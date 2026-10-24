"use strict";
const fs = require("node:fs");
const path = require("node:path");
const registry = require("./dispatch-registry");
const engine = require("./hook-engine");
const { ROOT, normalizeOutput, parseOutput, nativeEventFailure: failure, finalizeNativeEventFailure, NATIVE_LIFECYCLE_EVENTS: EVENTS } = require("./codex-hook-runtime");
const { projectPayloads, boundedMatcher } = require("./codex-native-policy");
const { runLocalSupervised } = require("./dispatch-main");

const SHORT = new Set(["SessionEnd", "Interrupt"]);
const MATCH_FIELD = { SessionStart: "source", SessionEnd: "reason", PreCompact: "trigger", PostCompact: "trigger",
  SubagentStart: "agent_type", SubagentStop: "agent_type", PostToolUse: "tool_name", PermissionRequest: "tool_name" };
const CONTEXT = new Set(["SessionStart", "UserPromptSubmit", "SubagentStart", "PostToolUse"]);
const RAW_PATCH_HOOKS = new Set(["integration-hygiene.js", "session-load-backstop.js"]);

function restrictive(out) {
  const json = parseOutput(out.stdout);
  return out._nativeRuntimeFault || out.exitCode !== 0 || json?.continue === false || json?.decision === "block" ||
    json?.hookSpecificOutput?.decision?.behavior === "deny";
}

function validControls(raw) {
  const whole = parseOutput(raw);
  const records = whole ? [whole] : raw.split(/\r?\n/).filter(s => s.trim()).map(parseOutput);
  for (const json of records) {
    if (!json) continue; // The event-specific text/JSON rule is enforced below.
    for (const key of ["continue", "suppressOutput"]) if (json[key] !== undefined && typeof json[key] !== "boolean") return false;
    for (const key of ["systemMessage", "stopReason", "reason", "validation"]) if (json[key] !== undefined && typeof json[key] !== "string") return false;
    if (json.decision !== undefined && !["block", "approve"].includes(json.decision)) return false;
    const h = json.hookSpecificOutput;
    if (h !== undefined && (!h || typeof h !== "object" || Array.isArray(h))) return false;
    for (const key of ["additionalContext", "validation", "hookEventName"]) if (h?.[key] !== undefined && typeof h[key] !== "string") return false;
  }
  return true;
}

