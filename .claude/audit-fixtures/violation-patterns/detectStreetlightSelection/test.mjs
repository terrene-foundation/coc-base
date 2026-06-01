#!/usr/bin/env node
/*
 * Audit-fixture smoke test for detectStreetlightSelection
 * (rules/value-prioritization.md MUST-1).
 *
 * Per cc-artifacts.md Rule 9: every detector ships with committed fixtures
 * covering each scope-restriction predicate, plus an executable test that
 * locks behavior. This test exercises ONLY detectStreetlightSelection;
 * the sibling detector has its own test at
 * `../detectDeferralWithoutValueAnchor/test.mjs`.
 *
 * Run: node .claude/audit-fixtures/violation-patterns/detectStreetlightSelection/test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HOOKS_LIB = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "..",
  "hooks",
  "lib",
  "violation-patterns.js",
);
const { detectStreetlightSelection } = require(HOOKS_LIB);

function readFixture(name) {
  return fs.readFileSync(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), name),
    "utf8",
  );
}

test("flag: fittability-pick over carried-forward without value-rank", () => {
  const text = readFixture("flag-fittability-pick-no-rank.txt");
  const result = detectStreetlightSelection(text);
  assert.notEqual(result, null, "expected flag; got null");
  assert.equal(result.rule_id, "value-prioritization/MUST-1");
  assert.equal(result.severity, "advisory");
});

test("flag: OR-escape-hatch in red-team disposition", () => {
  const text = readFixture("flag-or-escape-hatch.txt");
  const result = detectStreetlightSelection(text);
  assert.notEqual(result, null, "expected flag; got null");
  assert.equal(result.rule_id, "value-prioritization/MUST-1");
});

test("flag: pick-anchor euphemisms (Leaning toward / Best path forward / Will start with)", () => {
  // Round-2 analyst E-1: prose enumerates these but original regex didn't
  // match. Regression-lock for the RECOMMENDATION_ANCHOR expansion.
  const text = readFixture("flag-leaning-toward-euphemism.txt");
  const result = detectStreetlightSelection(text);
  assert.notEqual(result, null, "expected flag; got null");
  assert.equal(result.rule_id, "value-prioritization/MUST-1");
});

test("clean: value-ranked candidate list with named trade-off", () => {
  const text = readFixture("clean-value-ranked-named-tradeoff.txt");
  const result = detectStreetlightSelection(text);
  assert.equal(
    result,
    null,
    `expected null; got finding: ${JSON.stringify(result)}`,
  );
});

test("clean: single candidate (no candidate set surfaced)", () => {
  const text = readFixture("clean-single-candidate.txt");
  const result = detectStreetlightSelection(text);
  assert.equal(result, null);
});

test("clean: candidates listed without pick anchor (different rule covers it)", () => {
  // No "I recommend" / "Going with" — this is menu-without-pick, not
  // streetlight; detectMenuWithoutPick handles that case.
  const text = readFixture("clean-no-pick-anchor.txt");
  const result = detectStreetlightSelection(text);
  assert.equal(result, null);
});
