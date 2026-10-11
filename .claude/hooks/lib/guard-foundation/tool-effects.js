/**
 * guard-foundation/tool-effects.js — L1 provider: the ORDERED effects a
 * tool call WOULD produce, in the SAME effect model as shell commands
 * (effects.js). A `Bash` tool call literally delegates to
 * shell-effects.js — one effect vocabulary, so a policy cannot learn about
 * `Bash` effects through one vocabulary and Edit effects through another.
 *
 * THE MUTATION SURFACE IS THE INVOCATION'S OWN FIELDS, never the tool NAME
 * alone. `lib/tool-classes.js` classifies tool names for the EXISTING hooks;
 * this provider goes one level deeper: it reports WHAT the named tool would
 * move (which path, in which direction), because "is a mutation tool" is not
 * enough for a deny>undetermined-on-protected decision — the target is.
 *
 * MISSING-FIELD DISCIPLINE (the ruling: a missing fact ⇒ undetermined, NEVER
 * false/allow):
 *   - an unknown/unmapped tool name is UNDETERMINED — never determined-empty.
 *     An unmapped mutating tool must not read as "no effects".
 *   - `Write` without `content` is undetermined: absent content is NOT empty
 *     content, and the write extent would be fabricated by assuming either.
 *   - `Bash` without `command` is undetermined: no command text, no effects.
 *   - malformed/missing tool input object is undetermined.
 *
 * PROSPECTIVE BYTES. `Write` is the one call whose extent is fully present in
 * the invocation, so its prospective byte count is derived
 * (Buffer.byteLength of `content`, basis "derived"). An `Edit`'s write extent
 * is the WHOLE file (unknown without reading it), so its bytes stay unknown —
 * `new_string` length is the delta, not the extent, and using it would be a
 * fabricated fact. Everything else is `basis: "unknown"`, which per the
 * effect model does not by itself flip the verdict.
 *
 * Style: CommonJS, zero-dep, pure — no fs, no spawn, no policy.
 */

"use strict";

const {
  EFFECT_KINDS,
  ENDPOINT_KINDS,
  BYTE_BASES,
  endpoint,
  endpointUnknown,
  byteProvenance,
  effect,
  effectList,
} = require("./effects.js");
const {
  determinedEffects,
  undeterminedEffects,
  missingFactReason,
} = require("./contract.js");
const { effectsForShellCommand } = require("./shell-effects.js");

function _readPathEffect(filePath) {
  return effect(EFFECT_KINDS.READ_BYTES, {
    from: endpoint(ENDPOINT_KINDS.PATH, filePath),
    to: endpoint(ENDPOINT_KINDS.PROCESS, "process"),
  });
}

function _writePathEffect(filePath, fromKind, fromValue, bytes) {
  return effect(EFFECT_KINDS.WRITE_BYTES, {
    from: endpoint(fromKind, fromValue),
    to: endpoint(ENDPOINT_KINDS.PATH, filePath),
    bytes,
  });
}

function _missingPathField(ctx, fieldName) {
  return undeterminedEffects(
    missingFactReason(`tool input.${fieldName} (${ctx.tool} call has no verifiable target)`),
    [],
    [],
  );
}

/**
 * effectsForToolCall — THE tool-call provider.
 *
 * @param {string} toolName - the runtime tool name (e.g. payload.tool_name)
 * @param {object} toolInput - the runtime tool input object
 * @param {object} [ctx] - reserved (cwd etc.); never used to guess a fact.
 * @returns {{verdict: string, effects: Array, reason: string|null, unresolved?: Array}}
 */
function effectsForToolCall(toolName, toolInput, ctx = {}) {
  void ctx;

  if (typeof toolName !== "string" || toolName.trim().length === 0) {
    return undeterminedEffects(missingFactReason("tool name"), [], []);
  }
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return undeterminedEffects(missingFactReason(`tool input object (${toolName} call)`), [], []);
  }

  const c = { tool: toolName };

  switch (toolName) {
    case "Bash": {
      if (typeof toolInput.command !== "string" || toolInput.command.trim().length === 0) {
        return undeterminedEffects(missingFactReason("tool input.command (Bash call)"), [], []);
      }
      return effectsForShellCommand(toolInput.command);
    }

    case "Write": {
      const filePath = toolInput.file_path;
      if (typeof filePath !== "string" || filePath.length === 0) {
        return _missingPathField(c, "file_path");
      }
      if (typeof toolInput.content !== "string") {
        return undeterminedEffects(
          missingFactReason(
            "tool input.content (absent content is not empty content; the write extent would be fabricated)",
          ),
          [],
          [],
        );
      }
      const bytes = byteProvenance({
        prospective: Buffer.byteLength(toolInput.content, "utf8"),
        basis: BYTE_BASES.DERIVED,
      });
      return determinedEffects(
        effectList([_writePathEffect(filePath, ENDPOINT_KINDS.ARGV, "tool:Write:content", bytes)]),
      );
    }

    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const fieldName = toolName === "NotebookEdit" ? "notebook_path" : "file_path";
      const filePath = toolInput[fieldName];
      if (typeof filePath !== "string" || filePath.length === 0) {
        return _missingPathField(c, fieldName);
      }
      if (toolName === "MultiEdit" && !Array.isArray(toolInput.edits)) {
        return undeterminedEffects(missingFactReason("tool input.edits (MultiEdit call)"), [], []);
      }
      // A textual edit READS the file and WRITES it back. The write extent is
      // the whole file (unknown without reading it); new_string length is the
      // delta, not the extent, so the byte count stays unknown on purpose.
      return determinedEffects(
        effectList([
          _readPathEffect(filePath),
          _writePathEffect(
            filePath,
            ENDPOINT_KINDS.ARGV,
            `tool:${toolName}:new content`,
            byteProvenance(),
          ),
        ]),
      );
    }

    case "Read": {
      const filePath = toolInput.file_path;
      if (typeof filePath !== "string" || filePath.length === 0) {
        return _missingPathField(c, "file_path");
      }
      return determinedEffects(effectList([_readPathEffect(filePath)]));
    }

    case "apply_patch": {
      // Codex's patch tool: `command` carries the patch text (see
      // lib/codex-native-policy.js). Destination paths are NOT parsed from
      // the patch in the L1 skeleton, so the write's `to` endpoint is
      // explicitly UNKNOWN — which forces the bounded undetermined verdict
      // rather than a write aimed at a fabricated destination.
      if (typeof toolInput.command !== "string" || toolInput.command.length === 0) {
        return undeterminedEffects(
          missingFactReason("tool input.command (apply_patch: patch text)"),
          [],
          [],
        );
      }
      const partial = effectList([
        effect(EFFECT_KINDS.WRITE_BYTES, {
          from: endpoint(ENDPOINT_KINDS.ARGV, "tool:apply_patch:command"),
          to: endpointUnknown(),
        }),
      ]);
      return undeterminedEffects(
        "patch destinations not parsed in the L1 skeleton: write targets unknown",
        partial,
        [{ span: "<patch text>", reason: "patch destination paths unresolved" }],
      );
    }

    default:
      return undeterminedEffects(
        `no effect model entry for tool "${toolName}": an unmapped tool is not assumed effect-free`,
        [],
        [{ span: toolName, reason: "unmodeled tool" }],
      );
  }
}

module.exports = { effectsForToolCall };
