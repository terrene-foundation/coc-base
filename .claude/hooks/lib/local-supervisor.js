#!/usr/bin/env node
/**
 * local-supervisor — runs the REPO-OWNED detectors (the consumer's
 * `.claude/dispatch-registry.local.json`) OUTSIDE the dispatcher's process tree.
 *
 * WHY. A repo-owned detector is code loom does not vet. Run as a descendant of
 * dispatch.js it could take the dispatcher down — and every verdict loom's guards
 * had already reached with it — by walking `ps -o ppid=` up to it, by signalling
 * the process group it shares (`kill(0, …)`, a shell `trap 'kill 0' EXIT`), or by
 * leaving a grandchild that holds the stdout pipe open past the budget. So
 * dispatch.js starts this file through a short-lived launcher that EXITS at once:
 * this process is re-parented (to init/launchd, or the nearest subreaper — never
 * to the dispatcher) and lives in the launcher's session and process group, not
 * the dispatcher's. Nothing a detector can do to its ancestors or its own group
 * reaches the dispatcher through the tree. The re-parenting is VERIFIED, not
 * assumed: before running anything this process walks its own ancestry
 * (`ancestryReaches`) and refuses if the dispatcher is on it or the walk cannot
 * be completed. It checks ANCESTRY only — not the process group or session,
 * which the launcher's `detached` spawn is what provides.
 *
 * PROTOCOL (dispatch.js owns the other half, `runLocalSupervised`).
 *   in  — fd 3 (never fd 0), ONE JSON document, then EOF:
 *         {nonce, dispatcherPid, budgetMs, detectors: [{file, timeoutMs}]}
 *         `budgetMs` is the event budget REMAINING, in ms, measured on the
 *         dispatcher's monotonic clock the moment it wrote the input. It is
 *         RELATIVE because the two processes share no monotonic origin; this
 *         process anchors it to its OWN performance.now() on receipt, and every
 *         deadline below is monotonic from there — a wall-clock step (NTP, a
 *         manual date change, a VM resume) cannot cut a detector short, which
 *         dispatch.js would read as STARVED and refuse at PreToolUse.
 *         plus `raw` (the host's payload, byte-for-byte the string the host sent).
 *         OR, instead of `detectors`, `select: {event, value, matchers: [string],
 *         rows: [{hook, file, timeoutMs, mi, match, exists, loomRuns}]}` — the
 *         event's repo-owned rows when some matcher was left undecided (`match: null`,
 *         `mi` its index in `matchers`, each distinct matcher sent once; decided rows
 *         carry `mi: -1`): a regex, or a list too long for the dispatcher's thread.
 *         This process decides those and derives the detectors with
 *         dispatch-registry.js::planLocalRows, as the dispatcher does.
 *         fd 3 is closed as soon as it is read, before any detector starts.
 *   out — fd 1, newline-delimited JSON frames, each carrying the nonce:
 *         {t:"hello", n, pid}
 *         select mode only: {t:"match", n, m: [boolean per row]}
 *         per detector i, in order: {t:"start", n, i, pgid}  then
 *                                   {t:"done",  n, i, status, exitCode, stdout, stderr[, cut]}
 *         (`cut: true` on a timeout the EVENT deadline imposed before the
 *          detector's own timeout expired)
 *         (a detector that cannot start before the deadline: only
 *          {t:"done", …, status:"skipped"})
 *         {t:"end", n}
 *   The nonce reaches this process only through fd 3, which the detectors never
 *   see, and a detector's own stdout/stderr are captured on ITS OWN pipes — no
 *   detector shares fd 1 with this process. A detector therefore cannot write a
 *   frame for itself, another detector or loom; one that forces bytes onto the
 *   channel anyway (Linux /proc/<pid>/fd/1, same uid) produces a frame without
 *   the nonce, which dispatch.js reads as a protocol fault — a refusal at
 *   PreToolUse, never an outcome.
 *
 * PER DETECTOR — exactly the standalone semantics the host gave the hook, and
 * the ones the engine's former one-line wrapper process gave it before this file:
 *   - `node <file>` behind `/bin/sh -c` (the host runs hook commands through a
 *     shell too), so the detector's process.ppid is that shell: a detector that
 *     signals its parent ends only its own run. The shell is started `detached`,
 *     so the detector and every child it spawns are in a process group of their
 *     OWN — `kill(0, …)` reaches only that group, and the budget kill reaches all
 *     of it (grandchildren included).
 *   - the same payload on stdin, the same env and cwd the dispatcher got.
 *   - budget = its registration timeout + the dispatcher's grace, capped by the
 *     event deadline. On expiry the WHOLE group is SIGKILLed and the detector
 *     contributes NOTHING (status "timeout") — the host-kill disposition.
 *   - exit code as the process reports it; killed by a signal ⇒ non-zero, non-2
 *     (the shell reports 128+n; a signal that ended the shell itself ⇒ 1).
 *   - a detector that EXITS while something it spawned still holds its stdout /
 *     stderr: its output is read for DRAIN_MS more, then its group is killed and
 *     the pipes are dropped — its verdict stands, the pipe-holder cannot stall
 *     the event.
 *
 * WINDOWS. No process groups, sessions or re-parenting: dispatch.js starts this
 * file as a plain child — so it IS a descendant of the dispatcher there, and the
 * ancestry check above is skipped — the detector is spawned directly (no shell),
 * and the budget kill ends the detector process only (a grandchild survives it).
 * The protocol, capture and budgets are the same; the process-tree isolation
 * above is POSIX-only.
 *   KNOWN GAP (Windows only): on a supervisor FAULT (protocol violation, backstop
 *   overrun) lib/dispatch-main.js::runLocalSupervised ends ONLY this process
 *   (`launcher.kill()`); its `killGroup(running)` is a no-op on win32. This
 *   process is terminated outright, so none of its own cleanup runs and the
 *   detector it was running is ORPHANED — it keeps running, with no budget
 *   bounding it any longer, until it exits by itself. No fix is available from
 *   this side (a hard-killed process runs no handler); closing it needs the
 *   dispatcher to end the detector too — e.g. kill the pid the `start` frame
 *   reported, or `taskkill /T /F` this process's tree.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Monotonic: every budget in this file is arithmetic on performance.now(), which
// a wall-clock step cannot move (see `budgetMs` in the PROTOCOL above).
const { performance } = require("perf_hooks");
const monoNow = () => performance.now();

const DRAIN_MS = 250;
const MAX_CAPTURE = 64 * 1024 * 1024; // per stream, the old spawnSync maxBuffer
const WIN = process.platform === "win32";
// "$0" is node, "$1" the detector file; `; exit $?` keeps the shell as the
// detector's PARENT (a lone command would be exec'd in place by some shells).
const DETECTOR_SHELL = '"$0" "$1"; exit $?';

let running = null; // the detector child currently running (for the dispatcher-gone path)

function killGroup(child) {
  if (!child || !child.pid) return;
  try {
    if (WIN) child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {}
}

/**
 * Run one detector; resolves its outcome (never rejects).
 * @param {{file:string,timeoutMs:number}} d
 * @param {string} raw
 * @param {number} deadlineAt MONOTONIC ms (monoNow())
 * @param {(pgid:number)=>void} onStart
 */
