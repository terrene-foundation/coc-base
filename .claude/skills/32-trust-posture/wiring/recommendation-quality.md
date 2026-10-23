# recommendation-quality — governance bookkeeping

**This file carries the governance bookkeeping for the recommendation-quality family:
`.claude/rules/recommendation-quality.md` (MUST-1..5), `.claude/rules/recommendation-quality-packets.md`
(MUST-6) and `.claude/rules/recommendation-quality-escalation.md` (MUST-7, MUST-8). It is NOT a rule and
states no new obligation — every MUST and MUST NOT token below RESTATES a clause that lives in one of
those rules.** Moved verbatim from the single rule body (context-budget workstream, 2026-10-10), so the
Wiring blocks still speak of one rule: they declare ONE shared rule_id, and they stay together here for
that reason. Each rule keeps its clauses and their BLOCKED corpora. The MUST-6, MUST-7 and MUST-8 Why paragraphs and clause-scoped Wiring now sit in
`wiring/recommendation-quality-packets.md` and `wiring/recommendation-quality-escalation.md`.

---

## Preamble — full text (moved from the rule body)

The user opens a conversation to be **advised**, not to be a decision arbitrator on an unannotated list.

## Full Why paragraphs (moved from the rule bodies)

### MUST-1

**Why:** A neutral menu transfers the synthesis cost from the agent (high-context, fast) to the user (lower-context-on-implementation, slow). Users who wanted a menu would have asked for one — they asked the agent because they wanted advice. "Avoiding bias" by staying neutral IS a bias toward inaction. If context is genuinely missing, the agent MUST state which context would change the recommendation, not punt.

### MUST-2

**Why:** Implications are the difference between a recommendation a user can act on and a recommendation they have to interrogate. The agent has the load-bearing context already; surfacing it costs one paragraph. Forcing the user to re-derive it costs one round-trip.

### MUST-3

**Why:** Hiding cons makes the recommendation look like a one-way decision when it isn't. Users discovering the cons later (after committing to the recommendation) lose trust in every future recommendation from the same agent. The structural defense is to surface the cons as part of the recommendation; if they outweigh the pros, the recommendation should change.

**Why:** A con that does not change the user's decision is rhetorical filler; at a gate-stop it additionally misframes the correct hand-to-human action as a compromise and pressures toward continuing — the opposite of the honest signal the user needs. Honest symmetry surfaces the cons that would change or qualify the pick and states plainly when there are none.

### MUST-4

**Why:** Many COC users are non-technical, and even technical users context-switch across domains. Jargon-heavy framings compound across a conversation: every untranslated term increases the cognitive cost of the next decision. Translation at first appearance amortizes the cost. Per `rules/communication.md`: "Match the user's level if they speak technically" — but FIRST default to plain language; the user can opt up to jargon by speaking it themselves.

### MUST-5

**Why:** A recommendation that ends in "or, alternatively, the menu I just declined to recommend on" cancels itself out. Either the agent has a recommendation (commit to it; ask yes/no to confirm OR ask one specific clarifying question that would change it), or the agent doesn't and should say so explicitly: "I don't have enough context to recommend; I need to know X first."

## Trust Posture Wiring

