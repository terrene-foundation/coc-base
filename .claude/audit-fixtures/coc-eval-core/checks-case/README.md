# checks-case fixture

Payload-less fixture case for `checks-emitting-scanner.mjs`. The synthetic
scanner ignores `--root` and always emits its fixed verdict (grade INVALID,
alpha-check critical-fail, beta-check critical-pass); this dir exists only so the
engine's fixture-existence guard resolves the expected case name to a real
directory. Used by `coc-eval-core.test.mjs` to prove `critical_failures` binds a
fixture to its named failing critical check.
