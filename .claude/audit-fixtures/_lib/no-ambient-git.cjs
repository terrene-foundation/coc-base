"use strict";
/**
 * no-ambient-git — the ONE line every process-spawning harness imports FIRST.
 *
 *     import "../../audit-fixtures/_lib/no-ambient-git.cjs";   // ESM, first import
 *     require("../../../.claude/audit-fixtures/_lib/no-ambient-git.cjs"); // CJS
 *
 * Importing it removes every ambient `GIT_*` variable from `process.env` (keeping
 * only the loom#1903 neutralizer pins a runner handed down), so no git this process
 * spawns — directly, through a wrapper, or inside a `node` child — can be answered
 * by a repository the parent environment named. The why, and the one carve-out,
 * live on `fixture-git-env.cjs::stripAmbientGit` / `scrubAmbientGit`.
 *
 * It then INSTALLS the neutralizer pins (`installFixtureGitEnv`): global and system
 * config at the null device, plus the fixture identity. Stripping `GIT_*` cannot
 * stop the OTHER ambient channel — git finds the operator's global config through
 * `HOME` / `XDG_CONFIG_HOME`, not through any `GIT_*` variable — so without the pins
 * a harness git still reads the operator's `user.name`, `commit.gpgsign` (true on
 * the authoring machine), `core.hooksPath` and `init.templateDir`. Until this, only
 * fixtures launched by `run-audit-fixtures.mjs` got the pins; a test-harness suite
 * or a `tests/` file never did.
 *
 * MEASURED before adopting it, on a host whose global config sets
 * `user.name=<operator>` (so a harness silently depending on the operator identity
 * would have broken): the bulk harness corpus ran 264/267 with 5437 cases — the
 * same suites and count as without the pins, the 3 reds being history-dependent
 * suites that red identically either way — and `tests/integration` ran 1462 pass
 * of 1472, its one red being the operator-id case that failed identically without
 * the pins (fixed separately, below). A sweep of every harness for `--global`,
 * `--show-origin`, `.gitconfig` and `XDG_CONFIG_HOME` found only harnesses that
 * PLANT their own config; none reads the operator's.
 *
 * THE RISK THE PINS CARRY, and how it is contained. The pins live in the harness's
 * own process.env, which production code under test ALSO reads. A production env
 * builder that regressed to forwarding process.env would inherit them and look
 * hermetic — the review measured exactly that masking a security assertion
 * (git-env-config-profile-f1-1471 F1-S3). Contained IN-PROCESS: the exports of
 * hooks/lib/git-subprocess-env.js are wrapped below to run with the pins lifted.
 * NOT contained for a production process spawned as a CHILD with an env built from
 * `{ ...process.env }`: it inherits the pins, and a pinned variable cannot be
 * asserted through it. A test asserting a production child's config / prompt /
 * pager / identity neutralisation MUST hand that child an env built from
 * `stripAmbientGit` with the pins deleted (as harness-git-env-regrowth H5 does),
 * never from `process.env`. Swept when this was written: none does.
 *
 * NOT REACHED BY THIS: hook code that reads config through
 * `git-subprocess-env.js::gitConfigInvocation`, which derives HOME from passwd and
 * drops GIT_CONFIG_GLOBAL on purpose (loom#1471 F1). A harness exercising that
 * profile sees the operator's real global config whatever its env says; it must
 * not assert on the value (see `tests/integration/operator-id.test.js::SECOND_HUMAN`).
 *
 * WHY A SIDE-EFFECT MODULE AND NOT A CALL. An ESM file's static imports are all
 * evaluated BEFORE its body runs, so a `scrubAmbientGit()` call in the body runs
 * after every imported module has already read `process.env` — a helper that
 * captured `{ ...process.env }` at load would keep `GIT_DIR`. Imports are evaluated
 * in declaration order, so this module, imported FIRST, runs before any of them.
 * The regrowth guard (`harness-git-env-regrowth.test.mjs`) checks that position.
 *
 * `.cjs` for the reason `fixture-git-env.cjs` gives: consumers are both ESM and
 * CommonJS, and CI pins node 20, where `require()` of an ESM module throws.
 */

const envLib = require("./fixture-git-env.cjs");
envLib.installFixtureGitEnv();

// The production git-env builders run WITHOUT the pins just installed — see
// `fixture-git-env.cjs::liftHarnessPins` for the masked assertion that forced this.
// Loaded HERE, before any other import, so every later consumer (a test's own
// import, or operator-id.js / state-resolver.js loaded in-process) binds the wrapped
// functions from the shared exports object.
envLib.wrapPinFree(require("../../hooks/lib/git-subprocess-env.js"));
