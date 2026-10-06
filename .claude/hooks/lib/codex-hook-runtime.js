#!/usr/bin/env node
/** Codex native hook boundary. Root location follows this delivered script,
 * while cwd in the host payload continues to describe the actual session.
 * Native PreToolUse does not implement CC's ask/continue fields; normalize at
 * this boundary so shared CC/Gemini hooks keep their own output contracts.
 * Codex 0.158.0 rejects a bare allow decision; only allow+updatedInput is
 * supported. An ordinary successful hook exit needs no permission decision.
 * Reference: https://learn.chatgpt.com/docs/hooks (2026-09-28).
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ROOT = fs.realpathSync(path.resolve(__dirname, "../../.."));
const INPUT_TIMEOUT_MS = 2000;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
// ONE deadline for the whole native policy call — NOT a fresh one per
// rendering. The configured native hook timeout is 600s
// (`.claude/codex-templates/hooks.json`), so the call refuses from INSIDE the
// hook (exit 2) sixty seconds before the host could time it out: what the HOST
// does on its own hook timeout is UNMEASURED, and this design does not depend
// on it either way.
const NATIVE_CALL_BUDGET_MS = 540000;
// These are direct-handler roles, not replacements for native-policy's live
// registration inventory or its separate 550s/600s aggregate budget.
const HANDLERS = [
  ...["validate-bash-command.js", "validate-workflow.js", "validate-deployment.js",
    "ci-runner-saturation-guard.js", "synthetic-load-guard.js"]
    .map((name) => ({ name, validator: true, timeoutMs: 4000 })),
  { name: "integration-hygiene.js", timeoutMs: 10000 },
  { name: "session-load-backstop.js", timeoutMs: 10000 },
  { name: "session-start.js", timeoutMs: 20000 },
];

function canonicalFile(file) {
  let canonical;
  try { canonical = fs.realpathSync(file); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) throw new Error(`target hook not found: ${file}`, { cause: error });
    throw error;
  }
  if (!fs.statSync(canonical).isFile()) throw new Error(`target hook is not a regular file: ${file}`);
  return canonical;
}

function resolveTarget(targetArg, root = ROOT) {
  const target = canonicalFile(path.resolve(root, targetArg));
  let timeoutMs = Infinity;
  let validator = false;
  let hygiene = false;
  for (const handler of HANDLERS) {
    let known;
    try { known = canonicalFile(path.join(root, ".claude/hooks", handler.name)); }
    catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.cause?.code)) continue;
      throw error;
    }
    if (known !== target) continue;
    timeoutMs = Math.min(timeoutMs, handler.timeoutMs);
    validator ||= !!handler.validator;
    hygiene ||= handler.name === "integration-hygiene.js";
  }
  return { target, validator, hygiene, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 10000 };
}

function refusal(message, event = "PreToolUse") {
  const { instructAndWait } = require("./instruct-and-wait");
  const result = instructAndWait({
    hookEvent: event, severity: event === "PreToolUse" ? "block" : "advisory", what_happened: message,
    why: "The Codex policy boundary could not authorize this operation.",
    agent_must_report: ["Explain the refusal and resolve the stated policy or runtime failure."],
    agent_must_wait: "Do not retry the operation unchanged.",
    user_summary: event === "PreToolUse" ? "Codex policy refused the pending operation." : "Codex hook could not finish its check.",
  });
  return { stdout: JSON.stringify(result.json) + "\n", stderr: message + "\n", exitCode: event === "PreToolUse" ? result.exitCode : 1 };
}

function parseOutput(stdout) {
  try {
    const value = JSON.parse(stdout);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function normalizeRecord(event, result, toolName) {
  const out = { ...result };
  const json = parseOutput(out.stdout);
  if (event !== "PreToolUse") return out;
  if (!json) {
    if (out.exitCode !== 0 && out.exitCode !== 2) return refusal("Policy hook crashed without a decision.");
    return out;
  }
  if (json.hookSpecificOutput !== undefined && (!json.hookSpecificOutput || typeof json.hookSpecificOutput !== "object" || Array.isArray(json.hookSpecificOutput))) {
    return refusal("Policy supplied malformed hook-specific output.");
  }
  const h = json.hookSpecificOutput || {};
  if ((h.permissionDecision !== undefined && !["allow", "deny", "ask"].includes(h.permissionDecision)) ||
      (json.decision !== undefined && !["approve", "block"].includes(json.decision)) ||
      json.updatedInput !== undefined || json.permissionDecision !== undefined) {
    return refusal("Policy supplied an unsupported tool-control decision.");
  }
  const needsDecision = h.permissionDecision === "ask" || json.continue === false || json.decision === "approve";
  if (needsDecision) {
    const reason = [...new Set([h.permissionDecisionReason, json.stopReason, json.reason, h.additionalContext, h.validation, json.systemMessage]
      .filter((value) => typeof value === "string" && value.trim()))].join("\n\n") || "Policy requires authorization that this hook cannot grant.";
    return refusal(reason);
  }
  delete json.continue;
  delete json.suppressOutput;
  if (json.hookSpecificOutput) {
    json.hookSpecificOutput.hookEventName = event;
    if (typeof h.validation === "string") json.hookSpecificOutput.additionalContext = [...new Set([h.additionalContext, h.validation].filter(Boolean))].join("\n\n");
    delete json.hookSpecificOutput.validation;
  }
  if (h.permissionDecision === "deny" || json.decision === "block") {
    const reason = [...new Set([h.permissionDecisionReason, json.reason, h.additionalContext, json.systemMessage]
      .filter((value) => typeof value === "string" && value.trim()))].join("\n\n") || "Policy refused this operation.";
    json.hookSpecificOutput = { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason };
    delete json.decision;
    delete json.reason;
    delete json.systemMessage;
    out.exitCode = 2;
    out.stderr = `${out.stderr || ""}\n${reason}\n`;
  }
  if (json.hookSpecificOutput?.updatedInput !== undefined) {
    const rewrite = json.hookSpecificOutput;
    // An argv rewrite must SURVIVE this layer to reach the adapter's
    // classifier: `restoreNativeRewrite` is what knows the ORIGINAL command's
    // shape, and it maps an argv onto an argv (a passthrough hook echoing its
    // input) while refusing a scalar against an argv. Killing every non-string
    // command HERE made that mapping unreachable. The array admitted is the
    // same fail-closed shape the entry boundary admits — non-empty, all
    // strings, no empty elements — so an invalid argv still dies at this layer.
    const command = rewrite.updatedInput?.command;
    const argvRewrite = Array.isArray(command) && command.length > 0 &&
      command.every((part) => typeof part === "string" && part !== "");
    if (rewrite.permissionDecision !== "allow" || !rewrite.updatedInput || typeof rewrite.updatedInput !== "object" || Array.isArray(rewrite.updatedInput) ||
        ((NATIVE_SHELL_TOOLS.has(toolName) || toolName === "apply_patch") &&
         typeof command !== "string" && !argvRewrite)) {
      return refusal("Policy supplied an unsupported tool-input rewrite.");
    }
  }
  // A bare allow is rejected by the native runtime (measured on 0.158.0).
  // Success without a rewrite is expressed by exit 0, not an approval field.
  if (h.permissionDecision === "allow" && h.updatedInput === undefined) {
    delete h.permissionDecision;
    delete h.permissionDecisionReason;
  }
  // A deny must never carry a rewrite. Valid allow+updatedInput survives.
  if (json.hookSpecificOutput?.permissionDecision === "deny") delete json.hookSpecificOutput.updatedInput;
  // Emit only the supported PreToolUse envelope; preserve explanations from
  // legacy fields as context rather than leaking cross-event controls.
  const clean = {};
  if (typeof json.systemMessage === "string") clean.systemMessage = json.systemMessage;
  if (json.hookSpecificOutput) {
    const specific = json.hookSpecificOutput;
    clean.hookSpecificOutput = { hookEventName: event };
    for (const key of ["permissionDecision", "permissionDecisionReason", "updatedInput", "additionalContext"]) {
      if (specific[key] !== undefined) clean.hookSpecificOutput[key] = specific[key];
    }
  }
  const legacyContext = [json.reason, json.stopReason, json.validation].filter((v) => typeof v === "string" && v.trim());
  if (legacyContext.length) {
    clean.hookSpecificOutput ||= { hookEventName: event };
    clean.hookSpecificOutput.additionalContext = [clean.hookSpecificOutput.additionalContext, ...legacyContext].filter(Boolean).join("\n\n");
  }
  out.stdout = JSON.stringify(clean) + "\n";
  return out;
}


// Release behavior reference: https://learn.chatgpt.com/docs/hooks (2026-09-28).
// Output adaptation belongs here, never in shared CC/Gemini producers.
const COMMON_EVENTS = new Set(["SessionStart", "PreCompact", "PostCompact", "UserPromptSubmit", "SubagentStop", "Stop"]);
const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "SubagentStart", "PostToolUse"]);
const BLOCK_EVENTS = new Set(["PostToolUse", "UserPromptSubmit", "SubagentStop", "Stop"]);
function outputDetails(json) {
  return [json.systemMessage, json.reason, json.stopReason, json.validation,
    json.hookSpecificOutput?.additionalContext, json.hookSpecificOutput?.validation,
    json.hookSpecificOutput?.permissionDecisionReason, json.hookSpecificOutput?.decision?.message]
    .filter((v) => typeof v === "string" && v.trim());
}
function normalizeLifecycle(event, result) {
  if (!COMMON_EVENTS.has(event) && !CONTEXT_EVENTS.has(event) &&
      !["PermissionRequest", "SessionEnd", "Interrupt"].includes(event)) return { ...result };
  const text = String(result.stdout || "").trim();
  if (!text) return { ...result };
  const whole = parseOutput(text);
  const records = whole ? [whole] : text.split(/\r?\n/).filter((s) => s.trim()).map(parseOutput);
  const details = [...new Set(records.filter(Boolean).flatMap(outputDetails))];
  const explanation = details.join("\n\n");
  if (event === "SessionEnd") {
    // This lifecycle event cannot steer the thread. Preserve diagnostics, not
    // an apparent authorization/continuation decision the host ignores.
    return { ...result, stdout: "", stderr: [result.stderr, explanation].filter(Boolean).join("\n") };
  }
  if (records.some((r) => !r)) {
    if (["SessionStart", "UserPromptSubmit", "SubagentStart"].includes(event) && !/^[{[]/.test(text)) return { ...result };
    if (event === "PermissionRequest") return permissionRefusal("Permission hook emitted malformed JSON output.", result);
    return { ...result, stdout: "", stderr: [result.stderr, explanation, `Invalid ${event} hook JSON output.`].filter(Boolean).join("\n"), exitCode: result.exitCode || 1 };
  }
  if (event === "PermissionRequest") {
    let decision;
    for (const json of records) {
      const h = json.hookSpecificOutput || {};
      if (typeof h !== "object" || Array.isArray(h)) return permissionRefusal("Permission hook supplied invalid hook-specific output.", result);
      if ([json.updatedInput, json.updatedPermissions, json.interrupt, h.updatedInput, h.updatedPermissions, h.interrupt].some((v) => v !== undefined)) {
        return permissionRefusal(["Permission hook supplied a reserved control.", explanation].filter(Boolean).join("\n"), result);
      }
      if (json.continue === false || json.decision === "block" || ["deny", "ask"].includes(h.permissionDecision)) {
        return permissionRefusal(explanation || "Permission hook refused the request.", result);
      }
      if (h.decision !== undefined) {
        if (!h.decision || typeof h.decision !== "object" || Array.isArray(h.decision) || !["allow", "deny"].includes(h.decision.behavior) ||
            (h.decision.message !== undefined && typeof h.decision.message !== "string")) {
          return permissionRefusal("Permission hook supplied an invalid decision.", result);
        }
        // Reserved controls also occur inside the decision object. Dropping
        // them while retaining behavior:allow would approve a request whose
        // constraints the native host never applied.
        if (Object.keys(h.decision).some((key) => !["behavior", "message"].includes(key))) {
          return permissionRefusal(["Permission hook supplied an unsupported decision control.", explanation].filter(Boolean).join("\n"), result);
        }
        if (h.decision.behavior === "deny") return permissionRefusal(explanation || "Permission hook refused the request.", result);
        decision = { behavior: "allow" }; // Only an explicit native approval, never inferred.
      }
    }
    const out = {};
    if (explanation) out.systemMessage = explanation;
    if (decision) out.hookSpecificOutput = { hookEventName: event, decision };
    return { ...result, stdout: JSON.stringify(out) + "\n" };
  }
  const out = {};
  for (const json of records) {
    if (COMMON_EVENTS.has(event)) {
      if (typeof json.continue === "boolean" && out.continue !== false) out.continue = json.continue;
      if (typeof json.suppressOutput === "boolean") out.suppressOutput = json.suppressOutput;
      if (typeof json.stopReason === "string") out.stopReason = [out.stopReason, json.stopReason].filter(Boolean).join("\n");
    }
    if (event === "PostToolUse" && json.continue === false) {
      out.continue = false;
      if (typeof json.stopReason === "string") out.stopReason = [out.stopReason, json.stopReason].filter(Boolean).join("\n");
    }
    if (BLOCK_EVENTS.has(event) && json.decision === "block") {
      out.decision = "block";
      out.reason = [out.reason, json.reason].filter((v) => typeof v === "string" && v.trim()).join("\n") || "Hook requested further review.";
    }
  }
  const warnings = [...new Set(records.map((json) => json.systemMessage).filter((v) => typeof v === "string" && v.trim()))];
  const context = details.filter((v) => !warnings.includes(v) && v !== out.reason && v !== out.stopReason).join("\n\n");
  if (warnings.length) out.systemMessage = warnings.join("\n\n");
  if (context) {
    if (CONTEXT_EVENTS.has(event)) out.hookSpecificOutput = { hookEventName: event, additionalContext: context };
    else out.systemMessage = [out.systemMessage, context].filter(Boolean).join("\n\n");
  }
  return { ...result, stdout: JSON.stringify(out) + "\n" };
}
function permissionRefusal(message, result) {
  const denied = refusal(message);
  return { ...result, exitCode: 2, stderr: [result.stderr, denied.stderr].filter(Boolean).join("\n"), stdout: JSON.stringify({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: parseOutput(denied.stdout).hookSpecificOutput.permissionDecisionReason } },
  }) + "\n" };
}

// Native hosts require one JSON result. Shared hooks can emit several JSON
// records; parse every record before merging so an earlier refusal cannot be
// erased by a later context/allow record (or by a whole-stdout parse failure).
function normalizeOutput(event, result, toolName, { preserveExit = false } = {}) {
  if (preserveExit && result.exitCode !== 0 && result.exitCode !== 2) {
    // Generic advisory failures retain their status only when normalization
    // is nonrestrictive. Replacing a deny's exit2 with exit1/7 makes Codex
    // report hook failure and run the operation that the hook refused.
    const normalized = normalizeOutput(event, { ...result, exitCode: 0 }, toolName);
    const json = parseOutput(normalized.stdout);
    const restrictive = normalized.exitCode === 2 ||
      (BLOCK_EVENTS.has(event) && json?.decision === "block") ||
      ((COMMON_EVENTS.has(event) || event === "PostToolUse") && json?.continue === false);
    return restrictive ? normalized : { ...normalized, exitCode: result.exitCode };
  }
  if (event !== "PreToolUse") return normalizeLifecycle(event, result);
  const text = String(result.stdout || "").trim();
  const whole = parseOutput(text);
  const records = whole ? [whole] : text.split(/\r?\n/).filter((line) => line.trim()).map(parseOutput);
  const details = records.filter(Boolean).flatMap((json) => [
    json.hookSpecificOutput?.permissionDecisionReason, json.reason, json.stopReason,
    json.hookSpecificOutput?.additionalContext, json.hookSpecificOutput?.validation, json.systemMessage,
  ]).filter((value) => typeof value === "string" && value.trim());
  const deny = (reason) => refusal([...new Set([reason, ...details].filter(Boolean))].join("\n\n"));
  if (result.exitCode !== 0 && result.exitCode !== 2) {
    return deny(result.stderr || "Policy hook crashed before completing its decision.");
  }
  if (records.some((record) => !record)) return deny("Policy hook emitted malformed JSON output.");
  if (!records.length) {
    if (result.verdict === "deny" || result.exitCode !== 0) return deny(result.stderr || "Policy hook refused or crashed without a decision.");
    return { ...result };
  }
  const normalized = records.map((json, index) => ({
    hook: `output record ${index + 1}`,
    ...normalizeRecord(event, { stdout: JSON.stringify(json), stderr: "", exitCode: 0 }, toolName),
  }));
  const restrictive = normalized.filter((out) => out.exitCode === 2);
  if (records.length === 1 && restrictive.length === 1) {
    const out = restrictive[0];
    return { stdout: out.stdout, stderr: [...new Set([result.stderr, out.stderr].filter(Boolean))].join("\n"), exitCode: 2 };
  }
  if (restrictive.length || result.verdict === "deny" || result.exitCode === 2) {
    // The evaluator's independently computed denial is never downgraded even
    // if no native record could reproduce its decision.
    const reasons = restrictive.map((out) => out.stderr || parseOutput(out.stdout)?.hookSpecificOutput?.permissionDecisionReason).filter(Boolean);
    return deny(reasons.join("\n\n") || result.stderr || "Policy evaluator refused this operation.");
  }
  const { mergeOutcomes } = require("./hook-engine");
  const merged = normalized.length === 1 ? normalized[0] : mergeOutcomes(event, normalized);
  // Conflicting rewrites are refused by the shared merger, never selected by
  // output order. Preserve each record's context alongside that refusal.
  if (merged.exitCode === 2) return deny(parseOutput(merged.stdout)?.hookSpecificOutput?.permissionDecisionReason || merged.stderr);
  const out = normalizeRecord(event, merged, toolName);
  return { stdout: out.stdout, stderr: result.stderr || "", exitCode: result.exitCode };
}

function invokeTarget(descriptor, args, raw, payload) {
  const { target, validator, timeoutMs } = descriptor;
  if (validator && payload.hook_event_name === "PreToolUse" &&
      NATIVE_SHELL_TOOLS.has(payload.tool_name) &&
      typeof payload.tool_input?.command !== "string") {
    return refusal("Validator requires a string command in tool_input.");
  }
  const result = spawnSync(process.execPath, [target, ...args], {
    input: raw, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, COC_RUNTIME: "codex", CLAUDE_PROJECT_DIR: ROOT },
  });
  if (result.error) throw new Error(`failed to run target hook ${target}: ${result.error.message}`);
  if (result.status === null) throw new Error(`target hook terminated by signal ${result.signal || "unknown"}`);
  const out = { stdout: result.stdout || "", stderr: result.stderr || "", exitCode: result.status };
  // Unrelated advisory handlers retain their documented nonzero statuses. Only
  // known validators promote unexpected exits into an authorization refusal.
  return normalizeOutput(payload.hook_event_name, out, payload.tool_name, { preserveExit: !validator });
}

/** The ONE set of native tools that carry a shell command. Every gate that
 * asks "is this a shell call?" reads THIS set — the entry aliasing, the
 * evaluator's shape arms, the rewrite classifier, the validator guard and the
 * output-rewrite admission — so the gates cannot disagree about which tools
 * they protect (an earlier split left `shell_command` out of the evaluator's
 * set and `Bash` out of the rewrite classifier). */
