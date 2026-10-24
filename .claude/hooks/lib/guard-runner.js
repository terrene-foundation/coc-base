"use strict";
/**
 * guard-runner — THE FAIL-CLOSED RUN BOUNDARY FOR A DENY-CAPABLE GUARD.
 *
 * WHY THIS EXISTS. A guard whose registry row declares `on_incomplete: "deny"` exists to
 * REFUSE a call. Before this module every such guard carried its own top-level try/catch,
 * its own timeout timer and its own stdin reader, and each of them failed OPEN: a catch
 * that printed `{"continue":true}` and exited 1 (the dispatcher read that as a completed
 * pass), a timer that did the same, a `.catch(() => passthrough())` that exited 0, and a
 * stdin reader (`read-stdin-bounded.js`) that resolved `{}` on a timeout, a parse error or
 * an overflow — which the guard then read as "not my tool" and allowed. Any input that
 * made a guard throw was therefore a bypass of that guard. This module is the ONE place a
 * deny-capable guard's run ends, and every ending other than a completed verdict REFUSES.
 *
 * THE CONTRACT (frozen for the guards that build on it):
 *
 *     const { runGuard } = require("./lib/guard-runner.js");
 *     async function main(payload, ctx) { ...decide...; deny via instruct-and-wait.js::emit; allow by returning }
 *     const hookMain = runGuard("<guard-file-basename>", main, { budgetMs: 5000 });
 *     module.exports = { hookMain };
 *     if (require.main === module) hookMain();
 *
 *   runGuard(name, main, { budgetMs, standalone, refusal }) -> hookMain
 *     name        the guard's file basename without `.js`; named in every refusal.
 *     main        (payload, ctx) -> any | Promise. `payload` is the parsed hook payload (a
 *                 JSON object); `ctx` is frozen { guard, raw, inEngine, budgetMs }.
 *     budgetMs    integer 1..600000. The bound for a run OUTSIDE the engine. Inside the
 *                 engine the registry row's own timeout is the bound (the engine enforces
 *                 it) and this value is not used: the runner arms NO timer there.
 *     standalone  optional boolean. `true` declares a guard registered DIRECTLY with its
 *                 host (settings-deny-edit-guard): its host reads only the exit code, so
 *                 even inside the engine (only reachable through hook-engine.js::runCli's
 *                 selftest path) the runner emits its refusal itself, as exit 2.
 *     refusal     optional { recovery?, escalate? } — STATIC per-guard refusal metadata,
 *                 declared here at registration and validated at load (a malformed value
 *                 is a TypeError, like `standalone`), never computed on a failure path.
 *                 `recovery` is one line the guard's own refusals always carried (what the
 *                 agent does next); `escalate` is the ALWAYS-ESCALATE class the guard's
 *                 refusals route to the human (instruct-and-wait.js `escalate`). Both ride
 *                 every refusal the RUNNER builds, and the GuardRunError it re-throws in
 *                 the engine (see NAMED RESIDUALS for what the dispatcher's text carries).
 *
 * WHAT A RUN ENDS AS. Two modes, chosen per call (never by the guard):
 *
 *   IN THE ENGINE — `lib/hook-engine.js` holds a live run (its `_state.current`, read from
 *   require.cache). The engine already owns stdout/stderr capture, `process.exit`, the
 *   per-row budget, and the uncaught-exception boundary, and a deny row that CRASHES is
 *   refused by the dispatcher (`hook-engine.js::incompleteDenyReason` -> "crashed", with
 *   the dispatcher's own refusal text and repair hatch). So the runner arms nothing here:
 *   a throw, a rejection or an unreadable payload is RE-THROWN as a `GuardRunError` naming
 *   the guard and the kind, which the engine records as the row's crash. The engine's exit
 *   sentinel is the one thrown value that is NOT a crash: a guard's own `process.exit(c)`
 *   inside the engine throws it, and the runner re-throws it UNCHANGED, classified by
 *   `hook-engine.js::isEngineExit` (identity against the engine's private frozen
 *   singleton). A shape test (`e && e.__hookEngineExit`) is never used: a forged lookalike
 *   is a crash like any other thrown value. A guard that RETURNS with `process.exitCode`
 *   set is judged as standalone judges it (runInEngine::settleExitCode): unset or 0 passes,
 *   2 is its refusal (re-issued as the engine's exit 2), any other code is refused as an
 *   `exit` ending — the engine itself never reads exitCode for a module row.
 *
 *   OUTSIDE THE ENGINE — a process of its own (`node <guard>.js`: a direct registration,
 *   the Codex runtime, the local supervisor, a Gemini adapter, a test). The runner OWNS
 *   the process: it arms the budget timer, installs `uncaughtException` /
 *   `unhandledRejection`, buffers stdout (process.stdout.write and fs.writeSync on fd 1),
 *   and routes `process.exit` through ONE latch, so exactly one reply and one exit code
 *   ever leave the process. The FIRST ending wins — the guard's exit, its return, a throw,
 *   a rejection, the budget, an unreadable payload — and is classified by `classify()`
 *   (parity with codex-mcp-guard/policy-outcome.js::classifyPolicyOutcome, canDeny=true):
 *     allow / surface        the guard's buffered reply and exit code go out unchanged
 *     deny                   the guard's own refusal goes out (forced to exit 2 when the
 *                            reply is not one JSON object a host can parse)
 *     anything else          (crash, warn-denied, ask-denied, timeout, error, missing)
 *                            the guard's buffered reply is DISCARDED and the runner's
 *                            refusal goes out instead, exit 2, naming the guard.
 *   A run that RETURNS settles one macrotask later, so a rejection the guard left
 *   unawaited during its own run is seen first and refuses; anything scheduled after the
 *   verdict never runs (the process ends at the verdict, as a real one does).
 *
 * PER EVENT, "anything else" is disposed of by the DISPATCHER'S OWN TABLE — the ONE
 * per-event policy for an incomplete deny-capable check,
 * `dispatch-main.js::incompleteDenyDisposition` (imported, never copied here), so a
 * standalone run and the same row in the engine end the same way:
 *     refuse      PreToolUse; Stop / SubagentStop while `stop_hook_active` is not true
 *                 (the refusal above, exit 2 — at a Stop it continues the turn ONCE);
 *                 an event the runner cannot name (unreadable payload)
 *     report      PostToolUse — the call already ran: the reason goes to the model as
 *                 additionalContext, exit 0, and on stderr
 *     allow-loud  Stop / SubagentStop on the refire (`stop_hook_active` true),
 *                 UserPromptSubmit, every other event — a stderr warning naming the
 *                 guard, exit 1, no reply
 * A Gemini event name is read as the CC event it carries before the table is asked
 * (eventOf / GEMINI_EVENT_SEMANTICS: BeforeTool → PreToolUse, AfterTool → PostToolUse,
 * BeforeAgent → UserPromptSubmit), so a Gemini stall keeps the budget refusal's wording.
 * A table that cannot be loaded (or answers anything else) yields the BUILT-IN
 * conservative default: PreToolUse refuse, Stop / SubagentStop block-once, an unnamed
 * event refuse, the rest allow-loud.
 *
 * A STOP REFUSAL IS BOUNDED (fc R-7 security L-3). The table's Stop / SubagentStop "refuse" is a
 * REQUEST, granted only through stop-refusal.js::refusalVerdict (refusalEnding ->
 * stopRefusalVerdict, budget key `guard-runner-standalone`): the host's `stop_hook_active` flag,
 * a per-session budget below the host's 8-block override, and the COC_STOP_REFUSAL kill switch.
 * It FAILS OPEN — no usable session_id, or a library that cannot load or throws, is allowed
 * LOUDLY with the declining bound named (hook-output-discipline.md MUST-6(b)). A PreToolUse
 * refusal is never bounded. NAMED RESIDUAL: an UNREADABLE payload names no event, so the table's
 * no-event row refuses it, unbudgeted — the runner cannot tell a Stop from a PreToolUse there
 * (nothing outside stdin names the event to a direct registration), and allowing it would let an
 * unreadable PreToolUse call run unvetted. At a direct Stop registration only the host's own
 * 8-block override bounds that case.
 *
 * THE RUNNER'S FAILURE PATH LOADS NO LIBRARY AT MODULE LOAD. Its renderer
 * (`instruct-and-wait.js`) and the per-event table above are loaded lazily, inside the
 * refusal, and a renderer that will not load yields the BUILT-IN refusal (the guard's
 * name, the reason class and its text on stderr; exit 2 is the refusal every host reads).
 * A missing library therefore cannot turn a refusal into node's own exit 1.
 *
 * ONE REFUSAL-TEXT SOURCE. `REFUSAL_TEXT` below is the only copy of the runner's refusal
 * sentences — the verbatim budget sentence, the retry sentence, and each ending's text.
 * The dispatcher (`dispatch-main.js::incompleteDenyRefusalText`), the Gemini adapter
 * (`gemini-hook-runtime.js::refusalText`) and guards that echo a sentence import it.
 *
 * THE PAYLOAD IS READ HERE (readPayload). It REJECTS — never resolves a default — on an
 * empty stdin, a terminal, a stream error, a parse error, a non-object JSON value, and a
 * payload over MAX_PAYLOAD_BYTES; a stdin that never ends is bounded by the budget. Each
 * of those refuses. A guard built on this module does not read stdin itself.
 *
 * NAMED RESIDUALS (not claimed closed):
 *   - a guard that blocks the event loop SYNCHRONOUSLY past its budget cannot be refused
 *     by a timer; the host's own timeout kills it (out of engine) or the engine's main
 *     thread cuts it (in engine);
 *   - a write to fd 1 by a path other than process.stdout.write / fs.writeSync (a child
 *     with stdio "inherit", fs.writeFileSync(1), a socket on fd 1) bypasses the buffer: a
 *     refusal still exits 2, which every host reads as the refusal, but the reply is then
 *     not the only thing on stdout;
 *   - `process.reallyExit` is not routed through the latch (an `exit` listener catches a
 *     real `process.exit` reached through a reference saved before the runner installed;
 *     nothing catches reallyExit);
 *   - in the engine, a guard that writes two replies and exits 0 is the engine's to judge
 *     (the runner cannot unwrite captured output there);
 *   - in the engine the DISPATCHER builds the refusal; the guard's `refusal` metadata
 *     reaches it as the outcome's `refusal` field (set on the live run at entry, carried
 *     across the worker boundary by hook-engine.js in shape only, validated by
 *     refusalMetaOf where the dispatcher renders it). A
 *     detector the engine cuts at its budget posts no outcome of its own, so a BUDGET
 *     refusal in the engine carries no metadata;
 *   - a GUARD that requires a library at its own top level fails to load before this
 *     module runs: standalone that is node's exit 1 (in the engine, a load-failed refusal).
 */

