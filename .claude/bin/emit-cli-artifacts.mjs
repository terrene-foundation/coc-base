#!/usr/bin/env node
/*
 * Multi-CLI artifact emitter — commands, native skills and native agents.
 *
 * Peer to .claude/bin/emit.mjs (which emits the per-CLI baseline:
 * AGENTS.md + GEMINI.md + codex-mcp-guard/policies.json). This driver
 * fills the remaining surface that coc-sync Step 6.6 needs to populate
 * in Codex-aware + Gemini-aware USE templates — the driving tool layer
 * that makes /analyze, /todos, /implement, etc. reachable from those
 * CLIs plus the subagent registry Gemini needs for @specialist.
 *
 * Output layout (with --out <dir>) — the per-CLI ROOTS are the FINAL dotted
 * names the consumer loads from, NOT staging names awaiting a rename:
 *
 *   <dir>/.codex/
 *     prompts/<cmd>.md                    one per non-excluded .claude/commands/<cmd>.md
 *     prompts/specialist-<name>.md        compatibility operating specifications
 *     agents/<name>.toml                 native custom agents, exact source names
 *   <dir>/.agents/skills/
 *     <nn-name>/SKILL.md                  composed expertise skills
 *     coc-<cmd>/SKILL.md                  explicitly invoked phase procedures
 *     coc-<cmd>/agents/openai.yaml        disables implicit phase invocation
 *
 *   <dir>/.gemini/
 *     commands/<cmd>.toml     one per non-excluded command (TOML per Gemini spec)
 *     skills/<nn-name>/SKILL.md
 *     agents/<name>.md        per non-excluded specialist (CC → Gemini frontmatter)
 *
 * Exclusions: reads cli_emit_exclusions.{codex,gemini} and honors those globs at
 * source-tree scan time. The SOURCE differs by repo class (F95): at loom
 * (`coc-source`) from `.claude/sync-manifest.yaml`; at a multi-CLI USE template,
 * where that path is the one `emit.mjs` Validator 16 requires ABSENT, from the
 * narrowed projection `.claude/.coc-cli-emit.yaml` that loom writes there
 * (`sync-tier-aware.mjs::emitCliEmitProjection`). Both are resolved by
 * `lib/coc-manifest.mjs::loadExclusions`. If NEITHER is present this emitter
 * withholds nothing — measured at kailash-coc-py as 406 → 473 artifacts, 67
 * one-directional over-emissions, which is why the projection exists.
 *
 * Companion surfaces (owned by other delivery steps):
 *   - .codex/prompts/ retains source procedure text for compatibility/headless
 *     callers. It is not a discovered project slash-command directory. OpenAI
 *     deprecated custom prompts on 2026-01-22; loom#385 was the May 28 response.
 *     Current interactive phase invocation uses explicit `$coc-<phase>` skills.
 *   - emit.mjs populates codex-mcp-guard/policies.json metadata. The delivered
 *     guard library evaluates registered hook subprocesses; runtime predicate
 *     execution is implemented, not deferred pending a policies.js module.
 *     The native hook bridge consumes this policy machinery. Independent MCP
 *     wrapper calls remain compatibility entry points, not universal interception.
 *   - .codex/hooks.json + .gemini/settings.json are copied by coc-sync
 *     directly from codex-templates/ + gemini-templates/ (Step 6.6).
 *
 * Usage:
 *   EMIT_OUT=$(mktemp -d)   # --out MUST be a scratch dir OUTSIDE any working tree;
 *                           # a path inside one is refused (see the fence in main()).
 *   node .claude/bin/emit-cli-artifacts.mjs --out "$EMIT_OUT"
 *   node .claude/bin/emit-cli-artifacts.mjs --out "$EMIT_OUT" --verbose
 *   node .claude/bin/emit-cli-artifacts.mjs --cli codex  --out "$EMIT_OUT"  (codex only)
 *   node .claude/bin/emit-cli-artifacts.mjs --cli gemini --out "$EMIT_OUT"  (gemini only)
 *   node .claude/bin/emit-cli-artifacts.mjs --target py  --out "$EMIT_OUT"  (filter by repos.py.tier_subscriptions)
 *
 * These examples previously read `--out ./tmp/emit`. That is a repo-RELATIVE path, and
 * `tmp/` is not gitignored here, so following them wrote `tmp/{codex,gemini}/` as
 * untracked dirs into the working tree — the very pollution the fence now refuses. The
 * tool's own usage block was demonstrating the anti-pattern.
 *
 * --target <name> filters emission to files matched by the union of glob
 * patterns under tiers.<tier> for each tier in repos.<name>.tier_subscriptions.
 * Required when emitting for a USE template — emitting WITHOUT a target ships
 * every artifact on disk (e.g., onboarding-tier files leak into [cc,coc-core,kailash]
 * py/rs targets). Per sync-flow.md § Gate 2 → Process step 3 (loom: /sync-to-use), missing/empty
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
  ensureTrailingNewline,
  writeTextArtifactSync,
  safeReadFileSync,
  matchesAnyGlob,
  loadExclusions,
  loadLaneExclusions,
  loadVariantOnly,
  loadLoomOnly,
  loadUniversalExclude,
  loadTiers,
  loadTargetTierSubscriptions,
  loadTargetVariant,
  loadTargetRole,
  loadSurfaceRolesDiagnostics,
  deliveryVerdict,
  buildTierFilter,
  composeArtifactBody,
  rewriteClaudePathsForCli,
  mapArtifactMarkdownClauses,
  walkFiles,
} from "./lib/coc-manifest.mjs";
// #408 AC#5-b: the rules-reference emitter resolves each rule's non-CC lane via
// the SHARED cli_delivery parser (also used by emit.mjs::validateCliDelivery /
// Validator 18). Single source of truth — a divergent mirror was the R1 finding
// the AC#5-a redteam closed.
import { isMainModule } from "./lib/entry-point.mjs";
import { checkRuleCliDelivery, parseExcludeFrom } from "./lib/cli-delivery.mjs";
// loom#1870 — the `multi_cli_overlays.<type>.symlinks` reader below parses the
// manifest text directly. Sourced from the ONE loader every other manifest read
// in this pipeline uses, so a truncated/absent manifest fails the same way here.
import { readManifestSource, readCliEmitProjection, isManifestOwnerClass } from "./lib/manifest-source.mjs";
import {
  assertNoUnclassifiedWorkspaceRef,
  assertPrivateOrgConfig,
  assertTreeFreeOfPrivateIdentity,
  WorkspaceDisclosureError,
} from "./lib/strip-build-internal.mjs";

// ────────────────────────────────────────────────────────────────
// Per-CLI ROOT directory names — FINAL, not staging
// ────────────────────────────────────────────────────────────────
// The emitter writes the name the consumer actually loads from (`.codex/`,
// `.gemini/`), so no downstream step has to rename anything. The previous
// dotless staging layout (`codex/`, `gemini/`) depended on coc-sync Step 6.6
// relocating it; when that relocation did not run, the staging names were
// published verbatim into the consumer as stray `codex`/`gemini` dirs.
// Measured across four Gate-2 deliveries: two clean, two leaked. The sibling
// emitter emit-coc.mjs has never leaked because it writes its FINAL `.coc`
// root directly — same disposition here.
export const CLI_ROOTS = Object.freeze({ codex: ".codex", gemini: ".gemini" });

// Throw on an unknown CLI rather than degrading to a bare directory name: a
// silent fallback would re-introduce exactly the dotless root this constant
// exists to remove (zero-tolerance.md Rule 3).
export function cliRoot(cli) {
  const dir = Object.prototype.hasOwnProperty.call(CLI_ROOTS, cli) ? CLI_ROOTS[cli] : null;
  if (!dir) {
    throw new Error(
      `emit-cli-artifacts: unknown CLI "${cli}" — no root directory declared in CLI_ROOTS ` +
        `(known: ${Object.keys(CLI_ROOTS).join(", ")})`,
    );
  }
  return dir;
}

// Skills have a shared native discovery root in current Codex. Keep this
// separate from cliRoot: configuration and custom agents still use .codex.
export function cliSkillRoot(cli) {
  return cli === "codex" ? ".agents/skills" : `${cliRoot(cli)}/skills`;
}

// ────────────────────────────────────────────────────────────────
// surface_roles readability — the emit-side fail-closed decision
// ────────────────────────────────────────────────────────────────
// PURE over the `unparsed` array `parseSurfaceRolesStanza` returns: `null` when
// every stanza line was read, otherwise the operator-facing refusal text.
// Separated from `main()` on purpose — while the decision lived inline the only
// way to exercise it was to mutate the live manifest and spawn the emitter, and
// a gate whose sole exercise is a destructive one does not get exercised.
//
// It takes the ARRAY rather than reading the manifest itself so the caller owns
// the read: `main()` must fail closed on loom's own manifest, while a consumer
// class whose manifest is EXPECTED-absent yields an empty array and no refusal.
export function surfaceRolesRefusalMessage(unparsed) {
  if (!Array.isArray(unparsed) || unparsed.length === 0) return null;
  const shown = unparsed
    .slice(0, 10)
    .map((u) => `    line ${u.lineNo}: ${String(u.line).trim()}\n      -> ${u.reason}`)
    .join("\n");
  const more = unparsed.length > 10 ? `\n    ... and ${unparsed.length - 10} more` : "";
  return (
    "emit-cli-artifacts: REFUSING TO EMIT — the surfacing authority " +
    "`.claude/sync-manifest.yaml` has " +
    `${unparsed.length} line(s) inside its \`surface_roles:\` stanza ` +
    "that the loader could not read.\n" +
    "  Each one is an entry this emit would have scored as ABSENT, i.e.\n" +
    "  DEFAULT-SURFACED at every role — the artifact would ship to a role the\n" +
    "  manifest de-surfaced it for, on every consumer lane, without a word.\n" +
    "  `check-invoker-audience.mjs` already refuses on these exact lines; emitting\n" +
    "  past them is the audit and the distribution disagreeing about the same bytes.\n" +
    `${shown}${more}\n` +
    "  Rewrite each line as `  <path>: [role, role]` or as `  <path>:` followed by\n" +
    "  `    - <role>` items. Bare scalars, 4-space indents, anchors/aliases and\n" +
    "  nested mappings are REPORTED rather than guessed at, on purpose: inferring\n" +
    "  what the operator meant is the silent decision this refusal exists to stop.\n"
  );
}

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

function emitCommands({ outDir, exclusions, tierFilter, loomOnly, universalExclude, surfaceRoles, targetRole, lang, laneExclude, hasTarget, verbose }) {
  const srcDir = path.join(REPO, ".claude", "commands");
  if (!fs.existsSync(srcDir)) {
    return { codex: 0, gemini: 0, skipped: 0, fateSkipped: [] };
  }

  const stats = { codex: 0, gemini: 0, skipped: 0, fateSkipped: [] };

  for (const { absPath, relPath } of walkFiles(srcDir)) {
    if (!relPath.endsWith(".md")) continue;
    const manifestRel = `commands/${relPath}`;
    const name = path.basename(relPath, ".md");

    // F92 — ONE delivery oracle (lib/coc-manifest.mjs::deliveryVerdict) for
    // loom_only + lane fate + surface_roles + tier, ordered to match
    // sync-tier-aware.mjs::classifyFile. Was four inline copies here; the lane
    // fate in particular was MISSING, which shipped three build_exclude'd
    // commands to codex+gemini on the BUILD lane.
    const verdict = deliveryVerdict({
      manifestRel, loomOnly, universalExclude, laneExclude, surfaceRoles, targetRole,
      tierFilter, hasTarget,
    });
    if (!verdict.delivered) {
      stats.skipped++;
      // Record the WITHHELD IDENTITY for the distribution-FATE reasons, so this
      // surface reports its hits and not only a tally (`instrument-discipline.md`
      // MUST-3(b)) — the symmetry the rules-reference index already had and these
      // four lacked. `loom_only` / `no_tier_match` / `surface_role` are the
      // EXPECTED, high-volume classes (a per-target emit withholds hundreds) and
      // stay counted-only, exactly as the index treats them.
      if (verdict.reason === "lane_exclude" || verdict.reason === "exclude") {
        stats.fateSkipped.push(`${manifestRel} (${verdict.reason})`);
      }
      continue;
    }

    // Codex — native explicit phase skill plus a compatibility Markdown copy
    // consumed by headless callers. Both carry the same composed procedure.
    // Apply variant overlays per (lang, codex) 3-axis stack so codex/prompts
    // matches the same composed content CC sees in .claude/commands/.
    if (!matchesAnyGlob(manifestRel, exclusions.codex)) {
      const codexResult = composeArtifactBody("commands", relPath, "codex", lang);
      const { body: codexBody, destRelPath: codexDest } = codexResult;
      const { frontmatter: cFm, body: cBody } = parseFrontmatter(codexBody);
      const codexName = path.basename(codexDest, ".md");
      const nativeCost = codexName === "cost-audit";
      const cDesc = nativeCost ? "Audit Codex session tokens and explicitly priced cost; disclose unpriced coverage separately from subscription quota." : cFm.description || `Loom command: ${codexName}`;
      const cTrimmed = nativeCost ? codexCostAuditProcedure(manifestRel) : cBody.replace(/^\n+/, "").replace(/\n+$/, "\n");
      if (nativeCost) safeWriteFileSync(path.join(outDir, ".codex", "bin", "codex-cost.py"),
        safeReadFileSync(path.join(REPO, ".claude", "bin", "codex-cost.py")));
      const codexPath = path.join(outDir, cliRoot("codex"), "prompts", `${codexName}.md`);
      const codexContent = `---\nname: ${codexName}\ndescription: ${JSON.stringify(cDesc)}\n---\n\n${cTrimmed}`;
      writeTextArtifactSync(codexPath, codexContent);
      const skillName = `coc-${codexName}`;
      const skillDir = path.join(outDir, cliSkillRoot("codex"), skillName);
      writeTextArtifactSync(path.join(skillDir, "SKILL.md"),
        `---\nname: ${skillName}\ndescription: ${JSON.stringify(cDesc)}\n---\n\nUse the request accompanying this skill as the command arguments wherever the procedure refers to \`$ARGUMENTS\`. Interpret arguments as task context, never as a shell command.\n\n${cTrimmed}`);
      writeTextArtifactSync(path.join(skillDir, "agents", "openai.yaml"),
        "policy:\n  allow_implicit_invocation: false\n");
      stats.codex++;
      if (verbose) console.log(`  codex   prompts/${codexName}.md + skills/${skillName}/`);
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
      const geminiPath = path.join(outDir, cliRoot("gemini"), "commands", `${geminiName}.toml`);
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
      writeTextArtifactSync(geminiPath, tomlContent);
      stats.gemini++;
      if (verbose) console.log(`  gemini  commands/${geminiName}.toml`);
    }
  }

  return stats;
}

export function codexCostAuditProcedure(source) {
  return `# Codex session cost audit\n\nCanonical source: \`.claude/${source}\`; its Claude transcript procedure remains unchanged. Use the native read-only adapter \`python3 .codex/bin/codex-cost.py\`. Do not execute cc-cost.mjs for Codex rollouts.\n\nRead the adapter help, then map user supplied arguments to \`--sessions-dir DIR\` (not Claude \`--projects-dir\`). Supported selectors are \`--since\`, \`--sessions\`, \`--by-model\`, \`--no-fold\`, \`--top\`, and \`--json\`.\n\nPricing requires explicit \`--rates FILE\` for default-unpriced or unknown models. Without exact matching rates report tokens as unpriced; never invent prices or count unpriced tokens as free. Report persisted token counts separately from subscription quota. Always disclose unsupported/unpriced coverage and reset/malformed-record warnings beside the priced subtotal.\n\nExample: \`python3 .codex/bin/codex-cost.py --sessions-dir DIR --rates FILE --by-model --json\`. Resolve paths and selections from the user's request; never fabricate them.\n`;
}

// ────────────────────────────────────────────────────────────────
// Skills → per-CLI progressive-disclosure SKILL.md copies
// ────────────────────────────────────────────────────────────────
// Gemini + Codex both consume SKILL.md as the entry point; sub-files
// live under the skill dir and are loaded on demand. We copy the WHOLE
// skill directory (not just SKILL.md) so the sub-file references in
// SKILL.md resolve when the CLI reads them.
// RS-89 — does this directory hold a SKILL.md ANYWHERE in its tree? Mirrors
// validate-emit.mjs::findSkillManifests's predicate (recurse, never follow a
// symlink, bounded depth) but short-circuits on the first hit: the producer only
// needs the boolean, not the list. Kept in lockstep with that function — if the
// validator's notion of "is a skill dir" changes, this MUST change with it, or
// the emitter starts shipping what the validator fails on (or withholding what
// it would have passed).
function hasSkillManifest(dir, depth = 0) {
  if (depth > 20) return false;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (hasSkillManifest(path.join(dir, e.name), depth + 1)) return true;
    } else if (e.name === "SKILL.md") return true;
  }
  return false;
}

function emitSkills({ outDir, exclusions, tierFilter, loomOnly, universalExclude, surfaceRoles, targetRole, lang, laneExclude, hasTarget, verbose }) {
  const srcDir = path.join(REPO, ".claude", "skills");
  if (!fs.existsSync(srcDir)) return { codex: 0, gemini: 0, skipped: 0, fateSkipped: [] };

  const stats = { codex: 0, gemini: 0, skipped: 0, fateSkipped: [] };
  const skillDirs = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => d.name);

  for (const skill of skillDirs) {
    const manifestRel = `skills/${skill}/SKILL.md`;
    const skillSrc = path.join(srcDir, skill);

    // F92 — ONE delivery oracle (see emitCommands). Runs BEFORE the
    // entrypoint gate below, preserving the prior order in which loom_only /
    // surface_roles were tested ahead of hasSkillManifest.
    const verdict = deliveryVerdict({
      manifestRel, loomOnly, universalExclude, laneExclude, surfaceRoles, targetRole,
      // The tier test moves here from below, alongside its sibling fences.
      tierFilter, hasTarget,
    });
    if (!verdict.delivered) {
      stats.skipped += 2; // skipped for both CLIs
      // Record the WITHHELD IDENTITY for the distribution-FATE reasons, so this
      // surface reports its hits and not only a tally (`instrument-discipline.md`
      // MUST-3(b)) — the symmetry the rules-reference index already had and these
      // four lacked. `loom_only` / `no_tier_match` / `surface_role` are the
      // EXPECTED, high-volume classes (a per-target emit withholds hundreds) and
      // stay counted-only, exactly as the index treats them.
      if (verdict.reason === "lane_exclude" || verdict.reason === "exclude") {
        stats.fateSkipped.push(`${manifestRel} (${verdict.reason})`);
      }
      continue;
    }

    // RS-89: entrypoint gate. The candidate set above is every immediate
    // DIRECTORY under .claude/skills/ with no test that it is actually a skill,
    // so a non-skill directory emits as an entrypoint-less skill dir —
    // validate-emit.mjs already FAILS that ("skill dir emitted with no SKILL.md
    // anywhere in its tree"), but only AFTER emission; nothing stopped the
    // producer. Mirror the validator's predicate EXACTLY: tree-wide, not
    // top-level. A top-level-only test would drop 40-stack-onboarding, whose
    // SKILL.md files live one level down (go/, python/, rust/, typescript/).
    assertOrdinaryResourceTree(skillSrc);
    if (!hasSkillManifest(skillSrc)) {
      stats.skipped += 2; // skipped for both CLIs
      if (verbose) console.log(`  (skip)  skills/${skill}/ — no SKILL.md in tree`);
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
      const skillOut = path.join(outDir, cliSkillRoot(cli), skill);
      if (cli === "codex" && fs.existsSync(skillOut)) {
        throw new Error(`Codex skill collides with command skill: ${skill}`);
      }
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
export function assertOrdinaryResourceTree(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsupported skill resource directory: ${root}`);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const source = path.join(root, entry.name);
    const metadata = fs.lstatSync(source);
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
      throw new Error(`unsupported skill resource (symlink or special file): ${source}`);
    }
    if (metadata.isDirectory()) assertOrdinaryResourceTree(source);
  }
}

function emitSkillTreeWithOverlays({ skillName, skillSrc, skillOut, cli, lang }) {
  // walkFiles deliberately skips non-ordinary entries. A skill must instead
  // refuse incomplete support delivery before creating any output directory.
  assertOrdinaryResourceTree(skillSrc);
  fs.mkdirSync(skillOut, { recursive: true });
  for (const { absPath, relPath } of walkFiles(skillSrc)) {
    // For markdown files, apply variant-overlay composition. Non-md
    // files (e.g., images, fixtures) are copied byte-for-byte — they
    // never have variant overlays.
    if (relPath.endsWith(".md")) {
      const category = "skills";
      const skillRelPath = path.posix.join(skillName, relPath);
      const result = composeArtifactBody(category, skillRelPath, cli, lang, { rewritePaths: false });
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
        const linkedBody = rebaseArtifactMarkdownLinks(result.body, {
          sourceFile: absPath,
          destination: path.posix.join(cliSkillRoot(cli), result.destRelPath),
        });
        const outBody = translateSkillFrontmatterTools(
          rewriteClaudePathsForCli(linkedBody, cli, { sourcePath: skillRelPath }), cli);
        writeTextArtifactSync(outFile, outBody);
        continue;
      }
    }
    // Fallback: byte copy (destination keeps original relPath). Deliberately on
    // the RAW writer, not the terminator-applying one: this is a verbatim
    // passthrough and MUST stay byte-exact.
    //
    // loom#1684 F4 — SCOPE, stated precisely because the obvious reading is
    // wrong. `data` is a Buffer, but NOT only binary. Two classes reach here:
    //   (1) non-`.md` files (images, fixtures) — never composable; and
    //   (2) any `.md` whose `composeArtifactBody` returned null, i.e. no global
    //       source at `.claude/skills/<rel>` (a variant-only file). That is a
    //       TEXT artifact copied verbatim, and it therefore BYPASSES the
    //       exactly-one-LF contract by design.
    // Class (2) is safe only because the copy is byte-identical to a source the
    // corrected `git ls-files` sweep in emitter-trailing-newline.test.mjs holds
    // to the same one-LF invariant — the source sweep is what covers this path,
    // not the writer.
    const outFile = path.join(skillOut, relPath);
    const data = safeReadFileSync(absPath);
    safeWriteFileSync(outFile, data);
    const outputFd = fs.openSync(outFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fchmodSync(outputFd, fs.lstatSync(absPath).mode & 0o777); }
    finally { fs.closeSync(outputFd); }
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
// Enumerate the rule SOURCES for a lang, applying `artifact-flow.md` § Variant
// Overlay Semantics (Replacement / Addition / Global-only). Returns a Map of
// `<file>` → absolute source path.
//
// THE DISCRIMINATOR IS FRONTMATTER PRESENCE, and it is load-bearing. A variant
// rule file is one of TWO different things, and only one of them is a rule:
//   · WITH frontmatter  → a STANDALONE rule. Either a full REPLACEMENT of the
//     global twin or an ADDITION with no global twin at all (the eight rs rules:
//     build-speed, release, …). NOTE: since the prism lane was retired
//     (2026-09-02) NO full REPLACEMENT overlay remains in the tree — prism's two
//     were the last — so every surviving frontmatter file is an ADDITION. The
//     replacement PATH below is still live code and still exercised by
//     composeRule; it simply has no in-repo instance to index today.
//   · WITHOUT frontmatter → a SLOT OVERLAY (`<!-- slot:lang-… -->`) that patches
//     the global rule's BODY. Its frontmatter — and therefore its `paths:` and
//     title — still comes from the global, which this index already enumerated,
//     so indexing the overlay would double-count it with no parseable metadata.
//
// Measured at authoring time across the then-three langs: 10 with frontmatter
// (8 rs variant-only + 2 prism replacements), 16 without. Prism retired
// 2026-09-02, so the live figures are 8 with frontmatter and 14 without —
// re-measure rather than citing either number. The predicate also excludes
// the `ci-runners.operator.local*` files for free — they carry no frontmatter,
// and two of them are gitignored per-operator files that must never be indexed.
//
// F92 NOTE: this re-derives locally what `sync-tier-aware.mjs` already computes
// authoritatively as the plan's `variant_only` set. That duplication IS the root
// cause this shard's parent ledger row tracks; consult the shared oracle here
// once it exists rather than growing a sixth copy of the composition order.
function collectRuleSources(lang) {
  const sources = new Map();
  const rulesDir = path.join(REPO, ".claude", "rules");
  if (fs.existsSync(rulesDir)) {
    for (const f of fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md"))) {
      sources.set(f, { abs: path.join(rulesDir, f), variantOnly: false });
    }
  }
  if (!lang) return sources;
  const variantDir = path.join(REPO, ".claude", "variants", lang, "rules");
  if (!fs.existsSync(variantDir)) return sources;
  // Only a DECLARED addition is tier-exempt below. Structural presence in the
  // variants tree is NOT the admission signal: `sync-manifest.yaml::variant_only`
  // is what makes the distributor copy the file, so an UNDECLARED variant file
  // would be indexed here and never delivered — a dangling row in the one channel
  // Codex/Gemini have, i.e. the exact bug this shard fixes, inverted.
  const declared = new Set((loadVariantOnly()[lang] || []).map((e) => e.replace(/^\.claude\//, "")));
  for (const f of fs.readdirSync(variantDir).filter((f) => f.endsWith(".md"))) {
    const abs = path.join(variantDir, f);
    // Read only the bytes needed to classify; a slot overlay never opens with
    // `---`. Keeps the classification honest rather than inferring from the name.
    let head;
    try {
      head = safeReadFileSync(abs, "utf8");
    } catch {
      continue; // unreadable variant source — the global (if any) still stands
    }
    if (!/^---\n/.test(head)) continue; // slot overlay → body patch, not a rule
    const hasGlobalTwin = sources.has(f) && sources.get(f).variantOnly === false;
    sources.set(f, {
      abs,
      // REPLACEMENT of a global keeps the global's tier admission (its twin is
      // tier-declared). ADDITION has no global path to test, so its admission is
      // the `variant_only` declaration — and only if that declaration exists.
      variantOnly: !hasGlobalTwin && declared.has(`variants/${lang}/rules/${f}`),
    });
  }
  return sources;
}

function buildRulesReferenceIndex({
  tierFilter,
  loomOnly,
  universalExclude,
  surfaceRoles,
  targetRole,
  exclusions,
  lang,
  laneExclude,
  hasTarget,
}) {
  const sources = collectRuleSources(lang);
  if (sources.size === 0)
    return {
      skillMd: null,
      rules: [],
      skippedContractFail: 0,
      skippedNoFrontmatter: 0,
      laneSkipped: [],
    };
  const files = [...sources.keys()].sort();

  const rules = [];
  const laneSkipped = [];
  let skippedContractFail = 0;
  let skippedNoFrontmatter = 0;
  for (const file of files) {
    const relPath = `rules/${file}`;
    const src = sources.get(file);
    // F92 — ONE delivery oracle. F93 gave this index the per-lane distribution
    // fate its four siblings still lacked, but applied it UNCONDITIONALLY: at
    // loom's own self-emit (no --target) that dropped four rules loom itself is
    // governed by (cross-repo, cross-sdk-inspection, loom-csq-boundary,
    // documentation) from the one channel Codex/Gemini have. Lane fate is a
    // property of a DELIVERY TO a target, so the oracle gates it on hasTarget.
    // `tierExempt` carries this index's variant_only carve-out: a DECLARED
    // variant-only ADDITION has no global path to test, so testing
    // `rules/<file>` against the tier globs asks the wrong question.
    const verdict = deliveryVerdict({
      manifestRel: relPath, loomOnly, universalExclude, laneExclude, surfaceRoles, targetRole,
      tierFilter, hasTarget, tierExempt: src.variantOnly,
    });
    if (!verdict.delivered) {
      if (verdict.reason === "lane_exclude") laneSkipped.push(relPath);
      continue;
    }
    const content = safeReadFileSync(src.abs, "utf8");
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
    return { skillMd: null, rules: [], skippedContractFail, skippedNoFrontmatter, laneSkipped };

  const rows = rules
    .map((r) => {
      const globs = r.paths.length
        ? r.paths.map((g) => `\`${mdCell(g)}\``).join(", ")
        : "_(no path globs — consult by domain relevance)_";
      return `| ${mdCell(r.title)} | ${globs} | \`.claude/rules/${r.file}\` |`;
    })
    .join("\n");

  // RS-89: `description:` MUST be a QUOTED scalar. RULES_REFERENCE_DESCRIPTION
  // contains "(no path-glob loader): find", and an unquoted YAML scalar carrying
  // `: ` is a ScannerError ("mapping values are not allowed here") — measured
  // against PyYAML, with a quoted sibling emission parsing clean as the control.
  // The whole frontmatter block failed to parse, so the rules-reference skill —
  // the ONLY path-scoped-rule delivery channel on the no-path-loader CLIs — was
  // unloadable on every emit. JSON.stringify (not the bare `"${...}"` sibling
  // form) so a future edit adding a quote or backslash to the constant cannot
  // silently re-open the class.
  const skillMd = `---
name: ${RULES_REFERENCE_SKILL}
description: ${JSON.stringify(RULES_REFERENCE_DESCRIPTION)}
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
  return { skillMd, rules, skippedContractFail, skippedNoFrontmatter, laneSkipped };
}

// Emit the rules-reference skill to both lanes' output trees (the --cli filter's
// post-hoc tree deletion in main() drops the unwanted lane, mirroring emitSkills).
export function buildCodexRulesIndex({ exclusions = {}, tierFilter, loomOnly, universalExclude, surfaceRoles, targetRole, lang, laneExclude, hasTarget } = {}) {
  const rules = [];
  for (const [file, source] of [...collectRuleSources(lang)].sort(([a], [b]) => a.localeCompare(b))) {
    const relPath = `rules/${file}`;
    const verdict = deliveryVerdict({ manifestRel: relPath, loomOnly, universalExclude,
      laneExclude, surfaceRoles, targetRole, tierFilter, hasTarget, tierExempt: source.variantOnly });
    if (!verdict.delivered || matchesAnyGlob(relPath, exclusions.codex || [])) continue;
    const content = safeReadFileSync(source.abs, "utf8");
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm && parseExcludeFrom(fm[1]).has("codex")) continue;
    const delivery = fm ? checkRuleCliDelivery(fm[1], {
      codex: false, gemini: matchesAnyGlob(relPath, exclusions.gemini || []),
    }) : null;
    // This discovery view includes baseline and legacy/unresolved metadata.
    // It does not assert contract validity or change rules-reference's gate.
    if (delivery?.lane === "cc-only") continue;
    rules.push({ file, paths: fm ? parseRulePaths(fm[1]) : [],
      lane: delivery?.lane || "unresolved (run Validator 18/14)",
      // Distribution composes variant sources into canonical rules/<file> at
      // the consumer; authoring-only variant directories are not runtime refs.
      source: `.claude/rules/${file}` });
  }
  const rows = rules.map((rule) => `| [${mdCell(rule.file)}](../${rule.source}) | ${rule.paths.length ? rule.paths.map((glob) => `\`${mdCell(glob)}\``).join(", ") : "domain relevance / unscoped"} | ${mdCell(rule.lane)} |`).join("\n");
  return { rules, markdown: `# Canonical Codex rule discovery\n\nRead applicable canonical rules before changing files or performing their governed operations. Match path scopes, then consult unscoped rules by domain relevance. Codex does not automatically inject these path-scoped rule bodies.\n\nThis complete discovery view is separate from the contracted rules-reference skill; unresolved metadata remains visible and does not pass Validator 18/14. Distribution, surface-role and CLI exclusions still apply. Rule bodies remain canonical source files.\n\n| Canonical rule | Path scopes | Declared delivery |\n| --- | --- | --- |\n${rows}\n` };
}

function emitRulesReferenceSkill({ outDir, exclusions, tierFilter, loomOnly, universalExclude, surfaceRoles, targetRole, lang, laneExclude, hasTarget, verbose }) {
  const completeIndex = buildCodexRulesIndex({ exclusions, tierFilter, loomOnly, universalExclude, surfaceRoles, targetRole, lang, laneExclude, hasTarget });
  writeTextArtifactSync(path.join(outDir, ".codex", "rules-index.md"), completeIndex.markdown);
  const stats = { codex: 0, gemini: 0, rules: 0, skippedContractFail: 0, skippedNoFrontmatter: 0, laneSkipped: [] };
  const { skillMd, rules, skippedContractFail, skippedNoFrontmatter, laneSkipped } = buildRulesReferenceIndex({
    tierFilter,
    loomOnly,
    universalExclude,
    surfaceRoles,
    targetRole,
    exclusions,
    lang,
    laneExclude,
    hasTarget,
  });
  stats.skippedContractFail = skippedContractFail;
  stats.skippedNoFrontmatter = skippedNoFrontmatter;
  stats.laneSkipped = laneSkipped;
  // Print the WITHHELD LIST IN FULL, never a tally (`instrument-discipline.md`
  // MUST-3(b)) — mirroring emit-coc.mjs, whose lane reporting exists because a
  // wrong `--lane` is otherwise invisible in the transcript.
  if (laneSkipped.length > 0) {
    process.stderr.write(
      `emit-cli-artifacts: rules-reference index withheld ${laneSkipped.length} rule(s) by lane fate:\n` +
        laneSkipped.map((r) => `  - ${r}\n`).join(""),
    );
  }
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
    const outFile = path.join(outDir, cliSkillRoot(cli), RULES_REFERENCE_SKILL, "SKILL.md");
    writeTextArtifactSync(outFile, skillMd);
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
// Codex custom agents and legacy headless operating-spec copies.
// Current native schema: https://learn.chatgpt.com/docs/agent-configuration/subagents
// Configuration intentionally inherits the parent model and reasoning effort;
// Claude model aliases and tool names are not Codex configuration values.
// JSON basic strings are TOML-compatible after DEL is explicitly escaped.
export function rebaseArtifactMarkdownLinks(body, { sourceFile, destination, mapPath = (p) => p, strict = false }) {
  return mapArtifactMarkdownClauses(body, (clause, context) => {
    return clause.replace(/\]\(([^\s)]+)([^)]*)\)/g, (whole, url, title) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) return whole;
      const [target, ...fragment] = url.split("#");
      const absolute = target.startsWith(".claude/")
        ? path.join(REPO, target) : path.resolve(path.dirname(sourceFile), target);
      const sourceRel = path.relative(REPO, absolute).split(path.sep).join("/");
      if (sourceRel.startsWith("../") || !fs.existsSync(absolute)) {
        if (strict) throw new Error(`unresolved source reference in ${path.relative(REPO, sourceFile)}: ${target}`);
        return whole; // illustrative links without a source target are not fabricated
      }
      const mapped = mapPath(sourceRel, context);
      const relative = path.posix.relative(path.posix.dirname(destination), mapped);
      return `](${relative}${fragment.length ? `#${fragment.join("#")}` : ""}${title})`;
    });
  });
}

export function codexAgentToml(frontmatter, body) {
  const { name, description } = frontmatter;
  if (typeof name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new Error(`invalid Codex agent name: ${JSON.stringify(name)}`);
  }
  if (typeof description !== "string" || !description.trim() || !body.trim()) {
    throw new Error(`Codex agent ${name} requires description and instructions`);
  }
  const quote = (value) => JSON.stringify(value).replace(/\u007f/g, "\\u007f");
  const fields = [
    `name = ${quote(name)}`,
    `description = ${quote(description)}`,
    `developer_instructions = ${quote(body.trim() + "\n")}`,
  ];
  // Write can create or overwrite files. Narrow a known inventory only when
  // neither Write nor Edit is present; filesystem sandboxes are not tool ACLs.
  // Unknown or missing metadata retains the parent configuration.
  const tools = String(frontmatter.tools || "").split(",").map((t) => t.trim()).filter(Boolean);
  const known = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Bash", "Write", "Task", "Edit"]);
  if (tools.includes("Write")) {
    fields.push('sandbox_mode = "workspace-write"');
  } else if (tools.length && !tools.includes("Edit") && tools.every((tool) => known.has(tool))) {
    fields.push('sandbox_mode = "read-only"');
  }
  return fields.join("\n") + "\n";
}

// Validate the emitter's deliberately small TOML subset. General TOML is wider;
// consumer efficacy checks this producer contract, while tests also use tomllib.
export function validateCodexAgentToml(text, expectedName = null) {
  const errors = [];
  const values = new Map();
  const required = ["name", "description", "developer_instructions"];
  const allowed = new Set([...required, "sandbox_mode"]);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-z_]+) = (".*")$/);
    if (!match || !allowed.has(match[1])) {
      errors.push("unexpected or malformed native agent field");
      continue;
    }
    const [, key, raw] = match;
    if (values.has(key)) errors.push(`duplicate native agent field: ${key}`);
    try {
      const value = JSON.parse(raw);
      if (typeof value !== "string" || !value.trim()) throw new Error("empty value");
      // Accept only the canonical basic-string spelling the producer writes.
      // This excludes JSON-only escapes (notably escaped slash) and raw DEL.
      if (raw !== JSON.stringify(value).replace(/\u007f/g, "\\u007f")) {
        throw new Error("noncanonical TOML basic string");
      }
      values.set(key, value);
    } catch {
      errors.push(`invalid native agent string: ${key}`);
    }
  }
  for (const key of required) {
    if (!values.has(key)) errors.push(`missing native agent field: ${key}`);
  }
  if (values.has("name") && !/^[a-z][a-z0-9_-]*$/.test(values.get("name"))) {
    errors.push("invalid native agent name");
  }
  if (expectedName !== null && values.get("name") !== expectedName) {
    errors.push(`native agent name does not match filename: ${expectedName}`);
  }
  if (values.has("sandbox_mode") && !["read-only", "workspace-write", "danger-full-access"].includes(values.get("sandbox_mode"))) {
    errors.push("invalid native agent sandbox_mode");
  }
  return errors;
}

function emitCodexAgentPrompts({ outDir, exclusions, tierFilter, loomOnly, universalExclude, surfaceRoles, targetRole, lang, laneExclude, hasTarget, verbose, sourceDir, sourceIsManifestOwner = isManifestOwnerClass(REPO) }) {
  const srcDir = sourceDir || path.join(REPO, ".claude", "agents");
  if (!fs.existsSync(srcDir)) return { codex: 0, skipped: 0, fateSkipped: [] };

  const stats = { codex: 0, skipped: 0, fateSkipped: [] };
  const emittedNames = new Set();
  const promptNames = new Set();
  const records = [];
  const allExclusions = [
    ...(exclusions.codex || []),
    ...CODEX_AGENT_STRUCTURAL_EXCLUSIONS.filter((glob) => sourceIsManifestOwner || glob !== "agents/management/**"),
  ];

  for (const { absPath, relPath } of walkFiles(srcDir)) {
    if (!relPath.endsWith(".md")) continue;
    const manifestRel = `agents/${relPath}`;
    // F92 — ONE delivery oracle (see emitCommands).
    const verdict = deliveryVerdict({
      manifestRel, loomOnly, universalExclude, laneExclude, surfaceRoles, targetRole,
      tierFilter, hasTarget,
    });
    if (!verdict.delivered) {
      stats.skipped++;
      // Record the WITHHELD IDENTITY for the distribution-FATE reasons, so this
      // surface reports its hits and not only a tally (`instrument-discipline.md`
      // MUST-3(b)) — the symmetry the rules-reference index already had and these
      // four lacked. `loom_only` / `no_tier_match` / `surface_role` are the
      // EXPECTED, high-volume classes (a per-target emit withholds hundreds) and
      // stay counted-only, exactly as the index treats them.
      if (verdict.reason === "lane_exclude" || verdict.reason === "exclude") {
        stats.fateSkipped.push(`${manifestRel} (${verdict.reason})`);
      }
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
    const composedResult = sourceDir ? null : composeArtifactBody("agents", relPath, "codex", lang, { rewritePaths: false });
    const source = composedResult ? composedResult.body : safeReadFileSync(absPath, "utf8");
    const { frontmatter, body } = parseFrontmatter(source);
    const baseName = frontmatter.name || path.basename(relPath, ".md");
    if (emittedNames.has(baseName)) throw new Error(`duplicate Codex agent name: ${baseName}`);
    emittedNames.add(baseName);
    codexAgentToml({ ...frontmatter, name: baseName }, body); // validate before any write
    // Strip redundant trailing "-specialist" for cleaner specialist-<x> filename
    // UX (e.g. `dataflow-specialist` → `specialist-dataflow`, not
    // `specialist-dataflow-specialist`). Agents whose name lacks the suffix
    // (analyst, reviewer, build-fix, value-auditor, …) pass through as-is.
    const shortName = baseName.endsWith("-specialist")
      ? baseName.slice(0, -"-specialist".length)
      : baseName;
    const promptName = `specialist-${shortName}`;
    if (promptNames.has(promptName)) throw new Error(`duplicate Codex compatibility prompt name: ${promptName}`);
    promptNames.add(promptName);
    records.push({ absPath, frontmatter, body, baseName, shortName, promptName });
  }

  // Both representations use the same fully checked identity set and adapted body.
  const outputs = [];
  const canMap = (_source, destination) => destination.startsWith(".codex/agents/")
    ? emittedNames.has(path.basename(destination, ".toml"))
    : fs.existsSync(path.join(outDir, destination));
  for (const { absPath, frontmatter, body: sourceBody, baseName, shortName, promptName } of records) {
    const body = rebaseArtifactMarkdownLinks(sourceBody, {
      sourceFile: absPath, destination: `.codex/agents/${baseName}.toml`, strict: true,
      mapPath: (p, context) => rewriteClaudePathsForCli(p, "codex", { ...context, canMap }),
    });
    const adaptedBody = rewriteClaudePathsForCli(body, "codex", { canMap });
    outputs.push([path.join(outDir, ".codex/agents", `${baseName}.toml`),
      codexAgentToml({ ...frontmatter, name: baseName }, adaptedBody)]);
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
      `This is the compatibility operating specification for **${displayName}**.`,
      "",
      `For native delegation, request the custom agent named \`${baseName}\` ` +
        `(defined in \`.codex/agents/${baseName}.toml\`).`,
      "For headless callers that explicitly compose a prompt, the operating specification below remains available.",
      "",
      "## Operating specification",
      "",
    ].join("\n");

    // Demote the leading H1 banner (e.g. "# DataFlow Specialist Agent") to
    // H3 so the spec content nests properly under the H2 "## Operating
    // specification" wrapper. Without this, downstream markdown TOC/heading
    // hierarchy tooling misrenders (H1 inside H2 section).
    const trimmedBody = adaptedBody
      .replace(/^\n+/, "")
      .replace(/\n+$/, "\n")
      .replace(/^# /, "### ");
    const fm = `---\nname: ${promptName}\ndescription: "${description}"\n---\n\n`;
    const content = `${fm}${preamble}${trimmedBody}`;

    const outPath = path.join(outDir, cliRoot("codex"), "prompts", `${promptName}.md`);
    outputs.push([outPath, content]);
    stats.codex++;
    if (verbose) console.log(`  codex   prompts/${promptName}.md`);
  }
  // This is a staging emitter, not an ownership-aware deployment writer. Existing
  // differing files are collisions; preserve them and refuse before writing either form.
  for (const [file, content] of outputs) {
    let component = path.resolve(outDir);
    for (const part of ["", ...path.relative(outDir, file).split(path.sep)]) {
      component = path.join(component, part);
      let stat;
      try { stat = fs.lstatSync(component); } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (stat.isSymbolicLink() || (component !== path.resolve(file) && !stat.isDirectory()) ||
          (component === path.resolve(file) && (!stat.isFile() || fs.readFileSync(file, "utf8") !== ensureTrailingNewline(content)))) {
        throw new Error(`Codex agent output collision: ${path.relative(outDir, component)}`);
      }
    }
  }
  // An explicit empty catalog distinguishes a deliberate all-excluded result
  // from missing emission during ownership-aware delivery. Validate directories
  // even when there are no output files to drive the collision loop above.
  const agentsDir = path.join(outDir, cliRoot("codex"), "agents");
  let directory = path.resolve(outDir);
  for (const part of ["", ...path.relative(outDir, agentsDir).split(path.sep)]) {
    directory = path.join(directory, part);
    try {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Codex agent output collision: ${path.relative(outDir, directory)}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const [file, content] of outputs) writeTextArtifactSync(file, content);

  return stats;
}

function emitGeminiAgents({ outDir, exclusions, tierFilter, loomOnly, universalExclude, surfaceRoles, targetRole, lang, laneExclude, hasTarget, verbose }) {
  const srcDir = path.join(REPO, ".claude", "agents");
  if (!fs.existsSync(srcDir)) return { gemini: 0, skipped: 0, fateSkipped: [] };

  const stats = { gemini: 0, skipped: 0, fateSkipped: [] };
  const allExclusions = [
    ...(exclusions.gemini || []),
    ...GEMINI_AGENT_STRUCTURAL_EXCLUSIONS,
  ];

  for (const { absPath, relPath } of walkFiles(srcDir)) {
    if (!relPath.endsWith(".md")) continue;
    const manifestRel = `agents/${relPath}`;
    // F92 — ONE delivery oracle (see emitCommands).
    const verdict = deliveryVerdict({
      manifestRel, loomOnly, universalExclude, laneExclude, surfaceRoles, targetRole,
      tierFilter, hasTarget,
    });
    if (!verdict.delivered) {
      stats.skipped++;
      // Record the WITHHELD IDENTITY for the distribution-FATE reasons, so this
      // surface reports its hits and not only a tally (`instrument-discipline.md`
      // MUST-3(b)) — the symmetry the rules-reference index already had and these
      // four lacked. `loom_only` / `no_tier_match` / `surface_role` are the
      // EXPECTED, high-volume classes (a per-target emit withholds hundreds) and
      // stay counted-only, exactly as the index treats them.
      if (verdict.reason === "lane_exclude" || verdict.reason === "exclude") {
        stats.fateSkipped.push(`${manifestRel} (${verdict.reason})`);
      }
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

    const outPath = path.join(outDir, cliRoot("gemini"), "agents", `${name}.md`);
    writeTextArtifactSync(outPath, out);
    stats.gemini++;
    if (verbose) console.log(`  gemini  agents/${name}.md`);
  }

  return stats;
}

// ────────────────────────────────────────────────────────────────
// `.codex-mcp-guard/` tree — REGENERATED per target (loom#1870)
// ────────────────────────────────────────────────────────────────
//
// WHAT WAS BROKEN. No delivery path refreshed a target's guard tree. Measured on
// a real `--dry-run --json` plan, all five lanes (USE py/rs/base, BUILD py/rs):
// `.claude/codex-mcp-guard/policies.json` → `action: "skip", reason:
// "no_tier_match"`, while the four `.claude/audit-fixtures/codex-mcp-guard/*.json`
// rows in the SAME plan read `copy`/`tier_match` (positive control — the plan is
// not empty and the matcher fires). `emit.mjs::wireMcpPolicies` DID regenerate,
// but into `<args.out>/codex-mcp-guard/`, whose default is `/tmp/loom-emit-<ts>`:
// a dead-end producer, since the runtime reads a sibling of `server.js` and the
// freshness gate reads `<root>/.claude/codex-mcp-guard/policies.json`. The only
// delivery was the `cp -r .claude/codex-mcp-guard/` in coc-sync Step 6.6 prose —
// loom's COMMITTED BYTES, never a regeneration.
//
// WHY COPYING IS THE WRONG FIX. A target does not hold loom's hook set (measured:
// 166 copied, 13 withheld `loom_only` on the py USE lane), so loom's table names
// guards the target does not have. The tree is therefore REGENERATED against the
// target's OWN `.claude/hooks/` + `.claude/settings.json`, not copied.
//
// WHY HERE AND NOT IN THE ENGINE. `sync-tier-aware.mjs`'s apply seam is too early:
// the delivered tree at that point has hooks but NO `settings.json` (measured on a
// real apply — 167 hook files, settings.json absent), because the USE lane's
// enrichment WRITES settings.json at coc-sync Step 6, which runs BEFORE Step 6.5/6.6
// but AFTER the engine apply. Extracting without settings.json yields an empty,
// fail-OPEN table. This emitter is the Step 6.6 producer, so it runs after Step 6.
//
// Precedent: `manifest_distribute` carried this EXACT defect — declared in the
// manifest, implemented only by agent prose `cp`, never run by the deterministic
// Gate-2 driver — and loom#1777 fixed it by moving the write into the engine.
// Same disposition here, one step later in the pipeline.

// The `symlinks:` declaration's FIRST executable consumer (loom#1870). Before
// this, `multi_cli_overlays.<type>.symlinks` was declared-and-code-unconsumed:
// its only producers were prose (`coc-sync.md` Step 4.6, `migrate.md`), so the
// contract held only as long as an LLM read a runbook. Returns `[]` for a type
// that declares none (`cc-only-legacy`), which is the correct answer, not a
// degraded one — those templates run no multi-CLI emitter and the symlink target
// (`../.codex-mcp-guard`) does not exist there.
//
// Regex-scoped like every other parse in this emitter (no YAML dep). Sequence
// items are `- path: <p>` followed by `target: <t>`; a `#`-led prose mention of
// `symlinks:` does not match — the anchor requires the key at line start after
// whitespace only, at the two-space template-type body indent.
export function loadOverlaySymlinks(templateType = "multi-cli", manifestText = null) {
  const src = manifestText === null ? (readManifestSource(REPO) ?? readCliEmitProjection(REPO)) : manifestText;
  if (!src) return [];
  const lines = src.split("\n");
  let inOverlays = false;
  let inType = false;
  let inSymlinks = false;
  let symIndent = -1;
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (/^multi_cli_overlays:\s*$/.test(line)) {
      inOverlays = true;
      continue;
    }
    if (!inOverlays) continue;
    // A new TOP-LEVEL key ends the block.
    if (/^[A-Za-z_][\w-]*:/.test(line)) break;
    const typeHit = line.match(/^ {2}([A-Za-z][\w-]*):\s*$/);
    if (typeHit) {
      inType = typeHit[1] === templateType;
      inSymlinks = false;
      continue;
    }
    if (!inType) continue;
    const symHit = line.match(/^(\s*)symlinks:\s*$/);
    if (symHit) {
      inSymlinks = true;
      symIndent = symHit[1].length;
      continue;
    }
    if (!inSymlinks) continue;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^\s*/)[0].length;
    // A sibling key at the same-or-shallower indent ends the sequence.
    if (indent <= symIndent) {
      inSymlinks = false;
      continue;
    }
    const pathHit = line.match(/^\s*-\s*path:\s*(\S+)\s*$/);
    if (pathHit) {
      if (cur && cur.path && cur.target) out.push(cur);
      cur = { path: pathHit[1], target: null };
      continue;
    }
    const targetHit = line.match(/^\s*target:\s*(\S+)\s*$/);
    if (targetHit && cur) cur.target = targetHit[1];
  }
  if (cur && cur.path && cur.target) out.push(cur);
  return out;
}

