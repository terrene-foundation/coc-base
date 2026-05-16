#!/usr/bin/env node
/*
 * Acceptance test — extract-policies.mjs vs. validator-13 fixtures.
 *
 * Contract (spec v6 §4.4): the extractor MUST emit bijective matching
 * against expected-policies.json on the three shape fixtures. Missing
 * OR extra predicate entries fail acceptance.
 *
 * Exit codes:
 *   0 — bijection holds; shape + reason_template match for every fixture
 *   1 — mismatch; diff printed to stderr
 *
 * Usage:
 *   node test-extract-policies.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractPolicies } from "./extract-policies.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Layout detection (same shape as server.js::resolveCocRoot — validator-13
// fixtures live under <coc-root>/fixtures/validator-13/). At loom dev this
// resolves to <repo>/.claude; at multi-CLI USE templates / coc-projects it
// resolves to <repo>/.claude via the .codex-mcp-guard/ → ../.claude
// detection. Previously hard-coded `..`,`..` which only resolved correctly
// at the loom layout (.claude/codex-mcp-guard/) and was off-by-one when
// emitted to multi-CLI top-level layout (.codex-mcp-guard/).
function resolveCocRoot(here) {
  const loomDev = path.resolve(here, "..");
  if (fs.existsSync(path.join(loomDev, "fixtures"))) return loomDev;
  const useTemplate = path.resolve(here, "..", ".claude");
  if (fs.existsSync(path.join(useTemplate, "fixtures"))) return useTemplate;
  return loomDev;
}
const COC_ROOT = resolveCocRoot(__dirname);
const FIXTURE_DIR = path.join(COC_ROOT, "fixtures", "validator-13");
const EXPECTED_PATH = path.join(FIXTURE_DIR, "expected-policies.json");

// ────────────────────────────────────────────────────────────────
// Run extractor + load expected
// ────────────────────────────────────────────────────────────────
const actual = extractPolicies(FIXTURE_DIR);
const expected = JSON.parse(fs.readFileSync(EXPECTED_PATH, "utf8"));

// Map actual predicates by id for O(1) lookup; drop the
// auto-generated expected-policies.json fixture from the actual set
// (the extractor will ignore it since it's .json not .js, but guard).
const actualById = new Map(
  actual.predicates.map((p) => [p.id, p]),
);

// ────────────────────────────────────────────────────────────────
// Bijection + shape + reason_template check
// ────────────────────────────────────────────────────────────────
const failures = [];

for (const fixture of expected.fixtures) {
  const expectedId = fixture.predicate.id;
  const got = actualById.get(expectedId);

  if (!got) {
    failures.push(
      `MISSING: expected predicate id=${expectedId} (shape ${fixture.shape}) not found in extractor output`,
    );
    continue;
  }

  if (got.shape !== fixture.shape) {
    failures.push(
      `SHAPE MISMATCH: ${expectedId} expected shape=${fixture.shape}, got shape=${got.shape}`,
    );
  }

  if (got.source_file !== fixture.file) {
    failures.push(
      `SOURCE FILE MISMATCH: ${expectedId} expected file=${fixture.file}, got file=${got.source_file}`,
    );
  }

  if (got.reason_template !== fixture.predicate.reason_template) {
    failures.push(
      `REASON MISMATCH: ${expectedId}\n  expected: ${JSON.stringify(fixture.predicate.reason_template)}\n  actual:   ${JSON.stringify(got.reason_template)}`,
    );
  }

  actualById.delete(expectedId); // consumed
}

// After consuming expected entries, any remaining actual entries are extras.
for (const [id, got] of actualById) {
  failures.push(
    `EXTRA: extractor emitted predicate id=${id} (shape ${got.shape}, file ${got.source_file}) not in expected-policies.json`,
  );
}

// ────────────────────────────────────────────────────────────────
// Report
// ────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  const count = expected.fixtures.length;
  process.stdout.write(
    `PASS  validator-13 extractor: ${count}/${count} predicates match (${expected.fixtures.map((f) => f.shape).join(", ")}).\n`,
  );
  process.exit(0);
} else {
  process.stderr.write("FAIL  validator-13 extractor bijection:\n");
  for (const f of failures) {
    process.stderr.write(`  - ${f}\n`);
  }
  process.stderr.write("\nExtractor output:\n");
  process.stderr.write(JSON.stringify(actual, null, 2) + "\n");
  process.exit(1);
}
