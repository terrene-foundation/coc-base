/**
 * lib/dispatch-main.js — the hook dispatcher's BODY, started by the bootstrap
 * `.claude/hooks/dispatch.js <Event>` (the file settings.json names). ONE process per
 * hook event.
 *
 * WHY A BOOTSTRAP (round-6 SEC MEDIUM-1). Every event's guards run behind this one
 * dispatcher, so a syntax error or a deleted file here would make node exit 1 before
 * any handler below is installed — at PreToolUse a NON-blocking error, i.e. every
 * call runs with zero guards. The bootstrap is a small builtins-only file (held under a
 * 350-line cap by hook-engine.test.mjs),
 * edited only to change the fault reply or the repair hatch; it loads this file inside try/catch and,
 * if loading or starting it fails, refuses at PreToolUse (with the repair hatch, which
 * it owns — `repairHatch` below delegates to it — minus its Edit/Write half: this file
 * has no content pin, round-7) and fails loud elsewhere. This
 * file is therefore NOT the process's main module: the bootstrap calls `start()`.
 * In the text below "dispatch.js" names the dispatcher as a whole — the name the
 * host, the registry and every reply use.
 *
 * Reads the host's payload once, selects the detectors `dispatch-registry.json`
 * lists for <Event> whose matcher admits this call (the host's own matcher rule,
 * against the payload field the host matches at that event), runs them through
 * `lib/hook-engine.js` in WORKER THREADS of this one process — one after another
 * in registry order, or all at once where the registry says `isolation:
 * "parallel"` (SessionEnd); a row declaring `on_incomplete: "deny"` gets a worker
 * of its own, so no SHARED-BATCH row's realm mutation — or git answer — can reach
 * its verdict (hook-consolidation S3, the per-row boundary; round-6 SEC R1-F2:
 * the engine keeps per-realm-kind git-answer pools, and a deny row may read only
 * answers written by DENY rows — it shares that one isolated pool with the other
 * deny rows BY DESIGN; a shared-batch row's answers never reach it, and its
 * answers never reach a shared batch), and a deny row that does not COMPLETE
 * refuses at PreToolUse (§ FAIL-CLOSED FOR INCOMPLETE DENY ROWS below) — and
 * writes ONE merged reply, its parts in registry order. See `lib/hook-engine.js`
 * for the per-detector sandbox contract (stdin / stdout / exit / argv / crash /
 * timeout) and the merge rule (any deny wins; every reason is handed back in one
 * message).
 *
 * FAILURE POLICY OF THE DISPATCHER ITSELF.
 *   - A detector crashing or overrunning its budget is contained by the engine
 *     and fails as that hook always failed: neither is a refusal, a crash (or any
 *     non-zero exit other than 2 without a JSON reply) is shown to the USER as
 *     the host showed a non-blocking hook error, and a killed one contributes
 *     nothing (the host shows a timeout only at UserPromptSubmit) —
 *     hook-engine.js § FAILED DETECTORS. THE ONE EXCEPTION is a row declaring
 *     `on_incomplete: "deny"` (round-6 SEC R1-F3): its crash / own-budget
 *     overrun / exit other than 0 or 2 (JSON or not) REFUSES at PreToolUse, fail-closed —
 *     the declaration is a contract, and an unrun deny-capable guard must not
 *     read as one that passed. That is a detector killed on its OWN
 *     budget. One the EVENT deadline kept from starting, or stopped before its own
 *     budget ran out, is STARVED — a guard that could not run, which the host never
 *     did to a hook: refused at PreToolUse like an engine fault (same repair hatch),
 *     a note elsewhere.
 *   - The REGISTRY being missing or invalid at PreToolUse would silently switch
 *     EVERY guard off at once — a blast radius no single hook ever had. So it
 *     FAILS CLOSED there: the call is refused with a reason naming the file,
 *     EXCEPT read-only lookups (Read/Grep/Glob) and a call that names the
 *     registry itself, so the fault can be diagnosed and repaired in-session.
 *     At every other event it fails open, loudly.
 *   - A detector file the registry names but this tree does not carry is
 *     SKIPPED: a consumer that was not delivered a loom-only hook never had it
 *     registered either (the settings reconciler only propagated registrations
 *     whose script resolved on disk).
 *   - REPO-OWNED detectors (`.claude/dispatch-registry.local.json`) never run in
 *     this process or below it: `runLocalSupervised` starts lib/local-supervisor.js
 *     through a launcher that exits at once, so the supervisor is re-parented and in
 *     a session/process group of its own. A supervisor that cannot start, dies,
 *     overruns the event or breaks its frame protocol is a local-registry fault —
 *     refused at PreToolUse like an unreadable local registry, loud elsewhere.
 *   - Nothing the REPO supplies is read, parsed or evaluated here before loom's
 *     verdict exists: loom's detectors are selected from loom's registry alone and
 *     run first; `.claude/dispatch-registry.local.json` is opened only after that,
 *     and only when loom reached no verdict a repo detector could not outrank (a
 *     deny / block / halt wins whatever the file says; a loom `ask` does not close
 *     the gate — a repo deny outranks it at the host). Any repo-controlled work on this thread could stall
 *     it — the watchdog is a timer on this same thread and cannot fire — until the
 *     host killed the dispatcher: a non-blocking kill, so the call would run with
 *     NO loom guard. What is done here after loom's run is bounded by the FILE, not
 *     by its content: a size cap checked by fstat before reading and a per-event
 *     row cap (lib/dispatch-registry.js), plain-list matchers of at most
 *     MAX_DISPATCHER_MATCHER_CHARS decided here once per distinct string (splitting
 *     on `|` cannot backtrack, and deciding them here keeps a registry of list rows
 *     that match nothing from starting a supervisor on every call), and every other
 *     repo matcher — a regular expression, or an over-long list — decided only
 *     inside the supervisor, which the backstop kills as a group.
 *   - dispatch.js itself throwing (or overrunning its budget — the watchdog) is the
 *     registry-fault blast radius too: refused at PreToolUse, loud elsewhere —
 *     whether the throw reaches main()'s promise or escapes it from an event handler
 *     (the process-level handlers at the bottom). The repair hatch admits a call
 *     there only when no detector had already reached a restrictive verdict; one
 *     that had is still delivered — at EVERY event with a refusal (a Stop /
 *     UserPromptSubmit / PreCompact block too), with the fault beside it
 *     (lateFaultReply; outcomes are reported live, so a fault mid-run sees them).
 */
"use strict";

const path = require("path");
const fsExists = (p) => {
  try {
    return require("fs").statSync(p).isFile();
  } catch {
    return false;
  }
};

// .claude/hooks — the bootstrap's directory; every path below is relative to it.
const HOOKS_DIR = path.resolve(__dirname, "..");
// The leading bytes of `dispatch-registry.js::resolvePinnedRegistryText`'s "changed on
// disk" note (the kept copy serves; NOT the "cannot be read" fault). Pinned against the
// producer by test-harness/tests/hook-output-economy-perf.test.mjs.
const PIN_CHANGED_NOTE_PREFIX =
  ".claude/hooks/dispatch-registry.json changed on disk since this session's hook settings were loaded;";
// The event is the dispatcher's argument; a probe that spawns the script bare
// (hook-runtime-smoke, validate-hooks) gets it from the payload instead.
let event = process.argv[2];
// `--registry-sha256=<hex>`: the registry content this (session-snapshotted)
// settings entry was written for — see dispatch-registry.js::DISPATCH_COMMAND_RE.
const pinArg = (process.argv.slice(3).find((a) => a.startsWith("--registry-sha256=")) || "").slice("--registry-sha256=".length) || null;
// MONOTONIC (round-5 LOW-2): every deadline and budget below is arithmetic on
// performance.now(), which a wall-clock step (NTP, a manual date change, a VM
// resume) cannot move. On Date.now() a forward step mid-run made a detector's
// remaining budget negative, and the guards after it read as STARVED — a refusal
// at PreToolUse of a call nothing had objected to. The engine's deadline is on this
// same clock (lib/hook-engine.js::now).
const { performance } = require("perf_hooks");
const monoNow = () => performance.now();
// The dispatch's start. `start({t0})` replaces it with the instant the BOOTSTRAP
// began, so the time spent loading this file is charged to the event's budget.
let t0 = monoNow();

const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
const realExit = process.exit.bind(process);

let hardExit = false; // set when a worker was abandoned while possibly stuck

/**
 * THE COMPLETION RECORD (round-8 SEC HIGH-1). The bootstrap loads this file and
 * calls `start()`, so a body that loads, exports a `start` and then ANSWERS NOTHING
 * looked exactly like a body that dispatched: `module.exports = { start(){} }`
 * compiles, emits nothing and exits 0 — and at PreToolUse the host reads an empty
 * stdout at exit 0 as an ALLOWED call, every guard off with no visible signal. The
 * bootstrap therefore requires an AFFIRMATIVE record, and `start()` RETURNS this one:
 *   - `ran`     — start() was entered and this module took responsibility for the
 *                 event's reply. The bootstrap reads it the moment start() returns,
 *                 and refuses through its own boot-fault path if it is absent.
 *   - `emitted` — the process reached its ANSWER. Set on the one path that hands the
 *                 reply to the streams (finish) and on the last-resort bare exit the
 *                 fatal handler takes when even that reply cannot be built — never as
 *                 a promise that the reply will go out. The record is LIVE and the
 *                 bootstrap re-reads it at process exit, so a body that started and
 *                 then never answered is refused too: what the record affirms at
 *                 return is that the dispatch STARTED, and only emission shows it
 *                 finished.
 *                 MEASURED LIMITS: the bootstrap's check is a process 'exit' listener,
 *                 and node emits no 'exit' for every way a process can end, so the
 *                 check does NOT run in all of them:
 *                   - SIGKILL, and an abort-driven OOM (process.abort()), cannot be
 *                     caught at all. Both end the image with the check unrun — MEASURED
 *                     on this tree: SIGKILL gives rc=137 with BOTH streams empty, and
 *                     process.abort() gives rc=134 with a native trace on stderr; the
 *                     BOOT-FAULT count is 0 in both. At PreToolUse a non-2 exit carrying
 *                     no deny JSON is an ALLOWED call, so this is the very silent-allow
 *                     property this record exists to defend — and for these two it is
 *                     NOT closed.
 *                   - SIGTERM and SIGINT ARE catchable, and the bootstrap catches them
 *                     (dispatch.js::watchEmission), exiting through this same listener
 *                     so the marker and the disposition stay one implementation.
 *                     UNCATCHABLE they were the same silent allow (MEASURED against the
 *                     pre-fix bootstrap: rc=143, both streams empty, count 0), which is
 *                     why the pair is caught rather than merely documented.
 *                   - `end()` replacing this image with process.execve (a detector was
 *                     abandoned while possibly stuck) is reachable ONLY from `end()` —
 *                     i.e. only after the reply was handed to the streams — so a body
 *                     that answers nothing never ends there. What that limit costs is
 *                     narrower: a body that EMITS but fails to mark is not caught on the
 *                     execve path, and its reply still reaches the host.
 *   - `event`   — the event, as soon as it is known (argv, then the payload), so the
 *                 exit check takes the disposition this file already gives a
 *                 dispatcher it could not load: a refusal at PreToolUse, loud
 *                 elsewhere. An unknown event fails closed to the refusal.
 * A body that does not carry this record fails CLOSED: the bootstrap refuses it at
 * PreToolUse and is loud elsewhere, exactly as for a body that fails to load.
 *
 * MOVED FROM THE BOOTSTRAP, verbatim (engine-w1 R1 LOW-5 — `dispatch.js` holds its line
 * cap by keeping only the code there; its two pointers name this block). From
 * `dispatch.js::watchEmission`:
 *   The COMPLETION RECORD a started body must hand back (round-8 SEC HIGH-1). "The body
 *   loads and `start` is a function" describes a MODULE: `module.exports = { start(){} }`
 *   is all of it, answers nothing, exits 0, and at PreToolUse the host reads empty stdout
 *   at exit 0 as an ALLOWED call — every guard off with no visible signal. Fields,
 *   rationale and the measured execve limit live in lib/dispatch-main.js::completion.
 *   `ran` is required below, the moment start() returns; `emitted` is required at exit.
 *   THE EXIT HALF NOW LIVES IN THE EARLY OBSERVER (R2 M4): it is installed before the
 *   body is required, so it also covers an exit with NO record at all (at load, inside
 *   start(), before main()'s first await) — this function hands it the record and keeps
 *   only the CATCHABLE half. The refusal is this file's EXISTING boot-fault disposition
 *   — exit 2 with the fixed BOOT-FAULT marker at PreToolUse, a loud exit 1 with the same
 *   marker elsewhere — never a second deny shape. An ANSWERED event returns at once and
 *   touches nothing — that is what keeps a real hook's exit code unchanged.
 * From the bootstrap's early exit observer (`dispatch.js`, the `process.on("exit")` block):
 *   THE EARLY EXIT ANSWER (R2 M4 — the round-2 early-exit finding, HIGH; the tenant
 *   label in the finding's case name is deliberately NOT reproduced here — this file
 *   is on the SYNCED surface and a tenant identity token is a disclosure finding
 *   there, `scan-synced-disclosure`).
 *   Installed ONLY when this file is the process's main module, and BEFORE the body
 *   below is required. The completion check further down can only see an exit AFTER
 *   start() RETURNS — the record is handed back then — so a `process.exit(0)` at the
 *   body's LOAD, inside start(), or in main() before its first await ended the image
 *   with EMPTY output at status 0, which the host reads as an ALLOWED call, every
 *   guard off with no visible signal. ONE exit listener owns every end-with-no-reply
 *   (the old watchEmission exit listener is folded in here, so there is never a
 *   second fault shape): no reply was written (`completion.answered`) and no emitted
 *   record exists ⇒ PreToolUse (or an unknown/absent event) is REFUSED — exit 2 with
 *   the fixed BOOT-FAULT marker on stderr, which the host reads as the block text —
 *   and every NAMED non-PreToolUse event stays loud (exit 1, no JSON). A reply that
 *   WAS written returns at once and leaves the exit code untouched. `fs.writeSync`
 *   is the one write that still lands while the process is exiting.
 */
const completion = { ran: false, event: null, emitted: false };

/**
 * Write the reply and end. Both streams are written with completion callbacks
 * (an async pipe write followed by an immediate exit can truncate a large reply —
 * and a truncated reply can cut a deny out). When a worker was abandoned (stuck
 * in a busy loop or a blocking spawnSync), a normal exit would JOIN that thread
 * and could outlive the host's timeout, losing every verdict: the process image
 * is replaced by `sh -c "exit N"` instead, which keeps the exit code and the
 * already-flushed output and drops the stuck thread.
 */
let finishing = false;
function finish({ stdout, stderr, exitCode, findingsDelivery, findingsContext }) {
  if (finishing) return; // one reply per event (the watchdog may race the normal path)
  finishing = true;
  // Stop only — the per-attempt receipt's queue reading, taken HERE, at the attempt and before
  // the stdout handoff (lib/stop-receipt.js). Keyed on the completion record's `event` (the
  // same value main()/start() resolve), so this block stays self-contained: the receipt
  // helpers live OUTSIDE it, below readAllStdin, and are reached only for a Stop.
  const isStop = completion.event === "Stop";
  const stopQueue = isStop ? stopQueueAtAttempt() : null;
  const end = () => {
    // The answer is going out: the bootstrap's exit check must see it, or a reply
    // that IS emitted would be refused as one that was not. Set here, on the write's
    // own completion callback, never earlier.
    completion.emitted = true;
    if (hardExit && typeof process.execve === "function" && process.platform !== "win32") {
      try {
        process.execve("/bin/sh", ["sh", "-c", `exit ${Number(exitCode) | 0}`], {});
      } catch {}
    }
    realExit(exitCode);
  };
  const writeOut = () => {
    const handedOff = (err) => {
      if (err) {
        try { realErr("HOOK-FINDINGS STDOUT HANDOFF FAILED — receipts remain pending: " + String(err.message || err) + "\n"); } catch {}
        exitCode = exitCode || 1;
        if (isStop) stopAttemptReceipt(stopQueue, { stdoutHandoff: "failed", ack: "skipped", exitCode });
        return end();
      }
      let ack = "failed";
      try {
        if (!require("./hook-findings.js").confirmDelivery(findingsDelivery || [], findingsContext))
          realErr("HOOK-FINDINGS ACK WRITE FAILED — findings may be delivered again.\n");
        else ack = "ok";
      } catch (e) {
        try { realErr("HOOK-FINDINGS ACK FAILED — findings remain pending: " + String(e.message || e) + "\n"); } catch {}
      }
      // THE RECEIPT SEAM: after the stdout handoff completed (this callback) and after the
      // findings ACK above, before end() — so the row reports the outcomes it OBSERVED.
      if (isStop) stopAttemptReceipt(stopQueue, { stdoutHandoff: "ok", ack, ackReceipts: (findingsDelivery || []).length, exitCode });
      end();
    };
    try {
      realOut(stdout || "", handedOff);
    } catch (e) {
      handedOff(e);
    }
  };
  try {
    if (stderr) return realErr(stderr, writeOut);
  } catch {}
  writeOut();
}

// Shared stdin deadline: .claude/hooks/lib/hook-input-budget.js:3-5.
//
// WHY A BUDGET AT ALL (guard-foundation S4 / A9, spec `adapters.md` § "Hook budget:
// 2 s / 4 MiB input"). This read is the FIRST statement of main() and the
// whole-dispatch watchdog is armed AFTER it, so nothing else bounds it. On a stdin
// that never closes the previous form — which resolved only on `end`/`error` —
// held the CC enforcement path until the HOST killed the process: the PreToolUse
// dispatcher's registered timeout (`dispatch-registry.json`
// `events.PreToolUse.dispatcher.timeout`, several hundred seconds and re-derived as
// guards are added — read it there, never from a copy here) is what a never-closing
// stdin cost, with every guard unrun, and on its own timeout the host lets the
// CALL RUN (MEASURED on CC, `adapters.md` § host-timeout) — so the refusal must
// come from INSIDE this process, exactly as the Codex runtime's does.
const { STDIN_READ_TIMEOUT_MS, HookBudgetExceeded } = require("./hook-input-budget");
/**
 * The byte ceiling — the BOOTSTRAP's constant (`dispatch.js::STDIN_MAX_BYTES`), read from
 * there and never retyped (engine-w1 R1 LOW-5): the bootstrap's own fault-path read holds
 * the SAME ceiling, and the bootstrap may load nothing from lib/, so the one constant lives
 * in it and this file reads it. Read LAZILY, at the read, never at this module's load: a
 * top-level require of the bootstrap from here would be a load cycle whenever this module
 * is required first (a suite's driver), and the bootstrap THROWS on a body that exports no
 * start(). A bootstrap that cannot be read back is a throw — main()'s fatal path, which
 * refuses at PreToolUse — never a guessed ceiling.
 */
function stdinMaxBytes() {
  const v = require(path.join(HOOKS_DIR, "dispatch.js")).STDIN_MAX_BYTES;
  if (!Number.isSafeInteger(v) || v <= 0) throw new Error("dispatch.js exports no usable STDIN_MAX_BYTES");
  return v;
}

/**
 * The dispatcher's read of the host's payload — BOUNDED, and the only read on this
 * path. Resolves `{ raw, fault, bytes }`:
 *   - `raw` is every byte that arrived, as UTF-8 — the detectors' stdin
 *     (`hook-engine.js` hands each one "the SAME raw payload bytes").
 *   - `bytes` is the count of bytes that ARRIVED (over the ceiling, including the
 *     chunk that was not kept) — the figure a refusal reports, never a re-measure
 *     of `raw`, whose decoding turns each invalid byte into a 3-byte U+FFFD.
 *   - `fault` is null unless one of the two bounds fired:
 *       `{ kind: "deadline", bytes }` — EOF never came inside STDIN_READ_TIMEOUT_MS.
 *       `{ kind: "ceiling", bytes }`  — more than STDIN_MAX_BYTES arrived. The
 *         deadline bounds the WAIT; this bounds the SIZE, so a producer that
 *         streams forever inside the window cannot grow the buffer without end.
 *         Counted in BYTES — the unit `MAX_INPUT_BYTES` names — never in UTF-16
 *         code units, which under-count multibyte input by up to 4x.
 *
 * A fault is a FAULT, never a payload: the buffer may be truncated (a JSON prefix
 * that happens to parse is still not the call as the host wrote it), so the caller
 * dispatches NOTHING from it and refuses at PreToolUse — the disposition the Codex
 * native runtime takes when its own read is rejected ("hook stdin deadline
 * exceeded" / "hook input exceeds 4 MiB limit", `codex-hook-runtime.js`). What the
 * buffer IS used for is the repair hatch's decision — a read-only lookup no deny row
 * for it is registered at the event (S-C F1; never true in loom's own registry) — the
 * event when argv named none, a Stop's `stop_hook_active` flag, and, on a deadline over
 * a whole document, which deny rows it narrows to (`stdinBoundFaultReply`) — the same "arm the bound, then answer with whatever
 * arrived" shape the bootstrap's own fault path takes (`dispatch.js::bootFault`,
 * its 3,000 ms timer).
 *
 * A stream `error` is NOT a fault: it resolves what arrived, the disposition this
 * reader has always taken — a stdin hiccup must not be relabelled a bound firing.
 */
function readAllStdin() {
  const STDIN_MAX_BYTES = stdinMaxBytes(); // the bootstrap's ONE constant (stdinMaxBytes)
  return new Promise((resolve) => {
    const chunks = [];
    const s = process.stdin;
    let bytes = 0;
    let settled = false;
    let timer = null;
    const settle = (fault) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // `onError` is deliberately KEPT: after a bound fires the stream is still
      // open, and an `error` with no listener is thrown — it would reach the fatal
      // handler and replace this reply. Once settled, onError is a no-op.
      try {
        s.removeListener("data", onData);
        s.removeListener("end", onEnd);
      } catch {
        // best-effort listener cleanup
      }
      resolve({ raw: Buffer.concat(chunks).toString("utf8"), fault, bytes });
    };
    const onData = (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
      bytes += buf.length;
      // Past the ceiling the chunk is not kept: a payload this large is not a
      // genuine tool event, and the answer is the refusal the deadline takes.
      if (bytes > STDIN_MAX_BYTES) return settle({ kind: "ceiling", bytes });
      chunks.push(buf);
    };
    const onEnd = () => settle(null);
    const onError = () => settle(null);
    if (!s || s.isTTY) return settle(null);
    s.on("data", onData);
    s.on("end", onEnd);
    s.on("error", onError);
    // The WAIT bound. Deliberately not unref'd while it lives: it is what makes
    // this promise settle at all. `settle` clears it on every other path, so a
    // normal read carries no live timer into the dispatch that follows (which may
    // legitimately run for most of the event's registered timeout).
    //
    //
    // ACCEPTED RESIDUAL: if this process's loop stalls past the bound, the expired
    // timer can run ahead of an EOF already waiting in the pipe, and a complete,
    // closed payload is answered as a deadline. What that costs is availability only:
    // at PreToolUse the call is refused, a Read/Grep/Glob included wherever a guard
    // that can refuse it is registered (S-C F1 — before, the hatch admitted those
    // three unvetted, so a stall was a fail-OPEN path for them); at an event with a
    // deny row it is that event's row of the per-event table (incompleteDenyDisposition)
    // plus a durable record of the skipped guards. A one-turn setImmediate deferral was tried and
    // MEASURED insufficient: on two of three fleet hosts (Node v24.21 Linux, v25.8
    // Darwin) the data arrived in the deferred turn but the `end` did not, so no
    // fixed deferral closes it, and a stall-detecting grace period would put a
    // timing heuristic on the enforcement path.
    timer = setTimeout(() => settle({ kind: "deadline", bytes }), STDIN_READ_TIMEOUT_MS);
  });
}

// ── THE PER-ATTEMPT STOP RECEIPT (lib/stop-receipt.js) — measurement, never trust state ──
// The wall-clock instant this attempt began (start() back-dates it to the bootstrap's t0),
// the registry text's digest the dispatch actually parsed (main), and the boundary commit's
// return (main: undefined = never reached, null = no commit ran, else commitStopReadiness's).
let attemptedAtMs = Date.now();
let registrySha256 = null;
// THE receipt sink's anchor: THIS dispatcher's own repo (`.claude/hooks/../..`, HOOKS_DIR is
// realpath'd), never the payload's cwd or CLAUDE_PROJECT_DIR. ONE constant for the full receipt
// AND the minimal skip row, so the two writes cannot drift apart (SRS-R1 S-1).
const STOP_SINK_ROOT = path.resolve(HOOKS_DIR, "..", "..");
let stopCommit;
// The monotonic instant the HOST kills this dispatch — t0 + the registry's dispatcher timeout,
// set by main() once the registry parsed; null before that (a registry fault never sets it).
let stopHostDeadlineAt = null;
// "fatal" once the fatal handler answers — set BEFORE it calls finish(), so the receipt that
// finish() would otherwise take is skipped and nothing stands between the fault reply and exit.
let stopLateFault = null;
// True once main() answers a fired stdin bound (readAllStdin) — set BEFORE that reply's
// finish(). Such a Stop never reached the registry, so without this the receipt would be
// filed as a "registry-fault" (and, for a deadline, past the early-fault bound, not at all).
let stopStdinBound = false;
/**
 * THE RECEIPT'S TIME RESERVES — two tiers, one budget arithmetic. Every receipt step runs only
 * while enough time remains before the host's kill: a receipt that delayed the exit past that
 * kill would turn a delivered Stop reply into a host timeout. The per-subprocess caps on the
 * receipt path, each bounded in its own module:
 *   (q) the queue read's main-checkout resolve — state-resolver.js::DEFAULT_BUDGET_MS, 3500 ms;
 *   (c) the handover-cycle locator: its ps-ancestry fallback when CLAUDE_CONFIG_DIR is unset
 *       (context-meter.js::psInfo, 1500 ms × up to TERMINAL_KEY_MAX_HOPS + 1 = 5 calls = 7500 ms)
 *       plus its own resolve (another 3500 ms);
 *   (a) the append primitive's landing-window probe (append-sink.js → landing-window-read.js::
 *       windowCovers): resolveCommonGitDir directly, again through resolvePrimaryRoot, and
 *       linkedWorktreeTops' `git worktree list` plus ITS OWN resolvePrimaryRoot — four 5000 ms
 *       git calls, none memoized — and, when a window record exists, classifyWindow's
 *       processStartToken ps (2000 ms). (a) = 22000 ms.
 * FULL receipt = (q) + (c) + (a) = 3500 + 11000 + 22000 = 36.5 s ⇒ STOP_RECEIPT_RESERVE_MS = 40 s.
 * (This reserve read 35 s while its sum counted (a) as three git calls and no ps — 29.5 s; the
 * fourth git call and the ps put the true worst case above 35 s.)
 * MINIMAL skip row = (a) alone — it does no queue read and no cycle locate — 22 s
 * ⇒ STOP_RECEIPT_MINIMAL_RESERVE_MS = 25 s. Below it, the skip is one stderr line only.
 * The production Stop timeout is 118 s (dispatch-registry.json Stop.dispatcher.timeout, mirrored
 * at settings.json's Stop entry), so a normally-paced Stop always has the full reserve; the
 * WATCHDOG's stall reply fires 1 s before the kill, so both reserves always refuse it.
 */
