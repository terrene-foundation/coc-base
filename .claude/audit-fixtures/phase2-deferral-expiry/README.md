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
`min_cases: 40`). That registry is closed in both directions, so this runner
cannot become unwired and the entry cannot outlive the runner.

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
anything: this repo has no required status checks and `enforce_admins:false`
(measured 2026-08-06), so a red run is evidence, not a merge block. See the
registry's `_README` § CI REALITY.
