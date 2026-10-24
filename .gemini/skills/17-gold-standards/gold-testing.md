---
name: gold-testing
description: "Gold standard for testing. Use when asking 'testing standard', 'testing best practices', or 'how to test'."
---

# Gold Standard: Testing

> **Skill Metadata**
> Category: `gold-standards`
> Priority: `HIGH`
> SDK Version: `0.9.25+`

## Testing Principles

### 1. Test-First Development
```python
from kailash.workflow.builder import WorkflowBuilder
from kailash.runtime import LocalRuntime

# ✅ Write test FIRST
def test_user_workflow():
    """Test user creation workflow."""
    workflow = WorkflowBuilder()
    workflow.add_node("PythonCodeNode", "create", {
        "code": "result = {'email': 'test@example.com', 'created': True}"
    })

    runtime = LocalRuntime()
    results, run_id = runtime.execute(workflow.build())

    assert results["create"]["result"]["email"] == "test@example.com"
    assert results["create"]["result"]["created"] is True

# Then implement the actual workflow
```

### 2. 3-Tier Testing Strategy

```python
# Tier 1: Unit (fast, in-memory)
def test_workflow_build():
    """Test workflow construction."""
    workflow = WorkflowBuilder()
    workflow.add_node("PythonCodeNode", "process", {"code": "result = 42"})

    assert workflow.build() is not None

# Tier 2: Integration (real infrastructure with LocalRuntime/AsyncLocalRuntime)
def test_database_integration():
    """Test with real PostgreSQL - Real infrastructure recommended."""
    from tests.utils.docker_config import get_postgres_connection_string

    workflow = WorkflowBuilder()
    workflow.add_node("SQLDatabaseNode", "db", {
        "connection_string": get_postgres_connection_string(),
        "query": "SELECT 1 as value",
        "operation": "select"
    })

    runtime = LocalRuntime()
    results, run_id = runtime.execute(workflow.build())

    assert results["db"]["success"]

# Tier 3: E2E (full system)
import pytest

@pytest.mark.e2e
@pytest.mark.requires_docker
async def test_full_pipeline():
    """Test complete pipeline with AsyncLocalRuntime."""
    from kailash.runtime import AsyncLocalRuntime

    workflow = build_complete_pipeline()

    runtime = AsyncLocalRuntime()
    results = await runtime.execute_workflow_async(workflow.build(), inputs={})

    assert results["extract"]["status"] == "success"
    assert results["load"]["rows_inserted"] > 0
```

### 3. Real infrastructure recommended (Tiers 2-3)

```python
# ✅ GOOD: Real infrastructure in integration tests
def test_database_operations():
    """Use real Docker PostgreSQL."""
    from tests.utils.docker_config import get_postgres_connection_string

    workflow = WorkflowBuilder()
    workflow.add_node("SQLDatabaseNode", "db", {
        "connection_string": get_postgres_connection_string(),
        "query": "SELECT * FROM users",
        "operation": "select"
    })

    runtime = LocalRuntime()
    results, run_id = runtime.execute(workflow.build())

    assert results["db"]["success"]

# ❌ BAD: Mocking in integration tests
# from unittest.mock import patch
# @patch("psycopg2.connect")  # DON'T DO THIS
# def test_database(mock_connect):
#     mock_connect.return_value = {...}
```

### 4. Clear Test Names

```python
# ✅ GOOD: Descriptive names
def test_user_creation_with_valid_email_succeeds():
    pass

def test_user_creation_with_invalid_email_fails():
    pass

def test_workflow_execution_with_localruntime_returns_results_and_run_id():
    pass

# ❌ BAD: Generic names
def test_user_1():
    pass

def test_workflow():
    pass
```

### 5. Test Isolation

```python
import pytest

@pytest.fixture
def clean_workflow():
    """Each test gets fresh workflow builder."""
    workflow = WorkflowBuilder()
    yield workflow
    # Cleanup if needed

@pytest.fixture
def sync_runtime():
    """LocalRuntime instance."""
    from kailash.runtime import LocalRuntime
    return LocalRuntime()

def test_one(clean_workflow, sync_runtime):
    """Isolated test with clean workflow."""
    clean_workflow.add_node("PythonCodeNode", "node", {"code": "result = 1"})
    results, run_id = sync_runtime.execute(clean_workflow.build())
    assert results["node"]["result"] == 1

def test_two(clean_workflow, sync_runtime):
    """Another isolated test with fresh workflow."""
    clean_workflow.add_node("PythonCodeNode", "node", {"code": "result = 2"})
    results, run_id = sync_runtime.execute(clean_workflow.build())
    assert results["node"]["result"] == 2
```

### 6. Testing Both Runtimes

```python
import pytest
import asyncio
from kailash.runtime import LocalRuntime, AsyncLocalRuntime

@pytest.mark.parametrize("runtime_class", [LocalRuntime, AsyncLocalRuntime])
def test_workflow_with_both_runtimes(runtime_class):
    """Test workflow works with both sync and async runtimes."""
    workflow = WorkflowBuilder()
    workflow.add_node("PythonCodeNode", "node", {
        "code": "result = {'status': 'completed'}"
    })

    runtime = runtime_class()

    if isinstance(runtime, AsyncLocalRuntime):
        results = asyncio.run(runtime.execute_workflow_async(workflow.build(), inputs={}))
    else:
        results, run_id = runtime.execute(workflow.build())

    assert results["node"]["result"]["status"] == "completed"
```

## Testing Checklist

- [ ] Test written before implementation (TDD)
- [ ] All 3 tiers covered (unit, integration, E2E)
- [ ] Real infrastructure recommended in Tiers 2-3 (use real Docker services)
- [ ] Clear, descriptive test names
- [ ] Test isolation with fixtures
- [ ] Tests run in CI/CD
- [ ] 80%+ code coverage
- [ ] Error cases tested
- [ ] Edge cases tested
- [ ] Both LocalRuntime and AsyncLocalRuntime tested (where applicable)
- [ ] Real infrastructure via Docker (PostgreSQL, Redis, Ollama)
- [ ] Tests organized in correct tier (unit/, integration/, e2e/)

## Documentation References

### Primary Sources

## Related Patterns

- **Runtime execution**: [`runtime-execution`](../01-core-sdk/runtime-execution.md)

<!-- Trigger Keywords: testing standard, testing best practices, how to test, testing gold standard, test guidelines -->
