#!/usr/bin/env node
/**
 * worktree-forest-guard.js — the Phase-2 detector `worktree-isolation.md` Rule 8
 * deferred, and — at SessionEnd — the ACTOR that Rule 8(b) never had.
 * PreToolUse reports. SessionEnd reaps ZERO-LOSS trees and reports what it did.
 *
 * @hook-event: PreToolUse:Bash (guard) — the subject is the worktree-CREATING
 *   command itself, which exists only as the pending Bash invocation; no later
 *   event can see it before the tree is added, and no earlier one knows it is
 *   coming. Bash is the sole matcher because `git worktree add` is a shell
 *   command; an Edit/Write matcher would never see it.
 * @hook-event: SessionEnd (lifecycle) — the subject is the forest a closing
 *   session leaves behind, which is only final once no further tool call will
 *   add to it. Rule 8(b) exists because 8(a) "fails silently whenever an
 *   orchestrator dies mid-wave"; SessionEnd is the last moment that case is
 *   still observable from inside the session that caused it.
 *
 * TWO SURFACES, both chosen on evidence rather than convenience:
 *
 *   PreToolUse(Bash) on a worktree-CREATING command — the moment the ratchet
 *     turns. This is where "creation owns teardown" actually binds: the operator
 *     is about to add tree N+1, and if N already contains a reapable backlog,
 *     that is the cheapest possible moment to say so. It fires RARELY (only on
 *     `git worktree add` / `/worktree`), so it cannot become background noise.
 *
 *   SessionEnd — the once-per-session close-out. Rule 8(b) exists because 8(a)
 *     "fails silently whenever an orchestrator dies mid-wave, the case that leaks
 *     most"; a session ending with a reapable backlog is the visible edge of that
 *     case. Fires exactly once, so it is free.
 *
 * NOT Stop. Stop fires on EVERY turn, and an instruction there nags after every
 * post-commit turn — the reasoning `wrapup-after-landing.js` records verbatim for
 * rejecting Stop for its own trigger. A forest census is also ~28 `git status`
 * calls at this clone's size; paying that per turn would be a real cost for a
 * signal that changes at most a few times a session.
 *
 * SEVERITY — `halt-and-report` at PreToolUse, `advisory` at SessionEnd, never
 * `block`, per `hook-output-discipline.md` MUST-2.
 *
 *   The SIGNAL is structural and deterministic — `git worktree list --porcelain`
 *   enumerates the forest from `.git/worktrees/`, and the reap verdicts derive
 *   from `git status --porcelain` / `rev-list --not --remotes` / `cherry` / mtime.
 *   None of that is a lexical guess and none can be evaded by rewording a
 *   command. By MUST-2's letter, a structural signal MAY carry `block`.
 *
 *   It does not, and the reason is MUST-2's own MUST NOT: "detectors that block
 *   work the agent has been instructed to perform, when the structural fact
 *   confirms in-scope". Whether a reapable backlog should stop the NEXT worktree
 *   from being created is a judgment about the operator's plan, not a fact about
 *   the repo — a 30-lane wave is legitimate. Blocking it would make this the
 *   detector whose false-positive cost exceeds its true-positive value. So the
 *   structural signal buys CONFIDENCE IN THE NUMBER (the report states counts as
 *   fact), not teeth.
 *
 * IT REMOVES AT SessionEnd ONLY, AND ONLY WHAT CANNOT LOSE WORK. This file
 * contains no removal code: it spawns `worktree-reap.mjs` with
 * `--apply --zero-loss-only`, and that script owns every gate — git's own
 * dirty-tree refusal (never escalated), the KEEP verdict, the main-checkout and
 * own-worktree hard guards, and the 12h idle floor this hook never waives (it
 * passes no `--min-age-hours` and no `--only`). `--force` does not exist to pass.
 * TAG-FIRST is excluded from the unattended pass because its durability would
 * depend on a tag the pass itself mints; it is reported for an operator instead.
 * Full reasoning: the header of `lib/worktree-forest.js`.
 *
 * WHY SessionEnd AND NOT PreToolUse. At PreToolUse the operator is mid-decision,
 * creating a tree right now; removing others underneath that is the surprise a
 * pre-flight advisory exists to prevent, and someone is present to read a
 * report. At SessionEnd nobody is watching, which is exactly the case Rule 8(b)
 * was written for and the one an operator-invoked `/sweep` cannot cover.
 *
 * KILL SWITCH: `COC_WORKTREE_AUTOREAP=0` (also `off`/`false`/`no`/`disabled`)
 * disables the unattended reap and falls back to the report-only path, which
 * then says it is disabled. DEFAULT ON; an unrecognised value stays ON rather
 * than silently shipping the feature inert.
 *
 * Both scripts ship to every synced target: `.claude/hooks/**` and
 * `.claude/bin/worktree-reap.mjs` are both on
 * `sync-tier-aware.mjs::ALWAYS_INCLUDE`, so the hook this settings.json wires at
 * every consumer resolves the tool it names.
 *
 * FAIL-OPEN. Every error path emits `{continue:true}` and exits 0/1. A detector
 * that can wedge a session is worse than the accumulation it reports.
 */