// Files under `.claude/codex-mcp-guard/` that are GENERATED, not copied. Both are
// (re)written by `wireMcpPolicies` from the target's own hooks; copying loom's
// version first and overwriting would briefly publish loom's table.
const CODEX_GUARD_GENERATED = new Set(["policies.json", "extract-policies.dump.json"]);

/**
 * The set of files a delivered `.codex-mcp-guard/` is owed — READ FROM THE
 * PACKAGE'S OWN `files:` DECLARATION, never hardcoded here and never "everything
 * on disk".
 *
 * "Everything on disk" is rejected: it sweeps in whatever local work happens to be
 * sitting in the directory at delivery time — `node_modules/` after any install,
 * and a nested `.claude/` holding `operator-id` identity state written by the
 * guard's own test suite. A hardcoded list here is rejected too, as a SECOND
 * declaration of the same set — the split-contract shape `security.md`
 * § Enforcement-Surface Parity refuses: adding a runtime file to
 * `package.json::files` would silently not deliver it.
 *
 * The two files `files:` cannot carry — `package.json` and `package-lock.json` —
 * are added explicitly below, with the reason recorded at the call site. An earlier
 * revision of this comment justified WITHHOLDING the lockfile on a census of loom's
 * own root tree; that inference was wrong and is withdrawn (see below).
 *
 * THROWS rather than degrading when `files` is absent or empty. An empty
 * delivered set is not a neutral outcome — it is a `.codex-mcp-guard/` holding a
 * policies table and no `server.js` to read it (`zero-tolerance.md` Rule 3).
 */
