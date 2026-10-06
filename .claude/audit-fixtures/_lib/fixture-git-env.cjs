"use strict";
/**
 * fixture-git-env — THE shared git environment for every fixture harness that
 * builds a repository, and the shared classifier that keeps an ENVIRONMENT ABORT
 * distinguishable from a MUTANT KILL (loom#1903).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS EXISTS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * `git init` creates a repository with NO local config, so every subsequent
 * `git commit` in that fixture runs under the OPERATOR'S global config. Where
 * that config sets `commit.gpgsign=true`, every fixture commit spawns gpg. Under
 * concurrent runners gpg-agent contention makes the commit fail, and the throw
 * propagates out of `execFileSync` — usually inside a fixture CONSTRUCTOR,
 * mid-build.
 *
 * MEASURED on this tree, both poles, on a scratch repo (loom#1903 re-derivation):
 *
 *   pole                                                      commit.gpgsign
 *   ─────────────────────────────────────────────────────────  ──────────────
 *   fresh `git init`, operator env                             true   ← leaks
 *   same repo, `--local` only                                  (empty) ← nothing overrides
 *   GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null    (empty) ← closed
 *
 * And the abort itself, forced deterministically with a `gpg.program` that fails
 * (the same failure MODE contention produces, without needing contention):
 *
 *   $ git commit -m t                     # under a leaking global config
 *   error: gpg failed to sign the data:
 *   gpg: signing failed: No pinentry
 *   fatal: failed to write commit object
 *   exit 128
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A RULE-CLASS DEFECT AND NOT A FLAKE
 * ─────────────────────────────────────────────────────────────────────────────
 * A fixture-construction throw is reported by a mutation harness as a test FAIL,
 * which is BYTE-IDENTICAL to a genuine mutant kill. So the leak does not merely
 * flake — it INFLATES kill counts, and kill counts are exactly the evidence a
 * lane cites to claim its tests are load-bearing. The harness reports stronger
 * coverage than it has, in the direction nobody audits.
 *
 * That is `rules/instrument-discipline.md` MUST-1 in its literal form: an
 * instrument whose output is the same whether the proposition is true or false
 * carries zero information. MUST-2 then makes the consequence explicit — a green
 * (or here, a RED) that cannot be shown to discriminate is not a verdict.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO HALVES, AND WHY BOTH ARE NEEDED
 * ─────────────────────────────────────────────────────────────────────────────
 * PREVENTION (`fixtureGitEnv` / `installFixtureGitEnv`) closes the leak. It is
 * necessary and NOT sufficient: it shuts the one variable measured today and
 * leaves the CLASS open, because the next environmental abort — a missing
 * identity, an unreadable config, a credential helper prompting — reproduces the
 * same indistinguishability with a different cause.
 *
 * DISCRIMINATION (`classifyGitFailure` + `ENV_ABORT_TAG` + `FIXTURE_ENV_ABORT_EXIT`)
 * closes the class. An environmental abort is reported with its OWN tag and its
 * OWN reserved exit code, so no environmental failure can ever again be scored as
 * a test failure — whatever causes it. This is the half that survives the next
 * variable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY .cjs AND NOT .mjs (measured, not stylistic)
 * ─────────────────────────────────────────────────────────────────────────────
 * Consumers span both module systems: `.claude/audit-fixtures/**` and
 * `.claude/bin/**` are ESM, `tests/integration/multi-operator/*.test.js` are CJS
 * (`package.json` declares no `"type"`, so `.js` is CommonJS). `require()` of an
 * ESM module is unflagged only from Node 22.12; **CI pins node-version "20"**
 * (`.github/workflows/coc-artifact-eval.yml`), where `require("./x.mjs")` throws
 * ERR_REQUIRE_ESM. A local node 25 reports it working, which is an instrument
 * scoped to the wrong host (`evidence-first-claims.md` MUST-6). CJS is the one
 * format both systems load on the pinned runtime, so this file is `.cjs`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT DO — named, not implied away
 * ─────────────────────────────────────────────────────────────────────────────
 * It does NOT monkey-patch `child_process`. That was evaluated and rejected on a
 * mechanism, not a preference: a consumer that writes
 * `import { execFileSync } from "node:child_process"` binds the builtin's ESM
 * namespace, which is materialised from the CJS exports at first evaluation and
 * does NOT observe a later mutation of them. A patch would therefore cover some
 * call sites and silently miss others — an instrument that fires unpredictably is
 * worse than one that does not fire, because its silence reads as clean.
 *
 * The reliable seams are the two used here instead: the ENVIRONMENT (inherited by
 * every spawn that does not pass an explicit `env:`) and the RUNNER (which owns
 * the child env and the verdict for every fixture it spawns).
 */