const path = require("path");
const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
const {
  resolveFloor,
  resolveAutoReap,
  isWorktreeCreatingCommand,
  censusForest,
  volumeFreeKb,
  classifyForest,
  reapForest,
  evaluateForest,
  evaluateReap,
  reportLines,
  reapReportLines,
  summarize,
  KIND_CENSUS_ONLY,
  KIND_REAPED,
  KIND_REAP_INTERRUPTED,
} = require(path.join(__dirname, "lib", "worktree-forest.js"));

// cc-artifacts.md Rule 7 — a stdin-stall fallback that never hangs the session.
// Exit 1 (not 0) so a fired timeout is distinguishable from a normal passthrough
// in exit-code logs.
//
// WHAT THIS DOES AND DOES NOT BOUND. It is cleared on stdin `end`, BEFORE `run()`
// is called, and `run()` is synchronous — a `setTimeout` cannot interrupt an
// `execFileSync`, because the timer callback can only be delivered once the
// stack unwinds. So this bounds the WAIT FOR STDIN and nothing else. (An earlier
// comment here called it "generous over the 8s classifier budget", which was
// wrong in a way worth naming: it implied a ceiling on the census+classify work
// that this timer never provided.) The real ceilings are the per-subprocess
// timeouts in worktree-forest.js and the `timeout` on each settings.json
// registration, which are sized against each other there.
const TIMEOUT_MS = 10000;
const _timeout = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);
_timeout.unref?.();

function passthrough() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

