/**
 * hook-engine — run many hook scripts IN ONE PROCESS, each under its own
 * process-shaped sandbox, and merge their decisions into one hook reply.
 *
 * WHY THIS EXISTS (operator directive 2026-09-26, "why 99 hooks?"). Every
 * detector used to be its own `settings.json` entry, so one Bash call started
 * 23 node processes and one Edit started 33. A bare node start costs ~49 ms of
 * CPU, the shared libraries were re-parsed by every one of them, and the same
 * git/posture/roster reads ran again in each. The root cause was never the
 * detectors — it was that the ONLY registration surface was "a new process".
 * This module is the other surface: `dispatch.js <Event>` reads stdin once and
 * runs every registered detector here, in-process — one after another in registry
 * order, or all at once for an event whose registry says `isolation: "parallel"`
 * (SessionEnd); either way the outcomes come back in registry order.
 *
 * THE CONTRACT A DETECTOR RUNS UNDER. A migrated hook keeps its CLI entry
 * byte-for-byte (`if (require.main === module) hookMain()`), and ALSO exports
 * `hookMain` — the same function. Inside the engine that function runs with:
 *
 *   - `process.stdin`   → a private stream holding the SAME raw payload bytes
 *   - `process.stdout` / `process.stderr` writes → captured per detector
 *   - `process.exit(c)` → records exit code `c` and ENDS the detector: a
 *                         sentinel is thrown so no ordinary statement after it
 *                         runs, and anything it writes later is discarded.
 *                         KNOWN RESIDUAL (a process would not do this): a
 *                         `catch`/`finally` the exit is nested in DOES run.
 *                         Every catch/finally around an exit in the dispatched
 *                         hooks was swept (entry conversion audit + review
 *                         syntax sweep): output, exit, clearTimeout, closeSync or
 *                         reject only — no ledger write, signature or spawn.
 *   - `process.argv`    → [execPath, <hook file>], as a standalone spawn has
 *   - an uncaught throw / rejection → exit 1 with the stack on stderr, which is
 *                         what node does to a crashing script — and the merge
 *                         shows it to the USER as the host did (§ FAILED DETECTORS)
 *   - its own time budget (its old settings.json `timeout`) → on expiry the
 *                         detector contributes NOTHING to the decision, which is
 *                         what the host does to a hook it kills (a cancelled hook)
 *
 * So a guard's DECISION, its stdin contract, its fail-open/fail-closed
 * behaviour on error and on timeout are the ones it already had: the engine
 * does not re-implement any of them, it runs the hook's own code under the same
 * process semantics. `hook-engine.test.mjs` pins each of those clauses and the
 * per-hook equivalence corpus pins the outputs byte-for-byte.
 *
 * MERGE. Any deny wins; every deny reason goes back in ONE message; advisory
 * context from the other detectors rides along. When exactly one detector
 * produced output its reply is forwarded VERBATIM, so a single-detector call is
 * byte-identical to the standalone hook. What counts as a refusal, and which
 * output the host reads at all, is PER EVENT — see § HOST SEMANTICS PER EVENT
 * (SessionStart has no refusal; PreCompact reads raw stdout as instructions;
 * SessionEnd reads only failures; at Stop a halt wins over a block). A detector
 * that FAILED (crash, or a non-zero exit other than 2 without a JSON reply) is
 * shown to the user as the host showed it — § FAILED DETECTORS.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const { PassThrough } = require("stream");

// Thrown out of a detector's `process.exit()` so no statement after the exit
// runs. Never escapes the engine: the uncaught / unhandled handlers swallow it.
const EXIT_SENTINEL = Object.freeze({ __hookEngineExit: true });

const ENTRY_EXPORT = "hookMain";

const als = new AsyncLocalStorage();
const state = { current: null, installed: false, real: null };

function toText(chunk, enc) {
  if (chunk === undefined || chunk === null) return "";
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString(typeof enc === "string" ? enc : "utf8");
  }
  return String(chunk);
}

class DetectorRun {
  constructor(entry, raw) {
    this.entry = entry;
    this.raw = raw;
    this.out = [];
    this.err = [];
    this.exitCode = null;
    this.status = null; // exit | return | crash | timeout | skipped
    this.done = false;
    this._stdin = null;
    this.promise = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }
  stdinStream() {
    if (!this._stdin) {
      const s = new PassThrough();
      s.end(this.raw);
      this._stdin = s;
    }
    return this._stdin;
  }
  finish(status, exitCode) {
    if (this.done) return;
    this.done = true;
    this.status = status;
    this.exitCode = exitCode;
    this._resolve();
  }
  crash(err) {
    if (this.done) return;
    const text =
      err && err.stack ? err.stack : `Uncaught ${String(err && err.message ? err.message : err)}`;
    this.err.push(text + "\n");
    this.finish("crash", 1);
  }
  outcome() {
    return {
      hook: this.entry.hook,
      status: this.status,
      exitCode: this.exitCode,
      stdout: this.out.join(""),
      stderr: this.err.join(""),
    };
  }
}

function currentRun() {
  return als.getStore() || state.current;
}

/**
 * Install the process shims ONCE. Outside a detector (no current run) every
 * shim delegates to the real primitive, so the dispatcher's own final write and
 * exit are untouched.
 */
function installShims() {
  if (state.installed) return;
  state.installed = true;
  const realExit = process.exit.bind(process);
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const stdinDesc = Object.getOwnPropertyDescriptor(process, "stdin");
  const realReadFileSync = fs.readFileSync;
  state.real = { exit: realExit, out: realOut, err: realErr, stdinDesc, readFileSync: realReadFileSync };

  process.exit = function hookEngineExit(code) {
    const run = currentRun();
    if (!run) return realExit(code);
    if (!run.done) {
      let c = code === undefined || code === null ? 0 : Number(code);
      if (!Number.isInteger(c)) c = 1;
      run.finish("exit", c);
    }
    throw EXIT_SENTINEL;
  };

  const capture = (which, real) =>
    function hookEngineWrite(chunk, enc, cb) {
      const run = currentRun();
      if (!run) return real(chunk, enc, cb);
      if (!run.done) run[which].push(toText(chunk, enc));
      const done = typeof enc === "function" ? enc : cb;
      if (typeof done === "function") process.nextTick(done);
      return true;
    };
  process.stdout.write = capture("out", realOut);
  process.stderr.write = capture("err", realErr);

  Object.defineProperty(process, "stdin", {
    configurable: true,
    enumerable: stdinDesc ? stdinDesc.enumerable : true,
    get() {
      const run = currentRun();
      if (run) return run.stdinStream();
      return stdinDesc && stdinDesc.get ? stdinDesc.get.call(process) : undefined;
    },
  });

  // fd-0 reads (`fs.readFileSync(0)` / `/dev/stdin`, sync, callback and promise
  // forms) see the same private bytes. In a worker thread the REAL fd 0 is the
  // dispatcher's already-drained stdin: an unshimmed read would come back empty
  // and the hook would fail OPEN on a payload it never saw.
  const isStdin = (file) => file === 0 || file === "/dev/stdin";
  const stdinBytes = (run, options) => {
    const enc = typeof options === "string" ? options : options && options.encoding;
    return enc ? Buffer.from(run.raw).toString(enc) : Buffer.from(run.raw);
  };
  fs.readFileSync = function hookEngineReadFileSync(file, options) {
    const run = currentRun();
    if (run && isStdin(file)) return stdinBytes(run, options);
    return realReadFileSync.apply(fs, arguments);
  };
  const realReadFile = fs.readFile;
  fs.readFile = function hookEngineReadFile(file, options, cb) {
    const run = currentRun();
    if (run && isStdin(file)) {
      const done = typeof options === "function" ? options : cb;
      const data = stdinBytes(run, typeof options === "function" ? undefined : options);
      process.nextTick(() => done(null, data));
      return undefined;
    }
    return realReadFile.apply(fs, arguments);
  };
  const realPromisesReadFile = fs.promises.readFile;
  fs.promises.readFile = function hookEngineReadFileP(file, options) {
    const run = currentRun();
    if (run && isStdin(file)) return Promise.resolve(stdinBytes(run, options));
    return realPromisesReadFile.apply(fs.promises, arguments);
  };
  // Direct fd-1/fd-2 writes would land on the dispatcher's REAL stdout and corrupt
  // the one JSON reply; they are captured like process.stdout/stderr writes.
  const realWriteSync = fs.writeSync;
  fs.writeSync = function hookEngineWriteSync(fd, buffer) {
    const run = currentRun();
    if (run && (fd === 1 || fd === 2)) {
      const text = toText(buffer, typeof arguments[2] === "string" ? arguments[2] : undefined);
      if (!run.done) run[fd === 1 ? "out" : "err"].push(text);
      return Buffer.byteLength(text);
    }
    return realWriteSync.apply(fs, arguments);
  };

  const onThrow = (err) => {
    if (err === EXIT_SENTINEL) return;
    const run = currentRun();
    if (run && !run.done) return run.crash(err);
    if (run && run.done) return; // stray async of a finished detector: its process would be gone
    // An engine-level fault. Rethrowing from here would exit 7; report and exit 1
    // (non-blocking), the same disposition a crashing hook process has.
    try {
      realErr(`[hook-engine] fatal: ${err && err.stack ? err.stack : err}\n`);
    } catch {}
    realExit(1);
  };
  process.on("uncaughtException", onThrow);
  process.on("unhandledRejection", onThrow);
}

