#!/usr/bin/env node
/**
 * fleet-drain-guard.js — the detector for `wave-loop.md` MUST-6 ("Never Idle-Wait While
 * Independent In-Budget Work Is Launchable"), whose Detection mechanism read "Phase 1 (manual,
 * gate-review)" only.
 *
 * @hook-event: Stop (lifecycle) — THE TURN BOUNDARY IS THE SUBJECT. The failure is the orchestrator
 *   handing back to the human with lanes idle and dispatchable work on the board; that is a
 *   property of the moment the turn ends, not of any tool call. No `PreToolUse` hook can fire on
 *   the dispatch that was never made, and `SubagentStop` is blind for the sharper form of the same
 *   reason — in the DRAINED case no subagent is running, so none stops, and the one state this
 *   exists to catch is the one that event structurally cannot see. `Stop` fires at the end of the
 *   main agent's turn regardless. Class is `lifecycle`, not `guard`: `Stop` carries no tool axis,
 *   and `hook-event-selection.md` MUST-3 FAILs a narrow class registered at an event that cannot
 *   carry a matcher.
 *
 *   The cost of `Stop` is stated rather than hidden, the same way the sibling
 *   `delegation-default-guard.js` states it: it is LATE. It fires after the turn's throughput is
 *   already spent, so it recovers the NEXT turn, not this one. For a REFILL trigger that is
 *   tolerable in a way it would not be for a correctness gate — the next turn is exactly when the
 *   refill would happen.
 *
 * SEVERITY IS `halt-and-report`, AND THE EVENT IS WHAT CAPS IT — not the signal. Both counts are
 * STRUCTURAL (set arithmetic over JSONL rows; a markdown table row count), so
 * `hook-output-discipline.md` MUST-2's bar on `block` from a LEXICAL signal is not the binding
 * constraint here. MEASURED at both poles instead: `instruct-and-wait.js` tests `STOP_LIKE_EVENTS`
 * BEFORE the `severity === "block"` branch, so `Stop` + `block` returns `{continue:true}` exit 0,
 * while the control `PreToolUse` + `block` returns `{continue:false}` exit 2. No severity blocks at
 * `Stop`. `halt-and-report` is the strongest available AND the right one on the merits: what is
 * needed is that the orchestrator SURFACE and acknowledge the count, which is precisely the
 * intervention that was missing.
 *
 * NO NETWORK. The occupancy signals are the harness's own `background_tasks` array, already present
 * on the payload this hook is handed, cross-checked against the `dispatch-reconcile` ledger this
 * repo already writes; the open-work count comes from the committed `## Outstanding ledger (forest)`
 * surface. Open issues and open PRs were REJECTED as sources — not because they are wrong, but
 * because they need a `gh` round-trip and this hook runs at EVERY turn boundary, where a 2s network
 * call is a per-turn tax. `lib/fleet-drain.js` records the measurement that also makes them poor
 * SIGNALS (ambient repo state, near-constant across compliant and non-compliant sessions alike).
 *
 * TWO OCCUPANCY INSTRUMENTS, NEITHER PREFERRED BY FAITH (2026-08-20). The ledger difference is a
 * LOWER bound on running lanes and this detector fires on running being LOW, so alone it
 * systematically OVER-reported drain — a defect that made the FINDING untrustworthy. It is NOT
 * what caps the severity, and saying so would contradict the measurement two paragraphs above:
 * the EVENT caps it, at every severity, whatever the signal's quality. The primary
 * signal is now the harness's structural `background_tasks` statement; the ledger is the
 * cross-check; and where the two DISAGREE about whether anything is running, the verdict is UNKNOWN
 * and says which reading each gave. Shape, conditions and the known-answer control:
 * `lib/fleet-drain.js` § INSTRUMENT C.
 *
 * TRI-STATE. ADVISE / OBSERVE / QUIET / UNKNOWN. An absent or unreadable ledger, an absent or
 * unclassifiable `background_tasks` array, or a disagreement between the two is UNKNOWN — never
 * silently QUIET. UNKNOWN prints nothing (noise discipline, argued at `formatFleetDrainAdvisory`),
 * but it is a distinct state in the data and is pinned by fixtures.
 *
 * FAILS OPEN ON EVERY ERROR AND EVERY UNKNOWN (`cc-artifacts.md` Rule 7), and resolves the repo
 * root FAIL-CLOSED — reading some other tree's ledger would answer a question about a different
 * session while appearing to answer this one.
 *
 * WRITES ONE THING: a per-session dedupe marker keyed on the MEASURED PAIR **plus the FLEET EPOCH**
 * (`launched`/`terminated`, as ROW COUNTS over the ledger), so a persisting drain is surfaced once
 * per state rather than once per assistant turn, while a fleet that CHANGES is reported again. The
 * epoch is what makes the second half of that sentence TRUE: without it nothing in the key moved
 * when a lane completed, and a genuinely new drain was suppressed as a duplicate (measured, session
 * c90a644a 2026-08-20). Counting ROWS rather than distinct NAMES is what makes it true for a
 * REUSED lane name — a resumed or retried lane, or a review loop that dispatches the same two names
 * every round, otherwise froze the epoch and silenced the detector permanently. The epoch is scoped
 * to the `ADVISE` arm; `lib/fleet-drain.js::signatureOf` carries both incidents and that bound. The
 * marker is written only AFTER the emitting write REPORTS THE BYTES FLUSHED (`write()` resolving
 * `true`, not merely returning) — and inside this hook's own 4s bound — so failing to write it costs
 * a repeated line, never a suppressed finding. A session with no usable `session_id` is exempted
 * from dedupe entirely rather than sharing the fallback marker path with every other such session.
 *
 * KILL SWITCH: `COC_FLEET_DRAIN=0|off|false|no`. DEFAULT-ON, so a deployment that never heard of
 * this still gets the coverage. Lane floor: `COC_FLEET_LANE_FLOOR` (default 1).
 *
 * Origin: session 39, 2026-08-17 — measured 100 open issues / 7 open PRs / 16 forest-ledger rows
 * against ONE running lane, with `wave-loop.md` MUST-6 and `agents.md` § Parallel Execution loaded
 * throughout. A rule a compliant agent violates ~20 times in one session is an enforcement gap.
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7, under the registered 5s timeout so this hook's own
// fallback fires first and shutdown is never held up.
const TIMEOUT_MS = 4000;
let fallback = null;

/**
 * THERE IS NO `emitted` DOUBLE-WRITE FLAG, and its removal is a deletion of dead scaffolding
 * (`zero-tolerance.md` Rule 2), not a weakening. It read `if (!emitted)` inside the timer callback
 * and claimed to stop a late bare `{continue:true}` from erasing a delivered finding — a guarantee
 * it could not provide, because the branch is UNREACHABLE and the flag was therefore provably
 * `false` at every evaluation.
 *
 * MEASURED, not assumed: the ONLY yield point in this file is `await readStdinBounded()`, which
 * runs BEFORE anything is written. `finish()` and `emitFinding()` each write to stdout and then
 * call `process.exit(0)` with no `await`, `setImmediate`, `process.nextTick` or promise
 * continuation between the two, so the event loop is never handed back after a protocol line is
 * emitted and the timer callback cannot run. (FALSIFYING RESULT had this been wrong: the same
 * matcher run over the whole file DOES fire — 3 hits — and none of them fall between the stdout
 * write and the exit.) The flag was also structurally unpinnable: the fixture set records that the
 * only mutation reaching it needs `TIMEOUT_MS = 0`, and that mutation reds the identical case set
 * WITH the guard intact, so it carried no information about the guard
 * (`instrument-discipline.md` MUST-2(b)).
 *
 * WHAT ACTUALLY HOLDS THE GUARANTEE is the exit, which is why deleting the flag costs nothing: a
 * synchronous write-then-exit cannot be preempted. Should a future edit introduce an `await`
 * between the emit and the exit, that edit — not this file's present state — is what would need a
 * re-armed guard, and it would also break the Rule-7 self-bound reasoning at `emitFinding`.
 */
