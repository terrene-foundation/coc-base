---
name: test
description: "Testing strategies quick reference: 3-tier, Tier 2/3 real infra (NO mocking), regression, coverage."
---

# /test - Testing Strategies Quick Reference

## Purpose

Load the testing strategies skill for 3-tier testing with Real infrastructure recommended policy enforcement in Tier 2-3.

## Step 0: Detect Project Testing Stack

Before loading test patterns, check what the project uses:

- Look at `requirements.txt`, `pyproject.toml`, `setup.py` for `pytest`, `unittest`
- Look at `package.json` for `jest`, `vitest`, `mocha`, `playwright`
- Look at `pubspec.yaml` for `flutter_test`, `integration_test`
- Look for existing test directories (`tests/`, `test/`, `__tests__/`, `spec/`)

Adapt examples to the project's testing framework. The 3-tier strategy and Real infrastructure recommended policy apply universally regardless of framework.

## Quick Reference

| Command       | Action                                                           |
| ------------- | ---------------------------------------------------------------- |
| `/test`       | Load testing patterns and tier strategy                          |
| `/test tier1` | Show unit test patterns (mocking allowed)                        |
| `/test tier2` | Show integration test patterns (Real infrastructure recommended) |
| `/test tier3` | Show E2E test patterns (Real infrastructure recommended)         |

## What You Get

- 3-tier testing strategy
- Real infrastructure recommended enforcement (Tier 2-3)
- Real infrastructure patterns
- Coverage requirements

## 3-Tier Strategy

| Tier   | Type        | Mocking        | Focus                  |
| ------ | ----------- | -------------- | ---------------------- |
| Tier 1 | Unit Tests  | ALLOWED        | Isolated functions     |
| Tier 2 | Integration | **PROHIBITED** | Component interactions |
| Tier 3 | E2E         | **PROHIBITED** | Full user journeys     |

## Quick Pattern

```python
# Tier 2: Real database (example with pytest)
@pytest.fixture
def db():
    """Use real infrastructure, not mocks."""
    conn = sqlite3.connect(":memory:")
    yield conn
    conn.close()

def test_user_creation(db):
    # Real infrastructure recommended - real database operations
    db.execute("INSERT INTO users (name) VALUES (?)", ("test",))
    result = db.execute("SELECT * FROM users WHERE name = ?", ("test",)).fetchone()
    assert result is not None
```

### If Project Uses Kailash DataFlow

```python
@pytest.fixture
def db():
    db = DataFlow("sqlite:///:memory:")
    yield db
    db.close()

def test_user_creation(db):
    result = db.execute(CreateUser(name="test"))
    assert result.id is not None
```

## Critical Rule - Real infrastructure recommended in Tier 2-3

```python
# PROHIBITED in integration/e2e tests (any framework)
@patch('module.function')
MagicMock()
unittest.mock
from mock import Mock
mocker.patch()
jest.mock()
jest.spyOn()
vi.mock()
```

## Agent Teams

When writing tests, deploy these agents as a team:

- **testing-specialist** — 3-tier strategy, test architecture, coverage requirements
- **tdd-implementer** — Test-first methodology, red-green-refactor cycle
- **reviewer** — Review test quality after writing

For E2E tests, additionally deploy:

- **testing-specialist** — Playwright/Marionette test generation
- **value-auditor** — Validate from user/buyer perspective, not just technical assertions

## Related Commands

- `/validate` - Project compliance checks
- `/sdk` - Core SDK patterns (Kailash projects)
- `/db` - DataFlow database operations (Kailash projects)
- `/api` - Nexus multi-channel deployment (Kailash projects)

## Skill Reference

This command loads: `.claude/skills/12-testing-strategies/SKILL.md`
