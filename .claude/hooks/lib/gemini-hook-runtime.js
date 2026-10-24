#!/usr/bin/env node
"use strict";
/**
 * gemini-hook-runtime — THE GEMINI HOOK BOUNDARY FOR loom's SHARED GUARDS.
 *
 *     exec env -i PATH="$PATH" HOME="$HOME" node $GEMINI_PROJECT_DIR/.claude/hooks/lib/gemini-hook-runtime.js --guard .claude/hooks/<guard>.js; exit <2|1>
 *
 * (registrationCommand below is the ONE spelling; gemini-hook-runtime.test.mjs reds a Gemini
 * settings file whose command differs from it.)
 *
 * WHY THIS EXISTS. `.gemini/settings.json` used to register each shared guard as a bare
 * `node $GEMINI_PROJECT_DIR/.claude/hooks/<guard>.js`. Two things made that fail OPEN:
 *
 *   1. Gemini reads a hook's EXIT CODE only when its output is not JSON. MEASURED by reading
 *      the installed Gemini CLI 0.41.2 bundle (`hookRunner.executeCommandHook` +
 *      `convertPlainTextToHookOutput`; `DefaultHookOutput::isBlockingDecision`): when stdout
 *      (or, if stdout is empty, stderr) parses as JSON, that JSON IS the decision and the
 *      exit code is ignored; a BeforeTool call is blocked only by `decision: "block"|"deny"`
 *      (or stopped by `continue: false`). `hookSpecificOutput.permissionDecision` — the field
 *      every loom guard's refusal carries (instruct-and-wait.js::instructAndWait, block) — is
 *      read nowhere. So a guard's exit-2 refusal with its CC-shaped JSON reply was an ALLOW
 *      on Gemini, and a guard that crashed with `{"continue":true}` and exit 1 was an allow
 *      too. Only a non-JSON exit other than 0/1 denied.
 *   2. Nothing bounded the guard: a hang ran into Gemini's own 60 s hook timeout
 *      (`DEFAULT_HOOK_TIMEOUT = 6e4`, same bundle), and a timed-out hook produces NO output,
 *      which Gemini treats as no decision — an allow.
 *
 * WHAT THIS DOES, IN ORDER — every step that cannot complete REFUSES for a deny-capable
 * guard (exit 2 + a Gemini-native `{"decision":"deny"}` reply), never passes through:
 *
 *   argv      EXACTLY `--guard .claude/hooks/<basename>.js`, the basename in GUARDS (an
 *             exact-basename allowlist). Anything else — `..`, an absolute path, a second
 *             argument, `--guard=…`, an unknown or differently-cased name — is refused for
 *             every row, because a malformed registration names no row whose capability is
 *             known. The full `.claude/hooks/<g>.js` spelling is required because it is what
 *             `emit-hook-registry.mjs::filesNamedIn` reads to derive a row's `gemini`
 *             surface; this file's own path (`.claude/hooks/lib/…`) never matches that regex.
 *   resolve   the guard is `<hooks dir>/<basename>`, where the hooks dir is the realpath of
 *             this file's parent directory. The candidate must be a regular file, NOT a
 *             symlink, and its realpath must sit directly in that same realpath'd hooks dir
 *             under the same basename (both sides through fs.realpathSync — security.md
 *             § Path Containment). An unresolvable path refuses.
 *   payload   read through guard-runner.js::readPayload, which REJECTS an empty, unparsable,
 *             non-object, oversized or never-ending stdin (it never resolves `{}`).
 *   run       `spawn(process.execPath, [guard])` with NO node flags and an ALLOWLISTED env
 *             (scrubEnv): only the names settings-deny-guard-shape.js::isGuardChildEnvKey admits
 *             (PATH, HOME; on win32 the OS start-up names) are inherited — NODE_OPTIONS, GIT_*,
 *             XDG_*, CLAUDE_TRUST_STATE_DIR and every name nobody listed are dropped — and
 *             COC_RUNTIME=gemini and CLAUDE_PROJECT_DIR=<this tree's root> are set (Codex
 *             parity: codex-hook-runtime.js::invokeTarget).
 *             Bounded by the guard's own registry budget; on overrun the child is killed
 *             (SIGKILL — our own child, through the ChildProcess handle we hold; a no-op once
 *             it has exited) and the run is a budget refusal. The run settles on the
 *             child's EXIT, so a grandchild holding the pipe open cannot extend it.
 *   decide    guard-runner.js::classify over guard-runner.js::stdoutFacts — the ONE
 *             classifier, parity-pinned to codex-mcp-guard/policy-outcome.js::
 *             classifyPolicyOutcome — with the row's canDeny. Two Gemini-specific facts are
 *             added: a Gemini-native `decision: "block"|"deny"` line is a deny, and a
 *             CC rewrite (`hookSpecificOutput.updatedInput`) from a deny-capable guard is
 *             refused, because Gemini does not apply it (it reads `tool_input`), so passing
 *             it on would run the UN-rewritten call.
 *   render    allow   -> the guard's stdout/stderr unchanged, exit 0.
 *             deny    -> `{"decision":"deny","reason":<the guard's reason>}`, exit 2.
 *             refuse  -> (deny-capable guard; crash, exit ≠ 0/2, warn, ask, timeout, signal,
 *                        unreadable payload, missing file, rewrite) the adapter's own
 *                        `{"decision":"deny"}` naming the guard and the outcome, exit 2.
 *             advise  -> (canDeny:false guard that did not complete) a plain-text stderr
 *                        line, exit 1 — Gemini's non-blocking warning; the call proceeds,
 *                        which is that row's declared `on_incomplete: "continue"`.
 *
 * NAMED RESIDUALS (not claimed closed):
 *   - this file's OWN syntax error, or a missing `node`, exits 1 before any code here runs:
 *     Gemini reads that as a non-blocking warning. The same residual every direct
 *     registration carries (SHARD-PLAN §6). A load failure of guard-runner.js IS caught.
 *   - Gemini's environment is NOT only the operator's: Gemini loads a `.env` into it at
 *     start-up — the first of `<dir>/.gemini/.env` (trusted workspace) and `<dir>/.env` from
 *     the workspace up to the root, then `~/.gemini/.env` and `~/.env` (Gemini CLI 0.41.2
 *     bundle, chunk-5A3LI34G.js `findEnvFile` / `loadEnvironment`) — and an AGENT can write
 *     one. R1 MEASURED NODE_OPTIONS=--require <file> there turning a deny guard's refusal into
 *     an allow. CLOSED STRUCTURALLY for this process and every guard (R2 HIGH-1, ROOT ruling
 *     A): the registration starts this file through `exec env -i PATH=… HOME=… node …`, so no
 *     key of that file reaches this node, and scrubEnv admits only the allowlisted names to the
 *     guard. STILL OPEN, and NOT closed by `env -i`: the `bash -c` Gemini wraps every hook
 *     command in starts BEFORE `env -i`, with that environment — BASH_ENV is sourced,
 *     SHELLOPTS=xtrace expands a PS4 `$(…)`, LD_PRELOAD / DYLD_* act on the bash binary
 *     (MEASURED: BASH_ENV and SHELLOPTS+PS4 each ran code before `env -i`). That stage is
 *     FENCED, not closed: an agent write leaving one of those keys
 *     (settings-deny-guard-shape.js::isDotenvForbiddenKey) in a file named `.env` is refused by
 *     settings-deny-edit-guard.js::enforceDotenv (file tools) and validate-bash-command.js
 *     (Gemini's run_shell_command). A `.env` that already carries one when Gemini starts —
 *     planted by the operator, another program, or a write outside these hooks — and the
 *     operator's own environment are not fenced at all.
 *   - check-to-spawn TOCTOU on the guard path (security.md § the accepted residual).
 *   - a guard that is a HARDLINK to other bytes is a regular file here; its CONTENT is
 *     pinned by the hook registry's per-row file_sha256, not by this adapter.
 *   - Gemini's blocking on a live Gemini build is UNMEASURED: the behaviour above was read
 *     from the installed 0.41.2 bundle's source, not observed on a running session.
 *   - Windows: NOT ISOLATED. Gemini runs the command under PowerShell there
 *     (`getShellConfiguration`), where neither `exec` nor `env -i` exists, so the isolated
 *     launch cannot start and the trailing `exit <code>` decides: 2 (a refusal) on a
 *     deny-capable row, 1 (Gemini's non-blocking warning) on an advisory one — each row's own
 *     `on_incomplete`. Under bash the `exec` replaces the shell, so that tail never runs. Read
 *     from the bundle's source, not observed on a Windows host; an isolated Windows form needs
 *     a PowerShell spelling Gemini's single command string does not carry.
 *
 * HOW THE EMITTER PINS IT. This file is a RUNTIME entry
 * (hook-registry-contract.js::RUNTIME_ENTRIES): its require closure is pinned at manifest
 * level. Its one spawn-by-path site is a declared hole: the guard it spawns is one of the
 * GUARDS basenames, each a ROW of the manifest pinned by its own file_sha256 + deps.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ADAPTER = "gemini-hook-runtime";

/**
 * The guards this adapter will run, by EXACT basename, with the capability and budget their
 * PreToolUse registration declares — a dispatch-registry.json row (`on_incomplete: "deny"` ->
 * canDeny; the row's `timeout` seconds -> budgetMs), or, for a guard Claude Code runs DIRECTLY
 * (settings-deny-edit-guard.js), its `.claude/settings.json` PreToolUse registration (its
 * `timeout` -> budgetMs) with the hook-registry row's `on_incomplete`. gemini-hook-runtime.test.mjs
 * reds when this table drifts from either source or from the Gemini registrations.
 * settings-deny-edit-guard.js is here for R1 HIGH-1: it is the deny-capable fence on Gemini's
 * own write tools (`write_file|replace`), which refuses a loader key in a `.env` Gemini loads.
 */
