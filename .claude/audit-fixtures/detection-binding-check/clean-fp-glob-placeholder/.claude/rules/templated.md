# Rule Documenting The Canonical Wiring Template

## Trust Posture Wiring

- **Detection mechanism:** cite the hook path (`.claude/hooks/lib/<file>.js::<function>`),
  the audit-fixture directory (`.claude/audit-fixtures/<id>/`), and the probe file
  (`.claude/test-harness/probes/<id>.probes.json`). Any `.claude/bin/*-readiness-check.mjs`
  scanner qualifies.
- **Violation scope:** MUST-1.
