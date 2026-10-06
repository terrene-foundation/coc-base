#!/usr/bin/env node
/*
 * Multi-CLI Emitter — Phase E4 (spec v6 §2.2 + §3.1 + §4.4)
 *
 * Driver that composes source rules with CLI-specific slot overlays,
 * runs v6 abridgement_protocol, enforces per-rule + total cap budgets,
 * and emits the per-CLI baseline context file (AGENTS.md for codex,
 * GEMINI.md for gemini).
 *
 * Also: populates `.codex-mcp-guard/` POLICIES table via extract-policies.mjs
 * (Phase E6) and flips POLICIES_POPULATED=false → true when bijection
 * holds against the extractor's output.
 *
 * Usage:
 *   node .claude/bin/emit.mjs --cli codex --out "$(mktemp -d)"
 *   node .claude/bin/emit.mjs --cli gemini --out "$(mktemp -d)"
 *   node .claude/bin/emit.mjs --all --out "$(mktemp -d)"    (both CLIs)
 *   node .claude/bin/emit.mjs --all --dry-run              (default out)
 *   node .claude/bin/emit.mjs --cli codex --lang=rs        (fused value form)
 *   node .claude/bin/emit.mjs --help                       (usage to stdout, exit 0)
 *
 * Exit codes: 0 = pass (or a lone --help); 1 = budget/validator failure;
 * 2 = usage error — any unrecognized, malformed, or repeated argument, or no
 * CLI selected. Exit 2 is taken BEFORE any validator or emission runs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule } from "./lib/entry-point.mjs";
// r4-v4 F7 (correctness item 7): the SHARED canonical-set identity scanner for
// the emitted root baselines (AGENTS.md / GEMINI.md are delivered content) —
// imported, never re-implemented. Aliased so an identifier already used in this
// module cannot shadow it.
import {
  privateOrgSlugs as emitPrivateOrgSlugs,
  assertPrivateOrgConfig,
  assertTreeFreeOfPrivateIdentity,
} from "./lib/strip-build-internal.mjs";
// loom#1424 — `execFileSync` is gone with V17 half B's per-target subprocess
// probe; `spawnSync` remains for validator 16's strict-YAML python probe.
import { spawnSync } from "node:child_process";

// Symlink-safe write. Node's fs.writeFileSync follows symlinks by
// default, so a TOCTOU attacker can plant a symlink between mkdirSync
// and writeFileSync and redirect the write. O_NOFOLLOW refuses to open
// a symlink target, closing the window. Used for emission outputs where
// we specifically want to fail-closed on symlink presence.
function safeWriteFileSync(filePath, data) {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_CREAT |
      fs.constants.O_WRONLY |
      fs.constants.O_TRUNC |
      fs.constants.O_NOFOLLOW,
    0o644,
  );
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

// The ONE write path for emitted TEXT artifacts here (loom#1684). The terminator
// contract itself lives in lib/coc-manifest.mjs::ensureTrailingNewline — imported,
// not re-implemented, so it cannot drift between the three emitters. This module
// keeps its OWN safeWriteFileSync (deliberately: it does not mkdir, unlike the lib
// copy), hence a local wrapper rather than the lib's writeTextArtifactSync.
function writeTextArtifactSync(filePath, text) {
  safeWriteFileSync(filePath, ensureTrailingNewline(text));
}

// Symlink-safe read (mirrors safeWriteFileSync to close the read side of the
// same TOCTOU). O_NOFOLLOW raises ELOOP if the leaf is a symlink — so an
// artifact-source file swapped for a symlink between an existsSync probe and
// the read raises instead of silently reading the attacker's target. Leaf-only
// guard, same caveat as the write side; loom's .claude tree carries zero
// symlinks (#569 sibling-site sweep — emit lane).
function safeReadFileSync(filePath, encoding) {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    return fs.readFileSync(fd, encoding);
  } finally {
    fs.closeSync(fd);
  }
}

// loom#1684 — the emitted-text terminator contract, defined ONCE in the shared
// manifest lib and imported by all three emitters (emit.mjs / emit-cli-artifacts /
// emit-coc) so the contract cannot drift across their write sites. Sits with its
// sibling `./lib/*` imports rather than in the node-builtin block above: this file
// has SEVERAL import clusters by pre-existing design (23-26, here, 89, 94, 107,
// 117, 130), so hoisting only this one out would be less consistent, not more.
import { ensureTrailingNewline } from "./lib/coc-manifest.mjs";
import {
  parseSlotsV5,
  applyOverlay,
  scanBlockStates,
  isContent,
  isMarker,
} from "./lib/slot-parser.mjs";
import { resolveOverlay } from "./lib/variant-overlay.mjs";
// loom#1501 (L4) — the two emission axes, declared ONCE. Previously three
// literals apiece across emit.mjs / validate-emit.mjs / validate-proximity-band.mjs,
// kept aligned by prose; the proximity-band copy had already drifted to a
// 3-lane set that rejected `--lang prism` (and `--lang rb`, then still a
// declared lane; rb was retired as a lane 2026-08-11). Rationale, the
// measured drift, and why the set is a DECLARATION rather than a disk probe:
// see the module header.
import { EMIT_LANGS, EMIT_CLIS } from "./lib/emit-axes.mjs";
// F-353 Item 4 — deployment-local rules (ADD-ONLY). The emit/compose path
// composes canon ∪ declared-local baseline rules so a deployment's local rule
// LOADS alongside canon; the loader enforces the add-only-no-override invariant
// (a collision with a canon rule is a LOUD throw that BLOCKS the emit).
import { loadLocalRules } from "./lib/local-rules.mjs";
// loom#1538 — the codex policy extractor is loaded LAZILY (see
// `loadExtractPolicies` below), NOT statically. `../codex-mcp-guard/` is a
// CODEX-lane artifact; a cc-only template (`clis: [claude]`) correctly ships
// no codex surface, so a top-level import of it made emit.mjs — and therefore
// validate-emit.mjs, which imports emit.mjs — fail at MODULE LOAD with
// ERR_MODULE_NOT_FOUND on those repos, unusable as a gate. It stayed invisible
// at loom because `.claude/codex-mcp-guard` resolves there via the repo-root
// `.codex-mcp-guard/` tree. The dependency is real but it belongs to two
// codex-only functions, so it is paid at CALL time by those two.
// Validator 18 (#408 AC#5-a) shares the EMITTER's canonical manifest parser +
// glob matcher so the validator's cc-only certification provably matches what
// emit-cli-artifacts actually excludes (no divergent hand-rolled second parser).
import { loadExclusions, matchesAnyGlob } from "./emit-cli-artifacts.mjs";
// loom#1386 — emit.mjs is ALWAYS_INCLUDE (shipped verbatim to every repo class)
// and held EIGHT unguarded sync-manifest.yaml reads, so on the three classes
// that FORBID the manifest it could not run at all. `readManifestSource` is the
// ONE class-aware discriminator (null ⇔ EXPECTED-absent; LOUD throw on
// absent-at-loom OR present-but-unreadable); `isManifestOwnerClass` is the
// no-filesystem predicate the loom-only validators gate on. `readRepoClass` +
// the class constants MOVED there so lib/coc-manifest.mjs and
// lib/variant-overlay.mjs can reach them without an import cycle; they are
// re-exported below unchanged for this file's existing importers (loom#1383).
import {
  MANIFEST_OWNER_CLASS,
  MANIFEST_FORBIDDEN_CLASSES,
  KNOWN_REPO_CLASSES,
  readRepoClass,
  isManifestOwnerClass,
  readManifestSource,
  readYamlBlock,
  readYamlScalar,
} from "./lib/manifest-source.mjs";
export { KNOWN_REPO_CLASSES, readRepoClass, isManifestOwnerClass };
// cli_delivery resolution primitives (#408 AC#5-a contract) live in a SHARED
// lib so BOTH Validator 18 here AND the AC#5-b rules-reference emitter in
// emit-cli-artifacts.mjs resolve lanes through ONE parser. Re-exported below
// for the cli-delivery-contract test + any standalone importer of emit.mjs.
import {
  CLI_DELIVERY_VALUES,
  parseExcludeFrom,
  deriveCliDelivery,
  checkRuleCliDelivery,
} from "./lib/cli-delivery.mjs";
export { CLI_DELIVERY_VALUES, parseExcludeFrom, deriveCliDelivery, checkRuleCliDelivery };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");

// ────────────────────────────────────────────────────────────────
// Codex surface — lazy + optional (loom#1538)
// ────────────────────────────────────────────────────────────────
// Resolved relative to THIS file (`.claude/bin/`), matching what the old
// static specifier `../codex-mcp-guard/extract-policies.mjs` resolved to, so
// the loom symlink path is unchanged.
const CODEX_GUARD_DIR = path.resolve(__dirname, "..", "codex-mcp-guard");
const CODEX_EXTRACTOR = path.join(CODEX_GUARD_DIR, "extract-policies.mjs");

/**
 * Is a codex-mcp-guard surface present in this repo?
 *
 * Absence is EXPECTED and CORRECT on a cc-only template — it is not an error
 * condition to be repaired by shipping the codex tree there. Callers that need
 * the extractor branch on this; they do not assume it.
 */
export function hasCodexGuardSurface() {
  return fs.existsSync(CODEX_EXTRACTOR);
}

let extractPoliciesCache = null;

/**
 * Load `extractPolicies` on demand. Throws a NAMED error — identifying the
 * missing codex surface and the path probed — rather than the opaque
 * ERR_MODULE_NOT_FOUND that a static import raised at module load. A consumer
 * that genuinely needs the extractor still fails, but it fails AT THE POINT OF
 * USE with a message that says what is missing and why it might legitimately
 * be absent.
 */
async function loadExtractPolicies() {
  if (extractPoliciesCache) return extractPoliciesCache;
  if (!hasCodexGuardSurface()) {
    throw new Error(
      `codex surface absent: ${CODEX_EXTRACTOR} does not exist. ` +
        `The MCP policy extractor is a CODEX-lane artifact; a cc-only template ` +
        `(clis: [claude]) correctly ships no codex-mcp-guard tree. Do not add ` +
        `the scaffold to satisfy this import — skip the codex-only path instead ` +
        `(see hasCodexGuardSurface()).`,
    );
  }
  const mod = await import(pathToFileURL(CODEX_EXTRACTOR).href);
  extractPoliciesCache = mod.extractPolicies;
  return extractPoliciesCache;
}

// ────────────────────────────────────────────────────────────────
// v6 abridgement protocol (extends v5 with M-1: "BLOCKED responses:")
//   v6.3 M-3: additional loom-internal-metadata strips (#1240 — recover
//   baseline-emission headroom baseline-WIDE; the rs lane had breached the 10%
//   floor. Every v6.3 strip removes ONLY loom-internal metadata a Codex/Gemini
//   USE-template consumer never consumes — the SAME class the Origin/Wiring
//   strips already remove — so ZERO MUST / MUST-NOT / **Why:**-rationale /
//   DO-DO-NOT content is de-scoped. CC loads the full source rule unchanged.)
// ────────────────────────────────────────────────────────────────
// Strip sections:
//   - Origin: lines (and continuation paragraphs)
//   - Trust Posture Wiring H2 sections                     [v6 M-2]
//   - Distinct From / Cross-References / Relationship-to-existing-rules
//       H2 sections (loom rule-graph navigation)           [v6.3 M-3]
//   - "## Examples (<CLI>-native ...)" H2 sections (CLI-dispatch-syntax
//       appendix; CG delegation delivered natively via .codex/prompts +
//       .gemini/agents — see the detailed comment at the strip site)
//                                                           [v6.3 M-3]
//   - Evidence / Verified / Measured H3+ sub-sections
//   - BLOCKED rationalizations: enumerated bullet lists
//   - BLOCKED responses: enumerated bullet lists           [v6 M-1]
//       (incl. clause-qualified header variants)            [v6.3 M-3]
//   - Heading-depth level 4 and deeper
// Strip patterns:
//   - Fenced code blocks that are NOT DO / DO NOT examples
//   - Markdown tables beyond 3 data rows (keep header + first 3)
//   - Whole-line rule-extracts guide pointers ("See `…guide…` for …",
//       "Depth … lives in `…guide…`.")                     [v6.3 M-3]
//   - Trailing "… Origin: <receipt>." provenance tails on kept lines
//       (the line-initial Origin strip, extended mid-line)  [v6.3 M-3]
//   - Trailing "… See guide." / "… See extract." / "… <label>: guide."
//       depth-pointer tails on kept lines (the whole-line rule-extracts
//       pointer strip, extended mid-line — same loom-internal navigation
//       class, same sentence-anchored mechanism). NOT extended to
//       `skills/…` pointers, which DO ship to consumers.  [loom#2018 E1a]
//   - Slot-marker-removal blank re-collapse (stripSlotMarkers)  [v6.3 M-3]
// Preserve:
//   - MUST / MUST NOT clauses in full
//   - **Why:** lines in full — the WHOLE line, however many sentences
//       (CORRECTED loom#2009: this line read "in full (first 2 sentences)".
//       No code here truncated anything; MEASURED, all five `Why` matches in
//       this file were comments. The parenthetical was a guarantee the
//       abridger never implemented — instrument-bipolarity.md MUST-4 — and it
//       was DELETED rather than implemented, because implementing it would
//       de-scope **Why:** rationale from the emitted baseline and so directly
//       contradict the v6.3 M-3 invariant 27 lines above ("ZERO MUST /
//       MUST-NOT / **Why:**-rationale / DO-DO-NOT content is de-scoped").
//       Pinned by emit-shape.test.mjs "#2009 abridgeV6 preserves a **Why:**
//       line WHOLE", which reds if a truncator is ever added silently.)
//   - DO / DO NOT example blocks under 200 bytes each
//   - Tables whose full-rendered size is under 1000 bytes

// [loom#2141] The fence on the BLOCKED-block stripper's paragraph consumption.
// TRUE for any line that opens a NEW block-level construct, i.e. a line that
// can never be a soft-wrapped continuation of the preceding paragraph. The
// stripper stops here, so nothing beyond the rationalization block is ever
// consumed. Members, and why each is load-bearing:
//   - ATX heading          — a new section; swallowing it deletes a whole rule.
//   - fence (``` / ~~~)    — a DO/DO-NOT example the preserve-contract keeps.
//   - table row / delim    — preserved by the table arm below.
//   - blockquote           — a distinct block.
//   - HTML comment         — variant slot markers (`<!-- /slot:… -->`), which
//                            stripSlotMarkers owns; consuming one would fuse
//                            the overlay's boundary into the strip.
//   - `**` bold-label start — `**Why:**`, `**DO:**`, a sibling `**BLOCKED …:**`
//                            header, and the normative `**NOT a rationalization
//                            …**` paragraph at
//                            `.claude/rules/ci-cost-discipline.md:32`, which
//                            sits one blank below a BLOCKED block. This is the
//                            single most load-bearing member: it is what keeps
//                            arm (3b) from eating a **Why:** rationale.
//   - thematic break       — `---` / `***`, incl. a frontmatter fence.
// DELIBERATELY NOT a member: a bullet (`- `). A bullet IS block-level, but it
// is block-level content OF this block, so the stripper consumes it by its own
// arms rather than stopping at it.
// The conservative direction is deliberate: a continuation line that happens to
// begin with a bolded phrase stops the strip and leaks (the pre-2141 outcome for
// that one line), which is the failure this rule PREFERS over deleting a
// normative paragraph.
export function isBlockedBlockStop(line) {
  return /^\s{0,3}(?:#{1,6}\s|```|~~~|\||>|<!--|\*\*|(?:[-*_][ \t]*){3,}$)/.test(
    line,
  );
}

