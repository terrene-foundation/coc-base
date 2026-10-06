---
name: gold-security
description: "Gold standard for security practices. Use when asking 'security standard', 'security best practices', or 'secure coding'."
---

# Gold Standard: Security

> **Skill Metadata**
> Category: `gold-standards`
> Priority: `HIGH`
> SDK Version: `0.9.25+`

## Security Principles

### 1. Secrets Management
```python
# ✅ GOOD: Environment variables
import os

workflow.add_node("HTTPRequestNode", "api", {
    "url": "https://api.example.com",
    "headers": {
        "Authorization": f"Bearer {os.getenv('API_KEY')}"
    }
})

# ❌ BAD: Hard-coded secrets
# "Authorization": "Bearer sk-abc123..."
```

### 2. SQL Injection Prevention
```python
# ✅ GOOD: Parameterized queries
workflow.add_node("DatabaseQueryNode", "query", {
    "query": "SELECT * FROM users WHERE id = ?",
    "parameters": ["{{input.user_id}}"]
})

# ❌ BAD: String concatenation
# "query": f"SELECT * FROM users WHERE id = {user_id}"
```

### 3. Input Validation
```python
# ✅ GOOD: Validate all inputs
workflow.add_node("CodeValidationNode", "validate", {
    "input": "{{input.user_data}}",
    "schema": {
        "email": "email",
        "age": "integer",
        "role": "enum:user,admin"
    },
    "sanitize": True  # Remove dangerous characters
})
```

### 4. Authentication & Authorization
```python
# ✅ GOOD: Check permissions
workflow.add_node("DatabaseQueryNode", "check_auth", {
    "query": "SELECT role FROM users WHERE id = ?",
    "parameters": ["{{input.user_id}}"]
})

workflow.add_node("SwitchNode", "authorize", {
    "condition": "{{check_auth.role}} in ['admin', 'editor']",
    "true_branch": "process",
    "false_branch": "unauthorized"
})
```

### 5. Audit Logging
```python
# ✅ GOOD: Log all sensitive operations
workflow.add_node("SQLDatabaseNode", "audit_log", {
    "query": "INSERT INTO audit_log (user_id, action, resource, timestamp) VALUES (?, ?, ?, NOW())",
    "parameters": ["{{input.user_id}}", "delete_user", "{{input.target_user}}"]
})
```

## Security Checklist

- [ ] No hard-coded secrets
- [ ] Parameterized SQL queries
- [ ] Input validation for all user data
- [ ] Authentication checks
- [ ] Authorization checks
- [ ] Audit logging for sensitive ops
- [ ] HTTPS for all API calls
- [ ] Encryption for sensitive data
- [ ] Rate limiting on APIs
- [ ] Security tests in test suite

<!-- Trigger Keywords: security standard, security best practices, secure coding, security gold standard -->
