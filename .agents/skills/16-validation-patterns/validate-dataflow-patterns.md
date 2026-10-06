---
name: validate-dataflow-patterns
description: "Validate DataFlow compliance patterns. Use when asking 'validate dataflow', 'dataflow compliance', or 'check dataflow code'."
---

# Validate DataFlow Patterns

> **Skill Metadata**
> Category: `validation`
> Priority: `MEDIUM`
> SDK Version: `0.9.25+`

## DataFlow Compliance Checks

```python
# ✅ CORRECT: Use @db.model decorator
from dataflow import DataFlow

db = DataFlow("sqlite:///app.db")

@db.model
class User:
    id: str
    email: str

# Auto-generates 11 nodes: UserCreateNode, UserReadNode, UserUpsertNode, UserCountNode, etc.

# ❌ WRONG: Manual node creation for database ops
# workflow.add_node("SQLDatabaseNode", "create_user", {
#     "query": "INSERT INTO users..."
# })
```

## Validation Rules

1. **Use @db.model** - Not manual SQL
2. **Use generated nodes** - UserCreateNode, UserReadNode
3. **String IDs** - Required for all models
4. **No direct SQLAlchemy** - DataFlow handles it

<!-- Trigger Keywords: validate dataflow, dataflow compliance, check dataflow code, dataflow patterns -->
