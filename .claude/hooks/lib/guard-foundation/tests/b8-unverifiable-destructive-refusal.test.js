/**
 * B8 — an UNVERIFIABLE target at the destructive fence must REFUSE.
 *
 * THE DETERMINATION, measured behaviorally before this change (this worktree,
 * validate-bash-command run directly with PreToolUse payloads):
 *
 *   git -C "$(pwd)"   reset --hard HEAD   -> rc 0, continue:true  <- the command RUNS
 *   git -C "${WT}"    reset --hard HEAD   -> rc 0, continue:true  <- the command RUNS
 *   git -C "$(pwd)"   clean -fd           -> rc 0, continue:true  <- the command RUNS
 *   rm -rf $someTarget                    -> rc 0, continue:true  <- the command RUNS
 *   rm -rf "$(some_cmd)"                  -> rc 0, continue:true  <- the command RUNS
 *
 * Each of those emissions carried `severity: "halt-and-report"` — and
 * halt-and-report maps to continue:true (lib/instruct-and-wait.js), so on a
 * MUTATION fence it is not a softer refusal but no refusal at all. The
 * branches' own doctrine text already said "an unverifiable target ranks
 * TIGHTEST at a fail-closed destructive-op fence"; the behavior did the
 * opposite. Ruling: unverifiable REFUSES (rc 2, named reason).
 *
 * THE BENIGN TWINS MUST NOT NEWLY REFUSE: a verifiable clean-tree `--hard`,
 * a verifiable clean-of-untracked `clean -fd`, and `reset --keep` are the
 * advisory paths and keep their current posture (rc 0). The dirty-tree and
 * untracked-file structural blocks are exercised here too, as ANTI-VACUITY
 * controls: the fence must still discriminates verifiable DIRTY from
 * unverifiable, or the new refusals could pass vacuously.
 *
 * Run: node --test .claude/hooks/lib/guard-foundation/tests/b8-unverifiable-destructive-refusal.test.js
 */

"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// loom#1471 regrowth guard: this file spawns git fixtures, so EVERY call must
// pass the RESOLVED absolute binary from the shared allowlist helper — never
// the literal `git` string — and the constants-built env (`gitEnvForArgs`), so
// an ambient GIT_DIR / GIT_WORK_TREE from a settings.json env block cannot
// re-point these fixture calls at another repository.
const {
  resolveGitBinary,
  gitEnvForArgs,
} = require("../../git-subprocess-env.js");

const REPO = path.resolve(__dirname, "..", "..", "..", "..", "..");
const HOOK = path.join(REPO, ".claude", "hooks", "validate-bash-command.js");
const BLOCKED = 2;

function runHook(command) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_input: { command }, cwd: REPO }),
    cwd: REPO,
    encoding: "utf8",
    timeout: 30000,
  });
  let reason = "";
  try {
    const j = JSON.parse(res.stdout.trim().split("\n").pop());
    reason =
      (j.hookSpecificOutput && j.hookSpecificOutput.permissionDecisionReason) ||
      "";
  } catch {
    reason = "";
  }
  return { status: res.status, reason };
}

// Fixture repos for the structural blocks that must keep firing and for the
// zero-loss legs (B8 ruling (1)): dirty / untracked / stash / unpushed-clean /
// zero-loss-clean.
let dirtyRepo;
let untrackedRepo;
let stashRepo;
let unpushedRepo;
let cleanRepo;

function git(cwd, args) {
  return spawnSync(resolveGitBinary(), args, {
    cwd,
    encoding: "utf8",
    timeout: 20000,
    env: gitEnvForArgs(args),
  });
}

function initRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ["init", "-q"]);
  fs.writeFileSync(path.join(dir, "file.txt"), "one\n");
  git(dir, ["add", "file.txt"]);
  git(dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
  return dir;
}

before(() => {
  dirtyRepo = initRepo("gf-b8-dirty-");
  fs.writeFileSync(path.join(dirtyRepo, "file.txt"), "modified\n"); // dirty

  untrackedRepo = fs.mkdtempSync(path.join(os.tmpdir(), "gf-b8-untracked-"));
  git(untrackedRepo, ["init", "-q"]);
  fs.writeFileSync(path.join(untrackedRepo, "untracked.txt"), "x\n"); // untracked

  stashRepo = initRepo("gf-b8-stash-");
  fs.writeFileSync(path.join(stashRepo, "file.txt"), "parked\n");
  git(stashRepo, ["stash", "-q"]); // clean tree, one stash entry

  unpushedRepo = initRepo("gf-b8-unpushed-");
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "gf-b8-bare-"));
  git(bare, ["init", "-q", "--bare"]);
  git(unpushedRepo, ["remote", "add", "origin", bare]); // remote exists, nothing pushed

  cleanRepo = initRepo("gf-b8-clean-"); // clean tree, no stash, no remote
});

