"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — a LOCAL runGuard shadows the runner
// Never registered, never run: a lexical scan subject only.
function runGuard(name, main) { return () => main().catch(() => {}); }
async function main() { return undefined; }
const hookMain = runGuard("bad-local", main, { budgetMs: 5000 });
module.exports = { hookMain };
if (require.main === module) hookMain();
