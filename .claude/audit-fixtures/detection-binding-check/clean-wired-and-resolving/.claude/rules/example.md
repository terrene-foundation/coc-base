# Example Rule — fully wired, every binding resolves

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review.
- **Detection mechanism:** Phase 1 (structural, CI) — scanner `.claude/bin/example-readiness-check.mjs`; fixtures `.claude/audit-fixtures/example/`; probes `.claude/test-harness/probes/example.probes.json`.
- **Violation scope:** MUST-1.
