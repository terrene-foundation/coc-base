# Product-Completion-First — Depth Extract

Depth companion for `.claude/rules/product-completion-first.md`. The rule body carries every
obligation (MUST / MUST NOT / BLOCKED corpus / `**Why:**` line / canonical Wiring fields); this file
carries the narrative, measurement history and provenance moved out of it under `rule-authoring.md`
Rule 10 path (a). Nothing here is normative on its own — read it as the rule's evidence base.

## Detection Mechanism — Depth

Probe-tier registration semantics and the consumer-lane measurement, moved verbatim from the rule's
`- **Detection mechanism:**` bullet:

> Registered in `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`. Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed — they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at gate-review. Consumer note: `.claude/test-harness/probes/product-completion-first.probes.json` does not ship to use/base, build/base, use/py, build/py, use/rs, build/rs (MEASURED: `skip` on 6 of this rule’s 6 lanes), so no consumer on those lanes receives it; at those targets this tier is not a live gate and enforcement is gate-review at the consumer’s end.

The detector's CLOSED signal set, and why it is closed:

> `.claude/hooks/bug-signal-defer-guard.js` runs the predicate `.claude/hooks/lib/bug-signal-defer.js::findBugSignalDefers`, and flags a DEFERRED finding whose text also names a BUG signal (`failing test` / `build error` / `type error` / `insecure` / `lossy` / `contract break` / `gate-integrity` / `self-ref-enforcement defect` — the full BUG-definition signal set, transcribed from this field and CLOSED, so the detector cannot assert a category boundary this rule did not draw).

What the advisory severity surfaces, and what it deliberately does not:

> and what it surfaces is a QUESTION for the reviewer — is the category right? — never a category verdict, which only gate-review can give.

### Staged rollout — arming, fencing, promotion

> **It IS registered** in `.claude/settings.json` at `PostToolUse`, matcher `Edit|Write|NotebookEdit` — the write-tool set its own `@hook-event` header declares, MEASURED on this tree against a known-absent control — so AT LOOM it fires. **ARMED is not PROVEN EFFECTIVE:** no armed guard has been OBSERVED firing in a live session; registration and distribution state are all that is measured, and the discrimination census below predates arming and is OWED a re-measurement rather than restatable as current. **It reaches NO consumer:** the hook file is deliberately fenced `loom_only` in `sync-manifest.yaml` with its required twin in `validate-emit.mjs::LOOM_ONLY_TIER_CARVEOUTS`, so it does not ship — a consumer receives this RULE and not this DETECTOR, enforcement at those targets is GATE-REVIEW at the consumer's end, its silence there is the ABSENCE OF AN INSTRUMENT rather than evidence that no mis-categorized defer shipped, and the gap is DECLARED in the detector-distribution baseline registry (`detector-distribution-baseline.json`, under the test-harness tree) rather than left silent. **Staged because firing volume is measured on loom's corpus and nowhere else, and a consumer's corpus is a different population.** PROMOTION is deleting this guard's `loom_only:` entry TOGETHER WITH its `LOOM_ONLY_TIER_CARVEOUTS` twin — removing either alone is a defect. Registry note, outside this lane's write-set: the `phase2-deferrals.json` row for this detector sits in `acknowledged_non_deferrals` under the id `product-completion-first.md#bug-signal-defer-detector`, and its "no longer owed" reasoning rests on a registration premise that is now TRUE at loom and FALSE at every consumer — re-stating that row on the armed-and-fenced facts is still owed.

### Detector scope — where a disposition is RECORDED

> **Scope is where a disposition is RECORDED** (workspace notes, sweep/redteam reports, todo lists, journal entries, session notes), deliberately NOT this rule's `paths:` frontmatter, which says where the RULE LOADS; consequently this rule file is out of scope and the detector does not fire on the corpus that defines it.

### Discrimination census, per-suppressor rationale, and the enumerated blind spots

> **Discrimination was MEASURED before it was built, not assumed:** across 1625 durable markdown files on this tree, 2320 units mention defer/incremental at all and the conjunction fires on 5 — 0.2% — with this rule's own canonical violation as the positive control (fires) and its own canonical compliant defer as the negative control (silent). The nearest neighbour in the corpus, `deferral-registry-locality.md`, had its own detector RETIRED as unbuildable precisely because its matcher fired on everything and separated nothing; this one was held to that test first.

