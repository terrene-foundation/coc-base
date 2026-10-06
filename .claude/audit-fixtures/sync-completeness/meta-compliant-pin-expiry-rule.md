---
name: dependency-pin-expiry
description: A pinned third-party dependency carries an expiry date, and a pin found past it is renewed or escalated in the session that reads it, never carried forward untouched. Fires when a session opens a lockfile whose pin annotation has lapsed.
priority: 10
scope: path-scoped
paths:
  - "**/requirements*.txt"
  - "**/Cargo.lock"
---

# Dependency Pin Expiry

## MUST Rules

### 1. A Lapsed Pin MUST Be Renewed Or Escalated In The Session That Reads It

Every pin carries an `expires:` date beside it. A session that reads a pin whose date has
passed MUST either renew the pin against the current upstream release or escalate the lapse
to the human with the version gap named, before that session closes. Carrying the lapsed pin
forward untouched is BLOCKED: a freeze nobody revisits is indistinguishable from a freeze
nobody chose, and the expiry date exists to make exactly that difference visible.

```markdown
# DO — the lapse is acted on in the session that read it

"cryptography held at 42.0.4, expires 2026-08-01, today is 2026-09-13. Upstream is 44.0.1.
Renewing to 44.0.1, or hold at 42 and re-date the freeze?"

# DO NOT — read the lapsed date and leave the pin standing

"Pin is past its date but the build is green; leaving it. The bump belongs in an upgrade
pass, not in this one."
```

**Why:** An expiry date the reading session declines to act on converts a deliberate freeze
into an accidental one, and the build stays green the whole way down.

**BLOCKED rationalizations:**

- "The build is green, so the pin is still fine"
- "Bumping it is outside what I was asked to do here"
- "Someone set that date months ago, it was probably arbitrary"
- "I will put it in the handover and the next session can pick it up"
- "Renewing this pulls in a major, and that is a separate decision"
- "The expiry is a reminder, not a gate"

### 2. A Renewed Pin MUST Carry The Upstream Release It Was Measured Against

A renewal MUST write the new `expires:` date together with the upstream version the check
ran against and the date it ran. A refreshed date with no measured version behind it is
BLOCKED.

```markdown
# DO — the renewed date carries the measurement that justifies it

pandas==2.2.3 # expires: 2027-03-01 — checked 2026-09-13, upstream latest 2.2.3

# DO NOT — refresh the date and leave the measurement out

pandas==2.2.3 # expires: 2027-03-01
```

**Why:** A date with no measurement behind it records only that someone typed a date, so the
next reader cannot tell a checked freeze from a postponed one.

## MUST NOT

- Renew a pin past a major boundary without naming the breaking changes it crosses

**Why:** A major bump renewed as routine hygiene lands API breakage under a commit message
that promises none, so the failure surfaces far from the change that caused it.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms a session
  that read a lapsed pin either renewed it or escalated it); `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2 — whether a pin was READ is a judgment over the
  session's own reasoning, not a tool-call fact.
- **Grace period:** 7 days from rule landing (2026-08-24 → 2026-08-31).
- **Cumulative posture impact:** same-class violations (a lapsed pin carried forward with no
  renewal and no escalation; a renewed date shipped with no measured upstream version)
  contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop
  1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key;
  named deviation recorded per `trust-posture.md` Rule 8, since whether a pin was read at all
  is legible only in the session that opened the file.
- **Receipt requirement:** SessionStart soft-gate `[ack: dependency-pin-expiry]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer compares each `expires:`
  annotation in the touched lockfile against the commit date and confirms a renewal or an
  escalation turn exists for every lapsed one. Phase 2 (deferred) — a detector parsing the
  `expires:` field out of the lockfile annotation and comparing it against the commit
  timestamp, both parsed structural values; fixtures land WITH that detector at
  `.claude/audit-fixtures/dependency-pin-expiry/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + MUST-2 + the MUST NOT clause; every `violations.jsonl` row
  names the package, its expiry date, and the session that read it.
- **Origin:** See § Origin.

## Origin

2026-08-24 — a lockfile pin marked `expires: 2026-02-01` was read in four separate sessions
and renewed in none of them, and the freeze was eighteen months old before anyone noticed.
