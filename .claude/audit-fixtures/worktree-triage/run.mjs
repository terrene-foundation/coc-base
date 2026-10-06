#!/usr/bin/env node
/**
 * Audit-fixture runner for `.claude/bin/worktree-triage.mjs` — the quota-death
 * fleet-recovery triage tool that backs `rules/worktree-isolation.md` Rule 4a
 * obligation 2, shipped WITH the tool per `cc-artifacts.md` Rule 9.
 *
 * ── THE POLE PAIR (`instrument-bipolarity.md` MUST-1 / MUST-2) ──────────────
 *
 * worktree-triage GATES: its exit code is what a caller reads to decide whether
 * a dead lane's tree may be reused, and a run of it is cited as the evidence
 * that a fleet was triaged. So it ships BOTH poles, executable by THIS harness:
 *
 *   RED  a forest holding one tree with uncommitted work. The tool MUST refuse
 *        to report an all-clear — and the assertion is on the failure IDENTITY,
 *        not on the exit code: the named worktree PATH must carry the verdict
 *        string SALVAGE. An exit code is a quantity; "which tree, which class"
 *        is the identity, and only the identity survives the obvious repair.
 *   GREEN the same forest with that one tree committed. The tool MUST report no
 *        SALVAGE at all.
 *
 * The pair is then checked for VACUITY in both directions: the two runs must
 * DIFFER, and — the half that catches an assertion which cannot fail — the RED
 * pole's identity assertion is re-run against the GREEN pole's output and MUST
 * NOT be satisfied there.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 *
 * Every forest is built under `mkdtemp` in os.tmpdir() and removed at exit. The
 * live worktree forest is NEVER read by this runner and never written: the
 * whole point of the tool is recovery, and a fixture that practises on a real
 * lane's uncommitted work would be the failure it exists to prevent. Git runs
 * with GIT_CONFIG_GLOBAL/SYSTEM pointed at /dev/null so an operator's signing
 * config, hooks, or templates cannot change what is measured.
 *
 * ── COVERAGE SHAPE ──────────────────────────────────────────────────────────
 *
 * One case per PREDICATE a wrong edit would silently widen or narrow, each in
 * both polarities where a polarity exists: the four classes, the fail-closed
 * arms (unreadable status, absent directory, no-remote repo, unknown commit
 * state), the capture contract (what it writes, what it round-trips, what it
 * leaves alone), the containment refusal and its near-miss sibling, the exit-
 * code alphabet, and a structural sweep proving the tool CANNOT reach a
 * destructive git subcommand or fs call — parsed from its argument arrays, not
 * grepped from its prose, so the tool's own comments about what it never does
 * cannot satisfy the check.
 */

import "../_lib/no-ambient-git.cjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const TOOL = join(REPO_ROOT, ".claude", "bin", "worktree-triage.mjs");
// Read once, up here: the structural sweep at the foot of this file, the
// HIGH-3 implementing-line assertion, and the CRIT-1 flag-pin assertion all
// read it. Parsed from the tool's git ARGUMENT ARRAYS, never from its prose —
// the tool's header describes what it never does, and a prose grep would be
// satisfied by that sentence alone.
const SRC = readFileSync(TOOL, "utf8");
const GIT_ARG_ARRAYS = [...SRC.matchAll(/gitOk\(\s*\[([^\]]*)\]/g)].map((m) => m[1]);
const GIT_TOKENS = GIT_ARG_ARRAYS.map((body) =>
  [...body.matchAll(/"([^"]*)"/g)].map((t) => t[1]).filter((t) => t !== "-C"),
);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
};

let passes = 0;
let failures = 0;
const cleanup = [];