export function codexGuardDeliverySet(guardSrc) {
  const pkgPath = path.join(guardSrc, "package.json");
  if (!fs.existsSync(pkgPath))
    throw new Error(
      `codex-guard emit refused: ${pkgPath} does not exist. The delivered file set ` +
        `is read from its \`files:\` declaration; there is no fallback list.`,
    );
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch (e) {
    throw new Error(`codex-guard emit refused: ${pkgPath} is not parseable JSON — ${e.message}`);
  }
  const declared = Array.isArray(pkg.files) ? pkg.files : [];
  if (declared.length === 0)
    throw new Error(
      `codex-guard emit refused: ${pkgPath} declares no \`files:\` array. Without it ` +
        `the delivered tree would be a policies table with no server.js to read it.`,
    );
  // `package.json` itself is never listed in its own `files:` (npm always includes
  // it); the target needs it for `npm ci` + the `self-check` script, so add it.
  //
  // `package-lock.json` rides along for the SAME reason, and withholding it was a
  // measured defect rather than a choice. `npm ci` FAILS CLOSED without a lockfile —
  // it refuses to resolve a tree — so a delivery carrying `package.json` alone hands
  // the target a package whose documented install command cannot run. And the
  // mandate is not incidental: the README THIS EMITTER DELIVERS says
  // "`cd .codex-mcp-guard && npm ci`" and then "`npm ci` (not `npm install`) is
  // required: it installs the exact versions declared in `package-lock.json`",
  // while `dev-container-templates/rs/bin/dev:58` runs
  // `( cd /workspace/.codex-mcp-guard && npm ci --no-fund --no-audit )` against the
  // DELIVERED tree. The guard has real dependencies (`@modelcontextprotocol/sdk`,
  // `zod`), so without the lockfile that bootstrap dies and the reproducible-install
  // audit chain the README claims is broken at every consumer.
  //
  // The superseded rationale here read: "'everything on disk' ships
  // `package-lock.json`, which loom's own root `.codex-mcp-guard/` does not carry
  // (measured: 9 files under `.claude/codex-mcp-guard/`, 5 at the root tree)". Both
  // figures still re-derive on today's tree — the measurement was right and the
  // INFERENCE was wrong. It read loom's root tree, an instrument built for "what
  // does loom RUN?", as the answer to "what is a DELIVERED target OWED?"
  // (`instrument-discipline.md` MUST-4). Those two sets diverge at exactly this
  // file, because loom's root tree is an already-resolved local install that never
  // executes `npm ci`, whereas a delivered target's FIRST action is to run it.
  const want = new Set([...declared, "package.json", "package-lock.json"]);
  // The generated pair is produced by `wireMcpPolicies`, not copied. `policies.json`
  // IS declared in `files:` — dropping it here is what makes the delivery a
  // REGENERATION rather than a republication of loom's table.
  for (const g of CODEX_GUARD_GENERATED) want.delete(g);
  return [...want].sort();
}

