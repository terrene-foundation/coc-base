#!/usr/bin/env node
/*
 * Audit fixture runner for validate-emit's `signing-model-key-separation` check
 * (loom#411 GAP-5).
 *
 * Structural probe per rules/probe-driven-verification.md MUST-3: the pure
 * predicate flagsSigningModelKeyBindings() is run over each committed fixture and
 * its flagged/clean verdict compared byte-exact to the sidecar `.expected`. NO
 * semantic judgment, NO regex on assistant prose.
 *
 * One fixture per scope-restriction predicate per cc-artifacts.md Rule 9:
 *   flag-envvar-model-key-bound-to-signing.js   → flagged (provider env-var source)
 *   flag-model-key-const-bound-to-signing.js    → flagged (_MODEL_KEY const source)
 *   flag-bare-model-key-bound-to-signing.js     → flagged (bare model[_-]?key source)
 *   clean-distinct-keys-separate-lines.js        → clean   (per-line predicate)
 *   clean-resolve-identity-signing-only.js       → clean   (invariant ii — the real signing path)
 *   clean-comment-only-mention.js                → clean   (comment-strip predicate)
 *
 * The two SCAN-level scope-restriction predicates (own-file skip, test-file skip)
 * live in scanSigningModelKeyBindings, not the pure predicate — covered by
 * .claude/test-harness/tests/scanSigningModelKeySeparation.test.mjs.
 *
 * Exit 0 = all fixtures pass. Exit 1 = >=1 mismatch.
 */
import { flagsSigningModelKeyBindings } from "../../bin/validate-emit.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

for (const name of readdirSync(here)
  .filter((n) => n.endsWith(".js"))
  .sort()) {
  const text = readFileSync(join(here, name), "utf8");
  const expected = readFileSync(
    join(here, name.replace(/\.js$/, ".expected")),
    "utf8",
  ).trim();
  const hits = flagsSigningModelKeyBindings(text);
  const actual = hits.length > 0 ? "flagged" : "clean";
  if (actual === expected) {
    passed++;
    process.stdout.write(`  PASS  ${name} → ${actual}\n`);
  } else {
    failed++;
    process.stderr.write(
      `  FAIL  ${name}: expected ${expected}, got ${actual} (${JSON.stringify(hits)})\n`,
    );
  }
}

process.stdout.write(
  `\nsigning-model-key-separation fixtures: ${passed} passed, ${failed} failed\n`,
);
process.exit(failed > 0 ? 1 : 0);
