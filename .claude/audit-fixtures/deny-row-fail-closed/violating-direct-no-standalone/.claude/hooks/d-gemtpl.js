"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — DIRECT registration (.claude/gemini-templates/settings.json) with standalone: true NESTED under another key (not the option)
// Never registered, never run: a lexical scan subject only.
const { runGuard } = require("./lib/guard-runner.js");
async function main() { return undefined; }
const hookMain = runGuard("d-gemtpl", main, { budgetMs: 5000, refusal: { standalone: true } });
module.exports = { hookMain };
if (require.main === module) hookMain();
