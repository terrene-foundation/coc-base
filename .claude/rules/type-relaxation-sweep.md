---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.py"
  - "**/*.rs"
---

# Type-Relaxation Sweep — Extraction Sites Are Not Render Sites

Depth — the worked cross-language sites, the BLOCKED corpus, and the origin evidence — is
`skills/16-validation-patterns/type-relaxation-sweep.md`. Read it before reviewing a relaxation.

## MUST Rules

### 1. Sweep Value-Extraction Sites Separately From Render Sites

When a change relaxes a type constraint that was load-bearing for runtime safety (`string & keyof T`
→ `string`, `Optional[X]` → `X | None | Y`, a narrowed union widened to its base), the review MUST
inventory **value-extraction** sites separately from **render** sites, at analysis time and against
the PROPOSED type. A coalesce or null-check at the render site does NOT establish that the extraction
expression is guarded — two distinct safety properties, only one visible in the output.

```text
# DO — two inventories: sites that EXTRACT under the relaxed type, sites that RENDER one
# DO NOT — one pass marking an extraction "already safe" because its output is coalesced downstream
```

**Why:** The dangerous guards are the ones nobody wrote — where the type system narrowed ambiently
and safety was a side effect of the constraint, not of a check. Those sites read as already-safe to a
single-pass review precisely because there is no guard code to notice missing, and the compiler stops
objecting at exactly the moment the guard disappears. BLOCKED corpus + cross-language evidence: skill.

Depth — the Trust-Posture Wiring, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/type-relaxation-sweep.md`, which every validator reads as part of this rule.