function ok(name) {
  passes += 1;
  process.stdout.write(`PASS ${name}\n`);
}
function bad(name, msg) {
  failures += 1;
  process.stdout.write(`FAIL ${name} — ${msg}\n`);
}
function check(name, fn) {
  try {
    fn();
    ok(name);
  } catch (e) {
    bad(name, (e && e.message ? e.message : String(e)).split("\n")[0]);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── git / tool drivers ──────────────────────────────────────────────────────

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${(r.stderr || "").trim().split("\n")[0]}`);
  }
  return (r.stdout || "").trim();
}

function triage(args) {
  const r = spawnSync("node", [TOOL, ...args], { cwd: REPO_ROOT, encoding: "utf8", env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function triageJson(args) {
  const r = triage([...args, "--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    /* left null — the caller asserts on it */
  }
  return { ...r, json: parsed };
}

/** Look up one worktree record by the last path segment of its directory. */
function rec(json, leaf) {
  assert(json, "no JSON parsed from the tool");
  const hit = json.worktrees.filter((w) => w.path.split("/").pop() === leaf);
  assert(hit.length === 1, `expected exactly one worktree whose leaf is '${leaf}', got ${hit.length}`);
  return hit[0];
}

// ── forest construction ─────────────────────────────────────────────────────

/**
 * Build a throwaway forest.
 *
 * Returns { root, main, wt } where `wt(name)` is the absolute path of a lane.
 * `remote: false` builds a repo with no remote at all — the arm that proves the
 * ahead-count degrades to the unpushed count rather than silently reading zero.
 */
function mkForest({ remote = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wt-triage-fx-"));
  cleanup.push(root);
  const main = join(root, "main");
  git(root, ["init", "-q", "-b", "main", main]);
  writeFileSync(join(main, "base.txt"), "base\n");
  git(main, ["add", "base.txt"]);
  git(main, ["commit", "-q", "-m", "base"]);
  if (remote) {
    const bare = join(root, "remote.git");
    git(root, ["init", "-q", "--bare", bare]);
    git(main, ["remote", "add", "origin", bare]);
    git(main, ["push", "-q", "-u", "origin", "main"]);
    git(main, ["remote", "set-head", "origin", "main"]);
  }
  return { root, main, wt: (n) => join(root, "wt", n) };
}

function addLane(f, name, branch) {
  git(f.main, ["worktree", "add", "-q", "-b", branch, f.wt(name), "main"]);
  return f.wt(name);
}

function commitIn(path, file, body, msg) {
  writeFileSync(join(path, file), body);
  git(path, ["add", file]);
  git(path, ["commit", "-q", "-m", msg]);
}

function dirtyIn(path) {
  writeFileSync(join(path, "base.txt"), "base\nchanged-by-the-lane\n");
  writeFileSync(join(path, "brand-new.txt"), "untracked lane output\n");
  mkdirSync(join(path, "sub"), { recursive: true });
  writeFileSync(join(path, "sub", "deep.txt"), "nested untracked\n");
}

// ════════════════════════════════════════════════════════════════════════════
// THE POLE PAIR
// ════════════════════════════════════════════════════════════════════════════

/** The RED-pole predicate, as a FUNCTION so it can be re-run against GREEN. */
function redPoleIdentitySatisfied(run, leaf) {
  if (!run.json) return false;
  const hits = run.json.worktrees.filter((w) => w.path.split("/").pop() === leaf && w.recoverability === "SALVAGE");
  return hits.length === 1;
}

const poleForest = mkForest();
const poleLane = addLane(poleForest, "at-risk", "lane-at-risk");
dirtyIn(poleLane);
const RED = triageJson(["--repo", poleForest.main]);

check("POLE-RED: a forest holding uncommitted lane work does not report an all-clear", () => {
  eq(RED.status, 3, "exit code");
});
check("POLE-RED IDENTITY: the named worktree carries the verdict SALVAGE (not merely a non-zero exit)", () => {
  assert(redPoleIdentitySatisfied(RED, "at-risk"), "no SALVAGE record for the 'at-risk' worktree");
  eq(rec(RED.json, "at-risk").recoverability, "SALVAGE", "verdict for 'at-risk'");
});
check("POLE-RED IDENTITY: the human report names the class and the path on one line", () => {
  // The path is taken from the tool's OWN record, not from the fixture's
  // constructed string: `git worktree list` reports symlink-RESOLVED paths, and
  // on macOS the temp root resolves through /private, so comparing against the
  // constructed path would fail on a correct tool (`worktree-isolation.md`
  // MUST NOT § "Assert by string-comparing … against the path the orchestrator
  // passed" — the same defect, one layer out).
  const human = triage(["--repo", poleForest.main]);
  assert(human.stdout.includes(`SALVAGE ${rec(RED.json, "at-risk").path}`), "human report does not carry 'SALVAGE <path>'");
});

// Same forest, same lane — the work is now committed. Only that changed.
git(poleLane, ["add", "-A"]);
git(poleLane, ["commit", "-q", "-m", "lane work"]);
const GREEN = triageJson(["--repo", poleForest.main]);

check("POLE-GREEN: the same forest with the lane's work committed reports clean", () => {
  eq(GREEN.status, 0, "exit code");
});
check("POLE-GREEN: no worktree at all carries the SALVAGE verdict", () => {
  eq(GREEN.json.counts.SALVAGE, 0, "SALVAGE count");
});
check("POLE PAIR: the two verdicts DIFFER (a pair that agrees is vacuous)", () => {
  assert(RED.status !== GREEN.status, `both poles exited ${RED.status}`);
  assert(RED.json.counts.SALVAGE !== GREEN.json.counts.SALVAGE, "both poles reported the same SALVAGE count");
});
check("POLE PAIR ANTI-VACUITY: the RED identity assertion is NOT satisfied by the GREEN output", () => {
  assert(
    !redPoleIdentitySatisfied(GREEN, "at-risk"),
    "the RED pole's own predicate holds on the GREEN pole too — it cannot discriminate and every RED pass is unearned",
  );
});
check("POLE PAIR: the RED exit code is distinct from the tool-could-not-run code", () => {
  const usage = triage(["--repo", poleForest.main, "--nonsense"]);
  eq(usage.status, 1, "unknown-flag exit");
  assert(RED.status !== usage.status, "a finding and a failure share an exit code — a caller cannot tell them apart");
});

// ════════════════════════════════════════════════════════════════════════════
// CLASSIFICATION — the four classes, each against a forest that holds all four
// ════════════════════════════════════════════════════════════════════════════

const F = mkForest();
const lostLane = addLane(F, "lost", "lane-lost");
const pushedLane = addLane(F, "pushed", "lane-pushed");
commitIn(pushedLane, "p.txt", "p\n", "pushed work");
git(pushedLane, ["push", "-q", "-u", "origin", "lane-pushed"]);
const unpushedLane = addLane(F, "unpushed", "lane-unpushed");
commitIn(unpushedLane, "u.txt", "u\n", "unpushed work");
const salvageLane = addLane(F, "salvage", "lane-salvage");
dirtyIn(salvageLane);
const ALL = triageJson(["--repo", F.main]);

check("CLASS SALVAGE: a tree with uncommitted work", () => {
  eq(rec(ALL.json, "salvage").recoverability, "SALVAGE", "recoverability");
});
check("CLASS PUSHED: commits exist AND are reachable from a remote", () => {
  const r = rec(ALL.json, "pushed");
  eq(r.recoverability, "PUSHED", "recoverability");
  eq(r.unpushed, 0, "unpushed count");
  assert(r.ahead > 0, `expected own commits, got ahead=${r.ahead}`);
});
check("CLASS UNPUSHED: commits exist and are on no remote", () => {
  const r = rec(ALL.json, "unpushed");
  eq(r.recoverability, "UNPUSHED", "recoverability");
  assert(r.unpushed > 0, `expected unpushed commits, got ${r.unpushed}`);
});
check("CLASS LOST: clean tree with no commits of its own", () => {
  eq(rec(ALL.json, "lost").recoverability, "LOST", "recoverability");
});
check("CLASSES ARE TOTAL: every record carries exactly one of the four recoverability classes", () => {
  const allowed = new Set(["SALVAGE", "PUSHED", "UNPUSHED", "LOST"]);
  for (const w of ALL.json.worktrees) assert(allowed.has(w.recoverability), `unexpected recoverability ${w.recoverability} for ${w.path}`);
});

// ── the SHARED removal-safety vocabulary (consolidated 2026-08-22) ───────────
//
// The four classes above are the RECOVERY axis. `verdict` is the word this tool
// shares with `.claude/bin/worktree-reap.mjs` and
// `.claude/hooks/lib/wip-lanes.js` — one question, one spelling. These
// checks are BIPOLAR on ONE run: the same forest must yield BOTH words, because
// a mapping that returns a constant would satisfy every per-class assertion
// below while carrying no information at all.

check("SHARED VERDICT: the at-risk classes map to KEEP, naming the tree", () => {
  eq(rec(ALL.json, "salvage").verdict, "KEEP", "verdict for 'salvage' (uncommitted work, no reflog)");
  eq(rec(ALL.json, "unpushed").verdict, "KEEP", "verdict for 'unpushed' (local ref is the only copy)");
});
check("SHARED VERDICT: the recoverable classes map to ZERO-LOSS, naming the tree", () => {
  eq(rec(ALL.json, "pushed").verdict, "ZERO-LOSS", "verdict for 'pushed' (reachable from a remote)");
  eq(rec(ALL.json, "lost").verdict, "ZERO-LOSS", "verdict for 'lost' (clean, no commits of its own)");
});
check("SHARED VERDICT POLE PAIR: ONE run yields BOTH words (a constant mapping is vacuous)", () => {
  const words = new Set(ALL.json.worktrees.map((w) => w.verdict));
  assert(
    words.has("KEEP") && words.has("ZERO-LOSS"),
    `one run produced only ${[...words].join(", ")} — the mapping cannot discriminate, so every per-class pass above is unearned`,
  );
});
check("SHARED VERDICT: the spelling is the REAPER's, not a third vocabulary", () => {
  const allowed = new Set(["ZERO-LOSS", "KEEP"]);
  for (const w of ALL.json.worktrees) {
    assert(allowed.has(w.verdict), `${w.path} carries verdict '${w.verdict}', which worktree-reap.mjs does not emit`);
  }
  // TAG-FIRST is deliberately NOT minted here: only a tool that removes a tree
  // can act on "tag it first". Asserted so a later edit cannot add it silently.
  assert(
    !ALL.json.worktrees.some((w) => w.verdict === "TAG-FIRST"),
    "a non-removing tool minted TAG-FIRST — a verdict it can never act on",
  );
});
check("SHARED VERDICT: the summary tally is DERIVED from the records, never measured twice", () => {
  const keep = ALL.json.worktrees.filter((w) => w.verdict === "KEEP").length;
  const zl = ALL.json.worktrees.filter((w) => w.verdict === "ZERO-LOSS").length;
  eq(ALL.json.verdicts.KEEP, keep, "KEEP tally vs per-record KEEP count");
  eq(ALL.json.verdicts["ZERO-LOSS"], zl, "ZERO-LOSS tally vs per-record ZERO-LOSS count");
  eq(keep + zl, ALL.json.worktrees.length, "the two words are TOTAL over the forest");
});
check("COUNTS RECONCILE: the summary counts sum to the number of worktrees", () => {
  const c = ALL.json.counts;
  eq(c.SALVAGE + c.PUSHED + c.UNPUSHED + c.LOST, ALL.json.worktrees.length, "sum of counts");
});
check("SALVAGE DOMINATES: a dirty tree is SALVAGE even when its commits are all pushed", () => {
  const lane = addLane(F, "pushed-and-dirty", "lane-pd");
  commitIn(lane, "pd.txt", "pd\n", "pd");
  git(lane, ["push", "-q", "-u", "origin", "lane-pd"]);
  dirtyIn(lane);
  const j = triageJson(["--repo", F.main]).json;
  const r = rec(j, "pushed-and-dirty");
  eq(r.recoverability, "SALVAGE", "verdict");
  eq(r.unpushed, 0, "commit axis still reported for a SALVAGE tree");
});
check("MAIN CHECKOUT is identified as such rather than treated as a lane", () => {
  const hits = ALL.json.worktrees.filter((w) => w.is_main);
  eq(hits.length, 1, "count of is_main records");
  eq(hits[0].path, ALL.json.main_checkout, "is_main record is the main checkout");
});
check("DETACHED HEAD carrying unpushed commits is UNPUSHED and reports its SHA", () => {
  const f = mkForest();
  const lane = f.wt("detached");
  git(f.main, ["worktree", "add", "-q", "--detach", lane, "main"]);
  commitIn(lane, "d.txt", "d\n", "detached work");
  const r = rec(triageJson(["--repo", f.main]).json, "detached");
  eq(r.recoverability, "UNPUSHED", "verdict");
  eq(r.branch, null, "branch");
  assert(typeof r.sha === "string" && r.sha.length >= 40, `expected a full SHA, got ${r.sha}`);
  assert(r.reasons.join(" ").includes(r.sha.slice(0, 12)), "the reason does not name the detached SHA");
});

// ── dirty-count accuracy (the number a human reads to size the rescue) ──

check("DIRTY COUNT: a rename is counted ONCE, not once per path field", () => {
  const f = mkForest();
  const lane = addLane(f, "renamed", "lane-renamed");
  git(lane, ["mv", "base.txt", "renamed.txt"]);
  eq(rec(triageJson(["--repo", f.main]).json, "renamed").dirty_count, 1, "dirty_count for one rename");
});
check("DIRTY COUNT: a filename containing a space is counted ONCE", () => {
  const f = mkForest();
  const lane = addLane(f, "spaced", "lane-spaced");
  writeFileSync(join(lane, "a file with spaces.txt"), "x\n");
  eq(rec(triageJson(["--repo", f.main]).json, "spaced").dirty_count, 1, "dirty_count for one spaced filename");
});
check("DIRTY COUNT: a gitignored file does NOT make a tree SALVAGE", () => {
  const f = mkForest();
  const lane = addLane(f, "ignored", "lane-ignored");
  writeFileSync(join(lane, ".gitignore"), "build/\n");
  git(lane, ["add", ".gitignore"]);
  git(lane, ["commit", "-q", "-m", "ignore build"]);
  git(lane, ["push", "-q", "-u", "origin", "lane-ignored"]);
  mkdirSync(join(lane, "build"), { recursive: true });
  writeFileSync(join(lane, "build", "out.o"), "binary\n");
  const r = rec(triageJson(["--repo", f.main]).json, "ignored");
  eq(r.recoverability, "PUSHED", "verdict — ignored build output is not uncommitted WORK");
});

// ════════════════════════════════════════════════════════════════════════════
// FAIL-CLOSED ARMS
// ════════════════════════════════════════════════════════════════════════════

check("FAIL-CLOSED: an UNREADABLE status is SALVAGE, never clean", () => {
  const f = mkForest();
  const lane = addLane(f, "unreadable", "lane-unreadable");
  chmodSync(lane, 0o000);
  try {
    const r = rec(triageJson(["--repo", f.main]).json, "unreadable");
    eq(r.recoverability, "SALVAGE", "verdict");
    eq(r.dirty_count, null, "dirty_count is unknown, not zero");
    assert(r.reasons.join(" ").toLowerCase().includes("unreadable"), "the reason does not name the unreadable status");
  } finally {
    chmodSync(lane, 0o755);
  }
});
check("FAIL-CLOSED CONTROL: the same lane readable again is NOT SALVAGE", () => {
  const f = mkForest();
  const lane = addLane(f, "readable", "lane-readable");
  chmodSync(lane, 0o000);
  const blind = rec(triageJson(["--repo", f.main]).json, "readable").recoverability;
  chmodSync(lane, 0o755);
  const seeing = rec(triageJson(["--repo", f.main]).json, "readable").recoverability;
  assert(blind !== seeing, `permission state changed nothing — both runs said ${blind}, so the fail-closed arm is unreachable`);
  eq(seeing, "LOST", "verdict once readable");
});
check("FAIL-CLOSED: an ABSENT directory is not SALVAGE — there is nothing left to capture", () => {
  const f = mkForest();
  const lane = addLane(f, "gone", "lane-gone");
  commitIn(lane, "g.txt", "g\n", "work");
  rmSync(lane, { recursive: true, force: true });
  const r = rec(triageJson(["--repo", f.main]).json, "gone");
  assert(r.recoverability !== "SALVAGE", "an absent directory was classified SALVAGE");
  eq(r.directory_present, false, "directory_present");
  assert(r.reasons.join(" ").includes("directory absent"), "the reason does not name the absent directory");
});
check("FAIL-CLOSED: an ABSENT directory still has its COMMIT axis evaluated from the ref", () => {
  const f = mkForest();
  const lane = addLane(f, "gone2", "lane-gone2");
  commitIn(lane, "g.txt", "g\n", "work that survives the directory");
  rmSync(lane, { recursive: true, force: true });
  const r = rec(triageJson(["--repo", f.main]).json, "gone2");
  eq(r.recoverability, "UNPUSHED", "verdict — the branch ref outlives the directory");
  assert(r.unpushed > 0, `expected unpushed commits from the ref, got ${r.unpushed}`);
});
check("FAIL-CLOSED: a repo with NO remote reports base_ref null and does not call local commits PUSHED", () => {
  const f = mkForest({ remote: false });
  const lane = addLane(f, "noremote", "lane-noremote");
  commitIn(lane, "n.txt", "n\n", "local only");
  const j = triageJson(["--repo", f.main]).json;
  eq(j.base_ref, null, "base_ref");
  eq(rec(j, "noremote").recoverability, "UNPUSHED", "verdict");
});

// ════════════════════════════════════════════════════════════════════════════
// CAPTURE
// ════════════════════════════════════════════════════════════════════════════

const CF = mkForest();
const capLane = addLane(CF, "cap", "lane-cap");
dirtyIn(capLane);
const capClean = addLane(CF, "cap-clean", "lane-cap-clean");
commitIn(capClean, "c.txt", "c\n", "clean work");
git(capClean, ["push", "-q", "-u", "origin", "lane-cap-clean"]);

const capDir = join(CF.root, "rescue");
const beforeStatus = git(capLane, ["status", "--porcelain"]);
const beforeHead = git(capLane, ["rev-parse", "HEAD"]);
const CAP = triageJson(["--repo", CF.main, "--capture", capDir]);
const capDest = readdirSync(capDir).map((d) => join(capDir, d));

check("CAPTURE: writes exactly one destination, for the SALVAGE tree only", () => {
  eq(capDest.length, 1, "capture destinations");
  assert(capDest[0].includes("cap-"), `destination does not name the source lane: ${capDest[0]}`);
});
check("CAPTURE: writes a tracked.patch carrying the modified tracked file", () => {
  const p = readFileSync(join(capDest[0], "tracked.patch"), "utf8");
  assert(p.includes("base.txt"), "tracked.patch does not mention the modified file");
  assert(p.includes("changed-by-the-lane"), "tracked.patch does not carry the modification");
});
check("CAPTURE: copies untracked files, including nested ones", () => {
  eq(readFileSync(join(capDest[0], "untracked", "brand-new.txt"), "utf8"), "untracked lane output\n", "top-level untracked");
  eq(readFileSync(join(capDest[0], "untracked", "sub", "deep.txt"), "utf8"), "nested untracked\n", "nested untracked");
});
check("CAPTURE: writes a MANIFEST naming the source worktree, branch and HEAD", () => {
  const m = readFileSync(join(capDest[0], "MANIFEST.txt"), "utf8");
  assert(m.includes(capLane), "manifest does not name the source worktree");
  assert(m.includes("lane-cap"), "manifest does not name the branch");
  assert(m.includes(beforeHead), "manifest does not name the HEAD the patch applies to");
});
check("CAPTURE: leaves the source worktree BYTE-FOR-BYTE as it found it", () => {
  eq(git(capLane, ["status", "--porcelain"]), beforeStatus, "working-tree status after capture");
  eq(git(capLane, ["rev-parse", "HEAD"]), beforeHead, "HEAD after capture");
});
check("HIGH-3: the run does not REWRITE the paused lane's index file (bipolar, control first)", () => {
  // SUPERSEDES a `git diff --cached` assertion that could not fail here. That
  // check read STAGED CONTENT; the property is an index WRITE. Capture never
  // stages anything, so the old assertion returned empty whether or not git
  // had rewritten the index — a non-discriminating instrument guarding a named
  // safety property (`instrument-discipline.md` MUST-1). The index FILE's hash
  // is the instrument that can actually return the other answer.
  const f = mkForest();
  const lane = addLane(f, "idx", "lane-idx");
  const gitDir = git(lane, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const indexPath = join(gitDir, "index");
  const hash = () => createHash("sha256").update(readFileSync(indexPath)).digest("hex");

  // Stale the stat cache WITHOUT changing content, so a refresh rewrites the
  // index. `utimes` into the future beats git's racily-clean same-second rule.
  //
  // The timestamp MUST ADVANCE on every call. A single fixed `future` made this
  // case VACUOUS: the control's own `git status` recorded that exact mtime into
  // the index, so the second stale() was a no-op, the index was already fresh,
  // and the subject had nothing to rewrite — it passed against a tool that DID
  // rewrite the index. Caught by mutation-testing this case against the
  // unfixed tool, where it failed to red (`instrument-discipline.md` MUST-2(b):
  // a non-reddening mutation leaves two hypotheses, and this was the second).
  let tick = 0;
  const stale = () => {
    const t = new Date(Date.now() + 5000 + ++tick * 2000);
    utimesSync(join(lane, "base.txt"), t, t);
  };

  // CONTROL — an UNPINNED status MUST move the hash. If it does not, this
  // fixture cannot observe the property at all and says so instead of passing.
  stale();
  const ctlBefore = hash();
  spawnSync("git", ["-C", lane, "status", "--porcelain=v1"], { encoding: "utf8", env: GIT_ENV });
  const ctlAfter = hash();
  assert(
    ctlBefore !== ctlAfter,
    "INERT INSTRUMENT: a plain `git status` did not rewrite the index here, so this fixture could not detect the tool doing it either — re-instrument rather than reading the subject's green",
  );

  // SUBJECT — the tool, over a forest containing this lane, MUST NOT move it.
  stale();
  const before = hash();
  triage(["--repo", f.main]);
  eq(hash(), before, "the lane's index file was REWRITTEN by a report-only triage run");
});
check("HIGH-3: every git invocation carries --no-optional-locks (the line the claim rests on)", () => {
  // The header claims the only writes are into --capture. That claim is
  // implemented by ONE prepend at the gitOk chokepoint; assert the prepend
  // exists rather than trusting the sentence (`instrument-bipolarity.md`
  // MUST-4 — prose MUST name an implementing line, and it MUST be reachable).
  assert(
    /execFileSync\(\s*"git",\s*\["--no-optional-locks",\s*\.\.\.args\]/.test(SRC),
    "gitOk does not prepend --no-optional-locks to every invocation",
  );
  const spawnSites = [...SRC.matchAll(/execFileSync\(/g)].length;
  eq(spawnSites, 1, "more than one git spawn site — the chokepoint prepend would no longer be total");
});
check("CAPTURE ROUND-TRIP: the capture restores the lane's content byte-for-byte", () => {
  const restore = CF.wt("restored");
  git(CF.main, ["worktree", "add", "-q", "--detach", restore, beforeHead]);
  const ap = spawnSync("git", ["apply", join(capDest[0], "tracked.patch")], { cwd: restore, encoding: "utf8", env: GIT_ENV });
  eq(ap.status, 0, `git apply failed: ${(ap.stderr || "").trim().split("\n")[0]}`);
  const cp = spawnSync("cp", ["-R", join(capDest[0], "untracked") + "/.", restore], { encoding: "utf8" });
  eq(cp.status, 0, "copying the untracked half failed");
  const diff = spawnSync("diff", ["-r", "--exclude=.git", capLane, restore], { encoding: "utf8" });
  eq(diff.status, 0, `restored content differs from the source lane: ${(diff.stdout || "").trim().split("\n")[0]}`);
});
check("CAPTURE: still exits 3 — capturing the work does not clear the finding", () => {
  eq(CAP.status, 3, "exit after capture");
});
check("CAPTURE: the JSON records the destination per captured tree", () => {
  const r = rec(CAP.json, "cap");
  assert(r.capture && r.capture.dest, "no capture record on the SALVAGE tree");
  eq(r.capture.errors.length, 0, "capture errors");
  const clean = rec(CAP.json, "cap-clean");
  assert(!clean.capture, "a non-SALVAGE tree was captured");
});

// ── containment ──

check("CONTAINMENT: a capture target INSIDE a worktree is refused before any write", () => {
  const target = join(capLane, "rescue-here");
  const r = triage(["--repo", CF.main, "--capture", target]);
  eq(r.status, 1, "exit");
  assert(r.stderr.includes("resolves INSIDE"), "the refusal does not say why");
  assert(!existsSync(target), "the refused target was created anyway");
});
check("CONTAINMENT: a capture target INSIDE the main checkout is refused", () => {
  const target = join(CF.main, "rescue-here");
  const r = triage(["--repo", CF.main, "--capture", target]);
  eq(r.status, 1, "exit");
  assert(!existsSync(target), "the refused target was created anyway");
});
check("CONTAINMENT NEAR-MISS: a sibling sharing a path PREFIX is NOT treated as inside", () => {
  // `<lane>-rescue` shares every character of `<lane>` and is a different
  // directory. A prefix test without a separator refuses it — that is the
  // classic containment bypass run backwards, and it makes the tool unusable.
  const target = `${capLane}-rescue`;
  const r = triage(["--repo", CF.main, "--capture", target]);
  assert(r.status !== 1, `a legitimate sibling target was refused: ${r.stderr.trim().split("\n")[0]}`);
  assert(existsSync(target), "the sibling target was not created");
});
check("CAPTURE FAILURE is LOUD: an unwritable destination exits 2, not 0 or 3", () => {
  const f = mkForest();
  const lane = addLane(f, "unwritable", "lane-unwritable");
  dirtyIn(lane);
  const dest = join(f.root, "readonly-rescue");
  mkdirSync(dest, { recursive: true });
  chmodSync(dest, 0o500);
  try {
    const r = triage(["--repo", f.main, "--capture", dest]);
    eq(r.status, 2, "exit on a failed capture write");
  } finally {
    chmodSync(dest, 0o755);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// REDTEAM REGRESSION CASES
//
// Named for the finding id per `coc-artifact-eval-coverage.md` MUST-2, so the
// case fails the moment a future edit re-opens the class. Each is BIPOLAR and
// each asserts a failure IDENTITY (which tree, which verdict, which byte), not
// an exit code (`instrument-bipolarity.md` MUST-2).
// ════════════════════════════════════════════════════════════════════════════

/** A forest whose lane's ONLY output is untracked — the no-reflog case. */
function mkUntrackedOnlyLane(configure) {
  const f = mkForest();
  const lane = addLane(f, "untracked-only", "lane-uo");
  git(lane, ["push", "-q", "-u", "origin", "lane-uo"]);
  writeFileSync(join(lane, "report.md"), "irreplaceable lane output\n");
  if (configure) configure(lane);
  return { f, lane };
}

check("CRIT-1 CONTROL: `status.showUntrackedFiles=no` really does blank an UNPINNED status", () => {
  // Fire the instrument at a known-answer case first (`instrument-discipline.md`
  // MUST-3(a)). If the config no longer blanks the unpinned read, the RED pole
  // below proves nothing about the pin and must be re-instrumented.
  const { lane } = mkUntrackedOnlyLane((l) => git(l, ["config", "status.showUntrackedFiles", "no"]));
  eq(git(lane, ["status", "--porcelain"]), "", "unpinned status under the config");
  assert(git(lane, ["status", "--porcelain=v1", "--untracked-files=all"]).includes("report.md"), "the pinned form must still see the file");
});
check("CRIT-1 RED: untracked-only work under `showUntrackedFiles=no` is SALVAGE, not LOST", () => {
  const { f } = mkUntrackedOnlyLane((l) => git(l, ["config", "status.showUntrackedFiles", "no"]));
  const run = triageJson(["--repo", f.main]);
  const r = rec(run.json, "untracked-only");
  eq(r.recoverability, "SALVAGE", "verdict — a config-driven false clean must not read as 'nothing recoverable here'");
  eq(r.dirty_count, 1, "dirty_count");
  eq(run.status, 3, "exit");
});
check("CRIT-1 GREEN: the same lane with that work COMMITTED is not SALVAGE", () => {
  const { f, lane } = mkUntrackedOnlyLane((l) => git(l, ["config", "status.showUntrackedFiles", "no"]));
  git(lane, ["add", "-A"]);
  git(lane, ["commit", "-q", "-m", "lane output"]);
  const r = rec(triageJson(["--repo", f.main]).json, "untracked-only");
  assert(r.recoverability !== "SALVAGE", `a committed lane still read as SALVAGE (${r.recoverability})`);
});
check("CRIT-1: `core.excludesFile` cannot blank the tree either (the sibling config lever)", () => {
  const { f, lane } = mkUntrackedOnlyLane((l) => {
    const ex = join(l, "..", "excludes");
    writeFileSync(ex, "*.md\n");
    git(l, ["config", "core.excludesFile", ex]);
  });
  // This one SHOULD stay quiet — an operator-declared exclude is a real
  // exclude, and `--exclude-standard` honours it. The case pins the BOUNDARY so
  // a later "fix" does not over-widen the pin into ignoring .gitignore too.
  // (LOST, not PUSHED: the lane carries no commits of its OWN, so the clean-tree
  // arm lands on LOST — what matters here is only that it is not SALVAGE.)
  const r = rec(triageJson(["--repo", f.main]).json, "untracked-only");
  assert(r.recoverability !== "SALVAGE", "an explicitly-excluded file is not uncommitted WORK — the pin over-widened past .gitignore/excludesFile");
  eq(r.recoverability, "LOST", "verdict");
  eq(r.dirty_count, 0, "dirty_count");
  assert(existsSync(join(lane, "report.md")), "fixture setup");
});
check("CRIT-1: --porcelain is pinned to =v1, the version the parser hardcodes", () => {
  const statusArgs = GIT_TOKENS.find((t) => t[0] === "status");
  assert(statusArgs, "no status call found");
  assert(statusArgs.includes("--porcelain=v1"), `status is not pinned to v1: [${statusArgs.join(" ")}]`);
  assert(!statusArgs.includes("--porcelain"), "status still passes a bare, version-unpinned --porcelain");
  assert(statusArgs.includes("--untracked-files=all"), "status does not pin --untracked-files");
  // NOTE: this line no longer stands ALONE. It is a source-text pin, and a
  // source-text pin proves the flag is PRESENT and nothing about what it
  // CAUSES — measured: deleting `--ignore-submodules=none` used to red exactly
  // this one case and change no observable behaviour any fixture asserted on,
  // which is why a 75/75 green was blind to the submodule capture gap below.
  // The SUBMODULE section that follows is the behavioural backing; this
  // assertion is kept only as the cheap argv-shape pin it always was.
  assert(statusArgs.includes("--ignore-submodules=none"), "status does not pin --ignore-submodules");
});

// ════════════════════════════════════════════════════════════════════════════
// SUBMODULE — detection is submodule-AWARE, capture is submodule-BLIND
//
// `classify()` pins `--ignore-submodules=none`, so a dirty submodule makes a
// tree SALVAGE. Capture's two reads (`git diff HEAD --binary`, `ls-files
// --others`) BOTH look straight past a gitlink and neither errors, so the run
// used to write a content-free rescue, report `capture_complete: true`, print
// "all at-risk work is SAVED — the trees may now be reused or removed", and
// exit 3 — a work-preservation tool AFFIRMATIVELY AUTHORISING the destruction
// of work it never captured.
//
// These cases are BEHAVIOURAL: they run the tool against a real forest holding
// a real submodule and assert on the exit code, the JSON, the manifest, and
// the AUTHORISING SENTENCE — never on the tool's own source text.
// ════════════════════════════════════════════════════════════════════════════

const SENTINEL = "IRREPLACEABLE-SUBMODULE-CONTENT";

/**
 * Add a real submodule to `f.main` and return its path within a tree.
 *
 * `-c protocol.file.allow=always` is required at BOTH add and update time:
 * modern git refuses the `file://` transport for submodules by default, and
 * GIT_CONFIG_GLOBAL is /dev/null here so it cannot come from an operator's
 * config. If submodules cannot be built in this environment `git()` THROWS and
 * the case FAILS loudly — a work-preservation fixture must never degrade to a
 * silent skip.
 */
function addSubmodule(f, name = "sub") {
  const origin = join(f.root, `${name}-origin`);
  git(f.root, ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "s.txt"), "submodule base\n");
  git(origin, ["add", "s.txt"]);
  git(origin, ["commit", "-q", "-m", "submodule base"]);
  git(f.main, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, name]);
  git(f.main, ["commit", "-q", "-m", "add submodule"]);
  git(f.main, ["push", "-q", "origin", "main"]);
  return name;
}

