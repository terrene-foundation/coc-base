---
priority: 0
scope: baseline
---

# Sample Rule

<!-- slot:neutral-body -->

Every bulk operation MUST log per-row failures at WARN level.

**Why:** Silent partial failures cascade into data corruption.

<!-- /slot:neutral-body -->

<!-- slot:examples -->

```python
Agent(subagent_type="dataflow-specialist", prompt="...")
```

<!-- /slot:examples -->
