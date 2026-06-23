#!/usr/bin/env node
/*
 * coc-manifest.mjs — shared manifest-loader + artifact-compose primitives.
 *
 * W0 of the coc-universal workstream (decisions/00 D1-D4; wave-plan W0).
 * Extracts the neutral manifest-reading + variant-compose layer that BOTH
 * emit-cli-artifacts.mjs (per-CLI tree producer) AND emit-coc.mjs (unified
 * `.coc/` producer) depend on, so emit-coc no longer imports from
 * emit-cli-artifacts. This unblocks retiring per-CLI emission (wave W5)
 * without breaking the `.coc/` producer (01-analysis/00 §3 sequencing risk
 * #2). The functions below are moved VERBATIM from emit-cli-artifacts.mjs
 * (same behavior, byte-identical emit) — only the file location + the
 * sibling import paths (`./lib/X` → `./X`) and REPO's depth changed.
 *
 * Symbols (13): REPO, safeWriteFileSync, globToRegex, matchesAnyGlob,
 *   loadExclusions, loadLoomOnly, loadTiers, loadTargetTierSubscriptions,
 *   loadTargetVariant, buildTierFilter, composeArtifactBody,
 *   rewriteClaudePathsForCli, walkFiles.
 *
 * Node ESM, zero external deps (mirrors emit.mjs / emit-cli-artifacts.mjs).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyOverlay } from "./slot-parser.mjs";
import { resolveOverlay } from "./variant-overlay.mjs";
import { stripBuildInternalReferences } from "./strip-build-internal.mjs";

// REPO = repo root. This module lives at `.claude/bin/lib/`, i.e. THREE
// levels below the root (lib → bin → .claude → root), so REPO resolves
// `..` THREE times — one deeper than emit-cli-artifacts.mjs / emit.mjs
// (which live at `.claude/bin/`, two levels, two `..`). Do NOT "simplify"
// to two `..`: that resolves to `.claude/` and every manifest read below
// (loadExclusions / loadTiers / composeArtifactBody) reads the wrong path.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");

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
  // Escape regex metacharacters, then re-expand glob tokens. `?` is escaped to
  // a literal (not left as a regex 0-or-1 quantifier) — the manifest globs are
  // exact-path / prefix patterns, never POSIX single-char wildcards.
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
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
      // Strip surrounding quotes, THEN inline ` # ...` comments — matching
      // loadTiers/loadLoomOnly. Closes a latent footgun (W4 redteam R-LOW): the
      // prior asymmetry meant an inline comment on a cli_emit_exclusions entry
      // would corrupt the glob, so rationale had to live on full comment lines
      // only. Behavior-preserving for current data (no entry carries a ` #`).
      const val = entryMatch[1].replace(/^["']|["']$/g, "");
      const cleaned = val.replace(/\s+#.*$/, "").trim();
      if (cleaned) result[currentCli].push(cleaned);
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────
// sync-manifest.yaml → loom_only (top-level FLAT glob list)
// ────────────────────────────────────────────────────────────────
// F104 — loom-only artifacts are a POSITIVE never-sync declaration.
// A source path matching any glob here is skipped for EVERY target
// (cc/codex/gemini × every lang), BEFORE tier classification. Same flat
// list shape as `obsoleted:` / `exclude:`: a top-level key whose body is a
// list of `- <glob>` entries (NO nested CLI sub-keys). Bare source-relative
// globs (`agents/management/coc-sync.md`) matched against the manifest-
// relative path the emit functions build (`agents/...`).
function loadLoomOnly() {
  const manifestPath = path.join(REPO, ".claude", "sync-manifest.yaml");
  const src = fs.readFileSync(manifestPath, "utf8");
  const lines = src.split("\n");

  const result = [];
  let inStanza = false;

  for (const line of lines) {
    if (/^loom_only:\s*$/.test(line)) {
      inStanza = true;
      continue;
    }
    if (!inStanza) continue;

    // End of stanza: a new top-level key (column 0, ends with `:`).
    if (/^[a-zA-Z_][^:]*:\s*$/.test(line) && !line.startsWith(" ")) {
      break;
    }

    // List entry (2-space indent, leading dash). Strip inline comments.
    const entryMatch = line.match(/^ {2}-\s*(.+?)\s*$/);
    if (entryMatch) {
      const val = entryMatch[1].replace(/^["']|["']$/g, "");
      const cleaned = val.replace(/\s+#.*$/, "").trim();
      if (cleaned) result.push(cleaned);
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
  // their CLI does not — surfaced as drift in a downstream consumer (#205).
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
// missing — per sync-flow.md § Gate 2 → Process step 3 (loom: /sync-to-use), that is a manifest
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
        `(retired/structural-defect halt per sync-flow.md § Gate 2 → Process step 3 (loom: /sync-to-use)) — refusing to emit.\n`,
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

export {
  REPO,
  safeWriteFileSync,
  globToRegex,
  matchesAnyGlob,
  loadExclusions,
  loadLoomOnly,
  loadTiers,
  loadTargetTierSubscriptions,
  loadTargetVariant,
  buildTierFilter,
  composeArtifactBody,
  rewriteClaudePathsForCli,
  walkFiles,
};