const STOP_RECEIPT_RESERVE_MS = 40000;
const STOP_RECEIPT_MINIMAL_RESERVE_MS = 25000;
/**
 * A REGISTRY FAULT answers before the registry names the host's timeout, so the remaining budget
 * is not knowable — only the time ALREADY SPENT is. The fault reply goes out within ~50 ms of t0;
 * while no more than this has elapsed, ANY host Stop timeout ≥ 27 s (this + the minimal reserve)
 * still leaves the minimal row its 25 s. Claude Code's default hook timeout is 60 s and loom pins
 * 118 s, so the minimal row is taken; a fault answered later than this writes stderr only.
 */
const STOP_RECEIPT_EARLY_FAULT_MS = 2000;

/**
 * Why THIS Stop takes no FULL receipt, or null (a full receipt). Read at the attempt and again
 * at the row. A skip is {code, why, minimal}: `minimal` true ⇒ the row step writes the minimal
 * skip row (lib/stop-receipt.js::buildSkippedReceipt) — enough budget is left for the append
 * alone; false ⇒ one stderr line only. `code` is the row's `skipped` value.
 */
function stopReceiptSkipReason() {
  if (stopLateFault) return { code: stopLateFault, minimal: false, why: `the dispatcher's ${stopLateFault} path answers without a receipt` };
  if (stopStdinBound) {
    // The event's budget was never taken, so — as for a registry fault — only the time
    // spent is knowable. A deadline answers just past STDIN_READ_TIMEOUT_MS, so the early
    // bound is shifted by it: any host Stop timeout of at least 29 s (STDIN_READ_TIMEOUT_MS
    // 2 s + STOP_RECEIPT_EARLY_FAULT_MS 2 s + STOP_RECEIPT_MINIMAL_RESERVE_MS 25 s) still
    // leaves the minimal row its reserve.
    const spent = Math.max(0, Math.round(monoNow() - t0));
    const bound = STDIN_READ_TIMEOUT_MS + STOP_RECEIPT_EARLY_FAULT_MS;
    return spent <= bound
      ? { code: "stdin-bound", minimal: true, why: `the dispatcher's input read hit its bound, so the event's time budget was never taken; ${spent} ms spent, inside the ${bound} ms early-fault bound` }
      : { code: "stdin-bound", minimal: false, why: `the dispatcher's input read hit its bound, so the event's time budget was never taken, and ${spent} ms are already spent, past the ${bound} ms early-fault bound` };
  }
  if (stopHostDeadlineAt === null) {
    const spent = Math.max(0, Math.round(monoNow() - t0));
    return spent <= STOP_RECEIPT_EARLY_FAULT_MS
      ? { code: "registry-fault", minimal: true, why: `the dispatch's time budget is unknown (the registry did not load); ${spent} ms spent, inside the ${STOP_RECEIPT_EARLY_FAULT_MS} ms early-fault bound` }
      : { code: "registry-fault", minimal: false, why: `the dispatch's time budget is unknown (the registry did not load) and ${spent} ms are already spent, past the ${STOP_RECEIPT_EARLY_FAULT_MS} ms early-fault bound` };
  }
  const left = stopHostDeadlineAt - monoNow();
  if (left >= STOP_RECEIPT_RESERVE_MS) return null;
  const ms = Math.max(0, Math.round(left));
  return left >= STOP_RECEIPT_MINIMAL_RESERVE_MS
    ? { code: "low-time-budget", minimal: true, why: `${ms} ms remain before the host's kill, under the receipt's ${STOP_RECEIPT_RESERVE_MS} ms reserve` }
    : { code: "low-time-budget", minimal: false, why: `${ms} ms remain before the host's kill, under even the minimal skip row's ${STOP_RECEIPT_MINIMAL_RESERVE_MS} ms reserve` };
}

/**
 * The queue at the attempt (finish() calls this for a Stop only), as a TOKEN the row consumes:
 * {skip} when this Stop takes no receipt; else {queue, ownGitScope}. Opens an event-git scope on
 * this thread (lib/event-git.js — one answer per distinct git question for the rest of this
 * event) unless one is already open, so the receipt's repeated questions share one spawn.
 * Never throws.
 */
function stopQueueAtAttempt() {
  const skip = stopReceiptSkipReason();
  if (skip) return { skip, queue: null, ownGitScope: false };
  const token = { skip: null, queue: null, ownGitScope: false };
  try {
    const EG = require(path.join(HOOKS_DIR, "lib", "event-git.js"));
    if (!EG.eventGitStats().scopeOpen) {
      EG.beginEventGit();
      token.ownGitScope = true;
    }
  } catch {}
  try {
    token.queue = require(path.join(HOOKS_DIR, "lib", "stop-receipt.js")).queueAtAttempt(hostPayload);
  } catch {}
  return token;
}

/**
 * Append the receipt for THIS Stop attempt. Called from finish() only, after the stdout
 * handoff and the findings ACK. Measurement only: it cannot change the reply or the exit
 * code, and any failure — or a skip — is one stderr line written synchronously (end() exits
 * next). The row lands in THIS dispatcher's repo (`.claude/hooks/../..`), never the payload
 * cwd's; the queue (read at the attempt) and the handover cycle stay keyed on the payload cwd.
 */
function stopAttemptReceipt(token, outcome) {
  const t = token && typeof token === "object" ? token : { skip: null, queue: null, ownGitScope: false };
  try {
    // The row-time verdict wins: time only runs down, so it is never looser than the attempt's.
    const skip = stopReceiptSkipReason() || t.skip;
    if (skip) {
      // A minimal skip row keeps the skipped attempt COUNTABLE (stop-receipt.js --rate reports it
      // as skipped_attempts, never pending or not-pending). It does no queue read and no cycle
      // locate; it goes through the SAME contained, writer-anchored append as a full receipt.
      if (skip.minimal) {
        const SR = require(path.join(HOOKS_DIR, "lib", "stop-receipt.js"));
        const w = SR.recordSkippedAttempt({ runtime: "claude", sinkRoot: STOP_SINK_ROOT, attemptedAtMs, skipped: skip.code });
        if (w && w.ok) require("fs").writeSync(2, `[stop-receipt] receipt skipped (${skip.why}) — a minimal skip row was recorded; measurement only; this Stop is unaffected\n`);
        return;
      }
      require("fs").writeSync(2, `[stop-receipt] receipt skipped (${skip.why}) — measurement only; this Stop is unaffected\n`);
      return;
    }
    const SR = require(path.join(HOOKS_DIR, "lib", "stop-receipt.js"));
    const p = hostPayload && typeof hostPayload === "object" ? hostPayload : null;
    const repoDir = (p && typeof p.cwd === "string" && path.isAbsolute(p.cwd) && p.cwd) || process.env.CLAUDE_PROJECT_DIR || path.resolve(HOOKS_DIR, "..", "..");
    SR.recordStopAttempt({
      runtime: "claude",
      sinkRoot: STOP_SINK_ROOT,
      repoDir,
      payload: p,
      attemptedAtMs,
      dispatcher: {
        name: "dispatch-main.js",
        body_sha256: SR.fileSha256(__filename),
        registry_sha256: registrySha256,
        registry_source: "the resolved (pinned or on-disk) registry text this dispatch parsed",
      },
      queue: t.queue,
      commit: stopCommit,
      stdoutHandoff: outcome.stdoutHandoff,
      ack: outcome.ack,
      ackReceipts: outcome.ackReceipts,
      exitCode: Number(outcome.exitCode) | 0,
      configDir: process.env.CLAUDE_CONFIG_DIR,
      pid: process.ppid,
    });
  } catch (e) {
    // The message may carry an absolute path (a `Cannot find module '<path>'`): route it through
    // the module's sanitizer, and when the module itself is what failed to load, say so with the
    // error's code alone — never the raw message.
    let why;
    try {
      why = require(path.join(HOOKS_DIR, "lib", "stop-receipt.js")).sanitizeReason((e && e.message) || String(e));
    } catch {
      why = `the receipt module could not be loaded${e && typeof e.code === "string" ? ` (${e.code})` : ""}`;
    }
    try {
      require("fs").writeSync(2, `[stop-receipt] receipt NOT recorded (${why || "unknown"}) — measurement only; this Stop is unaffected\n`);
    } catch {}
  } finally {
    if (t.ownGitScope) {
      try {
        require(path.join(HOOKS_DIR, "lib", "event-git.js")).endEventGit();
      } catch {}
    }
  }
}

/**
 * The ONLY calls let through while a registry is unreadable: read-only lookups,
 * an Edit/Write/NotebookEdit whose target resolves to the broken registry itself, and
 * an exact `git checkout -- <file>` / `git restore [--source=HEAD] <file>` of it.
 * The Edit/Write half is admitted for a REGISTRY only (`edit: true`): the loom
 * registry is content-pinned by hash, and the repo's local one only ever switches
 * the repo's own detectors. The bootstrap's hatch for a broken dispatcher BODY
 * admits no write at all (round-7 SEC MEDIUM-1).
 *
 * ONE implementation, in the bootstrap (`dispatch.js::repairHatch`): the bootstrap
 * must be able to answer with it when THIS file is the broken one, and a second copy
 * here would drift from it. A bootstrap that cannot be read back admits nothing
 * (fail closed).
 */
function repairHatch(payload, file, readOnly = true) {
  try {
    // `file === null`: a fault that names no broken FILE (the input bound —
    // `stdinBoundFaultReply`) still gets the hatch's read-only half — but only for a
    // lookup no deny row for it is registered at the event (`readOnly`, decided by
    // readOnlyHatchOpen). Loom's own registry registers one for each of Read, Grep and
    // Glob, so in loom that half is ALWAYS closed and nothing is admitted. The list
    // is empty either way: no Edit and no restore command is admitted by it.
    return require(path.join(HOOKS_DIR, "dispatch.js")).repairHatch(payload, file === null ? [] : [file], { edit: true, readOnly }) === true;
  } catch {
    return false;
  }
}

/**
 * The ONE shared delivery-instruction block (`instruct-and-wait.js::DELIVERY_INSTRUCTION`)
 * — composed into every refusal reason THIS file renders, never a hand-rolled copy
 * (R2 L2: the constant is the channel a report is owed on, and a divergent copy is
 * exactly the drift one shared source exists to stop). Loaded LAZILY: a fault path
 * must not be made to throw by the require (the first refusal is the first time it
 * is needed), and a failed load returns "" — the refusal still refuses.
 */
let deliveryInstructionCache;
function deliveryInstruction() {
  if (deliveryInstructionCache === undefined) {
    try {
      const v = require(path.join(HOOKS_DIR, "lib", "instruct-and-wait.js")).DELIVERY_INSTRUCTION;
      deliveryInstructionCache = typeof v === "string" ? v : "";
    } catch {
      deliveryInstructionCache = "";
    }
  }
  return deliveryInstructionCache;
}

const GRACE_MS = 750;
// The longest REPO-OWNED matcher this thread decides itself (a plain list, split
// once per distinct string). Longer ones go to the supervisor with the regex ones:
// a realistic list matcher is a few tool names (loom's longest is 24 characters),
// so this changes where a matcher is decided, never whether it matches.
const MAX_DISPATCHER_MATCHER_CHARS = 1024;

// ---------------------------------------------------------------------------
// Repo-owned detectors, OUTSIDE this process tree (lib/local-supervisor.js)
// ---------------------------------------------------------------------------

const SUPERVISOR_FILE = path.join(HOOKS_DIR, "lib", "local-supervisor.js");
// Past the SUPERVISOR's own deadline (which it anchors at its receipt, so this side
// must anchor here too — see `anchorAt` in runLocalSupervised) it has already killed
// its running detector and written its last frames; this much later it is presumed
// dead or stuck.
const SUPERVISOR_BACKSTOP_MS = 500;
const SUPERVISOR_STATUSES = new Set(["exit", "timeout", "crash", "skipped"]);
// The launcher: backgrounds the supervisor with fd 1/2/3 inherited and EXITS, so
// the supervisor is re-parented away from this process (to init/launchd or the
// nearest subreaper) and stays in the launcher's session/process group, which
// `detached` made a new one. Its input rides fd 3 — an asynchronous list's fd 0 is
// /dev/null in a non-interactive shell, and fd 3 is closed by the supervisor
// before any detector starts.
const LAUNCHER_SHELL = '"$0" "$1" 3<&3 &';

// The longest frame line accepted, in UTF-16 code units, checked BEFORE a chunk is
// appended — well below V8's string limit (buffer.constants.MAX_STRING_LENGTH,
// ~2^29), where `buf += chunk` would THROW instead of faulting. What is counted is
// the decoded line's `.length` — UTF-16 code units, NOT bytes. The supervisor caps
// each detector stream at 64 MiB of BYTES (lib/local-supervisor.js MAX_CAPTURE) and
// a done frame carries both streams JSON-escaped: a byte costs at most 1 unit
// unescaped, 2 as `"` `\` or a newline/tab/CR (escaped ×2), 6 as any other control
// character (`\u00XX`, ×6). So a legitimate done frame can exceed the cap — e.g.
// ~43 MiB of such control characters in one stream, or BOTH streams at their
// 64 MiB cap of newlines or quotes (2 × 64 Mi × 2 = 256 Mi plus the frame's own
// fields). Past the cap the call is refused as a protocol fault, never lost
// (fail-closed); only the size at which that happens is bounded here. The env var
// can only LOWER it (tests).
const MAX_FRAME_CHARS_DEFAULT = 256 * 1024 * 1024;
const MAX_FRAME_CHARS = Math.min(MAX_FRAME_CHARS_DEFAULT, Number(process.env.COC_DISPATCH_MAX_FRAME_CHARS) > 0 ? Number(process.env.COC_DISPATCH_MAX_FRAME_CHARS) : Infinity);

/**
 * Run the repo-owned detectors under the supervisor and read back one outcome per
 * detector. Resolves `{outcomes, plan}` — or `{outcomes, plan, fault}` when the
 * supervisor could not start, died, overran the event, or broke the protocol:
 * `outcomes` then holds only what it had fully reported, and the caller treats the
 * fault like an unreadable local registry (refused at PreToolUse, loud elsewhere) —
 * never as "the repo's detectors had nothing to say".
 *
 * `job` is either `{entries}` — the detectors to run, already selected here — or
 * `{select: {event, value, rows}}` — the event's repo-owned rows, some of whose
 * matchers were left undecided (`rows[i].match === null`: a regular expression, or a
 * list longer than MAX_DISPATCHER_MATCHER_CHARS). Those are evaluated INSIDE the
 * supervisor, never on this thread: a catastrophic-backtracking repo regex run here
 * would stall the dispatcher past the host's kill, and every verdict loom's guards
 * reached would be lost. The supervisor answers with one `match` frame (the full
 * vector; a row decided here must come back unchanged), and BOTH sides derive the
 * detectors to run from it with the same lib/dispatch-registry.js::planLocalRows —
 * `plan` is that derivation (null until the match frame arrived). A supervisor
 * stuck in a repo regex is bounded like any other: the backstop kills its group and
 * the event gets a fault.
 *
 * The frames are accepted only in the one order the supervisor produces them
 * (hello → [match] → per index: start → done, or a lone skipped done → end), each
 * carrying this event's nonce, and each outcome is NAMED here from the entries,
 * never from the frame. Anything else is a fault.
 *
 * TWO DEADLINES, ONE ANCHOR. `deadlineAt` is THIS side's event deadline, the same
 * instant loom's detectors were run against. The supervisor's deadline is NOT that
 * one: it is `receivedAt + budgetMs` on its own clock, where the budget is what
 * remained here when the input was written — i.e. the event deadline PLUS whatever
 * that process spent booting before it read the input (`lib/local-supervisor.js`,
 * PROTOCOL). A backstop measured from `deadlineAt` therefore races a deadline that
 * has already moved later by the boot latency, and kills a supervisor that is still
 * inside its own: a reported fault with no repo detector at fault. The backstop is
 * measured from this side's observation of that receipt instead (the first `start`
 * frame), and capped by `hostDeadlineAt` — REQUIRED, the instant the HOST kills this
 * process — so a boot latency can lengthen the wait only into the reply reserve the
 * host left, never past the kill. An omitted `hostDeadlineAt` is NaN, not a silent
 * default: the backstop fires at once and every local run faults, loudly.
 */
function runLocalSupervised(job, raw, deadlineAt /* monotonic: monoNow() */, hostDeadlineAt /* monotonic: monoNow() */) {
  const { spawn } = require("child_process");
  // The directory every detector of this job is spawned in: the SESSION's (the payload's
  // cwd), or null for "this process's own cwd". See the note in `input()`.
  const localCwd = job && typeof job.cwd === "string" && job.cwd ? job.cwd : null;
  return new Promise((resolve) => {
    const nonce = require("crypto").randomBytes(24).toString("hex");
    const select = job.select || null;
    let entries = select ? null : job.entries; // select mode: known at the match frame
    let plan = null;
    const outcomes = [];
    let settled = false;
    let ended = false; // the end frame was accepted
    let running = null; // pgid of the detector the supervisor declared started
    let launcher = null;
    // Whether the pool child ever LAUNCHED. A fault then separates two dispositions the
    // dispatcher must not conflate: a pool that never started is a LOCAL-REGISTRY fault
    // whose refusal carries the repair hatch (the registry is a repo-owned file the agent
    // may need to Read to repair), while a pool that RAN and left rows unreported owes
    // those rows the per-row incomplete contract.
    let launched = false;
    let buf = "";
    let errText = "";
    let expect = "hello";
    // The backstop's anchor: monotonic ms of the FIRST `start` frame, i.e. this
    // side's observation of the supervisor's receipt (`receivedAt`, the instant its
    // own deadline is anchored at) — null until that frame arrives.
    let anchorAt = null;
    // The budget actually handed over in `input()`, i.e. what the supervisor anchored
    // at that receipt. Captured once, at the write: the same number on both sides is
    // what makes `anchorAt + writtenBudgetMs` the supervisor's own deadline.
    let writtenBudgetMs = null;
    let backstop = null;
    const killGroup = (pgid) => {
      if (!pgid || process.platform === "win32") return;
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {}
    };
    const release = () => {
      clearTimeout(backstop);
      if (!launcher) return;
      for (const s of launcher.stdio) {
        try {
          if (s) s.destroy();
        } catch {}
      }
    };
    const fault = (why) => {
      if (settled) return;
      settled = true;
      // The supervisor's group (the launcher's pgid) and the detector it was
      // running (its own group) are ended — nothing it started outlives the event.
      if (launcher) {
        if (process.platform === "win32") {
          try {
            launcher.kill();
          } catch {}
        } else killGroup(launcher.pid);
      }
      killGroup(running);
      release();
      const tail = errText.trim() ? `: ${errText.trim().slice(0, 400)}` : "";
      const lost = entries
        ? `repo-owned detectors after ${outcomes.length} of ${entries.length} did NOT report`
        : "no repo-owned detector ran (their regex matchers were not decided)";
      resolve({ outcomes, plan, launched, fault: new Error(`the supervisor running this repo's own detectors ${why}${tail} — ${lost}`) });
    };
    // One anchor, the supervisor's own: its receipt, plus the budget it anchored
    // there, is the deadline it is working to — so the backstop is always
    // SUPERVISOR_BACKSTOP_MS past THAT deadline and the boot latency between the two
    // processes is charged to neither. Measured from the event deadline instead (what
    // this was), the backstop sits the boot latency EARLY: past ~500 ms of boot it
    // kills a supervisor still inside its own budget and reports a fault naming no
    // detector. Capped by the host's kill — beyond it there is no process left to
    // answer from, so waiting longer would trade a reported fault for no reply at all.
    const armBackstop = () => {
      clearTimeout(backstop);
      const at = (anchorAt === null ? deadlineAt : anchorAt + writtenBudgetMs) + SUPERVISOR_BACKSTOP_MS;
      backstop = setTimeout(
        () => fault(expect === "match" ? "did not finish evaluating this repo's regex matchers inside the event budget" : "did not finish inside the event budget"),
        Math.max(1, Math.min(at, hostDeadlineAt) - monoNow()),
      );
    };
    // Until a `start` frame arrives the anchor is the event deadline, unchanged: a
    // supervisor that never reports one — stuck deciding a repo regex, or dead before
    // its first detector — is bounded exactly as before. The anchor is taken ONCE:
    // re-taking it per detector would let a supervisor that keeps starting detectors
    // outrun the backstop forever, and the instant being mirrored (`receivedAt`) is
    // a single one, not one per detector.
    armBackstop();

    const onLine = (line) => {
      let f;
      try {
        f = JSON.parse(line);
      } catch {
        return fault("wrote a frame that is not JSON (protocol violation)");
      }
      if (!f || typeof f !== "object" || f.n !== nonce) return fault("wrote a frame without this event's nonce (protocol violation)");
      const i = outcomes.length; // the only index a frame may speak for
      if (expect === "hello") {
        if (f.t !== "hello") return fault(`opened with ${JSON.stringify(f.t)}, not hello (protocol violation)`);
        // THE POOL IS RUNNING. `hello` is the supervisor's own first frame, so this — not
        // the launcher's spawn — is the fact the two fault dispositions turn on: a missing
        // or unreadable supervisor file still lets the SHELL start, and only the frame
        // tells apart "the pool never ran" (a local-registry fault, hatch intact) from
        // "the pool ran and left rows unreported" (the per-row incomplete contract).
        launched = true;
        expect = select ? "match" : "next";
        return undefined;
      }
      if (expect === "match") {
        const rows = select.rows;
        if (f.t !== "match" || !Array.isArray(f.m) || f.m.length !== rows.length || !f.m.every((b) => typeof b === "boolean")) {
          return fault(`sent ${JSON.stringify(f.t)} where the matcher vector was due (protocol violation)`);
        }
        // A row this process already decided comes back unchanged, or the stream is a lie.
        if (rows.some((r, k) => r.match !== null && f.m[k] !== r.match)) return fault("changed a matcher decision the dispatcher had made (protocol violation)");
        plan = require(path.join(HOOKS_DIR, "lib", "dispatch-registry.js")).planLocalRows(rows, f.m);
        entries = plan.run.map((k) => rows[k]);
        expect = "next";
        return undefined;
      }
      if (expect === "next") {
        if (f.t === "end") {
          if (i !== entries.length) return fault(`ended after ${i} of ${entries.length} detectors (protocol violation)`);
          ended = true;
          expect = "eof";
          return undefined;
        }
        if (f.t === "start" && f.i === i && i < entries.length && Number.isInteger(f.pgid) && f.pgid > 1) {
          running = f.pgid;
          expect = "done";
          // The supervisor's receipt, observed from here: from this frame on, the
          // backstop is measured on ITS deadline rather than on the event deadline
          // it has already outrun by however long it spent booting.
          if (anchorAt === null) {
            anchorAt = monoNow();
            armBackstop();
          }
          return undefined;
        }
        if (f.t === "done" && f.i === i && i < entries.length && f.status === "skipped") return accept(f);
        return fault(`sent ${JSON.stringify(f.t)} for index ${JSON.stringify(f.i)} where detector ${i} was due (protocol violation)`);
      }
      if (expect === "done") {
        if (f.t !== "done" || f.i !== i) return fault(`sent ${JSON.stringify(f.t)} for index ${JSON.stringify(f.i)} while detector ${i} was running (protocol violation)`);
        return accept(f);
      }
      return fault("wrote past its end frame (protocol violation)");
    };
    const accept = (f) => {
      if (!SUPERVISOR_STATUSES.has(f.status)) return fault(`reported status ${JSON.stringify(f.status)} (protocol violation)`);
      if (!(f.exitCode === null || Number.isInteger(f.exitCode)) || typeof f.stdout !== "string" || typeof f.stderr !== "string") {
        return fault("reported a malformed outcome (protocol violation)");
      }
      // `cut` (optional): a timeout the EVENT DEADLINE imposed — the detector's own
      // timeout had not expired. Read only on a timeout; any other type is a lie.
      if (f.cut !== undefined && typeof f.cut !== "boolean") return fault("reported a malformed outcome (protocol violation)");
      const quiet = f.status === "timeout" || f.status === "skipped";
      const e = entries[outcomes.length];
      outcomes.push({
        hook: e.hook, // named here, never by the frame
        status: f.status,
        exitCode: quiet ? null : f.exitCode,
        // A killed detector contributes nothing, as a host-killed hook did.
        stdout: f.status === "timeout" ? "" : f.stdout,
        stderr: f.status === "timeout" ? "" : f.stderr,
        deadlineCut: f.status === "timeout" && f.cut === true,
        budgetMs: e.timeoutMs,
      });
      running = null;
      expect = "next";
      return undefined;
    };

    try {
      // THE POOL RUNS IN THE SESSION'S DIRECTORY, not the dispatcher's: a legacy row that
      // resolves git (or reads a relative path) from its cwd must see what its standalone
      // launch saw. MEASURED as a fail-open otherwise — three kailash-py guards DENY
      // standalone in a non-git cwd and ALLOWED under a dispatcher-rooted pool.
      const childEnv = { ...process.env };
      delete childEnv.COC_STOP_CANDIDATE_ID;
      const opts = { stdio: ["ignore", "pipe", "pipe", "pipe"], cwd: localCwd || process.cwd(), env: childEnv, windowsHide: true };
      launcher =
        process.platform === "win32"
          ? spawn(process.execPath, [SUPERVISOR_FILE], opts)
          : spawn("/bin/sh", ["-c", LAUNCHER_SHELL, process.execPath, SUPERVISOR_FILE], { ...opts, detached: true });
    } catch (e) {
      return fault(`could not be started (${e && e.message ? e.message : e})`);
    }
    // NOT here: a successful SHELL spawn is not the pool running — a missing or
    // unreadable supervisor file still starts the launcher, which then fails. The flag is
    // set on the pool's own `hello` frame (see the frame handler).
    launcher.on("error", (e) => fault(`could not be started (${e && e.message ? e.message : e})`));
    launcher.stdio[3].on("error", () => {});
    // A stream 'error' with no listener is thrown on this thread — the whole event
    // would be lost (round-3 L1). Either channel failing is a supervisor fault.
    launcher.stdout.on("error", (e) => fault(`channel failed (${e && e.message ? e.message : e})`));
    launcher.stderr.on("error", (e) => fault(`stderr channel failed (${e && e.message ? e.message : e})`));
    // Decoded as a STREAM: a pipe chunk can end inside a multi-byte UTF-8 character,
    // and a per-chunk String(c) turns each half into U+FFFD — a detector's non-ASCII
    // reason or context would reach the host corrupted.
    launcher.stdout.setEncoding("utf8");
    launcher.stderr.setEncoding("utf8");
    launcher.stderr.on("data", (c) => {
      if (errText.length < 4096) errText += String(c);
    });
    launcher.stdout.on("data", (c) => {
      if (settled) return;
      const chunk = String(c);
      // Line by line, each segment's length checked BEFORE it is appended: past
      // V8's string limit the append itself would throw (into the fatal path) instead
      // of faulting. Only the pending (unterminated) line is ever held.
      let from = 0;
      while (!settled) {
        const nl = chunk.indexOf("\n", from);
        const seg = nl === -1 ? chunk.slice(from) : chunk.slice(from, nl);
        if (buf.length + seg.length > MAX_FRAME_CHARS) return fault(`wrote a frame longer than ${MAX_FRAME_CHARS} characters (protocol violation)`);
        buf += seg;
        if (nl === -1) break;
        const line = buf;
        buf = "";
        onLine(line);
        from = nl + 1;
      }
    });
    launcher.stdout.on("close", () => {
      if (settled) return;
      if (!ended || buf.length) return fault(ended ? "wrote past its end frame (protocol violation)" : "ended before reporting every detector");
      settled = true;
      release();
      resolve({ outcomes, plan });
    });
    // `mode` and `onIncomplete` travel with every row the pool is asked to run: the pool
    // decides in-process (`mode:"legacy"`, in a worker of ITS OWN process) vs
    // standalone-process from `mode`, and a deny-class row must be markable when the pool
    // dies. h8-fixup flagged the earlier drop of these two fields on this path.
    const slim = (e) => ({ hook: e.hook, file: e.file, timeoutMs: e.timeoutMs, mode: e.mode, onIncomplete: e.onIncomplete });
    // Undecided matchers travel ONCE each (`matchers`, indexed by a row's `mi`): a
    // group matcher is copied onto every row of its group, and a per-row copy would
    // multiply the input by the row count on this thread.
    let selectInput = null;
    if (select) {
      const matchers = [];
      const at = new Map();
      const rows = select.rows.map((r) => {
        let mi = -1;
        if (r.match === null) {
          if (!at.has(r.matcher)) {
            at.set(r.matcher, matchers.length);
            matchers.push(r.matcher);
          }
          mi = at.get(r.matcher);
        }
        return { ...slim(r), mi, match: r.match, exists: r.exists, loomRuns: r.loomRuns };
      });
      selectInput = { event: select.event, value: select.value, matchers, rows };
    }
    // The supervisor is ANOTHER process, whose monotonic clock has a different
    // origin, so no instant on either clock means anything to the other. What
    // crosses is the REMAINING monotonic budget, RELATIVE, taken the moment the
    // input is written (lib/local-supervisor.js `budgetMs`); the supervisor anchors
    // it to its own performance.now() on receipt. No wall clock is read on either
    // side, so a wall-clock step anywhere in the run cannot cut a repo detector.
    // The budget is written before that process has finished booting, so the
    // deadline it lands on is `deadlineAt` + that boot latency, never `deadlineAt`:
    // nothing here may assume the two coincide — the backstop above is anchored on
    // the side's own reading of the receipt for exactly this reason.
    const input = () => {
      // Captured as it is written: the supervisor anchors ITS deadline at this value
      // on receipt, and the backstop above is measured from the same pair.
      writtenBudgetMs = Math.max(0, deadlineAt - monoNow());
      return JSON.stringify({
        nonce,
        dispatcherPid: process.pid,
        budgetMs: writtenBudgetMs,
        // THE ROW'S SCOPE, handed to the supervisor so ITS spawn carries it: a detector
        // that resolves git (or reads a relative path) from its cwd must see the SESSION's
        // directory, which is the payload's cwd — never this process's. Null/absent when
        // the payload names none, which leaves the supervisor inheriting this process's
        // cwd, exactly as a host launch with no cwd change would.
        ...(localCwd ? { cwd: localCwd } : {}),
        ...(select ? { select: selectInput } : { detectors: entries.map(slim) }),
        raw,
      });
    };
    if (process.platform === "win32") return launcher.stdio[3].end(input());
    // Written only once the launcher has EXITED: by then the kernel has re-parented
    // the supervisor, and it runs nothing before this input arrives.
    launcher.on("exit", (code, signal) => {
      if (code !== 0) return fault(`launcher failed (exit ${code === null ? signal : code})`);
      launcher.stdio[3].end(input());
    });
  });
}

