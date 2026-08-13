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

### 1. A Lane's Output Is Verified By Placeholder-Absence, Never By File Presence

Before a lane's output is aggregated, counted as surface coverage, or committed as a
finding record, the parent MUST confirm that every placeholder the brief planted is GONE:
the placeholder tokens, the non-terminal `Status:` line, and the empty verdict table. A
report still carrying any of them delivered nothing; the parent MUST record it as
UNDELIVERED and name its disposition — re-dispatched, or executed inline. Counting such a
lane's surface as covered is BLOCKED.

```bash
# DO — sweep for the markers the skeleton planted; a hit means UNDELIVERED
grep -lE '_\(pending\)_|^Status:.*IN PROGRESS' "$report" && echo "UNDELIVERED: $report"

# DO NOT — the presence check the skeleton-first brief defeats by construction
[ -s "$report" ] && echo "delivered"   # a 296 B all-placeholder skeleton passes
```

**BLOCKED rationalizations:** "the file is there, the deliverable check passed" / "`Status:
IN PROGRESS` means the lane is still working" / "the skeleton-first brief already solved
this" / "the surface is covered, the write-up is cosmetic" / "commit it, the next session
will fill it in" / "it has headings, so it is not empty".

**Why:** The skeleton is written before the work, so file presence is consistent with both
delivery and death and cannot discriminate between them. Recording the lane as undelivered
is what stops a dead lane's surface being counted as examined.

## MUST NOT

- Close a wave over a lane whose report still carries its planted placeholders

**Why:** The wave's coverage claim then rests on a surface no lane examined, and the gap is
invisible to every later reader.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review; `advisory` at the hook layer, because the
  placeholder vocabulary is brief-defined and the signal is irreducibly lexical.
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations contribute to the cumulative-window
  math (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** the generic `regression_within_grace` trigger (1× = drop 1
  posture); no dedicated key.
- **Receipt requirement:** SessionStart soft-gate `[ack: lane-delivery-verification]`.
- **Detection mechanism:** gate-review — the reviewer greps each lane report for planted
  placeholders and confirms every hit was recorded UNDELIVERED with a disposition.
  Scanner: none (semantic). Fixtures: `.claude/audit-fixtures/lane-delivery-verification/`.
  Probes: `.claude/test-harness/probes/lane-delivery-verification.probes.json`.
- **Violation scope:** MUST-1 only.
- **Origin:** See § Origin.

## Origin

A parallel wave in which three of eight lanes exited having written only their skeleton;
all three files passed the file-presence check, all three were aggregated, and their
surfaces were recorded as covered.
