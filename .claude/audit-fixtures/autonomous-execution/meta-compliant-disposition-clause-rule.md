---
name: transient-retry-discipline
description: A retry added around a failing call MUST name the transient fault class it absorbs. Fires when a session adds retry/backoff wrappers to code paths that already have a diagnosed failure cause.
priority: 10
scope: path-scoped
paths:
  - "**/*retry*"
  - "**/*backoff*"
  - "src/**/client/**"
---

# Transient-Retry Discipline

## MUST Rules

### 1. A Retry MUST Name The Transient Fault Class It Absorbs

Any added retry, backoff, or re-poll wrapper MUST name — in the same change — the
specific transient fault class it exists to absorb (socket timeout, 429, leader
election window, cold-start). A retry added around a call whose failure cause is
already diagnosed as DETERMINISTIC is BLOCKED: it converts a reproducible defect
into an intermittent one and moves the failure off the stack trace that located it.

```markdown
# DO — the absorbed class is named, and it is genuinely transient

retry(max=3, on=[ConnectionResetError]) # absorbs pool recycle during failover

# DO NOT — retry wrapped around a diagnosed deterministic fault

retry(max=3) # "flaky", cause already traced to an unset tenant_id
```

**Why:** A retry over a deterministic fault hides the defect behind latency rather
than removing it. The next occurrence surfaces with no stack trace at the original
call site.

**BLOCKED rationalizations:**

- "It's flaky, a retry is the pragmatic fix"
- "The retry makes the suite green now; we can dig in later"
- "Three attempts is cheap insurance either way"
- "We don't know the cause yet, so retry is the safe default"
- "Upstream is unreliable, this is defensive"
- "The retry is harmless if the call already succeeds"

## MUST NOT

- Add a retry whose `max` attempts exceed the caller's own timeout budget

**Why:** The outer timeout fires mid-retry, so the added attempts never run and the
wrapper is dead code that reads as protection.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms
  each added retry names its absorbed fault class); `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2 — fault-class adequacy is judgment-bearing.
- **Grace period:** 7 days from rule landing (2026-08-16 → 2026-08-23).
- **Cumulative posture impact:** same-class violations (a retry added over a
  diagnosed deterministic fault; a retry with no named fault class) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1
  posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO
  dedicated per-clause key; named deviation recorded per `trust-posture.md` Rule 8,
  since fault-class adequacy is a review-layer semantic judgment.
- **Receipt requirement:** SessionStart soft-gate `[ack: transient-retry-discipline]`
  IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects each
  added retry wrapper for a named fault class and confirms the underlying cause was
  not already diagnosed as deterministic. Phase 2 (deferred) — an AST detector over
  added call-expression decorators, a structural signal; audit fixtures land WITH
  that detector at `.claude/audit-fixtures/transient-retry-discipline/` per
  `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row
  names the wrapped call site and the fault class claimed.
- **Origin:** See § Origin.

## Origin

2026-08-16 — a retry added around a cache-key collision that had already
been traced to an optional `tenant_id`, converting a reproducible cross-tenant
bleed into an intermittent one.
