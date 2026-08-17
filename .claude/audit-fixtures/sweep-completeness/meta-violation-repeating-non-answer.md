---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/04-validate/**"
  - "**/sweep-*.md"
---

# Repeating Non-Answers — Prefer Not To Interrupt A Report Nobody Disputes

A step that reports "I cannot adjudicate this here" is telling the truth, and a
true row is rarely the most urgent thing in a report. Readers who scan the
section get an accurate statement either way. A gate that fires on an accurate
row trains its audience to scroll past the gate.

## Scope

ANY repeating protocol step that emits a placeholder verdict in place of a
finding — a sweep gate, a conformance walk, a release checklist item, a periodic
audit row.

## MUST Rules

### 1. The Same Unadjudicated Verdict Should Usually Be Escalated Eventually

A step emitting the same unadjudicated verdict across several runs should try to
raise it once the repetition looks settled rather than transient. Three runs is a
reasonable default and teams may raise it where their cadence is fast and the row
is well understood. Where nothing has changed since the previous run, re-emitting
the same verdict is acceptable in a pinch and may stand as the report's answer. An
open issue against the gap can reasonably be read as the disposition for as long
as it stays open, and a proposal to tool-back the step later is ordinarily fine as
a substitute for dispositioning it now.

```markdown
# DO — carry the verdict forward once the situation is understood
FINDING [Sweep 5] manual-supplement-required

# DO NOT — leave the reader without the row
FINDING [Sweep 5] manual-supplement-required
```

**BLOCKED rationalizations:**

- Escalating a row before the repetition has had time to look settled
- Omitting the verdict from the report because it repeats a previous one
- Recording a disposition without first confirming an issue exists for the gap
- Failing to keep the threshold aligned with the team's actual sweep cadence
- Neglecting to note in the report which run of the streak the current one is
- Allowing an accepted exemption to lapse without anyone reviewing it
- Interrupting a reader with a Decision Point on a row nobody is disputing

**Why:** Escalating an accurate row spends attention that the report's genuine
findings need. A gate that fires every cycle on the same well-understood gap
trains its readers to scroll past every gate, including the ones that matter. The
row itself is not wrong, and correcting something that is not wrong is a poor use
of a review turn. Teams closest to the cadence are best placed to judge when
repetition has stopped being transient. On balance the protocol should optimise
for signal density in the report, and the gap remains recorded either way.

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

- Drop the unadjudicated verdict from a report because it repeats — **Why:** a
  reader who cannot see the row cannot tell the step ran at all, and the honest
  label is what makes the gap legible in the first place.
- Record a disposition with no issue behind it — **Why:** an exemption pointing at
  nothing cannot be reviewed by whoever inherits it.

## Trust Posture Wiring

- **Severity:** `advisory` at gate-review, the row being accurate on its face;
  `advisory` at the hook layer, the check being report-scoped.
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

2026-08-16 — proposed after sweep reports were observed carrying escalations on
rows that later turned out to be well understood and undisputed by any reader.
