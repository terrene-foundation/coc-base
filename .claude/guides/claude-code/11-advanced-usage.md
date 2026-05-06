# Guide 11: Advanced Usage

## Introduction

This guide covers **power user features** for those who want deeper control over the setup. These techniques go beyond daily workflows into customization, optimization, and expert-level usage.

By the end of this guide, you will know how to:

- Explicitly control agent delegation
- Chain multiple agents for complex tasks
- Customize hooks and rules
- Optimize context usage
- Extend the setup with new components

---

## Part 1: Explicit Agent Control

### Requesting Specific Agents

Instead of relying on automatic delegation, request specific agents:

```
> Use the analyst to evaluate the architectural risks of adding real-time notifications
```

```
> Use the dataflow-specialist to review my model design for potential performance issues
```

```
> Use the security-reviewer to audit only the authentication module
```

### Chaining Agents Manually

For complex analysis, chain agents in sequence:

```
> For this feature, I want you to:
> 1. Use analyst for risk assessment
> 2. Use analyst for breakdown
> 3. Use `decide-framework` skill for technology selection
> 4. Use the appropriate specialist for implementation guidance
```

### Parallel Agent Execution

Request parallel agent work for independent tasks:

```
> In parallel:
> - Use testing-specialist to review test coverage
> - Use security-reviewer to audit security
> - Use reviewer to check code quality
```

Claude launches all three agents simultaneously.

### Agent Bypass (Use Carefully)

Skip automatic delegation when you know best:

```
> Skip the analyst, I've already analyzed this. Just implement:
> [Your implementation details]
```

Note: Bypassing agents removes safety checks.

---

## Part 2: Plan Mode vs Direct Execution

### The Decision Framework

| Mode                 | Use When                                                               | Example                                                            |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Plan mode**        | Multiple valid approaches, architectural decisions, multi-file changes | "Redesign the auth system"                                         |
| **Direct execution** | Clear scope, known approach, single-file changes                       | "Fix this null pointer at line 42"                                 |
| **Hybrid**           | Investigate first, then execute                                        | "Debug the performance issue" → plan explores, direct executes fix |

### The Explore Subagent

For broad codebase exploration, use the Explore agent. It runs in its own context window:

1. **Discovery noise is isolated** — verbose file contents, search results, and dead ends stay in the subagent's context
2. **Only the summary returns** — your main context stays clean
3. **Prevents context budget exhaustion** — exploration doesn't consume the tokens you need for implementation

Use Explore for: broad searches, multi-file analysis, understanding unfamiliar codebases.
Use Grep/Glob directly for: targeted lookups, specific file searches.

### CLAUDE.md Hierarchy

Claude Code loads instructions from three levels, in order:

| Level               | Location                        | Shared?                  | Use For                             |
| ------------------- | ------------------------------- | ------------------------ | ----------------------------------- |
| **User-level**      | `~/.claude/CLAUDE.md`           | No (your machine only)   | Personal preferences, shortcuts     |
| **Project-level**   | `.claude/CLAUDE.md`             | Yes (version-controlled) | Team standards, project conventions |
| **Directory-level** | `CLAUDE.md` in any subdirectory | Yes                      | Subdirectory-specific rules         |

**The new-team-member trap**: Developer A has perfect conventions (user-level CLAUDE.md). Developer B joins, gets inconsistent output. Root cause: instructions live on A's machine. Fix: Move to project-level `.claude/CLAUDE.md`.

### Path-Specific Rules

For rules that apply only to certain file types, use `.claude/rules/` with YAML frontmatter:

```markdown
# .claude/rules/testing.md

---

## paths: ["**/*.test.tsx"]

All test files must use describe/it blocks with specific assertion messages.
```

**Advantage over directory-level CLAUDE.md**: Glob patterns match across the entire codebase. Rules load only for matching files, keeping irrelevant context out of the token budget.

---

## Part 3: Advanced Context Management

### Selective Skill Loading

Load only what you need:

