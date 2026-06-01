---
priority: 0
scope: baseline
---

# Sample Rule

<!-- slot:neutral-body -->

Every bulk operation MUST log per-row failures at WARN level.

<!-- /slot:neutral-body -->

<!-- slot:examples -->

```python
@gemini_log.warn("row %d failed: %s", row, exc)
```

<!-- /slot:examples -->
