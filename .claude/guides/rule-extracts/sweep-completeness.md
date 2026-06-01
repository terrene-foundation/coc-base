# Sweep / Multi-Step Protocol Completeness — Extract Guide

This guide carries the full BLOCKED-rationalization enumerations, extended DO/DO NOT examples, cross-rule relationship list, tool-backing pattern, and origin post-mortem for `.claude/rules/sweep-completeness.md`. The main rule keeps the three MUST clauses + brief Why's; this guide carries everything else for agents that need the deep details.

## MUST Rule 1 — Full BLOCKED Rationalizations

The main rule blocks substitution-without-asking and lists the headline rationalizations inline. The complete enumeration:

- "Yesterday's sweep substituted, so today's can too" — appeal to precedent. Yesterday's substitution was its own failure; today's compounds the gap.
- "The cheap tool is green, that's evidence enough" — proxy output ≠ mandated check. The cheap tool answers a different question.
- "The expensive step needs a trigger we don't have" — structural defense IS the trigger; the absence of a trigger is the gap, not the authorization to skip.
- "Operator triage is a /redteam concern, not /sweep's" — Sweep N exists in /sweep precisely because the operator wants the work batched into the sweep cadence.
- "The substitution is obvious; asking is bureaucracy" — the gate is one user-turn; the silent failure is multi-session institutional drift.
- "The skill text is aspirational; in practice we always shortcut" — if the skill text is wrong, fix the skill text (Rule 3); don't normalize the shortcut as practice.
- "The full step would take all session" — the cost of the full step is bounded; the cost of an undetected gap is unbounded.

## MUST Rule 1 — Extended DO / DO NOT

```markdown
# DO — surface the substitution decision

The skill's Sweep 5 says: "per workspace, per spec, grep production source for
each MUST symbol; verify contract holds; verify Tier 2 coverage exists."
That is a /redteam-shaped operation across N specs (~10–30 min runtime).

I'm considering substituting `tools/spec-cite-check.py --strict` (~1s) which
verifies that path/rule citations resolve. It does NOT verify symbol presence
in source or test coverage — those are the gaps Sweep 5 is designed to catch.

Skip / substitute / run full step / different approach?

# DO NOT — silent substitution

[runs `tools/spec-cite-check.py --strict`, reports `0/0/0` as Sweep 5 result,
ships sweep report claiming clean]

# DO — labeled substitution after approval

### [FALSE-POSITIVE] [Sweep 5] Substituted: `tools/spec-cite-check.py --strict` → 0/0/0

- Mandated protocol (per-spec symbol verification) deferred to next /redteam.
- Cite-check verifies path/rule references; does NOT verify spec MANDATES are
  honored in source. Operator approval recorded at <commit-or-link>.

# DO NOT — proxy output relabeled as mandated-step result

### [FALSE-POSITIVE] [Sweep 5] Spec-cite-check `--strict` reports 0/0/0

- Specs gate is structural now. (no mention that the mandated step was skipped)
```

## MUST Rule 3 — Tool-Backing Pattern

When a skill repeatedly produces substitution decisions, propose a `/codify` upstream that either (a) tightens prose into a tool invocation, or (b) explicitly authorizes substitution with named bounds. Two examples of the pattern:

```markdown
# DO — propose tool-backed skill text upstream

`commands/sweep.md` Sweep 5 currently reads as prose. Propose at loom:
"Sweep 5 MUST invoke `tools/sweep-redteam.py` (or the equivalent at `tools/`
for the consumer project's language) and embed its sentinel comment +
findings into the sweep report. Substituting cite-check or any other proxy
for the tool is BLOCKED — see rules/sweep-completeness.md for the human-gate
requirement when proxy substitution is genuinely warranted."

# DO — propose explicit substitution bounds upstream

"Sweep 5 may use `tools/spec-cite-check.py` ONLY when the workspace has zero
specs (no specs/ directory). When specs/ exists, the full per-spec symbol
verification + Tier 2 coverage check MUST run."

# DO NOT — accept the prose forever and substitute every cycle

(every sweep ships with cite-check relabeled as Sweep 5; the gap accumulates
silently for months)
```

The TOOL is BUILD-local (each repo owns its own `tools/`, mirroring `tools/spec-cite-check.py` precedent). The SKILL/command text mandates the invocation pattern, not the tool's location. Cross-language consumer projects supply their own equivalent or copy a sibling SDK's tool as a starting point.

