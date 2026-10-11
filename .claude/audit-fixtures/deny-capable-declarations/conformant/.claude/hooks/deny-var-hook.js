"use strict";
// fixture: the same IDENTIFIER-ASSIGNED shape as violating-under-var, declared
// `on_incomplete: "deny"` in this tree's dispatch-registry.json — the quiet
// direction of that fixture's pole.
function hookMain() {
  const blocking = [];
  const severity = blocking.length ? "block" : "pre-action";
  const { instructAndWait } = require("./instruct-and-wait.js");
  return instructAndWait({
    hookEvent: "PreToolUse",
    severity,
    why: "fixture",
  });
}
module.exports = { hookMain };
