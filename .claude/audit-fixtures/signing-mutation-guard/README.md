# signing-mutation-guard audit fixtures

Per `cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4. One
fixture per scope-restriction predicate the hook
(`.claude/hooks/signing-mutation-guard.js`, B3a) relies on.

## PRECONDITION — coordination MUST be ON (read this before triaging a "fail-open")

Every `block` / `halt-and-report` disposition in the table below presumes an
**enrolled repo with coordination ON**. The hook gates its whole substrate
behind `coordination-mode.js::isCoordinationEnabled` (see
`signing-mutation-guard.js`, and the rationale at its degraded-mode branch), so
on a solo / fresh / un-enrolled repo the guard passes through **by design**.

**A coordination-OFF passthrough is CORRECT and is not a regression.** Driving
these fixtures by hand against a coordination-OFF repo reproduces a passthrough
on every `block` row — which looks exactly like a fail-open and is not one.
Enable coordination first, or the fixture's expected disposition is
unreachable and the run says nothing about the guard.

**This is not hypothetical:** a downstream report filed this guard as a
CONFIRMED fail-open on precisely that shape, and it took a separate
investigation to withdraw it. Reproducing a SYMPTOM is not confirming a
DIAGNOSIS (`rules/instrument-discipline.md` MUST-1) — name the falsifying
result, and check the precondition, before concluding the guard is broken.

### Canonical invocation

The canonical runner is **`run.mjs`** in this directory. It builds a temp git
repo per fixture, ESTABLISHES coordination ON explicitly, drives the hook, and
asserts `severity` / `exit_code` / `continue` / `stderr_tag` from each
`expected.txt`. It exits non-zero when any check fails, so it can gate CI, and
is registered in `.claude/test-harness/ci-audit-fixtures.json` (`min_cases: 44`)
— a registry closed in both directions, so an unregistered runner and a
registered-but-missing runner each fail the build.

```bash
node .claude/audit-fixtures/signing-mutation-guard/run.mjs   # 44 checks
echo $?                                                      # 0 = green
```

Each precondition is NAMED in the check text, so a precondition failure can
never be mistaken for a guard failure — the confusion that produced the
withdrawn fail-open report above. `T8` drives the same fixtures at a
coordination-OFF repo as a NEGATIVE CONTROL, so the ON-repo greens are
demonstrably attributable to the precondition rather than to luck.

To drive the hook by hand you must reproduce the precondition yourself (a temp
repo with `.claude/learning/coordination-mode.json` → `{"enabled":true}`, passed
as `cwd`). Prefer `run.mjs`, which does this for you: on an ENROLLED repo the
Bash layer refuses a direct write to any `coordination-mode.json` path, so the
by-hand recipe is awkward to execute here and is deliberately not reproduced as
a copy-paste block that has not been run on this repo.

## Predicates covered

| Fixture                            | Predicate exercised                                                     | Expected disposition |
| ---------------------------------- | ----------------------------------------------------------------------- | -------------------- |
| `01-halt-sibling-porcelain/`       | Sibling worktree porcelain shows EXACT target path uncommitted-modified | halt-and-report      |
| `02-pass-no-sibling/`              | No sibling worktrees → empty match-set                                  | silent passthrough   |
| `03-block-degraded-mode-mutation/` | No signing key + Edit on tracked path                                   | block                |
| `04-pass-degraded-mode-read/`      | No signing key + Read on tracked path (non-mutating)                    | silent passthrough   |
| `05-pass-signing-key-present/`     | Signing key resolved + no sibling contention + Edit                     | silent passthrough   |
| `06-block-git-commit-degraded/`    | No signing key + `git commit` Bash (git-mut command)                    | block                |

## Why these and only these

The hook's scope-restriction predicates are (per `cc-artifacts.md`
Rule 9 + architecture v11 §2.3 + §4.3 + R4-S-02 + R5-S-03):

1. **Operation classification** (`classifyOperation`): Edit | Write |
   Bash-with-mutation. Fixtures 04 (Read) and 02 (Edit + no sibling)
   cover the non-mutating + non-contended branches.
2. **§4.2 sibling-worktree porcelain predicate**
   (`detectSiblingContention` → `lib/sibling-porcelain.js`):
   grounded in the process-local structural primitive (`git status
--porcelain` against enumerated sibling worktrees), so
   `hook-output-discipline.md` MUST-2 PERMITS `severity: "block"` —
   it does NOT require it, and since loom#1323 this branch emits
   **halt-and-report**: sibling worktrees have physically separate
   working trees, so the write cannot clobber the sibling's bytes and
   the only real collision is a recoverable 3-way merge conflict at
   merge time. Fixture 01 covers the positive via
   `COC_PORCELAIN_OVERRIDE`; the override-precedence contract matches
   B1's adjacency-leasecheck convention (whose §4.2 branch was
   downgraded in the same change, so BOTH guards on the shared
   `Edit|Write|NotebookEdit` matcher now surface rather than deny —
   the enforcement-surface parity that makes the downgrade real).
3. **Degraded-mode working-tree-mutation predicate**
   (`wouldMutateWorkingTree`): the ONLY remaining `severity: "block"`
   branch in this hook, grounded in `git ls-files --error-unmatch