// The host's parsed payload, once read — for the fatal handler outside main().
let hostPayload = null;
// The per-Stop candidate id this dispatch minted (main); null for every other event.
let stopCandidateId = null;
// The outcomes this event has produced so far (loom's, then any repo-owned ones —
// the SAME array main() merges) and the engine that judges them. Read by the two
// replies built OUTSIDE main()'s normal return — the watchdog and the fatal
// handler — so a verdict already reached is never dropped by them (lateFaultReply).
let reached = [];
let reachedEngine = null;

// `file` is relative to .claude/, and null for a fault that names no broken FILE
// (the input bound — see `kind` "stdin-bound"). `kind` — null: a registry fault
// (`file` names which registry); "fatal": dispatch.js itself threw after it
// started dispatching; "stall": dispatch.js did not finish inside its budget (the
// watchdog); "stdin-bound": the dispatcher could NOT READ this call's payload
// inside its input budget (guard-foundation A9 — the buffer is discarded, never
// dispatched, because a truncated read is not the call). For the last three the
// hatch is the loom registry's; for "stdin-bound" it is the read-only half of it (an
// empty file list), since no file is implicated. On every one of these loom-side
// faults the read-only half admits Read/Grep/Glob ONLY where no deny row for that
// tool is registered at the event (readOnlyHatchOpen, S-C F1) — and loom's own
// registry carries a PreToolUse deny row for each of the three (Read:
// detect-violations, session-notes-guard, probe-phase-guard; Grep and Glob:
// probe-phase-guard), so in loom the read-only half is ALWAYS closed and those
// faults admit no lookup; only a registry with no such row (a consumer's, a
// suite's toy tree) keeps a lookup open. "unparseable": no input bound fired (EOF, a stream error, or no
// stdin at all) but what arrived is not a JSON object — empty, cut short, or another
// JSON value — or is an object that names no tool (no non-empty tool_name), so no
// guard can vet it (GF-UNPARSEABLE); it takes the same read-only hatch half as
// "stdin-bound", which admits nothing here because no tool can be read from it.
// `opts.hatch: false` refuses even a call the hatch would admit.
function registryFaultReply(err, payload, file = "hooks/dispatch-registry.json", kind = null, opts = {}) {
  const why = err && err.message ? err.message : err;
  const dispatcherFault = kind === "fatal" || kind === "stall";
  const starved = kind === "starved";
  const stdinBound = kind === "stdin-bound";
  const unparseable = kind === "unparseable";
  const msg =
    unparseable
      ? `dispatch.js could not read a tool call from this payload (${why}). ` +
        `No detector ran on this call — no call could be read from it.`
      : stdinBound
      ? `dispatch.js could not read this call's payload inside its input budget (${why}). ` +
        `No detector ran on this call — it was never handed the call.`
      : starved
      ? `dispatch.js ran out of the time budget for ${event} before ` +
        // A repo-owned starvation must NAME the repo's registry: the repair is often an
        // edit of that file (drop or fix the row that overran), and an agent that is not
        // told which file cannot act on the refusal.
        (file === "hooks/dispatch-registry.json"
          ? "loom's own detectors"
          : `this repo's own detectors — see .claude/${file}`) +
        ` could finish (${why}). A guard that could not run has not passed.`
      : kind === "fatal"
      ? `dispatch.js failed while dispatching ${event} — a fault in the dispatcher itself, not in a registry (${why}). ` +
        `Every verdict the detectors registered for ${event} reached on this call is lost unless it is repeated below.`
      : kind === "stall"
      ? `dispatch.js did not finish dispatching ${event} inside its time budget (${why}). ` +
        `Every verdict the detectors registered for ${event} reached on this call is lost unless it is repeated below.`
      : file === "hooks/dispatch-registry.json"
      ? `dispatch.js could not initialize — .claude/hooks/dispatch-registry.json or the engine (${why}). ` +
        `Every detector registered for ${event} is behind that file.`
      : `dispatch.js could not read this repo's own detector registry .claude/${file} (${why}). ` +
        `Every repo-owned detector for ${event} is behind that file; loom's detectors DID run.`;
  // The repair hatch applies to a local-registry fault of EITHER kind — the file
  // unreadable, or a supervisor RUNTIME fault (it could not start, died, stalled —
  // e.g. in a repo regex matcher — or broke protocol) — deliberately (L3, round 2):
  //   - the repair of a runtime fault is often an edit of the local registry itself
  //     (drop or fix the row whose detector or matcher breaks the supervisor), and
  //     the host requires a Read of a file before an Edit of it, so the Edit hatch
  //     alone would be unusable without the read-only one;
  //   - loom's own detectors DID run on the admitted call (a restrictive loom
  //     verdict still wins over the hatch — the local fault is merged beside it);
  //     only the repo's OWN detectors are skipped, and the repo can already switch
  //     those off by editing its own registry, so the hatch grants no capability
  //     the repo does not hold against itself;
  //   - the exposure is exactly that of an unreadable local registry, which has
  //     always had this hatch.
  // S-C F1 (ruling 9a): on a loom-side fault — the input bound, an unreadable payload,
  // loom's own registry, the dispatcher's stall or throw — the read-only half admits a
  // lookup only when NO deny row for that tool is REGISTERED at the event
  // (readOnlyHatchOpen). Registered, not merely unrun: a stall or a throw can land
  // after some rows already ran and allowed, and those count too — the stricter rule,
  // kept deliberately (engine-w1 R1 LOW-6). A REPO-registry fault keeps it: loom's own
  // guards DID run on that call (see the note above), so the lookup was vetted.
  const loomSide = file === null || file === "hooks/dispatch-registry.json";
  const narrow = Object.prototype.hasOwnProperty.call(opts, "narrow") ? opts.narrow : isPlainObject(payload) ? payload : null;
  const callTool = isPlainObject(payload) && typeof payload.tool_name === "string" ? payload.tool_name : null;
  const openReadOnly = event === "PreToolUse" && loomSide
    ? READ_ONLY_TOOLS.filter((t) => readOnlyHatchOpen(narrow === null ? null : { tool_name: t }, t))
    : READ_ONLY_TOOLS;
  const readOnlyAllowed =
    openReadOnly.length === READ_ONLY_TOOLS.length
      ? "Read/Grep/Glob are still allowed"
      : openReadOnly.length
        ? `${openReadOnly.join("/")} ${openReadOnly.length === 1 ? "is" : "are"} still allowed; ${READ_ONLY_TOOLS.filter((t) => !openReadOnly.includes(t)).join("/")} NOT, because a guard that can refuse them did not run`
        : "Read/Grep/Glob are NOT allowed either: a guard that can refuse them is registered at this event and did not run (or which guards are registered is unknown)";
  if (event === "PreToolUse") {
    if (opts.hatch === false || !repairHatch(payload, file, !loomSide || openReadOnly.includes(callTool))) {
      const allowed =
        unparseable
          ? "Nothing can be admitted from THIS payload, a Read included, because no tool can be read from it; a later " +
            "Read/Grep/Glob whose payload arrives readable is dispatched normally. No FILE is implicated, so no restore command is provided.\n"
          : stdinBound
          ? `${readOnlyAllowed} (unless a guard had already refused the call before the fault). ` +
            "No FILE is implicated by this fault, so no restore command is provided.\n"
          : loomSide
          ? `${readOnlyAllowed}. An Edit/Write of .claude/${file}, and an exact \`git checkout -- .claude/${file}\` / \`git restore\` of it are still allowed ` +
            "(unless a guard had already refused the call before the fault).\n"
          : `Read/Grep/Glob, an Edit/Write of .claude/${file}, and an exact \`git checkout -- .claude/${file}\` / \`git restore\` of it are still allowed ` +
            "(unless a guard had already refused the call before the fault).\n";
      const reportBlock =
        unparseable
          ? "  - Quote the reason above: the host handed this hook a payload from which no tool call can be read.\n" +
            "  - The payload is written by the host, not by this session, so there is no file to restore. A payload cut short " +
            "once may read whole on a RETRY; an unreadable payload on every call is a report to the user (and to the maintainers " +
            "of whatever writes this hook's stdin). " +
            allowed
          : stdinBound
          ? "  - Quote the reason above: the call's payload did not arrive inside the dispatcher's input budget.\n" +
            "  - The budget is 2 s / 4 MiB of input — the same one the Codex native runtime applies to its own stdin. A deadline that " +
            "fired once may pass on a RETRY. A payload over the 4 MiB size limit is refused the same way on EVERY retry: the call itself must be " +
            "made smaller (e.g. one large Write split into several). A deadline on every call means the producer of this hook's stdin " +
            "is not closing it, which is a report to the user (and to the maintainers of whatever wrote it), not a file to restore. " +
            allowed
          : starved
          ? "  - Quote the detectors named above: the event's time budget ran out before they could run or finish.\n" +
            "  - Usually a detector AHEAD of them used most of the budget (look for its timeout note), or the machine is " +
            `overloaded. The budget is \`dispatcher.timeout\` for ${event} in .claude/hooks/dispatch-registry.json. Retrying may pass. ` +
            allowed
          : dispatcherFault
          ? "  - The hook dispatcher itself failed (the registry is NOT the cause); quote the error above.\n" +
            "  - The fault is in .claude/hooks/dispatch.js or a library under .claude/hooks/lib/ (the error above names where; a stall " +
            "can also be a detector that blocked the dispatcher's thread). If a local change to those files caused it, the user " +
            "restores them (e.g. `git checkout -- .claude/hooks/`); otherwise report the error to the maintainers. " +
            allowed
          : `  - The hook registry is unreadable; quote the error above.\n  - Repair it: restore .claude/${file} (e.g. \`git checkout -- .claude/${file}\`). ` +
            allowed;
      // The report's DELIVERY half is the ONE shared constant, composed the same
      // way `instruct-and-wait.js` composes it after its own report block (R2 L2) —
      // a refusal whose report has no stated channel is the defect that constant
      // exists to close.
      const delivery = deliveryInstruction();
      const reason =
        "STOP — Tool call blocked.\n\nWHAT HAPPENED: " + msg +
        "\nWHY: " +
        (unparseable
          ? "no guard can vet a call it cannot read, and an unreadable payload ALLOWED would let any call through unchecked. "
          : stdinBound
          ? "the dispatcher was never handed this call's payload, so no guard ran and the call cannot be vetted. "
          : starved
          ? "loom's guards did not all run on this call, so it cannot be vetted. "
          : dispatcherFault
          ? "the dispatcher failed part-way, so the guards' verdicts on this call are not all known and it cannot be vetted. "
          : file === "hooks/dispatch-registry.json"
          ? "with that registry unreadable no guard can run, so this call cannot be vetted. "
          : "this repo's own guards could not run, so this call cannot be fully vetted. ") +
        "Refusing is the fail-closed disposition.\n\n" +
        "REPORT TO USER (do not skip any):\n" +
        reportBlock +
        (delivery ? "\n" + delivery + "\n" : "");
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
        }) + "\n",
        stderr: "\n" + reason + "\n",
        exitCode: 2,
      };
    }
  }
  // Loud = a NON-JSON exit 1. The host parses stdout JSON at every status and a
  // parsed reply is a success (hook-engine.js § JSON IS READ AT EVERY EXIT CODE), so
  // a `{"continue":true}` here would make this fault invisible; with no JSON the
  // host shows the stderr to the user as a hook error. An event nobody NAMED — or a
  // name that is not EXACTLY one of the host's own event names (`pretooluse`,
  // ` PreToolUse`, a lookalike; HOST_EVENT_NAMES, a fixed set, so the answer does not
  // depend on whether the registry could be read) — may be PreToolUse, so it takes exit
  // 2: "an unknown event fails closed to the refusal" (`completion` above; S-C F4;
  // engine-w1 R1 LOW-1 + SEC LOW-2, R2-F3 + R2-SEC-3, eventIsUnknown). A real host event
  // the registry does not list is NOT unknown: it is a registry fault at a known event
  // and keeps the loud exit 1. A hatch-admitted PreToolUse call keeps its loud exit 1 —
  // the hatch decided that.
  const unknown = event !== "PreToolUse" && eventIsUnknown();
  // THE DURABLE RECORD on every fault that leaves deny rows unrun at a KNOWN
  // non-PreToolUse event (engine-w1 R2-F4 + R2-SEC-2): the loud exit 1 reaches only the
  // actor, and at PostToolUse the operation already ran — the same gap the stdin-bound
  // path's record closed (that path records for itself, with its own narrowing, so it is
  // excluded here). PreToolUse records nothing: the call is refused, or the hatch admitted
  // a call no deny row covers.
  const record = event !== "PreToolUse" && !unknown && !stdinBound ? recordRegistryFault(kind, file, narrow, opts) : null;
  return {
    stdout: "",
    stderr:
      `[dispatch] ${msg} ${dispatcherFault ? `No verdict of the detectors for ${event || "this event"} was delivered.` : `Detectors for ${event || "this event"} did NOT run.`}` +
      (unknown && event ? ` ${JSON.stringify(event)} is not one of the host's hook event names, so it fails closed to the refusal (exit 2).` : "") +
      (record && record.ok ? ` The skipped deny-capable check IS recorded: one ${UNRUN_DENY_RULE_ID} row in violations.jsonl.` : "") +
      "\n" +
      (record && !record.ok ? `${record.loud}\n` : ""),
    exitCode: unknown ? 2 : 1,
  };
}

// The reached outcomes' OWN text, for the late-fault replies that ALLOW (or only REPORT) with
// UNJUDGED verdicts (fc R-7 security L-2): the verdict is not enforced there, but it must not be
// SILENT — before this, a detector that had reached a real block vanished from the reply. The
// SAME field set hook-engine.js::restrictiveReply reads, each strictly as a plain string and
// nothing a detector supplied interpreted beyond a type check: an exit-2 stderr, else the JSON
// `reason`, else hookSpecificOutput.permissionDecisionReason, else stderr. Read HERE, never
// through the engine — the engine's own judgement is what failed. BOUNDED: each outcome's text
// to UNJUDGED_REASON_MAX characters and the whole to UNJUDGED_REASONS_MAX, every cut SAID in the
// text. Never throws: a failure yields "" and the warning stands without it.
const UNJUDGED_REASON_MAX = 2000;
const UNJUDGED_REASONS_MAX = 8000;
function unjudgedReasonsText(outs) {
  try {
    const s = (v) => (typeof v === "string" ? v : "");
    const parts = [];
    let total = 0;
    let dropped = 0;
    for (const o of Array.isArray(outs) ? outs : []) {
      if (!o || typeof o !== "object") continue;
      let j = null;
      try {
        const t = s(o.stdout).trim();
        const v = t ? JSON.parse(t) : null;
        j = v && typeof v === "object" && !Array.isArray(v) ? v : null;
      } catch {}
      const hso = j && j.hookSpecificOutput && typeof j.hookSpecificOutput === "object" ? j.hookSpecificOutput : {};
      const text = (o.exitCode === 2 && s(o.stderr).trim()) || (j && s(j.reason)) || s(hso.permissionDecisionReason) || s(o.stderr).trim();
      if (!text) continue;
      const hook = s(o.hook) || "(unnamed row)";
      const body =
        text.length > UNJUDGED_REASON_MAX
          ? `${text.slice(0, UNJUDGED_REASON_MAX)} [truncated: ${text.length - UNJUDGED_REASON_MAX} more characters of ${hook}'s text not shown — the per-outcome bound is ${UNJUDGED_REASON_MAX}]`
          : text;
      const line = `  ${hook}: ${body}`;
      if (total + line.length > UNJUDGED_REASONS_MAX) {
        dropped++;
        continue;
      }
      total += line.length;
      parts.push(line);
    }
    if (!parts.length && !dropped) return "";
    const cut = dropped ? `\n  [truncated: ${dropped} more reached outcome(s) not shown — the whole text is bounded at ${UNJUDGED_REASONS_MAX} characters]` : "";
    return `[dispatch] what the reached detectors said (NOT enforced — their verdicts could not be judged):\n${parts.join("\n")}${cut}\n`;
  } catch {
    return "";
  }
}

/**
 * The durable record for a registryFaultReply at a known non-PreToolUse event (R2-F4 +
 * R2-SEC-2), or null when the fault provably skipped no deny row. Which rows were
 * skipped, by the fault's kind:
 *   - `opts.skipped` (an engine fault, a starved event): the caller's deny-row outcomes
 *     that did not run — exact, so an empty list records nothing;
 *   - a fault in THIS REPO's registry or its supervisor: the repo's rows are unknown;
 *   - a stall or a dispatcher throw: the rows ran part-way, so which completed is unknown
 *     — recorded only when the event registers a deny row for this call at all;
 *   - loom's registry (or the engine behind it) could not initialize: unrunDenyRows says,
 *     and an unreadable registry is its unknown form.
 * NEVER throws: a fault reply must still go out.
 */
function recordRegistryFault(kind, file, narrow, opts) {
  try {
    const loomSide = file === null || file === undefined || file === "hooks/dispatch-registry.json";
    const label = opts.recordKind || (kind === null ? (loomSide ? "registry" : "local-registry") : kind);
    let unrun;
    if (Array.isArray(opts.skipped)) {
      if (!opts.skipped.length) return null;
      unrun = { rows: [...new Set(opts.skipped)], unknown: null };
    } else if (!loomSide) {
      unrun = { rows: null, unknown: "local-fault" };
    } else {
      unrun = unrunDenyRows(narrow);
      if (Array.isArray(unrun.rows) && unrun.rows.length === 0) return null;
      if ((kind === "stall" || kind === "fatal") && Array.isArray(unrun.rows)) unrun = { rows: null, unknown: "dispatcher", registered: unrun.rows };
    }
    return recordUnrunDenyRows(label, null, unrun);
  } catch (e) {
    return { ok: false, loud: `[dispatch] DURABLE RECORD FAILED — the ${UNRUN_DENY_RULE_ID} row for this fault could not be built: ${e && e.message ? e.message : String(e)}.` };
  }
}

/**
 * The reply when the dispatcher's own input read hit a bound (`readAllStdin`) —
 * guard-foundation A9, the trust-boundary half of it.
 *
 * The buffer that DID arrive is parsed for exactly the decisions below — the repair
 * hatch's (whose read-only half loom's own registry always keeps closed, see
 * registryFaultReply's note), the event when argv named none, and a Stop's
 * `stop_hook_active` flag. It is never dispatched, and this is the load-bearing half of the
 * contract: a truncated payload that happens to parse is NOT the call as the host
 * wrote it, so adjudicating it would be a verdict on a document no guard can see
 * whole. Refusing (at PreToolUse) is the fail-closed disposition, and the same one
 * the Codex native runtime takes when its own bounded read is rejected.
 *
 * The event, when argv did not name one (a bare spawn — hook-runtime-smoke, a
 * probe), is taken from that same parsed buffer, the rule main() applies to a
 * normal read. An event still unnamed, or one loom's registry does not list, fails
 * closed to the refusal exit 2 (eventIsUnknown).
 *
 * Outside PreToolUse the reply depends on what the fault left unrun
 * (unrunDenyRows): an event whose rows are all `continue` keeps the loud exit 1;
 * an event with a deny row left unrun takes the ONE per-event table
 * (incompleteDenyDisposition — refuse / report / allow-loud, stdinBoundBlock), AND
 * a DURABLE violations.jsonl row naming the skipped guards (recordUnrunDenyRows) —
 * a reply alone reaches only the actor, and at PostToolUse the operation already ran.
 */
