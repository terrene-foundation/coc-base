---
priority: 0
scope: baseline
---

# Evidence-First Claims — No Assertion Without Quoted Evidence

See `.claude/guides/rule-extracts/evidence-first-claims.md` for full DO/DO-NOT blocks, BLOCKED-rationalization corpora, the `cat -v` decode walkthrough, the structural-finding carve-out, and the complete E1/E2/E3 origin narrative.

Diagnostic, root-cause, anomaly, and security claims MUST be grounded in evidence quoted **inline, in the same message as the claim**. Inference is permitted — but labeled as inference, never asserted as fact. The security/anomaly subclass carries the strictest bar: quote the triggering bytes, decoded.

## MUST Rules

### 1. Diagnostic And Root-Cause Claims Cite The Evidence Inline

Any statement of WHY something failed MUST quote the supporting log line, command output, exit code, or file content in the same message. "X failed because Y" without the evidence for Y is BLOCKED; reading the log precedes naming the cause.

**Why:** A symptom is consistent with many causes; naming one before reading the evidence builds the next action on a confident-but-wrong diagnosis. See guide.

### 2. Security / Anomaly Claims Quote The Triggering Bytes, Decoded

Any claim of compromise, injection, tampering, or "suspicious" data MUST quote the exact triggering bytes inline AND decode the WHOLE suspect span (`hexdump -C` / `od -c`) BEFORE characterizing it. A `cat -v` rendering is display encoding, NOT content. Byte-less structural findings substitute inline repro steps + observed output; fabricating a byte-quote OR suppressing a byte-less real finding are BOTH BLOCKED.

**Why:** A false security claim is worse than silence — it triggers escalation and consumes trust real findings need; one hexdump settles whether `e2 80 94` is an em-dash or a payload. See guide.

### 3. An Errored Or Empty Command Is Zero Evidence, Never Confirmation

A command that exited non-zero, hit an invalid flag, timed out, or returned empty provides no findings — it does NOT "confirm" any hypothesis. An errored SECURITY detector is NOT an all-clear: re-run it correctly OR surface "detection did not run; threat status UNKNOWN".

**Why:** An errored command and a clean-but-empty result are indistinguishable in raw output yet opposite in meaning. See guide.

### 4. Inference Is Labeled As Inference; Only Quoted Observation Is Stated As Fact

"I see [quoted X]" is a fact; "this suggests [Y]" is an inference and MUST carry a hypothesis marker. Presenting an inference in the grammar of an observation is BLOCKED.

**Why:** The reader cannot act correctly if they cannot tell known from guessed; fact-grammar is the form every confabulation takes. See guide.

### 5. A Verification Instrument Is Shown Capable Of The OPPOSITE Verdict Before Its Result Is Banked

MUST-3 governs a command that FAILED; this governs one that SUCCEEDED and answered a DIFFERENT question. Before banking a verification result the instrument MUST be shown able to return the opposite verdict. Two BLOCKED shapes: a **self-derived oracle**, whose expected value is computed FROM the subject so both agree by construction; and a **wrong-question instrument** — e.g. a TWO-DOT `git diff base..HEAD` on a branch BEHIND base, which renders base's newer commits as REVERSIONS (use `base...HEAD`).

**BLOCKED rationalizations:** "the command exited 0" / "it returned a real number" / "the assertion passed" / "I read the output myself" / "it's the same check CI runs" / "the diff is the diff, both forms show the changes".

**Why:** A confident wrong answer from a WORKING command is invisible at read time — the transcript shows a clean exit and a plausible result. See guide.

### 6. An Instrument's SCOPE Is Established Before Its Green Is Generalized

MUST-5 asks whether an instrument can fail AT ALL; this asks whether it can fail FOR THIS CLASS. One that PASSES its negative control can still be BLIND to a class its execution model, compiled feature set, mutation point, dependency context, or engine dialect excludes. State the scope a green covers and what it EXCLUDES; generalizing past it is BLOCKED. Five shapes: guide.

**BLOCKED rationalizations:** "the suite is green" / "the negative control passed, so the instrument is sound" / "both runners run the same tests" / "the feature flag only adds tests, it cannot remove coverage" / "more kills is stronger evidence" / "it passes in the suite, standalone is the same thing" / "the in-memory engine is the same SQL".

**Why:** A negative control proves the instrument can MOVE, not that it can SEE the class under review — so a blind green is indistinguishable from a covering one, and more dangerous, since the control makes it look verified.

## MUST NOT

- State a security / compromise / injection / tampering claim without quoting the triggering bytes inline — **Why:** unfalsifiable from the reader's side; triggers costly escalation on a possibly-invented threat.
- Characterize `cat -v` / escaped-byte renderings as content without decoding to the real codepoint first — **Why:** the rendering is not the byte.
- Treat an errored, timed-out, or empty command result as confirmation of any hypothesis — **Why:** absence-of-result is not evidence.
- Assert a root-cause claim before reading the log / output / file that would show the cause — **Why:** the log disambiguates; asserting first builds the next action on a guess.
- Bank a verification result from an instrument never shown able to return the opposite verdict, or generalize a green past the class its instrument could observe — **Why:** a check that cannot fail, or cannot fail for this class, reports `pass` for every input including the ones it exists to catch.

