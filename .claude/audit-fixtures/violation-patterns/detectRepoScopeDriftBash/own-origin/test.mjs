#!/usr/bin/env node
/*
 * Self-contained smoke test for the OWN-ORIGIN allowance in
 * detectRepoScopeDriftBash (repo-scope-discipline.md MUST-NOT-1).
 *
 * Locks: a `gh --repo <slug>` command is in-scope (returns null) when
 * <slug> matches the CWD repo's own `origin` remote — including from a git
 * WORKTREE whose directory basename differs from the repo slug (the
 * basename heuristic cannot see this; origin resolution can). A DIFFERENT
 * slug with no origin/upstream/receipt match still halts-and-reports.
 *
 * Root cause it regression-locks: before this allowance, the detector
 * decided in-scope by `targetRepo.includes(path.basename(cwd))`. In a
 * worktree (cwd basename e.g. "gate-admin" for repo "Org/loom") the
 * basename never appears in the slug, so every owner `gh pr create/view/
 * merge --repo Org/loom` false-flagged. Origin resolution is worktree-safe
 * (worktrees share the common .git → same `origin`).
 *
 * Run: node .claude/audit-fixtures/violation-patterns/detectRepoScopeDriftBash/own-origin/test.mjs
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
const { detectRepoScopeDriftBash } = require(HOOKS_LIB);

const ORIGIN_SLUG = "Org/loom";
const ORIGIN_URL = "git@github.com:Org/loom.git";

// Build a temp repo whose CHECKOUT DIRECTORY basename differs from the repo
// slug (reproducing the worktree case: dir "wt-gate-admin" vs slug "Org/loom"),
// with `origin` set to ORIGIN_URL.
function mkRepoWithOrigin() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rsd-origin-"));
  const dir = path.join(parent, "wt-gate-admin"); // basename != slug on purpose
  fs.mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", ORIGIN_URL], { cwd: dir });
  return { parent, dir };
}
function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

test("gh --repo <own-origin> from a worktree-shaped dir → in-scope (null)", () => {
  const { parent, dir } = mkRepoWithOrigin();
  try {
    const cmd = `gh pr create --repo ${ORIGIN_SLUG} --base main --head codify/x --title t --body b`;
    assert.equal(detectRepoScopeDriftBash(cmd, dir), null);
  } finally {
    rm(parent);
  }
});

test("gh pr merge --repo <own-origin> (https origin form) → in-scope (null)", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rsd-origin-https-"));
  const dir = path.join(parent, "some-other-dirname");
  try {
    fs.mkdirSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/Org/loom.git"],
      { cwd: dir },
    );
    assert.equal(
      detectRepoScopeDriftBash(`gh pr merge 1 --repo ${ORIGIN_SLUG} --admin`, dir),
      null,
    );
  } finally {
    rm(parent);
  }
});

test("gh --repo <different-slug> with origin set → still halts (no over-suppression)", () => {
  const { parent, dir } = mkRepoWithOrigin();
  try {
    const r = detectRepoScopeDriftBash(
      "gh issue create --repo Other/repo --title t --body b",
      dir,
    );
    assert.ok(r && r.severity === "halt-and-report", "cross-repo MUST still flag");
    assert.equal(r.rule_id, "repo-scope-discipline/MUST-NOT-1");
  } finally {
    rm(parent);
  }
});

test("no origin remote + basename mismatch → existing halt behavior preserved", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rsd-noremote-"));
  const dir = path.join(parent, "unrelated-dir");
  try {
    fs.mkdirSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const r = detectRepoScopeDriftBash(
      "gh issue create --repo Org/loom --title t --body b",
      dir,
    );
    assert.ok(r && r.severity === "halt-and-report");
  } finally {
    rm(parent);
  }
});