const os = require("node:os");

/**
 * Reserved exit code for an environmental abort. 78 is EX_CONFIG from
 * sysexits.h — "a configuration error", which is exactly what this is.
 *
 * The VALUE matters less than the fact that it is NOT 1: node exits 1 on an
 * uncaught throw and every test runner exits 1 on assertion failure, so 1 is the
 * one code that cannot discriminate. 2 is taken by usage errors in this repo's
 * tooling; 128 is what git itself returns and would be ambiguous with a real
 * git-level test expectation.
 */
const FIXTURE_ENV_ABORT_EXIT = 78;

/**
 * The greppable banner an aborting fixture prints. A runner that sees this in a
 * child's output knows the child's verdict is UNINTERPRETABLE without having to
 * re-derive the cause from raw git stderr.
 */
const ENV_ABORT_TAG = "##FIXTURE-ENV-ABORT##";

/**
 * Deterministic identity, supplied through the ENVIRONMENT rather than config.
 *
 * REQUIRED, not cosmetic. Neutralising the global config also removes the
 * operator's `user.name`/`user.email`, and a fixture that never sets them
 * repo-locally would then fail with "Please tell me who you are" — trading one
 * environmental abort for another. Measured on this tree: with these four set and
 * GIT_CONFIG_GLOBAL/SYSTEM at the null device, `git commit` exits 0 with no
 * user.* config anywhere. Without them the result is HOST-DEPENDENT — this
 * machine auto-detected an identity from gecos and succeeded, a CI runner with no
 * such data emits "unable to auto-detect email address" and exits 128. A fixture
 * whose success depends on the host's gecos field is not hermetic.
 *
 * Author and committer are BOTH set: git requires both, and a missing committer
 * is the failure that only appears on the host that lacks the fallback.
 */
const FIXTURE_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: "loom fixture",
  GIT_AUTHOR_EMAIL: "fixture@loom.invalid",
  GIT_COMMITTER_NAME: "loom fixture",
  GIT_COMMITTER_EMAIL: "fixture@loom.invalid",
});

/**
 * The variables that make a fixture repository depend on nothing outside itself.
 *
 * `os.devNull` rather than a hardcoded "/dev/null": the literal is not
 * Windows-portable and resolves to "NUL" on win32. Nine sites in this repo
 * hardcode the string and one uses `os.devNull`; this is the portable form.
 */
const GIT_NEUTRALIZERS = Object.freeze({
  // The leak this rule exists for: global + system config, including gpgsign.
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  // A fixture must never block on a human. Without this a credential or
  // pinentry prompt hangs the runner until its timeout, which is reported as a
  // TIMEOUT — a third way for an environmental fault to wear a test's clothes.
  GIT_TERMINAL_PROMPT: "0",
  // Deterministic output shape for anything that parses git's stdout.
  GIT_PAGER: "cat",
  LC_ALL: "C",
  ...FIXTURE_IDENTITY,
});

/**
 * Build the environment for a fixture-spawned git.
 *
 * Layered ON TOP of the ambient environment, deliberately — unlike
 * `hooks/lib/git-subprocess-env.js::gitEnv()`, which builds a constants-only env
 * from scratch. That function is a SECURITY fence for a guard subprocess and
 * pins `PATH` to "/usr/bin:/bin"; a fixture harness needs the operator's PATH to
 * find git at all (homebrew, nix and asdf all install outside those two
 * directories), and needs TMPDIR/HOME for scratch trees. The threat models
 * differ: that one is defending against a hostile ambient environment, this one
 * against an INCIDENTAL one. Same neutralizers, different base.
 *
 * The ambient base is taken WITHOUT its git variables (`stripAmbientGit`): PATH,
 * HOME and TMPDIR are what a fixture needs from the parent, and `GIT_DIR` is not.
 *
 * @param {object} [extra] — additional variables, applied last.
 * @returns {object} a new env object; the input is never mutated.
 */
