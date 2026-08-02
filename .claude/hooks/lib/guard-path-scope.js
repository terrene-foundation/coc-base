/**
 * guard-path-scope — worktree-aware repo-relative resolution for the
 * Edit/Write-lane integrity fences.
 *
 * THE DEFECT THIS CLOSES (loom#1414):
 *   integrity-guard.js and journal-write-guard.js both decided "is this
 *   path watched?" with
 *
 *       const r = path.relative(repoDir, absPath);
 *       if (r.startsWith("..")) return { watched: false };
 *
 *   where `repoDir` is `resolveMainCheckout(sessionCwd)` — the MAIN
 *   checkout. Inside a linked git worktree the target lives at
 *   `<parent>/.<slug>-wt/<name>/.claude/learning/posture.json` while
 *   repoDir is `<parent>/<repo>`, so path.relative yields a `../`-prefixed
 *   string and EVERY protected path reported unwatched. Measured on
 *   origin/main @ edd3facd: 10/10 canonical controls passed unfenced from
 *   inside a worktree with no CLAUDE_TRUST_STATE_DIR pin; all 10 fenced
 *   with the pin (which forces repoDir back to the worktree root). Since
 *   this repo does nearly all parallel work in sibling worktrees, the
 *   fence was inert for that entire class of session.
 *
 *   Note the realpath normalisation is NOT the problem — it correctly
 *   handles the macOS /var vs /private/var symlink case. The two paths
 *   are genuinely in different trees.
 *
 * THE RESOLUTION MODEL:
 *   A path is evaluated against every root that could legitimately claim
 *   it, and the caller's own matcher decides. Candidate roots, in order:
 *
 *     1. `repoDir` — the session/main root. This is exactly today's
 *        behaviour, kept first so nothing that fences today stops fencing.
 *     2. The target's OWN git toplevel — the worktree (or nested
 *        worktree) the file actually lives in. This is the fix.
 *     3. Every ENCLOSING git toplevel of the same repo family, walking OUT
 *        from candidate 2 toward the filesystem root (loom#1430).
 *
 *   Candidates 2 and 3 are admitted ONLY when that tree belongs to the
 *   SAME REPO FAMILY as the session, established by `git rev-parse
 *   --git-common-dir` identity (a linked worktree's common dir IS the
 *   main checkout's `.git` — an identity, not a heuristic; the same one
 *   state-resolver.js relies on).
 *
 * WHY THE OUTWARD WALK (loom#1430):
 *   `--show-toplevel` resolves the INNERMOST tree, so a nested `git init` at
 *   an intermediate directory re-roots the rel. `git init journal/` inside a
 *   worktree rewrites the watched `journal/0001.md` to the unwatched
 *   `0001.md` and — because a fresh `git init` is a different repo family —
 *   suppresses candidate 2 outright. Measured before the fix, session root at
 *   the main checkout so candidate 1 is `../`-rejected:
 *
 *     BEFORE `git init journal/`  rels=["journal/0999-forged.md"]  -> FENCED
 *     AFTER  `git init journal/`  rels=[]                          -> PASSED
 *
 *   The enclosing same-family tree is the root that legitimately owns the
 *   path, so it is probed too. `--git-common-dir` identity is unchanged as
 *   the jurisdiction primitive; it is simply no longer applied to the
 *   innermost tree alone.
 *
 * FAIL-CLOSED — AND ITS EXACT BOUNDARY:
 *   This fence is disabled by SILENCE, so "zero candidates" is the failure
 *   mode both #1414 and #1430 wear. The resolver therefore falls back to
 *   emitting every path SUFFIX — so a protected tail still reaches the
 *   caller's matcher — in BOTH of these cases:
 *
 *     - no containing tree resolves at all (git absent/errored, the path is
 *       in no repository); and
 *     - a containing tree resolves and IS in the session's repo family, but
 *       not one usable rel came out of it (every rel `..`-escaped or came
 *       back absolute — e.g. a `core.worktree` redirect whose toplevel does
 *       not contain the target).
 *
 *   The claim this header can support is NARROWER than "an unresolvable root
 *   must never silently disable the fence": what actually holds is that an
 *   IN-JURISDICTION path never resolves to zero candidates. Out of
 *   jurisdiction is a deliberate passthrough, NOT a fail-closed case — see
 *   NO OVER-BLOCK below.
 *
 * NO OVER-BLOCK (two independent fences):
 *   - The marker precheck below: a path containing neither `.claude/` nor
 *     `journal/` as a segment can never match any watched pattern under any
 *     root, so it short-circuits to zero candidates. This also keeps the
 *     hot path free of process spawns — an ordinary source-file edit costs
 *     pure string work, no git.
 *   - Jurisdiction: a target inside a DIFFERENT repo family yields no
 *     candidate 2, so cross-repo writes stay passthrough exactly as today.
 *     Those are governed by repo-scope-discipline.md + /cross-repo-authorize,
 *     not by this repo's codify lease; fencing them here would break
 *     loom's own artifact distribution (`/sync-to-use` writes `.claude/**`
 *     into target repos by design).
 *
 * The marker precheck is deliberately CASE-INSENSITIVE: on a
 * case-insensitive filesystem (APFS default) `.CLAUDE/` and `.claude/` are
 * the same directory, and a case-sensitive precheck would reintroduce the
 * one-character bypass loom#1399 closed at the matcher layer. Wider here is
 * safe — the precheck only ever admits a path to the matcher.
 *
 * Style: CommonJS, pure node builtins, to match sibling lib/* guard modules.
 * Never throws into a guard (zero-tolerance.md Rule 3): every fs/spawn
 * failure resolves to the fail-closed disposition.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
// THE shared git-subprocess allowlist (loom#1462 F1) — see ./git-subprocess-env.js.
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env.js");

// A watched rel begins with `.claude/`, `journal/`, `workspaces/<name>/journal/`
// — or, since loom#1470, `.git`. So a path containing no marker segment cannot
// match under ANY root. Segment-anchored to avoid matching a file merely NAMED
// "journal.md".
//
// loom#1470 — THE MARKER PRECHECK IS THE LAYER THAT MUST LEARN `.git` TOO. The
// precheck runs BEFORE any root resolution and short-circuits to ZERO
// candidates, so a registry row alone would have been INERT on this lane: the
// matcher never sees a path the precheck rejected. Measured on the fixture
// before this line changed, with the roster as the passing control:
//
//   .git                   rels=[]  integrityWatched=false   <- the defeat
//   .git/config            rels=[]  integrityWatched=false
//   .claude/operators.roster.json  rels=[".claude/…"]  true  <- CONTROL
const GIT_ADMIN_MARKER = "/.git";
const MARKERS = ["/.claude/", "/journal/", GIT_ADMIN_MARKER + "/"];

const GIT_TIMEOUT_MS = 2000;

// Bound on the outward walk of enclosing git toplevels (loom#1430). Each step
// costs one git subprocess, so this caps the worst case rather than letting a
// deeply-nested layout walk to `/`. Real nesting is 0-2 levels (a repo inside a
// worktree inside a checkout); 8 is slack, not a target.
const MAX_ENCLOSING_PROBES = 8;

function _toPosix(p) {
  return p.replace(/\\/g, "/");
}

function _realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Realpath-normalize an absolute path whose leaf may not exist yet (the
 * file is about to be created). Walks up to the deepest EXISTING ancestor,
 * realpaths that, and re-appends the remainder. Preserved verbatim in
 * behaviour from the two hooks this module factors out of.
 */
