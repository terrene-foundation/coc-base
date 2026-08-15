# classifyCrossRepoIntent audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Each fixture pins one intent-classification predicate `classifyCrossRepoIntent(command)` relies on for the tier-reads discipline (D — `journal/0488`): a user-directed READ satisfies `repo-scope-discipline.md` § User-Authorized Exception with condition 4 downgraded to a one-line affordance receipt; a WRITE keeps all five conditions. Inputs are Bash command strings; expected outputs are the string `"read"` or `"write"` returned by `classifyCrossRepoIntent(input)`.

| Fixture                    | Expects   | Predicate locked                                                                                                                    |
| -------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `read-issue-list.txt`      | `"read"`  | a `gh issue list` (view/list/status/diff/checks) verb → READ tier                                                                  |
| `read-api-get.txt`         | `"read"`  | a bare `gh api <path>` with NO mutating method/field → GET → READ tier (the verify-resource-existence common case)                  |
| `write-issue-create.txt`   | `"write"` | a `gh issue create` (create/edit/close/merge/…) verb → WRITE tier (all five conditions)                                            |
| `write-api-mutate.txt`     | `"write"` | a `gh api -X POST … -f …` mutating call — matched by `GH_API_MUTATE` FIRST, so a mutating `gh api` never falls through to READ      |
| `write-unknown-verb.txt`   | `"write"` | an UNRECOGNIZED `gh <verb>` → FAIL-CLOSED to the stricter WRITE tier (a novel verb never silently gets the lighter read ceremony)   |
| `read-run-list.txt`        | `"read"`  | `gh run list` — CI-audit enumeration → READ tier (loom#1665)                                                                       |
| `read-run-view.txt`        | `"read"`  | `gh run view` — inspecting one run's logs → READ tier (loom#1665)                                                                  |
| `read-run-watch.txt`       | `"read"`  | `gh run watch` — follows a run to completion, mutates nothing → READ tier (loom#1665)                                              |
| `read-run-download.txt`    | `"read"`  | `gh run download` — fetches artifacts → READ tier; `download` was absent from `GH_READ_VERBS` (loom#1665)                          |
| `read-release-download.txt`| `"read"`  | `gh release download` — same missing-read-verb half of loom#1665, on a different prefix                                            |
| `write-workflow-run.txt`   | `"write"` | `gh workflow run` — TRIGGERS a workflow → WRITE tier. The pole that keeps the loom#1665 fix from over-reaching                     |
| `write-run-cancel.txt`     | `"write"` | `gh run cancel` — aborts a live run → WRITE tier (holds via the fail-closed default)                                               |
| `write-run-rerun.txt`      | `"write"` | `gh run rerun` — re-triggers CI → WRITE tier (holds via the fail-closed default)                                                   |
| `write-run-delete.txt`     | `"write"` | `gh run delete` — destroys run history → WRITE tier (holds via the fail-closed default)                                            |

## loom#1665 — the `gh run` bipolar set

`GH_WRITE_VERBS` carried the bare verb `run` (correct for `gh workflow run`) in an
alternation whose prefix group is OPTIONAL, so `gh run list` matched as
empty-prefix + verb `run` — the match was the literal string `"gh run"`. Because
`GH_WRITE_VERBS` is tested BEFORE `GH_READ_VERBS`, the read pattern (which
already listed `run` among its prefixes and matched `"gh run list"` correctly)
was never reached. **Every `gh run *` command classified WRITE, so a read receipt
could not authorize a CI audit at all.**

The fix anchors `run` to its `workflow` prefix and adds `watch`/`download` to the
read verbs. The test ORDER is deliberately unchanged — `GH_WRITE_VERBS` keeps
first refusal on genuine ambiguity, because fail-closed is the correct default
for an authorization tier.

**Why this set is bipolar and not merely additive:** the four `read-run-*`
fixtures alone would pass against a classifier that returned `"read"` for every
`gh run *` — including `cancel`, `rerun`, and `delete`, which genuinely mutate.
The four `write-*` fixtures are what make the read half load-bearing. A
`node --test` assertion enforces that both poles stay populated, and a second
assertion pins the directory against the expectation map so a fixture cannot be
added without being asserted.

**Fail-closed invariant:** the classifier ranks an unrecognized subcommand WRITE (the stricter tier), mirroring the enforcement-surface-parity "unrecognized ranks tightest" — an over-restrictive misclassification (a read handled as a write) is safe; the reverse (a write handled as a read) is the failure this fixture set guards against.
