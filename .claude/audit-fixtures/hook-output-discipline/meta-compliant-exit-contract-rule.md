---
name: cli-exit-contract
description: A CLI's non-zero exit path MUST carry a machine-readable payload naming what failed and what the caller must do. Fires when a tool signals failure through the exit status alone.
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

Any exit path that signals failure MUST first write a structured record to stdout with
four populated fields — `code`, `what_failed`, `evidence`, `caller_must`. A bare
`process.exit(1)` is BLOCKED: the exit status is one integer shared by every failure the
tool can have, so it partitions nothing and the caller is left to guess which branch it
hit from a status it has already seen a dozen times.

```
# DO — the record lands, then the status

write({code: "E_LOCK_HELD", what_failed: "...", evidence: "...", caller_must: "..."})
process.exit(1)

# DO NOT — the status alone, with the reason left in a log nobody reads

if (!lock.acquire()) process.exit(1)
```

**Why:** One integer cannot distinguish a held lock from a bad argument from a missing
file, so the caller either retries the wrong branch or halts on a failure it could have
resolved itself.

**BLOCKED rationalizations:**

- "The message is already on stderr, that is enough for a human"
- "The exit code is the documented interface, that IS the contract"
- "Callers can grep the log if they need the detail"
- "Four fields for a one-line failure branch is bureaucracy"
- "We can add the payload later if anyone complains"
- "The tool name is in the error, that is the what_failed"

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
