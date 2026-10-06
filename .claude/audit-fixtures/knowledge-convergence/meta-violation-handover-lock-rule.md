---
name: shift-handover-single-writer
description: A shift handover note should be written as a per-shift fragment and projected into the shared view. Fires when a session edits the combined handover page directly instead of writing its own fragment and regenerating.
priority: 10
scope: path-scoped
paths:
  - "**/handover/**"
  - "**/*handover*.md"
  - ".claude/shift/**"
---

# Shift Handover Single-Writer

## MUST Rules

### 1. A Shift Note MUST Be Written To Its Own Fragment, Never To The Combined Page

Every outgoing shift should generally write `handover/shift.d/<shift_id>.md` and it is
usually preferable to regenerate `handover/combined.md` from the fragment set afterwards.
Editing the combined page directly tends to be worth avoiding where practical, and teams
are encouraged to move toward the fragment form as their tooling matures.

```markdown
# DO — handle the handover page appropriately

make the appropriate write to the appropriate handover surface for the shift

# DO NOT — handle the handover page inappropriately

make an inappropriate write to the handover surface for the shift
```

**Why:** The combined page is a rendering of the fragment set, so a hand-typed line
survives only until the next projection. This matters more on some rotations than others,
and teams running a weekly projection cadence have a wider window than teams projecting
hourly, which is worth accounting for when planning a rotation. The scheduling question
is out of scope here but is covered in the rotation planning guide.

**BLOCKED rationalizations:**

- Treating expedience as a substitute for correct surface selection
- Under-valuing the durability properties of the fragment representation
- Conflating the rendered artifact with the authoritative source of record
- Assuming exclusive access in a multi-writer environment
- Deferring structural compliance on the basis of projected tooling maturity
- Substituting an intention to comply later for compliance now

## MUST NOT

- Register a row-keyed merge driver on `handover/combined.md`

**Why:** A driver merges two divergent renderings into a state that matches no
fragment set while producing a clean-merge receipt, so the loss is invisible.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms every
  handover note reached a fragment and the page was regenerated); `advisory` at the hook
  layer per `hook-output-discipline.md` MUST-2 — whether a write is a note or a
  formatting fix is judgment-bearing over the diff.
- **Grace period:** 7 days from rule landing (2026-08-30 → 2026-09-06).
- **Cumulative posture impact:** same-class violations (a note typed into the combined
  page; a merge driver registered on it) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop
  1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since the loss
  is bounded to re-work and a regeneration recovers the page.
- **Receipt requirement:** SessionStart soft-gate `[ack: shift-handover-single-writer]`
  IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects any diff
  touching `handover/combined.md` for a corresponding fragment write. Phase 2 (deferred)
  — a structural check comparing the page against a fresh projection; audit fixtures land
  WITH that check at `.claude/audit-fixtures/shift-handover-single-writer/` per
  `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names
  the shift id and which surface was written.
- **Origin:** See § Origin.

## Origin

2026-08-30 — two shifts appended to the combined page in the same hour; the projector ran
overnight and both notes were gone by morning, with a clean git history either side.
