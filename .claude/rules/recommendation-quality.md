---
priority: 10
scope: path-scoped
paths:
  - ".claude/**"
  - "workspaces/**"
  - "**/*.md"
  - "briefs/**"
  - "todos/**"
  - "journal/**"
---

# Recommendation Quality — No Suggestion Without Recommendation

When the agent surfaces a choice to the user — options, paths forward, design tradeoffs, technical decisions, mitigation strategies — the agent MUST present a **recommendation**, not a menu. The recommendation MUST include implications, pros and cons, and plain-language framing the user can act on without a technical glossary. Bare option enumeration without a pick is BLOCKED. Pros-and-cons-without-recommendation is BLOCKED. Technical jargon without translation is BLOCKED.

The user opens a conversation to be **advised**, not to be a decision arbitrator on an unannotated list.

## Scope

ALL agent output that asks for user direction. Applies to: design choices, architectural tradeoffs, "should we X or Y?" framings, "options A/B/C" lists, mitigation strategies, scope decisions, sequencing decisions, follow-up dispositions. Does NOT apply to: factual answers ("what's the version of X?"), confirmation gates ("destructive op — proceed?"), or user-explicitly-asked-for-choice ("give me three options").

## MUST Rules

### 1. Every Surfaced Choice MUST Carry A Recommendation

When the agent surfaces ≥2 options for the user to choose between, the response MUST include one of: (a) a single explicit recommendation with rationale, OR (b) the user explicitly asked for a menu without a pick ("just give me the options"). Anything else is BLOCKED.

```markdown
# DO — recommendation with rationale

I recommend Option B (move auth to a service module).

Why: it isolates the failure surface. Option A (add another callsite)
keeps the bug class alive — same null-bind we just fixed could land in
the new callsite. Option B closes the class structurally.

Tradeoff: ~150 LOC churn in this PR vs ~30 for Option A. The churn is
one-time; the bug-class-prevention is ongoing.

# DO NOT — bare option menu, no pick

Two paths:

- Option A: add another callsite (cheap)
- Option B: move auth to a service module (more refactor)
  Which would you like?
```

**BLOCKED rationalizations:**

- "The user knows their codebase better than me, they should pick"
- "Recommending feels presumptuous for a major decision"
- "Pros and cons are enough, the user can synthesize"
- "I'm avoiding bias by staying neutral"
- "The choice depends on context I don't have"
- "Listing options IS the recommendation"

**Why:** A neutral menu transfers the synthesis cost from the agent (high-context, fast) to the user (lower-context-on-implementation, slow). Users who wanted a menu would have asked for one — they asked the agent because they wanted advice. "Avoiding bias" by staying neutral IS a bias toward inaction. If context is genuinely missing, the agent MUST state which context would change the recommendation, not punt.

### 2. Recommendations MUST Spell Out Implications

The recommendation MUST include the **implications** of taking it: what changes for the user, what ongoing maintenance burden, what blast radius, what reversibility class. "Implications" is what makes the recommendation actionable beyond the immediate decision.

```markdown
# DO — implications spelled out

Recommend: revert PR #52 and re-do the migration command from scratch.

Implications:

- One-time cost: ~one session of re-work (Loom-A through Loom-D + harness validation)
- Recovers: a clean, audit-pristine /migrate that handles the full surface
- Ongoing: every multi-CLI consumer gets correct cross-CLI parity from
  the first /migrate, not "first /migrate is shallow + we'll patch later"
- Reversibility: revert is one git command; the work isn't lost (this
  audit's findings are the spec for v2)

# DO NOT — recommendation without implications

Recommend: revert PR #52 and re-do.
```

**BLOCKED rationalizations:**

- "The implications are obvious from context"
- "Listing implications is verbose"
- "The user can ask if they want detail"
- "Implications inflate the response"

**Why:** Implications are the difference between a recommendation a user can act on and a recommendation they have to interrogate. The agent has the load-bearing context already; surfacing it costs one paragraph. Forcing the user to re-derive it costs one round-trip.

### 3. Pros And Cons MUST Be Symmetric And Honest

When the agent presents tradeoffs (whether or not multiple options are surfaced), the **cons of the recommended option MUST be stated** alongside the pros. One-sided recommendations are BLOCKED.

