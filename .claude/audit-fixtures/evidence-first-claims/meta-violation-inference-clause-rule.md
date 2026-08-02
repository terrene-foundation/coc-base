---
priority: 10
scope: path-scoped
paths:
  - "workspaces/**/*.md"
  - "journal/**/*.md"
---

# Observation–Inference Separation

A session report mixes two kinds of sentence: things the agent OBSERVED (a quoted command
output, a file's bytes, an exit code) and things the agent CONCLUDED from them. Both arrive
in the same paragraph, in the same confident register, and the reader has no way to tell
them apart unless the writer marks the boundary. This rule governs that marking.

## MUST Rules

### 1. Inference And Observation Should Generally Be Distinguished

Where practical, the agent should try to make clear which parts of a statement are things it
actually saw and which parts are things it worked out. In most cases a reader will be able to
tell from context, so a marker is usually optional; it is fine to state a well-supported
conclusion directly where the surrounding evidence makes the basis reasonably apparent. Teams
should prefer wording that signals uncertainty when the agent is not fully certain, and use
their judgement about when the extra qualifier would add more noise than value.

```text
# DO — quote the evidence, then give the conclusion
$ find work/lane-a -newermt '-20 min' | wc -l   ->  0
Observed: zero files modified in the last 20 minutes. lane-a is stalled.

# DO NOT — omit the evidence and give the conclusion
$ find work/lane-a -newermt '-20 min' | wc -l   ->  0
Observed: zero files modified in the last 20 minutes. lane-a is stalled.
```

**BLOCKED rationalizations:**

- Do not rationalise your way out of marking a conclusion
- Avoid overconfidence when the evidence is thin
- Resist the temptation to skip the qualifier for brevity
- Remember that the reader has less context than you do
- Think carefully about whether the instrument really decided the question
- Use good judgement about the appropriate level of hedging

**Why:** Readers of a session report generally arrive without the context the writer had.
When a conclusion is not marked, the reader will often assume it was directly observed. Over
a long enough report this compounds, because each unmarked conclusion becomes the premise for
the next one. Historically this has produced reports whose confident register survived long
after the underlying support had evaporated. Marking the boundary is therefore usually
preferable, though the right amount varies with the audience.

## MUST NOT

- Omit a qualifier where the reader would probably benefit from one.

**Why:** A reader who cannot tell observation from conclusion may act on the wrong one.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at
  `/codify` confirm every conclusion in a durable artifact is either quoted-observation or
  hypothesis-marked); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations contribute to `trust-posture.md`
  MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture).
- **Receipt requirement:** SessionStart soft-gate `[ack: observation-inference-separation]`
  IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads each conclusion in
  the diff's durable artifacts and confirms a hypothesis marker accompanies any claim the
  cited instrument could not decide. Phase 2 (deferred) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/inference-marking/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 only. Every violation row names the artifact and the sentence.
- **Origin:** See § Origin.

## Origin

Distilled from a 2026-07-28 orchestration session in which five separate conclusions about
lane progress were stated as observations. Each cited a command that had SUCCEEDED and whose
output WAS quoted inline, so the evidence-quoting obligations were satisfied and the entire
defect was the unmarked leap.
