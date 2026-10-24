/**
 * shipped-tree-walk — the ONE enumerator of what delivery ships from a tree.
 *
 * `sync-tier-aware.mjs::walkClaudeDir` builds every distribution plan from
 * `walkShippedTree(REPO, CLAUDE_DIR)`, and the guards that ask "does anything
 * that ships do X?" read the same function (the #1442 emit-reference sweep,
 * `tests/integration/multi-operator/lib/emit-reference-sweep.js::shippedScripts`,
 * and the runner-basename guard,
 * `.claude/test-harness/tests/audit-fixture-runner-basename-parity.test.mjs::sourceFiles`).
 * A guard that enumerated with `git ls-files` instead disagreed with delivery
 * wherever the index and the disk differ (sigcov R1): a path tracked under a
 * different letter case that a case-insensitive checkout writes into `.claude/`
 * (W1), and an untracked nested repository, which `--others` reports as one
 * directory entry (W2, C2). A tracked path absent from disk (sparse checkout,
 * skip-worktree — C1) agreed only because an `existsSync` filter happened to
 * drop it. One enumerator makes "swept == shipped" hold by construction
 * instead of by argument.
 *
 * WHAT IT RETURNS. Every REGULAR file under `rootDir` on disk — a
 * `readdirSync` walk that descends real directories, never a symlink, and keeps
 * only `isFile()` entries (so symlinks, dangling or not, are neither shipped
 * nor swept) — repo-relative with forward slashes, sorted, minus every path the
 * repository's own ignore rules ignore (`filterSourceIgnored`). An entry
 * named `.git` (a nested repository's git directory, or a worktree's gitfile)
 * is never descended into and never returned (sigcov R2-2): git itself never
 * tracks a path component named `.git`, so no legitimate shipped file is one,
 * and its `config` can carry remote URLs with credentials and signing-key
 * selectors.
 *
 * WHAT IT REFUSES (a throw; nothing is returned):
 *   - an EMBEDDED REPOSITORY: a directory under the root holding a `.git`
 *     entry that the repository's ignore rules do not ignore (sigcov R2-2). It
 *     cannot be delivered faithfully, and a consumer's git would treat it as
 *     an embedded repo anyway. An ignored one ships nothing and is not refused.
 *   - an UNREADABLE DIRECTORY: EACCES, EPERM, or any read error other than
 *     the directory having vanished (ENOENT/ENOTDIR) mid-walk (sigcov R2-6). A
 *     skipped directory would drop out of delivery AND every shipped-set guard
 *     with no signal, so a guard's "0 references" would read the same as
 *     "never looked". No legitimate delivery tree holds one: git cannot record
 *     a directory's permissions, so an unreadable directory is local debris.
 *   - two shipped paths one destination filesystem can hold only one of
 *     (sigcov R1 W1, R2-4), compared under `foldKey`: Unicode NFC
 *     normalisation (an NFC and an NFD spelling of one name collide) and full
 *     case folding (`ß` collides with `ss`, `K` with the Kelvin sign). Which
 *     bytes land would otherwise depend on copy order.
 *
 * CommonJS so the CommonJS sweep can require it and the ES-module callers can
 * import it.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// loom#888 — explicit maxBuffer for git calls that capture output; the same
// 64MiB `sync-tier-aware.mjs::MAX_GIT_BUFFER` uses.
const MAX_GIT_BUFFER = 64 * 1024 * 1024;

function defaultGitRunner(args, opts) {
  return execFileSync("git", args, { maxBuffer: MAX_GIT_BUFFER, ...opts });
}

/**
 * Remove from `relPaths` (repo-root-relative, forward-slash) any path that
 * loom's OWN source `.gitignore` ignores. The ALWAYS_INCLUDE walk
 * (`.claude/hooks/**`, `.claude/bin/**`, …) is a raw filesystem walk: stray
 * gitignored junk under those trees on the operator's disk (`.DS_Store`,
 * an all-commented `.env` template) would otherwise be swept into the
 * distribution and written to EVERY consumer. A source-gitignored file MUST
 * NEVER enter the distribution (loom#710); the Rule-6 swallowed-artifact gate
 * (loom#676) stays the downstream backstop, but the fix is to never emit, not
 * to force-track downstream (which would make `.env`/`.DS_Store` git-tracked
 * at 30+ consumers — a `security.md` "No .env in Git" violation).
 *
 * Fail-safe (mirrors findSwallowedArtifacts + evidence-first-claims MUST-3):
 *   - git RAN and reported non-repo (exit 128 "not a git repository") →
 *     no source `.gitignore` semantics → structural no-op, return all
 *     (covers a synthetic `--out`/test REPO that is not a git checkout);
 *   - check-ignore exit 1 → NONE ignored → return all;
 *   - check-ignore exit 0 → remove the listed (echoed verbatim as fed);
 *   - ANY other error (git missing, exit 128 inside a repo, transient FS) →
 *     THROW. An errored ignore-detector is NOT an all-clear: refusing to
 *     report clean is the only way to honor "never emit source-ignored".
 */
