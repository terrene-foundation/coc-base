#!/usr/bin/env node
/**
 * dispatch-retask-guard.js — the RE-TASK entry of the dispatch-contract guard's effort-routing arm.
 *
 * A follow-up (`SendMessage`) whose first line DECLARES a ROLE is checked against the effort its
 * recipient was LAUNCHED with, from the T1 dispatch ledger: a running agent's effort cannot be
 * changed by a message, so a ROLE needing a different effort than a KNOWN launch is blocked (dispatch
 * a fresh agent instead), and every finding is advisory when the launch effort is unknown. The whole
 * decision lives in `dispatch-contract-guard.js` (`evaluateRetask`) and `lib/effort-routing.js`
 * (`decideRetask`); this file is the event binding and its fail-open run boundary, nothing else.
 *
 * @hook-event: PreToolUse:SendMessage (guard) — the follow-up IS the subject: the recipient and the
 *   message that declares the new ROLE live in `tool_input` at this moment and nowhere else, and it
 *   is the last instant before the message re-tasks an agent at an effort it cannot change. The
 *   matcher is exactly that one tool; a `*` matcher would pay a node spawn on every Read/Bash/Grep to
 *   reach an immediate passthrough, and `hook-event-selection.md` MUST-3 FAILs a narrow class
 *   registered without a matcher.
 *
 * WHY A SEPARATE FILE. `SendMessage` is every lane's delivery channel, so a guard that cannot FINISH
 * on a follow-up — a crash, or an overrun of the registered budget on a loaded host — must let the
 * message through, while a launch the guard cannot finish must not run. The registry declares that
 * per row (`on_incomplete`), and it refuses ONE hook declared twice with different values
 * (`lib/dispatch-registry.js::assertNoDivergentDuplicateRows`). So the launch entry,
 * `dispatch-contract-guard.js`, keeps its `Task|Agent` row at `deny`, and this entry is registered on
 * `SendMessage` at `continue` (`.claude/hooks/dispatch-registry.json`). In-process failures pass
 * through as well (`dispatch-contract-guard.js::evaluateEffortRouting`): only a COMPLETED evaluation
 * against a KNOWN launch can block a follow-up.
 *
 * WHY THE RUN BOUNDARY LIVES HERE. The launch entry fails CLOSED through `lib/guard-runner.js::runGuard`
 * (a deny row); this entry must fail OPEN on the same endings — an unreadable payload, a throw, its
 * own budget — so it keeps the bounded reader and the timer + catch that pass the follow-up through
 * (`cc-artifacts.md` Rule 7, advisory/`continue` rows). Keeping that boundary in this file, not in the
 * shared module, is what lets the launch file carry no fail-open shape at all.
 */

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [
 *       ".claude/dispatch-authz/.override-claim-<mkdtemp>/receipt",
 *       "<main-checkout>/.claude/learning/override-receipt-uses.jsonl"
 *     ],
 *     "network": false,
 *     "spawns": ["git"]
 *   },
 *   "idempotent": false,
 *   "may_rewrite_input": false,
 *   "notes": "Runs dispatch-contract-guard.js::evaluateRetask, which acts only on SendMessage, inside this file's own fail-open boundary (bounded stdin read, a 4000ms timer and a catch, each passing the follow-up through). A follow-up whose first line declares no ROLE returns before any IO. On a ROLE-declaring follow-up it spawns the lib/state-resolver.js::requireMainCheckout git probe to read the T1 dispatch ledger (read-only). Writes happen only on an override: an honoured EFFORT-OVERRIDE line appends one inline row to the use ledger (lib/override-receipt.js::recordInlineOverride), and a matching one-shot receipt for a blocked re-task is claimed and recorded exactly as for the launch entry, so a consumed receipt cannot authorize a repeat payload."
 * }
 */

"use strict";

const { evaluateRetask, passthrough, BUDGET_MS } = require("./dispatch-contract-guard.js");
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND in-process by
// lib/hook-engine.js (dispatch.js). The timer is cleared when the run settles, so a fired-late
// callback can never answer for a later run in the engine's long-lived worker. `main` awaits only the
// stdin read, so the timer can fire only while that read is pending; the judgement after it runs
// synchronously to an exit.
function hookMain() {
  const timer = setTimeout(() => passthrough(null), BUDGET_MS);
  if (typeof timer.unref === "function") timer.unref();
  return readStdinBounded({})
    .then((payload) => evaluateRetask(payload))
    .catch(() => passthrough(null))
    .finally(() => clearTimeout(timer));
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
