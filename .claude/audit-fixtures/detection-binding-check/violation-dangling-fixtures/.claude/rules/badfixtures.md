# Rule Naming A Fixtures Directory That Does Not Exist

## Trust Posture Wiring

- **Detection mechanism:** Phase 1 (structural, CI) — scanner
  `.claude/bin/present-check.mjs`; fixtures `.claude/audit-fixtures/nonexistent-fixtures/`;
  probes `.claude/test-harness/probes/present.probes.json`.
- **Violation scope:** MUST-1.