function filterSourceIgnored(repoDir, relPaths, runGit = defaultGitRunner) {
  if (!relPaths || relPaths.length === 0) return relPaths || [];
  // Precondition: is repoDir a git repo? Distinguish a GENUINE non-repo
  // (legitimate structural no-op) from a detector-could-not-run failure.
  try {
    runGit(["-C", repoDir, "rev-parse", "--git-dir"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e) {
    const stderr = e && e.stderr != null ? String(e.stderr) : "";
    if (e && e.status === 128 && /not a git repository/i.test(stderr)) {
      return relPaths.slice(); // git RAN and reported non-repo — no .gitignore to honor
    }
    throw new Error(
      `filterSourceIgnored: source-gitignore filter could NOT run at ${repoDir} ` +
        `— git rev-parse failed (${e && e.code ? e.code : "status " + (e && e.status)})` +
        `${stderr ? ": " + stderr.trim() : ""}; refusing to emit unfiltered ` +
        `(could ship a source-ignored file per loom#710 — detector status UNKNOWN ` +
        `per evidence-first-claims MUST-3).`,
    );
  }
  let out = "";
  try {
    out = runGit(["-C", repoDir, "check-ignore", "--stdin"], {
      input: relPaths.join("\n") + "\n",
      encoding: "utf8",
    });
  } catch (e) {
    if (e.status === 1) return relPaths.slice(); // none ignored — emit all
    throw e; // genuine git error in a git repo — surface, never emit-unfiltered
  }
  const ignored = new Set(
    out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return relPaths.filter((p) => !ignored.has(p));
}

/**
 * The key under which a case-insensitive, normalisation-insensitive
 * destination (APFS, NTFS) treats two names as one: NFC, then full case
 * folding by upper-then-lower (`"ß".toUpperCase()` is `"SS"`), then NFC again
 * because case mapping can emit a decomposed sequence. Implemented locally: no
 * shared Unicode comparator exists on this base (sigcov R2-4; to be unified
 * with m-w4-2's at train-9 integration).
 */
function foldKey(p) {
  return String(p).normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/**
 * Throw when two of `relPaths` are equal under `foldKey`. Pure: it reads only
 * the list, so it is testable on a case-insensitive filesystem that cannot
 * hold such a pair on disk.
 */
function assertNoCaseCollisions(relPaths) {
  const seen = new Map();
  const collisions = [];
  for (const p of relPaths) {
    const key = foldKey(p);
    if (seen.has(key)) collisions.push(`${seen.get(key)} <-> ${p}`);
    else seen.set(key, p);
  }
  if (collisions.length > 0) {
    throw new Error(
      `shipped-tree-walk: ${collisions.length} pair(s) of shipped paths differ only by letter case or Unicode normalisation: ` +
        `${collisions.join("; ")} — a case-insensitive destination (macOS, Windows) can hold only one ` +
        "of each pair, so what lands would depend on copy order; rename or remove one of each pair",
    );
  }
}

/**
 * Every regular file under `rootDir` (absolute, inside `repoDir`) that
 * delivery ships: see the module header.
 */
function walkShippedTree(repoDir, rootDir, { runGit = defaultGitRunner } = {}) {
  // Path relative to the repository (matches manifest glob shape).
  const rel = (abs) => path.relative(repoDir, abs).split(path.sep).join("/");
  const repoRoot = path.resolve(repoDir);
  const out = [];
  const embedded = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // A directory that vanished mid-walk (or a root that does not exist)
      // ships nothing; any other failure would drop real content silently.
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) continue;
      throw new Error(
        `shipped-tree-walk: cannot read directory ${rel(dir) || "."} (${(err && err.code) || (err && err.message) || err}) — ` +
          "refusing to enumerate a partial shipped set: it would drop out of delivery and of every " +
          "shipped-set guard with no signal; make it readable or remove it",
      );
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.name === ".git") {
        // Never shipped, never descended. The repository's own git entry is
        // not under a shipped root; skip it if a caller walks the root itself.
        if (path.resolve(dir) !== repoRoot) embedded.push(rel(dir));
        continue;
      }
      if (e.isDirectory()) {
        stack.push(abs);
      } else if (e.isFile()) {
        out.push(rel(abs));
      }
    }
  }
  // An embedded repository the ignore rules do not cover is refused, never
  // half-shipped (sigcov R2-2); an ignored one ships nothing.
  const shippedEmbedded = filterSourceIgnored(repoDir, embedded.sort(), runGit);
  if (shippedEmbedded.length > 0) {
    throw new Error(
      `shipped-tree-walk: ${shippedEmbedded.length} embedded git repositor${shippedEmbedded.length === 1 ? "y" : "ies"} ` +
        `under a shipped root: ${shippedEmbedded.join(", ")} — a nested repository cannot be delivered faithfully ` +
        "and its git directory holds operator-local state (remote URLs, identity); ignore it or move it out",
    );
  }
  // loom#710 — never emit a file the repository's OWN .gitignore ignores
  // (.DS_Store / .env junk under an always-include tree must not ship).
  const shipped = filterSourceIgnored(repoDir, out.sort(), runGit);
  assertNoCaseCollisions(shipped);
  return shipped;
}

module.exports = {
  walkShippedTree,
  filterSourceIgnored,
  assertNoCaseCollisions,
  foldKey,
};
