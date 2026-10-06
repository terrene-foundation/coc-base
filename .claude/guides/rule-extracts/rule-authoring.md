# Rule Authoring — Depth Extract

Depth companion to `.claude/rules/rule-authoring.md`. The rule body carries the complete normative contract — MUST Rules 1–11, the MUST NOT bullets, every BLOCKED-rationalization corpus, every DO/DO-NOT block, every `**Why:**` line, and the Trust-Posture-Wiring block with all eight canonical fields. This file carries what is EVIDENCE, PROVENANCE or MECHANISM rather than obligation.

Read it when adjudicating a Rule-10 or Rule-11 disposition at `/codify`, when authoring the `cli_delivery:` lane for a new rule, or when tracing why a clause here says what it says.

## Origin — Provenance Chain

Moved from the rule's opening `Origin:` line and its `- **Origin:**` Wiring field 2026-09-13. The rule keeps the originating journal reference, the subprocess A/B validation result, and the two extension dates.

- **Rule 10** (added 2026-05-22, F23a cycle) — `journal/0144` § "Forest items" F23. Analyst FM1 and FM6 were paired in `journal/0144`; Rule 10 lifts FM1, the proximity-band admission gate. The same cycle added the Trust Posture Wiring block.
- **Rule 11** (added 2026-05-23, F23b cycle) — `journal/0144` § FM6 (original framing) + `journal/0146` § FM-C (the analyst's ELEVATION receipt) + `journal/0147` (that codify's receipt-first DECISION entry) + `journal/0148` (mid-cycle amendment). F23b closes the FM6 forest deferral originally opened by F23a's shard-budget discipline.
- **Multi-agent redteam R1 dispositions** — `journal/0149`.
- **Sub-field-template relocation** — Rule 10's "Named-rationale exception — MANDATORY sub-fields" template moved to `.claude/skills/skill-authoring/proximity-band-named-rationale-template.md` as a structural-cleanup improvement. That relocation was explicitly NOT Rule-10 compliance: `rule-authoring.md` is `priority: 10` + `scope: path-scoped`, so Rule 10's proximity-band gate does NOT fire on edits to this file. See `journal/0148` § "Lesson learned".

## Length Rationale

Moved from the rule's `**Length rationale**` paragraph 2026-09-13. The rule keeps the named rationale itself (which structural elements Rule 10 requires, and why collapsing any of them would weaken the defense).

The rule is self-referential — exempting itself from its own length cap requires the same named-rationale-at-Origin shape every other rule uses. Sibling precedent: `security.md` § Length rationale, `recommendation-quality.md` § Length rationale, `artifact-flow.md` § Length rationale.

## The `cli_delivery:` Lane Field

Moved from MUST Rule 7's `cli_delivery:` paragraph 2026-09-13. The rule keeps the field's purpose, its three values, Validator 18's no-silent-drops enforcement, the existence of the smart default, and the GLOBAL/neutral parity property.

**The smart default, derived from `scope:` when `cli_delivery:` is absent:**