const NATIVE_SHELL_TOOLS = new Set(["Bash", "shell", "shell_command", "exec_command", "unified_exec", "local_shell"]);
// `local_shell` joins on MEASURED evidence: the installed codex 0.160.0
// app-server schema (generate-json-schema, LocalShellAction) types its command
// as `command: string[]` — the same argv shape this set exists for. The other
// unified-exec sibling, `write_stdin`, carries session/chars and NO command
// field, so it is deliberately NOT a shell tool here; a COMMAND rewrite for
// any tool outside this set is refused in restoreNativeRewrite instead of
// riding through raw.

/** The command a native shell call carries, whichever alias field holds it —
 * `command`, `cmd`, or both — with the aliases REQUIRED to agree. Returns
 * undefined when neither field is present.
 *
 * WHY ONE EXTRACTOR: evaluation read `command` while the rewrite classifier
 * treated `cmd` as what exec_command executes, so `{command:[harmless],
 * cmd:[other]}` evaluated one command and executed the other — denied before
 * (the argv crashed the chain), allowed once the entry normalised arrays.
 * Reading both fields HERE, refusing a conflicting pair, and refusing any
 * carrying field whose value is neither a string nor a valid argv, makes
 * "what is evaluated" and "what is executed" the same question for every
 * downstream gate. Which field the native HOST itself executes stays
 * UNMEASURED for exec_command — the both-present refusal is what keeps the
 * question unobservable either way. */
