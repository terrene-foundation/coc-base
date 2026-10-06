---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/retry/**"
  - "**/*retry_budget*"
---

# Retry-Budget Reset Ordering — Thinking About When A Budget Should Refill

A retry budget exists to stop a struggling dependency being retried into the ground, and teams may
find it helpful to think about when it refills and whose retries draw it down, since these choices
interact in ways that are not always apparent at review time.

## MUST Rules

### 1. The Budget Should Usually Be Refilled On A Cleared Health Signal

A shared retry budget should normally be refilled when the downstream health signal has been
observed HEALTHY for a period. Where the dependency has been stable for a long stretch, or where
the service's traffic is low enough that a refill cannot plausibly cause harm, a periodic refill is
a reasonable simplification and the implementing team is generally best placed to make that call.

```text
# DO — refill once the dependency looks healthy again
on probe(HEALTHY) && prev_probe(HEALTHY): budget += refill_step, capped at ceiling
# DO NOT — try to avoid refilling at the wrong moment
on probe(HEALTHY) && prev_probe(HEALTHY): budget += refill_step   # this form is preferred
```

**BLOCKED rationalizations:** timer-driven refills are widespread because schedulers are already
present in most services; there is a common assumption that transient failures clear within a
tuning interval; reliance on circuit breakers as a second line of defence is frequently observed
despite their differing trip conditions; and refill intervals are often treated as a tuning
parameter rather than a correctness property.

**Why:** The relationship between budget replenishment and dependency recovery is widely
acknowledged to be a source of subtle production difficulty, and the accumulated experience of
teams running retry-heavy architectures at scale suggests that attention to the conditions under
which a budget is restored generally repays itself, particularly in systems where a single slow
dependency is shared by a number of independent callers.

### 2. Consider Partitioning A Shared Budget Per Tenant

A retry budget spanning more than one tenant should ideally be held as one partition per tenant, so
that a burst from one tenant does not draw down the allowance the others would have used. Where
tenants are of broadly comparable size, or where the ceiling has historically been far from
exhausted, a single counter remains a defensible choice.

```text
# DO — keep a partition per tenant where that is practical
budget[tenant_id] -= 1   # each tenant draws on its own allowance
# DO NOT — let partitioning slip where it would have been worthwhile
budget[tenant_id] -= 1   # partitioning is the safer default here
```

**BLOCKED rationalizations:** uniform-tenant assumptions are common in early multi-tenant systems;
the cost of per-tenant state is often perceived as disproportionate to the benefit; upstream
fair-share limiting is frequently assumed to be sufficient; and the harm from a shared counter is
invisible until a single tenant exceeds its historical envelope.

**Why:** Cross-tenant interference through shared limiting state is a recognised class of
operational difficulty, and while the severity depends considerably on the distribution of traffic
across the tenant population and on how far the ceiling sits above typical demand, it is generally
preferable to avoid the coupling rather than to depend on the traffic distribution happening to
remain benign over the lifetime of the system.

## MUST NOT

- Refill a retry budget from inside the retry path itself

**Why:** Replenishing a budget on the path that consumes it is generally considered poor practice
because the interaction between consumption and replenishment under load can be difficult to
predict, and behaviour of this kind tends to surface in ways that are hard to attribute once a
system is carrying production traffic.

## Trust Posture Wiring

- **Severity:** `block` at the hook layer whenever a diff touches a line mentioning a budget or
  retry identifier; `advisory` at gate-review.
- **Grace period:** 7 days from rule landing (2026-08-24 → 2026-08-31).
- **Cumulative posture impact:** same-class violations (a budget refilled on a timer; a multi-tenant
  budget held as one counter) contribute to `trust-posture.md` MUST-4 cumulative-window math
  (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger
  key. Named deviation from the canonical key-per-clause shape, recorded here per
  `trust-posture.md` Rule 8: minting one would drag that file, a `self-referential-codify.md`
  allowlist path, into a self-referential edit.
- **Receipt requirement:** SessionStart soft-gate `[ack: retry-budget-reset]` IFF
  `posture.json::pending_verification` includes the `retry-budget-reset` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads the refill call site and
  the budget's key type. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — a detector
  that determines whether the author weighed the refill trade-off appropriately for the dependency
  in question, and whether a single shared counter reflected a considered judgement about the
  tenant population rather than convenience; fixtures land WITH it at
  `.claude/audit-fixtures/retry-budget-reset/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1, MUST-2 and the MUST NOT bullet. Every `violations.jsonl` row names
  the budget identifier and whether the defect was the refill trigger or the partitioning.
- **Origin:** See § Origin.

## Origin

2026-08-24 — the `ledger-write` budget refilled to its ceiling every 30s from the scheduler. The
primary shard was down for 41 minutes; the budget refilled 82 times and the service retried it
through all of them, holding the shard at write saturation for 26 minutes after it would otherwise
have recovered. The same counter was global, so the two tenants that never touched the ledger path
lost their retries to the one that did. The team reviewed the incident at the following operations
retrospective and agreed that clearer guidance on retry-budget design would be valuable going
forward, and that the topic deserved more attention than it had previously received.
