# Proximity-Band Budget Audit Fixtures

Audit fixtures for `rule-authoring.md` MUST Rule 10 + `emit.mjs::getProximityBandAdvisory` (F23a, journal/0146) AND MUST Rule 11 + `rule-11-helper.mjs::countPriorRule10Invocations` (F23b, journal/0147 + journal/0148 amendment).

## Predicates covered (one fixture per scope-restriction predicate per `cc-artifacts.md` Rule 9)

### Rule 10 (F23a) — proximity-band admission gate

| Fixture                                   | Headroom              | Expected `getProximityBandAdvisory` output                 | Predicate exercised                                                                                   |
| ----------------------------------------- | --------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `fixture-01-above-band-clean.json`        | 20% (above 15% band)  | `null`                                                     | "advisory does NOT fire when headroom outside band"                                                   |
| `fixture-02-within-band-advisory.json`    | 12% (within band)     | advisory object                                            | "advisory fires when headroom within band"                                                            |
| `fixture-03-at-band-edge.json`            | 15% (exact band edge) | `null`                                                     | "band edge is exclusive (≥ band → no advisory)"                                                       |
| `fixture-04-at-floor-edge.json`           | 10% (exact floor)     | advisory object                                            | "floor edge is inclusive (= floor → advisory fires; BLOCK fires only when headroom strictly < floor)" |
| `fixture-05-below-floor.json`             | 8% (BLOCK case)       | `null` (BLOCK path handled by `validateAggregateHeadroom`) | "below floor returns null — block path is structural, not advisory"                                   |
| `fixture-06-misconfig-band-le-floor.json` | any                   | `null`                                                     | "misconfiguration (band ≤ floor) returns null safely"                                                 |
| `fixture-07-zero-blockcap.json`           | any                   | `null`                                                     | "blockCap ≤ 0 returns null safely"                                                                    |
| `fixture-08-negative-blockcap`            | any                   | `null`                                                     | "blockCap < 0 returns null safely (security M4 — malformed-input defense)"                            |
| `fixture-09-nan-emission`                 | NaN                   | null or object (no crash)                                  | "NaN emissionBytes does not crash; current behavior locked (security M4 — fix at F23-followup)"       |
| `fixture-10-output-shape-completeness`    | within band           | advisory object with ALL documented keys                   | "shape contract — regression dropping any field caught here (security M4)"                            |

### Rule 11 (F23b) — 2nd-extraction escalation across (rule, CLI) pairs within 30 days

| Fixture                                       | Predicate exercised                                                                   | Expected `countPriorRule10Invocations` output |
| --------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| `fixture-11-empty-entries-no-fire`            | Clock bootstraps at land-time — empty history → no fire.                              | `{ count: 0, fires: false }`                  |
| `fixture-12-one-match-within-30d-fires`       | 1 prior Rule-10 invocation on same (rule, CLI, lang) lane within 30d → Rule 11 fires. | `{ count: 1, fires: true }`                   |
| `fixture-13-different-lane-no-fire`           | Lane match is structural (rule + cli + lang exact-match); different lane → no fire.   | `{ count: 0, fires: false }`                  |
| `fixture-14-outside-30d-window-no-fire`       | Calendar-day rolling window; entries > 30d ago do NOT count.                          | `{ count: 0, fires: false }`                  |
| `fixture-15-two-matches-corpus-review-signal` | Multiple matches within window → corpus-level review escalation signal (count=2).     | `{ count: 2, fires: true }`                   |

## Running the fixture suite

```bash
node .claude/audit-fixtures/proximity-band-budget/run.mjs
```

Exit 0 = all 15 predicates pass (10 F23a + 5 F23b). Non-zero = regression in `getProximityBandAdvisory` OR `countPriorRule10Invocations` semantics.

## Why these fixtures matter

**Rule 10 (F23a) fixtures.** Per `rule-authoring.md` MUST Rule 10's Trust Posture Wiring detection mechanism, the cc-architect mechanical sweep at `/codify` parses `emit.mjs` dry-run output for `headroom_pct < 15%` rows. The fixtures lock the contract semantics — a regression that silently changes "exclusive band edge" to "inclusive" (or vice versa) would weaken the rule's at-author-time admission gate.

**Rule 11 (F23b) fixtures.** Per Rule 11's TPW detection mechanism, cc-architect's Phase-1 manual sweep parses journal entries into structured Rule-10-invocation records, then calls `countPriorRule10Invocations` to count prior invocations per (rule, CLI, lang) lane within a 30-day rolling window. The fixtures lock the structural contract — lane-match is exact (no regex-over-prose per `probe-driven-verification.md` MUST-1), window is calendar-day rolling, clock bootstraps at land-time. A regression here would either silently miss 2nd-extraction patterns or false-positive on unrelated lanes.

Per `cc-artifacts.md` Rule 9 + Rule 10 positive-allowlist principle: enumerable scope-restriction predicates exercised at landing time.

Origin: journal/0146 § F23a closure (10 F23a fixtures); journal/0147 + journal/0148 § F23b closure (5 F23b fixtures + `rule-11-helper.mjs`).
