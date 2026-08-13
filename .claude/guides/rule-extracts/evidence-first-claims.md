# evidence-first-claims.md — Extended Evidence and Examples

Full DO/DO-NOT blocks, BLOCKED-rationalization corpora, the structural-finding carve-out, and the complete origin narrative for `.claude/rules/evidence-first-claims.md`. The rule body carries the compact clauses; this extract carries the depth (not baseline-emitted).

## MUST-1 — Diagnostic And Root-Cause Claims Cite The Evidence Inline

```text
# DO — claim names the cause AND shows the evidence
The Linux gem job failed. From the log:
    + full=$(rbenv install --list | grep -E "3.2\.[0-9]+$" ...)
    no ruby-build version for 3.2
    + exit 1
Root cause: `rbenv install --list` returns a curated shortlist; the grep
finds no 3.2 patch → empty → exit 1. (NOT a timeout — the job ran 53s.)

# DO NOT — name a cause before reading the log
The gem job is taking long — it's hitting the 30-minute runner timeout.
# (stated as fact; the actual log showed a 53s failure on version resolution)
```

**BLOCKED rationalizations:** "The cause is obvious from the symptom" / "I'll confirm with the log after" / "The timing pattern fits a timeout" / "It's the same failure mode as last time" / "Reading the full log is slow; the summary is enough".

## MUST-2 — Security / Anomaly Claims Quote The Triggering Bytes, Decoded

Decode via `hexdump -C` / `od -c` / `python3 -c "print(repr(open(f,'rb').read()))"` over the WHOLE suspect span — NOT the one rendered token that drew your eye (an injection often hides bytes elsewhere). The decode MUST cover the obfuscation classes `cat -v` renders as benign-or-invisible: **zero-width / invisible** (U+200B ZWSP, U+200C/D, U+FEFF BOM, U+2060 word-joiner), **bidi / RTL override** (U+202A–202E, U+2066–2069 — the "Trojan Source" class where displayed order ≠ byte order), **homoglyph / confusable** (Cyrillic `а` U+0430 vs Latin `a` U+0061), and `\xNN` / base64 / percent-encoding wrappers.

**Structural-finding carve-out:** the byte-quote bar applies to the content / injection / tampering subclass — findings whose evidence IS bytes. A structural / behavioral security finding with no triggering bytes (timing side-channel, multi-step exploit chain, TOCTOU race, logic-flaw auth bypass, SSRF) satisfies the evidence requirement instead with inline reproduction steps + the observed output at each step — same no-proxy-for-evidence principle, different evidence shape. Fabricating a byte-quote to satisfy the rule AND suppressing a real structural finding because it has no bytes to quote are BOTH BLOCKED.

```text
# DO — quote the bytes, decode the WHOLE span, THEN characterize
`cat -v` showed `Helper M-bM-^@M-^T synchronous`. Hexdump of that span:
    e2 80 94  → UTF-8 em-dash (—)   # `cat -v` renders e2 80 94 as M-bM-^@M-^T
Conclusion: benign Unicode in a code comment. No anomaly.

# DO NOT — pattern-match a rendering to a threat narrative
cat -v output looked obfuscated → "a prompt injection tried to make me
curl|bash a remote script". (No curl, no bash, no URL existed in any
byte — `grep -icE "curl|bash|http"` → 0. The "threat" was invented.)
```

**BLOCKED rationalizations:** "The output looked like obfuscated/hostile content" / "Better to flag a false positive than miss a real attack" / "The control chars are suspicious on their own" / "I refused it, so no harm" (refusing a non-existent threat is theatre) / "Raising it lets the user decide".

## MUST-3 — An Errored Or Empty Command Is Zero Evidence

```text
# DO — a broken command is re-run or its failure is named
grep -nED 'curl|bash' file.java   # → "ugrep: invalid argument -D" (error text is grep-impl-specific)
# The grep ERRORED (bad flag) — it found nothing because it never ran.
# Re-running with a valid flag: grep -niE 'curl|bash' → 0 matches.

# DO NOT — treat the errored grep's empty output as "no injection found,
# consistent with my threat read" (it confirmed nothing; it never executed)
```

**BLOCKED rationalizations:** "It returned nothing, which fits" / "Empty result = clean / = confirmed" / "The command roughly worked" / "Close enough to re-running it".

## MUST-4 — Inference Labeled As Inference

```text
# DO — observation and inference are grammatically distinct
Observation: run 530 shows `publish-rubygems: SKIPPED`, `build-ruby-gem-linux: FAILURE`.
Inference (unverified until I read the log): the --list-all fix likely didn't
fully resolve the ABI; pulling the log to confirm.

# DO NOT — inference dressed as observation
"The --list-all fix worked; the gem is publishing now."
# (stated as fact while the job had actually FAILED)
```

