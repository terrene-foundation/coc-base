"use strict";

class IncompleteTranscriptProjectionError extends Error {
  constructor(observedCalls, unknownReasons) {
    super(unknownReasons.join("; "));
    this.name = "IncompleteTranscriptProjectionError";
    this.observedCalls = Object.freeze(observedCalls.slice());
    this.unknownReasons = Object.freeze(unknownReasons.slice());
  }
}

function recordedName(name) {
  if (typeof name !== "string" || !name.trim() || name !== name.trim()) throw new Error("recorded call has no inspectable tool name");
  const plain = name.replace(/^(?:functions|tools)\./, "");
  if (!plain.trim()) throw new Error("recorded call has no inspectable tool name");
  if (plain === "exec") throw new Error("recorded executor call has no inspectable history contract");
  return name;
}

function validateRecordedInput(name, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("recorded call input is not an object");
  if (name === "Bash" && (typeof input.command !== "string" || !input.command.trim())) throw new Error("recorded Bash history has no inspectable command");
  if (["Edit", "Write"].includes(name) && (typeof input.file_path !== "string" || !input.file_path.trim())) throw new Error("recorded edit history has no inspectable target");
  return input;
}

// Normalizes recorded calls, not successful execution. Native wire examples:
// https://github.com/openai/codex/blob/main/codex-rs/core/tests/common/responses.rs
// Code-mode JavaScript and arbitrary shell writes have no complete target set.
function transcriptToolCalls(entry) {
  if (!entry || typeof entry !== "object") return [];
  if (entry.message && Array.isArray(entry.message.content)) {
    if ((entry.type !== undefined && entry.type !== "assistant") || (entry.message.role !== undefined && entry.message.role !== "assistant")) return [];
    const observedCalls = [];
    const unknownReasons = [];
    for (const b of entry.message.content.filter(b => b?.type === "tool_use")) {
      try {
        const name = recordedName(b.name);
        observedCalls.push({ name, input: validateRecordedInput(name, b.input) });
      } catch (error) {
        unknownReasons.push(error.message);
      }
    }
    if (unknownReasons.length) throw new IncompleteTranscriptProjectionError(observedCalls, unknownReasons);
    return observedCalls;
  }
  if (entry.type !== "response_item" || !entry.payload || typeof entry.payload !== "object") return [];
  const item = entry.payload;
  if (!["function_call", "custom_tool_call"].includes(item.type)) {
    if (typeof item.type === "string" && item.type.endsWith("_call")) {
      throw new Error("unsupported native execution-call record kind");
    }
    return [];
  }
  const name = recordedName(item.name).replace(/^(?:functions|tools)\./, "");
  let input;
  if (item.type === "function_call") {
    if (typeof item.arguments !== "string") throw new Error("native call arguments are not JSON text");
    try { input = JSON.parse(item.arguments); }
    catch { throw new Error("native call arguments are malformed JSON"); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("native call arguments are not an object");
  } else if (name === "apply_patch" && typeof item.input === "string") input = { command: item.input };
  else throw new Error("native custom call has no inspectable history contract");
  const runtime = require("./codex-hook-runtime");
  if (runtime.NATIVE_SHELL_TOOLS.has(name)) {
    const normalized = runtime.normalizeNativeInput({ tool_name: name, tool_input: input });
    const raw = normalized.tool_input.command;
    const command = Array.isArray(raw) ? runtime.commandRenderings(raw)[0] : raw;
    if (typeof command !== "string" || !command.trim()) throw new Error("native shell history has no inspectable command");
    return [{ name: "Bash", input: { ...input, command } }];
  }
  if (name === "apply_patch") {
    const aliases = [input.command, input.patch, input.input].filter(v => v !== undefined);
    if (!aliases.length || aliases.some(v => typeof v !== "string" || v !== aliases[0])) throw new Error("native patch history has invalid or conflicting aliases");
    const { synthesizePolicyInputs } = require("../../codex-mcp-guard/server");
    const targets = synthesizePolicyInputs("apply_patch", { command: aliases[0] });
    if (!targets.length || targets.some(value => !value.file_path)) throw new Error("native patch history has no verifiable targets");
    return targets.map(input => ({ name: "Edit", input }));
  }
  return [{ name, input: validateRecordedInput(name, input) }];
}

module.exports = { transcriptToolCalls, IncompleteTranscriptProjectionError };
