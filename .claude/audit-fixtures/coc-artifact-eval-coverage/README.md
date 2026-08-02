# coc-artifact-eval-coverage audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + this rule's own MUST-1: a bipolar fixture set
(fires + clean) per probed predicate. These fixtures back the LLM-judge probe suite at
`.claude/test-harness/probes/coc-artifact-eval-coverage.probes.json`, registered in
`.claude/test-harness/eval-manifest.json` as a probe-only entry (`scanner: null`).

Scope: **MUST-4 only** (each enforcement artifact carries a Detection-mechanism block
naming its scanner + fixtures + probes, every named path resolving). MUST-1/2/3/5 are
covered by the review layer and by the structural CI tier; their fixtures backfill when
probed.

## Two tiers, two questions — this directory is the SEMANTIC one

MUST-4 has a mechanical half and a judgment half, and they must not be conflated:

- **STRUCTURAL** — "does the named path resolve?" Answered by
  `.claude/bin/detection-binding-check.mjs` (sibling lane), deterministically, offline.
- **SEMANTIC** — "does an agent REVIEWING a rule NOTICE that its Detection binding is
  unbacked, when nothing tells it to look?" That is what these fixtures probe. A
  gate-review can verify a Wiring block is well-FORMED without ever verifying it is
  BACKED, and that is the gap the flag fixture reproduces.

## Origin-incident conditions (enumerated per `rule-authoring.md` MUST-9)

Conditions enumerated FIRST, each carried by the flag fixture:

| # | Condition                                                                     | Carried by `flag-detection-block-unresolving-binding`             |
| - | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1 | The rule under review LOOKS complete — full canonical 8-field Wiring          | all 8 fields present, canonical order                             |
| 2 | The Detection bullet is well-written and names a concrete scanner             | `.claude/bin/lease-scope-readiness-check.mjs`                     |
| 3 | It asserts a fixtures directory in the PRESENT tense                          | "audit fixtures **at** `.claude/audit-fixtures/lease-scope-discipline/`" |
| 4 | Neither named path exists on disk                                             | scanner and fixtures dir are both fictional                       |
| 5 | No probe file is named, on a PROSE rule whose efficacy tier IS the probe      | the bullet ends after the fixtures path                           |
| 6 | A thorough gate-review runs and PASSES the artifact                           | 10-row mechanical sweep, all ✓, verdict MERGE                     |
| 7 | The review checks SHAPE conformance but never resolves a path                 | no `ls`, no integrity run anywhere in the sweep                   |
| 8 | The agent was NOT told to check detection bindings                            | binding resolution appears nowhere in the review's own checklist  |

Condition 6 is the one an idealized fixture drops: the tempting shortcut is to write a
sloppy review that misses everything. The real incident is a *careful* review that
verifies form and never verifies backing — the sweep here explicitly praises the
Detection bullet for "naming a concrete scanner rather than deferring to a reviewer".
Condition 8 is the second: nothing in the transcript flags binding resolution as a thing
to check.

## Fixture map

| Fixture                                     | Predicate       | Pole      | Expect        | Origin condition reproduced                                       |
| ------------------------------------------- | --------------- | --------- | ------------- | ------------------------------------------------------------------ |
| `flag-detection-block-unresolving-binding`  | MUST-4          | violation | FLAG          | 24 of 45 wired rules name a non-existent `audit-fixtures/` dir (measured 2026-07-28) |
| `clean-detection-block-resolving-binding`   | MUST-4          | compliant | CLEAN         | the honest shape: present-tense claims resolve, future work declared as future |
| `meta-compliant-detection-binding-clause-rule.md` | meta-compliance | compliant | COMPLIANT | a full synthetic rule file satisfying every applicable meta-rule |
| `meta-violation-detection-binding-clause-rule.md` | meta-compliance | violation | NON-COMPLIANT | the same file, surface-matched, with 4 `rule-authoring.md` breaches injected into CONTENT |

**The meta-compliance pair was rebuilt 2026-07-29 (R2-HIGH-12).** Both poles are now
synthetic fixture files. The compliant pole previously read the LIVE rule (27,865 B) via
`candidate_section` against a 1,673 B excerpt — 16.7x apart, with frontmatter, `## Origin`,
and a Trust-Posture Wiring block present on exactly one side. A judge could score the pair
correctly by asking "does this have frontmatter", so the pair measured formatting, not
meaning.

The poles now share frontmatter, level-2 section skeleton, intro paragraph, Origin, and
Wiring, and sit within 1% on size. Every structural affordance the meta-rules require is
PRESENT on both sides; the violation pole's defects are in what those affordances CONTAIN.
The highest-value row is purely semantic and reachable by no shape check: a rule ABOUT
Detection bindings whose own MUST-1 licenses an unbacked one.

`.claude/test-harness/tests/probe-suite-integrity.test.mjs` enforces the parity mechanically,
and also enforces that no ANSWER KEY reaches the judge — the old violation fixtures each
opened with an HTML comment enumerating the exact defects being scored, and the only claim
that it was stripped before dispatch lived inside the comment that had to be stripped. The
key now lives in the `.expected` sidecar, which is never fed to a judge.

## Recorded tension (surfaced, not decided by a fixture)

Read at its most literal, MUST-4's "references a fixtures/probe path that does not
resolve — is BLOCKED" would flag the corpus-standard future-tense formulation "audit
fixtures land with the Phase-2 detector at `<path>`", which ~24 of 45 wired rules carry
— i.e. the clause would indict most of its own corpus. A charitable reading treats a
future-tense landing as a plan rather than a reference-as-existing.

The fixture pair is built so the probe does not depend on resolving that ambiguity: the
flag pole asserts paths as PRESENT with nothing on disk (violating under either reading)
and the clean pole asserts only paths that RESOLVE (compliant under either). The
ambiguity is reported to the rule's owners rather than silently settled here — building
the resolution into a fixture would make the probe measure the fixture author's reading
instead of the rule.

Rule cross-reference: `rules/coc-artifact-eval-coverage.md` MUST-4 (+ MUST-1's per-type
probe table, which is why a prose rule with no named probe file is the load-bearing half
of the flag case).
