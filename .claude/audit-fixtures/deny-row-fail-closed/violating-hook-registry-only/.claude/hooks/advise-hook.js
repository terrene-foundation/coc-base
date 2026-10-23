"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — an ADVISORY row: it may fail open, and is NOT scanned
// Never registered, never run: a lexical scan subject only.
function hookMain() {
  setTimeout(() => { console.log(JSON.stringify({ continue: true })); process.exit(1); }, 5000);
  try { JSON.parse("{"); } catch { console.log(JSON.stringify({ continue: true })); process.exit(0); }
}
module.exports = { hookMain };
