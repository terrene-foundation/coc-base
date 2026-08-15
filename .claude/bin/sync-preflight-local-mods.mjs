#!/usr/bin/env node
/**
 * sync-preflight-local-mods.mjs — surface consumer-authored local modifications
 * that `/sync-from-template` would REPLACE WHOLE, before the sync writes anything.
 *
 * `/sync-from-template` is a CATEGORY-BASED REPLACE, not a per-file merge
 * (`commands/sync-from-template.md` § Downstream Sync). A path in a SHARED
 * category is replaced whole by the template's copy — a local edit to it is
 * discarded with no conflict marker and no diff to review. This tool finds those
 * edits FIRST so a human can decide per file.
 *
 * THREE-VALUED EXIT — the third value is the load-bearing one:
 *
 *   0  nothing at risk. The scan RAN and found no consumer-authored modification
 *      in the scanned set.
 *   2  at-risk modifications found. A HUMAN decides per file before the sync runs.
 *   1  THE CHECK DID NOT RUN. Not a git repo, no `.claude/` at --root, a git
 *      invocation failed, or a bad flag. This is the ABSENCE of a result, not a
 *      clean result, and MUST NEVER be read as "safe" (`instrument-discipline.md`
 *      MUST-1: a non-discriminating outcome is not evidence). Fix the invocation
 *      and re-run; proceeding on a 1 is BLOCKED.
 *
 * The 0/1 split is the whole point. A tool that returned 0 when it could not run
 * would be indistinguishable, at the call site, from a tool that ran clean — the
 * exact instrument failure this file exists to avoid reproducing.
 *
 * COVERAGE RESIDUAL (stated, not assumed away). Only the six SHARED_GLOB_DIRS
 * below are scanned. `.claude/bin/`, `.claude/hooks/`, `.claude/audit-fixtures/`
 * and files at the `.claude/` ROOT are NOT scanned, so a local modification there
 * is replaced with no warning from this tool. Check those by hand (`git status`)
 * until the scanned set widens.
 *
 * DIRECTION OF FAILURE: the classifier over-reports (flags a sync-authored file
 * as consumer-authored) rather than silently missing a real loss. A false exit 2
 * costs a human read; a false exit 0 costs the edit.
 *
 * Usage:
 *   node .claude/bin/sync-preflight-local-mods.mjs [--root <dir>] [--json]
 *                                                  [--sync-subject-re <regex>]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The six shared directories a consumer receives from its USE template and may
 * locally modify. FIXED — widening this set is a contract change that must also
 * update the residual paragraph above and both `sync-from-template.md` bodies.
 */
const SHARED_GLOB_DIRS = [
  "agents",
  "commands",
  "guides",
  "rules",
  "skills",
  "templates",
];

/**
 * Paths INSIDE a shared dir that the sync PRESERVES (consumer-owned by category),
 * so a local modification there is not at risk and must not be reported.
 * Mirrors the preserved set in `commands/sync-from-template.md` § Downstream Sync.
 */
const PRESERVED_SUBDIRS = ["project"];

/**
 * CONSUMER-OWNED files at the `.claude/` ROOT (loom#1729).
 *
 * These are shipped ONCE as a scaffold and thereafter WRITTEN BY THE CONSUMER.
 * They are consumer-owned in exactly the sense `commands/sync-from-template.md`
 * § Downstream Sync step 3 already names for `rules/project/` and `team-memory/**`
 * — "MUST NEVER be overwritten" — but they live at the `.claude/` ROOT, which the
 * six SHARED_GLOB_DIRS above do not reach. That is the whole gap: the category
 * existed, the enforcement did not extend to this location.
 *
 * WHY A POST-CONDITION AND NOT ONLY A PRE-SCAN. The failure mode is silent LOSS,
 * not a visible conflict: the registry returns to `{"deferrals": {}}` and the
 * SessionStart surface then reports "✓ Verified Empty", which is INDISTINGUISHABLE
 * from a consumer who never deferred anything. A pre-scan can only say what is at
 * risk; nothing in the outcome discriminates survival from loss. `--snapshot` /
 * `--verify` is that discriminator: it can only pass if the bytes actually survived.
 */
const CONSUMER_OWNED_ROOT_FILES = [".claude/deferrals.json"];

