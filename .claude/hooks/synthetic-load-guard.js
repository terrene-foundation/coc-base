#!/usr/bin/env node
"use strict";
/**
 * Synthetic-load guard — refuses a CPU load generator at the tool boundary.
 *
 * @hook-event: PreToolUse:Bash (guard) — launching load is a Bash action, and this is the one
 *   instant the pending command string exists BEFORE a process does: at SessionStart no command
 *   has been proposed, and by PostToolUse a busy loop is already burning a core on a machine
 *   other sessions share. Bash is the only tool that launches a process, so the matcher names it
 *   alone; the process-table backstop (session-load-backstop) covers launches this boundary
 *   cannot see (script files, sub-agent shells).
 *
 * Origin: co-owner-directed, receipt journal/0609 — a sub-agent "reproduced a flake under load"
 * with `node -e "const e=Date.now()+900*1000;while(Date.now()<e){}"` and drove a 16-core shared
 * machine to a load average of 319. Rule clause: ci-cost-discipline MUST-7.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * TWO SEVERITIES, AND WHY THE LINE FALLS WHERE IT DOES
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * BLOCK — `kind:"load-tool"`. The verdict is a command word at a PARSED argv position
 *   (`stress-ng`, `yes` to `/dev/null`, `openssl speed`, `dd if=/dev/zero of=/dev/null`), which
 *   `hook-output-discipline.md` MUST-5(a) names as fencing-grade. Every such block carries the
 *   audited one-shot override (`lib/override-receipt.js`), because a block with no escape is the
 *   MUST NOT "detector that blocks work the agent has been instructed to perform".
 *
 * HALT-AND-REPORT — `kind:"busy-loop"` / `kind:"fan-out"`, PERMANENTLY (MUST-5(b)). Whether an
 *   interpreter body "only reads the clock" is read from program TEXT, a lexical signal MUST-2
 *   caps below `block`. The command is allowed to run and the agent is told to stop it if it did
 *   start a loop.
 *
 * THE RECEIPT IS NEVER TOUCHED ON A NON-BLOCKING FINDING — deliberately. The override gate is
 * constructed only when a `block` finding exists. A halt-and-report does not stop the command, so
 * there is nothing to override; resolving the gate there would CONSUME a receipt the agent wrote
 * for a later, genuinely refused call, and a halt would silently spend the one shot. The same
 * reasoning orders env before receipt inside the gate.
 *
 * CROSS-CLI: gated on NEITHER `hook_event_name` NOR `tool_name`. The registration scopes this hook
 * per lane (CC `PreToolUse`/`Bash`, Codex `PreToolUse`/`shell`, Gemini `BeforeTool`/matcher
 * `bash|run_shell_command`); re-checking CC's literals here would make it inert on the other two
 * while every surface reported the lane covered — the pattern `ci-runner-saturation-guard.js`
 * records and measured.
 *
 * FAILS OPEN ON EVERY UNKNOWN (`cc-artifacts.md` Rule 7): no payload, no command, a library that
 * will not load, a gate that will not construct, the 5 s timer — all pass the call through. A
 * broken override channel degrades a block to halt-and-report rather than refusing with no escape.
 *
 * ACCEPTED RESIDUAL — FAIL-OPEN IS REACHABLE ON PURPOSE. The paragraph above is a disposition;
 * this names its cost. An input crafted to make a sub-parse THROW, or to outlast the 5 s timer,
 * is classified SILENT and the command runs. That is accepted, not deferred: the alternative is a
 * guard that wedges ordinary shell work on its own parse bugs, which is how a guard gets switched
 * off. The layer that sees what gets through is the process-table backstop, which reads processes
 * rather than command strings and so cannot be defeated by a spelling.
 *
 * NAMED RESIDUAL — the halt-and-report HEAD. The shared renderer (`lib/instruct-and-wait.js`)
 * heads a `halt-and-report` "NOT BLOCKED — the action ALREADY RAN", which is not true at the
 * instant a PreToolUse hook runs. It DOES carry a truthful register for exactly this moment —
 * `pre-action`, "the action has NOT run yet", gated on `hookEvent === "PreToolUse"` (read in
 * `instruct-and-wait.js`; it was added for a PreToolUse guide-first surface with the same
 * problem). It is NOT adopted here, for a structural reason: in that renderer the HEAD is a
 * function of `severity` alone, so selecting the truthful head would mean SHIPPING THE FINDING AS
 * `pre-action` — and this finding's severity is its CLASS, which `hook-output-discipline.md`
 * MUST-2/5(b) fixes at `halt-and-report` because a loop body is read lexically. Buying an accurate
 * head with an inaccurate class is the worse trade: the class is what the rule, the posture ledger
 * and the fixtures all key on. So the class is kept and the FATE is stated in the payload's own
 * words — `what_happened` opens "NOT refused — this command is being allowed to run", and
 * `agent_must_wait` says how to stop it if it started. No claim is made here about WHEN the
 * context reaches the agent relative to the command: that is the harness's delivery timing and
 * this lane has not measured it.
 */

