/**
 * fleet-drain.js — the PURE decision half of the fleet-drain detector
 * (`wave-loop.md` MUST-6, "Never Idle-Wait While Independent In-Budget Work Is Launchable").
 *
 * ## The failure, measured on this repo
 *
 * An orchestrator dispatched work in WAVES and read each idle notification as "a result arrived"
 * rather than "a lane just freed — refill it". Lanes drained one by one and nothing recounted at
 * the boundary. Measured mid-session 2026-08-17: 100 open issues, 7 open PRs, 16 forest-ledger
 * rows, ONE lane running. Three distinct mistakes, only the first of which is detectable here:
 * no refill trigger (a COUNT); blocking confused with EXCLUSIVE (a judgment); partial refill after
 * lane deaths (a judgment). This module arms the count and claims nothing about the other two.
 *
 * `agents.md` § Parallel Execution and `wave-loop.md` MUST-6 already forbid this in prose, and
 * BOTH were loaded in the session that produced ~20 instances of it. That is the argument for a
 * mechanism rather than more prose, and it is also the argument for NOT authoring a new rule
 * alongside this detector: the contract exists and is well-drafted; what it lacked was a surface
 * that fires. So this arms MUST-6's Detection mechanism, which read "Phase 1 (manual)" only.
 *
 * ## Why `Stop`
 *
 * The failure happens at the TURN BOUNDARY — the moment the orchestrator hands back to the human
 * with an idle fleet — not at a tool call. No `PreToolUse` hook can fire on a dispatch that is
 * never made (the same argument `delegation-default.js` records for MUST-3), and `SubagentStop` is
 * blind for the sharper version of the same reason: in the drained case no subagent is running, so
 * none stops. `Stop` fires at the end of the main agent's turn regardless. Class is `lifecycle`,
 * not `guard`: `Stop` carries no tool axis, and `hook-event-selection.md` MUST-3 FAILs a narrow
 * class registered at an event that cannot carry a matcher.
 *
 * ## The severity is capped BELOW what the signal would justify, and the cap is structural
 *
 * Both counts are STRUCTURAL — set arithmetic over JSONL rows and a markdown table — so
 * `hook-output-discipline.md` MUST-2's bar on `block` from a LEXICAL signal is not what caps this.
 * The cap is the event. MEASURED, both poles, against `instruct-and-wait.js`:
 *
 *     Stop        + block           → {continue:true}  exit 0     ← STOP_LIKE branch, unconditional
 *     PreToolUse  + block           → {continue:false} exit 2     ← the control: it CAN say no
 *
 * `STOP_LIKE_EVENTS` is tested BEFORE the `severity === "block"` branch, so at `Stop` no severity
 * reaches the blocking path. `halt-and-report` is therefore the strongest available severity, and
 * it is also the right one on the merits: the intervention needed is that the orchestrator SURFACE
 * and acknowledge the count, not that its turn be denied.
 *
 * ─── INSTRUMENT A — lanes running ───────────────────────────────────────────────────────────────
 *
 * `runningLanes` = {NAMED launch `dispatch_name`} MINUS {`reconcile` row `generation`}, both from
 * the per-session `dispatch-reconcile` ledger this repo already writes.
 *
 * The join key was MEASURED, not assumed. A `reconcile` row is written by
 * `reconcile-dispatch-delivery.js` at `SubagentStop`, which fires INSIDE the stopping subagent, so
 * its `generation` — `payload.agent_id` through `dispatch-ledger.js::normalizeAgentId` — is the
 * STOPPING LANE'S OWN NAME. That is what makes a per-lane termination signal exist at all.
 *
 * KNOWN-ANSWER CONTROL (`instrument-discipline.md` MUST-3(a)), run against the live ledger of the
 * session that authored this file: launched 23, reconciled 33, and the difference resolved to
 * `s39-fleetguard` (this lane, definitively running), `s39-xread`, `shape4-scout`, `shape5-scout`.
 * FALSIFYING RESULT: had the instrument been broken, `s39-fleetguard` — a lane that provably had
 * not stopped, because it was executing the query — would have been ABSENT from the difference.
 * It was present. The instrument can distinguish running from stopped HERE.
 *
 * THE SCOPE, and it is narrow (`instrument-discipline.md` MUST-4 — this instrument answers ONE
 * question and is not read for a second): it counts NAMED lanes LAUNCHED IN THIS SESSION that have
 * not yet had a `SubagentStop`. It is NOT a count of running processes, NOT a count of addressable
 * teammates (that roster spans sessions; this ledger is per-session), and NOT an activity measure —
 * a live-but-wedged lane counts as running, correctly for the refill question and wrongly for any
 * other.
 *
 * THE MEASURED HOLE, and why this instrument can only ever be a LOWER bound. A dispatch made
 * without a `name` writes `dispatch_name: null`, so it is absent from the launched set; its
 * `reconcile` rows arrive under an unnormalizable `a<16hex>` generation that joins to nothing.
 * Measured across the 9 ledgers on this clone: unnamed launches per session 0, 0, 0, 0, 1, 2, 2, 6,
 * 22 — present in 5 of 9 — and hex-only reconcile generations OUTNUMBER them wildly (one session:
 * 22 unnamed launches against 401 distinct hex generations, i.e. ~one per event, not one per lane).
 * So the unnamed population can be neither joined NOR subtracted numerically.
 *
 * That asymmetry decides the design. The named difference is a LOWER bound on running lanes; this
 * detector fires on running being LOW, so what it needs is an UPPER bound, which is exactly what
 * the unnamed population denies it.
 *
 * UNTIL 2026-08-20 THIS MODULE RESOLVED THAT BY REFUSING: `countRunningLanes` returned `ok:false`
 * whenever `unnamed > 0`, and the whole session went UNKNOWN. That refusal was correct given ONE
 * instrument, and it cost silence in roughly 5 of 9 sessions. It is superseded — not softened — by
 * INSTRUMENT C below, which supplies the upper bound the ledger cannot. `countRunningLanes` now
 * REPORTS the unnamed count and flags `boundedAbove:false` instead of failing; `ok` here means the
 * ledger was READ, and the bound question is settled at the reconciliation step. Nothing else about
 * its scope moved.
 *
 * ─── INSTRUMENT C — background_tasks, the harness's own statement of what is running ─────────────
 *
 * The `Stop` payload carries a `background_tasks` key. It is a STRUCTURAL fact produced by the
 * harness, not a count this repo derives, and before 2026-08-20 ZERO hooks in this corpus read it
 * (`grep -rln background_tasks .claude/` returned nothing, against a control: the same grep form
 * DOES find `stop_hook_active`, so the negative was real and not a broken matcher).
 *
 * ITS SHAPE WAS MEASURED, NEVER INFERRED FROM THE NAME. An isolated throwaway sandbox
 * (`/tmp/bgtasks-probe`, a `Stop` + `SubagentStop` hook that dumps the raw value, driven by
 * `claude -p --permission-mode bypassPermissions`) produced these four conditions, verbatim:
 *
 *   A  nothing running                  Stop          `[]`                              len 0
 *   B  background SHELL running         Stop          `[{id, type:"shell",    status:"running",
 *                                                        description, command}]`        len 1
 *   C  background SUBAGENT running      Stop          `[{id, type:"subagent", status:"running",
 *                                                        description, agent_type}]`     len 1
 *   C' same session, SubagentStop        SubagentStop  identical to C (status still "running":
 *                                                      the event fires INSIDE the stopping lane)
 *   C'' same session, after it finished  Stop          `[]`                              len 0
 *   D  background shell run to completion, then Stop → `[]`                            len 0
 *
 * (Condition D's driver prompt ran a 3s background shell and then a 12s FOREGROUND wait, so the
 * shell had certainly finished before the turn ended. That timing lives in the probe's driver
 * invocation, NOT in `fire.log`, which records no timings — cited here as the driver's parameter
 * rather than as something the log shows, because the log does not show it.)
 *
 * FOUR THINGS ARE ESTABLISHED BY THAT, AND EXACTLY FOUR:
 *   (1) it is an ARRAY, present on every `Stop` payload observed (5 of 5 fires);
 *   (2) a running SUBAGENT appears, with `type:"subagent"` — so lanes ARE visible here, which is
 *       the whole reason this instrument can bound the ledger's hole;
 *   (3) a running background SHELL also appears, under `type:"shell"` — so array LENGTH is not a
 *       lane count and must be classified by `type`, not counted raw;
 *   (4) a task that has FINISHED is ABSENT (C'', D) — it does not linger under a terminal status.
 *
 * WHAT WAS NOT ESTABLISHED IS TREATED AS UNKNOWN, not guessed:
 *   • the exhaustive `type` vocabulary. Only `"shell"` and `"subagent"` were observed. An element
 *     whose type is neither makes this instrument REFUSE (`ok:false`) rather than assume it is not
 *     a lane — assuming would be the confidently-wrong direction for a detector that fires on
 *     running being LOW. The remedy when a new type appears is to classify it here, and the refusal
 *     is what makes it visible instead of silently disarming the guard.
 *   • the `status` vocabulary. Only `"running"` was ever observed. So this instrument does NOT
 *     filter on `status`: PRESENCE in the array is occupancy. That direction is deliberate — (4)
 *     says terminal tasks are absent today, and IF a future harness lingers them under a terminal
 *     status, counting presence over-counts occupancy, which makes this detector quieter, never
 *     falsely louder.
 *   • whether a SUBAGENT'S OWN nested background tasks appear in the MAIN session's array. Not
 *     constructed, therefore UNKNOWN — and it is NOT bounded. An earlier draft of this comment
 *     bounded it with INSTRUMENT A's generation-filter argument ("while a nested lane runs, its
 *     parent runs too"), and that argument is FALSE in the one state that matters: a nested lane
 *     that OUTLIVES its parent — the detached spawn mode `agents.md` § Agent-Result-Delivery
 *     describes, which opens no return path. Constructed against this module, a nested lane whose
 *     parent has reconciled and which the harness array omits yields `ADVISE / drained` with
 *     `boundedAbove:true`, i.e. FLEET DRAINED while a lane runs, with nothing in the verdict
 *     signalling the blind spot. See § RESIDUAL RISK below; the claim is withdrawn rather than
 *     repaired, because no measurement here supports either half of it.
 *   • whether a harness that predates this key exists in the field. If `background_tasks` is
 *     ABSENT, this instrument refuses and the session is UNKNOWN. That is not a hedge, it is the
 *     same refusal INSTRUMENT A used to make alone: with no upper bound from anywhere, a
 *     drain verdict is unbounded-above and would be exactly the confident wrong answer this whole
 *     module is organised against. Measured cost on THIS harness: zero — the key was present on
 *     every payload observed.
 *
 * THE UNNAMED QUESTION, WHICH IS THE LOAD-BEARING ONE, AND IS MEASURED RATHER THAN INFERRED. The
 * probe was built to answer "does a background SUBAGENT appear here". This module reads the answer
 * for a DIFFERENT question — "does an UNNAMED lane appear here" — and that second question is the
 * only one that makes INSTRUMENT C an upper bound over INSTRUMENT A's blind spot, so
 * `instrument-discipline.md` MUST-4 requires its own falsifying result rather than a re-read. It
 * has one, from the same capture: `dispatch-ledger.js::dispatchNameOf` derives `dispatch_name` from
 * `tool_input.name` ALONE, and probe condition C dispatched with `subagent_type` and `description`
 * but NO `name` — so that lane was UNNAMED in exactly the ledger's sense, and it appeared in
 * `background_tasks` regardless. FALSIFYING RESULT: had the harness keyed its array on the same
 * field the ledger does, condition C would have produced `[]` like condition A, and INSTRUMENT C
 * would have inherited INSTRUMENT A's blind spot instead of covering it. It produced one element.
 *
 * KNOWN-ANSWER CONTROL (`instrument-discipline.md` MUST-3(a)). The captured condition-C payload —
 * one subagent that was DEFINITIVELY running, because the probe fired while it slept — must read as
 * 1 lane; the captured condition-A and condition-D payloads, in which nothing was running, must read
 * as 0. FALSIFYING RESULT: had this instrument been broken, condition C would have read 0 lanes,
 * i.e. IDENTICAL to the idle conditions, and the two states would be indistinguishable. Both poles
 * are pinned as fixtures against the VERBATIM captured payloads, so the control travels with the
 * code rather than living only in this comment.
 *
 * ─── RECONCILIATION — two instruments, and neither is preferred by faith ─────────────────────────
 *
 * A and C do NOT measure the same population, so comparing their exact COUNTS would be reading each
 * for a question it was not built for (`instrument-discipline.md` MUST-4). A counts NAMED lanes the
 * MAIN agent launched this session and that have not reconciled; C counts what the harness says is
 * running right now, named or not. They differ by construction and a difference is not a defect.
 *
 * What they BOTH answer is the one proposition this detector turns on: IS ANYTHING RUNNING. So the
 * reconciliation is on that boolean, and it is asymmetric because the instruments' errors are:
 *
 *   • ledger BOUNDED (`unnamed === 0`): its zero is a genuine claim of idleness. Any disagreement
 *     with C on the boolean is a real contradiction ⇒ UNKNOWN, in BOTH directions.
 *   • ledger UNBOUNDED (`unnamed > 0`): its zero is an ACKNOWLEDGED BLIND SPOT, not a claim. It can
 *     only under-report busy. So "ledger idle, harness busy" is EXPECTED and C is used; but "ledger
 *     busy, harness idle" is still a real contradiction ⇒ UNKNOWN.
 *
 * That is what fixes both halves of the original defect at once. The FALSE POSITIVE — ledger says
 * drained while lanes run — now hits the contradiction arm and goes UNKNOWN instead of ADVISE. The
 * COVERAGE HOLE — 5 of 9 sessions silenced by an unnamed launch — now resolves whenever C supplies
 * the upper bound the ledger lacked. Neither instrument overrides the other silently: every
 * non-agreeing state is named in the verdict data and in the rendered reason.
 *
 * ─── RESIDUAL RISK — the state BOTH instruments miss, stated because it still exists ────────────
 *
 * The reconciliation is exhaustive over the two instruments' readings: ADVISE requires BOTH to read
 * exactly zero, and every disagreement they can express routes to UNKNOWN. What it CANNOT reach is
 * a running lane that is invisible to both at once. Two such states are known and neither is closed
 * here:
 *
 *   (a) A NESTED LANE THAT OUTLIVES ITS PARENT. The ledger's launch filter is scoped to the MAIN
 *       agent's generation by design, so a subagent-spawned lane never enters `launched`; if the
 *       harness array is also session-scoped and omits it, both read zero while it runs.
 *   (b) `boundedAbove` NAMES MORE THAN IT HOLDS. It bounds ONE hole — unnamed MAIN-AGENT launches —
 *       and nothing else. A NAMED launch under a subagent generation is excluded from `launched` by
 *       the same deliberate filter and counted by nothing, yet `boundedAbove` still returns `true`,
 *       and the contradiction arm reads that as "the ledger asserts idleness". The field is
 *       correctly named for what `countRunningLanes` computes and is OVER-read by the reconciler.
 *
 * BOTH ARE THE SAME UNDERLYING STATE, and it is the one this change does NOT fix. It is narrower
 * than the defect it replaces — that one fired on any unnamed dispatch, present in 5 of 9 sessions,
 * whereas this needs a lane that outlives its parent AND is absent from the harness array, the
 * second half of which is UNMEASURED. Closing it needs a nested-lane visibility measurement this
 * lane did not construct; recording it as a bounded blind spot would be the false bound the § above
 * withdraws.
 *
 * ─── INSTRUMENT B — open work ───────────────────────────────────────────────────────────────────
 *
 * `## Outstanding ledger (forest)` rows from the committed session-notes surface. Chosen over open
 * issues / open PRs deliberately: those need a network round-trip, and this hook runs at EVERY
 * turn boundary, where a 2s `gh` call is a per-turn latency tax. The forest ledger is committed,
 * machine-readable, already gated by `.claude/bin/validate-forest-ledger.mjs`, and reads in one
 * bounded file read. The parse mirrors that validator's anchors (both the inline
 * `## Outstanding ledger (forest)` section and the whole-file `# Forest Ledger` shared form) rather
 * than inventing a second dialect.
 *
 * ─── CALIBRATION, and the arm the measurement REFUSED to justify ────────────────────────────────
 *
 * MEASURED, 30 commits of the session-notes surface, 2026-08-03 → 2026-08-16: forest rows ranged
 * 9–21, median ~16, never zero. That distribution is decisive and it is not the answer the brief
 * expected. An open-work count that sits between 9 and 21 in every session — compliant sessions
 * included — carries almost no information about THIS turn. It is precisely the AMBIENT-repo-state
 * trap `delegation-default.js` records and rejects for open-PR and unlanded-branch counts: a
 * predicate keyed on it is true nearly always, so it could never stay quiet.
 *
 * The consequence is that the brief's suggested "≥20 open items with ≤1 lane" cannot be adopted as
 * written: ≥20 held in 2 of 30 commits, so that arm would have been SILENT during the very
 * incident it was specified from, while ≥10 held in 28 of 30 and would fire always. Neither is a
 * threshold; both are a coin with the repo's mood painted on it. So:
 *
 *   OPEN WORK IS A GATE, NOT A SIGNAL. It has exactly one job — keep the detector quiet when the
 *     board is genuinely clear — and its threshold is the BOUNDARY `dispatchable >= 1`. A boundary
 *     has no free parameter to get wrong. This is also what keeps the detector from becoming
 *     pressure to invent work: at zero dispatchable rows it is silent, which is the mechanical form
 *     of `recommendation-quality.md` MUST-3 (a converged hand-to-human stop IS complete).
 *
 *   THE DISCRIMINATING VARIABLE IS THE LANE COUNT. Measured running-lane counts across the 9
 *     ledgers: 0, 0, 0, 0, 0, 0, 1, 4, 5. That one varies.
 *
 *   DRAINED (`running === 0`) SHIPS ADVISING. Zero is a boundary, not a tuned N — the same
 *     argument `delegation-default.js` makes for its own zero-dispatch arm.
 *
 *   UNDER-CAPACITY SHIPS **OBSERVING**, NOT ADVISING, and that is the honest disposition rather
 *     than a hedge. `running <= LANE_FLOOR` (default 1) held in 7 of those 9 sessions, and nothing
 *     here knows how many of the 7 were legitimately quiet — a session with one deliberately
 *     serial long-running lane looks identical. So the arm emits the measured pair and explicitly
 *     gives no advice, the disposition `delegation-default.js` took for its own uncalibrated
 *     partial-shortfall ratio.
 *     TO CALIBRATE IT: collect `.claude/learning/dispatch-reconcile/*.jsonl` across >=30 sessions
 *     with NO unnamed launches (the UNKNOWN arm excludes the rest); for each turn boundary take
 *     (running, dispatchable); hand-label whether independent in-budget work was genuinely
 *     launchable at that moment; promote to ADVISE at the lane floor where precision clears ~0.8.
 *     Until that measurement exists this module MUST NOT invent the number.
 *
 * `LANE_FLOOR` is configurable (`COC_FLEET_LANE_FLOOR`) rather than magic, and the whole detector
 * has a kill switch (`COC_FLEET_DRAIN` = `0`/`off`/`false`), the shape `worktree-forest.js` uses.
 *
 * ─── WHAT THIS CANNOT DO, stated because a guard that fires while the orchestrator is CORRECTLY
 *     waiting for a person trains people to ignore it ─────────────────────────────────────────────
 *
 * There is NO structural signal at `Stop` for "the orchestrator is correctly blocked on a human
 * decision". The payload carries `session_id`, `transcript_path`, `stop_hook_active` and nothing
 * about intent, and inferring it from prose would be the semantic read hooks are barred from. So
 * this module does NOT claim to detect it. What it ships instead is an OPT-IN suppression an
 * operator can write into the surface they already maintain: a forest row whose status carries a
 * blocked-on-human marker is not counted as dispatchable, and a board where every row is so marked
 * goes QUIET. That is an affordance, not a detection claim, and until rows carry the marker this
 * detector WILL speak on a turn that is correctly waiting. Three things bound the cost: the
 * severity cannot block, the per-signature dedupe means a persisting state is surfaced once rather
 * than every turn, and the kill switch exists. THE 2026-08-20 INSTRUMENT CHANGE MOVED NONE OF THOSE
 * THREE. This module stays non-refusing; converting it to refuse is a separate, later, gated step
 * and is deliberately not attempted here.
 *
 * TRI-STATE, NEVER A BOOLEAN. ADVISE / OBSERVE / QUIET / UNKNOWN. An absent, unreadable, or
 * unnamed-contaminated ledger is UNKNOWN and says so. Reporting QUIET from a ledger never read
 * would be identical output whether the fleet was saturated or empty — the non-discriminating
 * instrument `instrument-discipline.md` MUST-1 forbids citing.
 *
 * FAILS OPEN on every error path (`cc-artifacts.md` Rule 7): every function returns a result
 * object and NOTHING throws.
 *
 * Origin: session 39, 2026-08-17 — measured 100 open issues / 7 open PRs / 16 forest rows against
 * ONE running lane, with `wave-loop.md` MUST-6 loaded throughout.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { appendSinkLine, readSinkFile } = require("./append-sink.js");

/**
 * The main-agent generation sentinel. IMPORTED from the producer, never restated. A local copy of
 * `"(main-agent)"` would keep matching until the producer changed its sentinel, at which point the
 * launch filter would select NOTHING and this detector would report a permanently drained fleet —
 * a silent, confidently-wrong flip in the firing direction. `assertMainGenerationMatchesProducer`
 * pins the coupling so an edit to either side reds a fixture.
 */
