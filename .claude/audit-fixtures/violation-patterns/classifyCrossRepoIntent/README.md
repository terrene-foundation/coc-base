# classifyCrossRepoIntent audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Each fixture pins one intent-classification predicate `classifyCrossRepoIntent(command)` relies on for the tier-reads discipline (D — `journal/0488`): a user-directed READ satisfies `repo-scope-discipline.md` § User-Authorized Exception with condition 4 downgraded to a one-line affordance receipt; a WRITE keeps all five conditions. Inputs are Bash command strings; expected outputs are the string `"read"` or `"write"` returned by `classifyCrossRepoIntent(input)`.

| Fixture                    | Expects   | Predicate locked                                                                                                                    |
| -------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `read-issue-list.txt`      | `"read"`  | a `gh issue list` (view/list/status/diff/checks) verb → READ tier                                                                  |
| `read-api-get.txt`         | `"read"`  | a bare `gh api <path>` with NO mutating method/field → GET → READ tier (the verify-resource-existence common case)                  |
| `write-issue-create.txt`   | `"write"` | a `gh issue create` (create/edit/close/merge/…) verb → WRITE tier (all five conditions)                                            |
| `write-api-mutate.txt`     | `"write"` | a `gh api -X POST … -f …` mutating call — matched by `GH_API_MUTATE` FIRST, so a mutating `gh api` never falls through to READ      |
| `write-unknown-verb.txt`   | `"write"` | an UNRECOGNIZED `gh <verb>` → FAIL-CLOSED to the stricter WRITE tier (a novel verb never silently gets the lighter read ceremony)   |

**Fail-closed invariant:** the classifier ranks an unrecognized subcommand WRITE (the stricter tier), mirroring the enforcement-surface-parity "unrecognized ranks tightest" — an over-restrictive misclassification (a read handled as a write) is safe; the reverse (a write handled as a read) is the failure this fixture set guards against.
