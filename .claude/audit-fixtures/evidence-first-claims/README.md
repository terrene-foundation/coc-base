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
| `flag-inference-as-fact`             | MUST-4    | FLAG   | gap-filler (2026-05-31 session, see note)        |
| `clean-inference-labeled`            | MUST-4    | CLEAN  | gap-filler corrected (hypothesis marker present) |
| `flag-instrument-inference-as-fact`  | MUST-4    | FLAG   | 2026-07-28 instrument-selection incident         |
| `clean-instrument-inference-labeled` | MUST-4    | CLEAN  | same incident corrected (marker + discriminating check) |
| `meta-compliant-inference-clause-rule`| meta-compl| COMPL  | synthetic rule file meeting every applicable meta-rule |
| `meta-violation-inference-clause-rule`| meta-compl| N-COMPL| same file, surface-matched, 4 breaches in CONTENT |

**MUST-4 gap-filler note.** The three origin errors (E1/E2/E3) map to MUST-1/2/3. At
rule-landing time MUST-4 (inference-in-the-grammar-of-observation) had no distinct origin
incident — it was the cross-cutting grammar every confabulation takes — so its original
fixture pair uses the 2026-05-31 session's own "--list-all fix worked" inference (stated
as fact while the run had FAILED) as the faithful flag case.

**MUST-4 now HAS a documented origin incident** (added 2026-07-28). The loom
orchestration session recorded in `journal/0568` produced five instrument-selection
failures on one root cause, every one a MUST-4 instance with a distinctive shape the
original pair does not carry: the command **SUCCEEDED**, its output **was quoted inline**
(so MUST-1 and MUST-3 are both satisfied), and the defect is entirely in the unmarked
leap from the quoted bytes to a conclusion the instrument could not have decided. The
`*-instrument-*` pair reproduces that shape at real transcript scale — the original pair
is a single line each, which is enough for a lexical detector and not enough for an
LLM-judge probe. Corroborating corpus: loom#1421's six-instrument table, loom#1358's
four assert-shapes.

**Probe suite.** The bipolar LLM-judge suite for MUST-4 is
`.claude/test-harness/probes/evidence-first-claims.probes.json` (efficacy +
no-false-positive + meta-compliance, meta-compliance itself bipolar), registered in
`.claude/test-harness/eval-manifest.json` as a probe-only entry (`scanner: null`). Every row
pins `judge_model: claude-sonnet-5` and a `pair_id`; the model pin is deliberate — these
fixtures were authored by Opus 5, and Anthropic's eval guidance is that the evaluating model
should differ from the generating one. Without the pin, judge selection was per-invocation
and no two runs were comparable.

**The meta-compliance pair was rebuilt 2026-07-29 (R2-HIGH-12 + R2-HIGH-14).** Both poles are
now synthetic fixture files. Previously the compliant pole read the LIVE rule (5,305 B) via
`candidate_section` against a 1,447 B excerpt — 3.7x apart, with frontmatter, `## Origin`,
and a Trust-Posture Wiring block present on exactly one side — so a judge could score it
correctly by asking "does this have frontmatter", measuring formatting rather than meaning.
The poles now share frontmatter, level-2 section skeleton, intro paragraph, Origin, and
Wiring, and sit within 5% on size; every affordance the meta-rules require is PRESENT on both
sides and the violation pole's defects live in what those affordances CONTAIN.

**The answer-key strip is MECHANIZED, no longer asserted.** The old violation fixture opened
with an HTML comment enumerating the exact defects the judge was scored on, and the claim
that it was stripped before dispatch lived inside the comment that had to be stripped — so a
leak would have been invisible AND would have made the row pass more convincingly. The key
now lives in the `.expected` sidecar, which is never fed to a judge, and
`.claude/test-harness/tests/probe-suite-integrity.test.mjs` fails on any HTML comment or
answer-key marker in a candidate fixture.

Rule cross-reference: `rules/evidence-first-claims.md` (MUST-1 through MUST-4 +
Trust Posture Wiring). Emergency trigger `evidence_free_claim` (the MUST-2 security
subclass) is registered at `rules/trust-posture.md` MUST-4 § Emergency.
