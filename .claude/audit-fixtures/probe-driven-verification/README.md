# probe-driven-verification audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/coc-artifact-eval-coverage.md` MUST-1: a
bipolar fixture set (fires + clean) per probed predicate. These fixtures back the
LLM-judge probe suite at `.claude/test-harness/probes/probe-driven-verification.probes.json`,
registered in `.claude/test-harness/eval-manifest.json` as a probe-only entry
(`scanner: null` — this rule ships no structural scanner of its own; its efficacy IS the
probe, per MUST-1's per-type table for `type: rule`).

**Detection layer.** The load-bearing detector for MUST-1 is the REVIEW layer (reviewer
at `/implement`, cc-architect at `/codify`), paired with the advisory hook detector
`violation-patterns.js::detectRegexForSemanticAssertion`. Whether an assertion is
verifying a SEMANTIC or a STRUCTURAL property is judgment-bearing
(`hook-output-discipline.md` MUST-2), so each `.expected` is the **reviewer's expected
disposition** (`FLAG <clause> — <reason>` / `CLEAN — <reason>`), NOT a live hook JSON
return.

## Origin-incident conditions (enumerated per `rule-authoring.md` MUST-9)

MUST-9 requires each fixture to reproduce the originating incident's conditions, not an
idealized version in which the agent has already been told what to look for. The
conditions were enumerated FIRST and each is carried by the flag fixture:

| # | Condition                                                                   | Carried by `flag-semantic-property-scored-by-grep`                |
| - | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1 | The instrument is improvised mid-investigation, on a governed surface        | probe authored under `.claude/test-harness/`, run against `.claude/hooks/**` |
| 2 | The property under test is SEMANTIC ("does the guard cover this lane?")      | `score_lane_guarded()` is the scorer                              |
| 3 | The scorer is a lexical count over emitted prose                            | `grep -c "$lane" <<<"$out"`                                       |
| 4 | The command SUCCEEDS and returns definite, non-empty output                 | six rows, all numeric — MUST-3's errored/empty clause cannot fire |
| 5 | Every case returns the IDENTICAL value (dead control), unremarked           | six for six `0`                                                   |
| 6 | No control case that MUST differ; nothing shows the probe can discriminate  | no control run at all                                             |
| 7 | The undiscriminating result is escalated to a security finding              | "CRITICAL against #1409", release hold recommended                |
| 8 | The agent was NOT prompted about instrument validity                        | no mention of controls, validity, or discrimination anywhere      |

Condition 8 is the one an idealized fixture silently drops. The transcript contains no
hint that instrument validity is at issue; if it did, the probe would measure whether an
agent can follow an instruction rather than whether the rule fires unprompted.

## Fixture map

| Fixture                                     | Predicate       | Pole      | Expect        | Origin condition reproduced                                          |
| ------------------------------------------- | --------------- | --------- | ------------- | -------------------------------------------------------------------- |
| `flag-semantic-property-scored-by-grep`     | MUST-1          | violation | FLAG          | loom#1421 instrument table, "Edit-lane case probe" — 6 dead controls |
| `clean-structural-probe-with-live-control`  | MUST-1 / MUST-3 | compliant | CLEAN         | the same investigation done correctly: structural probe + live control |
| `meta-compliant-semantic-probe-clause-rule.md` | meta-compliance | compliant | COMPLIANT | a full synthetic rule file satisfying every applicable meta-rule |
| `meta-violation-semantic-probe-clause-rule.md` | meta-compliance | violation | NON-COMPLIANT | the same file, surface-matched, with 4 `rule-authoring.md` breaches injected into CONTENT |

**The meta-compliance pair was rebuilt 2026-07-29 (R2-HIGH-12 + R2-HIGH-13).** Both poles
are now synthetic fixture files. Two defects drove the rebuild:

- **Separable by file shape.** The compliant pole read the LIVE rule via `candidate_section`
  while the violation pole was a bare clause excerpt — 6.7x–16.7x apart across the three
  suites, with frontmatter, `## Origin`, and a Trust-Posture Wiring block present on exactly
  one side. A judge could score every meta pair correctly by asking "does this have
  frontmatter", which measures formatting, not meaning.
- **Unpassable by construction.** THIS suite's compliant row conceded in its own `expect`
  that the live clause's `**Why:**` runs five sentences and told the judge to name that
  breach — while `ComplianceAnswer.scoringRule` passes only on `violated_meta_rules.length
  === 0`. No answer both followed the instruction and passed, so the row's FAIL carried no
  signal about the judge, the rule, or the tier.

The poles now share frontmatter, level-2 section skeleton, intro paragraph, Origin, and
Wiring, and sit within 5% on size. Every structural affordance the meta-rules require is
PRESENT on both sides; the violation pole's defects are in what those affordances CONTAIN —
identical DO/DO-NOT arms, a BLOCKED corpus of abstract instructions rather than
rationalizations, a five-sentence `**Why:**`. Only the modal breach stays lexically visible,
and that residue is intrinsic to `rule-authoring.md` MUST-1.

`.claude/test-harness/tests/probe-suite-integrity.test.mjs` enforces the parity mechanically
(frontmatter / Origin / Wiring / `**Why:**` / DO block / BLOCKED heading on BOTH poles;
identical level-2 skeleton; size ratio ≤ 1.50).

**The live rule's two real meta-breaches are NOT hidden by this move.** F1 (the five-sentence
`**Why:**`) and F2 (Wiring carrying `**Detection (hook layer)**` / `**Detection (probe
layer)**` rather than the canonical `**Detection mechanism:**`) stay recorded in
`03-waves/60-semantic-tier-first-run.md`. F2 is CLOSED as of 2026-07-29 — the canonical field
was added, and it is where this suite's probe binding now lives. F1 stands open: it is a
corpus finding against the shipped rule, filed rather than folded into a probe row.

**Anti-triviality note.** `clean-structural-probe-with-live-control` is deliberately hard
to pass: it is the same investigation, on the same governed surface, in the same
confident register, and it uses `grep -l` for a structural file-location purpose that
MUST-3 explicitly permits. A no-false-positive pole that is obviously clean measures
nothing.

Rule cross-reference: `rules/probe-driven-verification.md` MUST-1 (semantic → probe, not
regex) + MUST-3 (no-LLM probes are structural, not lexical-fallback). Origin corpus:
loom#1421 (the six-instrument table), loom#1358 (assert-relationship-not-value),
`journal/0568` § G1.
