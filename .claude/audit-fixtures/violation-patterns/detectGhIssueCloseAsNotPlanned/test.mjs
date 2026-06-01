#!/usr/bin/env node
/*
 * Audit-fixture smoke test for detectGhIssueCloseAsNotPlanned
 * (rules/value-prioritization.md MUST-4, F-3 deferred follow-up).
 *
 * Per cc-artifacts.md Rule 9: every detector ships with committed fixtures
 * covering each scope-restriction predicate (literal-vs-shell-variable,
 * reason allowlist, quote forms), plus an executable smoke test that
 * locks behavior. Predicate classes covered:
 *   1. Flag: `gh issue close N --reason not_planned` (bare)
 *   2. Flag: `gh pr close N --reason wontfix`
 *   3. Flag: `gh issue close N --reason "not_planned"` (quoted form)
 *   4. Clean: `--reason completed` (legitimate close, not an evasion)
 *   5. Clean: no gh close at all
 *   6. Skip (shell variable per hook-output-discipline.md MUST-3):
 *      `--reason "$REASON"` and `--reason $(...)`
 *
 * Run: node .claude/audit-fixtures/violation-patterns/detectGhIssueCloseAsNotPlanned/test.mjs
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
const { detectGhIssueCloseAsNotPlanned } = require(HOOKS_LIB);

function readFixture(name) {
  return fs.readFileSync(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), name),
    "utf8",
  ).trim();
}

test("flag: gh issue close --reason not_planned (bare)", () => {
  const cmd = readFixture("flag-issue-close-not-planned.txt");
  const result = detectGhIssueCloseAsNotPlanned(cmd);
  assert.notEqual(result, null, "expected flag; got null");
  assert.equal(result.rule_id, "value-prioritization/MUST-4");
  assert.equal(result.severity, "halt-and-report");
  assert.equal(result.detection_layer, "lexical");
  assert.equal(result.mode, "bash");
});

test("flag: gh pr close --reason wontfix", () => {
  const cmd = readFixture("flag-pr-close-wontfix.txt");
  const result = detectGhIssueCloseAsNotPlanned(cmd);
  assert.notEqual(result, null);
  assert.equal(result.rule_id, "value-prioritization/MUST-4");
});

test("flag: gh issue close --reason \"not_planned\" (quoted form)", () => {
  const cmd = readFixture("flag-quoted-reason.txt");
  const result = detectGhIssueCloseAsNotPlanned(cmd);
  assert.notEqual(result, null);
  assert.equal(result.rule_id, "value-prioritization/MUST-4");
});

test("clean: gh issue close --reason completed (legitimate)", () => {
  const cmd = readFixture("clean-close-completed.txt");
  const result = detectGhIssueCloseAsNotPlanned(cmd);
  assert.equal(
    result,
    null,
    `expected null; got finding: ${JSON.stringify(result)}`,
  );
});

test("clean: no gh close at all", () => {
  const cmd = readFixture("clean-no-gh-close.txt");
  const result = detectGhIssueCloseAsNotPlanned(cmd);
  assert.equal(result, null);
});

test("skip: --reason \"$REASON\" (shell variable per MUST-3)", () => {
  const cmd = readFixture("skip-shell-variable.txt");
  const result = detectGhIssueCloseAsNotPlanned(cmd);
  assert.equal(
    result,
    null,
    `expected null (skip); got finding: ${JSON.stringify(result)}`,
  );
});

test("flag: gh issue close --reason 'wontfix' (single-quoted form, Round-2 MED-C4)", () => {
  const cmd = readFixture("flag-wontfix-single-quoted.txt");
  const result = detectGhIssueCloseAsNotPlanned(cmd);
  assert.notEqual(result, null);
  assert.equal(result.rule_id, "value-prioritization/MUST-4");
});

test("flag: xargs-piped close without literal ticket id (Round-2 MED-C2)", () => {
  // The argument-order tolerance: the regex MUST flag `gh issue close
  // --reason not_planned` even when no literal ID appears (xargs
  // supplies the ID at runtime). The structural signal is the verb
  // pair + --reason flag + forbidden value.
  const cmd = readFixture("flag-no-ticket-id-xargs.txt");
  const result = detectGhIssueCloseAsNotPlanned(cmd);
  assert.notEqual(result, null);
  assert.equal(result.rule_id, "value-prioritization/MUST-4");
});

test("flag: --reason flag before ticket id (Round-2 MED-C2)", () => {
  // Argument-order tolerance — `gh issue close --reason wontfix 234`
  // is structurally equivalent to `... 234 --reason wontfix`.
  const cmd = readFixture("flag-reason-flag-before-id.txt");
  const result = detectGhIssueCloseAsNotPlanned(cmd);
  assert.notEqual(result, null);
  assert.equal(result.rule_id, "value-prioritization/MUST-4");
});

test("skip: --reason \"${REASON}\" (brace-form shell variable, Round-2 MED-C1)", () => {
  // Brace-form shell variable expansion `${VAR}` MUST be skipped
  // alongside the bare `$VAR` form per hook-output-discipline.md
  // MUST-3.
  const cmd = readFixture("skip-brace-form-shell-variable.txt");
  const result = detectGhIssueCloseAsNotPlanned(cmd);
  assert.equal(
    result,
    null,
    `expected null (skip brace-form); got finding: ${JSON.stringify(result)}`,
  );
});

test("skip: --reason `cmd` (backtick command substitution)", () => {
  // Backtick command substitution is the deprecated-but-still-valid
  // shell form; MUST be skipped same as $() per MUST-3. Fixture-based
  // per cc-artifacts.md Rule 9 (Round-3 LOW-2 cleanup).
  const cmd = readFixture("skip-backtick-substitution.txt");
  const result = detectGhIssueCloseAsNotPlanned(cmd);
  assert.equal(
    result,
    null,
    `expected null (skip backtick subst); got finding: ${JSON.stringify(result)}`,
  );
});

test("skip: --reason $(echo not_planned) (command substitution)", () => {
  const cmd = readFixture("skip-command-substitution.txt");
  const result = detectGhIssueCloseAsNotPlanned(cmd);
  assert.equal(
    result,
    null,
    `expected null (skip); got finding: ${JSON.stringify(result)}`,
  );
});

test("empty / null input returns null without throwing", () => {
  assert.equal(detectGhIssueCloseAsNotPlanned(""), null);
  assert.equal(detectGhIssueCloseAsNotPlanned(null), null);
  assert.equal(detectGhIssueCloseAsNotPlanned(undefined), null);
  assert.equal(detectGhIssueCloseAsNotPlanned(42), null);
});

test("does NOT flag: gh issue close N (no --reason flag at all)", () => {
  // A simple close without --reason flag MUST NOT trigger — the rule
  // targets explicit not_planned/wontfix dispositions, not all closures.
  const result = detectGhIssueCloseAsNotPlanned("gh issue close 234");
  assert.equal(result, null);
});

test("does NOT flag: 'gh issue close' inside prose (not a real bash command shape)", () => {
  // Sanity check on regex anchoring — the matcher requires the verb-noun
  // structure of an actual gh CLI invocation, not just keyword presence.
  const proseLike = "When you gh issue close, the reason flag matters.";
  const result = detectGhIssueCloseAsNotPlanned(proseLike);
  assert.equal(result, null);
});
