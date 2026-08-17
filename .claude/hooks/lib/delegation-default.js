/**
 * delegation-default.js — the PURE decision half of the delegation-default detector
 * (`orchestrator-context-economy.md` MUST-3, loom#1752).
 *
 * THE GAP THIS CLOSES, stated exactly. MUST-5 and MUST-6 are detected by
 * `dispatch-contract-guard.js` at `PreToolUse:Task|Agent`. That surface fires only when a dispatch
 * HAPPENS. MUST-3's failure mode is the ABSENCE of a dispatch, and no PreToolUse hook on the
 * delegation tool can fire on a call that is never made. The signal therefore has to be read at a
 * surface that fires WITHOUT one, which is `Stop`.
 *
 * THE SIGNAL IS ALREADY ON DISK, AND IS ALREADY READ — AT THE WRONG SURFACE. `dispatch-ledger.js`
 * records, per session: a `declared` row per user prompt carrying `countDeclaredSubparts(prompt)`
 * (a line-anchored list-marker count, structural and deterministic — never a semantic read), and a
 * `launch` row per dispatch carrying the parent `generation`. `reconcile()` already folds those
 * into a `parallelism` rider `{declared, dispatched, shortfall}`. But its ONLY consumer is
 * `reconcile-dispatch-delivery.js` at `SubagentStop` — a lifecycle event that fires when a SUBAGENT
 * stops. In the session where the orchestrator dispatched NOTHING, no subagent ever stops, so the
 * rider that would have named the shortfall never runs. The zero-dispatch case — the exact case
 * MUST-3 exists for — is the one case the existing reader structurally cannot see.
 *
 * SO THIS MODULE ADDS NO SECOND COUNT. It consumes `reconcile().parallelism` verbatim
 * (`assessFromLedger` below) rather than re-deriving declared/dispatched from the rows. Two
 * implementations of one count drift, and the drift would be silent: both would keep exiting 0.
 *
 * ─── CALIBRATION NOTE (loom#1752 acceptance: "the thresholds and how they were chosen") ────────
 *
 * There are exactly two constants, and NEITHER is a tuned threshold. That is deliberate: no real
 * transcript corpus was available to this lane (`.claude/learning/dispatch-reconcile/` is
 * gitignored and empty in a fresh worktree), and a fabricated N presented as calibrated is worse
 * than an honest observing-mode detector.
 *
 *   FLOOR = 2 (declared sub-parts). NOT NEW, and not chosen here. It is the floor already shipped
 *     in `dispatch-ledger.js::reconcile`'s parallelism rider (`declared >= 2 && dispatched <
 *     declared`, landed 2026-08-14 with T1). Reused verbatim so the two readers of one signal
 *     cannot disagree about when it is live. `assertFloorMatchesReconciler()` below pins that
 *     equality against the reconciler's OWN behaviour, so a future edit to either side reds a
 *     fixture instead of silently splitting the contract.
 *
 *   ZERO (dispatches). Not a tuned N. It is the total-absence boundary MUST-3 names in words —
 *     "waiting to be told to parallelize is BLOCKED" — and a boundary has no free parameter to get
 *     wrong. `declared >= 2 && dispatched === 0` is the ONLY arm that advises.
 *
 *   UNCALIBRATED, AND SHIPPED OBSERVING: the PARTIAL-shortfall ratio. Declared 5, dispatched 1 may
 *     be correct decomposition or may be four sub-parts run serially. Nothing here knows which, so
 *     that arm returns OBSERVE: it emits the measured pair and explicitly gives no advice.
 *     TO CALIBRATE IT: collect `.claude/learning/dispatch-reconcile/*.jsonl` across >=30 real
 *     sessions; for each `declared` row take (declared, dispatched-after-it) from
 *     `reconcile().parallelism`; hand-label a sample for whether the un-dispatched sub-parts were
 *     genuinely INDEPENDENT; then pick the dispatched/declared ratio at which precision clears
 *     ~0.8 and promote that arm from OBSERVE to ADVISE. Until that measurement exists this module
 *     MUST NOT invent the ratio.
 *
 * INPUTS DELIBERATELY REJECTED, recorded because loom#1752 names them as candidates and an
 * unexplained omission reads as an oversight:
 *
 *   - open-PR count, unlanded-branch count, `phase2-deferrals.json` open count (115). All three are
 *     AMBIENT repo state: near-constant within a session and across sessions. A predicate keyed on
 *     them is true in every session including every compliant one, so it could never stay quiet —
 *     a non-discriminating instrument in `instrument-discipline.md` MUST-1's sense, and its output
 *     would carry zero information about THIS session's delegation behaviour. `declared_subparts`
 *     is per-prompt and varies, which is exactly why it discriminates.
 *
 *   - "elapsed orchestrator tool calls since the last dispatch". No sink records it. MEASURED, not
 *     assumed: `provenance-capture-tool.js::classify` returns non-null only for delegation tools,
 *     write tools, journal-decision writes, and SHELL_TOOLS — Read/Grep/Glob produce no record at
 *     all, and those are precisely the serial-exploration calls the failure mode consists of. A new
 *     PostToolUse `*` sink would pay a node spawn on every tool call to buy it. Separately, the
 *     provenance ledger is a signed governance surface whose field semantics are fixed by its
 *     producer; reading it for a throughput advisory is the `instrument-discipline.md` MUST-4
 *     wrong-question shape.
 *
 * HONEST BOUNDS — the same three loom#1752 states, restated where the code is:
 *   1. It cannot know a task is genuinely ATOMIC, so it WILL false-positive on legitimately serial
 *      work (a 5-item checklist whose items are strictly sequential). Advisory severity is what
 *      makes that acceptable; a blocking version would be wrong and is unavailable anyway —
 *      "are these parts independent" is judgment-bearing, and `hook-output-discipline.md` MUST-2
 *      caps a judgment-bearing finding below `block`.
 *   2. It detects IDLE-SERIALISM, not BAD delegation. A session that dispatches five useless lanes
 *      passes it cleanly.
 *   3. It sees only what the ledger recorded. A prompt that decomposes into five parts in PROSE,
 *      with no list markers, counts 0 and the detector stays quiet. Under-counting is the chosen
 *      direction: a missed advisory costs one nudge, a false one costs trust in every later nudge.
 *
 * TRI-STATE, NEVER A BOOLEAN. ADVISE / OBSERVE / QUIET / UNKNOWN. A missing or unreadable ledger is
 * UNKNOWN and says so — reporting QUIET from a ledger that was never read would be identical output
 * whether the session delegated perfectly or not at all.
 *
 * Origin: loom#1752, closing the surface gap `orchestrator-context-economy.md` § Wiring recorded
 * ("MUST-1..4 are review-layer only").
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { appendSinkLine } = require("./append-sink.js");

/**
 * The declared-sub-part floor. INHERITED from `dispatch-ledger.js::reconcile`, not chosen here.
 * `assertFloorMatchesReconciler` pins the equality; see the calibration note.
 */
