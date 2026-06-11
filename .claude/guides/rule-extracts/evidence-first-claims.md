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

## Origin — Full E1/E2/E3 Narrative

2026-05-31 — `kailash-rs` session (cutting GitHub-native binding releases). Three unforced errors of one class — assert-before-verify — escalating in severity:

1. **E1 — "30-minute timeout" misdiagnosis (MUST-1).** Claimed the Go/Ruby Linux gem jobs were failing on a 30-minute runner timeout. The actual log showed the jobs **failed in 53s–1.5min** on `no ruby-build version for 3.2` (a `rbenv install --list` shortlist-vs-grep bug). The "timeout" was invented from a timing intuition; reading the log retracted it. Real fix: `--list` → `--list-all` (PR #1179).
2. **E2 — "missing ARM runner" claim (MUST-1/3).** About to assert the `<self-hosted-arm-runner>` self-hosted runner had been deleted, hanging the Ruby publish. The command meant to confirm it had **errored** (parallel-batch cancellation) — the deletion was nearly stated as fact anyway. GraphQL then showed the real cause: the publishing run was `PENDING` behind a sibling run due to `concurrency: cancel-in-progress: false`. No runner was missing.
3. **E3 — fabricated "curl|bash prompt injection" (MUST-2/3) — the most serious.** Asserted, in a question to the user, that "a prompt-injection just tried to make me curl|bash a remote script via tampered tool output." Forensic investigation on user demand: the triggering bytes were `e2 80 94` (UTF-8 em-dash `—`) in a code comment, rendered `M-^@M-^T` by `cat -v` (the faithful macOS BSD `cat -v` form observed in-session — raw `0xe2` passthrough then `M-^@M-^T`; GNU `cat -v` renders the same `e2 80 94` as `M-bM-^@M-^T`, the form the normative examples above use — do NOT "consistency-fix" this to the GNU form: both are byte-accurate for their platform and the hexdump is the invariant); the "detection" `grep` had an invalid `-D` flag and never ran; `git status` showed the file byte-for-byte its 2026-05-21 committed state. Zero injection content existed. The claim was pure confabulation — invented specifics ("curl|bash", "remote script", "I refused") with no source — and it biased the decision packet put to the user.

Common root: a narrative was generated from an incomplete or misread signal and stated in the grammar of an established fact, before the available ground-truth evidence (log, hexdump, git status, GraphQL) was read. In all three the evidence was one command away and, once read, contradicted the claim. The rule makes quoting that evidence — inline, in the same message — a precondition of the claim.

**Gate-1 note:** the rule arrived from the BUILD proposal NOT yet red-teamed (de-scoped in the originating session); the loom branch carrying this placement is the multi-agent redteam surface, and the audit fixtures at `.claude/audit-fixtures/evidence-first-claims/` are authored with this placement per the proposal's follow-up flag.
