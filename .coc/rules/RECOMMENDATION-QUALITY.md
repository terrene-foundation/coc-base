---
id: "RECOMMENDATION-QUALITY"
paths: [".claude/**", "workspaces/**", "**/*.md", "briefs/**", "todos/**", "journal/**"]
---

# Recommendation Quality — No Suggestion Without Recommendation

See `.claude/guides/rule-extracts/recommendation-quality.md` for MUST-6's extended decision-packet DO/DO-NOT examples and detection-mechanism detail.

When the agent surfaces a choice to the user — options, paths forward, design tradeoffs, technical decisions, mitigation strategies — the agent MUST present a **recommendation**, not a menu. The recommendation MUST include implications, pros and cons, and plain-language framing the user can act on without a technical glossary. Bare option enumeration without a pick is BLOCKED. Pros-and-cons-without-recommendation is BLOCKED. Technical jargon without translation is BLOCKED.

The user opens a conversation to be **advised**, not to be a decision arbitrator on an unannotated list.

## Scope

ALL agent output that asks for user direction. Applies to: design choices, architectural tradeoffs, "should we X or Y?" framings, "options A/B/C" lists, mitigation strategies, scope decisions, sequencing decisions, follow-up dispositions, **founder/owner decision packets and "clarification" lists**. Does NOT apply to: factual answers ("what's the version of X?"), confirmation gates ("destructive op — proceed?"), or user-explicitly-asked-for-choice ("give me three options"). Note: a founder-clarification packet is NOT the "user-explicitly-asked-for-choice" exemption — the user asking for a decision packet is asking for _recommendations to ratify_, not a blank menu (see MUST-6).

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

**Honest symmetry forbids FABRICATING a con — a con MUST change what the user does.** MUST-3's symmetry prevents HIDING real downsides; it does NOT license INVENTING them for the sake of balance. The test for a con is: _does it change what the user should do?_ A "con" that changes nothing is rhetorical filler, not a con. This bites hardest at a **clean gate-stop** — when the recommendation is to hand control back to the human gate (end of shard, `/wrapup`, converge-then-gate): the stop IS the correct, complete action (Human-on-the-Loop, `rules/autonomous-execution.md` § Structural vs Execution Gates), not a compromise. Manufacturing a "cons of stopping here" at that boundary is BLOCKED — it misframes the correct action as a lesser option, subtly pressures toward "keep going," and confuses the user with a non-decision.

```markdown
# DO — clean gate-stop stated plainly, no fabricated con

Recommend: stop here — the work is converged; wrap up and resume in a fresh
session. Clean stopping point, nothing is lost by stopping. I can continue
now if you'd prefer.

# DO NOT — manufactured con dressing the correct gate-stop as a trade-off

Recommend: stop here.
Cons of stopping here (honest): the write doesn't land until next session;
if you'd rather I keep going, just say so.
```

**BLOCKED rationalizations:**

- "Symmetry means I must list a con even here"
- "The con is honest even though it changes nothing"
- "Naming the downside of stopping is being thorough"
- "It gives the user the full picture" (a non-decision-changing 'con' is noise, not the picture)
- "Writing a con for balance is what MUST-3 asks for"

**Why:** A con that does not change the user's decision is rhetorical filler; at a gate-stop it additionally misframes the correct hand-to-human action as a compromise and pressures toward continuing — the opposite of the honest signal the user needs. Honest symmetry surfaces the cons that would change or qualify the pick and states plainly when there are none.

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

### 6. "The Human Decides" Means Ratify A Recommendation — Not Fill A Blank

When a decision is reserved to the human (founder ratification, owner sign-off, a gated approval, a "clarification" the human must answer), the agent MUST still produce a full spec-grounded recommendation for **every** item. The human exercises authority by **ratifying or overriding** that recommendation — NOT by answering a blank the agent left. A "clarification packet", "decision menu", or list of open questions presented with empty answer fields for the human to fill from scratch is the MUST-1 violation in disguise and is BLOCKED.

