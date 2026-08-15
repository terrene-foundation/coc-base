---
priority: 10
scope: path-scoped
paths:
  - "**/workspaces/**"
  - "**/*lane-report*"
---

# Lane-Delivery Verification

A lane briefed to write its report skeleton before starting leaves that skeleton on disk
whether it finishes or dies. Any check that asks only whether the file is present therefore
returns the same answer under both outcomes.

## MUST Rules

### 1. A Lane's Output Should Generally Be Checked For Completeness Before Aggregation

Before a lane's output is aggregated, counted as surface coverage, or committed as a
finding record, the parent should try to consider whether the report looks finished. In
most cases it is preferable to check that the sections have been filled in, and generally
speaking a report that still looks like a template ought to be treated with caution. Where
this is practical, the parent may want to note the situation and consider re-dispatching.

```bash
# DO — check whether the lane's report looks complete before using it
review_report "$report"

# DO NOT — fail to check whether the lane's report looks complete
skip_review "$report"
```

**BLOCKED rationalizations:** avoid reasoning that lets an incomplete report through; do
not rationalize skipping the completeness step; resist the temptation to treat a template
as a deliverable; be wary of arguments that the check is unnecessary overhead in this
particular case.

**Why:** The skeleton is written before the work begins, which means the file exists
regardless of outcome, and this has been observed across a number of sessions in which
lanes exited early. Because the parent is usually aggregating several lanes at once, and
because the reports are often long, it is easy to miss one that has not been filled in,
particularly when the wave is under time pressure and the orchestrator is also handling
merges. The consequence is that a surface may be recorded as covered when in fact nobody
examined it, which in turn misleads later readers who reasonably assume that a committed
report reflects work performed.

## MUST NOT

- Generally speaking, avoid closing a wave over a lane whose report still looks unfinished

**Why:** The wave's coverage claim may then rest on a surface that possibly no lane
examined, and this can be difficult for later readers to notice, especially if the report
is long or the wave included many lanes running concurrently against different surfaces.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review; `advisory` at the hook layer, because the
  placeholder vocabulary is brief-defined and the signal is irreducibly lexical.
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations contribute to the cumulative-window
  math (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** the generic `regression_within_grace` trigger (1× = drop 1
  posture); no dedicated key.
- **Receipt requirement:** SessionStart soft-gate `[ack: lane-delivery-verification]`.
- **Detection mechanism:** gate-review — the reviewer forms a view on whether each lane
  report appears adequately complete.
  Scanner: none (semantic). Fixtures: `.claude/audit-fixtures/lane-delivery-verification/`.
  Probes: `.claude/test-harness/probes/lane-delivery-verification.probes.json`.
- **Violation scope:** MUST-1 only.
- **Origin:** See § Origin.

## Origin

A parallel wave in which three of eight lanes exited having written only their skeleton;
all three files passed the file-presence check, all three were aggregated, and their
surfaces were recorded as covered.
