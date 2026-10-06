/**
 * repo-dir-override — THE shared, repo-BOUND resolution of
 * `COC_OPERATOR_REPO_DIR` for every guard that reads it.
 *
 * ── THE DEFECT (loom#1871 follow-up, HIGH-1) ────────────────────────────────
 *
 * Eight hooks resolved their repo root as, in effect,
 *
 *     const envDir = process.env.COC_OPERATOR_REPO_DIR;
 *     if (envDir && fs.existsSync(envDir)) return envDir;
 *
 * i.e. an env var was honoured on the sole evidence that the named directory
 * EXISTS. That value is the jurisdiction basis for every gate below it, so one
 * line in a `settings.json` `env:` block plus a `git init` moved the whole fence
 * to an unrelated repository. This is the same ordinary-looking-config-edit
 * delivery vector loom#1871's own comment names for the knob it DID fix.
 *
 * MEASURED, two-pole, all EIGHT readers, with each hook's refusal established on
 * pole B first: 8 of 8 pass through under the override, every one printing
 * `exit 0` + a bare `{"continue":true}` with no `hookSpecificOutput` — an output
 * unreachable on pole B. SIX of the eight refuse with `exit 2` on pole B, so the
 * override converts a hard deny into a silent pass.
 *
 * ── THREE ARMS, ONE ROOT CAUSE ──────────────────────────────────────────────
 *
 * The escape is NOT one branch, which is why a per-arm fix does not close it:
 *
 *   UNWATCHED-PATH   integrity-guard, journal-write-guard, session-notes-guard,
 *                    analyze-completeness-guard. `requireMainCheckout(decoy)`
 *                    SUCCEEDS — a `git init` directory IS a genuine checkout
 *                    root — so the guard never takes its own fail-closed branch;
 *                    it proceeds with `repoDir = decoy`, sees the real target as
 *                    out-of-tree, and passes through.
 *   COORDINATION-OFF signing-mutation-guard, adjacency-leasecheck,
 *                    genesis-anchor-guard. `isCoordinationEnabled(decoy)` is
 *                    false and that branch calls `passthrough()`, upstream of
 *                    every substantive check.
 *   OVERRIDE-HONORED probe-phase-guard, which reaches its own gate with the
 *                    wrong jurisdiction.
 *
 * All three become unreachable once the RESOLVER refuses, which is why this
 * lives here and not in eight patches.
 *
 * ── WHY `provenCheckoutRoot` IS NOT ENOUGH ──────────────────────────────────
 *
 * probe-phase-guard was hardened for THIS EXACT DEFECT (loom#1473 / #1586) with
 * `provenCheckoutRoot`, and reproduces anyway — its own header admits the
 * `git init` residual. That predicate asks "is this A checkout root?", and a
 * fresh `git init` answers yes. So a grep for `provenCheckoutRoot` makes a site
 * look fixed when it is not, and any fix that merely reuses it is not a fix.
 *
 * THE PREDICATE HERE IS REPO IDENTITY, NOT ROOT-NESS: the override is honoured
 * only when its `git rev-parse --git-common-dir` equals the common-dir of the
 * override-FREE seed. A linked worktree's common dir IS the main checkout's
 * `.git`, so this admits the whole legitimate worktree forest; a fresh
 * `git init` elsewhere can never satisfy it, because it names its own `.git`.
 * The same `--git-common-dir` identity guard-path-scope.js already relies on.
 *
 * ── WHAT IT COSTS ───────────────────────────────────────────────────────────
 *
 * `COC_OPERATOR_REPO_DIR` is load-bearing test injection. Pointing it at a
 * fixture repo still works whenever the driving payload's `cwd` is that same
 * fixture — the overwhelmingly common shape, since a test that injects a
 * fixture root drives the hook from inside it. What NO LONGER works is
 * injecting a fixture root while the session cwd is a DIFFERENT repository:
 * there the override is IGNORED (loudly, on stderr) and resolution falls back
 * to the seed. That is the attack shape, and it is also a real cost to any test
 * written in that style; such a test must drive with `cwd` set to the fixture.
 *
 * The seed deliberately EXCLUDES `CLAUDE_PROJECT_DIR` as well. An attacker able
 * to add `COC_OPERATOR_REPO_DIR` to a `settings.json` `env:` block is equally
 * able to add `CLAUDE_PROJECT_DIR`, so corroborating one env var against another
 * would be no corroboration at all. `payload.cwd` is reported by the harness,
 * not by the settings file, which is what makes it usable as the baseline.
 *
 * FAIL-CLOSED DIRECTION: when git cannot answer for EITHER side, the override is
 * IGNORED and the seed is used. Ignoring is the fail-closed direction here
 * because the seed is the real session repository — the fence then RUNS. This is
 * the opposite disposition from "refuse to run", and it is deliberate: the
 * resolver's job is to pick a jurisdiction, and the un-overridden session cwd is
 * always the more trustworthy of the two.
 *
 * Style: CommonJS, pure node builtins, matching sibling lib/* guard modules.
 * Never throws into a guard (zero-tolerance.md Rule 3).
 */