// Adapt each result before aggregation: hook-engine.js:796–816 uses Claude
// event semantics, while codex-hook-runtime.js::normalizeOutput owns native ones.
function adapt(event, out) {
  if (!["exit", "return"].includes(out.status) || out.deadlineCut) {
    return failure(event, `${out.hook} did not finish (${out.status}${out.deadlineCut ? ", event deadline" : ""}); its partial output was discarded.`);
  }
  let raw = out.stdout || "";
  if (!parseOutput(raw)) {
    const lines = raw.split(/\r?\n/).filter(line => line.trim());
    if (lines.length > 1 && lines.some(line => parseOutput(line))) {
      return merge(event, lines.map(line => parseOutput(line)
        ? adapt(event, { ...out, stdout: line })
        : failure(event, `${out.hook} supplied an invalid output record.`)));
    }
  }
  if (!validControls(raw)) return failure(event, `${out.hook} supplied malformed control fields.`);
  // Claude PreCompact plain output is context; the native event needs JSON.
  if (event === "PreCompact" && raw.trim() && !/^[{[]/.test(raw.trim())) raw = JSON.stringify({ systemMessage: raw.trim() });
  const normalized = normalizeOutput(event, { ...out, stdout: raw }, undefined, { preserveExit: true });
  if (normalized.exitCode !== 0 && normalized.exitCode !== 2) return failure(event, `${out.hook}: ${normalized.stderr || "invalid hook output"}`);
  if (out.exitCode !== 0 && out.exitCode !== 2) normalized.stderr = [normalized.stderr, `${out.hook} exited ${out.exitCode}; its restrictive decision is retained.`].filter(Boolean).join("\n");
  if (out.exitCode === 2 && ["PreCompact", "PostCompact", "SessionStart"].includes(event)) {
    const json = parseOutput(normalized.stdout) || {};
    json.continue = false;
    json.stopReason ||= json.reason || out.stderr || `${out.hook} refused the event.`;
    return { ...normalized, stdout: JSON.stringify(json), exitCode: 0 };
  }
  return normalized;
}

function merge(event, outcomes) {
  const result = {}, context = [], messages = [], reasons = [], stderr = [];
  let exitCode = 0;
  for (const out of outcomes) {
    if (out.stderr) stderr.push(out.stderr.trim());
    if (out.exitCode === 2) exitCode = 2;
    else if (out.exitCode && exitCode !== 2) exitCode = out.exitCode;
    const json = parseOutput(out.stdout);
    if (!json) {
      if (out.stdout?.trim()) context.push(out.stdout.trim());
      continue;
    }
    if (json.systemMessage) messages.push(json.systemMessage);
    if (json.hookSpecificOutput?.additionalContext) context.push(json.hookSpecificOutput.additionalContext);
    if (json.continue === false) result.continue = false;
    if (json.stopReason) reasons.push(json.stopReason);
    if (json.decision === "block") {
      result.decision = "block";
      result.reason = [result.reason, json.reason].filter(Boolean).join("\n");
    }
    const decision = json.hookSpecificOutput?.decision;
    if (decision && result.hookSpecificOutput?.decision?.behavior !== "deny") result.hookSpecificOutput = { hookEventName: event, decision };
  }
  if (reasons.length) result.stopReason = [...new Set(reasons)].join("\n\n");
  if (context.length) {
    if (CONTEXT.has(event)) result.hookSpecificOutput = { ...result.hookSpecificOutput, hookEventName: event, additionalContext: [...new Set(context)].join("\n\n") };
    else messages.push(...context);
  }
  if (messages.length) result.systemMessage = [...new Set(messages)].join("\n\n");
  if (["Stop", "SubagentStop"].includes(event) && result.continue === false && result.decision === "block") {
    result.systemMessage = [result.systemMessage, result.reason].filter(Boolean).join("\n\n");
    delete result.decision;
    delete result.reason;
  }
  // Native SessionEnd is advisory and cannot steer a thread.
  if (event === "SessionEnd") return { stdout: "", stderr: [...stderr, ...messages, ...reasons].join("\n"), exitCode };
  return { stdout: Object.keys(result).length ? JSON.stringify(result) + "\n" : "", stderr: [...new Set(stderr)].join("\n"), exitCode,
    _nativeRuntimeFault: outcomes.some(out => out._nativeRuntimeFault) };
}

function selected(groups, payload, original, matches, alreadyRan) {
  const hooksRoot = fs.realpathSync(path.join(ROOT, ".claude/hooks"));
  const entries = new Map();
  const event = payload.hook_event_name;
  for (const group of groups) {
    const field = MATCH_FIELD[event];
    const matched = !field || matches(group.matcher, payload[field] || "", event) || matches(group.matcher, original[field] || "", event);
    for (const hook of group.hooks || []) {
      const name = registry.hookBasename(hook.command);
      // Keep the established native patch backstop without projecting every
      // edit as Bash. This handler reads process state, not command input
      // (.claude/hooks/session-load-backstop.js:62–77).
      const patchBackstop = event === "PostToolUse" && original.tool_name === "apply_patch" && name === "session-load-backstop.js" && matches(group.matcher, "Bash", event);
      if (!matched && !patchBackstop) continue;
      if (hook.type !== "command" || !name) throw new Error("selected hook descriptor is not a canonical command");
      if (alreadyRan.has(name)) continue;
      const file = fs.realpathSync(path.join(hooksRoot, name));
      if (path.dirname(file) !== hooksRoot || !fs.statSync(file).isFile()) throw new Error(`${name} is not an ordinary canonical hook`);
      const timeoutMs = hook.timeout === undefined ? 600000 : hook.timeout * 1000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000) throw new Error(`${name} has invalid timeout`);
      const previous = entries.get(name);
      entries.set(name, { hook: name, file, timeoutMs: Math.min(timeoutMs, previous?.timeoutMs ?? Infinity) });
    }
  }
  return [...entries.values()];
}

function subtractSource(combined, source) {
  const remaining = new Map();
  for (const group of source) { const k = JSON.stringify(group); remaining.set(k, (remaining.get(k) || 0) + 1); }
  return combined.filter(group => {
    const k = JSON.stringify(group), count = remaining.get(k) || 0;
    if (!count) return true;
    remaining.set(k, count - 1); return false;
  });
}

async function evaluateEvent(payload, { startedAt = engine.now(), rawPayload = payload } = {}) {
  const event = payload.hook_event_name;
  if (!EVENTS.has(event)) throw new Error(`unsupported native lifecycle event: ${event}`);
  const start = startedAt, budget = SHORT.has(event) ? 2200 : 550000;
  const deadlineAtMono = start + budget;
  const hostDeadlineAt = start + (SHORT.has(event) ? 2600 : 590000);
  const outcomes = [];
  try {
    const source = registry.readExpandedSettings(ROOT, { includeLocal: false }).hooks?.[event] || [];
    const projections = ["PostToolUse", "PermissionRequest"].includes(event) ? projectPayloads(payload) : [payload];
    const ran = projections.map(() => new Set());
    const matches = boundedMatcher(Date.now() + Math.max(0, deadlineAtMono - engine.now()));
    for (const local of [false, true]) {
      // Never read or execute local additions after a source refusal/fault.
      if (local && outcomes.some(restrictive)) break;
      const groups = local ? subtractSource(registry.readExpandedSettings(ROOT).hooks?.[event] || [], source) : source;
      for (const [index, projected] of projections.entries()) {
        const entries = selected(groups, projected, payload, matches, local ? ran[index] : new Set());
        if (!entries.length) continue;
        for (const entry of entries) ran[index].add(entry.hook);
        // Hygiene consumes the original patch; other edit hooks consume its
        // typed per-file projection (codex-native-policy.js::projectPayloads).
        const batches = event === "PostToolUse" && payload.tool_name === "apply_patch"
          ? [entries.filter(e => !RAW_PATCH_HOOKS.has(e.hook)), index === 0 ? entries.filter(e => RAW_PATCH_HOOKS.has(e.hook)) : []]
          : [entries];
        for (const [batchIndex, batch] of batches.entries()) {
          if (!batch.length) continue;
          const raw = JSON.stringify(batchIndex === 1 ? payload : projected);
          if (engine.now() >= deadlineAtMono) {
            outcomes.push(...batch.map(entry => failure(event, `${entry.hook} did not start: event deadline exhausted.`)));
            continue;
          }
          if (local) {
            const result = await runLocalSupervised({ entries: batch }, raw, deadlineAtMono, hostDeadlineAt);
            outcomes.push(...result.outcomes.map(out => adapt(event, out)));
            if (result.fault) outcomes.push(failure(event, result.fault.message));
          } else {
            const results = await engine.runDetectorsIsolated(batch, raw, { deadlineAtMono, watchdogSlackMs: 0, isolation: SHORT.has(event) ? "parallel" : "event" });
            outcomes.push(...results.map(out => adapt(event, out)));
          }
        }
      }
    }
  } catch (error) { outcomes.push(failure(event, error.message)); }
  return finalizeNativeEventFailure(event, merge(event, outcomes), rawPayload);
}

module.exports = { EVENTS, evaluateEvent, adapt, merge, restrictive, selected };