function nativeShellCommand(input) {
  const present = [input.command, input.cmd].filter((value) => value !== undefined);
  if (!present.length) return undefined;
  for (const value of present) {
    if (typeof value === "string") continue;
    if (!Array.isArray(value)) {
      throw new Error(`native shell command has an unsupported type (${value === null ? "null" : typeof value}); refusing to evaluate it as an empty command`);
    }
    if (!value.length) throw new Error("native shell command is an empty argv; refusing to normalise it to an empty command line");
    if (value.some((part) => typeof part !== "string")) throw new Error("native shell argv carries a non-string element; refusing to normalise it away");
    if (value.some((part) => part === "")) throw new Error("native shell argv carries an empty element; refusing to normalise it away");
  }
  if (present.length === 2) {
    const [a, b] = [input.command, input.cmd];
    const agrees = a === b || (Array.isArray(a) && Array.isArray(b) &&
      a.length === b.length && a.every((part, index) => part === b[index]));
    if (!agrees) throw new Error("conflicting native shell command aliases");
  }
  return input.command !== undefined ? input.command : input.cmd;
}

const NATIVE_AGENT_TOOLS = new Set(["spawn_agent", "collaborationspawn_agent"]);

function normalizeNativeInput(payload) {
  const name = payload.tool_name;
  let input = payload.tool_input;
  if (name === "apply_patch" && typeof input === "string") input = { command: input };
  if (NATIVE_AGENT_TOOLS.has(name) && (!input || typeof input !== "object" || Array.isArray(input))) {
    throw new Error("native agent input must be an object");
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    input = { ...input };
    if (NATIVE_SHELL_TOOLS.has(name)) {
      // The ONE extractor decides what this call's command IS — whichever
      // alias field carries it, with a conflicting pair and any
      // non-string/non-argv value refused, so evaluation and execution can
      // never diverge about the field.
      const command = nativeShellCommand(input);
      if (command !== undefined) input.command = command;
    }
    if (name === "apply_patch") {
      const aliases = [input.command, input.patch, input.input].filter((value) => value !== undefined);
      if (aliases.some((value) => value !== aliases[0])) throw new Error("conflicting native patch input aliases");
      if (input.command === undefined) input.command = input.patch ?? input.input;
    }
    if (NATIVE_AGENT_TOOLS.has(name)) {
      for (const [native, canonical] of [["message", "prompt"], ["agent_type", "subagent_type"], ["task_name", "name"]]) {
        for (const key of [native, canonical]) {
          if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key].trim())) {
            throw new Error(`native agent ${key} must be a nonempty string`);
          }
        }
        if (input[native] !== undefined) {
          if (input[canonical] !== undefined && input[canonical] !== input[native]) {
            throw new Error(`conflicting native agent ${canonical} aliases`);
          }
          input[canonical] = input[native];
        }
      }
      if (typeof input.prompt !== "string") throw new Error("native agent input requires message or prompt");
      if (input.description === undefined) input.description = input.prompt;
    }
  }
  return { ...payload, tool_input: input };
}

