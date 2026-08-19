---
name: validate-connections
description: "Validate workflow connections. Use when asking 'validate workflow', 'check connections', or 'workflow validation'."
---

# Validate Workflow Connections

> **Skill Metadata**
> Category: `validation`
> Priority: `HIGH`
> SDK Version: `0.9.25+`

## Validation Checks

```python
from kailash.workflow.builder import WorkflowBuilder

workflow = WorkflowBuilder()
workflow.add_node("LLMNode", "node1", {})
workflow.add_node("TransformNode", "node2", {})

# ✅ Valid connection (4-parameter pattern)
workflow.add_connection("node1", "result", "node2", "input")

# ❌ Invalid: node doesn't exist
# workflow.add_connection("node1", "node3")  # Error!

# Validate workflow
built = workflow.build()  # Raises error if invalid
```

## Common Issues

1. **Missing connections** - Isolated nodes
2. **Invalid node IDs** - Typos in connections
3. **Circular dependencies** - A → B → A
4. **Unreachable nodes** - No path from start

## Documentation


<!-- Trigger Keywords: validate workflow, check connections, workflow validation, connection errors -->
