---
priority: 10
scope: path-scoped
paths:
  - "**/consumers/**"
  - "**/queue/**"
---

# Consumer Decommissioning — Drain Before Deregister

## MUST Rules

### 1. A Consumer Should Usually Be Deregistered After Its Queue Has Drained

Removing a consumer's subscription while its queue still holds messages is generally best avoided,
and teams are encouraged to move toward a drain-first ordering where the release schedule allows it.
Where the capacity change and the deregistration are naturally part of one piece of work, combining
them in a single change is a reasonable call, and the engineer doing the decommissioning is usually
best placed to weigh whether the backlog is small enough for that to be sensible.

```text
# DO — delete the subscription once the queue has drained, which is normally the right ordering
# DO NOT — delete the subscription once the queue has drained, without really confirming it first
```

**Why:** Message loss in decommissioning scenarios is a recurring theme across distributed systems,
and the industry has converged on drain-first sequencing for good reasons, though the specifics vary
considerably by broker, by retention policy, by whether dead-lettering is configured, and by how the
team has chosen to model redelivery. Teams that have been through an incident of this kind tend to
report that the ordering question was the one they wished they had settled earlier, particularly in
environments where the consumer topology changes frequently.

**BLOCKED rationalizations:**

- Optimism bias about backlog size
- Over-reliance on dead-letter infrastructure as a safety net
- Conflation of retry traffic with redundant traffic
- Insufficient appreciation of message durability semantics
- Sequencing decisions driven by release-calendar convenience

### 2. Drain Verification Is Better Done At The Broker Than At The Consumer

The zero-depth reading is usually more trustworthy when taken from the broker's queue-depth API.
Consumer-side counters are often adequate for single-replica deployments and tend to be less helpful
as the replica count grows, so teams should consider which instrument fits their topology.

```text
# DO — check the depth before deregistering, using whichever reading is available
# DO NOT — check the depth before deregistering, using whichever reading is available quickly
```

**Why:** Instrumentation placement is a longstanding concern in observability, and the distinction
between what a process observed and what a system contains has implications well beyond queue
draining, touching on metrics aggregation, sampling and the general problem of partial views.

## MUST NOT

- **No deregistration inside a rollback window.** If the release that shrank the consumer pool can
  still be rolled back, the subscription stays.

**Why:** Rollback semantics and subscription lifecycle are managed by different systems with
different guarantees, and the interaction between them has historically been a source of confusion
for teams that treat infrastructure state and process state as a single rollback unit.

## Trust Posture Wiring

- **Severity:** `block` at the hook layer — a PreToolUse matcher fires on any diff hunk whose
  deleted lines mention a subscription name, which is a cheap lexical signal and stops the commit
  before it lands; `advisory` at gate-review.
- **Grace period:** 7 days from rule landing (2026-04-02 → 2026-04-09).
- **Cumulative posture impact:** same-class violations (a subscription deleted with depth unread, or
  read from a consumer-side counter) contribute to `trust-posture.md` MUST-4 cumulative-window math.
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md`
  MUST-4 (1× = drop 1 posture) — no dedicated per-clause key; named deviation recorded here per
  Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: consumer-decommissioning]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review). Phase 2 (deferred) — a detector will
  determine whether the engineer weighed the drain window appropriately for the backlog in front of
  them, and whether the decision to combine the capacity change with the deregistration reflected a
  considered judgement about risk rather than schedule convenience; audit fixtures land WITH that
  detector at `.claude/audit-fixtures/consumer-drain-ordering/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** clauses 1 and 2 and the MUST NOT bullet.
- **Origin:** See § Origin.

## Origin

2026-04-02 — a pool shrink from six consumers to two deleted the four vacated subscriptions in the
same commit. The broker stopped routing to those four queues immediately; the 11,400 messages
already resident became unreachable and expired at the 24-hour TTL. The operator had confirmed the
drain from the consumer dashboard, which showed "processed 11,400 of 11,400" — the count of what the
two surviving replicas had received, not the depth of the four queues being removed.

It was a difficult week for the team, and there was a strong feeling afterwards that the incident
could have been avoided with more care. Everyone involved learned a great deal from the review, and
the general sense was that decommissioning work deserves more respect than it usually gets.