const { MAIN_GENERATION } = require("./dispatch-ledger.js");

/** Verdict vocabulary. Closed — an unrecognized state is a bug, never a guess. */
const STATES = Object.freeze(["ADVISE", "OBSERVE", "QUIET", "UNKNOWN"]);

/**
 * The under-capacity lane floor. UNCALIBRATED — see the calibration note. It is the reason that
 * arm ships OBSERVING rather than advising, and it is env-overridable so a deployment can tune it
 * without editing a constant into a fork.
 */
const DEFAULT_LANE_FLOOR = 1;

/**
 * The dispatchable-work floor. A BOUNDARY, not a tuned N: below it there is nothing to refill
 * with, and the detector's silence there IS the clean-converged-stop contract
 * (`recommendation-quality.md` MUST-3).
 */
const DISPATCHABLE_FLOOR = 1;

/** Cap on the marker file read, so a runaway sink cannot turn a shutdown hook into an OOM. */
const MAX_MARKER_BYTES = 256 * 1024;

/** Cap on a notes file read when `session-notes-layout.js` is unavailable to supply its own. */
const FALLBACK_NOTES_CAP_BYTES = 2 * 1024 * 1024;

/** Most lanes/rows named in one advisory line, so a large board cannot produce a wall of text. */
const MAX_NAMED = 8;

