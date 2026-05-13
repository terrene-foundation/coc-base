# Guide 06: The Skill System

## Introduction

Skills are the **knowledge base** of this setup. They contain patterns, templates, references, and best practices organized by domain. When Claude needs to know HOW to do something, it consults skills.

By the end of this guide, you will understand:

- What skills are and how they're organized
- The current skill directories and their purposes
- How skills relate to commands and agents
- How to access skill content effectively
- The structure of skill files

---

## Part 1: What Are Skills?

### The Problem Skills Solve

Development requires extensive domain knowledge:

- Database operations have specific patterns
- Testing requires understanding of strategies
- Security involves many checklist items
- Each framework has its own conventions

Without organization, this knowledge would be:

- Scattered across random files
- Hard to find when needed
- Inconsistent in format
- Difficult to update

### The Solution: Organized Knowledge

Skills provide **organized, accessible domain expertise**:

```
┌─────────────────────────────────────────────────────────────┐
│                    SKILL DIRECTORY                           │
│                    .claude/skills/                           │
│                                                              │
│   ┌─────────────────┐  ┌─────────────────┐                  │
│   │   02-dataflow   │  │   12-testing    │                  │
│   │                 │  │                 │                  │
│   │ • Model patterns│  │ • 3-tier strategy│                 │
│   │ • CRUD operations│ │ • Real infrastructure recommended    │                  │
│   │ • Bulk processing│ │ • Test fixtures │                  │
│   │ • Gotchas       │  │ • Coverage      │                  │
│   └─────────────────┘  └─────────────────┘                  │
│                                                              │
│   ┌─────────────────┐  ┌─────────────────┐                  │
│   │   03-nexus      │  │   04-kaizen     │                  │
│   │                 │  │                 │                  │
│   │ • API deployment│  │ • Agent patterns│                  │
│   │ • CLI creation  │  │ • Signatures    │                  │
│   │ • MCP exposure  │  │ • Multi-agent   │                  │
│   │ • Sessions      │  │ • Memory        │                  │
│   └─────────────────┘  └─────────────────┘                  │
│                                                              │
│                    ... more directories                      │
└─────────────────────────────────────────────────────────────┘
```

### Skills vs. Other Components

| Component    | Contains                        | Purpose                     |
| ------------ | ------------------------------- | --------------------------- |
| **Skills**   | Patterns, templates, references | Show HOW to do things       |
| **Agents**   | Processes, analysis methods     | DECIDE what to do           |
| **Hooks**    | Validation scripts              | ENFORCE rules automatically |
| **Rules**    | Constraints, requirements       | Define MUST/MUST NOT        |
| **Commands** | Shortcuts to skills             | Quick access                |

---

## Part 2: Skill Directory Overview

### Skill Directories

| Directory                    | Name         | Domain                    |
| ---------------------------- | ------------ | ------------------------- |
| `01-core-sdk`                | Core SDK     | Workflows, nodes, runtime |
| `02-dataflow`                | DataFlow     | Database operations       |
| `03-nexus`                   | Nexus        | Multi-channel platform    |
| `04-kaizen`                  | Kaizen       | AI agents                 |
| `05-kailash-mcp`             | MCP          | Model Context Protocol    |
| `06-cheatsheets`             | Cheatsheets  | Quick reference           |
| `08-nodes-reference`         | Nodes        | 110+ node documentation   |
| `10-deployment-git`          | Deployment   | Docker, K8s, Git          |
| `12-testing-strategies`      | Testing      | 3-tier strategy           |
| `31-error-troubleshooting`   | Errors       | Debugging guides          |
| `16-validation-patterns`     | Validation   | Input validation          |
| `17-gold-standards`          | Standards    | Mandatory practices       |
| `18-security-patterns`       | Security     | OWASP, secrets            |
| `23-uiux-design-principles`  | UI/UX Design | Design principles         |
| `25-ai-interaction-patterns` | AI Patterns  | AI UX (Shape of AI)       |
| `26-eatp-reference`          | EATP         | Trust protocol reference  |
| `co-reference`               | CARE         | Governance framework ref  |

---

## Part 3: Core Framework Skills (01-04)

### 01-core-sdk: Foundation Skills

**Purpose**: Workflow creation, node patterns, runtime execution

**Key files**:

- `workflow-quickstart.md` - Basic workflow creation
- `node-patterns-common.md` - Common node usage
- `connection-patterns.md` - Linking nodes
- `runtime-execution.md` - Running workflows
- `error-handling-patterns.md` - Error management
- `cycle-workflows-basics.md` - Cyclic patterns

