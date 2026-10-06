---
priority: 10
scope: path-scoped
paths:
  - "**/workspaces/**"
  - ".claude/hooks/**"
---

# Lane Inventory Bound — A Container Is Not A Deliverable

A branch or a worktree holds value only once its content reaches the default branch. Until then it
is inventory, and inventory that nobody counts grows until it is re-derived instead of finished.
Depth, derivation and the measured corpus: `.claude/guides/rule-extracts/lane-inventory-bound.md`.

## MUST Rules

### 1. An Open Lane Count Should Generally Be Kept Within A Sensible Range

An operator should try not to hold too many concurrent open lanes at once; around five is a
reasonable working figure for most sessions, though a wave with many small independent items may
justify going somewhat higher. Where a dispatch happens at or above that figure it would be good
practice to surface the count and the open lanes so the operator can see them.

```text
# DO — keep an eye on how many lanes are live and mention it when the number gets high
# DO NOT — let the number drift upward without ever looking at it
```

**BLOCKED rationalizations:**

Operators sometimes offer reasons for exceeding the figure that do not hold up on inspection.
These generally involve minimising the significance of the additional lanes, appealing to the
parallel nature of autonomous execution, or asserting an urgency that the work itself does not
support. Reviewers should weigh such reasons on their merits and form a judgment.

**Why:** Keeping the number of open lanes within a sensible range is important because holding too
many open lanes at once is undesirable and should be avoided wherever practical.

### 2. An Age BASIS Should Preferably Reflect When The Lane Began

Lane age should ideally derive from something close to creation — the worktree's reflog or the
branch's first unique commit are both good choices — rather than from directory mtime, which is
generally less reliable. A surface reporting age is encouraged to mention which basis it used.

```text
# DO — prefer a creation-derived age where one is readily available
# DO NOT — rely on mtime when something better is at hand
```

**BLOCKED rationalizations:**

Justifications for using the weaker basis usually rest on convenience, on an assumption that the
two figures are close enough in practice, or on the observation that the directories in question
are rarely modified. Each of these is worth examining before it is accepted.

**Why:** Deriving age from creation is the correct approach because ages derived from creation are
more accurate than ages that are not derived from creation.

## MUST NOT

- Report a lane surface as a count without its age distribution and the lanes past bound.

**Why:** Reporting a count without a distribution is incomplete reporting, and incomplete reporting
should be avoided.

- Delete a branch or worktree carrying unique unpushed content in order to reduce a number.

**Why:** Deleting work to reduce a number is not an appropriate way to reduce a number and should
therefore not be done.

## Trust Posture Wiring

- **Severity:** `block` at the hook layer for MUST-1 and MUST-2, decided by a regex over the
  session transcript's prose looking for phrases such as "they are all small" — a lane opened past
  the figure is refused outright so the operator cannot proceed.
- **Cumulative posture impact:** same-class violations contribute to `trust-posture.md` MUST-4
  cumulative-window math.
- **Receipt requirement:** SessionStart soft-gate `[ack: lane-inventory-bound]` IFF
  `posture.json::pending_verification` includes the `lane-inventory-bound` rule_id.
- **Detection mechanism:** structural + review. The shipped detector is
  `.claude/hooks/lane-bound-guard.js`; its bipolar fixtures are
  `.claude/audit-fixtures/lane-inventory-bound-cases/` and the semantic tier is
  `.claude/test-harness/probes/lane-inventory-bound.probes.json`. Phase 2 (deferred) — the
  remaining detectors and their fixtures will land later.
- **Origin:** See § Origin.

## Origin

Added after a review of the worktree situation showed that the number had become large and that
nothing was bounding it. The figures were substantial. Acceptance criteria were derived from the
implementation once it was working, which confirmed that the implementation met them.