const path = require("node:path");
const { execFileSync } = require("node:child_process");

const TIMEOUT_MS = 5000;
const RECEIPT_REL = ".claude/load-authz/synthetic-load-allow";
const ENV_VAR = "COC_ALLOW_SYNTHETIC_LOAD";

function ruleIdText() {
  // Single source: the library owns the id. The literal is only the fallback if it cannot load.
  try {
    return require(path.join(__dirname, "lib", "synthetic-load.js")).RULE_ID || "ci-cost-discipline/MUST-7";
  } catch {
    return "ci-cost-discipline/MUST-7";
  }
}

// Resolved ONCE. Every payload below reads THIS, never a re-typed literal: the library is the
// single source of the id, and a hard-coded copy in a `user_summary` is a second source that
// drifts silently the moment the clause is renumbered.
const RULE_ID = ruleIdText();

const WHY_CORE =
  RULE_ID +
  " (journal/0609). CPU on a shared machine is a purchased resource that " +
  "other sessions are using: synthetic load starves their work, and on 2026-09-12 a busy-loop " +
  '"reproduction" drove a 16-core machine to a load average of 319. A failure that appears only ' +
  "under load or on slow timing is a DETERMINISM bug, and it is reproduced by forcing the budget " +
  "(shrink the timeout or threshold the test depends on), injecting a clock, or stubbing the slow " +
  "call — never by generating load.";

/**
 * The MAIN checkout, so an operator's receipt is found even when the call comes from a linked
 * worktree. A callback, so git is spawned ONLY on the path that actually looks for a receipt.
 */
function mainCheckoutRoots(cwd, env) {
  const roots = [];
  const e = env && typeof env === "object" ? env : process.env;
  if (typeof e.CLAUDE_PROJECT_DIR === "string" && e.CLAUDE_PROJECT_DIR) roots.push(e.CLAUDE_PROJECT_DIR);
  try {
    const { resolveGitBinary, gitEnv } = require(path.join(__dirname, "lib", "git-subprocess-env.js"));
    const bin = resolveGitBinary();
    if (bin) {
      const out = execFileSync(bin, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500,
        killSignal: "SIGKILL",
        env: gitEnv(),
      });
      const common = String(out || "").trim();
      if (common && path.basename(common) === ".git") roots.push(path.dirname(common));
    }
  } catch {
    // Not a repo, no git, timed out — the invoking tree is still a candidate.
  }
  return roots;
}

function describe(findings, safeField) {
  return findings.map((f) => {
    const copies =
      f.kind === "fan-out" && f.copies !== null && f.copies !== undefined
        ? ` x${safeField(String(f.copies), "?", 20)}`
        : "";
    return `${f.kind} "${safeField(f.matched, "?", 40)}"${copies}: ${safeField(f.evidence, "(no excerpt)", 120)}`;
  });
}

