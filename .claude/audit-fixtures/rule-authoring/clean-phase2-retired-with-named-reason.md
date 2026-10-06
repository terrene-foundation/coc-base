---
name: quota-exhaustion-signal
description: A quota that runs out surfaces as a typed refusal naming the quota and its reset, never as a generic failure or a silent degradation. Fires on edits to rate-limit and quota enforcement paths.
priority: 10
scope: path-scoped
paths:
  - "**/src/quota/**"
  - "**/src/**/rate_limit.*"
---

# Quota Exhaustion Signal

## MUST Rules

### 1. An Exhausted Quota MUST Surface As A Typed Refusal Naming The Quota And Its Reset

When a request is refused because a quota is spent, the refusal MUST carry the quota's
identifier and the instant it resets. Returning a generic failure is BLOCKED: the caller
cannot distinguish a spent quota from an outage, so it retries immediately and spends the
next window before it opens.

```markdown
# DO — the refusal names the quota and when it reopens

raise QuotaExhausted(quota="api.writes.daily", resets_at="2026-09-07T00:00Z")

# DO NOT — a generic failure the caller cannot act on

raise ServiceUnavailable() # caller retries in 200ms, and again, and again
```

**Why:** A caller that cannot tell exhaustion from an outage retries at outage cadence, which
turns a quota boundary into a self-inflicted load spike.

### 2. A Quota MUST NOT Be Enforced By Silently Degrading The Response

Where a quota is spent, the handler MUST refuse rather than return a truncated, sampled or
stale result that looks complete. Silent degradation is BLOCKED, because the caller records a
successful response and the missing rows are discovered downstream, if at all.

```markdown
# DO — refuse, so the caller knows the result is not available

if quota.spent: raise QuotaExhausted(quota=q.id, resets_at=q.resets_at)

# DO NOT — return a partial result that presents as complete

if quota.spent: return rows[:100] # the caller reads 100 and believes that is all there is
```

**Why:** A truncated result carrying a success status is recorded as complete by every system
downstream, so the loss is silent and unbounded in time.

**BLOCKED rationalizations:**

- "A generic error is safer, the quota name leaks capacity information"
- "Truncating is friendlier than failing the whole request"
- "Callers do not read our error types anyway, they just check the status code"
- "The reset time is an implementation detail we might want to change"
- "Partial data is better than no data for a dashboard"
- "I will add the typed error once someone asks for it"

## MUST NOT

- Reset a quota counter as a side effect of reading it

**Why:** A read that mutates makes the counter unobservable, so no operator can answer how
close a tenant is to its ceiling.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms every
  quota refusal in the diff is typed and carries its reset, and that no handler degrades
  silently); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing (2026-09-06 → 2026-09-13).
- **Cumulative posture impact:** same-class violations (a generic failure on exhaustion; a
  truncated result presented as complete; a counter reset by a read) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5×
  total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key;
  named deviation recorded per `trust-posture.md` Rule 8, since a refusal's shape is
  repairable without touching any stored counter.
- **Receipt requirement:** SessionStart soft-gate `[ack: quota-exhaustion-signal]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads each refusal path in
  the diff. Phase 2 — a type-level assertion that every return edge of a quota-guarded handler
  either raises `QuotaExhausted` or returns the handler's full declared result type, read from
  the parsed return annotation and the raise nodes on each branch; both are parsed structure,
  so the detector keys on structure and never on the author's stated intent. Fixtures land
  with it at `.claude/audit-fixtures/quota-exhaustion-signal/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** clauses 1 and 2 plus the MUST NOT bullet; every `violations.jsonl` row
  names the handler and the shape of the refusal it returned.
- **Origin:** See § Origin.

## Origin

2026-09-06 — `journal/0466-INCIDENT-silent-quota-truncation.md` § 2: an export endpoint
returned its first hundred rows with a 200 status once a tenant's daily quota was spent, and
three weeks of downstream reports were built on truncated extracts before anyone noticed.
