#!/usr/bin/env node
/**
 * emit-coc.mjs — unified `.coc/` artifact-set emitter (issue #392, Step-2 producer).
 *
 * Produces a `.coc/` derivative ALONGSIDE the existing per-CLI variants
 * (`.codex/`, `.gemini/`, `AGENTS.md`, `GEMINI.md`). The `.coc/` directory is
 * the UNIFIED, CLI-NEUTRAL composed form: one canonical artifact set that a
 * downstream consumer (csq) reads and re-translates per-surface. It is treated
 * by consumers as one more composed-files overlay — the same trust model as
 * `.codex/` / `.gemini/` / `AGENTS.md` (plain files in the user's repo; NO
 * signing, NO trust prompt).
 *
 * Loom owns `.coc` EMISSION; csq CONSUMES it (`rules/loom-csq-boundary.md`).
 * The producer conforms to csq's published consumer contract
 * `governance.csq:specs/09-unified-coc-artifact-standard.md` (rev 2.0.0):
 *   - directory shape (§9.1): COC.md + COC.lock + rules/agents/skills/commands,
 *     four canonical subdirs always present (empty → `.gitkeep` sentinel).
 *   - frontmatter (§9.2): per-artifact `id` (^[A-Z][A-Z0-9-]{1,32}$), optional
 *     `paths` (rules), optional `applies_to` (omitted = universal per §9.2.4.1).
 *     `coc.version` lives in COC.md once (§9.5).
 *   - determinism (§9.2.5): byte-identical re-emit (sorted traversal + lock).
 *   - read-only on the consumer side (§9.10) — loom is the sole writer (§9.10.3).
 *
 * §9.7 (first-pull trust gate) and §9.8 (Ed25519 signature) were RETRACTED in
 * spec rev 2.0.0 as wrong-layer — hence COC.lock is a PLAIN canonical-JSON
 * manifest with NO signature sidecar.
 *
 * Usage:
 *   node .claude/bin/emit-coc.mjs --out <dir> [--target <repos.* key>] [-v]
 *   (--target resolves against sync-manifest.yaml::repos.* — py|rs|rb|base|prism;
 *    cc/codex/gemini are TIER names, not targets, and correctly halt exit 2)
 *
 * `--out .` writes `<cwd>/.coc/`. `--target` applies the consumer's tier
 * subscriptions + language variant overlays (mirrors emit-cli-artifacts.mjs);
 * absent → emit everything present in `.claude/` with no variant overlay
 * (the post-/sync consumer case, where `.claude/` already holds the subset).
 *
 * Node ESM, zero external deps (mirrors emit.mjs / emit-cli-artifacts.mjs).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  REPO,
  safeWriteFileSync,
  loadExclusions,
  loadLoomOnly,
  buildTierFilter,
  loadTargetVariant,
  composeArtifactBody,
  walkFiles,
  matchesAnyGlob,
} from "./lib/coc-manifest.mjs";
import { stripSlotMarkers } from "./emit.mjs";

// ──────────────────────────────────────────────────────────────────
// Constants — the producer-side contract knobs.
// ──────────────────────────────────────────────────────────────────

// coc.version envelope declared once in COC.md (spec §9.5). Major MUST stay
// within csq's MAX_KNOWN_COC_MAJOR window (1) until csq ships a reader bump.
const COC_VERSION = "1.0.0";

// COC.lock schema_version (issue #392 AC: `{"schema_version": 1, "files": [...]}`).
const LOCK_SCHEMA_VERSION = 1;

// Per-file budget (issue #392 AC: each `.coc/` file ≤ 60 KiB, "matches the
// existing per-CLI slot cap" = emit.mjs block_cap 61440). spec-09 imposes NO
// size cap on the consumer side, so an oversize file is a producer-quality
// WARN (surfaced + counted), NOT a hard block — emitting a truncated body
// would lose load-bearing content (zero-tolerance.md Rule 2/6).
const FILE_SIZE_WARN_BYTES = 61440;

// Surface allowlist (spec §9.2.2). "all" is the implicit universal default
// (omit the field); the explicit per-surface tokens are the three CLIs.
const SURFACES = ["claude-code", "codex", "gemini"];

// Per spec §9.2.1: `id` MUST match this grammar (len 2–33, leading [A-Z]).
const ID_RE = /^[A-Z][A-Z0-9-]{1,32}$/;

// Kind sentinel prepended when the natural id is digit-leading (skills like
// `01-core-sdk` → `S01-CORE-SDK`). The kind dir already separates namespaces,
// so the sentinel only restores grammar conformance; ids stay unique per kind.
const KIND_SENTINEL = { rules: "R", agents: "A", skills: "S", commands: "C" };

// Typed-superset fields (contract 09b §3.2 — the L2-enabling requirement).
// For a conforming runtime to deliver L2 (native subagent registry / native
// /command / progressive-disclosure skill), `.coc/` MUST preserve the source
// artifact's native typed frontmatter rather than stripping it. These are the
// per-kind fields the producer carries BEYOND the strict {id, paths, applies_to}
// block, in canonical (allowlist) order. Each is carried ONLY when the source
// artifact declares it (the producer never synthesizes a field), so NONE are
// producer-required — the per-kind SET is:
//   - agent:   name, description, tools, model, hooks
//   - command: name, description, argument-hint, model
//   - skill:   name, description
//   - rule:    none — paths/applies_to (already in the strict block) ARE its
//              typed fields; rules are context, not a native registry kind.
// For L2 a conformer NEEDS name + description on the registry kinds; when a
// source omits `name` (e.g. a description-only skill / command), the native
// handle derives from the filename/dir exactly as the native surface does.
// The fields are ADDITIVE + OMITTABLE + unknowns-tolerant (contract §3.2 + §9):
// a `.coc/` set omitting them is a valid L1-floor set; a consumer not parsing
// them reads them via `unknowns` and delivers L1 — a clean degrade, never a
// parse failure. They are carried VERBATIM from the source's composed
// frontmatter (extractTypedBlock), never re-serialized — see buildFrontmatter.
const TYPED_FIELDS = {
  rules: [],
  agents: ["name", "description", "tools", "model", "hooks"],
  skills: ["name", "description"],
  commands: ["name", "description", "argument-hint", "model"],
};

// Known sha256 of a zero-byte file (the `.gitkeep` sentinel). Computed, not
// hardcoded, at emit time — kept here only as documentation of the value.
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// ──────────────────────────────────────────────────────────────────
// id derivation — spec §9.2.1 + basename==id (issue #392 AC).
// ──────────────────────────────────────────────────────────────────
function deriveId(kind, sourceName) {
  if (!KIND_SENTINEL[kind]) {
    throw new Error(`emit-coc: unknown artifact kind "${kind}" (expected one of ${Object.keys(KIND_SENTINEL).join("/")}).`);
  }
  let id = String(sourceName)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (/^[0-9]/.test(id)) id = KIND_SENTINEL[kind] + id; // digit-leading → prepend sentinel
  if (!ID_RE.test(id)) {
    throw new Error(
      `emit-coc: derived id "${id}" (from ${kind}/${sourceName}) violates ` +
        `spec §9.2.1 grammar ^[A-Z][A-Z0-9-]{1,32}$ — name too long (>33) or unmappable.`,
    );
  }
  return id;
}

// ──────────────────────────────────────────────────────────────────
// applies_to — surfaces the artifact targets (spec §9.2.2 + §9.2.4.1).
// Source of truth is the SAME cli_emit_exclusions the per-CLI emitter uses,
// so `.coc/` surface-scoping is byte-aligned with what `.codex/`/`.gemini/`
// actually receive. Returns null when universal (omit the field).
// ──────────────────────────────────────────────────────────────────
function computeAppliesTo(manifestRel, exclusions) {
  const surfaces = SURFACES.filter((s) => {
    if (s === "claude-code") return true; // loom is CC-source; nothing excludes from CC
    return !matchesAnyGlob(manifestRel, exclusions[s] || []);
  });
  if (surfaces.length === SURFACES.length) return null; // universal → omit per §9.2.4.1
  return surfaces; // SURFACES order is fixed + alphabetical → deterministic
}

// ──────────────────────────────────────────────────────────────────
// Frontmatter helpers.
// ──────────────────────────────────────────────────────────────────

// Strict-YAML-1.2 double-quoted scalar. SAFETY INVARIANT: every value passed
// here is LOOM-AUTHORED, single-line frontmatter data — `paths` come from a
// source rule's own frontmatter (loom-authored) and `applies_to` from the fixed
// SURFACES constant. No consumer/attacker-supplied or body-derived text reaches
// this function. Under that invariant, escaping `\` and `"` is sufficient to bar
// octal literals, 1.1 bool coercion (yes/no/on/off), implicit timestamps,
// anchors/aliases, and block-escape. If a future change ever routes raw
// body-derived or consumer-supplied text through buildFrontmatter, re-review:
// a literal newline inside a flow sequence would break the single-line emission
// (today impossible — list inputs are single-line frontmatter fields).
function yamlQuote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Build the per-artifact strict-YAML-1.2 frontmatter block (no trailing LF).
// `id` is QUOTED (security/cc R1): although the grammar bars YAML-special chars,
// an artifact named exactly `no`/`on`/`off`/`yes`/`true`/`false`/`null` would
// derive to `id: NO` etc. — a string under strict YAML 1.2 but coerced to a
// bool/null under any 1.1-compat reader. The spec forbids 1.1 coercion, so we
// quote unconditionally. List values are quoted flow sequences.
//
// `typedBlock` (contract §3.2) is the per-kind typed-superset, carried VERBATIM
// from the source artifact's composed frontmatter via extractTypedBlock(). It is
// NOT routed through yamlQuote: the typed fields include nested blocks (agent
// `hooks:` is multi-line) that single-line quoting would corrupt.
//
// The block extractTypedBlock returns is well-formed by two structural facts:
//  (1) It preserves ONLY single-line scalar values and INDENTED nested blocks /
//      block-scalar bodies — exactly the shapes loom's typed fields use today.
//      A multi-line scalar whose continuation wraps to column 0 is NOT silently
//      dropped — extractTypedBlock THROWS on it (a future author adding such a
//      field must extend the loop first), so this comment cannot drift ahead of
//      the code.
//  (2) A column-0 `---` (or any column-0 non-allowlisted line) is a block
//      TERMINATOR in extractTypedBlock (sets curKey=null, never collected), AND
//      YAML fence-closing requires column 0 — so the emitted typed block can
//      never carry a `---` that prematurely closes THIS frontmatter. (rawFrontmatter
//      also extracts strictly between the source's own `---` fences — a secondary
//      guarantee; the column-0 terminator is the operative one.)
// The block is appended as its own line(s) after the strict fields — never inside
// a flow sequence — so the single-line-emission invariant on id/paths/applies_to
// is unaffected.
function buildFrontmatter({ id, paths, appliesTo, typedBlock }) {
  const lines = ["---", `id: ${yamlQuote(id)}`];
  if (paths && paths.length) {
    lines.push(`paths: [${paths.map(yamlQuote).join(", ")}]`);
  }
  if (appliesTo && appliesTo.length) {
    lines.push(`applies_to: [${appliesTo.map(yamlQuote).join(", ")}]`);
  }
  if (typedBlock) {
    lines.push(typedBlock);
  }
  lines.push("---");
  return lines.join("\n");
}

// Extract the raw frontmatter text (between the leading `---` fences) so we
// can read multi-line list fields parseFrontmatter() does not capture.
function rawFrontmatter(source) {
  const m = source.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? m[1] : "";
}

// Strip the leading frontmatter block, returning the body only.
function stripFrontmatter(source) {
  return source.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

// Tokenize a YAML flow-sequence interior (`a, "b,c", 'd'`) into raw items,
// respecting quotes so a comma INSIDE a quoted scalar is not a separator
// (cc R1: naive split(",") mis-splits `["a,b"]` into two globs).
function splitFlowItems(inner) {
  const items = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ",") {
      items.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  items.push(cur);
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

// Read a YAML list field (flow `[a, b]` OR block `\n  - a\n  - b`) from raw
// frontmatter text. Returns string[] or null when the field is absent.
// A MALFORMED block item (a `-` line that fails the item shape) THROWS rather
// than silently truncating the list (zero-tolerance.md Rule 3 — silent
// fallback that would drop path-scope coverage).
function extractListField(rawFm, field) {
  const flow = rawFm.match(new RegExp(`^${field}:[ \\t]*\\[(.*)\\][ \\t]*$`, "m"));
  if (flow) {
    return splitFlowItems(flow[1]);
  }
  const head = rawFm.match(new RegExp(`^${field}:[ \\t]*$`, "m"));
  if (!head) return null;
  const rest = rawFm.slice(head.index + head[0].length).split("\n");
  const items = [];
  for (const line of rest) {
    if (line.trim() === "") continue; // tolerate blank lines inside the block
    // `- item` at column 0 OR indented — both first-class YAML 1.2 block
    // sequences under the key (parity with coc-run.mjs::listField; loom#777 R1).
    if (!/^[ \t]*-/.test(line)) break; // first non-list line ends the block
    const it = line.match(/^[ \t]*-[ \t]*(.*\S)[ \t]*$/);
    if (!it) {
      throw new Error(
        `emit-coc: malformed YAML block-list item in '${field}': ${JSON.stringify(line)} ` +
          `— refusing to silently truncate the list (zero-tolerance Rule 3).`,
      );
    }
    items.push(it[1].replace(/^['"]|['"]$/g, ""));
  }
  return items.length ? items : null;
}

// ──────────────────────────────────────────────────────────────────
// Typed-superset extraction (contract §3.2) — VERBATIM, never re-serialized.
// ──────────────────────────────────────────────────────────────────
// Pull the per-kind TYPED_FIELDS out of the source's composed frontmatter text
// (rawFm), returning the raw text of each allowlisted key's block — the `key:`
// line PLUS any indented continuation lines (so a nested `hooks:` block is
// preserved exactly) — joined in canonical TYPED_FIELDS order. Returns "" when
// the kind carries no typed fields OR none are present (clean L1-floor degrade).
//
// id/paths/applies_to are NEVER in any kind's TYPED_FIELDS (they are owned by the
// strict block), so this cannot duplicate a strict field. A column-0 `key:` line
// starts a block; subsequent indented (or blank) lines belong to it; the next
// column-0 key ends it. Canonical-order emission (not source order) keeps the
// output deterministic across artifacts regardless of source field ordering.
function extractTypedBlock(rawFm, kind) {
  const allow = TYPED_FIELDS[kind] || [];
  if (allow.length === 0 || !rawFm) return "";
  const allowSet = new Set(allow);
  const lines = rawFm.split("\n");
  const blocks = new Map(); // key → raw lines (incl. the key line)
  let curKey = null;
  for (const line of lines) {
    const keyMatch = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s.*)?$/.exec(line);
    if (keyMatch && !/^\s/.test(line)) {
      curKey = keyMatch[1];
      blocks.set(curKey, [line]);
    } else if (curKey !== null && (/^\s/.test(line) || line.trim() === "")) {
      // Indented continuation (nested-block child / block-scalar body) or an
      // interior blank line — belongs to the current block.
      blocks.get(curKey).push(line);
    } else {
      // A column-0 line that is neither a key nor indented. In well-formed
      // frontmatter (only keys + indented children) this occurs ONLY as the
      // wrapped continuation of a multi-line plain/quoted scalar. If it would
      // drop a continuation of an ALLOWLISTED field, FAIL LOUD rather than
      // silently truncate the value (zero-tolerance Rule 3 — the same posture
      // extractListField takes on a malformed block-list). Single-line scalars
      // and INDENTED nested blocks / block-scalar bodies (every loom typed-field
      // shape today) never reach here; a non-allowlisted field's continuation is
      // harmlessly skipped (we never emit it).
      if (curKey !== null && allowSet.has(curKey)) {
        throw new Error(
          `emit-coc: typed field '${curKey}' (kind '${kind}') has a multi-line ` +
            `scalar value whose continuation is at column 0 (${JSON.stringify(line)}) — ` +
            `extractTypedBlock preserves single-line scalars + indented nested blocks ` +
            `only; extend the block-capture loop before adding such a field.`,
        );
      }
      curKey = null; // a column-0 non-key line ends the current block
    }
  }
  const out = [];
  for (const key of allow) {
    if (!blocks.has(key)) continue;
    const blk = blocks.get(key).slice();
    while (blk.length > 1 && blk[blk.length - 1].trim() === "") blk.pop(); // trim trailing blanks
    out.push(blk.join("\n"));
  }
  return out.join("\n");
}

// ──────────────────────────────────────────────────────────────────
// Body composition — CLI-NEUTRAL canonical form.
// composeArtifactBody(cat, rel, /*cli*/ null, lang) applies the language
// variant overlay + strips BUILD-internal refs, with NO per-CLI path rewrite
// (cli=null is a no-op in rewriteClaudePathsForCli). We then drop slot markers
// (csq's CocSet has no slot logic; RuleDef.body is a single raw-markdown
// string) and the source frontmatter (replaced by the strict `.coc/` block).
// ──────────────────────────────────────────────────────────────────
function composeNeutralBody(category, relPath, lang) {
  const res = composeArtifactBody(category, relPath, null, lang);
  if (res === null) return null;
  const rawFm = rawFrontmatter(res.body);
  const body = stripSlotMarkers(stripFrontmatter(res.body)).replace(/^\n+/, "").replace(/\s+$/, "");
  return { rawFm, body, destRelPath: res.destRelPath };
}

