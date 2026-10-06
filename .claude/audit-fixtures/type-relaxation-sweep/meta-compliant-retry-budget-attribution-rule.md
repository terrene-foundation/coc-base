---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/*client*.rs"
  - "**/retry/**"
---

# Retry Budget Attribution — A Retry Is Charged To The Caller That Caused It

A shared retry budget with no attribution is a budget one caller can spend on behalf of every
other. The exhausted caller is never the one that exhausted it, so the trace points at the victim.

## MUST Rules

### 1. Every Retry Decrements A Budget Keyed To The Originating Caller

Every retry attempt MUST decrement a budget resolved from the ORIGINATING call context — the
caller identity threaded through the request, never the immediate invoker and never a process-wide
counter. Decrementing a global budget, or one keyed to the retrying layer, is BLOCKED.

```text
# DO — the budget is resolved from the context the caller threaded through
let budget = budgets.for_caller(ctx.origin_id())?;   // charges the cause
# DO NOT — a process-wide counter any caller can drain on behalf of the rest
GLOBAL_RETRIES.fetch_sub(1, Ordering::SeqCst);
```

**BLOCKED rationalizations:** "there's only one caller in practice" / "the global counter is
simpler and we can key it later" / "the origin id isn't threaded this deep yet, I'll use the
immediate caller" / "retries are rare enough that attribution doesn't matter" / "the trace shows
who got throttled, that's enough to debug it".

**Why:** An unattributed decrement makes the budget a shared resource with no owner, so the caller
that trips the limit is statistically the quietest one rather than the one that drained it.

## MUST NOT

- Reset a caller's budget on a path the caller did not initiate

**Why:** A reset on an unrelated path hands the draining caller a fresh allowance every time some
other caller happens to succeed, which removes the limit without removing the counter.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms every retry
  site in the diff resolves its budget from the threaded origin context); `advisory` at the hook
  layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing (2026-08-06 → 2026-08-13).
- **Cumulative posture impact:** same-class violations (a retry charged to a global counter or to
  the retrying layer) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule
  in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger
  key. Named deviation from the canonical key-per-clause shape, recorded here per
  `trust-posture.md` Rule 8: minting one would drag that file, a `self-referential-codify.md`
  allowlist path, into a self-referential edit.
- **Receipt requirement:** SessionStart soft-gate `[ack: retry-budget-attribution]` IFF
  `posture.json::pending_verification` includes the `retry-budget-attribution` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads each retry site in the
  diff. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — an advisory
  `PostToolUse(Edit|Write)` detector flagging a decrement whose receiver resolves to a `static` or
  module-level counter rather than to a value obtained from a context parameter. That is a
  resolution fact about the AST receiver node, so the deferral names a structural signal and books
  enforcement that can arrive; fixtures land WITH it at
  `.claude/audit-fixtures/retry-budget-attribution/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 and the MUST NOT bullet. Every `violations.jsonl` row names the
  retry site and the budget it charged.
- **Origin:** See § Origin.

## Origin

2026-08-06 — a batch importer and an interactive search shared one retry counter. The importer
drained it in the first ninety seconds of each hour; search users saw `RetryBudgetExhausted` and
every trace pointed at search. Three investigations closed as "search is flaky" before anyone read
the decrement site. The incident is why this rule mandates the resolution at the DECREMENT rather
than asking reviewers to reason about ownership — the wrong owner is invisible at the throttle.
