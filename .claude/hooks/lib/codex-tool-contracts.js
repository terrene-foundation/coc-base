"use strict";

const PLAN_TOOLS = new Set(["update_plan", "functionsupdate_plan"]);
const MESSAGE_TOOLS = new Set(["send_message", "collaborationsend_message"]);
const STATUS = new Set(["pending", "in_progress", "completed"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function projectStructuredTool(payload) {
  if (PLAN_TOOLS.has(payload.tool_name)) {
    const input = object(payload.tool_input, "native plan input");
    if (!Array.isArray(input.plan) || input.plan.length > 256) throw new Error("native plan must contain an array of at most 256 steps");
    if (input.explanation !== undefined && typeof input.explanation !== "string") throw new Error("native plan explanation must be a string");
    const todos = input.plan.map((step, index) => {
      object(step, `plan step ${index}`);
      if (!STATUS.has(step.status)) throw new Error(`plan step ${index} has an unsupported status`);
      return { content: nonempty(step.step, `plan step ${index}`), status: step.status };
    });
    if (input.todos !== undefined && JSON.stringify(input.todos) !== JSON.stringify(todos)) throw new Error("conflicting native plan/todo inputs");
    return { ...payload, tool_name: "TodoWrite", tool_input: { ...input, todos } };
  }
  if (MESSAGE_TOOLS.has(payload.tool_name)) {
    const input = object(payload.tool_input, "native message input");
    const recipients = [input.id, input.target, input.recipient].filter(v => v !== undefined);
    if (!recipients.length || recipients.some(v => nonempty(v, "native message recipient") !== recipients[0])) throw new Error("native message requires one unambiguous recipient");
    const content = nonempty(input.message, "native message");
    if (input.content !== undefined && input.content !== content) throw new Error("conflicting native message content");
    // Preserve only host-supplied sender identity on the outer payload; a
    // recipient is not the sender (dispatch-ledger.js:398–411).
    return { ...payload, tool_name: "SendMessage", tool_input: { ...input, recipient: recipients[0], content, type: "message" } };
  }
  return payload;
}

module.exports = { PLAN_TOOLS, MESSAGE_TOOLS, projectStructuredTool };