/** Build `main` + one lane carrying a submodule; `init` controls checkout. */
function mkSubmoduleLane({ init = true } = {}) {
  const f = mkForest();
  addSubmodule(f);
  const lane = addLane(f, "submod", "lane-submod");
  if (init) git(lane, ["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"]);
  return { f, lane, sub: join(lane, "sub") };
}

/** The RED-pole predicate, as a FUNCTION so it can be re-run against GREEN. */
function submoduleGapReported(run) {
  if (!run.json) return false;
  const errs = run.json.worktrees.flatMap((w) => (w.capture ? w.capture.errors : []));
  return errs.some((e) => /submodule sub\b/.test(e));
}

check("SUBMODULE RED: uncommitted content inside a submodule is NOT declared SAVED", () => {
  const { f, lane, sub } = mkSubmoduleLane();
  writeFileSync(join(sub, "rescue-me.txt"), `${SENTINEL}\n`);
  const dest = join(f.root, "rescue");
  const run = triageJson(["--repo", f.main, "--capture", dest]);

  // The tree IS at risk — that half already worked and must keep working.
  eq(rec(run.json, "submod").recoverability, "SALVAGE", "verdict");

  // IDENTITY, not a quantity: the error must NAME the submodule, so a reader
  // knows WHERE the unsaved work is. An exit code alone survives the obvious
  // repair of exiting 2 for an unrelated reason.
  assert(submoduleGapReported(run), `no capture error names the submodule: ${JSON.stringify(rec(run.json, "submod").capture)}`);

  eq(run.json.capture_complete, false, "capture_complete");
  eq(run.status, 2, "exit (2 = at-risk work was NOT fully captured)");

  // THE AUTHORISING SENTENCE. This is the actual defect: the tool told an
  // operator it was safe to destroy the tree.
  const human = triage(["--repo", f.main, "--capture", join(f.root, "rescue-human")]);
  assert(
    !human.stdout.includes("all at-risk work is SAVED"),
    "the tool still authorises reuse/removal of a tree whose submodule work it never captured",
  );
  assert(human.stdout.includes("INCOMPLETE"), "the human report does not flag the rescue as incomplete");

  // And the loss is REAL, so the error is honest rather than decorative: the
  // sentinel genuinely is not anywhere under the rescue directory.
  const found = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (readFileSync(p, "utf8").includes(SENTINEL)) found.push(p);
    }
  })(dest);
  eq(found.length, 0, "fixture premise: the sentinel is expected to be UNCAPTURED — capture now descends into submodules and this case needs rewriting");

  // The MANIFEST is what a human reads days later; the exit code reaches the
  // caller once.
  const slug = readdirSync(dest)[0];
  const manifest = readFileSync(join(dest, slug, "MANIFEST.txt"), "utf8");
  assert(manifest.includes("INCOMPLETE"), "MANIFEST.txt does not declare the rescue PARTIAL");
  assert(/submodule sub\b/.test(manifest), "MANIFEST.txt does not name the submodule that was not captured");
});

