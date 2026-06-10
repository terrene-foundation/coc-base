#!/usr/bin/env node
/*
 * ============================================================================
 *  sync-tier-aware — canonical tier-aware .claude/ enumerator (issue #272)
 * ============================================================================
 *
 *  PURPOSE
 *
 *  Closes the recurring `/tmp/sync-<target>.sh` ad-hoc-script class in
 *  /sync Gate 2. Every prior cycle re-implemented the tier-subscription
 *  filter in hand-written bash; every cycle regressed (the 2026-05-17
 *  cycle's helper leaked 4 categories of inappropriate files into a USE
 *  template before self-reverting). This script IS the structural defense
 *  the coc-sync.md MUST NOT § "Ad-Hoc Bash Sync Scripts That Bypass
 *  Tier-Aware Tooling" clause names — there is now exactly one place
 *  where tier filtering happens, and it ships with regression tests.
 *
 *  CONTRACT (sync-flow.md Gate 2 step 3)
 *
 *    1. Read `repos.<target>.tier_subscriptions` (REQUIRED in v2.21.0+;
 *       missing = manifest defect, halt with non-zero exit).
 *    2. Compute inclusion glob set = union of `tiers.<tier>[]` across
 *       subscribed tiers.
 *    3. Always-include tier-independent runtime infra regardless of
 *       subscriptions: `.claude/hooks/**`, `.claude/hooks/lib/**`,
 *       `.claude/bin/**`, `.claude/.coc-obsoleted`.
 *    4. Apply `exclude:` (universal) + `use_exclude:` (USE-templates only).
 *    5. Apply `use_obsoleted:` as PURGE list (paths to delete from target
 *       even though they are not in the include set).
 *    6. Exclude loom-local config: `*.local.json` (the gitignored
 *       operator-local resolver / repin config — never sync). The
 *       committed `*.local.example.json` schema templates DO ship (they
 *       are the documented schema downstream consumers may follow).
 *    7. Resolve target on-disk path via `bin/lib/loom-links.mjs`
 *       (`use-template.<key>` logical keys). NO positional fallback.
 *
 *  USAGE
 *
 *    node .claude/bin/sync-tier-aware.mjs --target <py|rs|rb|base>
 *        [--template <repo>]   # restrict to one of repos.<target>.templates[]
 *        [--dry-run]           # emit manifest, do not write
 *        [--out <dir>]         # write to this absolute path instead of
 *                              # resolving via loom-links
 *        [--json]              # emit machine-readable JSON manifest on stdout
 *                              # (default: text summary on stdout)
 *
 *  Exit codes: 0 = success; 1 = manifest defect / write failure;
 *              2 = usage error; 3 = resolver not-configured (loom-links).
 *
 *  Node ESM, zero external dependencies (mirrors emit.mjs convention:
 *  regex-based YAML slicing per validateTierCompleteness()).
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { resolveRepo, LinkError } from "./lib/loom-links.mjs";

// ────────────────────────────────────────────────────────────────
// Filesystem safety primitives (security-reviewer Round-1 CRIT/HIGH)
// ────────────────────────────────────────────────────────────────

/**
 * Resolve `sub` against `base` and assert the result stays inside
 * `base`. Rejects `..` traversal, absolute paths, and `base` itself
 * (a `.` purge entry would delete the whole template repo).
 *
 * Used by both the copy branch (path.join(dir, f.path)) and the purge
 * branch (path.join(dir, use_obsoleted_entry)). Mirrors the structural-
 * confirmation pattern in `git.md` § "git reset --hard verify clean
 * working tree" and `schema-migration.md` Rule 7 — applied here to
 * `fs.rmSync(..., recursive, force)`, the irreversible-op equivalent.
 */
function safeJoinUnder(base, sub) {
  const baseAbs = path.resolve(base);
  const targetAbs = path.resolve(baseAbs, sub);
  if (targetAbs === baseAbs) {
    throw new Error(
      `path '${sub}' resolves to the target dir itself (would erase the template)`,
    );
  }
  if (!targetAbs.startsWith(baseAbs + path.sep)) {
    throw new Error(
      `path '${sub}' escapes the target dir (resolves to '${targetAbs}')`,
    );
  }
  return targetAbs;
}

/**
 * Reject manifest-declared `use_obsoleted` entries that would defeat
 * containment at parse time, surfacing the defect before any FS call.
 * Catches absolute paths (POSIX `path.join` discards prior components
 * when an absolute path appears), `.`-equivalents, and `..`-segments.
 */
function rejectUnsafePurgeEntry(entry) {
  if (typeof entry !== "string" || entry.length === 0) {
    return `empty entry`;
  }
  if (path.isAbsolute(entry)) return `absolute path '${entry}'`;
  if (entry === "." || entry === "./") return `'.' entry`;
  const segs = entry.split(/[/\\]/);
  if (segs.some((s) => s === "..")) return `'..' segment in '${entry}'`;
  return null;
}

/**
 * Symlink-safe single-source write — Buffer (binary copy) or utf8
 * string (text write) share one open-write-close path. fs.copyFileSync
 * + fs.writeFileSync-by-path both follow symlinks at destination by
 * default; this helper refuses via O_NOFOLLOW, raising ELOOP on a
 * pre-planted symlink at `dest`. Mirrors emit.mjs::safeWriteFileSync;
 * asymmetry between emit.mjs and sync-tier-aware sync paths would
 * itself be institutional drift per `cross-repo.md` MUST-1.
 *
 * The encoding parameter distinguishes the two callers: Buffer for
 * safeCopyFile (binary file→file copy); "utf8" for safeWriteTextSync
 * (manifest-derived text). Collapsing avoids the duplicated-TOCTOU-
 * defense drift `rules/security.md` § "Pre-Encoder Consolidation"
 * names for credential decode/encode pairs.
 *
 * Reviewer Round-1 MED: helper collapse.
 */
