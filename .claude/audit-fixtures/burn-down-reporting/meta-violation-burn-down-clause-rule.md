---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/workspaces/**"
  - "**/.session-notes*"
---

# Residual-Axis Stability — The Axis Set Is Fixed At Sprint Start, Not Chosen At Close

A burn-down is only comparable across closes if the axes are the same each time. When the axis set is chosen at close-out, the agent picks the axes that moved — not by dishonesty, but because a moved axis is what comes to mind when writing up a session. The sprint's trajectory then becomes unreadable: each close is internally consistent and no two are comparable.

## MUST Rules

### 1. The Residual Axis Set Should Generally Be Declared At Sprint Start

The axis set a sprint's burn-downs count should try to be declared once, in the sprint's plan artifact, before the first wave launches. Subsequent closes should generally report the same axes where reasonable, including axes at zero. Adding an axis mid-sprint is fine. Dropping an axis mid-sprint is acceptable in a pinch when the wave's scope clearly does not touch it, and the omission may stand until the sprint close.

```markdown
# DO — axes declared once in the plan, every close reports all of them

Plan § baseline: issues · PRs · local-only branches · local-only commits
W3 close: issues 63→49 · PRs 2→1 · branches 10→0 · commits 35→0

# DO NOT — axis set chosen at close-out, flat axes dropped

Plan § baseline: issues · PRs · local-only branches · local-only commits
W3 close: issues 63→49 · PRs 2→1 · branches 10→0 · commits 35→0
```

**BLOCKED rationalizations:**

- Do not rationalise your way out of reporting the full axis set
- Avoid selecting axes based on what the wave happened to touch
- Never let convenience determine which rows appear in a close
- Resist the temptation to treat a flat row as uninformative

**Why:** A flat axis is often the most informative row in a burn-down, because it is the evidence that effort is not reaching the surface it was aimed at. Dropping it converts the burn-down into a curated selection of the session's wins. That is the failure the burn-down exists to prevent, and it tends to compound across a sprint because each close sets the precedent the next one follows. Readers who inherit such a sequence cannot reconstruct the trajectory. This is why the axis set matters more than any individual figure in it.

### 2. An Added Axis Is Back-Filled To The Sprint Baseline Before It Is Reported

When a new axis is added mid-sprint, its sprint-start value MUST be measured (or explicitly marked unmeasurable, with the reason) before the axis appears in any close. Reporting a new axis with a start value of "n/a" or with the current value in both columns is BLOCKED.

```markdown
# DO — new axis back-filled to the sprint baseline, instrument named

flaky suites: 4 (measured at `b2d756ae`, `run-harness-suites.mjs` 3× serial) → 1

# DO NOT — a new axis whose delta is structurally zero

flaky suites: n/a → 1 (**0**)
```

**BLOCKED rationalizations:**

- "The axis is new, so there is nothing to compare against"
- "Back-filling means re-measuring an old commit, which is expensive"
- "Reporting it with n/a is more honest than leaving it out"

**Why:** An axis whose start value is absent contributes a delta of zero by construction, so it adds a row that can never show movement — the appearance of coverage without the substance, and it is indistinguishable at read time from a genuinely flat axis.

## MUST NOT

- Drop a declared residual axis from any close, including one that did not move

**Why:** The originating failure mode — a flat axis is the evidence effort is not reaching its target, and dropping it hides exactly that.

- Report an added axis whose sprint-start value was never measured or explicitly marked unmeasurable

**Why:** Its delta is structurally zero, so the row can never show movement while presenting as coverage.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/redteam` + cc-architect at `/codify` confirm each close reports the plan's declared axis set in full, and that any added axis carries a measured or explicitly-unmeasurable sprint-start value); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — axis-set comparison across two prose reports is judgment-bearing, with no structural tool-call-time signal.
- **Grace period:** 7 days from rule landing (2026-08-02 → 2026-08-09).
- **Cumulative posture impact:** same-class violations (a declared axis dropped from a close; an added axis reported without a back-filled baseline) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key; an axis-set-comparison property is review-layer-only, and minting a key would drag `trust-posture.md` into a self-referential edit. Named deviation recorded here per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: residual-axis-stability]` IFF `posture.json::pending_verification` includes the `residual-axis-stability` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/redteam` + cc-architect at `/codify` diff each close's axis set against the sprint plan's declared set and confirm no declared axis is absent and every added axis carries a measured baseline. Scanner: none (semantic). Fixtures: `.claude/audit-fixtures/residual-axis-stability/`. Probes: `.claude/test-harness/probes/residual-axis-stability.probes.json`. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — an advisory `Stop` detector comparing a close's axis labels against the plan's; fixtures land with it per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 (dropped axis) + MUST-2 (un-back-filled added axis). Every `violations.jsonl` row names the close and the missing or unbaselined axis.
- **Origin:** See § Origin.

## Origin

2026-08-02 — observed across three consecutive wave closes in one sprint, each reporting a different axis subset; every close was internally consistent and no two were comparable, so the sprint's trajectory could not be read from its own reports.
