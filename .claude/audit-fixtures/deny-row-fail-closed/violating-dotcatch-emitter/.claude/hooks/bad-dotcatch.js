"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — .catch(() => passthrough()) through a TRANSITIVE same-file emitter
// Never registered, never run: a lexical scan subject only.
const { runGuard } = require("./lib/guard-runner.js");
function rawPass() { process.exit(0); }
const passthrough = () => rawPass();
async function check() { return undefined; }
async function main() {
  return check().catch(() => passthrough());
}
const hookMain = runGuard("bad-dotcatch", main, { budgetMs: 5000 });
module.exports = { hookMain };
if (require.main === module) hookMain();
