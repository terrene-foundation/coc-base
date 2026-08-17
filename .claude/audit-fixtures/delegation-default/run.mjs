#!/usr/bin/env node
/**
 * Audit-fixture runner for the delegation-default detector — `.claude/hooks/lib/delegation-default.js`
 * plus the real `.claude/hooks/delegation-default-guard.js` stdin boundary
 * (`orchestrator-context-economy.md` MUST-3, loom#1752), shipped WITH the detector per
 * `cc-artifacts.md` Rule 9.
 *
 * Coverage shape is ONE CASE PER SCOPE-RESTRICTION PREDICATE — the predicates a wrong edit would
 * silently widen or narrow:
 *
 *   1  the DECLARED_FLOOR gate — below the floor there is nothing to decompose
 *   2  the floor is COUPLED to `dispatch-ledger.js::reconcile`, not restated
 *   3  the sufficiency arm — dispatched >= declared is the default holding
 *   4  the ADVISE arm — zero dispatches, the only arm that advises
 *   5  the OBSERVE arm — a PARTIAL shortfall, whose ratio is uncalibrated
 *   6  the UNKNOWN arm — a missing/unreadable ledger must never read as QUIET
 *   7  reuse of the reconciler's count rather than a second derivation
 *   8  advisory rendering: which states speak and which stay silent
 *   9  the severity cap is stated in the emitted text
 *  10  the dedupe signature discriminates
 *  11  the marker file's injective session mapping + fail-open read
 *  12  the REAL hook boundary — stdin in, stderr advisory out, continue:true, exit 0
 *
 * BIPOLAR BY CONSTRUCTION: every predicate carries BOTH a firing pole and a quiet pole. A set that
 * only ever asserts firing passes identically against a detector that fires on everything; a set
 * that only ever asserts silence passes identically against a detector that is INERT. Both are live
 * risks here — the whole detector is capped at advisory, so an inert one is indistinguishable from
 * a well-delegating session, which is precisely the non-discriminating instrument
 * `instrument-discipline.md` MUST-1 forbids citing as evidence.
 *
 * ESTABLISHED RED (`instrument-discipline.md` MUST-2): every mutation below was RUN against this
 * file before it landed — MEASURED, not predicted. Each set is what the mutation ACTUALLY
 * reddened, and each restored file exits 0:
 *   M-a  `declared < DECLARED_FLOOR` gate → `false`                    → 01, 32
 *   M-b  `dispatched >= declared` sufficiency arm → `false`            → 05, 16, 22, 31
 *   M-c  collapse the `!parallelism` UNKNOWN branch to QUIET           → 11, 18, 19, 20, 23
 *   M-d  reinstate `JSON.parse(await readStdinBounded())` in the HOOK  → 30, 33, 35
 *        (the inert-hook bug that shipped in `dispatch-contract-guard.js`, where 42 library
 *         fixtures stayed green against a hook that never ran — hence the real child process here)
 *   M-e  `alreadySurfaced` returns false unconditionally               → 35, 40
 *   M-f  DECLARED_FLOOR 2 → 3 (split from the reconciler's floor)      → 03, 17
 *   M-g  the ADVISE branch of `formatDelegationAdvisory` returns null  → 21, 26, 27, 30, 35
 *
 * Case 04 is deliberately NOT a regression lock and reds under none of the seven: it is the
 * POSITIVE CONTROL on the coupling assertion itself, driving a stub reconciler whose rider never
 * goes live and asserting that `assertFloorMatchesReconciler` REJECTS it. Without it, case 03's
 * green would be consistent with an assertion that cannot return the other answer
 * (`instrument-discipline.md` MUST-3(a)). Recorded here rather than left looking like a gap.
 *
 * Pure functions against in-memory inputs, plus one throwaway git repo in tmp for the ledger and
 * hook-boundary cases. No network, no live session, and NOTHING is written under the real
 * `.claude/learning/` — the hook resolves its sink from `CLAUDE_PROJECT_DIR`, which these cases
 * point at the tmp repo.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const L = require(path.join(REPO, ".claude/hooks/lib/delegation-default.js"));
const LEDGER = require(path.join(REPO, ".claude/hooks/lib/dispatch-ledger.js"));

const cases = [];
function check(id, name, cond, detail, redsUnder) {
  cases.push({ id, name, pass: !!cond, detail, redsUnder });
}

const P = (declared, dispatched) => ({ declared, dispatched, shortfall: 0 });
const A = (declared, dispatched) => L.assessDelegationDefault(P(declared, dispatched));

// ── 1. the DECLARED_FLOOR gate ─────────────────────────────────────────────
check("01", "FLOOR quiet pole: declared BELOW the floor is QUIET, whatever the dispatch count",
  A(L.DECLARED_FLOOR - 1, 0).state === "QUIET",
  `declared=${L.DECLARED_FLOOR - 1} dispatched=0 → ${A(L.DECLARED_FLOOR - 1, 0).state}`,
  "M-a: the `declared < DECLARED_FLOOR` gate → false");
check("02", "FLOOR firing pole: declared AT the floor with zero dispatches ADVISES",
  A(L.DECLARED_FLOOR, 0).state === "ADVISE",
  `declared=${L.DECLARED_FLOOR} dispatched=0 → ${A(L.DECLARED_FLOOR, 0).state}`);

// ── 2. the floor is COUPLED to the reconciler, not restated ────────────────
// A fixture asserting `DECLARED_FLOOR === 2` would stay green while the reconciler moved to 3 and
// the two readers of one signal silently disagreed about when it is live.
{
  const c = L.assertFloorMatchesReconciler(LEDGER.reconcile);
  check("03", "COUPLING: the reconciler's own parallelism rider goes live at exactly DECLARED_FLOOR",
    c.ok, c.detail, "M-f: move DECLARED_FLOOR off the reconciler's own floor (2 → 3)");
}
check("04", "COUPLING quiet pole: a reconciler that never goes live fails the coupling assertion",
  L.assertFloorMatchesReconciler(() => ({ parallelism: { declared: 9, dispatched: 0, shortfall: 0 } })).ok === false,
  "a stub reconciler with shortfall pinned to 0 is REJECTED — the assertion can fail");

// ── 3. the sufficiency arm ─────────────────────────────────────────────────
check("05", "SUFFICIENCY quiet pole: dispatched >= declared is the default holding",
  A(3, 3).state === "QUIET" && A(3, 5).state === "QUIET",
  `3/3 → ${A(3, 3).state}; 5 lanes vs 3 parts → ${A(3, 5).state}`,
  "M-b: the `dispatched >= declared` sufficiency arm → false");
check("06", "SUFFICIENCY firing pole: one lane short of the declared count is NOT quiet",
  A(3, 2).state !== "QUIET",
  `declared=3 dispatched=2 → ${A(3, 2).state}`);

// ── 4/5. ADVISE vs OBSERVE — the arm split ────────────────────────────────
check("07", "ADVISE arm: zero dispatches against >=2 declared parts is the ONLY advising state",
  A(4, 0).state === "ADVISE", `4/0 → ${A(4, 0).state}`);
check("08", "ADVISE quiet pole: a single dispatch withdraws the ADVISE verdict",
  A(4, 1).state !== "ADVISE", `4/1 → ${A(4, 1).state}`);
check("09", "OBSERVE arm: a PARTIAL shortfall observes, and does not advise",
  A(5, 2).state === "OBSERVE", `5/2 → ${A(5, 2).state}`);
check("10", "OBSERVE quiet pole: a total shortfall is ADVISE, never OBSERVE",
  A(5, 0).state !== "OBSERVE", `5/0 → ${A(5, 0).state}`);

// ── 6. the UNKNOWN arm — absence is NOT cleanliness ───────────────────────
check("11", "UNKNOWN firing pole: a null parallelism rider is UNKNOWN, never QUIET",
  L.assessDelegationDefault(null).state === "UNKNOWN",
  `null → ${L.assessDelegationDefault(null).state}`,
  "M-c: collapse the `!parallelism` UNKNOWN branch to QUIET");
check("12", "UNKNOWN carries the typed reason from the failed read, not a generic one",
  L.assessDelegationDefault(null, { reason: "ledger unreadable: EACCES" }).reason.includes("EACCES"),
  "the caller's typed reason survives into the verdict");
check("13", "UNKNOWN quiet pole: a well-formed rider is never UNKNOWN",
  A(4, 0).state !== "UNKNOWN" && A(1, 0).state !== "UNKNOWN",
  "both a firing and a quiet rider resolve to a real state");
check("14", "UNKNOWN on a non-integer pair: a rider with a string declared is UNKNOWN",
  L.assessDelegationDefault({ declared: "4", dispatched: 0 }).state === "UNKNOWN",
  "a non-integer pair cannot be compared, so no verdict is invented");

// ── 7. reuse of the reconciler's count ────────────────────────────────────
{
  const rowsFor = (declared, dispatched) => {
    const rows = [{ kind: "declared", declared_subparts: declared, generation: LEDGER.MAIN_GENERATION }];
    for (let i = 0; i < dispatched; i++)
      rows.push({ kind: "launch", launch_id: `L${i}`, generation: LEDGER.MAIN_GENERATION, dispatch_name: `lane-${i}` });
    return rows;
  };
  check("15", "LEDGER firing pole: rows with 4 declared parts and no launch rows ADVISE",
    L.assessFromLedger(rowsFor(4, 0), undefined, LEDGER.reconcile).state === "ADVISE",
    "the count comes from reconcile(), not from a second walk of the rows");
  check("16", "LEDGER quiet pole: rows with 4 declared parts and 4 launch rows are QUIET",
    L.assessFromLedger(rowsFor(4, 4), undefined, LEDGER.reconcile).state === "QUIET",
    "the same seam returns the other answer");
  check("17", "LEDGER attribution: a launch row from a SUBAGENT generation does not count as the orchestrator's",
    L.assessFromLedger(
      [
        { kind: "declared", declared_subparts: 2, generation: LEDGER.MAIN_GENERATION },
        { kind: "launch", launch_id: "L0", generation: "some-lane", dispatch_name: "nested" },
      ],
      undefined,
      LEDGER.reconcile,
    ).state === "ADVISE",
    "a nested lane's own dispatch is not the orchestrator delegating");
  check("18", "LEDGER: null rows yield UNKNOWN, never a clean read",
    L.assessFromLedger(null, { reason: "no ledger for this session" }, LEDGER.reconcile).state === "UNKNOWN",
    "absence stays UNKNOWN through the ledger seam too");
  check("19", "LEDGER: a missing reconciler yields UNKNOWN rather than a guess",
    L.assessFromLedger(rowsFor(4, 0), undefined, null).state === "UNKNOWN",
    "no reconciler → no count → no verdict");
  check("20", "LEDGER: a THROWING reconciler yields UNKNOWN rather than propagating",
    L.assessFromLedger(rowsFor(4, 0), undefined, () => {
      throw new Error("boom");
    }).state === "UNKNOWN",
    "a shutdown hook must not throw out of its predicate");
}

// ── 8. advisory rendering — which states speak ────────────────────────────
check("21", "RENDER firing pole: ADVISE renders a non-empty block naming MUST-3",
  (L.formatDelegationAdvisory(A(4, 0)) || "").includes("MUST-3"),
  `chars=${(L.formatDelegationAdvisory(A(4, 0)) || "").length}`,
  "M-g: the ADVISE branch of formatDelegationAdvisory returns null");
check("22", "RENDER quiet pole: QUIET renders NOTHING",
  L.formatDelegationAdvisory(A(3, 3)) === null,
  "a satisfied session emits no line at all",
  "M-b: the `dispatched >= declared` sufficiency arm → false");
check("23", "RENDER: UNKNOWN renders nothing (noise discipline), but the STATE is still distinct",
  L.formatDelegationAdvisory(L.assessDelegationDefault(null)) === null &&
    L.assessDelegationDefault(null).state === "UNKNOWN",
  "silence in the transcript, not silence in the data");
check("24", "RENDER: OBSERVE is LABELLED as observing and disclaims being a verdict",
  (L.formatDelegationAdvisory(A(5, 2)) || "").includes("OBSERVING") &&
    (L.formatDelegationAdvisory(A(5, 2)) || "").includes("UNCALIBRATED"),
  "the uncalibrated arm cannot be mistaken for a finding");
check("25", "RENDER: a malformed verdict renders nothing rather than throwing",
  L.formatDelegationAdvisory(undefined) === null && L.formatDelegationAdvisory("x") === null,
  "fail open at the render seam too");

// ── 9. the severity cap is stated in the emitted text ────────────────────
{
  const adv = L.formatDelegationAdvisory(A(4, 0)) || "";
  check("26", "SEVERITY: the advisory states it is not a block, and never emits a block severity",
    adv.includes("never a block") && !adv.includes('severity: "block"'),
    "hook-output-discipline.md MUST-2 — a judgment-bearing finding is capped below block");
  check("27", "SEVERITY: the advisory states its own false-positive bound",
    adv.includes("false-positive"),
    "the honest bound travels with the finding, not only with the docs");
}

// ── 10. the dedupe signature discriminates ───────────────────────────────
check("28", "SIGNATURE firing pole: a CHANGED measured pair produces a different signature",
  L.signatureOf(A(4, 0)) !== L.signatureOf(A(4, 1)) && L.signatureOf(A(4, 0)) !== L.signatureOf(A(5, 0)),
  "one more lane, or a new prompt, speaks again");
check("29", "SIGNATURE quiet pole: the SAME measured pair produces the same signature",
  L.signatureOf(A(4, 0)) === L.signatureOf(A(4, 0)) && L.signatureOf(null) === "",
  "a persisting shortfall is surfaced once, not once per turn");

// ── 11/12. the marker file + the REAL hook boundary ──────────────────────
// The 29 cases above exercise pure functions. They would ALL PASS against a hook that never runs —
// which is exactly what happened to `dispatch-contract-guard.js`, inert on every input while 42
// library fixtures stayed green. These cases drive the hook as the runtime does: real child
// process, real stdin, real stderr, real exit code.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-default-fixture-"));
  const q = { cwd: tmp, stdio: "ignore" };
  execFileSync("git", ["init", "-q"], q);
  execFileSync("git", ["-c", "user.email=f@x", "-c", "user.name=f", "commit", "-q", "--allow-empty", "-m", "init"], q);

  const seed = (session, declared, dispatched) => {
    LEDGER.appendRecord({
      repoDir: tmp,
      record: LEDGER.buildDeclaredRecord({
        sessionId: session,
        generation: LEDGER.MAIN_GENERATION,
        declaredSubparts: declared,
        nowIso: new Date().toISOString(),
      }),
    });
    for (let i = 0; i < dispatched; i++)
      LEDGER.appendRecord({
        repoDir: tmp,
        record: LEDGER.buildLaunchRecord({
          sessionId: session,
          generation: LEDGER.MAIN_GENERATION,
          dispatchName: `lane-${i}`,
          subagentType: "analyst",
          nowIso: new Date().toISOString(),
        }),
      });
  };

  const HOOK = path.join(REPO, ".claude/hooks/delegation-default-guard.js");

  // Fired ONCE per session so the dedupe marker does not swallow the observation under test.
  seed("fx-advise", 4, 0);
  seed("fx-quiet", 4, 4);
  seed("fx-below-floor", 1, 0);
  seed("fx-observe", 5, 2);
  seed("fx-dedupe", 3, 0);

  const advise = fireCapture(HOOK, tmp, "fx-advise");
  const quiet = fireCapture(HOOK, tmp, "fx-quiet");
  const belowFloor = fireCapture(HOOK, tmp, "fx-below-floor");
  const observe = fireCapture(HOOK, tmp, "fx-observe");
  const noLedger = fireCapture(HOOK, tmp, "fx-no-ledger-at-all");
  const dedupe1 = fireCapture(HOOK, tmp, "fx-dedupe");
  const dedupe2 = fireCapture(HOOK, tmp, "fx-dedupe");

  check("30", "END-TO-END firing pole: a zero-dispatch session emits a NON-EMPTY advisory on stderr",
    advise.stderr.includes("[delegation-default]") && advise.stderr.includes("ZERO lanes"),
    `stderr chars=${advise.stderr.length}`,
    "M-d: JSON.parse the already-parsed payload in the hook (the inert-hook bug)");
  check("31", "END-TO-END quiet pole: a fully-delegated session emits NOTHING on stderr",
    quiet.stderr.trim() === "", `stderr=${JSON.stringify(quiet.stderr.slice(0, 60))}`);
  check("32", "END-TO-END quiet pole: a below-floor prompt emits NOTHING",
    belowFloor.stderr.trim() === "", "1 declared sub-part is not a decomposable input");
  check("33", "END-TO-END: a PARTIAL shortfall emits the OBSERVING line, not the advising one",
    observe.stderr.includes("OBSERVING") && !observe.stderr.includes("ZERO lanes"),
    "the uncalibrated arm is distinguishable at the boundary",
    "M-d: JSON.parse the already-parsed payload in the hook");
  check("34", "END-TO-END: an absent ledger emits NOTHING and does not claim cleanliness",
    noLedger.stderr.trim() === "", "UNKNOWN is silent in the transcript by design");
  check("35", "END-TO-END dedupe: the SAME shortfall is surfaced once, not once per turn",
    dedupe1.stderr.includes("[delegation-default]") && dedupe2.stderr.trim() === "",
    `first=${dedupe1.stderr.length} chars, second=${dedupe2.stderr.length} chars`,
    "M-e: alreadySurfaced() returns false unconditionally");
  check("36", "END-TO-END: every path emits continue:true on stdout and exits 0",
    [advise, quiet, belowFloor, observe, noLedger, dedupe1].every(
      (r) => r.code === 0 && JSON.parse(r.stdout.trim()).continue === true,
    ),
    "never blocks, never holds up shutdown — hook-output-discipline.md MUST-2");
  check("37", "END-TO-END: a malformed payload is survived, silently, at exit 0",
    (() => {
      const r = rawFire(HOOK, tmp, "not json at all");
      return r.code === 0 && JSON.parse(r.stdout.trim()).continue === true;
    })(),
    "an unparseable payload is an UNKNOWN, not a violation");
  check("38", "MARKER: the session→file mapping is injective across sanitizing collisions",
    L.markerPath(tmp, "a/b") !== L.markerPath(tmp, "a_b"),
    "two raw ids that sanitize alike still land on distinct files");
  check("39", "MARKER quiet pole: an unread/absent marker fails OPEN (advisory still emitted)",
    L.alreadySurfaced(tmp, "never-seen-session", "ADVISE:4:0") === false,
    "a lost dedupe costs a repeated line; a wrong suppression costs the finding");
  check("40", "MARKER firing pole: a written signature IS seen on the next read",
    (() => {
      L.markSurfaced(tmp, "marker-rt", "ADVISE:9:0");
      return L.alreadySurfaced(tmp, "marker-rt", "ADVISE:9:0") === true;
    })(),
    "the round-trip resolves — the dedupe read can return the other answer");
  check("41", "MARKER: a DIFFERENT signature is not suppressed by an existing marker",
    L.alreadySurfaced(tmp, "marker-rt", "ADVISE:9:1") === false,
    "dedupe is keyed on the measured pair, not on the session");
  check("42", "ISOLATION: nothing was written under the real repo's .claude/learning",
    !fs.existsSync(path.join(REPO, ".claude/learning/delegation-default")) ||
      fs.readdirSync(path.join(REPO, ".claude/learning/delegation-default")).every((f) => !f.startsWith("fx-")),
    "the fixtures point CLAUDE_PROJECT_DIR at a throwaway repo");

  fs.rmSync(tmp, { recursive: true, force: true });
}

/** Drive the hook as a real child process, capturing stdout, stderr and the exit code separately. */
function fireCapture(hook, projectDir, session) {
  return rawFire(hook, projectDir, JSON.stringify({ hook_event_name: "Stop", session_id: session }));
}

function rawFire(hook, projectDir, input) {
  const r = spawnSync("node", [hook], {
    input,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
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
