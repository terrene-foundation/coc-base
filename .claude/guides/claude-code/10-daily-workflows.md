# Guide 10: Daily Workflows

## Introduction

This guide shows **practical workflows** for common development tasks. Each workflow demonstrates how the setup's components work together to help you build software efficiently.

By the end of this guide, you will know how to:

- Start a new feature from scratch
- Debug and fix bugs
- Write and run tests
- Prepare code for commit
- Review and deploy code

---

## Part 1: Starting a New Feature

### The Complete Flow

```
1. DESCRIBE → 2. ANALYZE → 3. PLAN → 4. IMPLEMENT → 5. TEST → 6. REVIEW → 7. COMMIT
```

### Step 1: Describe What You Want

Start with a clear description:

```
> I need to add user registration functionality. Users should be able to:
> - Register with email and password
> - Receive email verification
> - Log in after verification
> Use DataFlow for the database and Nexus for the API.
```

### Step 2: Analysis Phase

Claude automatically engages `analyst`:

```
Claude: I'll analyze this feature first.

[Delegating to analyst...]

Analysis Summary:
- Complexity: Moderate (15/30)
- Key Risks: Email delivery, password security
- Recommended: DataFlow for User model, Nexus for API
- Dependencies: Email service configuration

Shall I proceed with planning?
```

### Step 3: Planning Phase

Claude creates a structured plan:

```
> Yes, create a plan

[Creating todo list...]

Tasks:
1. Create User DataFlow model
2. Implement password hashing
3. Create registration workflow
4. Add email verification
5. Create login workflow
6. Deploy as Nexus API
7. Write integration tests
8. Security review

Starting with task 1...
```

### Step 4: Implementation Phase

For each task, Claude:

````
[Task 1: Create User DataFlow model]

> /db

Creating model with dataflow-specialist...

```python
from dataflow import DataFlow

db = DataFlow()

@db.model
class User:
    id: int
    email: str
    password_hash: str
    verified: bool = False
    verification_token: str | None = None
````

[validate-workflow hook: Verified - primary key is 'id']
[auto-format hook: Formatted]

Task 1 complete. Moving to task 2...

```

### Step 5: Testing Phase

```

[Task 7: Write integration tests]

> /test

Writing tests with testing-specialist...

```python
# tests/integration/test_user_registration.py
import pytest
from dataflow import DataFlow

@pytest.fixture
def db():
    # Real database - Real infrastructure recommended
    dataflow = DataFlow("sqlite:///:memory:")
    dataflow.create_tables()
    yield dataflow
    dataflow.drop_tables()

def test_user_registration(db):
    # Test with real database
    result = db.User.create(
        email="test@example.com",
        password_hash="hashed_password"
    )
    assert result.id is not None
    assert result.verified == False
```

[validate-workflow hook: Verified - no mocking detected]

```

### Step 6: Review Phase

```

[Delegating to reviewer...]

Code Review Summary:
✅ DataFlow patterns correct
✅ Security patterns followed
⚠️ Consider rate limiting on registration endpoint
✅ Tests use real infrastructure

Recommendation: Address rate limiting, then proceed.

```

### Step 7: Commit Phase

```

> Commit this

[Delegating to security-reviewer...]

Security Review:
✅ No hardcoded secrets
✅ Password properly hashed
✅ Input validation present
⚠️ Rate limiting recommended (non-blocking)

Ready to commit.

[Creating commit...]
git commit -m "feat(auth): Add user registration with email verification

- Add User DataFlow model
- Implement registration and login workflows
- Add email verification flow
- Include integration tests

Co-Authored-By: Claude <noreply@anthropic.com>"

```

---

## Part 2: Debugging a Bug

### The Debug Flow

```

1. REPRODUCE → 2. INVESTIGATE → 3. FIX → 4. TEST → 5. VERIFY

```

### Step 1: Reproduce the Issue

```

> Users are getting "NoneType has no attribute 'email'" when registering

Claude: Let me reproduce this issue. First, I'll check the registration code.

[Reading src/workflows/registration.py...]

Found potential issue at line 45. Let me trace it...

```

### Step 2: Investigate with Agents

