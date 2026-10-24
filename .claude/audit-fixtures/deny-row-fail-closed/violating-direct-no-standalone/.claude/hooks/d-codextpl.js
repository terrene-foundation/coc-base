"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — DIRECT registration (.claude/codex-templates/hooks.json) whose options are a VARIABLE (not readable, so not declared)
// Never registered, never run: a lexical scan subject only.
const { runGuard } = require("./lib/guard-runner.js");
const OPTS = { budgetMs: 5000, standalone: true };
async function main() { return undefined; }
const hookMain = runGuard("d-codextpl", main, OPTS);
module.exports = { hookMain };
if (require.main === module) hookMain();
