# Per-Rule Budget Exception Audit Fixtures (loom#1355)

Audit fixtures for the per-lane, per-rule, time-bounded **budget** exception mechanism in `.claude/bin/emit.mjs` — `resolvePerRuleBudgetException`, `effectivePerRuleBlockCeiling`, `parsePerRuleBudgetExceptions`, `assertPerRuleBudgetExceptionsBounded`.

Sibling of `../headroom-floor-exception/`. That stanza governs a lane's **aggregate** emission against `block_cap_bytes`; this one governs a **single rule** against its `per_rule_size_budget_bytes` entry.

## What the mechanism is

`sync-manifest.yaml::cli_variants."context/root.md".codex.per_rule_size_budget_bytes` declares a byte budget per baseline rule; a rule emitting above `budget × (1 + 30%)` hard-fails emission (spec v6 §A.2), so one CRIT rule cannot monopolise the total.

That map is **flat** — keyed by rule filename with no lane dimension. On 2026-07-26 the `rs` lane emitted `security.md` at **9,545 B** against a ceiling of **9,360 B** (budget 7,200 B +30%) — **185 B over** — while `base` and `py` emitted the same rule at **7,775 B**, comfortably inside. The overrun is entirely the `variants/rs/rules/security.md` overlay, which contributes **1,770 B post-abridgement** (9,545 − 7,775): three Rust security MUST sections (constant-time credential comparison, fail-closed defaults, network transport hardening), each with a red-team `Origin:`.

The flat remedies were both wrong:

- **raise the budget** → relaxes `base`/`py` too, permanently and with no expiry, to fix an `rs`-only overrun;
- **trim the overlay** → `abridgeV6` has already reduced it from 4,010 B raw to 1,770 B emitted, so the code fences and Origin lines are gone; 185 B can only come out of a MUST clause or its `**Why:**`.

Leaving it red was not an option either — a permanently-red gate is the ratchet `zero-tolerance.md` Rule 1 forbids, and it BLOCKS `/sync-to-use rs`. So the overrun is **accepted and ENCODED**, lane-scoped and expiring, in `sync-manifest.yaml::cli_variants."context/root.md".per_rule_budget_exceptions`.

## The three properties these fixtures pin

| Property        | Meaning                                                                                                                     | Fixtures                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **NARROW**      | The grant covers only its declared lane, CLIs **and rule**. No sibling lane and no sibling rule inherits it.                 | 03–07, 15, 16, 19, 20         |
| **TEMPORARY**   | Expiry is inclusive; the day after expiry the rule reverts to the flat ceiling and the gate re-reds.                         | 08–11, 33                     |
| **FAIL-CLOSED** | Every "cannot establish the grant applies" path denies it; a malformed or out-of-bounds declaration THROWS, never degrades.  | 12–14, 22, 23, 30–46, 49      |

## Predicates covered (one fixture set per scope-restriction predicate per `cc-artifacts.md` Rule 9)

### `resolvePerRuleBudgetException` — the scope-restriction predicate

| Fixture                                              | Predicate exercised                                                       | Expected       |
| ---------------------------------------------------- | ------------------------------------------------------------------------- | -------------- |
| `fixture-01-declared-lane-cli-rule-in-force`         | Lane + CLI + rule match, date before expiry → the one granted case        | the exception  |
| `fixture-02-second-declared-cli-also-covered`        | One entry naming both CLIs covers both (no per-CLI duplication)           | the exception  |
| `fixture-03-undeclared-lane-not-covered`             | `py` emits the same rule and keeps the flat ceiling — the whole point      | `null`         |
| `fixture-04-prism-lane-not-covered`                  | Same, `prism`                                                             | `null`         |
| `fixture-05-base-lane-not-covered`                   | `lang=null` normalizes to lane `base`, which holds no grant                | `null`         |
| `fixture-06-undeclared-rule-on-declared-lane-…`      | RULE narrowness: a `security.md` grant never relaxes `agents.md` on `rs`   | `null`         |
| `fixture-07-undeclared-cli-not-covered`              | A CLI the entry does not name inherits nothing                            | `null`         |
| `fixture-08-day-before-expiry-still-in-force`        | In force up to expiry                                                     | the exception  |
| `fixture-09-expiry-day-itself-still-in-force-…`      | Expiry is INCLUSIVE (matches `resolveHeadroomException`)                   | the exception  |
| `fixture-10-day-after-expiry-lapses-gate-turns-red`  | **The core property**: a waiver never lapses into permission               | `null`         |
| `fixture-11-far-future-lapses`                       | Same, far past expiry                                                     | `null`         |
| `fixture-12-missing-clock-fails-closed`              | Cannot establish unexpired → does not apply                               | `null`         |
| `fixture-13-malformed-clock-fails-closed`            | Same, unparseable clock                                                   | `null`         |
| `fixture-14-calendar-invalid-clock-fails-closed`     | Same, shaped-but-invalid date (`2026-02-30`)                              | `null`         |
| `fixture-15-empty-corpus-yields-no-grant`            | No declarations → flat ceiling everywhere                                 | `null`         |
| `fixture-16-non-array-corpus-yields-no-grant`        | Defensive: a non-array corpus denies rather than throws at resolve time    | `null`         |

