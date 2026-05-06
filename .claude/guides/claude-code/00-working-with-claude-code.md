# Working with Claude Code: Standard Operating Procedures

## Purpose

This document establishes the definitive operating procedures for human-AI collaboration with Claude Code. It is designed for a **multi-session, multi-worktree workflow** where:

- Each phase produces **artifacts that survive session restarts**
- Human approval is a **BLOCKING GATE**, not a suggestion
- The goal is to build a **self-sustaining system** (agents + skills) that reduces future human effort
- Fresh Claude sessions are a **feature, not a bug**

---

## Part 1: First Principles

### The Fundamental Division of Labor

```
┌─────────────────────────────────────────────────────────────────┐
│                    HUMAN RESPONSIBILITIES                        │
│                                                                  │
│  ✓ Objectives       - What we're trying to achieve              │
│  ✓ Domain Knowledge - Industry expertise, business context      │
│  ✓ Constraints      - Budget, timeline, compliance, technology  │
│  ✓ Unknown Context  - Information Claude cannot access          │
│  ✓ Approval Gates   - EXPLICIT approval to proceed phases       │
│  ✓ Final Validation - Approval of outcomes against objectives   │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                  CLAUDE CODE RESPONSIBILITIES                    │
│                                                                  │
│  ✓ Analysis         - VP, USP, AAA, Platform, Network Effects   │
│  ✓ Planning         - Breaking down into todos with subagents   │
│  ✓ Todo Management  - Creating, tracking, completing tasks      │
│  ✓ Implementation   - Writing code, tests, documentation        │
│  ✓ Self-Review      - Using subagents to validate own work      │
│  ✓ Artifact Creation - Docs that survive session restarts       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Core Principles

#### Principle 1: Externalized Cognition

Claude has no memory between sessions. Therefore:

- **All knowledge must be externalized** into workspace artifacts
- Each phase produces documents that feed the next phase
- `/wrapup` saves session notes; next session resumes automatically
- Memory lives in documents, not sessions

#### Principle 2: Hard Gates, Not Suggestions

Approval gates are BLOCKING:

- **"Do not continue until I have approved your todos"** - Claude MUST STOP
- Human types explicit approval keyword (APPROVED, REVISE, ABORT)
- Silence is NOT approval - Claude waits indefinitely
- This is a commitment device for both parties

#### Principle 3: Phase Separation Via Slash Commands

The phase structure is enforced via **self-contained slash commands**:

| Phase | Command      | Output                                        |
| ----- | ------------ | --------------------------------------------- |
| 01    | `/analyze`   | `01-analysis/`, `02-plans/`, `03-user-flows/` |
| 02    | `/todos`     | `todos/active/`                               |
| 03    | `/implement` | `src/`, `apps/`, `docs/`                      |
| 04    | `/redteam`   | `04-validate/`                                |
| 05    | `/codify`    | Updates existing agents and skills            |

Each command is self-contained -- it includes workspace detection, workflow steps, and agent teams.

#### Principle 4: Self-Sustaining Goal

The end state is a project where:

- **Agents** in `.claude/agents/` understand what to do (updated by `/codify`)
- **Skills** in `.claude/skills/` know how to do it (updated by `/codify`)
- **Docs** in `docs/00-developers/` provide full context
- **Future sessions** can work WITHOUT these instruction templates

Exit criteria: Test that agents/skills work standalone.

#### Principle 5: Fresh Sessions Are Features

Long sessions accumulate:

- Conflicting context
- Forgotten constraints
- Decision fatigue
- Compounding errors

Fresh sessions with well-documented context are MORE reliable:

- Each session starts clean
- Context is focused and curated
- Input (instruction doc) is inspectable
- Behavior is reproducible

#### Principle 6: Session Strategy Matrix

Choose the right session strategy for each situation:

| Strategy            | When to Use                                            | Mechanism                                 |
| ------------------- | ------------------------------------------------------ | ----------------------------------------- |
| **Resume**          | Continuing the same task, no external changes          | `--resume` flag or session continuation   |
| **Fork**            | Exploring an alternative approach from shared baseline | Parallel worktrees, `fork_session`        |
| **Fresh + Summary** | Tool results stale, context degraded, switching focus  | New session with `/wrapup` notes injected |

**The Stale Context Trap**: If you resume a session after modifying files externally (IDE, another terminal), Claude may give contradictory advice based on cached tool results that no longer reflect reality. Either inform Claude about specific changes or start fresh with a summary.

For deep coverage of session management patterns, see [Guide 13 - Agentic Architecture](13-agentic-architecture.md).

---

## Part 2: The Phase Pipeline

### Phase Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                        PHASE 1: ANALYSIS                         │
│                                                                  │
│  Input: Human objectives, domain knowledge, constraints          │
│  Process: VP/USP, AAA, Platform, Network Effects analysis        │
│  Output: docs/01-analysis/* artifacts                           │
│                                                                  │
│  GATE: Human verifies artifacts exist                            │
│                                                                  │
└─────────────────────────┬───────────────────────────────────────┘
                          │ Human pastes Phase 2 template
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                        PHASE 2: PLANNING                         │
│                                                                  │
│  Input: Phase 1 artifacts, docs/01-analysis/*                   │
│  Process: Create todos, framework selection, architecture       │
│  Output: todos/active/*, docs/02-plans/*                        │
│                                                                  │
│  GATE: "Do not continue until I have approved your todos"        │
│  Human types: APPROVED / REVISE / ABORT                          │
│                                                                  │
└─────────────────────────┬───────────────────────────────────────┘
                          │ Human types APPROVED
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                     PHASE 3: IMPLEMENTATION                      │
│                                                                  │
│  Input: Approved todos, docs/02-plans/*                         │
│  Process: Implementation loop (spam until todos complete)        │
│  Output: Code, tests, docs/00-developers/*                      │
│                                                                  │
│  Session Resume: docs/04-codegen-instructions/* for fresh starts │
│                                                                  │
└─────────────────────────┬───────────────────────────────────────┘
                          │ All todos completed
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                       PHASE 4: VALIDATION                        │
│                                                                  │
│  Input: Completed implementation                                 │
│  Process: E2E testing, parity validation, LLM evaluation         │
│  Output: Human validation checklist, test results                │
│                                                                  │
│  GATE: Human validates outcome manually                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Why Phases Are Separate Files

**Problem**: If all phases are in one file, Claude may:

- Skip analysis and jump to implementation
- Proceed without approval
- Conflate different concerns

**Solution**: Separate template files force natural gates:

- Human must consciously decide to paste next phase
- Phase 1 artifacts MUST exist before Phase 2 makes sense
- Each phase has focused context

---

## Part 3: The docs/\* Artifact Structure

### Directory Purposes

| Directory                       | Purpose                                                           | Lifecycle                      |
| ------------------------------- | ----------------------------------------------------------------- | ------------------------------ |
| `docs/00-developers/`           | **Final developer documentation** - "what it is", "how to use it" | Continuously updated           |
| `docs/01-analysis/`             | **Phase 1 artifacts** - VP, USP, AAA, platform analysis           | Created once, referenced often |
| `docs/02-plans/`                | **Phase 2 artifacts** - Architecture decisions, approved plans    | Approval record                |
| `docs/03-user-flows/`           | **User journey documentation**                                    | Reference for validation       |
| `docs/04-codegen-instructions/` | **Session resume documents** - Bootstrap fresh sessions           | Ephemeral, operational         |

### The 00- Prefix is Significant

`docs/00-developers/` appears FIRST in directory listings because:

- Developers are the primary audience
- Implementation details (01-04) support developer needs
- The project exists to serve developers

### Session Resume Documents

`docs/04-codegen-instructions/` solves the **cold start problem**:

**Without session resume docs:**

```
Human: "Continue working on feature X"
Claude: "I have no context. What is feature X?"
[30 minutes of re-explaining]
```

**With session resume docs:**

```
Human: [Pastes docs/04-codegen-instructions/feature-x.md]
Claude: "I have full context. Continuing from step 3..."
[Immediate productive work]
```

These are **worktree-specific** and **disposable** - operational scaffolding, not permanent documentation.

---

## Part 4: Hard Approval Gates

### The Commitment Device

When instructions say **"Do not continue until I have approved your todos"**:

1. Claude presents the todo list
2. Claude STOPS and WAITS
3. Human reviews and responds with:
   - **APPROVED** - Proceed to implementation
   - **REVISE: [feedback]** - Make adjustments, re-present
   - **ABORT** - Stop work entirely

**Silence is NOT approval.** Claude does not interpret lack of response as permission to proceed.

### Why Hard Gates Matter

| Without Gates                           | With Gates                      |
| --------------------------------------- | ------------------------------- |
| AI jumps to coding before understanding | Analysis must complete first    |
| Architectural decisions are implicit    | Decisions are documented        |
| Scope creep is invisible                | Approved todos define scope     |
| Errors compound                         | Errors caught at cheapest point |

### Gate Locations

| Phase Transition            | Gate Requirement                          |
| --------------------------- | ----------------------------------------- |
| Analysis → Planning         | Human verifies docs/01-analysis/\* exists |
| Planning → Implementation   | Human types APPROVED on todo list         |
| Implementation → Validation | Human pastes validation template          |
| Validation → Complete       | Human confirms outcome matches criteria   |

---

## Part 5: Product Strategy Frameworks

These frameworks are **NOT in Claude's agents/skills** and must be explicitly invoked:

### AAA Framework (Digital Enterprise Transformation)

Every feature should align with at least one:

- **Automate**: Reduce operational costs
- **Augment**: Reduce decision-making costs
- **Amplify**: Reduce expertise costs (for scaling)

If a feature doesn't align with AAA, question whether it should be built.

### Platform Model Thinking

Analyze the solution as a platform with:

- **Producers**: Users who offer/deliver products/services
- **Consumers**: Users who consume products/services
- **Partners**: Facilitators of transactions between producers and consumers

### Network Effects (5 Behaviors)

Features must cover:

- **Accessibility**: Easy transaction completion
- **Engagement**: Useful transaction information
- **Personalization**: Curated information for intended use
- **Connection**: Connected information sources (one/two-way)
- **Collaboration**: Seamless producer-consumer work

### 80/15/5 Reusability Rule

All decisions must respect:

- **80%**: Agnostic, reusable features (core)
- **15%**: Client-specific but configurable (self-service)
- **5%**: Pure customization (requires justification)

**GATE**: If custom work exceeds 5%, STOP and escalate. This indicates wrong product-market fit or need for refactoring.

---

## Part 6: Multi-Session Workflow

### The "Spam Repeatedly" Pattern

Implementation instructions say: **"Spam this repeatedly until all todos/active have been moved to todos/completed"**

This pattern:

- Each iteration is a fresh session (no accumulated errors)
- The instruction document provides consistent context
- Progress is tracked via todo completion (externalized state)
- Human can pause, resume, or adjust between iterations

### Worktree-Specific Instructions

For parallel development:

```
docs/04-codegen-instructions/
├── 01-backend-worktree.md      # Backend terminal
├── 02-web-worktree.md          # Web frontend terminal
├── 03-mobile-worktree.md       # Mobile app terminal
└── 04-integration-guide.md     # How codebases merge
```

Each worktree has its own context document. Multiple Claude sessions can work in parallel on different worktrees.

### Context Loading for Fresh Sessions

Every session resume document must begin with:

```markdown
## Context Loading

