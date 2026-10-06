#!/usr/bin/env node
/**
 * worktree-conservation-guard.js — the conservation gate for worktree LIFETIME.
 *
 * It answers one question at one moment: as this agent goes idle, is there
 * uncommitted work sitting in a worktree that nothing is coming back for?
 *
 * @hook-event: Stop (lifecycle) — the subject is the agent's OWN transition to
 *   idle, which exists only as this event. The measured failure composes from
 *   four individually-correct behaviours: a hook refuses a lane's last tool call
 *   (correct — fail-closed on an unresolvable signal); the lane does not retry
 *   the blocked form (correct); the lane goes idle emitting no payload; the idle
 *   notification fires (correct). Nothing in that chain is a defect, and the
 *   composition is silent work loss. Stop is where the chain terminates.
 *
 * WHY STOP AND NOT THE ALTERNATIVES — each rejected on a property, not taste.
 *
 *   SessionEnd is TOO LATE. It is where `worktree-forest-guard.js` already
 *     reaps, and that is right for teardown: nobody is watching, and removal of
 *     provably-durable trees needs no reader. Conservation is the opposite — the
 *     finding is only worth raising while an agent and an operator are still
 *     present to act on it. A report that arrives as the session closes names
 *     work nobody can recover in that session.
 *
 *   SubagentStop is the most attractive and is DELIBERATELY NOT USED. It fires
 *     exactly when a lane goes idle, which is the moment this gate is about. Two
 *     properties defeat it. Its payload carries the ORCHESTRATOR's `cwd`, not
 *     the stopped subagent's, so the event cannot attribute a tree to the lane
 *     that just stopped — it would have to survey the whole forest anyway, which
 *     Stop already does. And `instruct-and-wait.js` defines its delivery channel
 *     for `Stop`/`SessionEnd`/`PreCompact` only; a `SubagentStop` emission would
 *     fall through to the `additionalContext` shape whose delivery on that event
 *     is NOT verified here. Registering it would be booking an instrument never
 *     shown to fire (`instrument-discipline.md` MUST-3a).
 *
 *   PreToolUse is the WRONG PHASE. Uncommitted content mid-work is NORMAL; a
 *     gate there is pure noise and gets disabled, which restores the bug class.
 *
 * `worktree-forest-guard.js` rejects Stop for ITS trigger, and both of its
 * reasons are answered rather than ignored:
 *   "an instruction there nags after every turn" — that holds for a census,
 *     which is true on every turn once the forest is large. This gate is silent
 *     unless a tree is AT-RISK, and at-risk is bounded on BOTH sides (see the
 *     WIP and PARKED windows in `lib/worktree-conservation.js`). Measured on the
 *     originating 52-tree forest — 19 of them dirty — it reports nothing.
 *   "a forest census is ~28 `git status` calls; paying that per turn would be a
 *     real cost" — measured and fixed rather than accepted: a bounded worker
 *     pool surveys all 52 trees in 2,604 ms, under a wall-clock budget that
 *     degrades to UNMEASURED rather than to a wrong answer.
 *
 * SEVERITY — `halt-and-report`, and the ceiling is the TRANSPORT, not timidity.
 *
 *   The signal is STRUCTURAL: `git status --porcelain` rows and filesystem
 *   mtimes. Nothing is inferred from prose and nothing can be evaded by
 *   rewording, so by `hook-output-discipline.md` MUST-2's letter it MAY carry
 *   `block`. It does not, for a reason that is a fact about the channel rather
 *   than a judgment: `instruct-and-wait.js` documents `block` as "only
 *   meaningful at PreToolUse", and its Stop-class branch emits
 *   `{continue:true, systemMessage}` unconditionally. Claiming `block` here
 *   would book teeth the transport cannot deliver — the deferred-detector shape
 *   `rule-authoring.md` names. `halt-and-report` is the STRONGEST severity this
 *   event carries, and it is the correct one: the agent must surface the finding
 *   in its user-facing turn before going idle.
 *
 *   Hand-rolling `{decision:"block"}` to force continuation was considered and
 *   REFUSED on the false-positive cost. An at-risk tree the agent cannot clear —
 *   a parked lane belonging to another operator, a tree whose owner deliberately
 *   left it dirty — would wedge the session in a loop it has no remedy for. A
 *   gate that can wedge a session destroys more work than the loss it reports.
 *
 * FAIL-OPEN, on every unresolved condition (`cc-artifacts.md` Rule 7): git
 * missing, non-zero exit, timeout, not a repository, no worktrees, unreadable
 * state, unparseable payload. Every path emits `{continue:true}`. Because the
 * survey is ASYNC, the setTimeout fallback here genuinely bounds the work — it
 * is not the decorative timer a synchronous survey would leave behind.
 *
 * KILL SWITCH: `COC_WORKTREE_CONSERVATION=0` (also `off`/`false`/`no`/
 * `disabled`). DEFAULT ON; an unrecognised value stays ON rather than silently
 * shipping the gate inert (`security.md` § Secure-Default). Windows are tunable
 * via `COC_CONSERVATION_WIP_MINUTES`, `COC_CONSERVATION_PARKED_HOURS`,
 * `COC_CONSERVATION_BUDGET_MS`, `COC_CONSERVATION_CONCURRENCY`.
 */

