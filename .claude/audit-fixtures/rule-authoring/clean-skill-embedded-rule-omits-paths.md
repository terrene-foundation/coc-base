---
name: connection-drain-ordering
description: Shutdown drains accepted work before closing the pool that work depends on, and a drain that cannot complete within its deadline reports what it abandoned. Inlined into the shutdown skill.
priority: 20
scope: skill-embedded
---

# Connection Drain Ordering

## MUST Rules

### 1. Shutdown MUST Drain Accepted Work Before Closing The Pool That Work Depends On

A shutdown sequence MUST stop accepting new work, drain what has already been accepted, and
only then close the connection pool those handlers hold. Closing the pool first is BLOCKED:
every in-flight handler then fails on its next query, and the work was already acknowledged
to the caller.

```markdown
# DO — stop accepting, drain, then close what the drained work needed

server.stop_accepting(); await inflight.drain(deadline=30); await pool.close()

# DO NOT — close the pool while accepted work is still holding it

await pool.close(); await inflight.drain(deadline=30) # every handler raises mid-drain
```

**Why:** Work that was acknowledged to the caller and then failed on a closed pool is
indistinguishable, from the caller's side, from work the server silently lost.

### 2. A Drain That Hits Its Deadline MUST Report What It Abandoned

When a drain deadline expires with work still in flight, the shutdown path MUST emit a record
naming the count and the identifiers of the abandoned units before the process exits. Exiting
on the deadline with no record is BLOCKED, because the operator then has no list to replay
from.

```markdown
# DO — the deadline expiry is recorded with its abandoned set

if not drained: log.error("drain deadline", abandoned=inflight.ids(), count=len(inflight))

# DO NOT — exit quietly on the deadline

if not drained: sys.exit(0) # the abandoned units are unnamed and unreplayable
```

**Why:** An unnamed abandoned set cannot be replayed, so a bounded loss becomes an unbounded
reconciliation across every downstream system that saw the acknowledgement.

**BLOCKED rationalizations:**

- "The pool close is idempotent, the order does not matter"
- "Handlers already retry, they will pick the connection back up"
- "The deadline never expires in practice, I have never seen it"
- "Logging the abandoned ids on shutdown floods the log at exactly the wrong time"
- "The orchestrator restarts us, whatever was in flight comes back on its own"
- "I will add the abandoned-set record once we see a real loss"

## MUST NOT

- Register the pool close and the drain as two independent shutdown hooks

**Why:** Independent hooks run in registration order rather than dependency order, so the
ordering this rule establishes is re-broken by the next hook anyone adds.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms the
  shutdown path drains before closing and records any abandoned set); `advisory` at the hook
  layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing (2026-09-02 → 2026-09-09).
- **Cumulative posture impact:** same-class violations (a pool closed ahead of the drain; a
  deadline expiry with no abandoned-set record; a drain and a close registered as independent
  hooks) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d →
  drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key;
  named deviation recorded per `trust-posture.md` Rule 8, since the ordering is a single
  statement sequence and repairing it rewrites no state.
- **Receipt requirement:** SessionStart soft-gate `[ack: connection-drain-ordering]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads the shutdown
  sequence in the diff. Phase 2 — a control-flow walk over the shutdown function's statement
  list asserting the `drain` call node precedes the `close` call node, plus a check that the
  deadline branch contains a logging call whose keyword set includes the abandoned
  identifiers; statement order and keyword presence are both parsed structure. Fixtures land
  with it at `.claude/audit-fixtures/connection-drain-ordering/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** clauses 1 and 2 plus the MUST NOT bullet; every `violations.jsonl` row
  names the shutdown function and the statement order observed.
- **Origin:** See § Origin.

## Origin

2026-09-02 — `journal/0451-INCIDENT-shutdown-pool-close-race.md` § 4: a rolling deploy closed
the pool ahead of the drain on each of eleven nodes, and 340 acknowledged jobs failed mid-flight
with no record of which ones.
