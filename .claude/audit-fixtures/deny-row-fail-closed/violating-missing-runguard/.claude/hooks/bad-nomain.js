"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — the OLD shape: hookMain is a plain function, no runner
// Never registered, never run: a lexical scan subject only.
async function main() { return undefined; }
function hookMain() {
  return main();
}
module.exports = { hookMain };
if (require.main === module) hookMain();