```markdown
# DO — symmetric pros and cons

Recommend: keep the codex-mcp-guard fail-closed (POLICIES_POPULATED=false).

Pros:

- Fail-closed is the safe default — Codex/Gemini cannot bypass policy
  while predicates are unwired
- Visible failure mode (server refuses to start) — user can't ignore
- Consistent with zero-tolerance Rule 2 (no fail-open scaffolds)

Cons (real, not glossed):

- Every Codex/Gemini session in a multi-CLI repo hits the startup
  refusal until predicates are wired
- Users will ask "why doesn't Codex work?" — answer is "Loom-B not
  shipped yet" — not great DX
- Workaround is to disable codex-mcp-guard in .codex/config.toml,
  which then silently disables policy enforcement entirely

The cons are why Loom-B is on the critical path, not deferred indefinitely.

# DO NOT — pros only, cons elided

Recommend: keep fail-closed. Pros: safe default, visible failure mode,
follows zero-tolerance Rule 2.
```

**BLOCKED rationalizations:**

- "The cons are minor"
- "Listing the cons might dissuade the user from the right choice"
- "The recommendation IS the answer; cons are footnotes"
- "User asked for a recommendation, not a balanced view"

**Why:** Hiding cons makes the recommendation look like a one-way decision when it isn't. Users discovering the cons later (after committing to the recommendation) lose trust in every future recommendation from the same agent. The structural defense is to surface the cons as part of the recommendation; if they outweigh the pros, the recommendation should change.

### 4. Plain-Language Exposition — Translate Every Technical Term

The recommendation, implications, and pros/cons MUST use language a non-coder can act on. Technical terms appearing for the first time MUST be immediately translated. Jargon-heavy framings without translation are BLOCKED. This rule **extends `rules/communication.md`** § "Explain Choices in Business Terms" — communication.md is the principle; this rule is the structural enforcement at recommendation time.

```markdown
# DO — every term translated as it appears

Recommend: enable variant overlays in the per-CLI emitter.

What that means for you: today, when we publish the Codex and Gemini
versions of the project rules, they ship the _generic_ version of
the rules — even when there's a Python-specific or Rust-specific
override that Claude Code already uses. Those overrides are ignored
on the way to Codex/Gemini. Result: Claude Code says "use real
infrastructure for tests" (the strict Python rule); Codex says
"use mocks where convenient" (the generic rule). Same project,
two different rules.

Enabling variant overlays makes Codex and Gemini also pick up the
Python-specific version, so all three CLIs say the same thing.

# DO NOT — jargon-heavy without translation

Recommend: wire variant-axis composition into emit-cli-artifacts.mjs
via composeArtifactBody(category, relPath, cli, lang) so .codex/prompts/
and .gemini/commands/ ship variant-overlaid bodies matching CC's
.claude/commands/ output, closing the cross-CLI parity Rule 1 violation
in test.md / db.md / ai.md / release.md.
```

**BLOCKED rationalizations:**

- "The user is technical, jargon is fine"
- "Translation makes responses too long"
- "The technical framing is the most precise"
- "Plain language loses fidelity"
- "Glossary at the end of the response is enough"

**Why:** Many COC users are non-technical, and even technical users context-switch across domains. Jargon-heavy framings compound across a conversation: every untranslated term increases the cognitive cost of the next decision. Translation at first appearance amortizes the cost. Per `rules/communication.md`: "Match the user's level if they speak technically" — but FIRST default to plain language; the user can opt up to jargon by speaking it themselves.

### 5. "I Recommend X" Followed By A Question MUST Resolve The Question

If the recommendation ends with a question to the user ("want me to proceed?", "which way should I go?"), the question MUST be a **yes/no** confirmation OR a single decision point — never a re-presentation of the original menu. Re-asking the user to choose between the same options the agent just declined to recommend on is BLOCKED.

```markdown
# DO — recommendation, then yes/no confirmation

Recommend: revert PR #52, re-design /migrate using the corrected
emission pipeline.

Want me to revert PR #52 now? (yes/no)

# DO NOT — recommendation, then re-ask the menu

Recommend: revert PR #52, re-design /migrate.

Or, alternatively, we could (a) leave PR #52 in main and patch
forward, (b) revert and start clean, (c) some hybrid. Which way?
```

**BLOCKED rationalizations:**

- "The user might disagree with the recommendation, surfacing alternatives is courteous"
- "Re-asking ensures consensus"
- "Yes/no is too binary for a complex decision"

**Why:** A recommendation that ends in "or, alternatively, the menu I just declined to recommend on" cancels itself out. Either the agent has a recommendation (commit to it; ask yes/no to confirm OR ask one specific clarifying question that would change it), or the agent doesn't and should say so explicitly: "I don't have enough context to recommend; I need to know X first."

## MUST NOT

- Surface ≥2 options without a recommendation pick

**Why:** This is the originating failure mode this rule blocks. The user who asked for advice gets a menu instead.

