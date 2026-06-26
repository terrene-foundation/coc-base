---
name: gold-error-handling
description: "Gold standard for error handling. Use when asking 'error handling standard', 'handle errors', or 'error patterns'."
---

# Gold Standard: Error Handling

> **Skill Metadata**
> Category: `gold-standards`
> Priority: `HIGH`
> SDK Version: `0.9.25+`

## Error Handling Patterns

### 1. Try-Catch at Node Level

```python
workflow = WorkflowBuilder()

# Critical operation
workflow.add_node("HTTPRequestNode", "payment_api", {
    "url": "https://api.stripe.com/charge",
    "method": "POST",
    "timeout": 30
})

# Error handler
workflow.add_error_handler("payment_api", "log_payment_failure")
workflow.add_error_handler("payment_api", "refund_user")
```

### 2. Validation Before Processing

```python
# ✅ GOOD: Validate first
workflow.add_node("CodeValidationNode", "validate_input", {
    "schema": {"email": "email", "amount": "decimal > 0"}
})

workflow.add_node("SwitchNode", "check_valid", {
    "condition": "{{validate_input.is_valid}} == true",
    "true_branch": "process",
    "false_branch": "error_response"
})
```

### 3. Graceful Degradation

```python
# Primary path
workflow.add_node("HTTPRequestNode", "primary_api", {...})

# Fallback on error
workflow.add_error_handler("primary_api", "fallback_api")
workflow.add_node("HTTPRequestNode", "fallback_api", {...})
```

### 4. Error Logging

```python
workflow.add_node("SQLDatabaseNode", "log_error", {
    "query": "INSERT INTO error_log (node_id, error, timestamp) VALUES (?, ?, NOW())",
    "parameters": ["{{error.node_id}}", "{{error.message}}"]
})
```

## Gold Standard Checklist

- [ ] Error handlers for all critical nodes
- [ ] Input validation before processing
- [ ] Fallback paths for external APIs
- [ ] Error logging for debugging
- [ ] User-friendly error messages
- [ ] Retry logic with backoff
- [ ] Transaction rollback on failure
- [ ] Error tests in test suite

<!-- Trigger Keywords: error handling standard, handle errors, error patterns, error handling gold standard -->