const fs = require("fs");
const path = require("path");

// The same 10 MiB ceiling read-stdin-bounded.js used — far above any real tool payload —
// but past it this reader REFUSES instead of resolving a default.
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const MAX_BUDGET_MS = 600000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The engine module's require.cache key. Node keys the cache by the resolved real
// filename, and this file's __dirname is already resolved, so this is the key the
// dispatcher's worker loaded `./hook-engine.js` under. Deliberately NOT require() and NOT
// require.resolve(): the runner never loads the engine (a standalone run must stay
// engine-free), and the engine is pinned as a runtime of its own, not as a dependency of
// every guard.
const ENGINE_FILE = path.join(__dirname, "hook-engine.js");

// ── THE ONE REFUSAL-TEXT SOURCE ──────────────────────────────────────────────────────────
// `budget` carries the two VERBATIM sentences the operator token rule requires (SHARD-PLAN
// §1). Every other module that says one of these sentences imports it from here.
const BUDGET_SENTENCE =
  "a guard time-out under load is a budget refusal, not a deny";
const retrySentence = (name) =>
  `Retry once; if it recurs, report ${name}'s budget and wait for the user`;

// Every kind of ending the runner refuses, and what it says about it.
const KIND_TEXT = Object.freeze({
  crash: (name, detail) =>
    `${name} crashed before reaching a verdict (${detail}). A deny-capable guard that cannot finish cannot clear the call, so the call is refused.`,
  unreadable: (name, detail) =>
    `${name} could not read its hook payload (${detail}). A guard that never saw the call cannot clear it, so the call is refused.`,
  budget: (name, detail) =>
    `${name} did not reach a verdict within its budget (${detail}): ${BUDGET_SENTENCE}. ${retrySentence(name)}.`,
  exit: (name, detail) =>
    `${name} ended without a verdict a host can read (${detail}). A deny-capable guard must finish with exit 0 or a refusal, so the call is refused.`,
});

