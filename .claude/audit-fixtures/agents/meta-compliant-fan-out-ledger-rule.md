---
name: fan-out-result-ledger
description: Every lane of a parallel dispatch gets a ledger row carrying what it returned before the wave is scored. Fires when a wave is closed with a lane whose return was never written down.
priority: 10
scope: path-scoped
paths:
  - "**/workspaces/**"
  - "**/*wave*.md"
---

# Fan-Out Result Ledger

## MUST Rules

### 1. A Wave MUST Be Scored From Ledger Rows, Never From Recollection Of What Came Back

Before a parallel wave is declared closed, every dispatched lane MUST have a row recording
what it RETURNED — the verdict, or the fact that nothing arrived. Scoring the wave from the
orchestrator's memory of the fan-out is BLOCKED: memory holds the lanes that spoke loudest,
and a lane that returned nothing leaves no trace to be remembered by.

```markdown
# DO — one row per dispatched lane, including the silent one

L1 CLEAN · L2 CLEAN · L3 2 findings · L4 NO RETURN (throttled) → wave NOT closed

# DO NOT — score from what is recalled, so the silent lane is invisible

"three lanes came back clean, one had findings, all dispositioned" → wave closed
```

**Why:** A lane that returns nothing is indistinguishable from a lane that returned nothing
to say, and only a row written at dispatch time preserves the difference.

**BLOCKED rationalizations:**

- "All four came back, I read them as they arrived"
- "If one had failed I would have noticed the error"
- "The findings are in the PR description, that is the record"
- "Writing a row for a clean lane is bookkeeping for its own sake"
- "I can reconstruct the fan-out from the transcript if anyone asks"
- "The wave was four lanes, it is not a lot to hold in mind"

## MUST NOT

- Close a wave in which any lane's row records a return the orchestrator never opened

**Why:** A row asserting delivery without a read is a stronger false clean than no row at
all, because the ledger then vouches for the lane nobody looked at.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/redteam` confirms each
  dispatched lane carries a row and each row names what was returned); `advisory` at the
  hook layer per `hook-output-discipline.md` MUST-2 — whether a recorded return was actually
  read is judgment over the session's history.
- **Grace period:** 7 days from rule landing (2026-08-24 → 2026-08-31).
- **Cumulative posture impact:** same-class violations (a wave closed with an unrowed lane;
  a row recording a return that was never opened) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1
  posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since whether a
  row was written before or after the score is legible only in the session that wrote it.
- **Receipt requirement:** SessionStart soft-gate `[ack: fan-out-result-ledger]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer counts dispatch calls in
  the transcript and ledger rows in the wave file and confirms the two sets match by lane.
  Phase 2 (deferred) — a detector pairing dispatch-tool invocations against ledger rows in
  the wave file, both structural and countable; audit fixtures land WITH that detector at
  `.claude/audit-fixtures/fan-out-result-ledger/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names the
  wave, the lane with no row, and the score it was closed on.
- **Origin:** See § Origin.

## Origin

2026-08-24 — a six-lane wave was closed as clean; the sixth lane had returned nothing, and
no row existed to say so.
