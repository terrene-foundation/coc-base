---
name: backup-restore-rehearsal
description: A backup target counts as coverage only after a restore from it has been rehearsed end to end. Fires when a session records a new backup destination as protected without ever reading data back out of it.
priority: 10
scope: path-scoped
paths:
  - "**/infra/backup/**"
  - "**/ops/runbooks/**"
---

# Backup Restore Rehearsal

## MUST Rules

### 1. A New Backup Target MUST Have A Rehearsed Restore Before It Counts As Coverage

When a backup destination is added, the session MUST restore from it into a scratch
environment and assert the restored data against the source BEFORE recording the target as
coverage. Recording a destination as protected on the strength of a successful write is
BLOCKED: a write proves the bytes left, and only a read proves they can come back.

```markdown
# DO — the restore runs, and the assertion is against the source

pg_restore into scratch; row counts and a checksum compared against the source; 4 tables,
all four equal; the target is recorded as coverage with the rehearsal timestamp.

# DO NOT — record the target on the write alone

nightly dump exits 0, the object lands in the bucket at 41 GB, coverage table updated; no
byte is ever read back.
```

**Why:** A destination that has never been read from is a destination whose restore path has
never been executed, and the first execution should not be the outage.

**BLOCKED rationalizations:**

- "The dump exited zero, so the archive is good"
- "The bucket shows the object at the right size"
- "We restored from this vendor at the last company"
- "A rehearsal costs a scratch cluster we do not have budget for"
- "The runbook documents the restore, that is the same thing"
- "We will rehearse it at the next DR exercise"

## MUST NOT

- Record a restore rehearsal as passed when the assertion compared the restore against itself

**Why:** A restore compared against its own output agrees by construction and reports success
for an archive that is entirely empty.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms a target
  added to the coverage table carries a rehearsal record naming the scratch environment and
  the source it was compared against); `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2 — whether an assertion compared against the source or
  against the restore is a judgment over the rehearsal script.
- **Grace period:** 7 days from rule landing (2026-09-01 → 2026-09-08).
- **Cumulative posture impact:** same-class violations (a destination recorded as coverage
  with no rehearsal; a rehearsal whose assertion never reached the source) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture;
  5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key;
  named deviation recorded per `trust-posture.md` Rule 8, since what a rehearsal compared
  against is legible only in the script that ran it.
- **Receipt requirement:** SessionStart soft-gate `[ack: backup-restore-rehearsal]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer diffs the coverage table
  and, for each added row, confirms a rehearsal record exists with a later timestamp than the
  row. Phase 2 (deferred) — a detector comparing added rows in the coverage manifest against
  rehearsal records in the same directory, both parsed files with comparable timestamps;
  fixtures land WITH that detector at `.claude/audit-fixtures/backup-restore-rehearsal/` per
  `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names the
  destination, the rehearsal that was owed, and the coverage row it was recorded under.
- **Origin:** See § Origin.

## Origin

2026-09-01 — a quarterly restore drill found that two of five recorded destinations had never
been read from, and one of those two held an archive of zero-byte members.
