# detectRepoScopeDriftBash audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Each fixture pins one scope-restriction predicate the detector relies on. Inputs are Bash command strings; expected outputs are the JSON returned by `detectRepoScopeDriftBash(input, cwd)` — `null` (no flag) or a violation object.

| Fixture                         | Expects           | Predicate locked                                                                                                    |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `clean-current-repo.txt`        | `null`            | `gh ... --repo X` where X contains cwd basename → in-scope, no flag                                                 |
| `flag-explicit-other-repo.txt`  | `halt-and-report` | `gh ... --repo X` where X is a literal off-repo string → flag with halt-and-report severity (NOT block, per MUST-2) |
| `skip-shell-variable.txt`       | `null`            | `gh ... --repo "$REPO"` — pre-expansion shell variable, detector cannot evaluate, MUST skip (MUST-3)                |
| `skip-command-substitution.txt` | `null`            | `gh ... --repo $(...)` — command substitution, detector cannot evaluate, MUST skip (MUST-3)                         |
| `skip-braced-variable.txt`      | `null`            | `gh ... --repo "${REPO}"` — braced shell variable, MUST skip (MUST-3)                                               |

The cwd for every fixture is `/Users/esperie/repos/loom` (basename `loom`). `terrene-foundation/kailash-py` is the canonical off-repo string.