after(() => {
  for (const dir of [
    dirtyRepo,
    untrackedRepo,
    stashRepo,
    unpushedRepo,
    cleanRepo,
  ]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("B8 RED CASE: unverifiable destructive targets REFUSE (reset/clean -C-substituted, rm -rf unassessable)", () => {
  const cases = [
    ['git -C "$(pwd)" reset --hard HEAD', /cannot resolve/i],
    ['git -C "${WT}" reset --hard HEAD', /cannot resolve/i],
    ['git -C "$(pwd)" clean -fd', /cannot resolve/i],
    ["rm -rf $someTarget", /could NOT assess/i],
    ['rm -rf "$(some_cmd)"', /could NOT assess/i],
  ];
  for (const [cmd, reasonRx] of cases) {
    const r = runHook(cmd);
    assert.equal(
      r.status,
      BLOCKED,
      `unverifiable destructive target must REFUSE (rc 2), got ${r.status}: ${cmd}`,
    );
    assert.match(
      r.reason,
      reasonRx,
      `the refusal must NAME why (unverifiable target): ${cmd}`,
    );
  }
});

test("B8 TWINS: verifiable clean-tree / --keep / clean-of-untracked keep their advisory posture (rc 0)", () => {
  const twins = [
    `git -C ${REPO} reset --hard HEAD`,
    `git -C ${REPO} clean -fd`,
    "git reset --keep HEAD",
  ];
  for (const cmd of twins) {
    assert.notEqual(
      runHook(cmd).status,
      BLOCKED,
      `the benign twin must NOT newly refuse: ${cmd}`,
    );
  }
});

test("B8 ANTI-VACUITY: the VERIFIABLE structural blocks still fire (dirty tree, untracked files)", () => {
  const dirty = runHook(`git -C ${dirtyRepo} reset --hard HEAD`);
  assert.equal(
    dirty.status,
    BLOCKED,
    "a verifiable DIRTY tree still blocks --hard",
  );
  assert.match(
    dirty.reason,
    /dirty/i,
    "the dirty-tree refusal names the structural signal",
  );

  const untracked = runHook(`git -C ${untrackedRepo} clean -fd`);
  assert.equal(
    untracked.status,
    BLOCKED,
    "a verifiable untracked-having tree still blocks clean -f",
  );
  assert.match(
    untracked.reason,
    /untracked/i,
    "the clean refusal names the structural signal",
  );
});

test("B8 RULING (2) RED CASE: a VERIFIED-DIRTY target BLOCKS the force-removal, with a named way out", () => {
  const dirty = runHook(`rm -rf ${dirtyRepo}`);
  assert.equal(
    dirty.status,
    BLOCKED,
    "verified-dirty rm -rf must BLOCK (non-empty porcelain is block-grade)",
  );
  assert.match(
    dirty.reason,
    /patch|--keep|`!`|via `!`/i,
    "the refusal must NAME A WAY OUT, not dead-end",
  );

  const untrackedRm = runHook(`rm -rf ${untrackedRepo}`);
  assert.equal(
    untrackedRm.status,
    BLOCKED,
    "untracked-only content is the same unlanded-work class",
  );
});

test("B8 RULING (1) RED CASE: the zero-loss proof now includes stash and unpushed commits", () => {
  const stash = runHook(`rm -rf ${stashRepo}`);
  assert.equal(
    stash.status,
    BLOCKED,
    "clean tree BUT a stash entry = parked work that exists nowhere else — not zero-loss",
  );
  assert.match(stash.reason, /stash/i, "the refusal names the stash leg");

  const unpushed = runHook(`rm -rf ${unpushedRepo}`);
  assert.equal(
    unpushed.status,
    BLOCKED,
    "clean tree BUT commits on no remote — destroying it destroys the only copy",
  );
  assert.match(
    unpushed.reason,
    /remote/i,
    "the refusal names the unpushed leg",
  );
});

test("B8 TWIN: a proven-zero-loss target (clean, no stash, no unpushed) stays NON-blocking", () => {
  const clean = runHook(`rm -rf ${cleanRepo}`);
  assert.notEqual(
    clean.status,
    BLOCKED,
    "a finished tree with nothing unlanded must NOT block — the fence is not a blanket (twin)",
  );
});

test("B8 ASSESSOR: the three zero-loss legs are assessor verdicts, not fence guesses", () => {
  const target = require(
    path.join(REPO, ".claude", "hooks", "lib", "destructive-force-target.js"),
  );
  assert.equal(
    target.assessTarget(stashRepo).state,
    target.STATE.DIRTY,
    "stash => DIRTY",
  );
  assert.match(target.assessTarget(stashRepo).detail, /stash/i);
  assert.equal(
    target.assessTarget(unpushedRepo).state,
    target.STATE.DIRTY,
    "unpushed => DIRTY",
  );
  assert.match(
    target.assessTarget(unpushedRepo).detail,
    /NO remote|no remote/i,
  );
  assert.equal(
    target.assessTarget(cleanRepo).state,
    target.STATE.CLEAN,
    "zero-loss => CLEAN",
  );
  // delta-(2) text fix, red-first: a NO-REMOTE CLEAN detail must name the leg
  // it did NOT assess — "every commit it carries is on a remote" is FALSE
  // when no remote is configured (measured).
  assert.match(
    target.assessTarget(cleanRepo).detail,
    /no remote|NOT assessed/i,
    "the no-remote CLEAN detail must name the unpushed leg as NOT assessed, not claim every commit is on a remote",
  );
});
