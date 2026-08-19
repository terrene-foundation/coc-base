#!/usr/bin/env node
/**
 * Audit-fixture runner for the fleet-drain detector — `.claude/hooks/lib/fleet-drain.js` plus the
 * real `.claude/hooks/fleet-drain-guard.js` stdin boundary (`wave-loop.md` MUST-6), shipped WITH
 * the detector per `cc-artifacts.md` Rule 9.
 *
 * Coverage shape is ONE CASE PER SCOPE-RESTRICTION PREDICATE — the predicates a wrong edit would
 * silently widen or narrow:
 *
 *   1  the launch filter is scoped to the MAIN-AGENT generation
 *   2  that sentinel is COUPLED to the producer, not restated
 *   3  reconcile rows are NOT generation-filtered (they carry the STOPPING lane's own name)
 *   4  the unnamed-launch refusal — an unbounded-above fleet is UNKNOWN, never a number
 *   5  a failed ledger read is UNKNOWN, never QUIET
 *   6  the forest parse is bound to the ledger SECTION, not the whole file
 *   7  the whole-file shared-ledger form parses
 *   8  fenced code blocks are excluded
 *   9  header + separator rows are excluded
 *  10  "forest empty" is FOUND-with-zero-rows, distinct from a missing section
 *  11  a missing section is UNKNOWN, never zero
 *  12  the blocked-on-human marker suppresses a row — and is NARROW enough not to eat status prose
 *  13  the clean-stop gate — nothing dispatchable is QUIET whatever the lane count
 *  14  the DRAINED arm — zero lanes, the only arm that advises
 *  15  the UNDER-CAPACITY arm — uncalibrated, so it OBSERVES and gives no advice
 *  16  the saturated arm
 *  17  UNKNOWN precedes QUIET — a count never taken must not render as a clear board
 *  18  the lane floor is configurable, and configuring it MOVES the arm boundary
 *  19  `resolveLaneFloor` refuses garbage rather than silently disarming
 *  20  the kill switch, both poles
 *  21  advisory rendering: which states speak and which stay silent
 *  22  the severity cap is stated in the emitted text
 *  23  the dedupe signature discriminates on the MEASURED PAIR
 *  24  the marker file's round-trip + fail-open read
 *  25  the REAL hook boundary — stdin in, systemMessage out, continue:true, exit 0
 *  26  isolation — nothing is written under the real `.claude/learning/`
 *
 * BIPOLAR BY CONSTRUCTION: every predicate carries BOTH a firing pole and a quiet pole. A set that
 * only ever asserts firing passes identically against a detector that fires on everything; a set
 * that only ever asserts silence passes identically against a detector that is INERT. Both are live
 * risks here — the detector cannot block, so an inert one is indistinguishable from a
 * well-orchestrated session, which is precisely the non-discriminating instrument
 * `instrument-discipline.md` MUST-1 forbids citing as evidence.
 *
 * ESTABLISHED RED (`instrument-discipline.md` MUST-2): every mutation below was RUN against this
 * file before it landed — MEASURED, not predicted. The sets are what each mutation ACTUALLY
 * reddened; the unmutated baseline and the restored file both exit 0. Every anchor was confirmed
 * PRESENT before its edit, so no mutation was silently INERT — which matters, because a mutation
 * that never reached the code leaves the two hypotheses MUST-2(b) names (vacuous pin, or inert
 * mutation) both live. NONE of the eleven was non-reddening. Case ids are this file's own.
 *
 *   M-a  drop the `r.generation !== MAIN_GENERATION` launch filter          → 02, 08
 *   M-b  ALSO generation-filter the `reconcile` arm to MAIN_GENERATION      → 04, 05, 06, 39
 *   M-c  `unnamed > 0` refusal → fall through and return a number           → 07
 *   M-d  collapse the assess-level UNKNOWN base state to QUIET              → 26, 27
 *   M-e  unbind the forest parse from the section (scan the whole file)     → 11, 12, 17
 *   M-f  `dispatchable < DISPATCHABLE_FLOOR` clean-stop gate → `false`      → 21, 22, 34
 *   M-g  DRAINED arm returns OBSERVE instead of ADVISE                      → 23, 30, 33, 39
 *   M-h  UNDER-CAPACITY arm returns ADVISE instead of OBSERVE               → 24, 28, 33
 *   M-i  widen HUMAN_BLOCKED_RE to /blocked/i                               → 17, 20
 *   M-j  `alreadySurfaced` returns false unconditionally                    → 36, 41
 *   M-k  MAIN_GENERATION localised to a literal the producer never emits    → 03a
 *
 * The per-case `redsUnder` notes below were written as PREDICTIONS and several were WRONG; the
 * table above supersedes them and is the measured record. Two results are worth reading rather
 * than skimming:
 *
 *   M-k reds case 03a AND NOTHING ELSE. Every behavioural case survives a sentinel that no longer
 *     matches, because the fixtures build their own rows using the module's exported constant, so
 *     both sides move together and the drift is invisible to them. The coupling assertion is the
 *     ONLY pin that catches it. That is precisely why it exists — and it is also a live limit of
 *     this set, stated rather than hidden.
 *
 *   M-c reds case 07 alone. The unnamed-launch refusal has exactly one firing pin (08 is its quiet
 *     pole and does not depend on the refusal), so that pin is load-bearing on its own.
 *
 * Cases 03 and 03b are deliberately NOT regression locks: they are the POSITIVE CONTROLS on the
 * coupling assertion itself, driving a stub producer whose sentinel differs and one that throws,
 * and asserting `assertMainGenerationMatchesProducer` REJECTS both. Without them, 03a's green would
 * be consistent with an assertion that cannot return the other answer at all
 * (`instrument-discipline.md` MUST-3(a)).
 *
 * SCOPE MUTATION (an equally-valid alternative implementation that MUST leave every pin GREEN) —
 * RUN, not asserted: `countRunningLanes`'s set-difference was replaced with an equivalent
 * `Map`-based accumulate-then-filter (same contract, different data structure and iteration order).
 * All 50 cases stayed green, exit 0. The pins therefore bind the CONTRACT — which lanes count as
 * running, which states speak — and not the shape of the loop that computes it.
 *
 * Pure functions against in-memory inputs, plus one throwaway git repo in tmp for the ledger,
 * marker and hook-boundary cases. No network, no live session, and NOTHING is written under the
 * real `.claude/learning/` — the hook resolves its sink from `CLAUDE_PROJECT_DIR`, which these
 * cases point at the tmp repo.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const L = require(path.join(REPO, ".claude/hooks/lib/fleet-drain.js"));
const LEDGER = require(path.join(REPO, ".claude/hooks/lib/dispatch-ledger.js"));

const cases = [];
function check(id, name, cond, detail, redsUnder) {
  cases.push({ id, name, pass: !!cond, detail, redsUnder });
}

// ── row builders ──────────────────────────────────────────────────────────────────────────────
const launch = (name, generation = L.MAIN_GENERATION) => ({
  kind: "launch",
  generation,
  dispatch_name: name,
  launch_id: `id-${name || "anon"}-${Math.random().toString(16).slice(2, 8)}`,
});
const stop = (generation) => ({ kind: "reconcile", generation, state: "RESOLVED" });

const lanesOf = (rows) => L.countRunningLanes(rows);
const workOf = (total, humanBlocked = 0) => ({
  ok: true,
  total,
  dispatchable: total - humanBlocked,
  humanBlocked,
  sources: ["x"],
  reason: null,
});
const verdict = (rows, total, cfg) => L.assessFleetDrain({ lanes: lanesOf(rows), work: workOf(total) }, cfg);

// ── 1. the launch filter is scoped to the MAIN-AGENT generation ───────────────────────────────
check(
  "01",
  "SCOPE firing pole: a MAIN-AGENT named launch with no stop counts as running",
  (() => {
    const r = lanesOf([launch("alpha")]);
    return r.ok && r.running.length === 1 && r.running[0] === "alpha";
  })(),
  "one main-agent launch, no reconcile → running=[alpha]",
);
check(
  "02",
  "SCOPE quiet pole: a launch dispatched BY A SUBAGENT is NOT the main agent's lane",
  (() => {
    const r = lanesOf([launch("nested", "some-subagent")]);
    return r.ok && r.running.length === 0;
  })(),
  `nested launch under generation "some-subagent" → running=[]`,
  "M-a: drop the main-generation launch filter; M-k: localise the sentinel",
);

// ── 2. the sentinel is COUPLED to the producer, not restated ──────────────────────────────────
{
  const c = L.assertMainGenerationMatchesProducer(LEDGER.buildLaunchRecord);
  check(
    "03a",
    "COUPLING: the producer's own default launch generation IS the sentinel this module filters on",
    c.ok,
    c.detail,
    "M-k: localise MAIN_GENERATION to a literal the producer no longer emits",
  );
  // POSITIVE CONTROL on the assertion itself (instrument-discipline MUST-3(a)): it must be able to
  // return the OTHER answer. Without this, 03a's green is consistent with an assertion that always
  // passes.
  const stub = () => ({ generation: "(not-the-sentinel)" });
  check(
    "03",
    "COUPLING control: a producer emitting a DIFFERENT sentinel is REJECTED",
    L.assertMainGenerationMatchesProducer(stub).ok === false,
    "the coupling assertion can return the other answer",
  );
  check(
    "03b",
    "COUPLING control: a throwing producer is REJECTED, not treated as agreement",
    L.assertMainGenerationMatchesProducer(() => {
      throw new Error("boom");
    }).ok === false,
    "a builder that throws fails the coupling rather than passing it",
  );
}

// ── 3. reconcile rows are NOT generation-filtered ─────────────────────────────────────────────
check(
  "04",
  "TERMINATION firing pole: a reconcile row under the LANE'S OWN name terminates that lane",
  (() => {
    const r = lanesOf([launch("alpha"), stop("alpha")]);
    return r.ok && r.running.length === 0;
  })(),
  "launch(alpha) + reconcile(generation=alpha) → running=[]",
  "M-a / M-k",
);
check(
  "05",
  "TERMINATION quiet pole: a reconcile for a DIFFERENT lane leaves this one running",
  (() => {
    const r = lanesOf([launch("alpha"), launch("beta"), stop("beta")]);
    return r.ok && r.running.length === 1 && r.running[0] === "alpha";
  })(),
  "only beta stopped → running=[alpha]",
  "M-b: generation-filter the reconcile arm (would discard every termination signal)",
);
check(
  "06",
  "TERMINATION: a lane stopping twice is not double-counted (set semantics)",
  (() => {
    const r = lanesOf([launch("alpha"), stop("alpha"), stop("alpha")]);
    return r.ok && r.running.length === 0 && r.terminated === 1;
  })(),
  "duplicate reconcile rows collapse to one terminated lane",
);

// ── 4. the unnamed-launch refusal ─────────────────────────────────────────────────────────────
check(
  "07",
  "UNNAMED firing pole: a MAIN-AGENT unnamed launch makes occupancy UNKNOWN, never a number",
  (() => {
    const r = lanesOf([launch("alpha"), launch(null)]);
    return r.ok === false && r.running === null && r.unnamed === 1 && /cannot be bounded from above/.test(r.reason);
  })(),
  "an unnamed main-agent launch cannot be bounded above → ok=false, running=null",
  "M-c: fall through and return a number anyway",
);
check(
  "08",
  "UNNAMED quiet pole: an unnamed launch in a SUBAGENT generation does NOT contaminate the count",
  (() => {
    const r = lanesOf([launch("alpha"), launch(null, "some-subagent")]);
    return r.ok === true && r.unnamed === 0 && r.running.length === 1;
  })(),
  "the scope narrowing is what recovers 7-of-9 sessions rather than 4-of-9",
);

// ── 5. a failed ledger read is UNKNOWN, never QUIET ───────────────────────────────────────────
check(
  "09",
  "READ-FAILURE firing pole: null rows are UNKNOWN and carry the typed reason",
  (() => {
    const r = L.countRunningLanes(null, { reason: "ledger absent" });
    return r.ok === false && r.running === null && /ledger absent/.test(r.reason);
  })(),
  "an unread ledger is UNKNOWN, not an idle fleet",
  "M-d: collapse the UNKNOWN branch to QUIET",
);
check(
  "10",
  "READ-FAILURE quiet pole: an EMPTY-but-read ledger is a real zero, not UNKNOWN",
  (() => {
    const r = lanesOf([]);
    return r.ok === true && r.running.length === 0;
  })(),
  "read-and-empty and never-read are DISTINCT states",
);

// ── 6..11. the forest-ledger parse ────────────────────────────────────────────────────────────
const LEDGER_MD = [
  "# Session Notes",
  "",
  "## In-play PRs",
  "",
  "| PR | what | state |",
  "| --- | --- | --- |",
  "| `#1787` | inventory | in CI |",
  "| `#1786` | slugs | in CI |",
  "",
  "## Outstanding ledger (forest)",
  "",
  "| ID | Item | Status |",
  "| --- | --- | --- |",
  "| `F35` | Gate-2 delivery | 3 landed; 3 BUILD blocked, 3 distinct causes |",
  "| `F74` | ingest first | 66 paths, MIXED direction |",
  "| `F76` | no required check | merges unverified BY CONSTRUCTION |",
  "",
  "## Traps",
  "",
  "| a | b |",
  "| --- | --- |",
  "| x | y |",
  "",
].join("\n");

check(
  "11",
  "PARSE firing pole: the ledger section's data rows are counted",
  (() => {
    const p = L.parseForestLedger(LEDGER_MD);
    return p.found && p.rows.length === 3;
  })(),
  `3 forest rows found (the in-play-PR and Traps tables are in OTHER sections)`,
  "M-e: unbind the parse from the section",
);
check(
  "12",
  "PARSE quiet pole: a file with tables but NO ledger section yields found=false",
  (() => {
    const p = L.parseForestLedger("## In-play PRs\n\n| a | b |\n| --- | --- |\n| x | y |\n");
    return p.found === false && p.rows.length === 0;
  })(),
  "no ledger heading → nothing found, and NOT a zero",
);
check(
  "13",
  "PARSE: the whole-file shared-ledger form (`# Forest Ledger`) parses, and `##` does not close it",
  (() => {
    const p = L.parseForestLedger(
      "# Forest Ledger\n\n| ID | Item | value_anchor |\n| --- | --- | --- |\n| F1 | a | x |\n\n## Notes\n\n| F2 | b | y |\n",
    );
    return p.found && p.rows.length === 2;
  })(),
  "the shared form runs to EOF; the inline form stops at the next `## `",
);
check(
  "14",
  "PARSE quiet pole: a table inside a FENCED block is not a ledger row",
  (() => {
    const p = L.parseForestLedger(
      "## Outstanding ledger (forest)\n\n```\n| F9 | fenced | example |\n```\n\n| `F1` | real | open |\n",
    );
    return p.found && p.rows.length === 1;
  })(),
  "documentation examples inside fences do not inflate the count",
);
check(
  "15",
  "PARSE quiet pole: header and separator rows are excluded",
  (() => {
    const p = L.parseForestLedger("## Outstanding ledger (forest)\n\n| ID | Item | Status |\n| --- | --- | --- |\n");
    return p.found && p.rows.length === 0;
  })(),
  "a header-only table is a found-and-empty board",
);
check(
  "16",
  "PARSE: an explicit `forest empty` is FOUND with zero rows, distinct from a missing section",
  (() => {
    const p = L.parseForestLedger("## Where we are\n\nforest empty — nothing outstanding\n");
    return p.found === true && p.rows.length === 0;
  })(),
  "a positive all-clear is not the same state as an absent board",
);
check(
  "17",
  "OPEN-WORK firing pole: rows across multiple fragments are summed",
  (() => {
    const w = L.countOpenWork([
      { path: "a.md", text: LEDGER_MD },
      { path: "b.md", text: "## Outstanding ledger (forest)\n\n| `F9` | other | open |\n" },
    ]);
    return w.ok && w.total === 4 && w.dispatchable === 4 && w.sources.length === 2;
  })(),
  "two fragments, 3 + 1 rows → total 4",
  "M-e",
);
check(
  "18",
  "OPEN-WORK quiet pole: no readable surface is UNKNOWN, never zero",
  (() => {
    const a = L.countOpenWork([]);
    const b = L.countOpenWork([{ path: "a.md", text: "## Notes\n\nnothing here\n" }]);
    return a.ok === false && a.total === null && b.ok === false && b.total === null;
  })(),
  "an absent board and a clear board are the same bytes — so neither reads as clear",
  "M-d",
);

// ── 12. the blocked-on-human marker, and its NARROWNESS ───────────────────────────────────────
check(
  "19",
  "SUPPRESSION firing pole: a blocked-on-human row is counted in TOTAL but not in DISPATCHABLE",
  (() => {
    const w = L.countOpenWork([
      {
        path: "a.md",
        text: "## Outstanding ledger (forest)\n\n| `F1` | a | open |\n| `F2` | b | blocked-on-human, awaiting the call |\n",
      },
    ]);
    return w.ok && w.total === 2 && w.dispatchable === 1 && w.humanBlocked === 1;
  })(),
  "suppression can never hide magnitude — the TOTAL still carries it",
);
check(
  "20",
  "SUPPRESSION quiet pole: ordinary status prose containing 'blocked' is NOT suppressed",
  (() => {
    const w = L.countOpenWork([
      {
        path: "a.md",
        text:
          "## Outstanding ledger (forest)\n\n| `F1` | a | 3 BUILD blocked, 3 distinct causes |\n" +
          "| `F2` | b | blocked on the rebase landing |\n",
      },
    ]);
    return w.ok && w.total === 2 && w.dispatchable === 2 && w.humanBlocked === 0;
  })(),
  "work blocked on WORK is still dispatchable; a loose /blocked/i would make the gate inert",
  "M-i: widen HUMAN_BLOCKED_RE to /blocked/i",
);

// ── 13. the clean-stop gate ───────────────────────────────────────────────────────────────────
check(
  "21",
  "CLEAN-STOP firing pole: zero lanes with a CLEAR board is QUIET, not a drain",
  (() => {
    const v = verdict([], 0);
    return v.state === "QUIET" && v.arm === "clean-stop";
  })(),
  "a converged hand-to-human stop IS complete (recommendation-quality.md MUST-3)",
  "M-f: disable the clean-stop gate",
);
check(
  "22",
  "CLEAN-STOP: a board whose every row is blocked-on-human is also QUIET",
  (() => {
    const v = L.assessFleetDrain({ lanes: lanesOf([]), work: workOf(4, 4) });
    return v.state === "QUIET" && v.arm === "clean-stop" && /blocked-on-human/.test(v.reason);
  })(),
  "4 rows, all human-blocked → nothing dispatchable → silent",
  "M-f",
);

// ── 14..16. the three live arms ───────────────────────────────────────────────────────────────
check(
  "23",
  "DRAINED firing pole: zero lanes with dispatchable work ADVISES",
  (() => {
    const v = verdict([], 16);
    return v.state === "ADVISE" && v.arm === "drained" && v.running === 0 && v.dispatchable === 16;
  })(),
  "the refill trigger that was missing",
  "M-g: DRAINED returns OBSERVE",
);
check(
  "24",
  "UNDER-CAPACITY firing pole: one lane with work OBSERVES — it does NOT advise",
  (() => {
    const v = verdict([launch("alpha")], 16);
    return v.state === "OBSERVE" && v.arm === "under-capacity";
  })(),
  "the lane floor is uncalibrated, so this arm emits the pair and gives no advice",
  "M-h: UNDER-CAPACITY returns ADVISE",
);
check(
  "25",
  "SATURATED quiet pole: lanes ABOVE the floor is QUIET",
  (() => {
    const v = verdict([launch("a"), launch("b"), launch("c")], 16);
    return v.state === "QUIET" && v.arm === "saturated";
  })(),
  "3 lanes over a floor of 1 → silent",
);

// ── 17. UNKNOWN precedes QUIET ────────────────────────────────────────────────────────────────
check(
  "26",
  "PRECEDENCE: unknown LANES with a clear board is UNKNOWN, not the clean-stop QUIET",
  (() => {
    const v = L.assessFleetDrain({ lanes: L.countRunningLanes(null, { reason: "absent" }), work: workOf(0) });
    return v.state === "UNKNOWN";
  })(),
  "a count never taken must not render as a clear board",
  "M-d",
);
check(
  "27",
  "PRECEDENCE: unknown WORK with zero lanes is UNKNOWN, not DRAINED",
  (() => {
    const v = L.assessFleetDrain({ lanes: lanesOf([]), work: L.countOpenWork([]) });
    return v.state === "UNKNOWN" && v.running === 0;
  })(),
  "the lane count is still reported, but no arm fires on half a measurement",
  "M-d",
);

// ── 18..19. the configurable lane floor ───────────────────────────────────────────────────────
check(
  "28",
  "FLOOR firing pole: raising the floor moves a 2-lane session INTO the under-capacity arm",
  verdict([launch("a"), launch("b")], 16, { laneFloor: 2 }).state === "OBSERVE",
  "floor 2, 2 lanes → OBSERVE (at the default floor of 1 the same input is QUIET)",
);
check(
  "29",
  "FLOOR quiet pole: the SAME input at the default floor is saturated",
  verdict([launch("a"), launch("b")], 16).state === "QUIET",
  "the constant is genuinely load-bearing, not decorative",
);
check(
  "30",
  "FLOOR: a floor of 0 disarms the under-capacity arm but NOT the drained arm",
  verdict([launch("a")], 16, { laneFloor: 0 }).state === "QUIET" && verdict([], 16, { laneFloor: 0 }).state === "ADVISE",
  "the boundary arm has no free parameter to switch off",
  "M-b / M-g",
);
check(
  "31",
  "RESOLVE-FLOOR: garbage, negative and absent all fall back to the default rather than disarming",
  L.resolveLaneFloor({}) === L.DEFAULT_LANE_FLOOR &&
    L.resolveLaneFloor({ COC_FLEET_LANE_FLOOR: "banana" }) === L.DEFAULT_LANE_FLOOR &&
    L.resolveLaneFloor({ COC_FLEET_LANE_FLOOR: "-3" }) === L.DEFAULT_LANE_FLOOR &&
    L.resolveLaneFloor({ COC_FLEET_LANE_FLOOR: "4" }) === 4,
  "a malformed env var must not silently disarm the arm it configures",
  "M-g",
);

// ── 20. the kill switch ───────────────────────────────────────────────────────────────────────
check(
  "32",
  "KILL-SWITCH: DEFAULT-ON when absent; only explicit off-tokens disable",
  L.resolveEnabled({}) === true &&
    L.resolveEnabled({ COC_FLEET_DRAIN: "1" }) === true &&
    L.resolveEnabled({ COC_FLEET_DRAIN: "off" }) === false &&
    L.resolveEnabled({ COC_FLEET_DRAIN: "0" }) === false &&
    L.resolveEnabled({ COC_FLEET_DRAIN: "false" }) === false,
  "a deployment that never heard of this still gets the coverage",
  "M-h",
);

// ── 21..22. advisory rendering ────────────────────────────────────────────────────────────────
check(
  "33",
  "RENDER firing pole: ADVISE and OBSERVE both speak",
  (() => {
    const a = L.formatFleetDrainAdvisory(verdict([], 16));
    const o = L.formatFleetDrainAdvisory(verdict([launch("alpha")], 16));
    return typeof a === "string" && /FLEET DRAINED/.test(a) && typeof o === "string" && /UNCALIBRATED/.test(o);
  })(),
  "the OBSERVE text says in words that it gives no advice",
  "M-g / M-h",
);
check(
  "34",
  "RENDER quiet pole: QUIET and UNKNOWN render NOTHING",
  L.formatFleetDrainAdvisory(verdict([launch("a"), launch("b")], 16)) === null &&
    L.formatFleetDrainAdvisory(verdict([], 0)) === null &&
    L.formatFleetDrainAdvisory(L.assessFleetDrain({ lanes: L.countRunningLanes(null, { reason: "x" }), work: workOf(9) })) ===
      null &&
    L.formatFleetDrainAdvisory(null) === null,
  "UNKNOWN is silent but DISTINCT in the data — it is never folded into QUIET",
  "M-b / M-g / M-k",
);
check(
  "35a",
  "RENDER: the ADVISE text names the running lanes it counted",
  /alpha/.test(String(L.formatFleetDrainAdvisory(verdict([launch("alpha")], 16)))),
  "the operator can check the count against the fleet they believe they have",
);
check(
  "35b",
  "RENDER: the severity cap is stated in the emitted text",
  /ADVISORY/.test(String(L.formatFleetDrainAdvisory(verdict([], 16)))) &&
    /cannot block/.test(String(L.formatFleetDrainAdvisory(verdict([], 16)))),
  "the reader is told what the finding can and cannot do",
);

// ── 23. the dedupe signature ──────────────────────────────────────────────────────────────────
check(
  "23s",
  "SIGNATURE: keyed on the MEASURED PAIR — a changed fleet produces a different signature",
  L.signatureOf(verdict([], 16)) !== L.signatureOf(verdict([], 15)) &&
    L.signatureOf(verdict([], 16)) !== L.signatureOf(verdict([launch("a")], 16)) &&
    L.signatureOf(verdict([], 16)) === L.signatureOf(verdict([], 16)),
  "a persisting state surfaces once; a CHANGING fleet is reported again",
);

// ── 24..26. IO: marker round-trip, the real hook boundary, isolation ──────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-drain-fx-"));
  execFileSync("git", ["init", "-q", tmp], { stdio: "ignore" });
  fs.mkdirSync(path.join(tmp, ".claude", "learning", "dispatch-reconcile"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".session-notes.d"), { recursive: true });

  check(
    "36a",
    "MARKER quiet pole: an unwritten signature is NOT suppressed",
    L.alreadySurfaced(tmp, "sess-1", "ADVISE:drained:0:16") === false,
    "the dedupe read can return the other answer",
  );
  check(
    "36",
    "MARKER firing pole: a written signature IS seen on the next read",
    (() => {
      L.markSurfaced(tmp, "sess-1", "ADVISE:drained:0:16");
      return L.alreadySurfaced(tmp, "sess-1", "ADVISE:drained:0:16") === true;
    })(),
    "the round-trip resolves",
    "M-j: alreadySurfaced returns false unconditionally",
  );
  check(
    "37",
    "MARKER: a DIFFERENT signature is not suppressed by an existing marker",
    L.alreadySurfaced(tmp, "sess-1", "ADVISE:drained:0:15") === false,
    "dedupe is keyed on the pair, not on the session",
  );
  check(
    "38",
    "MARKER fail-open: an unreadable marker path reads as NOT-surfaced",
    L.alreadySurfaced(path.join(tmp, "does", "not", "exist"), "sess-1", "x") === false,
    "a lost marker costs a repeated line; a wrong suppression costs the finding",
  );

  // ── the REAL hook boundary ──────────────────────────────────────────────────────────────────
  // The library cases above ALL pass against a hook that never runs. That is not hypothetical:
  // `dispatch-contract-guard.js` shipped inert while 42 of its library fixtures stayed green,
  // because the hook called JSON.parse() on an already-parsed payload. So these drive the real
  // script as a child process.
  const HOOK = path.join(REPO, ".claude/hooks/fleet-drain-guard.js");
  const notes = path.join(tmp, ".session-notes.d", "op.md");
  fs.writeFileSync(
    notes,
    "## Outstanding ledger (forest)\n\n| ID | Item | Status |\n| --- | --- | --- |\n" +
      "| `F1` | a | open |\n| `F2` | b | open |\n| `F3` | c | open |\n",
  );
  const sid = "hook-boundary-session";
  const sink = LEDGER._sinkPath(tmp, sid);
  fs.mkdirSync(path.dirname(sink), { recursive: true });
  // A DRAINED ledger: two named main-agent launches, both reconciled.
  fs.writeFileSync(
    sink,
    [
      JSON.stringify({ ...launch("alpha"), v: 1, session_id: sid, ts: "2026-08-17T00:00:00.000Z" }),
      JSON.stringify({ ...launch("beta"), v: 1, session_id: sid, ts: "2026-08-17T00:00:01.000Z" }),
      JSON.stringify({ ...stop("alpha"), v: 1, session_id: sid, ts: "2026-08-17T00:00:02.000Z" }),
      JSON.stringify({ ...stop("beta"), v: 1, session_id: sid, ts: "2026-08-17T00:00:03.000Z" }),
      "",
    ].join("\n"),
  );

  const first = fire(HOOK, tmp, sid);
  check(
    "39",
    "HOOK firing pole: a drained ledger + a populated board emits the finding on systemMessage",
    (() => {
      let j = null;
      try {
        j = JSON.parse(first.stdout.trim().split("\n").pop());
      } catch {}
      return j && j.continue === true && typeof j.systemMessage === "string" && /FLEET DRAINED/.test(j.systemMessage);
    })(),
    `exit=${first.code} stdout=${first.stdout.trim().slice(0, 90)}`,
    "M-g / M-b — and any regression that makes the hook itself inert",
  );
  check(
    "40",
    "HOOK: continue:true and exit 0 — a Stop-family hook never holds up shutdown",
    first.code === 0 && /"continue":true/.test(first.stdout),
    `exit=${first.code}`,
  );
  const second = fire(HOOK, tmp, sid);
  check(
    "41",
    "HOOK quiet pole: the SAME measured pair is deduped on the next turn",
    (() => {
      let j = null;
      try {
        j = JSON.parse(second.stdout.trim().split("\n").pop());
      } catch {}
      return j && j.continue === true && j.systemMessage === undefined && second.code === 0;
    })(),
    `second run: ${second.stdout.trim().slice(0, 60)}`,
    "M-j: a broken dedupe re-fires every turn and the finding becomes noise",
  );
  const killed = fire(HOOK, tmp, "kill-switch-session", { COC_FLEET_DRAIN: "off" });
  check(
    "42",
    "HOOK quiet pole: the kill switch silences the detector end-to-end",
    killed.code === 0 && !/systemMessage/.test(killed.stdout),
    `COC_FLEET_DRAIN=off → ${killed.stdout.trim().slice(0, 40)}`,
  );
  const noLedger = fire(HOOK, tmp, "session-with-no-ledger");
  check(
    "43",
    "HOOK quiet pole: a session with NO ledger is UNKNOWN — silent, exit 0, nothing claimed",
    noLedger.code === 0 && !/systemMessage/.test(noLedger.stdout) && /"continue":true/.test(noLedger.stdout),
    `no ledger → ${noLedger.stdout.trim().slice(0, 40)}`,
  );
  const garbage = rawFire(HOOK, tmp, "not json at all");
  check(
    "44",
    "HOOK fail-open: malformed stdin still exits 0 with continue:true",
    garbage.code === 0 && /"continue":true/.test(garbage.stdout),
    `exit=${garbage.code} — cc-artifacts.md Rule 7: a broken guard never blocks real work`,
  );

  check(
    "45",
    "ISOLATION: nothing was written under the real repo's .claude/learning/fleet-drain",
    !fs.existsSync(path.join(REPO, ".claude/learning/fleet-drain")) ||
      fs
        .readdirSync(path.join(REPO, ".claude/learning/fleet-drain"))
        .every((f) => !/^(hook-boundary|kill-switch|session-with-no-ledger|sess-1)/.test(f)),
    "the fixtures point CLAUDE_PROJECT_DIR at a throwaway repo",
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

/** Drive the hook as a real child process, capturing stdout, stderr and the exit code separately. */
function fire(hook, projectDir, session, extraEnv) {
  return rawFire(hook, projectDir, JSON.stringify({ hook_event_name: "Stop", session_id: session }), extraEnv);
}

function rawFire(hook, projectDir, input, extraEnv) {
  const r = spawnSync("node", [hook], {
    input,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...(extraEnv || {}) },
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status == null ? -1 : r.status };
}

let failed = 0;
for (const c of cases) {
  const tag = c.pass ? "PASS" : "FAIL";
  if (!c.pass) failed++;
  process.stdout.write(`${tag}  ${c.id}  ${c.name}  [${c.detail}]\n`);
}
process.stdout.write(`\n${cases.length - failed}/${cases.length} cases pass\n`);
process.exit(failed === 0 ? 0 : 1);
