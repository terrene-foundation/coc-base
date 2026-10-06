#!/usr/bin/env node
/**
 * reconcile-dispatch-delivery.js — the RECONCILER half of the dispatch↔delivery stream (T1).
 *
 * Reads the per-session dispatch ledger `emit-dispatch-ledger.js` writes and reports, per dispatch
 * generation, which launched lanes have NOT called `SendMessage` — i.e. whose output is invisible
 * to the orchestrator. Also carries the parallelism rider: declared sub-parts vs lanes actually
 * dispatched for the last prompt.
 *
 * @hook-event: SubagentStop (lifecycle) — the subagent boundary IS the subject. The ledger rows
 *   this reads are on disk by the time a lane stops, and this is the LAST moment before the
 *   orchestrator concludes the lane returned nothing. `Stop` is too late: it fires after the main
 *   agent has already redone the work serially, which is the loss this exists to prevent. Class is
 *   `lifecycle`, not `verification`: `SubagentStop` carries no tool axis, and
 *   `hook-event-selection.md` MUST-3 FAILs a narrow class at an event that cannot carry a matcher.
 *
 * ADVISORY, NEVER BLOCKING. Whether a lane SHOULD have delivered is judgment-bearing — a lane may
 * legitimately stop without a message — so per `hook-output-discipline.md` MUST-2 this carries no
 * `block`. `{continue:true}` and exit 0 on EVERY path including the timeout fallback: a shutdown
 * hook must never block shutdown, the contract `stop.js` states in its own header.
 *
 * TRI-STATE, NEVER A BOOLEAN. The ledger is gitignored, so on a fresh clone, in CI, or in a session
 * whose launch hook never ran it is ABSENT. Reporting "0 undelivered" from a missing ledger would be
 * a non-discriminating instrument: identical output whether every lane delivered or none did. The
 * unresolved branch says the status is UNKNOWN and names why, the same shape
 * `lib/open-pr-surface.js` uses for a failed `gh` round-trip.
 *
 * The verdict is ALSO appended to the ledger as a `reconcile` row, so it is durable and greppable
 * rather than only a line of stderr a closing lane may never surface.
 *
 * Origin: T1, runtime-enforcement-2026-08-14.
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7, under the registered 5s timeout so this hook's own
// fallback fires first and shutdown is never held up.
const TIMEOUT_MS = 4000;
/** Held back from `TIMEOUT_MS` for the ledger read, the reconcile, the verdict append and `finish()`. */
const RESOLVE_SAFETY_MS = 600;
let fallback = null;

const path = require("path");

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

function finish() {
  if (fallback) clearTimeout(fallback);
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {}
  process.exit(0);
}

/**
 * Resolve the main checkout FAIL-CLOSED. NOT the legacy `resolveMainCheckout`, which silently
 * returns `cwd` when git could not answer — see the twin note in `emit-dispatch-ledger.js`.
 *
 * The stakes differ here and are HIGHER than for the producer. The producer would merely write to
 * the wrong place; this reader would READ SOMEONE ELSE'S LEDGER — or an empty one — from an
 * unconfirmed root and then report a verdict about THIS session's lanes. A RESOLVED verdict
 * derived from a tree we could not confirm is a confident wrong answer, which is the whole class
 * this module exists to remove. An indeterminate resolution is therefore UNRESOLVED, stated.
 *
 * `opts` carries this hook's deadline to the resolver, so its git probes cannot outrun
 * `TIMEOUT_MS`; a spent budget is UNRESOLVED like any other unconfirmed root.
 *
 * @returns {{ok: true, repoDir: string} | {ok: false, reason: string, code?: string}}
 */
function requireMainCheckoutSafely(repoDir, opts) {
  try {
    const { requireMainCheckout } = require(path.join(__dirname, "lib", "state-resolver.js"));
    return requireMainCheckout(repoDir, opts);
  } catch (e) {
    return { ok: false, reason: `state-resolver unavailable: ${e && e.message ? e.message : String(e)}` };
  }
}

async function main() {
  const startedAt = Date.now();
  // Resolved per run, not at load: the engine requires this module once per worker.
  const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  fallback = setTimeout(() => {
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
    process.exit(0);
  }, TIMEOUT_MS);

  // Engine residual (hook-engine.js header): in-process, the exit inside finish()
  // throws a sentinel, so this `catch` runs — it only calls finish() (clearTimeout +
  // output + exit), the allowed set. The verdict append sits BEFORE finish(), so no
  // ledger write can run after an exit.
  try {
    const payload = await readStdinBounded();
    const lib = require(path.join(__dirname, "lib", "dispatch-ledger.js"));

    const sessionId = payload.session_id || "unknown-session";
    const resolved = requireMainCheckoutSafely(PROJECT_DIR, {
      deadline: startedAt + TIMEOUT_MS - RESOLVE_SAFETY_MS,
    });

    // An unconfirmed root yields UNRESOLVED WITHOUT reading anything. Reading an arbitrary cwd's
    // ledger here would answer a question about a different tree while appearing to answer this
    // one — and an empty read from the wrong place is indistinguishable from a clean board.
    const read = resolved.ok
      ? lib.readLedger({ repoDir: resolved.repoDir, sessionId })
      : {
          ok: false,
          reason:
            `the main checkout could not be resolved (${resolved.reason}), so no ledger was read — ` +
            "delivery status is UNKNOWN for this session, not clean.",
        };
    const verdict = read.ok ? lib.reconcile(read.rows) : lib.reconcile(null, read);

    const advisory = lib.formatReconcileAdvisory(verdict);
    if (advisory) {
      // stderr only. A Stop-family hook's stdout carries the protocol payload; the advisory is a
      // breadcrumb, and a closed or failing stderr must never break shutdown.
      try {
        process.stderr.write(advisory + "\n");
      } catch {}
    }

    // Make the verdict DURABLE. An ephemeral stderr line at a lane's shutdown may never reach a
    // reader; a `reconcile` row is greppable afterwards and is what makes this instrument's own
    // output inspectable. Skipped when the ledger could not be read at all — writing a verdict row
    // into a sink we just failed to read would be the first row of a file whose absence IS the
    // finding.
    // `read.ok` implies `resolved.ok` — the unresolved-root branch above constructs a `read` that
    // is never ok — so the root is confirmed by the time this writes. Asserted in the condition
    // rather than left to the reader to infer.
    if (read.ok && resolved.ok) {
      const w = lib.appendRecord({
        repoDir: resolved.repoDir,
        record: lib.buildReconcileRecord({
          sessionId,
          generation: lib.generationOf(payload),
          verdict,
          nowIso: new Date().toISOString(),
        }),
      });
      if (w && w.ok === false) {
        try {
          process.stderr.write(
            `dispatch-reconcile.verdict.dropped reason=${String(w.error).slice(0, 160)}\n`,
          );
        } catch {}
      }
    }

    finish();
  } catch {
    finish();
  }
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js).
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