```
> /db

# Now Claude has DataFlow context
# Other contexts not loaded
```

### Unloading Context

Clear context when switching domains:

```
> /clear

# Context cleared, starting fresh
```

### Context Stacking

Layer contexts for complex tasks:

```
> /sdk
> /db
> /test

# Claude now has Core SDK + DataFlow + Testing
# Use for implementing tested DataFlow features
```

### Minimal Context Mode

For simple tasks, avoid loading heavy context:

```
> Just fix this typo, don't load any extra context

[Claude fixes without loading skills]
```

---

## Part 4: Hook Customization

### Adding a Custom Hook

Create a new hook script:

```javascript
// .claude/hooks/my-custom-hook.js
#!/usr/bin/env node

const fs = require('fs');

let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const data = JSON.parse(input);

  // Your custom validation
  if (data.tool_input?.file_path?.includes('.env')) {
    console.log(JSON.stringify({
      continue: false,
      hookSpecificOutput: {
        message: 'Blocked: Cannot edit .env files'
      }
    }));
    process.exit(2);
  }

  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
});
```

Register in `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/my-custom-hook.js",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### Disabling a Hook Temporarily

Edit `.claude/settings.json` and comment out the hook (JSON doesn't support comments, so remove the entry temporarily).

### Hook Debugging

Add logging to hooks:

```javascript
console.error(`[DEBUG] Input: ${JSON.stringify(data)}`);
```

Check stderr for debug output.

---

## Part 5: Rule Customization

### Adding Project-Specific Rules

Create a new rule file:

````markdown
# .claude/rules/project-specific.md

## MUST Rules

### Always Use Project Logger

All logging MUST use the project's custom logger:

```python
# Correct
from myproject.logger import log
log.info("Message")

# Incorrect
print("Message")  # NO
import logging    # Use project logger instead
```
````

````

### Rule Priority Override

When rules conflict, specify priority in the rule file:

```markdown
## Priority
This rule takes precedence over patterns.md for logging concerns.
````

### Temporary Rule Exceptions

Document exceptions in your request:

```
> I need to use print statements for debugging. This is a temporary exception to the logging rule. I'll remove them before commit.
```

---

## Part 6: Custom Skills

### Creating a New Skill

Create a skill directory:

```
.claude/skills/99-my-custom-skill/
├── SKILL.md
├── pattern-1.md
└── pattern-2.md
```

Write the SKILL.md:

```markdown
---
name: my-custom-skill
description: "Custom patterns for [your domain]. Use when [trigger conditions]."
---

# My Custom Skill

## Quick Patterns

[Your most common patterns]

## Reference Documentation

- **[pattern-1](pattern-1.md)** - Description

## When to Use

- [Use case 1]
- [Use case 2]

## Support

For help, invoke:

- `pattern-expert` - General patterns
```

### Linking Skills to Commands

Create a command:

```markdown
# .claude/commands/mycmd.md

---

name: mycmd
description: "Load my custom patterns"

---

# My Custom Quick Reference

Load the 99-my-custom-skill skill for [domain] patterns.

## Quick Patterns

[Subset of patterns]

## Usage Examples
```

/mycmd

```
Then ask about [domain] features.
```

---

## Part 7: Custom Agents

### Creating a Specialist Agent

```markdown
# .claude/agents/my-specialist.md

---

name: my-specialist
description: Short description under 120 chars. Use for [trigger].
tools: Read, Write, Edit, Bash, Grep, Glob
model: opus

---

# My Specialist

You are a specialist in [domain].

## Responsibilities

1. [Primary responsibility]
2. [Secondary responsibility]

## Rules

1. [Critical rule]
2. [Important guideline]

## Process

1. [Step 1]
2. [Step 2]
3. [Verification]

## Skill References

- **[my-custom-skill](../skills/99-my-custom-skill/SKILL.md)**

## Related Agents

- **pattern-expert**: Hand off for general patterns
```

### Agent Invocation

After creating, use:

```
> Use the my-specialist to help with [task]
```

