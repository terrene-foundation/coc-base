# Rule Naming A Probe Suite Whose Authorship Is DECLARED-Deferred

The suite does not exist yet and the Detection block says so by NAMING it. The
absence is declared, reasoned, risk-banded and dated in
`phase2-deferrals.json::probe_authorship_deferrals`, so the binding stays
greppable and the gate stays green only until the expiry passes.

## Trust Posture Wiring

- **Detection mechanism:** Phase 1 (structural, CI) — scanner
  `.claude/bin/present-check.mjs`; fixtures `.claude/audit-fixtures/present/`;
  probes `.claude/test-harness/probes/deferredprobe.probes.json` — NOT YET
  AUTHORED, declared with an expiry in the probe-authorship deferral registry.
- **Violation scope:** MUST-1.
