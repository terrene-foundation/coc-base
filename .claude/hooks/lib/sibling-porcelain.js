/**
 * sibling-porcelain — sibling-worktree mutation detection primitive.
 *
 * Shard B3a (workspaces/multi-operator-coc/02-plans/01-architecture.md
 * §2.3 + §4.2 filesystem exception + §4.3 signing-mutation-guard.js row).
 *
 * The PRODUCTION primitive that supersedes the COC_PORCELAIN_OVERRIDE
 * test-surrogate B1's adjacency-leasecheck.js documented as future-wiring.
 *
 * Concept:
 *   Per architecture R4-S-02 + R5-S-03, the §4.2 filesystem exception
 *   ("cross-worktree contention shows the EXACT target file uncommitted-
 *   modified on a sibling worktree") is detectable by enumerating sibling
 *   worktrees and reading each one's `git status --porcelain`. The
 *   porcelain enumeration is a process-local structural primitive (no
 *   network, no cross-clone signal) — qualifies as the
 *   hook-output-discipline.md MUST-2 "structural fact the agent cannot
 *   rationalize away" — so the consuming hooks (signing-mutation-guard.js
 *   in B3a, adjacency-leasecheck.js in B1) MAY emit severity:block on a
 *   match.
 *
 * Primitive API:
 *   enumerateSiblingWorktrees(repoDir) → array of sibling worktree
 *     absolute paths (NEVER includes repoDir's own current worktree;
 *     NEVER includes a worktree under .claude/worktrees/ — those are
 *     agent-isolation worktrees per worktree-isolation.md, NOT sibling
 *     operator worktrees).
 *
 *   detectSiblingMutation(repoDir, targetRelPath) → array of match
 *     objects {worktree, target} where any sibling worktree's
 *     `git status --porcelain` output shows the exact targetRelPath
 *     modified/added/staged. Returns [] when no match.
 *
 * Production-vs-test precedence (Rule 4 of B3a):
 *   B1's adjacency-leasecheck.js retains COC_PORCELAIN_OVERRIDE as the
 *   test-surrogate (precedence: override-set → use override; else → call
 *   detectSiblingMutation). B3a's signing-mutation-guard mirrors that
 *   precedence so the B1 test suite (which sets COC_PORCELAIN_OVERRIDE
 *   on real worktrees that lack the production primitive's enumeration
 *   conditions) remains green.
 *
 * Why this lives in lib/ and not inline:
 *   Both hooks (signing-mutation-guard.js AND adjacency-leasecheck.js)
 *   need the same primitive. Per architecture v11 §2.3's note "All new
 *   hooks reuse lib/runtime.js, lib/instruct-and-wait.js, ..." the
 *   sibling-worktree primitive is a reusable building block.
 *
 * Style: CommonJS to match sibling .claude/hooks/lib/* modules. No
 * external deps. Spawns `git worktree list --porcelain` + `git -C <path>
 * status --porcelain` as subprocesses — git is the canonical
 * implementation of these primitives, per rules/dependencies.md "Own
 * the Stack" (we do NOT re-implement git's worktree-list or
 * porcelain-status parsers).
 */

"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const STATUS_TIMEOUT_MS = 3000;

/**
 * Safe subprocess wrapper. Returns {ok, stdout, stderr} — never throws.
 * Honors stdio:["ignore","pipe","pipe"] for deterministic capture.
 */
