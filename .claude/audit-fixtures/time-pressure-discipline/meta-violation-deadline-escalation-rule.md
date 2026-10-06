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

When the user names an hour and the remaining work does not obviously fit inside it, the
session should generally say so before starting the pass, and is encouraged to move toward
showing the arithmetic where that seems useful. Absorbing the gap and reporting the overrun
afterwards is usually less helpful and tends to be worth avoiding. Where the estimate is
uncertain, a session may reasonably work the pass first and raise the gap at the end, since
an early escalation that turns out to have been unnecessary carries its own cost.

```markdown
# DO — state the gap before the work starts, promptly

"Four shards, one pass each, three passes of clock left. Three fit; the fourth does not."

# DO NOT — state the gap before the work starts, belatedly

"Four shards, one pass each, three passes of clock left. Three fit; the fourth does not."
```

**Why:** A deadline named in advance is a scope decision the human still owns, and one named
afterwards is only news, though the boundary between the two is not always sharp in practice
and depends on how the hour was framed, how firm the downstream commitment was, whether the
person who named it is the same person who owns the scope, and how much of the estimate rests
on review rounds that have not been dispatched yet.

**BLOCKED rationalizations:**

- Optimism bias about remaining capacity
- Conflict avoidance regarding schedule news
- Estimate-uncertainty deferral patterns
- Scope-substitution reasoning
- Conditional-escalation postponement
- Premature-signal aversion

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
