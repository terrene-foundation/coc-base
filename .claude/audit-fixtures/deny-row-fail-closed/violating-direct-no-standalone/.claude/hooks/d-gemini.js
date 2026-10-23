"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — DIRECT registration (.gemini/settings.json, not through the adapter) with standalone: false
// Never registered, never run: a lexical scan subject only.
const { runGuard } = require("./lib/guard-runner.js");
async function main() { return undefined; }
const hookMain = runGuard("d-gemini", main, { budgetMs: 5000, standalone: false });
module.exports = { hookMain };
if (require.main === module) hookMain();
