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
  gitEnv,
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
    `git -C ${cleanRepo} reset --hard HEAD`,
    `git -C ${cleanRepo} clean -fd`,
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

/* ── TARGET-CONFIG: assessing a target repo runs NO program its OWN config names ──
 *
 * The defect (security seat, measured `fsmonitor-ran=true`): the assessor ran git
 * against the target under `gitEnv()`, which nulls global/system config but not the
 * target's `.git/config`, so a planted `core.fsmonitor` (and a filter driver, and
 * `gpg.program` under `log.showSignature`) ran inside the hook when it merely
 * ASSESSED `rm -rf <repo>`.
 *
 * Each case carries its own CONTROL: the plant is first shown LIVE by running the
 * subcommand the old `runGit` ran — same binary, same `gitEnv()`, no neutralizer —
 * and asserting the marker DOES appear. Without that, "no marker" could mean the
 * plant was inert. Each case also asserts the assessor reached a VERDICT (not an
 * INDETERMINATE short-circuit, which would leave no marker for the wrong reason).
 */
const WIN32_SKIP = process.platform === "win32";

/** A program that records it ran by creating `marker`, in a dir OUTSIDE the repo. */
function plantProgram(dir, name, marker, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n: > '${marker}'\n${body}\n`, { mode: 0o755 });
  return p;
}

/** The OLD runGit's exact shape: resolved binary, `gitEnv()`, NO neutralizer prefix. */
function oldShapeGit(args) {
  return spawnSync(resolveGitBinary(), args, {
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "ignore"],
    env: gitEnv(),
  });
}

/** Make every tracked file stat-dirty with UNCHANGED content, so status must re-read it. */
function statDirty(repo) {
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(repo, "file.txt"), later, later);
}

function freshTargetCase(prefix) {
  const repo = initRepo(prefix);
  const progDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}prog-`));
  const markDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}mark-`));
  return {
    repo,
    progDir,
    markDir,
    cleanup() {
      for (const d of [repo, progDir, markDir]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

const target = () =>
  require(path.join(REPO, ".claude", "hooks", "lib", "destructive-force-target.js"));

test("B8 TARGET-CONFIG: a planted core.fsmonitor does NOT run when the hook assesses `rm -rf <repo>`", { skip: WIN32_SKIP }, () => {
  const c = freshTargetCase("gf-b8-fsmon-");
  try {
    const marker = path.join(c.markDir, "fsmonitor-ran");
    const prog = plantProgram(c.progDir, "fsmon.sh", marker, "exit 0");
    git(c.repo, ["config", "core.fsmonitor", prog]);
    statDirty(c.repo);

    // CONTROL — the plant is LIVE under the old runGit shape.
    const control = oldShapeGit(["-C", c.repo, "status", "--porcelain", "--untracked-files=all"]);
    assert.equal(control.status, 0, "control status must run");
    assert.ok(fs.existsSync(marker), "CONTROL: the planted fsmonitor must run under gitEnv() alone, or the negative below is unreadable");
    fs.rmSync(marker);

    // The hook, end to end.
    const r = runHook(`rm -rf ${c.repo}`);
    assert.ok(!fs.existsSync(marker), "the hook ran the target's planted core.fsmonitor while assessing `rm -rf`");
    assert.notEqual(r.status, BLOCKED, "a clean scratch repo must still assess to a non-blocking verdict (the assessment completed)");

    // The assessor, directly: a real verdict, and still no marker.
    const a = target().assessTarget(c.repo);
    assert.equal(a.state, target().STATE.CLEAN, `assessor must reach a verdict, got ${a.state}: ${a.detail}`);
    assert.ok(!fs.existsSync(marker), "assessTarget ran the target's planted core.fsmonitor");
  } finally {
    c.cleanup();
  }
});

test("B8 TARGET-CONFIG: a planted filter driver (bound in .git/info/attributes) does NOT run; an un-neutralizable driver name REFUSES", { skip: WIN32_SKIP }, () => {
  const c = freshTargetCase("gf-b8-filter-");
  try {
    const marker = path.join(c.markDir, "filter-ran");
    // `cat` passes the content through, so a RUN filter changes nothing but the marker.
    const prog = plantProgram(c.progDir, "clean.sh", marker, "cat");
    git(c.repo, ["config", "filter.evil.clean", prog]);
    // info/attributes, deliberately: `--attr-source` cannot reach it (measured), so only
    // emptying the driver closes it.
    fs.mkdirSync(path.join(c.repo, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(c.repo, ".git", "info", "attributes"), "* filter=evil\n");
    statDirty(c.repo);

    const control = oldShapeGit(["-C", c.repo, "status", "--porcelain", "--untracked-files=all"]);
    assert.equal(control.status, 0, "control status must run");
    assert.ok(fs.existsSync(marker), "CONTROL: the planted clean filter must run under gitEnv() alone");
    fs.rmSync(marker);
    statDirty(c.repo);

    const r = runHook(`rm -rf ${c.repo}`);
    assert.ok(!fs.existsSync(marker), "the hook ran the target's planted clean filter while assessing `rm -rf`");
    assert.notEqual(r.status, BLOCKED, "the neutralized assessment must complete (CLEAN), not refuse");
    statDirty(c.repo);
    const a = target().assessTarget(c.repo);
    assert.equal(a.state, target().STATE.CLEAN, `assessor must reach a verdict, got ${a.state}: ${a.detail}`);
    assert.ok(!fs.existsSync(marker), "assessTarget ran the target's planted clean filter");

    // A driver whose NAME holds `=` cannot be emptied through `-c` (git splits at the
    // first `=`). CONTROL first: it is live. Then the assessor must REFUSE to run status.
    // Built as one whole-file write: this is a fixture's git config, not a log, so it does
    // not take the append-sink shape the wip-discipline pair20 scope pin forbids.
    const cfg = path.join(c.repo, ".git", "config");
    fs.writeFileSync(cfg, `${fs.readFileSync(cfg, "utf8")}[filter "x=y"]\n\tclean = ${prog}\n`);
    fs.writeFileSync(path.join(c.repo, ".git", "info", "attributes"), "* filter=x=y\n");
    statDirty(c.repo);
    oldShapeGit(["-C", c.repo, "status", "--porcelain"]);
    assert.ok(fs.existsSync(marker), "CONTROL: the `x=y` driver must be live under gitEnv() alone");
    fs.rmSync(marker);
    statDirty(c.repo);

    const eq = target().assessTarget(c.repo);
    assert.equal(eq.state, target().STATE.INDETERMINATE, "an un-neutralizable driver must rank INDETERMINATE, never run");
    assert.match(eq.detail, /cannot be neutralized/);
    assert.ok(!fs.existsSync(marker), "assessTarget ran an un-neutralizable filter driver");
    const refused = runHook(`rm -rf ${c.repo}`);
    assert.equal(refused.status, BLOCKED, "an unassessable target REFUSES at the fence (B8)");
    assert.ok(!fs.existsSync(marker), "the hook ran an un-neutralizable filter driver");
  } finally {
    c.cleanup();
  }
});

test("B8 TARGET-CONFIG: a planted gpg.program under log.showSignature does NOT run from the stash leg", { skip: WIN32_SKIP }, () => {
  const c = freshTargetCase("gf-b8-gpg-");
  try {
    const marker = path.join(c.markDir, "gpg-ran");
    const prog = plantProgram(c.progDir, "gpg.sh", marker, "exit 1");
    git(c.repo, ["config", "log.showSignature", "true"]);
    git(c.repo, ["config", "gpg.program", prog]);
    // A commit carrying a gpgsig header, parked as the stash entry, so the stash leg's
    // `stash list` has a signature to verify.
    const tree = git(c.repo, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    const parent = git(c.repo, ["rev-parse", "HEAD"]).stdout.trim();
    const body =
      `tree ${tree}\nparent ${parent}\n` +
      "author t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\n" +
      "gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQ==\n -----END PGP SIGNATURE-----\n\nsigned\n";
    const hoArgs = ["hash-object", "-t", "commit", "-w", "--stdin"];
    const signed = spawnSync(resolveGitBinary(), hoArgs, {
      cwd: c.repo,
      input: body,
      encoding: "utf8",
      env: gitEnvForArgs(hoArgs),
    }).stdout.trim();
    assert.match(signed, /^[0-9a-f]{40,64}$/, "the signed fixture commit must be written");
    git(c.repo, ["-c", "user.email=t@t", "-c", "user.name=t", "update-ref", "--create-reflog", "refs/stash", signed]);

    const control = oldShapeGit(["-C", c.repo, "stash", "list"]);
    assert.equal(control.status, 0, "control stash list must run");
    assert.ok(fs.existsSync(marker), "CONTROL: the planted gpg.program must run under gitEnv() alone");
    fs.rmSync(marker);

    const a = target().assessTarget(c.repo);
    assert.equal(a.state, target().STATE.DIRTY, `the stash leg must still answer (DIRTY), got ${a.state}: ${a.detail}`);
    assert.match(a.detail, /stash/i);
    assert.ok(!fs.existsSync(marker), "assessTarget ran the target's planted gpg.program");

    const r = runHook(`rm -rf ${c.repo}`);
    assert.equal(r.status, BLOCKED, "parked work still blocks the force-removal");
    assert.ok(!fs.existsSync(marker), "the hook ran the target's planted gpg.program while assessing `rm -rf`");
  } finally {
    c.cleanup();
  }
});

// The SAME defect at the reset --hard / clean -f fence (validate-bash-command.js::
// gitWorkingTreeStatus): its status of the judged TARGET ran under gitEnv() alone. Both a
// planted fsmonitor and a planted clean filter are exercised; CONTROL as above.
test("B8 TARGET-CONFIG: `git -C <repo> reset --hard` and `clean -fd` run NO program the target repo's config names", { skip: WIN32_SKIP }, () => {
  const c = freshTargetCase("gf-b8-reset-");
  try {
    const fsMark = path.join(c.markDir, "fsmonitor-ran");
    const filterMark = path.join(c.markDir, "filter-ran");
    git(c.repo, ["config", "core.fsmonitor", plantProgram(c.progDir, "fsmon.sh", fsMark, "exit 0")]);
    git(c.repo, ["config", "filter.planted.clean", plantProgram(c.progDir, "clean.sh", filterMark, "cat")]);
    fs.mkdirSync(path.join(c.repo, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(c.repo, ".git", "info", "attributes"), "*.txt filter=planted\n");
    statDirty(c.repo);
    const control = oldShapeGit(["-C", c.repo, "status", "--porcelain", "--untracked-files=all"]);
    assert.equal(control.status, 0, "control status must run");
    assert.ok(fs.existsSync(fsMark) && fs.existsSync(filterMark), "CONTROL: both plants must run under gitEnv() alone");
    for (const cmd of [`git -C ${c.repo} reset --hard`, `git -C ${c.repo} clean -fd`]) {
      fs.rmSync(fsMark, { force: true });
      fs.rmSync(filterMark, { force: true });
      statDirty(c.repo);
      const r = runHook(cmd);
      assert.ok(!fs.existsSync(fsMark), `${cmd}: the hook ran the target's planted core.fsmonitor`);
      assert.ok(!fs.existsSync(filterMark), `${cmd}: the hook ran the target's planted clean filter`);
      // A verdict was reached: a clean tree takes the advisory path (rc 0), not the unverifiable refusal.
      assert.notEqual(r.status, BLOCKED, `${cmd}: a clean target must still measure clean: ${(r.stdout || "").slice(0, 300)}`);
    }
  } finally {
    c.cleanup();
  }
});
