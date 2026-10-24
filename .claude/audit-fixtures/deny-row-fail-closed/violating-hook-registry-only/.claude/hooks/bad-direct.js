"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — declared deny ONLY in hook-registry.json; an uncaughtException handler passes through
// Never registered, never run: a lexical scan subject only.
const { runGuard } = require("./lib/guard-runner.js");
async function main() {
  process.on("uncaughtException", () => { process.stdout.write(JSON.stringify({ continue: true })); });
}
const hookMain = runGuard("bad-direct", main, { budgetMs: 16000, standalone: true });
module.exports = { hookMain };
if (require.main === module) hookMain();