function safeWriteSync(dest, data, encoding = null) {
  const fd = fs.openSync(
    dest,
    fs.constants.O_CREAT |
      fs.constants.O_WRONLY |
      fs.constants.O_TRUNC |
      fs.constants.O_NOFOLLOW,
    0o644,
  );
  try {
    if (encoding === null) {
      fs.writeFileSync(fd, data);
    } else {
      fs.writeFileSync(fd, data, encoding);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function safeCopyFile(src, dest) {
  safeWriteSync(dest, fs.readFileSync(src));
}

/**
 * Post-copy byte-equality verification — #401 Defect-2 fix.
 *
 * The incident reported `copied 1228` while 13 hooks + 189 files stayed at
 * stale HEAD content: the success COUNT was trusted, but a copy can silently
 * no-op (or land partial bytes), shipping the OLD artifact under a green
 * report. `safeCopyFile` is a raw byte copy, so the contract is exact:
 * dest bytes MUST equal src bytes after a successful copy.
 *
 * Returns `null` on byte-equal success; otherwise a human-readable failure
 * reason. A read error on `dest` is the "planned-but-not-written" case the
 * #401 acceptance criterion names — surfaced as a failure, never swallowed.
 */
function verifyCopiedBytes(src, dest) {
  try {
    const srcBuf = fs.readFileSync(src);
    const destBuf = fs.readFileSync(dest);
    if (srcBuf.equals(destBuf)) return null;
    return `byte mismatch (src ${srcBuf.length}B vs dest ${destBuf.length}B)`;
  } catch (e) {
    return `planned copy not readable post-write: ${e.message}`;
  }
}

function safeWriteTextSync(dest, content) {
  safeWriteSync(dest, content, "utf8");
}

/**
 * Pre-write safety snapshot — the "forever"-grade defense (issue #401).
 *
 * BEFORE any copy-overwrite or purge-delete touches a consumer template,
 * capture every UNTRACKED working-tree file to an out-of-tree quarantine
 * under the repo's git-common-dir. `git clean` / `git reset --hard` /
 * `rm` operate on the working tree and cannot reach inside `.git/`, so
 * the snapshot survives any downstream destructive primitive — a Bash
 * `rm`, this tool's own `fs.rmSync` purge branch, OR a future tool's
 * internal fs delete. It runs at the filesystem-mutation boundary, so it
 * is surface-agnostic (the design red-team's CRIT-1: a PreToolUse Bash
 * hook is blind to `fs.rmSync` inside a Node tool; a pre-write snapshot
 * is not).
 *
 * It runs PER RESOLVED TEMPLATE DIR (called from executePlan's loop), so
 * it covers COLLATERAL writes too — a fan-out to a sibling template still
 * snapshots that sibling's untracked work (the #401 incident: a `--target
 * py` run wrote into kailash-coc-py as collateral and a cleanup destroyed
 * its untracked Docker files).
 *
 * Scope: `git ls-files --others --exclude-standard` = untracked-AND-not-
 * ignored — exactly the class with no git object that is unrecoverable if
 * destroyed. Ignored files are out of scope (documented; they are by
 * definition reproducible build artifacts).
 *
 * THROWS (does not call fail()/exit, for testability) when untracked
 * files exist but cannot be enumerated or copied — the caller MUST let it
 * propagate so the sync HALTS rather than proceeding to mutate unprotected
 * untracked work.
 *
 * Returns { snapshotDir, count }; { snapshotDir: null, count: 0 } when the
 * tree is clean, not a git repo, or dryRun.
 */
function snapshotUntrackedFiles(dir, { dryRun } = {}) {
  if (dryRun) return { snapshotDir: null, count: 0 };
  // Locate the git-common-dir (worktree-aware). Not a git repo → no
  // git-op deletion vector; return clean.
  let gitCommonDir;
  try {
    gitCommonDir = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return { snapshotDir: null, count: 0 };
  }
  const gitDirAbs = path.isAbsolute(gitCommonDir)
    ? gitCommonDir
    : path.resolve(dir, gitCommonDir);
  let untracked;
  try {
    untracked = execFileSync(
      "git",
      ["-C", dir, "ls-files", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\0")
      .filter(Boolean);
  } catch (e) {
    throw new Error(
      `presync-snapshot: could not enumerate untracked files in ${path.basename(dir)}: ${e.message}`,
    );
  }
  if (untracked.length === 0) return { snapshotDir: null, count: 0 };
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  // crypto.randomBytes suffix collision-proofs against same-millisecond
  // re-invocations sharing a git-common-dir, mirroring the gitignore
  // tmp-suffix hardening elsewhere in this file (Round-1 consensus).
  const rand = crypto.randomBytes(4).toString("hex");
  const snapshotDir = path.join(
    gitDirAbs,
    `coc-presync-snapshot-${ts}-${rand}`,
  );
  fs.mkdirSync(snapshotDir, { recursive: true });
  const failures = [];
  let copied = 0;
  for (const rel of untracked) {
    const srcAbs = path.join(dir, rel);
    // Defense-in-depth (security-reviewer MED-1): route the quarantine
    // destination through the same containment guard the copy/purge
    // branches use. git ls-files emits repo-relative normalized paths
    // today; the guard makes the invariant structural, not git-version-
    // dependent.
    let destAbs;
    try {
      destAbs = safeJoinUnder(snapshotDir, rel);
    } catch (e) {
      failures.push(`${rel}: refused (containment): ${e.message}`);
      continue;
    }
    try {
      if (!fs.existsSync(srcAbs)) continue; // vanished / dangling symlink
      const st = fs.lstatSync(srcAbs);
      if (st.isDirectory()) continue; // ls-files lists files, not dirs
      // Do NOT follow symlinks (security-reviewer HIGH-1): copyFileSync
      // copies the TARGET's bytes, leaking out-of-tree content into the
      // quarantine and corrupting recovery. A symlink's target is tracked
      // elsewhere or out of scope; the snapshot preserves files git would
      // otherwise lose. lstatSync above already returns the link's own
      // stat (does not follow), so this is the race-minimal test.
      if (st.isSymbolicLink()) continue;
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.copyFileSync(srcAbs, destAbs);
      copied++;
    } catch (e) {
      failures.push(`${rel}: ${e.message}`);
    }
  }
  if (failures.length) {
    throw new Error(
      `presync-snapshot: ${failures.length} untracked file(s) could not be snapshotted in ${path.basename(dir)} — refusing to proceed (would risk unrecoverable loss): ${failures.slice(0, 3).join("; ")}`,
    );
  }
  return { snapshotDir, count: copied };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(REPO, ".claude", "sync-manifest.yaml");
const CLAUDE_DIR = path.join(REPO, ".claude");

// ────────────────────────────────────────────────────────────────
// Always-include (Gate 2 step 3 — tier-independent runtime infra)
// ────────────────────────────────────────────────────────────────
//
// These ship to every USE template regardless of tier_subscriptions.
// Source of truth: `commands/sync.md` Gate 2 step 3 line.
//
// Pinning here (vs computing from manifest) is intentional: these are
// runtime infrastructure paths, not tier-classified content. Adding a
// new always-include path is a deliberate operator decision, not a
// passive manifest edit.
const ALWAYS_INCLUDE = [
  ".claude/hooks/**",
  ".claude/hooks/lib/**",
  ".claude/bin/**",
  ".claude/.coc-obsoleted",
];

// Loom-local config paths (gitignored operator config; NEVER sync).
// The companion `*.local.example.json` schema templates DO ship — they
// are the committed schemas downstream consumers may copy from. See
// `bin/lib/loom-links.mjs` § Disclosure discipline.
const LOOM_LOCAL_PATTERNS = [".claude/bin/*.local.json"];

// ────────────────────────────────────────────────────────────────
// `.gitignore` apply — managed block markers (GH #368 finding 1)
// ────────────────────────────────────────────────────────────────
//
// `sync-manifest.yaml::gitignore_additions:` declares paths every
// consumer's `.gitignore` MUST contain. Apply discipline:
//
//  1. Read the consumer's existing `.gitignore` (empty if absent).
//  2. Locate the managed block by literal marker lines (BEGIN/END).
//  3. If present, REPLACE the block body with the manifest's current
//     entries (no diff merge — manifest is authoritative INSIDE the
//     block). If absent, APPEND the block (with a leading blank line
//     if the file does not already end with one).
//  4. Lines OUTSIDE the block are NEVER touched — user-managed.
//  5. Write atomically via `.tmp.<pid>` + `rename()` per
//     `knowledge-convergence.md` MUST-1 + `coc-append.js` lineage.
//
// The block markers are byte-stable: same manifest input produces
// byte-identical block output across runs (idempotency proof).
const GITIGNORE_MANAGED_BEGIN =
  "# >>> coc:gitignore_additions — managed by loom /sync; do not edit between markers >>>";
const GITIGNORE_MANAGED_END = "# <<< coc:gitignore_additions <<<";

// ────────────────────────────────────────────────────────────────
// CLI parse
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    target: null,
    template: null,
    allTemplates: false,
    dryRun: false,
    out: null,
    json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") args.target = argv[++i];
    else if (a === "--template") args.template = argv[++i];
    else if (a === "--all-templates") args.allTemplates = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n${usage()}`);
      process.exit(2);
    }
  }
  if (!args.target) {
    process.stderr.write(`--target is required\n${usage()}`);
    process.exit(2);
  }
  return args;
}

function usage() {
  return (
    "Usage: sync-tier-aware.mjs --target <py|rs|rb|base>\n" +
    "       [--template <repo> | --all-templates] [--dry-run] [--out <dir>] [--json]\n" +
    "\n" +
    "  --template <repo>   restrict the write to ONE template in the lane\n" +
    "  --all-templates     write EVERY template in the lane (explicit opt-in;\n" +
    "                      required when the lane has >1 template — #401)\n"
  );
}

// ────────────────────────────────────────────────────────────────
// Manifest parsing — regex-scoped section parse, mirroring
// emit.mjs::validateTierCompleteness() (no YAML dep).
// ────────────────────────────────────────────────────────────────
function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    fail(1, `sync-manifest.yaml not found at ${rel(MANIFEST_PATH)}`);
  }
  return fs.readFileSync(MANIFEST_PATH, "utf8");
}

/**
 * Slice a top-level YAML block: from the line AFTER `^<key>:` to the
 * next column-0 key. Mirrors emit.mjs::validateTierCompleteness sliceBlock.
 */
function sliceBlock(text, key) {
  const re = new RegExp(`^${key}:\\s*$`, "m");
  const start = text.search(re);
  if (start === -1) return "";
  const bodyStart = text.indexOf("\n", start);
  if (bodyStart === -1) return "";
  const after = text.slice(bodyStart + 1);
  const nextRel = after.search(/^[A-Za-z_][\w-]*:\s*$/m);
  return after.slice(0, nextRel === -1 ? undefined : nextRel);
}

/** Extract a list of `- <glob>` entries from a YAML block body. */
function parseList(blockBody) {
  const out = [];
  const re = /^\s*-\s*(\S.*?)\s*(?:#.*)?$/gm;
  let m;
  while ((m = re.exec(blockBody)) !== null) {
    let v = m[1];
    // Strip surrounding quotes if any
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out.push(v);
  }
  return out;
}

/**
 * Parse `tiers:` block into { tier_name: [glob, ...] }. The block is
 * nested 2-space (tier key) → 4-space (- glob). Inner-key lookahead
 * also stops at the next `tiers`-block sibling at the same indent.
 */
function parseTiers(manifestText) {
  const tiersBlock = sliceBlock(manifestText, "tiers");
  const tiers = {};
  // Split tiers by their headers: `^  <tier>:\s*$`
  const tierHeaderRe = /^  ([a-z_][\w-]*):\s*$/gm;
  const headers = [];
  let m;
  while ((m = tierHeaderRe.exec(tiersBlock)) !== null) {
    headers.push({ name: m[1], start: m.index, headerEnd: m.index + m[0].length });
  }
  for (let i = 0; i < headers.length; i++) {
    const startBody = headers[i].headerEnd + 1;
    const endBody = i + 1 < headers.length ? headers[i + 1].start : tiersBlock.length;
    const body = tiersBlock.slice(startBody, endBody);
    // Only `- <glob>` lines at any indent within this tier body.
    tiers[headers[i].name] = parseList(body);
  }
  return tiers;
}

/**
 * Parse `variant_only:` block into { <variant>: [entry, ...] }. Block shape
 * mirrors `tiers:` — a 2-space variant key, then a 4-space `- entry` list:
 *
 *   variant_only:
 *     py:
 *       - variants/py/skills/01-core-sdk/otel-tracing.md
 *     rs:
 *       - variants/rs/skills/28-ruby-bindings/ruby-nexus-rack.md
 *       - variants/rs/skills/06-cheatsheets/**
 *     rb: []
 *
 * Inline-empty arrays (`rb: []`) do NOT match the block-header regex (which
 * anchors `:\s*$`), so they simply produce no section — treated as empty,
 * which is the correct semantics (no variant-only files for that variant).
 *
 * Entries are repo-relative WITHOUT the leading `.claude/` (the manifest
 * convention: `variants/<variant>/<rest>`). They may be literal paths or
 * `**`/`*` globs (e.g. `variants/rs/skills/06-cheatsheets/**`).
 */
function parseVariantOnly(manifestText) {
  const block = sliceBlock(manifestText, "variant_only");
  const out = {};
  const headerRe = /^  ([a-z_][\w-]*):\s*$/gm;
  const headers = [];
  let m;
  while ((m = headerRe.exec(block)) !== null) {
    headers.push({ name: m[1], start: m.index, headerEnd: m.index + m[0].length });
  }
  for (let i = 0; i < headers.length; i++) {
    const startBody = headers[i].headerEnd + 1;
    const endBody = i + 1 < headers.length ? headers[i + 1].start : block.length;
    out[headers[i].name] = parseList(block.slice(startBody, endBody));
  }
  return out;
}

/**
 * Expand the declared `variant_only:<variant>` entries against the walked
 * loom file set, returning the per-file copy plan AND the completeness gap.
 *
 * #427 root cause: variant_only files live at `.claude/variants/<variant>/…`
 * and are EXCLUDED by `classifyFile` (the `variants/**` exclude). They deploy
 * to the target at the STRIPPED destination (`variants/<variant>/skills/X.md`
 * → `.claude/skills/X.md`), written as-is (no compose — `coc-sync.md:1405`
 * confirms variant_only files are pure additions, not slot-composed overlays).
 * Prior to this pass, their distribution was prose-only in the coc-sync agent
 * (Step 5), so a forgotten / stale new entry shipped silently.
 *
 * Returns:
 *   { files:  [{ path, dest, variant_only_entry }],  // path = .claude-prefixed
 *                                                     // loom source (matches the
 *                                                     // global copy-branch shape);
 *                                                     // dest = .claude-prefixed
 *                                                     // stripped destination.
 *     missing: [entry, ...] }                         // declared entries that
 *                                                     // matched ZERO loom files
 *                                                     // (manifest-vs-source defect).
 *
 * Security note: the entry string is used ONLY as a glob to MATCH walked loom
 * files (which `walkClaudeDir` guarantees cannot contain `..`); the `dest` is
 * derived by stripping a known prefix off a REAL walked path, never by
 * interpolating the entry into a path. So a malicious manifest glob cannot
 * escape the target dir through this function — and `safeJoinUnder` is the
 * final runtime guard at the copy site regardless.
 */
function expandVariantOnly(allFiles, variant, entries) {
  const files = [];
  const missing = [];
  if (!variant || !Array.isArray(entries)) return { files, missing };
  const prefix = `variants/${variant}/`;
  for (const entry of entries) {
    const re = globToRegex(entry);
    let matched = 0;
    for (const f of allFiles) {
      const stripped = f.startsWith(".claude/") ? f.slice(".claude/".length) : f;
      if (!stripped.startsWith(prefix)) continue; // only this variant's tree
      if (!re.test(stripped)) continue;
      const rest = stripped.slice(prefix.length); // e.g. "skills/X.md", "scripts/migrate.py"
      // Dest-root dispatch (coc-sync.md Step 5 § "top-level scripts/ is the
      // destination"): `scripts/` + `workspaces/` are project-ops top-level
      // dirs, deployed to `<target>/<rest>` — NOT `.claude/`-rooted (`.claude/
      // scripts/` is in `obsoleted:` and purged every sync, so a `.claude/`-
      // rooted scripts entry silently self-destructs). EVERYTHING ELSE —
      // skills, agents, rules, commands, AND hooks — is `.claude/`-rooted.
      // hooks/ specifically → `.claude/hooks/` per the v2.9.1 consolidation
      // (cross-repo.md Rule 3 + ALWAYS_INCLUDE `.claude/hooks/**`); the live
      // py template confirms `.claude/hooks/<hook>.js`, NOT top-level.
      const dest = /^(scripts|workspaces)\//.test(rest)
        ? rest // top-level <target>/scripts/… | workspaces/…
        : ".claude/" + rest; // <target>/.claude/… (skills/agents/rules/commands/hooks)
      files.push({
        path: f,
        dest,
        variant_only_entry: entry,
      });
      matched++;
    }
    if (matched === 0) missing.push(entry);
  }
  return { files, missing };
}

/**
 * Parse `repos:` block into { name: { tier_subscriptions:[], templates:[{repo,clis,baseline_files}], variant, build } }.
 */
function parseRepos(manifestText) {
  const reposBlock = sliceBlock(manifestText, "repos");
  const repos = {};
  // Repo headers: `^  <name>:\s*$`
  const headerRe = /^  ([a-z][\w-]*):\s*$/gm;
  const headers = [];
  let m;
  while ((m = headerRe.exec(reposBlock)) !== null) {
    headers.push({ name: m[1], start: m.index, headerEnd: m.index + m[0].length });
  }
  for (let i = 0; i < headers.length; i++) {
    const startBody = headers[i].headerEnd + 1;
    const endBody = i + 1 < headers.length ? headers[i + 1].start : reposBlock.length;
    const body = reposBlock.slice(startBody, endBody);
    // tier_subscriptions: inline array `[cc, co, coc]` OR `[]`
    const tsMatch = body.match(/^\s*tier_subscriptions:\s*\[([^\]]*)\]\s*$/m);
    const tier_subscriptions =
      tsMatch === null
        ? null
        : tsMatch[1]
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    // variant: <name>
    const variantMatch = body.match(/^\s*variant:\s*(\S+)\s*$/m);
    const variant = variantMatch ? variantMatch[1] : null;
    // build: <name|null>
    const buildMatch = body.match(/^\s*build:\s*(\S+)\s*$/m);
    const build =
      buildMatch && buildMatch[1] !== "null" ? buildMatch[1] : null;
    // templates: list of { repo, clis, baseline_files }
    const templates = parseTemplates(body);
    repos[headers[i].name] = {
      tier_subscriptions,
      templates,
      variant,
      build,
    };
  }
  return repos;
}

function parseTemplates(repoBody) {
  // Each template entry begins with `^\s*-\s*repo:\s*<repo>\s*$`.
  // We parse repo, clis, baseline_files per entry.
  const out = [];
  const entryRe = /^\s*-\s*repo:\s*(\S+)\s*$/gm;
  const entries = [];
  let m;
  while ((m = entryRe.exec(repoBody)) !== null) {
    entries.push({ repo: m[1], start: m.index + m[0].length });
  }
  for (let i = 0; i < entries.length; i++) {
    const end = i + 1 < entries.length ? entries[i + 1].start : repoBody.length;
    const body = repoBody.slice(entries[i].start, end);
    const clisMatch = body.match(/^\s*clis:\s*\[([^\]]*)\]\s*$/m);
    const clis = clisMatch
      ? clisMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
    const baseMatch = body.match(/^\s*baseline_files:\s*\[([^\]]*)\]\s*$/m);
    const baseline_files = baseMatch
      ? baseMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
    out.push({ repo: entries[i].repo, clis, baseline_files });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// Glob matching — minimal subset supporting `**`, `*`, exact paths.
// Sufficient for the manifest's glob vocabulary (no `?`, no `[...]`).
// ────────────────────────────────────────────────────────────────
function globToRegex(glob) {
  // Anchor at start AND end. Escape regex metachars except `*`.
  // `**` → match anything including `/`.
  // `*`  → match anything except `/`.
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 2;
        // Skip a following slash so `**/x` matches both `x` and `a/b/x`.
        if (glob[i] === "/") i += 1;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (/[.+?^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

function matchesAny(relpath, globs) {
  for (const g of globs) {
    if (globToRegex(g).test(relpath)) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────
// gitignore_additions — manifest read + idempotent apply
// ────────────────────────────────────────────────────────────────

/**
 * Parse `gitignore_additions:` from the manifest. Returns the declared
 * entries in manifest order (order preservation lets an operator diff
 * the manifest against the consumer's `.gitignore` line-for-line).
 */
function parseGitignoreAdditions(manifestText) {
  return parseList(sliceBlock(manifestText, "gitignore_additions"));
}

/**
 * FA — parse `visibility_gitignore_additions.public:` from the manifest.
 * These entries are appended to a consumer's `.gitignore` ONLY when the
 * consumer declares `visibility: public` in its `.coc-sync-marker`.
 *
 * The block has one nested class (`public:`) whose items are a `- ` list;
 * sliceBlock grabs the whole `visibility_gitignore_additions:` body and
 * parseList extracts the list items under it (the only list in the block).
 * Returns [] when the block is absent (back-compat: a manifest without
 * the FA block applies no visibility-conditional entries).
 */
function parseVisibilityGitignoreAdditions(manifestText) {
  return parseList(sliceBlock(manifestText, "visibility_gitignore_additions"));
}

/**
 * FA — resolve a consumer's visibility from its `.coc-sync-marker`.
 * Returns { visibility, optOut } where visibility ∈ {"public","private"}
 * and optOut is the marker's `visibility_opt_out` array (paths a private
 * consumer wants ignored anyway, OR a public consumer wants to keep —
 * currently honored as "public consumer skips these visibility entries").
 *
 * DEFAULT IS "public" (fail-safe per FA decision): a marker with no
 * `visibility` field, an unreadable/absent marker, or malformed content
 * all resolve to "public" so a misconfigured repo IGNORES its
 * operator-local session state rather than risking a public commit of
 * it. The marker lives at `<dir>/.claude/.coc-sync-marker`.
 *
 * FORMAT TOLERANCE: markers on disk today are single-line JSON, but
 * coc-sync.md Step 9 mandates YAML going forward. This reader handles
 * BOTH — JSON.parse first; on failure, a minimal line-scan for
 * `visibility:` + `visibility_opt_out:` YAML keys. Neither format is
 * privileged; visibility detection works regardless of which the
 * consumer's marker uses. (Fail-safe still applies: a marker this
 * reader cannot extract a visibility from → "public".)
 */
function readConsumerVisibility(dir) {
  const markerPath = path.join(dir, ".claude", ".coc-sync-marker");
  const fallback = { visibility: "public", optOut: [] };
  // Hardening (security-reviewer LOW-1): O_NOFOLLOW refuses a symlinked
  // marker (a symlink could redirect the read outside the consumer dir),
  // and a size cap bounds the read so a multi-GB marker cannot OOM the
  // sync. Both failure modes fall to the fail-safe public default — a
  // marker we cannot safely read is treated as "no visibility declared".
  // Mirrors the .gitignore read discipline (O_NOFOLLOW) below.
  const MAX_MARKER_BYTES = 64 * 1024; // markers are tiny JSON/YAML; 64KiB is generous
  let raw;
  let fd;
  try {
    fd = fs.openSync(
      markerPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    return fallback; // absent / unreadable / symlink (ELOOP) → fail-safe public
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_MARKER_BYTES) {
      return fallback; // non-regular-file or oversize → fail-safe public
    }
    raw = fs.readFileSync(fd, "utf8");
  } catch {
    return fallback; // read error → fail-safe public
  } finally {
    fs.closeSync(fd);
  }

  let visibilityRaw = null;
  let optOut = [];

  // Path 1 — JSON (current on-disk format).
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.visibility === "string") {
      visibilityRaw = parsed.visibility;
    }
    if (Array.isArray(parsed && parsed.visibility_opt_out)) {
      optOut = parsed.visibility_opt_out.filter((e) => typeof e === "string");
    }
  } catch {
    // Path 2 — YAML line-scan (future mandated format). Minimal, no
    // YAML lib: match `visibility: <value>` and a flow/block opt-out
    // list. Anything unparseable leaves visibilityRaw null → public.
    const vm = raw.match(/^\s*visibility:\s*["']?([A-Za-z]+)["']?\s*$/m);
    if (vm) visibilityRaw = vm[1];
    // Flow list: `visibility_opt_out: [a, b]`
    const flow = raw.match(/^\s*visibility_opt_out:\s*\[([^\]]*)\]\s*$/m);
    if (flow) {
      optOut = flow[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0);
    }
  }

  const v =
    typeof visibilityRaw === "string"
      ? visibilityRaw.trim().toLowerCase()
      : "public";
  const visibility = v === "private" ? "private" : "public"; // only these two; anything else → public
  return { visibility, optOut };
}

/**
 * FA — compute the effective gitignore additions for ONE consumer:
 * the always-applied `base` entries plus, when the consumer is public,
 * the visibility entries (minus any the marker opted out of). Private
 * consumers get base only → they TRACK session-notes + workspaces.
 *
 *   optOut semantics: an entry in the marker's visibility_opt_out[] whose
 *   value is a prefix-or-exact match of a visibility entry suppresses that
 *   entry. "session-notes" suppresses the .session-notes* trio;
 *   "workspaces" suppresses the /workspaces/* pair. Matching is by the
 *   coarse token the operator writes, not the literal gitignore line.
 */
function effectiveGitignoreAdditions(base, visibilityAdds, marker) {
  if (marker.visibility !== "public") return base.slice();
  const optOut = marker.optOut || [];
  const optOutMatches = (entry) =>
    optOut.some((tok) => {
      if (tok === "session-notes") return entry.includes("session-notes");
      if (tok === "workspaces") return entry.includes("workspaces");
      return entry === tok; // exact-line opt-out
    });
  const kept = visibilityAdds.filter((e) => !optOutMatches(e));
  return [...base, ...kept];
}

/**
 * Validate a single gitignore_additions entry. Defends against
 * manifest defects that would either escape the consumer's repo
 * boundary or break the managed-block grammar.
 *
 *   - Empty string → defect (would produce a blank ignore line that
 *     silently ignores nothing).
 *   - Newline in entry (ASCII \r, \n OR Unicode U+2028 LS,
 *     U+2029 PS) → defect (would inject extra lines OUTSIDE the
 *     managed block, evading the marker-block invariant).
 *   - Entry colliding with the marker strings → defect (would close
 *     the managed block one line early, leaving "user content
 *     outside the block" that next-apply preserves verbatim).
 *     Security-reviewer R1 MED-1 (marker-string-as-entry).
 *
 * Returns the defect description (string) or `null` if safe.
 */
function rejectUnsafeGitignoreEntry(entry) {
  if (typeof entry !== "string" || entry.length === 0) {
    return "empty entry";
  }
  // Reject ASCII CR/LF AND Unicode line separators (U+2028 LS, U+2029 PS).
  // git uses LF-only grammar for .gitignore so the structural-injection
  // path is ASCII; Unicode separators are rejected so editor / GitHub-UI
  // previews stay aligned with on-disk semantics.
  if (/[\r\n\u2028\u2029]/.test(entry)) {
    return `entry contains line terminator (would break managed-block invariant): '${entry.replace(/[\r\n\u2028\u2029]/g, "\\n")}'`;
  }
  // Marker-collision check — reject any entry that contains either
  // BEGIN or END marker as a substring. Substring (vs equality) check
  // catches both literal-marker entries AND entries that embed a
  // marker into a longer string (e.g. `# >>> coc:gitignore_additions
  // ... # SUFFIX`).
  if (
    entry.includes(GITIGNORE_MANAGED_BEGIN) ||
    entry.includes(GITIGNORE_MANAGED_END)
  ) {
    return `entry collides with managed-block marker: '${entry}'`;
  }
  return null;
}

/**
 * Compose the managed-block body from the manifest's declared
 * entries. The block is byte-stable: same `additions` input always
 * produces the same output bytes (no timestamps, no sorting, no
 * deduping — preserve manifest order verbatim).
 */
function composeGitignoreBlock(additions) {
  const lines = [GITIGNORE_MANAGED_BEGIN, ...additions, GITIGNORE_MANAGED_END];
  return lines.join("\n") + "\n";
}

/**
 * Find the managed block in an existing `.gitignore` body. Returns
 * `{ start, end }` byte-offsets of the BEGIN line through the END
 * line's trailing newline (inclusive), or `null` if no block exists.
 *
 * Detection is anchored to the literal marker strings — a partial
 * marker (BEGIN with no matching END, or END before BEGIN) is
 * treated as `null` (no managed block) and the next apply will
 * append a fresh block. This preserves user-managed content even
 * under marker corruption.
 */
function findGitignoreBlock(existingBody) {
  const beginIdx = existingBody.indexOf(GITIGNORE_MANAGED_BEGIN);
  if (beginIdx === -1) return null;
  const endIdx = existingBody.indexOf(GITIGNORE_MANAGED_END, beginIdx);
  if (endIdx === -1) return null;
  // Extend through the END line's trailing newline (if any).
  const newlineAfterEnd = existingBody.indexOf(
    "\n",
    endIdx + GITIGNORE_MANAGED_END.length,
  );
  const end =
    newlineAfterEnd === -1
      ? existingBody.length
      : newlineAfterEnd + 1; // include the newline
  return { start: beginIdx, end };
}

/**
 * Compute the post-apply body without doing any FS write. Pure
 * function for testability — the FS side-effect lives in
 * `applyGitignoreAdditions` below.
 *
 * Idempotency: applying the same `additions` to the result of a
 * prior apply produces byte-identical output.
 */
function computeGitignoreUpdate(existingBody, additions) {
  const block = composeGitignoreBlock(additions);
  const existing = findGitignoreBlock(existingBody);
  if (existing !== null) {
    // Replace the block in-place; lines outside untouched.
    const before = existingBody.slice(0, existing.start);
    const after = existingBody.slice(existing.end);
    return { content: before + block + after, action: "replaced" };
  }
  // Append. If the file is empty, just write the block. Otherwise
  // ensure a single blank line separates the user content from the
  // managed block — both for readability AND so a later re-find
  // operation always sees BEGIN at column 0.
  if (existingBody.length === 0) {
    return { content: block, action: "created" };
  }
  const sep = existingBody.endsWith("\n\n")
    ? ""
    : existingBody.endsWith("\n")
      ? "\n"
      : "\n\n";
  return { content: existingBody + sep + block, action: "appended" };
}

/**
 * Apply manifest-declared gitignore entries to `<dir>/.gitignore`
 * idempotently. Returns a structured result describing what changed.
 *
 *   dir       — absolute path of the target consumer repo (template root).
 *   additions — list of entries from parseGitignoreAdditions().
 *   dryRun    — when true, compute the new content but do not write.
 *
 * Return shape:
 *   { action: "replaced" | "appended" | "created" | "noop",
 *     added: <count of entries declared>,
 *     entries: <verbatim declared entries>,
 *     pre_bytes, post_bytes,
 *     gitignore_path: ".gitignore" }
 *
 * `action: "noop"` fires only when (a) the existing block content
 * exactly matches the about-to-write content (byte-equal), avoiding
 * a redundant atomic rename. This is what makes re-runs costless.
 */
function applyGitignoreAdditions(dir, additions, dryRun) {
  const gitignorePath = path.join(dir, ".gitignore");
  let existing = "";
  let preStat = null;
  try {
    // O_NOFOLLOW on the READ side too — a symlinked `.gitignore`
    // pointing outside the template is the same disclosure class
    // as the write-side TOCTOU.
    const fd = fs.openSync(
      gitignorePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      preStat = fs.fstatSync(fd);
      existing = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if (e.code === "ENOENT") {
      // No existing .gitignore — treat as empty.
      existing = "";
    } else if (e.code === "ELOOP") {
      // Symlink at .gitignore path — refuse rather than rewrite.
      throw new Error(
        `.gitignore at ${rel(gitignorePath)} is a symlink; refusing to write ` +
          `(O_NOFOLLOW). Resolve manually before next /sync.`,
      );
    } else {
      throw e;
    }
  }

  const { content, action } = computeGitignoreUpdate(existing, additions);

  // Short-circuit when nothing would change.
  if (content === existing) {
    return {
      action: "noop",
      added: additions.length,
      entries: additions.slice(),
      pre_bytes: existing.length,
      post_bytes: existing.length,
      gitignore_path: ".gitignore",
    };
  }

  if (!dryRun) {
    // Atomic write: tmp file + rename. tmp lives next to target so
    // rename is same-filesystem (POSIX guarantees atomic rename).
    //
    // Tmp suffix is `<pid>.<8-hex-random>` per Round-1 cross-agent
    // consensus (reviewer-MED-3 + security-LOW-2): pid alone collides
    // on (a) two concurrent invocations from a single Node process if
    // executePlan ever becomes async, AND (b) cross-process race on
    // the same out-tree where pid happens to recycle. The random
    // suffix collapses both to negligible probability without changing
    // the same-filesystem rename invariant. Same shape as Python
    // tempfile.NamedTemporaryFile pid+random + os.O_EXCL discipline.
    const tmpPath = path.join(
      dir,
      `.gitignore.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`,
    );
    try {
      safeWriteTextSync(tmpPath, content);
      // Preserve mode from existing file if any; default 0o644 already
      // set on open. (chmod intentionally omitted — safeWriteTextSync
      // creates with 0o644 which matches git's default for tracked files.)
      fs.renameSync(tmpPath, gitignorePath);
    } catch (e) {
      // Best-effort cleanup of the tmp file on failure; never let
      // a stale tmp block the next apply. Per `rules/observability.md`
      // Rule 5 (cleanup failures surface as WARN+) — log the unlink
      // failure to stderr so a stuck-tmp leaves a forensic trail
      // rather than vanishing into the surrounding error path.
      try {
        fs.unlinkSync(tmpPath);
      } catch (unlinkErr) {
        if (unlinkErr.code !== "ENOENT") {
          process.stderr.write(
            `sync-tier-aware: WARN cleanup of tmp ` +
              `'${rel(tmpPath)}' failed: ${unlinkErr.code || unlinkErr.message}\n`,
          );
        }
      }
      throw e;
    }
  }

  return {
    action,
    added: additions.length,
    entries: additions.slice(),
    pre_bytes: existing.length,
    post_bytes: content.length,
    gitignore_path: ".gitignore",
  };
}

// ────────────────────────────────────────────────────────────────
// Walk loom/.claude/ — emit every file relative to repo root.
// ────────────────────────────────────────────────────────────────
function walkClaudeDir() {
  const out = [];
  const stack = [CLAUDE_DIR];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(abs);
      } else if (e.isFile()) {
        // Path relative to REPO (matches manifest glob shape).
        out.push(path.relative(REPO, abs).split(path.sep).join("/"));
      }
    }
  }
  return out.sort();
}

// ────────────────────────────────────────────────────────────────
// Glob normalization — manifest tier globs are repo-root-relative
// but typically authored WITHOUT the leading `.claude/` prefix
// (e.g. `rules/git.md`, `agents/management/coc-sync.md`). The walk
// emits `.claude/rules/git.md`. We probe both shapes.
// ────────────────────────────────────────────────────────────────
function matchesManifestGlob(relpath, manifestGlob) {
  // Strip leading `.claude/` from the candidate so a bare manifest
  // glob like `rules/git.md` matches; also keep the full path for
  // globs authored WITH the prefix (always-include set).
  const stripped = relpath.startsWith(".claude/")
    ? relpath.slice(".claude/".length)
    : relpath;
  return (
    globToRegex(manifestGlob).test(relpath) ||
    globToRegex(manifestGlob).test(stripped)
  );
}

function matchesAnyManifestGlob(relpath, globs) {
  for (const g of globs) {
    if (matchesManifestGlob(relpath, g)) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────
// Inclusion computation
// ────────────────────────────────────────────────────────────────
function buildPlan(manifest, target, templateFilter) {
  const tiersMap = parseTiers(manifest);
  const repos = parseRepos(manifest);
  const repo = repos[target];
  if (!repo) {
    fail(
      1,
      `manifest defect: repos.${target} not declared in sync-manifest.yaml. ` +
        `Available: ${Object.keys(repos).join(", ")}`,
    );
  }
  if (repo.tier_subscriptions === null) {
    fail(
      1,
      `manifest defect: repos.${target}.tier_subscriptions missing ` +
        `(REQUIRED in v2.21.0+; halt per commands/sync.md Gate 2 step 3)`,
    );
  }

  const exclude = parseList(sliceBlock(manifest, "exclude"));
  const loomOnly = parseList(sliceBlock(manifest, "loom_only")); // F104 — positive never-sync
  const useExclude = parseList(sliceBlock(manifest, "use_exclude"));
  const useObsoleted = parseList(sliceBlock(manifest, "use_obsoleted"));
  const gitignoreAdditions = parseGitignoreAdditions(manifest);
  // FA — visibility-conditional additions (applied per-consumer in
  // executePlan based on each target's .coc-sync-marker visibility).
  const visibilityGitignoreAdditions =
    parseVisibilityGitignoreAdditions(manifest);

  // Reject unsafe purge entries at plan-build time (CRIT-1 defense).
  // An absolute / `.` / `..` entry would cause fs.rmSync to escape the
  // template dir; halt before any FS mutation.
  for (const entry of useObsoleted) {
    const defect = rejectUnsafePurgeEntry(entry);
    if (defect !== null) {
      fail(
        1,
        `manifest defect: use_obsoleted entry ${defect} ` +
          `— sync-tier-aware refuses to apply this purge list ` +
          `(would escape target dir)`,
      );
    }
  }

  // Reject unsafe gitignore_additions entries at plan-build time.
  // Same defense shape as use_obsoleted above — surface manifest
  // defects BEFORE any FS mutation.
  for (const entry of gitignoreAdditions) {
    const defect = rejectUnsafeGitignoreEntry(entry);
    if (defect !== null) {
      fail(
        1,
        `manifest defect: gitignore_additions entry ${defect} ` +
          `— sync-tier-aware refuses to apply this entry`,
      );
    }
  }

  // FA — same safety gate for visibility-conditional entries. The `!`
  // negation prefix (e.g. `!/workspaces/_template/`) is a legitimate
  // gitignore re-include and is NOT a path-escape; rejectUnsafe checks
  // line-terminator + marker-collision, neither of which `!` trips.
  for (const entry of visibilityGitignoreAdditions) {
    const defect = rejectUnsafeGitignoreEntry(entry);
    if (defect !== null) {
      fail(
        1,
        `manifest defect: visibility_gitignore_additions entry ${defect} ` +
          `— sync-tier-aware refuses to apply this entry`,
      );
    }
  }

  // Compose inclusion globs from subscribed tiers.
  const inclusionGlobs = [];
  for (const tier of repo.tier_subscriptions) {
    const g = tiersMap[tier];
    if (!g) {
      fail(
        1,
        `manifest defect: tiers.${tier} not declared but ` +
          `repos.${target}.tier_subscriptions references it`,
      );
    }
    inclusionGlobs.push(...g);
  }

  const templates =
    templateFilter === null
      ? repo.templates
      : repo.templates.filter((t) => t.repo === templateFilter);
  if (templateFilter !== null && templates.length === 0) {
    fail(
      2,
      `--template ${templateFilter} not found under repos.${target}. ` +
        `Available: ${repo.templates.map((t) => t.repo).join(", ")}`,
    );
  }
  const allFiles = walkClaudeDir();

  // Per-file disposition.
  const files = [];
  for (const f of allFiles) {
    const disposition = classifyFile(
      f,
      inclusionGlobs,
      exclude,
      useExclude,
      loomOnly,
    );
    files.push({ path: f, ...disposition });
  }

  // #427 — variant_only distribution pass. classifyFile EXCLUDES every
  // `variants/**` path (the global enumerator is tier-only); variant_only
  // ADDITIONS are distributed here, copied to their stripped destination
  // (see expandVariantOnly). `variant_only_missing` is the completeness
  // gap (a declared entry matching zero loom files) — main() hard-fails the
  // WRITE path on it, mirroring the #401 Defect-2 byte-verify teeth.
  const variantOnlyMap = parseVariantOnly(manifest);
  const { files: variantOnlyFiles, missing: variantOnlyMissing } =
    expandVariantOnly(allFiles, repo.variant, variantOnlyMap[repo.variant] || []);

  return {
    target,
    variant: repo.variant,
    tier_subscriptions: repo.tier_subscriptions,
    templates: templates.map((t) => t.repo),
    files,
    variant_only: variantOnlyFiles,
    variant_only_missing: variantOnlyMissing,
    purge: useObsoleted.slice(),
    gitignore_additions: gitignoreAdditions.slice(),
    visibility_gitignore_additions: visibilityGitignoreAdditions.slice(),
  };
}

function classifyFile(relpath, inclusionGlobs, exclude, useExclude, loomOnly = []) {
  // 1. Always-include — wins over everything except loom-local.
  const alwaysInc = matchesAny(relpath, ALWAYS_INCLUDE);
  // 2. Loom-local — universal skip (gitignored operator config).
  if (matchesAny(relpath, LOOM_LOCAL_PATTERNS)) {
    return { action: "skip", reason: "loom_local" };
  }
  // 2b. loom_only (F104) — POSITIVE never-sync declaration. A matching
  // path is skipped for EVERY target, BEFORE tier inclusion — a positive
  // skip, not an accidental `no_tier_match`. Checked before always-include
  // so a loom-only artifact is never copied even if it matched ALWAYS_INCLUDE
  // (none do today; the ordering makes the never-sync invariant total).
  if (matchesAnyManifestGlob(relpath, loomOnly)) {
    return { action: "skip", reason: "loom_only" };
  }
  if (alwaysInc) {
    return { action: "copy", reason: "always_include" };
  }
  // 3. exclude (universal).
  if (matchesAnyManifestGlob(relpath, exclude)) {
    return { action: "skip", reason: "exclude" };
  }
  // 4. use_exclude (USE-template only — this tool emits to USE templates).
  if (matchesAnyManifestGlob(relpath, useExclude)) {
    return { action: "skip", reason: "use_exclude" };
  }
  // 5. Tier inclusion.
  if (matchesAnyManifestGlob(relpath, inclusionGlobs)) {
    return { action: "copy", reason: "tier_match" };
  }
  return { action: "skip", reason: "no_tier_match" };
}

// ────────────────────────────────────────────────────────────────
// Target path resolution — loom-links resolver, never positional.
// ────────────────────────────────────────────────────────────────
function resolveTemplateDir(repo, outOverride) {
  if (outOverride !== null) return outOverride;
  // Logical key: `use-template.<short-key>`. Strip `kailash-coc-` /
  // `coc-` prefixes to derive the short key. The operator's
  // `.local.json` declares these.
  const shortKey = repo
    .replace(/^kailash-coc-/, "")
    .replace(/^coc-/, "");
  const key = `use-template.${shortKey}`;
  const r = resolveRepo(key, { require: false });
  if (r.skipped) {
    fail(
      3,
      `loom-links resolver: ${r.reason}\n` +
        `(declare 'use-template.${shortKey}' in loom-links.local.json, ` +
        `or pass --out <dir> to override)`,
    );
  }
  if (r.kind !== "path") {
    fail(
      3,
      `loom-links: '${key}' is a ${r.kind}, expected path linkage`,
    );
  }
  return r.value;
}

// ────────────────────────────────────────────────────────────────
// Execution — copy + purge
// ────────────────────────────────────────────────────────────────
function executePlan(plan, outOverride, dryRun) {
  // Two-pass execution (MED-3 defense): resolve EVERY template path
  // BEFORE any FS mutation. A missing resolver entry halts the whole
  // run rather than leaving partial state across templates 1..N-1 when
  // template N fails.
  const resolvedDirs = plan.templates.map((tmpl) =>
    resolveTemplateDir(tmpl, outOverride),
  );

  const results = [];
  for (let i = 0; i < plan.templates.length; i++) {
    const tmpl = plan.templates[i];
    const dir = resolvedDirs[i];
    const result = {
      template: tmpl,
      // HIGH-2 / MED-A defense: results carry the BASENAME, not the
      // resolved absolute path. emitText AND --json both consume this
      // shape; both branches stay disclosure-clean. The absolute `dir`
      // remains local to executePlan (closed over below) for FS ops —
      // never escapes the function as serialized output.
      target_basename: path.basename(dir),
      copied: [],
      verified: 0,
      verify_failures: [],
      variant_only_copied: [],
      variant_only_verified: 0,
      variant_only_verify_failures: [],
      purged: [],
      skipped: {
        loom_local: 0,
        exclude: 0,
        use_exclude: 0,
        no_tier_match: 0,
      },
    };
    // #401 forever-fix: snapshot this template's untracked working-tree
    // files to an out-of-tree quarantine BEFORE any copy/purge below.
    // Per-dir, so it covers collateral fan-out writes. A throw here
    // propagates and HALTS the run rather than mutating unprotected work.
    const presync = snapshotUntrackedFiles(dir, { dryRun });
    result.presync_snapshot =
      presync.count > 0
        ? { dir: path.basename(presync.snapshotDir), count: presync.count }
        : null;
    for (const f of plan.files) {
      if (f.action === "skip") {
        result.skipped[f.reason] = (result.skipped[f.reason] || 0) + 1;
        continue;
      }
      const src = path.join(REPO, f.path);
      // CRIT-2 defense: containment check on dest. f.path comes from
      // walkClaudeDir() which cannot produce `..` segments today, but
      // a future manifest-driven enumeration would inherit the gap.
      let dest;
      try {
        dest = safeJoinUnder(dir, f.path);
      } catch (e) {
        fail(1, `copy refused: ${e.message}`);
      }
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // HIGH-1 defense: O_NOFOLLOW refuses symlink targets at dest.
        safeCopyFile(src, dest);
        // #401 Defect-2 fix: post-copy byte-equality. A plain `copied++`
        // count trusts that safeCopyFile landed the bytes; the incident
        // proved a copy can silently no-op (dest left at stale HEAD).
        const reason = verifyCopiedBytes(src, dest);
        if (reason === null) {
          result.verified++;
        } else {
          result.verify_failures.push(`${path.relative(dir, dest)} — ${reason}`);
        }
      }
      result.copied.push({
        src: f.path,
        dest: path.relative(dir, dest),
        reason: f.reason,
      });
    }
    // #427 — variant_only distribution. These live under `variants/<variant>/`
    // in loom (EXCLUDED from the global copy above) and land at the STRIPPED
    // destination (vf.dest, already `.claude/`-prefixed). Same O_NOFOLLOW copy
    // + post-copy byte-equality (#401 Defect-2) as the global branch, so a
    // silent no-op / stale-bytes copy surfaces as a verify failure and blocks.
    for (const vf of plan.variant_only || []) {
      const src = path.join(REPO, vf.path);
      let dest;
      try {
        dest = safeJoinUnder(dir, vf.dest);
      } catch (e) {
        fail(1, `variant_only copy refused: ${e.message}`);
      }
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        safeCopyFile(src, dest);
        const reason = verifyCopiedBytes(src, dest);
        if (reason === null) {
          result.variant_only_verified++;
        } else {
          result.variant_only_verify_failures.push(
            `${path.relative(dir, dest)} — ${reason}`,
          );
        }
      }
      result.variant_only_copied.push({
        src: vf.path,
        dest: path.relative(dir, dest),
        entry: vf.variant_only_entry,
      });
    }
    // Purge use_obsoleted at target (only if path exists at target).
    // CRIT-1 defense: containment check rejects `..` / absolute /
    // `.` entries that escape the template dir. Pre-validated at
    // plan-build time (rejectUnsafePurgeEntry); this is the runtime
    // belt to the parse-time braces.
    for (const p of plan.purge) {
      let targetAbs;
      try {
        targetAbs = safeJoinUnder(dir, p);
      } catch (e) {
        fail(1, `purge refused: ${e.message}`);
      }
      if (fs.existsSync(targetAbs)) {
        if (!dryRun) {
          const stat = fs.lstatSync(targetAbs);
          if (stat.isDirectory()) fs.rmSync(targetAbs, { recursive: true, force: true });
          else fs.unlinkSync(targetAbs);
        }
        result.purged.push({ path: p });
      }
    }
    // Apply gitignore_additions (GH #368 finding 1). Idempotent —
    // a re-run on a previously-applied template produces action:"noop".
    // Failures here halt the whole run rather than leaving partial
    // state across templates 1..N-1.
    //
    // FA — resolve THIS consumer's visibility from its .coc-sync-marker
    // (default public, fail-safe) and merge the visibility-conditional
    // entries. Public → base + visibility (session-notes + active
    // workspaces ignored, _template preserved). Private → base only
    // (TRACK session-notes + workspaces as team knowledge).
    const marker = readConsumerVisibility(dir);
    const effectiveAdds = effectiveGitignoreAdditions(
      plan.gitignore_additions,
      plan.visibility_gitignore_additions,
      marker,
    );
    result.visibility = marker.visibility;
    try {
      result.gitignore = applyGitignoreAdditions(dir, effectiveAdds, dryRun);
    } catch (e) {
      fail(1, `gitignore apply refused: ${e.message}`);
    }
    results.push(result);
  }
  return results;
}

// ────────────────────────────────────────────────────────────────
// Reporting
// ────────────────────────────────────────────────────────────────
function emitText(plan, results, dryRun) {
  const mode = dryRun ? "DRY RUN" : "WRITE";
  const lines = [];
  lines.push(
    `# sync-tier-aware ${mode} — target=${plan.target} ` +
      `variant=${plan.variant ?? "—"} ` +
      `tiers=[${plan.tier_subscriptions.join(",")}]`,
  );
  // #427 — completeness gap: declared variant_only entries with ZERO loom
  // matches. Surfaced in BOTH dry-run (preview) and write; main() additionally
  // hard-fails the WRITE path on a non-empty list.
  if (plan.variant_only_missing && plan.variant_only_missing.length) {
    lines.push(
      `  ✗ variant_only INCOMPLETE — ${plan.variant_only_missing.length} declared ` +
        `entr${plan.variant_only_missing.length === 1 ? "y" : "ies"} matched ZERO loom ` +
        `source files (manifest declares a file absent from loom):`,
    );
    for (const e of plan.variant_only_missing) lines.push(`      - ${e}`);
  }
  for (const r of results) {
    // HIGH-2 defense: result carries target_basename (set in
    // executePlan); the absolute path never escapes the function.
    // Per `bin/lib/loom-links.mjs` § Disclosure discipline.
    lines.push("");
    lines.push(`## template: ${r.template}`);
    lines.push(`   target_dir: ${r.target_basename}/`);
    if (r.presync_snapshot) {
      // Surface the safety action so the operator SEES that N untracked
      // files were quarantined and where to recover them (reviewer LOW-1).
      lines.push(
        `   presync_snapshot: ${r.presync_snapshot.count} untracked file(s) → .git/${r.presync_snapshot.dir}/`,
      );
    }
    lines.push(`   copied:  ${r.copied.length}`);
    if (!dryRun) {
      // #401 Defect-2: byte-equality verified count + any under-delivery.
      lines.push(
        `   verified: ${r.verified}/${r.copied.length} byte-equal` +
          (r.verify_failures.length
            ? ` — ${r.verify_failures.length} FAILED (sync under-delivered)`
            : ""),
      );
    }
    // #427 — variant_only distribution line (one per template).
    const voCopied = r.variant_only_copied ? r.variant_only_copied.length : 0;
    lines.push(
      `   variant_only: ${voCopied} copied` +
        (!dryRun
          ? ` — ${r.variant_only_verified}/${voCopied} byte-equal` +
            (r.variant_only_verify_failures && r.variant_only_verify_failures.length
              ? ` — ${r.variant_only_verify_failures.length} FAILED (variant_only under-delivered)`
              : "")
          : ""),
    );
    lines.push(`   purged:  ${r.purged.length}`);
    lines.push(
      `   skipped: loom_local=${r.skipped.loom_local || 0} ` +
        `exclude=${r.skipped.exclude || 0} ` +
        `use_exclude=${r.skipped.use_exclude || 0} ` +
        `no_tier_match=${r.skipped.no_tier_match || 0}`,
    );
    if (r.gitignore) {
      lines.push(
        `   .gitignore: ${r.gitignore.action} ` +
          `(${r.gitignore.added} declared entr${r.gitignore.added === 1 ? "y" : "ies"}, ` +
          `${r.gitignore.pre_bytes}B → ${r.gitignore.post_bytes}B)`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────
function rel(p) {
  try {
    return path.relative(process.cwd(), p) || p;
  } catch {
    return p;
  }
}

function fail(code, msg) {
  process.stderr.write(`sync-tier-aware: ${msg}\n`);
  process.exit(code);
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);
  const manifest = loadManifest();
  const plan = buildPlan(manifest, args.target, args.template);
  // #401 Defect-1 fix (ROOT CAUSE of the data loss): an un-scoped
  // `--target <lane>` WRITE fans out to EVERY template in the lane as
  // collateral. The incident: a sync intended for one consumer also wrote
  // globals into a sibling consumer's working tree, and the cleanup
  // destroyed that sibling's untracked files. A lane-wide WRITE MUST be an
  // explicit operator decision, never the silent default. The gate fires
  // on the WRITE path only — `--dry-run` inspection is free to preview the
  // whole lane (that is its purpose; the danger is the write, not the
  // preview). When the lane has >1 template and neither --template nor
  // --all-templates was given, HALT before any FS mutation.
  if (
    !args.dryRun &&
    args.template === null &&
    !args.allTemplates &&
    plan.templates.length > 1
  ) {
    fail(
      2,
      `lane '${args.target}' has ${plan.templates.length} templates ` +
        `[${plan.templates.join(", ")}]. ` +
        `Refusing an implicit lane-wide write (#401 data-loss root cause). ` +
        `Pass --template <repo> to scope to one, or --all-templates to ` +
        `write all ${plan.templates.length} (serial, snapshot-protected). ` +
        `(Re-run with --dry-run to preview the full lane without writing.)`,
    );
  }
  const results = executePlan(plan, args.out, args.dryRun);
  if (args.json) {
    const out = { plan, results, dry_run: args.dryRun };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else {
    process.stdout.write(emitText(plan, results, args.dryRun));
  }
  // #401 Defect-2 fix: a non-zero verify_failures count means the tool
  // reported a copy it did not actually land (the silent apply-gap: the
  // incident reported `copied 1228` while 13 hooks + 189 files stayed at
  // stale HEAD content). Surface every mismatch and exit non-zero so a
  // caller can NEVER trust a success count that masks an under-delivery.
  if (!args.dryRun) {
    const failed = results.flatMap((r) =>
      [
        ...(r.verify_failures || []),
        // #427 — variant_only byte-equality failures share the #401 Defect-2
        // teeth: a copy that silently no-ops / lands stale bytes blocks the sync.
        ...(r.variant_only_verify_failures || []),
      ].map((f) => `${r.template}: ${f}`),
    );
    if (failed.length > 0) {
      fail(
        1,
        `post-copy byte-equality verification FAILED for ${failed.length} ` +
          `path(s) — the sync under-delivered (#401 Defect 2 / #427):\n  ` +
          failed.slice(0, 20).join("\n  ") +
          (failed.length > 20 ? `\n  …and ${failed.length - 20} more` : ""),
      );
    }
    // #427 — completeness gate: a declared variant_only entry that matched
    // ZERO loom source files is a manifest-vs-source defect. Block the WRITE
    // so a sync can NEVER complete with a declared-but-undistributable file.
    if (plan.variant_only_missing && plan.variant_only_missing.length > 0) {
      fail(
        1,
        `variant_only INCOMPLETE (#427): ${plan.variant_only_missing.length} ` +
          `declared entr${plan.variant_only_missing.length === 1 ? "y" : "ies"} ` +
          `for variant '${plan.variant}' matched ZERO loom source files ` +
          `(manifest declares a file that does not exist in loom):\n  ` +
          plan.variant_only_missing.join("\n  "),
      );
    }
  }
}

// Run only when invoked directly (not when imported by tests).
// Use realpathSync to resolve symlinks (macOS /var/folders → /private/var/folders).
function _isInvokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
if (_isInvokedDirectly()) {
  try {
    main();
  } catch (e) {
    if (e instanceof LinkError) {
      fail(3, `loom-links: ${e.subtype}: ${e.message}`);
    }
    fail(1, `${e.message || e}`);
  }
}

// ────────────────────────────────────────────────────────────────
// Exports (for regression tests)
// ────────────────────────────────────────────────────────────────
export {
  parseArgs,
  parseTiers,
  parseRepos,
  parseVariantOnly,
  expandVariantOnly,
  parseList,
  sliceBlock,
  globToRegex,
  matchesAny,
  matchesManifestGlob,
  matchesAnyManifestGlob,
  classifyFile,
  buildPlan,
  safeJoinUnder,
  snapshotUntrackedFiles,
  verifyCopiedBytes,
  rejectUnsafePurgeEntry,
  parseGitignoreAdditions,
  parseVisibilityGitignoreAdditions,
  readConsumerVisibility,
  effectiveGitignoreAdditions,
  rejectUnsafeGitignoreEntry,
  composeGitignoreBlock,
  findGitignoreBlock,
  computeGitignoreUpdate,
  applyGitignoreAdditions,
  GITIGNORE_MANAGED_BEGIN,
  GITIGNORE_MANAGED_END,
  ALWAYS_INCLUDE,
  LOOM_LOCAL_PATTERNS,
};
