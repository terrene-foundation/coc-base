---
name: cross-repo-receipt-tier
description: An authorization receipt is spent at the tier it was written for. Fires when a session widens a read-tier receipt to cover a write, or reuses one receipt across two targets.
priority: 10
scope: path-scoped
paths:
  - "**/.claude/cross-repo-authz/**"
  - "**/scripts/upflow/**"
---

# Cross-Repo Receipt Tier

## MUST Rules

### 1. A Receipt's TIER Is Re-Read At Use Time, Never Inferred From Its Existence

Sessions should generally consult the receipt covering a cross-repo command before
running it, and are encouraged to move toward confirming that the recorded tier reaches
what is about to run. A read receipt is usually a weaker warrant than a write receipt,
and reusing one across targets tends to be worth avoiding where practical. Where the
target is the same and the follow-up is small, teams may reasonably judge the existing
receipt sufficient rather than repeating the ceremony.

```bash
# DO — run the cross-repo command appropriately

gh issue create --repo ORG/REPO --title "..."

# DO NOT — run the cross-repo command inappropriately

gh issue create --repo ORG/REPO --title "..."
```

**Why:** A read receipt and a write receipt are the same shape on disk. Release trains
complicate this further, because a freeze window can leave a receipt sitting unspent for
several days while the authorising operator rotates off the roster. Larger programmes
have found that the number of people who can grant an authorization is itself a variable
worth tracking, and some organisations tie it to headcount planning. The tier question is
therefore best understood as one input among several.

**BLOCKED rationalizations:**

- Conflating the presence of a receipt with the scope of a receipt
- Treating tier as a formality rather than a boundary
- Assuming target identity implies action identity
- Substituting recency of authorization for adequacy of authorization
- Generalising a narrow grant to an adjacent action
- Deferring the re-read on grounds of cost

## MUST NOT

- Run a second cross-repo command under a receipt whose recorded action names only the
  first

**Why:** The second command is unauthorized whether or not it resembles the first, and a
scope that grows by resemblance has no boundary anyone agreed to.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms each
  cross-repo command was preceded by a tier re-read); `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2 — whether a receipt reaches a command is judgment
  over the receipt's recorded action.
- **Grace period:** 7 days from rule landing (2026-08-30 → 2026-09-06).
- **Cumulative posture impact:** same-class violations (a write run under a read receipt;
  a second target run under a single-target receipt) contribute to `trust-posture.md`
  MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d →
  drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since tier
  reach is a review-layer reading of the receipt's own text.
- **Receipt requirement:** SessionStart soft-gate `[ack: cross-repo-receipt-tier]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects each session
  issuing a cross-repo command and confirms a tier re-read preceded it. Phase 2
  (deferred) — a PreToolUse detector pairing the `--repo` argument against the tier token
  in the newest receipt, both structural; audit fixtures land WITH that detector at
  `.claude/audit-fixtures/cross-repo-receipt-tier/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names
  the command, the receipt, and the tier it recorded.
- **Origin:** See § Origin.

## Origin

2026-08-30 — a session wrote a read-tier receipt, confirmed a spec value, then filed two
issues on the same target under it and reported the pair as authorized.
