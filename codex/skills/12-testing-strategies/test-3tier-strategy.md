---
name: test-3tier-strategy
description: "3-tier testing strategy overview. Use when asking '3-tier testing', 'testing strategy', or 'test tiers'."
---

# 3-Tier Testing Strategy

> **Skill Metadata**
> Category: `testing`
> Priority: `HIGH`
> SDK Version: `0.9.25+`

## Testing Pyramid

### Tier 1: Unit Tests (Fast, In-Memory)
```python
def test_workflow_build():
    """Test workflow construction"""
    workflow = WorkflowBuilder()
    workflow.add_node("LLMNode", "llm", {"prompt": "test"})
    built = workflow.build()
    assert built is not None
```

### Tier 2: Integration Tests (Real Infrastructure)
```python
def test_llm_integration():
    """Test with real OpenAI API"""
    workflow = WorkflowBuilder()
    workflow.add_node("LLMNode", "llm", {
        "provider": "openai",
        "model": os.environ["LLM_MODEL"],
        "prompt": "Say hello"
    })
    runtime = LocalRuntime()
    results, run_id = runtime.execute(workflow.build())
    assert "hello" in results["llm"]["response"].lower()
```

### Tier 3: End-to-End Tests (Full System)
```python
@pytest.mark.e2e
def test_full_application():
    """Test complete application flow"""
    # Test API endpoint
    # Test database persistence
    # Test external integrations
```

## Test Distribution

- **Tier 1 (Unit)**: 70% - Fast feedback
- **Tier 2 (Integration)**: 25% - Real dependencies
- **Tier 3 (E2E)**: 5% - Critical paths

## Real infrastructure recommended Policy

✅ **Use real infrastructure** in Tiers 2-3:
- Real OpenAI API calls
- Real databases (SQLite/PostgreSQL)
- Real file systems

❌ **No mocks** for:
- LLM providers
- Databases
- External APIs (in integration tests)

## Runtime Parity Testing

Test workflows against **both** LocalRuntime and AsyncLocalRuntime using shared fixtures:

```python
import pytest
from tests.shared.runtime.conftest import runtime_class, execute_runtime

def test_workflow_execution(runtime_class):
    """Test runs twice: once with LocalRuntime, once with AsyncLocalRuntime"""
    runtime = runtime_class()
    workflow = create_test_workflow()

    # Helper normalizes parameter names and return structures
    results = execute_runtime(runtime, workflow, parameters={"input": "data"})

    assert results["output_node"]["result"] == expected_value
```

**Key Features:**
- Parametrized fixtures run same test on both runtimes
- `execute_runtime()` helper normalizes parameters and return structures
- Ensures identical behavior between sync and async runtimes
- Located in `tests/shared/runtime/` directory

## Documentation


<!-- Trigger Keywords: 3-tier testing, testing strategy, test tiers, testing pyramid, unit tests, integration tests -->