function _git(args, opts) {
  const o = opts || {};
  try {
    const r = spawnSync("git", args, {
      cwd: o.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: o.timeout || STATUS_TIMEOUT_MS,
    });
    if (r.status !== 0) {
      return { ok: false, stdout: r.stdout || "", stderr: r.stderr || "" };
    }
    return { ok: true, stdout: r.stdout || "", stderr: r.stderr || "" };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Enumerate sibling worktrees of `repoDir`.
 *
 * Implementation: parse `git worktree list --porcelain` output blocks.
 * Each block looks like:
 *
 *   worktree /abs/path/to/worktree
 *   HEAD <sha>
 *   branch refs/heads/<branch>
 *
 * Returns absolute paths NOT equal to repoDir AND NOT inside
 * .claude/worktrees/ (those are agent-isolation worktrees per
 * worktree-isolation.md; they are this session's own forks, not sibling
 * operator clones).
 *
 * Returns [] on any failure (no git, not a repo, single-checkout). The
 * empty-set return is the structural-NULL — the caller MUST treat empty
 * as "no sibling mutation detected" (advisory passthrough), NOT as
 * "all clear, definitely no contention".
 */
function enumerateSiblingWorktrees(repoDir) {
  if (!repoDir || typeof repoDir !== "string") return [];
  const r = _git(["worktree", "list", "--porcelain"], { cwd: repoDir });
  if (!r.ok) return [];
  // Resolve repoDir to its absolute form for safe equality comparison.
  const selfTop = _git(["rev-parse", "--show-toplevel"], { cwd: repoDir });
  const selfAbs = selfTop.ok ? selfTop.stdout.trim() : path.resolve(repoDir);

  // M3 MED-2 / F-5: containment check via git-common-dir comparison.
  // `git worktree list --porcelain` returns whatever paths git tracks;
  // a malicious actor or misconfigured filesystem could plant entries
  // pointing outside the repo's actual common-dir. The structural
  // defense is to verify each candidate sibling's common-dir matches
  // our own — same repo = same common-dir, by git's invariant.
  const selfCommon = _git(["rev-parse", "--git-common-dir"], { cwd: repoDir });
  if (!selfCommon.ok) return [];
  const selfCommonAbs = path.resolve(repoDir, selfCommon.stdout.trim());

  const blocks = r.stdout.split(/\n\n+/);
  const out = [];
  for (const block of blocks) {
    const m = block.match(/^worktree\s+(.+)$/m);
    if (!m) continue;
    const wtPath = m[1].trim();
    if (!wtPath) continue;
    // Skip the current worktree.
    if (wtPath === selfAbs) continue;
    // Skip agent-isolation worktrees per worktree-isolation.md — they
    // are session-owned forks of this same checkout, not sibling
    // operator clones. (Mirrors state-resolver.js's filter.)
    if (wtPath.includes("/.claude/worktrees/")) continue;
    // Containment check: the candidate sibling MUST resolve to the same
    // git-common-dir as self. Different common-dir = different repo
    // entirely; skip + log advisory.
    const cCommon = _git(["rev-parse", "--git-common-dir"], { cwd: wtPath });
    if (!cCommon.ok) {
      try {
        process.stderr.write(
          `[ADVISORY] sibling-porcelain: skipping ${wtPath} — git-common-dir resolve failed\n`,
        );
      } catch {
        // best-effort
      }
      continue;
    }
    const cCommonAbs = path.resolve(wtPath, cCommon.stdout.trim());
    if (cCommonAbs !== selfCommonAbs) {
      try {
        process.stderr.write(
          `[ADVISORY] sibling-porcelain: skipping ${wtPath} — different git-common-dir (self=${selfCommonAbs}, candidate=${cCommonAbs})\n`,
        );
      } catch {
        // best-effort
      }
      continue;
    }
    out.push(wtPath);
  }
  return out;
}

/**
 * Parse a `git status --porcelain` output into an array of repo-relative
 * paths. Porcelain rows look like:
 *
 *   XY <space> <path>           (no rename)
 *   XY <space> <path> -> <new>  (rename — both old + new)
 *
 * Where X = index status and Y = working-tree status.
 * For the §4.2 exception "uncommitted-modified" we accept ANY non-empty
 * row — modified, added, staged, untracked, renamed — because every
 * non-empty row IS evidence the sibling worktree has uncommitted state
 * on that path; the mutation predicate is satisfied.
 *
 * Returns array of strings (repo-relative paths in the sibling worktree).
 */
function _parsePorcelain(stdout) {
  if (!stdout) return [];
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  const paths = [];
  for (const line of lines) {
    // Porcelain v1: 2-char status + space + path. Renames have " -> ".
    if (line.length < 3) continue;
    const rest = line.slice(3);
    if (!rest) continue;
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) {
      // Rename: capture both source and destination paths — both
      // sides of a rename are "modified" in the sibling worktree's
      // sense.
      const src = rest.slice(0, arrow).trim();
      const dst = rest.slice(arrow + 4).trim();
      if (src) paths.push(_unquotePorcelain(src));
      if (dst) paths.push(_unquotePorcelain(dst));
    } else {
      paths.push(_unquotePorcelain(rest.trim()));
    }
  }
  return paths;
}

/**
 * Porcelain quotes paths containing spaces / non-ASCII with double-quotes
 * + C-style escapes (when core.quotePath=true, default). For our exact-
 * match predicate we strip the surrounding quotes; the remaining escape
 * sequences are not unescaped (worst case is the comparison misses a
 * match for a path containing weird chars — that surfaces as a false
 * negative, NOT a false positive, so the structural-signal contract
 * holds — block-on-no-match instead of block-on-match would be the
 * dangerous side).
 */
function _unquotePorcelain(s) {
  if (
    s.length >= 2 &&
    s.charCodeAt(0) === 0x22 &&
    s.charCodeAt(s.length - 1) === 0x22
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Detect sibling-worktree mutation against `targetRelPath`.
 *
 * Arguments:
 *   repoDir       — the current worktree (where the hook is running).
 *   targetRelPath — repo-relative path the hook's tool_input would mutate.
 *
 * Returns:
 *   Array of {worktree, target} objects — one per sibling worktree whose
 *   porcelain output names `targetRelPath` as uncommitted. Empty array
 *   when no match (or when enumeration failed structurally — caller
 *   treats empty as "no detected contention").
 *
 * The match predicate is EXACT (per architecture v11 §4.2: "the EXACT
 * target file uncommitted-modified on a sibling worktree"). A sibling
 * worktree with `src/lib/foo.js` modified and the candidate target
 * `src/lib/foo.js` matches; the same sibling with `src/lib/bar.js`
 * modified does NOT match (that's an ADJACENT-class signal, B1's
 * adjacency-leasecheck.js territory, not §4.2's filesystem exception).
 */
function detectSiblingMutation(repoDir, targetRelPath) {
  if (!repoDir || !targetRelPath) return [];
  if (typeof targetRelPath !== "string" || targetRelPath.length === 0) {
    return [];
  }
  const siblings = enumerateSiblingWorktrees(repoDir);
  if (siblings.length === 0) return [];
  const matches = [];
  for (const wt of siblings) {
    const r = _git(["status", "--porcelain"], { cwd: wt });
    if (!r.ok) continue; // structural-NULL on per-sibling failure
    const paths = _parsePorcelain(r.stdout);
    for (const p of paths) {
      if (p === targetRelPath) {
        matches.push({ worktree: wt, target: p });
        break; // one match per sibling is sufficient
      }
    }
  }
  return matches;
}

module.exports = {
  enumerateSiblingWorktrees,
  detectSiblingMutation,
  // Exposed for testing / debugging.
  _internal: {
    _parsePorcelain,
    _unquotePorcelain,
  },
};
