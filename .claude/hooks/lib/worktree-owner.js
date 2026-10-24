/**
 * worktree-owner.js — the ONE reader of worktree OWNERSHIP, shared by the reaper
 * (`.claude/bin/worktree-reap.mjs`) and the SessionEnd caller that sizes its budget
 * (`worktree-forest.js`).
 *
 * WHY THIS IS ITS OWN MODULE. Ownership was read inside `worktree-reap.mjs` alone,
 * and the reaper asked it only INSIDE per-tree classification — after `git status`,
 * `rev-list` and `for-each-ref` had already been paid for. Measured 2026-10-11 on a
 * 51-tree forest at load ~90: the SessionEnd guard took 38.2 s of a 45 s registration,
 * classifying ~50 trees only to hold them as not-this-session's. The fix decides
 * ownership FIRST, so both the reaper (to filter its candidate set) and its caller (to
 * size the budget by the OWNED count) need the answer — and two copies of "is this
 * mine" would be the second lineage that drifts (`security.md` § Multi-Site Kwarg
 * Plumbing). So the answer lives here, once, and both import it.
 *
 * WHAT IS READ, EXACTLY — not a guess, and not the environment at reap time:
 *
 *   1. THE OWNER RECORD, `<per-worktree git dir>/coc-owner.json`. The per-worktree git
 *      dir is the one under `<common>/worktrees/` whose `gitdir` BACK-LINK names this
 *      tree, confirmed by the tree's own `.git` pointer when that file still exists (see
 *      `adminDirFor` — never derived from the tree's basename, which git does not keep
 *      unique). The file is written at CREATION and is NOT removed by
 *      `git worktree unlock`, which is what makes "spent but still mine" readable;
 *      `git worktree remove` deletes the whole admin dir, so the record cannot outlive
 *      its tree.
 *   2. FALLBACK — the LOCK REASON, `coc-session=<id> …`, which git prints as
 *      `locked <reason>` in `git worktree list --porcelain`. Used only when the owner
 *      record is absent, and only to ACCEPT a tree as ours.
 *
 * ABSENT MEANS NOT OURS. A tree with no readable record and no session-bearing lock is
 * NOT owned — and so is one whose record is unreadable, malformed, wrong-typed or
 * names an empty session. Nothing else is consulted: not the branch name, not the
 * path, not the environment. A name that merely CONTAINS a session id is not a record.
 *
 * This module reads files and parses strings. It spawns NOTHING — no git call, which
 * is the whole point: ownership must be answerable before any per-tree git work is
 * spent. Style: CommonJS, matching `.claude/hooks/lib/`; the reaper loads it through
 * `createRequire`, the same shape it uses for `trunk-ref.js` and `landed-map.js`.
 */

"use strict";

const fs = require("fs");
const path = require("path");
// The shared non-blocking, fd-checked reader and its exclusive-create write twin.
// Every file here sits in a session-writable git admin area (`<common>/worktrees/
// <id>/gitdir`, a tree's `.git`, `coc-owner.json`); a FIFO at any was a blocking
// read on the worktree-forest hook path, and a symlink at the owner record
// redirected the reaper's write.
const { readRegularFileBounded, writeFreshThenRename } = require(path.join(__dirname, "landing-window-read.js"));

const OWNER_FILE = "coc-owner.json";
const SESSION_REASON_RE = /(?:^|\s)coc-session=([^\s]+)/;

/**
 * Parse `git worktree list --porcelain` into records. Records are separated by blank
 * lines; keys are space-delimited, and `bare` / `detached` / `locked` / `prunable` may be
 * VALUELESS flags (`true`). A `locked <reason>` line keeps its reason STRING, which is
 * what `sessionFromLock` reads.
 */