// ──────────────────────────────────────────────────────────────────
// Artifact collection — one record per emitted artifact.
//   { kind, id, relInCoc, content }
// ──────────────────────────────────────────────────────────────────
function collectArtifacts({ exclusions, loomOnly, tierFilter, lang, warnOversize }) {
  const records = [];
  const seenIds = { rules: new Set(), agents: new Set(), skills: new Set(), commands: new Set() };

  const push = (kind, sourceName, manifestRel, composed, paths) => {
    const id = deriveId(kind, sourceName);
    if (seenIds[kind].has(id)) {
      throw new Error(
        `emit-coc: duplicate ${kind} id "${id}" (from ${manifestRel}) — spec §9.4.2 ` +
          `forbids duplicate ids within .coc/ (csq hard-errors coc.duplicate_id).`,
      );
    }
    seenIds[kind].add(id);
    const appliesTo = computeAppliesTo(manifestRel, exclusions);
    const typedBlock = extractTypedBlock(composed.rawFm, kind);
    const fm = buildFrontmatter({ id, paths, appliesTo, typedBlock });
    const content = `${fm}\n\n${composed.body}\n`;
    const relInCoc = `${kind}/${id}.md`;
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > FILE_SIZE_WARN_BYTES) warnOversize.push({ relInCoc, bytes });
    records.push({ kind, id, relInCoc, content });
  };

  // RULES — `.claude/rules/*.md`. Carry `paths` for path-scoped rules.
  const rulesDir = path.join(REPO, ".claude", "rules");
  if (fs.existsSync(rulesDir)) {
    for (const name of fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md")).sort()) {
      const manifestRel = `rules/${name}`;
      if (loomOnly && matchesAnyGlob(manifestRel, loomOnly)) continue;
      if (tierFilter && !matchesAnyGlob(manifestRel, tierFilter)) continue;
      const composed = composeNeutralBody("rules", name, lang);
      if (composed === null) continue;
      const paths = extractListField(composed.rawFm, "paths");
      push("rules", path.basename(name, ".md"), manifestRel, composed, paths);
    }
  }

  // AGENTS — `.claude/agents/**/*.md` (recursive). Skip `_*` meta files.
  const agentsDir = path.join(REPO, ".claude", "agents");
  if (fs.existsSync(agentsDir)) {
    const rels = [];
    for (const { relPath } of walkFiles(agentsDir)) {
      if (!relPath.endsWith(".md")) continue;
      if (path.basename(relPath).startsWith("_")) continue; // _README.md etc.
      rels.push(relPath.split(path.sep).join("/"));
    }
    for (const rel of rels.sort()) {
      const manifestRel = `agents/${rel}`;
      if (loomOnly && matchesAnyGlob(manifestRel, loomOnly)) continue;
      if (tierFilter && !matchesAnyGlob(manifestRel, tierFilter)) continue;
      const composed = composeNeutralBody("agents", rel, lang);
      if (composed === null) continue;
      push("agents", path.basename(rel, ".md"), manifestRel, composed, null);
    }
  }

  // SKILLS — `.claude/skills/<name>/SKILL.md` (entry point only; per spec
  // §9.2.4 SkillDef carries one body — progressive-disclosure sub-files are
  // not part of the CocSet contract).
  //
  // NESTED skills (W4 D3 resolution): a skill dir with NO top-level SKILL.md but
  // with per-language `<dir>/<sub>/SKILL.md` entry points (e.g. 40-stack-onboarding/
  // {go,python,rust,typescript}/SKILL.md) is emitted as ONE flat `.coc/` skill per
  // sub-entry, id `<DIR>-<SUB>` — coverage-preserving (every language body reaches
  // every surface), csq reads them as ordinary SkillDefs. The one-body-per-skill
  // contract (§9.2.4) is satisfied per flat skill. Legacy emit-cli-artifacts makes ONE
  // dir-level delivery decision (`skills/<dir>/SKILL.md`) and emits the whole tree; we
  // mirror that decision (filter on the dir-level path) so per-surface membership stays
  // byte-aligned with legacy, then emit one flat skill per sub-entry.
  const skillsDir = path.join(REPO, ".claude", "skills");
  if (fs.existsSync(skillsDir)) {
    const skillNames = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const skill of skillNames) {
      const dirManifestRel = `skills/${skill}/SKILL.md`; // the dir-level path legacy filters on
      if (loomOnly && matchesAnyGlob(dirManifestRel, loomOnly)) continue;
      if (tierFilter && !matchesAnyGlob(dirManifestRel, tierFilter)) continue;
      if (fs.existsSync(path.join(skillsDir, skill, "SKILL.md"))) {
        // Flat skill: `<dir>/SKILL.md` → id `<DIR>`.
        const composed = composeNeutralBody("skills", `${skill}/SKILL.md`, lang);
        if (composed === null) continue;
        push("skills", skill, dirManifestRel, composed, null);
      } else {
        // Nested skill: one flat `.coc/` skill per `<dir>/<sub>/SKILL.md` → id `<DIR>-<SUB>`.
        const subs = fs
          .readdirSync(path.join(skillsDir, skill), { withFileTypes: true })
          .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, skill, d.name, "SKILL.md")))
          .map((d) => d.name)
          .sort();
        for (const sub of subs) {
          const composed = composeNeutralBody("skills", `${skill}/${sub}/SKILL.md`, lang);
          if (composed === null) continue;
          push("skills", `${skill}-${sub}`, `skills/${skill}/${sub}/SKILL.md`, composed, null);
        }
      }
    }
  }

  // COMMANDS — `.claude/commands/**/*.md`.
  const commandsDir = path.join(REPO, ".claude", "commands");
  if (fs.existsSync(commandsDir)) {
    const rels = [];
    for (const { relPath } of walkFiles(commandsDir)) {
      if (!relPath.endsWith(".md")) continue;
      rels.push(relPath.split(path.sep).join("/"));
    }
    for (const rel of rels.sort()) {
      const manifestRel = `commands/${rel}`;
      if (loomOnly && matchesAnyGlob(manifestRel, loomOnly)) continue;
      if (tierFilter && !matchesAnyGlob(manifestRel, tierFilter)) continue;
      const composed = composeNeutralBody("commands", rel, lang);
      if (composed === null) continue;
      push("commands", path.basename(rel, ".md"), manifestRel, composed, null);
    }
  }

  return records;
}

