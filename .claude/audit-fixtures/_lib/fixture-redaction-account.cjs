"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fixtureRunner, isTestRunnerContext } = require("../../hooks/lib/test-runner-context.js");
// Mistake guard, not a security boundary: caller-controlled test markers are advisory.
// Outside tests the preload is inert, including when a CLI inherits NODE_OPTIONS.
if (isTestRunnerContext()) {
const ownRunner = process.argv[1] && path.resolve(process.argv[1]);
if (fixtureRunner(ownRunner)) process.env.COC_FIXTURE_RUNNER = fs.realpathSync(ownRunner);
const original = os.userInfo.bind(os);
let fixtureHome, linkedDirectory;
function validateFixtureMap(map) {
  if (path.basename(map) !== "redaction-map.json") throw new Error("fixture-redaction-account requires redaction-map.json");
}
function selectFixtureAccount(map = process.env.COC_REDACTION_MAP) {
  if (map) validateFixtureMap(map);
  if (!fixtureHome) {
    fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "coc-fixture-account-"));
    fs.mkdirSync(path.join(fixtureHome, ".config"));
    fs.mkdirSync(path.join(fixtureHome, "empty"));
  }
  const dir = map ? path.dirname(path.resolve(map)) : path.join(fixtureHome, "empty");
  if (dir !== linkedDirectory) {
    const link = path.join(fixtureHome, ".config", "coc");
    if (linkedDirectory) fs.unlinkSync(link);
    fs.symlinkSync(dir, link, process.platform === "win32" ? "junction" : "dir");
    linkedDirectory = dir;
  }
  return fixtureHome;
}

function accountHome() {
  const map = process.env.COC_REDACTION_MAP;
  return selectFixtureAccount(map);
}

os.userInfo = (...args) => ({ ...original(...args), homedir: accountHome() });
process.on("exit", () => {
  if (fixtureHome) try { fs.rmSync(fixtureHome, { recursive: true, force: true }); } catch { /* fixture cleanup */ }
});
module.exports = { selectFixtureAccount };
}
