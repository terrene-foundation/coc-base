---
name: telemetry-sampling-floor
description: The declared trace-sampling floor holds for the whole life of an open incident, and ingest cost is cut somewhere other than the signal. Fires when a session lowers the sampling rate while an incident is open.
priority: 10
scope: path-scoped
paths:
  - "**/observability/**"
  - "**/incidents/**"
---

# Telemetry Sampling Floor

## MUST Rules

### 1. Sampling MUST NOT Be Lowered Below The Declared Floor While An Incident Is Open

While an incident is open, the session MUST hold the trace-sampling rate at or above the
floor declared for the affected service, for the whole life of the incident. Lowering it to
bring ingest spend back inside budget is BLOCKED, however large the overspend: the spans
dropped are the ones that would have shown the failure, and they cannot be re-collected
afterwards. Cost is cut on the healthy services, on span attributes, or on retention — never
on the rate for the service under investigation.

```markdown
# DO — hold the floor and take the cost out of somewhere that is not the signal

"Ingest is running 3x budget. Dropping debug-level spans on the six healthy services holds
the 1-in-50 floor on the one that is failing."

# DO NOT — lower the floor because the bill is the loudest number on the screen

"Ingest is running 3x budget. Sampling down to 1-in-500 across the board until this settles."
```

**Why:** A span not sampled during the incident is gone, so a rate lowered to save money spends
an unrecoverable asset to protect a recoverable one.

**BLOCKED rationalizations:**

- "We already have enough traces from the first hour"
- "One in five hundred still catches anything systemic"
- "I will put the rate back as soon as the spend settles"
- "The error logs cover what the traces would have shown"
- "Nobody has asked for traces from the last twenty minutes"
- "The budget alert is a hard limit and the floor is a guideline"

## MUST NOT

- Restore a lowered sampling rate without naming the window it was low for

**Why:** An unnamed gap reads as absence of failures rather than absence of data, and the next
reader cannot tell the two apart.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms the rate
  declared for an affected service was not lowered between incident open and incident close);
  `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether an incident was
  open at the moment of a config change is a judgment over two timelines.
- **Grace period:** 7 days from rule landing (2026-08-24 → 2026-08-31).
- **Cumulative posture impact:** same-class violations (a rate lowered below the declared floor
  while an incident was open; a restored rate with no gap window named) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5×
  total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key;
  named deviation recorded per `trust-posture.md` Rule 8, since which service an incident
  affects is resolvable only against the incident record.
- **Receipt requirement:** SessionStart soft-gate `[ack: telemetry-sampling-floor]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer compares the commit
  timestamp of any sampling-rate change against the open and close timestamps on the incident
  record. Phase 2 (deferred) — a detector comparing a parsed rate value in the diff against the
  floor in the service manifest, both structural; fixtures land WITH that detector at
  `.claude/audit-fixtures/telemetry-sampling-floor/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names the
  service, the floor, the rate it was set to, and the window.
- **Origin:** See § Origin.

## Origin

2026-08-24 — a checkout-latency incident ran four hours with the rate at 1-in-500 from minute
forty, and the root-cause span was never sampled.