/**
 * The blocked-on-human suppression marker. Matched against a forest row's WHOLE line so it works
 * in the status cell or anywhere else the operator finds natural to write it.
 *
 * DELIBERATELY LITERAL AND NARROW. A loose pattern (`/blocked/i`) would swallow the ordinary
 * status prose this surface is full of — measured on the live ledger, rows read "3 BUILD blocked,
 * 3 distinct causes" and "un-hermetic PATH fallthrough", which are blocked on WORK, not on a
 * person. Silencing those would make the gate inert exactly when the board is busiest.
 */
const HUMAN_BLOCKED_RE = /\b(?:blocked[-\s]on[-\s]human|awaiting[-\s]human|human[-\s]gated|needs[-\s]human[-\s]decision)\b/i;

// ── forest-ledger anchors ─────────────────────────────────────────────────────────────────────
//
// MIRRORED BY HAND from `.claude/bin/validate-forest-ledger.mjs`, which is an ESM CLI with no exports
// and therefore not requirable from a CJS hook. Restating the anchors is the lesser of two evils
// against re-inventing a second dialect for one surface. NOTHING PINS THE MIRROR: when that
// validator's section boundary moved, no fixture here went red (review-cor-r9-F6), so a change to
// its heading, section-end, fence or line-ending rules MUST be copied here by hand. Kept in step:
// the ledger heading may be indented up to three spaces; the INLINE section ends at an UNINDENTED
// `## ` heading with text only (the validator refuses an indented or empty one); every line ending (LF, CRLF, bare CR) splits a
// line; a line-start code span (```x```) is not a fence; a fence closes only on the same
// marker at least as long; the whole-file SHARED form runs to EOF (case 13), as the validator's
// now does. What this does NOT mirror: the validator's refusals (grammar, malformed rows, headings
// inside the shared form) — this parse only COUNTS open work for an advisory, and the validator
// is the gate.
const HEADING_RE = /^ {0,3}##[ \t]+Outstanding ledger \(forest\)\s*$/i;
const SHARED_HEADING_RE = /^ {0,3}#[ \t]+Forest Ledger\b/i;
const NEXT_SECTION_RE = /^##[ \t]+[^ \t]/;
const FENCE_RE = /^\s*(```+|~~~+)(.*)$/;

/** The fence run a line opens or closes, or null — never a line-start code span, whose info string holds a backtick. */
function _fenceRun(line) {
  const m = line.match(FENCE_RE);
  if (m === null || (m[1][0] === "`" && m[2].includes("`"))) return null;
  return m[1];
}
const EMPTY_FOREST_RE = /^\s*forest empty\b/im;

function _isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

/**
 * Extract a message from a thrown value WITHOUT trusting it.
 *
 * The reflex `e && e.message ? e.message : String(e)` reads a property and coerces to string, and
 * BOTH are throw sites: a hostile `message` getter, or a throwing `toString`. A catch block that
 * can itself throw is not a catch block, and this module's whole contract is that nothing escapes
 * (`cc-artifacts.md` Rule 7). Every failure here degrades to a constant.
 */
function _safeErrMessage(e) {
  try {
    const m = e && e.message;
    if (typeof m === "string" && m.length > 0) return m.slice(0, 200);
  } catch {
    return "<unreadable error>";
  }
  try {
    return String(e).slice(0, 200);
  } catch {
    return "<unstringifiable error>";
  }
}

/**
 * Resolve the under-capacity lane floor. Fails to the default on anything unparseable or negative
 * — a malformed env var must not silently disarm or over-arm the arm it configures.
 * @param {object} [env]
 * @returns {number}
 */
function resolveLaneFloor(env) {
  const e = env || process.env;
  const raw = e.COC_FLEET_LANE_FLOOR;
  if (!_isNonEmptyString(raw)) return DEFAULT_LANE_FLOOR;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_LANE_FLOOR;
  return n;
}

/**
 * The kill switch. DEFAULT-ON: absence enables the detector, so a deployment that never heard of
 * it still gets the coverage. Only the explicit off-tokens disable it.
 * @param {object} [env]
 * @returns {boolean}
 */
function resolveEnabled(env) {
  const e = env || process.env;
  const raw = e.COC_FLEET_DRAIN;
  if (!_isNonEmptyString(raw)) return true;
  return !/^(?:0|off|false|no)$/i.test(raw.trim());
}

// ── INSTRUMENT A — lanes running ──────────────────────────────────────────────────────────────

/**
 * Count the NAMED lanes THE MAIN AGENT launched this session that have not yet had a
 * `SubagentStop`.
 *
 * SCOPED TO THE MAIN AGENT'S OWN FLEET, and the scope is the event's, not a convenience. `Stop`
 * is the MAIN agent's turn boundary; the refill decision belongs to the main agent; and a nested
 * lane that some subagent spawned is that subagent's business — while it runs, its parent is
 * running too, so it is already represented in the count through its parent.
 *
 * It also RECOVERS most of the coverage the unnamed-launch hole costs, which is why the
 * measurement is recorded rather than the narrowing merely asserted. Across the 9 ledgers on this
 * clone, unnamed launches attributable to the MAIN agent versus to any generation:
 *
 *     main-agent unnamed  0, 0, 0, 0, 0, 0, 0, 6, 18   → contaminated in 2 of 9 sessions
 *     any-generation      0, 0, 0, 0, 1, 2, 2, 6, 22   → contaminated in 5 of 9 sessions
 *
 * So the measurable population rises from 4 of 9 sessions to 7 of 9, and the session that authored
 * this file moves from UNKNOWN to measurable (23 named main-agent launches, 0 unnamed; its 2
 * unnamed launches were dispatched by a subagent). The narrowing is a scope correction that
 * happens to pay, not a threshold tuned to make a number look good.
 *
 * Pure: takes ledger rows, returns plain data. No IO, no clock.
 *
 * ## ONE ROOT CAUSE, TWO DEFECTS: SET SEMANTICS WHERE MULTIPLICITY IS THE WHOLE QUESTION
 *
 * The first cut of this function reduced both readings to NAME SETS — `launched` and `terminated`
 * were `Set`s of names and everything downstream read `.size`. A name set cannot represent a lane
 * that ran, stopped, and ran AGAIN under the same name, which is not an exotic shape: it is a
 * repeated review loop (`correctness` + `security` each round) and it is `agents.md` § RECOVERY's
 * resume-a-lane-under-its-original-name path. `dispatch-ledger.js` § "KNOWN RESIDUAL" already
 * records same-(generation, name) reuse as live. Two defects fell out of that one choice, MEASURED
 * on this repo 2026-08-20:
 *
 *   OCCUPANCY WAS WRONG.  `running` was {launched names} \ {terminated names}. Relaunch `alpha`
 *     after it stopped and `alpha` sits in BOTH sets, so it is subtracted away: the detector
 *     reported `running: 0` WHILE `alpha` WAS RUNNING, and would advise "0 lanes, refill now" into
 *     a live fleet. That is a wrong answer about the world, not merely a dedupe fault.
 *
 *   THE EPOCH WAS FROZEN.  `signatureOf` keys the per-session dedupe on `launched`/`terminated`
 *     precisely so a NEW drain is not suppressed as a repeat of an old one. Refill using only names
 *     already in both sets and NEITHER cardinality moves — so the second drain's signature is
 *     byte-identical to the one already marked and is suppressed for the rest of the session. The
 *     detector goes permanently silent on exactly the recurring-wave workflow it is most valuable
 *     on.
 *
 * ## The fix, in two halves that must not be conflated
 *
 *   `launched` / `terminated`  — the FLEET EPOCH, as ROW COUNTS. Every launch row and every
 *                                reconcile row advances them, whether or not the name is new, so a
 *                                reused name still moves the epoch. Rows are append-only and
 *                                per-session, so the pair is still monotonic and is unchanged
 *                                exactly when nothing happened. This half is unchanged and is what
 *                                fixed the frozen epoch.
 *   `running`                   — names whose LAST row in the ledger is a launch. ORDER-AWARE
 *                                LAST-WRITE-WINS, not a balance. See below.
 *
 * ## Why occupancy is LAST-WRITE-WINS and NOT a launch-minus-stop balance
 *
 * The first attempt at this fix made occupancy a per-name BALANCE (launch rows minus reconcile
 * rows, positive ⇒ live). That is ORDER-INSENSITIVE, and order is the entire question. MEASURED
 * 2026-08-20, the two sequences a balance CANNOT tell apart:
 *
 *     launch a, launch a, stop a   balance 1 ⇒ "live"   TRUTH: DEAD — the first launch row never
 *                                                       produced a lane, the second did and stopped
 *     launch a, stop a, launch a   balance 1 ⇒ "live"   TRUTH: LIVE — relaunched after stopping
 *
 * The first shape is not hypothetical. `emit-dispatch-ledger.js` writes the launch row at
 * `PreToolUse` — BEFORE the dispatch runs — while `dispatch-contract-guard.js` refuses on the SAME
 * matcher, so a REFUSED dispatch leaves a launch row behind with no lane and no reconcile row to
 * ever balance it. Relaunch under the same name (the `agents.md` § RECOVERY workflow this whole fix
 * exists to serve) and the balance sticks permanently above zero: a PHANTOM lane, `OBSERVE` instead
 * of `ADVISE`, silence for the rest of the session. That is a REGRESSION against the name-set
 * difference this replaced, which returned `[]` there and correctly advised.
 *
 * LAST-WRITE-WINS is licensed by the design's own premise, not by convenience: the name IS the
 * `SendMessage` address (`dispatch-ledger.js` header), so at most ONE lane per name can be live at
 * a time. With multiplicity ruled out, the last row for a name is the most recent thing known about
 * it, and it DECIDES — a sum over rows answers a question ("how many net launches") nobody asked.
 * It also collapses the balance's phantom class by construction: an unbalanced launch row is
 * overwritten by the next stop for that name, whatever the counts.
 *
 * WHAT IT STILL CANNOT DO, and the direction it fails in. A MISSED reconcile row (a `SubagentStop`
 * hook that times out and fails open) leaves the name's last row a launch, so a dead lane reads as
 * live and the detector goes quiet rather than advising. No signal exists here to do better — a
 * lane that never wrote a stop row is indistinguishable from one still running. But the loss does
 * NOT ACCUMULATE, which is the balance's separate defect: ONE recorded stop for that name clears
 * it, where a balance inflated by two missed stops needs two extra recorded stops. And `running`
 * counts DISTINCT NAMES, so N missed stops on ONE name read as one lane, never N — the
 * `running > laneFloor` saturation-silence a balance could reach on a single name is unreachable
 * here. On this axis LWW is equal to the balance at one missed stop and strictly better after.
 *
 * ## `ok` IS NOT `boundedAbove` — the third field, and why the unnamed refusal is gone
 *
 * `ok` MEANS "THE LEDGER WAS READ", NOT "THE COUNT IS BOUNDED ABOVE". Those were the same thing
 * while this was the only instrument, and conflating them is what made an unnamed launch silence
 * the whole session. They are now separate fields: `running` is the NAMED difference — a LOWER
 * bound, always — and `boundedAbove` says whether that lower bound is also an upper one. The upper
 * bound comes from INSTRUMENT C, and `assessFleetDrain` is where the two are reconciled.
 *
 * THE TWO HALVES ARE ORTHOGONAL AND BOTH ARE LOAD-BEARING. The epoch/occupancy split above is about
 * MULTIPLICITY (a name that runs, stops and runs again); this one is about the UNNAMED population (a
 * launch row that carries no name at all). Neither subsumes the other: row counts make the epoch
 * move for a reused name, and `boundedAbove` is what lets INSTRUMENT C cover the hole the names
 * never entered. Collapsing either back into `ok` reintroduces a measured silence.
 *
 * @param {object[]|null} rows  `dispatch-ledger.js::readLedger().rows`
 * @param {{reason?:string}} [failure] typed reason when the read failed
 * @returns {{ok:boolean, running:string[]|null, launched:number|null, terminated:number|null,
 *            unnamed:number|null, boundedAbove:boolean, reason:string|null}}
 *   `launched`/`terminated` are ROW counts (the epoch); `running` names the lanes whose LAST ledger
 *   row is a launch (occupancy); `boundedAbove` says whether that occupancy reading is also an UPPER
 *   bound (it is not, once an unnamed main-agent launch is present). All are `null` on an unmeasured
 *   reading — never a fabricated 0.
 */
function countRunningLanes(rows, failure) {
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      running: null,
      launched: null,
      terminated: null,
      unnamed: null,
      boundedAbove: false,
      reason:
        (failure && failure.reason) ||
        "no dispatch-ledger rows were readable, so the running-lane count is UNKNOWN — not zero.",
    };
  }

  // OCCUPANCY — ORDER-AWARE LAST-WRITE-WINS, one entry per name. The ledger is append-only and
  // read in append order, so the LAST row mentioning a name is the most recent thing known about
  // it, and that is its state. Never a sum: see the block above.
  const lastRow = new Map();
  // EPOCH — ROW counts, so a REUSED lane name still moves them. See the note above.
  let launchedRows = 0;
  let terminatedRows = 0;
  let unnamed = 0;

  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    if (r.kind === "launch") {
      // The `generation` on a LAUNCH row is the PARENT of the dispatched lane, so this selects
      // the lanes the MAIN agent itself dispatched.
      if (r.generation !== MAIN_GENERATION) continue;
      if (_isNonEmptyString(r.dispatch_name)) {
        lastRow.set(r.dispatch_name, "launch");
        launchedRows++;
      } else unnamed++;
    } else if (r.kind === "reconcile") {
      // NOT generation-filtered, and deliberately so: the `generation` on a RECONCILE row is the
      // STOPPING LANE'S OWN name, not its parent's. Filtering it to `(main-agent)` would discard
      // every real termination signal and report the whole fleet as permanently running.
      //
      // A stop for a name the MAIN agent never launched (a nested lane) records `"stop"` and so
      // never enters `running`. It is kept in the map rather than skipped so that a LATER main
      // launch under that name still wins the slot — the sequence a refused-then-retried dispatch
      // actually produces.
      if (_isNonEmptyString(r.generation)) {
        lastRow.set(r.generation, "stop");
        terminatedRows++;
      }
    }
  }

  // OCCUPANCY, computed ONCE and BEFORE the unnamed branch — order-aware last-write-wins over
  // `lastRow`. It is hoisted above that branch because, since 2026-08-20, the unnamed branch no
  // longer refuses: it returns this SAME occupancy reading flagged as a lower bound only. Leaving
  // the computation below the branch is what forced the old `running: null` refusal.
  const running = [];
  for (const [name, state] of lastRow) {
    if (state === "launch") running.push(name);
  }
  running.sort();

  // THE UPPER-BOUND DECLARATION (was a refusal until 2026-08-20). An unnamed launch is unjoinable
  // in both directions (see the header): it never enters `lastRow`, and its reconcile rows arrive
  // under a hex generation that matches nothing. So the LWW reading stays a valid LOWER bound and is
  // NOT an upper one. This function no longer decides what to do about that — it REPORTS it, and
  // `assessFleetDrain` reconciles it against INSTRUMENT C, which can supply the upper bound.
  // Returning `ok:false` here is what silenced 5 of 9 sessions when the ledger was the only signal.
  //
  // THE EPOCH IS RETURNED ON THIS PATH TOO, and that is not cosmetic. `signatureOf` keys the ADVISE
  // arm's dedupe on the epoch, so an unnamed-contaminated session that reaches ADVISE through
  // INSTRUMENT C must still be able to re-surface when a lane completes. Nulling the counters here
  // would reintroduce the frozen-epoch CRIT on exactly the sessions this branch exists to un-silence.
  if (unnamed > 0) {
    return {
      ok: true,
      running,
      launched: launchedRows,
      terminated: terminatedRows,
      unnamed,
      boundedAbove: false,
      reason:
        `${unnamed} main-agent launch row(s) carry no dispatch name, and an unnamed lane's termination rows ` +
        "arrive under an unjoinable agent id — so this ledger reading is a LOWER bound on running " +
        "lanes only. Its zero is a blind spot, not a claim of idleness.",
    };
  }

  return {
    ok: true,
    running,
    launched: launchedRows,
    terminated: terminatedRows,
    unnamed: 0,
    boundedAbove: true,
    reason: null,
  };
}