const DECLARED_FLOOR = 2;

/** Verdict vocabulary. Closed — an unrecognized state is a bug, never a guess. */
const STATES = Object.freeze(["ADVISE", "OBSERVE", "QUIET", "UNKNOWN"]);

/** Cap on the marker file read, so a runaway sink cannot turn a shutdown hook into an OOM. */
const MAX_MARKER_BYTES = 256 * 1024;

function _isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

/**
 * The core predicate. Takes the reconciler's `parallelism` rider and returns a verdict.
 *
 * Pure: no IO, no clock, no rows-walking. Every arm below is a fixture case.
 *
 * @param {{declared:number,dispatched:number}|null} parallelism
 * @param {{reason?:string}} [failure] typed reason when the ledger read failed
 * @returns {{state:string,declared:number|null,dispatched:number|null,reason:string|null}}
 */
function assessDelegationDefault(parallelism, failure) {
  if (!parallelism || typeof parallelism !== "object") {
    return {
      state: "UNKNOWN",
      declared: null,
      dispatched: null,
      reason:
        (failure && failure.reason) ||
        "no prompt-declaration row was recorded for this session, so the number of declared " +
          "sub-parts is UNKNOWN. This is NOT a clean result — it does not mean the session " +
          "delegated correctly.",
    };
  }
  const declared = Number.isInteger(parallelism.declared) ? parallelism.declared : null;
  const dispatched = Number.isInteger(parallelism.dispatched) ? parallelism.dispatched : null;
  if (declared === null || dispatched === null) {
    return {
      state: "UNKNOWN",
      declared,
      dispatched,
      reason:
        "the parallelism rider carried a non-integer declared/dispatched pair, so no comparison " +
        "is possible. UNKNOWN, not clean.",
    };
  }
  if (declared < DECLARED_FLOOR) {
    return {
      state: "QUIET",
      declared,
      dispatched,
      reason: `the last prompt declared ${declared} enumerated sub-part(s), below the ${DECLARED_FLOOR} floor — nothing to decompose.`,
    };
  }
  if (dispatched >= declared) {
    return {
      state: "QUIET",
      declared,
      dispatched,
      reason: `${dispatched} lane(s) dispatched against ${declared} declared sub-part(s) — the default held.`,
    };
  }
  if (dispatched === 0) {
    return {
      state: "ADVISE",
      declared,
      dispatched,
      reason: `${declared} sub-parts declared, ZERO lanes dispatched.`,
    };
  }
  return {
    state: "OBSERVE",
    declared,
    dispatched,
    reason: `${declared} sub-parts declared, ${dispatched} lane(s) dispatched — a PARTIAL shortfall, whose threshold is uncalibrated.`,
  };
}

