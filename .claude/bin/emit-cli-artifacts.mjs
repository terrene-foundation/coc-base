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
 *     prompts/specialist-<name>.md        per non-excluded .claude/agents (recursive)
 *                                         deterministic delegation shim — Codex has no
 *                                         native specialist-by-name dispatch; the prompt
 *                                         loads the operating spec into context via
 *                                         /prompts:specialist-<name>
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
 * py/rs/rb targets). Per commands/sync.md Gate 2 step 3, missing/empty
 * tier_subscriptions is a manifest defect that MUST halt the sync.
 *
 * Exit codes: 0 = success, 1 = emission failure, 2 = usage error.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyOverlay } from "./lib/slot-parser.mjs";
import { resolveOverlay } from "./lib/variant-overlay.mjs";
import { stripBuildInternalReferences } from "./lib/strip-build-internal.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");

// ────────────────────────────────────────────────────────────────
// Symlink-safe write (mirrors emit.mjs to keep TOCTOU closed)
// ────────────────────────────────────────────────────────────────
function safeWriteFileSync(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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

// ────────────────────────────────────────────────────────────────
// Glob matcher (subset: ** and * against POSIX paths)
// ────────────────────────────────────────────────────────────────
// Matches patterns like:
//   skills/30-claude-code-patterns/**   → prefix match
//   agents/cc-architect.md              → exact match
//   commands/cc-audit.md                → exact match
//   guides/claude-code/**               → prefix match
function globToRegex(glob) {
  // Escape regex metacharacters, then re-expand glob tokens.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withStars = escaped
    .replace(/\*\*/g, "__DOUBLESTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLESTAR__/g, ".*");
  return new RegExp(`^${withStars}$`);
}

function matchesAnyGlob(relPath, globs) {
  for (const g of globs) {
    if (globToRegex(g).test(relPath)) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────
// sync-manifest.yaml → cli_emit_exclusions
// ────────────────────────────────────────────────────────────────
// Minimal YAML reader scoped to the exclusions stanza. We don't pull in
// a YAML library — the structure here is simple enough (two lists of
// strings) that line-oriented parsing is safe. Falls back to empty
// arrays if the stanza is missing so the emitter never silently does
// the wrong thing (exclusions absent → emit everything → caller sees
// unexpected files and investigates).
function loadExclusions() {
  const manifestPath = path.join(REPO, ".claude", "sync-manifest.yaml");
  const src = fs.readFileSync(manifestPath, "utf8");
  const lines = src.split("\n");

  const result = { codex: [], gemini: [] };
  let inStanza = false;
  let currentCli = null;

  for (const line of lines) {
    if (/^cli_emit_exclusions:\s*$/.test(line)) {
      inStanza = true;
      continue;
    }
    if (!inStanza) continue;

    // End of stanza: a new top-level key (column 0, ends with :)
    if (/^[a-zA-Z_][^:]*:\s*$/.test(line) && !line.startsWith(" ")) {
      break;
    }

    // CLI key (2-space indent)
    const cliMatch = line.match(/^ {2}([a-z]+):\s*$/);
    if (cliMatch) {
      currentCli = cliMatch[1];
      if (!(currentCli in result)) result[currentCli] = [];
      continue;
    }

    // List entry (4-space indent, leading dash)
    const entryMatch = line.match(/^ {4}-\s*(.+?)\s*$/);
    if (entryMatch && currentCli) {
      // Strip surrounding quotes if present
      const val = entryMatch[1].replace(/^["']|["']$/g, "");
      result[currentCli].push(val);
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────
// sync-manifest.yaml → tiers.* (top-level tier → glob list)
// ────────────────────────────────────────────────────────────────
// Mirrors loadExclusions: line-oriented parsing, no YAML library. The
// tiers stanza is structurally identical to cli_emit_exclusions (a
// top-level key with sub-keys whose values are list-of-string).
function loadTiers() {
  const manifestPath = path.join(REPO, ".claude", "sync-manifest.yaml");
  const src = fs.readFileSync(manifestPath, "utf8");
  const lines = src.split("\n");

  const result = {};
  let inStanza = false;
  let currentTier = null;

  for (const line of lines) {
    if (/^tiers:\s*$/.test(line)) {
      inStanza = true;
      continue;
    }
    if (!inStanza) continue;

    // End of stanza: a new top-level key (column 0, ends with :)
    if (/^[a-zA-Z_][^:]*:\s*$/.test(line) && !line.startsWith(" ")) {
      break;
    }

    // Tier key (2-space indent)
    const tierMatch = line.match(/^ {2}([a-zA-Z_][\w-]*):\s*$/);
    if (tierMatch) {
      currentTier = tierMatch[1];
      result[currentTier] = [];
      continue;
    }

    // List entry (4-space indent, leading dash). Skip comments.
    const entryMatch = line.match(/^ {4}-\s*(.+?)\s*$/);
    if (entryMatch && currentTier) {
      const val = entryMatch[1].replace(/^["']|["']$/g, "");
      // Strip trailing inline comments (` # ...`)
      const cleaned = val.replace(/\s+#.*$/, "").trim();
      if (cleaned) result[currentTier].push(cleaned);
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────
// sync-manifest.yaml → repos.<target>.tier_subscriptions
// ────────────────────────────────────────────────────────────────
// Returns the ordered list of tier names the named target subscribes to.
// Inline-list form: `tier_subscriptions: [cc, co, coc]`.
// Returns null if the target is unknown (caller decides whether to halt).
// Returns empty array [] if the target declares an empty subscription
// (e.g. retired prism — manifest declares [] structurally).
function loadTargetTierSubscriptions(target) {
  const manifestPath = path.join(REPO, ".claude", "sync-manifest.yaml");
  const src = fs.readFileSync(manifestPath, "utf8");
  const lines = src.split("\n");

  let inRepos = false;
  let inTarget = false;

  for (const line of lines) {
    if (/^repos:\s*$/.test(line)) {
      inRepos = true;
      continue;
    }
    if (!inRepos) continue;

    // End of repos stanza: new top-level key
    if (/^[a-zA-Z_][^:]*:\s*$/.test(line) && !line.startsWith(" ")) {
      break;
    }

    // Target key (2-space indent, e.g. "  py:")
    const targetMatch = line.match(/^ {2}([a-zA-Z_][\w-]*):\s*$/);
    if (targetMatch) {
      inTarget = targetMatch[1] === target;
      continue;
    }

    // tier_subscriptions inline list (4-space indent under target)
    if (inTarget) {
      const tsMatch = line.match(/^ {4}tier_subscriptions:\s*\[(.*?)\]\s*$/);
      if (tsMatch) {
        return tsMatch[1]
          .split(",")
          .map((t) => t.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      }
    }
  }

  return null;
}

// ────────────────────────────────────────────────────────────────
// sync-manifest.yaml → repos.<target>.variant
// ────────────────────────────────────────────────────────────────
// Returns the language-axis variant slug (py / rs / rb / base / null).
// The variant determines which `variants/<lang>/...` overlay tree applies
// when composing per-CLI artifacts (commands, skills, agents) for the
// target's language axis. Returns null when target is unknown OR when
// repos.<target>.variant is absent.
function loadTargetVariant(target) {
  if (!target) return null;
  const manifestPath = path.join(REPO, ".claude", "sync-manifest.yaml");
  const src = fs.readFileSync(manifestPath, "utf8");
  const lines = src.split("\n");

  let inRepos = false;
  let inTarget = false;
  for (const line of lines) {
    if (/^repos:\s*$/.test(line)) {
      inRepos = true;
      continue;
    }
    if (!inRepos) continue;
    if (/^[a-zA-Z_][^:]*:\s*$/.test(line) && !line.startsWith(" ")) {
      break;
    }
    const targetMatch = line.match(/^ {2}([a-zA-Z_][\w-]*):\s*$/);
    if (targetMatch) {
      inTarget = targetMatch[1] === target;
      continue;
    }
    if (inTarget) {
      const vMatch = line.match(/^ {4}variant:\s*(.+?)\s*$/);
      if (vMatch) {
        return vMatch[1].replace(/^["']|["']$/g, "");
      }
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// composeArtifactBody — apply variant overlays to a non-rule artifact
// ────────────────────────────────────────────────────────────────
// Mirrors emit.mjs::composeRule for the commands/skills/agents axes.
// Resolution order (each layer composed on top of the previous):
//   1. Global at .claude/<category>/<relPath> (required base)
//   2. Language overlay  variants/<lang>/<category>/<relPath>
//   3. CLI overlay       variants/<cli>/<category>/<relPath>
//   4. Ternary overlay   variants/<lang>-<cli>/<category>/<relPath>
//
// Two overlay forms are supported (auto-detected per file):
//   - Slot-keyed: file contains `<!-- slot:NAME -->` markers; composed
//                 via slot-parser::applyOverlay (slot bodies replace
//                 matching slots in the running composed body).
//   - Full-file:  variant file is the deployed content; replaces
//                 composed body entirely (no slot markers present).
//
// Returns the composed body string. Caller is responsible for parsing
// frontmatter from the returned body (frontmatter may differ between
// global and full-file variant — variant wins on full-file, slot
// composition preserves global frontmatter unless slots cover it).
//
// Without `lang` (legacy emit-everything mode), only the CLI-axis
// overlay is applied.
//
// Return shape: { body, destRelPath } | null
//   body:        composed file content
//   destRelPath: relPath on the destination tree. Equals input relPath UNLESS
//                the manifest declares an explicit overlay whose basename
//                differs from the global (true rename — e.g.
//                skills/.../python-version-bump.md → rust-version-bump.md on rs).
//
// Overlay resolution per axis uses resolveOverlay() from lib/variant-overlay.mjs:
//   - manifest-explicit + file missing → halt (manifest defect)
//   - manifest-null                    → skip overlay for this axis
//   - manifest-explicit / path-mirror  → apply if file exists
function composeArtifactBody(category, relPath, cli, lang) {
  const globalPath = path.join(REPO, ".claude", category, relPath);
  if (!fs.existsSync(globalPath)) return null;
  let composed = fs.readFileSync(globalPath, "utf8");
  let destRelPath = relPath;

  const axes = [];
  if (lang) axes.push(lang);
  if (cli) axes.push(cli);
  if (lang && cli) axes.push(`${lang}-${cli}`);

  for (const axis of axes) {
    const res = resolveOverlay(category, relPath, axis);
    if (res.kind === "manifest-null") continue;
    if (!fs.existsSync(res.path)) {
      if (res.kind === "manifest-explicit") {
        process.stderr.write(
          `emit-cli-artifacts: sync-manifest.yaml::variants declares overlay ` +
            `'${path.relative(REPO, res.path)}' for ${category}/${relPath} ` +
            `axis '${axis}', but the file is missing — halt (manifest defect).\n`,
        );
        process.exit(2);
      }
      continue;
    }
    const overlay = fs.readFileSync(res.path, "utf8");
    if (overlay.includes("<!-- slot:")) {
      // Slot-keyed: compose via slot-parser
      const { composed: c } = applyOverlay(composed, overlay);
      composed = c;
    } else {
      // Full-file replacement
      composed = overlay;
    }
    // Renames carry through the destination basename — last explicit wins.
    if (res.kind === "manifest-explicit" && res.destRelPath !== relPath) {
      destRelPath = res.destRelPath;
    }
  }
  // Strip BUILD-internal references before returning. Per
  // .claude/agents/management/coc-sync.md Step 3a — every artifact
  // landing in a USE template MUST be stripped of paths the USE
  // consumer cannot resolve (workspaces/multi-cli-coc/, packages/
  // kailash-*/, gh api repos/<concrete-org>/kailash-*, etc.). The
  // transform is idempotent; running on already-clean content is a
  // no-op. See .claude/bin/lib/strip-build-internal.mjs for the
  // codified pattern set + audit fixtures.
  const { stripped } = stripBuildInternalReferences(composed);
  // CLI-aware path rewrite: at loom the source body references
  // .claude/{skills,commands,agents}/ because that IS where CC stores
  // them. For codex / gemini emissions the consumer's CLI looks under
  // .codex/{skills,prompts,agents}/ or .gemini/{skills,commands,agents}/.
  // Without this rewrite, a Codex consumer reading the emitted prompt
  // sees `.claude/skills/04-kaizen/SKILL.md` and looks for it where
  // their CLI does not — surfaced as drift in tpc_cash_treasury (#205).
  // Shared-runtime paths (hooks, learning, VERSION, bin, sync markers,
  // rules, guides, codex-mcp-guard) stay `.claude/` since they're
  // consumed identically across all three CLIs.
  const rewritten = rewriteClaudePathsForCli(stripped, cli);
  return { body: rewritten, destRelPath };
}

// CLI-aware path rewrite — see composeArtifactBody for rationale.
// codex: .claude/skills → .codex/skills; .claude/commands → .codex/prompts; .claude/agents → .codex/agents
// gemini: .claude/skills → .gemini/skills; .claude/commands → .gemini/commands; .claude/agents → .gemini/agents
// cc / null: no rewrite.
//
// Regex contract: path-aware via negative-character-class lookbehind
// `(^|[^a-zA-Z0-9._/-])` — rejects substrings like `mock-.claude/skills/`
// or `x.claude/skills/`. NOT markdown-fence-aware: rewrites apply
// uniformly to prose AND fenced code blocks. This is intentional for
// command/skill emission (the consumer's runtime paths are CLI-specific
// regardless of where the reference appears). If a future source command
// needs to document the loom-side authoring path verbatim (e.g., "loom
// authors land skills at .claude/skills/"), wrap the literal in a
// `<!-- noemit -->` slot or substitute with `&period;claude` so the
// regex no longer matches.
function rewriteClaudePathsForCli(body, cli) {
  if (cli !== "codex" && cli !== "gemini") return body;
  // commands path differs: codex calls them "prompts", gemini calls them "commands".
  const commandsTarget = cli === "codex" ? "prompts" : "commands";
  return body
    // .claude/skills/ → .{codex,gemini}/skills/
    .replace(/(^|[^a-zA-Z0-9._/-])\.claude\/skills\//g, `$1.${cli}/skills/`)
    // .claude/commands/ → .codex/prompts/ or .gemini/commands/
    .replace(/(^|[^a-zA-Z0-9._/-])\.claude\/commands\//g, `$1.${cli}/${commandsTarget}/`)
    // .claude/agents/ → .{codex,gemini}/agents/
    .replace(/(^|[^a-zA-Z0-9._/-])\.claude\/agents\//g, `$1.${cli}/agents/`);
}

// ────────────────────────────────────────────────────────────────
// Build tier filter: union of glob patterns across subscribed tiers.
// Returns null when no target (caller emits everything per legacy mode).
// Halts with exit 2 when target is provided but tier_subscriptions is
// missing — per commands/sync.md Gate 2 step 3, that is a manifest
// defect, not a fall-through-to-all-tiers fallback.
// ────────────────────────────────────────────────────────────────
function buildTierFilter(target) {
  if (!target) return null;
  const subs = loadTargetTierSubscriptions(target);
  if (subs === null) {
    process.stderr.write(
      `emit-cli-artifacts: target '${target}' not found in sync-manifest.yaml::repos.* — halt.\n`,
    );
    process.exit(2);
  }
  if (subs.length === 0) {
    process.stderr.write(
      `emit-cli-artifacts: target '${target}' has empty tier_subscriptions ` +
        `(retired/structural-defect halt per commands/sync.md Gate 2 step 3) — refusing to emit.\n`,
    );
    process.exit(2);
  }
  const tiers = loadTiers();
  const globs = [];
  for (const tier of subs) {
    const patterns = tiers[tier];
    if (!patterns) {
      process.stderr.write(
        `emit-cli-artifacts: tier '${tier}' (subscribed by ${target}) ` +
          `not found in sync-manifest.yaml::tiers.* — halt.\n`,
      );
      process.exit(2);
    }
    globs.push(...patterns);
  }
  return globs;
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
// Directory walker — yields { absPath, relPath } for files only
// ────────────────────────────────────────────────────────────────
function* walkFiles(root, rel = "") {
  const full = rel ? path.join(root, rel) : root;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const entryRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      yield* walkFiles(root, entryRel);
    } else if (entry.isFile()) {
      yield {
        absPath: path.join(full, entry.name),
        relPath: entryRel,
      };
    }
  }
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

function emitCommands({ outDir, exclusions, tierFilter, lang, verbose }) {
  const srcDir = path.join(REPO, ".claude", "commands");
  if (!fs.existsSync(srcDir)) {
    return { codex: 0, gemini: 0, skipped: 0 };
  }

  const stats = { codex: 0, gemini: 0, skipped: 0 };

  for (const { absPath, relPath } of walkFiles(srcDir)) {
    if (!relPath.endsWith(".md")) continue;
    const manifestRel = `commands/${relPath}`;
    const name = path.basename(relPath, ".md");

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
function emitSkills({ outDir, exclusions, tierFilter, lang, verbose }) {
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
        safeWriteFileSync(outFile, result.body);
        continue;
      }
    }
    // Fallback: byte copy (destination keeps original relPath).
    const outFile = path.join(skillOut, relPath);
    const data = fs.readFileSync(absPath);
    safeWriteFileSync(outFile, data);
  }
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
// into `.codex/prompts/specialist-<name>.md` so the specialist becomes
// reachable as `/prompts:specialist-<name>` — a deterministic shim
// that closes acceptance criteria 1 + 2 from the 2026-05-15 Codex
// follow-up (specialist-by-name dispatch + reviewer/security-reviewer/
// gold-standards-validator gate launchability).
//
// The emitted prompt wraps the specialist's operating spec with a
// preamble describing three invocation patterns: (a) inline persona
// (most reliable; works headless), (b) worker subagent delegation
// (interactive only), (c) headless fallback (use pattern a). Codex
// loads `.codex/prompts/<name>.md` on demand via /prompts:<name> —
// no baseline-context cap pressure.
function emitCodexAgentPrompts({ outDir, exclusions, tierFilter, lang, verbose }) {
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
    const source = composedResult ? composedResult.body : fs.readFileSync(absPath, "utf8");
    const { frontmatter, body } = parseFrontmatter(source);
    const baseName = frontmatter.name || path.basename(relPath, ".md");
    // Strip redundant trailing "-specialist" for cleaner /prompts:specialist-<x>
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

function emitGeminiAgents({ outDir, exclusions, tierFilter, lang, verbose }) {
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
    const source = composedResult ? composedResult.body : fs.readFileSync(absPath, "utf8");
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
  const tierFilter = buildTierFilter(args.target); // null when --target absent
  const lang = loadTargetVariant(args.target); // null when --target absent or variant unset
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  if (args.verbose) {
    console.log(`Source: ${REPO}/.claude`);
    console.log(`Output: ${outDir}`);
    console.log(`Exclusions (codex): ${exclusions.codex.length} globs`);
    console.log(`Exclusions (gemini): ${exclusions.gemini.length} globs`);
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
    commands: emitCommands({ outDir, exclusions, tierFilter, lang, verbose: args.verbose }),
    skills: emitSkills({ outDir, exclusions, tierFilter, lang, verbose: args.verbose }),
    codexAgentPrompts:
      onlyCli === "gemini"
        ? { codex: 0, skipped: 0 }
        : emitCodexAgentPrompts({ outDir, exclusions, tierFilter, lang, verbose: args.verbose }),
    geminiAgents:
      onlyCli === "codex"
        ? { gemini: 0, skipped: 0 }
        : emitGeminiAgents({ outDir, exclusions, tierFilter, lang, verbose: args.verbose }),
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
  loadExclusions,
  loadTiers,
  loadTargetTierSubscriptions,
  loadTargetVariant,
  buildTierFilter,
  composeArtifactBody,
  parseFrontmatter,
  emitCommands,
  emitSkills,
  emitCodexAgentPrompts,
  emitGeminiAgents,
  translateCcToolsToGemini,
};
