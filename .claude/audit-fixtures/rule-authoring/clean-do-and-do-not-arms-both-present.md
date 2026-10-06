---
name: retry-budget-declaration
description: A retry loop declares its budget as a bounded attempt count and a total deadline, and never retries a request the server has already accepted. Fires on edits to client-side retry paths.
priority: 10
scope: path-scoped
paths:
  - "**/src/clients/**"
  - "**/src/**/retry.*"
---

# Retry Budget Declaration

## MUST Rules

### 1. A Retry Loop MUST Declare Both An Attempt Ceiling And A Total Deadline

Every retry loop MUST bound itself on two axes at once: a maximum attempt count and a total
wall-clock deadline measured from the first attempt. Declaring only the attempt ceiling is
BLOCKED, because a backoff schedule with a ceiling of six can still run for a quarter of an
hour once the backoff grows.

```markdown
# DO — both axes bound, deadline measured from the first attempt

retry(max_attempts=5, deadline=Deadline.from_now(seconds=8))

# DO NOT — attempts alone; the backoff decides the wall clock

retry(max_attempts=5) # 1s, 2s, 4s, 8s, 16s ⇒ 31s on a path the caller gave 8s
```

**Why:** An attempt ceiling bounds the number of requests and not the time they consume, so a
caller's own deadline expires while the loop is still sleeping between attempts.

### 2. A Request The Server Has Already Accepted MUST NOT Be Retried Without An Idempotency Key

When a response is a timeout, a connection reset, or any status that leaves acceptance
undetermined, the request MUST NOT be re-sent unless it carries an idempotency key the server
honours. Re-sending an undetermined write without that key is BLOCKED: the failure the client
observed is indistinguishable from a success whose acknowledgement was lost.

```markdown
# DO — the write carries a key, so the re-send is safe to make

resp = post("/orders", json=body, headers={"Idempotency-Key": attempt_key})
if resp.timed_out: retry() # the server collapses the duplicate on the key

# DO NOT — re-send an undetermined write with no key at all

resp = post("/orders", json=body)
if resp.timed_out: retry() # the first attempt may already have committed
```

**Why:** A timeout tells the client nothing about whether the server committed, so an
unkeyed re-send is a coin flip between a lost order and a duplicate one.

**BLOCKED rationalizations:**

- "A timeout almost always means the request never landed"
- "The endpoint is a POST but it is really just an upsert"
- "Adding idempotency keys is a server-side change, it is not my ticket"
- "We have never actually seen a duplicate in production"
- "The retry only fires once, the blast radius is one extra order"
- "The caller can reconcile duplicates downstream"

## MUST NOT

- Retry inside a handler that is itself already being retried by its caller

**Why:** Nested retry loops multiply rather than add, so two loops of five attempts each
produce twenty-five requests against a service that is already failing.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms each retry
  loop in the diff declares both bounds and that no undetermined write is re-sent unkeyed);
  `advisory` at the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing (2026-08-27 → 2026-09-03).
- **Cumulative posture impact:** same-class violations (a retry loop with only an attempt
  ceiling; an unkeyed re-send of an undetermined write; a nested retry) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5×
  total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key;
  named deviation recorded per `trust-posture.md` Rule 8, since the bound is a call-site
  argument and repairing it touches no stored state.
- **Receipt requirement:** SessionStart soft-gate `[ack: retry-budget-declaration]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads each retry call site
  in the diff. Phase 2 — an AST check over call nodes resolving to the `retry` decorator or
  helper, asserting both keyword arguments are present, plus a walk of the call's body for a
  re-send whose request node carries no `Idempotency-Key` header entry. Argument presence and
  header-dict membership are both parsed structure. Fixtures land with it at
  `.claude/audit-fixtures/retry-budget-declaration/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** clauses 1 and 2 plus the MUST NOT bullet; every `violations.jsonl` row
  names the call site and which bound was absent.
- **Origin:** See § Origin.

## Origin

2026-08-27 — `journal/0431-INCIDENT-duplicate-order-storm.md` § 1: a gateway timeout at 8s met
a client retry with a ceiling of five and no deadline, and 1,180 orders were committed twice
over nine minutes.