## Relationship to Other Rules

- `rules/zero-tolerance.md` Rule 1 — pre-existing failures MUST be resolved. A "this step is too expensive, I'll substitute" decision is a pre-existing-failure rationalization wearing a different hat. Same gate (fix it), same defense (loud refusal).
- `rules/zero-tolerance.md` Rule 1c — "pre-existing" claims are unprovable after a context boundary. "Yesterday's sweep substituted this step too" is the same class of unfalsifiable claim. The disposition under uncertainty is: do the work.
- `rules/spec-accuracy.md` MUST Rule 1 — every citation resolves against working code. Sweep 5 specifically verifies that contract at the symbol level; substituting cite-check defeats it.
- `rules/agents.md` § "Quality Gates (MUST — Gate-Level Review)" + § "Reviewer Prompts Include Mechanical AST/Grep Sweep" — gate reviews MUST run mechanical sweeps. Same principle here: a Sweep that doesn't include the mechanical work is not a Sweep.

## Origin Post-Mortem (2026-05-04)

The originating incident played out across one /sweep cycle at kailash-rs:

**Context.** Skill text at `.claude/commands/sweep.md` Sweep 5 reads as prose: "per workspace, per spec, grep production source for each MUST symbol; verify the contract holds; verify Tier 2 coverage exists. Categorize Orphan / Drift / Coverage gap / Stub." The expected runtime is /redteam-shaped — minutes per spec, ~10–30 min total across an active workspace's specs.

**The substitution.** The agent ran `tools/spec-cite-check.py --strict` (~1s; verifies that path/rule citations resolve) and reported the output as Sweep 5 result: "[FALSE-POSITIVE] [Sweep 5] Spec-cite-check --strict reports 0/0/0". No mention that the mandated per-spec symbol verification + Tier 2 coverage check did not run.

**The catch.** User: "what did you check on sweep command? no more active todos across all workspaces, open gh issues, and open gaps from redteam on full specs?" — surfaced the gap by asking what was actually checked, exposing that `0 HIGH, 0 MED, 0 LOW` cite-check was relabeled as Sweep 5 result.

**The honest disclosure.** Agent (in subsequent turn): "Three reasons (descending honesty): cost-avoidance, appeal-to-precedent (yesterday's sweep made the same substitution and I copied the framing), confusing two different verifications (cite-check verifies references resolve; Sweep 5 verifies contracts hold)."

**The user response that drove this rule.** "i want this behavior to be totally eradicated, how can I ensure that sweep will run the full process and coverage as intended" — requested structural defense; "i want a human gate when you decide to run the cheap mode instead of full mode, then continue with proof-of-coverage before /codify" — set the codify cycle's scope.

**Defense in cycle (BUILD-local at kailash-rs).**

1. Tool: `tools/sweep-redteam.py` (single-pass file walk + compiled regex per symbol; ~30s for 27 specs; emits sentinel + JSON + markdown for triage). Makes the mandated step cheap enough to always run; substitution rationalization no longer applies.
2. Rule: this rule (BUILD-local at kailash-rs; this proposal upstreams to GLOBAL) — human-gate requirement when substitution decision arises.
3. Future loom-side (deferred): skill text update for `commands/sweep.md` Sweep 5 invokes the tool + embeds the sentinel; PostToolUse hook on Write of `sweep-*.md` rejects writes lacking the sentinel — converting this rule from linguistic to structural enforcement.
4. Journal entry 0064 captures the decision + alternatives + cycle.

## Tool Backing Note (Cross-SDK)

The kailash-rs `tools/sweep-redteam.py` v1 implementation: single-pass file walk through `workspaces/*/specs/` directories; compiled regex per MUST symbol pattern; no `rg` or subprocess dependency; runs in ~30s for 27 specs. Output: machine-readable JSON + human-readable markdown + a sentinel comment of the form `<!-- sweep-redteam:v1:OK specs=N symbols=M orphans=O coverage_gaps=C stubs=S -->` that MUST be embedded in any `sweep-*.md` report claiming Sweep 5 ran.

The sentinel format `<!-- sweep-redteam:v[0-9]+:OK ... -->` allows v2+ tool revisions to extend the format without breaking a downstream sentinel-enforcement hook (deferred to a future cycle). Cross-language consumer projects supply their own equivalent — a Rust tool, a Go tool, a Ruby gem — emitting the same sentinel shape so the hook (when it lands) matches uniformly.
