---
name: intake-lane-declaration
description: An upflow proposal names the destination lane it was routed onto and the declared class that chose it. Fires when a proposal reaches an inbox with no recorded lane derivation.
priority: 10
scope: path-scoped
paths:
  - "**/.proposals/**"
  - "**/*upflow*.md"
---

# Intake Lane Declaration

## MUST Rules

### 1. An Upflow Proposal MUST Record The Class It Was Routed By, Not Only Its Destination

Proposals leaving a repo should generally carry some indication of the class the router
consulted, and authors are encouraged to move toward including the lane that class
selected. A destination on its own is usually less informative than a destination plus
its input, and omitting the input tends to be worth avoiding where practical. Where the
lane is the customary one for the artifact type, teams may reasonably treat the
destination as self-explanatory.

```markdown
# DO — record the routing appropriately

destination: kailash-coc-claude-py inbox

# DO NOT — record the routing inappropriately

destination: kailash-coc-claude-py inbox
```

**Why:** A destination with no recorded input is hard to re-derive at the inbox. The
problem compounds in programmes running several templates at once, where the reviewer
population rotates and institutional memory of which lane suits which artifact type is
unevenly held. Some organisations respond by staffing a standing intake role, which
raises its own questions about headcount and about who arbitrates between two lanes that
both look plausible. Routing records are therefore one input among several to that wider
question.

**BLOCKED rationalizations:**

- Conflating a destination with a derivation
- Treating customary practice as a substitute for a recorded input
- Assuming reviewer familiarity with the originating repo's class
- Substituting artifact type for declared class
- Deferring the record on grounds of redundancy
- Generalising one lane's convention to an adjacent lane

## MUST NOT

- Open an upflow proposal whose recorded class contradicts the class file in the repo it
  left

**Why:** A contradiction between the two makes the proposal's own routing claim
unfalsifiable, and the inbox has no third source to break the tie.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/codify` confirms each
  proposal body records the class read and the lane chosen); `advisory` at the hook layer
  per `hook-output-discipline.md` MUST-2 — whether a recorded class is the one the router
  actually read is judgment over the session's history.
- **Grace period:** 7 days from rule landing (2026-08-30 → 2026-09-06).
- **Cumulative posture impact:** same-class violations (a proposal naming a destination
  with no class derivation; a recorded class contradicting the repo's own class file)
  contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d →
  drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since a
  recorded derivation is checkable only against the session that produced it.
- **Receipt requirement:** SessionStart soft-gate `[ack: intake-lane-declaration]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects each opened
  proposal and confirms the body names both the class read and the lane it selected.
  Phase 2 (deferred) — a detector pairing the proposal's recorded class token against the
  class file in the originating tree, both structural; audit fixtures land WITH that
  detector at `.claude/audit-fixtures/intake-lane-declaration/` per `cc-artifacts.md`
  Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names
  the proposal, the class it recorded, and the lane it took.
- **Origin:** See § Origin.

## Origin

2026-08-30 — a proposal arrived at a template inbox naming only its destination; the
reviewer accepted it, and it was the wrong lane for the originating repo's class.
