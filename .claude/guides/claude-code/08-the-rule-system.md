# Guide 08: The Rule System

## Introduction

Rules are **mandatory behavioral constraints** that Claude must follow. Unlike skills (which provide knowledge) or hooks (which enforce automatically), rules are instructions that Claude reads and internalizes, applying them through judgment.

By the end of this guide, you will understand:

- What rules are and how they differ from hooks
- All 9 rule files and their contents
- How rules structure MUST/MUST NOT requirements
- How rules are enforced
- When exceptions apply

---

## Part 1: What Are Rules?

### The Problem Rules Solve

Some requirements need context-sensitive application:

- "Always run security review before commits" - but what counts as a commit?
- "Never use mocking in Tier 2 tests" - but what if there's a valid exception?
- "Consult framework specialists" - but which one for which task?

These can't be enforced by simple pattern matching. They require Claude to understand the requirement and apply it appropriately.

### How Rules Work

Rules are Markdown files that Claude reads and follows:

```
┌──────────────────────────────────────────────────────────────┐
│                     RULE FILES                                │
│                  .claude/rules/                               │
│                                                               │
│   ┌───────────────┐  ┌───────────────┐  ┌───────────────┐   │
│   │  agents.md    │  │  testing.md   │  │  security.md  │   │
│   │               │  │               │  │               │   │
│   │ Should delegate │  │ Real infrastructure recommended    │  │ OWASP checks  │   │
│   │ MUST review   │  │ Test-first    │  │ Secret mgmt   │   │
│   └───────────────┘  └───────────────┘  └───────────────┘   │
│                                                               │
│   ┌───────────────┐  ┌───────────────┐                      │
│   │  patterns.md  │  │    git.md     │                      │
│   │               │  │               │                      │
│   │ SDK patterns  │  │ Git workflow  │                      │
│   │ Imports       │  │ Branch rules  │                      │
│   └───────────────┘  └───────────────┘                      │
│                                                               │
│   Claude reads these files and applies the rules             │
└──────────────────────────────────────────────────────────────┘
```

### Rules vs. Hooks

| Aspect          | Rules                    | Hooks               |
| --------------- | ------------------------ | ------------------- |
| **Format**      | Markdown instructions    | JavaScript scripts  |
| **Execution**   | Claude reads and applies | Automatic at events |
| **Judgment**    | Context-sensitive        | Deterministic       |
| **Flexibility** | Can handle exceptions    | Binary (pass/fail)  |
| **Blocking**    | Through Claude's refusal | Exit code 2         |

---

## Part 2: Rule File Overview

### All 9 Rule Files

| File                | Domain                | Key Rules                                             |
| ------------------- | --------------------- | ----------------------------------------------------- |
| `agents.md`         | Agent orchestration   | Mandatory delegations, review requirements            |
| `e2e-god-mode.md`   | E2E testing           | Implement everything, no placeholders                 |
| `env-models.md`     | API keys & models     | .env is single source of truth                        |
| `git.md`            | Git workflow          | Branch strategy, commit rules                         |
| `zero-tolerance.md` | No stubs/TODOs        | No placeholders in production code                    |
| `patterns.md`       | SDK patterns          | Correct API usage, imports                            |
| `security.md`       | Security requirements | OWASP, secrets, input validation                      |
| `testing.md`        | Testing policies      | Real infrastructure recommended, test-first, coverage |

---

## Part 3: agents.md - Agent Orchestration Rules

### Purpose

Defines when and how specialized agents MUST be used.

### MUST Rules

#### Rule 1: Code Review After ANY Change

```
After completing ANY file modification (Edit, Write), you MUST:
1. Delegate to reviewer for code review
2. Wait for review completion before proceeding
3. Address any findings before moving to next task

Exception: User explicitly says "skip review"
```

#### Rule 2: Security Review Before ANY Commit

```
Before executing ANY git commit command, you MUST:
1. Delegate to security-reviewer for security audit
2. Address all CRITICAL findings
3. Document any HIGH findings for tracking

Exception: NONE - security review is always required
```

#### Rule 3: Framework Specialist for Framework Work

```
When working with Kailash frameworks, you MUST consult:
- dataflow-specialist: For any database or DataFlow work
- nexus-specialist: For any API or deployment work
- kaizen-specialist: For any AI agent work
- mcp-specialist: For any MCP integration work
```

