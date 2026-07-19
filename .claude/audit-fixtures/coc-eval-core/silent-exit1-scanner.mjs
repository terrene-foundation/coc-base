#!/usr/bin/env node
// Fixture scanner for the grade-pin regression (coc-eval-core.test.mjs, F4):
// exits 1 with EMPTY stdout — the shape a scanner takes when it CRASHES to exit 1
// (uncaught throw before emitting JSON) rather than reaching its INVALID-grade
// verdict. `extractVerdict("")` -> grade=null. A negative fixture that pinned only
// `exit:1` would FALSE-PASS this (1 === want.exit); pinning `grade:"INVALID"` makes
// the null-grade mismatch and FAIL. Ignores --root; the crash is the whole point.
process.exit(1);
