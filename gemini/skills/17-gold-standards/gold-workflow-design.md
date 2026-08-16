---
name: gold-workflow-design
description: "Gold standard for workflow design. Use when asking 'workflow design standard', 'workflow best practices', or 'design workflow'."
---

# Gold Standard: Workflow Design

> **Skill Metadata**
> Category: `gold-standards`
> Priority: `HIGH`
> SDK Version: `0.9.25+`

## Design Principles

### 1. Single Responsibility
```python
# ✅ GOOD: Each workflow does one thing
workflow_user_registration = WorkflowBuilder()
workflow_send_welcome_email = WorkflowBuilder()

# ❌ BAD: One workflow does too much
workflow_everything = WorkflowBuilder()  # Registration + email + billing...
```

### 2. Composability
```python
# ✅ GOOD: Reusable sub-workflows
def create_validation_workflow():
    workflow = WorkflowBuilder()
    workflow.add_node("CodeValidationNode", "validate", {...})
    return workflow.build()

# Use in multiple workflows
main_workflow.add_sub_workflow("validation", create_validation_workflow())
```

### 3. Error Handling
```python
# ✅ GOOD: Explicit error paths
workflow.add_error_handler("api_call", "log_error")
workflow.add_error_handler("api_call", "notify_admin")
```

### 4. Clear Naming
```python
# ✅ GOOD: Descriptive node IDs
workflow.add_node("LLMNode", "generate_product_description", {...})

# ❌ BAD: Generic names
workflow.add_node("LLMNode", "node1", {...})
```

## Gold Standard Checklist

- [ ] Single responsibility per workflow
- [ ] Descriptive node IDs
- [ ] Error handlers for critical nodes
- [ ] Input validation nodes
- [ ] Clear connection flow
- [ ] No circular dependencies
- [ ] Documented with comments
- [ ] Unit tests for workflow logic

<!-- Trigger Keywords: workflow design standard, workflow best practices, design workflow, workflow gold standard -->
