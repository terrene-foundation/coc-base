#!/usr/bin/env node
// worktree-reap.mjs — classify the git worktree forest by RECOVERABILITY and
// reap only the trees whose removal cannot lose work.
//
// The teardown counterpart to `/worktree` + `rules/worktree-isolation.md`
// Rule 8. Worktree CREATION is governed (Rules 1/5/6/7); before Rule 8 nothing
// carried a teardown obligation, so every parallel wave left its trees behind
// until the operator ran out of disk.
//
// SAFETY MODEL — two orthogonal axes, both must clear before a tree is reaped:
//
//   (1) DURABILITY — do the commits survive `git worktree remove`?
//       `remove` deletes the DIRECTORY, never the branch ref. So commits on a
//       named branch survive; a detached HEAD unreachable from any ref does not.
//   (2) OCCUPANCY — is someone working in this tree right now?
//       A tree can be perfectly durable AND still be a live session's floor.
//       Reaping it loses no commits but yanks the ground out from under it.
//
// Conflating these is the trap: "clean + all commits pushed" is durable but
// says NOTHING about occupancy. Both gates are evaluated independently.
//
// Default is REPORT-ONLY. `--apply` performs removals. `--force` is NOT
// implemented and never will be: a bare `git worktree remove` already REFUSES a
// dirty tree, and that loud refusal is the desired behavior, not an obstacle.
// Checking `git status` and then passing `--force` is the check-then-clobber
// TOCTOU that `worktree-orchestration.md` Rule 11's BLOCKED corpus names —
// the state can change between the check and the removal.
//
// SIZE is reported alongside the verdicts, because the verdict counts do not
// predict the failure this tool exists to prevent: a forest of thirty KEEP trees
// and a forest of thirty KEEP trees at 60 MB each are the same report and
// different amounts of remaining disk. Cost is measured, not assumed — see
// § disk usage below.
//
// SCOPE — `--only <path|name>` narrows which trees may be ACTED ON, so a wave
// that has just collected a lane's report and pushed its branch can reap that
// lane's tree at delivery, without touching a tree it does not own. Selection
// picks CANDIDATES, never OUTCOMES: a selected tree still runs the full verdict
// pipeline and a KEEP verdict still holds it. An `--only` that forced removal
// would be the `--force` this tool refuses, wearing a new name.
//
// Why the feature exists: the 12h default age floor is LONGER than the session
// that creates the trees, so same-day growth is invisible to it by construction.
// Measured at the moment a seven-lane wave had all delivered and pushed:
// `zero-loss: 0  tag-first: 0  keep: 25`, every tree held by
// `active 0.2h ago (< --min-age-hours 12)`; at `--min-age-hours 0`, 19 of the 25
// became ZERO-LOSS on real evidence. The floor is NOT lowered, because it guards
// a case no evidence here can see — ANOTHER LIVE SESSION'S worktree (the
// `is THIS session's own worktree` guard covers only this one). `--only` is the
// narrow instrument: the operator supplies the occupancy knowledge for ONE tree.
//
// Usage:
//   node .claude/bin/worktree-reap.mjs                  # classify, report, change nothing
//   node .claude/bin/worktree-reap.mjs --json           # machine-readable (for /sweep Sweep 6)
//   node .claude/bin/worktree-reap.mjs --apply          # reap ZERO-LOSS + TAG-FIRST trees
//   node .claude/bin/worktree-reap.mjs --apply --zero-loss-only
//   node .claude/bin/worktree-reap.mjs --min-age-hours 0
//   node .claude/bin/worktree-reap.mjs --only lane-a --only lane-b --apply
//   node .claude/bin/worktree-reap.mjs --no-size        # skip the disk-usage pass
//   node .claude/bin/worktree-reap.mjs --help
//
// Env: WORKTREE_REAP_DU overrides the `du` binary. Two real uses — pointing at a
// POSIX du on a host whose default is not one, and exercising the unmeasurable
// path in the suite (a degrade path that is never taken is a degrade path that
// was never verified).
//
// Exit codes: 0 = ran (findings are data, not failure); 1 = usage/git error,
//             INCLUDING an `--only` selector that matched nothing or matched
//             ambiguously (a selection that silently no-ops and reports success
//             is indistinguishable from a clean forest — it could not
//             discriminate the two, so it fails loud instead);
//             2 = --apply attempted a removal git REFUSED (loud, per above).