function restoreNativeRewrite(result, original, evaluateRewritten) {
  if (original.hook_event_name !== "PreToolUse" || result.exitCode !== 0) return result;
  const output = parseOutput(result.stdout);
  const rewrite = output?.hookSpecificOutput?.updatedInput;
  if (!rewrite) return result;
  if (original.tool_name === "apply_patch" || NATIVE_AGENT_TOOLS.has(original.tool_name)) {
    return refusal("Canonical edit or agent rewrites cannot be mapped unambiguously to this native tool.");
  }
  if (!NATIVE_SHELL_TOOLS.has(original.tool_name)) {
    // A COMMAND rewrite for a tool outside the set is unmappable and must not
    // ride through raw (the admission layer only constrains the set's tools).
    // Rewrites carrying no command — other native arguments — keep dev's
    // passthrough.
    return rewrite.command !== undefined || rewrite.cmd !== undefined
      ? refusal("A command rewrite for this native tool cannot be mapped to its input schema.")
      : result;
  }
  const input = original.tool_input;
  const refuse = () => refusal("Canonical shell rewrite cannot be mapped to the native input schema.");
  if (!input || typeof input !== "object" || Array.isArray(input)) return refuse();
  // F2: a rewrite may carry ONLY the command — any other key would change an
  // input field (workdir, env, …) the chain never re-reads to judge the call.
  const foreignKey = Object.keys(rewrite).some((key) => key !== "command" && key !== "cmd");
  // WRITE INTO EVERY FIELD THE ORIGINAL CARRIED — nothing is deleted, so
  // merge-vs-replace on the host cannot matter (MED, security round). A
  // per-tool single-field guess could rewrite a field the host does not read
  // while leaving the executed one stale; which field the native HOST
  // executes stays UNMEASURED, and this is what keeps that question from
  // mattering. The entry's both-present agreement rule then holds on the
  // result: every carrier receives the SAME value.
  const carriers = ["command", "cmd"].filter((key) => input[key] !== undefined);
  // F2: whatever a rewrite would EXECUTE is re-evaluated through its own
  // renderings before it is returned — a policy that sees only one string
  // shape can otherwise invent an argv the entry normalisation never judged.
  // The chain's refusal is the rewrite's refusal. Rewrites emitted DURING the
  // re-evaluation are ignored: this pass judges, it does not transform.
  const accepted = (native, command) => {
    if (evaluateRewritten) {
      const verdict = evaluateRewritten(native, command);
      if (verdict && verdict.exitCode !== 0) {
        const reason = parseOutput(verdict.stdout)?.hookSpecificOutput?.permissionDecisionReason || verdict.stderr;
        return refusal(["A rewritten shell command must pass the policy chain unrewritten; the rewrite was refused.", reason].filter(Boolean).join("\n\n"));
      }
    }
    output.hookSpecificOutput.updatedInput = native;
    return { ...result, stdout: JSON.stringify(output) + "\n" };
  };
  // AN ARGV STAYS AN ARGV. The ORIGINAL shape decides how a rewrite may be
  // expressed: a hook that echoes the argv it was forwarded maps back onto it
  // and still produces an argv — the passthrough consumer must not be refused
  // for being honest about the shape it was given — while a SCALAR against an
  // argv REFUSES, because a string cannot be placed back into argv position
  // without guessing, and guessing is how a fail-closed gate stops being one.
  if (Array.isArray(input.command) || Array.isArray(input.cmd)) {
    const proposed = Array.isArray(rewrite.command) ? rewrite.command : Array.isArray(rewrite.cmd) ? rewrite.cmd : null;
    const aliasesAgree = rewrite.command === undefined || rewrite.cmd === undefined ||
      JSON.stringify(rewrite.command) === JSON.stringify(rewrite.cmd);
    if (!proposed || proposed.length === 0 || !aliasesAgree || foreignKey ||
        proposed.some((part) => typeof part !== "string" || part === "")) return refuse();
    // Carriers ONLY: the rewrite's own alias keys are NOT spread wholesale —
    // a rewrite arrives on the canonical `command` key while the original may
    // have carried only `cmd`, and copying the key the call never had would
    // invent a field (MEASURED: {cmd,workdir} gained a stray command key).
    const native = { ...input };
    for (const key of carriers) native[key] = proposed;
    return accepted(native, proposed);
  }
  if (typeof rewrite.command !== "string" || foreignKey ||
      (rewrite.cmd !== undefined && rewrite.cmd !== rewrite.command)) {
    return refuse();
  }
  const native = { ...input };
  for (const key of carriers) native[key] = rewrite.command;
  return accepted(native, rewrite.command);
}

