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
 *   4  the unnamed-launch UPPER-BOUND DECLARATION — the ledger reading is a LOWER bound and says so
 *  4b  INSTRUMENT C — the harness `background_tasks` reader: lanes vs shells, absent key, unmeasured
 *      type, non-array, status-not-filtered, fails-open — plus the KNOWN-ANSWER CONTROL on the
 *      VERBATIM captured payloads
 *  4c  THE RECONCILIATION — disagreement is UNKNOWN in both directions when the ledger is bounded,
 *      one-directional when it is not; neither instrument is preferred by faith
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
 *  27  the FLEET EPOCH in the signature — a drain that CHANGES re-surfaces, one that PERSISTS
 *        does not (the half of the dedupe contract the pre-fix tuple did not achieve)
 *  28  marked ⇒ delivered — an emit that FAILS leaves nothing marked, so the finding survives
 *  29  the SAME-NAME CRIT — a REUSED lane name still moves the epoch (row counts, not name sets),
 *        and still reads as OCCUPIED after a relaunch (last-write-wins, not a set difference)
 *  30  the epoch is scoped to the ADVISE arm — a nested lane's churn cannot spam the OBSERVE arm,
 *        and scoping it that way does NOT disarm the drained arm
 *  31  the marker path is INJECTIVE across session ids that sanitize to the same token, and the
 *        suppression side refuses a symlink
 *  32  ORDER decides occupancy — the two sequences a launch-minus-stop BALANCE cannot tell apart
 *        (a refused dispatch's phantom launch row vs a genuine relaunch) are DISTINGUISHED
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
 * M-c IS SUPERSEDED, and by a behaviour change rather than by a better measurement. The
 * `unnamed > 0` REFUSAL it mutated no longer exists: since the INSTRUMENT-C round below,
 * `countRunningLanes` REPORTS the unnamed count and flags `boundedAbove:false` instead of returning
 * `ok:false`. The mutation is therefore unperformable as written, and its replacements are C-s
 * (restore the refusal) and C-c' (claim `boundedAbove:true` anyway) in the instrument-C table. The
 * row is kept rather than deleted so the supersession is visible.
 *
 * SECOND ROUND, 2026-08-20 — the two measured DEFECTS (epoch-blind signature; mark-before-emit).
 * Same standard: every anchor was asserted PRESENT before the edit (a missing anchor ABORTS the
 * mutation rather than producing a silently inert one, `instrument-discipline.md` MUST-2(b)),
 * every set below is what the mutation ACTUALLY reddened, and both files were restored from a
 * `cp` backup and re-verified by SHA-256 with the full set back at 62/62.
 *
 *   M-l  signatureOf reverted to pre-fix `state:arm:running:dispatchable`   → 46, 47, 48, 50, 51, 56
 *   M-m  drop `launched` ALONE from the signature, keep `terminated`        → 46, 47, 48, 50, 56
 *   M-n  key the signature on the CLOCK instead of the fleet epoch          → 41, 46, 47, 48, 50,
 *                                                                              52, 56, 57
 *   M-o  revert the ASSESS-level threading (epoch dropped from the verdict) → 46, 47, 48, 49, 51, 56
 *   M-p  restore MARK-BEFORE-EMIT (the pre-fix ordering)                    → 54, 55
 *   M-q  mark unconditionally after emit, ignoring whether it was delivered → 54, 55
 *   M-r  never mark at all                                                  → 41, 52, 56, 57
 *
 * Three of those results bound what this set proves, and are worth reading rather than skimming:
 *
 *   M-m does NOT red 51. The end-to-end lane-completion case discriminates on `terminated`, which
 *     M-m preserves — so 48 (which holds `terminated` constant and moves `launched` alone) is the
 *     ONLY pin that catches a signature carrying HALF the epoch. That asymmetry is why 48 exists
 *     as its own case rather than folded into 46.
 *
 *   M-o reds 49, and no mutation that leaves the signature SHAPE intact reds it otherwise. It is
 *     the sole pin on the ASSESS-level threading as distinct from the SIGNATURE-level read: a
 *     signature reading `verdict.launched` off a verdict that never carries it renders empty on
 *     both sides and the collision returns silently.
 *
 *   M-p and M-q red the SAME pair (54, 55). Both are orderings that mark a finding the operator
 *     never saw, so the set pins the INVARIANT (marked ⇒ delivered) rather than one particular way
 *     of breaking it. 56/57 are its other pole (delivered ⇒ marked exactly once, and that marker
 *     still suppresses the repeat), which is why the degenerate "fix" of never marking (M-r) reds.
 *
 * THE 2026-08-20 INSTRUMENT-C MUTATIONS, run the same way on this tree. Baseline before each: 72/72,
 * exit 0; restored after each: 72/72, exit 0. Every anchor was confirmed UNIQUELY PRESENT before its
 * edit and confirmed ON DISK after it, so none was silently inert — except C-t, which is recorded
 * below precisely BECAUSE it was.
 *
 * THE `C-` PREFIX IS LOAD-BEARING, not decoration. This round was measured on a branch that did not
 * yet carry the EPOCH round above, and both rounds independently reached for the letters `n` through
 * `r`. Merged, `M-n` and `C-n` are DIFFERENT mutations with DIFFERENT reddened sets, and a table
 * where one label means two things is not a record. The instrument-C round is therefore namespaced
 * rather than re-lettered, so every result below still reads against the run that produced it.
 *
 *   C-n   fold background SHELLS into the lane count                     → C2, C3, R9, R10
 *   C-o   treat an ABSENT `background_tasks` key as an empty array       → C4
 *   C-p   silently ignore elements of unmeasured `type`                  → C5
 *   C-q   filter to `status === "running"` on an unmeasured vocabulary   → C8
 *   C-r   drop the contradiction arm                                     → R1, R2, R6, 39b
 *   C-s   restore the old `ok:false` refusal on `unnamed > 0`            → 07, R4, R5, R6
 *   C-c'  report `boundedAbove:true` even with unnamed launches          → 07, R4, R5
 *   C-t2  defeat BOTH harness guards — the true ledger-only fallback     → R7, 39c
 *
 * ROUND 2, after an adversarial review of the round-1 set. Baseline and restore both 78/78, exit 0;
 * anchors confirmed unique and on disk as before:
 *
 *   C-o'  absent key → LITERALLY an empty array (`ok:true, lanes:0`)     → C4, R7, 39c
 *   C-y   a running subagent counted as a SHELL — instrument C blind
 *         to lanes WITHOUT refusing                                      → C1, C3, C8, R1, R5, R8,
 *                                                                          R11, 24, 25, 28, 29, 30,
 *                                                                          33, 35a, 39b
 *   C-u   restore the throw-capable `e.message ? … : String(e)` catch    → C9
 *   C-v   drop ledgerLanes/ledgerBounded from the dedupe signature       → R11
 *   C-w   drop the `< 0` half of the harness lane guard                  → R12
 *   C-x   drop the `Number.isFinite` half of the work guard              → R13
 *   C-z   remove the try/catch wrapper around `_assessFleetDrain`        → 28 cases
 *
 * THE TWO ROUNDS' BASELINES ARE NOT THIS TREE'S. Each was measured on its own branch — 62/62 for the
 * epoch round, 72/72 then 78/78 for the instrument-C round — and the union tree runs a larger set.
 * The reddened SETS above are still the measurement each mutation produced against the code it
 * mutated, and the union's own baseline + re-established REDs are recorded separately below.
 *
 * C-o' SUPERSEDES the round-1 C-o row, which is a CORRECTION and not a restatement. Round-1's C-o
 * disabled the `hasOwnProperty` guard, and an absent key then fell through to `payload
 * .background_tasks === undefined`, which the NON-ARRAY branch refused anyway — so it recorded
 * `→ C4` while the FAITHFUL form of the same idea reds C4, R7 AND 39c. R7's input IS
 * `readBackgroundTasks({hook_event_name:"Stop"})`, so no faithful C-o could ever have left it
 * green; the round-1 row was measuring a weaker mutation than its own label described. The label,
 * not the measurement, was the defect.
 *
 * C-y IS THE MUTATION THAT MATTERS, and getting it wrong once is worth recording. A first attempt
 * disabled the `type === TASK_TYPE_LANE` branch entirely — but a `subagent` element then matched
 * neither branch, landed in `unclassified`, and instrument C REFUSED, so the detector went UNKNOWN
 * and 39b stayed green for a reason unrelated to the pin. Only the form that routes the lane into
 * `shells` makes instrument C read `ok:true, lanes:0` for a BUSY fleet — the confidently-wrong
 * direction — and it was confirmed to reach the code before the suite ran:
 * `readBackgroundTasks({background_tasks:[{id:"a",type:"subagent",status:"running"}]})` →
 * `{"ok":true,"lanes":0,"shells":1,…}`. Under THAT mutation 39b reds. Two near-identical mutations,
 * opposite verdicts: the difference between a refusal and a wrong answer.
 *
 * C-t IS THE ONE WORTH READING, and it is reported rather than buried. Disabling ONLY the first
 * harness guard (`!tasks || !tasks.ok`) reddened NOTHING. That result left two live hypotheses —
 * vacuous pins, or an inert mutation (`instrument-discipline.md` MUST-2(b)) — and recording "the
 * pins are vacuous" on it would have been a verdict the instrument could not support. It was
 * RESOLVED by direct instrumentation rather than by argument: with that guard disabled, an
 * unreadable-harness input STILL returns `arm:"harness-unreadable"`, but carrying the SECOND
 * guard's reason string ("the harness lane count was not a number"). So the mutation was INERT —
 * the two guards are redundant for that input — and C-t2, which removes both, reds R7 and 39c. The
 * pins are sound; that first mutation simply never changed the answer.
 *
 * 39c IS A SECOND FINDING FROM THAT SAME PASS, and it was a defect in THIS file rather than in the
 * module. As first written it fired at a session with NO ledger, so under C-t2 it stayed silent
 * because the LEDGER was unreadable — it could not discriminate the harness path it is named for
 * (`instrument-discipline.md` MUST-1). It was re-instrumented onto its own DRAINED ledger and now
 * reds under C-t2. A pin that passes for a reason other than the one it claims is not a pin.
 *
 * THE UNION ROUND, 2026-08-20 — after #1841 (epoch + occupancy) and #1851 (instrument C) were
 * RECONCILED onto one tree. Neither lane's earlier round is evidence for the merged code: each was
 * measured against a tree the other's changes were absent from, so a resolution that quietly dropped
 * one half would leave BOTH prior tables green and say nothing. These eight mutations were run
 * against the MERGED tree. Baseline before each and restore after each: 110/110, exit 0, with all
 * three files verified BYTE-IDENTICAL by SHA-256 against a `cp` backup after every restore. Every
 * anchor was asserted UNIQUELY PRESENT before its edit (count != 1 ABORTS rather than producing a
 * silently inert mutation) and asserted ON DISK after it.
 *
 *   U-1  epoch reverted to distinct-NAME cardinality (#1841's CRIT)  → 06, 58, 60, 61, 62, 68,
 *                                                                       70, 71
 *   U-2  occupancy reverted to the NAME-SET difference (#1841)       → 48, 60, 62, 71
 *   U-3  occupancy reverted to the launch-minus-stop BALANCE (#1841) → 48, 70, 71
 *   U-4  a running subagent counted as a SHELL (#1851's C-y)         → 19 cases, incl. C1, C3, C8,
 *                                                                       R1, R5, R8, R11, 39b — AND
 *                                                                       48, 62, 63, 71 from #1841
 *   U-5  restore the `ok:false` unnamed refusal (#1851's C-s)        → 07, R4, R5, R6, R11
 *   U-6  drop the contradiction arm (#1851's C-r)                    → R1, R2, R6, R15, 39b
 *   U-7  drop `...epoch` from the RESTRUCTURED `withLedger` path     → 46, 47, 48, 49, 51, 56, 58,
 *                                                                       59, 62, 63, 64, 68, 70
 *   U-8  revert the anonymous-session early-emit (#1841)             → 72, 73, 74
 *
 * U-7 IS THE SEAM ITSELF, and it is the one mutation neither lane could have run. #1851 restructured
 * `assessFleetDrain` into a wrapper plus `_assessFleetDrain` with a `withLedger`/`withBoth`
 * accumulator, and #1841's epoch threading had to be re-attached to THAT shape rather than to the
 * `...base, ...epoch` spread it was written against. A resolution that took #1851's structure and
 * lost the spread would pass every instrument-C case and every occupancy case, and would silently
 * restore the c90a644a suppression. It reds 13.
 *
 * U-4 IS THE OTHER CROSS-LANE RESULT worth reading: an instrument-C mutation reds #1841's occupancy
 * cases (48, 62, 63, 71) because those cases now reach their arm THROUGH the harness reading. The
 * two lanes are not merely co-resident; the epoch/occupancy pins are downstream of instrument C.
 *
 * CASE 73 WAS THE MEASURED CASUALTY OF THE MERGE, and it is recorded because it PASSED. The
 * anonymous-session cases drove the hook with a payload carrying no `background_tasks` key — correct
 * before instrument C, and after it the hook goes UNKNOWN and SILENT. The firing poles (75, 72, 74)
 * reddened honestly. But 73 is a QUIET pole asserting "no marker file was written", and a hook that
 * never reaches the dedupe writes no marker either — so it went on passing while measuring nothing.
 * MEASURED, two poles on ONE tree with U-8 applied to BOTH: without `background_tasks: []` case 73
 * PASSES (blind); with it, 73 REDS. A case that survives a merge but stops discriminating is worse
 * than a dropped one, because it still counts toward `min_cases`. Case 53 carried the identical
 * defect for the same reason and is fixed the same way.
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
 *     pole and does not depend on the refusal), so that pin is load-bearing on its own. SUPERSEDED
 *     — the refusal is gone; see the M-c supersession note above and C-s / C-c'.
 *
 * Cases 03 and 03b are deliberately NOT regression locks: they are the POSITIVE CONTROLS on the
 * coupling assertion itself, driving a stub producer whose sentinel differs and one that throws,
 * and asserting `assertMainGenerationMatchesProducer` REJECTS both. Without them, 03a's green would
 * be consistent with an assertion that cannot return the other answer at all
 * (`instrument-discipline.md` MUST-3(a)).
 *
 * THIRD ROUND, 2026-08-20 — the SAME-NAME CRIT and its co-morbid occupancy defect. Same standard:
 * every anchor asserted PRESENT before the edit (`grep -c` printing 1) AND asserted PRESENT AFTER
 * it, so no mutation was silently inert; every set below is what the mutation ACTUALLY reddened;
 * the file was restored from a `cp` backup and re-verified BYTE-IDENTICAL by SHA-256
 * (`357f312f…acb0`) after each one, with the full set back at 76/76.
 *
 *   M-s  epoch reverted to SET CARDINALITY (the CRIT)          → 06, 58, 60, 61, 62, 68
 *   M-t  occupancy reverted to the NAME-SET DIFFERENCE          → 60, 62
 *   M-u  read the epoch on EVERY arm (drop the ADVISE scoping)  → 62, 63
 *   M-v  scope `terminated` to MAIN-FLEET names instead         → 46, 47, 48, 49, 51, 63, 64
 *   M-w  drop the sha256 marker-path disambiguator              → 65
 *   M-x  revert the suppression-side symlink refusal            → 67
 *
 * M-v is the one to read rather than skim. It is the OTHER remedy available for the OBSERVE-arm
 * noise M-u's scoping fixes, and the measurement is why it was REJECTED rather than debated: it
 * reds 46/47/48/49/51 — the entire c90a644a regression set — because that incident's session had
 * ZERO main-generation launch rows, so name-scoping the epoch freezes it at `0:0` and reintroduces
 * the exact defect the epoch was built for. Arm-scoping costs nothing that arm was delivering.
 *
 * THE FORMERLY-UNPINNED `emitted` GUARD IS GONE, and the note that named it is RESOLVED rather
 * than carried. It was the `emitted` flag in `fleet-drain-guard.js`'s self-bound timer, recorded
 * here as unpinnable because the only mutation reaching it needs `TIMEOUT_MS = 0`, and that
 * CONTROL — timeout 0 with the guard INTACT — reds the identical set {39, 51, 68a, 68, 55, 56}, so
 * the mutation carried no information about the guard (`instrument-discipline.md` MUST-2(b): a
 * non-discriminating mutation is not a verdict). Round 4 established the stronger fact behind that
 * symptom: the branch is UNREACHABLE, because the sole yield point in that file is
 * `await readStdinBounded()` and it precedes every write, so the flag was provably `false` at every
 * evaluation. Dead scaffolding asserting a guarantee it did not provide was DELETED
 * (`zero-tolerance.md` Rule 2); the guard-file header carries the measurement and the falsifying
 * result. Nothing is owed here now — there is no longer a guard to pin. Case 69 continues to pin
 * one protocol line on the NORMAL path, which is the live half.
 *
 * FOURTH ROUND, 2026-08-20 — OCCUPANCY BECOMES ORDER-AWARE (last-write-wins). Round 3's balance
 * fixed the name-set CRIT and introduced a new one: a balance is order-insensitive, so
 * `[launch a, launch a, stop a]` (DEAD — the first launch row is a refused dispatch that never
 * produced a lane) and `[launch a, stop a, launch a]` (LIVE — a relaunch) both net to +1 and both
 * read "live". Cases 70/71 are that pair. Same standard as round 3: every anchor asserted PRESENT
 * before AND after each edit (`grep -c` printing 1), the file restored from a `cp` backup and
 * re-verified BYTE-IDENTICAL by SHA-256 (`1a90974d…6555`) after each one, back at 78/78.
 *
 *   M-y  occupancy reverted to the LAUNCH-MINUS-STOP BALANCE (round 3)  → 48, 70, 71
 *   M-t  occupancy reverted to the NAME-SET DIFFERENCE (round 1)        → 48, 60, 62, 71
 *
 * READ THE TWO SETS TOGETHER: they are not nested. 70 reds ONLY under the balance — the name-set
 * difference gets the phantom case RIGHT, which is exactly why that shape was a REGRESSION against
 * the model it replaced rather than a leftover. 60/62 red ONLY under the set difference. 48/71 red
 * under BOTH. So the set now discriminates all three occupancy models pairwise, where before round
 * 4 it could not tell the balance from last-write-wins at all.
 *
 * CASE 48'S MEANING CHANGED IN THIS ROUND — flagged, not quietly edited. See the note at the case.
 *
 * REACHABILITY CONTROL for the scope mutation below (`instrument-discipline.md` MUST-2(b) — a
 * non-red is not a verdict until the mutation is shown to reach the code): the occupancy predicate
 * was short-circuited to `if (false && …)` and reds 16 cases {01, 05, 08, 24, 25, 28, 29, 30, 33,
 * 34, 35a, 48, 60, 62, 71, 63}, 62/78. The region is unambiguously live under this set.
 *
 * SCOPE MUTATION (an equally-valid alternative implementation that MUST leave every pin GREEN) —
 * RUN, not asserted, and RE-RUN at the CURRENT count: the `Map` last-write-wins accumulate-then-
 * filter was replaced by a REVERSE scan over the raw rows taking the FIRST mention of each name,
 * keyed in a null-prototype object (same contract, different data structure, opposite iteration
 * direction). All 78 cases stayed green, exit 0. The pins therefore bind the CONTRACT — which lanes
 * count as running, which states speak, which tuple keys the dedupe — and not the shape of the loop
 * that computes it. The prior revision of this note carried a stale "50 cases" figure it flagged as
 * un-re-run; that caveat is RETIRED, not carried forward.
 *
 * ── THE READ HALF OF THE MARKER CONTRACT (loom#1762 follow-up, CRITICAL A), 2026-08-31 ─────────
 *
 * Cases 76-83 (block 28) landed with the reroute of `alreadySurfaced` onto the shared
 * `append-sink.js::readSinkFile` primitive. It was the THIRD live sink reader and the only one
 * still on a bare `lstat` + `readFileSync` after the loom#1762 fix switched its two siblings.
 * Population 110 -> 118.
 *
 * THE SUITE WAS BLIND TO THE FIX: measured with the reroute applied and NOT ONE case added, this
 * runner reported 110/110 and exit 0. Same standing property `delegation-default`'s header
 * records — a green suite across a security fix is evidence about the SUITE, not about the fix.
 *
 * MEASURED red-sets, at 118 cases, unmutated baseline 118/118 exit 0, each mutation after a 1 -> 0
 * pre-image reach proof and each file restored from a SCRATCHPAD copy verified byte-identical by
 * sha256 (never `git checkout --`, which on this uncommitted tree deletes the fix under test):
 *
 *   M-fd1   `alreadySurfaced` back to bare lstat + readFileSync   -> 76, 79, 82
 *   M-fd2   `alreadySurfaced` returns false unconditionally
 *           (the OPPOSITE failure — containment as a stub)        -> 36, 41, 52, 57, 67, 68b,
 *           77, 80, 81, 82
 *   M-fd3   BOTH read-path nlink refusals dropped                 -> 79
 *   M-fd3a  ONLY `readSinkFile`'s own nlink refusal dropped       -> (NONE)
 *           NOT A VACUITY VERDICT. Two hypotheses stood and the SECOND is true:
 *           `reconcileFdIdentity` carries its own nlink check on the same path, so
 *           defense-in-depth absorbs it. Resolved by M-fd3, not left standing — and it is the
 *           same finding `delegation-default`'s M-z3/M-z3b pair recorded one module over.
 *   M-fd4   drop the over-cap refusal from `readSinkFile`         -> 80
 *   M-fd5   drop O_NOFOLLOW from the read open                    -> (NONE)
 *           Again INERT, not vacuous: `reconcileFdIdentity`'s dev/ino compare catches it, because
 *           the lstat of a link resolves the LINK's inode while the fd holds the TARGET's.
 *   M-fd5b  drop O_NOFOLLOW **and** that dev/ino compare          -> 67, 78
 *
 * M-fd1 and M-fd2 are deliberately OPPOSITE mutations of ONE function and neither alone is
 * sufficient: M-fd1 is satisfied by a "fix" that refuses every marker (which silently disables the
 * dedupe), M-fd2 by the naive read that started this. Only the PAIR pins the behaviour. Case 78 is
 * the one case in the block that reds under NEITHER — it is a NON-REGRESSION pin on the single
 * shape the old reader DID guard — and its live mutation is M-fd5b; it was drafted labelled M-fd1
 * and the label was corrected against the measurement rather than the measurement against it.
 *
 * Pure functions against in-memory inputs, plus one throwaway git repo in tmp for the ledger,
 * marker and hook-boundary cases. No network, no live session, and NOTHING is written under the
 * real `.claude/learning/` — the hook resolves its sink from `CLAUDE_PROJECT_DIR`, which these
 * cases point at the tmp repo.
 */

import "../_lib/no-ambient-git.cjs";
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

// ── INSTRUMENT C builders ─────────────────────────────────────────────────────────────────────
//
// Built from the VERBATIM element shapes the probe captured (see the module header § INSTRUMENT C),
// and always routed through the REAL `readBackgroundTasks` rather than hand-assembling its result.
// Hand-assembling would make every reconciliation case pass against a reader that never parses
// anything — the inert-instrument shape this whole file is organised against.
const btSubagent = (id) => ({ id, type: "subagent", status: "running", description: `lane ${id}`, agent_type: "general-purpose" });
const btShell = (id) => ({ id, type: "shell", status: "running", description: `shell ${id}`, command: "sleep 300" });
const bgPayload = (arr) => ({ hook_event_name: "Stop", session_id: "s", background_tasks: arr });
const tasksOf = (n, shells = 0) =>
  L.readBackgroundTasks(
    bgPayload([...Array.from({ length: n }, (_, i) => btSubagent(`a${i}`)), ...Array.from({ length: shells }, (_, i) => btShell(`b${i}`))]),
  );

// DEFAULT: the harness AGREES with the ledger. Every pre-existing arm/floor/render case is about
// what the detector does once occupancy is KNOWN, so its harness reading is made to agree and the
// case keeps testing exactly what it tested. Cases about DISAGREEMENT pass `tasks` explicitly.
const verdict = (rows, total, cfg, tasks) => {
  const lanes = lanesOf(rows);
  return L.assessFleetDrain(
    { lanes, work: workOf(total), tasks: tasks || tasksOf(Array.isArray(lanes.running) ? lanes.running.length : 0) },
    cfg,
  );
};

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
// REWRITTEN 2026-08-20, and the old assertion ENCODED THE BUG. It read `r.terminated === 1` and
// was captioned "set semantics" — it PINNED the name-set cardinality that froze the fleet epoch and
// silenced the detector after one advisory (case 58 is the CRIT it hid). The half of it that is
// still correct is OCCUPANCY: a lane that stopped twice is not running. That half is kept, and the
// epoch half is inverted to the row count the contract now requires. Nothing here was merely
// renumbered — the assertion changed meaning, so it is called out rather than quietly edited.
check(
  "06",
  "TERMINATION: a duplicate reconcile row cannot resurrect occupancy, but it DOES move the epoch",
  (() => {
    const r = lanesOf([launch("alpha"), stop("alpha"), stop("alpha")]);
    return r.ok && r.running.length === 0 && r.launched === 1 && r.terminated === 2;
  })(),
  "occupancy is last-write-wins (the LAST row for `alpha` is a stop ⇒ not running, and a second stop cannot flip it back); the epoch counts ROWS ⇒ 2",
  "reverting the epoch to set cardinality — `terminated` reads 1 and this reds",
);

// ── 4. the unnamed-launch UPPER-BOUND DECLARATION (was a refusal until 2026-08-20) ────────────
check(
  "07",
  "UNNAMED firing pole: a MAIN-AGENT unnamed launch marks the ledger reading NOT bounded above",
  (() => {
    const r = lanesOf([launch("alpha"), launch(null)]);
    return (
      r.ok === true &&
      r.boundedAbove === false &&
      r.unnamed === 1 &&
      Array.isArray(r.running) &&
      r.running.length === 1 &&
      /LOWER bound/.test(r.reason)
    );
  })(),
  "an unnamed main-agent launch → the named difference is a LOWER bound; boundedAbove=false",
  "M-c: report boundedAbove:true anyway, i.e. treat the blind spot as a claim of idleness",
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
check(
  "08b",
  "UNNAMED quiet pole: with NO unnamed launches the ledger reading IS bounded above",
  (() => {
    const r = lanesOf([launch("alpha"), launch("beta"), stop("beta")]);
    return r.ok === true && r.boundedAbove === true && r.unnamed === 0 && r.reason === null;
  })(),
  "boundedAbove discriminates — it is not hardcoded to either value",
);

// ── 4b. INSTRUMENT C — the harness `background_tasks` reader ──────────────────────────────────
//
// THE KNOWN-ANSWER CONTROL (`instrument-discipline.md` MUST-3(a)) lives here, and it is driven by
// the payloads the probe ACTUALLY captured, pasted verbatim rather than reconstructed from memory.
// FALSIFYING RESULT: had this instrument been broken, case C1 — one subagent that was DEFINITIVELY
// running, because the hook fired while it slept — would read 0 lanes, i.e. IDENTICAL to the idle
// captures C0/C0d, and the two states would be indistinguishable. That indistinguishability is
// exactly what the pair below can return, and does not.
const CAPTURED_IDLE = []; // probe condition A, verbatim: Stop with nothing running
const CAPTURED_IDLE_AFTER_COMPLETION = []; // probe condition D, verbatim: a finished bg shell is ABSENT
const CAPTURED_SUBAGENT_RUNNING = [
  { id: "a861595c6f0405427", type: "subagent", status: "running", description: "probe sleeper", agent_type: "general-purpose" },
]; // probe condition C, verbatim
const CAPTURED_SHELL_RUNNING = [
  { id: "bx7xiiyv0", type: "shell", status: "running", description: "Sleep for 300 seconds", command: "sleep 300" },
]; // probe condition B, verbatim

check(
  "C1",
  "CONTROL firing pole: the captured payload of a DEFINITIVELY-running subagent reads as 1 lane",
  (() => {
    const r = L.readBackgroundTasks(bgPayload(CAPTURED_SUBAGENT_RUNNING));
    return r.ok === true && r.lanes === 1 && r.shells === 0 && r.laneIds[0] === "a861595c6f0405427";
  })(),
  "verbatim probe condition C — the instrument can say BUSY",
  "any change that stops classifying type:'subagent' as a lane",
);
check(
  "C0",
  "CONTROL quiet pole: the captured payload with nothing running reads as 0 lanes",
  (() => {
    const a = L.readBackgroundTasks(bgPayload(CAPTURED_IDLE));
    const d = L.readBackgroundTasks(bgPayload(CAPTURED_IDLE_AFTER_COMPLETION));
    return a.ok === true && a.lanes === 0 && a.total === 0 && d.ok === true && d.lanes === 0;
  })(),
  "verbatim probe conditions A and D — the instrument can say IDLE, so C1's answer is information",
);
check(
  "C2",
  "SHELLS are not lanes: a running background shell is counted, but never as occupancy of a lane",
  (() => {
    const r = L.readBackgroundTasks(bgPayload(CAPTURED_SHELL_RUNNING));
    return r.ok === true && r.lanes === 0 && r.shells === 1 && r.total === 1;
  })(),
  "verbatim probe condition B — a `sleep` in the background must not silence the drain arm",
  "M-n: fold shells into the lane count (a background sleep would then disarm the detector)",
);
check(
  "C3",
  "MIXED: lanes and shells in one array are classified apart, not summed",
  (() => {
    const r = L.readBackgroundTasks(bgPayload([...CAPTURED_SUBAGENT_RUNNING, ...CAPTURED_SHELL_RUNNING]));
    return r.ok === true && r.lanes === 1 && r.shells === 1 && r.total === 2;
  })(),
  "array LENGTH is not a lane count",
);
check(
  "C4",
  "ABSENT KEY firing pole: no `background_tasks` on the payload is UNKNOWN, never empty",
  (() => {
    const r = L.readBackgroundTasks({ hook_event_name: "Stop", session_id: "s" });
    return r.ok === false && r.present === false && r.lanes === null && /no upper bound|UNKNOWN/.test(r.reason);
  })(),
  "a harness that does not supply the key leaves occupancy unbounded above",
  "M-o: treat an absent key as an empty array (every session would then read as drained)",
);
check(
  "C5",
  "UNMEASURED TYPE firing pole: an element whose type is outside {subagent, shell} REFUSES",
  (() => {
    const r = L.readBackgroundTasks(bgPayload([{ id: "z", type: "cron", status: "running" }]));
    return r.ok === false && r.present === true && /unmeasured type/.test(r.reason) && /cron/.test(r.reason);
  })(),
  "an unclassifiable RUNNING task cannot be ruled out as a lane — refuse, do not assume",
  "M-p: silently ignore unknown types (a new task type would disarm the guard invisibly)",
);
check(
  "C6",
  "NON-ARRAY firing pole: a `background_tasks` that is not an array is UNKNOWN, and says which type",
  (() => {
    const a = L.readBackgroundTasks({ background_tasks: null });
    const b = L.readBackgroundTasks({ background_tasks: { count: 2 } });
    return a.ok === false && /null/.test(a.reason) && b.ok === false && /object/.test(b.reason);
  })(),
  "the shape was measured, so a departure from it is reported rather than coerced",
);
check(
  "C7",
  "FAILS OPEN: a garbage payload returns a result object and NEVER throws",
  (() => {
    for (const bad of [null, undefined, "string", 42, [], { background_tasks: [1, "x"] }]) {
      let r;
      try {
        r = L.readBackgroundTasks(bad);
      } catch {
        return false;
      }
      if (!r || typeof r !== "object" || typeof r.ok !== "boolean") return false;
    }
    return true;
  })(),
  "cc-artifacts.md Rule 7 — every function returns a result object and nothing throws",
);
check(
  "C8",
  "STATUS IS NOT FILTERED: presence is occupancy, because a finished task was measured ABSENT",
  (() => {
    const r = L.readBackgroundTasks(bgPayload([{ ...btSubagent("q"), status: "completed" }]));
    return r.ok === true && r.lanes === 1;
  })(),
  "filtering an unmeasured status vocabulary could drop a live lane — the falsely-LOUD direction",
  "M-q: filter to status==='running' on an unmeasured vocabulary",
);

// ── 4c. THE RECONCILIATION — neither instrument is preferred by faith ─────────────────────────
check(
  "R1",
  "DISAGREEMENT firing pole: bounded ledger says IDLE, harness says BUSY → UNKNOWN, not ADVISE",
  (() => {
    const v = verdict([launch("alpha"), stop("alpha")], 12, undefined, tasksOf(2));
    return v.state === "UNKNOWN" && v.arm === "instrument-disagreement" && /disagree/.test(v.reason);
  })(),
  "THE ORIGINAL FALSE POSITIVE: the old single-instrument detector ADVISED here",
  "M-r: drop the contradiction arm (the undercounting FP comes straight back)",
);
check(
  "R2",
  "DISAGREEMENT firing pole: ledger says BUSY, harness says IDLE → UNKNOWN in that direction too",
  (() => {
    const v = verdict([launch("alpha")], 12, undefined, tasksOf(0));
    return v.state === "UNKNOWN" && v.arm === "instrument-disagreement";
  })(),
  "a stale ledger row is a contradiction as much as a missing one — the arm is symmetric when bounded",
);
check(
  "R3",
  "AGREEMENT quiet pole: both instruments read IDLE → the DRAINED arm fires as before",
  (() => {
    const v = verdict([launch("alpha"), stop("alpha")], 12, undefined, tasksOf(0));
    return v.state === "ADVISE" && v.arm === "drained" && v.harnessLanes === 0 && v.ledgerLanes === 0;
  })(),
  "the contradiction arm is not a blanket mute — agreement still reaches the firing arm",
);
check(
  "R4",
  "UNBOUNDED LEDGER: an unnamed launch no longer silences the session when the harness says IDLE",
  (() => {
    const v = verdict([launch("alpha"), stop("alpha"), launch(null)], 12, undefined, tasksOf(0));
    return v.state === "ADVISE" && v.arm === "drained" && v.ledgerBounded === false;
  })(),
  "THE RECOVERED COVERAGE HOLE: silence in ~5 of 9 sessions, now resolved by the upper bound",
  "M-s: keep the old ok:false refusal on unnamed>0 (the 5-of-9 hole returns)",
);
check(
  "R5",
  "UNBOUNDED LEDGER: its IDLE reading cannot CONTRADICT a busy harness — it is a blind spot",
  (() => {
    const v = verdict([launch("alpha"), stop("alpha"), launch(null)], 12, undefined, tasksOf(3));
    return v.state === "QUIET" && v.arm === "saturated" && v.running === 3;
  })(),
  "asymmetry is the instruments' measured scope, not a preference",
);
check(
  "R6",
  "UNBOUNDED LEDGER: but its BUSY reading against an idle harness IS still a contradiction",
  (() => {
    const v = verdict([launch("alpha"), launch(null)], 12, undefined, tasksOf(0));
    return v.state === "UNKNOWN" && v.arm === "instrument-disagreement";
  })(),
  "the asymmetry is one-directional and does not collapse into 'always trust the harness'",
);
check(
  "R7",
  "HARNESS UNREADABLE firing pole: no upper bound from anywhere is UNKNOWN, never DRAINED",
  (() => {
    const v = L.assessFleetDrain({
      lanes: lanesOf([launch("alpha"), stop("alpha")]),
      work: workOf(12),
      tasks: L.readBackgroundTasks({ hook_event_name: "Stop" }),
    });
    return v.state === "UNKNOWN" && v.arm === "harness-unreadable" && v.ledgerLanes === 0;
  })(),
  "an idle-looking ledger with no harness signal is exactly the confident wrong answer",
  "M-t: fall back to ledger-only when the harness signal is missing",
);
check(
  "R8",
  "OCCUPANCY NUMBER: when both agree BUSY the MAX is taken — conservative against firing",
  (() => {
    const v = verdict([launch("a"), launch("b"), launch("c")], 12, { laneFloor: 1 }, tasksOf(1));
    return v.state === "QUIET" && v.arm === "saturated" && v.running === 3 && v.harnessLanes === 1;
  })(),
  "both firing arms trigger on running being LOW, so the larger reading is the safe one",
);
check(
  "R9",
  "SHELLS do not suppress the drain arm end-to-end",
  (() => {
    const v = verdict([launch("alpha"), stop("alpha")], 12, undefined, tasksOf(0, 4));
    return v.state === "ADVISE" && v.arm === "drained" && v.harnessShells === 4;
  })(),
  "four background shells and zero lanes is still a drained FLEET — MUST-6 is about lanes",
);
check(
  "R10",
  "RENDER: the advisory names BOTH instrument readings, so the operator can check the reconciliation",
  (() => {
    const t = L.formatFleetDrainAdvisory(verdict([launch("alpha"), stop("alpha")], 12, undefined, tasksOf(0, 2)));
    return typeof t === "string" && /background_tasks 0 subagent/.test(t) && /2 shell/.test(t) && /dispatch ledger 0 named/.test(t);
  })(),
  "a reconciled verdict that hides its inputs cannot be audited by its reader",
);

check(
  "C9",
  "FAILS OPEN under a HOSTILE thrown value: the catch block cannot itself throw",
  (() => {
    // A payload whose `background_tasks` getter throws an object with a throwing `message` getter
    // AND a throwing `toString` — the exact pair that turns the reflex
    // `e.message ? e.message : String(e)` idiom into a second throw site inside the catch.
    const hostile = new Proxy(
      {},
      {
        has: () => true,
        getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: undefined }),
        get(_t, k) {
          if (k === "background_tasks") {
            throw {
              get message() {
                throw new Error("nested");
              },
              toString() {
                throw new Error("ts");
              },
            };
          }
          return undefined;
        },
      },
    );
    let r;
    try {
      r = L.readBackgroundTasks(hostile);
    } catch {
      return false;
    }
    return r && r.ok === false && typeof r.reason === "string" && /unreadable|unstringifiable|failed/.test(r.reason);
  })(),
  "a catch that can throw is not a catch — cc-artifacts.md Rule 7",
  "M-u: restore `e && e.message ? e.message : String(e)` in the catch",
);
check(
  "R11",
  "SIGNATURE discriminates the two readings, not just their MAX",
  (() => {
    // Both render `running: 1`, but one ledger reading is an unbounded 0 and the other a bounded 1,
    // and the ADVISORY TEXT differs. A key blind to that deduped the second message away.
    const a = verdict([launch("alpha"), stop("alpha"), launch(null)], 5, undefined, tasksOf(1));
    const b = verdict([launch("alpha")], 5, undefined, tasksOf(1));
    const ta = L.formatFleetDrainAdvisory(a);
    const tb = L.formatFleetDrainAdvisory(b);
    return a.running === 1 && b.running === 1 && ta !== tb && L.signatureOf(a) !== L.signatureOf(b);
  })(),
  "a dedupe key must discriminate everything the message it suppresses says",
  "M-v: drop ledgerLanes/ledgerBounded from the signature",
);
check(
  "R12",
  "NEGATIVE harness lane count is UNKNOWN, never a path INTO the firing arm",
  (() => {
    const v = L.assessFleetDrain({
      lanes: lanesOf([launch("alpha"), stop("alpha")]),
      work: workOf(12),
      tasks: { ok: true, present: true, lanes: -1, laneIds: [], shells: 0, total: 0, unclassified: [], reason: null },
    });
    return v.state === "UNKNOWN" && v.arm === "harness-unreadable";
  })(),
  "-1 !== 0, so a bare `=== 0` drained test passes it straight through to ADVISE",
  "M-w: guard only `!Number.isInteger`, dropping the `< 0` half",
);
check(
  "R13",
  "NaN dispatchable is UNKNOWN — it slips the clean-stop gate silently, because NaN < 1 is FALSE",
  (() => {
    const v = L.assessFleetDrain({
      lanes: lanesOf([launch("alpha"), stop("alpha")]),
      work: { ok: true, total: 3, dispatchable: NaN, humanBlocked: 0, sources: ["x"], reason: null },
      tasks: tasksOf(0),
    });
    return v.state === "UNKNOWN" && v.arm === "work-unreadable";
  })(),
  "every NaN comparison is false, so an unmeasurable board reads as a reason to speak",
  "M-x: drop the `Number.isFinite(work.dispatchable)` half of the work guard",
);
check(
  "R14",
  "FAILS OPEN: assessFleetDrain returns a verdict on HOSTILE readings and NEVER throws",
  (() => {
    const boom = (field) =>
      new Proxy(
        {},
        {
          get(_t, k) {
            if (k === field) throw new Error(`hostile ${String(k)}`);
            if (k === "ok") return true;
            if (k === "running") return [];
            if (k === "lanes") return 0;
            if (k === "dispatchable") return 5;
            return undefined;
          },
        },
      );
    for (const f of ["ok", "running", "boundedAbove", "lanes", "dispatchable", "reason"]) {
      for (const slot of ["lanes", "work", "tasks"]) {
        const readings = { lanes: lanesOf([]), work: workOf(5), tasks: tasksOf(0) };
        readings[slot] = boom(f);
        let v;
        try {
          v = L.assessFleetDrain(readings);
        } catch {
          return false;
        }
        if (!v || !L.STATES.includes(v.state)) return false;
      }
    }
    return true;
  })(),
  "the fails-open contract held for the FUNCTION, not merely for the inputs its producers happen to make",
  "M-z: remove the try/catch wrapper around _assessFleetDrain",
);
// AN EARLIER DRAFT OF R14 ALSO ASSERTED that no hostile reading reaches ADVISE. That assertion was
// WRONG and is withdrawn rather than weakened quietly: a Proxy that throws on `running` in the
// `work` SLOT is not hostile to anything `work` is read for — it returns `ok:true, dispatchable:5`,
// a perfectly valid board — while `lanes` and `tasks` legitimately read 0. Measured, 11 of the 18
// combinations reach ADVISE for exactly that reason and NONE of them threw. Asserting on ADVISE
// there would have pinned an accident of the fixture's own Proxy, not a property of the module.
check(
  "R15",
  "SUBAGENT-BLIND instrument C is caught: a lane misclassified as a shell must NOT reach ADVISE",
  (() => {
    // The residual class 39b exists to pin, asserted here in the library too so it does not rest on
    // one end-to-end case: if instrument C ever returns `ok:true, lanes:0` while a lane runs, the
    // ledger is the only thing left that can contradict it. With a BOUNDED busy ledger it does.
    const v = L.assessFleetDrain({
      lanes: lanesOf([launch("alpha")]),
      work: workOf(12),
      tasks: { ok: true, present: true, lanes: 0, laneIds: [], shells: 1, total: 1, unclassified: [], reason: null },
    });
    return v.state === "UNKNOWN" && v.arm === "instrument-disagreement";
  })(),
  "the cross-check earns its keep exactly when the PRIMARY instrument is the wrong one",
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
// The mirror's line-ending, code-span and fence-pairing rules (review-cor-r10-M3/L1): each moved
// in step with validate-forest-ledger.mjs, and each is pinned here because nothing else pins it.
check(
  "16a",
  "PARSE: a CR-only (old-Mac) ledger is read line by line",
  (() => {
    const p = L.parseForestLedger("## Outstanding ledger (forest)\r\r| F1 | a | x |\r| F2 | b | y |\r");
    return p.found && p.rows.length === 2;
  })(),
  "split on LF alone, the whole file is one line: found=false, 0 rows",
);
check(
  "16b",
  "PARSE: a line-start code span above the heading is not a fence",
  (() => {
    const p = L.parseForestLedger("# S\n\n```npm test``` passed\n\n## Outstanding ledger (forest)\n\n| F1 | a | x |\n");
    return p.found && p.rows.length === 1;
  })(),
  "read as a fence it swallows the heading: found=false",
);
check(
  "16c",
  "PARSE: fences pair by marker — a ``` line inside a ~~~ block does not close it",
  (() => {
    const p = L.parseForestLedger("## Outstanding ledger (forest)\n\n~~~\n```\n| F9 | fenced | x |\n~~~\n\n| F1 | a | x |\n");
    return p.found && p.rows.length === 1 && p.rows[0].includes("F1");
  })(),
  "toggled on any fence line, F9 counts and the real F1 row is hidden",
);
check(
  "16d",
  "PARSE: an indented `  ## ` heading does NOT end the inline section — the validator's does not either (it refuses the line)",
  (() => {
    const p = L.parseForestLedger("## Outstanding ledger (forest)\n\n| F1 | a | x |\n\n  ## Archive\n\n| F2 | b | y |\n");
    return p.found && p.rows.length === 2;
  })(),
  "ending there hid F2 from the count while the validator still reads it (review-sec-r11-F4)",
);
check(
  "16f",
  "PARSE: a `## ` heading whose text starts with an IME space still ends the inline section",
  (() => {
    const p = L.parseForestLedger("## Outstanding ledger (forest)\n\n| F1 | a | x |\n\n## \u3000Archive\n\n| F2 | b | y |\n");
    return p.found && p.rows.length === 1;
  })(),
  "with `\\S`, U+3000 was not text, so the archived F2 counted as open work (review-sec-r13-1)",
);
check(
  "16e",
  "PARSE: a ledger heading indented up to three spaces opens the section, as the validator's does",
  (() => {
    const p = L.parseForestLedger("  ## Outstanding ledger (forest)\n\n| F1 | a | x |\n");
    return p.found && p.rows.length === 1;
  })(),
  "unindented-only, the indented heading read as no ledger at all (review-cor-r12-F4)",
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
    const v = L.assessFleetDrain({ lanes: lanesOf([]), work: workOf(4, 4), tasks: tasksOf(0) });
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
    const v = L.assessFleetDrain({ lanes: lanesOf([]), work: L.countOpenWork([]), tasks: tasksOf(0) });
    return v.state === "UNKNOWN" && v.arm === "work-unreadable" && v.running === 0;
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

// ── 23e. THE FLEET EPOCH — the half of the dedupe contract that was NOT achieved ───────────────
//
// DEFECT 1, measured on session c90a644a 2026-08-20: `state:arm:running:dispatchable` does not
// move when a lane COMPLETES (`running` was already 0 and returns to 0; `dispatchable` is a
// property of the board), so a genuinely NEW drain collided with one already surfaced and was
// suppressed. These pins assert the SIGNATURE STRING ITSELF, not merely inequality: an assertion
// that two signatures "differ" is satisfied by any change, including one that reintroduces the
// collision on a different axis. The exact strings below are the failure IDENTITY
// (`instrument-bipolarity.md` MUST-2) — each names which signature was produced.
//
// The incident's ledger shape is reproduced literally: NO launch rows at all (those lanes were
// dispatched in a PRIOR session, so this session's ledger holds no MAIN_GENERATION launch), and a
// `terminated` count that rises as each lane returns.
const priorSessionDrain = (n) => Array.from({ length: n }, (_, i) => stop(`lane-${i + 1}`));

check(
  "46",
  "EPOCH firing pole: a drain arriving after a lane COMPLETED gets a different signature",
  (() => {
    const before = L.signatureOf(verdict(priorSessionDrain(24), 25));
    const after = L.signatureOf(verdict(priorSessionDrain(25), 25));
    return (
      before === "ADVISE:drained:0:25:0:0:b:0:24" && after === "ADVISE:drained:0:25:0:0:b:0:25" && before !== after
    );
  })(),
  "the measured incident: launched stayed 0, terminated 24→25 — pre-fix BOTH were `ADVISE:drained:0:25`",
  "M-l: drop `launched`/`terminated` from signatureOf (the pre-fix tuple) — reds here",
);
check(
  "47",
  "EPOCH quiet pole: a drain that merely PERSISTS keeps its signature and stays suppressed",
  (() => {
    const rows = priorSessionDrain(24);
    const a = L.signatureOf(verdict(rows, 25));
    const b = L.signatureOf(verdict([...rows], 25));
    return a === b && a === "ADVISE:drained:0:25:0:0:b:0:24";
  })(),
  "nothing completed, nothing dispatched → identical tuple → the noise control the header wants is preserved",
  "M-n: key the signature on a clock/turn counter — would red here by re-surfacing every turn",
);
// CASE 48 WAS RE-AUTHORED 2026-08-20 (round 3) AND ITS MEANING CHANGED. It previously asserted
// that `[stop("ghost"), launch("ghost")]` renders `ADVISE:drained:0:25:1:1` — i.e. "0 lanes
// running, refill now" for a ledger whose LAST row launches `ghost`. That was not a stale
// expectation, it was the surviving half of the order-blindness bug PINNED as correct: the case
// was written to isolate the `launched` epoch field and reached for the cheapest row pair that
// moved it, and the order-insensitive occupancy model of the day agreed. Under last-write-wins
// that ledger says `ghost` is LIVE, so the old expectation is now the wrong answer and asserting
// it would re-pin the defect. The case keeps BOTH jobs — (a) the corrected occupancy answer for
// the relaunch shape, and (b) the same `launched`-alone epoch isolation, moved onto a row pair
// that is order-valid under LWW.
check(
  "48",
  "ORDER: a stop then a RELAUNCH under that name is LIVE — and `launched` still moves ALONE on the drained arm",
  (() => {
    // (a) THE CORRECTED ANSWER. The name is the SendMessage address, so the LAST row decides:
    //     ghost stopped, then ghost launched ⇒ ghost is running. The pre-LWW models both got this
    //     wrong in the SAME direction — the name-set difference subtracted it away, and the
    //     launch-minus-stop balance netted to 0 — so both announced a drained fleet into a live one.
    const dead = verdict([stop("ghost")], 25);
    const live = verdict([stop("ghost"), launch("ghost")], 25);
    // (b) THE EPOCH ISOLATION, preserved. Two DRAINED verdicts with `terminated` held at 1 while
    //     `launched` moves 0→1: a signature carrying `terminated` but not `launched` passes case 46
    //     and FAILS here. The `launch`-then-`stop` order is what keeps the second one drained.
    const before = L.signatureOf(verdict([stop("orphan")], 25));
    const after = L.signatureOf(verdict([launch("beta"), stop("beta")], 25));
    return (
      L.signatureOf(dead) === "ADVISE:drained:0:25:0:0:b:0:1" &&
      live.state === "OBSERVE" &&
      live.running === 1 &&
      String(live.runningNames) === "ghost" &&
      L.signatureOf(live) === "OBSERVE:under-capacity:1:25:1:1:b::" &&
      before === "ADVISE:drained:0:25:0:0:b:0:1" &&
      after === "ADVISE:drained:0:25:0:0:b:1:1"
    );
  })(),
  "the relaunch reads OBSERVE with runningNames=[ghost]; and launched 0→1 with terminated held at 1 moves the drained signature alone",
  "M-m: drop `launched` alone from signatureOf — reds on (b) and NOT at 46. M-y: revert occupancy to the launch-minus-stop balance — reds on (a), which renders `ADVISE:drained:0:25:1:1`",
);
check(
  "49",
  "EPOCH: `assessFleetDrain` THREADS the counters rather than dropping them",
  (() => {
    const v = verdict(priorSessionDrain(24), 25);
    const unknown = L.assessFleetDrain({ lanes: L.countRunningLanes(null, { reason: "absent" }), work: workOf(9) });
    return (
      v.launched === 0 && v.terminated === 24 && unknown.launched === null && unknown.terminated === null
    );
  })(),
  "a measured verdict carries the epoch; an UNMEASURED lane reading carries null, never a fabricated 0",
  "M-l / M-o: revert the assess-level threading — reds here even if signatureOf still reads the fields",
);
check(
  "50",
  "SIGNATURE totality: null and partially-measured verdicts render well-defined, never `undefined`",
  // NINE fields since the instrument-C reconciliation joined the key, so the all-empty constant is
  // eight colons, and the ledger-unreadable arm now NAMES itself in field 1 (it previously rendered
  // an empty arm). Both are asserted verbatim rather than by shape: a totality case that only
  // checked for the absence of `undefined` would pass against a tuple of the wrong arity, which is
  // exactly how a marker written under one format silently fails to match another.
  L.signatureOf(null) === "UNKNOWN::::::::" &&
    L.signatureOf(L.assessFleetDrain({ lanes: L.countRunningLanes(null, { reason: "x" }), work: workOf(9) })) ===
      "UNKNOWN:ledger-unreadable:::::::" &&
    !/undefined/.test(L.signatureOf({ state: "ADVISE" })),
  "the marker key is a string on every path; a thrown or `undefined`-bearing key would cost the finding",
);

// ── 29. THE SAME-NAME CRIT — a reused lane name froze the epoch and the occupancy count ────────
//
// Found by adversarial redteam 2026-08-20, then reproduced end-to-end (case 68). ONE root cause:
// `launched`/`terminated` were name SETS, so a lane that ran, stopped and ran AGAIN under the same
// name was invisible to both readings. Two defects fell out of it, and both are pinned here.
//
// The realistic trigger is not exotic: a repeated review loop dispatching `correctness` +
// `security` every round, or `agents.md` § RECOVERY resuming a stalled lane under its original
// name. `dispatch-ledger.js` § "KNOWN RESIDUAL" already records same-(generation, name) reuse.
//
// Every pin below asserts the SIGNATURE STRING or the exact reading, never a bare inequality
// (`instrument-bipolarity.md` MUST-2): the failure IDENTITY is which tuple collided, and "they
// differ" is satisfied by any change including one that reintroduces the collision elsewhere.
const REVIEW_WAVE = () => [launch("correctness"), launch("security"), stop("correctness"), stop("security")];

check(
  "58",
  "CRIT firing pole: a SECOND wave reusing the SAME lane names produces a DIFFERENT signature",
  (() => {
    const one = L.signatureOf(verdict(REVIEW_WAVE(), 3));
    const two = L.signatureOf(verdict([...REVIEW_WAVE(), ...REVIEW_WAVE()], 3));
    return one === "ADVISE:drained:0:3:0:0:b:2:2" && two === "ADVISE:drained:0:3:0:0:b:4:4";
  })(),
  "row counts 2:2 → 4:4; under the name-SET epoch BOTH rendered `ADVISE:drained:0:3:2:2` and the second drain was suppressed for the session",
  "M-s: revert the epoch to set cardinality — both signatures collapse to :2:2 and this reds",
);
check(
  "59",
  "CRIT quiet pole: the noise control survives — an UNCHANGED ledger still yields the SAME signature",
  (() => {
    const rows = REVIEW_WAVE();
    return (
      L.signatureOf(verdict(rows, 3)) === L.signatureOf(verdict([...rows], 3)) &&
      L.signatureOf(verdict(rows, 3)) === "ADVISE:drained:0:3:0:0:b:2:2"
    );
  })(),
  "counting rows must not become re-surfacing every turn; nothing appended ⇒ identical tuple",
  "M-n: a clock-keyed signature reds here",
);
check(
  "60",
  "OCCUPANCY firing pole: a lane RELAUNCHED under a name already stopped reads as RUNNING",
  (() => {
    const r = lanesOf([launch("alpha"), stop("alpha"), launch("alpha")]);
    return r.ok && r.running.length === 1 && r.running[0] === "alpha" && r.launched === 2 && r.terminated === 1;
  })(),
  "the co-morbid defect: with name-set difference `alpha` sat in BOTH sets and was subtracted away, so the detector reported running=0 into a LIVE fleet",
  "M-t: restore `[...launched].filter(n => !terminated.has(n))` — running is [] and this reds",
);
check(
  "61",
  "OCCUPANCY quiet pole: once the relaunched lane stops, its last row is that stop and it IS drained",
  (() => {
    const rows = [launch("alpha"), stop("alpha"), launch("alpha"), stop("alpha")];
    const r = lanesOf(rows);
    return r.ok && r.running.length === 0 && r.launched === 2 && r.terminated === 2 && verdict(rows, 16).state === "ADVISE";
  })(),
  "order-awareness must not report a phantom lane either — the last row for `alpha` is a stop ⇒ genuinely drained",
);
check(
  "62",
  "CRIT: the full relaunch SEQUENCE — every step's arm and signature, including the frozen one",
  (() => {
    const a = [launch("alpha")];
    const b = [...a, stop("alpha")];
    const c = [...b, launch("alpha")];
    const d = [...c, stop("alpha")];
    return (
      L.signatureOf(verdict(a, 25)) === "OBSERVE:under-capacity:1:25:1:1:b::" &&
      L.signatureOf(verdict(b, 25)) === "ADVISE:drained:0:25:0:0:b:1:1" &&
      L.signatureOf(verdict(c, 25)) === "OBSERVE:under-capacity:1:25:1:1:b::" &&
      L.signatureOf(verdict(d, 25)) === "ADVISE:drained:0:25:0:0:b:2:2"
    );
  })(),
  "pre-fix steps b/c/d ALL rendered `ADVISE:drained:0:25:1:1` — step c wrongly claimed a drained fleet while alpha ran, and step d was suppressed",
  "M-s / M-t: either revert collapses steps b..d onto one tuple and this reds",
);

// ── 32. ORDER IS THE ANSWER — the two sequences a launch-minus-stop BALANCE cannot tell apart ───
//
// Found by adversarial redteam 2026-08-20 against the balance model that fixed the name-set CRIT
// above. A balance is ORDER-INSENSITIVE, and both sequences below hold two launch rows and one
// stop row for ONE name — so both net to +1 and both read "live", while their truths are OPPOSITE.
//
// The DEAD one is reachable in production, not contrived: `emit-dispatch-ledger.js` writes the
// launch row at `PreToolUse`, BEFORE the dispatch runs, while `dispatch-contract-guard.js` refuses
// on the SAME matcher — so a REFUSED dispatch leaves an unbalanceable launch row with no lane. The
// operator then relaunches under the same name (`agents.md` § RECOVERY) and the balance is stuck
// above zero for the session: a PHANTOM lane, OBSERVE forever, never the ADVISE that is the whole
// point. That is a REGRESSION against the name-set difference it replaced, which returned `[]`.
//
// Both poles assert the exact arm, occupancy and signature — the failure IDENTITY, never a bare
// "they differ" (`instrument-bipolarity.md` MUST-2), because "differ" is satisfied by any change
// including one that swaps which of the two is wrong.
check(
  "70",
  "ORDER firing pole: two launches then a stop is DEAD — a refused dispatch must not leave a phantom lane",
  (() => {
    const rows = [launch("a"), launch("a"), stop("a")];
    const r = lanesOf(rows);
    const v = verdict(rows, 25);
    return (
      r.ok &&
      r.running.length === 0 &&
      r.launched === 2 &&
      r.terminated === 1 &&
      v.state === "ADVISE" &&
      v.arm === "drained" &&
      L.signatureOf(v) === "ADVISE:drained:0:25:0:0:b:2:1"
    );
  })(),
  "the LAST row for `a` is its stop ⇒ dead; under the balance (2−1=+1) this rendered an OBSERVE tuple and went silent for the session",
  "M-y: revert occupancy to the launch-minus-stop balance — running becomes [a], the arm flips to OBSERVE and this reds",
);
check(
  "71",
  "ORDER quiet pole: the SAME three rows RE-ORDERED (launch, stop, launch) is LIVE — and the two are DISTINGUISHED",
  (() => {
    const dead = [launch("a"), launch("a"), stop("a")];
    const live = [launch("a"), stop("a"), launch("a")];
    const rl = lanesOf(live);
    const vl = verdict(live, 25);
    return (
      rl.ok &&
      rl.running.length === 1 &&
      String(rl.running) === "a" &&
      rl.launched === 2 &&
      rl.terminated === 1 &&
      vl.state === "OBSERVE" &&
      L.signatureOf(vl) === "OBSERVE:under-capacity:1:25:1:1:b::" &&
      L.signatureOf(verdict(dead, 25)) !== L.signatureOf(vl)
    );
  })(),
  "identical row MULTISET, opposite truths: the epoch pair is 2:1 in BOTH, so only the order distinguishes them — a balance renders both as the same OBSERVE tuple",
  "M-y: under the balance both sequences render the SAME signature and the inequality at the end reds",
);

// ── 30. THE EPOCH IS SCOPED TO THE `ADVISE` ARM — a nested-churn noise bound ────────────────────
//
// A reconcile row is NOT generation-filtered (it cannot be — its `generation` is the STOPPING
// lane's own name, so filtering to `(main-agent)` would discard every termination signal). So a
// nested subagent's stop moves the epoch with no main-fleet change. On ADVISE that is the MUST-6
// refill trigger and is wanted. On OBSERVE — an arm that by construction gives NO advice — it
// would `halt-and-report` every turn of a sequential one-lane workflow. Hence the arm scoping.
check(
  "63",
  "ARM-SCOPE firing pole: nested churn does NOT re-surface the OBSERVE arm",
  (() => {
    // ROUTED THROUGH `verdict()`, not a bare `assessFleetDrain`, since the instrument-C
    // reconciliation landed: a reading with NO harness signal is `harness-unreadable`/UNKNOWN, so
    // the bare form would assert arm-scoping against a verdict that never reaches an arm — a case
    // passing for a reason unrelated to its name. `verdict()` supplies the AGREEING harness reading,
    // which is what this case always meant by "one lane is running".
    const one = verdict([launch("alpha"), stop("nested-1")], 25);
    const two = verdict([launch("alpha"), stop("nested-1"), stop("nested-2")], 25);
    return (
      one.state === "OBSERVE" &&
      two.terminated === 2 &&
      L.signatureOf(one) === "OBSERVE:under-capacity:1:25:1:1:b::" &&
      L.signatureOf(two) === "OBSERVE:under-capacity:1:25:1:1:b::"
    );
  })(),
  "the verdict still CARRIES the epoch (terminated 1→2); the OBSERVE signature deliberately does not read it",
  "M-u: read the epoch on every arm — the two signatures differ and this reds",
);
check(
  "64",
  "ARM-SCOPE quiet pole: the SAME churn on the DRAINED arm still re-surfaces (c90a644a preserved)",
  (() => {
    const one = L.signatureOf(verdict([stop("nested-1")], 25));
    const two = L.signatureOf(verdict([stop("nested-1"), stop("nested-2")], 25));
    return one === "ADVISE:drained:0:25:0:0:b:0:1" && two === "ADVISE:drained:0:25:0:0:b:0:2";
  })(),
  "zero main launches with rising terminations IS the measured c90a644a shape — scoping the epoch to ADVISE must not disarm it",
  "M-v: scope `terminated` to main-fleet names instead — launched is 0 here so the epoch freezes at 0:0 and this reds",
);

// ── 31. the marker path is INJECTIVE — a suppression store must not collide across sessions ─────
check(
  "65",
  "MARKER-PATH firing pole: two ids that SANITIZE to the same token land on DISTINCT files",
  L._markerPath("/r", "sess:a") !== L._markerPath("/r", "sess/a") &&
    L._markerPath("/r", "sess:a") !== L._markerPath("/r", "sess a"),
  "the charclass collapses `:`/`/`/space to `_`; without the sha256 suffix one session's marker silences another's drain",
  "M-w: drop the sha256 disambiguator — all three paths collide and this reds",
);
check(
  "66",
  "MARKER-PATH quiet pole: deterministic for one id, and no id can traverse out of the sink dir",
  L._markerPath("/r", "x") === L._markerPath("/r", "x") &&
    path.dirname(L._markerPath("/r", "../../etc/passwd")) === path.join("/r", ".claude", "learning", "fleet-drain") &&
    path.dirname(L._markerPath("/r", "")) === path.join("/r", ".claude", "learning", "fleet-drain"),
  "injectivity must not come at the cost of stability or containment",
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
  check(
    "67",
    "MARKER symlink refusal: a marker path that is a SYMLINK reads as NOT-surfaced",
    (() => {
      const sig = "ADVISE:drained:0:9:1:1";
      const planted = path.join(tmp, "planted.jsonl");
      fs.writeFileSync(planted, JSON.stringify({ v: 1, signature: sig, ts: "2026-08-20T00:00:00.000Z" }) + "\n");
      const link = L._markerPath(tmp, "symlink-session");
      fs.mkdirSync(path.dirname(link), { recursive: true });
      try {
        fs.symlinkSync(planted, link);
      } catch {
        return false; // a platform without symlinks cannot answer this question — fail LOUD
      }
      // CONTROL, so this is not a vacuous green: the SAME bytes at a REGULAR file DO suppress.
      const realSid = "regular-file-session";
      const real = L._markerPath(tmp, realSid);
      fs.copyFileSync(planted, real);
      return L.alreadySurfaced(tmp, "symlink-session", sig) === false && L.alreadySurfaced(tmp, realSid, sig) === true;
    })(),
    "the suppression side now lstat-refuses a link, symmetric with appendSinkLine's write-side refusal; the regular-file control proves the read path still works",
    "M-x: revert `lstatSync`/isSymbolicLink to `statSync` — the link resolves, suppresses, and this reds",
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

  // ── DEFECT 1, END TO END ────────────────────────────────────────────────────────────────────
  // Case 41 above just established that this exact ledger+board is SUPPRESSED on a repeat turn.
  // Now ONE lane completes — a single extra reconcile row, the cheapest possible fleet change —
  // and nothing else moves: `running` is still 0 (gamma was never launched by the main agent),
  // `dispatchable` is still 3. Pre-fix the signature was `ADVISE:drained:0:3` both times and this
  // turn was silent; post-fix it is `ADVISE:drained:0:3:2:3` and the refill trigger fires.
  fs.appendFileSync(
    sink,
    JSON.stringify({ ...stop("gamma"), v: 1, session_id: sid, ts: "2026-08-17T00:00:04.000Z" }) + "\n",
  );
  const afterCompletion = fire(HOOK, tmp, sid);
  check(
    "51",
    "HOOK firing pole (epoch): a lane COMPLETING re-surfaces the drain on the same board",
    (() => {
      let j = null;
      try {
        j = JSON.parse(afterCompletion.stdout.trim().split("\n").pop());
      } catch {}
      return (
        afterCompletion.code === 0 &&
        j &&
        j.continue === true &&
        typeof j.systemMessage === "string" &&
        /FLEET DRAINED/.test(j.systemMessage)
      );
    })(),
    `terminated 2→3 with the board unchanged → re-surfaced (exit=${afterCompletion.code})`,
    "M-l: pre-fix signature — this turn goes SILENT and the case reds",
  );
  const afterCompletionRepeat = fire(HOOK, tmp, sid);
  check(
    "52",
    "HOOK quiet pole (epoch): the NEW signature is itself deduped on the following turn",
    (() => {
      let j = null;
      try {
        j = JSON.parse(afterCompletionRepeat.stdout.trim().split("\n").pop());
      } catch {}
      return afterCompletionRepeat.code === 0 && j && j.continue === true && j.systemMessage === undefined;
    })(),
    "re-surfacing on CHANGE must not become re-surfacing on every turn",
    "M-n: a clock/turn-keyed signature reds here",
  );

  // ── THE SAME-NAME CRIT, END TO END ──────────────────────────────────────────────────────────
  // A fresh session in the same throwaway repo, driving the REAL hook three times:
  //   turn 1  a two-lane wave launched and both reconciled            → drained, SURFACES
  //   turn 2  REFILL reusing BOTH names, then both stop again         → a NEW drain
  // Nothing but the ledger changes between them: `running` is 0 both times, `dispatchable` is 3
  // both times. Under the name-SET epoch the second turn's key was byte-identical to the first's
  // (`ADVISE:drained:0:3:2:2`) and the hook went SILENT for the rest of the session — measured
  // pre-fix at exactly this input. Turn 1 is the positive control: if it did not speak, turn 2's
  // silence would be uninformative (`instrument-discipline.md` MUST-3(a)).
  const critSid = "same-name-refill-session";
  const critSink = LEDGER._sinkPath(tmp, critSid);
  fs.mkdirSync(path.dirname(critSink), { recursive: true });
  const critWave = (t) =>
    [
      JSON.stringify({ ...launch("correctness"), v: 1, session_id: critSid, ts: `2026-08-20T00:00:0${t}.000Z` }),
      JSON.stringify({ ...launch("security"), v: 1, session_id: critSid, ts: `2026-08-20T00:00:0${t + 1}.000Z` }),
      JSON.stringify({ ...stop("correctness"), v: 1, session_id: critSid, ts: `2026-08-20T00:00:0${t + 2}.000Z` }),
      JSON.stringify({ ...stop("security"), v: 1, session_id: critSid, ts: `2026-08-20T00:00:0${t + 3}.000Z` }),
      "",
    ].join("\n");
  const spoke = (r) => {
    let j = null;
    try {
      j = JSON.parse(r.stdout.trim().split("\n").pop());
    } catch {}
    return !!(r.code === 0 && j && j.continue === true && typeof j.systemMessage === "string" && /FLEET DRAINED/.test(j.systemMessage));
  };

  fs.writeFileSync(critSink, critWave(0));
  const critFirst = fire(HOOK, tmp, critSid);
  check(
    "68a",
    "CRIT e2e control: the FIRST drain surfaces (without this, the next case's reading is unusable)",
    spoke(critFirst),
    `first wave → exit=${critFirst.code}, spoke=${spoke(critFirst)}`,
  );
  fs.appendFileSync(critSink, critWave(4));
  const critSecond = fire(HOOK, tmp, critSid);
  check(
    "68",
    "CRIT e2e firing pole: a refill REUSING both lane names, then draining again, RE-SURFACES",
    spoke(critSecond),
    `second wave (same two names) → exit=${critSecond.code}, spoke=${spoke(critSecond)} — pre-fix this turn was SILENT and stayed silent for the session`,
    "M-s / M-t — and the pre-fix name-SET epoch, measured SILENT at exactly this input",
  );
  const critThird = fire(HOOK, tmp, critSid);
  check(
    "68b",
    "CRIT e2e quiet pole: with nothing appended, that new signature is itself deduped",
    (() => {
      let j = null;
      try {
        j = JSON.parse(critThird.stdout.trim().split("\n").pop());
      } catch {}
      return critThird.code === 0 && j && j.continue === true && j.systemMessage === undefined;
    })(),
    "re-surfacing on CHANGE must not become re-surfacing on every turn",
    "M-n",
  );
  check(
    "69",
    "HOOK protocol: a DELIVERING run writes EXACTLY ONE protocol line",
    critFirst.stdout.split("\n").filter((l) => l.trim() !== "").length === 1 &&
      critThird.stdout.split("\n").filter((l) => l.trim() !== "").length === 1,
    `delivering run ${critFirst.stdout.split("\n").filter((l) => l.trim() !== "").length} line(s), silent run ${critThird.stdout.split("\n").filter((l) => l.trim() !== "").length}`,
    // SCOPE, stated because the obvious claim for this case is FALSE. It pins one-line-per-run on
    // the NORMAL path. It does NOT pin the `emitted` guard in `fleet-drain-guard.js`, and that was
    // MEASURED, not assumed: the only mutation that can drive the guard is forcing TIMEOUT_MS to 0,
    // and its CONTROL (timeout 0, guard intact) reds the identical set {39, 51, 68a, 68, 55, 56} —
    // so the mutation carries no information about the guard. The reason is structural: the marker
    // append is SYNCHRONOUS and a synchronous stall cannot yield to a timer (measured: a 50ms timer
    // armed before a 400ms sync spin fires at 400ms). The guard is therefore correct and defensive
    // but UNPINNED by this set, which is recorded rather than papered over.
    "no discriminating mutation — see the scope note",
  );

  const killed = fire(HOOK, tmp, "kill-switch-session", { COC_FLEET_DRAIN: "off" });
  check(
    "42",
    "HOOK quiet pole: the kill switch silences the detector end-to-end",
    killed.code === 0 && !/systemMessage/.test(killed.stdout),
    `COC_FLEET_DRAIN=off → ${killed.stdout.trim().slice(0, 40)}`,
  );
  // END-TO-END RECONCILIATION. Same drained ledger shape, same populated board, and — load-bearing
  // — its OWN session id, so the dedupe marker cannot account for the silence. An earlier draft
  // reused `sid`, whose fires 39/41 had already written the marker `ADVISE:drained:0:3:0`; MEASURED
  // under a mutation that makes instrument C classify a running subagent as a shell (so it returns
  // `ok:true, lanes:0` for a BUSY harness — the confidently-wrong direction), that draft still read
  // PASS while the very same input under a FRESH session id emitted `FLEET DRAINED` with a lane
  // running. The silence was the marker, not the reconciliation. A pin that passes for a reason
  // other than the one it claims is not a pin.
  const sidBusy = "busy-harness-session";
  const sinkBusy = LEDGER._sinkPath(tmp, sidBusy);
  fs.mkdirSync(path.dirname(sinkBusy), { recursive: true });
  fs.writeFileSync(
    sinkBusy,
    [
      JSON.stringify({ ...launch("delta"), v: 1, session_id: sidBusy, ts: "2026-08-20T00:00:00.000Z" }),
      JSON.stringify({ ...stop("delta"), v: 1, session_id: sidBusy, ts: "2026-08-20T00:00:01.000Z" }),
      "",
    ].join("\n"),
  );
  const busyHarness = fire(HOOK, tmp, sidBusy, undefined, [
    { id: "a861595c6f0405427", type: "subagent", status: "running", description: "probe sleeper", agent_type: "general-purpose" },
  ]);
  check(
    "39b",
    "HOOK firing pole (the FP, closed): a drained LEDGER but a BUSY harness emits nothing",
    busyHarness.code === 0 && !/systemMessage/.test(busyHarness.stdout) && /"continue":true/.test(busyHarness.stdout),
    `busy harness → ${busyHarness.stdout.trim().slice(0, 50)}`,
    "M-r / M-t: without the reconciliation this re-emits FLEET DRAINED while a lane runs",
  );
  // 39c gets its OWN DRAINED LEDGER under a fresh session id, and that is load-bearing rather than
  // tidiness. An earlier draft reused a session with no ledger at all: it was silent under the
  // ledger-only-fallback mutation too, because the LEDGER was unreadable — so it could not have
  // discriminated the very path it names. MEASURED: with this ledger in place, the mutation that
  // treats an absent harness key as 0 lanes turns this case from silent to FLEET DRAINED.
  const sidNoKey = "absent-bg-key-session";
  const sinkNoKey = LEDGER._sinkPath(tmp, sidNoKey);
  fs.mkdirSync(path.dirname(sinkNoKey), { recursive: true });
  fs.writeFileSync(
    sinkNoKey,
    [
      JSON.stringify({ ...launch("gamma"), v: 1, session_id: sidNoKey, ts: "2026-08-20T00:00:00.000Z" }),
      JSON.stringify({ ...stop("gamma"), v: 1, session_id: sidNoKey, ts: "2026-08-20T00:00:01.000Z" }),
      "",
    ].join("\n"),
  );
  const missingKey = rawFire(HOOK, tmp, JSON.stringify({ hook_event_name: "Stop", session_id: sidNoKey }));
  check(
    "39c",
    "HOOK quiet pole: a DRAINED ledger with NO background_tasks key is UNKNOWN — silent, exit 0",
    missingKey.code === 0 && !/systemMessage/.test(missingKey.stdout) && /"continue":true/.test(missingKey.stdout),
    `absent key over a drained ledger → ${missingKey.stdout.trim().slice(0, 50)}`,
    "M-t2: treat an absent harness key as 0 lanes and fall back to the ledger alone",
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

  // ── UNIDENTIFIED SESSIONS MUST NOT SHARE ONE SUPPRESSION FILE ───────────────────────────────
  //
  // Found by adversarial security review 2026-08-20. `_markerPath` falls back to the literal
  // "unknown-session" when `session_id` is missing, so EVERY session lacking one derived the SAME
  // marker path — and the sha256 disambiguator cannot separate them, because it hashes that same
  // fallback string. Session A's marker then silenced session B's genuine drain: the one direction
  // `_markerPath`'s own header says the suffix exists to prevent. The fix exempts an unidentified
  // session from dedupe entirely (emit, write nothing), so the cost is a repeated line per turn.
  //
  // The ledger is seeded under `unknown-session` because that is the id the hook reads WITH when
  // the payload carries none — without this the run would be UNKNOWN and the case would pass for
  // the wrong reason (a silent hook), which is why 71 asserts the finding is actually EMITTED.
  const anonSink = LEDGER._sinkPath(tmp, "unknown-session");
  fs.mkdirSync(path.dirname(anonSink), { recursive: true });
  fs.writeFileSync(
    anonSink,
    [
      JSON.stringify({ ...launch("alpha"), v: 1, session_id: "unknown-session", ts: "2026-08-17T00:00:00.000Z" }),
      JSON.stringify({ ...stop("alpha"), v: 1, session_id: "unknown-session", ts: "2026-08-17T00:00:01.000Z" }),
      "",
    ].join("\n"),
  );
  const anonMarker = path.join(tmp, ".claude", "learning", "fleet-drain");
  const anonBefore = fs.existsSync(anonMarker) ? fs.readdirSync(anonMarker) : [];

  // `background_tasks: []` IS REQUIRED, and its absence would make every case below pass for the
  // wrong reason. Since instrument C landed, a payload with NO `background_tasks` key has no upper
  // bound from anywhere and the detector goes UNKNOWN — SILENT. A firing pole asserting "it spoke"
  // would then red honestly (75/72/74 did), but the QUIET pole 73 ("no marker was written") would
  // PASS on a hook that never even reached the dedupe, which is the non-discriminating instrument
  // `instrument-discipline.md` MUST-1 forbids citing. `[]` is the harness's own IDLE statement
  // (probe condition A, verbatim) and is what a genuinely drained turn carries, so it restores the
  // anonymous-session question — dedupe behaviour — as the only variable these cases test.
  const anonPayload = JSON.stringify({ hook_event_name: "Stop", background_tasks: [] });

  const anon1 = rawFire(HOOK, tmp, anonPayload);
  check(
    "75",
    "ANON firing pole: a payload with NO session_id still EMITS the drain finding",
    anon1.code === 0 && /FLEET DRAINED/.test(anon1.stdout),
    `exit=${anon1.code} spoke=${/FLEET DRAINED/.test(anon1.stdout)}`,
    "reverting the !hasSessionId early-emit (it would fall through to the shared-marker dedupe)",
  );

  const anon2 = rawFire(HOOK, tmp, anonPayload);
  check(
    "72",
    "ANON must-fire-again: a SECOND unidentified turn is NOT suppressed — no shared marker exists",
    anon2.code === 0 && /FLEET DRAINED/.test(anon2.stdout),
    `second anonymous turn spoke=${/FLEET DRAINED/.test(anon2.stdout)} — pre-fix it was silenced by turn 1's marker`,
    "reverting the !hasSessionId early-emit — turn 1 marks, turn 2 goes silent",
  );

  const anonAfter = fs.existsSync(anonMarker) ? fs.readdirSync(anonMarker) : [];
  check(
    "73",
    "ANON quiet pole: an unidentified session writes NO marker file at all",
    anonAfter.filter((f) => !anonBefore.includes(f)).filter((f) => /^unknown-session/.test(f)).length === 0,
    `new unknown-session marker file(s): ${anonAfter.filter((f) => !anonBefore.includes(f)).filter((f) => /^unknown-session/.test(f)).length} — writing one is what let it silence a DIFFERENT session`,
    "reverting the !hasSessionId early-emit (a marker appears)",
  );

  const blank = rawFire(HOOK, tmp, JSON.stringify({ hook_event_name: "Stop", session_id: "   ", background_tasks: [] }));
  check(
    "74",
    "ANON: a WHITESPACE-only session_id is treated as ABSENT — the `.trim()` door dispatch-ledger already has",
    blank.code === 0 && /FLEET DRAINED/.test(blank.stdout),
    `blank id spoke=${/FLEET DRAINED/.test(blank.stdout)} — pre-fix it read the ledger at \`unknown-session\` but wrote the marker at \`__\``,
    "dropping the .trim().length>0 leg of hasSessionId",
  );

  check(
    "45",
    "ISOLATION: nothing was written under the real repo's .claude/learning/fleet-drain",
    !fs.existsSync(path.join(REPO, ".claude/learning/fleet-drain")) ||
      fs
        .readdirSync(path.join(REPO, ".claude/learning/fleet-drain"))
        .every(
          (f) =>
            !/^(hook-boundary|kill-switch|session-with-no-ledger|sess-1|emit-fail|symlink-session|regular-file-session|same-name-refill-session)/.test(
              f,
            ),
        ),
    "the fixtures point CLAUDE_PROJECT_DIR at a throwaway repo",
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 27. DEFECT 2 — the marker is written only AFTER the finding reaches stdout ─────────────────
//
// The guard absorbs a renderer failure and writes a bare `{continue:true}` so a broken renderer
// never costs the shutdown. Pre-fix the dedupe marker was written BEFORE that emit, so the
// absorbed failure left the signature recorded as surfaced HAVING NEVER BEEN DELIVERED —
// suppressed for the rest of the session. That inverts the header's stated tradeoff (a marker
// problem must cost a REPEATED line, never a SUPPRESSED finding).
//
// HOW THE FAILURE IS INDUCED, and why it is the real script under test: a `--require` preload
// patches `Module._load` to throw for `instruct-and-wait.js` ONLY, then node runs the real
// `fleet-drain-guard.js` as the main module (so its `require.main === module` entry point fires
// normally). Nothing in the hook, the lib, or the repo is modified.
//
// THE MUTATION IS SHOWN TO REACH THE CODE (`instrument-discipline.md` MUST-2(b)) rather than
// assumed: case 53 asserts the stubbed run produces NO `systemMessage`, while case 55 asserts the
// IDENTICAL invocation without the stub DOES. A stub that never reached the renderer would emit
// the finding in both, and 53 would red.
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-drain-emitfail-"));
  execFileSync("git", ["init", "-q", tmp2], { stdio: "ignore" });
  fs.mkdirSync(path.join(tmp2, ".session-notes.d"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp2, ".session-notes.d", "op.md"),
    "## Outstanding ledger (forest)\n\n| ID | Item | Status |\n| --- | --- | --- |\n" +
      "| `F1` | a | open |\n| `F2` | b | open |\n| `F3` | c | open |\n",
  );

  const HOOK2 = path.join(REPO, ".claude/hooks/fleet-drain-guard.js");
  const sid2 = "emit-fail-session";
  const sink2 = LEDGER._sinkPath(tmp2, sid2);
  fs.mkdirSync(path.dirname(sink2), { recursive: true });
  fs.writeFileSync(
    sink2,
    [
      JSON.stringify({ ...launch("alpha"), v: 1, session_id: sid2, ts: "2026-08-20T00:00:00.000Z" }),
      JSON.stringify({ ...launch("beta"), v: 1, session_id: sid2, ts: "2026-08-20T00:00:01.000Z" }),
      JSON.stringify({ ...stop("alpha"), v: 1, session_id: sid2, ts: "2026-08-20T00:00:02.000Z" }),
      JSON.stringify({ ...stop("beta"), v: 1, session_id: sid2, ts: "2026-08-20T00:00:03.000Z" }),
      "",
    ].join("\n"),
  );
  // launched 2 / terminated 2 / running 0 / dispatchable 3, with the harness reading 0 lanes and the
  // ledger bounded (`b`) — the exact key this board must produce.
  const EXPECTED_SIG = "ADVISE:drained:0:3:0:0:b:2:2";

  const breaker = path.join(tmp2, "break-renderer.cjs");
  fs.writeFileSync(
    breaker,
    'const Module = require("node:module");\n' +
      "const orig = Module._load;\n" +
      "Module._load = function (request, parent, isMain) {\n" +
      '  if (/instruct-and-wait\\.js$/.test(String(request))) throw new Error("renderer unavailable (fixture)");\n' +
      "  return orig.apply(this, arguments);\n" +
      "};\n",
  );

  // Resolved through the PRODUCER'S OWN derivation, never restated here. `_markerPath` appends an
  // 8-char sha256 of the raw session id (the injectivity fix — case 65), and a fixture that
  // rebuilt the name by hand would read through a different door than the hook writes through:
  // exactly the two-doors defect `dispatch-ledger.js::_sinkPath` records.
  const markerPath = L._markerPath(tmp2, sid2);
  const markerRows = () => {
    try {
      return fs
        .readFileSync(markerPath, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  // `background_tasks: []` for the same reason the anonymous block carries it: without the key the
  // hook goes UNKNOWN and never reaches the renderer at all, so the induced failure would not be
  // induced — and case 53, which asserts NO `systemMessage`, would pass against a run that was
  // silent rather than one whose renderer threw. That is the exact "shown to reach the code"
  // property the block comment above claims (`instrument-discipline.md` MUST-2(b)); case 55 is its
  // other pole and uses `fire()`, which supplies the same idle array.
  const broken = spawnSync("node", ["--require", breaker, HOOK2], {
    input: JSON.stringify({ hook_event_name: "Stop", session_id: sid2, background_tasks: [] }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmp2 },
  });
  const brokenOut = broken.stdout || "";
  check(
    "53",
    "EMIT-FAILURE control: the induced renderer failure REACHES the code — no finding is delivered",
    broken.status === 0 && /"continue":true/.test(brokenOut) && !/systemMessage/.test(brokenOut),
    `stubbed run exit=${broken.status} stdout=${brokenOut.trim().slice(0, 60)} — case 55 is its other pole`,
  );
  check(
    "54",
    "EMIT-FAILURE firing pole: an UNDELIVERED finding is NOT marked",
    markerRows().every((r) => r.signature !== EXPECTED_SIG),
    `marker holds ${markerRows().length} row(s); none may claim ${EXPECTED_SIG} was surfaced`,
    "M-p: restore mark-before-emit — the marker exists here and this case reds",
  );

  const recovered = fire(HOOK2, tmp2, sid2);
  check(
    "55",
    "EMIT-FAILURE recovery: the next Stop STILL surfaces it — the finding was not lost",
    (() => {
      let j = null;
      try {
        j = JSON.parse(recovered.stdout.trim().split("\n").pop());
      } catch {}
      return (
        recovered.code === 0 && j && j.continue === true && typeof j.systemMessage === "string" &&
        /FLEET DRAINED/.test(j.systemMessage)
      );
    })(),
    `exit=${recovered.code} — pre-fix this turn is SILENT because the failed emit already marked ${EXPECTED_SIG}`,
    "M-p: restore mark-before-emit — reds here",
  );
  check(
    "56",
    "EMIT-SUCCESS quiet pole: a DELIVERED finding is marked exactly once, under the epoch key",
    (() => {
      const rows = markerRows().filter((r) => r.signature === EXPECTED_SIG);
      return rows.length === 1;
    })(),
    `exactly one ${EXPECTED_SIG} row after one delivery (observed ${markerRows().length} total row(s))`,
    "M-q: mark unconditionally after emit — the stubbed run would have left a row and this reds",
  );
  const dedupedAgain = fire(HOOK2, tmp2, sid2);
  check(
    "57",
    "EMIT-SUCCESS: and that one marker DOES suppress the next identical turn",
    (() => {
      let j = null;
      try {
        j = JSON.parse(dedupedAgain.stdout.trim().split("\n").pop());
      } catch {}
      return dedupedAgain.code === 0 && j && j.continue === true && j.systemMessage === undefined;
    })(),
    "emit-then-mark preserves the dedupe it reorders — it does not disable it",
    "M-r: never mark at all — the detector re-fires every turn and this reds",
  );

  fs.rmSync(tmp2, { recursive: true, force: true });
}

// ── 28. THE READ HALF OF THE MARKER CONTRACT (loom#1762 follow-up, CRITICAL A) ─────────────────
//
// `alreadySurfaced` was the THIRD live reader of a sink, and the only one still on a bare
// `fs.lstatSync` + `fs.readFileSync` after the loom#1762 fix switched its two siblings to the
// shared `append-sink.js::readSinkFile` primitive. Its own comment claimed the lstat was "the
// symmetric refusal" to the hardened write side. IT WAS NOT: lstat declines to follow only the
// FINAL component, so replacing the sink DIRECTORY with a symlink walked straight out of the
// repository and an attacker-owned file decided which findings this repo suppresses. The cap was
// gated on the same lstat, which `readSinkFile`'s header already records as decorative.
//
// MEASURED, one probe, four arms — the last is the control that makes the third readable:
//     fleet-drain,        in-tree marker WITH the signature   -> true   (the matcher fires)
//     fleet-drain,        in-tree marker WITHOUT it           -> false  (it discriminates)
//     fleet-drain,        OUT-OF-TREE sink-dir symlink        -> true   <-- SUPPRESSED
//     delegation-default, byte-identical shape                -> false  (its fixed reader refuses)
//
// EVERY CASE BELOW WAS ABSENT WHEN THE FIX LANDED AND THIS SUITE REPORTED 110/110 GREEN AGAINST
// IT. That is the standing property of this branch — three preceding fixes each stayed fully green
// until cases were written for them — so a green suite across a security fix is evidence about the
// SUITE and never about the fix.
//
// BIPOLAR THROUGHOUT: a "fix" that refuses EVERY marker passes every firing pole here and silently
// disables the dedupe, so each refusal is paired with the ordinary case that must keep working.
{
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-drain-read-"));
  execFileSync("git", ["init", "-q", tmp3], { stdio: "ignore" });
  const OUT3 = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-drain-outoftree-"));
  const SIG3 = "ADVISE:drained:0:9:0:0:b:2:2";
  const markerDir = path.dirname(L._markerPath(tmp3, "any"));
  // The marker directory's PARENT must exist before any of the swap cases can create a link in
  // its place. Omitting this made case 76's `symlinkSync` raise ENOENT, which its own catch
  // reported as a FAILING case rather than a passing one — the fixture failing LOUD on its own
  // setup, which is the direction that catch is written for.
  fs.mkdirSync(path.dirname(markerDir), { recursive: true });
  const plant = (dir, sid) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, path.basename(L._markerPath(tmp3, sid))),
      JSON.stringify({ v: 1, signature: SIG3, ts: "planted-by-the-attacker" }) + "\n",
    );
  };

  // (a) THE MEASURED DEFECT. The sink DIRECTORY — not the marker file — is the component lstat
  // never guarded, and it is the one an attacker can swap without touching the predictable
  // filename at all.
  check(
    "76",
    "MARKER CONTAINMENT firing pole: an OUT-OF-TREE sink-DIRECTORY symlink is refused, so nothing is suppressed",
    (() => {
      const sid = "dir-symlink-session";
      const evil = path.join(OUT3, "evil-marker-dir");
      plant(evil, sid);
      fs.rmSync(markerDir, { recursive: true, force: true });
      try {
        fs.symlinkSync(evil, markerDir);
      } catch {
        return false; // a platform without symlinks cannot answer this question — fail LOUD
      }
      const suppressed = L.alreadySurfaced(tmp3, sid, SIG3);
      fs.unlinkSync(markerDir);
      fs.mkdirSync(markerDir, { recursive: true });
      return suppressed === false;
    })(),
    "lstat guards only the FINAL component; the DIRECTORY above it was the whole attack surface",
    "M-fd1: restore the bare `fs.lstatSync` + `fs.readFileSync` marker read",
  );

  // (b) THE QUIET POLE, and the reason (a) is not satisfied by a stub that always returns false.
  // The write/read round-trip through the SHARED primitive has to keep working, or the detector
  // re-fires on every turn and the dedupe this module exists to provide is gone.
  check(
    "77",
    "MARKER CONTAINMENT quiet pole: an HONEST in-tree marker STILL suppresses, and only its own signature",
    (() => {
      const sid = "honest-through-primitive";
      return (
        L.markSurfaced(tmp3, sid, SIG3).ok === true &&
        L.alreadySurfaced(tmp3, sid, SIG3) === true &&
        L.alreadySurfaced(tmp3, sid, "ADVISE:drained:0:1:0:0:b:1:1") === false
      );
    })(),
    "a containment fix that refuses everything passes every firing pole and is inert in the other direction",
    "M-fd2: make `alreadySurfaced` return false unconditionally (containment as a stub)",
  );

  // (c) The shape the OLD lstat did catch. Kept pinned so routing through the primitive is shown
  // to RETAIN it rather than trade one refusal for another — case 67 asserts the same property
  // against the old implementation and this one asserts it against the new.
  check(
    "78",
    "MARKER CONTAINMENT: the marker FILE as an out-of-tree symlink is still refused",
    (() => {
      const sid = "file-symlink-session";
      const poison = path.join(OUT3, "poison-file.jsonl");
      fs.writeFileSync(poison, JSON.stringify({ v: 1, signature: SIG3, ts: "planted" }) + "\n");
      const p = L._markerPath(tmp3, sid);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      try { fs.unlinkSync(p); } catch {}
      fs.symlinkSync(poison, p);
      return L.alreadySurfaced(tmp3, sid, SIG3) === false;
    })(),
    "the property the previous implementation DID hold must survive the reroute",
    // MEASURED, and it corrects the label this case was DRAFTED with. M-fd1 (restore the bare
    // `lstat` + `readFileSync`) does NOT red this case — it reds {76, 79, 82} and not 78 —
    // because the OLD reader already refused a final-component symlink; that is the one shape it
    // did guard, which is exactly why this case exists as a NON-REGRESSION pin rather than as an
    // M-fd1 lock. M-fd2 leaves it green too (a reader that always returns false satisfies a
    // "must not suppress" pole). Its live mutation is M-fd5b — and M-fd5 ALONE (drop O_NOFOLLOW,
    // keep everything else) reds NOTHING, which is an INERT MUTATION and not a vacuity verdict:
    // `reconcileFdIdentity`'s dev/ino compare absorbs it, because the lstat of the link resolves
    // the LINK's inode while the fd holds the TARGET's. Only dropping both makes this case's
    // property observable — the same defense-in-depth shape M-z3/M-z3b recorded one module over.
    "M-fd5b: drop O_NOFOLLOW **and** the fd dev/ino compare (both, or neither reds)",
  );

  // (d) A HARD LINK is invisible to containment: `ln <out-of-tree> <in-tree>` succeeds on one
  // device and the in-tree name then RESOLVES INSIDE the root. The old reader had no nlink check
  // at all, so this is a capability the reroute ADDS.
  check(
    "79",
    "MARKER CONTAINMENT: a HARD-LINKED marker (out-of-tree bytes, in-tree name) is refused",
    (() => {
      const sid = "hardlink-session";
      const poison = path.join(OUT3, "poison-link-src.jsonl");
      fs.writeFileSync(poison, JSON.stringify({ v: 1, signature: SIG3, ts: "planted" }) + "\n");
      const p = L._markerPath(tmp3, sid);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      try { fs.unlinkSync(p); } catch {}
      try { fs.linkSync(poison, p); } catch { return true; } // cross-device: not reachable here
      // CONTROL: the in-tree name genuinely resolves INSIDE the root, so containment alone cannot
      // see this — only the nlink refusal does.
      return fs.realpathSync(p).startsWith(fs.realpathSync(tmp3)) && L.alreadySurfaced(tmp3, sid, SIG3) === false;
    })(),
    "containment resolves INSIDE the root here — the nlink refusal is the only thing that sees it",
    "M-fd3: drop `readSinkFile`'s nlink refusal AND `reconcileFdIdentity`'s (both, or neither reds)",
  );

  // (e) THE BOUND, and its DIRECTION. An over-cap marker must refuse, and the refusal must land on
  // "not surfaced" — a repeated line, never a suppressed finding.
  check(
    "80",
    "MARKER BOUND: an OVER-cap marker is refused, and the refusal costs a REPEAT — never a suppression",
    (() => {
      const sid = "overcap-session";
      const p = L._markerPath(tmp3, sid);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const row = JSON.stringify({ v: 1, signature: SIG3, ts: "x" }) + "\n";
      // The signature IS present in these bytes, so a read that ignored the cap would suppress.
      fs.writeFileSync(p, row + "#".repeat(L.MAX_MARKER_BYTES + 1));
      const over = L.alreadySurfaced(tmp3, sid, SIG3);
      // CONTROL, same file under the cap: the identical row DOES suppress, so the refusal above is
      // the CAP firing and not the row failing to match.
      fs.writeFileSync(p, row);
      const under = L.alreadySurfaced(tmp3, sid, SIG3);
      return over === false && under === true;
    })(),
    "the control pins that the row itself matches — so the refusal is the bound, not a parse miss",
    "M-fd4: drop the over-cap refusal from `readSinkFile`",
  );

  // (f) THE RESIDUAL, PINNED AS A CASE so it cannot be quietly believed closed. Containment is not
  // authentication: an attacker who simply WRITES the predictable IN-TREE path still disarms this
  // detector completely. Closing it needs an unpredictable session-scoped key — a DESIGN change,
  // deliberately not attempted here. Same open half as `delegation-default.js` case 98.
  check(
    "81",
    "MARKER RESIDUAL (NOT closed): a pre-planted IN-TREE marker still suppresses — containment is not authentication",
    (() => {
      const sid = "preplanted-session";
      const p = L._markerPath(tmp3, sid);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ v: 1, signature: SIG3, ts: "planted" }) + "\n");
      return L.alreadySurfaced(tmp3, sid, SIG3) === true;
    })(),
    "documents the OPEN half: this case going false would mean an unpredictable key landed and this text is stale",
  );

  // (g) THE REAL HOOK. Every case above passes against a hook that never runs — the inert-guard
  // shape `dispatch-contract-guard.js` shipped with while 42 library fixtures stayed green. This
  // one drives the registered script as a child process, through all four states in sequence, so
  // the control and the attack are read off the SAME tree.
  {
    const HOOK3 = path.join(REPO, ".claude/hooks/fleet-drain-guard.js");
    fs.mkdirSync(path.join(tmp3, ".session-notes.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp3, ".session-notes.d", "op.md"),
      "## Outstanding ledger (forest)\n\n| ID | Item | Status |\n| --- | --- | --- |\n" +
        "| `F1` | a | open |\n| `F2` | b | open |\n| `F3` | c | open |\n",
    );
    const sid = "e2e-dir-symlink-session";
    const sink = LEDGER._sinkPath(tmp3, sid);
    fs.mkdirSync(path.dirname(sink), { recursive: true });
    fs.writeFileSync(
      sink,
      [
        JSON.stringify({ ...launch("alpha"), v: 1, session_id: sid, ts: "2026-08-31T00:00:00.000Z" }),
        JSON.stringify({ ...launch("beta"), v: 1, session_id: sid, ts: "2026-08-31T00:00:01.000Z" }),
        JSON.stringify({ ...stop("alpha"), v: 1, session_id: sid, ts: "2026-08-31T00:00:02.000Z" }),
        JSON.stringify({ ...stop("beta"), v: 1, session_id: sid, ts: "2026-08-31T00:00:03.000Z" }),
        "",
      ].join("\n"),
    );
    const spoke = (r) => /FLEET DRAINED/.test(r.stdout);
    const one = fire(HOOK3, tmp3, sid); // CONTROL: the finding exists at all
    const two = fire(HOOK3, tmp3, sid); // CONTROL: and the dedupe genuinely suppresses it
    // Now the attack, on the SAME tree: move the honest marker directory OUT and link to it.
    const stash = path.join(OUT3, "stashed-marker-dir");
    fs.renameSync(markerDir, stash);
    let linked = true;
    try { fs.symlinkSync(stash, markerDir); } catch { linked = false; }
    const three = fire(HOOK3, tmp3, sid); // must SPEAK — the marker is out of tree
    fs.unlinkSync(markerDir);
    fs.renameSync(stash, markerDir);
    const four = fire(HOOK3, tmp3, sid); // and restoring it must suppress again
    check(
      "82",
      "E2E MARKER CONTAINMENT: an OUT-OF-TREE marker directory does NOT suppress the drain through the real hook",
      linked && spoke(one) && !spoke(two) && spoke(three) && !spoke(four) &&
        [one, two, three, four].every((r) => r.code === 0 && /"continue":true/.test(r.stdout)),
      `spoke: first=${spoke(one)} deduped=${!spoke(two)} through-symlink=${spoke(three)} restored-deduped=${!spoke(four)}`,
      "M-fd1: restore the bare marker read — `three` goes silent and this reds",
    );
  }

  check(
    "83",
    "ISOLATION: the read-half cases wrote nothing under the real repo's .claude/learning/fleet-drain",
    !fs.existsSync(path.join(REPO, ".claude/learning/fleet-drain")) ||
      fs
        .readdirSync(path.join(REPO, ".claude/learning/fleet-drain"))
        .every((f) => !/^(dir-symlink|honest-through-primitive|file-symlink|hardlink|overcap|preplanted|e2e-dir-symlink)/.test(f)),
    "every path in this block resolves under the throwaway repo",
  );

  fs.rmSync(tmp3, { recursive: true, force: true });
  fs.rmSync(OUT3, { recursive: true, force: true });
}

/** Drive the hook as a real child process, capturing stdout, stderr and the exit code separately. */
// `backgroundTasks` defaults to `[]` — the harness's IDLE statement, which is what a real drained
// turn carries (probe condition A, verbatim). Passing it explicitly is how the end-to-end cases
// drive the reconciliation through the REAL stdin boundary rather than only through the library.
function fire(hook, projectDir, session, extraEnv, backgroundTasks) {
  return rawFire(
    hook,
    projectDir,
    JSON.stringify({
      hook_event_name: "Stop",
      session_id: session,
      background_tasks: backgroundTasks === undefined ? [] : backgroundTasks,
    }),
    extraEnv,
  );
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
