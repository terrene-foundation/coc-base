#!/usr/bin/env node
// worktree-triage.mjs — classify every worktree in the forest by what a dead
// lane LEFT BEHIND, so a fleet that died together can be triaged before any
// tree is reused, re-entered, or removed.
//
// The RECOVERY counterpart to `worktree-reap.mjs` — ONE vocabulary between
// them, TWO axes. Both tools answer the removal-safety question in the SAME
// word, `verdict` ∈ ZERO-LOSS / KEEP (the reaper additionally mints TAG-FIRST,
// which only a tool that removes trees can act on). This tool then answers the
// FINER question the reaper cannot — "a lane died here; what is still
// recoverable, and what needs saving RIGHT NOW?" — on a SUBORDINATE field,
// `recoverability` ∈ SALVAGE / PUSHED / UNPUSHED / LOST.
//
// The subordination is the point. KEEP alone collapses "someone is working
// here" and "23 files of finished work nobody has committed" into one word, and
// it is the second that loses work when eight lanes die inside three minutes —
// so the distinction is PRESERVED, just not as a rival `verdict`. Before
// 2026-08-22 these four classes were emitted under the field name `verdict`,
// the same name carrying the reaper's three: one field, one question, two
// vocabularies. See § THE SHARED REMOVAL-SAFETY VOCABULARY for the mapping.
//
// Governed by `rules/worktree-isolation.md` Rule 4a (obligation 2: triage
// every dead lane's worktree for uncommitted work, and capture it, BEFORE any
// worktree is reused or removed).
//
// ── THE FOUR CLASSES (total, ordered — SALVAGE dominates) ───────────────────
//
//   SALVAGE   uncommitted work is present in the working tree. THE case that
//             loses work: unstaged edits and untracked-not-ignored files have
//             NO reflog (`rules/git.md` § Destructive Working-Tree Ops), so
//             nothing recovers them once the tree is reused or removed.
//   PUSHED    clean tree; the lane's commits exist AND are reachable from some
//             remote-tracking ref. Recoverable from the remote alone.
//   UNPUSHED  clean tree; the lane's commits exist and are on NO remote. The
//             branch ref (or the detached SHA, reported) is the only copy.
//   LOST      clean tree, no commits of its own. Nothing is recoverable here —
//             either the lane produced nothing, or what it produced is gone.
//
// A tree is classified SALVAGE the moment `git status` reports ANY entry,
// regardless of its commit state, because that is the only class with a
// deadline. The commit-axis counts are still reported for a SALVAGE tree.
//
// "ANY entry" is only as honest as the status invocation, so that invocation
// is PINNED at `classify()` rather than left to inherit config
// (`--untracked-files=all --ignore-submodules=none --porcelain=v1`). A
// repo-local `status.showUntrackedFiles=no` otherwise makes git exit 0 with
// EMPTY output on a tree whose only content is untracked — the config-driven
// false clean `lane-status.mjs::countDirty` names — and this tool would then
// classify a lane's irreplaceable output LOST, "nothing recoverable here",
// one step before the tree is reused. `=all` rather than `=normal` because
// the default collapses a whole new directory to a single `?? dir/` entry,
// so `dirty_count` would under-report the rescue by every file but one, and
// because `=all` is the enumeration `capture()`'s own
// `ls-files --others` half already copies — one number, one meaning.
//
// ── FAIL-CLOSED, AND WHERE ──────────────────────────────────────────────────
//
// An UNREADABLE `git status` is classified SALVAGE, not LOST. "The tree is
// clean" and "I could not find out whether the tree is clean" produce the same
// empty output from a naive read, so treating the second as clean would be a
// non-discriminating instrument in exactly the sense
// `rules/instrument-discipline.md` MUST-1 names — and the direction that
// errs is the one that keeps the directory around. Same for an unreadable
// commit count: the tree is reported with the count as `null` and a stated
// reason, never as a zero.
//
// An ABSENT directory is different and is NOT SALVAGE: whatever was
// uncommitted there is already gone, so there is nothing to capture. Its
// commit axis is still evaluated from the branch ref in the main checkout,
// which survives the directory.
//
// ABSENT and UNREADABLE are therefore DISTINGUISHED, and `existsSync` cannot
// tell them apart — it answers false on ANY stat error, so an EACCES on a
// parent directory, an ELOOP, or an unmounted volume all read as "already
// gone" and the tree is dispositioned LOST/UNPUSHED with its work intact on
// disk. `probeDirectory()` reads `statSync`'s error CODE instead: only
// ENOENT/ENOTDIR is absence; everything else is UNREADABLE and fails closed
// to SALVAGE, the same direction an unreadable status takes.
//
// ── WHAT THIS TOOL WILL NEVER DO ────────────────────────────────────────────
//
// It never removes a worktree, never passes `--force`, never `rm -rf`s
// anything, and never touches the stash. There is no flag for any of them and
// no code path that could reach one — the only writes this process performs
// are into the `--capture` directory, and that directory is required to
// resolve OUTSIDE every worktree and outside the main checkout.
//
// That "only writes" claim covers git's writes too, and it is IMPLEMENTED at
// `gitOk()`, which prepends `--no-optional-locks` to EVERY invocation — the
// one line the claim rests on, placed in the single chokepoint so a later
// call site cannot forget it. Without it `status` and `diff HEAD` refresh and
// REWRITE the index (`.git/worktrees/<name>/index`), taking `index.lock` in a
// tree that may only be PAUSED: a report-only auditor contending for the lock
// of a live lane is a hazard this repo has already hit once. The flag is the
// documented equivalent of `GIT_OPTIONAL_LOCKS=0`, and it is passed as an
// ARGUMENT rather than an env var so the guarantee is visible in the argv the
// structural fixture parses, not in an environment a caller could drop.
//
// `git stash` is excluded on purpose and not as an oversight: the stash stack
// lives in the COMMON `.git` dir and is therefore SHARED by the main checkout
// and every linked worktree, so a sibling's `git stash pop` can take an entry
// this tool created (`rules/worktree-isolation.md` Rule 9). A patch file under
// a caller-named directory is reachable by nobody else.
//
// ── SUBMODULES: WHERE THIS TOOL IS LOUD RATHER THAN COMPLETE ────────────────
//
// Capture CANNOT save submodule working-tree content. Both of its reads look
// straight past a gitlink: `git diff HEAD --binary` sees one SHA in the
// parent's tree object (EMPTY output while that SHA is unchanged, however much
// uncommitted content sits inside), and `ls-files --others` never descends
// into an index entry. Neither errors. Left alone that produced the worst
// failure this tool can have — a content-free rescue reported as
// `capture_complete: true` with "all at-risk work is SAVED — the trees may now
// be reused or removed", exit 3.
//
// The fix is NOT to narrow detection into agreement, which would trade a loud
// gap for a silent one. It is `submoduleGaps()`, on BOTH axes:
//
//   detection  a tree whose OWN status reads clean is re-checked one level
//              down, because the parent's pinned flags govern how the PARENT
//              reports a submodule and NOT the status run inside it — a
//              submodule-local `status.showUntrackedFiles=no` blinds the
//              parent completely (measured), and the tree would otherwise be
//              dispositioned LOST.
//   capture    a gitlink holding uncommitted content is NAMED into `errors`,
//              which is what already turns `capture_complete` false, prints
//              the manifest's INCOMPLETE section, and exits 2.
//
// So the contract is honest rather than complete: submodule content is never
// captured, and it is never silently declared saved. Anything unresolved —
// an unreadable gitlink, a path that is not a repository root yet holds files
// — is REPORTED; only an EMPTY placeholder (an uninitialized submodule, which
// cannot hold uncommitted content) is silent.
//
// Capture is also INDEX-FREE. `git add -N` would let one `git diff` cover
// untracked files too, and it is a MUTATION of a live worktree's index — a
// lane that is merely paused (not dead) would resume onto an index this tool
// wrote. Tracked changes are read with `git diff HEAD --binary` (under the
// `--no-optional-locks` above, so not even the stat-cache refresh is written)
// and untracked files are COPIED byte-for-byte.
//
// Capture NEVER overwrites a previous rescue. `<slug>` is derived from the
// worktree path and is therefore STABLE across runs, so two captures of the
// same forest into one directory collide BY CONSTRUCTION — and the DO block
// of the rule this tool serves says `--capture "$HOME/rescue-$(date +%F)"`,
// which makes two rescues on one day the expected case, not the exotic one.
// Every destination is created with a non-recursive `mkdirSync` (create-or-
// FAIL, never clobber) and each file lands under `flag: "wx"` /
// `COPYFILE_EXCL`; on collision the slug takes a `-2`, `-3` … suffix, which
// is the shape `orchestration-launch-ledger.md` MUST-5 already sets. A rescue
// tool whose second run destroys its first is the failure it exists to
// prevent, performed on the evidence.
//
// ── USAGE ───────────────────────────────────────────────────────────────────
//
//   node .claude/bin/worktree-triage.mjs                       # report, change nothing
//   node .claude/bin/worktree-triage.mjs --json                # machine-readable
//   node .claude/bin/worktree-triage.mjs --capture /tmp/rescue-2026-08-20
//   node .claude/bin/worktree-triage.mjs --repo /path/to/repo  # triage another forest
//   node .claude/bin/worktree-triage.mjs --help
//
// ── EXIT CODES ──────────────────────────────────────────────────────────────
//
//   0  ran; NO tree is SALVAGE (nothing is at risk of silent loss)
//   3  ran; ≥1 tree is SALVAGE — work is at risk. This is a FINDING, and it is
//      a distinct code from 1 so a caller can tell "there is work to save" from
//      "the tool could not run". Both are non-zero so neither is mistaken for
//      an all-clear.
//   1  usage error, git error, or a `--capture` target that resolves inside a
//      worktree / the main checkout (refused before any write)
//   2  `--capture` was requested and at least one SALVAGE tree was NOT fully
//      captured. A partial rescue reported as a rescue is the failure this
//      code exists to make loud.
//
// AT-RISK-UNSAVED vs AT-RISK-SAVED — the orchestrator's actual next question —
// is answered by the PAIR (was `--capture` given, and which code came back),
// and 2 SUBSUMES 3 rather than masking it: capture only ever runs on a SALVAGE
// tree, so exit 2 already implies the finding 3 reports.
//
//   3 without --capture   work is at risk and NOTHING has been saved
//   3 with    --capture   work is at risk and EVERY at-risk tree was captured
//   2 (always with)       work is at risk and at least one capture FAILED
//
// The middle row is a guarantee, not a hope: a SALVAGE tree that cannot be
// captured — including one whose directory is UNREADABLE — records a capture
// error rather than being skipped in silence, so it downgrades the run to 2.
// `--json` states the same thing directly as `capture_complete`, and the human
// report prints a `captured N/M` line, so neither reader has to infer it from
// an exit code.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as FS,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