/** Quote ONE argv element exactly when the shell would otherwise change it.
 *
 * ⛔ A BARE SPACE JOIN IS A FAIL-OPEN, AND IT WAS MEASURED. The first version of
 * this normaliser joined with " ", which emits an UNQUOTED nested shell body:
 * `["bash","-lc","git reset --hard origin/main"]` became
 * `bash -lc git reset --hard origin/main`, and `parseGitInvocations` returns
 * `[]` for that — the unquoted `-c` operand EATS the verb, so no fence sees it.
 * MEASURED through `--native-policy`: that payload returned status 0 (allow),
 * and so did `["bash","-lc","git clean -fd"]` and `["bash","-lc","git push
 * --force origin main"]`; dev returns 2 (deny) for all three. A `;`, `&&` or
 * newline inside the element splits the segment and the fence DOES fire, so the
 * blind spot was single-command bodies — the common case.
 *
 * So the array form was fail-closed before, BY THE CRASH: every array hit the
 * TypeError and became a denial. Removing the crash without fixing the
 * SERIALISATION removed the denial too — the accidental guard was load-bearing.
 *
 * Quoting fixes it and is measured: `"bash -lc 'git reset --hard origin/main'"`
 * (the quoted form) returns status 2 BLOCK. But quoting EVERY element would hide
 * a bare verb from the same parsers, so an element is quoted only when it needs
 * it — the POSIX-safe set passes through untouched, so
 * `["git","reset","--hard"]` still reads as `git reset --hard`. */
const SHELL_SAFE_ELEMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;
function shellQuoteElement(part) {
  if (part === "") return "''";
  if (SHELL_SAFE_ELEMENT.test(part)) return part;
  return "'" + part.replaceAll("'", "'\\''") + "'";
}

// NO ADAPTER-LOCAL SHELL LIST. The array adapter imports the ONE shell-name
// set (`git-command-parse.js::SHELL_BASENAMES`) through the reader below —
// security ruling, 2026-10-03: this file's own `SHELL_C_NAMES` had already
// drifted from the parser's (no fish/csh/tcsh/yash/rbash/toybox).
/** Mirrors `git-command-parse.js::MAX_NEST_DEPTH`. Past it the adapter cannot
 * say WHICH command runs, so it REFUSES rather than normalising a line it has
 * not read (see `commandRenderings`). */
const NATIVE_UNWRAP_DEPTH_BOUND = 8;
/** The depth bound's sibling: the NESTED dialect can branch (`find … -exec sh
 * -c A \; -exec sh -c B \;` yields two bodies, and each may nest again), so a
 * lawful deep body can expand past a linear count. MEASURED: the deepest chain
 * the depth bound admits (7 nested wrappers) yields 10 renderings — an 8-deep
 * one ALREADY refuses — while two `find -exec` per level compounds 2^8.
 * Every rendering costs one FULL policy evaluation, so the count is capped
 * HERE and a command that exceeds it is REFUSED — a reading that cannot be
 * bounded is not one this boundary may allow. (An unbounded run would also end
 * in refusal, by hook timeout; refusing up front is the same verdict without
 * stalling the session for the whole budget.) */
const NATIVE_RENDERING_BOUND = 32;

