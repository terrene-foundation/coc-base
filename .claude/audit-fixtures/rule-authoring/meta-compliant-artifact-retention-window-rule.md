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

The retention window for a published artifact MUST be at least as long as the oldest release
any environment can still roll back to, computed from the deploy ledger rather than chosen as
a round number. A window picked without reading the ledger is BLOCKED, and a window shortened
without re-reading it is BLOCKED for the same reason.

```markdown
# DO — the window is derived, and the derivation is recorded

horizon=$(deploy-ledger oldest-rollbackable --env prod)   # 47 days
publish --retain-days "$((horizon + 7))" --retain-reason "prod horizon 47d + 7d margin"

# DO NOT — a round number, with the ledger unread

publish --retain-days 30   # prod can still roll back 47 days; 17 of them have no artifact
```

**Why:** A window shorter than the live rollback horizon deletes the only artifact a rollback
could use, so the rollback path is gone before anyone discovers it is needed.

**BLOCKED rationalizations:**

- "Thirty days is what we have always used and nothing has broken"
- "Nobody rolls back further than a couple of releases"
- "Storage cost is real and the old artifacts are almost certainly dead weight"
- "If we ever need an old build we can rebuild it from the tag"
- "The ledger query is slow, I will hardcode the number for now"
- "I will widen the window the first time a rollback actually fails"

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
