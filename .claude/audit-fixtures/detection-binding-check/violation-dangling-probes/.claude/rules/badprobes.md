# Rule Naming A Probe File That Does Not Exist

## Trust Posture Wiring

- **Detection mechanism:** Phase 1 (structural, CI) — scanner
  `.claude/bin/present-check.mjs`; fixtures `.claude/audit-fixtures/present/`;
  probes `.claude/test-harness/probes/nonexistent.probes.json`.
- **Violation scope:** MUST-1.