/** EVERY candidate body of a command-position shell wrapper, or null — the ONE
 * reader (`git-command-parse.js::shellCandidateBodies`), shared with the
 * string-side nested-body scan, so the two cannot disagree about which words a
 * shell could run (this adapter's own SHELL_C_NAMES had already drifted — no
 * fish/csh/tcsh/yash/rbash/toybox).
 *
 * THE CURRENT RULE (security rulings 2026-10-03/04 — the earlier revision of
 * this comment still described the retired "no `-c` requirement" model, which
 * the 2026-10-04 re-check found reopened H3): strip launchers and their cruft
 * from the front; if the next word is a shell (basename, case-insensitive),
 * apply its PER-SHELL command-option grammar (`SHELL_COMMAND_GRAMMAR` — fish's
 * `--command`, PowerShell's case-insensitive `-Command…` prefixes and its
 * POSITIONAL command included); a MULTICALL applet (`busybox`/`toybox`)
 * re-enters the walk on its applet word. An UNEXPANDABLE word at an option
 * position — or a multicall chain past its hop bound — makes the read
 * `unresolvable`, and THIS wrapper REFUSES (throws, below): which words a shell
 * could run is UNKNOWN, and the adapter must not normalise a line it has not
 * read (`sh $FLAGS BODY` was the reopened silent allow). WITH a command option,
 * EVERY later word is a candidate body — no `--` stop, no option-operand
 * modelling; over-denial is ACCEPTED and deliberate (`["bash","-c","--","BODY"]`
 * yields `--` and `BODY` both; attached `--command=X` values are candidates
 * too). WITHOUT one the shell runs a script: no candidates, no refusal (the
 * named residual). MEASURED anchors with harmless marker bodies: `-c BODY`,
 * `-c -- BODY`, `-c - BODY`, `-o pipefail -c BODY`, `busybox sh -c BODY` all
 * RUN their body, and all are candidates under this rule.
 *
 * Host argv elements are literal strings, so no `unexpandable` marks exist on
 * this path — the marks belong to the string side, which passes whole tokens;
 * only the multicall hop bound can mark an argv. The nested-body REFUSAL for a
 * candidate the extractor cannot fully read stays the caller's
 * (`commandRenderings`). */
function shellWrapperBody(argv) {
  const { candidates, shellAt, unresolvable } = require("./git-command-parse").shellCandidateBodies(argv);
  // The read itself is unresolvable: the walk found a shell whose option region
  // (or applet chain) cannot be read from this argv, so the adapter must not
  // normalise a line it has not read — the same contract as the depth and
  // rendering bounds below, and the same mark the string side refuses on.
  if (unresolvable) {
    throw new Error("native shell command contains an option position or applet chain whose content cannot be read; refusing to evaluate a command that cannot be fully read");
  }
  if (shellAt === -1 || !candidates.length) return null;
  return candidates.map((c) => c.value);
}

/** EVERY honest rendering of ONE argv, CANONICAL FIRST. The canonical entry is
 * the shell-quoted line — the serialisation the payload is normalised TO. The
 * rest are ADDITIONAL readings of the same argv which must also allow before
 * the call is allowed (the any-refuses rule lives in `evaluateEveryRendering`).
 *
 * The unwrap RECURSES, because a body may itself be a shell-wrapper invocation
 * (`["bash","-lc","bash -lc '/bin/rm /'"]`). The nested dialect is the CC
 * side's own — `git-command-parse.js::nestedCommandStrings`, the SAME function
 * `violation-patterns.js` expands a string command with — so the array adapter
 * cannot disagree with the string detectors about what is nested. Past
 * NATIVE_UNWRAP_DEPTH_BOUND the adapter REFUSES (throws): a line it cannot
 * fully read is not a line it may allow. */
function commandRenderings(argv) {
  const renderings = [];
  const seen = new Set();
  const push = (text) => {
    if (typeof text !== "string" || !text.trim() || seen.has(text)) return;
    if (renderings.length >= NATIVE_RENDERING_BOUND) {
      throw new Error(`native shell command expands to more than ${NATIVE_RENDERING_BOUND} renderings; refusing to evaluate readings that cannot be bounded`);
    }
    seen.add(text);
    renderings.push(text);
  };
  push(argv.map(shellQuoteElement).join(" "));
  push(argv.join(" "));
  const bodies = shellWrapperBody(argv);
  let frontier = bodies === null ? [] : [...bodies];
  const { nestedCommandStrings } = require("./git-command-parse");
  for (let depth = 0; frontier.length; depth += 1) {
    if (depth >= NATIVE_UNWRAP_DEPTH_BOUND) {
      throw new Error(`native shell command nests shell wrappers deeper than ${NATIVE_UNWRAP_DEPTH_BOUND} levels; refusing to normalise a command whose inner body cannot be read`);
    }
    const next = [];
    for (const text of frontier) {
      push(text);
      const nested = nestedCommandStrings(text);
      // AN UNEXPANDABLE BODY REFUSES (security ruling, 2026-10-03). The old
      // `continue` here claimed "the fences read the body itself and fail closed
      // there" — true of the STRING side, not of this adapter, whose contract is
      // the ruled one: a candidate body that came from an expansion this
      // adapter cannot read (`sh $FLAGS BODY` inside a body) means the REAL body
      // is unknown, so the whole call refuses (throw → refusal at dispatch),
      // same as the depth and rendering bounds above. Literal siblings are not
      // filtered when the body IS readable — every extracted child is pushed.
      if (nested.unresolvable) {
        throw new Error("native shell command contains an expansion whose content cannot be read (an unexpandable candidate body); refusing to evaluate a command that cannot be fully read");
      }
      for (const inner of nested.commands) next.push(inner);
    }
    frontier = next;
  }
  return renderings;
}

/** Codex delivers a native shell command as an argv ARRAY — `shell` and
 * `unified_exec` carry `["bash","-lc","<command>"]` — while every CC-side policy
 * and detector reads ONE string. Normalising HERE, at the single entry every
 * Codex payload passes, is what makes that true for all of them at once; a guard
 * at one detector's call site would leave every sibling detector on the array.
 *
 * MEASURED on dev 1439ff368: the array reached the detectors and
 * `violation-patterns.js::heredocBodiesAreInertData` threw
 * "command.matchAll is not a function", which `evaluateNative`'s catch rendered
 * as `refusal(...)` — so EVERY Codex command was DENIED, which is why this
 * presents as a policy denial rather than as a crash.
 *
 * NO SINGLE STRING IS SAFE FOR BOTH FENCE FAMILIES, and both directions were
 * measured. The space join EATS the `-c` operand's command (`bash -lc git reset
 * --hard origin/main` → `parseGitInvocations` is `[]` → allow, where the string
 * form denies); the quoted join HIDES a body behind a trailing quote
 * (`bash -lc '/bin/rm /'` → the raw-text fence cannot match → allow, where the
 * string form denies). So this returns EVERY rendering of the argv — canonical
 * quoted line first, the space-joined line and any unwrapped shell bodies after
 * — and the caller evaluates ALL of them, refusing if ANY refuses.
 *
 * Returns an array of renderings (canonical first) when the command was an
 * array, or null when this function found nothing to change. EVALUATION input
 * only: the caller substitutes the canonical entry into the payload the policy
 * chain reads, and never re-serialises the payload itself — the execution
 * payload stays byte-identical to what Codex sent.
 */
