import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { resolveGitBinary, gitEnv } = require("../../hooks/lib/git-subprocess-env.js");

export function sessionStartGolden(root) {
  const sourcePath = path.join(root, ".claude/hooks/session-start.js");
  const live = fs.readFileSync(sourcePath, "utf8");
  const baseline = execFileSync(resolveGitBinary(), ["show", "ec25c9928:.claude/hooks/session-start.js"],
    { cwd: root, encoding: "utf8", env: gitEnv() });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "accel-golden-"));
  const project = path.join(scratch, "project"), home = path.join(scratch, "home");
  fs.mkdirSync(project); fs.mkdirSync(home);
  const driver = path.join(scratch, "driver.cjs");
  fs.writeFileSync(driver, `const fs=require('node:fs'), Module=require('node:module');
const RealDate=Date; global.Date=class extends RealDate {constructor(...args){super(...(args.length?args:['2026-01-01T00:00:00.000Z']));} static now(){return 1767225600000;}};
const load=Module._load; Module._load=function(name,...args){
  if(name==='./lib/accel-probe.js')return {SESSION_BUDGET_MS:1600,killOutstanding(){},probeAll:()=>process.argv[4]==='hang'?new Promise(()=>{}):Promise.resolve([
    {kind:'engine',outcome:'unavailable',reason:'no-locator',rung:'R0'},
    {kind:'ollama',outcome:process.argv[4]==='undetermined'?'undetermined':'unavailable',reason:'slot-empty',rung:'R0'},
    {kind:'csq',outcome:process.argv[4]==='undetermined'?'undetermined':'unavailable',reason:'not-installed',rung:'R0'}])};
  return load.call(this,name,...args);
};
const filename=process.argv[3], instance=new Module(filename); instance.filename=filename;
instance.paths=Module._nodeModulePaths(require('node:path').dirname(filename));
instance._compile(fs.readFileSync(process.argv[2],'utf8'),filename); instance.exports.hookMain();
`);
  function run(source, name, mode = "absent") {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(project); fs.mkdirSync(home);
    execFileSync(resolveGitBinary(), ["init", "-q"], { cwd: project, env: gitEnv() });
    const file = path.join(scratch, `${name}.js`);
    fs.writeFileSync(file, source);
    const started = performance.now();
    const child = spawnSync(process.execPath, [driver, file, sourcePath, mode], {
      cwd: project, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ cwd: project, session_id: "golden-session" }),
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, COC_RUNTIME: "cc",
        CLAUDE_PROJECT_DIR: project, KAILASH_LEARNING_DIR: path.join(project, ".claude/learning") },
    });
    assert.equal(child.status, 0, `${name}: ${child.stderr}`);
    assert.ok(performance.now() - started < 5000, `${name}: session-start exceeded 5s`);
    const output = JSON.parse(child.stdout.trim());
    return { context: output.hookSpecificOutput?.additionalContext || "", stderr: child.stderr };
  }
  try {
    const old = run(baseline, "baseline");
    const now = run(live, "live");
    function verify(current) {
      const lines = current.context.split("\n");
      assert.equal(lines.filter((line) => line.startsWith("[ACCEL]")).length, 1, "accel-line-count");
      const remaining = current.context.replace(/^\[ACCEL\][^\n]*(?:\n\n|$)/, "");
      assert.equal(remaining, old.context, "context-byte-parity");
      assert.equal(current.stderr, old.stderr, "stderr-byte-parity");
    }
    verify(now);
    const target = "if (result.accelContext) ctxParts.push(result.accelContext);";
    assert.equal(live.split(target).length, 2, "line mutation reached");
    assert.throws(() => verify(run(live.replace(target, ""), "drop")), /accel-line-count/);
    assert.throws(() => verify(run(live.replace(target,
      "if (result.accelContext) ctxParts.push(result.accelContext, result.accelContext);"), "double")), /accel-line-count/);
    const hung = run(live, "hang", "hang");
    assert.ok(hung.context.includes("session-probe-timeout"), "forced hang must reach the session deadline");
    const lowRungs = (current) => {
      const line = current.context.split("\n").find((entry) => entry.startsWith("[ACCEL]"));
      const rung = (name) => line.split(`${name}=`)[1].split("(")[0];
      assert.equal(rung("embed"), "E0", "R1-C-MED-1 undetermined embedding rung");
      assert.equal(rung("broker"), "B0", "R1-C-MED-1 undetermined broker rung");
    };
    lowRungs(run(live, "undetermined", "undetermined"));
    for (const target of ['local?.outcome === "available"', 'broker?.outcome === "available"']) {
      assert.equal(live.split(target).length, 2, "rung mutation reached exactly once");
      const mutated = run(live.replace(target, target.replace('=== "available"', '!== "unavailable"')),
        target.startsWith("local") ? "embed-mutant" : "broker-mutant", "undetermined");
      assert.throws(() => lowRungs(mutated), /R1-C-MED-1 undetermined/);
    }
    return ["session-golden-byte-parity", "session-drop-and-double-mutations-red", "session-forced-hang-under-5s",
      "R1-C-MED-1-undetermined-rungs-and-mutations-red"];
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
