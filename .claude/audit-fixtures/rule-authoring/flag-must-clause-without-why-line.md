---
name: timezone-normalization
description: Timestamps cross a process boundary as UTC instants and are localised only at the render edge, and a wall-clock recurrence stores its zone alongside its local time. Fires on edits touching datetime handling.
priority: 10
scope: path-scoped
paths:
  - "**/src/scheduling/**"
  - "**/src/**/datetime_*.py"
---

# Timezone Normalization

## MUST Rules

### 1. A Timestamp Crossing A Process Boundary MUST Be A UTC Instant

Any timestamp written to a database, placed on a queue, or serialised into an API response
MUST be a UTC instant carrying an explicit offset. Emitting a naive local datetime across a
boundary is BLOCKED, because the receiving process has no way to recover which zone the
sender meant.

```markdown
# DO — explicit UTC instant on the wire

payload["due_at"] = due.astimezone(timezone.utc).isoformat() # 2026-08-31T14:00:00+00:00

# DO NOT — naive local datetime; the receiver guesses the zone

payload["due_at"] = due.isoformat() # 2026-08-31T14:00:00 — 14:00 where?
```

**Why:** A naive datetime is interpreted in the reader's zone rather than the writer's, so the
same row means a different instant in every process that reads it.

### 2. A Wall-Clock Recurrence MUST Store Its Zone Alongside Its Local Time

A recurrence expressed in wall-clock terms — "every weekday at 09:00 in Berlin" — MUST persist
the zone identifier next to the local time, and MUST NOT be collapsed to a UTC instant at
write time. Collapsing it is BLOCKED: the offset it was collapsed with is correct only until
the next transition, after which every occurrence is an hour wrong.

```markdown
# DO — local time and zone stored together, resolved per occurrence

Recurrence(local_time="09:00", zone="Europe/Berlin", rule="FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")

# DO NOT — collapse to UTC at write time, freezing one offset forever

Recurrence(utc_time="07:00", rule="FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR") # wrong after October
```

**BLOCKED rationalizations:**

- "Everything is UTC internally, so storing the zone is redundant"
- "We convert at write time, which is simpler than converting on every read"
- "Our users are all in one country, the offset never changes for them"
- "The library handles daylight saving, I do not need to think about it"
- "A one-hour drift twice a year is not worth the schema change"
- "I will add the zone column when someone actually reports a wrong reminder"

## MUST NOT

- Compare two timestamps whose awareness differs without normalising both first

**Why:** Mixing an aware and a naive datetime raises in some code paths and silently compares
wrong in others, so the failure surfaces far from where it was introduced.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms every
  boundary-crossing timestamp in the diff is an aware UTC instant and that every wall-clock
  recurrence persists its zone); `advisory` at the hook layer per `hook-output-discipline.md`
  MUST-2.
- **Grace period:** 7 days from rule landing (2026-08-31 → 2026-09-07).
- **Cumulative posture impact:** same-class violations (a naive datetime on a boundary; a
  recurrence collapsed to UTC at write time; an un-normalised comparison) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5×
  total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key;
  named deviation recorded per `trust-posture.md` Rule 8, since a collapsed recurrence is
  recoverable from the original local time while the row is still in the write-ahead log.
- **Receipt requirement:** SessionStart soft-gate `[ack: timezone-normalization]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads each datetime
  construction and serialisation in the diff. Phase 2 — a type-level check over annotated
  datetime values at serialisation call sites, plus a schema read asserting every recurrence
  table carries a zone column; the annotation and the column are both parsed structure, so the
  detector reads structure rather than prose. Fixtures land with it at
  `.claude/audit-fixtures/timezone-normalization/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** clauses 1 and 2 plus the MUST NOT bullet; every `violations.jsonl` row
  names the call site and the value's awareness at that point.
- **Origin:** See § Origin.

## Origin

2026-08-31 — `journal/0444-INCIDENT-daylight-saving-reminder-drift.md` § 2: 6,400 weekday
reminders fired an hour early for five weeks after the October transition, because each had
been collapsed to a UTC instant with the July offset.
