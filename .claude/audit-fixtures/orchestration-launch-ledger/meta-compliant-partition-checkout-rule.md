---
name: worker-partition-checkout
description: A worker that takes a queue partition MUST record the checkout in a durable ledger before it begins draining. Fires when a session re-assigns a partition on the strength of an idle-looking consumer-group offset.
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

Every worker taking a partition MUST append a checkout row — partition id, worker id,
lease expiry, status — to the durable checkout ledger BEFORE it reads its first message,
and MUST read that ledger before taking any partition. Re-assigning a partition on the
strength of a stalled consumer-group offset is BLOCKED: an offset that has not moved is
equally consistent with a dead worker and with a live one mid-batch on a slow sink.

```
# DO — the checkout lands first, and the ledger is read before the take

append {p: 7, worker: w-14, lease: 2026-08-20T11:04Z, status: held}; then poll
read ledger -> p=7 held by w-14, lease live -> do NOT take p=7

# DO NOT — take the partition because the offset looks stale

"offset on p=7 has not moved in 9 minutes, w-14 must be gone" -> take p=7
```

**Why:** A stalled offset is produced by a dead worker and by a healthy one blocked on a
slow sink alike, so the inference is unfalsifiable at the moment it is made.

**BLOCKED rationalizations:**

- "The offset has been stuck for nine minutes, nothing takes that long"
- "The lease is nearly expired anyway, I am just getting ahead of it"
- "If the old worker comes back it will notice and drop the partition"
- "Writing the row first costs a round trip on every take"
- "The consumer group would have rebalanced if the worker were alive"
- "I checked the dashboard and the worker looked idle"

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
