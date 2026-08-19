# unadjudicated-escalation — fixture set

Backs `.claude/rules/sweep-completeness.md` MUST-4 and its detector
`.claude/bin/unadjudicated-escalation.mjs` (loom#1722). Run:

```bash
node .claude/audit-fixtures/unadjudicated-escalation/run.mjs   # prints its own N/N total
```

Registered in `.claude/test-harness/ci-audit-fixtures.json` (`min_cases: 22`, taken
from an actual run) and executed by `.claude/bin/run-audit-fixtures.mjs`. That
number is a FLOOR, not the current total — the suite runs above it today, which
is legal and is why the comment above no longer predicts a count. The floor
itself is coupled to the registry by
`.claude/test-harness/tests/audit-fixture-prose-count-coupling.test.mjs`.

## Why the set is bipolar, and what each pole is for

A detector shown only to FIRE proves it can say "escalate" and nothing else. Nine
cases here are runs that MUST NOT escalate:

| case                                  | what it protects                                                |
| ------------------------------------- | --------------------------------------------------------------- |
| `streak-1` / `streak-2`               | the honest first emissions MUST-2 mandates are not violations   |
| `streak-broken-by-newest-clean-run`   | the streak counts BACK from the newest run, so a fix clears it  |
| `streak-broken-mid-sequence`          | an intervening clean run resets the CONSECUTIVE count           |
| `live-disposition`                    | a complete, unexpired disposition suppresses                    |
| `prose-about-a-verdict`               | discussing the token is not emitting it                         |
| `fenced-example-row`                  | a QUOTED example row does not manufacture a streak              |
| `non-sweep-report-in-04-validate`     | a `redteam-*.md` sibling is not a `/sweep` run                  |
| `zero-reports`                        | an empty scan reports `runs_scanned=0`, never a clean bill      |

Nine are runs that MUST escalate — `streak-3` (the threshold), `streak-5` (the
loom#1722 shape), `expired-disposition`, two malformed-sentinel cases, a
wrong-key disposition, `two-keys-one-at-threshold` (exactly one alarm, so the
detector is not a blanket one), root-level `SWEEP-*.md` discovery, and the
same-date `b`-suffix run.

Four more assert instrument integrity: undated reports are surfaced rather than
dropped, `--threshold` does not exist, the binary's own self-check refuses to
report when the matcher is broken, and the binary runs against THIS checkout.

## The lever

Every case builds a REAL temp repository with real
`workspaces/<ws>/04-validate/sweep-<date>.md` files and invokes the REAL binary
as a subprocess, reading its exit code and `--json`. Nothing is mocked. The two
poles differ ONLY in the committed report sequence — same binary, same argv — so
the pair measures what MUST-4 is about and not a flag.

Dates are PINNED via `--today`; no case reads the wall clock.

## Mutations, measured

- `const VERDICT_ALT = UNADJUDICATED_VERDICTS.join("|")` → a literal that matches
  nothing: the binary's self-check fails and it exits 2 (asserted by
  `self-check/refuses-to-report-when-the-matcher-cannot-discriminate`, which
  first asserts the replacement LANDED, so an inert mutation cannot be read as a
  verdict — `instrument-discipline.md` MUST-2(b)).
- Requiring a `[Sweep N]` bracket for a hit (the matcher's first cut): matched 3
  of the 5 real reports carrying the verdict and reported a streak of 0. That
  measurement is why the grammar accepts a backticked VALUE, and why the four
  real row shapes are pinned as positive controls in the binary.
- Comparing entry-point paths lexically instead of through `realpathSync`: the
  binary silently declines to run from a macOS temp dir (`/var` vs `/private/var`)
  and exits 0 having executed nothing — a false green caught by the same case.
