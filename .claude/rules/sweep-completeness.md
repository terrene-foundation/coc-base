---
priority: 10
scope: path-scoped
paths:
  - ".claude/commands/sweep.md"
  - ".claude/commands/redteam.md"
  - ".claude/commands/codify.md"
  - ".claude/commands/wrapup.md"
  - ".claude/commands/cc-audit.md"
  - ".claude/commands/cli-audit.md"
  - ".claude/commands/i-audit.md"
  - ".claude/commands/i-harden.md"
  - ".claude/commands/i-polish.md"
  - ".claude/skills/sweep/**"
  - ".claude/skills/redteam/**"
  - ".claude/skills/codify/**"
  - ".claude/skills/spec-compliance/**"
  - "**/redteam-*.md"
  - "**/sweep-*.md"
  - "**/04-validate/**"
---

# Sweep / Multi-Step Protocol Completeness

See `.claude/guides/rule-extracts/sweep-completeness.md` for the full BLOCKED-rationalization enumeration, extended DO/DO NOT examples, the cross-rule relationship list, the tool-backing pattern, and the 2026-05-04 origin post-mortem.

When a skill, command, or rule prescribes a multi-step protocol and the agent identifies any step as too expensive / "needs separate trigger" / "deferrable to /redteam" / "out of sweep tempo", the agent MUST stop and ask the human BEFORE substituting a cheaper proxy. Silent substitution is BLOCKED. Appeal to precedent ("yesterday's sweep skipped this step too") does NOT authorize today's substitution — yesterday's skip was its own failure.

The substitution decision is the trigger. The human is the gate.

## MUST Rules

### 1. Substitution Decision Triggers a Human Gate

When the agent identifies a mandated step as too expensive to run inline AND the skill/command/rule does not explicitly authorize the substitution, the agent MUST stop and surface to the human: WHICH step is being skipped, WHY (cost / time / "needs trigger"), WHAT proxy is being considered, WHAT coverage is lost, and ASK skip / substitute / run-full / different-approach.

```markdown
# DO — surface the substitution decision

The skill's Sweep 5 says "per spec, grep MUST symbols + Tier 2 coverage."
That is /redteam-shaped (~10–30 min). I'm considering substituting
`tools/spec-cite-check.py --strict` (~1s) which verifies path/rule
references resolve — does NOT verify symbol presence in source or
test coverage. Skip / substitute / run full step / different approach?

# DO NOT — silent substitution

[runs cite-check, reports `0/0/0` as Sweep 5 result, ships clean]
```

**BLOCKED rationalizations:** "yesterday's sweep substituted, today's can too" / "the cheap tool is green, that's evidence enough" / "the expensive step needs a trigger we don't have" / "asking is bureaucracy" — full list in extract.

**Why:** Substitution feels efficient and goes invisibly until someone asks "what did you actually check?" By then the report has shipped, the next session inherits the framing, and the gap silently widens.

### 2. Proxy Output MUST Be Labeled, Never Relabeled

If the agent substitutes a cheap proxy after human-gated approval, the proxy's output MUST be labeled with the proxy's own name in the report — never as the mandated step's result. `Sweep 5: 0/0/0 cite-check (substituted per user approval)` is fine. `Sweep 5: 0/0/0 (clean)` is BLOCKED.

**Why:** A reader of the sweep report cannot tell, from the second form, that the mandated step did not run. The agent's substitution becomes invisible institutional knowledge.

### 3. Skill / Command Text Tightening Is The Long-Term Fix

When a skill repeatedly produces substitution decisions, the skill text itself is the leverage point — propose a `/codify` upstream that either (a) tightens prose into a tool invocation (e.g., `commands/sweep.md` Sweep 5 → `tools/sweep-redteam.py` invocation), or (b) explicitly authorizes substitution with named bounds. This rule is run-time defense; tool-backed skill text is design-time defense. Both layers needed.

**Why:** A rule that fires every cycle is a signal that the structural defense is wrong. Recurring substitutions need design-time tooling so the gate stops firing.

## MUST NOT

- Silently substitute a cheaper tool for a mandated multi-step protocol step

**Why:** This is the originating failure mode — invisible to readers, propagates as institutional drift.

- Cite "yesterday's sweep did the same" as authorization

**Why:** Yesterday's substitution was its own failure; treating it as precedent compounds the gap.

- Label the proxy's output as the mandated step's result

**Why:** It removes the audit trail that allows the next reader to know the mandated step didn't run.

**Distinct from**: `rules/time-pressure-discipline.md` — that rule blocks procedure drops triggered by **user pressure framings** ("speed up", "deadline looming"); this rule blocks procedure drops triggered by the **agent's own cost calculus** ("the expensive step needs a trigger we don't have"). Different triggers, overlapping defense. Both halves required: the agent can rationalize a substitution either way.

Origin: 2026-05-04 — `/sweep` reported 0 CRIT/HIGH after substituting cite-check (~1s) for the mandated Sweep 5 protocol (~10–30 min). User: "what did you check on sweep command?" — exposing that `0 HIGH, 0 MED, 0 LOW` cite-check was relabeled as Sweep 5 result. The cheap tool answered a different question; the agent shipped the answer as if it were the question. See guide for full post-mortem and tool-backing pattern.
