"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — DIRECT registration (.codex/hooks.json) whose standalone is a VARIABLE (not readable, so not declared)
// Never registered, never run: a lexical scan subject only.
const { runGuard } = require("./lib/guard-runner.js");
const STANDALONE = true;
async function main() { return undefined; }
const hookMain = runGuard("d-codex", main, { budgetMs: 5000, standalone: STANDALONE });
module.exports = { hookMain };
if (require.main === module) hookMain();
