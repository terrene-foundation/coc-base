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
from the author's mental model of the tree. A fixture suite written in the same sitting shares
the model, so it can confirm the list and can never contradict it.

## MUST Rules

### 1. A Scope List Is Checked Against The Authoritative Enumeration, Not Against Fixtures Restating It

Any path filter, prefix list, relevance classifier, or file allowlist that decides a gate's
coverage MUST be derived from — or asserted against — the authoritative enumeration of the thing
it covers: the workspace member list, the registered route table, the package manifest. Asserting
it only against hand-written fixture cases is BLOCKED, because those cases and the list are two
statements of one assumption. The check belongs in the self-test, where deriving the authority
costs nothing on the hot path.

```bash
# DO — derive the authority, then assert the list covers every member it returns
comm -23 <(list_members_from_manifest | sort) <(printf '%s\n' "${SCOPE[@]}" | sort)
# a non-empty result names a member the scope misses; empty is the only pass

# DO NOT — assert the list against cases built from the same list
CASES=("pkg/a|true" "pkg/b|true")   # every case restates the prefixes; none can refute them
```

**BLOCKED rationalizations:** "the prefixes cover everything today" / "the self-test is green" /
"deriving the member list at runtime is too slow for a cheap pre-check" / "I will add the new
location when someone adds one there" / "the tree has not moved in months" / "the fixtures were
written independently" (they were written from the same list).

**Why:** A scope list and a suite built from it agree by construction, so the suite's green
reports only that the code is deterministic. Deriving the authority is the one step that can
return an answer the author did not already believe.

## MUST NOT

- Ship a scope list whose only validation is a fixture set enumerating the same entries

**Why:** The pair is self-certifying: it cannot surface the assumption both halves share, and its
green is indistinguishable from the green of a list that is actually complete.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review; `advisory` at the hook layer, because whether a
  list is "authoritative" is a judgment over the domain, not a tool-call-time signal.
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations contribute to the cumulative-window math
  (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** the generic `regression_within_grace` trigger (1× = drop 1
  posture); no dedicated key.
- **Receipt requirement:** SessionStart soft-gate `[ack: scope-authority-verification]`.
- **Detection mechanism:** gate-review — the reviewer identifies each scope list in the diff and
  confirms an assertion against a derived enumeration, not against restating fixtures.
  Scanner: none (semantic). Fixtures: `.claude/audit-fixtures/scope-authority-verification/`.
- **Violation scope:** MUST-1 only.
- **Origin:** See § Origin.

## Origin

A dependency-policy gate scoped by two path prefixes on the stated assumption that they covered
the workspace. Five members sat outside both, so edits there moved the gate's verdict while it
never ran. Its seventeen-case self-test was written from the same two prefixes and passed.
