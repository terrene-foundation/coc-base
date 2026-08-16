# `spec-corpus-conformance` structural fixtures

Structural (Contract C2) fixture set for `.claude/bin/spec-corpus-conformance.mjs` —
Sweep 5's REPO-LEVEL branch for a repo whose specs govern the ARTIFACT CORPUS
rather than application source (loom#1722).

Each subdirectory is a MINIMAL repo root. The harness invokes
`node .claude/bin/spec-corpus-conformance.mjs --root <fixture> --json` per
`coc-eval-core.mjs`'s contract and asserts the disposition pinned in
`.claude/test-harness/eval-manifest.json::spec-corpus-conformance.expected`.

There is no `run.mjs` here: the manifest's `scanner` drives these fixtures, the
same shape `.claude/audit-fixtures/detection-binding-check/` uses. That is why
this directory owes no row in `ci-audit-fixtures.json`.

## The bipolar set, and what each pole binds

Every violation fixture pins a DISTINCT failing critical check-id, so a
content swap that keeps the same exit + grade but flips to a different failing
check no longer matches the pin (`coc-artifact-eval-coverage.md` MUST-5(a)).

| fixture                               | exit | pinned critical class    | binds                                            |
| ------------------------------------- | ---- | ------------------------ | ------------------------------------------------ |
| `clean-conforming-corpus`             | 0    | —                        | resolving citations + the out-of-scope exemption |
| `clean-coverage-gap-not-fatal`        | 0    | —                        | coverage gaps are REPORTED, never fatal          |
| `clean-empty-section-not-fatal`       | 0    | —                        | placeholder sections are REPORTED, never fatal   |
| `clean-fp-doc-basename-declined`      | 0    | —                        | a bare `foo.md` is DECLINED, never orphaned      |
| `clean-fp-fenced-example`             | 0    | —                        | fenced illustrative paths are not claims         |
| `clean-prose-heading-drift-not-fatal` | 0    | —                        | `§ Heading` drift is REPORTED, never fatal       |
| `violation-orphan-citation`           | 1    | `orphan-citations`       | ORPHAN                                           |
| `violation-drift-symbol`              | 1    | `drift-machine-anchor`   | DRIFT                                            |
| `violation-blocked-marker`            | 1    | `stub-blocked-marker`    | STUB (spec-accuracy MUST-2)                      |
| `violation-empty-spec-corpus`         | 1    | `spec-corpus-nonempty`   | zero INPUT is not zero FINDINGS                  |
| `violation-no-specs-root`             | 1    | `specs-root-resolves`    | wrong-mode invocation                            |
| `violation-zero-citations`            | 1    | `citations-extracted`    | a non-firing extractor                           |
| `violation-no-artifact-corpus`        | 1    | `artifact-corpus-readable` | scanning the WRONG ROOT                        |

## What this set deliberately does NOT prove

A `clean-*` fixture's `expected` row (exit 0 / VALID) is satisfied whether the
NON-critical detector it is named for fired or not — deleting prose-heading
drift detection entirely would keep `clean-prose-heading-drift-not-fatal` green.
That hole is closed one layer up, in `.claude/bin/spec-corpus-conformance.test.mjs`,
whose `ANTI-VACUITY:` cases assert each of those detectors actually FIRED and
reported its hits.
