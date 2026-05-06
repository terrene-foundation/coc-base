# Implementation Plan

**Date**: 2026-03-11
**Status**: Ready to execute

---

## How Model Assignment Works in Claude Code

Agent model is set via YAML frontmatter in the agent `.md` file:

```yaml
---
model: sonnet
---
```

Valid values: `opus`, `sonnet`, `haiku`, or omit for inherit.

**No changes to `settings.json` are needed** — model assignment lives in each agent's frontmatter.

---

## Changes Per Repo

### 1. Terrene Foundation (`<governance-kb-repo>`)

**1 agent to update:**

| File                                        | Change                          |
| ------------------------------------------- | ------------------------------- |
| `.claude/agents/management/todo-manager.md` | `model: opus` → `model: sonnet` |

### 2. Kailash Python SDK BUILD (`<sdk-repo>`)

**6 agents to update:**

| File                                        | Change                             |
| ------------------------------------------- | ---------------------------------- |
| `.claude/agents/release-specialist.md`   | `model: opus` → `model: sonnet`    |
| `.claude/agents/reviewer.md` | `model: opus` → `model: sonnet`    |
| `.claude/agents/build-fix.md`               | `model: opus` → `model: sonnet`    |
| `.claude/agents/testing-specialist.md`              | `model: opus` → `model: sonnet`    |
| `.claude/agents/gh-manager.md`              | Add `model: sonnet` if not present |

### 3. Kailash Python USE (`<python-use-repo>`)

**6 agents to update:**

| File                                        | Change                          |
| ------------------------------------------- | ------------------------------- |
| `.claude/agents/release-specialist.md`   | `model: opus` → `model: sonnet` |
| `.claude/agents/reviewer.md` | `model: opus` → `model: sonnet` |
| `.claude/agents/build-fix.md`               | `model: opus` → `model: sonnet` |
| `.claude/agents/testing-specialist.md`              | `model: opus` → `model: sonnet` |
| `.claude/agents/todo-manager.md`            | `model: opus` → `model: sonnet` |

### 4. Kailash Rust BUILD/USE (`<rust-repo>`)

**6 agents to update:**

| File                                        | Change                          |
| ------------------------------------------- | ------------------------------- |
| `.claude/agents/release-specialist.md`   | `model: opus` → `model: sonnet` |
| `.claude/agents/reviewer.md` | `model: opus` → `model: sonnet` |
| `.claude/agents/build-fix.md`               | `model: opus` → `model: sonnet` |
| `.claude/agents/testing-specialist.md`              | `model: opus` → `model: sonnet` |
| `.claude/agents/todo-manager.md`            | `model: opus` → `model: sonnet` |

---

## Execution Order

1. **Terrene Foundation first** (this repo) — smallest change, immediate validation
2. **Kailash Python USE** — template repo, changes propagate to new clones
3. **Kailash Rust BUILD/USE** — same template structure
4. **Kailash Python SDK BUILD** — development repo, test in active use

---

## Validation

After applying changes, verify:

1. Each modified agent file has valid YAML frontmatter
2. Run a quick test: spawn one of the modified agents and confirm it responds (e.g., ask todo-manager to list tasks)
3. Compare response quality subjectively — if any agent feels degraded, revert to Opus

---

## Rollback

If any agent underperforms on Sonnet:

1. Change `model: sonnet` back to `model: opus` in the agent's `.md` file
2. No other changes needed — model assignment is self-contained in each file

---

## Future Considerations

### When to reassess

- **New model release** (Sonnet 4.7, Opus 4.7): Re-evaluate benchmarks
- **After 30 days of use**: Check if any Sonnet agents are producing noticeably worse results
- **New agent types added**: Apply the classification logic from `03-recommendations.md`

### Agents to watch

| Agent                   | Currently | Watch For                                                    |
| ----------------------- | --------- | ------------------------------------------------------------ |
| build-fix               | → Sonnet  | Does it handle complex build errors? If not, revert to Opus  |
| testing-specialist              | → Sonnet  | Does Playwright orchestration degrade? TerminalBench says no |
| reviewer | → Sonnet  | Missing subtle doc issues? Unlikely given scope              |

### Explore subagent optimization

When using `Agent` tool with `subagent_type: "Explore"`, consider adding `model: "sonnet"` to the call. Search and exploration tasks show equivalent performance between models, and Explore agents don't do deep reasoning.

Example:

```
Agent(subagent_type="Explore", model="sonnet", prompt="Find all files matching...")
```

This is a calling-pattern change, not a file edit.
