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
 * detectors after it — seeded with the git answers THIS REALM KIND recorded so
 * far (the engine keeps per-realm-kind pools: a deny row never reads a
 * `continue` row's answers, round-6 SEC R1-F2), so a failure stays a failure
 * across the restart within a realm kind.
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
// BOUND ONCE, before any detector loads. A detector that reaches this module (it is
// required by absolute path from `.claude/hooks/<name>.js`, so a repo-owned row shares
// this very instance) could otherwise REPLACE `engine.runDetector` between rows of the
// batch and answer for its siblings. NAMED RESIDUAL: binding the property does not stop
// a row patching realm globals the engine itself uses (`Promise.prototype.then`, the
// `Object.prototype` chain behind `run.outcome()`), or mutating the `_state` this module
// exports for tests — a repo-owned row shares this worker's realm with the engine by
// construction, which is exactly what `mode:"process"` avoids. Loom rows run in an EARLIER
// worker of their own origin, and a deny row gets a singleton worker, so neither can be
// reached by a shared-batch neighbour.
const runDetector = engine.runDetector;

async function run() {
  const { entries, raw, gitSeed } = workerData;
  eventGit.beginEventGit();
  eventGit.seedEventGit(gitSeed || []);
  eventGit.onRecord((key, rec) => send({ type: "git", key, rec }));
  for (const e of entries) {
    send({ type: "start", index: e.index });
    // `mode` travels with the entry: "module" (default — require the file and call its
    // hookMain) or "legacy" (run the file as its own CLI entry; see
    // hook-engine.js § LEGACY ROWS). Rows leaving it unset are module rows, exactly
    // as before. Repo-owned detectors routed here by the dispatcher's legacy path
    // carry their own `origin`/`mode` from the same registry row shape.
    // `onIncomplete` travels too: the finisher must know a row can REFUSE before it may
    // cut it (a deny-capable row the idle grace cut was a fail-open — measured), and the
    // main thread's own marking (`runDetectorsIsolated::put`) reads it off the same entry.
    const outcome = await runDetector({ hook: e.hook, file: e.file, timeoutMs: e.timeoutMs, mode: e.mode, onIncomplete: e.onIncomplete }, raw);
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