const path = require("path");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

/** The unconditional safe exit. Every path in this file ends here or at `emitFinding`. */
function finish() {
  if (fallback) clearTimeout(fallback);
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {}
  process.exit(0);
}

/**
 * Resolve the main checkout FAIL-CLOSED, the discipline `reconcile-dispatch-delivery.js` and
 * `delegation-default-guard.js` both apply: an indeterminate resolution yields UNKNOWN without
 * reading anything, because a verdict derived from a tree we could not confirm is a confident
 * wrong answer.
 */
function requireMainCheckoutSafely(repoDir) {
  try {
    const { requireMainCheckout } = require(path.join(__dirname, "lib", "state-resolver.js"));
    return requireMainCheckout(repoDir);
  } catch (e) {
    return { ok: false, reason: `state-resolver unavailable: ${e && e.message ? e.message : String(e)}` };
  }
}

/**
 * Emit the finding in the canonical halting-hook shape (`hook-output-discipline.md` MUST-1), THEN
 * — and only if the write REPORTED THE BYTES FLUSHED — record the dedupe marker. At `Stop` the shape
 * resolves to `{continue:true, systemMessage}` — `hookSpecificOutput` is dropped at this event,
 * which is why the shared renderer routes STOP_LIKE events to `systemMessage`.
 *
 * ORDER IS LOAD-BEARING, AND IT USED TO BE WRONG. The marker was previously written BEFORE this
 * function ran, so a renderer failure — which this function absorbs, writing a bare
 * `{continue:true}` so a broken renderer never costs the shutdown — left the signature marked as
 * surfaced having NEVER been delivered, suppressing it for the rest of the session. That inverts
 * the header's stated tradeoff: a marker failure must cost at most a REPEATED line, never a
 * SUPPRESSED finding. Emitting first and marking on the success path only makes both directions
 * fail the safe way — an undelivered finding is never marked, and an unmarked delivered finding
 * merely repeats.
 *
 * THE SELF-BOUND STAYS ARMED ACROSS THE MARKER WRITE. Reordering emit-before-mark moved the marker
 * append AFTER the point this function used to `clearTimeout`, which quietly left the append
 * covered only by the registered 5s harness timeout rather than this hook's own 4s bound
 * (`cc-artifacts.md` Rule 7). The timer is now cleared LAST, and nothing is needed to stop it from
 * writing a second protocol line over a delivered finding: everything from the stdout write to
 * `process.exit(0)` below is synchronous, so the callback cannot be scheduled in between. A flag
 * that tested for that condition once existed here and was DELETED as unreachable — see the note
 * above the requires. The two guarantees are not in tension.
 *
 * WHAT THAT DOES AND DOES NOT BUY, measured rather than assumed: `markSurfaced` appends
 * SYNCHRONOUSLY, and a synchronous stall blocks the event loop, so no `setTimeout` callback can
 * preempt it in EITHER ordering (measured: a 400ms sync spin delays a 50ms timer to ~400ms). The
 * restored ordering therefore re-covers the ASYNCHRONOUS surface — module resolution, and any
 * future non-blocking sink — and the honest limit is that neither ordering bounds a blocking write.
 *
 * @param {string} advisory
 * @param {Function} mark called ONLY after the finding reached stdout; its own failure is
 *   non-fatal by design (see the call site).
 */
