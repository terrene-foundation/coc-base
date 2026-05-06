# Guide 05: The Agent System

## Introduction

While commands load knowledge, **agents provide specialized processing**. Think of agents as expert consultants that Claude can call upon for tasks requiring deep expertise that simple patterns can't address.

By the end of this guide, you will understand:

- What agents are and how they differ from skills
- Every available agent and what it specializes in
- When Claude delegates to agents automatically
- How to explicitly request agent delegation
- The phases where different agents are used

---

## Part 1: What Are Agents?

### The Problem Agents Solve

Some tasks require more than pattern matching. They require:

- **Deep domain expertise** - Knowing not just what, but why
- **Multi-step reasoning** - Complex analysis across multiple dimensions
- **Judgment calls** - Decisions that can't be reduced to rules
- **Specialized validation** - Checks specific to certain domains

### Skills vs. Agents

| Aspect         | Skills                                | Agents                                 |
| -------------- | ------------------------------------- | -------------------------------------- |
| **Content**    | Patterns, templates, quick references | Processes, analysis methods, expertise |
| **Size**       | 50-250 lines                          | 100-300 lines                          |
| **Purpose**    | Show HOW to do things                 | DECIDE what to do                      |
| **Invocation** | Commands load them                    | Claude delegates to them               |
| **Processing** | None (just information)               | Active analysis and reasoning          |

### How Agent Delegation Works

```
┌──────────────────────────────────────────────────────────────┐
│                     YOUR REQUEST                              │
│        "Review this code for security issues"                 │
└────────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                      CLAUDE CODE                              │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Analysis: This requires security expertise               ││
│  │ Decision: Delegate to security-reviewer agent            ││
│  └─────────────────────────────────────────────────────────┘│
│                             │                                 │
│                             ▼                                 │
│  ┌─────────────────────────────────────────────────────────┐│
│  │           SECURITY-REVIEWER AGENT                        ││
│  │                                                          ││
│  │  • Runs OWASP Top 10 checklist                          ││
│  │  • Scans for hardcoded secrets                          ││
│  │  • Checks input validation                               ││
│  │  • Reviews authentication flows                          ││
│  │  • Returns structured findings                           ││
│  └─────────────────────────────────────────────────────────┘│
│                             │                                 │
│                             ▼                                 │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Claude integrates agent findings into response           ││
│  └─────────────────────────────────────────────────────────┘│
└────────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                    YOUR RESULT                                │
│       Comprehensive security review with actionable items     │
└──────────────────────────────────────────────────────────────┘
```

---

## Part 2: Agent Categories

### Analysis & Planning Agents

These agents help understand requirements and plan implementation.

#### `analyst`

**Expertise**: Failure point analysis, root cause investigation, complexity assessment

**When used**:

- Planning complex features
- Debugging systemic issues
- Evaluating architectural trade-offs

**What it does**:

1. Conducts failure point analysis (technical + business risks)
2. Applies 5-Why framework for root cause investigation
3. Scores complexity (Simple/Moderate/Enterprise)
4. Creates risk prioritization matrix
5. Identifies existing solutions to reuse

**Example request**:

```
> Analyze the requirements for adding multi-tenancy to our application
```

Claude delegates to `analyst` → Returns executive summary, risk register, implementation phases.

#### `analyst`

**Expertise**: Requirements breakdown, Architecture Decision Records (ADR)

**When used**:

- Starting complex features
- Creating formal documentation
- Making architectural decisions

**What it does**:

1. Systematically breaks down requirements
2. Creates ADR documentation
3. Identifies dependencies and constraints
4. Maps requirements to implementation tasks

**Example request**:

```
> Create an ADR for our authentication system choice
```


**Expertise**: Finding patterns in SDK documentation

**When used**:

- Finding existing solutions before coding
- Resolving errors during development
- Locating specific patterns or examples

**What it does**:

1. Searches SDK documentation efficiently
2. Uses pre-built file indexes
3. Finds relevant patterns and examples
4. Provides specific file:line references

**Example request**:

```
> Find existing patterns for handling workflow errors
```

#### ``decide-framework` skill`

**Expertise**: Choosing between Core SDK, DataFlow, Nexus, Kaizen

**When used**:

- Starting a new project
- Deciding which framework to use
- Understanding framework trade-offs

**What it does**:

1. Analyzes requirements against framework capabilities
2. Recommends appropriate framework(s)
3. Coordinates with framework specialists
4. Provides migration guidance if needed

**Example request**:

```
> Should I use DataFlow or raw Core SDK for this database feature?
```

### Framework Specialist Agents