import { execFileSync } from "node:child_process";
import { statSync, existsSync, realpathSync } from "node:fs";
// Namespace import ONLY for statfsSync, which landed in node 18.15. A named
// import of a symbol the runtime lacks is a link-time SyntaxError that takes the
// whole reaper down — including the classification an old runtime could still
// have performed correctly. Reached through the namespace it is a runtime
// `undefined` this file degrades on, which is the honest failure for a number
// that is decoration on top of the verdicts, not part of them.
import * as fsmod from "node:fs";
import { join, basename, resolve } from "node:path";

const DEFAULT_MIN_AGE_HOURS = 12;
const DU_BIN = process.env.WORKTREE_REAP_DU || "du";

// ── git plumbing ────────────────────────────────────────────────────────────

function git(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", opts.quiet ? "ignore" : "pipe"],
    ...opts,
  }).trim();
}

function gitOk(args, opts = {}) {
  try {
    return { ok: true, out: git(args, { quiet: true, ...opts }) };
  } catch (e) {
    return { ok: false, out: "", err: (e.stderr || e.message || "").toString().trim() };
  }
}

/**
 * Parse `git worktree list --porcelain` into records.
 * Records are separated by blank lines; keys are space-delimited, and the
 * `bare` / `detached` / `locked` / `prunable` keys are VALUELESS flags.
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

// ── selection (--only) ──────────────────────────────────────────────────────

/**
 * Resolve `--only` selectors against the parsed forest.
 *
 * MATCH ORDER, and it is total — there is no third fallback and no fuzzy tier:
 *   1. PATH. The selector is put through `realpathSync` (falling back to
 *      `resolve` when the directory is already gone, e.g. a prunable tree) and
 *      compared for EQUALITY against the worktree path. `git worktree list`
 *      reports resolved absolute paths, so a raw comparison would miss on any
 *      symlinked prefix — /var → /private/var on macOS being the everyday case.
 *   2. BASENAME, only if the path match found nothing. This is the ergonomic
 *      form (`--only lane-a`); it is second because a path is unambiguous by
 *      construction and a basename is not.
 *
 * Both failure modes are ERRORS, never a quiet skip:
 *   NO MATCH   — a typo that silently matched nothing, then reported a clean
 *                run, is a non-discriminating instrument: "your selector was
 *                wrong" and "that tree was already reaped" print identically.
 *   AMBIGUOUS  — two trees sharing a basename must not be resolved by
 *                first-wins. The candidates are listed so the operator can
 *                re-issue with a full path.
 *
 * Errors are collected across ALL selectors and returned together, so an
 * operator naming four lanes with two typos learns both in one run rather than
 * one per re-run. ANY error aborts the whole run (see main) — fail-closed: a
 * partial selection is not a selection the operator asked for.
 */
function resolveSelectors(selectors, worktrees) {
  const chosen = new Set();
  const errors = [];
  for (const sel of selectors) {
    const trimmed = sel.replace(/\/+$/, "");
    let asPath;
    try {
      asPath = realpathSync(trimmed);
    } catch {
      asPath = resolve(trimmed);
    }
    const base = basename(trimmed);

    let hits = worktrees.filter((w) => w.path === asPath);
    if (hits.length === 0) hits = worktrees.filter((w) => basename(w.path) === base);

    if (hits.length === 0) {
      errors.push(`--only '${sel}': no worktree matches (tried path '${asPath}', then basename '${base}')`);
    } else if (hits.length > 1) {
      errors.push(`--only '${sel}': ambiguous — ${hits.length} worktrees share the basename '${base}':\n` + hits.map((w) => `    ${w.path}`).join("\n") + "\n  Re-run with a full path.");
    } else {
      chosen.add(hits[0].path);
    }
  }
  return { chosen, errors };
}

// ── activity (the occupancy proxy) ──────────────────────────────────────────

/**
 * Hours since the tree was last touched. Uses the NEWEST of the worktree root
 * dir mtime and its per-worktree git `index` mtime — the index moves on any
 * git operation, which the root dir mtime alone can miss (a write deep in the
 * tree does not bump the root). Returns null when neither can be stat'ed.
 *
 * CLAMPED AT ZERO, and that clamp is load-bearing, not cosmetic. The two clocks
 * being subtracted have DIFFERENT resolutions: `statSync().mtimeMs` is a float
 * carrying sub-millisecond precision, while `Date.now()` is an integer
 * millisecond (floored). A tree touched at 1000.7ms read back at 1000ms yields
 * age = -0.7ms — NEGATIVE — and every negative age is unconditionally `<` any
 * floor, so `--min-age-hours 0` (age floor explicitly waived) silently held
 * trees ~50% of the time depending on where the sub-millisecond fraction landed.
 * A clock skew that puts an mtime in the FUTURE lands here too; the clamp reads
 * it as "touched now" (age 0), which every floor > 0 still holds, so the
 * fail-safe direction is preserved for every case except the waived floor.
 */