// Preflight the complete guard write set before mkdir/copy/policy generation.
// O_NOFOLLOW in the shared writer protects file leaves, not directory ancestors.
// This bounds existing paths; it does not claim protection from concurrent swaps.
function inspectGuardPath(root, relative, { kind = "file", required = false, linkTarget = null } = {}) {
  const base = path.resolve(root);
  const absolute = path.resolve(base, relative);
  const inside = path.relative(base, absolute);
  if (path.isAbsolute(relative) || inside === ".." || inside.startsWith(`..${path.sep}`)) {
    throw new Error(`codex-guard emit refused: path escapes selected root: ${relative}`);
  }
  let cursor = base;
  for (const part of ["", ...inside.split(path.sep).filter(Boolean)]) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if (error.code === "ENOENT" && !required && cursor !== base) return null;
      throw error;
    }
    const leaf = cursor === absolute;
    if (leaf && stat.isSymbolicLink() && linkTarget !== null && fs.readlinkSync(cursor) === linkTarget) {
      const resolved = path.resolve(path.dirname(cursor), linkTarget);
      inspectGuardPath(base, path.relative(base, resolved), { kind: "directory", required });
      return stat;
    }
    if (stat.isSymbolicLink() || !(leaf && kind === "file" ? stat.isFile() : stat.isDirectory())) {
      throw new Error(`codex-guard emit refused: unsafe ${kind} path: ${cursor}`);
    }
    if (leaf) return stat;
  }
}

