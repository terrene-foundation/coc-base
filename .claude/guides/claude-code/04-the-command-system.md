# Guide 04: The Command System

## Introduction

Commands are **shortcuts for loading specialized knowledge** into Claude's context. Instead of Claude having all knowledge loaded at once (which would be slow and expensive), commands let you selectively load exactly what's needed for your current task.

By the end of this guide, you will understand:

- What commands are and why they exist
- Every available command and what it loads
- When to use which command
- How commands relate to skills
- How to combine commands for complex tasks

---

## Part 1: What Are Commands?

### The Problem Commands Solve

Claude Code has a limited **context window** - the amount of information it can "hold in mind" at once. If we loaded all 28 skill directories simultaneously, Claude would:

1. Run out of context space quickly
2. Process irrelevant information
3. Be slower and more expensive to run

### The Solution: On-Demand Loading

Commands solve this by loading knowledge **only when needed**:

```
Without Commands:
┌────────────────────────────────────────────────────────┐
│ Claude's Context (Always Loaded)                        │
│ ┌──────┬──────┬──────┬──────┬──────┬──────┬──────────┐│
│ │ SDK  │ Data │Nexus │Kaizen│Tests │Deploy│ ... all  ││
│ │      │ Flow │      │      │      │      │ 28 skills││
│ └──────┴──────┴──────┴──────┴──────┴──────┴──────────┘│
│ Context 80% full before you even ask a question        │
└────────────────────────────────────────────────────────┘

With Commands:
┌────────────────────────────────────────────────────────┐
│ Claude's Context (On-Demand)                            │
│ ┌──────────────────────────────────────────────────┐  │
│ │ /db loads only DataFlow knowledge                 │  │
│ │ ┌──────┐                                          │  │
│ │ │ Data │   90% context available for your task    │  │
│ │ │ Flow │                                          │  │
│ │ └──────┘                                          │  │
│ └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

### How Commands Work

When you type a command like `/db`:

1. Claude reads the command file (`.claude/commands/db.md`)
2. The command file tells Claude to load specific skills
3. Skills are loaded into Claude's context
4. Claude now has specialized knowledge for your task

```
┌──────────┐     ┌──────────────────┐     ┌────────────────────┐
│ You type │ ──▶ │ Command file     │ ──▶ │ Skill directory    │
│ /db      │     │ commands/db.md   │     │ skills/02-dataflow │
└──────────┘     └──────────────────┘     └────────────────────┘
                          │
                          ▼
                 ┌──────────────────┐
                 │ Claude now knows │
                 │ DataFlow patterns│
                 └──────────────────┘
```

---

## Part 2: Available Commands

### Primary Framework Commands

These are the commands you'll use most often:

#### `/sdk` - Core SDK Quick Reference

**What it loads**: Core SDK patterns for workflows, nodes, and runtime execution

**When to use**:

- Building custom workflows
- Working directly with WorkflowBuilder
- Understanding node connections
- Debugging runtime issues

**Example usage**:

```
> /sdk
> Now create a workflow that fetches data from an API and transforms it
```

**What you get**:

```python
# Claude will use patterns like:
from kailash.workflow.builder import WorkflowBuilder
from kailash.runtime import LocalRuntime

workflow = WorkflowBuilder()
workflow.add_node("APICall", "fetch", {"url": endpoint})
workflow.add_node("Transform", "transform", {})
workflow.connect("fetch", "transform", {"data": "input"})

runtime = LocalRuntime()
results, run_id = runtime.execute(workflow.build())
```

#### `/db` - DataFlow Quick Reference

**What it loads**: DataFlow framework patterns for database operations

**When to use**:

- Creating database models
- Implementing CRUD operations
- Working with PostgreSQL or SQLite
- Bulk data operations

**Example usage**:

```
> /db
> Create a User model with email and password fields
```

**What you get**:

```python
# Claude will use patterns like:
from dataflow import DataFlow

db = DataFlow()

@db.model
class User:
    id: int          # Primary key MUST be named 'id'
    email: str
    password: str
    # created_at, updated_at auto-managed