- **Severity:** `advisory` for the hook-based detection (lexical regex match — per `rules/hook-output-discipline.md` MUST-2, lexical signals MUST NOT carry severity:block); `halt-and-report` when surfaced by a gate-level reviewer (reviewer / cc-architect) at `/codify`. Never block-at-tool-call — recommendations are prose, so no structural PreToolUse signal exists.
- **Grace period:** MUST-1..5 — 7 days from 2026-05-06 (→ 2026-05-13). MUST-6 — 7 days from 2026-05-18 (→ 2026-05-25). During grace the Stop-event hook logs to `violations.jsonl` for cumulative tracking but does NOT auto-emergency-downgrade; after grace, regression feeds `rules/trust-posture.md` MUST Rule 4 cumulative math (5× total in 30d → drop posture).
- **Regression-within-grace:** a same-class violation authored by `/codify` (a recommendation that drops to a menu, hides cons, buries jargon, OR a blank-field decision packet) within the relevant grace window → emergency-downgrade per trust-posture Rule 4.
- **Receipt requirement:** SessionStart MUST require `[ack: recommendation-quality]` in the agent's first response IF the most recent `violations.jsonl` includes a `recommendation-quality/MUST-1` entry AND `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** the canonical single-field roll-up per `trust-posture.md` MUST-8. Phase 1 — the hook-layer `.claude/hooks/lib/violation-patterns.js::detectMenuWithoutPick` (≥2 option markers, no recommendation anchor; Stop-event chain via `.claude/hooks/detect-violations.js`, advisory, IMPLEMENTED 2026-05-06); the `/codify` gate-level reviewer sweep adjudicating each hook flag (false positive — the user asked for a menu — vs true positive, final disposition human); and the `/codify` + `/redteam` gate-review over MUST-6 decision packets. Fixtures `.claude/audit-fixtures/violation-patterns/detectMenuWithoutPick/` + `.claude/audit-fixtures/recommendation-quality/`, per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. **MUST-6 STRUCTURAL DETECTOR — SHIPPED 2026-09-15, graduating this rule's `phase2-deferrals.json::deferrals["recommendation-quality.md#must6-decision-packets"]` row, which is DELETED in the same change.** `.claude/hooks/decision-packet-guard.js` runs the pure predicates at `.claude/hooks/lib/decision-packet.js` over a `PostToolUse` `Write` payload, with fixtures at `.claude/audit-fixtures/decision-packet/` (19 bipolar cases driven by that directory's `run.mjs`, MEASURED 19/19). It parses the written markdown, finds a decision table by its HEADER (an answer/recommendation column beside a ratify column) or a `**Recommendation:**` bullet or a bare `→ ANSWER:` marker, and reports THREE distinct states that a naive emptiness check collapses: `packet-answer-empty` (the cell EXISTS and is blank, including the `____` blank-fill idiom), `packet-answer-punt` (the cell holds a declared punt token — non-empty text, so an emptiness check misses it), and `packet-row-indeterminate` (NO cell at the answer index — ABSENT, not empty, and reported `advisory` rather than as a blank). Severity is `halt-and-report`, NOT `block`: the table walk is structural and MUST-2 would permit teeth, but deciding which column is the answer column and whether a cell is a punt are both prose matches, and a detector is capped at its weakest half. **WHAT IT CANNOT SEE, so its silence is never an all-clear (`instrument-discipline.md` MUST-3(a)):** EDITS — the declared scope is `Write` and the predicate reads `tool_input.content`, which an Edit does not carry, so a blank introduced into a clean packet by an Edit is missed; packets that stay prose in a chat reply (that is `detectMenuWithoutPick`'s half); a non-markdown path; and — structurally, forever — MUST-6's AUTHORSHIP half, since a specialist-produced pick and a single-threaded orchestrator guess are byte-identical in the file. Those remain gate-review. MEASURED on this tree: 0 findings across 4,852 tracked `.md` files, which is a READABLE true negative and not inert silence — the same predicate fires on the rule's own DO-NOT examples once they are lifted out of their code fence, and the Form-B bullet walk classified 36 recommendation fields in four live packets, all FILLED. **Probes: REGISTERED — `.claude/test-harness/probes/recommendation-quality.probes.json`**, one bipolar `pair_id` firing pair per derived clause (MUST-1..MUST-8 and MUST-NOT) plus a meta-compliance pair — read the row/pair counts off the suite, never off this line; registered in `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`; ZERO deferred clauses. Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed. **No Phase-2 row remains for MUST-6** — the deferral above is GRADUATED, not renewed, and the sentence that booked it ("a `PostToolUse(Write)` hook scanning packet files for empty answer-field markers") is withdrawn here because the hook it promised now exists. This edit is scoped to **MUST-6 ONLY**: MUST-7's retirement (`acknowledged_non_deferrals`) and MUST-8's live `deferrals["recommendation-quality.md#must8-sensitivity"]` row are deliberately untouched, and MUST-8's own Wiring block below still correctly books an unbuilt detector.

Depth — the hook marker/anchor list, the fixture breakdown, the false-positive class, the review-layer procedure, the Phase-2 marker set, and the measured detector finding on the MUST-1 probe pair — lives in `.claude/guides/rule-extracts/recommendation-quality.md`.

## Relationship to existing rules — rule-body pointer (moved from the rule body)

The full Extends / Distinct-From map — `communication.md`, `feedback_directive_recommendations.md`, `autonomous-execution.md`, `time-pressure-discipline.md` MUST-3, and the MUST-6-scrub-STACKS-with-MUST-8-confirm treatment of `user-flow-validation.md` — is the extract § "Relationship to existing rules". Read it when adjudicating an overlap.

Origin: MUST-1..5 — 2026-05-06 user directive. MUST-6 — 2026-05-18 (a Rust SDK blank founder packet); self-referential `/codify` per `self-referential-codify.md` Rule 2. MUST-7 — 2026-07-05 SAFR S3 O1 (third autonomy axis), receipt `journal/0434`, convergence `journal/0435`. MUST-8 — 2026-07-05 SAFR S1 O1 (fourth axis), receipt `journal/0436`. All four narratives + the verbatim directives: the extract § "Origin narratives — per-instance provenance".

**Extraction record** (each ZERO de-scoping — every MUST, MUST NOT, BLOCKED entry, DO/DO-NOT block and `**Why:**` line stays here; all 8 canonical Wiring fields keep their normative statements). Four passes, none firing `rule-authoring.md` Rule 10 / Rule 11 (this rule is `scope: path-scoped`): the extract § "Extraction record — 2026-08-19 structural-cleanup extraction".

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Named rationale: **autonomy-axis-completeness scope** — the eight-clause contract (MUST-1..6 core + the two orthogonal autonomy-escalation axes SAFR surfaced, MUST-7 confidence + MUST-8 sensitivity), each clause carrying the DO/DO-NOT + BLOCKED corpus + `**Why:**` the meta-rule mandates. `priority: 10` + `scope: path-scoped`, so it pays NO baseline-emission cost and Rule 10's proximity-band gate does not fire. Enumeration + splitting-cost argument: the extract § "Length rationale — the eight-clause enumeration".
