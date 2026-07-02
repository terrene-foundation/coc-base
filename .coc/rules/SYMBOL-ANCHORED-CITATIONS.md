---
id: "SYMBOL-ANCHORED-CITATIONS"
paths: ["**/specs/**", "**/workspaces/**/specs/**", "**/02-plans/**", "**/01-analysis/**", "**/briefs/**", "**/todos/**", "**/journal/**"]
---

# Symbol-Anchored Citations — Cite Code By Grep-Stable Anchor, Not Bare Line Number

A code reference in a durable planning artifact (spec, plan, todo, brief, journal, analysis) is a NAVIGATION POINTER: the next reader follows it to find the cited code. A bare line number (`foo.mjs:471`) is invalidated by ANY insertion above it — most often by the CITING session's own later edits shifting the lines — and then silently points at the wrong code. A grep-stable anchor (the function / class / `const` name, or a `§section` heading) survives every edit: one `grep` recovers the location regardless of line drift. This rule mandates the grep-stable anchor as the PRIMARY; a line number is permitted only as a paired, disposable hint.

Origin: 2026-06-30 — co-owner relayed a sibling loom-command's feedback (three line-number citations in spec/todos broke on edit, twice from the citing session's own edits shifting lines); receipt-first DECISION `journal/0375`. Co-owner-directed origination per `rules/artifact-flow.md`.

## MUST Rules

### 1. The Primary Anchor MUST Be Grep-Stable (Symbol Or `§Section`), Never A Bare Line Number

Every code reference in a durable planning/spec/todo/journal artifact MUST anchor on a grep-stable token — a function / class / method / `const` / config-key name, OR a `§section` heading — that survives line drift. A bare `<path>:<NNN>` (or `<path>:<NNN-MMM>`) as the SOLE locator is BLOCKED.

```markdown
# DO — grep-stable symbol / section anchor (survives any edit to the file)

`resolveCanonTip()` in `sync-from-canon-fetch.mjs` returns the verified canon tip.
The split rule is `artifact-flow.md` § "loom Splits, Never Originates".

# DO NOT — bare line number as the sole anchor (breaks on the next edit above it)

The canon tip resolver is at `sync-from-canon-fetch.mjs:337`.
The split rule is at `artifact-flow.md:139`.
```

**BLOCKED rationalizations:**

- "The line number is fine for now"
- "I'll fix the line if it drifts"
- "The reader can scroll to find it"
- "Line numbers are more precise than a symbol name"
- "The cited file won't change"
- "/redteam will catch a stale line"
- "It resolved at merge, that's enough" (resolution-at-merge is `spec-accuracy.md` Rule 1; this rule is durability-over-time)

**Why:** A line number encodes a position that the next edit destroys — and the most frequent editor of a cited file is the same session that wrote the citation, so the citation is often stale before it is even read. The symbol anchor is recoverable with one `grep` no matter how the file is re-shaped; it is the only anchor that self-heals.

### 2. A Line Number Is A Paired, Disposable Hint — Never The Sole Anchor

When a line number genuinely aids navigation (a long file, a specific call site), it MUST accompany the grep-stable symbol, never replace it: the symbol is the recovery anchor, the line is convenience. A line range that pairs with a named contract (the `zero-tolerance.md` Rule 3e claim-bounding shape) satisfies this — the named contract IS the symbol.

```markdown
# DO — symbol primary, line as a paired hint (citation self-heals if the line drifts)

`checkO1Citation()` (`o1-citation-check.js`, ~line 181) validates the receipt shape.
Method list per `zero-tolerance.md` Rule 3e: the handlers at `dispatch.rs:88-140`
(the `register_*` block).

# DO NOT — bare line / line-range with no symbol to recover from

See `o1-citation-check.js:181`.
The handlers are at `dispatch.rs:88-140`.
```

**BLOCKED rationalizations:**

- "The line alone is shorter"
- "Everyone uses bare line numbers"
- "The symbol is implied by context"
- "The line range already bounds it, a symbol is redundant"

**Why:** The pairing is what makes the citation self-healing: when the line drifts, the reader greps the symbol and finds the new location; with no symbol, a drifted line is an unrecoverable dead pointer. The line is the convenience, the symbol is the contract.

### 3. Plan/Spec Citations Feeding A Delegation Prompt Carry The Symbol And Instruct Re-Resolution

When a citation from a spec/plan/todo is injected into a delegation prompt (the orchestrator hands an agent "build on `X`"), the orchestrator MUST pass the grep-stable SYMBOL and instruct the agent to RE-RESOLVE it against the current file before building — NOT pass a line the agent is told to trust. The plan's line numbers are presumed drifted by build time (prior shards merged, the file moved).

```markdown
# DO — delegation prompt carries the symbol + a re-resolve instruction

"Reuse `resolveCanonTip` + the `_internal` guard battery in
`sync-from-canon-fetch.mjs`. Re-grep for the actual symbols + their current
locations before building — the plan's line citations may have drifted."

# DO NOT — hand the agent a line and tell it to trust it

"Reuse the guard battery at `sync-from-canon-fetch.mjs:471` and the resolver at `:337`."
```

**BLOCKED rationalizations:**

- "The cited line is current, the agent can trust it"
- "Re-resolving wastes the agent's budget"
- "The plan was just written, the line is fresh"
- "The agent will figure out the right line if it's off"

