# `detection-distribution-check` audit fixtures

Each case sub-directory is a **self-contained mini-repo root**. The engine
(`coc-eval-core.mjs::runEvalHarness`) invokes the scanner as
`node .claude/bin/detection-distribution-check.mjs --root <case-dir> --json` and
asserts the case's pinned disposition from
`.claude/test-harness/eval-manifest.json`.

`coc-artifact-eval-coverage.md` MUST-5(a): exit code + grade prove **POLARITY,
not detection CLASS** — every violation case here shares `exit 1` / `INVALID`.
Each violation case therefore pins the specific critical check-id it exercises
via `critical_failures`, which `runEvalHarness` verifies is genuinely among the
scanner's failed-critical checks. A fixture-content swap that keeps the exit code
but flips to a different failing check no longer matches its pin.

## Why every fixture rule is named `security.md`

Not incidental, and not copy-paste. The `rules` tier in `sync-manifest.yaml` is a
**per-file allowlist** (`rules/security.md`, `rules/git.md`, …), **not** a
`rules/**` glob. A rule invented for a fixture (`example.md`, `demo.md`) matches
no tier and therefore ships to **no lane at all** — which makes the rule-side of
every claim vacuously empty and the whole shipping comparison a no-op. Such a
fixture would pass whether or not the scanner worked.

So each case names a rule the manifest actually distributes. If `security.md` is
ever removed from the tier allowlist these fixtures will start failing loudly,
which is the correct and intended behaviour.

## Cases

| Case | Exit | Pinned critical check | What it fixes in place |
| --- | --- | --- | --- |
| `clean-detector-ships` | 0 | — | Rule and detector (`.claude/hooks/…`) reach the same lanes. No gap exists, so nothing needs declaring. |
| `clean-declared-distribution-gap` | 0 | — | A real gap, **declared** in the case's own baseline registry. Proves the declaration channel clears the finding. |
| `violation-undeclared-distribution-gap` | 1 | `undeclared-distribution-gap` | The rule ships to every lane; the cited `.claude/test-harness/**` probe suite ships to none, and nothing says so. |
| `violation-directory-token-gap` | 1 | `undeclared-distribution-gap` | The cited token is a **directory**, so the verdict comes from `enumerateMembers` rather than a single classify. About a third of live claims take this path; it had no fixture in the first cut. |
| `violation-stale-baseline` | 1 | `stale-distribution-baseline` | The registry declares a gap that no longer exists — registry→corpus reconciliation. |
| `violation-empty-corpus` | 1 | `corpus-readable` | Fail-closed: a scan that read no rules verifies nothing and must never grade VALID. |

The first three form the **bipolar triple** that matters. `clean-declared-…` and
`violation-undeclared-…` are byte-identical except for the presence of the
baseline registry, so the pair isolates the declaration as the single variable —
the clean pole still **detects** the gap (`distribution_gaps: 1`) and is clean
because it declared, not because the scanner went blind.

## The bound no fixture can exercise

`distribution-model-loaded` (the fail-closed gate on an empty lane set) is **not
fixture-reachable**, deliberately. The lane model is read from the manifest of
the checkout the *script* lives in, never from `--root`, so no fixture root can
suppress it. The unit test asserts it stays unreachable rather than pretending
coverage exists; it is covered by code structure, not by a case here.

## Adding a case

1. Create the mini-root here (at minimum `.claude/rules/<a-tier-listed-rule>.md`).
2. Add its key to `eval-manifest.json::"detection-distribution-check".expected`.
   **Without this the fixture never runs**, and `coc-manifest-integrity` check
   (g) will red the build with "present on disk but NOT asserted".
3. Add a row to `CASES` in
   `.claude/test-harness/tests/detection-distribution-check.test.mjs`; that
   file's registration test asserts the two sets agree in both directions.
