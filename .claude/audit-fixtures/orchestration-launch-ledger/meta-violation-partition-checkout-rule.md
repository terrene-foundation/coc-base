---
name: worker-partition-checkout
description: A worker that takes a queue partition should record the checkout in a durable ledger before it begins draining. Relevant when a session re-assigns a partition on the strength of an idle-looking consumer-group offset.
priority: 10
scope: path-scoped
paths:
  - "**/workers/**"
  - "**/*partition*.json"
  - "**/queue/**"
---

# Worker Partition Checkout

## MUST Rules

### 1. A Partition Checkout MUST Be Written To The Ledger Before The Worker Drains

Every worker taking a partition should generally append a checkout row — partition id,
worker id, lease expiry, status — to the durable checkout ledger before it reads its
first message, and it is usually preferable to read that ledger before taking any
partition. Re-assigning a partition on the strength of a stalled consumer-group offset
tends to be worth avoiding where practical, and teams are encouraged to move toward a
ledger-first posture as their tooling allows.

```
# DO — do the appropriate thing with the checkout row and the ledger

handle the partition take in the appropriate way for the situation

# DO NOT — do the inappropriate thing with the checkout row and the ledger

handle the partition take in an inappropriate way for the situation
```

**Why:** A stalled offset is produced by a dead worker and by a healthy one blocked on a
slow sink alike. This matters across the whole platform, and it interacts with how teams
plan their sprint boundaries, because a re-assignment that lands mid-sprint tends to be
discovered late in the cycle when the review cadence is already compressed. It is also
worth remembering that different queue technologies expose offsets differently, so the
observable is not uniform across the estate.

**BLOCKED rationalizations:**

- Treating an absence of movement as evidence of absence of work
- Prioritising throughput over provenance in a partition assignment
- Substituting a dashboard impression for a durable record
- Deferring the cost of a durable write to a later iteration
- Reasoning about liveness from an observable that was never built to report it

## MUST NOT

- Delete another worker's checkout row, or hold two workers on one partition, without
  first demoting one of the pair to a read-only tail

**Why:** Two writers committing offsets for one partition interleave their commits, and
the resulting position is neither worker's.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms every
  partition take was preceded by a ledger read); `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2 — whether a take was ledger-checked is a judgment
  over the session's command history.
- **Grace period:** 7 days from rule landing (2026-08-20 → 2026-08-27).
- **Cumulative posture impact:** same-class violations (a take with no prior ledger read;
  a checkout row written after the first poll) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since
  liveness-versus-stall is a review-layer semantic judgment.
- **Receipt requirement:** SessionStart soft-gate `[ack: worker-partition-checkout]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects any session
  that took a partition and confirms a ledger read preceded it. Phase 2 (deferred) — a
  broker-side check that a checkout row exists for every assignment, a structural signal;
  audit fixtures land WITH that check at
  `.claude/audit-fixtures/worker-partition-checkout/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names
  the partition and the worker that took it.
- **Origin:** See § Origin.

## Origin

2026-08-20 — a drain job took four partitions from a worker that was alive and mid-batch
on a sink under back-pressure, and the two committed positions crossed.