function inspectGuardInputTree(root, relative) {
  inspectGuardPath(root, relative, { kind: "directory", required: true });
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) inspectGuardInputTree(root, child);
    else inspectGuardPath(root, child, { required: true });
  }
}

/**
 * Materialize `<targetRoot>/.codex-mcp-guard/` and the declared symlink(s).
 *
 * Runtime files (server.js, package.json, extract-policies.mjs, README …) are
 * loom-authored and identical everywhere, so they are COPIED. The two generated
 * files are REGENERATED from `<targetRoot>/.claude/{hooks,settings.json}`.
 *
 * FAILS CLOSED on an absent target settings.json rather than writing the empty
 * table `extractPolicies` returns without a matcher map. An empty policy set is
 * not a neutral outcome — `server.js` fail-closed-refuses on it in one direction
 * and, wherever it does not, ships a guard that wraps nothing. Throwing names the
 * missing input (`security.md` § Secure-Default; `zero-tolerance.md` Rule 3 — no
 * silent fallback).
 *
 * Returns a report; the caller prints it. Never returns a bare boolean — a count
 * of what was written is the evidence a reader needs.
 */
export async function emitCodexGuardTree({ targetRoot, templateType = "multi-cli", verbose = false }) {
  const guardSrc = path.join(REPO, ".claude", "codex-mcp-guard");
  try { fs.lstatSync(guardSrc); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { emitted: false, reason: "no codex-mcp-guard surface in this repo", copied: 0, symlinks: [] };
  }
  const emitMod = await import("./emit.mjs");

  targetRoot = path.resolve(targetRoot);
  const declared = loadOverlaySymlinks(templateType);
  const sourceLink = declared.find(({ path: linkPath }) => linkPath === ".claude/codex-mcp-guard");
  inspectGuardPath(REPO, ".claude/codex-mcp-guard", {
    kind: "directory", required: true, linkTarget: sourceLink?.target ?? null,
  });
  // Resolve only the one declared source alias; every selected file below it
  // must still be ordinary. Consumer emitters read their installed guard here.
  const guardSourceRoot = fs.realpathSync(guardSrc);
  inspectGuardPath(guardSourceRoot, "package.json", { required: true });
  const delivery = codexGuardDeliverySet(guardSourceRoot);
  for (const name of delivery) inspectGuardPath(guardSourceRoot, name, { required: true });

  const hooksDir = path.join(targetRoot, ".claude", "hooks");
  const settingsPath = path.join(targetRoot, ".claude", "settings.json");
  if (!fs.existsSync(hooksDir)) {
    throw new Error(
      `codex-guard emit refused: ${hooksDir} does not exist. The policy table is ` +
        `extracted from the TARGET's own hooks; run the engine apply for this target ` +
        `BEFORE this emit (coc-sync Step 4 precedes Step 6.6).`,
    );
  }
  if (!fs.existsSync(settingsPath)) {
    throw new Error(
      `codex-guard emit refused: ${settingsPath} does not exist. extractPolicies builds ` +
        `its hook-matcher map from settings.json and returns an EMPTY policy table ` +
        `without it — a fail-OPEN guard. settings.json is written by coc-sync Step 6, ` +
        `which MUST run before this emit (Step 6.6).`,
    );
  }

  inspectGuardInputTree(targetRoot, ".claude/hooks");
  inspectGuardPath(targetRoot, ".claude/settings.json", { required: true });
  const destDir = path.join(targetRoot, ".codex-mcp-guard");
  inspectGuardPath(targetRoot, ".codex-mcp-guard", { kind: "directory" });
  for (const name of [...delivery, ...CODEX_GUARD_GENERATED]) {
    inspectGuardPath(targetRoot, path.join(".codex-mcp-guard", name));
  }
  for (const { path: linkPath, target } of declared) {
    // Validate the declaration's destination and referent, not merely the text
    // of an existing link. A missing referent is created only after preflight.
    const referent = path.relative(targetRoot, path.resolve(targetRoot, path.dirname(linkPath), target));
    inspectGuardPath(targetRoot, referent, { kind: "directory" });
    const existing = inspectGuardPath(targetRoot, linkPath, { kind: "directory", linkTarget: target });
    if (existing && !existing.isSymbolicLink()) {
      throw new Error(`codex-guard emit refused: ${linkPath} is a real directory where the manifest declares a symlink; preserve it and resolve ownership before delivery`);
    }
  }
  fs.mkdirSync(destDir, { recursive: true });

  let copied = 0;
  const copiedNames = [];
  for (const name of delivery) {
    const src = path.join(guardSourceRoot, name);
    safeWriteFileSync(path.join(destDir, name), fs.readFileSync(src));
    fs.chmodSync(path.join(destDir, name), fs.statSync(src).mode & 0o777);
    copied++;
    copiedNames.push(name);
    if (verbose) console.log(`  codex-guard  ${name}`);
  }

  // REGENERATE against the target's own hooks — the whole point of this function.
  await emitMod.wireMcpPolicies(destDir, { sourceRoot: targetRoot, hooksDir, settingsPath });

  // All declared destinations were checked before the first write. An exact
  // existing consumer link is retained; no unexpected alias is followed/replaced.
  const made = [];
  for (const { path: linkPath, target } of declared) {
    const abs = path.join(targetRoot, linkPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) fs.symlinkSync(target, abs);
    made.push(`${linkPath} -> ${target}`);
    if (verbose) console.log(`  codex-guard  symlink ${linkPath} -> ${target}`);
  }

  return { emitted: true, reason: null, copied, files: copiedNames, symlinks: made };
}

