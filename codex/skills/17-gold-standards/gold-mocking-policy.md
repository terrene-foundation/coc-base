---
name: gold-mocking-policy
description: "Testing policy requiring real infrastructure, no mocking for Tier 2-3 tests. Use when asking 'mocking policy', 'NO mocking in Tiers 2-3', 'real infrastructure', 'test policy', 'mock guidelines', or 'testing standards'."
---

# Gold Standard: NO mocking in Tiers 2-3 Policy

NO mocking in Tiers 2-3 policy for integration and E2E tests - use real infrastructure with LocalRuntime and AsyncLocalRuntime.

> **Skill Metadata**
> Category: `gold-standards`
> Priority: `CRITICAL`
> SDK Version: `0.9.25+`

## Core Policy

### NO mocking in Tiers 2-3 in Tiers 2-3

**Tier 1 (Unit Tests)**: Mocking ALLOWED for external dependencies
**Tier 2 (Integration Tests)**: NO mocking in Tiers 2-3 - Use real Docker services
**Tier 3 (E2E Tests)**: NO mocking in Tiers 2-3 - Use real infrastructure

## Why NO mocking in Tiers 2-3?

1. **Mocks hide real integration issues** - Type mismatches, connection errors, timing issues
2. **Real infrastructure catches actual bugs** - Validates actual behavior, not assumptions
3. **Production-like testing prevents surprises** - Discovers deployment issues early
4. **Runtime validation** - Tests LocalRuntime and AsyncLocalRuntime with real services
5. **Better confidence** - Tests prove the code works with real systems

## What to Use Instead

### Tier 1: Unit Tests (Mocking Allowed)

```python
from unittest.mock import patch
from kailash.workflow.builder import WorkflowBuilder
from kailash.runtime import LocalRuntime

# ✅ ALLOWED in unit tests
@patch('requests.get')
def test_node_logic(mock_get):
    """Unit test can mock external dependencies."""
    mock_get.return_value.status_code = 200
    # Test node logic without real API
```

### Tier 2: Integration Tests (NO mocking in Tiers 2-3)

```python
from kailash.workflow.builder import WorkflowBuilder
from kailash.runtime import LocalRuntime
from tests.utils.docker_config import get_postgres_connection_string
import pytest

# ✅ CORRECT: Use real Docker PostgreSQL
@pytest.mark.requires_docker
def test_database_integration():
    """Integration test with real PostgreSQL - NO mocking in Tiers 2-3."""
    conn_string = get_postgres_connection_string()

    workflow = WorkflowBuilder()
    workflow.add_node("SQLDatabaseNode", "db", {
        "connection_string": conn_string,
        "query": "SELECT 1 as value",
        "operation": "select"
    })

    runtime = LocalRuntime()
    results, run_id = runtime.execute(workflow.build())

    assert results["db"]["success"]
    assert len(results["db"]["data"]) > 0


# ❌ WRONG: Mocking in integration tests
# from unittest.mock import patch
# @patch('psycopg2.connect')  # DON'T DO THIS
# def test_database_integration(mock_connect):
#     mock_connect.return_value = Mock(...)
```

### Tier 3: E2E Tests (NO mocking in Tiers 2-3)

```python
import pytest
from kailash.runtime import AsyncLocalRuntime

# ✅ CORRECT: Use real services for E2E
@pytest.mark.e2e
@pytest.mark.requires_docker
async def test_complete_pipeline():
    """E2E test with real infrastructure - NO mocking in Tiers 2-3."""
    workflow = build_complete_etl_pipeline()

    runtime = AsyncLocalRuntime()
    results = await runtime.execute_workflow_async(workflow.build(), inputs={})

    # All stages use real services
    assert results["extract"]["status"] == "success"
    assert results["transform"]["rows_processed"] > 0
    assert results["load"]["rows_inserted"] > 0
```

## Real Infrastructure Examples

### Real PostgreSQL Database

```python
from tests.utils.docker_config import get_postgres_connection_string

def test_with_real_postgres():
    """Use real PostgreSQL from Docker."""
    conn_string = get_postgres_connection_string()

    workflow = WorkflowBuilder()
    workflow.add_node("SQLDatabaseNode", "db", {
        "connection_string": conn_string,
        "query": "SELECT * FROM users",
        "operation": "select"
    })

    runtime = LocalRuntime()
    results, run_id = runtime.execute(workflow.build())

    assert results["db"]["success"]
```

### Real Redis Cache

```python
from tests.utils.docker_config import get_redis_url
import redis

def test_with_real_redis():
    """Use real Redis from Docker."""
    redis_url = get_redis_url()
    redis_client = redis.from_url(redis_url)

    # Test with real Redis
    redis_client.set('test_key', 'test_value')
    assert redis_client.get('test_key') == b'test_value'
```

### Real API Service