---

## Part 8: Optimization Techniques

### Reduce Token Usage

**Do:**

```
> /db
> Create user model
```

**Don't:**

```
> I want to create a database model for users with all the DataFlow patterns
> and I want to make sure it follows all the best practices...
[Loads unnecessary context]
```

### Batch Operations

**Do:**

```
> Fix all the lint errors in src/
```

**Don't:**

```
> Fix the lint error in src/file1.py
> Fix the lint error in src/file2.py
> Fix the lint error in src/file3.py
[Multiple roundtrips]
```

### Parallel Reads

**Do:**

```
> Read src/models/user.py, src/models/product.py, and src/models/order.py
```

Claude reads all three in parallel.

### Cache Awareness

After reading a file once, Claude remembers it for the session:

```
> Read src/config.py

[File read]

> What's the DATABASE_URL in that config?

[Claude answers from memory, no re-read needed]
```

---

## Part 9: Multi-Project Setup

### Project-Specific Overrides

Each project can have its own `.claude/` directory:

```
~/projects/
├── project-a/
│   └── .claude/
│       └── rules/         # Project A specific rules
│           └── custom.md
├── project-b/
│   └── .claude/
│       └── skills/        # Project B specific skills
│           └── 99-b-specific/
```

### Shared Base Setup

For shared setup across projects, use symlinks:

```bash
# In each project
ln -s ~/shared-claude-setup/.claude/skills .claude/skills
```

### Environment Detection

The session-start hook detects frameworks:

```javascript
// .claude/hooks/session-start.js
const hasDataFlow = fs.existsSync("dataflow.py") || hasImport("dataflow");
const hasNexus = fs.existsSync("nexus.py") || hasImport("nexus");
```

Customize for your projects.

---

## Part 10: Integration with External Tools

### IDE Integration

Claude Code can run from VS Code terminal:

```
# In VS Code integrated terminal
claude
```

### CI/CD Integration

Key flags for CI/CD:

- **`-p`**: Non-interactive mode. Essential for CI — without it, the job hangs waiting for input.
- **`--output-format json`**: Machine-parseable output for PR comments and automated processing.
- **`--json-schema`**: Enforce specific output structure (e.g., review findings schema).

**Critical pattern: Independent review instances**. The session that generated code is less effective at reviewing its own changes — it retains reasoning context making it less likely to question its own decisions. Use a separate Claude Code invocation for review:

```yaml
# .github/workflows/review.yml
steps:
  - name: Claude Review
    run: |
      claude -p "Review the changes in this PR for security and correctness" \
        --output-format json \
        --json-schema review_schema.json
```

For deep coverage of multi-instance review, see [Guide 15 - Prompt Engineering](15-prompt-engineering.md), Part 6.

### Pre-Commit Hooks

Integrate with git pre-commit:

```yaml
# .pre-commit-config.yaml
repos:
  - repo: local
    hooks:
      - id: claude-security
        name: Claude Security Review
        entry: scripts/claude-security-check.sh
        language: script
```

---

## Part 11: Key Takeaways

### Summary

1. **Explicit agent control** - Request specific agents when needed

2. **Context management** - Load selectively, clear when switching

3. **Customization** - Add hooks, rules, skills, agents

4. **Optimization** - Reduce tokens, batch operations, parallel reads

5. **Multi-project** - Per-project overrides with shared base

### Power User Checklist

- [ ] Created at least one custom hook
- [ ] Added project-specific rules
- [ ] Built a custom skill for your domain
- [ ] Optimized context loading patterns
- [ ] Integrated with CI/CD

---

## What's Next?

When things go wrong, the troubleshooting guide helps you diagnose and fix issues.

**Next: [12 - Troubleshooting](12-troubleshooting.md)**

---

## Navigation

- **Previous**: [10 - Daily Workflows](10-daily-workflows.md)
- **Next**: [12 - Troubleshooting](12-troubleshooting.md)
- **Home**: [README.md](README.md)
