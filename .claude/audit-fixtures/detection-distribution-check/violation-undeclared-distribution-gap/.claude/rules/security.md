# Security — cites a detector that reaches NONE of this rule's lanes

The rule ships to every live lane. `.claude/test-harness/**` ships to none of
them. Nothing in this tree declares that, so the consumer receives a rule whose
stated enforcement mechanism is absent from its tree with nothing saying so.

## Trust Posture Wiring

- **Detection mechanism:** Phase 1 — probes `.claude/test-harness/probes/security.probes.json`.
- **Violation scope:** MUST-1.
