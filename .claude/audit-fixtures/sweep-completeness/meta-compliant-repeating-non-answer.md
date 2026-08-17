---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/04-validate/**"
  - "**/sweep-*.md"
---

# Repeating Non-Answers — A Verdict That Never Changes MUST Escalate

A step that reports "I cannot adjudicate this here" is telling the truth. Told
once it is honest labeling; told every run it is a slot in the report that reads
as coverage and answers nothing. Honesty is what makes it invisible: nobody
reviews a row that is not wrong.

## Scope

ANY repeating protocol step that emits a placeholder verdict in place of a
finding — a sweep gate, a conformance walk, a release checklist item, a periodic
audit row.

## MUST Rules

### 1. The Same Unadjudicated Verdict On Three Consecutive Runs MUST Escalate

A step emitting the SAME unadjudicated verdict on three consecutive runs MUST NOT
emit it a fourth time. The third run IS the Decision Point, and it MUST resolve
one of two ways: author the missing check, or record a dated disposition carrying
`owner`, `issue` and `until`. Filing an issue is not a disposition; a proposal to
tool-back the step later is not a disposition. The count is derived from the
committed reports, never from a private counter a session can rewrite.

```markdown
# DO — third consecutive run, surfaced and resolved
DECISION [Sweep 5] manual-supplement-required x3 — author the check, or disposition it
unadjudicated-disposition:v1 key="Sweep 5/..." issue=1722 owner=@owner until=2026-09-30

# DO NOT — print the identical non-verdict a fourth time
FINDING [Sweep 5] manual-supplement-required
```

**BLOCKED rationalizations:**

- "It is not claiming clean, so there is nothing to correct"
- "The row is honest — every word of it is true"
- "Nothing changed since the last run, so there is nothing new to report"
- "The tool still does not exist and building it is not this session's work"
- "The issue is filed and open, and that IS the disposition"
- "It escalated last time too, so this escalation carries no new information"
- "Three is arbitrary; the threshold could just as well be five"

**Why:** A verdict that never discriminates is not evidence, and repeated
indefinitely it consumes a report slot while answering nothing. Repetition is the
only signal a placeholder has become permanent.

### 2. A Disposition Suppresses, And Never Resets The Count

A recorded disposition MUST suppress escalation only until its `until` date, and
the streak MUST keep climbing underneath it. When `until` passes, escalation
resumes on its own with no counter cleared by anyone. A disposition that resets
the count is BLOCKED, because a chain of short-dated exemptions would then hold a
dead gate open forever while the count read one the whole time.

```markdown
# DO — suppress, and let the streak keep climbing
3 x Sweep 5/manual-supplement-required (suppressed, live disposition to 2026-09-30)

# DO NOT — clear the count on the disposition
1 x Sweep 5/manual-supplement-required (counter reset on disposition)
```

**BLOCKED rationalizations:**

- "The disposition means it has been dealt with, so the count should start over"
- "Keeping the count climbing under an accepted exemption is double-counting"
- "A permanent exemption is cleaner than renewing a dated one every quarter"

**Why:** A reset makes a permanent exemption expressible in the grammar, and a
permanent exemption is the silence this rule exists to break.

## MUST NOT

- Re-emit an unadjudicated verdict at or past the threshold with neither an
  escalation nor a live disposition — **Why:** the repetition is the only signal
  the placeholder has become permanent, and suppressing it leaves a dead gate
  printing forever.
- Offer a threshold the emitting party may raise — **Why:** a gate whose severity
  the gated party sets is not a gate.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review; `advisory` at the hook layer,
  the check being report-scoped with no tool-call-time signal.
- **Grace period:** 7 days from clause landing.
- **Cumulative posture impact:** same-class violations route to the cumulative
  window (3x same-rule / 5x total in 30d → drop 1 posture).
- **Regression-within-grace:** the GENERIC `regression_within_grace` trigger; no
  dedicated key, recorded as a named deviation.
- **Receipt requirement:** SessionStart soft-gate `[ack: repeating-non-answer]`
  IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** a scanner deriving the streak from the committed
  reports, plus gate-review for the wording the lexical grammar cannot see.
- **Violation scope:** MUST-1, MUST-2, and the two MUST NOT bullets.
- **Origin:** See § Origin.

## Origin

2026-08-16 — one sweep gate emitted the same unadjudicated verdict for five
consecutive sessions; the fifth report named the pattern and nothing consumed it.
