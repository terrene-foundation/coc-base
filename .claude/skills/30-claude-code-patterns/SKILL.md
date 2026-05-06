---
name: claude-code-patterns
description: "Claude Code architecture — artifact design, context, agentic patterns. For CC audit/build."
allowed-tools:
  - Read
  - Glob
  - Grep
---

# Claude Code Architecture Patterns

Reference patterns for designing effective Claude Code artifacts and understanding CC's internal architecture.

## Quick Reference: Artifact Types

| Type    | Layer           | Purpose                     | Token Target             | Quality Test                         |
| ------- | --------------- | --------------------------- | ------------------------ | ------------------------------------ |
| Agent   | L1 Intent       | Teach judgment + procedure  | 150-400 lines            | Completes task without clarification |
| Skill   | L2 Context      | Teach knowledge + reference | 150-250 lines (SKILL.md) | Answers 80% of routine questions     |
| Rule    | L3 Guardrails   | Enforce boundaries          | 50-150 lines             | Zero violations in scope             |
| Command | L4 Instructions | Orchestrate workflows       | 50-150 lines             | Predictable, verifiable output       |
| Hook    | L3 Guardrails   | Deterministic prevention    | 20-80 lines (JS)         | 100% enforcement, no exceptions      |

## Agentic Architecture Patterns

### The Agentic Loop

```
send → check stop_reason → execute tools → append → repeat
```

- `stop_reason == "end_turn"` is the ONLY termination signal
- Never parse text for "I'm done" (natural language termination)
- Never use arbitrary iteration caps (trust the model's signal)
- Claude returns text AND tool_use in the same response — check stop_reason, not content type

### Multi-Agent Memory Isolation

Subagents do NOT share memory with coordinator or each other. All context must be passed explicitly via structured metadata (source URLs, doc names, page numbers).

### Attention Dilution

14+ items in single pass → inconsistent depth. Fix: per-item analysis pass, then cross-item synthesis pass.

### Session Management

| Strategy        | When                           | Mechanism                     |
| --------------- | ------------------------------ | ----------------------------- |
| Resume          | Same task, no external changes | `--resume`                    |
| Fork            | Explore alternative approach   | Parallel worktrees            |
| Fresh + Summary | Stale context, switching focus | New session + `/wrapup` notes |

## Tool Design Patterns

### Descriptions Are Selection Mechanism

Tool descriptions are for the MODEL, not humans. Include: what it does, inputs, example queries, boundaries vs similar tools.

### 4-5 Tool Limit Per Agent

18+ tools → <70% selection accuracy. Split into specialized subagents.

### Error Categories

| Category   | Retryable | Action               |
| ---------- | --------- | -------------------- |
| Transient  | Yes       | Wait and retry       |
| Validation | After fix | Fix input, retry     |
| Business   | No        | Alternative workflow |
| Permission | No        | Escalate             |

Distinguish access failure ("DB unreachable") from valid empty result ("no orders found").

## Prompt Engineering Patterns

### Explicit Criteria Beat Vague Instructions

"Be conservative" → fails intermittently. "Flag only when claimed behavior contradicts code" → reliable.

### Few-Shot: 2-4 Examples with Reasoning

Include a "resist extraction" example (when NOT to act). Reasoning blocks teach generalization, not pattern matching.

### Schema Design

- `"type": ["string", "null"]` for optional fields (not `"nullable": true`)
- `"unclear"` enum value for genuine ambiguity
- `"other"` + detail field for extensible categories
- Only `required` fields that are always in the source — required = fabrication pressure

### Validation-Retry Boundaries

Works for: format errors, structural errors, misplaced values.
Fails for: information not in source, fabrication, genuine ambiguity.

## Context Management Patterns

### Progressive Summarization Trap

Transactional data ($247.83, order #8891) gets compressed to "customer wants refund." Fix: persistent case facts block, never summarized.

### Lost-in-the-Middle

Critical info at beginning/end of context. Middle gets less attention. Trim tool results to needed fields.

### Hooks vs Prompts Decision

| Stakes                         | Enforcement                 |
| ------------------------------ | --------------------------- |
| Money, security, compliance    | Hook (100% deterministic)   |
| Style, formatting, preferences | Prompt (~95% probabilistic) |

## Token Efficiency Patterns

1. **Path-scope rules** via YAML frontmatter globs (60-80% savings)
2. **Progressive disclosure** in skills: SKILL.md summary vs full directory
3. **Agent descriptions** under 120 chars (loaded on every selection)
4. **Commands** are prompts (50-150 lines), not documentation
5. **Don't duplicate CLAUDE.md** in rules — CLAUDE.md is always loaded
6. **Consolidate overlapping rules** — one rule beats five saying similar things

## Detailed Reference

- **[Artifact Design Guide](artifact-design.md)** — Templates, frontmatter, structural patterns
- **[Anti-Patterns Catalog](anti-patterns.md)** — Common mistakes and fixes
- **[Token Budget Guide](token-budget.md)** — Measurement and optimization
- **[Parallel Merge Workflow](parallel-merge-workflow.md)** — Merging 5+ parallel worktree changes to the same file via specialist delegation
- **[Worktree Orchestration Protocol](worktree-orchestration.md)** — Extended evidence + post-mortems for `rules/agents.md` worktree MUSTs and `rules/worktree-isolation.md`

## When to Use This Skill

- Creating a new agent, skill, rule, command, or hook
- Auditing existing artifacts for quality
- Optimizing token efficiency of the `.claude/` directory
- Understanding how CC components interact

## Support

- **cc-architect** — Primary expert for CC artifact work
- `co-reference` skill — CO methodology (principles, layers)
- `co-reference` skill — COC methodology (five-layer implementation)