// ──────────────────────────────────────────────────────────────────
// COC.md — the human-readable primer + the coc.version envelope (§9.5).
// ──────────────────────────────────────────────────────────────────
function buildCocMd(counts) {
  const fm = ["---", `coc.version: ${COC_VERSION}`, "---"].join("\n");
  const body = [
    "# COC — Unified Cognitive-Orchestration Artifact Set",
    "",
    "This `.coc/` directory is the **unified, CLI-neutral** artifact set for this",
    "repository, emitted by loom alongside the per-CLI variants (`.codex/`,",
    "`.gemini/`, `AGENTS.md`, `GEMINI.md`). It is a composed-files overlay — plain",
    "files in your repo, the same trust model as the per-CLI artifacts. There is no",
    "signing and no trust prompt; you control what lands here through the same review",
    "channel you use for any other repository content.",
    "",
    "## Layout",
    "",
    "| Path           | Contents                                                        |",
    "| -------------- | --------------------------------------------------------------- |",
    "| `COC.md`       | This primer; declares the `coc.version` envelope.               |",
    "| `COC.lock`     | Canonical JSON manifest: SHA-256 of every other file under `.coc/`. |",
    "| `rules/`       | One Markdown file per rule (`<ID>.md`).                          |",
    "| `agents/`      | One Markdown file per agent.                                     |",
    "| `skills/`      | One Markdown file per skill (the SKILL.md entry point).          |",
    "| `commands/`    | One Markdown file per command.                                   |",
    "",
    "## Frontmatter",
    "",
    "Each artifact carries strict YAML 1.2 frontmatter with a grammar-conforming",
    "`id` (`^[A-Z][A-Z0-9-]{1,32}$`, file basename equals `id`). Rules may carry a",
    "`paths` path-scope filter. An `applies_to` surface allowlist is present only",
    "when the artifact is surface-specific; a universal artifact omits it. The",
    "`coc.version` envelope is declared here once and omitted per-artifact.",
    "",
    "Agents, commands, and skills additionally carry a **typed superset** beyond",
    "`id`, copied verbatim from each artifact's source frontmatter — so a field is",
    "present only when the source declares it: agents carry `name`/`description`",
    "(+ optional `tools`/`model`/`hooks`); commands carry an optional `name` handle",
    "(+ optional `description`/`argument-hint`/`model`; absent → the handle derives",
    "from the artifact filename, as in the native surface); skills carry `name`",
    "and/or `description`. These fields let a conforming runtime reconstruct the",
    "native surface (subagent registry, `/command`, eager-loaded skill description)",
    "— Level-2 fidelity. They are additive and omittable: a consumer that does not",
    "parse them reads them as unknowns and delivers the Level-1 injection floor (a",
    "clean degrade, never a parse failure).",
    "",
    "## Contents",
    "",
    `- rules: ${counts.rules}`,
    `- agents: ${counts.agents}`,
    `- skills: ${counts.skills}`,
    `- commands: ${counts.commands}`,
    "",
    "## Authorship",
    "",
    "Loom owns `.coc/` emission; downstream consumers read it (read-only). The",
    "format conforms to the published consumer contract",
    "`governance.csq:specs/09-unified-coc-artifact-standard.md`.",
  ].join("\n");
  return `${fm}\n\n${body}\n`;
}

