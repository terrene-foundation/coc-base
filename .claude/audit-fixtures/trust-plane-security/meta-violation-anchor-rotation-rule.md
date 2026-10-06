---
name: audit-anchor-key-rotation
description: An audit-anchor signing key should be retired behind a verify-only window before its material is cleared. Relevant when a rotation drops the outgoing key in the same step that installs the incoming one.
priority: 10
scope: path-scoped
paths:
  - "**/anchor/**"
  - "**/*keyring*.json"
  - "**/audit/**"
---

# Audit Anchor Key Rotation

## MUST Rules

### 1. An Outgoing Anchor Key MUST Stay VERIFY-ONLY Until Every Anchor It Signed Is Re-Anchored

A rotation should generally install the incoming key, move the outgoing key to a
verify-only state, and clear its material after a re-anchor pass has covered the records
the outgoing key signed. Clearing in the same step that installs the replacement tends to
be worth avoiding where practical, since anchors bearing the old key id become harder to
verify, and teams are encouraged to move toward a windowed rotation as their runbooks
allow.

```
# DO — perform the rotation in the appropriate order

sequence the rotation steps in the appropriate way for the keyring

# DO NOT — perform the rotation in an inappropriate order

sequence the rotation steps in an inappropriate way for the keyring
```

**Why:** Signing keeps working on the incoming key, so nothing in the writing path reports
the loss. This has consequences across the retention estate as a whole, and it interacts
with how a team plans its audit calendar, because a gap discovered near a reporting
boundary tends to consume the same review capacity the report itself needs. It is also
worth remembering that different anchor backends expose key ids differently, so the
observable is not uniform.

**BLOCKED rationalizations:**

- Treating historical records as lower-value than current ones
- Prioritising key hygiene over verifiability without stating the trade
- Deferring a re-anchor pass to a later iteration
- Assuming a restorable backup is equivalent to a live verify path
- Relying on a runbook's precedent in place of a stated invariant

## MUST NOT

- Report a rotation complete while any anchor still names a key id whose material was
  cleared

**Why:** A rotation reported complete stops anyone looking, and the unverifiable anchors
are then discovered by an auditor rather than by the team that made them.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (security-reviewer at `/implement`
  confirms the outgoing key sat verify-only and the re-anchor pass covered every record
  before the clear); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 —
  whether a re-anchor pass was complete is judgment over the pass's own output.
- **Grace period:** 7 days from rule landing (2026-08-20 → 2026-08-27).
- **Cumulative posture impact:** same-class violations (material cleared in the install
  step; a rotation reported complete with anchors still on the outgoing key id) contribute
  to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1
  posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since re-anchor
  completeness is a review-layer semantic judgment.
- **Receipt requirement:** SessionStart soft-gate `[ack: audit-anchor-key-rotation]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — security-reviewer inspects any
  rotation for a verify-only window and a re-anchor pass whose count equals the outgoing
  key's anchor count. Phase 2 (deferred) — a keyring check that no cleared key id is named
  by any live anchor, a structural signal; audit fixtures land WITH that check at
  `.claude/audit-fixtures/audit-anchor-key-rotation/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names
  the key id and the anchor count left behind.
- **Origin:** See § Origin.

## Origin

2026-08-20 — a scheduled rotation installed the incoming key and cleared the outgoing
material in one step, leaving eleven months of anchors unverifiable while signing stayed
green.