- `scope: baseline` → `baseline`
- `scope: path-scoped` → `skill-channel` (delivered on-demand via the rules-reference skill, the #408 AC#5-b emitter)
- `exclude_from: [codex, gemini]`, or both-lane `cli_emit_exclusions` → `cc-only`

**Why the parity invariant holds even though `cross-cli-parity.md` MUST-3 does not name the field.** MUST-3 fixes that a rule's `priority:`/`scope:` classification cannot diverge per CLI. It does not yet enumerate `cli_delivery:` by name, but the invariant is identical and is structurally guaranteed: Validator 18 reads only the GLOBAL rule body, and variant overlays carry no `cli_delivery:` key at all, so there is no surface on which the value could diverge.

## Rule 9 — The Fixture-Drift Evidence

Moved from Rule 9's `**Why:**` line 2026-09-13. The rule keeps the failure-mode statement (a fixture that does not reproduce the incident measures something the incident was not).

F-1 (5 cycles) + F-1.5 (1 cycle) on `value-prioritization.md` never reached the Failure-A pattern, because each fixture removed one Phase I1 condition. F-2.0 (#100) is corrective.

## Rule 10 — The Measured Accretion

Moved from Rule 10's § "UNCONDITIONAL — headroom is NOT a precondition" 2026-09-13. The rule keeps the unconditional obligation and the statement that waiting for a lane to approach its floor IS the accretion path.

Measured 2026-08-04 → 2026-09-01: the baseline rule COUNT stayed flat at 11 while mean bytes/rule rose 9,614 → 13,482 (+40%) — all of it accreting INSIDE the existing eleven, while every lane still showed room. That is the shape the unconditional reading exists to catch: a per-lane headroom gate would have fired on none of it.

## Rule 10 — The Fail-Closed Boundary

Moved from Rule 10's § "NEW load-bearing content" disambiguation 2026-09-13. The rule keeps the fail-closed disposition itself.

The asymmetry is what makes fail-closed correct here: the Phase-1 false-POSITIVE cost is bounded to one extra extraction-or-exception step, while the Phase-1 false-NEGATIVE cost is the wallpaper failure mode — unbounded, and invisible until a lane breaches.

## Rule 10 — Sweep Ordering And Receipt Fields

Moved from the Trust-Posture-Wiring `**Detection mechanism:**` field 2026-09-13. The rule keeps the sweep's (a)–(d) steps, the BLOCKED-corpus grep that HALTS on a phrase match, and the receipt's existence.

**Ordering — why the emit.mjs self-reference runs first.** A proposal that ALSO modifies `emit.mjs` triggers a separate `self-referential-codify.md` Rule 1 redteam round FIRST; the proximity-band sweep then runs against the post-redteam-approved `emit.mjs`. Running it the other way round would make the sweep's verdict depend on an unreviewed copy of the tool producing it — trust-of-trust circularity.

**Receipt fields recorded under `§ F23a proximity-band sweep`:** the emit dry-run exit code; per-lane `headroom_pct` (codex + gemini × py + rs + base); the `advisory_fired` booleans; presence/absence of paired extraction OR named-rationale; and the BLOCKED-corpus grep verdict.

**Rule 11 sub-field (vi)'s three elements** (full template at `.claude/skills/skill-authoring/proximity-band-named-rationale-template.md` § "Rule 11 Sub-Field (vi)"): (vi.a) verbatim-cite the prior invocation; (vi.b) anti-tautology structural-necessity; (vi.c) named corpus-disposition rejection.

## Rule 11 — The Analyst FM-C Anchor

Moved from Rule 11's § "Analyst FM-C anchor" 2026-09-13. The rule keeps the single-event-vs-cumulative-pattern distinction the anchor grounds.

`journal/0146` § FM-C, verbatim: _"necessary-but-not-sufficient: FM1 catches NEW additions; FM6 catches cumulative extract patterns the FM1-gate doesn't see."_

## Rule 11 — Recurrence-Window False Positives

Moved from Rule 11's § "Recurrence-window scope" 2026-09-13. The rule keeps the counting predicate (only Rule-10-MANDATED invocations count) and the frontmatter-`scope:`-at-date verification the sweep performs.

Worked example: `journal/0147` was corrected by `journal/0148`. `rule-authoring.md` is `priority: 10` + `scope: path-scoped`, so Rule 10 did NOT fire on that extraction and the entry is NOT Rule-11 recurrence input — even though its text carries "Rule-10 disposition" anchor language that a naive grep matches.

## Over-Density Degrades Output

Moved from the MUST NOT § "Rules longer than 200 lines" `**Why:**` line 2026-09-13. The rule keeps the output-quality claim and the `governed-throughput.md` cross-reference.

`journal/0193` ablation, directional rather than powered: a dense rule-slice dropped a consuming agent's plan score 93 → 82, and curated-minimal beat verbose — more so as the model weakened.

## Extraction Record

**2026-09-13 paired extraction (rule 37,700 B → 33,854 B).** This companion did not exist before; it was created by this pass. Moved here: the Origin provenance chain, the length-rationale self-reference argument, the `cli_delivery:` smart-default table and parity reasoning, the Rule-9 fixture-drift evidence, the Rule-10 measured accretion and fail-closed cost argument, the Rule-10 sweep ordering + receipt-field list + sub-field (vi) elements, the Rule-11 FM-C verbatim anchor and recurrence-window worked example, the over-density ablation figures, and the probe-suite registration narrative from the Detection-mechanism field.

Every counted enforcement token was held flat across the pass — `must_clause` 4, `must_token` 81, `must_not_token` 9, `blocked_token` 27, `why_line` 15, and all eight canonical Wiring fields at 1 apiece — so `check-descoping.mjs` records no negative delta on any class.

`rule-authoring.md` Rule 10 / Rule 11 do NOT fire on this pass: Rule 10 § "Trigger scope" binds `priority: 0` + `scope: baseline` rules ONLY, and this rule is `priority: 10` + `scope: path-scoped`. The pass is STRUCTURAL CLEANUP, not a Rule-10 paired extraction, and therefore not Rule-11 recurrence input — the same disposition `journal/0148` § "Lesson learned" recorded for the earlier sub-field-template relocation.

## Probe Suite — Registration Narrative

Moved from the Trust-Posture-Wiring `**Detection mechanism:**` field 2026-09-13. The rule keeps the suite path, the row/pair counts, the manifest + `PINNED_SUITES` registration, the per-clause candidate-type mapping, and the registration-buys-dispatchability semantics.

**Why the firing pairs are not a thirteenth copy of the meta pair, and why the distinction is load-bearing for THIS rule specifically.** Every other suite in the corpus carries a meta-compliance pair graded AGAINST this rule, which asks holistically whether an invented-topic rule honours the whole meta-rule set. Each firing pair here instead ISOLATES ONE clause: the violating pole breaches that clause and SATISFIES its eleven neighbours, so a judge citing a neighbour has named the wrong clause and the pair has measured nothing.

**What each candidate type is, and why.** MUST-1..MUST-7 and the MUST NOT section are properties OF THE ARTIFACT (modal, corpus content, example arms, justification line, frontmatter, Origin, Detection-row honesty), so their poles are complete synthetic rule files. MUST-9, MUST-10 and MUST-11 are properties of WHAT THE AUTHOR DID (whether the incident's conditions were enumerated before scenario design, which budget disposition was taken, whether the recurrence window was read) — none of which is in any file — so their poles are session transcripts carrying their own tool calls.

**MUST-8's transcript form is a MEASURED necessity, not a preference.** The harness's answer-key fence rejects any candidate containing an HTML comment, and slot markers ARE HTML comments, so a compliant artifact snapshot showing a slot partition is unrepresentable. The poles instead grep for the marker names.

**A correction kept rather than overwritten.** An earlier revision of the Detection row said the suite was NOT YET AUTHORED and pointed at a `probe_authorship_deferrals` entry. That was true when written and is now FALSE; it was corrected in place rather than left standing, because a Detection row claiming an absent tier is the same absence-reads-as-clean shape this meta-rule governs.

**Execution semantics.** No workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed — they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at gate-review. Consumer note: `.claude/test-harness/**` is never-synced, so no consumer receives this suite and enforcement at those targets is gate-review.

**The shipped Phase-2 half.** `.claude/bin/validate-extraction-history.mjs` is 617 lines — the Rule-11 mechanical sweep: date parsing, git-log rename detection, frontmatter-scope verification. Its fixtures at `.claude/audit-fixtures/validate-extraction-history/` were measured 19/19 pass at registration. What REMAINS deferred is only its promotion from a CI-run sweep to a HARD `/codify` gate, whose stated trigger is ≥3 real Rule-11 invocations exercising the manual sweep — a threshold no journal record yet shows crossed.
