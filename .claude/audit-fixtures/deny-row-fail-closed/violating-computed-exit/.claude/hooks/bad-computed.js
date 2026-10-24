"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — a computed process["exit"] (R1 MED-2), string and template spellings
// Never registered, never run: a lexical scan subject only.
const { runGuard } = require("./lib/guard-runner.js");
async function main(payload) {
  try { JSON.parse(payload.raw); } catch { process["exit"](0); }
  if (!payload.cwd) process[`exit`](0);
  return undefined;
}
const hookMain = runGuard("bad-computed", main, { budgetMs: 5000 });
module.exports = { hookMain };
if (require.main === module) hookMain();
