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
 *  13  the SESSION-VOLUME arm (2026-08-31) — consecutive prompts with ZERO lanes, ORTHOGONAL to
 *      every predicate above: it fires where `declared_subparts` is 0 on every prompt and the
 *      per-prompt arm is therefore QUIET by its own contract
 *  14  that arm's calibration is anchored to the MEASURED corpus distribution, not to a literal
 *  15  the session arm's DEDUPE keys on a NON-RESETTING quantity — a key derived from the run
 *      itself silences every stretch after the first (the relapse class, 2026-08-31)
 *  16  UNKNOWN is not ONE state: instrument-did-not-run stays silent, instrument-RAN-BROKEN speaks
 *  17  the main-generation filter on DECLARED rows, and its missing-field default
 *  18  the SESSION FENCE (2026-08-31) — this arm aggregates the WHOLE file, so a row belonging to
 *      ANOTHER session pooled into it must not move this session's verdict; and the fence must be
 *      WIRED at the guard's only production call site, not merely PRESENT in the library
 *  19  the MARK-AFTER-EMITTER-RESOLVES ordering — a `require` failure must not consume the dedupe
 *  20  the READ HALF of the sink contract (loom#1762) — the marker read and the ledger read were
 *      neither CONTAINED nor BOUNDED while their write halves were hardened through
 *      `append-sink.js`. Three defects, one class: a symlinked marker silently suppressed a real
 *      finding; `MAX_LEDGER_BYTES` gated only a `statSync` while the read ran to EOF; and a read
 *      REFUSED for cause rendered byte-identically to a well-delegating session
 *  21  (2026-09-01) the FOUR REFUSAL BRANCHES of `readSinkFile` a Tier-1 round mutated with a reach
 *      proof while this suite stayed 126-GREEN: the ANCESTOR containment refusal, the
 *      SINK-DIRECTORY containment refusal, `!st.isFile()`, and — one layer up — the two directions
 *      the consumers depend on
 *  22  the MARKER's FAIL-OPEN direction for every refusal sub-case, not only symlink/hard-link
 *  23  the LEDGER's FAIL-CLOSED direction, symmetrically: a refusal is never an absence
 *  24  the CORRUPT/ABSENT PARTITION — three file shapes that READ successfully and yielded nothing
 *      were scored CLEAN, the zero-byte one being the WRITE half's own residue
 *  25  the CALIBRATION NOTE's own DERIVE COMMAND, which matched itself
 *  26  (2026-09-01) the SESSION IDENTITY — the `"unknown-session"` SHARED CONSTANT that made the
 *      session fence unreachable IN PRINCIPLE. Five sites resolved an absent `session_id` to one
 *      literal, so every id-less session pooled into ONE sink, and every row AND the reader in it
 *      carried that same id. The fix derives a per-HOST-PROCESS identity in ONE shared function;
 *      these cases pin the derivation (stable-within / distinct-across / pid-reuse), that all five
 *      sites share it, the fence working end-to-end through the real hooks, and the pre-fix pooled
 *      sink staying readable, unadopted and NOT silently orphaned
 *  27  (2026-09-12) the LANE-DEPTH arm, `rules/wip-discipline.md` MUST-9 — a lane
 *      `wip-lanes.js::laneDepth` marks UNDER-PACKED with no ATTRIBUTED dispatch this session is
 *      reported naming THAT lane; an attributed dispatch silences it; an unattributable one is
 *      UNATTRIBUTED, never zero; an unreadable ledger, an exhausted budget and a killed probe are
 *      typed UNKNOWNs; the zero-dispatch fact is stated once per response; no fire ever refuses
 *
 * POPULATION, stated as a COUNT rather than a RANGE LABEL. This set is 163 cases: 48 before the
 * session-volume arm, 29 added with it (28 with the arm, plus 62b when its calibration argument
 * was re-grounded), 14 added 2026-08-31 with the relapse + broken-instrument fixes (71-84), 4
 * added with the session fence (85-88), 4 added 2026-08-31 end-to-end (89-92: two for the fence's
 * WIRING, two for the mark-after-emitter ordering), 2 for the ONE-parsable-row disarm (93-94), and
 * 17 added with the READ-half fixes (95-111: four for marker containment INCLUDING the still-OPEN
 * residual, six for the ledger bound and its absent/over-cap discriminators, four for the
 * refused-read corrupt state, three end-to-end), and 8 added 2026-08-31 with the READ-half
 * FOLLOW-UP fixes (112-119: four for the `absent` CLAIM ITSELF — the dangling-symlink laundering,
 * its genuinely-missing pole, the ancestor variant and the TOCTOU residual — one end-to-end, and
 * three for the ALLOCATION regression the first read-half fix introduced), and 21 added 2026-09-01
 * for the FOUR UNPINNED REFUSAL BRANCHES and the partition they feed (120-140: four for the two
 * `containment failed` refusals, two for `!st.isFile()`, six for the marker's fail-open direction,
 * three for the ledger's fail-closed direction, four for the corrupt/absent partition, and two for
 * the self-matching derive command), and 16 added 2026-09-01 with the SESSION-IDENTITY fix
 * (141-156: five for the derivation itself, four for the five sites sharing it, two end-to-end for
 * the FENCE the fix finally makes reachable, four for the legacy pooled sink's disposition, and
 * one isolation guard).
 *
 * THE 16 EXIST BECAUSE THE SUITE WAS BLIND A SIXTH TIME. The producer-side identity fix landed
 * complete — measured two-pole on one tree, pre-fix two id-less hosts produced ONE sink
 * (`unknown-session-86a371a9.jsonl`) and post-fix TWO — and this runner reported 147/147, exit 0,
 * on BOTH trees. Every one of the sixteen is bipolar, and every mutation in that battery reds at
 * least one of them under a reach proof.
 *
 * THE 21 EXIST BECAUSE THE SUITE WAS BLIND A FIFTH TIME. A Tier-1 round mutated each of the four
 * branches WITH A REACH PROOF and this runner reported 126/126, exit 0, every time — including for
 * the two that REOPEN the CRITICAL class the read half exists to close. Non-inertness was proven
 * independently before any case was written: an out-of-tree ancestor symlink took `readSinkFile`
 * from `{"ok":false,"reason":"containment failed — sink ancestor resolves to ..."}` to
 * `{"ok":true,"rows":1}` (an out-of-tree row answering a question about this repository), and a
 * FIFO planted at the sink path took it from "not a regular file" to
 * `{"ok":true,"rows":0,"skipped":0}` — byte-identical to a well-delegating session. A green suite
 * across a security fix is evidence about the SUITE, not about the fix; that is now the standing
 * property of this runner and not a surprise.
 *
 * THE 8 EXIST BECAUSE THE SUITE WAS BLIND AGAIN. Measured with all three follow-up fixes applied
 * and NOT ONE case added: 118/118, exit 0. That is now the FOURTH consecutive fix on this branch
 * to leave this runner fully green, which is why the header says it as a standing property of the
 * suite rather than as a surprise.
 *
 * THOSE 17 EXIST BECAUSE THE SUITE WAS BLIND TO ALL THREE FIXES. Measured: with every loom#1762
 * fix applied and NOT ONE new case added, this runner reported 101/101 and exit 0 — the same
 * "green until cases were added specifically for them" the three preceding fixes on this branch
 * each hit. A green suite across a security fix is evidence about the SUITE, not about the fix.
 *
 * The header ALSO went stale again in the interval this set documents: it said 99 while 93-94 were
 * already in the file, exactly the failure recorded below. Both numbers are now derived, not typed
 * — and the derive command was itself WRONG-BY-CONSTRUCTION until 2026-08-31: `sort -u` COLLAPSES
 * duplicate ids, so a set with two cases numbered 93 reported 116 for a 118-case population. Two
 * ids WERE duplicated (93, 94) when the READ-half cases were first drafted against a header that
 * said the range ended at 92. Renumbered to 95-111. Check for duplicates, not just the count:
 *   grep -o 'check("[0-9]\+[a-z]\?"' run.mjs | sed 's/check("//;s/"//' | sort | uniq -d
 *
 * THE HEADER WENT STALE HERE ONCE ALREADY, and the correction is recorded rather than smoothed
 * over. It read "91 cases" while cases 85-88 were already in the file — the fence cases landed
 * without their own line in this count, and every derived claim below (the mutation table's
 * "at 91 cases", the "restored file exits 0 at 91/91") inherited the error.
 *
 * The registry floor is deliberately NOT restated here. `min_cases` for this runner lives in
 * `.claude/test-harness/ci-audit-fixtures.json` and MUST equal what the derive command below
 * prints; go read it there rather than trusting a number in this comment. The gate that couples
 * prose to that registry — `test-harness/tests/audit-fixture-prose-count-coupling.test.mjs` —
 * scans `.md` files ONLY and never opens this runner, MEASURED: with the registry set to 98
 * against a header saying 99, all 8 of its arms stayed green. So a floor written into this header
 * would be UN-GATED prose, which is exactly how the count above went stale the first time.
 *
 * The numbered ids run 01..140 but the population is
 * NOT the span of that range — 08b-08e, 31a and 31b are cases too, and reading "01-42" as "42
 * cases" undercounts the pre-arm set by six. That mistake was actually made when this arm was
 * committed, in the commit body, and corrected in the follow-up. Derive the count, never read it
 * off the ids:
 *   grep -o 'check("[0-9]\+[a-z]\?"' run.mjs | sort -u | wc -l
 *
 * BIPOLAR BY CONSTRUCTION: every predicate carries BOTH a firing pole and a quiet pole. A set that
 * only ever asserts firing passes identically against a detector that fires on everything; a set
 * that only ever asserts silence passes identically against a detector that is INERT. Both are live
 * risks here — the whole detector is capped at advisory, so an inert one is indistinguishable from
 * a well-delegating session, which is precisely the non-discriminating instrument
 * `instrument-discipline.md` MUST-1 forbids citing as evidence.
 *
 * ESTABLISHED RED (`instrument-discipline.md` MUST-2). EVERY mutation listed below was RUN against
 * THIS population on 2026-08-31, each after a REACH PROOF: the exact pre-image is counted in the
 * target file BEFORE the edit and again AFTER, and the mutation is only read once that count moves
 * 1 -> 0 (for the three INSERTION mutations — M-e, M-g, M-m — the pre-image legitimately survives,
 * so the proof is a sentinel comment going 0 -> 1 instead). A sed that silently matched nothing
 * would print an unchanged suite and read exactly like a vacuous case, which is the failure this
 * proof exists to separate: a mutation that does not red leaves TWO hypotheses — vacuous case OR
 * inert mutation — and is never by itself a vacuity verdict.
 *
 * Every set below is what the mutation ACTUALLY reddened at 99 cases, and every restored file was
 * compared byte-for-byte against its pre-mutation contents before the next mutation ran. Sets
 * measured against an EARLIER, smaller population were RE-MEASURED here rather than carried
 * forward, because adding cases changes them — and the last revision of this header broke exactly
 * that discipline: it carried M-h forward at 18 (measured 23) and M-j at 3 (measured 6), both
 * stale by the fence cases already in the file. Nothing below is inherited.
 *
 *   M-a  `declared < DECLARED_FLOOR` gate → `false`                    → 01, 32
 *   M-b  `dispatched >= declared` sufficiency arm → `false`            → 05, 16, 22, 31, 31b
 *   M-c  collapse the `!parallelism` UNKNOWN branch to QUIET           → 11, 18, 19, 20, 23
 *   M-d  reinstate `JSON.parse(await readStdinBounded())` in the HOOK  → 30, 31a, 33, 35, 63, 66,
 *        67, 81, 82, 89, 91, 92    (the inert-hook bug that shipped in `dispatch-contract-guard.js`,
 *        where 42 library fixtures stayed green against a hook that never ran — hence the child
 *        process; it reds every end-to-end case in the set and nothing else)
 *   M-e  `alreadySurfaced` returns false unconditionally               → 35, 40, 69, 81, 84, 91
 *   M-f  DECLARED_FLOOR 2 → 3 (split from the reconciler's floor)      → 03, 08, 09, 17, 24, 33
 *   M-g  the ADVISE branches of `formatDelegationAdvisory` return null → 08d, 21, 26, 27, 30, 31a,
 *        35    (BOTH ADVISE branches — the one-lane arm and the zero-dispatch arm; killing only
 *        one leaves 08d or 21 green, which is why the mutation is applied above both)
 *   M-h  `run >= SERIAL_RUN_FLOOR` → `false` (the session arm inert)   → 43, 46, 47, 52, 54, 56,
 *        57, 58, 59, 61, 63, 66, 67, 71, 72, 79, 80, 81, 85, 87, 89, 91, 92    (23 — the widest in
 *        the set. The previous header listed 18, measured against a population that no longer
 *        existed: 85 and 87 were already in the file, and 89/91/92 have since joined them.)
 *   M-i  SERIAL_RUN_FLOOR 12 → 11 (a slide off the stable band)        → 62
 *        Only 62 reds, BY DESIGN: cases 43-61 are written relative to `L.SERIAL_RUN_FLOOR` so they
 *        slide with it, which is what keeps them from restating a magic number. Case 62 is the
 *        anchor that makes an unmeasured threshold change visible at all — it asserts the firing
 *        SET is stable at the floor and at floor+1 and strictly wider one below, and at 11 it is not.
 *        Case 89 was DRAFTED restating the literal 12 and reddened here on its first measurement;
 *        it now reads `L.SERIAL_RUN_FLOOR` and slides with the rest. Recorded because the red was
 *        the drafting error announcing itself, not a property of the fence.
 *   M-j  drop `run = 0` on a main-generation launch                    → 45, 65, 73, 86, 88, 90
 *        (the previous header listed 3; 86 and 88 were already in the file when it said so)
 *   M-k  replace the run with a session-wide `dispatched === 0 &&
 *        prompts >= FLOOR` test (the contract MEASURED as unable to
 *        see the motivating session)                                  → 46, 71, 81
 *   M-l  collapse the `!Array.isArray(rows)` UNKNOWN branch to QUIET   → 48
 *   M-m  the session-arm render returns null on ADVISE                 → 54, 56, 57, 58, 63, 66,
 *        67, 81, 89, 91, 92
 *   M-n  strip the session-instruction escalation from the render      → 56
 *   M-o  remove the arm's WIRING from the guard, library intact        → 63, 66, 67, 81, 82, 89,
 *        91, 92
 *   M-p  force the emitter-routing fallback (bare stderr write, no
 *        `systemMessage` — the agent never sees the finding)           → 31a, 67, 82, 91
 *   M-q  key the session signature on the RUN alone (the shipped
 *        relapse defect, restored)                                     → 71, 81
 *   M-r  drop the corrupt branch from `formatSessionVolumeAdvisory`    → 74, 78, 82
 *   M-s  render on every UNKNOWN, signature unchanged                  → 55, 75
 *   M-s2 render AND sign every UNKNOWN (the full widening; only this
 *        one clears the guard's `f.sig` gate and reaches the hook)     → 34, 55, 75, 77, 83
 *   M-t  drop the main-generation filter from the volume walk          → 47, 79
 *   M-u  default a MISSING `generation` to a non-main sentinel         → 80
 *   M-v  drop the `crossings` tick from the volume walk                → 71, 73, 81
 *   M-w  drop the SESSION FENCE in the library (a foreign session's
 *        `launch` row resets our run again)                            → 85, 89
 *        Cited at case 85 but ABSENT from this table until 2026-08-31, so the table ran M-a..M-v
 *        while the set carried a lock nothing here described. Registered and measured.
 *   M-x  mark the dedupe BEFORE the emitter is known loadable
 *        (`resolved.ok && emit` → `resolved.ok`)                       → 92
 *   M-y  unwire the fence at the guard's ONLY production call site
 *        (the 4th argument to `assessSessionVolume` → `undefined`)     → 89
 *
 * ── the READ half (loom#1762). Measured 2026-08-31 at 118 cases, unmutated baseline 118/118
 *    exit 0, each mutation after a 1 -> 0 pre-image reach proof, each file restored and verified
 *    BYTE-IDENTICAL by sha256 before the next ran. RESTORE IS FROM A SCRATCHPAD COPY, NEVER
 *    `git checkout` — the tree is UNCOMMITTED during this work, so `git checkout -- <path>`
 *    restores HEAD and SILENTLY DELETES the fix under test. That happened once here: the harness
 *    reported a clean restore while having reverted the very code being measured, and the whole
 *    batch had to be re-run. If you re-measure this table, copy the files aside first.
 *
 *   M-z   `alreadySurfaced` back to bare `fs.statSync` + `fs.readFileSync`
 *         (CRITICAL 1 restored — the marker read follows a symlink)  -> 95, 97, 109
 *   M-z2  `alreadySurfaced` returns false unconditionally
 *         (containment as a STUB — the OPPOSITE failure to M-z)      -> 35, 40, 69, 81, 84, 91,
 *         96, 98    (the widest of this group, and the reason 96 and 98 exist: a "fix" that
 *         refuses EVERYTHING passes every firing pole here and is inert in the other direction)
 *   M-z3  drop `readSinkFile`'s OWN `nlink > 1` refusal               -> (NONE)
 *         NOT A VACUITY VERDICT. Two hypotheses stood — vacuous case OR inert mutation — and the
 *         SECOND is the true one: `reconcileFdIdentity` carries its own nlink check on the same
 *         path, so defense-in-depth absorbed it. Resolved by M-z3b, not left standing.
 *   M-z3b BOTH read-path nlink checks disabled together               -> 97
 *         So case 97 is LIVE, and is the SOLE case observing hard-link refusal on the read.
 *         Confirmed independently on the UNMUTATED tree: the link IS created (nlink 2), the
 *         in-tree name DOES resolve inside the repo, and `readSinkFile` refuses it — so
 *         containment alone never sees this shape; the nlink check is the only thing that does.
 *   M-z4  drop the over-cap refusal from `readSinkFile`               -> 99, 101, 102
 *   M-z5  gate the ledger read on `statSync().size` again
 *         (CRITICAL 2 restored — the read runs to EOF)                -> 101, 104, 110
 *   M-z6  collapse `absent` so every read failure looks alike         -> 34, 83, 103, 111
 *   M-z7  hard-code `corrupt: false` in the `!Array.isArray` branch
 *         (the third defect restored — a refused read renders null)   -> 105, 110
 *   M-z8  treat EVERY read failure as corrupt (the OPPOSITE widening,
 *         which makes every fresh clone speak)                        -> 34, 83, 106, 108, 111
 *
 * ── the READ-half FOLLOW-UP (loom#1762 CRITICAL A/B + the allocation regression). Measured
 *    2026-08-31 at 126 cases, unmutated baseline 126/126 exit 0, each mutation after a 1 -> 0
 *    pre-image reach proof, each file restored from a SCRATCHPAD COPY and verified byte-identical
 *    by sha256 before the next ran. Every red-set below is what was ACTUALLY observed, including
 *    the three that came back EMPTY and what resolved each of them.
 *
 *   M-B1   restore `fs.existsSync` in `_deepestExistingAncestor`
 *          (the ROOT-CAUSE half: the walk steps PAST a dangling link)  -> 114
 *   M-B2   restore the bare `absent:true` on the sink-dir ENOENT branch
 *          (the RACE half — a link planted between the two resolves)   -> 115
 *   M-B3   BOTH halves — the shipped defect exactly as measured        -> 112, 114, 115, 116
 *   M-Bwide the OPPOSITE widening: never report absent, so every fresh
 *          clone and every CI run speaks                               -> 113
 *   M-C1   restore the unconditional `Buffer.allocUnsafe(maxBytes + 1)` -> 117, 118
 *          118 joins because its `reads > 1` reach proof is real coverage, not decoration: an
 *          oversized buffer swallows the whole grown file in ONE `read(2)`, so the case correctly
 *          refuses to certify a run that never entered the loop it exists to exercise.
 *   M-C2   size from the stat with NO grow step (the stat becomes the
 *          BOUND again — the CRITICAL-2 defect in allocation form)     -> 118
 *   M-C3   drop the grow step ALONE                                    -> 118
 *   M-C4   SCOPE mutation: ignore the stat, allocate the FLOOR and grow
 *          (an equally valid implementation)                           -> (NONE, correctly)
 *   M-C5   allocate the FLOOR only AND drop the grow step              -> 99, 101, 102, 118, 119
 *          Truncation defeats the over-cap detector too, which is why 99/101/102 join in.
 *
 * ── the FOUR UNPINNED REFUSAL BRANCHES + the partition they feed (2026-09-01). Measured at 147
 *    cases, unmutated baseline 147/147 exit 0 (fleet-drain 118/118 exit 0 on the same tree), each
 *    mutation after a reach proof — the pre-image counted in the target file BEFORE the edit and
 *    again AFTER, read only once the count moved by exactly one — and each file restored from a
 *    SCRATCHPAD COPY and verified byte-identical by sha256 before the next ran. NEVER
 *    `git checkout --`: the tree is uncommitted during this work, so it restores HEAD and silently
 *    deletes the fix under test. Every red-set below is what was ACTUALLY observed.
 *
 *   M-D1  drop the ANCESTOR `containment failed` refusal (read path)   -> 120
 *   M-D2  drop the SINK-DIRECTORY `containment failed` refusal         -> 122
 *         M-D1 and M-D2 red DISJOINT SINGLE cases, which is the narrowest possible evidence that
 *         the two refusals are independently load-bearing rather than one being redundant.
 *   M-D3  drop BOTH read-path containment refusals                     -> 120, 122, 127, 133
 *         and CROSS-SUITE, measured in the same battery: fleet-drain -> 76, 82.
 *   M-D4  drop the `!st.isFile()` refusal                              -> 124, 132
 *   M-E1  `alreadySurfaced`'s `if (!r.ok) return false;`
 *         -> `return r.overCap === true;` (the measured suppressor)    -> 126
 *         ONLY 126, correctly: this mutation flips exactly one sub-case, and 126 is the case
 *         written for it. A 262,300-byte marker under it flips `alreadySurfaced` false -> TRUE and
 *         suppresses the advisory permanently, since the marker never shrinks.
 *   M-E2  the same line -> `return r.absent !== true;` (every refusal
 *         honoured — the full widening)                                -> 95, 97, 109, 126, 127,
 *         128, 129, 130
 *   M-F1  `readLedger`'s `absent:` also accepts "not a regular file"   -> 132
 *   M-F2  the same, for "containment failed"                           -> 112, 116, 133
 *         M-E* and M-F* are OPPOSITE directions of one contract and neither alone is evidence: the
 *         marker fails OPEN on a refusal (a lost dedupe costs one line) and the ledger fails CLOSED
 *         (a laundered refusal costs the whole finding). Case 131 and case 134 are the poles that
 *         stop each group being satisfiable by "always emit" / "never report absent".
 *   M-G1  restore the UNCOUNTED blank-line `continue` in `readLedger`
 *         (the shipped defect exactly as measured)                     -> 135, 136, 137, 138
 *   M-G2  count EVERY blank line, incl. the trailing-newline artifact
 *         (the OPPOSITE error, and the constraint that makes the fix
 *         non-trivial)                                                 -> 100, 138
 *         138 reds under BOTH, which is the point: it is the one case that holds the terminator
 *         free and an interior blank line counted at the same time.
 *   M-H1  perturb one arm's spacing so the documented derive command
 *         no longer finds it                                           -> 139
 *   M-H2  remove ONE of the two prose mentions the naive form matched   -> (NONE)
 *         NOT A VACUITY VERDICT. Two hypotheses stood — vacuous case OR inert mutation — and the
 *         SECOND is the true one, RESOLVED rather than left standing: 140's predicate is
 *         `unanchored > anchored`, and there are TWO prose mentions, so removing one leaves 4 > 3
 *         and the predicate never moves. M-H2b removes BOTH.
 *   M-H2b remove BOTH prose mentions                                   -> 140
 *
 * CROSS-SUITE, measured in the SAME battery so the two runners' numbers are commensurable rather
 * than each asserted alone. The `fleet-drain` mutations that touch shared `append-sink.js` code
 * also move THIS set: M-fd3 (both read-path nlink refusals) -> 97; M-fd4 (drop the over-cap
 * refusal) -> 99, 101, 102, 118; M-fd5b (drop O_NOFOLLOW AND the fd dev/ino compare) -> 95, 109,
 * 110. Their fleet-drain halves and the two INERT mutations are tabulated in that runner's header.
 *
 * M-B1 and M-B2 red DISJOINT single cases, which is the narrowest possible evidence that the two
 * halves of the B fix are independently load-bearing: neither is redundant with the other, and
 * M-B3 shows what the pair costs when both are gone. M-Bwide is the pole that stops the whole
 * group being satisfiable by "never report absent again".
 *
 * M-C2 AND M-C3 FIRST CAME BACK WITH AN EMPTY RED-SET, AND THAT WAS NOT A VACUITY VERDICT. Two
 * hypotheses stood, and the SECOND was true — but only after a defect in case 118 was found and
 * fixed. As drafted, 118 hooked `fs.fstatSync` to grow the file; `captureDirIdentity` and
 * `reconcileFdIdentity` each fstat BEFORE `readSinkFile` sizes its buffer, so the growth landed
 * ahead of the sizing stat and the read completed in ONE syscall (`reads: 1, consumed: 4194305`)
 * having never entered the grow path. The case passed while testing nothing it named. Re-hooked on
 * `fs.readSync`, with `reads > 1` asserted INSIDE the predicate as a permanent reach proof, both
 * mutations red it. A green case is an instrument and had to be shown able to fail here too.
 *
 * M-z6 and M-z8 red 34 and 83, which are PRE-EXISTING cases rather than ones added here. That is
 * the existing coverage doing its job: both are "an absent ledger emits NOTHING" poles, and both
 * widenings break exactly that. It also means the noise rule this fix had to PRESERVE was already
 * pinned, so the new cases did not have to re-pin it — 106 and 108 pin the library-level verdict
 * and the named residual, which 34 and 83 cannot see.
 *
 * M-z and M-z2 are deliberately OPPOSITE mutations of ONE function, and neither alone is
 * sufficient evidence. M-z alone is satisfied by a containment fix that refuses everything; M-z2
 * alone is satisfied by the naive read that started this. Only the PAIR pins the behaviour.
 *
 * M-w, M-x and M-y are the three the previous revision could not have listed a set for, and for two
 * of them the reason was that NOTHING reddened. RE-MEASURED HERE, not taken on report: the PREVIOUS
 * fixture set was restored from git and driven at its own 95-case population, unmutated baseline
 * 95/95 with an empty red-set, then each mutation applied with the same 1 -> 0 pre-image proof:
 *
 *     at 95 cases          M-w -> 85            M-x -> (none)        M-y -> (none)
 *     at 99 cases          M-w -> 85, 89        M-x -> 92            M-y -> 89
 *
 * The fence's four cases (85-88) call `L.assessSessionVolume(...)` DIRECTLY and pass the sessionId
 * themselves, so the fence could be unwired at the one place production calls it and every one of
 * them stayed green; and no case in the set could reach the mark-ordering branch at all, because
 * every end-to-end case ran against a tree where the emitter loads. Cases 89-92 close both, and
 * each is now the SOLE case its mutation reds — the narrowest possible evidence that the coverage
 * is new rather than incidental.
 *
 * M-k, M-l, M-m and M-p were previously listed here as regression locks with NO measured set —
 * cited against the header's own "every mutation below was RUN". They are now RUN, and two of the
 * predictions they carried were wrong: M-m reds ELEVEN cases, not one, and M-p reds 31a, which is
 * why 31a's lock label was corrected (see M-e vs M-p below).
 *
 * M-e WAS OVERLOADED onto two unrelated mutations — `alreadySurfaced → false` AND the emitter
 * routing — while the emitter mutation is separately lettered M-p. Case 31a's lock label named
 * M-e and was WRONG: measured, M-e does NOT red 31a and M-p does. Disambiguated; M-e is now the
 * dedupe mutation only.
 *
 * WHAT M-o COVERS vs WHAT IT REDS — the distinction the previous text collapsed. It reds 63, 66,
 * 67, 81, 82, 89, 91, 92. The old note said "only the three end-to-end cases see it", which
 * reported the RED-SET as though it were the COVERAGE, and was false on both halves. There are
 * SIXTEEN cases driven through the real guard as a child process (63-70, 81-84, 89-92). Eight of
 * them — 64, 65, 68, 69, 70, 83, 84, 90 — assert SILENCE or a shape M-o leaves untouched, which is
 * exactly what M-o produces, so they are structurally BLIND to it and always will be; that is not a
 * defect in them (a quiet pole must assert silence) but it must not be counted as coverage. Case 69
 * passes VACUOUSLY under M-o in particular: it asserts a second fire is silent, and under M-o the
 * FIRST was silent too. The honest statement is that the end-to-end population is sixteen, the
 * subset able to discriminate wiring-inertness is EIGHT (measured, not counted by eye), and the
 * remainder are quiet poles carried for the opposite failure (a detector that fires on everything).
 *
 * THE SAME SHAPE, ONE LAYER UP, is what cases 89 and 92 exist for. M-o asks whether the ARM is
 * wired; M-y asks whether the arm's SESSION-FENCE ARGUMENT is wired, and M-x whether the guard's
 * mark/emit ORDERING holds. Both of those were invisible to the whole set, and both were invisible
 * for the same reason M-o was nearly invisible: a library-level case supplies its own arguments and
 * therefore cannot observe what the single production call site supplies.
 *
 * Case 04 is deliberately NOT a regression lock and reds under none of the mutations: it is the
 * POSITIVE CONTROL on the coupling assertion itself, driving a stub reconciler whose rider never
 * goes live and asserting that `assertFloorMatchesReconciler` REJECTS it. Without it, case 03's
 * green would be consistent with an assertion that cannot return the other answer
 * (`instrument-discipline.md` MUST-3(a)). Recorded here rather than left looking like a gap.
 *
 * Pure functions against in-memory inputs, plus one throwaway git repo in tmp for the ledger and
 * hook-boundary cases, and — for cases 91/92 only — two COPIES of `.claude/hooks/` inside that same
 * tmp dir, one of them with `lib/instruct-and-wait.js` removed so the guard's emitter `require`
 * actually fails. The real `.claude/hooks/` is READ to make those copies and is never written.
 * No network, no live session, and NOTHING is written under the real `.claude/learning/` — the hook
 * resolves its sink from `CLAUDE_PROJECT_DIR`, which these cases point at the tmp repo.
 */

import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const L = require(path.join(REPO, ".claude/hooks/lib/delegation-default.js"));
const LEDGER = require(path.join(REPO, ".claude/hooks/lib/dispatch-ledger.js"));
// The shared sink primitive itself. Cases 114/115/117-119 assert properties of `readSinkFile`
// that no consumer can express — an ancestor refusal reason, the allocation it takes, whether the
// cap still holds under a concurrent writer — so they drive it directly rather than inferring it
// from a `readLedger` verdict two layers up (`instrument-discipline.md` MUST-4: a check built for
// one question answers only that question).
const AS = require(path.join(REPO, ".claude/hooks/lib/append-sink.js"));

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
check("07", "ADVISE arm: zero dispatches against >=2 declared parts advises",
  A(4, 0).state === "ADVISE", `4/0 → ${A(4, 0).state}`);
// loom#2004 moved this pole. It used to read "a single dispatch withdraws the ADVISE
// verdict", which encoded the PRE-promotion contract: 4/1 was OBSERVE. It is now ADVISE,
// because ONE lane is not parallel execution. The bipolar INTENT is preserved by moving
// the quiet pole to the boundary that actually withdraws the verdict — two lanes — rather
// than by flipping an expectation to go green.
check("08", "ADVISE quiet pole: TWO dispatches withdraw the advising verdict",
  A(4, 2).state !== "ADVISE", `4/2 → ${A(4, 2).state}`);
check("08b", "ONE-LANE arm (loom#2004): a single dispatch against >=2 declared parts ADVISES",
  A(4, 1).state === "ADVISE", `4/1 → ${A(4, 1).state}`);
check("08c", "ONE-LANE arm names its own reason, not the zero-dispatch one",
  /one lane is not parallel execution/.test(A(4, 1).reason || ""),
  `reason: ${A(4, 1).reason}`);
check("08d", "ONE-LANE arm renders a DISTINCT advisory from the zero-dispatch arm",
  L.formatDelegationAdvisory(A(4, 1)) !== L.formatDelegationAdvisory(A(4, 0)) &&
    /ONE lane is not parallel execution/.test(L.formatDelegationAdvisory(A(4, 1)) || ""),
  "the two advising arms must not render identically — a reader must be able to tell which fired");
check("08e", "the promotion did NOT swallow the ambiguous half: >=2 lanes short still OBSERVES",
  A(9, 3).state === "OBSERVE", `9/3 → ${A(9, 3).state}`);
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

// ── 13. the SESSION-VOLUME arm — ORTHOGONAL to everything above ──────────
// The per-prompt arm is QUIET at `declared: 0` by contract, which is the HIGHEST-VOLUME case
// (an open-ended directive enumerates nothing). These cases pin the arm that sees it, and the
// ORTHOGONALITY case below is the one that would have caught the 2026-08-30 defect session.
{
  const MAIN = LEDGER.MAIN_GENERATION;
  const decl = (n = 0) => ({ kind: "declared", declared_subparts: n, generation: MAIN });
  const lau = (i) => ({ kind: "launch", launch_id: `SV${i}`, generation: MAIN, dispatch_name: `lane-${i}` });
  // n prompts, all with ZERO enumerated sub-parts, and no lane at all.
  const serial = (n) => Array.from({ length: n }, () => decl(0));
  const V = (rows) => L.assessSessionVolume(rows);

  check("43", "VOLUME firing pole: a run AT the floor with zero lanes ADVISES",
    V(serial(L.SERIAL_RUN_FLOOR)).state === "ADVISE",
    `${L.SERIAL_RUN_FLOOR} serial prompts → ${V(serial(L.SERIAL_RUN_FLOOR)).state} (run=${V(serial(L.SERIAL_RUN_FLOOR)).run})`,
    "M-h: `run >= SERIAL_RUN_FLOOR` → false (the arm goes inert)");
  check("44", "VOLUME quiet pole: one prompt BELOW the floor is QUIET, not ADVISE",
    V(serial(L.SERIAL_RUN_FLOOR - 1)).state === "QUIET",
    `${L.SERIAL_RUN_FLOOR - 1} serial prompts → ${V(serial(L.SERIAL_RUN_FLOOR - 1)).state}`,
    "M-i: SERIAL_RUN_FLOOR 12 → 11 (a threshold slide is visible at BOTH poles)");
  check("45", "VOLUME quiet pole: ONE dispatched lane resets the run — the same shape stays QUIET",
    (() => {
      const rows = [...serial(L.SERIAL_RUN_FLOOR), lau(0), ...serial(L.SERIAL_RUN_FLOOR - 1)];
      return V(rows).state === "QUIET" && V(rows).dispatched === 1;
    })(),
    `an over-floor run followed by a lane and a below-floor run → ${V([...serial(L.SERIAL_RUN_FLOOR), lau(0), ...serial(L.SERIAL_RUN_FLOOR - 1)]).state}`,
    "M-j: `run = 0` on a main-generation launch → removed (the run stops resetting)");
  check("46", "VOLUME: the run is a RUN, not a session max — a lane mid-session does NOT immunise the tail",
    (() => {
      // MEASURED SHAPE of the 2026-08-30 defect session: it DID dispatch, earlier, then stopped.
      // The obvious "session max dispatched === 0" contract is QUIET here; this arm is not.
      const rows = [...serial(3), lau(0), lau(1), ...serial(L.SERIAL_RUN_FLOOR)];
      const v = V(rows);
      return v.state === "ADVISE" && v.dispatched === 2;
    })(),
    "a session with 2 lanes early and a 12-prompt serial tail still advises",
    "M-k: replace the run with a session-wide max-dispatched test (the falsified contract)");
  check("47", "VOLUME: a NESTED lane's dispatch does not reset the orchestrator's run",
    (() => {
      const rows = [...serial(6), { kind: "launch", launch_id: "N0", generation: "some-lane", dispatch_name: "nested" }, ...serial(6)];
      return V(rows).state === "ADVISE" && V(rows).dispatched === 0;
    })(),
    "attribution matches the reconciler's main-generation rule");
  // ── the SESSION FENCE (2026-08-31) ────────────────────────────────────────
  // The arm aggregates the WHOLE file, so a foreign row's blast radius is the whole session rather
  // than the tail. The dangerous direction is the QUIET one: a foreign `launch` resets our run and
  // SILENTLY suppresses a true finding.
  //
  // WHAT THESE FOUR CASES ACTUALLY COVER, corrected 2026-09-01 to match the source's own
  // WITHDRAWAL. This block used to say a foreign row is "only reachable through the
  // `unknown-session` fallback — which needs no attacker", which described a shape the fence
  // CANNOT see and which case 85 does not construct. Per `delegation-default.js`'s WITHDRAWN
  // CLAIM: `appendRecord` keys the sink FILE on the row's own `session_id`, so two sessions pool
  // into one file ONLY via the `"unknown-session"` literal — and in that file every row AND the
  // reader carry that literal, so `r.session_id !== sessionId` is never true and nothing is
  // fenced. Case 85 therefore builds the DISTINGUISHABLE `S-MINE` / `S-OTHER` shape, which the
  // shipped writers cannot currently produce but a hand-written, migrated or future-writer file
  // can. That is defense-in-depth against a file shape that does not occur today, NOT the closure
  // of the pooling hazard — which remains OPEN and needs a per-process identity when
  // `session_id` is absent, not another predicate. These cases are green while it is open.
  check("85", "FENCE firing pole: a FOREIGN session's launch does NOT reset our run",
    (() => {
      const mine = (r) => ({ ...r, session_id: "S-MINE" });
      const rows = [
        ...serial(6).map(mine),
        { ...lau(9), session_id: "S-OTHER" },
        ...serial(6).map(mine),
      ];
      const v = L.assessSessionVolume(rows, undefined, 0, "S-MINE");
      // 12 of OUR prompts, uninterrupted by a lane that was never ours.
      return v.state === "ADVISE" && v.run === 12 && v.dispatched === 0;
    })(),
    "a foreign launch row cannot silence this session's finding",
    "M-w: drop the session fence (the foreign launch resets run \u2192 QUIET)");
  check("86", "FENCE quiet pole: our OWN launch still resets — the fence does not over-filter",
    (() => {
      const mine = (r) => ({ ...r, session_id: "S-MINE" });
      const rows = [
        ...serial(6).map(mine),
        { ...lau(9), session_id: "S-MINE" },
        ...serial(6).map(mine),
      ];
      const v = L.assessSessionVolume(rows, undefined, 0, "S-MINE");
      return v.state === "QUIET" && v.run === 6 && v.dispatched === 1;
    })(),
    "the fence must admit our own rows — a filter that drops everything would ADVISE always");
  check("87", "FENCE: a row with NO session_id is treated as OURS, not dropped",
    (() => {
      // The file is already session-keyed, so an absent field is an older producer's row for THIS
      // session. Dropping it would shrink prompts toward 0 -> UNKNOWN, turning a legacy ledger
      // silently unmeasured — the absence-reads-as-clean shape this arm exists against.
      const v = L.assessSessionVolume(serial(L.SERIAL_RUN_FLOOR), undefined, 0, "S-MINE");
      return v.state === "ADVISE" && v.prompts === L.SERIAL_RUN_FLOOR;
    })(),
    "legacy rows without session_id stay measured");
  check("88", "FENCE quiet pole: with NO sessionId supplied the arm behaves exactly as before",
    (() => {
      // Backward compatibility: every pre-fence caller passes 3 args. The fence must be inert then,
      // or this change would silently alter every existing consumer's verdict.
      const rows = [...serial(6), { ...lau(9), session_id: "S-OTHER" }, ...serial(6)];
      const v = L.assessSessionVolume(rows);
      return v.state === "QUIET" && v.dispatched === 1;
    })(),
    "an absent sessionId leaves the pre-fence behaviour untouched");
  check("48", "VOLUME UNKNOWN firing pole: null rows are UNKNOWN, never QUIET",
    L.assessSessionVolume(null).state === "UNKNOWN" &&
      L.assessSessionVolume(null, { reason: "ledger unreadable: EACCES" }).reason.includes("EACCES"),
    `null → ${L.assessSessionVolume(null).state}`,
    "M-l: collapse the `!Array.isArray(rows)` UNKNOWN branch to QUIET");
  check("49", "VOLUME UNKNOWN: a readable ledger with NO prompt rows measures nothing → UNKNOWN",
    V([lau(0)]).state === "UNKNOWN",
    "absence of prompts is not evidence of good delegation");
  check("50", "VOLUME UNKNOWN quiet pole: a ledger with real prompt rows is never UNKNOWN",
    V(serial(3)).state !== "UNKNOWN" && V(serial(L.SERIAL_RUN_FLOOR)).state !== "UNKNOWN",
    "both poles of the real arm resolve to a real state");
  check("51", "VOLUME: malformed rows are skipped, not thrown on",
    V([null, "x", decl(0), 42, decl(0)]).state === "QUIET" && V([null, "x"]).state === "UNKNOWN",
    "a shutdown hook must not throw out of its predicate");

  // ── ORTHOGONALITY — the whole point of this arm ──────────────────────────
  // Every prompt declares ZERO sub-parts, so the PER-PROMPT arm is QUIET by its own contract.
  // If this case ever goes red because the session arm stopped firing, the detector is back to
  // being silent on exactly the case that motivated it.
  check("52", "ORTHOGONALITY firing pole: declared_subparts=0 on EVERY prompt — per-prompt arm QUIET, session arm ADVISES",
    (() => {
      const rows = serial(L.SERIAL_RUN_FLOOR + 4);
      const perPrompt = L.assessFromLedger(rows, undefined, LEDGER.reconcile);
      const session = V(rows);
      return perPrompt.state === "QUIET" && session.state === "ADVISE";
    })(),
    `per-prompt=${L.assessFromLedger(serial(L.SERIAL_RUN_FLOOR + 4), undefined, LEDGER.reconcile).state}, session=${V(serial(L.SERIAL_RUN_FLOOR + 4)).state}`,
    "M-h: the session arm goes inert — this is the case NOTHING else covers");
  check("53", "ORTHOGONALITY quiet pole: the two arms are independent in the OTHER direction too",
    (() => {
      // 4 enumerated sub-parts, zero lanes, but only ONE prompt: per-prompt ADVISES, session QUIET.
      const rows = [decl(4)];
      return L.assessFromLedger(rows, undefined, LEDGER.reconcile).state === "ADVISE" && V(rows).state === "QUIET";
    })(),
    "neither arm is a relabelling of the other — each fires where the other does not");

  // ── rendering + signature ────────────────────────────────────────────────
  {
    const adv = L.formatSessionVolumeAdvisory(V(serial(L.SERIAL_RUN_FLOOR))) || "";
    check("54", "VOLUME RENDER firing pole: ADVISE renders a non-empty block naming the zero-lane count",
      adv.includes("ZERO lanes") && adv.includes(String(L.SERIAL_RUN_FLOOR)) && adv.includes("MUST-3"),
      `chars=${adv.length}`,
      "M-m: the session-arm render returns null (the finding never reaches anyone)");
    check("55", "VOLUME RENDER quiet pole: QUIET and UNKNOWN render NOTHING",
      L.formatSessionVolumeAdvisory(V(serial(2))) === null &&
        L.formatSessionVolumeAdvisory(L.assessSessionVolume(null)) === null &&
        L.formatSessionVolumeAdvisory(undefined) === null,
      "silence in the transcript, not silence in the data");
    check("56", "VOLUME RENDER: the advisory carries the SESSION-INSTRUCTION escalation, in this turn",
      /PROHIBIT SPAWNING AGENTS/.test(adv) && /raised with the operator NOW/.test(adv),
      "an agent forbidden to spawn must surface the conflict, not silently continue serially",
      "M-n: strip the session-instruction escalation sentence from the render");
    check("57", "VOLUME RENDER: states the severity cap and its own false-positive bound",
      adv.includes("never a block") && adv.includes("false-positive") && !adv.includes('severity: "block"'),
      "hook-output-discipline.md MUST-2 — no SEVERITY blocks at Stop; refusal is a separate, opt-in lever");
    check("58", "VOLUME RENDER: the two arms render DISTINGUISHABLY",
      adv !== (L.formatDelegationAdvisory(A(4, 0)) || "") && adv.includes("SESSION-LEVEL"),
      "a reader must be able to tell which arm fired");
  }
  check("59", "VOLUME SIGNATURE firing pole: a FURTHER full floor of serial work speaks again",
    L.sessionVolumeSignatureOf(V(serial(L.SERIAL_RUN_FLOOR))) !==
      L.sessionVolumeSignatureOf(V(serial(L.SERIAL_RUN_FLOOR * 2))),
    `${L.sessionVolumeSignatureOf(V(serial(L.SERIAL_RUN_FLOOR)))} vs ${L.sessionVolumeSignatureOf(V(serial(L.SERIAL_RUN_FLOOR * 2)))}`);
  check("60", "VOLUME SIGNATURE quiet pole: ONE more serial prompt does NOT re-speak (bucketed, not exact)",
    L.sessionVolumeSignatureOf(V(serial(L.SERIAL_RUN_FLOOR))) ===
      L.sessionVolumeSignatureOf(V(serial(L.SERIAL_RUN_FLOOR + 1))) &&
      L.sessionVolumeSignatureOf(V(serial(2))) === "",
    "an un-bucketed signature would emit once per turn past the floor — the noisy-detector failure");
  check("61", "VOLUME SIGNATURE: distinct from the per-prompt arm's, so one never dedupes the other",
    L.sessionVolumeSignatureOf(V(serial(L.SERIAL_RUN_FLOOR))) !== L.signatureOf(A(4, 0)) &&
      L.sessionVolumeSignatureOf(V(serial(L.SERIAL_RUN_FLOOR))).startsWith("SESSION-VOLUME:"),
    "two arms, two independent dedupe keys");

  // ── the CALIBRATION is anchored to the corpus, not to a literal ──────────
  // RE-GROUNDED 2026-08-31, after an independent re-derivation REFUTED the original argument.
  // This case used to assert that the floor "sits in the EMPTY gap of the distribution". That is a
  // non-discriminating assertion in this rule-set's own MUST-1 sense: the tail holds 7 sessions
  // spread over 12 integer bins, SIX of which are empty (12, 15, 17, 19, 20, 23). At ~0.6
  // sessions/bin an empty bin is what a sparse tail produces WHETHER OR NOT the floor is a real
  // boundary — so emptiness at 12 would look identical if the proposition were false. 12 was the
  // first of six empty bins, not a distinctive gap.
  //
  // What the corpus DOES support is a STABILITY property, and that is what is asserted now: the
  // firing SET is identical at the floor and at floor+1, so the choice is insensitive to where in
  // the ambiguity band it lands, while floor-1 fires strictly wider. That is a claim the data can
  // refute — and M-i still reds on it, because at 11 the firing set is NOT stable.
  check("62", "CALIBRATION: the floor is the lower edge of a STABLE band, not a lucky empty bin",
    (() => {
      // Per-session MAXIMUM run, measured 2026-08-31 over .claude/learning/dispatch-reconcile/
      // as of that date (44 files, 44 sessions, 1064 declared rows, 563 main-gen launches).
      // SNAPSHOT, deliberately: that directory is a LIVE glob which the verifying session itself
      // writes into, so the raw counts are NOT reproducible later — a re-derivation on 45 files
      // is the expected outcome, not a regression. Recorded here so a future threshold change
      // reds against the MEASUREMENT rather than against a restated number.
      const CORPUS_MAX_RUNS = [
        2, 2, 3, 3, 4, 4, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 8, 8, 8, 8, 8, 8, 8, 9, 9, 9,
        10, 10, 10, 10, 10, 11, 13, 14, 16, 18, 21, 22, 24,
      ];
      const firesAt = (n) => CORPUS_MAX_RUNS.filter((v) => v >= n).length;
      const F = L.SERIAL_RUN_FLOOR;
      // STABLE: the same sessions fire at F and F+1 — the choice does not turn on a single bin.
      const stable = firesAt(F) === firesAt(F + 1);
      // SEPARATING: one integer DOWN fires strictly wider, so F is the LOWER edge of that band
      // rather than a point somewhere inside it.
      const separates = firesAt(F) < firesAt(F - 1);
      // and it must still catch the case the arm was built for (the motivating session, maxRun 21).
      const catchesMotivating = firesAt(F) > 0 && 21 >= F;
      return stable && separates && catchesMotivating && CORPUS_MAX_RUNS.length === 44;
    })(),
    `floor=${L.SERIAL_RUN_FLOOR}: same firing set at ${L.SERIAL_RUN_FLOOR}/${L.SERIAL_RUN_FLOOR + 1}, wider at ${L.SERIAL_RUN_FLOOR - 1} — lower edge of a stable band`,
    "M-i: SERIAL_RUN_FLOOR 12 \u2192 11 (at 11 the firing set is NOT stable \u2014 11 and 12 differ)");

  check("62b", "CALIBRATION honest-bound pole: bin EMPTINESS is NOT the ground, and the set says so",
    (() => {
      // The refuted argument, pinned as a FALSIFIED claim so it cannot be quietly re-derived.
      // If emptiness at the floor were the justification, this assertion would be pointless; it
      // exists precisely because MANY tail bins are empty, which is why emptiness proves nothing.
      const CORPUS_MAX_RUNS = [
        2, 2, 3, 3, 4, 4, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 8, 8, 8, 8, 8, 8, 8, 9, 9, 9,
        10, 10, 10, 10, 10, 11, 13, 14, 16, 18, 21, 22, 24,
      ];
      const max = Math.max(...CORPUS_MAX_RUNS);
      let empty = 0;
      for (let n = L.SERIAL_RUN_FLOOR; n <= max; n++) if (!CORPUS_MAX_RUNS.includes(n)) empty++;
      // More than one empty bin above the floor ⇒ "the floor is empty" carries no information.
      return empty > 1;
    })(),
    "multiple tail bins are empty, so an empty bin at the floor is not evidence of a boundary");

  // ── 15. the RELAPSE class — a dedupe keyed on a RESETTING quantity ──────────
  // MEASURED DEFECT (2026-08-31, two-pole against the library at 3ba48720): the signature was
  // `floor(run / SERIAL_RUN_FLOOR)`, derived from the CURRENT stretch. The run RESETS on any lane,
  // so the second stretch past the floor reproduced bucket 1 and the marker already held it:
  //   12 serial → ADVISORY | +1 lane → silent | +12 MORE serial → SILENT | +23 → STILL SILENT
  // Control on the same run: a fresh session at 12 still fired, so the arm was not inert — the
  // suppression was the dedupe alone. Cases 59/60 were structurally BLIND: 59 drives an UNBROKEN
  // 24 (bucket 2, which DID differ) and 60 asserts sameness, which the defect also produced.
  // The key is now the CROSSING ORDINAL plus depth-within-stretch; these pin both halves.
  check("71", "RELAPSE firing pole: a SECOND crossing after a lane reset speaks (a NEW signature)",
    (() => {
      const one = serial(L.SERIAL_RUN_FLOOR);
      const two = [...serial(L.SERIAL_RUN_FLOOR), lau(0), ...serial(L.SERIAL_RUN_FLOOR)];
      const three = [...two, lau(1), ...serial(L.SERIAL_RUN_FLOOR)];
      const s = (r) => L.sessionVolumeSignatureOf(V(r));
      return V(two).state === "ADVISE" && V(three).state === "ADVISE" &&
        s(two) !== s(one) && s(three) !== s(two) && s(three) !== s(one);
    })(),
    `1st=${L.sessionVolumeSignatureOf(V(serial(L.SERIAL_RUN_FLOOR)))} 2nd=${L.sessionVolumeSignatureOf(V([...serial(L.SERIAL_RUN_FLOOR), lau(0), ...serial(L.SERIAL_RUN_FLOOR)]))}`,
    "M-q: key the session signature on the RUN alone again (the measured relapse defect)");
  check("72", "RELAPSE quiet pole: WITHIN one crossing, every further prompt keeps the SAME signature",
    (() => {
      const s = (n) => L.sessionVolumeSignatureOf(V(serial(n)));
      const base = s(L.SERIAL_RUN_FLOOR);
      // the whole stretch from the floor up to (but not reaching) a further full floor is one key
      for (let n = L.SERIAL_RUN_FLOOR; n < L.SERIAL_RUN_FLOOR * 2; n++) if (s(n) !== base) return false;
      return base !== "";
    })(),
    "an un-deduped key would emit once per turn past the floor — the noisy-detector failure");
  // M-q does NOT red this case, and that is measured rather than assumed: M-q keys the SIGNATURE,
  // while this case reads the WALK.
  check("73", "RELAPSE: the ORDINAL counts CROSSINGS, not prompts, and never decreases across resets",
    (() => {
      const one = V(serial(L.SERIAL_RUN_FLOOR));
      const deep = V(serial(L.SERIAL_RUN_FLOOR * 2));
      const two = V([...serial(L.SERIAL_RUN_FLOOR), lau(0), ...serial(L.SERIAL_RUN_FLOOR)]);
      const below = V(serial(L.SERIAL_RUN_FLOOR - 1));
      // a deeper UNBROKEN run is still ONE crossing; a reset-then-recross is TWO; below-floor is none
      return one.crossings === 1 && deep.crossings === 1 && two.crossings === 2 && below.crossings === 0;
    })(),
    `1 stretch=${V(serial(L.SERIAL_RUN_FLOOR)).crossings}, unbroken 2x=${V(serial(L.SERIAL_RUN_FLOOR * 2)).crossings}, re-crossed=${V([...serial(L.SERIAL_RUN_FLOOR), lau(0), ...serial(L.SERIAL_RUN_FLOOR)]).crossings}`,
    "M-v: drop the `crossings` tick from the volume walk");

  // ── 16. the BROKEN-INSTRUMENT state — UNKNOWN is not one state ──────────────
  // MEASURED DEFECT (2026-08-31): `formatSessionVolumeAdvisory` returned null on every non-ADVISE
  // verdict, so at the OUTPUT boundary a corrupt ledger was byte-identical to a well-delegating
  // session (sha256 of stdout AND stderr equal, 0 stderr bytes each). The library's own comment
  // argued that reporting this in the grammar of "delegated fine" is the failure the tri-state
  // exists to prevent — and the renderer erased it one function later. The noise argument for
  // silence is SOUND and is preserved: instrument-DID-NOT-RUN stays silent, instrument-RAN-BROKEN
  // speaks. These cases pin the SPLIT, not just the speaking half.
  const corruptV = L.assessSessionVolume([], undefined, 3);
  check("74", "CORRUPT firing pole: a ledger READ whose every line was unparseable SPEAKS",
    corruptV.state === "UNKNOWN" && corruptV.corrupt === true &&
      /BROKEN INSTRUMENT/.test(L.formatSessionVolumeAdvisory(corruptV) || ""),
    `state=${corruptV.state} corrupt=${corruptV.corrupt} chars=${(L.formatSessionVolumeAdvisory(corruptV) || "").length}`,
    "M-r: drop the corrupt branch from formatSessionVolumeAdvisory (back to silent-on-every-UNKNOWN)");
  // THE ONE-ROW DISARM (2026-08-31). `corrupt` used to read `rows.length === 0 && skipped > 0`,
  // which asks a different question than the `prompts === 0` branch it sits in: `rows.length`
  // counts EVERY record kind, so a single parsable `launch` / `delivery` / `reconcile` row
  // disarmed the state entirely. Measured at the output boundary, "1 launch + 200 unparseable
  // lines" was byte-identical to a well-delegating session. These two cases pin the corrected
  // predicate; without them the fix was invisible to the suite (99/99 both before and after).
  check("93", "CORRUPT firing pole: ONE parsable non-declared row must NOT disarm the broken state",
    (() => {
      // rows.length === 1 (a launch), prompts === 0 (no declared rows), skipped > 0.
      // Old predicate: corrupt=false -> SILENT. Corrected: corrupt=true -> SPEAKS.
      const v = L.assessSessionVolume([lau(0)], undefined, 200);
      return v.state === "UNKNOWN" && v.prompts === 0 && v.corrupt === true &&
        /BROKEN INSTRUMENT/.test(L.formatSessionVolumeAdvisory(v) || "");
    })(),
    "nothing was measured, so one surviving row is not evidence the instrument worked",
    "M-z: corrupt back to `rows.length === 0 && skipped > 0` (one row re-disarms it)");
  check("94", "CORRUPT quiet pole: rows that DID measure prompts are not a broken instrument",
    (() => {
      // prompts > 0, so this never enters the corrupt branch at all — a partially-corrupt ledger
      // that still measured a real serial run must report THAT, not a broken instrument.
      const v = L.assessSessionVolume(serial(L.SERIAL_RUN_FLOOR), undefined, 7);
      return v.state === "ADVISE" && v.corrupt !== true &&
        !/BROKEN INSTRUMENT/.test(L.formatSessionVolumeAdvisory(v) || "");
    })(),
    "skipped lines alongside a real measurement are lossy, not blind — the arm still reports the run");
  check("75", "CORRUPT quiet pole: instrument-DID-NOT-RUN stays SILENT — no ledger, empty ledger, QUIET",
    L.formatSessionVolumeAdvisory(L.assessSessionVolume(null, undefined, 0)) === null &&
      L.formatSessionVolumeAdvisory(L.assessSessionVolume([], undefined, 0)) === null &&
      L.formatSessionVolumeAdvisory(V(serial(2))) === null &&
      L.assessSessionVolume([], undefined, 0).corrupt === false,
    "a fresh clone and CI are UNKNOWN on every run; a line there teaches the reader to skip this hook",
    "M-s: render on EVERY unknown (the noise failure the split exists to avoid)");
  check("76", "CORRUPT narrowness: PARTIAL corruption does NOT fire — usable rows means it ran",
    (() => {
      const partial = L.assessSessionVolume(serial(3), undefined, 5);
      return partial.corrupt === false && L.formatSessionVolumeAdvisory(partial) === null &&
        partial.skipped === 5;
    })(),
    "skipped>0 with usable rows is a torn line, not a dead detector — the verdict still measured something");
  check("77", "CORRUPT signature: a fixed per-session key, distinct from BOTH arms, and it dedupes",
    L.sessionVolumeSignatureOf(corruptV) === "SESSION-VOLUME:CORRUPT" &&
      L.sessionVolumeSignatureOf(corruptV) === L.sessionVolumeSignatureOf(L.assessSessionVolume([], undefined, 9)) &&
      L.sessionVolumeSignatureOf(corruptV) !== L.sessionVolumeSignatureOf(V(serial(L.SERIAL_RUN_FLOOR))) &&
      L.sessionVolumeSignatureOf(corruptV) !== L.signatureOf(A(4, 0)) &&
      L.sessionVolumeSignatureOf(L.assessSessionVolume([], undefined, 0)) === "",
    "spoken once per session, never once per turn, and it never dedupes against a real finding");
  check("78", "CORRUPT render: DISTINGUISHABLE from both advisory arms, and states it is not clean",
    (() => {
      const t = L.formatSessionVolumeAdvisory(corruptV) || "";
      return t !== (L.formatSessionVolumeAdvisory(V(serial(L.SERIAL_RUN_FLOOR))) || "") &&
        t !== (L.formatDelegationAdvisory(A(4, 0)) || "") &&
        /NOT a clean result/.test(t) && /never a block/.test(t);
    })(),
    "a reader must be able to tell 'you did not delegate' from 'I could not tell'");

  // ── 17. the GENERATION filter on DECLARED rows — previously UNPINNED ────────
  // The filter was exercised only on `launch` rows (case 47). No case fed a non-main `declared`
  // row, and none OMITTED `generation`, so both halves of `_isNonEmptyString(r.generation) ?
  // r.generation : MAIN_GENERATION` were free to move without reddening anything.
  check("79", "GENERATION firing pole: a SUBAGENT's declared rows are NOT the orchestrator's prompts",
    (() => {
      const nested = Array.from({ length: L.SERIAL_RUN_FLOOR }, () => ({
        kind: "declared", declared_subparts: 0, generation: "some-lane",
      }));
      // control: the SAME shape attributed to main DOES advise, so the case can return the other answer
      const asMain = V(serial(L.SERIAL_RUN_FLOOR));
      const v = V([...serial(2), ...nested]);
      return asMain.state === "ADVISE" && v.state === "QUIET" && v.prompts === 2;
    })(),
    `${L.SERIAL_RUN_FLOOR} nested declared rows + 2 main → ${V([...serial(2), ...Array.from({length: L.SERIAL_RUN_FLOOR}, () => ({kind:"declared",declared_subparts:0,generation:"some-lane"}))]).state}`,
    "M-t: drop the generation filter (a nested lane's prompts inflate the orchestrator's run)");
  check("80", "GENERATION quiet pole: a row OMITTING `generation` defaults to MAIN and IS counted",
    (() => {
      const bare = Array.from({ length: L.SERIAL_RUN_FLOOR }, () => ({ kind: "declared", declared_subparts: 0 }));
      const v = V(bare);
      // and an EMPTY-STRING generation takes the same default — _isNonEmptyString, not truthiness
      const empty = V(Array.from({ length: L.SERIAL_RUN_FLOOR }, () => ({ kind: "declared", declared_subparts: 0, generation: "" })));
      return v.state === "ADVISE" && v.prompts === L.SERIAL_RUN_FLOOR && empty.state === "ADVISE";
    })(),
    "the defensive default is fail-LOUD: an unattributed row is the orchestrator's, not discarded",
    "M-u: default a missing generation to a non-main sentinel (rows silently vanish)");
}

// ── 11/12. the marker file + the REAL hook boundary ──────────────────────
// The 68 cases above exercise pure functions (derived, not counted by eye: every `check(` before
// this comment). They would ALL PASS against a hook that never runs —
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
  // 2026-08-27 — the regression lock for routing this guard through the SHARED emitter.
  // Case 30 above asserts the HUMAN channel (stderr) and passed both before and after that
  // change, so it cannot discriminate it: the defect being fixed was that the finding reached
  // the terminal ONLY and never entered the agent's context. These two cases assert the AGENT
  // channel, which at `Stop` is top-level `systemMessage` (instruct-and-wait.js delivery
  // contract). Bipolar, because "always emits a systemMessage" would pass vacuously.
  check("31a", "END-TO-END firing pole: the advisory reaches the AGENT on stdout as systemMessage",
    (() => {
      try {
        const j = JSON.parse(advise.stdout.trim().split("\n").pop() || "{}");
        return typeof j.systemMessage === "string" && j.systemMessage.includes("ZERO lanes");
      } catch { return false; }
    })(),
    `stdout=${JSON.stringify(advise.stdout.slice(0, 80))}`,
    "M-p: force the emitter-routing fallback — the finding reaches the terminal, never the agent");
  check("31b", "END-TO-END quiet pole: a fully-delegated session carries NO systemMessage",
    (() => {
      try {
        const j = JSON.parse(quiet.stdout.trim().split("\n").pop() || "{}");
        return j.continue === true && j.systemMessage === undefined;
      } catch { return false; }
    })(),
    "silence must stay silent on BOTH channels, not merely on stderr");
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
  // ── END-TO-END for the SESSION-VOLUME arm ────────────────────────────────
  // Cases 43-62 above are pure functions and would ALL PASS against a guard that never consults
  // the new arm at all — the same inertness that let `dispatch-contract-guard.js` ship dead while
  // 42 library fixtures stayed green. These drive the real hook: real child process, real stdin.
  {
    // n prompts declaring ZERO sub-parts each, then optionally one lane. `seed` writes one
    // declared row per call, so the run is built by repetition.
    const seedSerial = (session, n, lanesAtEnd = 0) => {
      for (let i = 0; i < n; i++) seed(session, 0, 0);
      if (lanesAtEnd) seed(session, 0, lanesAtEnd);
    };
    // The per-session sink path, derived exactly as `dispatch-ledger.js::_sinkPath` derives it
    // (sanitized token + 8 hex of the sha256 of the RAW id). Needed by the cases that must place a
    // row the LEDGER API will not place for them — a row attributed to a FOREIGN session, which
    // `appendRecord` would route to a DIFFERENT file by construction.
    const sinkPathOf = (repoDir, session) =>
      path.join(
        repoDir, ".claude", "learning", "dispatch-reconcile",
        `${session.replace(/[^A-Za-z0-9._-]/g, "_")}-` +
          `${require("node:crypto").createHash("sha256").update(session, "utf8").digest("hex").slice(0, 8)}.jsonl`,
      );
    seedSerial("fx-volume-advise", L.SERIAL_RUN_FLOOR + 2);
    seedSerial("fx-volume-quiet", L.SERIAL_RUN_FLOOR - 1);
    // Over-floor run, then a lane: the run resets, so the arm must go quiet at the boundary too.
    // `seed(s, 0, 1)` appends one MORE declared row before the launch, hence FLOOR + 1 declared
    // rows total with the launch LAST — a run of 0.
    seedSerial("fx-volume-reset", L.SERIAL_RUN_FLOOR, 1);

    const volAdvise = fireCapture(HOOK, tmp, "fx-volume-advise");
    const volQuiet = fireCapture(HOOK, tmp, "fx-volume-quiet");
    const volReset = fireCapture(HOOK, tmp, "fx-volume-reset");

    check("63", "E2E VOLUME firing pole: a zero-lane serial run emits the SESSION-LEVEL advisory",
      volAdvise.stderr.includes("[delegation-default]") &&
        volAdvise.stderr.includes("ZERO lanes across its last"),
      `stderr chars=${volAdvise.stderr.length}`,
      "M-h/M-o: the session arm goes inert, or is never wired into the guard");
    check("64", "E2E VOLUME quiet pole: a BELOW-floor serial run emits NOTHING",
      volQuiet.stderr.trim() === "",
      `stderr=${JSON.stringify(volQuiet.stderr.slice(0, 60))}`);
    check("65", "E2E VOLUME quiet pole: a dispatched lane resets the run — nothing is emitted",
      volReset.stderr.trim() === "",
      `stderr=${JSON.stringify(volReset.stderr.slice(0, 60))}`,
      "M-j: `run = 0` on a main-generation launch → removed");
    check("66", "E2E ORTHOGONALITY: every prompt declared 0 sub-parts, so ONLY the session arm speaks",
      volAdvise.stderr.includes("ZERO lanes across its last") &&
        !volAdvise.stderr.includes("enumerated sub-parts and ZERO lanes were"),
      "the per-prompt arm is silent at declared=0 — this is the case it structurally cannot see",
      "M-o: drop the session arm from the guard (back to the pre-2026-08-31 blind spot)");
    check("67", "E2E VOLUME: the advisory reaches the AGENT on stdout as systemMessage",
      (() => {
        try {
          const j = JSON.parse(volAdvise.stdout.trim().split("\n").pop() || "{}");
          return typeof j.systemMessage === "string" && j.systemMessage.includes("ZERO lanes across its last");
        } catch { return false; }
      })(),
      `stdout=${JSON.stringify(volAdvise.stdout.slice(0, 80))}`,
      "M-p: revert the emitter routing — the finding reaches the terminal but never the agent");
    check("68", "E2E VOLUME quiet pole: a below-floor session carries NO systemMessage",
      (() => {
        try {
          const j = JSON.parse(volQuiet.stdout.trim().split("\n").pop() || "{}");
          return j.continue === true && j.systemMessage === undefined;
        } catch { return false; }
      })(),
      "silence must stay silent on BOTH channels");
    // BLIND to the relapse defect by construction — silence is what that defect produced too.
    // Case 81 is the firing pole that discriminates it.
    check("69", "E2E VOLUME dedupe: the SAME bucket is surfaced once, not once per turn",
      (() => {
        const second = fireCapture(HOOK, tmp, "fx-volume-advise");
        return second.stderr.trim() === "";
      })(),
      "the QUIET pole of the relapse pair: the SAME stretch must not re-speak",
      "M-e: alreadySurfaced() returns false unconditionally");
    // `Stop` CAN refuse a hand-back via the opt-in refusal lever (`instruct-and-wait.js`
    // § STOP HAND-BACK REFUSAL); this guard deliberately passes none, so what is asserted here is
    // that a CHOICE held, not that the platform imposed a limit.
    check("70", "E2E VOLUME: every path emits continue:true and exits 0 — this guard never refuses",
      [volAdvise, volQuiet, volReset].every(
        (r) => r.code === 0 && JSON.parse(r.stdout.trim().split("\n").pop()).continue === true,
      ),
      "hook-output-discipline.md MUST-2 — no SEVERITY blocks at Stop");

    // ── E2E RELAPSE — the defect case 69 could not see ─────────────────────────
    // Case 69 asserts the SAME stretch stays silent on a second turn, which the defective build
    // also produced; it was blind by construction. This drives the sequence the defect was
    // MEASURED on: fire at the floor, open ONE lane, run the floor again — the second crossing
    // must speak. Bipolar with 69: 69 is the quiet pole, this is the firing pole.
    check("81", "E2E RELAPSE firing pole: a SECOND crossing after a lane reset SPEAKS again",
      (() => {
        const S = "fx-volume-relapse";
        seedSerial(S, L.SERIAL_RUN_FLOOR);
        const first = fireCapture(HOOK, tmp, S);
        const repeat = fireCapture(HOOK, tmp, S); // same stretch → must stay silent (quiet pole)
        seed(S, 0, 1); // one lane: the run resets
        seedSerial(S, L.SERIAL_RUN_FLOOR);
        const second = fireCapture(HOOK, tmp, S);
        return first.stderr.includes("ZERO lanes across its last") &&
          repeat.stderr.trim() === "" &&
          second.stderr.includes("ZERO lanes across its last");
      })(),
      "12 serial → speaks; same stretch → silent; +1 lane +12 serial → speaks AGAIN",
      "M-q: key the session signature on the RUN alone (the relapse defect, end to end)");

    // ── E2E BROKEN INSTRUMENT — the byte-identical-output defect ───────────────
    // MEASURED at this boundary before the fix: sha256(stdout) and sha256(stderr) were EQUAL for
    // an all-corrupt ledger and a well-delegating session (0 stderr bytes each). Bipolar: the
    // corrupt pole must speak on BOTH channels, the no-ledger pole must stay silent on both.
    check("82", "E2E CORRUPT firing pole: an all-unparseable ledger reports a BROKEN INSTRUMENT",
      (() => {
        const S = "fx-corrupt";
        const p = sinkPathOf(tmp, S);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "{not json\n<<<torn\nnope nope\n");
        const r = fireCapture(HOOK, tmp, S);
        let agentSaw = false;
        try {
          const j = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
          agentSaw = typeof j.systemMessage === "string" && /BROKEN INSTRUMENT/.test(j.systemMessage);
        } catch { agentSaw = false; }
        return /BROKEN INSTRUMENT/.test(r.stderr) && agentSaw && r.code === 0;
      })(),
      "a detector that measured nothing must not be byte-identical to one that measured cleanliness",
      "M-r: drop the corrupt branch from formatSessionVolumeAdvisory");
    check("83", "E2E CORRUPT quiet pole: NO ledger stays SILENT and is byte-identical to a clean session",
      (() => {
        const absent = fireCapture(HOOK, tmp, "fx-corrupt-absent");
        const clean = fireCapture(HOOK, tmp, "fx-quiet"); // already deduped/quiet from above
        return absent.stderr.trim() === "" && !/BROKEN INSTRUMENT/.test(absent.stdout) &&
          absent.stdout === clean.stdout && absent.stderr === clean.stderr;
      })(),
      "the noise argument holds where it holds: a fresh clone and CI are UNKNOWN on EVERY run",
      "M-s: render on every UNKNOWN (a line in every fresh-clone and CI session)");
    check("84", "E2E CORRUPT dedupe: the broken instrument is reported ONCE per session, not per turn",
      fireCapture(HOOK, tmp, "fx-corrupt").stderr.trim() === "",
      "a fixed per-session key — a broken detector is a standing condition, not a per-turn event");

    // ── E2E SESSION FENCE — the WIRING, not just the library ──────────────────
    // Cases 85-88 call `L.assessSessionVolume(...)` DIRECTLY and supply the sessionId themselves,
    // so they pass identically against a guard that never supplies one. MEASURED: replacing the
    // guard's 4th argument at its ONLY production call site with `undefined` reddened NOTHING at
    // 95 cases — the fence could be silently unwired with a green suite. These two drive the real
    // hook, where the argument is either passed or it is not.
    //
    // The pooling this defends against needs no attacker: `session_id` falls back to the literal
    // `"unknown-session"` at three independent sites, so two sessions that each hit an empty or
    // slow stdin share ONE file. The dangerous direction is the QUIET one — a foreign `launch`
    // resets our run and SILENTLY suppresses a true finding.
    const appendForeignLaunch = (ourSession, foreignSession) => {
      const p = sinkPathOf(tmp, ourSession);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(
        p,
        JSON.stringify(
          LEDGER.buildLaunchRecord({
            sessionId: foreignSession,
            generation: LEDGER.MAIN_GENERATION,
            dispatchName: "foreign-lane",
            subagentType: "analyst",
            nowIso: new Date().toISOString(),
          }),
        ) + "\n",
      );
    };
    const HALF = Math.ceil(L.SERIAL_RUN_FLOOR / 2);
    // Half a floor of OUR prompts, then a lane that is NOT ours pooled into our file, then the
    // rest. The run reaches the floor ONLY if the foreign row is fenced out.
    seedSerial("fx-fence-foreign", HALF);
    appendForeignLaunch("fx-fence-foreign", "fx-fence-SOMEONE-ELSE");
    seedSerial("fx-fence-foreign", L.SERIAL_RUN_FLOOR - HALF);
    const fenceForeign = fireCapture(HOOK, tmp, "fx-fence-foreign");
    // The same shape with the lane attributed to US: the run resets and the arm must go quiet.
    seedSerial("fx-fence-own", HALF);
    seed("fx-fence-own", 0, 1);
    seedSerial("fx-fence-own", L.SERIAL_RUN_FLOOR - HALF);
    const fenceOwn = fireCapture(HOOK, tmp, "fx-fence-own");

    check("89", "E2E FENCE firing pole: a FOREIGN session's launch pooled into our sink does NOT silence the finding",
      fenceForeign.stderr.includes(`ZERO lanes across its last ${L.SERIAL_RUN_FLOOR} `) &&
        fenceForeign.code === 0,
      `stderr chars=${fenceForeign.stderr.length}`,
      "M-w: drop the session fence / M-y: unwire it at the guard's only production call site");
    check("90", "E2E FENCE quiet pole: our OWN launch in the same position DOES reset the run — the fence does not over-filter",
      fenceOwn.stderr.trim() === "" && fenceOwn.code === 0,
      `stderr=${JSON.stringify(fenceOwn.stderr.slice(0, 60))} — a fence that dropped OUR rows too would advise here`,
      "M-j: `run = 0` on a main-generation launch → removed");

    // ── E2E EMITTER-REQUIRE FAILURE — the mark-AFTER-emitter-resolves ordering ──
    // The guard marks the dedupe only `if (resolved.ok && emit)`. Dropping `&& emit` restores a
    // MEASURED defect the guard carries a 15-line comment about: a `require` failure consumed the
    // dedupe while the advisory fell back to stderr, suppressing the finding for the REST OF THE
    // SESSION. MEASURED at 95 cases, that mutation reddened NOTHING — every end-to-end case above
    // runs against a tree where the emitter loads, so none of them can reach the branch at all.
    //
    // Reaching it needs a hooks tree whose `lib/instruct-and-wait.js` is ABSENT. The guard requires
    // it by `__dirname`, so the tree is COPIED into tmp and the guard is driven from the COPY.
    // Nothing under the real `.claude/hooks/` is read for anything but the copy, and nothing there
    // is written.
    const hooksOk = path.join(tmp, "hooks-emitter-ok");
    const hooksBroken = path.join(tmp, "hooks-emitter-broken");
    fs.cpSync(path.join(REPO, ".claude/hooks"), hooksOk, { recursive: true });
    fs.cpSync(path.join(REPO, ".claude/hooks"), hooksBroken, { recursive: true });
    fs.rmSync(path.join(hooksBroken, "lib", "instruct-and-wait.js"), { force: true });
    const HOOK_OK = path.join(hooksOk, "delegation-default-guard.js");
    const HOOK_BROKEN = path.join(hooksBroken, "delegation-default-guard.js");

    // CONTROL FIRST (`instrument-discipline.md` MUST-3(a)). Without this, case 92's result would be
    // equally consistent with a copied tree that simply does not run — the copy is a new instrument
    // and has to be shown capable of the ORDINARY answer before its unusual one is read.
    check("91", "E2E EMITTER control: the COPIED hooks tree behaves EXACTLY as the real one — stderr, systemMessage, and the dedupe holds",
      (() => {
        const S = "fx-emitter-ok";
        seedSerial(S, L.SERIAL_RUN_FLOOR);
        const first = fireCapture(HOOK_OK, tmp, S);
        const second = fireCapture(HOOK_OK, tmp, S);
        let agentSaw = false;
        try {
          const j = JSON.parse(first.stdout.trim().split("\n").pop() || "{}");
          agentSaw = typeof j.systemMessage === "string" && j.systemMessage.includes("ZERO lanes across its last");
        } catch { agentSaw = false; }
        return first.stderr.includes("ZERO lanes across its last") && agentSaw &&
          second.stderr.trim() === "" && first.code === 0;
      })(),
      "the positive control for case 92 — the copy resolves its repo root, reads the ledger, emits, and marks");
    check("92", "E2E EMITTER firing pole: when the emitter cannot be required, NOTHING is marked — the finding stays LIVE for the next turn",
      (() => {
        const S = "fx-emitter-broken";
        seedSerial(S, L.SERIAL_RUN_FLOOR);
        const first = fireCapture(HOOK_BROKEN, tmp, S);
        // the advisory took the stderr fallback: the human sees it, the AGENT does not
        let agentSaw = true;
        try {
          const j = JSON.parse(first.stdout.trim().split("\n").pop() || "{}");
          agentSaw = typeof j.systemMessage === "string";
        } catch { agentSaw = true; }
        // and NOT ONE marker line was written, so the next turn still speaks
        const mf = L.markerPath(tmp, S);
        const markedAny =
          fs.existsSync(mf) && fs.readFileSync(mf, "utf8").split("\n").some((l) => l.trim() !== "");
        const second = fireCapture(HOOK_BROKEN, tmp, S);
        return first.stderr.includes("ZERO lanes across its last") && agentSaw === false &&
          markedAny === false && second.stderr.includes("ZERO lanes across its last") &&
          first.code === 0 && second.code === 0;
      })(),
      "a require failure must not consume the dedupe — a lost line costs a repeat, a wrong suppression costs the finding",
      "M-x: mark BEFORE the emitter is known loadable (`resolved.ok && emit` → `resolved.ok`)");
  }

  // ── 20. THE READ HALF OF THE SINK CONTRACT (loom#1762) ───────────────────
  // Two CRITICALs and one rendering defect, all the same class: a WRITE path hardened through
  // `append-sink.js` paired with a READ path that neither resolved nor bounded anything. Every
  // case below was ABSENT when the fixes landed and the suite stayed 101/101 green against all
  // three — which is why they exist. Each carries BOTH poles: the refusal, and the ordinary case
  // that must keep working, because a containment fix that simply always refuses is inert in the
  // opposite direction and would pass a firing-only set.
  {
    const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-default-outoftree-"));
    const poison = path.join(OUT, "poison.jsonl");
    const SIG = "ADVISE:5:0";
    fs.writeFileSync(poison, JSON.stringify({ sig: SIG, ts: "seeded-by-the-attacker" }) + "\n");
    fs.mkdirSync(path.join(tmp, ".claude", "learning", "delegation-default"), { recursive: true });

    // (a) THE MEASURED DEFECT. Symlinking the marker at an out-of-tree file the attacker controls
    // took a real finding from 3647 bytes to 18 — byte-identical to a clean session.
    check("95", "MARKER CONTAINMENT firing pole: a SYMLINKED marker is refused, so the advisory is NOT suppressed",
      (() => {
        const S = "fx-marker-symlink";
        const mp = L.markerPath(tmp, S);
        try { fs.unlinkSync(mp); } catch {}
        fs.symlinkSync(poison, mp);
        return L.alreadySurfaced(tmp, S, SIG) === false;
      })(),
      "an out-of-tree file must never answer a question about this repository",
      "M-z: route `alreadySurfaced` back through bare fs.statSync + fs.readFileSync");

    // (b) THE QUIET POLE, and it is what stops (a) passing against a stub that always returns
    // false. A containment fix that also breaks the ordinary dedupe is not a fix.
    check("96", "MARKER CONTAINMENT quiet pole: an HONEST in-tree marker STILL suppresses",
      (() => {
        const S = "fx-marker-honest";
        return L.markSurfaced(tmp, S, SIG, new Date().toISOString()).ok === true &&
          L.alreadySurfaced(tmp, S, SIG) === true &&
          // and a DIFFERENT signature is still not suppressed by it
          L.alreadySurfaced(tmp, S, "ADVISE:9:0") === false;
      })(),
      "the fix must not be 'always false' — the write/read round-trip has to keep working",
      "M-z2: make `alreadySurfaced` return false unconditionally (containment as a stub)");

    // (c) A HARD LINK is invisible to containment: `ln <out-of-tree> <in-tree>` succeeds on one
    // device and the in-tree name then RESOLVES INSIDE the root. Only the nlink check sees it.
    check("97", "MARKER CONTAINMENT: a HARD-LINKED marker (out-of-tree bytes, in-tree name) is refused",
      (() => {
        const S = "fx-marker-hardlink";
        const mp = L.markerPath(tmp, S);
        try { fs.unlinkSync(mp); } catch {}
        try { fs.linkSync(poison, mp); } catch { return true; } // cross-device: not reachable here
        return fs.realpathSync(mp).startsWith(fs.realpathSync(tmp)) && L.alreadySurfaced(tmp, S, SIG) === false;
      })(),
      "containment resolves INSIDE the root here — the nlink check is the only thing that refuses",
      "M-z3: drop the `nlink > 1` refusal from `readSinkFile`");

    // (d) THE RESIDUAL, PINNED AS A TEST so it cannot be quietly believed closed. An attacker who
    // simply WRITES the predictable in-tree path still disarms the detector completely. Closing it
    // needs an unpredictable (session-scoped HMAC) key and is a DESIGN change, not done here.
    check("98", "MARKER RESIDUAL (NOT closed): a pre-planted IN-TREE marker still suppresses — containment is not authentication",
      (() => {
        const S = "fx-marker-preplanted";
        const mp = L.markerPath(tmp, S);
        fs.writeFileSync(mp, JSON.stringify({ sig: SIG, ts: "planted" }) + "\n");
        return L.alreadySurfaced(tmp, S, SIG) === true;
      })(),
      "documents the OPEN half: this case going false would mean the HMAC landed and this text is stale");

    // ── the ledger read: the cap was on the STAT, never on the READ ────────
    const LSINK = (s) => LEDGER._sinkPath(tmp, s);
    const ROW = (s) => JSON.stringify({
      kind: "declared", session_id: s, generation: LEDGER.MAIN_GENERATION, declared_subparts: 0,
    }) + "\n";
    const CAP = LEDGER.MAX_LEDGER_BYTES;

    check("99", "LEDGER BOUND firing pole: an OVER-cap ledger is refused, and says so structurally",
      (() => {
        const S = "fx-ledger-overcap";
        const p = LSINK(S);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "x".repeat(CAP + 1));
        const r = LEDGER.readLedger({ repoDir: tmp, sessionId: S });
        return r.ok === false && r.overCap === true && r.absent === false;
      })(),
      "`overCap`/`absent` are FIELDS, not a string-match on the reason",
      "M-z4: drop the over-cap refusal from `readSinkFile`");

    check("100", "LEDGER BOUND quiet pole: a small HONEST ledger still reads every row",
      (() => {
        const S = "fx-ledger-small";
        const p = LSINK(S);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, ROW(S).repeat(3));
        const r = LEDGER.readLedger({ repoDir: tmp, sessionId: S });
        return r.ok === true && r.rows.length === 3 && r.skipped === 0;
      })(),
      "a bound that refuses everything is inert in the other direction");

    // THE DEFECT'S OWN CONTROL. Before the fix a stat reporting `size:100` against a 4 MB file
    // still returned all 200,000 rows — proving the read ignored the stat and ran to EOF. With the
    // bound ON THE READ, a lying stat cannot widen it. This is the case that discriminates
    // "bounded by the read" from "bounded by a stat", and NO other case in this set can.
    check("101", "LEDGER BOUND: the READ is the enforcement point — a LYING stat cannot widen it",
      (() => {
        const S = "fx-ledger-lyingstat";
        const p = LSINK(S);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, ROW(S).repeat(60000)); // comfortably over the cap
        const real = fs.statSync;
        fs.statSync = (q, ...rest) => {
          const st = real.call(fs, q, ...rest);
          if (String(q) === p) return { ...st, size: 100, isFile: () => true };
          return st;
        };
        let r;
        try { r = LEDGER.readLedger({ repoDir: tmp, sessionId: S }); }
        finally { fs.statSync = real; }
        return r.ok === false && r.overCap === true;
      })(),
      "the pre-fix code returned 200,000 rows here; a stat is not a bound",
      "M-z5: gate the read on `statSync().size` again instead of on the bytes actually read");

    check("102", "LEDGER BOUND boundary: exactly the cap READS, cap+1 REFUSES — measured, not assumed",
      (() => {
        const S = "fx-ledger-boundary";
        const p = LSINK(S);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "x".repeat(CAP));
        const at = LEDGER.readLedger({ repoDir: tmp, sessionId: S });
        fs.writeFileSync(p, "x".repeat(CAP + 1));
        const over = LEDGER.readLedger({ repoDir: tmp, sessionId: S });
        return at.ok === true && over.ok === false && over.overCap === true;
      })(),
      "an off-by-one here silently re-opens or over-closes the cap");

    check("103", "LEDGER ABSENT quiet pole: a genuinely absent ledger is `absent:true` and keeps its reason",
      (() => {
        const r = LEDGER.readLedger({ repoDir: tmp, sessionId: "fx-ledger-never-written" });
        return r.ok === false && r.absent === true && /never wrote one/.test(r.reason);
      })(),
      "the fresh-clone / CI / no-dispatch case must stay distinguishable from a refusal",
      "M-z6: collapse `absent` so every failure looks alike again");

    check("104", "LEDGER CONTAINMENT firing pole: a SYMLINKED ledger is refused and is NOT reported absent",
      (() => {
        const S = "fx-ledger-symlink";
        const p = LSINK(S);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        try { fs.unlinkSync(p); } catch {}
        fs.symlinkSync(poison, p);
        const r = LEDGER.readLedger({ repoDir: tmp, sessionId: S });
        return r.ok === false && r.absent === false;
      })(),
      "an out-of-tree ledger must not answer a question about this session",
      "M-z: route the ledger read back through bare fs.statSync + fs.readFileSync");

    // ── the third defect: a computed refusal reason that was then DISCARDED ──
    check("105", "CORRUPT firing pole: a REFUSED read is a BROKEN INSTRUMENT and SPEAKS",
      (() => {
        const v = L.assessSessionVolume(null, { ok: false, absent: false, reason: "refused for a reason" }, 0);
        const line = L.formatSessionVolumeAdvisory(v);
        return v.state === "UNKNOWN" && v.corrupt === true && v.corrupt_kind === "read-refused" &&
          typeof line === "string" && line.includes("BROKEN INSTRUMENT") &&
          // it must NOT borrow the all-unparseable sentence about lines that did not parse
          !line.includes("line(s) parsed into a usable record");
      })(),
      "before this, an over-cap / symlinked / ENAMETOOLONG read rendered null — byte-identical to a clean session",
      "M-z7: hard-code `corrupt: false` in the `!Array.isArray(rows)` branch again");

    check("106", "CORRUPT quiet pole: an ABSENT ledger is NOT corrupt and stays SILENT",
      (() => {
        const v = L.assessSessionVolume(null, { ok: false, absent: true, reason: "never wrote one" }, 0);
        return v.state === "UNKNOWN" && v.corrupt === false && v.corrupt_kind === null &&
          L.formatSessionVolumeAdvisory(v) === null;
      })(),
      "the noise rule holds exactly where it was written for — fresh clone, CI, pre-first-prompt",
      "M-z8: treat EVERY read failure as corrupt (a BROKEN INSTRUMENT line in every fresh clone)");

    check("107", "CORRUPT regression lock: the ALL-UNPARSEABLE branch keeps its OWN message, not the refused one",
      (() => {
        const v = L.assessSessionVolume([], undefined, 7);
        const line = L.formatSessionVolumeAdvisory(v);
        return v.corrupt === true && v.corrupt_kind === "all-unparseable" &&
          typeof line === "string" && line.includes("not one of its 7 line(s) parsed");
      })(),
      "two different broken instruments, two different sentences — neither may borrow the other's");

    check("108", "CORRUPT named residual: a failure carrying NO `absent` field stays SILENT — a DESIGN call, not a closure",
      (() => {
        // The guard SYNTHESIZES this when the main checkout will not resolve: no read was attempted,
        // so nothing is known about a ledger's absence. Kept silent to avoid a BROKEN INSTRUMENT
        // line on every Stop outside a resolvable checkout. Pinned so the choice stays deliberate.
        const v = L.assessSessionVolume(null, { ok: false, reason: "the main checkout could not be resolved" }, 0);
        return v.corrupt === false && L.formatSessionVolumeAdvisory(v) === null;
      })(),
      "documents an OPEN design call: if this ever flips, it must flip on purpose");

    // ── 21. THE `absent` CLAIM ITSELF (loom#1762 follow-up, CRITICAL B) ─────
    //
    // Cases 103/106/111 pin that `absent` is CARRIED and that the absent case stays silent. They
    // say NOTHING about whether the value is TRUE — they consume the producer's claim rather than
    // testing it, and the producer was wrong. `readSinkFile` reached `absent:true` through
    // `fs.realpathSync(sinkDir)` raising ENOENT, and ENOENT is raised for a DANGLING SYMLINK
    // exactly as for a missing directory. `_deepestExistingAncestor` could not catch it either:
    // it tested presence with `fs.existsSync`, which FOLLOWS the final component and so reports a
    // dangling link as non-existent, walking straight past the attacker's link and answering
    // containment on its parent — which passes.
    //
    // MEASURED end-to-end through the real guard, 14 serial prompts / 0 lanes:
    //     CONTROL honest tree                      -> 2961 bytes of advisory on stderr
    //     ATTACK  dangling symlink at the sink dir ->   18 bytes = {"continue":true}
    // and DURABLY: `mkdirSync(..., {recursive:true})` raises ENOENT against the same link, so the
    // write half can never recreate the directory and every later session re-reports the benign
    // fresh-clone reason forever. The path is gitignored, so `git status` never shows it.
    //
    // THE DISCRIMINATING CONTROL is that the NON-dangling variants were already correct — an
    // existing out-of-tree directory symlink and an out-of-tree sink FILE both refuse with
    // `absent:false`. Only the dangling shape was laundered, which is why no existing case saw it.
    {
      const DANGLE = (name) => path.join(OUT, `no-such-target-${name}`); // never created

      check("112", "ABSENT firing pole: a DANGLING sink-directory symlink is NOT absent — it REFUSES and speaks",
        (() => {
          const S = "fx-dangling-dir";
          const p = LSINK(S);
          fs.rmSync(path.dirname(p), { recursive: true, force: true });
          fs.mkdirSync(path.dirname(path.dirname(p)), { recursive: true });
          fs.symlinkSync(DANGLE(S), path.dirname(p));
          const r = LEDGER.readLedger({ repoDir: tmp, sessionId: S });
          const v = L.assessSessionVolume(null, r, 0);
          // restore so later cases in this block get a real directory back
          fs.unlinkSync(path.dirname(p));
          fs.mkdirSync(path.dirname(p), { recursive: true });
          // NOT absent, and the arm must call it a BROKEN INSTRUMENT rather than stay silent.
          return r.ok === false && r.absent === false && v.corrupt === true;
        })(),
        "a planted link must never be laundered into the one disposition callers stay SILENT about",
        "M-B3: restore `fs.existsSync` in the ancestor walk AND the bare `absent:true` ENOENT branch");

      check("113", "ABSENT quiet pole: a GENUINELY missing sink directory is still `absent:true` and still SILENT",
        (() => {
          const S = "fx-genuinely-missing";
          const p = LSINK(S);
          fs.rmSync(path.dirname(p), { recursive: true, force: true });
          const r = LEDGER.readLedger({ repoDir: tmp, sessionId: S });
          const v = L.assessSessionVolume(null, r, 0);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          // This is the pole that stops 112 passing against "never report absent again", which
          // would put a BROKEN INSTRUMENT line in every fresh clone and every CI run.
          return r.ok === false && r.absent === true && v.corrupt === false;
        })(),
        "the fresh-clone / CI case must survive the narrowing — refusing everything is not a fix",
        "M-Bwide: make the ENOENT branch refuse unconditionally instead of lstat-discriminating");

      check("114", "ABSENT: a dangling symlink at an ANCESTOR is refused too — not only at the sink directory",
        (() => {
          const anc = path.join(tmp, ".claude", "learning", "fx-dangling-ancestor");
          fs.symlinkSync(DANGLE("anc"), anc);
          const r = AS.readSinkFile({
            repoDir: tmp, sinkPath: path.join(anc, "deeper", "s.jsonl"), maxBytes: 4096,
          });
          fs.unlinkSync(anc);
          // The `lstat(sinkDir)` half CANNOT see this: lstat of `<dangling>/deeper` raises ENOENT,
          // indistinguishable from absent. Only the ancestor walk's `_lexistsSync` catches it,
          // which is why the fix is there and not only on the ENOENT branch.
          return r.ok === false && r.absent === false && /DANGLING symlink/.test(r.reason);
        })(),
        "the wider class: an lstat-on-the-sink-dir-only fix leaves every ancestor laundered",
        "M-B1: restore `fs.existsSync` in `_deepestExistingAncestor`");

      check("115", "ABSENT residual: the TOCTOU-race branch also refuses, driven by a lying resolver",
        (() => {
          const S = "fx-dangling-race";
          const p = LSINK(S);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, ROW(S));
          const evil = path.join(tmp, ".claude", "learning", "fx-raced-link");
          try { fs.unlinkSync(evil); } catch {}
          fs.symlinkSync(DANGLE("race"), evil);
          const dir = path.dirname(p);
          // A link planted BETWEEN the ancestor resolve and the sink-directory resolve is not
          // reproducible by racing, so it is driven deterministically — the same lying-instrument
          // technique case 101 uses for the stat.
          const realRp = fs.realpathSync, realLs = fs.lstatSync, realRl = fs.readlinkSync;
          let seen = 0;
          fs.realpathSync = (q, ...rest) => {
            if (String(q) === dir && ++seen >= 2) { const e = new Error("ENOENT: raced"); e.code = "ENOENT"; throw e; }
            return realRp.call(fs, q, ...rest);
          };
          fs.lstatSync = (q, ...rest) => realLs.call(fs, String(q) === dir ? evil : q, ...rest);
          fs.readlinkSync = (q, ...rest) => realRl.call(fs, String(q) === dir ? evil : q, ...rest);
          let r;
          try { r = AS.readSinkFile({ repoDir: tmp, sinkPath: p, maxBytes: 4096 }); }
          finally { fs.realpathSync = realRp; fs.lstatSync = realLs; fs.readlinkSync = realRl; }
          fs.unlinkSync(evil);
          return r.ok === false && r.absent === false && /DANGLING symlink/.test(r.reason);
        })(),
        "narrow, but the difference between refusing the race and laundering it",
        "M-B2: restore the bare `absent:true` on the sink-directory ENOENT branch");

      // ── the ALLOCATION regression the first read-half fix introduced ──────
      //
      // The fix allocated `maxBytes + 1` UNCONDITIONALLY. MEASURED: a 125-byte ledger allocated
      // 4,194,305 bytes. Two hooks read that ledger per `Stop` plus 256 KiB per marker read, so
      // the honest steady state went from kilobytes to ~8 MiB per turn — on the shutdown path,
      // which is what the CRITICAL it fixed was about. Sizing against the stat is safe ONLY while
      // the stat cannot become a BOUND, so 118 re-pins the bound under a lying stat.
      const allocPeak = (fn) => {
        const real = Buffer.allocUnsafe;
        let peak = 0;
        Buffer.allocUnsafe = (n) => { if (n > peak) peak = n; return real.call(Buffer, n); };
        try { fn(); } finally { Buffer.allocUnsafe = real; }
        return peak;
      };

      check("117", "ALLOC firing pole: a small ledger allocates against its SIZE, not against the cap",
        (() => {
          const S = "fx-alloc-small";
          const p = LSINK(S);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, "x".repeat(125));
          let r = null;
          const peak = allocPeak(() => { r = AS.readSinkFile({ repoDir: tmp, sinkPath: p, maxBytes: LEDGER.MAX_LEDGER_BYTES }); });
          // The floor is an ALLOCATION floor, so the assertion is "far below the cap", not an exact
          // literal — a case pinned to 8192 would red on any future floor change that is fine.
          return r.ok === true && r.bytes === 125 && peak < LEDGER.MAX_LEDGER_BYTES / 8;
        })(),
        "the pre-regression read allocated 4,194,305 bytes for 125 bytes of ledger, twice per Stop",
        "M-C1: restore the unconditional `Buffer.allocUnsafe(maxBytes + 1)`");

      check("118", "ALLOC quiet pole: the CAP still bounds BYTES CONSUMED when the file grows MID-READ",
        (() => {
          const S = "fx-alloc-race";
          const p = LSINK(S);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          const CAPB = LEDGER.MAX_LEDGER_BYTES;
          fs.writeFileSync(p, "x".repeat(125));
          const realRead = fs.readSync;
          let grew = false, consumed = 0, reads = 0;
          // THE WRITER RUNS ON THE FIRST `read(2)` — AFTER the sizing stat, which is the only
          // window that exercises anything. Hooking `fstatSync` instead does NOT work and the
          // first draft of this case did exactly that: `captureDirIdentity` and
          // `reconcileFdIdentity` each fstat BEFORE `readSinkFile` sizes its buffer, so the growth
          // landed ahead of the sizing stat, the allocator saw the already-4 MB file, and the read
          // completed in ONE syscall having never touched the grow path. MEASURED at that draft:
          // `reads: 1, consumed: 4194305` — the case passed while testing nothing it named, and
          // BOTH allocation mutations came back with an empty red-set because of it. `reads > 1`
          // below is the reach proof carried INSIDE the assertion so the same blindness cannot
          // return silently.
          fs.readSync = (...args) => {
            if (!grew) { grew = true; fs.writeFileSync(p, "y".repeat(CAPB + 5000)); }
            const n = realRead.apply(fs, args);
            reads++;
            if (n > 0) consumed += n;
            return n;
          };
          let r;
          try { r = AS.readSinkFile({ repoDir: tmp, sinkPath: p, maxBytes: CAPB }); }
          finally { fs.readSync = realRead; }
          return grew && reads > 1 && r.ok === false && r.overCap === true && consumed <= CAPB + 1;
        })(),
        "sizing the ALLOCATION from the stat must never turn the stat back into the BOUND",
        "M-C2 / M-C3: size from the stat with no grow step — the read stops short and returns ok:true");

      check("119", "ALLOC: a file LARGER than the allocation floor is still read in FULL — growth is not truncation",
        (() => {
          const S = "fx-alloc-grow";
          const p = LSINK(S);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          const big = 300 * 1024;
          fs.writeFileSync(p, "z".repeat(big));
          const r = AS.readSinkFile({ repoDir: tmp, sinkPath: p, maxBytes: LEDGER.MAX_LEDGER_BYTES });
          return r.ok === true && r.bytes === big && r.text.length === big;
        })(),
        "a grow loop that stopped at the floor would silently truncate every ledger past 8 KiB",
        "M-C3: drop the grow step — the read returns only the first chunk");
    }

    // ── 22. THE FOUR UNPINNED REFUSAL BRANCHES IN `readSinkFile` (2026-09-01) ─
    //
    // A Tier-1 round mutated each of these and this suite stayed 126-GREEN. Two of them REOPEN the
    // CRITICAL class the read half exists to close, so a green suite across them was evidence about
    // the SUITE, not about the code — the fifth consecutive time on this branch, which is why the
    // header states it as a standing property.
    //
    // Every case below plants the OUT-OF-TREE or NON-REGULAR content that a disabled check would
    // hand back, so a mutation does not merely change a reason string: it changes WHOSE BYTES
    // answer a question about this repository.
    {
      // A throwaway root PER SHAPE. The shared `tmp` already carries a real `.claude/learning`
      // that later cases depend on, and these cases replace that directory with a symlink.
      const mkroot = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `delegation-default-${tag}-`));

      // (a) ANCESTOR CONTAINMENT — the FIRST `containment failed` refusal, and the one the module
      // header calls "the ordering lesson from the #1228 fix". It had ZERO read-side coverage: the
      // pre-existing symlink cases (95, 104, 109, 110) all link the FINAL component, which
      // `O_NOFOLLOW` refuses at open time, so every one of them stayed green with this branch gone.
      // The ancestor shape is the one `O_NOFOLLOW` cannot see — the sink directory is a REAL
      // directory inside the attacker's tree, and nothing about the final component is unusual.
      check("120", "ANCESTOR CONTAINMENT firing pole: an out-of-tree `.claude/learning` symlink is REFUSED, so attacker bytes never answer",
        (() => {
          const root = mkroot("anc-firing");
          const evil = path.join(OUT, "attacker-learning");
          fs.mkdirSync(path.join(evil, "delegation-default"), { recursive: true });
          const sink = path.join(root, ".claude", "learning", "delegation-default", "s.jsonl");
          // The bytes a disabled check hands back: a real, in-root-LOOKING, parseable row.
          fs.writeFileSync(path.join(evil, "delegation-default", "s.jsonl"),
            JSON.stringify({ kind: "declared", planted: "by-the-attacker" }) + "\n");
          fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
          fs.symlinkSync(evil, path.join(root, ".claude", "learning"));
          const r = AS.readSinkFile({ repoDir: root, sinkPath: sink, maxBytes: 4096 });
          fs.rmSync(root, { recursive: true, force: true });
          // REACH PROOF carried inside the assertion: the planted file IS readable by a naive read,
          // so a green here cannot come from the file being missing.
          return r.ok === false && r.absent === false && r.error === "containment failed" &&
            /sink ancestor resolves to/.test(r.reason) && r.text === undefined;
        })(),
        "the sink dir is a REAL directory inside the attacker's tree — O_NOFOLLOW sees nothing wrong",
        "M-D1: drop the ANCESTOR `containment failed` refusal from `readSinkFile`");

      check("121", "ANCESTOR CONTAINMENT quiet pole: the SAME path under an HONEST ancestor reads every byte",
        (() => {
          const root = mkroot("anc-quiet");
          const sink = path.join(root, ".claude", "learning", "delegation-default", "s.jsonl");
          fs.mkdirSync(path.dirname(sink), { recursive: true });
          const row = JSON.stringify({ kind: "declared", honest: true }) + "\n";
          fs.writeFileSync(sink, row);
          const r = AS.readSinkFile({ repoDir: root, sinkPath: sink, maxBytes: 4096 });
          fs.rmSync(root, { recursive: true, force: true });
          // Without this pole, 120 passes identically against a `readSinkFile` that refuses
          // EVERYTHING — which would silently disarm the marker dedupe and every ledger read.
          return r.ok === true && r.text === row && r.bytes === row.length;
        })(),
        "a containment fix that refuses the ordinary case is not a fix — it is the opposite failure");

      // (b) SINK-DIRECTORY CONTAINMENT — the SECOND `containment failed` refusal. It is NOT
      // reachable by planting, and that is exactly why it was unpinned: `_deepestExistingAncestor`
      // returns the sink directory ITSELF whenever a name is there, so the ancestor resolve and
      // this one see the same path and (a) refuses first. What is left for this branch is the
      // RACE — a swap landing between the two resolves — which is driven deterministically by a
      // lying resolver, the same technique cases 101 and 115 use, because racing it is not
      // reproducible.
      const lyingSecondResolve = (dir, out) => {
        const real = fs.realpathSync;
        let seen = 0;
        fs.realpathSync = (q, ...rest) => {
          if (String(q) === dir && ++seen >= 2) return out;
          return real.call(fs, q, ...rest);
        };
        return () => { fs.realpathSync = real; };
      };

      check("122", "SINK-DIR CONTAINMENT firing pole: a directory swapped BETWEEN the two resolves is refused by the SECOND check",
        (() => {
          const root = mkroot("dir-firing");
          const sink = path.join(root, ".claude", "learning", "delegation-default", "s.jsonl");
          fs.mkdirSync(path.dirname(sink), { recursive: true });
          fs.writeFileSync(sink, JSON.stringify({ kind: "declared" }) + "\n");
          const restore = lyingSecondResolve(path.dirname(sink), fs.realpathSync(OUT));
          let r;
          try { r = AS.readSinkFile({ repoDir: root, sinkPath: sink, maxBytes: 4096 }); }
          finally { restore(); }
          fs.rmSync(root, { recursive: true, force: true });
          return r.ok === false && r.absent === false && r.error === "containment failed" &&
            /sink directory resolves to/.test(r.reason);
        })(),
        "the ancestor check cannot see this: it resolved the same path one syscall earlier and it was honest",
        "M-D2: drop the SINK-DIRECTORY `containment failed` refusal from `readSinkFile`");

      check("123", "SINK-DIR CONTAINMENT quiet pole: the SAME seam with an HONEST second resolve reads normally",
        (() => {
          // The positive control on the INSTRUMENT (`instrument-discipline.md` MUST-3(a)): without
          // it, 122's refusal is equally consistent with "the hook itself broke the read".
          const root = mkroot("dir-quiet");
          const sink = path.join(root, ".claude", "learning", "delegation-default", "s.jsonl");
          fs.mkdirSync(path.dirname(sink), { recursive: true });
          const row = JSON.stringify({ kind: "declared" }) + "\n";
          fs.writeFileSync(sink, row);
          const dir = path.dirname(sink);
          const restore = lyingSecondResolve(dir, fs.realpathSync(dir));
          let r;
          try { r = AS.readSinkFile({ repoDir: root, sinkPath: sink, maxBytes: 4096 }); }
          finally { restore(); }
          fs.rmSync(root, { recursive: true, force: true });
          return r.ok === true && r.text === row;
        })(),
        "the seam fires and returns the OTHER answer, so 122 measures the check and not the hook");

      // (c) `!st.isFile()` — the FIFO door into the SILENT class. `O_NOFOLLOW` refuses SYMLINKS,
      // not FIFOs, and `O_NONBLOCK` (defense 5) means the open SUCCEEDS instead of hanging — so
      // without this branch the read reaches a pipe with no writer, gets EOF on the first
      // `read(2)`, and returns `{ok:true, bytes:0}`. MEASURED with the branch disabled: a ledger
      // read returns `{"ok":true,"rows":0,"skipped":0}` — BYTE-IDENTICAL to a well-delegating
      // session. That is the same silent-clean class as CRITICAL 1, reached through a different door.
      const mkfifoAt = (p) => {
        try { fs.unlinkSync(p); } catch {}
        execFileSync("mkfifo", [p]);
        return fs.lstatSync(p).isFIFO(); // REACH PROOF: the shape under test actually exists
      };

      check("124", "NOT-A-REGULAR-FILE firing pole: a FIFO planted at the sink is REFUSED, not read as an empty file",
        (() => {
          const root = mkroot("fifo-firing");
          const sink = path.join(root, ".claude", "learning", "delegation-default", "s.jsonl");
          fs.mkdirSync(path.dirname(sink), { recursive: true });
          const planted = mkfifoAt(sink);
          const r = AS.readSinkFile({ repoDir: root, sinkPath: sink, maxBytes: 4096 });
          fs.rmSync(root, { recursive: true, force: true });
          return planted && r.ok === false && r.absent === false &&
            r.error === "not a regular file" && r.overCap === false;
        })(),
        "with the branch gone this returns ok:true/bytes:0 — indistinguishable from a clean session",
        "M-D4: drop the `!st.isFile()` refusal from `readSinkFile`");

      check("125", "NOT-A-REGULAR-FILE quiet pole: an ordinary regular file at the SAME path still reads",
        (() => {
          const root = mkroot("fifo-quiet");
          const sink = path.join(root, ".claude", "learning", "delegation-default", "s.jsonl");
          fs.mkdirSync(path.dirname(sink), { recursive: true });
          const row = JSON.stringify({ kind: "declared" }) + "\n";
          fs.writeFileSync(sink, row);
          const r = AS.readSinkFile({ repoDir: root, sinkPath: sink, maxBytes: 4096 });
          fs.rmSync(root, { recursive: true, force: true });
          return r.ok === true && r.text === row;
        })(),
        "the refusal is scoped to the non-regular shape — it does not refuse the sink it exists to read");

      // ── 23. THE MARKER'S FAIL-OPEN DIRECTION, for EVERY refusal sub-case ────
      //
      // `alreadySurfaced` maps EVERY refusal to `false` (emit the advisory) on purpose: a lost
      // dedupe costs one repeated line, a wrongly-honoured marker costs the whole finding. That
      // direction was pinned for exactly TWO sub-cases — symlink (95) and hard link (97). MEASURED
      // with the branch mutated to `return r.overCap === true;`, this suite stayed green while a
      // 262,300-byte marker flipped `alreadySurfaced` false -> TRUE and SUPPRESSED the advisory
      // PERMANENTLY (the marker never shrinks, so every later session is silenced too).
      //
      // Each case below plants a marker whose CONTENT WOULD SUPPRESS if it were honoured, so the
      // assertion is about the DIRECTION and not about the marker being empty.
      {
        const SIGX = "ADVISE:7:0";
        const suppressing = JSON.stringify({ sig: SIGX, ts: "planted" }) + "\n";
        const mkmarker = (tag) => {
          const root = mkroot(`fo-${tag}`);
          const mp = L.markerPath(root, "fx-failopen");
          fs.mkdirSync(path.dirname(mp), { recursive: true });
          return { root, mp };
        };

        check("126", "MARKER FAIL-OPEN: an OVER-CAP marker does NOT suppress",
          (() => {
            const { root, mp } = mkmarker("overcap");
            // Cap + 1 by construction, with a genuinely-matching row at the front so an honoured
            // read WOULD suppress. MEASURED shape of the mutation that motivated this case.
            fs.writeFileSync(mp, suppressing + "x".repeat(L.MAX_MARKER_BYTES + 1));
            const over = fs.statSync(mp).size > L.MAX_MARKER_BYTES; // REACH PROOF
            const got = L.alreadySurfaced(root, "fx-failopen", SIGX);
            fs.rmSync(root, { recursive: true, force: true });
            return over && got === false;
          })(),
          "an over-cap marker that suppressed would silence this detector for the life of the session",
          "M-E1: `alreadySurfaced`'s `if (!r.ok) return false;` -> `return r.overCap === true;`");

        check("127", "MARKER FAIL-OPEN: a CONTAINMENT-FAILED marker does NOT suppress",
          (() => {
            const root = mkroot("fo-cont");
            const evil = path.join(OUT, "attacker-markers");
            const mp = L.markerPath(root, "fx-failopen");
            fs.mkdirSync(path.join(evil, "delegation-default"), { recursive: true });
            // The attacker's file sits at exactly the basename the marker read will ask for.
            fs.writeFileSync(path.join(evil, "delegation-default", path.basename(mp)), suppressing);
            fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
            fs.symlinkSync(evil, path.join(root, ".claude", "learning"));
            const got = L.alreadySurfaced(root, "fx-failopen", SIGX);
            fs.rmSync(root, { recursive: true, force: true });
            return got === false;
          })(),
          "an out-of-tree marker honoured as a dedupe is CRITICAL 1 with the ancestor as the door",
          "M-E2: `alreadySurfaced`'s `if (!r.ok) return false;` -> `return r.absent !== true;`");

        check("128", "MARKER FAIL-OPEN: a NOT-A-REGULAR-FILE marker does NOT suppress",
          (() => {
            const { root, mp } = mkmarker("fifo");
            const planted = mkfifoAt(mp);
            const got = L.alreadySurfaced(root, "fx-failopen", SIGX);
            fs.rmSync(root, { recursive: true, force: true });
            return planted && got === false;
          })(),
          "the FIFO door must land on the EMIT side of the dedupe, not the suppress side",
          "M-E2 (see 127)");

        check("129", "MARKER FAIL-OPEN: an IDENTITY-MISMATCHED marker does NOT suppress",
          (() => {
            const { root, mp } = mkmarker("ident");
            fs.writeFileSync(mp, suppressing);
            // A directory swap between the containment check and the open is not reproducible by
            // racing, so `reconcileFdIdentity`'s path compare is forged deterministically: its
            // `lstat` of `<realSinkDir>/<basename>` is pointed at a DIFFERENT inode, exactly what a
            // completed swap looks like from inside the reconcile.
            const decoy = path.join(root, "decoy.jsonl");
            fs.writeFileSync(decoy, suppressing);
            const base = path.basename(mp);
            const realLs = fs.lstatSync;
            fs.lstatSync = (q, ...rest) =>
              realLs.call(fs, String(q).endsWith(base) ? decoy : q, ...rest);
            let got;
            try { got = L.alreadySurfaced(root, "fx-failopen", SIGX); }
            finally { fs.lstatSync = realLs; }
            fs.rmSync(root, { recursive: true, force: true });
            return got === false;
          })(),
          "a forged path compare is how defense 6 is defeated — the dedupe must not honour its result",
          "M-E2 (see 127)");

        check("130", "MARKER FAIL-OPEN: an OPEN-FAILED marker does NOT suppress",
          (() => {
            const { root, mp } = mkmarker("openfail");
            fs.writeFileSync(mp, suppressing);
            // EACCES is driven rather than produced by `chmod 000`, so the case does not silently
            // become vacuous when the runner happens to be root.
            const realOpen = fs.openSync;
            let fired = false;
            fs.openSync = (q, ...rest) => {
              if (String(q) === mp) { fired = true; const e = new Error("EACCES: permission denied"); e.code = "EACCES"; throw e; }
              return realOpen.call(fs, q, ...rest);
            };
            let got;
            try { got = L.alreadySurfaced(root, "fx-failopen", SIGX); }
            finally { fs.openSync = realOpen; }
            fs.rmSync(root, { recursive: true, force: true });
            return fired && got === false; // `fired` is the reach proof
          })(),
          "an unreadable marker is a marker we do not honour — the same direction as every other refusal",
          "M-E2 (see 127)");

        check("131", "MARKER FAIL-OPEN quiet pole: a marker that READS still suppresses, and still discriminates",
          (() => {
            // The pole that stops the whole group being satisfiable by `return false` — which is
            // M-z2, already measured as reddening 35/40/69/81/84/91/96/98. Scoped here so this
            // group carries its own bipolar pair rather than borrowing one twelve cases away.
            const { root } = mkmarker("honest");
            const ok = L.markSurfaced(root, "fx-failopen", SIGX, new Date().toISOString()).ok === true;
            const same = L.alreadySurfaced(root, "fx-failopen", SIGX);
            const other = L.alreadySurfaced(root, "fx-failopen", "ADVISE:9:0");
            fs.rmSync(root, { recursive: true, force: true });
            return ok && same === true && other === false;
          })(),
          "fail-open on REFUSAL is not fail-open on SUCCESS — the round trip has to keep working");
      }

      // ── 24. THE LEDGER'S FAIL-CLOSED DIRECTION, symmetrically ───────────────
      //
      // `readLedger` maps `absent: r.absent === true` — so every refusal that is NOT a genuine
      // absence carries `absent:false`, reaches `assessSessionVolume`'s `readRefused` predicate,
      // and SPEAKS as a BROKEN INSTRUMENT. MEASURED with that widened to also accept
      // `r.error === "not a regular file"` (or `"containment failed"`), this suite stayed green
      // while the hook went 408 B -> 0 B end-to-end: the refusal was laundered into the one
      // disposition callers are contracted to stay silent about, restoring the exact silence
      // CRITICAL 2 was about. Cases 104 and 112 pin the symlink and dangling-link doors; these
      // two pin the doors that were open.
      {
        const rootFor = (tag, plant) => {
          const root = mkroot(`fc-${tag}`);
          const p = LEDGER._sinkPath(root, "fx-failclosed");
          fs.mkdirSync(path.dirname(p), { recursive: true });
          const reached = plant(root, p);
          const r = LEDGER.readLedger({ repoDir: root, sessionId: "fx-failclosed" });
          const v = L.assessSessionVolume(null, r, 0);
          const spoke = L.formatSessionVolumeAdvisory(v);
          fs.rmSync(root, { recursive: true, force: true });
          return { reached, r, v, spoke };
        };

        check("132", "LEDGER FAIL-CLOSED: a NOT-A-REGULAR-FILE ledger is NOT absent — it is a BROKEN INSTRUMENT and SPEAKS",
          (() => {
            const { reached, r, v, spoke } = rootFor("fifo", (_root, p) => mkfifoAt(p));
            return reached && r.ok === false && r.absent === false && r.overCap === false &&
              v.corrupt === true && v.corrupt_kind === "read-refused" && typeof spoke === "string" &&
              spoke.length > 0;
          })(),
          "laundering this into `absent` restores the silence CRITICAL 2 was about (measured 408 B -> 0 B)",
          "M-F1: widen `absent:` to accept `r.error === \"not a regular file\"`");

        check("133", "LEDGER FAIL-CLOSED: a CONTAINMENT-FAILED ledger is NOT absent — it SPEAKS too",
          (() => {
            const root = mkroot("fc-cont");
            const evil = path.join(OUT, "attacker-ledgers");
            const p = LEDGER._sinkPath(root, "fx-failclosed");
            fs.mkdirSync(path.join(evil, path.basename(path.dirname(p))), { recursive: true });
            fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
            fs.symlinkSync(evil, path.join(root, ".claude", "learning"));
            const r = LEDGER.readLedger({ repoDir: root, sessionId: "fx-failclosed" });
            const v = L.assessSessionVolume(null, r, 0);
            const spoke = L.formatSessionVolumeAdvisory(v);
            fs.rmSync(root, { recursive: true, force: true });
            return r.ok === false && r.absent === false && v.corrupt === true &&
              typeof spoke === "string" && spoke.length > 0;
          })(),
          "an out-of-tree ancestor is a refusal, never an absence",
          "M-F2: widen `absent:` to accept `r.error === \"containment failed\"`");

        check("134", "LEDGER FAIL-CLOSED quiet pole: a GENUINELY absent ledger is STILL absent, and STILL silent",
          (() => {
            const root = mkroot("fc-absent");
            const r = LEDGER.readLedger({ repoDir: root, sessionId: "fx-failclosed" });
            const v = L.assessSessionVolume(null, r, 0);
            const spoke = L.formatSessionVolumeAdvisory(v);
            fs.rmSync(root, { recursive: true, force: true });
            // The pole that stops 132/133 being satisfiable by "nothing is ever absent" — which
            // would put a BROKEN INSTRUMENT line in every fresh clone and every CI run.
            return r.ok === false && r.absent === true && v.corrupt === false && spoke === null;
          })(),
          "the fail-closed direction is scoped to REFUSALS — absence keeps its silence");
      }

      // ── 25. THE CORRUPT/ABSENT PARTITION — three shapes scored CLEAN that are not ─
      //
      // MEASURED before the fix: a whitespace-only sink, a ZERO-BYTE sink and a spaces-with-no-
      // newline sink each produced `rows=0, skipped=0` and therefore SILENCE, while an
      // all-unparseable sink and an unknown-`kind` sink correctly produced a BROKEN INSTRUMENT.
      // Root cause: `readLedger`'s blank-line `continue` skipped WITHOUT counting, so the
      // downstream `prompts === 0 && skipped > 0` partition could never see them.
      //
      // The zero-byte shape is the WRITE half's own residue (`appendSinkLine` opens `O_CREAT` and
      // then refuses on several post-open checks), so the module that produces this input is the
      // one whose reader scored it clean.
      {
        const partition = (tag, bytes) => {
          const root = mkroot(`part-${tag}`);
          const p = LEDGER._sinkPath(root, "fx-partition");
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, bytes);
          const wrote = fs.statSync(p).size === Buffer.byteLength(bytes); // REACH PROOF
          const r = LEDGER.readLedger({ repoDir: root, sessionId: "fx-partition" });
          const v = L.assessSessionVolume(r.ok ? r.rows : null, r.ok ? undefined : r, r.ok ? r.skipped : 0);
          const spoke = L.formatSessionVolumeAdvisory(v);
          fs.rmSync(root, { recursive: true, force: true });
          return { wrote, r, v, spoke };
        };
        const broken = (o) =>
          o.wrote && o.r.ok === true && o.r.rows.length === 0 && o.r.skipped > 0 &&
          o.v.state === "UNKNOWN" && o.v.corrupt === true &&
          typeof o.spoke === "string" && o.spoke.length > 0;

        check("135", "PARTITION firing pole: a ZERO-BYTE ledger is a BROKEN INSTRUMENT, not a clean session",
          broken(partition("zero", "")),
          "a torn create is the write half's own residue — it must not score as well-delegating",
          "M-G1: restore the uncounted blank-line `continue` in `readLedger`");

        check("136", "PARTITION firing pole: a WHITESPACE-ONLY ledger is a BROKEN INSTRUMENT",
          broken(partition("ws", "   \n\t\n  \n")),
          "rows=0/skipped=0 rendered byte-identically to a session that dispatched every lane",
          "M-G1 (see 135)");

        check("137", "PARTITION firing pole: SPACES WITH NO TRAILING NEWLINE is a BROKEN INSTRUMENT",
          broken(partition("nonl", "   ")),
          "the no-terminator variant is the one a naive `endsWith` fix would leave behind",
          "M-G1 (see 135)");

        check("138", "PARTITION quiet pole: the TRAILING-NEWLINE ARTIFACT is not a blank line — an honest ledger is skipped===0",
          (() => {
            // THE CONSTRAINT THAT MAKES THE FIX NON-TRIVIAL. JSONL terminates every row, so
            // `"row\n".split("\n")` yields a final "" that belongs to the TERMINATOR. Counting it
            // reds case 100 (and this one), which is correct behaviour, not a case to be relaxed.
            const root = mkroot("part-honest");
            const p = LEDGER._sinkPath(root, "fx-partition");
            fs.mkdirSync(path.dirname(p), { recursive: true });
            const row = (i) => JSON.stringify({ kind: "declared", session_id: "fx-partition", generation: LEDGER.MAIN_GENERATION, declared_subparts: i }) + "\n";
            fs.writeFileSync(p, row(0) + row(1) + row(2));
            const clean = LEDGER.readLedger({ repoDir: root, sessionId: "fx-partition" });
            // ...and a blank line BETWEEN rows is real residue: counted, without losing the rows.
            fs.writeFileSync(p, row(0) + "\n" + row(1));
            const torn = LEDGER.readLedger({ repoDir: root, sessionId: "fx-partition" });
            fs.rmSync(root, { recursive: true, force: true });
            return clean.ok === true && clean.rows.length === 3 && clean.skipped === 0 &&
              torn.ok === true && torn.rows.length === 2 && torn.skipped === 1;
          })(),
          "both halves at once: the terminator is free, an interior blank line is not",
          "M-G2: count EVERY blank line, including the trailing-newline artifact");
      }

      // ── 26. THE DERIVE COMMAND THAT MATCHED ITSELF ──────────────────────────
      //
      // `delegation-default.js`'s CALIBRATION NOTE tells the reader to derive the number of
      // advising arms rather than trust the prose. MEASURED 2026-09-01, the command it shipped —
      // `grep -c 'state: "ADVISE"' delegation-default.js` — returned 4 against 3 real arms,
      // because the INSTRUCTION quoting the pattern is itself a hit. An instruction that cannot
      // return the right answer is worse than no instruction: it hands a wrong number to a reader
      // who was told to trust it over the prose.
      {
        const SRC = fs.readFileSync(path.join(REPO, ".claude/hooks/lib/delegation-default.js"), "utf8");
        const lines = SRC.split("\n");
        const anchored = lines.filter((l) => /^ *state: "ADVISE",$/.test(l));
        const unanchored = lines.filter((l) => /state: "ADVISE"/.test(l));

        // READ THE HITS, NOT THE TALLY (`instrument-discipline.md` MUST-3(b)). A "none of these
        // is a comment" clause was DRAFTED here and REMOVED: the anchored pattern requires the
        // line to begin with spaces then `state:`, and a comment continuation begins with ` *`, so
        // that clause could not have returned the other answer — it was a non-discriminating
        // sub-assertion inside a case about non-discriminating instruments. What replaces it reads
        // each hit IN CONTEXT: an arm is a property of a verdict object literal, so the `return {`
        // that opens it must be within a few lines above.
        const inReturnLiteral = (i) => {
          for (let k = i; k >= Math.max(0, i - 6); k--) if (/^\s*return \{$/.test(lines[k])) return true;
          return false;
        };
        const anchoredIdx = lines.map((l, i) => [l, i]).filter(([l]) => /^ *state: "ADVISE",$/.test(l)).map(([, i]) => i);
        check("139", "DERIVE firing pole: the ANCHORED form finds the three ARMS, each inside a verdict literal",
          anchored.length === 3 && anchoredIdx.every(inReturnLiteral),
          `anchored hits at lines ${anchoredIdx.map((i) => i + 1).join(", ")}, all inside a \`return {\``,
          "M-H1: perturb one arm's spacing so the documented derive command no longer finds it");

        check("140", "DERIVE quiet pole: the UNANCHORED form matches its OWN instruction — the measured defect",
          // The pole that proves the anchor is LOAD-BEARING rather than decorative. If this ever
          // goes false, the prose mentions were removed and the anchor may be reconsidered — it
          // must not be dropped merely because someone re-ran the naive form and liked the number.
          unanchored.length > anchored.length &&
            unanchored.some((l) => /^\s*\*/.test(l)),
          `unanchored hits: ${unanchored.length} vs anchored ${anchored.length}; at least one is prose`,
          "the anchor is what separates the arms from the sentence describing them");
      }
    }

    // ── END-TO-END: the same three defects through the REAL hook ────────────

    // Every case above supplies its own arguments and would pass against a guard that never
    // consults any of it — the inertness class this file already learned twice (M-o, M-y).
    {
      const seedSerialLocal = (session, n) => { for (let i = 0; i < n; i++) seed(session, 0, 0); };

      check("109", "E2E MARKER firing pole: a SYMLINKED marker does NOT suppress the advisory through the real hook",
        (() => {
          const S = "fx-e2e-marker-symlink";
          seedSerialLocal(S, L.SERIAL_RUN_FLOOR);
          // CONTROL FIRST: the finding is genuinely there and the hook speaks it.
          const control = fireCapture(HOOK, tmp, S);
          if (!control.stderr.includes("ZERO lanes across its last")) return false;
          // Now plant the poison marker carrying THIS session's real signature.
          const sig = L.sessionVolumeSignatureOf(
            L.assessSessionVolume(null, undefined, 0) // shape only; real sig read below
          );
          const mp = L.markerPath(tmp, S);
          // the honest marker the control just wrote IS the signature we must poison with
          const honest = fs.readFileSync(mp, "utf8");
          fs.unlinkSync(mp);
          const out = path.join(OUT, `${S}.jsonl`);
          fs.writeFileSync(out, honest);
          fs.symlinkSync(out, mp);
          void sig;
          // Same signature, same session — but the marker is now out of tree, so it must be refused
          // and the advisory must fire AGAIN rather than being suppressed by it.
          const second = fireCapture(HOOK, tmp, S);
          return second.stderr.includes("ZERO lanes across its last") && second.code === 0;
        })(),
        "the dedupe must not be honourable from outside the repository",
        "M-z: route `alreadySurfaced` back through bare fs.statSync + fs.readFileSync");

      check("110", "E2E LEDGER firing pole: a SYMLINKED ledger reports a BROKEN INSTRUMENT, not silence",
        (() => {
          const S = "fx-e2e-ledger-symlink";
          const p = LSINK(S);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          try { fs.unlinkSync(p); } catch {}
          const out = path.join(OUT, `${S}.jsonl`);
          fs.writeFileSync(out, ROW(S).repeat(3));
          fs.symlinkSync(out, p);
          const r = fireCapture(HOOK, tmp, S);
          return r.stderr.includes("BROKEN INSTRUMENT") && r.code === 0;
        })(),
        "an unreadable-for-cause ledger used to render byte-identically to a well-delegating session",
        "M-z7: hard-code `corrupt: false` in the `!Array.isArray(rows)` branch again");

      check("111", "E2E LEDGER quiet pole: an ABSENT ledger STILL emits nothing — the noise rule is intact",
        (() => {
          const r = fireCapture(HOOK, tmp, "fx-e2e-ledger-absent");
          return r.stderr.trim() === "" && r.code === 0;
        })(),
        "the widening in 110 must not have swept the fresh-clone case in with it",
        "M-z8: treat EVERY read failure as corrupt");

      // THE DANGLING-SYMLINK ATTACK, END TO END, BOTH POLES ON ONE TREE. This is the shape the
      // measurement was taken on: a real 14-prompt / 0-lane session, one honest run and one with
      // a link planted at the sink directory. The library cases above cannot see it, because they
      // supply their own `failure` object and so never exercise the guard's own read.
      check("116", "E2E ABSENT firing pole: a DANGLING sink-directory symlink SPEAKS, where an absent one stays silent",
        (() => {
          const S = "fx-e2e-dangling-dir";
          const seedSerial = (session, n) => { for (let i = 0; i < n; i++) seed(session, 0, 0); };
          seedSerial(S, L.SERIAL_RUN_FLOOR + 2);
          // CONTROL 1: the finding is genuinely there on an honest tree.
          const honest = fireCapture(HOOK, tmp, S);
          if (!honest.stderr.includes("ZERO lanes across its last")) return false;
          // Now swap the sink DIRECTORY for a link whose target does not exist. Note the ledger
          // rows are destroyed with it, so the ONLY thing the guard can report is the read
          // verdict — which pre-fix was `absent`, hence 18 bytes of `{"continue":true}`.
          const dir = path.dirname(LSINK(S));
          fs.rmSync(dir, { recursive: true, force: true });
          fs.symlinkSync(path.join(OUT, "no-such-e2e-target"), dir);
          const attacked = fireCapture(HOOK, tmp, S);
          fs.unlinkSync(dir);
          fs.mkdirSync(dir, { recursive: true });
          // CONTROL 2, the OTHER pole on the SAME tree: a session whose ledger is genuinely
          // absent must STILL be silent, so the widening is scoped to the planted link.
          const absent = fireCapture(HOOK, tmp, "fx-e2e-dangling-control-absent");
          return attacked.stderr.includes("BROKEN INSTRUMENT") && attacked.code === 0 &&
            absent.stderr.trim() === "" && absent.code === 0;
        })(),
        "MEASURED pre-fix: honest 2961 bytes of advisory, dangling link 18 bytes — byte-identical to a clean session",
        "M-B3: restore `fs.existsSync` in the ancestor walk AND the bare `absent:true` ENOENT branch");
    }

    fs.rmSync(OUT, { recursive: true, force: true });
  }

  check("42", "ISOLATION: nothing was written under the real repo's .claude/learning",
    !fs.existsSync(path.join(REPO, ".claude/learning/delegation-default")) ||
      fs.readdirSync(path.join(REPO, ".claude/learning/delegation-default")).every((f) => !f.startsWith("fx-")),
    "the fixtures point CLAUDE_PROJECT_DIR at a throwaway repo");

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 26. SESSION IDENTITY (2026-09-01) — the SHARED CONSTANT that made the fence unreachable ──
//
// `appendRecord` keys the sink FILE on the row's own `session_id`, so two sessions pool into one
// file only when both resolve to the SAME id. The no-session fallback was the shared constant
// `"unknown-session"`, restated at FIVE sites, so every id-less session landed in one file — and
// inside it every row AND the reader carried that literal, making `assessSessionVolume`'s fence
// predicate unreachable IN PRINCIPLE. MEASURED two-pole on one tree before these cases were
// written: pre-fix, two id-less hosts produced 1 sink (`unknown-session-86a371a9.jsonl`);
// post-fix, 2. The existing 147 cases were ALL GREEN across that change, which is why this block
// exists.
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-default-identity-"));
  const q = { cwd: t, stdio: "ignore" };
  execFileSync("git", ["init", "-q"], q);
  execFileSync("git", ["-c", "user.email=f@x", "-c", "user.name=f", "commit", "-q", "--allow-empty", "-m", "init"], q);
  const EMIT = path.join(REPO, ".claude/hooks/emit-dispatch-ledger.js");
  const GUARD = path.join(REPO, ".claude/hooks/delegation-default-guard.js");
  // The runner's own `rawFire` inherits `process.env` wholesale, which on a real host carries
  // `CLAUDE_CODE_SESSION_ID` — rung 2 of the resolution. A case about rung 3 that inherited it
  // would silently test rung 2 instead and pass for the wrong reason, so the anonymous cases fire
  // with BOTH host spellings scrubbed and a pinned `CLAUDE_PID`.
  const anonEnv = (hostPid, extra) => {
    const e = { ...process.env, CLAUDE_PROJECT_DIR: t, CLAUDE_PID: String(hostPid), ...(extra || {}) };
    delete e.CLAUDE_CODE_SESSION_ID;
    delete e.CLAUDE_SESSION_ID;
    return e;
  };
  const fireIn = (hook, input, env) =>
    (() => {
      const r = spawnSync("node", [hook], { input, encoding: "utf8", env });
      return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status == null ? -1 : r.status };
    })();
  const promptPayload = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    prompt: "do these:\n- alpha\n- beta\n- gamma\n",
  });
  const launchPayload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: { description: "lane", subagent_type: "analyst", prompt: "x" },
  });
  const stopPayload = JSON.stringify({ hook_event_name: "Stop" });

  // ── the derivation ───────────────────────────────────────────────────────
  check("141", "IDENTITY firing pole: two DIFFERENT hosts with no session_id derive DIFFERENT ids",
    LEDGER.anonymousSessionId({ hostPid: "111111", startToken: "T" }) !==
      LEDGER.anonymousSessionId({ hostPid: "222222", startToken: "T" }),
    "the collision was BY DESIGN — one shared constant for every id-less session",
    "M-I1: return the literal `\"unknown-session\"` from anonymousSessionId (both hosts collide again)");
  check("142", "IDENTITY quiet pole: the SAME host derives the SAME id — one session, one sink",
    LEDGER.anonymousSessionId({ hostPid: "111111", startToken: "T" }) ===
      LEDGER.anonymousSessionId({ hostPid: "111111", startToken: "T" }),
    "an id that varied per call would fragment ONE session across many sinks — the opposite defect",
    "M-I2: mix `Math.random()` or `process.hrtime.bigint()` into the hash basis");
  check("143", "IDENTITY firing pole: pid ALONE is not sufficient — a REUSED pid is discriminated",
    LEDGER.anonymousSessionId({ hostPid: "4242", startToken: "Sun 30 Aug 07:05:15 2026" }) !==
      LEDGER.anonymousSessionId({ hostPid: "4242", startToken: "Mon 31 Aug 09:11:02 2026" }),
    "the OS reuses pids; without the start-time component a later session inherits a dead one's history",
    "M-I3: drop `start` from the hash basis (`${hostPid}|` alone) — the two poles collapse");
  check("144", "IDENTITY quiet pole: an EXPLICIT session id is returned VERBATIM, never rewritten",
    LEDGER.resolveSessionId("13a23150-e15f-4571-b237-2e5d07d4ae5c") ===
      "13a23150-e15f-4571-b237-2e5d07d4ae5c",
    "45 of 45 live sinks on this checkout carry a real UUID — the common path must be untouched",
    "M-I4: derive unconditionally, ignoring the explicit argument");
  check("145", "IDENTITY: the ENV rung is read, and it is the MEASURED host variable name",
    (() => {
      const withEnv = LEDGER.resolveSessionId(undefined, { env: { CLAUDE_CODE_SESSION_ID: "S-ENV" } });
      const without = LEDGER.resolveSessionId(undefined, { env: {}, hostPid: "9", startToken: "T" });
      return withEnv === "S-ENV" && without.startsWith(`${LEDGER.ANON_SESSION_PREFIX}-`);
    })(),
    "MEASURED in a Claude-Code-spawned child: CLAUDE_CODE_SESSION_ID=<uuid>, CLAUDE_PID=<host pid>",
    "M-I5: delete the `CLAUDE_CODE_SESSION_ID` rung — a real id present in env falls to rung 3");

  // ── ONE derivation, five sites ───────────────────────────────────────────
  //
  // These three run IN-PROCESS, and this runner inherits the host's real environment — so
  // `CLAUDE_CODE_SESSION_ID` is present and rung 2 answers before rung 3 is ever reached. First
  // written without this scrub, they measured the SITE-SHARING claim against a real UUID and were
  // therefore blind to the anonymous derivation entirely: mutation M-I2 (a per-call random id)
  // left all three GREEN. `withAnonRung` deletes both host spellings for the duration of one case
  // and restores them, so the claim is measured on the rung it is about.
  const withAnonRung = (fn) => {
    const a = process.env.CLAUDE_CODE_SESSION_ID;
    const b = process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    LEDGER._resetAnonSessionMemo();
    try {
      return fn();
    } finally {
      if (a !== undefined) process.env.CLAUDE_CODE_SESSION_ID = a;
      if (b !== undefined) process.env.CLAUDE_SESSION_ID = b;
      LEDGER._resetAnonSessionMemo();
    }
  };
  check("146", "SITES: the record builder and the ledger path mapper agree on the anonymous id",
    withAnonRung(() => {
      // The two are read on the SAME append — `appendRecord` keys the file on the row's own
      // `session_id` — so a disagreement here is a guaranteed write/read split, not a style nit.
      const rec = LEDGER.buildDeclaredRecord({ sessionId: undefined, declaredSubparts: 3 });
      const base = path.basename(LEDGER._sinkPath(t, undefined));
      return base.startsWith(`${rec.session_id}-`);
    }),
    "`_base` and `_sinkPath` each carried their OWN copy of the literal before this change",
    "M-I6: restore `_isNonEmptyString(sessionId) ? sessionId : \"unknown-session\"` in `_base`");
  check("147", "SITES: the dedupe marker mapper shares the derivation with the ledger mapper",
    withAnonRung(() => {
      const id = LEDGER.resolveSessionId(undefined);
      return path.basename(L.markerPath(t, undefined)).startsWith(`${id}-`) &&
        path.basename(LEDGER._sinkPath(t, undefined)).startsWith(`${id}-`);
    }),
    "a marker keyed on the shared constant let the FIRST id-less session's signature suppress every later one",
    "M-I7: restore the literal fallback in `delegation-default.js::markerPath`");
  check("148", "SITES: a WHITESPACE-ONLY id resolves the SAME way at both doors",
    withAnonRung(() => {
      // Pre-fix, `_base` kept "  " while `_sinkPath` fell back to the literal — a row written
      // under one id into a file named for another. The shared function closes it.
      const rec = LEDGER.buildDeclaredRecord({ sessionId: "  ", declaredSubparts: 2 });
      return path.basename(LEDGER._sinkPath(t, "  ")).startsWith(`${rec.session_id}-`);
    }),
    "the two-doors defect, reachable with no attacker",
    "M-I6 also reds this: `_base` keeping the raw whitespace id splits it from `_sinkPath`");
  check("149", "SITES: NO resolution reaches the retired shared constant any more",
    LEDGER.resolveSessionId(undefined) !== LEDGER.LEGACY_ANON_SESSION_ID &&
      LEDGER.resolveSessionId(undefined, { env: {}, hostPid: "7", startToken: "T" }) !==
        LEDGER.LEGACY_ANON_SESSION_ID,
    "the constant survives as a NAME for the legacy sink, never as a resolution target",
    "M-I1 reds this too — a sixth copy of the literal is reachable again");

  // ── the FENCE, end-to-end, through the REAL hooks ────────────────────────
  // This is the brief's measured scenario: session A runs a serial stretch while session B, also
  // id-less, opens ONE lane mid-run. Pre-fix the two pooled and B's lane RESET A's run, silencing
  // a true finding. These fire the real producer and the real guard as child processes.
  //
  // SPAWN BUDGET, and why the shape is what it is. Firing the producer once per prompt would cost
  // ~40 child node processes and took this runner from 6.2s to 24.6s, which is load the whole
  // parallel registry pays. So the producer is fired ONCE per session to establish the identity it
  // actually resolves, that identity is READ BACK off the row it wrote, and the remaining rows are
  // appended in-process under THAT id. Nothing is assumed: the id used for the bulk rows is the
  // producer's own output, not a re-derivation, so the producer/consumer seam is still what is
  // measured.
  const sinkDirOf = () => path.join(t, ".claude/learning/dispatch-reconcile");
  const producerIdentity = (env) => {
    const before = fs.existsSync(sinkDirOf()) ? fs.readdirSync(sinkDirOf()) : [];
    fireIn(EMIT, promptPayload, env);
    const after = fs.readdirSync(sinkDirOf());
    const fresh = after.filter((f) => !before.includes(f));
    if (fresh.length !== 1) return null;
    const first = fs.readFileSync(path.join(sinkDirOf(), fresh[0]), "utf8").trim().split("\n")[0];
    return JSON.parse(first).session_id;
  };
  const seedDeclared = (sid, n) => {
    for (let i = 0; i < n; i++)
      LEDGER.appendRecord({ repoDir: t, record: LEDGER.buildDeclaredRecord({
        sessionId: sid, generation: LEDGER.MAIN_GENERATION, declaredSubparts: 3,
        nowIso: new Date().toISOString() }) });
  };
  {
    const HALF = Math.floor(L.SERIAL_RUN_FLOOR / 2);
    const A = anonEnv(910001);
    const B = anonEnv(920002);
    const idA = producerIdentity(A); // 1 real producer fire; the id comes off its own row
    seedDeclared(idA, HALF - 1);
    fireIn(EMIT, launchPayload, B); // the FOREIGN lane — a real producer fire under a 2nd host
    seedDeclared(idA, L.SERIAL_RUN_FLOOR - HALF);
    const spoke = fireIn(GUARD, stopPayload, A);
    // READ BOTH STREAMS, and that is a correction rather than a convenience. `instruct-and-wait`
    // puts the FULL advisory on stdout as `systemMessage` and only a ~160-char PREVIEW of the
    // FIRST finding on stderr. Here BOTH arms fire, so the preview shows the per-prompt one and a
    // stderr-only assertion reds a GREEN fix — measured: stdout carried the volume text, stderr
    // did not. The pre-existing volume e2e cases assert on stderr and are correct for their own
    // shape, where the per-prompt arm is QUIET and the volume finding IS first.
    const spokeAll = spoke.stderr + spoke.stdout;
    check("150", "FENCE E2E firing pole: a FOREIGN id-less session's lane no longer silences ours",
      idA !== null && idA.startsWith(`${LEDGER.ANON_SESSION_PREFIX}-`) &&
        spokeAll.includes("ZERO lanes across its last") && spoke.code === 0,
      "MEASURED pre-fix on this exact shape: QUIET, run 6 — SILENT; control with ids made distinguishable: ADVISE, run 12",
      "M-I1: the shared constant pools A and B into one sink again — B's launch resets the run to 0");
    // The OTHER pole on the SAME tree: our OWN lane must still reset the run, or the fix would
    // simply have made the arm speak always.
    const C = anonEnv(930003);
    const idC = producerIdentity(C);
    seedDeclared(idC, HALF - 1);
    fireIn(EMIT, launchPayload, C); // OUR lane — same host, so it MUST reset the run
    seedDeclared(idC, L.SERIAL_RUN_FLOOR - HALF);
    const quiet = fireIn(GUARD, stopPayload, C);
    // Same both-streams read as 150. The per-prompt arm DOES still fire here ("ZERO lanes were
    // dispatched for it"), which is a DIFFERENT string from the volume arm's ("ZERO lanes across
    // its last") — so this pole is discriminating, not merely quiet-because-nothing-ran.
    const quietAll = quiet.stderr + quiet.stdout;
    check("151", "FENCE E2E quiet pole: our OWN lane still resets the run — no over-widening",
      !quietAll.includes("ZERO lanes across its last") &&
        quietAll.includes("ZERO lanes were dispatched for it") && quiet.code === 0,
      "the volume arm must stay silent at run=6; a fence that dropped everything would ADVISE always",
      "M-I8: make the fence drop rows whose session_id EQUALS ours (inverted predicate)");
  }

  // ── backward compatibility for the pre-fix POOLED sink ───────────────────
  {
    const legacy = LEDGER.legacyAnonSinkPath(t);
    check("152", "LEGACY: the pre-fix pooled sink is still READABLE at its unchanged path",
      (() => {
        // The filename is MEASURED against the pre-fix writer, not asserted from the new code:
        // running the OLD `emit-dispatch-ledger.js` on a scratch tree produced exactly this name,
        // and one such file exists on this machine under kailash-coc-py. Pinning the literal is
        // the point — a change to the mapping would silently orphan real files on disk.
        if (path.basename(legacy) !== "unknown-session-86a371a9.jsonl") return false;
        fs.mkdirSync(path.dirname(legacy), { recursive: true });
        fs.writeFileSync(legacy, JSON.stringify(
          LEDGER.buildDeclaredRecord({ sessionId: LEDGER.LEGACY_ANON_SESSION_ID, declaredSubparts: 4 })) + "\n");
        const r = LEDGER.readLedger({ repoDir: t, sessionId: LEDGER.LEGACY_ANON_SESSION_ID });
        return r.ok === true && r.rows.length === 1 && r.rows[0].declared_subparts === 4;
      })(),
      "nothing is deleted, moved or rewritten — the old rows stay addressable by name",
      "M-I9: change the sink filename mapping (sanitizer or hash width) — the legacy path stops resolving");
    check("153", "LEGACY quiet pole: it is NOT ADOPTED — a derived session does not inherit the pool",
      (() => {
        // Its rows are a pool of one or more sessions, indistinguishable BY CONSTRUCTION. Handing
        // them to whichever session runs next would import another session's history — the same
        // defect wearing a new name.
        const r = LEDGER.readLedger({ repoDir: t, sessionId: LEDGER.resolveSessionId(undefined, { env: {}, hostPid: "940004", startToken: "T" }) });
        return r.ok === false && r.absent === true;
      })(),
      "the legacy file exists on this tree (case 152 wrote it) and is still not this session's ledger",
      "M-I1: force the shared constant back — the derived id BECOMES the legacy id and the pool is adopted");
    const D = anonEnv(950005);
    const crumb = fireIn(GUARD, stopPayload, D);
    check("154", "LEGACY: non-adoption is NOT SILENT — the guard names the retained file",
      crumb.stderr.includes("legacy-anon-sink") && crumb.stderr.includes("adopted=no") &&
        crumb.stderr.includes(path.basename(legacy)) && crumb.code === 0,
      "a silent orphan and a correctly-empty ledger render identically; this line separates them",
      "M-I11: delete the breadcrumb block from `delegation-default-guard.js`");
    const namedEnv = { ...process.env, CLAUDE_PROJECT_DIR: t };
    const named = fireIn(GUARD, JSON.stringify({ hook_event_name: "Stop", session_id: "fx-legacy-named" }), namedEnv);
    check("155", "LEGACY quiet pole: a session with a REAL id gets no breadcrumb — it is not wallpaper",
      !named.stderr.includes("legacy-anon-sink") && named.code === 0,
      "gated on the derived-anonymous rung, which 45 of 45 live sinks show is the rare path",
      "M-I12: drop the ANON_SESSION_PREFIX gate — every session gets the line every turn");
  }

  check("156", "ISOLATION: the identity block wrote nothing under the real repo's .claude/learning",
    !fs.existsSync(path.join(REPO, ".claude/learning/dispatch-reconcile")) ||
      fs.readdirSync(path.join(REPO, ".claude/learning/dispatch-reconcile"))
        .every((f) => !f.startsWith("unknown-9")),
    "every fire in this block points CLAUDE_PROJECT_DIR at a throwaway repo");

  fs.rmSync(t, { recursive: true, force: true });
}

