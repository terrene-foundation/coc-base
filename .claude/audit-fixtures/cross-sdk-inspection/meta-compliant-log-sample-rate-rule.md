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

When an emitter drops records — head sampling, tail sampling, a per-key rate limiter, an
adaptive rate that moves with load — every record it DOES emit MUST carry the denominator
that was in force at that emission, as a field on the record itself. Stamping the rate in a
sidecar config, a dashboard annotation, or the emitter's own startup line is BLOCKED: the
consumer that multiplies is reading one record, not the fleet's configuration history.

```python
# DO — the denominator rides on the record, set where the drop decision is made

if rng.random() < rate:
    emit({**event, "sample_rate": round(1 / rate)})   # 1-in-N, at THIS emission

# DO NOT — drop the record and leave the reader to find the rate elsewhere

if rng.random() < rate:
    emit(event)                                        # reader multiplies by a guess
```

**Why:** An adaptive rate changes between emissions, so a consumer that multiplies a count by
a rate read from anywhere except the record is multiplying by a number that was true at some
other moment.

**BLOCKED rationalizations:**

- "The rate is in the deploy config, anyone can look it up"
- "It is 1-in-100 everywhere, it has been for a year"
- "The dashboard already divides by the sample rate"
- "Adding a field to every record costs us ingest volume"
- "We only sample the debug tier, nobody counts those"
- "If the rate changed we would have gotten a deploy notification"

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
