---
priority: 10
scope: path-scoped
paths:
  - "**/.claude/rules/**"
  - "**/.claude/variants/**/rules/**"
---

# Rule Authoring Meta-Rule

<!-- slot:neutral-body -->

Rules are the agent's linguistic tripwires. This meta-rule defines how all other rules MUST be authored so that each new rule compounds the effect of the existing ones instead of diluting it.

Origin: journal/0052-DISCOVERY-session-productivity-patterns.md §6. Validated by subprocess A/B test: rule quality improved from 2/6 to 6/6 when this meta-rule was loaded. Extended 2026-05-22 (F23a cycle): added MUST Rule 10 + Trust Posture Wiring per journal/0144 § Forest item F23 + analyst FM1. Extended 2026-05-23 (F23b cycle): added MUST Rule 11 (2nd-extraction escalation across (rule, CLI) pairs within 30 days) per journal/0146 § FM-C + journal/0147 + journal/0148 (mid-cycle amendment); Rule 10's "Named-rationale exception — MANDATORY sub-fields" template moved to .claude/skills/skill-authoring/proximity-band-named-rationale-template.md as structural-cleanup improvement (NOT Rule-10 compliance — this rule is path-scoped, so Rule 10's proximity-band gate does NOT fire on rule-authoring.md edits; see journal/0148 § "Lesson learned"). Multi-agent redteam R1 dispositions in journal/0149.

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Rule body is ~304 lines, exceeding the 200-line guidance by ~104. Named rationale: Rule 10 (proximity-band admission gate) requires DO/DO NOT examples + BLOCKED rationalization corpus + Trust Posture Wiring per the meta-rule's own MUST 3 + MUST 4 + MUST 7 + trust-posture.md MUST 8 canonical 8-field shape; collapsing any of those would weaken the structural defense the rule provides. The rule is self-referential — exempting itself from its own length cap requires the same named-rationale-at-Origin shape every other rule uses (sibling precedent: `user-flow-validation.md` Origin + `multi-operator-coordination.md` Origin), which is exactly what this paragraph is.

See `guides/deterministic-quality/01-rule-authoring-principles.md` for full evidence, anti-patterns, and reproduction protocol.

## MUST Rules

### 1. Phrased As Prohibitions, Not Encouragements

Every rule's load-bearing clauses MUST use `MUST` or `MUST NOT`. The words "should," "try to," "prefer," and "consider" are BLOCKED as the primary modal of a rule clause.

```markdown
# DO

### 1. Bulk Ops MUST Log Partial Failures at WARN

# DO NOT

### 1. Bulk Ops Should Log Partial Failures
```

**Why:** "Should" tells the agent it is permitted to skip. Under time pressure, everything permitted to be skipped is skipped. Evidence: gate reviews phrased as "recommended" were skipped 6/6 times in 0052.

### 2. Linguistic Tripwires Enumerate BLOCKED Phrases Verbatim

When a rule targets a behavior the agent is prone to rationalize, it MUST include the exact excuse phrases marked BLOCKED.

```markdown
# DO

**BLOCKED responses:**

- "Pre-existing issue, not introduced in this session"
- "Outside the scope of this change"
- ANY acknowledgement without an actual fix

# DO NOT

Do not defer work. Address issues as you find them.
```

**Why:** Abstract "do not defer" is trivially rationalized. Verbatim blocked phrases block the rationalization at the linguistic level. Subprocess test confirmed: without BLOCKED phrases, agent said "scope creep, leave it alone."

### 3. Every MUST Clause Has DO / DO NOT Examples

Every `MUST` or `MUST NOT` clause MUST include a concrete example showing both the correct and blocked pattern.

**Why:** Without examples, the agent reconstructs meaning from context and gets it wrong at edges. The example is the unambiguous anchor.

### 4. Every MUST Clause Has A `**Why:**` Line

Every `MUST` and `MUST NOT` clause MUST be followed by a `**Why:**` line (2 sentences max) explaining the failure mode the rule prevents.

**Why:** The `Why:` line converts a rote rule into a principle the agent can apply to situations the rule-author never imagined. It also serves as institutional memory when the rule becomes a backstop for a code primitive.

### 5. Rules Are Path-Scoped Unless Classified As Baseline