/**
 * Default matcher for a commit authored BY the sync rather than by the consumer.
 * A file whose every touching commit matches this is template-authored; one with
 * at least one non-matching commit carries a consumer edit.
 *
 * Deliberately broad: over-matching here would UNDER-report (the wrong direction),
 * so the pattern is anchored on sync-verb vocabulary rather than on any single
 * repo's commit style, and `--sync-subject-re` exists for repos whose sync commits
 * do not use it.
 */
const DEFAULT_SYNC_SUBJECT_RE =
  "(sync-from-template|sync-to-use|sync-to-build|/sync\\b|\\bcoc sync\\b|^(chore|sync)\\((coc|sync|template)\\))";

class DidNotRun extends Error {
  constructor(reason) {
    super(reason);
    this.name = "DidNotRun";
  }
}

function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    json: false,
    syncSubjectRe: DEFAULT_SYNC_SUBJECT_RE,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--root") {
      if (!argv[i + 1]) throw new DidNotRun("--root requires a directory");
      opts.root = argv[++i];
    } else if (a === "--sync-subject-re") {
      if (!argv[i + 1]) throw new DidNotRun("--sync-subject-re requires a regex");
      opts.syncSubjectRe = argv[++i];
    } else if (a === "--snapshot") {
      if (!argv[i + 1]) throw new DidNotRun("--snapshot requires a receipt path");
      opts.snapshot = argv[++i];
    } else if (a === "--verify") {
      if (!argv[i + 1]) throw new DidNotRun("--verify requires a receipt path");
      opts.verify = argv[++i];
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
    } else {
      throw new DidNotRun(`unrecognized flag: ${a}`);
    }
  }
  if (opts.snapshot && opts.verify) {
    throw new DidNotRun("--snapshot and --verify are mutually exclusive");
  }
  return opts;
}

function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    throw new DidNotRun(
      `git ${args.join(" ")} failed: ${String(e.stderr || e.message).trim()}`,
    );
  }
}

/** Every file under the six shared dirs, minus the preserved subdirs. */
function enumerateSharedFiles(root) {
  const claude = path.join(root, ".claude");
  if (!fs.existsSync(claude) || !fs.statSync(claude).isDirectory()) {
    throw new DidNotRun(`no .claude/ directory under ${root}`);
  }
  const out = [];
  for (const dir of SHARED_GLOB_DIRS) {
    const abs = path.join(claude, dir);
    if (!fs.existsSync(abs)) continue;
    walk(abs);
  }
  return out.sort();

  function walk(abs) {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, ent.name);
      const rel = path.relative(root, child).split(path.sep).join("/");
      if (ent.isDirectory()) {
        if (PRESERVED_SUBDIRS.includes(ent.name)) continue;
        walk(child);
      } else if (ent.isFile()) {
        out.push(rel);
      }
    }
  }
}

/**
 * Classify one path. Returns {rel, atRisk, reason}.
 *
 * At risk when EITHER:
 *   (a) the working tree carries an uncommitted modification to it, OR
 *   (b) at least one commit touching it has a subject the sync-subject matcher
 *       does NOT recognize — i.e. a consumer authored it.
 */
function classify(root, rel, syncRe, dirtySet) {
  if (dirtySet.has(rel)) {
    return { rel, atRisk: true, reason: "uncommitted local modification" };
  }
  const log = git(root, ["log", "--format=%s", "--", rel]).trim();
  if (log === "") {
    // Untracked-but-present, or no history: cannot show it is template-authored.
    return { rel, atRisk: true, reason: "no commit history (untracked?)" };
  }
  const subjects = log.split("\n");
  const consumerAuthored = subjects.filter((s) => !syncRe.test(s));
  if (consumerAuthored.length === 0) {
    return { rel, atRisk: false, reason: "all commits are sync-authored" };
  }
  return {
    rel,
    atRisk: true,
    reason: `consumer-authored commit: ${consumerAuthored[0]}`,
  };
}

/** Consumer-owned root files that EXIST under `root`, as repo-relative paths. */
function enumerateConsumerOwnedRootFiles(root) {
  return CONSUMER_OWNED_ROOT_FILES.filter((rel) => {
    const abs = path.join(root, rel);
    return fs.existsSync(abs) && fs.statSync(abs).isFile();
  }).sort();
}

