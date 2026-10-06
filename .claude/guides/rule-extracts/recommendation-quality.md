# recommendation-quality.md — Extended Examples (MUST-6) + Detection Detail

Companion extract for `.claude/rules/recommendation-quality.md`. The rule carries
full inline examples for MUST-1..5; MUST-6 ships compact in the rule body with
its extended DO / DO NOT decision-packet examples and detection-mechanism prose
here (per `rule-authoring.md` 200-line ceiling — reference material extracted).

## MUST-6 — "The Human Decides" Means Ratify, Not Fill A Blank

### Packet shape — recommendation-carrying vs blank menu

```markdown
# DO — every question carries a recommendation; the human ratifies

| Q   | Recommendation (spec basis)          | Honest con       | Your call         |
| --- | ------------------------------------ | ---------------- | ----------------- |
| Q1  | Opaque UUID id (substrate is opaque) | needs a dir join | RATIFY / OVERRIDE |

# DO NOT — blank menu handed to the human to fill from scratch

| Q   | Question                  | → ANSWER: |
| --- | ------------------------- | --------- |
| Q1  | Identity = tuple or UUID? |           |

(prose: "the agent does NOT pre-fill")

# DO NOT — punt disguised as a recommendation cell

| Q   | Recommendation      | Your call         |
| --- | ------------------- | ----------------- |
| Q1  | needs founder input | RATIFY / OVERRIDE |

(a recommendation cell that says "needs input" / "TBD" / "depends" is a
blank in table costume — MUST-6 + MUST-5 both BLOCK it)
```

### Specialist-team authorship — per-domain vs orchestrator guess

```markdown
# DO — each recommendation produced by the relevant domain specialist

Packet spans envelope (PACT), trust/posture (EATP), crate-architecture.
→ pact-specialist recommends the envelope rows; trust-plane-specialist the
posture rows; rust-architect the crate rows — each grounded in its spec.
The orchestrator synthesizes; it does not guess the picks.

# DO NOT — one orchestrator pass guessing every domain's pick

Orchestrator drafts all 22 recommendations single-threaded, citing no
specialist's spec reading — "spec-grounded" in name only.
```

## Trust Posture Wiring — extended detection-mechanism detail

**MUST-1..5 hook detection (IMPLEMENTED 2026-05-06):**
`.claude/hooks/lib/violation-patterns.js::detectMenuWithoutPick` runs in the
Stop-event chain via `.claude/hooks/detect-violations.js`. Pattern: ≥2 option
markers (`Option [A-D]`, `(a)`–`(d)`, `[a]`–`[d]`) without a recommendation
anchor (`I recommend`, `Going with`, `Pick:`, `My pick:`, `Recommendation:`,
`My choice:`, `I'd go with`, `I'm going with`). 8 audit fixtures committed at
`.claude/audit-fixtures/violation-patterns/detectMenuWithoutPick/` per
`cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4 — 2 flag cases, 5
clean cases, 1 empty input. False-positive class: legitimate option
enumerations the user explicitly asked for ("just give me the options") — the
hook surfaces the candidate; the agent acknowledges next turn or the user
adjudicates.

**Review-layer detection:** gate-level reviewer mechanical sweep at `/codify`
validation — for any hook-flagged response answering a user choice, the reviewer
confirms (a) the user explicitly asked for a menu (false positive — close) or
(b) the response genuinely lacked recommendation/implications/pros-cons/
plain-language (true positive — flag for downgrade math). Final disposition human.

**MUST-6 detection:** the Stop-event `detectMenuWithoutPick` hook covers prose
menus. A blank packet is a _file_ artifact, not prose — Phase-1 detection is the
`/codify` + `/redteam` gate-review (reviewer confirms any surfaced decision
packet carries a recommendation per row). Phase-2 (deferred): a
`PostToolUse(Write)` hook scanning decision-packet / brief files for repeated
empty answer-field markers (`→ ANSWER:` followed by blank; empty table cells
under an "answer"/"recommendation" column; recommendation cells equal to
"TBD"/"needs input"/"depends"). Audit fixtures land with the Phase-2 hook.

Origin: lifted from the Rust SDK BUILD proposal (Gate-1 2026-06-11, entries
REC-Q-MUST6 + REC-Q-GUIDE, origin evidence 2026-05-18). See the rule's
Origin (MUST-6) paragraph for the incident narrative.

### The three-bullet detection split, and why the rule now carries one field (moved 2026-09-15)

Until 2026-09-15 the rule's `## Trust Posture Wiring` block carried FOUR
`Detection mechanism` bullets: the canonical single-field roll-up
`trust-posture.md` MUST-8 mandates, plus a hook-layer bullet, a review-layer
bullet and a MUST-6-packet bullet. The split predated the MUST-8 roll-up mandate
and was retained on the stated ground that "each half carries detail the roll-up
cannot" — which was true, and is why the detail is HERE rather than deleted. The
rule now carries the single canonical field with every normative statement and
every citation intact; the three bullets' expository remainder is the material in
this section.

