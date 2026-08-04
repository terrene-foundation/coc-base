// FIXTURE (flag) — the exact regression shape that shipped in
// variants/py/hooks/validate-prod-deploy.js before the 2026-07-29 fix:
// a PreToolUse block emitted as a raw literal process.exit(2), so the agent
// receives an EMPTY stdout payload and cannot know why it was halted.
// hook-output-discipline.md MUST-1. Expects: FAIL.
const fs = require("fs");

if (!fs.existsSync("/tmp/.staging-passed")) {
  console.error("BLOCKED: production deploy without staging");
  process.exit(2); // Block
}
process.exit(0);