"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env.js");

const GIT_TIMEOUT_MS = 2000;

/**
 * The repository-identity token for `dir`: the realpath of its
 * `--git-common-dir`. Null when `dir` is not in a git repository, git is
 * unavailable, or the call errors — never throws.
 */
function repoIdentity(dir) {
  if (!dir || typeof dir !== "string") return null;
  const bin = resolveGitBinary();
  if (!bin) return null;
  let r;
  try {
    r = spawnSync(bin, ["rev-parse", "--git-common-dir"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      // NOTHING inherited — GIT_DIR and family cannot steer which repository
      // answers (loom#1462 F1 / loom#1471).
      env: gitEnv(),
    });
  } catch {
    return null;
  }
  if (!r || r.status !== 0) return null;
  const out = String(r.stdout || "").trim();
  if (!out) return null;
  // `--git-common-dir` may come back relative to `cwd`.
  const abs = require("path").isAbsolute(out)
    ? out
    : require("path").resolve(dir, out);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/** The seed a guard would use with the env override absent. */
function unoverriddenSeed(payload) {
  if (payload && typeof payload.cwd === "string" && payload.cwd.length > 0) {
    return payload.cwd;
  }
  return process.cwd();
}

/**
 * Resolve the repo root, honouring `COC_OPERATOR_REPO_DIR` ONLY when it names
 * the SAME repository as the override-free seed.
 *
 * @param {object} payload  the hook payload (its `cwd` is the baseline)
 * @param {object} [opts]
 *   - hookName {string}  used only in the stderr refusal note
 *   - quiet    {boolean} suppress the stderr note (tests)
 * @returns {{repoDir: string, overrideRefused: boolean, reason: string|null}}
 */
function resolveRepoDirBound(payload, opts) {
  const o = opts || {};
  const seed = unoverriddenSeed(payload);
  const envDir = process.env.COC_OPERATOR_REPO_DIR;
  if (!envDir) return { repoDir: seed, overrideRefused: false, reason: null };

  // session-notes-guard.js read this variable with NO existence check at all,
  // so a nonexistent path became the repo root outright. The check is here now,
  // once, for every reader.
  if (!fs.existsSync(envDir)) {
    return refuse(seed, `the path does not exist: ${envDir}`, o);
  }
  const envId = repoIdentity(envDir);
  const seedId = repoIdentity(seed);
  if (!envId || !seedId) {
    return refuse(
      seed,
      `git could not establish repository identity for ${!envId ? `the override (${envDir})` : `the session cwd (${seed})`}`,
      o,
    );
  }
  if (envId !== seedId) {
    return refuse(
      seed,
      `the override names a DIFFERENT repository (${envId}) than the session (${seedId})`,
      o,
    );
  }
  return { repoDir: envDir, overrideRefused: false, reason: null };
}

function refuse(seed, reason, o) {
  if (!o.quiet) {
    try {
      // Format is load-bearing: `REFUSED $COC_OPERATOR_REPO_DIR=<dir>` is the
      // shape probe-phase-guard already announced and its loom#1473 suite
      // asserts on. One wording, every reader.
      process.stderr.write(
        `[${o.hookName || "coc-guard"}] REFUSED $COC_OPERATOR_REPO_DIR=${process.env.COC_OPERATOR_REPO_DIR} — ${reason}. ` +
          "Ignoring the override and resolving from the session cwd (loom#1871).\n",
      );
    } catch {
      /* stderr unavailable — never throw into a guard (zero-tolerance.md Rule 3) */
    }
  }
  return { repoDir: seed, overrideRefused: true, reason };
}

module.exports = {
  resolveRepoDirBound,
  unoverriddenSeed,
  // Test-only — NOT part of the supported API.
  _test_repoIdentity: repoIdentity,
};
