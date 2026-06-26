---
name: gold-test-creation
description: "Test creation standards with 3-tier strategy, fixtures, and real infrastructure requirements. Use when asking 'test standards', 'test creation', 'test guidelines', '3-tier testing', 'test requirements', or 'testing gold standard'."
---

# Gold Standard: Test Creation

Test creation guide with patterns, examples, and best practices for Kailash SDK.

> **Skill Metadata**
> Category: `gold-standards`
> Priority: `HIGH`
> SDK Version: `0.9.25+`

## Test Creation Pattern

### Basic Test Structure
```python
from kailash.workflow.builder import WorkflowBuilder
from kailash.runtime import LocalRuntime
import pytest

def test_workflow_execution():
    """Test workflow execution with LocalRuntime."""
    # Arrange: Build workflow
    workflow = WorkflowBuilder()
    workflow.add_node("PythonCodeNode", "process", {
        "code": "result = {'status': 'success', 'value': 42}"
    })

    # Act: Execute workflow
    runtime = LocalRuntime()
    results, run_id = runtime.execute(workflow.build())

    # Assert: Verify results
    assert results["process"]["result"]["status"] == "success"
    assert results["process"]["result"]["value"] == 42
    assert run_id is not None
```

### Async Test Pattern
```python
import pytest
from kailash.runtime import AsyncLocalRuntime

@pytest.mark.asyncio
async def test_async_workflow_execution():
    """Test workflow execution with AsyncLocalRuntime."""
    workflow = WorkflowBuilder()
    workflow.add_node("PythonCodeNode", "process", {
        "code": "result = {'status': 'completed'}"
    })

    runtime = AsyncLocalRuntime()
    results = await runtime.execute_workflow_async(workflow.build(), inputs={})

    assert results["process"]["result"]["status"] == "completed"
```

## 3-Tier Test Creation

### Tier 1: Unit Tests
```python
# tests/unit/test_workflow_builder.py
from kailash.workflow.builder import WorkflowBuilder

def test_workflow_builder_creates_workflow():
    """Test WorkflowBuilder creates valid workflow."""
    workflow = WorkflowBuilder()
    workflow.add_node("PythonCodeNode", "node", {"code": "result = 1"})

    built_workflow = workflow.build()
    assert built_workflow is not None
    assert "node" in built_workflow.graph

def test_workflow_builder_adds_connection():
    """Test WorkflowBuilder adds connections correctly."""
    workflow = WorkflowBuilder()
    workflow.add_node("PythonCodeNode", "source", {"code": "result = {'data': 42}"})
    workflow.add_node("PythonCodeNode", "target", {"code": "result = data"})
    workflow.add_connection("source", "result.data", "target", "data")

    built_workflow = workflow.build()
    assert built_workflow is not None
```

### Tier 2: Integration Tests (Real infrastructure recommended)
```python
# tests/integration/test_database_workflows.py
import pytest
from kailash.workflow.builder import WorkflowBuilder
from kailash.runtime import LocalRuntime
from tests.utils.docker_config import get_postgres_connection_string

@pytest.mark.requires_docker
def test_database_query_workflow():
    """Test database query with real PostgreSQL - Real infrastructure recommended."""
    conn_string = get_postgres_connection_string()

    workflow = WorkflowBuilder()
    workflow.add_node("SQLDatabaseNode", "db", {
        "connection_string": conn_string,
        "query": "SELECT 1 as id, 'test' as name",
        "operation": "select"
    })

    runtime = LocalRuntime()
    results, run_id = runtime.execute(workflow.build())

    assert results["db"]["success"]
    assert len(results["db"]["data"]) == 1
    assert results["db"]["data"][0]["name"] == "test"
```

### Tier 3: E2E Tests
```python
# tests/e2e/test_complete_pipeline.py
import pytest
from kailash.runtime import AsyncLocalRuntime

@pytest.mark.e2e
@pytest.mark.requires_docker
async def test_complete_etl_pipeline():
    """Test complete ETL pipeline end-to-end."""
    workflow = build_etl_pipeline()

    runtime = AsyncLocalRuntime()
    results = await runtime.execute_workflow_async(workflow.build(), inputs={})

    # Verify all stages completed
    assert results["extract"]["status"] == "success"
    assert results["transform"]["rows_processed"] > 0
    assert results["load"]["rows_inserted"] > 0
    assert results["validate"]["errors"] == []
```

## Test Fixtures

