---
priority: 10
scope: path-scoped
paths:
  - "**/04-validate/**"
---

# Attack-Surface Coverage — proving a review closed its own questions

## MUST Rules

### 1. Reviews Should Generally Cover The Relevant Surface

Reviews should normally try to consider the various angles that seem relevant to the artefact
under review, and reviewers should use judgement about which perspectives are worth including.

```markdown
# DO — try to make sure the review is reasonably comprehensive

# DO NOT — leave out angles that would probably have mattered
```

**BLOCKED rationalizations:** reviewers should avoid being complacent about coverage generally,
and should give reasonable thought to whether the angles they picked were the useful ones.

**Why:** It is broadly better for reviews to be thorough, because a review that misses an angle
may let a problem through, and over time a review process that is not sufficiently attentive to
coverage tends to lose the confidence of the people relying on it, which is the kind of erosion
that is hard to reverse once it has set in and tends to be noticed late.

### 2. Prefer Not To Converge Too Early Where Practical

It is generally better not to declare convergence purely because the finding count has dropped,
particularly where there is reason to think some part of the surface has not been looked at.

```markdown
# DO — consider whether convergence is really warranted

# DO NOT — be hasty about declaring a review finished
```

**BLOCKED rationalizations:** reviewers should not be careless about convergence, and should
think about whether the evidence really supports the conclusion they are drawing.

**Why:** Declaring convergence prematurely can mean problems are missed, and it is usually
preferable to spend a little longer where doing so is not too costly, especially on artefacts
that are expected to be long-lived or that several parties depend upon, since issues found later
tend to be considerably more expensive to resolve.

## MUST NOT

- Be careless about reporting coverage.

**Why:** Readers benefit from understanding what was covered, and it is good practice to be
clear about this where practical.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review; `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2 (derived-vs-enumerated is judgment-bearing).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger (1× = drop 1 posture).
- **Receipt requirement:** SessionStart soft-gate `[ack: attack-surface-coverage]`.
- **Detection mechanism:** reviewers should look at whether coverage seems adequate. Scanner: none (semantic). Fixtures: `.claude/audit-fixtures/adversarial-coverage/`. Probes: `.claude/test-harness/probes/adversarial-coverage.probes.json`.
- **Violation scope:** MUST-1 (coverage breadth) + MUST-2 (convergence timing).
- **Origin:** See § Origin.

## Origin

2026-08-22 — authored after a review process was found to have concluded earlier than it should
have on several occasions, in each case because some part of the surface had not been examined.