/** MED-2 (v6): `emitCodexGuardTree` writes its WHOLE copy loop before
 * `wireMcpPolicies` runs, so a throw there leaves bytes ON DISK that nothing
 * has yet scanned — the top-level `main().catch` would exit with them in
 * place, and a planted value would sit in the target silently. This wrapper
 * scans the destination tree on the failure path with the same shared scanner
 * the success-path gate uses: an identity hit is reported as the refusal (the
 * more severe finding); otherwise the ORIGINAL error propagates unchanged. A
 * tree the emit never created scans as absent/clean, so pre-write refusals
 * behave exactly as before. */
async function emitCodexGuardTreeScanned(opts) {
  try {
    return await emitCodexGuardTree(opts);
  } catch (err) {
    const destDir = path.join(path.resolve(opts.targetRoot), ".codex-mcp-guard");
    // Scan ONLY a real directory: written bytes exist only if the emit's mkdir
    // + copy loop ran. A file/symlink destination can only exist on a PRE-write
    // refusal (the emit's own preflight refuses those shapes before writing),
    // where there is nothing of this run's to scan — and scanning it would
    // report the fixture's shape as an "UNREADABLE" halt, misattributed.
    let st = null;
    try {
      st = fs.lstatSync(destDir);
    } catch {
      /* absent: the emit refused before creating it */
    }
    if (st && st.isDirectory()) {
      try {
        assertTreeFreeOfPrivateIdentity(destDir, {
          label: "emit-cli-artifacts guard tree (failed emit)",
        });
      } catch (scanErr) {
        process.stderr.write(
          `emit-cli-artifacts: REFUSING — private identity in the guard tree written before the emit FAILED.\n${scanErr.message}\n`,
        );
        process.exit(1);
      }
    }
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────
// CLI entry
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  // `lane` defaults to "use", NOT "all" — mirroring emit-coc.mjs (loom#1699).
  // The lane is NOT inferable from --target (both lanes use the same target
  // keys), and "use" is the stricter default: it withholds MORE, so a caller
  // that forgets the flag can never widen the index past what the USE lane
  // ships. `loadLaneExclusions` THROWS on an unknown lane rather than degrading
  // to "no exclusions" (zero-tolerance.md Rule 3 — no silent fallback).
  const args = {
    out: null,
    cli: null,
    target: null,
    lane: "use",
    verbose: false,
    // loom#1870 — the DELIVERED tree root. Distinct from `--out`, which on the USE
    // lane is a staging dir the `.codex/` subtrees are later copied OUT of, and on
    // the BUILD lane IS the scratch worktree root. The guard tree must be written
    // where the target's `.claude/hooks` + `settings.json` live, so it cannot key
    // off `--out` unconditionally; it defaults to `--out` only when that directory
    // actually carries a `.claude/hooks/`, which is exactly the BUILD-lane case.
    targetRoot: null,
    templateType: "multi-cli",
    // loom#1870 follow-up — emit ONLY the `.codex-mcp-guard/` tree, into
    // `--target-root`, and skip the CLI emission entirely. This is the mode the
    // per-target delivery loop calls: the guard tree is written once PER DELIVERED
    // TREE (it is regenerated against THAT target's hooks), while the `.codex/` +
    // `.gemini/` emission is a single staging-dir pass reused across the loop. A
    // full re-emit per target to reach the guard block would be ~950 wasted file
    // writes per iteration. `--out` is NOT required here and is REFUSED if passed:
    // this mode writes nothing to a staging dir, so accepting the flag would let a
    // caller believe a CLI emit happened when none did.
    guardOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--cli") args.cli = argv[++i];
    else if (a === "--target") args.target = argv[++i];
    else if (a === "--lane") args.lane = argv[++i];
    else if (a === "--target-root") args.targetRoot = argv[++i];
    else if (a === "--template-type") args.templateType = argv[++i];
    else if (a === "--guard-only") args.guardOnly = true;
    else if (a === "-v" || a === "--verbose") args.verbose = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── MED-2 (v6): THE IDENTITY CONFIG PREFLIGHT RUNS BEFORE ANY WRITE. The
  // config assertion previously lived only inside the post-write gates, so a
  // distributor tree whose declaration was empty/malformed still REWROTE a
  // target's guard tree before refusing. Now the assertion precedes the first
  // write on EVERY path; a consumer tree (no config) announces its role here,
  // once, and the later post-write gates reuse the same notice flag.
  preflightPrivateIdentityConfig();

  // ────────────────────────────────────────────────────────────────
  // `--guard-only` — THE PRODUCER for `emitCodexGuardTree`.
  //
  // Handled BEFORE the `--out` requirement below, because this mode writes no
  // staging tree at all. Until this branch existed the guard emitter had NO caller:
  // `--target-root` was parsed, documented in the usage string, and passed by
  // nothing in `.claude/bin/**`, `.claude/hooks/**`, `scripts/**` or
  // `.github/workflows/**` (measured; control `--target ` fires in 20+ files), so
  // every run printed `codex-mcp-guard: SKIP`. That is the `artifact-stranding.md`
  // MUST-3 shape — a shipped, correct, fail-closed mechanism with no producer.
  //
  // Fail CLOSED on a missing `--target-root` rather than inferring one. The
  // inference this replaced (`--out` when it carried a `.claude/hooks/`) was
  // STRUCTURALLY DEAD: an `--out` holding `.claude/` is refused as a deployment
  // target ~137 lines earlier, so the two conditions are mutually exclusive by
  // construction and no invocation could satisfy both. Measured, both poles on one
  // tree: `--out <dir with .claude/hooks>` exits 2 with EMPTY stdout, while a clean
  // `--out` exits 0 and DOES print the guard line — so the missing line is genuine
  // non-reach, not an instrument that never emits it.
  //
  // `--out` is REFUSED here, not ignored. Accepting it would let a caller who meant
  // to do both emits in one command believe the CLI trees were written when this
  // mode wrote none — a silent half-delivery wearing the shape of a full one.
  if (args.guardOnly) {
    if (!args.targetRoot) {
      process.stderr.write(
        "emit-cli-artifacts: --guard-only requires --target-root <delivered-tree>.\n" +
          "  The policy table is extracted from the TARGET's own .claude/hooks/ +\n" +
          "  settings.json, so there is no safe default: emitting against loom's own\n" +
          "  hooks is precisely the staleness this mode exists to end.\n" +
          "  usage: emit-cli-artifacts.mjs --guard-only --target-root <dir> " +
          "[--template-type multi-cli|cc-only-legacy] [-v]\n",
      );
      process.exit(2);
    }
    if (args.out) {
      process.stderr.write(
        "emit-cli-artifacts: --guard-only does not take --out (got " +
          `"${args.out}"). This mode writes ONLY <target-root>/.codex-mcp-guard/ and\n` +
          "  emits no staging tree. Run the two emits as two commands so a skipped\n" +
          "  CLI emit cannot hide behind a successful guard emit.\n",
      );
      process.exit(2);
    }
    const guardReport = await emitCodexGuardTreeScanned({
      targetRoot: path.resolve(args.targetRoot),
      templateType: args.templateType,
      verbose: args.verbose,
    });
    // L4 (security read): the guard tree is a content EXIT too — the same
    // fail-closed gate and (role-split, r4-v4) config assertion the --out path
    // carries: armed when this tree has the config, else ONE informational line.
    // This is the call the red installed-consumer case exercised: a consumer
    // refresh must SUCCEED here, not refuse on a config it does not have.
    // Post-write halt (the #401 pattern): the tree on disk is real, the command
    // FAILS, and the operator fixes the source before re-running.
    try {
      assertEmittedTreeIdentityClean(path.join(path.resolve(args.targetRoot), ".codex-mcp-guard"));
    } catch (err) {
      process.stderr.write(
        `emit-cli-artifacts: REFUSING — private identity in the emitted guard tree.\n${err.message}\n`,
      );
      process.exit(1);
    }
    console.log("emit-cli-artifacts summary (--guard-only):");
    console.log(
      guardReport.emitted
        ? `  codex-mcp-guard: REGENERATED — ${guardReport.copied} runtime file(s) copied, ` +
            `policies.json + dump extracted from the TARGET's hooks, ` +
            `${guardReport.symlinks.length} declared symlink(s): ` +
            `${guardReport.symlinks.join(", ") || "(none)"}`
        : `  codex-mcp-guard: SKIP (NOT a pass) — ${guardReport.reason}`,
    );
    return;
  }

  if (!args.out) {
    process.stderr.write(
      "usage: emit-cli-artifacts.mjs --out <dir> [--cli codex|gemini] [--target py|rs|base] " +
        "[--lane use|build|all] [--target-root <delivered-tree>] " +
        "[--template-type multi-cli|cc-only-legacy] [-v]\n" +
        "       emit-cli-artifacts.mjs --guard-only --target-root <delivered-tree> " +
        "[--template-type multi-cli|cc-only-legacy] [-v]\n",
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
  // F92-b — the UNIVERSAL `exclude:` fence (classifyFile step 3). CLI-blind and
  // NOT hasTarget-gated; distinct from `loadExclusions()` above, which is the
  // PER-CLI `cli_emit_exclusions` axis each emitter applies in its own branch.
  const universalExclude = loadUniversalExclude();
  // W3-d — per-artifact positive role restriction.
  //
  // READ VIA THE DIAGNOSTIC LOADER, AND FAIL CLOSED. The map-only
  // `loadSurfaceRoles()` this call site used until now returns
  // `parseSurfaceRolesStanza(...).entries` and DISCARDS the `unparsed` array
  // (`lib/coc-manifest.mjs:684-693`; the diagnostic sibling that keeps it is
  // `lib/coc-manifest.mjs:699-701`), so a stanza line the parser cannot read
  // arrived here as an entry that was simply ABSENT — and absent means
  // DEFAULT-SURFACED at every role (`lib/coc-manifest.mjs:831-836`).
  //
  // That made the two halves of the same authority disagree. `check-invoker-
  // audience.mjs` reads the SAME stanza through `loadSurfaceRolesDiagnostics()`
  // and REFUSES (`UNRUN`, exit 2) on any unparsed line
  // (`check-invoker-audience.mjs:1054-1070`). So a form the AUDIT
  // rejected was EMITTED, silently and wrongly, to every consumer — the refusal
  // and the distribution disagreeing about the same bytes, with distribution
  // winning. MEASURED through the real exported parser against the live
  // manifest, one entry rewritten per form, `commands/analyze.md` as subject:
  //
  //   inline flow / block sequence / trailing comment -> READ (19 entries)
  //   bare scalar `key: build`                        -> dropped (18, 1 unparsed)
  //   4-space indent                                  -> dropped (18, 1 unparsed)
  //   anchor/alias `key: &a [..]`                     -> dropped (18, 1 unparsed)
  //   nested mapping `key:` / `  roles: [..]`         -> dropped (18, 2 unparsed)
  //
  // Four of the six forms, each landing in `unparsed` — i.e. the information
  // needed to refuse was computed and then thrown away at this line. The
  // consequence is FAIL-OPEN and directional, measured on the same subject
  // through `surfaceRolesAllow`: for role `platform` the verdict flips
  // false -> TRUE on the drop, while `build`/`use-consumer` are unchanged. The
  // one thing a dropped entry can do is SURFACE a command the manifest
  // de-surfaced. That is `feedback_emit_cli_ignores_exclude` / #638 arriving
  // through a second door: not an `exclude:` the emitter ignores, but a
  // `surface_roles:` entry the emitter could not read and did not mention.
  //
  // The trigger is `unparsed`, NOT an empty map, and that distinction is
  // load-bearing for the classes this module ships to verbatim (loom#1386).
  // `readManifestSource` returns `null` where the manifest is EXPECTED-absent
  // (`lib/manifest-source.mjs:528-539`; the three forbidden classes are declared
  // at `lib/manifest-source.mjs:256-260`) and the parser maps null to
  // `{ entries: {}, unparsed: [] }` (`lib/coc-manifest.mjs:738-739`), so an
  // expected-absent manifest does NOT trip this refusal. An empty map is also
  // left alone here for the reason `loadSurfaceRoles` records: with no
  // `--target` the role is null and `surfaceRolesAllow` short-circuits true, and
  // WITH a `--target` the D3 sibling `loadTargetRole` refuses before any role
  // can be resolved. Unreadable LINES are the case neither guard covers, and
  // they are the case that ships wrong bytes.
  const surfaceRolesDiag = loadSurfaceRolesDiagnostics();
  const surfaceRolesRefusal = surfaceRolesRefusalMessage(surfaceRolesDiag.unparsed);
  if (surfaceRolesRefusal !== null) {
    process.stderr.write(surfaceRolesRefusal);
    process.exit(2);
  }
  const surfaceRoles = surfaceRolesDiag.entries;
  const targetRole = loadTargetRole(args.target); // null when --target absent OR role unset (py/rs)
  const tierFilter = buildTierFilter(args.target); // null when --target absent
  const lang = loadTargetVariant(args.target); // null when --target absent or variant unset
  const laneExclude = loadLaneExclusions(args.lane); // THROWS on an unknown lane
  // F92 — lane fate is a property of a DELIVERY TO a target. loom's own
  // `.codex/`/`.gemini/` trees (no --target) are NOT a delivery, so the oracle
  // must not withhold from them what the USE lane withholds from a consumer.
  // A STRICT null check here diverged from every sibling loader (buildTierFilter /
  // loadTargetRole / loadTargetVariant all use `if (!target) return null`), and
  // `parseArgs` assigns `argv[++i]` — so a TRAILING `--target` yields `undefined`:
  // tierFilter/targetRole/lang all null (ABSENT semantics) while `hasTarget` stayed
  // true, defaulting the lane to "use" and withholding every use_exclude'd artifact
  // from loom's OWN self-emit. Measured on the strict form: 5 rules
  // (coc-artifact-eval-coverage, cross-repo, cross-sdk-inspection, documentation,
  // loom-csq-boundary) stripped from loom's own rules-reference index — the F93
  // regression class re-entered through an inconsistent absence predicate.
  const hasTarget = Boolean(args.target);
  const outDir = path.resolve(args.out);

  // `--out` IS A STAGING DIRECTORY, never a deployment target. This emitter writes
  // the FINAL dotted `.codex/` + `.gemini/` roots (`CLI_ROOTS` above); it has NOT
  // written undotted `codex/` + `gemini/` subtrees since 15fcfd4f retired that
  // staging layout. coc-sync Step 6.6 COPIES the emitted subtrees into the target
  // NEXT TO the files this emitter never produces — `.codex/config.toml` +
  // `hooks.json` from `codex-templates/`, and the per-target MCP guard via
  // `--guard-only` — and validate-emit.mjs resolves the same dotted roots through
  // the imported `cliRoot`. Pointing `--out` at a live repo therefore writes
  // emitter-owned files straight into the trees the CLIs load while SKIPPING that
  // step, and the summary below still reports rising counts. The fence was first
  // written against the pre-15fcfd4f layout, where the same misuse left the dotted
  // trees STALE and littered stray undotted dirs under a green gate
  // (`sync-completeness.md` Rule 8); it was caught once only because a human
  // noticed the emitter's counts disagreed with `git status`.
  //
  // REFUSE rather than warn. Every sanctioned caller emits into a fresh scratch
  // dir — coc-sync Step 6.6 (`mktemp -d`), migrate.md and
  // multi-cli-migration.md (`$EMIT_TMP`), validate-emit.mjs::emitFresh and every
  // test suite (`mkdtempSync`) — so this cannot false-positive on them. And a
  // warning is precisely what the `output:` line below already was at the moment
  // the misuse went unnoticed. Same fail-closed shape as sync-gate2-worktree.mjs's
  // exit-2 refusal of a bare single-shot `build_multi_cli` run.
  //
  // Checked BEFORE mkdir, so a not-yet-created scratch dir carries no signal of its
  // own — which is exactly why the `.git` probe WALKS UP rather than testing `outDir`
  // alone. An adversarial audit measured the outDir-only form letting three cases
  // through: `--out <repo>/docs` (950 files written, `git status` showing a stray
  // `?? docs/`), `--out <repo>/not-yet-created`, and — the sharp one — `--out .` with
  // the shell sitting in a repo SUBdirectory. That last is the same operator slip this
  // fence exists for, one directory down. A deployment target is any path INSIDE a
  // working tree, not only the tree's root.
  //
  // Safe against the scratch dirs every sanctioned caller uses: measured, no ancestor
  // of an `os.tmpdir()` path carries a `.git`, and the walk terminates at the
  // filesystem root. `fs.existsSync` deliberately does not distinguish file from
  // directory — in a LINKED worktree `.git` is a FILE, and that case is pinned by test.
  const deploymentSignals = [];
  for (let probe = outDir; ; ) {
    if (fs.existsSync(path.join(probe, ".git"))) {
      deploymentSignals.push(
        probe === outDir ? ".git" : `.git (in ancestor ${probe})`,
      );
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break; // filesystem root
    probe = parent;
  }
  // `.claude` closes the remaining window: a live deployment target that has not been
  // `git init`'d yet carries neither `.git` nor a dotted CLI tree, yet is exactly the
  // deployment-target case (measured under the pre-15fcfd4f undotted layout: `ls` →
  // `codex gemini`, dotted `.codex` absent).
  // Narrow in practice — a real target is already a clone — but it is a real hole.
  // Present in every deployment target, absent from every scratch dir.
  for (const dotted of [".claude", ".codex", ".agents", ".gemini"]) {
    if (fs.existsSync(path.join(outDir, dotted))) deploymentSignals.push(`${dotted}/`);
  }
  if (deploymentSignals.length > 0) {
    process.stderr.write(
      "emit-cli-artifacts: --out must be a STAGING directory, not a deployment target.\n" +
        `  refused:  ${outDir}\n` +
        `  detected: ${deploymentSignals.join(", ")} — this is a repo/worktree root.\n` +
        "  This emitter writes the FINAL .codex/ + .agents/skills/ + .gemini/ roots. Writing them here would\n" +
        "  skip coc-sync Step 6.6 (template config + MCP guard delivery) while reporting success.\n" +
        "  Use the scratch-then-copy pattern (coc-sync.md Step 6.6):\n" +
        '    EMIT_OUT=$(mktemp -d)\n' +
        '    node .claude/bin/emit-cli-artifacts.mjs --target <t> --out "$EMIT_OUT"\n' +
        '    cp -r "$EMIT_OUT"/.codex/{prompts,agents}          <target>/.codex/\n' +
        '    cp -r "$EMIT_OUT"/.gemini/{commands,skills,agents} <target>/.gemini/\n',
    );
    process.exit(2);
  }

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
    commands: emitCommands({ outDir, exclusions, tierFilter, loomOnly, universalExclude, surfaceRoles, targetRole, lang, laneExclude, hasTarget, verbose: args.verbose }),
    skills: emitSkills({ outDir, exclusions, tierFilter, loomOnly, universalExclude, surfaceRoles, targetRole, lang, laneExclude, hasTarget, verbose: args.verbose }),
    rulesReference: emitRulesReferenceSkill({ outDir, exclusions, tierFilter, loomOnly, universalExclude, surfaceRoles, targetRole, lang, laneExclude, hasTarget, verbose: args.verbose }),
    codexAgentPrompts:
      onlyCli === "gemini"
        ? { codex: 0, skipped: 0, fateSkipped: [] }
        : emitCodexAgentPrompts({ outDir, exclusions, tierFilter, loomOnly, universalExclude, surfaceRoles, targetRole, lang, laneExclude, hasTarget, verbose: args.verbose }),
    geminiAgents:
      onlyCli === "codex"
        ? { gemini: 0, skipped: 0, fateSkipped: [] }
        : emitGeminiAgents({ outDir, exclusions, tierFilter, loomOnly, universalExclude, surfaceRoles, targetRole, lang, laneExclude, hasTarget, verbose: args.verbose }),
  };

  // Apply --cli filter after the fact: if onlyCli is set, delete the
  // other CLI's output tree. Simpler than threading the filter through
  // every emitter and keeps emission logic straightforward.
  if (onlyCli === "codex") {
    const geminiDir = path.join(outDir, cliRoot("gemini"));
    if (fs.existsSync(geminiDir))
      fs.rmSync(geminiDir, { recursive: true, force: true });
  } else if (onlyCli === "gemini") {
    const codexDir = path.join(outDir, cliRoot("codex"));
    if (fs.existsSync(codexDir))
      fs.rmSync(codexDir, { recursive: true, force: true });
    const skillsDir = path.join(outDir, ".agents");
    if (fs.existsSync(skillsDir)) fs.rmSync(skillsDir, { recursive: true, force: true });
  }

  // ── loom#1930: fail-closed disclosure sweep over the EMITTED tree ──
  //
  // The rewrites in strip-build-internal.mjs can only strip names they KNOW.
  // The CRITICAL leak that opened #1930 was a pair of names loom cannot know:
  // `workspaces/use-feedback-triage/…` and `workspaces/issue-781-todo-nnn-cleanup/`
  // rode in inside artifacts synced from BUILD/USE repos, and appear nowhere in
  // loom's `workspaces/` directory or its git history. Both reached the shipped
  // `.codex/` and `.gemini/` trees. No derivation closes that class — only a
  // refusal does.
  //
  // Why HERE and not in `writeTextArtifactSync`: that helper is shared with
  // emit.mjs and writes surfaces (loom's own `.claude/` composition) that
  // legitimately name loom workspaces. The CLI trees are the SHIPPING surface,
  // and this is the last point at which the whole of that surface is in hand.
  //
  // FAIL-CLOSED means: the run exits non-zero and the caller
  // (check-cli-emit-drift / the operator's re-emit) never promotes the tree into
  // the committed `.codex/`/`.gemini/` directories. The scratch --out dir is
  // deliberately left on disk so the offending file can be read.
  const undisclosed = [];
  for (const emittedRoot of [".codex", ".agents", ".gemini"]) {
    const root = path.join(outDir, emittedRoot);
    const walk = (dir) => {
      let ents;
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(abs);
        } else if (e.isFile()) {
          let text;
          try {
            text = fs.readFileSync(abs, "utf8");
          } catch {
            continue;
          }
          try {
            assertNoUnclassifiedWorkspaceRef(text, {
              file: path.relative(outDir, abs),
            });
          } catch (err) {
            if (err instanceof WorkspaceDisclosureError) {
              undisclosed.push(`${path.relative(outDir, abs)}: ${err.names.join(", ")}`);
            } else {
              throw err;
            }
          }
        }
      }
    };
    walk(root);
  }
  if (undisclosed.length) {
    process.stderr.write(
      `emit-cli-artifacts: REFUSING — ${undisclosed.length} emitted file(s) name an UNCLASSIFIED workspace:\n` +
        undisclosed.map((r) => `  - ${r}\n`).join("") +
        "Classify each name in .claude/bin/lib/loom-workspace-names.json:\n" +
        "  real internal workspace   -> append to `strip`    (it will be scrubbed)\n" +
        "  placeholder / meta-dir    -> append to `preserve`  (it will ship verbatim)\n" +
        "The emitted tree was NOT promoted. Nothing under .codex/ or .gemini/ changed.\n",
    );
    process.exit(1);
  }

  // ── THE PRIVATE-IDENTITY GATE (Tier-1 r4, 2026-10-04) — the SAME fail-closed
  // point and the SAME convention as the #1930 sweep above: the scratch --out
  // tree IS the shipping surface, and this is the last moment the whole of it is
  // in hand. The guarantee is the ONE shared scanner (raw bytes AND every path
  // component, symlink targets included; unreadable entries halt; the stated
  // raw-byte / ASCII-case limit lives in strip-build-internal.mjs). ROLE SPLIT
  // (r4-v4): armed when this tree CARRIES canon-identity-values.json
  // (distributor shape — config, never repo class); a consumer-shaped tree
  // without one gets ONE informational line and the empty-set scan (see
  // assertEmittedTreeIdentityClean).
  try {
    assertEmittedTreeIdentityClean(outDir);
  } catch (err) {
    process.stderr.write(
      `emit-cli-artifacts: REFUSING — private identity in the emitted tree.\n` +
        `${err.message}\n` +
        `The emitted tree was NOT promoted. Nothing under .codex/ or .gemini/ changed.\n`,
    );
    process.exit(1);
  }

  // ORDERING (merge of loom#1930 into loom#1870): the disclosure sweep above runs
  // FIRST and BEFORE the guard-tree emit below. The sweep is a fail-CLOSED refusal
  // that exits non-zero so the scratch tree is never promoted; the guard emit is the
  // only step here that writes OUTSIDE the scratch --out dir (into the delivered
  // target's `.codex-mcp-guard/` plus its declared symlink). Emitting the guard
  // before the refusal would leave a half-delivered target behind a run that
  // refused — so this order preserves #1930's guarantee rather than weakening it.
  // loom#1870 — the `.codex-mcp-guard/` tree, REGENERATED against the target's own
  // hooks. Gated on the codex lane being in scope, and on a resolvable delivered
  // tree root. A SKIP here is announced as a SKIP and never as a pass: the whole
  // defect this closes was a delivery step that silently did not happen, so a
  // reader must be able to tell "regenerated" from "not run" in the summary.
  let guard = { emitted: false, reason: null, copied: 0, symlinks: [] };
  if (onlyCli === "gemini") {
    guard.reason = "--cli gemini (codex lane out of scope)";
  } else {
    // The `--out`-inference that used to sit here was STRUCTURALLY DEAD and is
    // removed rather than left as reassuring-looking cover. It fired only when
    // `--out` carried a `.claude/hooks/` — but an `--out` holding `.claude/` is
    // refused as a deployment target ~137 lines above, exit 2, before this line is
    // ever reached. Measured on this tree: that input exits 2 with EMPTY stdout,
    // while a clean `--out` exits 0 and prints this block's SKIP line. Keeping a
    // branch that cannot fire made the guard emitter look wired to every reader who
    // checked, which is why it stayed stranded through several audits.
    const inferred = args.targetRoot;
    if (!inferred) {
      guard.reason =
        "no --target-root (deliver the guard tree with --guard-only --target-root <dir>)";
    } else if (args.templateType !== "multi-cli") {
      guard.reason = `--template-type ${args.templateType} declares no codex guard tree`;
    } else {
      guard = await emitCodexGuardTreeScanned({
        targetRoot: path.resolve(inferred),
        templateType: args.templateType,
        verbose: args.verbose,
      });
    }
  }

  // F1 (security read): the guard tree is the LAST write on this path and it
  // writes OUTSIDE the gated scratch — so the identity gate runs again HERE,
  // after it, on the guard tree itself. The earlier gate still protects the
  // scratch from being promoted; this one closes F1's "gate before the last
  // write" gap without inverting the #1930 half-delivery guarantee (a dirty
  // guard tree halts post-write, the #401 pattern; the tree is regenerated,
  // never branched).
  if (guard && guard.emitted && args.targetRoot) {
    try {
      assertEmittedTreeIdentityClean(path.join(path.resolve(args.targetRoot), ".codex-mcp-guard"));
    } catch (err) {
      process.stderr.write(
        `emit-cli-artifacts: REFUSING — private identity in the emitted guard tree (the last write).\n${err.message}\n`,
      );
      process.exit(1);
    }
  }

  console.log("emit-cli-artifacts summary:");
  console.log(
    `  codex:  prompts=${report.commands.codex} skills=${report.skills.codex} agents=${report.codexAgentPrompts.codex} (plus compatibility prompts)`,
  );
  console.log(
    guard.emitted
      ? `  codex-mcp-guard: REGENERATED — ${guard.copied} runtime file(s) copied, ` +
          `policies.json + dump extracted from the TARGET's hooks, ` +
          `${guard.symlinks.length} declared symlink(s): ${guard.symlinks.join(", ") || "(none)"}`
      : `  codex-mcp-guard: SKIP (NOT a pass) — ${guard.reason}`,
  );
  console.log(
    `  gemini: commands=${report.commands.gemini} skills=${report.skills.gemini} agents=${report.geminiAgents.gemini}`,
  );
  console.log(
    `  rules-reference skill: codex=${report.rulesReference.codex} gemini=${report.rulesReference.gemini} (${report.rulesReference.rules} path-scoped rules indexed) [#408 AC#5-b]`,
  );
  // Print the lane UNCONDITIONALLY (the emit-coc.mjs loom#1699 contract): the
  // lane is not inferable from --target, so a wrong-lane emit is otherwise
  // invisible in the transcript — and this index is the ONLY delivery channel
  // path-scoped rules have on Codex/Gemini, so a silently wrong lane silently
  // changes what those CLIs are governed by.
  console.log(
    `  rules-reference lane: ${args.lane} (variant=${lang || "(none)"}; withheld by lane fate: ${report.rulesReference.laneSkipped.length})`,
  );
  console.log(
    `  skipped (exclusions): commands=${report.commands.skipped} skills=${report.skills.skipped} codex-agent-prompts=${report.codexAgentPrompts.skipped} gemini-agents=${report.geminiAgents.skipped}`,
  );
  // Print the WITHHELD LIST IN FULL for the four command/skill/agent surfaces,
  // mirroring the rules-reference index above. Before this, four of the five
  // surfaces dropped artifacts into `stats.skipped` and printed nothing but a
  // tally — so the NEXT instance of the F92/F93 class (a distribution fence
  // firing where it should not, or not firing where it should) would again be
  // invisible in the transcript. Only the distribution-FATE reasons are listed;
  // the expected high-volume classes stay in the tally above.
  for (const [surface, st] of [
    ["commands", report.commands],
    ["skills", report.skills],
    ["codex-agent-prompts", report.codexAgentPrompts],
    ["gemini-agents", report.geminiAgents],
  ]) {
    const withheld = st.fateSkipped || [];
    if (withheld.length === 0) continue;
    process.stderr.write(
      `emit-cli-artifacts: ${surface} withheld ${withheld.length} artifact(s) by distribution fate:\n` +
        withheld.map((r) => `  - ${r}\n`).join(""),
    );
  }
  console.log(`  output: ${outDir}`);
}

// Only run if invoked directly; support `import` in tests.
// ── MED-2 (v6) TDZ NOTE — WHY THESE DECLARATIONS LIVE *ABOVE* main()'s CALL ─
// `main()` is invoked synchronously while this module is still evaluating (the
// `isMainModule` block directly below), and its FIRST statement is the identity
// preflight. A `const`/`let` declared further down the file is in its TEMPORAL
// DEAD ZONE at that moment: the predicate's argument evaluation throws
// `ReferenceError: Cannot access 'CANON_IDENTITY_CONFIG' before initialization`,
// the predicate's catch maps a code-less error to "present", and a CONSUMER tree
// (no config) was refused with the distributor's EMPTY-set error — measured on
// the installed-consumer fixture, 2026-10-05. Declarations the synchronous head
// of main() reads therefore precede the entry-point block.
//
// The path mirrors `strip-build-internal.mjs::CANON_IDENTITY_REL`
// (`<.claude>/canon-identity-values.json`), the SAME file `orgSets()` reads.
const CANON_IDENTITY_CONFIG = path.join(REPO, ".claude", "canon-identity-values.json");
let _consumerIdentityNoticeEmitted = false;

// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; a lexical compare exits 0 silently).
if (isMainModule(import.meta.url)) {
  // `main` is async since loom#1870 (the guard-tree emit dynamically imports
  // the extractor, exactly as emit.mjs does, so a cc-only template that ships
  // this always_include emitter but no codex surface never hits a static
  // import). A synchronous `try { main(); } catch` CANNOT observe an async
  // rejection — it would surface as an unhandled rejection whose exit code is
  // a runtime-flag detail rather than this script's declared contract. The
  // loom#1930 realpath guard above is unaffected: it decides WHETHER to run,
  // this decides how a failure of that run is reported.
  main().catch((err) => {
    process.stderr.write(`emit-cli-artifacts: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

// ── ROLE SPLIT (correctness r4-v4, item 6): DISTRIBUTOR vs CONSUMER ─────────
// The CONFIG assertion is a DISTRIBUTOR obligation, not a consumer one. Canon's
// distribution entrypoints assert on THEIR side of the boundary before this
// emitter's output is delivered anywhere — Gate-2 (`sync-gate2-worktree.mjs::main`
// entry + `assertFinalizeIdentityClean`), publish-to-public,
// publish-to-private-template, edition-emit, fork-conference-pack,
// seed-build-target. A CONSUMER runs THIS module from its OWN tree (`/migrate`
// Step 6, a USE template's re-emit), where `.claude/canon-identity-values.json`
// legitimately does not exist — asserting there refused EVERY consumer refresh
// with a "private-slug gate would be vacuous" error the consumer cannot act on
// (the red `codex-guard-producer` installed-consumer case; breaks `/migrate`
// Step 6 + template refresh). So: assert the config ONLY when it EXISTS; when it
// is absent, say so in ONE informational line and still run the identity SCAN —
// the empty private set makes that scan vacuous BY CONSTRUCTION (a consumer has
// no canon private slugs to leak), never disarmed, because the arming that
// matters happened at the distributor.
//
// The state this predicate reads (`CANON_IDENTITY_CONFIG`, the notice flag)
// is declared ABOVE the entry-point check — see the TDZ note there; main()
// runs during module evaluation, so a declaration below its call site is
// still uninitialized at the synchronous head of main().
function canonIdentityConfigPresent() {
  try {
    fs.accessSync(CANON_IDENTITY_CONFIG, fs.constants.F_OK);
    return true;
  } catch (e) {
    // ENOENT alone is the consumer case. Any OTHER access failure (EACCES, …)
    // is treated as PRESENT so the assert path runs and fails closed on the
    // read error rather than silently classifying a distributor tree as a
    // consumer one (the L1 lesson: only absence is benign).
    return !(e && e.code === "ENOENT");
  }
}

/** MED-2 (v6): the ONE preflight every path in main() runs BEFORE its first
 * write — the config assertion (distributor-shaped tree) or the single
 * consumer-role notice (deduped). The post-write gates call it too, so the
 * config is re-checked on every gate without ever printing a second notice. */
function preflightPrivateIdentityConfig() {
  if (canonIdentityConfigPresent()) {
    assertPrivateOrgConfig();
  } else if (!_consumerIdentityNoticeEmitted) {
    _consumerIdentityNoticeEmitted = true;
    console.log(
      "emit-cli-artifacts: consumer role — no .claude/canon-identity-values.json in this tree; the " +
        "private-identity CONFIG assertion is not armed here (it runs at canon's distribution " +
        "entrypoints) and the emitted-tree scan runs with the empty private set.",
    );
  }
}

/** The r4 identity gate for this exit, as a NAMED export (security read): the
 * wiring test binds the CALL SITE, and the permanent plant case drives THIS
 * function over a planted/clean fixture tree. ROLE SPLIT (r4-v4, item 6): the
 * config is asserted only when a config EXISTS (distributor-shaped tree); a
 * consumer-shaped tree without one gets ONE informational line and the
 * empty-set scan. MED-2 (v6): it delegates the config/notice half to the
 * preflight, which main() also runs before its first write. */
export function assertEmittedTreeIdentityClean(outDir) {
  preflightPrivateIdentityConfig();
  assertTreeFreeOfPrivateIdentity(outDir, { label: "emit-cli-artifacts --out tree" });
}

export {
  REPO,
  safeWriteFileSync,
  ensureTrailingNewline,
  writeTextArtifactSync,
  loadExclusions,
  loadLaneExclusions,
  loadVariantOnly,
  loadLoomOnly,
  loadTiers,
  loadTargetTierSubscriptions,
  loadTargetVariant,
  buildTierFilter,
  collectRuleSources,
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
