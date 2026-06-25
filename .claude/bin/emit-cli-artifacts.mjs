#!/usr/bin/env node
/*
 * Multi-CLI artifact emitter — commands + skills + gemini agents.
 *
 * Peer to .claude/bin/emit.mjs (which emits the per-CLI baseline:
 * AGENTS.md + GEMINI.md + codex-mcp-guard/policies.json). This driver
 * fills the remaining surface that coc-sync Step 6.6 needs to populate
 * in Codex-aware + Gemini-aware USE templates — the driving tool layer
 * that makes /analyze, /todos, /implement, etc. reachable from those
 * CLIs plus the subagent registry Gemini needs for @specialist.
 *
 * Output layout (with --out <dir>):
 *
 *   <dir>/codex/
 *     prompts/<cmd>.md                    one per non-excluded .claude/commands/<cmd>.md
 *     prompts/specialist-<name>.md        per non-excluded .claude/agents (recursive).
 *                                         Operating-spec content surface; inlined into
 *                                         the agent context via inline-cat injection
 *                                         `"$(cat .codex/prompts/specialist-<name>.md)"`.
 *                                         See `bin/coc` dispatcher + bin/README.md for
 *                                         the canonical Codex invocation path (F79).
 *     skills/<nn-name>/SKILL.md  per non-excluded .claude/skills/<nn-name>/SKILL.md
 *
 *   <dir>/gemini/
 *     commands/<cmd>.toml     one per non-excluded command (TOML per Gemini spec)
 *     skills/<nn-name>/SKILL.md
 *     agents/<name>.md        per non-excluded specialist (CC → Gemini frontmatter)
 *
 * Exclusions: reads .claude/sync-manifest.yaml → cli_emit_exclusions.{codex,gemini}
 * and honors those globs at source-tree scan time.
 *
 * Deferred (NOT emitted here):
 *   - .codex/prompts/ frontmatter is kept from the source .md; Codex CLI
 *     reads it as-is via /prompts:<name>.
 *   - .codex-mcp-guard/server.js POLICIES_POPULATED flip is NOT done here.
 *     Flipping the flag without wiring real predicate FUNCTIONS into POLICIES
 *     would convert the fail-closed guard (zero-tolerance Rule 2) into a
 *     fail-open no-op. Full runtime predicate wiring is a later phase.
 *     emit.mjs writes policies.json metadata alongside server.js; the live
 *     flip waits until server.js can `require(./policies.js)` and map each
 *     entry to a callable predicate.
 *   - .codex/hooks.json + .gemini/settings.json are copied by coc-sync
 *     directly from codex-templates/ + gemini-templates/ (Step 6.6).
 *
 * Usage:
 *   node .claude/bin/emit-cli-artifacts.mjs --out /tmp/cli-emit-$$
 *   node .claude/bin/emit-cli-artifacts.mjs --out ./tmp/emit --verbose
 *   node .claude/bin/emit-cli-artifacts.mjs --cli codex --out ./tmp   (codex only)
 *   node .claude/bin/emit-cli-artifacts.mjs --cli gemini --out ./tmp  (gemini only)
 *   node .claude/bin/emit-cli-artifacts.mjs --target py --out ./tmp   (filter by repos.py.tier_subscriptions)
 *
 * --target <name> filters emission to files matched by the union of glob
 * patterns under tiers.<tier> for each tier in repos.<name>.tier_subscriptions.
 * Required when emitting for a USE template — emitting WITHOUT a target ships
 * every artifact on disk (e.g., onboarding-tier files leak into [cc,co,coc]
 * py/rs/rb targets). Per sync-flow.md § Gate 2 → Process step 3 (loom: /sync-to-use), missing/empty
 * tier_subscriptions is a manifest defect that MUST halt the sync.
 *
 * Exit codes: 0 = success, 1 = emission failure, 2 = usage error.
 */

import fs from "node:fs";
import path from "node:path";

// W0 (coc-universal): the neutral manifest-loader + variant-compose layer
// moved to lib/coc-manifest.mjs so emit-coc.mjs no longer imports from this
// file. Imported back here (+ re-exported below) so this module's public API
// and every internal caller stay unchanged — byte-identical emit.
import {
  REPO,
  safeWriteFileSync,
  safeReadFileSync,
  matchesAnyGlob,
  loadExclusions,
  loadLoomOnly,
  loadTiers,
  loadTargetTierSubscriptions,
  loadTargetVariant,
  loadTargetRole,
  loadSurfaceRoles,
  surfaceRolesAllow,
  buildTierFilter,
  composeArtifactBody,
  walkFiles,
} from "./lib/coc-manifest.mjs";
// #408 AC#5-b: the rules-reference emitter resolves each rule's non-CC lane via
// the SHARED cli_delivery parser (also used by emit.mjs::validateCliDelivery /
// Validator 18). Single source of truth — a divergent mirror was the R1 finding
// the AC#5-a redteam closed.
import { checkRuleCliDelivery } from "./lib/cli-delivery.mjs";

// ────────────────────────────────────────────────────────────────
// YAML frontmatter parser (minimal — handles the subset used here)
// ────────────────────────────────────────────────────────────────
// Supports:
//   key: value
//   key: "quoted value"
//   key: value1, value2, value3        (inline comma list)
//   (no nested mappings, no block scalars, no anchors)
function parseFrontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: source };

  const fmRaw = match[1];
  const body = match[2];
  const fm = {};

  for (const line of fmRaw.split("\n")) {
    const m = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    // Strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }

  return { frontmatter: fm, body };
}

// ────────────────────────────────────────────────────────────────
// Commands → per-CLI prompt files
// ────────────────────────────────────────────────────────────────
// Default Gemini tool allowlist for slash commands. Commands drive phase
// work (read workspace, write plans, run shell); the allowlist matches
// what the CC command equivalents need. web_fetch intentionally omitted
// — slash commands should not exfiltrate repo state.
const GEMINI_DEFAULT_COMMAND_TOOLS = [
  "read_file",
  "glob",
  "grep_search",
  "list_directory",
  "run_shell_command",
  "write_file",
];

