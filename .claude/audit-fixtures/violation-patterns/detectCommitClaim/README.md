# detectCommitClaim audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Each fixture pins one scope-restriction predicate `detectCommitClaim(command)` relies on. Inputs are bash command strings; expected outputs are the JSON returned by the detector — `null` (no flag) or a violation object with `severity: "advisory"` (lexical-only, per `hook-output-discipline.md` MUST-2).

| Fixture                       | Expects    | Predicate locked                                                                                                         |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `flag-claim-refactored.txt`   | `advisory` | `git commit -m "...refactored..."` matches `COMMIT_CLAIM_LANG` → advisory (claim language present, /redteam-shaped diff). |
| `clean-non-claim.txt`         | `null`     | `git commit -m "add user validation"` contains no claim-language token → no flag.                                        |

Detector source: `.claude/hooks/lib/violation-patterns.js::detectCommitClaim`. Rule cross-reference: `rules/git.md` § "Commit-message claim accuracy".
