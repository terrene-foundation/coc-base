---
name: gold-parameter-passing
description: "Parameter passing standard with three methods, explicit parameter declaration, parameter scoping, and enterprise security patterns. Use when asking 'parameter standard', 'parameter gold', 'parameter validation', 'parameter security', or 'parameter compliance'."
---

# Gold Standard: Parameter Passing

Parameter passing compliance standard with three methods, automatic unwrapping, and security patterns.

> **Skill Metadata**
> Category: `gold-standards`
> Priority: `CRITICAL`
> SDK Version: `0.9.31+`

## Quick Reference

- **Primary Use**: Parameter Passing Compliance Standard
- **Category**: gold-standards
- **Priority**: CRITICAL
- **Trigger Keywords**: parameter standard, parameter gold, parameter validation, parameter security, parameter scoping

## Three Methods of Parameter Passing

### Method 1: Node Configuration (Most Reliable)

```python
from kailash.workflow.builder import WorkflowBuilder

workflow = WorkflowBuilder()
workflow.add_node("CSVReaderNode", "reader", {
    "file_path": "data.csv",
    "delimiter": ",",
    "has_header": True
})
```

**Use when**: Static values, test fixtures, default settings

### Method 2: Workflow Connections (Dynamic Data Flow)

```python
workflow.add_node("CSVReaderNode", "reader", {"file_path": "data.csv"})
workflow.add_node("DataTransformerNode", "transformer", {})

# Pass data between nodes (4-parameter syntax)
workflow.add_connection("reader", "data", "transformer", "input_data")
```

**Use when**: Dynamic data flow, pipelines, transformations

### Method 3: Runtime Parameters (User Input)

```python
from kailash.runtime.local import LocalRuntime

runtime = LocalRuntime()
results, run_id = runtime.execute(
    workflow.build(),
    parameters={
        "reader": {"file_path": "custom.csv"},
        "transformer": {"operation": "normalize"}
    }
)
```

**Use when**: User input, environment overrides, dynamic values

## Parameter Scoping (v0.9.31+)

**Node-specific parameters are automatically unwrapped:**

```python
# What you pass to runtime:
parameters = {
    "api_key": "global-key",      # Global param (all nodes)
    "node1": {"value": 10},        # Node-specific for node1
    "node2": {"value": 20}         # Node-specific for node2
}

runtime.execute(workflow.build(), parameters=parameters)

# What node1 receives (unwrapped automatically):
{
    "api_key": "global-key",       # Global param
    "value": 10                     # Unwrapped from nested dict
}
# node1 does NOT receive node2's parameters (isolated)
```

**Scoping Rules:**
1. **Parameters filtered by node ID**: Only relevant params passed to each node
2. **Node-specific params unwrapped**: Contents extracted from nested dict
3. **Global params included**: Top-level non-node-ID keys go to all nodes
4. **Other nodes' params excluded**: Prevents parameter leakage

## Explicit Parameter Declaration (Security)

Custom nodes must declare parameters explicitly:

```python
from kailash.nodes.base import Node, NodeParameter

class CustomNode(Node):
    def get_parameters(self):
        """Declare ALL expected parameters."""
        return {
            "file_path": NodeParameter(
                type=str,
                required=True,
                description="Path to input file"
            ),
            "delimiter": NodeParameter(
                type=str,
                required=False,
                default=",",
                description="CSV delimiter"
            )
        }

    def run(self, **kwargs):
        file_path = kwargs["file_path"]  # Guaranteed to exist
        delimiter = kwargs.get("delimiter", ",")  # Optional with default
        return {"data": process_file(file_path, delimiter)}
```

**Why explicit declaration?**
- **Security**: Prevents parameter injection attacks
- **Compliance**: Enables parameter tracking and auditing
- **Debugging**: Clear parameter expectations
- **Testing**: Testable parameter contracts
- **Isolation**: Automatic scoping prevents data leakage

## Parameter Naming 

### Using "metadata" as a Parameter Name

You can now use `metadata` as a parameter name in custom nodes:

```python
class CustomNode(Node):
    def get_parameters(self):
        return {
            "data": NodeParameter(type=str, required=True),
            "metadata": NodeParameter(
                type=dict,
                required=False,
                default=None,
                description="User metadata "
            )
        }

    def run(self, data: str, metadata: dict = None, **kwargs):
        # Access user's metadata parameter
        user_meta = metadata

        # Access node's internal metadata (different from parameter)
        node_name = self.metadata.name
        node_desc = self.metadata.description

        return {"data": processed, "metadata": user_meta}
```

**Two types of metadata:**
- `metadata` parameter: User-defined metadata dict (your parameter)
- `self.metadata`: Node's internal metadata object (Core SDK)

### Reserved Names

The only reserved parameter name is `_node_id`:

```python
def get_parameters(self):
    return {
        "_node_id": NodeParameter(...)  # ❌ Reserved - do not use
    }
```

## Common Pitfalls

### Pitfall 1: Empty Parameter Declaration

```python
# WRONG - No parameters declared
class BadNode(Node):
    def get_parameters(self):
        return {}  # SDK injects nothing!

# CORRECT - Explicit declaration
class GoodNode(Node):
    def get_parameters(self):
        return {
            "config": NodeParameter(type=dict, required=True)
        }
```

### Pitfall 2: Expecting Undeclared Parameters

```python
# WRONG - Expecting undeclared parameter
def run(self, **kwargs):
    value = kwargs.get('param')  # Always None if not declared!

# CORRECT - Declare in get_parameters() first
def get_parameters(self):
    return {"param": NodeParameter(type=str, required=True)}
```

## Validation Errors (v0.9.31+)

**Validation failures now raise ValueError:**

```python
try:
    runtime = LocalRuntime(connection_validation="invalid")
except ValueError as e:  # Changed from RuntimeExecutionError
    print(f"Configuration error: {e}")

try:
    workflow.build()  # Validates parameters
except ValueError as e:  # Missing required parameters
    print(f"Parameter error: {e}")
```

## Related Patterns

- **For runtime execution**: See [`runtime-execution`](../01-core-sdk/runtime-execution.md)
- **For workflow basics**: See [`workflow-quickstart`](../01-core-sdk/workflow-quickstart.md)
- **For quick reference**: See [`param-passing-quick`](../01-core-sdk/param-passing-quick.md)

## Documentation References

### Primary Sources

### Internal Implementation

## Quick Tips

- Use Method 1 (node configuration) for tests - most reliable
- Use Method 2 (connections) for dynamic data flow between nodes
- Use Method 3 (runtime parameters) for user input and overrides
- Always declare parameters explicitly in custom nodes
- Parameter scoping prevents data leakage automatically (v0.9.31+)
- Validation errors raise ValueError (v0.9.31+)

## Keywords for Auto-Trigger

<!-- Trigger Keywords: parameter standard, parameter gold, parameter validation, parameter security, parameter scoping, parameter compliance, parameter isolation, unwrap parameters -->
