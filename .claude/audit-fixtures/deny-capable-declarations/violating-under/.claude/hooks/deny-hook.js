"use strict";
// fixture: a deny-capable row (`severity: "block"` is a real refusal token).
function hookMain() { return { severity: "block", rule: "fixture/deny" }; }
module.exports = { hookMain };