function tomlLiteralEscape(body) {
  // We use TOML literal triple-quoted strings ('''...''') for prompt
  // bodies. Literal strings preserve everything verbatim — no escape
  // processing — which is what we need for shell regex patterns,
  // backslashes in code samples, and embedded double-quotes. The only
  // collision is an embedded triple-single-quote. We break those by
  // concatenating a single-quote literal string with the rest so the
  // TOML parser sees a valid expression; prompt bodies effectively
  // never contain ''' so this branch is cold but safe.
  if (!body.includes("'''")) return body;
  return body.replace(/'''/g, "''′'"); // U+2032 ′ — visually near but not a quote
}

function emitCommands({ outDir, exclusions, tierFilter, loomOnly, surfaceRoles, targetRole, lang, verbose }) {
  const srcDir = path.join(REPO, ".claude", "commands");
  if (!fs.existsSync(srcDir)) {
    return { codex: 0, gemini: 0, skipped: 0 };
  }

  const stats = { codex: 0, gemini: 0, skipped: 0 };

  for (const { absPath, relPath } of walkFiles(srcDir)) {
    if (!relPath.endsWith(".md")) continue;
    const manifestRel = `commands/${relPath}`;
    const name = path.basename(relPath, ".md");

    // F104 loom-only filter: positive never-sync declaration. Skip for
    // EVERY target, BEFORE tier classification.
    if (loomOnly && matchesAnyGlob(manifestRel, loomOnly)) {
      stats.skipped++;
      continue;
    }

    // W3-d surface_roles filter (deferred W2-c tail): positive per-artifact
    // role restriction. Skip when the TARGET's role is not in the artifact's
    // declared surface_roles. Default-surfaced (no entry) OR null targetRole
    // (py/rs, no --target) → keep (back-compat). Sibling of loom_only, BEFORE tiers.
    if (!surfaceRolesAllow(surfaceRoles, manifestRel, targetRole)) {
      stats.skipped++;
      continue;
    }

    // Tier-subscription filter: skip files not matched by any subscribed tier.
    // tierFilter is null when --target is absent (legacy emit-everything mode).
    if (tierFilter && !matchesAnyGlob(manifestRel, tierFilter)) {
      stats.skipped++;
      continue;
    }

    // Codex — same .md, Codex reads frontmatter natively via /prompts:<name>.
    // Apply variant overlays per (lang, codex) 3-axis stack so codex/prompts
    // matches the same composed content CC sees in .claude/commands/.
    if (!matchesAnyGlob(manifestRel, exclusions.codex)) {
      const codexResult = composeArtifactBody("commands", relPath, "codex", lang);
      const { body: codexBody, destRelPath: codexDest } = codexResult;
      const { frontmatter: cFm, body: cBody } = parseFrontmatter(codexBody);
      const codexName = path.basename(codexDest, ".md");
      const cDesc = cFm.description || `Loom command: ${codexName}`;
      const cTrimmed = cBody.replace(/^\n+/, "").replace(/\n+$/, "\n");
      const codexPath = path.join(outDir, "codex", "prompts", `${codexName}.md`);
      const codexContent = `---\nname: ${codexName}\ndescription: "${cDesc}"\n---\n\n${cTrimmed}`;
      safeWriteFileSync(codexPath, codexContent);
      stats.codex++;
      if (verbose) console.log(`  codex   prompts/${codexName}.md`);
    } else {
      stats.skipped++;
    }

    // Gemini — TOML. Body becomes the prompt string. Apply (lang, gemini)
    // overlays.
    if (!matchesAnyGlob(manifestRel, exclusions.gemini)) {
      const geminiResult = composeArtifactBody("commands", relPath, "gemini", lang);
      const { body: geminiBody, destRelPath: geminiDest } = geminiResult;
      const { frontmatter: gFm, body: gBody } = parseFrontmatter(geminiBody);
      const geminiName = path.basename(geminiDest, ".md");
      const gDesc = gFm.description || `Loom command: ${geminiName}`;
      const gTrimmed = gBody.replace(/^\n+/, "").replace(/\n+$/, "\n");
      const geminiPath = path.join(outDir, "gemini", "commands", `${geminiName}.toml`);
      const toolsLine = GEMINI_DEFAULT_COMMAND_TOOLS
        .map((t) => `"${t}"`)
        .join(", ");
      const tomlContent = [
        `name = "${geminiName}"`,
        `description = "${gDesc.replace(/"/g, '\\"')}"`,
        `prompt = '''`,
        tomlLiteralEscape(gTrimmed).replace(/\n+$/, ""),
        `'''`,
        `tools = [${toolsLine}]`,
        "",
      ].join("\n");
      safeWriteFileSync(geminiPath, tomlContent);
      stats.gemini++;
      if (verbose) console.log(`  gemini  commands/${geminiName}.toml`);
    }
  }

  return stats;
}

// ────────────────────────────────────────────────────────────────
// Skills → per-CLI progressive-disclosure SKILL.md copies
// ────────────────────────────────────────────────────────────────
// Gemini + Codex both consume SKILL.md as the entry point; sub-files
// live under the skill dir and are loaded on demand. We copy the WHOLE
// skill directory (not just SKILL.md) so the sub-file references in
// SKILL.md resolve when the CLI reads them.
function emitSkills({ outDir, exclusions, tierFilter, loomOnly, surfaceRoles, targetRole, lang, verbose }) {
  const srcDir = path.join(REPO, ".claude", "skills");
  if (!fs.existsSync(srcDir)) return { codex: 0, gemini: 0, skipped: 0 };

  const stats = { codex: 0, gemini: 0, skipped: 0 };
  const skillDirs = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const skill of skillDirs) {
    const manifestRel = `skills/${skill}/SKILL.md`;
    const skillSrc = path.join(srcDir, skill);

    // F104 loom-only filter: positive never-sync declaration. A skill dir
    // matching a loom_only prefix glob (skills/<n>/** or skills/<n>/SKILL.md)
    // is skipped for both CLIs, BEFORE tier classification.
    if (loomOnly && matchesAnyGlob(manifestRel, loomOnly)) {
      stats.skipped += 2; // skipped for both CLIs
      continue;
    }

    // W3-d surface_roles filter (deferred W2-c tail): sibling of loom_only.
    if (!surfaceRolesAllow(surfaceRoles, manifestRel, targetRole)) {
      stats.skipped += 2; // skipped for both CLIs
      continue;
    }

    // Tier-subscription filter: skill tier patterns are usually
    // `skills/NN-name/**` (prefix globs). Match the SKILL.md path against
    // the tier filter — same convention as exclusions matching above.
    // tierFilter null = legacy emit-everything mode.
    if (tierFilter && !matchesAnyGlob(manifestRel, tierFilter)) {
      stats.skipped += 2; // skipped for both CLIs
      continue;
    }

    for (const cli of ["codex", "gemini"]) {
      // Skills use prefix globs (skills/NN-name/**); match against any
      // file under the skill dir to decide inclusion.
      const skillGlob = `skills/${skill}/SKILL.md`;
      if (matchesAnyGlob(skillGlob, exclusions[cli])) {
        stats.skipped++;
        continue;
      }
      const skillOut = path.join(outDir, cli, "skills", skill);
      // Per-file emission with variant-overlay composition for every
      // file under the skill dir (SKILL.md and sub-files). Replaces a
      // bare copyDirRecursive: the previous behavior copied global
      // files verbatim, leaving variant overlays unapplied for codex/
      // gemini emissions (variant-overlay drift root cause).
      emitSkillTreeWithOverlays({
        skillName: skill,
        skillSrc,
        skillOut,
        cli,
        lang,
      });
      stats[cli]++;
      if (verbose) console.log(`  ${cli.padEnd(7)} skills/${skill}/`);
    }
  }

  return stats;
}

// Walk the skill tree; for each file, compose with variant overlays
// (lang, cli, lang-cli ternary) and write to skillOut. Files that have
// no variant overlay anywhere fall through to a verbatim copy.
function emitSkillTreeWithOverlays({ skillName, skillSrc, skillOut, cli, lang }) {
  fs.mkdirSync(skillOut, { recursive: true });
  for (const { absPath, relPath } of walkFiles(skillSrc)) {
    // For markdown files, apply variant-overlay composition. Non-md
    // files (e.g., images, fixtures) are copied byte-for-byte — they
    // never have variant overlays.
    if (relPath.endsWith(".md")) {
      const category = "skills";
      const skillRelPath = path.posix.join(skillName, relPath);
      const result = composeArtifactBody(category, skillRelPath, cli, lang);
      if (result !== null) {
        // Destination path follows manifest rename when present:
        // skills/<skill>/<rename>.md instead of skills/<skill>/<orig>.md.
        // Strip the leading "<skill>/" so the path is relative to skillOut.
        const destBelowSkill = result.destRelPath.startsWith(`${skillName}/`)
          ? result.destRelPath.slice(skillName.length + 1)
          : result.destRelPath;
        const outFile = path.join(skillOut, destBelowSkill);
        // #408 AC#4: translate CC tool-name frontmatter per-CLI (gemini
        // native names / codex strip) so CC-isms (Read/Glob/Grep) do not
        // leak verbatim into the skills lane. Body untouched.
        const outBody = translateSkillFrontmatterTools(result.body, cli);
        safeWriteFileSync(outFile, outBody);
        continue;
      }
    }
    // Fallback: byte copy (destination keeps original relPath).
    const outFile = path.join(skillOut, relPath);
    const data = safeReadFileSync(absPath);
    safeWriteFileSync(outFile, data);
  }
}

// ────────────────────────────────────────────────────────────────
// Rules-reference skill — #408 AC#5-b on-demand skill-channel delivery
// ────────────────────────────────────────────────────────────────
// Claude Code auto-loads each path-scoped rule when the operator edits a file
// matching the rule's `paths:` globs. Codex and Gemini have NO such path-glob
// loader, so before this skill those rules were undeliverable on the non-CC
// lanes (surfaced by Validator 18 as the `skill-channel [pending AC#5-b]`
// backlog — visible, never silent). This emitter closes that gap.
//
// DESIGN — index, NOT body-copy. The canonical rule bodies live at the SHARED
// `.claude/rules/<name>.md` (consumed identically by all three CLIs — rules are
// NOT rewritten to a per-CLI path; see rewriteClaudePathsForCli). So this skill
// is a generated INDEX: a table mapping each skill-channel rule to its `paths:`
// globs (the "when does this apply" signal CC gets from the glob loader) and a
// pointer to the canonical `.claude/rules/<name>.md` to read on demand. This is
// single-source-of-truth (zero body duplication → zero drift), budget-neutral on
// the always-on AGENTS.md/GEMINI.md file AND on the skill listing (ONE entry).
//
// The skill-channel rule SET is resolved through the SHARED checkRuleCliDelivery
// (the same parser Validator 18 uses), so the index provably contains exactly the
// rules the validator reports as `skill-channel`. `cli_delivery` is a global/
// neutral field, so the set is lane-identical (Validator 18 fails the emit on any
// asymmetric exclusion before this runs) — the index is built once and emitted to
// both lanes. tier/loomOnly/exclusion filters are applied so a --target emit only
// indexes rules that target actually receives.
const RULES_REFERENCE_SKILL = "rules-reference";
const RULES_REFERENCE_DESCRIPTION =
  "Path-scoped project rules index for Codex/Gemini (no path-glob loader): find " +
  "which rule governs the file you are editing, then read the cited .claude/rules/<name>.md.";

// Extract the `paths:` YAML list from a rule frontmatter body. Returns string[]
// (the globs, unquoted). The flat parseFrontmatter cannot read list values, so
// this is a focused list-scanner handling BOTH YAML list forms a rule may use:
//   - block form:  `paths:` then indented `  - "glob"` lines
//   - inline form: `paths: ["a", "b"]`  (3 corpus rules use this — e.g.
//                  multi-operator-coordination / user-flow-validation carry the
//                  broadest `**/*` glob inline; missing it mislabels them as
//                  "no path globs", the exact R1 reviewer/analyst MED/HIGH).
// Both list forms are parsed through QUOTE-AWARE primitives (not regex token
// matching). R2 surfaced that a regex split is position-dependent (a brace-glob
// `"**/*.{py,rs}"` only survived as the FIRST element) and that a greedy
// `\[(.*)\]` over-captures a trailing comment containing `]`. The scan-based
// helpers below close both classes: comment-strip and comma-split both respect
// quote state, so they are correct regardless of element position or comment
// content.

// Strip a trailing ` #…` comment that sits OUTSIDE single/double quotes. A `#`
// inside a quoted glob (e.g. `"a#b"`) is preserved; a whitespace-preceded `#`
// outside quotes (a YAML comment) and everything after it is removed.
function stripOutsideQuoteComment(line) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD && i > 0 && /\s/.test(line[i - 1])) {
      return line.slice(0, i);
    }
  }
  return line;
}

// Split a flow-list body on commas that are OUTSIDE quotes, so a brace-glob's
// internal comma is preserved no matter where the element sits in the list.
function splitFlowListOutsideQuotes(body) {
  const out = [];
  let cur = "";
  let inS = false;
  let inD = false;
  for (const c of body) {
    if (c === "'" && !inD) {
      inS = !inS;
      cur += c;
    } else if (c === '"' && !inS) {
      inD = !inD;
      cur += c;
    } else if (c === "," && !inS && !inD) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

// Trim, unquote a single list item. Comment-stripping is done at the line level
// (stripOutsideQuoteComment) BEFORE this, so no comment handling is needed here.
function stripPathItem(raw) {
  return raw.trim().replace(/^["']|["']$/g, "").trim();
}

function parseRulePaths(fmBody) {
  const lines = fmBody.split("\n");
  const out = [];
  let inList = false;
  for (const rawLine of lines) {
    // Strip any outside-quote trailing comment FIRST — this removes the
    // greedy-vs-bracket ambiguity entirely (a comment can no longer contain a
    // `]` that the bracket match would over-capture).
    const line = stripOutsideQuoteComment(rawLine);
    // Inline flow-list form: `paths: ["a", "b"]`. Greedy to the LAST `]` is now
    // safe (the comment is already gone) and preserves a glob char-class like
    // `**/*.[ch]`. The body is split quote-aware, position-independent.
    const inline = line.match(/^paths:\s*\[(.*)\]\s*$/);
    if (inline) {
      for (const t of splitFlowListOutsideQuotes(inline[1])) {
        const g = stripPathItem(t);
        if (g) out.push(g);
      }
      return out; // inline form is self-contained; no block follows.
    }
    if (/^paths:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (inList) {
      // Full-line comment inside the block: skip, do NOT terminate the list.
      // (A comment-only line is empty after stripOutsideQuoteComment iff the
      // `#` was at column 0 with no preceding space; handle both via trim.)
      if (line.trim() === "" || /^\s*#/.test(rawLine)) continue;
      const m = line.match(/^\s*-\s*(.+?)\s*$/);
      if (m) {
        const g = stripPathItem(m[1]);
        if (g) out.push(g);
        continue;
      }
      // A non-list, non-blank, non-comment line ends the paths block.
      if (line.trim() !== "") break;
    }
  }
  return out;
}

// Extract the rule's H1 title (first `# ...` after the frontmatter), used as the
// human-readable label in the index. Falls back to the filename stem. Fence-aware:
// a `# DO`-style heading inside a ``` code block is NOT mistaken for the title
// (latent today — every corpus rule opens with its H1 — but cheap to close).
function ruleTitle(content, file) {
  const afterFm = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  let inFence = false;
  for (const line of afterFm.split("\n")) {
    // Both fence forms — backtick (```) and tilde (~~~) — toggle the fence.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1].trim();
  }
  return file.replace(/\.md$/, "");
}

// Escape a value before interpolating it into a markdown table cell: the cell
// delimiter `|` breaks the row, a newline splits it, and a backtick breaks the
// inline-code span the glob cells render inside (`` `${mdCell(g)}` ``). The input
// is self-authored trusted rule frontmatter (gated by /codify +
// self-referential-codify), so this is defense-in-depth, not a trust boundary —
// no corpus title or glob contains any of these, but completeness keeps a future
// glob from silently breaking the table.
function mdCell(s) {
  return s
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'") // backtick → apostrophe (cannot close the code span)
    .replace(/\r?\n/g, " ");
}

// Build the rules-reference index body (one SKILL.md). Returns
// { skillMd: string|null, rules: [{file, title, paths}], skippedContractFail,
//   skippedNoFrontmatter }. skillMd is null when no rule resolves to skill-channel
// for the (filtered) set — callers skip the emission rather than ship an empty index.
//
// DEFENSIVE, not ordering-dependent: this emitter independently resolves each
// rule's lane through the SHARED checkRuleCliDelivery and includes ONLY rules
// whose lane === "skill-channel". A rule whose contract FAILS (asymmetric
// exclusion, unresolved lane) resolves to lane:null and is excluded HERE,
// regardless of whether emit.mjs::validateCliDelivery (Validator 18) ran first.
// Validator 18 is the hard GATE that fails the whole emit on such a rule; this
// emitter does not rely on that ordering for correctness — it skips the same
// rules on its own. Contract-failure + missing-frontmatter skips are COUNTED and
// surfaced (never silent per zero-tolerance Rule 3) so a standalone run flags them.
function buildRulesReferenceIndex({ tierFilter, loomOnly, surfaceRoles, targetRole, exclusions }) {
  const rulesDir = path.join(REPO, ".claude", "rules");
  if (!fs.existsSync(rulesDir))
    return { skillMd: null, rules: [], skippedContractFail: 0, skippedNoFrontmatter: 0 };
  const files = fs
    .readdirSync(rulesDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const rules = [];
  let skippedContractFail = 0;
  let skippedNoFrontmatter = 0;
  for (const file of files) {
    const relPath = `rules/${file}`;
    // loom-only rules never ship to any consumer.
    if (loomOnly && matchesAnyGlob(relPath, loomOnly)) continue;
    // W3-d surface_roles filter (deferred W2-c tail): sibling of loom_only.
    if (!surfaceRolesAllow(surfaceRoles, relPath, targetRole)) continue;
    // tier-subscription filter (null = full/dogfood emit → include all).
    if (tierFilter && !matchesAnyGlob(relPath, tierFilter)) continue;
    const content = safeReadFileSync(path.join(rulesDir, file), "utf8");
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) {
      // emit.mjs Validator 14 is the hard gate on missing frontmatter; count
      // here so a standalone emit surfaces it rather than dropping it silently.
      skippedNoFrontmatter++;
      continue;
    }
    // Resolve the lane via the SHARED parser, using the SAME per-lane manifest
    // exclusion read the real emit uses (Validator 18's exact computation).
    const manifest = {
      codex: matchesAnyGlob(relPath, exclusions.codex || []),
      gemini: matchesAnyGlob(relPath, exclusions.gemini || []),
    };
    const res = checkRuleCliDelivery(fm[1], manifest);
    if (res.lane !== "skill-channel") {
      // A contract FAILURE (lane:null + failures — asymmetric exclusion /
      // unresolved lane) is distinct from a legitimate non-skill-channel lane
      // (baseline / cc-only / n/a-skill-embedded). Count the former so it is
      // visible even if this emitter runs without emit.mjs's Validator 18 gate.
      if (res.lane === null && res.failures && res.failures.length) skippedContractFail++;
      continue;
    }
    rules.push({
      file,
      title: ruleTitle(content, file),
      paths: parseRulePaths(fm[1]),
    });
  }

  if (rules.length === 0)
    return { skillMd: null, rules: [], skippedContractFail, skippedNoFrontmatter };

  const rows = rules
    .map((r) => {
      const globs = r.paths.length
        ? r.paths.map((g) => `\`${mdCell(g)}\``).join(", ")
        : "_(no path globs — consult by domain relevance)_";
      return `| ${mdCell(r.title)} | ${globs} | \`.claude/rules/${r.file}\` |`;
    })
    .join("\n");

  const skillMd = `---
name: ${RULES_REFERENCE_SKILL}
description: ${RULES_REFERENCE_DESCRIPTION}
---

# Rules Reference — Path-Scoped Project Rules (on-demand index)

<!-- GENERATED by .claude/bin/emit-cli-artifacts.mjs::emitRulesReferenceSkill
     (#408 AC#5-b). Source of truth: .claude/rules/*.md frontmatter.
     DO NOT edit by hand — regenerated on every emit. -->

Claude Code auto-loads each rule below when you edit a file matching its
\`paths:\` globs. **Codex and Gemini have no path-glob rule loader** — so this
index IS your delivery channel. Find the rule(s) whose globs match the file or
domain you are working on, then **read the cited \`.claude/rules/<name>.md\`**
(the canonical rule body, shared verbatim across all CLIs) before proceeding.
A path-scoped rule you have not read is a rule you are not honoring.

| Rule | Applies when editing (paths) | Read |
| ---- | ---------------------------- | ---- |
${rows}

${rules.length} path-scoped rule${rules.length === 1 ? "" : "s"} indexed.
`;
  return { skillMd, rules, skippedContractFail, skippedNoFrontmatter };
}

// Emit the rules-reference skill to both lanes' output trees (the --cli filter's
// post-hoc tree deletion in main() drops the unwanted lane, mirroring emitSkills).
function emitRulesReferenceSkill({ outDir, exclusions, tierFilter, loomOnly, surfaceRoles, targetRole, verbose }) {
  const stats = { codex: 0, gemini: 0, rules: 0, skippedContractFail: 0, skippedNoFrontmatter: 0 };
  const { skillMd, rules, skippedContractFail, skippedNoFrontmatter } = buildRulesReferenceIndex({
    tierFilter,
    loomOnly,
    surfaceRoles,
    targetRole,
    exclusions,
  });
  stats.skippedContractFail = skippedContractFail;
  stats.skippedNoFrontmatter = skippedNoFrontmatter;
  // Surface contract-failure / missing-frontmatter skips loudly (never silent per
  // zero-tolerance Rule 3). These are the hard-gate cases emit.mjs Validator 18 /
  // Validator 14 fail on; if this emitter runs standalone, the advisory makes the
  // decoupling visible rather than dropping the rule without a trace.
  if (skippedContractFail || skippedNoFrontmatter) {
    process.stderr.write(
      `emit-cli-artifacts: rules-reference index skipped ${skippedContractFail} ` +
        `contract-failing + ${skippedNoFrontmatter} missing-frontmatter rule(s) — ` +
        `run emit.mjs (Validator 18/14) to see the failing rule names.\n`,
    );
  }
  if (!skillMd) return stats; // empty index → emit nothing.
  stats.rules = rules.length;
  for (const cli of ["codex", "gemini"]) {
    const outFile = path.join(outDir, cli, "skills", RULES_REFERENCE_SKILL, "SKILL.md");
    safeWriteFileSync(outFile, skillMd);
    stats[cli] = 1;
    if (verbose) console.log(`  ${cli.padEnd(7)} skills/${RULES_REFERENCE_SKILL}/ (${rules.length} rules)`);
  }
  return stats;
}

// ────────────────────────────────────────────────────────────────
// Gemini agents — CC frontmatter → Gemini subagent frontmatter
// ────────────────────────────────────────────────────────────────
// Per .claude/gemini-templates/agents/README.md, Gemini subagent
// frontmatter shape is:
//   name: <kebab>       MUST match filename
//   description: <one line>
//   tools: [list]       optional, omit = all tools
//   model: gemini-2.5-pro
// CC tool names (Read, Write, Edit, Bash, Grep, Glob, Task) must be
// mapped. `Task` drops because Gemini subagents cannot recursively
// invoke other subagents (README constraint).
const CC_TO_GEMINI_TOOLS = {
  Read: "read_file",
  Write: "write_file",
  Edit: "replace",
  Bash: "run_shell_command",
  Grep: "grep_search",
  Glob: "glob",
  // Task: dropped — subagents can't recurse
};

// Agents excluded from Gemini emission per gemini-templates README:
//   - cc-architect.md (CC-specific)
//   - codex-architect.md (Codex peer, not a Gemini subagent)
//   - gemini-architect.md (self-reference)
//   - cli-orchestrator.md (meta)
//   - management/* (loom-only)
// sync-manifest only lists cc-architect + (by glob) cc-related content.
// We add the rest as structural exclusions below.
const GEMINI_AGENT_STRUCTURAL_EXCLUSIONS = [
  "agents/codex-architect.md",
  "agents/gemini-architect.md",
  "agents/cli-orchestrator.md",
  "agents/management/**",
  "agents/_README.md",
];

function translateCcToolsToGemini(toolsRaw) {
  if (!toolsRaw) return null;
  const tokens = toolsRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const translated = [];
  for (const tok of tokens) {
    if (tok in CC_TO_GEMINI_TOOLS) {
      translated.push(CC_TO_GEMINI_TOOLS[tok]);
    }
    // Unknown tokens are dropped silently — CC-specific tools have
    // no Gemini equivalent. list_directory is always added below.
  }
  // list_directory is a Gemini default discovery primitive not in CC.
  if (!translated.includes("list_directory")) {
    translated.push("list_directory");
  }
  return translated;
}

// ────────────────────────────────────────────────────────────────
// Skill frontmatter tool-name translation (#408 AC#4)
// ────────────────────────────────────────────────────────────────
// The SKILLS lane historically byte-copied CC tool-name frontmatter
// (`tools:\n  - Read\n  - Glob\n  - Grep`) verbatim into both Codex and
// Gemini emissions — the cross-CLI-parity gap #408 AC#4 names. The AGENTS
// lane already translates (emitGeminiAgents → translateCcToolsToGemini)
// or strips (emitCodexAgentPrompts drops `tools:` entirely); this brings
// the skills lane to the SAME per-CLI contract:
//   - gemini: translate each CC token to its native name (CC_TO_GEMINI_TOOLS),
//     preserving the multi-line YAML list form. CC-only / unknown tokens
//     (e.g. Task) drop. Unlike the agents translator this does NOT inject
//     list_directory — skill `tools:` declares ONLY what the SKILL.md body
//     invokes (skill-authoring.md "Tools List Mismatch"), so over-declaring
//     would violate that contract.
//   - codex: strip the `tools:` block entirely, mirroring emitCodexAgentPrompts
//     (Codex prompts/skills carry no native per-artifact tool restriction).
// Operates ONLY on the leading frontmatter block — the body (including the
// DO-NOT example blocks that legitimately contain CC-isms like
// `Agent(subagent_type=…)` to teach what NOT to write, per #408 C3b) is
// never touched. Also normalizes the legacy `allowed-tools:` key to `tools:`
// on translate (skill-authoring.md § "Tools Field" rename-at-distribute).
//
// Robustness (each pins a redteam-surfaced edge case, all with regression
// fixtures in skill-frontmatter-tool-translation.test.mjs):
//   - CRLF: the fence + line split are CRLF-tolerant and the source EOL is
//     preserved on rebuild — a CRLF skill no longer silently no-ops and leaks
//     CC tokens.
//   - trailing comment: a YAML `#` comment on the key line (`tools:  # note`,
//     or `tools: Read  # note`) is stripped BEFORE the inline-vs-multiline
//     decision, so the following list items are still consumed rather than
//     orphaned into a dangling-list malformed-YAML leak.
//   - idempotent: tokens already in native form (values of CC_TO_GEMINI_TOOLS)
//     pass through unchanged, so a second gemini pass is a true no-op instead
//     of dropping the block. The single call site (emitSkillTreeWithOverlays)
//     still invokes exactly once per emit.
// A body with no frontmatter, or frontmatter with no tools:/allowed-tools:
// block, round-trips byte-identical on both lanes.
function translateSkillFrontmatterTools(body, cli) {
  if (cli !== "codex" && cli !== "gemini") return body;
  // CRLF-tolerant fence; the source EOL is preserved on reconstruction.
  const fmMatch = body.match(/^(---\r?\n)([\s\S]*?\r?\n)(---\r?\n)([\s\S]*)$/);
  if (!fmMatch) return body; // no frontmatter → nothing to translate
  const [, open, fmRaw, close, rest] = fmMatch;
  const eol = open.includes("\r\n") ? "\r\n" : "\n";
  const geminiNative = new Set(Object.values(CC_TO_GEMINI_TOOLS));
  const lines = fmRaw.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(tools|allowed-tools):\s*(.*)$/);
    if (!m) {
      out.push(line);
      continue;
    }
    // Strip a trailing YAML comment (`# …` at start, or ` # …` after the
    // value) from the key line BEFORE the inline-vs-multiline decision —
    // otherwise a commented key takes the inline branch, mis-parses the
    // comment as a token, and orphans the following list items.
    let inline = m[2];
    const hashIdx = inline.search(/(^|\s)#/);
    if (hashIdx !== -1) inline = inline.slice(0, hashIdx);
    inline = inline.trim();
    let tokens;
    if (inline) {
      tokens = inline
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    } else {
      tokens = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        tokens.push(lines[j].replace(/^\s*-\s+/, "").trim());
        j++;
      }
      i = j - 1; // advance past the consumed list items
    }
    if (cli === "codex") {
      // strip the block entirely (mirror emitCodexAgentPrompts)
      continue;
    }
    // gemini: translate CC tokens → native; pass already-native tokens through
    // (idempotency); drop CC-only/unknown (Task). Normalize key → tools.
    const translated = tokens
      .map((t) => CC_TO_GEMINI_TOOLS[t] || (geminiNative.has(t) ? t : null))
      .filter(Boolean);
    if (translated.length > 0) {
      out.push("tools:");
      for (const t of translated) out.push(`  - ${t}`);
    }
    // translated empty → drop the block (no native gemini equivalent)
  }
  return `${open}${out.join(eol)}${close}${rest}`;
}

// Agents excluded from Codex specialist-prompt emission. Mirrors the
// Gemini exclusion intent: peer-CLI architects (cc / codex / gemini),
// the meta cli-orchestrator, loom-only management agents, and the
// agents-tree README. codex-architect is excluded as a self-reference
// (same precedent as gemini-architect for Gemini emission) — it audits
// Codex artifacts at authoring time and is not a runtime specialist.
const CODEX_AGENT_STRUCTURAL_EXCLUSIONS = [
  "agents/cc-architect.md",
  "agents/codex-architect.md",
  "agents/gemini-architect.md",
  "agents/cli-orchestrator.md",
  "agents/management/**",
  "agents/_README.md",
];

// ────────────────────────────────────────────────────────────────
// Codex specialist prompts — deterministic delegation shim
// ────────────────────────────────────────────────────────────────
// Codex's runtime does NOT expose native callable equivalents of COC
// specialists (per .claude/guides/codex/README.md "Known limitations
// 2026-04-22/23" — only `default/explorer/worker` roles exist). This
// emitter materializes each eligible `.claude/agents/<group>/<name>.md`
// into `.codex/prompts/specialist-<name>.md` as the operating-spec
// content surface; the file is consumed via inline-cat injection
// `"$(cat .codex/prompts/specialist-<name>.md)"` per F79 (see `bin/coc`
// dispatcher + bin/README.md for the canonical Codex invocation path).
// Closes acceptance criteria 1 + 2 from the 2026-05-15 Codex follow-up
// (specialist-by-name dispatch + reviewer/security-reviewer/
// gold-standards-validator gate launchability).
//
// The emitted prompt wraps the specialist's operating spec with a
// preamble describing three invocation patterns: (a) inline persona
// (most reliable; works headless), (b) worker subagent delegation
// (interactive only), (c) headless fallback (use pattern a). The file
// is loaded into context on demand via inline-cat injection — no
// baseline-context cap pressure.
function emitCodexAgentPrompts({ outDir, exclusions, tierFilter, loomOnly, surfaceRoles, targetRole, lang, verbose }) {
  const srcDir = path.join(REPO, ".claude", "agents");
  if (!fs.existsSync(srcDir)) return { codex: 0, skipped: 0 };

  const stats = { codex: 0, skipped: 0 };
  const allExclusions = [
    ...(exclusions.codex || []),
    ...CODEX_AGENT_STRUCTURAL_EXCLUSIONS,
  ];

  for (const { absPath, relPath } of walkFiles(srcDir)) {
    if (!relPath.endsWith(".md")) continue;
    const manifestRel = `agents/${relPath}`;
    // F104 loom-only filter: positive never-sync declaration, BEFORE tier.
    if (loomOnly && matchesAnyGlob(manifestRel, loomOnly)) {
      stats.skipped++;
      continue;
    }
    // W3-d surface_roles filter (deferred W2-c tail): sibling of loom_only.
    if (!surfaceRolesAllow(surfaceRoles, manifestRel, targetRole)) {
      stats.skipped++;
      continue;
    }
    if (tierFilter && !matchesAnyGlob(manifestRel, tierFilter)) {
      stats.skipped++;
      continue;
    }
    if (matchesAnyGlob(manifestRel, allExclusions)) {
      stats.skipped++;
      continue;
    }

    // Apply variant overlays so the emitted Codex specialist content
    // matches the composed body CC sees for the same target. Falls
    // back to verbatim source when no overlay applies (no agents
    // overlay tree exists for `codex` axis today, but the call shape
    // mirrors emitGeminiAgents for future-proofing).
    const composedResult = composeArtifactBody("agents", relPath, "codex", lang);
    const source = composedResult ? composedResult.body : safeReadFileSync(absPath, "utf8");
    const { frontmatter, body } = parseFrontmatter(source);
    const baseName = frontmatter.name || path.basename(relPath, ".md");
    // Strip redundant trailing "-specialist" for cleaner specialist-<x> filename
    // UX (e.g. `dataflow-specialist` → `specialist-dataflow`, not
    // `specialist-dataflow-specialist`). Agents whose name lacks the suffix
    // (analyst, reviewer, build-fix, value-auditor, …) pass through as-is.
    const shortName = baseName.endsWith("-specialist")
      ? baseName.slice(0, -"-specialist".length)
      : baseName;
    const promptName = `specialist-${shortName}`;
    const descRaw = frontmatter.description || `${baseName} specialist`;
    // Codex prompt frontmatter description is quoted; escape any
    // embedded double-quotes so the YAML stays valid.
    const description = descRaw.replace(/"/g, '\\"');

    // Display name for prose: prefer the short form so "the dataflow
    // specialist" reads naturally instead of "the dataflow-specialist
    // specialist". Falls back to baseName when the agent never had the
    // suffix (analyst, reviewer, value-auditor, build-fix, etc.).
    const displayName = shortName;

    const preamble = [
      `You are now operating as the **${displayName}** specialist for the remainder of this turn (or for the delegated subagent invocation, if you delegate).`,
      "",
      "## Invocation patterns",
      "",
      "**(a) Inline persona — most reliable; works in both headless and interactive Codex.**",
      `After invoking \`/prompts:${promptName}\`, your context now contains the operating specification below. Read the user's task and respond as the ${displayName} specialist.`,
      "",
      "**(b) Worker subagent delegation — interactive Codex only.**",
      "Delegate to a worker subagent using natural-language spawn (per Codex subagent docs). Pass the operating specification below as the worker's prompt body.",
      "",
      "**(c) Headless `codex exec` fallback.**",
      `Native subagent spawning is unreliable in headless mode. Use pattern (a): invoke \`/prompts:${promptName}\`, then provide your task in the same session.`,
      "",
      "---",
      "",
      "## Operating specification",
      "",
    ].join("\n");

    // Demote the leading H1 banner (e.g. "# DataFlow Specialist Agent") to
    // H3 so the spec content nests properly under the H2 "## Operating
    // specification" wrapper. Without this, downstream markdown TOC/heading
    // hierarchy tooling misrenders (H1 inside H2 section).
    const trimmedBody = body
      .replace(/^\n+/, "")
      .replace(/\n+$/, "\n")
      .replace(/^# /, "### ");
    const fm = `---\nname: ${promptName}\ndescription: "${description}"\n---\n\n`;
    const content = `${fm}${preamble}${trimmedBody}`;

    const outPath = path.join(outDir, "codex", "prompts", `${promptName}.md`);
    safeWriteFileSync(outPath, content);
    stats.codex++;
    if (verbose) console.log(`  codex   prompts/${promptName}.md`);
  }

  return stats;
}

function emitGeminiAgents({ outDir, exclusions, tierFilter, loomOnly, surfaceRoles, targetRole, lang, verbose }) {
  const srcDir = path.join(REPO, ".claude", "agents");
  if (!fs.existsSync(srcDir)) return { gemini: 0, skipped: 0 };

  const stats = { gemini: 0, skipped: 0 };
  const allExclusions = [
    ...(exclusions.gemini || []),
    ...GEMINI_AGENT_STRUCTURAL_EXCLUSIONS,
  ];

  for (const { absPath, relPath } of walkFiles(srcDir)) {
    if (!relPath.endsWith(".md")) continue;
    const manifestRel = `agents/${relPath}`;
    // F104 loom-only filter: positive never-sync declaration, BEFORE tier.
    if (loomOnly && matchesAnyGlob(manifestRel, loomOnly)) {
      stats.skipped++;
      continue;
    }
    // W3-d surface_roles filter (deferred W2-c tail): sibling of loom_only.
    if (!surfaceRolesAllow(surfaceRoles, manifestRel, targetRole)) {
      stats.skipped++;
      continue;
    }
    // Tier-subscription filter: skip agents not matched by any subscribed tier.
    if (tierFilter && !matchesAnyGlob(manifestRel, tierFilter)) {
      stats.skipped++;
      continue;
    }
    if (matchesAnyGlob(manifestRel, allExclusions)) {
      stats.skipped++;
      continue;
    }

    // Apply variant overlays (lang, gemini, lang-gemini ternary) so the
    // emitted gemini agent matches the composed content CC sees in
    // .claude/agents/ for the same target. Without this, .gemini/agents/
    // ships globals while .claude/agents/ ships variant-composed bodies.
    const composedResult = composeArtifactBody("agents", relPath, "gemini", lang);
    const source = composedResult ? composedResult.body : safeReadFileSync(absPath, "utf8");
    const { frontmatter, body } = parseFrontmatter(source);
    const name = frontmatter.name || path.basename(relPath, ".md");
    const description = frontmatter.description || `${name} specialist`;
    const tools = translateCcToolsToGemini(frontmatter.tools);

    const fmLines = [`name: ${name}`, `description: ${description}`];
    if (tools) {
      fmLines.push("tools:");
      for (const t of tools) fmLines.push(`  - ${t}`);
    }
    fmLines.push(`model: ${frontmatter["gemini-model"] || "gemini-2.5-pro"}`);

    const trimmedBody = body.replace(/^\n+/, "");
    const out = `---\n${fmLines.join("\n")}\n---\n\n${trimmedBody}`;

    const outPath = path.join(outDir, "gemini", "agents", `${name}.md`);
    safeWriteFileSync(outPath, out);
    stats.gemini++;
    if (verbose) console.log(`  gemini  agents/${name}.md`);
  }

  return stats;
}

// ────────────────────────────────────────────────────────────────
// CLI entry
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { out: null, cli: null, target: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--cli") args.cli = argv[++i];
    else if (a === "--target") args.target = argv[++i];
    else if (a === "-v" || a === "--verbose") args.verbose = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    process.stderr.write(
      "usage: emit-cli-artifacts.mjs --out <dir> [--cli codex|gemini] [--target py|rs|rb|base] [-v]\n",
    );
    process.exit(2);
  }

  // --cli accepts only codex|gemini. CC is the source of truth (reads
  // .claude/ directly; nothing to emit). Reject unknown values rather
  // than silently emitting both trees — surfaces the misuse loudly.
  if (args.cli !== null && args.cli !== "codex" && args.cli !== "gemini") {
    process.stderr.write(
      `usage: --cli accepts "codex" or "gemini" only (got "${args.cli}"). ` +
        "CC reads .claude/ directly; no emit needed.\n",
    );
    process.exit(2);
  }

  const onlyCli = args.cli; // null = both
  const exclusions = loadExclusions();
  const loomOnly = loadLoomOnly(); // F104 — positive never-sync globs (all targets)
  const surfaceRoles = loadSurfaceRoles(); // W3-d — per-artifact positive role restriction
  const targetRole = loadTargetRole(args.target); // null when --target absent OR role unset (py/rs)
  const tierFilter = buildTierFilter(args.target); // null when --target absent
  const lang = loadTargetVariant(args.target); // null when --target absent or variant unset
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  if (args.verbose) {
    console.log(`Source: ${REPO}/.claude`);
    console.log(`Output: ${outDir}`);
    console.log(`Exclusions (codex): ${exclusions.codex.length} globs`);
    console.log(`Exclusions (gemini): ${exclusions.gemini.length} globs`);
    console.log(`Loom-only (all targets): ${loomOnly.length} globs`);
    console.log(
      `Surface-roles: ${Object.keys(surfaceRoles).length} declared; target role=${targetRole || "(unset → full emission)"}`,
    );
    if (tierFilter) {
      const subs = loadTargetTierSubscriptions(args.target);
      console.log(
        `Target: ${args.target} → variant=${lang || "(none)"} → tiers ${JSON.stringify(subs)} → ${tierFilter.length} include globs`,
      );
    } else {
      console.log("Target: (none — emit everything, no variant overlays)");
    }
    console.log("");
  }

  const report = {
    commands: emitCommands({ outDir, exclusions, tierFilter, loomOnly, surfaceRoles, targetRole, lang, verbose: args.verbose }),
    skills: emitSkills({ outDir, exclusions, tierFilter, loomOnly, surfaceRoles, targetRole, lang, verbose: args.verbose }),
    rulesReference: emitRulesReferenceSkill({ outDir, exclusions, tierFilter, loomOnly, surfaceRoles, targetRole, verbose: args.verbose }),
    codexAgentPrompts:
      onlyCli === "gemini"
        ? { codex: 0, skipped: 0 }
        : emitCodexAgentPrompts({ outDir, exclusions, tierFilter, loomOnly, surfaceRoles, targetRole, lang, verbose: args.verbose }),
    geminiAgents:
      onlyCli === "codex"
        ? { gemini: 0, skipped: 0 }
        : emitGeminiAgents({ outDir, exclusions, tierFilter, loomOnly, surfaceRoles, targetRole, lang, verbose: args.verbose }),
  };

  // Apply --cli filter after the fact: if onlyCli is set, delete the
  // other CLI's output tree. Simpler than threading the filter through
  // every emitter and keeps emission logic straightforward.
  if (onlyCli === "codex") {
    const geminiDir = path.join(outDir, "gemini");
    if (fs.existsSync(geminiDir))
      fs.rmSync(geminiDir, { recursive: true, force: true });
  } else if (onlyCli === "gemini") {
    const codexDir = path.join(outDir, "codex");
    if (fs.existsSync(codexDir))
      fs.rmSync(codexDir, { recursive: true, force: true });
  }

  console.log("emit-cli-artifacts summary:");
  console.log(
    `  codex:  prompts=${report.commands.codex} skills=${report.skills.codex} agent-prompts=${report.codexAgentPrompts.codex}`,
  );
  console.log(
    `  gemini: commands=${report.commands.gemini} skills=${report.skills.gemini} agents=${report.geminiAgents.gemini}`,
  );
  console.log(
    `  rules-reference skill: codex=${report.rulesReference.codex} gemini=${report.rulesReference.gemini} (${report.rulesReference.rules} path-scoped rules indexed) [#408 AC#5-b]`,
  );
  console.log(
    `  skipped (exclusions): commands=${report.commands.skipped} skills=${report.skills.skipped} codex-agent-prompts=${report.codexAgentPrompts.skipped} gemini-agents=${report.geminiAgents.skipped}`,
  );
  console.log(`  output: ${outDir}`);
}

// Only run if invoked directly; support `import` in tests.
const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`emit-cli-artifacts: ${err.stack || err.message}\n`);
    process.exit(1);
  }
}

export {
  REPO,
  safeWriteFileSync,
  loadExclusions,
  loadLoomOnly,
  loadTiers,
  loadTargetTierSubscriptions,
  loadTargetVariant,
  buildTierFilter,
  composeArtifactBody,
  parseFrontmatter,
  walkFiles,
  matchesAnyGlob,
  emitCommands,
  emitSkills,
  emitRulesReferenceSkill,
  buildRulesReferenceIndex,
  parseRulePaths,
  ruleTitle,
  mdCell,
  stripOutsideQuoteComment,
  splitFlowListOutsideQuotes,
  emitCodexAgentPrompts,
  emitGeminiAgents,
  translateCcToolsToGemini,
  translateSkillFrontmatterTools,
  // Exported for validate-coc-parity.mjs (W4) so the parity harness models the TRUE legacy
  // per-CLI agent-exclusion set (manifest cli_emit_exclusions ∪ these constants), not a
  // manifest-only proxy — a manifest⟷constant drift then surfaces as a parity divergence
  // instead of being silently absorbed. Retired together with this emitter at W5.
  CODEX_AGENT_STRUCTURAL_EXCLUSIONS,
  GEMINI_AGENT_STRUCTURAL_EXCLUSIONS,
};