function normalizeAbs(absPath) {
  try {
    let ancestor = absPath;
    while (ancestor && !fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (ancestor && fs.existsSync(ancestor)) {
      return fs.realpathSync(ancestor) + absPath.slice(ancestor.length);
    }
  } catch {
    // best-effort — fall back to the raw path
  }
  return absPath;
}

/** Deepest existing DIRECTORY at or above absPath, or null. */
function _deepestExistingDir(absPath) {
  let p = absPath;
  for (let i = 0; i < 64; i++) {
    try {
      return fs.statSync(p).isDirectory() ? p : path.dirname(p);
    } catch {
      const parent = path.dirname(p);
      if (parent === p) return null;
      p = parent;
    }
  }
  return null;
}

/**
 * One git invocation, two answers: the tree's toplevel and its shared
 * git-common-dir (the repo-family identity). Returns null when `dir` is
 * not inside a git repository or git is unavailable/errors.
 *
 * `--show-toplevel --git-common-dir` prints toplevel first, common-dir
 * second; for a linked worktree the common dir is absolute (<main>/.git),
 * for a plain checkout it is the relative `.git`, resolved here against
 * the query dir.
 */
function _gitTreeInfo(dir) {
  let r;
  // loom#1462 F1, same class: this subprocess used to resolve `git` through the
  // ambient PATH and inherit the ambient environment, and `cwd:` — like `-C` — only
  // chooses a DIRECTORY, it does not pin which REPOSITORY git resolves. So GIT_DIR
  // steered the repo-family identity this guard scopes protected paths against.
  // Measured on the real command, not derived:
  //
  //   $ (cd victim && git rev-parse --show-toplevel --git-common-dir)
  //     <...>/victim          .git
  //   $ (cd victim && GIT_DIR=evil/.git GIT_WORK_TREE=evil git rev-parse ...)
  //     <...>/evil            <...>/evil/.git        ← the ATTACKER's tree
  //
  // Now routed through the same shared allowlist the coordination-mode attestation
  // uses (rules/security.md § Enforcement-Surface Parity — one shared function, both
  // surfaces, so they cannot drift). An unresolvable git returns null exactly as any
  // other git failure does, which every caller here already treats as fail-closed.
  const bin = resolveGitBinary();
  if (!bin) return null;
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

/** true iff `child` IS `parent` or lies underneath it. Both must be realpathed. */
function _isAtOrUnder(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The git-dir that a tree's OWN `.git` entry names, or null.
 *   - plain checkout  → `<top>/.git` is a DIRECTORY and IS the git dir
 *   - linked worktree → `<top>/.git` is a FILE holding `gitdir: <path>`,
 *     pointing at `<common>/worktrees/<name>`
 * Anything else (absent, a symlink to nowhere, an unreadable or malformed
 * file) returns null, which the caller reads as INCOHERENT — the fail-safe
 * direction, since incoherence only ever costs extra probing.
 */
function _dotGitTarget(top) {
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
 * `_gitTreeInfo` answers one query with two values, and `core.worktree` is a
 * repo-LOCAL config key that changes only the FIRST of them. The result is a
 * hybrid pair: `top` from one tree, `common` from another. That pair is what
 * hijacked the #1430 outward walk — see § THE WALK CANNOT SKIP AN ANCESTOR.
 *
 * A pair is coherent when `<top>/.git` names the same repository `common`
 * does: equal to it (plain checkout), or inside it (a linked worktree's
 * `<common>/worktrees/<name>`). Measured on the three fixtures that differ by
 * exactly one `git config`:
 *
 *   plain worktree           top=W        <top>/.git -> R/.git/worktrees/wt   COHERENT
 *   nested `git init`        top=W/journal <top>/.git -> W/journal/.git        COHERENT
 *   nested + core.worktree=W top=W        <top>/.git -> R/.git/worktrees/wt   INCOHERENT
 *                                          common     =  W/journal/.git
 *
 * Pure `fs` work — no subprocess — so the check is free relative to the probe
 * that produced the pair.
 */
function _treeIsCoherent(tree) {
  if (!tree || !tree.top || !tree.common) return false;
  const target = _dotGitTarget(tree.top);
  if (!target) return false;
  return target === tree.common || _isAtOrUnder(target, tree.common);
}

function _hasMarker(posixPath, markers) {
  const hay = posixPath.toLowerCase();
  if (markers.some((m) => hay.includes(m))) return true;
  // loom#1470 — the `.git` of a LINKED WORKTREE is a plain FILE, i.e. a LEAF,
  // so the `/.git/` directory-prefix substring cannot see it. That leaf IS
  // defeat 1 (`echo "gitdir: <evil>" > .git`), and this repo operates out of
  // linked worktrees, so it is the normal operating mode rather than an exotic
  // one. Admitted ONLY when the caller's marker set actually carries the `.git`
  // subtree marker, so an `opts.markers` override keeps its own semantics
  // instead of silently inheriting a marker it never declared.
  //
  // `endsWith` is exact, so `.gitignore` / `.github` / `.gitattributes` /
  // `.gitmodules` are NOT admitted — the same boundary property the registry
  // row's `\b` trailer relies on, held here by string equality rather than by
  // a regex the precheck deliberately avoids.
  return (
    markers.includes(GIT_ADMIN_MARKER + "/") && hay.endsWith(GIT_ADMIN_MARKER)
  );
}

/** Every path suffix, longest first: the fail-closed candidate set. */
function _suffixCandidates(posixAbs) {
  const segs = posixAbs.split("/").filter((s) => s.length > 0);
  const out = [];
  for (let i = 0; i < segs.length; i++) out.push(segs.slice(i).join("/"));
  return out;
}

/**
 * The session root's shared git dir, resolved WITHOUT a subprocess in the
 * common case: `resolveMainCheckout` only returns a root it has already
 * validated as containing `.git`, and for a plain checkout that IS the
 * common dir. Falls back to the git query for a repoDir that is itself a
 * worktree (`.git` is a FILE there) or has no `.git` at all.
 */
function _sessionCommonDir(normalizedRepo) {
  if (!normalizedRepo) return null;
  const dotGit = path.join(normalizedRepo, ".git");
  try {
    if (fs.statSync(dotGit).isDirectory()) return _realpathSafe(dotGit);
  } catch {
    // not a plain checkout — fall through to the git query
  }
  const info = _gitTreeInfo(normalizedRepo);
  return info ? info.common : null;
}

/**
 * Ordered candidate repo-relative forms of `absPath`, yielded LAZILY.
 *
 * Laziness is load-bearing for cost, not just style: candidate 1 is pure
 * string work, and it is the one that hits for every session running in the
 * main checkout. Only a MISS on candidate 1 pays for the git subprocess that
 * resolves the target's own worktree root (measured ~35-70ms). So:
 *   - unprotected path        → 0 spawns (marker precheck short-circuits)
 *   - main-checkout session   → 0 spawns (candidate 1 hits)
 *   - worktree session        → 1-2 spawns, and the fence actually works
 *
 * `state` is an out-parameter the caller may inspect after iterating.
 */
function* _candidates(absPath, repoDir, opts, state) {
  const markers = (opts && opts.markers) || MARKERS;
  state.rootResolved = true;
  state.sameFamily = false;
  state.containingRoot = null;
  state.gitProbes = 0;
  // loom#1446 defect 2 — true IFF the enclosing-tree walk fell out at
  // MAX_ENCLOSING_PROBES rather than terminating on its own. Distinguishes
  // "no enclosing family tree" (a verdict) from "ran out of budget" (not one).
  state.probesExhausted = false;

  if (typeof absPath !== "string" || absPath.length === 0) return;

  // An already-relative path is NORMALIZED, then used. The prior form yielded it
  // verbatim ("used as-is — unchanged from both hooks"), which made the fence
  // bypassable by any redundant spelling, because the caller's matcher does an
  // EXACT-string membership test. Measured on the composed tree with the canonical
  // relative form as a passing control (2/2 controls fenced):
  //
  //   FENCED  .claude/learning/posture.json                  <- control
  //   PASSED  ./.claude/learning/posture.json                 <- one "./" prefix
  //   PASSED  .claude/learning/./posture.json
  //   PASSED  .claude/learning//posture.json
  //   PASSED  .claude/learning/../learning/posture.json
  //
  // The absolute branch below never had this hole: normalizeAbs realpaths the
  // deepest existing ancestor, which collapses `//`, `/./` and `/../`. Only the
  // relative branch skipped normalization — and integrity-guard.js:132 takes
  // `input.file_path` RAW (no path.resolve), so whatever the payload spells is what
  // this branch saw. This is the loom#1409 redundant-path-form class, which was
  // scoped to the Bash lane, reaching the Edit/Write lane through the one input
  // shape that bypasses normalizeAbs.
  //
  // path.posix.normalize collapses the redundant forms without resolving symlinks
  // (there is no root to resolve against here) and leaves a genuinely-escaping
  // `../` prefix intact.
  //
  // AN ESCAPING REL IS RESOLVED, NOT YIELDED RAW (loom#1446 defect 1). The prior
  // form yielded a `../`-prefixed rel verbatim and delegated the rejection to the
  // MATCHERS — `matchIntegrityWatchedRel` tests DIRECT membership by exact string
  // and its subtrees with `^`-anchored patterns, so a `../` prefix cannot match.
  // Three things were wrong with leaning on that:
  //
  //   1. It made the property belong to every CONSUMER rather than to this
  //      module. The Bash-lane regexes are unanchored by design, so any future
  //      unanchored consumer of these candidates silently inherits an
  //      out-of-tree rel — a fence that holds only by the accident of who is
  //      reading it. Measured pre-fix, driving the real integrity-guard:
  //
  //        ".claude/learning/posture.json"            -> exit=2  <- control
  //        "../../journal/0001.md"  (from a subdir)   -> exit=0  BYPASS
  //        "../journal/0001.md"                       -> exit=0  BYPASS
  //
  //   2. `state.sameFamily = true` was set UNCONDITIONALLY, so the fail-closed
  //      suffix fall-through #1430 added was unreachable from this branch: an
  //      escaping rel produced zero usable candidates AND claimed jurisdiction,
  //      which is exactly the silent-unwatched shape #1414/#1430 exist to remove.
  //
  //   3. A rel has NO MEANING without a base. Treating it as repo-relative by
  //      fiat is the actual root cause: from a subdirectory a `../`-prefixed path
  //      names a file INSIDE the repo while spelling as escaping.
  //
  // So: a NON-escaping rel is repo-relative by construction and is yielded as
  // before (unchanged, and the #1414 redundant-form collapse still applies). An
  // ESCAPING rel is RESOLVED against the session root and re-entered through the
  // ABSOLUTE branch, which is the well-tested path that decides jurisdiction
  // properly — realpath, marker precheck, git-family probe, fail-closed suffixes.
  //
  // WHY RE-ENTRY RATHER THAN FENCING HERE: fencing an escaping rel outright would
  // WIDEN jurisdiction, which #1446 explicitly forbids — `../kailash-py/journal/x`
  // must stay a passthrough exactly as its absolute spelling does, because
  // cross-repo writes are governed by repo-scope-discipline.md, not by this fence
  // (`/sync-to-use` writes `.claude/**` into target repos by design). Resolving
  // first makes the two spellings of the same file reach the SAME verdict, which
  // is the invariant that was actually broken. Recursion is depth-1: the resolved
  // path is absolute, so the re-entered call cannot reach this branch again.
  //
  // Pinned by `protected-path-dimensions-1409-1429-1441.test.js` § "an ESCAPING
  // ../ rel" and by `guard-path-scope-1446.test.js`; § SEP below.
  if (!path.isAbsolute(absPath)) {
    const rel = path.posix.normalize(_toPosix(absPath));
    // normalize() renders a bare "." for an empty-ish input and can leave a
    // "./" prefix on some inputs; strip it so the rel matches canonical form.
    const cleaned = rel === "." ? "" : rel.replace(/^\.\//, "");

    if (!cleaned.startsWith("..")) {
      state.sameFamily = true;
      if (cleaned.length > 0) yield cleaned;
      return;
    }

    const base =
      typeof repoDir === "string" && repoDir.length > 0
        ? _realpathSafe(repoDir)
        : null;
    if (base) {
      yield* _candidates(path.resolve(base, cleaned), repoDir, opts, state);
      return;
    }

    // NO BASE to resolve against — jurisdiction is INDETERMINATE, not negative.
    // Fail CLOSED (emit suffixes so a protected tail still reaches the matcher)
    // rather than yielding an unmatchable rel and reporting "not watched". The
    // marker precheck keeps this free for ordinary source paths.
    if (!_hasMarker(cleaned, markers)) return;
    state.sameFamily = true;
    for (const s of _suffixCandidates(cleaned)) {
      if (s && !s.startsWith("..")) yield s;
    }
    return;
  }

  const normalizedAbs = normalizeAbs(absPath);
  const posixAbs = _toPosix(normalizedAbs);

  // Cheap precheck: no marker segment → no root can make this watched.
  // Keeps every ordinary source-file edit spawn-free, and is the
  // no-over-block fence for the fail-closed branch below.
  if (!_hasMarker(posixAbs, markers)) return;

  const seen = new Set();
  const usable = (r) => {
    if (!r || r.startsWith("..") || path.isAbsolute(r)) return null;
    const p = _toPosix(r);
    if (seen.has(p)) return null;
    seen.add(p);
    return p;
  };

  const normalizedRepo =
    typeof repoDir === "string" && repoDir.length > 0
      ? _realpathSafe(repoDir)
      : null;

  // Candidate 1 — the session/main root (today's behaviour, kept first).
  if (normalizedRepo) {
    const c1 = usable(path.relative(normalizedRepo, normalizedAbs));
    if (c1) yield c1;
  }

  // Candidate 2 — the tree the target actually lives in (the fix).
  const probeDir = _deepestExistingDir(normalizedAbs);
  let targetTree = null;
  if (probeDir) {
    state.gitProbes++;
    targetTree = _gitTreeInfo(probeDir);
  }
  // `rootResolved` reports the INNERMOST tree only — it is the "is this path
  // in any git repository at all" signal, not a jurisdiction verdict.
  state.rootResolved = Boolean(targetTree);
  if (targetTree) {
    state.containingRoot = targetTree.top;
    state.gitProbes++;
    const sessionCommon = _sessionCommonDir(normalizedRepo);
    // Same repo family ⇔ same shared git dir. When the session root is not
    // itself resolvable as a repo we cannot establish jurisdiction, so we
    // admit the candidate (fail-closed: fence rather than silently skip).
    const inFamily = (tree) => !sessionCommon || sessionCommon === tree.common;

    state.sameFamily = inFamily(targetTree);
    if (state.sameFamily) {
      const c2 = usable(path.relative(targetTree.top, normalizedAbs));
      if (c2) yield c2;
    }

    // Candidates 3..N — walk OUT one enclosing tree at a time (loom#1430).
    // `--show-toplevel` answers with the INNERMOST tree, so a nested `git
    // init` at an intermediate directory re-roots the rel out of the watched
    // pattern (`journal/0001.md` -> `0001.md`) or, being a different family,
    // suppresses candidate 2 entirely. Either way the ENCLOSING same-family
    // tree is the root that legitimately owns the path.
    //
    // Lazy by construction: each probe happens only after the previous
    // candidate was consumed and did not match, so the paths that HIT pay
    // nothing for this. Measured per call, pre-#1430 -> post, git subprocesses
    // and ms (20-call mean):
    //
    //   main-checkout HIT            0 -> 0 probes    0.03 -> 0.06 ms
    //   unprotected (marker precheck) 0 -> 0 probes    0.01 -> 0.01 ms
    //   worktree HIT                 2 -> 2 probes   30.43 -> 30.92 ms
    //   marker-bearing MISS          2 -> 3 probes   31.68 -> 54.08 ms
    //   foreign repo (jurisdiction)  2 -> 3 probes   32.43 -> 76.47 ms
    //
    // So the cost lands on the two MISS paths, +1 probe each — one git call is
    // the minimum that can answer "is there an enclosing tree?", since git does
    // the ancestor walk internally. The foreign-repo row is the `/sync-to-use`
    // path; it stays a passthrough, it just costs one more probe to prove it.
    // A stat-only prescan for an ancestor `.git` would avoid that probe, but it
    // can miss a toplevel under `core.worktree`/`--separate-git-dir` — trading
    // a fence gap for latency is the wrong side of this trade.
    // EXHAUSTION IS INDETERMINATE, NOT A VERDICT (loom#1446 defect 2). The cap
    // bounds cost; it must never masquerade as "walk completed, no enclosing
    // family tree". Pre-fix those two exits were indistinguishable, so at nesting
    // depth >= 9 the loop ran out of budget, left sameFamily=false, and :418
    // returned a PASSTHROUGH — the zero-candidate silent-unwatched failure #1414
    // and #1430 exist to remove, reintroduced behind a bound. Measured pre-fix:
    //
    //   depth 8  -> exit=2 rels=["journal/n1/.../d8.md"] sameFamily=true   FENCE-HELD
    //   depth 9  -> exit=0 rels=[]                       sameFamily=false  BYPASS
    //   depth 12 -> exit=0 rels=[]                       sameFamily=false  BYPASS
    //
    // Attacker cost was `mkdir -p` plus nine `git init`s. So the loop now
    // DISTINGUISHES its two exits: a `break` means the walk genuinely COMPLETED
    // (filesystem root reached, or no enclosing tree) and a negative jurisdiction
    // verdict is sound; falling out at the cap means we never established
    // jurisdiction and the fail-closed suffix path owns the decision.
    //
    // WHY KEEP A FIXED CAP AT ALL. Removing it trades a fence gap for an
    // unbounded git-subprocess walk on every marker-bearing Edit — each level is
    // ~30ms, and the walk length is attacker-chosen, so an uncapped loop is a
    // latency amplifier reachable from the same `mkdir -p`. A stat-only ancestor
    // prescan is rejected above (it misses `core.worktree` / `--separate-git-dir`
    // toplevels). Bounding the COST while making bound-exhaustion fail CLOSED
    // gives up neither property: the cap stays 8 because real nesting is 0-2, and
    // the pathological depths that exceed it are now fenced rather than passed.
    // THE WALK CANNOT SKIP AN ANCESTOR (the `core.worktree` walk-hijack).
    //
    // The walk treats its cursor as ALREADY COVERED and probes the cursor's
    // PARENT. Both the seed and the per-step advance used to be a git-REPORTED
    // toplevel, and `core.worktree` is a repo-LOCAL config key — one `.git/config`
    // line, reachable by any actor who can `git init` a directory, and NOT
    // strippable by `gitEnv()` (which removes SYSTEM/GLOBAL config and the whole
    // `GIT_*` family, #1462 F1, but `.git/config` is read by definition once the
    // repository is discovered). So the attacker chose where the walk started.
    //
    // With a nested `git init` at `<W>/journal` plus `core.worktree = <W>`,
    // `_gitTreeInfo(<W>/journal)` reports top=<W> (the redirect) with
    // common=<W>/journal/.git (the nested repo). `common` is foreign, so
    // candidate 2 is suppressed and <W> is never evaluated — yet the walk seeded
    // at <W> and probed `dirname(<W>)`, stepping straight OVER the same-family
    // root that legitimately owns the path. Finding no repo above, it terminated
    // CLEANLY (probesExhausted=false), so :528 took the deliberate
    // out-of-jurisdiction PASSTHROUGH instead of the fail-closed suffix branch.
    // Measured, the two fixtures differing by exactly one `git config`:
    //
    //   nesting only              -> FENCE-HELD  rels=["journal/0001.md"]
    //   nesting + core.worktree   -> PASSTHROUGH rels=[]
    //
    // `rels=[]` with probesExhausted=false is verbatim the silent-unwatched shape
    // #1414, #1430 and #1446 each closed, reached by a route none of them model.
    //
    // THE FIX IS THE COVERAGE INVARIANT, NOT THIS INPUT. Skipping is sound only
    // when the skipped span is provably inside a tree that WAS evaluated. Git
    // justifies that only for a COHERENT report (`_treeIsCoherent`: the reported
    // top actually roots the reported repo) whose top ENCLOSES the directory just
    // probed — then git's own upward `.git` discovery proves no other repository
    // sits in between. Otherwise the cursor advances by exactly ONE directory.
    // So the walk is anchored to the filesystem ancestry of the TARGET, which no
    // config value can move, and every ancestor is either probed or provably
    // covered. `core.worktree` is one spelling; `--separate-git-dir` and any
    // future toplevel-relocating mechanism are closed by the same invariant.
    //
    // Cost is unchanged on every ordinary layout: a coherent report accelerates
    // exactly as before (verified against the plain-worktree and nested-init
    // controls, same probe counts). Only an INCOHERENT report — which no honest
    // checkout produces — pays per-directory steps, and paying budget there is
    // the correct side of the trade: exhausting the budget fails CLOSED (#1446
    // defect 2), while skipping fails OPEN.
    let cursor = _realpathSafe(
      _treeIsCoherent(targetTree) ? targetTree.top : probeDir,
    );
    let walkComplete = false;
    for (let i = 0; i < MAX_ENCLOSING_PROBES; i++) {
      const parent = path.dirname(cursor);
      if (!parent || parent === cursor) {
        walkComplete = true; // filesystem root — nothing further to probe
        break;
      }
      state.gitProbes++;
      const outer = _gitTreeInfo(parent);
      if (!outer) {
        walkComplete = true; // no enclosing tree
        break;
      }
      // ADVANCE. Accelerate to the reported toplevel ONLY when that report is
      // coherent AND encloses the directory just probed; otherwise step one
      // directory. Either way the cursor moves strictly up, so the walk always
      // makes progress and always terminates.
      const next =
        _treeIsCoherent(outer) && _isAtOrUnder(parent, outer.top)
          ? outer.top
          : parent;
      if (next === cursor || !_isAtOrUnder(cursor, next)) {
        walkComplete = true; // no progress — treat as walked out, never loop
        break;
      }
      cursor = next;
      // A FOREIGN enclosing tree is not itself a candidate, but it does not
      // end the walk: a foreign repo can sit nested inside one of ours.
      if (!inFamily(outer)) continue;
      if (!state.sameFamily) {
        state.sameFamily = true;
        state.containingRoot = outer.top;
      }
      const cN = usable(path.relative(outer.top, normalizedAbs));
      if (cN) yield cN;
    }
    state.probesExhausted = !walkComplete;

    // OUT OF JURISDICTION — resolvable, but no tree containing this path
    // belongs to the session's repo family. Deliberate passthrough, NOT a
    // fail-closed case: cross-repo writes are governed by
    // repo-scope-discipline.md + /cross-repo-authorize, not by this repo's
    // codify lease, and fencing them here would break loom's own artifact
    // distribution (`/sync-to-use` writes `.claude/**` into target repos by
    // design). Unchanged from before #1430 — EXCEPT that this passthrough now
    // requires the walk to have genuinely COMPLETED (loom#1446 defect 2). A walk
    // that fell out at MAX_ENCLOSING_PROBES never reached a verdict, so it drops
    // to the fail-closed suffixes below instead of passing. The jurisdiction
    // invariant is untouched: a FOREIGN repo terminates the walk by `break`
    // (filesystem root / no enclosing tree), so `walkComplete` is true and the
    // `/sync-to-use` passthrough behaves exactly as before — pinned by the
    // `1430-jurisdiction-preserved` controls.
    if (!state.sameFamily && !state.probesExhausted) return;

    // IN JURISDICTION and at least one usable rel came out — a non-match here
    // is a genuine "not watched", so stop.
    if (seen.size > 0) return;

    // IN JURISDICTION but NOT ONE usable rel — every rel `..`-escaped or came
    // back absolute (e.g. a `core.worktree` redirect whose toplevel does not
    // contain the target). Zero candidates is exactly the silent-unwatched
    // failure #1414/#1430 are, so fall through to the fail-closed suffixes
    // below rather than returning nothing.
  }

  // FAIL-CLOSED — either no containing tree resolved at all, or one did, in
  // this repo family, and produced no usable rel. Emit every suffix so a
  // protected tail still reaches the matcher.
  for (const s of _suffixCandidates(posixAbs)) {
    const c = usable(s);
    if (c) yield c;
  }
}

/**
 * Eager form — materializes every candidate. Introspection API for tests and
 * diagnostics; guards should prefer matchFirstCandidate (lazy).
 *
 * NOTE this form is EAGER: it always pays for the git probe, AND it walks the
 * full enclosing-tree chain that the lazy form short-circuits out of. Guards
 * must use matchFirstCandidate instead.
 *
 * @returns {{rels: string[], rootResolved: boolean, sameFamily: boolean,
 *            containingRoot: string|null, gitProbes: number}}
 *
 * `rootResolved` — the INNERMOST containing tree resolved (i.e. the path is in
 *   SOME git repository). Not a jurisdiction verdict.
 * `sameFamily`   — SOME containing tree, innermost OR enclosing, is in the
 *   session's repo family (loom#1430 widened this from "the innermost tree
 *   is": a nested `git init` makes the innermost tree foreign while an
 *   enclosing tree still legitimately owns the path). False ⇒ out of
 *   jurisdiction ⇒ deliberate passthrough.
 * `containingRoot` — the tree that establishes jurisdiction: the innermost
 *   tree, or the first enclosing same-family tree when the innermost is
 *   foreign.
 */
function candidateRepoRelatives(absPath, repoDir, opts) {
  const state = {};
  const rels = [..._candidates(absPath, repoDir, opts, state)];
  return {
    rels,
    rootResolved: state.rootResolved,
    sameFamily: state.sameFamily,
    containingRoot: state.containingRoot,
    gitProbes: state.gitProbes,
    probesExhausted: state.probesExhausted,
  };
}

/**
 * Run `match(rel)` over the candidates and return the first truthy result,
 * else null. `match` is the caller's own watched-path predicate — the
 * pattern set stays owned by each guard.
 *
 * @returns {{hit: any, gitProbes: number}} via `out` when supplied — the probe
 *   count is exposed so a test can pin the laziness (a refactor that made this
 *   eager again would add a subprocess to every protected-path Edit/Write).
 */
function matchFirstCandidate(absPath, repoDir, match, opts, out) {
  const state = {};
  let hit = null;
  for (const rel of _candidates(absPath, repoDir, opts, state)) {
    hit = match(rel);
    if (hit) break;
  }
  if (out && typeof out === "object") out.gitProbes = state.gitProbes;
  return hit;
}

/* ═════════════════════════════════════════════════════════════════════════════
 * THE PROTECTED-PATH REGISTRY (loom#1422)
 *
 * WHAT THIS CLOSES:
 *   "Is this a protected state path?" used to be decided INDEPENDENTLY at ~10
 *   sites across 4 hook files. Measured during the Wave-H session, the
 *   case-sensitivity dimension had to be added at ALL of:
 *
 *     validate-bash-command.js  STATE_PATH_RX, LAYER3_BLOCK_RX, COORD_MODE_RX
 *     integrity-guard.js        DIRECT membership + team-memory/journal/
 *                               workspaces-journal subtrees
 *     posture-gate.js           3 inline regexes
 *     journal-write-guard.js    its own journal-entry matcher
 *
 *   It was still missed — by the orchestrator, WHILE fixing a violation of
 *   security.md § Enforcement-Surface Parity, the very clause that mandates
 *   landing a new dimension at every surface in one change. The Bash-lane fix
 *   shipped first and was declared complete; an adversarial lens then found the
 *   Edit/Write lane fully bypassable (9/9 canonical fenced, 10/10 case-variants
 *   passed). A rule asking a human to remember an enumeration nobody produces
 *   is demonstrably not sufficient.
 *
 * THE MODEL — ONE DECLARATIVE REGISTRY, EVERY SURFACE DERIVED FROM IT:
 *   `PROTECTED_PATHS` below is the single source. Every matcher any hook uses
 *   is BUILT from it (`STATE_PATH_RX`, `LAYER3_BLOCK_RX`, `COORD_MODE_RX`,
 *   `POSTURE_GATE_RX`, the integrity DIRECT set + subtrees, the journal-entry
 *   parser). A new fail-closed dimension is therefore added ONCE — in the
 *   separator token, the case flag, or a registry row — and every surface
 *   inherits it by construction rather than by memory.
 *
 *   The enumeration test at
 *   `tests/integration/multi-operator/protected-path-predicate-1422.test.js`
 *   walks `.claude/hooks/**` and FAILS if any hook re-derives a protected-path
 *   decision locally, so the property survives authors who never read this.
 *   That test ships with a planted-violation anti-vacuity control.
 *
 * SURFACE MEMBERSHIP IS PER-ROW AND DELIBERATELY ASYMMETRIC. The surfaces are
 * NOT the same set, and collapsing them would be a real regression:
 *   - `bash`        — STATE_PATH_RX, the unconditional Bash-lane fence.
 *   - `layer3`      — LAYER3_BLOCK_RX, the #1293 "Option X" subset that KEEPS
 *                     severity:block for an interpreter-body write because the
 *                     forgery is NOT re-derived away by a fold on a
 *                     coordination-OFF repo. Bounded paths (observations.jsonl,
 *                     the ephemeral caches) are deliberately absent — they are
 *                     advisory.
 *   - `direct`      — integrity-guard's Edit/Write watched set (codify-branch +
 *                     covering-lease gated, enrolled-repo conditional). Contains
 *                     learning-codified.json, which is DELIBERATELY absent from
 *                     `bash` because /codify legitimately advances it.
 *   - `coordMode`   — COORD_MODE_RX, the enrolled-vs-solo asymmetric fence.
 *   - `postureGate` — posture-gate.js's defense-in-depth trio.
 *
 * NOT IN SCOPE — the settings-deny CANONICAL_DENY_FLOOR triplication
 * (`settings-deny-edit-guard.js`, `settings-deny-drift-guard.js`,
 * `.claude/bin/reconcile-settings-deny.mjs`) is DELIBERATE duplication, not
 * drift: each hardcodes the floor precisely so poisoning the mutable bin's
 * `CANONICAL_STATE_DENY` cannot reduce the enforced minimum
 * (`settings-deny-edit-guard.js` § "HARDCODED trust anchor (redteam F2)"), and
 * `settings-deny-canon-parity.test.mjs` pins them in lockstep. Consolidating
 * those into this module would DESTROY that independence. The enumeration test
 * therefore recognises a permission-matcher string (`Tool(<path>)`) as a
 * DECLARATION rather than a path-matching decision — a structural
 * discriminator, not a per-file exemption.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The path separator used to join a registry row's literal segments — and, as
 * of loom#1409, the REDUNDANT-SEPARATOR fence.
 *
 * THE DEFECT: POSIX resolves `.claude/X`, `.claude//X` and `.claude/./X` to the
 * SAME file, but only the canonical spelling was fenced. Measured against the
 * real detector before this widening, with controls that MUST flag:
 *
 *   FLAG   echo x > .claude/learning/posture.json      <- CONTROL
 *   PASS   echo x > .claude//learning/posture.json
 *   PASS   echo x > .claude/./learning/posture.json
 *   FLAG   echo x > .claude/VERSION                    <- CONTROL
 *   PASS   echo x > .claude//VERSION
 *
 * It costs one character, needs no symlink and no race. And it is NOT only an
 * attack shape: a `"$DIR/" + "/file"` string join is the ordinary authoring
 * source of a doubled separator, so the fence was defeated as easily by a
 * careless join as by an adversary — the same "two of the defeat forms are not
 * attacks" property that made #1371's S1 finding load-bearing.
 *
 * WHY WIDEN THE PATTERN RATHER THAN NORMALIZE THE COMMAND: the Bash-lane
 * detector deliberately operates on SEGMENTS and masks doc-carrier bodies
 * (#1319 Defect 2), and it applies `pathRx` to a whole LINE at most of its call
 * sites rather than to an extracted operand — so an operand-only normalization
 * would fix Layer 1's redirect/heredoc/tee and silently miss Layer 2, Layer 3
 * and the Layer-4 bundle. Normalizing the whole command would resurrect the
 * prose false positives #1390 spent a round removing. #1409 itself objected to
 * widening on the grounds that it "would have to be repeated at every copy of
 * the pattern" — which is exactly what the registry dissolved: there is now one
 * copy, and this is the one edit.
 *
 * `..` IS DELIBERATELY EXCLUDED. `//` and `/./` are no-ops, so collapsing them
 * cannot change WHICH FILE is named. A `..` segment DOES change the target, so
 * canonicalizing it into a match would be a semantic decision this token must
 * not make silently. The token cannot match it: after the separator,
 * `\.\/+` requires a `/` immediately following the single `.`, which `../` does
 * not provide. The path-shaped lanes resolve `..` upstream instead —
 * `normalizeAbs` realpaths the deepest existing ancestor, and the relative
 * branch of `_candidates` runs `path.posix.normalize`, which collapses an
 * INTERIOR `..` (`.claude/foo/../learning/posture.json` -> the canonical rel,
 * measured WATCHED) while leaving a genuinely ESCAPING `../` prefix intact.
 *
 * BE PRECISE ABOUT WHAT REJECTS THE ESCAPING FORM — an earlier revision of this
 * paragraph said it "is rejected by `usable()`", which is FALSE and was measured
 * so. `usable()` is declared at the top of the ABSOLUTE branch, AFTER the
 * relative branch has already yielded and returned, so it is never called there
 * (and is in the temporal dead zone). The escaping rel IS yielded:
 *
 *   input ".claude/learning/posture.json"                -> rels=[same]  watched=YES  <- CONTROL
 *   input "../outside/.claude/learning/posture.json"     -> rels=[same]  watched=no
 *   input ".claude/foo/../learning/posture.json"         -> rels=[canonical] watched=YES
 *
 * What actually rejects it is the MATCHER: `matchIntegrityWatchedRel` tests
 * DIRECT membership by exact string and its subtrees with `^`-anchored
 * patterns, so a `../`-prefixed rel simply fails to match. That distinction is
 * load-bearing rather than pedantic — the property belongs to the matchers, NOT
 * to the resolver, so a future UNANCHORED consumer of `_candidates` (the
 * Bash-lane regexes are unanchored by design) would inherit an out-of-tree rel
 * and silently lose it. Anchor any new rel matcher, or filter at the source.
 */
const SEP = "\\/+(?:\\.\\/+)*";

function _escapeRx(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A registry row's regex source: literal segments joined by the SEP token,
 * optionally fenced by a leading `prefix` assertion.
 *
 * `prefix` (loom#1470) is a ZERO-WIDTH assertion a row may declare to bound its
 * LEFT edge, the mirror of the `\b` trailer `_buildSurfaceRx` appends on the
 * right. Only the `.git` row needs it so far, and it needs it for a measured
 * reason — see that row.
 */
function _rowSource(row) {
  return (
    (row.prefix || "") + row.segments.map(_escapeRx).join(SEP) + (row.suffix || "")
  );
}

/** A registry row's canonical repo-relative spelling (exact-membership form). */
function _rowRel(row) {
  return row.segments.join("/");
}

/**
 * THE REGISTRY. One row per protected path; `surfaces` declares which fences
 * see it. Adding a path is one row; adding a DIMENSION is one edit to the
 * builders below.
 */
const PROTECTED_PATHS = Object.freeze(
  [
    {
      id: "posture.json",
      segments: [".claude", "learning", "posture.json"],
      suffix: "(?:\\.bak|\\.tmp\\.\\d+)?",
      surfaces: { bash: true, layer3: true, direct: true },
      // posture-gate keeps its own tail VERBATIM: this consolidation is
      // behaviour-preserving, and that surface anchors with `$` where the Bash
      // lane uses `\b`. Aligning them would WIDEN posture-gate (fail-closed,
      // arguably better) but is a behaviour change, so it is not taken here.
      postureGateSuffix: "(?:\\.bak)?$",
    },
    {
      id: "violations.jsonl",
      segments: [".claude", "learning", "violations.jsonl"],
      suffix: "(?:\\.[A-Za-z0-9_-]+)?",
      surfaces: { bash: true, layer3: true, direct: true },
      postureGateSuffix: "",
    },
    {
      // Bounded path: NOT in layer3 — a forged positive observation cannot
      // self-upgrade (challenge-nonce gated) and a wipe is self-harm only.
      id: "observations.jsonl",
      segments: [".claude", "learning", "observations.jsonl"],
      suffix: "(?:\\.[A-Za-z0-9_-]+)?",
      surfaces: { bash: true, direct: true },
    },
    {
      id: "coordination-log.jsonl",
      segments: [".claude", "learning", "coordination-log.jsonl"],
      surfaces: { bash: true, layer3: true, direct: true },
    },
    {
      id: "presence-mechanism.json",
      segments: [".claude", "learning", "presence-mechanism.json"],
      surfaces: { bash: true, layer3: true },
    },
    {
      id: ".initialized",
      segments: [".claude", "learning", ".initialized"],
      surfaces: { bash: true, layer3: true },
      postureGateSuffix: "$",
    },
    {
      // Ephemeral cache — bounded, advisory at Layer 3.
      id: ".heartbeat-cache",
      segments: [".claude", "learning", ".heartbeat-cache"],
      suffix: "(?:[A-Za-z0-9_.-]*)?",
      surfaces: { bash: true },
    },
    {
      id: ".session-end-cache",
      segments: [".claude", "learning", ".session-end-cache"],
      suffix: "(?:[A-Za-z0-9_.-]*)?",
      surfaces: { bash: true },
    },
    {
      id: "operators.roster.json",
      segments: [".claude", "operators.roster.json"],
      surfaces: { bash: true, layer3: true, direct: true },
    },
    {
      // F67 / security-reviewer HIGH-1 (journal 0162): the schema is the
      // trust-root CONTRACT — it defines what a valid roster looks like. An
      // operator who weakens it (removes propertyNames prototype-pollution
      // rejection, relaxes the GPG-fingerprint constraint, adds a human_admin
      // synonym to the host_role enum) silently accepts forged rosters. Same
      // structural authority class as operators.roster.json — gated equally.
      id: "operators.roster.schema.json",
      segments: [".claude", "operators.roster.schema.json"],
      surfaces: { bash: true, layer3: true, direct: true },
    },
    {
      // #1309 — the file-tool deny CONTRACT protecting every path above.
      id: "settings.json",
      segments: [".claude", "settings.json"],
      surfaces: { bash: true, layer3: true },
    },
    {
      // #1429 AC-3 — `.claude/settings.local.json` carries an `env` block that
      // reaches EVERY hook subprocess (settings-deny-drift-guard.js documents
      // the merge), i.e. the same authority class as settings.json — yet it
      // matched NEITHER Bash-lane regex: the alternation requires
      // `settings\.json` immediately after `.claude/`, and `settings.local.json`
      // fails at `local.`. Measured before this row, with its sibling as the
      // anti-vacuity control:
      //
      //   PASSED   echo x > .claude/settings.local.json
      //   FLAGGED  echo x > .claude/settings.json        <- CONTROL
      //
      // That is the delivery vehicle #1429's walkthrough uses to plant
      // LOOM_ECOSYSTEM_CONFIG and disable coordination at all 10 gate sites.
      //
      // BASH LANE ONLY — deliberately NOT in `direct`, and this asymmetry is a
      // DECISION, not an omission. settings.local.json is gitignored
      // per-operator config an operator legitimately edits with file tools
      // (`/settings` writes it), so an enrolled-repo Edit fence would over-block
      // a documented happy path. The file-tool side of this authority class is
      // already covered differently: settings-deny-drift-guard.js SCANS
      // settings.local.json for dangerous `env` keys at session start, and
      // LOOM_ECOSYSTEM_CONFIG joined DANGEROUS_ENV_EXACT in #1429.
      id: "settings.local.json",
      segments: [".claude", "settings.local.json"],
      surfaces: { bash: true, layer3: true },
    },
    {
      // #1399 — the repo-CLASS root of trust.
      id: "VERSION",
      segments: [".claude", "VERSION"],
      surfaces: { bash: true, layer3: true },
    },
    {
      // #1441 — the coordination MASTER SWITCH, sitting above every other fence:
      // a `coordination.enabled:false` here turns coordination off at all 10
      // gate call sites. It was fenced on NO lane — verified before this row:
      // absent from STATE_PATH_RX, absent from settings.json permissions.deny,
      // absent from integrity-guard's DIRECT set.
      //
      // WHAT THIS ROW DOES, AND WHAT NOW COVERS THE REST. #1439 (for #1429) made
      // tier 3 verify the config's LOCATION — that the resolved path is the
      // canonical `<repo>/.claude/bin/ecosystem.json`, refusing an env relocation
      // or an out-of-tree symlink. This row fences the WRITE on both agent-write
      // lanes, which is the cheap correct half of #1441.
      //
      // It closes the AGENT vector only, and the earlier form of this comment
      // recorded the rest as an open residual: an actor writing the file outside
      // the agent's tool boundary (a plain editor, an operator-run script) still
      // produced an uncommitted canonical config the predicate honoured. That
      // residual is now CLOSED at the other end — coordination-mode.js
      // § COMMIT ATTESTATION requires the committed blob at HEAD to itself carry
      // `coordination.enabled:false` before a disable is honoured on an enrolled
      // repo. The two halves are complementary and neither subsumes the other:
      // this row stops the agent from writing the file at all; the attestation
      // stops an already-written uncommitted disable from taking effect.
      //
      // NOT added to settings.json `permissions.deny`: `/ecosystem-init` writes
      // this file with file tools on a fresh fork, and a flat absolute `Edit()`
      // deny would break that sanctioned ceremony — the same reasoning that
      // keeps `.claude/VERSION` out of CANONICAL_STATE_DENY. DIRECT membership
      // is the right control precisely because integrity-guard is
      // enrolled-CONDITIONAL: a pre-enrollment fork writes it freely, while an
      // enrolled repo routes the write through the codify-branch +
      // covering-lease flow. Same disposition as coordination-mode.json, one
      // level up — and it preserves the audited-disable path that T4 pins.
      id: "bin/ecosystem.json",
      segments: [".claude", "bin", "ecosystem.json"],
      surfaces: { bash: true, layer3: true, direct: true },
    },
    {
      // #1470 — THE GIT ADMINISTRATIVE SURFACE ITSELF, the one every
      // git-derived security property in this repo already depends on and the
      // only one that was fenced on NO lane. Two INDEPENDENTLY-EXECUTED defeats
      // share it, and both go AROUND the #1464 subprocess-env allowlist rather
      // than through it, so no env fix can reach either.
      //
      // DEFEAT 1 — the `.git` FILE of a LINKED WORKTREE. Git DISCOVERY reads
      // `<repo>/.git` FROM DISK before any environment is consulted; in a linked
      // worktree that is a plain text file holding `gitdir: <path>`. Measured on
      // a real `git worktree add` fixture whose roster is ANCHORED AT HEAD but
      // absent in the working tree (the #1462 F2 tier the redirect steers):
      //
      //   clean .git                -> {enabled:true,  "implicit-head-enrolled-failclosed"}  WARNS
      //   .git -> <evil>/.git       -> {enabled:false, "default-off"}                        SILENT
      //
      // The evil tree is a VALID repository, so git SUCCEEDS and simply answers
      // about the WRONG repo — there is no `{ok:false}` for the tightest-ranking
      // fix at f957b3f9 to catch. One file write, substrate OFF, no warning.
      //
      // DEFEAT 2 — `core.repositoryformatversion = 99` in the repo's own
      // `.git/config`. GIT_CONFIG_NOSYSTEM + GIT_CONFIG_GLOBAL=/dev/null
      // neutralise the system and global files, but a repository's OWN config is
      // always read and cannot be disabled. Measured on the same fixture:
      //
      //   git -C <wt> status --porcelain
      //     -> status=128  "fatal: Expected git repo version <= 1, found 99"
      //   substrate -> {enabled:true, "implicit-head-indeterminate-failclosed"}  WARNS
      //
      // BE PRECISE ABOUT WHAT DEFEAT 2 STILL IS. #1470 reported it as a SILENT
      // disable; at f957b3f9 ("rank git-could-not-answer TIGHTEST at the F2
      // surface too") that half is ALREADY CLOSED — the outcome is now a LOUD
      // fail-closed-ON, measured above, not `{enabled:false,"default-off"}`. What
      // remains, and what this row fences, is that ONE unguarded write still
      // FORCES that state transition repo-wide and breaks EVERY git command in
      // the repository. Do not re-file the closed half.
      //
      // WHY A `.git` PREFIX MATCH IS THE WHOLE SUBTREE. `_buildSurfaceRx`
      // appends `\b`, and every sibling dotfile continues with a WORD character
      // — `.gitignore`, `.github`, `.gitattributes`, `.gitmodules` — so `\.git\b`
      // matches `.git`, `.git/config` and `.git/HEAD` while matching none of
      // them. No wildcard suffix is needed and none is added.
      //
      // WHY THE `prefix` LOOKBEHIND. Without it, `\.git\b` also matches the
      // `.git` tail of every clone URL, and Layer 2 is DIRECTION-BLIND
      // (`pathRx.test(line)`), so an ordinary `rm -rf build && git clone
      // https://host/o/r.git` would block. `(?<![\w-])` requires the `.git` to
      // start a path token — measured over a 7-command legitimate corpus
      // (clone via https + ssh, `.gitignore`, `.github/workflows`,
      // `.gitattributes`, `.gitmodules`): 7/7 pass, while all 7 adversarial
      // `.git` write forms flag. A bare repo named `repo.git` is deliberately
      // OUT of scope — it is a different repository's admin dir.
      //
      // `subtree: true` is what carries `.git/**` onto the Edit/Write DIRECT
      // lane: exact membership (`_rowRel`) covers `.git` itself, and the derived
      // WATCHED_SUBTREE_RX below covers everything beneath it.
      //
      // KEEPS block AT LAYER 3, same disposition as posture.json / settings.json
      // / VERSION: NOTHING re-derives `.git`, on a coordination-ON repo or an OFF
      // one, so an interpreter-body forgery STANDS. Prose-FP cost measured over
      // `.claude/**/*.md` at this commit, path-position `.git` (count/files):
      // 33/20 — BELOW `.claude/settings.json` (81/37) and `.claude/VERSION`
      // (90/26), both of which already carry Layer-3 block.
      //
      // NOT added to settings.json `permissions.deny`: a flat absolute `Edit()`
      // deny cannot express the enrolled-conditional model, and integrity-guard
      // is the right control for the same reason `bin/ecosystem.json` and
      // `.claude/VERSION` are declined there.
      id: ".git",
      segments: [".git"],
      prefix: "(?<![\\w-])",
      surfaces: { bash: true, layer3: true, direct: true },
      subtree: true,
    },
    {
      // Enrolled-vs-solo asymmetric: the opt-in override. A FLAT bash add would
      // over-block a solo consumer's own escape hatch, so it lives on its own
      // surface, gated by isCoordinationEnabled() at the caller.
      id: "coordination-mode.json",
      segments: [".claude", "learning", "coordination-mode.json"],
      surfaces: { direct: true, coordMode: true },
    },
    {
      // The /codify last_codified anchor (#759, security-reviewer Finding 4 in
      // the PR #758 redteam). UNLIKE its hook-only siblings (posture.json /
      // violations.jsonl / observations.jsonl / coordination-log.jsonl) this
      // file is CODIFY-WRITABLE: every /codify legitimately advances it. So it
      // is DELIBERATELY absent from the `bash` surface AND from settings.json
      // permissions.deny — a flat absolute deny would break /codify's own anchor
      // write (the #754 false-scenario as a real regression). The correct
      // control is DIRECT membership: the codify-branch + covering-lease flow
      // ALLOWS the write on codify/<display_id>-<date> under a lease whose
      // scope_files include this path (codify-lease.js MANDATORY_SCOPE already
      // unions it), and BLOCKS an off-codify `node -e`/Write that would advance
      // the anchor past unprocessed work, silently dropping a codification
      // window. Codify-writable → lease-gated; hook-owned → absolute-deny. That
      // asymmetry is the whole point, and it is why `surfaces` is per-row.
      id: "learning-codified.json",
      segments: [".claude", "learning", "learning-codified.json"],
      surfaces: { direct: true },
    },
  ].map(Object.freeze),
);

function _rowsFor(surface) {
  return PROTECTED_PATHS.filter((r) => r.surfaces[surface] === true);
}

/**
 * Build a path matcher over a registry surface.
 *
 * CASE-INSENSITIVE (`i`) IS LOAD-BEARING, NOT COSMETIC (loom#1399): on a
 * case-INSENSITIVE filesystem (APFS default on macOS, the default dev platform
 * for this corpus) `.claude/version` and `.claude/VERSION` are THE SAME FILE, so
 * a case-SENSITIVE matcher is defeated by a one-character change. Setting it
 * here sets it for every surface at once — which is precisely the property the
 * three hand-maintained copies failed to hold.
 */
function _buildSurfaceRx(surface, trailer) {
  const rows = _rowsFor(surface);
  /* istanbul ignore next — a surface with no rows is a registry authoring bug,
     and an empty alternation would build a regex matching EVERYTHING. Fail
     loudly rather than ship a matcher that blocks the whole repo. */
  if (rows.length === 0) {
    throw new Error(
      `guard-path-scope: protected-path surface "${surface}" has no registry rows`,
    );
  }
  return new RegExp(
    "(?:" + rows.map(_rowSource).join("|") + ")" + (trailer || ""),
    "i",
  );
}

/** Bash lane — the unconditional state-file mutation fence. */
const STATE_PATH_RX = _buildSurfaceRx("bash", "\\b");

/** Bash lane — the #1293 Option-X subset that KEEPS severity:block at Layer 3. */
const LAYER3_BLOCK_RX = _buildSurfaceRx("layer3", "\\b");

/** Bash lane — the enrolled-repo-only coordination-mode fence. */
const COORD_MODE_RX = _buildSurfaceRx("coordMode", "\\b");

/**
 * posture-gate.js's defense-in-depth trio. Each row keeps its own anchor so
 * this consolidation is behaviour-preserving (see the posture.json row).
 */
const POSTURE_GATE_RX = new RegExp(
  "(?:" +
    PROTECTED_PATHS.filter((r) => typeof r.postureGateSuffix === "string")
      .map((r) => r.segments.map(_escapeRx).join(SEP) + r.postureGateSuffix)
      .join("|") +
    ")",
  "i",
);

/**
 * `.claude/learning/*.jsonl` — the own-WIP attribution predicate
 * (multi-operator-sessionstart.js, F13 closure). Not a registry row (it is a
 * WILDCARD over the learning dir, not one path) but it IS a
 * `.claude/learning/` decision, so it is built here from the same SEP token
 * rather than re-spelled inline.
 */
const LEARNING_JSONL_RX = new RegExp(
  _escapeRx(".claude") + SEP + _escapeRx("learning") + SEP + ".*\\.jsonl",
  "i",
);

/**
 * The journal-entry grammar (journal-write-guard.js).
 *
 *   journal/<slot>-<...>.md
 *   workspaces/<name>/journal/<slot>-<...>.md
 *   workspaces/<name>/journal/.pending/<slot>-<...>.md
 *
 * Case-insensitive for the same reason as everything else here: on a
 * case-insensitive filesystem `Journal/0001-X-a.md` IS `journal/0001-X-a.md`.
 */
const JOURNAL_ENTRY_RX = new RegExp(
  "^((?:workspaces" +
    SEP +
    "[^/]+" +
    SEP +
    ")?)(journal)((?:" +
    SEP +
    "\\.pending)?)" +
    SEP +
    "(\\d+)(?:-[^/]*)?\\.md$",
  "i",
);

/**
 * Subtrees integrity-guard watches wholesale (not single files).
 *
 * The first three are shapes, not paths, so they stay literal. Rows that ARE
 * paths declare `subtree: true` on the registry instead and are DERIVED here
 * (loom#1470) — a subtree row must never be hand-maintained in two places, which
 * is the exact drift the #1422 registry exists to dissolve.
 */
const WATCHED_SUBTREE_RX = Object.freeze([
  new RegExp("^" + _escapeRx(".claude") + SEP + "team-memory" + SEP, "i"),
  new RegExp("^journal" + SEP, "i"),
  new RegExp("^workspaces" + SEP + "[^/]+" + SEP + "journal" + SEP, "i"),
  ..._rowsFor("direct")
    .filter((r) => r.subtree === true)
    .map(
      (r) => new RegExp("^" + r.segments.map(_escapeRx).join(SEP) + SEP, "i"),
    ),
]);

/** integrity-guard's DIRECT set, derived — never hand-maintained. */
const DIRECT_WATCHED_RELS = Object.freeze(_rowsFor("direct").map(_rowRel));
const _DIRECT_LC = new Set(DIRECT_WATCHED_RELS.map((p) => p.toLowerCase()));

/**
 * Canonicalize a repo-RELATIVE candidate before a membership test.
 *
 * loom#1409, the path-lane half: collapses the redundant forms (`//`, `/./`)
 * and strips a leading `./` so an EXACT-membership test cannot be defeated by a
 * redundant spelling. Through the production call path this is belt-and-braces
 * (`_candidates` realpaths the absolute branch and `path.posix.normalize`s the
 * relative one), but the predicate must be sound when called DIRECTLY too —
 * defence that depends on every caller normalizing first is the shape of the
 * original defect.
 *
 * A genuinely escaping `../` is LEFT INTACT rather than resolved, so the
 * caller's out-of-tree rejection still fires — same `..` reasoning as SEP.
 */
function normalizeRel(rel) {
  if (typeof rel !== "string" || rel.length === 0) return "";
  const n = path.posix.normalize(_toPosix(rel));
  if (n === "." || n === "./") return "";
  return n.replace(/^\.\//, "");
}

/**
 * integrity-guard's watched-path pattern set, applied to ONE candidate
 * repo-relative path. Returns `{watched: true, rel}` on a hit, else null.
 *
 * The `rel` returned is the ORIGINAL spelling, not the normalized one, so the
 * caller's downstream lease/branch messages quote what the payload actually
 * said.
 */
function matchIntegrityWatchedRel(rel) {
  const norm = normalizeRel(rel);
  if (norm.length === 0) return null;
  if (_DIRECT_LC.has(norm.toLowerCase())) return { watched: true, rel };
  for (const rx of WATCHED_SUBTREE_RX) {
    if (rx.test(norm)) return { watched: true, rel };
  }
  return null;
}

/**
 * The journal-entry matcher (journal-write-guard.js). Returns
 * `{watched: true, slot, dir, rel}` on a hit, else null.
 *
 * `dir` is the reservation-registry KEY and is compared by EXACT string at
 * findSlotReservation, so the WHOLE prefix is rebuilt in canonical lower case —
 * including `workspaces/<name>/`. Folding the workspace name is deliberate and
 * was measured: on a case-insensitive filesystem `workspaces/MyWs/journal/…`
 * and `workspaces/myws/journal/…` are THE SAME FILE, and preserving the prefix
 * split them across two registry keys (the workspace-name pair was the only
 * SPLIT KEY, with the journal/.pending pairs as 2/2 passing controls). The cost
 * on a case-SENSITIVE filesystem is an OVER-fence — two genuinely distinct
 * workspaces differing only by case share one key — which is the same fail-safe
 * trade loom#1399 took: a guard whose protection depends on the host filesystem
 * is worse than one that over-fences a name nobody uses. Verified no-op for
 * this repo (all 44 workspace names are lower case, so no existing
 * coordination-log record's `dir` changes meaning).
 */
function matchJournalEntryRel(rel) {
  const norm = normalizeRel(rel);
  if (norm.length === 0) return null;
  const m = norm.match(JOURNAL_ENTRY_RX);
  if (!m) return null;
  const dir = `${m[1]}${m[2]}${m[3]}`.toLowerCase();
  return { watched: true, slot: m[4], dir, rel };
}

/**
 * posture-gate.js's protected-path predicate, applied to an already
 * realpath-normalized absolute file path.
 */
function isPostureGateProtectedPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  return POSTURE_GATE_RX.test(_toPosix(filePath));
}

/** `.claude/learning/*.jsonl` own-WIP attribution predicate. */
function isLearningStateJsonlPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  return LEARNING_JSONL_RX.test(_toPosix(filePath));
}

module.exports = {
  candidateRepoRelatives,
  matchFirstCandidate,
  normalizeAbs,
  MARKERS,
  // ── the protected-path predicate (loom#1422) ──
  PROTECTED_PATHS,
  STATE_PATH_RX,
  LAYER3_BLOCK_RX,
  COORD_MODE_RX,
  POSTURE_GATE_RX,
  LEARNING_JSONL_RX,
  JOURNAL_ENTRY_RX,
  DIRECT_WATCHED_RELS,
  WATCHED_SUBTREE_RX,
  normalizeRel,
  matchIntegrityWatchedRel,
  matchJournalEntryRel,
  isPostureGateProtectedPath,
  isLearningStateJsonlPath,
};