```

Found in common-mistakes.md:
"NoneType errors in workflows often occur when node outputs
aren't properly connected"

[Delegating to pattern-expert for connection validation...]

Issue identified:

- Line 42: user = create_result.get("user")
- Problem: DataFlow CREATE returns {"result": user}, not {"user": user}

```

### Step 3: Apply the Fix

```

[Applying fix...]

```python
# Before (incorrect)
user = create_result.get("user")

# After (correct)
user = create_result.get("result")
```

[validate-workflow hook: Verified]
[auto-format hook: Formatted]

```

### Step 4: Write Regression Test

```

[Writing regression test...]

```python
def test_registration_returns_user_object(db):
    """Regression test for NoneType bug"""
    result = register_user(db, "test@test.com", "password")

    # This was failing before the fix
    assert result is not None
    assert result.email == "test@test.com"
```

```

### Step 5: Verify

```

[Running tests...]

tests/integration/test_registration.py::test_registration_returns_user_object PASSED

Bug fixed and regression test added.

```

---

## Part 3: Writing Tests

### Test-First Workflow

```

> I want to add a feature for password reset. Let's do TDD.

[Delegating to tdd-implementer...]

TDD Phase 1 (Red): Writing failing tests first...

```python
def test_password_reset_request_creates_token(db):
    """User can request password reset"""
    user = create_test_user(db)

    result = request_password_reset(db, user.email)

    assert result.reset_token is not None
    assert result.reset_token_expires > datetime.now()

def test_password_reset_with_valid_token(db):
    """User can reset password with valid token"""
    user = create_test_user(db)
    token = create_reset_token(db, user)

    result = reset_password(db, token, "new_password")

    assert result.success == True
    assert verify_password(user, "new_password")
```

Running tests...
FAILED: request_password_reset not defined
FAILED: reset_password not defined

TDD Phase 2 (Green): Implementing minimum code to pass...

```

### Test Categories

```

> /test

Test organization:

tests/
├── unit/ # Tier 1 - Mocking allowed
│ └── test_utils.py
├── integration/ # Tier 2 - Real infrastructure recommended
│ └── test_user.py
└── e2e/ # Tier 3 - Full system
└── test_registration_flow.py

Which type of test do you want to write?

```

---

## Part 4: Code Review Workflow

### Self-Review Before Commit

```

> Review my changes before I commit

[Delegating to reviewer...]

Reviewing 5 changed files...

src/models/user.py:
✅ DataFlow patterns correct
✅ Field types appropriate

src/workflows/auth.py:
✅ Error handling present
⚠️ Line 67: Consider adding rate limiting

tests/integration/test_auth.py:
✅ No mocking detected
✅ Real database used
⚠️ Missing test for invalid token case

Summary:

- 2 files perfect
- 3 files have minor suggestions
- No blocking issues

Suggestions:

1. Add rate limiting to auth workflow
2. Add test for invalid token scenario

```

### Security Review

```

> Run security review

[Delegating to security-reviewer...]

Security Audit Results:

PASSED:
✅ No hardcoded credentials
✅ Passwords hashed with bcrypt
✅ Input validation on email field
✅ SQL injection prevention (DataFlow)
✅ XSS prevention in responses

WARNINGS:
⚠️ Consider adding CSRF protection
⚠️ Rate limiting not implemented

CRITICAL: 0
HIGH: 0
MEDIUM: 2

Ready to commit with noted warnings.

```

---

## Part 5: Deployment Workflow

### Local Development

```

> Set up local development environment

[Delegating to release-specialist...]

Creating Docker Compose configuration...

```yaml
# docker-compose.yml
version: "3.8"

services:
  app:
    build: .
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/app
    depends_on:
      - db

  db:
    image: postgres:15
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
      - POSTGRES_DB=app
```

To start:

```bash
docker compose up
```

```

### Production Deployment

```

> Prepare for production deployment

[Delegating to release-specialist...]

Production checklist:

1. ✅ Environment variables configured
2. ⚠️ Need production DATABASE_URL
3. ⚠️ Need email service credentials
4. ✅ Kubernetes manifests ready

Creating production configs...

```

---

## Part 6: Quick Task Workflows

### Quick Fix