function emitFinding(advisory, mark) {
  let delivered = false;
  try {
    const { instructAndWait } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
    const out = instructAndWait({
      hookEvent: "Stop",
      severity: "halt-and-report",
      what_happened: advisory,
      why:
        "`wave-loop.md` MUST-6 — idling while independent, in-budget, parallelizable work is " +
        "launchable is BLOCKED. A lane freeing is a REFILL trigger, not merely a result to read.",
      agent_must_report: [
        "the measured pair above: running lanes, and dispatchable open rows",
        "either the lanes you are dispatching now, or which bound makes the remaining rows " +
          "non-launchable (data/build dependency, a structural human gate, capacity/throttle, " +
          "prudence, or a converged clean stop per recommendation-quality.md MUST-3)",
      ],
      agent_must_wait: false,
      user_summary: "Fleet idle with work on the board.",
    });
    // GATED ON THE RETURN VALUE, not on the call returning. `write()` resolving `false` means the
    // bytes were BUFFERED, not flushed — and `process.exit(0)` below discards a partial buffer. On
    // darwin a pipe stdout is asynchronous, so under back-pressure the old `delivered = true` marked
    // a finding whose bytes never left the process: the exact permanent suppression this reorder
    // exists to prevent, reintroduced one line lower. Treating a buffered write as UNDELIVERED costs
    // at most a repeated advisory line — the safe direction this whole module is built around.
    delivered = process.stdout.write(JSON.stringify(out.json) + "\n") === true;
  } catch {
    // The renderer is the only thing that can fail here; a finding must never cost the shutdown.
    // `delivered` stays false, so NOTHING is marked and the next `Stop` re-evaluates from scratch.
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
  }

  if (delivered && typeof mark === "function") {
    // NON-FATAL BY DESIGN, and not a silent fallback: `markSurfaced` already returns `{ok,error}`
    // and never throws, and there is nowhere to report to — stdout carries the hook protocol and
    // is already written. The failure mode is bounded and named in the header: a lost marker costs
    // one repeated advisory line on the next turn. This guard exists only so a defect in the sink
    // cannot turn a DELIVERED finding into a non-zero exit or a second protocol line.
    try {
      mark();
    } catch {}
  }
  // LAST, not first: the marker append above ran inside this hook's own 4s bound.
  if (fallback) clearTimeout(fallback);
  process.exit(0);
}

