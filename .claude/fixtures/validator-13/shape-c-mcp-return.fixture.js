#!/usr/bin/env node
// Shape C fixture — MCP response (validator 13, v6 §4.4).
//
// Predicate function: `validateWorkflowMcp`.
// Named, top-level. Returns `{isError: true, content: [...]}` — the MCP
// tool-rejection contract. Used by codex-mcp-guard/server.js when codex_hooks
// is in the under_development flag-fallback path.
// Expected POLICIES entry: reject rule blocking workflow names shorter than 3 chars.

"use strict";

/**
 * Rejects workflow invocations whose name is too short.
 * MCP shape: returns {isError, content} instead of calling process.exit.
 */
function validateWorkflowMcp(input) {
  const name = input.tool_input && input.tool_input.name;
  if (typeof name !== "string" || name.length < 3) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "workflow name must be >= 3 characters (Shape C fixture)",
        },
      ],
    };
  }
  return {
    isError: false,
    content: [{ type: "text", text: "ok" }],
  };
}

module.exports = { validateWorkflowMcp };
