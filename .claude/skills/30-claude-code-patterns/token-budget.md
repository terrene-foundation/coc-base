# CC Token Budget Guide

## How CC Artifacts Consume Tokens

Every CC artifact consumes tokens from the context window. Understanding the loading model is essential for efficiency.

## Loading Model

### Always Loaded (Every Turn)

| Source                       | Estimated Tokens       | Notes                                      |
| ---------------------------- | ---------------------- | ------------------------------------------ |
| CLAUDE.md (root)             | 2,000-5,000            | The larger this is, the less room for work |
| `.claude/CLAUDE.md`          | (if exists)            | Additive with root                         |
| Global rules (no path globs) | 200-500 each           | All load on session start                  |
| UserPromptSubmit hook output | 50-100                 | Injected every turn                        |
| Agent descriptions (all)     | 10-20 each, ~400 total | Loaded for selection decisions             |

### Conditionally Loaded

| Source                 | When                       | Estimated Tokens    |
| ---------------------- | -------------------------- | ------------------- |
| Path-scoped rules      | Editing matching files     | 200-500 each        |
| Skills (via commands)  | User invokes `/command`    | 700-2,000 per skill |
| Agent full definition  | When agent is delegated to | 700-1,800 per agent |
| Subdirectory CLAUDE.md | Working in that directory  | Variable            |

### Per-Invocation

| Source               | When            | Estimated Tokens      |
| -------------------- | --------------- | --------------------- |
| Tool results         | Every tool call | 100-5,000+ per result |
| Conversation history | Accumulates     | Grows each turn       |
| Subagent context     | Delegated task  | Separate window       |

## Budget Optimization Strategies

### 1. Path-Scope Everything Possible

```yaml
# BEFORE: Global rule, loads every turn
# .claude/rules/sql-safety.md (no frontmatter)
# Cost: 400 tokens × every turn

# AFTER: Scoped rule, loads only when editing DB files
# .claude/rules/sql-safety.md
---
globs:
  - "src/db/**"
  - "migrations/**"
  - "**/models.py"
---
# Cost: 400 tokens × only DB editing turns
```

**Savings**: If 70% of turns don't involve DB files → 70% token savings on this rule.

### 2. Progressive Disclosure in Skills

```
SKILL.md (entry point)     → ~700 tokens, answers 80% of questions
├── deep-topic-1.md        → ~500 tokens, loaded only when needed
├── deep-topic-2.md        → ~600 tokens, loaded only when needed
└── examples.md            → ~800 tokens, loaded only when needed
```

**vs Monolithic skill**: One 2,600-token file always loaded in full.

### 3. Agent Description Economy

Descriptions are loaded into EVERY agent selection decision. Every character costs.

```
# BAD: 180 chars
description: "A comprehensive specialist for database operations including schema design, query optimization, migration management, and performance tuning using DataFlow framework"

# GOOD: 95 chars
description: "DataFlow database specialist. Use for models, CRUD, bulk operations, migrations."
```

### 4. Command Brevity

Commands inject as user messages. Long commands crowd out actual user intent.

| Command Length | Impact                                   |
| -------------- | ---------------------------------------- |
| 50 lines       | Minimal — fits naturally                 |
| 150 lines      | Acceptable for complex workflows         |
| 300+ lines     | Problematic — competes with conversation |

Move reference material to skills. Commands deploy agents and set workflow.

### 5. CLAUDE.md Discipline

CLAUDE.md is the highest-cost artifact — it loads on every turn. Every line must earn its place.

**Keep in CLAUDE.md**:

- Project identity and purpose (what this repo is)
- Absolute directives (overriding rules)
- Command index (quick reference)
- Agent roster (who does what)

**Move OUT of CLAUDE.md**:

- Detailed coding patterns → skills
- Enforcement rules → `.claude/rules/`
- Execution examples → skills/templates
- Framework documentation → skills

## Measurement

### Quick Token Estimation

- 1 line of markdown ≈ 4-8 tokens
- 100 lines ≈ 400-800 tokens
- Tables are token-dense (~10-15 tokens per row)
- Code blocks are token-dense (~8-12 tokens per line)

### Checking Actual Token Cost

```bash
# Rough estimate: word count × 1.3
wc -w .claude/rules/security.md
# 450 words × 1.3 ≈ 585 tokens
```

### Budget Health Check

Count total always-loaded tokens:

```
CLAUDE.md + global rules + agent descriptions + hook outputs
= baseline per-turn cost
```

If baseline exceeds 10,000 tokens, consider:

1. Path-scoping more rules
2. Trimming CLAUDE.md to essentials
3. Consolidating overlapping rules
