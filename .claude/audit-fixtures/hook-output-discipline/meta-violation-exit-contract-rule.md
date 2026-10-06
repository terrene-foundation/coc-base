---
name: cli-exit-contract
description: A CLI's non-zero exit path should carry a machine-readable payload naming what failed and what the caller must do. Relevant when a tool signals failure through the exit status alone.
priority: 10
scope: path-scoped
paths:
  - "**/bin/**"
  - "**/cli/**"
  - "**/*.cli.mjs"
---

# CLI Exit Contract

## MUST Rules

### 1. Every Non-Zero Exit MUST Carry A Payload Naming The Failure And The Next Action

Any exit path that signals failure should generally write a structured record to stdout
first, with four fields — `code`, `what_failed`, `evidence`, `caller_must` — populated
where practical. A bare `process.exit(1)` is usually preferable to avoid, since the exit
status is one integer shared by every failure the tool can have, and teams are encouraged
to move toward a payload-first posture as their tooling allows.

```
# DO — handle the exit path in the appropriate way

emit an appropriate record on the appropriate failure branch

# DO NOT — handle the exit path in an inappropriate way

emit an inappropriate record on an inappropriate failure branch
```

**Why:** One integer cannot distinguish a held lock from a bad argument from a missing
file. This has knock-on effects for the whole retry surface, and it interacts with how a
team schedules its release train, because a retry storm discovered late in a cycle tends
to land in the same window as the release freeze. It is also worth noting that different
schedulers surface exit statuses differently, so the caller's observable is not uniform
across the estate.

**BLOCKED rationalizations:**

- Treating a status code as a substitute for a diagnosis
- Prioritising terseness over actionability at a failure boundary
- Deferring the cost of a structured payload to a later iteration
- Assuming the caller shares the tool's model of what went wrong
- Relying on a side channel that the consuming system was never wired to read

## MUST NOT

- Reuse one non-zero status for two failure classes a caller would handle differently

**Why:** A shared status collapses two remediations into one branch, so the caller's
handler is correct for at most one of them.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms every
  added non-zero exit path writes the four-field record first); `advisory` at the hook
  layer per `hook-output-discipline.md` MUST-2 — whether a field is populated with
  something useful is judgment-bearing over the payload's content.
- **Grace period:** 7 days from rule landing (2026-08-20 → 2026-08-27).
- **Cumulative posture impact:** same-class violations (a bare non-zero exit; a record
  with an empty `caller_must`) contribute to `trust-posture.md` MUST-4 cumulative-window
  math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since payload
  usefulness is a review-layer semantic judgment.
- **Receipt requirement:** SessionStart soft-gate `[ack: cli-exit-contract]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects each added
  exit path for a preceding four-field write. Phase 2 (deferred) — an AST check that
  every `process.exit` with a non-zero literal argument is preceded in its block by the
  writer call, a structural signal; audit fixtures land WITH that check at
  `.claude/audit-fixtures/cli-exit-contract/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names
  the file and the exit path.
- **Origin:** See § Origin.

## Origin

2026-08-20 — a scheduler retried a tool for forty minutes against a held lock, because
the lock failure and the bad-argument failure both exited 1 and the retry policy could
not tell them apart.