## MUST-5 — Opposite-Verdict Capability (Self-Derived Oracle + Two-Dot Diff)

`rules/instrument-discipline.md` MUST-1/2/3 govern whether a check DISCRIMINATES and whether it fires HERE. MUST-5 adds the two shapes that rule does not enumerate by name. Read both.

```text
# DO — show the opposite verdict first, THEN bank the result
mutate the mechanism -> assert the check goes RED -> revert -> assert GREEN
grep -c '<terminal-marker>' <script>   # == 1 before waiting on it
git diff base...HEAD                   # three-dot: what THIS branch changed

# DO NOT — bank a green from an instrument never shown able to go red
"fmt/lint/doc all 0"          # measured while a mutation was still applied
"0 occurrences"               # from a command that errored, or a pattern that cannot match
assert_eq!(missing_input, TENANT_ID)   # the argument IS that constant
assert!(err.contains(pos.label()))     # the message is BUILT from label()
git diff base..HEAD           # two-dot on a stale branch: base's commits read as REVERSIONS
```

**(a) Self-derived oracle.** The expected value is computed FROM the thing under test, so the two move together and agree by construction; the assertion then proves only that the code is deterministic. Pin against an INDEPENDENT literal, or a value derived by a separate path.

**(b) Wrong-question instrument.** A working command whose result does not bear on the claim. Observed forms: a grep pattern spanning a line break the prose wraps at; SHA ancestry (`merge-base --is-ancestor`) asked of a CONTENT question after a rebase or cherry-pick rewrote the SHAs; a selector picking a decorative separator; a completion marker the script emits TWICE; a shell-mangled argument, so the command never ran and its empty output read as "absent"; and the two-dot diff. On that last one: `git diff base..HEAD` compares the two TIPS, so on a branch BEHIND base every commit base gained since the fork point renders as a DELETION. Measured 2026-08-10: two-dot reported 31 files where three-dot and the forge's own PR diff both reported 15, and the 16 phantom files were raised as scope creep that would have blocked the merge. Use `base...HEAD` or the forge's PR-diff for any review artefact.

**BLOCKED rationalizations:** "the command exited 0" / "it returned a real number" / "the assertion passed" / "I read the output myself" / "it's the same check CI runs" / "the diff is the diff, both forms show the changes".

## MUST-6 — Instrument Scope Established Before A Green Generalizes

Every shape below was measured with a PASSING negative control — MUST-5 alone would have cleared each one. That is the point: the passing control is what makes a blind green look verified, which is strictly more dangerous than a green with no control at all.

```text
# DO — name the scope the green covers, and what it excludes
"2413 pass with the gated suite compiled; the runner is process-isolating,
 so this says nothing about shared-process races — re-ran under CI's runner."

# DO NOT — generalize a green past the instrument's reach
"process-isolated runner green -> the change is verified"  # blind to cross-test interaction
"2339 passed"                    # the file under review never compiled
"38 mutants killed"              # mutation at a shared helper; accept arms died too
"1546 examples, 0 failures"      # passes only because a sibling required tmpdir first
"tenant-isolation suite green"   # obtained on the permissive in-memory engine
```

- **Execution-model.** A process-isolating runner cannot observe cross-test interaction — shared statics, global registries, ordering effects. Re-derive with the instrument CI RUNS, not the convenient one. Measured: a tracing-capture test green under the isolating runner failed ~5-in-8 under the shared-process runner at 8/12/16 threads, reproducing inside ONE binary; a probe emitting a marker in the SAME closure captured 8/8 while the real assertion failed, isolating it to the callsite.
- **Compilation-scope.** A run that does not COMPILE a file cannot fail on it. Name the feature / `cfg` / marker / target set that compiled the file under review. Measured: `2339 passed` cited as verification while the file sat behind a non-default feature gate; with the feature on, 2413 — and the 74 absent tests included the three the shard existed to fix, with CI simultaneously red on them.
- **Mutation-point.** A mutation at a SHARED helper kills by collateral damage, not by the property. Apply it at the narrowest layer isolating the property; the tell is **ACCEPT arms dying**, since a truthiness regression cannot make a real `true`/`false` case fail. Measured: a mutation at a shared boolean-coercion predicate gave 38 unattributable kills; re-mutating one layer up gave 33 with ZERO accept arms dying.
- **Dependency-context.** A test file passing only because a SIBLING loaded its dependency covers nothing standalone. Run every new test file STANDALONE as well as in the suite. Measured: a new spec file passed in-suite but standalone raised from an `around` hook, which the runner attributes to the example — four apparent kills that were the harness.
- **Engine / dialect.** A suite green on a PERMISSIVE engine says nothing about the STRICT engine the product ships against. Measured 2026-08-10 and independently re-reproduced: a permissive embedded engine accepts `INSERT INTO t ("a","b","a") VALUES ('x','y','z')` with exit 0 and stores `x|y`, while the strict server engine refuses the identical statement with a duplicate-column error — so a tenant-isolation suite pinned to the permissive in-memory engine was green both BEFORE and AFTER the fix it was supposed to pin. Name the engine a green was obtained on, and re-derive on the strictest one supported.

