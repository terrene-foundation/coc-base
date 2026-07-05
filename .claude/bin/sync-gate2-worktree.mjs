#!/usr/bin/env node
/**
 * sync-gate2-worktree.mjs — collision-free Gate-2 distribution.
 *
 * Co-owner-directed origination (receipt: journal/0403). WHY: `/sync-to-build`
 * and `/sync-to-use` historically applied artifacts to the TARGET repo's LOCAL
 * working tree (`sync-tier-aware.mjs --{build|use} <target>` with no --out),
 * which collides with a developer actively working in that local checkout — the
 * uncommitted stranded overlay class (e.g. the 99 uncommitted .claude/ files a
 * prior sync left in a local BUILD checkout). This helper NEVER touches the
 * dev's local checkout: it creates an ISOLATED worktree from the target's REMOTE
 * main, applies Gate-2 there, and lands via PR.
 *
 * It WRAPS the deterministic `sync-tier-aware.mjs` engine (which already accepts
 * `--out <dir>` on both the apply and --verify paths) — it does NOT re-implement
 * the file-set / overlay / purge computation the engine owns (journal/0339).
 *
 * Flow: fetch remote main -> `git worktree add --detach <scratch> origin/main`
 *   -> sync-tier-aware --<lane> <target> --out <scratch> [+ --verify]
 *   -> capture EXACT manifest -> commit on sync/<date>-loom-<lane>-<target> -> push
 *   -> gh pr create -> (merge only with --merge, per git.md CI-check-then-merge)
 *   -> emit tracking receipt -> ALWAYS `git worktree remove` (finally).
 *
 * Merge is OFF by default (--no-merge): a bare run creates the PR and STOPS,
 * printing the exact human-gated merge command. --merge does the git.md
 * CI-check-and-merge-are-SEPARATE-steps sequence (pin head SHA, confirm required
 * checks SUCCESS on THAT SHA, then admin-merge).
 *
 * Usage:
 *   node .claude/bin/sync-gate2-worktree.mjs --lane <build|use> --target <slug>
 *        [--dry-run] [--no-merge|--merge] [--json]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveRepo } from "./lib/loom-links.mjs";

const SELF = "sync-gate2-worktree";

// ───────────────────────── pure (exported for tests) ─────────────────────────

export function usage() {
  return (
    `usage: ${SELF}.mjs --lane <build|use> --target <slug> ` +
    `[--dry-run] [--no-merge|--merge] [--json]\n` +
    `       ${SELF}.mjs --lane use --target <slug> --stage-only [--json]\n` +
    `       ${SELF}.mjs --lane use --target <slug> --finalize --worktree <path> [--no-merge|--merge] [--json]\n` +
    `       ${SELF}.mjs --lane use --target <slug> --abort --worktree <path>\n` +
    `  --lane build   -> resolver key build.<target>\n` +
    `  --lane use     -> resolver key use-template.<target>\n` +
    `  --dry-run      apply + --verify in the worktree, NO commit/PR (preview)\n` +
    `  --no-merge     (default) create the PR and STOP (human gates the merge)\n` +
    `  --merge        do the git.md CI-check-then-merge sequence + admin-merge\n` +
    `  --json         emit the tracking receipt as JSON on stdout\n` +
    `\n` +
    `  Two-phase (USE lane — enrichment runs in-worktree between apply & commit):\n` +
    `  --stage-only   fetch + worktree-from-origin/main + engine apply + --verify,\n` +
    `                 then STOP, PRINT the worktree path + base SHA, and leave the\n` +
    `                 worktree in place for the coc-sync agent to enrich (VERSION,\n` +
    `                 SDK pins, .coc-sync-marker, install, hooks). No commit/PR/cleanup.\n` +
    `  --finalize --worktree <path>\n` +
    `                 re-capture the manifest (now incl. enrichment) in an ALREADY-\n` +
    `                 staged worktree -> commit -> push -> PR -> receipt -> remove.\n` +
    `  --abort --worktree <path>\n` +
    `                 remove a staged worktree the caller decided not to finalize.\n`
  );
}

/** Parse argv; throw Error(msg) on any validation failure (fail loud). */
export function parseArgs(argv) {
  const args = {
    lane: null,
    target: null,
    dryRun: false,
    merge: false,
    json: false,
    // Two-phase (USE-lane enrichment) modes. Default (all three false) = single-shot.
    stageOnly: false,
    finalize: false,
    abort: false,
    worktree: null,
  };
  let mergeSeen = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lane") args.lane = argv[++i];
    else if (a === "--target") args.target = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-merge") {
      args.merge = false;
      mergeSeen = true;
    } else if (a === "--merge") {
      args.merge = true;
      mergeSeen = true;
    } else if (a === "--json") args.json = true;
    else if (a === "--stage-only") args.stageOnly = true;
    else if (a === "--finalize") args.finalize = true;
    else if (a === "--abort") args.abort = true;
    else if (a === "--worktree") args.worktree = argv[++i];
    else throw new Error(`unknown flag: ${a}\n${usage()}`);
  }
  if (args.lane !== "build" && args.lane !== "use")
    throw new Error(`--lane must be 'build' or 'use'\n${usage()}`);
  if (!args.target)
    throw new Error(`--target <slug> is required\n${usage()}`);
  // Exactly one two-phase mode (or none = single-shot). Mutually exclusive.
  const modeCount = [args.stageOnly, args.finalize, args.abort].filter(Boolean).length;
  if (modeCount > 1)
    throw new Error(`--stage-only / --finalize / --abort are mutually exclusive\n${usage()}`);
  // --finalize and --abort operate on an EXISTING worktree; they require its path.
  if ((args.finalize || args.abort) && !args.worktree)
    throw new Error(`--${args.finalize ? "finalize" : "abort"} requires --worktree <path>\n${usage()}`);
  // --stage-only CREATES the worktree; passing one is a caller error.
  if (args.stageOnly && args.worktree)
    throw new Error(`--stage-only creates its own worktree; do not pass --worktree\n${usage()}`);
  // --worktree only means anything in --finalize / --abort.
  if (args.worktree && !(args.finalize || args.abort))
    throw new Error(`--worktree is only valid with --finalize or --abort\n${usage()}`);
  // --dry-run is a single-shot preview; incompatible with every two-phase mode.
  if (args.dryRun && modeCount > 0)
    throw new Error(`--dry-run is incompatible with --stage-only/--finalize/--abort\n${usage()}`);
  if (args.dryRun && mergeSeen)
    throw new Error(`--dry-run is incompatible with --merge/--no-merge\n${usage()}`);
  // Merge only happens at finalize (or single-shot). --stage-only/--abort never merge.
  if (mergeSeen && (args.stageOnly || args.abort))
    throw new Error(`--merge/--no-merge is only valid at --finalize (or single-shot)\n${usage()}`);
  return args;
}

