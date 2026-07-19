# scanner-timeout fixture (F3 regression)

Fixture directory for the `scanner-timeout` regression case. `runEvalHarness`
runs `sleeper-scanner.mjs` (a sibling stub that blocks ~2s) against this dir with
a lowered `COC_EVAL_SCANNER_TIMEOUT_MS`, so the scanner is killed by the wall-clock
budget and exits with a non-numeric status + signal.

Asserted by `.claude/test-harness/tests/coc-eval-core.test.mjs`: the harness MUST
report this case as **FAIL** (`scanner did not exit cleanly: …`), NEVER a PASS on
the pinned `exit: 1` expectation — a killed scanner is a hard fail, not a
false-pass on an exit-1 fixture.