function stdinBoundFaultReply(fault, raw) {
  const STDIN_MAX_BYTES = stdinMaxBytes(); // the bootstrap's ONE constant (stdinMaxBytes)
  const kind = fault && fault.kind === "ceiling" ? "ceiling" : "deadline";
  const bytes = fault && typeof fault.bytes === "number" ? fault.bytes : 0;
  const why =
    kind === "ceiling"
      ? `the input exceeded the ${STDIN_MAX_BYTES / (1024 * 1024)} MiB ceiling ` +
        `(${STDIN_MAX_BYTES} bytes; ${bytes} had arrived)`
      : new HookBudgetExceeded("dispatcher stdin", STDIN_READ_TIMEOUT_MS, `the input deadline expired after ${STDIN_READ_TIMEOUT_MS} ms (${bytes} bytes had arrived)`).message;
  let hatchPayload = null;
  try {
    hatchPayload = JSON.parse(raw);
  } catch {
    // Not parseable ⇒ no payload for the hatch to judge, and the refusal below is
    // the whole answer. (This is the arm a producer that sends NOTHING reaches.)
  }
  if (!event && hatchPayload && typeof hatchPayload.hook_event_name === "string") {
    event = hatchPayload.hook_event_name;
    completion.event = event;
  }
  // Narrowing by tool needs a WHOLE document the host finished writing: only a
  // deadline can leave one (a ceiling's buffer is cut at the overflowing chunk, and a
  // whole document padded past the ceiling is not a shape the host writes). The SAME
  // narrowing decides the hatch below (S-C F1) and the blocking rows after it.
  const whole = kind === "deadline" && isPlainObject(hatchPayload) ? hatchPayload : null;
  // `file` is null: no broken file is named by this fault (see the param note on
  // registryFaultReply) — the hatch's read-only half, and only where no deny row for
  // the lookup is registered at the event (readOnlyHatchOpen, S-C F1).
  const reply = registryFaultReply(new Error(why), hatchPayload, null, "stdin-bound", { narrow: whole });
  // PreToolUse is answered above (refusal, hatch aside — the hatch admits only a tool
  // no deny row covers, so no deny row is ever skipped for a call that RUNS: nothing to
  // record). An event nobody named, or a name that is not one of the host's own, took
  // the refusal exit 2 there (registryFaultReply, eventIsUnknown). A real host event the
  // registry does not list goes on: its rows are unknown, and the table decides it.
  if (!event || event === "PreToolUse" || eventIsUnknown()) return reply;
  const unrun = unrunDenyRows(whole);
  if (unrun.rows && unrun.rows.length === 0) return reply; // only non-blocking rows ⇒ the loud exit 1
  // A deny row went unrun at an event whose call is NOT refused here (or, at a Stop, may
  // end the turn on the refire): the durable record first, so the reply can say whether
  // it landed. Its failure never changes the outcome — stdinBoundBlock carries it LOUDLY
  // instead, to the model and the user as well as stderr (R2-SEC-4).
  const record = recordUnrunDenyRows(kind, fault && typeof fault.bytes === "number" ? fault.bytes : 0, unrun);
  // The Stop flag is read from ANY buffer that parsed as one whole JSON object — a
  // ceiling's included (a parse succeeds only on a complete document, trailing
  // whitespace aside). Narrowing BY TOOL stays deadline-only (`whole`): there the tool
  // name may rule a guard OUT, which a padded document must not be able to do.
  const doc = isPlainObject(hatchPayload) ? hatchPayload : null;
  return stdinBoundBlock(why, unrun, whole, doc, record, kind);
}

/**
 * THE HOST'S HOOK EVENT NAMES — a FIXED, case-sensitive set (engine-w1 R2-F3 + R2-SEC-3).
 * Every name Claude Code dispatches a hook for, as its own matchQuery switch spells them
 * (2.1.283; the switch is quoted at main()'s MATCH_FIELD), plus the events that switch
 * gives no match field (Stop, UserPromptSubmit, TeammateIdle, TaskCreated, TaskCompleted)
 * and the three it transforms first (PreModelSwitch, PostModelSwitch, FileChanged). It is
 * deliberately NOT read from the registry: whether a name is a real host event must not
 * depend on a file a fault may have left unreadable, and a real event the registry
 * happens not to list is still that event — the per-event table decides it. The Set is
 * private (a Set's members stay mutable under Object.freeze); the export is a frozen copy.
 */
const HOST_EVENT_SET = new Set([
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied",
  "UserPromptSubmit", "UserPromptExpansion", "SessionStart", "SessionEnd", "Setup",
  "Stop", "StopFailure", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
  "Notification", "Elicitation", "ElicitationResult", "ConfigChange", "DirectoryAdded",
  "InstructionsLoaded", "TeammateIdle", "TaskCreated", "TaskCompleted",
  "PreModelSwitch", "PostModelSwitch", "FileChanged",
]);
const HOST_EVENT_NAMES = Object.freeze([...HOST_EVENT_SET]);

/**
 * Is `event` UNKNOWN — named by nobody, or not EXACTLY one of the host's event names
 * (HOST_EVENT_NAMES)? (engine-w1 R1 LOW-1 + SEC LOW-2; re-based R2-F3 + R2-SEC-3.) Every
 * fault path that would otherwise answer a named event loudly (exit 1) asks this first,
 * and an unknown event takes the refusal exit 2: it may be PreToolUse (`pretooluse`,
 * ` PreToolUse`, a zero-width or Cyrillic lookalike), and exit 2 is the refusal there.
 *
 * The condition is ONLY that fixed set, compared byte-for-byte — never the registry.
 * Before, membership was the registry's, and an unreadable registry left it undecidable,
 * so `pretooluse` on a broken registry answered exit 1 (allow) — and a real host event the
 * registry did not list answered exit 2 even at UserPromptSubmit, against the table. A
 * real host event absent from the registry is now a registry fault at a KNOWN event,
 * answered by that event's row of the table.
 */
function eventIsUnknown() {
  return typeof event !== "string" || !HOST_EVENT_SET.has(event);
}

/**
 * Why a deny-row set is UNKNOWN, in words — one phrase per `unknown` form that
 * unrunDenyRows and recordRegistryFault produce, so the reply and the durable row say
 * the same thing.
 */
function unknownRowsText(unrun) {
  switch (unrun && unrun.unknown) {
    case "local":
      return "this repo's dispatch-registry.local.json is not read on a fault path";
    case "local-fault":
      return "this repo's own registry or its supervisor faulted, so which of its deny rows ran is unknown";
    case "loom-unlisted":
      return "loom's registry does not list this event";
    case "dispatcher":
      return `the dispatcher stalled or failed part-way, so which deny rows completed is unknown; registered for this call: ${(unrun.registered || []).join(",")}`;
    default:
      return "loom's registry could not be read";
  }
}

/**
 * THE DURABLE RECORD of a fault that left deny rows unrun at a non-PreToolUse event
 * (engine-w1 R1 SEC MED, the stdin-bound fault; R2-F4 + R2-SEC-2, every other fault
 * through registryFaultReply → recordRegistryFault). One `violations.jsonl` row through
 * the SAME writer the detectors' ledger uses — `lib/state-io.js::appendViolation`, the
 * sink `detect-violations.js::_logViolation` ends in — never a new one. It names the
 * event, the fault kind (ceiling / deadline / registry / starved / stall / …), the byte
 * count that arrived when a byte bound fired (`bytes` null omits it) and the skipped
 * hooks; it carries NOTHING of the payload (a discarded buffer is never quoted). Anchored
 * at THIS dispatcher's own repo (STOP_SINK_ROOT), never the payload's cwd, which a fault
 * leaves unknown or untrusted.
 *
 * SEVERITY `advisory` (R2-F7 + R2-SEC-5): the row records a HOST or DISPATCHER fault —
 * a payload past the input bound, an unreadable registry, a stalled dispatch — not an act
 * of the agent's, so it must not weigh as an agent violation in the posture arithmetic a
 * `halt-and-report` row feeds (a stuck Stop chain alone wrote one per refire). The anchor
 * and the `dispatcher-unsigned` attribution stay: the row is still the skip's only trace.
 *
 * Returns { ok: true, id } or { ok: false, loud }: a failure never changes the event's
 * outcome — the caller carries `loud` in the reply, so it is never silent.
 */
const UNRUN_DENY_RULE_ID = "dispatch/deny-rows-unrun";
function recordUnrunDenyRows(kind, bytes, unrun) {
  const skipped = Array.isArray(unrun.rows) ? unrun.rows.join(",") : `UNKNOWN (${unknownRowsText(unrun)})`;
  const evidence = `event=${event} fault=${kind}${typeof bytes === "number" ? ` bytes=${bytes}` : ""} skipped=${skipped}`;
  try {
    const { appendViolation } = require(path.join(HOOKS_DIR, "lib", "state-io.js"));
    const id = appendViolation(STOP_SINK_ROOT, {
      rule_id: UNRUN_DENY_RULE_ID,
      severity: "advisory",
      evidence,
      posture_at_time: String(process.env.CLAUDE_CURRENT_POSTURE || "unknown").slice(0, 64),
      addressed_by: null,
      attribution: "dispatcher-unsigned",
    });
    return { ok: true, id };
  } catch (e) {
    return {
      ok: false,
      loud:
        `[dispatch] DURABLE RECORD FAILED — the ${UNRUN_DENY_RULE_ID} row for this fault (${evidence}) was NOT written ` +
        `to violations.jsonl: ${e && e.message ? e.message : String(e)}. The reply above stands; the skipped check is recorded nowhere else.`,
    };
  }
}

/** A JSON object that is not an array — the only shape a host payload has. */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * The deny rows REGISTERED for this call at `event` — every row of loom's registry
 * for `event` declaring `on_incomplete: "deny"` (the declaration
 * dispatch-registry.js::onIncompleteOf reads; the field's default is "deny"),
 * narrowed by tool as below. It reads the registry only, never which rows RAN: on a
 * stdin-bound fault no row ran, so "registered" and "left unrun" coincide; on a stall or
 * a throw (the hatch's other callers) some may have run and allowed, and they count
 * too — the stricter rule, kept deliberately (engine-w1 R1 LOW-6).
 *
 * WHY THIS DECIDES THE REPLY (ruling 9a(c), 2026-10-13; disposition re-based on the
 * frozen crash table, engine-w1 R1 MED-3). The 2 s / 4 MiB bound holds at EVERY event
 * — spec and Codex parity — and a fired bound outside PreToolUse runs no detector.
 * That made SIZE a switch: a PostToolUse payload padded past 4 MiB (an Edit of a
 * padded file carries the file) ran none of that event's deny rows —
 * detect-violations, the burndown write guards — while the call it reported had
 * already happened. A fired bound at an event with a deny row now takes that event's
 * row of the ONE per-event table (incompleteDenyDisposition) AND leaves a DURABLE
 * violations.jsonl row naming the skipped guards (recordUnrunDenyRows) — the reply
 * reaches only the actor, so without the row the skip left no trace. An event whose
 * rows are all `continue` keeps the loud exit 1: nothing there could have refused.
 *
 * The matcher narrows the set ONLY when the bound that fired was the DEADLINE and the
 * buffer parsed as a whole document (the host had written everything): its tool name
 * is the host's. The caller passes null otherwise, so EVERY deny row of the event
 * counts — the stricter reading, as an undecidable (regex) matcher also counts. The
 * narrowing reads `tool_name`; an event whose matcher reads another field (SubagentStop
 * `agent_type`, PreCompact `trigger`) has no deny row today, and one added there must
 * narrow on its own field.
 * THE REPO'S OWN REGISTRY (S-C F2, ruling 9a). It is not read on a fault path (main()
 * defers it until loom's verdict exists — round-3 H1), so when the file EXISTS its
 * rows are UNKNOWN, and unknown counts as "a deny row may exist" exactly as an
 * unreadable loom registry does: before, a consumer's local deny row at an event where
 * loom has only `continue` rows went unrun behind a loud, non-blocking exit 1, with no
 * record. Existence is an lstat, so a symlink or a directory under that name counts
 * too — the stricter reading.
 *
 * The same answer decides the read-only repair hatch (S-C F1): Read/Grep/Glob are
 * admitted on a fault only when this returns a KNOWN empty set for the tool — never in
 * loom's own registry, which registers a PreToolUse deny row for each of the three.
 *
 * @param {object|null} payload a WHOLE document to narrow by its `tool_name`, or null
 *   to count every deny row of the event.
 * @returns {{rows: string[]|null, unknown: "loom"|"loom-unlisted"|"local"|null}} `rows`: hook names,
 *   [] when the event has no deny row for this call; null when a registry's rows are
 *   unknown — `unknown` names which — and the caller treats that as "a deny row may
 *   exist" (the stricter reading lateFaultReply also takes): the table's disposition,
 *   a durable record, and the hatch's read-only half closed.
 */
function unrunDenyRows(payload) {
  try {
    const registryLib = require(path.join(HOOKS_DIR, "lib", "dispatch-registry.js"));
    const hookEngine = require(path.join(HOOKS_DIR, "lib", "hook-engine.js"));
    if (pinArg !== null && !/^[0-9a-f]{64}$/.test(pinArg)) return { rows: null, unknown: "loom" };
    const resolved = registryLib.resolvePinnedRegistryText(HOOKS_DIR, pinArg, registryLib.snapshotDirChoice(process.env));
    const reg = registryLib.parseRegistryText(resolved.text);
    if (!Object.prototype.hasOwnProperty.call(reg.events, event)) return { rows: null, unknown: "loom-unlisted" };
    if (localRegistryPresent(registryLib)) return { rows: null, unknown: "local" };
    const tool = payload && typeof payload.tool_name === "string" ? payload.tool_name : null;
    const rows = registryLib
      .detectorsFor(reg, event)
      .filter((r) => r.onIncomplete === "deny" && (tool === null || hookEngine.matcherMatchesWithoutRegex(r.matcher, tool, event) !== false))
      .map((r) => r.hook);
    return { rows: [...new Set(rows)], unknown: null }; // one name per hook: a hook in two groups is one guard
  } catch {
    return { rows: null, unknown: "loom" };
  }
}

/** The repo's own registry file is present (lstat: any entry under that name). Any error
 *  other than "no such file" counts as PRESENT — unknown, the stricter reading. */
function localRegistryPresent(registryLib) {
  try {
    require("fs").lstatSync(registryLib.localRegistryPath(HOOKS_DIR));
    return true;
  } catch (e) {
    return !(e && (e.code === "ENOENT" || e.code === "ENOTDIR"));
  }
}

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

/**
 * S-C F1 (ruling 9a): may the repair hatch admit THIS read-only lookup? Only when no
 * deny row for the tool is REGISTERED at this event — a KNOWN empty set from
 * unrunDenyRows, which counts a row that already ran and allowed too (the stricter rule,
 * engine-w1 R1 LOW-6). Loom's own registry never yields one for Read, Grep or Glob. Before, the hatch admitted Read/Grep/Glob unconditionally on every
 * loom-side fault, so a fault (a stalled read, a broken registry, a dispatcher
 * stall) let a lookup run past a guard written to refuse it (probe-phase-guard,
 * during a /certify probe). `narrow` is the WHOLE document to narrow by, or null —
 * then every deny row of the event counts.
 */
function readOnlyHatchOpen(narrow, tool) {
  if (!READ_ONLY_TOOLS.includes(tool)) return false;
  const u = unrunDenyRows(narrow === null ? null : { tool_name: tool });
  return Array.isArray(u.rows) && u.rows.length === 0;
}

/**
 * The reply for a stdin-bound fault at an event with a deny row left unrun
 * (unrunDenyRows), decided by the ONE per-event table (incompleteDenyDisposition,
 * engine-w1 R1 MED-3) — never by this function:
 *   - "refuse" (Stop / SubagentStop with `stop_hook_active` not true): the event's own
 *     refusal shape via hook-engine.js::restrictiveReply — `decision:"block"` + exit 2 —
 *     with a bare exit 2 if even that cannot load. ONLY when stop-refusal.js's loop bounds
 *     COUNT it (stopRefusalVerdict, hook-output-discipline.md MUST-6(b)): a refusal they
 *     decline or cannot count — the budget spent, the kill switch, no whole document, no
 *     session to budget — is made "allow-loud" instead;
 *   - "report" (PostToolUse — the call already ran): the reason to the model as
 *     additionalContext, exit 0, and on stderr;
 *   - "allow-loud" (UserPromptSubmit, the Stop refire, PreCompact and every other
 *     event): a non-JSON exit 1 naming the skipped guards, which the host shows.
 * `doc` is the buffer when it parsed as a whole JSON object (the Stop flag's source);
 * `whole` is the same only for a DEADLINE (the tool narrowing's source). `record` is
 * recordUnrunDenyRows' result, so the text says whether the durable row landed. No
 * guard is evaluated: the buffer is discarded exactly as at PreToolUse.
 */
function stdinBoundBlock(why, unrunRows, whole, doc = null, record = null, kind = "ceiling") {
  const denyRows = unrunRows.rows;
  const narrowed = whole !== null && typeof whole.tool_name === "string";
  const unrun = !denyRows
    ? `every guard registered for it (${unknownRowsText(unrunRows)}, so which of its rows can block is unknown)`
    : narrowed
      ? `${denyRows.join(", ")}, which would have run for this call`
      : `every guard at ${event} that can block — ${denyRows.join(", ")} — since the discarded payload names no tool to rule one out`;
  const stopLike = event === "Stop" || event === "SubagentStop";
  // The table is the fail-closed lane's, byte-identical; a Stop "refuse" it returns is
  // only a REQUEST, which the loop bounds then grant or decline (R2-F1 + R2-SEC-1 + R2-F2).
  let disposition = incompleteDenyDisposition(event, doc);
  let declined = null;
  if (disposition === "refuse" && stopLike) {
    const v = stopRefusalVerdict(doc, "dispatch-stdin-bound");
    if (v.refuse !== true) {
      disposition = "allow-loud";
      declined = v.reason || "unknown";
    }
  }
  const after =
    event === "PostToolUse"
      ? "The operation itself ALREADY RAN; what did not happen is its check. "
      : "";
  // The remedy is the one the AUTHOR of the oversized payload can act on: a Stop's
  // payload is the host's (end the turn again), a prompt's is the user's own text
  // (re-splitting a tool call does not shrink it), and a tool event's is the call's.
  const remedy = kind === "deadline"
    ? "  - Retry once; if it recurs, report this budget and wait for the user.\n"
    : stopLike
    ? "  - Retry ending the turn once; if the Stop payload exceeds the size ceiling again, report that ceiling and wait for the user.\n"
    : event === "UserPromptSubmit"
      ? "  - Send a shorter prompt: put large content in a file and give its path instead of pasting it, so the prompt fits and is checked.\n"
      : "  - Re-split the operation into smaller ones (e.g. one large Write or Edit into several), so each payload fits and is checked.\n";
  // WHY follows the disposition the table chose — the text never claims a refusal the
  // reply does not make.
  const policy = "the per-event policy (dispatch-main.js::incompleteDenyDisposition)";
  const whyLine =
    disposition === "refuse"
      ? "WHY: a guard that can refuse and did not run has not passed, so this is the fail-closed disposition."
      : disposition === "report"
        ? `WHY: at ${event} the operation already ran, so a refusal would prevent nothing: ${policy} REPORTS the skipped check instead of blocking.`
        : stopLike && declined !== null
          ? `WHY: ${policy} asks to refuse this hand-back, but the hand-back refusal's loop bound DECLINED it (${declined}) — a refusal that cannot be counted is not made (hook-output-discipline.md MUST-6(b)), so it is allowed, LOUDLY.`
          : stopLike
          ? `WHY: this hand-back was refused once already (stop_hook_active is true), so ${policy} allows it on the refire, LOUDLY — a fault that recurs on every Stop cannot hold the session.`
          : event === "UserPromptSubmit"
            ? `WHY: refusing the user's own prompt would wedge the session, so ${policy} allows it, LOUDLY.`
            : `WHY: at ${event} ${policy} allows an incomplete check, LOUDLY.`;
  const recorded =
    record && record.ok
      ? ` The skipped check IS recorded: one ${UNRUN_DENY_RULE_ID} row in violations.jsonl.`
      : record
        ? " The skipped check could NOT be recorded (see the DURABLE RECORD FAILED line)."
        : "";
  // R2-SEC-4: the failure line itself travels in the reply — in the text the MODEL reads
  // (additionalContext / the block reason) and in a systemMessage the USER sees — never on
  // stderr alone. An allow-loud reply is non-JSON by construction (a JSON reply at exit 1
  // reads as success), so there the line rides the loud stderr the host shows the user.
  const failed = record && !record.ok && typeof record.loud === "string" ? record.loud : null;
  const head = disposition === "refuse" ? "STOP" : disposition === "report" ? "NOTICE" : "WARNING";
  const text =
    `${head} — ${event} guards did NOT run.\n\n` +
    `WHAT HAPPENED: this ${event} payload exceeded the dispatcher's input bound (${why}), so dispatch.js discarded it ` +
    `and NO guard ran — including ${unrun} (on_incomplete:"deny"). ${after}${recorded}\n` +
    whyLine + "\n\n" +
    "REPORT TO USER (do not skip any):\n" +
    "  - Quote the reason above: the payload did not fit the dispatcher's 2 s / 4 MiB input budget.\n" +
    remedy +
    "  - A deadline that fired once may pass on a retry; a payload over 4 MiB is refused the same way every time.\n" +
    (failed ? `\n${failed}\n` : "");
  if (disposition === "report") {
    return {
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text }, ...(failed ? { systemMessage: failed } : {}) }) + "\n",
      stderr: "\n" + text + "\n",
      exitCode: 0,
    };
  }
  if (disposition === "allow-loud") {
    return { stdout: "", stderr: `[dispatch] ${text}`, exitCode: 1 };
  }
  let out;
  try {
    out = require(path.join(HOOKS_DIR, "lib", "hook-engine.js")).restrictiveReply(event, [], text);
  } catch {
    return { stdout: "", stderr: "\n" + text + "\n", exitCode: 2 };
  }
  if (!failed) return out;
  try {
    const j = JSON.parse(String(out.stdout || ""));
    if (isPlainObject(j)) return { ...out, stdout: JSON.stringify({ ...j, systemMessage: failed }) + "\n" };
  } catch {}
  return out;
}

/**
 * The hand-back refusal's LOOP BOUNDS for a stdin-bound Stop / SubagentStop the table asks
 * to refuse (engine-w1 R2-F1 + R2-SEC-1 + R2-F2; hook-output-discipline.md MUST-6(b)):
 * stop-refusal.js::refusalVerdict — the host's `stop_hook_active` read by the LIBRARY from
 * the raw document, a per-session budget strictly below the host's 8-block override, and
 * the COC_STOP_REFUSAL kill switch. FAIL OPEN: a refusal that cannot be counted is not
 * made. Uncountable is: no whole JSON document (nothing to read the flag from), or no
 * usable session_id (no session to budget) — the same countability gate the Codex
 * runtime applies (codex-hook-runtime.js::finalizeNativeEventFailure), and the same
 * "budget-unavailable" answer when the library cannot load. Returns {refuse, reason}.
 *
 * BUDGET KEY: the caller supplies it. `dispatch-stdin-bound` (stdinBoundBlock) and
 * `dispatch-incomplete-deny` (boundedStopRefusal) stay DISTINCT on purpose: the two
 * dispositions never spend each other's slots. A shared key lets one path exhaust the
 * other's refusals.
 */
function stopRefusalVerdict(doc, budgetKey) {
  if (!isPlainObject(doc)) return { refuse: false, reason: "uncountable-input: no whole JSON document arrived, so there is no stop_hook_active to read and no session to budget" };
  if (typeof doc.session_id !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(doc.session_id) || doc.session_id === "unknown-session") {
    return { refuse: false, reason: "uncountable-input: the document names no usable session_id, so no per-session budget can count the refusal" };
  }
  try {
    const v = require(path.join(HOOKS_DIR, "lib", "stop-refusal.js")).refusalVerdict(
      event,
      { payload: doc, repoDir: STOP_SINK_ROOT, budgetKey },
      { nativeSubagentStop: event === "SubagentStop" },
    );
    return v && typeof v === "object" ? v : { refuse: false, reason: "budget-unavailable: no verdict" };
  } catch (e) {
    return { refuse: false, reason: `budget-unavailable: ${e && e.message ? e.message : String(e)}` };
  }
}

/**
 * The reply of the watchdog ("stall") and of the fatal handler ("fatal") — the two
 * replies built OUTSIDE main()'s own merge. At PreToolUse the repair hatch may
 * admit the call (a non-JSON exit 1), but only when NOTHING had refused it: a
 * restrictive verdict a detector had already reached before the fault is still
 * DELIVERED, merged with the fault's refusal — a fault after a deny must never be
 * the thing that lets the denied call run. Verdicts that cannot be judged (the
 * engine's own judgement throws) count as restrictive: REFUSE, at EVERY event that
 * can refuse (round-5 review B — before, outside PreToolUse an unjudgeable verdict
 * list returned the bare fault, dropping a block a detector had reached). Every
 * reached outcome then rides hook-engine.js::restrictiveReply (string fields only)
 * as a refusal reason, with the fault's text. SessionStart / SessionEnd have no
 * refusal, so there the loud fault stands.
 *
 * An `ask` COUNTS here (engine.isRestrictive), unlike at the repo-detector gate
 * (engine.closesLocalGate): an ask that a late fault let the hatch admit silently
 * would be DROPPED — the call run without the question. At PreToolUse it is merged
 * beside the fault's refusal, so it is delivered as a deny (deny beats ask at the
 * host): stricter than the ask, never looser — re-expressed by askAsDeny first, so
 * its reason is in the refusal instead of being dropped by the merge. Now that an ask no longer skips the
 * repo detectors, a late fault can also land after a repo detector's ask — the same
 * rule covers it (`reached` holds the repo outcomes too).
 *
 * EVERY EVENT WITH A REFUSAL, not only PreToolUse: a Stop / SubagentStop /
 * UserPromptSubmit / PostToolUse block or a PreCompact block a detector reached is
 * delivered too, with the fault beside it as the loud failure it is (a user-only
 * note; at PreCompact a notice on the block's text). Without this a late throw or a
 * stall at Stop turned a block into "the turn may end".
 *
 * `reached` is LIVE: the engine reports each outcome as it is decided
 * (runDetectorsIsolated `onOutcome`), so a fault that lands while loom's run is still
 * going sees the verdicts already reached — never an empty list that reads as
 * "nothing refused" and opens the hatch for a call an earlier detector denied. A
 * detector still RUNNING at the fault has no verdict yet, exactly as a repo-owned
 * detector that never ran has none; the hatch treats both the same way.
 *
 * If the merge itself throws, the verdicts still go out through
 * hook-engine.js::restrictiveReply (string fields only), and failing even that, as a
 * bare exit 2 — a refusal at every event that has one.
 */