/** sha256 of a file's bytes. Throws DidNotRun if unreadable — never a fake digest. */
function hashFile(abs) {
  try {
    return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch (e) {
    throw new DidNotRun(`cannot read ${abs}: ${e.message}`);
  }
}

/**
 * Record the pre-sync bytes of every EXISTING consumer-owned root file.
 * A path that is absent is recorded as absent — so the "absent registry still
 * receives the scaffold" case verifies clean rather than reading as a loss.
 */
function snapshotConsumerOwned(root) {
  const entries = {};
  for (const rel of CONSUMER_OWNED_ROOT_FILES) {
    const abs = path.join(root, rel);
    entries[rel] =
      fs.existsSync(abs) && fs.statSync(abs).isFile()
        ? { present: true, sha256: hashFile(abs) }
        : { present: false, sha256: null };
  }
  return { version: 1, root, taken_at_sha: headSha(root), entries };
}

function headSha(root) {
  try {
    return git(root, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null; // a snapshot is still valid without one; never fabricate
  }
}

/**
 * Compare the CURRENT bytes against a snapshot. A violation is exactly:
 *   - present-before → absent-after   (destroyed)
 *   - present-before → different-after (overwritten)
 * An absent-before path is unconstrained: receiving the scaffold is the
 * create-if-absent case the mechanism exists to allow.
 */
function verifyConsumerOwned(root, snap) {
  if (!snap || snap.version !== 1 || !snap.entries) {
    throw new DidNotRun("snapshot receipt is malformed or not version 1");
  }
  const violations = [];
  for (const [rel, before] of Object.entries(snap.entries)) {
    if (!before.present) continue;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      violations.push({ path: rel, reason: "DESTROYED — present before the sync, absent after" });
      continue;
    }
    const after = hashFile(abs);
    if (after !== before.sha256) {
      violations.push({
        path: rel,
        reason: `OVERWRITTEN — bytes changed (${before.sha256.slice(0, 12)} → ${after.slice(0, 12)})`,
      });
    }
  }
  return violations;
}

function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      "usage: sync-preflight-local-mods.mjs [--root <dir>] [--json] [--sync-subject-re <regex>]\n" +
        "       sync-preflight-local-mods.mjs --snapshot <receipt>   (BEFORE the sync writes)\n" +
        "       sync-preflight-local-mods.mjs --verify <receipt>     (AFTER the merge)\n" +
        "exit 0 = nothing at risk · 2 = human decides · 1 = DID NOT RUN (never read as safe)\n",
    );
    return { exit: 0, report: null };
  }

  if (opts.snapshot) {
    const root = path.resolve(opts.root);
    if (!fs.existsSync(root)) throw new DidNotRun(`--root does not exist: ${root}`);
    const snap = snapshotConsumerOwned(root);
    fs.writeFileSync(opts.snapshot, JSON.stringify(snap, null, 2) + "\n");
    return { exit: 0, report: { mode: "snapshot", receipt: opts.snapshot, entries: snap.entries }, json: opts.json };
  }

  if (opts.verify) {
    const root = path.resolve(opts.root);
    if (!fs.existsSync(opts.verify)) {
      throw new DidNotRun(`--verify receipt does not exist: ${opts.verify} (was --snapshot run?)`);
    }
    let snap;
    try {
      snap = JSON.parse(fs.readFileSync(opts.verify, "utf8"));
    } catch (e) {
      throw new DidNotRun(`--verify receipt is not readable JSON: ${e.message}`);
    }
    const violations = verifyConsumerOwned(root, snap);
    return {
      exit: violations.length > 0 ? 2 : 0,
      report: { mode: "verify", receipt: opts.verify, checked: Object.keys(snap.entries).length, violations },
      json: opts.json,
    };
  }

  const root = path.resolve(opts.root);
  if (!fs.existsSync(root)) throw new DidNotRun(`--root does not exist: ${root}`);

  let syncRe;
  try {
    syncRe = new RegExp(opts.syncSubjectRe);
  } catch (e) {
    throw new DidNotRun(`--sync-subject-re is not a valid regex: ${e.message}`);
  }

  // Establishes we are in a git work tree at all; throws DidNotRun otherwise.
  git(root, ["rev-parse", "--is-inside-work-tree"]);

  const dirty = new Set(
    git(root, ["status", "--porcelain", "--", ".claude"])
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3).trim())
      .filter(Boolean),
  );

  const files = enumerateSharedFiles(root);
  const results = files.map((rel) => classify(root, rel, syncRe, dirty));
  const atRisk = results.filter((r) => r.atRisk);

  return {
    exit: atRisk.length > 0 ? 2 : 0,
    report: {
      root,
      scanned_dirs: SHARED_GLOB_DIRS,
      // loom#1729 — the consumer-owned ROOT files are no longer in the unscanned
      // residual: they are enumerated below and enforced by --snapshot/--verify.
      // The rest of the residual stands and is stated rather than assumed away.
      unscanned_note:
        ".claude/bin, .claude/hooks and .claude/audit-fixtures are NOT scanned; " +
        ".claude/ root files other than the consumer-owned set below are NOT scanned",
      consumer_owned_root_files: CONSUMER_OWNED_ROOT_FILES,
      consumer_owned_present: enumerateConsumerOwnedRootFiles(root),
      sync_subject_re: opts.syncSubjectRe,
      scanned: results.length,
      at_risk: atRisk.map((r) => ({ path: r.rel, reason: r.reason })),
    },
    json: opts.json,
  };
}