const GUARDS = Object.freeze({
  "validate-bash-command.js": Object.freeze({ canDeny: true, budgetMs: 30000 }),
  "ci-runner-saturation-guard.js": Object.freeze({ canDeny: false, budgetMs: 8000 }),
  "synthetic-load-guard.js": Object.freeze({ canDeny: true, budgetMs: 8000 }),
  "provenance-capture-tool.js": Object.freeze({ canDeny: false, budgetMs: 20000 }),
  "settings-deny-edit-guard.js": Object.freeze({ canDeny: true, budgetMs: 20000 }),
});

/** Gemini CLI's own per-hook timeout (DEFAULT_HOOK_TIMEOUT, Gemini CLI 0.41.2 bundle). */
const HOST_TIMEOUT_MS = 60000;
/** How long the payload may take to arrive. Gemini writes it and ends stdin at spawn. */
const STDIN_TIMEOUT_MS = 5000;
/** After the child EXITS, how long its pipes may take to drain before the run settles. */
const EXIT_DRAIN_MS = 500;
/** Reserve for this process's own start-up and reply under load. */
const RESERVE_MS = 5000;
/** A guard's reply larger than this is not a reply this boundary forwards. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Does a row's budget end before Gemini's own hook timeout? (A budget that does not re-opens failure 2.) */
function budgetFits(row) {
  return !!row && Number.isInteger(row.budgetMs) && row.budgetMs > 0 &&
    row.budgetMs + STDIN_TIMEOUT_MS + EXIT_DRAIN_MS + RESERVE_MS < HOST_TIMEOUT_MS;
}


