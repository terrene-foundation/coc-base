---
priority: 10
scope: path-scoped
paths:
  - "**/tools/conformance/**"
  - "**/e2e/**"
  - "**/eval-harness/**"
  - "**/04-validate/**"
  - "**/*conformance*"
  - "**/suites/**"
---

# Conformance Walk — Freeze The Expectation, Judge The Live/Static State, Report Coverage Honestly

A breadth check, a type-check, and a merge gate all answer "does it compile / render / return 200 / not crash". None answers the question a testable surface actually poses: **does each actionable unit DO what it is FOR?** The Conformance Walk (CW) closes that gap on ANY surface — SDK symbols, FE routes, HTTP endpoints, CLI flags, MCP tools — with ONE surface-neutral discipline: enumerate every unit, attach a FROZEN expectation, judge live/static state against it with a DETERMINISTIC oracle, report coverage HONESTLY (separate from pass-rate), and RATCHET so a new unit without an expectation fails the gate.

The methodology, the normative adapter-registry interface, the 5-adapter table, the phase-action triggers, and the CW-vs-`/redteam` role split live in `.claude/skills/conformance-walk/SKILL.md`. This rule carries the four MUST clauses; each surface supplies its own adapter per the skill's per-consumer adapter obligation.

## MUST Rules

### 1. Every Actionable Unit Carries A Frozen Expectation Asserted Against Live/Static Observed State

Every actionable UNIT on a touched testable surface (a public symbol, a route + its interactive elements, an endpoint, a CLI subcommand/flag, an MCP tool) MUST carry a FROZEN expectation — the observable contract or transition it should hold — asserted against the LIVE or STATIC observed state. The expectation MUST be frozen BEFORE the observation (freeze-then-judge). "Compiled / rendered / 200 / didn't crash" is the FLOOR, never the expectation; a different-than-expected effect is NOT a pass.

```text
# DO — freeze the contract, then judge the observed effect against it
Unit: POST /api/orders endpoint. Frozen expectation: 201 + Order schema + the row
persists (read-back GET returns it). Observed: 201 but read-back is empty → FAIL
(the floor "200" passed; the expectation "the order persists" did not).

# DO NOT — assert the floor and call it a pass
Unit: POST /api/orders. Assertion: "status < 500". Observed: 201 → PASS.
(the endpoint could silently drop every order and this still reads green)
```

**Why:** The floor ("it didn't crash") is satisfied by a surface that does the WRONG thing; only a frozen expectation asserted against the observed effect distinguishes "works" from "runs". Freezing BEFORE observing is what stops the expectation from being back-fitted to whatever the code happened to do.

### 2. The Deterministic Oracle Is Load-Bearing; Any LLM/Agent Semantic Judgment Is Advisory-Only

The DETERMINISTIC oracle — the one that yields the same verdict on every run with no model in the loop — is the load-bearing CI verdict and MAY hard-fail the gate. Any LLM / agent / semantic judgment MUST be ADVISORY-only: it produces a pre-computed worklist or a capture-then-human-freeze slot, and it MUST NOT hard-fail the gate. Wiring a non-reproducible semantic verdict as a blocking CI gate is BLOCKED.

```text
# DO — deterministic verdict blocks; semantic judgment is an advisory worklist item
Deterministic: "endpoint fired + schema matched + read-back present" → hard PASS/FAIL (CI).
Semantic: "is this error copy user-appropriate?" → advisory worklist row for /redteam.

# DO NOT — a model verdict gates the merge
"LLM judged the response 'looks correct' → mark PASS, block merge on the LLM verdict."
(non-reproducible; a re-run flips the gate, and a flaky judge blocks a good merge)
```

**Why:** A CI gate must be reproducible — a model-in-the-loop verdict flips between runs and turns the gate into noise operators learn to override. Splitting deterministic (load-bearing) from semantic (advisory) keeps the gate trustworthy while still surfacing the judgment questions to the human, pre-computed.

### 3. Coverage Is Reported Separately From Pass-Rate, Over A Machine-Derived Denominator

Coverage (is every enumerated unit measured?) MUST be reported SEPARATELY from pass-rate (how many measured units passed). The denominator MUST be machine-derived — enumerated from source or runtime, never hand-listed — and a verdict counts toward coverage only if it carries ≥1 real assertion (no-vacuous-eval guard). Fabricating 100% by dropping non-pass rows, hand-listing the denominator, or counting an assertion-free verdict as coverage is BLOCKED.

```text
# DO — two separate numbers over a machine-derived denominator
Denominator = 214 routes enumerated from the router AST. Coverage: 214/214 measured
(100%). Pass-rate: 190/214 pass, 24 fail. The 24 fails are the fix-list; coverage is honest.

# DO NOT — collapse coverage into pass-rate, or hand-list the denominator
"We test 190 routes and they all pass → 100%." (the 24 unmeasured routes vanished from
the denominator; "100%" is fabricated by omission)
```