function main() {
  let outcome;
  try {
    outcome = run(process.argv.slice(2));
  } catch (e) {
    // EVERY failure path lands here and exits 1 — never 0. "Did not run" and
    // "ran clean" must not be confusable at the call site.
    const reason = e instanceof DidNotRun ? e.message : `unexpected: ${e.message}`;
    process.stderr.write(
      `sync-preflight-local-mods: DID NOT RUN — ${reason}\n` +
        `exit 1 is the ABSENCE of a result, not a clean result. Do NOT proceed with the sync.\n`,
    );
    process.exit(1);
  }

  const { exit, report, json } = outcome;
  if (!report) process.exit(exit);

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exit(exit);
  }

  if (report.mode === "snapshot") {
    const present = Object.entries(report.entries).filter(([, v]) => v.present);
    process.stdout.write(
      `Consumer-owned snapshot written: ${report.receipt}\n` +
        `  recorded present: ${present.length} of ${Object.keys(report.entries).length}\n`,
    );
    for (const [rel, v] of Object.entries(report.entries)) {
      process.stdout.write(
        `  ${rel}  ${v.present ? v.sha256.slice(0, 12) : "(absent — scaffold may land)"}\n`,
      );
    }
    process.exit(exit);
  }

  if (report.mode === "verify") {
    if (report.violations.length === 0) {
      process.stdout.write(
        `Consumer-owned verify: ${report.checked} checked, 0 violations — every ` +
          `pre-sync file survived byte-identical.\n`,
      );
    } else {
      process.stdout.write(
        `Consumer-owned verify: ${report.violations.length} VIOLATION(S) — the sync ` +
          `destroyed or overwrote consumer-owned state. HALT; do not report success:\n`,
      );
      for (const v of report.violations) {
        process.stdout.write(`  ${v.path}\n      ${v.reason}\n`);
      }
    }
    process.exit(exit);
  }

  {
    process.stdout.write(
      `Scanned: ${report.scanned} files across ${report.scanned_dirs.length} shared dirs (${report.scanned_dirs.join(", ")})\n`,
    );
    process.stdout.write(`Not scanned: ${report.unscanned_note}\n`);
    process.stdout.write(
      `Consumer-owned (MUST survive the sync; enforce with --snapshot/--verify): ` +
        `${report.consumer_owned_present.length} present of ${report.consumer_owned_root_files.length} declared` +
        (report.consumer_owned_present.length
          ? ` — ${report.consumer_owned_present.join(", ")}\n`
          : `\n`),
    );
    if (report.at_risk.length === 0) {
      process.stdout.write("At risk: 0 — nothing a sync would silently replace.\n");
    } else {
      process.stdout.write(
        `At risk: ${report.at_risk.length} — a HUMAN decides each before the sync proceeds:\n`,
      );
      for (const r of report.at_risk) {
        process.stdout.write(`  ${r.path}\n      ${r.reason}\n`);
      }
    }
  }
  process.exit(exit);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export {
  SHARED_GLOB_DIRS,
  PRESERVED_SUBDIRS,
  CONSUMER_OWNED_ROOT_FILES,
  DEFAULT_SYNC_SUBJECT_RE,
  enumerateConsumerOwnedRootFiles,
  snapshotConsumerOwned,
  verifyConsumerOwned,
  parseArgs,
  enumerateSharedFiles,
  classify,
  run,
  DidNotRun,
};