function run(payload) {
  const event = payload.hook_event_name || "";
  const repoDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const floor = resolveFloor(process.env);

  if (event === "PreToolUse") {
    const cmd = (payload.tool_input && payload.tool_input.command) || "";
    if (!isWorktreeCreatingCommand(cmd)) return passthrough();
  } else if (event !== "SessionEnd") {
    // Registered only on those two events; anything else is a mis-registration
    // and passes through rather than guessing what the caller meant.
    return passthrough();
  }

  const census = censusForest(repoDir);
  // The cheap short-circuit: below the floor no finding is REACHABLE (reapable
  // is a subset of census), so the expensive classifier is never spawned. A
  // solo repo with one or two trees pays one `git worktree list` and nothing else.
  // It also gates the REAP — a three-tree forest is not the accumulation this
  // closes, and paying ~0.24s/tree at every session close to confirm that would
  // be a cost with no finding behind it.
  if (!Number.isInteger(census) || census < floor) return passthrough();

  const autoReap = resolveAutoReap(process.env);

  // ── SessionEnd: ACT, then report what was done ──
  //
  // This is the half of Rule 8 that had no actor. 8(a) binds the orchestrator
  // per wave and "fails silently whenever an orchestrator dies mid-wave"; 8(b)
  // named `/sweep` as the backstop, but `/sweep` is operator-invoked, so the
  // backstop for "nobody was watching" itself required someone to be watching.
  if (event === "SessionEnd" && autoReap.enabled) {
    // Read free space BEFORE the pass. One statfs; the reaper reports the after
    // figure from its own run. Neither number is attributed to the reap alone.
    const freeKbBefore = volumeFreeKb(repoDir);
    const result = reapForest(repoDir);
    if (result && result.ok) result.freeKbBefore = freeKbBefore;

    const finding = evaluateReap(census, result, floor);
    if (!finding) return passthrough();

    const isReaped = finding.kind === KIND_REAPED;
    const interrupted = finding.kind === KIND_REAP_INTERRUPTED;
    return emit({
      hookEvent: event,
      severity: "advisory",
      what_happened: interrupted
        ? `An unattended ZERO-LOSS reap ran at session end on a ${finding.census}-tree forest and was cut short (${finding.reason}). How many trees it removed is UNKNOWN.`
        : isReaped
          ? `An unattended reap ran at session end on a ${finding.census}-tree forest: ${finding.removed.length} ZERO-LOSS tree(s) removed, ${finding.keep} KEEP untouched, ${finding.tag_first} TAG-FIRST left for an operator.`
          : `Worktree forest census: ${finding.census} tree(s) (floor ${finding.floor}); the reap could not run (${finding.reason}).`,
      why: "worktree-isolation.md/Rule-8 — creation owns teardown; the forest grows unbounded until the volume fills",
      agent_must_report: isReaped || interrupted ? reapReportLines(finding) : reportLines(finding),
      agent_must_wait:
        "No action required in this session; the report is for the operator. Set COC_WORKTREE_AUTOREAP=0 to disable the unattended reap.",
      user_summary: summarize(finding),
    });
  }

  // ── PreToolUse (always), and SessionEnd with the reap disabled: REPORT ONLY ──
  //
  // PreToolUse never reaps, and that is a deliberate asymmetry rather than an
  // omission. The subject there is a worktree the operator is CREATING RIGHT
  // NOW; removing trees underneath an in-flight decision is precisely the
  // surprise a pre-flight advisory exists to prevent, and the operator is
  // present, so the report reaches someone who can act on it.
  const classification = classifyForest(repoDir);
  const finding = evaluateForest(census, classification, floor);
  if (!finding) return passthrough();

  const reapOff = event === "SessionEnd" && !autoReap.enabled;
  const lines = reportLines(finding);
  if (reapOff) {
    lines.push(
      `State that the unattended session-end reap is DISABLED by COC_WORKTREE_AUTOREAP=${autoReap.raw}, so nothing was removed automatically. It is ON by default; unset the variable to restore it.`,
    );
  }

  emit({
    hookEvent: event,
    severity: event === "PreToolUse" ? "halt-and-report" : "advisory",
    what_happened:
      finding.kind === KIND_CENSUS_ONLY
        ? `Worktree forest census: ${finding.census} tree(s) (floor ${finding.floor}); reap classification did not complete.`
        : `Worktree forest census: ${finding.census} tree(s), ${finding.reapable} reapable (floor ${finding.floor}).` +
          (event === "PreToolUse"
            ? " A new worktree was about to be created on top of that backlog."
            : " The session is ending with the backlog un-reaped and the unattended reap disabled."),
    why: "worktree-isolation.md/Rule-8 — creation owns teardown; the forest grows unbounded until the volume fills",
    agent_must_report: lines,
    agent_must_wait:
      event === "PreToolUse"
        ? "Report the counts, then proceed with the worktree creation if it is still what the operator wants. This is a report, not a block."
        : "No action required in this session; the report is for the operator.",
    user_summary: summarize(finding),
  });
}

let input = "";
process.stdin.on("error", passthrough);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  clearTimeout(_timeout);
  try {
    run(JSON.parse(input || "{}"));
  } catch (e) {
    process.stderr.write(`[worktree-forest-guard] HOOK ERROR: ${e.message}\n`);
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }
});
