#!/usr/bin/env node
/**
 * delegation-default-guard.js — the detector for `orchestrator-context-economy.md` MUST-3
 * ("Delegation Is The DEFAULT, Not An Escalation The Human Requests"), loom#1752.
 *
 * @hook-event: Stop (lifecycle) — THE ONLY SURFACE THAT CAN FIRE ON THIS FAILURE. MUST-5 and
 *   MUST-6 are detected at `PreToolUse:Task|Agent` by `dispatch-contract-guard.js`, which fires
 *   only when a dispatch HAPPENS. MUST-3's failure is the ABSENCE of one: no PreToolUse hook on the
 *   delegation tool can fire on a call that is never made. `SubagentStop` — where the existing
 *   parallelism rider is read — is equally blind for the same reason: no subagent stops in a
 *   session that dispatched none. `Stop` fires at the end of the main agent's turn regardless, so
 *   it is the only event at which a zero-dispatch session is observable at all. Class is
 *   `lifecycle`, not `verification`: `Stop` carries no tool axis, and `hook-event-selection.md`
 *   MUST-3 FAILs a narrow class registered at an event that cannot carry a matcher.
 *
 *   The cost of choosing `Stop` is stated rather than hidden: it is LATE. It fires after the turn's
 *   serial work is already spent, so it recovers the NEXT turn, not this one. The sibling
 *   reconciler's header rejects `Stop` for the DELIVERY question on exactly that ground — and it is
 *   right to, because `SubagentStop` is available to that question. It is not available to this
 *   one. A late advisory on a session that is still running beats a gate-review finding at
 *   `/codify`, which is the only coverage MUST-3 had before this.
 *
 * ADVISORY, NEVER BLOCKING, AND THAT IS A CAP. The sub-part COUNT is structural — line-anchored
 * list markers, `dispatch-ledger.js::countDeclaredSubparts` — but the proposition ("those parts are
 * INDEPENDENT and should have gone to lanes") is judgment-bearing, so `hook-output-discipline.md`
 * MUST-2 caps the finding below `block`, and a blocking version would be wrong on its merits: the
 * detector cannot distinguish a genuinely-atomic 5-step task from a decomposable one and WILL
 * false-positive on legitimately serial work. `{continue:true}` and exit 0 on EVERY path, including
 * the timeout fallback — a Stop-family hook must never hold up shutdown.
 *
 * NO SECOND COUNT. The declared-vs-dispatched pair is read from `dispatch-ledger.js::reconcile`'s
 * existing `parallelism` rider, not re-derived here. See `lib/delegation-default.js` for why, and
 * for the CALIBRATION NOTE recording which constants are inherited, which is a boundary, and which
 * arm ships OBSERVING because its threshold is uncalibrated.
 *
 * TRI-STATE. ADVISE / OBSERVE / QUIET / UNKNOWN. An absent or unreadable ledger, or an unconfirmed
 * repo root, is UNKNOWN — never silently QUIET. UNKNOWN prints nothing (noise discipline, argued at
 * `formatDelegationAdvisory`), but it is a distinct state in the data and is pinned by a fixture.
 *
 * FAILS OPEN ON EVERY UNKNOWN, and resolves the repo root FAIL-CLOSED — reading some other tree's
 * ledger would answer a question about a different session while appearing to answer this one.
 *
 * WRITES ONE THING: a per-session dedupe marker, so a persisting shortfall is surfaced once per
 * measured pair rather than once per assistant turn. Failing to write it costs a repeated line,
 * never a suppressed finding.
 *
 * Origin: loom#1752 — MUST-3 fired again in the session immediately after the rule landed, and the
 * human had to ask twice. See `orchestrator-context-economy.md` § Origin.
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7, under the registered 5s timeout so this hook's own
// fallback fires first and shutdown is never held up.
const TIMEOUT_MS = 4000;
let fallback = null;

const path = require("path");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

function finish() {
  if (fallback) clearTimeout(fallback);
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {}
  process.exit(0);
}

/**
 * Resolve the main checkout FAIL-CLOSED, the same discipline `reconcile-dispatch-delivery.js`
 * applies: an indeterminate resolution yields UNKNOWN without reading anything, because a verdict
 * derived from a tree we could not confirm is a confident wrong answer.
 */
function requireMainCheckoutSafely(repoDir) {
  try {
    const { requireMainCheckout } = require(path.join(__dirname, "lib", "state-resolver.js"));
    return requireMainCheckout(repoDir);
  } catch (e) {
    return { ok: false, reason: `state-resolver unavailable: ${e && e.message ? e.message : String(e)}` };
  }
}

async function main() {
  fallback = setTimeout(() => {
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
    process.exit(0);
  }, TIMEOUT_MS);

  try {
    // `readStdinBounded()` resolves the PARSED payload — NOT raw text. Calling JSON.parse() on it
    // is the bug that made `dispatch-contract-guard.js` silently inert while all 42 of its library
    // fixtures stayed green; the end-to-end cases in this detector's fixture set exist so the same
    // seam cannot regress here unobserved.
    const payload = await readStdinBounded();
    const ledger = require(path.join(__dirname, "lib", "dispatch-ledger.js"));
    const lib = require(path.join(__dirname, "lib", "delegation-default.js"));

    const sessionId = (payload && payload.session_id) || "unknown-session";
    const resolved = requireMainCheckoutSafely(PROJECT_DIR);

    const read = resolved.ok
      ? ledger.readLedger({ repoDir: resolved.repoDir, sessionId })
      : {
          ok: false,
          reason:
            `the main checkout could not be resolved (${resolved.reason}), so no ledger was read — ` +
            "delegation status is UNKNOWN for this session, not clean.",
        };

    const verdict = lib.assessFromLedger(read.ok ? read.rows : null, read.ok ? undefined : read, ledger.reconcile);
    const advisory = lib.formatDelegationAdvisory(verdict);

    if (advisory) {
      const sig = lib.signatureOf(verdict);
      const seen = resolved.ok ? lib.alreadySurfaced(resolved.repoDir, sessionId, sig) : false;
      if (!seen) {
        // stderr only. A Stop-family hook's stdout carries the protocol payload; the advisory is a
        // breadcrumb, and a closed or failing stderr must never break shutdown.
        try {
          process.stderr.write(advisory + "\n");
        } catch {}
        if (resolved.ok) lib.markSurfaced(resolved.repoDir, sessionId, sig, new Date().toISOString());
      }
    }

    finish();
  } catch {
    finish();
  }
}

if (require.main === module) {
  main();
}

module.exports = {};
