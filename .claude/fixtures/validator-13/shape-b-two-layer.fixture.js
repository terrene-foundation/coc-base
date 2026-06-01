#!/usr/bin/env node
// Shape B fixture — two-layer via result dict (validator 13, v6 §4.4).
//
// Predicate function: `validateDeployment`.
// Named, top-level. Returns `{exitCode: N, ...}` with N >= 2 literal.
// Consumed by an anonymous process.stdin.on('end', ...) callback that
// pipes `result.exitCode` into `process.exit(...)`.
// Expected POLICIES entry: reject rule blocking deploys to prod from non-main.

"use strict";

/**
 * Rejects deployments targeting prod from a non-main branch.
 * Two-layer: returns a result dict; the caller invokes process.exit(result.exitCode).
 */
function validateDeployment(input) {
  const target = input.tool_input && input.tool_input.target;
  const branch = input.tool_input && input.tool_input.branch;
  if (target === "prod" && branch !== "main") {
    return {
      exitCode: 2,
      decision: "block",
      reason: "prod deploys must originate from main (Shape B fixture)",
    };
  }
  return { exitCode: 0 };
}

if (require.main === module) {
  let raw = "";
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    const input = raw ? JSON.parse(raw) : {};
    const result = validateDeployment(input);
    if (result.exitCode >= 2) {
      process.stderr.write(JSON.stringify(result) + "\n");
    }
    process.exit(result.exitCode);
  });
}

module.exports = { validateDeployment };