function hoursSinceActivity(wtPath, gitCommonDir) {
  const stamps = [];
  for (const p of [wtPath, join(gitCommonDir, "worktrees", basename(wtPath), "index")]) {
    try {
      stamps.push(statSync(p).mtimeMs);
    } catch {
      /* absent — not an error, just one fewer signal */
    }
  }
  if (stamps.length === 0) return null;
  return Math.max(0, (Date.now() - Math.max(...stamps)) / 3_600_000);
}

// ── disk usage ──────────────────────────────────────────────────────────────
//
// COST, measured on this operator's forest (30 trees, ~5,800 files each, APFS,
// node v25.9.0) rather than estimated. Baseline reaper: 4.48 / 3.14 / 3.22 s.
// One `du -s -k` per tree: 3.39 s cold, then 1.96 / 1.78 / 1.85 s warm. A single
// `du` invocation over all thirty paths at once measured 1.77 / 1.73 s — the
// fork cost is noise next to the filesystem walk, so the per-tree form is used
// for the property it buys: a per-tree exit code, which is what makes ONE
// unreadable tree report as unknown instead of poisoning the whole total.
//
// So sizing roughly doubles a ~3 s report to ~5 s. Default-ON at that price,
// with `--no-size` to opt out — the inverse default would satisfy the letter of
// "the reaper can report size" while leaving every actual sweep sizeless, which
// is the silent-no-op default `rules/security.md` § Secure-Default names.
//
// PORTABILITY: `du -s -k` is POSIX (XCU) — both BSD/macOS and GNU/Linux du
// implement `-s` and `-k`, and both print `<kbytes>\t<path>`. No GNU-only flag
// (`--apparent-size`, `-b`, `-c`) is used. On a host with no du at all the
// execFileSync throws and every tree reports unknown; the verdicts are
// unaffected. NOT measured on Linux in this session — the portability claim
// rests on the POSIX specification of the two flags, not on a run.

/**
 * Disk usage of one worktree in KiB.
 *
 * Returns { kb, note } where `kb === null` means COULD NOT MEASURE — never 0.
 * The distinction is the whole point: a 0 standing in for a failed measurement
 * reads identically to a genuinely empty tree, so it could not discriminate the
 * hypothesis it would be cited for (`rules/instrument-discipline.md` MUST-1).
 * A non-zero exit WITH a parseable total is a LOWER BOUND (du walked what it
 * could read), reported as `partial` rather than laundered into an exact figure.
 */
function measureSizeKb(path) {
  if (!existsSync(path)) return { kb: 0, note: "directory absent" };

  let out = "";
  let failure = null;
  try {
    out = execFileSync(DU_BIN, ["-s", "-k", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = (e.stdout || "").toString();
    failure = ((e.stderr || "").toString().trim().split("\n").filter(Boolean).pop() || e.message || "du failed").trim();
  }

  let kb = null;
  for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean).reverse()) {
    const m = /^(\d+)\s/.exec(line);
    if (m) {
      kb = Number(m[1]);
      break;
    }
  }

  if (kb === null) return { kb: null, note: `unmeasured — ${failure || "du printed no total"}` };
  if (failure) return { kb, note: `partial (lower bound) — ${failure}` };
  return { kb, note: null };
}

/** Free space in KiB on the volume holding `path`, or null when unreadable. */
function volumeFreeKb(path) {
  try {
    if (typeof fsmod.statfsSync !== "function") return null;
    const s = fsmod.statfsSync(path);
    return Math.floor((s.bavail * s.bsize) / 1024);
  } catch {
    return null;
  }
}

/**
 * Roll per-tree sizes into the forest-level numbers.
 *
 * The median is taken over LINKED worktrees ONLY. A new worktree is a fresh
 * linked checkout, not a copy of the main checkout — measured on this forest,
 * main is 339 MiB (it accumulates build output and node_modules) against ~58 MiB
 * per linked tree, so folding it in inflates the median and UNDERSTATES how many
 * more trees fit. The median rather than the mean for the same reason: one fat
 * tree should not move the estimate for the next ordinary one.
 */
