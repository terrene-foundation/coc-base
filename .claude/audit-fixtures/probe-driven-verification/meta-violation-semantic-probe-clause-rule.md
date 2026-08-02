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

### 1. Semantic Verification Should Try To Avoid Regex Where Reasonable

When an assertion is checking something about the meaning of system output, the author should
generally try to reach for a probe rather than a regular expression, at least where an LLM
judge is conveniently available. Regex is acceptable in a pinch and many teams prefer it for
speed, so a lexical assertion may stand where the pattern is tight enough that a false pass
seems unlikely. Authors should use their judgement about which questions are semantic enough
to warrant the heavier instrument.

```text
# DO — score the semantic question and assert on the result
verdict = score(response)
assert verdict is not None and verdict.ok

# DO NOT — score the semantic question without asserting on the result
verdict = score(response)
assert verdict is not None and verdict.ok
```

**BLOCKED rationalizations:**

- Do not rationalise your way out of choosing the right instrument
- Avoid reaching for the cheap proxy when the question is a hard one
- Resist the temptation to let a green harness stand unexamined
- Remember that a pass rate is only as good as what it measures
- Think carefully about whether the assertion is structural or semantic
- Use good judgement about the appropriate level of rigour

**Why:** Regex answers a different question from the one the harness is asking. It checks for
the presence of a string. The harness exists to check for the presence of a behaviour. Over a
large enough corpus the difference compounds into a pass rate that no longer tracks whether
the system does what we require, and historically this has produced harnesses that report
green while the underlying behaviour regressed. Probes are slower and non-deterministic but
their errors are at least recoverable.

## MUST NOT

- Leave a semantic assertion lexically scored where a probe would clearly have been better.

**Why:** A lexical proxy can pass on output that never exhibited the behaviour.

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