Every rule with `scope: path-scoped` (Rule 7) MUST include `paths:` YAML frontmatter matching the file patterns where it applies. Rules with `scope: baseline` MUST NOT include `paths:` (baseline rules emit to AGENTS.md / CLAUDE.md always-on). Rules with `scope: skill-embedded` MUST NOT include `paths:` (they are inlined into a skill's SKILL.md, not loaded as standalone rules).

**Why:** Per 0051-DISCOVERY, rules without `paths:` pay full token cost in every session's baseline — which is the correct behavior for CRIT baseline rules (zero-tolerance, security, agents, etc.) and the wrong behavior for everything else. Wide patterns (`**/*.py`) for path-scoped rules are fine; the classification is set by Rule 7's `priority:` + `scope:` pair per v6 §A.1.

### 6. Rule Credits the Originating Journal Entry

Every new rule MUST include a one-line `Origin:` reference pointing to the journal entry or discovery that motivated it.

**Why:** A rule is a frozen response to a past failure. Without provenance, future agents cannot judge whether the rule still applies after the underlying failure mode has been fixed.

### 7. Rule Declares `priority:` And `scope:` In Frontmatter

Every rule MUST declare both `priority:` (0 CRIT baseline / 10 HIGH path-scoped / 20 MED/LOW skill-embedded-or-excluded) and `scope:` (`baseline` / `path-scoped` / `skill-embedded` / `excluded`) in YAML frontmatter. Pair must be consistent: priority:0 requires scope:baseline; priority:10 requires scope:path-scoped + `paths:`; priority:20 pairs with scope:skill-embedded or scope:excluded. `scope: excluded` rules additionally declare `exclude_from: [<cli>, ...]` listing the CLIs the rule is suppressed from (the rule still emits to the other CLIs; "excluded" scopes to specific CLI targets, not wholesale removal). Mismatches are BLOCKED at emission-time validation per v6 §A.1.

**`priority:`/`scope:` describe CC's loading; `cli_delivery:` describes the NON-CC lanes (#408 AC#5-a).** Codex/Gemini have NO `paths:` glob loader, so a `scope: path-scoped` rule that CC loads per-session would be SILENTLY dropped from Codex/Gemini. The OPTIONAL third frontmatter field `cli_delivery: baseline | skill-channel | cc-only` declares how the non-CC lanes deliver the rule — and `.claude/bin/emit.mjs::validateCliDelivery` (Validator 18) enforces that every rule resolves to exactly one lane (no silent drops). The field is OPTIONAL because a **smart default** is derived from `scope:` when it is absent: `scope:baseline → baseline`, `scope:path-scoped → skill-channel` (delivered on-demand via the rules-reference skill, the AC#5-b emitter), `exclude_from:[codex,gemini]` or both-lane `cli_emit_exclusions` → `cc-only`. Declare `cli_delivery:` EXPLICITLY only to override the smart default (e.g. promoting a path-scoped Absolute-Directive rule to `baseline`). `cli_delivery:` is a GLOBAL/neutral field — it is identical across CLI emissions and is NEVER overridden by a per-CLI variant overlay. This follows the SAME parity principle `cross-cli-parity.md` MUST-3 fixes for `priority:`/`scope:` (a rule's classification cannot diverge per CLI); MUST-3 does not yet enumerate `cli_delivery:` by name, but the invariant is identical and Validator 18 reads only the global rule body (overlays carry no `cli_delivery:`).

DO — baseline CRIT rule frontmatter:

    priority: 0
    scope: baseline

DO — path-scoped HIGH rule frontmatter:

    priority: 10
    scope: path-scoped
    paths:
      - "**/packages/**"

DO — excluded rule (CC-only):

    priority: 20
    scope: excluded
    exclude_from: [codex, gemini]

DO — path-scoped rule, explicit non-CC lane (optional; this IS the smart default):

    priority: 10
    scope: path-scoped
    cli_delivery: skill-channel
    paths:
      - "**/*.py"

DO NOT — explicit cli_delivery contradicting scope (Validator 18 BLOCKS):

    priority: 10
    scope: path-scoped
    cli_delivery: baseline
    # ← baseline is the always-on file; a path-scoped rule cannot claim it.
    #   Promote scope:baseline (+ paired extraction per Rule 10) to go baseline.

