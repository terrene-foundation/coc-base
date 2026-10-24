"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — CONFORMANT direct registration (hook-registry only), path.join require form
// Never registered, never run: a lexical scan subject only.
const path = require("path");
const { runGuard: rg } = require(path.join(__dirname, "lib", "guard-runner.js"));
async function main() { return undefined; }
const hookMain = rg("direct-guard", main, { budgetMs: 16000, standalone: true });
module.exports = { hookMain };
if (require.main === module) hookMain();
