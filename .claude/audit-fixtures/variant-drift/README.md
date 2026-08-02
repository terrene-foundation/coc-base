# `variant-drift` audit fixtures (loom#1416)

Fixtures for `.claude/bin/lib/variant-drift.mjs::classifyVariantDrift`, the
canon↔variant drift classifier. Driven by
`tests/integration/multi-operator/variant-drift.test.js`.

Each `fixture-*/` holds:

- `input.json` — a synthetic tree state (`variantFiles`, `canonFiles`,
  `variants:`, `variant_only:`, optional `mtimes`/`staleDays`)
- `expected.json` — the hand-authored verdict: `exit_code`, `defect_count`,
  `counts` by code, and where it matters `expected_paths`

The classifier is pure — no filesystem, no git, no manifest read — so every
fixture is hermetic and hand-checkable. The I/O half (`walkVariants`,
`walkCanon`, `collectGitDates`) is exercised against the real tree by the
non-vacuity mutation test, not by these fixtures.

## Why these particular cases

| fixture | code | what it locks |
| --- | --- | --- |
| `fixture-clean` | — | all three reachability lanes resolve; zero defects |
| `fixture-obsolete-canon-deleted` | A | **anti-vacuity anchor — MUST fire** |
| `fixture-variant-only-declared` | B | A/B discrimination: identical tree, one declaration |
| `fixture-phantom-null` | E5 | `manifest-null` overlay sitting at the mirror path |
| `fixture-phantom-rename-shadow` | E5 | rename redirect shadowing a mirror-path file |
| `fixture-manifest-drift-e1-e2-e3` | E1/E2/E3 | declared-but-absent, declared-for-absent-canon, dangling `variant_only` |
| `fixture-double-declared-e4` | E4 | one file claimed by both lanes |
| `fixture-stale-heuristic` | C | threshold arithmetic; C never changes exit code |
| `fixture-non-composed-undeclared` | A | **regression lock** on a real false positive (see below) |
| `fixture-anti-vacuity-no-variants` | — | empty variant set → exit 2, never 0 |
| `fixture-anti-vacuity-no-canon` | — | empty canon set → exit 2, never mass-A |

## The two load-bearing pairs

**`fixture-obsolete-canon-deleted` + `fixture-variant-only-declared`** are
byte-identical trees. The only difference is one `variant_only:` declaration,
and it flips the verdict from A to B. This pair is the evidence that category B
is *declared*, never *guessed* — the property #1416 requires, because without it
A and B are indistinguishable and the whole validator is useless.

**`fixture-non-composed-undeclared`** locks a false positive this validator
actually produced. Its first run against the real tree reported
`variants/py/hooks/validate-prod-deploy.js` as "declared for a canon that does
not exist". The canon file existed; the canon *walk* only covered composed
categories, so `hooks/` was invisible to it. Hand-verification caught it before
the number was quoted. The fixture pins the distinction the bug erased: canon
existence spans all categories, path-mirror reachability spans only the composed
ones.

## Anti-vacuity

Three independent guards, because a validator reporting zero findings because it
scanned nothing is the exact failure mode this issue exists to prevent:

1. `VacuousScanError` on an empty variant set **or** an empty canon set (exit 2).
2. A complete-accounting invariant — the per-lane buckets must sum to the number
   of files scanned, or the classifier throws. A file cannot fall through
   silently.
3. `fixture-obsolete-canon-deleted` carries `"must_fire": true`; the test asserts
   it produces findings, so an inert classifier fails the suite rather than
   passing it clean.