function lateFaultReply(err, kind) {
  const fault = registryFaultReply(err, hostPayload, undefined, kind);
  // Judged whether or not the hatch matched: a refusal of a non-hatch call must
  // carry the detectors' own reasons too, not only the fault's.
  let verdicts = null;
  // An incomplete deny row reached before the fault is a fail-closed verdict too
  // (R1-F3) wherever the ONE per-event table refuses it — PreToolUse, and the
  // ONCE-refusal at Stop / SubagentStop — mirroring the normal-path conversion
  // (applyIncompleteDenyRefusals): the fault must not be the thing that lets the call
  // (or the turn's end) through unvetted.
  let lateDisposition = "refuse";
  try {
    lateDisposition = incompleteDenyDisposition(event, hostPayload);
  } catch {}
  // The table's Stop / SubagentStop "refuse" is a REQUEST the loop bounds grant or decline
  // (boundedStopRefusal; hook-output-discipline.md MUST-6(b)) — asked only where a refusal
  // would actually be made (an incomplete deny row reached, or verdicts that cannot be
  // judged), so a late fault with nothing to refuse spends no budget slot. Declined, the
  // disposition is "allow-loud" and the bound is named in the reply.
  let lateDeclined = null;
  const boundLate = () => {
    if (lateDisposition !== "refuse" || (event !== "Stop" && event !== "SubagentStop")) return;
    let v;
    try {
      v = boundedStopRefusal();
    } catch (e) {
      v = { refuse: false, reason: `budget-unavailable: ${e && e.message ? e.message : String(e)}` };
    }
    if (!v || v.refuse !== true) {
      lateDisposition = "allow-loud";
      lateDeclined = (v && v.reason) || "unknown";
    }
  };
  let anyIncomplete = true;
  try {
    anyIncomplete = reached.some((o) => o && o.incompleteDeny);
  } catch {}
  if (anyIncomplete) boundLate();
  let refusesIncomplete = lateDisposition === "refuse";
  const declinedNote = () =>
    lateDeclined === null
      ? ""
      : `[dispatch] WARNING — ${event} ALLOWED with an UNVETTED deny-capable check: the per-event policy (dispatch-main.js::incompleteDenyDisposition) ` +
        `asked to refuse it, but the hand-back refusal's loop bound DECLINED it (${lateDeclined}) — a refusal that cannot be counted is not made ` +
        "(hook-output-discipline.md MUST-6(b)).\n";
  const denyOutcomesOf = (vs) => {
    const already = new Set(vs.map((o) => (o && typeof o.stderr === "string" ? o.stderr : "")));
    return vs
      .filter((o) => o && o.incompleteDeny)
      .map((o) => ({ hook: "dispatch.js", status: "exit", exitCode: 2, stdout: "", stderr: incompleteDenyRefusalText(o) }))
      .filter((o) => !already.has(o.stderr));
  };
  try {
    verdicts = reached.filter((o) => o && (reachedEngine.isRestrictive(o, event) || (refusesIncomplete && o.incompleteDeny)));
  } catch {}
  if (verdicts && !verdicts.length) {
    // nothing refused ⇒ the fault reply (hatch included) stands — with the declined bound named
    return lateDeclined === null ? fault : { ...fault, stderr: `${String(fault.stderr || "").trimEnd()}\n${declinedNote()}` };
  }
  if (event !== "PreToolUse") {
    if (!verdicts) {
      // Unjudgeable: nobody knows whether a real block was reached — the same epistemic
      // state as a crashed deny row, so it takes the same row of the ONE per-event table
      // (incompleteDenyDisposition, ROOT ruling): refused where the table refuses
      // (Stop / SubagentStop ONCE — a recurring fault cannot loop the session), REPORTED to
      // the model at PostToolUse (the action already ran), allowed LOUDLY elsewhere
      // (UserPromptSubmit — refusing the user's own prompt would wedge the session, the
      // human could not even type the fix). Only the UNJUDGEABLE case is bounded: a
      // verdict list that CAN be judged keeps every real block (the branch below).
      if (event === "SessionStart" || event === "SessionEnd") return fault;
      // A Stop refusal of unjudged verdicts is the table's REQUEST too: bounded the same way.
      boundLate();
      refusesIncomplete = lateDisposition === "refuse";
      if (!refusesIncomplete) {
        const rows = [...new Set(reached.filter(Boolean).map((o) => (typeof o.hook === "string" && o.hook ? o.hook : "(unnamed row)")))];
        const why =
          `the dispatcher could not judge the detectors' verdicts (${rows.length ? rows.join(", ") : "none reached"}), so whether one of them ` +
          (lateDeclined !== null
            ? `blocked is UNKNOWN; at ${event} the per-event policy (dispatch-main.js::incompleteDenyDisposition) asks to refuse, but the ` +
              `hand-back refusal's loop bound DECLINED it (${lateDeclined}) — a refusal that cannot be counted is not made (hook-output-discipline.md MUST-6(b)).`
            : `blocked is UNKNOWN; at ${event} the per-event policy (dispatch-main.js::incompleteDenyDisposition) does not refuse `) +
          (lateDeclined !== null
            ? ""
            : event === "Stop" || event === "SubagentStop"
            ? "on the refire (stop_hook_active true) — it was refused once — so a recurring fault cannot hold the session."
            : event === "PostToolUse"
            ? "— the action already ran, so a refusal would prevent nothing."
            : event === "UserPromptSubmit"
            ? "— refusing the user's own prompt would wedge the session."
            : "an incomplete check.");
        // Not enforced, but never SILENT: every reached outcome's own text rides the reply.
        const said = unjudgedReasonsText(reached);
        if (lateDisposition === "report") {
          const note = `[dispatch] NOTICE — ${event}: the call ran with UNJUDGED verdicts: ${why}`;
          return {
            stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: `${note}\n${said}${fault.stderr.trim()}` } }) + "\n",
            stderr: `${fault.stderr.trim()}\n${note}\n${said}`,
            exitCode: 0,
          };
        }
        return {
          stdout: "",
          stderr: `${fault.stderr.trim()}\n[dispatch] WARNING — ${event} ALLOWED with UNJUDGED verdicts: ${why}\n${said}`,
          exitCode: 1,
        };
      }
      const extra = `${fault.stderr.trim()} The dispatcher could not judge the detectors' verdicts, so every one reached is delivered as a refusal.`;
      try {
        return reachedEngine.restrictiveReply(event, reached.filter(Boolean), extra);
      } catch {}
      return { stdout: "", stderr: fault.stderr, exitCode: 2 };
    }
    const faultOutcome = { hook: "dispatch.js", status: "exit", exitCode: 1, stdout: "", stderr: fault.stderr + declinedNote(), ...(event === "PreCompact" ? { notice: true } : {}) };
    let stopDenies = [];
    try {
      stopDenies = denyOutcomesOf(verdicts);
    } catch {}
    try {
      return reachedEngine.mergeOutcomes(event, [...verdicts, ...stopDenies, faultOutcome]);
    } catch {}
    try {
      return reachedEngine.restrictiveReply(event, verdicts, fault.stderr);
    } catch {}
    return { stdout: "", stderr: fault.stderr, exitCode: 2 };
  }
  const refusal = registryFaultReply(err, hostPayload, undefined, kind, { hatch: false });
  if (verdicts) {
    // An incomplete deny row reached before the fault keeps its fail-closed
    // refusal beside the fault's, NAMED (R1-F3). When the normal-path conversion
    // already produced that refusal outcome, its text is among the verdicts and
    // is not repeated — the dedup is by the generated text itself.
    const denyOutcomes = denyOutcomesOf(verdicts);
    try {
      return reachedEngine.mergeOutcomes(event, [...verdicts.map(askAsDeny), ...denyOutcomes, { hook: "dispatch.js", status: "exit", exitCode: 2, stdout: refusal.stdout, stderr: refusal.stderr }]);
    } catch {}
    try {
      return reachedEngine.restrictiveReply(event, verdicts, refusal.stderr);
    } catch {}
  } else {
    // Unjudgeable: every reached outcome rides the refusal as a reason, as at the
    // other refusing events above.
    try {
      return reachedEngine.restrictiveReply(event, reached.filter(Boolean), refusal.stderr);
    } catch {}
  }
  return refusal; // even the fallback failed: the refusal alone still refuses
}

/**
 * A reached PreToolUse `ask`, re-expressed as the DENY a late fault turns it into.
 * The merge ranks deny above ask and keeps only the deny reasons, so an ask merged
 * as-is beside the fault's refusal would vanish from the reply — while the refusal
 * says every reached verdict "is repeated below". Only the decision and its reason
 * change; the rest of the detector's JSON (context, a halt) is kept. Anything that
 * is not a plain JSON ask is returned unchanged.
 */
function askAsDeny(o) {
  try {
    if (!o || o.exitCode === 2) return o;
    const j = JSON.parse(String(o.stdout || "").trim());
    const h = j && typeof j === "object" && j.hookSpecificOutput;
    if (!h || typeof h !== "object" || h.permissionDecision !== "ask") return o;
    const why = typeof h.permissionDecisionReason === "string" && h.permissionDecisionReason ? `: ${h.permissionDecisionReason}` : "";
    const denied = {
      ...j,
      hookSpecificOutput: {
        ...h,
        permissionDecision: "deny",
        permissionDecisionReason: `${o.hook} ASKED for confirmation of this call${why}\n(delivered as a refusal: the dispatcher failed after it, so the call cannot be put to the user as vetted)`,
      },
    };
    return { ...o, stdout: JSON.stringify(denied) + "\n" };
  } catch {
    return o;
  }
}

/**
 * THE PER-EVENT POLICY FOR AN INCOMPLETE DENY ROW (ROOT ruling, fail-closed completeness
 * Wave 3) — the ONE table that decides what a deny-capable check that did not complete
 * (crashed, overran its budget, could not read its payload) does at each event. Read here
 * (applyIncompleteDenyRefusals, lateFaultReply) and by the guard runner for a standalone
 * run (lib/guard-runner.js::incompleteDisposition), so the two paths cannot disagree.
 *
 *   PreToolUse         refuse      the call has not run; an unvetted call does not run.
 *   Stop/SubagentStop  block-once  refuse when `stop_hook_active` is not true (the turn
 *                                  continues once, the row named); on the refire (true)
 *                                  allow, LOUDLY. A refusal here fires Stop again, so a
 *                                  guard that crashes every time would otherwise loop the
 *                                  session; bounded by the host's own flag, it cannot.
 *                                  (Allowing on the FIRST attempt let a crashing
 *                                  conservation guard end the turn unvetted: fail-open.)
 *   UserPromptSubmit   allow-loud  blocking the user's own prompt wedges the session.
 *   PostToolUse        report      the call already RAN: the reason goes to the model
 *                                  (additionalContext), never a block.
 *   any other event    allow-loud  the host's disposition for a failed hook, loud.
 *   no event at all    refuse      (an unreadable payload, standalone only — the
 *                                  conservative reading of an event it cannot name).
 *
 * Returns "refuse" | "report" | "allow-loud".
 */
const INCOMPLETE_DENY_POLICY = Object.freeze({
  PreToolUse: "refuse",
  Stop: "block-once",
  SubagentStop: "block-once",
  UserPromptSubmit: "allow-loud",
  PostToolUse: "report",
});
function incompleteDenyDisposition(ev, payload) {
  if (typeof ev !== "string" || !ev) return "refuse";
  const rule = Object.prototype.hasOwnProperty.call(INCOMPLETE_DENY_POLICY, ev) ? INCOMPLETE_DENY_POLICY[ev] : "allow-loud";
  if (rule === "block-once") return payload && typeof payload === "object" && payload.stop_hook_active === true ? "allow-loud" : "refuse";
  return rule;
}

/** A JSON object that is not an array — the only shape a host payload has. */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}


// ONE bounded verdict per dispatch, shared by every caller of the table's Stop "refuse"
// (applyIncompleteDenyRefusals — loom's rows and the repo-owned rows — and lateFaultReply):
// a refusal already counted is not counted again, so a late fault landing after the
// normal-path conversion, or the second (repo-owned) conversion, spends no second slot for
// the same Stop. Asked ONLY where a refusal would actually be made — the library writes
// its slot before answering "refuse".
let stopRefusalMemo = null;
function boundedStopRefusal() {
  if (stopRefusalMemo === null) stopRefusalMemo = stopRefusalVerdict(hostPayload, "dispatch-incomplete-deny");
  return stopRefusalMemo;
}

/**
 * FAIL-CLOSED FOR INCOMPLETE DENY ROWS (round-6 SEC R1-F3; the seat's ruling).
 *
 * A registry row declaring `on_incomplete: "deny"` promises a fail-closed
 * disposition — the field name, the registry `_doc` and the Codex C4 ruling all
 * read it that way. Until this, the declaration bought only the per-row worker
 * boundary: a deny row that did not COMPLETE (crash, own-budget overrun, or an
 * exit other than 0 or 2, JSON or not — marked by the engine at decision time)
 * contributed NOTHING, so the call RAN with a deny-capable guard unrun. Where the
 * per-event table refuses, each marked row now becomes a REFUSAL. Security over availability — a
 * crashing deny check WILL block; that is intended.
 *
 * THE ONE REPAIR IT ADMITS (fail-closed completeness, ROOT ruling D1). A guard that
 * could not LOAD (`incompleteKind` "load") or CRASHED after loading ("crash") is
 * usually a guard whose working-tree bytes are broken — a half-applied edit, a
 * conflicted landing's markers. Refusing every Bash call then wedges the session with
 * no way to restore them. So for those two kinds ONLY, and ONLY when git says the
 * file's bytes DIFFER from HEAD or the path is UNMERGED (guardRestoreState — bounded
 * git reads), the refusal names the exact restore line and the repair hatch
 * (dispatch.js::repairHatch, `edit:false`) admits it: restoring committed bytes
 * cannot widen the guard. A guard whose bytes MATCH HEAD is a committed defect —
 * restoring cannot fix it, nothing is admitted, and the refusal tells the operator to
 * fix it from their own terminal. A BUDGET overrun is never repaired here: its
 * refusal says to retry. Unknown (git could not answer) admits nothing.
 *
 * SCOPE, so the rule is not over-read: the repair hatch is PreToolUse-only. Every
 * other event follows the ONE per-event table (incompleteDenyDisposition): Stop /
 * SubagentStop refuse ONCE (exit 2, no hatch) — only as the loop bounds grant it
 * (boundedStopRefusal: budget, kill switch, fail OPEN when uncountable; a declined
 * refusal is allowed LOUDLY, the bound named) — and allow LOUDLY on the refire;
 * PostToolUse reports the row to the model (additionalContext, exit 0);
 * UserPromptSubmit and every other event allow with a named warning (a failure outcome,
 * exit 1), beside the engine's own failure note for the row. The
 * caller's array is also the live `reached` list a late-fault reply reads, so
 * `.push` here is visible there too; lateFaultReply separately honours the raw
 * mark for a fault that lands BEFORE this conversion runs.
 */
function applyIncompleteDenyRefusals(outcomes) {
  const marked = outcomes.filter((x) => x && x.incompleteDeny);
  if (!marked.length) return;
  let disposition = incompleteDenyDisposition(event, hostPayload);
  // The table's Stop / SubagentStop "refuse" is only a REQUEST, which the loop bounds then
  // grant or decline (boundedStopRefusal; hook-output-discipline.md MUST-6(b)): declined —
  // the budget spent, the kill switch, no whole document, no session to budget — it is
  // allowed LOUDLY instead, the bound named.
  let declined = null;
  if (disposition === "refuse" && (event === "Stop" || event === "SubagentStop")) {
    const v = boundedStopRefusal();
    if (!v || v.refuse !== true) {
      disposition = "allow-loud";
      declined = (v && v.reason) || "unknown";
    }
  }
  if (disposition === "report") {
    for (const o of marked) {
      const text = incompleteDenyRefusalText(o, "report");
      outcomes.push({ hook: "dispatch.js", status: "exit", exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) + "\n", stderr: text + "\n" });
    }
    return;
  }
  if (disposition === "allow-loud") {
    // A FAILURE outcome of its own (exit 1), beside the engine's failure note for the row:
    // the merge shows it the way the host shows a failed hook at that event — a lone
    // failure stays exit 1, beside other context it is folded into the event's seen
    // channel (systemMessage at Stop) — and it never refuses, so it cannot continue a turn.
    for (const o of marked) outcomes.push({ hook: "dispatch.js", status: "exit", exitCode: 1, stdout: "", stderr: incompleteDenyRefusalText(o, "allow-loud", declined) });
    return;
  }
  if (event !== "PreToolUse") {
    // block-once at Stop / SubagentStop (stop_hook_active not true): refused, the row
    // named — no repair hatch, which admits tool CALLS and has no meaning at a Stop.
    for (const o of marked) outcomes.push({ hook: "dispatch.js", status: "exit", exitCode: 2, stdout: "", stderr: incompleteDenyRefusalText(o) });
    return;
  }
  // The restorable files of EVERY marked row, as one set: when two guards are broken
  // the operator restores them one call at a time, and a per-row test would let the
  // second row refuse the restore of the first — a wedge. Rows with nothing restorable
  // (a budget overrun, a committed defect, an unknown) refuse every call regardless.
  const plans = marked.map((o) => [o, incompleteRepairPlan(o)]);
  const restorable = [...new Set(plans.flatMap(([, p]) => p.restore.map((r) => `hooks/${r.rel}`)))];
  let admitted = false;
  if (restorable.length) {
    try {
      admitted = require(path.join(HOOKS_DIR, "dispatch.js")).repairHatch(hostPayload, restorable, { edit: false, readOnly: false }) === true;
    } catch {
      admitted = false; // a bootstrap that cannot be read back admits nothing (fail closed)
    }
  }
  for (const [o, p] of plans) {
    if (admitted && p.restore.length) continue; // this call IS the D1 repair of this row
    outcomes.push({ hook: "dispatch.js", status: "exit", exitCode: 2, stdout: "", stderr: incompleteDenyRefusalText(o) });
  }
}

// D1's git reads are BOUNDED: each is one read-only git call under the guard env
// (lib/git-subprocess-env.js::gitEnv — nothing inherited, no global/system config),
// with its own timeout and output cap, asked at most once per file per dispatch, and
// ALL of them share one budget per dispatch. They block this thread, and a dispatcher
// the host kills at its own timeout is a non-blocking pass at PreToolUse — so a slow or
// wedged git must spend a bounded few seconds and then read as "unknown" (nothing
// admitted, still refused), never hold the reply past the host's deadline.
const RESTORE_GIT_TIMEOUT_MS = 1500;
const RESTORE_GIT_TOTAL_MS = 4000;
const RESTORE_GIT_MAX_BYTES = 64 * 1024;
const restoreStateMemo = new Map();
let restoreGitSpentMs = 0;

/** A path relative to .claude/hooks/ made only of plain segments — no `..`, not absolute. */
function isPlainHooksRel(rel) {
  return (
    typeof rel === "string" &&
    rel.length > 0 &&
    rel.length <= 512 &&
    /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(rel) &&
    !rel.split("/").some((s) => s === "." || s === "..")
  );
}

/**
 * D1 — does `.claude/hooks/<rel>` hold bytes a restore from git would CHANGE?
 *   unmerged      the index holds it at a stage > 0 (a conflicted landing; read by
 *                 dispatch.js::unmergedPaths) → restore `--ours`;
 *   modified      it differs from HEAD (`git diff --quiet HEAD`, exit 1) → restore HEAD;
 *   clean         it matches HEAD → a COMMITTED defect, nothing to restore;
 *   not-in-head   HEAD has no such path → nothing to restore it from;
 *   unknown       git could not answer (no binary, not a repo, a timeout) → nothing
 *                 admitted: an unanswered question is never read as "dirty".
 */
function guardRestoreState(rel) {
  if (!restoreStateMemo.has(rel)) {
    let r;
    try {
      r = probeRestoreState(rel);
    } catch (e) {
      // One short line: the refusal is model-facing, and a require stack is neither
      // actionable there nor free of local paths.
      const first = String((e && e.message) || e).split("\n")[0].slice(0, 160);
      r = { state: "unknown", why: `the git read failed (${first})` };
    }
    restoreStateMemo.set(rel, r);
  }
  return restoreStateMemo.get(rel);
}

