/**
 * hook-engine-worker — the worker-thread half of the dispatcher.
 *
 * dispatch.js (main thread) starts ONE of these per event and hands it the
 * detectors to run, in order. Each runs in-process here under
 * hook-engine.js::runDetector (its own stdin, captured stdout/stderr, captured
 * process.exit, crash boundary). The worker posts:
 *   { type: "start", index }            before each detector
 *   { type: "done",  index, outcome }   after it
 *   { type: "git",   key, rec }         every git answer the event context records
 *   { type: "end" }                     after the last
 *
 * WHY A WORKER AND NOT THE MAIN THREAD. A detector blocked in synchronous code
 * (an execSync with no timeout, a busy loop) cannot be pre-empted by a timer on
 * its own thread. In the main thread that would stall EVERY later detector and
 * finally lose the whole event to the host's kill — denies already computed
 * included. Here the main thread keeps its timers: when a detector overruns its
 * budget, main records it as abandoned (the host-kill disposition that hook
 * always had), terminates this worker, and starts a fresh one for the
 * detectors after it — seeded with every git answer already recorded, so a
 * failure stays a failure across the restart.
 */
"use strict";

const workerThreads = require("worker_threads");
const { parentPort, workerData } = workerThreads;
// Bound NOW, before any detector loads: a detector that later patches
// MessagePort.prototype.postMessage cannot rewrite what the engine sends.
const send = workerThreads.MessagePort.prototype.postMessage.bind(parentPort);
// The channel to the dispatcher is the ENGINE's, not the detectors': once captured
// here it is removed from the module so a detector's require("worker_threads")
// cannot post a verdict for another detector of this worker.
try {
  Object.defineProperty(workerThreads, "parentPort", { value: null, configurable: false, writable: false });
} catch {}
const engine = require("./hook-engine.js");
const eventGit = require("./event-git.js");

async function run() {
  const { entries, raw, gitSeed } = workerData;
  eventGit.beginEventGit();
  eventGit.seedEventGit(gitSeed || []);
  eventGit.onRecord((key, rec) => send({ type: "git", key, rec }));
  for (const e of entries) {
    send({ type: "start", index: e.index });
    // Loom rows only (a loom registry row cannot carry `mode`); repo-owned detectors
    // never reach this worker — dispatch.js runs them under lib/local-supervisor.js.
    const outcome = await engine.runDetector({ hook: e.hook, file: e.file, timeoutMs: e.timeoutMs }, raw);
    send({ type: "done", index: e.index, outcome });
    if (outcome.inFlight) {
      // The detector's work is still running in this isolate; a process would have
      // been killed. Ask for a fresh worker for everything after it.
      send({ type: "recycle" });
      // Block this thread until the dispatcher terminates it: a continuation the
      // ended detector already queued must not get a turn in the gap between this
      // message and the termination (terminate() is asynchronous).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      return;
    }
  }
  eventGit.endEventGit();
  send({ type: "end" });
}

run().catch((err) => {
  send({ type: "fatal", message: String((err && err.stack) || err) });
});
