"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — process.exitCode set to a non-refusal code (R1 MED-2), two spellings
// Never registered, never run: a lexical scan subject only.
const { runGuard } = require("./lib/guard-runner.js");
async function main(payload) {
  try { JSON.parse(payload.raw); } catch { process.exitCode = 1; throw new Error("x"); }
  if (!payload.tool_name) { process["exitCode"] = 0; return undefined; }
  return undefined;
}
const hookMain = runGuard("bad-exitcode", main, { budgetMs: 5000 });
module.exports = { hookMain };
if (require.main === module) hookMain();