check("SUBMODULE RED: a gitlink that is not a repo yet HOLDS files fails CLOSED", () => {
  // Uninitialized-vs-unreadable ambiguity. The directory is not a git repo, so
  // the status probe cannot run — and it is not empty, so "uninitialized,
  // nothing to lose" cannot be concluded either. The only safe answer is to
  // report it.
  const { f, lane, sub } = mkSubmoduleLane({ init: false });
  writeFileSync(join(sub, "mystery.txt"), `${SENTINEL}\n`);
  writeFileSync(join(lane, "lane-output.txt"), "real parent work\n"); // makes the tree SALVAGE
  const run = triageJson(["--repo", f.main, "--capture", join(f.root, "rescue")]);
  assert(submoduleGapReported(run), `an ambiguous gitlink was passed over in silence: ${JSON.stringify(rec(run.json, "submod").capture)}`);
  eq(run.json.capture_complete, false, "capture_complete");
  eq(run.status, 2, "exit");
});

check("SUBMODULE GREEN: a CLEAN initialized submodule is not a false error", () => {
  // The no-false-positive pole. The submodule check RUNS (the gitlink is there
  // and initialized) and must stay QUIET, while the parent's real untracked
  // work is captured normally and the run still reports the all-clear.
  const { f, lane } = mkSubmoduleLane();
  writeFileSync(join(lane, "lane-output.txt"), `${SENTINEL}\n`);
  const dest = join(f.root, "rescue");
  const run = triageJson(["--repo", f.main, "--capture", dest]);

  eq(rec(run.json, "submod").recoverability, "SALVAGE", "verdict");
  eq(rec(run.json, "submod").capture.errors.length, 0, `a clean submodule produced a capture error: ${JSON.stringify(rec(run.json, "submod").capture.errors)}`);
  eq(run.json.capture_complete, true, "capture_complete");
  eq(run.status, 3, "exit (3 = at risk, and every at-risk tree WAS captured)");

  // VACUITY, the half that catches an assertion which cannot fail: the RED
  // predicate must NOT be satisfied here.
  assert(!submoduleGapReported(run), "the RED-pole predicate fires on the GREEN pole — it cannot discriminate");

  // And the parent's work really did land, so the green is not green-by-doing-nothing.
  const slug = readdirSync(dest)[0];
  assert(
    readFileSync(join(dest, slug, "untracked", "lane-output.txt"), "utf8").includes(SENTINEL),
    "the parent's untracked work was not captured",
  );
});

