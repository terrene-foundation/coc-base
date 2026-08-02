# Namespace Gap

## Trust Posture Wiring

- **Detection mechanism:** Phase 1 — the gate runs `.claude/scripts/totally-absent-scanner.mjs` on every PR, with audit fixtures at `.claude/detectors/nsgap/` and the probe suite at `.claude/probes/nsgap.probes.json`. All three are LIVE wiring, none is deferred.
- **Violation scope:** MUST-1.
