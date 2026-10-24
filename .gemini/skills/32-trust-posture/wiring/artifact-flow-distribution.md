# artifact-flow-distribution — governance bookkeeping

**This file carries the Trust-Posture Wiring, the Origin record and the rest of the full-length rationale for
`.claude/rules/artifact-flow-distribution.md` (what a sync may write). It is NOT a rule and states no new obligation — every MUST
and MUST NOT token below RESTATES a clause that lives in the rule.** Moved verbatim from the rule body
of `artifact-flow.md` when it was split into four path-scoped rules (context-budget workstream,
2026-10-10); each rule keeps its clauses and its BLOCKED corpora.

---

## Full Why paragraphs (moved from the rule body)

The **Why:** paragraphs of § The Owned-Surface Bound moved back inline into `.claude/rules/artifact-flow-distribution.md`, verbatim and at their pre-split position, later on 2026-10-10: they are what lets `check-clause-coverage.mjs` derive those sections as named clauses. The paragraphs below are the rest.

### Why — The consultant's edit-ban is Class A (the E3 reframe)

**Why:** Filing a distribution-mechanics fact as a role restriction falsely tells a consultant they may not improve templates and removes their most autonomous lane (D4 self-serve); a role-scoped (C) + posture-unlocked (B) write still MUST clear Class A. Full E3-reframe reasoning: see `.claude/guides/rule-extracts/artifact-flow.md` § E3 Reframe — Consultant Edit-Ban Is Class A.

### Why — Target-Only Paths Are Preserved

**Why:** Preservation stated only in manifest comments is invisible to the rule corpus that governs distribution — the same silence that left ADD ungoverned, one key over. The manifest cited a `cross-repo.md` MUST Rule 4 that never existed; a dangling citation reads as a governed obligation while pointing at nothing (`spec-accuracy.md`).

### Why — MUST NOT — a tier match is not distribution

**Why:** any other composition order OVER-REPORTS the distributed surface, so a contract derived from it declares surfaces loom does not write — and the enforcement then either encodes a fiction or reds on correct behaviour. Measured, base lane: companion § Composition Order — Measured Over-Report.

### Why — MUST NOT — every artifact has a positive fate

**Why:** absence from the shipped set would record no intent, leaving a deliberate loom-side tool indistinguishable from a file someone forgot to declare. **This invariant is currently HELD, and the clause exists to KEEP it held — it is prophylactic, not a live defect.** The landing measurement, and the `skip/no_tier_match`-is-not-undeclared trap: companion § Positive Fate — The Invariant Is Held.

### Trust Posture Wiring — Owned-Surface Bound + Target-Only Preservation

Applies to the **two clauses immediately above** ONLY (added 2026-08-16); ships canonical-8-field-compliant per `trust-posture.md` MUST-8. Every other section of this file stays on its own wiring until itself `/codify`-touched: companion § Owned-Surface Bound — Wiring Scope Note (full).

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/implement` confirm any change widening loom's write surface declared it in `owned_surfaces:` with `opt_in: true` + a real `election:`, and that no `target_owned:` path was overwritten or purged); `block` at the structural layer is carried by `check-owned-surfaces.mjs`, which fails the CI job — not by a hook, because a surface widening is a manifest/plan property with no tool-call-time signal (`hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from clause landing (2026-08-16 → 2026-08-23).
- **Cumulative posture impact:** same-class violations (a write to an undeclared surface; a non-`.claude` surface declared `opt_in: false`; an `opt_in: true` entry with no election; a `target_owned:` path overwritten or purged without an explicit `obsoleted:` exemption) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key; named deviation per `trust-posture.md` Rule 8, the structural gate already refusing the violating state at CI. Full reasoning: companion § Owned-Surface Bound — Regression-Within-Grace Disposition (full reasoning).
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-flow]` IFF `posture.json::pending_verification` includes the `artifact-flow` rule_id (shared rule_id; one ack covers every clause in this file).
- **Detection mechanism:** structural + review, and the structural half SHIPS WITH THE CLAUSE. `.claude/bin/check-owned-surfaces.mjs` reds on four kinds over both USE lanes and every BUILD lane, with `--selftest` as its positive control; bipolar poles at `.claude/audit-fixtures/owned-surface-bound/`, pinned by `.claude/test-harness/tests/check-owned-surfaces.test.mjs`, gate + suite both wired into `.github/workflows/coc-artifact-eval.yml`. Review: cc-architect at `/codify` judges whether a NEW surface should exist at all, which no mechanical check can answer. The four kinds named, their per-kind mechanics and the pole diff: companion § Owned-Surface Bound — Detection Mechanics.
- **Invoker class:** `ci` AND `agent-mid-procedure`. `ci` is backed by `.claude/bin/check-owned-surfaces.mjs`, a `run:` step in `.github/workflows/coc-artifact-eval.yml` (beside its `--selftest` and `.claude/test-harness/tests/check-owned-surfaces.test.mjs`), firing on every CI run with no command typed. `agent-mid-procedure` is cc-architect at `/codify` and reviewer at `/implement`, judging whether a NEW surface should exist at all; at an audience that surfaces neither command that half is REACHABLE-BUT-UNINVOKABLE.
- **Violation scope:** the § Owned-Surface Bound clause + the § Target-Only Paths Are Preserved clause ONLY (clause-scoped). Every `violations.jsonl` row names the surface and the lane it was measured on.
- **Origin:** See § Origin — 2026-08-16, co-owner-ratified D1/D2/D3/D4/D6.

## Trust Posture Wiring — Probe Pairs For This Rule

- **Detection mechanism:** the `MUST-NOT-firing` pair in `.claude/test-harness/probes/artifact-flow-distribution.probes.json` (fixtures `.claude/audit-fixtures/artifact-flow/`) exercises this rule's tier-match and positive-fate MUST NOT bullets — both rows name `.claude/rules/artifact-flow-distribution.md` as their `artifact`. The suite is registered under its own `artifact-flow-distribution` manifest key; the pair moved there from `artifact-flow.probes.json` when this rule was split from `artifact-flow.md` (2026-10-10), and it carries a copy of the meta-compliance pair. The Owned-Surface and Target-Only clauses have no pair — dated-deferred in `clause-coverage-baseline.json`.

## Origin — Owned-Surface Bound + Target-Only Preservation

**§ The Owned-Surface Bound + § Target-Only Paths Are Preserved — 2026-08-16, co-owner-ratified D1/D2/D3/D4/D6.** Depth: companion § Owned-Surface Bound + Target-Only Preservation — Origin (full narrative).
