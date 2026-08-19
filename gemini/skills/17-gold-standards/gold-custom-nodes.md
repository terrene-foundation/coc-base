---
name: gold-custom-nodes
description: "Gold standard for custom node development. Use when asking 'create custom node', 'custom node standard', or 'node development'."
---

# Gold Standard: Custom Node Development

> **Skill Metadata**
> Category: `gold-standards`
> Priority: `MEDIUM`
> SDK Version: `0.10.3+`

## Custom Node Template

```python
from kailash.nodes.base import Node, NodeParameter
from typing import Dict, Any

class MyCustomNode(Node):
    """Custom node for specific business logic.

    Use this node to process input data with custom configuration.
    """

    def get_parameters(self) -> Dict[str, NodeParameter]:
        """Define parameters this node accepts.

        Returns:
            Dictionary mapping parameter names to NodeParameter definitions
        """
        return {
            "input_data": NodeParameter(
                name="input_data",
                type=str,
                required=True,
                description="Input data to process"
            ),
            "config": NodeParameter(
                name="config",
                type=dict,
                required=False,
                default={},
                description="Configuration options"
            ),
            "metadata": NodeParameter(
                name="metadata",
                type=dict,
                required=False,
                default=None,
                description="Optional metadata (current version)"
            )
        }

    def run(self, input_data: str, config: dict = {}, metadata: dict = None, **kwargs) -> Dict[str, Any]:
        """Execute the custom node logic.

        Args:
            input_data: Input data to process
            config: Configuration options
            metadata: Optional metadata dictionary
            **kwargs: Additional parameters passed from workflow

        Returns:
            Dictionary with outputs
        """
        # Your custom logic here
        result = self._process(input_data, config)

        return {
            "result": result,
            "metadata": metadata  # Pass through metadata if needed
        }

    def _process(self, data: str, config: dict) -> str:
        """Process the input data."""
        return data.upper()
```

## Gold Standard Checklist

- [ ] Inherits from `Node`
- [ ] Implements `get_parameters()` method
- [ ] Implements `run()` method (not `execute()`)
- [ ] Parameters defined with `NodeParameter`
- [ ] Type hints for all methods
- [ ] Docstrings for class and methods
- [ ] Error handling for invalid inputs
- [ ] Unit tests for run logic
- [ ] Integration test in workflow

## Parameter Naming

### Available Parameter Names

You can use any parameter name including `metadata` (current version):

```python
def get_parameters(self):
    return {
        "id": NodeParameter(type=str, required=True),
        "metadata": NodeParameter(type=dict, required=False),  # ✅ Now supported
        "data": NodeParameter(type=Any, required=True),
    }
```

### Reserved Names (Do Not Use)

The only reserved name is `_node_id` (internal identifier):

```python
def get_parameters(self):
    return {
        "_node_id": NodeParameter(...)  # ❌ Reserved - do not use
    }
```

### Accessing Internal Node Metadata

Access the node's internal metadata via `self.metadata` property:

```python
def run(self, **kwargs):
    # Access internal NodeMetadata
    node_name = self.metadata.name
    node_desc = self.metadata.description

    # Access user's metadata parameter
    user_metadata = kwargs.get("metadata")

    return {"node_name": node_name, "user_metadata": user_metadata}
```

## Documentation


<!-- Trigger Keywords: create custom node, custom node standard, node development, custom node gold standard -->
