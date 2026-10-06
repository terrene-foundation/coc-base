---
name: validate-absolute-imports
description: "Validate absolute imports in SDK code. Use when asking 'check imports', 'import validation', or 'absolute imports'."
---

# Validate Absolute Imports

> **Skill Metadata**
> Category: `validation`
> Priority: `MEDIUM`
> SDK Version: `0.9.25+`

## Required Pattern

```python
# ✅ CORRECT: Absolute imports
from kailash.workflow.builder import WorkflowBuilder
from kailash.runtime import LocalRuntime
from kailash.nodes.llm import LLMNode

# ❌ WRONG: Relative imports
from ..workflow.builder import WorkflowBuilder
from .runtime import LocalRuntime
```

## Validation Script

```bash
# Find relative imports in SDK code
grep -r "from \.\." kailash/ --include="*.py"
grep -r "from \." kailash/ --include="*.py" | grep -v "# type:"

# Should return empty (no results)
```

## Why Absolute Imports?

1. **Clarity** - Clear module origin
2. **Portability** - Works in any context
3. **IDE support** - Better autocomplete
4. **Testing** - Easier to mock/patch

## Documentation


<!-- Trigger Keywords: check imports, import validation, absolute imports, relative imports -->
