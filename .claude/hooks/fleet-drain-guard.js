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
 * NO SECOND COUNT, AND NO NETWORK. The lane count is read from the `dispatch-reconcile` ledger this
 * repo already writes; the open-work count from the committed `## Outstanding ledger (forest)`
 * surface. Open issues and open PRs were REJECTED as sources — not because they are wrong, but
 * because they need a `gh` round-trip and this hook runs at EVERY turn boundary, where a 2s network
 * call is a per-turn tax. `lib/fleet-drain.js` records the measurement that also makes them poor
 * SIGNALS (ambient repo state, near-constant across compliant and non-compliant sessions alike).
 *
 * TRI-STATE. ADVISE / OBSERVE / QUIET / UNKNOWN. An absent, unreadable, or unnamed-contaminated
 * ledger is UNKNOWN — never silently QUIET. UNKNOWN prints nothing (noise discipline, argued at
 * `formatFleetDrainAdvisory`), but it is a distinct state in the data and is pinned by fixtures.
 *
 * FAILS OPEN ON EVERY ERROR AND EVERY UNKNOWN (`cc-artifacts.md` Rule 7), and resolves the repo
 * root FAIL-CLOSED — reading some other tree's ledger would answer a question about a different
 * session while appearing to answer this one.
 *
 * WRITES ONE THING: a per-session dedupe marker keyed on the MEASURED PAIR, so a persisting drain
 * is surfaced once per state rather than once per assistant turn, while a fleet that CHANGES is
 * reported again. Failing to write it costs a repeated line, never a suppressed finding.
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
 * Emit the finding in the canonical halting-hook shape (`hook-output-discipline.md` MUST-1). At
 * `Stop` that resolves to `{continue:true, systemMessage}` — `hookSpecificOutput` is dropped at
 * this event, which is why the shared renderer routes STOP_LIKE events to `systemMessage`.
 */
function emitFinding(advisory) {
  if (fallback) clearTimeout(fallback);
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
    process.stdout.write(JSON.stringify(out.json) + "\n");
  } catch {
    // The renderer is the only thing that can fail here; a finding must never cost the shutdown.
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
  }
  process.exit(0);
}

async function main() {
  fallback = setTimeout(() => {
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
    const sessionId = (payload && payload.session_id) || "unknown-session";

    const resolved = requireMainCheckoutSafely(PROJECT_DIR);
    if (!resolved.ok) return finish(); // UNKNOWN — silent by design, never QUIET in the data.

    const ledger = require(path.join(__dirname, "lib", "dispatch-ledger.js"));
    const read = ledger.readLedger({ repoDir: resolved.repoDir, sessionId });

    const lanes = lib.countRunningLanes(read.ok ? read.rows : null, read.ok ? undefined : read);
    const work = lib.countOpenWork(lib.collectNotesSurfaces(resolved.repoDir));
    const verdict = lib.assessFleetDrain({ lanes, work }, { laneFloor: lib.resolveLaneFloor(process.env) });

    const advisory = lib.formatFleetDrainAdvisory(verdict);
    if (!advisory) return finish();

    const sig = lib.signatureOf(verdict);
    if (lib.alreadySurfaced(resolved.repoDir, sessionId, sig)) return finish();
    lib.markSurfaced(resolved.repoDir, sessionId, sig, new Date().toISOString());

    return emitFinding(advisory);
  } catch {
    return finish();
  }
}

if (require.main === module) {
  main();
}

module.exports = {};
