#!/usr/bin/env node
/**
 * validate-coc-parity.mjs — W4 behavior-parity gate (coc-universal workstream).
 *
 * Proves that loom's NEW distribution path (one CLI-neutral `.coc/` set, translated
 * per-surface at launch by `coc-run`) delivers the SAME coverage and the SAME body
 * content to each CLI surface as the LEGACY per-CLI path (`emit-cli-artifacts.mjs`).
 * This is the safety gate before W5 retires the legacy path: if the `.coc/` path
 * silently dropped an artifact (coverage loss) or carried different body content,
 * retiring legacy emission would lose it. The contract is
 * `workspaces/coc-universal/specs/09b-coc-to-surface-conversion.md` §10.2.
 *
 * SCOPE (the csq boundary). loom owns the `.coc/` FORMAT + the conversion BEHAVIOR;
 * this harness is loom's own SMOKE-TEST half of the W4 gate ("legacy per-CLI emit vs
 * `.coc/`→translate equivalence"). The cross-conformer csq `coc-eval` A/B axis
 * (csq#764 #6) is csq's to own and is NOT exercised here (loom does not author csq
 * code — `rules/repo-scope-discipline.md`). This harness runs entirely against loom's
 * own producers, in-process, no network, no csq.
 *
 * THE TWO CHECKS (run against the real loom artifact tree; `--target` adds a variant):
 *
 *   A. MEMBERSHIP parity — per (surface × kind), the SET of SOURCE artifacts each path
 *      delivers MUST be equal. The legacy set is computed from the SHARED filter
 *      primitives both emitters use (`loom_only` → tier → `cli_emit_exclusions`); the
 *      `.coc/` set is read from a REAL emit-coc emission, filtered by `applies_to`
 *      exactly as `coc-run::filterForSurface` does. A coverage loss (an artifact legacy
 *      delivers that `.coc/` drops) is the #1 retirement risk this check exists to catch.
 *
 *   B. BODY parity — for the body-bearing kinds (commands/skills/agents) on codex+gemini,
 *      the `.coc/` NEUTRAL body plus the deterministic per-CLI path rewrite MUST reproduce
 *      the legacy per-CLI composed body, BYTE FOR BYTE:
 *          rewriteClaudePathsForCli(composeArtifactBody(kind, rel, null, lang).body, S)
 *            === composeArtifactBody(kind, rel, S, lang).body
 *      Both sides flow through the W0-shared core `lib/coc-manifest.mjs::composeArtifactBody`,
 *      so the equality holds iff the ONLY difference between the neutral and per-CLI forms
 *      is the recoverable path rewrite — i.e. no body content is lost in the neutral
 *      representation. (A future CLI-axis BODY overlay on a command/skill/agent would break
 *      the equality and surface here as a NEW gap — correctly.)
 *
 * WHY NOT byte-diff the legacy per-CLI FILES against the `.coc/` files: the two paths
 * RESHAPE by design (legacy reshapes rules into a single rules-reference index, wraps
 * gemini commands as TOML, wraps codex agents as `specialist-` prompts; `.coc/` carries
 * uniform neutral bodies + a strict frontmatter block). The load-bearing parity is
 * coverage (membership) + source-content preservation (body), NOT delivery-shape equality.
 * The legitimate shape differences are enumerated in ACCEPTED_FORMAT_DIFFERENCES and are
 * asserted as coverage-equivalent, never as byte-parity.
 *
 * KNOWN GAPS vs NEW GAPS. A divergence registered in KNOWN_GAPS (a real gap that has been
 * surfaced and carries a pending disposition) is reported loudly as a W5-retirement blocker
 * but is NON-FATAL by default (so the harness stays a green regression gate). An
 * UNREGISTERED divergence is a NEW gap — a regression — and is FATAL (exit 1). `--strict`
 * makes known gaps fatal too (the W5-readiness check: parity FULLY holds only when both are
 * empty).
 *
 * EXIT: 0 when there are no NEW gaps (and, under `--strict`, no known gaps either); 1 otherwise.
 *
 * Usage:
 *   node .claude/bin/validate-coc-parity.mjs [--target py|rs|rb|base|prism] [--strict] [--json]
 *
 * Node ESM, zero external deps. Self-referential surface (matches the `validate-*` stem on
 * the `self-referential-codify.md` Rule-2 Bin allowlist) — edits run the full multi-agent
 * redteam regardless of posture.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { emitCoc, deriveId } from "./emit-coc.mjs";
import { loadCocSet, filterForSurface } from "./coc-run.mjs";
import {
  REPO,
  composeArtifactBody,
  rewriteClaudePathsForCli,
  walkFiles,
  loadExclusions,
  loadLoomOnly,
  buildTierFilter,
  loadTargetVariant,
  matchesAnyGlob,
} from "./lib/coc-manifest.mjs";
// The REAL legacy emitter's hardcoded agent-exclusion constants — imported (NOT copied) so
// legacyDelivers models the TRUE legacy exclusion set (manifest cli_emit_exclusions ∪ these
// constants), making a manifest⟷constant drift visible as a parity divergence rather than
// silently absorbed (W4 redteam R-MED). emit-cli-artifacts is import-safe (its main() runs
// only when invoked as a script); both it and this harness are retired together at W5.
import {
  CODEX_AGENT_STRUCTURAL_EXCLUSIONS,
  GEMINI_AGENT_STRUCTURAL_EXCLUSIONS,
} from "./emit-cli-artifacts.mjs";

// Surface tokens (contract §6 applies_to) + the kinds compared.
const SURFACE_TOKENS = ["claude-code", "codex", "gemini"];
const KINDS = ["rules", "agents", "skills", "commands"];
// Body parity is meaningful only where legacy emits a per-artifact body, on the surfaces
// whose bodies are path-rewritten (cc IS the source — its body is the neutral body verbatim,
// trivially equal; rules are delivered as an index/baseline, not a per-rule body — see
// ACCEPTED_FORMAT_DIFFERENCES).
const BODY_KINDS = ["commands", "skills", "agents"];
const BODY_SURFACES = ["codex", "gemini"];

// The REAL legacy emitter unions these hardcoded agent-exclusion constants with the manifest
// cli_emit_exclusions at agent-emit time (emit-cli-artifacts.mjs). legacyDelivers unions them
// too, so it models the TRUE legacy membership (see legacyDelivers's comment for why a
// manifest-only proxy is structurally blind to a manifest⟷constant drift). Imported from the
// emitter — never copied — so the harness can never silently diverge from the real source.
const LEGACY_STRUCTURAL_AGENT_EXCLUSIONS = {
  codex: CODEX_AGENT_STRUCTURAL_EXCLUSIONS,
  gemini: GEMINI_AGENT_STRUCTURAL_EXCLUSIONS,
};

// ──────────────────────────────────────────────────────────────────
// Accepted format differences — by-design delivery-SHAPE differences that are
// coverage-equivalent. Documented here so the parity report distinguishes a deliberate
// shape difference from a real gap. None of these is a membership divergence (the SOURCE
// set reaching each surface is unchanged); they record WHY the two paths' on-disk shapes
// differ, so a reader never mistakes the shape difference for a coverage loss.
// ──────────────────────────────────────────────────────────────────
const ACCEPTED_FORMAT_DIFFERENCES = [
  {
    id: "rules-index-vs-body",
    kind: "rules",
    surfaces: ["codex", "gemini"],
    reason:
      "Legacy delivers rules to codex/gemini as a rules-reference INDEX (path-scoped rules → " +
      "pointers in one generated skill) plus the always-on baseline rules as bodies in " +
      "AGENTS.md/GEMINI.md; `.coc/` delivers ALL rules as uniform full bodies. Union coverage " +
      "is identical (same source rules reach the surface) — only the delivery shape differs. " +
      "`.coc/` is a fidelity ADD (full bodies vs an index), never a loss.",
    anchor: "emit-cli-artifacts.mjs::emitRulesReferenceSkill + emit.mjs baseline; spec 09b §4 rules rows",
  },
  {
    id: "rules-reference-synthetic-skill",
    kind: "skills",
    surfaces: ["codex", "gemini"],
    reason:
      "Legacy emits a synthetic `rules-reference` skill (a generated index, not a source skill " +
      "on disk under .claude/skills/). It is not a source artifact, so it never appears in this " +
      "harness's source-based membership comparison — by construction, not by suppression.",
    anchor: "emit-cli-artifacts.mjs::emitRulesReferenceSkill (#408 AC#5-b)",
  },
  {
    id: "skill-progressive-disclosure-subfiles",
    kind: "skills",
    surfaces: SURFACE_TOKENS,
    reason:
      "`.coc/` carries each skill's SKILL.md body ONLY (spec 09b §3.2 skill row: the on-demand " +
      "half is the carried SKILL.md body, NOT the sub-files); legacy copies the full " +
      "progressive-disclosure sub-file tree. This is the conscious Level-1 floor (progressive " +
      "disclosure unavailable at L1), a contract scoping decision — not a silent drop. Body " +
      "parity is therefore scoped to the SKILL.md body; sub-file presence is not asserted.",
    anchor: "coc-run.mjs::translateL1 KIND_HEADINGS (skills) + spec 09b §3.2",
  },
  {
    id: "nested-skill-flattening",
    kind: "skills",
    surfaces: SURFACE_TOKENS,
    reason:
      "A NESTED skill (a dir with NO top-level SKILL.md but per-language `<dir>/<sub>/SKILL.md`, " +
      "e.g. 40-stack-onboarding) is delivered by legacy as one dir-tree under `<dir>/`, and by " +
      "`.coc/` as N FLAT skills id `<DIR>-<SUB>` (W4 D3 resolution, co-owner-ratified option a). " +
      "Coverage is identical — every `<dir>/<sub>/SKILL.md` body reaches every surface the " +
      "dir-level decision delivers — so the harness enumerates the per-sub leaves and the cell " +
      "is EQUAL; only the on-disk SHAPE differs (nested dir vs N flat skills), never coverage.",
    anchor: "emit-coc.mjs collectArtifacts (nested-skill branch) + spec 09b §3.2",
  },
  {
    id: "frontmatter-reshape-and-path-rewrite",
    kind: "*",
    surfaces: ["codex", "gemini"],
    reason:
      "`.coc/` emits a strict canonical frontmatter block {id, paths?, applies_to?, typed-superset} " +
      "and a NEUTRAL body; legacy emits native per-CLI frontmatter and a path-rewritten body " +
      "(+ TOML wrap for gemini commands, `specialist-` preamble for codex agents). These are " +
      "delivery-time transforms a conformer re-applies; the body check normalizes the path " +
      "rewrite (the only body-content difference) and asserts byte-equality on the result.",
    anchor: "coc-manifest.mjs::rewriteClaudePathsForCli + emit-coc.mjs::buildFrontmatter/extractTypedBlock",
  },
];

// ──────────────────────────────────────────────────────────────────
// Known gaps — REAL divergences that have been surfaced and carry a pending disposition.
// Reported loudly as W5-retirement blockers; NON-FATAL by default, FATAL under --strict.
// An unregistered divergence is a NEW gap (a regression) and is always fatal.
// ──────────────────────────────────────────────────────────────────
// (Empty.) D3-nested-skill was the sole known gap; RESOLVED 2026-06-19 by co-owner-ratified
// option (a): emit-coc now emits each `<dir>/<sub>/SKILL.md` of a nested skill as a flat
// `.coc/` skill (id `<DIR>-<SUB>`), coverage-preserving, so the membership cell is EQUAL and
// the nested-flattening is a documented accepted format-difference (below) rather than a gap.
const KNOWN_GAPS = [];

// ──────────────────────────────────────────────────────────────────
// Source enumeration — the comparison BASIS. Mirrors how emit-coc.mjs::collectArtifacts +
// emit-cli-artifacts.mjs walk the source tree (same roots, same recursion, same `_*` skip,
// same SKILL.md-dir convention) so neither path can claim a source the other cannot see.
// `loom_only` + tier filtering are applied in the delivery predicates (legacyDelivers /
// cocDelivers), NOT here — so the basis stays the raw on-disk source and the filters are
// applied identically to both sides.
// ──────────────────────────────────────────────────────────────────
function enumerateSources() {
  const out = { rules: [], agents: [], skills: [], commands: [] };

  const rulesDir = path.join(REPO, ".claude", "rules");
  if (fs.existsSync(rulesDir)) {
    for (const name of fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md")).sort()) {
      out.rules.push({ mrel: `rules/${name}`, base: path.basename(name, ".md") });
    }
  }

  const agentsDir = path.join(REPO, ".claude", "agents");
  if (fs.existsSync(agentsDir)) {
    const rels = [];
    for (const { relPath } of walkFiles(agentsDir)) {
      if (!relPath.endsWith(".md")) continue;
      if (path.basename(relPath).startsWith("_")) continue; // _README.md etc. (emit-coc collectArtifacts:408)
      rels.push(relPath.split(path.sep).join("/"));
    }
    for (const rel of rels.sort()) {
      out.agents.push({ mrel: `agents/${rel}`, base: path.basename(rel, ".md") });
    }
  }

  const skillsDir = path.join(REPO, ".claude", "skills");
  if (fs.existsSync(skillsDir)) {
    const dirs = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const dir of dirs) {
      // Enumerate skill UNITS as delivered leaves. A dir with a top-level SKILL.md is ONE
      // flat unit `<dir>`; a NESTED dir (no top-level SKILL.md but per-language
      // `<dir>/<sub>/SKILL.md`) is N units `<dir>-<sub>` (the W4 D3 resolution — emit-coc
      // emits each as a flat skill). BOTH sides' delivery decision is the dir-level path
      // `skills/<dir>/SKILL.md` (legacy emitSkills decides per dir; emit-coc mirrors it), so
      // `mrel` is the dir-level path for every unit; `base` carries the coc-id stem and
      // `leafRel` the body path. This keeps membership byte-aligned with legacy.
      const dirMrel = `skills/${dir}/SKILL.md`;
      if (fs.existsSync(path.join(skillsDir, dir, "SKILL.md"))) {
        out.skills.push({ mrel: dirMrel, base: dir, dir, leafRel: `${dir}/SKILL.md` });
      } else {
        const subs = fs
          .readdirSync(path.join(skillsDir, dir), { withFileTypes: true })
          .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, dir, d.name, "SKILL.md")))
          .map((d) => d.name)
          .sort();
        for (const sub of subs) {
          out.skills.push({ mrel: dirMrel, base: `${dir}-${sub}`, dir, sub, leafRel: `${dir}/${sub}/SKILL.md` });
        }
      }
    }
  }

  const commandsDir = path.join(REPO, ".claude", "commands");
  if (fs.existsSync(commandsDir)) {
    const rels = [];
    for (const { relPath } of walkFiles(commandsDir)) {
      if (!relPath.endsWith(".md")) continue;
      rels.push(relPath.split(path.sep).join("/"));
    }
    for (const rel of rels.sort()) {
      out.commands.push({ mrel: `commands/${rel}`, base: path.basename(rel, ".md") });
    }
  }

  return out;
}

// ──────────────────────────────────────────────────────────────────
// Delivery predicates.
// ──────────────────────────────────────────────────────────────────
// legacyDelivers: does the LEGACY per-CLI path (emit-cli-artifacts + the cc source) deliver
// this source artifact to `surface`? cc IS the source tree (no per-CLI emit, no exclusions —
// emit-cli-artifacts emits only codex/gemini), so cc gets everything that survives
// loom_only + tier. codex/gemini subtract the TRUE legacy exclusion set: the manifest
// cli_emit_exclusions[surface] UNIONED with the emitter's hardcoded *_STRUCTURAL_EXCLUSIONS
// (emit-cli-artifacts unions both at agent-emit time — emit-cli-artifacts.mjs agent loops).
// Unioning the ACTUAL constants (LEGACY_STRUCTURAL_AGENT_EXCLUSIONS) — rather than trusting
// the manifest as a proxy — is what makes this predicate FAITHFUL to legacy: the W4 D1/D2 fix
// synced the 4 authoring-agent exclusions into the manifest, but the constants stay live until
// W5, so a future manifest⟷constant drift (a manifest exclusion dropped while the constant
// keeps it) would otherwise be INVISIBLE (both compared sides manifest-sourced). With the
// union, such a drift surfaces as a coverage divergence (the harness's TRUE-legacy excludes
// it, but `.coc/`'s manifest-derived applies_to over-delivers it → a NEW gap). The constants
// also carry `agents/management/**` + `agents/_README.md` — each already excluded on both
// sides by its OWN mechanism: `management/**` via loom_only (in legacyDelivers below + in
// emit-coc's emit), and `_README.md` via the `_*` source-enum skip (enumerateSources, which
// drops basenames starting with `_`). So unioning the constants changes nothing today and
// only adds the drift tripwire.
function legacyDelivers(surface, mrel, { loomOnly, tierFilter, exclusions }) {
  if (loomOnly.length && matchesAnyGlob(mrel, loomOnly)) return false;
  if (tierFilter && !matchesAnyGlob(mrel, tierFilter)) return false;
  if (surface === "claude-code") return true; // cc IS the source; no cc-side emit exclusions
  const trueLegacyExclusions = [
    ...(exclusions[surface] || []),
    ...(LEGACY_STRUCTURAL_AGENT_EXCLUSIONS[surface] || []),
  ];
  return !matchesAnyGlob(mrel, trueLegacyExclusions);
}

// cocDelivers: does the `.coc/`→translate path deliver this source artifact to `surface`?
// A record exists in the REAL emit-coc emission ONLY if it survived loom_only + tier; for
// skills, a flat dir emits id `<DIR>` and a NESTED dir (no top-level SKILL.md) emits one flat
// record per `<dir>/<sub>/SKILL.md` (id `<DIR>-<SUB>`, the D3 resolution), so `base` carries
// the per-unit id stem. filterForSurface then applies the applies_to filter exactly as coc-run
// does at launch. So loom_only/tier are reflected automatically (no record → not delivered).
function cocDelivers(surface, kind, base, cocById) {
  const id = deriveId(kind, base);
  const rec = cocById[kind].get(id);
  if (!rec) return false;
  return filterForSurface([rec], surface).length > 0;
}

// ──────────────────────────────────────────────────────────────────
// Membership comparison.
// ──────────────────────────────────────────────────────────────────
function computeMembership({ sources, cocById, loomOnly, tierFilter, exclusions }) {
  const cells = [];
  for (const surface of SURFACE_TOKENS) {
    for (const kind of KINDS) {
      const legacy = new Set();
      const coc = new Set();
      for (const s of sources[kind]) {
        // The Set key MUST be unique per delivered UNIT. For nested-skill leaves the `mrel`
        // is the shared DIR-level path (used for the legacy filter decision), so keying on it
        // would collapse the N leaves into one entry — a dropped leaf would then read EQUAL
        // (false green). Key on the per-unit leaf path instead (`skills/<dir>[/<sub>]/SKILL.md`),
        // so every language is a distinct membership entry; flat kinds key on the unique mrel.
        const unitKey = s.leafRel ? `skills/${s.leafRel}` : s.mrel;
        if (legacyDelivers(surface, s.mrel, { loomOnly, tierFilter, exclusions })) legacy.add(unitKey);
        if (cocDelivers(surface, kind, s.base, cocById)) coc.add(unitKey);
      }
      const legacyOnly = [...legacy].filter((m) => !coc.has(m)).sort();
      const cocOnly = [...coc].filter((m) => !legacy.has(m)).sort();
      cells.push({ surface, kind, legacyCount: legacy.size, cocCount: coc.size, legacyOnly, cocOnly });
    }
  }
  return cells;
}

// Classify a single divergent member (legacy-only OR coc-only) against the known-gap registry.
// Returns { kind: "known", gap } | { kind: "new" }. Accepted format-differences are handled at
// the membership level (they never produce a member divergence — they are shape, not coverage),
// so a member divergence is either a registered known gap or a regression.
function classifyMember(kind, surface, member) {
  for (const g of KNOWN_GAPS) {
    if (g.kind === kind && g.surfaces.includes(surface) && g.member === member) {
      return { kind: "known", gap: g };
    }
  }
  return { kind: "new" };
}

// ──────────────────────────────────────────────────────────────────
// Body comparison (shared-core formulation).
//   rewrite(composeArtifactBody(kind, rel, null, lang).body, S) === composeArtifactBody(kind, rel, S, lang).body
// for every body-bearing source artifact reaching surface S. Equality holds iff the only
// neutral-vs-per-CLI body difference is the recoverable path rewrite (no content lost).
// ──────────────────────────────────────────────────────────────────
function relForCompose(kind, source) {
  // composeArtifactBody takes the category-relative path. For skills the body is the SKILL.md
  // entry point — `leafRel` is `<dir>/SKILL.md` for a flat skill OR `<dir>/<sub>/SKILL.md` for
  // a nested unit. For the other kinds, the manifestRel minus the "<kind>/" prefix.
  if (kind === "skills") return source.leafRel;
  return source.mrel.slice(kind.length + 1); // strip "rules/"|"agents/"|"commands/"
}

function computeBodyParity({ sources, lang, loomOnly, tierFilter, exclusions }) {
  const cells = [];
  const mismatches = [];
  for (const surface of BODY_SURFACES) {
    for (const kind of BODY_KINDS) {
      let pass = 0;
      let total = 0;
      let skipped = 0;
      for (const s of sources[kind]) {
        if (!legacyDelivers(surface, s.mrel, { loomOnly, tierFilter, exclusions })) continue;
        const rel = relForCompose(kind, s);
        const neutral = composeArtifactBody(kind, rel, null, lang);
        const legacy = composeArtifactBody(kind, rel, surface, lang);
        if (neutral === null || legacy === null) {
          // Defensive: a source whose SKILL.md/body composes null is skipped (a membership
          // concern surfaced by computeMembership, not a body one). Post-D3 the nested-skill
          // leaves DO compose a real body (via leafRel) and are counted — this branch is dead
          // for current data; it stays as a guard against a future genuinely body-less source.
          skipped++;
          continue;
        }
        total++;
        const expected = rewriteClaudePathsForCli(neutral.body, surface);
        if (expected === legacy.body) pass++;
        else mismatches.push({ surface, kind, mrel: s.mrel, lenDelta: expected.length - legacy.body.length });
      }
      cells.push({ surface, kind, pass, total, skipped });
    }
  }
  return { cells, mismatches };
}

// ──────────────────────────────────────────────────────────────────
// Orchestration — emit a REAL `.coc/` set, load it via the real consumer, compare.
// ──────────────────────────────────────────────────────────────────
function runParity({ target = null } = {}) {
  const exclusions = loadExclusions();
  const loomOnly = loadLoomOnly();
  const tierFilter = buildTierFilter(target); // null when target absent (emit-everything)
  const lang = loadTargetVariant(target); // null when target absent / variant unset
  const sources = enumerateSources();

  // Emit a REAL `.coc/` set to an out-of-repo tmp dir and load it via coc-run's loadCocSet
  // (the real producer + the real consumer path), then reclaim the tmp tree.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coc-parity-"));
  let records;
  try {
    emitCoc({ outDir: tmpRoot, target, verbose: false });
    ({ records } = loadCocSet(path.join(tmpRoot, ".coc")));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const cocById = { rules: new Map(), agents: new Map(), skills: new Map(), commands: new Map() };
  for (const r of records) cocById[r.kind].set(r.id, r);

  const membership = computeMembership({ sources, cocById, loomOnly, tierFilter, exclusions });
  const body = computeBodyParity({ sources, lang, loomOnly, tierFilter, exclusions });

  // Partition every membership divergence into known vs new gaps.
  const knownGaps = [];
  const newGaps = [];
  for (const cell of membership) {
    for (const member of cell.legacyOnly) {
      const c = classifyMember(cell.kind, cell.surface, member);
      const row = { surface: cell.surface, kind: cell.kind, member, direction: "legacy-only (coverage LOSS)" };
      if (c.kind === "known") knownGaps.push({ ...row, gapId: c.gap.id });
      else newGaps.push(row);
    }
    for (const member of cell.cocOnly) {
      const c = classifyMember(cell.kind, cell.surface, member);
      const row = { surface: cell.surface, kind: cell.kind, member, direction: "coc-only (coverage ADD)" };
      if (c.kind === "known") knownGaps.push({ ...row, gapId: c.gap.id });
      else newGaps.push(row);
    }
  }
  // Body mismatches are always NEW gaps — there is no by-design CLI-axis body overlay on a
  // command/skill/agent today; any mismatch is an unexpected content divergence.
  for (const m of body.mismatches) {
    newGaps.push({ surface: m.surface, kind: m.kind, member: m.mrel, direction: `body mismatch (lenΔ ${m.lenDelta})` });
  }

  return { target, lang, membership, body, knownGaps, newGaps };
}

// ──────────────────────────────────────────────────────────────────
// Reporting.
// ──────────────────────────────────────────────────────────────────
function membershipVerdict(cell, knownGaps) {
  if (cell.legacyOnly.length === 0 && cell.cocOnly.length === 0) return "EQUAL";
  const all = [...cell.legacyOnly, ...cell.cocOnly];
  const allKnown = all.every((m) =>
    knownGaps.some((g) => g.surface === cell.surface && g.kind === cell.kind && g.member === m),
  );
  return allKnown ? "KNOWN-GAP" : "NEW-GAP";
}

function formatReport(result, { strict = false } = {}) {
  const lines = [];
  const scope = result.target ? `--target ${result.target} (variant=${result.lang || "none"})` : "emit-everything (no --target)";
  lines.push(`COC parity gate — ${scope}`);
  lines.push("");
  lines.push("A. Membership parity (source-artifact SET per surface × kind)");
  lines.push("   surface       kind      legacy  coc   verdict");
  lines.push("   ------------- --------- ------  ----  -------");
  for (const cell of result.membership) {
    const v = membershipVerdict(cell, result.knownGaps);
    lines.push(
      `   ${cell.surface.padEnd(13)} ${cell.kind.padEnd(9)} ${String(cell.legacyCount).padStart(6)}  ${String(cell.cocCount).padStart(4)}  ${v}`,
    );
  }
  lines.push("");
  lines.push("B. Body parity (rewrite(neutral) === legacy-composed, byte-for-byte)");
  lines.push("   surface  kind       pass/total  (skipped)");
  lines.push("   -------  ---------  ----------  ---------");
  for (const cell of result.body.cells) {
    const flag = cell.pass === cell.total ? "✓" : "✗";
    lines.push(
      `   ${cell.surface.padEnd(7)} ${cell.kind.padEnd(9)} ${flag} ${String(cell.pass).padStart(4)}/${String(cell.total).padEnd(4)}  ${cell.skipped ? `(${cell.skipped} nested/absent)` : ""}`,
    );
  }
  lines.push("");

  if (result.knownGaps.length) {
    lines.push(`⚠ KNOWN GAPS (${result.knownGaps.length}) — surfaced, NON-FATAL by default; BLOCK W5 retirement until resolved:`);
    for (const g of result.knownGaps) {
      const def = KNOWN_GAPS.find((k) => k.id === g.gapId);
      lines.push(`   [${g.gapId}] ${g.surface}/${g.kind}: ${g.member} — ${g.direction}`);
      if (def) lines.push(`        disposition: ${def.disposition}`);
    }
    lines.push("");
  }

  if (result.newGaps.length) {
    lines.push(`✗ NEW GAPS (${result.newGaps.length}) — UNEXPECTED divergence (regression); FATAL:`);
    for (const g of result.newGaps) {
      lines.push(`   ${g.surface}/${g.kind}: ${g.member} — ${g.direction}`);
    }
    lines.push("");
  }

  const accepted = ACCEPTED_FORMAT_DIFFERENCES.map((d) => d.id).join(", ");
  lines.push(`Accepted by-design format differences (coverage-equivalent, not asserted as byte-parity): ${accepted}`);
  lines.push("");

  const bodyOk = result.body.cells.every((c) => c.pass === c.total);
  if (result.newGaps.length > 0) {
    // NEW gaps are always fatal (a regression), strict or not.
    lines.push(`VERDICT: FAIL — ${result.newGaps.length} NEW gap(s) (regression). Parity broken; investigate before any retirement.`);
  } else if (result.knownGaps.length === 0) {
    lines.push("VERDICT: PARITY HOLDS — `.coc/`→translate is coverage- and body-equivalent to legacy per-CLI emit. W5 retirement unblocked.");
  } else if (strict) {
    // --strict is active AND known gaps remain → the W5-readiness gate FAILS (exit 1). Do NOT
    // tell the reader to "run with --strict" — they already did; name the W5 blocker instead.
    lines.push(`VERDICT: FAIL (--strict / W5-readiness) — ${result.knownGaps.length} known gap(s) still BLOCK W5 retirement; resolve them, or drop --strict for the regression-only gate (which passes: no new divergence).`);
  } else {
    // Default (regression) gate: no new divergence → green, with the known gaps listed as W5 blockers.
    lines.push(`VERDICT: NO REGRESSION (body ${bodyOk ? "✓" : "✗"}) — ${result.knownGaps.length} known gap(s) remain; W5 retirement BLOCKED until they are resolved (run with --strict to gate on them).`);
  }
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────
// CLI entry.
// ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { target: null, strict: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") args.target = argv[++i];
    else if (a === "--strict") args.strict = true;
    else if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else {
      process.stderr.write(`validate-coc-parity: unknown argument '${a}'\n`);
      args.bad = true;
    }
  }
  return args;
}

const USAGE = "usage: validate-coc-parity.mjs [--target py|rs|rb|base|prism] [--strict] [--json]";

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.bad) {
    process.stderr.write(USAGE + "\n");
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(USAGE + "\n");
    process.exit(0);
  }
  const result = runParity({ target: args.target });
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatReport(result, { strict: args.strict }) + "\n");
  }
  // Exit policy: NEW gaps are always fatal (regression). Known gaps are fatal only under
  // --strict (the W5-readiness gate); otherwise the harness stays green as a regression gate
  // while listing the known gaps as W5 blockers.
  const fatal = result.newGaps.length > 0 || (args.strict && result.knownGaps.length > 0);
  process.exit(fatal ? 1 : 0);
}

const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file://${fs.realpathSync(process.argv[1] || "")}`;
if (invokedAsScript) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`validate-coc-parity: ${err.stack || err.message}\n`);
    process.exit(1);
  }
}

export {
  enumerateSources,
  legacyDelivers,
  cocDelivers,
  computeMembership,
  classifyMember,
  computeBodyParity,
  relForCompose,
  runParity,
  membershipVerdict,
  formatReport,
  parseArgs,
  ACCEPTED_FORMAT_DIFFERENCES,
  KNOWN_GAPS,
  SURFACE_TOKENS,
  KINDS,
  BODY_KINDS,
  BODY_SURFACES,
};
