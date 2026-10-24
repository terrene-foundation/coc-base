"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — reads its payload through readStdinBounded
// Never registered, never run: a lexical scan subject only.
const { runGuard } = require("./lib/guard-runner.js");
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");
async function main() {
  const p = await readStdinBounded();
  return p ? undefined : undefined;
}
const hookMain = runGuard("bad-stdin", main, { budgetMs: 5000 });
module.exports = { hookMain };
if (require.main === module) hookMain();
