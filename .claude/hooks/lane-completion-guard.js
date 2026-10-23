#!/usr/bin/env node
/**
 * lane-completion-guard.js — refuse the hand-back while a lane of mine is
 * ALREADY GREEN AND MERGEABLE, or is CONFLICTING and therefore unmergeable.
 *
 * @hook-event: Stop (lifecycle) — the subject is the agent's OWN transition to
 *   idle. The defect is not "work exists"; it is going idle WHILE holding a lane
 *   that has already passed every required check and needs one command to land.
 *   That state exists only at this boundary, and only here is an operator still
 *   present for the alternative (a report) to have been the wrong choice.
 *
 * THE FAILURE THIS CLOSES, measured 2026-08-27. An operator asked why the queue
 * was not draining. Two PRs had gone green DURING the session and were never
 * landed, because the agent treated "CI pending" as terminal, wrote a status
 * report, and stopped. Both merged on the first attempt once looked at. Nothing
 * in the corpus fired: `wip-discipline.md` bounds how many lanes may be OPEN and
 * says nothing about a lane that is FINISHED, and every Stop-class guard emitted
 * `{continue:true, systemMessage}` — surfaced, then idle.
 *
 * THE SECOND FAILURE THIS CLOSES, measured 2026-08-28 (loom#1990). The header
 * above described a gate that fires ONLY on a lane "already green and
 * mergeable", and said in as many words that it "deliberately says nothing
 * about pending checks, failing checks and every non-mergeable state". Driven
 * live against this repo it returned `{"continue":true}` against 6 open lanes —
 * because ZERO were in that state, while TWO of them (#1953, #1895, both this
 * operator's) were `mergeable: "CONFLICTING"` and could not merge at all. The
 * only drain refusal in the corpus covered a state the backlog is never in.
 * The CONFLICTING arm is the fix; `lib/lane-completion.js`'s header carries the
 * ordering argument (the conflict test runs BEFORE the checks verdict).
 *
 * WHY IT MAY REFUSE, against the producer test `worktree-conservation-guard.js`
 * states — argued for BOTH arms.
 *   STRUCTURAL — a check conclusion, a mergeability verdict and GitHub's own
 *     `mergeable`/`mergeStateStatus` fields, all read off the forge, never an
 *     inference over prose and not evadable by rewording.
 *   AGENT-CLEARABLE — one `gh pr merge` for a landable lane; for a conflicting
 *     one, merge the base in and resolve the conflicted paths. Both are inside
 *     the envelope and neither needs a human decision.
 *   LOW-FALSE-POSITIVE — the predicate excludes drafts, other authors, held
 *     lanes, pending checks, failing checks and BEHIND-but-clean lanes. The
 *     conflicting arm additionally requires a RESOLVED operator identity: a
 *     sibling's conflict is not this agent's to resolve, so an unattributable
 *     lane is silent.
 * A finding failing any of those three MUST stay advisory. RED CI is exactly
 * such a finding and is deliberately NOT adopted — see the lib header's
 * measurement of four red lanes with three different dispositions.
 *
 * WHY NOT THE ADJACENT CANDIDATES, so the next author does not re-litigate:
 *   `delegation-default-guard` — its independence judgment false-positives on
 *     legitimately serial work (recorded in `orchestrator-context-economy.md`),
 *     and on a false positive the agent CANNOT clear the finding, so a refusal
 *     burns the budget and hands back anyway.
 *   `log-triage-gate` — its remedy is an unbounded tail; fifty WARN+ entries do
 *     not clear inside a three-refusal budget.
 *   `fleet-drain-guard` — permanently barred; its header names "the severity
 *     cannot block" as one of three bounds on a known false-positive class.
 *
 * TERMINATION is the library's, not this file's: BOUND 1 `stop_hook_active`
 * (read off the RAW payload — a caller-derived boolean is refused by name),
 * BOUND 2 the per-session budget under `budgetKey`, BOUND 4 write-before-refuse,
 * plus `COC_STOP_REFUSAL`. Every failure path degrades to today's advisory
 * hand-back, never to a wedge.
 *
 * SILENT on every FORGE question it cannot answer: `gh` missing,
 * unauthenticated, non-zero exit, timeout, unparseable JSON, no repo. Each is a
 * NOT-MEASURED forge read, which the run answers with `{continue:true}` and says
 * nothing — an unanswerable question is reported as silence here, never as "no
 * landable lanes", because those are opposite meanings
 * (`instrument-discipline.md` MUST-1). A run that does not answer at all — an
 * unreadable payload, a throw, a run past its budget — is no verdict: this row
 * is `on_incomplete: "deny"`, so it FAILS CLOSED through
 * `lib/guard-runner.js::runGuard` (`cc-artifacts.md` Rule 7), and the guard
 * carries no timer and no catch-passthrough of its own.
 *
 * KILL SWITCH: `COC_LANE_COMPLETION=0` (also off/false/no/disabled). DEFAULT ON;
 * an unrecognised value stays ON rather than shipping the gate inert
 * (`security.md` § Secure-Default). Operator holds: `COC_LANE_COMPLETION_HELD`,
 * a comma/space list of PR numbers this gate must never report.
 */