function fixtureGitEnv(extra) {
  return Object.assign({}, stripAmbientGit(process.env), GIT_NEUTRALIZERS, extra || {});
}

/**
 * Is this environment variable one git reads — and so one that can STEER it?
 *
 * The whole `GIT_` prefix, not a named list. `GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`,
 * `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` and the rest
 * all re-point or re-configure the child, and a denylist of names is one variable
 * behind the next git release. Case-insensitive, because environment names are on
 * Windows. The same predicate `forest-ledger/hermetic-env.mjs` already used.
 */
function isGitVar(name) {
  return /^git_/i.test(name);
}

/**
 * A copy of `base` with every AMBIENT git variable removed.
 *
 * THE DEFECT THIS EXISTS FOR (the inherited-GIT_DIR class). A harness that spawns
 * `git` with no `env:` — or with `{ ...process.env, … }` — hands the child
 * whatever the PARENT was started with. Run the suite from inside a git hook (git
 * exports `GIT_DIR` and `GIT_INDEX_FILE` to every hook) or from a shell that set
 * `GIT_DIR`, and the harness's "fresh temp repo" is answered by a DIFFERENT
 * repository: `GIT_DIR` outranks discovery, and neither `cwd:` nor `-C` pins
 * which repository git resolves — both only choose a directory. The setup commits
 * land in the other repo and the assertions read the other repo's state, so the
 * suite's verdict describes a tree it never built. `fixtureGitEnv` used to spread
 * `process.env` under its neutralizers and so carried `GIT_DIR` straight through:
 * the helper named "hermetic" was the one site guaranteed to leak it.
 *
 * ONE CARVE-OUT, AND WHY IT IS NOT A HOLE. A variable survives only when it is one
 * of `GIT_NEUTRALIZERS` AND its value is byte-identical to the neutralizer's own
 * value. That is not ambient state — it is THIS module's pin, handed down by
 * `run-audit-fixtures.mjs` (loom#1903). Stripping it would re-open the gpgsign
 * leak and remove the fixture identity in every child the runner spawns. A
 * `GIT_CONFIG_GLOBAL` pointing anywhere OTHER than the null device is a steering
 * value and is dropped like any other.
 *
 * @param {object} [base] — defaults to `process.env`; never mutated.
 * @returns {object} a new env object.
 */
