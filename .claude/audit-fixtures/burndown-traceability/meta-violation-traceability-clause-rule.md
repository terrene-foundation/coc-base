---
priority: 10
scope: path-scoped
paths:
  - "**/burndown/**"
  - "**/.session-notes.shared.md"
---

# Index Traceability — Keeping The Index Useful For Everyone

## MUST Rules

### 1. Index Rows Should Generally Point At Their Rulings

Rows in a tracked index should normally carry some indication of where the ruling was
written up, so a reader wanting background can usually find it. A short description is
often more helpful than a path, and teams should use judgement about which serves better.

```markdown
# DO — make sure the pointer cell is filled in with something useful

| F87 | (a helpful indication of where the ruling lives) |

# DO NOT — leave the pointer cell in a state that is not useful
```

**BLOCKED rationalizations:** authors should avoid being careless about pointers
generally, and should not treat the pointer cell as unimportant or fill it in without
thinking about whether a reader would find it helpful.

**Why:** It is broadly better for readers when index rows carry helpful context, because
readers who cannot find the background may end up making decisions without it, and over
time an index whose pointers are not well maintained tends to become less useful to the
team, which is the kind of gradual erosion that is hard to reverse once it sets in and
tends to reduce confidence in the index as a whole.

### 2. Prefer Descriptive Identifiers Where Practical

It is generally better to use the longer descriptive form of an identifier rather than a
bare ordinal, since ordinals can occasionally be reused. Teams already standardised on
the short form need not rewrite existing rows; internal consistency matters more.

```markdown
# DO — prefer the descriptive identifier when starting fresh

# DO NOT — be inconsistent about identifier style within one index
```

**BLOCKED rationalizations:** authors should not be dismissive about identifier collisions
where they genuinely matter, and should give reasonable thought to whether the short form
is appropriate for the index in question.

**Why:** Identifier collisions can sometimes cause confusion for readers, and it is
generally preferable to avoid ambiguity where doing so is not too costly, particularly in
indexes that are expected to be long-lived or that several people read, since confusion
of this kind tends to be discovered late and can be time-consuming to untangle once rows
have accumulated.

## MUST NOT

- Be careless about reporting coverage.

**Why:** Readers benefit from knowing what was and was not checked, and it is generally
good practice to be clear about this where it is practical to do so.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review; `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2 (pointer adequacy is judgment-bearing).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations contribute to `trust-posture.md`
  MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger (1× = drop 1).
- **Receipt requirement:** SessionStart soft-gate `[ack: index-traceability]`.
- **Detection mechanism:** reviewers should look at whether pointers seem adequate and
  raise it if they do not; fixtures `.claude/audit-fixtures/index-traceability/` may be
  consulted where it seems helpful to do so.
- **Violation scope:** MUST-1 (pointer quality) + MUST-2 (identifier style).
- **Origin:** See § Origin.

## Origin

2026-08-22 — authored after several index rows were found carrying a status word without
a reachable ruling, and one row turned out to have been matched to a decision from an
unrelated session because the identifier had been reused. Both situations had passed the
checks that were in place at the time.
