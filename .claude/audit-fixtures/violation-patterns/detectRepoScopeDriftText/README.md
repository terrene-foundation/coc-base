# detectRepoScopeDriftText audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Each fixture pins one scope-restriction predicate `detectRepoScopeDriftText(text)` relies on. Inputs are assistant prose; expected outputs are the JSON returned by the detector — `null` (no flag) or a violation object with `severity: "halt-and-report"`.

| Fixture                       | Expects             | Predicate locked                                                                                                 |
| ----------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `flag-context-switch-to.txt`  | `halt-and-report`   | Prose contains "context-switch to <repo>" → cross-repo prioritization recommended from within an in-repo session. |
| `clean-stay-in-scope.txt`     | `null`              | Prose stays scoped to current repo, no cross-repo redirection → no flag.                                          |

Detector source: `.claude/hooks/lib/violation-patterns.js::detectRepoScopeDriftText`. Rule cross-reference: `rules/repo-scope-discipline.md` MUST NOT § "Suggest 'context-switch to <repo>' …".