function stripAmbientGit(base) {
  const src = base || process.env;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (isGitVar(k) && !(Object.hasOwn(GIT_NEUTRALIZERS, k) && GIT_NEUTRALIZERS[k] === v)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Remove every ambient git variable from `target` IN PLACE (default
 * `process.env`), keeping only this module's own neutralizer pins (see
 * `stripAmbientGit`).
 *
 * THIS IS THE HARNESS-ENTRY SEAM. `no-ambient-git.cjs` calls it once, as the
 * FIRST import of every harness file that can spawn a process, so every spawn in
 * that process — the ones with no `env:`, the ones spreading `process.env`, the
 * ones hidden behind a local `git()` wrapper or a `run(cmd, …)` helper, AND a
 * `node` child that goes on to run git itself — starts from an environment with no
 * ambient steering in it. Converting call sites one by one cannot reach the last
 * two shapes; the process boundary reaches all of them.
 *
 * Idempotent. Mutating `process.env` is deliberate and bounded: it runs at entry,
 * before any test code, so a test that later SETS `GIT_DIR` on purpose (the
 * steering suites do, to prove a guard ignores it) is untouched.
 *
 * @param {object} [target] — defaults to `process.env`.
 * @returns {string[]} the names removed, sorted — for logging and assertion.
 */
function scrubAmbientGit(target) {
  const env = target || process.env;
  const kept = stripAmbientGit(env);
  const removed = Object.keys(env).filter((k) => isGitVar(k) && !Object.hasOwn(kept, k));
  for (const k of removed) delete env[k];
  return removed.sort();
}

/**
 * Install the neutralizers into `process.env` for the CURRENT process.
 *
 * This is the one-line adoption path, and it is what makes the fix a shared
 * mechanism rather than 65 separate patches. Any spawn that does NOT pass an
 * explicit `env:` inherits `process.env`, so a single call at the top of a
 * harness covers every `execFileSync("git", …)` / `spawnSync("git", …)` in that
 * file without editing any of them. Idempotent; safe to call more than once.
 *
 * Deliberately does NOT set GIT_CONFIG_COUNT/KEY/VALUE. Those would force
 * `commit.gpgsign=false` at `-c` precedence (above even repo-local config), which
 * is strictly tighter — but ten files in this tree already read or assert on
 * GIT_CONFIG_COUNT (`git-env-config-profile-f1-1471.test.mjs` alone uses it seven
 * times), and clobbering a variable other suites measure would break them to fix
 * this. The null-device neutralization is MEASURED sufficient for the leak
 * (pole 3 above), so the tighter form buys nothing here and costs collisions.
 *
 * @returns {object} the variables actually applied, for logging/assertion.
 */
function installFixtureGitEnv() {
  scrubAmbientGit(process.env);
  Object.assign(process.env, GIT_NEUTRALIZERS);
  return { ...GIT_NEUTRALIZERS };
}

/**
 * Remove THIS module's pins from `target` (default `process.env`) and return a
 * function that puts them back. Only a variable whose value is byte-identical to the
 * pin is lifted — anything a test set on purpose is left alone.
 *
 * WHY THIS EXISTS (review finding, loom harness-git-env lane). `installFixtureGitEnv`
 * writes the pins into the harness's OWN process.env, and production code under test
 * reads that same process.env. So a production env builder that regressed to
 * forwarding process.env — and dropped its own config pins in the same edit — would
 * INHERIT the harness's `GIT_CONFIG_GLOBAL=/dev/null`, and every assertion that it
 * "cannot see global config" would stay green over the regression. Measured on
 * `git-env-config-profile-f1-1471` F1-S3: red on dev, green on the pinned branch,
 * under exactly that mutation of `gitEnv()`. A security assertion that passes
 * whether or not the code is broken is not an assertion.
 *
 * @param {object} [target]
 * @returns {() => void} restore
 */
function liftHarnessPins(target) {
  const env = target || process.env;
  const saved = {};
  for (const [k, v] of Object.entries(GIT_NEUTRALIZERS)) {
    if (Object.hasOwn(env, k) && env[k] === v) {
      saved[k] = v;
      delete env[k];
    }
  }
  return () => Object.assign(env, saved);
}

const PIN_FREE = Symbol.for("loom.fixture-git-env.pin-free");

/**
 * Replace every plain-function export of `exportsObj` IN PLACE with a wrapper that
 * runs it with the harness pins lifted (`liftHarnessPins`), so a production env
 * builder is always measured against the environment it would see WITHOUT this
 * harness. The builders are synchronous, so lift-call-restore cannot interleave with
 * other code. Constructors (capitalised names, e.g. `GitConfigProfileError`) are
 * left alone so `instanceof` still holds. Idempotent; the original is kept on the
 * wrapper under `Symbol.for("loom.fixture-git-env.pin-free")`.
 *
 * In place, not a copy, because production modules load it by `require` and
 * destructure at THEIR load time: patching the shared exports object before any of
 * them loads is what makes an in-process call from operator-id.js, state-resolver.js
 * and the rest reach the wrapper too, not only a test's direct call.
 *
 * @param {object} exportsObj
 * @returns {object} the same object
 */
function wrapPinFree(exportsObj) {
  for (const [name, fn] of Object.entries(exportsObj)) {
    if (typeof fn !== "function" || fn[PIN_FREE] || /^[A-Z]/.test(name)) continue;
    const wrapped = function (...args) {
      const restore = liftHarnessPins(process.env);
      try {
        return fn.apply(this, args);
      } finally {
        restore();
      }
    };
    Object.defineProperty(wrapped, "name", { value: fn.name });
    Object.defineProperty(wrapped, "length", { value: fn.length });
    wrapped[PIN_FREE] = fn;
    exportsObj[name] = wrapped;
  }
  return exportsObj;
}

/**
 * Signatures of an ENVIRONMENTAL abort, as git itself prints them.
 *
 * Every pattern is ANCHORED to the start of a line and to git's own message
 * prefixes (`error:` / `fatal:` / `gpg:`). That is what keeps the classifier from
 * firing on a fixture that merely MENTIONS one of these strings in an assertion
 * message or an expected-output file — the mention would not carry the prefix at
 * line start. The residual is named rather than claimed shut: a fixture that
 * deliberately REPLAYS verbatim git error output on stderr while exiting non-zero
 * would be classified as an abort. None exists in this tree today; if one is
 * added, it must print the replay on stdout or the classifier must learn it.
 */
const ENV_ABORT_SIGNATURES = Object.freeze([
  /^error: gpg failed to sign the data/m,
  /^fatal: failed to write commit object/m,
  /^gpg: (?:signing failed|no default secret key|skipped)/m,
  /^error: cannot run gpg/m,
  /^fatal: unable to auto-detect email address/m,
  /^\*\*\* Please tell me who you are/m,
  /^fatal: could not (?:read|lock) config file/m,
  /^error: unable to start editor/m,
]);

/**
 * Decide whether a failed git-bearing process failed for an ENVIRONMENTAL reason.
 *
 * NAMES ITS FALSIFYING RESULT (`instrument-discipline.md` MUST-1): it returns
 * `null` for a non-zero exit whose output carries none of the signatures above —
 * i.e. an ordinary test failure — and a populated object only when a signature is
 * present. Both branches are exercised by the runner's self-check, so the
 * instrument is shown to fire HERE rather than assumed to (MUST-3a).
 *
 * A ZERO exit is never an abort, whatever the output says: a process that
 * completed successfully has, by definition, not been aborted. Checking status
 * first is what stops a fixture that PRINTS git error text while passing from
 * being reclassified.
 *
 * @param {number|null} status — child exit code (`null` when killed by signal).
 * @param {string} output — the child's combined stdout+stderr.
 * @returns {{signature: string, tagged: boolean}|null}
 */
function classifyGitFailure(status, output) {
  if (status === 0) return null;
  const text = typeof output === "string" ? output : "";
  if (text.includes(ENV_ABORT_TAG)) {
    return { signature: ENV_ABORT_TAG, tagged: true };
  }
  for (const re of ENV_ABORT_SIGNATURES) {
    const m = re.exec(text);
    if (m) return { signature: m[0].trim(), tagged: false };
  }
  return null;
}

/**
 * Positive control: prove the pin is ACTUALLY in force in this process.
 *
 * A fixture that calls `installFixtureGitEnv()` and then asserts nothing has only
 * shown that the call did not throw. This reads the effective value back out of
 * git itself — the same question the leak is about — so a harness can demonstrate
 * hermeticity instead of asserting it. Returns the offending keys rather than
 * throwing, so the caller chooses the disposition.
 *
 * @param {object} [cp] — injection seam for tests; defaults to node:child_process.
 * @returns {string[]} empty when hermetic; the leaking config keys otherwise.
 */
function checkHermetic(cp) {
  const { execFileSync } = cp || require("node:child_process");
  const leaks = [];
  for (const key of ["commit.gpgsign", "tag.gpgsign"]) {
    let value = "";
    try {
      value = String(
        execFileSync("git", ["config", "--get", key], {
          encoding: "utf8",
          env: fixtureGitEnv(),
          stdio: ["ignore", "pipe", "ignore"],
        }),
      ).trim();
    } catch {
      // `git config --get` exits 1 when the key is unset. That is the HERMETIC
      // answer, not an error — the whole point is that the key resolves to
      // nothing once global and system config are neutralized.
      value = "";
    }
    if (value && value !== "false") leaks.push(`${key}=${value}`);
  }
  return leaks;
}

module.exports = {
  FIXTURE_ENV_ABORT_EXIT,
  ENV_ABORT_TAG,
  GIT_NEUTRALIZERS,
  FIXTURE_IDENTITY,
  fixtureGitEnv,
  installFixtureGitEnv,
  stripAmbientGit,
  scrubAmbientGit,
  liftHarnessPins,
  wrapPinFree,
  PIN_FREE,
  classifyGitFailure,
  checkHermetic,
  // Test-only — NOT part of the supported API.
  _test_ENV_ABORT_SIGNATURES: ENV_ABORT_SIGNATURES,
};
