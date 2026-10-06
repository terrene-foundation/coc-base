#!/usr/bin/env node
"use strict";
/**
 * session-load-backstop.js — report CPU-burning processes THIS session spawned.
 *
 * @hook-event: PostToolUse:Bash (verification) — the subject is the set of processes a Bash
 *   call launched, which exists only once that call has RETURNED, so PostToolUse is the
 *   earliest event that can see it; Bash is the tool that launches processes. Stop and
 *   SubagentStop are not available to this class (hook-event-selection.md MUST-3: a
 *   verification hook needs a tool axis and a narrow matcher), and PreToolUse sees only
 *   the command string — which is the boundary guard's job, not this backstop's. The
 *   event also covers SUB-AGENTS, MEASURED rather than assumed on two instruments: (1) a
 *   sub-agent transcript of this session (`subagents/agent-*.jsonl`) carries 191
 *   `"hookEvent":"PostToolUse"` records including `"hookName":"PostToolUse:Bash"` entries,
 *   against 369 PreToolUse records in the same file as the control that the instrument
 *   reads hook records at all — had PostToolUse not fired for sub-agent calls that count
 *   would be 0; (2) a sub-agent's Bash shell walked up with read-only `ps` had the SAME
 *   `claude` process as its parent, so sub-agent processes are descendants of the one
 *   session root this hook scopes to.
 *
 * WHAT IT DOES (journal/0609 decision 2). Reads the process table once, finds the session's
 * CLI process by walking up from this hook's own pid, classifies every descendant's command
 * column with the synthetic-load classifier, and — when a descendant is a load generator,
 * or a busy loop with sustained CPU — reports each pid and command and tells the agent how
 * to stop it. All decisions live in lib/session-load-backstop.js, which is pure and
 * fixture-covered against fabricated process tables.
 *
 * SEVERITY IS halt-and-report, NEVER block — and the hook NEVER kills or signals anything.
 * Three grounds, each sufficient:
 *   1. The process table is a structural read, but classifying its command column is
 *      LEXICAL (a lossy, quote-stripped join of argv), and hook-output-discipline.md MUST-2
 *      bars `block` on a lexical signal.
 *   2. At PostToolUse the Bash call has already run; there is no call left to refuse.
 *   3. Stopping a process is the agent's act. A hook that killed processes on a lexical
 *      match would, on its first false positive, destroy real work — the exact harm this
 *      backstop exists to prevent from the other direction.
 *
 * STATELESS, and deliberately so. MEASURED cost of the read: one
 * `/bin/ps -Ao pid,ppid,pcpu,etime,command -ww` over 1,262 processes took 0.066 s wall time
 * at a 1-minute load average of 172 on 16 cores. That is small against a Bash call, so no
 * throttle is warranted — and a throttle would need per-session state on disk, an
 * unauthenticated in-tree marker a writer could pre-plant to silence the hook
 * (hook-output-discipline.md § Accepted Residual). Re-reporting on every Bash call while a
 * burner is still running is the intended behaviour: the report stops when the load stops.
 *
 * EVERY UNKNOWN IS SILENT: no ps, win32, a timeout, an unparseable table, no recognisable
 * session root, an absent classifier, a hook error. See the fail-open note in the lib.
 */

const path = require("node:path");
const os = require("node:os");

const TIMEOUT_MS = 5000;
let _timeout = null;

function passthrough() {
  clearTimeout(_timeout);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

/** Passwd-derived home for scrubbing emitted commands; never `$HOME`, never required. */
function scrubHome() {
  try {
    const h = os.userInfo().homedir;
    return typeof h === "string" && h.startsWith("/") ? h : null;
  } catch {
    return null;
  }
}

function run() {
  // DELIBERATELY gated on NEITHER `hook_event_name` NOR `tool_name`, and the payload is not
  // read at all: the subject is process state, not the command string, and the REGISTRATION
  // does all the scoping — spelled differently per CLI lane. Re-checking CC's literals here
  // would leave a mirrored registration registered, shipped and silently inert (the pattern
  // ci-runner-saturation-guard.js records).
  let L;
  try {
    L = require(path.join(__dirname, "lib", "session-load-backstop.js"));
  } catch {
    return passthrough();
  }
  const classify = L.loadClassifier();
  if (!classify) return passthrough();

  const text = L.readProcessTable();
  if (text === null) return passthrough();

  const assessment = L.assessSessionLoad({
    rows: L.parsePsTable(text),
    selfPid: process.pid,
    selfPpid: process.ppid,
    classify,
    // The classifier's context-dependent load words (`yes`, `dd`, `cat` …). Optional by
    // construction: absent ⇒ no row is re-classified ⇒ silence, never a wider report.
    conditionalWords: L.loadConditionalLoadWords(),
    homeDir: scrubHome(),
  });
  if (assessment.verdict !== "report") return passthrough();

  let emit;
  try {
    ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
  } catch {
    return passthrough();
  }
  clearTimeout(_timeout);
  emit(L.buildEmitPayload(assessment));
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  _timeout = setTimeout(() => {
    // cc-artifacts.md Rule 7 — a hanging hook blocks the session; a bounded one that says
    // nothing is the correct degenerate outcome for a backstop.
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    process.stdin.on("error", passthrough);
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {
      try {
        onStdinEnd();
      } catch (e) {
        return reject(e);
      }
      resolve();
    });
    process.stdin.resume();
  });
}

function onStdinEnd() {
  try {
    run();
  } catch (e) {
    clearTimeout(_timeout);
    process.stderr.write(`[session-load-backstop] HOOK ERROR: ${e && e.message}\n`);
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
