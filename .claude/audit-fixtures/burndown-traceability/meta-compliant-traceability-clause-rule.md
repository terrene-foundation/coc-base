---
priority: 10
scope: path-scoped
paths:
  - "**/burndown/**"
  - "**/.session-notes.shared.md"
---

# Index Traceability — A Status With Nowhere To Go Is Not A Status

## MUST Rules

### 1. Every Index Row Resolves To A Committed Ruling

Every row in a tracked index MUST carry a pointer resolving to a TRACKED file under a
declared durable root, and that file MUST name the row's id verbatim. A pointer cell
holding prose, an em-dash, `TBD`, or an empty string is BLOCKED.

```markdown
# DO — the pointer resolves and the target names the id back

| F87-upflow-loop | `workspaces/…/register-context.md#F87-upflow-loop` |

# DO NOT — decoration in the pointer cell

| F87-upflow-loop | still being investigated |
```

**BLOCKED rationalizations:** "the description is more useful than a path" · "it's in my
notes" · "the file exists, I can see it" · "I'll link it after the backfill" · "the
status word is the information" · "reconcile won't touch that row".

**Why:** A reader acting on a bare status word acts on the word alone and gets it wrong.
An unresolvable pointer is indistinguishable from a filled one to every check keyed on
non-emptiness, so the gap is invisible exactly where it is relied upon.

### 2. The Join Key Is The FULL Id, Never A Bare Ordinal

Back-references MUST match the complete id. A bare ordinal MUST NOT be the join key,
because the ordinal namespace is REUSED across sessions and a reused ordinal resolves
green against the wrong ruling.

```markdown
# DO — `git grep -F F87-upflow-loop` lands on the ruling for THIS item

# DO NOT — anchor on `F87`, which also matches an unrelated session's decision
```

**BLOCKED rationalizations:** "the suffix is cosmetic" · "there's only one F87" · "the
date disambiguates it" · "the index already uses the short form" · "rewriting the rows
is churn for no behavioural gain".

**Why:** A reused ordinal wires a row to another session's ruling with every link
resolving green. The defect therefore passes every check that only asks whether the
pointer resolved, which is the class of check most indexes actually run.

## MUST NOT

- Report an unchecked coverage dimension as clean.

**Why:** Absence and success render as the same bytes downstream; only an explicit
declaration separates them.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review; `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2 (pointer adequacy is judgment-bearing).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations contribute to `trust-posture.md`
  MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger (1× = drop 1).
- **Receipt requirement:** SessionStart soft-gate `[ack: index-traceability]`.
- **Detection mechanism:** the index checker refuses on a dangling row; fixtures
  `.claude/audit-fixtures/index-traceability/`; gate-review confirms the join key is the
  full id.
- **Violation scope:** MUST-1 (unresolvable pointer) + MUST-2 (bare-ordinal join key).
- **Origin:** See § Origin.

## Origin

2026-08-22 — authored after four index rows shipped carrying a status word and no
reachable ruling, and a fifth was wired to an unrelated session's decision through a
reused ordinal. Both classes resolved green against every check that asked only whether
the pointer cell was non-empty.