**When to use**: Building any workflow from scratch, understanding fundamentals

**Example content**:

```python
# Canonical 4-parameter node pattern
workflow.add_node(
    "NodeClassName",      # 1. Node type (PascalCase)
    "unique_node_id",     # 2. Unique ID (snake_case)
    {"param": "value"},   # 3. Configuration dict
    connections=[]        # 4. Optional connections
)
```

### 02-dataflow: Database Operations

**Purpose**: Zero-config database framework patterns

**Key files**:

- `model-definition.md` - `@db.model` decorator
- `crud-operations.md` - Create, Read, Update, Delete
- `bulk-operations.md` - Mass data processing
- `multi-tenancy.md` - Tenant isolation

**When to use**: Any database operation, model creation, CRUD

**Critical gotchas**:

```python
# ❌ NEVER set timestamps manually
user = User(created_at=datetime.now())  # WRONG

# ✅ Let DataFlow auto-manage
user = User(name="Test", email="test@test.com")  # CORRECT
```

### 03-nexus: Multi-Channel Platform

**Purpose**: Deploy workflows as API + CLI + MCP

**Key files**:

- `quickstart.md` - Zero-config setup
- `workflow-registration.md` - Adding workflows
- `session-management.md` - State handling
- `dataflow-integration.md` - Database integration

**When to use**: API deployment, CLI creation, multi-channel apps

**Example content**:

```python
from nexus import Nexus

app = Nexus()

@app.workflow("user/create")
def create_user(name: str, email: str):
    # Single definition serves API, CLI, and MCP
    pass
```

### 04-kaizen: AI Agent Framework

**Purpose**: Production-ready AI agents

**Key files**:

- `agent-quickstart.md` - Basic agent creation
- `signatures.md` - Signature-based programming
- `multi-agent.md` - Agent coordination
- `memory-patterns.md` - Session/long-term memory

**When to use**: AI features, LLM integration, agent systems

**Example content**:

```python
from kaizen.api import Agent

agent = Agent(
    model="gpt-4",
    execution_mode="autonomous",
    memory="session"
)
```

---

## Part 4: Supporting Skills (05-12)

### 05-kailash-mcp: Model Context Protocol

**Purpose**: MCP server implementation

**Key content**: Transport patterns, tool definitions, authentication

### 06-cheatsheets: Quick Reference

**Purpose**: At-a-glance patterns for common tasks

**Key files**:

- `workflow-patterns.md` - Common workflow structures
- `node-selection.md` - Choosing the right node
- `common-mistakes.md` - Gotchas to avoid

### 08-nodes-reference: Node Documentation

**Purpose**: Reference for all 110+ SDK nodes

**Categories**:

- AI nodes (LLMNode, EmbeddingNode, etc.)
- API nodes (HTTPRequest, GraphQL, etc.)
- Data nodes (Transform, Filter, etc.)
- Database nodes (Query, Insert, etc.)
- File nodes (Read, Write, etc.)
- Logic nodes (SwitchNode, Loop, etc.)

### 10-deployment-git: Infrastructure

**Purpose**: Docker, Kubernetes, Git workflows

**Key files**:

- `docker-compose.md` - Local development
- `kubernetes.md` - Production deployment
- `git-workflows.md` - Branch strategies

### 12-testing-strategies: Test Patterns

**Purpose**: 3-tier testing strategy

**Key content**:

```
Tier 1: Unit Tests
├── Mocking allowed
├── Fast execution
└── Individual components

Tier 2: Integration Tests
├── Real infrastructure recommended (mandatory)
├── Real databases (SQLite in-memory)
└── Component interactions

Tier 3: E2E Tests
├── Real infrastructure recommended (mandatory)
├── Full system
└── Real infrastructure
```

---

## Part 5: Quality & Standards Skills

### 31-error-troubleshooting: Debugging

**Purpose**: Common errors and solutions

**Key content**: Nexus blocking issues, connection errors, cycle convergence problems

### 16-validation-patterns: Input Validation

**Purpose**: Validation best practices

**Key content**: Parameter validation, connection validation, security validation

### 17-gold-standards: Mandatory Practices

**Purpose**: Recommended best practices

**Key rules**:

- Absolute imports only
- Real infrastructure recommended in Tier 2-3
- Primary key named `id`
- `runtime.execute(workflow.build())`

### 18-security-patterns: Security

**Purpose**: OWASP compliance, secrets management

**Key content**: Input validation, injection prevention, authentication patterns

---

## Part 7: Skill File Structure

### Standard SKILL.md Format

