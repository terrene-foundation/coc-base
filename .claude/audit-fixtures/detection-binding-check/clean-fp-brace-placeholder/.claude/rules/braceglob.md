# Rule Whose Detection Block Uses Brace-Expansion Placeholders

## Trust Posture Wiring

- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer runs the sweep. Audit fixtures committed at `.claude/audit-fixtures/violation-patterns/detect{Alpha,Beta}/` per `rules/cc-artifacts.md` Rule 9; see also `.claude/bin/check[Alpha].mjs` and `.claude/bin/probe(Beta).mjs`.
- **Violation scope:** MUST-1.