Extended per-bullet rationale: guide § MUST NOT. MUST-5 and MUST-6 each carry their own `**BLOCKED rationalizations:**` corpus inline.

## Trust Posture Wiring — MUST-5 (Opposite-Verdict Capability) + MUST-6 (Instrument Scope)

Applies to the **MUST-5 and MUST-6** clauses ONLY, both added 2026-08-12 via `/sync-from-build` Gate-1 placement; ships canonical-8-field-compliant per `trust-posture.md` MUST-8. One block covers both: they are one contract read at two depths (can it fail at all / can it fail for THIS class) and share a detection surface. The pre-existing rule-wide block below governs MUST-1..4 and is unchanged until itself `/codify`-touched (clause-scoped precedent: `security.md` § Enforcement-Surface Parity, `git.md` § CI-check/merge).

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm any banked verification result came from an instrument demonstrated capable of the opposite verdict, that no assertion derives its expected value from its subject, that no review artefact was built from a two-dot diff, and that any generalized green NAMES the scope it covers and what it excludes); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (whether an instrument can fail, and whether a green was generalized past its reach, are judgments over the session's command history — there is no tool-call-time structural signal, and a lexical detector for this class would itself instance the failure mode).
- **Grace period:** 7 days from clause landing (2026-08-12 → 2026-08-19).
- **Cumulative posture impact:** same-class violations (a result banked with no demonstrated opposite verdict; a self-derived oracle; a review artefact built from `base..HEAD` on a branch behind base; a process-isolated green generalized to the shared-process class; a pass-count reported without the feature set that determined which files compiled; a mutation kill-count banked from a shared-helper mutation whose accept arms also died; a new test file verified only inside the suite; a suite green on a permissive engine generalized to the strict engine the product ships against) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Instrument capability and instrument scope are review-layer judgments over command history, and minting a key would drag `trust-posture.md`, a `self-referential-codify.md` allowlist file, into a self-referential edit; the universal trigger already covers it. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `instrument-discipline.md`, `security.md` § Enforcement-Surface Parity, and `git.md` § CI-check/merge took. These clauses do NOT route to MUST-2's `evidence_free_claim` instant-drop key: that fires on a byte-less security claim, a different violation shape.
- **Receipt requirement:** SessionStart soft-gate `[ack: evidence-first-claims]` IFF `posture.json::pending_verification` includes the `evidence-first-claims` rule_id (shared rule_id; one ack covers MUST-1..6).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/implement` + cc-architect at `/codify` inspect any session that banked a verification result and confirm the transcript shows (a) the instrument producing the OPPOSITE verdict at least once, (b) no assertion whose expected value was computed from its subject, (c) no review artefact derived from a two-dot `base..HEAD` range, and for any generalized green, WHICH (d) runner produced it and whether that execution model can observe the class under review, (e) feature/target set was compiled, (f) mutation layer was used and whether ACCEPT arms SURVIVED, (g) standalone-vs-suite status for a new test file, and (h) engine/dialect the green was obtained on and whether it is the permissive or the strictest one the product ships against. **Semantic tier: COVERED — two bipolar probe pairs ship WITH these clauses.** `.claude/test-harness/probes/evidence-first-claims.probes.json` gains `MUST-5-firing` and `MUST-6-firing`, each an efficacy (`RuleEfficacyAnswer`, violation pole) + no-false-positive (`NoFalsePositiveAnswer`, compliant pole) row, with candidates + answer-key sidecars at `.claude/audit-fixtures/evidence-first-claims/`. All four use `candidate_fixture`, the shape the adapter reads and the shape every pre-existing row in this suite already uses. Dispatchability MEASURED on this change, two-pole on one tree: `coc-probe-dispatch.mjs plan` reports `dispatch_count` 54 → 58 with `suite: evidence-first-claims` rising 4 → 8 and `refusal_count` 0 on both poles (2026-08-12). Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes the dispatcher, so a green CI run is NEVER evidence these probes passed. **An earlier revision of this block claimed no probe row could ship because the adapter would refuse an inline-`scenario` row. That reason was FALSE and is withdrawn** — measured, this suite carries 8 `candidate_fixture` occurrences and 0 `scenario` rows, so the adapter-readable shape was already in use here and feasibility was demonstrated by the sibling MUST-4 pair in the same commit. Phase 2 is RETIRED, not pending (2026-08-14): no hook detector will EVER be built — per § Severity above, a lexical detector for this class would itself instance the failure mode — so no audit fixtures are owed. Gate-review IS the enforcement layer, permanently.
- **Violation scope:** MUST-5 (banked-without-opposite-verdict; self-derived oracle; wrong-question instrument incl. the two-dot diff) + MUST-6 (execution-model, compilation-scope, mutation-point, dependency-context, engine/dialect blindness) ONLY — clause-scoped. MUST-1..4 keep their existing scope under the rule-wide block below.
- **Origin:** See § Origin — 2026-08-04 / 08-07 / 08-10, BUILD stream.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review; `advisory` at hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing (2026-05-31 → 2026-06-07).
- **Cumulative posture impact:** MUST-1/3/4 route cumulative per `trust-posture.md` MUST-4; MUST-2 routes emergency — never double-counted.
- **Regression-within-grace:** emergency downgrade per `trust-posture.md` MUST-4. Independently, MUST-2 is a 1×-instant emergency trigger — key `evidence_free_claim` (1× = drop 1 posture).
- **Receipt requirement:** SessionStart `[ack: evidence-first-claims]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 review-layer — reviewer at `/implement` + cc-architect at `/codify`, paired with the semantic tier below. Phase 2 hook (advisory, planned `detectEvidenceFreeClaim` — NOT yet built; its fixtures land WITH it). Fixtures: `.claude/audit-fixtures/evidence-first-claims/`. Probes: `.claude/test-harness/probes/evidence-first-claims.probes.json` — a bipolar MUST-4 LLM-judge suite (efficacy + no-false-positive + a meta-compliance pair), registered in `.claude/test-harness/eval-manifest.json` as a probe-only entry (`scanner: null`) and dispatched at gate-review via `/test-harness-probe`; it is deliberately NOT in CI (the loom↔csq boundary keeps CI LLM-free). Its disarm-resistance + fixture-hygiene floor is `.claude/test-harness/tests/probe-suite-integrity.test.mjs`.
- **Violation scope:** rule-corpus-wide. MUST-1/3/4 cumulative; MUST-2 emergency.
- **Origin:** See § Origin.

## Distinct From / Cross-References

Extends `verify-resource-existence.md` MUST-2 to ALL diagnostic/anomaly/security claims. Pairs with `recommendation-quality.md` MUST-3, `probe-driven-verification.md`, `user-flow-validation.md` MUST-2. Distinct from `communication.md` (HOW vs WHETHER) and `verify-claims-before-write.md` (code-surface claims at durable-write time vs diagnostic/security claims inline).

**MUST-5 / MUST-6 — 2026-08-04, 08-07 and 08-10, BUILD stream (Rust SDK waves S15 / S19 / S24), landed together at loom 2026-08-12 via `/sync-from-build` Gate-1.** MUST-5's parent set was nine confident wrong answers from WORKING commands in one session, two of which did damage; its two named shapes are the ones `instrument-discipline.md` does not enumerate — a self-derived oracle, and the two-dot diff measured at 31 files against 15 for the three-dot range on the same branch, whose 16 phantom files were flagged as scope creep that would have blocked a merge. MUST-6's parent set was four instruments in ONE wave, each of which PASSED its negative control and was still blind, so MUST-5 alone would have cleared every one; the fifth shape (engine/dialect) was measured 2026-08-10, where a tenant-isolation suite pinned to a permissive in-memory engine was green both BEFORE and AFTER the fix it existed to pin. Per-instance detail and the full shape mechanics: guide § MUST-5 / § MUST-6.

Both entries classified **GLOBAL** on both axes — the contracts name no language runtime and no CLI-native primitive; the runners, feature flags and engines are illustrative EXAMPLES, and the class is language-agnostic (process-isolating vs shared-process runners, marker/feature selection changing which files are collected, permissive-vs-strict engines). Both proposals FLAGGED `rule-authoring.md` Rule 10 and Rule 11 for Gate-1 rather than self-clearing, because the per-lane headroom validator refuses to run outside a loom-class checkout. **Rule 10 disposition — path (a) paired extraction, MEASURED at placement:** the clause bodies were authored compact and the depth (both shape sets, DO/DO-NOT blocks, BLOCKED corpora, per-instance narrative, and the MUST NOT per-bullet rationales) was extracted to `.claude/guides/rule-extracts/evidence-first-claims.md`, which is not baseline-emitted. The two clauses are COUPLED and land together because MUST-6 is defined by reference to MUST-5 ("MUST-5 asks whether an instrument can fail AT ALL"); shipping either alone would ship a dangling reference.

Origin: 2026-05-31 — a Rust SDK session: three escalating assert-before-verify errors (E1 "timeout" misdiagnosis vs a 53s log-visible failure; E2 errored command nearly read as runner-deletion; E3 fabricated "curl|bash prompt-injection" from a `cat -v`-rendered em-dash — the detection grep never ran). User directive after E3: "how can you just fabricate a security claim, its not normal, please investigate fully" → forensics → `/codify`. Full narrative in the guide extract.
