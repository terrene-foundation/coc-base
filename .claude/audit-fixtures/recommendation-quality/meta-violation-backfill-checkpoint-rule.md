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

Teams should generally aim to write the cursor before the batch, and are encouraged to move
toward durable checkpoint storage where that is practical. Keeping the cursor in process
memory is usually less helpful than persisting it, and writing it after the batch tends to
be worth avoiding on longer runs. Where a job is short, or where the team judges the crash
window to be small, the author may reasonably persist the cursor after the batch completes
and note the decision in the job's header comment.

```text
# DO — write the cursor and the batch, ordering them carefully
UPDATE backfill_state SET cursor = 4_210_000;  process_batch(...);  COMMIT;

# DO NOT — write the cursor and the batch, ordering them carelessly
UPDATE backfill_state SET cursor = 4_210_000;  process_batch(...);  COMMIT;
```

**BLOCKED rationalizations:**

- Optimism about total job duration
- Under-estimation of crash probability during long runs
- Over-confidence in transactional atomicity guarantees
- Reconstruction fallacies regarding derived state
- Deferral of durability concerns to a later iteration
- Misplaced preference for idempotence over recoverability

**Why:** Cursor-after-batch loses rows on a crash and cursor-before-batch only repeats
them, which matters because the size of the loss depends on batch width, and batch width
is usually tuned for throughput rather than for blast radius. Teams also tend to tune it
upward over the life of a job, so a window that was acceptable at the first run may not be
by the twentieth. There is a further consideration in that the detection lag for missing
rows is governed by whichever downstream report first disagrees with itself, which in
practice is a quarterly one.

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