**The probe suite, in full.**
`.claude/test-harness/probes/recommendation-quality.probes.json` holds 20 rows in
10 bipolar `pair_id` pairs — one firing pair per derived clause (MUST-1 through
MUST-8, and the MUST NOT block) plus a meta-compliance pair — with candidate
fixtures and answer-key sidecars at
`.claude/audit-fixtures/recommendation-quality/`. It is registered in
`eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in
`probe-suite-integrity.test.mjs::PINNED_SUITES`, with ZERO deferred clauses in
`clause-coverage-baseline.json`.

**The MUST-1 pair is built on precisely what the hook CANNOT see.** MEASURED on
this tree: `detectMenuWithoutPick` returns `null` on the VIOLATING pole — the
pole's `Recommendation:` anchor suppresses the finding while the line behind that
anchor picks nothing — and FIRES an advisory on the COMPLIANT pole. A check that
deferred to the hook would therefore score that pair BACKWARDS, which is the
whole reason the semantic tier exists alongside the lexical one.

**What registration buys, and what it does not.** Registration buys
DISPATCHABILITY, never automatic execution: no workflow invokes
`coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green
CI run is NEVER evidence these probes passed — they execute only when an
orchestrator dispatches `/test-harness-probe --artifacts` at gate-review.

## MUST-7 + MUST-8 — the two orthogonal autonomy axes (depth)

Extracted from the rule body 2026-08-09 (loom#1597-capacity, rule-injection-budget
pressure — ZERO de-scoping). Both MUST clauses keep their full normative force,
DO/DO-NOT blocks and `**Why:**` lines in `rules/recommendation-quality.md`; what
moved here is the axis exposition and the BLOCKED-rationalization corpora.

### Why confidence (MUST-7) is a THIRD axis

Blast-radius (`/autonomize` § Prudence — destructive / hard-to-reverse / shared-state
actions) asks _how bad if it is wrong_; undecidability (MUST-1 — no single best option)
asks _is there a pick at all_; confidence asks _can I stand behind this pick on
evidence_. A decidable + low-blast-radius + low-confidence pick passes BOTH existing
gates and falls through — MUST-7 is the gate that catches exactly that quadrant.
Decidability ≠ confidence: one option can be clearly the front-runner AND still be a guess.

**BLOCKED rationalizations (MUST-7):**