```python
from tests.utils.docker_config import MOCK_API_CONFIG
import requests

def test_with_real_api():
    """Use real mock-api Docker service."""
    workflow = WorkflowBuilder()
    workflow.add_node("HTTPRequestNode", "api", {
        "url": f"{MOCK_API_CONFIG['base_url']}/v1/users",
        "method": "GET"
    })

    runtime = LocalRuntime()
    results, run_id = runtime.execute(workflow.build())

    assert results["api"]["status_code"] == 200
```

## Testing Both Runtimes with Real Services

```python
import pytest
import asyncio
from kailash.runtime import LocalRuntime, AsyncLocalRuntime
from tests.utils.docker_config import get_postgres_connection_string

@pytest.mark.parametrize("runtime_class", [LocalRuntime, AsyncLocalRuntime])
@pytest.mark.requires_docker
def test_database_with_both_runtimes(runtime_class):
    """Test database operations with both runtimes - NO mocking in Tiers 2-3."""
    conn_string = get_postgres_connection_string()

    workflow = WorkflowBuilder()
    workflow.add_node("SQLDatabaseNode", "db", {
        "connection_string": conn_string,
        "query": "SELECT 1 as value",
        "operation": "select"
    })

    runtime = runtime_class()

    if isinstance(runtime, AsyncLocalRuntime):
        results = asyncio.run(runtime.execute_workflow_async(workflow.build(), inputs={}))
    else:
        results, run_id = runtime.execute(workflow.build())

    assert results["db"]["success"]
```

## Available Docker Services

### Test Infrastructure

```bash
# Start all test services
cd tests/utils
docker-compose -f docker-compose.test.yml up -d

# Available services:
# - PostgreSQL: localhost:5434
# - Redis: localhost:6380
# - Ollama: localhost:11435
# - MySQL: localhost:3307
# - MongoDB: localhost:27017
# - Mock API: localhost:8888
```

### Using Docker Config

```python
from tests.utils.docker_config import (
    get_postgres_connection_string,  # PostgreSQL connection
    get_redis_url,                   # Redis URL
    OLLAMA_CONFIG,                   # Ollama config
    MOCK_API_CONFIG                  # Mock API config
)
```

## Common Violations and Fixes

### Violation 1: Mocking Database Connections

```python
# ❌ WRONG: Mocking database in integration test
from unittest.mock import patch, Mock

@patch('psycopg2.connect')
def test_database_query(mock_connect):
    mock_connect.return_value = Mock(...)
    # BAD - mocking hides real connection issues

# ✅ CORRECT: Use real database
from tests.utils.docker_config import get_postgres_connection_string

@pytest.mark.requires_docker
def test_database_query():
    conn_string = get_postgres_connection_string()
    # Use real PostgreSQL connection
```

### Violation 2: Mocking HTTP Requests

```python
# ❌ WRONG: Mocking requests in integration test
from unittest.mock import patch

@patch('requests.get')
def test_api_call(mock_get):
    mock_get.return_value.status_code = 200
    # BAD - mocking hides real API issues

# ✅ CORRECT: Use real mock-api service
from tests.utils.docker_config import MOCK_API_CONFIG

@pytest.mark.requires_docker
def test_api_call():
    url = f"{MOCK_API_CONFIG['base_url']}/v1/users"
    response = requests.get(url)
    assert response.status_code == 200
```

### Violation 3: Mocking Runtime Behavior

```python
# ❌ WRONG: Mocking runtime behavior
from unittest.mock import patch

@patch('kailash.runtime.local.LocalRuntime.execute')
def test_workflow(mock_execute):
    mock_execute.return_value = ({}, 'run_123')
    # BAD - not testing real runtime behavior

# ✅ CORRECT: Use real runtime
from kailash.runtime import LocalRuntime

def test_workflow():
    workflow = WorkflowBuilder()
    workflow.add_node("PythonCodeNode", "node", {"code": "result = 42"})

    runtime = LocalRuntime()
    results, run_id = runtime.execute(workflow.build())

    assert results["node"]["result"] == 42
```

## Policy Summary

| Test Tier               | Mocking Policy             | Infrastructure       | Runtime                           |
| ----------------------- | -------------------------- | -------------------- | --------------------------------- |
| **Tier 1: Unit**        | ✅ ALLOWED                 | In-memory, mocked    | LocalRuntime                      |
| **Tier 2: Integration** | ❌ NO mocking in Tiers 2-3 | Real Docker services | LocalRuntime or AsyncLocalRuntime |
| **Tier 3: E2E**         | ❌ NO mocking in Tiers 2-3 | Real infrastructure  | AsyncLocalRuntime (typical)       |

## Documentation References

### Primary Sources

## Related Patterns

- **Gold testing standard**: [`gold-testing`](gold-testing.md)

<!-- Trigger Keywords: mocking policy, NO mocking in Tiers 2-3, real infrastructure, test policy, mock guidelines, testing standards -->
