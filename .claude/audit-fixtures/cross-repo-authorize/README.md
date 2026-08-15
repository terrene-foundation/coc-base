# `cross-repo-authorize` audit fixtures

Backs `.claude/bin/cross-repo-authorize.mjs` (the User-Authorized Exception ceremony
tool) and `.claude/commands/cross-repo-authorize.md` (its ceremony doc).

```
node .claude/audit-fixtures/cross-repo-authorize/run.mjs     # exit 0 = all cases held
```

Registered in `.claude/test-harness/ci-audit-fixtures.json` as
`cross-repo-authorize` / `mode: run` / `min_cases: 26` — the count taken from an
ACTUAL run, not from reading the source. The registry is closed in both
directions (`run-audit-fixtures.mjs` § REGISTRY COMPLETENESS), so an unregistered
runner here fails the build.

## Why this runner drives the REAL guard

The load-bearing cases import
`violation-patterns.js::hasCrossRepoAuthorizationReceipt` and drive it against a
real temp git repo. They do **not** grep the tool's source for `wx` / `sha256`:
that would pass on a tool which imported the digest and never used it. The
question each case asks is the one that matters — _is this cross-repo action
still authorized?_ — so a regression fails by printing
`write-authorized after read receipt: false`.

`control-harness-writes-and-guard-reads` is the positive control
(`instrument-discipline.md` MUST-3(a)). If it fails, every result below it is
uninterpretable and the runner says so: a later "no receipt" would be
indistinguishable from a harness that cannot write one. It caught a real breakage
during authoring — a backtick in an edit terminated the tool's body template
literal, and the control reported the SyntaxError instead of the suite quietly
reporting 13 unrelated failures.

## Named regression cases (`coc-artifact-eval-coverage.md` MUST-2)

Case names that are finding ids are the regression locks for those findings.

| Case                            | Finding | Mutation that REDS it (verified)                      |
| ------------------------------- | ------- | ----------------------------------------------------- |
| `RS-71-tier-defeat-measured`    | RS-71   | pre-fix tool (no digest, no `wx`): `true` → `false`   |
| `RS-71-mode-in-filename-digest` | RS-71   | `tripleDigest(target, action, mode)` → `…, "MUTANT")` |
| `RS-71-no-silent-clobber`       | RS-71   | drop `flag: "wx"` from `writeReceiptNoClobber`        |
| `RS-71-truncation-collision`    | RS-71   | pre-fix 48-char slug filename                         |
| `PY-3-C2-*` (7 cases)           | PY-3-C2 | pre-fix mtime claims + the two stale line anchors     |

### The mutation that did NOT red, and why that mattered

Replacing `mode` with a constant in the digest was **reached** (verified by
grepping the mutated line) yet left the suite green, because the `wx` no-clobber
retry independently kept both receipts by writing a `-2` sibling. Per
`instrument-discipline.md` MUST-2(b) that leaves two live hypotheses — vacuous
test, or inert mutation — and it was neither: the mutation was real, its effect
was **masked by the second mechanism**.

`RS-71-mode-in-filename-digest` was therefore strengthened from "two files exist"
to "two files with DISTINCT base names, neither the other's `-N` sibling." It
then redded under the same mutation. A case that merely counted files would have
reported the digest property as covered while only the retry was holding it up.

## Disclosure

Every token is synthetic: target `example-org/example-repo`, requester
`fixture-operator`. No real operator `display_id`, org slug, home path, or repo
name appears here. Receipts are written into `mkdtemp` repos and removed; the
runner never touches the live `.claude/cross-repo-authz/` store.