function sizeRollup(records, mainTop) {
  const measured = records.filter((r) => typeof r.sizeKb === "number");
  const partial = measured.filter((r) => r.sizeNote && r.sizeNote.startsWith("partial")).length;
  const totalKb = measured.length > 0 ? measured.reduce((a, r) => a + r.sizeKb, 0) : null;

  const linked = measured.filter((r) => r.path !== mainTop).map((r) => r.sizeKb).sort((a, b) => a - b);
  const medianKb = linked.length === 0 ? null : linked.length % 2 ? linked[(linked.length - 1) / 2] : Math.round((linked[linked.length / 2 - 1] + linked[linked.length / 2]) / 2);

  const freeKb = volumeFreeKb(mainTop);
  // Trees of median size the volume still has room for. This is a DERIVED
  // measurement, not a tuned threshold: no constant is chosen anywhere in it.
  const headroom = medianKb !== null && medianKb > 0 && freeKb !== null ? Math.floor(freeKb / medianKb) : null;

  return {
    total_kb: totalKb,
    total_is_lower_bound: totalKb !== null && (partial > 0 || measured.length < records.length),
    measured: measured.length,
    unknown: records.length - measured.length,
    partial,
    median_tree_kb: medianKb,
    volume_free_kb: freeKb,
    headroom_trees: headroom,
  };
}

/** KiB → the largest binary unit that keeps the number readable; null → "unknown". */
function fmtKb(kb) {
  if (kb === null || kb === undefined) return "unknown";
  if (kb < 1024) return `${kb} KiB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MiB`;
  return `${(kb / 1024 / 1024).toFixed(2)} GiB`;
}

// ── classification ──────────────────────────────────────────────────────────

const REAP = "ZERO-LOSS";
const TAG_FIRST = "TAG-FIRST";
const KEEP = "KEEP";

/**
 * Classify one worktree. Returns { verdict, reasons[], ... }.
 *
 * Every KEEP reason is recorded, not just the first — an operator reading the
 * report needs to know ALL of what is holding a tree, or they fix one signal,
 * re-run, and are surprised by the next.
 */