These agents provide deep expertise in specific frameworks.

#### `dataflow-specialist`

**Expertise**: DataFlow database framework

**When used**:

- Creating database models
- Implementing CRUD operations
- Bulk data processing
- Multi-tenancy patterns

**What it knows**:

- `@db.model` decorator patterns
- Auto-generated node usage (11 nodes per model)
- PostgreSQL vs SQLite differences
- Migration control and schema management
- Critical gotchas (no manual timestamps, `id` primary key)

**Example request**:

```
> Help me implement bulk user import with DataFlow
```

#### `nexus-specialist`

**Expertise**: Nexus multi-channel platform

**When used**:

- Deploying workflows as APIs
- Creating CLI interfaces
- Setting up MCP servers
- Multi-channel session management

**What it knows**:

- Zero-config initialization
- Workflow registration patterns
- API + CLI + MCP deployment
- DataFlow integration warnings
- Session management strategies

**Example request**:

```
> Deploy my user management workflow as a REST API
```

#### `kaizen-specialist`

**Expertise**: Kaizen AI agent framework

**When used**:

- Building AI agents
- Multi-agent coordination
- Signature-based programming
- Multi-modal processing

**What it knows**:

- BaseAgent architecture
- Unified Agent API (v1.0.0)
- Execution modes (autonomous, supervised)
- Tool access patterns
- A2A protocol integration

**Example request**:

```
> Create an autonomous agent that can analyze documents
```

#### `mcp-specialist`

**Expertise**: Model Context Protocol implementation

**When used**:

- Implementing MCP servers
- MCP client integration
- Tool and resource exposure

**What it knows**:

- MCP transport patterns (stdio, SSE, HTTP)
- Tool and resource definitions
- Authentication patterns
- Progress reporting

**Example request**:

```
> Expose my workflow as an MCP tool
```

### Implementation Agents

These agents help write and validate code.

#### `pattern-expert`

**Expertise**: Core SDK patterns (workflows, nodes, parameters)

**When used**:

- Implementing workflows
- Debugging pattern issues
- Understanding node connections

**What it knows**:

- WorkflowBuilder patterns
- Node parameter handling
- Connection validation
- Cyclic workflow patterns
- Conditional execution

**Example request**:

```
> Debug why my workflow nodes aren't connecting properly
```

#### `tdd-implementer`

**Expertise**: Test-Driven Development methodology

**When used**:

- Writing tests before code
- Following TDD workflow
- Ensuring test coverage

**What it does**:

1. Writes tests first (Red phase)
2. Implements minimal code to pass (Green phase)
3. Refactors for quality (Refactor phase)
4. Ensures Real infrastructure recommended in Tier 2-3

**Example request**:

```
> Implement user registration following TDD
```

#### `testing-specialist`

**Expertise**: 3-tier testing strategy

**When used**:

- Understanding test requirements
- Choosing test approaches
- Debugging test failures

**What it knows**:

- Tier 1: Unit tests (mocking allowed)
- Tier 2: Integration tests (Real infrastructure recommended)
- Tier 3: End-to-end tests (Real infrastructure recommended)
- Real infrastructure patterns
- Test organization

**Example request**:

```
> What's the right approach for testing my DataFlow models?
```

#### `gold-standards-validator`

**Expertise**: Compliance checking against standards

**When used**:

- Validating code quality
- Catching violations early
- Pre-commit checks

**What it checks**:

- Absolute import compliance
- Parameter validation patterns
- Security best practices
- Testing policy adherence

**Example request**:

```
> Check if my code follows gold standards
```

### Review Agents

These agents review and validate work.

#### `reviewer`

**Expertise**: Checkpoint reviews and progress critique

**When used**:

- After todo creation (review completeness)
- After component implementation (review quality)
- At milestones (review progress)

**What it does**:

1. Reviews against requirements
2. Identifies gaps and issues
3. Suggests improvements
4. Validates milestone completion

**Example request**:

```
> Review my implementation before I move to the next component
```

#### `security-reviewer`

**Expertise**: Security review and vulnerability detection

**When used**:

- Before commits (mandatory)
- Reviewing authentication code
- Checking for secrets exposure

**What it checks**:

- OWASP Top 10 vulnerabilities
- Hardcoded secrets
- Input validation
- SQL injection prevention
- Authentication flows

**Example request**:

```
> Security review this authentication code
```

#### `reviewer`

**Expertise**: Documentation accuracy and testing

**When used**:

- Validating code examples
- Ensuring documentation accuracy
- Testing documentation completeness

**What it does**:

1. Tests all code examples actually work
2. Verifies documentation matches implementation
3. Checks for stale references
4. Validates links and paths

**Example request**:

```
> Verify all code examples in the README work
```

### Frontend Specialist Agents

These agents provide deep expertise in frontend development across frameworks.

#### `uiux-designer`

**Expertise**: UI/UX design principles and enterprise UX patterns

**When used**:

- Designing new pages, features, or interfaces
- Evaluating existing UI for usability issues
- Making layout, spacing, or hierarchy decisions
- Creating design specifications

**What it knows**:

- Top-down design methodology
- Layout and information architecture
- Visual hierarchy principles (F-pattern, Z-pattern)
- Enterprise UX patterns
- WCAG accessibility standards

**Example request**:

```
> Analyze the contacts search page layout and identify usability issues
```

#### `react-specialist`

**Expertise**: React frontend development and component architecture

**When used**:

- Creating responsive React components
- Converting mockups to functional code
- Implementing API integration with @tanstack/react-query
- Structuring frontend projects

**What it knows**:

- React component architecture (elements/ pattern)
- One API call per component pattern
- Shadcn UI component usage
- Responsive design patterns
- State management (Zustand, Redux, React Query)

**Example request**:

```
> Create a responsive user list component with loading states
```

#### `react-specialist`

**Expertise**: React 19 and Next.js 15 patterns

**When used**:

- Building production-grade React/Next.js frontends
- Implementing workflow editors with React Flow
- Creating admin dashboards
- AI agent interfaces

**What it knows**:

- React 19 features (Server Components, Actions)
- Next.js 15 patterns (App Router, Middleware)
- React Flow for workflow visualization
- React Query patterns
- TypeScript best practices

**Example request**:

```
> Create a workflow editor using React Flow with Nexus integration
```

#### `flutter-specialist`

**Expertise**: Flutter cross-platform development

**When used**:

- Building mobile apps for Kailash workflows
- Creating Flutter UI for Nexus/DataFlow/Kaizen
- Setting up Riverpod state management
- Building cross-platform (iOS/Android/Web/Desktop) apps

**What it knows**:

- Flutter design system patterns
- Riverpod state management
- Responsive design across phone/tablet/desktop
- Kailash SDK integration patterns
- Material Design 3 theming

**Example request**:

```
> Create a Flutter mobile app for the user management workflow
```

### Infrastructure Agents

#### `release-specialist`

**Expertise**: Docker and Kubernetes deployment

**When used**:

- Setting up local development
- Configuring production deployment
- Environment management

**What it knows**:

- Docker Compose patterns
- Kubernetes configurations
- Environment variables and secrets
- Health checks and monitoring
- Horizontal scaling

**Example request**:

```
> Set up Kubernetes deployment for my application
```

#### `release-specialist`

**Expertise**: Git workflows and releases

**When used**:

- Pre-commit validation
- Creating pull requests
- Version management

**What it does**:

1. Runs code quality tools (black, isort, ruff)
2. Creates feature branches
3. Manages PR workflows
4. Handles version releases

**Example request**:

```
> Prepare this code for a PR
```

### Management Agents

#### `todo-manager`

**Expertise**: Task management and tracking

**When used**:

- Creating task breakdowns
- Tracking progress
- Managing project todos

**What it does**:

1. Creates detailed task lists
2. Tracks completion status
3. Identifies dependencies
4. Maintains todo hierarchy

**Example request**:

```
> Create a task breakdown for implementing user auth
```

#### `gh-manager`

**Expertise**: GitHub project management

**When used**:

- Syncing with GitHub Projects
- Creating issues
- Managing sprints

**What it does**:

1. Creates GitHub issues from requirements
2. Links issues to projects
3. Tracks sprint progress
4. Manages labels and milestones

**Example request**:

```
> Create GitHub issues for our sprint backlog
```

---

## Part 3: Development Phase Mapping

### Phase 1: Analysis

```
```

| Agent                  | Purpose in Phase                     |
| ---------------------- | ------------------------------------ |
| `analyst`         | Identify risks and failure points    |
| `analyst` | Break down requirements, create ADRs |
| ``decide-framework` skill`    | Select appropriate frameworks        |

### Phase 2: Planning

```
todo-manager → gh-manager → reviewer
```

| Agent                   | Purpose in Phase               |
| ----------------------- | ------------------------------ |
| `todo-manager`          | Create detailed task breakdown |
| `gh-manager`            | Sync tasks to GitHub           |
| `reviewer` | Validate plan completeness     |

### Phase 3: Implementation

```
tdd-implementer → pattern-expert → [framework-specialist] → gold-standards-validator → reviewer
```