// ── INSTRUMENT C — background_tasks, the harness's own statement of what is running ───────────

/**
 * The MEASURED `type` vocabulary of a `background_tasks` element. Both values were observed
 * verbatim in the probe (see the header): a background shell and a background subagent. Anything
 * else is UNCLASSIFIED and makes this instrument refuse — never silently "not a lane".
 */
const TASK_TYPE_LANE = "subagent";
const TASK_TYPE_SHELL = "shell";

/**
 * Read the harness's `background_tasks` array off the `Stop` payload and classify it.
 *
 * PRESENCE IS OCCUPANCY — `status` is deliberately NOT filtered on. Measured: a finished task is
 * ABSENT from the array (probe conditions C'' and D), and the only `status` value ever observed was
 * `"running"`. Filtering on an unmeasured status vocabulary could drop a live task and under-count
 * occupancy, which is the direction that makes this detector falsely LOUD. Counting presence can
 * only make it quieter.
 *
 * REFUSES RATHER THAN GUESSES on: an absent key (no upper bound available at all), a non-array
 * value, and any element whose `type` is outside the measured vocabulary. Each refusal is a typed
 * `reason` that names what was seen, so a harness change surfaces as UNKNOWN with a diagnosis
 * rather than as a silently disarmed guard.
 *
 * Pure: takes the payload, returns plain data. No IO, no clock. NEVER throws.
 *
 * @param {object|null} payload the hook's parsed stdin payload
 * @returns {{ok:boolean, present:boolean, lanes:number|null, laneIds:string[]|null,
 *            shells:number|null, total:number|null, unclassified:string[]|null, reason:string|null}}
 */
