#!/usr/bin/env node
/*
 * Audit-fixture runner for the worktree-LIFETIME conservation gate
 * (`.claude/hooks/lib/worktree-conservation.js` +
 * `.claude/hooks/worktree-conservation-guard.js`).
 *
 * THREE ARMS, and the third is not optional.
 *
 *   ARM 1 (classifyTree table). One `classify-*.json` per scope-restriction
 *   predicate — the WIP window, the PARKED window, the clean predicate, the
 *   unmeasured state, the content-over-root precedence, and both fallbacks —
 *   each in the polarity that locks its comparison direction, per
 *   `cc-artifacts.md` Rule 9. Facts are INJECTED, so this arm is deterministic:
 *   no git, no clock, no filesystem.
 *
 *   ARM 2 (evaluateConservation table). One `finding-*.json` per branch of the
 *   finding predicate, including the two that must stay SILENT (a failed survey,
 *   and a forest that is entirely unmeasured). The silent cases are the ones
 *   that keep the gate from being disabled for noise, so they are fixtures, not
 *   comments.
 *
 *   ARM 3 (real git). Arms 1 and 2 hand the classifier its facts, so on their
 *   own they say NOTHING about whether the code that PRODUCES those facts can
 *   tell a dirty tree from a clean one — a green Arm 1 is fully consistent with
 *   a `measureTree` that returns `dirty: 0` for everything. That is
 *   `instrument-discipline.md` MUST-2(a) exactly: a green reports on the
 *   behaviour it NAMES, and Arms 1-2 do not name this one. Arm 3 therefore
 *   builds a throwaway repository with three real worktrees — one clean, one
 *   dirty and freshly written, one dirty with its content backdated past the WIP
 *   window — and asserts the REAL survey returns three DIFFERENT answers. It
 *   also asserts the falsifying result is reachable: the same forest under a
 *   1 ms budget must report UNMEASURED rather than clean.
 *
 * Exits non-zero on the first mismatch, printing expected vs actual.
 */

import "../_lib/no-ambient-git.cjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const LIB = require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "worktree-conservation.js"));

let cases = 0;
const failures = [];

