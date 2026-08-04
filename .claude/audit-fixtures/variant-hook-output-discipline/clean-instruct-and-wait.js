// FIXTURE (clean) — the compliant block-emission mechanism the base
// .claude/hooks/validate-prod-deploy.js uses: instructAndWait() builds the
// canonical six-field shape and the hook exits with out.exitCode (never a
// literal 2). hook-output-discipline.md MUST-1. Expects: PASS.
const fs = require("fs");
const { instructAndWait } = require("./lib/instruct-and-wait");

if (!fs.existsSync("/tmp/.staging-passed")) {
  const out = instructAndWait({
    hookEvent: "PreToolUse",
    severity: "block",
    what_happened: "Production deploy attempted without staging verification",
    why: "deploy-hygiene.md — staging MUST pass before production deploy",
    agent_must_report: ["Quote the exact deploy command that was attempted"],
    agent_must_wait: "Do not retry until staging has produced .staging-passed.",
    user_summary: "Production deploy blocked — staging verification missing",
  });
  console.log(JSON.stringify(out.json));
  process.exit(out.exitCode);
}
process.exit(0);
