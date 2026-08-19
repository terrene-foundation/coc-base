# `phase2-deferral-expiry` audit fixtures

Pins the two predicates behind the Phase-2 detector deferral expiry gate
(`.claude/bin/phase2-deferral-integrity.mjs`):

| Predicate                     | What the fixtures pin                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `validateDeferralDeclaration` | all seven required fields; the 30-character substantiveness floor on `reason`/`graduation`; ISO-date shape; real-calendar round-trip; **past-expiry hard fail**; risk-band horizon ceiling |
| `wiringSections`              | both Wiring declaration forms (`##` heading and `**bold paragraph**`); fence-awareness; nesting                                          |

Run:

```bash
node .claude/audit-fixtures/phase2-deferral-expiry/run.mjs
```

Registered in `.claude/test-harness/ci-audit-fixtures.json` (`mode: run`,
`min_cases: 51`). That registry is closed in both directions, so this runner
cannot become unwired and the entry cannot outlive the runner. The floor
restated here is COUPLED to the registry by
`.claude/test-harness/tests/audit-fixture-prose-count-coupling.test.mjs`, so it
cannot drift again — this line read `40` against a registry declaring `51`
until loom#1793 added that gate.

## Why these fixtures exist

`trust-posture.md` § Two-Phase Rollout defers Phase-2 enforcement for a sound
reason — a meta-rule should not be drafted by an agent already operating under
it. What was missing was a forcing function: "Phase 2 lands after ≥3 real
sessions" carries no date and no mechanical check, so **deferral was permanent by
default**. The registry at `.claude/test-harness/phase2-deferrals.json` gives
every deferral an expiry; these fixtures pin the predicate that reads it.

The clock is **injected** (`NOW`), not read. These fixtures assert the predicate,
so they do not start failing on a calendar date — the live gate is what is meant
to do that.

## Bipolar, and why that matters here

Every predicate gets a case that must PASS and a case that must FAIL. A runner
that only ever asserts rejection cannot distinguish a working predicate from one
that rejects everything, and a gate never shown to go RED is not evidence it can
(`instrument-discipline.md` MUST-2a).

Two cases are **regression pins** for bugs found while building this checker,
both of which silently UNDER-reported:

- `slicer/fence-comment-does-not-truncate-section` — shell comments (`# DO — …`)
  inside fenced code blocks were parsed as markdown headings and closed Wiring
  sections early. Measured on the real corpus: `artifact-flow.md`'s
  `**Detection mechanism:**` line was mis-tiered from a fail-closed error down to
  a non-fatal warning by a `# DO —` comment 26 lines above it.
- `slicer/bold-paragraph-form-detected` — ten rules open the block as
  `**Trust Posture Wiring (Rule 6):**` rather than a `##` heading. Nineteen such
  markers were invisible to the first cut of the section slicer.

Both were caught by reading the hits rather than the tally
(`instrument-discipline.md` MUST-3b).

## Scope limit — stated plainly

These fixtures pin predicates. They do **not** establish that the gate blocks
anything — that is branch-protection state, which no fixture here observes.

**Re-measure it; do not cite this paragraph.** Branch protection is mutable repo
state, so any sentence here is a dated snapshot. Read the shape with `has()` —
the object-construction form yields `null` for a missing key and cannot tell
ABSENT from PRESENT-AND-NULL:

```
gh api repos/:owner/:repo/branches/main/protection --jq \
  '{has_required_status_checks: has("required_status_checks"),
    contexts: .required_status_checks.contexts,
    enforce_admins: .enforce_admins.enabled}'

  2026-08-06 -> no required_status_checks, enforce_admins false
  2026-08-14 -> {"contexts":["Required checks"],"enforce_admins":true,
                 "has_enforce_admins":true,"has_required_status_checks":true}
```

**As of the 2026-08-14 measurement a red run of this gate DOES block the merge**
at canon loom — the gate's step runs in job `coc-artifact-eval-structural`, the
job named `Required checks` lists that job in its `needs:`, and that name is the
pinned protection context under `enforce_admins: true`. Which PRs, and NOT via a
`paths:` filter: the eval workflow instantiates on EVERY PR (its `pull_request`
arm has no filter; the four-path filter is on the `push:` arm alone). A PR
touching no artifact path SKIPS the structural job through a job-level `if:`, and
`Required checks` still reports and passes. The text here until 2026-08-14 said the opposite
("a red run is evidence, not a merge block"); that became false on 2026-08-08
and sat stale, which is the argument for re-measuring over citing.

**Consumers: this paragraph describes CANON LOOM, not your repo.** Protection is
per-repository. Run the query above against your own remote before concluding
anything about whether this gate gates you. See the registry's `_README` §
CI REALITY.
