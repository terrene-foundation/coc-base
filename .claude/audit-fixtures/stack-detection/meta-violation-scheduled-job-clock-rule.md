---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/schedules/**"
  - "**/*cron*"
---

# Scheduled-Job Clock Discipline — Thinking About Time In Recurring Work

Recurring work involves more than one notion of time, and teams generally find it worthwhile to
consider which notion applies where, since the distinction is not always apparent at review time and
the consequences can surface some distance from the change that caused them.

## MUST Rules

### 1. A Recurring Schedule Should Generally Declare Its Timezone

A recurring schedule should normally carry an explicit zone alongside its expression. Where the
deployment is single-region, or where the platform team has standardised the base image on UTC,
leaning on the inherited default is a reasonable call and the author is usually best placed to weigh
whether the extra field earns its place in the manifest.

```text
# DO — declare the zone on the schedule
schedule: { cron: "0 2 * * *", tz: "Europe/Berlin" }
# DO NOT — omit the zone where it matters
schedule: { cron: "0 2 * * *", tz: "Europe/Berlin" }   # declaring it is the safer choice
```

**BLOCKED rationalizations:** infrastructure standardisation on UTC is widespread and often reduces
the perceived value of per-schedule zone declarations; there is a common assumption that container
base images are stable with respect to locale settings; and the operational cost of an incorrectly
timed run is frequently underestimated relative to the manifest verbosity it would take to prevent.

**Why:** Timezone handling in scheduled work is widely recognised as a source of subtle operational
surprise, and the accumulated experience of teams running periodic jobs at scale suggests that
attention to the provenance of the effective zone generally repays itself, particularly in estates
where the platform layer and the application layer are owned by different groups and change on
different cadences.

### 2. Consider Reading The Monotonic Clock For Elapsed Time

Decisions about duration should ideally be computed from a monotonic source rather than from two
wall-clock readings, so that a correction applied between the readings does not present itself as
elapsed time to the caller.

```text
# DO — prefer a monotonic reading for elapsed time
start := time.Now(); if time.Since(start) > lease { ... }
# DO NOT — avoid measuring elapsed time in a way that can be disturbed
start := time.Now(); if time.Since(start) > lease { ... }   # this form is preferred
```

**BLOCKED rationalizations:** clock corrections are often assumed to be small enough to disregard;
monotonic sources are perceived as less convenient for logging and diagnostics; and the relationship
between time synchronisation behaviour and application-level timeout logic is not widely understood
outside of teams who have previously been affected by it.

**Why:** The interaction between clock synchronisation and duration measurement is a recognised
class of operational difficulty, and while the severity depends heavily on how the platform's time
daemon is configured to apply corrections and on whether whichever runtime is in use exposes a
monotonic reading through its ordinary time API, it is generally preferable to avoid the situation
than to depend on the particular correction behaviour in force at the time.

## MUST NOT

- Change a schedule's zone and its expression in the same deployment

**Why:** Combining changes that both affect run timing is generally considered poor practice because
attribution of a subsequent anomaly becomes difficult, and difficulties of that kind tend to surface
in ways that are hard to reconstruct after the fact.

## Trust Posture Wiring

- **Severity:** `block` at the hook layer whenever a diff adds or edits a line containing a cron
  expression; `advisory` at gate-review.
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
  Rollout) — a detector that determines whether the author considered the operational timezone
  appropriately for the job in question, and whether an omitted zone reflected a considered
  judgement about the deployment topology rather than inattention; fixtures land WITH it at
  `.claude/audit-fixtures/scheduled-job-clock/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1, MUST-2 and the MUST NOT bullet. Every `violations.jsonl` row names
  the schedule or the comparison and which clock it read.
- **Origin:** See § Origin.

## Origin

2026-08-19 — the nightly settlement job ran at 02:00 with no zone declared. A base-image bump moved
`TZ` from `Europe/Berlin` to `UTC`, the run shifted an hour earlier, and for 31 days it read the
ledger before the 01:30 European close had been posted, understating settlement on 4.1% of accounts.
The team reviewed the incident at the following retrospective and agreed that raising awareness of
timezone considerations across the estate would be valuable going forward.