Decide ≠ recommend. "Not an agent-decided _default_" forbids a SILENT, unstated assumption baked into code or output — it does NOT forbid a LOUD, rationale-backed, ratifiable _recommendation_. The agent always recommends; the human always decides; withholding the recommendation is never the correct expression of "the human decides."

A multi-domain decision packet (≥2 questions spanning ≥2 specialist domains) MUST have each recommendation produced by the relevant **domain specialist** (per `rules/agents.md` Specialist Delegation), so every pick is spec-grounded — a single-threaded orchestrator guess is not a spec-grounded recommendation.

`DO` (packet): each row = recommendation + spec basis + honest con + "RATIFY / OVERRIDE". `DO` (authorship): each row's pick produced by its domain specialist; the orchestrator synthesizes, does not guess. `DO NOT`: a row with an empty `→ ANSWER:` field; a recommendation cell that says "needs input" / "TBD" / "depends" (a blank in table costume); all rows guessed in one single-threaded orchestrator pass. Full examples in the guide extract.

**BLOCKED rationalizations:**

- "These are clarifications for the human to answer, not choices for me to recommend on"
- "The human / founder holds decision authority, so I should not pre-fill"
- "'Not an agent-decided default' means I must not recommend an answer"
- "Presenting the questions blank respects the human's decision authority"
- "The agent does NOT pre-fill — withholding the recommendation IS the discipline"
- "The questions are too deep / too founder-specific for me to recommend on"
- "The recommendation cell can say 'needs founder input' — that's honest"

**Why:** Withholding the recommendation under the banner of "the human decides" transfers the entire synthesis cost to the human — the exact MUST-1 failure, one indirection deeper. The human's decision authority is over the recommendation, not over a vacuum; even a deep question has a spec-closest answer the agent MUST recommend, naming the residual judgment (per MUST-1's "state which context would change the recommendation, not punt"). A decision packet remains an internal artifact — if escalated to a public/cross-repo surface it stays bound by `upstream-issue-hygiene.md` Rule 2 redaction.

### 7. A Below-Confidence Recommendation Escalates For Ratification, Regardless Of Blast-Radius

When the agent produces a recommendation it **cannot stand behind on evidence** — a pick it judges LOW-confidence (thin or absent evidence, an unfamiliar domain, a pattern-match dressed as a verified convention, a guess) — the disposition MUST be to **ESCALATE**: surface the recommendation, state the confidence explicitly, name the specific evidence that would raise it, and request the user's **ratification** BEFORE acting. This holds **regardless of how low the action's blast-radius is** — a cheap, easily-reversible, decidable ("clear") pick held at low confidence is escalated, NOT auto-executed. Auto-executing a below-confidence pick because "it is cheap and there IS a pick" is BLOCKED.

**Confidence is a third axis, orthogonal to the two loom already gates.** Blast-radius (`/autonomize` § Prudence — destructive / hard-to-reverse / shared-state actions) asks _how bad if it is wrong_; undecidability (MUST-1 — no single best option) asks _is there a pick at all_; confidence asks _can I stand behind this pick on evidence_. A decidable + low-blast-radius + low-confidence pick passes BOTH existing gates and falls through — MUST-7 is the gate that catches exactly that quadrant. Decidability ≠ confidence: one option can be clearly the front-runner AND still be a guess.

**Escalation is NOT a menu-punt — MUST-1 still binds.** The agent STILL produces the single recommendation with implications and symmetric pros/cons (MUST-1/2/3); MUST-7 adds one thing — the low-confidence pick is surfaced for ratification (a yes/no or single decision point per MUST-5) instead of auto-executed. The confidence label is part of the recommendation's quality, not a subtraction from it (per MUST-3's symmetric-honesty principle).