function parseWorktreePorcelain(porcelain) {
  const out = [];
  let cur = null;
  for (const raw of String(porcelain).split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? true : line.slice(sp + 1);
    if (key === "worktree") cur = { path: val, detached: false, locked: false, prunable: false };
    else if (cur) cur[key] = val;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The canonical form of a path that need not exist: the realpath of its deepest existing
 * ancestor, with the missing tail appended. A prunable tree's directory is gone, so a
 * plain `realpathSync` cannot resolve it — and a lexical string would compare
 * `/var/...` against git's `/private/var/...` on macOS and miss. Every comparison in
 * this module runs BOTH sides through this one function, so they cannot disagree about
 * a symlinked prefix.
 *
 * NULL, never a guess, when a component EXISTS but will not resolve (a dangling link,
 * EACCES, ELOOP) or nothing resolves: it climbs ONLY past a genuinely absent component
 * (ENOENT and `lstat` sees nothing). It used to climb past ANY error and return the raw
 * root, so a back-link or tree spelled through a dangling link canonicalized to a form that
 * never resolved and could match another tree's (train-8 R2 correctness ledger: the corr F1 class). Every caller reads null
 * as "no admin dir / no owner record" — the not-owned, refusal direction.
 */
function canonicalPath(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch (e) {
    if (!e || e.code !== "ENOENT") return null;
    try {
      fs.lstatSync(abs);
      return null; // the entry exists but will not resolve: a dangling link
    } catch (le) {
      if (!le || le.code !== "ENOENT") return null; // not provably absent: refuse
      /* genuinely absent: climb */
    }
    const parent = path.dirname(abs);
    if (parent === abs) return null;
    const up = canonicalPath(parent);
    return up === null ? null : path.join(up, path.basename(abs));
  }
}

/**
 * Every per-worktree admin dir under `<realpath(common)>/worktrees/`, keyed by the
 * canonical `<tree>/.git` path its `gitdir` BACK-LINK names. Built once per call site
 * that asks about many trees (`partitionByOwner`), so the scan is not repeated per tree.
 *
 * CONTAINED: an entry whose realpath leaves `<realpath(common)>/worktrees/` (a symlink
 * planted there) is not an admin dir and is skipped. A relative back-link (git's
 * `worktree.useRelativePaths`) is relative to the admin dir, and is resolved there.
 * Returns null when the worktrees directory cannot be read.
 */
function adminIndex(gitCommonDir) {
  if (typeof gitCommonDir !== "string" || gitCommonDir === "") return null;
  let root;
  let names;
  try {
    root = fs.realpathSync(path.join(fs.realpathSync(gitCommonDir), "worktrees"));
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  const byTarget = new Map();
  for (const name of names) {
    let dir;
    let link;
    try {
      dir = fs.realpathSync(path.join(root, name));
      if (path.dirname(dir) !== root) continue;
      const got = readRegularFileBounded(path.join(dir, "gitdir"));
      if (!got.ok) continue; // refused (FIFO, symlink, oversized) or absent: no back-link
      link = got.text.trim();
    } catch {
      continue;
    }
    if (!link) continue;
    const target = canonicalPath(path.resolve(dir, link));
    if (target === null) continue; // an unresolvable back-link names no tree
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target).push(dir);
  }
  return { root, byTarget };
}

/**
 * The per-worktree git admin dir for `wtPath`, or null when it has none.
 *
 * FOUND BY BACK-LINK, NEVER DERIVED FROM A NAME. Git suffixes same-basename admin dirs
 * (`foo`, `foo1`, …), so `<common>/worktrees/<basename(path)>` is a GUESS that names
 * another tree's admin dir whenever two trees share a basename — and the guess used to be
 * the fallback for exactly the tree that cannot contradict it, a prunable one whose
 * directory is gone. Reading a foreign vanished `b/foo` through our `worktrees/foo` made
 * it ours, and the reaper then retired its registration and orphaned its detached commit.
 *
 * So the answer is the admin dir, CONTAINED in `<realpath(common)>/worktrees/`, whose
 * `gitdir` back-link resolves to `<canonical wtPath>/.git`. When the tree-side `.git`
 * file is present its `gitdir:` pointer (relative ones resolved against the tree) MUST
 * name that same dir, or the answer is null: the pointer is a file any process in the
 * tree can rewrite, so it may only CONFIRM the back-link, never stand in for it. A
 * missing `.git` (the directory is gone) leaves the back-link as the sole witness; two
 * back-links to one path are AMBIGUOUS and null, pointer or no pointer.
 * File reads only — no git spawn.
 */
function adminDirFor(wtPath, gitCommonDir, index) {
  if (typeof wtPath !== "string" || wtPath === "") return null;
  const idx = index === undefined ? adminIndex(gitCommonDir) : index;
  if (!idx) return null;
  const tree = canonicalPath(wtPath);
  if (tree === null) return null; // cannot be shown to be ANY registered tree: no record
  const dotGit = path.join(tree, ".git");
  let pointer = null;
  try {
    if (!fs.statSync(dotGit).isFile()) return null; // the main checkout: `.git` is a directory
    // Decided on the opened fd: a `.git` that exists but is refused (a FIFO swapped
    // in after the stat, a symlink, oversized) is a `.git` we could not check —
    // CLOSED (null), exactly like the non-ENOENT branch below. ENOENT (the tree
    // vanished after the stat) still leaves the back-link to decide.
    const got = readRegularFileBounded(dotGit);
    if (!got.ok) {
      if (got.code === "ENOENT") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return null;
    }
    const m = got.text.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m || !m[1]) return null;
    pointer = canonicalPath(path.resolve(tree, m[1]));
    if (pointer === null) return null; // a pointer we could not check: closed
  } catch (e) {
    // ABSENT is the prunable shape and leaves the back-link to decide; anything else
    // (unreadable, not a directory on the way) is a `.git` we could not check — closed.
    if (!e || (e.code !== "ENOENT" && e.code !== "ENOTDIR")) return null;
  }
  // EXACTLY ONE back-link, whatever the pointer says. A second admin dir naming the same
  // tree is not something git makes for a live tree, so it is a forgery or a stale
  // re-registration; letting the tree-side pointer pick between them would let a
  // rewritable file choose WHICH record is read — including a planted one naming us.
  const hits = idx.byTarget.get(dotGit) || [];
  if (hits.length !== 1) return null;
  if (pointer !== null && pointer !== hits[0]) return null;
  return hits[0];
}

/**
 * The owner record for a tree, or null. NEVER throws: an unreadable or malformed record
 * reads as ABSENT, which is the refusal direction, never as "ours".
 */
function readOwnerRecord(wtPath, gitCommonDir, index) {
  const dir = adminDirFor(wtPath, gitCommonDir, index);
  if (!dir) return null;
  try {
    const got = readRegularFileBounded(path.join(dir, OWNER_FILE));
    if (!got.ok) return null; // refused or absent: no owner record, never a guess
    const rec = JSON.parse(got.text);
    if (!rec || typeof rec !== "object") return null;
    return {
      session: typeof rec.session === "string" && rec.session ? rec.session : null,
      owner: typeof rec.owner === "string" ? rec.owner : null,
      created: typeof rec.created === "string" ? rec.created : null,
      branch: typeof rec.branch === "string" ? rec.branch : null,
      source: OWNER_FILE,
    };
  } catch {
    return null;
  }
}

/** Write the owner record next to git's own per-worktree admin files. */
function writeOwnerRecord(wtPath, gitCommonDir, rec) {
  const dir = adminDirFor(wtPath, gitCommonDir);
  if (!dir || !fs.existsSync(dir)) return { ok: false, err: `no per-worktree git dir for ${wtPath}` };
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Exclusive temp create + rename (`writeFreshThenRename`): a plain writeFileSync
    // FOLLOWED a symlink planted at `coc-owner.json` in the session-writable admin
    // dir and wrote the reaper's record wherever it pointed. rename(2) replaces a
    // symlink standing at the target rather than following it.
    const file = path.join(dir, OWNER_FILE);
    writeFreshThenRename(`${file}.tmp-${process.pid}`, file, JSON.stringify(rec, null, 2) + "\n", 0o644);
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

/**
 * The session a LOCK names, from the reason string git reports. `locked true` (no
 * reason) yields null — a lock with no session in it names nobody, and reading
 * "unspecified" as "ours" is exactly the inference this gate exists to refuse.
 */
function sessionFromLock(wt) {
  if (!wt || typeof wt.locked !== "string") return null;
  const m = wt.locked.match(SESSION_REASON_RE);
  return m && m[1] ? m[1] : null;
}

/**
 * Decide who owns a tree. PURE except for the record already read.
 *
 * PRECEDENCE IS RECORD-FIRST: the record survives `unlock`, the lock reason does not.
 * A tree that was delivered (and so unlocked) must still read as owned, or the delivery
 * path strands it.
 *
 * Returns { session, owner, created, branch, source } — `session` null means UNOWNED,
 * which every caller MUST read as "not mine".
 */
function decideTreeOwner(record, wt) {
  if (record) return record;
  const s = sessionFromLock(wt);
  if (s) return { session: s, owner: null, created: null, branch: null, source: "lock-reason" };
  return { session: null, owner: null, created: null, branch: null, source: null };
}

/**
 * Is `owner` (a `decideTreeOwner` result) the session `sid`? THE ownership predicate —
 * the reaper's candidate filter, its in-classify guard and the caller's budget count all
 * call THIS function, so they cannot disagree.
 *
 * FAIL-CLOSED, and each refusal is its own line so a mutation of any one is visible:
 * no session to compare against owns nothing; a missing owner, or one whose session is
 * absent or not a non-empty string, is NOT owned.
 */
function isOwnedBy(owner, sid) {
  if (typeof sid !== "string" || sid === "") return false;
  if (!owner || typeof owner.session !== "string" || owner.session === "") return false;
  return owner.session === sid;
}

/**
 * Split parsed worktrees into the ones `sid` owns and the rest, reading each tree's
 * ownership ONCE (file reads only — no git). Order is preserved within each half.
 *
 * Returns { owned: [{ wt, owner }], notOwned: [{ wt, owner }] }.
 */
function partitionByOwner(worktrees, gitCommonDir, sid, prebuiltIndex) {
  const owned = [];
  const notOwned = [];
  // ONE scan of the admin dirs for the whole forest — the caller's, when it already
  // built one for the run. `null` (unreadable) is passed on as is, so every tree reads
  // as having no record — not owned, the refusal direction.
  const index = prebuiltIndex === undefined ? adminIndex(gitCommonDir) : prebuiltIndex;
  for (const wt of worktrees || []) {
    const owner = decideTreeOwner(readOwnerRecord(wt.path, gitCommonDir, index), wt);
    (isOwnedBy(owner, sid) ? owned : notOwned).push({ wt, owner });
  }
  return { owned, notOwned };
}

module.exports = {
  OWNER_FILE,
  SESSION_REASON_RE,
  parseWorktreePorcelain,
  canonicalPath,
  adminIndex,
  adminDirFor,
  readOwnerRecord,
  writeOwnerRecord,
  sessionFromLock,
  decideTreeOwner,
  isOwnedBy,
  partitionByOwner,
};
