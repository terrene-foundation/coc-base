#!/usr/bin/env node
/*
 * Shape D fixture — function returns { severity: "block", ... } and the
 * caller routes the return through instructAndWait() per
 * hook-output-discipline.md MUST-1.
 *
 * This is the canonical halting-hook pattern landed 2026-05-05 (the
 * `lib/instruct-and-wait.js` library). Pre-Shard-B, Shape D was missing
 * from the v6 §4.4 vocabulary and validate-bash-command.js's halting
 * predicates were silently unclassified.
 */

const { instructAndWait } = require("./lib/instruct-and-wait");

function validateBashGuardedExit(data) {
  const command = data.tool_input?.command || "";
  // Block dangerous shell commands by returning the canonical
  // instruct-and-wait shape; the caller does the actual exit.
  if (/^rm\s+-rf\s+\//.test(command)) {
    return {
      severity: "block",
      what_happened: `Dangerous command attempted: ${command.slice(0, 80)}`,
      why: "validate-bash-command/dangerous-pattern — rm -rf / is a destructive root-fs operation",
      reason: "rm -rf / is blocked",
      agent_must_report: [
        "Quote the exact command",
        "Confirm whether the user explicitly authorized this",
      ],
      agent_must_wait: "Do not retry. Wait for explicit user instruction.",
      user_summary: "rm -rf / blocked",
    };
  }
  return { continue: true, exitCode: 0 };
}

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const data = JSON.parse(input);
  const result = validateBashGuardedExit(data);
  if (result.severity) {
    const out = instructAndWait({
      hookEvent: "PreToolUse",
      severity: result.severity,
      what_happened: result.what_happened,
      why: result.why,
      agent_must_report: result.agent_must_report,
      agent_must_wait: result.agent_must_wait,
      user_summary: result.user_summary,
    });
    process.stdout.write(JSON.stringify(out.json) + "\n");
    process.exit(out.exitCode);
  }
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
});
