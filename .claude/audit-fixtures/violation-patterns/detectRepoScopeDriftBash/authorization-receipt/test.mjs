#!/usr/bin/env node
/*
 * Self-contained smoke test for the repo-scope-discipline.md
 * § User-Authorized Exception condition-4 receipt allowance.
 *
 * Locks: detectRepoScopeDriftBash returns null for an off-repo
 * `gh --repo` command IFF a recent journal entry carries the greppable
 * marker `cross-repo-authorized: <exact-target-slug>`. No marker /
 * wrong slug / stale (>6h) → halt-and-report preserved.
 *
 * Run: node .claude/audit-fixtures/violation-patterns/detectRepoScopeDriftBash/authorization-receipt/test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HOOKS_LIB = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "..",
  "..",
  "hooks",
  "lib",
  "violation-patterns.js",
);
const { detectRepoScopeDriftBash, hasCrossRepoAuthorizationReceipt } =
  require(HOOKS_LIB);

const TARGET = "Org/target";
const CMD = `gh issue create --repo ${TARGET} --title t --body b`;

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsd-receipt-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "journal"), { recursive: true });
  return dir;
}
function writeReceipt(dir, rel, slug, ageMs = 0) {
  const fp = path.join(dir, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(
    fp,
    `---\ntype: DECISION\n---\n# Cross-repo authorized\n\ncross-repo-authorized: ${slug}\n`,
  );
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(fp, t, t);
  }
  return fp;
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("recent receipt for exact target slug → in-scope (null)", () => {
  const dir = mkRepo();
  try {
    writeReceipt(dir, "journal/0001-DECISION-x.md", TARGET);
    assert.equal(hasCrossRepoAuthorizationReceipt(TARGET, dir), true);
    assert.equal(detectRepoScopeDriftBash(CMD, dir), null);
  } finally {
    rm(dir);
  }
});

test("no receipt → halt-and-report (NOT a blanket relaxation)", () => {
  const dir = mkRepo();
  try {
    const r = detectRepoScopeDriftBash(CMD, dir);
    assert.ok(r && r.severity === "halt-and-report", "MUST still flag");
    assert.equal(r.rule_id, "repo-scope-discipline/MUST-NOT-1");
  } finally {
    rm(dir);
  }
});

test("receipt for a DIFFERENT slug → still flags (slug-specific)", () => {
  const dir = mkRepo();
  try {
    writeReceipt(dir, "journal/0001-DECISION-x.md", "Org/other");
    assert.equal(hasCrossRepoAuthorizationReceipt(TARGET, dir), false);
    const r = detectRepoScopeDriftBash(CMD, dir);
    assert.ok(r && r.severity === "halt-and-report");
  } finally {
    rm(dir);
  }
});

test("stale receipt (>6h) → still flags (condition 5, no cross-session reuse)", () => {
  const dir = mkRepo();
  try {
    writeReceipt(dir, "journal/0001-DECISION-x.md", TARGET, 7 * 3600 * 1000);
    assert.equal(hasCrossRepoAuthorizationReceipt(TARGET, dir), false);
    const r = detectRepoScopeDriftBash(CMD, dir);
    assert.ok(r && r.severity === "halt-and-report");
  } finally {
    rm(dir);
  }
});

test("receipt in workspace journal/.pending → in-scope (null)", () => {
  const dir = mkRepo();
  try {
    writeReceipt(
      dir,
      "workspaces/demo/journal/.pending/0001-DECISION-x.md",
      TARGET,
    );
    assert.equal(hasCrossRepoAuthorizationReceipt(TARGET, dir), true);
    assert.equal(detectRepoScopeDriftBash(CMD, dir), null);
  } finally {
    rm(dir);
  }
});
