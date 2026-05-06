#!/usr/bin/env node
/*
 * MCP Guardrail Companion Server — Codex fallback for hooks/*.js
 *
 * Emitted to `.codex-mcp-guard/server.js` in USE templates when
 * `codex_hooks.feature_flag = under_development` (see sync-manifest.yaml
 * cli_variants.hooks/*.js.codex.feature_flag_fallback).
 *
 * Contract: every reject-condition implemented in .claude/hooks/*.js MUST
 * have a coverage-equivalent reject-condition in this server. Enforced by
 * /sync emit-time validator 13 (AST predicate-set match) — see v5 spec.
 *
 * Module system: CommonJS (matches .claude/hooks/*.js convention).
 */

"use strict";

// ---------------------------------------------------------------------------
// Structural feature-flag gate — prevents fail-open default
// ---------------------------------------------------------------------------
// Zero-tolerance Rule 2 requires no stubs in production code paths. The
// POLICIES table below is populated by /sync validator 13 from the AST of
// .claude/hooks/*.js at emission time. Until that happens, this server
// MUST refuse to start — a fail-open guardrail is worse than no guardrail
// (it advertises coverage it does not provide).
//
// Validator 13 sets POLICIES_POPULATED=true and writes real predicates;
// attempting to run the server before that throws loudly.
const POLICIES_POPULATED = false;

if (!POLICIES_POPULATED && require.main === module) {
  process.stderr.write(
    [
      "codex-mcp-guard: refusing to start with unpopulated POLICIES table.",
      "",
      "This scaffold was emitted by /sync but validator 13 has not yet",
      "populated the policy predicates from .claude/hooks/*.js. Running",
      "the server in this state would fail-open on every tool invocation,",
      "which is worse than no guardrail at all (zero-tolerance Rule 2).",
      "",
      "To populate:",
      "  1. Ensure .claude/hooks/*.js contains the production hook policies.",
      "  2. Run /sync with validator 13 enabled; it AST-parses the hooks and",
      "     writes POLICIES here, setting POLICIES_POPULATED=true.",
      "  3. Re-run this server.",
      "",
      "See .codex-mcp-guard/README.md § Authoring.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Imports (loaded only after gate passes)
// ---------------------------------------------------------------------------
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const { parseHook } = require("../hooks/lib/runtime.js");

// ---------------------------------------------------------------------------
// Tool-wrap scope (parity with cli_variants.hooks/*.js.codex.wraps)
// ---------------------------------------------------------------------------
// Read-path tools (read, grep_tool, glob_tool) are INTENTIONALLY out of
// scope in the MCP fallback path — hooks with read-only policies are
// skipped on Codex when codex_hooks=under_development. Documented in
// README.md § Scope.
const WRAPPED_TOOLS = Object.freeze(["apply_patch", "unified_exec", "shell"]);

// ---------------------------------------------------------------------------
// Policy table — populated by /sync validator 13 from hooks/*.js AST
// ---------------------------------------------------------------------------
// Contract per v5 §4.4 validator 13:
//   POLICIES[tool] is an array of { id, predicate, reason } entries.
//   Each entry corresponds 1:1 with a hook-file predicate function per the
//   definition in v5 §4.4 validator 13. Bijection enforced at /sync time.
//
// Authoring discipline: the POLICIES table is never hand-edited. It is
// re-generated on every /sync from the hook AST. Hand edits are lost.
const POLICIES = Object.freeze({
  apply_patch: [],
  unified_exec: [],
  shell: [],
});

// ---------------------------------------------------------------------------
// MCP server registration
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "codex-mcp-guard", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

for (const tool of WRAPPED_TOOLS) {
  server.tool(tool, {
    description: `Guardrail wrapper for Codex ${tool} — enforces hooks/*.js parity`,
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "object" },
        session_id: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["input"],
    },
    handler: async ({ input, session_id, cwd }) => {
      // Build the same payload shape parseHook() expects from hooks/*.js
      // stdin, so policy predicates can be ported AST-for-AST.
      const raw = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: input,
        session_id,
        cwd,
      });
      const parsed = parseHook(raw); // reuses runtime.js COC_RUNTIME enum check

      const policies = POLICIES[tool] || [];
      for (const policy of policies) {
        if (policy.predicate(parsed)) {
          return {
            isError: true,
            content: [{ type: "text", text: policy.reason }],
          };
        }
      }
      return { content: [{ type: "text", text: "permit" }] };
    },
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`codex-mcp-guard fatal: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { POLICIES, WRAPPED_TOOLS, POLICIES_POPULATED };
