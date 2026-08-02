# Rule With A Worked Example — the fenced bullet is illustration, not a binding

## MUST Rules

### 1. Name The Full Binding

```text
# DO — Detection mechanism names the full binding, every path resolving
- **Detection mechanism:** scanner `.claude/bin/foo-readiness-check.mjs`;
  fixtures `.claude/audit-fixtures/foo/`; probes `.claude/test-harness/probes/foo.probes.json`.

# DO NOT — a Detection block with no harness binding
- **Detection mechanism:** cc-architect reviews it at /codify.
```

## Trust Posture Wiring

- **Detection mechanism:** scanner `.claude/bin/fenced-readiness-check.mjs`; fixtures `.claude/audit-fixtures/fenced/`.
- **Violation scope:** MUST-1.