| Agent                      | Purpose in Phase             |
| -------------------------- | ---------------------------- |
| `tdd-implementer`          | Write tests first            |
| `pattern-expert`           | Implement using SDK patterns |
| `[framework-specialist]`   | Framework-specific guidance  |
| `gold-standards-validator` | Validate compliance          |
| `reviewer`    | Review implementation        |

### Phase 4: Testing

```
testing-specialist → reviewer
```

| Agent                     | Purpose in Phase     |
| ------------------------- | -------------------- |
| `testing-specialist`      | Verify test coverage |
| `reviewer` | Test code examples   |

### Phase 5: Deployment

```
release-specialist
```

| Agent                   | Purpose in Phase        |
| ----------------------- | ----------------------- |
| `release-specialist` | Docker/Kubernetes setup |

### Phase 6: Release

```
release-specialist → security-reviewer
```

| Agent                    | Purpose in Phase                   |
| ------------------------ | ---------------------------------- |
| `release-specialist` | Pre-commit validation, PR creation |
| `security-reviewer`      | Security audit before commit       |

### Phase 7: Final

```
reviewer
```

| Agent                   | Purpose in Phase |
| ----------------------- | ---------------- |
| `reviewer` | Final critique   |

---

## Part 4: Automatic vs. Explicit Delegation

### Automatic Delegation

Claude automatically delegates based on task type:

| Request Contains                         | Delegates To               |
| ---------------------------------------- | -------------------------- |
| "security review", "vulnerability"       | `security-reviewer`        |
| "DataFlow", "database model"             | `dataflow-specialist`      |
| "Nexus", "deploy as API"                 | `nexus-specialist`         |
| "Kaizen", "AI agent"                     | `kaizen-specialist`        |
| "test", "testing strategy"               | `testing-specialist`       |
| "analyze requirements", "failure points" | `analyst`             |
| "compliance", "gold standards"           | `gold-standards-validator` |

### Explicit Delegation

You can explicitly request agent delegation:

```
> Use the dataflow-specialist to help with database design

> Use the analyst to assess risks for this feature

> Use the security-reviewer to audit this authentication code
```

### Chaining Multiple Agents

For complex tasks, request multiple agents:

```
> Use the analyst, analyst, and `decide-framework` skill
  to fully analyze this feature request
```

Claude will invoke each agent in sequence, building on previous results.

---

## Part 5: Agent Output Formats

### Analysis Agents Output

```
## Executive Summary
[2-3 sentence overview with complexity score]

## Risk Register
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| ... | ... | ... | ... |

## Implementation Phases
1. Phase 1: [description]
   - Success criteria: [measurable]
2. Phase 2: [description]
   ...

## Decision Points
- [Questions requiring stakeholder input]
```

### Review Agents Output

```
## Review Summary
[Pass/Fail with key findings]

## Issues Found
1. [Issue description]
   - Location: file:line
   - Severity: Critical/Major/Minor
   - Recommendation: [fix]

## Recommendations
- [Improvement suggestions]
```

### Specialist Agents Output

````
## Recommendation
[Framework-specific guidance]

## Code Pattern
```python
# Correct implementation
...
````

## Gotchas

❌ [Anti-pattern]: [Consequence]
✅ [Correct approach]: [Why]

## References

- [Relevant documentation links]

```

---

## Part 6: Agent Architecture Patterns

### Hub-and-Spoke Topology

Claude Code uses a **hub-and-spoke** orchestration model: Claude acts as the central coordinator, with specialized subagents around the perimeter. All communication flows through the coordinator — subagents never communicate directly with each other.

```

                    ┌─────────────┐
                    │  Research    │
                    │  Agent       │
                    └──────┬──────┘
                           │

┌─────────────┐ ┌──────┴──────┐ ┌─────────────┐
│ Analysis │────│ Claude │────│ Synthesis │
│ Agent │ │ (Hub) │ │ Agent │
└─────────────┘ └──────┬──────┘ └─────────────┘
│
┌──────┴──────┐
│ Validation │
│ Agent │
└─────────────┘

```

The coordinator is responsible for: **task decomposition** (breaking requests into subtasks), **agent selection** (choosing which specialist handles each), **context passing** (providing each agent with needed information), and **result aggregation** (combining outputs into a coherent response).

### Critical Memory Isolation

**Subagents do NOT share memory with the coordinator or each other.** Each subagent:

- Starts with a fresh context window
- Does not see the coordinator's conversation history
- Does not see other subagents' inputs or outputs
- Receives only what the coordinator explicitly passes to it

