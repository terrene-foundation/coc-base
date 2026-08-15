/**
 * git-checkout-proof — THE shared answer to "is this directory a real git checkout?"
 * (loom#1474 E3).
 *
 * THE DEFECT THIS EXISTS FOR. Two independent surfaces each proved "real git
 * checkout" by the EXISTENCE of a `.git` entry:
 *
 *   state-resolver.js   `if (!fs.existsSync(path.join(root, ".git"))) return null;`
 *   guard-path-scope.js `if (fs.statSync(dotGit).isDirectory()) return _realpathSafe(dotGit);`
 *
 * Existence is not proof. `mkdir .git` satisfies both, and the second one is
 * WORSE than a plain miss: it does not merely admit the root, it manufactures a
 * COMMON DIR out of the empty directory and hands it to a repo-family
 * comparison, which then reports the attacker's root and the victim's repo as
 * different families. Measured end-to-end through the real integrity-guard, the
 * two counterfeit shapes differing by exactly one `mkdir` vs one `touch`:
 *
 *   .git as an empty FILE  rels=[".claude/learning/posture.json"]  exit=2  BLOCKED
 *   .git as an empty DIR   rels=[]                                 exit=0  ALLOWED
 *
 * The FILE shape blocked only by ACCIDENT — `_sessionCommonDir`'s fs shortcut
 * declined it, the git fallback also failed, and a null common dir degrades to
 * "admit every candidate", which is the fail-closed direction. So the blocked
 * row was never the predicate refusing; it was the predicate accepting and a
 * DOWNSTREAM resolution failing safe. One `mkdir` instead of one `touch` made
 * the same downstream resolution fail OPEN, and a protected write to
 * `posture.json` — the trust state gating agent autonomy — was allowed.
 *
 * WHY GIT IS THE PREDICATE, AND NOT A STRUCTURAL FILE CHECK. The obvious
 * hardening is "`.git` must be a directory containing HEAD + objects + refs".
 * That is strictly better than existence, and it is still a proxy re-implemented
 * by hand. git already answers this question authoritatively, and the answer was
 * measured against every shape the probe builds:
 *
 *   real `git init`                  ok=true   value=.git   insideRoot=true
 *   no `.git` at all                 ok=false  fatal: not a git repository
 *   `.git` empty FILE                ok=false  fatal: invalid gitfile format
 *   `.git` empty DIR                 ok=false  fatal: not a git repository
 *   `.git` DIR w/ HEAD+objects+refs  ok=true   value=.git   insideRoot=true
 *   `.git` dangling symlink          ok=false  fatal: not a git repository
 *
 * git refuses every counterfeit shape and accepts every genuine repository, so it is
 * both stronger than the structural proxy and impossible to drift from git's
 * own notion of a repository.
 *
 * WHAT THIS DOES NOT CLOSE, STATED PLAINLY. The last row above is a REAL
 * repository — indistinguishable from `git init`, because it IS one. An actor
 * who can set `$CLAUDE_TRUST_STATE_DIR` can also run `git init`, so no predicate
 * on the TARGET can refuse them; the probe encodes that deliberately as its C4
 * `lever-is-live` control, which expects a redirect to a real checkout to be
 * ACCEPTED. This module closes the COUNTERFEIT class (a directory wearing a
 * `.git` costume) and nothing wider. The override staying live for a real checkout
 * is the documented contract, not a residual this module failed to close.
 *
 * PATH CONTAINMENT (`rules/security.md` § Path Containment). `provenCheckoutRoot`
 * compares git's reported toplevel against the caller's root with BOTH sides put
 * through `fs.realpathSync` — the same resolver — and fails CLOSED when either
 * side will not resolve. That comparison is what makes a NESTED subdirectory of a
 * real repository refuse: `<repo>/sub` has no `.git`, but git's discovery walks
 * UP and answers for `<repo>`, so a bare "did git answer?" check would ACCEPT
 * `<repo>/sub/.claude/learning` as a canonical trust-state dir. Requiring
 * toplevel === root is what turns git's upward discovery from a hole into a
 * refusal. Scoped honestly: this closes the lexical/nested-root class. It does
 * NOT defeat a check-to-use TOCTOU — an actor who can swap the directory between
 * this proof and the later read/write is not fenced here, and that would need
 * enforcement at the sink. The same disclosure covers the COHERENCE check below:
 * `treeIsCoherent` re-reads `<top>/.git` through the filesystem AFTER git has
 * already answered, so it opens a second check-to-use window of the same class,
 * not a new one. Both are bounded by the same missing sink-side enforcement.
 *
 * WHY ONE MODULE AND NOT TWO COPIES — AND WHAT "SHARED" HAS TO MEAN.
 * `rules/security.md` § Enforcement-Surface Parity: a fail-closed dimension lands
 * at EVERY surface through ONE shared function. Two sites each deciding "is this
 * a checkout" by their own local proxy is precisely the shape that shipped a
 * fence one of them stepped over.
 *
 * THIS PARAGRAPH PREVIOUSLY OVER-CLAIMED, and the over-claim is worth recording
 * because it was load-bearing. At `ceda639e` it read "a new fail-closed dimension
 * lands at EVERY surface through ONE shared function, so the surfaces cannot
 * drift" — and it was FALSE at the moment it was being used to argue the change
 * was safe. What this module actually shared then was `gitTreeProof` alone: the
 * raw two-value PROBE. Every DECISION built on that probe stayed per-surface —
 * `provenCheckoutRoot` (strict realpath + `top === realRoot`) lived only here,
 * `_treeIsCoherent` (does `<top>/.git` name the repo git reported?) lived only in
 * `guard-path-scope`. Neither predicate was a superset of the other, so each
 * surface refused a shape the other admitted, and `core.worktree` walked through
 * the gap this sentence said could not exist (loom#1586).
 *
 * The correction is not that the claim is now true; it is that SHARING A PROBE IS
 * NOT SHARING A DECISION. Parity is satisfied only when the surfaces share the
 * PREDICATE THEY GATE ON. What is shared now, and what the export list at the
 * bottom of this file is for: `gitTreeProof` (the probe) AND `treeIsCoherent` +
 * its helpers `dotGitTarget` / `isAtOrUnder` (the decision). `guard-path-scope`
 * imports the coherence rule from here rather than holding its own copy, so the
 * outward-walk fence and the trust-state override predicate cannot disagree about
 * what roots a repository. A future edit that adds a rule to one surface without
 * routing it through this module re-opens exactly the gap described above.
 *
 * Style: CommonJS, pure node:fs/path + the shared git allowlist, no deps —
 * matches the sibling lib/* guards.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveGitBinary, gitEnv } = require(
  path.join(__dirname, "git-subprocess-env.js"),
);

// Matches guard-path-scope's own bound. A hung git must become an ordinary
// negative rather than wedging the hook it is called from.
const GIT_TIMEOUT_MS = 2000;

/** realpath, or the input unchanged — the lenient form the tree probe reports with. */
function _realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** true iff `child` IS `parent` or lies underneath it. Both must be realpathed. */
function isAtOrUnder(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The git-dir that a tree's OWN `.git` entry names, or null.
 *   - plain checkout   → `<top>/.git` is a DIRECTORY and IS the git dir
 *   - linked worktree  → `<top>/.git` is a FILE holding `gitdir: <path>`,
 *     pointing at `<common>/worktrees/<name>`
 *   - separate-git-dir → `<top>/.git` is a FILE holding `gitdir: <elsewhere>`
 * Anything else (absent, a symlink to nowhere, an unreadable or malformed file)
 * returns null, which the caller reads as INCOHERENT — the fail-safe direction.
 */
function dotGitTarget(top) {
  const dotGit = path.join(top, ".git");
  let st;
  try {
    st = fs.lstatSync(dotGit);
  } catch {
    return null;
  }
  try {
    if (st.isDirectory()) return _realpathSafe(dotGit);
    if (!st.isFile()) return null;
    const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
    if (!m) return null;
    return _realpathSafe(
      path.isAbsolute(m[1]) ? m[1] : path.resolve(top, m[1]),
    );
  } catch {
    return null;
  }
}

/**
 * COHERENCE — does the reported toplevel actually ROOT the reported repository?
 *
 * A pair is coherent when `<top>/.git` names the same repository `common` does:
 * equal to it (plain checkout, or `--separate-git-dir` whose `.git` FILE points
 * AT the common dir), or inside it (a linked worktree's
 * `<common>/worktrees/<name>`).
 *
 * WHY THIS IS LOAD-BEARING AND NOT BELT-AND-BRACES (loom#1586). `core.worktree`
 * is a repo-LOCAL config key — one line in an ancestor's `.git/config`, writable
 * by anyone who can `git init` a directory, and NOT strippable by `gitEnv()`
 * (which removes SYSTEM/GLOBAL config and the whole `GIT_*` family, but
 * repo-local config is read BY DEFINITION once git discovers the repository).
 * With `core.worktree = <D>` set on an ancestor, git reports `--show-toplevel`
 * as `<D>` even though `<D>` holds NO `.git` entry whatsoever. Measured:
 *
 *   fixture                 has .git   existsSync-predicate   git --show-toplevel
 *   core.worktree root D    false      refuse                 D   ← git says "root"
 *
 * So "git named this directory as a toplevel" is NOT proof it is a checkout
 * root, and a predicate resting on that alone is WEAKER on this axis than the
 * crude `fs.existsSync(<root>/.git)` it replaced. Coherence restores the floor:
 * `dotGitTarget(D)` is null (no `.git` entry to name anything), so the pair is
 * incoherent and refused. Same invariant `guard-path-scope`'s outward walk uses
 * to refuse to skip an ancestor — one rule, now shared by both surfaces rather
 * than held on only one of them.
 */
function treeIsCoherent(tree) {
  if (!tree || !tree.top || !tree.common) return false;
  const target = dotGitTarget(tree.top);
  if (!target) return false;
  return target === tree.common || isAtOrUnder(target, tree.common);
}

/**
 * One git invocation, two answers: the tree's toplevel and its shared
 * git-common-dir (the repo-family identity). Returns null when `dir` is not
 * inside a git repository, or git is unavailable/errors/times out.
 *
 * `--show-toplevel --git-common-dir` prints toplevel first, common-dir second;
 * for a linked worktree the common dir is absolute (`<main>/.git`), for a plain
 * checkout it is the relative `.git`, resolved here against the query dir.
 *
 * loom#1462 F1: git is invoked by ABSOLUTE path (no PATH lookup) with an arg
 * ARRAY (no shell) and an env built from constants by `gitEnv()`, so the
 * `GIT_DIR` / `GIT_COMMON_DIR` family cannot steer which repository answers.
 * Neither `-C` nor `cwd:` pins that on its own — both only choose a DIRECTORY.
 *
 * NULL IS A REAL ANSWER, NOT AN ERROR TO SWALLOW. It MUST NOT throw into a guard
 * (`zero-tolerance.md` Rule 3), and every caller ranks it TIGHTEST: git that
 * cannot answer is INDETERMINATE, never a clean "yes, real checkout".
 */
function gitTreeProof(dir) {
  if (typeof dir !== "string" || dir === "") return null;
  const bin = resolveGitBinary();
  if (!bin) return null;
  let r;
  try {
    r = spawnSync(bin, ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      env: gitEnv(), // NOTHING inherited — GIT_DIR & family cannot reach this
    });
  } catch {
    return null;
  }
  if (!r || r.status !== 0) return null;
  const lines = String(r.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (lines.length < 2) return null;
  const common = path.isAbsolute(lines[1])
    ? lines[1]
    : path.resolve(dir, lines[1]);
  return { top: _realpathSafe(lines[0]), common: _realpathSafe(common) };
}

/**
 * `dir` is the ROOT of a real git checkout — git says so, and says the root is
 * `dir` itself rather than some ancestor.
 *
 * @returns {{realRoot: string, top: string, common: string} | null}
 *   null on ANY doubt: unresolvable path, git could not answer, or git answered
 *   about a DIFFERENT directory (i.e. `dir` is a nested subdirectory, not a
 *   checkout root). Callers treat null as REFUSE.
 *
 * Accepts a linked worktree as a root — its `--show-toplevel` IS the worktree
 * directory (its `.git` is a FILE and its common dir lives elsewhere, which is
 * why a "common dir must sit inside root" rule would wrongly refuse it). loom
 * operates out of linked worktrees, so refusing them would be a live regression,
 * not extra safety.
 */
function provenCheckoutRoot(dir) {
  if (typeof dir !== "string" || dir === "") return null;
  let realRoot;
  try {
    // FAIL CLOSED on an unresolvable root — `rules/security.md` § Path
    // Containment. The strict form, deliberately NOT `_realpathSafe`: a root
    // that will not resolve must refuse, never fall back to its lexical spelling.
    realRoot = fs.realpathSync(dir);
  } catch {
    return null;
  }
  const tree = gitTreeProof(realRoot);
  if (!tree || !tree.top) return null;
  // BOTH sides through the SAME resolver before the comparison. `tree.top` is
  // already realpath'd by gitTreeProof; realRoot is realpath'd above.
  if (tree.top !== realRoot) return null;
  // COHERENCE — git NAMING this directory a toplevel is not proof it roots the
  // repository git named. `core.worktree` in an ancestor's repo-LOCAL config
  // makes git report a directory holding NO `.git` entry as the toplevel
  // (loom#1586). Without this line the predicate is WEAKER than the
  // `fs.existsSync(<root>/.git)` check it replaced. See § treeIsCoherent.
  if (!treeIsCoherent(tree)) return null;
  return { realRoot, top: tree.top, common: tree.common };
}

module.exports = {
  gitTreeProof,
  provenCheckoutRoot,
  // The COHERENCE rule, shared so `guard-path-scope`'s outward walk and this
  // predicate cannot drift into disagreeing about what roots a repository
  // (`rules/security.md` § Enforcement-Surface Parity).
  dotGitTarget,
  treeIsCoherent,
  isAtOrUnder,
};
