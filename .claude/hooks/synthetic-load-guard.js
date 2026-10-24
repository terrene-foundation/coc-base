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
 * FAILS CLOSED ON A RUN THAT CANNOT FINISH (`cc-artifacts.md` Rule 7, deny rows): the run is
 * owned by `lib/guard-runner.js::runGuard`, so a throw (a sub-parse, a library that will not load),
 * a run past the budget, or an unreadable payload REFUSES the call — on every host, not only Codex.
 * The earlier disposition accepted the opposite on purpose (an input crafted to make a sub-parse
 * throw, or to outlast the 5 s timer, ran the command); that residual is CLOSED, because any input
 * that made this guard throw was a bypass of it. What still passes is a COMPLETED verdict: a call
 * with no command, or a command the classifier reads as no load generator. A broken override
 * channel still degrades a block to halt-and-report rather than refusing with no escape — that is
 * a verdict the guard reaches and reports, not a crash.
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

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [
 *       ".claude/load-authz/synthetic-load-allow",
 *       ".claude/load-authz/.override-claim-<mkdtemp>/receipt",
 *       "<main-checkout>/.claude/learning/override-receipt-uses.jsonl"
 *     ],
 *     "network": false,
 *     "spawns": ["git"]
 *   },
 *   "idempotent": false,
 *   "may_rewrite_input": false,
 *   "notes": "On a block-class call with a matching, unexpired receipt, consumption renames the public receipt into a private same-parent 0700 `.override-claim-<mkdtemp>/receipt`, validates the claimed bytes, records the use under the main checkout, then cleans up the private claim. Validation or recording failure restores the original inode bytes without overwriting a newer public receipt; a collision retains private custody and reports refusal. Recorded cleanup failure never rearms the public receipt. Source: .claude/hooks/lib/override-receipt.js:656-685,896-1005. The consumed receipt cannot authorize a repeat payload, so idempotent is false. spawns: one `git rev-parse --path-format=absolute --show-toplevel --git-common-dir` (via lib/event-git.js) on the block path, to find the MAIN checkout for receipt lookup, and on the honour path the main-checkout probe lib/append-sink.js::mainCheckoutBoundaryRoots makes for the use ledger (same canonical question). Receipt candidates resolve in the invoking tree or a resolved root."
 * }
 */

const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { runGuard } = require("./lib/guard-runner.js");
const { emit } = require("./lib/instruct-and-wait.js");

// The out-of-engine run budget handed to runGuard (inside the dispatcher the row's own
// registered 8s is the bound and this value is unused). It bounds the WHOLE run, and a
// run past it is REFUSED, not passed through: 6500 sits below the 8s registration
// (measured direct run 1.9s under load, dispatch-registry `_timeout_note`).
const TIMEOUT_MS = 6500;
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
    const { askOnce, eventGitKey } = require(path.join(__dirname, "lib", "event-git.js"));
    // Canonical common-dir argv; sharing requires the complete question key:
    // binary, cwd, argv and envelope (.claude/hooks/lib/event-git.js:53-56).
    // Matching argv alone does not share answers across environment profiles.
    const CANONICAL = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"];
    const bin = resolveGitBinary();
    if (bin) {
      const probe = askOnce(
        eventGitKey({ gitBin: bin, cwd, args: CANONICAL, envelope: "gitEnv" }),
        () => {
          try {
            const out = execFileSync(bin, CANONICAL, {
              cwd,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
              timeout: 1500,
              killSignal: "SIGKILL",
              env: gitEnv(),
            });
            return { ok: true, value: String(out || "").trim() };
          } catch (err) {
            return { ok: false, reason: String((err && err.message) || err) };
          }
        },
      );
      const lines = probe.ok
        ? String(probe.value || "")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const common = lines.length ? lines[lines.length - 1] : "";
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
 * @param {string}   [o.toolName]   the payload's `tool_name` — part of the call digest a receipt
 *                                  must name (`lib/override-receipt.js` § THE CALL DIGEST)
 * @param {object}   [o.consumer]   the consuming party's identity for the use ledger
 *                                  (`lib/override-receipt.js::consumerOf(payload)`)
 */
function decide({ command, cwd, env, extraRoots, toolName, consumer } = {}) {
  if (typeof command !== "string" || !command.trim()) return null;
  // A library that will not load is NOT "no finding": it throws out of here, and the run
  // that cannot finish is refused (guard-runner.js::runGuard / the dispatcher's
  // on_incomplete:"deny"). Returning null here used to make a missing lib a silent allow.
  const L = require(path.join(__dirname, "lib", "synthetic-load.js"));
  const O = require(path.join(__dirname, "lib", "override-receipt.js"));
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
  // THE CALL DIGEST — a receipt lifts only the command it was written for: this tool, this
  // exact command string, and the ids of the findings that block it. The command is the
  // digest's principal input for every shell tool (`callPromptOf` reads `command`).
  const digest = O.callDigestOf(
    typeof toolName === "string" ? toolName : "",
    { command },
    blocks.map((f) => f.rule_id),
  );
  const override = gate.resolveOverride({ digest, env: effectiveEnv, consumer });
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
      `Only if generating load is itself the task the operator assigned: ${gate.formatOverrideInstruction(digest)}`,
    ],
    agent_must_wait:
      "Do not re-issue this command or any respelling of it. Reproduce the failure without load; use " +
      "the override only when the operator explicitly asked for load generation.",
    user_summary: `${RULE_ID} — refused a CPU load generator (${safeField(blocks[0].matched, "?", 40)})`,
  };
}

// main — the decision over the PARSED payload. guard-runner.js reads and parses stdin
// (an empty, unparseable or non-object payload REFUSES there and never reaches here)
// and owns the budget. Nothing below catches a throw: a classifier or library failure
// is a run that never reached a verdict, which the runner (or, in the engine, the
// dispatcher's on_incomplete:"deny") refuses. The old `.catch` passed the call through
// on every host but Codex — a throw was a bypass of this guard.
function main(payload) {
  const command = payload.tool_input && payload.tool_input.command;
  if (typeof command !== "string" || !command) return passthrough();
  let consumer;
  try {
    consumer = require(path.join(__dirname, "lib", "override-receipt.js")).consumerOf(payload);
  } catch {
    consumer = undefined; // identity is ledger metadata; its absence never decides anything
  }
  const decision = decide({
    command,
    cwd: payload.cwd || process.cwd(),
    env: process.env,
    toolName: payload.tool_name,
    consumer,
  });
  if (!decision) return passthrough();
  return emit(decision);
}

function passthrough() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). A require() has no side effects.
const hookMain = runGuard("synthetic-load-guard", main, { budgetMs: TIMEOUT_MS });

module.exports = { decide, mainCheckoutRoots, RECEIPT_REL, ENV_VAR, TIMEOUT_MS, hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
