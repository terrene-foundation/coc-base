---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/retry/**"
  - "**/*retry_budget*"
---

# Retry-Budget Reset Ordering — The Health Signal Refills The Budget, Not The Clock

A retry budget exists to stop a struggling dependency being retried into the ground. Two decisions
determine whether it does that: WHEN it refills, and WHOSE retries draw it down. Refill on a clock
and the budget funds the outage it was throttling; share one counter across tenants and the loudest
tenant spends everybody's.

## MUST Rules

### 1. The Budget Is Refilled Only On A Cleared Health Signal

A shared retry budget MUST be refilled only on an observed transition of the downstream health
signal to HEALTHY across two consecutive probe intervals. Refilling on a wall-clock timer, a
scheduler tick, or any interval that advances while the dependency is still failing is BLOCKED.

```text
# DO — the refill is a consequence of the dependency recovering
on probe(HEALTHY) && prev_probe(HEALTHY): budget += refill_step, capped at ceiling
# DO NOT — the refill is a consequence of time passing
every 30s: budget = ceiling        # fires mid-outage; the ceiling never binds
```

**BLOCKED rationalizations:** "the timer is simpler and the outage will end anyway" / "thirty
seconds is long enough for anything transient to clear" / "the circuit breaker will catch it before
the budget matters" / "we can tune the interval if it turns out to be too aggressive" / "a
health-gated refill could stall forever if the probe is wrong".

**Why:** A timer refills the budget while the dependency is still failing, so each tick hands the
caller a fresh allowance of retries aimed at the outage the budget exists to damp.

### 2. A Shared Budget Is Partitioned Per Tenant

A retry budget spanning more than one tenant MUST be held as one partition per tenant, each drawn
down only by that tenant's own retries and refilled only by that tenant's own health signal. A
single global counter serving multiple tenants is BLOCKED.

```text
# DO — one partition each, so a burst is contained to the tenant that caused it
budget[tenant_id] -= 1   # tenant A exhausted; tenant B still holds its full allowance
# DO NOT — one counter for everyone, so the burst is billed to the whole fleet
budget -= 1              # tenant A's storm leaves tenant B with nothing to retry with
```

**BLOCKED rationalizations:** "our tenants are roughly the same size" / "a per-tenant map is more
state than this deserves" / "fair-share limiting upstream already spreads the load" / "one counter
is easier to reason about and to alert on" / "no tenant has ever come close to the ceiling".

**Why:** A single counter lets one tenant's retry burst exhaust the allowance every other tenant
would have drawn on, so the failure surfaces as lost retries for tenants that spent nothing.

## MUST NOT

- Refill a retry budget from inside the retry path itself

**Why:** A refill on the code path that spends the budget makes it self-replenishing exactly when
load is highest, so the ceiling is never reached and the budget measures nothing.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms the refill is
  gated on a health transition and that the budget is keyed by tenant); `advisory` at the hook layer
  per `hook-output-discipline.md` MUST-2 — whether a refill site is clock-driven is a judgment over
  the surrounding control flow, not a tool-call-time structural signal.
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
  the budget's key type. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — an
  advisory detector flagging any assignment to a budget field whose enclosing scope is a timer or
  scheduler callback rather than a probe handler, and any budget declaration whose type is a scalar
  rather than a map keyed by the tenant type. Both are AST facts over one file, so the deferral
  names a structural signal and books enforcement that can arrive; fixtures land WITH it at
  `.claude/audit-fixtures/retry-budget-reset/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1, MUST-2 and the MUST NOT bullet. Every `violations.jsonl` row names
  the budget identifier and whether the defect was the refill trigger or the partitioning.
- **Origin:** See § Origin.

## Origin

2026-08-24 — the `ledger-write` budget refilled to its ceiling every 30s from the scheduler. The
primary shard was down for 41 minutes; the budget refilled 82 times and the service retried it
through all of them, holding the shard at write saturation for 26 minutes after it would otherwise
have recovered. The same counter was global, so the two tenants that never touched the ledger path
lost their retries to the one that did. The incident is why this rule fixes the refill TRIGGER and
the budget's KEY rather than asking reviewers to judge whether a retry rate looks reasonable — the
rate looked reasonable at every single tick.