### Workflow Fixtures
```python
# tests/conftest.py
import pytest
from kailash.workflow.builder import WorkflowBuilder
from kailash.runtime import LocalRuntime, AsyncLocalRuntime

@pytest.fixture
def workflow_builder():
    """Fresh WorkflowBuilder for each test."""
    return WorkflowBuilder()

@pytest.fixture
def sync_runtime():
    """LocalRuntime instance."""
    return LocalRuntime()

@pytest.fixture
def async_runtime():
    """AsyncLocalRuntime instance."""
    return AsyncLocalRuntime()
```

### Infrastructure Fixtures
```python
# tests/conftest.py
from tests.utils.docker_config import (
    get_postgres_connection_string,
    get_redis_url
)

@pytest.fixture(scope="session")
def postgres_connection():
    """Session-scoped PostgreSQL connection."""
    return get_postgres_connection_string()

@pytest.fixture(scope="session")
def redis_connection():
    """Session-scoped Redis connection."""
    return get_redis_url()
```

## Parametrized Testing

### Testing Both Runtimes
```python
import pytest
import asyncio
from kailash.runtime import LocalRuntime, AsyncLocalRuntime

@pytest.mark.parametrize("runtime_class", [LocalRuntime, AsyncLocalRuntime])
def test_workflow_with_both_runtimes(runtime_class, workflow_builder):
    """Test workflow works with both sync and async runtimes."""
    workflow_builder.add_node("PythonCodeNode", "node", {
        "code": "result = {'value': 100}"
    })

    runtime = runtime_class()

    if isinstance(runtime, AsyncLocalRuntime):
        results = asyncio.run(runtime.execute_workflow_async(workflow_builder.build()))
    else:
        results, run_id = runtime.execute(workflow_builder.build())

    assert results["node"]["result"]["value"] == 100
```

### Testing Multiple Scenarios
```python
@pytest.mark.parametrize("input_value,expected", [
    (10, 20),
    (5, 10),
    (0, 0),
    (-5, -10)
])
def test_double_value_workflow(input_value, expected, workflow_builder, sync_runtime):
    """Test workflow doubles input value correctly."""
    workflow_builder.add_node("PythonCodeNode", "double", {
        "code": "result = {'value': input_val * 2}"
    })

    results, run_id = sync_runtime.execute(
        workflow_builder.build(),
        parameters={"double": {"input_val": input_value}}
    )

    assert results["double"]["result"]["value"] == expected
```

## Error Testing

### Testing Error Handling
```python
import pytest
from kailash.sdk_exceptions import WorkflowValidationError

def test_missing_required_parameter_raises_error(workflow_builder, sync_runtime):
    """Test that missing required parameters raise validation error."""
    workflow_builder.add_node("RequiredParamNode", "node", {})

    with pytest.raises(WorkflowValidationError, match="missing required inputs"):
        sync_runtime.execute(workflow_builder.build())
```

## Test Organization Standards

### File Naming
```
tests/
├── unit/
│   └── test_<component>.py        # test_ prefix required
├── integration/
│   └── test_<integration>.py      # test_ prefix required
└── e2e/
    └── test_<scenario>.py         # test_ prefix required
```

### Test Naming
```python
# ✅ GOOD: Descriptive test names
def test_workflow_execution_with_valid_parameters_returns_success():
    pass

def test_database_connection_with_invalid_credentials_raises_error():
    pass

# ❌ BAD: Generic test names
def test_workflow():
    pass

def test_db():
    pass
```

## Test Standards Checklist

- [ ] Test uses correct runtime (LocalRuntime for sync, AsyncLocalRuntime for async)
- [ ] Test organized in correct tier (unit/, integration/, e2e/)
- [ ] Real infrastructure recommended in integration/e2e tests (use real Docker services)
- [ ] Clear, descriptive test name
- [ ] Proper fixtures for test isolation
- [ ] Error cases tested
- [ ] Edge cases covered
- [ ] Parametrized for multiple scenarios (where applicable)
- [ ] Both runtimes tested (where applicable)
- [ ] Proper pytest markers (@pytest.mark.requires_docker, @pytest.mark.e2e)

## Documentation References

### Primary Sources

## Related Patterns

- **Gold testing standard**: [`gold-testing`](gold-testing.md)

## When to Escalate

Use `testing-specialist` subagent when:
- Complex test infrastructure needed
- Custom fixtures required
- CI/CD integration issues
- Performance testing strategy

<!-- Trigger Keywords: test standards, test creation, test guidelines, 3-tier testing, test requirements, testing gold standard -->
