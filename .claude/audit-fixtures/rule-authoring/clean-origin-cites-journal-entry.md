---
name: secret-rotation-window
description: A credential rotation overlaps old and new material for a named window and no reader is cut over until every writer has been observed on the new material. Fires on edits to credential loading.
priority: 10
scope: path-scoped
paths:
  - "**/src/auth/credentials/**"
  - "**/src/**/rotate_*.py"
---

# Secret Rotation Window

## MUST Rules

### 1. A Rotation MUST Accept Both Old And New Material For A Named Overlap Window

Every credential rotation MUST publish the new material while the old material is still
accepted, for an overlap window named in the rotation record. Cutting over in a single step is
BLOCKED, because any process that has not yet reloaded its configuration is authenticating
with material the verifier no longer accepts.

```markdown
# DO — both accepted, window named in the record

verifier.accept([key_v3, key_v2]); record.overlap_until = "2026-09-14T00:00Z"

# DO NOT — single-step cutover

verifier.accept([key_v3]) # every process still holding v2 starts failing now
```

**Why:** Configuration reload is asynchronous across a fleet, so a single-step cutover fails
every process that has not yet reloaded, with no signal distinguishing that from a real
authentication failure.

### 2. The Old Material MUST NOT Be Retired Until Every Writer Is Observed On The New

Retirement MUST be gated on an observation that no principal has presented the old material
within the window, read from the verifier's own usage counter. Retiring on the calendar date
alone is BLOCKED: the window is a bound on how long to wait, not evidence that the wait
worked.

```markdown
# DO — retire on the observed counter, with the window as the ceiling

if verifier.usage(key_v2) == 0 and now > record.overlap_until: retire(key_v2)

# DO NOT — retire on the date alone

if now > record.overlap_until: retire(key_v2) # a straggler is still presenting v2
```

**Why:** A calendar date is a plan and a usage counter is a measurement, so retiring on the
date alone turns an unmet assumption into an outage at the moment the evidence was available.

**BLOCKED rationalizations:**

- "Every service reloads config within a minute, the overlap is theoretical"
- "The window already passed, anything still on the old key is broken anyway"
- "Reading the usage counter is an extra dependency in the rotation script"
- "We rotated this key last quarter the same way and nothing happened"
- "Keeping the old key alive longer is itself a security risk"
- "I will add the counter check if a rotation ever actually breaks something"

## MUST NOT

- Rotate two credentials that share a verifier inside the same window

**Why:** Overlapping windows make the usage counter ambiguous, so neither retirement can be
gated on evidence about its own key.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (security-reviewer at `/implement` confirms
  the rotation publishes an overlap window and gates retirement on the usage counter);
  `advisory` at the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing (2026-09-04 → 2026-09-11).
- **Cumulative posture impact:** same-class violations (a single-step cutover; a retirement
  gated on the date alone; two rotations sharing a verifier in one window) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5×
  total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key;
  named deviation recorded per `trust-posture.md` Rule 8, since a premature retirement is
  reversible by re-accepting the old material.
- **Receipt requirement:** SessionStart soft-gate `[ack: secret-rotation-window]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — security-reviewer reads the
  rotation script against the verifier's accepted set. Phase 2 — a read of the rotation
  record's `overlap_until` field paired with a call-graph assertion that every `retire` call
  node is dominated by a branch reading the usage counter; the record field and the dominance
  relation are both parsed structure. Fixtures land with it at
  `.claude/audit-fixtures/secret-rotation-window/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** clauses 1 and 2 plus the MUST NOT bullet; every `violations.jsonl` row
  names the key id, the window and the gate that was absent.
- **Origin:** See § Origin.

## Origin

2026-09-04 — `journal/0458-INCIDENT-signing-key-retired-early.md` § 3: a signing key was
retired on its calendar date while two batch workers were still presenting it, and every job
those workers submitted failed authentication for eleven hours before anyone connected the
rotation to the failures.