Peruse this document and actively reference any linked docs to achieve
high situational awareness. Check todos/active/ for current state.
Then proceed with implementation.
```

---

## Part 7: Self-Sustainability Exit Criteria

### The Goal

After completing all phases, the project should have agents/skills that work **WITHOUT** these instruction templates.

### Validation Test

1. Start a fresh Claude session
2. Ask: "Using the agents in `.claude/agents/` and skills in `.claude/skills/`, implement [new feature X]"
3. Claude should be able to:
   - Understand what to do (agents)
   - Know how to do it (skills)
   - Reference knowledge base (docs/00-developers/)

If Claude cannot complete the task without returning to instruction templates, the agents/skills are **INCOMPLETE**.

### What Self-Sustaining Looks Like

| Future Task           | How It's Handled                                       |
| --------------------- | ------------------------------------------------------ |
| Bug fix               | Agent knows process, skill has patterns                |
| New feature           | Agent coordinates specialists, skills provide patterns |
| Onboarding            | docs/00-developers/ provides full context              |
| Architecture question | ADRs in docs/02-plans/ explain decisions               |

---

## Part 8: What Humans Focus On

### Human Responsibilities

| Focus Area           | Examples                                       | When                  |
| -------------------- | ---------------------------------------------- | --------------------- |
| **Objectives**       | Business goals, user outcomes, success metrics | Start of project      |
| **Domain Expertise** | Industry knowledge, regulatory requirements    | Throughout            |
| **Constraints**      | Technology stack, budget, timeline, compliance | Start and adjustments |
| **Approval Gates**   | APPROVED/REVISE/ABORT at phase transitions     | Between phases        |
| **Final Validation** | Testing against objectives, user acceptance    | End of implementation |

### What Humans DON'T Do

| Don't Do                  | Why                              | Instead                          |
| ------------------------- | -------------------------------- | -------------------------------- |
| Specify implementation    | Limits Claude's solution space   | Describe outcomes                |
| Review each file          | Slows progress, reduces autonomy | Review via testing               |
| Skip approval gates       | Defeats quality control          | Always provide explicit approval |
| Proceed without artifacts | Future sessions lose context     | Ensure docs/\* are created       |

---

## Part 9: Template Usage Guide

### Choosing the Right Template

| Situation                       | Template File                                                          | Expected Duration |
| ------------------------------- | ---------------------------------------------------------------------- | ----------------- |
| New or existing project         | `01-analyze.md` → `02-todos.md` → `03-implement.md` → `04-validate.md` | Multi-session     |
| Single feature (project exists) | `03-implement.md` (with approved todos)                                | 1-2 sessions      |
| Validation only                 | `04-validate.md`                                                       | 1 session         |

### Template Workflow

1. **Copy the template** - Don't excerpt, copy all of it
2. **Fill in HUMAN INPUT section** - This is YOUR domain
3. **Paste into Claude terminal** - Let Claude execute
4. **Wait for GATE** - Claude will stop and wait for approval
5. **Provide explicit approval** - Type APPROVED, REVISE, or ABORT
6. **Repeat for next phase** - Paste next template when ready

---

## Summary

### Key Operational Points

1. **Phases are enforced via file separation** - You can't skip phases
2. **Gates require explicit approval keywords** - Silence is not approval
3. **Artifacts survive sessions** - Memory lives in docs/\*
4. **Fresh sessions load from docs/04-codegen-instructions/** - Cold start solved
5. **End goal is self-sustaining agents/skills** - Templates become unnecessary

### The Philosophy

> "A project that contains enough documented knowledge that it can be extended, maintained, and evolved by any competent developer (human or AI) without access to the original creators."

This is **autonomous maintainability** - where the project maintains itself.

---

## Navigation

- **[01-what-is-claude-code.md](01-what-is-claude-code.md)** - Next: Understanding Claude Code
- **[README.md](README.md)** - Guide index
- **[commands/](../../commands/)** - Phase slash commands (`/analyze`, `/todos`, `/implement`, `/redteam`, `/codify`)
