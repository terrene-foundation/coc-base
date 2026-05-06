# CC Artifact Design Templates

## Agent Template

```markdown
---
name: specialty-descriptor
description: One-line with trigger phrases. Use when [condition]. Use for [domain].
tools: Read, Glob, Grep[, Write, Edit, Bash, Task]
model: opus
---

# [Professional Title]

You are an expert in [domain]. You understand [key concepts].

## Primary Responsibilities

1. [Actionable verb] + [specific outcome]
2. ...

## [Core Domain Knowledge]

[Structured knowledge the agent needs for judgment calls]

## Process

1. [Step with clear input/output]
2. ...

## Output Format

[Template the agent fills — not "produce a report"]

## Behavioral Guidelines

- [Specific behavioral rule]
- ...

## Related Agents

- **[agent-name]** — Hand off for [scope boundary]

## Full Documentation

- `.claude/skills/NN-name/` — [what's there]
```

### Agent Checklist

- [ ] Name is specialty, not task (noun, not verb)
- [ ] Description under 120 chars with trigger phrases
- [ ] Responsibilities are numbered and actionable
- [ ] Output format is a template, not vague
- [ ] Related agents listed for handoff at scope boundaries
- [ ] Knowledge is in the agent (not delegated to vague "skills")

## Skill Template

```markdown
---
name: skill-name
description: One-line. Triggers when [condition].
allowed-tools:
  - Read
  - Glob
  - Grep
---

# [Skill Title]

[One paragraph: what this skill covers]

## Quick Reference

[Tables/lists answering the most common questions — 80% case]

## [Topic Sections]

[Organized by concept, not by chronology]

## When to Use This Skill

- [Trigger condition]

## Support

- **[agent-name]** — [when this skill is insufficient]
```

### Skill Checklist

- [ ] SKILL.md answers 80% of routine questions without reading subdirectory files
- [ ] Quick reference at top (tables preferred)
- [ ] Each file under 250 lines; split if longer
- [ ] References authoritative sources, doesn't duplicate them
- [ ] "When to Use" section matches the description trigger phrases

## Rule Template

````markdown
# [Rule Title]

## Scope

[Path globs or "Global". This determines WHEN the rule loads.]

## MUST Rules

### 1. [Rule Name]

[Explanation]

```python
# DO:
[correct pattern]

# DO NOT:
[incorrect pattern]
```
````

**Why:** [one-line rationale]

## MUST NOT Rules

### 1. [Rule Name]

[Same structure]

## Cross-References

- [Related rules/agents]

````

### Rule Checklist
- [ ] Scope section present (path globs save tokens)
- [ ] Every MUST has a code example (DO/DO NOT)
- [ ] Every MUST has a "Why" line
- [ ] Self-contained — readable without other rules
- [ ] No duplication with CLAUDE.md content

## Command Template

```markdown
---
name: command-name
description: "One-line shown in /help"
---

# [Command Name]

## What This Does
[Plain language, one paragraph]

## Your Role
[What the human provides/approves]

## Workflow
1. [Step]
2. [Step]
...

## Agent Teams
| Function | Agent |
|----------|-------|
| [task] | [agent-name] |

## Completion Evidence
[What must exist for this to be done]
````

### Command Checklist

- [ ] Plain language (non-technical users can understand)
- [ ] Numbered workflow with clear sequence
- [ ] Agent teams listed by function
- [ ] Completion evidence defined
- [ ] Under 150 lines

## Hook Template (JavaScript)

```javascript
#!/usr/bin/env node
/**
 * Hook: [name]
 * Event: PreToolUse|PostToolUse|SessionStart|etc.
 * Matcher: [ToolName pattern]
 * Purpose: [one line]
 */

const TIMEOUT_MS = 5000;
const timeout = setTimeout(() => {
  console.error("[HOOK TIMEOUT] [name] exceeded limit");
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    const result = processHook(data);
    console.log(JSON.stringify(result));
    process.exit(result.exitCode || 0);
  } catch (error) {
    console.error(`[HOOK ERROR] ${error.message}`);
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
});

function processHook(data) {
  // Hook logic here
  return { continue: true, exitCode: 0 };
}
```

### Hook Checklist

- [ ] Timeout handler present (prevents hanging)
- [ ] Error handler returns `{ continue: true }` (fail-open by default)
- [ ] Exit codes: 0 = continue, 2 = block, other = warn
- [ ] Stateless — no cross-invocation memory
- [ ] Registered in `.claude/settings.json`
