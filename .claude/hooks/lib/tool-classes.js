/**
 * tool-classes.js — central classification of Claude Code tool names by
 * structural effect.
 *
 * F14 C2 iter-3 root-cause fix: prior iterations (iter-1, iter-2)
 * enforced "Edit/Write" mutation classification per-site across ~15 hook
 * files. R3 surfaced that even after iter-2's per-site sweep, additional
 * sites remained on the bare `tool === "Edit" || tool === "Write"`
 * pattern (adjacency-leasecheck.js, signing-mutation-guard.js,
 * genesis-anchor-guard.js, detect-violations.js). Per autonomous-execution.md
 * MUST Rule 4 + zero-tolerance.md Rule 4 (no workarounds — fix bug class
 * structurally): the structural defense is one helper module, every hook
 * routes through it.
 *
 * Architecture refs:
 *   - rules/hook-output-discipline.md MUST-1 — every halting hook MUST
 *     emit the full instructAndWait shape; tool-class classification is
 *     prerequisite to deciding whether to halt at all.
 *   - rules/cc-artifacts.md Rule 7 — hooks check structure; tool name IS
 *     the structural signal here (no semantic inference required).
 *
 * Contract (MUST):
 *   1. Adding a new mutation tool MUST extend `MUTATION_TOOLS` here
 *      AND nowhere else. Every hook consulting `isMutationTool(tool)`
 *      picks up the change automatically — no per-site sweep required.
 *   2. Per-site `tool === "Edit" || tool === "Write"` patterns are
 *      BLOCKED outside this file. The structural-sweep test in
 *      tests/integration/multi-operator/c2-auth-hardening-iter3.test.js
 *      enforces this with `grep -rn` exit-code assertions.
 *
 * Why a helper, not a constant set per-hook:
 *   - iter-1 fixed integrity-guard.js + posture-gate.js by adding
 *     MultiEdit/NotebookEdit to local sets.
 *   - iter-2 R2 surfaced that 4 OTHER hooks still had the bare
 *     `Edit || Write` pattern.
 *   - iter-3 R3 surfaced THE SAME class still present in additional
 *     hooks the iter-2 sweep missed.
 *   - Per-site enforcement is the bug-class generator. One helper is
 *     the structural close.
 *
 * Style: CommonJS (matches the rest of .claude/hooks/lib/), zero-dep,
 *   pure function. NEVER throws — non-string / null / undefined input
 *   returns `false` so callers can use the helper as a predicate
 *   without try/except boilerplate.
 */

"use strict";

/**
 * Set of tool names that mutate working-tree files.
 *
 * Mutation tools share the structural property: they accept a
 * `file_path` (or `notebook_path` for NotebookEdit) and produce a
 * working-tree write. Read-only tools (`Read`, `Grep`, `Glob`,
 * `WebFetch`) are NOT in this set even though they touch the filesystem.
 * Bash is its own tool class — its mutation surface is the command
 * string, not the tool name (handled by signing-mutation-guard.js's
 * separate classifier).
 *
 * Per Anthropic's CC tool inventory (as of 2026-06-12; Tools Reference at
 * code.claude.com/docs/en/tools-reference):
 *   - Edit         — single-file textual edit (file_path, old_string,
 *                    new_string; replace_all for batch replacement)
 *   - Write        — full-file write (file_path, content)
 *   - NotebookEdit — Jupyter notebook cell edit (notebook_path, ...)
 *
 * LEGACY TOLERANCE — "MultiEdit" (batch single-file edit, file_path +
 * edits[]) was REMOVED from Claude Code (~v2.0.8, 2025-10; restoration
 * declined per anthropic/claude-code#11125). It stays in MUTATION_TOOLS
 * deliberately: this Set classifies RUNTIME payloads (`payload.tool_name`),
 * keeping the classifier correct for ANY surface that reaches a hook
 * (the `*`-matched and Bash-classified blocks, plus direct invocation).
 * Scope precision (R1 security-reviewer, journal/0276 cycle): the
 * Edit-class settings matcher no longer routes MultiEdit, so on a
 * pre-removal CC the Edit-class residual is covered by the Bash-path
 * detectStateFileMutation layer (path-based, tool-name-independent) —
 * NOT by this Set. Set membership carries zero warning cost (unlike
 * settings.json permissions entries, which CC validates against the live
 * tool inventory and warns on — those were removed 2026-06-12,
 * journal/0276). Do NOT re-add MultiEdit to settings.json matchers or
 * permissions.
 *
 * EXTENSION PATH (when Anthropic ships a new mutation tool):
 *   1. Append the tool name to MUTATION_TOOLS below.
 *   2. Update the JSDoc bullet list above with the new tool's signature.
 *   3. Add a fixture under .claude/audit-fixtures/violation-patterns/
 *      isMutationTool/ if the tool name has a non-trivial structural
 *      shape (e.g., a multi-word name).
 *   4. (No per-site sweep required. Every hook consulting
 *      `isMutationTool(tool)` picks up the change automatically.)
 *      The iter-3 structural sweep test
 *      (tests/integration/multi-operator/c2-auth-hardening-iter3.test.js)
 *      enforces "no bare `tool === 'Edit' || tool === 'Write'`" via
 *      `grep -rn` exit-code assertions; missed extensions surface as
 *      sweep failures, not silent regressions.
 *
 * Same pattern as `cc-artifacts.md` Rule 8 (workspace-walking hooks
 * filter leading-underscore meta-dirs): the SSOT constant lives here;
 * extending it is the only edit required when Anthropic ships a new
 * mutation tool surface.
 */
const MUTATION_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * isMutationTool — predicate. Returns true iff the tool name is in
 * the MUTATION_TOOLS set. Robust to non-string / null / undefined input
 * (returns false rather than throwing).
 *
 * @param {*} tool - candidate tool name (typically `payload.tool_name`)
 * @returns {boolean}
 */
function isMutationTool(tool) {
  return typeof tool === "string" && MUTATION_TOOLS.has(tool);
}

module.exports = {
  MUTATION_TOOLS,
  isMutationTool,
};
