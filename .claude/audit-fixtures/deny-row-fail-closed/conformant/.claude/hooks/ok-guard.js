"use strict";
// FIXTURE for .claude/bin/check-deny-row-fail-closed.mjs — CONFORMANT; the prose below is the NEGATIVE control (a grep would red it)
// Never registered, never run: a lexical scan subject only.
// PROSE: catch (e) { console.log(JSON.stringify({ continue: true })); } and readStdinBounded()
const NOTE = "catch { continue: true } setTimeout(() => passthrough()) readStdinBounded";
const { runGuard } = require("./lib/guard-runner.js");
const fs = require("fs");
function allow(context) {
  process.stdout.write(JSON.stringify({ continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context } }) + "\n");
  process.exit(0);
}
async function main(payload) {
  let stat = null;
  try { stat = fs.statSync(String(payload.cwd)); } catch { stat = null; } // a cleanup catch: no passthrough
  try { fs.unlinkSync("/nonexistent"); } catch (e) { if (e && e.code !== "ENOENT") throw e; }
  const p = Promise.resolve(1).catch((e) => { throw e; });
  await p.then((v) => v, (e) => { throw e; });
  setTimeout(() => {}, 0).unref();
  if (!stat) return allow(NOTE); // the verdict path may allow — it is not an error path
  return undefined;
}
const hookMain = runGuard("ok-guard", main, { budgetMs: 5000 });
module.exports = { hookMain };
if (require.main === module) hookMain();
