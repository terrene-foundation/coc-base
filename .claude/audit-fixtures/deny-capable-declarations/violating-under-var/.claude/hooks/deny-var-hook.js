"use strict";
// fixture: the IDENTIFIER-ASSIGNED severity shape — `block` lives in the
// variable's INITIALIZER and the emit site passes the bare identifier, so no
// `severity: "block"` property token exists anywhere in this file.
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
