"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — a catch that prints continue:true, and a catch that exits 0
// Never registered, never run: a lexical scan subject only.
const { runGuard } = require("./lib/guard-runner.js");
async function main(payload) {
  try { JSON.parse(payload.raw); } catch (e) { console.log(JSON.stringify({ continue: true })); process.exit(1); }
  try { decide(payload); } catch { process.exit(0); }
}
function decide() {}
const hookMain = runGuard("bad-catch", main, { budgetMs: 5000 });
module.exports = { hookMain };
if (require.main === module) hookMain();
