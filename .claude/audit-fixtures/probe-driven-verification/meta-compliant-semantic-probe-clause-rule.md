---
priority: 10
scope: path-scoped
paths:
  - ".claude/test-harness/**"
  - ".claude/hooks/**"
---

# Semantic-Assertion Instrument Selection

A harness assertion asks one of two questions. A STRUCTURAL question ("does this file exist",
"did the process exit 0", "is this key present") has a decidable mechanical answer. A SEMANTIC
question ("did the response recommend something", "did the refusal cite the loaded rule") does
not. This rule governs which instrument each question gets.

## MUST Rules

### 1. Semantic Verification MUST Be Probe-Driven, Never Regex Or Keyword

Any harness assertion whose subject is the MEANING of system output MUST be scored by a probe
— an LLM judge with a JSON-schema answer, a subprocess verifier, an AST walker, or a domain
oracle. Scoring a semantic property by regex, substring, or keyword count is BLOCKED. A
structural question MUST NOT be escalated to a probe either: file existence, exit codes, and
key presence are decidable, and an LLM judge over a decidable question adds non-determinism
for nothing.

```text
# DO — the semantic question goes to a probe; its verdict is read from a typed answer
verdict = probe(response, schema="RecommendationProbeAnswer")
assert verdict.contains_pick and verdict.implications_present

# DO NOT — the same semantic question scored by substring presence
assert "Recommend:" in response       # passes on "I cannot Recommend: anything here"
```

**BLOCKED rationalizations:**

- "The regex is a good enough proxy for now"
- "A probe is too slow to run on every assertion"
- "The string only appears when the behaviour actually happened"
- "We can tighten the pattern if it ever false-passes"
- "LLM judges are non-deterministic, so regex is more rigorous"
- "The reviewer reads the output anyway, so the assertion is belt-and-braces"

**Why:** A regex answers whether a string appeared, and the harness exists to answer whether a
behaviour occurred. Over a corpus the two diverge silently, so the pass rate stops tracking
the property it claims to measure.

## MUST NOT

- Report a harness green when any semantic assertion in it was scored lexically.

**Why:** A green built on a lexical proxy manufactures confidence, which is worse than no
harness because it forecloses the investigation that would have found the regression.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at
  `/codify` classify every harness assertion as structural or semantic and confirm each
  semantic one carries a probe); `advisory` at the hook layer per `hook-output-discipline.md`
  MUST-2.
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations contribute to `trust-posture.md`
  MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture).
- **Receipt requirement:** SessionStart soft-gate `[ack: semantic-instrument-selection]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — for every assertion in the diff's
  harness files, classify structural | semantic | unknown and fail the gate on any semantic
  assertion with no probe definition. Phase 2 (deferred) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/semantic-probe-coverage/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 only. Every violation row names the assertion and its file.
- **Origin:** See § Origin.

## Origin

Distilled from a case probe whose six controls were each scored by counting whether a lane's
name appeared in a guard's emitted prose. All six returned zero, which read as six clean
controls; the guard had never been invoked over its real input contract at all.