/**
 * Assess from ledger rows, reusing the reconciler's OWN count. `reconcileFn` is injected so the
 * fixtures can drive this seam without a ledger on disk, and so the coupling to
 * `dispatch-ledger.js::reconcile` is explicit rather than a hidden require.
 *
 * @param {object[]|null} rows
 * @param {{reason?:string}} [failure]
 * @param {(rows:object[]|null, failure?:object)=>object} reconcileFn
 */
function assessFromLedger(rows, failure, reconcileFn) {
  if (typeof reconcileFn !== "function")
    return assessDelegationDefault(null, { reason: "no reconciler was available to read the ledger." });
  let verdict;
  try {
    verdict = reconcileFn(Array.isArray(rows) ? rows : null, failure);
  } catch (e) {
    return assessDelegationDefault(null, {
      reason: `the ledger reconciler threw (${e && e.message ? e.message : String(e)}), so delegation status is UNKNOWN.`,
    });
  }
  return assessDelegationDefault(verdict && verdict.parallelism, failure);
}

/**
 * Pin DECLARED_FLOOR against the reconciler's actual behaviour rather than against its source text.
 * Drives `reconcileFn` at both poles of the floor and reports whether they agree with this module.
 *
 * Exported so the audit fixtures assert the COUPLING, not a restated constant: a fixture that only
 * checked `DECLARED_FLOOR === 2` would stay green while the reconciler moved to 3.
 *
 * @returns {{ok:boolean, detail:string}}
 */
function assertFloorMatchesReconciler(reconcileFn) {
  const rowsFor = (declared, dispatched) => {
    const rows = [{ kind: "declared", declared_subparts: declared, generation: "(main-agent)" }];
    for (let i = 0; i < dispatched; i++)
      rows.push({ kind: "launch", launch_id: `L${i}`, generation: "(main-agent)", dispatch_name: `lane-${i}` });
    return rows;
  };
  try {
    const below = reconcileFn(rowsFor(DECLARED_FLOOR - 1, 0)).parallelism;
    const at = reconcileFn(rowsFor(DECLARED_FLOOR, 0)).parallelism;
    const belowQuiet = below && below.shortfall === 0;
    const atLive = at && at.shortfall > 0;
    return {
      ok: !!(belowQuiet && atLive),
      detail: `reconciler shortfall at declared=${DECLARED_FLOOR - 1}: ${below && below.shortfall}; at declared=${DECLARED_FLOOR}: ${at && at.shortfall}`,
    };
  } catch (e) {
    return { ok: false, detail: `reconciler threw: ${e && e.message ? e.message : String(e)}` };
  }
}