"use strict";

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [".claude/learning/stop-refusal/<session-id>.jsonl"],
 *     "network": false,
 *     "spawns": ["gh","git"]
 *   },
 *   "idempotent": false,
 *   "may_rewrite_input": false,
 *   "notes": "spawns: `gh pr list` / `gh api user` via execFile plus local git probes via lib/trunk-ref.js::resolveTrunk (execFileSync). The hook MEANS to reach the network through the `gh` child — the forge read IS its instrument — so that is declared here via spawns, not via the network flag, which covers only this process's own sockets. The one write is the per-session refusal-budget row appended by lib/stop-refusal.js (BOUND 4, write-before-refuse) through lib/append-sink.js; each refusal consumes a slot, so a repeat appends another row rather than being a no-op."
 * }
 */

const path = require("path");
const { execFile } = require("child_process");
const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
const { runGuard } = require(path.join(__dirname, "lib", "guard-runner.js"));
const {
  resolveEnabled,
  evaluateLaneCompletion,
  reportLines,
  summarize,
} = require(path.join(__dirname, "lib", "lane-completion.js"));
// `nonLaneBranches` is the repo's EXISTING answer to "which branch names are
// trunk rather than lane", derived from the resolved ref (never hardcoded) and
// already used to fence the trunk elsewhere — so this guard and the reap
// surface cannot disagree about which branch a ref names
// (`security.md` § Enforcement-Surface Parity). It is NOT a second copy.
const { resolveTrunk, nonLaneBranches } = require(
  path.join(__dirname, "lib", "trunk-ref.js"),
);

// The trunk probe is LOCAL git (`rev-parse --verify`), never network, and runs
// at most twice. It is bounded anyway so a wedged git cannot eat the hook's
// budget: an expired probe yields UNDETERMINED, which degrades the remedy
// rather than fabricating a trunk.
const TRUNK_BUDGET_MS = 1200;

// The standalone run budget guard-runner.js::runGuard enforces (in the engine the
// registry row's own timeout bounds the run). Set above the forge budget below so
// that the forge budget cuts first under normal operation and the run still
// answers (silently); past it the run is a budget REFUSAL.
const BUDGET_MS = 9000;
const GH_BUDGET_MS = 6000;

function passthrough() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