function haltPayload(findings, safeField, note) {
  return {
    hookEvent: "PreToolUse",
    severity: "halt-and-report",
    what_happened:
      "NOT refused — this command is being allowed to run, and it appears to start CPU busy work: " +
      describe(findings, safeField).join("; ") +
      "." +
      (note ? ` ${note}` : ""),
    why:
      WHY_CORE +
      " A loop whose body only reads the clock or bumps a counter does no work except occupying a " +
      "core. This finding reads the loop's text, a lexical signal, so it cannot block " +
      "(hook-output-discipline MUST-2).",
    agent_must_report: [
      "Quote the command and the loop that was flagged.",
      "State whether it did start a busy loop, and if so, that you stopped it — name the PID you killed.",
      "If this is a false positive, name the line that makes the loop wait on real work (a sleep, a " +
        "read, an await) — that line is the evidence.",
    ],
    agent_must_wait:
      "If this command started a busy loop, stop it NOW, before any other step: interrupt it if it " +
      "is in the foreground; if it is in the background, find the PID THIS session started " +
      "(`ps -axo pid,ppid,pcpu,command | sort -k3 -nr | head`) and `kill <pid>`, then confirm with " +
      "`ps` that it is gone. Never pattern-kill (`pkill -f node`): that kills other sessions' " +
      "processes too. Do not relaunch it or any respelling of it.",
    user_summary: `${RULE_ID} — possible CPU busy loop (${safeField(findings[0].matched, "?", 40)}); not blocked, agent told to stop it`,
  };
}

/**
 * Decide what to emit for one command. Returns `null` (silent) or an `instructAndWait` payload.
 * Everything that varies is injectable, so the fixtures run hermetically.
 *
 * @param {object}   o
 * @param {string}   o.command      the Bash tool command string
 * @param {string}   o.cwd          the invoking tree (receipt candidate #1)
 * @param {object}   [o.env]        environment for the override channel; defaults to process.env
 * @param {function} [o.extraRoots] `() => string[]` extra receipt roots; defaults to the main checkout
 */
