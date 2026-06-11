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

## MUST NOT

- State a security / compromise / injection / tampering claim without quoting the triggering bytes inline — **Why:** unfalsifiable from the reader's side; triggers costly escalation on a possibly-invented threat.
- Characterize `cat -v` / escaped-byte renderings as content without decoding to the real codepoint first — **Why:** the rendering is not the byte.
- Treat an errored, timed-out, or empty command result as confirmation of any hypothesis — **Why:** absence-of-result is not evidence.
- Assert a root-cause claim before reading the log / output / file that would show the cause — **Why:** the log disambiguates; asserting first builds the next action on a guess.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review; `advisory` at hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing (2026-05-31 → 2026-06-07).
- **Cumulative posture impact:** MUST-1/3/4 route cumulative per `trust-posture.md` MUST-4; MUST-2 routes emergency — never double-counted.
- **Regression-within-grace:** emergency downgrade per `trust-posture.md` MUST-4. Independently, MUST-2 is a 1×-instant emergency trigger — key `evidence_free_claim` (1× = drop 1 posture).
- **Receipt requirement:** SessionStart `[ack: evidence-first-claims]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 review-layer — reviewer at `/implement` + cc-architect at `/codify`. Phase 2 hook (advisory, planned `detectEvidenceFreeClaim`). Fixtures: `.claude/audit-fixtures/evidence-first-claims/`.
- **Violation scope:** rule-corpus-wide. MUST-1/3/4 cumulative; MUST-2 emergency.
- **Origin:** See § Origin.

## Distinct From / Cross-References

Extends `verify-resource-existence.md` MUST-2 to ALL diagnostic/anomaly/security claims. Pairs with `recommendation-quality.md` MUST-3, `probe-driven-verification.md`, `user-flow-validation.md` MUST-2. Distinct from `communication.md` (HOW vs WHETHER) and `verify-claims-before-write.md` (code-surface claims at durable-write time vs diagnostic/security claims inline).

## Origin

2026-05-31 — kailash-rs session: three escalating assert-before-verify errors (E1 "timeout" misdiagnosis vs a 53s log-visible failure; E2 errored command nearly read as runner-deletion; E3 fabricated "curl|bash prompt-injection" from a `cat -v`-rendered em-dash — the detection grep never ran). User directive after E3: "how can you just fabricate a security claim, its not normal, please investigate fully" → forensics → `/codify`. Full narrative in the guide extract.
