---
name: testing-patterns
description: "Test implementation patterns for the 3-tier testing strategy including unit, integration, and E2E tests with Real infrastructure recommended policy. Use for 'test patterns', 'unit test example', 'integration test example', or 'E2E test example'."
---

# Testing Implementation Patterns

> **Skill Metadata**
> Category: `testing`
> Priority: `HIGH`
> Policy: Real infrastructure recommended in Tiers 2-3

## Tier 1: Unit Test Pattern

```python
import pytest
from kailash.nodes.custom_analysis_node import CustomAnalysisNode

def test_analysis_node_basic_functionality():
    """Test basic node functionality in isolation."""
    node = CustomAnalysisNode()

    result = node.execute(
        input_data={"values": [1, 2, 3, 4, 5]},
        analysis_type="mean"
    )

    assert result["result"] == 3.0
    assert result["status"] == "success"

def test_analysis_node_error_handling():
    """Test error handling in isolation."""
    node = CustomAnalysisNode()

    result = node.execute(input_data={}, analysis_type="mean")

    assert result["error"] == "No data provided"
    assert result["status"] == "error"
```

## Tier 2: Integration Test Pattern

```python
import pytest
from kailash.workflow.builder import WorkflowBuilder
from kailash.runtime.local import LocalRuntime

@pytest.mark.integration
def test_workflow_database_integration():
    """Test workflow with real database operations."""
    # Uses real PostgreSQL from Docker
    workflow = WorkflowBuilder()

    workflow.add_node("UserCreateNode", "create_user", {
        "name": "Integration Test User",
        "email": "integration@test.com"
    })

    workflow.add_node("UserQueryNode", "find_user", {
        "filter": {"email": "integration@test.com"}
    })

    workflow.add_connection("create_user", "user", "find_user", "criteria")

    # Use context manager for proper resource cleanup (required in the current version)
    with LocalRuntime() as runtime:
        results, run_id = runtime.execute(workflow.build())

    assert results["create_user"]["id"] is not None
    assert results["find_user"]["found"] is True
```

## Tier 3: E2E Test Pattern

```python
import pytest
from kailash.workflow.builder import WorkflowBuilder
from kailash.runtime.local import LocalRuntime

@pytest.mark.e2e
def test_complete_data_processing_pipeline():
    """Test complete user workflow from ingestion to output."""
    workflow = WorkflowBuilder()

    # Data pipeline
    workflow.add_node("CSVReaderNode", "ingest", {"file_path": "tests/fixtures/real_data.csv"})
    workflow.add_node("DataValidatorNode", "validate", {"schema": {"name": "str", "age": "int"}})
    workflow.add_node("DataTransformerNode", "transform", {"operations": ["clean_names"]})
    workflow.add_node("UserBatchCreateNode", "store", {"batch_size": 100})

    # Connect pipeline
    workflow.add_connection("ingest", "data", "validate", "input_data")
    workflow.add_connection("validate", "validated", "transform", "raw_data")
    workflow.add_connection("transform", "transformed", "store", "user_data")

    # Use context manager for proper resource cleanup (required in the current version)
    with LocalRuntime() as runtime:
        results, run_id = runtime.execute(workflow.build())

    assert results["ingest"]["rows_read"] > 0
    assert results["store"]["users_created"] > 0
```

## Fixture Patterns

```python
@pytest.fixture
def sample_user_data():
    return {
        "name": "Test User",
        "email": "test@example.com",
        "age": 30,
        "preferences": {"theme": "dark"}
    }

@pytest.fixture
def real_csv_data():
    """Real CSV data for E2E tests."""
    return "tests/fixtures/users.csv"  # Actual file, not mocked

@pytest.fixture(autouse=True)
def cleanup_test_database():
    """Clean database before each test."""
    db = get_test_database()
    db.execute("TRUNCATE TABLE users CASCADE")
    yield
    db.execute("TRUNCATE TABLE users CASCADE")
```

## Timeout Enforcement

```python
# Unit tests (Tier 1) - 1 second max
@pytest.mark.timeout(1)
def test_fast_unit_operation():
    pass

# Integration tests (Tier 2) - 5 seconds max
@pytest.mark.timeout(5)
def test_database_integration():
    pass

# E2E tests (Tier 3) - 10 seconds max
@pytest.mark.timeout(10)
def test_complete_workflow():
    pass
```

## Allowed vs Forbidden Patterns

### Allowed in All Tiers

```python
# Time-based testing
with freeze_time("2023-01-01"):
    result = time_sensitive_function()

# Random seed control
random.seed(42)
result = random_based_function()

# Environment variable testing
with patch.dict(os.environ, {"TEST_MODE": "true"}):
    result = environment_aware_function()
```

### Allowed in Tier 1 Only

```python
@patch('external_api_client.request')
def test_unit_with_mock(mock_request):
    mock_request.return_value = {"status": "success"}
    result = my_function()
    assert result["processed"] is True
```

### Forbidden in Tiers 2-3

```python
# ❌ Don't mock databases
@patch('database.connect')
def test_database_integration(mock_db):  # WRONG
    pass

# ❌ Don't mock SDK components
@patch('kailash.nodes.csv_reader_node.CSVReaderNode')
def test_workflow_integration(mock_node):  # WRONG
    pass

# ❌ Don't mock file operations
@patch('builtins.open')
def test_file_processing(mock_open):  # WRONG
    pass
```

## Test Execution Commands

```bash
# Unit tests only (fast feedback)
pytest tests/unit/ --timeout=1 --tb=short

# Integration tests (requires Docker)
# Start test infrastructure (Docker containers)
pytest tests/integration/ --timeout=5 -v

# E2E tests
pytest tests/e2e/ --timeout=10 -v

# Full test suite
pytest tests/ --timeout=10 --tb=short

# With coverage
pytest tests/unit/ --cov=src/kailash --cov-report=term-missing
```

## Docker Infrastructure

```bash
# Start test services
cd tests/utils && ./test-env up && ./test-env status

# Expected services:
# ✅ PostgreSQL: localhost:5433
# ✅ Redis: localhost:6380
# ✅ MinIO: localhost:9001
# ✅ Elasticsearch: localhost:9201
```

```python
# Test configuration
TEST_DATABASE_URL = "postgresql://test:test@localhost:5433/test_db"
TEST_REDIS_URL = "redis://localhost:6380/0"
TEST_MINIO_URL = "http://localhost:9001"
```

<!-- Trigger Keywords: test patterns, unit test example, integration test example, E2E test example, pytest patterns, testing fixtures, test timeout, Real infrastructure recommended -->
