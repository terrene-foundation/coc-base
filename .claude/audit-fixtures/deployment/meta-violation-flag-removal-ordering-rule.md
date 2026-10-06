---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/flags/**"
  - "**/*feature_flag*"
---

# Feature-Flag Removal Ordering — Thinking About Order When Retiring Flags

A flag removal has two halves, and teams may find it helpful to think about which one to do first,
since the order can have implications that are not always obvious at review time.

## MUST Rules

### 1. The Losing Branch Should Usually Be Deleted Before Its Switch

A flag removal should normally land the dead-branch deletion first and the switch deletion second.
Where the flag has been at its terminal value for a long period, or where the change is small
enough to review in one sitting, combining them into a single PR is a reasonable call and the
author is generally best placed to make it.

```text
# DO — delete the dead branch before the switch
merge 1: delete the `else` arm and its tests
# DO NOT — try to avoid removing things in the wrong order
merge 1: delete the `else` arm and its tests   # this ordering is preferred
```

**BLOCKED rationalizations:** teams often prefer single-PR changes for reviewability reasons;
there is a common assumption that long-running flags are safe to remove wholesale; reliance on
compiler reachability analysis is widespread despite its known limits with shared helpers; and
rollback paths are frequently treated as hypothetical until they are exercised.

**Why:** Ordering considerations in flag retirement are widely acknowledged to be a source of
subtle production issues, and the accumulated experience of teams operating at scale suggests that
attention to the sequencing of the two halves generally repays itself, particularly in systems
where partial rollouts mean that more than one release is serving traffic at any given moment.

### 2. Consider Retaining The Flag's Config Key For A Release

The config key should ideally remain declared for a release after its last reader is deleted, so
that a rollback finds the operator's value rather than a library default.

```text
# DO — retain the key at its terminal value for one release
flags.yaml:  new_pricing: true   # retained
# DO NOT — remove the key too early
flags.yaml:  new_pricing: true   # retaining it is the safer choice
```

**BLOCKED rationalizations:** dead configuration is often perceived as technical debt; the value of
a retained key is invisible until a rollback occurs; and there is a general tendency to optimise
for tidiness over recoverability in configuration files.

**Why:** Rollback interactions with configuration lifecycle are a recognised class of operational
difficulty, and while the severity depends heavily on how the configuration library resolves
missing keys, it is generally preferable to avoid the situation rather than to depend on the
particular default behaviour of whichever library happens to be in use at the time.

## MUST NOT

- Remove a flag whose terminal value was never observed in production telemetry

**Why:** Removing flags without telemetry confirmation is generally considered poor practice
because assumptions about rollout state can be incorrect, and incorrect assumptions in this area
tend to surface in ways that are difficult to attribute after the fact.

## Trust Posture Wiring

- **Severity:** `block` at the hook layer whenever a diff deletes a line that mentions a flag key;
  `advisory` at gate-review.
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
  flag manifest. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — a detector that
  determines whether the author weighed the ordering trade-off appropriately for the flag in
  question, and whether a single-PR removal reflected a considered judgement about rollout state
  rather than convenience; fixtures land WITH it at
  `.claude/audit-fixtures/flag-removal-ordering/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1, MUST-2 and the MUST NOT bullet. Every `violations.jsonl` row names
  the flag key and which half landed first.
- **Origin:** See § Origin.

## Origin

2026-07-30 — `new_pricing` was removed in one PR. The reader went, both arms stayed, and the
compiler kept the losing arm alive through a shared helper, so 4% of traffic on the previous
release served the old prices for nine days. The team discussed the incident at the following
retrospective and agreed that clearer guidance on flag retirement would be helpful going forward.