function runOne(d, raw, deadlineAt, onStart, cwd) {
  return new Promise((resolve) => {
    const remaining = deadlineAt - monoNow();
    const budget = Math.max(1, Math.min(d.timeoutMs, remaining));
    // The EVENT deadline, not the detector's own timeout, bounds this run: a kill
    // then is "could not run", which dispatch.js refuses at PreToolUse — distinct
    // from the detector overrunning its own timeout (the host-kill disposition).
    const cut = remaining < d.timeoutMs;
    // THE DETECTOR'S SCOPE IS THE PAYLOAD'S, NOT THIS PROCESS'S. The host launches a
    // hook with the SESSION's cwd, and `payload.cwd` is that same directory; a worker
    // thread cannot change its cwd (`process.chdir` is ERR_WORKER_UNSUPPORTED_OPERATION
    // — MEASURED) and a spawn with no `cwd` option takes the REAL process cwd (also
    // MEASURED: patching `process.cwd` does not move it), so a detector that resolves
    // git from its cwd would answer for the DISPATCHER's tree whenever the session has
    // cd'd elsewhere. MEASURED on the pinned corpora: three kailash-py guards DENY
    // standalone in a non-git cwd and ALLOWED under the adapted path for exactly this
    // reason. `cwd` therefore travels with the job and is handed to the spawn.
    let child;
    try {
      const opts = { stdio: ["pipe", "pipe", "pipe"], ...(cwd ? { cwd } : {}) };
      child = WIN
        ? spawn(process.execPath, [d.file], { ...opts, windowsHide: true })
        : spawn("/bin/sh", ["-c", DETECTOR_SHELL, process.execPath, d.file], { ...opts, detached: true });
    } catch (e) {
      return resolve({ status: "crash", exitCode: 1, stdout: "", stderr: `${e && e.message ? e.message : e}\n` });
    }
    const out = [];
    const err = [];
    const size = { out: 0, err: 0 };
    let settled = false;
    let exited = null; // {code, signal}
    let open = 2; // stdout + stderr not yet closed
    let drain = null;
    const settle = (o) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      // Dropping OUR ends: a pipe-holder in a group of its own (it called setsid)
      // survives the group kill, but it can no longer hold this process open.
      for (const s of [child.stdout, child.stderr, child.stdin]) {
        try {
          if (s) s.destroy();
        } catch {}
      }
      resolve(o);
    };
    const exitOutcome = () =>
      settle({
        status: "exit",
        exitCode: exited.code !== null ? exited.code : 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    const timer = setTimeout(() => {
      killGroup(child);
      settle({ status: "timeout", exitCode: null, stdout: "", stderr: "", cut });
    }, budget);
    const collect = (which, arr) => (c) => {
      size[which] += c.length;
      if (size[which] > MAX_CAPTURE) {
        killGroup(child);
        return settle({ status: "crash", exitCode: 1, stdout: "", stderr: `detector output exceeded ${MAX_CAPTURE} bytes on ${which === "out" ? "stdout" : "stderr"}\n` });
      }
      arr.push(c);
    };
    const closed = () => {
      open--;
      if (open === 0 && exited) exitOutcome();
    };
    child.stdout.on("data", collect("out", out));
    child.stderr.on("data", collect("err", err));
    child.stdout.on("close", closed);
    child.stderr.on("close", closed);
    child.stdin.on("error", () => {}); // a detector that never reads stdin (EPIPE)
    child.on("error", (e) => {
      if (exited) return;
      killGroup(child);
      settle({ status: "crash", exitCode: 1, stdout: "", stderr: `${e && e.message ? e.message : e}\n` });
    });
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      if (open === 0) return exitOutcome();
      // Something the detector spawned still holds its stdout/stderr.
      drain = setTimeout(() => {
        killGroup(child);
        exitOutcome();
      }, DRAIN_MS);
    });
    running = child;
    if (child.pid) onStart(child.pid);
    child.stdin.end(raw);
  });
}

