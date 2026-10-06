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
 * STILL NOT Stop — RE-DECIDED 2026-08-19, against a design that argued the
 * opposite, and recorded here because that is where the next reader will look.
 *
 *   THE CHALLENGE. A parallel rs-variant build added a THROTTLED `Stop` trigger
 *   plus a `PostToolUse(Bash)` band monitor, on measured evidence: its own
 *   SessionStart-only surface warned once at 8 worktrees and stayed silent while
 *   the count went to 31 and the volume to 275 GB. It called that GAP-4 and
 *   argued a throttle answers the "nags every turn" objection.
 *
 *   THE THROTTLE OBJECTION IS ANSWERED. It is not the reason for this decision,
 *   and pretending otherwise would be arguing against a position nobody holds.
 *
 *   WHY STOP IS STILL DECLINED — the gap it closes does not exist HERE.
 *   GAP-4 is a property of a SessionStart-ONLY surface. This guard is not one:
 *   its PreToolUse trigger fires on the worktree-CREATING command itself, which
 *   is the ONLY event at which the forest count can increase. So it already
 *   reports at every point GAP-4 describes, immediately rather than up to a
 *   throttle-window late, and it costs nothing on the turns in between. A Stop
 *   monitor would add a second surface reporting the same number, later.
 *
 *   AND THE rs SIDE COULD NEVER HAVE FIRED. loom registers NO variant hook in any
 *   settings.json — it has no variant-hook lifecycle-registration mechanism at
 *   all, which `sync-manifest.yaml` declares verbatim as a RESIDUAL. A `Stop`
 *   registration declared inside a variant hook is therefore inert by
 *   construction on every lane loom distributes. The trigger was booking a
 *   capability nothing wires.
 *
 *   WHAT IS KEPT from that design: the pressure BANDS (`COUNT_BANDS`,
 *   `crossedBand` in `lib/worktree-occupancy.js`), which are the good half of the
 *   idea and are re-usable by any surface that wants "warn once per level, and
 *   re-arm when the count falls". Nothing in this guard consumes them yet; they
 *   are exported for the surfaces that will.
 *
 *   WHAT IS LOST, stated rather than waved away: a session that opens, creates no
 *   further worktrees, and runs for many hours gets no mid-session re-surface. The
 *   backstop for that case is `/sweep` Sweep 6 and the SessionEnd pass, both of
 *   which this file already carries. A future reader reopening this trade should
 *   reopen it on THAT ground, not on the throttle.
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
 * IT REMOVES AT SessionEnd ONLY, AND ONLY WHAT THIS SESSION CREATED AND CANNOT
 * LOSE WORK. This file contains no removal code: it spawns `worktree-reap.mjs`
 * with `--apply --zero-loss-only --reap-owned-by <this session>`, and that script
 * owns every gate — git's own dirty-tree refusal (never escalated), the KEEP
 * verdict, the main-checkout and own-worktree hard guards, and the 12h idle floor
 * this hook never waives for anything but a tree the closing session created (it
 * passes no `--min-age-hours` and no `--only`). `--force` does not exist to pass.
 *
 * OWNERSHIP, because "cannot lose work" was never the whole question. Three
 * gates — durability, occupancy, age — all cleared on two review worktrees
 * destroyed mid-round: they were clean, pushed, idle, and belonged to somebody
 * else. Nothing in the pipeline asked WHO, so a correct answer to every question
 * asked still removed another session's work. The pass now removes only trees
 * whose creating session is this one and REPORTS every other tree by name;
 * ownership is read from the per-worktree git dir (`coc-owner.json`, falling back
 * to the `coc-session=` token in the lock reason), never inferred. A tree with no
 * record is NOT-YOURS, so landing this on an existing unlabelled forest removes
 * nothing until creation starts labelling.
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
  isUnlockedWorktreeAdd,
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
  KIND_PARTIAL,
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
let _timeout = null;

function passthrough() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

/**
 * The identity of the session that is closing.
 *
 * TWO SIGNALS, ONE MEANING, and both are read from real state rather than
 * reconstructed: the harness stamps `session_id` on the SessionEnd payload, and
 * the same value is exported to this process as `CLAUDE_CODE_SESSION_ID`
 * (`CLAUDE_SESSION_ID` on older builds). Either alone identifies the run; they
 * are not combined into a synthetic id, because a value no reader could ever
 * match is worse than no value at all.
 *
 * AN ABSENT IDENTITY IS RETURNED AS null AND IS NEVER DEFAULTED. The reaper
 * refuses to reap without one, and that refusal is the correct outcome: the
 * unattended pass removes only trees this session created, so with no way to say
 * who this is, every tree is somebody else's. Defaulting to something ("" or a
 * placeholder) would make the gate match nothing, which reports identically to a
 * session that created no trees — the failure mode this whole change is about.
 */
