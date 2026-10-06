---
priority: 10
scope: path-scoped
paths:
  - "**/04-validate/**"
---

# Attack-Surface Coverage — proving a review closed its own questions

## MUST Rules

### 1. The Surface Is DERIVED From The Artefact, Never Enumerated

A review MUST derive its attack surface from the structure of the artefact under review. A
hand-listed roster of agents or perspectives MUST NOT be used as the surface.

```markdown
# DO — derive, then report every cell's disposition
"7 roles × 6 phases = 42 cells. 37 attacked, 3 n/a (reason given), 2 OPEN."

# DO NOT — enumerate a roster and call it coverage
"Deployed 8 agents. All report no remaining gaps."
```

**BLOCKED rationalizations:** "the roster covers everything in practice" · "adding an axis is
scope creep" · "the agents would have found it" · "a derivation is academic".

**Why:** A roster converges when its members run out of findings, which is a fact about the
roster. A derivation converges when every cell is discharged, which is a fact about the artefact.

### 2. Convergence Requires Closed Coverage, Not Falling Yield

A review MUST NOT declare convergence on a falling finding-count alone. Coverage MUST be closed
and no new cell added in the last two rounds.

```markdown
# DO — "Not converged: yield is 1, but 2 cells unattacked. Coverage governs."

# DO NOT — "Two clean rounds. Converged."
```

**BLOCKED rationalizations:** "two clean rounds is the criterion" · "the count is the signal" ·
"an open cell is theoretical" · "we can close it next round".

**Why:** A falling count under an expanding question set is the old questions being exhausted
while new ones still produce. Yield alone cannot distinguish the two.

## MUST NOT

- Report convergence without publishing the coverage table.

**Why:** An unpublished table cannot be checked, so the claim is unfalsifiable from the reader's
side.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review; `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2 (derived-vs-enumerated is judgment-bearing).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger (1× = drop 1 posture).
- **Receipt requirement:** SessionStart soft-gate `[ack: attack-surface-coverage]`.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/redteam` + cc-architect at `/codify` read every convergence claim against its published coverage table, confirming each cell carries a disposition and a warrant and that no cell was closed by its own row. Scanner: none (semantic). Fixtures: `.claude/audit-fixtures/adversarial-coverage/`. Probes: `.claude/test-harness/probes/adversarial-coverage.probes.json`.
- **Violation scope:** MUST-1 (enumerated roster) + MUST-2 (yield-only convergence).
- **Origin:** See § Origin.

## Origin

2026-08-22 — authored after a seventeen-round review converged five times and was five times
wrong, each time having run out of answers to one question rather than out of questions.
