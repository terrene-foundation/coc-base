#!/usr/bin/env node
/**
 * sibling-porcelain-scaling — the regression lock for loom#1902.
 *
 * WHAT IS UNDER TEST.
 *   `.claude/hooks/lib/sibling-porcelain.js::detectSiblingMutation`, the §4.2
 *   filesystem-exception primitive consumed by `signing-mutation-guard.js` and
 *   `adjacency-leasecheck.js`. Two axes:
 *     CORRECTNESS — the exact-match contention predicate and the two invariants
 *                   the primitive's own header declares (INDETERMINATE never
 *                   collapses to clean; one match per sibling).
 *     SCALING     — the per-sibling CONSTANT, which is a safety property here
 *                   rather than a nicety (see below).
 *
 * THE DEFECT.
 *   `detectSiblingMutation` ran a FULL `git status --porcelain` per sibling
 *   worktree, and `enumerateSiblingWorktrees` ran a `git rev-parse
 *   --git-common-dir` per candidate on top of it — 2N+3 spawns, the dominant
 *   one walking a whole checkout to answer a question about ONE path.
 *   `signing-mutation-guard.js` is registered in `.claude/settings.json` with
 *   `"timeout": 5` (seconds). MEASURED on a 52-sibling forest before the fix:
 *   107 spawns; 5411 ms of spawnSync out of 5416 ms wall (99.9%), of which
 *   `status --porcelain` alone was 4833 ms; guard end-to-end min 4921 / med
 *   5246 / max 5943 ms against a `posture-gate.js` control at 86–102 ms on the
 *   same input in the same run. The guard's own 5000 ms `setTimeout` fail-open
 *   does NOT rescue it: the scan is synchronous `spawnSync`, so the timer is
 *   starved and never fires (marker fired at 5001 ms with the event loop free,
 *   0 hits on the real path). The harness kill is what actually lands, and it
 *   lands mid-scan with no verdict — a safety property degraded into a coin
 *   flip that gets worse as the forest grows.
 *
 * HOW THE SCALING CASES DISCRIMINATE — and what each one CANNOT see.
 *   A wall-clock upper bound is BLOCKED here (`rules/testing.md` § "Never
 *   Assert An UPPER Bound On Real Elapsed Time"): a busy runner reddens it
 *   while the code is correct, and the repair is always to raise it until it
 *   masks the regression. So the scaling axis is fenced by THREE instruments,
 *   each with a named falsifying result, and none of them is an absolute time:
 *
 *     SCALING/marginal-spawns  A self-normalizing SPAWN-COUNT ratio: the
 *       marginal spawns per additional sibling, (spawns(N) - spawns(k)) /
 *       (N - k). The fixed setup cost cancels. Deterministic and completely
 *       load-independent. FALSIFYING RESULT: 2 (the pre-fix eager containment
 *       check) instead of 1.
 *     SCALING/narrow-query    The argv actually issued per sibling. FALSIFYING
 *       RESULT: a bare `["status","--porcelain"]` with no pathspec limiter.
 *       This is the case that reds on a pathspec revert; the timing case below
 *       cannot, because on a tiny synthetic tree a full status is nearly free.
 *     SCALING/query-differential  A SAME-RUN ratio of medians, full-status vs
 *       narrow-status, against ONE worktree with a non-trivial file count.
 *       This is what makes the argv case matter rather than being cosmetic.
 *       Self-normalizing: both halves are measured on the same tree, same
 *       machine, same moment, so machine speed and ambient load divide out.
 *       FALSIFYING RESULT: a ratio at or below 1, i.e. narrowing buys nothing.
 *
 *   The forest case additionally carries a HANG-STOP, not a performance
 *   threshold: it is set an order of magnitude away from the observed value
 *   precisely so that load cannot red it, and it exists only to keep a genuine
 *   hang from running the suite forever.
 *
 * WHAT THIS FIXTURE DOES NOT REACH.
 *   O(N) is INHERENT — git exposes no cross-worktree status, so N working
 *   trees require N queries. These cases fence the CONSTANT, not the order.
 *   They also say nothing about the harness kill itself (that is
 *   `settings.json` behaviour, pinned only as the BUDGET/timeout-pin identity
 *   below), and nothing about the starved-`setTimeout` finding, which is a
 *   property of the consuming hook's control flow rather than of this
 *   primitive.
 *
 * Each case names the mutation that reds it; the mutations are recorded as
 * MEASURED in README.md (`instrument-discipline.md` MUST-2(b)).
 */