// The RECOVERY axis — what a dead lane left behind. SUBORDINATE to `verdict`
// below, and reported as `recoverability` in every record.
const SALVAGE = "SALVAGE";
const PUSHED = "PUSHED";
const UNPUSHED = "UNPUSHED";
const LOST = "LOST";

// ── THE SHARED REMOVAL-SAFETY VOCABULARY ────────────────────────────────────
//
// ONE question — "is this tree safe to remove?" — gets ONE word, and it is the
// word `.claude/bin/worktree-reap.mjs` and `.claude/hooks/lib/wip-lanes.js`
// already use. Before 2026-08-22 this file emitted its four RECOVERY classes
// under the field name `verdict`, which is the same field name the reaper emits
// ZERO-LOSS/TAG-FIRST/KEEP into: two vocabularies, one field, one question, and
// an operator reading both reports had no way to reconcile them. Two answers to
// one question teach an operator to trust neither.
//
// The fix is a DEMOTION, not a deletion: nothing this tool could distinguish
// before it can no longer distinguish. The four classes keep every reason
// string, every fail-closed direction, and every exit code they had — they now
// travel under `recoverability`, which is what they always were.
//
//   ZERO-LOSS  nothing is lost by removing the directory.
//   KEEP       holds work, or the question could not be answered.
//
// The mapping is FAIL-CLOSED and agrees with the reaper on every case it can
// reach: SALVAGE (uncommitted work, no reflog) and UNPUSHED (the local ref is
// the only copy, including the commit-state-unknown arm) are KEEP; PUSHED
// (reachable from a remote) and LOST (clean, no commits of its own) are
// ZERO-LOSS. Where the reaper would say TAG-FIRST — clean, detached, and
// reachable from NO ref — this tool says KEEP, which is the conservative
// direction and costs nothing: this tool removes no tree and never will
// (§ WHAT THIS TOOL WILL NEVER DO), so KEEP here is a report, not an inaction.
// TAG-FIRST is deliberately NOT minted here, because minting a verdict this
// tool cannot act on would re-open the divergence this consolidation closes.
const ZERO_LOSS = "ZERO-LOSS";
const KEEP = "KEEP";

