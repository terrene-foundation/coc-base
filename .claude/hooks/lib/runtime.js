/**
 * Shared hook runtime — COC_RUNTIME closed-enum validation + parseHook contract.
 *
 * Used by:
 *   - .claude/hooks/*.js (CommonJS consumers, via require)
 *   - .claude/codex-mcp-guard/server.js (via require — MCP guard companion)
 *
 * The COC_RUNTIME env var is a closed enum: {cc, codex, gemini}. Silent
 * passthrough of an unknown value is BLOCKED (zero-tolerance Rule 3 — no
 * silent fallbacks). See v3 §4.3 PoC C-2.
 *
 * Origin: v3 §4.3 + v5 session 2026-04-22 (analyst B-19 Defect 1 — module
 * was referenced by MCP guard but never authored).
 */

const VALID_RUNTIMES = new Set(["cc", "codex", "gemini"]);

/**
 * Normalize a CLI-specific hook event name to a canonical form.
 * CC uses PascalCase (`PreToolUse`); Codex / Gemini may use snake_case.
 */
function normalizeEvent(hookEventName, runtime) {
  if (!hookEventName) return null;
  if (runtime === "cc") return hookEventName;
  // codex / gemini snake_case → PascalCase
  return hookEventName
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Parse a raw hook-invocation JSON payload into the canonical shape every
 * hook consumes. Validates COC_RUNTIME at parse time; throws on unknown or
 * missing runtime rather than silently defaulting.
 *
 * @param {string} raw - JSON-encoded hook payload (from stdin or MCP call)
 * @returns {object} - { runtime, event, toolName, toolInput, prompt, sessionId, cwd, projectDir }
 * @throws {Error} - if COC_RUNTIME is unset or not in VALID_RUNTIMES
 */
function parseHook(raw) {
  const runtime = process.env.COC_RUNTIME;
  if (!runtime) {
    throw new Error(
      "COC_RUNTIME env not set; emitter-generated wrapper required " +
        "(set COC_RUNTIME=cc|codex|gemini before invoking hook)",
    );
  }
  if (!VALID_RUNTIMES.has(runtime)) {
    throw new Error(
      `COC_RUNTIME='${runtime}' invalid; must be cc, codex, or gemini`,
    );
  }

  const data = JSON.parse(raw);
  return {
    runtime,
    event: normalizeEvent(data.hook_event_name, runtime),
    toolName: data.tool_name ?? (data.tool && data.tool.name),
    toolInput: data.tool_input ?? (data.tool && data.tool.input),
    prompt: data.prompt ?? data.user_prompt,
    sessionId: data.session_id,
    cwd: data.cwd,
    projectDir:
      process.env.CLAUDE_PROJECT_DIR ||
      process.env.GEMINI_PROJECT_DIR ||
      process.env.CODEX_HOME,
  };
}

module.exports = {
  VALID_RUNTIMES,
  parseHook,
  normalizeEvent,
};
