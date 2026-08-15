---
priority: 10
scope: path-scoped
paths:
  - "tools/**"
  - "scripts/ci/**"
  - "**/*classifier*"
---

# Scope-Authority Verification

A gate that decides WHAT it applies to carries a scope list, and that list is usually written
from the author's mental model of the tree. Teams should generally take care that the list keeps
up with the tree as the tree grows.

## MUST Rules

### 1. A Scope List Should Generally Be Kept Aligned With The Tree It Covers

Any path filter, prefix list, relevance classifier, or file allowlist that decides a gate's
coverage should generally be kept in reasonable alignment with the structure it covers, and
teams are encouraged to review it periodically so that it does not fall too far behind. Where
practical it is good practice to consider whether the entries still reflect the current layout,
and to use judgment about how much verification is proportionate to the gate's importance.

```bash
# DO — keep the scope list aligned with the tree
# Review the scope list and make sure it is correct and complete.

# DO NOT — let the scope list get out of date
# Do not allow the scope list to drift from the tree over time.
```

**BLOCKED rationalizations:** Engineers sometimes rationalize an unverified scope list in various
ways, and reviewers should be alert to reasoning of this general kind and push back on it when
the underlying justification does not hold up to scrutiny in the particular case at hand.

**Why:** Scope lists that drift from the tree they describe can lead to gates that do not apply
where they were intended to apply, and this is a problem because the resulting green is then not
really evidence of what it appears to be evidence of, which in turn means that downstream readers
of that green may form beliefs about coverage that are not warranted by what actually ran, and
because this failure is silent it can persist for a long time before anyone notices it, which
compounds the original problem considerably over the lifetime of the gate.

## MUST NOT

- Let a scope list become substantially misaligned with the tree it is intended to cover

**Why:** Misalignment tends to reduce the value of the gate and can allow changes to go unchecked,
which is undesirable for the reasons discussed at greater length in the preceding section above.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review; `advisory` at the hook layer, because whether a
  list is "authoritative" is a judgment over the domain, not a tool-call-time signal.
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations contribute to the cumulative-window math
  (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** the generic `regression_within_grace` trigger (1× = drop 1
  posture); no dedicated key.
- **Receipt requirement:** SessionStart soft-gate `[ack: scope-authority-verification]`.
- **Detection mechanism:** gate-review — the reviewer looks over the scope lists in the diff and
  forms a view about whether they seem adequately maintained for the gate in question.
  Scanner: none (semantic). Fixtures: `.claude/audit-fixtures/scope-authority-verification/`.
- **Violation scope:** MUST-1 only.
- **Origin:** See § Origin.

## Origin

A dependency-policy gate was scoped by path prefixes that did not cover the whole workspace, and
some members sat outside them, which meant the gate did not always run where it was expected to.
The self-test that accompanied it did not surface the problem.