/** The refusal text for one ending kind (an unknown kind reads as a crash). */
function refusalText(name, kind, detail) {
  const f = KIND_TEXT[kind] || KIND_TEXT.crash;
  return f(name, detail);
}

const REFUSAL_TEXT = Object.freeze({ BUDGET_SENTENCE, retrySentence, refusalText, KINDS: Object.freeze(Object.keys(KIND_TEXT)) });

// ── static per-guard refusal metadata (runGuard's `refusal` option) ─────────────────────
const MAX_RECOVERY_CHARS = 2000;
// Syntax only: the class itself is judged where every escalation is (instruct-and-wait.js
// via hook-findings.js::escalationClass, which renders an unknown class LOUDLY as
// `unclassified:`), so this module loads no library to validate it.
const ESCALATE_RE = /^[a-z][a-z-]{0,31}$/;

function validateRefusal(name, r) {
  if (r === undefined) return null;
  if (!r || typeof r !== "object" || Array.isArray(r) || ![Object.prototype, null].includes(Object.getPrototypeOf(r)))
    throw new TypeError(`runGuard(${name}): refusal must be a plain object { recovery?, escalate? } when given`);
  for (const k of Object.keys(r)) {
    if (k !== "recovery" && k !== "escalate") throw new TypeError(`runGuard(${name}): unknown refusal field ${JSON.stringify(k)}`);
  }
  const out = {};
  if (r.recovery !== undefined) {
    const t = r.recovery;
    if (typeof t !== "string" || !t.trim() || t.length > MAX_RECOVERY_CHARS || /[\x00-\x08\x0b-\x1f\x7f]/.test(t))
      throw new TypeError(`runGuard(${name}): refusal.recovery must be a non-empty string of at most ${MAX_RECOVERY_CHARS} characters with no control characters`);
    out.recovery = t.trim();
  }
  if (r.escalate !== undefined) {
    if (typeof r.escalate !== "string" || !ESCALATE_RE.test(r.escalate))
      throw new TypeError(`runGuard(${name}): refusal.escalate must be an escalation class name (got ${JSON.stringify(r.escalate)})`);
    out.escalate = r.escalate;
  }
  if (!Object.keys(out).length) throw new TypeError(`runGuard(${name}): refusal must declare recovery and/or escalate`);
  return Object.freeze(out);
}

/** The text a refusal adds for the guard's static metadata ("" when it declares none). */
function metadataText(meta) {
  if (!meta) return "";
  return (meta.recovery ? ` RECOVERY: ${meta.recovery}` : "") + (meta.escalate ? ` ESCALATE: ${meta.escalate}.` : "");
}

class GuardPayloadError extends Error {
  constructor(kind, reason) {
    super(reason);
    this.name = "GuardPayloadError";
    this.kind = kind; // "unreadable" | "budget"
    this.reason = reason;
  }
}

class GuardRunError extends Error {
  constructor(guard, kind, detail, cause, meta) {
    super(`guard-runner: ${KIND_TEXT[kind] ? KIND_TEXT[kind](guard, detail) : `${guard}: ${detail}`}${metadataText(meta)}`);
    this.name = "GuardRunError";
    this.guard = guard;
    this.kind = kind;
    if (meta) this.refusal = meta;
    if (cause !== undefined) this.cause = cause;
    const causeStack = cause && cause.stack ? String(cause.stack) : null;
    if (causeStack) this.stack = `${this.name}: ${this.message}\n    caused by: ${causeStack}`;
  }
}

function describe(e) {
  try {
    if (e instanceof GuardPayloadError) return e.reason;
    if (e && typeof e === "object" && typeof e.message === "string" && e.message)
      return `${e.name || "Error"}: ${e.message}`;
    if (e === undefined) return "a rejection with no reason";
    const s = JSON.stringify(e);
    return `a non-Error value was thrown: ${s === undefined ? String(e) : s.slice(0, 200)}`;
  } catch {
    return "an unrenderable value was thrown";
  }
}

// ── the engine, read from require.cache ONLY ─────────────────────────────────────────────
function engineExports() {
  try {
    const m = require.cache[ENGINE_FILE];
    return m && m.exports ? m.exports : null;
  } catch {
    return null; // a planted, throwing cache entry is no engine
  }
}

// The engine's identity classifier, bound ONCE it is first available (at this module's
// load in a dispatcher worker, which loads the engine before any guard; on first use when a
// guard loaded the runner before the engine, as hook-engine.js::runCli does). A classifier
// that accepts a FORGED shape is refused: it would read a lookalike as an exit.
let boundEngineExit = null;
function bindEngineExit() {
  if (boundEngineExit) return boundEngineExit;
  try {
    const eng = engineExports();
    const f = eng && eng.isEngineExit;
    if (typeof f !== "function") return null;
    if (f(Object.freeze({ __hookEngineExit: true })) !== false) return null;
    boundEngineExit = f;
    return f;
  } catch {
    return null;
  }
}
bindEngineExit();

/** Is `e` the engine's exit sentinel? Identity only; false whenever no engine is loaded. */
function isEngineExit(e) {
  const f = bindEngineExit();
  if (!f) return false;
  try {
    return f(e) === true;
  } catch {
    return false;
  }
}

/** The engine's live run, or null. Read synchronously at hookMain entry. */
function liveEngineRun() {
  try {
    const eng = engineExports();
    const st = eng && eng._state;
    if (!st || st.installed !== true) return null;
    const run = st.current;
    return run && typeof run === "object" && run.done === false ? run : null;
  } catch {
    return null;
  }
}

