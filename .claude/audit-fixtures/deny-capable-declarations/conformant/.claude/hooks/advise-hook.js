"use strict";
// fixture: an advisory row with no refusal token in code (prose about severity: "block" is dropped).
function hookMain() { return { severity: "advisory" }; }
module.exports = { hookMain };
