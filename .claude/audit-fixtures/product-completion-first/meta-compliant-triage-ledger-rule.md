---
name: incident-followup-triage
description: A post-incident follow-up MUST be classified by whether it prevents recurrence before it is scheduled. Fires when a session schedules follow-ups by the incident's own severity instead of by what each item prevents.
priority: 10
scope: path-scoped
paths:
  - "**/incidents/**"
  - "**/postmortems/**"
  - ".claude/incident/**"
---

# Incident Follow-Up Triage

## MUST Rules

### 1. A Follow-Up MUST Be Scheduled By What It Prevents, Never By The Incident's Severity

Every follow-up MUST be labelled PREVENTS-RECURRENCE or DOES-NOT before it is given a
lane. The incident's severity ranks the write-up and MUST NOT decide which follow-ups
land now. Scheduling a follow-up because the incident was a Sev-1, or shelving one
because the incident was a Sev-3, is BLOCKED.

```markdown
# DO — the label decides the lane, the severity decides the write-up's prominence

Sev-3 incident, follow-up "add the missing idempotency key": PREVENTS-RECURRENCE → now.

# DO NOT — the incident's rank decides the follow-up's lane

"Only a Sev-3, so all four follow-ups go to the backlog." (one of them prevents it)
```

**Why:** Severity records how loud one occurrence was, and a quiet incident can have the
same root cause as a loud one. Scheduling on it ships the recurrence that the follow-up
existed to stop.

**BLOCKED rationalizations:**

- "It was only a Sev-3, the follow-ups can wait"
- "It was a Sev-1, so everything on the list is urgent"
- "We'll pick these up if it happens again"
- "The on-call runbook already covers it in practice"
- "Nobody has hit this twice, so it's theoretical"
- "The follow-up is bigger than the incident was"

## MUST NOT

- Close an incident whose PREVENTS-RECURRENCE follow-ups are still open

**Why:** A closed incident leaves the review cadence, so its open follow-ups stop being
read as incident work and become ordinary backlog.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms every
  follow-up carries a prevention label assigned before its lane); `advisory` at the hook
  layer per `hook-output-discipline.md` MUST-2 — whether an item prevents recurrence is
  judgment-bearing over the incident's causal chain.
- **Grace period:** 7 days from rule landing (2026-08-25 → 2026-09-01).
- **Cumulative posture impact:** same-class violations (a follow-up laned by incident
  severity; an incident closed over open prevention items) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture;
  5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since prevention
  is a review-layer causal judgment.
- **Receipt requirement:** SessionStart soft-gate `[ack: incident-followup-triage]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads each incident's
  follow-up set for a prevention label predating its lane. Phase 2 (deferred) — a check
  over the incident form's structured fields; audit fixtures land WITH that check at
  `.claude/audit-fixtures/incident-followup-triage/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names
  the incident id and the follow-up that was mis-laned.
- **Origin:** See § Origin.

## Origin

2026-08-25 — a Sev-3 duplicate-charge incident shelved its whole follow-up list on rank;
the same root cause produced a Sev-1 eleven days later with the fix still in the backlog.