// ── the payload ──────────────────────────────────────────────────────────────────────────
/**
 * Read the whole hook payload from `stream`. Resolves { payload, raw }; REJECTS a
 * GuardPayloadError on every path that is not one complete JSON object.
 */
function readStdinPayload(opts = {}) {
  const stream = Object.prototype.hasOwnProperty.call(opts, "stream") ? opts.stream : process.stdin;
  const maxBytes = Number.isInteger(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : MAX_PAYLOAD_BYTES;
  const timeoutMs = Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : null;
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    let timer = null;
    const chunks = [];
    const detach = () => {
      try {
        stream.removeListener("data", onData);
        stream.removeListener("end", onEnd);
        stream.removeListener("error", onError);
      } catch {
        // a stream that cannot drop its listeners is about to be abandoned with the process
      }
    };
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      detach();
      if (err) reject(err);
      else resolve(value);
    };
    const fail = (kind, reason) => finish(new GuardPayloadError(kind, reason));
    function onData(c) {
      if (settled) return;
      const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c), "utf8");
      size += b.length;
      if (size > maxBytes) {
        try {
          stream.pause();
        } catch {
          // pausing is courtesy; the refusal does not depend on it
        }
        return fail("unreadable", `the payload exceeds ${maxBytes} bytes`);
      }
      chunks.push(b);
    }
    function onEnd() {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return fail("unreadable", "stdin was empty");
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        return fail("unreadable", `the payload is not JSON (${e && e.message ? e.message : e})`);
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return fail("unreadable", "the payload is not a JSON object");
      finish(null, { payload, raw });
    }
    function onError(e) {
      fail("unreadable", `stdin errored (${e && e.message ? e.message : e})`);
    }
    if (!stream || typeof stream.on !== "function") return fail("unreadable", "there is no stdin stream");
    if (stream.isTTY) return fail("unreadable", "stdin is a terminal, not a hook payload");
    try {
      stream.on("data", onData);
      stream.on("end", onEnd);
      stream.on("error", onError);
      if (typeof stream.resume === "function") stream.resume();
    } catch (e) {
      return fail("unreadable", `stdin could not be read (${e && e.message ? e.message : e})`);
    }
    if (timeoutMs) timer = setTimeout(() => fail("budget", `stdin did not end within ${timeoutMs} ms`), timeoutMs);
  });
}

/** Public form: resolves the parsed payload object, rejects GuardPayloadError. */
function readPayload(opts) {
  return readStdinPayload(opts).then((r) => r.payload);
}

// ── the classifier ───────────────────────────────────────────────────────────────────────
/**
 * The facts a host reads off a guard's stdout, extracted line by line exactly as
 * codex-mcp-guard/server.js::extractHookValidation + ::hasParseableHookDecision do: a
 * `continue:false` on ANY line, the most restrictive permissionDecision on any line, and
 * whether any line is a recognised hook record.
 */
const DECISION_RANK = { allow: 0, ask: 1, deny: 2 };
function stdoutFacts(stdout) {
  let continueFlag = null;
  let permissionDecision = null;
  let hasParseableDecision = false;
  let objects = 0;
  const lines = String(stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    objects++;
    if ("continue" in obj || "hookSpecificOutput" in obj || "systemMessage" in obj) hasParseableDecision = true;
    if (obj.continue === false) continueFlag = false;
    const pd = obj.hookSpecificOutput && obj.hookSpecificOutput.permissionDecision;
    if (
      typeof pd === "string" &&
      (permissionDecision === null || (DECISION_RANK[pd] ?? 3) > (DECISION_RANK[permissionDecision] ?? 3))
    )
      permissionDecision = pd;
  }
  let singleObject = false;
  const trimmed = String(stdout || "").trim();
  if (trimmed) {
    try {
      const whole = JSON.parse(trimmed);
      singleObject = !!whole && typeof whole === "object" && !Array.isArray(whole) && objects === 1;
    } catch {
      singleObject = false;
    }
  }
  return { continueFlag, permissionDecision, hasParseableDecision, singleObject, empty: !trimmed };
}

/**
 * THE VERDICT OF ONE GUARD RUN — the same rule, row for row, as
 * `.claude/codex-mcp-guard/policy-outcome.js::classifyPolicyOutcome` (the canonical copy;
 * `.codex-mcp-guard/policy-outcome.js` is its distributed twin). Kept as its own copy
 * because the hooks lib ships to trees that carry no Codex guard; the parity is pinned by
 * guard-runner.test.mjs, which runs both over the full fact matrix and reds on any drift.
 * A guard runner is deny-capable by construction, so `canDeny` defaults to true.
 */
function classify(facts, { canDeny = true } = {}) {
  const result = { ...facts, validation: null };
  if (["missing", "timeout", "error"].includes(facts.verdict)) return result;
  const code = facts.exitCode;
  if (!Number.isInteger(code)) return { ...result, verdict: "error" };
  if (code === 2 || facts.continueFlag === false || facts.permissionDecision === "deny") {
    return { ...result, verdict: "deny" };
  }
  if (canDeny !== false && code !== 0) {
    return { ...result, verdict: facts.hasParseableDecision ? "warn-denied" : "crash" };
  }
  if (facts.permissionDecision === "ask") {
    if (canDeny !== false) return { ...result, verdict: "ask-denied" };
    return {
      ...result,
      verdict: "surface",
      validation:
        facts.validation ||
        'Hook requested user confirmation (permissionDecision:"ask"); review before relying on it.',
    };
  }
  if (code === 0) {
    return facts.actionableValidation
      ? { ...result, verdict: "surface", validation: facts.validation }
      : { ...result, verdict: "allow" };
  }
  return { ...result, verdict: facts.hasParseableDecision ? "warn" : "crash" };
}

/** What the runner does with a verdict: let the guard's reply out, or refuse in its place. */
// `warn` (a non-zero exit of a row that cannot deny) is unreachable at canDeny=true and is
// deliberately NOT a pass: were it ever reached, a non-zero exit would leave the process.
const PASS_VERDICTS = new Set(["allow", "surface", "deny"]);
function disposition(verdict) {
  return PASS_VERDICTS.has(verdict) ? "pass" : "refuse";
}