function normalizeCommandShape(payload) {
  const shellLike = NATIVE_SHELL_TOOLS.has(payload.tool_name);
  const input = payload?.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    // F1: a shell call whose tool_input cannot carry a readable command is not
    // "nothing to check" — the host still has a command to run. An absent
    // command used to reach the validator, whose `|| ""` fall-through
    // evaluated it as an EMPTY line; refusing here is what removes that path.
    if (shellLike) throw new Error("native shell tool_input must be an object carrying the command");
    return null;
  }
  const cmd = input.command;
  if (cmd === undefined) {
    if (shellLike) throw new Error("native shell command is absent; refusing to evaluate an empty command line");
    return null; // absent is not this function's business for other tools
  }
  if (typeof cmd === "string") return null;
  // ⛔ A PRESENT COMMAND THAT IS NEITHER A STRING NOR A STRING ARRAY IS NOT
  // "NOTHING TO CHECK" — it is a shape this adapter cannot evaluate, and letting
  // it through means the guard has no command to look at while the shell still
  // has one to run. The correctness reviewer measured the split precisely: `42`
  // and `{a:1}` reached the detectors and DENIED only because they CRASHED
  // (`violation-patterns.js` `command.matchAll`), while `null` and `[]` fell
  // through `validate-bash-command.js`'s `|| ""` and were ALLOWED. A fail-closed
  // gate cannot depend on which of two accidents happens. For a shell-like tool
  // this now REFUSES, which is the only disposition that is the same in every
  // case; a non-shell tool keeps its existing handling.
  if (Array.isArray(cmd)) {
    if (cmd.length === 0) {
      if (shellLike) throw new Error("native shell command is an empty argv; refusing to normalise it to an empty command line");
      return null;
    }
    if (cmd.some((part) => typeof part !== "string")) {
      throw new Error("native shell argv carries a non-string element; refusing to normalise it away");
    }
    // ⛔ AN EMPTY ELEMENT IS NOT NOTHING. MEASURED, dirty tree: the argv
    // `["", "", "git", "reset", "--hard", "HEAD"]` normalised to
    // `'' '' git reset --hard HEAD`, the parser found no git invocation in it, and
    // the call was ALLOWED — while the STRING form of the same intent DENIED. That
    // is a fail-open, and it is the one direction that matters.
    // Dropping empty elements would repair it and is what a shell effectively does,
    // but dropping is exactly the silent-shortening the non-string arm above
    // refuses, and whether an empty element is inert depends on the exact position
    // (`git "" reset` is not `git reset`). Refusing has ONE disposition in every
    // position, so it is what a fail-closed gate takes.
    if (cmd.some((part) => part === "")) {
      throw new Error("native shell argv carries an empty element; refusing to normalise it away");
    }
    // The canonical (shell-quoted) line is the EVALUATION input — dispatch
    // substitutes it for the argv in the payload it hands the policy chain —
    // while the payload itself keeps the raw argv: the legacy child-hook route
    // forwards the bytes Codex sent, untouched.
    return commandRenderings(cmd);
  }
  if (shellLike) {
    throw new Error(`native shell command has an unsupported type (${cmd === null ? "null" : typeof cmd}); refusing to evaluate it as an empty command`);
  }
  return null;
}

/** FAIL-CLOSED ACROSS RENDERINGS — the second half of the ruled design. One
 * native argv has more than one honest reading (the quoted line, the
 * space-joined line, and — behind a shell wrapper — the body the inner shell
 * parses byte for byte), and each fence family reads a DIFFERENT one, so no
 * single serialisation is safe against both.
 *
 * Every rendering is evaluated and a refusal from ANY of them IS the verdict;
 * only when every rendering allows is the CANONICAL rendering's own result
 * returned, so an allow-path hook's context/rewrite output is exactly what it
 * was before. Monotone: an extra rendering can only ADD a refusal, never open
 * something another rendering's fence catches.
 *
 * The canonical result is returned immediately when it already refuses (exit
 * non-zero), so the deny path costs no extra evaluation. */
/** A verdict RESTRICTS when the runtime's own normalisers would treat it as a
 * refusal — a nonzero exit, a `block` decision on a block-capable event, or
 * `continue:false` — even at exit 0. MEASURED GAP, exit-code-only test:
 * `normalizeLifecycle` carries `block` and `continue:false` at status 0, so a
 * block that a NON-CANONICAL rendering produced was dropped and the canonical
 * allow returned as the verdict. */
function verdictRestricts(event, result) {
  if (result.exitCode !== 0) return true;
  const json = parseOutput(result.stdout);
  if (!json) return false;
  return (BLOCK_EVENTS.has(event) && json.decision === "block") ||
    ((COMMON_EVENTS.has(event) || event === "PostToolUse") && json.continue === false);
}

function evaluateEveryRendering(payload, renderings, evaluate, deadline = Date.now() + NATIVE_CALL_BUDGET_MS) {
  // ONE deadline for the WHOLE call — the renderings SHARE it rather than each
  // starting a fresh one, so a call that fans out to many renderings refuses
  // from INSIDE the hook (exit 2) before the host's own hook timeout can fire.
  if (Date.now() >= deadline) return refusal("Native policy evaluation exceeded its time budget.");
  const canonical = evaluate(payload);
  if (!renderings || renderings.length < 2 || verdictRestricts(payload.hook_event_name, canonical)) return canonical;
  for (const rendering of renderings.slice(1)) {
    if (Date.now() >= deadline) return refusal("Native policy evaluation exceeded its time budget.");
    const refused = evaluate({ ...payload, tool_input: { ...payload.tool_input, command: rendering } });
    if (verdictRestricts(payload.hook_event_name, refused)) return refused;
    // LOW b (security round): a rewrite is AUTHORED by the canonical decision.
    // A non-canonical rendering that requests one would execute a transform
    // judged only in part — refuse rather than map it.
    if (parseOutput(refused.stdout)?.hookSpecificOutput?.updatedInput !== undefined) {
      return refusal("A non-canonical rendering requested a rewrite; refusing rather than executing a transform judged only in part.");
    }
  }
  return canonical;
}