This means the coordinator must be explicit about what each subagent needs. If you assume shared context, subagents receive insufficient information and produce incomplete results.

### Attention Dilution Warning

When processing **14+ items in a single pass** (e.g., reviewing many files), analysis depth becomes inconsistent — early items get detailed feedback, later items get superficial treatment. The fix is **multi-pass architecture**: analyze each item individually (consistent depth), then synthesize across items in a separate pass.

This is why the **Explore agent** is valuable — it processes files in its own context window, ensuring consistent depth, then returns a summary for integration.

For deep coverage of these patterns, see [Guide 13 - Agentic Architecture](13-agentic-architecture.md).

### Agents Cannot Call Agents

Subagents operate in separate context windows and **cannot invoke other subagents**. Coordination happens through Claude Code:

```

┌─────────────────────────────────────────────────────────────┐
│ CLAUDE CODE │
│ (Coordinator) │
│ │
│ ┌─────────┐ ┌─────────┐ ┌─────────┐ │
│ │ Agent 1 │ ──▶ │ Agent 2 │ ──▶ │ Agent 3 │ │
│ └─────────┘ └─────────┘ └─────────┘ │
│ │
│ Results from each agent inform the next delegation │
└─────────────────────────────────────────────────────────────┘

````

### Handoff Patterns

Agents document which other agents should be consulted:

```markdown
## Related Agents

- **analyst**: Hand off for formal ADR creation
- **`decide-framework` skill**: Consult for framework selection
- **testing-specialist**: Hand off for test strategy
````

Claude uses these hints to coordinate effectively.

---

## Part 7: Common Agent Workflows

### Workflow 1: New Feature

```
1. analyst
   └── Analyze risks and complexity

2. analyst
   └── Break down requirements

3. `decide-framework` skill
   └── Select frameworks

4. todo-manager
   └── Create task breakdown

5. [For each component]
   └── tdd-implementer → pattern-expert → gold-standards-validator

6. reviewer
   └── Review implementation

7. security-reviewer + release-specialist
   └── Prepare for commit
```

### Workflow 2: Bug Fix

```
   └── Find similar issues in documentation

2. pattern-expert
   └── Understand correct patterns

3. tdd-implementer
   └── Write regression test

4. gold-standards-validator
   └── Validate fix

5. security-reviewer
   └── Check fix doesn't introduce vulnerabilities
```

### Workflow 3: Code Review

```
1. reviewer
   └── General code quality

2. security-reviewer
   └── Security issues

3. gold-standards-validator
   └── Compliance check
```

### Workflow 4: Documentation Update

```
1. reviewer
   └── Test existing examples

2. [Make changes]

3. reviewer
   └── Test new examples
```

---

## Part 8: Key Takeaways

### Summary

1. **Agents provide specialized expertise** - Not just patterns, but judgment and analysis

2. **30 agents cover all phases** - From analysis to frontend to release

3. **Automatic delegation is smart** - Claude chooses agents based on task type

4. **Explicit delegation is reliable** - Request specific agents when needed

5. **Agents coordinate through Claude** - They can't call each other directly

6. **Outputs are structured** - Each agent type has standard output formats

### Quick Reference

| Need                   | Agent                      |
| ---------------------- | -------------------------- |
| Risk analysis          | `analyst`             |
| Requirements breakdown | `analyst`     |
| Choose framework       | ``decide-framework` skill`        |
| Database help          | `dataflow-specialist`      |
| API deployment         | `nexus-specialist`         |
| AI agents              | `kaizen-specialist`        |
| MCP integration        | `mcp-specialist`           |
| UI/UX design           | `uiux-designer`            |
| React components       | `react-specialist`       |
| React 19/Next.js       | `react-specialist`         |
| Flutter mobile         | `flutter-specialist`       |
| Write tests first      | `tdd-implementer`          |
| Test strategy          | `testing-specialist`       |
| Code compliance        | `gold-standards-validator` |
| Security audit         | `security-reviewer`        |
| Implementation review  | `reviewer`    |
| Documentation testing  | `reviewer`  |
| Deployment setup       | `release-specialist`    |
| Git/PR workflow        | `release-specialist`   |
| Task management        | `todo-manager`             |
| GitHub projects        | `gh-manager`               |

---

## What's Next?

Agents use skills for their knowledge base. The next guide explains the skill system in detail.

**Next: [06 - The Skill System](06-the-skill-system.md)**

---

## Navigation

- **Previous**: [04 - The Command System](04-the-command-system.md)
- **Next**: [06 - The Skill System](06-the-skill-system.md)
- **Home**: [README.md](README.md)