// ── the refusal ──────────────────────────────────────────────────────────────────────────
// Events where a JSON refusal has a host-readable deny shape (instruct-and-wait.js block
// at a non-STOP_LIKE event). Anywhere else — a Stop-like event, or an event the runner
// never learned because the payload was unreadable — the refusal is stderr + exit 2 only,
// which every host reads, and no hand-back refusal shape is invented here.
const JSON_DENY_EVENTS = new Set(["PreToolUse", "PostToolUse", "UserPromptSubmit"]);
// Events whose exit 2 continues the turn and fires the event again (hook-engine.js STOP_LIKE).
const STOP_LIKE = new Set(["Stop", "SubagentStop"]);

function firstLine(e) {
  try {
    return String((e && e.message) || e).split("\n")[0].slice(0, 200);
  } catch {
    return "an unrenderable error";
  }
}

/**
 * The BUILT-IN refusal: what the runner says when its renderer (instruct-and-wait.js) will
 * not load or throws. It needs nothing but this file: the guard's name, the reason class,
 * the ending's text and the guard's static metadata, on stderr. Exit 2 — set by the caller —
 * is the refusal every host reads; no JSON shape is invented without the renderer.
 */
function builtInRefusal(cfg, kind, detail, why) {
  const text = refusalText(cfg.name, kind, detail) + metadataText(cfg.refusal);
  return {
    stdout: "",
    stderr: `[guard-runner] DENY ${cfg.name}: ${text}\n[guard-runner] built-in refusal (guard ${cfg.name}, reason class ${kind}) — the renderer lib/instruct-and-wait.js was unavailable (${why}); exit 2 carries the refusal.\n`,
    text,
  };
}

/** { stdout, stderr } for the runner's own refusal. Never throws. */
function buildRefusal(cfg, kind, detail, event, payload) {
  const name = cfg.name;
  const meta = cfg.refusal;
  const text = refusalText(name, kind, detail) + metadataText(meta);
  const stderr = `[guard-runner] DENY ${name}: ${text}\n`;
  if (!JSON_DENY_EVENTS.has(event)) return { stdout: "", stderr, text };
  try {
    // LAZY, inside the refusal: the renderer is a library, and the runner's failure path
    // must not depend on one at load (a missing renderer would be node's exit 1).
    const { instructAndWait } = require("./instruct-and-wait.js");
    const reasons = [`Guard: ${name}`, `Outcome: ${kind}`, `Detail: ${detail}`];
    if (kind === "budget") reasons.push(BUDGET_SENTENCE, retrySentence(name));
    if (meta && meta.recovery) reasons.push(`Recovery: ${meta.recovery}`);
    const out = instructAndWait({
      hookEvent: event,
      severity: "block",
      what_happened: text,
      why: "cc-artifacts.md Rule 7 — a deny-capable guard that does not reach a verdict refuses (guard-runner.js::runGuard)",
      agent_must_report: reasons,
      payload: payload || undefined,
      ...(meta && meta.escalate ? { escalate: meta.escalate } : {}),
    });
    if (!out || !out.json) return builtInRefusal(cfg, kind, detail, "it returned no reply");
    return { stdout: JSON.stringify(out.json) + "\n", stderr, text };
  } catch (e) {
    return builtInRefusal(cfg, kind, detail, firstLine(e));
  }
}

const DISPOSITIONS = new Set(["refuse", "report", "allow-loud"]);

/**
 * The BUILT-IN conservative default, used ONLY when the dispatcher's table will not load
 * or answers outside its contract: PreToolUse refuse, Stop / SubagentStop block-once (on
 * the host's `stop_hook_active`), an event that cannot be named refuse, the rest
 * allow-loud. Not a copy of the table — the floor beneath it.
 */
function builtInDisposition(event, payload) {
  if (typeof event !== "string" || !event) return "refuse";
  if (event === "PreToolUse") return "refuse";
  if (STOP_LIKE.has(event)) return payload && typeof payload === "object" && payload.stop_hook_active === true ? "allow-loud" : "refuse";
  return "allow-loud";
}

/**
 * What the ONE per-event table (`dispatch-main.js::incompleteDenyDisposition`, loaded
 * lazily on this path only) says for this event: { disposition, why } — `why` is null
 * when the table answered, else the reason the built-in default was used.
 */
function incompleteDisposition(event, payload) {
  try {
    const f = require("./dispatch-main.js").incompleteDenyDisposition;
    if (typeof f !== "function") return { disposition: builtInDisposition(event, payload), why: "dispatch-main.js exports no incompleteDenyDisposition" };
    const v = f(event, payload);
    if (!DISPOSITIONS.has(v)) return { disposition: builtInDisposition(event, payload), why: "the table answered outside its contract" };
    return { disposition: v, why: null };
  } catch (e) {
    return { disposition: builtInDisposition(event, payload), why: `the per-event table could not be loaded (${firstLine(e)})` };
  }
}

/**
 * The table's Stop / SubagentStop "refuse" is a REQUEST (fc R-7 security L-3;
 * hook-output-discipline.md MUST-6(b)), granted only through stop-refusal.js::refusalVerdict —
 * the host's `stop_hook_active` read by the LIBRARY from the raw document, a per-session budget
 * strictly below the host's 8-block override, and the COC_STOP_REFUSAL kill switch — exactly as
 * the dispatcher grants the same request for a row in the engine. FAIL OPEN: a refusal that
 * cannot be counted is not made. Uncountable is: no whole JSON document, or no usable session_id;
 * a library that cannot load or throws is "budget-unavailable". Returns {refuse, reason}.
 *
 * BUDGET KEY: `guard-runner-standalone` — the runner's own, DISTINCT from the dispatcher's
 * `dispatch-incomplete-deny` and engine-w1's `dispatch-stdin-bound`, so a direct registration and
 * the dispatcher never spend each other's slots.
 *
 * A LOCAL COPY of the countability gate in dispatch-main.js::stopRefusalVerdict, not a shared
 * helper, and on purpose: that function must stay byte-identical to engine-w1's (only its budget
 * key differs) so the landing merge deduplicates it, and it reads the dispatcher's module state
 * (`event`, STOP_SINK_ROOT) — so it can neither be re-pointed at a helper nor called from here.
 * The bounds themselves are NOT copied: both call the ONE library. Loaded lazily, inside the
 * refusal, like every library on the runner's failure path.
 */