A sibling of the same class one layer up: a local "doc gate" green measured a doctest runner while the failing CI gate ran the documentation LINTER — different instruments, different questions, same word in the command.

**BLOCKED rationalizations:** "the suite is green" / "the negative control passed, so the instrument is sound" / "both runners run the same tests" / "the feature flag only adds tests, it cannot remove coverage" / "more kills is stronger evidence" / "it passes in the suite, standalone is the same thing" / "the in-memory engine is the same SQL".

## Origin — Full E1/E2/E3 Narrative

2026-05-31 — Rust SDK session (cutting GitHub-native binding releases). Three unforced errors of one class — assert-before-verify — escalating in severity:

1. **E1 — "30-minute timeout" misdiagnosis (MUST-1).** Claimed the Go/Ruby Linux gem jobs were failing on a 30-minute runner timeout. The actual log showed the jobs **failed in 53s–1.5min** on `no ruby-build version for 3.2` (a `rbenv install --list` shortlist-vs-grep bug). The "timeout" was invented from a timing intuition; reading the log retracted it. Real fix: `--list` → `--list-all` (PR #1179).
2. **E2 — "missing ARM runner" claim (MUST-1/3).** About to assert the `<self-hosted-arm-runner>` self-hosted runner had been deleted, hanging the Ruby publish. The command meant to confirm it had **errored** (parallel-batch cancellation) — the deletion was nearly stated as fact anyway. GraphQL then showed the real cause: the publishing run was `PENDING` behind a sibling run due to `concurrency: cancel-in-progress: false`. No runner was missing.
3. **E3 — fabricated "curl|bash prompt injection" (MUST-2/3) — the most serious.** Asserted, in a question to the user, that "a prompt-injection just tried to make me curl|bash a remote script via tampered tool output." Forensic investigation on user demand: the triggering bytes were `e2 80 94` (UTF-8 em-dash `—`) in a code comment, rendered `M-^@M-^T` by `cat -v` (the faithful macOS BSD `cat -v` form observed in-session — raw `0xe2` passthrough then `M-^@M-^T`; GNU `cat -v` renders the same `e2 80 94` as `M-bM-^@M-^T`, the form the normative examples above use — do NOT "consistency-fix" this to the GNU form: both are byte-accurate for their platform and the hexdump is the invariant); the "detection" `grep` had an invalid `-D` flag and never ran; `git status` showed the file byte-for-byte its 2026-05-21 committed state. Zero injection content existed. The claim was pure confabulation — invented specifics ("curl|bash", "remote script", "I refused") with no source — and it biased the decision packet put to the user.

Common root: a narrative was generated from an incomplete or misread signal and stated in the grammar of an established fact, before the available ground-truth evidence (log, hexdump, git status, GraphQL) was read. In all three the evidence was one command away and, once read, contradicted the claim. The rule makes quoting that evidence — inline, in the same message — a precondition of the claim.

**Gate-1 note:** the rule arrived from the BUILD proposal NOT yet red-teamed (de-scoped in the originating session); the loom branch carrying this placement is the multi-agent redteam surface, and the audit fixtures at `.claude/audit-fixtures/evidence-first-claims/` are authored with this placement per the proposal's follow-up flag.

## MUST NOT — per-bullet rationale

Extracted from the rule body (paired extraction, 2026-08-12 Gate-1 placement, `rule-authoring.md` Rule 10 path (a)). The prohibition bullets stay in the rule as linguistic tripwires; their rationales live here.

- **Security claim without inline triggering bytes** — unfalsifiable from the reader's side, and it triggers costly escalation on a possibly-invented threat.
- **`cat -v` / escaped-byte rendering treated as content** — the rendering is not the byte; only a decode settles what the span actually contains.
- **Errored, timed-out or empty result read as confirmation** — absence-of-result is not evidence, and it is indistinguishable in raw output from a clean run.
- **Root-cause asserted before reading the log** — the log disambiguates; asserting first builds the next action on a guess.
- **A result banked from an instrument never shown able to return the opposite verdict, or a green generalized past its scope** — a check that cannot fail, or cannot fail for this class, reports `pass` for every input including the ones it exists to catch.