The four suppressors, with the per-suppressor justification the rule body states only in summary:

> fenced code, markdown table rows (a `|` row is not a sentence, and that artifact produced 3 of the 5 measured hits), a FIXED / FIX NOW disposition (which is not a defer), and a `BLOCKED`-marked quotation of a rationalization.

> **Blind spots are enumerated, not implied:** a defer stated only in chat and never written down, and any write that bypasses `Edit`/`Write`/`NotebookEdit`, are outside the matcher's vantage point, so Phase 1 stays the backstop.

> They live in their own directory rather than beside the SEMANTIC candidates at `.claude/audit-fixtures/product-completion-first/`, so the probe corpus keeps a single consumer.

## Regression-Within-Grace — Key Rationale

Why `blocking_triage_bypass` is a DEDICATED emergency trigger key rather than the generic
`regression_within_grace` the corpus usually takes:

> a dedicated key because mis-triaging a completion-blocking finding as deferrable polish is a distinct, high-consequence failure class (a real defect ships under a converged banner) warranting an instant drop, not only cumulative accrual.

## Skip-Class Carve-Out — Why A Declared CLEAN Skip Carries No Fork-Side Delta

> A CLEAN artifact is byte-identical to the last-accepted canon blob canon already reviewed to convergence — it carries NO fork-side delta to find, so its review is DELEGATED upstream by construction, not deferred as incremental.

## Origin — Depth

The verbatim co-owner directive and the ratified D1–D4 dispositions, moved verbatim from the rule's
§ Origin:

> Verbatim directive: red-team stays in every phase/wave, but the harness must stop grinding ~80% of the budget on <10%-value increments that do not block a complete, visible product — "small increments that do not block the sprints to completion should be documented and tracked separately, and revisited as required or after the full product is done and visible."

> Ratified dispositions D1–D4 (`journal/0467`): D1 lean anchor rule (authored `priority:10 path-scoped` under the measured saturated-baseline constraint — codex 11.89% / gemini 12.35% headroom within the 15% proximity band, matching the `knowledge-cascade-routing.md` precedent), D2 invest-now surfaced-for-direction, D3 GH `deferred-quality` label surface, D4 numeric autonomous-cycle ETA.

Also moved here 2026-09-13 (citation-restoration paired extraction), from the same § Origin
sentence: the rule was **corrected in-session** to the CATEGORY gate, with severity decoupled from
fix-vs-defer, and `/sweep` was rebuilt as a management decision report in the same cycle.

## Detector And Fixture Narrative — Relocated 2026-09-13

Relocated from the `**Detection mechanism:**` field (citation-restoration paired extraction); the
rule body keeps every binding, this keeps the exposition.

- The detector's rollout descriptor reads "ARMED AT LOOM, FENCED FROM CONSUMERS (staged rollout,
  2026-09-13)" in the rule; in full, it is a **co-owner-approved** staged rollout — staged because
  firing volume is measured on loom's corpus and nowhere else, and a consumer's corpus is a
  different population. PROMOTION is deleting the guard's `loom_only:` entry TOGETHER WITH its
  `LOOM_ONLY_TIER_CARVEOUTS` twin; removing either alone is a defect.
- The 25 bipolar cases at `.claude/audit-fixtures/bug-signal-defer/` isolate **each arm of the
  conjunction and each suppressor** — that isolation is what makes the case count load-bearing
  rather than decorative.

## Extraction Record

2026-09-13 paired extraction (`rule-authoring.md` Rule 10 path (a)), ZERO de-scoping: every MUST,
MUST NOT, BLOCKED-corpus entry, DO/DO-NOT block and `**Why:**` line stayed in the rule body, and the
Wiring block keeps all eight canonical field labels with their normative statements. The three-category
positive-allowlist definitions were re-shaped from a padded markdown table into a bullet list with the
cell text preserved — a formatting change, not a content change. What moved is enumerated by the
sections above.
