# Proximity-Band Validator Audit Fixtures

Audit fixtures for `.claude/bin/validate-proximity-band.mjs` (F23e, journal/0155 — Rule 10 Phase-2 mechanical sweep, sub-items 1-3 of cc-architect's manual sweep).

Pairs with the F23a `proximity-band-budget` audit-fixture suite (which locks `getProximityBandAdvisory` semantics) and F25's `validate-extraction-history` (which locks Rule 11 escalation semantics). This suite locks the COMPOSITION: emit-dry-run headroom parse + baseline-priority diff scan + cross-reference verdict.

## Predicates covered (one fixture per scope-restriction predicate per `cc-artifacts.md` Rule 9)

| Fixture                              | Predicate exercised                                                                                                          | Expected output                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `fixture-01-no-near-breach`          | All lanes above 15% proximity band; no advisory fires. Direct call to `getProximityBandAdvisory` returns null.               | `null` (clean)                                        |
| `fixture-02-near-breach-no-diff`     | Near-breach lane exists (≥1 advisory) but diff carries no baseline-rule additions → verdict `advisory_only_no_diff`, exit 0. | `rule_10_fires=false`, exit 0                         |
| `fixture-03-near-breach-with-diff`   | Near-breach AND new MUST addition on a priority:0 + scope:baseline rule → Rule 10 fires, exit 1.                             | `rule_10_fires=true`, exit 1                          |
| `fixture-04-band-edge-15pct`         | Lane at exactly 15% headroom — F23a's band edge is EXCLUSIVE (no advisory fires AT band edge per emit.mjs line 519).         | `null` (no advisory at band edge)                     |
| `fixture-05-misconfig-band-le-floor` | `proximityBandPct <= floorPct` → misconfiguration; advisory does NOT fire (security M4 — defense against malformed config).  | `null`                                                |
| `fixture-06-diff-only-path-scoped`   | Diff adds MUST clause to a `scope: path-scoped` rule (NOT baseline) → does NOT contribute to Rule 10 trigger.                | `baseline_additions=0`, `rule_10_fires=false`, exit 0 |
| `fixture-07-empty-diff`              | `base..head` produces no diff at all → no additions, no fire.                                                                | `additions_total=0`, exit 0                           |
| `fixture-08-multiple-lanes-mixed`    | Multiple lane records present; near-breach detection identifies only the in-band ones.                                       | `near_breach_lanes` lists exactly the in-band lanes   |
| `fixture-09-help-exit-0`             | Subprocess test: `--help` exits 0 + prints usage.                                                                            | exit 0, stdout contains "usage:"                      |
| `fixture-10-malformed-flag-exit-2`   | Subprocess test: unknown `--unknown-flag` exits 2 with error.                                                                | exit 2, stderr contains "unknown flag"                |

## Running the fixture suite

```bash
node .claude/audit-fixtures/validate-proximity-band/run.mjs
```

Exit 0 = all predicates pass. Non-zero = regression in
`runEmitDryRun`, `scanProposalDiffForBaselineAdditions`, `isBaselineRule`,
or the main composition / verdict logic.

## Why these fixtures matter

Per `rule-authoring.md` MUST Rule 10's Trust Posture Wiring detection
mechanism, the cc-architect mechanical sweep at `/codify` parses
`emit.mjs` dry-run output for `headroom_pct < 15%` rows AND cross-
references against new MUST / MUST NOT / BLOCKED additions on priority:0

- scope:baseline rules. This validator is the mechanical version of that
  sweep; the fixtures lock the contract semantics — a regression that
  silently changes "exclusive band edge" to "inclusive", silently misses
  path-scoped-vs-baseline filtering, or silently classifies a diff with
  zero additions as `rule_10_fires=true` would weaken the at-author-time
  admission gate Rule 10 exists to provide.

Fixtures 02 / 03 / 06 / 07 use temp git repos (real subprocess; no
mocks) per `probe-driven-verification.md` MUST-3 — structural probes
against exit codes + JSON output, no regex-over-prose. Fixtures 01 / 04
/ 05 / 08 exercise the imported helpers (`getProximityBandAdvisory`,
`isBaselineRule`, the lane-classification predicate) directly via ESM
import. Fixtures 09 / 10 are subprocess CLI assertions.

Per `cc-artifacts.md` Rule 9 + Rule 10 positive-allowlist principle:
enumerable scope-restriction predicates exercised at landing time.

Origin: journal/0155 § F23e closure (the F23a sibling Phase-2
deferral; pairs with F25's Rule 11 escalation validator). Coverage of
sub-items 4-5 of the Rule 10 manual sweep (named-rationale 5-sub-field
validation + BLOCKED-corpus grep) is DEFERRED to a separate sub-shard.