/** Stamp the shared removal-safety verdict onto a classified record. */
function withSharedVerdict(rec) {
  rec.verdict =
    rec.recoverability === SALVAGE || rec.recoverability === UNPUSHED ? KEEP : ZERO_LOSS;
  return rec;
}

// ── git plumbing ────────────────────────────────────────────────────────────

/**
 * Run git READ-ONLY and never take an optional lock.
 *
 * `--no-optional-locks` is prepended HERE, at the single chokepoint every git
 * call in this file goes through, because it is the implementing line for the
 * header's "the only writes this process performs are into the `--capture`
 * directory". Without it `status` / `diff HEAD` rewrite the worktree's index
 * and contend for `index.lock` with a lane that may only be paused. It is a
 * TOP-LEVEL git option, so it must precede `-C` and the subcommand.
 */
function gitOk(args, opts = {}) {
  try {
    const out = execFileSync("git", ["--no-optional-locks", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
      ...opts,
    });
    return { ok: true, out };
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout || "").toString(),
      err: ((e.stderr || "").toString() || e.message || "git failed").toString().trim().split("\n")[0],
    };
  }
}

/**
 * Parse `git worktree list --porcelain`. Records are blank-line separated;
 * `bare` / `detached` / `locked` / `prunable` are VALUELESS flag keys, so a
 * naive `split(" ")` into {key, value} yields `true` for them by design.
 */
function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const raw of porcelain.split("\n")) {
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
 * Parse `git status --porcelain -z` into entries.
 *
 * NUL-separated so a filename containing a newline, a quote, or a space cannot
 * split one entry into two — the count feeds a work-at-risk verdict, and an
 * inflated or deflated count is a wrong verdict. Rename/copy entries (`R`/`C`
 * in either status column) are followed by a SECOND NUL-terminated field
 * carrying the ORIGIN path; that field is consumed here so it is not counted
 * as an entry of its own.
 */
function parseStatusZ(buf) {
  const toks = buf.split("\0");
  const entries = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    const xy = t.slice(0, 2);
    const path = t.slice(3);
    entries.push({ xy, path });
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") i += 1; // origin path
  }
  return entries;
}

// ── capture-target containment ──────────────────────────────────────────────

/** Raised when a path cannot be resolved to a real form. Fails the run closed. */
class ResolveError extends Error {}

/**
 * Resolve a path to its real form.
 *
 * Fails CLOSED. Every caller uses the result in a CONTAINMENT decision — "is
 * the capture target inside a worktree?" — and an unresolved lexical path is
 * exactly the input `security.md` § Path Containment says must never reach
 * that comparison. Returning `resolve(p)` on total failure (the prior
 * behaviour) silently downgraded the real-path test to the lexical one it
 * exists to replace, so the last resort now THROWS and the caller refuses.
 *
 * SCOPE of that last resort, stated rather than implied: the walk-up terminates
 * at an ancestor that EXISTS, and a path that stats will almost always realpath,
 * so this throw is a DEFENSIVE guard for the residue (EIO, ENAMETOOLONG) — not a
 * routine branch. It is deliberately NOT claimed to be fixture-covered; the
 * fixtures cover the REFUSAL a caller actually observes. An unusable target is
 * refused either way, and this closes the one direction that would have compared
 * a lexical path instead.
 */
function realOrResolve(p) {
  try {
    return realpathSync(p);
  } catch {
    // Walk up to the nearest existing ancestor and re-join, so a not-yet-created
    // capture dir under a SYMLINKED prefix still compares against real paths.
    let cur = resolve(p);
    const tail = [];
    while (!existsSync(cur) && dirname(cur) !== cur) {
      tail.unshift(basename(cur));
      cur = dirname(cur);
    }
    try {
      return join(realpathSync(cur), ...tail);
    } catch (e) {
      throw new ResolveError(`cannot resolve ${p} to a real path (${e.code || e.message}) — refusing rather than comparing a lexical path`);
    }
  }
}

/**
 * Distinguish an ABSENT directory from an UNREADABLE one.
 *
 * `existsSync` collapses both to false, and the two have OPPOSITE dispositions
 * here: absent means the uncommitted work is already gone (nothing to capture),
 * unreadable means it may be sitting there intact behind an EACCES parent, a
 * symlink loop, or an unmounted volume. Only the error CODE separates them.
 */
function probeDirectory(p) {
  try {
    return statSync(p).isDirectory() ? { state: "present" } : { state: "unreadable", err: "path exists but is not a directory" };
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return { state: "absent" };
    return { state: "unreadable", err: (e && (e.code || e.message)) || "stat failed" };
  }
}

/**
 * True when `child` is `parent` or lies beneath it, compared on RESOLVED paths
 * with a trailing separator.
 *
 * The separator is what stops `/tmp/rescue-x` from reading as inside
 * `/tmp/rescue` — a prefix test without it is the classic containment bypass
 * (`rules/security.md` § Path Containment).
 */
