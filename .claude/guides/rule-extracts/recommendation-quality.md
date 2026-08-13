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