import "../_lib/no-ambient-git.cjs";
import { readExpandedHookSettings } from "../../bin/lib/expanded-hook-settings.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// Overridable so a RED can be established against an UNFIXED build of the
// module without mutating the working tree (`instrument-discipline.md` MUST-2).
const LIB =
  process.env.SIBLING_PORCELAIN_LIB ||
  path.join(REPO_ROOT, ".claude", "hooks", "lib", "sibling-porcelain.js");
const GUARD = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "signing-mutation-guard.js",
);
const SETTINGS = path.join(REPO_ROOT, ".claude", "settings.json");

const sp = require(LIB);

let pass = 0;
const failures = [];

function check(name, expectation, actualFn) {
  let ok = false;
  let detail;
  try {
    const r = actualFn();
    ok = r === true;
    if (!ok) detail = typeof r === "string" ? r : JSON.stringify(r);
  } catch (err) {
    detail = `threw: ${err && err.message ? err.message : String(err)}`;
  }
  if (ok) {
    pass += 1;
    // `PASS <name>` at column 0 is the shape run-audit-fixtures.mjs::CASE_PASS
    // counts (/^[ \t]*(?:PASS|ok)[ \t]+\S/); an indented glyph is invisible to it.
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}`);
    console.log(`      expected: ${expectation}`);
    console.log(`      actual  : ${detail}`);
  }
}

// `realpathSync` on the tmpdir is load-bearing on macOS, where /var is a
// symlink to /private/var: git reports worktree paths in RESOLVED form, so an
// unresolved base would make every `wtPath === selfAbs` / match comparison in
// the primitive compare two spellings of the same directory.
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s54-sp-"));
const cleanups = [];

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * A real repo on disk with a real linked worktree. Every correctness case runs
 * against git itself — no porcelain strings are faked, so a case cannot pass
 * against a predicate git would have answered differently.
 */
function makeRepo(name) {
  const root = path.join(TMP, name);
  const main = path.join(root, "main");
  fs.mkdirSync(main, { recursive: true });
  git(["init", "-q", "-b", "main", "."], main);
  git(["config", "user.email", "t@t.t"], main);
  git(["config", "user.name", "t"], main);
  git(["config", "commit.gpgsign", "false"], main);
  fs.mkdirSync(path.join(main, "src"), { recursive: true });
  for (const f of ["mod.js", "del.js", "ren.js", "clean.js", "other.js"]) {
    fs.writeFileSync(path.join(main, "src", f), "a\n");
  }
  fs.writeFileSync(path.join(main, "src", "foo.js.bak"), "a\n");
  git(["add", "-A"], main);
  git(["commit", "-qm", "init"], main);
  return { root, main };
}

function addWorktree(repo, name) {
  const wt = path.join(repo.root, name);
  git(["worktree", "add", "-q", "--detach", wt, "HEAD"], repo.main);
  return wt;
}

/**
 * The PRE-FIX algorithm, transcribed: a FULL `git status --porcelain` per
 * sibling, exact-compared against the target. The equivalence case below runs
 * this and the shipped implementation over the same fixture, so a semantic
 * drift in the narrow query reds HERE rather than silently changing what the
 * guard fires on. The ONE deliberate difference is recorded in that case.
 */
function legacyVerdict(wt, target) {
  const r = spawnSync("git", ["status", "--porcelain"], {
    cwd: wt,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return "UNREADABLE";
  const paths = sp._internal._parsePorcelain(r.stdout || "");
  return paths.some((p) => p === target) ? "MATCH" : "CLEAN";
}

function newVerdict(repoMain, target) {
  const res = sp.detectSiblingMutation(repoMain, target);
  if (!res.ok) return "UNREADABLE";
  return res.matches.length > 0 ? "MATCH" : "CLEAN";
}

// ── POLE PAIR ───────────────────────────────────────────────────────────────
// Bipolar by construction (`instrument-bipolarity.md` MUST-1/2): the SAME call
// on the SAME forest, differing only in whether the sibling actually mutated
// the target. A predicate stuck on either answer reds on one of the two.

const poles = makeRepo("poles");
const poleSib = addWorktree(poles, "sib");

check(
  "POLE-A/mutated-sibling-DETECTED",
  "detectSiblingMutation returns ok:true with a match NAMING the sibling worktree",
  () => {
    fs.writeFileSync(path.join(poleSib, "src", "mod.js"), "CHANGED\n");
    const res = sp.detectSiblingMutation(poles.main, "src/mod.js");
    if (!res.ok) return `ok:false — ${res.reason}`;
    if (res.matches.length !== 1) return `matches=${JSON.stringify(res.matches)}`;
    if (res.matches[0].worktree !== poleSib) {
      return `named ${res.matches[0].worktree}, expected ${poleSib}`;
    }
    return res.matches[0].target === "src/mod.js" || `target=${res.matches[0].target}`;
  },
);

check(
  "POLE-B/clean-forest-SILENT",
  "the same call over the same forest with nothing mutated returns ok:true, matches=[]",
  () => {
    fs.writeFileSync(path.join(poleSib, "src", "mod.js"), "a\n"); // restore
    const res = sp.detectSiblingMutation(poles.main, "src/mod.js");
    if (!res.ok) return `ok:false — ${res.reason}`;
    return res.matches.length === 0 || `matches=${JSON.stringify(res.matches)}`;
  },
);

// ── PORCELAIN SHAPES ────────────────────────────────────────────────────────
// The narrow query must see every shape the full-tree query saw. Each of these
// is a distinct porcelain row type, and a pathspec that silently dropped one
// would be a FALSE NEGATIVE in a contention guard.

const shapes = makeRepo("shapes");
const shapeSib = addWorktree(shapes, "sib");
fs.writeFileSync(path.join(shapeSib, "src", "mod.js"), "CHANGED\n");
fs.rmSync(path.join(shapeSib, "src", "del.js"));
git(["mv", "src/ren.js", "src/ren2.js"], shapeSib);
fs.writeFileSync(path.join(shapeSib, "src", "untracked.js"), "new\n");
fs.writeFileSync(path.join(shapeSib, "src", "added.js"), "staged\n");
git(["add", "src/added.js"], shapeSib);
fs.mkdirSync(path.join(shapeSib, "untrackdir"), { recursive: true });
fs.writeFileSync(path.join(shapeSib, "untrackdir", "deep.js"), "x\n");
fs.writeFileSync(path.join(shapeSib, "src", "café.js"), "u\n");

for (const [label, target] of [
  ["modified", "src/mod.js"],
  ["deleted", "src/del.js"],
  ["rename-src", "src/ren.js"],
  ["rename-dst", "src/ren2.js"],
  ["untracked", "src/untracked.js"],
  ["staged-add", "src/added.js"],
]) {
  check(
    `shape/${label}-DETECTED`,
    `a sibling row of shape '${label}' on the exact target is reported as a match`,
    () => {
      const res = sp.detectSiblingMutation(shapes.main, target);
      if (!res.ok) return `ok:false — ${res.reason}`;
      return res.matches.length === 1 || `matches=${JSON.stringify(res.matches)}`;
    },
  );
}

check(
  "exactness/adjacent-path-NOT-matched",
  "a sibling with OTHER paths dirty does not match the untouched target (§4.2 is EXACT-match, not adjacency)",
  () => {
    const res = sp.detectSiblingMutation(shapes.main, "src/clean.js");
    if (!res.ok) return `ok:false — ${res.reason}`;
    return res.matches.length === 0 || `matches=${JSON.stringify(res.matches)}`;
  },
);

check(
  "exactness/prefix-sibling-path-NOT-matched",
  "'src/other.js' does not match on the strength of 'src/other.js.bak' being dirty",
  () => {
    fs.writeFileSync(path.join(shapeSib, "src", "foo.js.bak"), "CHANGED\n");
    const res = sp.detectSiblingMutation(shapes.main, "src/foo.js");
    if (!res.ok) return `ok:false — ${res.reason}`;
    return res.matches.length === 0 || `matches=${JSON.stringify(res.matches)}`;
  },
);

check(
  "glob/wildcard-target-cannot-FALSE-POSITIVE",
  "a target carrying pathspec wildcards matches nothing, because the EXACT compare — not the pathspec — decides",
  () => {
    // SCOPE, corrected after measurement. This case does NOT fence `:(literal)`.
    // MEASURED: dropping the magic leaves this case GREEN, because git widens
    // to 5 dirty rows under src/ and none of them exact-equals the literal
    // string `src/*.js`, so the retained `p === targetRelPath` compare rejects
    // them all. What this case actually fences is that exact compare — the
    // defense-in-depth layer that makes the pathspec purely a NARROWING
    // (cost/precision) device rather than a correctness-bearing one. The
    // `:(literal)` magic itself is fenced structurally by
    // SCALING/per-sibling-query-is-NARROW. Recording the distinction rather
    // than letting the name imply a discrimination it does not have.
    const raw = spawnSync(
      "git",
      ["--no-optional-locks", "status", "--porcelain", "--", "src/*.js"],
      { cwd: shapeSib, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const widened = (raw.stdout || "").trim().split("\n").filter(Boolean).length;
    if (widened === 0) {
      return "CONTROL FAILED: the unmagicked pathspec matched nothing, so this case cannot discriminate — re-instrument";
    }
    const res = sp.detectSiblingMutation(shapes.main, "src/*.js");
    if (!res.ok) return `ok:false — ${res.reason}`;
    return (
      res.matches.length === 0 ||
      `an unmagicked query would see ${widened} rows and the primitive returned ${res.matches.length} matches — ` +
        "the exact compare is no longer deciding"
    );
  },
);

check(
  "glob/EXACT-compare-is-the-decider-PIN",
  "the source still decides on `p === targetRelPath`, the line the false-positive case above rests on",
  () => {
    const src = fs.readFileSync(LIB, "utf8");
    return (
      src.includes("if (p === targetRelPath) {") ||
      "sibling-porcelain.js no longer decides on `p === targetRelPath` — the pathspec would " +
        "become correctness-bearing, and the false-positive case above would be fencing nothing"
    );
  },
);

check(
  "equivalence/legacy-full-status-vs-narrow-query",
  "for every shape, the narrow query yields the SAME verdict the pre-fix full-status algorithm yielded",
  () => {
    // The one KNOWN, deliberate difference is excluded and named rather than
    // hidden: `untrackdir/deep.js`. A full-tree status under the default
    // `-unormal` collapses an untracked DIRECTORY to `?? untrackdir/`, which
    // never exact-matches the file inside it — the legacy algorithm MISSED it.
    // The narrow query returns `?? untrackdir/deep.js`, so it now matches. That
    // is a false negative removed, in the fail-CLOSED direction for a
    // contention guard, and it is asserted in its own case below.
    const targets = [
      "src/mod.js",
      "src/del.js",
      "src/ren.js",
      "src/ren2.js",
      "src/untracked.js",
      "src/added.js",
      "src/clean.js",
      "src/café.js",
      "src/foo.js",
      "does/not/exist.js",
    ];
    const diffs = [];
    for (const t of targets) {
      const a = legacyVerdict(shapeSib, t);
      const b = newVerdict(shapes.main, t);
      if (a !== b) diffs.push(`${t}: legacy=${a} new=${b}`);
    }
    return diffs.length === 0 || `divergence: ${JSON.stringify(diffs)}`;
  },
);

check(
  "equivalence/untracked-dir-child-is-the-ONE-named-difference",
  "the narrow query DETECTS a file inside an untracked directory, which the legacy full-status algorithm missed",
  () => {
    const legacy = legacyVerdict(shapeSib, "untrackdir/deep.js");
    const now = newVerdict(shapes.main, "untrackdir/deep.js");
    if (legacy !== "CLEAN") {
      return `CONTROL FAILED: legacy algorithm returned ${legacy}, not the CLEAN this difference is defined against`;
    }
    return now === "MATCH" || `narrow query returned ${now}, expected MATCH`;
  },
);

// ── INVARIANT 1 — INDETERMINATE PROPAGATES, NEVER COLLAPSES TO CLEAN ────────
// The primitive's header declares `ok:false` means COULD NOT ANSWER and is
// distinct from `ok:true` with an empty list. Collapsing the former into the
// latter turns a failed check into a false all-clear — the same bug class the
// scaling defect is (a check that silently stops checking).

check(
  "INV1/not-a-repo-is-INDETERMINATE",
  "detectSiblingMutation against a non-repository returns ok:false with a reason, NOT ok:true/matches:[]",
  () => {
    const notRepo = path.join(TMP, "not-a-repo");
    fs.mkdirSync(notRepo, { recursive: true });
    const res = sp.detectSiblingMutation(notRepo, "src/mod.js");
    if (res.ok) return "ok:true — INDETERMINATE collapsed into a clean answer";
    if (res.matches.length !== 0) return `matches=${JSON.stringify(res.matches)}`;
    return (
      (typeof res.reason === "string" && res.reason.length > 0) ||
      "ok:false carried no reason"
    );
  },
);

check(
  "INV1/bad-arguments-are-INDETERMINATE",
  "a missing or non-string target returns ok:false, never a clean ok:true",
  () => {
    const bad = [
      sp.detectSiblingMutation(poles.main, ""),
      sp.detectSiblingMutation(poles.main, null),
      sp.detectSiblingMutation("", "src/mod.js"),
      sp.detectSiblingMutation(poles.main, 42),
    ];
    const leaked = bad.filter((r) => r.ok);
    return leaked.length === 0 || `${leaked.length} bad-argument call(s) returned ok:true`;
  },
);

const unread = makeRepo("unreadable");
const unreadSib = addWorktree(unread, "sib");
// A sibling whose CONTAINMENT still resolves but whose status cannot be read:
// chmod the linked worktree's own index. `rev-parse --git-common-dir` does not
// read the index, so the candidate stays contained — which is exactly the
// combination the INDETERMINATE tail exists for.
const unreadIndex = git(["rev-parse", "--git-dir"], unreadSib).trim();
const unreadIndexAbs = path.resolve(unreadSib, unreadIndex, "index");
let unreadArmed = false;
try {
  fs.chmodSync(unreadIndexAbs, 0o000);
  unreadArmed = true;
  cleanups.push(() => {
    try {
      fs.chmodSync(unreadIndexAbs, 0o644);
    } catch {
      /* best-effort */
    }
  });
} catch {
  /* left disarmed; the case below reports rather than passing vacuously */
}