const path = require("path");
const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
const {
  resolveConfig,
  surveyForest,
  evaluateConservation,
  reportLines,
  summarize,
} = require(path.join(__dirname, "lib", "worktree-conservation.js"));

// cc-artifacts.md Rule 7 — the fallback that can never hang a session. Exit 1
// (not 0) so a fired timeout is distinguishable from a normal passthrough in
// exit-code logs.
//
// UNLIKE a synchronous hook's timer, this one BOUNDS THE WORK: the survey is
// async, so the event loop is free to deliver this callback while `git status`
// children are still outstanding. It is set above the survey's own default
// budget (3,000 ms) plus enumeration, so under normal operation the budget cuts
// first and this never fires.
const TIMEOUT_MS = 8000;
// Per-run state — (re)initialised by hookMain(), because the engine requires this
// module once per worker and a stale `_emitted = true` would silence the next run.
let _emitted = false;
let _timeout = null;

function passthrough() {
  if (_emitted) return;
  _emitted = true;
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

async function run(payload) {
  // Registered on Stop alone; anything else is a mis-registration and passes
  // through rather than guessing what the caller meant.
  if ((payload.hook_event_name || "") !== "Stop") return passthrough();

  const cfg = resolveConfig(process.env);
  if (!cfg.enabled) return passthrough();

  const repoDir =
    payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const survey = await surveyForest(repoDir, cfg);
  const finding = evaluateConservation(survey);

  // NO FINDING IS THE COMMON CASE, and it is silent — no census line, no "all
  // clear". A gate that speaks on every turn is a gate that gets turned off.
  if (!finding) return passthrough();

  const n = finding.atRisk.length;
  const files = finding.atRisk.reduce((a, t) => a + (t.dirty || 0), 0);
  if (_emitted) return;
  _emitted = true;
  clearTimeout(_timeout);
  return emit({
    hookEvent: "Stop",
    severity: "halt-and-report",
    what_happened:
      `This agent is going idle while ${n} worktree${n === 1 ? "" : "s"} hold${n === 1 ? "s" : ""} ` +
      `${files} uncommitted path${files === 1 ? "" : "s"} that stopped changing some time ago. ` +
      `Unstaged and untracked files have NO reflog and exist in exactly ONE place on disk.`,
    why:
      "worktree lifetime conservation — an idle lane emitting no summary is indistinguishable from a finished one, " +
      "so uncommitted work in a quiet tree is lost silently rather than loudly",
    agent_must_report: reportLines(finding),
    // Text MUST be true on BOTH paths — refused and advisory. The prior wording
    // ended "This is a report, not a block — the turn is not being stopped",
    // which is FALSE the moment `refuseHandback` fires, and a head that says
    // "HAND-BACK REFUSED" over a body that says "the turn is not being stopped"
    // is the self-contradiction that teaches a reader to discount the head.
    // The guard CANNOT branch this text on the verdict: `refusalVerdict` WRITES
    // the budget (stop-refusal.js BOUND 4), so asking for the verdict here and
    // again inside `instructAndWait` would spend two slots for one finding.
    // THE HANDOFF, and why the PR half is named here rather than left implied.
    // Committing is only the FIRST half of conserving a quiet tree. A branch that
    // is committed but carries NO PR is invisible to `lane-completion-guard.js`,
    // whose predicate is "green AND mergeable" — a state a branch cannot reach
    // without a PR existing. So the remedy that stops at "commit it" hands the
    // branch to nobody: `lib/unlanded-work-surface.js` reports it once at
    // SessionStart with no severity, and nothing else ever asks again. That is
    // not hypothetical — it is how a branch carrying a LIVE fix reached 752
    // commits behind main with no PR (the codex-policies-delivery lane).
    // Naming the PR step here closes the handoff at the moment of capture, so
    // the branch enters the population the completion gate can actually see.
    //
    // "or record why it is HELD" is deliberate and is NOT an escape hatch: a
    // held branch is a DECLARED disposition, which is what `wip-discipline.md`
    // asks for. What it forbids is the third state — committed, un-PR'd, and
    // unexplained — which is the one this sentence removes.
    agent_must_wait:
      "Do not treat a quiet worktree as a completed one. For each tree listed, inspect it " +
      "(`git -C <path> status --porcelain`), then either commit its work on its own branch AND " +
      "open a PR for it — a committed branch with no PR is invisible to the lane-completion " +
      "gate, which is how a lane reaches weeks of age unnoticed — or record why it is HELD and " +
      "what will land it, or state what it holds and why it stopped.",
    user_summary: summarize(finding),
    // ── THE PRODUCER (artifact-stranding.md MUST-3) ──────────────────────────
    // `stop-refusal.js` shipped 2026-08-20 fully measured, fixture-covered and
    // rule-documented, with ZERO callers — the exact "shipped mechanism with no
    // producer" class that rule names. This is its first producer.
    //
    // WHY THIS FINDING MAY REFUSE THE HAND-BACK: it is AGENT-RESOLVABLE inside
    // the existing envelope. The remedy is `git status` on a named path followed
    // by a commit ON THE TREE'S OWN BRANCH, or a statement of what it holds —
    // no human decision, no gate, no destructive or hard-to-reverse act, no
    // scope expansion. A finding needing an operator DECISION (a land-or-kill
    // disposition, a posture change, an authorization) MUST NOT be wired this
    // way: refusing a hand-back the agent cannot clear spends the budget and
    // hands the turn back anyway, having burned three rounds.
    //
    // TERMINATION is structural and belongs to the library, not to this comment:
    // BOUND 1 `stop_hook_active` (the host's own re-invocation flag, read off the
    // RAW payload — a caller-derived boolean is refused by name), BOUND 2 the
    // per-session budget under `budgetKey`, BOUND 4 write-before-refuse, plus the
    // `COC_STOP_REFUSAL` kill switch. Every failure path degrades to today's
    // advisory hand-back, never to a wedge.
    refuseHandback: {
      payload,
      repoDir,
      budgetKey: "worktree-conservation",
    },
  });
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything here used to run at
// load time, in this order: arm the fallback timer, then attach the stdin reader.
//
// It RETURNS A PROMISE that settles only when the run has finished, because the
// engine reads a settled hookMain as "the detector is done": returning while the
// stdin listeners are still pending would end the run with no output. Standalone
// the promise is inert — every path leaves through process.exit first. In-engine
// process.exit throws a sentinel; the try/catch blocks below only hand it to
// `reject` (no other statement runs after an exit), which the engine reads as the
// exit it already recorded.
function hookMain() {
  _emitted = false;
  _timeout = setTimeout(() => {
    if (_emitted) return;
    _emitted = true;
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, TIMEOUT_MS);
  _timeout.unref?.();

  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.on("error", (err) => {
      try {
        passthrough(err);
      } catch (e) {
        return reject(e);
      }
      resolve();
    });
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(input || "{}");
      } catch (e) {
        process.stderr.write(
          `[worktree-conservation-guard] HOOK ERROR: ${e.message}\n`,
        );
        try {
          passthrough();
        } catch (e2) {
          return reject(e2);
        }
        return resolve();
      }
      run(payload)
        .catch((e) => {
          // Fail-open on ANY unhandled rejection from the async survey. Reported on
          // stderr so a real defect is visible, never swallowed
          // (`zero-tolerance.md` Rule 3).
          process.stderr.write(
            `[worktree-conservation-guard] HOOK ERROR: ${e && e.message}\n`,
          );
          passthrough();
        })
        .then(resolve, reject);
    });
  });
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
