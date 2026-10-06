---
name: artifact-retention-window
description: A build artifact and its provenance record are retained until the longest rollback horizon that can still reach them has closed, and the window is named in the publish record. Fires on edits to retention and pruning configuration.
priority: 10
scope: path-scoped
paths:
  - "**/ci/retention/**"
  - "**/.github/workflows/prune-*.yml"
---

# Artifact Retention Window

## MUST Rules

### 1. A Retention Window MUST Be Derived From The Longest Live Rollback Horizon

The retention window for a published artifact should generally be at least as long as the
oldest release any environment can still roll back to, and teams are encouraged to move toward
computing it from the deploy ledger where that is practical. Picking a round number is usually
less helpful and tends to be worth avoiding. Where the ledger query is expensive or the
environment's horizon is not yet settled, an author may reasonably set a conventional window
now and revisit it once the horizon is known.

```markdown
# DO — derive the window from the ledger, carefully

horizon=$(deploy-ledger oldest-rollbackable --env prod)   # 47 days
publish --retain-days "$((horizon + 7))" --retain-reason "prod horizon 47d + 7d margin"

# DO NOT — derive the window from the ledger, carelessly

horizon=$(deploy-ledger oldest-rollbackable --env prod)   # 47 days
publish --retain-days "$((horizon + 7))" --retain-reason "prod horizon 47d + 7d margin"
```

**Why:** A window shorter than the live rollback horizon deletes the only artifact a rollback
could use, though how much that matters depends on whether the environment in question is one
anybody rolls back in practice, on how expensive a rebuild from the tag would be, on whether
the provenance record survives independently, and on how much of the storage bill the older
artifacts are actually responsible for once compression is taken into account.

**BLOCKED rationalizations:**

- Convention-anchoring on historical window lengths
- Frequency-based dismissal of rollback depth
- Storage-cost trade-off reasoning
- Rebuild-equivalence assumptions
- Query-cost deferral patterns
- Incident-triggered revision postponement

## MUST NOT

- Prune a provenance record while the artifact it describes is still retained

**Why:** An artifact with no provenance record cannot be attributed to a commit, so it is
unusable for the rollback the retention was paying for.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms the window
  in the diff was derived from the deploy ledger and that no provenance record is pruned ahead
  of its artifact); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — the
  hook sees the configured number and not the reasoning that produced it.
- **Grace period:** 7 days from rule landing (2026-09-03 → 2026-09-10).
- **Cumulative posture impact:** same-class violations (a window set without reading the
  ledger; a window shortened below the live horizon; a provenance record pruned ahead of its
  artifact) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in
  30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key;
  named deviation recorded per `trust-posture.md` Rule 8, since a too-short window is
  correctable up to the moment the pruner runs.
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-retention-window]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer compares the configured
  window against the deploy ledger's oldest rollbackable release. Phase 2 (deferred) — a
  detector comparing the parsed `retain-days` field in the publish config against the ledger's
  oldest-rollbackable timestamp, both structured values read from files rather than from any
  session's prose; fixtures land WITH that detector at
  `.claude/audit-fixtures/artifact-retention-window/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** the numbered clause and the MUST NOT bullet; every `violations.jsonl`
  row names the configured window, the live horizon and the gap between them.
- **Origin:** See § Origin.

## Origin

2026-09-03 — a rollback to a release eleven days outside the retention window found the tag,
the changelog and the provenance record intact, and no artifact to deploy.