export function abridgeV6(raw) {
  const lines = raw.split("\n");
  const out = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // H4+ headings → strip entire subsection until next <= H3
    const hMatch = line.match(/^(#{1,6})\s/);
    if (hMatch && hMatch[1].length >= 4) {
      i++;
      while (i < lines.length) {
        const n = lines[i].match(/^(#{1,6})\s/);
        if (n && n[1].length <= 3) break;
        if (n && n[1].length >= hMatch[1].length) break;
        i++;
      }
      continue;
    }

    // Origin: line or Origin paragraph — strip until blank
    if (/^Origin:/i.test(trimmed) || /^\*\*Origin:/i.test(trimmed)) {
      i++;
      while (i < lines.length && lines[i].trim() !== "") i++;
      continue;
    }

    // [v6.3 M-3] Rule-extract guide-pointer line — the leading "See
    // `.claude/guides/rule-extracts/<name>.md` for ..." depth pointer 20+ rules
    // carry directly under their H1. It routes to loom's EXTRACT-not-NARROW guide
    // companion (rule-authoring.md Rule 7 + the extraction pattern), which is
    // loom-side authoring DEPTH — the rule body's normative MUST content is
    // self-contained without it. The pointer is dead weight in the abridged
    // Codex/Gemini baseline (same loom-internal class as the Origin/Wiring strips):
    // CC loads the full rule (pointer intact); the abridged AGENTS.md/GEMINI.md
    // carries the MUST clauses, not the navigation to loom's depth files.
    // Two whole-line shapes: the leading "See `...guide...` for ..." pointer AND
    // the "Depth for most sections below lives in `...guide...`." variant
    // (security.md). Both are whole-line loom-side depth pointers with the
    // rule-extracts guide as the only payload — matched only when the line is
    // ENTIRELY the pointer (starts with See/Depth and its sole reference is a
    // rule-extracts guide), never a MUST clause that merely cites a guide inline.
    if (
      /^See `?\.claude\/guides\/rule-extracts\/[a-z0-9-]+\.md`? for .+\.\s*$/.test(
        trimmed,
      ) ||
      /^Depth\b[^`]*`\.claude\/guides\/rule-extracts\/[a-z0-9-]+\.md`\.\s*$/.test(
        trimmed,
      ) ||
      // The governance-SIBLING pointer. Same class as the rule-extracts
      // pointers above — loom-internal navigation to bookkeeping the
      // abridged baseline already strips wholesale (Wiring, Origin,
      // Distinct-From). Unrecognised, it SURVIVED into the Codex/Gemini
      // baseline at 233 B per split rule; across the twelve baseline rules
      // this pattern targets that is ~2,796 B on a `codex/rs` lane sitting
      // near its floor, which would have spent the very budget the split
      // exists to recover.
      //
      // Trailing prose after the backtick is tolerated here and not above,
      // because this pointer must also say WHY the file is elsewhere — a
      // bare path would read as a dangling reference to anyone who opened
      // the rule and found its Wiring missing.
      /^Depth\b[^`]*`\.claude\/skills\/32-trust-posture\/wiring\/[a-z0-9-]+\.md`[^`]*\.\s*$/.test(
        trimmed,
      )
    ) {
      i++;
      continue;
    }

    // Trust Posture Wiring H2 section — strip entire section until next H1/H2.
    // [v6 M-2] Wiring is loom-INTERNAL enforcement metadata (severity, grace
    // period, cumulative posture math, detection mechanism, receipt/violation
    // scope) — bookkeeping for loom's own posture machinery, NOT agent-behavioral
    // instruction. A Codex/Gemini consumer of a USE template never runs that
    // machinery, so the Wiring prose is dead weight in its always-on baseline —
    // the same loom-internal class abridge already strips for `Origin:` above.
    // It stays in the SOURCE rule: CC full-rule load sees it, and the
    // cc-architect canonical-field sweep greps `**Violation scope:**` against
    // `.claude/rules/*.md` (source), never the abridged baseline, so the
    // grep-token contract (`trust-posture.md` MUST-8) is unaffected.
    if (hMatch && hMatch[1].length === 2 && /^##\s+Trust Posture Wiring\b/.test(line)) {
      i++;
      while (i < lines.length) {
        const n = lines[i].match(/^(#{1,6})\s/);
        if (n && n[1].length <= 2) break; // next H1/H2 section begins
        i++;
      }
      continue;
    }

    // [v6.3 M-3] Distinct From / Cross-References / Relationship-to-existing-rules
    // H2 sections — loom-INTERNAL rule-graph navigation metadata ("extends X",
    // "pairs with Y", "distinct from Z"). A Codex/Gemini USE-template consumer of
    // the abridged baseline does not traverse the loom rule graph; these sections
    // are bookkeeping for loom-side authoring/audit, the same loom-internal class
    // the Wiring/Origin strips already remove. The normative cross-rule bindings a
    // consumer actually needs are inline in the MUST clauses (preserved); this is
    // the standalone navigation section. Strip entire section until next H1/H2.
    if (
      hMatch &&
      hMatch[1].length === 2 &&
      /^##\s+(Distinct From(\s*\/\s*Cross-References)?|Relationship to existing rules)\b/.test(
        line,
      )
    ) {
      i++;
      while (i < lines.length) {
        const n = lines[i].match(/^(#{1,6})\s/);
        if (n && n[1].length <= 2) break; // next H1/H2 section begins
        i++;
      }
      continue;
    }

    // [v6.3 M-3] "## Examples (<CLI>-native ...)" H2 section — the per-rule
    // CLI-dispatch-syntax appendix (agents.md). The section itself declares it is
    // supplementary ("the delegation MECHANISM above is self-contained; the
    // CLI-neutral MUST-clause contract is the load-bearing part"), and the REAL
    // Codex/Gemini delegation surfaces are delivered NATIVELY —
    // `.codex/prompts/specialist-*.md` + `.gemini/agents/*-specialist.md` (the
    // `specialist-delegation-syntax` skill it also cites is cli_emit_exclusions'd
    // from BOTH Codex and Gemini, so the appendix's skill pointer was dangling for
    // a CG consumer). The abridged baseline carries the CLI-neutral MUST contract;
    // the CLI-specific dispatch appendix is loom/native-surface depth.
    // BOUNDED — the title MUST carry a CLI-syntax qualifier: an explicit CLI name
    // (CLI / Codex / Gemini) OR the phrase "delegation syntax". A bare "## Examples",
    // a normative "## Examples (worked cases)", OR a "## Examples (native …)"
    // section is NOT this shape and is PRESERVED (a future baseline rule using
    // "## Examples" as a normative section must not silently vanish — R1 MED-1;
    // bare "native" dropped from the qualifier set per R2 residual-2, since the
    // live appendices match via CLI/Codex/"delegation syntax" anyway). Strip
    // entire section until next H1/H2.
    if (
      hMatch &&
      hMatch[1].length === 2 &&
      /^##\s+Examples\b.*\b(CLI|Codex|Gemini|delegation syntax)\b/i.test(line)
    ) {
      i++;
      while (i < lines.length) {
        const n = lines[i].match(/^(#{1,6})\s/);
        if (n && n[1].length <= 2) break; // next H1/H2 section begins
        i++;
      }
      continue;
    }

    // Evidence / Verified / Measured H3 sub-sections
    if (
      hMatch &&
      hMatch[1].length === 3 &&
      /^(#+)\s+(Evidence|Verified|Measured)/i.test(line)
    ) {
      i++;
      while (i < lines.length && !/^(#{1,3})\s/.test(lines[i])) i++;
      continue;
    }

    // BLOCKED rationalizations / BLOCKED responses — strip header + bullets
    // [v6 M-1: added "BLOCKED responses:" to v5's "BLOCKED rationalizations:"]
    // [v6.3 M-3: broadened to catch QUALIFIED variants — a parenthetical or
    // clause-qualified header ("**BLOCKED responses when skipping MUST gates:**",
    // "**BLOCKED rationalizations (Tier 2 misuse):**") is the SAME dead-weight
    // enumeration class, only with a scope qualifier between the keyword and the
    // colon. `[^*]*` matches the qualifier (never crossing a `**` boundary), so a
    // bare "**BLOCKED:**" normative enumeration is deliberately NOT matched.]
    // [loom#2141] The pre-2141 loop consumed the header LINE and then only
    // bullets/blanks. Where the block is a SOFT-WRAPPED prose paragraph the
    // second PHYSICAL line is neither, so the loop stopped and that line fell
    // into the emission unattributed — a sentence starting mid-clause, header
    // and first item gone. loom#2141 reports a downstream BUILD repo whose
    // committed AGENTS.md carried FOUR such orphans, caught by a human reading
    // the file and by no gate (that count is the issue's measurement, not one
    // re-derived here). MEASURED on THIS tree at d0647405: 254 BLOCKED blocks
    // across `.claude/rules/*.md`, of which 19 in 8 files leaked under the
    // pre-2141 loop — all 8 `priority: 10`, so canon's emitted baseline was
    // clean and the defect was LATENT, awaiting any promotion to baseline.
    // The fix consumes the header's own paragraph (lazy continuation) and,
    // where the header is ALONE on its line, the single prose paragraph that
    // follows one blank — the two shapes this corpus actually authors.
    //
    // OVER-consumption is the strictly worse failure (it silently DELETES
    // obligations from the emitted baseline), so every extension below is
    // fenced: consumption stops at any block-level construct
    // (isBlockedBlockStop), NEVER crosses two blanks, and the prose-paragraph
    // arm (b) fires ONLY when the header carried no inline body, consumed no
    // continuation, and the body is not a bullet list — so the pre-existing
    // "header → bullets → blank → normative paragraph" shape keeps that
    // paragraph, exactly as before.
    if (/^\*\*BLOCKED\s+(rationalizations|responses)\b[^*]*:?\*\*/.test(trimmed)) {
      const headerHasInlineBody =
        trimmed
          .replace(/^\*\*BLOCKED\s+(rationalizations|responses)\b[^*]*:?\*\*/, "")
          .trim() !== "";
      i++;
      // (1) Lazy continuation of the header's OWN paragraph — physical lines
      //     with no blank between them. This is the #2141 orphan. A BULLET
      //     ends this arm: it opens the enumeration body, which arm (3a) owns
      //     under its own fences, so the blank-separated and blank-less bullet
      //     shapes take the identical path.
      let continuationLines = 0;
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^\s*-\s/.test(lines[i]) &&
        !isBlockedBlockStop(lines[i])
      ) {
        i++;
        continuationLines++;
      }
      // (2) At most ONE blank may separate the header from its enumeration.
      if (i < lines.length && lines[i].trim() === "") i++;
      if (i < lines.length && /^\s*-\s/.test(lines[i])) {
        // (3a) Bullet enumeration: bullets, interior blanks, AND a bullet's own
        //      INDENTED lazy continuation. The continuation is the same #2141
        //      orphan one level down — the item at
        //      `.claude/rules/self-referential-codify.md:72-73` wraps onto an
        //      indented "(the carve-out is one-time-per-rule …)" line, which
        //      the pre-2141 loop left in the emission as a parenthetical with
        //      no antecedent. Fenced two ways so it cannot
        //      reach past the list: it requires LEADING WHITESPACE (a
        //      flush-left line after a list is a new paragraph) and it must not
        //      follow a BLANK (a blank ends the item, so what comes next is a
        //      new block, not a wrap).
        let afterBlank = false;
        while (i < lines.length) {
          const l = lines[i];
          if (l.trim() === "") {
            afterBlank = true;
            i++;
            continue;
          }
          if (/^\s*-\s/.test(l)) {
            afterBlank = false;
            i++;
            continue;
          }
          if (!afterBlank && /^\s/.test(l) && !isBlockedBlockStop(l)) {
            i++;
            continue;
          }
          break;
        }
      } else if (
        continuationLines === 0 &&
        !headerHasInlineBody &&
        i < lines.length &&
        lines[i].trim() !== "" &&
        !isBlockedBlockStop(lines[i])
      ) {
        // (3b) Prose enumeration under a header that is ALONE on its line
        //      ("**BLOCKED rationalizations:**" / blank / one `·`-joined
        //      paragraph of quoted rationalizations — ci-cost-discipline.md).
        //      Bounded to ONE paragraph: it stops at the first blank.
        while (
          i < lines.length &&
          lines[i].trim() !== "" &&
          !isBlockedBlockStop(lines[i])
        )
          i++;
        while (i < lines.length && lines[i].trim() === "") i++;
      }
      continue;
    }

    // Fenced code block: preserve only if DO/DO NOT AND <= 200B total
    const fenceOpen = line.match(/^(```+|~~~+)/);
    if (fenceOpen) {
      const fence = fenceOpen[1];
      const blockLines = [line];
      let j = i + 1;
      while (j < lines.length) {
        blockLines.push(lines[j]);
        if (
          lines[j].startsWith(fence[0].repeat(fence.length)) &&
          lines[j].slice(fence.length).trim() === ""
        ) {
          j++;
          break;
        }
        j++;
      }
      const blockText = blockLines.join("\n");
      const blockSize = Buffer.byteLength(blockText, "utf8");
      const isDoBlock = blockLines.some((l) =>
        /^#\s+DO\b|^#\s+DO NOT\b|^\/\/\s+DO\b|^\/\/\s+DO NOT\b/.test(l),
      );
      if (isDoBlock && blockSize <= 200) {
        out.push(...blockLines);
      }
      i = j;
      continue;
    }

    // Markdown tables: preserve if under 1000B; else header + 3 data rows
    if (
      /^\|/.test(line) &&
      i + 1 < lines.length &&
      /^\|[-:\s|]+\|/.test(lines[i + 1])
    ) {
      const tableLines = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && /^\|/.test(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }
      const tableText = tableLines.join("\n");
      const tableSize = Buffer.byteLength(tableText, "utf8");
      const dataRows = tableLines.length - 2;
      if (tableSize <= 1000) {
        out.push(...tableLines);
      } else if (dataRows > 3) {
        out.push(
          tableLines[0],
          tableLines[1],
          tableLines[2],
          tableLines[3],
          tableLines[4],
        );
        out.push("| ... | ... |");
      } else {
        out.push(...tableLines);
      }
      i = j;
      continue;
    }

    out.push(line);
    i++;
  }

  // [loom#2018 E1a] Inline depth-pointer tail — a trailing "… See guide." /
  // "… See extract." / "… <label>: guide." navigation SENTENCE appended to a kept
  // line. This is the SAME loom-internal navigation class the WHOLE-LINE
  // rule-extracts pointer strip above already removes, and the same MECHANISM the
  // `Origin:` peel directly below uses — only the tail form was never covered, so
  // an identical pointer survived or died purely on whether its author put it on
  // its own line. `guide` / `extract` here resolve to
  // `.claude/guides/rule-extracts/<rule>.md`, which is loom-side authoring depth a
  // Codex/Gemini consumer of a USE template never receives and cannot traverse;
  // the pointer is therefore dead navigation in the abridged baseline. CC loads
  // the full rule with the pointer intact.
  //
  // DELIBERATELY NOT EXTENDED to `skills/…` pointers: those DO ship to consumers,
  // so stripping them would degrade progressive disclosure rather than remove dead
  // weight. That is an open policy question, not a byte fix (loom#2018 comment,
  // "UNVERIFIED, stated rather than implied").
  //
  // Bounded three ways so it peels navigation and never rationale:
  //   (1) SENTENCE-ANCHORED — fires only on a fragment preceded by a sentence
  //       terminator (`.`/`)`), i.e. a genuine trailing sentence, never a
  //       mid-sentence mention such as "…see `rules/framework-first.md` and guide
  //       for per-framework rationale." (measured: that MUST NOT bullet in
  //       agents.md is preserved).
  //   (2) The label form's label MUST NOT contain `.`, `:` or an em-dash. `.`
  //       stops the peel from reaching back into the preceding sentence; the
  //       em-dash exclusion preserves labels that carry a normative aside, e.g.
  //       git.md's "…SKIP carve-out — a SKIP is NOT a parity failure: guide."
  //       which is kept WHOLE rather than peeled.
  //   (3) Only `guide` / `extract` are pointer targets. Any other noun is left
  //       alone.
  // This does NOT truncate **Why:** rationale — it removes a trailing navigation
  // sentence, exactly as the `Origin:` peel does on the same lines. The
  // "**Why:** lines in full" preserve-contract above is about RATIONALE
  // sentences; pinned by emit-shape.test.mjs "#2009 …preserves a **Why:** line
  // WHOLE" and by the bipolar E1a test beside it.
  const outDepthTrimmed = out
    .map((l) =>
      l.replace(
        /(?<=[.)])\s+(?:See (?:also )?(?:the )?(?:guide|extract)\b|[^.:\n—]{1,140}:\s(?:guide|extract)\b)[^\n]*$/,
        "",
      ),
    )
    // Same class, explicit-path form: "… <label>: `.claude/guides/rule-extracts/
    // <rule>.md`[ § Section]." TERMINATION-BOUNDED — the pointer must be the
    // LAST thing on the line. This is deliberate and load-bearing: an EOL-greedy
    // `[^\n]*$` here was MEASURED to swallow the sentence FOLLOWING the pointer,
    // and in autonomous-execution.md § 10x Throughput Multiplier that next
    // sentence is normative ("procedure drops stay BLOCKED even when explicitly
    // authorized"). Requiring the line to END at the pointer preserves it: that
    // line is now NOT matched, by construction. Pinned by the bipolar E1a test.
    .map((l) =>
      l.replace(
        /(?<=[.)])\s+[^.:\n—]{1,140}:\s`?\.claude\/guides\/rule-extracts\/[a-z0-9-]+\.md`?(?:\s§[^.\n]{0,60})?\.\s*$/,
        "",
      ),
    );

  // [v6.3 M-3] Inline provenance tail — a mid-paragraph "... Origin: <receipt>."
  // sentence appended to a kept line (typically a **Why:** or a variant-overlay
  // clause, e.g. "... per observation. Origin: R3 finding `0021-...`, fixed in commit `173d054b`.").
  // This is the SAME loom-internal provenance class the line-initial `Origin:`
  // strip above removes, only mid-line: a Codex/Gemini consumer never consumes the
  // originating-receipt provenance. SENTENCE-ANCHORED — the peel fires ONLY on an
  // " Origin: …EOL" fragment immediately preceded by a sentence terminator (`.`/`)`),
  // i.e. a genuine trailing provenance SENTENCE. A mid-sentence "Origin:" token
  // (e.g. a security clause "…validate the `Origin`/Origin: header before…") is NOT
  // a sentence tail and is PRESERVED (R1 MED-2 / security-reviewer LOW-2 — the
  // unconditional peel would have truncated such a clause on a future baseline
  // rule). The normative clause preceding the provenance sentence is preserved intact.
  const outTrimmed = outDepthTrimmed.map((l) =>
    l.replace(/(?<=[.)])\s+Origin:\s[^\n]*$/, ""),
  );

  // Collapse multi-blanks + trim
  let result = outTrimmed.join("\n");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim() + "\n";
}

// ────────────────────────────────────────────────────────────────
// Slot-marker strip (after abridgement, before emit)
// ────────────────────────────────────────────────────────────────
// Slot markers are HTML comments — invisible in rendered markdown,
// but emitted text is consumed by Codex/Gemini as source strings.
// Strip them for a clean final output.
export function stripSlotMarkers(raw) {
  const lines = raw.split("\n");
  // THE PARSER'S OWN BLOCK MODEL (loom#2208). A marker inside a FENCED block, an
  // INDENTED block, an HTML RAW block or an HTML COMMENT is not a slot: it is the
  // rule's own documentation OF the mechanism — an example showing a reader where
  // \`neutral-body\` ends and \`examples\` begin — and deleting it destroyed that
  // example in shipped .coc/ output (4 files, 15 markers, 394 B, measured).
  //
  // Classification is NOT re-derived here. \`scanBlockStates\` is the function
  // \`parseSlotsV5\` itself consumes, so "which lines are block content" and "which
  // lines are real slot markers" have ONE answer: a strip-local model that knows
  // fewer block shapes than the parser is a second answer waiting to drift, and
  // only one of the two would match the contract the parser implements.
  const states = scanBlockStates(lines);
  const kept = [];
  let lastBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const st = states[i];
    if (isContent(st)) {
      kept.push(line); // VERBATIM: a block that owns its bytes keeps every one of them
      lastBlank = st.isBlank;
      continue;
    }
    if (isMarker(st)) continue; // a real marker: dropped; flanking blanks collapse below
    const out = line.replace(/[ \t]+$/, "");
    if (out === "") {
      if (lastBlank) continue; // a run of blanks OUTSIDE a fence collapses to one
      lastBlank = true;
      kept.push(out);
      continue;
    }
    lastBlank = false;
    kept.push(out);
  }
  const stripped = kept.join("\n");
  // [v6.3 M-3] Removing a slot-marker line leaves the blank lines that flanked it
  // un-collapsed (abridgeV6's blank-collapse ran BEFORE this strip). Re-collapse
  // 3+ consecutive newlines to one blank line + drop trailing whitespace so the
  // slot-marker removal does not leave whitespace bloat in the emitted baseline.
  // The per-line trailing strip and the blank-run collapse now happen DURING the
  // walk above, where the fence mask is known. Applying \`\n{3,}\` here instead would
  // reach INSIDE a fence and reflow the blank lines a fenced example owns.
  const cleaned = stripped;
  // [marker-position byte-stability] abridgeV6 returns `result.trim() + "\n"`:
  // no leading whitespace, exactly ONE trailing LF. THIS strip can break that
  // invariant on EITHER edge, because deleting a marker line does not delete the
  // blank line that flanked it — a marker sitting FIRST leaves a leading newline,
  // one sitting LAST leaves a trailing newline. Neither is hypothetical: a slot
  // marker moved up into the body (so the file no longer ENDS with its closing
  // marker) leaves the LAST one, and the cost is invisible in the source and
  // visible in the emission — the extra LF becomes an extra blank line before
  // `chunks.join("\n---\n\n")`'s inter-rule `---`, and check-baseline-delta.mjs
  // charges that rule +1 emitted byte with ZERO content added.
  //
  // So the invariant is restored HERE, on both edges, making emission
  // byte-stable regardless of WHERE the markers sit. A whitespace-only input is
  // returned unchanged rather than normalized to a bare "\n": the previous
  // function returned it as-is and callers depend on the VALUE, not on this
  // normalization contract.
  const trimmed = cleaned.replace(/^\n+/, "").replace(/[ \t\r\n]+$/, "");
  return trimmed === "" ? cleaned : `${trimmed}\n`;
}

// ────────────────────────────────────────────────────────────────
// Rule frontmatter strip (CDX-1: per-rule frontmatter blocks repeated in body)
// ────────────────────────────────────────────────────────────────
// Source rules carry a leading frontmatter block declaring `priority:`
// and `scope:` (validator-14 enforces the pair). The block is metadata
// for the emitter — Codex/Gemini consume the rendered baseline as
// instruction prose, so the `---\npriority: 0\nscope: baseline\n---`
// block must not survive into the emitted body.
export function stripRuleFrontmatter(raw) {
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

// ────────────────────────────────────────────────────────────────
// Overlay application (per variant-authoring.md Rule 1)
// ────────────────────────────────────────────────────────────────
// applyOverlay is imported from ./lib/slot-parser.mjs — shared with
// compose.mjs. Variant files contain ONLY slot-keyed replacement bodies.

// ────────────────────────────────────────────────────────────────
// Compose one rule for one CLI
// ────────────────────────────────────────────────────────────────
// Precedence per variant-authoring.md Rule 4:
//   1. global .claude/rules/<rule>.md
//   2. variants/<lang>/rules/<rule>.md        (language-axis only)
//   3. variants/<cli>/rules/<rule>.md         (CLI-axis only)
//   4. variants/<lang>-<cli>/rules/<rule>.md  (ternary, both-axis)
// 2–4 are all applied if present (union of slot replacements), in
// that order. Language-axis overlays were added 2026-04-22 (Phase I2)
// to close the semantic-override bug where, e.g., the language-specific
// rs override of framework-first.md was invisible to emit because only
// CLI-only and ternary paths composed into the baseline.
/**
 * Compose ONE overlay onto an already-composed body, selecting the slot-keyed
 * or full-file branch. Extracted from `composeRule`'s inner `applyAxis` closure
 * so the FULL-FILE REPLACEMENT branch is reachable by a fixture: it was
 * previously testable only through an in-repo full-file overlay, and when the
 * prism lane retired (2026-09-02) the tree stopped containing one, leaving live
 * code with no way to exercise it (loom#2087). Pure — no filesystem, no REPO.
 *
 * @param {string} base    the body composed so far
 * @param {string} overlay the overlay file's contents
 * @returns {{composed: string, warnings: string[]}}
 */
export function composeOverlayBody(base, overlay) {
  if (overlay.includes("<!-- slot:")) {
    // Slot-keyed overlay — compose via slot-parser (Phase F2 convention).
    return applyOverlay(base, overlay);
  }
  // Full-file overlay — variant wins per artifact-flow.md § Variant Overlay
  // Semantics. Pre-2026-05-12 composeRule had no branch for this and silently
  // no-op'd against legacy full-file overlays. Mirror composeArtifactBody.
  return { composed: overlay, warnings: [] };
}

export function composeRule(ruleName, cli, lang = null) {
  // Rule-name validation: a simple `.md` filename, OR a `local/<name>.md`
  // deployment-local rule (F-353 Item 4). The optional single `local/` segment
  // is the ONLY subdir form permitted — no other traversal. A local rule is a
  // fork-local ADDITION with NO variant overlays (never py/rs/cli-specialized),
  // so it composes as the raw global body and SKIPS the axis-overlay passes.
  const isLocal = /^local\/[a-z][a-z0-9-]*\.md$/.test(ruleName);
  if (!isLocal && !/^[a-z][a-z0-9-]*\.md$/.test(ruleName)) {
    throw new Error(
      `invalid rule name '${ruleName}' — must match /^[a-z][a-z0-9-]*\\.md$/ (or a local/<name>.md deployment-local rule)`,
    );
  }

  const globalPath = path.join(REPO, ".claude", "rules", ruleName);
  if (!fs.existsSync(globalPath)) {
    throw new Error(`rule not found: ${globalPath}`);
  }

  let composed = safeReadFileSync(globalPath, "utf8");
  const warnings = [];

  // Deployment-local rules carry no variant overlays — compose the body as-is.
  if (isLocal) {
    return { composed, warnings };
  }

  // Axis resolution defers to resolveOverlay() so sync-manifest.yaml::variants
  // is the source of truth. `null` declarations skip the axis even if a
  // legacy file exists on disk (closes the phantom-overlay class — e.g.
  // `variants/py/rules/ci-runners.md` exists despite the manifest declaring
  // `[py] ci-runners.md: null`).
  //
  // Composition order matches the documented precedent: language-axis first,
  // CLI-axis second, ternary (lang-cli) third. All present overlays compose
  // additively (slot bodies replace global slots; full-file overlays replace
  // composed body entirely — last writer wins).
  const applyAxis = (axis, axisLabel) => {
    const res = resolveOverlay("rules", ruleName, axis);
    if (res.kind === "manifest-null") return;
    if (!fs.existsSync(res.path)) {
      if (res.kind === "manifest-explicit") {
        throw new Error(
          `sync-manifest.yaml::variants declares overlay '${path.relative(REPO, res.path)}' ` +
            `for rules/${ruleName} axis '${axis}', but the file is missing (manifest defect)`,
        );
      }
      return;
    }
    const overlay = safeReadFileSync(res.path, "utf8");
    const { composed: c, warnings: w } = composeOverlayBody(composed, overlay);
    composed = c;
    warnings.push(...w.map((m) => `[${axisLabel}] ${m}`));
  };

  if (lang) applyAxis(lang, lang);
  applyAxis(cli, cli);
  if (lang) applyAxis(`${lang}-${cli}`, `${lang}-${cli}`);

  return { composed, warnings };
}

// ────────────────────────────────────────────────────────────────
// Emit CRIT baseline for one CLI
// ────────────────────────────────────────────────────────────────
// Per spec v6 §2.2, the CRIT baseline is emitted to AGENTS.md (codex)
// or GEMINI.md (gemini). The rule set + per-rule budgets come from
// sync-manifest.yaml cli_variants.context/root.md.<cli>.abridgement_protocol.

// ────────────────────────────────────────────────────────────────
// cli_variants."context/root.md" — every emit-tuning read resolves by PATH
// ────────────────────────────────────────────────────────────────
// The per-rule budgets, the budget tolerance and block threshold, the per-CLI
// caps and both exception lists are all declared under ONE stanza, and every
// reader below resolves its key by full path through
// `manifest-source.mjs::readYamlBlock` / `readYamlScalar` — never by the first
// textual occurrence of a key name. Key names repeat in this manifest
// (`cli_emit_exclusions.gemini` precedes `cli_variants."context/root.md".gemini`),
// so an unanchored read answers from whichever stanza comes first. No YAML
// dependency is added; strict structural validity stays Validator 16's.
const ROOT_CONTEXT_PATH = Object.freeze(["cli_variants", "context/root.md"]);
const ROOT_CONTEXT_LABEL = 'sync-manifest.yaml::cli_variants."context/root.md"';
// The abridgement protocol — and with it the per-rule budgets, tolerance and
// block threshold — is declared ONCE, under codex: the gemini stanza carries
// `inherit_abridgement_from: "codex"` instead of a copy. These readers take
// codex's declaration, and emitBaseline applies it to both CLIs.
const ABRIDGEMENT_PATH = Object.freeze([...ROOT_CONTEXT_PATH, "codex", "abridgement_protocol"]);
const ABRIDGEMENT_LABEL = `${ROOT_CONTEXT_LABEL}.codex.abridgement_protocol`;

// Per-rule budget entries as Map<ruleFileName, budgetBytes>, from
// `<ABRIDGEMENT_PATH>.per_rule_size_budget_bytes`.
export function loadPerRuleBudgets() {
  // D2 EMIT-TUNING (loom#1386). An absent manifest routes to the SAME empty Map
  // parsePerRuleBudgets returns when the stanza is missing from a present
  // manifest — no new fallback is invented. A consumer emitting its own
  // baseline then gets the "no per_rule_size_budget_bytes entry" WARN per rule
  // (emitBaseline's `else` branch), which is advisory, not a gate.
  const src = readManifestSource(REPO);
  if (src === null) return new Map();
  return parsePerRuleBudgets(src);
}

// Pure parser over manifest SOURCE TEXT, so fixture copies exercise every branch
// without mutating the tracked file. A stanza absent at its path yields the empty
// Map. An entry that IS present but is not `"<rule>.md": <integer>` THROWS:
// skipping it would silently move that rule from the per-rule BLOCK to the
// no-budget WARN.
export function parsePerRuleBudgets(src) {
  const budgets = new Map();
  const block = readYamlBlock(src, [...ABRIDGEMENT_PATH, "per_rule_size_budget_bytes"]);
  if (block === null) return budgets;
  for (const { key, line, value } of block.children) {
    if (!/^[a-z][a-z0-9-]*\.md$/.test(key) || !/^\d+$/.test(value)) {
      throw new Error(
        `[emit] ${ABRIDGEMENT_LABEL}.per_rule_size_budget_bytes (line ${line}): entry ` +
          `"${key}": "${value}" is not "<rule>.md": <integer bytes>. Refusing to skip ` +
          `it — a skipped entry silently demotes that rule's per-rule BLOCK to a WARN.`,
      );
    }
    budgets.set(key, parseInt(value, 10));
  }
  return budgets;
}

// Tolerance from `<ABRIDGEMENT_PATH>.per_rule_budget_tolerance` (fixed at ±30% in
// v6 §2.2, stored as the string "±30%"). ABSENT at its path → 0.30. DECLARED but
// not "±<int>%" → THROWS: a fallback there would silently discard a written value.
export function loadBudgetTolerance() {
  // D2 EMIT-TUNING (loom#1386) — absent manifest resolves to the SAME 0.30 the
  // absent-key path below already declares (v6 §2.2 fixed ±30%).
  const src = readManifestSource(REPO);
  if (src === null) return 0.3;
  const raw = readYamlScalar(src, [...ABRIDGEMENT_PATH, "per_rule_budget_tolerance"]);
  const m = raw === null ? null : raw.match(/^±(\d+)%$/);
  if (raw !== null && m === null) {
    throw new Error(
      `[emit] ${ABRIDGEMENT_LABEL}.per_rule_budget_tolerance is "${raw}", not "±<integer>%".`,
    );
  }
  return m ? parseInt(m[1], 10) / 100 : 0.3;
}

// Block threshold from sync-manifest.yaml per_rule_budget_block_threshold
// (v6 §A.2 + §2.2). When a rule's emitted bytes exceed budget * (1 +
// block_threshold), emission MUST hard-fail — the WARN tier is the
// drift-signal; the BLOCK tier is the contract. Pre-Shard-D, only the
// WARN path was wired; zero-tolerance.md ran +64% over budget unchecked.
export function loadBudgetBlockThreshold() {
  // D2 EMIT-TUNING (loom#1386) — absent manifest resolves to the SAME 0.30 the
  // no-match path below already declares. Note the direction: 0.30 is the
  // TIGHTER answer (a smaller threshold blocks sooner), so the absent-manifest
  // branch cannot loosen a budget gate.
  const src = readManifestSource(REPO);
  if (src === null) return 0.3;
  // Resolved at `<ABRIDGEMENT_PATH>.per_rule_budget_block_threshold`. Absent → 0.30;
  // declared but not "+<int>%" → THROWS, same reasoning as loadBudgetTolerance.
  const raw = readYamlScalar(src, [...ABRIDGEMENT_PATH, "per_rule_budget_block_threshold"]);
  const m = raw === null ? null : raw.match(/^\+(\d+)%$/);
  if (raw !== null && m === null) {
    throw new Error(
      `[emit] ${ABRIDGEMENT_LABEL}.per_rule_budget_block_threshold is "${raw}", not "+<integer>%".`,
    );
  }
  return m ? parseInt(m[1], 10) / 100 : 0.3;
}

// Per-CLI caps from `cli_variants."context/root.md".<cli>` — the manifest is the
// single source of truth for the caps and the v6.2 Risk-0004 headroom floor;
// hardcoded constants would silently drift if the manifest changed. Shape:
//   cli_variants:
//     context/root.md:
//       <cli>:
//         warn_cap_bytes: <int>                 # REQUIRED
//         block_cap_bytes: <int>                # REQUIRED
//         headroom_floor_pct: <int>             # default 10, clamped ≥ 10
//         headroom_proximity_band_pct: <int>    # default 15, clamped > floor
export function loadCliCaps() {
  // D2 EMIT-TUNING (loom#1386) — absent manifest returns the SAME empty object
  // parseCliCaps returns when `cli_variants."context/root.md"` is absent, which
  // emitBaseline resolves to its declared `{warn 32768, block 65536, floor 10}`
  // fallback object. Those equal the manifest's live caps — block was the v6 §2.2 /
  // Risk-0004 61440 until the manifest's 2026-08-12 raise — and
  // emit-class-blind-manifest-reads.test.mjs::F1394-C asserts that parity for EACH CLI
  // against that CLI's own stanza (its per-CLI provenance check and F1394-C-b red if
  // one CLI's caps are read from another's), so a consumer's baseline is gated at the
  // same caps loom enforces — the absent manifest does not widen a cap.
  const src = readManifestSource(REPO);
  if (src === null) return {};
  return parseCliCaps(src);
}

// The keys that make a `context/root.md` child a CLI cap stanza.
const CLI_CAP_KEYS = Object.freeze([
  "warn_cap_bytes",
  "block_cap_bytes",
  "headroom_floor_pct",
  "headroom_proximity_band_pct",
]);

// Pure parser over manifest SOURCE TEXT. Each CLI's caps come from THAT CLI's own
// stanza and nowhere else.
//
//   · `cli_variants."context/root.md"` ABSENT → {} (emitBaseline's fallback).
//   · PRESENT → every CLI in EMIT_CLIS MUST declare a stanza under it with integer
//     warn_cap_bytes and block_cap_bytes; a missing stanza, a missing cap or a
//     non-integer value THROWS. emit.mjs emits a baseline for every EMIT_CLIS
//     member, so a CLI with no parseable caps would otherwise be gated at a
//     default — or, as the regex reader this replaced did for gemini, at another
//     CLI's caps.
//   · A child NOT in EMIT_CLIS that declares a cap key THROWS: those caps would
//     gate nothing (a typo'd `gemeni:` is the case). A child with no cap key —
//     the exception lists, or a CLI stanza that carries no caps — is not a cap
//     stanza and is left alone.
export function parseCliCaps(src) {
  const root = readYamlBlock(src, ROOT_CONTEXT_PATH);
  if (root === null) return {};

  for (const child of root.children) {
    if (EMIT_CLIS.includes(child.key)) continue;
    const capKey = readYamlBlock(src, [...ROOT_CONTEXT_PATH, child.key]).children.find((c) =>
      CLI_CAP_KEYS.includes(c.key),
    );
    if (capKey) {
      throw new Error(
        `[emit] ${ROOT_CONTEXT_LABEL}.${child.key} (line ${child.line}) declares ` +
          `${capKey.key}, but "${child.key}" is not an emitted CLI ` +
          `(${EMIT_CLIS.join(", ")}) — those caps would gate nothing.`,
      );
    }
  }

  const caps = {};
  for (const cli of EMIT_CLIS) {
    const where = `${ROOT_CONTEXT_LABEL}.${cli}`;
    const block = readYamlBlock(src, [...ROOT_CONTEXT_PATH, cli]);
    if (block === null) {
      throw new Error(
        `[emit] ${where} is not declared. emit.mjs emits a baseline for every CLI in ` +
          `EMIT_CLIS (${EMIT_CLIS.join(", ")}), so each MUST declare its caps in its own ` +
          `stanza — refusing to gate ${cli} at a default or at another CLI's caps.`,
      );
    }
    const intCap = (key, absentDefault) => {
      const entry = block.children.find((c) => c.key === key);
      if (entry === undefined) {
        if (absentDefault !== undefined) return absentDefault;
        throw new Error(
          `[emit] ${where}.${key} is missing — a declared CLI's caps MUST parse from its ` +
            `own stanza; refusing to fall back to a default or to another CLI's value.`,
        );
      }
      if (!/^\d+$/.test(entry.value)) {
        throw new Error(
          `[emit] ${where}.${key} (line ${entry.line}) must be a non-negative integer; ` +
            `got "${entry.value}".`,
        );
      }
      return parseInt(entry.value, 10);
    };
    const warnCap = intCap("warn_cap_bytes");
    const blockCap = intCap("block_cap_bytes");
    // Default 10 (Risk-0004 floor) when undeclared. Lower-bound clamp at 10 per the
    // Risk-0004 contract: a manifest edit setting floor < 10 would silently disable
    // enforcement on the very surface the v6.2 plan §3 closes (security-reviewer
    // audit, PR #218 R1).
    const floorPct = Math.max(10, intCap("headroom_floor_pct", 10));
    // F23a / rule-authoring.md MUST Rule 10 — proximity band. Default 15; clamped to
    // floor + 1 so a misconfigured manifest cannot silently disable the advisory band
    // (same fail-closed pattern as the floor clamp, security-reviewer M3).
    let bandPct = intCap("headroom_proximity_band_pct", 15);
    if (bandPct <= floorPct) {
      process.stderr.write(
        `[emit] WARN: ${cli} headroom_proximity_band_pct=${bandPct} <= ` +
          `headroom_floor_pct=${floorPct}; clamping band to ${floorPct + 1} ` +
          `per F23a Security-M3 fail-closed clamp (rule-authoring.md MUST Rule 10).\n`,
      );
      bandPct = floorPct + 1;
    }
    caps[cli] = {
      warn_cap_bytes: warnCap,
      block_cap_bytes: blockCap,
      headroom_floor_pct: floorPct,
      headroom_proximity_band_pct: bandPct,
    };
  }
  return caps;
}

export function getCritBaseline() {
  // CRIT baseline = CANON rules with priority: 0 in frontmatter.
  // Empirically matches the per_rule_size_budget_bytes keys in the manifest.
  // NON-recursive by design: the `.claude/rules/local/` subtree (F-353 Item 4)
  // is a dirent, not a `.md` file, so canon's baseline NEVER enumerates a
  // deployment-local rule (mechanism #1 — canon stays local-blind). Local
  // baseline rules are composed SEPARATELY (getLocalBaselineRules, below) so the
  // add-only overlay is additive, never a canon-baseline mutation.
  const rulesDir = path.join(REPO, ".claude", "rules");
  const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md") && !f.endsWith(".example.md"));
  const crit = [];
  for (const f of files) {
    const content = safeReadFileSync(path.join(rulesDir, f), "utf8");
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const prio = fm[1].match(/^priority:\s*(\d+)/m);
    if (prio && parseInt(prio[1], 10) === 0) crit.push(f);
  }
  return crit.sort();
}

// F-353 Item 4 — deployment-local baseline rules composed ALONGSIDE canon.
// Returns `local/<name>.md` rule names (composeRule joins them under
// `.claude/rules/`, resolving `.claude/rules/local/<name>.md`) for declared
// local rules that carry `priority: 0` (baseline-active parity with canon).
// INERT for canon loom + any deployment with no `local-manifest.yaml` → []. The
// loader ENFORCES the add-only invariant: a local id/path colliding with a canon
// rule is a LOUD `add-only-violation` throw that BLOCKS the emit — a local rule
// can never silently override, shadow, or soften a canon rule.
export function getLocalBaselineRules(repoRoot = REPO) {
  // loadLocalRules enforces the ADD-ONLY invariant (LOUD throw on a canon
  // collision) AND the baseline-only contract (every returned local rule is
  // `priority: 0`), so the returned set is exactly the always-on baseline local
  // rules — no re-filter needed. r.path is repo-relative
  // `.claude/rules/local/<name>.md`; the ruleName composeRule expects is the
  // path UNDER `.claude/rules/` → `local/<name>.md`.
  const { rules } = loadLocalRules(repoRoot);
  return rules.map((r) => r.path.replace(/^\.claude\/rules\//, "")).sort();
}

// #423 AC#4 — pure binding-token guard, exported so the violation shape is
// testable in isolation (mirrors validateAggregateHeadroom). The always-on
// baseline MUST carry ZERO Ruby binding-code fences: Ruby examples live ONLY
// in the on-demand 28-ruby-bindings skill, never the abridged baseline.
// abridgeV6 drops >200B non-DO code blocks, but a ```ruby DO-block ≤200B in a
// rule body survives — this is the mechanical guard against re-introducing the
// rb-in-baseline failure mode the rb→rs collapse eliminated. Python is the
// baseline default example language, so only Ruby fences are asserted-absent.
export function detectBindingTokenViolations(emission, cli, lang = null) {
  const violations = [];
  const lines = String(emission).split("\n");
  // Match ```ruby / ~~~ruby / ```rb at column 0 OR indented, case-insensitive,
  // any fence length (≥3) — covers every fence shape abridgeV6 can pass through
  // (it strips column-0 fences; an indented one survives as a plain line). `\b`
  // after the token excludes ```rbs / ```rbenv (RBS/rbenv are not Ruby code).
  const FENCE_RX = /^[ \t]*(?:`{3,}|~{3,})(ruby|rb)\b/i;
  const idx = lines.findIndex((l) => FENCE_RX.test(l));
  if (idx !== -1) {
    violations.push({
      cli,
      lang,
      token: lines[idx].replace(/^[ \t]*(?:`{3,}|~{3,})/, "").trim(),
      line: idx + 1,
      message:
        "Ruby binding-code fence in the abridged baseline — Ruby binding code " +
        "MUST live in the on-demand 28-ruby-bindings skill, not the always-on " +
        "baseline (#423 Phase 1 invariant). Move it out of the rule body.",
    });
  }
  return violations;
}

// ────────────────────────────────────────────────────────────────
// loom#1355 — declared, time-bounded, per-lane headroom-floor exceptions
// ────────────────────────────────────────────────────────────────
// A lane may emit below `headroom_floor_pct` ONLY via an entry in
// `sync-manifest.yaml::cli_variants."context/root.md".headroom_floor_exceptions`.
// Everything here is fail-CLOSED: a lane with no matching entry, a lane whose
// entry has EXPIRED, and an unparseable clock all resolve to "no exception" →
// the full floor applies and the gate BLOCKS. A MALFORMED declaration THROWS
// rather than degrading into "no floor" (zero-tolerance.md Rule 3 — a silent
// fallback here would hand a permanent waiver to any typo).
//
// The absolute lower bound an exception may grant. When it was set, 5% of the then
// 61,440 B block_cap was 3,072 B of reserve — below the 4 KiB safety margin block_cap
// then held under the Codex override ceiling. The 2026-08-12 raise to 65,536 B put block_cap
// AT that ceiling and consumed the margin
// (sync-manifest.yaml::cli_variants.context/root.md.codex.block_cap_rationale); 5% is now 3,277 B.
// Past that point the
// "reserve" is no longer meaningful and the correct instrument is a cap
// decision (BLOCKED without override-ceiling-stable evidence per the v6.2
// plan §3.2), not a per-lane exception.
export const HEADROOM_EXCEPTION_MIN_FLOOR_PCT = 5;

// CLIs an exception may name. An unknown value THROWS: a typo'd `clis:` entry
// would otherwise silently cover nothing (or, worse, read as coverage).
const HEADROOM_EXCEPTION_KNOWN_CLIS = ["codex", "gemini"];

// Pure parser over the manifest SOURCE TEXT (not a path), so the expiry and
// malformed-declaration branches are testable against an in-memory copy —
// no tracked file is ever mutated to exercise them.
//
// The list block is located by PATH — `cli_variants."context/root.md".<key>`, the
// one place these stanzas are declared — via manifest-source.mjs::readYamlBlock;
// the `- lane: …` items inside it are then read line by line.
// Shared list-block scanner for the declared-exception stanzas
// (`headroom_floor_exceptions`, `per_rule_budget_exceptions`). Returns raw
// `{ __line, <field>: <string> }` records; ALL validation is the caller's, so
// each stanza keeps its own required-field contract. Shared deliberately: the
// bare-`-` branch below is subtle enough that two copies would drift, and a
// drifted copy of a fail-closed parser is a silently-evaporating waiver.
function scanYamlExceptionList(src, keyName) {
  const text = String(src ?? "");
  const block = readYamlBlock(text, [...ROOT_CONTEXT_PATH, keyName]);
  if (block === null) {
    // Absent at the declared path. Absent EVERYWHERE is the fail-closed "no
    // exceptions → full gate everywhere". Declared somewhere ELSE is a waiver that
    // would silently grant nothing, so it is named instead of ignored.
    const strayRe = new RegExp(`^\\s*${keyName}:\\s*(?:#.*)?$`);
    const strayIdx = text.split("\n").findIndex((l) => strayRe.test(l));
    if (strayIdx !== -1) {
      throw new Error(
        `[emit] sync-manifest.yaml line ${strayIdx + 1} declares \`${keyName}:\`, but not ` +
          `at ${ROOT_CONTEXT_LABEL}.${keyName} — the only path emit reads it from. Move ` +
          `it there; left in place it grants nothing and says so nowhere.`,
      );
    }
    return [];
  }

  const entries = [];
  let current = null;
  for (const { line: lineNo, text: line } of block.body) {
    if (/^\s*(#.*)?$/.test(line)) continue; // blank / comment-only
    // The `\s+(.*)` tail is OPTIONAL: YAML permits a bare `-` opening a list
    // item whose fields all sit on the following indented lines. Requiring the
    // tail made such an entry match nothing, so every field beneath it fell to
    // the `!current` arm and the whole declaration silently parsed to zero
    // entries — a written waiver evaporating with no error. (Fail-closed, so
    // never permissive; still a silent misparse the operator gets no signal
    // about.) Caught by fixture-36 during branch enumeration.
    const itemStart = line.match(/^\s*-(?:\s+(.*))?$/);
    if (itemStart) {
      if (current) entries.push(current);
      current = { __line: lineNo };
      const rest = itemStart[1] ?? "";
      if (rest.trim()) assignExceptionField(current, rest);
      continue;
    }
    if (!current) continue; // stray scalar before the first list item
    assignExceptionField(current, line);
  }
  if (current) entries.push(current);
  return entries;
}

export function parseHeadroomExceptions(src) {
  const entries = scanYamlExceptionList(src, "headroom_floor_exceptions");

  const seen = new Set();
  return entries.map((raw) => {
    const where = `sync-manifest.yaml::headroom_floor_exceptions (entry at line ${raw.__line})`;
    const lane = requireHeadroomField(raw, "lane", where);
    const grantedRaw = requireHeadroomField(raw, "granted_floor_pct", where);
    const granted = Number(grantedRaw);
    if (!Number.isFinite(granted)) {
      throw new Error(
        `[emit] ${where}: granted_floor_pct must be a finite number; got "${grantedRaw}".`,
      );
    }
    if (granted < HEADROOM_EXCEPTION_MIN_FLOOR_PCT || granted >= 100) {
      throw new Error(
        `[emit] ${where}: granted_floor_pct ${granted} is outside the permitted ` +
          `[${HEADROOM_EXCEPTION_MIN_FLOOR_PCT}, 100) range. An exception may not ` +
          `relax the reserve below ${HEADROOM_EXCEPTION_MIN_FLOOR_PCT}% — raise ` +
          `block_cap_bytes with override-ceiling evidence instead (v6.2 plan §3.2).`,
      );
    }
    const expires = requireHeadroomField(raw, "expires", where).replace(/^["']|["']$/g, "");
    if (!isValidHeadroomDate(expires)) {
      throw new Error(
        `[emit] ${where}: expires must be a calendar-valid YYYY-MM-DD date; got "${expires}".`,
      );
    }
    const issue = requireHeadroomField(raw, "issue", where);
    const clisRaw = requireHeadroomField(raw, "clis", where);
    const clis = clisRaw
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((c) => c.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    if (clis.length === 0) {
      throw new Error(`[emit] ${where}: clis must name at least one CLI.`);
    }
    for (const c of clis) {
      if (!HEADROOM_EXCEPTION_KNOWN_CLIS.includes(c)) {
        throw new Error(
          `[emit] ${where}: unknown cli "${c}" in clis; known: ` +
            `${HEADROOM_EXCEPTION_KNOWN_CLIS.join(", ")}.`,
        );
      }
      const dupKey = `${c}::${lane}`;
      if (seen.has(dupKey)) {
        throw new Error(
          `[emit] ${where}: duplicate exception for lane "${lane}" on cli "${c}"; ` +
            `two entries covering one lane make the applied floor ambiguous.`,
        );
      }
      seen.add(dupKey);
    }
    return {
      lane,
      clis,
      granted_floor_pct: granted,
      expires,
      issue: String(issue),
      granted_on: raw.granted_on ? String(raw.granted_on).replace(/^["']|["']$/g, "") : null,
      measured_emission_bytes: raw.measured_emission_bytes
        ? Number(raw.measured_emission_bytes)
        : null,
      measured_headroom_pct_at_grant: raw.measured_headroom_pct_at_grant
        ? Number(raw.measured_headroom_pct_at_grant)
        : null,
      measured_shortfall_bytes: raw.measured_shortfall_bytes
        ? Number(raw.measured_shortfall_bytes)
        : null,
      // The block_cap the three `measured_*` figures above were taken against.
      // Carried through (rather than assumed to be the LIVE cap) because a
      // grant older than a cap raise is arithmetically unreadable without it:
      // the rs entry's 8.73% / 783 B re-derive against 61,440 and against
      // nothing else. Optional — an entry that omits it yields null and the
      // caller decides; parse-time enforcement would retroactively invalidate
      // every pre-#2006 grant.
      measured_block_cap_bytes: raw.measured_block_cap_bytes
        ? Number(raw.measured_block_cap_bytes)
        : null,
      rationale: raw.rationale ? String(raw.rationale).replace(/^["']|["']$/g, "") : null,
    };
  });
}

function assignExceptionField(target, text) {
  const kv = text.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*(?:#.*)?$/);
  if (!kv) return;
  const [, key, value] = kv;
  // A quoted value may legitimately contain `#`; the comment strip above is
  // greedy-safe only for unquoted scalars, so re-read quoted values whole.
  const quoted = text.match(/^\s*[A-Za-z_][A-Za-z0-9_]*:\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*$/);
  target[key] = quoted ? quoted[1].slice(1, -1) : value;
}

function requireHeadroomField(raw, key, where) {
  return requireExceptionField(
    raw,
    key,
    where,
    "lane, clis, granted_floor_pct, expires and issue",
  );
}

function requireExceptionField(raw, key, where, mustDeclare) {
  const v = raw[key];
  if (v === undefined || String(v).trim() === "") {
    throw new Error(
      `[emit] ${where}: required field "${key}" is missing. A declared ` +
        `exception MUST declare ${mustDeclare} ` +
        `— an under-specified waiver is not auditable and is rejected (fail-closed).`,
    );
  }
  return String(v).trim();
}

// Calendar-valid, not merely shaped: "2026-13-45" matches the regex but is not
// a date, and Date round-tripping is what rejects it.
function isValidHeadroomDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

// Thin file wrapper — the parse/validate logic lives in the pure function above.
export function loadHeadroomExceptions() {
  // D2 EMIT-TUNING (loom#1386), fail-CLOSED direction. An exception WIDENS a
  // gate (it lowers the headroom floor for one lane), so "no manifest ⇒ no
  // exceptions" is the STRICTEST answer available — a consumer is enforced at
  // the full floor and can never inherit a waiver loom granted itself. Routed
  // through the same pure parser with an empty source so the shape is identical
  // to a present-but-stanza-less manifest.
  const src = readManifestSource(REPO);
  return parseHeadroomExceptions(src === null ? "" : src);
}

// The scope-restriction predicate. Returns the ONE exception that covers this
// (cli, lane) pair and is still in force, or null. Null is the safe answer:
// every null path leaves the caller enforcing the full manifest floor.
//
// `now` is injected (YYYY-MM-DD) so expiry is testable without a clock or a
// file mutation. An absent/invalid `now` resolves to null — fail-closed: if we
// cannot establish that the exception is unexpired, it does not apply.
// Expiry is INCLUSIVE: an exception is in force through the end of its
// `expires` date and lapses the day after.
export function resolveHeadroomException({ cli, lang, exceptions, now }) {
  if (!Array.isArray(exceptions) || exceptions.length === 0) return null;
  const today = typeof now === "string" && isValidHeadroomDate(now) ? now : null;
  if (!today) return null;
  const lane = lang || "base";
  for (const ex of exceptions) {
    if (!ex || ex.lane !== lane) continue;
    if (!Array.isArray(ex.clis) || !ex.clis.includes(cli)) continue;
    if (today > ex.expires) continue; // EXPIRED → falls through to the full floor
    return ex;
  }
  return null;
}

// Compose the floor actually enforced for this lane. `Math.min` is the
// structural guarantee that an exception can only ever move the floor in the
// direction it declared: a nonsense grant ABOVE the base floor is ignored
// rather than silently tightening.
//
// The lower bound is NOT a clamp and this function never sees it: a grant
// below HEADROOM_EXCEPTION_MIN_FLOOR_PCT makes parseHeadroomExceptions THROW
// upstream, so such a grant never reaches here to be clamped. Corrected
// 2026-08-29 (#1953) — the previous wording said "clamp bounds it from
// below", which reads as "a 3.6% grant becomes 5%"; it does not, it kills
// the emission for every lane.
//
// The hard `block_cap_bytes` gate is untouched by this path and stays
// independent.
export function effectiveHeadroomFloorPct(baseFloorPct, exception) {
  if (!exception) return baseFloorPct;
  return Math.min(baseFloorPct, exception.granted_floor_pct);
}

// Today in UTC as YYYY-MM-DD — the default clock for exception resolution.
export function headroomToday() {
  return new Date().toISOString().slice(0, 10);
}

// ── Per-lane, per-rule BUDGET exceptions (loom#1355) ────────────────────────
// The sibling instrument to headroom_floor_exceptions, one measurement surface
// down. `per_rule_size_budget_bytes` is a FLAT map (rule → bytes) with no lane
// dimension, so a language overlay that pushes ONE rule over its block
// threshold has, historically, only had flat remedies: raise the budget for
// EVERY lane, or delete overlay content. This stanza adds the third: accept the
// overrun on the NAMED lane only, with an expiry and a measurement anchor.
//
// Fail-CLOSED on the same three axes as the headroom exception: a rule with no
// matching entry is enforced at the flat ceiling; an entry whose `expires` has
// PASSED resolves to null and the rule reverts to the flat ceiling (the gate
// turns RED again); and a MALFORMED entry THROWS rather than degrading into
// "no ceiling". Two further bounds are budget-relative and therefore checked
// where the budgets are known (emitBaseline): an entry naming a rule with no
// declared budget THROWS (a typo'd rule name would otherwise silently cover
// nothing), and a grant above PER_RULE_BUDGET_EXCEPTION_MAX_MULTIPLE × budget
// THROWS. Both are checked for EVERY declared entry on every emission, not just
// the covered lane, so a malformed waiver cannot hide until that lane runs.
//
// Like its sibling, an exception FREEZES a rule at its measured size — it is
// NOT a budget to spend. `granted_block_ceiling_bytes` is set just above the
// MEASURED emission so any new MUST clause on that lane re-reds the gate.

// A grant may not exceed this multiple of the rule's declared budget. Past 2×
// the rule is not "slightly over" its measurement — the budget itself is wrong
// or the rule needs abridgement/demotion, and the correct instrument is a
// re-measured budget (spec v6 §A.2), not a waiver.
export const PER_RULE_BUDGET_EXCEPTION_MAX_MULTIPLE = 2;

const PER_RULE_BUDGET_EXCEPTION_KNOWN_CLIS = ["codex", "gemini"];

// Pure parser over manifest SOURCE TEXT (not a path), so every branch is
// testable against an in-memory copy — no tracked file is ever mutated.
export function parsePerRuleBudgetExceptions(src) {
  const entries = scanYamlExceptionList(src, "per_rule_budget_exceptions");

  const seen = new Set();
  return entries.map((raw) => {
    const where = `sync-manifest.yaml::per_rule_budget_exceptions (entry at line ${raw.__line})`;
    const must = "lane, clis, rule, granted_block_ceiling_bytes, expires and issue";
    const lane = requireExceptionField(raw, "lane", where, must);
    const rule = requireExceptionField(raw, "rule", where, must).replace(/^["']|["']$/g, "");
    // Same shape the per_rule_size_budget_bytes keys use. A name that cannot be
    // a budget key can never match one, so reject it at parse time rather than
    // let it read as coverage.
    if (!/^[a-z][a-z0-9-]*\.md$/.test(rule)) {
      throw new Error(
        `[emit] ${where}: rule "${rule}" is not a valid rule filename ` +
          `(expected e.g. "security.md"); a name that cannot match a ` +
          `per_rule_size_budget_bytes key would silently cover nothing.`,
      );
    }
    const ceilingRaw = requireExceptionField(raw, "granted_block_ceiling_bytes", where, must);
    const ceiling = Number(ceilingRaw);
    if (!Number.isInteger(ceiling) || ceiling <= 0) {
      throw new Error(
        `[emit] ${where}: granted_block_ceiling_bytes must be a positive ` +
          `integer byte count; got "${ceilingRaw}".`,
      );
    }
    const expires = requireExceptionField(raw, "expires", where, must).replace(/^["']|["']$/g, "");
    if (!isValidHeadroomDate(expires)) {
      throw new Error(
        `[emit] ${where}: expires must be a calendar-valid YYYY-MM-DD date; got "${expires}".`,
      );
    }
    const issue = requireExceptionField(raw, "issue", where, must);
    const clisRaw = requireExceptionField(raw, "clis", where, must);
    const clis = clisRaw
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((c) => c.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    if (clis.length === 0) {
      throw new Error(`[emit] ${where}: clis must name at least one CLI.`);
    }
    for (const c of clis) {
      if (!PER_RULE_BUDGET_EXCEPTION_KNOWN_CLIS.includes(c)) {
        throw new Error(
          `[emit] ${where}: unknown cli "${c}" in clis; known: ` +
            `${PER_RULE_BUDGET_EXCEPTION_KNOWN_CLIS.join(", ")}.`,
        );
      }
      const dupKey = `${c}::${lane}::${rule}`;
      if (seen.has(dupKey)) {
        throw new Error(
          `[emit] ${where}: duplicate exception for rule "${rule}" on lane ` +
            `"${lane}" / cli "${c}"; two entries covering one rule make the ` +
            `applied ceiling ambiguous.`,
        );
      }
      seen.add(dupKey);
    }
    return {
      lane,
      clis,
      rule,
      granted_block_ceiling_bytes: ceiling,
      expires,
      issue: String(issue),
      granted_on: raw.granted_on ? String(raw.granted_on).replace(/^["']|["']$/g, "") : null,
      measured_emission_bytes: raw.measured_emission_bytes
        ? Number(raw.measured_emission_bytes)
        : null,
      measured_overrun_bytes: raw.measured_overrun_bytes
        ? Number(raw.measured_overrun_bytes)
        : null,
      base_budget_bytes_at_grant: raw.base_budget_bytes_at_grant
        ? Number(raw.base_budget_bytes_at_grant)
        : null,
      rationale: raw.rationale ? String(raw.rationale).replace(/^["']|["']$/g, "") : null,
    };
  });
}

// Thin file wrapper — the parse/validate logic lives in the pure function above.
export function loadPerRuleBudgetExceptions() {
  // D2 EMIT-TUNING (loom#1386), fail-CLOSED direction — identical reasoning to
  // loadHeadroomExceptions: a per-rule budget exception RAISES a block ceiling,
  // so "no manifest ⇒ no exceptions" leaves the consumer on the flat ceiling.
  const src = readManifestSource(REPO);
  return parsePerRuleBudgetExceptions(src === null ? "" : src);
}

// The scope-restriction predicate. Returns the ONE exception covering this
// (cli, lane, rule) triple and still in force, or null. Null is the safe
// answer: every null path leaves the caller enforcing the flat ceiling.
// `now` is injected (YYYY-MM-DD) so expiry is testable without a clock or a
// file mutation; an absent/invalid `now` resolves to null — fail-closed.
// Expiry is INCLUSIVE, matching resolveHeadroomException.
export function resolvePerRuleBudgetException({ cli, lang, rule, exceptions, now }) {
  if (!Array.isArray(exceptions) || exceptions.length === 0) return null;
  const today = typeof now === "string" && isValidHeadroomDate(now) ? now : null;
  if (!today) return null;
  const lane = lang || "base";
  for (const ex of exceptions) {
    if (!ex || ex.lane !== lane || ex.rule !== rule) continue;
    if (!Array.isArray(ex.clis) || !ex.clis.includes(cli)) continue;
    if (today > ex.expires) continue; // EXPIRED → falls through to the flat ceiling
    return ex;
  }
  return null;
}

// Compose the BLOCK ceiling actually enforced for this (lane, rule). `Math.max`
// is the structural guarantee that an exception only ever moves the ceiling the
// way it declared: a grant BELOW the flat ceiling is ignored rather than
// silently TIGHTENING the gate on a lane nobody meant to constrain.
export function effectivePerRuleBlockCeiling(baseCeilingBytes, exception) {
  if (!exception) return baseCeilingBytes;
  return Math.max(baseCeilingBytes, exception.granted_block_ceiling_bytes);
}

// Budget-relative validation. Split from the parser because the parser is pure
// over manifest text and does not know the budget map. Called for EVERY
// declared entry on EVERY emission so a malformed waiver surfaces on the first
// emission of any lane, not only the one it names.
export function assertPerRuleBudgetExceptionsBounded(exceptions, budgets) {
  for (const ex of exceptions || []) {
    const where = `sync-manifest.yaml::per_rule_budget_exceptions (rule "${ex.rule}", lane "${ex.lane}")`;
    if (!budgets.has(ex.rule)) {
      throw new Error(
        `[emit] ${where}: no per_rule_size_budget_bytes entry exists for ` +
          `"${ex.rule}". An exception against an unbudgeted rule covers ` +
          `nothing and is rejected (fail-closed) rather than read as coverage.`,
      );
    }
    const budget = budgets.get(ex.rule);
    const maxGrant = budget * PER_RULE_BUDGET_EXCEPTION_MAX_MULTIPLE;
    if (ex.granted_block_ceiling_bytes > maxGrant) {
      throw new Error(
        `[emit] ${where}: granted_block_ceiling_bytes ` +
          `${ex.granted_block_ceiling_bytes}B exceeds the permitted maximum ` +
          `${maxGrant}B (${PER_RULE_BUDGET_EXCEPTION_MAX_MULTIPLE}× the ${budget}B ` +
          `declared budget). A rule that far over its measurement needs a ` +
          `re-measured budget or abridgement per spec v6 §A.2, not a waiver.`,
      );
    }
  }
}

// v6.2 Shard 1 — pure validator for aggregate headroom. Extracted from
// emitBaseline so the violation shape is testable in isolation. Returns
// an array (empty when no breach) so the call site can spread it directly
// into the result; matches the budget_block_violations shape per plan §5.1
// invariant 3 (per-rule budget BLOCK and aggregate-headroom BLOCK are
// independent and both can fire on one emission).
// `floorPct` is the EFFECTIVE floor for this lane — the manifest floor unless a
// declared, unexpired exception lowered it (loom#1355). `exception` is carried
// through only for provenance in the violation record, so a breach that happened
// DESPITE an in-force exception is distinguishable from an ordinary breach.
export function validateAggregateHeadroom({
  cli,
  lang,
  emissionBytes,
  blockCap,
  floorPct,
  exception = null,
}) {
  if (blockCap <= 0) return [];
  const headroomFloorBytes = Math.floor(blockCap * (1 - floorPct / 100));
  const livePctRaw = ((blockCap - emissionBytes) / blockCap) * 100;
  if (livePctRaw >= floorPct) return [];
  return [
    {
      cli,
      lang: lang || "base",
      emission_bytes: emissionBytes,
      block_cap_bytes: blockCap,
      headroom_pct: Number(livePctRaw.toFixed(2)),
      headroom_floor_pct: floorPct,
      headroom_floor_bytes: headroomFloorBytes,
      under_by_bytes: emissionBytes - headroomFloorBytes,
      exception_applied: exception
        ? { lane: exception.lane, granted_floor_pct: exception.granted_floor_pct, expires: exception.expires, issue: exception.issue }
        : null,
      remediation:
        "v6.2 Risk-0004 floor breach: per workspaces/multi-cli-coc/02-plans/" +
        "08-loom-v6.2-headroom-validator.md, demote a CRIT rule to path-scoped " +
        "(per v6 §A.2 + the v2.13.0/v2.19.0/v6.2-Shard-3 precedent), tighten a " +
        "per-rule budget, or trim emission. block_cap raise (option b) is BLOCKED " +
        "without explicit Codex-override-ceiling-stable evidence per plan §3.2. " +
        (exception
          ? "NOTE: a declared headroom_floor_exception is already in force on this " +
            "lane and the emission breached it anyway — the lane has grown since the " +
            "grant. Re-measure and re-decide the exception; do NOT widen it reflexively."
          : "A per-lane headroom_floor_exception in sync-manifest.yaml is a co-owner " +
            "decision (documented, measured and time-bounded), NOT a self-service escape."),
    },
  ];
}

// F23a / rule-authoring.md MUST Rule 10 — proximity-band advisory.
// Emission is above floor (no BLOCK) but within the 15% proximity band:
// the next baseline-priority MUST clause addition on this lane needs
// paired extraction OR named-rationale exception per the rule. Returns
// null when no advisory applies; otherwise an advisory object surfaced
// in dry-run + write reports + console WARN. The 15% default matches
// rule-authoring.md MUST 10 verbatim; per-CLI override lives in
// `sync-manifest.yaml::cli_variants.context/root.md.<cli>.headroom_proximity_band_pct`
// (defaults to 15 when absent).
export const HEADROOM_PROXIMITY_BAND_PCT_DEFAULT = 15;

export function getProximityBandAdvisory({
  cli,
  lang,
  emissionBytes,
  blockCap,
  floorPct,
  proximityBandPct = HEADROOM_PROXIMITY_BAND_PCT_DEFAULT,
}) {
  if (blockCap <= 0) return null;
  if (proximityBandPct <= floorPct) return null; // misconfiguration; no band
  const livePctRaw = ((blockCap - emissionBytes) / blockCap) * 100;
  if (livePctRaw < floorPct) return null; // BLOCK case — handled separately
  if (livePctRaw >= proximityBandPct) return null; // outside band — no advisory
  const proximityBandBytes = Math.floor(blockCap * (1 - proximityBandPct / 100));
  return {
    cli,
    lang: lang || "base",
    emission_bytes: emissionBytes,
    block_cap_bytes: blockCap,
    headroom_pct: Number(livePctRaw.toFixed(2)),
    headroom_floor_pct: floorPct,
    proximity_band_pct: proximityBandPct,
    proximity_band_bytes: proximityBandBytes,
    margin_to_floor_bytes: emissionBytes <= Math.floor(blockCap * (1 - floorPct / 100))
      ? Math.floor(blockCap * (1 - floorPct / 100)) - emissionBytes
      : 0,
    advisory:
      "F23a proximity-band advisory (rule-authoring.md MUST Rule 10): " +
      `headroom ${livePctRaw.toFixed(2)}% within ${proximityBandPct}% proximity band ` +
      `above ${floorPct}% floor. Next baseline-priority MUST clause addition on this ` +
      "lane MUST EITHER ship paired extraction-to-skill recovering ≥ the bytes added " +
      "OR carry a named-rationale exception in the proposal's receipt journal. " +
      "Adding load-bearing content without (a) or (b) is BLOCKED per Rule 10.",
  };
}

// The label every LANE-SCOPED output row carries, printed as
// `[${laneLabel(cli, lang)}] …`: `codex` on a no-`--lang` run (the null lane),
// `codex rs` / `codex base` when `--lang` is set. ONE function, because a row
// that builds its own `[${cli}]` prints the null lane's label on a `--lang rs`
// run — a measurement of rs that reads as a measurement of a different lane
// (emit-arg-validation.test.mjs, "lane label identity"). `lang` is never
// defaulted to "base" here: the null lane and `base` are different compositions
// (lib/emit-axes.mjs header, "`base` IS A LANE").
//
// Lane-INDEPENDENT rows do not use it: `[validator-13]`..`[validator-18]` run
// once per invocation, outside the per-CLI loop in ::main; `[emit] WARN` in
// ::loadCliCaps is a per-CLI manifest clamp no `--lang` changes; `[telemetry]`
// names the shared --out file. The brackets stay at each call site so the
// emit.mjs source needles audit-fixtures/validate-proximity-band/run.mjs
// fixture_13 mutates (`] headroom: `, `] ADVISORY: headroom `) keep matching.
export function laneLabel(cli, lang = null) {
  return lang ? `${cli} ${lang}` : cli;
}

/** True when a canon identity DECLARATION file exists at this tree's canonical
 * path (r4-v6 LOW-2). Mirrors `emit-cli-artifacts.mjs::canonIdentityConfigPresent`
 * exactly: ENOENT alone is the consumer case; any OTHER access failure counts as
 * PRESENT so the assert path runs and fails closed on the read error (only
 * absence is benign — the L1 lesson). Promotion into
 * `lib/strip-build-internal.mjs` is the right end state; it is local here
 * because the shared lib is outside this round's file set, and this comment
 * names the promotion so the drift risk is recorded rather than silent. */
function canonIdentityConfigPresent() {
  try {
    fs.accessSync(path.join(REPO, ".claude", "canon-identity-values.json"), fs.constants.F_OK);
    return true;
  } catch (e) {
    return !(e && e.code === "ENOENT");
  }
}

/** The r4 identity gate for THIS exit's delivered root baselines (r4-v4 F7,
 * correctness item 7), as a NAMED export — the per-exit behavioural case binds
 * the CALL SITE and drives THIS function over planted/clean outputs, the same
 * shape every other registered exit uses (e.g. fork-conference-pack's
 * `assertStagedBundleIdentityClean`). The scan runs over EXACTLY the file this
 * run wrote (`onlyPaths` — never the whole destination tree, which legitimately
 * holds the target's own content).
 *
 * ROLE SPLIT, three states (r4-v6 LOW-2, mirroring emit-cli-artifacts):
 *   • declaration ABSENT (consumer) → `{inert:true}`, empty-set scan, one
 *     informational line from the caller — refusing a consumer's own refresh
 *     is the F6 defect;
 *   • declaration PRESENT → `assertPrivateOrgConfig()` runs FIRST, so a
 *     present-but-EMPTY private set REFUSES (a broken declaration must never
 *     silently disarm the gate);
 *   • declaration PRESENT + non-empty → the scan runs armed.
 * @returns {{inert: boolean}}
 */
export function assertEmittedBaselineIdentityClean(outDir, outPath) {
  const configPresent = canonIdentityConfigPresent();
  const slugs = configPresent
    ? assertPrivateOrgConfig() // present-but-empty REFUSES (LOW-2)
    : emitPrivateOrgSlugs(); // consumer: empty set, the scan below is vacuous
  assertTreeFreeOfPrivateIdentity(outDir, {
    slugs,
    onlyPaths: [outPath],
    label: `emit.mjs ${path.basename(outPath)}`,
  });
  return { inert: !configPresent };
}

export function emitBaseline(cli, outDir, { lang = null, verbose = false, dryRun = false } = {}) {
  // Canon ∪ deployment-local baseline (F-353 Item 4). getLocalBaselineRules is
  // INERT ([]) for canon loom, so this is a no-op here; in a fork with declared
  // local rules it composes them alongside canon (add-only enforced at load).
  const crit = [...getCritBaseline(), ...getLocalBaselineRules()];
  const budgets = loadPerRuleBudgets();
  const tolerance = loadBudgetTolerance();
  const blockThreshold = loadBudgetBlockThreshold();
  // loom#1355 — declared per-lane, per-rule budget exceptions. Bounds that
  // depend on the budget map are asserted here for EVERY declared entry (not
  // just the ones covering this lane), so a typo'd rule name or an over-broad
  // grant halts the first emission of any lane instead of hiding until the
  // named lane runs.
  const perRuleBudgetExceptions = loadPerRuleBudgetExceptions();
  assertPerRuleBudgetExceptionsBounded(perRuleBudgetExceptions, budgets);
  const perRuleBudgetExceptionsApplied = [];
  const perRuleReport = [];
  const chunks = [];
  const allWarnings = [];
  const budgetWarnings = [];
  const budgetBlockViolations = [];

  if (cli === "codex") chunks.push("Read `.codex/rules-index.md` for canonical rule paths and scopes. Before editing or governed operations, load matching path-scoped rules and relevant unscoped rules; Codex does not inject their bodies automatically.");

  for (const rule of crit) {
    const { composed, warnings } = composeRule(rule, cli, lang);
    const fmStripped = stripRuleFrontmatter(composed);
    const abridged = abridgeV6(fmStripped);
    const cleaned = stripSlotMarkers(abridged);
    const bytes = Buffer.byteLength(cleaned, "utf8");

    // Per-rule budget check per sync-manifest.yaml §per_rule_size_budget_bytes.
    // Outside ±tolerance → WARN (drift signal).
    // Over budget * (1 + block_threshold) → BLOCK (contract violation;
    //   per spec v6 §A.2, prevents one CRIT rule from monopolizing the
    //   total emission budget). Pre-Shard-D, only the WARN path was
    //   wired and zero-tolerance.md ran +64% over budget unchecked.
    let budgetStatus = "no_budget";
    if (budgets.has(rule)) {
      const budget = budgets.get(rule);
      const tolHigh = Math.floor(budget * (1 + tolerance));
      const tolLow = Math.floor(budget * (1 - tolerance));
      const baseBlockHigh = Math.floor(budget * (1 + blockThreshold));
      // loom#1355 — a declared, unexpired exception for THIS (cli, lane, rule)
      // raises the BLOCK ceiling for this rule on this lane only. It does NOT
      // touch tolHigh: an exercised exception still emits the `over` WARN
      // below, so the drift signal survives the waiver.
      const budgetException = resolvePerRuleBudgetException({
        cli,
        lang,
        rule,
        exceptions: perRuleBudgetExceptions,
        now: headroomToday(),
      });
      const blockHigh = effectivePerRuleBlockCeiling(baseBlockHigh, budgetException);
      if (budgetException && blockHigh > baseBlockHigh) {
        perRuleBudgetExceptionsApplied.push({
          ...budgetException,
          base_block_threshold_bytes: baseBlockHigh,
          effective_block_ceiling_bytes: blockHigh,
          bytes,
        });
      }
      if (bytes > blockHigh) {
        budgetStatus = "block";
        const overByPct = ((bytes / budget - 1) * 100).toFixed(1);
        budgetBlockViolations.push({
          rule,
          bytes,
          budget,
          block_threshold_bytes: blockHigh,
          over_by_bytes: bytes - blockHigh,
          over_by_pct: Number(overByPct),
          exception_applied: Boolean(budgetException),
        });
        budgetWarnings.push(
          `${rule}: ${bytes}B BLOCKS budget ${budget}B (+${blockThreshold * 100}% block_threshold = ${blockHigh}B); over by ${bytes - blockHigh}B (+${overByPct}% of budget)`,
        );
      } else if (bytes > tolHigh) {
        budgetStatus = "over";
        budgetWarnings.push(
          `${rule}: ${bytes}B over budget ${budget}B (+${tolerance * 100}% = ${tolHigh}B); over by ${bytes - tolHigh}B` +
            (budgetException
              ? ` — NOT blocking: declared per-rule budget exception (issue #${budgetException.issue}, lane '${budgetException.lane}', ceiling ${blockHigh}B, EXPIRES ${budgetException.expires})`
              : ""),
        );
      } else if (bytes < tolLow) {
        budgetStatus = "under";
        budgetWarnings.push(
          `${rule}: ${bytes}B under budget ${budget}B (-${tolerance * 100}% = ${tolLow}B); under by ${tolLow - bytes}B`,
        );
      } else {
        budgetStatus = "ok";
      }
    } else {
      budgetWarnings.push(
        `${rule}: no per_rule_size_budget_bytes entry in sync-manifest.yaml (CRIT rule requires a budget)`,
      );
    }

    perRuleReport.push({
      rule,
      bytes,
      budget: budgets.get(rule) || null,
      budget_status: budgetStatus,
    });
    // CDX-3: drop the redundant `# <filename>.md` H1 prefix — each rule's
    // own H1 (e.g. `# Zero-Tolerance Rules`) is more descriptive and the
    // `---` inter-rule separator below provides structural boundary.
    // CDX-1 fix: stripRuleFrontmatter() above prevents the `---\npriority:`
    // block from showing up where the file-name H1 used to live.
    chunks.push(cleaned);
    if (warnings.length) allWarnings.push({ rule, warnings });
  }

  // CDX-2: append a closing `---` so the document ends with a clean
  // structural terminator rather than the trailing prose of the last
  // rule. `chunks.join` only places separators *between* chunks; without
  // this the final byte lands inside Rule 6a's "Why" paragraph and the
  // file looks truncated to a Codex/Gemini reader.
  // loom#1684 F3 — normalize BEFORE measuring, so the byte count describes the
  // artifact that actually lands on disk. `writeTextArtifactSync` applies the
  // terminator contract at write time; measuring the pre-normalization string
  // would let the two drift. They are equal TODAY only by coincidence of
  // construction (the suffix above already ends in exactly one LF, so the helper
  // is a no-op) — and that coincidence is load-bearing, because the injection
  // budget is at its ceiling and `validate-proximity-band` parses the headroom
  // computed from this number. Any future edit to that suffix would silently
  // desynchronize the budget from the emitted file.
  const emission = ensureTrailingNewline(
    chunks.join("\n---\n\n").replace(/\n+$/, "") + "\n\n---\n",
  );
  const emissionBytes = Buffer.byteLength(emission, "utf8");

  // #423 AC#4 — binding-token regression guard (pure fn exported above for
  // isolation testing). Ruby binding code MUST NOT reach the always-on baseline.
  const bindingTokenViolations = detectBindingTokenViolations(emission, cli, lang);

  // v6 caps — load from sync-manifest.yaml (single source of truth). The
  // previous hardcoded WARN_CAP=32768 / BLOCK_CAP=61440 are now loaded per-CLI
  // from cli_variants.context/root.md.<cli>.{warn,block}_cap_bytes so a
  // manifest edit propagates without touching emit.mjs.
  const allCaps = loadCliCaps();
  const caps = allCaps[cli] || {
    warn_cap_bytes: 32768,
    // 65536 mirrors sync-manifest.yaml's co-owner-approved 61440 → 65536 raise
    // (2026-08-12, plan §3.2 option (b)). PARITY IS THE CONTRACT, enforced by
    // emit-class-blind-manifest-reads.test.mjs::F1394-C: a manifest-less
    // consumer reading a stale fallback would be gated at a cap loom's own gate
    // no longer applies, and would ship a baseline loom would reject.
    //
    // NOTE the asymmetry this creates, recorded rather than left to be found:
    // the manifest grant carries a 2027-02-12 EXPIRY; this constant carries no
    // expiry mechanism. When the grant lapses the manifest reverts and F1394-C
    // reds again, which is the intended signal — but it fires at the NEXT edit,
    // not on the expiry date. Do not read this constant as an independent
    // authorization for 65536; it is a mirror, and the manifest is the source.
    block_cap_bytes: 65536,
    headroom_floor_pct: 10,
  };
  const WARN_CAP = caps.warn_cap_bytes;
  const BLOCK_CAP = caps.block_cap_bytes;
  // v6.2 Risk-0004 floor — emission MUST keep at least this percentage of
  // block_cap as headroom. Default 10% per Risk-0004 contract; per-CLI
  // override via cli_variants.context/root.md.<cli>.headroom_floor_pct.
  const HEADROOM_FLOOR_PCT = caps.headroom_floor_pct;
  // loom#1355 — a DECLARED, unexpired, per-lane exception may lower the floor
  // for THIS lane only. loadHeadroomExceptions THROWS on a malformed
  // declaration (no silent degradation to "no floor"); resolveHeadroomException
  // returns null for every non-matching / expired / unclocked case, so a lane
  // without a live grant is enforced at the full manifest floor.
  const headroomException = resolveHeadroomException({
    cli,
    lang,
    exceptions: loadHeadroomExceptions(),
    now: headroomToday(),
  });
  const EFFECTIVE_HEADROOM_FLOOR_PCT = effectiveHeadroomFloorPct(
    HEADROOM_FLOOR_PCT,
    headroomException,
  );
  if (headroomException) {
    // Loud by construction: an accepted breach that nobody can see is the
    // failure mode this whole mechanism exists to prevent (loom#1348 — the
    // original rs breach survived 11 days because nothing surfaced it).
    console.log(
      `[${laneLabel(cli, lang)}] headroom-floor EXCEPTION APPLIED: floor ` +
        `${HEADROOM_FLOOR_PCT}% → ${EFFECTIVE_HEADROOM_FLOOR_PCT}% for lane ` +
        `'${headroomException.lane}' (declared in sync-manifest.yaml, issue #${headroomException.issue}, ` +
        `EXPIRES ${headroomException.expires} — on expiry this lane reverts to the ` +
        `${HEADROOM_FLOOR_PCT}% floor and the gate turns RED again).`,
    );
  }
  let tier;
  if (emissionBytes >= BLOCK_CAP) tier = "BLOCK";
  else if (emissionBytes >= WARN_CAP) tier = "WARN";
  else tier = "OK";

  // v6.2 Shard 1 — per-lang aggregate headroom validator. Independent of
  // per-rule budget BLOCK (line 440) and tier classification (above).
  // Surfaces a structured violation for any cli×lang combo whose
  // emission would breach the Risk-0004 floor. Both dryRun and regular
  // returns include the array; strict-headroom mode in main() (default
  // on as of v6.2 cycle-2; --no-strict-headroom escape for test-harness)
  // turns a non-empty array into a non-zero exit code so /sync halts at
  // emission.
  const headroomFloorViolations = validateAggregateHeadroom({
    cli,
    lang,
    emissionBytes,
    blockCap: BLOCK_CAP,
    floorPct: EFFECTIVE_HEADROOM_FLOOR_PCT,
    exception: headroomException,
  });

  // F23a proximity-band advisory (rule-authoring.md MUST Rule 10).
  // Default 15%; per-CLI override via sync-manifest.yaml::cli_variants.context/root.md.<cli>.headroom_proximity_band_pct.
  const proximityBandPct =
    (caps.headroom_proximity_band_pct ?? HEADROOM_PROXIMITY_BAND_PCT_DEFAULT);
  // Uses the EFFECTIVE floor so the band stays continuous with the gate: on a
  // lane holding an exception the BLOCK case starts at the granted floor, and
  // the advisory keeps firing above it (visibility is the point — a lane living
  // on an exception must stay noisy, not go quiet).
  const proximityBandAdvisory = getProximityBandAdvisory({
    cli,
    lang,
    emissionBytes,
    blockCap: BLOCK_CAP,
    floorPct: EFFECTIVE_HEADROOM_FLOOR_PCT,
    proximityBandPct,
  });
  if (proximityBandAdvisory) {
    console.log(
      `[${laneLabel(cli, lang)}] ADVISORY: headroom ${proximityBandAdvisory.headroom_pct}% ` +
      `within ${proximityBandPct}% proximity band — next baseline MUST addition requires ` +
      `paired extraction OR named-rationale exception per rule-authoring.md Rule 10.`,
    );
  }

  const emitName = cli === "codex" ? "AGENTS.md" : "GEMINI.md";
  const outPath = path.join(outDir, emitName);
  const reportPath = path.join(outDir, `emit-report-${cli}.json`);

  if (!dryRun) {
    fs.mkdirSync(outDir, { recursive: true });
    writeTextArtifactSync(outPath, emission);
    // r4-v4 F7 (correctness item 7): AGENTS.md / GEMINI.md are DELIVERED root
    // baselines (`commands/sync-to-use.md` Step 6 and `commands/migrate.md`
    // Step 6 both ship them), so this write is a content EXIT. The gate itself
    // is the NAMED export below — the per-exit behavioural case and the
    // registry wiring marker bind to THAT function, never to an inline copy.
    const gate = assertEmittedBaselineIdentityClean(outDir, outPath);
    if (gate.inert) {
      // ARMED BY CONFIG (the F6 role split): a consumer generating into its
      // OWN repo has no `.claude/canon-identity-values.json`, so its scan is
      // vacuous and the generator must NOT refuse a consumer refresh. It says
      // so once per write instead of passing silently, so "no config" is never
      // mistaken for "checked and clean" (`evidence-first-claims.md` MUST-3).
      process.stderr.write(
        `emit.mjs: no .claude/canon-identity-values.json in this checkout — the private-slug scan over ${emitName} is INERT here (a consumer generating into its own repo; the distribution entrypoints assert the config before they distribute).\n`,
      );
    }
  }

  const headroomBytesForReport = Math.max(0, BLOCK_CAP - emissionBytes);
  const headroomPctForReport =
    BLOCK_CAP > 0
      ? Number(((headroomBytesForReport / BLOCK_CAP) * 100).toFixed(2))
      : 0;

  // loom#1539 (B) — UNCONDITIONAL per-lane headroom line.
  //
  // Until now the ADVISORY line above was the ONLY carrier of headroom on
  // stdout, and it prints ONLY when the lane is inside the proximity band.
  // `validate-proximity-band.mjs` therefore had to read "no ADVISORY line"
  // as "lane is above the band" — an inference, not a measurement, and one
  // that is indistinguishable from "the ADVISORY line drifted and no longer
  // parses". Measured: renaming `headroom ` to `headroom of ` in the
  // ADVISORY line above made that gate report both 13.46% lanes as
  // `headroom=(above band)`, `near-breach lanes: 0`, `verdict: clean`,
  // exit 0 — a FALSE CLEAN produced by a one-token edit in a sibling file.
  //
  // A measurement that is printed only when it is interesting cannot
  // distinguish "not interesting" from "not taken"
  // (`instrument-discipline.md` MUST-1). So the number is now printed on
  // EVERY lane, every run, and the gate requires it: a parsed lane with no
  // headroom line is UNRUN, not clean. This line is additive — the
  // ADVISORY / tier / headroom-floor lines are untouched.
  console.log(
    `[${laneLabel(cli, lang)}] headroom: ${headroomPctForReport}% ` +
      `(band ${proximityBandPct}%, floor ${EFFECTIVE_HEADROOM_FLOOR_PCT}%, cap ${BLOCK_CAP}B)`,
  );

  if (dryRun) {
    // Dry-run: return metadata but don't write files; caller reports
    // tier + rule count without touching disk.
    return {
      cli,
      lang,
      out_path: outPath,
      emission_bytes: emissionBytes,
      tier,
      rules: crit.length,
      warn_cap_bytes: WARN_CAP,
      block_cap_bytes: BLOCK_CAP,
      headroom_bytes: headroomBytesForReport,
      headroom_pct: headroomPctForReport,
      headroom_floor_pct: EFFECTIVE_HEADROOM_FLOOR_PCT,
      headroom_floor_pct_declared: HEADROOM_FLOOR_PCT,
      headroom_floor_exception: headroomException,
      headroom_floor_violations: headroomFloorViolations,
      binding_token_violations: bindingTokenViolations,
      proximity_band_advisory: proximityBandAdvisory,
      budget_warnings: budgetWarnings,
      budget_block_violations: budgetBlockViolations,
      per_rule_budget_exceptions_applied: perRuleBudgetExceptionsApplied,
      per_rule: perRuleReport,
      warnings: allWarnings,
      dry_run: true,
    };
  }

  writeTextArtifactSync(
    reportPath,
    JSON.stringify(
      {
        cli,
        lang,
        emit_path: outPath,
        emission_bytes: emissionBytes,
        tier,
        warn_cap: WARN_CAP,
        block_cap: BLOCK_CAP,
        warn_cap_bytes: WARN_CAP,
        block_cap_bytes: BLOCK_CAP,
        headroom_bytes: headroomBytesForReport,
        headroom_pct: headroomPctForReport,
        headroom_floor_pct: EFFECTIVE_HEADROOM_FLOOR_PCT,
        headroom_floor_pct_declared: HEADROOM_FLOOR_PCT,
        headroom_floor_exception: headroomException,
        headroom_floor_violations: headroomFloorViolations,
        binding_token_violations: bindingTokenViolations,
        proximity_band_advisory: proximityBandAdvisory,
        rules_emitted: crit.length,
        per_rule: perRuleReport,
        budget_warnings: budgetWarnings,
        budget_block_violations: budgetBlockViolations,
        per_rule_budget_exceptions_applied: perRuleBudgetExceptionsApplied,
        warnings: allWarnings,
      },
      null,
      2,
    ),
  );

  if (verbose) {
    console.log(`[emit ${laneLabel(cli, lang)}] → ${outPath}`);
    console.log(
      `  ${crit.length} rules, ${emissionBytes}B total (${tier} tier; warn=${WARN_CAP}, block=${BLOCK_CAP})`,
    );
    for (const r of perRuleReport) {
      console.log(`    ${r.rule.padEnd(28)} ${String(r.bytes).padStart(6)} B`);
    }
    if (allWarnings.length) {
      console.log(`  warnings:`);
      for (const w of allWarnings) {
        for (const msg of w.warnings) console.log(`    ${w.rule}: ${msg}`);
      }
    }
  }

  const headroomBytes = Math.max(0, BLOCK_CAP - emissionBytes);
  const headroomPct = BLOCK_CAP > 0 ? (headroomBytes / BLOCK_CAP) * 100 : 0;

  return {
    // Same identity fields as the dry-run return above, so ::main labels a
    // written lane from the result it measured (::laneLabel), not from argv.
    cli,
    lang,
    emission_bytes: emissionBytes,
    tier,
    out_path: outPath,
    rules: crit.length,
    warn_cap_bytes: WARN_CAP,
    block_cap_bytes: BLOCK_CAP,
    headroom_bytes: headroomBytes,
    headroom_pct: Number(headroomPct.toFixed(2)),
    headroom_floor_pct: EFFECTIVE_HEADROOM_FLOOR_PCT,
    headroom_floor_pct_declared: HEADROOM_FLOOR_PCT,
    headroom_floor_exception: headroomException,
    headroom_floor_violations: headroomFloorViolations,
    binding_token_violations: bindingTokenViolations,
    proximity_band_advisory: proximityBandAdvisory,
    budget_warnings: budgetWarnings,
    budget_block_violations: budgetBlockViolations,
    per_rule_budget_exceptions_applied: perRuleBudgetExceptionsApplied,
  };
}

// ────────────────────────────────────────────────────────────────
// Validator 12 — slot round-trip preservation
// ────────────────────────────────────────────────────────────────
// After compose + abridge, each rule's slot structure MUST still be
// parseable (no unclosed slots, no mangled markers).
export function validateSlotRoundTrip(cli, lang = null) {
  const crit = getCritBaseline();
  const failures = [];
  for (const rule of crit) {
    try {
      const { composed } = composeRule(rule, cli, lang);
      parseSlotsV5(composed);
    } catch (err) {
      failures.push({ rule, error: err.message });
    }
  }
  return { pass: failures.length === 0, failures };
}

// ────────────────────────────────────────────────────────────────
// Validator 13 — MCP guardrail bijection
// ────────────────────────────────────────────────────────────────
// Extract predicates from .claude/hooks/ → bijection against acceptance
// fixture expectations. When bijection holds, write policies.json and
// flip POLICIES_POPULATED=true in server.js.
// Async since loom#1538 — the extractor is a lazy `await import`. On a repo
// with no codex surface this returns `skipped: true`, which callers MUST NOT
// print as a pass: nothing was checked (same UNRUN-is-not-PASS contract as
// coc-eval-all.mjs's `coverage_asserted`).
export async function validateMcpBijectionAgainstFixtures() {
  if (!hasCodexGuardSurface()) {
    return {
      pass: true,
      skipped: true,
      reason: `no codex surface at ${path.relative(REPO, CODEX_GUARD_DIR)}/ — Validator 13 is not applicable to a cc-only repo (nothing was verified)`,
    };
  }
  const extractPolicies = await loadExtractPolicies();
  // Fixture moved from workspaces/multi-cli-coc/fixtures/ (gitignored)
  // to .claude/fixtures/ (committed) on 2026-04-22 so emit.mjs works
  // from a fresh clone. USE-template repos vendor the fixture when
  // they vendor .claude/bin/.
  const fixtureDir = path.join(REPO, ".claude", "fixtures", "validator-13");
  const expectedPath = path.join(fixtureDir, "expected-policies.json");
  if (!fs.existsSync(expectedPath)) {
    return { pass: false, reason: `fixture missing: ${expectedPath}` };
  }
  const expected = JSON.parse(safeReadFileSync(expectedPath, "utf8"));
  // requireMatcherMap:false — EXPLICIT opt-out (loom#S73-M5). This validator
  // reads only `predicates[].{id,shape,reason_template}`; it never touches the
  // matcher map or the `policies` table. The fixture dir has no sibling
  // settings.json BY DESIGN (`.claude/fixtures/` holds validator-13 only), so
  // the fail-closed default would refuse a directory that legitimately has no
  // matcher map to build. The enforcement-table caller (wireMcpPolicies) keeps
  // the default and MUST NOT be given this opt-out.
  const actual = extractPolicies(fixtureDir, { requireMatcherMap: false });
  const actualById = new Map(actual.predicates.map((p) => [p.id, p]));
  const failures = [];
  for (const fx of expected.fixtures) {
    const got = actualById.get(fx.predicate.id);
    if (!got) {
      failures.push(`MISSING ${fx.predicate.id}`);
      continue;
    }
    if (got.shape !== fx.shape) failures.push(`SHAPE ${fx.predicate.id}`);
    if (got.reason_template !== fx.predicate.reason_template)
      failures.push(`REASON ${fx.predicate.id}`);
    actualById.delete(fx.predicate.id);
  }
  for (const id of actualById.keys()) failures.push(`EXTRA ${id}`);
  return { pass: failures.length === 0, failures };
}

// ────────────────────────────────────────────────────────────────
// Validator 14 — rule frontmatter per rule-authoring.md Rule 7
// ────────────────────────────────────────────────────────────────
// Every rule MUST declare BOTH `priority:` (0/10/20) AND `scope:`
// (baseline/path-scoped/skill-embedded/excluded). Pair must be consistent:
//   priority:0  ⇒ scope:baseline
//   priority:10 ⇒ scope:path-scoped + `paths:` present
//   priority:20 ⇒ scope:skill-embedded OR scope:excluded
//                 scope:excluded additionally requires `exclude_from: [...]`
//
// Before this validator existed, emit.mjs's getCritBaseline() silently
// dropped rules missing `priority:` — a stripped-frontmatter regression
// evaporated from the emitted baseline with no warning. Session
// 2026-04-24 pre-commit audit caught 5 baseline-rule regressions + 8
// pre-existing path-scoped Rule 7 violations this way.
export function validateRuleFrontmatter() {
  const rulesDir = path.join(REPO, ".claude", "rules");
  const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md") && !f.endsWith(".example.md"));
  const failures = [];

  for (const f of files) {
    const content = safeReadFileSync(path.join(rulesDir, f), "utf8");
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) {
      failures.push(`${f}: MISSING frontmatter block`);
      continue;
    }
    const body = fm[1];
    const prioMatch = body.match(/^priority:\s*(\d+)/m);
    const scopeMatch = body.match(/^scope:\s*(\w[\w-]*)/m);
    const hasPaths = /^paths:/m.test(body);
    const excludeFromMatch = body.match(/^exclude_from:\s*\[([^\]]*)\]/m);

    if (!prioMatch) failures.push(`${f}: MISSING priority: field`);
    if (!scopeMatch) failures.push(`${f}: MISSING scope: field`);
    if (!prioMatch || !scopeMatch) continue;

    const prio = parseInt(prioMatch[1], 10);
    const scope = scopeMatch[1];

    if (prio === 0 && scope !== "baseline") {
      failures.push(`${f}: priority:0 requires scope:baseline (got scope:${scope})`);
    }
    if (prio === 10 && scope !== "path-scoped") {
      failures.push(`${f}: priority:10 requires scope:path-scoped (got scope:${scope})`);
    }
    if (prio === 10 && !hasPaths) {
      failures.push(`${f}: priority:10 + scope:path-scoped requires paths: list`);
    }
    if (prio === 20 && !["skill-embedded", "excluded"].includes(scope)) {
      failures.push(
        `${f}: priority:20 requires scope:skill-embedded or scope:excluded (got scope:${scope})`,
      );
    }
    if (scope === "excluded" && !excludeFromMatch) {
      failures.push(`${f}: scope:excluded requires exclude_from: [cli, ...]`);
    }
    if (![0, 10, 20].includes(prio)) {
      failures.push(`${f}: priority must be 0, 10, or 20 (got ${prio})`);
    }
    if (!["baseline", "path-scoped", "skill-embedded", "excluded"].includes(scope)) {
      failures.push(
        `${f}: scope must be baseline/path-scoped/skill-embedded/excluded (got ${scope})`,
      );
    }
  }

  return { pass: failures.length === 0, failures };
}

// ────────────────────────────────────────────────────────────────
// Validator 18 — cli_delivery lane-declaration contract (#408 AC#5-a/b)
// ────────────────────────────────────────────────────────────────
// The per-rule resolution primitives (CLI_DELIVERY_VALUES, parseExcludeFrom,
// deriveCliDelivery, checkRuleCliDelivery) live in the SHARED lib
// `./lib/cli-delivery.mjs` (imported + re-exported at the top of this file).
// They are shared because BOTH this validator AND the AC#5-b rules-reference
// emitter (emit-cli-artifacts.mjs) must resolve lanes through ONE parser —
// a divergent mirror was the exact R1 finding the AC#5-a redteam closed.
//
//   - baseline      → always-on in AGENTS.md / GEMINI.md (getCritBaseline).
//   - skill-channel → on-demand index entry in the rules-reference skill,
//                     emitted by emit-cli-artifacts.mjs::emitRulesReferenceSkill
//                     (AC#5-b). The index points the non-CC LLM at the
//                     canonical `.claude/rules/<name>.md` (shared path).
//   - cc-only       → genuinely CC-specific; not delivered to Codex/Gemini.
//
// validateCliDelivery() is the fs-wiring: it reads every rule's frontmatter,
// computes the per-lane manifest-exclusion booleans via the SHARED loadExclusions
// + matchesAnyGlob (so the verdict provably tracks the real emit), and buckets
// each rule into the report by its resolved lane.
export function validateCliDelivery() {
  const rulesDir = path.join(REPO, ".claude", "rules");
  const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md") && !f.endsWith(".example.md")).sort();
  // SHARED canonical parser + glob matcher from the emitter (no divergent mirror):
  // the validator's cc-only verdict is computed from the SAME exclusion read the
  // real emit uses, so a future manifest-parse change cannot drift the two apart.
  const excl = loadExclusions();
  const failures = [];
  const report = {
    baseline: [],
    "skill-channel": [],
    "cc-only": [],
    "n/a-skill-embedded": [],
  };

  for (const f of files) {
    const content = safeReadFileSync(path.join(rulesDir, f), "utf8");
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue; // Validator 14 already fails on a missing frontmatter block.
    const relPath = `rules/${f}`;
    const manifest = {
      codex: matchesAnyGlob(relPath, excl.codex || []),
      gemini: matchesAnyGlob(relPath, excl.gemini || []),
    };
    const res = checkRuleCliDelivery(fm[1], manifest);
    for (const msg of res.failures) failures.push(`${f}: ${msg}`);
    if (res.lane) report[res.lane].push(f);
  }

  return { pass: failures.length === 0, failures, report };
}

// ────────────────────────────────────────────────────────────────
// Validator 15 — manifest tier-completeness (loom 2026-05-16, journal
// 0078; agents + skill-dir + command coverage added 2026-07-05, knowledge-
// cascade-routing.md MUST-2). Every .claude/rules/*.md — AND every
// .claude/agents/**/*.md file AND every .claude/skills/<dir>/ directory AND
// every .claude/commands/*.md file — MUST have its distribution fate
// consciously declared in sync-manifest.yaml — exactly one of:
//   (a) tier-listed (cc/coc-core/kailash/onboarding) — shipped to subscribers,
//   (b) use_obsoleted:/obsoleted: — actively purged from templates,
//   (c) use_exclude:/exclude:/loom_only: — deliberately loom-only (never
//       fanned out; rules conventionally use use_exclude, agents+skills+
//       commands use loom_only).
// The failure mode this blocks is SILENT omission: an artifact that is in
// none of these falls out of the subscription-based /sync model
// unnoticed. Before this validator, 16 rules authored at loom were
// never added to a tier and were frozen in templates (matching only by
// the luck of a pre-subscription full-sync). use_exclude IS a conscious
// state (loom-only by design, e.g. loom-csq-boundary.md) — counting it
// as managed prevents false positives on deliberately-excluded rules
// while still hard-failing the unmanaged class. Regex-scoped section
// parse (no YAML dep) over readManifestSource's raw text — the approach every
// manifest reader in this file takes (e.g. parseCliCaps, parseHeadroomExceptions).
// Base-exclusion advisory heuristic (journal/0362 STEP-2). Returns true when a
// rule body shows NEITHER Kailash-framework coupling NOR loom-tooling coupling —
// i.e. it reads as GENERAL COC coding methodology. A general rule sitting in the
// `kailash` tier (which the non-Kailash `base` axis does not subscribe to) is
// the F10 base-coverage gap; the caller flags it as a non-blocking advisory.
// Loom-tooling coupling suppresses the flag because COC-tooling rules (sync /
// variant / cross-CLI) legitimately stay kailash-only (base never runs loom's
// sync machinery). Pure + exported so the heuristic is unit-testable in
// isolation (positive + negative) without live-manifest injection.
const _KAILASH_COUPLING_RE =
  /(kailash|dataflow|nexus|kaizen|\bpact\b|\beatp\b|trust[ -]?plane|workflowbuilder|connection[ -]?pool|infrastructure[ -]?sql|tenant[_ -]?isolation|core sdk|cross-?sdk|build[ -]repo|@db\.model)/i;
const _LOOM_TOOLING_RE =
  /(sync-to-|\/sync\b|sync-manifest|\bloom\b|\bvariant|emit-cli|use template|build repo|cross-?cli|\bcodex\b|\bgemini\b|coc-sync|tier_subscriptions)/i;
export function isBaseExclusionAdvisoryCandidate(ruleBody) {
  if (typeof ruleBody !== "string" || ruleBody.length === 0) return false;
  return !_KAILASH_COUPLING_RE.test(ruleBody) && !_LOOM_TOOLING_RE.test(ruleBody);
}

// ── Agent + skill-directory completeness (loom 2026-07-05, knowledge-cascade-
// routing.md MUST-2) ──────────────────────────────────────────────────────────
// V15 originally hard-failed on an unmanaged rules/*.md ONLY. A NEW agent file
// or a NET-NEW skill DIRECTORY with no manifest declaration silently orphans in
// EXACTLY the same way — it falls out of the subscription-based /sync model
// unnoticed. knowledge-cascade-routing.md MUST-2 names this precise gap ("for
// artifact types V15 does not yet cover (agents, net-new skill directories),
// the author MUST declare the fate consciously, because the backstop will not
// catch the omission"). These two pure helpers extend the SAME completeness
// contract to agents (per-file) and skills (per-directory).
//
// An artifact is MANAGED when its manifest-relative path is declared in ANY
// distribution-fate block: a tier, loom_only, exclude, use_exclude, obsoleted,
// or use_obsoleted. Declarations may be exact files (agents/x.md), directory
// globs (agents/frontend/**, skills/<name>/**), the codex TOML-safety overlay
// form (foo/**.md), or `.claude/`-prefixed trailing-slash dir entries
// (obsoleted:/use_obsoleted: use the `.claude/` prefix; the others do not).
// Regex block-slice + entry-scan (no YAML dep), the same `sliceBlock` shape
// validateTierCompleteness uses. Exported for unit test.
export function _collectDeclaredArtifactPatterns(manifestText) {
  const sliceBlock = (key) => {
    const re = new RegExp(`^${key}:\\s*$`, "m");
    const start = manifestText.search(re);
    if (start === -1) return "";
    const bodyStart = manifestText.indexOf("\n", start);
    if (bodyStart === -1) return "";
    const after = manifestText.slice(bodyStart + 1);
    const nextRel = after.search(/^[A-Za-z_][\w-]*:\s*$/m);
    return after.slice(0, nextRel === -1 ? undefined : nextRel);
  };
  // `- <path>` at any indent; strip an optional quote + trailing `# comment`;
  // normalize away the `.claude/` prefix so obsoleted/use_obsoleted entries
  // (which carry it) compare equal to tier entries (which do not).
  const entriesOf = (block) =>
    [...block.matchAll(/^\s*-\s*"?([A-Za-z0-9_.\/*-]+?)"?\s*(?:#.*)?$/gm)].map(
      (m) => m[1].replace(/^\.claude\//, ""),
    );
  const patterns = new Set();
  for (const key of [
    "tiers",
    "loom_only",
    "exclude",
    "use_exclude",
    "obsoleted",
    "use_obsoleted",
  ]) {
    for (const e of entriesOf(sliceBlock(key))) patterns.add(e);
  }
  // Defense-in-depth: a type-root catch-all (agents/**, skills/**, commands/**,
  // OR the trailing-slash dir agents/ etc.) would trivially satisfy the
  // per-artifact completeness check for that whole type — silently defeating
  // this validator. No legitimate manifest declaration is a bare type-root
  // wildcard (each artifact is declared specifically, e.g. skills/NN-name/**),
  // so drop them. Keeps completeness non-vacuous against a future footgun.
  for (const overBroad of [
    "agents/**",
    "skills/**",
    "commands/**",
    // the `**.md` overlay form is established manifest vocabulary (cli_variants
    // uses `agents/**.md:`), so a future author could write it into a fate block
    // by analogy — and since agent/command paths end in `.md`, `agents/**.md` /
    // `commands/**.md` would vacuously satisfy that whole type's completeness
    // (R2 security-reviewer). Drop them too. (skills/**.md is harmless — a skill
    // `rel` is a directory with no `.md` suffix — but dropped for symmetry.)
    "agents/**.md",
    "skills/**.md",
    "commands/**.md",
    "agents/",
    "skills/",
    "commands/",
  ]) {
    patterns.delete(overBroad);
  }
  return patterns;
}

// True when `rel` (a manifest-relative artifact path, e.g. agents/x.md or the
// skill-directory path skills/<name>) is covered by any declared pattern. Glob
// semantics: exact match; `pre/**` (directory glob — matches the dir itself AND
// anything under it); `pre/**.md` (codex TOML-safety overlay form); `pre/`
// (trailing-slash dir prefix, the obsoleted-dir shape). A skill DIRECTORY is
// managed by its `skills/<name>/**` tier glob because `pre/** → pre === rel`.
export function _artifactIsManaged(rel, patterns) {
  for (const p of patterns) {
    if (p === rel) return true;
    if (p.endsWith("/**") && (rel === p.slice(0, -3) || rel.startsWith(p.slice(0, -2))))
      return true;
    if (p.endsWith("/**.md") && rel.endsWith(".md") && rel.startsWith(p.slice(0, -5)))
      return true;
    if (p.endsWith("/") && (rel === p.slice(0, -1) || rel.startsWith(p))) return true;
  }
  return false;
}

// ── V15 CLASS RULING (loom#1386) ──────────────────────────────────────────────
// V15 is a LOOM-ONLY gate. Its proposition is "every artifact's DISTRIBUTION
// FATE is consciously declared in sync-manifest.yaml" — and distribution fate is
// declared by the SPLITTER, in loom's manifest, when loom classifies an incoming
// proposal (knowledge-cascade-routing.md MUST-2, its "Scope" paragraph: "the
// manifest gate is LOOM-side, NOT the originator's ... The ABSENCE of a local
// `sync-manifest.yaml` in an
// originator is EXPECTED"). A consumer neither owns nor declares that fate, so on
// a manifest-forbidden class there is NO PROPOSITION for V15 to assert.
//
// The two rejected alternatives, and why:
//   - RUN IT ANYWAY (status quo ante): every read returns empty, so every one of
//     the repo's rules/agents/skills/commands reports "unmanaged". Measured on a
//     consumer fixture: 183 false failures. It does not merely mis-report, it
//     BLOCKS emit at a gate whose claim is false there.
//   - PASS VACUOUSLY: a printed PASS is indistinguishable from a real assertion,
//     which is the fail-OPEN shape #1383 rejected for V16. A gate that asserts
//     nothing must SAY it asserted nothing.
// So the verdict carries an explicit third state, `skipped` + `skipReason`, and
// main() prints SKIP with the reason. Precedent: validate-emit.mjs's F1030d
// consumer skip ("community-edition completeness is a loom-only concern; skipped
// at a consumer").
//
// WHAT A CONSUMER LOSES: nothing it ever had — the check was never TRUE there.
// Consumer-side artifact management runs through `/sync-from-template` merge, not
// tier subscription. A consumer-local orphan check would be a NEW validator with
// a consumer-true proposition, not this one.
export function validateTierCompleteness() {
  if (!isManifestOwnerClass(REPO)) {
    const { type } = readRepoClass(REPO);
    return {
      pass: true,
      skipped: true,
      skipReason:
        `class:${type} → distribution fate is declared in LOOM's ` +
        `sync-manifest.yaml, never here (a local manifest would be a SECOND ` +
        `distribution source — see validator 16). Tier-completeness has no ` +
        `proposition to assert on a "${type}" repo, so it asserts none rather ` +
        `than reporting every local artifact as "unmanaged".`,
      failures: [],
      advisories: [],
    };
  }
  const rulesDir = path.join(REPO, ".claude", "rules");
  // Owner class: absence here is a DEFECT, and readManifestSource throws LOUD on
  // it — preserving #1383's fail-closed direction at the reader as well as at
  // V16. `text` is non-null precisely because of the class gate above.
  const text = readManifestSource(REPO);

  // Slice a top-level YAML block: from the line AFTER `^<key>:` to the
  // next column-0 key. Slicing must start past the key's own newline —
  // otherwise the next-key search matches the tail of the key line.
  const sliceBlock = (key) => {
    const re = new RegExp(`^${key}:\\s*$`, "m");
    const start = text.search(re);
    if (start === -1) return "";
    const bodyStart = text.indexOf("\n", start);
    if (bodyStart === -1) return "";
    const after = text.slice(bodyStart + 1);
    const nextRel = after.search(/^[A-Za-z_][\w-]*:\s*$/m);
    return after.slice(0, nextRel === -1 ? undefined : nextRel);
  };

  const tiersBlock = sliceBlock("tiers");
  const obsBlock = sliceBlock("use_obsoleted");
  const exclBlock = sliceBlock("use_exclude");

  const tiered = new Set(
    [...tiersBlock.matchAll(/^\s*-\s*rules\/([a-z0-9-]+)\.md\s*$/gm)].map(
      (m) => `${m[1]}.md`,
    ),
  );
  // use_obsoleted entries are `.claude/rules/x.md`; use_exclude entries
  // are `rules/x.md` (no `.claude/` prefix). Match both shapes.
  const obsoleted = new Set(
    [...obsBlock.matchAll(/^\s*-\s*\.claude\/rules\/([a-z0-9-]+)\.md\s*$/gm)].map(
      (m) => `${m[1]}.md`,
    ),
  );
  const excluded = new Set(
    [...exclBlock.matchAll(/^\s*-\s*rules\/([a-z0-9-]+)\.md\s*$/gm)].map(
      (m) => `${m[1]}.md`,
    ),
  );

  const failures = [];
  for (const f of fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md") && !f.endsWith(".example.md"))) {
    if (!tiered.has(f) && !obsoleted.has(f) && !excluded.has(f)) {
      failures.push(
        `${f}: unmanaged — declare its distribution fate in ` +
          `sync-manifest.yaml: add to a tier (cc/coc-core/kailash/onboarding), OR ` +
          `use_obsoleted: (purge from templates), OR use_exclude: ` +
          `(loom-only). (journal 0078)`,
      );
    }
  }

  // ── Agents + skill-directory completeness (knowledge-cascade-routing MUST-2) ──
  // Same hard-fail contract as rules above, extended to agents (per-file, minus
  // the non-agent agents/_README.md) and skills (per-directory). A NEW agent or
  // net-new skill dir with no declared distribution fate is an unmanaged orphan
  // that silently falls out of /sync — exactly the rule-orphan failure V15 was
  // built to block, one artifact-type over.
  const declaredPatterns = _collectDeclaredArtifactPatterns(text);
  const agentsDir = path.join(REPO, ".claude", "agents");
  const skillsDir = path.join(REPO, ".claude", "skills");
  const walkMd = (dir) => {
    let out = [];
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) out = out.concat(walkMd(fp));
      else if (e.name.endsWith(".md")) out.push(fp);
    }
    return out;
  };
  for (const fp of walkMd(agentsDir)) {
    const rel = "agents/" + path.relative(agentsDir, fp).split(path.sep).join("/");
    if (rel.endsWith("/_README.md") || rel === "agents/_README.md") continue;
    if (!_artifactIsManaged(rel, declaredPatterns)) {
      failures.push(
        `${rel}: unmanaged agent — declare its distribution fate in ` +
          `sync-manifest.yaml: add to a tier (cc/coc-core/kailash/onboarding), OR ` +
          `loom_only: (loom-internal), OR exclude:/obsoleted: (never/no-longer ` +
          `synced). (knowledge-cascade-routing.md MUST-2)`,
      );
    }
  }
  if (fs.existsSync(skillsDir)) {
    for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const rel = "skills/" + e.name;
      if (!_artifactIsManaged(rel, declaredPatterns)) {
        failures.push(
          `${rel}/: unmanaged skill directory — declare its distribution fate in ` +
            `sync-manifest.yaml: add a ${rel}/** entry to a tier (cc/coc-core/` +
            `kailash/onboarding), OR loom_only: (loom-internal), OR ` +
            `obsoleted: (no longer synced). (knowledge-cascade-routing.md MUST-2)`,
        );
      }
    }
  }
  // COMMANDS: every .claude/commands/*.md is manifest-tier-managed by an
  // individual entry (there is NO commands/** catch-all in any fate block), so
  // a new command with no declaration silently skips emission
  // (emit-cli-artifacts.mjs::emitCommands tierFilter skip) exactly as an
  // unmanaged agent does. Same completeness contract (self-ref redteam R1
  // cc-architect HIGH-1: commands are the same orphan class; reconcile-notes.md
  // was a live instance). surface_roles: de-surfacing does NOT confer
  // managed-ness — a de-surfaced command still ships to build/use, so tier
  // membership remains the fate axis.
  const commandsDir = path.join(REPO, ".claude", "commands");
  for (const fp of walkMd(commandsDir)) {
    const rel = "commands/" + path.relative(commandsDir, fp).split(path.sep).join("/");
    if (!_artifactIsManaged(rel, declaredPatterns)) {
      failures.push(
        `${rel}: unmanaged command — declare its distribution fate in ` +
          `sync-manifest.yaml: add to a tier (cc/coc-core/kailash/onboarding), OR ` +
          `loom_only: (loom-internal), OR exclude:/obsoleted: (never/no-longer ` +
          `synced). (knowledge-cascade-routing.md MUST-2)`,
      );
    }
  }

  // ── Base-exclusion advisory (journal/0362 STEP-2; F10 base-coverage class) ──
  // The `kailash` tier is the Kailash-framework SUBSET of COC; the non-Kailash
  // `base` axis does NOT subscribe to it (subscribes cc + coc-core + onboarding).
  // A GENERAL COC coding rule mis-placed in `kailash` is therefore SILENTLY
  // excluded from base (classifyFile -> no_tier_match -> skip) — the exact F10
  // gap the 2026-06-26 base-coverage reconciliation fixed by hand. This is the
  // ADVISORY-flag heuristic (owner-approved 2026-06-28) that prevents RECURRENCE:
  // a kailash-only rule with ZERO Kailash-framework AND ZERO loom-tooling
  // coupling is probably general and belongs in `coc-core` so base receives it.
  // ADVISORY only (non-blocking) — it is a content heuristic, not a structural
  // fact, so per hook-output-discipline.md MUST-2 it MUST NOT block /sync; a
  // human verifies, then moves or annotates. Suppressed by loom-tooling tokens
  // because COC-tooling rules (coc-sync-landing/sync-completeness/variant-
  // authoring/cross-cli-parity) legitimately stay kailash-only (base consumers
  // never run loom's sync/variant machinery).
  // SCOPE (rules-only): this advisory walks `rules/*.md` only — validator-15's
  // pre-existing domain. The F10 base-coverage walk also found kailash-only
  // COMMANDS / SKILLS / AGENTS the reconciliation hand-moved to coc-core; a
  // future general command/skill/agent mis-placed in `kailash` is NOT caught by
  // this advisory. Extending the heuristic to those classes is a follow-up
  // (out of journal/0362 STEP-2's validator-15 scope).
  const tierRulesOf = (name) => {
    const re = new RegExp(`^  ${name}:\\s*$`, "m");
    const start = tiersBlock.search(re);
    if (start === -1) return new Set();
    const bodyStart = tiersBlock.indexOf("\n", start);
    if (bodyStart === -1) return new Set();
    const after = tiersBlock.slice(bodyStart + 1);
    const nextRel = after.search(/^  [A-Za-z_][\w-]*:\s*$/m);
    const body = after.slice(0, nextRel === -1 ? undefined : nextRel);
    return new Set(
      [...body.matchAll(/^\s*-\s*rules\/([a-z0-9-]+)\.md\s*$/gm)].map(
        (m) => `${m[1]}.md`,
      ),
    );
  };
  const kailashRules = tierRulesOf("kailash");
  const baseReaching = new Set([
    ...tierRulesOf("cc"),
    ...tierRulesOf("coc-core"),
    ...tierRulesOf("onboarding"),
  ]);
  const advisories = [];
  for (const f of kailashRules) {
    if (baseReaching.has(f)) continue; // reaches base via another tier
    const fp = path.join(rulesDir, f);
    if (!fs.existsSync(fp)) continue;
    const body = safeReadFileSync(fp, "utf8");
    if (!isBaseExclusionAdvisoryCandidate(body)) continue;
    advisories.push(
      `${f}: in the \`kailash\` tier (excluded from the non-Kailash \`base\` ` +
        `axis) but shows NO Kailash-framework or loom-tooling coupling — likely ` +
        `GENERAL COC coding methodology that belongs in \`coc-core\` so base ` +
        `receives it. Verify by hand, then move to coc-core OR annotate why it ` +
        `is Kailash-scoped. (F10 base-coverage class; journal/0362 STEP-2)`,
    );
  }
  return { pass: failures.length === 0, failures, advisories };
}

// ────────────────────────────────────────────────────────────────
// Validator 16 — strict-YAML manifest gate (loom 2026-05-16, journal
// 0080). emit.mjs reads sync-manifest.yaml as raw text (readManifestSource)
// and scans it with narrow line/regex parsers — no YAML dep, by design. Those
// parsers are YAML-SYNTAX-BLIND: a
// structurally-broken manifest still lets `emit --dry-run` exit 0,
// while every strict-YAML consumer (verify-overlays.sh, yq, downstream
// /sync) fails repo-wide. PR #246 shipped exactly this — a list scalar
// with an embedded ": " — and it passed the emit gate. This validator
// closes the hole: a strict YAML parse (python3 yaml.safe_load shell-
// out, so emit.mjs stays Node-dependency-free) MUST succeed or emit
// hard-fails. Runs BEFORE Validator 15 in main() — V15's regex section
// parse is only trustworthy on a syntactically valid manifest.
//
// CLASS-CONDITIONAL since loom#1383. emit.mjs ships verbatim to consumers
// of every repo class, and the original gate demanded a manifest in ALL of
// them — so `emit.mjs --all` exited 1 in every coc-build repo, which is
// architecturally REQUIRED not to hold one. The gate now reads
// `.claude/VERSION::type` and asserts the class-appropriate expectation:
// coc-source MUST hold a manifest that parses; coc-build/coc-use-template/
// coc-project MUST NOT hold one at all (see _classifyManifestPresence for
// the split-brain rationale). Both directions FAIL — this is STRICTER than
// the original in both, never "skip when absent".
// Pure classification of the python-YAML-probe result → {pass, failures}.
// Exported for test. Distinguishes FOUR dispositions so an ENVIRONMENT gap is
// never reported as a manifest defect (evidence-first-claims: assert only what
// the probe found):
//   • python3 absent (spawn ENOENT)      → env-gap advisory, pass:false
//   • PyYAML absent (ModuleNotFoundError) → env-gap advisory, pass:false
//   • non-zero + YAMLError                → real defect, pass:false
//   • status 0                            → pass:true
// The two env-gap branches fail-loud (pass:false) — an env that cannot verify
// MUST NOT silently pass — but say WHY honestly, never "not valid YAML".
export function _classifyManifestYamlProbe(r) {
  if (r.error && r.error.code === "ENOENT") {
    // python3 absent — degrade to a clear advisory, do NOT silently pass.
    return {
      pass: false,
      failures: [
        "python3 not found — cannot strict-YAML-validate the manifest. " +
          "Install python3 (PyYAML) OR validate manually before emit.",
      ],
    };
  }
  const stderr = (r.stderr || "").trim();
  // Anchor on the `ModuleNotFoundError:` prefix (the uncaught `import yaml`
  // failure always carries it; a `yaml.YAMLError` str never does) so a broken
  // manifest whose parse-error text happens to contain "No module named yaml"
  // cannot be misclassified as an env gap. Both dispositions are pass:false, so
  // this only sharpens the MESSAGE — but an honest classifier asserts only what
  // the probe found (evidence-first-claims). (R1 redteam LOW-1, #764 follow-up.)
  if (r.status !== 0 && /ModuleNotFoundError: No module named ['"]?yaml['"]?/.test(stderr)) {
    // PyYAML absent — mirror the python3-ENOENT branch. This is an ENVIRONMENT
    // gap, NOT a manifest defect: reporting "not valid YAML" here would assert a
    // defect the probe never found (the manifest may be perfectly valid; the env
    // just cannot check). #764: the emit-side twin of the test-harness skip-guard.
    return {
      pass: false,
      failures: [
        "PyYAML not installed — cannot strict-YAML-validate the manifest. " +
          "Install PyYAML (`pip install pyyaml`) OR validate manually before emit. " +
          "(Environment gap, not a manifest defect.)",
      ],
    };
  }
  // MISSING/UNREADABLE is NOT malformed (loom#1383 defect 2). The probe now
  // catches OSError on open() separately and tags it, so a file that never
  // opened can never be reported as a PARSE failure. Before this, `open()` on a
  // missing path raised FileNotFoundError straight past the `yaml.YAMLError`
  // handler and surfaced verbatim under "is not valid YAML" — two different
  // conditions, one indistinguishable error. Ordered AFTER the two env-gap
  // branches (an `import yaml` failure precedes any open()) and BEFORE the
  // generic non-zero branch, which stays the malformed-manifest disposition.
  if (r.status !== 0 && /^MANIFEST_UNREADABLE: /m.test(stderr)) {
    return {
      pass: false,
      failures: [
        `sync-manifest.yaml could not be OPENED (missing or unreadable) — ` +
          `this is NOT a YAML syntax defect: ` +
          `${stderr.replace(/^MANIFEST_UNREADABLE: /m, "").slice(0, 400)}`,
      ],
    };
  }
  if (r.status !== 0) {
    return {
      pass: false,
      failures: [`sync-manifest.yaml is not valid YAML: ${stderr.slice(0, 400)}`],
    };
  }
  // A zero exit is NOT a pass on its own. The probe writes a SENTINEL as its last
  // act, so a zero exit WITHOUT it means the interpreter never ran the script —
  // the corrupt-shim case measured 2026-09-20, where `python3` exited 0 for every
  // input and this validator consequently blessed a manifest carrying an unclosed
  // flow sequence. Fail CLOSED and NAME the reason, rather than assert a parse
  // that never happened.
  if (!String(r.stdout || "").includes(_MANIFEST_YAML_SENTINEL)) {
    return {
      pass: false,
      failures: [
        "python3 exited 0 but the YAML probe never reported running (sentinel " +
          `'${_MANIFEST_YAML_SENTINEL}' absent from stdout) — so the manifest was NOT ` +
          "validated and this is NOT a pass. The interpreter resolved on PATH is not " +
          "executing the script it was given; a corrupt pyenv shim does exactly this. " +
          "Verify with: python3 -c 'import nonexistent_module_xyz' — a WORKING " +
          "interpreter exits NON-zero. Repair the interpreter (or clear the shim) and re-run.",
      ],
    };
  }
  return { pass: true, failures: [] };
}

// ────────────────────────────────────────────────────────────────
// Repo-class resolution for the class-conditional V16 gate (loom#1383).
//
// `.claude/VERSION::type` is the repo's CLASS declaration (see
// the header comment of .claude/hooks/lib/version-utils.js for the canonical
// four). emit.mjs is
// DISTRIBUTED verbatim to consumers of every class, so any gate it runs must
// assert something true FOR THE CLASS IT IS RUNNING IN — not for loom.
//
// loom#1386 MOVED `readRepoClass` + MANIFEST_OWNER_CLASS /
// MANIFEST_FORBIDDEN_CLASSES / KNOWN_REPO_CLASSES to `lib/manifest-source.mjs`
// (imported + re-exported at the top of this file, so every prior importer is
// unaffected). The move is REQUIRED, not cosmetic: `lib/coc-manifest.mjs` and
// `lib/variant-overlay.mjs` also need the class read, and emit.mjs already
// imports FROM emit-cli-artifacts.mjs → lib/coc-manifest.mjs, so having them
// import the class read back from HERE would be a cycle. manifest-source.mjs
// carries zero internal imports for exactly that reason.

// Pure class→expectation+presence classifier (no filesystem, no spawn) so every
// branch is unit-testable. Returns {pass, failures, probe}: `probe` true means
// the caller MUST still run the strict-YAML parse (owner class, file present).
//
// WHY the non-owner classes assert MUST-NOT-EXIST rather than skipping:
// a second manifest is a SECOND DISTRIBUTION SOURCE. `sync-manifest.yaml` is
// where an artifact's distribution fate is declared; loom declares it when it
// CLASSIFIES an incoming proposal (knowledge-cascade-routing.md MUST-2, its
// "Scope" paragraph —
// "the manifest gate is LOOM-side, NOT the originator's ... The ABSENCE of a
// local `sync-manifest.yaml` in an originator is EXPECTED"). Two manifests means
// two places declaring that fate; when they disagree an artifact either cascades
// twice or not at all — and NOTHING detects the divergence, because each repo's
// own run is green against its own manifest. So absence is not merely tolerated
// in a consumer, it is REQUIRED; and "skip the gate when the file is absent"
// is rejected outright — that is a fail-OPEN gate on unconfigured input, which
// would also stop catching a genuinely-missing manifest at loom.
export function _classifyManifestPresence({
  repoClass,
  classError,
  manifestExists,
}) {
  if (classError) {
    return {
      pass: false,
      probe: false,
      failures: [
        `repo class UNRESOLVED — ${classError}. Validator 16 asserts a ` +
          `DIFFERENT manifest expectation per class (${MANIFEST_OWNER_CLASS}: ` +
          `manifest MUST exist; ${MANIFEST_FORBIDDEN_CLASSES.join("/")}: ` +
          `manifest MUST NOT exist), so it fails CLOSED rather than guess. ` +
          `Repair .claude/VERSION before emit.`,
      ],
    };
  }
  if (repoClass === MANIFEST_OWNER_CLASS) {
    if (!manifestExists) {
      return {
        pass: false,
        probe: false,
        failures: [
          `sync-manifest.yaml is MISSING (not malformed) — a ` +
            `${MANIFEST_OWNER_CLASS} repo is the splitter/distributor and MUST ` +
            `hold the manifest that declares every artifact's distribution ` +
            `fate. Without it nothing cascades. Restore ` +
            `.claude/sync-manifest.yaml before emit.`,
        ],
      };
    }
    return { pass: true, probe: true, failures: [] };
  }
  // Non-owner class: the manifest MUST NOT exist.
  if (manifestExists) {
    return {
      pass: false,
      probe: false,
      failures: [
        `sync-manifest.yaml MUST NOT exist in a "${repoClass}" repo — found ` +
          `one. A local manifest is a SECOND distribution source: loom already ` +
          `declares this repo's artifacts' distribution fate when it classifies ` +
          `the proposal, so a local manifest claims to classify them too. When ` +
          `the two disagree an artifact either cascades twice or not at all, ` +
          `and nothing detects the divergence. Originate via /codify → ` +
          `.claude/.proposals/latest.yaml and DELETE the local manifest ` +
          `(knowledge-cascade-routing.md § Scope).`,
      ],
    };
  }
  return { pass: true, probe: false, failures: [] };
}

// The strict-YAML probe source. Exported so the test suite can drive the REAL
// python behaviour (the OSError-vs-YAMLError split) against the same string
// emit runs, instead of a hand-copied duplicate that would silently drift.
// open() is guarded separately from safe_load() so a file that cannot be OPENED
// reports as MANIFEST_UNREADABLE, never as a parse failure (loom#1383 defect 2).
// The trailing SENTINEL write is load-bearing, not decoration. Before it, SUCCESS
// was signalled ONLY by exit status 0 and an empty stdout — which is byte-identical
// to an interpreter that never executed this script at all. MEASURED 2026-09-20 on
// this workstation: a corrupt pyenv install left `python3` printing its own prefix
// directory and exiting 0 for EVERY input, including `import nonexistent_module`.
// The validator therefore reported every manifest — including one with a deliberately
// appended unclosed flow sequence — as strict-valid YAML. A validator that cannot
// fail is not a validator (instrument-discipline.md MUST-1: exit 0 is not
// discrimination). Requiring the probe to SAY it ran converts that silent
// fail-OPEN into a named refusal.
export const _MANIFEST_YAML_SENTINEL = "MANIFEST_YAML_PROBE_RAN";
export const _MANIFEST_YAML_PROBE_PY =
  "import sys,yaml\n" +
  "try:\n fh = open(sys.argv[1])\n" +
  "except OSError as e:\n sys.stderr.write('MANIFEST_UNREADABLE: ' + str(e))\n sys.exit(3)\n" +
  "try:\n yaml.safe_load(fh)\n" +
  "except yaml.YAMLError as e:\n sys.stderr.write(str(e))\n sys.exit(1)\n" +
  "finally:\n fh.close()\n" +
  "sys.stdout.write('MANIFEST_YAML_PROBE_RAN')";

// Validator 16 entry point — class-conditional (loom#1383). `manifestPath` and
// `repoRoot` are both injectable so fixture trees can drive every class branch
// without mutating the live repo.
export function validateManifestYaml(
  manifestPath = path.join(REPO, ".claude", "sync-manifest.yaml"),
  repoRoot = REPO,
) {
  const { type: repoClass, error: classError } = readRepoClass(repoRoot);
  const presence = _classifyManifestPresence({
    repoClass,
    classError,
    manifestExists: fs.existsSync(manifestPath),
  });
  if (!presence.probe) {
    return { pass: presence.pass, failures: presence.failures };
  }
  // Owner class with the manifest present — it must also PARSE.
  // The probe's own OSError guard is a defence-in-depth backstop for the
  // check-to-use window between the fs.existsSync above and this spawn.
  const r = spawnSync(
    "python3",
    ["-c", _MANIFEST_YAML_PROBE_PY, manifestPath],
    { encoding: "utf8" },
  );
  return _classifyManifestYamlProbe(r);
}

// ────────────────────────────────────────────────────────────────
// Validator 17 — multi-operator substrate hook ⇔ data file coupling
// (loom F67 2026-05-28, journal 0161, GH issue #379).
//
// roster-schema-validate.js + genesis-anchor-guard.js read
// .claude/operators.roster.schema.json at runtime (path hardcoded in
// hooks/lib/roster-schema-validate.js::SCHEMA_PATH). Before F67 the substrate sync
// shipped the validator code but not the schema; consumer repos that
// received the substrate without the schema had genesis-anchor-guard
// fail-close every commit ("operators roster missing; trust root not
// established") — the schema is not consumer-authorable, so there is
// no in-repo recovery path.
//
// This validator codifies the coupling: if either hook is present in
// loom source (which it is and will be), the manifest's tiered set
// MUST contain operators.roster.schema.json — bare existence in
// .claude/ is NOT enough; the path must appear in a tier so /sync
// distributes it. Structural exit per hook-output-discipline.md
// MUST-2 (file-existence + tier-membership are structural signals,
// not lexical regex).
// ── V17 CLASS RULING (loom#1386) — a SPLIT, not a blanket skip ────────────────
// V17 bundles TWO propositions with different class-truth, and the pre-#1386 code
// could not reach the second one on a consumer because it died on the manifest
// read between them.
//
//   HALF A — hook ⇔ schema FILE coupling ("if roster-schema-validate.js /
//     genesis-anchor-guard.js are present, .claude/operators.roster.schema.json
//     MUST be present"). This is CLASS-INDEPENDENT and it is the half that
//     protects the CONSUMER: the failure V17 exists to block is a consumer whose
//     genesis-anchor-guard fail-closes EVERY COMMIT ("operators roster missing;
//     trust root not established") with no in-repo recovery path, because the
//     schema is not consumer-authorable. That proposition is true, checkable, and
//     load-bearing on a coc-build / coc-use-template / coc-project repo.
//
//   HALF B — manifest tier-membership + the F70 end-to-end
//     `sync-tier-aware --target <t> --dry-run` sweep. BOTH are DISTRIBUTION
//     assertions: tier membership is loom's declaration, and `declaredTargets`
//     below is LOOM's sync-target list. A consumer has no sync targets, so half B
//     asserts loom's distribution plan from inside a repo that has none.
//
// Blanket-skipping V17 on a consumer would have been the easy ruling and it is
// WORSE than the split: it would leave the consumer-protecting half A unrun
// forever, which is exactly the state the crash produced. So half A runs
// everywhere; half B is gated on the owner class and reports `skipped`.
// ────────────────────────────────────────────────────────────────
// loom#1424 defect 2 — a validator MUST NOT announce a failure while naming
// nothing.
//
// Every `VALIDATOR N FAIL` body in main() was rendered as
// `v.failures.map((l) => "  " + l).join("\n")`. On an empty (or all-blank)
// `failures` array that renders to the EMPTY STRING, so the operator gets a
// header and a void: a verdict with no cause, indistinguishable from a
// reporting bug, and un-actionable either way. That is a non-discriminating
// instrument in the sense of rules/instrument-discipline.md — the output is
// identical whether the validator found something it failed to report or
// returned `pass:false` by mistake.
//
// Routing every render through here makes the empty body unreachable: the
// function either names the offenders, or names the reporting defect itself.
//
// WHAT THIS DELIBERATELY DOES NOT DO: force `pass:true` when the list is empty.
// That would convert a reporting bug into a silent green — the exact
// silent-fallback shape rules/zero-tolerance.md Rule 3 blocks — and would let a
// genuine finding vanish. A loud, named, blocking report is the correct
// disposition for "the validator failed and cannot say why".
//
// Blank-but-present entries are filtered BEFORE the count, because
// `["", "  "]` renders to whitespace and reads to a human exactly like the
// empty case it is meant to exclude.
export function renderValidatorFailureBody(validatorId, failures) {
  const items = Array.isArray(failures)
    ? failures.filter((l) => typeof l === "string" && l.trim() !== "")
    : [];
  if (items.length === 0) {
    return (
      `  REPORTING DEFECT (loom#1424): validator ${validatorId} returned ` +
      `pass:false while naming ZERO offending items` +
      (Array.isArray(failures)
        ? ` (failures[] had ${failures.length} entr${failures.length === 1 ? "y" : "ies"}, ` +
          `none of them non-blank)`
        : ` (failures was not an array: ${typeof failures})`) +
      `.\n` +
      `  A failure that names no cause cannot be acted on and cannot be told ` +
      `apart from a reporting bug (rules/instrument-discipline.md).\n` +
      `  The emit is BLOCKED rather than passed: an empty finding list is not ` +
      `evidence of a clean tree. Fix the validator so every pass:false return ` +
      `is preceded by a failures.push() naming the offender, then re-run.`
    );
  }
  return items.map((l) => "  " + l).join("\n");
}

// Async since loom#1424 — half B lazily imports sync-tier-aware.mjs (see the
// import note at the half-B boundary below). Half A is unchanged and still
// returns before any await, so a consumer-class run does no extra work.
//
// ── F94 (ledger 2026-08-19) — `haltHalfB` ───────────────────────────────────
// Half B parses the manifest with a regex `tiers:` slice, exactly as V15 does.
// On a manifest that did not clear V16 that parse yields a verdict about the
// PARSER, not about the distribution plan: a malformed manifest has no
// recognisable `tiers:` block, so half B reports "the schema is not declared in
// any tier" — a distribution defect that is not there. main() therefore passes
// the precondition reason down rather than calling and discarding: half A (the
// class-independent, consumer-protecting half) still RUNS, and half B reports a
// terminal SKIP naming why. Refusing to answer is the honest disposition; the
// misleading answer is worse than the missing one.
export async function validateRosterSchemaCoupling({ haltHalfB = null } = {}) {
  const hooksRoot = path.join(REPO, ".claude", "hooks");
  const schemaPath = path.join(REPO, ".claude", "operators.roster.schema.json");

  const validatorJs = path.join(hooksRoot, "lib", "roster-schema-validate.js");
  const guardJs = path.join(hooksRoot, "genesis-anchor-guard.js");

  const failures = [];

  // EVERY `pass` below is DERIVED from `failures`, never asserted as a literal.
  // The three early returns in this function each ship `failures` alongside `pass`, so a
  // literal `true` states a verdict the accompanying evidence could contradict. It is
  // not contradictable TODAY — half A's only failure path returns `pass: false` above —
  // but that invariant is held by the PLACEMENT of a return statement, not by anything
  // the construction enforces: the first half-A check that pushes a failure and falls
  // through instead of returning would make V17 report PASS with failures attached, and
  // emission would proceed past it. Deriving costs nothing and removes the standing trap.
  const verdict = (extra = {}) => ({ pass: failures.length === 0, ...extra, failures });

  const hookPresent =
    fs.existsSync(validatorJs) || fs.existsSync(guardJs);
  if (!hookPresent) {
    // No coupling to enforce — the substrate hasn't landed in this checkout.
    return verdict();
  }

  if (!fs.existsSync(schemaPath)) {
    failures.push(
      `operators.roster.schema.json missing at .claude/ — required by ` +
        `roster-schema-validate.js:56-61 (runtime hardcoded path). ` +
        `Restore the schema file before declaring substrate complete.`,
    );
    return { pass: false, failures };
  }
  // ── END HALF A (class-independent). Everything below is HALF B. ──
  // On a manifest-forbidden class half A has now run to completion — which is
  // strictly MORE consumer protection than before loom#1386, when the read three
  // lines down threw ENOENT and the whole validator (half A included) never
  // produced a verdict.
  // CLASS gate first, then the F94 PRECONDITION gate. Order is deliberate: on a
  // consumer half B is not asserted whatever V16 said, so the class reason is the
  // TRUE reason. Reporting a precondition there would imply half B would have run
  // had V16 passed, which is false.
  if (!isManifestOwnerClass(REPO)) {
    const { type } = readRepoClass(REPO);
    return verdict({
      skipped_half_b: true,
      skipReason:
        `class:${type} → half A (hook ⇔ schema file coupling) RAN and passed; ` +
        `half B (manifest tier-membership + the F70 sync-tier-aware per-target ` +
        `dry-run) is a DISTRIBUTION assertion — tier membership is declared in ` +
        `loom's manifest and a "${type}" repo has no sync targets — so it is not ` +
        `asserted here.`,
    });
  }

  if (haltHalfB) {
    // A half-B SKIP is not a half-A verdict. `pass` therefore reports what half A
    // actually found, so a half-A failure can never be masked by half B being skipped.
    return verdict({ skipped_half_b: true, skipReason: haltHalfB });
  }

  // Manifest tier-membership check. The schema MUST appear as a
  // bare-name entry in the `tiers:` block — NOT in `use_exclude:`
  // (loom-only) or `use_obsoleted:` (purged on next sync). Per
  // reviewer M1 + cc-architect HIGH-2 (journal 0162): a whole-file
  // regex sweep would false-PASS if a future operator moved the
  // entry to use_exclude/obsoleted, restoring the exact failure mode
  // V17 exists to block. Mirroring V15's sliceBlock pattern keeps
  // the validator's mechanical sweep scope-matched to its prose
  // claim ("the schema MUST appear in a TIER").
  // Owner class (gated above): absence is a DEFECT and readManifestSource throws
  // LOUD rather than degrading half B into a vacuous pass.
  const manifestText = readManifestSource(REPO);
  // Slice the `tiers:` block: from the line AFTER `^tiers:` to the
  // next column-0 key. Same shape as validateTierCompleteness above
  // (lines 939-948); duplicated rather than factored to keep V17
  // self-contained (the factoring belongs in a separate refactor
  // codify, not this same-shard remediation wave).
  const tiersStart = manifestText.search(/^tiers:\s*$/m);
  if (tiersStart === -1) {
    failures.push(
      `sync-manifest.yaml has no \`tiers:\` block — V17 cannot verify ` +
        `schema tier-membership. Restore the tiers block before declaring ` +
        `substrate complete.`,
    );
    return { pass: false, failures };
  }
  const tiersBodyStart = manifestText.indexOf("\n", tiersStart);
  const afterTiers = manifestText.slice(tiersBodyStart + 1);
  const nextKeyRel = afterTiers.search(/^[A-Za-z_][\w-]*:\s*$/m);
  const tiersBlock =
    nextKeyRel === -1 ? afterTiers : afterTiers.slice(0, nextKeyRel);
  const tieredRe = /^\s*-\s*operators\.roster\.schema\.json\s*$/m;
  if (!tieredRe.test(tiersBlock)) {
    failures.push(
      `operators.roster.schema.json EXISTS at .claude/ but is NOT declared ` +
        `in any sync-manifest.yaml \`tiers:\` entry. The substrate's hook ` +
        `consumers (roster-schema-validate.js, genesis-anchor-guard.js) ` +
        `ship without their runtime data; consumer repos receiving the ` +
        `substrate via /sync will fail-close every commit ("operators ` +
        `roster missing; trust root not established"). Add ` +
        `\`- operators.roster.schema.json\` to a tier (recommended: kailash, ` +
        `alongside commands/whoami.md). Origin: F67 / GH #379 / journal 0161. ` +
        `Note: an entry in \`use_exclude:\` or \`use_obsoleted:\` does NOT ` +
        `satisfy this check — the schema must be IN a tier so /sync ships ` +
        `it (journal 0162 scope-fix).`,
    );
    return { pass: false, failures };
  }

  // F70: end-to-end strengthening — invoke sync-tier-aware.mjs --dry-run
  // --json per declared sync target and assert
  // operators.roster.schema.json appears in the planned `copied` list.
  //
  // The text-declaration check above (tieredRe) verifies the schema is
  // SYNTACTICALLY in the manifest. F70 verifies it is SEMANTICALLY
  // distributed — closes the grammar-evolution drift class where a
  // future manifest addition (per-entry `disabled: true` marker, a new
  // `use_exclude_v2:` block) silently drops the schema from every
  // target's plan while leaving the tier-declaration intact. The text
  // check would pass; only the end-to-end dry-run sees the drift.
  //
  // Per journal/0162 § F70 acceptance.
  //
  // ── loom#1424: WHY THIS IS AN IN-PROCESS CALL AND NOT A SUBPROCESS ──────────
  // This sweep used to spawn `sync-tier-aware.mjs --target <t> --dry-run --json`
  // once per target under `timeout: 20000`. That made V17's VERDICT a function
  // of MACHINE LOAD rather than of the tree, and it is what made the
  // `COC Artifact Eval (structural)` required check flaky.
  //
  // MEASURED, not inferred (this worktree, 16 cores):
  //   - the 8-lane fan-out in emit-shape.test.mjs runs 8 emitters concurrently,
  //     so 8 of these probes are in flight at once;
  //   - at load-average 275 the slowest probe took   5702 ms (3.51x headroom);
  //   - with 48 CPU burners added it took           10159 ms (1.97x headroom).
  //     Probe duration is a MONOTONE function of contention — the budget is
  //     reachable, and a CI runner is a noisy-neighbour box by construction.
  //   - driving the budget below the observed duration reproduced the reported
  //     signature EXACTLY on an unchanged tree: `[validator-17]
  //     roster-schema-coupling: FAIL` + exit 1, with the ETIMEDOUT rendered as
  //     though the TARGET were misdeclared ("if the target is intentionally
  //     retired, remove it from declaredTargets") — a load artefact wearing the
  //     grammar of a distribution defect.
  //   - the issue's decisive signature (V17 PASS at one log line, FAIL at a
  //     later one in the SAME job) is exactly what a per-process wall-clock
  //     budget produces across lanes that meet different instantaneous load.
  //
  // The fix is not a longer timeout and not a retry — both leave the verdict
  // load-dependent. It is to delete the wall clock from the measurement: call
  // the SAME plan builder `sync-tier-aware.mjs::main()` calls, in-process.
  // There is then no budget for contention to breach, and the verdict is a pure
  // function of the tree.
  //
  // NOTHING V17 ASSERTS IS GIVEN UP. V17 only ever read `plan.files[]` and
  // `plan.tier_subscriptions[]`, and BOTH are produced by `buildPlan` alone
  // (keys of the object sync-tier-aware.mjs::buildPlan returns) — never by
  // `executePlan`, whose `results`
  // V17 never touched. Byte-equality of the two paths for all four targets is
  // MEASURED and pinned by a regression test, so the end-to-end claim survives:
  // emit-shape.test.mjs § "loom#1424 — V17 half B's in-process plan is the
  // SAME plan the sync-tier-aware BINARY emits". That pin pays the subprocess
  // ONCE, serially, instead of 32 times across 8 concurrent lanes.
  //
  // The `--out` flag is gone with the subprocess. It existed only to bypass the
  // loom-links resolver; `buildPlan` never resolves a target's on-disk location,
  // so the validator stays operator-portable for the same reason, one layer up.
  // loom#1501 (L4) — the module-level EMIT_LANGS, not a second inline literal.
  // V17's declared targets and `--lang`'s accepted lanes are the SAME axis; two
  // copies is the shape where retiring a lane updates one and leaves the other.
  const declaredTargets = EMIT_LANGS;
  const SCHEMA_PLAN_PATH = ".claude/operators.roster.schema.json";
  // LAZY import, deliberately — the loom#1538 precedent above (loadExtractPolicies)
  // is the same hazard: emit.mjs is FORCE-SHIPPED to consumers
  // (its ".claude/bin/emit.mjs" entry in sync-tier-aware.mjs::ALWAYS_INCLUDE) but
  // sync-tier-aware.mjs is NOT, so a
  // top-level `import` would make emit.mjs fail at MODULE LOAD with
  // ERR_MODULE_NOT_FOUND on every consumer — unusable as a gate. Half B is already
  // gated on the manifest-owner class above, so the import is only ever reached
  // where the module exists.
  let buildSyncPlan;
  let syncManifest;
  try {
    const mod = await import(
      pathToFileURL(path.join(REPO, ".claude", "bin", "sync-tier-aware.mjs")).href
    );
    buildSyncPlan = mod.buildPlan;
    // Loaded ONCE for the whole sweep: main() reads the manifest once per
    // invocation too, so this is the same read, not a cheaper approximation.
    syncManifest = mod.loadManifest();
  } catch (err) {
    failures.push(
      `V17 (F70 end-to-end): could not load .claude/bin/sync-tier-aware.mjs to build the ` +
        `distribution plan: ${err && err.message ? err.message.slice(0, 200) : String(err).slice(0, 200)}. ` +
        `Half B runs only at the manifest-owner class, where that module MUST be present.`,
    );
    return { pass: false, failures };
  }
  for (const target of declaredTargets) {
    let plan;
    try {
      // The EXACT call sync-tier-aware.mjs::main() makes, with the defaults
      // parseArgs() hands it for a bare `--target <t> --dry-run --json` run:
      // template=null, mode="use" (the defaults sync-tier-aware.mjs::parseArgs sets,
      // passed through by the buildPlan call in sync-tier-aware.mjs::main).
      plan = buildSyncPlan(syncManifest, target, null, "use");
    } catch (err) {
      failures.push(
        `V17 (F70 end-to-end): building the sync-tier-aware distribution plan for ` +
          `--target ${target} THREW: ${err && err.message ? err.message.slice(0, 200) : String(err).slice(0, 200)}. ` +
          `The plan MUST build for every declared target so V17 can verify the schema ` +
          `actually distributes; if the target is intentionally retired, remove it from this validator's ` +
          `declaredTargets list AND remove repos.${target} from sync-manifest.yaml in the same commit.`,
      );
      continue;
    }
    const files = plan && Array.isArray(plan.files) ? plan.files : [];
    // F70 scope: only fail on targets that subscribe to the `kailash` tier
    // (where the schema lives per F67's tier choice in journal/0161).
    // Targets not subscribed to kailash are out of #379's scope — they
    // don't receive the substrate hooks' kailash-tier siblings either.
    // F70's regression-lock binds the schema's distribution to the
    // tier-subscriptions that ARE supposed to ship it; widening the
    // scope to every target would re-open a different architectural
    // question (do base/prism need the substrate?) that F67 explicitly
    // scoped out.
    const subs =
      plan && Array.isArray(plan.tier_subscriptions) ? plan.tier_subscriptions : [];
    if (!subs.includes("kailash")) {
      // Target does not subscribe to kailash tier — out of F70 scope.
      // Documented as advisory note so the operator sees the skip.
      continue;
    }
    const schemaEntry = files.find((f) => f && f.path === SCHEMA_PLAN_PATH);
    if (!schemaEntry) {
      failures.push(
        `V17 (F70 end-to-end): the sync-tier-aware distribution plan for --target ${target} ` +
          `does NOT include ${SCHEMA_PLAN_PATH} at all. ` +
          `The tier declaration in sync-manifest.yaml passed the text check but the resolved ` +
          `distribution plan silently dropped the schema. Inspect the manifest's tier_subscriptions ` +
          `for target=${target}, any future per-entry markers (e.g. \`disabled: true\`), or recent ` +
          `changes to sync-tier-aware.mjs's filtering logic.`,
      );
      continue;
    }
    if (schemaEntry.action !== "copy") {
      failures.push(
        `V17 (F70 end-to-end): the sync-tier-aware distribution plan for --target ${target} ` +
          `includes ${SCHEMA_PLAN_PATH} but action="${schemaEntry.action}" (reason="${schemaEntry.reason}"). ` +
          `Expected action="copy" so the schema actually ships with the substrate. The substrate's ` +
          `hook consumers (roster-schema-validate.js, genesis-anchor-guard.js) ship without their ` +
          `runtime data otherwise — every commit in target=${target} consumer repos will fail-close.`,
      );
    }
  }

  return { pass: failures.length === 0, failures };
}

// ────────────────────────────────────────────────────────────────
// POLICIES writeback to .codex-mcp-guard/
// ────────────────────────────────────────────────────────────────
// Runs extract-policies on .claude/hooks/. Writes TWO files (CDX-5 fix,
// Shard B 2026-05-10):
//
//   policies.json                — RUNTIME shape consumed by server.js
//                                  ({version, source_dir, policies}).
//                                  loadPolicies() in server.js (line 71-89)
//                                  reads `raw.policies[t]` for each wrapped
//                                  tool; this writer must match that shape.
//   extract-policies.dump.json   — AUDIT shape for V13 introspection
//                                  ({predicates, shape_summary,
//                                   orchestrators_filtered, policies_predicates}).
//                                  Sidecar; not loaded at runtime.
//
// Pre-Shard-B: this function wrote the audit shape to filename
// `policies.json`, while the on-disk `.claude/codex-mcp-guard/policies.json`
// (manually populated) carried the runtime shape. Same filename, two
// schemas — CDX-5 finding from the 2026-05-10 audit. If a /sync ever
// shipped this function's output to the codex-mcp-guard runtime
// directory, server.js would silently see no policies and fail-closed-
// refuse-to-start.
//
// Orchestrator filter per spec v6 §4.4 "Why Shape B is load-bearing":
// Shape A orchestrator functions (`main`, top-level entry points) are
// filtered as non-policy. Policies must be Shape B/C/D — Shape A's
// `main` is the script entry, not a guard predicate.
// Async since loom#1538 — see loadExtractPolicies. Unlike Validator 13 this
// one does NOT degrade to a skip: writing the policy table is the caller's
// explicit request, so an absent codex surface throws the named error.
// SOURCE-ROOT PARAMETER (loom#1870). The scan root was hardcoded to loom's own
// `REPO` — correct for loom's dogfood emit, and WRONG for the only other caller
// that matters: a Gate-2 delivery, which needs the policy table for the TARGET's
// hooks. A target does NOT receive loom's hook set (measured on the py USE lane:
// 166 hooks copied, 13 withheld `loom_only`), so loom's table describes guards the
// target does not hold. `opts.sourceRoot` moves the scan without forking the shape
// composition below — ONE producer of the runtime/audit JSON, two readers (loom's
// own emit, and the per-target guard emit in emit-cli-artifacts.mjs). A second
// composer would be the split-contract shape `security.md` § Enforcement-Surface
// Parity names. Defaults preserve the pre-existing loom-scoped behaviour exactly.
//
// `settingsPath` is passed EXPLICITLY rather than left to the extractor's own
// `path.resolve(dir, "..", "settings.json")` default. Same value for the default
// case (behaviour-preserving), but load-bearing for a target root: the matcher map
// is built from settings.json, and when it is absent `extractPolicies` returns an
// EMPTY table — measured, `{"shell":[],"unified_exec":[],"apply_patch":[]}`, 47
// bytes — which is a silent fail-OPEN policy set. The caller asserts presence.
export async function wireMcpPolicies(outDir, opts = {}) {
  const sourceRoot = opts.sourceRoot ? path.resolve(opts.sourceRoot) : REPO;
  const hooksDir = opts.hooksDir
    ? path.resolve(opts.hooksDir)
    : path.join(sourceRoot, ".claude", "hooks");
  const settingsPath = opts.settingsPath
    ? path.resolve(opts.settingsPath)
    : path.resolve(hooksDir, "..", "settings.json");
  const extractPolicies = await loadExtractPolicies();
  const extracted = extractPolicies(hooksDir, { settingsPath });

  const filteredPredicates = extracted.predicates.filter((p) => {
    if (p.shape === "A" && p.id === "main") return false;
    return true;
  });

  // Runtime shape — what server.js::loadPolicies consumes.
  const runtimeJson = {
    version: 1,
    source_dir: path.relative(sourceRoot, hooksDir),
    policies: extracted.policies,
  };

  // Audit shape — V13 introspection, /cli-audit Phase 2 input.
  const auditJson = {
    version: 1,
    generated_at: new Date().toISOString(),
    source_dir: path.relative(sourceRoot, hooksDir),
    shape_summary: {
      A: filteredPredicates.filter((p) => p.shape === "A").length,
      B: filteredPredicates.filter((p) => p.shape === "B").length,
      C: filteredPredicates.filter((p) => p.shape === "C").length,
      D: filteredPredicates.filter((p) => p.shape === "D").length,
    },
    orchestrators_filtered: extracted.predicates.length - filteredPredicates.length,
    predicates: filteredPredicates,
    policies_predicates: extracted.policies_predicates,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const runtimePath = path.join(outDir, "policies.json");
  const auditPath = path.join(outDir, "extract-policies.dump.json");
  writeTextArtifactSync(runtimePath, JSON.stringify(runtimeJson, null, 2) + "\n");
  writeTextArtifactSync(auditPath, JSON.stringify(auditJson, null, 2) + "\n");
  return runtimePath;
}

// ────────────────────────────────────────────────────────────────
// CLI entry
// ────────────────────────────────────────────────────────────────

// Single source of truth for the accepted-flag list. Read by formatArgRefusal,
// main()'s no-CLI usage error, and main()'s --help path — a future flag
// addition touches one place, not three. The axis values are DERIVED from
// EMIT_CLIS / EMIT_LANGS rather than typed: the literal this replaced read
// `[--lang py|rs]` while `base` was already a declared lane.
const EMIT_USAGE =
  `usage: emit.mjs [--cli ${EMIT_CLIS.join("|")}] [--all] [--lang ${EMIT_LANGS.join("|")}] ` +
  "[--out <dir>] [--dry-run] [--no-strict-headroom] [-v]\n" +
  "       emit.mjs -h | --help\n" +
  "  one of --cli or --all is required; --cli / --lang / --out take the NEXT word " +
  "or a fused --flag=value";

// The value-taking flags. ONE list read by parseArgs' separate-word branch, its
// fused `--flag=value` branch, and its repeat check, so the three cannot disagree.
const VALUE_FLAGS = Object.freeze(["--cli", "--out", "--lang"]);
// Flags that take NO value. Read by describeUnrecognizedArg only, so `--all=1`
// is refused with "takes no value" rather than the generic hint.
const BOOLEAN_FLAGS = Object.freeze([
  "--all",
  "--dry-run",
  "-v",
  "--verbose",
  "--no-strict-headroom",
  "-h",
  "--help",
]);

// loom#1501 (L4) — the axes are DECLARED in `./lib/emit-axes.mjs` and imported
// at the top of this file. `emit-shape.test.mjs` walks the declared (cli × lang)
// matrix and V17's target loop consumes the same list, so the emission axes and
// the distribution axes cannot drift apart.
//
// ONE BOUND, stated rather than implied. A lane with no overlay directory
// composes to the same bytes as a no-`--lang` run. That is a property of the
// DECLARATION (a lane whose overrides are all inherited), not a defect of the
// check below — but it is NOT left silent either: `noteAbsentOverlay` prints the
// fact, because a byte count an operator cannot attribute to a lane is the same
// non-discriminating reading this whole check exists to prevent. See there for
// why the disposition is loud-succeed rather than fail-closed. NO declared lane
// is in that state today: `rb` was the only one, and it was removed as a lane on
// 2026-08-11 (Ruby ships as a binding of the rs all-bindings template).

/**
 * loom#1501 (L4). `--lang <declared-lane-with-no-overlay-dir>` is LEGAL and
 * MUST succeed — rejecting it is precisely the F1 defect (a declared lane made
 * invalid by a disk probe). But succeeding SILENTLY is its own instrument
 * failure, one layer in. Measured, on the codex CLI:
 *
 *   emit.mjs --cli codex --lang <no-overlay-lane> --dry-run  →  "WARN: 11 rules, 53168B"
 *   emit.mjs --cli codex --lang py             --dry-run  →  "[codex py] WARN: 11 rules, 53168B"
 *
 * Byte-identical. Nothing in that line lets the operator distinguish "this lane
 * genuinely has no lane-specific overrides, so this IS its composition" from
 * "my `--lang` never took effect and I am reading some other lane" — the reading
 * `instrument-discipline.md` MUST-1 forbids citing, and the exact shape that made
 * the empty-`$L` trap costly (a plausible number for the wrong lane).
 *
 * Hence: LOUD-SUCCEED. Failing closed is wrong (it re-creates F1); succeeding
 * silently is wrong (a number the operator cannot attribute); naming the absence
 * makes the number readable. This is `security.md` § Secure-Default's second
 * branch — when fail-closed is not the correct default, emit a loud notice
 * naming what is not in effect.
 *
 * Written to stderr, so it cannot contaminate a stdout-parsing consumer
 * (`validate-proximity-band.mjs` scrapes emit's stdout for lane rows).
 */
export function noteAbsentOverlay(lang) {
  if (!lang) return false; // a no-`--lang` run claims no lane; nothing to attribute
  const overlayDir = path.join(REPO, ".claude", "variants", lang);
  if (fs.existsSync(overlayDir)) return false;
  process.stderr.write(
    `emit.mjs: NOTICE — lane ${JSON.stringify(lang)} is DECLARED but has no ` +
      `overlay directory (${path.relative(REPO, overlayDir)}).\n` +
      `  This is legal: a lane whose overrides are all inherited composes ` +
      `identically to a run with no --lang flag.\n` +
      `  It is reported because the byte count below is therefore NOT ` +
      `lane-specific — do not cite it as evidence about ${JSON.stringify(lang)} ` +
      `in particular.\n`,
  );
  return true;
}

export function parseArgs(argv) {
  const args = {
    cli: null,
    out: null,
    lang: null,
    all: false,
    dryRun: false,
    verbose: false,
    // v6.2 cycle-2 — strict mode is opt-out (default true). Mirrors the
    // v2.13.0 --strict-budget rollout: shipped opt-in in cycle-1, flipped
    // to opt-out in cycle-2 after one /sync observation cycle confirmed
    // zero false-positive blocks (PR #218 → v2.31.0 /sync, 2026-05-15).
    // Any headroom_floor_violations[] entry triggers exit code 1 so
    // /sync halts at emission rather than shipping the breach to
    // downstream USE templates.
    strictHeadroom: true,
    // issue #235 — tokens parseArgs did not recognize, verbatim. A typo'd
    // --no-strict-headroom lands here, as does a whole `--lang base` arriving as
    // ONE argv element. main() REFUSES the run (exit 2) when this is non-empty;
    // see the "ROOT CAUSE of the old warn-and-continue" note at the end of
    // parseArgs for why it no longer warns.
    unknownArgs: [],
    // `-h` / `--help`. Honoured by main() ONLY as the sole argument; combined
    // with anything else it is a flagDefect (see the end of parseArgs).
    help: false,
    // loom#1501 (L4). `*Seen` is tracked separately from the value because
    // `argv[++i]` is `undefined` when the flag is the LAST token, which is
    // indistinguishable from "the flag was never passed" if you only read the
    // value. Declared HERE rather than assigned only on the matching branch, so
    // the returned key set does not vary by input — a shape a caller can rely on.
    cliSeen: false,
    outSeen: false,
    langSeen: false,
    // Populated by the shared value-flag check below.
    flagDefects: [],
  };
  // How many times each value flag appeared, and which arrived fused
  // (`--lang=rs`). Locals, not `args` keys, so the returned key set stays fixed.
  const occurrences = { "--cli": 0, "--out": 0, "--lang": 0 };
  const fused = new Set();
  const takeValue = (flag, value, isFused) => {
    occurrences[flag] += 1;
    if (isFused) fused.add(flag);
    if (flag === "--cli") {
      args.cliSeen = true;
      args.cli = value;
    } else if (flag === "--out") {
      args.outSeen = true;
      args.out = value;
    } else {
      args.langSeen = true;
      args.lang = value;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `--flag=value` splits at the FIRST `=`, so `--out=/tmp/a=b` keeps its path.
    const eq = typeof a === "string" ? a.indexOf("=") : -1;
    const fusedHead = eq > 0 ? a.slice(0, eq) : null;
    if (VALUE_FLAGS.includes(a)) takeValue(a, argv[++i], false);
    // The fused form is ACCEPTED, and routed through the SAME value checks
    // as the separate-word form below. It is also the robust scripting form:
    // `--lang="$L"` with $L empty arrives as `--lang=`, an EMPTY-value refusal,
    // where `--lang $L` under bash drops the word and swallows the next flag.
    else if (fusedHead && VALUE_FLAGS.includes(fusedHead)) {
      takeValue(fusedHead, a.slice(eq + 1), true);
    }
    else if (a === "--all") args.all = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "-v" || a === "--verbose") args.verbose = true;
    // v6.2 cycle-2 — explicit opt-out for test-harness intentional-breach
    // exercises. Production /sync invocations MUST NOT pass this flag;
    // dropping strict mode in a /sync command body is regression class (a)
    // per sync-completeness.md Trust Posture Wiring § Rule 2 headroom-floor.
    else if (a === "--no-strict-headroom") args.strictHeadroom = false;
    else if (a === "-h" || a === "--help") args.help = true;
    // issue #235 — anything else is an unrecognized token. Pre-v6.2 this
    // branch did not exist: a typo'd --no-strict-headroon was silently
    // swallowed, strict mode stayed ON, and the operator burned a round
    // trip diagnosing why their explicit opt-out never fired.
    else args.unknownArgs.push(a);
  }
  // ── loom#1501 (L4) — EVERY value-taking flag MUST receive a value ────────
  //
  // THE TRAP THIS CLOSES, reproduced before it was written. With an unquoted
  // shell variable that happens to be EMPTY, the shell drops the word entirely:
  //
  //     emit.mjs --cli codex --lang $L --all   →   ["--cli","codex","--lang","--all"]
  //
  // so `--lang` swallowed `--all`, `args.all` never got set, and the run
  // emitted the BASE lane while reporting a perfectly plausible byte count
  // (53168B / 13.46%). A typo does the same thing more quietly: `--lang rss`
  // emits base's exact numbers at exit 0. Both produce a VALID MEASUREMENT OF
  // THE WRONG LANE — the shape instrument-discipline.md MUST-1 forbids citing,
  // because nothing the operator reads off the run distinguishes it from the
  // lane they asked for. It bit twice in one cycle, the second time in a lane
  // that had itself documented the trap.
  //
  // It is fixed HERE and not in a Bash hook, deliberately: a PreToolUse hook
  // sees `payload.tool_input.command` PRE-EXPANSION, so the very same command
  // string is correct when `$L` is set and wrong when it is empty. A hook
  // therefore cannot discriminate, and hook-output-discipline.md MUST-3
  // requires it to SKIP shell-variable operands rather than guess. The signal
  // exists only after the shell has expanded — i.e. right here, in argv.
  //
  // The valid set is the DECLARATION (`EMIT_LANGS`), not `.claude/variants/` on
  // disk. An earlier cut of this check derived it from disk and this comment
  // argued that made it drift-proof; the opposite was true, and it was wrong in
  // both directions at once — see EMIT_LANGS for the measured cases. `--lang
  // codex` (a CLI axis passed on the language axis) is now rejected too, which
  // that draft explicitly recorded as an accepted miss.
  //
  // Recorded on `args` rather than exiting in-place, mirroring `unknownArgs`
  // above: parseArgs is exported and exercised directly by the harness, so the
  // process-level disposition belongs to main().
  // ONE shared check across all three, per security.md § Enforcement-Surface
  // Parity: `--cli` and `--out` carry the IDENTICAL defect and were left unfixed
  // in the first cut of this change. `--cli $C --all` with $C empty yields
  // `cli === "--all"` and `all` never set; `--out $O --dry-run` writes to a
  // directory literally named `--dry-run` with dryRun FALSE. Three copies of
  // this check is the shape that leaves one of them a version behind.
  const checkValueFlag = (flag, seen, value, extra) => {
    if (!seen) return;
    if (value === undefined || value === null) {
      args.flagDefects.push(
        `${flag} got no value — it was the last token on the command line`,
      );
      return;
    }
    if (value === "") {
      // Distinct from the case above: `--lang ""` DID receive a token, it is just
      // empty. Reporting it as "last token on the command line" sends the reader
      // to look for a missing operand that is right there in quotes.
      args.flagDefects.push(`${flag} got an EMPTY value`);
      return;
    }
    const v = String(value);
    if (v.startsWith("-")) {
      // The swallowed-next-flag explanation is true only of the separate-word
      // form; a fused `--lang=--all` consumed nothing, so it gets the bare fact.
      args.flagDefects.push(
        fused.has(flag)
          ? `${flag} got ${JSON.stringify(v)}, which is a FLAG, not a value`
          : `${flag} got ${JSON.stringify(v)}, which is a FLAG, not a value — an ` +
              `unquoted empty shell variable dropped the value and \`${flag}\` ate the next flag`,
      );
      return;
    }
    const msg = extra ? extra(v) : null;
    if (msg) args.flagDefects.push(`${flag} got ${msg}`);
  };

  checkValueFlag("--cli", args.cliSeen, args.cli, (v) =>
    EMIT_CLIS.includes(v)
      ? null
      : `${JSON.stringify(v)}, which is not a known CLI (expected ${EMIT_CLIS.join(" or ")})`,
  );
  checkValueFlag("--lang", args.langSeen, args.lang, (v) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) {
      return `${JSON.stringify(v)}, which is not a well-formed lane name`;
    }
    // Against the DECLARATION, never against `.claude/variants/` on disk — see
    // EMIT_LANGS. A disk probe rejects a declared lane that has no overlay dir
    // and accepts `codex` (an overlay dir that is not a lang lane); an `existsSync`
    // disk probe additionally accepts any FILE, so `--lang README.md` passed and
    // emitted base output byte-identical to a no-lang run — exactly the silent
    // lane-shift this check's own error string claims to prevent.
    if (!EMIT_LANGS.includes(v)) {
      return (
        `${JSON.stringify(v)}, which is not a declared lane ` +
        `(expected ${EMIT_LANGS.join(", ")}) — the run would silently emit the BASE lane`
      );
    }
    return null;
  });
  // `--out` takes an arbitrary path, so only the two shared arms apply.
  checkValueFlag("--out", args.outSeen, args.out, null);

  // A repeated value flag is the same wrong-lane shape: `--lang rs --lang
  // py` silently measured `py`. Refused rather than last-wins, even when the
  // values agree, because agreement is a coincidence the parser cannot vouch for.
  for (const flag of VALUE_FLAGS) {
    if (occurrences[flag] > 1) {
      args.flagDefects.push(
        `${flag} was given ${occurrences[flag]} times — only the LAST value would ` +
          `take effect and the others would be silently ignored; pass it once`,
      );
    }
  }

  // `--help` combined with anything else is REFUSED, not honoured. Measured
  // before this change: `--all --dry-run --help` ran the whole emission at exit 0.
  // Honouring help there instead would print usage and ALSO exit 0 having emitted
  // nothing — a green a caller reading only the exit code cannot tell from a pass.
  if (args.help && argv.length > 1) {
    args.flagDefects.push(
      `--help/-h was combined with other arguments — --help emits nothing, so an ` +
        `exit 0 here would read as a passing emission; run \`emit.mjs --help\` on its own`,
    );
  }

  // ROOT CAUSE of the old warn-and-continue (replaced by a refusal; provenance
  // journal/0607). parseArgs recorded
  // `unknownArgs` and wrote a WARNING, but main() gated its exit on
  // `flagDefects` ALONE, so an unrecognized token never stopped the run. That
  // disposition came from issue #235, whose one motivating token (a typo'd
  // --no-strict-headroom) happens to be fail-SAFE: strict mode stays ON. It does
  // not generalize. Measured before this change, each at exit 0:
  //   ["--cli","codex","--lang base","--dry-run"]  → base lane emitted
  //   ["--cli","codex","--lang=rs","--dry-run"]    → base lane emitted
  //   ["--all","--dry-run","--help"]               → full emission
  // — a valid measurement of the WRONG lane, the reading
  // instrument-discipline.md MUST-1 forbids citing. The token a parser does not
  // recognize is by definition one whose intent it cannot know, so the only
  // disposition that is safe for EVERY such token is to refuse the run.
  //
  // parseArgs stays side-effect free; formatArgRefusal renders the refusal and
  // main() owns the exit.
  return args;
}

// Makes an operator-controlled string printable without adding quotes: control
// and ANSI-escape characters come back \u-escaped (argv may carry a raw ESC).
const printable = (s) => JSON.stringify(String(s)).slice(1, -1);

/**
 * The per-token diagnosis for an argument parseArgs did not recognize.
 * Pure; the returned hint never echoes the token raw.
 */
export function describeUnrecognizedArg(token) {
  const t = String(token);
  if (t.startsWith("-") && /\s/.test(t)) {
    const parts = t.trim().split(/\s+/);
    if (parts.length === 2 && VALUE_FLAGS.includes(parts[0])) {
      const [flag, value] = parts.map(printable);
      return (
        `a flag and its value arrived as ONE argument (a multi-word shell variable ` +
        `passed quoted, or unquoted under zsh, which does not word-split) — pass ` +
        `them as separate words (${flag} ${value}) or fused (${flag}=${value})`
      );
    }
    return "ONE argument containing whitespace — flags and values must be separate words";
  }
  const eq = t.indexOf("=");
  if (eq > 0 && BOOLEAN_FLAGS.includes(t.slice(0, eq))) {
    return `${t.slice(0, eq)} takes no value`;
  }
  // issue #235 kept coherent: the typo'd opt-out is now REFUSED, not ignored.
  if (/^--?(no-?)?strict/i.test(t)) {
    return (
      "strict headroom is ON by default and this run was REFUSED, so the intended " +
      "opt-out did NOT apply — the only accepted spelling is --no-strict-headroom " +
      "(the legacy --strict-headroom opt-in was removed)"
    );
  }
  if (!t.startsWith("-")) return "emit.mjs takes no positional arguments";
  return "not a recognized flag";
}

/**
 * The full refusal text for a parsed argv, or `null` when there is
 * nothing to refuse. Every token is JSON.stringify'd before it is echoed:
 * argv is operator-controlled and may carry control / ANSI-escape characters,
 * and quoting also makes empty and whitespace-only tokens visible.
 */
export function formatArgRefusal(args) {
  const lines = [
    ...args.unknownArgs.map(
      (t) => `unrecognized argument ${JSON.stringify(t)}: ${describeUnrecognizedArg(t)}`,
    ),
    ...args.flagDefects,
  ];
  if (lines.length === 0) return null;
  // The quoting advice fixes ONLY the swallowed-flag arms; for a whitespace-fused
  // token it is the opposite of the fix, so it is printed only when it applies.
  const swallowed = args.flagDefects.some((d) =>
    /FLAG, not a value — an unquoted|got no value/.test(d),
  );
  return (
    `emit.mjs: ERROR — refusing to run: ${lines.length} rejected argument(s); ` +
    `nothing was emitted or measured:\n` +
    lines.map((l) => `    ${l}\n`).join("") +
    `  Lanes are ${EMIT_LANGS.join(" / ")}; CLIs are ${EMIT_CLIS.join(" / ")}.\n` +
    (swallowed
      ? `  If you are scripting this, QUOTE the variable (--lang "$MY_LANE") — an ` +
        `unquoted empty one is DROPPED by the shell, so the flag swallows the next ` +
        `flag and the run silently shifts to another lane.\n`
      : "") +
    `  ${EMIT_USAGE}\n`
  );
}

// Async since loom#1538 — Validator 13's extractor is a lazy `await import`.
async function main() {
  const args = parseArgs(process.argv.slice(2));

  // loom#1501 (L4), widened to unrecognized tokens — fail LOUD and EARLY on ANY
  // rejected argument: a
  // value flag with no/bad value, a repeated value flag, --help combined with
  // other arguments, or an unrecognized token. Exit 2 (usage error), before any
  // validator or emission, so the operator can never read one lane's byte count
  // as another's. Rationale in full at the checks in parseArgs.
  const refusal = formatArgRefusal(args);
  if (refusal) {
    process.stderr.write(refusal);
    process.exit(2);
  }

  // A lone -h / --help: usage to STDOUT, exit 0 — the convention the sibling
  // validate-emit.mjs::main and validate-proximity-band.mjs::main follow.
  if (args.help) {
    process.stdout.write(`${EMIT_USAGE}\n`);
    process.exit(0);
  }

  // loom#1501 (L4) — the lane is declared and well-formed, but if it carries no
  // overlay directory the byte counts below are not attributable to it. Say so.
  noteAbsentOverlay(args.lang);

  const clis = args.all ? EMIT_CLIS : args.cli ? [args.cli] : null;
  if (!clis) {
    process.stderr.write(
      `emit.mjs: ERROR — no CLI selected: pass --cli <${EMIT_CLIS.join("|")}> or ` +
        `--all; nothing was emitted or measured.\n${EMIT_USAGE}\n`,
    );
    process.exit(2);
  }

  // ASK for the scratch dir, never spell it (conservation-gate.md MUST-5, its
  // ask-for sentence — this call site was a hand-spelled `/tmp/loom-emit-<ts>`
  // until the 2026-10-03 correctness round found emit.mjs violating the rule it
  // also helps enforce). `mkdtemp` resolves through the platform's reported temp
  // root and guarantees the name is free.
  //
  // F2 (same round): a dir WE asked for and did not write into is removed on
  // exit — a dry run leaked an empty `loom-emit-*` dir on every invocation
  // (measured 0 → 1 → 2). `process.exit()` skips try/finally, so the removal
  // rides an `exit` listener, and the `wrote` flag — not the flag name —
  // decides: a validator-fail or usage run leaves an EMPTY dir (removed, once
  // it exists), a real emission writes into it (kept), a dry run writes
  // nothing (removed). A caller-supplied `--out` is NEVER removed; it is not
  // ours to delete, and the pole pair pins both halves
  // (emit-arg-validation.test.mjs::scratch-outdir-lifecycle).
  const autoOut = !args.out;
  if (autoOut) args.out = fs.mkdtempSync(path.join(os.tmpdir(), "loom-emit-"));
  let wrote = false;
  if (autoOut) {
    process.on("exit", () => {
      if (wrote) return;
      try {
        fs.rmSync(args.out, { recursive: true, force: true });
      } catch {
        // Cleanup-only, best-effort: zero-tolerance Rule 3's hooks/cleanup
        // carve-out — an unremovable scratch dir must not fail a run whose
        // measurement already succeeded.
      }
    });
  }

  let overallPass = true;
  const telemetry = {
    emitted_at: new Date().toISOString(),
    per_cli: {},
    block_cap_bytes: null,
    warn_cap_bytes: null,
  };

  // ────────────────────────────────────────────────────────────────
  // STRUCTURAL VALIDATOR PASS (V14, V16, V18, V15, V17) — ONE pass, ONE exit
  // ────────────────────────────────────────────────────────────────
  // F94 (ledger 2026-08-19). Each of these five used to `process.exit(1)` the
  // instant it failed, so a broken tree printed validator-14 and validator-16
  // and NOTHING ELSE. The operator could not see the validation STATE in one
  // pass and cleared failures one push at a time — a downstream multi-CLI USE
  // template reported exactly that.
  //
  // WHAT DID **NOT** CHANGE: the run ORDER, and the fact that a
  // precondition-blocked validator does not run. The order is load-bearing —
  //   * V16 before V15  — V15's regex section parse is only meaningful on a
  //     syntactically valid manifest;
  //   * V18 after V14 AND V16 — V18 reads rule frontmatter AND the
  //     cli_emit_exclusions stanza, and a malformed manifest must not silently
  //     flip a cc-only rule to skill-channel;
  //   * V17 half B after V16 — half B slices `tiers:` with the same regex V15
  //     uses, so on a malformed manifest it reports a distribution defect that
  //     is not there.
  // Running a validator whose input is already known-bad produces a MISLEADING
  // verdict, and a wrong verdict is worse than a missing one. So a
  // precondition-blocked validator reports a terminal
  // `SKIP (precondition: validator-N FAILED)` — the same
  // report-the-non-assertion-with-its-reason idiom V15 and V17 already use for
  // their class skips (loom#1386). A SKIP is NEVER a pass: it names what was
  // not asserted, and the failing precondition below still blocks emission.
  //
  // Emission is gated on `structuralFailures` at the END of the pass, before
  // the first emitBaseline() call — so nothing is emitted from a tree any of
  // these five rejected.
  const structuralFailures = [];
  const recordStructuralFailure = (id, header, failures) => {
    structuralFailures.push(id);
    overallPass = false;
    process.stderr.write(
      `VALIDATOR ${id} FAIL (${header}):\n${renderValidatorFailureBody(id, failures)}\n`,
    );
  };
  // Renders the SKIP reason so it names the failure IDENTITY — which validator,
  // which precondition — never a bare count or exit status.
  const preconditionSkip = (...ids) =>
    `precondition: ${ids.map((i) => `validator-${i}`).join(", ")} FAILED`;

  // Validator 14 — rule frontmatter consistency per rule-authoring.md Rule 7.
  // Runs FIRST so a frontmatter regression blocks emission before any
  // CLI-specific work. Silent-drop in getCritBaseline() was the failure
  // mode this validator exists to prevent (session 2026-04-24).
  // No precondition.
  const v14 = validateRuleFrontmatter();
  console.log(`[validator-14] rule-frontmatter: ${v14.pass ? "PASS" : "FAIL"}`);
  if (!v14.pass) {
    recordStructuralFailure(14, "rule-authoring.md Rule 7", v14.failures);
  }

  // Validator 16 — class-conditional manifest gate (journal 0080; class
  // -conditional per loom#1383). MUST run BEFORE V15: V15's regex section
  // parse is only meaningful on a syntactically valid manifest. PR #246's
  // broken manifest passed the YAML-blind regex parser; this gate makes
  // that impossible. The class read is reported alongside the verdict so a
  // consumer run shows WHICH expectation was asserted, not just PASS/FAIL.
  const v16Class = readRepoClass();
  const v16 = validateManifestYaml();
  console.log(
    `[validator-16] manifest-yaml: ${v16.pass ? "PASS" : "FAIL"} ` +
      `(class:${v16Class.type || "UNRESOLVED"} → manifest ` +
      `${v16Class.type === "coc-source" ? "REQUIRED" : v16Class.type ? "FORBIDDEN" : "expectation-unresolvable"})`,
  );
  if (!v16.pass) {
    recordStructuralFailure(
      16,
      "class-conditional sync-manifest.yaml gate, journal 0080 + loom#1383",
      v16.failures,
    );
  }

  // Validator 18 — cli_delivery lane-declaration contract (#408 AC#5-a/b).
  // Runs AFTER V14 (frontmatter validated) AND V16 (manifest YAML validated):
  // V18 reads BOTH rule frontmatter AND the cli_emit_exclusions manifest stanza
  // (via the shared loadExclusions), so — like V15 — it must sit behind the
  // strict-YAML gate (a malformed manifest must not silently flip a cc-only
  // rule to skill-channel). Every rule's non-CC delivery lane MUST be declared
  // or smart-defaulted; a path-scoped rule with no resolvable lane is the silent
  // Codex/Gemini drop this contract closes. The skill-channel rules are now
  // DELIVERED (AC#5-b) by emit-cli-artifacts.mjs::emitRulesReferenceSkill, which
  // resolves the SAME lane set through the shared cli-delivery parser — the count
  // below provably equals the rule count in the emitted rules-reference index.
  // PRECONDITION: V14 (frontmatter) AND V16 (manifest YAML). Both are inputs
  // V18 READS, so on a failure of either its lane verdicts describe the broken
  // input, not the delivery contract — it is not run, and reports the SKIP.
  const v18Blockers = [...(v14.pass ? [] : [14]), ...(v16.pass ? [] : [16])];
  if (v18Blockers.length > 0) {
    console.log(
      `[validator-18] cli-delivery: SKIP (${preconditionSkip(...v18Blockers)})`,
    );
  } else {
    const v18 = validateCliDelivery();
    console.log(
      `[validator-18] cli-delivery: ${v18.pass ? "PASS" : "FAIL"} ` +
        `(baseline:${v18.report.baseline.length} ` +
        `skill-channel:${v18.report["skill-channel"].length} → rules-reference skill ` +
        `cc-only:${v18.report["cc-only"].length} ` +
        `n/a-skill-embedded:${v18.report["n/a-skill-embedded"].length})`,
    );
    if (!v18.pass) {
      recordStructuralFailure(
        18,
        "cli_delivery contract, #408 AC#5-a",
        v18.failures,
      );
    }
  }

  // Validator 15 — manifest tier-completeness (journal 0078). Runs
  // alongside V14 (structural, pre-emission): a rule absent from every
  // tier is silently excluded from the subscription sync, so block
  // before any CLI work — same block-before-emission posture as V14 (F94: the
  // block is now the single exit at the end of the pass, not an exit here).
  // loom#1386 — V15 is loom-only. On a manifest-forbidden class it reports SKIP
  // with the reason rather than PASS: a printed PASS is indistinguishable from a
  // real assertion, and this gate asserts nothing there (see the ruling comment
  // above validateTierCompleteness).
  // PRECONDITION: V16. V15's regex section parse is only meaningful on a
  // syntactically valid manifest (PR #246's broken manifest passed the
  // YAML-blind regex parser) — so on a V16 failure V15 is not run.
  if (!v16.pass) {
    console.log(
      `[validator-15] tier-completeness: SKIP (${preconditionSkip(16)})`,
    );
  } else {
    const v15 = validateTierCompleteness();
    console.log(
      `[validator-15] tier-completeness: ${
        v15.skipped ? `SKIP (${v15.skipReason})` : v15.pass ? "PASS" : "FAIL"
      }`,
    );
    if (!v15.pass) {
      recordStructuralFailure(
        15,
        "sync-manifest tier-completeness, journal 0078",
        v15.failures,
      );
    }
    // Base-exclusion advisories (journal/0362 STEP-2) — ADVISORY, never blocking.
    if (Array.isArray(v15.advisories) && v15.advisories.length > 0) {
      console.log(
        `[validator-15] base-exclusion advisories (${v15.advisories.length}; non-blocking):`,
      );
      for (const a of v15.advisories) console.log(`  ⚠ ${a}`);
    }
  }

  // Validator 17 — multi-operator substrate hook ⇔ data coupling (F67
  // 2026-05-28, journal 0161, GH #379). The roster schema is data the
  // substrate's hooks read at runtime; shipping the hooks without the
  // schema fail-closes every consumer commit. Regression-lock makes
  // future tier-set drift structurally impossible.
  // loom#1386 — V17 SPLITS by class. Half A (hook ⇔ schema file coupling) runs
  // everywhere and is the half that protects a consumer from a fail-closing
  // genesis-anchor-guard; half B (tier-membership + F70 per-target dry-run) is a
  // distribution assertion and is asserted only at the owner class. The verdict
  // line names WHICH halves ran so a consumer run is never mistaken for a full one.
  // PRECONDITION: half A none (it is the consumer-protecting half and MUST run
  // everywhere, loom#1386); half B V16 — half B slices `tiers:` with the same
  // regex V15 uses, so a malformed manifest makes it report a distribution
  // defect that is not there. The reason is passed DOWN rather than the whole
  // validator being skipped, so half A still runs.
  const v17 = await validateRosterSchemaCoupling({
    haltHalfB: v16.pass
      ? null
      : `${preconditionSkip(16)} → half A (hook ⇔ schema file coupling) RAN ` +
        `and passed; half B (manifest tier-membership + the F70 ` +
        `sync-tier-aware per-target dry-run) reads the SAME manifest V16 ` +
        `rejected, so it is not asserted here. Fix validator-16 and re-run.`,
  });
  console.log(
    `[validator-17] roster-schema-coupling: ${
      !v17.pass
        ? "FAIL"
        : v17.skipped_half_b
          ? `PASS (half A only — ${v17.skipReason})`
          : "PASS"
    }`,
  );
  if (!v17.pass) {
    recordStructuralFailure(
      17,
      "multi-operator substrate hook⇔data coupling, F67 / GH #379 / journal 0161",
      v17.failures,
    );
  }

  // ── THE SINGLE EXIT (F94) ───────────────────────────────────────────────
  // Emission MUST NOT proceed when ANY of the five failed. This is the one
  // gate that replaces the five fail-fast exits; it names every failing
  // validator by IDENTITY so the operator clears the whole set in one pass
  // instead of one push per validator.
  if (structuralFailures.length > 0) {
    process.stderr.write(
      `\nEMISSION BLOCKED — ${structuralFailures.length} structural validator(s) FAILED: ` +
        `${structuralFailures.map((i) => `validator-${i}`).join(", ")}.\n` +
        `All five structural validators reported above in ONE pass; any printed ` +
        `SKIP names the failing precondition that blocked it and asserts NOTHING ` +
        `— clear the FAILures, re-run, and the SKIPped validators will report ` +
        `their own verdicts.\n`,
    );
    process.exit(1);
  }

  for (const cli of clis) {
    if (!args.dryRun) wrote = true; // a real emission writes into args.out — the exit hook must keep it
    const subdir = path.join(args.out, cli);
    const result = emitBaseline(cli, subdir, {
      lang: args.lang,
      verbose: args.verbose,
      dryRun: args.dryRun,
    });
    telemetry.per_cli[cli] = {
      rules: result.rules,
      bytes: result.emission_bytes,
      tier: result.tier,
      headroom_bytes: result.headroom_bytes,
      headroom_pct: result.headroom_pct,
      warn_cap_bytes: result.warn_cap_bytes,
      block_cap_bytes: result.block_cap_bytes,
      // The floor this run actually ENFORCED on this lane — an unexpired
      // headroom_floor_exceptions grant's floor while one covers the lane, the
      // declared floor otherwise — plus the declared floor and the grant itself
      // (null when none). A consumer grading headroom from this file needs the
      // effective floor: grading against the declared one mis-grades every lane
      // on a grant, and a hand-kept copy of the grant misses its expiry.
      headroom_floor_pct: result.headroom_floor_pct,
      headroom_floor_pct_declared: result.headroom_floor_pct_declared,
      headroom_floor_exception: result.headroom_floor_exception,
    };
    // Top-level caps: take from the first CLI that reports them. If different
    // CLIs have different caps, the per_cli block still shows the truth.
    if (telemetry.block_cap_bytes === null) {
      telemetry.block_cap_bytes = result.block_cap_bytes;
      telemetry.warn_cap_bytes = result.warn_cap_bytes;
    }
    const rtr = validateSlotRoundTrip(cli, args.lang);
    // Every row below reports on THIS lane's emission, so every one carries the
    // lane, taken once from the result that was measured (::laneLabel) rather
    // than rebuilt per row.
    const lane = laneLabel(result.cli, result.lang);
    console.log(
      `[${lane}] ${result.tier}: ${result.rules} rules, ${result.emission_bytes}B → ${result.out_path}`,
    );
    console.log(`[${lane}] validator-12 slot-round-trip: ${rtr.pass ? "PASS" : "FAIL"}`);
    if (!rtr.pass) {
      overallPass = false;
      process.stderr.write(`[${lane}] VALIDATOR 12 FAIL: ${JSON.stringify(rtr.failures)}\n`);
    }
    // loom#1355 — announce every per-rule budget exception actually exercised
    // on this lane. Printed BEFORE the WARN/BLOCK blocks so an operator reading
    // top-down learns a waiver is in force before reading the numbers it
    // explains, and so an expiring waiver is visible on every single emission.
    if (
      result.per_rule_budget_exceptions_applied &&
      result.per_rule_budget_exceptions_applied.length > 0
    ) {
      for (const ex of result.per_rule_budget_exceptions_applied) {
        process.stderr.write(
          `[${lane}] per-rule budget EXCEPTION APPLIED: ${ex.rule} (exception lane '${ex.lane}') ` +
            `block ceiling ${ex.base_block_threshold_bytes}B → ${ex.effective_block_ceiling_bytes}B ` +
            `(emitted ${ex.bytes}B; declared in sync-manifest.yaml, issue #${ex.issue}, ` +
            `EXPIRES ${ex.expires} — on expiry this rule reverts to the ` +
            `${ex.base_block_threshold_bytes}B ceiling and the gate turns RED again).\n`,
        );
      }
    }
    if (result.budget_warnings && result.budget_warnings.length > 0) {
      process.stderr.write(
        `[${lane}] per-rule budget WARN (${result.budget_warnings.length} rule${result.budget_warnings.length > 1 ? "s" : ""}):\n`,
      );
      for (const w of result.budget_warnings) {
        process.stderr.write(`  ${w}\n`);
      }
    }
    if (result.budget_block_violations && result.budget_block_violations.length > 0) {
      // Per-rule budget BLOCK — spec v6 §A.2 + sync-manifest.yaml
      // per_rule_budget_block_threshold. ANY rule over budget * (1 +
      // block_threshold) is a hard fail; emission is wrong by contract,
      // not just over a soft target. Closes CDX-7 (2026-05-10 audit).
      overallPass = false;
      process.stderr.write(
        `[${lane}] per-rule budget BLOCK (${result.budget_block_violations.length} rule${result.budget_block_violations.length > 1 ? "s" : ""} exceed block_threshold):\n`,
      );
      for (const v of result.budget_block_violations) {
        process.stderr.write(
          `  ${v.rule}: ${v.bytes}B over budget ${v.budget}B by +${v.over_by_pct}% (block_threshold ${v.block_threshold_bytes}B); over by ${v.over_by_bytes}B\n`,
        );
      }
      process.stderr.write(
        `[${lane}] remediation: per spec v6 §A.2, abridge the offending rule (move long examples to .claude/guides/rule-extracts/<rule>.md), tighten the per-rule budget, or demote the rule to path-scoped.\n`,
      );
    }
    if (result.tier === "BLOCK") {
      overallPass = false;
      // Read the LIVE per-CLI caps rather than restating literals. The prior
      // form hardcoded 61440 here while emitBaseline gated on the manifest
      // value, so after the 2026-08-12 raise to 65536 this message would have
      // reported a cap that no longer existed — and reported an "over by"
      // arithmetic computed against it, understating the real overage by
      // 4096 B. A remediation message that misstates the ceiling it is telling
      // you to fit under is worse than no message.
      const _caps = loadCliCaps()[cli] || {
        warn_cap_bytes: 32768,
        block_cap_bytes: 65536,
      };
      process.stderr.write(
        `[${lane}] HARD BLOCK: ${result.emission_bytes}B >= block_cap ${_caps.block_cap_bytes} (over by ${result.emission_bytes - _caps.block_cap_bytes}B)\n`,
      );
      process.stderr.write(
        `[${lane}] remediation: per spec v6 §A.2, demote a CRIT rule to path-scoped, tighten a per-rule budget, or trim the ruleset. See ${subdir}/emit-report-${cli}.json for per-rule sizes.\n`,
      );
    } else if (result.tier === "WARN") {
      // Same defect, same fix: the WARN band's upper bound IS the block cap, so
      // a literal here drifts from the manifest exactly as the BLOCK line did.
      const _caps = loadCliCaps()[cli] || {
        warn_cap_bytes: 32768,
        block_cap_bytes: 65536,
      };
      process.stderr.write(
        `[${lane}] WARN: ${result.emission_bytes}B in [${_caps.warn_cap_bytes}, ${_caps.block_cap_bytes}) — refactoring-signal tier (steady state per v6 §2.2).\n`,
      );
    }
    // v6.2 Shard 1 — per-lang headroom floor enforcement. Surfaces with
    // ANY violation (independent of tier — a BLOCK is cap-breach, a
    // floor breach is the canary BEFORE cap-breach). Always logs;
    // strict-headroom mode (default on as of cycle-2; opt-out via
    // --no-strict-headroom for test-harness) converts the log into a
    // hard fail.
    if (result.headroom_floor_violations && result.headroom_floor_violations.length > 0) {
      const v = result.headroom_floor_violations[0];
      const verdict = args.strictHeadroom ? "BLOCK" : "WARN";
      process.stderr.write(
        `[${lane}] headroom-floor ${verdict}: ` +
          `${v.headroom_pct}% < ${v.headroom_floor_pct}% floor ` +
          `(under by ${v.under_by_bytes}B; emission ${v.emission_bytes}B vs ` +
          `floor ${v.headroom_floor_bytes}B / cap ${v.block_cap_bytes}B)\n`,
      );
      process.stderr.write(
        `[${lane}] remediation: ${v.remediation}\n`,
      );
      if (args.strictHeadroom) {
        overallPass = false;
      }
    }
    // #423 AC#4 — binding-token regression guard (hard BLOCK, NOT strict-gated;
    // a Ruby code fence in the always-on baseline is always a defect — Ruby
    // belongs in the on-demand 28-ruby-bindings skill per the rb→rs collapse).
    if (
      result.binding_token_violations &&
      result.binding_token_violations.length > 0
    ) {
      const b = result.binding_token_violations[0];
      process.stderr.write(
        `[${lane}] binding-token BLOCK (#423): ` +
          `${b.message} (line ${b.line}, fence \`\`\`${b.token})\n`,
      );
      overallPass = false;
    }
  }

  // Write consolidated emit-telemetry.json at the shared out-dir so
  // /cli-audit Phase 4 (and coc-sync marker synthesis) can read a single
  // machine-readable summary rather than parsing two per-CLI reports.
  // Surfaces baseline headroom as a trend metric — Risk-0004 (baseline-cap
  // headroom ~4%) becomes observable across syncs.
  if (!args.dryRun) {
    try {
      fs.mkdirSync(args.out, { recursive: true });
      writeTextArtifactSync(
        path.join(args.out, "emit-telemetry.json"),
        JSON.stringify(telemetry, null, 2),
      );
    } catch (e) {
      process.stderr.write(`[telemetry] write failed: ${e.message}\n`);
    }
  }

  // Validator 13 + POLICIES wiring — runs wherever a codex surface exists;
  // not CLI-scoped. On a cc-only repo there is no codex surface, so it SKIPS
  // (loom#1538) and says so: a skip is not a pass, and the log line must not
  // let a reader take one for the other.
  const v13 = await validateMcpBijectionAgainstFixtures();
  if (!v13.pass) {
    overallPass = false;
    const detail = v13.reason || JSON.stringify(v13.failures);
    process.stderr.write(`VALIDATOR 13 FAIL: ${detail}\n`);
  } else if (v13.skipped) {
    console.log(`[validator-13] SKIP (NOT a pass) — ${v13.reason}`);
  } else if (args.dryRun) {
    console.log(`[validator-13] PASS (dry-run; policies.json not written)`);
  } else {
    const policiesDir = path.join(args.out, "codex-mcp-guard");
    const policiesPath = await wireMcpPolicies(policiesDir);
    console.log(`[validator-13] PASS + wrote ${policiesPath}`);
  }

  process.exit(overallPass ? 0 : 1);
}

// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; a lexical compare exits 0 silently).
if (isMainModule(import.meta.url)) {
  // Explicit rejection handler: main is async as of loom#1538, and a bare
  // `main()` would surface a throw as an unhandled rejection whose exit code
  // is a runtime-flag detail rather than this script's contract. Keep the
  // pre-async behaviour — print the failure, exit 1.
  main().catch((err) => {
    process.stderr.write(`emit: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