/** One bounded forge read. Resolves to null on ANY unresolved condition. */
function readLanes(cwd) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const timer = setTimeout(() => finish(null), GH_BUDGET_MS);
    timer.unref?.();
    try {
      execFile(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          "50",
          "--json",
          // `mergeable` and `headRefName` were added for the CONFLICTING arm and
          // cost NO extra round trip — they widen the SAME single `pr list` call
          // that already ran, so the per-turn network cost is unchanged at the
          // two calls below. That matters because this hook fires at EVERY turn
          // boundary, the cost `fleet-drain-guard.js`'s header names as its
          // reason for taking NO network at all.
          // `baseRefName` names the branch the forge computed a CONFLICT against,
          // so the remedy merges THAT branch; same single call, no extra trip.
          "number,title,isDraft,author,mergeable,mergeStateStatus,headRefName,baseRefName,statusCheckRollup",
        ],
        { cwd, timeout: GH_BUDGET_MS, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          clearTimeout(timer);
          if (err) return finish(null);
          try {
            const parsed = JSON.parse(String(stdout || "[]"));
            finish(Array.isArray(parsed) ? parsed : null);
          } catch {
            finish(null);
          }
        },
      );
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/** Who am I? Used to skip lanes another human owns. null ⇒ do not filter. */
function readOperator(cwd) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const timer = setTimeout(() => finish(null), 2500);
    timer.unref?.();
    try {
      execFile(
        "gh",
        ["api", "user", "-q", ".login"],
        { cwd, timeout: 2500 },
        (err, stdout) => {
          clearTimeout(timer);
          if (err) return finish(null);
          const s = String(stdout || "").trim();
          finish(s || null);
        },
      );
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

async function run(payload) {
  if ((payload.hook_event_name || "") !== "Stop") return passthrough();
  if (!resolveEnabled(process.env)) return passthrough();

  const repoDir =
    payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const rows = await readLanes(repoDir);
  // NOT-MEASURED ⇒ SILENT. An unreadable forge is not "no landable lanes".
  if (rows === null) return passthrough();
  // Zero open PRs decides the turn with no trunk probe at all, preserving the
  // "a clean turn spawns no extra git" property for the common idle case.
  if (rows.length === 0) return passthrough();

  // THE TRUNK IS NOW RESOLVED BEFORE CLASSIFICATION, not after it. The promotion
  // arm needs it to decide what each row IS, and a finding is the wrong place to
  // learn that: by then a promotion has already been classified `landable` and
  // handed a `--delete-branch` remedy against the trunk.
  //
  // STRICT resolver (`trunk-ref.js::resolveTrunk`), which returns a THIRD
  // verdict. UNDETERMINED leaves both fields null and the remedy degrades in
  // `reportLines`; it is never collapsed into a guessed `origin/main`.
  const t = resolveTrunk({
    repoDir,
    remote: "origin",
    timeoutMs: TRUNK_BUDGET_MS,
  });
  // `trunk` stays REMOTE-QUALIFIED (`origin/dev`) — it is spliced into a
  // `git merge <ref>` remedy and must be a real ref. `trunkBranches` are the
  // BARE names (`dev`, `main`, `master`) — they are compared against
  // `headRefName`, which the forge returns bare. MEASURED: `resolveTrunk`
  // returns `origin/dev`, so a direct `===` against a head matches NOTHING and
  // would have left the promotion arm silently inert.
  const trunk = t.status === "resolved" ? t.ref : null;
  const trunkBranches = trunk ? nonLaneBranches(trunk) : [];

  const operator = await readOperator(repoDir);
  const finding = evaluateLaneCompletion(rows, {
    env: process.env,
    operator,
    trunk,
    trunkBranches,
  });
  if (!finding) return passthrough();

  const n = finding.landable.length;
  const k = (finding.conflicting || []).length;
  const clauses = [];
  if (n) {
    clauses.push(
      `${n} lane${n === 1 ? "" : "s"} of its own ${n === 1 ? "has" : "have"} ALREADY passed every ` +
        `required check and ${n === 1 ? "is" : "are"} mergeable right now`,
    );
  }
  if (k) {
    clauses.push(
      `${k} lane${k === 1 ? "" : "s"} of its own CANNOT merge at all — the forge reports ` +
        `${k === 1 ? "it" : "them"} CONFLICTING with the base branch`,
    );
  }
  return emit({
    hookEvent: "Stop",
    severity: "halt-and-report",
    what_happened:
      `This agent is going idle while ${clauses.join(", and ")}. ` +
      (n && !k
        ? `${n === 1 ? "It is" : "They are"} finished work sitting un-landed, not work in progress.`
        : `Neither state clears itself: a finished lane needs one command, and a conflicted lane ` +
          `stays unmergeable until someone merges the base in and resolves it.`),
    why:
      "lane drain — an open lane is normal, but a lane that is GREEN and MERGEABLE is finished, and a " +
      "lane that is CONFLICTING is stalled on a fixed, agent-clearable remedy; leaving either open " +
      "converts work into queue depth and hands the operator something the agent could have executed",
    agent_must_report: reportLines(finding),
    // True on BOTH paths — refused and advisory. It names the ACTION, never a
    // promise about whether the turn continues, because the guard cannot branch
    // this text on the verdict: `refusalVerdict` WRITES the budget (BOUND 4), so
    // asking for the verdict here and again inside `instructAndWait` would spend
    // two slots for one finding.
    agent_must_wait:
      "Land each GREEN + MERGEABLE lane named above before going idle, then clean it up (branch AND " +
      "worktree). For each CONFLICTING lane, merge the base branch into it and resolve — that lane " +
      "cannot merge in any state until you do. If one must stay open, say WHY in your next message — " +
      "an unexplained open-but-finished or open-but-conflicted lane is the state this gate exists to end.",
    user_summary: summarize(finding),
    // ── PRODUCER (artifact-stranding.md MUST-3) ──────────────────────────────
    // Second producer of `stop-refusal.js`. Declared in
    // `stop-refusal-contract.test.mjs::REFUSAL_ADOPTERS`; an undeclared adoption
    // reds that suite. Its own budgetKey, so it cannot spend the
    // worktree-conservation guard's slots.
    refuseHandback: {
      payload,
      repoDir,
      budgetKey: "lane-completion",
    },
  });
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). guard-runner.js::runGuard reads
// the payload (refusing an empty, stalled, unparseable or oversized stdin), runs
// `run`, and refuses a throw, a rejection, or a standalone run past BUDGET_MS —
// the endings this row used to pass through as `{continue:true}`.
const hookMain = runGuard("lane-completion-guard", run, { budgetMs: BUDGET_MS });

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
