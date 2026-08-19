---
name: validate-parameters
description: "Validate node parameters. Use when asking 'validate parameters', 'check node params', or 'parameter validation'."
---

# Validate Node Parameters

> **Skill Metadata**
> Category: `validation`
> Priority: `HIGH`
> SDK Version: `0.9.25+`

## Parameter Validation

```python
from kailash.workflow.builder import WorkflowBuilder

workflow = WorkflowBuilder()

# Valid: All required parameters
workflow.add_node("LLMNode", "llm1", {
    "provider": "openai",
    "model": os.environ["LLM_MODEL"],
    "prompt": "Hello"
})

# Invalid: Missing required 'prompt'
# workflow.add_node("LLMNode", "llm2", {
#     "provider": "openai",
#     "model": os.environ["LLM_MODEL"]
# })  # Error!

# Validate at build time
workflow.build()  # Raises error if parameters invalid
```

## Validation Methods (Internal)

Both LocalRuntime and AsyncLocalRuntime use ValidationMixin for shared validation logic:

```python
# ValidationMixin provides 5 validation methods:
# 1. validate_workflow() - Validates complete workflow structure
# 2. _validate_connection_contracts() - Validates connection parameter contracts
# 3. _validate_conditional_execution_prerequisites() - Validates conditional node setup
# 4. _validate_switch_results() - Validates SwitchNode output structure
# 5. _validate_conditional_execution_results() - Validates conditional execution results
```

### Runtime Validation

```python
from kailash.runtime.local import LocalRuntime

runtime = LocalRuntime()

# Validation happens at execution time
try:
    results, run_id = runtime.execute(workflow.build())
except WorkflowValidationError as e:
    print(f"Validation failed: {e}")
```

## Custom Node Parameter Validation

Define parameter contracts for validation:

```python
from kailash.nodes.base import Node, NodeParameter
from typing import Dict, Any

class ValidatedNode(Node):
    def get_parameters(self) -> Dict[str, NodeParameter]:
        """Define parameter validation contract."""
        return {
            "file_path": NodeParameter(
                type=str,
                required=True,
                description="Path to input file"
            ),
            "threshold": NodeParameter(
                type=int,
                required=False,
                default=100,
                description="Processing threshold"
            )
        }

    def run(self, **kwargs) -> Dict[str, Any]:
        # Parameters are pre-validated by runtime
        file_path = kwargs["file_path"]  # Guaranteed to exist
        threshold = kwargs.get("threshold", 100)  # Has default

        # Business logic validation
        if threshold < 0:
            raise ValueError("threshold must be non-negative")

        return {"result": process(file_path, threshold)}
```

## Validation Errors

### Missing Required Parameters

```python
# Error: Missing 'file_path'
workflow.add_node("CSVReaderNode", "reader", {
    "delimiter": ","  # file_path is required!
})
# Raises: WorkflowValidationError
```

### Invalid Parameter Types

```python
# Error: Wrong type for 'threshold'
workflow.add_node("FilterNode", "filter", {
    "threshold": "100"  # Should be int, not str
})
# Raises: WorkflowValidationError
```

### Unknown Parameters

```python
# Error: Unknown parameter 'unknown_param'
workflow.add_node("CSVReaderNode", "reader", {
    "file_path": "data.csv",
    "unknown_param": "value"  # Not defined in node contract
})
# Raises: WorkflowValidationError
```

## Connection Validation

ValidationMixin validates connection contracts:

```python
# Valid: Output type matches input type
workflow.add_node("CSVReaderNode", "reader", {"file_path": "data.csv"})
workflow.add_node("DataTransformerNode", "transformer", {})
workflow.add_connection("reader", "data", "transformer", "input_data")

# Invalid: Type mismatch
# workflow.add_connection("reader", "metadata", "transformer", "input_data")
# Raises: WorkflowValidationError (if contracts enforce types)
```

## Common Validation Issues

1. **Missing required parameters** - Provide all required parameters
2. **Invalid parameter types** - Match parameter types to node contract
3. **Unknown parameters** - Only use declared parameters
4. **Invalid parameter values** - Validate business logic constraints
5. **Connection type mismatches** - Ensure compatible types

## Related Patterns

- **For parameter passing**: See [`gold-parameter-passing`](#)
- **For runtime execution**: See [`runtime-execution`](#)
- **For workflow basics**: See [`workflow-quickstart`](#)

## Documentation References

### Primary Sources

### Internal Implementation
- Provides shared validation logic for LocalRuntime and AsyncLocalRuntime

## Quick Tips

- Validation happens at `workflow.build()` and `runtime.execute()`
- Define parameter contracts with `get_parameters()` in custom nodes
- Use required=True for mandatory parameters
- Add business logic validation in `run()` method
- Both LocalRuntime and AsyncLocalRuntime use identical validation logic

<!-- Trigger Keywords: validate parameters, check node params, parameter validation, node parameters -->
