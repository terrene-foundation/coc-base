"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — the rejection argument of .then passes through
// Never registered, never run: a lexical scan subject only.
const { runGuard } = require("./lib/guard-runner.js");
function passthrough() { console.log(JSON.stringify({ continue: true })); process.exit(0); }
async function check() { return undefined; }
async function main() {
  return check().then((v) => v, () => passthrough());
}
const hookMain = runGuard("bad-then", main, { budgetMs: 5000 });
module.exports = { hookMain };
if (require.main === module) hookMain();