# This automatically generates 11 nodes:
# - UserCREATE, UserREAD, UserUPDATE, UserDELETE
# - UserLIST, UserUPSERT, UserCOUNT
# - UserBULK_CREATE, UserBULK_UPDATE, UserBULK_DELETE, UserBULK_UPSERT
```

#### `/api` - Nexus Quick Reference

**What it loads**: Nexus multi-channel deployment patterns

**When to use**:

- Deploying workflows as APIs
- Creating CLI interfaces
- Setting up MCP servers
- Multi-channel applications

**Example usage**:

```
> /api
> Deploy my user workflow as a REST API
```

**What you get**:

```python
# Claude will use patterns like:
from nexus import Nexus

app = Nexus()

@app.workflow("user/create")
def create_user(name: str, email: str):
    # Workflow implementation
    pass

# This automatically provides:
# - REST API at /api/user/create
# - CLI command: user create --name=... --email=...
# - MCP tool: user_create
```

#### `/ai` - Kaizen Quick Reference

**What it loads**: Kaizen AI agent patterns

**When to use**:

- Building AI agents
- Working with LLMs
- Multi-agent systems
- Signature-based programming

**Example usage**:

```
> /ai
> Create an agent that can analyze documents and answer questions
```

**What you get**:

```python
# Claude will use patterns like:
from kaizen.api import Agent

agent = Agent(
    model="gpt-4",
    execution_mode="autonomous",
    memory="session"
)

result = await agent.run("Analyze this document: ...")
```

### Quality and Validation Commands

#### `/test` - Testing Strategies Quick Reference

**What it loads**: 3-tier testing strategy patterns

**When to use**:

- Writing unit tests (Tier 1)
- Writing integration tests (Tier 2)
- Writing end-to-end tests (Tier 3)
- Understanding the Real infrastructure recommended policy

**Example usage**:

```
> /test
> Write integration tests for my User model
```

**What you get**:

```python
# Claude will use patterns like:
import pytest
from dataflow import DataFlow

@pytest.fixture
def db():
    # REAL database, not mocked
    dataflow = DataFlow(database_url="sqlite:///:memory:")
    dataflow.create_tables()
    yield dataflow
    dataflow.drop_tables()

def test_create_user(db):
    # Real database operations
    result = db.User.create(name="Test", email="test@test.com")
    assert result.id is not None
```

#### `/validate` - Project Compliance Validation

**What it loads**: Universal compliance rules + Kailash-specific patterns (when detected)

**When to use**:

- Pre-commit compliance checking
- Security audit (secrets, injection, input validation)
- Testing policy enforcement (Real infrastructure recommended in Tier 2-3)
- Stubs/TODOs/placeholder detection

**Example usage**:

```
> /validate
> Check this project for compliance issues
```

**What you get**:

- Project type auto-detection (generic vs Kailash)
- Universal: security, no-stubs, env-models, testing policy
- Kailash-specific (when detected): import validation, workflow patterns
- Pattern validation (correct runtime execution)
- Security validation (no hardcoded secrets)
- Testing validation (Real infrastructure recommended in Tier 2-3)

### Workspace Phase Commands

These commands replace the manual copy-paste workflow for the 5-phase workspace process.

#### `/analyze` - Phase 01: Analysis

**What it does**: Loads the analysis instruction template for the current workspace

**When to use**: Starting a new project or re-entering analysis after validation gaps

**Example usage**:

```
> /analyze my-saas-app
```

#### `/todos` - Phase 02: Todos

**What it does**: Loads the todos instruction template, checks existing plans

**When to use**: Breaking plans into actionable todos

**Example usage**:

```
> /todos
```

**Note**: Stops for human approval before proceeding to implementation.

#### `/implement` - Phase 03: Implementation

**What it does**: Loads the implementation instruction template, shows todo progress

**When to use**: Working through active todos. Repeat until all complete.

**Example usage**:

```
> /implement              # Pick next active todo
> /implement auth-setup   # Focus on specific todo
```

#### `/redteam` - Phase 04: Validation

**What it does**: Loads the validation instruction template for red team testing

**When to use**: After implementation, to validate with Playwright MCP (web) and Marionette MCP (Flutter)

**Example usage**:

```
> /redteam
```

#### `/codify` - Phase 05: Codification

**What it does**: Loads the codification instruction template for creating project agents and skills

**When to use**: After validation passes, to capture project knowledge

**Example usage**:

```
> /codify
```

#### `/ws` - Workspace Status Dashboard

**What it does**: Shows read-only workspace status derived from the filesystem

**When to use**: To check current phase, todo progress, and recent activity

**Example usage**:

```
> /ws
> /ws my-saas-app
```

#### `/wrapup` - Session Notes

**What it does**: Writes `.session-notes` to the workspace with accomplishments, blockers, and next steps

**When to use**: Before ending a session, to preserve context for the next session

**Example usage**:

```
> /wrapup
```

### Learning Commands

#### `/learn` - Continuous Learning Command

**What it loads**: Observation logging system

**When to use**:

- Recording a useful pattern you discovered
- Noting a mistake to avoid
- Capturing domain-specific knowledge

**Example usage**:

```
> /learn
> DataFlow models should always have descriptive field names
```

---

## Part 3: Command Structure

### Anatomy of a Command File

Every command in `.claude/commands/` follows this structure:

```markdown
---
name: command-name
description: "What this command does and when to use it"
---

