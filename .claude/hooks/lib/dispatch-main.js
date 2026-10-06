/**
 * lib/dispatch-main.js — the hook dispatcher's BODY, started by the bootstrap
 * `.claude/hooks/dispatch.js <Event>` (the file settings.json names). ONE process per
 * hook event.
 *
 * WHY A BOOTSTRAP (round-6 SEC MEDIUM-1). Every event's guards run behind this one
 * dispatcher, so a syntax error or a deleted file here would make node exit 1 before
 * any handler below is installed — at PreToolUse a NON-blocking error, i.e. every
 * call runs with zero guards. The bootstrap is a small (~250-line), builtins-only file,
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
 * against the payload field the host matches at that event), runs each
 * IN-PROCESS under `lib/hook-engine.js` — one after another in registry order, or
 * all at once where the registry says `isolation: "parallel"` (SessionEnd) — and
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
 *     hook-engine.js § FAILED DETECTORS. That is a detector killed on its OWN
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
function finish({ stdout, stderr, exitCode }) {
  if (finishing) return; // one reply per event (the watchdog may race the normal path)
  finishing = true;
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
    try {
      realOut(stdout || "", end);
    } catch {
      end();
    }
  };
  try {
    if (stderr) return realErr(stderr, writeOut);
  } catch {}
  writeOut();
}

function readAllStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    const s = process.stdin;
    if (!s || s.isTTY) return resolve("");
    s.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    s.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    s.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
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
function repairHatch(payload, file) {
  try {
    return require(path.join(HOOKS_DIR, "dispatch.js")).repairHatch(payload, [file], { edit: true }) === true;
  } catch {
    return false;
  }
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
      resolve({ outcomes, plan, fault: new Error(`the supervisor running this repo's own detectors ${why}${tail} — ${lost}`) });
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
      const opts = { stdio: ["ignore", "pipe", "pipe", "pipe"], cwd: process.cwd(), env: process.env, windowsHide: true };
      launcher =
        process.platform === "win32"
          ? spawn(process.execPath, [SUPERVISOR_FILE], opts)
          : spawn("/bin/sh", ["-c", LAUNCHER_SHELL, process.execPath, SUPERVISOR_FILE], { ...opts, detached: true });
    } catch (e) {
      return fault(`could not be started (${e && e.message ? e.message : e})`);
    }
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
    const slim = (e) => ({ hook: e.hook, file: e.file, timeoutMs: e.timeoutMs });
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
// The outcomes this event has produced so far (loom's, then any repo-owned ones —
// the SAME array main() merges) and the engine that judges them. Read by the two
// replies built OUTSIDE main()'s normal return — the watchdog and the fatal
// handler — so a verdict already reached is never dropped by them (lateFaultReply).
let reached = [];
let reachedEngine = null;

// `file` is relative to .claude/. `kind` — null: a registry fault (`file` names
// which registry); "fatal": dispatch.js itself threw after it started dispatching;
// "stall": dispatch.js did not finish inside its budget (the watchdog). For the
// last two the hatch is the loom registry's (Read/Grep/Glob stay available to
// diagnose). `opts.hatch: false` refuses even a call the hatch would admit.
function registryFaultReply(err, payload, file = "hooks/dispatch-registry.json", kind = null, opts = {}) {
  const why = err && err.message ? err.message : err;
  const dispatcherFault = kind === "fatal" || kind === "stall";
  const starved = kind === "starved";
  const msg =
    starved
      ? `dispatch.js ran out of the time budget for ${event} before loom's own detectors could finish (${why}). ` +
        `A guard that could not run has not passed.`
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
  if (event === "PreToolUse") {
    if (opts.hatch === false || !repairHatch(payload, file)) {
      const allowed =
        `Read/Grep/Glob, an Edit/Write of .claude/${file}, and an exact \`git checkout -- .claude/${file}\` / \`git restore\` of it are still allowed ` +
        "(unless a guard had already refused the call before the fault).\n";
      const reason =
        "STOP — Tool call blocked.\n\nWHAT HAPPENED: " + msg +
        "\nWHY: " +
        (starved
          ? "loom's guards did not all run on this call, so it cannot be vetted. "
          : dispatcherFault
          ? "the dispatcher failed part-way, so the guards' verdicts on this call are not all known and it cannot be vetted. "
          : file === "hooks/dispatch-registry.json"
          ? "with that registry unreadable no guard can run, so this call cannot be vetted. "
          : "this repo's own guards could not run, so this call cannot be fully vetted. ") +
        "Refusing is the fail-closed disposition.\n\n" +
        "REPORT TO USER (do not skip any):\n" +
        (starved
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
            allowed);
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
  // host shows the stderr to the user as a hook error.
  return {
    stdout: "",
    stderr: `[dispatch] ${msg} ${dispatcherFault ? `No verdict of the detectors for ${event} was delivered.` : `Detectors for ${event} did NOT run.`}\n`,
    exitCode: 1,
  };
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
  try {
    verdicts = reached.filter((o) => o && reachedEngine.isRestrictive(o, event));
  } catch {}
  if (verdicts && !verdicts.length) return fault; // nothing refused ⇒ the fault reply (hatch included) stands
  if (event !== "PreToolUse") {
    if (!verdicts) {
      // Unjudgeable: the stricter reading wherever a refusal exists.
      if (event === "SessionStart" || event === "SessionEnd") return fault;
      const extra = `${fault.stderr.trim()} The dispatcher could not judge the detectors' verdicts, so every one reached is delivered as a refusal.`;
      try {
        return reachedEngine.restrictiveReply(event, reached.filter(Boolean), extra);
      } catch {}
      return { stdout: "", stderr: fault.stderr, exitCode: 2 };
    }
    const faultOutcome = { hook: "dispatch.js", status: "exit", exitCode: 1, stdout: "", stderr: fault.stderr, ...(event === "PreCompact" ? { notice: true } : {}) };
    try {
      return reachedEngine.mergeOutcomes(event, [...verdicts, faultOutcome]);
    } catch {}
    try {
      return reachedEngine.restrictiveReply(event, verdicts, fault.stderr);
    } catch {}
    return { stdout: "", stderr: fault.stderr, exitCode: 2 };
  }
  const refusal = registryFaultReply(err, hostPayload, undefined, kind, { hatch: false });
  if (verdicts) {
    try {
      return reachedEngine.mergeOutcomes(event, [...verdicts.map(askAsDeny), { hook: "dispatch.js", status: "exit", exitCode: 2, stdout: refusal.stdout, stderr: refusal.stderr }]);
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

async function main() {
  const raw = await readAllStdin();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
  hostPayload = payload;
  if (!event && payload && typeof payload.hook_event_name === "string") event = payload.hook_event_name;
  completion.event = event || null; // for the bootstrap's exit check, which reads only the record

  let registryLib;
  let engine;
  let reg;
  let pinNote = null;
  let pinNotice = null;
  let pinNoticeEvery = false;
  try {
    registryLib = require(path.join(HOOKS_DIR, "lib", "dispatch-registry.js"));
    engine = require(path.join(HOOKS_DIR, "lib", "hook-engine.js"));
    if (pinArg !== null && !/^[0-9a-f]{64}$/.test(pinArg)) throw new Error("malformed --registry-sha256 argument");
    const resolved = registryLib.resolvePinnedRegistryText(
      HOOKS_DIR,
      pinArg,
      registryLib.snapshotDirChoice(process.env),
    );
    reg = registryLib.parseRegistryText(resolved.text);
    pinNote = resolved.note;
    pinNotice = resolved.notice || null;
    pinNoticeEvery = resolved.noticeEveryEvent === true;
    if (!reg.events[event]) throw new Error(`no event ${JSON.stringify(event)} in the registry`);
    // The worker opens the event's shared git context; fail here (closed, at
    // PreToolUse) if the pieces it needs are not in this tree.
    require.resolve(path.join(HOOKS_DIR, "lib", "event-git.js"));
    require.resolve(path.join(HOOKS_DIR, "lib", "hook-engine-worker.js"));
  } catch (err) {
    return finish(registryFaultReply(err, payload));
  }

  const spec = reg.events[event];
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
  // An unparseable payload names no tool; run every detector and let each handle
  // the malformed input the way it always did. A payload WITHOUT the match field
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
  for (const d of registryLib.detectorsFor(reg, event)) {
    if (!matchAll && !engine.matcherMatches(d.matcher, matchValue, event)) continue;
    // Eligibility BEFORE de-duplication: a loom row this tree does not run (absent,
    // or loom_only outside loom) must not shadow the repo's own row of that name.
    if (!eligible(d.hook)) {
      if (!fsExists(path.join(HOOKS_DIR, d.hook)) && (eligible.repoClass === "loom" || eligible.repoClass === "unreadable")) {
        // In loom itself every registered detector must exist; a missing one is a
        // guard that silently stopped running (a consumer legitimately lacks some).
        loomNotes.push(`[dispatch] dispatch-registry.json names ${d.hook}, which is not in .claude/hooks/ — NOT run\n`);
      }
      continue;
    }
    if (seen.has(d.hook)) continue;
    seen.add(d.hook);
    runnable.push({ hook: d.hook, file: path.join(HOOKS_DIR, d.hook), timeoutMs: budgetOf(d), mode: d.mode, origin: "loom" });
  }

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
  // A local row's `mode` is accepted and ignored: repo-owned detectors always run
  // as their own processes under the supervisor, outside this process tree.
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
    }));
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
  // `reached` is filled as each loom outcome is DECIDED, not when the run resolves:
  // a fatal throw or the watchdog landing mid-run must still deliver a deny an
  // earlier detector already reached (lateFaultReply).
  const live = [];
  reached = live;
  reachedEngine = engine;
  const ran = await engine.runDetectorsIsolated(runnable, raw, {
    deadlineAtMono: t0 + deadlineMs,
    isolation: spec.dispatcher.isolation || "event",
    onOutcome: (i, o) => {
      live[i] = o;
    },
  });
  if (ran.abandonedWorkers) hardExit = true;
  const outcomes = ran.filter(Boolean);
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
    );
    outcomes.push({ hook: "dispatch.js", status: "exit", exitCode: fault.exitCode === 2 ? 2 : 0, stdout: fault.exitCode === 2 ? fault.stdout : "", stderr: fault.exitCode === 2 ? fault.stderr : "" });
    if (fault.exitCode !== 2) engineNotes.push(fault.stderr.replace(/^\[dispatch\] /, ""));
  }
  // STARVED loom detectors: one the EVENT deadline kept from starting (`skipped`) or
  // stopped before its OWN budget ran out (`deadlineCut`) is a guard that could not
  // run — not one that passed. At PreToolUse that is refused like an engine fault
  // (same repair hatch: Read/Grep/Glob and a repair of the loom registry); a note
  // elsewhere. A detector killed on its OWN budget is not in this list: it keeps the
  // host-kill disposition (contributes nothing, never a refusal) it always had.
  const starved = outcomes.filter((o) => o.status === "skipped" || o.deadlineCut === true);
  if (starved.length) {
    const fault = registryFaultReply(
      new Error(
        starved.map((o) => `${o.hook} ${o.status === "skipped" ? "was not started" : "was stopped at the event deadline"}`).join("; "),
      ),
      payload,
      undefined,
      "starved",
    );
    outcomes.push({ hook: "dispatch.js", status: "exit", exitCode: fault.exitCode === 2 ? 2 : 0, stdout: fault.exitCode === 2 ? fault.stdout : "", stderr: fault.exitCode === 2 ? fault.stderr : "" });
    if (fault.exitCode !== 2) engineNotes.push(fault.stderr.replace(/^\[dispatch\] /, ""));
  }
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
  const localSelNotes = [];
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
    let local = null;
    try {
      local = registryLib.loadLocalRegistryIfPresent(HOOKS_DIR);
    } catch (err) {
      localFault = err;
    }
    const localRows = local ? buildLocalRows(local) : [];
    let lr = null;
    if (localRows.some((r) => r.match === null)) {
      lr = await runLocalSupervised({ select: { event, value: matchValue, rows: localRows } }, raw, t0 + deadlineMs, hostDeadlineAt);
      if (lr.plan) localSelNotes.push(...planNotes(lr.plan));
    } else if (localRows.length) {
      const plan = registryLib.planLocalRows(localRows, localRows.map((r) => r.match));
      localSelNotes.push(...planNotes(plan));
      if (plan.run.length) lr = await runLocalSupervised({ entries: plan.run.map((k) => localRows[k]) }, raw, t0 + deadlineMs, hostDeadlineAt);
    }
    if (lr) {
      outcomes.push(...lr.outcomes);
      supervisorFault = lr.fault || null;
      // BUDGET MODEL (round-3 M1): the dispatcher's timeout is sized from LOOM's rows
      // only; repo-owned detectors get what loom's run left of the event deadline. A
      // repo detector that could not start before that deadline (`skipped`), or was
      // killed AT it (`deadlineCut` — its own timeout had not expired), is a guard
      // that could not run, not one that passed: a local-registry fault, refused at
      // PreToolUse (same repair hatch), a note elsewhere. A repo detector killed on
      // its OWN timeout keeps the host-kill disposition (contributes nothing, not a
      // refusal) — and is named in a note, as the host named a timed-out hook.
      const cut = lr.outcomes.filter((o) => o.status === "skipped" || o.deadlineCut);
      if (cut.length) {
        budgetFault = new Error(
          `the event's time budget ran out before this repo's own detectors could finish — ${cut
            .map((o) => `${o.hook} ${o.status === "skipped" ? "was not started" : "was killed at the event deadline"}`)
            .join("; ")} (the dispatcher's timeout for ${event} is sized from loom's detectors; repo-owned ones get only what remains)`,
        );
      }
      for (const o of lr.outcomes) {
        if (o.status === "timeout" && !o.deadlineCut) {
          gateNotes.push(`[dispatch] repo-owned detector ${o.hook} exceeded its own timeout (${o.budgetMs} ms) and was killed; it contributed nothing\n`);
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
  if (pinNote) notices.push(pinNote);
  if (pinNotice && (pinNoticeEvery || event === "SessionStart")) notices.push(pinNotice);
  if (eligible.repoClass === "unreadable" && eligible.ranLoomOnlyUnreadable.length) {
    localNotes.push(
      `.claude/VERSION is unreadable, so this tree could not be told apart from loom; these loom_only detectors were RUN anyway (enforcement side): ${[...new Set(eligible.ranLoomOnlyUnreadable)].join(", ")}. Restore .claude/VERSION.\n`,
    );
  }
  for (const lf of [localFault, supervisorFault, budgetFault]) {
    if (!lf) continue;
    const fault = registryFaultReply(lf, payload, registryLib.LOCAL_REGISTRY_BASENAME);
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
  return finish(engine.mergeOutcomes(event, outcomes));
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
  // An unexpected throw anywhere in main() loses the merge of every verdict reached
  // so far, the registry-fault blast radius: it takes the SAME disposition as the
  // header and the watchdog — refused at PreToolUse (with the repair hatch, which
  // admits a call only when no detector had already refused it — lateFaultReply),
  // loud (a non-JSON exit 1) everywhere else.
  const fatal = (err) => {
    try {
      finish(lateFaultReply(new Error(`fatal: ${err && err.stack ? err.stack : err}`), "fatal"));
    } catch {
      // Even the reply could not be built: exit 2 is still a refusal at PreToolUse
      // (the host shows the stderr), and a non-JSON exit 1 is loud elsewhere.
      try {
        realErr(`[dispatch] fatal while dispatching ${event}: ${err && err.message ? err.message : err}\n`);
      } catch {}
      const code = event === "PreToolUse" ? 2 : 1;
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

module.exports = { main, start, registryFaultReply, lateFaultReply, askAsDeny };
