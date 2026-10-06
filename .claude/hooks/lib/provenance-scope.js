/**
 * provenance-scope — the REGISTRATION scope of `provenance-capture-tool.js`,
 * DERIVED from the one editing-tools list rather than hand-typed.
 *
 * WHY THIS MODULE EXISTS (FW-1). The hook sat on the PreToolUse `*` matcher, so
 * a Read/Grep/Glob call started it only for `classify()` to return null — the
 * record-nothing path. Narrowing the matcher is safe only if the narrowed set
 * CANNOT miss a tool the classifier would record, and a hand-typed alternation
 * is exactly the thing that drifts: `MUTATION_TOOLS` gains a member and the
 * matcher silently stops covering it. So the registry row AND the drift check
 * both read THIS module, and this module reads `tool-classes.js`.
 *
 * WHAT IS DERIVED FROM WHERE
 *   - MUTATION tools: `tool-classes.js::MUTATION_TOOLS` — that file's own
 *     contract is "Adding a new mutation tool MUST extend `MUTATION_TOOLS` here
 *     AND nowhere else", so this module derives rather than re-declares.
 *   - SHELL and DELEGATION tools: declared here, because they are this hook's
 *     own classification surface (`classify()` classifies by EFFECT and reads
 *     these sets FROM HERE — one copy, no drift between classifier and matcher).
 *   - NON-CC tools (Gemini / Codex vocabularies): declared here and DELIBERATELY
 *     EXCLUDED from the matcher — they are registered on those CLIs' own
 *     surfaces, never in `dispatch-registry.json`. `NON_CC_TOOLS` names them so
 *     the drift check can REQUIRE their absence instead of reading them as
 *     omissions.
 *
 * PURE: no IO, no registry read. The registry belongs to the CALLER, so the same
 * predicate serves the generator, the regression test, and any CI validator.
 */
"use strict";

const { MUTATION_TOOLS } = require("./tool-classes.js");

/** CC's shell tool — the consequential-command surface on this CLI. */
const CC_SHELL_TOOLS = Object.freeze(["Bash"]);
/** Delegation: `Agent` is CC's current name, `Task` the vanilla/legacy alias. */
const DELEGATION_TOOLS = Object.freeze(["Agent", "Task"]);

/** Gemini write-tool vocabulary (classify() maps by effect, not by CLI). */
const GEMINI_WRITE_TOOLS = Object.freeze(["write_file", "replace"]);
/** Codex write-tool vocabulary. */
const CODEX_WRITE_TOOLS = Object.freeze(["apply_patch"]);
/** Gemini shell tool. */
const GEMINI_SHELL_TOOLS = Object.freeze(["run_shell_command"]);
/** Codex shell tools (`shell` and its argv-array sibling). */
const CODEX_SHELL_TOOLS = Object.freeze(["shell", "unified_exec"]);

/** Everything `classify()` treats as a shell surface, on every CLI. */
const SHELL_TOOLS = Object.freeze([
  ...CC_SHELL_TOOLS,
  ...GEMINI_SHELL_TOOLS,
  ...CODEX_SHELL_TOOLS,
]);

/**
 * Tool names that exist on OTHER CLIs and MUST NOT appear in a CC settings
 * matcher. Named as data (not as a comment) so the drift check ENFORCES their
 * absence: a matcher carrying `apply_patch` is a row that can never match on CC,
 * which reads exactly like coverage while providing none.
 */
const NON_CC_TOOLS = Object.freeze([
  ...GEMINI_WRITE_TOOLS,
  ...CODEX_WRITE_TOOLS,
  ...GEMINI_SHELL_TOOLS,
  ...CODEX_SHELL_TOOLS,
]);

/**
 * The CC tool names a registry row for this hook must cover, in class order.
 *
 * `MultiEdit` IS INCLUDED, and that is a deliberate security-review correction
 * (FW-1 finding 3). An earlier revision excluded it by generalising
 * `tool-classes.js`'s "do NOT re-add MultiEdit to settings.json matchers or
 * permissions" into THIS surface, and that lost AUDIT COVERAGE: `classify()`
 * still returns an `Action` for `MultiEdit` (it is in `MUTATION_TOOLS`, which
 * classifies RUNTIME payloads), so before the narrowing a MultiEdit call
 * produced a provenance record — and after it, none.
 *
 * The two surfaces are NOT the same surface: that R1 ban is about the CC
 * SETTINGS matchers and permission entries, where CC validates a matcher against
 * the live tool inventory. This module builds a DISPATCHER-REGISTRY row, matched
 * in-process by `lib/dispatch-main.js`, where an alternative that never matches
 * costs nothing and an alternative that is MISSING costs a governance record on
 * any surface still emitting the tool.
 *
 * The drift check enforces the consequence: every tool name `classify()` records
 * must be admitted by the matcher.
 */
function matcherTools() {
  return [...CC_SHELL_TOOLS, ...MUTATION_TOOLS, ...DELEGATION_TOOLS];
}

/** @type {readonly string[]} */
const PROVENANCE_MATCHER_TOOLS = Object.freeze(matcherTools());

/**
 * The `matcher` string a registry row for `provenance-capture-tool.js` MUST
 * carry. The drift check compares the registry against THIS value, so a
 * hand-typed edit — or a `*` re-widening — reds a named case.
 */
const PROVENANCE_MATCHER = PROVENANCE_MATCHER_TOOLS.join("|");

module.exports = {
  CC_SHELL_TOOLS,
  DELEGATION_TOOLS,
  GEMINI_WRITE_TOOLS,
  CODEX_WRITE_TOOLS,
  GEMINI_SHELL_TOOLS,
  CODEX_SHELL_TOOLS,
  SHELL_TOOLS,
  NON_CC_TOOLS,
  PROVENANCE_MATCHER_TOOLS,
  PROVENANCE_MATCHER,
};