/**
 * Is the detector still CONSUMING its stdin — reading it (flowing, or a 'readable'
 * listener) and not yet at its end? A real process with such a read pending is
 * kept alive by it, so hookMain returning does not end the hook.
 */
function stdinPending(run) {
  const s = run._stdin;
  if (!s || s.readableEnded || s.destroyed) return false;
  return s.readableFlowing === true || s.listenerCount("readable") > 0;
}

/**
 * hookMain has returned (or its promise settled) without a process.exit. A real
 * process would end there only if nothing kept it alive; the one keep-alive the
 * engine models is a pending stdin read (the dominant hook shape: attach
 * 'data'/'end' listeners, return, act in the 'end' handler). So: finish now if
 * stdin is not being read, otherwise when it ends — one macrotask later, so the
 * hook's own 'end' handlers and the microtasks they queue have run first. The
 * per-detector budget still bounds the wait (a read that never ends is a timeout).
 * RESIDUAL: any OTHER keep-alive (a ref'd timer, a child process) started without
 * a pending stdin read is not modelled — the detector ends when hookMain settles.
 */
function finishWhenStdinSettles(run) {
  if (run.done) return;
  if (!stdinPending(run)) return run.finish("return", 0);
  const s = run._stdin;
  let armed = false;
  const settle = () => {
    if (armed) return;
    armed = true;
    setImmediate(() => run.finish("return", 0)); // finish() is a no-op once the hook exited
  };
  s.once("end", settle);
  s.once("close", settle);
  s.once("error", settle);
}

/**
 * Run ONE detector to completion under the sandbox. Never throws.
 * @param {{hook:string,file:string,timeoutMs:number}} entry
 * @param {string} raw the event payload exactly as the host sent it
 */
async function runDetector(entry, raw) {
  installShims();
  const run = new DetectorRun(entry, raw);
  const savedArgv = process.argv;
  state.current = run;
  process.argv = [process.execPath, entry.file];
  // Ref'd on purpose: a detector awaiting a promise that never settles holds no
  // handle, and without this timer node would exit mid-dispatch.
  const budget = setTimeout(() => run.finish("timeout", null), Math.max(1, entry.timeoutMs));
  let mainSettled = false;
  try {
    als.run(run, () => {
      let ret;
      try {
        const mod = require(entry.file);
        const fn = mod && mod[ENTRY_EXPORT];
        if (typeof fn !== "function") {
          throw new Error(
            `hook-engine: ${entry.hook} does not export ${ENTRY_EXPORT}() — it cannot run in-process`,
          );
        }
        ret = fn();
      } catch (e) {
        // A synchronous exit (or throw) inside hookMain: nothing is in flight.
        mainSettled = true;
        if (e !== EXIT_SENTINEL) run.crash(e);
        return;
      }
      Promise.resolve(ret).then(
        () => {
          mainSettled = true;
          finishWhenStdinSettles(run);
        },
        (e) => {
          mainSettled = true;
          if (e !== EXIT_SENTINEL) run.crash(e);
        },
      );
    });
    await run.promise;
    // One macrotask for a synchronous exit's sentinel to settle hookMain's promise.
    await new Promise((r) => setImmediate(r));
  } finally {
    clearTimeout(budget);
    process.argv = savedArgv;
    state.current = null;
  }
  const out = run.outcome();
  // The detector ENDED (its exit, its own fallback timer, a crash, the budget)
  // while its hookMain was still in flight — e.g. a fallback timer firing during
  // an await. A real process would be gone; here its continuation could still run
  // (a ledger append, a signature) interleaved with the next detector. Flagging it
  // lets the dispatcher discard this worker before the next detector starts.
  out.inFlight = !mainSettled;
  return out;
}

/**
 * The engine's clock: MONOTONIC milliseconds (performance.now()). Every deadline and
 * budget in runDetectorsIsolated is arithmetic on it, so a forward wall-clock step
 * cannot turn a detector's remaining budget negative and starve the guards after it
 * (round-5 LOW-2). Only instants taken from THIS clock may be compared with it.
 */
function now() {
  return require("perf_hooks").performance.now();
}

// ---------------------------------------------------------------------------
// runDetectorsIsolated — the dispatcher's runner: detectors in a worker thread,
// budgets enforced from the main thread
// ---------------------------------------------------------------------------

/**
 * Run `entries` in worker threads and return one outcome per entry, in entry
 * order. Each entry's budget is enforced HERE, on the main thread, so a detector
 * stuck in synchronous code cannot stall the others or erase decisions already
 * made: on overrun it is recorded as `timeout` (contributes nothing — the
 * disposition the host's kill always gave that hook) and its worker is
 * terminated. An entry that cannot start before `deadlineAtMono` is `skipped`; a started
 * one the deadline stops before its OWN budget ran out is a `timeout` with
 * `deadlineCut: true` — the dispatcher treats both as guards that could not run
 * (refused at PreToolUse), unlike a detector that overran its own budget.
 *
 * @param {Array<{hook:string,file:string,timeoutMs:number}>} entries
 * @param {string} raw
 * @param {{deadlineAtMono:number, watchdogSlackMs?:number, isolation?:"event"|"detector"|"parallel",
 *   onOutcome?:(index:number, outcome:object)=>void}} opts  `deadlineAtMono` is an
 *   instant on THIS module's monotonic clock (`now()`, i.e. performance.now()), never
 *   Date.now(): a wall-clock step must not move a budget (round-5 LOW-2). It is a
 *   NEW name on purpose — a caller still passing an epoch `deadlineAt` would read as
 *   a deadline decades away, so that is refused (TypeError), never reinterpreted.
 *   `onOutcome` is called as each outcome is decided, before the returned promise
 *   resolves.
 *   isolation "event" (default): one worker runs every detector of the event, in
 *   order — shared module cache and git context, cheapest; after an overrun a
 *   fresh worker continues with the next entry, seeded with the event's git
 *   answers so far. "detector": the same order, a fresh worker per detector — no
 *   detector can see another's globals or module state, at the cost of
 *   re-loading shared libraries per detector. "parallel": EVERY detector starts
 *   at once in its own worker (the host's own execution model for an event's
 *   hooks) — the event's wall time is the slowest member, not the sum, which is
 *   what an event with a host-side cap on the TOTAL wait (SessionEnd) needs. Each
 *   budget, the protocol and the abandonment accounting are the same in all three.
 */