/**
 * Run a run of `mode:"legacy"` rows in THIS process, in registry order, through the
 * dispatcher's own engine (lib/hook-engine.js) with the same per-row budgets and the same
 * process-shaped sandbox — one worker thread per batch, not one OS process per row.
 *
 * WHY THE POOL IS A SEPARATE PROCESS AT ALL: the engine's shims make a row's *ordinary*
 * failure modes safe (a crash, a timeout, a process.exit), but an abort, an OOM or a
 * signal ends the PROCESS, and no JS-level patch can stop those. Running repo rows in the
 * dispatcher's own workers would put every template verdict behind a repo row's worth of
 * that risk. Here the blast radius is this child: its own transport dies, the dispatcher
 * keeps its verdicts, and the rows of this pool are marked per their declarations.
 *
 * The rows run with THIS process's cwd, which the dispatcher sets from the payload — the
 * session's directory — so their git answers are the ones their standalone launch had.
 */
async function runLegacyRow(d, index, raw, deadlineAt) {
  let engine;
  try {
    engine = require("./hook-engine.js");
  } catch (e) {
    return {
      status: "crash",
      exitCode: 1,
      stdout: "",
      stderr: `[dispatch] ${d.hook} could not run in-process: the engine would not load in this pool (${e && e.message ? e.message : e})\n`,
    };
  }
  const entry = { hook: d.hook, file: d.file, timeoutMs: d.timeoutMs, mode: "legacy", onIncomplete: d.onIncomplete, origin: "local", index };
  const out = await engine.runDetectorsIsolated([entry], raw, { deadlineAtMono: deadlineAt, isolation: "event" });
  const o = out[0] || { status: "engine-fault", exitCode: null, stdout: "", stderr: `[dispatch] ${entry.hook} produced no outcome — the pool could not run it\n` };
  // THE FRAME VOCABULARY IS THE SUPERVISOR'S, NOT THE ENGINE'S. The dispatcher validates
  // `status` against exit|timeout|crash|skipped, and the engine's own words include
  // "return" (a row that finished without calling process.exit) and "engine-fault" (a row
  // whose worker never produced one). Both are translated HERE, at the boundary, so the
  // dispatcher's per-row contract sees the same vocabulary it always has: a completed row
  // is an `exit` with its code, an unrunnable one a `crash` whose stderr says so.
  // MEASURED: forwarding "return" raw was a protocol violation that took the whole pool's
  // answer down.
  const status = o.status === "return" ? "exit" : o.status === "engine-fault" ? "crash" : o.status;
  const exitCode = o.status === "return" && !Number.isInteger(o.exitCode) ? 0 : o.exitCode === undefined ? null : o.exitCode;
  return { status, exitCode, stdout: o.stdout || "", stderr: o.stderr || "" };
}

