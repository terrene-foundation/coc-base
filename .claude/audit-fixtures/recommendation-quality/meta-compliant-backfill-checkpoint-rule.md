---
priority: 10
scope: path-scoped
paths:
  - "src/jobs/backfill/**"
  - "migrations/**"
---

# Backfill Checkpoints — The Cursor Lands Before The Batch

A backfill that cannot say where it stopped cannot be resumed; it can only be re-run from
zero, against a table that has changed underneath it since the first attempt.

## MUST Rules

### 1. A Backfill MUST Persist Its Resume Cursor BEFORE Processing The Batch That Cursor Covers

The cursor write and the batch write MUST be ordered cursor-first, and the cursor MUST be
durable (committed to a table or an object store) before the first row of the batch is
touched. Writing the cursor after the batch is BLOCKED, and holding the cursor in process
memory for the run's duration is BLOCKED. A crash between the two writes MUST leave the
job re-processing a batch it already did, never skipping one it did not.

```text
# DO — cursor first, durable, so a crash re-does work instead of losing it
UPDATE backfill_state SET cursor = 4_200_000 WHERE job = 'orders_v2';  COMMIT;
process_batch(4_200_000 .. 4_210_000);                                  COMMIT;

# DO NOT — batch first, cursor second: a crash in between skips 10,000 rows silently
process_batch(4_200_000 .. 4_210_000);                                  COMMIT;
UPDATE backfill_state SET cursor = 4_210_000 WHERE job = 'orders_v2';  COMMIT;
```

**BLOCKED rationalizations:**

- "The job has never crashed in staging, so the ordering is theoretical"
- "Writing the cursor first means we might redo a batch, which is worse than skipping one"
- "It is a single transaction anyway, the database will sort it out"
- "We can reconstruct where it stopped from the max id in the target table"
- "This run only takes eleven minutes, there is no window to crash in"
- "I will add the checkpoint once we see it actually fail"

**Why:** Cursor-after-batch loses rows on a crash and cursor-before-batch only repeats
them, so the ordering decides whether a failed run is an inconvenience or a silent data
loss nobody detects until a quarterly report disagrees with itself.

## MUST NOT

- Resume a backfill from a cursor written by a different code version without re-reading
  the cursor's schema version alongside it

**Why:** A cursor is an offset into an interpretation of the table, so resuming a v2 run
from a v1 cursor silently re-partitions the range.

## Trust Posture Wiring

- **Severity:** `block` at the hook layer (a `PreToolUse(Bash)` read of the job's argv
  where `--resume-from` is passed with no `--state-table`, both argv tokens); `halt-and-report`
  at gate-review.
- **Grace period:** 7 days from rule landing (2026-09-01 → 2026-09-08).
- **Cumulative posture impact:** same-class violations (a batch written before its cursor;
  an in-memory-only cursor) contribute to cumulative-window math.
- **Regression-within-grace:** the generic `regression_within_grace` trigger, no dedicated key.
- **Receipt requirement:** SessionStart soft-gate `[ack: backfill-checkpoint]` IFF the rule
  id is in `pending_verification`.
- **Detection mechanism:** Phase 1 gate-review. Phase 2 books a parsed structural signal —
  the ordering of the two `COMMIT` statements in the job's SQL as parsed from the migration
  file's AST, which is observable without reading any prose; audit fixtures land WITH that
  detector at `.claude/audit-fixtures/backfill-checkpoint-ordering/` per `cc-artifacts.md`
  Rule 9.
- **Violation scope:** the numbered clause and the MUST NOT bullet.
- **Origin:** See § Origin.

## Origin

2026-09-01 — the `orders_v2` backfill crashed at hour six of a nine-hour run and was
resumed from the max id in the target table, which skipped 41,000 rows whose writes had
been rolled back. The gap was found eleven weeks later by a finance reconciliation.
