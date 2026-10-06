---
name: deadline-escalation-notice
description: A named deadline the session cannot meet at full procedure is escalated to the human before the pass begins, never absorbed silently. Fires when a session works past a stated hour without saying it will be missed.
priority: 10
scope: path-scoped
paths:
  - "**/workspaces/**"
  - "**/.session-notes"
---

# Deadline Escalation Notice

## MUST Rules

### 1. A Deadline The Session Cannot Meet MUST Be Escalated Before The Pass, Not Reported After

When the user names an hour and the remaining work does not fit inside it at full
procedure, the session MUST say so BEFORE starting the pass, with the arithmetic that
shows the gap. Absorbing the gap silently and reporting the overrun afterwards is
BLOCKED: the human can re-scope a deadline they are told about in advance and can do
nothing at all with one they learn about once it has passed.

```markdown
# DO — the gap is stated before the work starts, with its arithmetic

"Four shards, one pass each, three passes of clock left. Three fit; the fourth does not.
Which three?"

# DO NOT — absorb the gap and report it once the hour is gone

"Started at 14:00 as asked." … 17:40: "Three of four landed; the fourth needs another pass."
```

**Why:** A deadline named in advance is a scope decision the human still owns, and the same
deadline named afterwards is only news.

**BLOCKED rationalizations:**

- "I might still make it if the reviews come back clean"
- "Telling them now just makes them anxious for three hours"
- "The estimate could be wrong in the good direction"
- "They said ship it, not ship three of four"
- "I will raise it if it actually slips"
- "Escalating before I have tried is premature"

## MUST NOT

- Report a missed hour without naming which item consumed the overrun

**Why:** An overrun with no attributed item cannot be re-scoped next time, so the same
deadline is missed the same way.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms a
  session that missed a named hour raised the arithmetic before the pass); `advisory` at
  the hook layer per `hook-output-discipline.md` MUST-2 — whether the remaining work fits
  the remaining clock is a judgment over the session's own estimate.
- **Grace period:** 7 days from rule landing (2026-08-30 → 2026-09-06).
- **Cumulative posture impact:** same-class violations (a named hour missed with no prior
  escalation; an overrun reported with no item attributed) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture;
  5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since whether a
  gap was foreseeable is legible only in the session that estimated it.
- **Receipt requirement:** SessionStart soft-gate `[ack: deadline-escalation-notice]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer compares the hour named
  in the user turn against the timestamp of the closing turn and confirms an escalation
  turn exists between them. Phase 2 (deferred) — a detector pairing a parsed hour in a user
  turn against the session's closing timestamp, both structural and comparable; fixtures
  land WITH that detector at `.claude/audit-fixtures/deadline-escalation-notice/` per
  `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names the
  hour, the gap, and the turn where it should have been raised.
- **Origin:** See § Origin.

## Origin

2026-08-30 — a session was given a 16:00 hour, finished at 19:20, and the first mention of
the gap was in the closing summary.
