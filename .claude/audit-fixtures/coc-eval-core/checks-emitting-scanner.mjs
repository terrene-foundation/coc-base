#!/usr/bin/env node
// Synthetic structural scanner for the detection-class-binding regression
// (coc-eval-core.test.mjs). loom EXCLUDES the real canon-sync readiness scanner
// (an F3 concern), so this stand-in reproduces the SAME engine contract the
// BUILD R8-FB test exercised against canon-sync: a scanner emits a per-check
// results array, and `critical_failures` binds a fixture to the specific CRITICAL
// check it MUST exercise. A content swap that flips the failing check (same exit +
// grade) no longer matches the pin.
//
// Deterministic verdict (ignores --root — the shape is the whole point):
//   grade INVALID, passed false, exit 1
//   checks: alpha-check (critical) FAILS; beta-check (critical) PASSES.
// So a pin of critical_failures:["alpha-check"] matches; ["beta-check"] does not
// (beta passed, not failed) — the simulated content-swap the binding must catch.
const verdict = {
  grade: "INVALID",
  passed: false,
  score: 0,
  checks: [
    { id: "alpha-check", critical: true, passed: false },
    { id: "beta-check", critical: true, passed: true },
    { id: "gamma-note", critical: false, passed: false },
  ],
};
process.stdout.write(JSON.stringify(verdict));
process.exit(1);
