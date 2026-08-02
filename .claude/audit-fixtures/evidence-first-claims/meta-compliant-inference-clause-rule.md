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

### 1. Inference Is Labeled As Inference; Only Quoted Observation Is Stated As Fact

"I see [quoted X]" is a FACT and MUST be stated in the grammar of an observation. "This
suggests [Y]" is an INFERENCE and MUST carry an explicit hypothesis marker naming what the
instrument could not decide. Presenting an inference in the grammar of an observation is
BLOCKED, and a conclusion whose supporting instrument cannot distinguish it from its
negation MUST NOT be asserted at all until a discriminating check has run.

```text
# DO — the quoted bytes are stated as fact; the leap is marked, and its blind spot named
$ find work/lane-a -newermt '-20 min' | wc -l   ->  0
Observed: zero files modified in the last 20 minutes.
HYPOTHESIS: lane-a may have stalled. This instrument cannot distinguish a stalled lane
from one that finished and committed, so I am running `git log --since` before acting.

# DO NOT — the same quoted bytes, then the conclusion in fact-grammar
$ find work/lane-a -newermt '-20 min' | wc -l   ->  0
lane-a is stalled.
```

**BLOCKED rationalizations:**

- "The inference is obvious from the quoted output"
- "Hedging every conclusion makes the report unreadable"
- "I quoted the evidence, so the reader can judge for themselves"
- "A hypothesis marker is padding when I am confident"
- "The next step would have caught it if I were wrong"
- "Zero results can only mean one thing here"

**Why:** The reader cannot act correctly if they cannot tell known from guessed, and
fact-grammar is the form every confabulation takes.

## MUST NOT

- State a conclusion in the grammar of an observation when the instrument that produced the
  quoted evidence cannot distinguish that conclusion from its negation.

**Why:** An instrument that returns the same bytes for both answers has decided nothing, so
a confident sentence built on it is unfalsifiable from the reader's side.

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