**Why:** Between `/todos` (when the line was cited) and `/implement` (when the agent reads it) the file has usually moved — prior shards merged, the spec was edited during convergence. An agent that trusts a drifted line builds against the wrong code or stalls; an agent handed the symbol greps it in one step. This is the codification of the mitigation this rule's Origin session applied by hand.

## MUST NOT

- Cite code in a durable planning/spec/todo/journal artifact by a bare line number with no grep-stable symbol or `§section` anchor

**Why:** The bare line is the dead-pointer failure mode this rule exists to block — invalidated by the next edit, unrecoverable without a symbol.

- Strip the symbol from a citation "because the line is more exact"

**Why:** Exactness that the next edit destroys is worse than a stable anchor — the precise-but-stale pointer reads as authoritative and misdirects.

- Inject a bare-line citation into a delegation prompt as a trusted locator

**Why:** Plan lines are presumed drifted by build time; a trusted stale line sends the agent to the wrong code or stalls it.

## Trust Posture Wiring

- **Severity:** `advisory` at the hook layer (lexical bare-line-citation detection cannot carry `block` per `rules/hook-output-discipline.md` MUST-2); `halt-and-report` at gate-review (reviewer / cc-architect at `/codify` confirm every code citation in spec/plan/todo/journal diffs carries a grep-stable anchor).
- **Grace period:** 7 days from rule landing (2026-06-30 → 2026-07-07).
- **Cumulative posture impact:** same-class violations (a durable-artifact code citation anchored on a bare line number) contribute to `rules/trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** any same-class violation within 7 days routes through the GENERIC `regression_within_grace` emergency trigger per `rules/trust-posture.md` MUST Rule 4 (1× = drop 1 posture) — no dedicated trigger key, so no edit to the self-referential `trust-posture.md` is required.
- **Receipt requirement:** SessionStart MUST require `[ack: symbol-anchored-citations]` in the agent's first response IFF `posture.json::pending_verification` includes this rule_id (set at land-time, cleared after grace). Soft-gate.
- **Detection mechanism:** Phase 1 — review-layer mechanical sweep at `/codify`. cc-architect / reviewer greps the spec/plan/todo/journal diff for `<path.ext>:<NNN>` (or `:<NNN>-<MMM>`) citations NOT adjacent to a grep-stable symbol or `§` — adjacency is the same backtick group / same sentence for a bare `:<NNN>`, widened to the same PARAGRAPH for a `:<NNN>-<MMM>` range so a legitimate `zero-tolerance.md` Rule 3e claim-bounding range (which pairs the named contract in the same paragraph) is not over-flagged. Phase 2 (deferred per `rules/trust-posture.md` § Two-Phase Rollout, after ≥3 real sessions exercise Phase 1): a `.claude/hooks/lib/violation-patterns.js::detectBareLineCitation` advisory detector on PostToolUse(Edit|Write) scoped to the `paths:` globs, paired with the review-layer probe per `rules/probe-driven-verification.md` MUST-4. Audit fixtures land WITH the Phase-2 detector at `.claude/audit-fixtures/symbol-anchored-citations/` per `rules/cc-artifacts.md` Rule 9.
- **Violation scope:** MUST 1 (grep-stable primary anchor), MUST 2 (line as paired hint), MUST 3 (delegation re-resolution). Every `violations.jsonl` row records which MUST clause fired.
- **Origin:** See § Origin.

## Distinct From / Cross-References

- **Extends** `rules/spec-accuracy.md` Rule 1 (every cited symbol resolves via grep/ast at MERGE time) — that rule governs WHETHER a citation resolves at write time; this rule governs the anchor SHAPE so resolution SURVIVES later edits. Symbol anchors satisfy Rule 1 more durably than line anchors.
- **Reconciles** `rules/specs-authority.md` Rule 9 (cite a canonical artifact by `<path>:<line>` OR `<path> §<section>`) — this rule makes the `§section`/symbol form the REQUIRED primary; R9's `:line` alternative is the MUST-2 paired-hint case.
- **Reconciles** `rules/zero-tolerance.md` Rule 3e (doc walk-back claims cite `<path>:<start>-<end>`) — 3e's line RANGE is a claim-BOUNDING device that already pairs with the named contract (method / handler / `const`); the named contract IS the MUST-2 symbol, so 3e is NOT the bare-nav-pointer this rule blocks. 3e is left unchanged.
- **Same family as** `rules/verify-claims-before-write.md` (durable-artifact code-claims) — that governs WHETHER the claim was verified; this governs HOW the citation is anchored for stability.
- **Pairs with** `rules/cross-cli-artifact-hygiene.md` — a grep-stable symbol anchor is also CLI-neutral (no per-CLI line surface), so it serves portability and stability together.

## Origin

2026-06-30 — co-owner relayed a sibling loom-command session's feedback: _"Three times, a citation with a line number in the spec/todos broke the moment I edited the cited file — twice from my own edits shifting the lines. Root-cause fix: every code reference in the spec, todos, and plan is now symbol-based (grep-stable), not line-based. This is a cross-project discipline worth codifying."_ Co-owner-directed origination per `rules/artifact-flow.md` § Co-Owner-Directed Origination; receipt-first DECISION `journal/0375`. Independently corroborated this session: the `#576-S2` plan ((loom-internal reference)) cited code by line (`:471` / `:337` / `:57-69` / `:405-410`) and the orchestrator had to instruct the Wave-1 worktree agents to re-resolve the symbols because line numbers drift (MUST-3); the `#722` cert-anchor repairs (`§5:118→119`) earlier this session were line-drift fixes of the same class.
