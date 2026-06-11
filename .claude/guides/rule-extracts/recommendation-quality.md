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

Origin: lifted from the kailash-rs BUILD proposal (Gate-1 2026-06-11, entries
REC-Q-MUST6 + REC-Q-GUIDE, origin evidence 2026-05-18). See the rule's
Origin (MUST-6) paragraph for the incident narrative.