```markdown
# DO — low-confidence pick on a low-blast-radius action: recommend AND escalate for ratification

Recommend: name the new flag `--strict-mode` (matches the two sibling flags I found).

Confidence: LOW — I found only two siblings and could not locate the naming-convention
doc; this is a pattern-match, not a verified convention. Cheap to rename now, expensive
once consumers depend on it.

What would raise it: the naming-convention doc, or a third sibling confirming the pattern.

Ratify `--strict-mode`, or should I find the convention doc first? (ratify / find-doc)

# DO NOT — auto-execute the low-confidence-but-cheap pick

Going with `--strict-mode` (matches two siblings; cheap to rename). Done.

# (decidable + low blast-radius → both existing gates pass → the guess ships

# silently; the user never learns the "pick" was a pattern-match, not a convention)
```

**BLOCKED rationalizations:**

- "There's a clear pick, so `/autonomize` says proceed" (a _clear_ pick you can STAND BEHIND proceeds; a decidable pick held at low confidence is not the same — decidability ≠ confidence)
- "It's cheap / easily reversible, low blast-radius" (blast-radius is a different axis; MUST-7's whole point is the low-blast-radius + low-confidence quadrant Prudence does not cover)
- "Asking would be hedging" (surfacing a genuine low-confidence pick for ratification is the OPPOSITE of hedging — hedging is asking when you ARE confident; this is the honest confidence signal the user needs)
- "I made a pick, that satisfies MUST-1" (MUST-1 requires the recommendation; MUST-7 requires escalating it when you cannot stand behind it — both bind)
- "The redteam / next session will catch it if it's wrong" (a below-confidence pick is precisely the one whose error is cheapest to catch NOW, at ratification, and most expensive once acted on)
- "Stating low confidence undermines the recommendation" (an accurate confidence label is part of the recommendation's quality, not a subtraction — per MUST-3's symmetric-honesty)

**Why:** loom's autonomy model gates on blast-radius (Prudence) and undecidability (MUST-1) but NOT on confidence; a decidable, low-blast-radius pick auto-proceeds under `/autonomize` even when the agent holds it at low confidence, and the user never learns the "pick" was a guess. Confidence (can I stand behind this on evidence?) is orthogonal to blast-radius (how bad if wrong?): the low-confidence + low-blast-radius quadrant is invisible to both existing gates, so a wrong guess ships silently and surfaces later at 2–5× the cost. Escalating for ratification — while STILL recommending — is the structural defense: the user ratifies or redirects at the cheapest possible moment. External authority: SAFR v1.0 §2 — its Controls-Repository evidence-quality / minimum-confidence dimension plus the Disposition-Engine **Escalate** outcome (the two components distilled at `specs/methodology/agentic-runtime-governance.md` §1) compose to the disposition property loom adopts for its own agents: a decision below a confidence / evidence-quality threshold escalates to human review regardless of value / reversibility.

### 8. A Sensitivity/Classification Escalation Escalates For Confirmation, Regardless Of Blast-Radius

When an autonomous action would raise the **sensitivity or audience** of handled content — incorporating HIGHER-sensitivity material into a LOWER-sensitivity or WIDER-audience **durable** surface — the disposition MUST be to **CONFIRM before persisting**: name the sensitivity partition being crossed, state the lower-exposure alternative that exists, and request the user's confirmation. This holds **even when the write is mechanically cheap** — not destructive, not hard-to-reverse, not externally-visible-yet (a purely-local commit) — i.e. when it trips none of the action-type gates `/autonomize` § Prudence enumerates. Auto-persisting a sensitivity escalation because "the write is cheap and in-scope" is BLOCKED.

**The partitions** (illustrative, not exhaustive — the AGENT judges sensitivity qualitatively, NO hardcoded classification table, per `rules/agent-reasoning.md`): a secret / credential / PII into a durable artifact (commit body, journal, doc); **gitignored-per-operator** material (`loom-links.local.json`, private config, a sibling operator's local state) into a **committed shared** artifact (`.claude/team-memory/*`, `.session-notes.shared.md`, a journal entry); **tenant-scoped** content into a **global or synced** artifact.

**Sensitivity is a fourth escalation dimension the other three gates miss.** loom's autonomy gates ask three questions: blast-radius (`/autonomize` § Prudence) — _how bad if it is wrong_; undecidability (MUST-1) — _is there a pick at all_; confidence (MUST-7) — _can I stand behind this pick on evidence_. Sensitivity asks a fourth: _does this write raise the exposure / classification of the content_. The miss is at the OPERATIONAL layer: § Prudence's confirm-triggers are all **action-mechanics** (destructive / hard-to-reverse / shared-state-visible / scope-expansion / BUILD-repo), so a **mechanically-cheap** write — a purely-local commit — trips none of them **even when the content it persists is high-consequence** (a secret leak IS maximal-consequence; it is the _write mechanics_ that are cheap, not the content). Sensitivity is thus orthogonal to the action-mechanics PROXY Prudence gates on, not to consequence. The distribution disclosure fences do not close this either: Gate-1 intake, Gate-2 sync, and `publish-to-public.mjs` fire at a **distribution-pipeline boundary**, and the one authoring-time disclosure hook — `cross-ecosystem-disclosure-guard.js` (PreToolUse Edit|Write) — is dormant on canon + scoped to the fork→canon partition, so NO existing fence examines the gitignored→committed / tenant→global / secret→durable partitions at the in-repo **authoring** verdict. MUST-8 is that gate.

**Escalation is NOT a menu-punt — MUST-1 still binds.** The agent STILL recommends the write it believes is correct (or its scrubbed / lower-exposure form); MUST-8 adds one thing — the sensitivity-crossing write is surfaced for confirmation (a yes/no or single decision point per MUST-5) instead of auto-persisted.

```markdown
# DO — sensitivity-elevating write surfaced for confirmation

Recommend: commit a genericized template (`<operator-home>/repos/...`), not the
sibling's verbatim `loom-links.local.json`. Pasting the real paths would move
gitignored-per-operator layout into a committed team-memory file
(gitignored → committed-all-operators). Commit the genericized form, or do you
want the verbatim paths in the shared note? (genericize / verbatim)

# DO NOT — auto-persist the escalation because it is cheap + in-scope

Wrote the working example into team-memory (pasted the sibling's real
loom-links.local.json paths — it is just a local commit, in scope for onboarding). Done.
```

**BLOCKED rationalizations:**

- "It's a local commit, not a push — no one sees it yet" (the durable surface IS the exposure; a committed shared artifact is read by every operator on the next pull, and no distribution fence re-examines an already-committed in-repo write)
- "The disclosure scrub / Gate-2 will catch it" (those fire at a distribution-pipeline boundary — intake / sync / publish — not at the authoring verdict; the content is in git history and correlatable BEFORE any fence runs, the exact `artifact-flow.md` Intake-Scrub failure mode)
- "It's cheap / easily reversible, low blast-radius" (the write MECHANICS are cheap, but § Prudence gates on action-mechanics and misses the exposure the cheap write persists — MUST-8's whole point is that a mechanically-cheap write can still elevate sensitivity, whatever the content's consequence)
- "The content came from a file I was authorized to read" (read-authority does not carry forward to persist-and-widen — this is the per-verdict independence the sensitivity axis enforces)
- "I'll just scrub it myself, no need to confirm" (a silent self-scrub can under-redact; surfacing the partition lets the user set the exposure they intend)
- "security.md already covers secrets" (security.md is secret-scoped + advisory prose; MUST-8 is the per-verdict gate over the broader sensitivity/audience partition — gitignored→committed and tenant→global included)

**Why:** loom gates blast-radius (Prudence), undecidability (MUST-1), and confidence (MUST-7), but NOT sensitivity; a mechanically-cheap write that raises the exposure/classification of handled content passes all three and ships silently, because no loom fence examines this partition AT the authoring verdict — the intake/sync/publish fences fire only at a distribution-pipeline boundary, and the one authoring-time disclosure hook (`cross-ecosystem-disclosure-guard.js`) is dormant on canon + fork→canon-scoped, blind to the gitignored→committed / tenant→global / secret→durable partitions. Confirming at the authoring verdict — while STILL recommending the write — is the only point the escalation can be caught before the content is durable and correlatable. External authority: SAFR v1.0 §2 — the Disposition-Engine calibration on **sensitivity** (one of its five dimensions: reversibility, materiality, impact, sensitivity, novelty; distilled at `specs/methodology/agentic-runtime-governance.md` §1) composes to the disposition property loom adopts for its own agents: a write that elevates content sensitivity escalates to human confirmation regardless of value / reversibility.

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

- Auto-execute a recommendation held below the agent's confidence floor without escalating it for ratification, even on a low-blast-radius action

**Why:** Confidence is orthogonal to blast-radius; a low-confidence pick that passes the blast-radius (Prudence) and undecidability (MUST-1) gates ships a silent guess the user never got to ratify — the exact quadrant MUST-7 exists to catch.

- Auto-persist a write that raises the sensitivity or audience of handled content — a secret into a durable artifact, gitignored-per-operator material into a committed shared surface, tenant-scoped content into a global/synced one — without surfacing the partition for confirmation, even on a low-blast-radius local write

**Why:** Sensitivity is a distinct axis from all three existing gates (Prudence's action-mechanics proxy, MUST-7 confidence, MUST-1 undecidability); a mechanically-cheap sensitivity-elevating write passes all three, and no distribution fence re-examines an already-committed in-repo write — the authoring verdict is the only point the escalation can be caught.

## Trust Posture Wiring

- **Severity:** `advisory` for the hook-based detection (lexical regex match — per `rules/hook-output-discipline.md` MUST-2, lexical signals MUST NOT carry severity:block); `halt-and-report` when surfaced by a gate-level reviewer (reviewer / cc-architect) at `/codify` validation. Not block-at-tool-call (no structural signal at PreToolUse time — recommendations are prose).
- **Grace period:** MUST-1..5 — 7 days from 2026-05-06 (→ 2026-05-13). MUST-6 — 7 days from 2026-05-18 (→ 2026-05-25). During grace, the Stop-event hook logs to `violations.jsonl` for cumulative-tracking but does NOT auto-emergency-downgrade. After grace, regression contributes to the cumulative-downgrade math per `rules/trust-posture.md` MUST Rule 4 (5× total in 30d → drop posture).
- **Regression-within-grace:** if `/codify` authors a same-class violation (a recommendation that drops to a menu, hides cons, buries jargon, OR a blank-field decision packet) within the relevant grace window, emergency-downgrade per trust-posture Rule 4.
- **Receipt requirement:** SessionStart MUST require `[ack: recommendation-quality]` in the agent's first response IF the most recent `violations.jsonl` includes a `recommendation-quality/MUST-1` entry AND `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism (hook layer — IMPLEMENTED 2026-05-06):** `.claude/hooks/lib/violation-patterns.js::detectMenuWithoutPick` runs in the Stop-event chain via `.claude/hooks/detect-violations.js`. Pattern: ≥2 option markers (`Option [A-D]`, `(a)`–`(d)`, `[a]`–`[d]`) without a recommendation anchor (`I recommend`, `Going with`, `Pick:`, `My pick:`, `Recommendation:`, `My choice:`, `I'd go with`, `I'm going with`). 8 audit fixtures committed at `.claude/audit-fixtures/violation-patterns/detectMenuWithoutPick/` per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4 — covering: 2 flag cases (markers without anchor), 5 clean cases (single option, with each of three anchor forms, no options at all), 1 empty input. False-positive class: legitimate option enumerations the user explicitly asked for ("just give me the options"). Acknowledged in Scope above; the hook surfaces the candidate, the agent acknowledges in next turn or the user adjudicates.
- **Detection mechanism (review layer — semantic):** gate-level reviewer mechanical sweep at `/codify` validation: for any agent response flagged by the hook AND the response was in answer to a user choice, the reviewer confirms whether (a) the user explicitly asked for a menu (false positive — close), or (b) the response genuinely lacked recommendation/implications/pros-cons/plain-language (true positive — flag for downgrade math). Final disposition is human.
- **Detection mechanism (MUST-6 — decision packets):** `detectMenuWithoutPick` covers prose menus; a blank packet is a FILE artifact, not prose — Phase-1 detection is the `/codify` + `/redteam` gate-review (reviewer confirms any surfaced decision packet carries a recommendation per row). Phase-2 (deferred): a `PostToolUse(Write)` hook scanning decision-packet files for empty answer-field markers; detail in the guide extract.

### Trust Posture Wiring — MUST-7 (Below-Confidence Escalation)

Applies to the **MUST-7** clause (added 2026-07-05, SAFR S3 O1 origination). Per `trust-posture.md` MUST-8 grandfather cutoff, MUST-7 lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant; the pre-existing MUST-1..6 Wiring above remains grandfathered until each is itself `/codify`-touched (the clause-scoped precedent set by `rule-authoring.md`'s own Wiring section + `security.md`/`git.md`).

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm a below-confidence pick was escalated for ratification, not auto-executed); `advisory` at the hook layer (no structural signal at tool-call time — a confidence self-assessment is judgment-bearing prose, per `hook-output-discipline.md` MUST-2, and lexical detection of a "low confidence" self-label would be regex-shaped, which MUST NOT carry `block`).
- **Grace period:** 7 days from clause landing (2026-07-05 → 2026-07-12).
- **Cumulative posture impact:** same-class violations (auto-executing a below-confidence-floor recommendation without escalating it for ratification) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a confidence-self-assessment property is review-layer-only and semantic; it does not warrant a dedicated instant-drop key, and minting one would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal `regression_within_grace` trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: recommendation-quality]` IFF `posture.json::pending_verification` includes this rule_id (shared rule_id; a single ack covers MUST-1..7).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/implement` + cc-architect at `/codify` inspect any session transcript where the agent produced a recommendation while exhibiting or self-labeling low confidence, and confirm it was surfaced for ratification (recommendation + explicit confidence + evidence-that-would-raise-it + a yes/no gate) rather than auto-executed; the review-layer semantic gate-review IS the authoritative verdict (the `probe-driven-verification.md` MUST-2 LLM-as-judge shape) — a below-confidence self-label is semantic, not a lexical regex, so `detectMenuWithoutPick` does NOT cover it, and when the Phase-2 lexical detector lands it MUST pair with this review layer per `probe-driven-verification.md` MUST-4. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/recommendation-quality/below-confidence-escalation/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-7 (below-confidence auto-execution without escalation) ONLY (clause-scoped); the pre-existing MUST-1..6 Wiring stays grandfathered until each is itself `/codify`-touched.
- **Origin:** See MUST-7's inline SAFR v1.0 §2 authority + `journal/0434` (SAFR S3 O1 origination); prior chain `journal/0432`/`0433` (the SAFR conformance-mapping distillation).

### Trust Posture Wiring — MUST-8 (Sensitivity/Classification Escalation)

Applies to the **MUST-8** clause (added 2026-07-05, SAFR S1 O1 origination). Per `trust-posture.md` MUST-8 grandfather cutoff, MUST-8 lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant; the pre-existing MUST-1..6 Wiring above remains grandfathered until each is itself `/codify`-touched (the clause-scoped precedent set by `rule-authoring.md`'s own Wiring section + `security.md`/`git.md` + MUST-7's own Wiring, which — like MUST-8 — landed post-cutoff canonical-compliant, cited here as precedent for the clause-scoped shape, NOT as a grandfathered member).

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + security-reviewer when the crossed partition is secret/credential/tenant-scoped + cc-architect at `/codify` confirm a sensitivity-elevating write was surfaced for confirmation, not auto-persisted); `advisory` at the hook layer (no structural signal at tool-call time — whether a write raises sensitivity is judgment-bearing prose per `hook-output-discipline.md` MUST-2; a lexical tripwire on a gitignored-path substring appearing in a committed-file Write MAY pair as advisory but MUST NOT carry `block`).
- **Grace period:** 7 days from clause landing (2026-07-05 → 2026-07-12).
- **Cumulative posture impact:** same-class violations (auto-persisting a sensitivity/classification escalation without surfacing it for confirmation) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture). **Single-count exemption:** a secret/credential-partition violation counted under the pre-existing `critical` secret-leak trigger (→ L1, per Regression-within-grace below) is NOT ALSO counted in MUST-8's cumulative window — the critical path is terminal and single-counts it; the remaining partitions accrue via this cumulative path — PII-in-a-durable-artifact (unless the PII is itself a credential/secret routing to `critical`), gitignored-per-operator, and tenant-scoped. PII is deliberately NOT exempted from the cumulative count: `trust-posture.md` MUST-4's `critical` trigger names only "secret leak", so a PII-only escalation does not route there and MUST accrue cumulatively — the gate-review (`halt-and-report`) is its detection surface.
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a sensitivity self-assessment is review-layer-only and semantic; it does not warrant a dedicated instant-drop key, and minting one would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal `regression_within_grace` trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition MUST-7, `security.md` § Enforcement-Surface Parity, and `git.md` § CI-check/merge took. A secret/credential leak into a committed artifact that ALSO trips the pre-existing `critical` (secret leak → L1) emergency trigger in `trust-posture.md` MUST-4 routes THERE, unchanged — MUST-8 adds no new key AND (per the single-count exemption above) does not additionally accrue it in the cumulative window.
- **Receipt requirement:** SessionStart soft-gate `[ack: recommendation-quality]` IFF `posture.json::pending_verification` includes this rule_id (shared rule_id; a single ack covers MUST-1..8).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/implement` + security-reviewer (secret/tenant partitions) + cc-architect at `/codify` inspect any session transcript where the agent persisted content into a durable/committed/synced surface that raised its sensitivity or audience, and confirm it was surfaced for confirmation (partition named + lower-exposure alternative stated + yes/no gate) rather than auto-persisted; the review-layer semantic gate-review IS the authoritative verdict (the `probe-driven-verification.md` MUST-2 LLM-as-judge shape) — sensitivity elevation is semantic, not a lexical regex, so no existing hook detector covers it, and when a Phase-2 lexical tripwire lands (e.g. a gitignored-path substring in a committed-file Write) it MUST pair with this review layer per `probe-driven-verification.md` MUST-4. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/recommendation-quality/sensitivity-escalation/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-8 (sensitivity/classification-escalation auto-persist without confirmation) ONLY (clause-scoped); the pre-existing MUST-1..6 Wiring stays grandfathered until each is itself `/codify`-touched (MUST-7 is post-cutoff canonical, not grandfathered).
- **Origin:** See MUST-8's inline SAFR v1.0 §2 authority + `journal/0436` (SAFR S1 O1 origination); sibling `journal/0434` (the S3/MUST-7 confidence-axis, same fourth-axis shape) + prior chain `journal/0432`/`0433` (the SAFR conformance-mapping distillation).

## Relationship to existing rules

Extends:

- `rules/communication.md` § "Explain Choices in Business Terms" — that rule says explain in business terms; this rule says ALSO recommend (don't just explain).
- `rules/communication.md` § "Frame Decisions as Impact" — that rule says present impact; this rule says present a recommendation alongside the impact.
- `feedback_directive_recommendations.md` (user memory) — that note says "Always recommend based on rigor/completeness/accuracy/optimality; never option-menus without a pick. On 'proceed'/'continue', execute" — this rule lifts the user feedback into a structural defense.

Distinct from:

- `rules/autonomous-execution.md` — that rule governs WHAT the agent recommends (autonomous-framing assumptions); this rule governs HOW the recommendation is delivered.
- `rules/time-pressure-discipline.md` — that rule's MUST Rule 3 (Prioritization MUST Be Suggested, Not Auto-Picked) IS the recommendation-quality shape applied to pressure-driven prioritization. When the user signals time pressure and ≥2 outstanding tasks are eligible, the agent MUST surface a prioritized list with rationale per this rule's Rules 1–3, not unilaterally pick the top item.
- `rules/user-flow-validation.md` MUST-6 (scrub receipts before embedding in PR/commit/journal/session-notes that may sync) and MUST-8 here **STACK, not conflict**, on the secret-into-durable-artifact case: MUST-6 mandates the SCRUB (remove secrets/downstream tokens before embedding); MUST-8 mandates the CONFIRM (surface the sensitivity partition so the user sets the exposure). An agent embedding sensitive content into a committed/synced artifact owes both — scrub per MUST-6 AND confirm per MUST-8. MUST-6 is receipt-scoped + sync-boundary-oriented; MUST-8 is the per-verdict authoring-time gate over the broader sensitivity/audience partition.

Origin: 2026-05-06 — user directive after observing recommendations that surfaced options without picks AND used technical framings without translation: "please add in a strong rule that agent is not supposed to suggest without giving recommendations with implications, pros and cons, and easy-to-understand less technical expositions. This is critical." The user feedback memory `feedback_directive_recommendations.md` (2026-04-22) had captured the principle; this rule structurally enforces it as a MUST clause with detection + grace-period wiring.

Origin (MUST-6): 2026-05-18 — a Rust SDK session. The agent built a 22-question founder clarification packet as a blank menu — every `→ ANSWER:` field empty, prose stating "the agent does NOT pre-fill." User: "why aren't you using a team of agents, ultrathink, and recommend according to our specs?" Root cause: conflating "don't agent-**decide** a silent default" (correct) with "don't agent-**recommend**" (wrong). Correction: a 6-specialist team produced 23 spec-grounded recommendations; the packet was rewritten to carry pick + spec basis + con + ratify/override per row. User then directed proper codification ("don't just rely on memory, codify it properly"). Self-referential `/codify` per `self-referential-codify.md` Rule 2 — landed BUILD-side with a 3-agent redteam (reviewer / security-reviewer / cc-architect), verdict MERGE-WITH-FIXES, all CRIT/HIGH/MED fixes applied in that codify.

Origin (MUST-7): 2026-07-05 — SAFR S3 O1 origination (below-confidence escalation; the third autonomy axis). Receipt `journal/0434`; convergence `journal/0435`. Origin (MUST-8): 2026-07-05 — SAFR S1 O1 origination (sensitivity/classification escalation; the fourth autonomy axis, surfaced when an independent redteam refutation broke the initial "loom already holds the invariant" close). Receipt `journal/0436`.

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Rule body is ~390 lines, over the 200-line guidance. Named rationale: **autonomy-axis-completeness scope** — the rule codifies the eight-clause recommendation contract (a six-clause recommendation core — MUST-1..6: recommend-not-menu + implications + symmetric cons + plain-language + resolve-the-question + decision-packet-ratification — PLUS the two orthogonal autonomy-escalation axes SAFR surfaced, MUST-7 confidence + MUST-8 sensitivity, = eight clauses total), each carrying the DO/DO-NOT + BLOCKED-corpus + `**Why:**` the meta-rule mandates AND the canonical 8-field Trust-Posture Wiring (`trust-posture.md` MUST-8) the post-cutoff clauses require. The rule is `priority: 10` + `scope: path-scoped`, so it pays NO baseline-emission cost (loaded only in matching sessions) and Rule 10's proximity-band gate does NOT fire. Splitting the axes into sibling rules would fragment the "the agent recommends AND escalates on these orthogonal axes" contract across files and force cross-rule lookups at every recommendation. Per `rule-authoring.md` MUST NOT § "Rules longer than 200 lines": overage is permitted with named rationale anchored at Origin. Sibling precedent: `artifact-flow.md` + `cc-artifacts.md` length rationales.