function decide({ command, cwd, env, extraRoots } = {}) {
  if (typeof command !== "string" || !command.trim()) return null;
  let L;
  let O;
  try {
    L = require(path.join(__dirname, "lib", "synthetic-load.js"));
    O = require(path.join(__dirname, "lib", "override-receipt.js"));
  } catch {
    return null;
  }
  const findings = L.classifyCommand(command);
  if (!Array.isArray(findings) || findings.length === 0) return null;
  const safeField = O.safeField;
  const blocks = findings.filter((f) => f.severity === "block");
  const halts = findings.filter((f) => f.severity !== "block");
  const invoking = typeof cwd === "string" && cwd ? cwd : process.cwd();
  const effectiveEnv = env && typeof env === "object" ? env : process.env;

  if (blocks.length === 0) return haltPayload(halts, safeField);

  let gate;
  try {
    gate = O.createOverrideGate({
      receiptRel: RECEIPT_REL,
      envVar: ENV_VAR,
      cwd: invoking,
      extraRoots: typeof extraRoots === "function" ? extraRoots : () => mainCheckoutRoots(invoking, effectiveEnv),
    });
  } catch {
    // No working escape ⇒ never a block the agent cannot lift. Degrade to the report tier.
    return haltPayload(findings, safeField, "(The override channel could not be constructed, so this load generator was NOT refused.)");
  }

  const list = describe(findings, safeField);
  const override = gate.resolveOverride(effectiveEnv);
  if (override) {
    return {
      hookEvent: "PreToolUse",
      severity: "advisory",
      what_happened: `A CPU load generator is being allowed to run under an override: ${list.join("; ")}. ${gate.formatOverrideLine(override)}`,
      why: WHY_CORE,
      agent_must_report: [
        "State that the synthetic-load refusal was overridden, and quote the stated reason recorded above.",
        "State the bound on this load — how long it runs and how many cores it takes — and check " +
          "`uptime` first: do not start it while the 1-minute load average exceeds the core count.",
        "When its purpose is served, stop every process it started and confirm with `ps` that none is still running.",
      ],
      agent_must_wait: "None — the override was honoured and the command proceeds. Report the override in your next message.",
      user_summary: `${RULE_ID} — load-generator refusal OVERRIDDEN (${safeField(blocks[0].matched, "?", 40)})`,
    };
  }

  const blockList = describe(blocks, safeField);
  const haltList = describe(halts, safeField);
  return {
    hookEvent: "PreToolUse",
    severity: "block",
    what_happened:
      `Refused before it ran — this command launches a synthetic CPU load generator: ${blockList.join("; ")}. ` +
      "Nothing was started." +
      (haltList.length ? ` Also flagged, not blocking on its own: ${haltList.join("; ")}.` : ""),
    why:
      WHY_CORE +
      " This refusal keys on the command word at its parsed argv position, not on text matching, " +
      "which is why it may block (hook-output-discipline MUST-5).",
    agent_must_report: [
      `Quote the refused command and name the load generator: ${blocks.map((f) => `"${safeField(f.matched, "?", 40)}"`).join(", ")}.`,
      "Say what you were trying to reproduce or measure, and the load-free way you will do it " +
        "instead: force the budget, inject a clock, or stub the slow call.",
      "Do not generate load another way (a different tool, a busy loop, a wrapper, a nested shell) — " +
        "that is the same act under a new spelling.",
      `Only if generating load is itself the task the operator assigned: ${gate.formatOverrideInstruction()}`,
    ],
    agent_must_wait:
      "Do not re-issue this command or any respelling of it. Reproduce the failure without load; use " +
      "the override only when the operator explicitly asked for load generation.",
    user_summary: `${RULE_ID} — refused a CPU load generator (${safeField(blocks[0].matched, "?", 40)})`,
  };
}

module.exports = { decide, mainCheckoutRoots, RECEIPT_REL, ENV_VAR, TIMEOUT_MS, hookMain };

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). It is the body the CLI guard
// used to hold, unchanged except that it returns the stdin promise.
function hookMain() {
  let timer = null;
  const passthrough = () => {
    if (timer) clearTimeout(timer);
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {
      // stdout gone; exiting 0 still lets the call through
    }
    process.exit(0);
  };
  // cc-artifacts.md Rule 7 — a hung guard blocks the session; a bounded one passes the call through.
  timer = setTimeout(passthrough, TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();

  let readStdinBounded;
  try {
    ({ readStdinBounded } = require(path.join(__dirname, "lib", "read-stdin-bounded.js")));
  } catch {
    passthrough();
  }
  return readStdinBounded({ fallback: null })
    .then((payload) => {
      if (!payload || typeof payload !== "object") return passthrough();
      const command = payload.tool_input && payload.tool_input.command;
      if (typeof command !== "string" || !command) return passthrough();
      const decision = decide({ command, cwd: payload.cwd || process.cwd(), env: process.env });
      if (!decision) return passthrough();
      let emit;
      try {
        ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
      } catch {
        return passthrough();
      }
      clearTimeout(timer);
      return emit(decision);
    })
    .catch((e) => {
      try {
        process.stderr.write(`[synthetic-load-guard] HOOK ERROR: ${e && e.message ? e.message : e}\n`);
      } catch {
        // ignore
      }
      // Codex's boundary must distinguish a failed validator from a clean
      // early return. Other hosts retain the historical advisory fallback.
      if (process.env.COC_RUNTIME === "codex") {
        clearTimeout(timer);
        process.stdout.write(JSON.stringify({ continue: true }) + "\n");
        process.exit(1);
      }
      passthrough();
    });
}

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