const GUARD_ARG_RE = /^\.claude\/hooks\/([A-Za-z0-9][A-Za-z0-9._-]*\.js)$/;

/** argv (after the script) -> { ok, name } | { ok:false, reason }. Exactly two tokens. */
function parseArgv(argv, guards = GUARDS) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--guard") {
    return { ok: false, reason: `expected exactly \`--guard .claude/hooks/<guard>.js\`, got ${JSON.stringify(argv)}` };
  }
  const m = GUARD_ARG_RE.exec(typeof argv[1] === "string" ? argv[1] : "");
  if (!m) return { ok: false, reason: `--guard ${JSON.stringify(argv[1])} is not \`.claude/hooks/<basename>.js\`` };
  if (!Object.prototype.hasOwnProperty.call(guards, m[1])) {
    return { ok: false, reason: `--guard ${JSON.stringify(argv[1])} is not an allowlisted guard (${Object.keys(guards).join(", ")})` };
  }
  return { ok: true, name: m[1] };
}

/** The guard's real path, or why it may not run. `hooksDir` must already be a realpath. */
function resolveGuard(hooksDir, name) {
  const candidate = path.join(hooksDir, name);
  let st;
  try {
    st = fs.lstatSync(candidate);
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return { ok: false, kind: "missing", detail: `${candidate} does not exist` };
    return { ok: false, kind: "containment", detail: `${candidate} cannot be inspected (${e && e.code ? e.code : e})` };
  }
  if (st.isSymbolicLink()) return { ok: false, kind: "containment", detail: `${candidate} is a symlink — a guard must be an ordinary file in the hooks directory` };
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (e) {
    return { ok: false, kind: "containment", detail: `${candidate} does not resolve (${e && e.code ? e.code : e})` };
  }
  if (path.dirname(real) !== hooksDir || path.basename(real) !== name) {
    return { ok: false, kind: "containment", detail: `${candidate} resolves to ${real}, outside ${hooksDir}` };
  }
  let realSt;
  try {
    realSt = fs.statSync(real);
  } catch (e) {
    return { ok: false, kind: "containment", detail: `${real} cannot be inspected (${e && e.code ? e.code : e})` };
  }
  if (!realSt.isFile()) return { ok: false, kind: "containment", detail: `${real} is not a regular file` };
  return { ok: true, file: real };
}