function dispatch(args = process.argv.slice(2), raw = fs.readFileSync(0, "utf8")) {
  const [targetArg, ...forwardedArgs] = args;
  if (!targetArg) throw new Error("no target hook path given");
  const parsed = JSON.parse(raw || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("hook input must be an object");
  const payload = normalizeNativeInput(parsed);
  if (JSON.stringify(payload) !== JSON.stringify(parsed)) raw = JSON.stringify(payload);
  const renderings = normalizeCommandShape(payload);
  // EVALUATION input vs EXECUTION payload. A policy or detector reads ONE
  // shape — the canonical rendering replaces the argv in the payload the chain
  // sees — while the payload itself keeps what Codex sent, because the legacy
  // child-hook route forwards it onward byte-identical and
  // restoreNativeRewrite classifies a rewrite against the ORIGINAL argv.
  const evaluated = renderings
    ? { ...payload, tool_input: { ...payload.tool_input, command: renderings[0] } }
    : payload;
  // ONE alias into evaluation: the canonical rendering is the command every
  // reader sees, so a sibling alias still holding the raw argv is DROPPED
  // rather than left to disagree with it — the chain re-runs the entry's
  // agreement rule on every projection (projectPayloads normalises again), and
  // MEASURED: it refused the evaluable form because `cmd` held the argv beside
  // the canonical string.
  if (renderings) delete evaluated.tool_input.cmd;
  // ONE deadline for the whole call (NATIVE_CALL_BUDGET_MS): every rendering
  // AND every rewrite re-evaluation shares it.
  const nativeDeadline = Date.now() + NATIVE_CALL_BUDGET_MS;
  // F2: the evaluator a REWRITE must clear before it is returned — the same
  // chain, the same deadline, rewrites ignored (this pass judges, never
  // transforms). Both routes share it: an echo of a MODIFIED argv is exactly
  // as capable of introducing an unread command as a native-route rewrite.
  //
  // The candidate presents the rewritten command as the ONLY alias: the mapped
  // native keeps the field the ORIGINAL carried, and re-running the entry's
  // agreement rule over a STALE sibling alias would refuse the re-evaluation
  // itself (MEASURED: cmd:'clean' beside command:'rewritten'). The require is
  // LAZY — trees that carry a minimal runtime subset must not need the policy
  // adapter merely to pass a call through, and a rewrite on such a tree
  // refuses with its own module error instead of silently skipping the check.
  const evaluateRewritten = (nativeInput, command) => {
    const { evaluateNative } = require("./codex-native-policy");
    const rewritten = Array.isArray(command) ? commandRenderings(command) : [command];
    const base = { ...nativeInput };
    delete base.command;
    delete base.cmd;
    return evaluateEveryRendering(
      { ...evaluated, tool_input: { ...base, command: rewritten[0] } },
      rewritten,
      (candidate) => {
        const out = normalizeOutput(candidate.hook_event_name, evaluateNative(candidate, nativeDeadline), candidate.tool_name);
        const again = parseOutput(out.stdout)?.hookSpecificOutput?.updatedInput;
        if (again !== undefined) {
          // LOW a (security round): accept ONLY an idempotent echo of the
          // value under judgement. The chain reads the CANONICAL rendering,
          // so an argv rewrite's honest echo returns that string — it is the
          // SAME command. A DIFFERENT rewrite requested DURING re-evaluation
          // would execute a transform this pass never judged.
          const againValue = again.command !== undefined ? again.command : again.cmd;
          const same = JSON.stringify(againValue) === JSON.stringify(command) ||
            JSON.stringify(againValue) === JSON.stringify(rewritten[0]);
          if (!same) {
            return refusal("A rewritten command may not request a further rewrite; the rewrite was refused.");
          }
        }
        return out;
      },
      nativeDeadline,
    );
  };
  process.env.COC_RUNTIME = "codex";
  process.env.CLAUDE_PROJECT_DIR = ROOT;
  if (targetArg === "--native-policy") {
    const { evaluateNative } = require("./codex-native-policy");
    return evaluateEveryRendering(evaluated, renderings, (candidate) =>
      restoreNativeRewrite(
        normalizeOutput(candidate.hook_event_name, evaluateNative(candidate, nativeDeadline), candidate.tool_name),
        parsed,
        evaluateRewritten,
      ), nativeDeadline);
  }
  const descriptor = resolveTarget(targetArg);
  const { target } = descriptor;
  if (!descriptor.hygiene && payload.tool_name === "apply_patch" && payload.hook_event_name === "PostToolUse") {
    const { projectPayloads } = require("./codex-native-policy");
    const { mergeOutcomes } = require("./hook-engine");
    return mergeOutcomes("PostToolUse", projectPayloads(payload).map((p) => ({
      hook: target, ...invokeTarget(descriptor, forwardedArgs, JSON.stringify(p), p),
    })));
  }
  // PASSTHROUGH, dev's contract: the targeted child hook is a legacy consumer
  // and receives what Codex sent — the argv stays an argv. invokeTarget's own
  // guard refuses a validator a non-string command, and restoreNativeRewrite
  // refuses a scalar rewrite of an argv; neither is repair-by-normalisation.
  return restoreNativeRewrite(invokeTarget(descriptor, forwardedArgs, raw, payload), parsed, evaluateRewritten);
}

function readInput(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const done = (error) => {
      clearTimeout(timer);
      stream.removeListener("data", data);
      stream.removeListener("end", end);
      stream.removeListener("error", failed);
      stream.pause();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_INPUT_BYTES) done(new Error("hook input exceeds 4 MiB limit"));
      else chunks.push(chunk);
    };
    const end = () => done();
    const failed = (error) => done(error);
    const timer = setTimeout(() => done(new Error("hook stdin deadline exceeded")), INPUT_TIMEOUT_MS);
    stream.on("data", data).once("end", end).once("error", failed);
  });
}

async function main() {
  let result;
  let event = "PreToolUse";
  try {
    const raw = await readInput();
    event = parseOutput(raw)?.hook_event_name || event;
    result = dispatch(process.argv.slice(2), raw);
  } catch (error) { result = normalizeOutput(event, refusal(`[codex-hook-runtime] ${error.message}`, event), undefined, { preserveExit: true }); }
  fs.writeSync(1, result.stdout || "");
  fs.writeSync(2, result.stderr || "");
  process.exitCode = result.exitCode;
}
// `commandRenderings` and `evaluateEveryRendering` are exported for the
// array/string suites: the first pins the unwrap composition and the depth- and
// rendering-bound refusals WITHOUT paying a policy evaluation per rendering, the
// second pins the restrictive-verdict rule (a `block` at exit 0) directly —
// LATENT through the runtime today, because the native adapter refuses every
// non-PreToolUse event, and the rule exists so the loop cannot drop a block the
// normalisers treat as a refusal.
module.exports = { ROOT, NATIVE_AGENT_TOOLS, NATIVE_SHELL_TOOLS, normalizeOutput, normalizeNativeInput, parseOutput, refusal, dispatch, resolveTarget, commandRenderings, evaluateEveryRendering, INPUT_TIMEOUT_MS };
if (require.main === module) main();
