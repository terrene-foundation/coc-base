# `instrument-discipline` audit fixtures

Candidate texts for the LLM-judge probe suite
`.claude/test-harness/probes/instrument-discipline.probes.json`, registered in
`.claude/test-harness/eval-manifest.json` as a probe-only entry (`scanner: null`)
and dispatched at gate-review via `/test-harness-probe --artifacts`.

**These fixtures back the SEMANTIC tier only.** There is no structural scanner for
this rule and no Phase-2 hook detector; `coc-manifest-integrity.mjs` check (g)
(fixture-set completeness against `expected`) is keyed on `scanner != null` and so
does not reach this directory. What DOES enforce hygiene here is
`.claude/test-harness/tests/probe-suite-integrity.test.mjs`, which requires every
`candidate_fixture` to resolve, to carry no answer key, and to have an `.expected`
sidecar — and which pins this suite in `PINNED_SUITES`.

## Coverage — all six sub-clauses, both polarities each

`instrument-discipline.md` enumerates five sub-clauses in the MUST-1..3 block's
`**Violation scope:**` and one more in the clause-scoped MUST-4 block. Every one
carries a bipolar pair. For MUST-1..3 that was the condition the suite's
`_deferred_probes` graduation clause required before the declaration could be
discharged (converting only the three originally-staged clauses was explicitly
insufficient); MUST-4 shipped its pair in the same change that landed the clause,
per `coc-artifact-eval-coverage.md` MUST-1.

| Pair | Clause | Violation pole | Compliant pole |
| --- | --- | --- | --- |
| `MUST-1-firing` | falsifying result named | `flag-porcelain-cited-as-completion` | `clean-falsifying-result-named` |
| `MUST-2a-firing` | green needs an established red | `flag-green-suite-cited-as-verification` | `clean-red-established-before-green` |
| `MUST-2b-firing` | non-reddening mutation is two hypotheses | `flag-mutation-silence-as-vacuity` | `clean-mutation-shown-to-reach-code` |
| `MUST-3a-firing` | instrument shown to fire HERE | `flag-instrument-never-shown-to-fire` | `clean-positive-control-fired-here` |
| `MUST-3b-firing` | read the hits, not the tally | `flag-tally-reported-not-hits` | `clean-hits-read-in-context` |
| `MUST-4-firing` | instrument scoped to the question it was BUILT for | `flag-instrument-reused-for-second-question` | `clean-second-question-re-instrumented` |
| `meta-compliance` | rule-authoring conformance | `meta-violation-lexical-sufficiency` | `meta-compliant-discrimination-required` |

## The answer key lives in the `.expected` sidecar, never in the candidate

Each candidate `.txt` is handed to a judge VERBATIM. The reasoning — which clause
fires, which discriminator separates the poles, which neighbouring clause a judge
might mis-cite — lives in the adjacent `.expected` file, which no judge ever sees.
`probe-suite-integrity.test.mjs` bans HTML comments outright in candidates and
greps them for the answer-key markers it enumerates, because an earlier fixture
generation kept its key inside a comment whose only claim to being stripped lived
inside the comment that had to be stripped.

## Why the poles look so similar

Each pair is deliberately surface-matched: same task, same register, same length
band, same closing scope note, often the same commands. A pair separable by shape
measures formatting rather than meaning — the judge could score it correctly
without understanding anything. Concretely:

- The compliant MUST-1 pole NAMES both instruments its counterpart misuses, in
  order to reject them.
- The compliant MUST-2a pole still prints `# pass 31 # fail 0`.
- The compliant MUST-2b pole still concludes "propose delete" on one row.
- The compliant MUST-3a pole's sweep is NOT empty — it returns seven hits.
- The compliant MUST-3b pole reports MORE numbers than its counterpart, and
  messier ones.
- The compliant MUST-4 pole still INVOKES and cites the same re-used simulator;
  it also quotes both unsound readings, in order to reject them, so a judge
  keying on their presence rather than their disposition scores it wrong. Its
  public-API answer comes back POSITIVE, the opposite of the convenient result.

For the meta-compliance pair the equalization is mechanically enforced:
`probe-suite-integrity.test.mjs` requires both poles to share a `##` heading
skeleton and numbered-clause count, to each carry frontmatter, an `## Origin`, a
Trust-Posture Wiring block, a `**Why:**` line, a `# DO` block and a
`**BLOCKED rationalizations:**` heading, and to sit within a 1.5x byte ratio
(measured: 1.151). The violation pole's defect is therefore the CONTENT of that
furniture, never its absence.

## Phase-2 fixtures are NOT here

Both of `instrument-discipline.md`'s Detection blocks defer a Phase-2 hook
detector, and per `cc-artifacts.md` Rule 9 their structural fixtures land WITH
that detector. A regex detector for this rule would itself instance the class it
detects — which is why each deferral's `detector` field reads "deliberately none"
and its `graduation` contemplates rewriting the Wiring to say no Phase 2 will
come, rather than promising one. The deferrals are nonetheless DATED, not
open-ended: `.claude/test-harness/phase2-deferrals.json` carries
`instrument-discipline.md#no-regex-detector` (MUST-1..3) and
`instrument-discipline.md#no-regex-detector-must-4`, both expiring
2026-11-13, and `phase2-deferral-integrity.mjs` hard-fails an unregistered or
expired one. Nothing in this directory should be read as backing a structural
gate.
