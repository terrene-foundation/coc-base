/**
 * instruct-and-wait — canonical hook output shape for the graduated-trust system.
 *
 * Delivery-channel contract (verified against the CC hook docs 2026-06-09 —
 * loom #466). The host injects agent-facing context ONLY via documented fields;
 * arbitrary sibling fields (`validation`, `message`, `suppressOutput`) are
 * SILENTLY DROPPED — the agent never sees them:
 *   Stop / SessionEnd / PreCompact         → top-level `systemMessage`
 *                                            (`hookSpecificOutput` dropped here)
 *   PreToolUse / PostToolUse /             → `hookSpecificOutput.additionalContext`
 *     UserPromptSubmit / SessionStart        (non-block)
 *   PreToolUse BLOCK                       → exit code 2; the host feeds stderr
 *                                            back to the agent (additionalContext
 *                                            is NOT read once the call is denied)
 *
 * History (CRIT-1 + #466): the prior shape emitted `hookSpecificOutput.validation`,
 * a custom field CC drops — so the structured body (`what_happened`/`why`/
 * `agent_must_report`) reached the agent on NO event; only the `user_summary`
 * stderr line survived. This file is the canonical shape `hook-output-discipline.md`
 * MUST-1 mandates for every halting hook, so the drop degraded the structured
 * handoff fleet-wide.
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

  // 2. Event-aware JSON shape (mitigates CRIT-1 + #466 dropped-channel bug).
  if (STOP_LIKE_EVENTS.has(hookEvent)) {
    // Stop / SessionEnd / PreCompact — hookSpecificOutput is dropped; use systemMessage
    // `continue: true` always — these events cannot block tool calls
    return {
      json: { continue: true, systemMessage: validation },
      exitCode: 0,
    };
  }

  if (severity === "block") {
    // PreToolUse block ONLY. Exit code 2 is the proven, UNCHANGED block trigger
    // (the structural teeth at L2/L3 per trust-posture.md); on exit 2 the host
    // feeds stderr back to the agent, so the FULL instruction body goes to
    // stderr — that is the agent's delivery channel for a denied call
    // (additionalContext is NOT read once the call is blocked). The
    // permissionDecision/Reason pair carries the same body via the canonical
    // structured PreToolUse field for hosts that parse it; exit 2 remains
    // authoritative so the block teeth do not depend on it.
    process.stderr.write("\n" + validation + "\n");
    return {
      json: {
        continue: false,
        hookSpecificOutput: {
          hookEventName: hookEvent,
          permissionDecision: "deny",
          permissionDecisionReason: validation,
        },
      },
      exitCode: 2,
    };
  }

  // Non-block (halt-and-report / advisory / post-mortem) at
  // PreToolUse / PostToolUse / UserPromptSubmit / SessionStart — the body
  // reaches the agent ONLY via additionalContext.
  return {
    json: {
      continue: true,
      hookSpecificOutput: {
        hookEventName: hookEvent,
        additionalContext: validation,
      },
    },
    exitCode: 0,
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
