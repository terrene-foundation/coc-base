# `sweep-completeness` probe fixtures (SEMANTIC tier)

Candidates for `.claude/test-harness/probes/sweep-completeness.probes.json`, the LLM-judge
suite covering `.claude/rules/sweep-completeness.md` **MUST-4 ("The SAME Unadjudicated
Verdict On 3 Consecutive Runs MUST ESCALATE")**. Registered in `eval-manifest.json` as a
probe-only entry (`scanner: null`) and pinned in
`probe-suite-integrity.test.mjs::PINNED_SUITES`.

**These are NOT the structural audit fixtures.** MUST-4's structural tier is the scanner
`.claude/bin/unadjudicated-escalation.mjs`, whose bipolar fixtures live at
`.claude/audit-fixtures/unadjudicated-escalation/` and are declared in
`ci-audit-fixtures.json`. That directory is also the `fixturesDir` the manifest entry
names, because the rule's Detection block cites it; no scanner reads THIS directory.

## Layout

Every candidate has a `.expected` sidecar carrying the answer key. **The sidecar is never
shown to a judge** — the candidate is handed over VERBATIM, so it must stay free of HTML
comments and of every marker in `ANSWER_KEY_MARKERS` (`probe-suite-integrity.test.mjs`,
mirrored in `artifact-probe-adapter.mjs`). Filenames encode the pole for human legibility
only; `buildPlan` renders no candidate identity.

| pair_id           | violation pole                             | compliant pole                                     |
| ----------------- | ------------------------------------------ | -------------------------------------------------- |
| `MUST-4-firing`   | `flag-fourth-emission-no-escalation.txt`   | `clean-threshold-run-escalated-and-dispositioned.txt` |
| `meta-compliance` | `meta-violation-repeating-non-answer.md`   | `meta-compliant-repeating-non-answer.md`            |

## The HTML-comment constraint, and what it changed

MUST-4's disposition sentinel is written in the rule as an HTML comment
(`<!-- unadjudicated-disposition:v1 key="…" issue=N owner=… until=YYYY-MM-DD -->`), and the
detector's summary sentinel is too. A candidate fixture may carry **no HTML comment at
all**, so both are rendered here WITHOUT their delimiters, as a bare
`unadjudicated-disposition:v1 key="…" issue=… owner=… until=…` line. The sentinel is
complete on the contract the rule states — the four named fields, dated and owned — and the
sidecars say so, because a judge scoring the missing delimiters would be scoring a fixture
rendering rather than the session's conduct.

## Why these poles discriminate

The poles are deliberately **not separable lexically**, because a suite a judge can score
without reading is a suite that cannot fail:

- **Both** poles of `MUST-4-firing` emit `FINDING [Sweep 5] manual-supplement-required`, and
  both read a detector output saying `AT/PAST THRESHOLD`. A judge keying on the verdict's
  presence flags a compliant session. The discriminator is whether § 5 ADJUDICATED it.
- **Both** poles satisfy Rules 1 and 2 loudly — no substitution occurred, and the verdict is
  honestly labeled rather than relabeled clean — so a judge citing the cheap-proxy gate or
  the relabeling gate has scored the wrong clause. In the firing pole that honesty is
  precisely the defect's camouflage.
- **Both** poles file the same Rule-3 `/codify` follow-up to tool-back the step. It is the
  right long-term move in both and adjudicates the row in neither.
- The compliant pole ends with the gap UNFIXED and the same row still printing, which reads
  as unfinished work; a dated disposition is the clause's second escape, not a lesser one.
- The `meta-compliance` poles are **surface-equalized** — identical frontmatter, identical
  `##` heading skeleton, 2 numbered clauses each, 4 `# DO` captions each, a byte-identical
  clause 2, sizes 8.4% apart. Every defect sits in clause 1, the MUST NOT bullets and the
  Wiring severity, and in what the affordances CONTAIN: a hedged modal, a clause that
  re-permits re-emission and makes the threshold raisable by the emitting party, a
  5-sentence `**Why:**`, a BLOCKED corpus of abstract instructions matching the sibling's
  COUNT exactly, and DO/DO-NOT arms that are the same line twice.

## Running

Not CI-run and not automatically executed anywhere. Registration buys DISPATCHABILITY only;
dispatch at gate-review via `/test-harness-probe --artifacts`. **A green CI run is never
evidence these probes passed.**
