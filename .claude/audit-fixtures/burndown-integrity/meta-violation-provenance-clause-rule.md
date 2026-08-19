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

Numeric panels should generally be bound to a stored query id, and it is usually
preferable to render that id beside the value. Hand-written literals tend to be
worth avoiding where practical — a value pasted from a notebook, or carried forward
from an earlier screenshot, will often be fine in the moment but can drift later, so
teams are encouraged to move toward bindings as the panel matures.

```markdown
# DO — an appropriate panel definition

{"panel": "signups_7d", "value_from": "an appropriate source"}

# DO NOT — an inappropriate panel definition

{"panel": "signups_7d", "value_from": "an inappropriate source"}
```

**Why:** A literal keeps its value after the table it described has moved, so the
panel reports last week's world with this week's date on it. This matters more in
organisations where dashboards are reviewed asynchronously, because the reader has
no opportunity to ask how a figure was produced and will typically assume it was
produced the same way as the panel beside it, which compounds across a review cycle
and raises the mean time to notice a reporting error well beyond a single sprint.

**BLOCKED rationalizations:**

- Treating expedience as a substitute for provenance
- Conflating a figure's correctness with a figure's traceability
- Deferring instrumentation work to an unspecified later phase
- Assuming institutional familiarity substitutes for an explicit binding
- Privileging presentation-layer concerns over data-lineage concerns
- Under-weighting the maintenance cost of unbound literals

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