const STOP_REFUSAL_BUDGET_KEY = "guard-runner-standalone";
const STOP_SINK_ROOT = path.resolve(__dirname, "..", "..", "..");
function stopRefusalVerdict(event, doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { refuse: false, reason: "uncountable-input: no whole JSON document arrived, so there is no stop_hook_active to read and no session to budget" };
  }
  if (typeof doc.session_id !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(doc.session_id) || doc.session_id === "unknown-session") {
    return { refuse: false, reason: "uncountable-input: the document names no usable session_id, so no per-session budget can count the refusal" };
  }
  try {
    const v = require("./stop-refusal.js").refusalVerdict(
      event,
      { payload: doc, repoDir: STOP_SINK_ROOT, budgetKey: STOP_REFUSAL_BUDGET_KEY },
      { nativeSubagentStop: event === "SubagentStop" },
    );
    return v && typeof v === "object" ? v : { refuse: false, reason: "budget-unavailable: no verdict" };
  } catch (e) {
    return { refuse: false, reason: `budget-unavailable: ${firstLine(e)}` };
  }
}

/** The runner's whole answer for an ending it does not let out, by the per-event table. */
function refusalEnding(cfg, kind, detail, payload) {
  const event = eventOf(payload);
  const asked = incompleteDisposition(event, payload);
  const why = asked.why;
  let d = asked.disposition;
  const fallback = why ? ` (built-in default: ${why})` : "";
  // A Stop-like "refuse" is the table's REQUEST; the loop bound grants or declines it. Only a
  // NAMED Stop-like event is bounded: PreToolUse — and an event the runner cannot name — keep
  // their refusal unbounded (an unvetted call does not run).
  let declined = null;
  if (d === "refuse" && STOP_LIKE.has(event)) {
    let v;
    try {
      v = stopRefusalVerdict(event, payload);
    } catch (e) {
      v = { refuse: false, reason: `budget-unavailable: ${firstLine(e)}` };
    }
    if (!v || v.refuse !== true) {
      d = "allow-loud";
      declined = (v && typeof v.reason === "string" && v.reason) || "unknown";
    }
  }
  if (d === "refuse") {
    const r = buildRefusal(cfg, kind, detail, event, payload);
    const once = STOP_LIKE.has(event)
      ? `[guard-runner] ${event} refused ONCE for ${cfg.name}${fallback}: on the refire (stop_hook_active true) it is allowed with a warning, never refused again; the refusal is counted against this session's budget (stop-refusal.js::refusalVerdict, key ${STOP_REFUSAL_BUDGET_KEY}).\n`
      : fallback
      ? `[guard-runner] refusal disposition${fallback}.\n`
      : "";
    return { stdout: r.stdout, stderr: r.stderr + once, exitCode: 2 };
  }
  if (declined !== null) {
    const text = refusalText(cfg.name, kind, detail) + metadataText(cfg.refusal);
    return {
      stdout: "",
      stderr:
        `[guard-runner] WARNING ${cfg.name} at ${event} — ALLOWED UNVETTED (the per-event policy asked to refuse${fallback}, but the hand-back refusal's loop bound DECLINED it (${declined}) — ` +
        `a refusal that cannot be counted is not made, hook-output-discipline.md MUST-6(b)): ${text}\n`,
      exitCode: 1,
    };
  }
  const text = refusalText(cfg.name, kind, detail) + metadataText(cfg.refusal);
  if (d === "report") {
    const note = `[guard-runner] NOTICE ${cfg.name} at ${event} — the call already ran UNVETTED: ${text}`;
    return {
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: note } }) + "\n",
      stderr: `${note}${fallback}\n`,
      exitCode: 0,
    };
  }
  return {
    stdout: "",
    stderr: `[guard-runner] WARNING ${cfg.name} at ${event} — ALLOWED UNVETTED (not refused here by the per-event policy${fallback}): ${text}\n`,
    exitCode: 1,
  };
}

/**
 * The guard's static refusal metadata, re-validated: a frozen { recovery?, escalate? }, or
 * null for anything that does not pass validateRefusal. Never throws — the DISPATCHER reads
 * it off an outcome that crossed a worker boundary (dispatch-main.js::refusalMetaOfOutcome),
 * and a malformed value is dropped, not propagated.
 */
function refusalMetaOf(v) {
  if (v === undefined || v === null) return null;
  try {
    return validateRefusal("engine-outcome", v);
  } catch {
    return null;
  }
}

// ── IN THE ENGINE ────────────────────────────────────────────────────────────────────────
function runInEngine(cfg, main) {
  const settleTick = () => new Promise((r) => setImmediate(r));
  // The guard's static metadata rides the engine's outcome (hook-engine.js forwards it
  // across the worker boundary), so the DISPATCHER's refusal carries it.
  if (cfg.refusal) {
    try {
      const run = liveEngineRun();
      if (run) run.refusal = cfg.refusal;
    } catch {}
  }
  const fail = (kind, e) => {
    if (isEngineExit(e)) throw e; // the guard's own process.exit — the engine already recorded it
    const detail = describe(e);
    if (!cfg.standalone) throw new GuardRunError(cfg.name, kind, detail, e, cfg.refusal);
    // A direct registration replayed in the engine (hook-engine.js::runCli selftest): its
    // host reads only the exit code, so the answer is emitted here — whatever the ONE
    // per-event table disposes (refusalEnding: refuse / report / allow-loud) — through the engine's
    // own exit (which records it and throws the sentinel out to the engine).
    const r = refusalEnding(cfg, kind, detail, lastPayload);
    process.stderr.write(r.stderr);
    if (r.stdout) process.stdout.write(r.stdout);
    process.exit(r.exitCode);
    throw new GuardRunError(cfg.name, kind, detail, e, cfg.refusal); // unreachable while the engine's exit throws
  };
  let lastPayload = null;
  return readStdinPayload({ stream: process.stdin }).then(
    ({ payload, raw }) => {
      lastPayload = payload;
      const ctx = Object.freeze({ guard: cfg.name, raw, inEngine: true, budgetMs: cfg.budgetMs });
      return Promise.resolve()
        .then(() => main(payload, ctx))
        .then(
          () => settleTick().then(() => settleExitCode()),
          (e) => fail("crash", e),
        );
    },
    (e) => fail(e instanceof GuardPayloadError ? e.kind : "unreadable", e),
  );
  // R1 MED-1. A guard that RETURNS after setting process.exitCode ended with that code, and
  // the engine never reads it for a module row (hook-engine.js reads it back only for
  // legacy-loaded rows, and resets it per row). Read here — after the settle tick, the same
  // moment runStandalone reads it through normalizeExitCode — and judged the same way:
  // unset / 0 is a return (pass), 2 is the guard's refusal (routed through the engine's own
  // exit so the engine records exit 2), anything else ends without a verdict a host reads
  // and is refused as kind "exit", exactly as standalone does.
  function settleExitCode() {
    const raw = process.exitCode;
    const code = normalizeExitCode(undefined);
    if (code === 0) return undefined;
    if (code === 2) {
      process.exit(2); // in the engine this throws its exit sentinel out to the engine, which records exit 2
      return undefined;
    }
    return fail("exit", new Error(`it set process.exitCode = ${JSON.stringify(raw) ?? String(raw)} and returned`));
  }
}

