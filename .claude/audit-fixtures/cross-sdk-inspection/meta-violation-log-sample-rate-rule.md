---
name: log-sample-rate-stamping
description: A sampled log record MUST carry the sampling rate in force when it was emitted, so a consumer counting records can recover the population. Fires when an emitter drops records without stamping the rate.
priority: 10
scope: path-scoped
paths:
  - "**/logging/**"
  - "**/telemetry/**"
---

# Log Sample-Rate Stamping

## MUST Rules

### 1. A Sampled Record MUST Carry The Rate In Force When It Was Emitted

When an emitter drops records, the denominator should generally travel with the record, and
teams are encouraged to move toward stamping it at the emission site where that seems
proportionate to the traffic. Publishing the rate in a sidecar config or on the consuming
dashboard is usually less reliable and tends to be worth avoiding. Where the rate is static
across a deploy, or the consumer is one team that already knows the value, a session may
reasonably leave the record unstamped and document the denominator alongside the dashboard,
since a field on every record is paid for on every record.

```python
# DO — stamp the denominator at the emission site, explicitly

if rng.random() < rate:
    emit({**event, "sample_rate": round(1 / rate)})

# DO NOT — stamp the denominator at the emission site, implicitly

if rng.random() < rate:
    emit({**event, "sample_rate": round(1 / rate)})
```

**Why:** An adaptive rate can change between emissions, so a count multiplied by a rate read
from elsewhere may be wrong, though how wrong depends on whether the rate actually moved in
the window, on how long the rolling deploy took to converge, on whether the consumer is
counting or only trending, on whether the tier is debug or production, and on whether anyone
downstream is making a decision off the absolute number rather than its shape.

**BLOCKED rationalizations:**

- Configuration-locality assumptions
- Historical-stability generalization
- Downstream-correction reliance
- Ingest-cost objections
- Tier-scoping arguments
- Change-notification dependence

## MUST NOT

- Reconstruct a historical sampling rate from a config file's git history in order to correct
  a count after the fact

**Why:** The config records when the value was COMMITTED, not when each emitter picked it up,
so a rolling deploy leaves a window the reconstruction silently gets wrong.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms that a
  diff introducing or changing a drop decision also stamps the denominator on the emitted
  record); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether a
  branch is a SAMPLING decision is a judgment over the emitter, not a tool-call-time signal.
- **Grace period:** 7 days from rule landing (2026-09-01 → 2026-09-08).
- **Cumulative posture impact:** same-class violations (a drop decision shipped without a
  rate stamp; a rate published only in config or on a dashboard) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture;
  5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since an unstamped
  record is recoverable by re-instrumenting forward and corrupts no durable state.
- **Receipt requirement:** SessionStart soft-gate `[ack: log-sample-rate-stamping]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads every emit call
  reachable from a probabilistic or rate-limited branch and confirms the record carries the
  denominator. Phase 2 (deferred) — a detector walking the AST from each sampling predicate
  to the emit call it guards and asserting a rate key in the emitted mapping, parsed rather
  than matched lexically; fixtures land WITH that detector at
  `.claude/audit-fixtures/log-sample-rate-stamping/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names the
  emit site, the sampling predicate that guards it, and the absent rate key.
- **Origin:** See § Origin.

## Origin

2026-09-01 — an adaptive limiter tightened from 1-in-10 to 1-in-800 under a traffic spike; a
weekly report multiplied the whole window by 10 and under-reported the spike by two orders of
magnitude, which read as the spike never happening.