function probeRestoreState(rel) {
  if (!isPlainHooksRel(rel)) return { state: "unknown", why: "the guard's file name is not a plain path" };
  let G;
  try {
    G = require(path.join(HOOKS_DIR, "lib", "git-subprocess-env.js"));
  } catch {
    return { state: "unknown", why: "the git environment library (.claude/hooks/lib/git-subprocess-env.js) could not be loaded" };
  }
  const bin = G.resolveGitBinary();
  if (!bin) return { state: "unknown", why: "no git binary was found" };
  const env = G.gitEnv();
  const root = path.resolve(HOOKS_DIR, "..", "..");
  const spec = `.claude/hooks/${rel}`;
  const { spawnSync } = require("child_process");
  // `core.fsmonitor=false` and `--no-ext-diff --no-textconv`: a repo-config helper
  // must not run as a side effect of a read made on the refusal path.
  const git = (args) => {
    const left = RESTORE_GIT_TOTAL_MS - restoreGitSpentMs;
    if (left < 50) return { error: { code: "BUDGET" }, status: null, stdout: "" };
    const t = monoNow();
    try {
      return spawnSync(bin, ["-C", root, "-c", "core.fsmonitor=false", ...args], {
        env,
        encoding: "utf8",
        timeout: Math.ceil(Math.min(RESTORE_GIT_TIMEOUT_MS, left)),
        maxBuffer: RESTORE_GIT_MAX_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } finally {
      restoreGitSpentMs += monoNow() - t;
    }
  };
  const failed = (r, what) =>
    r.error
      ? {
          state: "unknown",
          why:
            r.error.code === "BUDGET"
              ? `this call's ${RESTORE_GIT_TOTAL_MS} ms budget for these git reads was spent`
              : r.error.code === "ETIMEDOUT"
              ? `git ${what} did not answer in time`
              : `git ${what} could not run (${r.error.code || r.error.message})`,
        }
      : { state: "unknown", why: `git ${what} exited ${r.status === null ? `on signal ${r.signal}` : r.status}` };
  // UNMERGED? — the ONE answer the bootstrap's own fault reply reads too
  // (dispatch.js::unmergedPaths: the index file itself, no spawn), so the two refusals
  // cannot name different restores for the same file. `null` (no `.git` at the project
  // root — a .claude/ below its repository's root — or an index it cannot read) is "not
  // known unmerged", NEVER "dirty": the reads below still decide, and `git checkout HEAD
  // -- <file>` restores an unmerged path too.
  let unmerged = null;
  try {
    unmerged = require(path.join(HOOKS_DIR, "dispatch.js")).unmergedPaths([spec]);
  } catch {
    unmerged = null;
  }
  if (unmerged && typeof unmerged.has === "function" && unmerged.has(spec)) return { state: "unmerged" };
  // `HEAD:./<path>` — the `./` makes the path relative to `-C root`, not to the
  // top level, so a project whose .claude/ sits below its repository's root still reads.
  const h = git(["rev-parse", "--verify", "--quiet", `HEAD:./${spec}`]);
  if (h.error) return failed(h, "rev-parse");
  if (h.status === 1) return { state: "not-in-head" };
  if (h.status !== 0) return failed(h, "rev-parse");
  const d = git(["diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--", spec]);
  if (d.error) return failed(d, "diff --quiet HEAD");
  if (d.status === 1) return { state: "modified" };
  if (d.status === 0) return { state: "clean" };
  return failed(d, "diff --quiet HEAD");
}

/**
 * What a marked row's refusal may offer as its repair: `restore` lists each file whose
 * restore D1 admits, with its exact line; `held` lists every other candidate with why
 * it is not restorable. Only "load" and "crash" rows have candidates: a crash names
 * the guard's own file; a load failure names it AND the file its load error names
 * (`loadCulprit` — a library the guard pulls in), since that is the file whose bytes
 * are broken. A budget overrun has none.
 */
function incompleteRepairPlan(o) {
  const plan = { kind: o && typeof o.incompleteKind === "string" ? o.incompleteKind : null, restore: [], held: [] };
  if (plan.kind !== "load" && plan.kind !== "crash") return plan;
  const files = [];
  if (o && isPlainHooksRel(o.hook)) files.push(o.hook);
  if (plan.kind === "load" && o && isPlainHooksRel(o.loadCulprit) && !files.includes(o.loadCulprit)) files.push(o.loadCulprit);
  for (const rel of files) {
    const st = guardRestoreState(rel);
    if (st.state === "unmerged") plan.restore.push({ rel, line: `git checkout --ours -- .claude/hooks/${rel}`, state: st.state });
    else if (st.state === "modified") plan.restore.push({ rel, line: `git checkout HEAD -- .claude/hooks/${rel}`, state: st.state });
    else plan.held.push({ rel, state: st.state, why: st.why || "" });
  }
  return plan;
}

/**
 * A guard's static refusal metadata ({ recovery?, escalate? }, forwarded by the engine in
 * shape only — hook-engine.js::refusalMetaFrom), validated by its ONE owner,
 * guard-runner.js::refusalMetaOf. Null when absent, invalid, or the owner will not load:
 * the metadata only adds wording to the text, never a refusal.
 */
function refusalMetaOfOutcome(o) {
  if (!o || !o.refusal) return null;
  try {
    const f = require(path.join(HOOKS_DIR, "lib", "guard-runner.js")).refusalMetaOf;
    return typeof f === "function" ? f(o.refusal) : null;
  } catch {
    return null;
  }
}

/** guard-runner.js::REFUSAL_TEXT — the one refusal-text source — or null when it will not load. */
function refusalTexts() {
  try {
    const T = require(path.join(HOOKS_DIR, "lib", "guard-runner.js")).REFUSAL_TEXT;
    return T && typeof T.BUDGET_SENTENCE === "string" && typeof T.retrySentence === "function" ? T : null;
  } catch {
    return null;
  }
}

/**
 * The text naming ONE incomplete deny row (also read by lateFaultReply), by the row's
 * disposition under the ONE per-event table (incompleteDenyDisposition): "refuse" (the
 * default — a PreToolUse refusal, or the ONCE-refusal at Stop / SubagentStop), "report"
 * (PostToolUse: the call already ran) or "allow-loud" (the warning). Three bodies, by
 * `incompleteKind` (hook-engine.js::incompleteDenyKind): LOAD-FAILED and CRASHED carry
 * the D1 repair (the exact restore line; the "only call this refusal admits"
 * sentence only where the hatch exists, a PreToolUse refusal); BUDGET says the time-out is not a
 * deny and to retry; an unclassified mark keeps the generic repair line. The guard's own
 * static `refusal` metadata (hook-engine.js forwards it; lib/guard-runner.js validates
 * it) adds its RECOVERY — in place of the "user fixes it from their own terminal" lines —
 * and its ESCALATE class.
 */
function incompleteDenyRefusalText(o, mode = "refuse", declined = null) {
  const name = o && typeof o.hook === "string" && o.hook ? o.hook : "(unnamed row)";
  // Same ONE shared delivery constant as registryFaultReply (R2 L2).
  const delivery = deliveryInstruction();
  const plan = incompleteRepairPlan(o);
  const meta = refusalMetaOfOutcome(o);
  const recovery = meta && typeof meta.recovery === "string" && meta.recovery ? meta.recovery : null;
  const escalate = meta && typeof meta.escalate === "string" && meta.escalate ? meta.escalate : null;
  const ev = typeof event === "string" && event ? event : "this event";
  const hatch = mode === "refuse" && event === "PreToolUse";
  const didNot = `${name} declares on_incomplete:"deny" and did NOT complete ${hatch ? "on this call" : `at ${ev}`} — it ` +
    `${o && o.incompleteDeny ? o.incompleteDeny : "did not reach a verdict"}.`;
  const head =
    mode === "report"
      ? `NOTICE — a deny-capable check did not complete (the call already ran).\n\nWHAT HAPPENED: ${didNot} The call that just ran was NOT vetted by this guard; at ${ev} it is reported, not refused.\n`
      : mode === "allow-loud"
      ? `WARNING — ${ev} ALLOWED with an UNVETTED deny-capable check.\n\nWHAT HAPPENED: ${didNot} ` +
        ((event === "Stop" || event === "SubagentStop") && declined !== null
          ? `The per-event policy asks to refuse ${ev} ONCE, but the hand-back refusal's loop bound DECLINED it (${declined}) — ` +
            `a refusal that cannot be counted is not made (hook-output-discipline.md MUST-6(b)), so ${ev} is allowed, LOUDLY, and a guard that cannot finish never holds the session.\n`
          : event === "Stop" || event === "SubagentStop"
          ? `This is the refire (stop_hook_active is true): the row was already refused once, and ${ev} is not refused twice, so a guard that cannot finish never holds the session.\n`
          : `At ${ev} an incomplete check is never a block (blocking the user's own prompt wedges the session).\n`)
      : hatch
      ? `STOP — Tool call blocked.\n\nWHAT HAPPENED: ${didNot} The call was NOT vetted by this guard.\n`
      : `STOP — ${ev} refused ONCE.\n\nWHAT HAPPENED: ${didNot} The turn was NOT vetted by this guard, so it continues once; ` +
        `on the refire (stop_hook_active true) this row is allowed with a warning, never refused again.\n`;
  const contract =
    mode !== "refuse" && declined !== null
      ? "the row's declaration is a fail-closed contract, but the refusal the per-event policy (dispatch-main.js::incompleteDenyDisposition) " +
        `asked for at ${ev} was declined by its loop bound (stop-refusal.js::refusalVerdict) — so the gap is named here instead.`
      : mode !== "refuse"
      ? "the row's declaration is a fail-closed contract, and the per-event policy (dispatch-main.js::incompleteDenyDisposition) " +
        `does not refuse at ${ev} in this state — so the gap is named here instead.`
      : "the row's declaration is a fail-closed contract — an incomplete deny-capable check REFUSES rather than passing, " +
        "because allowing the call would run it with a guard that can refuse having never reached a verdict.";
  const nameIt = `  - Name the detector above (\`.claude/hooks/${name}\`) and quote this reason.\n`;
  let why;
  let repair;
  if (plan.kind === "budget") {
    // The two VERBATIM budget sentences come from the ONE refusal-text source
    // (guard-runner.js::REFUSAL_TEXT), so the dispatcher's budget refusal and the runner's
    // say the same words. A source that will not load costs the wording, never the
    // refusal: this row is refused below either way.
    const T = refusalTexts();
    why =
      `WHY: ${name} ran past its own registered time budget, so it never judged this call. A guard time-out is not a finding ` +
      `about the call: ${T ? T.BUDGET_SENTENCE : "it is a budget refusal (the shared refusal text, .claude/hooks/lib/guard-runner.js, could not be loaded)"}. Still, ${contract}\n\n`;
    repair = T ? `  - ${T.retrySentence(name)}.\n` : `  - Retry the call; if the refusal recurs, quote it (${name} overran its budget).\n`;
    if (recovery) repair += `  - RECOVERY (${name}): ${recovery}\n`;
  } else if (plan.kind === "load" || plan.kind === "crash") {
    why =
      (plan.kind === "load" && o && o.status === "missing"
        ? `WHY: ${name} could not be LOADED — its registered file is MISSING from .claude/hooks/, so the guard never ran. `
        : plan.kind === "load"
        ? `WHY: ${name} could not be LOADED — a file in its load path does not compile or cannot be found (the error is in the ` +
          "dispatcher notes), so the guard never ran. "
        : `WHY: ${name} loaded and then CRASHED (or ended with an exit that is neither 0, a pass, nor 2, a refusal) before ` +
          "reaching a verdict — its own error output is in the dispatcher notes. ") +
      `And ${contract}\n\n`;
    const parts = [];
    if (plan.restore.length) {
      parts.push(
        "  - Its bytes differ from the last commit (" +
          plan.restore.map((r) => `.claude/hooks/${r.rel} is ${r.state === "unmerged" ? "UNMERGED — a conflicted landing" : "MODIFIED"}`).join("; ") +
          "), so restoring them is the repair. Run EXACTLY " +
          (plan.restore.length === 1 ? "this line" : "these lines, one call each") +
          ":\n" +
          plan.restore.map((r) => `      ${r.line}\n`).join("") +
          (hatch ? "    That restore is the only call this refusal admits; nothing else is — a Read/Grep/Glob lookup or an Edit of the file included. " : "    ") +
          "It DISCARDS the file's uncommitted bytes — if they are worth keeping, the user repairs the file from " +
          "their own terminal instead.\n",
      );
    }
    // The guard's own RECOVERY replaces the "user fixes it from their own terminal" lines.
    if (recovery) parts.push(`  - RECOVERY (${name}): ${recovery}\n`);
    for (const h of recovery ? [] : plan.held) {
      parts.push(
        h.state === "clean"
          ? `  - .claude/hooks/${h.rel} MATCHES the last commit: this is a COMMITTED defect, restoring cannot fix it, and no ` +
              "call is admitted past this refusal. The user fixes it from their own terminal (outside this session), then retries.\n"
          : h.state === "not-in-head"
          ? `  - .claude/hooks/${h.rel} is not in the last commit, so there is nothing to restore it from and no call is ` +
              "admitted past this refusal. The user fixes it from their own terminal (outside this session), then retries.\n"
          : `  - Whether .claude/hooks/${h.rel} differs from the last commit could not be determined (${h.why}), so no restore ` +
              "is admitted. The user repairs it from their own terminal (outside this session), then retries.\n",
      );
    }
    if (!parts.length) {
      parts.push(
        "  - No file of this guard could be named for a restore, so no call is admitted past this refusal. The user fixes " +
          "it from their own terminal (outside this session), then retries.\n",
      );
    }
    repair = parts.join("");
  } else {
    why = `WHY: ${contract}\n\n`;
    repair = "  - Repair or fix that detector (and its own crash/timeout output in the dispatcher notes), then retry the call.\n";
    if (recovery) repair += `  - RECOVERY (${name}): ${recovery}\n`;
  }
  if (escalate) repair += `  - ESCALATE(${escalate}): ${name} declares this an ALWAYS-ESCALATE class — route it to the orchestrator, never close it alone.\n`;
  return head + why + "REPORT TO USER (do not skip any):\n" + nameIt + repair + (delivery ? "\n" + delivery + "\n" : "");
}

/**
 * SHADOW ROWS — a loom registry row declaring `enforcement: "shadow"`
 * (lib/dispatch-registry.js::enforcementOf: only that exact, own value relaxes, and never
 * for a NEVER_SHADOW_HOOKS hook). Owner order 2026-10-14: the old guards stop BLOCKING and
 * become a REVIEW FEED for the guard foundation; the data-loss arms keep enforcing.
 *
 * A hook is shadow for THIS call only when EVERY matching loom row naming it declares
 * shadow (main() builds that set, run path and missing-file path alike); one enforce
 * row anywhere in the matched set makes it enforce. The registry also refuses divergent
 * declarations outright (assertNoDivergentEnforcement); this is the second layer.
 *
 * A shadow row still RUNS. When it reaches what WOULD have refused the call, the gate
 * returns a NEUTRALIZED COPY of the outcome (exit 0, no output, no incompleteDeny, no
 * denyRow) and appends ONE allowlisted line to the gitignored feed (lib/shadow-feed.js).
 * "Would have refused" is:
 *   - a restrictive verdict (engine.isRestrictive: deny, ask, exit 2, decision:"block",
 *     continue:false) — EXCEPT one whose row REPORTED a data-loss arm's rule id to the
 *     engine (`o.ruleIds`, via lib/instruct-and-wait.js and hook-engine.js::installShims;
 *     registry NEVER_SHADOW_RULE_IDS), or reported none at all: those are DELIVERED
 *     (fail closed). The id is never read from the reply a hook prints;
 *   - at PreToolUse only, the incomplete-deny refusal and the starved refusal — the only
 *     event where either exists — EXCEPT for a hook with data-loss arms
 *     (NEVER_SHADOW_ARMS): with no verdict there is no rule id, so the arm is unknown.
 * At every other event a starved shadow row keeps its loud dispatcher note.
 *
 * Applied at two points, each of which alone decides a path: in onOutcome, so the LIVE
 * list a late fault reads (lateFaultReply) holds the neutralized copy; and over the
 * finished run, which the normal path reads. Neither mutates the engine's outcome. ONE
 * feed line per hook per call. A feed write failure does not restore the refusal and
 * never drops another row's verdict; it becomes a note.
 *
 * Scope: loom's own registry rows only. A repo-owned (local) row never carries the field
 * to the engine (buildLocalRows forwards an explicit field list), so every repo-owned
 * verdict is delivered.
 */
function makeShadowGate(engine, registryLib, payload, shadowRows, notes) {
  const fed = new Set();
  const toolName = payload && typeof payload === "object" && typeof payload.tool_name === "string" ? payload.tool_name : "";
  let feed = null;
  const verdictOf = (o) => {
    const j = engine.parseJson(o.stdout);
    const h = j && j.hookSpecificOutput && typeof j.hookSpecificOutput === "object" ? j.hookSpecificOutput : {};
    let reason = "";
    for (const v of [h.permissionDecisionReason, j && j.reason, j && j.stopReason, o.stderr]) {
      if (typeof v === "string" && v.trim()) {
        reason = v;
        break;
      }
    }
    // The ids the row REPORTED to the engine (hook-engine.js::installShims), never read
    // from its reply. Any data-loss arm id among them decides; with none, the arm is unknown.
    const ids = Array.isArray(o.ruleIds) ? o.ruleIds.filter((id) => typeof id === "string" && id) : [];
    // What the host would have done, most severe first (the feed's `decision`).
    const decision =
      j && j.continue === false ? "halt"
      : h.permissionDecision === "deny" ? "deny"
      : j && j.decision === "block" ? "block"
      : o.exitCode === 2 ? (event === "PreToolUse" ? "deny" : "block")
      : h.permissionDecision === "ask" ? "ask"
      : null;
    return { reason, ruleIds: ids, overflow: o.ruleIdsOverflow === true, decision };
  };
  const hasDataLossArms = (hook) => registryLib.dataLossArmsOf(hook) !== null;
  return (o) => {
    // A guard whose file is MISSING never ran, so nothing is known about its arms: it is
    // never shadowed (R2b M-2 — an unresolvable row takes the fail-closed path).
    if (!o || o.shadowed || o.status === "missing" || !shadowRows.has(o.hook)) return o;
    let kind = null;
    let reason = "";
    let ruleId = null;
    let decision = "deny"; // the incomplete and starved refusals exist at PreToolUse only
    if (engine.isRestrictive(o, event)) {
      const v = verdictOf(o);
      // No structural id, or ANY data-loss arm's id: the verdict is DELIVERED.
      // An id lost past the engine's bound (overflow) is an UNKNOWN arm: delivered too.
      if (v.overflow || v.ruleIds.length === 0 || v.ruleIds.some((id) => registryLib.NEVER_SHADOW_RULE_IDS.has(id))) return o;
      kind = "verdict";
      reason = v.reason;
      ruleId = v.ruleIds[0];
      decision = v.decision;
    } else if (event === "PreToolUse" && o.incompleteDeny && !hasDataLossArms(o.hook)) {
      kind = "incomplete";
      reason = `did not complete: ${o.incompleteDeny}`;
    } else if (event === "PreToolUse" && (o.status === "skipped" || o.deadlineCut === true) && !hasDataLossArms(o.hook)) {
      kind = "starved";
      reason = o.status === "skipped" ? "was not started before the event deadline" : "was stopped at the event deadline";
    }
    if (!kind) return o;
    const out = { ...o, shadowed: kind, denyRow: false };
    delete out.incompleteDeny;
    if (kind === "verdict") {
      out.exitCode = 0;
      out.stdout = "";
      out.stderr = "";
    }
    if (!fed.has(o.hook)) {
      fed.add(o.hook);
      let err = null;
      try {
        if (!feed) feed = require(path.join(HOOKS_DIR, "lib", "shadow-feed.js"));
        err = feed.appendShadowLine(HOOKS_DIR, feed.shadowRecord({ hook: o.hook, event, toolName, kind, decision, ruleId, reason }));
      } catch (e) {
        err = e && e.message ? e.message : String(e);
      }
      if (err) notes.push(`[dispatch] shadow row ${o.hook} would have refused this call; its review-feed line was NOT written (${err})\n`);
    }
    return out;
  };
}

async function main() {
  const { raw, fault, bytes: rawBytes } = await readAllStdin();
  // A bound that fired is a FAULT, answered BEFORE the parse below and before the
  // watchdog is armed: the buffer is not a payload (it may be truncated), so
  // nothing is dispatched from it. Fail-closed at PreToolUse (hatch aside); at every
  // other event whose rows include a deny row, that event's row of the per-event table
  // plus a durable record of the skipped guards; loud where nothing could have refused — the same bound as the Codex native runtime's
  // own rejected input read. See `stdinBoundFaultReply`.
  if (fault) {
    stopStdinBound = true; // a Stop's receipt names THIS cause (stopReceiptSkipReason)
    return finish(stdinBoundFaultReply(fault, raw));
  }
  let payload = null;
  let parsed = false;
  try {
    payload = JSON.parse(raw);
    parsed = true;
  } catch {
    payload = null;
  }
  hostPayload = payload;
  if (!event && payload && typeof payload.hook_event_name === "string") event = payload.hook_event_name;
  completion.event = event || null; // for the bootstrap's exit check, which reads only the record
  // GF-UNPARSEABLE. At PreToolUse — the event argv names; a bare spawn naming none
  // never reaches this and answers the unknown-event fault below — a payload read with
  // NO input bound firing (EOF, a stream error, or no stdin at all) that is not a JSON
  // object — empty, cut short, or another JSON value — names no call a guard can vet.
  // It used to be dispatched like any payload, and every detector failed open on it
  // ("stdin payload unreadable … It was allowed"), so the very bytes the bound
  // refuses while the stream is open were ALLOWED once it closed. It is refused
  // here, before the registry loads: the refusal does not turn on any row, so no
  // registry fault may change it. Every other event keeps its
  // disposition — the detectors' own handling of the malformed input.
  if (event === "PreToolUse" && (payload === null || typeof payload !== "object" || Array.isArray(payload))) {
    // The reader's own count of what ARRIVED — not a re-measure of the decoded string,
    // which counts each invalid byte as the 3-byte U+FFFD it was decoded to.
    const n = typeof rawBytes === "number" ? rawBytes : Buffer.byteLength(raw, "utf8");
    const arrived = `${n} byte${n === 1 ? "" : "s"} arrived`;
    const why =
      n === 0
        ? "stdin was empty"
        : !parsed
        ? `${arrived}, not parseable as JSON`
        : `${arrived}, parsing as JSON ${payload === null ? "null" : Array.isArray(payload) ? "array" : typeof payload}, not an object`;
    return finish(registryFaultReply(new Error(why), payload, null, "unparseable"));
  }
  // GF-UNPARSEABLE, the object one level up (ruling 9a, folded in): an object that
  // names no tool names no call either. Every PreToolUse the host writes carries a
  // non-empty `tool_name`; without one the dispatcher would run EVERY group
  // (matchAll, below) and each guard reads the call it cannot find as "nothing to
  // check" — `{"tool_name":5}` reached only the Bash guard's no-command block, and
  // nothing in the dispatcher made that the answer. `tool_input` is NOT checked
  // here: whether the host sends an OBJECT for every tool (MCP tools included) is
  // UNMEASURED, and a wrong guess there locks every call of that tool out — the
  // declared residual in the GF-UNPARSEABLE todo.
  // A LOOKALIKE name ("Bash ", "bash", a Cyrillic or zero-width variant) passes this
  // gate and matches no group: tool_name is HOST-written, never the session's, so a
  // lookalike is a hardening note, accepted (engine-w1 R1 SEC LOW-1) — not a code change.
  if (event === "PreToolUse" && (typeof payload.tool_name !== "string" || payload.tool_name.trim() === "")) {
    const got = typeof payload.tool_name === "string" ? "an empty string" : payload.tool_name === undefined ? "absent" : `a JSON ${payload.tool_name === null ? "null" : Array.isArray(payload.tool_name) ? "array" : typeof payload.tool_name}`;
    return finish(registryFaultReply(new Error(`the payload is a JSON object, but its tool_name is ${got}, so it names no tool`), payload, null, "unparseable"));
  }
  // Keep the Stop capability private; only the engine's canonical boundary singleton receives
  // it (`.claude/hooks/lib/hook-engine.js:877-887,1330-1346,1556-1565`).
  delete process.env.COC_STOP_CANDIDATE_ID;
  if (event === "Stop") {
    stopCandidateId = require("crypto").randomBytes(16).toString("hex");
  } else {
    stopCandidateId = null;
  }

  let registryLib;
  let engine;
  let reg;
  let pinNote = null;
  let pinNotice = null;
  let pinNoticeEvery = false;
  let snapshotChoice = null;
  // The session's identity, for the repo-local registry's pin. Read only when it is a
  // usable string; a payload without one leaves the local registry read fresh on every
  // event (the pre-pin behaviour) — the pin is a session-scoped guard, so with no
  // session there is nothing to anchor it to.
  const sessionId =
    payload && typeof payload.session_id === "string" && payload.session_id.length > 0 && payload.session_id.length <= 512
      ? payload.session_id
      : null;
  try {
    registryLib = require(path.join(HOOKS_DIR, "lib", "dispatch-registry.js"));
    engine = require(path.join(HOOKS_DIR, "lib", "hook-engine.js"));
    if (pinArg !== null && !/^[0-9a-f]{64}$/.test(pinArg)) throw new Error("malformed --registry-sha256 argument");
    // Resolved ONCE per event: it mkdir/lstat-probes the directory, and the local
    // registry's SESSION pin uses the SAME choice as the template registry's copy.
    snapshotChoice = registryLib.snapshotDirChoice(process.env);
    const resolved = registryLib.resolvePinnedRegistryText(
      HOOKS_DIR,
      pinArg,
      snapshotChoice,
    );
    reg = registryLib.parseRegistryText(resolved.text);
    // A row that does not name its hook file EXACTLY as it is on disk enforces (R2b M-2,
    // MED-1): on a case-insensitive volume a case variant runs the real file under a name
    // the never-shadow sets do not hold. Per row — never the whole registry.
    registryLib.enforceInexactNames(reg, HOOKS_DIR);
    if (event === "Stop") registrySha256 = require("crypto").createHash("sha256").update(resolved.text).digest("hex");
    pinNote = resolved.note;
    pinNotice = resolved.notice || null;
    pinNoticeEvery = resolved.noticeEveryEvent === true;
    // An event the registry does not list is a registry fault, answered below by
    // registryFaultReply: exit 2 when the name is not one of the host's own
    // (eventIsUnknown), otherwise that event's row of the per-event table.
    if (!(typeof event === "string" && event && Object.prototype.hasOwnProperty.call(reg.events, event))) {
      throw new Error(`no event ${JSON.stringify(event)} in the registry`);
    }
    // The worker opens the event's shared git context; fail here (closed, at
    // PreToolUse) if the pieces it needs are not in this tree.
    require.resolve(path.join(HOOKS_DIR, "lib", "event-git.js"));
    require.resolve(path.join(HOOKS_DIR, "lib", "hook-engine-worker.js"));
  } catch (err) {
    return finish(registryFaultReply(err, payload));
  }

  const spec = reg.events[event];
  // The per-attempt Stop receipt's budget anchor (stopReceiptSkipReason): the host's kill instant.
  if (event === "Stop") stopHostDeadlineAt = t0 + spec.dispatcher.timeout * 1000;
  // Whole-dispatch watchdog, 1 s inside the host's timeout for this entry: whatever
  // stalls the main thread asynchronously, a reply goes out before the host's kill
  // would drop every verdict — fail CLOSED at PreToolUse, open (loudly) elsewhere.
  setTimeout(() => {
    finish(lateFaultReply(new Error("the dispatch did not complete inside its budget"), "stall"));
  }, Math.max(1000, spec.dispatcher.timeout * 1000 - 1000));
  // The payload field the HOST matches a group's `matcher` against, per event — its
  // matchQuery switch, 2.1.283 `function ILt(e){switch(e.hook_event_name){…}}`:
  // `case"PreToolUse":case"PostToolUse":case"PostToolUseFailure":case"PermissionRequest":
  // case"PermissionDenied":return e.tool_name;case"UserPromptExpansion":return
  // e.command_name;case"SessionStart":return e.source;case"Setup":return e.trigger;
  // case"PreCompact":case"PostCompact":return e.trigger;…case"Notification":return
  // e.notification_type;case"SessionEnd":return e.reason;case"StopFailure":return
  // e.error;case"SubagentStart":return e.agent_type;case"SubagentStop":return
  // e.agent_type;…case"Elicitation":return e.mcp_server_name;case"ElicitationResult":
  // return e.mcp_server_name;case"ConfigChange":return e.source;case"DirectoryAdded":
  // return e.source;case"InstructionsLoaded":return e.load_reason;…default:return}`.
  // Stop / UserPromptSubmit / TeammateIdle / TaskCreated / TaskCompleted have none.
  // NOT mirrored (the host transforms the value first; none is a registry event):
  // PreModelSwitch / PostModelSwitch (to_model, normalised) and FileChanged
  // (derived from file_path).
  const MATCH_FIELD = {
    PreToolUse: "tool_name", PostToolUse: "tool_name", PostToolUseFailure: "tool_name",
    PermissionRequest: "tool_name", PermissionDenied: "tool_name", UserPromptExpansion: "command_name",
    SessionStart: "source", Setup: "trigger", PreCompact: "trigger", PostCompact: "trigger",
    Notification: "notification_type", SessionEnd: "reason", StopFailure: "error",
    SubagentStart: "agent_type", SubagentStop: "agent_type", Elicitation: "mcp_server_name",
    ElicitationResult: "mcp_server_name", ConfigChange: "source", DirectoryAdded: "source",
    InstructionsLoaded: "load_reason",
  };
  const matchField = Object.prototype.hasOwnProperty.call(MATCH_FIELD, event) ? MATCH_FIELD[event] : null;
  const matchValue = payload && matchField && typeof payload[matchField] === "string" ? payload[matchField] : undefined;
  const deadlineMs = spec.dispatcher.timeout * 1000 - 2000;
  // The instant the HOST kills this process for this entry — the settings timeout the
  // dispatcher command was registered with, the same one the watchdog below sits 1 s
  // inside and the event deadline 2 s inside. Handed to runLocalSupervised as the cap
  // on its backstop: a supervisor whose boot latency pushed it past the event deadline
  // may spend that 2 s reserve, and not one ms more. Derived from the registry's
  // timeout, NOT from `deadlineMs` + the literal, so the two cannot drift apart.
  const hostDeadlineAt = t0 + spec.dispatcher.timeout * 1000;

  // Same two conditions the settings reconciler used to decide whether a hook was
  // registered in a tree at all: it resolves on disk here, and it is not a
  // loom_only hook outside loom (lib/dispatch-registry.js::makeEligible).
  const projectRoot = path.resolve(HOOKS_DIR, "..", "..");
  const eligible = registryLib.makeEligible(projectRoot, reg);
  // An unparseable payload names no tool; outside PreToolUse (where it is refused
  // above, GF-UNPARSEABLE) run every detector and let each handle the malformed
  // input the way it always did. A payload WITHOUT the match field
  // runs every group too — the host's own rule: `s===void 0||!n||TIe(…)` (no match
  // query ⇒ every matcher matches).
  const matchAll = !(matchField && payload && matchValue !== undefined);
  // +GRACE_MS: several guards arm an internal timer EQUAL to their registration
  // timeout, and some of those timers FAIL CLOSED (integrity-guard's
  // authorization-phase deny). Under the host the race between that timer and the
  // host's kill was unmeasured; here the hook's own timer is guaranteed to fire
  // first, so its fail-closed disposition always gets to land.
  const budgetOf = (d) => (d.timeout || 60) * 1000 + GRACE_MS;

  // LOOM's detectors are selected from LOOM's registry alone. Nothing the repo's
  // local registry supplies — in particular a regex matcher — is evaluated on this
  // thread before loom's verdict exists (see the repo-owned section below).
  const seen = new Set();
  const runnable = [];
  const loomNotes = [];
  const missingGuardOutcome = (d) => {
    const o = { hook: d.hook, status: "missing", exitCode: 0, stdout: "", stderr: "", denyRow: true };
    o.incompleteDeny = engine.incompleteDenyReason(o);
    o.incompleteKind = engine.incompleteDenyKind(o);
    return o;
  };
  const missingLoom = [];
  // Loom hooks every matching row of which declares `enforcement: "shadow"` (§ SHADOW
  // ROWS, makeShadowGate). Filled after the selection loop below, so a later enforce row
  // of the same hook always wins over an earlier shadow row (the STRICTER reading).
  const shadowRows = new Set();
  const matchedEnforcement = new Map(); // hook -> every matching row is shadow
  const applyShadow = makeShadowGate(engine, registryLib, payload, shadowRows, loomNotes);
  for (const d of registryLib.detectorsFor(reg, event)) {
    if (!matchAll && !engine.matcherMatches(d.matcher, matchValue, event)) continue;
    matchedEnforcement.set(d.hook, (matchedEnforcement.has(d.hook) ? matchedEnforcement.get(d.hook) : true) && d.enforcement === "shadow");
    // Eligibility BEFORE de-duplication: a loom row this tree does not run (absent,
    // or loom_only outside loom) must not shadow the repo's own row of that name.
    if (!eligible(d.hook)) {
      if (!fsExists(path.join(HOOKS_DIR, d.hook)) && (eligible.repoClass === "loom" || eligible.repoClass === "unreadable")) {
        // In loom itself every registered detector must exist; a missing one is a
        // guard that silently stopped running (a consumer legitimately lacks some).
        loomNotes.push(`[dispatch] dispatch-registry.json names ${d.hook}, which is not in .claude/hooks/ — NOT run\n`);
        if (d.onIncomplete === "deny") missingLoom.push(missingGuardOutcome(d));
      }
      continue;
    }
    if (seen.has(d.hook)) continue;
    seen.add(d.hook);
    runnable.push({ hook: d.hook, file: path.join(HOOKS_DIR, d.hook), timeoutMs: budgetOf(d), mode: d.mode, onIncomplete: d.onIncomplete, origin: "loom" });
  }

  for (const [hook, allShadow] of matchedEnforcement) if (allShadow) shadowRows.add(hook);
  // A missing guard file goes through the same gate as a run outcome; the gate never
  // shadows it (makeShadowGate), so a missing shadow guard refuses like its enforce twin.
  for (let k = 0; k < missingLoom.length; k += 1) missingLoom[k] = applyShadow(missingLoom[k]);

  // REPO-OWNED rows (the local registry), in registry order — built only AFTER
  // loom's run, and only on the non-restrictive branch (below). `match` is decided
  // here only when it needs no regular expression AND the matcher is short (empty /
  // `*` / a plain list of at most MAX_DISPATCHER_MATCHER_CHARS — linear, nothing to
  // backtrack, and memoized per distinct matcher string, so a group matcher copied
  // onto every row of its group is split once); anything else is left null and
  // decided inside the supervisor process (runLocalSupervised), which this process
  // bounds with its backstop and kills as a group — a stall there is a supervisor
  // fault, never a lost loom verdict. With the file and row caps
  // (lib/dispatch-registry.js) the work done here is O(file size).
  // A local row's `mode` decides WHERE it runs: "legacy" runs it IN-PROCESS, in a worker
  // thread of this process (hook-engine.js § LEGACY ROWS — the process-shaped sandbox
  // without the process), anything else (the default) under the supervisor, outside this
  // process tree. The supervisor is the STRONGER isolation and stays the default: a
  // repo-owned row that must not be able to signal the dispatcher keeps `mode:"process"`.
  const matchMemo = new Map();
  const existsMemo = new Map();
  const decideHere = (m) => {
    if (matchAll) return true;
    if (typeof m === "string" && m.length > MAX_DISPATCHER_MATCHER_CHARS) return null;
    if (!matchMemo.has(m)) matchMemo.set(m, engine.matcherMatchesWithoutRegex(m, matchValue, event));
    return matchMemo.get(m);
  };
  const existsHere = (hook) => {
    if (!existsMemo.has(hook)) existsMemo.set(hook, fsExists(path.join(HOOKS_DIR, hook)));
    return existsMemo.get(hook);
  };
  const buildLocalRows = (local) =>
    registryLib.detectorsFor(local, event).map((d) => ({
      hook: d.hook,
      file: path.join(HOOKS_DIR, d.hook),
      timeoutMs: budgetOf(d),
      matcher: d.matcher,
      match: decideHere(d.matcher),
      exists: existsHere(d.hook),
      loomRuns: seen.has(d.hook), // ADD-ONLY: a local row cannot re-run (or re-time) a hook loom runs
      // `mode` and `onIncomplete` travel with the row: `mode:"legacy"` is run IN-PROCESS
      // by the engine (hook-engine.js § LEGACY ROWS) instead of as its own process, and
      // `on_incomplete:"deny"` earns the same fail-closed incomplete-execution contract
      // it has on loom's side. Both are the row's own declarations, forwarded unchanged.
      mode: d.mode,
      onIncomplete: d.onIncomplete,
    }));
  const missingLocalForPlan = (plan) => {
    return plan.notes.filter((n) => n.kind === "missing" && n.onIncomplete === "deny").map(missingGuardOutcome);
  };
  const planNotes = (plan) =>
    plan.notes.map((n) =>
      n.kind === "missing"
        ? `[dispatch] .claude/dispatch-registry.local.json names ${n.hook}, which is not in .claude/hooks/ — NOT run\n`
        : `[dispatch] .claude/dispatch-registry.local.json row for ${n.hook} ignored: loom already runs it for ${event}\n`,
    );
  // Detectors run in worker threads — one after another in registry order, or all
  // at once under `isolation: "parallel"` (SessionEnd); each one's budget is
  // enforced from this thread, so a detector stuck in synchronous code is
  // abandoned (the host-kill disposition it always had) without stalling the rest
  // or erasing decisions already made (lib/hook-engine.js::runDetectorsIsolated).
  // A row carrying `onIncomplete: "deny"` (the registry's per-row declaration —
  // its verdict can refuse a call) gets a worker of its own: the engine ends the
  // shared batch before it and resumes after it, so no neighbour's realm state can
  // reach that row's verdict — and, because the event's git-answer cache lives on
  // THIS thread (outside any worker isolate), the engine seeds a deny row only
  // from answers written by deny rows (per-realm-kind pools; round-6 SEC R1-F2),
  // so a shared-batch neighbour cannot plant an answer a deny row reads.
  // `reached` is filled as each loom outcome is DECIDED, not when the run resolves:
  // a fatal throw or the watchdog landing mid-run must still deliver a deny an
  // earlier detector already reached (lateFaultReply).
  const live = missingLoom.slice();
  reached = live;
  reachedEngine = engine;
  const ran = await engine.runDetectorsIsolated(runnable, raw, {
    stopCandidateId,
    deadlineAtMono: t0 + deadlineMs,
    isolation: spec.dispatcher.isolation || "event",
    onOutcome: (i, o) => {
      live[missingLoom.length + i] = applyShadow(o);
    },
  });
  if (ran.abandonedWorkers) hardExit = true;
  // The normal path's application point (onOutcome above fills only the LIVE list a late
  // fault reads): every shadow outcome is gated here, before the starved, incomplete-deny
  // and local-gate steps read it.
  const outcomes = [...missingLoom, ...ran.filter(Boolean).map(applyShadow)];
  // From here a watchdog or fatal reply must still deliver what these reached — and
  // what the repo-owned detectors add (the same array main() merges).
  reached = outcomes;
  // A detector the ENGINE failed to run (its worker could not boot, or died with
  // nothing running) is not a detector that found nothing: at PreToolUse that is
  // the registry-fault blast radius, so it is refused the same way. Converted
  // BEFORE the local-detector gate below, so the gate sees the refusal.
  const engineFaults = outcomes.filter((o) => o.status === "engine-fault");
  const engineNotes = [];
  if (engineFaults.length) {
    const fault = registryFaultReply(
      new Error(`the detector engine failed before running ${engineFaults.map((o) => o.hook).join(", ")}: ${engineFaults[0].stderr.trim()}`),
      payload,
      undefined,
      null,
      // The durable record (recordRegistryFault) names exactly the deny rows that did not run.
      { recordKind: "engine-fault", skipped: engineFaults.filter((o) => o.denyRow === true).map((o) => o.hook) },
    );
    outcomes.push({ hook: "dispatch.js", status: "exit", exitCode: fault.exitCode === 2 ? 2 : 0, stdout: fault.exitCode === 2 ? fault.stdout : "", stderr: fault.exitCode === 2 ? fault.stderr : "" });
    if (fault.exitCode !== 2) engineNotes.push(fault.stderr.replace(/^\[dispatch\] /, ""));
  }
  // STARVED loom detectors: one the EVENT deadline kept from starting (`skipped`) or
  // stopped before its OWN budget ran out (`deadlineCut`) is a guard that could not
  // run — not one that passed. At PreToolUse that is refused like an engine fault
  // (same repair hatch: Read/Grep/Glob and a repair of the loom registry); a note
  // elsewhere — EXCEPT a starved row that declared `on_incomplete: "deny"`: the
  // starved refusal then carries NO hatch (R2 M1; the seat's witness
  // `denyhang-deadlinecut-read rc=0` — a Read past a hanging deny row was ADMITTED
  // because the starved reply is the registry-fault shape, which the hatch
  // admits). A guard that can refuse must not be bypassable by hanging past the
  // event deadline. A detector killed on its OWN budget is not in this list: it
  // keeps the host-kill disposition (contributes nothing) it always had — EXCEPT
  // a row declaring `on_incomplete: "deny"`, whose own-budget overrun is marked
  // by the engine and REFUSED by applyIncompleteDenyRefusals below (R1-F3).
  // A starved SHADOW row is fed, not refused (§ SHADOW ROWS).
  const starved = outcomes.filter((o) => !o.shadowed && (o.status === "skipped" || o.deadlineCut === true));
  if (starved.length) {
    // R2 M1: any starved row that declared `on_incomplete: "deny"` takes the
    // refusal WITHOUT the repair hatch — otherwise hanging a deny row past the
    // event deadline buys a Read/Grep/Glob past it (`denyhang-deadlinecut-read
    // rc=0`). The declaration, not starvation, decides: a starved advisory row
    // keeps the hatch it always had.
    const denyStarved = starved.some((o) => o.denyRow === true);
    const fault = registryFaultReply(
      new Error(
        starved.map((o) => `${o.hook} ${o.status === "skipped" ? "was not started" : "was stopped at the event deadline"}`).join("; "),
      ),
      payload,
      undefined,
      "starved",
      // The durable record (recordRegistryFault) names exactly the starved deny rows.
      { ...(denyStarved ? { hatch: false } : {}), skipped: starved.filter((o) => o.denyRow === true).map((o) => o.hook) },
    );
    outcomes.push({ hook: "dispatch.js", status: "exit", exitCode: fault.exitCode === 2 ? 2 : 0, stdout: fault.exitCode === 2 ? fault.stdout : "", stderr: fault.exitCode === 2 ? fault.stderr : "" });
    if (fault.exitCode !== 2) engineNotes.push(fault.stderr.replace(/^\[dispatch\] /, ""));
  }
  // FAIL-CLOSED FOR INCOMPLETE DENY ROWS (round-6 SEC R1-F3). A row declaring
  // `on_incomplete: "deny"` that did not COMPLETE — it crashed, overran its OWN
  // budget, or exited with anything but 0 or 2, JSON or not (the engine marks exactly
  // those at decision time, hook-engine.js::incompleteDenyReason) — is disposed of by
  // the ONE per-event table (incompleteDenyDisposition): refused at PreToolUse,
  // refused ONCE at Stop / SubagentStop, reported to the model at PostToolUse, allowed
  // LOUDLY elsewhere. The declaration is a cross-lane contract (the registry _doc, the
  // Codex C4 ruling) and its promise is fail-closed; before this, such a row
  // contributed NOTHING and the call ran with a deny-capable guard unrun. Converted
  // BEFORE the local-detector gate below, so the gate sees the refusal.
  applyIncompleteDenyRefusals(outcomes);
  // Repo-owned detectors run only when loom's detectors reached NO verdict a repo
  // detector could not outrank — a deny/block (any shape), a halt, an engine fault
  // or a starved guard (engine.closesLocalGate). A loom ASK does NOT close the gate
  // (round-5 LOW-3): the host ranks deny above ask, so a repo detector's deny must
  // still be evaluated and win — skipping it made a call the repo refuses into a
  // question the user could approve. The ask itself is kept by the merge (and by a
  // late fault: lateFaultReply still counts it via isRestrictive).
  // When they do run, it is under the supervisor, outside this process tree: a
  // local detector that signals its parent, walks the tree, kills its process
  // group or leaves a pipe-holding grandchild reaches the supervisor at most —
  // and a supervisor that dies, overruns or breaks protocol is a LOCAL-REGISTRY
  // FAULT (refused at PreToolUse), never "the repo's detectors found nothing".
  //
  //
  // THE LOCAL REGISTRY IS NOT EVEN READ until loom's verdict exists (round-3 H1):
  // reading, parsing and walking a repo-supplied file is work the repo controls, and
  // any of it done before loom's run could stall this thread — where the watchdog
  // cannot fire — past the host's kill, which drops EVERY verdict. On the restrictive
  // branch it is never read at all (loom's refusal wins whatever it says); a
  // malformed or oversize one is still a local-registry fault, decided here, after
  // loom's run — refused at PreToolUse beside loom's verdict, loud elsewhere.
  //
  // The notes keep the order they had when every row was selected up front: loom's
  // selection notes, the repo's selection notes, then the rest.
  let localFault = null;
  let supervisorFault = null;
  let budgetFault = null;
  // Whether the repo-owned rows the event deadline starved include one that declared
  // `on_incomplete:"deny"` — a guard that can refuse and could not run. Read where the
  // fault becomes a reply, so its refusal carries NO repair hatch (R2 M1).
  let budgetFaultDenyStarved = false;
  let budgetFaultDenyHooks = []; // the starved repo deny rows, for the durable record
  const localSelNotes = [];
  // The repo-local registry's PIN bookkeeping (taken / served / refused) and its
  // add-only and undispatchable-event notices. Its own failures are NOTICES, never
  // refusals — the pin is the dispatcher's bookkeeping, and losing it must not cost the
  // repo its detectors.
  const localPinNotices = [];
  const gateNotes = [];
  const restrictive = engineFaults.length || outcomes.some((o) => engine.closesLocalGate(o, event));
  if (restrictive) {
    if (registryLib.localRegistryPresent(HOOKS_DIR)) {
      gateNotes.push(
        `[dispatch] repo-owned detectors not run: loom's detectors already reached a restrictive verdict on this call (.claude/${registryLib.LOCAL_REGISTRY_BASENAME} was not read)\n`,
      );
    }
  } else {
    // The consumer-owned local registry (target_owned; loom never writes it). A
    // broken one must not silently switch the repo's OWN guards off, so it is
    // reported like a broken loom registry — refused at PreToolUse, loud elsewhere.
    // The text is PINNED to this session's first read (resolveLocalRegistryText), so a row
    // removed or re-pointed mid-session cannot switch a repo guard off under a running
    // session; the pin's own failures are NOTICES, never refusals. The pin is an
    // ACCEPTANCE RECORD: a pin that is gone, replaced or unanchored REFUSES rather than
    // being re-taken (H8's closure 1 — before it, a deleted pin read as "first read" and
    // an edited registry was silently re-pinned, and a self-consistent forgery was served
    // with the note blaming the live file).
    let local = null;
    try {
      const resolvedLocal = registryLib.resolveLocalRegistryText(HOOKS_DIR, sessionId, snapshotChoice);
      if (resolvedLocal.note) localPinNotices.push(`[dispatch] ${resolvedLocal.note}`);
      if (resolvedLocal.notice) localPinNotices.push(`[dispatch] ${resolvedLocal.notice}\n`);
      // Parsed into a LOCAL first: a registry the loader then refuses must not be left
      // installed (`local`), or the refusal would ride beside rows that ran — the
      // collision case measured exactly that (a repo row's own output delivered with the
      // add-only refusal, reading as "the repo's guard ran").
      const parsed = resolvedLocal.text === null ? null : registryLib.parseLocalRegistryText(resolvedLocal.text);
      // ADD-ONLY (typed, loud): a local row naming a hook the template registry dispatches
      // for this event is refused WHOLE — never ignored, never shadowed. `eligible` is
      // passed so a template row THIS TREE does not run (absent file, or loom_only outside
      // loom) shadows nothing: an ineligible loom row must not block the repo's own row of
      // that name (the eligibility-before-de-dup rule above).
      if (parsed) registryLib.assertAddOnly(parsed, reg, { isLive: eligible });
      // The session's pin is taken only over ACCEPTED text: pinning a text this loader
      // refuses would freeze the fault — the operator repairs the file, and the pinned
      // (broken) copy keeps being served for the rest of the session.
      if (resolvedLocal.pinPending) {
        const c = registryLib.commitLocalRegistryPin(resolvedLocal.pinPending);
        if (!c.ok) {
          localPinNotices.push(`[dispatch] ${registryLib.localPinWriteNotice(resolvedLocal.pinPending.pinPath, c.problem)}\n`);
        }
      }
      // Rows for an event this tree's registry does not dispatch can never run: named,
      // with the event, rather than dropped in `withLocal`'s silence.
      if (parsed) {
        for (const e of Object.keys(parsed.events).filter((x) => !reg.events[x])) {
          const rows = parsed.events[e].groups.flatMap((g) => g.hooks.map((h) => registryLib.hookBasename(h.command))).filter(Boolean);
          localSelNotes.push(
            `[dispatch] .claude/${registryLib.LOCAL_REGISTRY_BASENAME} declares ${rows.length} row(s) for ${e} (${rows.join(", ")}), ` +
              `but .claude/hooks/dispatch-registry.json does not dispatch ${e} in this tree — those rows CANNOT run.\n`,
          );
        }
      }
      local = parsed;
    } catch (err) {
      localFault = err;
    }
    const localRows = local ? buildLocalRows(local) : [];
    let lr = null;
    // § THE ROW'S SCOPE — AND WHY SOME ROWS CANNOT RUN IN-PROCESS AT ALL.
    // A worker thread shares THIS process's cwd and cannot change it (`process.chdir` is
    // ERR_WORKER_UNSUPPORTED_OPERATION — MEASURED), and neither `spawn`'s default cwd nor
    // fs relative resolution follows a patched `process.cwd` (also MEASURED: both use the
    // REAL cwd). So an in-process row sees THIS process's directory, while its standalone
    // launch would have seen the SESSION's — the payload's `cwd`. MEASURED on the pinned
    // corpora, that difference is a DENY→ALLOW fail-open: three kailash-py guards refuse
    // standalone in a non-git cwd ("main checkout unidentifiable") and ALLOWED under the
    // adapted path, because the dispatcher's tree IS a git repo and answered their check.
    // The faithful rule is therefore: an in-process row is allowed ONLY when the two
    // directories are the same. A mismatch does not run the row with the wrong scope — it
    // DEMOTES it to the process path, where the supervisor spawns it with the payload's
    // cwd (local-supervisor.js § THE DETECTOR'S SCOPE IS THE PAYLOAD'S), which is exactly
    // what a host launch did. Named loudly: a demotion is a disposition, never a silent
    // downgrade.
    // `require("fs")` per call, as this file does everywhere else — it has no top-level
    // fs binding, and a bare `fs` here throws inside the catch (MEASURED: the helper
    // returned null for BOTH directories, which read as "the scopes match" and silently
    // disabled the whole check — the swallowed-ReferenceError class this lane keeps
    // meeting). A null from a directory that cannot be resolved is now REPORTED, never
    // treated as agreement.
    const canonicalDir = (p) => {
      try {
        return require("fs").realpathSync(p);
      } catch {
        return null;
      }
    };
    const payloadCwd =
      payload && typeof payload.cwd === "string" && payload.cwd && path.isAbsolute(payload.cwd) ? canonicalDir(payload.cwd) : null;
    const processCwd = canonicalDir(process.cwd());
    const inProcScopeOk = payloadCwd === null || processCwd === null || payloadCwd === processCwd;
    // § REPEAT-CRASH DEMOTION (lib/pool-crash-ledger.js). A repo row that has repeatedly
    // ended the pool is run as its own process from now on — the standalone-process path it
    // would have had before the adapter — and the demotion is recorded (a durable ledger
    // plus an audit line) and SAID here, once per event, never silently. It changes WHERE
    // the row runs, never what it decides: the same input yields the same verdict on either
    // side of the boundary (pinned by a fixture).
    const ledger = (() => {
      try {
        return require(path.join(HOOKS_DIR, "lib", "pool-crash-ledger.js"));
      } catch {
        return null;
      }
    })();
    const repoRoot = path.resolve(HOOKS_DIR, "..", "..");
    const demotedRows = [];
    if (ledger) {
      for (const r of localRows) {
        if (r.mode !== "legacy") continue;
        try {
          if (ledger.isDemoted(repoRoot, r.hook)) {
            r.mode = "process";
            demotedRows.push(r.hook);
          }
        } catch {}
      }
      if (demotedRows.length) {
        localSelNotes.push(
          `[dispatch] ${demotedRows.join(", ")}: run as its own PROCESS — this row repeatedly ended the repo pool and has been demoted ` +
            `(recorded in .claude/learning/repo-pool-faults.json; see \`node .claude/hooks/lib/pool-crash-ledger.js --status\`). ` +
            "The verdict is unchanged.\n",
        );
      }
    }
    // The event's repo-owned outcomes, ONE list whatever ran them: a `mode:"legacy"`
    // row runs in this process's own workers, everything else under the supervisor
    // outside the process tree, and the two sets are folded here so every downstream
    // treatment (budget-cut accounting, the merged reply's order, the notes) is
    // identical and each outcome appears EXACTLY ONCE. `legacyOut` is the in-process
    // half only, and is read once, by the ordering merge below.
    // The rows the plan SELECTED, whichever branch planned them: the pool-death marking
    // below needs the planned set, not the reported one (a row the pool never reported has
    // no outcome of its own to be found by).
    let chosenRows = [];
    let localOutcomes = [];
    if (localRows.some((r) => r.match === null)) {
      lr = await runLocalSupervised({ select: { event, value: matchValue, rows: localRows }, cwd: payloadCwd }, raw, t0 + deadlineMs, hostDeadlineAt);
      if (lr.plan) {
        localSelNotes.push(...planNotes(lr.plan));
        // A regex matcher must be decided IN THE SUPERVISOR (a catastrophic-backtracking
        // pattern on the dispatcher's thread would stall it past the host's kill, losing
        // every verdict) — and the supervisor runs the rows it selects. So for THIS
        // event the legacy rows keep their process disposition. Named, never silent:
        // the alternative is a note that says a detector did not run, which would claim
        // something false.
        const held = lr.plan.run.map((k) => localRows[k]).filter((r) => r && r.mode === "legacy");
        if (held.length) {
          localSelNotes.push(
            `[dispatch] ${held.map((r) => r.hook).join(", ")}: a mode:"legacy" row ran as its own PROCESS for this event — ` +
              "the local registry's matchers need a regular expression here, so every local row was decided and run by the " +
              "supervisor. The verdict is unchanged; only the process count is.\n",
          );
        }
      }
      chosenRows = lr && lr.plan ? lr.plan.run.map((k) => localRows[k]).filter(Boolean) : [];
      localOutcomes = lr && Array.isArray(lr.outcomes) ? lr.outcomes.slice() : [];
      if (lr && lr.plan) localOutcomes.push(...missingLocalForPlan(lr.plan));
    } else if (localRows.length) {
      const plan = registryLib.planLocalRows(localRows, localRows.map((r) => r.match));
      localSelNotes.push(...planNotes(plan));
      const chosen = plan.run.map((k) => localRows[k]);
      // § ONE POOL, ONE CHILD, EVERY REPO ROW. The whole selection goes to the pool
      // (lib/local-supervisor.js), which runs the `mode:"legacy"` rows in worker threads of
      // ITS OWN process and the rest as standalone processes — the two-pool split, where
      // the dispatcher's process is the TEMPLATE pool and the pool child is the REPO pool.
      // Running legacy rows HERE instead would put every template verdict the dispatcher
      // already reached behind one repo row's abort/OOM, which no JS-level guard can stop.
      if (chosen.length) lr = await runLocalSupervised({ entries: chosen, cwd: payloadCwd }, raw, t0 + deadlineMs, hostDeadlineAt);
      chosenRows = chosen;
      // The pool reports in registry order (it walks the entries it was given), so its
      // outcome list IS the plan's order; anything it returned for a row the plan did not
      // select is still reported, never dropped.
      localOutcomes = lr && Array.isArray(lr.outcomes) ? lr.outcomes.slice() : [];
      localOutcomes.push(...missingLocalForPlan(plan));
    }
    // § THE FAULT IS RECORDED, AND A ROW THAT KEEPS CAUSING IT IS DEMOTED (see the ledger
    // note above). Recorded for the rows this event actually ASKED the pool to run: a row
    // the plan did not select cannot have ended it.
    if (ledger && lr && lr.fault) {
      try {
        const rec = ledger.recordPoolFault(repoRoot, chosenRows.map((r) => r.hook));
        if (rec.problem) localSelNotes.push(`[dispatch] ${rec.problem}\n`);
        if (rec.demoted.length) {
          localSelNotes.push(
            `[dispatch] ${rec.demoted.join(", ")}: DEMOTED to its own PROCESS — it has ended the repo pool ${ledger.DEMOTE_AFTER} times in ` +
              `${Math.round(ledger.WINDOW_MS / 60000)} minutes. Recorded in .claude/learning/repo-pool-faults.json (+ the .jsonl audit ` +
              "trail); `node .claude/hooks/lib/pool-crash-ledger.js --status` shows it. It runs from the next event on.\n",
          );
        }
      } catch (e) {
        localSelNotes.push(`[dispatch] the crash ledger could not be updated (${(e && e.message) || e}); no row was demoted\n`);
      }
    }
    // § A DEAD POOL IS A SET OF UNRUN ROWS, NOT A SILENCE. The pool is a child process, so
    // it can end without reporting — an abort, an OOM, or a signal (none of which a
    // JS-level guard can stop). Every row the plan SELECTED that the pool never reported
    // gets an outcome saying so; a deny-capable one is then marked incomplete below and
    // REFUSES at PreToolUse. The dispatcher's own (template) verdicts were reached before
    // the pool was ever started and are untouched by its death.
    // BUT A POOL THAT NEVER STARTED IS THE FAULT'S, NOT A SET OF UNRUN ROWS. When the pool
    // could not be launched at all (its file missing or unreadable, a spawn failure) it
    // reports NOTHING, and the disposition the repo already has for that is a
    // LOCAL-REGISTRY fault WITH the repair hatch — the pool file is a repo-owned file an
    // agent must be able to Read to repair it. Marking its rows unrun here instead would
    // hand a default-deny row a hatchless refusal and take that affordance away. The
    // per-row marking below is therefore for a pool that RAN and left rows unreported.
    const poolNeverStarted = !!(lr && lr.fault && lr.launched !== true);
    if (!poolNeverStarted) {
      const reported = new Set(localOutcomes.map((o) => o && o.hook));
      for (const r of chosenRows) {
        if (reported.has(r.hook)) continue;
        localOutcomes.push({
          hook: r.hook,
          status: "engine-fault",
          exitCode: null,
          stdout: "",
          stderr:
            `[dispatch] ${r.hook} did not run: the repo pool ended before it reported. A repo row that ends the pool takes its own ` +
            "rows with it; the template pool's verdicts were already reached and stand.\n",
        });
      }
    }
    // THE SAME PER-ROW INCOMPLETE-EXECUTION CONTRACT TEMPLATE ROWS CARRY, applied to the
    // SUPERVISED repo-owned rows. A repo row is spawned as its own process by the
    // supervisor, so the engine never marks it; without this loop a deny-class repo row
    // that crashed, overran its OWN budget or exited with anything but 0 or 2
    // contributed NOTHING and the call RAN — a repo deny that silently did not happen
    // (H8's FIX 2 class). `onIncompleteOf` normalizes the declaration (only an exact
    // "continue" reads advisory; absent or unrecognized is deny, fail-closed), and the
    // marking uses the ENGINE's own predicate so the two halves cannot drift.
    {
      const denyClass = new Map(localRows.map((r) => [r.hook, r.onIncomplete === "deny"]));
      // Over the WHOLE repo-owned set, not only the pool's reports: a row the pool never
      // reported has no `incompleteDenyReason` shape (its status is the dispatcher's
      // `engine-fault`), so its incompleteness is stated here directly — for a deny row
      // that is the refusal, for a continue row the loud note the outcome already carries.
      for (const o of localOutcomes) {
        if (!o || denyClass.get(o.hook) !== true) continue;
        o.denyRow = true;
        const why = engine.incompleteDenyReason(o);
        if (why) {
          o.incompleteDeny = why;
          o.incompleteKind = engine.incompleteDenyKind(o);
        } else if (o.status === "engine-fault") o.incompleteDeny = "the repo pool ended before it reported";
      }
    }
    // FAIL-CLOSED FOR INCOMPLETE DENY ROWS, repo-owned half. A LEGACY row declaring
    // `on_incomplete:"deny"` is the same contract as a loom row's: it runs in this
    // process's workers, the engine marks its crash / own-budget overrun / non-JSON
    // non-zero exit at decision time (hook-engine.js::incompleteDenyReason), and at
    // PreToolUse that mark REFUSES. Converted HERE rather than by the loom-side call
    // above, which ran before these rows existed; the conversion is applied to a COPY
    // so it cannot double-count a loom row that call already converted.
    if (localOutcomes.some((o) => o && o.incompleteDeny)) {
      const converted = localOutcomes.slice();
      applyIncompleteDenyRefusals(converted);
      localOutcomes = converted;
    }
    // AN ENGINE FAULT ON THE REPO-OWNED HALF IS REFUSED TOO. A worker that dies with
    // NOTHING running is `engine-fault` — the engine's own words: "a detector the engine
    // failed to run is not a detector that found nothing". The loom-side conversion above
    // ran BEFORE these rows existed, so without this a repo row that could not run (or an
    // in-process legacy row whose worker died) merged as silence — a pass. Same
    // disposition as loom's: refused at PreToolUse with the repair hatch, loud elsewhere.
    const localEngineFaults = localOutcomes.filter((o) => o && o.status === "engine-fault");
    if (localEngineFaults.length) {
      const fault = registryFaultReply(
        new Error(
          `the detector engine failed before running ${localEngineFaults.map((o) => o.hook).join(", ")}: ${String(localEngineFaults[0].stderr || "").trim()}`,
        ),
        payload,
        registryLib.LOCAL_REGISTRY_BASENAME,
        null,
        // The durable record (recordRegistryFault) names exactly the repo deny rows that did not run.
        { recordKind: "local-engine-fault", skipped: localEngineFaults.filter((o) => o.denyRow === true).map((o) => o.hook) },
      );
      outcomes.push({ hook: "dispatch.js", status: "exit", exitCode: fault.exitCode === 2 ? 2 : 0, stdout: fault.exitCode === 2 ? fault.stdout : "", stderr: fault.exitCode === 2 ? fault.stderr : "" });
      if (fault.exitCode !== 2) localSelNotes.push(fault.stderr.replace(/^\[dispatch\] /, ""));
    }
    // Tagged IN PLACE (the same objects other code below reads): a repo-owned row can never
    // be taken for a loom row by name — lib/session-start-budget.js::isSeedSection and
    // stopBoundaryCommit both key on loom's producer.
    for (const o of localOutcomes) if (o && typeof o === "object") o.origin = "local";
    if (localOutcomes.length) outcomes.push(...localOutcomes);
    {
      // A supervisor fault is the SUPERVISOR's: an in-process legacy row cannot produce
      // one (the engine reports its own faults per row, above).
      if (lr) supervisorFault = lr.fault || null;
      // BUDGET MODEL (round-3 M1): the dispatcher's timeout is sized from LOOM's rows
      // only; repo-owned detectors get what loom's run left of the event deadline. A
      // repo detector that could not start before that deadline (`skipped`), or was
      // killed AT it (`deadlineCut` — its own timeout had not expired), is a guard
      // that could not run, not one that passed: a local-registry fault, refused at
      // PreToolUse (same repair hatch), a note elsewhere. A repo detector killed on
      // its OWN timeout keeps the host-kill disposition (contributes nothing, not a
      // refusal) — and is named in a note, as the host named a timed-out hook.
      // Both runners' outcomes are counted here: an in-process legacy row starved by
      // the EVENT deadline is the same "could not run" fact as a supervised one.
      const cut = localOutcomes.filter((o) => o.status === "skipped" || o.deadlineCut);
      if (cut.length) {
        budgetFault = new Error(
          `the event's time budget ran out before this repo's own detectors could finish — ${cut
            .map((o) => `${o.hook} ${o.status === "skipped" ? "was not started" : "was killed at the event deadline"}`)
            .join("; ")} (the dispatcher's timeout for ${event} is sized from loom's detectors; repo-owned ones get only what remains)`,
        );
        // THE DECLARATION TRAVELS HERE TOO (R2 M1, the same rule the loom side applies):
        // a starved row that declared `on_incomplete:"deny"` is a guard that can REFUSE
        // and could not run, so its refusal must NOT carry the repair hatch — otherwise
        // hanging a repo-owned deny row past the event deadline buys a Read/Grep/Glob
        // past it. MEASURED by the correctness review: identical fixtures, the local half
        // exited 0 with the hatch open where the loom half refused with no hatch. The
        // engine marks `denyRow` on every outcome of a deny row; before this lane the
        // declaration was not even forwarded to a local row, so forwarding it is what
        // makes reading it here necessary.
        budgetFaultDenyStarved = cut.some((o) => o && o.denyRow === true);
        budgetFaultDenyHooks = cut.filter((o) => o && o.denyRow === true).map((o) => o.hook);
      }
      // A repo detector killed on ITS OWN timeout: the host-kill disposition
      // (contributes nothing), named in a note as the host named a timed-out hook.
      // A legacy row's budget is the engine's own timer, so it carries no `budgetMs`.
      for (const o of localOutcomes) {
        if (o.status === "timeout" && !o.deadlineCut) {
          gateNotes.push(
            `[dispatch] repo-owned detector ${o.hook} exceeded its own timeout${Number.isFinite(o.budgetMs) ? ` (${o.budgetMs} ms)` : ""} and was killed; it contributed nothing\n`,
          );
        }
      }
    }
  }
  const localNotes = [...loomNotes, ...localSelNotes, ...engineNotes, ...gateNotes];
  // NOTICES — about the dispatcher's own state, not about a detector that did not
  // run; said under their own heading (round-7 review LOW-2), never under the NOTES
  // heading, which would claim detectors were skipped when every one ran.
  //   - pinNote (a kept copy of the pinned registry is serving because the file on
  //     disk is gone or changed): on EVERY event while it lasts — it is a live fault
  //     (a new session cannot start its detectors) and each event is a chance to fix it.
  //   - pinNotice (the session has NO kept copy): at SessionStart, PLUS every event
  //     when the notice is about a condition the session RETRIES per event
  //     (`noticeEveryEvent`, i.e. the copy could not be written or could not be
  //     placed). It is a hazard, not a fault: nothing is wrong until the registry is
  //     also deleted or changed mid-session. For the UNUSABLE-DIRECTORY kind the
  //     SessionStart-only rule stands, and for its own reason: at that point the
  //     refusal itself names the unusable directory (resolvePinnedRegistryText's
  //     error), so SessionStart — once per session start (startup / resume / clear /
  //     compact), when fixing the directory still helps — is where it is actionable,
  //     and repeating it on every tool call adds context and no information. That
  //     reason does NOT hold for the write kind: there the directory is perfectly
  //     usable, no later refusal names anything, and the copy is retried on every
  //     event — so it is said on every event, and goes quiet the moment one succeeds.
  const notices = [];
  // HOOK OUTPUT ECONOMY (journal/0661) — the "registry CHANGED on disk" pinNote is said
  // ONCE PER SESSION, not on every event. MEASURED: 771 firings / 291 KB of ONE
  // identical text in the loom transcripts. It is not a fault for THIS session (the
  // pinned copy serves and every detector ran); it only tells the operator a restart
  // applies the change, which one statement does. The "cannot be read" pinNote is a
  // LIVE fault (a new session could not start its detectors) and keeps its
  // every-event cadence. Notice TEXT only — no refusal, deny or fail-closed path reads
  // `notices`. Any failure of the once-state emits (fail open).
  if (pinNote) {
    let say = true;
    if (sessionId && pinNote.startsWith(PIN_CHANGED_NOTE_PREFIX)) {
      try {
        const once = require(path.join(HOOKS_DIR, "lib", "session-once.js"));
        const repoDir = path.resolve(HOOKS_DIR, "..", "..");
        const v = once.shouldEmit({ repoDir, sessionId, channel: "dispatch-pin-changed", text: pinNote, mode: "once" });
        say = v.emit;
        if (v.emit && v.reason !== "state-unavailable")
          once.recordEmission({ repoDir, sessionId, channel: "dispatch-pin-changed", sig: v.sig });
      } catch {
        say = true;
      }
    }
    if (say) notices.push(pinNote);
  }
  if (pinNotice && (pinNoticeEvery || event === "SessionStart")) notices.push(pinNotice);
  notices.push(...localPinNotices);
  if (eligible.repoClass === "unreadable" && eligible.ranLoomOnlyUnreadable.length) {
    localNotes.push(
      `.claude/VERSION is unreadable, so this tree could not be told apart from loom; these loom_only detectors were RUN anyway (enforcement side): ${[...new Set(eligible.ranLoomOnlyUnreadable)].join(", ")}. Restore .claude/VERSION.\n`,
    );
  }
  for (const lf of [localFault, supervisorFault, budgetFault]) {
    if (!lf) continue;
    const fault =
      lf === budgetFault && budgetFaultDenyStarved
        ? registryFaultReply(lf, payload, registryLib.LOCAL_REGISTRY_BASENAME, "starved", { hatch: false, skipped: budgetFaultDenyHooks })
        : lf === budgetFault
          ? registryFaultReply(lf, payload, registryLib.LOCAL_REGISTRY_BASENAME, null, { recordKind: "starved", skipped: budgetFaultDenyHooks })
          : registryFaultReply(lf, payload, registryLib.LOCAL_REGISTRY_BASENAME);
    outcomes.push({ hook: registryLib.LOCAL_REGISTRY_BASENAME, status: "exit", exitCode: fault.exitCode === 2 ? 2 : 0, stdout: fault.exitCode === 2 ? fault.stdout : "", stderr: fault.exitCode === 2 ? fault.stderr : "" });
    if (fault.exitCode !== 2) localNotes.push(fault.stderr.replace(/^\[dispatch\] /, ""));
  }
  if (localNotes.length || notices.length) {
    // Said to the agent, not buried on stderr: a repo guard that silently did not
    // run reads exactly like one that ran and passed.
    const text =
      (localNotes.length ? "HOOK DISPATCHER NOTES (detectors that did not run as registered):\n" + localNotes.join("") : "") +
      (notices.length ? "HOOK DISPATCHER NOTICE (about the dispatcher itself; the detectors registered for this event ran):\n" + notices.join("") : "");
    if (event === "PreCompact") {
      // PreCompact reads raw stdout as compaction INSTRUCTIONS and shows only a
      // FAILED hook's stderr, so the notes are a `notice` the merge places itself:
      // the reply's failure when nothing else was said, beside a block's text, or a
      // delimited block after the instructions (hook-engine.js::mergePreCompact) —
      // never an exit-0 stderr nobody sees.
      outcomes.push({ hook: "dispatch.js", status: "exit", exitCode: 1, notice: true, stdout: "", stderr: text });
    } else if (event === "SessionEnd") {
      // SessionEnd never reads stdout and prints a failed member's stderr: non-zero.
      outcomes.push({ hook: "dispatch.js", status: "exit", exitCode: 1, stdout: "", stderr: text });
    } else {
      // Stop/SubagentStop: systemMessage (additionalContext there would CONTINUE the turn).
      const json = ["Stop", "SubagentStop"].includes(event)
        ? { continue: true, systemMessage: text }
        : { continue: true, hookSpecificOutput: { hookEventName: event, additionalContext: text } };
      outcomes.push({ hook: "dispatch.js", status: "exit", exitCode: 0, stdout: JSON.stringify(json) + "\n", stderr: "" });
    }
  }

  if (process.env.COC_DISPATCH_TRACE === "1") {
    realErr(
      "[dispatch-trace] " +
        JSON.stringify(outcomes.map((o) => ({ hook: o.hook, status: o.status, exit: o.exitCode }))) +
        ` ${Math.round(monoNow() - t0)}ms\n`,
    );
  }
  const merged = engine.mergeOutcomes(event, sessionStartBudget(event, outcomes, payload, sessionId));
  merged.findingsContext = engine.deliveryContext(raw);
  stopCommit = stopBoundaryCommit(event, outcomes, merged, payload, { candidateId: stopCandidateId });
  return finish(merged);
}

/**
 * Stop only — THE BOUNDARY COMMIT (context-cycle H1). `context-boundary.js` (a Stop row,
 * running BEFORE the merge) writes only a CANDIDATE; readiness becomes true here, after
 * EVERY Stop verdict — loom's and the repo's — has been merged, and only when the merged
 * reply really lets the turn END:
 *   - exit 0 with a JSON reply that neither blocks (`decision:"block"`) nor halts
 *     (`continue:false`), and no detector failed, timed out, was starved or faulted;
 *   - the payload is not a `stop_hook_active` re-invocation (a turn some guard refused);
 *   - the context-boundary row itself completed in THIS dispatch, and the candidate it left
 *     carries `candidateId` — the id main() minted for THIS Stop — and this Stop's session.
 * A commit covers ONLY this dispatcher's rows: Stop hooks registered outside it can still
 * block afterwards, so a committed ready is valid for a consumer only once Claude Code's
 * clean stop_hook_summary lands (lib/context-state.js::boundaryReadyValid / stopFinished).
 * Anything else records the refusal (ready stays false). A fault before this point never
 * reaches it — the watchdog / fatal paths finish without a commit — so the candidate is
 * never committed: fail CLOSED. Never throws; problems go to stderr.
 */
function stopBoundaryCommit(ev, outcomes, merged, payload, { candidateId = null } = {}) {
  if (ev !== "Stop") return null;
  if (!payload || typeof payload !== "object" || (typeof payload.agent_id === "string" && payload.agent_id)) return null;
  try {
    const engine = require(path.join(HOOKS_DIR, "lib", "hook-engine.js"));
    const list = Array.isArray(outcomes) ? outcomes : [];
    const row = list.find((o) => o && o.hook === "context-boundary.js" && o.origin !== "local");
    if (!row || !(row.status === "exit" || row.status === "return") || row.exitCode !== 0) return null; // no candidate this Stop
    const why = [];
    if (payload.stop_hook_active === true) why.push("stop_hook_active re-invocation");
    if (!merged || merged.exitCode !== 0) why.push(`merged exit ${merged ? merged.exitCode : "none"}`);
    const j = merged ? engine.parseJson(merged.stdout) : null;
    if (!j) why.push("no JSON reply");
    else {
      if (j.decision === "block") why.push("a Stop guard blocked");
      if (j.continue === false) why.push("a detector halted");
    }
    const bad = list.filter((o) => o && (o.status === "timeout" || o.status === "skipped" || o.status === "engine-fault" || o.deadlineCut === true || o.incompleteDeny || engine.isFailure(o) || o.exitCode === 2));
    if (bad.length) why.push(`detector(s) did not complete cleanly: ${bad.map((o) => o.hook).slice(0, 6).join(", ")}`);
    const CS = require(path.join(HOOKS_DIR, "lib", "context-state.js"));
    const cwd = (typeof payload.cwd === "string" && payload.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const loc = CS.locateState({ configDir: process.env.CLAUDE_CONFIG_DIR, repoDir: cwd, pid: process.ppid });
    if (!loc.ok) {
      realErr(`[dispatch] boundary NOT committed: ${loc.reason}\n`);
      return null;
    }
    const r = CS.commitStopReadiness(loc, {
      endsTurn: why.length === 0,
      why: why.join("; "),
      nowIso: new Date().toISOString(),
      candidateId,
      sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
    });
    if (!r.ok) realErr(`[dispatch] boundary commit failed (${r.reason}); readiness stays false\n`);
    return r;
  } catch (e) {
    try {
      realErr(`[dispatch] boundary commit threw (${(e && e.message) || e}); readiness stays false\n`);
    } catch {}
    return null;
  }
}

/**
 * SessionStart only: seed first and the merged additionalContext ≤ 9,500 chars
 * (lib/session-start-budget.js — CYCLE.md M11: a longer string is persisted to a file and
 * the model sees a 2 KB preview, which is how the compaction handoff went dark). Fails
 * OPEN to the unbudgeted outcomes, LOUDLY on stderr: the budget only reorders and moves
 * context text, and no refusal exists at SessionStart for it to lose.
 */
function sessionStartBudget(ev, outcomes, payload, sessionId) {
  if (ev !== "SessionStart") return outcomes;
  try {
    const B = require(path.join(HOOKS_DIR, "lib", "session-start-budget.js"));
    const { SEED_SENTINEL } = require(path.join(HOOKS_DIR, "lib", "boundary-seed.js"));
    const repoDir = (payload && typeof payload.cwd === "string" && payload.cwd) || path.resolve(HOOKS_DIR, "..", "..");
    const nowIso = new Date().toISOString();
    const r = B.applySessionStartBudget(outcomes, {
      sentinel: SEED_SENTINEL,
      writeOverflow: B.makeOverflowWriter({ repoDir, sessionId, source: payload && payload.source, nowIso }),
    });
    if (r.report.error) realErr(`[dispatch] SessionStart overflow NOT saved (${r.report.error}); ${r.report.moved} section(s) were dropped from this start\n`);
    return r.outcomes;
  } catch (e) {
    realErr(`[dispatch] SessionStart budget not applied (${(e && e.message) || e}); the merged context may exceed the inline limit\n`);
    return outcomes;
  }
}

/**
 * Start the dispatch in THIS process. Called by the bootstrap (dispatch.js) when it
 * is the process's main module — never on require, which must not change its
 * host's process. `opts.t0`: the monotonic instant the bootstrap started.
 *
 * RETURNS the completion record (round-8 SEC HIGH-1) — the affirmative answer the
 * bootstrap requires in place of the old "the body loaded and exports a start()"
 * check, which a body that answers nothing satisfied. Read its doc for the fields.
 */
function start(opts = {}) {
  if (opts && typeof opts.t0 === "number" && Number.isFinite(opts.t0)) t0 = opts.t0;
  // The receipt's attempt instant: the wall clock back-dated to the bootstrap's start.
  attemptedAtMs = Date.now() - Math.max(0, monoNow() - t0);
  // An unexpected throw anywhere in main() loses the merge of every verdict reached
  // so far, the registry-fault blast radius: it takes the SAME disposition as the
  // header and the watchdog — refused at PreToolUse (with the repair hatch, which
  // admits a call only when no detector had already refused it — lateFaultReply),
  // loud (a non-JSON exit 1) everywhere else.
  const fatal = (err) => {
    // A Stop's per-attempt receipt is skipped on this path (stopReceiptSkipReason).
    stopLateFault = "fatal";
    try {
      finish(lateFaultReply(new Error(`fatal: ${err && err.stack ? err.stack : err}`), "fatal"));
    } catch {
      // Even the reply could not be built: exit 2 is still a refusal at PreToolUse
      // (the host shows the stderr), and a non-JSON exit 1 is loud elsewhere — at a
      // NAMED event loom's registry lists. An event nobody named, or one the registry
      // does not list, takes the refusal too (eventIsUnknown; a throw while deciding
      // that is the same unknown, so it refuses).
      try {
        realErr(`[dispatch] fatal while dispatching ${event}: ${err && err.message ? err.message : err}\n`);
      } catch {}
      let unknown = true;
      try {
        unknown = eventIsUnknown();
      } catch {}
      const code = event === "PreToolUse" || unknown ? 2 : 1;
      // A bare exit IS this process's answer — the refusal is the code itself. The
      // record must say so, or the bootstrap's exit check would refuse a call the
      // dispatcher had already refused, and report the wrong cause for it.
      completion.emitted = true;
      realExit(code);
    }
  };
  // A throw OUTSIDE main()'s promise chain — inside an event handler (the
  // supervisor channel's 'data' / 'exit' / 'close', a timer) or an 'error' event
  // with no listener — would otherwise end node with exit 1: a non-blocking error,
  // i.e. the call RUNS at PreToolUse with every verdict lost (round-3 L1). Both
  // escape routes take the fatal disposition. Installed only here, in the
  // dispatcher's own process (start() is called by the bootstrap only when it is the
  // main module): the engine's worker threads have their own handling, and requiring
  // this file as a module must not change its host's process.
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  // The record is affirmative from here: this module owns the event's reply. `event`
  // is refreshed from the payload in main(); until then the argv one is what the
  // bootstrap would have used anyway.
  completion.ran = true;
  completion.event = completion.event || event || null;
  main().catch(fatal);
  return completion;
}

// `readAllStdin` and the two budget constants are exported for their suite
// (`tests/dispatch-stdin-bound.test.mjs`), which drives the REAL reader in a child
// on a real pipe — the bound is only observable end-to-end, and the constants are
// what that suite pins against the Codex runtime's. STDIN_MAX_BYTES is a GETTER over the
// bootstrap's own constant (stdinMaxBytes) — the same value, never a second copy.
// INCOMPLETE_DENY_POLICY / incompleteDenyDisposition carry the fail-closed lane's export
// names, so the landing resolve replaces them with that lane's single source.
// HOST_EVENT_NAMES is the ONE fixed set eventIsUnknown decides against (engine-w1 R2-F3).
module.exports = { main, start, registryFaultReply, lateFaultReply, askAsDeny, runLocalSupervised, PIN_CHANGED_NOTE_PREFIX, sessionStartBudget, stopBoundaryCommit, readAllStdin, STDIN_READ_TIMEOUT_MS, incompleteDenyDisposition, INCOMPLETE_DENY_POLICY, HOST_EVENT_NAMES };
Object.defineProperty(module.exports, "STDIN_MAX_BYTES", { enumerable: true, get: stdinMaxBytes });
