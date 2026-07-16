/**
 * state-resolver — resolve trust-posture state files to the MAIN checkout, never a worktree.
 *
 * Mitigates red-team CRIT-2 (worktree state writes lost on cleanup):
 *   Worktree-isolated agents have their own cwd; if state I/O resolves against cwd,
 *   violations.jsonl writes go to the worktree's .claude/learning/ which is auto-deleted.
 *
 * Resolution order:
 *   1. CLAUDE_TRUST_STATE_DIR env var (override for tests)
 *   2. git rev-parse --git-common-dir (DETERMINISTIC main-checkout id)
 *   3. FALLBACK (common-dir unavailable/errors): superproject → worktree-list
 *      scan (excluding BOTH .claude/worktrees/ AND durable sibling worktrees)
 *   4. git rev-parse --show-toplevel (single-checkout case)
 *
 * Why common-dir is the primary (and the exclusion heuristic is NOT):
 *   `git rev-parse --git-common-dir` returns the SHARED git dir. A linked
 *   worktree (agent-isolation under .claude/worktrees/ OR a durable sibling
 *   like ~/repos/.loom-wt/<name>) has a `.git` FILE, and its common-dir
 *   resolves to the MAIN checkout's `.git` DIR. So the main top-level is the
 *   parent of the common git dir. This is an identity, not an ordering guess.
 *   The former "first worktree-list entry NOT under .claude/worktrees/" logic
 *   mis-selected a durable sibling worktree as "main" (a sibling is also NOT
 *   under .claude/worktrees/), shadowing the true main's coordination state.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function safeExec(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// A worktree-list entry is NEVER the main checkout when it is an agent-
// isolation worktree (.claude/worktrees/) OR a durable sibling worktree
// (the gate-cascade-admin lane roots siblings under a .loom-wt/ parent).
// Used only by the heuristic FALLBACK; the common-dir primary needs none
// of this.
function isNonMainWorktreePath(p) {
  return p.includes("/.claude/worktrees/") || p.includes("/.loom-wt/");
}

function resolveMainCheckout(cwd) {
  if (process.env.CLAUDE_TRUST_STATE_DIR) {
    return path.dirname(path.dirname(process.env.CLAUDE_TRUST_STATE_DIR));
  }
  const startCwd = cwd || process.cwd();

  // PRIMARY (deterministic): the shared git-common-dir identifies the MAIN
  // checkout unambiguously. For a linked worktree it is <main>/.git; for a
  // plain checkout it is `.git` (relative) → resolves to <top>/.git. In both
  // cases the main top-level is the parent of the common dir when it ends in
  // `.git`. No ordering/exclusion heuristic is load-bearing here.
  const commonDir = safeExec("git rev-parse --git-common-dir", startCwd);
  if (commonDir) {
    const absCommon = path.isAbsolute(commonDir)
      ? commonDir
      : path.resolve(startCwd, commonDir);
    if (path.basename(absCommon) === ".git") {
      const mainTop = path.dirname(absCommon);
      // Validate: mainTop must be a real directory containing `.git`.
      try {
        if (
          fs.statSync(mainTop).isDirectory() &&
          fs.existsSync(path.join(mainTop, ".git"))
        ) {
          // Canonicalize (realpath) so the primary branch returns the same
          // symlink-resolved spelling as the fallback git toplevels (which git
          // already realpath's) — uniform return semantics across every branch,
          // so a caller that string-compares the path never sees a
          // /var vs /private/var spelling split between main + worktree sessions.
          return fs.realpathSync(mainTop);
        }
      } catch {
        // stat/realpath failed — fall through to the heuristic fallback below.
      }
    }
  }

  // FALLBACK (common-dir unavailable/errored). Superproject first (git
  // submodule-style nesting), then the worktree-list scan — now rejecting
  // BOTH agent-isolation AND durable sibling worktrees so the heuristic can
  // no longer mis-select a sibling as main.
  const sup = safeExec(
    "git rev-parse --show-superproject-working-tree",
    startCwd,
  );
  if (sup) return sup;

  const wtList = safeExec("git worktree list --porcelain", startCwd);
  if (wtList) {
    const blocks = wtList.split("\n\n");
    for (const block of blocks) {
      const m = block.match(/^worktree\s+(.+)$/m);
      if (m && !isNonMainWorktreePath(m[1])) {
        return m[1];
      }
    }
  }

  // Fallback: current toplevel (single-checkout case)
  const top = safeExec("git rev-parse --show-toplevel", startCwd);
  if (top) return top;

  // No git context — return cwd, caller may fail-closed
  return startCwd;
}

function resolveStateDir(cwd) {
  if (process.env.CLAUDE_TRUST_STATE_DIR) {
    return process.env.CLAUDE_TRUST_STATE_DIR;
  }
  const main = resolveMainCheckout(cwd);
  return path.join(main, ".claude", "learning");
}

function ensureStateDir(cwd) {
  const dir = resolveStateDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { resolveMainCheckout, resolveStateDir, ensureStateDir };