function readBackgroundTasks(payload) {
  const fail = (reason, present) => ({
    ok: false,
    present: !!present,
    lanes: null,
    laneIds: null,
    shells: null,
    total: null,
    unclassified: null,
    reason,
  });

  try {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return fail("the hook payload was not a readable object, so `background_tasks` is UNKNOWN — not empty.", false);
    }
    if (!Object.prototype.hasOwnProperty.call(payload, "background_tasks")) {
      return fail(
        "this payload carries no `background_tasks` key, so the harness supplied no upper bound on " +
          "what is running. Lane occupancy is UNKNOWN for this turn, not idle.",
        false,
      );
    }

    const bt = payload.background_tasks;
    if (!Array.isArray(bt)) {
      return fail(
        `\`background_tasks\` was ${bt === null ? "null" : typeof bt}, not the array this instrument was ` +
          "measured against, so it is UNKNOWN — not empty.",
        true,
      );
    }

    const laneIds = [];
    let shells = 0;
    const unclassified = [];

    for (const t of bt) {
      if (!t || typeof t !== "object" || Array.isArray(t)) {
        unclassified.push(`<${t === null ? "null" : typeof t}>`);
        continue;
      }
      if (t.type === TASK_TYPE_LANE) {
        laneIds.push(_isNonEmptyString(t.id) ? t.id : _isNonEmptyString(t.description) ? t.description : "<unnamed>");
      } else if (t.type === TASK_TYPE_SHELL) {
        // A background SHELL is occupancy of the machine, but it is NOT a lane, and MUST-6 is about
        // lanes. Counted separately and reported, never folded into the lane count and never
        // allowed to silence the drain arm — a `sleep` in the background is not a dispatched agent.
        shells++;
      } else {
        unclassified.push(_isNonEmptyString(t.type) ? t.type : `<${typeof t.type}>`);
      }
    }

    if (unclassified.length > 0) {
      const seen = [...new Set(unclassified)].slice(0, MAX_NAMED).join(", ");
      return fail(
        `\`background_tasks\` carried ${unclassified.length} element(s) of unmeasured type (${seen}); only ` +
          `\`${TASK_TYPE_LANE}\` and \`${TASK_TYPE_SHELL}\` were ever observed. An unclassifiable RUNNING task ` +
          "cannot be ruled out as a lane, so occupancy is UNKNOWN rather than assumed idle.",
        true,
      );
    }

    return {
      ok: true,
      present: true,
      lanes: laneIds.length,
      laneIds: laneIds.sort(),
      shells,
      total: bt.length,
      unclassified: [],
      reason: null,
    };
  } catch (e) {
    // `_safeErrMessage` and NOT the usual `e.message ? e.message : String(e)`: that idiom is itself
    // a throw site when the thrown value carries a hostile `message` getter or a throwing
    // `toString`, which would turn this catch — the last line of the fails-open contract — into the
    // thing that breaks it.
    return fail(`reading \`background_tasks\` failed: ${_safeErrMessage(e)}`, false);
  }
}

// ── INSTRUMENT B — open work ──────────────────────────────────────────────────────────────────

/**
 * Extract forest-ledger data rows from ONE notes file's text.
 *
 * Bound to the ledger SECTION, never the whole file — an unbound scan would pull IDs out of any
 * other wide table in a notes fragment (the in-play-PR and in-play-branch tables live in the same
 * file), which is the substring-mask failure the upstream validator's own comments record.
 *
 * @param {string} text
 * @returns {{found:boolean, rows:string[]}} `rows` are the raw data-row lines
 */
function parseForestLedger(text) {
  if (typeof text !== "string" || text.length === 0) return { found: false, rows: [] };

  const lines = text.split(/\r\n|\r|\n/);
  let inSection = false;
  let shared = false;
  let fenceMarker = null; // the open fence's character, or null outside a fence
  let fenceLen = 0;
  let found = false;
  const rows = [];

  for (const line of lines) {
    const run = _fenceRun(line);
    if (run !== null) {
      // Paired by marker and length, as the validator pairs them: a ``` line inside a ~~~ block
      // does not close it, and toggling on any fence line counted the fenced example as a row.
      if (fenceMarker === null) {
        fenceMarker = run[0];
        fenceLen = run.length;
      } else if (run[0] === fenceMarker && run.length >= fenceLen) {
        fenceMarker = null;
        fenceLen = 0;
      }
      continue;
    }
    if (fenceMarker !== null) continue;

    if (HEADING_RE.test(line)) {
      inSection = true;
      shared = false;
      found = true;
      continue;
    }
    if (SHARED_HEADING_RE.test(line)) {
      // The whole-file shared-ledger form: the section runs to EOF, so `## ` headings inside it
      // do not close it the way they close the inline form.
      inSection = true;
      shared = true;
      found = true;
      continue;
    }
    if (inSection && !shared && NEXT_SECTION_RE.test(line)) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    if (!line.trimStart().startsWith("|")) continue;

    const cells = line.split("|").slice(1, -1);
    if (cells.length === 0) continue;
    // Separator row (`| --- | --- |`)
    if (cells.every((c) => /^:?-+:?$/.test(c.replace(/\s/g, "")) || c.trim() === "")) continue;
    // Header row — matched on the ID/Item column pair, accepting BOTH the inline header and the
    // split shared header, exactly as the upstream validator does.
    // Two accepted header shapes, both matched CASE-INSENSITIVELY. The first is the wide
    // value-anchor form the upstream validator keys on; the second is the plain `| ID | Item |
    // Status |` header the live fragments actually carry. A case-SENSITIVE `id` test silently let
    // the real header through as a data row and inflated every count by one per fragment — caught
    // by fixtures 11/15/17, which is what a firing pole asserting an exact count is for.
    const joined = cells.join("|").toLowerCase();
    if (/\b(?:value-anchor|value_anchor)\b/.test(joined) && /\b(?:item|id)\b/.test(joined)) continue;
    if (/^\s*id\s*$/i.test(cells[0] || "")) continue;

    rows.push(line);
  }

  // An explicit "forest empty" declaration is a POSITIVE statement that the board is clear, and is
  // distinct from a missing section. It is `found` with zero rows.
  if (!found && EMPTY_FOREST_RE.test(text)) return { found: true, rows: [] };

  return { found, rows };
}

/**
 * Count dispatchable open work across the notes surfaces.
 *
 * @param {Array<{path:string, text:string}>} fragments
 * @returns {{ok:boolean, total:number|null, dispatchable:number|null, humanBlocked:number|null,
 *            sources:string[], reason:string|null}}
 */
function countOpenWork(fragments) {
  if (!Array.isArray(fragments) || fragments.length === 0) {
    return {
      ok: false,
      total: null,
      dispatchable: null,
      humanBlocked: null,
      sources: [],
      reason:
        "no session-notes surface was readable, so the open-work count is UNKNOWN — not zero. " +
        "An absent board and a clear board are the same bytes here, which is why this is not QUIET.",
    };
  }

  let found = false;
  let total = 0;
  let humanBlocked = 0;
  const sources = [];

  for (const f of fragments) {
    if (!f || typeof f.text !== "string") continue;
    const parsed = parseForestLedger(f.text);
    if (!parsed.found) continue;
    found = true;
    sources.push(f.path);
    for (const row of parsed.rows) {
      total++;
      if (HUMAN_BLOCKED_RE.test(row)) humanBlocked++;
    }
  }

  if (!found) {
    return {
      ok: false,
      total: null,
      dispatchable: null,
      humanBlocked: null,
      sources: [],
      reason:
        "no `## Outstanding ledger (forest)` section was found in any readable notes surface, so " +
        "the open-work count is UNKNOWN — not zero.",
    };
  }

  return { ok: true, total, dispatchable: total - humanBlocked, humanBlocked, sources, reason: null };
}

// ── the decision ──────────────────────────────────────────────────────────────────────────────

/**
 * The core predicate. Takes both instrument readings and returns a verdict.
 *
 * Pure: no IO, no clock, no env read (the floor is passed in). Every arm below is a fixture case.
 *
 * ORDER IS LOAD-BEARING. UNKNOWN precedes QUIET, because a count that was never taken must never
 * render as a clear board; the instrument RECONCILIATION precedes every verdict arm, because a
 * contradiction between the two occupancy signals is not a number to average; and the dispatchable
 * gate precedes both firing arms, because a clean converged hand-back is COMPLETE and this detector
 * must never become pressure to invent work.
 *
 * THE FLEET EPOCH IS CARRIED, NOT DROPPED. `launched` and `terminated` are threaded through from
 * INSTRUMENT A onto the verdict for one reason: `signatureOf` needs them (see there). They are
 * MONOTONIC counters over the session's ledger, so they are what distinguishes a drain that merely
 * PERSISTS from a genuinely NEW one. Every arm carries whatever half of the pair was measurable —
 * including the UNKNOWN arms, so a session that never reaches a verdict still records a non-null
 * epoch wherever INSTRUMENT A produced one.
 *
 * THE RECONCILIATION IS ASYMMETRIC, AND THE ASYMMETRY IS THE INSTRUMENTS' MEASURED SCOPE, not a
 * preference (`instrument-discipline.md` MUST-4 — see the header's § RECONCILIATION). A BOUNDED
 * ledger asserts idleness, so it can contradict the harness in either direction. An UNBOUNDED
 * ledger (unnamed launches present) only ever under-reports busy, so its idle reading cannot
 * contradict a busy harness — but its BUSY reading still contradicts an idle harness.
 *
 * THE EPOCH AND THE RECONCILIATION ARE INDEPENDENT AXES. The epoch answers "is this drain NEW";
 * the reconciliation answers "is this fleet ACTUALLY idle". A verdict needs both: the reconciliation
 * decides whether ADVISE is reachable at all, and the epoch decides whether a reachable ADVISE is
 * suppressed as a duplicate. Dropping either one restores a measured silence.
 *
 * @param {{lanes:object, work:object, tasks:object}} readings
 * @param {{laneFloor?:number}} [cfg]
 * @returns {{state:string, arm:string|null, running:number|null, runningNames:string[]|null,
 *            harnessLanes:number|null, harnessShells:number|null, ledgerLanes:number|null,
 *            ledgerBounded:boolean|null, dispatchable:number|null, humanBlocked:number|null,
 *            launched:number|null, terminated:number|null, laneFloor:number, reason:string|null}}
 */