check("SUBMODULE GREEN: an UNINITIALIZED submodule is not a false error", () => {
  // git leaves an EMPTY placeholder directory for a submodule that was never
  // checked out. An empty directory cannot hold uncommitted content, so this
  // is the one non-repo arm allowed to stay silent — and it must, or every
  // fresh worktree in a submodule repo would report a phantom loss.
  const { f, lane, sub } = mkSubmoduleLane({ init: false });
  eq(readdirSync(sub).length, 0, "fixture premise: an uninitialized submodule is an EMPTY placeholder");
  writeFileSync(join(lane, "lane-output.txt"), "real parent work\n");
  const run = triageJson(["--repo", f.main, "--capture", join(f.root, "rescue")]);
  eq(rec(run.json, "submod").capture.errors.length, 0, `an uninitialized submodule produced a phantom capture error: ${JSON.stringify(rec(run.json, "submod").capture.errors)}`);
  eq(run.json.capture_complete, true, "capture_complete");
  eq(run.status, 3, "exit");
});

check("SUBMODULE: `--ignore-submodules=none` has BEHAVIOURAL backing — config cannot blank a dirty submodule", () => {
  // Deleting the flag from `classify()` used to red ONLY the source-text pin
  // above, and nothing else — measured. That is because git's DEFAULT already
  // reports a dirty submodule, so the flag's whole job is defeating INHERITED
  // CONFIG, exactly as `--untracked-files=all` defeats
  // `status.showUntrackedFiles=no`. `submodule.<name>.ignore=all` is that
  // lever, and it is the one a real repo carries: measured, with it set and
  // the flag absent, `git status` exits 0 with EMPTY output on a tree holding
  // uncommitted submodule work, so the lane is classified as though it held
  // nothing — the silent direction, one step before the tree is reused.
  const { f, lane, sub } = mkSubmoduleLane();
  writeFileSync(join(sub, "rescue-me.txt"), `${SENTINEL}\n`);
  git(lane, ["config", "submodule.sub.ignore", "all"]);
  const r = rec(triageJson(["--repo", f.main]).json, "submod");
  eq(r.recoverability, "SALVAGE", "a tree whose ONLY uncommitted work is inside a submodule, under `submodule.sub.ignore=all`");
  eq(r.dirty_count, 1, "dirty_count");
});

