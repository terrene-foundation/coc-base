#!/usr/bin/env node
/*
 * Audit-fixture smoke test for detectDeferralWithoutValueAnchor
 * (rules/value-prioritization.md MUST-2).
 *
 * Per cc-artifacts.md Rule 9: every detector ships with committed fixtures
 * covering each scope-restriction predicate, plus an executable test that
 * locks behavior. This test exercises ONLY detectDeferralWithoutValueAnchor;
 * the sibling detector has its own test at
 * `../detectStreetlightSelection/test.mjs`.
 *
 * Run: node .claude/audit-fixtures/violation-patterns/detectDeferralWithoutValueAnchor/test.mjs
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
const { detectDeferralWithoutValueAnchor } = require(HOOKS_LIB);

function readFixture(name) {
  return fs.readFileSync(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), name),
    "utf8",
  );
}

test("flag: Carried-forward (no grace clock) without value-anchor", () => {
  const text = readFixture("flag-carried-forward-no-anchor.txt");
  const result = detectDeferralWithoutValueAnchor(text);
  assert.notEqual(result, null, "expected flag; got null");
  assert.equal(result.rule_id, "value-prioritization/MUST-2");
  assert.equal(result.severity, "advisory");
});

test("flag: tracked separately / deferred to follow-up without value-anchor", () => {
  const text = readFixture("flag-tracked-separately-no-anchor.txt");
  const result = detectDeferralWithoutValueAnchor(text);
  assert.notEqual(result, null);
  assert.equal(result.rule_id, "value-prioritization/MUST-2");
});

test("flag: OR-escape-hatch as deferral disposition without value-anchor", () => {
  const text = readFixture("flag-or-escape-hatch-deferral.txt");
  const result = detectDeferralWithoutValueAnchor(text);
  assert.notEqual(result, null);
  assert.equal(result.rule_id, "value-prioritization/MUST-2");
});

test("clean: deferral marker WITH adjacent Value-anchor: line", () => {
  const text = readFixture("clean-value-anchor-present.txt");
  const result = detectDeferralWithoutValueAnchor(text);
  assert.equal(
    result,
    null,
    `expected null; got finding: ${JSON.stringify(result)}`,
  );
});

test("clean: session notes with no deferral language", () => {
  const text = readFixture("clean-no-deferral-language.txt");
  const result = detectDeferralWithoutValueAnchor(text);
  assert.equal(result, null);
});

test("clean: legitimate Phase II / wishlist usage outside deferral context", () => {
  // Round-2 reviewer MED-R2-1: Phase II in migration phasing (not
  // deferral) and "wishlist" in user feature description should NOT
  // flag. Tier-2 markers require deferral-context proximity.
  const text = readFixture("clean-legitimate-phase-usage.txt");
  const result = detectDeferralWithoutValueAnchor(text);
  assert.equal(
    result,
    null,
    `expected null; got finding: ${JSON.stringify(result)}`,
  );
});

test("flag: PM-cadence deferral euphemisms (sprint / quarter / OKR)", () => {
  // Round-2 analyst E-2: regex didn't match sprint/iteration/OKR cadence
  // vocabulary. Regression-lock for DEFERRAL_MARKER_TIER2 expansion.
  const text = readFixture("flag-pm-cadence-deferral.txt");
  const result = detectDeferralWithoutValueAnchor(text);
  assert.notEqual(result, null, "expected flag; got null");
  assert.equal(result.rule_id, "value-prioritization/MUST-2");
});
