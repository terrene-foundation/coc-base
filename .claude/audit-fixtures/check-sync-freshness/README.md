# check-sync-freshness — Audit Fixtures

`.claude/bin/check-sync-freshness.mjs` is the pre-sync remote-freshness validator (F62, journal/0163 + journal/0164). Its scope-restriction predicates are exercised by **in-tree unit tests** at `.claude/bin/check-sync-freshness.test.mjs` rather than disk-committed fixtures.

## Why tests, not fixtures-on-disk

Per `cc-artifacts.md` Rule 9, mechanical audit tools MUST ship with at least one committed test fixture per scope-restriction predicate. The intent of Rule 9 is captured at its origin: _"Mechanical audit tools have non-obvious scope-restriction predicates…that future modifications can silently weaken. Committed fixtures make those regressions mechanically detectable."_

`check-sync-freshness.mjs`'s scope-restriction predicates require **live git repositories** to exercise (`git rev-parse refs/heads/<branch>`, `git ls-remote origin <branch>`). Static text fixtures cannot reproduce this — a disk-committed fixture would need a runtime driver that synthesizes git repos before each invocation, which is exactly what `check-sync-freshness.test.mjs` already does via `mkdtempSync` + `execFileSync("git", ...)`.

The 7 unit tests at `check-sync-freshness.test.mjs` cover:

| #   | Scope-restriction predicate exercised                              | Test name                                                                    |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1   | local == remote → PASS                                             | "PASS path — local matches remote"                                           |
| 2   | local lags remote by 1 → FAIL                                      | "FAIL path — local lags origin by 1 commit (teammate's commit)"              |
| 3   | local lags remote by N → FAIL                                      | "FAIL path — local lags origin by 3 commits"                                 |
| 4   | local has no branch ref → FAIL with typo-vs-corruption distinction | "FAIL path — local has no branch ref (typo'd integration branch)"            |
| 5   | CLI exit-code contract (PASS)                                      | "CLI integration — exit 0 on PASS via --loom against fresh repo"             |
| 6   | CLI exit-code contract (no args)                                   | "CLI integration — exit 2 when no probe target specified"                    |
| 7   | CLI exit-code contract (unknown arg)                               | "CLI integration — exit 2 on unknown arg"                                    |
| 8   | CLI FAIL output contract via spawnSync against synthetic repo      | "CLI integration — exit 1 + FAIL output shape on stale-local synthetic repo" |

Run: `node --test .claude/bin/check-sync-freshness.test.mjs`

A future weakening of any predicate produces a failed test on every CI invocation — the structural-regression-detection mechanism Rule 9 mandates. The test file IS the fixture surface, materialized at runtime rather than disk.

## Sibling validator audit pattern

For comparison, `audit-fixtures/validator-17-roster-schema-coupling/` (F67) committed disk-fixtures as `.scenario.txt` files because V17 reads a static YAML file's contents — static text IS the input. `check-sync-freshness` reads git refs, so static text cannot serve as input; tests are the canonical mechanism.

Origin: F62 cc-architect MED-1 (journal/0164) — discharges `cc-artifacts.md` Rule 9 sibling-convention obligation via this cross-reference rather than via disk fixtures that cannot exercise the predicate.