check("SUBMODULE RED: a submodule's OWN config cannot make a clean-READING tree LOST", () => {
  // The parent's pinned flags govern how the PARENT reports a submodule; they
  // do not govern the status run INSIDE it. Measured: with
  // `status.showUntrackedFiles=no` in the submodule, the parent's
  // `--ignore-submodules=none --untracked-files=all` exits 0 with EMPTY output
  // over a submodule holding untracked work — so the tree would be
  // dispositioned "nothing recoverable here" one step before it is reused.
  const { f, sub } = mkSubmoduleLane();
  writeFileSync(join(sub, "rescue-me.txt"), `${SENTINEL}\n`);
  git(sub, ["config", "status.showUntrackedFiles", "no"]);
  const r = rec(triageJson(["--repo", f.main]).json, "submod");

  // PREMISE CONTROL. Without this the case could pass for the wrong reason —
  // if the parent could still see the submodule, SALVAGE would prove nothing
  // about the clean-tree probe. Asserting the blindness is real is what makes
  // the verdict below attributable to the probe.
  eq(r.dirty_count, 0, "fixture premise: the parent's own status must read CLEAN here, or this case tests nothing");
  eq(r.recoverability, "SALVAGE", "a tree whose submodule holds work its own config hides from the parent was NOT flagged");
  assert(r.submodule_gaps.length > 0, "no submodule gap recorded on the record");
});

check("SUBMODULE GREEN: a fully clean tree with a clean submodule is NOT a phantom SALVAGE", () => {
  // The no-false-positive pole for the clean-tree probe, and the one that
  // matters most: if this over-fires, EVERY worktree in EVERY submodule repo
  // reports a phantom loss and the tool's whole signal is destroyed.
  const { f } = mkSubmoduleLane();
  const r = rec(triageJson(["--repo", f.main]).json, "submod");
  eq(r.dirty_count, 0, "dirty_count");
  // `|| []` deliberately: this is a NO-FALSE-POSITIVE pole and must report on
  // over-firing alone. The field's EXISTENCE is asserted by the RED case above,
  // where its absence is a real finding rather than an incidental one.
  eq((r.submodule_gaps || []).length, 0, `a clean submodule produced a phantom gap: ${JSON.stringify(r.submodule_gaps)}`);
  assert(r.recoverability !== "SALVAGE", `a clean tree with a clean submodule read as SALVAGE (${r.recoverability})`);
});

check("SUBMODULE: the gap probe's OWN status is pinned against the submodule's own config", () => {
  // The gap probe runs `git status` INSIDE the submodule, and a submodule
  // carries its own config. Unpinned, `status.showUntrackedFiles=no` there
  // blanks the very entries that make the gap real — and the failure is
  // fail-OPEN: the rescue would go back to reporting `capture_complete: true`
  // over uncaptured work. Same defence classify() already carries, one level
  // down.
  const { f, sub } = mkSubmoduleLane();
  writeFileSync(join(sub, "rescue-me.txt"), `${SENTINEL}\n`);
  git(sub, ["config", "status.showUntrackedFiles", "no"]);
  const run = triageJson(["--repo", f.main, "--capture", join(f.root, "rescue")]);
  assert(submoduleGapReported(run), `the submodule's own config blanked the gap probe: ${JSON.stringify(rec(run.json, "submod").capture)}`);
  eq(run.json.capture_complete, false, "capture_complete");
  eq(run.status, 2, "exit");
});

check("CRIT-2 RED: a second capture to the SAME destination does not clobber the first", () => {
  const f = mkForest();
  const lane = addLane(f, "twice", "lane-twice");
  const dest = join(f.root, "rescue-2026-08-20"); // Rule 4a's own DO-block shape
  writeFileSync(join(lane, "base.txt"), "base\nRESCUE-1-EDIT\n");
  eq(triage(["--repo", f.main, "--capture", dest]).status, 3, "first capture");
  const first = readdirSync(dest);
  eq(first.length, 1, "destinations after the first capture");
  const firstPatch = join(dest, first[0], "tracked.patch");
  const firstBytes = readFileSync(firstPatch, "utf8");
  assert(firstBytes.includes("RESCUE-1-EDIT"), "fixture setup: the first patch must carry the first edit");

  writeFileSync(join(lane, "base.txt"), "base\nRESCUE-2-EDIT\n");
  eq(triage(["--repo", f.main, "--capture", dest]).status, 3, "second capture");

  // IDENTITY, not a count: the first rescue's BYTES must be exactly what they were.
  eq(readFileSync(firstPatch, "utf8"), firstBytes, "the FIRST rescue's tracked.patch was overwritten by the second run");
  assert(!readFileSync(firstPatch, "utf8").includes("RESCUE-2-EDIT"), "the first rescue now carries the second run's edit");
  const after = readdirSync(dest).sort();
  eq(after.length, 2, `expected a suffixed sibling, got [${after.join(", ")}]`);
  assert(after.some((d) => /-2$/.test(d)), `no '-2' suffixed destination: [${after.join(", ")}]`);
  assert(readFileSync(join(dest, after.find((d) => /-2$/.test(d)), "tracked.patch"), "utf8").includes("RESCUE-2-EDIT"), "the suffixed rescue does not carry the second edit");
});
check("CRIT-2 GREEN: a FIRST capture into a fresh destination still uses the unsuffixed slug", () => {
  const f = mkForest();
  const lane = addLane(f, "once", "lane-once");
  dirtyIn(lane);
  const dest = join(f.root, "rescue-fresh");
  triage(["--repo", f.main, "--capture", dest]);
  const got = readdirSync(dest);
  eq(got.length, 1, "destinations");
  // The UNSUFFIXED slug is `<basename>-<sha256(path)[0..8)>` (captureSlug) — the
  // 8 hex chars ARE the slug, not a collision suffix; only `-2`, `-3` … are.
  // So the bare-slug test is "still ends in the 8-hex digest", NOT "does not end
  // in digits". The earlier `!/-\d+$/` form read an ALL-DECIMAL digest as a
  // collision suffix: measured 49 false failures over 2000 first-captures in
  // two independent samples (2.45%, 95% CI 1.8–3.1%; analytic (10/16)^8 =
  // 2.33%), against 0/2000 for the form below. The fixture root is a fresh
  // mkdtempSync path every run, so that was fresh entropy per run.
  // That made this negative control INTERMITTENTLY VACUOUS — the worst kind.
  // Every observed failure was a bare `once-<8 decimal digits>` with no `-N`
  // sibling in `dest`, which is what proves no real collision ever occurred.
  assert(/-[0-9a-f]{8}$/.test(got[0]), `a first capture was needlessly suffixed: ${got[0]}`);
});
check("CRIT-2: a third capture takes -3, so suffixing is not a one-shot", () => {
  const f = mkForest();
  const lane = addLane(f, "thrice", "lane-thrice");
  const dest = join(f.root, "rescue-3");
  for (const n of [1, 2, 3]) {
    writeFileSync(join(lane, "base.txt"), `base\nEDIT-${n}\n`);
    triage(["--repo", f.main, "--capture", dest]);
  }
  const got = readdirSync(dest).sort();
  eq(got.length, 3, `destinations: [${got.join(", ")}]`);
  assert(got.some((d) => /-3$/.test(d)), `no '-3' destination: [${got.join(", ")}]`);
});