function classify(wt, ctx) {
  const reasons = [];
  const path = wt.path;
  const branch = wt.branch ? wt.branch.replace(/^refs\/heads\//, "") : null;
  const sha = wt.HEAD || null;

  // SELECTION IS A CANDIDATE FILTER. It reaches exactly ONE thing inside the
  // classifier — the age floor, below — and nothing else. Every other signal
  // (main checkout, own worktree, bare, locked, dirty, unpushed, unreadable
  // status) is evaluated identically whether or not the tree was named.
  const selected = ctx.selected === null || ctx.selected.has(path);

  // AGE-FLOOR WAIVER, and the reasoning, because this is the one judgment call
  // in the feature. The floor is a CLOCK PROXY for a question the tool cannot
  // answer directly: is another live session working here? Naming an exact path
  // is the operator ASSERTING that knowledge for that one tree — the same
  // substitution `--min-age-hours 0` already permits, but scoped to one tree
  // instead of the whole forest, which is strictly the safer of the two.
  //
  // It is bounded three ways, so a careless `--only` cannot become a `--force`:
  //   (1) ONLY the age floor is waived. Dirty, unpushed, locked, bare, main, and
  //       own-session all still hold the tree — so the residual exposure is a
  //       tree that is clean AND fully pushed, where removal loses no commits by
  //       construction (that is what ZERO-LOSS means).
  //   (2) ONLY the DEFAULT floor. An explicitly passed `--min-age-hours` is an
  //       INSTRUCTION, not a default, and outranks the waiver — otherwise
  //       `--only X --min-age-hours 24` would silently ignore the number typed.
  //   (3) ONLY the selected trees. An unselected tree in the same run keeps the
  //       floor it would have had.
  // The waiver is also REPORTED per tree (`ageFloorWaived`, and a line in the
  // human report) rather than being an invisible semantic of the flag.
  const ageFloorWaived = selected && ctx.selected !== null && !ctx.ageExplicit;
  const effectiveFloor = ageFloorWaived ? 0 : ctx.minAgeHours;
  const stamp = (rec) => ({ ...rec, selected, ageFloorWaived });

  // ── hard guards: never reap, regardless of durability ──
  if (path === ctx.mainTop) reasons.push("is the MAIN checkout");
  if (ctx.selfTop && path === ctx.selfTop) reasons.push("is THIS session's own worktree");
  if (wt.bare) reasons.push("bare repository");
  if (wt.locked) reasons.push(`locked${typeof wt.locked === "string" ? ` (${wt.locked})` : ""}`);

  const missing = !existsSync(path);
  if (missing && reasons.length === 0) {
    // Directory already gone — `git worktree prune` is the correct tool, not remove.
    return stamp({ path, branch, sha, verdict: REAP, prunable: true, reasons: ["directory absent — prunable"], dirty: 0, unpushed: null, ageHours: null });
  }

  // ── occupancy signals ──
  const dirtyRes = missing ? { ok: true, out: "" } : gitOk(["-C", path, "status", "--porcelain"]);
  const dirty = dirtyRes.ok && dirtyRes.out ? dirtyRes.out.split("\n").filter(Boolean).length : 0;
  if (!dirtyRes.ok) reasons.push(`status unreadable — failing closed (${dirtyRes.err.split("\n")[0]})`);
  if (dirty > 0) reasons.push(`dirty tree (${dirty} path${dirty === 1 ? "" : "s"}; unstaged + untracked have NO reflog)`);

  const ageHours = missing ? null : hoursSinceActivity(path, ctx.gitCommonDir);
  if (ageHours !== null && ageHours < effectiveFloor) {
    reasons.push(`active ${ageHours.toFixed(1)}h ago (< --min-age-hours ${effectiveFloor})`);
  }

  // ── durability ──
  // `rev-list <ref> --not --remotes` = commits on this ref absent from EVERY
  // remote-tracking ref. This is the durability question. It is NOT the same as
  // `git cherry origin/main <branch>`, which answers "is this PATCH already
  // upstream (possibly under another SHA / another branch name)" by patch-id
  // against ONE upstream. Measured divergence on a real branch: cherry printed
  // 5 `+` lines while --not --remotes counted 4, because one commit was
  // reachable from a different remote ref. Use both; do not substitute either.
  let unpushed = null;
  if (sha) {
    const ref = branch || sha;
    const r = gitOk(["rev-list", "--count", ref, "--not", "--remotes"]);
    unpushed = r.ok ? Number(r.out) : null;
    if (!r.ok) reasons.push("unpushed-commit count unreadable — failing closed");
  }

  let patchesUpstream = null;
  if (branch && unpushed > 0 && ctx.defaultRemoteRef) {
    // Does the patch already exist upstream under another name? `-` = present
    // upstream (equivalent patch found), `+` = absent.
    const r = gitOk(["cherry", ctx.defaultRemoteRef, branch]);
    if (r.ok) {
      const lines = r.out ? r.out.split("\n").filter(Boolean) : [];
      patchesUpstream = lines.length > 0 && lines.every((l) => l.startsWith("-"));
    }
  }

  // A detached HEAD carrying commits on no ref is NOT a KEEP — it is the
  // TAG-FIRST case, and routing it to KEEP is what made that verdict dead code
  // (caught by the per-verdict fixture, not by any run against a real forest,
  // where the verdict simply never occurs). Only a NAMED branch's unpushed
  // commits are an occupancy signal: the branch ref already makes them durable,
  // so what holds the tree is that the work is in flight, not that it is at risk.
  let detachedUnreachable = false;
  if (unpushed !== null && unpushed > 0 && !patchesUpstream) {
    if (branch) reasons.push(`${unpushed} commit(s) on '${branch}' absent from every remote (work in flight)`);
    else detachedUnreachable = true;
  }

  if (reasons.length > 0) {
    return stamp({ path, branch, sha, verdict: KEEP, reasons, dirty, unpushed, ageHours, patchesUpstream });
  }

  // Nothing holds it. Does a ref preserve the commits after removal?
  if (!detachedUnreachable) {
    const why = branch
      ? `clean; branch '${branch}' persists after removal${unpushed === 0 ? " and is fully pushed" : " (patches already upstream)"}`
      : "clean; HEAD reachable from a remote ref";
    return stamp({ path, branch, sha, verdict: REAP, reasons: [why], dirty, unpushed, ageHours, patchesUpstream });
  }

  // Clean, idle, but detached AND unreachable — removal would orphan the SHA.
  return stamp({
    path,
    branch,
    sha,
    verdict: TAG_FIRST,
    reasons: ["clean but DETACHED and unreachable from any ref — tag before removing"],
    dirty,
    unpushed,
    ageHours,
    patchesUpstream,
  });
}

// ── reap ────────────────────────────────────────────────────────────────────

function reap(rec, ctx) {
  const actions = [];
  if (rec.prunable) {
    if (!ctx.apply) return ["would: git worktree prune"];
    const r = gitOk(["worktree", "prune"]);
    return [r.ok ? "pruned" : `PRUNE REFUSED: ${r.err.split("\n")[0]}`];
  }
  if (rec.verdict === TAG_FIRST) {
    const tag = `reaped/${basename(rec.path)}-${(rec.sha || "").slice(0, 8)}`;
    if (!ctx.apply) {
      actions.push(`would: git tag ${tag} ${(rec.sha || "").slice(0, 8)}`);
    } else {
      const t = gitOk(["tag", tag, rec.sha]);
      if (!t.ok && !/already exists/i.test(t.err)) {
        return [`TAG FAILED, NOT REMOVING: ${t.err.split("\n")[0]}`];
      }
      actions.push(`tagged ${tag}`);
    }
  }
  // NOTE: no --force, ever. A refusal here is the safety net working.
  if (!ctx.apply) {
    actions.push(`would: git worktree remove ${rec.path}`);
    return actions;
  }
  const r = gitOk(["worktree", "remove", rec.path]);
  actions.push(r.ok ? "removed" : `REMOVE REFUSED (not escalating to --force): ${r.err.split("\n")[0]}`);
  if (!r.ok) ctx.refusals.push({ path: rec.path, err: r.err.split("\n")[0] });
  return actions;
}

// ── main ────────────────────────────────────────────────────────────────────

function help() {
  return [
    "worktree-reap.mjs — classify the worktree forest and reap only what cannot lose work.",
    "",
    "  (no flags)            classify + report; changes NOTHING (default)",
    "  --apply               perform removals for ZERO-LOSS + TAG-FIRST verdicts",
    "  --zero-loss-only      with --apply, skip TAG-FIRST (reap only provably-pushed trees)",
    "  --min-age-hours <N>   idle floor before a tree is reapable (default " + DEFAULT_MIN_AGE_HOURS + ")",
    "  --only <path|name>    act on ONLY this worktree; repeatable, one selector each",
    "  --no-size             skip the per-tree `du` pass (~2s per 30 trees, measured)",
    "  --json                machine-readable output",
    "  --help",
    "",
    "--only — path-scoped reaping, for reaping a lane's tree at delivery.",
    "  MATCHING   full path first (resolved through symlinks), then basename. A",
    "             selector matching NOTHING, or matching two trees that share a",
    "             basename, is an ERROR (exit 1) naming the candidates — nothing",
    "             is inspected or removed. It is never a quiet no-op.",
    "  SELECTS CANDIDATES, NOT OUTCOMES   a named tree still runs the full verdict",
    "             pipeline; a KEEP verdict (dirty / unpushed / locked / main /",
    "             this session's own tree) still holds it. There is no --force.",
    "  AGE FLOOR  --only WAIVES the DEFAULT " + DEFAULT_MIN_AGE_HOURS + "h floor for the selected trees, and",
    "             says so per tree in the report. Naming an exact path IS the",
    "             occupancy assertion the clock was standing in for. An explicitly",
    "             passed --min-age-hours is an instruction and OUTRANKS the waiver;",
    "             unselected trees keep the floor. No other signal is waived.",
    "  SCOPE      a scoped run reports scope=selected in its sentinel so it cannot",
    "             be read as a full-forest audit.",
    "",
    "Size is reported per tree and for the forest, with free space and a headroom",
    "estimate (free ÷ median LINKED tree). A tree whose size cannot be determined",
    "reports `unknown`, never 0. Env WORKTREE_REAP_DU overrides the `du` binary.",
    "",
    "Never implements --force: `git worktree remove` already refuses a dirty tree,",
    "and that refusal is the desired behavior. See rules/worktree-isolation.md Rule 8.",
  ].join("\n");
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(help() + "\n");
    return 0;
  }
  const apply = argv.includes("--apply");
  const zeroLossOnly = argv.includes("--zero-loss-only");
  const json = argv.includes("--json");
  const measureSize = !argv.includes("--no-size");
  const ageIdx = argv.indexOf("--min-age-hours");
  // Whether the floor was TYPED matters, not only its value: an explicit floor
  // outranks the --only waiver (see classify). `--min-age-hours 12` and the
  // default 12 are the same number and different instructions.
  const ageExplicit = ageIdx !== -1;
  const minAgeHours = ageIdx !== -1 && argv[ageIdx + 1] != null ? Number(argv[ageIdx + 1]) : DEFAULT_MIN_AGE_HOURS;
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) {
    process.stderr.write("worktree-reap: --min-age-hours must be a non-negative number\n");
    return 1;
  }

  // `--only` is REPEATABLE and takes exactly one selector each. It deliberately
  // does NOT split on commas: a path may legally contain one, and silently
  // splitting it would turn a valid selector into two that match nothing.
  const onlySelectors = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--only") continue;
    const v = argv[i + 1];
    if (v == null || v.startsWith("--")) {
      process.stderr.write("worktree-reap: --only requires a worktree path or name\n");
      return 1;
    }
    onlySelectors.push(v);
    i++;
  }

  let gitCommonDir, mainTop, selfTop, listOut;
  try {
    gitCommonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    mainTop = git(["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    listOut = git(["worktree", "list", "--porcelain"]);
  } catch (e) {
    process.stderr.write(`worktree-reap: not a git repository, or git failed: ${e.message}\n`);
    return 1;
  }
  // mainTop above is THIS checkout's top (which may be a linked worktree);
  // the MAIN checkout is the parent of the SHARED .git dir.
  selfTop = mainTop;
  mainTop = gitCommonDir.replace(/\/\.git\/?$/, "");

  const defaultRemoteRef = (() => {
    const r = gitOk(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    if (r.ok && r.out) return r.out.replace(/^refs\/remotes\//, "");
    return gitOk(["rev-parse", "--verify", "--quiet", "origin/main"]).ok ? "origin/main" : null;
  })();

  const parsed = parseWorktrees(listOut);

  // Resolve the selection BEFORE anything is classified, measured or removed.
  // Any unresolvable selector aborts the whole run: a partial selection is not
  // the selection the operator asked for, and reaping the subset that happened
  // to resolve would act on a set nobody named.
  let selected = null;
  if (onlySelectors.length > 0) {
    const { chosen, errors } = resolveSelectors(onlySelectors, parsed);
    if (errors.length > 0) {
      process.stderr.write(errors.map((e) => `worktree-reap: ${e}`).join("\n") + "\nworktree-reap: nothing was inspected and nothing was removed.\n");
      return 1;
    }
    selected = chosen;
  }

  const ctx = { mainTop, selfTop, gitCommonDir, minAgeHours, ageExplicit, apply, defaultRemoteRef, selected, refusals: [] };
  // The WHOLE forest is classified even under --only. Two reasons: the size
  // rollup (median over LINKED trees, headroom) is only meaningful over the
  // whole forest, and a scoped run that hid the rest would make the report look
  // like a small forest rather than a partial pass. What --only narrows is what
  // may be ACTED ON.
  const records = parsed.map((wt) => classify(wt, ctx));

  // BEFORE the reap loop, always: --apply deletes directories, and a tree
  // measured after its own removal would report 0 — the exact zero-that-means-
  // nothing this measurement is built to avoid.
  for (const rec of records) {
    if (measureSize) {
      const { kb, note } = measureSizeKb(rec.path);
      rec.sizeKb = kb;
      rec.sizeNote = note;
    } else {
      rec.sizeKb = null;
      rec.sizeNote = "not measured (--no-size)";
    }
  }
  const size = sizeRollup(records, mainTop);

  for (const rec of records) {
    // `rec.selected` is the CANDIDATE gate; the verdict is still the OUTCOME
    // gate, and it is evaluated first-class here. A selected KEEP tree gets no
    // action, which is what makes --only a selector rather than a --force.
    const eligible = rec.selected && (rec.verdict === REAP || (rec.verdict === TAG_FIRST && !zeroLossOnly));
    rec.actions = eligible ? reap(rec, ctx) : [];
  }

  const scoped = selected !== null;
  const counts = {
    total: records.length,
    selected: records.filter((r) => r.selected).length,
    zero_loss: records.filter((r) => r.verdict === REAP).length,
    tag_first: records.filter((r) => r.verdict === TAG_FIRST).length,
    keep: records.filter((r) => r.verdict === KEEP).length,
  };

  if (json) {
    process.stdout.write(
      JSON.stringify(
        { applied: apply, scope: scoped ? "selected" : "all", only: onlySelectors, min_age_hours: minAgeHours, min_age_hours_explicit: ageExplicit, default_remote_ref: defaultRemoteRef, main_checkout: mainTop, counts, size, refusals: ctx.refusals, worktrees: records },
        null,
        2,
      ) + "\n",
    );
  } else {
    const lines = [];
    lines.push(`Worktree forest — ${counts.total} tree(s); reap floor --min-age-hours ${minAgeHours}` + (apply ? "  [APPLYING]" : "  [report only]"));
    if (scoped) {
      lines.push(`  scope: --only — ${counts.selected} of ${counts.total} tree(s) selected (${onlySelectors.join(", ")}).`);
      lines.push(`         the other ${counts.total - counts.selected} were classified but are NOT eligible for reap in this run.`);
    }
    lines.push("");
    for (const r of records) {
      const tag = r.verdict === REAP ? "ZERO-LOSS" : r.verdict === TAG_FIRST ? "TAG-FIRST" : "KEEP     ";
      const sz = r.sizeKb === null ? "unknown" : (r.sizeNote && r.sizeNote.startsWith("partial") ? "≥" : "") + fmtKb(r.sizeKb);
      const mark = scoped ? (r.selected ? "  [selected]" : "  [out of scope]") : "";
      lines.push(`  [${tag}] ${basename(r.path)}${r.branch ? `  (${r.branch})` : "  (detached)"}  —  ${sz}${mark}`);
      // Printed, not silent: a waived floor is a rule that did NOT run, and the
      // operator should see the age it would have been measured against.
      if (r.ageFloorWaived) {
        lines.push(`             · default --min-age-hours ${DEFAULT_MIN_AGE_HOURS} waived by explicit --only selection` + (r.ageHours === null ? "" : ` (last active ${r.ageHours.toFixed(1)}h ago)`));
      }
      for (const why of r.reasons) lines.push(`             · ${why}`);
      if (r.sizeNote && r.sizeKb === null) lines.push(`             · size ${r.sizeNote}`);
      for (const a of r.actions) lines.push(`             → ${a}`);
    }
    lines.push("");
    lines.push(`  zero-loss: ${counts.zero_loss}   tag-first: ${counts.tag_first}   keep: ${counts.keep}`);
    lines.push(
      `  forest size: ${size.total_is_lower_bound && size.total_kb !== null ? "≥" : ""}${fmtKb(size.total_kb)}` +
        ` across ${size.measured} measured tree(s)` +
        (size.unknown > 0 ? `   [${size.unknown} unknown]` : "") +
        (size.partial > 0 ? `   [${size.partial} partial]` : ""),
    );
    lines.push(`  volume free: ${fmtKb(size.volume_free_kb)}   median linked tree: ${fmtKb(size.median_tree_kb)}   headroom: ${size.headroom_trees === null ? "unknown" : `~${size.headroom_trees} more tree(s)`}`);
    // The ONLY size threshold this tool asserts, and it is definitional rather
    // than tuned: below one median tree, the next `git worktree add` cannot fit.
    // No "looks about right" constant is introduced; the headroom figure above
    // is printed on EVERY run so the trend is visible long before it reaches 1.
    if (size.headroom_trees !== null && size.headroom_trees < 1) {
      lines.push(`  WARNING: free space is under one median worktree — the next worktree creation will not fit.`);
    }
    if (!apply && counts.zero_loss + counts.tag_first > 0) {
      lines.push("  Re-run with --apply to reap. KEEP trees are never touched.");
    }
    // SENTINEL. /sweep reads this as evidence the forest audit ran, so a run
    // that acted on a SUBSET must not render like one that swept everything —
    // otherwise a partial pass silently clears a whole-forest gate, which is a
    // real gate turned into a false one. `scope=` carries that distinction, and
    // `selected=` the size of the subset.
    lines.push(
      `  <!-- worktree-reap:v1:total=${counts.total} scope=${scoped ? "selected" : "all"} selected=${counts.selected}` +
        ` zero_loss=${counts.zero_loss} tag_first=${counts.tag_first} keep=${counts.keep} applied=${apply}` +
        ` size_kb=${size.total_kb === null ? "unknown" : size.total_kb} size_unknown=${size.unknown} size_partial=${size.partial}` +
        ` free_kb=${size.volume_free_kb === null ? "unknown" : size.volume_free_kb} headroom_trees=${size.headroom_trees === null ? "unknown" : size.headroom_trees} -->`,
    );
    process.stdout.write(lines.join("\n") + "\n");
  }

  return ctx.refusals.length > 0 ? 2 : 0;
}

process.exit(main(process.argv.slice(2)));
