# `coc-manifest-integrity` — class-derived pin sets (loom#1393)

Committed fixtures for the scope-restriction predicate that decides the backing
sets of integrity checks **(c)** (must-register artifacts) and **(i)** (pinned
structural entries) in `.claude/bin/coc-manifest-integrity.mjs`.

Run: `node .claude/audit-fixtures/coc-manifest-integrity-class-derived/run.mjs`
(exit 0 = every case matched; non-zero = mismatch — the Rule 9 runner contract).

## What is under test

`coc-manifest-integrity.mjs` is `BUILD_ONLY_ALWAYS_INCLUDE`
(`sync-tier-aware.mjs:602`), so it ships **verbatim** to every `coc-build`
consumer. Before loom#1393 both sets were a flat `[]` — correct at loom, and
shipped unchanged to BUILD, where both checks iterated an empty list, could
never fire, and the harness still reported green. For an assertion an empty set
is not a neutral default; it is a **vacuous pass**.

The fix derives both sets from `.claude/VERSION::type` through the one shared
predicate (`lib/manifest-source.mjs::readRepoClass`), splitting by who owns the
data:

| class | where the pin set comes from |
| ----- | ---------------------------- |
| `coc-source` (loom) | loom's own set, declared **in code** (`IN_CODE_PIN_SETS`) |
| every other class | that repo's **own** eval-manifest (`_must_register_artifacts`, `_required_structural_entries`) |
| unresolvable | **fail closed** — never pick a set |

**Undeclared is not empty.** A repo routed to the manifest-declared branch that
declares neither pins nor an explicit `_declared_no_pins` is UNCONFIGURED and
hard-fails, the same ratchet check (k) already applies via `_declared_empty`.

## Case matrix

The rows below are the NUMBERED levers, one per predicate. They are not the
suite total: `05b-coc-build-undeclared-warn-is-actionable` rides case 05 and has
no row of its own, so the runner emits more cases than this table has rows. The
total is declared as `min_cases` in `.claude/test-harness/ci-audit-fixtures.json`
and self-reported by the runner; it is not restated here, because the heading
that used to carry it said `10 cases` against a suite emitting 11 (loom#1793).

| # | case | polarity | predicate exercised |
| - | ---- | -------- | ------------------- |
| 01 | no `.claude/VERSION` | flag | class UNRESOLVED → fail closed |
| 02 | out-of-vocabulary class value | flag | positive allowlist, not a denylist |
| 03 | `coc-source`, in-code set | clean | the in-code branch governs |
| 04 | `coc-source` + a stray manifest pin | flag | a would-be-ignored declaration is surfaced |
| 05 | `coc-build`, nothing declared | flag | **the loom#1393 regression itself** |
| 06 | `coc-build` + valid `_declared_no_pins` | clean | the legible way to be green |
| 07 | `coc-build` + expired declaration | flag | no permanent blanket |
| 08 | `coc-build` + intact pin | clean | anti-vacuity control for 09/10 |
| 09 | `coc-build`, pinned entry deleted | flag | the (i) disarm, now reachable on BUILD |
| 10 | `coc-build`, `fixturesDir` repointed | flag | the (h)-sibling decoy lever |

Both polarities are mandatory and the runner **enforces** it: a set with zero
flag cases or zero clean cases exits non-zero, so a fixture file that silently
stopped enumerating cases cannot print the same "all matched" line as a real
pass.

Cases 03/06/08 are the anti-vacuity **controls**. They pass whether or not the
fix is present — that is their job: they prove the seven flag cases fail because
of the disarm under test, not because a fixture of that shape can never pass.

## Falsification receipt

Reverting `resolvePinSets` to the pre-#1393 behaviour (return both sets empty,
class-blind) makes all **7 flag cases fail** and the runner exit 1, while the 3
controls stay green. Case 09 is the sharpest: under the mutant its only error is
check (f)'s orphan-scanner report — which confirms (f) is **not** a substitute
for the (i) pin, since (f) is blind to a deletion whose scanner file also goes.

## Layout note

Inline-case `run.mjs`, the variant `cc-artifacts.md` Rule 9 permits alongside the
sidecar layout (see `.claude/audit-fixtures/codex-dispatcher/README.md`
§ "Fixture layout"). Chosen because each case is a whole synthetic **repo tree**
— `.claude/VERSION` + eval-manifest + on-disk scanner and fixture files — and a
sidecar pair per tree would scatter one logical case across a directory.
