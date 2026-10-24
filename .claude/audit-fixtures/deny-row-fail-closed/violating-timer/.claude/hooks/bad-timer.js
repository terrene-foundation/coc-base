"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — its own fail-open timer
// Never registered, never run: a lexical scan subject only.
const { runGuard } = require("./lib/guard-runner.js");
async function main() {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ continue: true }));
  }, 4000);
}
const hookMain = runGuard("bad-timer", main, { budgetMs: 5000 });
module.exports = { hookMain };
if (require.main === module) hookMain();
