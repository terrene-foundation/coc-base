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

// ── $CLAUDE_TRUST_STATE_DIR containment validation (#1444) ──────────────────
//
// THE DEFECT THIS CLOSES. The override used to be honored UNCONDITIONALLY as a
// pure `dirname(dirname($CLAUDE_TRUST_STATE_DIR))` — no existence check, no
// containment test, no canonicalization, and no denylist entry. Because
// integrity-guard derives `repoDir = resolveMainCheckout(sessionCwd)` and then
// asks BOTH `isWatchedPath(target, repoDir)` and `isCoordinationEnabled(repoDir)`,
// pointing the variable at an EMPTY directory made the real posture.json /
// operators.roster.json fall outside `repoDir` (→ unwatched → passthrough) AND
// made the redirected root read as un-enrolled (→ coordination OFF → passthrough).
// Protected writes flipped from BLOCKED to ALLOWED with NO files planted.
//
// WHY VALIDATION AND NOT DENIAL. The override is a LEGITIMATE, in-use seam: the
// integration suite pins it at a fixture's own `<root>/.claude/learning`
// (c2-auth-hardening-iter2, protected-path-dimensions-1409-1429-1441,
// state-file-guard-case-parity). Denying it outright would break those and
// remove a documented affordance. What made it dangerous was not that it moves
// the root — it is that it moved the root ANYWHERE. So the fix constrains it to
// the ONE shape it is documented to express: the canonical trust-state directory
// of a REAL git checkout.
//
// THE PREDICATE, mirroring coordination-mode.js::_isCanonicalEcosystemConfig
// (rules/security.md § Path Containment — BOTH candidate and boundary root go
// through the SAME resolver before comparison, and the whole thing fails CLOSED):
//   1. absolute path, canonical shape `<root>/.claude/learning`;
//   2. `<root>` exists, is a directory, and carries a `.git` entry (real checkout);
//   3. the resolved `.claude` dir still sits at `<realRoot>/.claude` — so a
//      SYMLINKED `.claude` cannot relocate the canonical location itself;
//   4. when the learning dir already exists, its realpath must equal
//      `<realClaudeDir>/learning` — so a symlink planted at the canonical path
//      whose target escapes the checkout reads as RELOCATED and is refused.
//      When it does not exist yet, the verified parent chain is sufficient
//      (mkdir will create it INSIDE the already-canonicalized `.claude`), which
//      keeps first-use on a fresh checkout working.
// Any resolution error returns null → the caller IGNORES the override and falls
// through to the deterministic git-derived resolution, i.e. the protected
// behaviour, never an attacker-supplied path.
function _validatedTrustStateRoot(raw) {
  try {
    if (typeof raw !== "string" || raw.trim() === "") return null;
    if (!path.isAbsolute(raw)) return null;
    const norm = path.normalize(raw);
    if (path.basename(norm) !== "learning") return null;
    const claudeDir = path.dirname(norm);
    if (path.basename(claudeDir) !== ".claude") return null;
    const root = path.dirname(claudeDir);

    if (!fs.statSync(root).isDirectory()) return null;
    if (!fs.existsSync(path.join(root, ".git"))) return null;

    const realRoot = fs.realpathSync(root);
    const realClaudeDir = fs.realpathSync(claudeDir);
    if (realClaudeDir !== path.join(realRoot, ".claude")) return null;

    if (fs.existsSync(norm)) {
      const realCandidate = fs.realpathSync(norm);
      if (realCandidate !== path.join(realClaudeDir, "learning")) return null;
    }
    return realRoot;
  } catch {
    return null;
  }
}

// LOUD-on-refusal (rules/security.md § Secure-Default For A New Security Feature).
// A new gate whose default is a SILENT no-op is BLOCKED: silently ignoring the
// override would leave an operator whose legitimate-but-malformed override stopped
// working with no way to see why, and would let a genuine attack pass unremarked.
// One-time per process, stderr only (never stdout — a hook's stdout is its
// structured protocol surface, so writing there would corrupt the payload).
let _warnedTrustStateDir = false;
function _warnRefusedTrustStateDir(raw, reason) {
  if (_warnedTrustStateDir) return;
  _warnedTrustStateDir = true;
  try {
    process.stderr.write(
      `[state-resolver] REFUSED $CLAUDE_TRUST_STATE_DIR=${raw} — ${reason}. ` +
        "Falling back to git-derived main-checkout resolution. The override is " +
        "honored ONLY at the canonical <root>/.claude/learning of a real git " +
        "checkout (loom#1444).\n",
    );
  } catch {
    /* stderr unavailable — never throw into a guard (zero-tolerance.md Rule 3) */
  }
}

function resolveMainCheckout(cwd) {
  const rawStateDir = process.env.CLAUDE_TRUST_STATE_DIR;
  if (rawStateDir) {
    const validRoot = _validatedTrustStateRoot(rawStateDir);
    if (validRoot) return validRoot;
    _warnRefusedTrustStateDir(
      rawStateDir,
      "not the canonical <root>/.claude/learning of a real git checkout",
    );
    // FALL THROUGH (fail closed): ignore the redirect and resolve deterministically.
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

// DELIBERATELY NOT VALIDATED — and this asymmetry with resolveMainCheckout is a
// KNOWN, NAMED residual, not an oversight. Read this before "fixing" it.
//
// The #1444 bypass runs through resolveMainCheckout: integrity-guard derives
// `repoDir` from it and then asks isWatchedPath(target, repoDir) +
// isCoordinationEnabled(repoDir). Validating THAT surface closes the proven
// bypass. resolveStateDir answers a different question — where state is WRITTEN —
// and it is the sanctioned isolation seam the existing hermetic suites are built
// on: ~10 test files (state-io-write-nofollow, posture-v2-migration,
// coord-hook-budget, genesis-anchor-guard, pending-verification-grace,
// sessionend-release-lease, state-file-guard-case-parity,
// protected-path-dimensions-…) point it at an os.tmpdir() sandbox that is NOT a
// git checkout.
//
// Applying the resolveMainCheckout predicate here REJECTS those sandboxes and
// falls back to git-derived resolution, which silently redirects their
// appendViolation writes into the REAL .claude/learning/violations.jsonl — the
// input to trust-posture.md MUST-4's cumulative downgrade math. That is strictly
// worse than the gap it closes: it corrupts the signal governing every operator's
// autonomy, and it does so SILENTLY because the suites still pass.
//
// The honest reason a predicate cannot serve both: "redirect the state root to an
// arbitrary directory" is the SAME operation whether a test or an attacker issues
// it. No property of the target distinguishes them — only a sanctioned
// test-context signal would, and that signal does not exist in this codebase yet
// (it is the same missing mechanism the COC_TEST_* seam family needs, loom#1450).
// Manufacturing a weak proxy here (e.g. "the directory exists") would be a fence
// an attacker steps over with one mkdir, which is worse than a named gap.
//
// RESIDUAL, stated plainly: an attacker who can set $CLAUDE_TRUST_STATE_DIR can
// still redirect where state is WRITTEN. The READ side already fails closed
// (state-io returns L1_PSEUDO_AGENT with _fail_closed on relocated/unreadable
// state), and the settings-channel ADD is now denylisted. Closing the write side
// requires migrating the ~10 sandboxes onto a sanctioned isolation seam and is
// tracked as the follow-on shard, NOT claimed closed here.
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