### `effectivePerRuleBlockCeiling` — ceiling composition

| Fixture                                                | Predicate exercised                                                          | Expected |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- | -------- |
| `fixture-17-no-exception-keeps-flat-ceiling`           | No grant → the flat `budget × 1.3` ceiling stands                            | `9360`   |
| `fixture-18-grant-above-flat-ceiling-relaxes`          | The declared grant applies                                                   | `9600`   |
| `fixture-19-grant-below-flat-ceiling-is-ignored-…`     | `Math.max` guarantees a grant can never TIGHTEN a gate                       | `9360`   |
| `fixture-20-grant-equal-to-flat-ceiling-is-a-noop`     | Boundary case                                                                | `9360`   |

### `assertPerRuleBudgetExceptionsBounded` — budget-relative bounds

Split from the parser because the parser is pure over manifest text and does not know the budget map. Called for **every** declared entry on **every** lane's emission, so a malformed waiver surfaces on the first emission of any lane rather than hiding until the lane it names runs.

| Fixture                                          | Predicate exercised                                                                   | Expected  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- | --------- |
| `fixture-21-live-shaped-grant-is-within-bounds`  | The live declaration's shape is admissible                                            | no throw  |
| `fixture-22-unbudgeted-rule-throws`              | A typo'd rule name covers nothing while READING as coverage → reject                  | throws    |
| `fixture-23-grant-above-2x-budget-throws`        | Past 2× the budget itself is wrong; re-measure per spec v6 §A.2, don't waive           | throws    |
| `fixture-24-grant-exactly-at-2x-budget-…`        | Boundary is inclusive                                                                 | no throw  |
| `fixture-25-empty-corpus-is-vacuously-bounded`   | No declarations → nothing to bound                                                    | no throw  |
| `fixture-26-max-multiple-constant-is-…-2x`       | The exported constant matches what this README documents                              | `2`       |

### `parsePerRuleBudgetExceptions` — fail-closed declaration parsing

Fixtures 27–51. A malformed declaration **THROWS**, halting emission, rather than degrading into "no ceiling" — a silent fallback here would hand a permanent waiver to any typo (`zero-tolerance.md` Rule 3).

Covered: well-formed parse (27); absent stanza → no exceptions (28); dedent boundary (29); each of the six required fields missing (30–35); non-integer / fractional / zero / negative ceiling (36–39); rule name that is not a rule filename, incl. a path-separated one (40, 41); calendar-invalid and misshaped expiry (42, 43); unknown CLI and empty `clis` (44, 45); duplicate `(cli, lane, rule)` (46) with the two legitimate non-duplicates that must still parse (47, 48); the bare-`-` list item (49 — the shape whose headroom-sibling equivalent, fixture-36 there, silently parsed to zero entries and made a written waiver evaporate with no error); optional provenance fields resolving to `null` not `NaN` (50); comment-only and blank lines inside an entry (51).

## Hermetic by construction

No fixture reads the live `sync-manifest.yaml`. The live declaration's shape is inlined as `RS_SECURITY` / `WELL_FORMED`, so a manifest edit changes the live gate but never silently rewrites what these predicates are asserted to do. The live declaration is separately pinned by the `#1355` tests in `.claude/test-harness/tests/emit-shape.test.mjs`.

## Running

```bash
node .claude/audit-fixtures/per-rule-budget-exception/run.mjs   # 51/51 fixtures passed
```

Also invoked from `.claude/test-harness/tests/emit-shape.test.mjs` so the corpus cannot rot unnoticed the way a standalone runner can.

## Mutation-verified

The suite was mutation-tested (on `/tmp` copies only — no tracked file mutated) against seven mutants, each killed: expiry check removed (2 fixtures fail), `Math.max`→`Math.min` (2), rule scoping dropped (1), lane scoping dropped (3), 2× bound removed (1), unbudgeted-rule check removed (1), invalid clock failing open (3).
