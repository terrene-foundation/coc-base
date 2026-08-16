---
name: testing-strategies
description: "Kailash testing — 3-tier, Tier 2/3 real infra (NO mocking), regression, coverage."
---

# Kailash Testing Strategies

3-tier testing strategy for Kailash applications. Tier 2/3 require real infrastructure — NO mocking (`@patch`, `MagicMock`, `unittest.mock` are BLOCKED) per `rules/testing.md`.

## When to Use

Use when asking about testing, test strategy, 3-tier testing, unit tests, integration tests, end-to-end tests, testing workflows, testing DataFlow, testing Nexus, real infrastructure, NO mocking, test organization, or testing best practices.

## Sub-File Index

- **[test-3tier-strategy](test-3tier-strategy.md)** - Complete 3-tier guide: tier definitions, fixture patterns, CI/CD integration
- **[probe-driven-verification](probe-driven-verification.md)** - Probe-driven verification runbook (regex/keyword for semantic claims is BLOCKED). Per `rules/probe-driven-verification.md`.

## 3-Tier Strategy

| Tier            | Scope               | Mocking                       | Speed      | Infrastructure             |
| --------------- | ------------------- | ----------------------------- | ---------- | -------------------------- |
| 1 - Unit        | Functions, classes  | Allowed                       | <1s/test   | None                       |
| 2 - Integration | Workflows, DB, APIs | **BLOCKED — real infra only** | 1-10s/test | Real DB, real runtime      |
| 3 - E2E         | Complete user flows | **BLOCKED — real infra only** | 10s+/test  | Real HTTP, real everything |

### Real Infrastructure Policy (Tiers 2-3)

**Why**: Mocking hides database constraints, API timeouts, race conditions, connection pool exhaustion, schema migration issues, and LLM token limits.

**What to use instead**: Test databases (Docker containers), test API endpoints, test LLM accounts (with caching), temp directories.

### Key Fixtures

```python
@pytest.fixture
def db():
    """Real database for testing."""
    db = DataFlow("postgresql://test:test@localhost:5433/test_db")
    db.create_tables()
    yield db
    db.drop_tables()

@pytest.fixture
def runtime():
    return LocalRuntime()
```

## Test Organization

```
tests/
  tier1_unit/          # Mocking allowed
  tier2_integration/   # Real infrastructure
  tier3_e2e/           # Full system
  conftest.py          # Shared fixtures
```

## Component Testing Summary

| Component     | Tier | Key Point                                                  |
| ------------- | ---- | ---------------------------------------------------------- |
| Workflows     | 2    | Real runtime execution, verify `results["node"]["result"]` |
| DataFlow      | 2    | Real DB, verify with read-back after write                 |
| Nexus API     | 3    | Real HTTP requests to running server                       |
| Kaizen Agents | 2    | Real LLM calls with response caching                       |

## Regression Test Design

Regression tests lock in bug fixes. They MUST exercise the actual
code path -- call the function, assert the raise or return value.
**Source-grep tests are BLOCKED as the sole assertion** because they
pin the implementation, not the contract: when the fix moves to a
shared helper (the right refactor), the grep breaks even though the
protection is still in place.

```python
# Behavioral (survives refactors)
@pytest.mark.regression
def test_null_byte_rejected():
    parsed = urlparse("mysql://user:%00x@h/db")
    with pytest.raises(ValueError, match="null byte"):
        decode_userinfo_or_raise(parsed)

# Source-grep (BLOCKED as sole assertion)
def test_null_byte_exists_in_source():
    assert "\\x00" in open("src/kailash/db/connection.py").read()
```

See `rules/testing.md` "MUST: Behavioral Regression Tests Over
Source-Grep" for the full rule and rationale.

## Release-Blocking Regression Tier (Above Tier 3 E2E)

Unit and integration tests per primitive cannot observe the handoff between primitives; each primitive's tests construct test fixtures with exactly the fields it needs, and the chain between A → B fails only when A's real output is missing a field B actually needs. For every pipeline the docs teach (README Quick Start, tutorial, `specs/*.md` canonical example), add a regression test that executes the docs-exact code against real infrastructure AND asserts a deterministic fingerprint over the output. Flipped fingerprints block release. See `skills/16-validation-patterns/SKILL.md` § "End-to-End Pipeline Regression Above Unit/Integration" for the full pattern + kailash-ml 1.0.0 W33b evidence, and `rules/testing.md` § "End-to-End Pipeline Regression Tests Above Unit + Integration" for the MUST clause.

## Optional Dependency Testing

Tests that exercise optional extras (e.g., `[hpo]`, `[redis]`, `[vault]`)
MUST guard against the dependency being absent. Use `pytest.importorskip`
at module or class scope so the test is _skipped_ (not _failed_) in CI
environments that don't install the extra.

```python
# At module level — skips entire file if optuna is missing
optuna = pytest.importorskip("optuna", reason="optuna required for HPO tests")

class TestSuccessiveHalving:
    @pytest.mark.asyncio
    async def test_pruning(self):
        # optuna is guaranteed available here
        ...
```

**Why:** Base CI installs core dependencies only. A test that imports
an optional extra without a skip guard fails every CI matrix entry,
blocking unrelated PRs. `pytest.importorskip` is the standard
mechanism — it imports the module if available and calls `pytest.skip`
if not.

**Where to place the guard:** Before the first use of the optional
module — typically at module scope (before the test class) or inside
a fixture. Placing it inside a test function body is too late if the
class-level setup already depends on the import.

## Critical Rules

- Tier 1: Mock external dependencies
- Tier 2-3: Real infrastructure, no `@patch`/`MagicMock`/`unittest.mock`
- Docker for test databases
- Clean up resources after every test
- Cache LLM responses for cost control
- Run Tier 1 in CI always; Tier 2-3 optionally
- Never commit test credentials

## Running Tests

```bash
pytest tests/tier1_unit/        # Fast CI
pytest tests/tier2_integration/ # With real infra
pytest tests/tier3_e2e/         # Full system
pytest --cov=app --cov-report=html  # Coverage
```

## Related Skills

- **[17-gold-standards](../17-gold-standards/SKILL.md)** - Testing best practices
- **[02-dataflow](../02-dataflow/SKILL.md)** - DataFlow testing
- **[03-nexus](../03-nexus/SKILL.md)** - API testing

## Support

- `testing-specialist` - Testing strategies and patterns
- `tdd-implementer` - Test-driven development
- `dataflow-specialist` - DataFlow testing patterns
