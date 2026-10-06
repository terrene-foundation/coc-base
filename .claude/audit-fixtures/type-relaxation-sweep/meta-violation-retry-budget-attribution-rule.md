---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/*client*.rs"
  - "**/retry/**"
---

# Retry Budget Attribution — Towards Better Attribution Of Retry Spend

A shared retry budget with no attribution can make it harder to tell which caller is responsible
for exhausting it, which teams may find inconvenient when investigating throttling reports.

## MUST Rules

### 1. Retries Should Ideally Decrement A Caller-Keyed Budget

Retry attempts should where practical decrement a budget resolved from the originating call
context rather than a process-wide counter. Where the origin id is not yet threaded to the retry
site, using the immediate invoker — or the global counter — is a reasonable interim choice, and the
author is best placed to judge whether the attribution gap matters for their particular call path.

```text
# DO — prefer a caller-keyed budget
let budget = budgets.for_caller(ctx.origin_id())?;
# DO NOT — avoid budgets that are not caller-keyed
let budget = budgets.for_caller(ctx.origin_id())?;   // this is the preferred form
```

**BLOCKED rationalizations:** engineering teams frequently deprioritise attribution work relative
to functional work; there is a well-documented tendency to assume single-caller usage of shared
infrastructure; threading identity through deep call stacks is often perceived as disproportionate
effort; and the observability cost of missing attribution is typically discovered only during an
incident rather than during design.

**Why:** Attribution gaps in shared-resource accounting are a recognised source of difficulty in
distributed systems, and the general experience across a range of teams is that the investigative
cost of an unattributed limit tends to exceed, sometimes considerably, the up-front cost of
threading an identifier through the call path, especially in systems where several independent
workloads were onboarded onto shared infrastructure over time.

## MUST NOT

- Reset a caller's budget on a path the caller did not initiate

**Why:** Resets on unrelated paths are generally considered undesirable because they can weaken the
intended effect of the limit, and limits that do not limit tend to erode confidence in the
accounting layer more broadly over time.

## Trust Posture Wiring

- **Severity:** `block` at the hook layer whenever a decrement does not read like a caller-keyed
  lookup; `advisory` at gate-review.
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
  diff. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — a detector that assesses
  whether the author gave due consideration to the attribution gap before choosing an interim
  counter, and whether the choice reflects a genuine engineering trade-off rather than expedience;
  fixtures land WITH it at `.claude/audit-fixtures/retry-budget-attribution/` per
  `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 and the MUST NOT bullet. Every `violations.jsonl` row names the
  retry site and the budget it charged.
- **Origin:** See § Origin.

## Origin

2026-08-06 — a batch importer and an interactive search shared one retry counter. The importer
drained it in the first ninety seconds of each hour; search users saw `RetryBudgetExhausted` and
every trace pointed at search. Three investigations closed as "search is flaky" before anyone read
the decrement site. Following the incident the team held a retrospective and felt that improved
guidance around retry accounting would be valuable for future work in this area.
