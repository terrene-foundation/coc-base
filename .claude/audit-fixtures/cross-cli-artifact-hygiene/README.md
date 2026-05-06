# cross-cli-artifact-hygiene Audit Fixtures

Fixtures for `tools/lint-workspaces.js` per `rules/cross-cli-artifact-hygiene.md`.

Per `rules/cc-artifacts.md` MUST §9 (Audit Tools Ship With Committed Test Fixtures), every mechanical audit tool ships with test fixtures exercising every scope-restriction predicate.

## Layout

| Fixture                        | Type | Expected lint behavior                                                                      |
| ------------------------------ | ---- | ------------------------------------------------------------------------------------------- |
| `flag-agent-syntax.md`         | flag | Multiple findings: agent-subagent-type, agent-object-subagent-type, agent-run-in-background |
| `flag-claude-md-authority.md`  | flag | Multiple findings: cli-baseline-claude-md, cli-baseline-agents-md, cli-baseline-path        |
| `flag-tool-name.md`            | flag | Multiple findings: tool-noun-read, tool-noun-bash, tool-noun-edit, hook-event-session-start |
| `clean-neutral-delegation.md`  | null | Zero findings — delegation, baseline, hook, tool refs all neutral                           |
| `clean-historical-citation.md` | null | Zero findings — `(historical)` qualifier skips the line                                     |

## Run

    node tools/lint-workspaces.js .claude/audit-fixtures/cross-cli-artifact-hygiene/

Expected: 3 flag fixtures produce findings, 2 clean fixtures produce zero. Combined exit code: 1.

## Severity

Advisory. Per the rule's Trust Posture Wiring, lint output surfaces leakage to the user; the user adjudicates rewrite vs qualify-as-historical. New leaks introduced after rule-land are `regression_within_grace` per `trust-posture.md` MUST Rule 4.

## Allowlist

Lines containing `(historical)`, `(historical citation)`, or `<!-- cli-portable-exception -->` are skipped. This implements MUST 5 (qualified-historical mentions are acceptable).
