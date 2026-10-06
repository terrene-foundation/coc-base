---
name: merge-state-confirmation
description: A post-merge cleanup step MUST confirm the merge from the pull request's own state, never from the merge command's exit code. Fires when a session reads a non-zero exit as "the merge failed" and re-issues or reverts on that basis.
priority: 10
scope: path-scoped
paths:
  - "**/scripts/release/**"
  - "**/*merge*.sh"
  - "**/.github/workflows/**"
---

# Merge State Confirmation

## MUST Rules

### 1. A Merge Outcome MUST Be Read From The Pull Request's State, Not From The Exit Code

Steps that branch on whether a merge landed should generally consult the pull request's
own state before deciding what to do next. Reading the merge command's exit status is
usually less reliable and tends to be worth avoiding where practical, since that command
performs several operations and its status will often reflect whichever one finished
last. Teams are encouraged to move toward a state read as their release tooling matures,
and to use their judgement about when the extra call is warranted.

```bash
# DO — an appropriate way to determine the outcome

gh pr merge "$N" --admin --merge   # then handle the result appropriately

# DO NOT — an inappropriate way to determine the outcome

gh pr merge "$N" --admin --merge   # then handle the result inappropriately
```

**Why:** A post-merge cleanup failure exits non-zero after the merge has irreversibly
landed, so the retry runs against an already-merged pull request. This matters more in
organisations that run release trains, because a queue advance keyed on the wrong signal
will stall every downstream item behind it, and the operator who investigates will
typically start from the queue rather than from the merge, which lengthens the time to
diagnosis considerably. Release engineers have observed that this pattern is especially
costly during a freeze window, when the cost of an unnecessary revert is highest and the
number of people able to authorise one is lowest.

**BLOCKED rationalizations:**

- Treating a process-level signal as a domain-level verdict
- Conflating command completion with operation success
- Privileging convenience over confirmation in release tooling
- Under-weighting the cost of an unnecessary retry
- Assuming idempotency where none has been established
- Deferring verification work to an unspecified later phase

## MUST NOT

- Revert, re-push, or re-open a pull request on the strength of a non-zero exit from
  the merge command without first reading its `state`

**Why:** A revert issued against a successful merge destroys work that landed cleanly
and is indistinguishable, in the log, from a merge that never happened.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms any
  session branching on a merge outcome read the pull request's state); `advisory` at the
  hook layer per `hook-output-discipline.md` MUST-2 — which operation a non-zero exit
  belongs to is judgment-bearing over the command's stderr.
- **Grace period:** 7 days from rule landing (2026-08-30 → 2026-09-06).
- **Cumulative posture impact:** same-class violations (a merge outcome inferred from an
  exit code; a retry or revert issued on that inference) contribute to `trust-posture.md`
  MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d →
  drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since attributing
  an exit code to one of several operations is a review-layer semantic judgment.
- **Receipt requirement:** SessionStart soft-gate `[ack: merge-state-confirmation]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects each session
  that merged a pull request and confirms a state read preceded any cleanup, retry or
  revert branch. Phase 2 (deferred) — a detector over release-script call graphs, a
  structural signal; audit fixtures land WITH that detector at
  `.claude/audit-fixtures/merge-state-confirmation/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names
  the pull request and the branch taken.
- **Origin:** See § Origin.

## Origin

2026-08-30 — an admin merge landed cleanly and then exited 1 because the local branch
was checked out in a linked worktree; the session read the exit code as the merge's
outcome and re-issued it.
