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
 *   5. NONE OF THE ABOVE ANSWERED — the resolution is INDETERMINATE and is
 *      flagged as such (see § INDETERMINATE below). It is NOT an answer.
 *
 * § INDETERMINATE — why exhausting the chain is not a fallback (loom#1471 F7)
 *
 *   Steps 2–4 all failing means git did not identify a main checkout: the
 *   binary would not resolve, or every probe exited non-zero (not a repo;
 *   `detected dubious ownership`; a corrupt repo; a timeout). The former shape
 *   returned `startCwd` there and called it a fallback, on the reasoning that
 *   resolving "within the caller's own cwd never widens trust". That reasoning
 *   was wrong, and resolving within cwd IS the widening. Measured:
 *
 *     PROBE   (non-repo dir):  resolveMainCheckout -> <the cwd itself>
 *                              discriminateState   -> fresh-repo-L5
 *     CONTROL (real worktree): resolveMainCheckout -> /Users/esperie/repos/loom
 *                              discriminateState   -> use-cache
 *
 *   `resolveStateDir` then points the substrate at `<cwd>/.claude/learning`,
 *   which is empty, and an empty state dir reads to `posture-v2.js`'s
 *   `fresh-repo-L5` — the MOST PERMISSIVE floor on the ladder (operative
 *   posture = min(operator, repo_floor), so an L5 floor constrains nothing).
 *   A git that could not answer therefore PROMOTED the repo floor. Same
 *   endpoint as loom#1338 ("a nuked repo pinned at L1 was handed back
 *   fresh-repo-L5"), reached through the git-resolution path rather than the
 *   symlink-probe path — `rules/security.md` § Enforcement-Surface Parity: one
 *   control, two independent validators, one of them blind.
 *
 *   So the indeterminate case is now DISTINGUISHABLE from "git said cwd is the
 *   toplevel" (both previously produced `startCwd`) and is ranked TIGHTEST by
 *   its consumers, per that same rule's fail-closed direction. `path` is still
 *   populated with `startCwd` so ~20 hook call sites keep a usable string, but
 *   `indeterminate: true` travels with it and trust-state consumers refuse.
 *
 * § F8 — gitEnv() discards `safe.directory`, and that stays (loom#1471)
 *
 *   `gitEnv()` sets GIT_CONFIG_NOSYSTEM=1 + GIT_CONFIG_GLOBAL/SYSTEM=devNull.
 *   git honours `safe.directory` ONLY from system/global config (deliberately —
 *   repo-local config is attacker-controlled), so it is discarded here, and on a
 *   differently-owned checkout (container bind-mount, CI runner, shared clone)
 *   every probe fatals with `detected dubious ownership`.
 *
 *   DECISION: keep discarding it; do NOT restore global config and do NOT pass
 *   `-c safe.directory=*`. Restoring global config reopens the entire
 *   attacker-config class this module exists to close. `safe.directory=*` is
 *   narrower but still lets git read the repo-LOCAL config of a foreign-owned
 *   repo, which carries command-valued keys — trading a availability problem for
 *   an execution one. The correct mitigation is the one above: the ownership
 *   fatal is INDETERMINATE, and indeterminate now fails CLOSED to L1 instead of
 *   escalating to L5. Residual, stated plainly: on such a host the trust
 *   substrate pins to L1 with a loud reason naming the git error, and the
 *   operator clears it by owning the checkout, adding it to a repository-scoped
 *   config git will read, or setting CLAUDE_TRUST_STATE_DIR. That is an
 *   availability cost paid in the safe direction.
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
const { execFileSync } = require("child_process");
const { resolveGitBinary, gitEnv } = require(
  path.join(__dirname, "git-subprocess-env.js"),
);

// loom#1471. `resolveMainCheckout` is THE anchor for the trust-state substrate:
// `resolveStateDir` returns `<main>/.claude/learning`, which is where posture.json,
// violations.jsonl and coordination-log.jsonl live (state-io.js:818→828, :1035,
// :1280). The former shape — `execSync("git rev-parse …")` with no `env:` — handed
// the child the AMBIENT environment, and `GIT_DIR` outranks repository DISCOVERY,
// so `cwd` did NOT pin which repository answered: one ambient variable relocated the
// entire substrate to an attacker's repo. Measured, not derived (test T3).
//
// Two changes, closing two distinct vectors: git is invoked by ABSOLUTE path (no
// PATH lookup) with an arg ARRAY (no shell), and the env is built from constants by
// `gitEnv()` so nothing is inherited.
// How long a single git probe may take before it counts as no answer. A hung
// git would otherwise wedge the hook; with the bound it becomes an ordinary
// INDETERMINATE, which now fails closed.
const GIT_TIMEOUT_MS = 5000;

/** Collapse git's stderr to one short, single-line clause for the reason. */
function firstLine(buf) {
  const s = (buf == null ? "" : String(buf)).trim();
  if (!s) return "";
  return s.split("\n")[0].slice(0, 200);
}

/**
 * Run one git probe.
 *
 * Returns `{ok: true, value}` when git RAN AND EXITED ZERO — `value` may still
 * be the empty string, which is git answering with nothing and is a different
 * event from git not answering. Returns `{ok: false, reason}` when the binary
 * would not resolve, the probe exited non-zero, or it timed out.
 *
 * The distinction is the whole point: the caller can no longer confuse "git
 * identified this cwd" with "git could not answer" (§ INDETERMINATE above).
 * `reason` carries git's own first stderr line so the operator sees
 * `detected dubious ownership` rather than a generic failure.
 */
function safeExec(args, cwd) {
  const gitBin = resolveGitBinary();
  if (!gitBin) {
    return { ok: false, reason: "git binary did not resolve" };
  }
  try {
    const out = execFileSync(gitBin, args, {
      cwd,
      encoding: "utf8",
      // stderr is CAPTURED, not discarded, so the indeterminate reason can name
      // the actual git error instead of leaving the operator to guess.
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
      timeout: GIT_TIMEOUT_MS,
    });
    return { ok: true, value: String(out).trim() };
  } catch (e) {
    const detail = firstLine(e && e.stderr) || firstLine(e && e.message);
    return {
      ok: false,
      reason: `git ${args[0]} failed${detail ? `: ${detail}` : ""}`,
    };
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

/** A resolution that identified a main checkout. */
function determinate(p, source) {
  return { path: p, indeterminate: false, source, reason: null };
}

/**
 * Resolve the main checkout AND report whether git actually identified it.
 *
 * @returns {{path: string, indeterminate: boolean, source: string, reason: string|null}}
 *   `indeterminate: true` means NO probe answered — `path` is `startCwd` purely
 *   so callers keep a string, and it is NOT a claim about which repo that is.
 *   Trust-state consumers MUST refuse rather than read it (§ INDETERMINATE).
 */
function resolveMainCheckoutDetailed(cwd) {
  // The override stays behind #1444's containment predicate. The INDETERMINATE
  // contract added here changes only what a git that CANNOT answer reports; it
  // does not re-open the env seam, so the validated-or-refused shape below is
  // carried through verbatim rather than reduced back to a bare dirname().
  const rawStateDir = process.env.CLAUDE_TRUST_STATE_DIR;
  if (rawStateDir) {
    const validRoot = _validatedTrustStateRoot(rawStateDir);
    if (validRoot) return determinate(validRoot, "env-override");
    _warnRefusedTrustStateDir(
      rawStateDir,
      "not the canonical <root>/.claude/learning of a real git checkout",
    );
    // FALL THROUGH (fail closed): ignore the redirect and resolve deterministically.
  }
  const startCwd = cwd || process.cwd();
  // Every probe's failure reason, in order, so the operator sees WHY git could
  // not answer rather than a bare "indeterminate".
  const failures = [];

  // PRIMARY (deterministic): the shared git-common-dir identifies the MAIN
  // checkout unambiguously. For a linked worktree it is <main>/.git; for a
  // plain checkout it is `.git` (relative) → resolves to <top>/.git. In both
  // cases the main top-level is the parent of the common dir when it ends in
  // `.git`. No ordering/exclusion heuristic is load-bearing here.
  const common = safeExec(["rev-parse", "--git-common-dir"], startCwd);
  if (!common.ok) failures.push(common.reason);
  if (common.ok && common.value) {
    const commonDir = common.value;
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
          return determinate(fs.realpathSync(mainTop), "git-common-dir");
        }
      } catch (e) {
        // stat/realpath failed — fall through to the heuristic fallback below.
        failures.push(`common-dir validation failed: ${e.message}`);
      }
    }
  }

  // FALLBACK (common-dir unavailable/errored). Superproject first (git
  // submodule-style nesting), then the worktree-list scan — now rejecting
  // BOTH agent-isolation AND durable sibling worktrees so the heuristic can
  // no longer mis-select a sibling as main.
  const sup = safeExec(
    ["rev-parse", "--show-superproject-working-tree"],
    startCwd,
  );
  if (!sup.ok) failures.push(sup.reason);
  if (sup.ok && sup.value) return determinate(sup.value, "git-superproject");

  const wtList = safeExec(["worktree", "list", "--porcelain"], startCwd);
  if (!wtList.ok) failures.push(wtList.reason);
  if (wtList.ok && wtList.value) {
    const blocks = wtList.value.split("\n\n");
    for (const block of blocks) {
      const m = block.match(/^worktree\s+(.+)$/m);
      if (m && !isNonMainWorktreePath(m[1])) {
        return determinate(m[1], "git-worktree-list");
      }
    }
  }

  // Fallback: current toplevel (single-checkout case)
  const top = safeExec(["rev-parse", "--show-toplevel"], startCwd);
  if (!top.ok) failures.push(top.reason);
  if (top.ok && top.value) return determinate(top.value, "git-show-toplevel");

  // INDETERMINATE. Not "no git context, so cwd" — we did not identify a main
  // checkout at all, and saying `startCwd` without saying so is what escalated
  // the floor to L5 (§ INDETERMINATE). The path is returned for callers that
  // only need a string; the flag is what trust-state consumers act on.
  return {
    path: startCwd,
    indeterminate: true,
    source: "indeterminate",
    reason:
      `git could not identify a main checkout from ${startCwd}` +
      (failures.length ? ` — ${failures.join("; ")}` : ""),
  };
}

/**
 * THE accessor for any caller that makes a TRUST decision from the repo root.
 *
 * @returns {{ok: true, repoDir: string} | {ok: false, reason: string}}
 *
 * WHY THIS EXISTS AS A SEPARATE FUNCTION rather than a flag callers remember to
 * check. The idiom every guard reached for was:
 *
 *     const repoDir = resolveMainCheckout(sessionCwd) || sessionCwd;
 *
 * which READS as defensive and CANNOT fire — the legacy accessor never returns
 * a falsy value on the indeterminate path, it returns `startCwd`. In
 * `integrity-guard.js` that `repoDir` fed `isCoordinationEnabled(repoDir)`, and
 * on false the guard called `passthrough()`: an indeterminate resolution handed
 * the guard an attacker-choosable cwd with no roster and no genesis, and the
 * whole fence turned ITSELF off. Measured, with a control returning the other
 * answer — CONTROL (real worktree) enabled=true, fence runs; PROBE (git cannot
 * answer) enabled=false, passthrough().
 *
 * A boolean on a result object would have left that idiom writable. A separate
 * accessor whose failure branch has no path back to `passthrough()` does not.
 * `rules/security.md` § Enforcement-Surface Parity — ONE shared function, so the
 * surfaces cannot drift into disagreeing about what indeterminate means.
 *
 * NOTE the asymmetry this preserves: a determinate resolution of a genuinely
 * un-enrolled repo STILL yields `ok: true`, so the MO-OPT opt-in gate (a solo /
 * fresh repo pays nothing) is byte-unchanged. Only "git could not answer" is
 * refused. That distinction is the entire reason the flag is a separate
 * dimension from the coordination-enabled read.
 */
function requireMainCheckout(cwd) {
  const r = resolveMainCheckoutDetailed(cwd);
  if (r.indeterminate) return { ok: false, reason: r.reason };
  return { ok: true, repoDir: r.path };
}

/**
 * Path-only view of `resolveMainCheckoutDetailed`, unchanged in shape.
 *
 * LEGACY. It silently returns `startCwd` when git could not answer, which is
 * the fail-open shape described on `requireMainCheckout` above. It survives ONLY
 * for callers that join a path or write telemetry — never for a caller that
 * gates on the result. That boundary is not a convention: it is enforced by
 * `tests/integration/multi-operator/trust-resolver-fail-closed-1471.test.js`,
 * which holds the exact allowlist of files permitted to call this and reds on
 * any addition. Trust-bearing callers MUST use `requireMainCheckout`.
 */
function resolveMainCheckout(cwd) {
  return resolveMainCheckoutDetailed(cwd).path;
}

/**
 * Resolve the trust-state dir AND carry the resolution's determinacy forward.
 *
 * @returns {{path: string, indeterminate: boolean, source: string, reason: string|null}}
 */
function resolveStateDirDetailed(cwd) {
  // ASYMMETRY, DELIBERATE AND LOAD-BEARING — do not "fix" it without reading
  // this. `resolveMainCheckout` puts $CLAUDE_TRUST_STATE_DIR through #1444's
  // containment predicate (which requires a REAL git checkout at <root>); this
  // function honors the raw value. Routing both through the predicate was tried
  // here and reverted: it refuses every fixture whose root is a bare temp dir
  // with no `.git`, which is the documented in-use test seam #1444 explicitly
  // preserved, and it reddened 26 state-io cases plus 4 sibling suites.
  // The residual is bounded by the layer above, not by this function:
  // CLAUDE_TRUST_STATE_DIR is in the settings.json deny-set
  // (settings-deny-guard-shape.js), and a HOST env export is outside the #1309
  // trust boundary by design. Tracked as a finding rather than closed here.
  if (process.env.CLAUDE_TRUST_STATE_DIR) {
    return determinate(process.env.CLAUDE_TRUST_STATE_DIR, "env-override");
  }
  const main = resolveMainCheckoutDetailed(cwd);
  return {
    path: path.join(main.path, ".claude", "learning"),
    indeterminate: main.indeterminate,
    source: main.source,
    reason: main.reason,
  };
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
// RESIDUAL, stated plainly — and narrower than an earlier draft of this comment
// claimed. An attacker who can set $CLAUDE_TRUST_STATE_DIR redirects where state
// is WRITTEN, and the READ side is NOT closed against them either.
//
// What the read side actually rejects is a SYMLINKED ANCESTOR:
// `state-io.js::_assertStateDirContained` anchors on `dirname(dirname(dir))`,
// realpaths that, and re-joins the two known trailing components. That is
// SELF-RELATIVE — it proves the directory was not reached through a symlink. It
// does NOT tie the directory to this repository, and nothing downstream does
// either: an override is `determinate`, so it never trips the indeterminate
// refusal. A real, symlink-free `/tmp/attacker/.claude/learning` holding a
// planted posture.json therefore passes containment and IS read.
//
// So "fails closed on relocated state" means symlink-relocated ONLY. A reviewer
// reading the earlier wording would conclude reads were safe and only writes
// leaked; that was an over-claim, and this series' whole argument is that
// residuals get written down rather than argued away.
//
// The mitigations that DO hold are one layer up, not here: the settings-channel
// ADD is denylisted, and a HOST env export is outside the #1309 trust boundary
// by design. Closing this properly requires migrating the ~10 sandboxes onto a
// sanctioned isolation seam — the follow-on shard, NOT claimed closed here.
function resolveStateDir(cwd) {
  return resolveStateDirDetailed(cwd).path;
}

// One WARN per process, not per call — hooks resolve the state dir many times
// per session and a per-call warning would bury the signal it exists to raise.
let _indeterminateWarned = false;

/**
 * Create and return the state dir.
 *
 * Under an INDETERMINATE resolution this still creates the directory — callers
 * such as `detect-violations.js` are mid-append and throwing here would take
 * the hook down (`zero-tolerance.md` Rule 3) — but it is NOT silent: whatever
 * gets written lands somewhere we could not confirm is this repo's state, so
 * the operator is told once, loudly, with git's own error. The trust DECISION
 * is refused separately and unconditionally in `state-io.js::readPosture`.
 */
function ensureStateDir(cwd) {
  const res = resolveStateDirDetailed(cwd);
  if (res.indeterminate && !_indeterminateWarned) {
    _indeterminateWarned = true;
    console.error(
      `[STATE-RESOLVER] WARNING: trust-state directory is INDETERMINATE — ${res.reason}. ` +
        `Writes are going to ${res.path}, which is NOT confirmed to be this repository's ` +
        `trust state; posture reads fail closed to L1 until git can answer. Fix the git ` +
        `error above (a differently-owned checkout reports "detected dubious ownership") ` +
        `or set CLAUDE_TRUST_STATE_DIR explicitly.`,
    );
  }
  fs.mkdirSync(res.path, { recursive: true });
  return res.path;
}

module.exports = {
  resolveMainCheckout,
  resolveMainCheckoutDetailed,
  requireMainCheckout,
  resolveStateDir,
  resolveStateDirDetailed,
  ensureStateDir,
};