/**
 * The guard child's environment (R2 HIGH-1, ROOT ruling A2): an ALLOWLIST, then the two names
 * this boundary owns. Only a name settings-deny-guard-shape.js::isGuardChildEnvKey admits is
 * inherited; everything else — a loader key, GIT_*, XDG_CONFIG_HOME, CLAUDE_TRUST_STATE_DIR, a
 * name nobody has thought of yet — is dropped, so what a `.env` or the operator's shell put in
 * the parent's environment cannot reach a guard. Membership lives in that ONE module (#1471).
 * Loaded HERE, lazily, so a missing predicate throws into runAdapter's notDone path and never
 * degrades to an inherited env.
 */
function scrubEnv(env, root, platform = process.platform) {
  const { isGuardChildEnvKey } = require("./settings-deny-guard-shape.js");
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== "string" || !isGuardChildEnvKey(k, platform)) continue;
    out[k] = v;
  }
  out.COC_RUNTIME = "gemini";
  out.CLAUDE_PROJECT_DIR = root;
  return out;
}

/**
 * THE Gemini registration command for a GUARDS row (R2 HIGH-1, ROOT ruling A1) — the one
 * spelling both Gemini settings files must carry. Gemini runs it as `bash -c <command>`
 * after replacing `$GEMINI_PROJECT_DIR` with the shell-quoted workspace path
 * (`HookRunner.expandCommand`), with its own environment, a loaded `.env` included:
 *   - `exec env -i NAME="$NAME" …` starts node with ONLY the allowlisted names
 *     (settings-deny-guard-shape.js::GUARD_CHILD_ENV_ALLOW), so NODE_OPTIONS and every other
 *     key never reach this file's own process; `exec` replaces the shell, so the hook's exit
 *     status is the adapter's;
 *   - `; exit <2|1>` runs only where that launch cannot start — PowerShell on Windows, or a
 *     bash whose `exec` fails (bash then exits 126/127 itself, which Gemini also reads as a
 *     refusal) — and it is the row's own on_incomplete: 2 for a deny-capable row, 1 (Gemini's
 *     non-blocking warning) for an advisory one.
 * `$GEMINI_PROJECT_DIR` stays UNQUOTED because Gemini substitutes it already quoted.
 */
function registrationCommand(name, guards = GUARDS) {
  if (!Object.prototype.hasOwnProperty.call(guards, name)) throw new Error(`${name} is not a GUARDS row`);
  const { GUARD_CHILD_ENV_ALLOW } = require("./settings-deny-guard-shape.js");
  const env = GUARD_CHILD_ENV_ALLOW.map((k) => `${k}="$${k}"`).join(" ");
  return `exec env -i ${env} node $GEMINI_PROJECT_DIR/.claude/hooks/lib/gemini-hook-runtime.js --guard .claude/hooks/${name}; exit ${guards[name].canDeny ? 2 : 1}`;
}