/**
 * Render a verdict as ONE advisory block, or null when there is nothing to say.
 *
 * QUIET and UNKNOWN both render null. UNKNOWN rendering null is a NOISE decision, not a claim of
 * cleanliness: on a fresh clone, in CI, and in every session before the first prompt row lands the
 * state is UNKNOWN, and a shutdown line saying so on every one of them is the noise that teaches an
 * orchestrator to skip past this hook's output. The state is still distinct in the returned data
 * and is pinned by a fixture, so a caller that wants it can read it.
 */
function formatDelegationAdvisory(verdict) {
  if (!verdict || typeof verdict !== "object") return null;
  if (verdict.state === "ADVISE")
    return (
      `[delegation-default] the last prompt declared ${verdict.declared} enumerated sub-parts and ZERO lanes were ` +
      "dispatched for it. `orchestrator-context-economy.md` MUST-3 — delegation is the DEFAULT, not an " +
      'escalation the human requests; a human asking "why aren\'t you using lanes?" is evidence the default ' +
      "already failed. Dispatch the independent sub-parts now, or state why they are not independent. " +
      "ADVISORY, never a block: the sub-part COUNT is structural, but whether those parts are INDEPENDENT " +
      "is judgment-bearing, so `hook-output-discipline.md` MUST-2 caps this below `block`. It cannot tell a " +
      "genuinely-atomic task from a decomposable one and will false-positive on legitimately serial work."
    );
  if (verdict.state === "OBSERVE")
    return (
      `[delegation-default] OBSERVING, NOT ADVISING: the last prompt declared ${verdict.declared} sub-parts and ` +
      `${verdict.dispatched} lane(s) were dispatched for it. The ratio at which a PARTIAL shortfall becomes a ` +
      "finding is UNCALIBRATED — see the calibration note in `.claude/hooks/lib/delegation-default.js`. This " +
      "line is a measurement recorded so that ratio can be calibrated later; it is not a verdict and must not " +
      "be acted on as one."
    );
  return null;
}

/**
 * A stable dedupe signature. `Stop` fires at the end of EVERY assistant turn, so an un-deduped
 * advisory would repeat verbatim for as many turns as the shortfall persists — the noisy-detector
 * failure `hook-output-discipline.md` § MUST NOT names. Keyed on the measured pair so that a
 * CHANGED pair (one more lane dispatched, a new prompt) speaks again.
 */
function signatureOf(verdict) {
  if (!verdict || typeof verdict !== "object") return "";
  return `${verdict.state}:${verdict.declared}:${verdict.dispatched}`;
}

/** Per-session dedupe marker. Mirrors `dispatch-ledger.js::_sinkPath`'s injective mapping. */
function markerPath(repoDir, session) {
  const crypto = require("node:crypto");
  const raw = _isNonEmptyString(session) && session.trim().length > 0 ? session : "unknown-session";
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  const suffix = crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  return path.join(repoDir, ".claude", "learning", "delegation-default", `${safe}-${suffix}.jsonl`);
}

/**
 * Has this exact signature already been surfaced this session?
 *
 * FAILS OPEN — an unreadable or absent marker returns false, so the advisory is emitted. The
 * failure direction is deliberate and is the opposite of the ledger's: a lost dedupe costs one
 * repeated line, a wrongly-suppressed advisory costs the whole finding.
 */
function alreadySurfaced(repoDir, session, sig) {
  if (!sig) return false;
  try {
    const p = markerPath(repoDir, session);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_MARKER_BYTES) return false;
    return fs
      .readFileSync(p, "utf8")
      .split("\n")
      .some((l) => {
        if (l.trim() === "") return false;
        try {
          return JSON.parse(l).sig === sig;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

/** Record that a signature was surfaced. Best-effort; never throws, never blocks shutdown. */
function markSurfaced(repoDir, session, sig, nowIso) {
  if (!sig) return { ok: false, error: "empty signature" };
  try {
    return appendSinkLine({
      repoDir,
      sinkPath: markerPath(repoDir, session),
      line: JSON.stringify({ sig, ts: nowIso || new Date().toISOString() }),
    });
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = {
  DECLARED_FLOOR,
  STATES,
  MAX_MARKER_BYTES,
  assessDelegationDefault,
  assessFromLedger,
  assertFloorMatchesReconciler,
  formatDelegationAdvisory,
  signatureOf,
  markerPath,
  alreadySurfaced,
  markSurfaced,
};