# Command Name Quick Reference

## Quick Patterns

[Most common patterns for immediate use]

## When to Use

[Guidance on when this command is appropriate]

## Usage Examples

[Examples showing how to use the command]

## Related Skills

[Links to full skill documentation]

## Common Mistakes

[Gotchas and anti-patterns to avoid]
```

### Example: The `/db` Command File

````markdown
---
name: db
description: "DataFlow Quick Reference - Load for database operations"
---

# DataFlow Quick Reference

## Quick Patterns

### Model Definition

```python
@db.model
class User:
    id: int          # Required
    name: str
    email: str
```
````

### CRUD Operations

```python
# Create
user = await db.User.create(name="Test", email="test@test.com")

# Read
user = await db.User.read(id=1)

# Update
await db.User.update(filter={"id": 1}, fields={"name": "Updated"})

# Delete
await db.User.delete(id=1)
```

## When to Use

- Creating database models
- CRUD operations
- Bulk data operations
- Multi-tenancy requirements

## Common Mistakes

❌ Setting created_at manually (auto-managed)
❌ Primary key not named 'id'
❌ Using raw SQL instead of DataFlow nodes

```

---

## Part 4: Using Commands Effectively

### Single Command Usage

For focused tasks, use a single command:

```

> /db
> Create a Product model with name, price, and inventory fields

```

Claude loads DataFlow patterns and creates the model correctly.

### Multiple Commands

For complex tasks, load multiple commands:

```

> /db
> /api
> Create a Product model and deploy it as a REST API with CRUD endpoints

```

Claude now has both DataFlow and Nexus patterns in context.

### Command Stacking Order

Load commands in dependency order:

```

Good order (foundation first):

> /sdk # Core patterns
> /db # Database on top of SDK
> /api # API using database

Problematic order:

> /api # Needs database context
> /db # Loaded after API

```

### When Commands Load Automatically

Claude may load skills automatically based on your request:

```

> Create a DataFlow model for users

```

Without typing `/db`, Claude recognizes:
- "DataFlow" mentioned → loads `02-dataflow` skill
- Proceeds with correct patterns

However, **explicit command loading is more reliable**:

```

> /db
> Create a model for users

```

---

## Part 5: Command Quick Reference Table

| Command | Loads | Use For |
|---------|-------|---------|
| `/sdk` | Core SDK | Workflows, nodes, runtime |
| `/db` | DataFlow | Database operations |
| `/api` | Nexus | API deployment |
| `/ai` | Kaizen | AI agents |
| `/test` | Testing | Writing tests |
| `/validate` | Project Compliance | Security, testing, stubs (+ Kailash when detected) |
| `/analyze` | Phase 01 template | Research, planning, user flows |
| `/todos` | Phase 02 template | Task breakdown (stops for approval) |
| `/implement` | Phase 03 template | Build iteratively through todos |
| `/redteam` | Phase 04 template | Red team validation |
| `/codify` | Phase 05 template | Create project agents & skills |
| `/ws` | Workspace state | Status dashboard (read-only) |
| `/wrapup` | Session notes | Save context before ending |
| `/learn` | Learning system | Recording observations |

---

## Part 6: Command vs. Direct Questions

### When to Use Commands

