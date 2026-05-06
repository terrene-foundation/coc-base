# CC Artifact Anti-Patterns

Common mistakes when creating or modifying Claude Code artifacts, organized by artifact type.

## Agent Anti-Patterns

### 1. Knowledge Dump Agent

**Symptom**: Agent file is 500+ lines, most of it reference material.
**Why it's wrong**: Agent context competes with task context in the token budget. Embedded reference material loads on every invocation.
**Fix**: Extract knowledge into a skill directory. Agent references the skill. Agent file stays under 400 lines.

### 2. Vague Description

**Symptom**: `description: "Helps with development tasks"`
**Why it's wrong**: Claude cannot reliably select this agent because the trigger is too broad. Every task is a "development task."
**Fix**: `description: "DataFlow database specialist. Use when implementing database models, CRUD operations, or bulk data processing."`

### 3. Missing Output Format

**Symptom**: Agent instructions say "produce a report" or "analyze and respond."
**Why it's wrong**: Output varies wildly between invocations. Downstream consumers can't rely on the structure.
**Fix**: Include a markdown template the agent fills. Every invocation produces the same structure.

### 4. No Handoff Boundaries

**Symptom**: Agent has no "Related Agents" section. It tries to handle everything.
**Why it's wrong**: Scope creep. Agent produces shallow coverage of topics better handled by specialists.
**Fix**: Define explicit scope boundaries with handoff targets.

## Skill Anti-Patterns

### 5. Opaque Skill Directory

**Symptom**: SKILL.md says "See the files in this directory" with minimal summary.
**Why it's wrong**: Claude must read multiple files to answer basic questions. Token waste.
**Fix**: SKILL.md should answer 80% of routine questions. Sub-files for the remaining 20%.

### 6. Duplicate of CLAUDE.md

**Symptom**: Skill repeats instructions already in CLAUDE.md.
**Why it's wrong**: CLAUDE.md is always loaded. Duplicating it in a skill doubles the token cost.
**Fix**: Remove the duplication. Skill provides knowledge CLAUDE.md doesn't.

### 7. Stale Cross-References

**Symptom**: Skill references files, functions, or patterns that no longer exist.
**Why it's wrong**: Claude follows the reference, finds nothing, wastes tokens and produces incorrect advice.
**Fix**: Verify all references point to existing artifacts. Automate with CI validation.

## Rule Anti-Patterns

### 8. Global Rule Should Be Scoped

**Symptom**: Rule about SQL patterns loads when editing CSS files.
**Why it's wrong**: Consumes tokens without providing value. Multiplied by every turn.
**Fix**: Add YAML frontmatter with path globs: `globs: ["**/*.py", "src/db/**"]`

### 9. Rule Without Examples

**Symptom**: "Use parameterized queries" with no DO/DO NOT code blocks.
**Why it's wrong**: Claude interprets the instruction differently each time. No anchor for consistent behavior.
**Fix**: Every MUST rule needs a concrete example showing correct and incorrect patterns.

### 10. Rule Without Why

**Symptom**: "MUST validate IDs with validate_id()" but no rationale.
**Why it's wrong**: Without understanding why, Claude applies the rule mechanically and misses edge cases where the spirit matters more than the letter.
**Fix**: Add "**Why:** [one-line rationale]" after each MUST.

## Command Anti-Patterns

### 11. Command Is Documentation

**Symptom**: Command file is 300+ lines explaining concepts instead of directing action.
**Why it's wrong**: Commands are prompts injected as user messages. Long prompts compete with actual user intent.
**Fix**: Commands should be 50-150 lines. Move explanations to skills.

### 12. Command Embeds Agent Logic

**Symptom**: Command file contains review criteria, analysis frameworks, or validation rules.
**Why it's wrong**: The command is doing the agent's job. Criteria can't be reused by other commands.
**Fix**: Move criteria to the agent definition. Command deploys the agent.

## Hook Anti-Patterns

### 13. Hook Does Semantic Analysis

**Symptom**: Hook contains regex patterns trying to understand code meaning.
**Why it's wrong**: Hooks are deterministic checks. Semantic understanding is the LLM's job.
**Fix**: Hook checks structure (file exists, format valid). Agent checks semantics (code is correct).

### 14. Hook Without Timeout

**Symptom**: Hook has no setTimeout fallback.
**Why it's wrong**: A hanging hook blocks the entire Claude Code session indefinitely.
**Fix**: Always include timeout handler that returns `{ continue: true }` and exits.

### 15. Hook Modifies Files

**Symptom**: Hook writes to files or modifies state beyond stdout.
**Why it's wrong**: Side effects from hooks are invisible to Claude. The model doesn't know the hook changed something.
**Fix**: Hooks should only validate and report. File modifications are the model's job (via Edit/Write tools).