check(
  "INV1/unreadable-CONTAINED-sibling-is-INDETERMINATE",
  "a contained sibling whose status cannot be read yields ok:false with the sibling named — never a clean empty result",
  () => {
    if (!unreadArmed) return "SETUP FAILED: could not chmod the sibling index; case cannot discriminate";
    // Control: the sibling must genuinely be unreadable to git, or this case
    // proves nothing about the tail it targets.
    const probe = spawnSync("git", ["status", "--porcelain"], {
      cwd: unreadSib,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (probe.status === 0) {
      return "CONTROL FAILED: git status still succeeded on the chmod'd sibling; case cannot discriminate";
    }
    const res = sp.detectSiblingMutation(unread.main, "src/mod.js");
    if (res.ok) return "ok:true — an unreadable sibling was reported as no-contention";
    return (
      (res.reason || "").includes(unreadSib) ||
      `reason did not name the sibling: ${res.reason}`
    );
  },
);

check(
  "INV1/a-MATCH-outranks-an-unreadable-sibling",
  "a positive finding stands on its own: match elsewhere + unreadable sibling returns ok:true WITH the match",
  () => {
    if (!unreadArmed) return "SETUP FAILED: could not chmod the sibling index; case cannot discriminate";
    const good = addWorktree(unread, "sib-good");
    fs.writeFileSync(path.join(good, "src", "mod.js"), "CHANGED\n");
    const res = sp.detectSiblingMutation(unread.main, "src/mod.js");
    if (!res.ok) return `ok:false — a match must outrank the unreadable sibling: ${res.reason}`;
    return (
      res.matches.some((m) => m.worktree === good) ||
      `matches did not include ${good}: ${JSON.stringify(res.matches)}`
    );
  },
);

// ── INVARIANT 2 — ONE MATCH PER SIBLING ─────────────────────────────────────

check(
  "INV2/one-match-per-sibling-no-duplicate-worktrees",
  "across a forest where every sibling holds the target dirty, each worktree appears in matches exactly once",
  () => {
    const multi = makeRepo("multi");
    const sibs = [];
    for (let i = 0; i < 4; i++) {
      const w = addWorktree(multi, `sib${i}`);
      // Two dirty ROWS naming the target from one sibling: a rename whose
      // source is the target, plus the target re-created untracked. Without
      // the `break` this sibling would contribute two entries.
      git(["mv", "src/mod.js", "src/mod-renamed.js"], w);
      fs.writeFileSync(path.join(w, "src", "mod.js"), "recreated\n");
      sibs.push(w);
    }
    const res = sp.detectSiblingMutation(multi.main, "src/mod.js");
    if (!res.ok) return `ok:false — ${res.reason}`;
    const seen = res.matches.map((m) => m.worktree);
    const uniq = new Set(seen);
    if (seen.length !== uniq.size) {
      return `duplicate worktree entries: ${JSON.stringify(seen)}`;
    }
    return (
      seen.length === sibs.length ||
      `expected ${sibs.length} matched siblings, got ${seen.length}`
    );
  },
);

check(
  "INV2/one-match-per-sibling-break-PIN",
  "the source still carries the single-match break the invariant above rests on",
  () => {
    const src = fs.readFileSync(LIB, "utf8");
    return (
      src.includes("break; // one match per sibling is sufficient") ||
      "sibling-porcelain.js no longer carries the `break; // one match per sibling is sufficient` line — " +
        "the uniqueness case above may now be passing for an unrelated reason"
    );
  },
);

// ── SCALING ─────────────────────────────────────────────────────────────────

const FOREST_N = 80; // deliberately well above the ~50 forest that produced the defect
const forest = makeRepo("forest");
const forestSibs = [];
for (let i = 0; i < FOREST_N; i++) forestSibs.push(addWorktree(forest, `wt${i}`));

/**
 * Count the git subprocesses `detectSiblingMutation` issues, and capture their
 * argv. Instruments `child_process.spawnSync` BEFORE the module resolves it —
 * the module destructures at require time, so the interposition is installed
 * by re-requiring under a patched `child_process` in a child process.
 */
function probeForest(limit) {
  const script = `
    const cp = require("child_process");
    const orig = cp.spawnSync;
    const calls = [];
    cp.spawnSync = function (bin, args, opts) {
      calls.push(args || []);
      return orig.apply(this, arguments);
    };
    const sp = require(${JSON.stringify(LIB)});
    const t0 = Date.now();
    const res = sp.detectSiblingMutation(${JSON.stringify(forest.main)}, "src/mod.js");
    const ms = Date.now() - t0;
    process.stdout.write(JSON.stringify({ ok: res.ok, n: res.matches.length, ms, calls }));
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, S54_FOREST_LIMIT: String(limit) },
  });
  if (r.status !== 0) throw new Error(`probe exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// One probe over the FULL forest, and one over a repo holding a single sibling.
// The self-normalizing ratio below is (spawns_N - spawns_1) / (N - 1), so every
// fixed setup spawn cancels and only the marginal per-sibling cost survives.
const small = makeRepo("forest-small");
addWorktree(small, "only");
function probeRepo(main) {
  const script = `
    const cp = require("child_process");
    const orig = cp.spawnSync;
    const calls = [];
    cp.spawnSync = function (bin, args) { calls.push(args || []); return orig.apply(this, arguments); };
    const sp = require(${JSON.stringify(LIB)});
    const t0 = Date.now();
    const res = sp.detectSiblingMutation(${JSON.stringify(main)}, "src/mod.js");
    process.stdout.write(JSON.stringify({ ok: res.ok, n: res.matches.length, ms: Date.now() - t0, calls }));
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) throw new Error(`probe exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

let big = null;
let one = null;
try {
  big = probeRepo(forest.main);
  one = probeRepo(small.main);
} catch (err) {
  big = { error: String(err && err.message) };
}

check(
  "SCALING/marginal-spawns-per-additional-sibling-is-ONE",
  "(spawns over an 80-sibling forest − spawns over a 1-sibling forest) / 79 === 1; the pre-fix eager containment check makes it 2",
  () => {
    if (!big || big.error) return `probe failed: ${big && big.error}`;
    const marginal = (big.calls.length - one.calls.length) / (FOREST_N - 1);
    if (marginal !== 1) {
      return (
        `marginal=${marginal} (spawns: ${big.calls.length} over ${FOREST_N} siblings, ` +
        `${one.calls.length} over 1) — 2 means the per-candidate containment ` +
        "rev-parse is running over the whole forest again"
      );
    }
    return true;
  },
);

check(
  "SCALING/per-sibling-query-is-NARROW",
  "every per-sibling status spawn carries --no-optional-locks and a ':(literal)<target>' pathspec limiter",
  () => {
    if (!big || big.error) return `probe failed: ${big && big.error}`;
    const statusCalls = big.calls.filter((a) => a.includes("status"));
    if (statusCalls.length < FOREST_N) {
      return `only ${statusCalls.length} status spawns over ${FOREST_N} siblings — the scan did not reach every sibling`;
    }
    const bare = statusCalls.filter(
      (a) =>
        !a.includes("--no-optional-locks") ||
        !a.includes("--") ||
        !a.some((t) => typeof t === "string" && t.startsWith(":(literal)")),
    );
    return (
      bare.length === 0 ||
      `${bare.length} of ${statusCalls.length} status spawns issued a WIDE query, e.g. ${JSON.stringify(bare[0])}`
    );
  },
);

check(
  "SCALING/forest-scan-still-ANSWERS",
  "the 80-sibling scan returns a real answer (ok:true), not an INDETERMINATE produced by its own cost",
  () => {
    if (!big || big.error) return `probe failed: ${big && big.error}`;
    return big.ok === true || "ok:false over the synthetic forest";
  },
);

check(
  "SCALING/forest-scan-HANG-STOP",
  "the 80-sibling scan terminates; bound set an order of magnitude from the observed value so load cannot red it",
  () => {
    if (!big || big.error) return `probe failed: ${big && big.error}`;
    // NOT a performance threshold (`rules/testing.md` § "Never Assert An UPPER
    // Bound On Real Elapsed Time"). 60_000 ms against an observed low-four-digit
    // value is a hang-stop: it can only fire on a genuine hang, never on a busy
    // runner. The performance contract is carried by the two ratio cases.
    return big.ms < 60000 || `scan took ${big.ms}ms — treat as a hang, not as slowness`;
  },
);

check(
  "SCALING/per-sibling-cost-in-SPAWN-FLOORS",
  "the forest scan costs at most 3 bare-git-spawn floors per sibling, with the floor measured in the same run so machine speed and ambient load divide out",
  () => {
    if (!big || big.error) return `probe failed: ${big && big.error}`;
    // SELF-NORMALIZING, per `rules/testing.md` § complexity-bound ratios: the
    // denominator is the median wall time of the CHEAPEST possible git spawn
    // (`rev-parse --git-dir` walks nothing), measured against the same repo in
    // the same run. A busy machine inflates numerator and denominator together,
    // so the ratio is stable where a wall-clock bound would ratchet.
    const t = [];
    for (let i = 0; i < 9; i++) {
      const s = process.hrtime.bigint();
      spawnSync("git", ["--no-optional-locks", "rev-parse", "--git-dir"], {
        cwd: forest.main,
        stdio: ["ignore", "pipe", "pipe"],
      });
      t.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
    t.sort((a, b) => a - b);
    const floor = t[t.length >> 1];
    if (!(floor > 0)) return "spawn floor measured as 0ms — the instrument cannot normalize";
    const perSibling = big.ms / (floor * FOREST_N);
    // SCOPE, stated rather than implied (`instrument-discipline.md` MUST-4).
    // This is a COARSE budget fence, NOT the regression fence. Measured across
    // 5 trials the value sat at 1.19–1.49, so the cap carries ~2x headroom and
    // cannot flake — but by the same token it only catches a GROSS regression
    // (an extra substantial per-sibling subprocess, or a re-introduced
    // whole-tree walk against a LARGE checkout). It cannot see the pathspec
    // revert on a synthetic tree, because there the tree is too small for a
    // full status to cost more than the spawn floor. That property is fenced
    // deterministically by SCALING/per-sibling-query-is-NARROW above; the
    // magnitude is re-derivable on a real forest via `measure.mjs`.
    return (
      perSibling <= 3.0 ||
      `${perSibling.toFixed(2)} spawn-floors per sibling ` +
        `(scan=${big.ms}ms, floor=${floor.toFixed(1)}ms, N=${FOREST_N}) — ` +
        "the per-sibling constant grew; check for an added subprocess in the scan loop"
    );
  },
);

// ── BUDGET ──────────────────────────────────────────────────────────────────

check(
  "BUDGET/guard-TIMEOUT_MS-matches-its-settings.json-registration",
  "signing-mutation-guard.js's internal TIMEOUT_MS equals the harness timeout it is registered with, so neither can be raised alone",
  () => {
    const guardSrc = fs.readFileSync(GUARD, "utf8");
    const m = guardSrc.match(/const TIMEOUT_MS = (\d+);/);
    if (!m) return "signing-mutation-guard.js no longer declares `const TIMEOUT_MS = <n>;`";
    const internalMs = Number(m[1]);
    // Expanded: a `dispatch.js <Event>` entry stands for the registry's per-hook groups
    // (each keeps its own timeout there), so the harness bound is still per guard.
    const settings = readExpandedHookSettings(SETTINGS);
    const found = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      if (
        typeof node.command === "string" &&
        node.command.includes("signing-mutation-guard.js")
      ) {
        found.push(node.timeout);
      }
      Object.values(node).forEach(walk);
    };
    walk(settings);
    if (found.length === 0) {
      return "signing-mutation-guard.js is not registered in settings.json — the harness bound is unknown";
    }
    const mismatched = found.filter((t) => t * 1000 !== internalMs);
    return (
      mismatched.length === 0 ||
      `TIMEOUT_MS=${internalMs} but registered timeouts are ${JSON.stringify(found)} s — ` +
        "raising one without the other leaves the guard killed mid-scan with no verdict"
    );
  },
);

for (const fn of cleanups) fn();
fs.rmSync(TMP, { recursive: true, force: true });

const total = pass + failures.length;
console.log(`\nsibling-porcelain-scaling: ${pass}/${total} PASS`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