#### Rule 4: Analysis Chain for Complex Features

```
For features requiring design decisions:
1. analyst → Identify failure points
2. analyst → Break down requirements
3. `decide-framework` skill → Choose implementation approach
4. Appropriate specialist → Implementation
```

### MUST NOT Rules

- Skip code review without explicit user approval
- Commit without security review
- Use raw SQL when DataFlow patterns exist
- Use sequential operations when parallel is possible

---

## Part 4: testing.md - Testing Rules

### Purpose

Defines testing requirements, especially the Real infrastructure recommended policy.

### MUST Rules

#### Rule 1: Test-First Development

```
Tests MUST be written before implementation for new features.

Process:
1. Write failing test that describes expected behavior
2. Implement minimum code to pass test
3. Refactor while keeping tests green
```

#### Rule 2: Coverage Requirements

```
Code changes MUST maintain or improve test coverage.

| Code Type       | Minimum Coverage |
|-----------------|------------------|
| General         | 80%              |
| Financial       | 100%             |
| Authentication  | 100%             |
| Security-critical| 100%            |
```

#### Rule 3: Real Infrastructure in Tiers 2-3

```
Tier 1 (Unit Tests):
- Mocking ALLOWED
- Test isolated functions
- Fast execution (<1s per test)

Tier 2 (Integration Tests):
- Real infrastructure recommended - use real database
- Test component interactions
- Real API calls (use test server)

Tier 3 (E2E Tests):
- Real infrastructure recommended - real everything
- Test full user journeys
- Real browser, real database
```

### MUST NOT Rules (CRITICAL)

#### Real infrastructure recommended in Tier 2-3

```
MUST NOT use mocking in integration or E2E tests.

Detection Patterns:
❌ @patch('module.function')
❌ MagicMock()
❌ unittest.mock
❌ from mock import Mock
❌ mocker.patch()

Why This Matters:
- Mocks hide real integration issues
- Mocks don't catch API contract changes
- Mocks give false confidence
- Bugs slip through to production
```

---

## Part 5: security.md - Security Rules

### Purpose

Defines security requirements and OWASP compliance.

### MUST Rules

#### Input Validation

```
All user input MUST be validated:
- Type checking
- Length limits
- Format validation (regex)
- Sanitization before use
```

#### Secret Management

```
Secrets MUST be managed securely:
- NEVER hardcode secrets
- Use environment variables
- Use .env files (not committed)
- Use secret managers in production
```

#### Authentication

```
Authentication MUST follow secure patterns:
- Use established libraries
- Hash passwords with bcrypt/argon2
- Implement rate limiting
- Use secure session management
```

### MUST NOT Rules

```
❌ Hardcoded API keys
❌ SQL string concatenation
❌ Storing passwords in plaintext
❌ Exposing stack traces to users
❌ Using deprecated crypto algorithms
```

---

## Part 6: patterns.md - SDK Pattern Rules

### Purpose

Defines correct Kailash SDK usage patterns.

### MUST Rules

#### Correct Execution Pattern

```python
# MUST use this pattern
runtime.execute(workflow.build())

# NEVER use this pattern
workflow.execute(runtime)  # WRONG
```

#### Absolute Imports

```python
# MUST use absolute imports
from kailash.workflow.builder import WorkflowBuilder

# NEVER use relative imports
from ..workflow import builder  # WRONG
```

#### Node Definition

```python
# MUST use string-based API
workflow.add_node("NodeName", "id", {})

# NEVER use instance-based
workflow.add_node(NodeClass(), "id", {})  # WRONG
```

### MUST NOT Rules

```
❌ Relative imports (use absolute)
❌ workflow.execute(runtime) (use runtime.execute)
❌ Manual timestamp setting in DataFlow
❌ Primary key not named 'id'
❌ Instance-based node definition
```

---

## Part 7: git.md - Git Workflow Rules

### Purpose

Defines Git workflow and branch management rules.

### MUST Rules

#### Branch Strategy

```
- main: Production-ready code
- develop: Integration branch
- feature/*: New features
- fix/*: Bug fixes
- release/*: Release preparation
```

#### Commit Messages