function runDetectorsIsolated(entries, raw, opts) {
  const { Worker } = require("worker_threads");
  if (!opts || !Number.isFinite(opts.deadlineAtMono) || opts.deadlineAt !== undefined) {
    throw new TypeError("runDetectorsIsolated: pass opts.deadlineAtMono, an instant on hook-engine.now() (monotonic); an epoch opts.deadlineAt is not accepted");
  }
  const deadlineAt = opts.deadlineAtMono;
  const slack = opts.watchdogSlackMs === undefined ? 250 : opts.watchdogSlackMs;
  const outcomes = new Array(entries.length).fill(null);
  // Every outcome is REPORTED the moment it is decided (`opts.onOutcome(i, o)`), not
  // only when the whole run resolves: a dispatcher fault that lands while the run is
  // still going (its fatal handler, its watchdog) must see the verdicts already
  // reached — a deny from detector 0 must not read as "nothing refused" because
  // detector 1 is still running (lib/dispatch-main.js::lateFaultReply). An observer that
  // throws cannot take the run down with it.
  const put = (i, o) => {
    outcomes[i] = o;
    if (typeof opts.onOutcome === "function") {
      try {
        opts.onOutcome(i, o);
      } catch {}
    }
  };
  // Indexes a worker has declared started and not yet finished: the event deadline
  // cutting one of those is a `timeout` the DEADLINE imposed (deadlineCut), not a
  // detector that never started (`skipped`).
  const running = new Set();
  // Git answers recorded so far, per ORIGIN: a replacement worker is seeded only
  // with answers its own origin recorded, so a repo-owned (local) detector can
  // never plant an answer a loom guard would later be served.
  const gitRecords = { loom: new Map(), local: new Map() };
  const note = (e, text) => `[dispatch] ${e.hook} ${text}\n`;
  const skipped = (i) => ({ hook: entries[i].hook, status: "skipped", exitCode: null, stdout: "", stderr: note(entries[i], "skipped: event dispatch budget exhausted") });
  // A started detector the EVENT deadline stopped while its own budget had not run
  // out. It contributes nothing (a killed hook's output is never read), but it is NOT
  // the host-kill of its own timeout: `deadlineCut` lets the dispatcher tell a guard
  // that could not finish from one that overran (lib/dispatch-main.js § STARVED loom detectors).
  const cutAtDeadline = (i) => ({
    hook: entries[i].hook,
    status: "timeout",
    exitCode: null,
    stdout: "",
    stderr: note(entries[i], "was stopped at the event deadline before its own budget ran out"),
    deadlineCut: true,
  });
  return new Promise((resolve) => {
    let done = false;
    const live = new Set(); // workers not yet retired, for the global deadline
    let abandonedWorkers = 0; // workers terminated while possibly stuck (see lib/dispatch-main.js::finish)
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(deadlineTimer);
      for (const w of live) {
        abandonedWorkers++;
        w.terminate().catch(() => {});
      }
      live.clear();
      outcomes.abandonedWorkers = abandonedWorkers;
      resolve(outcomes);
    };
    // One timer for the whole event: worker boot and the gaps between detectors
    // are bounded too, not only a started detector's budget.
    const deadlineTimer = setTimeout(() => {
      for (let i = 0; i < entries.length; i++) if (!outcomes[i]) put(i, running.has(i) ? cutAtDeadline(i) : skipped(i));
      finish();
    }, Math.max(1, deadlineAt - now()));

    /**
     * Start ONE worker over `batch` (entries of one origin, in order) and drive
     * its protocol. Exactly one of ctl.ended / ctl.recycled / ctl.abandoned is
     * called, once, when the worker is finished with; ctl.done(i) after each
     * accepted outcome.
     */
    const spawnBatch = (batch, origin, ctl) => {
      const expected = batch.map((e) => e.index);
      const w = new Worker(require("path").join(__dirname, "hook-engine-worker.js"), {
        workerData: { entries: batch, raw, gitSeed: [...gitRecords[origin]] },
        stdout: true, // a detector's writes are captured by the engine; anything else is not the host's
        stderr: true,
      });
      live.add(w);
      w.stdout.resume();
      w.stderr.resume();
      let current = null; // index the worker declared started and has not finished
      let pos = 0; // position in `expected` of the next index allowed to start
      let timer = null;
      let settled = false;
      const clear = () => {
        if (timer) clearTimeout(timer);
        timer = null;
      };
      const retire = () => {
        settled = true;
        clear();
        live.delete(w);
        w.terminate().catch(() => {});
      };
      // The worker ended abnormally. If a detector was RUNNING, that detector is
      // charged (`status`, the disposition a killed/crashed hook had). If none was
      // running, the ENGINE failed — no detector's fault — and the controller marks
      // the next entry "engine-fault" (never a silent crash), so the dispatcher can
      // refuse at PreToolUse instead of reading a dead engine as "nothing to deny".
      const abandon = (status, text, deadlineCut = false) => {
        if (settled) return;
        abandonedWorkers++;
        retire();
        if (current !== null && !outcomes[current]) {
          put(
            current,
            deadlineCut
              ? cutAtDeadline(current)
              : { hook: entries[current].hook, status, exitCode: status === "crash" ? 1 : null, stdout: "", stderr: text },
          );
        }
        if (current !== null) running.delete(current);
        ctl.abandoned(current, text);
      };
      // STRICT PROTOCOL. The worker is an isolate the detectors share, so a
      // message is accepted only in the one shape and order the engine itself
      // produces: start(expected[pos]) → done(same index, once) → … → end after
      // the last. Anything else is treated as a fault of whatever was running,
      // never as an outcome — a detector cannot post another's verdict.
      const bad = (why) => abandon("crash", `[dispatch] engine protocol violation (${why}) — the running detector is charged\n`);
      w.on("message", (m) => {
        if (settled || done) return;
        if (!m || typeof m !== "object") return bad("non-object message");
        if (m.type === "git") {
          if (typeof m.key !== "string" || !m.rec || typeof m.rec !== "object") return bad("malformed git record");
          if (!gitRecords[origin].has(m.key)) gitRecords[origin].set(m.key, m.rec);
          return;
        }
        if (m.type === "start") {
          if (current !== null || pos >= expected.length || m.index !== expected[pos]) return bad("unexpected start");
          current = m.index;
          running.add(m.index);
          pos++;
          clear();
          const own = entries[m.index].timeoutMs + slack;
          const left = deadlineAt - now();
          // Which limit binds decides the disposition: its OWN budget ⇒ the host-kill
          // (contributes nothing); the EVENT deadline ⇒ a guard that could not finish.
          const cut = left < own;
          timer = setTimeout(
            () => abandon("timeout", note(entries[m.index], "overran its budget and was abandoned (host-kill equivalent)"), cut),
            Math.max(1, Math.min(own, left)),
          );
          return;
        }
        if (m.type === "done") {
          if (current === null || m.index !== current || outcomes[m.index]) return bad("unexpected done");
          const o = m.outcome;
          if (!o || typeof o !== "object") return bad("malformed outcome");
          clear();
          running.delete(m.index);
          put(m.index, {
            hook: entries[m.index].hook, // named by the engine, never by the message
            status: String(o.status),
            exitCode: o.exitCode === null || Number.isInteger(o.exitCode) ? o.exitCode : 1,
            stdout: typeof o.stdout === "string" ? o.stdout : "",
            stderr: typeof o.stderr === "string" ? o.stderr : "",
          });
          current = null;
          ctl.done(m.index);
          return;
        }
        if (m.type === "recycle") {
          if (current !== null) return bad("recycle while running");
          abandonedWorkers++;
          retire();
          return ctl.recycled();
        }
        if (m.type === "end") {
          if (current !== null || pos !== expected.length) return bad("early end");
          retire();
          return ctl.ended();
        }
        if (m.type === "fatal") return abandon("crash", `[dispatch] engine worker fault: ${m.message}\n`);
        return bad(`unknown message type ${JSON.stringify(m.type)}`);
      });
      w.on("error", (err) => abandon("crash", `[dispatch] engine worker error: ${(err && err.stack) || err}\n`));
      w.on("exit", () => {
        if (!settled) abandon("crash", "[dispatch] engine worker exited before the detector finished\n");
      });
    };

    if (opts.isolation === "parallel") {
      // Every detector at once, one worker each. Outcomes land in their own slot,
      // so the registry order of the result is independent of completion order.
      let pending = 0;
      for (let i = 0; i < entries.length; i++) {
        if (now() >= deadlineAt) {
          put(i, skipped(i));
          continue;
        }
        pending++;
        let settledOne = false;
        const settle = () => {
          if (settledOne) return;
          settledOne = true;
          if (--pending === 0) finish();
        };
        spawnBatch([{ ...entries[i], index: i }], entries[i].origin || "loom", {
          done() {},
          ended: settle,
          recycled: settle,
          abandoned(current, text) {
            if (current === null && !outcomes[i]) put(i, { hook: entries[i].hook, status: "engine-fault", exitCode: null, stdout: "", stderr: text });
            settle();
          },
        });
      }
      if (pending === 0) finish();
      return;
    }

    // Serial ("event" / "detector"): one worker at a time, in registry order.
    let next = 0; // first entry not yet handed to a worker
    const startWorker = () => {
      if (done) return;
      while (next < entries.length && now() >= deadlineAt) {
        put(next, skipped(next));
        next++;
      }
      if (next >= entries.length) return finish();
      // A batch never mixes origins (loom's detectors never share a worker with a
      // repo-owned one), and is ONE entry under isolation "detector".
      const origin = entries[next].origin || "loom";
      let stop = next + 1;
      if (opts.isolation !== "detector") {
        while (stop < entries.length && (entries[stop].origin || "loom") === origin) stop++;
      }
      const batch = entries.slice(next, stop).map((e, i) => ({ ...e, index: next + i }));
      spawnBatch(batch, origin, {
        done(i) {
          next = i + 1;
        },
        ended: startWorker,
        recycled: startWorker,
        abandoned(current, text) {
          if (current !== null) next = current + 1;
          else if (next < entries.length) {
            put(next, { hook: entries[next].hook, status: "engine-fault", exitCode: null, stdout: "", stderr: text });
            next += 1;
          }
          startWorker();
        },
      });
    };
    startWorker();
  });
}