**Why:** Collapsing coverage into pass-rate lets a surface hit "100%" by never measuring the units that would fail — the denominator silently shrinks to the passing set. A machine-derived denominator + separate coverage number makes "nothing unmeasured" a checkable claim, and the no-vacuous guard closes the `assert(true)` hole.

### 4. The Verdict Taxonomy Is Discrete: Pass | Fail | Blocked | Retest | Skipped | Not-Run

Every unit's verdict MUST be one of the discrete set `Pass | Fail | Blocked | Retest | Skipped | Not-Run`. `Blocked` (un-walkable — a precondition/dependency was down) is NOT `Pass` and NOT `Fail`; `Retest` (non-deterministic, needs a re-run) is NOT `Fail`; `Skipped` (deliberately out of the denominator — consciously out of scope) is distinct from `Not-Run` (in the denominator, never reached this run) which is a coverage gap, NOT a `Pass`. Collapsing `Blocked` / `Not-Run` into `Pass`, or a coverage gap into silence, is BLOCKED.

```text
# DO — a down dependency is Blocked, a never-reached unit is Not-Run
Auth service down → the 12 units behind it are Blocked (not Fail, not Pass).
Runner never reached route /admin/audit → Not-Run (a coverage gap to close, not a pass).

# DO NOT — coerce non-pass verdicts to Pass to hit a green board
"The dependency was down so those 12 units just pass by default." (Blocked→Pass hides
that they were never actually judged)
```

**Why:** A binary pass/fail forces every un-judged unit into one bucket, and "green" absorbs Blocked and Not-Run silently — the exact way a coverage gap masquerades as success. The discrete taxonomy keeps "we couldn't judge this" and "we never got to this" visible and distinct from "this passed".

## MUST NOT

- Assert the floor (compiled / rendered / 200 / no-crash) as the expectation. **Why:** the floor is satisfied by a surface doing the wrong thing; the frozen expectation is the only signal that separates works from runs.
- Wire a non-reproducible LLM/agent verdict as a blocking CI gate. **Why:** a model-in-the-loop gate flips between runs and becomes override-noise; deterministic verdicts gate, semantic ones advise.
- Report a single "100%" that conflates coverage and pass-rate, or hand-list the denominator. **Why:** the denominator silently shrinks to the passing set — fabricated 100% by omission.
- Ship a new unit with no frozen expectation, or let a coverage regression pass the gate. **Why:** freeze-then-judge requires the expectation to precede the unit; without the ratchet, coverage decays every merge.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm every touched testable surface's units carry frozen expectations, coverage is reported separately from pass-rate over a machine-derived denominator, and the verdict taxonomy is the discrete set); `advisory` at the hook layer (whether an expectation is frozen-vs-floor and whether a denominator is machine-derived are judgment-bearing per `hook-output-discipline.md` MUST-2 — no structural tool-call signal; a lexical tripwire on `assert(true)` / status-only assertions MAY pair as advisory but MUST NOT carry `block`).
- **Grace period:** 7 days from rule landing (2026-07-16 → 2026-07-23).
- **Cumulative posture impact:** same-class violations (a unit shipped without a frozen expectation, a semantic verdict wired as a blocking gate, coverage conflated with pass-rate, or a non-discrete verdict) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a freeze-then-judge / coverage-honesty property is review-layer-plus-advisory-hook and does not warrant an instant-drop key; the universal trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: conformance-walk]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/implement` + cc-architect at `/codify` inspect any session touching a testable surface and confirm (a) each new unit carries a frozen expectation asserted against observed state, (b) the deterministic oracle is the gate and any semantic verdict is advisory, (c) coverage is reported separately from pass-rate over a machine-derived denominator with the no-vacuous guard, (d) verdicts are from the discrete taxonomy. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — advisory detectors for floor-only assertions (`status < 500` / `assert(true)`) + hand-listed denominators; audit fixtures land with the Phase-2 detectors at `.claude/audit-fixtures/conformance-walk/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 (frozen expectation vs floor) + MUST-2 (deterministic-load-bearing / semantic-advisory split) + MUST-3 (coverage-separate-from-pass-rate + machine-derived denominator + no-vacuous) + MUST-4 (discrete verdict taxonomy).
- **Origin:** See § Origin.

## Origin

2026-07-16 — loom origination (#1146), generalizing two independently-converged instances of one meta-pattern: the Symbol Conformance Matrix (SCM, a static-symbol/BE verification method in a BUILD SDK repo) and the Transition-Oracle Walk (TOW, #1137, a route/interaction/FE eval-harness in a downstream consumer). The four MUST clauses are the surface-neutral core; each surface supplies its own adapter per `skills/conformance-walk/SKILL.md`. #1137 is re-scoped as CW's route/interaction (FE) adapter, not closed. Co-owner-directed origination per `rules/artifact-flow.md` § Co-Owner-Directed Origination; receipt-first DECISION `journal/0518`. Core-extraction evidence (six shared elements, file:line-grounded from both instances) in the design study; the specific instance provenance stays in the local receipt per `knowledge-cascade-routing.md` MUST-3.
