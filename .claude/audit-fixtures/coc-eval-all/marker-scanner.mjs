#!/usr/bin/env node
// Synthetic bipolar readiness scanner for the coc-eval-all end-to-end self-test
// (coc-eval-all.test.mjs). loom has NO real structural scanner (canon-sync is
// excluded, an F3 concern), so this stand-in gives coc-eval-all a real scanner +
// fixtures to drive the WHOLE structural path: manifest-integrity → runEvalHarness
// → PASS/FAIL/coverage-floor.
//
// Contract mirrors a real readiness scanner: reads `--root <dir> --json`, emits a
// verdict object on stdout, and encodes the disposition in its EXIT CODE:
//   <root>/VIOLATION present  -> grade INVALID, passed false, exit 1 (detection case)
//   otherwise                 -> grade VALID,   passed true,  exit 0 (clean case)
// Bipolar by construction so a manifest asserting {clean: exit 0, violation:
// exit 1} satisfies the (h) bipolar floor.
import { existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const ri = args.indexOf("--root");
const root = ri !== -1 && args[ri + 1] ? args[ri + 1] : process.cwd();

const violated = existsSync(join(root, "VIOLATION"));
const verdict = violated
  ? { grade: "INVALID", passed: false, score: 0, checks: [{ id: "marker", critical: true, passed: false }] }
  : { grade: "VALID", passed: true, score: 100, checks: [{ id: "marker", critical: true, passed: true }] };

process.stdout.write(JSON.stringify(verdict));
process.exit(violated ? 1 : 0);
