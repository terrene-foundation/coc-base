"use strict";
const fs = require("node:fs");
const path = require("node:path");
// Mistake guard only: caller-controlled markers do not establish a security boundary.
// Predicate: .claude/hooks/lib/test-runner-context.js::isTestRunnerContext.
function fixtureRunner(p) {
  if (typeof p !== "string" || !path.isAbsolute(p)) return false;
  try {
    const real = fs.realpathSync(p).split(path.sep).join("/");
    return fs.statSync(real).isFile() && (/\.test\.(?:mjs|cjs|js)$/.test(real) ||
      (/\/(?:audit-fixtures|test-harness)\//.test(real) && /\/run\.(?:mjs|cjs|js)$/.test(real)));
  } catch { return false; }
}
function isTestRunnerContext() {
  const ownRunner = process.argv[1] && path.resolve(process.argv[1]);
  return ["child-v8", "child-vm"].includes(process.env.NODE_TEST_CONTEXT) ||
    fixtureRunner(ownRunner) || fixtureRunner(process.env.COC_FIXTURE_RUNNER);
}
module.exports = { fixtureRunner, isTestRunnerContext };
