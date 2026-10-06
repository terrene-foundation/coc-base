# type-relaxation-sweep — governance bookkeeping

**This file carries the Trust-Posture Wiring, the rule-graph cross-references and the
Origin record for `.claude/rules/type-relaxation-sweep.md`. It is NOT a rule and states no
new obligation — every MUST and MUST NOT token below RESTATES a clause that lives in the
rule, quoted so the Wiring fields can name what they bind.**

**Why it is here.** Claude Code injects every `.md` under `.claude/rules/` recursively at
launch; the skills tree is not injected. Governance bookkeeping is read by gate-review and
by the validators, never acted on mid-turn, so every session was paying for it. This tree
also SHIPS (`skills/32-trust-posture/**` is a distribution tier) and is already on the
self-referential allowlist, so consumers keep their Wiring and edits here still fire the
Tier-1 gate.

---

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/analyze` + `/implement` confirm two
  separate inventories, swept against the proposed type); `advisory` at the hook layer per
  `hook-output-discipline.md` MUST-2 (whether a type change is safety-load-bearing is judgment-bearing).
- **Grace period:** 7 days from rule landing (2026-08-10 → 2026-08-17).
- **Cumulative posture impact:** same-class violations (extraction sites never inventoried separately,
  or classified safe from a render-side guard) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md`
  MUST-4 (1× = drop 1 posture) — NO dedicated key (review-layer judgment; minting one would drag the
  `self-referential-codify.md`-allowlisted `trust-posture.md` into a self-referential edit). Named
  deviation per `trust-posture.md` Rule 8, as `security.md` § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart soft-gate `[ack: type-relaxation-sweep]` IFF
  `posture.json::pending_verification` includes the `type-relaxation-sweep` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer enumerates sites reachable under
  the relaxed type and confirms the extraction inventory is distinct from the render one; a single
  merged list is the finding. Fire the site matcher at a known-affected file before trusting an empty
  inventory (`instrument-discipline.md` MUST-3(a)). **Phase 2 is RETIRED, not pending (2026-09-11):
  no hook detector will EVER be built.** The TRIGGER is an AST fact but the OBLIGATION is not, so a
  hook on the trigger alone is a reminder, never a detection. Gate-review is the permanent
  enforcement layer; rationale in `phase2-deferrals.json` key
  `type-relaxation-sweep.md#relaxed-type-site-sweep`. **Probes: REGISTERED —
  `.claude/test-harness/probes/type-relaxation-sweep.probes.json`**, 4 rows in 2 bipolar `pair_id`
  pairs — one firing pair for this rule's single derived clause, plus a meta-compliance pair — with
  candidate fixtures + answer-key sidecars at `.claude/audit-fixtures/type-relaxation-sweep/`.
  Registered in `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in
  `probe-suite-integrity.test.mjs::PINNED_SUITES`; ZERO deferred clauses in
  `clause-coverage-baseline.json`. The firing pair is the SEMANTIC tier this retirement leaves
  owed, and it is the right instrument for exactly the reason the hook is not: its violating pole
  runs the MUST-3(a) site-matcher control and PASSES it, so the inventory is sound and only its
  CLASSIFICATION is the defect — a property no receiver-resolution fact carries. Registration buys
  DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and the
  loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed —
  they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at
  gate-review. Consumer note: `.claude/test-harness/**` is never-synced, so no consumer receives
  this suite and enforcement at those targets is gate-review.
- **Violation scope:** MUST-1 ONLY; each row names the relaxed constraint + the unswept site.
- **Origin:** See § Origin.

## Origin

Origin: 2026-08-10 — `/sync-from-build` `build.prism` Gate-1 ingest of `type-relaxation-surface-sweep`
(blob `6309373`). GLOBAL; the `.dart` glob was dropped by the proposal's own red-team. Placement
rationale + full narrative: skill § Origin.
