# sibling-porcelain-scaling

Regression lock for **loom#1902** — `.claude/hooks/lib/sibling-porcelain.js::detectSiblingMutation`.

| file            | role                                                                        | in CI |
| --------------- | --------------------------------------------------------------------------- | ----- |
| `run.mjs`       | the registered suite (26 cases)                                             | yes   |
| `mutations.mjs` | proves the suite's green is worth something (7 mutations, marker-verified)   | no    |
| `measure.mjs`   | re-derives the MAGNITUDE on the real forest (a synthetic tree cannot show it)| no    |

## The defect

`signing-mutation-guard.js` is registered in `.claude/settings.json` with `"timeout": 5`
(seconds). `detectSiblingMutation` ran a **full** `git status --porcelain` per sibling
worktree, and `enumerateSiblingWorktrees` ran a `git rev-parse --git-common-dir` per
candidate on top — **2N+3 spawns**, the dominant one walking a whole checkout to answer a
question about **one** path. The forest is an operational quantity that grows with ordinary
parallel work, so the constant factor of that O(N) is a **safety** property: once
`N × per-sibling cost` crosses the budget the harness kills the hook mid-scan and the guard
stops guarding.

**Measured on a 52-sibling forest, before the fix.** Re-derive with `measure.mjs` rather
than citing these.

| instrument                                                    | value                                        |
| ------------------------------------------------------------- | -------------------------------------------- |
| `detectSiblingMutation` spawns                                 | 107 (52 status, 53 rev-parse, 2 setup)       |
| spawnSync share of wall time                                   | 5411 ms of 5416 ms — **99.9 %**              |
| `status --porcelain` alone                                     | 52 spawns, 4833 ms (89 %)                    |
| guard end-to-end, 7 runs                                       | min 4921 / med **5246** / max 5943 ms        |
| `posture-gate.js` control, same input, same run                | min 86 / med 91 / max 102 ms                 |

The control is what makes the guard figures readable: the cost is specific to this path,
not ambient load.

**The guard's own fail-open does not rescue it.** `TIMEOUT_MS = 5000` is armed as a
`setTimeout`, but the scan is synchronous `spawnSync`, so the event loop never turns and
the timer is **starved**. Bipolar, one marker, one instrument:

| pole                                    | wall    | exit | marker hits |
| --------------------------------------- | ------- | ---- | ----------- |
| B — event loop free (`await` inserted)   | 5046 ms | 1    | 1 (`at 5001ms`) |
| A — real path (synchronous scan)         | 5131 ms | 0    | **0**       |

Pole A passed its 5000 ms deadline by 131 ms and the fallback never ran. What actually
lands is the harness kill, and it lands with no verdict delivered.

## The fix — two structural properties, no budget raised

1. **Narrow the query.** `--no-optional-locks status --porcelain -- :(literal)<target>`.
   `:(literal)` is load-bearing: git's default pathspec is a wildmatch.
   `--no-optional-locks` is not a speed flag — without it `status` **rewrites another
   operator's index** and contends for their `index.lock`. Same rationale and same flag as
   `bin/worktree-triage.mjs::gitOk`.
2. **Defer the containment spawn** to candidates that produced a match or were unreadable.
   `2N+3` → `N+3`. The equivalence table is at the call site; the one difference is
   diagnostic (an `[ADVISORY] skipping` line no longer prints for a non-contained candidate
   that produced no signal).

**Measured after, same instruments.** Guard end-to-end min 713 / med **748** / max 802 ms
(control 83–87 ms, unchanged — so this is not ambient drift). 107 → 56 spawns. Same verdict
on the same input. Per-sibling query 82.3 → 16.6 ms (4.9×) on the real forest. Budget
headroom 6.7×; the crossing point moves from N ≈ 47 to N ≈ 380.

`O(N)` is **inherent** — git exposes no cross-worktree status. This fixes the constant.

### The bipolar end-to-end, with the clean pole ESTABLISHED

A first attempt used `CLAUDE.md` as the "uncontended" pole and it returned HALT-AND-REPORT.
That was **not** a defect in the fix and **not** a false positive: `CLAUDE.md` is genuinely
dirty in a stale sibling, and the **pre-fix algorithm run over the same live forest names the
same single sibling**. An unestablished pole is UNANSWERED, never a pass — so the pole was
re-picked against a path measured clean by BOTH algorithms.

| target                                 | legacy full-status | shipped narrow | agree |
| -------------------------------------- | ------------------ | -------------- | ----- |
| `CLAUDE.md`                            | 1 (`ig-wt-1414-…`) | 1 (same)       | yes   |
| `.claude/hooks/lib/sibling-porcelain.js` | 1 (`ig-wt-1414-…`) | 1 (same)       | yes   |
| `AGENTS.md`                            | 1 (`ig-wt-1414-…`) | 1 (same)       | yes   |
| `README.md`                            | **0**              | **0**          | yes   |

Guard end-to-end on a 51-sibling forest, 5 runs each:

| pole                                       | med    | max     | verdict                            |
| ------------------------------------------ | ------ | ------- | ---------------------------------- |
| A — contended (`sibling-porcelain.js`)      | 855 ms | 1712 ms | HALT-AND-REPORT, contention surfaced |
| B — uncontended (`README.md`, established)  | 763 ms | 783 ms  | PASSTHROUGH, bare `{"continue":true}` |

## What each scaling case can and cannot see