// ---------------------------------------------------------------------------
// matcher — the host's own semantics, reproduced
// ---------------------------------------------------------------------------

const SIMPLE_MATCHER = /^[A-Za-z0-9_|]+$/;

/**
 * Claude Code's matcher rule: empty or `*` matches every tool; a string of
 * identifiers and `|` is an EXACT match against one of its alternatives; any
 * other string is a regular expression. Events that carry no tool name treat
 * every group as matching (their matchers select on other fields, which the
 * registry does not use).
 */
// Events at which the host ALSO accepts `,` and spaces in a plain-list matcher
// ("Edit, Write" / "startup,resume") — its `vIe` set, passed as the list flag to
// BRo: `if(!(n?/^[a-zA-Z0-9_|, -]+$/:/^[a-zA-Z0-9_|]+$/).test(e))return;
// return e.split(n?/[|,]/:"|").map((g)=>g.trim()).filter(Boolean)…` (2.1.283).
// Stop and UserPromptSubmit are absent: they have no match field at all.
const LIST_MATCHER_EVENTS = new Set([
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied", "UserPromptExpansion",
  "SessionStart", "SessionEnd", "Setup", "PreCompact", "PostCompact", "PreModelSwitch", "PostModelSwitch",
  "Notification", "SubagentStart", "SubagentStop", "Elicitation", "ElicitationResult", "ConfigChange",
  "InstructionsLoaded", "DirectoryAdded",
]);
const LIST_MATCHER = /^[a-zA-Z0-9_|, -]+$/;

/**
 * The matcher rule above, decided WITHOUT compiling or running a regular expression: true /
 * false when the matcher is empty, `*` or a plain list (linear work, no
 * backtracking), null when only the regex reading can decide. dispatch.js uses it
 * for REPO-OWNED rows: a repo-supplied regex is never run on the dispatcher's
 * thread (a catastrophic-backtracking one would stall it past the host's kill and
 * lose loom's verdict) — the null rows are decided inside the supervisor process.
 * The dispatcher also calls this only for matchers of at most
 * lib/dispatch-main.js::MAX_DISPATCHER_MATCHER_CHARS, once per distinct string: the split
 * below is linear, but linear in a repo-supplied length.
 */
function matcherMatchesWithoutRegex(matcher, toolName, event) {
  if (matcher === undefined || matcher === null || matcher === "" || matcher === "*") return true;
  if (typeof toolName !== "string") return false;
  const list = typeof event === "string" && LIST_MATCHER_EVENTS.has(event);
  if (list ? LIST_MATCHER.test(matcher) : SIMPLE_MATCHER.test(matcher)) {
    return matcher
      .split(list ? /[|,]/ : "|")
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(toolName);
  }
  return null;
}

/**
 * @param {string} [event] the hook event; at an event in LIST_MATCHER_EVENTS a
 *   plain list may also be separated by `,` and carry spaces, as the host allows.
 *   Omitted ⇒ the strict `|`-only form (the tool-name reading this function had).
 */
function matcherMatches(matcher, toolName, event) {
  const decided = matcherMatchesWithoutRegex(matcher, toolName, event);
  if (decided !== null) return decided;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// merge — one reply for the host
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HOST SEMANTICS PER EVENT (grounded in the installed Claude Code 2.1.283 binary,
// not in memory — the quoted evidence is in the hook-waves engine report):
//
//   Stop / SubagentStop  exit 2 or JSON decision:"block" → a "Stop hook feedback"
//                        message and the turn CONTINUES; hookSpecificOutput.
//                        additionalContext is delivered AND continues the turn;
//                        continue:false ends it and WINS over a block (checked
//                        first); systemMessage and plain stdout are UI-only.
//   UserPromptSubmit     the FIRST blockingError (exit 2 / decision:"block") ends
//                        the pass: the prompt is not sent, nothing else reaches the
//                        model; otherwise plain stdout and additionalContext are
//                        model context.
//   SessionStart         exit 2 / decision:"block" is NOT a refusal: it is turned
//                        into a non-blocking error shown to the user only, and every
//                        OTHER hook's context still reaches the model.
//                        continue:false is not read.
//   PreCompact           runs outside the REPL runner: exit 2 / decision:"block"
//                        blocks the compaction; the RAW trimmed stdout of every
//                        hook that exited 0 (JSON or not) becomes custom compaction
//                        instructions, joined by "\n".
//   SessionEnd           nothing a hook prints is read, except that a hook that did
//                        not exit 0 has its output (stderr, or a block reason)
//                        printed as "SessionEnd hook [cmd] failed: …".
//
// JSON IS READ AT EVERY EXIT CODE (the REPL runner, i.e. every event above but
// PreCompact / SessionEnd). The runner parses stdout BEFORE it looks at the status —
// `let{json:Ss,plainText:si,validationError:xi}=Vze(RLt(mr));` — and a parsed object
// goes through `hq`, which never reads the exit code, then
// `if(mr.status===2&&!ys.blockingError)ys.blockingError=…;
//  yield{...ys,outcome:ys.blockingError?"blocking":"success",hook:bn}`.
// So a JSON deny / ask / decision:block / continue:false / additionalContext /
// updatedInput / systemMessage printed before `exit 1` is honoured exactly as at
// exit 0 (and no error is shown), and at exit 2 the JSON is honoured too, the
// stderr standing in as the block text only when the JSON carried none. Only a
// NON-JSON reply is status-driven: 0 → success, 2 → blocking, anything else →
// the non-blocking error below. (PreCompact / SessionEnd run outside the REPL:
// `blocked = status===2 || json.decision==="block"` at any status, and
// `succeeded = status===0`.)
//
// FAILED DETECTORS. For a non-JSON reply with a status other than 0 / 2 the runner
// yields `{type:"hook_non_blocking_error", …, stderr:\`Failed with non-blocking
// status code: ${mr.stderr.trim()||"No stderr output"}\`}` — never sent to the model
// (`hook_non_blocking_error:()=>[]`), rendered to the USER as "<hookName> hook
// error" + that text at every event but Stop / SubagentStop, where the renderer
// returns null and the stop loop instead collects it (`Ot.push(ne.stderr||…)`) into
// the stop summary plus the notification "Stop hook error occurred · ctrl+o to see".
// A TIMED-OUT hook (`mr.aborted`) yields `hook_cancelled` (its JSON is never
// parsed), rendered ONLY at UserPromptSubmit: "<hookName> hook [cmd] timed out
// after Ns — output discarded. Raise the hook's "timeout" to allow more time."
// One merged reply reproduces that as follows: when a failure is ALL there is to
// say, the reply IS a failure (exit 1, no JSON, the failures labelled by detector
// on stderr) — the same "hook error" the host showed; when other detectors spoke,
// the failures ride as a `systemMessage` (the host renders it "<hookName> says: …"
// to the user and never sends it to the model — `hook_system_message:()=>[]`),
// because a JSON reply cannot also be a non-blocking error.
// ---------------------------------------------------------------------------

// Events whose exit 2 / decision:"block" is a Stop-class block (feedback + continue).
const STOP_LIKE = new Set(["Stop", "SubagentStop"]);
// Events at which nothing a hook says is a refusal — exit 2 is a user-facing error.
const ADVISORY_ONLY = new Set(["SessionStart"]);
// Events whose hookSpecificOutput.additionalContext the host reads.
const CONTEXT_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "SessionStart", "Stop", "SubagentStop"]);

