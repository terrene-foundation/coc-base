# detectRegexForSemanticAssertion audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4.

| Fixture                                   | Path arg          | Expects    | Predicate locked                                                                        |
| ----------------------------------------- | ----------------- | ---------- | --------------------------------------------------------------------------------------- |
| `flag-regex-in-verify-recommendation.txt` | `tests/test_a.py` | `advisory` | `re.search` inside `verify_recommendation_*` → flag                                     |
| `flag-grep-in-score-refusal.sh`           | `tests/score.sh`  | `advisory` | `grep -E` inside `score_refusal*` → flag                                                |
| `clean-structural-probe.txt`              | `tests/test_b.py` | `null`     | structural assertion (no regex API)                                                     |
| `clean-marker-regex-fixture.txt`          | `tests/test_c.py` | `null`     | regex against fixture marker — Rule 3 path (probe-driven runbook calls this acceptable) |
| `clean-non-test-file.txt`                 | `src/app.py`      | `null`     | regex `re.search` present BUT path filter rejects (not in test/harness/audit dir)       |

Severity always `advisory` for flagged inputs (lexical-only per `hook-output-discipline.md` MUST-2).

Origin: 2026-05-06 — paired with `rules/probe-driven-verification.md` MUST-1 + Trust Posture Wiring "Stop-event detector flags re.search/grep -E patterns in test files where surrounding function name suggests semantic verification."