An absolute wall-clock upper bound is BLOCKED here (`rules/testing.md` § "Never Assert An
UPPER Bound On Real Elapsed Time"). Three instruments, each with a named falsifying result:

| case                                        | instrument                                     | falsifying result                     |
| ------------------------------------------- | ---------------------------------------------- | ------------------------------------- |
| `SCALING/marginal-spawns-…-is-ONE`          | spawn-count ratio `(s₈₀ − s₁)/79`, deterministic | `2` — eager containment is back        |
| `SCALING/per-sibling-query-is-NARROW`       | the argv actually issued, deterministic        | a bare `["status","--porcelain"]`      |
| `SCALING/per-sibling-cost-in-SPAWN-FLOORS`  | ratio to a same-run bare-git-spawn median      | `> 3.0` floors per sibling             |
| `SCALING/forest-scan-HANG-STOP`             | 60 s, an order of magnitude from observed      | a genuine hang only                    |

**A synthetic timing case was written, measured, and REMOVED.** A full-vs-narrow ratio on a
2500-file temp tree read **6.65 on the first (cold) trial and 1.10–1.36 on the next eight** —
it was measuring git's warm stat cache, not query breadth, and would have flaked against any
floor that could also discriminate. The magnitude lives in `measure.mjs`, on a real forest,
where the separation is unambiguous. The *fence* is the deterministic argv case.

The per-sibling-cost case is a **coarse** budget fence, not the regression fence: measured
across 5 trials it sat at 1.19–1.49 floors against a cap of 3.0, so it cannot flake — and by
the same token it only catches a gross regression.

## Mutation evidence

`node .claude/audit-fixtures/sibling-porcelain-scaling/mutations.mjs` → **7/7**. Each
mutation plants a stderr marker at the mutated line; a hit counts only on a line that is
*nothing but* the marker, and a parse failure is reported separately.

| mutation                     | hits | cases reddened                                                        |
| ---------------------------- | ---- | --------------------------------------------------------------------- |
| M1 wide query                | 29   | `SCALING/per-sibling-query-is-NARROW`, `equivalence/untracked-dir-child…` |
| M2 eager containment         | 25   | `SCALING/marginal-spawns-…-is-ONE`                                     |
| M3 collapse INDETERMINATE    | 1    | `INV1/not-a-repo-is-INDETERMINATE`                                     |
| M4 collapse unreadable tail  | 25   | `INV1/unreadable-CONTAINED-sibling-is-INDETERMINATE`                   |
| M5 drop `:(literal)`         | 29   | `SCALING/per-sibling-query-is-NARROW`                                  |
| M6 drop the `break`          | 23   | `INV2/…-no-duplicate-worktrees`, `INV2/…-break-PIN`                    |
| M7 drop the exact compare    | 20   | `glob/EXACT-compare-is-the-decider-PIN`, `equivalence/legacy-…`         |
| M8 inflate per-sibling cost  | 29   | `SCALING/per-sibling-cost-in-SPAWN-FLOORS`, `…-is-ONE`, `…-is-NARROW`   |

**M8 exists only as the timing pole's positive control.** A ratio nobody has SEEN emit its
falsifying result is not yet evidence, however sound its arithmetic
(`instrument-discipline.md` MUST-3(a)). M2 reds the spawn-COUNT ratio but leaves the
spawn-FLOOR ratio green, so M8 adds three extra whole-tree scans per sibling and the floor
ratio goes red. Without it the floor case would have shipped never demonstrated able to fail.

Two findings came out of running this rather than reasoning about it, and both changed the
suite:

- **M5 does NOT red the glob verdict case.** Dropping `:(literal)` widens the query to 5
  rows, and the retained `p === targetRelPath` compare rejects every one — so the verdict is
  unchanged. The case was renamed `glob/wildcard-target-cannot-FALSE-POSITIVE` and now says
  in its own body that it fences the exact compare, not the magic. Left unrenamed it would
  have been a case whose name claimed a discrimination it did not have.
- **M7 does NOT red that same case, or the prefix case.** With the compare gone,
  `:(literal)src/*.js` still returns zero rows. The two layers are **independently
  sufficient** for those inputs, so neither can be read as fencing the other.

The harness itself was corrected twice, on its own measurements: it once scored
`marker_hits=1` for a mutant that never parsed (the marker string appeared in node's echo of
the offending source line), and it once used one reach driver against a valid repo for every
mutation, then read its 0 hits for M3 as "the line never runs" — that driver never took the
enumeration-failure branch, so it could not have produced a hit either way.

## Invariants preserved

1. **`ok:false` INDETERMINATE propagates** — `INV1/not-a-repo`, `INV1/bad-arguments`,
   `INV1/unreadable-CONTAINED-sibling`, `INV1/a-MATCH-outranks-an-unreadable-sibling`.
   Fenced by M3 and M4.
2. **One match per sibling** — `INV2/…-no-duplicate-worktrees` plus a source PIN on the
   `break`. Fenced by M6.

Plus `equivalence/legacy-full-status-vs-narrow-query`, which runs the **pre-fix algorithm**
and the shipped one over the same fixture and compares verdicts across ten targets. The one
deliberate difference is asserted in its own case: a file inside an untracked **directory**.
A full-tree status under `-unormal` collapses it to `?? untrackdir/`, which never
exact-matches the file — the legacy algorithm **missed** it. The narrow query returns
`?? untrackdir/deep.js`, so it now matches. That is a false negative removed, in the
fail-closed direction for a contention guard.
