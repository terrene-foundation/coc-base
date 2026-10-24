---
id: "RECOMMENDATION-QUALITY"
---

# Recommendation Quality — No Suggestion Without Recommendation

Depth companion — cited below as **the extract** — is `.claude/guides/rule-extracts/recommendation-quality.md`: MUST-6's decision-packet examples, the MUST-7/MUST-8 axis expositions + BLOCKED corpora, the clause-scoped Wiring depth, the detection-mechanism detail, the Origin narratives, and the extraction record.

When the agent surfaces a choice to the user — options, paths forward, design tradeoffs, technical decisions, mitigation strategies — the agent MUST present a **recommendation**, not a menu. The recommendation MUST include implications, pros and cons, and plain-language framing the user can act on without a technical glossary. Bare option enumeration without a pick is BLOCKED. Pros-and-cons-without-recommendation is BLOCKED. Technical jargon without translation is BLOCKED.

## Scope

ALL agent output that asks for user direction. Applies to: design choices, architectural tradeoffs, "should we X or Y?" framings, "options A/B/C" lists, mitigation strategies, scope decisions, sequencing decisions, follow-up dispositions, **founder/owner decision packets and "clarification" lists**. Does NOT apply to: factual answers ("what's the version of X?"), confirmation gates ("destructive op — proceed?"), or user-explicitly-asked-for-choice ("give me three options"). Note: a founder-clarification packet is NOT the "user-explicitly-asked-for-choice" exemption — the user asking for a decision packet is asking for _recommendations to ratify_, not a blank menu (see MUST-6).

## MUST Rules

### 1. Every Surfaced Choice MUST Carry A Recommendation

When the agent surfaces ≥2 options for the user to choose between, the response MUST include one of: (a) a single explicit recommendation with rationale, OR (b) the user explicitly asked for a menu without a pick ("just give me the options"). Anything else is BLOCKED.

**BLOCKED rationalizations:**

- "The user knows their codebase better than me, they should pick"
- "Recommending feels presumptuous for a major decision"
- "Pros and cons are enough, the user can synthesize"
- "I'm avoiding bias by staying neutral"
- "The choice depends on context I don't have"
- "Listing options IS the recommendation"

### 2. Recommendations MUST Spell Out Implications

The recommendation MUST include the **implications** of taking it: what changes for the user, what ongoing maintenance burden, what blast radius, what reversibility class. "Implications" is what makes the recommendation actionable beyond the immediate decision.

**BLOCKED rationalizations:**

- "The implications are obvious from context"
- "Listing implications is verbose"
- "The user can ask if they want detail"
- "Implications inflate the response"

### 3. Pros And Cons MUST Be Symmetric And Honest

When the agent presents tradeoffs (whether or not multiple options are surfaced), the **cons of the recommended option MUST be stated** alongside the pros. One-sided recommendations are BLOCKED.

**BLOCKED rationalizations:**

- "The cons are minor"
- "Listing the cons might dissuade the user from the right choice"
- "The recommendation IS the answer; cons are footnotes"
- "User asked for a recommendation, not a balanced view"

**Honest symmetry forbids FABRICATING a con — a con MUST change what the user does.** MUST-3's symmetry prevents HIDING real downsides; it does NOT license INVENTING them for the sake of balance. The test for a con is: _does it change what the user should do?_ A "con" that changes nothing is rhetorical filler, not a con. This bites hardest at a **clean gate-stop** — when the recommendation is to hand control back to the human gate (end of shard, `/wrapup`, converge-then-gate): the stop IS the correct, complete action (Human-on-the-Loop, `rules/autonomous-execution.md` § Structural vs Execution Gates), not a compromise. Manufacturing a "cons of stopping here" at that boundary is BLOCKED — it misframes the correct action as a lesser option, subtly pressures toward "keep going," and confuses the user with a non-decision.

**BLOCKED rationalizations:**

- "Symmetry means I must list a con even here"
- "The con is honest even though it changes nothing"
- "Naming the downside of stopping is being thorough"
- "It gives the user the full picture" (a non-decision-changing 'con' is noise, not the picture)
- "Writing a con for balance is what MUST-3 asks for"

### 4. Plain-Language Exposition — Translate Every Technical Term

The recommendation, implications, and pros/cons MUST use language a non-coder can act on. Technical terms appearing for the first time MUST be immediately translated. Jargon-heavy framings without translation are BLOCKED. This rule **extends `guides/rule-extracts/communication.md`** § "Explain Choices in Business Terms" — communication.md is the principle; this rule is the structural enforcement at recommendation time.

**BLOCKED rationalizations:**

- "The user is technical, jargon is fine"
- "Translation makes responses too long"
- "The technical framing is the most precise"
- "Plain language loses fidelity"
- "Glossary at the end of the response is enough"

### 5. "I Recommend X" Followed By A Question MUST Resolve The Question

If the recommendation ends with a question to the user ("want me to proceed?", "which way should I go?"), the question MUST be a **yes/no** confirmation OR a single decision point — never a re-presentation of the original menu. Re-asking the user to choose between the same options the agent just declined to recommend on is BLOCKED.

**BLOCKED rationalizations:**

- "The user might disagree with the recommendation, surfacing alternatives is courteous"
- "Re-asking ensures consensus"
- "Yes/no is too binary for a complex decision"

MUST-6 lives in `rules/recommendation-quality-packets.md`; MUST-7 and MUST-8 live in `rules/recommendation-quality-escalation.md` (split 2026-10-10, clause numbers kept).

## MUST NOT

- Surface ≥2 options without a recommendation pick

**Why:** This is the originating failure mode this rule blocks. The user who asked for advice gets a menu instead.

- Present a "clarification packet" / decision list with blank answer fields, OR a recommendation cell that punts ("needs input" / "TBD" / "depends"), for the human to resolve from scratch

**Why:** A blank packet is MUST-1's violation in the costume of deference; "the human decides" is satisfied by ratify/override, not by an empty field.

- Use technical terms without immediate translation on first appearance in a recommendation

**Why:** Jargon compounds across a conversation; the cost of the second untranslated term is higher than the first.

- Hide cons of the recommended option

**Why:** Hidden cons surface later as broken trust; the structural defense is upfront symmetry.

- Replace a recommendation with "it depends" + a list of dependencies

**Why:** "It depends" without a recommendation is a punt. The agent has the context; if "it depends" is the honest answer, the agent MUST then state which context would resolve the dependency and recommend the path under each branch.

Depth — the Trust-Posture Wiring, the full Why paragraphs, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/recommendation-quality.md`, which every validator reads as part of this rule.