Every skill directory has a `SKILL.md` entry point:

```markdown
---
name: skill-name
description: "What this skill does. Use when [trigger conditions]."
---

# Skill Title

Overview paragraph explaining the skill's purpose.

## Features

[List of capabilities]

## Quick Start

[Minimal working example]

## Reference Documentation

[Links to detailed files in the directory]

## Key Concepts

[Important patterns and rules]

## Critical Rules

[MUST/MUST NOT items]

## When to Use This Skill

[Guidance on when to load this skill]

## Related Skills

[Links to complementary skills]

## Support

[Which agents to consult for help]
```

### Supporting Files

Skills often contain multiple supporting files:

```
02-dataflow/
├── SKILL.md              # Entry point
├── model-definition.md   # @db.model decorator
├── crud-operations.md    # CRUD patterns
├── bulk-operations.md    # Bulk processing
├── multi-tenancy.md      # Tenant patterns
├── gotchas.md            # Common mistakes
└── examples/             # Working examples
```

---

## Part 8: Accessing Skills

### Via Commands

Commands load skill quick references:

```
> /db
```

Loads the essential patterns from `02-dataflow`.

### Via Direct Request

Ask Claude to load specific skill content:

```
> Tell me about DataFlow bulk operations
```

Claude loads `02-dataflow/bulk-operations.md`.

### Via Agent Delegation

Agents access skills automatically:

```
> Use the dataflow-specialist to help with user model design
```

Agent knows to consult `02-dataflow` skill.

### Reading Skill Files Directly

Skills are in `.claude/skills/`:

```bash
ls .claude/skills/
ls .claude/skills/02-dataflow/
cat .claude/skills/02-dataflow/SKILL.md
```

---

## Part 9: How Skills Are Loaded

### Progressive Loading

Skills follow a progressive detail model:

```
       ┌────────────────────────┐
       │   SKILL.md (entry)     │  ← Quick patterns (50-100 lines)
       └───────────┬────────────┘
                   │
       ┌───────────▼────────────┐
       │   Supporting files     │  ← Detailed docs (100-500 lines)
       └───────────┬────────────┘
                   │
       ┌───────────▼────────────┐
       │   Deep dive skills      │  ← Full documentation (unlimited)
       └────────────────────────┘
```

### Context-Aware Loading

Claude loads only what's needed:

```
Simple request: "Create a user model"
└── Loads SKILL.md patterns only

Complex request: "Create user model with multi-tenancy"
└── Loads SKILL.md + multi-tenancy.md

Deep dive: "Explain DataFlow internals"
└── Loads SKILL.md + all supporting skill files
```

---

## Part 10: Skill-Agent Relationship

### Agents Reference Skills

Every agent knows which skills to consult:

| Agent                 | Primary Skills          |
| --------------------- | ----------------------- |
| `dataflow-specialist` | `02-dataflow`           |
| `nexus-specialist`    | `03-nexus`              |
| `kaizen-specialist`   | `04-kaizen`             |
| `testing-specialist`  | `12-testing-strategies` |
| `pattern-expert`      | `01-core-sdk`           |

### Skills Reference Agents

Every skill knows which agents to invoke:

```markdown
## Support

For complex workflows or debugging, invoke:

- `pattern-expert` - Workflow patterns
- `testing-specialist` - Test implementations
```

---

## Part 11: Key Takeaways

### Summary

1. **Skills are organized knowledge** - 28 directories covering all domains

2. **Each skill has an entry point** - `SKILL.md` with quick patterns

3. **Skills contain progressive detail** - From quick reference to deep documentation

4. **Commands load skill subsets** - For context efficiency

5. **Agents consult skills** - For decision-making support

6. **Skills reference each other** - Building a knowledge graph

### Quick Reference

| Domain    | Skill                   | Command     |
| --------- | ----------------------- | ----------- |
| Workflows | `01-core-sdk`           | `/sdk`      |
| Database  | `02-dataflow`           | `/db`       |
| API       | `03-nexus`              | `/api`      |
| AI        | `04-kaizen`             | `/ai`       |
| Testing   | `12-testing-strategies` | `/test`     |
| Standards | `17-gold-standards`     | `/validate` |

---

## What's Next?

Skills provide knowledge, but how are rules enforced automatically? The next guide explains the hook system.

**Next: [07 - The Hook System](07-the-hook-system.md)**

---

## Navigation

- **Previous**: [05 - The Agent System](05-the-agent-system.md)
- **Next**: [07 - The Hook System](07-the-hook-system.md)
- **Home**: [README.md](README.md)
