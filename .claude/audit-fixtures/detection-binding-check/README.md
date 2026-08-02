# `detection-binding-check` audit fixtures

Structural fixture set for `.claude/bin/detection-binding-check.mjs`, the detector
for `coc-artifact-eval-coverage.md` MUST-4 (the artifact↔harness binding).

Each case sub-directory is a self-contained mini-repo. The engine
(`coc-eval-core.mjs::runEvalHarness`) invokes the scanner as
`node .claude/bin/detection-binding-check.mjs --root <case-dir> --json` and
asserts the case's pinned disposition from
`.claude/test-harness/eval-manifest.json`.

## Why every violation case pins `critical_failures`

`coc-artifact-eval-coverage.md` MUST-5(a): exit code + grade prove POLARITY, not
detection CLASS. All three dangling cases below exit 1 with grade `INVALID`, so
exit+grade alone cannot tell them apart — a content swap between them would pass
a polarity-only assertion. Each therefore pins the specific critical check-id it
exercises, which `runEvalHarness` verifies is actually among the scanner's
failed-critical checks. `coc-manifest-integrity.mjs` check (i) independently
HARD-FAILS a pinned entry whose violation case pins no `critical_failures`.

## Cases

| Case                             | Exit | Classification state exercised          | Pinned critical check      |
| -------------------------------- | ---- | --------------------------------------- | -------------------------- |
| `clean-wired-and-resolving`      | 0    | `wired-and-resolving`                   | —                          |
| `clean-no-wiring`                | 0    | `no-wiring`                             | —                          |
| `clean-wired-no-detection-block` | 0    | `wired-no-detection-block`              | —                          |
| `clean-deferred-fixtures-absent` | 0    | `deferred-fixtures-absent` (not fatal)  | —                          |
| `clean-fp-illustrative-example`  | 0    | FP(1) fenced DO/DO-NOT example          | —                          |
| `clean-fp-shell-command`         | 0    | FP(2) shell commands + flags            | —                          |
| `clean-fp-absent-by-design`      | 0    | FP(3) paths asserted ABSENT             | —                          |
| `clean-fp-glob-placeholder`      | 0    | FP(4) globs / `<id>` placeholders       | —                          |
| `violation-dangling-scanner`     | 1    | `dangling-live-reference` (scanner)     | `dangling-scanner-binding` |
| `violation-dangling-fixtures`    | 1    | `dangling-live-reference` (fixtures)    | `dangling-fixtures-binding`|
| `violation-dangling-probes`      | 1    | `dangling-live-reference` (probes)      | `dangling-probes-binding`  |
| `violation-empty-corpus`         | 1    | fail-closed on an unreadable corpus     | `corpus-readable`          |

The clean cases share exit 0 and grade `VALID`, so the manifest cannot
discriminate them either. Their classification state is pinned instead by
`.claude/test-harness/tests/detection-binding-check.test.mjs`, which asserts the
exact per-rule `state` each case must produce. Manifest + self-tests together
bind every case to its class; neither does it alone.

## The false-positive cases are not decoration

Two of them reproduce failures the scanner hits on loom's REAL corpus:

- `clean-fp-illustrative-example` mirrors `coc-artifact-eval-coverage.md`, whose
  own worked example is a literal `- **Detection mechanism:**` bullet naming
  `foo-readiness-check.mjs` inside a ```` ```text ```` fence, and
  `trust-posture.md`, whose only Detection bullet is the canonical 8-field
  TEMPLATE inside a ```` ```markdown ```` fence. A scanner that does not strip
  fenced blocks reports danglers against both.
- `clean-fp-absent-by-design` mirrors `knowledge-convergence.md`, which cites
  `.claude/team-memory/team-memory.md` precisely because that aggregate file is
  BLOCKED.

Each guard is verified DISCRIMINATING by mutating the fixture INPUT rather than
the scanner: un-fencing the example block (delimiters removed, bullet text
untouched) flips `clean-fp-illustrative-example` from exit 0 to exit 1 with all
three danglers; deleting the `absent-by-design` declaration flips
`clean-fp-absent-by-design` from exit 0 to exit 1. A guard that cannot be shown
to fail is not a guard.