function parseJson(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    // Some hooks print more than one line; the host parses the whole stdout, so
    // a multi-line stdout is NOT JSON to it either. Mirror that exactly.
    return null;
  }
}

/**
 * Did this outcome reach a RESTRICTIVE verdict — anything a later detector's
 * allow could not override: exit 2, a JSON deny / ask / decision:"block", or a
 * continue:false halt.
 *
 * `ask` COUNTS here, and that is what the late-fault path needs
 * (lib/dispatch-main.js::lateFaultReply): a fault landing after a loom `ask` must not let the
 * hatch admit the call with the ask dropped — the ask is delivered (at PreToolUse,
 * beside the fault's refusal, which makes it a deny: the stricter reading). It does
 * NOT decide whether repo-owned detectors run — see closesLocalGate.
 */
function isRestrictive(o, event) {
  if (!o) return false;
  // `event` is optional (an Array#some callback passes an index here): without it
  // the tool-event reading applies. At SessionStart and SessionEnd the host treats
  // NOTHING a hook says as a refusal, so nothing there is restrictive.
  const ev = typeof event === "string" ? event : undefined;
  if (ev === "SessionStart" || ev === "SessionEnd") return false;
  // A killed / skipped detector's partial output is never parsed by the host.
  if (!ran(o) || !Number.isInteger(o.exitCode)) return false;
  if (o.exitCode === 2) return true;
  // Any other exit: its JSON is read exactly as at exit 0 (§ JSON IS READ AT EVERY
  // EXIT CODE), so a JSON deny printed before `exit 1` is still a deny.
  const j = parseJson(o.stdout);
  if (!j) return false;
  if (ev === "PreCompact") return j.decision === "block"; // continue:false is not read there
  const h = j.hookSpecificOutput && typeof j.hookSpecificOutput === "object" ? j.hookSpecificOutput : {};
  // A rewrite (updatedInput) alone is NOT restrictive: a repo-owned deny must
  // still run and win over it, and a conflicting local rewrite must still be
  // refused. (Repo-owned detectors run as their own processes under
  // lib/local-supervisor.js, outside the dispatcher's process tree — see
  // lib/dispatch-main.js::runLocalSupervised.)
  return h.permissionDecision === "deny" || h.permissionDecision === "ask" || j.decision === "block" || j.continue === false;
}

/**
 * Does this loom outcome make the repo-owned detectors moot, so dispatch.js skips
 * them? Every restrictive verdict EXCEPT a lone `ask` (round-5 LOW-3). The host's
 * precedence is deny > ask > allow: a repo detector's DENY beats loom's ASK, so
 * skipping the repo detectors on an ask would turn a call the repo refuses into a
 * question the user can approve. A deny, an exit 2, a decision:block or a
 * continue:false halt still closes the gate (nothing a repo detector says can
 * outrank those). An outcome carrying an ask AND a halt closes it (the halt).
 */
function closesLocalGate(o, event) {
  if (!isRestrictive(o, event)) return false;
  if (o.exitCode === 2) return true;
  const j = parseJson(o.stdout);
  if (!j) return true; // restrictive but unreadable here: the conservative reading
  const h = j.hookSpecificOutput && typeof j.hookSpecificOutput === "object" ? j.hookSpecificOutput : {};
  const other = h.permissionDecision === "deny" || j.decision === "block" || (event !== "PreCompact" && j.continue === false);
  return other || h.permissionDecision !== "ask";
}

/**
 * Did this outcome say anything the host would act on or deliver to the MODEL /
 * the decision? (A FAILED detector — isFailure — is silent in this sense: the host
 * shows it to the user only; the merge reports it separately.)
 */
function isSilent(o) {
  if (o.status === "timeout" || o.status === "skipped") return true;
  if (o.exitCode === 2) return false;
  const j = parseJson(o.stdout);
  if (o.exitCode !== 0) {
    // Not JSON ⇒ a non-blocking error (nothing reaches the model). JSON ⇒ read
    // exactly as at exit 0 (§ JSON IS READ AT EVERY EXIT CODE).
    if (!j || !Number.isInteger(o.exitCode)) return true;
  }
  if (!j) return !String(o.stdout || "").trim();
  const keys = Object.keys(j).filter((k) => !(k === "continue" && j[k] === true));
  return keys.length === 0;
}

/**
 * A detector the host would have reported as a NON-BLOCKING ERROR: it ran (exit,
 * natural end or crash) to a status other than 0 / 2 and printed no JSON reply.
 * (An engine-fault / killed / skipped outcome is not one — the dispatcher reports
 * those itself.)
 */
function isFailure(o) {
  if (!o || !(o.status === "exit" || o.status === "return" || o.status === "crash")) return false;
  if (o.exitCode === 0 || o.exitCode === 2) return false;
  return !parseJson(o.stdout);
}

// How much of a failed detector's stderr a user-facing systemMessage carries (the
// exit-1 reply carries all of it, as the host did).
const FAILURE_EXCERPT_LINES = 6;
const FAILURE_EXCERPT_CHARS = 1200;

function failureLabel(o) {
  const code = Number.isInteger(o.exitCode) ? o.exitCode : 1;
  return `${o.hook} ${o.status === "crash" ? "crashed" : "failed"} (exit ${code})`;
}

/**
 * ONE failed detector, labelled. `asNote` (a systemMessage): the host's own words
 * are added and the stderr is excerpted. Otherwise (the exit-1 reply) the whole
 * stderr — the host itself prefixes "Failed with non-blocking status code: ".
 */
function failureText(o, asNote) {
  let t = String(o.stderr || "").trim();
  if (asNote && t) {
    const lines = t.split("\n");
    let cut = lines.slice(0, FAILURE_EXCERPT_LINES).join("\n");
    if (cut.length > FAILURE_EXCERPT_CHARS) cut = cut.slice(0, FAILURE_EXCERPT_CHARS);
    t = cut.length < t.length ? cut + " …" : cut;
  }
  return `${failureLabel(o)}: ${asNote ? "Failed with non-blocking status code: " : ""}${t || "No stderr output"}`;
}

/** The user-only notes for one event's failed / timed-out detectors (see § FAILED DETECTORS). */
function failureNotes(event, outcomes) {
  const notes = outcomes.filter(isFailure).map((o) => `hook error — ${failureText(o, true)}`);
  if (event === "UserPromptSubmit") {
    for (const o of outcomes) {
      if (o.status === "timeout") notes.push(`${o.hook} timed out — output discarded. Raise its registry "timeout" to allow more time.`);
    }
  }
  return notes;
}

/**
 * A DETECTOR-SUPPLIED text field, as a string. Anything else is "" — never
 * `String(v)`: a detector's JSON is data it controls, and `{"reason":{"toString":1}}`
 * makes `String()` (or a template literal) THROW, which would turn one detector's
 * odd reply into a merge that loses every other detector's verdict.
 */
function str(v) {
  return typeof v === "string" ? v : "";
}

function joinBlocks(parts) {
  return parts.map(str).filter((p) => p.trim()).join("\n\n────────\n\n");
}

// The deepest `updatedInput` the merge will carry, in nested objects/arrays. A real one is a tool_input — a
// few levels. Past this the value is not serialized at all (a recursive stringify on
// an older runtime could overflow the stack inside the merge).
const MAX_REWRITE_DEPTH = 256;

/** `JSON.stringify(v)` of a rewrite, or null when it is too deep or cannot be serialized. */
function rewriteKey(v) {
  // Depth measured iteratively (no recursion on a detector-supplied shape).
  const stack = [[v, 1]];
  while (stack.length) {
    const [x, d] = stack.pop();
    if (!x || typeof x !== "object") continue; // a scalar adds no level
    if (d > MAX_REWRITE_DEPTH) return null;
    for (const k of Object.keys(x)) stack.push([x[k], d + 1]);
  }
  try {
    const s = JSON.stringify(v);
    return typeof s === "string" ? s : null;
  } catch {
    return null;
  }
}

/** A detector that ran to an exit (not killed on its budget, not skipped). */
function ran(o) {
  return o.status !== "timeout" && o.status !== "skipped";
}
const verbatim = (o) => ({ stdout: o.stdout || "", stderr: o.stderr || "", exitCode: o.exitCode === null ? 1 : o.exitCode });

