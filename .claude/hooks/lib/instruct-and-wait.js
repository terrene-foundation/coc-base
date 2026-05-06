/**
 * instruct-and-wait — canonical hook output shape for the graduated-trust system.
 *
 * Mitigates red-team CRIT-1 (Stop schema bug):
 *   Stop / SessionEnd / PreCompact emit `systemMessage` (top-level) — `hookSpecificOutput`
 *   is silently dropped on those events per CC schema.
 *   PreToolUse / PostToolUse / UserPromptSubmit / SessionStart use `hookSpecificOutput.validation`.
 *
 * Three severities:
 *   - block            tool call BLOCKED. Only meaningful at PreToolUse.
 *   - halt-and-report  tool ran (or event already fired); agent must surface and wait.
 *   - advisory         soft warning; agent acknowledges, may proceed.
 *   - post-mortem      forensic only (Stop-class events); surfaces at next SessionStart.
 */

const STOP_LIKE_EVENTS = new Set(["Stop", "SessionEnd", "PreCompact"]);

function buildValidationBody({
  severity,
  what_happened,
  why,
  agent_must_report,
  agent_must_wait,
}) {
  const head =
    severity === "block"
      ? "STOP — Tool call blocked."
      : severity === "halt-and-report"
        ? "STOP — Action requires acknowledgement."
        : severity === "post-mortem"
          ? "POST-MORTEM — Recorded for next session."
          : "ADVISORY — Acknowledge in next message.";
  const reportBlock =
    Array.isArray(agent_must_report) && agent_must_report.length
      ? "REPORT TO USER (do not skip any):\n" +
        agent_must_report.map((x) => "  - " + x).join("\n")
      : "";
  const waitBlock = agent_must_wait ? "THEN: " + agent_must_wait : "";
  return [
    head,
    "",
    "WHAT HAPPENED: " + what_happened,
    "WHY: " + why,
    "",
    reportBlock,
    "",
    waitBlock,
  ]
    .filter((l) => l !== null && l !== undefined)
    .join("\n");
}

/**
 * Build the JSON output for a hook. The caller decides exit code separately
 * (severity=block → exit 2 at PreToolUse; everything else → exit 0).
 */
function instructAndWait({
  hookEvent,
  severity, // "block" | "halt-and-report" | "advisory" | "post-mortem"
  what_happened,
  why,
  agent_must_report,
  agent_must_wait,
  user_summary,
}) {
  const validation = buildValidationBody({
    severity,
    what_happened,
    why,
    agent_must_report,
    agent_must_wait,
  });

  // 1. User-facing stderr line (mitigates user-visibility hole)
  if (user_summary) {
    const tag = severity.toUpperCase();
    process.stderr.write(`[${tag}] ${user_summary}\n`);
    process.stderr.write(
      `        See agent message for required report. (${why})\n`,
    );
  }

  // 2. Event-aware JSON shape (mitigates CRIT-1)
  if (STOP_LIKE_EVENTS.has(hookEvent)) {
    // Stop / SessionEnd / PreCompact — hookSpecificOutput is dropped; use systemMessage
    // `continue: true` always — these events cannot block tool calls
    return {
      json: { continue: true, systemMessage: validation },
      exitCode: 0,
    };
  }

  // PreToolUse / PostToolUse / UserPromptSubmit / SessionStart
  const cont = severity !== "block";
  return {
    json: {
      continue: cont,
      hookSpecificOutput: { hookEventName: hookEvent, validation },
    },
    exitCode: severity === "block" ? 2 : 0,
  };
}

/**
 * Helper: emit + exit. For use at hook script bottom.
 */
function emit(payload) {
  const out = instructAndWait(payload);
  process.stdout.write(JSON.stringify(out.json) + "\n");
  process.exit(out.exitCode);
}

module.exports = { instructAndWait, emit, STOP_LIKE_EVENTS };
