#!/usr/bin/env node
/*
 * Self-contained smoke test for the repo-scope-discipline.md
 * § User-Authorized Exception condition-4 receipt allowance.
 *
 * Locks: detectRepoScopeDriftBash returns null for an off-repo
 * `gh --repo` command IFF a recent journal entry carries the greppable
 * TIERED marker `cross-repo-authorized: <exact-target-slug> <mode>` (journal/0488)
 * with a content `timestamp:` inside the 6h window. No marker / wrong slug /
 * stale (>6h content timestamp) → halt-and-report preserved.
 *
 * Run: node .claude/audit-fixtures/violation-patterns/detectRepoScopeDriftBash/authorization-receipt/test.mjs
 */
import "../../../_lib/no-ambient-git.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HOOKS_LIB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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
function writeReceipt(dir, rel, slug, ageMs = 0, mode = "write") {
  const fp = path.join(dir, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  // TIERED format (journal/0488): the reader requires the whole-line marker
  // `cross-repo-authorized: <slug> <mode>` AND a content `timestamp:` within the
  // 6h window (mtime is no longer consulted). Default is a `write` receipt —
  // strictly stronger, so it clears both write- and read-intent per the tier
  // rule — and staleness is driven through the CONTENT timestamp (ageMs), not
  // `fs.utimesSync`.
  const ts = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(
    fp,
    `---\ntype: DECISION\ntimestamp: ${ts}\n---\n# Cross-repo authorized\n\ncross-repo-authorized: ${slug} ${mode}\n`,
  );
  return fp;
}

// ---------------------------------------------------------------------------
// #174 — WORKTREE-WIDE receipt resolution.
//
// `hasCrossRepoAuthorizationReceipt` used to build its whole search list from
// `repoRoot(cwd)` — ONE worktree's toplevel. The session cwd and the cwd a
// guarded command runs in are routinely DIFFERENT worktrees of one repo, which
// is the normal shape of parallel lane work; an operator who ran the sanctioned
// `/cross-repo-authorize` affordance and held a correctly-formed receipt was
// halted anyway by the guard that demanded it. The rows below lock the fix:
// a receipt in ANY worktree clears the action, while every other bound the
// search already had (tier, exact slug, 6h window, both-sided age, the
// `_`/`instructions` workspace exclusion) is UNCHANGED.
//
// The input here is a filesystem TOPOLOGY (linked worktrees sharing one
// common-dir), which no `.txt` fixture can express — hence a programmatic set
// alongside the string fixtures rather than a new fixture file per case.
// ---------------------------------------------------------------------------

// realpath'd, and every forest rooted under it: `git worktree list` reports the
// paths git recorded while `rev-parse --git-common-dir` answers relative to the
// caller, and on macOS the tmpdir spelling is a symlink — a forest built on the
// unresolved path can make two spellings of ONE common-dir compare unequal,
// which is exactly the containment check under test.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rsd-wt-")));
let _forest = 0;

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A scratch repo plus two LINKED worktrees A and B, sharing one common-dir. */
function mkForest() {
  const base = path.join(TMP, `forest-${_forest++}`);
  const main = path.join(base, "repo");
  fs.mkdirSync(main, { recursive: true });
  git(["init", "-q", "-b", "main"], main);
  git(["config", "user.email", "fixture@example.invalid"], main);
  git(["config", "user.name", "fixture"], main);
  fs.writeFileSync(path.join(main, "README.md"), "fixture\n");
  git(["add", "-A"], main);
  git(["commit", "-qm", "init"], main);
  const a = path.join(base, "wt-a");
  const b = path.join(base, "wt-b");
  git(["worktree", "add", "--detach", "-q", a, "HEAD"], main);
  git(["worktree", "add", "--detach", "-q", b, "HEAD"], main);
  return { base, main, a, b };
}

test("#174 fixture sanity — three worktrees really share one common-dir", () => {
  const { base, main, a, b } = mkForest();
  try {
    // If this drifts (a `.git` directory instead of a linked worktree file, or a
    // forest that is not a forest) every worktree row below is vacuous.
    assert.ok(
      fs.statSync(path.join(main, ".git")).isDirectory(),
      "fixture: main MUST be a plain checkout",
    );
    assert.ok(
      fs.statSync(path.join(b, ".git")).isFile(),
      "fixture: B MUST be a LINKED worktree (.git is a file there)",
    );
    const forest = git(["worktree", "list", "--porcelain"], b);
    const count = (forest.match(/^worktree /gm) || []).length;
    assert.equal(
      count,
      3,
      `fixture sanity: expected main + A + B; porcelain reported ${count}`,
    );
    void a;
  } finally {
    rm(base);
  }
});

test("#174 negative control — no receipt anywhere → still halts from a sibling", () => {
  const { base, b } = mkForest();
  try {
    // Without this row a later `true` would be a statement about the search's
    // eagerness, not about the receipt.
    assert.equal(hasCrossRepoAuthorizationReceipt(TARGET, b), false);
    const r = detectRepoScopeDriftBash(CMD, b);
    assert.ok(r && r.severity === "halt-and-report", "MUST still flag");
  } finally {
    rm(base);
  }
});

test("#174 a receipt in worktree A is authoritative from A, B and main", () => {
  const { base, main, a, b } = mkForest();
  try {
    writeReceipt(a, ".claude/cross-repo-authz/fixture-receipt.md", TARGET);
    assert.equal(
      hasCrossRepoAuthorizationReceipt(TARGET, a),
      true,
      "positive control: the receipt is not found even where it was written",
    );
    assert.equal(
      hasCrossRepoAuthorizationReceipt(TARGET, b),
      true,
      "#174: a valid receipt in a sibling worktree is invisible to the guard",
    );
    assert.equal(
      hasCrossRepoAuthorizationReceipt(TARGET, main),
      true,
      "#174: a valid receipt in a linked worktree is invisible from the main checkout",
    );
    assert.equal(detectRepoScopeDriftBash(CMD, b), null, "the guard MUST clear it");
  } finally {
    rm(base);
  }
});

test("#174 workspace-journal paths survive PER WORKTREE, incl. .pending/", () => {
  const { base, a, b } = mkForest();
  try {
    // The per-root refactor moved these lines into a helper; these rows prove
    // the `workspaces/<ws>/journal/` and `.pending/` paths still resolve for a
    // root that is NOT the caller's own.
    writeReceipt(a, "workspaces/demo-ws/journal/0001-DECISION-x.md", TARGET);
    assert.equal(
      hasCrossRepoAuthorizationReceipt(TARGET, b),
      true,
      "the per-worktree workspaces/<ws>/journal/ search path was lost",
    );
    fs.rmSync(path.join(a, "workspaces", "demo-ws", "journal", "0001-DECISION-x.md"), {
      force: true,
    });
    writeReceipt(a, "workspaces/demo-ws/journal/.pending/0002-DECISION-x.md", TARGET);
    assert.equal(
      hasCrossRepoAuthorizationReceipt(TARGET, b),
      true,
      "the per-worktree workspaces/<ws>/journal/.pending/ search path was lost",
    );
  } finally {
    rm(base);
  }
});

test("#174 `_`-prefixed and `instructions` workspaces stay EXCLUDED in a sibling", () => {
  const { base, a, b } = mkForest();
  try {
    writeReceipt(a, "workspaces/_template/journal/0003-DECISION-x.md", TARGET);
    assert.equal(
      hasCrossRepoAuthorizationReceipt(TARGET, b),
      false,
      "a receipt under workspaces/_template/ cleared the gate — the search surface widened",
    );
    fs.rmSync(path.join(a, "workspaces", "_template"), { recursive: true, force: true });
    writeReceipt(a, "workspaces/instructions/journal/0004-DECISION-x.md", TARGET);
    assert.equal(
      hasCrossRepoAuthorizationReceipt(TARGET, b),
      false,
      "a receipt under workspaces/instructions/ cleared the gate",
    );
  } finally {
    rm(base);
  }
});

test("#174 widening the SEARCH widens nothing else — tier, slug, age", () => {
  const { base, a, b } = mkForest();
  try {
    const rel = ".claude/cross-repo-authz/fixture-receipt.md";

    // Tier: a `read` receipt in a sibling must NOT clear a `write` action.
    writeReceipt(a, rel, TARGET, 0, "read");
    assert.equal(
      hasCrossRepoAuthorizationReceipt(TARGET, b, "read"),
      true,
      "control: the read receipt must be found from a sibling at all",
    );
    assert.equal(
      hasCrossRepoAuthorizationReceipt(TARGET, b, "write"),
      false,
      "tier collapse: a cheap read receipt cleared a write action across worktrees",
    );

    // Slug: a longer receipt must not clear a shorter request.
    writeReceipt(a, rel, `${TARGET}-internal`, 0, "read");
    assert.equal(
      hasCrossRepoAuthorizationReceipt(TARGET, b, "read"),
      false,
      `a receipt for ${TARGET}-internal cleared ${TARGET}`,
    );

    // Age, both directions: the sweep widens WHERE we look, not WHEN.
    writeReceipt(a, rel, TARGET, 7 * 3600 * 1000, "read");
    assert.equal(
      hasCrossRepoAuthorizationReceipt(TARGET, b, "read"),
      false,
      "the search widened the AGE WINDOW: an expired sibling receipt cleared the gate",
    );
    writeReceipt(a, rel, TARGET, -3 * 3600 * 1000, "read");
    assert.equal(
      hasCrossRepoAuthorizationReceipt(TARGET, b, "read"),
      false,
      "a FUTURE-dated sibling receipt authorizes indefinitely",
    );
  } finally {
    rm(base);
  }
});
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
