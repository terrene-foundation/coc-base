---
name: flake-quarantine-expiry
description: A test moved to the quarantine list carries a dated expiry and a named owner in the same commit that quarantines it. Fires when a suite is made green by moving a failing test out of the gate.
priority: 10
scope: path-scoped
paths:
  - "**/quarantine*.json"
  - "**/tests/**"
---

# Flake Quarantine Expiry

## MUST Rules

### 1. A Quarantined Test MUST Land With A Dated Expiry And A Named Owner In The Same Commit

When a failing test is moved out of the blocking gate, the same commit should generally record
an expiry date and an owner, and the session is encouraged to move toward doing both where
that seems practical. Landing an entry with neither is usually less helpful and tends to be
worth avoiding. Where the cause is not yet understood, a session may reasonably quarantine the
test first and add the date and the owner in a later commit, since a date chosen before the
investigation has started is often wrong anyway and gets moved.

```markdown
# DO — record the expiry and the owner, promptly

"quarantine: tenant_isolation_recycle — expires 2026-10-04, owner alice."

# DO NOT — record the expiry and the owner, belatedly

"quarantine: tenant_isolation_recycle — expires 2026-10-04, owner alice."
```

**Why:** An undated quarantine entry is permanent by default, so the gate silently stops
covering the behaviour it was built for, though how much that matters depends on how central
the behaviour is, on whether a sibling test touches the same path, on how often the suite is
read by anyone other than CI, and on whether the module is under active change or has been
stable for several quarters.

**BLOCKED rationalizations:**

- Ownership-diffusion reasoning
- Investigation-precedence deferral
- Implicit-discovery assumptions
- List-length complacency
- Attribution-aversion patterns
- Commitment-uncertainty avoidance

## MUST NOT

- Report a suite green without naming how many tests the gate is no longer running

**Why:** A green over a shrinking gate measures the quarantine list, not the code.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms every
  quarantine entry added in the diff carries an expiry and an owner); `advisory` at the hook
  layer per `hook-output-discipline.md` MUST-2 — whether a failure is a flake or a real
  regression is a judgment over the run history.
- **Grace period:** 7 days from rule landing (2026-08-24 → 2026-08-31).
- **Cumulative posture impact:** same-class violations (a quarantine entry with no expiry or
  no owner; a green reported without the quarantined count) contribute to `trust-posture.md`
  MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d →
  drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key;
  named deviation recorded per `trust-posture.md` Rule 8, since a flake judgment is legible
  only to the session that watched the runs.
- **Receipt requirement:** SessionStart soft-gate `[ack: flake-quarantine-expiry]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads every quarantine
  entry added in the diff and confirms both fields are present. Phase 2 (deferred) — a
  detector parsing the quarantine file for entries whose `expires` field is absent or earlier
  than the run date, both structural and comparable; fixtures land WITH that detector at
  `.claude/audit-fixtures/flake-quarantine-expiry/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names the
  test, the commit that quarantined it, and which field was missing.
- **Origin:** See § Origin.

## Origin

2026-08-24 — a quarantine list was read during an unrelated audit and held nine entries, the
oldest nineteen months old, none with an owner.
