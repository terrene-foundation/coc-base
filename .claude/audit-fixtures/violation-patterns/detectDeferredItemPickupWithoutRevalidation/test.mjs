#!/usr/bin/env node
/*
 * Audit-fixture smoke test for detectDeferredItemPickupWithoutRevalidation
 * (rules/value-prioritization.md MUST-3, F-2 deferred follow-up).
 *
 * Per cc-artifacts.md Rule 9: every detector ships with committed fixtures
 * covering each scope-restriction predicate, plus an executable test that
 * locks behavior. Three predicate classes are covered:
 *   1. Pickup-without-revalidation flags (3 fixtures: deferred shard,
 *      ticketed issue, Carried-forward)
 *   2. Revalidation-cancel clean (the agent picks up AND surfaces the
 *      MUST-3 re-validation prose — null finding)
 *   3. No-pickup clean (no deferred-item pickup language at all)
 *   4. Deferred-mentioned-not-pickup clean (agent reports deferred items
 *      exist without picking them up — null finding)
 *
 * Run: node .claude/audit-fixtures/violation-patterns/detectDeferredItemPickupWithoutRevalidation/test.mjs
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
const { detectDeferredItemPickupWithoutRevalidation } = require(HOOKS_LIB);

function readFixture(name) {
  return fs.readFileSync(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), name),
    "utf8",
  );
}

test("flag: resuming a deferred shard without re-validation", () => {
  const text = readFixture("flag-resuming-deferred-shard.txt");
  const result = detectDeferredItemPickupWithoutRevalidation(text);
  assert.notEqual(result, null, "expected flag; got null");
  assert.equal(result.rule_id, "value-prioritization/MUST-3");
  assert.equal(result.severity, "advisory");
  assert.equal(result.detection_layer, "lexical");
  assert.equal(result.mode, "response");
});

test("flag: picking up a ticketed issue from prior session without re-validation", () => {
  const text = readFixture("flag-picking-up-issue-no-revalidation.txt");
  const result = detectDeferredItemPickupWithoutRevalidation(text);
  assert.notEqual(result, null);
  assert.equal(result.rule_id, "value-prioritization/MUST-3");
});

test("flag: continuing Carried-forward without re-validation", () => {
  const text = readFixture("flag-continuing-carried-forward.txt");
  const result = detectDeferredItemPickupWithoutRevalidation(text);
  assert.notEqual(result, null);
  assert.equal(result.rule_id, "value-prioritization/MUST-3");
});

test("clean: pickup with adjacent re-validation surface (within 250 chars)", () => {
  const text = readFixture("clean-revalidation-present.txt");
  const result = detectDeferredItemPickupWithoutRevalidation(text);
  assert.equal(
    result,
    null,
    `expected null; got finding: ${JSON.stringify(result)}`,
  );
});

test("clean: no pickup language at all", () => {
  const text = readFixture("clean-no-pickup.txt");
  const result = detectDeferredItemPickupWithoutRevalidation(text);
  assert.equal(result, null);
});

test("clean: agent reports deferred items exist but does not pick them up", () => {
  // The agent describes the Carried-forward queue contents from prior
  // session WITHOUT a pickup verb adjacent to the deferred-noun. The
  // 80-char proximity requirement filters this case out of the regex.
  const text = readFixture("clean-deferred-mentioned-not-pickup.txt");
  const result = detectDeferredItemPickupWithoutRevalidation(text);
  assert.equal(
    result,
    null,
    `expected null; got finding: ${JSON.stringify(result)}`,
  );
});

test("clean: revalidation marker JUST INSIDE 250-char proximity boundary (Round-2 MED-C3)", () => {
  // Boundary-lock fixture — the proximity model is ±250 chars. A
  // revalidation marker exactly within the window MUST cancel the
  // finding. Locks the proximity contract.
  const text = readFixture("clean-revalidation-just-inside-250.txt");
  const result = detectDeferredItemPickupWithoutRevalidation(text);
  assert.equal(
    result,
    null,
    `expected null (within proximity); got finding: ${JSON.stringify(result)}`,
  );
});

test("flag: revalidation marker JUST OUTSIDE 250-char proximity boundary (Round-2 MED-C3)", () => {
  // Boundary-lock fixture — revalidation marker beyond 250 chars from
  // the pickup marker MUST NOT cancel the finding. The proximity
  // window is intentionally narrow so a distant revalidation surface
  // does not appear to satisfy the gate when it semantically does not.
  const text = readFixture("flag-revalidation-just-outside-250.txt");
  const result = detectDeferredItemPickupWithoutRevalidation(text);
  assert.notEqual(result, null, "expected flag (revalidation too far); got null");
  assert.equal(result.rule_id, "value-prioritization/MUST-3");
});

test("empty / null input returns null without throwing", () => {
  assert.equal(detectDeferredItemPickupWithoutRevalidation(""), null);
  assert.equal(detectDeferredItemPickupWithoutRevalidation(null), null);
  assert.equal(detectDeferredItemPickupWithoutRevalidation(undefined), null);
  assert.equal(detectDeferredItemPickupWithoutRevalidation(42), null);
});