**Use commands when**:
- Starting a new task
- Switching domains (e.g., from database to API)
- You want explicit context loading
- Working on complex implementations

**Example**:
```

> /db
> /test
> Create a User model with integration tests

```

### When to Ask Directly

**Ask directly when**:
- Continuing work in the same domain
- Asking simple questions
- Claude already has context
- Exploring possibilities

**Example** (after `/db` already loaded):
```

> How do I add a unique constraint to the email field?

```

---

## Part 7: Common Command Workflows

### Workflow 1: New Feature Development

```

1. /sdk # Load core patterns
2. /db # Load database patterns
3. Define models
4. /test # Load testing patterns
5. Write tests
6. /api # Load deployment patterns
7. Deploy

```

### Workflow 2: Bug Investigation

```

1. /sdk # Load core patterns for understanding
2. Read error messages
3. /test # Load testing to write reproduction test
4. Fix and verify

```

### Workflow 3: Code Review

```

1. /validate # Load compliance standards
2. Review code
3. /test # Verify test coverage
4. Report findings

```

### Workflow 4: AI Feature Development

```

1. /ai # Load Kaizen patterns
2. Design agent
3. /test # Test agent behavior
4. /api # Deploy as service

```

---

## Part 8: Relationship to Skills

### Commands Are Shortcuts to Skills

```

Command Skill Directory
─────────────────────────────────────────
/sdk ──▶ .claude/skills/01-core-sdk/
/db ──▶ .claude/skills/02-dataflow/
/api ──▶ .claude/skills/03-nexus/
/ai ──▶ .claude/skills/04-kaizen/
/test ──▶ .claude/skills/12-testing-strategies/
/validate ──▶ rules/ + .claude/skills/17-gold-standards/ (when Kailash detected)

```

### Skills Contain More Than Commands

Commands load the **quick reference** portion of skills. Full skills contain:

| Content | In Command | In Full Skill |
|---------|------------|---------------|
| Quick patterns | ✅ | ✅ |
| Common mistakes | ✅ | ✅ |
| Full documentation | ❌ | ✅ |
| Edge cases | ❌ | ✅ |
| Architecture details | ❌ | ✅ |
| Migration guides | ❌ | ✅ |

### Accessing Full Skill Content

Claude can access full skill content when needed:

```

> /db
> I need detailed information about multi-tenancy in DataFlow

```

Claude will:
1. Start with command quick reference
2. Access full `02-dataflow` skill content
3. Provide detailed multi-tenancy information

---

## Part 9: Key Takeaways

### Summary

1. **Commands are shortcuts** - They load specific skills into Claude's context

2. **Eighteen commands exist** - 11 framework (`/sdk`, `/db`, `/api`, `/ai`, `/test`, `/validate`, `/design`, `/i-audit`, `/i-polish`, `/i-harden`, `/learn`) + 7 workspace (`/analyze`, `/todos`, `/implement`, `/redteam`, `/codify`, `/ws`, `/wrapup`)

3. **Use commands for focus** - Load only what you need for your current task

4. **Stack commands for complex tasks** - Multiple commands can be loaded together

5. **Commands relate to skills** - Each command maps to a skill directory

6. **Explicit is better** - Using commands explicitly is more reliable than depending on auto-detection

### Quick Reference

| Want to... | Use Command |
|------------|-------------|
| Build workflows | `/sdk` |
| Work with databases | `/db` |
| Deploy APIs | `/api` |
| Build AI agents | `/ai` |
| Write tests | `/test` |
| Check compliance | `/validate` |
| Start a new project | `/analyze` |
| Break plans into tasks | `/todos` |
| Build through todos | `/implement` |
| Validate with red team | `/redteam` |
| Capture project knowledge | `/codify` |
| Check workspace status | `/ws` |
| Save session context | `/wrapup` |

---

## What's Next?

Commands load knowledge, but sometimes you need **specialized processing**. The next guide explains the agent system that provides deep expertise.

**Next: [05 - The Agent System](05-the-agent-system.md)**

---

## Navigation

- **Previous**: [03 - Installation and First Run](03-installation-and-first-run.md)
- **Next**: [05 - The Agent System](05-the-agent-system.md)
- **Home**: [README.md](README.md)
```
