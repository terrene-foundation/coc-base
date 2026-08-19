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
 * THE MEASURED HOLE, and why it forces UNKNOWN rather than a number. A dispatch made without a
 * `name` writes `dispatch_name: null`, so it is absent from the launched set; its `reconcile` rows
 * arrive under an unnormalizable `a<16hex>` generation that joins to nothing. Measured across the
 * 9 ledgers on this clone: unnamed launches per session 0, 0, 0, 0, 1, 2, 2, 6, 22 — present in 5
 * of 9 — and hex-only reconcile generations OUTNUMBER them wildly (one session: 22 unnamed
 * launches against 401 distinct hex generations, i.e. ~one per event, not one per lane). So the
 * unnamed population can be neither joined NOR subtracted numerically.
 *
 * That asymmetry decides the design. The named difference is a LOWER bound on running lanes; this
 * detector fires on running being LOW, so what it needs is an UPPER bound, which is exactly what
 * the unnamed population denies it. A session with unnamed launches is therefore UNKNOWN — the
 * detector goes silent rather than firing on a fleet it cannot see. Measured cost: silence in
 * roughly 5 of 9 sessions. That is a real coverage hole and it is stated rather than papered over;
 * the alternative is a guard that announces a drained fleet while lanes are running, which is the
 * one failure that gets a guard switched off.
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
 * than every turn, and the kill switch exists.
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

const fs = require("node:fs");
const path = require("node:path");

const { appendSinkLine } = require("./append-sink.js");

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
// MIRRORED from `.claude/bin/validate-forest-ledger.mjs`, which is an ESM CLI with no exports and
// therefore not requirable from a CJS hook. Restating the anchors is the lesser of two evils
// against re-inventing a second dialect for one surface; if that validator's anchors move, this
// parse is what a fixture reds. Both accepted shapes are the ones IT accepts.
const HEADING_RE = /^##[ \t]+Outstanding ledger \(forest\)\s*$/i;
const SHARED_HEADING_RE = /^#[ \t]+Forest Ledger\b/i;
const NEXT_SECTION_RE = /^##[ \t]+\S/;
const FENCE_RE = /^\s*(?:```+|~~~+)/;
const EMPTY_FOREST_RE = /^\s*forest empty\b/im;

function _isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
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
 * @param {object[]|null} rows  `dispatch-ledger.js::readLedger().rows`
 * @param {{reason?:string}} [failure] typed reason when the read failed
 * @returns {{ok:boolean, running:string[]|null, launched:number|null, terminated:number|null,
 *            unnamed:number|null, reason:string|null}}
 */
function countRunningLanes(rows, failure) {
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      running: null,
      launched: null,
      terminated: null,
      unnamed: null,
      reason:
        (failure && failure.reason) ||
        "no dispatch-ledger rows were readable, so the running-lane count is UNKNOWN — not zero.",
    };
  }

  const launched = new Set();
  let unnamed = 0;
  const terminated = new Set();

  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    if (r.kind === "launch") {
      // The `generation` on a LAUNCH row is the PARENT of the dispatched lane, so this selects
      // the lanes the MAIN agent itself dispatched.
      if (r.generation !== MAIN_GENERATION) continue;
      if (_isNonEmptyString(r.dispatch_name)) launched.add(r.dispatch_name);
      else unnamed++;
    } else if (r.kind === "reconcile") {
      // NOT generation-filtered, and deliberately so: the `generation` on a RECONCILE row is the
      // STOPPING LANE'S OWN name, not its parent's. Filtering it to `(main-agent)` would discard
      // every real termination signal and report the whole fleet as permanently running.
      if (_isNonEmptyString(r.generation)) terminated.add(r.generation);
    }
  }

  // THE UPPER-BOUND REFUSAL. An unnamed launch is unjoinable in both directions (see the header):
  // it never enters `launched`, and its reconcile rows arrive under a hex generation that matches
  // nothing. The named difference stays a valid LOWER bound on running lanes, but this detector
  // fires on running being LOW and therefore needs an UPPER bound. Returning a number here would
  // be a confident wrong answer on exactly the sessions with the busiest fleets.
  if (unnamed > 0) {
    return {
      ok: false,
      running: null,
      launched: launched.size,
      terminated: terminated.size,
      unnamed,
      reason:
        `${unnamed} main-agent launch row(s) carry no dispatch name, and an unnamed lane's termination rows ` +
        "arrive under an unjoinable agent id — so the number of RUNNING lanes cannot be bounded " +
        "from above. Lane occupancy is UNKNOWN for this session, not idle.",
    };
  }

  const running = [...launched].filter((n) => !terminated.has(n)).sort();
  return { ok: true, running, launched: launched.size, terminated: terminated.size, unnamed: 0, reason: null };
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

  const lines = text.split("\n");
  let inSection = false;
  let shared = false;
  let inFence = false;
  let found = false;
  const rows = [];

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

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
 * render as a clear board; and the dispatchable gate precedes both firing arms, because a clean
 * converged hand-back is COMPLETE and this detector must never become pressure to invent work.
 *
 * @param {{lanes:object, work:object}} readings
 * @param {{laneFloor?:number}} [cfg]
 * @returns {{state:string, arm:string|null, running:number|null, runningNames:string[]|null,
 *            dispatchable:number|null, humanBlocked:number|null, laneFloor:number, reason:string|null}}
 */
