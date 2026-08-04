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
| `fixture-11-unrun-zero-lanes-exits-nonzero` | **loom#1537 regression.** Emit dry-run FAILS → 0 lanes parsed. Pre-fix the gate exited 0 printing `verdict: clean`.   | exit 3, `verdict: unrun_no_coverage`, UNRUN banner; NEVER `verdict: clean` |
| `fixture-11b-unrun-json-coverage-asserted-false` | Same run under `--json`: the machine-readable discriminator.                                                     | `coverage_asserted=false`, `ok=false`, 2 `unrun_reasons` |
| `fixture-12-emit-loads-without-codex-surface` | **loom#1538 regression.** `emit.mjs` loads in a tree with `.claude/codex-mcp-guard/` removed; V13 skips; the extractor throws a NAMED error at USE. | `loaded=true`, `hasCodexGuardSurface()=false`, `v13.skipped=true`, throw names "codex surface absent" |

Negative polarity for fixture-11 is carried by fixtures 02 / 03 / 06 / 07,
which run a GENUINE multi-lane emit and MUST still reach their pre-fix
verdicts at their pre-fix exit codes — a coverage floor that fired on a real
run would show up there as a false UNRUN.

### Harness gaps the coverage floor surfaced (loom#1537)

Fixtures 02 / 03 / 06 / 07 were **passing vacuously**. `buildTempLoomRepo`
built temp repos in which the emit dry-run always failed, so `emit.lanes` was
always empty and every verdict those fixtures asserted on was computed from a
lane set that never existed. Three independent causes, all fixed with the
floor:

1. `.claude/VERSION` was never copied → Validator 16 resolved class
   `UNRESOLVED` and failed closed → emit exit 1, zero lanes.
2. `.claude/fixtures/` was never copied (the runner copied
   `.claude/audit-fixtures/`, a different directory) → Validator 13 failed on
   a missing `validator-13/expected-policies.json` → emit exit 1.
3. fixture-06's synthetic path-scoped rule was undeclared in the temp repo's
   `sync-manifest.yaml` → Validator 15 (tier-completeness) failed closed.

None of the three was detectable while a non-measuring run could still print
`verdict: clean` — which is the argument for the floor, made by the floor.

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