function isInside(child, parent) {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

// ── classification ──────────────────────────────────────────────────────────

/**
 * Classify one worktree.
 *
 * `baseRef` is the default remote ref (e.g. `origin/main`) used to answer "does
 * this tree carry commits of its OWN?". It may be null on a repo with no
 * remote, in which case the ahead-count falls back to "commits not reachable
 * from any remote", which on a remote-less repo is every commit — reported as
 * such rather than silently as zero.
 */
function classify(wt, ctx) {
  const path = wt.path;
  const branch = wt.branch ? wt.branch.replace(/^refs\/heads\//, "") : null;
  const sha = wt.HEAD || null;
  const reasons = [];
  const dir = probeDirectory(path);
  const rec = {
    path,
    branch,
    sha,
    is_main: path === ctx.mainTop,
    detached: Boolean(wt.detached),
    locked: Boolean(wt.locked),
    // true present · false genuinely absent · null present-or-not, UNREADABLE
    directory_present: dir.state === "present" ? true : dir.state === "absent" ? false : null,
    directory_state: dir.state,
    dirty_count: null,
    dirty_paths: [],
    // Uncommitted work the PARENT's status cannot see, one level down. Only
    // computed for a tree whose own status came back clean — see the probe at
    // the foot of the working-tree axis.
    submodule_gaps: [],
    unpushed: null,
    ahead: null,
    // The SHARED removal-safety word (ZERO-LOSS / KEEP), stamped by
    // `withSharedVerdict()` at the single seam below — never assigned in this
    // function, so there is exactly one place it can be derived.
    verdict: null,
    // The RECOVERY axis (SALVAGE / PUSHED / UNPUSHED / LOST) — subordinate to
    // `verdict`, and the finer question this tool exists to answer.
    recoverability: null,
    reasons,
  };

  // ── the working-tree axis ──
  if (dir.state === "absent") {
    reasons.push("directory absent — anything uncommitted here is already gone");
    rec.dirty_count = 0;
  } else if (dir.state === "unreadable") {
    // NOT the same as absent. See § FAIL-CLOSED above: the work may be intact
    // behind the error, and only one of the two directions preserves it.
    reasons.push(`directory unreadable (${dir.err}) — cannot tell absent from intact, failing closed to ${SALVAGE}`);
    rec.recoverability =SALVAGE;
    rec.dirty_count = null;
    return rec;
  } else {
    const st = gitOk([
      "-C",
      path,
      "status",
      // Every flag here is PINNED against inherited config. See § the four
      // classes: an unpinned `--porcelain` lets git change format versions
      // under a parser hardcoded to v1, and unpinned untracked/submodule
      // handling lets a repo-local config blank the very entries that make
      // this tree SALVAGE — git exits 0 and the lane's work reads as LOST.
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    if (!st.ok) {
      // Unreadable is NOT clean. See § FAIL-CLOSED above.
      reasons.push(`status unreadable — failing closed to ${SALVAGE} (${st.err})`);
      rec.recoverability =SALVAGE;
      rec.dirty_count = null;
      return rec;
    }
    const entries = parseStatusZ(st.out);
    rec.dirty_count = entries.length;
    rec.dirty_paths = entries.map((e) => `${e.xy} ${e.path}`);

    // A CLEAN read is not yet a clean tree when a gitlink is present.
    //
    // Pinning the flags above governs how the PARENT reports a submodule; it
    // does NOT govern the status run INSIDE it, and a submodule carries its
    // own config. MEASURED: with `status.showUntrackedFiles=no` set in the
    // submodule, this exact invocation — `--ignore-submodules=none
    // --untracked-files=all` and all — exits 0 with EMPTY output over a
    // submodule holding untracked work. The parent goes blind, `dirty_count`
    // reads 0, and the tree is classified LOST, "nothing recoverable here",
    // one step before it is reused. `--ignore-submodules=none` cannot reach
    // this: it re-enables the parent's REPORTING of a submodule whose own
    // status already came back empty.
    //
    // So a tree that reads clean is re-checked one level down, by the probe
    // that pins ITS own flags. Only on a clean tree: a dirty tree is already
    // SALVAGE, and the same gaps are named again at capture time. The cost is
    // one `ls-files --stage` per clean tree (42ms over 6,895 index entries,
    // measured) and it is paid once, after a fleet has already died.
    if (entries.length === 0) rec.submodule_gaps = submoduleGaps(path);
  }

  // ── the commit axis (evaluated for every tree, SALVAGE included) ──
  if (sha) {
    const ref = branch || sha;
    const up = gitOk(["-C", ctx.repoDir, "rev-list", "--count", ref, "--not", "--remotes"]);
    if (up.ok) rec.unpushed = Number(up.out.trim());
    else reasons.push(`unpushed-commit count unreadable (${up.err}) — reported as unknown, not zero`);

    if (ctx.baseRef) {
      const ah = gitOk(["-C", ctx.repoDir, "rev-list", "--count", `${ctx.baseRef}..${ref}`]);
      if (ah.ok) rec.ahead = Number(ah.out.trim());
      else reasons.push(`ahead-count vs ${ctx.baseRef} unreadable (${ah.err}) — reported as unknown, not zero`);
    } else {
      // No remote at all: every commit is "its own" and none is pushed.
      rec.ahead = rec.unpushed;
      reasons.push("no remote-tracking ref in this repo — ahead-count falls back to the unpushed count");
    }
  }

  // ── verdict ──
  if (rec.dirty_count === null || rec.dirty_count > 0) {
    rec.recoverability =SALVAGE;
    reasons.unshift(
      `${rec.dirty_count} uncommitted path(s) — unstaged and untracked-not-ignored work has NO reflog`,
    );
    return rec;
  }

  // SALVAGE with `dirty_count` 0 is not a contradiction — it is the whole
  // point of this arm: the count is what the PARENT could see, and this is
  // work it could not. Ordered after the dirty check so a tree that is dirty
  // on both axes keeps its primary reason, and before the commit axis's
  // verdicts so no submodule-held work is ever dispositioned PUSHED or LOST.
  if (rec.submodule_gaps.length > 0) {
    rec.recoverability =SALVAGE;
    reasons.unshift(
      "the tree's own status reads CLEAN but a submodule holds uncommitted work — a submodule's own config can blank it in the parent's status",
    );
    for (const g of rec.submodule_gaps) reasons.push(g);
    return rec;
  }

  if (rec.unpushed === null) {
    // Commit state unknown on a clean tree. Cannot claim LOST (that asserts
    // nothing is recoverable) and cannot claim PUSHED. UNPUSHED is the
    // fail-closed answer: it says "the only copy may be local", which is the
    // disposition that preserves the ref.
    rec.recoverability =UNPUSHED;
    reasons.push("commit state unknown — failing closed to UNPUSHED (preserve the ref)");
    return rec;
  }

  if (rec.unpushed > 0) {
    rec.recoverability =UNPUSHED;
    reasons.push(`${rec.unpushed} commit(s) on no remote — ${branch ? `branch '${branch}'` : `detached SHA ${String(sha).slice(0, 12)}`} is the only copy`);
    return rec;
  }

  if ((rec.ahead ?? 0) > 0) {
    rec.recoverability =PUSHED;
    reasons.push(`${rec.ahead} commit(s) of its own, all reachable from a remote — recoverable from the remote alone`);
    return rec;
  }

  rec.recoverability =LOST;
  reasons.push("clean tree with no commits of its own — nothing recoverable here");
  return rec;
}

// ── capture ─────────────────────────────────────────────────────────────────

/** Stable per-tree capture slug: readable basename + a collision-free suffix. */
function captureSlug(path) {
  const h = createHash("sha256").update(path).digest("hex").slice(0, 8);
  const base = basename(path).replace(/[^A-Za-z0-9._-]/g, "_") || "worktree";
  return `${base}-${h}`;
}

/**
 * Allocate a FRESH destination directory, or fail.
 *
 * `mkdirSync` WITHOUT `recursive` is the create-or-fail primitive: it raises
 * EEXIST rather than silently succeeding onto a directory that already holds a
 * previous rescue. The slug is stable per worktree path, so a second capture of
 * the same forest into the same `--capture` dir lands here every time; it takes
 * `-2`, `-3` … until one is genuinely new (`orchestration-launch-ledger.md`
 * MUST-5's suffix shape). The cap is not a limit on rescues, only on how many
 * collisions are tried before the run reports it could not place this one.
 */
function allocateDest(captureDir, slug) {
  const MAX = 100;
  for (let n = 1; n <= MAX; n++) {
    const dest = join(captureDir, n === 1 ? slug : `${slug}-${n}`);
    try {
      mkdirSync(dest); // create-or-FAIL — never `recursive`, never clobber
      return { dest };
    } catch (e) {
      if (e && e.code === "EEXIST") continue;
      return { error: `mkdir ${dest}: ${e.message}` };
    }
  }
  return { error: `cannot place a rescue under ${captureDir}: ${slug} and ${MAX - 1} suffixed siblings all exist` };
}

/**
 * Report every gitlink under `treePath` whose working tree may hold
 * UNCOMMITTED content that `capture()` did not, and cannot, save.
 *
 * ── WHY THIS EXISTS: detection is submodule-AWARE, capture is submodule-BLIND ─
 *
 * `classify()` pins `--ignore-submodules=none` on purpose, so a dirty submodule
 * makes the parent tree SALVAGE. Both of capture's reads then look straight
 * past it, and NEITHER errors:
 *
 *   `git diff HEAD --binary`  a gitlink is one SHA in the parent's tree object.
 *                             With the recorded SHA unchanged the diff is
 *                             EMPTY — measured, zero bytes — however much
 *                             uncommitted content sits inside the submodule.
 *   `ls-files --others`       does not descend into a gitlink: the submodule is
 *                             an INDEX ENTRY, never an "other", so its
 *                             untracked files are never enumerated, let alone
 *                             copied.
 *
 * Left alone the chain runs: dirty submodule → `dirty_count` 1 → SALVAGE →
 * capture writes a content-free patch and copies zero files → NO error → exit
 * 3, `capture_complete: true`, and the report's "all at-risk work is SAVED —
 * the trees may now be reused or removed". A work-preservation tool
 * AFFIRMATIVELY AUTHORISING the destruction of work it never captured is the
 * exact loss it exists to prevent, and submodule working-tree content has no
 * more reflog than any other uncommitted file.
 *
 * The fix is NOT to narrow detection — that would trade a loud gap for a silent
 * one, re-classifying a genuinely at-risk tree as clean. It is to make the
 * asymmetry LOUD, through machinery that already exists: an entry here reaches
 * capture's `errors`, which is what turns `ok` false, `capture_complete` false,
 * prints the manifest's INCOMPLETE section, and exits 2. Same path the
 * unreadable-directory arm in `main()` already takes.
 *
 * ── SCOPE, STATED RATHER THAN IMPLIED ───────────────────────────────────────
 *
 * UNCOMMITTED content only. A submodule sitting at a DIFFERENT commit from the
 * one the parent records is not this class: those commits are in the
 * submodule's own object store with their own reflog, which is the tool's own
 * PUSHED/UNPUSHED axis, and `git diff HEAD` does record the moved SHA in
 * `tracked.patch`. SALVAGE is the no-reflog class, and uncommitted-versus-
 * committed is exactly that line.
 *
 * NESTED submodules need no recursion: the status probe below is itself pinned
 * `--ignore-submodules=none`, so a dirty grandchild makes its parent submodule
 * report ≥1 entry and THAT path is named. The fail-loud is transitive; only the
 * outermost gitlink is named, which is where a human starts looking.
 *
 * This function does NOT attempt to capture submodule content. An honest,
 * named, exit-2 gap is worth more than a partial recursive copy whose fidelity
 * nobody has fixtured.
 *
 * ── FAIL-CLOSED, AND WHERE ──────────────────────────────────────────────────
 *
 * "Holds no uncommitted content" and "I could not find out" produce the same
 * empty answer from a naive read (`rules/instrument-discipline.md` MUST-1), so
 * only ONE direction is safe: anything unresolved is REPORTED. An
 * UNINITIALIZED submodule genuinely cannot hold uncommitted content — git
 * leaves an EMPTY placeholder directory — so an empty directory is silent, and
 * that is the only silent non-repo arm. A directory that is not a git repo yet
 * holds entries is the uninitialized-vs-unreadable AMBIGUITY, and it is
 * reported rather than guessed.
 */
function submoduleGaps(treePath) {
  const gaps = [];

  // The INDEX defines what is a gitlink — not `.gitmodules`, which can be
  // absent, stale, or list a submodule this tree never recorded. Mode 160000
  // is the gitlink mode, and `--stage` needs no submodule to be initialized to
  // report one.
  const ls = gitOk(["-C", treePath, "ls-files", "--stage", "-z"]);
  if (!ls.ok) {
    return [
      `cannot enumerate submodules in ${treePath} (${ls.err}) — an uncaptured submodule cannot be ruled out`,
    ];
  }

  for (const entry of ls.out.split("\0")) {
    if (!entry || !entry.startsWith("160000 ")) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const rel = entry.slice(tab + 1);
    const sub = join(treePath, rel);

    // ABSENT vs UNREADABLE, the same distinction `classify()` draws: nothing
    // on disk means nothing left to lose; anything else fails closed.
    const probe = probeDirectory(sub);
    if (probe.state === "absent") continue;
    if (probe.state === "unreadable") {
      gaps.push(`submodule ${rel}: ${probe.err} — uncommitted content cannot be ruled out and was NOT captured (${sub})`);
      continue;
    }

    // Is a repository ROOTED here? `--show-toplevel`, NOT `--git-dir`.
    //
    // `git -C <path> rev-parse --git-dir` DISCOVERS UPWARD, so at an
    // uninitialized submodule's empty placeholder it exits 0 and names the
    // PARENT worktree's git dir — measured. It answers "am I inside a
    // repository?", which is a different question from "is a repository rooted
    // HERE?" (`rules/instrument-discipline.md` MUST-4), and a status probe
    // built on it would then measure the PARENT worktree and report the
    // parent's own dirty files as a phantom submodule loss on every fresh
    // worktree in a submodule repo. `--show-toplevel` discriminates: it
    // returns the LANE for a placeholder and the SUBMODULE for a real one.
    const top = gitOk(["-C", sub, "rev-parse", "--show-toplevel"]);
    let rootedHere = false;
    if (top.ok && top.out.trim()) {
      try {
        rootedHere = realOrResolve(top.out.trim()) === realOrResolve(sub);
      } catch {
        rootedHere = false; // unresolvable ⇒ fall through to the fail-closed arm
      }
    }
    if (!rootedHere) {
      let names;
      try {
        names = readdirSync(sub);
      } catch (e) {
        gaps.push(`submodule ${rel}: no repository is rooted here and the directory is unreadable (${(e && (e.code || e.message)) || "readdir failed"}) — uncommitted content cannot be ruled out and was NOT captured (${sub})`);
        continue;
      }
      // The ONLY silent arm: an uninitialized submodule is an empty
      // placeholder, and an empty directory holds nothing to rescue.
      if (names.length === 0) continue;
      gaps.push(`submodule ${rel}: not initialized as a git repository yet holds ${names.length} entr${names.length === 1 ? "y" : "ies"} — uncommitted content cannot be ruled out and was NOT captured (${sub})`);
      continue;
    }

    const st = gitOk([
      "-C",
      sub,
      "status",
      // Pinned for the same reasons `classify()` pins them, and additionally
      // because a submodule carries its OWN config: an inherited
      // `status.showUntrackedFiles=no` inside the submodule would blank the
      // very entries that make this gap real.
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    if (!st.ok) {
      gaps.push(`submodule ${rel}: status unreadable (${st.err}) — uncommitted content cannot be ruled out and was NOT captured (${sub})`);
      continue;
    }
    const n = parseStatusZ(st.out).length;
    if (n > 0) {
      gaps.push(`submodule ${rel}: ${n} uncommitted path(s) inside a submodule — NOT captured, and they have no reflog. Capture reads \`git diff HEAD\` and \`ls-files --others\`, neither of which descends into a gitlink. Rescue by hand from ${sub} before this tree is reused or removed.`);
    }
  }

  return gaps;
}

/**
 * Capture one SALVAGE tree into `<captureDir>/<slug>[-N]/`.
 *
 * Writes (each create-or-fail — a prior rescue is never overwritten):
 *   tracked.patch    `git diff HEAD --binary` — staged AND unstaged tracked
 *                    changes in one applyable patch, with no index write.
 *   untracked/<rel>  byte-for-byte copies of every untracked-not-ignored file;
 *                    symlinks are recreated AS symlinks, never dereferenced.
 *   MANIFEST.txt     source path, branch, HEAD, counts, the re-apply line, and
 *                    — when anything failed — an INCOMPLETE section naming it.
 *
 * What it does NOT write is submodule content, which neither of its two reads
 * can see. That gap is not left silent: `submoduleGaps()` names it into
 * `errors`, below.
 *
 * Returns { ok, files, errors[] }. An error here is NOT swallowed: main turns
 * any non-empty `errors` into exit 2.
 */
function capture(rec, captureDir) {
  const errors = [];
  const files = [];

  const alloc = allocateDest(captureDir, captureSlug(rec.path));
  if (alloc.error) return { ok: false, dest: null, files, errors: [alloc.error] };
  const dest = alloc.dest;

  const diff = gitOk(["-C", rec.path, "diff", "HEAD", "--binary"]);
  if (!diff.ok) {
    errors.push(`git diff HEAD in ${rec.path}: ${diff.err}`);
  } else {
    const p = join(dest, "tracked.patch");
    try {
      writeFileSync(p, diff.out, { flag: "wx" }); // create-or-fail; never clobber a prior rescue
      files.push(p);
    } catch (e) {
      errors.push(`write ${p}: ${e.message}`);
    }
  }

  const untrackedList = [];
  const uo = gitOk(["-C", rec.path, "ls-files", "--others", "--exclude-standard", "-z"]);
  if (!uo.ok) {
    errors.push(`git ls-files --others in ${rec.path}: ${uo.err}`);
  } else {
    for (const rel of uo.out.split("\0").filter(Boolean)) {
      const src = join(rec.path, rel);
      const dst = join(dest, "untracked", rel);
      try {
        mkdirSync(dirname(dst), { recursive: true });
        // lstat, NOT stat: a symlink must be captured AS a symlink. `stat`
        // follows it, so a symlink→dir was previously `continue`d — dropped
        // from the rescue with no error, absent from the MANIFEST, and the run
        // still exited 3 as though everything had been saved — while a
        // symlink→file was silently DEREFERENCED, so the restore produced a
        // regular file where the lane had a link. Both are fidelity losses in
        // a tool whose whole product is a faithful copy.
        const st = lstatSync(src);
        if (st.isSymbolicLink()) {
          symlinkSync(readlinkSync(src), dst); // fails EEXIST — never clobbers
          files.push(dst);
          untrackedList.push(`${rel} -> ${readlinkSync(src)}`);
        } else if (st.isDirectory()) {
          // `ls-files --others` without `--directory` lists FILES, so this is
          // unreachable in normal operation. If it ever fires it is a real gap
          // in the rescue, so it is reported rather than skipped in silence.
          errors.push(`skip ${src}: untracked entry is a directory, not captured`);
        } else if (!st.isFile()) {
          errors.push(`skip ${src}: not a regular file (${st.mode.toString(8)}), not captured`);
        } else {
          copyFileSync(src, dst, FS.COPYFILE_EXCL); // create-or-fail; never clobber
          files.push(dst);
          untrackedList.push(rel);
        }
      } catch (e) {
        errors.push(`copy ${src}: ${e.message}`);
      }
    }
  }

  // Neither read above descends into a gitlink, so a dirty submodule would
  // otherwise leave this function with an EMPTY `errors` and let the run
  // report "all at-risk work is SAVED". Named here, it reaches the same
  // INCOMPLETE manifest / `capture_complete: false` / exit-2 path every other
  // capture failure takes.
  for (const gap of submoduleGaps(rec.path)) errors.push(gap);

  const manifest = [
    `source_worktree: ${rec.path}`,
    `branch: ${rec.branch || "(detached)"}`,
    `head: ${rec.sha || "(unknown)"}`,
    `captured_at: ${new Date().toISOString()}`,
    `uncommitted_paths: ${rec.dirty_count === null ? "unknown" : rec.dirty_count}`,
    `untracked_files_copied: ${untrackedList.length}`,
    "",
    "re-apply (from a checkout at the same HEAD):",
    `  git apply "${join(dest, "tracked.patch")}"`,
    `  cp -R "${join(dest, "untracked")}/." .`,
    "",
    "untracked files copied:",
    ...untrackedList.map((r) => `  ${r}`),
    "",
    // A partial rescue MUST say so on its own face. The exit code reaches the
    // caller once; this file is what a human reads days later, and a manifest
    // that lists only what succeeded reads exactly like a complete rescue.
    ...(errors.length
      ? ["INCOMPLETE — this rescue is PARTIAL. The following did not land:", ...errors.map((e) => `  ${e}`), ""]
      : []),
  ].join("\n");
  const mp = join(dest, "MANIFEST.txt");
  try {
    writeFileSync(mp, manifest, { flag: "wx" }); // create-or-fail; never clobber a prior rescue
    files.push(mp);
  } catch (e) {
    errors.push(`write ${mp}: ${e.message}`);
  }

  return { ok: errors.length === 0, dest, files, errors };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `usage: worktree-triage.mjs [--repo <path>] [--json] [--capture <dir>]

Classify every worktree in the forest. Each record carries the SHARED
removal-safety verdict (ZERO-LOSS / KEEP — the same vocabulary
worktree-reap.mjs reports) plus the recoverability class
(SALVAGE / PUSHED / UNPUSHED / LOST).
Read-only unless --capture is given, and even then writes ONLY under <dir>.

  --repo <path>     repository to triage (default: cwd)
  --json            machine-readable output
  --capture <dir>   capture every SALVAGE tree's uncommitted work into <dir>.
                    <dir> MUST resolve outside every worktree and outside the
                    main checkout; a target inside one is refused (exit 1).
  --help

exit: 0 no SALVAGE  ·  3 ≥1 SALVAGE  ·  1 usage/git/containment/resolve error
      2 --capture requested and ≥1 SALVAGE tree was NOT fully captured

  3 WITHOUT --capture  work is at risk and nothing has been saved
  3 WITH    --capture  work is at risk and every at-risk tree WAS captured
  2                    work is at risk and a capture FAILED (2 subsumes 3)
`;

function parseArgs(argv) {
  const out = { repo: process.cwd(), json: false, captureDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") out.repo = argv[++i];
    else if (a === "--capture") out.captureDir = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else {
      process.stderr.write(`worktree-triage: unknown argument: ${a}\n${USAGE}`);
      process.exit(1);
    }
  }
  if (out.repo === undefined || out.captureDir === undefined) {
    process.stderr.write(`worktree-triage: flag is missing its value\n${USAGE}`);
    process.exit(1);
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`worktree-triage: ${msg}\n`);
  process.exit(1);
}

/** Resolve or refuse — `realOrResolve` fails closed, and so does the run. */
function resolveOrFail(p, what) {
  try {
    return realOrResolve(p);
  } catch (e) {
    fail(`${what}: ${e.message}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const repoDir = resolveOrFail(args.repo, "--repo");
  const common = gitOk(["-C", repoDir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) fail(`not a git repository: ${repoDir} (${common.err})`);
  const gitCommonDir = common.out.trim();
  const mainTop = resolveOrFail(dirname(gitCommonDir), "main checkout");

  const wtRes = gitOk(["-C", repoDir, "worktree", "list", "--porcelain"]);
  if (!wtRes.ok) fail(`git worktree list failed: ${wtRes.err}`);
  const worktrees = parseWorktrees(wtRes.out);
  if (worktrees.length === 0) fail("git worktree list returned no records");

  // Default remote ref for the ahead-count. `origin/HEAD` when it is set,
  // otherwise the first remote-tracking head, otherwise null.
  let baseRef = null;
  const symref = gitOk(["-C", repoDir, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (symref.ok && symref.out.trim()) {
    baseRef = symref.out.trim().replace(/^refs\/remotes\//, "");
  } else {
    const heads = gitOk(["-C", repoDir, "for-each-ref", "--format=%(refname:short)", "refs/remotes/"]);
    const first = heads.ok ? heads.out.split("\n").map((s) => s.trim()).filter(Boolean)[0] : null;
    if (first) baseRef = first;
  }

  const ctx = { repoDir, mainTop, baseRef };
  const records = worktrees.map((wt) => withSharedVerdict(classify(wt, ctx)));

  // ── capture (only after every tree is classified) ──
  let captureDir = null;
  let captureFailed = false;
  let captureComplete = null;
  if (args.captureDir) {
    captureDir = resolveOrFail(args.captureDir, "--capture target");
    const forbidden = [mainTop, ...worktrees.map((w) => resolveOrFail(w.path, `worktree ${w.path}`))];
    for (const f of forbidden) {
      if (isInside(captureDir, f)) {
        fail(
          `--capture target ${captureDir} resolves INSIDE ${f}. A rescue written into the tree it is rescuing is destroyed by the same reuse it exists to survive. Refused before any write.`,
        );
      }
    }
    try {
      mkdirSync(captureDir, { recursive: true });
    } catch (e) {
      fail(`cannot create --capture dir ${captureDir}: ${e.message}`);
    }
    for (const rec of records) {
      if (rec.recoverability !== SALVAGE) continue;
      if (rec.directory_present !== true) {
        // A SALVAGE tree we cannot even open is NOT a tree we may pass over in
        // silence: skipping it here is what would let exit 3 claim "every
        // at-risk tree was captured" while one was never attempted.
        rec.capture = {
          dest: null,
          files: 0,
          errors: [`not captured: directory ${rec.directory_state} (${rec.path}) — work may be intact and is UNSAVED`],
        };
        captureFailed = true;
        continue;
      }
      const r = capture(rec, captureDir);
      rec.capture = { dest: r.dest, files: r.files.length, errors: r.errors };
      if (!r.ok) captureFailed = true;
    }
    captureComplete = !captureFailed;
  }

  const counts = { SALVAGE: 0, PUSHED: 0, UNPUSHED: 0, LOST: 0 };
  for (const r of records) counts[r.recoverability] += 1;
  const salvageCount = counts[SALVAGE];
  // The shared removal-safety tally, reported ALONGSIDE the recovery classes so
  // a reader comparing this report with `worktree-reap.mjs --json` is comparing
  // the same word. Derived from `recoverability`, never measured separately —
  // a second measurement is how the two vocabularies diverged in the first place.
  const verdicts = {
    "ZERO-LOSS": records.filter((r) => r.verdict === ZERO_LOSS).length,
    KEEP: records.filter((r) => r.verdict === KEEP).length,
  };

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          repo: repoDir,
          main_checkout: mainTop,
          base_ref: baseRef,
          capture_dir: captureDir,
          // null when --capture was not given; otherwise the direct answer to
          // "is every at-risk tree saved?", so no caller has to infer it from
          // the exit code.
          capture_complete: captureComplete,
          // The scope the exit code ranges over, stated as a FIELD so a JSON consumer
          // need not infer it from prose it never sees. A per-tree verdict lives on that
          // tree's record in `worktrees`; the exit status is a property of the forest.
          exit_scope: "forest",
          counts,
          verdicts,
          worktrees: records,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    const lines = [];
    lines.push(`worktree triage — ${records.length} tree(s) in ${repoDir}`);
    lines.push(`base ref: ${baseRef || "(none — no remote-tracking ref)"}`);
    lines.push("");
    // SALVAGE first and unconditionally: it is the only class with a deadline.
    for (const cls of [SALVAGE, UNPUSHED, PUSHED, LOST]) {
      const group = records.filter((r) => r.recoverability === cls);
      if (group.length === 0) continue;
      lines.push(`${cls} (${group.length})`);
      for (const r of group) {
        // The SHARED word first, the recovery class second — same order, same
        // spelling as `worktree-reap.mjs`, so the two reports collate.
        lines.push(`  ${r.verdict} · ${cls} ${r.path}${r.is_main ? "  [MAIN CHECKOUT]" : ""}`);
        lines.push(`    branch: ${r.branch || `(detached ${String(r.sha || "").slice(0, 12)})`}`);
        for (const why of r.reasons) lines.push(`    - ${why}`);
        if (r.capture) {
          lines.push(`    captured → ${r.capture.dest} (${r.capture.files} file(s))`);
          for (const e of r.capture.errors) lines.push(`    CAPTURE ERROR: ${e}`);
        }
      }
      lines.push("");
    }
    lines.push(
      `summary: ${verdicts.KEEP} KEEP · ${verdicts["ZERO-LOSS"]} ZERO-LOSS   (removal safety — same vocabulary as worktree-reap.mjs)`,
    );
    lines.push(
      `         ${counts.SALVAGE} SALVAGE · ${counts.UNPUSHED} UNPUSHED · ${counts.PUSHED} PUSHED · ${counts.LOST} LOST   (recoverability)`,
    );
    // The exit code is FOREST-WIDE and is not a verdict on any one tree. Said in the
    // REPORT, not only in --help: a lane that reads the code alone and concludes its OWN
    // work is at risk starts committing defensively, and exit 3 here genuinely means
    // "work is at risk" — just not necessarily YOURS. A lane's verdict is the per-lane
    // WORD on its own row and the summary LINE; it is never the process exit status.
    lines.push(
      `exit ${salvageCount > 0 ? 3 : 0} ranges over ALL ${records.length} tree(s) in this forest — ` +
        `it is NOT a verdict on any one tree. Your tree's verdict is the WORD on its own row above.`,
    );
    if (salvageCount > 0 && !captureDir) {
      lines.push(
        `ACTION: ${salvageCount} tree(s) hold uncommitted work with no reflog. Capture before any tree is reused or removed:`,
      );
      lines.push(`  node .claude/bin/worktree-triage.mjs --capture <dir-outside-the-forest>`);
    }
    if (captureDir) {
      // AT-RISK-SAVED vs AT-RISK-UNSAVED, stated rather than left to the exit code.
      const saved = records.filter((r) => r.capture && r.capture.errors.length === 0).length;
      lines.push(`captured ${saved}/${salvageCount} at-risk tree(s) → ${captureDir}`);
      lines.push(
        captureComplete
          ? "all at-risk work is SAVED — the trees may now be reused or removed"
          : "INCOMPLETE — at least one at-risk tree is UNSAVED; do NOT reuse or remove any tree yet",
      );
    }
    process.stdout.write(lines.join("\n") + "\n");
  }

  if (captureFailed) process.exit(2);
  process.exit(salvageCount > 0 ? 3 : 0);
}

main();