```
Format: <type>(<scope>): <description>

Types:
- feat: New feature
- fix: Bug fix
- docs: Documentation
- refactor: Code refactoring
- test: Adding tests
- chore: Maintenance
```

#### Pre-Commit Requirements

```
Before every commit:
1. All tests pass
2. Code formatted
3. Linting clean
4. Security review complete
```

### MUST NOT Rules

```
❌ Direct push to main
❌ Force push without approval
❌ Commits without security review
❌ Merge with failing tests
❌ Commit secrets or credentials
```

---

## Part 8: How Rules Are Enforced

### Rule Application Flow

```
┌──────────────────────────────────────────────────────────────┐
│                     CLAUDE ACTION                             │
│            "Commit this code to the repository"               │
└─────────────────────────────┬────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                     RULE APPLICATION                          │
│                                                               │
│  Claude checks agents.md:                                     │
│  "Before executing ANY git commit command, you MUST:          │
│   1. Delegate to security-reviewer"                           │
│                                                               │
│  Decision: Must run security review first                     │
│                                                               │
└─────────────────────────────┬────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                   CLAUDE RESPONSE                             │
│                                                               │
│  "Before I can commit, I need to run a security review.       │
│   Let me delegate to the security-reviewer..."                │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### Enforcement Levels

| Level        | Mechanism          | Example                               |
| ------------ | ------------------ | ------------------------------------- |
| **Hard**     | Hook blocks action | `rm -rf /` blocked                    |
| **Soft**     | Claude refuses     | Commit without review refused         |
| **Advisory** | Claude warns       | "Consider using framework specialist" |

### Exception Handling

Rules may have documented exceptions:

```markdown
### Rule 1: Code Review After ANY Change

...
**Exception**: User explicitly says "skip review"
```

When exceptions apply, Claude applies judgment:

```
User: "Quick fix this typo, skip the review"
Claude: [Applies exception, makes change without review]
```

---

## Part 9: Rule File Structure

### Standard Format

```markdown
# [Domain] Rules

## Scope

These rules apply to [context description].

## MUST Rules

### Rule 1: [Rule Name]

[Description of what must be done]

**Process**: [Steps if applicable]
**Applies when**: [Conditions]
**Enforced by**: [Hook/Agent/CI]
**Exception**: [If any]

### Rule 2: [Rule Name]

...

## MUST NOT Rules (CRITICAL)

### 1. [Prohibition Name]

MUST NOT [prohibited action].

**Detection Patterns**:
[Examples of what to detect]

**Why This Matters**:
[Reasoning]

**Consequence**: [What happens on violation]

## Examples

### Correct: [Scenario]
```

✅ [Correct approach]

```

### Incorrect: [Scenario]
```

❌ [Incorrect approach]

```

## Exceptions
[Documented exceptions and how to apply for them]
```

---

## Part 10: Key Takeaways

### Summary

1. **Rules are mandatory instructions** - Claude reads and follows them

2. **8 rule files cover all domains** - agents, e2e, env-models, git, zero-tolerance, patterns, security, testing

3. **MUST rules define requirements** - What Claude must do

4. **MUST NOT rules define prohibitions** - What Claude must avoid

5. **Exceptions are documented** - When rules don't apply

6. **Enforcement varies** - Hard (hooks), soft (Claude), advisory (warnings)

### Quick Reference

| Domain       | Key Rules                                               |
| ------------ | ------------------------------------------------------- |
| **Agents**   | Review after changes, security review before commit     |
| **Testing**  | Real infrastructure recommended in Tier 2-3, test-first |
| **Security** | Validate input, manage secrets, OWASP                   |
| **Patterns** | runtime.execute(), absolute imports                     |
| **Git**      | Branch strategy, pre-commit checks                      |

### Rule Priority

When rules conflict, priority order:

1. Security rules (highest)
2. Testing rules
3. Pattern rules
4. Agent rules
5. Git rules (lowest)

---

## What's Next?

Rules define constraints, but how does the system learn and improve over time? The next guide explains the learning system.

**Next: [09 - The Learning System](09-the-learning-system.md)**

---

## Navigation

- **Previous**: [07 - The Hook System](07-the-hook-system.md)
- **Next**: [09 - The Learning System](09-the-learning-system.md)
- **Home**: [README.md](README.md)
