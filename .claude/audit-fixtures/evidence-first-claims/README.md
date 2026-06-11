# evidence-first-claims audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4: one
fixture pair (flag + clean) per detection predicate. The rule (`rules/evidence-first-claims.md`)
has 4 MUST predicates, so 4 pairs (8 `.txt` + 8 `.expected`).

**Detection layer.** The load-bearing detector is the REVIEW layer (reviewer at
`/implement`, cc-architect at `/codify`). The hook-layer `detectEvidenceFreeClaim`
(Stop event) is Phase-2-deferred and advisory-only per `hook-output-discipline.md`
MUST-2. Therefore each `.expected` is the **reviewer's expected disposition**
(`FLAG <MUST-clause> — <reason>` or `CLEAN — <reason>`), NOT a live hook JSON return.

**Origin-incident reproduction** (per `rule-authoring.md` Rule 9 — fixtures reproduce
the originating incident's conditions, not idealized versions):

| Fixture                              | Predicate | Expect | Origin error reproduced                          |
| ------------------------------------ | --------- | ------ | ------------------------------------------------ |
| `flag-diagnostic-no-log`             | MUST-1    | FLAG   | E1 — "30-minute timeout" misdiagnosis            |
| `clean-diagnostic-with-log`          | MUST-1    | CLEAN  | E1 corrected (log + exit code + duration quoted) |
| `flag-security-no-decoded-bytes`     | MUST-2    | FLAG   | E3 — fabricated "curl\|bash prompt injection"    |
| `clean-security-decoded-benign`      | MUST-2    | CLEAN  | E3 corrected (em-dash hexdumped before claim)    |
| `flag-errored-grep-as-confirmation`  | MUST-3    | FLAG   | E2/E3 — errored `grep -D` read as confirmation   |
| `clean-errored-grep-rerun`           | MUST-3    | CLEAN  | E2/E3 corrected (broken cmd named, re-run)       |
| `flag-inference-as-fact`             | MUST-4    | FLAG   | gap-filler (no direct origin incident — see note)|
| `clean-inference-labeled`            | MUST-4    | CLEAN  | gap-filler corrected (hypothesis marker present) |

**MUST-4 gap-filler note.** The three origin errors (E1/E2/E3) map to MUST-1/2/3.
MUST-4 (inference-in-the-grammar-of-observation) has no distinct origin incident — it
is the cross-cutting grammar every confabulation takes. Its fixture uses the
session's own "--list-all fix worked" inference (stated as fact while the run had
FAILED) as the faithful flag case.

Rule cross-reference: `rules/evidence-first-claims.md` (MUST-1 through MUST-4 +
Trust Posture Wiring). Emergency trigger `evidence_free_claim` (the MUST-2 security
subclass) is registered at `rules/trust-posture.md` MUST-4 § Emergency.
