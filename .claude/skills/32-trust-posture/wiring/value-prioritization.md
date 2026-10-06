# value-prioritization — governance bookkeeping

**This file carries the Trust-Posture Wiring, the rule-graph cross-references and the
Origin record for `.claude/rules/value-prioritization.md`. It is NOT a rule and states no
new obligation — every MUST and MUST NOT token below RESTATES a clause that lives in the
rule, quoted so the Wiring fields can name what they bind.**

**Why it is here.** Claude Code injects every `.md` under `.claude/rules/` recursively at
launch; the skills tree is not injected. Governance bookkeeping is read by gate-review and
by the validators, never acted on mid-turn, so every session was paying for it. This tree
also SHIPS (`skills/32-trust-posture/**` is a distribution tier) and is already on the
self-referential allowlist, so consumers keep their Wiring and edits here still fire the
Tier-1 gate.

---

## Trust Posture Wiring — MUST-7 (clause-scoped)

Applies to the **MUST-7** clause ONLY (class-exclusion requires a measured critical-path share), added 2026-08-11 via `/sync-from-build` Gate-1 placement; ships canonical-8-field-compliant per `trust-posture.md` MUST-8. The pre-existing rule-wide block below governs MUST-1..6 and is unchanged until itself `/codify`-touched.

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm the inline critical-path-share measurement and the prior-decision surfacing); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from clause landing (2026-08-11 → 2026-08-18).
- **Cumulative posture impact:** same-class violations (a work class held, deprioritised, or deferred on throughput grounds with no measured critical-path share stated inline; a hold retained after its measured saving was shown to be ~0; a directive reversing a documented prior decision codified without surfacing that decision) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key. Named deviation per `trust-posture.md` Rule 8. It does NOT reuse `streetlight_selection` / `deferral_without_value_anchor`: those fire on a fittability pick WITHIN a set, not on excluding a class from it.
- **Receipt requirement:** SessionStart soft-gate `[ack: value-prioritization]` IFF `posture.json::pending_verification` includes the `value-prioritization` rule_id (shared rule_id; one ack covers MUST-1..7).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/implement` + cc-architect at `/codify` confirm the transcript carries (a) the class's measured critical-path share stated BEFORE the disposition, (b) what the hold COSTS, and (c) any reversed prior decision surfaced before codifying. **Phase 2 is RETIRED, not pending (2026-09-11): no hook detector will EVER be built** — a lexical detector would carry `block` on a lexical signal, which `hook-output-discipline.md` MUST-2 forbids and `rule-authoring.md` MUST NOT names. Gate-review IS the enforcement layer for MUST-7, permanently, and NO structural fixtures are owed. Rationale: `phase2-deferrals.json` key `value-prioritization.md#critical-path-share`. **Probes: REGISTERED for this clause too** — `.claude/test-harness/probes/value-prioritization.probes.json` carries a `MUST-7-firing` bipolar pair. Per-item depth: guide-extract § "MUST-7 Wiring — Detection-mechanism depth".
- **Violation scope:** MUST-7 ONLY (clause-scoped): a class excluded on throughput grounds with no measured critical-path share; a hold sustained against a measured ~0 saving; a prior-directive reversal codified without surfacing the prior decision. MUST-1..6 keep their existing scope under the rule-wide block below.
- **Origin:** See § Origin — 2026-07-26, BUILD stream.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect / analyst at `/codify`); `advisory` at the hook layer (lexical regex MUST NOT carry `block` per `rules/hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing.
- **Regression-within-grace:** any same-class violation triggers emergency downgrade L5→L4 per `rules/trust-posture.md` MUST Rule 4. Add `streetlight_selection` and `deferral_without_value_anchor` to trust-posture.md's emergency-trigger list.
- **Receipt requirement:** SessionStart MUST require `[ack: value-prioritization]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** the canonical single-field roll-up of the two bullets below, per `rules/trust-posture.md` MUST-8 (the split below predates that mandate and is retained because each half carries detail the roll-up cannot). Hook layer — the four `.claude/hooks/lib/violation-patterns.js` detectors named below, `advisory` for the Stop-event prose ones and `halt-and-report` for the Bash-time one; review layer — the `/codify` mechanical sweep over hook-flagged transcripts, final disposition human. Fixtures `.claude/audit-fixtures/violation-patterns/` + `.claude/audit-fixtures/value-prioritization/`; probes `.claude/test-harness/probes/value-prioritization.probes.json`, dispatched at gate-review and NOT in CI.
- **Detection (hook layer):** four detectors in `.claude/hooks/lib/violation-patterns.js` — `detectStreetlightSelection` (Stop, MUST-1), `detectDeferralWithoutValueAnchor` (Stop, MUST-2), `detectDeferredItemPickupWithoutRevalidation` (Stop, MUST-3), `detectGhIssueCloseAsNotPlanned` (PostToolUse(Bash), MUST-4). Severity: `advisory` for the Stop-event prose detectors, `halt-and-report` for the Bash-time one. Audit fixtures at `.claude/audit-fixtures/violation-patterns/detect{Streetlight,DeferralWithoutValueAnchor,DeferredItemPickupWithoutRevalidation,GhIssueCloseAsNotPlanned}/` per `rules/cc-artifacts.md` Rule 9. **Probes: REGISTERED — `.claude/test-harness/probes/value-prioritization.probes.json`** — one firing pair per derived clause (MUST-1..7 plus the `MUST-NOT` section) plus a meta-compliance pair, candidates at `.claude/audit-fixtures/value-prioritization/`. The MUST-1 pair is the load-bearing one. Row counts, registration, pole diff and dispatch semantics: guide-extract § "Probe-registration depth (2026-09-13)". Per-detector match contracts (patterns, adjacency windows, and the MUST-5 `/autonomize`-as-authority pattern-extension targets): guide-extract § "Detection mechanism — hook-layer detector contracts (full)".
- **Detection (review layer):** `/codify` mechanical sweep on hook-flagged transcripts — reviewer confirms SEMANTIC compliance per the flagged rule, and IS the probe-driven gate-review counterpart per `probe-driven-verification.md` MUST-4 for all three prose-detected MUST clauses (the LLM-judge verdict is the probe, per that rule's MUST-2). Final disposition is human. Per-MUST sweep questions: guide-extract § "Detection mechanism — review-layer per-MUST sweep protocol".

## Distinct From / Cross-References

Extends `recommendation-quality.md` + `autonomous-execution.md` + `sweep-completeness.md`; pairs with `time-pressure-discipline.md` + `zero-tolerance.md` Rule 1c; distinct from `autonomous-execution.md` § Per-Session Capacity Budget + the `feedback_*` HOW-preference memories. Per-rule clause map, to read when adjudicating an overlap: guide-extract § "Distinct From / Cross-References (full map)".

## Origin

**Failure-A** (deferral-as-forgetting, 2026-04-23) + **Failure-B** (streetlight selection, 2026-05-07 loom session). Both narratives verbatim, the user directive that landed the rule, and the 7-of-7 decay audit: guide-extract § "Origin — Failure-A / Failure-B narratives (full)".

**Empirical-claim status — DIRECTIONALLY SUPPORTED** across five ablation cycles; differentials, the seven caveats and the results index: guide-extract § "Empirical-claim status".

**Extraction records** — 2026-08-19 + 2026-08-24 + 2026-08-28 + 2026-09-13 (this one). The 2026-08-28 and 2026-09-13 passes are ZERO de-scoping: every MUST, MUST NOT, BLOCKED entry, DO/DO-NOT block and `**Why:**` failure-mode statement stayed here, with the MUST-7 Wiring block and the rule-wide block each keeping their canonical fields. **2026-08-24 was NOT** — it moved MUST-7's DO/DO-NOT and eight-phrase BLOCKED corpus to the extract, which is not injected, so MUST-7's tripwires do not load with the rule. OPEN FINDING, recorded rather than hidden under a blanket claim. **`rule-authoring.md` Rule 10 / Rule 11 do NOT fire** — this rule is `scope: path-scoped`, so these are STRUCTURAL CLEANUP (the `journal/0148` disposition). Records: guide-extract §§ "Structural-cleanup extraction — 2026-08-19" + "— 2026-08-28" + "— 2026-09-13".

**MUST-7 — 2026-07-26, BUILD stream (Rust SDK); landed at loom 2026-08-11 via `/sync-from-build` Gate-1, classified GLOBAL.** A co-owner directed holding an entire class of secondary-binding work on throughput grounds; the class was MEASURED, the saving was approximately zero, and the co-owner reversed — which is why "the requester already decided" is a BLOCKED rationalization rather than a stopping condition. Measured narrative: guide-extract § "MUST-7 — Origin narrative (measured)".