/** loom-links logical key for a lane+target. */
/**
 * A resolved target can open a Gate-2 PR only when loom-links bound it to a
 * remote (org + repo). A path-linked target with no ecosystem.json remote
 * yields `r.remote === undefined`; `gh pr create` would then TypeError only
 * AFTER the worktree + commit + push side effects. Pure predicate so the
 * fail-loud guard in commitPushPrMaybeMerge is unit-testable.
 */
export function hasRemoteBinding(r) {
  return Boolean(r && r.remote && r.remote.org && r.remote.repo);
}

export function resolverKey(lane, target) {
  return lane === "build" ? `build.${target}` : `use-template.${target}`;
}

/**
 * Parse `git status --porcelain` output into {added,modified,deleted}.
 *
 * Input MUST be the RAW porcelain string (capture via `gitStatusPorcelain`, NOT
 * the whole-output-trimming `git()` helper): the path column starts at byte 3,
 * so a leading-space status on the first line (` M`, ` D`) is load-bearing —
 * trimming it upstream shifts the first path left one char and drops its leading
 * `.` (`.claude/x` → `claude/x`). Callers pass raw; the per-line `slice(3).trim()`
 * below trims only the path's trailing whitespace, never the leading status.
 */
export function parseManifest(porcelain) {
  const out = { added: [], modified: [], deleted: [] };
  for (const raw of String(porcelain).split("\n")) {
    if (!raw.trim()) continue;
    const x = raw[0];
    const y = raw[1];
    const file = raw.slice(3).trim();
    if (x === "?" || y === "?" || x === "A") out.added.push(file);
    else if (x === "D" || y === "D") out.deleted.push(file);
    else out.modified.push(file);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

/**
 * Map a USE-lane loom-links target suffix to the `sync-tier-aware --target <lang>` lane.
 * The USE-lane resolver keys are `use-template.{py,rs,claude-py,claude-rs,base,...}`
 * (artifact-flow.md § "Repo Classes Map 1:1 To Resolver Logical Keys"); the lane is the
 * TRAILING language segment of the suffix (`claude-py` → `py`, `py` → `py`). Fails loud on
 * an unmappable suffix rather than silently mis-routing. Pure + exported for tests.
 */
export function useLaneLang(target) {
  if (target === "py" || target.endsWith("-py")) return "py";
  if (target === "rs" || target.endsWith("-rs")) return "rs";
  if (target === "rb" || target.endsWith("-rb")) return "rb";
  if (target === "base" || target.endsWith("-base")) return "base";
  throw new Error(
    `${SELF}: cannot derive USE lane-lang from target '${target}' ` +
      `(expected a use-template.{py,rs,claude-py,claude-rs,base,...} suffix)`,
  );
}

/**
 * Build the inner `sync-tier-aware` engine invocation for a Gate-2 apply into the
 * throwaway scratch worktree.
 *
 * BUILD lane: `--build <lang>` is self-contained (lang is py|rs|prism).
 * USE   lane: the inner engine requires BOTH the lane `--target <lang>` AND the
 *   `--template <repo-slug>` restriction — the loom-links suffix alone is NEITHER.
 *   Passing only `--template <suffix>` (the pre-fix shape) OMITS the required `--target`,
 *   so `sync-tier-aware` exits "--target OR --build is required" and the ENTIRE USE lane
 *   never runs. `opts.templateRepo` carries the resolved manifest template repo slug
 *   (`r.remote.repo`, e.g. `kailash-coc-claude-py`); the lane-lang is derived from the
 *   suffix via `useLaneLang`.
 *
 * NEVER includes `--dry-run`: the dry-run PREVIEW composes FOR REAL into the scratch
 * (journal/0415 — passing `--dry-run` to the inner engine writes nothing, so the manifest
 * would falsely report "0 files would change" against an un-composed tree, the
 * false-currency bug `sync-completeness.md` guards against). Pass `{ verify: true }` for
 * the consistency-gate pass. This is the tested pure surface that structurally pins both
 * fixes (the false-currency guard AND the USE-lane `--target`/`--template` shape) against
 * re-regression.
 */
export function buildEngineApplyArgs(engine, lane, target, scratch, opts = {}) {
  const argv = [engine];
  if (lane === "build") {
    argv.push("--build", target);
  } else {
    if (!opts.templateRepo)
      throw new Error(
        `${SELF}: USE lane requires opts.templateRepo (the resolved manifest template ` +
          `repo slug) — none provided for target '${target}'; declare its remote in ecosystem.json`,
      );
    argv.push("--target", useLaneLang(target), "--template", opts.templateRepo);
  }
  argv.push("--out", scratch);
  if (opts.verify) argv.push("--verify");
  return argv;
}

/** Shape the exact-tracking receipt (Gate-2 half). */
export function buildReceipt({
  lane,
  target,
  baseSha,
  worktree,
  branch,
  manifest,
  prUrl,
  mergeSha,
  loomSha,
  timestamp,
}) {
  return {
    gate: 2,
    lane,
    target,
    loom_sha: loomSha,
    base_sha: baseSha,
    worktree,
    branch,
    manifest,
    changed_count:
      manifest.added.length +
      manifest.modified.length +
      manifest.deleted.length,
    pr_url: prUrl || null,
    merge_sha: mergeSha || null,
    timestamp,
  };
}

// ───────────────────────── impure orchestration ─────────────────────────

function git(cwd, gitArgs) {
  return execFileSync("git", ["-C", cwd, ...gitArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Capture `git status --porcelain` WITHOUT trimming — leading whitespace in the
 * status columns is SIGNIFICANT and MUST be preserved for `parseManifest`.
 *
 * The generic `git()` helper `.trim()`s its whole output (correct + harmless for
 * scalar commands like `rev-parse`). But porcelain is line-structured: the path
 * starts at byte 3 (cols 0-1 = XY status, col 2 = space). A FIRST line with a
 * leading-space status code (` M`, ` D` — index-clean / worktree-dirty) loses
 * its leading space under a whole-output trim, so ` M .claude/x` becomes
 * `M .claude/x` and `parseManifest`'s `slice(3)` then eats the path's first
 * character (`.claude/x` → `claude/x`). Downstream that corrupt pathspec makes
 * `git add -- <path>` fail "pathspec did not match", aborting the Gate-2 PR.
 * Same hazard the sibling `codify-backlog.mjs` `-z` parser documents inline.
 */
export function gitStatusPorcelain(cwd) {
  return execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fail(code, msg) {
  process.stderr.write(`${SELF}: ${msg}\n`);
  process.exit(code);
}

/** Resolve the target's local clone via loom-links; fail loud on any gap. */
function resolveLocalClone(args) {
  const key = resolverKey(args.lane, args.target);
  const r = resolveRepo(key, { require: false });
  if (r.skipped)
    fail(3, `loom-links: ${r.reason} (declare '${key}' in loom-links.local.json)`);
  if (r.kind !== "path")
    fail(3, `loom-links: '${key}' is a ${r.kind}, expected a path linkage`);
  const localClone = r.value;
  if (!fs.existsSync(path.join(localClone, ".git")))
    fail(3, `resolved path is not a git repo: ${localClone}`);
  return { localClone, r };
}

/** Remove a worktree, warning (never throwing) on failure. */
function removeWorktree(localClone, wt) {
  try {
    git(localClone, ["worktree", "remove", "--force", wt]);
  } catch {
    process.stderr.write(`${SELF}: WARN could not remove worktree ${wt}\n`);
  }
}

/**
 * branch + explicit-path stage (coc-sync-landing MUST-2: never git add -A) +
 * commit + push + PR + optional gated merge. Operates on an already-populated
 * worktree; returns {branch, prUrl, mergeSha}.
 */
function commitPushPrMaybeMerge({ localClone, r, scratch, args, baseSha, loomSha, dateOnly, manifest }) {
  // Fail loud BEFORE any branch/commit/push side effect if the target has no
  // remote binding: `gh pr create` below dereferences r.remote.org/.repo, and a
  // path-linked target with no ecosystem.json remote yields r.remote === undefined
  // (an unguarded deref would TypeError only AFTER the worktree + commit + push).
  if (!hasRemoteBinding(r))
    fail(
      3,
      `loom-links: '${resolverKey(args.lane, args.target)}' has no remote binding ` +
        `(org/repo) — declare it in ecosystem.json; cannot open a Gate-2 PR without it`,
    );
  const branch = `sync/${dateOnly}-loom-${args.lane}-${args.target}`;
  git(scratch, ["checkout", "-b", branch]);
  const staged = [...manifest.added, ...manifest.modified, ...manifest.deleted];
  git(scratch, ["add", "--", ...staged]);
  const commitMsg =
    `chore(sync): Gate-2 ${args.lane} ${args.target} from loom ${loomSha.slice(0, 12)}\n\n` +
    `+${manifest.added.length} ~${manifest.modified.length} -${manifest.deleted.length} ` +
    `(worktree from origin/main ${baseSha.slice(0, 12)}). See loom journal/0403.`;
  git(scratch, ["commit", "-m", commitMsg]);
  git(scratch, ["push", "-u", "origin", branch]);

  const prUrl = execFileSync(
    "gh",
    ["pr", "create", "--repo", `${r.remote.org}/${r.remote.repo}`, "--head", branch,
     "--base", "main", "--title", commitMsg.split("\n")[0], "--body",
     `Automated Gate-2 distribution from loom ${loomSha.slice(0, 12)}.\n\n` +
     `Applied in an isolated worktree from origin/main (${baseSha.slice(0, 12)}); ` +
     `the target's local checkout was NOT touched. Manifest: +${manifest.added.length} ` +
     `~${manifest.modified.length} -${manifest.deleted.length}.`],
    { cwd: scratch, encoding: "utf8" },
  ).trim();

  let mergeSha = null;
  if (args.merge) {
    // git.md § "CI-check and merge are SEPARATE steps": pin head, confirm, then merge
    const head = execFileSync("gh", ["pr", "view", prUrl, "--json", "headRefOid", "-q", ".headRefOid"], { encoding: "utf8" }).trim();
    execFileSync("gh", ["pr", "checks", prUrl], { stdio: "inherit" });
    execFileSync("gh", ["pr", "merge", prUrl, "--admin", "--merge", "--delete-branch"], { stdio: "inherit" });
    mergeSha = head;
  }
  return { branch, prUrl, mergeSha };
}

/** Human text for a gated (un-merged) finalize/single-shot PR. */
function gatedMergeHint(prUrl) {
  return (
    `PR opened (merge gated): ${prUrl}\n  Merge after CI green:\n` +
    `  head=$(gh pr view ${prUrl} --json headRefOid -q .headRefOid); ` +
    `gh pr checks ${prUrl}; gh pr merge ${prUrl} --admin --merge --delete-branch`
  );
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    fail(2, e.message);
    return;
  }

  const { localClone, r } = resolveLocalClone(args);
  const stamp = new Date().toISOString();
  const dateOnly = stamp.slice(0, 10);
  const loomSha = git(process.cwd(), ["rev-parse", "HEAD"]);

  // ── Mode: --abort ── remove a staged worktree the caller is discarding.
  if (args.abort) {
    removeWorktree(localClone, args.worktree);
    emit(args.json, { gate: 2, aborted: true, worktree: args.worktree, timestamp: stamp },
      `Aborted: removed staged worktree ${args.worktree} (no PR).`);
    return;
  }

  // ── Mode: --finalize ── commit an ALREADY-staged+enriched worktree.
  if (args.finalize) {
    const scratch = args.worktree;
    if (!fs.existsSync(scratch))
      fail(3, `--finalize: worktree not found: ${scratch} (was it aborted or already finalized?)`);
    try {
      // The worktree still sits at detached origin/main tip (no commit yet), so
      // its HEAD IS the base SHA. Re-capture the manifest — it now includes the
      // agent's enrichment writes (VERSION, SDK pins, .coc-sync-marker, etc.).
      const baseSha = git(scratch, ["rev-parse", "HEAD"]);
      const manifest = parseManifest(gitStatusPorcelain(scratch));
      const changed =
        manifest.added.length + manifest.modified.length + manifest.deleted.length;
      if (changed === 0) {
        emit(args.json, buildReceipt({
          lane: args.lane, target: args.target, baseSha, worktree: scratch,
          branch: null, manifest, prUrl: null, mergeSha: null, loomSha, timestamp: stamp,
        }), "Already in sync after enrichment — nothing to distribute (no PR).");
        return;
      }
      const { branch, prUrl, mergeSha } = commitPushPrMaybeMerge({
        localClone, r, scratch, args, baseSha, loomSha, dateOnly, manifest,
      });
      const receipt = buildReceipt({
        lane: args.lane, target: args.target, baseSha, worktree: scratch,
        branch, manifest, prUrl, mergeSha, loomSha, timestamp: stamp,
      });
      emit(args.json, receipt,
        args.merge ? `Distributed + merged: ${prUrl}` : gatedMergeHint(prUrl));
    } catch (e) {
      fail(1, `gate-2 finalize failed: ${e.message}`);
    } finally {
      removeWorktree(localClone, scratch);
    }
    return;
  }

  // ── Mode: single-shot (default) OR --stage-only ──
  const scratch = path.join(
    os.tmpdir(),
    `loom-gate2-${args.lane}-${args.target}-${Date.now()}`,
  );
  let worktreeAdded = false;
  try {
    // 1. fresh remote main (never touches the dev's checked-out branch)
    git(localClone, ["fetch", "origin", "main"]);
    const baseSha = git(localClone, ["rev-parse", "origin/main"]);

    // 2. isolated detached worktree at remote-main tip
    git(localClone, ["worktree", "add", "--detach", scratch, "origin/main"]);
    worktreeAdded = true;

    // 3. apply Gate-2 into the worktree via the deterministic engine (--out)
    const engine = path.resolve(".claude/bin/sync-tier-aware.mjs");
    // USE lane needs the resolved manifest template repo slug for `--template` (BUILD
    // lane ignores it — `--build <lang>` is self-contained). See buildEngineApplyArgs.
    const templateRepo = args.lane === "use" ? r.remote && r.remote.repo : null;
    // NOTE (journal/0415): dry-run composes FOR REAL into the throwaway worktree — it
    // does NOT pass `--dry-run` to the inner engine. `sync-tier-aware --out <scratch>
    // --dry-run` writes NOTHING, so the `git status` manifest below would see an
    // un-composed tree and always report "0 file(s) would change" regardless of the real
    // delta — the false-currency preview bug (a stale target reads as "in sync"). The
    // scratch worktree is removed in `finally`, so composing here is side-effect-free.
    // `--verify` runs in BOTH modes so the dry-run preview is validated, not merely accurate.
    execFileSync("node", buildEngineApplyArgs(engine, args.lane, args.target, scratch, { templateRepo }), {
      stdio: "inherit",
    });
    execFileSync("node", buildEngineApplyArgs(engine, args.lane, args.target, scratch, { templateRepo, verify: true }), {
      stdio: "inherit",
    });

    // 4. capture the EXACT engine-apply manifest
    const manifest = parseManifest(gitStatusPorcelain(scratch));
    const changed =
      manifest.added.length + manifest.modified.length + manifest.deleted.length;

    if (args.dryRun) {
      const receipt = buildReceipt({
        lane: args.lane, target: args.target, baseSha, worktree: scratch,
        branch: null, manifest, prUrl: null, mergeSha: null, loomSha, timestamp: stamp,
      });
      emit(args.json, receipt, `DRY-RUN: ${changed} file(s) would change (no PR).`);
      return; // finally removes the worktree
    }

    // ── --stage-only: STOP here, leave the worktree in place for enrichment.
    if (args.stageOnly) {
      worktreeAdded = false; // suppress the finally cleanup — caller owns the worktree now
      const receipt = {
        ...buildReceipt({
          lane: args.lane, target: args.target, baseSha, worktree: scratch,
          branch: null, manifest, prUrl: null, mergeSha: null, loomSha, timestamp: stamp,
        }),
        staged: true,
      };
      emit(args.json, receipt,
        `STAGED: worktree ${scratch} (base origin/main ${baseSha.slice(0, 12)}), ` +
        `${changed} engine file(s). Enrich in the worktree, then:\n` +
        `  node .claude/bin/sync-gate2-worktree.mjs --lane ${args.lane} --target ${args.target} --finalize --worktree ${scratch}\n` +
        `Or discard: --abort --worktree ${scratch}`);
      return;
    }

    if (changed === 0) {
      emit(args.json, buildReceipt({
        lane: args.lane, target: args.target, baseSha, worktree: scratch,
        branch: null, manifest, prUrl: null, mergeSha: null, loomSha, timestamp: stamp,
      }), "Already in sync — nothing to distribute (no PR).");
      return; // finally removes the worktree
    }

    // 5-6. single-shot: commit + push + PR + optional merge (BUILD lane; no enrichment)
    const { branch, prUrl, mergeSha } = commitPushPrMaybeMerge({
      localClone, r, scratch, args, baseSha, loomSha, dateOnly, manifest,
    });
    const receipt = buildReceipt({
      lane: args.lane, target: args.target, baseSha, worktree: scratch,
      branch, manifest, prUrl, mergeSha, loomSha, timestamp: stamp,
    });
    emit(args.json, receipt,
      args.merge ? `Distributed + merged: ${prUrl}` : gatedMergeHint(prUrl));
  } catch (e) {
    fail(1, `gate-2 worktree flow failed: ${e.message}`);
  } finally {
    if (worktreeAdded) removeWorktree(localClone, scratch);
  }
}

function emit(json, receipt, human) {
  if (json) process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
  else process.stdout.write(human + "\n");
}

// Run only when invoked directly (not when imported by the test).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main();
}
