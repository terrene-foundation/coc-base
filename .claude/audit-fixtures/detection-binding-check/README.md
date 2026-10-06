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

## `run.mjs` — non-canonical Detection bullet MARKER (2026-09-16)

12 pure-predicate cases over `findNonCanonicalDetectionBullets` +
`extractDetectionSpans`. Run standalone:

```bash
node .claude/audit-fixtures/detection-binding-check/run.mjs
```

**Why these are not mini-repo cases.** Every case above is a mini-repo pinned in
`eval-manifest.json`, which is the right shape for whole-scanner dispositions. It
is the wrong shape here: the defect is that ONE character makes a Detection
bullet invisible, so the fixture must vary one character and read the verdict. A
mini-repo per marker would bury that difference under a directory tree. This is
the `fixture-hookEvent-a/b/w/w0` shape already used in `validate-emit/run.mjs`.

**The defect.** `DETECTION_BULLET_RE` anchors a hyphen at COLUMN 0; every other
marker renders identically in markdown and is DISCARDED, so `extractDetectionSpans`
returns zero spans and the rule reports `wired-no-detection-block` — a state that
was "reported, never red". One keystroke removed a rule and all of its bindings
from the MUST-4 gap population with the scanner still at exit 0.

Measured on the live corpus before the fix, mutating `conservation-gate.md`'s
`- **Detection mechanism:**` to `* **Detection mechanism:**`:

| Instrument                | Before                          | After                                |
| ------------------------- | ------------------------------- | ------------------------------------ |
| `detection-binding-check` | `wired-and-resolving`, 2 bindings | `wired-no-detection-block`, 0        |
| — summary                 | `wired_and_resolving` 62        | 61; exit **0**, VALID, score 100     |
| `validate-emit`           | 1844 pass / 0 fail              | 1844 pass / 0 fail — **byte-identical** |

The cross-check could not see it: `wiringBlocksIn` and both
`declaration-anchor.mjs` probes accept `*` at any indent. The two instruments
held OPPOSITE marker tolerances, so the strict one went quiet and the tolerant
one stayed green. Unlike the allowlist case there was not even a falling pass
count to notice.

**A non-canonical marker is now its OWN state and its OWN CRITICAL check**
(`detection-block-non-canonical-marker` / `non-canonical-detection-marker`),
deliberately split from `wired-no-detection-block`. Those are different facts:
the latter means the block was never written, which is a backlog item and stays
reported-only; the former means the block IS written and this scanner threw it
away, which is a fail-open in the instrument. The population is measured CLOSED
and EMPTY (141 Detection bullets corpus-wide, 0 non-canonical) and the remedy is
one character, so the "a gate that fires on day one gets switched off" argument
that keeps its neighbours quiet does not reach it.

| Case | Predicate                                                        | Expect  |
| ---- | ---------------------------------------------------------------- | ------- |
| `a`  | CONTROL — canonical `- `, and the parser DOES read the bullet     | CLEAN   |
| `b`  | the measured live defect — `* `                                   | FLAGGED |
| `c`  | `+ ` (third CommonMark marker)                                    | FLAGGED |
| `d`  | INDENT drift — `  - `                                             | FLAGGED |
| `e`  | ORDERED-list marker — `1. `                                       | FLAGGED |
| `f`  | ORDERED-list marker — `1) `                                       | FLAGGED |
| `g`  | U+2011 NON-BREAKING HYPHEN lookalike                              | FLAGGED |
| `h`  | DERIVATION — parser accepts `-  `, so the detector must too       | SILENT  |
| `i`  | PRECISION CONTROL — non-Detection bullets at any marker           | SILENT  |
| `j`  | VARIANT LABEL — `**Detection (structural …):**`, both poles       | BOTH    |
| `k`  | the report names the LINE, not merely that something was found    | line 5  |

**`h` is the case that keeps the two from drifting.** The verdict is DERIVED —
the detector asks `DETECTION_BULLET_RE` whether it would read the line, rather
than restating a second hand-written notion of "canonical". Because the parser
uses `\s+`, `-  ` (two spaces) IS read and must NOT be flagged. Anyone who
"tidies" that derivation into a literal `=== "- "` reds here, which is the whole
protection against re-creating the original defect — two parsers disagreeing.

**`i` is the load-bearing precision control.** The fence against a flooding
blanket `/^\s*[-*+]\s+/` draft is the `**Detection` LABEL anchor, not the marker
class. Measured over the fence-stripped corpus: the blanket matches **2965**
lines (503 of them indented detail sub-bullets); this probe matches **141**,
which is every Detection bullet there is, and flags **0**. A detector that floods
gets disabled by the first operator it blocks.

**Discrimination table.** Each mutation applied to `detection-binding-check.mjs`
one at a time (restored from a `cp` backup between runs). Clean baseline:
**12 passed, 0 failed, exit 0**.

| Mutation                                                           | Reds          | Controls stay green |
| ------------------------------------------------------------------ | ------------- | ------------------- |
| marker class narrowed to `[-*+]` (drops ordered + Unicode)          | `e` `f` `g`   | `a` `h` `i`         |
| `**Detection` label anchor made optional (the blanket draft)        | `i`           | `a`–`h` `j` `k`     |
| discard test restated as a literal `=== "- "` instead of derived    | `h`           | `a`–`g` `i`–`k`     |

The first two rows are the bipolar pair: tightening reds recall, loosening reds
precision, and only a corpus carrying both poles reds in both directions.

**Not yet CI-registered.** `ci-audit-fixtures.json` carries no `runners` entry
for `detection-binding-check` (it had no `run.mjs` until now), so this file runs
only when invoked directly. Registration is owed and is tracked by the lane
orchestrator, who owns that file — until it lands, a green CI run is NOT evidence
these cases passed.