check("HIGH-4 CONTROL: an EACCES parent makes the lane unstattable (else this arm is inert)", () => {
  const f = mkForest();
  addLane(f, "shadowed", "lane-shadowed");
  const wtParent = join(f.root, "wt");
  chmodSync(wtParent, 0o000);
  try {
    let threw = null;
    try {
      statSync(f.wt("shadowed"));
    } catch (e) {
      threw = e.code;
    }
    assert(threw === "EACCES", `expected EACCES from an unreadable parent, got ${threw} — running as root? this arm cannot fire`);
    assert(!existsSync(f.wt("shadowed")), "existsSync must ALSO be false here — that is the defect being fixed");
  } finally {
    chmodSync(wtParent, 0o755);
  }
});
check("HIGH-4 RED: an UNREADABLE directory is SALVAGE, never 'already gone'", () => {
  const f = mkForest();
  const lane = addLane(f, "shadowed2", "lane-shadowed2");
  writeFileSync(join(lane, "unsaved.md"), "work that is still on disk\n");
  const wtParent = join(f.root, "wt");
  chmodSync(wtParent, 0o000);
  try {
    const run = triageJson(["--repo", f.main]);
    const r = rec(run.json, "shadowed2");
    eq(r.recoverability, "SALVAGE", "verdict — unreadable must fail closed toward rescue");
    eq(r.directory_present, null, "directory_present is UNKNOWN, not false");
    eq(r.directory_state, "unreadable", "directory_state");
    assert(r.reasons.join(" ").includes("unreadable"), "the reason does not name the unreadable directory");
    assert(!r.reasons.join(" ").includes("already gone"), "an unreadable directory was described as already gone");
  } finally {
    chmodSync(wtParent, 0o755);
  }
});
check("HIGH-4 GREEN: a genuinely ABSENT directory is still NOT SALVAGE", () => {
  const f = mkForest();
  const lane = addLane(f, "reallygone", "lane-reallygone");
  commitIn(lane, "g.txt", "g\n", "work");
  rmSync(lane, { recursive: true, force: true });
  const r = rec(triageJson(["--repo", f.main]).json, "reallygone");
  assert(r.recoverability !== "SALVAGE", "a genuinely absent directory was classified SALVAGE — the fix over-widened");
  eq(r.directory_present, false, "directory_present");
  eq(r.directory_state, "absent", "directory_state");
});
check("HIGH-4: an UNREADABLE SALVAGE tree under --capture is a LOUD failure, not a silent skip", () => {
  const f = mkForest();
  const lane = addLane(f, "shadowed3", "lane-shadowed3");
  writeFileSync(join(lane, "unsaved.md"), "still on disk\n");
  const wtParent = join(f.root, "wt");
  const dest = join(f.root, "rescue");
  chmodSync(wtParent, 0o000);
  try {
    const run = triageJson(["--repo", f.main, "--capture", dest]);
    eq(run.status, 2, "exit — an at-risk tree that could not be captured must downgrade the run");
    eq(run.json.capture_complete, false, "capture_complete");
    const r = rec(run.json, "shadowed3");
    assert(r.capture && r.capture.errors.length > 0, "the uncapturable tree carries no error record — it was skipped in silence");
    assert(r.capture.errors.join(" ").includes("UNSAVED"), "the error does not say the work is unsaved");
  } finally {
    chmodSync(wtParent, 0o755);
  }
});

check("MED-5: a new untracked DIRECTORY is counted per FILE, not collapsed to one entry", () => {
  const f = mkForest();
  const lane = addLane(f, "manyfiles", "lane-manyfiles");
  mkdirSync(join(lane, "out", "deeper"), { recursive: true });
  for (const n of ["a", "b", "c"]) writeFileSync(join(lane, "out", `${n}.txt`), `${n}\n`);
  writeFileSync(join(lane, "out", "deeper", "d.txt"), "d\n");
  const r = rec(triageJson(["--repo", f.main]).json, "manyfiles");
  eq(r.recoverability, "SALVAGE", "verdict");
  eq(r.dirty_count, 4, "dirty_count — the default -u collapses this whole tree to one '?? out/' entry");
  assert(!r.dirty_paths.some((p) => p.endsWith("out/")), `a directory entry leaked into dirty_paths: [${r.dirty_paths.join(", ")}]`);
});
check("MED-5: dirty_count agrees with the number of files capture actually copies", () => {
  const f = mkForest();
  const lane = addLane(f, "agree", "lane-agree");
  mkdirSync(join(lane, "out"), { recursive: true });
  for (const n of ["a", "b", "c"]) writeFileSync(join(lane, "out", `${n}.txt`), `${n}\n`);
  const dest = join(f.root, "rescue");
  const run = triageJson(["--repo", f.main, "--capture", dest]);
  const r = rec(run.json, "agree");
  const slug = readdirSync(dest)[0];
  const copied = readdirSync(join(dest, slug, "untracked", "out"));
  eq(copied.length, r.dirty_count, "the count a human reads must equal the files the rescue holds");
});

check("MED-6: an untracked symlink→FILE is captured AS a symlink, not dereferenced", () => {
  const f = mkForest();
  const lane = addLane(f, "symfile", "lane-symfile");
  writeFileSync(join(lane, "target.txt"), "target body\n");
  symlinkSync("target.txt", join(lane, "link.txt"));
  const dest = join(f.root, "rescue");
  triage(["--repo", f.main, "--capture", dest]);
  const slug = readdirSync(dest)[0];
  const captured = join(dest, slug, "untracked", "link.txt");
  assert(lstatSync(captured).isSymbolicLink(), "the symlink was dereferenced into a regular file — the restore would not reproduce the lane");
  eq(readlinkSync(captured), "target.txt", "link target");
});
check("MED-6 RED: an untracked symlink→DIRECTORY is never silently dropped", () => {
  const f = mkForest();
  const lane = addLane(f, "symdir", "lane-symdir");
  mkdirSync(join(lane, "realdir"), { recursive: true });
  writeFileSync(join(lane, "realdir", "inner.txt"), "inner\n");
  symlinkSync("realdir", join(lane, "dirlink"));
  const dest = join(f.root, "rescue");
  const run = triageJson(["--repo", f.main, "--capture", dest]);
  const slug = readdirSync(dest)[0];
  const captured = join(dest, slug, "untracked", "dirlink");
  // The old code `stat`ed it, saw a directory, and `continue`d: gone from the
  // rescue, absent from the MANIFEST, exit still 3 as though all was saved.
  assert(lstatSync(captured).isSymbolicLink(), "the symlink→dir was dropped from the capture");
  const manifest = readFileSync(join(dest, slug, "MANIFEST.txt"), "utf8");
  assert(manifest.includes("dirlink"), "the MANIFEST does not name the captured symlink");
  eq(rec(run.json, "symdir").capture.errors.length, 0, "capture errors");
});
check("MED-6: a MANIFEST for a PARTIAL rescue says INCOMPLETE on its own face", () => {
  const f = mkForest();
  const lane = addLane(f, "partial", "lane-partial");
  dirtyIn(lane);
  // A dangling symlink: `ls-files --others` lists it, and recreating it works,
  // so force the failure with an unreadable regular file instead.
  writeFileSync(join(lane, "locked.txt"), "secret\n");
  chmodSync(join(lane, "locked.txt"), 0o000);
  const dest = join(f.root, "rescue");
  try {
    const run = triageJson(["--repo", f.main, "--capture", dest]);
    const slug = readdirSync(dest)[0];
    const manifest = readFileSync(join(dest, slug, "MANIFEST.txt"), "utf8");
    if (run.status === 2) {
      assert(manifest.includes("INCOMPLETE"), "a partial rescue's MANIFEST reads exactly like a complete one");
      eq(run.json.capture_complete, false, "capture_complete");
    } else {
      // Running with privileges that defeat the 0o000 — say so, do not pass silently.
      assert(false, `INERT: the unreadable file was copied anyway (exit ${run.status}); this arm cannot observe a partial rescue here`);
    }
  } finally {
    chmodSync(join(lane, "locked.txt"), 0o644);
  }
});

