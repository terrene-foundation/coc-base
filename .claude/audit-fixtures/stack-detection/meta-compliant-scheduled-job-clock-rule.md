---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/schedules/**"
  - "**/*cron*"
---

# Scheduled-Job Clock Discipline — The Schedule Names Its Zone, The Timer Names Its Clock

A recurring job reads two clocks that look like one. The schedule asks WHEN, which is a civil-time
question and therefore a question about a zone; the timeout asks HOW LONG, which is an elapsed-time
question and therefore a question the wall clock cannot answer.

## MUST Rules

### 1. A Recurring Schedule Declares Its Timezone Explicitly

Every recurring schedule MUST carry an explicit IANA zone alongside its expression. Relying on the
host's `TZ`, on a runtime default, or on "the scheduler runs in UTC anyway" is BLOCKED.

```text
# DO — zone travels with the expression, so a host migration cannot move the run
schedule: { cron: "0 2 * * *", tz: "Europe/Berlin" }   # 02:00 Berlin, DST-correct both ways
# DO NOT — expression alone, zone inherited from whatever the container was built with
schedule: { cron: "0 2 * * *" }                        # 02:00 somewhere; 03:00 after a rebase
```

**BLOCKED rationalizations:** "all our hosts are UTC" / "the scheduler defaults to UTC, so it is
already explicit" / "the job is idempotent, an hour either way is harmless" / "adding a zone to
every schedule is noise" / "we set TZ in the base image".

**Why:** An inherited zone is a property of the host rather than of the schedule, so a base-image
change or a region move silently relocates every run without touching the schedule's definition.

### 2. Elapsed-Time Decisions Read The Monotonic Clock

Any decision about DURATION — a timeout, a backoff, a lease renewal, a rate window — MUST be
computed from a monotonic source. Subtracting two wall-clock readings for an elapsed-time decision
is BLOCKED.

```text
# DO — monotonic source, immune to a step correction mid-measurement
start := time.Now()                  // carries a monotonic reading
if time.Since(start) > lease { ... } // difference uses the monotonic component
# DO NOT — two wall-clock instants subtracted, so an NTP step becomes elapsed time
start := time.Now().Round(0)         // monotonic reading stripped
if time.Now().Round(0).Sub(start) > lease { ... }
```

**BLOCKED rationalizations:** "NTP steps are milliseconds" / "the clock only ever moves forward" /
"we would notice a jump that large" / "wall time is easier to log" / "the lease is long enough to
absorb any correction".

**Why:** A wall clock can step backwards under an NTP correction or a leap-second smear, so a
difference of two readings can be negative or hours wide while no time has passed at all.

## MUST NOT

- Change a schedule's zone and its expression in the same deployment

**Why:** Both edits move the run, so a wrong result after the deploy cannot be attributed to either
one without re-running the change twice.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms every schedule
  in the diff carries a zone and every duration comparison reads a monotonic source); `advisory` at
  the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing (2026-08-19 → 2026-08-26).
- **Cumulative posture impact:** same-class violations (a schedule landed with no explicit zone; an
  elapsed-time decision computed from two wall-clock readings) contribute to `trust-posture.md`
  MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1
  posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key.
  Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md`
  Rule 8: minting one would drag that file, a `self-referential-codify.md` allowlist path, into a
  self-referential edit.
- **Receipt requirement:** SessionStart soft-gate `[ack: scheduled-job-clock]` IFF
  `posture.json::pending_verification` includes the `scheduled-job-clock` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads the schedule manifest and
  every duration comparison in the diff. Phase 2 (deferred per `trust-posture.md` § Two-Phase
  Rollout) — an advisory detector over one patch, flagging (a) a schedule literal whose mapping has
  a `cron` key and no `tz` key, and (b) a subtraction whose both operands are calls to the wall-clock
  constructor. Both are AST facts over the parsed diff, so the deferral names a structural signal and
  books enforcement that can arrive; fixtures land WITH it at
  `.claude/audit-fixtures/scheduled-job-clock/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1, MUST-2 and the MUST NOT bullet. Every `violations.jsonl` row names
  the schedule or the comparison and which clock it read.
- **Origin:** See § Origin.

## Origin

2026-08-19 — the nightly settlement job ran at 02:00 with no zone declared. A base-image bump moved
`TZ` from `Europe/Berlin` to `UTC`, the run shifted an hour earlier, and for 31 days it read the
ledger before the 01:30 European close had been posted, understating settlement on 4.1% of accounts.
Nothing in the schedule's own definition changed, which is why this rule binds the ZONE to the
expression rather than asking reviewers to confirm the host — the host was never in the diff.