// R1 LOW-L2. Gemini names its events differently (Gemini CLI 0.41.2 bundle `HookEventName`:
// BeforeTool, AfterTool, BeforeAgent, Notification, AfterAgent, SessionStart, SessionEnd,
// PreCompress, BeforeModel, AfterModel, BeforeToolSelection), and the Gemini adapter hands a
// guard the payload unchanged. Unmapped, a BeforeTool stall fell to the table's allow-loud
// default (exit 1, no budget text) and only the adapter's own refusal saved it, losing the
// budget wording. Mapped HERE, onto the CC event whose semantics it carries, so the ONE
// per-event table answers for it: BeforeTool is PreToolUse (the call has not run: refuse),
// AfterTool is PostToolUse (it ran: report), BeforeAgent is UserPromptSubmit. The rest stay
// unmapped on purpose — AfterAgent / SessionEnd carry no `stop_hook_active` refire flag, so
// reading either as Stop would refuse without the bound a Stop refusal relies on.
const GEMINI_EVENT_SEMANTICS = Object.freeze({
  BeforeTool: "PreToolUse",
  AfterTool: "PostToolUse",
  BeforeAgent: "UserPromptSubmit",
});
function eventOf(payload) {
  const e = payload && typeof payload === "object" ? payload.hook_event_name : null;
  if (typeof e !== "string") return null;
  return Object.prototype.hasOwnProperty.call(GEMINI_EVENT_SEMANTICS, e) ? GEMINI_EVENT_SEMANTICS[e] : e;
}

// ── OUTSIDE THE ENGINE ───────────────────────────────────────────────────────────────────
function toText(chunk, enc) {
  if (chunk === undefined || chunk === null) return "";
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)
    return Buffer.from(chunk).toString(typeof enc === "string" ? enc : "utf8");
  return String(chunk);
}