function assessFleetDrain(readings, cfg) {
  const laneFloor = cfg && Number.isInteger(cfg.laneFloor) && cfg.laneFloor >= 0 ? cfg.laneFloor : DEFAULT_LANE_FLOOR;
  const lanes = (readings && readings.lanes) || null;
  const work = (readings && readings.work) || null;

  const base = {
    state: "UNKNOWN",
    arm: null,
    running: null,
    runningNames: null,
    dispatchable: null,
    humanBlocked: null,
    laneFloor,
    reason: null,
  };

  if (!lanes || !lanes.ok) {
    return { ...base, reason: (lanes && lanes.reason) || "the running-lane count is UNKNOWN." };
  }
  if (!work || !work.ok) {
    return {
      ...base,
      running: lanes.running.length,
      runningNames: lanes.running,
      reason: (work && work.reason) || "the open-work count is UNKNOWN.",
    };
  }

  const running = lanes.running.length;
  const known = {
    ...base,
    running,
    runningNames: lanes.running,
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
      reason: `0 lanes running with ${work.dispatchable} dispatchable open row(s).`,
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
    "  ADVISORY. `Stop` cannot block at any severity (measured: the STOP_LIKE branch of",
    "  instruct-and-wait.js returns {continue:true}/exit 0 even for `block`), and the judgment of",
    "  whether the remaining rows are INDEPENDENT is not one this counter can make.",
  );

  return lines.join("\n");
}

/**
 * The dedupe signature — the MEASURED PAIR plus the arm, never the session.
 *
 * Keying on the pair is what makes a persisting state surface ONCE while a CHANGING fleet surfaces
 * again: refill a lane and the pair moves, so the next drain is reported. Keying on the session
 * instead would report the first drain of a session and stay silent through every later one.
 *
 * @param {object} verdict
 * @returns {string}
 */
function signatureOf(verdict) {
  if (!verdict) return "UNKNOWN::";
  return `${verdict.state}:${verdict.arm || ""}:${verdict.running == null ? "" : verdict.running}:${
    verdict.dispatchable == null ? "" : verdict.dispatchable
  }`;
}

function _markerPath(repoDir, sessionId) {
  const raw = _isNonEmptyString(sessionId) ? sessionId : "unknown-session";
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(repoDir, ".claude", "learning", "fleet-drain", `${safe}.jsonl`);
}

/**
 * Has this exact signature already been surfaced for this session?
 * FAIL-OPEN: any read failure returns false, so a lost marker costs a repeated line — never a
 * suppressed finding. The direction of that default is the whole safety argument.
 * @returns {boolean}
 */
function alreadySurfaced(repoDir, sessionId, signature) {
  try {
    const p = _markerPath(repoDir, sessionId);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_MARKER_BYTES) return false;
    const text = fs.readFileSync(p, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const r = JSON.parse(line);
        if (r && r.signature === signature) return true;
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
  resolveLaneFloor,
  resolveEnabled,
  countRunningLanes,
  parseForestLedger,
  countOpenWork,
  assessFleetDrain,
  formatFleetDrainAdvisory,
  signatureOf,
  alreadySurfaced,
  markSurfaced,
  collectNotesSurfaces,
};
