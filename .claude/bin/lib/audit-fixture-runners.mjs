/*
 * audit-fixture-runners.mjs — the ONE definition of "this directory declares a
 * runner" for `.claude/audit-fixtures/`.
 *
 * WHY THIS MODULE EXISTS (loom#2044)
 *   The question "does this fixture directory have a runner?" was answered
 *   INDEPENDENTLY in three places, and the three answers drifted:
 *
 *     - `run-audit-fixtures.mjs`                      accepted run.mjs AND run.cjs
 *     - `check-fixture-consumers.mjs::hasRunner`      accepted run.mjs ONLY
 *     - `audit-fixture-tempdir-uniqueness.test.mjs`   accepted run.mjs ONLY
 *
 *   loom#2058 widened the FIRST one after measuring that
 *   `analyze-completeness-guard/run.cjs` is a real runner — 9 fixtures, exit 0 —
 *   that the gate had NEVER executed, invisible for want of one letter on a green
 *   tree. The two siblings did not learn it. That is the same
 *   enforcement-surface-parity shape `security.md` § Enforcement-Surface Parity
 *   names: a dimension promoted at one surface, with the independent surfaces
 *   left blind.
 *
 *   MEASURED at authoring: the drift was live and already miscounting. On the
 *   same tree `run-audit-fixtures.mjs --closure-only` resolved 94 runners while
 *   `check-fixture-consumers.mjs` classified 93 as `runner` — the missing one
 *   being `analyze-completeness-guard`, which fell through to `referenced`
 *   because it happens ALSO to be referenced. That coincidence is the whole
 *   danger: a run.cjs directory that is NOT otherwise referenced is reported
 *   `ORPHAN` despite carrying a registered runner, and a run.cjs directory
 *   MISSING from the registry escapes the population gate's own
 *   `runner-unregistered` arm entirely — the arm that exists to be the
 *   independent second opinion.
 *
 *   So the repair is NOT to widen the two string literals. Three copies of a
 *   predicate is the defect; a fourth copy written correctly today is the same
 *   defect waiting. The predicate lives here, once, and every consumer resolves
 *   through it, so the NEXT accepted basename reaches every gate by construction
 *   rather than by whoever remembers to sweep.
 *
 *   `audit-fixture-runner-basename-parity.test.mjs` reds if a consumer
 *   re-hardcodes the literal instead of importing from here, which is what keeps
 *   that property true rather than merely intended.
 *
 * SCOPE, stated rather than implied: this module answers ONE question — which
 * file in a directory is its runner. It says nothing about whether that runner is
 * registered, discriminates, or still matches the code it pins. Those are the
 * registry closure's, the mutation's, and the fixture author's questions.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The runner basenames this closure accepts. Both are node-executable module
 * forms, which is the whole criterion — callers spawn `node <file>` and do not
 * care which. Anything else matching RUNNER_LIKE is refused BY NAME rather than
 * skipped, so a future `run.js` reds the gate instead of disappearing from it the
 * way `run.cjs` did.
 */
export const RUNNER_BASENAMES = ["run.mjs", "run.cjs"];
export const RUNNER_LIKE = /^run\.[A-Za-z0-9]+$/;

/**
 * Resolve one directory's runner.
 *
 * Returns `{ file }` when exactly one accepted runner is present, `{ problem }`
 * when the directory holds a runner-shaped file this closure will not execute or
 * holds two it cannot choose between, and `null` when the directory is simply not
 * a runner directory (the ordinary case — most fixture dirs are data corpora
 * consumed by a probe or a sibling suite).
 */
export function resolveRunner(fixturesDir, dirName) {
  const full = join(fixturesDir, dirName);
  let entries;
  try {
    if (!statSync(full).isDirectory()) return null;
    entries = readdirSync(full);
  } catch {
    return null;
  }
  const accepted = RUNNER_BASENAMES.filter((b) => entries.includes(b));
  if (accepted.length === 1) return { file: join(full, accepted[0]) };
  if (accepted.length > 1) {
    return {
      problem:
        `AMBIGUOUS runner: ${dirName} holds ${accepted.join(" and ")}\n` +
        "    A directory declares exactly ONE runner. Two is not a first-match win —\n" +
        "    it is a question about which pins the fixtures, and only the author can answer it.",
    };
  }
  const runnerLike = entries.filter((e) => RUNNER_LIKE.test(e)).sort();
  if (runnerLike.length) {
    return {
      problem:
        `UNRECOGNIZED runner basename: ${dirName}/${runnerLike.join(", " + dirName + "/")}\n` +
        `    This closure executes ${RUNNER_BASENAMES.join(" or ")}. The file above is runner-shaped\n` +
        "    and would be SKIPPED SILENTLY, which is how analyze-completeness-guard/run.cjs ran\n" +
        "    9 fixtures that CI never saw (loom#2044). Rename it to an accepted basename, or add\n" +
        "    that basename to RUNNER_BASENAMES if it is genuinely node-executable.",
    };
  }
  return null;
}

/**
 * Every runner directory under the fixtures root — the closure's disk side.
 *
 * Returns `{ dirs, problems, runnerFile }`: the resolved runner directories, any
 * runner-shaped file this closure refuses to execute, and the dir -> file map.
 * The problems are RETURNED rather than swallowed, because a skipped runner is
 * precisely the failure this gate exists to catch and it must reach the caller as
 * an error, not a silence. Returns `null` when the fixtures root is absent, which
 * callers MUST distinguish from an empty corpus.
 */
export function discoverRunners(fixturesDir) {
  if (!existsSync(fixturesDir)) return null;
  const dirs = [];
  const problems = [];
  const runnerFile = new Map();
  for (const d of readdirSync(fixturesDir).sort()) {
    const resolved = resolveRunner(fixturesDir, d);
    if (!resolved) continue;
    if (resolved.problem) {
      problems.push(resolved.problem);
      continue;
    }
    dirs.push(d);
    runnerFile.set(d, resolved.file);
  }
  return { dirs, problems, runnerFile };
}

/**
 * Does this directory declare an accepted runner?
 *
 * Deliberately TRUE for the ambiguous / unrecognized cases too: a directory
 * holding a runner-shaped file is a runner directory whose runner is
 * MISCONFIGURED, and reporting it as "no runner" would route it to a consumer
 * gate's orphan or reference arm instead of to the closure that owns the
 * complaint. Callers wanting the executable file itself use `resolveRunner`.
 */
export function hasRunner(fixturesDir, dirName) {
  return resolveRunner(fixturesDir, dirName) !== null;
}
