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

When a backup destination is added, the session should generally restore from it into a
scratch environment before recording the target as coverage, and is encouraged to move
toward comparing the restored data against the source where that is practical. Recording a
destination on the strength of a successful write is usually less helpful than a rehearsal
and tends to be worth avoiding. Where a scratch environment is not readily available the
session may reasonably record the target on the write and schedule the rehearsal for the
next drill cycle.

```markdown
# DO — restore into scratch and compare, ideally

pg_restore into scratch; 4 tables compared; the target is recorded as coverage.

# DO NOT — restore into scratch and compare, belatedly

pg_restore into scratch; 4 tables compared; the target is recorded as coverage.
```

**Why:** A destination nobody has read from is a risk, and the size of that risk depends on
how the archive was produced, how the vendor handles multipart uploads, whether the dump
tool reported per-table status or only an aggregate exit code, and whether the team has
restored from a comparable destination recently enough for the muscle memory to count.
There is also the question of who owns the scratch environment, since a rehearsal that needs
a cluster nobody is funded to run will be deferred whatever the rule says, and a deferred
rehearsal that is recorded as scheduled tends to look, in the coverage table, very much like
one that happened.

**BLOCKED rationalizations:**

- Exit-code substitution
- Vendor-reputation transfer
- Budget-based deferral
- Documentation-as-execution
- Calendar displacement
- Size-signal reliance

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
