# detectSelfConfession audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Each fixture pins one scope-restriction predicate `detectSelfConfession(finalText)` relies on. Inputs are the assistant's final response prose; expected outputs are the JSON returned by the detector — `null` (no flag) or a violation object with `severity: "advisory"` (lexical-only signal per `trust-posture.md` MUST NOT — self-confession NEVER auto-downgrades).

| Fixture                            | Expects    | Predicate locked                                                                                          |
| ---------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `flag-i-missed.txt`                | `advisory` | "I missed …" / "I forgot …" / "I should have run …" / "tests were incomplete" → lexical advisory.         |
| `clean-no-confession.txt`          | `null`     | Routine completion prose with no confession language → no flag.                                           |

Detector source: `.claude/hooks/lib/violation-patterns.js::detectSelfConfession`. Rule cross-reference: `rules/trust-posture.md` MUST NOT § "Self-confess + log + downgrade in one shot from a lexical regex match alone."
