# detectSweepSubstitution audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Each fixture pins one scope-restriction predicate `detectSweepSubstitution(finalText)` relies on. Inputs are the assistant's final report; expected outputs are the JSON returned by the detector — `null` (no flag) or a violation object with `severity: "halt-and-report"`.

| Fixture                                 | Expects             | Predicate locked                                                                                                              |
| --------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `flag-zero-clean-no-substitution.txt`   | `halt-and-report`   | `Sweep N: 0/0/0 (clean)` WITHOUT `(substituted ...)` qualifier → mandated step likely substituted by cheap proxy unlabeled.   |
| `clean-zero-with-substitution-label.txt`| `null`              | `Sweep N: 0/0/0 (substituted per user approval)` → labeled substitution per Rule 2 of sweep-completeness; no flag.            |

Detector source: `.claude/hooks/lib/violation-patterns.js::detectSweepSubstitution`. Rule cross-reference: `rules/sweep-completeness.md` MUST Rules 1 + 2.
