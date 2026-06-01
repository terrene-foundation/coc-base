---
priority: 0
scope: baseline
---

# Sample Rule

<!-- slot:neutral-body -->

Every bulk operation MUST log per-row failures at WARN level using Codex's structured-log primitive, and on Codex this applies only to mutating tools.

**Why:** Silent partial failures cascade into data corruption.

<!-- /slot:neutral-body -->
