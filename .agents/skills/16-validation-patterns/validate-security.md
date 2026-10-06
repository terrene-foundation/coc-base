---
name: validate-security
description: "Security validation checks. Use when asking 'security validation', 'check security', or 'security audit'."
---

# Security Validation

> **Skill Metadata**
> Category: `validation`
> Priority: `HIGH`
> SDK Version: `0.9.25+`

## Security Checklist

### 1. Secrets Management

```python
# ✅ CORRECT: Use environment variables
import os
api_key = os.getenv("OPENAI_API_KEY")

# ❌ WRONG: Hard-coded secrets
# api_key = "sk-abc123..."
```

### 2. SQL Injection Prevention

```python
# ✅ CORRECT: Parameterized queries
workflow.add_node("DatabaseQueryNode", "query", {
    "query": "SELECT * FROM users WHERE id = ?",
    "parameters": ["{{input.user_id}}"]
})

# ❌ WRONG: String concatenation
# "query": f"SELECT * FROM users WHERE id = {user_id}"
```

### 3. Input Validation

```python
# ✅ CORRECT: Validate inputs
workflow.add_node("CodeValidationNode", "validate", {
    "input": "{{input.data}}",
    "schema": {"email": "email", "age": "integer"}
})
```

## Validation Script

```bash
# Check for hard-coded secrets
grep -r "api_key.*=.*['\"]sk-" . --include="*.py"
grep -r "password.*=.*['\"]" . --include="*.py"

# Should return empty (no matches)
```

<!-- Trigger Keywords: security validation, check security, security audit, secrets management -->