```

> Fix the typo in UserModel, it should be "verified" not "verifed"

[Fixing typo...]
[auto-format hook: No changes needed]

Fixed. Commit this change?

```

### Quick Question

```

> How do I add a unique constraint to the email field in DataFlow?

> /db

In DataFlow, use the unique parameter:

```python
@db.model
class User:
    id: int
    email: str = Field(unique=True)  # Unique constraint
```

```

### Quick Pattern Lookup

```

> Show me the correct workflow execution pattern

> /sdk

Correct pattern:

```python
runtime = LocalRuntime()
results, run_id = runtime.execute(workflow.build())
```

Never use:

```python
workflow.execute(runtime)  # WRONG
```

```

---

## Part 7: Common Daily Patterns

### Morning Startup

```

> claude

# Claude Code starts

[session-start hook: Session initialized]
[Detecting frameworks: DataFlow, Nexus active]
[WORKSPACE] my-saas-app | Phase: 03-implement | Todos: 3 active / 5 done
[WORKSPACE] Session notes: 14 hours ago

Ready. What would you like to work on?

> /ws

# Shows full workspace status dashboard — phase, todo progress, recent files

```

### End of Day

```

> /wrapup

[Writing session notes to workspaces/my-saas-app/.session-notes...]
Saved: accomplishments, blockers, next steps.

> /exit

[session-end hook: State persisted]
Session ended.

```

---

## Part 8: Workflow Quick Reference

### Feature Development

| Step | Command/Action |
|------|----------------|
| Start | Describe feature |
| Load context | `/sdk`, `/db`, `/api` as needed |
| Plan | Claude creates todo list |
| Implement | Work through todos |
| Test | `/test` + write tests |
| Review | Claude delegates to reviewers |
| Commit | Claude runs security review |

### Bug Fix

| Step | Command/Action |
|------|----------------|
| Describe | Explain the bug |
| Investigate | Claude uses agents |
| Fix | Apply correction |
| Test | Write regression test |
| Commit | With fix description |

### Code Review

| Step | Command/Action |
|------|----------------|
| Request | "Review my changes" |
| Receive | reviewer findings |
| Address | Fix issues |
| Security | security-reviewer before commit |
| Commit | After all reviews pass |

### Workspace Project (Full Lifecycle)

| Step | Command | Output |
|------|---------|--------|
| Start project | `/analyze my-saas-app` | `01-analysis/`, `02-plans/`, `03-user-flows/` |
| Break into tasks | `/todos` | `todos/active/` (stops for human approval) |
| Build | `/implement` (repeat) | `src/`, `apps/`, move todos to `completed/` |
| Validate | `/redteam` | `04-validate/` (feeds gaps back to `/implement`) |
| Capture knowledge | `/codify` | Updates existing agents and skills in `.claude/` |
| Check status | `/ws` | Dashboard with phase, todos, recent activity |
| End session | `/wrapup` | `.session-notes` in workspace root |

---

## Part 9: Key Takeaways

### Summary

1. **Features follow a flow** - Describe → Analyze → Plan → Implement → Test → Review → Commit

2. **Bugs follow a flow** - Reproduce → Investigate → Fix → Test → Verify

3. **Tests are real** - Real infrastructure recommended in integration and E2E

4. **Reviews are automatic** - Claude delegates to reviewers

5. **Security is mandatory** - Always before commit

6. **Learning is continuous** - Observations are captured and codified into skills

### Daily Habits

```

Morning:

- Start Claude Code in project directory
- Session hook auto-detects workspace and shows status
- Run /ws for full dashboard if resuming a project

During Work:

- Describe tasks clearly
- Use commands for context (/sdk, /db, /api, /ai)
- Use /implement to work through workspace todos
- Let Claude handle delegation

End of Day:

- Run /wrapup to save session notes (accomplishments, blockers, next steps)
- Exit cleanly

```

---

## What's Next?

For power users wanting more control, the next guide covers advanced usage.

**Next: [11 - Advanced Usage](11-advanced-usage.md)**

---

## Navigation

- **Previous**: [09 - The Learning System](09-the-learning-system.md)
- **Next**: [11 - Advanced Usage](11-advanced-usage.md)
- **Home**: [README.md](README.md)
```
