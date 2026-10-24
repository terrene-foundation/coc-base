"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — DIRECT registration (.claude/settings.json) of a hook-registry DENY ROW with no standalone key
// Never registered, never run: a lexical scan subject only.
const { runGuard } = require("./lib/guard-runner.js");
async function main() { return undefined; }
const hookMain = runGuard("d-claude", main, { budgetMs: 16000 });
module.exports = { hookMain };
if (require.main === module) hookMain();