/**
 * PreCompact. The host (Vfe over executeHooksOutsideREPL) runs each hook and then:
 * a hook that exited 2 or printed decision:"block" (at ANY status) BLOCKS the
 * compaction (its reason, or its stderr); every hook that exited 0 contributes its
 * RAW trimmed stdout — JSON or not — to the custom compaction instructions,
 * `D.join("\n\n")`; and every hook is listed to the user —
 * "PreCompact [cmd] completed successfully: …" or "PreCompact [cmd] failed: <stderr>"
 * (a timed-out one: "failed: Hook cancelled"). So the merged reply is raw text, never
 * a JSON envelope: `{"continue":true}` invented here would itself become a
 * compaction instruction. One reply is either a success (its stdout = instructions)
 * or a failure (its stderr shown): when nobody produced an instruction, a failure is
 * reported AS the failure — the user saw it before; when instructions exist they win
 * (they change what the compaction keeps) and a failed DETECTOR's stderr stays on
 * stderr, unshown — a residual one reply cannot close.
 *
 * DISPATCHER NOTICES (`notice: true` outcomes — the dispatcher's own text: a broken
 * local registry, a supervisor fault, a registered file that is missing) are never
 * left unshown. With nothing else to say they make the reply a FAILURE (exit 1, the
 * notice on stderr — "PreCompact [cmd] failed: …", the form the host gives a failed
 * PreCompact hook). Beside a block they ride with the block's text. Beside
 * instructions they are APPENDED to the instructions, as a delimited notice block:
 * failing the reply would DROP the instructions (the host takes instructions only
 * from an exit-0 hook) and change what the compaction keeps, while stderr at exit 0
 * is never shown; appended, nothing is dropped, and the notice reaches the agent
 * through the summary — the channel the dispatcher uses for these notes at every
 * other event (additionalContext). The text appended is the dispatcher's own,
 * never a detector's stderr, so no detector output is promoted into the
 * model-facing instructions.
 */
const PRECOMPACT_NOTICE_HEAD =
  "HOOK DISPATCHER NOTICE (from the hook dispatcher, not from the user — keep it in the summary so the agent sees it after compaction):";
function mergePreCompact(all) {
  const notices = all.filter((o) => o.notice).map((o) => String(o.stderr || "").trim()).filter(Boolean);
  const outcomes = all.filter((o) => !o.notice);
  const noticeText = notices.join("\n");
  const withNotices = (given) => {
    if (!notices.length) return given;
    let r = given;
    // A JSON decision:"block" is a BLOCK at any exit code (the host: `blocked =
    // status===2 || json.decision==="block"`). Appending a notice to its stdout would
    // make that stdout non-JSON — the block would silently become an INSTRUCTION. So
    // it is re-expressed as the exit-2 form (reason on stderr), which carries a notice.
    const j = r.exitCode !== 2 ? parseJson(r.stdout) : null;
    if (j && j.decision === "block") r = { stdout: "", stderr: (str(j.reason) || r.stderr || "blocked (no reason given)").trim() + "\n", exitCode: 2 };
    if (r.exitCode === 0 && r.stdout.trim()) {
      return { ...r, stdout: `${r.stdout.replace(/\n+$/, "")}\n\n${PRECOMPACT_NOTICE_HEAD}\n${noticeText}\n` };
    }
    if (r.exitCode === 0) return { stdout: "", stderr: noticeText + "\n", exitCode: 1 };
    return { ...r, stderr: `${r.stderr.replace(/\n+$/, "")}\n\n${noticeText}\n` };
  };
  if (outcomes.length === 1 && ran(outcomes[0])) return withNotices(verbatim(outcomes[0]));
  return withNotices(mergePreCompactDetectors(outcomes));
}

function mergePreCompactDetectors(outcomes) {
  const blocked = [];
  const instructions = [];
  const failures = [];
  for (const o of outcomes) {
    if (!ran(o)) {
      if (o.status === "timeout") failures.push(`[${o.hook}] timed out: Hook cancelled`);
      else if (o.stderr) failures.push(String(o.stderr).trim());
      continue;
    }
    const j = parseJson(o.stdout);
    if (o.exitCode === 2 || (j && j.decision === "block")) {
      blocked.push(j && j.decision === "block" ? str(j.reason) || o.stderr : o.stderr);
      continue;
    }
    if (o.exitCode === 0) {
      const t = String(o.stdout || "").trim();
      if (t) instructions.push(t);
    } else {
      failures.push(`[${failureLabel(o)}] ${String(o.stderr || "").trim() || "No stderr output"}`);
    }
  }
  if (blocked.length) {
    // The host's blockedBy text for an exit-2 hook is its stderr; stdout stays empty
    // so no JSON of ours is read as the reason.
    return { stdout: "", stderr: joinBlocks(blocked.map((b) => String(b || "").trim() || "blocked (no reason given)")) + "\n", exitCode: 2 };
  }
  if (!instructions.length && failures.length) return { stdout: "", stderr: failures.join("\n") + "\n", exitCode: 1 };
  return { stdout: instructions.length ? instructions.join("\n\n") + "\n" : "", stderr: outcomes.map((o) => o.stderr).filter(Boolean).join(""), exitCode: 0 };
}

/**
 * SessionEnd. The host reads nothing a hook prints except a FAILED hook's output
 * (stderr, or a decision:"block" reason), which it prints as
 * "SessionEnd hook [cmd] failed: …" — a timed-out hook reads "Hook cancelled".
 * So every failure is kept, each labelled with its detector, and the merged
 * reply fails when any member failed.
 */
function mergeSessionEnd(outcomes) {
  if (outcomes.length === 1 && ran(outcomes[0])) return verbatim(outcomes[0]);
  const failed = [];
  let exitCode = 0;
  for (const o of outcomes) {
    if (!ran(o)) {
      failed.push(`[${o.hook}] ${o.status === "timeout" ? "timed out" : "did not run"}${o.stderr ? `: ${String(o.stderr).trim()}` : ""}`);
      exitCode = exitCode || 1;
      continue;
    }
    if (o.exitCode === 0) continue;
    const j = parseJson(o.stdout);
    const text = String((j && j.decision === "block" ? str(j.reason) || o.stderr : o.stderr) || "").trim();
    failed.push(`[${o.hook}] exited ${o.exitCode}${text ? `: ${text}` : ""}`);
    exitCode = o.exitCode === 2 ? 2 : exitCode || 1;
  }
  if (!exitCode) return { stdout: JSON.stringify({ continue: true }) + "\n", stderr: outcomes.map((o) => o.stderr).filter(Boolean).join(""), exitCode: 0 };
  return { stdout: "", stderr: failed.join("\n") + "\n", exitCode };
}

/**
 * Merge detector outcomes into the single {stdout, stderr, exitCode} the host
 * receives for this event — reproducing, as closely as one reply can, what the
 * host did with the same hooks run as separate processes (see HOST SEMANTICS
 * PER EVENT above).
 */
