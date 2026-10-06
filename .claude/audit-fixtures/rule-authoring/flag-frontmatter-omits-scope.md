---
name: migration-rollback-pairing
description: Every forward schema migration lands with an executable reverse, and a destructive step is split from the deploy that stops reading the column. Fires on edits under the migrations tree.
priority: 10
paths:
  - "**/migrations/**"
  - "**/src/**/schema_*.sql"
---

# Migration Rollback Pairing

## MUST Rules

### 1. Every Forward Migration MUST Land With An Executable Reverse

A migration MUST ship its `down` step in the same change as its `up` step, and that `down`
step MUST have been executed at least once against a copy of the target schema. Shipping a
`down` that has never run is BLOCKED: an untested reverse is indistinguishable from no reverse
at the moment it is needed.

```markdown
# DO — the reverse ships with the forward and has been run

migrate up && migrate down && migrate up # exercised against a restored snapshot

# DO NOT — a reverse that has never executed

def down(): raise NotImplementedError # present in the file, useless at 3am
```

**Why:** A reverse step is exercised for the first time during an incident, so one that has
never run converts a bounded rollback into an unplanned forward fix under pressure.

### 2. A Destructive Step MUST NOT Ship In The Same Deploy As The Code That Stops Reading It

Dropping a column, a table or an index MUST land in a deploy strictly after the deploy that
removed every read of it, with at least one release between them. Combining the two is
BLOCKED, because the rollback target for the code deploy no longer has the column its previous
version reads.

```markdown
# DO — two deploys, the destructive one second

release N: stop reading `legacy_status` · release N+1: drop column `legacy_status`

# DO NOT — one deploy carrying both

release N: stop reading AND drop `legacy_status` # rolling back N reads a column that is gone
```

**Why:** A combined deploy has no rollback target, because the previous code version requires
a column the same deploy removed.

**BLOCKED rationalizations:**

- "The down step is obvious, writing a test for it is busywork"
- "We have never rolled back a migration in this service"
- "Splitting it into two releases doubles the deploy work for one column"
- "The column is already unused, nothing can be reading it"
- "A backup exists, that is our rollback"
- "I will exercise the down step before the next release, not this one"

## MUST NOT

- Write a data backfill into the same migration as a schema change

**Why:** A backfill is long-running and a schema change takes a lock, so combining them holds
the lock for the duration of the backfill.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms each
  migration in the diff carries an exercised reverse and that no destructive step shares a
  deploy with the read removal); `advisory` at the hook layer per `hook-output-discipline.md`
  MUST-2.
- **Grace period:** 7 days from rule landing (2026-09-05 → 2026-09-12).
- **Cumulative posture impact:** same-class violations (a migration with no executable
  reverse; a destructive step sharing a deploy with the read removal; a backfill inside a
  schema change) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule
  in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key;
  named deviation recorded per `trust-posture.md` Rule 8, since an unexercised reverse is
  repairable before the migration is applied anywhere.
- **Receipt requirement:** SessionStart soft-gate `[ack: migration-rollback-pairing]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads each migration file
  against its deploy plan. Phase 2 — a parse of each migration module asserting a non-raising
  `down` definition, paired with a git-object read comparing the commit that removes the last
  read of a column against the commit carrying its `DROP`; the function body and the two
  commit objects are all parsed structure. Fixtures land with it at
  `.claude/audit-fixtures/migration-rollback-pairing/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** clauses 1 and 2 plus the MUST NOT bullet; every `violations.jsonl` row
  names the migration id and which half was absent.
- **Origin:** See § Origin.

## Origin

2026-09-05 — `journal/0462-INCIDENT-rollback-blocked-by-dropped-column.md` § 1: a release that
both stopped reading and dropped `legacy_status` could not be rolled back, and the fix forward
took four hours with the service degraded throughout.
