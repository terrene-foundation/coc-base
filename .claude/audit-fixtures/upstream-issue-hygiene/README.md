# `upstream-issue-hygiene` probe fixtures (SEMANTIC tier)

Candidates for `.claude/test-harness/probes/upstream-issue-hygiene.probes.json`, the
LLM-judge suite covering `.claude/rules/upstream-issue-hygiene.md` **MUST-4 ("Open,
Never Complete")**. Registered in `eval-manifest.json` as a probe-only entry
(`scanner: null`) and pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`.

**These are NOT structural audit fixtures.** No scanner reads this directory. There is
no Phase-2 detector for MUST-4 and none is deferred; the structural tier is the
`completeUpflowPR` refusal at the adapter boundary, whose fixtures live elsewhere.

## Layout

Every candidate has a `.expected` sidecar carrying the answer key. **The sidecar is
never shown to a judge** — the candidate is handed over VERBATIM, so it must stay free
of HTML comments and of every marker in `ANSWER_KEY_MARKERS`
(`probe-suite-integrity.test.mjs`, mirrored in `artifact-probe-adapter.mjs`). Filenames
encode the pole for human legibility only; `buildPlan` renders no candidate identity.

| pair_id                  | violation pole                                  | compliant pole                                       |
| ------------------------ | ----------------------------------------------- | ---------------------------------------------------- |
| `MUST-4-firing`          | `flag-upflow-opened-then-admin-merged.txt`      | `clean-upflow-opened-and-stopped.txt`                |
| `MUST-4-completion-locus`| `flag-human-gate-read-as-merge-authorization.txt`| `clean-upstream-maintainer-completes-own-repo.txt`   |
| `meta-compliance`        | `meta-violation-open-never-complete.md`         | `meta-compliant-open-never-complete.md`              |

## Why these poles discriminate

The poles are deliberately **not separable lexically**, because a suite a judge can
score without reading is a suite that cannot fail:

- **Both** poles of `MUST-4-firing` run `gh pr merge`. The compliant one merges on its
  OWN repo — the clause's own invariant, "you may only complete a PR on the repo you
  ARE". A judge keying on the command flags a clean session.
- **Both** poles of `MUST-4-completion-locus` complete a PR the session did not author.
  The compliant one is the UPSTREAM maintainer disposing on its own repo after the four
  ingest steps genuinely ran; it also DISABLES an auto-merge a downstream had enabled,
  so a judge treating any `--auto` mention as the violation flags the corrector.
- The violation pole of `MUST-4-completion-locus` issues **no merge act at all** and
  invites the reader to grep for one — `--auto --squash` lands it with no maintainer
  act, which the clause names as completion.
- Both `MUST-4` violation poles **satisfy MUST-1 and MUST-2** (quoted same-session human
  approval; a scrub that ran and struck the named identifiers), so a judge citing the
  human gate or redaction has scored the wrong clause.
- The `meta-compliance` poles are **surface-equalized** — identical frontmatter, identical
  `##` heading skeleton, 2 numbered clauses each, a byte-identical clause 2, sizes 4.7%
  apart. Every defect sits in clause 1 and in what the affordances CONTAIN (hedged modal,
  a re-permission of the blocked act, a 5-sentence `**Why:**`, a BLOCKED corpus of
  abstract instructions matching the sibling's COUNT exactly, and DO/DO-NOT arms that both
  open-then-merge).

## Running

Not CI-run and not automatically executed anywhere. Registration buys DISPATCHABILITY
only; dispatch at gate-review via `/test-harness-probe --artifacts`. **A green CI run is
never evidence these probes passed.**
