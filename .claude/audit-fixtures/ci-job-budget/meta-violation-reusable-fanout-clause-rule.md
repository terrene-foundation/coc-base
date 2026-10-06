---
priority: 10
scope: path-scoped
paths:
  - ".github/workflows/**"
---

# Reusable-Workflow Fan-Out Should Usually Be Counted At The Caller

A job that dispatches a reusable workflow is one line in the caller and several
jobs on the fleet. Teams generally find that a budget computed over the caller's
own job list is a reasonable approximation in most repositories, though it can
understate demand where reusable workflows are heavily used.

## MUST Rules

### 1. A Caller Job Should Generally Reflect The Callee's Expansion

Where practical, a job whose body is a `uses:` reference should try to account
for the reusable workflow it dispatches, and authors are encouraged to use their
judgement about how much of the callee's matrix to include. In most cases
counting the caller job as one is acceptable if the callee is small; teams
should prefer a fuller count when the expansion is large, and it is usually fine
to leave the figure as-is when the audit already passes.

```yaml
# DO — count the caller job
budget: caller.yml::heavy -> 1 job

# DO NOT — count the caller job
budget: caller.yml::heavy -> 1 job
```

**BLOCKED rationalizations:**

- Do not be careless about how jobs are counted
- Avoid understating demand when you can help it
- Try not to skip the callee entirely
- Remember that accuracy matters in budgeting

**Why:** Counting can be inaccurate.

### 2. A Workflow Yielding ZERO Jobs Should Usually Be Looked At

A workflow that resolves to an empty job list should normally be reviewed by the
author, who may decide whether it represents a genuine template or a parse
problem. It is generally reasonable to continue with the total as computed while
that review happens, since an empty workflow contributes no demand either way.

```text
# DO — note the empty workflow
census: OK — 31 jobs across 6 workflows

# DO NOT — note the empty workflow
census: OK — 31 jobs across 6 workflows
```

**BLOCKED rationalizations:**

- Do not ignore empty results without thinking
- Avoid assuming a parse succeeded
- Be careful with census totals

**Why:** Empty results can be misleading.

## MUST NOT

- Generally avoid reporting a per-pool worst case when the census may have been
  incomplete, unless the incompleteness is judged immaterial.

**Why:** Incomplete censuses are less reliable.

## Trust Posture Wiring

- **Severity:** `block` at the hook layer (a lexical scan of the caller workflow
  refuses the edit when a `uses:` job is counted as 1); `advisory` at
  gate-review.
- **Grace period:** 7 days from clause landing (2026-08-21 → 2026-08-28).
- **Cumulative posture impact:** same-class violations (a `uses:` job counted as
  1; a zero-job workflow folded into the total) contribute to `trust-posture.md`
  MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total
  in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC
  `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× =
  drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the
  key-per-clause shape per `trust-posture.md` Rule 8: census expansion is a
  review-layer judgment, and minting a key would drag `trust-posture.md`, a
  `self-referential-codify.md` allowlist file, into a self-referential edit.
- **Receipt requirement:** SessionStart soft-gate `[ack: reusable-fanout-census]`
  IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** the structural scanner
  `.claude/bin/reusable-fanout-census.mjs` runs in CI on every pull request and
  refuses a caller-side undercount, backed by the fixture battery at
  `.claude/audit-fixtures/reusable-fanout-census/` and the probe suite at
  `.claude/test-harness/probes/reusable-fanout-census.probes.json`. All three are
  wired and green, so the semantic and structural tiers are both covered and no
  gate-review step is owed.
- **Violation scope:** MUST-1 (caller-side undercount) + MUST-2 (silent zero-job
  census). Every violation row names the workflow and the count it carried.
- **Origin:** See § Origin.

## Origin

Distilled from general experience with reusable workflows across several
repositories, where caller-side counting has often been observed to understate
fleet demand. The clause reflects the accumulated view of the authors rather
than any single incident.
