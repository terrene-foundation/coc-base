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
 *     wrong. `declared >= 2 && dispatched === 0` WAS the only advising arm when this landed; it
 *     is NOT any more, and leaving that sentence unqualified is what let the same false claim sit
 *     in `orchestrator-context-economy.md` until a structural pass caught it. There are now THREE
 *     advising arms — see PARTIAL SHORTFALL below for the one-lane arm (loom#2004) and THE
 *     SESSION-VOLUME ARM for the third. Derive the count, do not trust this line — and note the
 *     command is ANCHORED so it cannot match ITSELF. The obvious form,
 *     `grep -c 'state: "ADVISE"' delegation-default.js`, MEASURED 4 against 3 real arms at the
 *     moment it was caught: the instruction quoting the pattern was itself the fourth hit, so the
 *     derive command was wrong BY CONSTRUCTION in exactly the way this note tells the reader to
 *     guard against. It reads 5 now, not 4, because THIS correction adds a second prose mention —
 *     recorded rather than smoothed over, since a stale literal here is the same defect one turn
 *     later, and case 140 asserts the RELATION (unanchored > anchored) rather than either literal.
 *     The arms are
 *     CODE — indentation, then the property, then a comma — while every prose mention sits behind
 *     a ` *` continuation marker:
 *     `grep -n '^ *state: "ADVISE",' delegation-default.js`
 *     Read the HITS, not a tally (`instrument-discipline.md` MUST-3(b)) — which is why the form
 *     above is `-n` and not `-c`. MEASURED 2026-09-01 it prints three lines, one per arm. Fixture
 *     cases 139/140 pin BOTH poles of that derivation — the anchored form finds exactly the arms,
 *     and the unanchored form matches this very sentence — so the anchor cannot be dropped back
 *     to the self-matching shape without a red.
 *
 *   PARTIAL SHORTFALL — HALF PROMOTED (loom#2004), and the split is the point.
 *
 *     MEASURED, from the corpus this note originally said did not exist. It does now:
 *     `.claude/learning/dispatch-reconcile/*.jsonl`, 44 files / 43 distinct sessions
 *     (the >=30 the protocol asked for), 14,983 records, 12,289 carrying
 *     `reconcile().parallelism`. Of those, 5,745 sit at or above DECLARED_FLOOR — the
 *     live population — split 3,197 zero-dispatch / 2,244 PARTIAL / 304 met-or-exceeded.
 *
 *     The PARTIAL arm is NOT one population. It divides cleanly at the floor itself:
 *
 *       dispatched === 1   1,271 rows (57%)   declared p50 5, p90 10, MAX 27
 *       dispatched >= 2      973 rows (43%)   ratio p50 0.50, max 0.80
 *
 *     ONE LANE IS NOT PARALLELISM. A session that enumerated 27 independent sub-parts
 *     and opened a single lane did not partially parallelize; it ran serially and
 *     dispatched once. That arm is now ADVISE, and it introduces NO new constant — it
 *     reuses DECLARED_FLOOR, because "parallel" means at least two lanes by definition.
 *     A boundary has no free parameter to get wrong, which is the same property that
 *     made the zero-dispatch arm safe to ship advising.
 *
 *     THE OTHER 43% STAYS OBSERVE, deliberately. Where two or more lanes DID run and
 *     fell short, "correct decomposition" and "four sub-parts run serially" are
 *     genuinely indistinguishable from the counts — the ambiguity this note named. The
 *     protocol's own gate (pick the ratio at which precision clears ~0.8) requires
 *     HAND-LABELS for whether the un-dispatched sub-parts were independent, and NO
 *     ledger field records that. It is not derivable from the 2,244 rows, however many
 *     there are. So the ratio is still uninvented, and this module still MUST NOT
 *     invent it: a fabricated N presented as calibrated remains worse than an honest
 *     observing arm. What changed is that 57% of the arm no longer needs one.
 *
 * ─── THE SESSION-VOLUME ARM (loom, 2026-08-31) — ORTHOGONAL, AND WHY THE OBVIOUS SHAPE FAILS ──
 *
 * Everything above is PER-PROMPT: `reconcile().parallelism` compares the LAST `declared` row's
 * sub-part count against the launches that followed it. That arm is QUIET at `declared: 0`, by its
 * own contract — and `declared: 0` is the HIGHEST-VOLUME case, because an open-ended operator
 * directive ("aggressively drain and top up your fleet") enumerates nothing. A whole session can
 * therefore run serially, for hours, with this detector correctly silent throughout.
 *
 * MEASURED, on `.claude/learning/dispatch-reconcile/*.jsonl` — 44 files, 44 distinct sessions,
 * 1,064 `declared` rows, 563 main-generation `launch` rows, 174 nested ones:
 *
 *   The obvious session-level shape — "many prompts AND max `parallelism.dispatched` across the
 *   session === 0" — CANNOT SEE THE DEFECT IT WAS WRITTEN FOR. It fires on 3 of 44 sessions, and
 *   the session that motivated this arm (2026-08-30T08:44..16:19Z, 40 prompts, the last 21 of them
 *   consecutive with no lane at all) is NOT one of them: its session max is 8, because it DID
 *   dispatch — earlier, then stopped. Reading a PER-PROMPT rider as a SESSION fact is
 *   `instrument-discipline.md` MUST-4's wrong-question shape, and it fails in the fail-OPEN
 *   direction, which is the one that matters.
 *
 * So the quantity here is a RUN, not a max: consecutive main-generation `declared` rows with no
 * intervening main-generation `launch` row. It resets to 0 the moment a lane opens, so it reads
 * "how long has this orchestrator been going it alone" rather than "did it ever delegate".
 *
 *   SERIAL_RUN_FLOOR = 12. NOT invented, and not a percentile. The per-session MAXIMUM run over
 *     the 44-session corpus is:
 *
 *       2 2 3 3 4 4 5 5 5 6 6 6 6 6 6 6 6 7 7 7 7 8 8 8 8 8 8 8 9 9 9
 *       10 10 10 10 10 11 | 13 14 16 18 21 22 24
 *
 *     Sweep: N=10 fires on 13/44 (29.5%), N=11 on 8/44 (18.2%), N=12 and N=13 on the SAME 7/44
 *     (15.9%), N=14 on 6/44.
 *
 *     THE ORIGINAL JUSTIFICATION FOR 12 WAS WRONG AND IS WITHDRAWN (2026-08-31, after an
 *     independent re-derivation). It read: "every integer 2..11 is occupied, 12 is EMPTY, so the
 *     floor is an observed gap in the distribution, not a tuned parameter." That argument does not
 *     discriminate, by this corpus's own shape: the tail holds 7 sessions spread over 12 integer
 *     bins and SIX of them are empty (12, 15, 17, 19, 20, 23). At ~0.6 sessions/bin an empty bin is
 *     simply what a sparse tail produces, WHETHER OR NOT 12 is a real boundary — so emptiness at 12
 *     would look identical if the proposition were false. 12 was the first of six empty bins, not a
 *     distinctive gap. The body/tail split also turned on a SINGLE session (one session at maxRun
 *     11 is the whole of "the body ends at 11").
 *
 *     WHAT THE CORPUS ACTUALLY SUPPORTS is a STABILITY argument, and that is the ground now: N=12
 *     and N=13 fire on the IDENTICAL 7-session set, and that set is unchanged when the corpus grows
 *     (re-derived at 45 files: still the same 7). So any floor in {12, 13} gives the same behaviour,
 *     catches the motivating session and both persistent zero-dispatch sessions, and is insensitive
 *     to corpus growth. 12 is taken as the LOWER EDGE of that stable band — a choice that does not
 *     turn on any single bin. Case 62 in the fixtures asserts exactly this property, and case 62b
 *     pins the refuted one as falsified so it cannot be quietly re-derived.
 *
 *     IT DOES NOT ONLY CATCH NON-DELEGATING SESSIONS, and an earlier draft of this note claimed it
 *     did ("stays quiet on the 44-session body, including every session that sustained parallel
 *     work"). MEASURED, that is FALSE: 3 of the 7 caught sessions dispatched heavily — one ran 26
 *     main-generation launches across 76 prompts and still fires on a maxRun of 14. The arm catches
 *     long serial STRETCHES inside otherwise-parallel sessions. That is the intended behaviour (the
 *     quantity is a run, not a session total, precisely so a lane early on cannot immunise the
 *     tail), but the promise the old sentence made was the opposite one, and it was wrong.
 *
 *     It fires on the motivating session (max run 21). THREE sessions dispatched nothing at all
 *     across their whole life (2, 16 and 18 prompts); the arm catches two of them and correctly
 *     skips the 2-prompt one, which is below any floor.
 *
 *     THE CORPUS IS A LIVE, SELF-REFERENTIAL GLOB and these raw counts will NOT reproduce. The
 *     session re-deriving them writes its own rows into `.claude/learning/dispatch-reconcile/`
 *     while measuring, so the observer is inside the population: a re-derivation already reads 45
 *     files. Treat "44 files / 1064 / 563" as a SNAPSHOT taken 2026-08-31, not as a reproducible
 *     assertion, and re-derive the SWEEP and the firing SET — which are stable — rather than the
 *     raw totals, which are not. The directory is untracked and exists only in the primary clone,
 *     so a fresh worktree cannot re-derive any of it.
 *
 *   THIS ARM DERIVES A QUANTITY THE RECONCILER DOES NOT COMPUTE, so it is not the second count the
 *     "NO SECOND COUNT" doctrine above forbids. `reconcile()` exposes no run length and no session
 *     totals; there is nothing here to drift against. It reads the SAME rows through the same
 *     main-generation attribution rule the parallelism rider uses (`generation === MAIN_GENERATION`,
 *     file order as the total order), deliberately, so the two arms cannot disagree about whose
 *     dispatch a launch was.
 *
 *   ITS BOUNDS ARE THE SAME BOUNDS. It cannot tell a genuinely serial task from a decomposable one,
 *     so it WILL false-positive on legitimately sequential work (a long release walk, a migration
 *     performed step by step). Advisory severity is what makes that acceptable. CORRECTED
 *     2026-08-31: an earlier draft justified this with "a blocking version is unavailable anyway:
 *     `Stop` cannot block at any severity". That is FALSE — `instruct-and-wait.js` implements an
 *     opt-in Stop hand-back refusal (`decision:"block"`, default OFF), and this repo's
 *     `lane-completion-guard.js` uses it. Advisory is a CHOICE here, made because a false positive
 *     is unclearable by the agent: a refusal would consume the hand-back budget and proceed anyway.
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
 * AND THE STATE HAS TO SURVIVE THE RENDERER, which for the session arm it did not until 2026-08-31.
 * UNKNOWN rendered null, so a corrupt ledger and a well-delegating session produced byte-identical
 * output — the distinction the tri-state exists for, erased one function later. The split now drawn
 * is INSTRUMENT-DID-NOT-RUN (no ledger: fresh clone, CI, pre-first-prompt — stays silent, because a
 * line on every one of those is the noise that teaches a reader to skip this hook) versus
 * INSTRUMENT-RAN-BROKEN (a sink that was read and yielded zero usable rows — SPEAKS, once per
 * session). See `formatSessionVolumeAdvisory`.
 *
 * THE SESSION ARM'S DEDUPE KEYS ON A CROSSING ORDINAL, not on the run length: the run RESETS, so a
 * length-derived key silenced every serial stretch after the first for the life of the session. See
 * `sessionVolumeSignatureOf` for the measured relapse and the fix.
 *
 * ─── THE LANE-DEPTH ARM (`rules/wip-discipline.md` MUST-9; journal/0607 + 0608 item 6) ────────
 *
 * A DIFFERENT QUESTION from every arm above, and a different rule. Those ask whether the
 * ORCHESTRATOR delegated; this one asks whether a LANE the work ledger shows UNDER-PACKED got any
 * agents from THIS session. `detectUnderPackedLane` is its pure half; `delegation-default-guard.js`
 * reads the ledger and runs it at `Stop`, where both the session's dispatches and the ledger exist.
 *
 * NO SECOND VERDICT. The per-lane verdict is `wip-lanes.js::laneDepth`'s `lanes[].verdict`, consumed
 * verbatim. This module never re-runs `laneDepthVerdict`; it only adds the one fact `laneDepth`
 * records as UNATTRIBUTED — how many agents this session dispatched for each lane.
 *
 * ATTRIBUTION IS STRUCTURAL, from `dispatch-ledger.js` launch rows only, never from prose:
 *   - a launch row whose `lane`/`branch` value NAMES the lane, or whose `worktree`/`cwd` value is a
 *     path the caller's `git worktree list` map resolves to the lane's branch, is FOR that lane;
 *   - a row carrying none of those keys — every row today, because `buildLaunchRecord` writes none —
 *     makes the lane UNATTRIBUTED, never zero: that dispatch could have been for any lane;
 *   - ZERO is claimed only from a ledger that was READ, parsed with NOTHING skipped, and holds no
 *     unidentified launch row. A skipped line could be a launch, so it is UNMEASURED.
 *
 * `halt-and-report` CEILING, NEVER `block`, NEVER A HAND-BACK REFUSAL. Item and agent counts are
 * structural; whether a lane's work decomposes is judgment (`hook-output-discipline.md` MUST-2).
 * UNATTRIBUTED and UNMEASURED findings are `advisory` — their agent half was not measured.
 *
 * Origin: loom#1752, closing the surface gap `orchestrator-context-economy.md` § Wiring recorded
 * ("MUST-1..4 are review-layer only"). The lane-depth arm: journal/0607 + 0608.
 */

"use strict";

const path = require("node:path");

// NO bare `fs` import here, DELIBERATELY. Both of this module's sink touches — the marker read and
// the marker write — go through `append-sink.js`, which owns the containment. A convenience `fs`
// binding in scope is how the naive `statSync`/`readFileSync` read got written next to a hardened
// write in the first place (loom#1762 CRITICAL 1); leaving it out makes the unhardened path
// something a future edit has to ADD an import to reach, rather than something already at hand.
const { appendSinkLine, readSinkFile } = require("./append-sink.js");

// The orchestrator-generation sentinel, IMPORTED from the producer rather than restated. A local
// copy would be a second definition of a join key, which is the drift class this module's
// "NO SECOND COUNT" doctrine exists to prevent.
const { MAIN_GENERATION, resolveSessionId } = require("./dispatch-ledger.js");

/**
 * The declared-sub-part floor. INHERITED from `dispatch-ledger.js::reconcile`, not chosen here.
 * `assertFloorMatchesReconciler` pins the equality; see the calibration note.
 */
const DECLARED_FLOOR = 2;

/**
 * The consecutive-serial-prompt floor for the SESSION-VOLUME arm. CALIBRATED, not chosen — but NOT
 * on the "empty bin" argument an earlier revision of THIS LINE still carried after the calibration
 * note above had already withdrawn it. That argument (12 is empty in the corpus, so it is a gap) is
 * REFUTED and must not be re-derived from here: six of the twelve tail bins are empty, so emptiness
 * at 12 would look identical whether or not 12 is a real boundary.
 *
 * The ground is STABILITY: N=12 and N=13 fire on the IDENTICAL 7-session set over the
 * `.claude/learning/dispatch-reconcile/` corpus and N=11 fires strictly wider, so 12 is the LOWER
 * EDGE of a band whose behaviour turns on no single bin. Full distribution and sweep in the
 * calibration note; re-derive from the corpus rather than trusting this line.
 */
const SERIAL_RUN_FLOOR = 12;

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
  if (dispatched < DECLARED_FLOOR) {
    // ONE lane is not parallelism. This reuses DECLARED_FLOOR rather than introducing a
    // ratio: "parallel" means at least two lanes by definition, so this is a BOUNDARY
    // with no free parameter to get wrong — the same property that made the
    // zero-dispatch arm safe to ship advising. See the calibration note above for the
    // measurement that showed this boundary carries most of the arm.
    return {
      state: "ADVISE",
      declared,
      dispatched,
      reason: `${declared} sub-parts declared, ${dispatched} lane dispatched — one lane is not parallel execution.`,
    };
  }
  return {
    state: "OBSERVE",
    declared,
    dispatched,
    reason: `${declared} sub-parts declared, ${dispatched} lane(s) dispatched — a PARTIAL shortfall above the ${DECLARED_FLOOR}-lane boundary, whose ratio is uncalibrated.`,
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
 * THE SESSION-VOLUME ARM. Orthogonal to `assessDelegationDefault` above: that one asks whether the
 * LAST PROMPT's enumerated sub-parts went to lanes; this one asks whether THIS SESSION has been
 * running alone, regardless of whether any prompt enumerated anything at all.
 *
 * Takes the RAW ledger rows for the current session and returns the same tri-state verdict shape.
 * Pure: no IO, no clock. Every arm below is a fixture case.
 *
 * The quantity is a RUN — consecutive main-generation `declared` rows with no intervening
 * main-generation `launch` row — NOT a session maximum. The calibration note above records the
 * measurement showing why the maximum cannot see the defect this arm exists for.
 *
 * ATTRIBUTION MATCHES THE RECONCILER, deliberately: a `launch` row from a SUBAGENT generation is a
 * nested lane's own dispatch, not the orchestrator delegating, so it does NOT reset the run. File
 * order is the total order, exactly as `reconcile`'s parallelism rider treats it — the sink is
 * append-only, so position is a total order no clock skew can corrupt.
 *
 * CROSSINGS, and why the walk carries them. The RUN alone cannot key a dedupe: it resets, so a
 * second stretch past the floor is numerically indistinguishable from the first, and a signature
 * derived from it suppresses every stretch after the first for the life of the session (MEASURED —
 * see `sessionVolumeSignatureOf`). `crossings` is the ORDINAL of the current stretch: the number of
 * serial runs in this session that have REACHED the floor, counting the current one. It is
 * incremented in THIS walk at the moment `run` first equals the floor, so it adds no second pass and
 * no second stored count.
 *
 * BROKEN-INSTRUMENT INPUT. `skipped` is `readLedger`'s own count of lines that did not parse into a
 * usable record. It is threaded in rather than re-derived, because this module never reads the sink.
 * When the ledger was READ but produced zero usable rows and `skipped > 0`, the verdict is still
 * UNKNOWN — nothing was measured — but it is flagged `corrupt`, because that UNKNOWN is a BROKEN
 * DETECTOR rather than an absent one, and the two must not render identically.
 *
 * @param {object[]|null} rows
 * @param {{reason?:string}} [failure] typed reason when the ledger read failed
 * @param {number} [skipped] `readLedger().skipped` — lines in THIS session's sink that did not
 *   parse into a usable record, INCLUDING blank and whitespace-only lines (which are the residue
 *   of a torn create; see `dispatch-ledger.js::readLedger`). It distinguishes a ledger that RAN
 *   and parsed to nothing (a BROKEN INSTRUMENT, which speaks) from one that was simply absent
 *   (which stays silent).
 * @param {string} [sessionId] the SESSION FENCE. When supplied, rows carrying a DIFFERENT
 *   `session_id` are dropped; a row with none counts as ours. Omit it and the fence is INERT,
 *   which is what keeps every pre-fence caller's verdict unchanged. Read the WITHDRAWAL in the
 *   body before trusting it: the fence does NOT close the pooling hazard.
 * @returns {{state:string,run:number|null,prompts:number|null,dispatched:number|null,crossings:number,skipped:number,corrupt:boolean,reason:string|null}}
 */
function assessSessionVolume(rows, failure, skipped, sessionId) {
  const skippedCount = Number.isInteger(skipped) && skipped > 0 ? skipped : 0;
  if (!Array.isArray(rows)) {
    // A READ THAT RAN AND REFUSED IS A BROKEN INSTRUMENT, NOT AN ABSENT ONE (loom#1762, the third
    // defect). This branch used to hard-code `corrupt: false`, so an over-cap ledger, a symlinked
    // ledger, a hard-linked one, and an ENAMETOOLONG session id ALL rendered null at the output
    // boundary — BYTE-IDENTICAL to a well-delegating session. `readLedger` computed a precise
    // refusal reason and this arm discarded it, which is the exact non-discriminating-instrument
    // shape the `corrupt` state was introduced for one layer down.
    //
    // THE DISCRIMINATOR IS STRUCTURAL, never a string-match on `reason`: `readLedger` now carries
    // `absent` on every failure shape. `absent === true` is the genuinely-missing case (fresh
    // clone, CI, no dispatches) and stays SILENT, which is the case the noise rule was written
    // for. Anything else the read REFUSED speaks.
    //
    // CORRECTED (loom#1762 follow-up, CRITICAL B). That paragraph read as a claim about the
    // PRODUCER — that `absent === true` IS the genuinely-missing case — and as such it was FALSE
    // when written. `readSinkFile` reached `absent:true` through `fs.realpathSync(sinkDir)`
    // raising ENOENT, and ENOENT is raised for a DANGLING SYMLINK exactly as for a missing
    // directory, so a planted link was laundered into the silent disposition. MEASURED end-to-end
    // through this guard: honest tree 2961 bytes of advisory, dangling link at the sink directory
    // 18 bytes — `{"continue":true}` — and DURABLY so, because the write half's `mkdir` fails
    // against the same link forever. The producer now lstats that path and refuses it, so the
    // sentence above is true of the CURRENT producer and was not of the previous one. This arm was
    // never wrong; what it consumed was. Pinned as case 112.
    //
    // NAMED RESIDUAL, deliberately left silent rather than guessed at: a failure object carrying
    // NO `absent` field at all. That is the guard's SYNTHESIZED failure for "the main checkout
    // could not be resolved", where no read was attempted, so nothing was measured about a ledger
    // and nothing is known about its absence. Treating it as corrupt would put a BROKEN INSTRUMENT
    // line in every Stop of every session running outside a resolvable checkout — the noise that
    // teaches a reader to skip this hook. It therefore keeps its pre-existing silence, and that is
    // a DESIGN CALL left open, not a case this fix claims to have closed. Pinned as case 108.
    const readRefused = !!failure && failure.absent === false;
    return {
      state: "UNKNOWN",
      run: null,
      prompts: null,
      dispatched: null,
      crossings: 0,
      skipped: skippedCount,
      corrupt: readRefused,
      // WHICH broken instrument, so the renderer never claims "not one of its 0 lines parsed"
      // about a file it was refused before reading. Two different failures, two different lines.
      corrupt_kind: readRefused ? "read-refused" : null,
      reason:
        (failure && failure.reason) ||
        "the dispatch ledger was not readable for this session, so the number of prompts issued " +
          "and lanes dispatched is UNKNOWN. This is NOT a clean result — it does not mean the " +
          "session delegated correctly.",
    };
  }

  let run = 0;
  let prompts = 0;
  let dispatched = 0;
  let foreign = 0;
  let crossings = 0;
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    // SESSION FENCE — load-bearing since 2026-09-01, and NOT before. Read the history, because
    // this comment has been wrong in BOTH directions and the correction is the argument.
    //
    // CLAIM 1 (the commit that added the fence): "this closes the cross-session pooling hazard."
    // FALSE, and refuted by two independent adversarial lanes.
    // CLAIM 2 (the withdrawal, 2026-08-31): "it cannot close it, and the hazard is OPEN."
    // TRUE AT THE TIME, and now SUPERSEDED — by a fix at the PRODUCER, not by another predicate
    // here, exactly as that withdrawal said would be required.
    //
    // WHY CLAIM 2 HELD: `dispatch-ledger.js::appendRecord` keys the sink FILE on the row's OWN
    // `record.session_id`, so file key === row session_id for every row the shipped writers
    // produce, and two sessions could share a file only by resolving to the SAME id. The one way
    // that happened was the SHARED CONSTANT `"unknown-session"`, which the producer, this
    // consumer, both path mappers and the record builder ALL fell back to. In that file every row
    // AND the reader carried that literal, so `r.session_id !== sessionId` was NEVER true and
    // nothing was fenced. Measured end-to-end at the time: a foreign lane reset the run and
    // silenced a true 12-prompt finding (`QUIET, run 6` where the control read `ADVISE, run 12`).
    //
    // WHAT CHANGED: `dispatch-ledger.js::resolveSessionId` is now the ONE resolution for all five
    // sites, and its no-session rung derives `unknown-<hostPid>-<hash>` per HOST PROCESS. Two
    // id-less sessions therefore resolve to DIFFERENT ids and land in DIFFERENT sinks. Pooling by
    // shared constant is unreachable, not merely unlikely.
    //
    // WHAT THIS PREDICATE BUYS NOW, bounded so it is not over-read in the other direction: it is
    // the SECOND line of defence, not the first. The first is that the sinks no longer collide.
    // The fence drops a genuinely-foreign row from a file that got one some other way — a
    // hand-written file, a migrated one, a future writer's, or the pre-fix pooled sink if a
    // reader is ever pointed at it. It still could not rescue a file whose rows are
    // byte-identical in the only field that identifies them; no predicate here could, which is
    // why the fix had to be at the producer. Fixture case 85 drives the distinguishable shape;
    // the producer-side cases drive the collision itself.
    //
    // Original rationale follows, still accurate as to WHY a fence was wanted:
    //
    // This arm aggregates the WHOLE file, where the per-prompt rider reads only rows after the last
    // `declared` row. That widening is the point of the arm — a run is not a tail — but it also
    // widened the blast radius of any foreign row from tail-bounded to total, and the docblock above
    // says the run is read "for the current session" while NOTHING enforced it.
    //
    // The sink is session-keyed by filename, so this should normally drop nothing. It USED to
    // matter because `session_id` had a literal `"unknown-session"` fallback at FIVE independent
    // sites (the count was recorded as THREE here and was itself wrong — the record builder
    // `_base` and `markerPath` were missed), reachable with no attacker at all:
    // `readStdinBounded` resolves `{}` on TTY stdin, empty stdin, a parse error, an over-ceiling
    // payload, or a timeout. Two sessions that each hit any of those shared one file; one
    // session's `launch` rows then reset the other's run and SILENTLY SUPPRESSED a true finding.
    // That is the path now closed at the producer.
    //
    // A row with NO `session_id` is treated as OURS, deliberately: the file is already session-keyed,
    // so an absent field is an older producer's row for this session, not a foreign one. Dropping it
    // would shrink `prompts` toward 0 and read as UNKNOWN — turning a legacy ledger silently
    // unmeasured, which is the absence-reads-as-clean shape this whole arm exists against.
    if (
      _isNonEmptyString(sessionId) &&
      _isNonEmptyString(r.session_id) &&
      r.session_id !== sessionId
    ) {
      foreign++;
      continue;
    }
    const generation = _isNonEmptyString(r.generation) ? r.generation : MAIN_GENERATION;
    if (generation !== MAIN_GENERATION) continue;
    if (r.kind === "declared") {
      prompts++;
      run++;
      // The ordinal ticks exactly ONCE per stretch, at the crossing itself. Same walk, same rows.
      if (run === SERIAL_RUN_FLOOR) crossings++;
    } else if (r.kind === "launch") {
      dispatched++;
      run = 0;
    }
  }

  // A ledger with no prompt rows at all measures nothing about volume. QUIET here would report
  // "this session issued no prompts" in the grammar of "this session delegated fine", which is the
  // absence-reads-as-cleanliness failure the tri-state exists to prevent.
  if (prompts === 0) {
    // TWO DIFFERENT UNKNOWNS, and only one of them is safe to swallow. "The ledger was never
    // written" (fresh clone, CI, pre-first-prompt) is the instrument NOT RUNNING, and rendering on
    // it would put a line in every such session — the noise that teaches a reader to skip this
    // hook. "The ledger WAS read and not one line parsed" is the instrument RUNNING BROKEN, and it
    // is byte-identical to a well-delegating session at the output boundary unless it says so.
    // CORRECTED 2026-08-31 after an adversarial round MEASURED the leak. This read
    // `rows.length === 0 && skippedCount > 0`, which asks a DIFFERENT question than the branch it
    // sits in. We are already inside `prompts === 0` — nothing was measured — but `rows.length`
    // counts EVERY record kind, so ONE parsable `launch`, `delivery` or `reconcile` row set
    // `rows.length > 0` and disarmed the whole state. Measured at the output boundary: a sink of
    // 1 `launch` row plus 200 unparseable lines produced stdout and stderr BYTE-IDENTICAL to a
    // well-delegating session, with a positive control (all-200-corrupt) proving the comparison
    // discriminates. A true 12-prompt serial stretch whose `declared` rows were corrupted was
    // likewise invisible.
    //
    // The commit that shipped it justified the old form as "partial corruption does not fire —
    // usable rows mean it measured something". That rationale is falsified by its own code path:
    // inside this branch `prompts === 0`, so nothing WAS measured, whatever `rows.length` says.
    // The predicate now keys on the branch it is already in.
    const corrupt = skippedCount > 0;
    return {
      state: "UNKNOWN",
      run: null,
      prompts: 0,
      dispatched,
      crossings: 0,
      skipped: skippedCount,
      corrupt,
      corrupt_kind: corrupt ? "all-unparseable" : null,
      reason: corrupt
        ? `the ledger was READ but not one of its ${skippedCount} line(s) parsed into a usable ` +
          "record, so this detector measured NOTHING. The instrument is BROKEN, not clean."
        : "the ledger recorded no prompt rows for this session, so serial-run volume is UNKNOWN. " +
          "Not clean — nothing was measured.",
    };
  }

  if (run >= SERIAL_RUN_FLOOR) {
    return {
      state: "ADVISE",
      run,
      prompts,
      dispatched,
      crossings,
      skipped: skippedCount,
      corrupt: false,
      corrupt_kind: null,
      reason:
        `${run} consecutive prompts with ZERO lanes dispatched (${prompts} prompt(s) and ` +
        `${dispatched} lane(s) this session; serial stretch #${crossings} past the floor).`,
    };
  }

  return {
    state: "QUIET",
    run,
    prompts,
    dispatched,
    crossings,
    skipped: skippedCount,
    corrupt: false,
    corrupt_kind: null,
    reason:
      `${run} consecutive prompt(s) since the last lane was dispatched, below the ` +
      `${SERIAL_RUN_FLOOR} floor (${prompts} prompt(s), ${dispatched} lane(s) this session).`,
  };
}

/**
 * Render the session-volume verdict as ONE advisory block, or null when there is nothing to say.
 *
 * QUIET renders null. UNKNOWN renders null in the ONE case that earns it — the instrument never ran
 * — and SPEAKS in the case that does not.
 *
 * WHY THE SPLIT, MEASURED. An earlier revision returned null on every non-ADVISE verdict, and the
 * consequence was byte-identical stdout for (a) no ledger at all, (b) a ledger every line of which
 * was corrupt, and (c) a session that delegated well. Three propositions, one output: the
 * non-discriminating instrument `instrument-discipline.md` MUST-1 forbids citing — and the file's
 * OWN comment at `assessSessionVolume` argued that reporting this in the grammar of "this session
 * delegated fine" is the failure the tri-state exists to prevent, which the renderer then erased.
 *
 * The noise argument for staying silent is SOUND and is preserved exactly where it holds: UNKNOWN is
 * the state on a fresh clone, in CI, and before the first prompt row lands, so rendering on every
 * UNKNOWN would teach a reader to skip this hook. It does NOT hold for `corrupt` — a ledger that was
 * read and yielded nothing usable is a BROKEN DETECTOR, which is the whole failure class this rule
 * set exists to prevent, and it is rare by construction (it needs a written sink whose every line is
 * unparseable). It dedupes on its own signature, so it speaks once per session, not once per turn.
 */
function formatSessionVolumeAdvisory(verdict) {
  if (!verdict || typeof verdict !== "object") return null;
  // A READ THAT WAS REFUSED is a different broken instrument from one that was read and parsed to
  // nothing, and it must not borrow the other's sentence — "not one of its 0 line(s) parsed" about
  // a file we never opened would be a fabricated measurement (loom#1762, the third defect).
  if (verdict.state === "UNKNOWN" && verdict.corrupt === true && verdict.corrupt_kind === "read-refused")
    return (
      "[delegation-default] BROKEN INSTRUMENT — NOT a clean result. This session's dispatch ledger " +
      "could not be read AT ALL, and the refusal is NOT the ordinary 'no ledger yet' case: it was " +
      `REFUSED for a specific reason — ${verdict.reason} — so the delegation detector measured ` +
      "NOTHING this session. Silence from this hook normally means 'nothing to report'; here it " +
      "would have meant 'nothing could be reported', and those two are byte-identical at the " +
      "output boundary unless one of them says so. Treat every quiet turn since as UNVERIFIED, not " +
      "clean. Likely causes: a ledger over the read cap, a symlinked or hard-linked sink, a sink " +
      "directory that no longer resolves inside this checkout, or a session id that will not form " +
      "a valid path. ADVISORY, never a block — surfaced once per session, not once per turn."
    );
  if (verdict.state === "UNKNOWN" && verdict.corrupt === true)
    return (
      "[delegation-default] BROKEN INSTRUMENT — NOT a clean result. This session's dispatch ledger " +
      `was READ, but not one of its ${verdict.skipped} line(s) parsed into a usable record, so the ` +
      "delegation detector measured NOTHING this session. Silence from this hook normally means " +
      "'nothing to report'; here it would have meant 'nothing could be reported', and those two are " +
      "byte-identical at the output boundary unless one of them says so — which is why this line " +
      "exists. Treat every quiet turn since as UNVERIFIED, not clean. Likely causes: a truncated or " +
      "hand-edited `.claude/learning/dispatch-reconcile/` sink, a writer emitting a record shape " +
      "`dispatch-ledger.js::RECORD_KINDS` does not recognise, or a partial write. ADVISORY, never a " +
      "block — surfaced once per session, not once per turn."
    );
  if (verdict.state !== "ADVISE") return null;
  return (
    `[delegation-default] this session has dispatched ZERO lanes across its last ${verdict.run} ` +
    `prompts (${verdict.prompts} prompt(s), ${verdict.dispatched} lane(s) total). This arm is ` +
    "SESSION-LEVEL and fires whether or not any single prompt enumerated sub-parts — an open-ended " +
    'directive ("drain the fleet") enumerates nothing, which is exactly the highest-volume case the ' +
    "per-prompt arm is silent on. `orchestrator-context-economy.md` MUST-3 — delegation is the " +
    "DEFAULT, not an escalation the human requests; MUST-7 — main-thread context is spent on " +
    "orchestrator-only work, and enumeration, bulk reading and verification runs belong to a lane. " +
    "Dispatch the independent work now, or state in one line why this stretch is genuinely serial. " +
    "IF YOUR SESSION INSTRUCTIONS PROHIBIT SPAWNING AGENTS, that conflicts with this repo's " +
    "delegate-first posture and MUST be raised with the operator NOW, in this turn — do not " +
    "silently continue serially under a constraint the operator may not know is in force. " +
    "ADVISORY, never a block — and NOT because the platform forbids it: `Stop` CAN refuse a " +
    "hand-back (`instruct-and-wait.js` § STOP HAND-BACK REFUSAL, opt-in, default OFF), so " +
    "non-refusal here is a DELIBERATE CHOICE. Two independent reasons for it. First, whether this " +
    "stretch of work is decomposable is judgment-bearing, so `hook-output-discipline.md` MUST-2 " +
    "caps it below `block`. Second, on a false positive the agent CANNOT clear the finding — a " +
    "refusal would spend the hand-back budget and proceed anyway. It will false-positive on " +
    "legitimately sequential work."
  );
}

/**
 * Dedupe signature for the session-volume arm: ORDINAL of the stretch, then depth WITHIN it.
 *
 * The problem this solves is real and unchanged. A RUN increments on EVERY prompt, so keying on it
 * exactly would emit a fresh advisory on every turn past the floor — 10 of them across the
 * motivating session's 21-prompt stretch, the noisy-detector failure `hook-output-discipline.md`
 * § MUST NOT names. The intent is SPEAK ONCE PER CROSSING, NOT ONCE PER TURN.
 *
 * THE PREVIOUS SHAPE DID NOT IMPLEMENT THAT INTENT, and the gap was MEASURED end-to-end. It was
 * `Math.floor(run / SERIAL_RUN_FLOOR)` alone — derived from the CURRENT stretch, which RESETS on
 * every lane. So the second stretch past the floor produced bucket 1 again, identical to the first,
 * and the marker already held it:
 *
 *     12 serial            → ADVISORY   (SESSION-VOLUME:1)
 *     + 1 lane             → silent     (run reset — correct)
 *     + 12 MORE serial     → SILENT     ← the defect: a fresh crossing, permanently suppressed
 *     + 23 consecutive     → STILL SILENT
 *     fresh session, 12    → ADVISORY   (control: the arm itself was not inert)
 *
 * It needed an UNBROKEN 24 to speak a second time, and an unbroken run is precisely what a session
 * that occasionally dispatches does not have — the motivating session's own shape. The header's
 * claim that it "re-speaks only after a further FULL floor of serial work (12, 24, 36...)" was true
 * only of an unbroken run and false after any reset, which is the normal case.
 *
 * THE KEY IS NOW TWO ORDINALS, and neither is a new constant:
 *   `crossings` — how many stretches in this session have reached the floor, counting the current
 *     one. It never decreases, so every NEW crossing after a reset is a NEW key and speaks exactly
 *     once. Derived in `assessSessionVolume`'s existing row walk; no second walk, no second count.
 *   `floor(run / SERIAL_RUN_FLOOR)` — depth within the current stretch, retained so an UNBROKEN run
 *     still re-speaks at 24, 36 … (the property the old comment promised and only that case got).
 *
 * The ADVISE condition is untouched: `run >= SERIAL_RUN_FLOOR`, with the floor at its calibrated 12.
 * Only the dedupe changed, which is the correct blast radius for a suppression bug.
 *
 * The CORRUPT-input verdict gets its own fixed key so a broken instrument is reported once per
 * session rather than once per turn, and never dedupes against — or is deduped by — either arm.
 */
function sessionVolumeSignatureOf(verdict) {
  if (!verdict || typeof verdict !== "object") return "";
  if (verdict.state === "UNKNOWN" && verdict.corrupt === true) return "SESSION-VOLUME:CORRUPT";
  if (verdict.state !== "ADVISE") return "";
  const ordinal = Number.isInteger(verdict.crossings) ? verdict.crossings : 0;
  return `SESSION-VOLUME:${ordinal}:${Math.floor(verdict.run / SERIAL_RUN_FLOOR)}`;
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
  if (verdict.state === "ADVISE" && verdict.dispatched > 0)
    return (
      `[delegation-default] the last prompt declared ${verdict.declared} enumerated sub-parts and ` +
      `${verdict.dispatched} lane was dispatched for it. ONE lane is not parallel execution — this is the ` +
      "same at-least-two-lanes boundary the floor already encodes, not a tuned ratio. " +
      "`orchestrator-context-economy.md` MUST-3 — delegation is the DEFAULT, not an escalation the human " +
      "requests. Dispatch the remaining independent sub-parts, or state why they are not independent. " +
      "ADVISORY, never a block: the sub-part COUNT is structural, but whether those parts are INDEPENDENT " +
      "is judgment-bearing, so `hook-output-discipline.md` MUST-2 caps this below `block`."
    );
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
      `${verdict.dispatched} lanes were dispatched for it. Parallelism DID happen and fell short, which is the ` +
      "genuinely ambiguous half — correct decomposition and serial sub-parts look identical from the counts. " +
      "The RATIO at which that becomes a finding is still UNCALIBRATED: it needs hand-labels for whether the " +
      "un-dispatched parts were independent, which no ledger field records. See the calibration note in " +
      "`.claude/hooks/lib/delegation-default.js`. A measurement, not a verdict; do not act on it as one."
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

/**
 * Per-session dedupe marker. Mirrors `dispatch-ledger.js::_sinkPath`'s injective mapping AND —
 * since 2026-09-01 — its session resolution, which is IMPORTED rather than restated. The literal
 * `"unknown-session"` that used to sit here was the FIFTH copy of one shared constant; a marker
 * keyed on it put every id-less session's dedupe state into one file, so the FIRST such session's
 * signature suppressed every later one's advisory.
 */
function markerPath(repoDir, session) {
  const crypto = require("node:crypto");
  const raw = resolveSessionId(session);
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  const suffix = crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  return path.join(repoDir, ".claude", "learning", "delegation-default", `${safe}-${suffix}.jsonl`);
}

/**
 * Has this exact signature already been surfaced this session?
 *
 * FAILS OPEN — an unreadable, absent, or REFUSED marker returns false, so the advisory is emitted.
 * The failure direction is deliberate and is the opposite of the ledger's: a lost dedupe costs one
 * repeated line, a wrongly-suppressed advisory costs the whole finding. Containment refusals join
 * that same branch on purpose: a marker we cannot safely read is a marker we do not honour.
 *
 * ## The read is CONTAINED, and it was not before (loom#1762 CRITICAL 1)
 *
 * This function used bare `fs.statSync` + `fs.readFileSync` with NO resolution and NO
 * `O_NOFOLLOW`, while its own write half (`markSurfaced`) routes through `append-sink.js`, which
 * resolves the deepest existing ancestor against the declared root, refuses a symlinked ancestor,
 * and opens `O_NOFOLLOW`. A hardened write paired with a naive read is not half a defense — the
 * attacker simply picks the read.
 *
 * MEASURED before the fix: symlinking this marker path at an out-of-tree 2-line poison file
 * carrying the enumerated signature took a genuine finding from 3647 bytes of advisory to 18
 * bytes — BYTE-IDENTICAL to a clean session. The dedupe suppressed the entire advisory on the
 * strength of a file outside the repository.
 *
 * The read now goes through `append-sink.js::readSinkFile`, which is the SAME containment code the
 * append path runs — not a second copy of it (`rules/security.md` § Path Containment requires both
 * candidate and boundary root resolved through the same resolver; a re-implementation here would
 * be the drift class this corpus keeps finding). It also carries the byte cap as a bound on the
 * READ rather than on a preceding stat.
 *
 * ## WHAT THIS DOES NOT CLOSE — read this before treating the marker as trustworthy
 *
 * Containment stops the marker read from LEAVING the repository. It does NOT stop an attacker who
 * simply WRITES the predictable in-tree marker path with enumerated signatures: that file resolves
 * inside the root, is a regular file, and passes every check `readSinkFile` makes. MEASURED: a
 * pre-planted in-tree marker of 1,049 enumerated-signature lines (55,644 bytes) is a TOTAL silent
 * disarm of this detector. Closing that half needs an UNPREDICTABLE key — a session-scoped HMAC
 * over the signature, so the attacker cannot enumerate what to write — which is a DESIGN decision
 * and is deliberately NOT implemented here. Do not describe this path as trusted; it is contained.
 * Pinned as fixture case 98, so the open half cannot be quietly believed closed.
 */
function alreadySurfaced(repoDir, session, sig) {
  if (!sig) return false;
  try {
    const p = markerPath(repoDir, session);
    const r = readSinkFile({ repoDir, sinkPath: p, maxBytes: MAX_MARKER_BYTES });
    // EVERY refusal — absent, symlinked, over-cap, hard-linked, containment-failed — lands here
    // and returns false, which EMITS the advisory. That is the safe direction and is the same one
    // the original `catch { return false }` took; what changed is that a symlinked or out-of-tree
    // marker now reaches it instead of being read and honoured.
    if (!r.ok) return false;
    return r.text.split("\n").some((l) => {
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

// ─── THE LANE-DEPTH ARM — `rules/wip-discipline.md` MUST-9 ────────────────────────────────────────

/** Lane-arm verdict vocabulary. Closed. NOT-RUN and QUIET render nothing; UNKNOWN and REPORT speak. */
const LANE_ARM_STATES = Object.freeze(["REPORT", "QUIET", "UNKNOWN", "NOT-RUN"]);

/** Per-lane attribution of this session's dispatches. Closed. */
const LANE_ATTRIBUTIONS = Object.freeze(["ZERO", "ATTRIBUTED", "UNATTRIBUTED", "UNMEASURED"]);

/**
 * Launch-row keys joined BY NAME and BY PATH. Their union MUST equal
 * `wip-lanes.js::LANE_ATTRIBUTION_KEYS` — the ledger module's declaration of which keys could
 * attribute a dispatch. A fixture pins that equality, so a key added there reds here instead of being
 * silently ignored (an ignored key would read a row as unidentified: safe, but blind).
 */
const LANE_NAME_KEYS = Object.freeze(["lane", "branch"]);
const LANE_PATH_KEYS = Object.freeze(["worktree", "cwd"]);

/** Rendering caps, so a large forest cannot turn one Stop line into a wall. */
const MAX_REPORTED_UNDER_PACKED = 8;
const MAX_REPORTED_QUEUED = 5;

/** A NOT-RUN verdict: the instrument did not run. Rendered silent, like every not-run arm above. */
function laneArmNotRun(reason) {
  return {
    state: "NOT-RUN",
    severity: null,
    lanes: [],
    suppressed: [],
    queued: [],
    counts: null,
    launches: null,
    kind: null,
    reason: _isNonEmptyString(reason) ? reason : "the lane-depth arm did not run",
  };
}

/**
 * Attribute this session's launch rows to lanes. Pure.
 *
 * The session fence is the SAME predicate `assessSessionVolume` applies: a row naming a DIFFERENT
 * `session_id` is dropped; a row with none counts as ours. Launch rows are deduped on `launch_id`
 * where they carry one, as `dispatch-ledger.js::reconcile` does.
 *
 * @param {{rows:object[]|null, failure?:{reason?:string}, skipped?:number, sessionId?:string,
 *          laneNames:string[], worktreeLanes?:object|null}} a
 * @returns {{ok:false, reason:string} | {ok:true, total:number, perLane:Map<string,number>,
 *          unidentified:number, elsewhere:number, skipped:number}}
 */
function attributeLaunchesToLanes(a) {
  const o = a && typeof a === "object" ? a : {};
  if (!Array.isArray(o.rows)) {
    return {
      ok: false,
      reason:
        (o.failure && o.failure.reason) ||
        "the dispatch ledger was not read, so no dispatch this session can be counted for any lane",
    };
  }
  const names = new Set((Array.isArray(o.laneNames) ? o.laneNames : []).filter(_isNonEmptyString));
  const byPath = new Map();
  if (o.worktreeLanes && typeof o.worktreeLanes === "object") {
    for (const [p, b] of Object.entries(o.worktreeLanes))
      if (_isNonEmptyString(p) && _isNonEmptyString(b)) byPath.set(path.resolve(p), b);
  }
  const perLane = new Map();
  const seen = new Set();
  let total = 0;
  let unidentified = 0;
  let elsewhere = 0;
  for (const r of o.rows) {
    if (!r || typeof r !== "object" || r.kind !== "launch") continue;
    if (
      _isNonEmptyString(o.sessionId) &&
      _isNonEmptyString(r.session_id) &&
      r.session_id !== o.sessionId
    )
      continue;
    if (_isNonEmptyString(r.launch_id)) {
      if (seen.has(r.launch_id)) continue;
      seen.add(r.launch_id);
    }
    total++;
    let lane = null;
    for (const k of LANE_NAME_KEYS) {
      if (_isNonEmptyString(r[k])) {
        lane = r[k];
        break;
      }
    }
    if (lane === null) {
      for (const k of LANE_PATH_KEYS) {
        if (_isNonEmptyString(r[k]) && byPath.has(path.resolve(r[k]))) {
          lane = byPath.get(path.resolve(r[k]));
          break;
        }
      }
    }
    if (lane === null) unidentified++;
    else if (names.has(lane)) perLane.set(lane, (perLane.get(lane) || 0) + 1);
    else elsewhere++;
  }
  const skipped = Number.isInteger(o.skipped) && o.skipped > 0 ? o.skipped : 0;
  return { ok: true, total, perLane, unidentified, elsewhere, skipped };
}

/** One lane's attribution, from an `attributeLaunchesToLanes` result. Pure. */
function _laneAttribution(att, lane) {
  if (!att || att.ok !== true)
    return { attribution: "UNMEASURED", agents: null, zeroKind: null, basis: (att && att.reason) || "no attribution" };
  const n = att.perLane.get(lane) || 0;
  if (n > 0)
    return { attribution: "ATTRIBUTED", agents: n, zeroKind: null, basis: `${n} launch row(s) this session name this lane` };
  if (att.unidentified > 0)
    return {
      attribution: "UNATTRIBUTED",
      agents: null,
      zeroKind: null,
      basis:
        `${att.unidentified} of this session's ${att.total} launch row(s) carry no lane, branch, worktree ` +
        "or cwd key that resolves to a lane, so whether any went to this lane is UNMEASURED — not zero",
    };
  if (att.skipped > 0)
    return {
      attribution: "UNMEASURED",
      agents: null,
      zeroKind: null,
      basis: `${att.skipped} dispatch-ledger line(s) did not parse, and any of them could be a launch for this lane`,
    };
  return {
    attribution: "ZERO",
    agents: 0,
    zeroKind: att.total === 0 ? "no-launches" : "joined",
    basis:
      att.total === 0
        ? "this session's dispatch ledger holds no launch row at all"
        : `all ${att.total} launch row(s) this session name other lanes`,
  };
}

/**
 * THE TURN-END DETECTOR for `rules/wip-discipline.md` MUST-9. Pure — the caller supplies the
 * `laneDepth` report, the dispatch-ledger rows and (optionally) a worktree→branch map.
 *
 * REPORT  a lane `laneDepth` marks UNDER-PACKED has no ATTRIBUTED dispatch this session. Severity is
 *         `halt-and-report` when at least one such lane's agent count is a MEASURED zero, else
 *         `advisory` (its agent half is UNATTRIBUTED or UNMEASURED).
 * QUIET   no lane is UNDER-PACKED, or every UNDER-PACKED lane got an attributed dispatch.
 * UNKNOWN the depth report was not usable (`depth.ok !== true`, or a malformed report). Never QUIET:
 *         an unreadable ledger does not mean "no under-packed lanes". `kind` separates a failed
 *         probe (`depth.probe` set by the caller) from a ledger `laneDepth` itself could not read.
 *
 * @param {{depth:object|null, rows:object[]|null, failure?:object, skipped?:number,
 *          sessionId?:string, worktreeLanes?:object|null}} a
 */
function detectUnderPackedLane(a) {
  const o = a && typeof a === "object" ? a : {};
  const d = o.depth;
  const unknown = (kind, reason) => ({
    state: "UNKNOWN",
    severity: null,
    lanes: [],
    suppressed: [],
    queued: [],
    counts: null,
    launches: null,
    kind,
    reason,
  });
  if (!d || typeof d !== "object")
    return unknown("ledger-unreadable", "no lane-depth report was produced, so whether any lane is under-packed is UNKNOWN");
  if (d.ok !== true)
    return unknown(
      _isNonEmptyString(d.probe) ? "probe-failed" : "ledger-unreadable",
      _isNonEmptyString(d.reason) ? d.reason : "the lane-depth report carried no reason",
    );
  if (!Array.isArray(d.lanes))
    return unknown("ledger-unreadable", "the lane-depth report carried no lanes array");

  const queued = Array.isArray(d.queued) ? d.queued : [];
  const underPacked = d.lanes.filter((l) => l && l.verdict === "UNDER-PACKED" && _isNonEmptyString(l.lane));
  if (underPacked.length === 0) {
    return {
      state: "QUIET",
      severity: null,
      lanes: [],
      suppressed: [],
      queued,
      counts: d.counts || null,
      launches: null,
      kind: null,
      reason: `no open lane is UNDER-PACKED by the work ledger (${d.lanes.length} lane(s), ${queued.length} QUEUED)`,
    };
  }

  const att = attributeLaunchesToLanes({
    rows: o.rows,
    failure: o.failure,
    skipped: o.skipped,
    sessionId: o.sessionId,
    laneNames: underPacked.map((l) => l.lane),
    worktreeLanes: o.worktreeLanes,
  });
  const rowsOut = underPacked.map((l) => ({
    lane: l.lane,
    itemCount: Number.isInteger(l.itemCount) ? l.itemCount : null,
    items: Array.isArray(l.items) ? l.items : [],
    why: _isNonEmptyString(l.why) ? l.why : null,
    ..._laneAttribution(att, l.lane),
  }));
  const reported = rowsOut.filter((r) => r.attribution !== "ATTRIBUTED");
  const suppressed = rowsOut.filter((r) => r.attribution === "ATTRIBUTED");
  const launches = att.ok
    ? { total: att.total, unidentified: att.unidentified, elsewhere: att.elsewhere, skipped: att.skipped }
    : null;
  if (reported.length === 0) {
    return {
      state: "QUIET",
      severity: null,
      lanes: [],
      suppressed,
      queued,
      counts: d.counts || null,
      launches,
      kind: null,
      reason: `every UNDER-PACKED lane got an attributed dispatch this session (${suppressed.map((r) => r.lane).join(", ")})`,
    };
  }
  return {
    state: "REPORT",
    severity: reported.some((r) => r.attribution === "ZERO") ? "halt-and-report" : "advisory",
    lanes: reported,
    suppressed,
    queued,
    counts: d.counts || null,
    launches,
    kind: null,
    reason: `${reported.length} UNDER-PACKED lane(s) with no attributed dispatch this session, ${queued.length} item(s) QUEUED`,
  };
}

/** The shared sanitizer, loaded lazily so the other arms pay nothing for it. */
function _clean(v, max) {
  try {
    const { safeField } = require("./override-receipt.js");
    return safeField(String(v == null ? "" : v), "?", max || 120);
  } catch {
    // eslint-disable-next-line no-control-regex
    const s = String(v == null ? "" : v).replace(/[\x00-\x1f\x7f-\x9f[\]`]/g, " ").trim();
    return (s || "?").slice(0, max || 120);
  }
}

/**
 * Render the lane-depth verdict, or null when there is nothing to say.
 *
 * NEVER DOUBLE-COUNTS the zero-dispatch fact. When every ZERO lane's zero comes from a ledger with NO
 * launch row at all, and a zero-dispatch finding from the per-prompt or session-volume arm is emitted
 * in the SAME response (`opts.zeroDispatchStatedBy`), this block names the lanes and REFERS to that
 * finding instead of stating the zero again.
 */
function formatUnderPackedLaneFinding(verdict, opts) {
  if (!verdict || typeof verdict !== "object") return null;
  if (verdict.state === "UNKNOWN")
    return (
      "[delegation-default] LANE DEPTH UNKNOWN at turn end — NOT 'no under-packed lanes'. " +
      `${verdict.kind === "probe-failed" ? "The lane-depth probe failed" : "The work ledger or the lane set could not be read"}: ` +
      `${_clean(verdict.reason, 300)}. Whether any lane is UNDER-PACKED while this session dispatched no ` +
      "agents for it was NOT measured (`rules/wip-discipline.md` MUST-9). ADVISORY — surfaced once per " +
      "session per failure class, not once per turn."
    );
  if (verdict.state !== "REPORT" || !Array.isArray(verdict.lanes) || verdict.lanes.length === 0) return null;
  const statedBy = opts && _isNonEmptyString(opts.zeroDispatchStatedBy) ? opts.zeroDispatchStatedBy : null;
  const zeroRows = verdict.lanes.filter((l) => l.attribution === "ZERO");
  const referZero = statedBy !== null && zeroRows.length > 0 && zeroRows.every((l) => l.zeroKind === "no-launches");
  const agentsText = (l) => {
    if (l.attribution === "ZERO")
      return referZero
        ? `agents this session: 0 — the ${statedBy} finding above states that zero; counted once, not twice`
        : `agents this session: 0 (${l.basis})`;
    return `agents this session ${l.attribution} — ${l.basis}`;
  };
  const shown = verdict.lanes.slice(0, MAX_REPORTED_UNDER_PACKED);
  const lines = shown.map(
    (l) =>
      `  - ${_clean(l.lane)} — ${l.itemCount === null ? "?" : l.itemCount} item(s)` +
      (l.items.length ? ` (${l.items.slice(0, 3).map((i) => _clean(i, 80)).join(", ")}${l.items.length > 3 ? ", …" : ""})` : "") +
      `; ${agentsText(l)}`,
  );
  if (verdict.lanes.length > shown.length) lines.push(`  - …and ${verdict.lanes.length - shown.length} more`);
  const q = verdict.queued || [];
  const queuedLine = q.length
    ? `QUEUED (${q.length}): ${q
        .slice(0, MAX_REPORTED_QUEUED)
        .map((x) => `${_clean(x && x.id, 80)} -> ${_clean(x && x.lane, 80)}`)
        .join(", ")}${q.length > MAX_REPORTED_QUEUED ? `, +${q.length - MAX_REPORTED_QUEUED} more` : ""}.`
    : "QUEUED: none listed.";
  const measuredZero = zeroRows.length > 0;
  return [
    `[delegation-default] UNDER-PACKED LANE(S) — \`rules/wip-discipline.md\` MUST-9. The work ledger marks ` +
      `${verdict.lanes.length} open lane(s) UNDER-PACKED (at most one item while items are QUEUED) and this ` +
      `session has no attributed dispatch for ${verdict.lanes.length === 1 ? "it" : "them"}:`,
    ...lines,
    queuedLine,
    "A lane is a MINI-ORCHESTRATOR: dispatch agents INSIDE that lane's one worktree under the partition " +
      "contract (writers on DISJOINT file sets, ONE committer, read-only verifiers unbounded, per-agent " +
      "build/output dirs — never another worktree), or bind queued items to it with a `lane: <branch>` " +
      "frontmatter key before opening anything new. If another session is driving the lane, say so.",
    measuredZero
      ? "HALT-AND-REPORT, never a block and never a hand-back refusal: the item and agent counts are " +
        "structural, but whether the lane's work decomposes is judgment (`hook-output-discipline.md` MUST-2)."
      : "ADVISORY: this session's agent count for these lanes was NOT measured — an UNATTRIBUTED or " +
        "UNMEASURED lane is never reported as zero agents.",
  ].join("\n");
}

/**
 * Dedupe signature for the lane-depth arm. REPORT keys on the reported (lane, items, attribution)
 * set plus the queued count, hashed so a long forest cannot bloat the marker: a CHANGED set speaks
 * again, an unchanged one does not. UNKNOWN keys on its failure CLASS — the reason's leading token —
 * so a broken instrument speaks once per session per class. NOT-RUN and QUIET yield "" (never marked).
 */
function underPackedSignatureOf(verdict) {
  if (!verdict || typeof verdict !== "object") return "";
  if (verdict.state === "UNKNOWN") {
    const cls = String(verdict.reason || "").split(":")[0].replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) || "unclassified";
    return `LANE-DEPTH:UNKNOWN:${verdict.kind || "unknown"}:${cls}`;
  }
  if (verdict.state !== "REPORT" || !Array.isArray(verdict.lanes) || verdict.lanes.length === 0) return "";
  const crypto = require("node:crypto");
  const canon = JSON.stringify({
    lanes: verdict.lanes
      .map((l) => [l.lane, l.itemCount, l.attribution])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    queued: (verdict.queued || []).length,
  });
  return `LANE-DEPTH:${crypto.createHash("sha256").update(canon, "utf8").digest("hex").slice(0, 16)}`;
}

module.exports = {
  DECLARED_FLOOR,
  SERIAL_RUN_FLOOR,
  STATES,
  MAX_MARKER_BYTES,
  LANE_ARM_STATES,
  LANE_ATTRIBUTIONS,
  LANE_NAME_KEYS,
  LANE_PATH_KEYS,
  laneArmNotRun,
  attributeLaunchesToLanes,
  detectUnderPackedLane,
  formatUnderPackedLaneFinding,
  underPackedSignatureOf,
  assessDelegationDefault,
  assessSessionVolume,
  assessFromLedger,
  assertFloorMatchesReconciler,
  formatDelegationAdvisory,
  formatSessionVolumeAdvisory,
  signatureOf,
  sessionVolumeSignatureOf,
  markerPath,
  alreadySurfaced,
  markSurfaced,
};
