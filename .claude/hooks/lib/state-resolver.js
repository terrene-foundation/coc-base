/**
 * state-resolver — resolve trust-posture state files to the MAIN checkout, never a worktree.
 *
 * Mitigates red-team CRIT-2 (worktree state writes lost on cleanup):
 *   Worktree-isolated agents have their own cwd; if state I/O resolves against cwd,
 *   violations.jsonl writes go to the worktree's .claude/learning/ which is auto-deleted.
 *
 * Resolution order:
 *   1. CLAUDE_TRUST_STATE_DIR env var (override for tests)
 *   2. git rev-parse --show-superproject-working-tree (linked-worktree main)
 *   3. git worktree list --porcelain → first entry NOT under .claude/worktrees/
 *   4. git rev-parse --show-toplevel (single-checkout case)
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

function resolveMainCheckout(cwd) {
  if (process.env.CLAUDE_TRUST_STATE_DIR) {
    return path.dirname(path.dirname(process.env.CLAUDE_TRUST_STATE_DIR));
  }
  const startCwd = cwd || process.cwd();

  // Try superproject (git submodule-style linked worktree)
  const sup = safeExec(
    "git rev-parse --show-superproject-working-tree",
    startCwd,
  );
  if (sup) return sup;

  // Walk worktree list; pick the entry whose path is NOT under .claude/worktrees/
  const wtList = safeExec("git worktree list --porcelain", startCwd);
  if (wtList) {
    const blocks = wtList.split("\n\n");
    for (const block of blocks) {
      const m = block.match(/^worktree\s+(.+)$/m);
      if (m && !m[1].includes("/.claude/worktrees/")) {
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