function assessFleetDrain(readings, cfg) {
  // THE FAILS-OPEN CONTRACT, HELD RATHER THAN ASSERTED (`cc-artifacts.md` Rule 7). Every field read
  // below is a potential throw site on a hostile reading (a getter that throws, a Proxy trap), and
  // the header's "NOTHING throws" was, before this wrapper, a claim about inputs the module's own
  // producers happen to make rather than about the function. Production reachability is nil — the
  // payload is `JSON.parse` output and `fleet-drain-guard.js::main` catches everything — but a
  // contract that holds only because nobody exercises it is not a contract.
  try {
    return _assessFleetDrain(readings, cfg);
  } catch (e) {
    return {
      state: "UNKNOWN",
      arm: "assess-threw",
      running: null,
      runningNames: null,
      harnessLanes: null,
      harnessShells: null,
      ledgerLanes: null,
      ledgerBounded: null,
      dispatchable: null,
      humanBlocked: null,
      // NULL, not a salvaged epoch: the throw means no reading here can be trusted, and
      // `signatureOf` renders a null epoch as EMPTY rather than dropping the field, so the tuple
      // keeps its arity on this path too.
      launched: null,
      terminated: null,
      laneFloor: DEFAULT_LANE_FLOOR,
      reason: `assessing the fleet threw (${_safeErrMessage(e)}); occupancy is UNKNOWN.`,
    };
  }
}

function _assessFleetDrain(readings, cfg) {
  const laneFloor = cfg && Number.isInteger(cfg.laneFloor) && cfg.laneFloor >= 0 ? cfg.laneFloor : DEFAULT_LANE_FLOOR;
  const lanes = (readings && readings.lanes) || null;
  const work = (readings && readings.work) || null;
  const tasks = (readings && readings.tasks) || null;

  const base = {
    state: "UNKNOWN",
    arm: null,
    running: null,
    runningNames: null,
    harnessLanes: null,
    harnessShells: null,
    ledgerLanes: null,
    ledgerBounded: null,
    dispatchable: null,
    humanBlocked: null,
    launched: null,
    terminated: null,
    laneFloor,
    reason: null,
  };

  // The epoch counters survive an UNKNOWN lane reading whenever the reader produced them — an
  // unreadable ledger nulls them, but a ledger that WAS read and merely could not be bounded above
  // still carries both counts. Guarded with `Number.isInteger` rather than read straight off the
  // reading, because this function's fails-open contract covers a hostile `lanes` object too.
  const epoch = {
    launched: lanes && Number.isInteger(lanes.launched) ? lanes.launched : null,
    terminated: lanes && Number.isInteger(lanes.terminated) ? lanes.terminated : null,
  };

  // `!Array.isArray(running)` is not defensive noise: it is the FAILS-OPEN contract
  // (`cc-artifacts.md` Rule 7) held at the one place a malformed reading would otherwise throw out
  // of a pure function that promises never to.
  if (!lanes || !lanes.ok || !Array.isArray(lanes.running)) {
    return {
      ...base,
      ...epoch,
      arm: "ledger-unreadable",
      reason: (lanes && lanes.reason) || "the running-lane count is UNKNOWN.",
    };
  }

  const ledgerLanes = lanes.running.length;
  const ledgerBounded = lanes.boundedAbove === true;
  const withLedger = { ...base, ...epoch, ledgerLanes, ledgerBounded, runningNames: lanes.running };

  // INSTRUMENT C is the PRIMARY occupancy signal, so its absence is not something the ledger can
  // paper over: without it there is no upper bound from anywhere, which is the exact condition
  // under which a drain verdict is a confident wrong answer.
  if (!tasks || !tasks.ok) {
    return {
      ...withLedger,
      arm: "harness-unreadable",
      reason: (tasks && tasks.reason) || "the harness `background_tasks` signal is UNKNOWN.",
    };
  }

  // `< 0` and not merely `!Number.isInteger`: a NEGATIVE lane count is not producible by
  // `readBackgroundTasks` (it is an array length), and it reached the ADVISE arm — `-1 === 0` is
  // false, so the drained test passes it through to `running = max(...)` and out the firing side.
  // Refusing it costs nothing and removes an unguarded path INTO the one verdict that speaks.
  if (!Number.isInteger(tasks.lanes) || tasks.lanes < 0) {
    return { ...withLedger, arm: "harness-unreadable", reason: "the harness lane count was not a count; UNKNOWN." };
  }
  const harnessLanes = tasks.lanes;
  const withBoth = { ...withLedger, harnessLanes, harnessShells: tasks.shells };

  // THE RECONCILIATION. On the one proposition both instruments answer — is anything running.
  const ledgerBusy = ledgerLanes > 0;
  const harnessBusy = harnessLanes > 0;
  const contradiction =
    ledgerBusy !== harnessBusy && (ledgerBounded || ledgerBusy); // unbounded-idle-vs-busy is expected, not a contradiction
  if (contradiction) {
    return {
      ...withBoth,
      arm: "instrument-disagreement",
      reason:
        `the two occupancy instruments disagree: the dispatch ledger reads ${ledgerLanes} running lane(s)` +
        `${ledgerBounded ? "" : " (lower bound only)"} while the harness \`background_tasks\` reads ` +
        `${harnessLanes}. One of them is wrong about whether this fleet is idle, and this detector does ` +
        "not pick a winner — occupancy is UNKNOWN for this turn.",
    };
  }

  // `!Number.isFinite(work.dispatchable)` is the M-3 sibling of the lane-count guard above: a NaN
  // dispatchable slips the clean-stop gate silently, because `NaN < DISPATCHABLE_FLOOR` is FALSE,
  // and lands in the firing arms. An unmeasurable board must be UNKNOWN, never a reason to speak.
  if (!work || !work.ok || !Number.isFinite(work.dispatchable)) {
    return {
      ...withBoth,
      arm: "work-unreadable",
      running: Math.max(ledgerLanes, harnessLanes),
      reason: (work && work.reason) || "the open-work count is UNKNOWN.",
    };
  }

  // THE OCCUPANCY NUMBER. The MAX of the two agreeing readings — the direction that is conservative
  // against FIRING, since both firing arms trigger on running being LOW. When both read zero it is
  // zero, which is the only value the ADVISE arm acts on.
  const running = Math.max(ledgerLanes, harnessLanes);
  const known = {
    ...withBoth,
    running,
    dispatchable: work.dispatchable,
    humanBlocked: work.humanBlocked,
  };

  // THE CLEAN-STOP GATE. Nothing dispatchable ⇒ silent, whatever the lane count. This is the
  // mechanical form of `recommendation-quality.md` MUST-3: a converged hand-to-human stop IS
  // complete, and manufacturing work to avoid stopping is BLOCKED.
  if (work.dispatchable < DISPATCHABLE_FLOOR) {
    return {
      ...known,
      state: "QUIET",
      arm: "clean-stop",
      reason:
        work.total > 0
          ? `all ${work.total} open row(s) are marked blocked-on-human; nothing is dispatchable.`
          : "the board is clear; nothing is dispatchable.",
    };
  }

  // THE DRAINED ARM — a BOUNDARY, no free parameter. Zero lanes with dispatchable work is the
  // refill trigger that was missing.
  if (running === 0) {
    return {
      ...known,
      state: "ADVISE",
      arm: "drained",
      reason:
        `0 lanes running with ${work.dispatchable} dispatchable open row(s) — BOTH instruments agree ` +
        `(harness \`background_tasks\`: 0 subagent task(s)${known.harnessShells ? `, ${known.harnessShells} background shell(s), which are not lanes` : ""}; ` +
        `dispatch ledger: 0 named running lane(s)${ledgerBounded ? "" : ", lower bound only"}).`,
    };
  }

  // THE UNDER-CAPACITY ARM — UNCALIBRATED, so it OBSERVES and gives no advice. See the header.
  if (running <= laneFloor) {
    return {
      ...known,
      state: "OBSERVE",
      arm: "under-capacity",
      reason: `${running} lane(s) running (floor ${laneFloor}) with ${work.dispatchable} dispatchable open row(s).`,
    };
  }

  return {
    ...known,
    state: "QUIET",
    arm: "saturated",
    reason: `${running} lane(s) running, above the floor of ${laneFloor}.`,
  };
}

/**
 * Render the advisory. ADVISE and OBSERVE speak; QUIET and UNKNOWN return null.
 *
 * UNKNOWN IS SILENT BUT NOT ABSENT. It prints nothing — a line saying "I could not measure" on
 * every fresh clone and CI run is noise that would get the whole detector muted — but it is a
 * DISTINCT state in the returned data, it is pinned by fixtures, and it is never folded into QUIET.
 * The distinction is what stops a never-measured session from reading as a saturated one.
 *
 * @param {object} verdict
 * @returns {string|null}
 */
function formatFleetDrainAdvisory(verdict) {
  if (!verdict || !STATES.includes(verdict.state)) return null;
  if (verdict.state === "QUIET" || verdict.state === "UNKNOWN") return null;

  const names =
    Array.isArray(verdict.runningNames) && verdict.runningNames.length > 0
      ? ` (${verdict.runningNames.slice(0, MAX_NAMED).join(", ")}${verdict.runningNames.length > MAX_NAMED ? ", …" : ""})`
      : "";

  const head =
    verdict.state === "ADVISE"
      ? "FLEET DRAINED — the turn is ending with every lane idle and work on the board."
      : "FLEET UNDER CAPACITY — measured pair only; this arm is UNCALIBRATED and gives no advice.";

  const lines = [
    `[fleet-drain] ${head}`,
    `  running lanes: ${verdict.running}${names}   dispatchable open rows: ${verdict.dispatchable}` +
      (verdict.humanBlocked ? ` (+${verdict.humanBlocked} blocked-on-human, not counted)` : ""),
    `  instruments: harness background_tasks ${verdict.harnessLanes == null ? "?" : verdict.harnessLanes} subagent(s)` +
      `${verdict.harnessShells ? ` + ${verdict.harnessShells} shell(s)` : ""}; dispatch ledger ` +
      `${verdict.ledgerLanes == null ? "?" : verdict.ledgerLanes} named lane(s)` +
      `${verdict.ledgerBounded === false ? " (lower bound only)" : ""}.`,
    `  ${verdict.reason}`,
  ];

  if (verdict.state === "ADVISE") {
    lines.push(
      "  `wave-loop.md` MUST-6: idling while independent in-budget work is launchable is BLOCKED.",
      "  A lane freeing is a REFILL trigger, not merely a result to read. Recount and dispatch, or",
      "  state which bound (dependency, structural human gate, capacity, prudence, or a converged",
      "  clean stop) makes the remaining rows non-launchable.",
    );
  } else {
    lines.push(
      "  No advice is given: the lane floor is not calibrated, and one deliberately-serial",
      "  long-running lane is indistinguishable from an under-filled fleet at this surface.",
    );
  }

  lines.push(
    "  ADVISORY. `Stop` cannot block via any SEVERITY value (measured: the STOP_LIKE branch of",
    "  instruct-and-wait.js returns {continue:true}/exit 0 even for `block`), and the judgment of",
    "  whether the remaining rows are INDEPENDENT is not one this counter can make.",
  );

  return lines.join("\n");
}

