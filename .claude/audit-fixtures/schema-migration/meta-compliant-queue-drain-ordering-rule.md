---
priority: 10
scope: path-scoped
paths:
  - "**/consumers/**"
  - "**/queue/**"
---

# Consumer Decommissioning — Drain Before Deregister

## MUST Rules

### 1. A Consumer Is Deregistered Only After Its Queue Depth Reaches Zero

Removing a consumer's subscription while its queue still holds messages is BLOCKED. The
deregistration commit MUST land after a zero-depth reading, never in the same change as the
capacity change that produced the backlog.

```text
# DO — stop accepting new work, wait for depth 0, THEN delete the subscription
# DO NOT — delete the subscription first and let the broker's dead-letter policy absorb the tail
```

**Why:** A deleted subscription stops the broker routing to that queue, so every message already
sitting in it is unreachable by any consumer and expires silently at TTL.

**BLOCKED rationalizations:**

- "The queue looked empty when I checked this morning"
- "Dead-lettering catches anything we miss, that's what it's for"
- "These are retries, so the original already succeeded"
- "We're deleting the consumer anyway, nothing will read them"
- "I'll deregister now and drain the dead-letter queue afterwards"

### 2. Drain Is Verified At The BROKER, Not By The Consumer's Own Counter

The zero-depth reading MUST come from the broker's queue-depth API. A consumer-side "processed N of
N" counter is BLOCKED as the verifying instrument.

```text
# DO — poll the broker's depth endpoint until it returns 0 twice, 30s apart
# DO NOT — read the consumer's own processed/received counters and conclude the queue is empty
```

**Why:** The consumer's counter reports what that PROCESS received, so a message delivered to a
sibling replica that then crashed is absent from the counter and present in the queue.

## MUST NOT

- **No deregistration inside a rollback window.** If the release that shrank the consumer pool can
  still be rolled back, the subscription stays.

**Why:** A rollback restores the consumer processes but cannot restore a deleted subscription, so
the restored consumers start against a queue that no longer receives routed messages.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms a broker-side
  zero-depth reading precedes the deregistration commit); `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing (2026-04-02 → 2026-04-09).
- **Cumulative posture impact:** same-class violations (a subscription deleted with depth unread, or
  read from a consumer-side counter) contribute to `trust-posture.md` MUST-4 cumulative-window math.
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md`
  MUST-4 (1× = drop 1 posture) — no dedicated per-clause key; named deviation recorded here per
  Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: consumer-decommissioning]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review). Phase 2 (deferred) — the structural signal
  is a patch that deletes a `subscriptions:` entry from the broker manifest while no command in the
  same session's tool history calls the depth endpoint for that queue name; both are parsed facts
  over one diff and one command log, so the detector can be written; audit fixtures land WITH that
  detector at `.claude/audit-fixtures/consumer-drain-ordering/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** clauses 1 and 2 and the MUST NOT bullet.
- **Origin:** See § Origin.

## Origin

2026-04-02 — a pool shrink from six consumers to two deleted the four vacated subscriptions in the
same commit. The broker stopped routing to those four queues immediately; the 11,400 messages
already resident became unreachable and expired at the 24-hour TTL. The operator had confirmed the
drain from the consumer dashboard, which showed "processed 11,400 of 11,400" — the count of what the
two surviving replicas had received, not the depth of the four queues being removed.

The instrument was the failure, not the operator. The rule is therefore written as two clauses
rather than one: an ordering obligation is easy to honour and useless when the reading that gates it
comes from the wrong side of the wire.