function mergeOutcomes(event, given) {
  // Every text field is a string from here on (str): the merge must not be made to
  // throw by what an outcome carries — a throw here loses EVERY verdict of the event.
  const outcomes = given.map((o) => ({ ...o, hook: str(o.hook) || "(unnamed detector)", stdout: str(o.stdout), stderr: str(o.stderr) }));
  if (event === "PreCompact") return mergePreCompact(outcomes);
  if (event === "SessionEnd") return mergeSessionEnd(outcomes);
  const speaking = outcomes.filter((o) => !isSilent(o));
  const allStderr = outcomes.map((o) => o.stderr).filter(Boolean).join("");
  // What the host showed the USER for failed / timed-out detectors (§ FAILED DETECTORS).
  const failed = outcomes.filter(isFailure);
  const notes = failureNotes(event, outcomes);
  if (speaking.length === 0) {
    if (failed.length && notes.length === failed.length) {
      // A failure is all there is to say: the reply IS a failure — exit 1, NO JSON
      // (a JSON reply would be read as success and the error never shown), every
      // failed detector named with its whole stderr, as the host showed each one.
      return { stdout: "", stderr: failed.map((o) => failureText(o, false)).join("\n\n") + "\n", exitCode: 1 };
    }
    const json = { continue: true };
    if (notes.length) json.systemMessage = joinBlocks(notes);
    return { stdout: JSON.stringify(json) + "\n", stderr: allStderr, exitCode: 0 };
  }
  if (speaking.length === 1 && notes.length === 0) {
    // Verbatim: a lone speaker's reply is byte-identical to its standalone run.
    // On exit 2 the host hands stderr to the model, so only the speaker's own
    // stderr may ride there — another detector's diagnostics never reached the
    // model when each hook was its own process.
    const o = speaking[0];
    return { stdout: o.stdout, stderr: o.exitCode === 2 ? o.stderr : allStderr, exitCode: o.exitCode };
  }

  const advisoryOnly = ADVISORY_ONLY.has(event);
  const blocking = []; // reasons the host must hand back as a refusal / block
  const contexts = []; // additionalContext / plain-text context
  const systemMessages = [];
  const userNotes = []; // advisory-only events: what the host showed the USER as a hook error
  const stopReasons = [];
  let halt = false; // an explicit continue:false from some detector
  let ask = false;
  let allow = false;
  const askReasons = [];
  const askers = []; // the detectors that asked (to name a rewrite's origin beside the ask)
  let stopBlock = null; // Stop-class decision:"block" reasons
  const rewrites = []; // PreToolUse updatedInput, per emitting detector
  const harvest = (j) => {
    const hso = j.hookSpecificOutput && typeof j.hookSpecificOutput === "object" ? j.hookSpecificOutput : null;
    if (hso && CONTEXT_EVENTS.has(event) && typeof hso.additionalContext === "string") contexts.push(hso.additionalContext);
    if (typeof j.systemMessage === "string") systemMessages.push(j.systemMessage);
  };
  const readHalt = (j) => {
    if (j.continue === false) {
      halt = true;
      if (typeof j.stopReason === "string") stopReasons.push(j.stopReason);
    }
  };

  for (const o of speaking) {
    const j = parseJson(o.stdout);
    if (o.exitCode === 2) {
      if (advisoryOnly) {
        // Not a refusal here: the host showed this stderr to the USER as a hook
        // error and still delivered every other hook's context. (It also parses a
        // JSON stdout on exit 2, so that detector's own context is kept too; a
        // plain stdout on exit 2 was discarded.)
        userNotes.push(`${o.hook} (exit 2): ${String(o.stderr || "").trim() || "no stderr output"}`);
        if (j) harvest(j);
        continue;
      }
      if (STOP_LIKE.has(event) && j && j.decision === "block") blocking.push(str(j.reason) || o.stderr || "");
      else blocking.push(o.stderr || (j && j.hookSpecificOutput && str(j.hookSpecificOutput.permissionDecisionReason)) || "");
      // The host parses the JSON at exit 2 too (§ JSON IS READ AT EVERY EXIT CODE):
      // a halt printed with the refusal is still a halt — and it WINS — and the
      // same object's systemMessage / additionalContext are still delivered.
      if (j) {
        harvest(j);
        readHalt(j);
      }
      continue;
    }
    if (!j) {
      // Plain stdout on exit 0 is context only at the two events that inject it.
      if (event === "UserPromptSubmit" || event === "SessionStart") contexts.push(o.stdout.trim());
      continue;
    }
    const hso = j.hookSpecificOutput && typeof j.hookSpecificOutput === "object" ? j.hookSpecificOutput : null;
    if (hso && hso.permissionDecision === "deny") blocking.push(str(hso.permissionDecisionReason));
    else if (hso && hso.permissionDecision === "ask") {
      ask = true;
      askers.push(o.hook);
      if (typeof hso.permissionDecisionReason === "string") askReasons.push(hso.permissionDecisionReason);
    }
    else if (hso && hso.permissionDecision === "allow") allow = true;
    if (j.decision === "block") {
      if (advisoryOnly) userNotes.push(`${o.hook} (decision:block): ${str(j.reason) || "no reason given"}`);
      else if (STOP_LIKE.has(event)) (stopBlock = stopBlock || []).push(str(j.reason));
      else blocking.push(str(j.reason));
    }
    harvest(j);
    if (hso && Object.prototype.hasOwnProperty.call(hso, "updatedInput")) {
      // Serialized ONCE, bounded (rewriteKey): the same string is the identity the
      // conflict rule compares, so no rewrite is stringified per comparison either.
      const key = rewriteKey(hso.updatedInput);
      if (key !== null) rewrites.push({ hook: o.hook, value: hso.updatedInput, key, decision: hso.permissionDecision });
      else if (event === "PreToolUse") {
        // A rewrite that cannot be carried is not silently dropped: the call would run
        // UNrewritten, which is not what the detector's owner approved either.
        blocking.push(
          "STOP — Tool call blocked.\n\nWHAT HAPPENED: " + o.hook + " rewrote this tool call (updatedInput) with a value deeper than " +
            MAX_REWRITE_DEPTH + " levels or not serializable, so dispatch.js cannot carry it.\n" +
            "WHY: running the call un-rewritten would run what the detector did not approve. The call did NOT run.\n",
        );
      } else userNotes.push(`${o.hook}: its updatedInput could not be carried (deeper than ${MAX_REWRITE_DEPTH} levels or not serializable) and was dropped`);
    }
    readHalt(j);
  }

  // updatedInput (a rewrite of the tool call — e.g. an arbiter routing a heavy
  // command through `trestle run`). ONE rewrite is carried through intact.
  // Two that DIFFER are a conflict the dispatcher will not resolve by picking
  // one: the call is REFUSED, naming both, so the owners declare a precedence.
  // Identical rewrites are one rewrite. A deny from anyone still wins over any
  // rewrite (a refused call is not run, rewritten or not).
  const distinct = [];
  for (const r of rewrites) {
    if (!distinct.some((d) => d.key === r.key)) distinct.push(r);
  }
  if (distinct.length > 1) {
    blocking.push(
      "STOP — Tool call blocked.\n\nWHAT HAPPENED: CONFLICTING updatedInput — " +
        distinct.map((d) => d.hook).join(" and ") +
        " each rewrote this tool call differently, and dispatch.js does not pick one.\n" +
        "WHY: a silent choice would run a command neither detector's owner approved. " +
        "The call did NOT run.\n\nREPORT TO USER (do not skip any):\n" +
        "  - Name the two detectors and quote both rewrites.\n" +
        "  - The fix is a declared precedence between them (or one of them yielding), not a retry.\n",
    );
  }

  // What the host showed the USER (never the model): every detector's systemMessage,
  // the advisory-only events' refusals-that-are-not, and the failed detectors.
  const shown = systemMessages.concat(userNotes, notes);

  if (blocking.length > 0 && !STOP_LIKE.has(event)) {
    // At UserPromptSubmit the host ends the pass on the first block: the prompt is
    // not sent and no other hook's context reaches the model, so none is appended.
    const extra = contexts.length && event !== "UserPromptSubmit"
      ? "\n\n────────\nALSO REPORTED BY NON-BLOCKING CHECKS ON THIS CALL:\n\n" + joinBlocks(contexts)
      : "";
    const reason = joinBlocks(blocking) + extra;
    const json =
      event === "PreToolUse"
        ? { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason } }
        : { decision: "block", reason };
    // The host parses the JSON at exit 2 as well (§ JSON IS READ AT EVERY EXIT
    // CODE), so user-only notes ride here as the systemMessage they were — shown to
    // the user, never folded into the model-facing reason.
    if (shown.length) json.systemMessage = joinBlocks(shown);
    // stderr is what the host feeds back on exit 2: every refusal reason, then
    // the advisory context. Non-refusing detectors' own stderr stays out, as it
    // did when each hook was a separate process.
    const stderr = "\n" + reason + "\n";
    if (halt) {
      // A detector ALSO asked to end the turn (continue:false). The JSON carries
      // both the refusal and the halt, and the host honours both at exit 0 (it
      // would at exit 2 too — the JSON is read at every status); exit 0 keeps the
      // reply's meaning in its JSON alone.
      json.continue = false;
      if (stopReasons.length) json.stopReason = stopReasons.join("\n");
      return { stdout: JSON.stringify(json) + "\n", stderr, exitCode: 0 };
    }
    return { stdout: JSON.stringify(json) + "\n", stderr, exitCode: 2 };
  }

  // Stop-class events: an exit-2 refusal (the host's "block the stop, hand stderr
  // to the model") and a JSON decision:"block" are one refusal; neither is lost
  // because another detector spoke. systemMessage stays a systemMessage (the host
  // shows it to the user, never to the model) and additionalContext stays context
  // — both in the JSON, which the host READS at exit 2 (§ JSON IS READ AT EVERY EXIT
  // CODE: hq takes the block text from decision:"block"'s reason, the systemMessage
  // and the additionalContext from the same object; stderr stands in only when the
  // JSON carries no block). Folding them into the reason instead would deliver the
  // context twice and show the model a user-only note.
  if (blocking.length > 0 && STOP_LIKE.has(event)) {
    const reason = joinBlocks(blocking.concat(stopBlock || []));
    const json = { decision: "block", reason };
    if (shown.length) json.systemMessage = joinBlocks(shown);
    if (contexts.length) json.hookSpecificOutput = { hookEventName: event, additionalContext: joinBlocks(contexts) };
    if (halt) {
      // continue:false WINS at Stop (the host checks it before the blocks). The
      // JSON carries it at any status; exit 0 keeps the reply's meaning in the JSON.
      json.continue = false;
      if (stopReasons.length) json.stopReason = stopReasons.join("\n");
      return { stdout: JSON.stringify(json) + "\n", stderr: "\n" + reason + "\n", exitCode: 0 };
    }
    return { stdout: JSON.stringify(json) + "\n", stderr: "\n" + reason + "\n", exitCode: 2 };
  }

  const json = {};
  if (stopBlock) {
    json.decision = "block";
    json.reason = joinBlocks(stopBlock);
  }
  json.continue = !halt;
  if (halt && stopReasons.length) json.stopReason = stopReasons.join("\n");
  if (shown.length) json.systemMessage = joinBlocks(shown);
  if (contexts.length || ask || allow || distinct.length === 1) {
    json.hookSpecificOutput = { hookEventName: event };
    if (ask) {
      json.hookSpecificOutput.permissionDecision = "ask";
      // An ask carried WITH a rewrite some OTHER detector made (round-6 SEC LOW-2): the
      // user is asked about the REWRITTEN call, so the question names who rewrote it —
      // otherwise the ask reads as if its own detector had proposed the new command.
      const reasons = askReasons.slice();
      if (distinct.length === 1) {
        const by = [...new Set(rewrites.filter((r) => r.key === distinct[0].key).map((r) => r.hook))].filter((h) => !askers.includes(h));
        if (by.length) reasons.push(`NOTE: this tool call was also REWRITTEN (updatedInput) by ${by.join(", ")}, which did not ask; approving runs the rewritten call.`);
      }
      if (reasons.length) json.hookSpecificOutput.permissionDecisionReason = joinBlocks(reasons);
    }
    else if (allow) json.hookSpecificOutput.permissionDecision = "allow";
    if (distinct.length === 1) json.hookSpecificOutput.updatedInput = distinct[0].value;
    if (contexts.length) json.hookSpecificOutput.additionalContext = joinBlocks(contexts);
  }
  return { stdout: JSON.stringify(json) + "\n", stderr: allStderr, exitCode: 0 };
}