/**
 * The dedupe signature — the MEASURED PAIR, the arm, and the FLEET EPOCH. Never the session.
 *
 * ## The measured defect this shape exists to fix
 *
 * The original signature was `state:arm:running:dispatchable`, and the header's contract has two
 * halves: "a persisting drain is surfaced once per state rather than once per assistant turn,
 * while a fleet that CHANGES is reported again". Only the first half held. NOTHING in that tuple
 * MOVES when a lane completes: `running` was already 0 in the drained arm and returns to 0, and
 * `dispatchable` is a property of the board, not of the fleet. So a genuinely NEW drain — the
 * orchestrator's LAST lane just finished, which is exactly the refill trigger `wave-loop.md`
 * MUST-6 names — produced a signature IDENTICAL to a drain already surfaced earlier in the session
 * and was suppressed.
 *
 * MEASURED, session c90a644a, 2026-08-20: a fleet of 5 lanes drained to zero with 25 dispatchable
 * forest rows open; the verdict was `ADVISE`/`drained` and the advisory was rendered — and the
 * marker file already held `ADVISE:drained:0:25` from an earlier drain, so `alreadySurfaced`
 * returned true and the hook went silent. The operator had to notice by hand. FALSIFYING RESULT
 * had the old tuple been sufficient: the two drains would have differed in `running` or
 * `dispatchable`; they differed in neither.
 *
 * ## The discriminator, and why it is these two counters
 *
 * `launched` and `terminated` are ROW COUNTS over the session's append-only ledger — `terminated`
 * increments on every reconcile row (one per `SubagentStop`), `launched` on every named
 * main-agent launch row. They are therefore MONOTONIC, and they are a FLEET EPOCH: the pair is
 * unchanged exactly when neither a lane completed nor a dispatch was made, and moves exactly when
 * one did. In the measured incident `launched` stayed 0 (those lanes were dispatched in a PRIOR
 * session, so no `MAIN_GENERATION` launch rows exist in this one) while `terminated` reached 24 and
 * rose with each returning lane — so `terminated` alone would have re-surfaced it, and `launched`
 * is carried because a fresh dispatch is the symmetric change on the other side.
 *
 *   same drain, nothing moved      → same tuple → SUPPRESSED  (the noise control, preserved)
 *   drain after a lane completed   → `terminated` moved → RE-SURFACED (the refill trigger)
 *   drain after a new dispatch     → `launched` moved   → RE-SURFACED
 *
 * ROW COUNTS, NOT SET CARDINALITIES, AND THE DIFFERENCE IS THE WHOLE CONTRACT. This block once read
 * "`terminated` increments on every `SubagentStop`" while the code held a `Set` of names, so the
 * sentence was FALSE for a repeated name and the CRIT it papered over was real: refill a drained
 * fleet using only names already present, let it drain again, and neither cardinality moved — the
 * new drain collided with the marked one and the detector went silent for the rest of the session.
 * `countRunningLanes` now counts rows, so the sentence above is true as written.
 *
 * THE EPOCH IS SCOPED TO THE `ADVISE` ARM, and that scoping is a noise bound, not an oversight.
 * A reconcile row is NOT generation-filtered (it cannot be — see `countRunningLanes`), so a nested
 * subagent's stop moves the epoch even though the main fleet did not change. On the `ADVISE` arm
 * that is CORRECT and is exactly the MUST-6 refill trigger: `running === 0` means no main lane is
 * in flight, so a returning lane IS news. On the `OBSERVE` arm it is not: a parent lane is running,
 * its nested lanes churn, and an arm that by construction GIVES NO ADVICE would `halt-and-report`
 * every single turn — breaking the header's "once per state, not once per turn" for a line that
 * carries no recommendation. So `OBSERVE` dedupes on the measured pair alone.
 *
 * THE RESIDUAL NOISE ON THE `ADVISE` ARM IS NAMED AND NOT BOUNDED FURTHER, deliberately. Reconcile
 * rows are neither generation-filtered nor deduped, so in the c90a644a shape — zero main-generation
 * launch rows, N inherited lanes returning one at a time — EVERY returning lane moves `terminated`
 * and mints a fresh signature. That weakens the header's "surfaced once per state, not once per
 * turn" on this arm specifically, and it is a cost of the c90a644a fix, not of the occupancy model:
 * last-write-wins does not touch it, because those names have no main launch row, so `running`
 * stays 0 either way.
 *
 * IT IS NOT UNBOUNDED. The ceiling is the EVENT: this detector runs at `Stop`, which fires once per
 * assistant turn, so the worst case is ONE `halt-and-report` line per turn, and only while the main
 * fleet reads drained AND the board carries dispatchable rows — the exact state MUST-6 names. N
 * lanes returning between two turn boundaries produce ONE line, not N.
 *
 * NO FURTHER BOUND IS ADDED, and refusing one is the measured disposition rather than the lazy one.
 * The obvious remedy — name-scoping `terminated` to the main fleet — is MEASURED BLOCKED (see the
 * next paragraph: it reds the entire c90a644a set). Every remaining option (bucketing `terminated`,
 * a per-turn rate cap, a minimum delta) introduces a TUNED NUMBER, and this module's calibration
 * note refuses to invent thresholds the data does not support; a per-turn line on the drained arm
 * is also the one place the advisory carries a recommendation the operator can act on. Recorded as
 * a known cost with a named ceiling, not as a solved problem.
 *
 * THE ALTERNATIVE REMEDY IS BLOCKED, and it is worth recording which one: scoping `terminated` to
 * names the MAIN agent launched would also silence the nested churn — and would REINTRODUCE the
 * measured c90a644a defect verbatim, because that session had ZERO main-generation launch rows (its
 * lanes came from a prior session), so every reconcile row would be filtered out and the epoch
 * would freeze at `0:0`. Cases 46/49/51 red under it. Arm-scoping costs nothing that arm was
 * delivering; name-scoping costs the incident this whole mechanism was built for.
 *
 * TOTAL for a null or partially-measured verdict, deliberately: a missing field renders empty
 * rather than `undefined`, and a null verdict yields a well-defined all-empty tuple of the SAME
 * arity as every other path. That constant is built from the tuple itself rather than written out
 * as a colon literal, because a hand-counted literal is exactly what goes stale when a component is
 * added — as one did here twice in one day. The signature is never thrown from and never returns a
 * non-string, because its only caller uses it as a marker key and a throw there would cost the
 * finding.
 *
 * BOTH INSTRUMENT READINGS JOIN THE KEY (2026-08-20) for the same reason the pair was chosen over
 * the session: they are components of the measured state, so a fleet whose harness occupancy moves
 * while the ledger's does not is a DIFFERENT state and must be able to surface again.
 *
 * `ledgerLanes` AND `ledgerBounded` ARE BOTH IN THE KEY, and that is a measured fix rather than
 * completeness for its own sake. With `running` (the MAX) alone, an unbounded-ledger-0 + harness-1
 * state and a ledger-1 + harness-1 state both keyed `OBSERVE:under-capacity:1:5:1` — while their
 * RENDERED text differs ("dispatch ledger 0 named lane(s) (lower bound only)" vs "1 named
 * lane(s) (alpha)"), so the second advisory was deduped away by a key that could not see the
 * difference it was reporting. A dedupe key must discriminate everything the message says.
 *
 * WIDENING IS ALWAYS THE SAFE DIRECTION HERE. A key with more components can only ever fail to
 * suppress — costing at most one extra advisory line — whereas a key with fewer can suppress a
 * finding. That asymmetry is also why an OLD-format marker cannot wrongly suppress a NEW-format
 * signature: `alreadySurfaced` compares with `===`, never a prefix or substring test.
 *
 * ## The two additions are ORTHOGONAL and BOTH are in the key
 *
 * The EPOCH (`launched`/`terminated`, ADVISE-scoped) answers "is this drain NEW". The INSTRUMENT
 * READINGS (`harnessLanes`, `ledgerLanes`, `ledgerBounded`) answer "which measured state is this".
 * They fix different suppressions and neither implies the other:
 *
 *   refill the SAME lane names, drain again      → epoch moves; both readings identical → without
 *                                                  the epoch this is SUPPRESSED (the c90a644a CRIT)
 *   unbounded-ledger-0 + harness-1 vs ledger-1
 *     + harness-1, same turn, same epoch          → epoch identical; readings differ → without the
 *                                                  readings this is SUPPRESSED while the two render
 *                                                  DIFFERENT advisory text
 *
 * So the key carries NINE components, not the four it shipped with. Widening remains the safe
 * direction (above): a wider key can only fail to suppress.
 *
 * @param {object} verdict
 * @returns {string}
 */
function signatureOf(verdict) {
  const f = (v) => (v == null ? "" : String(v));
  // NINE fields. `SIG_ARITY` is derived from the tuple's own length rather than restated, so the
  // null-verdict constant below cannot drift out of step with the tuple it is supposed to match —
  // the two-doors defect this module records elsewhere, in miniature.
  if (!verdict) return ["UNKNOWN", "", "", "", "", "", "", "", ""].join(":");
  // Arm-scoped: only ADVISE carries the epoch (see the block above). Every other state renders the
  // two fields EMPTY rather than dropping them, so the tuple keeps one arity on every path and a
  // marker written under one state can never collide with another.
  const epoch = verdict.state === "ADVISE" ? [f(verdict.launched), f(verdict.terminated)] : ["", ""];
  return [
    verdict.state,
    verdict.arm || "",
    f(verdict.running),
    f(verdict.dispatchable),
    f(verdict.harnessLanes),
    f(verdict.ledgerLanes),
    verdict.ledgerBounded == null ? "" : verdict.ledgerBounded ? "b" : "u",
    ...epoch,
  ].join(":");
}

/**
 * Per-session marker file. INJECTIVE `session_id` → filename, the same shape
 * `dispatch-ledger.js::_sinkPath` documents as load-bearing: a sanitized token PLUS an 8-char
 * sha256 of the RAW id.
 *
 * The suffix is not decoration. The charclass collapses every non-`[A-Za-z0-9._-]` byte to `_`, so
 * `sess:a` and `sess/a` sanitize to the SAME token — and this file is a SUPPRESSION store, so a
 * collision means one session's marker silences a genuine drain in a different session. That is the
 * one direction the whole module is built to avoid (a lost marker costs a repeated line; a wrong
 * one costs the finding). Its sibling had the disambiguator from the start; this reader shipped
 * without it.
 */
