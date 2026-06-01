# detectPreExistingNoSha audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Each fixture pins one scope-restriction predicate `detectPreExistingNoSha(text)` relies on. Inputs are assistant prose; expected outputs are the JSON returned by the detector — `null` (no flag) or a violation object with `severity: "halt-and-report"`.

| Fixture                          | Expects             | Predicate locked                                                                                       |
| -------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `flag-pre-existing-no-sha.txt`   | `halt-and-report`   | Paragraph claims "pre-existing failure" without nearby SHA citation → flag per zero-tolerance Rule 1c. |
| `clean-pre-existing-with-sha.txt`| `null`              | Same claim paired with `commit abc1234` SHA citation → no flag.                                        |

Detector source: `.claude/hooks/lib/violation-patterns.js::detectPreExistingNoSha`. Rule cross-reference: `rules/zero-tolerance.md` Rule 1c ("'Pre-existing' Is Unprovable After Context Boundary").
