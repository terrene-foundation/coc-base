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
 *     CONTROL (real worktree): resolveMainCheckout -> /Users/<operator>/repos/loom
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
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { askOnce: askGitOnce, eventGitKey } = require("./event-git.js");
const { resolveGitBinary, gitEnv } = require(
  path.join(__dirname, "git-subprocess-env.js"),
);
const { provenCheckoutRoot, gitTreeProof } = require(
  path.join(__dirname, "git-checkout-proof.js"),
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
// Per-probe CAP: the longest any ONE git probe may run, whatever budget the caller holds. A hung
// git would otherwise wedge the hook; with the bound it becomes an ordinary INDETERMINATE, which
// fails closed.
const GIT_TIMEOUT_MS = 5000;

// § BUDGET — the resolver is bounded by its CALLER, not only per probe.
//
// THE DEFECT. The cap above was the ONLY bound, and it bounded each probe rather than the call. One
// resolution runs up to FOUR probes in sequence (common-dir, superproject, worktree-list,
// show-toplevel) plus two `gitTreeProof` spawns on the override path, so a git that hangs cost
// 4 × 5000 ms + 2 × 2000 ms = 24 s — and even ONE probe's 5000 ms exceeds the 4000 ms Rule-7 timer of
// the hooks that call this (`emit-dispatch-ledger.js:47`, `reconcile-dispatch-delivery.js:38`,
// `fleet-drain-guard.js:86`, `delegation-permission-guard.js:94`, `delegation-default-guard.js:81`)
// and equals the 5 s every direct caller is registered at in `settings.json`. A synchronous spawn
// blocks the event loop, so the caller's own timer cannot interrupt it: the harness kills the hook
// instead of the resolver failing typed inside its caller's budget.
//
// THE FIX. Every call carries a DEADLINE — `opts.deadline` (epoch ms) or `opts.budgetMs` (relative),
// else `DEFAULT_BUDGET_MS`. Each probe runs under min(GIT_TIMEOUT_MS, remaining − PROBE_MARGIN_MS);
// when that leaves under MIN_PROBE_MS, NO git is spawned and the call returns INDETERMINATE with
// `code: "budget-exhausted"` — still fail-closed, now distinguishable from "git answered nothing".
//
// WHY 3500 ms FOR THE DEFAULT. It must sit under the smallest registered hook timeout among the
// direct callers (5 s, every one of them) AND under the smallest Rule-7 timer among them (4000 ms, the
// five cited above), leaving 500 ms for the caller's own node start, stdin read and post-resolution
// work. It is never SLOWER than before: the happy path is unchanged (a healthy probe answers in
// ~16 ms — measured median over 7 runs from a linked worktree), and the worst case falls from 24 s
// to ~3.5 s. The cost, stated: a git that needs over ~3.45 s to answer ONE probe used to resolve and
// now reads INDETERMINATE (fail-closed); a caller that can afford longer passes a larger budget.
const DEFAULT_BUDGET_MS = 3500;
/** Held back from each probe's timeout for the resolver's own post-probe stat/realpath work. */
const PROBE_MARGIN_MS = 50;
/** Below this no git is worth spawning — process start alone costs most of it. */
const MIN_PROBE_MS = 25;
// The fixed spawn cap the `gitTreeProof` probe passes to spawnSync —
// `git-checkout-proof.js::GIT_TIMEOUT_MS` (`git-checkout-proof.js:114`,
// `const GIT_TIMEOUT_MS = 2000;`). That callee takes no timeout parameter, so the override path
// cannot SHORTEN it — it can only decline to start a proof the remaining budget cannot cover.
// Pinned against the source by `state-resolver-indeterminate.test.mjs` T6e.
const PROOF_GIT_TIMEOUT_MS = 2000;
/** The typed prefix every budget-exhausted reason starts with. */
const BUDGET_EXHAUSTED_REASON = "main checkout unresolved: budget exhausted";

/** Resolve a caller's opts to an absolute deadline (epoch ms). */
function _deadlineOf(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  if (Number.isFinite(o.deadline)) return o.deadline;
  const budget = Number.isFinite(o.budgetMs) ? o.budgetMs : DEFAULT_BUDGET_MS;
  return Date.now() + budget;
}

/** Milliseconds a spawn may use before `deadline`, net of the margin (may be ≤ 0). */
function _spawnWindow(deadline) {
  return deadline - Date.now() - PROBE_MARGIN_MS;
}

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
 *
 * BOUNDED BY `deadline` (§ BUDGET): the probe runs under
 * min(GIT_TIMEOUT_MS, deadline − now − PROBE_MARGIN_MS), and when that window is under
 * MIN_PROBE_MS no git is spawned at all. `exhausted: true` marks a failure that the BUDGET
 * caused — a skipped probe, or a timeout at a budget-shortened cap — so the caller can stop the
 * chain and say so instead of reporting a generic indeterminate.
 */
function safeExec(args, cwd, deadline) {
  const window = _spawnWindow(deadline);
  if (!(window >= MIN_PROBE_MS)) {
    return {
      ok: false,
      exhausted: true,
      reason: `git ${args[0]} not run: ${Math.max(0, Math.floor(window))} ms of budget left`,
    };
  }
  const gitBin = resolveGitBinary();
  if (!gitBin) {
    return { ok: false, exhausted: false, reason: "git binary did not resolve" };
  }
  const timeout = Math.min(GIT_TIMEOUT_MS, Math.floor(window));
  // ONE answer per distinct question per hook event (lib/event-git.js): every
  // detector of an event resolving the main checkout asks git the same thing, and
  // git's failure recorded here stays a failure for all of them. NOT recorded:
  // the budget-exhausted "not run" branch above (git was never asked), and a
  // timeout the asker's budget caused (`exhausted: true` — the cap was shortened
  // below GIT_TIMEOUT_MS); a later asker with its own budget asks git itself.
  return askGitOnce(eventGitKey({ gitBin, cwd, args, envelope: "gitEnv" }), () => _spawnProbe(gitBin, args, cwd, timeout), {
    record: (v) => !(v && v.exhausted),
  });
}

function _spawnProbe(gitBin, args, cwd, timeout) {
  try {
    const out = execFileSync(gitBin, args, {
      cwd,
      encoding: "utf8",
      // stderr is CAPTURED, not discarded, so the indeterminate reason can name
      // the actual git error instead of leaving the operator to guess.
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
      timeout,
      // A read-only probe holds no lock (`GIT_OPTIONAL_LOCKS=0` in `gitEnv()`), so there is
      // nothing for a graceful signal to clean up — and SIGTERM can be ignored, which would
      // let the spawn outlive the bound this timeout exists to enforce.
      killSignal: "SIGKILL",
    });
    return { ok: true, value: String(out).trim() };
  } catch (e) {
    if (e && e.code === "ETIMEDOUT") {
      return {
        ok: false,
        // Budget-caused only when the budget SHORTENED the cap; a full-cap timeout is git's.
        exhausted: timeout < GIT_TIMEOUT_MS,
        reason: `git ${args[0]} timed out after ${timeout} ms`,
      };
    }
    const detail = firstLine(e && e.stderr) || firstLine(e && e.message);
    return {
      ok: false,
      exhausted: false,
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
//   2. `<root>` exists, is a directory, and git PROVES it is a checkout ROOT
//      (`provenCheckoutRoot`, loom#1474 E3 — see below). That proof is TWO
//      requirements, and naming only the first is what let loom#1586 through:
//      (2a) IDENTITY — git's `--show-toplevel` must BE `<root>`, not an
//           ancestor, which refuses a nested `<repo>/sub/.claude/learning`; and
//      (2b) COHERENCE — `<root>/.git` must NAME the repository git reported.
//           Load-bearing, not belt-and-braces: `core.worktree` is repo-LOCAL
//           config in an ANCESTOR's `.git/config` that `gitEnv()` cannot strip
//           (it removes SYSTEM/GLOBAL config and the whole `GIT_*` family, but
//           repo-local config is read BY DEFINITION once git discovers the
//           repo), and it makes git report a directory holding NO `.git` entry
//           at all as the toplevel. (2a) alone ACCEPTS that directory — i.e.
//           WEAKER on this axis than the `fs.existsSync(<root>/.git)` line it
//           replaced. Only (2b) refuses it;
//   3. the resolved `.claude` dir still sits at `<realRoot>/.claude` — so a
//      SYMLINKED `.claude` cannot relocate the canonical location itself;
//   4. when the learning dir already exists, its realpath must equal
//      `<realClaudeDir>/learning` — so a symlink planted at the canonical path
//      whose target escapes the checkout reads as RELOCATED and is refused.
//      When it does not exist yet, the verified parent chain is sufficient
//      (mkdir will create it INSIDE the already-canonicalized `.claude`), which
//      keeps first-use on a fresh checkout working.
//   5. loom#1891 — REPO IDENTITY: `<root>` must be the SAME REPOSITORY as the
//      override-FREE seed (the session cwd). See § THE RELATIONAL STEP below.
// Any resolution error returns a refusal → the caller IGNORES the override and
// falls through to the deterministic git-derived resolution, i.e. the protected
// behaviour, never an attacker-supplied path.
//
// § THE RELATIONAL STEP (loom#1891) — why requirements 1–4 were not enough
//
//   Requirements 1–4 are all predicates on the TARGET, and `git-checkout-proof.js`
//   drew the correct conclusion about them while drawing the WRONG conclusion
//   about the seam:
//
//     "An actor who can set $CLAUDE_TRUST_STATE_DIR can also run `git init`, so
//      no predicate on the TARGET can refuse them; the probe encodes that
//      deliberately as its C4 lever-is-live control ... The override staying live
//      for a real checkout is the documented contract, not a residual."
//
//   The first clause is TRUE and remains true. The inference from it is not: a
//   predicate on the target ALONE cannot refuse a `git init` decoy, but a
//   RELATIONAL predicate — target versus the override-free seed — can, and costs
//   the attacker something they do not have (write access to the victim's own
//   repository identity). That is loom#1875's predicate, which closed the
//   structurally identical `COC_OPERATOR_REPO_DIR` bypass, applied to the
//   variable #1875's own header explicitly left open.
//
//   WHY THE SEAM SURVIVED THREE HARDENINGS. Every prior measurement pointed the
//   override at a STUB (bare tmpdir, `touch .git`, `mkdir .git`, dangling
//   symlink), and every stub is correctly refused by requirement 2. So
//   `integrity-guard.js` recorded "CLAUDE_TRUST_STATE_DIR was tested as a second
//   lever and REFUTED — pointed at a BARE decoy it returns exit 2", and the probe
//   printed BYPASS CLOSED. A bare decoy CANNOT emit the falsifying result; it
//   fails requirement 2 by construction. `git init` satisfies it. Measured
//   two-pole on the pre-fix tree, one env var apart, COC_OPERATOR_REPO_DIR never
//   set (`.claude/test-harness/probes/x-envseam-1891-populated-decoy.cjs`):
//
//     clean                            exit 2  BLOCKED
//     env -> git-init decoy + roster   exit 0  {"continue":true}
//
//   THE DEFEATED CHECK IS THE ANTI-WIDENING ONE. `integrity-guard.js`'s
//   `corroborateOverride` re-runs its predicates against the override-FREE root
//   precisely to catch a jurisdiction that widens the passthrough set — but it
//   obtains that baseline from `requireMainCheckout(payload.cwd)`, which routes
//   through THIS function and so is steered by the SAME variable. The check
//   designed to catch a widening override was defeated by the thing it exists to
//   catch. Binding here fixes it for that guard and every sibling at once, which
//   is why the fix is at the shared resolver and not in N patches.
//
//   WHAT IT COSTS — MEASURED, NOT ASSUMED. Nothing that worked before stops
//   working, because the added condition sits BELOW requirement 2 on a path that
//   already returns null whenever git cannot answer:
//     - operator recovery in their OWN repo (the use `integrity-guard`'s block
//       message documents) — same common-dir as the session cwd → HONOURED;
//     - the whole legitimate worktree forest — a linked worktree's common dir IS
//       the main checkout's `.git` → HONOURED;
//     - the in-use integration fixtures, which point the override at a fixture's
//       own `<root>/.claude/learning` while driving from that same fixture →
//       HONOURED;
//     - the dubious-ownership recovery host named in § F8 above — git fatals for
//       the target, so requirement 2 ALREADY refused the override there before
//       this change. That recovery path runs through `resolveStateDir` (which
//       honours the raw value and is deliberately NOT changed here), not through
//       this predicate. This step therefore takes nothing from it.
//   What no longer works is naming a DIFFERENT repository's trust-state dir while
//   the session runs in this one. That is the attack shape, and it is also a real
//   cost to any future test written in that style: such a test must drive with
//   `cwd` set to the fixture, exactly as loom#1875 requires.
//
//   FAIL-CLOSED DIRECTION: when git cannot establish identity for EITHER side the
//   override is IGNORED and resolution falls back to the seed. Ignoring is the
//   fail-closed direction here because the seed is the real session repository —
//   the fence then RUNS on it. Same disposition, and same reasoning, as
//   `lib/repo-dir-override.js`.
//
// BUDGET (§ BUDGET). Each of the two `gitTreeProof` spawns below runs under its OWN fixed 2000 ms
// cap, which this function cannot shorten, so a proof is started only when the caller's remaining
// window covers that whole cap; otherwise `out.budget` is set and the override is IGNORED — the
// same fail-closed disposition as any other doubt, reported with its real reason.
function _validatedTrustStateRoot(raw, seedCwd, deadline, out) {
  const cannotAffordProof = () => {
    if (_spawnWindow(deadline) >= PROOF_GIT_TIMEOUT_MS) return false;
    if (out) out.budget = true;
    return true;
  };
  try {
    if (typeof raw !== "string" || raw.trim() === "") return null;
    if (!path.isAbsolute(raw)) return null;
    const norm = path.normalize(raw);
    if (path.basename(norm) !== "learning") return null;
    const claudeDir = path.dirname(norm);
    if (path.basename(claudeDir) !== ".claude") return null;
    const root = path.dirname(claudeDir);

    if (!fs.statSync(root).isDirectory()) return null;

    if (cannotAffordProof()) return null;

    // loom#1474 E3 — POSITIVE PROOF, not the existence of a `.git` entry.
    // The former line here was `fs.existsSync(path.join(root, ".git"))`, which
    // `mkdir .git` and `touch .git` both satisfy. Measured through the real
    // integrity-guard, the empty-DIR shape flipped a protected write to
    // `posture.json` from BLOCKED to ALLOWED (exit 2 -> exit 0); the empty-FILE
    // shape blocked only because a DOWNSTREAM resolution happened to fail safe,
    // never because this predicate refused it. `provenCheckoutRoot` asks git
    // instead, and additionally requires git's toplevel to BE this root — so a
    // nested `<repo>/sub/.claude/learning`, which git's upward discovery would
    // otherwise answer for, is refused too. Fails closed on every doubt.
    const proof = provenCheckoutRoot(root);
    if (!proof) return null;

    // loom#1891 — REPO IDENTITY, the relational step (§ THE RELATIONAL STEP).
    // `provenCheckoutRoot` already returned this tree's `--git-common-dir`, so
    // the binding costs ONE additional git probe (the seed's), not two.
    // BOTH sides come from the SAME resolver — `gitTreeProof`, whose `common` is
    // realpath'd — so this is a canonical-form comparison, never a lexical one
    // (`rules/security.md` § Path Containment).
    if (cannotAffordProof()) return null;
    const seedTree = gitTreeProof(
      typeof seedCwd === "string" && seedCwd !== "" ? seedCwd : process.cwd(),
    );
    if (!seedTree || !seedTree.common) return null;
    if (seedTree.common !== proof.common) return null;

    const realRoot = proof.realRoot;
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
 * The INDETERMINATE result for a resolution the caller's BUDGET cut short (§ BUDGET). Still
 * indeterminate — every consumer's fail-closed handling applies unchanged — but the reason starts
 * with `BUDGET_EXHAUSTED_REASON` and `budgetExhausted` is set, so "git ran out of time" is never
 * reported as "git answered nothing".
 */
function budgetExhausted(startCwd, failures) {
  return {
    path: startCwd,
    indeterminate: true,
    source: "indeterminate",
    budgetExhausted: true,
    reason:
      `${BUDGET_EXHAUSTED_REASON} — git did not identify a main checkout from ${startCwd} ` +
      `within the caller's budget` +
      (failures.length ? ` — ${failures.join("; ")}` : ""),
  };
}

/**
 * Resolve the main checkout AND report whether git actually identified it.
 *
 * @param {string} [cwd]
 * @param {{deadline?: number, budgetMs?: number}} [opts] — the caller's time budget (§ BUDGET):
 *   an absolute epoch-ms `deadline`, else a relative `budgetMs`, else `DEFAULT_BUDGET_MS`.
 * @returns {{path: string, indeterminate: boolean, source: string, reason: string|null,
 *            budgetExhausted?: boolean}}
 *   `indeterminate: true` means NO probe answered — `path` is `startCwd` purely
 *   so callers keep a string, and it is NOT a claim about which repo that is.
 *   Trust-state consumers MUST refuse rather than read it (§ INDETERMINATE).
 */
function resolveMainCheckoutDetailed(cwd, opts) {
  const deadline = _deadlineOf(opts);
  // The override stays behind #1444's containment predicate. The INDETERMINATE
  // contract added here changes only what a git that CANNOT answer reports; it
  // does not re-open the env seam, so the validated-or-refused shape below is
  // carried through verbatim rather than reduced back to a bare dirname().
  const startCwd = cwd || process.cwd();
  const rawStateDir = process.env.CLAUDE_TRUST_STATE_DIR;
  if (rawStateDir) {
    // The seed is the override-FREE session cwd — the one value in this decision
    // that the settings.json `env:` channel cannot author (loom#1875: an attacker
    // able to add one env var is equally able to add another, so corroborating an
    // env var against another env var is no corroboration at all).
    const refusal = { budget: false };
    const validRoot = _validatedTrustStateRoot(rawStateDir, startCwd, deadline, refusal);
    if (validRoot) return determinate(validRoot, "env-override");
    _warnRefusedTrustStateDir(
      rawStateDir,
      refusal.budget
        ? `its git proof needs up to ${PROOF_GIT_TIMEOUT_MS} ms and the caller's remaining ` +
            "budget could not cover it"
        : "not the canonical <root>/.claude/learning of a real git checkout that is " +
            "the SAME repository as the session cwd",
    );
    // FALL THROUGH (fail closed): ignore the redirect and resolve deterministically.
  }
  // Every probe's failure reason, in order, so the operator sees WHY git could
  // not answer rather than a bare "indeterminate".
  const failures = [];

  // PRIMARY (deterministic): the shared git-common-dir identifies the MAIN
  // checkout unambiguously. For a linked worktree it is <main>/.git; for a
  // plain checkout it is `.git` (relative) → resolves to <top>/.git. In both
  // cases the main top-level is the parent of the common dir when it ends in
  // `.git`. No ordering/exclusion heuristic is load-bearing here.
  const common = safeExec(["rev-parse", "--git-common-dir"], startCwd, deadline);
  if (!common.ok) failures.push(common.reason);
  if (common.exhausted) return budgetExhausted(startCwd, failures);
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
    deadline,
  );
  if (!sup.ok) failures.push(sup.reason);
  if (sup.exhausted) return budgetExhausted(startCwd, failures);
  if (sup.ok && sup.value) return determinate(sup.value, "git-superproject");

  const wtList = safeExec(["worktree", "list", "--porcelain"], startCwd, deadline);
  if (!wtList.ok) failures.push(wtList.reason);
  if (wtList.exhausted) return budgetExhausted(startCwd, failures);
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
  const top = safeExec(["rev-parse", "--show-toplevel"], startCwd, deadline);
  if (!top.ok) failures.push(top.reason);
  if (top.exhausted) return budgetExhausted(startCwd, failures);
  if (top.ok && top.value) return determinate(top.value, "git-show-toplevel");

  // INDETERMINATE. Not "no git context, so cwd" — we did not identify a main
  // checkout at all, and saying `startCwd` without saying so is what escalated
  // the floor to L5 (§ INDETERMINATE). The path is returned for callers that
  // only need a string; the flag is what trust-state consumers act on.
  return {
    path: startCwd,
    indeterminate: true,
    source: "indeterminate",
    budgetExhausted: false,
    reason:
      `git could not identify a main checkout from ${startCwd}` +
      (failures.length ? ` — ${failures.join("; ")}` : ""),
  };
}

/**
 * THE accessor for any caller that makes a TRUST decision from the repo root.
 *
 * @param {string} [cwd]
 * @param {{deadline?: number, budgetMs?: number}} [opts] — the caller's time budget. A hook
 *   SHOULD pass the deadline its own Rule-7 timer implies; passing nothing applies
 *   `DEFAULT_BUDGET_MS` (§ BUDGET).
 * @returns {{ok: true, repoDir: string} |
 *           {ok: false, reason: string, code: "budget-exhausted"|"indeterminate"}}
 *   `code: "budget-exhausted"` — the budget ran out before git answered; `reason` starts with
 *   `BUDGET_EXHAUSTED_REASON`. Both codes are the SAME fail-closed refusal.
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
function requireMainCheckout(cwd, opts) {
  const r = resolveMainCheckoutDetailed(cwd, opts);
  if (r.indeterminate) {
    return {
      ok: false,
      reason: r.reason,
      code: r.budgetExhausted ? "budget-exhausted" : "indeterminate",
    };
  }
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
function resolveMainCheckout(cwd, opts) {
  return resolveMainCheckoutDetailed(cwd, opts).path;
}

/**
 * Resolve the trust-state dir AND carry the resolution's determinacy forward.
 *
 * @returns {{path: string, indeterminate: boolean, source: string, reason: string|null}}
 */
function resolveStateDirDetailed(cwd, opts) {
  // ASYMMETRY, DELIBERATE AND LOAD-BEARING — do not "fix" it without reading
  // this. `resolveMainCheckout` puts $CLAUDE_TRUST_STATE_DIR through #1444's
  // containment predicate (which requires a REAL git checkout at <root>); this
  // function honors the raw value.
  //
  // THAT GUARANTEE HAS ALREADY LAPSED ONCE, SILENTLY, AND THIS COMMENT DID NOT
  // NOTICE. Between `ceda639e` and `9611a19f` the predicate was rewritten and
  // the phrase "requires a REAL git checkout at <root>" became FALSE: a
  // `core.worktree` redirect target — a directory with no `.git` entry at all —
  // satisfied it (loom#1586). Restored by the COHERENCE requirement, so the
  // sentence above is accurate again. It is recorded here because the sentence
  // read as true throughout the window in which it was false, and because it is
  // the ONLY thing bounding this function: everything below leans on a promise
  // made by a predicate in ANOTHER file, with no test binding the two. A change
  // to `provenCheckoutRoot` can silently invalidate this paragraph again.
  //
  // Routing both through the predicate was tried
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
  const main = resolveMainCheckoutDetailed(cwd, opts);
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
//
// SEPARATELY, loom#1502 closes the adjacent ACCIDENTAL leak — nobody sets the
// variable at all and the fail-OPEN default sends a TEST's rows into the real
// ledger. See § "The trust-state WRITE fence" on `ensureStateDir` below. That
// fence keys on test-context detection, so it is deliberately NO defence
// against a deliberate attacker, who simply does not set the marker. Two
// separate problems; only one of them is fixed.
function resolveStateDir(cwd, opts) {
  return resolveStateDirDetailed(cwd, opts).path;
}

// ── The trust-state WRITE fence (loom#1502) ────────────────────────────────
//
// THE DEFECT THIS CLOSES. `resolveStateDir` fails OPEN: with no
// $CLAUDE_TRUST_STATE_DIR set it returns `<mainCheckout>/.claude/learning`, and
// `resolveMainCheckout` deliberately maps EVERY worktree back to the main
// checkout. So a fixture, probe, or test that drives a state-writing helper
// from anywhere in the repo tree — including a throwaway agent worktree — lands
// its rows in the REAL `.claude/learning/violations.jsonl`, the input to
// `rules/trust-posture.md` MUST-4's cumulative downgrade math. A synthetic row
// there downgrades a real operator for a violation that never happened, and it
// does so SILENTLY: every suite still passes while doing it.
//
// WHY THE PRIOR COUNTERMEASURE WAS NOT ONE. The standing guidance was "point
// $CLAUDE_TRUST_STATE_DIR at a scratch checkout before any hook-dispatch test".
// That is a CONVENTION every future author must remember, and it was forgotten
// in at least three separate clusters between 2026-07-24 and 2026-08-01. A
// convention whose failure mode is silent is not a countermeasure.
//
// WHY NOT AN ENV/SESSION "AM I PRODUCTION" TOKEN. Measured, not assumed: a
// subprocess spawned from inside a Claude Code session INHERITS the whole
// CLAUDE_* env (CLAUDE_CODE_SESSION_ID, CLAUDECODE, …). A test driving a hook
// therefore presents byte-identical credentials to a genuine dispatch, so no
// env-presence check can discriminate them. Requiring a positive production
// token instead (e.g. minted in settings.json) was rejected for a worse reason:
// any consumer running hooks WITHOUT the token would silently stop recording
// genuine violations — disabling enforcement, which is far worse than the
// contamination this closes.
//
// THE SHAPE THAT WORKS. Detect the TEST context positively, and on detection
// REDIRECT the write sink to a per-process quarantine — never DROP the row.
// Enforcement is therefore structurally impossible to disable by this fence:
// every violation is still recorded, and every redirect is announced LOUDLY on
// stderr (`rules/security.md` § Secure-Default For A New Security Feature; a
// silent no-op default is BLOCKED, and `rules/zero-tolerance.md` Rule 3 forbids
// the silent fallback this replaces). A false POSITIVE costs one loud, named,
// recoverable redirect; a false NEGATIVE is the silent corruption we are here
// to end. That asymmetry is why the detector may be conservative but the
// disposition may not be.
//
// SCOPE, deliberately narrow: the fence lives on `ensureStateDir` — the
// WRITE-side resolver, whose only callers are `appendViolation` (violations.jsonl),
// `writePosture` (posture.json), and `detect-violations.js`'s stamped-append
// path. READS (`readPosture`, `readRecentViolations`, `resolveLogPath`) still
// resolve through `resolveStateDir` unchanged, so a read-only probe of the real
// log — `.claude/test-harness/tests/real-state-log-untouched.test.mjs` does
// exactly this — keeps working. The lease/coordination writers that route
// through `resolveStateDir` are untouched: they are not MUST-4 inputs, and
// widening the blast radius to them buys nothing here.
const TEST_CONTEXT_ENV = "COC_TRUST_STATE_CONTEXT";

// Path segments and entry-script names that identify a test/fixture/probe
// process. POSIX-normalised so the same literals match on Windows.
const _TEST_PATH_SEGMENTS = [
  "/.claude/test-harness/",
  "/.claude/audit-fixtures/",
  "/tests/",
  // The Codex MCP-guard companion's own suites (test-server.mjs,
  // test-extract-policies.mjs) are named `test-*`, not `*.test.*`, so they match
  // no _TEST_ENTRY_BASENAME shape and carried no runner variable. Segment-fencing
  // the directory makes them self-fencing even when a caller forgets the env pin.
  "/.claude/codex-mcp-guard/",
];
// `^test\.[cm]?js$` covers the audit-fixture runners, which are named bare
// `test.mjs` (e.g. .claude/audit-fixtures/violation-patterns/*/test.mjs) and so
// match no `.test.` infix.
const _TEST_ENTRY_BASENAME =
  /(?:\.test\.[cm]?js$|\.probes?\.[cm]?js$|\.fixture\.[cm]?js$|^test\.[cm]?js$|^run-audit-fixtures\.mjs$)/;

function _entryScriptPosix() {
  try {
    const a = process.argv && process.argv[1];
    if (typeof a !== "string" || a === "") return "";
    return path.resolve(a).split(path.sep).join("/");
  } catch {
    return "";
  }
}

/**
 * Is this process a test / fixture / probe run?
 *
 * `$COC_TRUST_STATE_CONTEXT` is the explicit override in BOTH directions:
 * `test` forces the fence on, `production` forces it off (the escape hatch for
 * a harness that genuinely must exercise the real sink). Everything else is
 * inferred from signals a test process cannot avoid carrying.
 *
 * @returns {{isTest: boolean, reason: string|null}}
 */
function detectTestContext() {
  const explicit = process.env[TEST_CONTEXT_ENV];
  if (explicit === "test") {
    return { isTest: true, reason: `${TEST_CONTEXT_ENV}=test` };
  }
  if (explicit === "production") return { isTest: false, reason: null };

  // Runner-set variables. `NODE_TEST_CONTEXT` is exported by `node --test` into
  // every test child; the others cover the third-party runners.
  for (const [v, label] of [
    ["NODE_TEST_CONTEXT", "node --test"],
    ["VITEST", "vitest"],
    ["JEST_WORKER_ID", "jest"],
  ]) {
    if (process.env[v]) return { isTest: true, reason: `$${v} (${label})` };
  }

  // Entry-script shape. This is the signal that catches the FORGOTTEN case —
  // an agent running a suite or fixture directly, having set nothing at all.
  const entry = _entryScriptPosix();
  if (entry) {
    const base = entry.slice(entry.lastIndexOf("/") + 1);
    if (_TEST_ENTRY_BASENAME.test(base)) {
      return { isTest: true, reason: `entry script ${base}` };
    }
    for (const seg of _TEST_PATH_SEGMENTS) {
      if (entry.includes(seg)) {
        return { isTest: true, reason: `entry script under ${seg}` };
      }
    }
  }

  return { isTest: false, reason: null };
}

// Quarantine sink: per-process, under the OS temp dir, in the same canonical
// `<root>/.claude/learning` shape the real sink uses so every downstream
// containment check (`_assertStateDirContained`) behaves identically.
function _quarantineStateDir() {
  return path.join(
    os.tmpdir(),
    `coc-trust-quarantine-${process.pid}`,
    ".claude",
    "learning",
  );
}

let _warnedQuarantine = false;
function _warnQuarantined(reason, dir) {
  if (_warnedQuarantine) return;
  _warnedQuarantine = true;
  try {
    process.stderr.write(
      `[state-resolver] TEST CONTEXT DETECTED (${reason}) and no ` +
        `$CLAUDE_TRUST_STATE_DIR is set. Trust-state WRITES are quarantined to ` +
        `${dir} — the real .claude/learning/ is NOT being written. Rows are still ` +
        `recorded (enforcement is not disabled), they are simply not counted by ` +
        `trust-posture.md MUST-4. To write a sink you control, set ` +
        `$CLAUDE_TRUST_STATE_DIR=<root>/.claude/learning; to exercise the real ` +
        `sink deliberately, set $${TEST_CONTEXT_ENV}=production (loom#1502).\n`,
    );
  } catch {
    /* stderr unavailable — never throw into a guard (zero-tolerance.md Rule 3) */
  }
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
function ensureStateDir(cwd, opts) {
  // loom#1502 — the trust-state WRITE fence. An explicit $CLAUDE_TRUST_STATE_DIR
  // is the sanctioned isolation seam and still wins outright: the ~10 hermetic
  // suites built on it are unaffected, and an operator who pinned it meant it.
  // Otherwise a detected TEST context REDIRECTS the write sink to a per-process
  // quarantine — rows are still recorded, so enforcement is never disabled.
  if (!process.env.CLAUDE_TRUST_STATE_DIR) {
    const ctx = detectTestContext();
    if (ctx.isTest) {
      const qdir = _quarantineStateDir();
      _warnQuarantined(ctx.reason, qdir);
      // Propagate to descendants: a fixture runner that spawns a hook as a child
      // gives that child NO argv/runner signal of its own, so without this the
      // child would resolve straight back to production.
      process.env[TEST_CONTEXT_ENV] = "test";
      fs.mkdirSync(qdir, { recursive: true });
      return qdir;
    }
  }
  const res = resolveStateDirDetailed(cwd, opts);
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
  detectTestContext,
  TEST_CONTEXT_ENV,
  // § BUDGET
  DEFAULT_BUDGET_MS,
  GIT_TIMEOUT_MS,
  PROOF_GIT_TIMEOUT_MS,
  BUDGET_EXHAUSTED_REASON,
};