function _markerPath(repoDir, sessionId) {
  const raw = _isNonEmptyString(sessionId) ? sessionId : "unknown-session";
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  const suffix = crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  return path.join(repoDir, ".claude", "learning", "fleet-drain", `${safe}-${suffix}.jsonl`);
}

/**
 * Has this exact signature already been surfaced for this session?
 * FAIL-OPEN: any read failure returns false, so a lost marker costs a repeated line — never a
 * suppressed finding. The direction of that default is the whole safety argument, and it is
 * PRESERVED below: every refusal `readSinkFile` can return lands on `return false`, which EMITS.
 *
 * ## A WITHDRAWN CLAIM, recorded rather than deleted, because believing it is why this survived
 *
 * This function used to `lstatSync` and then `readFileSync`, with the byte cap gated on the lstat,
 * and its comment asserted that refusing a symlink here was "the symmetric refusal" to
 * `appendSinkLine`'s write-side refusal. THAT CLAIM WAS FALSE. `lstat` declines to follow only the
 * FINAL component of the path it is handed, so it guarded the marker FILE and nothing above it:
 * replacing the sink DIRECTORY with a symlink walked straight out of the repository, and the read
 * that followed answered a question about this repo with a file the attacker owned. It also
 * resolved no ancestor, checked no hard link, pinned no directory identity, and — as
 * `readSinkFile`'s own header records — a cap checked at stat time is decorative, because the file
 * may grow between the stat and a `readFileSync` that runs to EOF.
 *
 * MEASURED, one probe, four arms, with controls that fire and discriminate:
 *
 *     fleet-drain, in-tree marker WITH the signature     -> true    (the matcher fires)
 *     fleet-drain, in-tree marker WITHOUT it             -> false   (the matcher discriminates)
 *     fleet-drain, OUT-OF-TREE sink-directory symlink    -> true    <-- SUPPRESSED a real finding
 *     delegation-default, byte-identical shape           -> false   (its fixed reader refuses)
 *
 * The fourth arm is what makes the third readable: the sibling detector, already routed through
 * the shared primitive, refuses the same attack, so the difference is THIS reader and not the
 * platform. Symmetry with the write half is therefore achieved by CALLING THE SAME CODE, which is
 * the only form of it that cannot drift — a second containment implementation here would be the
 * exact class `security.md` § Path Containment forbids and this corpus keeps re-finding.
 *
 * ## What this does NOT close
 *
 * Containment stops the marker read from LEAVING the repository. It does not stop an attacker who
 * WRITES the predictable in-tree marker path with enumerated signatures — that file resolves
 * inside the root and passes every check. Closing that needs an unpredictable session-scoped key
 * and is a DESIGN change, not attempted here. Same open residual as `delegation-default.js`.
 *
 * @returns {boolean}
 */
function alreadySurfaced(repoDir, sessionId, signature) {
  try {
    const p = _markerPath(repoDir, sessionId);
    const r = readSinkFile({ repoDir, sinkPath: p, maxBytes: MAX_MARKER_BYTES });
    // EVERY refusal — absent, symlinked file, symlinked ancestor, dangling sink directory,
    // hard-linked, over-cap, swapped directory — lands here and returns false, which EMITS the
    // finding. That is the same direction the old bare `catch { return false }` took; what changed
    // is WHICH shapes reach it instead of being read and honoured.
    if (!r.ok) return false;
    for (const line of r.text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const rec = JSON.parse(line);
        if (rec && rec.signature === signature) return true;
      } catch {
        /* a torn row is not a reason to suppress */
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Record that this signature was surfaced. Best-effort; returns a result object, NEVER throws.
 * Routes through the ONE hardened append primitive rather than a second un-hardened sink.
 * @returns {{ok:boolean, error?:string}}
 */
function markSurfaced(repoDir, sessionId, signature, nowIso) {
  try {
    const sinkPath = _markerPath(repoDir, sessionId);
    const line = JSON.stringify({
      v: 1,
      signature,
      ts: _isNonEmptyString(nowIso) ? nowIso : new Date().toISOString(),
    });
    const w = appendSinkLine({ repoDir, sinkPath, line });
    return w && w.ok ? { ok: true } : { ok: false, error: (w && `${w.error} — ${w.reason}`) || "append failed" };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Collect the readable session-notes surfaces under `baseDir`.
 *
 * Routes every read through `session-notes-layout.js::readNotesFileGuarded` — the single guarded
 * chokepoint (symlink refusal + size cap) that module exists to keep every notes reader inside.
 * If that module cannot be loaded, a bounded local fallback is used and SAYS so, rather than the
 * collector failing shut and turning every session UNKNOWN.
 *
 * @param {string} baseDir
 * @returns {Array<{path:string, text:string}>}
 */
function collectNotesSurfaces(baseDir) {
  const out = [];
  let guarded = null;
  try {
    guarded = require("./session-notes-layout.js").readNotesFileGuarded;
  } catch {
    guarded = null;
  }

  const read = (p) => {
    try {
      if (typeof guarded === "function") {
        const g = guarded(p);
        return g && g.ok ? g.content : null;
      }
      // THE BARE FORM HERE IS DELIBERATE. It has the shape CRITICAL-1 was filed
      // against (`lstatSync` + `readFileSync` rather than `readSinkFile`), and it is
      // NOT routed through the hardened reader. Assessed 2026-09-01; recorded so the
      // next reviewer does not re-litigate it from the shape alone.
      //
      //  1. NOT REACHABLE in production. This branch runs only when the require at
      //     the top of `collectNotesSurfaces` throws or yields a non-function.
      //     MEASURED on this tree: `session-notes-layout.js::readNotesFileGuarded`
      //     resolves and `typeof === "function"`, so `guarded` wins every time. The
      //     fallback exists so a deployment MISSING that module degrades to a
      //     bounded read instead of turning every session's count UNKNOWN.
      //  2. NOTHING IT READS REACHES AGENT-FACING OUTPUT. Its ONE production caller
      //     is `fleet-drain-guard.js:264`, which passes the result INLINE to
      //     `countOpenWork` and never binds it. `countOpenWork` reduces the text to
      //     integers — `total++`, and a boolean `HUMAN_BLOCKED_RE.test(row)` — and
      //     returns `{ok,total,dispatchable,humanBlocked,sources,reason}` where
      //     `reason` is a STRING LITERAL, never derived from file bytes. Downstream,
      //     `_assessFleetDrain` dereferences ONLY `ok`/`total`/`dispatchable`/
      //     `humanBlocked`/`reason`. `sources` (filenames) is collected and NEVER
      //     read anywhere in this module. So no byte of notes content, and not even
      //     a notes FILENAME, can reach the advisory, a `systemMessage`, or stdout.
      //
      // Its trust class therefore differs from the marker readers `readSinkFile` now
      // guards: a poisoned read there silences a DETECTOR, whereas the worst case
      // here is a miscounted integer on a branch that does not execute. The residual
      // TOCTOU window between this `lstat` and the `readFileSync` is real but has no
      // sink to reach. Route it if either fact changes — if this content ever starts
      // being QUOTED into a report or an advisory, it becomes a live injection
      // surface and the bounded read is no longer sufficient.
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() || !st.isFile() || st.size > FALLBACK_NOTES_CAP_BYTES) return null;
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };

  const candidates = [];
  try {
    const dir = path.join(baseDir, ".session-notes.d");
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".md")) candidates.push(path.join(dir, f));
    }
  } catch {
    /* no fragment dir on this deployment */
  }
  candidates.push(path.join(baseDir, ".session-notes.shared.md"));
  candidates.push(path.join(baseDir, ".session-notes"));

  for (const p of candidates) {
    const text = read(p);
    if (typeof text === "string" && text.length > 0) out.push({ path: path.relative(baseDir, p) || p, text });
  }
  return out;
}

/**
 * Pin the main-generation sentinel to the PRODUCER'S OWN BEHAVIOUR, not to a string literal.
 *
 * Drives `dispatch-ledger.js::buildLaunchRecord` with NO generation — the shape the launch hook
 * produces for a main-agent dispatch, since CC populates `agent_id` only inside a subagent — and
 * asserts the record comes back carrying exactly the sentinel this module filters on. A fixture
 * asserting `MAIN_GENERATION === "(main-agent)"` would stay green while the producer moved to a
 * different sentinel and this module's launch filter silently selected nothing.
 *
 * @param {Function} buildLaunchRecord the producer's own builder
 * @returns {{ok:boolean, detail:string}}
 */
function assertMainGenerationMatchesProducer(buildLaunchRecord) {
  try {
    const r = buildLaunchRecord({ sessionId: "s", dispatchName: "d", nowIso: "1970-01-01T00:00:00.000Z" });
    const got = r && r.generation;
    return {
      ok: got === MAIN_GENERATION,
      detail: `producer default generation ${JSON.stringify(got)} vs filtered ${JSON.stringify(MAIN_GENERATION)}`,
    };
  } catch (e) {
    return { ok: false, detail: `producer builder threw: ${e && e.message ? e.message : String(e)}` };
  }
}

module.exports = {
  STATES,
  MAIN_GENERATION,
  assertMainGenerationMatchesProducer,
  DEFAULT_LANE_FLOOR,
  DISPATCHABLE_FLOOR,
  HUMAN_BLOCKED_RE,
  MAX_NAMED,
  // Exported so the marker-bound fixture drives the REAL cap instead of restating the literal.
  // A fixture that hard-codes `256 * 1024` stays green while the constant moves underneath it,
  // which is the same "two readers of one signal silently disagree" shape the DECLARED_FLOOR
  // coupling assertion exists to prevent one module over.
  MAX_MARKER_BYTES,
  TASK_TYPE_LANE,
  TASK_TYPE_SHELL,
  resolveLaneFloor,
  resolveEnabled,
  countRunningLanes,
  readBackgroundTasks,
  parseForestLedger,
  countOpenWork,
  assessFleetDrain,
  formatFleetDrainAdvisory,
  signatureOf,
  // Exported so fixtures resolve the marker through the PRODUCER'S OWN derivation rather than
  // restating it — the two-doors defect `dispatch-ledger.js::_sinkPath` records (a read through one
  // door and a write through the other silently missing each other).
  _markerPath,
  alreadySurfaced,
  markSurfaced,
  collectNotesSurfaces,
};