// Emitting ONE `PASS <name>` / `FAIL <name>` line PER CASE is load-bearing, not
// cosmetic. `run-audit-fixtures.mjs` counts cases with `/^[ \t]*(?:PASS|ok)[ \t]+\S/`
// and deliberately does NOT count a summary line ("a bare PASS or ALL PASS or
// '8/10 fixtures pass' is not a case"). This runner previously printed only its
// summary, so the registry observed 0 cases against a declared min_cases 24: it
// exited 0 while contributing NO coverage — exactly the state
// `coc-artifact-eval-coverage.md` MUST-3 refuses to read as a pass, and the reason
// the floor exists. Do not "tidy" these lines away.
function check(name, expected, actual) {
  cases++;
  if (String(expected).trim() !== String(actual).trim()) {
    failures.push(`  ${name}\n      expected: ${expected}\n      actual:   ${actual}`);
    console.log(`FAIL ${name}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

// ── ARM 1 + 2: the fixture tables ───────────────────────────────────────────

for (const f of fs.readdirSync(HERE).filter((n) => n.endsWith(".json")).sort()) {
  const body = JSON.parse(fs.readFileSync(path.join(HERE, f), "utf8"));
  const expected = fs.readFileSync(path.join(HERE, f.replace(/\.json$/, ".expected")), "utf8");
  if (body.arm === "classifyTree") {
    check(f, expected, LIB.classifyTree(body.facts, body.cfg));
  } else if (body.arm === "evaluateConservation") {
    check(f, expected, LIB.evaluateConservation(body.survey) ? "fires" : "silent");
  } else if (body.arm === "classifyTreeDefaultCfg") {
    // loom#2005. The classify fixtures above pass `cfg` EXPLICITLY, which is good
    // isolation for the classifier and means NOTHING here covered the DEFAULT window.
    // Changing that default from 20 to 60 minutes broke not one case — the constant
    // was live and unpinned. These cases drive `resolveConfig({})` so the shipped
    // default is what classifies, and a silent narrowing of it reds.
    check(f, expected, LIB.classifyTree(body.facts, LIB.resolveConfig({})));
  } else {
    failures.push(`  ${f}\n      unknown arm: ${body.arm}`);
    cases++;
  }
}

// ── ARM 3: the same predicates against real git ─────────────────────────────

const git = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coc-conservation-"));
try {
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "fixture@example.invalid"], repo);
  git(["config", "user.name", "fixture"], repo);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "seed"], repo);

  const wt = (name) => {
    const p = path.join(tmp, name);
    git(["worktree", "add", "-q", "-b", `lane/${name}`, p], repo);
    return p;
  };
  const clean = wt("clean-lane");
  const fresh = wt("fresh-lane");
  const quiet = wt("quiet-lane");

  fs.writeFileSync(path.join(fresh, "in-flight.txt"), "being written right now\n");
  const quietFile = path.join(quiet, "abandoned.txt");
  fs.writeFileSync(quietFile, "written, then the lane went silent\n");

  // Backdate the abandoned file 2 h — past the 20 min WIP window, inside the
  // 24 h PARKED window. This is the at-risk shape, produced through the real
  // filesystem rather than injected.
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(quietFile, twoHoursAgo, twoHoursAgo);

  const cfg = LIB.resolveConfig({});
  const survey = await LIB.surveyForest(repo, cfg);
  const state = (p) => (survey.trees.find((t) => t.path === fs.realpathSync(p)) || {}).state;

  check("arm3/real-git/survey-ok", "true", String(survey.ok));
  check("arm3/real-git/clean-lane", "clean", state(clean));
  check("arm3/real-git/fresh-lane-is-wip", "wip", state(fresh));
  check("arm3/real-git/quiet-lane-is-at-risk", "at-risk", state(quiet));
  check("arm3/real-git/finding-fires", "fires", LIB.evaluateConservation(survey) ? "fires" : "silent");

  // The falsifying result must be REACHABLE from the same forest: with the
  // budget spent, the answer is UNMEASURED and the gate goes silent — it does
  // NOT report the unmeasured trees as clean, and does NOT keep alarming.
  const starved = await LIB.surveyForest(repo, { ...cfg, budgetMs: 1 }, { startedAt: Date.now() - 10_000 });
  check("arm3/real-git/starved-is-unmeasured", "true", String(starved.counts.unmeasured === starved.census));
  check("arm3/real-git/starved-reports-no-clean", "0", String(starved.counts.clean));
  check("arm3/real-git/starved-is-silent", "silent", LIB.evaluateConservation(starved) ? "fires" : "silent");
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort — a leftover temp dir is not a test failure */
  }
}

// ── DECLARED EXCLUSION (2026-08-27) ─────────────────────────────────────────
// Regression lock for the fix to a false-positive class this guard shipped with:
// it fired on 103 uncommitted paths that were ALL under the operator's scratch
// surface, a directory the operator has standing instructions never to `git add`.
// The finding was therefore not agent-clearable, which is the disposition this
// guard's own producer comment bars — so the guard failed its own admission test
// and would have cried wolf every session.
//
// The asserted prefix moved from `.claude/.prb/` to `.claude/.scratch/` when the
// mixed `.prb` surface was split by kind (durable findings to `workspaces/`,
// staging to the gitignored `.claude/.scratch/`). `.prb` no longer exists, so
// asserting on it would have locked in an exclusion that excludes nothing —
// a green that survives the deletion of its own subject.
//
// Bipolar on every arm: an exclusion that swallowed everything would be just as
// wrong as one that swallowed nothing.
check(
  "exclusion · the DEFAULT excludes the scratch prefix",
  "true",
  String(LIB.resolveExcludes({}).includes(".claude/.scratch/")),
);
check(
  "exclusion · the DEFAULT no longer names the retired .prb surface",
  "false",
  String(LIB.resolveExcludes({}).includes(".claude/.prb/")),
);
check(
  "exclusion · an EMPTY env value means exclude NOTHING (strictest, reachable)",
  "0",
  String(LIB.resolveExcludes({ COC_CONSERVATION_EXCLUDE: "" }).length),
);
check(
  "exclusion · an explicit value REPLACES the default rather than extending it",
  "false",
  String(
    LIB.resolveExcludes({ COC_CONSERVATION_EXCLUDE: "some/other/" }).includes(".claude/.scratch/"),
  ),
);
check(
  "exclusion · an absent env var is NOT the same as an empty one",
  "true",
  String(LIB.resolveExcludes({}).length > 0),
);

if (failures.length) {
  console.error(`worktree-conservation fixtures: ${failures.length} of ${cases} FAILED\n`);
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`worktree-conservation fixtures: ${cases}/${cases} passed`);
