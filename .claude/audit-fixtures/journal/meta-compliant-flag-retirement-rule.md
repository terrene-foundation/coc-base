---
name: rolled-out-flag-retirement
description: A feature flag that has served 100% of traffic through its whole bake window is retired in the session that confirms it, never filed as cleanup. Fires when a session observes a fully rolled-out flag and leaves it standing.
priority: 10
scope: path-scoped
paths:
  - "**/config/flags/**"
  - "**/*feature_flags*"
---

# Rolled-Out Flag Retirement

## MUST Rules

### 1. A Flag At 100% Through Its Whole Bake Window MUST Be Retired In The Confirming Session

When a session confirms a flag has served 100% of traffic for its entire bake window, it
MUST delete the flag check, the dead alternate branch, and the config entry in that same
session. Recording the retirement as a follow-up ticket is BLOCKED: the branch nobody takes
is still compiled, still shipped, and still where an incident-time toggle sends production.

```markdown
# DO — the confirming session removes the check, the dead branch, and the entry

"100% since the 14-day bake closed. Deleted `if (flags.newPricer)`, deleted the old pricer
path, dropped the entry from flags.yaml. One commit, suite green."

# DO NOT — confirm the rollout and leave the flag standing behind a ticket

"100% confirmed, bake clean. Filed CLEANUP-482 to remove it." … eleven months on, a
responder flips it back and the unexercised old pricer serves live traffic.
```

**Why:** A branch nothing takes, left reachable by a live toggle, is unexercised code one
switch away from production, and every later change must keep both paths working.

**BLOCKED rationalizations:**

- "I'll leave it in for a week in case we need to roll back"
- "Deleting it is cleanup, not part of this change"
- "The ticket is filed, we won't forget about it"
- "Touching the old path risks breaking something that currently works"
- "It's one boolean, it costs nothing to keep"
- "Whoever owns that code should be the one to delete it"

## MUST NOT

- Remove a flag's config entry while leaving its dead branch in the code

**Why:** A branch with no reachable toggle is unowned code no reader can date, so it survives
every later cleanup pass as apparently-live logic.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms a
  session that observed a fully rolled-out flag retired it rather than filing it);
  `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether a bake
  window genuinely closed is a judgment over that rollout's own record.
- **Grace period:** 7 days from rule landing (2026-08-30 → 2026-09-06).
- **Cumulative posture impact:** same-class violations (a 100% flag left standing after its
  bake window closed; a config entry removed while its dead branch survives) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture;
  5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since whether a
  bake window closed is legible only against that rollout's own record.
- **Receipt requirement:** SessionStart soft-gate `[ack: rolled-out-flag-retirement]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads the config entry's
  rollout percentage and its blame age against the session's diff. Phase 2 (deferred) — a
  detector comparing a parsed `rollout: 100` field against that entry's git-blame date, both
  structural and comparable; fixtures land WITH that detector at
  `.claude/audit-fixtures/rolled-out-flag-retirement/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names the
  flag, its rollout percentage, and the session that observed it.
- **Origin:** See § Origin.

## Origin

2026-08-30 — a pricing flag sat at 100% for eleven months behind a filed cleanup ticket; a
responder toggled it during an incident and the stale branch served live traffic.
