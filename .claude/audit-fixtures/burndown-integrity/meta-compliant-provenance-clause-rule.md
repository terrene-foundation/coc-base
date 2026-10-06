---
name: dashboard-figure-provenance
description: A figure shown on a status dashboard MUST carry the query that produced it. Fires when a session hand-writes a headline number into a dashboard panel instead of binding the panel to a stored query.
priority: 10
scope: path-scoped
paths:
  - "**/dashboards/**"
  - "**/*panel*.json"
  - "**/reporting/**"
---

# Dashboard Figure Provenance

## MUST Rules

### 1. A Dashboard Figure MUST Name The Stored Query That Produced It

Every numeric panel MUST bind to a stored query id and render that id beside the
value. A hand-written literal, a value pasted from a notebook, or a number carried
forward from last week's screenshot is BLOCKED — including when it is correct today,
because nothing re-derives it when the underlying table changes.

```markdown
# DO — the panel binds to a query id and shows it

{"panel": "signups_7d", "query_id": "q-4821", "value_from": "query"}

# DO NOT — a literal nobody can re-run

{"panel": "signups_7d", "value": 1840} # pasted from a notebook cell on Tuesday
```

**Why:** A literal keeps its value after the table it described has moved, so the
panel reports last week's world with this week's date on it.

**BLOCKED rationalizations:**

- "The number is right, I checked it against the table this morning"
- "The query is too slow to run on every panel refresh"
- "It's a headline figure, it barely changes"
- "I'll wire the query up in the follow-up ticket"
- "The dashboard is for the exec review, not for operators"
- "Everyone knows where that number comes from"

## MUST NOT

- Render a panel whose bound query has not been executed since the panel's own
  `as_of` timestamp

**Why:** A stale bound query is indistinguishable from a fresh one at the panel, so
the binding stops carrying the guarantee it was added for.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms
  every numeric panel carries a `query_id`); `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2 — whether a literal is a figure or a threshold
  is judgment-bearing over the panel's semantics.
- **Grace period:** 7 days from rule landing (2026-08-18 → 2026-08-25).
- **Cumulative posture impact:** same-class violations (a hand-written figure; a
  panel bound to a query never executed) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d →
  drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO
  dedicated per-clause key; named deviation recorded per `trust-posture.md` Rule 8,
  since figure-versus-threshold is a review-layer semantic judgment.
- **Receipt requirement:** SessionStart soft-gate `[ack: dashboard-figure-provenance]`
  IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects each
  added numeric panel for a `query_id` and confirms the bound query ran since the
  panel's `as_of`. Phase 2 (deferred) — a JSON-schema detector over panel
  definitions, a structural signal; audit fixtures land WITH that detector at
  `.claude/audit-fixtures/dashboard-figure-provenance/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row
  names the panel and the figure it rendered.
- **Origin:** See § Origin.

## Origin

2026-08-18 — a signups panel carried a literal pasted during an incident review and
kept reporting it for six weeks after the source table was repartitioned.