check("MED-7: --capture with every tree saved reports capture_complete true and says so", () => {
  const f = mkForest();
  const lane = addLane(f, "saved", "lane-saved");
  dirtyIn(lane);
  const dest = join(f.root, "rescue");
  const run = triageJson(["--repo", f.main, "--capture", dest]);
  eq(run.status, 3, "exit — at risk, and saved");
  eq(run.json.capture_complete, true, "capture_complete");
  const human = triage(["--repo", f.main, "--capture", join(f.root, "rescue2")]);
  assert(/captured 1\/1 at-risk tree/.test(human.stdout), "the human report does not state how many at-risk trees were saved");
  assert(human.stdout.includes("all at-risk work is SAVED"), "the human report does not distinguish at-risk-SAVED from at-risk-UNSAVED");
});
check("MED-7: without --capture, capture_complete is null and the report says nothing is saved", () => {
  const f = mkForest();
  const lane = addLane(f, "unsaved", "lane-unsaved");
  dirtyIn(lane);
  const run = triageJson(["--repo", f.main]);
  eq(run.status, 3, "exit");
  eq(run.json.capture_complete, null, "capture_complete must be null, not false — nothing was attempted");
  assert(triage(["--repo", f.main]).stdout.includes("ACTION:"), "the report does not tell the operator to capture");
});

check("LOW: an unresolvable --capture target is REFUSED before any capture is written", () => {
  const f = mkForest();
  const lane = addLane(f, "loop", "lane-loop");
  dirtyIn(lane);
  // A self-referential symlink: every resolution of a path THROUGH it raises
  // ELOOP.
  //
  // SCOPE, stated rather than implied: this exercises the REFUSAL, not
  // `realOrResolve`'s final catch. The walk-up finds the temp root — which
  // exists and realpaths fine — so resolution returns a joined path and the
  // refusal comes from the mkdir. The final catch needs realpath to fail on an
  // ancestor that EXISTS (EIO, ENAMETOOLONG), which this harness cannot
  // manufacture portably; it is a defensive last resort and is NOT claimed to
  // be covered here. What IS asserted is the property that matters to a
  // caller: refuse, and write nothing.
  const loop = join(f.root, "loopdir");
  symlinkSync(loop, loop);
  const r = triage(["--repo", f.main, "--capture", join(loop, "rescue")]);
  eq(r.status, 1, "exit — an unusable containment target must refuse");
  assert(r.stderr.includes("--capture"), `the refusal does not name the flag at fault: ${r.stderr.trim().split("\n")[0]}`);
  assert(!existsSync(join(f.root, "loopdir", "rescue")), "a rescue was written under the refused target");
});
check("LOW CONTROL: the SAME forest with a resolvable target does capture (the refusal is targeted)", () => {
  const f = mkForest();
  const lane = addLane(f, "loop-ok", "lane-loop-ok");
  dirtyIn(lane);
  const r = triage(["--repo", f.main, "--capture", join(f.root, "rescue-ok")]);
  eq(r.status, 3, "exit — a legitimate target must not be caught by the refusal");
  eq(readdirSync(join(f.root, "rescue-ok")).length, 1, "destinations");
});

// ════════════════════════════════════════════════════════════════════════════
// CLI SURFACE
// ════════════════════════════════════════════════════════════════════════════

check("CLI: --help exits 0 and names all four classes", () => {
  const r = triage(["--help"]);
  eq(r.status, 0, "exit");
  for (const c of ["SALVAGE", "PUSHED", "UNPUSHED", "LOST"]) assert(r.stdout.includes(c), `--help omits ${c}`);
});
check("CLI: an unknown flag exits 1 rather than running a partial triage", () => {
  eq(triage(["--repo", F.main, "--reap"]).status, 1, "exit");
});
check("CLI: a flag missing its value exits 1 rather than silently defaulting", () => {
  eq(triage(["--repo"]).status, 1, "exit");
});
check("CLI: a non-repository --repo exits 1 and says so", () => {
  const d = mkdtempSync(join(tmpdir(), "wt-triage-norepo-"));
  cleanup.push(d);
  const r = triage(["--repo", d]);
  eq(r.status, 1, "exit");
  assert(r.stderr.includes("not a git repository"), "the error does not name the cause");
});
check("CLI: --json emits parseable JSON carrying counts and per-tree records", () => {
  const j = triageJson(["--repo", F.main]).json;
  assert(j && j.counts && Array.isArray(j.worktrees), "JSON shape");
  assert(
    j.worktrees.every(
      (w) => typeof w.path === "string" && typeof w.recoverability === "string" && typeof w.verdict === "string",
    ),
    "record shape — every record carries a path, a recoverability class, AND the shared removal-safety verdict",
  );
});
check("CLI: the human report tells the operator what to DO when work is at risk", () => {
  const r = triage(["--repo", F.main]);
  assert(r.stdout.includes("--capture"), "the report does not name the capture affordance");
});

// ════════════════════════════════════════════════════════════════════════════
// STRUCTURAL — the tool CANNOT reach a destructive operation
//
// Parsed from the tool's git ARGUMENT ARRAYS and its imported identifiers, not
// grepped from its text: the tool's header comment says in prose that it never
// removes a worktree, and a prose grep would be satisfied by that sentence
// alone — an instrument the subject can satisfy by talking about itself.
// ════════════════════════════════════════════════════════════════════════════

check("STRUCTURAL CONTROL: the argument-array parser actually finds the tool's git calls", () => {
  assert(GIT_TOKENS.length >= 6, `parsed only ${GIT_TOKENS.length} git argument arrays — the sweep below would be near-vacuous`);
  assert(GIT_TOKENS.some((t) => t[0] === "status"), "the parser did not find the status call it is known to contain");
});
check("STRUCTURAL: every git subcommand the tool can invoke is on a read-only allowlist", () => {
  const allowed = new Set(["rev-parse", "worktree", "status", "rev-list", "symbolic-ref", "for-each-ref", "diff", "ls-files"]);
  for (const toks of GIT_TOKENS) {
    const sub = toks.find((t) => !t.startsWith("-"));
    assert(allowed.has(sub), `git subcommand '${sub}' is outside the read-only allowlist`);
  }
});
check("STRUCTURAL: `git worktree` is only ever invoked with `list`", () => {
  for (const toks of GIT_TOKENS) {
    if (toks[0] !== "worktree") continue;
    eq(toks[1], "list", "the subcommand after `worktree`");
  }
});
check("STRUCTURAL: no git argument array contains --force, -f, stash, or add -N", () => {
  for (const toks of GIT_TOKENS) {
    for (const forbidden of ["--force", "-f", "stash", "remove", "prune", "clean", "reset", "checkout", "restore", "-N"]) {
      assert(!toks.includes(forbidden), `git argument array contains '${forbidden}': [${toks.join(" ")}]`);
    }
  }
});
check("STRUCTURAL: the tool imports no destructive fs primitive", () => {
  for (const id of ["rmSync", "unlinkSync", "rmdirSync", "renameSync", "truncateSync", "rimraf"]) {
    assert(!new RegExp(`\\b${id}\\b`).test(SRC), `the tool references ${id}`);
  }
});
check("STRUCTURAL: the tool spawns processes from exactly ONE call site", () => {
  const spawns = [...SRC.matchAll(/\b(execFileSync|execSync|spawnSync|spawn|exec)\s*\(/g)].map((m) => m[1]);
  eq(spawns.length, 1, `process-spawning call sites: [${spawns.join(", ")}]`);
  eq(spawns[0], "execFileSync", "the spawning primitive (execFileSync takes an argv array — no shell)");
});
check("STRUCTURAL CONTROL: the destructive-identifier sweep FIRES on a known-positive", () => {
  const planted = `${SRC}\nrmSync("/", { recursive: true });\n`;
  assert(/\brmSync\b/.test(planted), "the identifier sweep cannot detect rmSync even when it is present");
});

// ── isolation ──

check("ISOLATION: no fixture forest was built inside the loom repository", () => {
  for (const d of cleanup) assert(!resolve(d).startsWith(REPO_ROOT + "/"), `fixture root ${d} is inside the repo`);
});
check("ISOLATION: every fixture forest lives under the system temp dir", () => {
  const t = resolve(tmpdir());
  for (const d of cleanup) assert(resolve(d).startsWith(t), `fixture root ${d} is outside ${t}`);
});

// ════════════════════════════════════════════════════════════════════════════

for (const d of cleanup) {
  try {
    // Restore any mode the fixtures tightened, so the temp tree can be removed.
    for (const p of [d]) if (existsSync(p)) chmodSync(p, 0o755);
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not a fixture failure */
  }
}

process.stdout.write(`\nworktree-triage fixtures: ${passes} pass / ${failures} fail\n`);
process.exit(failures === 0 ? 0 : 1);