- Use technical terms without immediate translation on first appearance in a recommendation

**Why:** Jargon compounds across a conversation; the cost of the second untranslated term is higher than the first.

- Hide cons of the recommended option

**Why:** Hidden cons surface later as broken trust; the structural defense is upfront symmetry.

- Replace a recommendation with "it depends" + a list of dependencies

**Why:** "It depends" without a recommendation is a punt. The agent has the context; if "it depends" is the honest answer, the agent MUST then state which context would resolve the dependency and recommend the path under each branch.

## Trust Posture Wiring

- **Severity:** `advisory` for the hook-based detection (lexical regex match — per `rules/hook-output-discipline.md` MUST-2, lexical signals MUST NOT carry severity:block); `halt-and-report` when surfaced by a gate-level reviewer (reviewer / cc-architect) at `/codify` validation. Not block-at-tool-call (no structural signal at PreToolUse time — recommendations are prose).
- **Grace period:** 7 days from rule landing (2026-05-06 → 2026-05-13). During grace, the Stop-event hook logs to `violations.jsonl` for cumulative-tracking but does NOT auto-emergency-downgrade. After grace, regression contributes to the cumulative-downgrade math per `rules/trust-posture.md` MUST Rule 4 (5× total in 30d → drop posture).
- **Regression-within-grace:** if `/codify` authors a same-class violation (a recommendation that drops to a menu, hides cons, or buries jargon) within 7 days of this rule landing, emergency-downgrade per trust-posture Rule 4.
- **Receipt requirement:** SessionStart MUST require `[ack: recommendation-quality]` in the agent's first response IF the most recent `violations.jsonl` includes a `recommendation-quality/MUST-1` entry AND `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism (hook layer — IMPLEMENTED 2026-05-06):** `.claude/hooks/lib/violation-patterns.js::detectMenuWithoutPick` runs in the Stop-event chain via `.claude/hooks/detect-violations.js`. Pattern: ≥2 option markers (`Option [A-D]`, `(a)`–`(d)`, `[a]`–`[d]`) without a recommendation anchor (`I recommend`, `Going with`, `Pick:`, `My pick:`, `Recommendation:`, `My choice:`, `I'd go with`, `I'm going with`). 8 audit fixtures committed at `.claude/audit-fixtures/violation-patterns/detectMenuWithoutPick/` per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4 — covering: 2 flag cases (markers without anchor), 5 clean cases (single option, with each of three anchor forms, no options at all), 1 empty input. False-positive class: legitimate option enumerations the user explicitly asked for ("just give me the options"). Acknowledged in Scope above; the hook surfaces the candidate, the agent acknowledges in next turn or the user adjudicates.
- **Detection mechanism (review layer — semantic):** gate-level reviewer mechanical sweep at `/codify` validation: for any agent response flagged by the hook AND the response was in answer to a user choice, the reviewer confirms whether (a) the user explicitly asked for a menu (false positive — close), or (b) the response genuinely lacked recommendation/implications/pros-cons/plain-language (true positive — flag for downgrade math). Final disposition is human.

## Relationship to existing rules

Extends:

- `rules/communication.md` § "Explain Choices in Business Terms" — that rule says explain in business terms; this rule says ALSO recommend (don't just explain).
- `rules/communication.md` § "Frame Decisions as Impact" — that rule says present impact; this rule says present a recommendation alongside the impact.
- `feedback_directive_recommendations.md` (user memory) — that note says "Always recommend based on rigor/completeness/accuracy/optimality; never option-menus without a pick. On 'proceed'/'continue', execute" — this rule lifts the user feedback into a structural defense.

Distinct from:

- `rules/autonomous-execution.md` — that rule governs WHAT the agent recommends (autonomous-framing assumptions); this rule governs HOW the recommendation is delivered.
- `rules/time-pressure-discipline.md` — that rule's MUST Rule 3 (Prioritization MUST Be Suggested, Not Auto-Picked) IS the recommendation-quality shape applied to pressure-driven prioritization. When the user signals time pressure and ≥2 outstanding tasks are eligible, the agent MUST surface a prioritized list with rationale per this rule's Rules 1–3, not unilaterally pick the top item.

Origin: 2026-05-06 — user directive after observing recommendations that surfaced options without picks AND used technical framings without translation: "please add in a strong rule that agent is not supposed to suggest without giving recommendations with implications, pros and cons, and easy-to-understand less technical expositions. This is critical." The user feedback memory `feedback_directive_recommendations.md` (2026-04-22) had captured the principle; this rule structurally enforces it as a MUST clause with detection + grace-period wiring.