// ── 27. THE LANE-DEPTH ARM (2026-09-12) — `rules/wip-discipline.md` MUST-9 ──────────────────────
//
// `detectUnderPackedLane` reports a lane `wip-lanes.js::laneDepth` marks UNDER-PACKED while this
// session has no ATTRIBUTED dispatch for it. Bipolar throughout, with IDENTITY assertions
// (`cc-artifacts.md` Rule 9): a firing pole must name THAT lane and not its packed sibling. Library
// cases first, then the REAL guard over real git repositories carrying real lanes and real `lane:`
// bindings, because a library case supplies its own arguments and cannot see the wiring.
//
// CONTAINMENT (worktree-isolation MUST-10): every repository below is its own `mkdtemp` directory,
// resolved and asserted to sit under the OS temp root and outside this checkout BEFORE the first
// git write, and every git call carries `-C <that absolute path>`.
{
  const W = require(path.join(REPO, ".claude/hooks/lib/wip-lanes.js"));
  const GUARD = path.join(REPO, ".claude/hooks/delegation-default-guard.js");
  const SID = "lane-lib-session";
  const decl = (n = 0) => ({ kind: "declared", session_id: SID, generation: LEDGER.MAIN_GENERATION, declared_subparts: n });
  const ln = (extra, id) => ({
    kind: "launch", session_id: SID, generation: LEDGER.MAIN_GENERATION, launch_id: id, dispatch_name: "w", ...extra,
  });
  const UNDER = { lane: "lane/under", items: ["ws/a1"], itemCount: 1, agents: null, verdict: "UNDER-PACKED", why: "u" };
  const PACKED = { lane: "lane/packed", items: ["ws/p1", "ws/p2"], itemCount: 2, agents: null, verdict: "PACKED", why: "p" };
  const Q1 = { id: "ws/q1", rel: "workspaces/ws/todos/active/q1.md", lane: "lane/closed" };
  const DEPTH = (lanes, queued = [Q1]) => ({
    ok: true, lanes, underPacked: lanes.filter((l) => l.verdict === "UNDER-PACKED").map((l) => l.lane), queued,
    unbound: [], unknown: [], counts: { lanes: lanes.length, bound: 0, queued: queued.length, unbound: 0, unmeasured: 0 },
  });
  const detect = (lanes, rows, more = {}) =>
    L.detectUnderPackedLane({ depth: DEPTH(lanes, more.queued), rows, skipped: 0, sessionId: SID, ...more });

  // ── library poles ──────────────────────────────────────────────────────────
  const zero = detect([UNDER, PACKED], [decl()]);
  check("157", "LANE firing pole: an UNDER-PACKED lane with ZERO launches is REPORTED, naming THAT lane only",
    zero.state === "REPORT" && zero.severity === "halt-and-report" &&
      JSON.stringify(zero.lanes.map((l) => l.lane)) === JSON.stringify(["lane/under"]) &&
      zero.lanes[0].attribution === "ZERO" && zero.lanes[0].agents === 0 && zero.lanes[0].zeroKind === "no-launches",
    `state=${zero.state} lanes=${zero.lanes.map((l) => `${l.lane}:${l.attribution}`).join(",")}`,
    "M-L2: consume `verdict !== NOTHING-QUEUED` — the PACKED sibling is named too");
  const attr = detect([UNDER, PACKED], [decl(), ln({ lane: "lane/under" }, "L1")]);
  check("158", "LANE quiet pole: the SAME lane with an attributed dispatch this session is silent",
    attr.state === "QUIET" && attr.suppressed.length === 1 && attr.suppressed[0].lane === "lane/under" &&
      attr.suppressed[0].agents === 1 && L.formatUnderPackedLaneFinding(attr) === null,
    `state=${attr.state} suppressed=${attr.suppressed.map((l) => l.lane)}`,
    "M-L1: report ATTRIBUTED lanes too");
  const sib = detect([UNDER, PACKED], [decl(), ln({ lane: "lane/packed" }, "L1")]);
  check("159", "LANE identity: a dispatch for the PACKED SIBLING does not clear the under-packed lane",
    sib.state === "REPORT" && sib.lanes.length === 1 && sib.lanes[0].lane === "lane/under" &&
      sib.lanes[0].attribution === "ZERO" && sib.lanes[0].zeroKind === "joined",
    `lanes=${sib.lanes.map((l) => `${l.lane}:${l.attribution}:${l.zeroKind}`)}`,
    "a session-wide 'dispatched anything' test would silence this pole");
  const packedOnly = detect([PACKED], [decl()], { queued: [Q1, { ...Q1, id: "ws/q2" }, { ...Q1, id: "ws/q3" }] });
  check("160", "LANE quiet pole: a PACKED lane with items QUEUED is silent",
    packedOnly.state === "QUIET" && packedOnly.lanes.length === 0 && packedOnly.queued.length === 3 &&
      L.formatUnderPackedLaneFinding(packedOnly) === null,
    packedOnly.reason, "M-L2");
  const unattr = detect([UNDER], [decl(), ln({}, "L1")]);
  const unattrText = L.formatUnderPackedLaneFinding(unattr) || "";
  check("161", "LANE: an UNATTRIBUTABLE dispatch reports UNATTRIBUTED — never zero agents",
    unattr.state === "REPORT" && unattr.severity === "advisory" && unattr.lanes[0].attribution === "UNATTRIBUTED" &&
      unattr.lanes[0].agents === null && unattrText.includes("UNATTRIBUTED") && unattrText.includes("lane/under") &&
      !unattrText.includes("agents this session: 0"),
    `attribution=${unattr.lanes[0] && unattr.lanes[0].attribution} severity=${unattr.severity}`,
    "M-L3: drop the unidentified branch — the row reads as a measured zero");
  const skippedV = L.detectUnderPackedLane({ depth: DEPTH([UNDER]), rows: [decl()], skipped: 2, sessionId: SID });
  check("162", "LANE: a ledger with SKIPPED lines is UNMEASURED, not zero — a skipped line could be a launch",
    skippedV.state === "REPORT" && skippedV.lanes[0].attribution === "UNMEASURED" && skippedV.severity === "advisory",
    `attribution=${skippedV.lanes[0] && skippedV.lanes[0].attribution}`, "M-L4: drop the skipped branch");
  const unread = L.detectUnderPackedLane({ depth: DEPTH([UNDER]), rows: null, failure: { reason: "no dispatch ledger for this session" } });
  check("163", "LANE: an UNREAD dispatch ledger is UNMEASURED and carries the read's own reason",
    unread.state === "REPORT" && unread.lanes[0].attribution === "UNMEASURED" &&
      unread.lanes[0].basis === "no dispatch ledger for this session" && unread.launches === null,
    `basis=${unread.lanes[0] && unread.lanes[0].basis}`);
  const wtHit = detect([UNDER], [decl(), ln({ worktree: "/x/wt-under" }, "L1")], { worktreeLanes: { "/x/wt-under": "lane/under" } });
  const wtMiss = detect([UNDER], [decl(), ln({ worktree: "/x/wt-under" }, "L1")]);
  check("164", "LANE: a worktree PATH joins through the worktree map; with no map the row is UNATTRIBUTED",
    wtHit.state === "QUIET" && wtHit.suppressed[0].lane === "lane/under" &&
      wtMiss.state === "REPORT" && wtMiss.lanes[0].attribution === "UNATTRIBUTED",
    `hit=${wtHit.state} miss=${wtMiss.state}:${wtMiss.lanes[0] && wtMiss.lanes[0].attribution}`, "M-L1, M-L3");
  // `LANE_ATTRIBUTION_KEYS` is declared in wip-lanes.js but NOT exported (measured: `W.LANE_ATTRIBUTION_KEYS`
  // is undefined). The export is preferred the day it lands; until then the DECLARATION is read from
  // source, and the parser is shown to FIRE (it must yield a non-empty set holding `lane`, the key
  // `_agentsAttribution` joins on) so an empty parse can never read as agreement.
  const declaredKeys = (() => {
    if (Array.isArray(W.LANE_ATTRIBUTION_KEYS)) return { src: "export", keys: W.LANE_ATTRIBUTION_KEYS };
    const text = fs.readFileSync(path.join(REPO, ".claude/hooks/lib/wip-lanes.js"), "utf8");
    const m = /const LANE_ATTRIBUTION_KEYS = Object\.freeze\(\[([^\]]*)\]\)/.exec(text);
    return { src: "source", keys: m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [] };
  })();
  check("165", "LANE: the join keys are COUPLED to wip-lanes.js::LANE_ATTRIBUTION_KEYS, not restated",
    (() => {
      const mine = new Set([...L.LANE_NAME_KEYS, ...L.LANE_PATH_KEYS]);
      const theirs = new Set(declaredKeys.keys);
      return theirs.size > 0 && theirs.has("lane") && mine.size === theirs.size && [...theirs].every((k) => mine.has(k));
    })(),
    `mine=${[...L.LANE_NAME_KEYS, ...L.LANE_PATH_KEYS]} theirs(${declaredKeys.src})=${declaredKeys.keys}`,
    "a key added to the ledger's declaration would otherwise be silently ignored here");
  const foreignRows = [decl(), { ...ln({ lane: "lane/under" }, "L1"), session_id: "FOREIGN" }];
  const fenced = detect([UNDER], foreignRows);
  const unfenced = L.detectUnderPackedLane({ depth: DEPTH([UNDER]), rows: foreignRows, skipped: 0 });
  check("166", "LANE fence: ANOTHER session's launch for this lane does not clear it; unfenced, it would",
    fenced.state === "REPORT" && fenced.lanes[0].attribution === "ZERO" && unfenced.state === "QUIET",
    `fenced=${fenced.state} unfenced=${unfenced.state}`, "M-L5: drop the session fence");
  const mislabelled = detect([{ ...PACKED, items: ["ws/p1"], itemCount: 1 }, { ...UNDER, lane: "lane/deep", items: ["a", "b", "c"], itemCount: 3 }], [decl()]);
  check("167", "LANE: laneDepth's verdict is CONSUMED VERBATIM, never re-derived from the item count",
    mislabelled.state === "REPORT" && mislabelled.lanes.length === 1 && mislabelled.lanes[0].lane === "lane/deep",
    `lanes=${mislabelled.lanes.map((l) => l.lane)}`, "M-L2");
  const unk = L.detectUnderPackedLane({ depth: { ok: false, reason: "lane-survey-failed: for-each-ref-failed" }, rows: [decl()] });
  const unkProbe = L.detectUnderPackedLane({ depth: { ok: false, probe: "timeout", reason: "timeout: killed" }, rows: null });
  const unkText = L.formatUnderPackedLaneFinding(unk) || "";
  check("168", "LANE UNKNOWN: an unreadable work ledger is a TYPED unknown that SPEAKS — never 'no under-packed lanes'",
    unk.state === "UNKNOWN" && unk.kind === "ledger-unreadable" && unk.reason.includes("for-each-ref-failed") &&
      unkText.includes("LANE DEPTH UNKNOWN") && unkText.includes("NOT 'no under-packed lanes'") &&
      L.underPackedSignatureOf(unk) === "LANE-DEPTH:UNKNOWN:ledger-unreadable:lane-survey-failed" &&
      unkProbe.kind === "probe-failed" && L.underPackedSignatureOf(unkProbe) === "LANE-DEPTH:UNKNOWN:probe-failed:timeout" &&
      L.detectUnderPackedLane({ depth: null }).state === "UNKNOWN",
    `sig=${L.underPackedSignatureOf(unk)} probeSig=${L.underPackedSignatureOf(unkProbe)}`,
    "M-L9: render UNKNOWN as silence");
  check("169", "LANE: NOT-RUN and QUIET render NOTHING and sign nothing (never marked, never spoken)",
    L.formatUnderPackedLaneFinding(L.laneArmNotRun("x")) === null && L.underPackedSignatureOf(L.laneArmNotRun("x")) === "" &&
      L.formatUnderPackedLaneFinding(attr) === null && L.underPackedSignatureOf(attr) === "",
    "the instrument-did-not-run silence the other arms keep");
  const referred = L.formatUnderPackedLaneFinding(zero, { zeroDispatchStatedBy: "per-prompt" }) || "";
  const stated = L.formatUnderPackedLaneFinding(zero) || "";
  const joinedReferred = L.formatUnderPackedLaneFinding(sib, { zeroDispatchStatedBy: "per-prompt" }) || "";
  check("170", "LANE NO DOUBLE COUNT: the zero is REFERRED to when another arm states it, stated when none does",
    referred.includes("the per-prompt finding above states that zero; counted once") && !referred.includes("holds no launch row") &&
      stated.includes("holds no launch row") && !stated.includes("counted once") &&
      // a JOINED zero is a DIFFERENT fact (launches happened, none for this lane) — it keeps its own basis
      joinedReferred.includes("name other lanes") && !joinedReferred.includes("counted once"),
    "one fact, one statement, in one response", "M-L6 (guard wiring) is pinned end-to-end by 180");
  check("171", "LANE signature discriminates: same set → same key; a changed item count, queue or attribution → new key",
    L.underPackedSignatureOf(zero) === L.underPackedSignatureOf(detect([UNDER, PACKED], [decl()])) &&
      L.underPackedSignatureOf(zero) !== L.underPackedSignatureOf(detect([{ ...UNDER, itemCount: 0, items: [] }], [decl()])) &&
      L.underPackedSignatureOf(zero) !== L.underPackedSignatureOf(detect([UNDER], [decl()], { queued: [] })) &&
      L.underPackedSignatureOf(zero) !== L.underPackedSignatureOf(unattr) &&
      /^LANE-DEPTH:[0-9a-f]{16}$/.test(L.underPackedSignatureOf(zero)),
    L.underPackedSignatureOf(zero));
  const dup = L.attributeLaunchesToLanes({ rows: [ln({ lane: "lane/under" }, "L1"), ln({ lane: "lane/under" }, "L1")], laneNames: ["lane/under"], sessionId: SID });
  check("172", "LANE: a launch row repeated under ONE launch_id counts once, as reconcile() dedupes it",
    dup.ok && dup.total === 1 && dup.perLane.get("lane/under") === 1, `total=${dup.total}`);

  // ── end-to-end over real repositories ──────────────────────────────────────
  const TMP_ROOT = fs.realpathSync(os.tmpdir());
  const REPO_REAL = fs.realpathSync(REPO);
  const made = [];
  const scratch = (tag) => {
    const abs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dd-lane-${tag}-`)));
    if (!path.isAbsolute(abs) || !abs.startsWith(TMP_ROOT + path.sep) || abs === REPO_REAL || abs.startsWith(REPO_REAL + path.sep))
      throw new Error(`CONTAINMENT: refusing fixture directory ${abs}`);
    made.push(abs);
    return abs;
  };
  const gitEnvClean = () => {
    const e = { ...process.env };
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]) delete e[k];
    return e;
  };
  const buildLaneRepo = ({ tag, lanes, todos, trunk = true }) => {
    const abs = scratch(tag);
    const g = (...args) =>
      execFileSync("git", ["-C", abs, "-c", "user.email=f@x", "-c", "user.name=f", ...args], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnvClean(),
      }).trim();
    g("init", "-q");
    for (const [rel, lane] of todos) {
      const p = path.join(abs, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `---\nlane: ${lane}\n---\n# ${path.basename(rel, ".md")}\n`);
    }
    g("add", "-A");
    g("commit", "-q", "--allow-empty", "-m", "init");
    if (trunk) g("update-ref", "refs/remotes/origin/main", "HEAD");
    for (const lane of lanes) g("update-ref", `refs/heads/${lane}`, g("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", lane));
    return { abs, g };
  };
  const T = (n) => `workspaces/ws/todos/active/${n}.md`;
  let launchSeq = 0;
  const seedDecl = (repo, sid, n = 0) =>
    LEDGER.appendRecord({ repoDir: repo, record: LEDGER.buildDeclaredRecord({ sessionId: sid, generation: LEDGER.MAIN_GENERATION, declaredSubparts: n, nowIso: new Date().toISOString() }) }).ok;
  const seedLaunch = (repo, sid, extra = {}) =>
    LEDGER.appendRecord({
      repoDir: repo,
      record: { ...LEDGER.buildLaunchRecord({ sessionId: sid, generation: LEDGER.MAIN_GENERATION, dispatchName: `worker-${++launchSeq}`, subagentType: "analyst", nowIso: new Date().toISOString() }), ...extra },
    }).ok;
  // A NODE_OPTIONS shim that acts ONLY inside the lane-depth CHILD (it keys on the probe flag), so it
  // can prove whether the probe was spawned at all, can hold it past its budget, and can PIN the
  // survey it performs — without adding a test knob to the shipped guard.
  //
  // WHY THE PIN EXISTS, MEASURED. The child is a whole node process that re-requires `wip-lanes.js`
  // and runs a multi-`git` lane survey: 0.93 / 1.17 / 1.53 s on an IDLE machine against a repository
  // the size of these fixtures. The guard allows it `min(2500, 4000 - elapsed - 600)` ms. Under any
  // concurrent load the survey crosses that bound, the guard emits its typed `LANE DEPTH UNKNOWN`
  // instead of the measured verdict, and every content assertion below flips — two consecutive runs
  // of this file on ONE tree gave 192/193 with DIFFERENT cases red. A check whose verdict depends on
  // machine timing measures the machine, not the guard.
  //
  // WHAT THE PIN REPLACES AND WHAT IT KEEPS. `DD_SHIM_DEPTH_JSON` patches `wip-lanes.js::laneDepth`
  // in the child's module cache BEFORE the child requires it, so the child returns a survey the
  // PARENT already measured with the SAME function on the SAME repository (control 173 pins that it
  // is the real one). Everything else stays real and end-to-end: the child is still spawned, its
  // worktree map is still read from real `git worktree list`, the reply still crosses the pipe, and
  // the parent still parses it, joins the ledger rows and composes the response. The arms that must
  // exercise an UNPINNED child keep doing so — 182 (survey failure), 183 (no budget), 184 (a probe
  // genuinely held past its budget), 185 (never spawned).
  const shimDir = scratch("shim");
  const SHIM = path.join(shimDir, "probe-shim.cjs");
  const WIP_LANES_REAL = fs.realpathSync(path.join(REPO, ".claude/hooks/lib/wip-lanes.js"));
  fs.writeFileSync(SHIM,
    'if (process.argv.includes("--lane-depth-probe")) {\n' +
    '  if (process.env.DD_SHIM_MARKER) require("fs").appendFileSync(process.env.DD_SHIM_MARKER, "probe\\n");\n' +
    '  if (process.env.DD_SHIM_DEPTH_JSON) {\n' +
    '    const pinned = JSON.parse(process.env.DD_SHIM_DEPTH_JSON);\n' +
    '    require(process.env.DD_SHIM_WIP_LANES).laneDepth = () => pinned;\n' +
    "  }\n" +
    '  if (process.env.DD_SHIM_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.DD_SHIM_SLEEP_MS));\n' +
    "}\n");
  // Every key the shim reads is deleted here, so an ambient value in the operator's environment can
  // never reach a fire that did not ask for it. A pin that leaked in would make an unpinned arm
  // (182/183/184/185) silently measure the pin instead of the child.
  const baseEnv = () => {
    const e = { ...process.env };
    delete e.COC_LANE_DEPTH_BUDGET_MS;
    delete e.DD_SHIM_MARKER;
    delete e.DD_SHIM_SLEEP_MS;
    delete e.DD_SHIM_DEPTH_JSON;
    delete e.DD_SHIM_WIP_LANES;
    return e;
  };
  const fire = (repo, payload, env = {}) => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({ hook_event_name: "Stop", ...payload }),
      encoding: "utf8",
      env: { ...baseEnv(), CLAUDE_PROJECT_DIR: repo, ...env },
    });
    const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
    let json = null;
    try { json = JSON.parse(lines[lines.length - 1] || ""); } catch {}
    return {
      code: r.status == null ? -1 : r.status, stderr: r.stderr || "", json, lines: lines.length, ms: Date.now() - t0,
      msg: json && typeof json.systemMessage === "string" ? json.systemMessage : "",
    };
  };
  const shimmed = (tag, sleepMs, depth) => {
    const marker = path.join(shimDir, `${tag}.marker`);
    const env = { NODE_OPTIONS: `--require ${SHIM}`, DD_SHIM_MARKER: marker };
    if (sleepMs) env.DD_SHIM_SLEEP_MS = String(sleepMs);
    if (depth) { env.DD_SHIM_DEPTH_JSON = JSON.stringify(depth); env.DD_SHIM_WIP_LANES = WIP_LANES_REAL; }
    return { env, spawned: () => fs.existsSync(marker) };
  };
  /** A pinned fire: the child still runs, its survey is the one the parent measured. */
  const pin = (tag, depth) => shimmed(tag, 0, depth);
  /** Names the timeout arm inside a check detail, so a red can never be read as a content failure. */
  const depthUnk = (f) => f.msg.includes("LANE DEPTH UNKNOWN");
  const laneBlock = (msg) => {
    const i = msg.indexOf("[delegation-default] UNDER-PACKED LANE(S)");
    if (i === -1) return "";
    // The block's own header sentence says "while items are QUEUED", so the block ends at the QUEUED
    // LINE, never at the first occurrence of the word.
    const j = msg.indexOf("\nQUEUED", i);
    return msg.slice(i, j === -1 ? undefined : j);
  };
  const fired = [];

  const R1 = buildLaneRepo({
    tag: "r1",
    lanes: ["lane/under", "lane/packed"],
    todos: [[T("a1"), "lane/under"], [T("p1"), "lane/packed"], [T("p2"), "lane/packed"], [T("q1"), "lane/closed"], [T("q2"), "lane/closed"]],
  });
  const R1depth = W.laneDepth({ repoDir: R1.abs });
  // The sibling reads UNDETERMINED, not PACKED: `laneDepth` is called here with no ledger, so the
  // AGENT axis is unmeasured, and a lane carrying 2+ items whose agents nobody counted is exactly
  // what must NOT read PACKED (that silent-PACKED reading was the defect the verdict model fixed).
  // The control still does its job — one lane UNDER-PACKED, the sibling not, 2 QUEUED — and it now
  // also pins that the unmeasured axis is reported rather than assumed parallel.
  check("173", "LANE CONTROL: the fixture repository really holds one UNDER-PACKED lane, one sibling whose agent axis is UNMEASURED (never PACKED), 2 QUEUED",
    R1depth.ok === true && JSON.stringify(R1depth.underPacked) === JSON.stringify(["lane/under"]) &&
      R1depth.lanes.some((l) => l.lane === "lane/packed" && l.verdict === "UNDETERMINED" && l.agents === null) &&
      R1depth.counts.queued === 2,
    `ok=${R1depth.ok} under=${R1depth.underPacked} queued=${R1depth.counts && R1depth.counts.queued} reason=${R1depth.reason || ""}`,
    "without this control every quiet pole below could be quiet because the ledger measured nothing");

  const zShim = shimmed("zero", 0, R1depth);
  const okSeed = seedDecl(R1.abs, "lz-zero");
  const fz = fire(R1.abs, { session_id: "lz-zero" }, zShim.env);
  fired.push(fz);
  const fzBlock = laneBlock(fz.msg);
  check("174", "LANE E2E firing pole: a zero-launch session is REPORTED at halt-and-report, naming lane/under and NOT lane/packed",
    okSeed && zShim.spawned() && fz.code === 0 && fz.json && fz.json.continue === true && !("decision" in (fz.json || {})) &&
      fz.msg.startsWith("NOT BLOCKED — the action ALREADY RAN") && fzBlock.includes("  - lane/under — 1 item(s)") &&
      !fzBlock.includes("lane/packed") && fz.msg.includes("MUST-9") && fz.stderr.includes("[HALT-AND-REPORT]"),
    `code=${fz.code} depthUnknown=${depthUnk(fz)} head=${JSON.stringify(fz.msg.slice(0, 40))} probeSpawned=${zShim.spawned()}`,
    "M-L2 names the sibling; M-L11 drops the head to ADVISORY");

  seedDecl(R1.abs, "lz-attr");
  seedLaunch(R1.abs, "lz-attr", { lane: "lane/under" });
  const fa = fire(R1.abs, { session_id: "lz-attr" }, pin("attr", R1depth).env);
  fired.push(fa);
  check("175", "LANE E2E quiet pole: the SAME lane with an attributed dispatch this session emits NOTHING",
    fa.code === 0 && fa.msg === "" && fa.stderr.trim() === "" && fa.json && fa.json.continue === true,
    `depthUnknown=${depthUnk(fa)} msg=${JSON.stringify(fa.msg.slice(0, 60))}`, "M-L1");

  seedDecl(R1.abs, "lz-sib");
  seedLaunch(R1.abs, "lz-sib", { lane: "lane/packed" });
  const fs1 = fire(R1.abs, { session_id: "lz-sib" }, pin("sib", R1depth).env);
  fired.push(fs1);
  check("176", "LANE E2E identity: a dispatch for the PACKED sibling does not silence lane/under",
    laneBlock(fs1.msg).includes("  - lane/under") && fs1.msg.includes("name other lanes") && !laneBlock(fs1.msg).includes("lane/packed"),
    `depthUnknown=${depthUnk(fs1)} block=${JSON.stringify(laneBlock(fs1.msg).slice(0, 80))}`);

  seedDecl(R1.abs, "lz-unattr");
  seedLaunch(R1.abs, "lz-unattr");
  const fu = fire(R1.abs, { session_id: "lz-unattr" }, pin("unattr", R1depth).env);
  fired.push(fu);
  check("177", "LANE E2E: an unattributable dispatch is reported UNATTRIBUTED at ADVISORY — never zero agents",
    fu.code === 0 && fu.msg.startsWith("ADVISORY") && laneBlock(fu.msg).includes("lane/under") &&
      fu.msg.includes("UNATTRIBUTED") && !fu.msg.includes("agents this session: 0"),
    // Detail reports EVERY conjunct, not the head: a timed-out lane-depth probe emits an ADVISORY
    // whose first 30 chars are byte-identical to the expected one, so a head-only detail cannot
    // separate "the probe timed out" from "the report really lacked UNATTRIBUTED" — and a red that
    // cannot name its cause sends the reader to the wrong fix. depthUnknown names the timeout arm.
    `code=${fu.code} advisory=${fu.msg.startsWith("ADVISORY")} laneBlockHasUnder=${laneBlock(fu.msg).includes("lane/under")} ` +
      `unattributed=${fu.msg.includes("UNATTRIBUTED")} saysZeroAgents=${fu.msg.includes("agents this session: 0")} ` +
      `depthUnknown=${fu.msg.includes("LANE DEPTH UNKNOWN")} head=${JSON.stringify(fu.msg.slice(0, 30))}`, "M-L3");

  const R2 = buildLaneRepo({
    tag: "r2", lanes: ["lane/packed"], todos: [[T("p1"), "lane/packed"], [T("p2"), "lane/packed"], [T("q1"), "lane/closed"]],
  });
  const pShim = shimmed("packed", 0, W.laneDepth({ repoDir: R2.abs }));
  seedDecl(R2.abs, "lz-packed");
  const fp = fire(R2.abs, { session_id: "lz-packed" }, pShim.env);
  fired.push(fp);
  check("179", "LANE E2E quiet pole: a PACKED lane with items QUEUED emits NOTHING — and the probe DID run",
    pShim.spawned() && fp.code === 0 && fp.msg === "" && fp.stderr.trim() === "",
    `probeSpawned=${pShim.spawned()} depthUnknown=${depthUnk(fp)} msg=${JSON.stringify(fp.msg.slice(0, 60))}`,
    "the spawned-probe control makes this silence a measured PACKED, not an unrun arm");

  seedDecl(R1.abs, "lz-double", 4);
  const fd = fire(R1.abs, { session_id: "lz-double" }, pin("double", R1depth).env);
  fired.push(fd);
  const countOf = (s, needle) => s.split(needle).length - 1;
  check("180", "LANE E2E NO DOUBLE FINDING: with the per-prompt zero-dispatch arm firing, ONE response states the zero ONCE",
    fd.code === 0 && fd.lines === 1 && countOf(fd.msg, "ZERO lanes were dispatched for it") === 1 &&
      laneBlock(fd.msg).includes("the per-prompt finding above states that zero; counted once") &&
      !fd.msg.includes("holds no launch row") && fd.msg.startsWith("NOT BLOCKED — the action ALREADY RAN") &&
      fd.msg.includes("MUST-3") && fd.msg.includes("MUST-9"),
    `lines=${fd.lines} depthUnknown=${depthUnk(fd)} zeroStatements=${countOf(fd.msg, "ZERO lanes were dispatched for it")}`,
    "M-L6: pass zeroDispatchStatedBy:null at the guard — the lane block restates the zero");

  const again = fire(R1.abs, { session_id: "lz-zero" }, pin("again", R1depth).env);
  const rShim = shimmed("refire");
  seedDecl(R1.abs, "lz-refire");
  const refire = fire(R1.abs, { session_id: "lz-refire", stop_hook_active: true }, rShim.env);
  fired.push(again, refire);
  check("181", "LANE LOOP SAFETY: no refusal on any fire; an unchanged finding is silent; a stop_hook_active refire never spawns the probe",
    again.code === 0 && again.msg === "" && again.stderr.trim() === "" &&
      refire.code === 0 && refire.msg === "" && !rShim.spawned() &&
      fired.every((f) => f.code === 0 && f.json && !("decision" in f.json) && f.json.continue === true),
    `again=${JSON.stringify(again.msg.slice(0, 30))} refireSpawned=${rShim.spawned()}`,
    "M-L7: drop the refire skip — the refire spawns the probe and speaks");

  const R3 = buildLaneRepo({ tag: "r3", lanes: ["lane/under"], todos: [[T("a1"), "lane/under"]], trunk: false });
  seedDecl(R3.abs, "lz-unk");
  const fk = fire(R3.abs, { session_id: "lz-unk" });
  const fk2 = fire(R3.abs, { session_id: "lz-unk" });
  check("182", "LANE E2E: an UNREADABLE work ledger speaks a TYPED unknown once per session — never 'no under-packed lanes'",
    fk.code === 0 && fk.msg.includes("LANE DEPTH UNKNOWN") && fk.msg.includes("lane-survey-failed") &&
      fk.msg.includes("NOT 'no under-packed lanes'") && !fk.msg.includes("UNDER-PACKED LANE(S)") && fk2.msg === "",
    `first=${JSON.stringify(fk.msg.slice(0, 60))} second=${fk2.msg.length}`, "M-L9");

  seedDecl(R1.abs, "lz-nobudget");
  const fnb = fire(R1.abs, { session_id: "lz-nobudget" }, { COC_LANE_DEPTH_BUDGET_MS: "1" });
  check("183", "LANE BUDGET: a budget below the floor is UNKNOWN (no-budget), never a report and never silence",
    fnb.code === 0 && fnb.msg.includes("LANE DEPTH UNKNOWN") && fnb.msg.includes("no-budget") && !fnb.msg.includes("UNDER-PACKED LANE(S)"),
    `msg=${JSON.stringify(fnb.msg.slice(0, 80))}`, "M-L12: drop the budget floor — the probe is spawned with a 1 ms timeout");

  // 1200 ms, not less: MEASURED, a 400 ms budget under a concurrent CPU-heavy run killed the child
  // BEFORE its `--require` shim wrote the spawned marker, so the control read false on a genuine
  // timeout. The budget figure is matched by shape, because a slow start shrinks what remains.
  const tShim = shimmed("timeout", 4000);
  seedDecl(R1.abs, "lz-timeout");
  const ft = fire(R1.abs, { session_id: "lz-timeout" }, { ...tShim.env, COC_LANE_DEPTH_BUDGET_MS: "1200" });
  const budgetMs = (/exceeded its (\d+) ms budget/.exec(ft.msg) || [])[1];
  check("184", "LANE BUDGET: a probe held past its budget is KILLED and reported UNKNOWN (timeout) inside the hook's time",
    tShim.spawned() && ft.code === 0 && ft.msg.includes("LANE DEPTH UNKNOWN") && ft.msg.includes("timeout") &&
      budgetMs !== undefined && Number(budgetMs) <= 1200 && ft.ms < 3500 && ft.json && ft.json.continue === true,
    `ms=${ft.ms} spawned=${tShim.spawned()} msg=${JSON.stringify(ft.msg.slice(0, 80))}`,
    "M-L10: unmap ETIMEDOUT — the killed probe is misreported as spawn-failed");

  const R4 = buildLaneRepo({ tag: "r4", lanes: ["lane/under"], todos: [] });
  const nShim = shimmed("noworkspaces");
  seedDecl(R4.abs, "lz-nows");
  const fn = fire(R4.abs, { session_id: "lz-nows" }, nShim.env);
  check("185", "LANE NOT-RUN: with no workspaces/ directory the probe is never spawned and nothing is emitted",
    fn.code === 0 && fn.msg === "" && !nShim.spawned(),
    `spawned=${nShim.spawned()} msg=${JSON.stringify(fn.msg.slice(0, 40))}`,
    "M-L8: drop the short-circuit — the probe spawns on every Stop of every repo");

  // Last, because it adds a linked worktree to R1.
  const wtAbs = scratch("wt");
  R1.g("worktree", "add", "-q", wtAbs, "lane/under");
  // Re-measured AFTER the worktree add, so the pin is this tree's survey and not the earlier one.
  const R1wtDepth = W.laneDepth({ repoDir: R1.abs });
  seedDecl(R1.abs, "lz-wt");
  seedLaunch(R1.abs, "lz-wt", { worktree: wtAbs });
  const fw = fire(R1.abs, { session_id: "lz-wt" }, pin("wt", R1wtDepth).env);
  seedDecl(R1.abs, "lz-wt-miss");
  seedLaunch(R1.abs, "lz-wt-miss", { worktree: shimDir });
  const fwm = fire(R1.abs, { session_id: "lz-wt-miss" }, pin("wtmiss", R1wtDepth).env);
  // The path→lane map itself is NOT pinned: the child still reads it from real `git worktree list`,
  // which is the join this case exists to prove. Only the survey is pinned. The detail reports the
  // UNKNOWN arm for BOTH poles, because a timed-out or unreadable survey turns the hit pole's
  // silence into a message and the miss pole's UNATTRIBUTED into an unknown — and head strings alone
  // cannot separate that from a genuine content failure, which is the read that sends a reader to
  // the wrong fix.
  check("178", "LANE E2E path join: a launch row naming lane/under's WORKTREE clears it; a non-worktree path is UNATTRIBUTED",
    fw.code === 0 && fw.msg === "" && fwm.msg.includes("UNATTRIBUTED") && laneBlock(fwm.msg).includes("lane/under"),
    `depthUnknownHit=${depthUnk(fw)} depthUnknownMiss=${depthUnk(fwm)} surveyOk=${R1wtDepth.ok} ` +
      `hit=${JSON.stringify(fw.msg.slice(0, 40))} miss=${JSON.stringify(fwm.msg.slice(0, 40))}`, "M-L1, M-L3");

  check("186", "LANE ISOLATION: this block wrote nothing under the real checkout's .claude/learning",
    ["dispatch-reconcile", "delegation-default"].every((d) => {
      const p = path.join(REPO, ".claude/learning", d);
      return !fs.existsSync(p) || fs.readdirSync(p).every((f) => !f.startsWith("lz-") && !f.startsWith("lane-lib-"));
    }),
    "every fire points CLAUDE_PROJECT_DIR at a mkdtemp repository");

  for (const d of made.reverse()) fs.rmSync(d, { recursive: true, force: true });
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