const MAX_ANCESTRY_HOPS = 64;
const PS_TIMEOUT_MS = 2000;

/**
 * The parent pid of `pid`, or throws. Linux reads /proc/<pid>/stat (no spawn; the
 * ppid is the 2nd field after the parenthesised command, which may itself hold
 * spaces or parens — hence the LAST ")"). Elsewhere `ps -o ppid= -p <pid>` from a
 * fixed path, never PATH, bounded by PS_TIMEOUT_MS.
 */
function ppidOf(pid) {
  let v;
  if (fs.existsSync("/proc/self/stat")) {
    const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    v = Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[1]);
  } else {
    const ps = ["/bin/ps", "/usr/bin/ps"].find((p) => fs.existsSync(p));
    if (!ps) throw new Error("no ps binary at /bin/ps or /usr/bin/ps");
    const out = require("child_process").execFileSync(ps, ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    v = Number(out.trim());
  }
  if (!Number.isInteger(v) || v < 0) throw new Error(`unreadable parent of pid ${pid}`);
  return v;
}

/**
 * Whether `targetPid` is an ancestor of this process: true / false, or a string
 * naming why the walk could not decide. The walk starts at process.ppid and stops
 * at pid 1 (init/launchd) or 0. After a normal launch it is ZERO hops on darwin
 * (re-parented straight to launchd) and a few on Linux under a subreaper.
 */
function ancestryReaches(targetPid) {
  let pid = process.ppid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
    if (pid === targetPid) return true;
    if (pid <= 1) return false;
    try {
      pid = ppidOf(pid);
    } catch (e) {
      return e && e.message ? e.message : String(e);
    }
  }
  return `ancestry deeper than ${MAX_ANCESTRY_HOPS} hops`;
}

