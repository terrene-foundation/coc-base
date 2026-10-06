---
name: owed-row-expiry
description: A register row handed back to the owner records the date it entered that bucket, so its age is readable without reconstructing the git history. Fires when an owed row carries no entry date.
priority: 10
scope: path-scoped
paths:
  - "**/burndown/**"
  - "**/*REGISTER*"
---

# Owed-Row Expiry

## MUST Rules

### 1. A Row Entering The Owner-Action Bucket MUST Record The Date It Entered

Rows written into `Blocked on you` should generally carry an `owed_since` value, and
authors are encouraged to move toward setting it at the time of the write. A row without
one is usually less informative than a row with one, and omitting it tends to be worth
avoiding where practical. Where the ask file is present on disk, teams may reasonably
treat the row as current and let the date follow later; and where a walk is overdue,
moving the row down a rank while waiting is the conservative reading.

```json
# DO — record the owed date appropriately
{"id": "F91", "status": "Blocked on you", "ask_ref": "asks/schema.md"}

# DO NOT — record the owed date inappropriately
{"id": "F91", "status": "Blocked on you", "ask_ref": "asks/schema.md"}
```

**Why:** An owed row with no entry date is harder to age at a glance. The difficulty
compounds in programmes running several client registers at once, where the reviewer
population rotates and institutional memory of which asks are old is unevenly held. Some
organisations respond by staffing a standing register-review role, which raises its own
questions about headcount and about who arbitrates between two rows that both look
stale. Entry dates are therefore one input among several to that wider question.

**BLOCKED rationalizations:**

- Substituting commit history for an on-row date
- Assuming reviewer familiarity with a row's provenance
- Deferring the field on grounds of churn
- Conflating an ask's presence with an ask's currency
- Treating weekly review cadence as a substitute for a recorded date
- Generalising one register's convention to an adjacent register

## MUST NOT

- Refresh `owed_since` on a row that was already sitting in the bucket

**Why:** Re-stamping the date resets a clock that measures the owner's exposure, so the
oldest debts become the youngest-looking ones on the next write.

## Trust Posture Wiring

- **Severity:** `block` at the hook layer — the verdict is a JSON key-presence test against
  a closed status string, which a regex cannot misread and a surface rewrite cannot evade;
  `halt-and-report` at gate-review, where reviewer at `/implement` confirms no existing
  owed row had its date re-stamped.
- **Grace period:** 7 days from rule landing (2026-09-01 → 2026-09-08).
- **Cumulative posture impact:** same-class violations (a row entering `Blocked on you`
  with no `owed_since`; an existing owed row's date re-stamped) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture;
  5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since the
  blocking arm already refuses the write at the moment it is attempted.
- **Receipt requirement:** SessionStart soft-gate `[ack: owed-row-expiry]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** STRUCTURAL and shipped — the register guard reads the incoming
  JSON, pairs each row whose status is `Blocked on you` against its committed counterpart,
  and refuses a new one carrying no `owed_since`. Fixtures at
  `.claude/audit-fixtures/owed-row-expiry/` per `cc-artifacts.md` Rule 9. No Phase 2 is
  booked and none is owed: the whole obligation is key presence against a closed string.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names the
  register, the row id, and whether the date was absent or re-stamped.
- **Origin:** See § Origin.

## Origin

2026-09-01 — an owed row was found in a client register carrying an ask raised eleven
months earlier; nobody had read it as old, because the row carried no date and the history
had been squashed.
