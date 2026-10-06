---
name: audit-anchor-key-rotation
description: An audit-anchor signing key MUST be retired behind a verify-only window before its material is cleared. Fires when a rotation drops the outgoing key in the same step that installs the incoming one.
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

A rotation MUST install the incoming key, move the outgoing key to a verify-only state,
and clear its material ONLY after a re-anchor pass has covered every record the outgoing
key signed. Clearing in the same step that installs the replacement is BLOCKED: every
anchor still bearing the old key id becomes unverifiable at that instant, and the failure
is silent because signing continues to work on the new key.

```
# DO — install, demote to verify-only, re-anchor, then clear

install(k2); demote(k1, "verify-only"); reanchor_all(from=k1); clear_material(k1)

# DO NOT — install and clear together

install(k2); clear_material(k1)   # every k1-signed anchor is now unverifiable
```

**Why:** Signing keeps working on the incoming key, so nothing in the writing path
reports the loss, and the gap surfaces only when someone tries to verify an old record.

**BLOCKED rationalizations:**

- "The old anchors are historical, nobody verifies them"
- "The re-anchor pass can run next week, the keyring is small"
- "Keeping the material around is the bigger security risk"
- "We have a backup of the keyring, we can restore if anyone asks"
- "The new key covers everything from here, which is what matters"
- "The rotation runbook has always done it in one step"

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