<path>` structural signal. Per R5-S-03, degraded mode is a working-
   tree-mutation predicate, NOT an Edit/Write tool-name allowlist —
   fixtures 03 (Edit on tracked path) and 06 (`git commit` Bash
   command) cover both the Edit-form and the git-mut-form of the
   mutation predicate. It STAYS `block` deliberately: an unsigned
   mutation lands with no attributable, chain-verifiable record and
   nothing recovers the missing signature after the fact (the
   IRRECOVERABLE class). Fixtures 01 vs 03/06 exist as a matched pair
   precisely to lock that asymmetry against a future "consistency
   fix" that downgrades 03/06 to match 01.
4. **Signing-key resolution** (operator-id 3-tier + override env
   vars): fixture 05 covers the happy-path where the key is
   present.

## Runner discrimination (instrument-discipline.md MUST-2)

A green runner is evidence ONLY if it would go RED in the behaviour's absence.
**Measured at loom 2026-08-16 against the shipped guard** — these are this
repo's own figures, not numbers carried over with the runner. Each mutant was a
`cp` of the guard carrying a `process.stderr.write("[MUTANT-Mx-EXECUTED]")`
marker at the mutated site, placed inside `.claude/hooks/` so its
`__dirname`-relative requires resolve, driven via `HOOK=<mutant> node run.mjs`
and deleted afterwards; the guard itself was never edited in place
(`git status --porcelain .claude/hooks/` empty after every run).

| #   | Mutation                                                                          | Reached code?   | Result                        | Checks reddened                                                                         |
| --- | --------------------------------------------------------------------------------- | --------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| M1  | degraded-mode branch `block` → `halt-and-report` (the "consistency fix" warned of) | yes (marker ×2) | 32 pass / **10 fail**, exit 1 | 03 + 06 exit/continue/tag, T7 both `STAYS block` rows, T7 both `does NOT emit [H-A-R]` rows |
| M2  | §4.2 sibling-porcelain `halt-and-report` → `block` (asymmetry normalized the other way) | yes (marker ×1) | 37 pass / **5 fail**, exit 1  | 01 exit/continue/tag, T7 `is halt-and-report`, T7 `does NOT emit [BLOCK]`               |
| M3  | `isCoordinationEnabled` opt-in gate deleted (always ON)                           | yes (marker ×5) | 38 pass / **6 fail**, exit 1  | T8 passthrough rows for 01 + 03 + 06, T8 discrimination rows for 01 + 03 + 06            |
| M4  | opt-in gate INVERTED (passthrough when ON)                                        | yes (marker ×5) | 27 pass / **15 fail**, exit 1 | all ON-repo halt/block rows + T7 + T8                                                    |
| M5  | `wouldMutateWorkingTree` returns false for `git-mut`                              | yes (marker ×2) | 37 pass / **5 fail**, exit 1  | 06 exit/continue/tag/guard-named + T7 `STAYS block`                                      |

**M1 and M2 together are the asymmetry lock.** M1 reds ONLY the 03/06 rows; M2
reds ONLY the 01 rows. A change that normalized both branches to one severity
would trip both sets, so the matched pair holds the distinction from either side.

**M3's own figures ARE the discrimination evidence for the T8 tag leg.** Before
2026-08-17 the T8 rows asserted only `exit === 0 && continue === true` and never
read stderr, and M3 reddened **2** rows — never 01. That was not luck: at
coordination-ON with the gate deleted, 01 returns `exit=0 continue=true
tag=[HALT-AND-REPORT]`, which is byte-identical on both asserted fields to the
silent pass it must be separated from, so the row returned the same verdict
whether the guard passed through or emitted the full §4.2 finding — on the
multi-operator SIGNING substrate. Adding the absent-severity-tag leg, plus
replacing a summary row that asserted the literal `true` (falsifier field: `"n/a"`)
with three rows that DRIVE the same fixtures at both repos and require the
dispositions to DIFFER, moved M3 from 2 reddened to **6**, and 01 now reds on
both legs. The 2 → 6 delta is the measurement, not the assertion.

**A non-reddening mutation has TWO explanations** (vacuous check OR inert
mutation), so the marker column is load-bearing, not decoration — and the
INERT case is not hypothetical here. The first attempt at M1 placed the mutant
OUTSIDE the repo; it crashed on `require(path.join(__dirname, "lib", …))` before
executing any branch, printed NO marker, and still reddened 24 checks. Read as a
tally alone that looks like strong discrimination; it was evidence of nothing.
That result was DISCARDED, not recorded. Any future re-run MUST gate each mutant
on `node --check`, keep the marker OUTSIDE the `emit({…})` object literal (a
marker inside it is a `SyntaxError`), and confirm a NON-ZERO marker count before
reading its tally.
