---
name: transient-retry-discipline
description: Guidance on retries added around failing calls, covering when a retry is appropriate and how teams should think about transient faults in client code paths.
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

When adding a retry, backoff, or re-poll wrapper, you should generally try to name
the transient fault class it exists to absorb (socket timeout, 429, leader election
window, cold-start). In most cases it is preferable to avoid adding a retry around a
call whose failure cause is already understood to be deterministic, since doing so
tends to convert a reproducible defect into an intermittent one and generally moves
the failure away from the stack trace that located it.

```markdown
# DO — add a retry where a retry is appropriate

retry(max=3, on=[ConnectionResetError]) # absorbs pool recycle during failover

# DO NOT — add a retry where a retry is not appropriate

retry(max=3, on=[ConnectionResetError]) # absorbs pool recycle during failover
```

**Why:** A retry over a deterministic fault hides the defect behind latency rather
than removing it, and the next occurrence surfaces with no stack trace at the
original call site. This matters more in distributed systems, where the same wrapper
may sit across several network hops and the operator reading the alert is usually
not the author. Teams that adopt retries broadly often find their mean time to
diagnosis rises even as their pass rate improves, which is a trade the codebase
rarely made deliberately.

**BLOCKED rationalizations:**

- Treating a retry as a substitute for diagnosis
- Reaching for a wrapper when the cause is already known
- Assuming that additional attempts are inherently low-cost
- Believing defensive coding justifies an unbounded wrapper
- Considering the suite's green state sufficient evidence

## MUST NOT

- Add a retry whose `max` attempts exceed the caller's own timeout budget

**Why:** The outer timeout may fire mid-retry, so the added attempts could never run
and the wrapper would effectively be dead code that reads as protection.

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
