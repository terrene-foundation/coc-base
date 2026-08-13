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
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
    } else {
      throw new DidNotRun(`unrecognized flag: ${a}`);
    }
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

function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      "usage: sync-preflight-local-mods.mjs [--root <dir>] [--json] [--sync-subject-re <regex>]\n" +
        "exit 0 = nothing at risk · 2 = human decides · 1 = DID NOT RUN (never read as safe)\n",
    );
    return { exit: 0, report: null };
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
      unscanned_note:
        ".claude/bin, .claude/hooks, .claude/audit-fixtures and the .claude/ root are NOT scanned",
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
  } else {
    process.stdout.write(
      `Scanned: ${report.scanned} files across ${report.scanned_dirs.length} shared dirs (${report.scanned_dirs.join(", ")})\n`,
    );
    process.stdout.write(`Not scanned: ${report.unscanned_note}\n`);
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
  DEFAULT_SYNC_SUBJECT_RE,
  parseArgs,
  enumerateSharedFiles,
  classify,
  run,
  DidNotRun,
};
