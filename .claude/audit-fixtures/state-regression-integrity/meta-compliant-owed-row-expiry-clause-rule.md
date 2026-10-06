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

Any row written into `Blocked on you` MUST carry `owed_since` set to the date of that
write. Writing the row without it is BLOCKED. The bucket accrues against the owner, so how
long it has accrued is part of what the row claims, and a register that cannot answer it
is asserting a debt of unknown size. An ask file's presence on disk says nothing about how
long the row has been owed and never substitutes for the field.

```json
# DO — the row says when the clock started, so its age is readable from the row
{"id": "F91", "status": "Blocked on you", "ask_ref": "asks/schema.md", "owed_since": "2026-09-14"}

# DO NOT — the row asserts a debt and leaves its age to be reconstructed from history
{"id": "F91", "status": "Blocked on you", "ask_ref": "asks/schema.md"}
```

**Why:** An owed row with no entry date is indistinguishable from one raised yesterday and
one raised last quarter, so the oldest asks are the ones least likely to be chased.

**BLOCKED rationalizations:**

- "The git history has the date, the row does not need to repeat it"
- "It went into the bucket today, so the date is obvious from the commit"
- "We review the owed rows weekly anyway, nothing gets old"
- "Adding a field to every owed row is churn for one number"
- "The owner knows what they owe us without being told how long"
- "I'll backfill the dates across the register in one pass later"

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
