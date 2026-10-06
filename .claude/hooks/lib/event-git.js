/**
 * event-git — ONE answer per distinct git question per hook EVENT.
 *
 * WHY. Measured on one PreToolUse Bash call before the consolidation: ~7–9
 * identical `git rev-parse --git-common-dir` spawns (every guard resolving the
 * main checkout for itself), because every cache in the repo was per-process
 * and every hook was its own process. With one dispatch.js process per event
 * the detectors of an event now share a process — so they can share the answer.
 *
 * THE SAFETY WINDOW IS ONE EVENT, AND IT IS NOT FILE-KEYED. A file-keyed git
 * memo was built and deleted on the perf/hook-cost lane after three security
 * reviews each found a staleness hole (pruned worktree gitdirs, retargeted
 * commondir, `[include]`d config): git's answer depends on more files than any
 * key can name. This module keys on the QUESTION only — (git binary, cwd, argv,
 * envelope) — and lives exactly one event:
 *   - sharing is ON only inside an event scope. There are TWO openers: the one
 *     dispatch.js opens with beginEventGit() BEFORE any detector runs and
 *     closes with endEventGit() after the last (the process then exits), AND —
 *     fw-tier2, 2026-10-05 — the four standalone hooks that run their own CLI
 *     path: adjacency-leasecheck, posture-gate, signing-mutation-guard and
 *     validate-bash-command each call installStandaloneEventScope() at entry,
 *     which opens the scope at load and closes it on exit. Nothing persists to
 *     disk in either shape. (This sentence previously said ONLY dispatch.js
 *     opens a scope and listed "a standalone hook" among the always-fresh
 *     cases — false for these four the moment fw-tier2 landed.)
 *   - OUTSIDE such a scope (a bin tool, a test that resolves the checkout,
 *     changes the repo, and resolves again, or a hook that does NOT install
 *     the standalone scope) every question is asked afresh — a long-lived
 *     process can never be served a stale answer.
 * Within an event no detector changes what these read-only questions answer
 * (PreToolUse runs before the tool; no detector commits or moves refs).
 *
 * A FAILURE STAYS A FAILURE. The recorded answer is whatever the first asker
 * got — including a non-zero exit, a timeout or a spawn error — and every later
 * asker in the event receives that same failure. A failed question is never
 * re-asked in the hope of a determinate answer, and never converted into one.
 *
 * Callers pass a `run()` that performs the spawn through the git subprocess
 * envelope (`git-subprocess-env.js::gitEnv`) and returns a plain, JSON-safe
 * result object; the stored copy is frozen and every caller gets its own clone.
 */
"use strict";

const path = require("path");

const answers = new Map();
let asked = 0;
let spawned = 0;
let scopeOpen = false;
let recordListener = null;

/** The identity of a question. `envelope` names the env builder the run() uses. */
function eventGitKey({ gitBin, cwd, args, envelope }) {
  if (!Array.isArray(args)) throw new TypeError("event-git: args must be an array");
  return JSON.stringify([String(gitBin || "git"), path.resolve(cwd || process.cwd()), args.map(String), String(envelope || "")]);
}

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/**
 * The event's answer to `key`, running `run()` only the first time it is asked.
 * `run()` MUST return a JSON-safe value describing the outcome (success AND
 * failure alike) and MUST NOT throw; a throw is recorded as a failure answer
 * `{ ok:false, thrown:<message> }` and re-thrown to every asker.
 */
function askOnce(key, run, opts = {}) {
  asked++;
  if (!scopeOpen) {
    spawned++;
    return run();
  }
  if (!answers.has(key)) {
    spawned++;
    let rec;
    try {
      rec = { value: clone(run()) };
    } catch (e) {
      rec = { thrown: { message: String((e && e.message) || e), code: e && e.code } };
    }
    // An outcome caused by the ASKER rather than by git — e.g. a timeout only
    // because the asker's remaining budget shortened the cap — is not git's
    // answer, so it is returned to that asker and NOT recorded: a later asker with
    // its own budget asks git itself.
    if (rec.value !== undefined && typeof opts.record === "function" && !opts.record(rec.value)) {
      return clone(rec.value);
    }
    answers.set(key, Object.freeze(rec));
    if (recordListener) {
      try {
        recordListener(key, rec);
      } catch {}
    }
  }
  const rec = answers.get(key);
  if (rec.thrown) {
    const err = new Error(rec.thrown.message);
    if (rec.thrown.code !== undefined) err.code = rec.thrown.code;
    throw err;
  }
  return clone(rec.value);
}

/** Open an event scope: sharing on, and no answer from any earlier event survives. */
function beginEventGit() {
  answers.clear();
  asked = 0;
  spawned = 0;
  scopeOpen = true;
}

/**
 * Carry answers already recorded in THIS event into a fresh context — used when
 * dispatch.js replaces a worker whose detector overran its budget, so a failure
 * recorded before the restart stays a failure after it.
 */
function seedEventGit(records) {
  if (!scopeOpen) throw new Error("event-git: seedEventGit outside an event scope");
  for (const [key, rec] of records || []) answers.set(key, Object.freeze(rec));
}

/** Observe each newly recorded answer (the worker forwards them to dispatch.js). */
function onRecord(fn) {
  recordListener = typeof fn === "function" ? fn : null;
}

/** Close the event scope: every answer is discarded and sharing is off again. */
function endEventGit() {
  answers.clear();
  scopeOpen = false;
  recordListener = null;
}

function eventGitStats() {
  return { scopeOpen, questions: answers.size, asked, spawned };
}

/**
 * Open the event scope for a hook that runs STANDALONE (its own process, the
 * `require.main === module` CLI path).
 *
 * A standalone hook invocation IS one event: the process is created for this
 * one payload and exits with its answer, which is exactly the lifetime the
 * scope has under the dispatcher too (hook-engine-worker.js opens it before the
 * first detector and the worker is retired with its event). Without this, every
 * asker inside one standalone hook pays its own git spawn for questions the
 * EVENT already knows the answer to — measured (fw-tier2): posture-gate asked
 * `rev-parse --git-common-dir` three times, validate-bash-command twice, in one
 * process, for one payload.
 *
 * It is the SAME mechanism, keying and failure contract as the dispatch scope —
 * callers do not change: `askOnce` records the first answer and returns a clone
 * to every later asker, including a recorded FAILURE (a failure stays a failure
 * for the rest of the event). Nothing is written to disk, and nothing survives
 * the process: `beginEventGit` clears the map, and the registered exit hook
 * closes the scope, so a second scope in a long-lived process still starts empty.
 *
 * NOT called on the engine path: when dispatch.js runs the hook in-process the
 * worker already owns the scope, and a nested begin would DISCARD answers the
 * earlier detectors of this event recorded.
 */
function installStandaloneEventScope() {
  beginEventGit();
  process.on("exit", () => {
    try {
      endEventGit();
    } catch {
      /* process is exiting; nothing to recover */
    }
  });
}

module.exports = { eventGitKey, askOnce, beginEventGit, endEventGit, seedEventGit, onRecord, eventGitStats, installStandaloneEventScope };