function resolveReaperSession(payload, env = process.env) {
  const fromPayload = payload && typeof payload.session_id === "string" ? payload.session_id.trim() : "";
  if (fromPayload) return fromPayload;
  const fromEnv = (env && (env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID)) || "";
  return typeof fromEnv === "string" && fromEnv.trim() !== "" ? fromEnv.trim() : null;
}

function run(payload) {
  const event = payload.hook_event_name || "";
  const repoDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const floor = resolveFloor(process.env);

  if (event === "PreToolUse") {
    const cmd = (payload.tool_input && payload.tool_input.command) || "";
    if (!isWorktreeCreatingCommand(cmd)) return passthrough();
    // THE CREATION HALF OF THE OWNERSHIP FIX, at the only moment it can be said.
    // A tree created without `--lock` carries no owner, so the unattended
    // reaper — which removes only what it can prove it created — will never
    // touch it. That is a decision being made right now, in this command, and
    // the cost lands on whoever has to retire the tree by hand much later.
    //
    // Fires BEFORE the census short-circuit below, deliberately: whether the
    // forest is small has no bearing on whether THIS tree will be recorded, and
    // routing it through the backlog report would make the advice conditional on
    // an unrelated number.
    if (isUnlockedWorktreeAdd(cmd)) {
      return emit({
        hookEvent: event,
        severity: "advisory",
        what_happened:
          "A worktree is being created WITHOUT `--lock`, so it will carry no record of the session that made it.",
        why: "worktree-isolation.md/Rule-8 — the unattended teardown removes only trees whose creating session is recorded; a tree with no record is one nobody can prove they own, and it will never be reaped automatically",
        // AN ARRAY, like every other report this guard emits. A bare string is
        // silently dropped from the rendered body — the advice would exist in the
        // JSON and reach nobody, which is the "reports success, delivers nothing"
        // shape this file's own doctrine forbids.
        agent_must_report: [
          "State that the tree about to be created will be UNRECORDED, and that the session-end reaper will refuse to remove it — it reaps only the trees it created, and a tree with no record is one nobody can prove they own.",
          "Create it through the owning affordance instead: `node .claude/bin/worktree-reap.mjs --create <path> --branch <name> --base <ref>` — which also LOCKS the tree and records the creating session.",
        ],
        agent_must_wait:
          "If this is a deliberate raw creation (entering an existing branch, or a fixture), say so and proceed. This is a report, not a block.",
        user_summary: "worktree forest: creating an UNLOCKED, unowned worktree",
      });
    }
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
    // WHO IS CLOSING. `payload.session_id` is the harness's own identity for this
    // run, and the env var is the same value the process tree carries; either
    // one alone is enough, and an ABSENT identity is NOT defaulted — the reaper
    // refuses without it, because the unattended pass removes only trees this
    // session created and "no id" must never read as "every tree is mine".
    const sessionId = resolveReaperSession(payload);
    // The census is passed so the subprocess budget SCALES with the workload
    // rather than sitting at a constant that the next forest size outgrows.
    const result = reapForest(repoDir, { census, reapOwnedBy: sessionId });
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
  const classification = classifyForest(repoDir, { census });
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
        : finding.kind === KIND_PARTIAL
          ? `Worktree forest census: ${finding.census} tree(s) (floor ${finding.floor}); the classify pass was PARTIAL — ${finding.classified} classified (${finding.reapable} reapable), ${finding.unknown} NOT examined and therefore UNKNOWN.`
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

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  _timeout = setTimeout(() => {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, TIMEOUT_MS);
  _timeout.unref?.();
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.on("error", passthrough);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      try {
        onStdinEnd(input);
      } catch (e) {
        return reject(e);
      }
      resolve();
    });
  });
}

function onStdinEnd(input) {
  clearTimeout(_timeout);
  try {
    run(JSON.parse(input || "{}"));
  } catch (e) {
    process.stderr.write(`[worktree-forest-guard] HOOK ERROR: ${e.message}\n`);
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
