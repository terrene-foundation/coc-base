---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/flags/**"
  - "**/*feature_flag*"
---

# Feature-Flag Removal Ordering — The Branch Dies Before The Switch

A flag removal has two halves that look interchangeable and are not. Delete the switch first and
every caller falls through to a default nobody chose; delete the dead branch first and the switch
becomes a no-op that is safe to remove at leisure.

## MUST Rules

### 1. The Losing Branch Is Deleted Before Its Switch

A flag removal MUST land the DEAD-BRANCH deletion first and the SWITCH deletion second, in that
order, as two separate merges. Removing the switch while both branches still exist is BLOCKED.

```text
# DO — two merges, dead branch first, so the switch is a proven no-op before it goes
merge 1: delete the `else` arm and its tests; the flag now selects between X and X
merge 2: delete the flag read, its config key and its default
# DO NOT — one merge that removes the read and leaves the arms to the compiler
if flag.enabled("new_pricing"):  ->  (deleted; both arms still present, neither reachable)
```

**BLOCKED rationalizations:** "the flag has been at 100% for months" / "one PR is easier to
review than two" / "the compiler will tell us if a branch is unreachable" / "we can roll back the
whole thing if it goes wrong" / "the losing branch is obviously dead, I read it".

**Why:** Between the two merges the system is in a state one of them created, so the order decides
which state is live under partial rollout — dead-branch-first leaves a no-op switch, switch-first
leaves an unchosen default serving traffic.

### 2. The Flag's Config Key Outlives Its Code By One Release

The config key MUST remain declared, and MUST read as its terminal value, for one full release
after the code that reads it is deleted. Deleting key and reader in the same release is BLOCKED.

```text
# DO — reader gone in N, key retained at its terminal value, key removed in N+1
flags.yaml:  new_pricing: true   # retained: no reader since 4.2, remove in 4.3
# DO NOT — key and reader removed together, so a rollback to N-1 finds no key at all
flags.yaml:  (new_pricing deleted in the same release as its last reader)
```

**BLOCKED rationalizations:** "nothing reads it, so it is dead weight" / "the rollback path is
theoretical" / "leaving dead config is untidy" / "we can re-add the key if we ever roll back".

**Why:** A rollback to the previous release restores a reader for a key that no longer exists, and
the resulting lookup miss resolves to the library default rather than the operator's last value.

## MUST NOT

- Remove a flag whose terminal value was never observed in production telemetry

**Why:** A flag assumed to be at 100% but never measured there may be serving a minority cohort a
different branch, so its removal silently changes behaviour for exactly the users nobody looked at.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms the two merges
  landed in order and that the config key is retained); `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing (2026-07-30 → 2026-08-06).
- **Cumulative posture impact:** same-class violations (a switch removed before its dead branch; a
  config key removed in the same release as its last reader) contribute to `trust-posture.md`
  MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1
  posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger
  key. Named deviation from the canonical key-per-clause shape, recorded here per
  `trust-posture.md` Rule 8: minting one would drag that file, a `self-referential-codify.md`
  allowlist path, into a self-referential edit.
- **Receipt requirement:** SessionStart soft-gate `[ack: flag-removal-ordering]` IFF
  `posture.json::pending_verification` includes the `flag-removal-ordering` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads the two merges and the
  flag manifest. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — an advisory
  detector flagging a diff that deletes a `flags.enabled("<key>")` call site while another hunk in
  the same diff still contains both arms of the conditional it guarded. Both halves are AST facts
  over the same patch, so the deferral names a structural signal and books enforcement that can
  arrive; fixtures land WITH it at `.claude/audit-fixtures/flag-removal-ordering/` per
  `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1, MUST-2 and the MUST NOT bullet. Every `violations.jsonl` row names
  the flag key and which half landed first.
- **Origin:** See § Origin.

## Origin

2026-07-30 — `new_pricing` was removed in one PR. The reader went, both arms stayed, and the
compiler kept the losing arm alive through a shared helper, so 4% of traffic on the previous
release served the old prices for nine days. The incident is why this rule fixes an ORDER rather
than asking reviewers to confirm a branch is dead — deadness was exactly what everyone believed.
