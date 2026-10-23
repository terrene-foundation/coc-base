"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — CONFORMANT neighbours of the R1 MED-2 evasions (the control)
// Never registered, never run: a lexical scan subject only.
// PROSE: catch { process.exitCode = 1; return; } and process["exit"](0) — dropped by the lexer
const NOTE = 'catch { return; } process["exit"](0) process.exitCode = 1';
const { runGuard } = require("./lib/guard-runner.js");
function probe(p) {
  try { return JSON.parse(p); } catch { return; } // a HELPER's catch, not main's (a named blind spot)
}
async function main(payload) {
  let parsed = null;
  try { parsed = JSON.parse(payload.raw); } catch (e) { throw e; }
  try { probe(payload.raw); } catch { return null; } // returns a value, not bare
  try { probe(payload.cwd); } catch (e) { process.exit(2); return; } // unreachable after the refusal exit
  if (process.exitCode === 1) return NOTE; // a comparison, not an assignment
  if (!parsed) { process.exitCode = 2; return undefined; } // the literal refusal code
  if (parsed.deny) process.exit(2);
  return undefined;
}
const hookMain = runGuard("ok-exit", main, { budgetMs: 5000 });
module.exports = { hookMain };
if (require.main === module) hookMain();