async function main() {
  fallback = setTimeout(() => {
    // Reachable ONLY while `await readStdinBounded()` is pending — the sole yield point in this
    // file, and it precedes every write. Once a protocol line has been emitted the emitting
    // function exits synchronously, so this callback can never run afterwards and can never erase
    // a delivered finding. See the note above the requires for the measurement.
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
    process.exit(0);
  }, TIMEOUT_MS);

  try {
    const lib = require(path.join(__dirname, "lib", "fleet-drain.js"));
    if (!lib.resolveEnabled(process.env)) return finish();

    // `readStdinBounded()` resolves the PARSED payload — NOT raw text. Calling JSON.parse() on it
    // is the bug that made `dispatch-contract-guard.js` silently inert while all 42 of its library
    // fixtures stayed green; the end-to-end cases in this detector's fixture set exist so the same
    // seam cannot regress here unobserved.
    const payload = await readStdinBounded();
    // A BLANK id is treated as ABSENT, matching `dispatch-ledger.js::_sinkPath`'s `.trim()` guard.
    // Without this the ledger is read at `unknown-session-<hashA>` while the marker is written to
    // `__-<hashB>` — a read through one door and a write through the other.
    const rawSessionId = payload && payload.session_id;
    const hasSessionId = typeof rawSessionId === "string" && rawSessionId.trim().length > 0;
    const sessionId = hasSessionId ? rawSessionId : "unknown-session";

    const resolved = requireMainCheckoutSafely(PROJECT_DIR);
    if (!resolved.ok) return finish(); // UNKNOWN — silent by design, never QUIET in the data.

    const ledger = require(path.join(__dirname, "lib", "dispatch-ledger.js"));
    const read = ledger.readLedger({ repoDir: resolved.repoDir, sessionId });

    const lanes = lib.countRunningLanes(read.ok ? read.rows : null, read.ok ? undefined : read);
    // INSTRUMENT C — the harness's own `background_tasks` array, read off the SAME payload already
    // in hand. No extra IO, no clock, no network: it is a field this hook was always given and
    // never opened.
    const tasks = lib.readBackgroundTasks(payload);
    const work = lib.countOpenWork(lib.collectNotesSurfaces(resolved.repoDir));
    const verdict = lib.assessFleetDrain({ lanes, work, tasks }, { laneFloor: lib.resolveLaneFloor(process.env) });

    const advisory = lib.formatFleetDrainAdvisory(verdict);
    if (!advisory) return finish();

    const sig = lib.signatureOf(verdict);

    // NEVER SHARE A SUPPRESSION FILE. Every session lacking a usable `session_id` derives the SAME
    // marker path, and the sha256 disambiguator cannot separate them because it hashes that same
    // fallback string. One session's marker would then silence a DIFFERENT session's genuine drain —
    // the one direction `lib/fleet-drain.js::_markerPath` says the suffix exists to prevent. So an
    // unidentified session does not participate in dedupe at all: it emits, and writes nothing.
    // Cost is a repeated line per turn; the alternative is a suppressed finding in another session.
    if (!hasSessionId) return emitFinding(advisory, null);

    if (lib.alreadySurfaced(resolved.repoDir, sessionId, sig)) return finish();

    // EMIT FIRST, MARK SECOND. The marker is a record that the finding WAS surfaced, so writing it
    // ahead of the write that surfaces it made the record false whenever the renderer failed —
    // permanently suppressing a signature never delivered. See `emitFinding`.
    return emitFinding(advisory, () =>
      lib.markSurfaced(resolved.repoDir, sessionId, sig, new Date().toISOString()),
    );
  } catch {
    return finish();
  }
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). `main()` already arms its own
// fallback timer as its first statement, so this is exactly the old load-time call.
function hookMain() {
  return main();
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
