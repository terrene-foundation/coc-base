# Validator 17 — Roster Schema Coupling Audit Fixtures

Fixtures exercise the four branches of `.claude/bin/emit.mjs::validateRosterSchemaCoupling()` (V17) so future refactors of the validator are mechanically detected before they ship a soft regression-lock.

Origin: F67 (GH #379, journal/0161) added V17 as a structural regression-lock for the multi-operator substrate's hook⇔data coupling. Journal/0162 (cc-architect HIGH-1) added these fixtures to close the `cc-artifacts.md` Rule 9 gap.

## Predicate branches V17 covers

| Branch | hookPresent | schemaExists | tier-membership | Expected                                                |
| ------ | ----------- | ------------ | --------------- | ------------------------------------------------------- |
| 1      | false       | n/a          | n/a             | PASS — no substrate, no coupling to enforce             |
| 2      | true        | true         | true            | PASS — happy path; substrate complete                   |
| 3      | true        | false        | n/a             | FAIL — schema file missing at runtime path              |
| 4      | true        | true         | false           | FAIL — schema exists but NOT declared in `tiers:` block |

## Scope-restriction predicate (journal/0162 scope-fix)

A FIFTH probe — schema present + entry in `use_exclude:` or `use_obsoleted:` (NOT in `tiers:`) — MUST FAIL. This was the false-pass class before the `sliceBlock("tiers")` scope-fix; the fixture below (`fixture-05-entry-in-use-exclude`) exercises it.

## Fixture layout

Each fixture is a `*.scenario.txt` describing the inputs (which files present/absent, which manifest tier holds the entry) and the expected V17 verdict + exit code. Driver: re-run V17 against a temporary working tree matching the scenario; assert verdict + exit code.

Automation note: today these are descriptive (operator runs the probe manually per the scenario steps). Phase-2 (after ≥3 real V17-touching codifies) — wire into a fixture-driver per `cc-artifacts.md` Rule 9 + the existing `audit-fixtures/violation-patterns/` driver pattern.
