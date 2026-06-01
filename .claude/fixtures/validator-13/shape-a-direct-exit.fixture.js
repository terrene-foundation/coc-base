#!/usr/bin/env node
// Shape A fixture — one-layer direct-exit hook (validator 13, v6 §4.4).
//
// Predicate function: `validateBashCommand`.
// Named, top-level. Body contains a `process.exit(N)` call with N >= 2.
// Expected POLICIES entry: reject rule that blocks commands matching /rm -rf \//.

"use strict";

/**
 * Rejects dangerous `rm -rf /` invocations.
 * One-layer: the function itself calls process.exit(2) on the reject path.
 */
function validateBashCommand(input) {
  const command = input.tool_input && input.tool_input.command;
  if (!command) {
    return; // no-op on empty
  }
  if (/\brm\s+-rf\s+\//.test(command)) {
    process.stderr.write(
      JSON.stringify({
        decision: "block",
        reason: "rm -rf / is blocked (Shape A fixture)",
      }) + "\n"
    );
    process.exit(2);
  }
}

if (require.main === module) {
  let raw = "";
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    const input = raw ? JSON.parse(raw) : {};
    validateBashCommand(input);
  });
}

module.exports = { validateBashCommand };