/**
 * The LAST-RESORT reply for restrictive verdicts already reached, when the full
 * merge could not be built (lib/dispatch-main.js::lateFaultReply). Built from string fields
 * only, with nothing a detector supplies interpreted beyond a type check, so it
 * cannot be made to throw by what a detector printed. It keeps the one thing that
 * must survive: the call / stop / prompt / compaction is REFUSED, with every reason
 * that could be read, and a detector's own halt (continue:false) is kept. An `ask`
 * becomes a refusal here (the stricter reading). `extra` (the fault's own text) is
 * appended.
 */
function restrictiveReply(event, verdicts, extra) {
  const reasons = [];
  const stopReasons = [];
  let halt = false;
  for (const o of verdicts || []) {
    let j = null;
    try {
      j = parseJson(str(o && o.stdout));
    } catch {}
    const hso = j && j.hookSpecificOutput && typeof j.hookSpecificOutput === "object" ? j.hookSpecificOutput : {};
    const exit2 = o && o.exitCode === 2 && str(o.stderr).trim();
    reasons.push(exit2 || (j && str(j.reason)) || str(hso.permissionDecisionReason) || str(o && o.stderr).trim() || `${str(o && o.hook) || "a detector"} refused (no reason given)`);
    if (j && j.continue === false && event !== "PreCompact") {
      halt = true;
      if (typeof j.stopReason === "string") stopReasons.push(j.stopReason);
    }
  }
  if (str(extra).trim()) reasons.push(str(extra));
  const reason = joinBlocks(reasons) || "refused (no reason could be read)";
  // PreCompact reads no JSON envelope: exit 2 blocks, stderr is the reason.
  if (event === "PreCompact") return { stdout: "", stderr: reason + "\n", exitCode: 2 };
  const json =
    event === "PreToolUse"
      ? { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason } }
      : { decision: "block", reason };
  if (halt) {
    json.continue = false;
    if (stopReasons.length) json.stopReason = stopReasons.join("\n");
    return { stdout: JSON.stringify(json) + "\n", stderr: "\n" + reason + "\n", exitCode: 0 };
  }
  return { stdout: JSON.stringify(json) + "\n", stderr: "\n" + reason + "\n", exitCode: 2 };
}

// ---------------------------------------------------------------------------
// runCli — the standalone entry every migrated hook ends with
// ---------------------------------------------------------------------------

const SELFTEST_ENV = "COC_HOOK_ENGINE_SELFTEST";
const SELFTEST_LOG_ENV = "COC_HOOK_ENGINE_SELFTEST_LOG";

/**
 * The CLI guard of a migrated hook:
 *
 *     module.exports = { ..., hookMain };
 *     if (require.main === module) require("./lib/hook-engine.js").runCli(hookMain, __filename);
 *
 * Normally this is exactly `hookMain()` — the standalone run is the hook's own
 * code, unchanged. With `COC_HOOK_ENGINE_SELFTEST=1` it instead runs the hook
 * THROUGH the engine sandbox and replays the captured outcome as this process's
 * own stdout / stderr / exit code. That turns every existing suite that spawns
 * a hook into an equivalence oracle for the in-process path: run the corpus
 * with the variable set and any divergence between "process" and "in-engine"
 * semantics surfaces as a red case. The variable only changes WHERE the same
 * code runs; it cannot skip or narrow a detector.
 */
function runCli(hookMain, file) {
  if (process.env[SELFTEST_ENV] !== "1") return hookMain();
  const chunks = [];
  const stdin = process.stdin;
  const go = async () => {
    // Start the detector from a MICROTASK, as the dispatcher's worker does for every
    // detector after the first. From a stream 'end' handler (a nextTick context) the
    // detector's own stdin ticks would drain before any microtask, which hid the
    // class where a hook is finished before its stdin 'end' fires.
    await null;
    const raw = Buffer.concat(chunks).toString("utf8");
    const o = await runDetector({ hook: path.basename(file), file, timeoutMs: 600000 }, raw);
    const logPath = process.env[SELFTEST_LOG_ENV];
    if (logPath) {
      // Test-only evidence trail (which runs went through the engine). Routed through the
      // hardened append primitive like every other sink under hooks/ (append-sink.js § Scope).
      try {
        require("./append-sink.js").appendSinkLine({
          repoDir: path.dirname(path.resolve(logPath)),
          sinkPath: path.resolve(logPath),
          line: JSON.stringify({ hook: path.basename(file), status: o.status, exit: o.exitCode }),
        });
      } catch {}
    }
    const real = state.real;
    try {
      if (o.stderr) real.err(o.stderr);
    } catch {}
    real.out(o.stdout || "", () => real.exit(o.exitCode === null ? 1 : o.exitCode));
  };
  if (!stdin || stdin.isTTY) return go();
  stdin.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
  stdin.on("end", go);
  stdin.on("error", go);
  return undefined;
}

module.exports = {
  ENTRY_EXPORT,
  SELFTEST_ENV,
  runCli,
  EXIT_SENTINEL,
  runDetector,
  runDetectorsIsolated,
  matcherMatches,
  matcherMatchesWithoutRegex,
  mergeOutcomes,
  restrictiveReply,
  MAX_REWRITE_DEPTH,
  parseJson,
  isSilent,
  isFailure,
  isRestrictive,
  closesLocalGate,
  now,
  LIST_MATCHER_EVENTS,
  _state: state,
};