// ──────────────────────────────────────────────────────────────────
// COC.lock — canonical JSON: {schema_version, files:[{path, sha256}]},
// files sorted by path, deterministic (pretty-printed, LF, no BOM, no
// trailing newline). Excludes COC.lock itself (csq hashes COC.lock's own
// bytes as the parse-cache key; §9.1).
// ──────────────────────────────────────────────────────────────────
function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function buildLock(fileEntries) {
  const files = [...fileEntries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return JSON.stringify({ schema_version: LOCK_SCHEMA_VERSION, files }, null, 2);
}

// ──────────────────────────────────────────────────────────────────
// Tree materialization into a sibling tmp dir, then atomic swap.
// ──────────────────────────────────────────────────────────────────
// Write via the shared O_NOFOLLOW helper (emit-cli-artifacts.mjs::safeWriteFileSync)
// — refuses to follow a symlink at the leaf, matching the F53 hardening standard
// (state-io.js) and the sibling emitter. UTF-8, no BOM (string data, default enc).
function writeFileNoBom(absPath, content) {
  safeWriteFileSync(absPath, content);
}

function buildTree(tmpDir, records) {
  const fileEntries = []; // {path (posix, rel to .coc/), sha256, bytes}
  const subdirs = ["rules", "agents", "skills", "commands"];

  // COC.md
  const counts = {
    rules: records.filter((r) => r.kind === "rules").length,
    agents: records.filter((r) => r.kind === "agents").length,
    skills: records.filter((r) => r.kind === "skills").length,
    commands: records.filter((r) => r.kind === "commands").length,
  };
  const cocMd = buildCocMd(counts);
  writeFileNoBom(path.join(tmpDir, "COC.md"), cocMd);
  fileEntries.push({
    path: "COC.md",
    sha256: sha256Hex(Buffer.from(cocMd, "utf8")),
  });

  // Ensure the four canonical subdirs exist (even when empty).
  for (const d of subdirs) fs.mkdirSync(path.join(tmpDir, d), { recursive: true });

  // Artifact files.
  const usedSubdirs = new Set();
  for (const rec of records) {
    usedSubdirs.add(rec.kind);
    const abs = path.join(tmpDir, rec.relInCoc);
    writeFileNoBom(abs, rec.content);
    fileEntries.push({
      path: rec.relInCoc,
      sha256: sha256Hex(Buffer.from(rec.content, "utf8")),
    });
  }

  // `.gitkeep` zero-byte sentinel in every EMPTY canonical subdir (§9.1; AC).
  for (const d of subdirs) {
    if (usedSubdirs.has(d)) continue;
    const keep = path.join(tmpDir, d, ".gitkeep");
    writeFileNoBom(keep, "");
    fileEntries.push({ path: `${d}/.gitkeep`, sha256: EMPTY_SHA256 });
  }

  // COC.lock — last (covers every other file, excludes itself).
  const lock = buildLock(fileEntries);
  writeFileNoBom(path.join(tmpDir, "COC.lock"), lock);

  return { fileCount: fileEntries.length + 1 /* +COC.lock */, counts };
}

// Atomic-ish dir swap: rename existing `.coc` aside, rename tmp in, rm aside.
// The only window where `.coc` is absent is the sub-ms between the two renames;
// a concurrent reader never sees a PARTIAL tree (it sees old-complete, or
// briefly absent → fallback chain, or new-complete) — satisfies the issue AC.
//
// Symlink hardening (security R1 MED): refuse to operate on a SYMLINKED finalDir.
// `.coc/` is a real directory loom owns (§9.10.3); a symlink there in the
// consumer's tree is either a mistake or a bounded-trust redirect attempt — we
// refuse rather than rename/replace through it. `tmpDir` is created by emitCoc
// via mkdir-or-fail (no recursive), so it is provably a real dir we own; the
// `bak` path is removed with rmSync (which unlinks a symlink itself, never
// follows it). Combined with O_NOFOLLOW on every file write, the swap cannot be
// redirected outside the target tree.
function atomicSwap(finalDir, tmpDir) {
  let st = null;
  try {
    st = fs.lstatSync(finalDir);
  } catch {
    st = null; // ENOENT — no existing tree
  }
  if (st && st.isSymbolicLink()) {
    throw new Error(
      `emit-coc: refusing to replace ${finalDir} — it is a symlink, not a real ` +
        `.coc/ directory (spec §9.10.3; symlink-redirect hardening).`,
    );
  }
  if (st) {
    const bak = `${finalDir}.bak.${process.pid}`;
    fs.rmSync(bak, { recursive: true, force: true });
    fs.renameSync(finalDir, bak);
    try {
      fs.renameSync(tmpDir, finalDir);
    } catch (err) {
      // Roll back: restore the previous tree so we never leave NO `.coc`.
      fs.renameSync(bak, finalDir);
      throw err;
    }
    fs.rmSync(bak, { recursive: true, force: true });
  } else {
    fs.renameSync(tmpDir, finalDir);
  }
}

// ──────────────────────────────────────────────────────────────────
// Orchestration.
// ──────────────────────────────────────────────────────────────────
export function emitCoc({ outDir, target = null, verbose = false }) {
  const exclusions = loadExclusions();
  const loomOnly = loadLoomOnly();
  const tierFilter = buildTierFilter(target); // null when target absent
  const lang = loadTargetVariant(target); // null when target absent / variant unset

  const warnOversize = [];
  const records = collectArtifacts({ exclusions, loomOnly, tierFilter, lang, warnOversize });

  const finalDir = path.join(outDir, ".coc");
  const tmpDir = path.join(outDir, `.coc.tmp.${process.pid}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Create-or-fail (NON-recursive): if an attacker raced a symlink/file into
  // tmpDir between the rm and here, mkdir throws EEXIST and we abort loudly,
  // rather than writing through a redirected directory component (security R1
  // MED — O_NOFOLLOW guards leaves; this guards the tmp-dir root).
  fs.mkdirSync(tmpDir);
  let built;
  try {
    built = buildTree(tmpDir, records);
    atomicSwap(finalDir, tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (verbose) {
    for (const rec of records) console.log(`  ${rec.relInCoc}`);
  }

  return { ...built, records: records.length, warnOversize, finalDir };
}

function parseArgs(argv) {
  const args = { out: null, target: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--target") args.target = argv[++i];
    else if (a === "-v" || a === "--verbose") args.verbose = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    process.stderr.write(
      "usage: emit-coc.mjs --out <dir> [--target py|rs|rb|base|prism] [-v]\n",
    );
    process.exit(2);
  }
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  const r = emitCoc({ outDir, target: args.target, verbose: args.verbose });

  console.log("emit-coc summary:");
  console.log(
    `  artifacts: ${r.records} (rules=${r.counts.rules} agents=${r.counts.agents} ` +
      `skills=${r.counts.skills} commands=${r.counts.commands})`,
  );
  console.log(`  files in .coc/: ${r.fileCount}`);
  console.log(`  coc.version: ${COC_VERSION}`);
  console.log(`  output: ${r.finalDir}`);
  if (r.warnOversize.length > 0) {
    console.log(
      `  WARN: ${r.warnOversize.length} file(s) exceed ${FILE_SIZE_WARN_BYTES}B ` +
        `(60 KiB producer budget; spec-09 imposes no consumer cap — emitted, not truncated):`,
    );
    for (const w of r.warnOversize) {
      console.log(`    ${w.relInCoc} — ${w.bytes}B (over by ${w.bytes - FILE_SIZE_WARN_BYTES}B)`);
    }
  }
}

const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`emit-coc: ${err.stack || err.message}\n`);
    process.exit(1);
  }
}

export {
  deriveId,
  computeAppliesTo,
  buildFrontmatter,
  extractListField,
  extractTypedBlock,
  buildLock,
  buildCocMd,
  buildTree,
  atomicSwap,
  sha256Hex,
  COC_VERSION,
  TYPED_FIELDS,
  FILE_SIZE_WARN_BYTES,
  EMPTY_SHA256,
};