/**
 * THE ONE SPAWN-BY-PATH SITE. `file` is only ever resolveGuard's result: one of the GUARDS
 * basenames, directly in the realpath'd hooks directory, not a symlink. Node is started with
 * no flags of its own; the env is scrubEnv's.
 */
function startGuard(file, env, cwd) {
  return spawn(process.execPath, [file], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

/** Run the guard once. Resolves { exitCode, signal, stdout, stderr, verdict?, detail? }; never rejects. */
function runChild(file, input, budgetMs, env, cwd) {
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let budgetTimer = null;
    let drainTimer = null;
    let child;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (budgetTimer) clearTimeout(budgetTimer);
      if (drainTimer) clearTimeout(drainTimer);
      for (const s of [child && child.stdout, child && child.stderr, child && child.stdin]) {
        try {
          if (s) s.destroy();
        } catch {
          // a pipe that cannot be destroyed is abandoned with this process
        }
      }
      try {
        if (child) child.unref();
      } catch {
        // unref is courtesy: the reply below does not depend on it
      }
      resolve({ ...r, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    };
    const kill = () => {
      try {
        // Our own direct child, through the handle we hold. After it has exited the handle
        // is closed and kill() sends nothing, so no reused pid is ever signalled.
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        // the refusal below does not depend on the kill landing
      }
    };
    try {
      child = startGuard(file, env, cwd);
    } catch (e) {
      return finish({ verdict: "error", detail: `the guard could not be started (${e && e.message ? e.message : e})` });
    }
    budgetTimer = setTimeout(() => {
      kill();
      finish({ verdict: "timeout", detail: `no verdict within ${budgetMs} ms` });
    }, budgetMs);
    const collect = (bucket, isOut) => (c) => {
      if (settled) return;
      const n = c.length;
      if (isOut) outBytes += n;
      else errBytes += n;
      if ((isOut ? outBytes : errBytes) > MAX_OUTPUT_BYTES) {
        kill();
        return finish({ verdict: "error", detail: `the guard wrote more than ${MAX_OUTPUT_BYTES} bytes to ${isOut ? "stdout" : "stderr"}` });
      }
      bucket.push(c);
    };
    child.stdout.on("data", collect(out, true));
    child.stderr.on("data", collect(err, false));
    child.on("error", (e) => finish({ verdict: "error", detail: `the guard could not be run (${e && e.message ? e.message : e})` }));
    const ended = (code, signal) =>
      signal || !Number.isInteger(code)
        ? { verdict: "error", exitCode: null, signal: signal || null, detail: `the guard was terminated by ${signal || "an unknown cause"}` }
        : { exitCode: code, signal: null };
    child.on("exit", (code, signal) => {
      if (settled) return;
      drainTimer = setTimeout(() => finish(ended(code, signal)), EXIT_DRAIN_MS);
    });
    child.on("close", (code, signal) => finish(ended(code, signal)));
    child.stdin.on("error", () => {
      // EPIPE: a guard that exits without reading its payload; its exit decides the run
    });
    try {
      child.stdin.end(input);
    } catch {
      // as above: a guard that closed stdin early is judged by how it ends
    }
  });
}

/** Per-line facts the shared classifier does not read: Gemini-native decisions, CC rewrites, reasons. */
function geminiFacts(stdout) {
  let geminiBlock = false;
  let rewrite = false;
  const reasons = [];
  for (const line of String(stdout || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    if (obj.decision === "block" || obj.decision === "deny") geminiBlock = true;
    const hso = obj.hookSpecificOutput;
    if (hso && typeof hso === "object" && Object.prototype.hasOwnProperty.call(hso, "updatedInput")) rewrite = true;
    for (const r of [hso && hso.permissionDecisionReason, obj.reason, obj.stopReason]) {
      if (typeof r === "string" && r.trim()) reasons.push(r.trim());
    }
  }
  return { geminiBlock, rewrite, reasons };
}

const MAX_REASON_CHARS = 64 * 1024;
function clip(s) {
  const t = String(s || "");
  return t.length > MAX_REASON_CHARS ? `${t.slice(0, MAX_REASON_CHARS)}\n[…truncated by ${ADAPTER}]` : t;
}

function denyReply(reason, { stop = false } = {}) {
  const body = { decision: "deny", reason: clip(reason) };
  if (stop) {
    body.continue = false;
    body.stopReason = body.reason;
  }
  return JSON.stringify(body) + "\n";
}

/**
 * The adapter's refusal text. The kinds only this boundary has (a malformed registration,
 * containment, a missing guard, an unapplied rewrite, the adapter's own fault) are worded
 * here; every ending the RUNNER also names — a budget overrun, an unreadable payload, an
 * exit that is no verdict — is the runner's own text, `guard-runner.js::REFUSAL_TEXT` (the
 * ONE refusal-text source), so the three refusers say the same words. `texts` is null only
 * before guard-runner.js has loaded, where none of those endings can arise.
 */
function refusalText(name, kind, detail, texts) {
  const g = name || "<unnamed guard>";
  switch (kind) {
    case "argv":
      return `${ADAPTER}: refused — the Gemini hook registration is malformed: ${detail}. A registration that names no known guard cannot clear the call.`;
    case "containment":
      return `${ADAPTER}: refused — ${g} failed path containment: ${detail}.`;
    case "missing":
      return `${ADAPTER}: refused — ${g} is not installed (${detail}). A deny-capable guard that cannot run cannot clear the call.`;
    case "rewrite":
      return `${ADAPTER}: refused — ${g} answered with a rewrite of the call (hookSpecificOutput.updatedInput), which Gemini does not apply; running the un-rewritten call would not be the call the guard allowed.`;
    case "runtime":
      return `${ADAPTER}: refused — the adapter itself could not run (${detail}).`;
    default:
      break;
  }
  const runnerKind = kind === "timeout" || kind === "budget" ? "budget" : kind === "unreadable" ? "unreadable" : "exit";
  if (texts && typeof texts.refusalText === "function") {
    return `${ADAPTER}: refused — ${texts.refusalText(g, runnerKind, runnerKind === "exit" ? `${kind}: ${detail}` : detail)}`;
  }
  return `${ADAPTER}: refused — ${g} ended without a verdict (${kind}: ${detail}), and the refusal text (guard-runner.js::REFUSAL_TEXT) was not loaded.`;
}

/**
 * The whole boundary as a function: { argv, env, stdin, hooksDir, cwd, guards } ->
 * { stdout, stderr, exitCode }. Never throws. `hooksDir` and `guards` exist for the test
 * harness, which runs this function against a sandbox; the CLI below passes this file's own.
 */
async function runAdapter(opts) {
  const o = opts || {};
  const guards = o.guards || GUARDS;
  let texts = null;
  const refuse = (name, kind, detail, extraStderr) => {
    const text = refusalText(name, kind, detail, texts);
    return { stdout: denyReply(text), stderr: `${text}\n${extraStderr ? String(extraStderr) : ""}`, exitCode: 2 };
  };
  try {
    const parsed = parseArgv(o.argv, guards);
    if (!parsed.ok) return refuse(null, "argv", parsed.reason);
    const name = parsed.name;
    const row = guards[name];
    if (!budgetFits(row)) return refuse(name, "runtime", `the ${name} row's budget does not end before Gemini's ${HOST_TIMEOUT_MS} ms hook timeout`);
    const advise = (kind, detail, extraStderr) => ({
      stdout: "",
      stderr: `${ADAPTER}: ${name} did not complete (${kind}: ${detail}); this row declares on_incomplete "continue", so the call is NOT refused.\n${extraStderr ? String(extraStderr) : ""}`,
      exitCode: 1,
    });
    const notDone = (kind, detail, extraStderr) => (row.canDeny ? refuse(name, kind, detail, extraStderr) : advise(kind, detail, extraStderr));

    let hooksDir;
    try {
      hooksDir = fs.realpathSync(o.hooksDir || path.resolve(__dirname, ".."));
    } catch (e) {
      return refuse(name, "containment", `the hooks directory does not resolve (${e && e.code ? e.code : e})`);
    }
    const resolved = resolveGuard(hooksDir, name);
    if (!resolved.ok) {
      // A path that fails containment is a trust failure, refused for every row; a guard
      // that is simply absent follows the row's own incomplete contract.
      if (resolved.kind === "containment") return refuse(name, "containment", resolved.detail);
      return notDone(resolved.kind, resolved.detail);
    }

    let runner;
    try {
      runner = require("./guard-runner.js");
      // R2 NEW-A: a runner that loads but lacks the functions used below (an emptied file) is
      // the same condition as one that will not load.
      for (const fn of ["readPayload", "stdoutFacts", "classify"]) {
        if (!runner || typeof runner[fn] !== "function") throw new Error(`it exports no ${fn} function`);
      }
    } catch (e) {
      return notDone("runtime", `guard-runner.js did not load (${e && e.message ? e.message : e})`);
    }
    texts = runner.REFUSAL_TEXT || null;

    let payload;
    try {
      payload = await runner.readPayload({ stream: o.stdin || process.stdin, timeoutMs: STDIN_TIMEOUT_MS });
    } catch (e) {
      const kind = e && e.kind === "budget" ? "budget" : "unreadable";
      return notDone(kind, e && e.reason ? e.reason : e && e.message ? e.message : String(e));
    }

    const root = path.resolve(hooksDir, "..", "..");
    let env;
    try {
      env = scrubEnv(o.env || process.env, root);
    } catch (e) {
      return notDone("runtime", `the guard child's env scrub did not load (${e && e.message ? e.message : e})`);
    }
    const ran = await runChild(resolved.file, JSON.stringify(payload), row.budgetMs, env, o.cwd || process.cwd());

    const facts = { ...runner.stdoutFacts(ran.stdout), exitCode: ran.exitCode };
    if (ran.verdict) facts.verdict = ran.verdict;
    let verdict = runner.classify(facts, { canDeny: row.canDeny }).verdict;
    const g = geminiFacts(ran.stdout);
    if (g.geminiBlock && (verdict === "allow" || verdict === "surface")) verdict = "deny";
    if (g.rewrite && row.canDeny && (verdict === "allow" || verdict === "surface")) return refuse(name, "rewrite", "", ran.stderr);

    if (verdict === "allow" || verdict === "surface") return { stdout: ran.stdout, stderr: ran.stderr, exitCode: 0 };
    if (verdict === "deny") {
      const reason = g.reasons[0] || String(ran.stderr || "").trim() || `${name} refused the call`;
      return { stdout: denyReply(reason, { stop: facts.continueFlag === false }), stderr: ran.stderr, exitCode: 2 };
    }
    const detail = ran.detail || (Number.isInteger(ran.exitCode) ? `exit ${ran.exitCode}` : "no exit code");
    return notDone(ran.verdict === "timeout" ? "budget" : verdict, detail, ran.stderr);
  } catch (e) {
    // Any fault of this boundary itself is a refusal: the guard's verdict was never established.
    return refuse(null, "runtime", e && e.message ? e.message : String(e));
  }
}

/** Write every byte, retrying a pipe that is momentarily full (macOS pipes are non-blocking). */
function writeAllSync(fd, text) {
  const buf = Buffer.from(String(text || ""), "utf8");
  let off = 0;
  let spins = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
      spins = 0;
    } catch (e) {
      if (e && e.code === "EAGAIN" && spins++ < 100000) continue;
      return false;
    }
  }
  return true;
}

async function main() {
  const r = await runAdapter({ argv: process.argv.slice(2), env: process.env, stdin: process.stdin });
  writeAllSync(1, r.stdout);
  writeAllSync(2, r.stderr);
  process.exit(r.exitCode);
}

module.exports = {
  GUARDS,
  HOST_TIMEOUT_MS,
  STDIN_TIMEOUT_MS,
  budgetFits,
  parseArgv,
  resolveGuard,
  scrubEnv,
  registrationCommand,
  geminiFacts,
  runAdapter,
};

if (require.main === module) {
  main().catch((e) => {
    // runAdapter never rejects; this is the last line of defence for the write itself.
    try {
      fs.writeSync(1, denyReply(`${ADAPTER}: refused — ${e && e.message ? e.message : e}`));
    } catch {
      // the exit code below is the refusal
    }
    process.exit(2);
  });
}