DO NOT — missing priority or mismatched pair:

    paths:
      - "**/*.py"
    # ← no priority; emitter falls back to filename heuristic → drift
    priority: 0
    scope: path-scoped
    # ← CRIT baseline cannot be path-scoped; emission validator blocks

**BLOCKED rationalizations:**

- "The emitter can infer priority from the filename"
- "`paths:` being present is enough signal"
- "I'll add priority when the emitter needs it"
- "The combo `priority: 0` + `scope: path-scoped` is harmless"
- "scope is implied by priority, declaring both is redundant"
- "Path-scoped rules don't need a non-CC lane — Codex/Gemini can do without them"
- "I'll set `cli_delivery: baseline` to force it always-on without the paired extraction"
- "The smart default might be wrong but the validator will sort it out at /sync"

**Why:** Priority drives which CLI surface the rule emits to (baseline AGENTS.md/CLAUDE.md vs path-scoped vs skill-embedded); scope drives which emission mechanism applies. Without both, the emitter classifies by filename heuristic — which is exactly how the v2→v6 convergence rounds repeatedly surfaced "phantom rules" and "surplus rules" findings. Declaring both lets the v6 §A.1 validator catch mismatches at author time rather than at /sync time when the damage has already propagated to downstream USE templates. The `cli_delivery:` third field closes the same class one lane over: a path-scoped rule with no `paths:` loader on Codex/Gemini is silently absent there unless its non-CC lane is declared or smart-defaulted — Validator 18 enforces that every rule resolves to exactly one lane, and an explicit `cli_delivery:` that contradicts `scope:` (e.g. `baseline` on a path-scoped rule, which would bypass the Rule 10 paired-extraction budget gate) is BLOCKED.

### 8. Rule Uses Slot Markers For CLI-Divergent Content

Rules with CLI-specific content (delegation syntax, tool names, native-primitive references) MUST partition that content into slot-marker blocks per v6 §3.1: `<!-- slot:neutral-body -->...<!-- /slot:neutral-body -->`, `<!-- slot:examples -->...<!-- /slot:examples -->`, `<!-- slot:origin-extended -->...<!-- /slot:origin-extended -->`. Markers anchor at column 0, outside fenced code blocks. CLI variant overlays at `variants/<cli>/rules/<rule>.md` supply replacement bodies only for the slots that diverge.

DO — neutral body carries the MUST clause, examples slot carries the CC syntax (overlay replaces on emit):

    <!-- slot:neutral-body -->
    Every specialist delegation MUST include the relevant spec files.
    <!-- /slot:neutral-body -->

    <!-- slot:examples -->
    Agent(subagent_type="dataflow-specialist", prompt="...")
    <!-- /slot:examples -->

DO NOT — bake CC-specific syntax into the neutral body:

    Every specialist delegation MUST use Agent(subagent_type=...) with
    the relevant spec files.
    # ↑ Codex uses codex_agent(...); Gemini uses @specialist — this rule
    # is now CC-only by accident; cross-cli-parity drift audit hard-blocks.

**BLOCKED rationalizations:**

- "Most users are on CC; the example covers 95% of cases"
- "Slot markers add ceremony for one CLI-specific example"
- "The emitter can strip CC syntax for Codex/Gemini automatically"

**Why:** Without slot markers the neutral body carries CLI-specific syntax that silently weakens the rule on the other two CLIs — a MUST clause with a CC-only example gets read as "only applies on CC." The slot mechanism is the single structural defense against per-CLI drift; the `parity_enforcement.cross_cli_drift_audit` validator checks neutral-body byte-identity and can only do so when the slots exist.

### 9. Empirical-Validation Fixtures Reproduce The Originating Incident's Conditions

When a rule's Origin (Rule 6) names ≥1 specific incident AND the rule ships empirical-validation fixtures (subprocess A/B, ablation, probe), each fixture MUST reproduce the incident's conditions — NOT an idealized version where the agent has already been told what to look for. Authors MUST enumerate incident conditions before scenario design and reject any fixture that drops one without rationale in the fixture's `_doc`.