function readInput() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let s;
    try {
      s = fs.createReadStream(null, { fd: 3, autoClose: true });
    } catch (e) {
      return reject(e);
    }
    s.on("data", (c) => chunks.push(c));
    s.on("error", reject);
    // `close`, not `end`: fd 3 is released before any detector is spawned.
    s.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function main() {
  let input;
  let receivedAt;
  try {
    const text = await readInput();
    receivedAt = monoNow(); // the anchor for the dispatcher's relative budget
    input = JSON.parse(text);
  } catch (e) {
    process.stderr.write(`[local-supervisor] unreadable input: ${e && e.message ? e.message : e}\n`);
    return process.exit(3);
  }
  const { nonce, dispatcherPid, budgetMs, select, raw, cwd } = input || {};
  // The detector's cwd, when the dispatcher declares one: an EXISTING absolute directory,
  // or nothing (the dispatcher's own cwd, which is what a host launch would have used).
  // Anything else is MALFORMED INPUT — refused like every other shape here, because a
  // detector that cannot start is a fault the dispatcher must hear about, never a row
  // that silently ran in the wrong scope.
  const cwdOk = cwd === undefined || cwd === null || (typeof cwd === "string" && path.isAbsolute(cwd) && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory());
  let { detectors } = input || {};
  const selectOk =
    select &&
    typeof select === "object" &&
    Array.isArray(select.rows) &&
    Array.isArray(select.matchers) &&
    select.matchers.every((m) => typeof m === "string") &&
    select.rows.every((r) => r && Number.isInteger(r.mi) && (r.match === null ? r.mi >= 0 && r.mi < select.matchers.length : r.mi === -1)) &&
    (select.event === undefined || typeof select.event === "string") &&
    (select.value === undefined || typeof select.value === "string");
  if (typeof nonce !== "string" || !(select ? selectOk && detectors === undefined : Array.isArray(detectors)) || typeof raw !== "string" || !cwdOk || !(typeof budgetMs === "number" && Number.isFinite(budgetMs) && budgetMs >= 0) || !(Number.isInteger(dispatcherPid) && dispatcherPid > 1)) {
    process.stderr.write(`[local-supervisor] malformed input${cwdOk ? "" : " (cwd is not an existing absolute directory)"}\n`);
    return process.exit(3);
  }
  // Anchored at RECEIPT, before the ancestry walk: the walk's time is spent from
  // the event budget, as it would be on the dispatcher's own clock.
  const deadlineAt = receivedAt + budgetMs;
  // The launcher has exited before the input is written, so this process has
  // been re-parented by now. VERIFY it rather than assume it: walk this
  // process's ancestry and refuse if the dispatcher is on it — the isolation
  // this file exists for then does not hold (dispatch.js reads the missing
  // frames as a fault). `process.ppid === dispatcherPid` alone could never fire:
  // the direct parent is the /bin/sh launcher while it lives, never the
  // dispatcher. An ancestry that cannot be read is refused too (fail-closed).
  // POSIX only — see the WINDOWS paragraph in the header.
  if (!WIN) {
    const v = ancestryReaches(dispatcherPid);
    if (v !== false) {
      const why = v === true ? "the dispatcher is still an ancestor of this process" : `cannot verify this process's ancestry (${v})`;
      process.stderr.write(`[local-supervisor] ${why} — refusing to run repo detectors\n`);
      return process.exit(3);
    }
  }
  // The dispatcher gone (its channel closed): nothing can use a verdict any more.
  // End the running detector's group with this process instead of orphaning it.
  process.stdout.on("error", () => {
    killGroup(running);
    process.exit(3);
  });
  const frame = (o) => process.stdout.write(JSON.stringify({ ...o, n: nonce }) + "\n");
  frame({ t: "hello", pid: process.pid });
  if (select) {
    // The repo matchers the dispatcher did not decide — every REGEX one, and any
    // plain list too long to split on its thread — are evaluated HERE (a
    // catastrophic-backtracking one there would stall it past the host's kill and
    // lose loom's verdict). A stall here is bounded by the dispatcher's backstop,
    // which kills this process group: a supervisor fault, refused at PreToolUse.
    // Rows the dispatcher already decided are echoed unchanged. The rule is the
    // host's in FULL (hook-engine.js::matcherMatches: a plain list is an exact-name
    // list, anything else a regex, an invalid pattern matches nothing) — a long
    // list read as a regex would admit `BashX` for `Bash|…`. Each distinct matcher
    // (`mi`) is decided once.
    const { matcherMatches } = require("./hook-engine.js");
    const decided = new Map();
    const m = select.rows.map((r) => {
      if (r.match === true || r.match === false) return r.match;
      if (typeof select.value !== "string") return false;
      if (!decided.has(r.mi)) decided.set(r.mi, matcherMatches(select.matchers[r.mi], select.value, select.event));
      return decided.get(r.mi);
    });
    frame({ t: "match", m });
    // The same derivation the dispatcher applies to this vector.
    const { planLocalRows } = require("./dispatch-registry.js");
    detectors = planLocalRows(select.rows, m).run.map((k) => select.rows[k]);
  }
  for (let i = 0; i < detectors.length; i++) {
    const d = detectors[i];
    if (monoNow() >= deadlineAt) {
      frame({ t: "done", i, status: "skipped", exitCode: null, stdout: "", stderr: `[dispatch] ${d.hook || d.file} skipped: event dispatch budget exhausted\n` });
      continue;
    }
    // § THE REPO POOL. A row declaring `mode:"legacy"` runs IN-PROCESS, in a worker thread
    // of THIS process — this process is the repo-owned pool, deliberately a child of the
    // dispatcher rather than the dispatcher itself: a repo row that aborts, OOMs or is
    // signalled ends THIS pool and its transport, while every template verdict the
    // dispatcher already reached stays in hand (the dispatcher treats a dead pool as the
    // per-row incompleteness their declarations describe). Rows that do not declare it
    // keep the standalone-process path below, exactly as before.
    if (d.mode === "legacy") {
      // ONE ROW PER ENGINE CALL, with the protocol's own start → done pair around it. The
      // engine can run a whole batch, but the dispatcher's frame protocol is strictly
      // interleaved (`start(i)` while another row is current is a PROTOCOL VIOLATION —
      // MEASURED: a batched pair of frames read as exactly that and refused the call), and
      // that strictness is what stops one detector posting another's verdict. A shared
      // batch would need that contract relaxed; a worker per row inside this pool costs a
      // thread boot, not an OS process, which is the cost the pool exists to avoid.
      // The frame protocol requires a real process group on `start` (the dispatcher
      // validates `Number.isInteger(f.pgid) && f.pgid > 1`), and the pool's OWN group is
      // the honest one here: this row runs inside THIS process, so if the dispatcher must
      // abandon it, ending the pool is exactly how that happens — and the dispatcher's
      // pool-death marking then applies each row's `on_incomplete` declaration.
      frame({ t: "start", i, pgid: process.pid });
      const o = await runLegacyRow(d, i, raw, deadlineAt);
      frame({ t: "done", i, status: o.status, exitCode: o.exitCode, stdout: o.stdout, stderr: o.stderr });
      continue;
    }
    const o = await runOne(d, raw, deadlineAt, (pgid) => frame({ t: "start", i, pgid }), cwd || undefined);
    frame({ t: "done", i, ...o });
  }
  process.stdout.write(JSON.stringify({ t: "end", n: nonce }) + "\n", () => process.exit(0));
}

if (require.main === module) {
  main().catch((e) => {
    try {
      process.stderr.write(`[local-supervisor] fatal: ${e && e.stack ? e.stack : e}\n`);
    } catch {}
    process.exit(3);
  });
}

module.exports = { DRAIN_MS, DETECTOR_SHELL };
