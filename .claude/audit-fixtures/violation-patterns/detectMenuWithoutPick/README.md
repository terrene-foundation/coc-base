# detectMenuWithoutPick audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Each fixture pins one scope-restriction predicate the detector relies on. Inputs are agent prose; expected outputs are the JSON returned by `detectMenuWithoutPick(text)` — `null` (no flag) or a violation object with `severity: "advisory"` (lexical-only, per `hook-output-discipline.md` MUST-2).

| Fixture                             | Expects    | Predicate locked                                                             |
| ----------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `flag-options-no-pick.txt`          | `advisory` | "Option A:" + "Option B:" with NO recommendation anchor → flag               |
| `flag-letter-list-no-pick.txt`      | `advisory` | "(a)" + "(b)" + "(c)" with NO anchor → flag                                  |
| `clean-options-with-recommend.txt`  | `null`     | "Option A:" + "Option B:" + "I recommend Option B" → anchor present, no flag |
| `clean-options-with-going-with.txt` | `null`     | "Option A:" + "Option B:" + "Going with Option A" → anchor present, no flag  |
| `clean-options-with-pick.txt`       | `null`     | "(a)" + "(b)" + "Pick: (a)" → anchor present, no flag                        |
| `clean-single-option.txt`           | `null`     | One "Option A:" only — under threshold (≥2 markers required), no flag        |
| `clean-no-options.txt`              | `null`     | No option markers at all (regular response prose) → no flag                  |
| `clean-empty.txt`                   | `null`     | Empty string → no flag (early return)                                        |

Severity is always `advisory` for flagged inputs — lexical regex match, per `hook-output-discipline.md` MUST-2 (severity:block requires structural signal). Cumulative tracking via `violations.jsonl`; trust-posture downgrade triggers per `rules/trust-posture.md` MUST Rule 4 (5× total in 30d).

Origin: 2026-05-06 — `rules/recommendation-quality.md` MUST-1 wired into Stop-event detection per user directive that recommendation quality (always-recommend, implications, pros/cons, plain language) needs structural enforcement, not just rule prose.
