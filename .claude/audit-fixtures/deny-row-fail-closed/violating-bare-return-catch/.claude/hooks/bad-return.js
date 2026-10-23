"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — a bare return inside main's catch (R1 MED-2), two spellings
// Never registered, never run: a lexical scan subject only.
const { runGuard } = require("./lib/guard-runner.js");
async function main(payload) {
  try { JSON.parse(payload.raw); } catch { return; }
  try { decide(payload); } catch (e) { return undefined; }
  return undefined;
}
function decide() {}
const hookMain = runGuard("bad-return", main, { budgetMs: 5000 });
module.exports = { hookMain };
if (require.main === module) hookMain();