DO — fixture conditions match the incident (Phase I1: no in-prompt anchor, no inlined brief, lower-option anchor-status NOT declared, tempting `feedback_*.md` memory in scope → all four reproduced).

DO NOT — F-1.5 S7-S10 inlined "(b) has no user-anchored source" AND materialized a brief that disqualified (b); both short-circuit the streetlight-fittability fallback the rule defends. The incident had neither.

**BLOCKED rationalizations:** "Close enough" / "Idealizing makes the test cleaner" / "Harder fixtures later" / "Current differential is the signal" / "Incident was an edge case."

**Why:** A rule's empirical claim is a research artifact distinct from its enforcement clauses (per `value-prioritization.md` § Origin "Empirical-claim status"). When fixtures don't reproduce the originating incident, the empirical claim measures something the incident wasn't, and every cycle's pass-rate drifts further from what the rule defends against. Evidence: F-1 (5 cycles) + F-1.5 (1 cycle) on `value-prioritization.md` never reached the Failure-A pattern because each fixture removed one Phase I1 condition; F-2.0 (#100) is corrective.

### 10. Baseline-Priority Rule Additions Within Proximity-Band Require Extraction Or Exception

When a `/codify` proposal adds NEW load-bearing content (MUST clause, MUST NOT clause, BLOCKED corpus entry, multi-paragraph Origin) to a rule with `priority: 0` + `scope: baseline` AND the current CLI emission for that rule's lane-of-concern is within 15% of the per-CLI headroom floor (i.e., `headroom_pct < 15%` per any cli×lang combo computed by `.claude/bin/emit.mjs::validateAggregateHeadroom`), the proposal MUST EITHER (a) ship the addition paired with an extraction-to-skill that recovers AT LEAST the bytes added on the lane-of-concern's emission, OR (b) carry a named-rationale budget exception in the proposal's receipt journal explaining why the addition is structurally non-decomposable AND why the lane-of-concern's near-breach is acceptable for THIS addition. Adding NEW load-bearing content without (a) or (b) is BLOCKED.

```markdown
# DO — paired extraction recovers the bytes added

Proposal: add MUST clause to security.md (~400 B added to rs-codex).
rs-codex pre-proposal: 10.64% headroom (within 15% proximity band).
Pair with: extract security.md § "Multi-Site Kwarg Plumbing" detail to
`skills/30-claude-code-patterns/kwarg-plumbing-discipline.md` (~500 B
recovered from rs-codex). Net rs-codex change: ~-100 B, headroom RISES.

# DO — named-rationale exception in receipt journal

Proposal: add MUST clause to security.md (~400 B added to rs-codex).
rs-codex pre-proposal: 10.64% headroom (within 15% proximity band).
Receipt journal § "F23 proximity-band exception": "this MUST clause
codifies a CVE-class vulnerability with no decomposable sub-content;
the rs-codex near-breach is acceptable because (a) the next CRIT-rule
addition cycle is unlikely within 30 days, (b) F23b 2nd-extraction
escalation will fire if rs needs another cut, (c) no skill-extension
host file exists for this specific failure mode yet."

# DO NOT — silent addition that consumes near-breach margin

Proposal: add MUST clause to security.md (~400 B added to rs-codex).
rs-codex pre-proposal: 10.64% headroom.
Receipt journal: (no proximity-band acknowledgement). Post-proposal
rs-codex: 9.99% — below 10% floor. /sync rs BLOCKS. Next session
must fire another F20-style extraction cycle to unblock.
```

**BLOCKED rationalizations:**

- "The addition is small (~100 B), it won't breach"
- "rs is the closest lane; py is fine"
- "We'll extract later if it breaches"
- "F20 already extracted, we have margin"
- "The MUST clause is critical, extraction is overhead"
- "Named rationale is bureaucracy"
- "15% is arbitrary"
- "I'll trim something else to make room"
- "The headroom-floor BLOCK will catch it at /sync"
- "We're at 10.64%, that's 64 basis points of margin"

**Why:** The wallpaper-risk failure mode (analyst FM6 per journal/0144 § "For Discussion #2") is every floor breach getting silently resolved by extraction, masking that the rule corpus is growing faster than the per-CLI emission strategy sustains. The 15% proximity band converts the implicit at-/sync-time BLOCK (which fires after burned cycle time) into an explicit at-author-time admission gate — extract-paired OR named-rationale OR BLOCKED.

**"NEW load-bearing content" disambiguation.** Extending an existing `**BLOCKED rationalizations:**` corpus by ≥1 new phrase IS new load-bearing content (each enumerated phrase is the linguistic tripwire MUST 2 mandates; adding one is a new tripwire). Reordering or rephrasing existing entries WITHOUT adding new ones is NOT. Edits that rewrite a `**Why:**` line WITHOUT introducing a new failure-mode claim are NOT. Appending a new paragraph to Origin that documents a same-class incident is NOT (extends provenance, not load-bearing surface); appending a new clause to Origin that ASSERTS a new structural defense (e.g., "and the rule additionally fires on X") IS. Edge cases at the boundary resolve in favor of the gate firing — fail-closed per `cc-artifacts.md` Rule 10 positive-allowlist principle (Phase-1 false-positive cost is bounded to one extra extraction-or-exception step; Phase-1 false-negative cost is the wallpaper failure mode).

**Trigger scope.** Rule 10 fires on `priority: 0` + `scope: baseline` rules ONLY. Path-scoped rules (`scope: path-scoped`, including this file itself) do NOT contribute to baseline emission and are NOT covered by Rule 10's proximity-band gate — their context cost is paid only in sessions matching their `paths:` glob, NOT in every session's baseline AGENTS.md / CLAUDE.md. Rule 10 governs baseline-emission accounting, not generic rule sizes.

**Composite + new-rule additions.** When a single `/codify` proposal touches MULTIPLE baseline rules, Rule 10 compliance is evaluated PER RULE (each touched baseline rule needs paired extraction OR named-rationale exception on its OWN load-bearing additions; aggregate compliance is BLOCKED — a single big extraction cannot "cover" additions across N rules). When a proposal ADDS a brand-new `priority: 0` + `scope: baseline` rule entirely, Rule 10 fires AS IF the entire rule body were "new load-bearing content" — the proposal MUST EITHER (a) ship the new rule paired with extraction recovering ≥ the new rule's emission bytes on any near-breach lane, OR (b) carry a named-rationale exception (per the MANDATORY sub-fields below) documenting why the new rule cannot be authored as path-scoped + why the near-breach is acceptable.

**Named-rationale exception — sub-field template.** Path (b) (named-rationale budget exception in the receipt journal) MUST follow the 5-sub-field template at `.claude/skills/skill-authoring/proximity-band-named-rationale-template.md` § "Mandatory Sub-Fields For Path (b)". Missing any sub-field is BLOCKED; cc-architect's mechanical sweep at `/codify` validates field presence against the depth-file. Path (a) (paired extraction) requires only verifiable byte recovery; path (b) requires the structured rationale because it's the only path that ADDS net bytes to a near-breach lane.

### 11. Recurrent Rule-10 Invocations On The Same (Rule, CLI) Pair Within 30 Days Escalate To Corpus Review

When `/codify` proposes Rule-10-gated content addition (path (a) paired extraction OR path (b) named-rationale exception) on a (rule, CLI) lane that has ALREADY been the target of ≥1 Rule-10-MANDATED invocation within the prior 30 calendar days (see "Recurrence-window scope" below for the strict-counting predicate), the proposal MUST EITHER (a') escalate to corpus-level pruning review (open a forest item evaluating whether the rule should be split into sibling rules sharing a glob, demoted from `scope: baseline` to `scope: path-scoped`, OR replaced by a skill + compact rule-body pointer), OR (b') carry a named-rationale exception in the receipt journal containing the 5 sub-fields from Rule 10's path (b) PLUS a sixth sub-field (vi) detailed in `.claude/skills/skill-authoring/proximity-band-named-rationale-template.md` § "Rule 11 Sub-Field (vi)". Proceeding with a 2nd Rule-10-mandated invocation on the same (rule, CLI) pair within 30 days WITHOUT (a') or (b') is BLOCKED.

```markdown
# DO — 2nd extraction on same (rule, CLI) pair escalates to corpus review

Proposal: add MUST clause to security.md (~400B on codex rs).
Prior Rule-10 invocation: journal/0146 (F23a, 2026-05-22, codex rs paired extraction).
Time-delta: 1 day < 30d. Rule 11 fires.
Disposition (a'): open forest item F25 "evaluate security.md split into
sibling rules security-network.md + security-credentials.md (both
path-scoped to packages/**/src/auth/** + packages/**/src/network/**)."

# DO NOT — silent 2nd Rule-10 invocation on the same (rule, CLI) pair

Prior Rule-10 invocation 5 days ago on codex rs (named-rationale exception).
Now propose another codex rs path (a) paired extraction.
Receipt journal: (no Rule 11 acknowledgement; no prior-invocation citation).
(BLOCKED — wallpaper-risk per analyst FM-C: the pattern says this rule's
per-CLI emission strategy is over-budget for that lane, not that this
particular addition is heavy.)
```

**BLOCKED rationalizations:**

- "The first invocation was small, this is the actual structural change"
- "Different content, same lane is coincidence"
- "Path (a) recovers bytes; no harm repeating it"
- "30 days is arbitrary"
- "Path (b)'s sub-field (iv) already cites F23b; that satisfies Rule 11"
- "Corpus-level review is too heavy for a 200B addition"
- "We can keep applying Rule 10 indefinitely as long as each invocation balances"
- "The prior invocation proves this rule needs another exception" (tautological self-reference)
- "Rapid-iteration on this rule is itself the rationale" (recurrence is exactly the signal Rule 11 catches)
- "The prior journal entry's named-rationale generalizes to this one" (named-rationale is per-invocation, not transitive)
- "Renaming the rule (`security.md` → `security-core.md`) reset the count" (rename without (a') is structurally indistinguishable from sanctioned split per FM-D)

**Why:** Without Rule 11, Rule 10 becomes the wallpaper itself — every breach is silently relieved by extraction-or-exception, and the per-CLI emission strategy never adapts to corpus density growth. The right disposition for the cumulative-pattern signal is corpus-level (split / demote / extract-to-skill+pointer), not addition-local.

**Analyst FM-C anchor** (`journal/0146` § FM-C verbatim): _"necessary-but-not-sufficient: FM1 catches NEW additions; FM6 catches cumulative extract patterns the FM1-gate doesn't see."_ Rule 10 catches the SINGLE-EVENT signal (a NEW addition crowds a near-breach lane; local disposition). Rule 11 catches the CUMULATIVE-PATTERN signal: when the same (rule, CLI) pair triggers the relief valve twice within 30 days, the underlying signal is no longer "this addition is heavy" but "this rule's per-CLI emission strategy is structurally over-budget for that CLI."

**Recurrence-window scope.** Rule 11 counts ONLY Rule-10-MANDATED invocations — proposals where the touched rule was `priority: 0` + `scope: baseline` at time-of-invocation AND the proposal added NEW load-bearing content within the 15% proximity band, triggering Rule 10's gate. Structural-cleanup extractions on path-scoped rules do NOT count, even if their journal entries contain "Rule-10 disposition" anchor language (e.g., `journal/0147` corrected by `journal/0148` — `rule-authoring.md` is `priority: 10` + `scope: path-scoped`, so Rule 10 did NOT fire and the extraction is NOT Rule-11 input). The 30-day window is rolling, calendar-day-based, anchored at the proposal's receipt journal date. Rule-10 invocations PRE-DATING this rule's landing are NOT counted (clock bootstraps at land-time per `trust-posture.md` § Two-Phase Rollout). The cc-architect's Phase-1 sweep MUST verify each grep-matched journal entry against the touched rule's frontmatter `scope:` field at the entry's date — entries on path-scoped rules are discarded as false-positives.

**Forest-item composition.** When Rule 11 fires AND the proposal takes disposition (a') corpus-level review, the forest item filed MUST name (i) which of the four corpus-level dispositions is recommended (split / demote / extract-to-skill+pointer / per-CLI emission strategy change), (ii) at least one alternative disposition considered and the reason it was rejected, (iii) the receipt-journal cross-reference for both Rule-10 invocations that triggered this Rule 11 firing, AND (iv) a `value-prioritization.md` MUST-2 value-anchor citing a user-anchored source (from the MUST-1 closed allowlist: user's brief, `briefs/`, journal DECISION entry, literal user quote, or user-authored spec § success criterion) explaining why this corpus-level disposition delivers value to the user — NOT just to code-health calculus. Filing a generic "evaluate this rule" forest item without ALL of (i)-(iv) is BLOCKED, AND constitutes a `value-prioritization.md` MUST-4 OR-escape-hatch (an unanchored deferred shard substituting cheap proxy for load-bearing escalation). Rule 11's path (a') MUST produce actionable signal with user-anchored value, not a deferred discussion placeholder.

## MUST NOT

- Rationale paragraphs longer than 2 sentences per `Why:` line

**Why:** Long rationale crowds the rule's load-bearing clauses out of working memory.

- Hedging phrases ("in most cases," "generally speaking") in a MUST clause

**Why:** Hedging converts a MUST into a should and reintroduces permission-to-skip.

- Rules longer than 200 lines

**Why:** Rules longer than 200 lines are skimmed AND over-density degrades the output of the agent that loads the artifact — not just its token budget (journal/0193, directional: a dense rule-slice dropped a consuming agent's plan 93→82, and curated-minimal beat verbose more as the model weakened). Curation — minimal load-bearing clauses, depth extracted to a guide/skill — is therefore an OUTPUT-QUALITY requirement, not only budget hygiene; the injection-time complement is `rules/governed-throughput.md`.

## The "Loud, Linguistic, Layered" Test

Before committing any new rule, verify:

1. **Loud** — can the rule be ignored by quoting a standard excuse phrase? If yes, add that phrase to the BLOCKED list.
2. **Linguistic** — does the rule target wording the agent might use, not just behavior? If no, rewrite.
3. **Layered** — at which load layer does the rule fire? If session-start for a non-universal rule, add `paths:`.

Rules that fail any check MUST be revised before merging.

## Trust Posture Wiring

Applies to MUST Rules 10 (added 2026-05-22, F23a cycle) and 11 (added 2026-05-23, F23b cycle). MUST Rules 1-9 of this file predate the `trust-posture.md` MUST-8 SHA and remain grandfathered per that rule's cutoff clause until each Rule's next `/codify`-touched edit. Rules 10 and 11 land AT/AFTER that SHA, so both MUST ship canonical 8-field-template-compliant (Severity / Grace period / Cumulative posture impact / Regression-within-grace / Receipt requirement / Detection mechanism / Violation scope / Origin, in that order). The two rules share most fields; per-rule deltas are called out explicitly below.

- **Severity:** Rule 10 — `halt-and-report` at gate-review (cc-architect mechanical sweep at `/codify` proposal validation against the 15% proximity-band check); `advisory` at the `emit.mjs` layer (the `validateAggregateHeadroom` advisory band warning at `headroom_pct < 15%`, per `hook-output-discipline.md` MUST-2 — structural numeric signal MAY carry advisory, BLOCK stays anchored at the 10% floor). Rule 11 — `halt-and-report` at gate-review (cc-architect mechanical sweep at `/codify` for prior-Rule-10-invocation count per (rule, CLI) lane within 30 days); NO `emit.mjs`-layer advisory (Rule 11's signal is journal-history-based, not per-emission).
- **Grace period:** Rule 10 — 7 days from rule landing (2026-05-22 → 2026-05-29). Rule 11 — 7 days from rule landing (2026-05-23 → 2026-05-30).
- **Cumulative posture impact:** Rule 10 same-class violations (baseline-priority rule addition within 15% proximity band without paired extraction OR named-rationale exception) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture). Rule 11 same-class violations (2nd Rule-10 invocation on the same (rule, CLI) lane within 30 days without disposition (a') corpus review or (b') sixth-sub-field named-rationale) contribute under the same MUST-4 cumulative math.
- **Regression-within-grace:** Rule 10 — any same-class violation within 7 days of Rule 10 landing triggers emergency downgrade L5→L4 per `trust-posture.md` MUST Rule 4. Trigger key `proximity_band_admission_bypass` (already on that rule's emergency-trigger list; 1× = drop 1 posture). Rule 11 — any same-class violation within 7 days of Rule 11 landing triggers emergency downgrade. NEW trigger key `recurrent_extraction_escalation_bypass` added to `trust-posture.md` MUST-4 emergency-trigger list (1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: rule-authoring]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id. Both Rules 10 and 11 share the same `rule-authoring` rule_id; a single ack covers both.
- **Detection mechanism:** Phase 1 — review-layer mechanical sweep at `/codify` proposal validation. **Rule 10 sweep**: cc-architect runs `node .claude/bin/emit.mjs --all --dry-run` against the proposal's working tree (note: a proposal that ALSO modifies `emit.mjs` triggers a separate self-referential-codify Rule 1 redteam round FIRST; the proximity-band sweep then runs against the post-redteam-approved emit.mjs to avoid trust-of-trust circularity). The sweep then (a) parses the emit-report output for `headroom_pct < 15%` rows; (b) checks whether the proposal's diff against any `priority: 0` baseline rule contains NEW MUST/MUST NOT/BLOCKED additions on a near-breach lane; (c) for path (b) named-rationale exceptions in the receipt journal, validates the 5 sub-fields at `.claude/skills/skill-authoring/proximity-band-named-rationale-template.md` AND greps the exception text against the Rule 10 BLOCKED-rationalization corpus — any phrase match HALTS the sweep (an exception text that quotes a BLOCKED rationalization IS a structural bypass attempt); (d) emits a durable receipt to the receipt journal under `§ F23a proximity-band sweep` recording: emit dry-run exit code, per-lane headroom_pct (codex + gemini × py + rs + base), advisory_fired booleans, presence/absence of paired extraction OR named-rationale, BLOCKED-corpus grep verdict. **Rule 11 sweep** (runs ONLY when Rule 10 fires): cc-architect greps `journal/*.md` for prior journal entries citing "Rule-10 disposition" (or equivalent path (a) / path (b) anchor language) AND naming the same (rule, CLI) lane as the current proposal; for each grep-match, the sweep MUST verify the touched rule's frontmatter `scope:` at the entry's date was `baseline` (entries on path-scoped rules are discarded as Rule-10-NOT-mandated false-positives — see "Recurrence-window scope" above). For each verified-mandated match, parses the entry's frontmatter `date:` field; counts matches with date within 30 calendar days of the current proposal's receipt-journal date. Count ≥1 → Rule 11 fires; cc-architect demands disposition (a') corpus-level forest item with ALL FOUR mandatory sub-elements ((i)-(iv) including the `value-prioritization.md` MUST-2 user-anchored value-anchor) OR disposition (b') named-rationale with sub-field (vi) per `.claude/skills/skill-authoring/proximity-band-named-rationale-template.md` § "Rule 11 Sub-Field (vi)" (three elements: (vi.a) verbatim-cite prior invocation, (vi.b) anti-tautology structural-necessity, (vi.c) named corpus-disposition rejection). Verdicts MUST cite the matching journal entry per `verify-resource-existence.md` MUST-4. Phase 2 automation (`.claude/bin/validate-extraction-history.mjs`) is deferred per `trust-posture.md` § Two-Phase Rollout (tracked as F23b-Phase-2 in the forest); structural Phase-1 → Phase-2 closure trigger fires after ≥3 real Rule-11 invocations exercise the manual sweep. Audit fixtures for both Rules 10 and 11 committed at `.claude/audit-fixtures/proximity-band-budget/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** Rule 10 — rule + lane (per-rule + per-CLI emission combo). Rule 11 — rule + lane + window (per-rule + per-CLI emission combo + the 30-day recurrence window). Every violation row in `violations.jsonl` records the touched rule, the breaching cli×lang combo, and (for Rule 11) the prior-invocation journal entry ID + days-since-prior delta.
- **Origin:** Rule 10 — `journal/0144` § "Forest items" F23 (analyst FM1+FM6 paired in `journal/0144`; Rule 10 lifts FM1 — the proximity-band admission gate). Rule 11 — `journal/0144` § FM6 (original framing) + `journal/0146` § FM-C (analyst's ELEVATION receipt: _"necessary-but-not-sufficient: FM1 catches NEW additions; FM6 catches cumulative extract patterns the FM1-gate doesn't see"_) + `journal/0147` (this codify's receipt-first DECISION entry). F23b closes the FM6 forest deferral originally opened by F23a's shard-budget discipline.

<!-- /slot:neutral-body -->