/** Write all of `text` to fd with the real writeSync, riding EAGAIN; never throws. */
function writeAll(realWriteSync, fd, text) {
  if (!text) return true;
  const bytes = Buffer.from(text, "utf8");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 2000;
  let offset = 0;
  try {
    for (let attempts = 0; offset < bytes.length; attempts++) {
      if (attempts >= 10000 || Date.now() >= deadline) return false;
      try {
        const n = realWriteSync.call(fs, fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(n) || n < 0) return false;
        offset += n;
        if (n === 0) Atomics.wait(pause, 0, 0, 1);
      } catch (err) {
        if (!err || !["EAGAIN", "EWOULDBLOCK", "EINTR"].includes(err.code)) return false;
        Atomics.wait(pause, 0, 0, 1);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeExitCode(code) {
  if (code === undefined || code === null) {
    const pc = process.exitCode;
    if (pc === undefined || pc === null) return 0;
    const n = Number(pc);
    return Number.isInteger(n) ? n : null;
  }
  const n = typeof code === "string" && /^-?\d+$/.test(code) ? Number(code) : code;
  return Number.isInteger(n) ? n : null;
}

/** The final { stdout, stderr, exitCode } for one ending. Pure but for the refusal render. */
function resolveEnding(cfg, ending, stdout, payload) {
  let facts;
  if (ending.kind === "budget") facts = { verdict: "timeout", exitCode: -2 };
  else if (ending.kind === "unreadable") facts = { verdict: "error", exitCode: -3 };
  else if (ending.kind === "crash") facts = { exitCode: 1, ...stdoutFacts(stdout) };
  else {
    const code = normalizeExitCode(ending.code);
    facts = { exitCode: code === null ? NaN : code, ...stdoutFacts(stdout) };
  }
  const r = classify(facts);
  if (disposition(r.verdict) === "pass") {
    if (r.verdict === "deny" && !(facts.exitCode === 2 || (facts.exitCode === 0 && facts.singleObject))) {
      // The guard refused, but in a form a host would NOT read as a refusal: a JSON
      // refusal on a non-zero exit other than 2 (a host parses the reply only at exit 0 —
      // the deny-then-throw shape), or a refusal at exit 0 in a reply that is not ONE JSON
      // object (two lines, trailing prose). Exit 2 is the refusal every host reads.
      return {
        verdict: r.verdict,
        stdout,
        stderr:
          ending.kind === "crash"
            ? `[guard-runner] DENY ${cfg.name}: the guard refused and then crashed (${describe(ending.err)}); exit 2 carries the refusal.\n`
            : `[guard-runner] DENY ${cfg.name}: the guard refused in a reply no host reads as a refusal (exit ${facts.exitCode}, ${facts.singleObject ? "one JSON object" : "not one JSON object"}); exit 2 carries it.\n`,
        exitCode: 2,
      };
    }
    return { verdict: r.verdict, stdout, stderr: "", exitCode: facts.exitCode };
  }
  let kind;
  let detail;
  if (ending.kind === "budget") {
    kind = "budget";
    detail = ending.err ? describe(ending.err) : `${cfg.budgetMs} ms elapsed`;
  } else if (ending.kind === "unreadable") {
    kind = "unreadable";
    detail = describe(ending.err);
  } else if (ending.kind === "crash") {
    kind = "crash";
    detail = describe(ending.err);
  } else {
    kind = "exit";
    detail =
      r.verdict === "ask-denied"
        ? 'it asked for confirmation (permissionDecision:"ask"), which a deny-capable run does not honour'
        : Number.isInteger(facts.exitCode)
          ? `it exited ${facts.exitCode}${facts.hasParseableDecision ? " with a non-refusing reply" : ""}`
          : `it exited with a non-integer code (${String(ending.code)})`;
  }
  const ref = refusalEnding(cfg, kind, detail, payload);
  return { verdict: r.verdict, stdout: ref.stdout, stderr: ref.stderr, exitCode: ref.exitCode, kind };
}

function runStandalone(cfg, main) {
  const realExit = process.exit;
  const realStdoutWrite = process.stdout.write;
  const realWriteSync = fs.writeSync;
  const out = [];
  let settled = false;
  let timer = null;
  let payload = null;

  const settle = (ending, viaExitEvent) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    const fin = resolveEnding(cfg, ending, out.join(""), payload);
    if (fin.stderr) writeAll(realWriteSync, 2, fin.stderr);
    writeAll(realWriteSync, 1, fin.stdout);
    if (viaExitEvent) {
      process.exitCode = fin.exitCode;
      return;
    }
    process.exitCode = fin.exitCode;
    realExit.call(process, fin.exitCode);
  };

  process.stdout.write = function guardRunnerStdoutWrite(chunk, enc, cb) {
    if (!settled) out.push(toText(chunk, enc));
    const done = typeof enc === "function" ? enc : cb;
    if (typeof done === "function") process.nextTick(done);
    return true;
  };
  fs.writeSync = function guardRunnerWriteSync(fd, buffer, offset, length, position) {
    if (fd !== 1) return realWriteSync.apply(fs, arguments);
    if (typeof buffer === "string") {
      // fs.writeSync(fd, string[, position[, encoding]]): the encoding is the 4th argument
      // (or the 3rd, in the short form a caller may use).
      const enc = typeof length === "string" ? length : typeof offset === "string" ? offset : "utf8";
      if (!settled) out.push(buffer);
      return Buffer.byteLength(buffer, enc);
    }
    const view = Buffer.isBuffer(buffer)
      ? buffer
      : Buffer.from(buffer.buffer, buffer.byteOffset || 0, buffer.byteLength);
    const off = Number.isInteger(offset) ? offset : 0;
    const len = Number.isInteger(length) ? length : view.length - off;
    const slice = view.subarray(off, off + len);
    if (!settled) out.push(slice.toString("utf8"));
    return slice.length;
  };
  process.exit = function guardRunnerExit(code) {
    if (settled) return realExit.call(process, process.exitCode);
    settle({ kind: "exit", code });
    return undefined;
  };
  const onCrash = (e) => settle({ kind: "crash", err: e });
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  // A real process.exit reached through a reference saved before this run installed: the
  // ending is still classified, and the exit code still moved to the refusal if it must.
  process.once("exit", (code) => settle({ kind: "exit", code }, true));
  // Ref'd on purpose: a guard awaiting a promise that never settles holds no handle, and
  // without this timer node would exit 0 with nothing on stdout — a silent allow.
  timer = setTimeout(() => settle({ kind: "budget" }), cfg.budgetMs);

  readStdinPayload({ stream: process.stdin }).then(
    (r) => {
      if (settled) return undefined;
      payload = r.payload;
      const ctx = Object.freeze({ guard: cfg.name, raw: r.raw, inEngine: false, budgetMs: cfg.budgetMs });
      return Promise.resolve()
        .then(() => main(r.payload, ctx))
        .then(
          () => {
            setImmediate(() => settle({ kind: "exit", code: undefined }));
          },
          (e) => settle({ kind: "crash", err: e }),
        );
    },
    (e) => settle({ kind: e instanceof GuardPayloadError && e.kind === "budget" ? "budget" : "unreadable", err: e }),
  );
  return undefined;
}

// ── the entry ────────────────────────────────────────────────────────────────────────────
function runGuard(name, main, opts) {
  if (typeof name !== "string" || !NAME_RE.test(name))
    throw new TypeError(`runGuard: name must be the guard's file basename (got ${JSON.stringify(name)})`);
  if (typeof main !== "function") throw new TypeError(`runGuard(${name}): main must be a function`);
  if (!opts || typeof opts !== "object" || Array.isArray(opts))
    throw new TypeError(`runGuard(${name}): options { budgetMs[, standalone][, refusal] } are required`);
  for (const k of Object.keys(opts)) {
    if (k !== "budgetMs" && k !== "standalone" && k !== "refusal") throw new TypeError(`runGuard(${name}): unknown option ${JSON.stringify(k)}`);
  }
  const { budgetMs, standalone } = opts;
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > MAX_BUDGET_MS)
    throw new TypeError(`runGuard(${name}): budgetMs must be an integer in [1, ${MAX_BUDGET_MS}] (got ${JSON.stringify(budgetMs)})`);
  if (standalone !== undefined && typeof standalone !== "boolean")
    throw new TypeError(`runGuard(${name}): standalone must be a boolean when given`);
  const refusal = validateRefusal(name, opts.refusal);
  const cfg = Object.freeze({ name, budgetMs, standalone: standalone === true, refusal });
  function hookMain() {
    if (liveEngineRun()) return runInEngine(cfg, main);
    return runStandalone(cfg, main);
  }
  return hookMain;
}

module.exports = {
  runGuard,
  readPayload,
  classify,
  disposition,
  stdoutFacts,
  isEngineExit,
  GuardRunError,
  GuardPayloadError,
  MAX_PAYLOAD_BYTES,
  BUDGET_SENTENCE,
  REFUSAL_TEXT,
  refusalMetaOf,
  _resolveEnding: resolveEnding,
};