- "There's a clear pick, so `/autonomize` says proceed" (a _clear_ pick you can STAND BEHIND proceeds; a decidable pick held at low confidence is not the same — decidability ≠ confidence)
- "It's cheap / easily reversible, low blast-radius" (blast-radius is a different axis; MUST-7's whole point is the low-blast-radius + low-confidence quadrant Prudence does not cover)
- "Asking would be hedging" (surfacing a genuine low-confidence pick for ratification is the OPPOSITE of hedging — hedging is asking when you ARE confident; this is the honest confidence signal the user needs)
- "I made a pick, that satisfies MUST-1" (MUST-1 requires the recommendation; MUST-7 requires escalating it when you cannot stand behind it — both bind)
- "The redteam / next session will catch it if it's wrong" (a below-confidence pick is precisely the one whose error is cheapest to catch NOW, at ratification, and most expensive once acted on)
- "Stating low confidence undermines the recommendation" (an accurate confidence label is part of the recommendation's quality, not a subtraction — per MUST-3's symmetric-honesty)

### Why sensitivity (MUST-8) is a FOURTH axis the other three gates miss

loom's autonomy gates ask three questions: blast-radius (`/autonomize` § Prudence) — _how
bad if it is wrong_; undecidability (MUST-1) — _is there a pick at all_; confidence
(MUST-7) — _can I stand behind this pick on evidence_. Sensitivity asks a fourth: _does
this write raise the exposure / classification of the content_. The miss is at the
OPERATIONAL layer: § Prudence's confirm-triggers are all **action-mechanics**
(destructive / hard-to-reverse / shared-state-visible / scope-expansion / BUILD-repo), so
a **mechanically-cheap** write — a purely-local commit — trips none of them **even when
the content it persists is high-consequence** (a secret leak IS maximal-consequence; it is
the _write mechanics_ that are cheap, not the content). Sensitivity is thus orthogonal to
the action-mechanics PROXY Prudence gates on, not to consequence. The distribution
disclosure fences do not close this either: Gate-1 intake, Gate-2 sync, and
`publish-to-public.mjs` fire at a **distribution-pipeline boundary**, and the one
authoring-time disclosure hook — `cross-ecosystem-disclosure-guard.js` (PreToolUse
Edit|Write) — is dormant on canon + scoped to the fork→canon partition, so NO existing
fence examines the gitignored→committed / tenant→global / secret→durable partitions at the
in-repo **authoring** verdict. MUST-8 is that gate.

**BLOCKED rationalizations (MUST-8):**

- "It's a local commit, not a push — no one sees it yet" (the durable surface IS the exposure; a committed shared artifact is read by every operator on the next pull, and no distribution fence re-examines an already-committed in-repo write)
- "The disclosure scrub / Gate-2 will catch it" (those fire at a distribution-pipeline boundary — intake / sync / publish — not at the authoring verdict; the content is in git history and correlatable BEFORE any fence runs, the exact `artifact-flow.md` Intake-Scrub failure mode)
- "It's cheap / easily reversible, low blast-radius" (the write MECHANICS are cheap, but § Prudence gates on action-mechanics and misses the exposure the cheap write persists — MUST-8's whole point is that a mechanically-cheap write can still elevate sensitivity, whatever the content's consequence)
- "The content came from a file I was authorized to read" (read-authority does not carry forward to persist-and-widen — this is the per-verdict independence the sensitivity axis enforces)
- "I'll just scrub it myself, no need to confirm" (a silent self-scrub can under-redact; surfacing the partition lets the user set the exposure they intend)
- "security.md already covers secrets" (security.md is secret-scoped + advisory prose; MUST-8 is the per-verdict gate over the broader sensitivity/audience partition — gitignored→committed and tenant→global included)

## Relationship to existing rules

Extracted from the rule body 2026-08-09 (loom#1597-capacity, rule-injection-budget
pressure — ZERO de-scoping; every MUST clause keeps its full normative force in the
rule, only this cross-reference map moved). The rule body carries a pointer here.

Extends:

- `rules/communication.md` § "Explain Choices in Business Terms" — that rule says explain in business terms; this rule says ALSO recommend (don't just explain).
- `rules/communication.md` § "Frame Decisions as Impact" — that rule says present impact; this rule says present a recommendation alongside the impact.
- `feedback_directive_recommendations.md` (user memory) — that note says "Always recommend based on rigor/completeness/accuracy/optimality; never option-menus without a pick. On 'proceed'/'continue', execute" — this rule lifts the user feedback into a structural defense.

Distinct from:

- `rules/autonomous-execution.md` — that rule governs WHAT the agent recommends (autonomous-framing assumptions); this rule governs HOW the recommendation is delivered.
- `rules/time-pressure-discipline.md` — that rule's MUST Rule 3 (Prioritization MUST Be Suggested, Not Auto-Picked) IS the recommendation-quality shape applied to pressure-driven prioritization. When the user signals time pressure and ≥2 outstanding tasks are eligible, the agent MUST surface a prioritized list with rationale per this rule's Rules 1–3, not unilaterally pick the top item.
- `rules/user-flow-validation.md` MUST-6 (scrub receipts before embedding in PR/commit/journal/session-notes that may sync) and MUST-8 here **STACK, not conflict**, on the secret-into-durable-artifact case: MUST-6 mandates the SCRUB (remove secrets/downstream tokens before embedding); MUST-8 mandates the CONFIRM (surface the sensitivity partition so the user sets the exposure). An agent embedding sensitive content into a committed/synced artifact owes both — scrub per MUST-6 AND confirm per MUST-8. MUST-6 is receipt-scoped + sync-boundary-oriented; MUST-8 is the per-verdict authoring-time gate over the broader sensitivity/audience partition.

## Trust Posture Wiring — MUST-7 clause-scoped depth

Extracted from the rule body 2026-08-19 (structural-cleanup extraction under rule-injection-budget
pressure — ZERO de-scoping). The MUST-7 Wiring block in `.claude/rules/recommendation-quality.md`
keeps all 8 canonical fields and every normative statement; what moved here is the
grandfather-precedent narrative, the severity rationale, the no-dedicated-key reasoning, and the
detection-mechanism depth.

### Grandfather / clause-scoped precedent

Applies to the **MUST-7** clause (added 2026-07-05, SAFR S3 O1 origination). Per `trust-posture.md`
MUST-8 grandfather cutoff, MUST-7 lands AT/AFTER the MUST-8 SHA and MUST ship
canonical-8-field-compliant; the pre-existing MUST-1..6 Wiring above it remains grandfathered until
each is itself `/codify`-touched (the clause-scoped precedent set by `rule-authoring.md`'s own
Wiring section + `security.md` / `git.md`).

### Severity — why the hook layer is advisory, not block

`halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm a
below-confidence pick was escalated for ratification, not auto-executed); `advisory` at the hook
layer — no structural signal exists at tool-call time, a confidence self-assessment is
judgment-bearing prose per `hook-output-discipline.md` MUST-2, and lexical detection of a "low
confidence" self-label would be regex-shaped, which MUST NOT carry `block`.

### Regression-within-grace — the no-dedicated-key reasoning

A same-class violation within the 7-day grace window routes through the GENERIC
`regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) —
NO dedicated per-clause trigger key. A confidence-self-assessment property is review-layer-only and
semantic; it does not warrant a dedicated instant-drop key, and minting one would drag
`trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit. The universal
`regression_within_grace` trigger already covers it. Named deviation from the canonical
key-per-clause shape, recorded per `trust-posture.md` Rule 8 — the same no-dedicated-key
disposition `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.

### Detection mechanism — depth

Phase 1 (manual, gate-review): reviewer at `/implement` + cc-architect at `/codify` inspect any
session transcript where the agent produced a recommendation while exhibiting or self-labeling low
confidence, and confirm it was surfaced for ratification (recommendation + explicit confidence +
evidence-that-would-raise-it + a yes/no gate) rather than auto-executed. The review-layer semantic
gate-review IS the authoritative verdict (the `probe-driven-verification.md` MUST-2 LLM-as-judge
shape) — a below-confidence self-label is semantic, not a lexical regex, so `detectMenuWithoutPick`
does NOT cover it. Phase 2 is RETIRED, not pending (2026-08-31): no hook detector will EVER be
built, because the only buildable one is a lexical matcher over agent prose, which
`hook-output-discipline.md` MUST-2 bars from carrying `block` — so the pairing obligation
`probe-driven-verification.md` MUST-4 would impose never becomes live, and no structural fixtures
are owed. The former forward-pointer to a below-confidence-escalation fixture directory is
withdrawn with the deferral, and its `validate-xref-integrity.mjs::SANCTIONED_DEFERRED_FIXTURES`
carve-out is deleted in the same change (a carve-out kept alive for a fixture nobody will ever
build would silently absorb the next real dangling reference at that slug);
gate-review is the enforcement layer here permanently, in the honest form
`hook-event-selection.md` sets. The retirement is recorded in
`phase2-deferrals.json::acknowledged_non_deferrals`, replacing the former
`deferrals['recommendation-quality.md#must7-below-confidence']` row.

**The `MUST-7-firing` probe pair — pole construction (moved from the rule
2026-09-15).** The two poles run the IDENTICAL thin-evidence search, make the
SAME pick, and end at the SAME commit, separating ONLY on whether the
below-confidence pick was surfaced for ratification or executed; candidates plus
`.expected` answer-key sidecars sit at
`.claude/audit-fixtures/recommendation-quality/`. An LLM judge over a transcript
is the instrument this property needs — which is exactly what the Phase-2 hook
retirement above already conceded — and authoring the pair is what discharges the
SEMANTIC tier that retirement expressly did NOT cover. An earlier revision of the
rule's Detection-mechanism row said the suite was NOT YET AUTHORED; that was true
when written and is now FALSE, corrected rather than left standing.

**Why no structural signal exists at tool-call time.** Whether a pick was held
BELOW the confidence floor, and whether it was escalated for ratification, are
judgments over the agent's OWN reasoning — no argv token, AST node,
parsed-document field or git-object fact carries either at the moment a tool is
called. That is the measured ground for the permanent retirement, not a
scheduling preference.

## Trust Posture Wiring — MUST-8 clause-scoped depth

Extracted from the rule body 2026-08-19 (same structural-cleanup extraction, ZERO de-scoping). The
MUST-8 Wiring block keeps all 8 canonical fields and every normative statement — including the
single-count exemption and the PII non-exemption; what moved here is the grandfather narrative, the
severity rationale, the reasoning behind the exemption, the no-dedicated-key reasoning, and the
detection-mechanism depth.

### Grandfather / clause-scoped precedent

Applies to the **MUST-8** clause (added 2026-07-05, SAFR S1 O1 origination). Per `trust-posture.md`
MUST-8 grandfather cutoff, MUST-8 lands AT/AFTER the MUST-8 SHA and MUST ship
canonical-8-field-compliant; the pre-existing MUST-1..6 Wiring remains grandfathered until each is
itself `/codify`-touched (the clause-scoped precedent set by `rule-authoring.md`'s own Wiring
section + `security.md` / `git.md` + MUST-7's own Wiring, which — like MUST-8 — landed post-cutoff
canonical-compliant, cited as precedent for the clause-scoped SHAPE, NOT as a grandfathered member).

### Severity — the reviewer set and why the hook layer is advisory

`halt-and-report` at gate-review: reviewer at `/implement` + security-reviewer when the crossed
partition is secret/credential/tenant-scoped + cc-architect at `/codify` confirm a
sensitivity-elevating write was surfaced for confirmation, not auto-persisted. `advisory` at the
hook layer — no structural signal at tool-call time, since whether a write raises sensitivity is
judgment-bearing prose per `hook-output-discipline.md` MUST-2; a lexical tripwire on a
gitignored-path substring appearing in a committed-file Write MAY pair as advisory but MUST NOT
carry `block`.

### Cumulative posture impact — why the single-count exemption, and why PII is NOT exempt

A secret/credential-partition violation counted under the pre-existing `critical` secret-leak
trigger (→ L1) is NOT ALSO counted in MUST-8's cumulative window — the critical path is terminal
and single-counts it. The remaining partitions accrue via the cumulative path: PII-in-a-durable
artifact (unless the PII is itself a credential/secret routing to `critical`),
gitignored-per-operator, and tenant-scoped. PII is deliberately NOT exempted from the cumulative
count: `trust-posture.md` MUST-4's `critical` trigger names only "secret leak", so a PII-only
escalation does not route there and MUST accrue cumulatively — the gate-review
(`halt-and-report`) is its detection surface.

### Regression-within-grace — the no-dedicated-key reasoning + the critical-trigger routing

A same-class violation within the 7-day grace window routes through the GENERIC
`regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) —
NO dedicated per-clause trigger key. A sensitivity self-assessment is review-layer-only and
semantic; it does not warrant a dedicated instant-drop key, and minting one would drag
`trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal
`regression_within_grace` trigger already covers it. Named deviation from the canonical
key-per-clause shape, recorded per `trust-posture.md` Rule 8 — the same no-dedicated-key
disposition MUST-7, `security.md` § Enforcement-Surface Parity, and `git.md` § CI-check/merge took.
A secret/credential leak into a committed artifact that ALSO trips the pre-existing `critical`
(secret leak → L1) emergency trigger in `trust-posture.md` MUST-4 routes THERE, unchanged — MUST-8
adds no new key AND (per the single-count exemption above) does not additionally accrue it in the
cumulative window.

### Detection mechanism — depth

Phase 1 (manual, gate-review): reviewer at `/implement` + security-reviewer (secret/tenant
partitions) + cc-architect at `/codify` inspect any session transcript where the agent persisted
content into a durable/committed/synced surface that raised its sensitivity or audience, and
confirm it was surfaced for confirmation (partition named + lower-exposure alternative stated +
yes/no gate) rather than auto-persisted. The review-layer semantic gate-review IS the authoritative
verdict (the `probe-driven-verification.md` MUST-2 LLM-as-judge shape) — sensitivity elevation is
semantic, not a lexical regex, so no existing hook detector covers it, and when a Phase-2 lexical
tripwire lands (e.g. a gitignored-path substring in a committed-file Write) it MUST pair with this
review layer per `probe-driven-verification.md` MUST-4. Phase 2 (deferred per `trust-posture.md`
§ Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at
`.claude/audit-fixtures/recommendation-quality/sensitivity-escalation/` per `cc-artifacts.md`
Rule 9.

**The `MUST-8-firing` probe pair — pole construction (moved from the rule
2026-09-15).** The two poles share the investigation, the diagnosis and the final
commit BYTE-FOR-BYTE, separating ONLY on whether the tenant-scoped material
crossed into the committed doc verbatim or as a synthetic reproduction surfaced
for confirmation; candidates plus `.expected` answer-key sidecars sit at
`.claude/audit-fixtures/recommendation-quality/`. The pair discharges the
SEMANTIC tier ONLY — the hook-detector deferral recorded immediately above is a
DIFFERENT instrument and is deliberately untouched by it. An earlier revision of
the rule's Detection-mechanism row said the suite was NOT YET AUTHORED; that was
true when written and is now FALSE, corrected rather than left standing.

## Origin narratives — per-instance provenance

Extracted from the rule body 2026-08-19 (structural-cleanup extraction, ZERO de-scoping). The rule
keeps a dated `Origin:` credit per clause (`rule-authoring.md` MUST-6) plus a pointer here; the
incident narratives and verbatim directives live below.

### MUST-1..5 — the originating user directive (2026-05-06)

User directive after observing recommendations that surfaced options without picks AND used
technical framings without translation: _"please add in a strong rule that agent is not supposed to
suggest without giving recommendations with implications, pros and cons, and easy-to-understand less
technical expositions. This is critical."_ The user-feedback memory `feedback_directive_recommendations.md`
(2026-04-22) had captured the principle; this rule structurally enforces it as a MUST clause with
detection + grace-period wiring.

### MUST-6 — the blank founder-clarification packet (2026-05-18)

A Rust SDK session. The agent built a 22-question founder clarification packet as a blank menu —
every `→ ANSWER:` field empty, prose stating "the agent does NOT pre-fill." User: _"why aren't you
using a team of agents, ultrathink, and recommend according to our specs?"_ Root cause: conflating
"don't agent-**decide** a silent default" (correct) with "don't agent-**recommend**" (wrong).
Correction: a 6-specialist team produced 23 spec-grounded recommendations; the packet was rewritten
to carry pick + spec basis + con + ratify/override per row. User then directed proper codification
("don't just rely on memory, codify it properly"). Self-referential `/codify` per
`self-referential-codify.md` Rule 2 — landed BUILD-side with a 3-agent redteam (reviewer /
security-reviewer / cc-architect), verdict MERGE-WITH-FIXES, all CRIT/HIGH/MED fixes applied in that
codify.

### MUST-7 and MUST-8 — the two SAFR originations (2026-07-05)

**MUST-7:** SAFR S3 O1 origination (below-confidence escalation; the third autonomy axis). Receipt
`journal/0434`; convergence `journal/0435`. **MUST-8:** SAFR S1 O1 origination
(sensitivity/classification escalation; the fourth autonomy axis, surfaced when an independent
redteam refutation broke the initial "loom already holds the invariant" close). Receipt
`journal/0436`. Both cite SAFR v1.0 §2 as external authority, distilled at
`specs/methodology/agentic-runtime-governance.md` §1. **CORRECTED 2026-08-29 (loom#1895):** an
earlier revision of this paragraph said "the per-clause authority sentences stay inline in the
rule's `**Why:**` lines". That is no longer true and the claim is WITHDRAWN — the rule body now
keeps a one-line authority CITATION (`SAFR v1.0 §2`, plus the distillation path) inside each
`**Why:**` and points at § "External authority — how SAFR v1.0 §2 composes to MUST-7 and MUST-8"
below for the composition argument. The failure-mode statement of each `**Why:**` stays in the rule
body verbatim, as it always has.

## External authority — how SAFR v1.0 §2 composes to MUST-7 and MUST-8

Extracted from the rule body 2026-08-29 (loom#1895 rule-injection-budget pressure — ZERO
de-scoping). What moved is the composition ARGUMENT — how the SAFR components compose to the
disposition property loom adopts. The authority CITATION itself, and the failure-mode statement of
each `**Why:**`, stay inline in `rules/recommendation-quality.md`.

**MUST-7 (confidence).** SAFR v1.0 §2's Controls-Repository **evidence-quality /
minimum-confidence** dimension, plus the Disposition-Engine **Escalate** outcome — the two
components distilled at `specs/methodology/agentic-runtime-governance.md` §1 — compose to the
disposition property loom adopts for its own agents: _a decision below a confidence /
evidence-quality threshold escalates to human review regardless of value / reversibility._

**MUST-8 (sensitivity).** The SAFR v1.0 §2 Disposition-Engine calibration on **sensitivity** — one
of its five dimensions (reversibility, materiality, impact, sensitivity, novelty), distilled at the
same `specs/methodology/agentic-runtime-governance.md` §1 — composes to the disposition property
loom adopts for its own agents: _a write that elevates content sensitivity escalates to human
confirmation regardless of value / reversibility._

Both compositions share a shape worth naming: SAFR calibrates a disposition on a CONTENT- or
EVIDENCE-property, and loom adopts it as an escalation gate that fires **regardless of value /
reversibility** — which is precisely why neither clause can be folded into the blast-radius gate
`/autonomize` § Prudence already runs.

## Length rationale — the eight-clause enumeration

Extracted from the rule body 2026-08-19 (structural-cleanup extraction, ZERO de-scoping). The rule
keeps the named rationale anchored at Origin, as `rule-authoring.md` MUST NOT § "Rules longer than
200 lines" requires; the enumeration and the splitting-cost argument live here.

The named rationale is **autonomy-axis-completeness scope**. The rule codifies an eight-clause
recommendation contract: a six-clause recommendation core — MUST-1..6, recommend-not-menu +
implications + symmetric cons + plain-language + resolve-the-question + decision-packet-ratification
— PLUS the two orthogonal autonomy-escalation axes SAFR surfaced, MUST-7 confidence + MUST-8
sensitivity. Each clause carries the DO/DO-NOT block + BLOCKED corpus + `**Why:**` line the
meta-rule mandates, AND (for the two post-cutoff clauses) the canonical 8-field Trust-Posture Wiring
`trust-posture.md` MUST-8 requires. The rule is `priority: 10` + `scope: path-scoped`, so it pays NO
baseline-emission cost (loaded only in matching sessions) and `rule-authoring.md` Rule 10's
proximity-band gate does NOT fire on it. Splitting the axes into sibling rules would fragment the
"the agent recommends AND escalates on these orthogonal axes" contract across files and force
cross-rule lookups at every recommendation. Per that MUST NOT the 200-line cap is guidance and
overage is permitted with a named rationale anchored at Origin. Sibling precedent:
`artifact-flow.md` + `cc-artifacts.md` length rationales.

## Extraction record — 2026-08-19 structural-cleanup extraction

**ZERO de-scoping.** Second extraction from `.claude/rules/recommendation-quality.md`, after the
2026-08-09 loom#1597-capacity pass recorded above. Driver: rule-injection budget — the rule fires in
6 of the 8 session profiles, including the two most over-budget ones. Moved here: the MUST-7 +
MUST-8 clause-scoped Wiring depth (grandfather narratives, severity rationales, the single-count
exemption reasoning, the no-dedicated-key reasoning, the detection-mechanism depth), the four Origin
incident narratives, and the length-rationale enumeration. The MUST-1..6 detection depth was already
here (§ "Trust Posture Wiring — extended detection-mechanism detail") and the rule body now points
at it instead of restating it.

Every MUST, MUST NOT, BLOCKED-rationalization entry, DO/DO-NOT block and `**Why:**` line stays in
the rule body verbatim; all 8 canonical Wiring fields keep their normative statements, with only
narrative moved out from inside a field.

### The four passes, with their measured figures

- **(1) 2026-08-09, loom#1597-capacity** — measured **46,199 B → 42,295 B**.
- **(2) 2026-08-19, structural cleanup** — MUST-7/MUST-8 Wiring depth + the four Origin narratives +
  the length-rationale enumeration moved here; measured **43,152 B → 39,158 B**.
- **(3) 2026-08-29, loom#1895** — the `workspace-note` profile was 2,998 B over its ceiling and this
  rule is its largest contributor (charging 6 of 8 profiles). Moved here: the `Origin:` per-clause
  narrative tail, the extraction-record recital, the length-rationale exposition, the two Wiring
  preamble grandfather recitals, the MUST-7 and MUST-8 axis expositions (each already restated
  inside its own protected `**Why:**`), and the two SAFR external-authority composition arguments
  (§ "External authority — how SAFR v1.0 §2 composes to MUST-7 and MUST-8"). Measured
  **39,158 B → 37,236 B** (−1,922 B).
- **(4) 2026-09-15, rule-budget lane** — driver: the rule is admitted by the `**/*.md` glob and so
  charges FIVE injection-budget profiles, two of them over their accepted level. Moved here: the
  three-bullet `Detection mechanism` split that predated `trust-posture.md` MUST-8's single-field
  roll-up (hook layer / review layer / MUST-6 packets), the probe-suite construction depth for the
  MUST-1, MUST-7 and MUST-8 pairs, the "no structural signal at tool-call time" argument behind the
  MUST-7 Phase-2 retirement, and the per-pass extraction recital. Measured on RAW file bytes —
  `Buffer.byteLength(readFileSync(path,"utf8"),"utf8")`, the quantity
  `check-rule-injection-budget.mjs::loadRules` reads — **41,308 B → 38,560 B** (−2,748 B).
  Deliberately NOT measured through `emit.mjs`'s abridge pipeline, which strips Trust-Posture-Wiring
  sections before emission and would have reported this pass as zero (`instrument-discipline.md`
  MUST-4). The enforcement-token census was held EXACTLY flat across the pass — `must_clause` 8,
  `must_token` 130, `must_not_token` 5, `blocked_token` 23, `why_line` 16, all eight Wiring fields
  unchanged — and so was the referential inventory (16 `citation_path` + 3 `citation_anchor` + 5
  `citation_file` members, identical sets), because a citation moved rule → guide is a LOSS under
  `check-descoping.mjs::isInjectedPairedDepthOf`, never a free move.

**`rule-authoring.md` Rule 10 / Rule 11 do NOT fire on any of the four passes.** Rule 10
§ "Trigger scope" limits the gate to `priority: 0` + `scope: baseline` rules, and this rule is
`scope: path-scoped`. All three are therefore STRUCTURAL-CLEANUP extractions, not Rule-10 paired
extractions — hence NOT Rule-11 recurrence input, which counts Rule-10-MANDATED invocations only
(the disposition `journal/0148` recorded).

**`rule-authoring.md` Rule 10 / Rule 11 do NOT fire here.** Rule 10 § "Trigger scope" limits the
gate to `priority: 0` + `scope: baseline` rules; `recommendation-quality.md` is `priority: 10` +
`scope: path-scoped`, so it does not contribute to baseline emission and Rule 10's proximity-band
gate never fires — which also makes this a NON-input to Rule 11's 30-day recurrence count (Rule 11
counts Rule-10-MANDATED invocations only). This is a STRUCTURAL-CLEANUP extraction, not a Rule-10
paired extraction — the same disposition `journal/0148` recorded for `rule-authoring.md`'s own
path-scoped extraction.
