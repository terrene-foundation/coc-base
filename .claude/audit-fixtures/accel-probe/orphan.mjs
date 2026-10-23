import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { resolveGitBinary, gitEnv } = require("../../hooks/lib/git-subprocess-env.js");

// The session-start probe deadline must hold when work lands BEFORE a probe spawns:
// every probe child is dead once the hook process has exited. The driver delays each
// probe spawn (synchronously, so the event loop is held exactly as slow pre-spawn work
// holds it), records every probe pid at spawn, and can refuse one probe's group kill
// with EPERM.
const DELAY_MS = 300;

export function orphanFixtures(root) {
  const hookPath = path.join(root, ".claude/hooks/session-start.js");
  const libraryPath = path.join(root, ".claude/hooks/lib/accel-probe.js");
  const hook = fs.readFileSync(hookPath, "utf8");
  const library = fs.readFileSync(libraryPath, "utf8");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "accel-orphan-"));
  const bin = path.join(scratch, "bin"), home = path.join(scratch, "home");
  fs.mkdirSync(bin); fs.mkdirSync(home);
  for (const name of ["csq", "ollama", "python3"]) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
  }
  const config = path.join(scratch, "ecosystem.json");
  fs.writeFileSync(config, JSON.stringify({ schema_version: 1, ecosystem: { id: "orphan" }, remote_links: {},
    rag: { reservoir_locator: "sqlite:///fixture.db", embedding: [{
      provider: "local", model_id: "fixture-model", dims: 1024, query_prefix_version: "v1",
    }] } }));
  const driver = path.join(scratch, "driver.cjs");
  fs.writeFileSync(driver, `const fs=require('node:fs'), path=require('node:path'), Module=require('node:module');
const cp=require('node:child_process'), spawn=cp.spawn, [,, hookSrc, hookFile, libSrc, libFile, pids]=process.argv;
const delays=JSON.parse(process.env.ORPHAN_DELAYS), refuse=process.env.ORPHAN_EPERM, byName={}, kill=process.kill;
cp.spawn=function(binary,args,options){
  const name=path.basename(binary);
  if(options&&options.detached&&delays[name])Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,delays[name]);
  const child=spawn.apply(this,arguments);
  if(options&&options.detached&&child.pid!==undefined){fs.appendFileSync(pids,child.pid+'\\n');byName[name]=child.pid;}
  return child;
};
process.kill=function(pid,signal){
  if(refuse&&signal==='SIGKILL'&&pid===-byName[refuse])
    throw Object.assign(new Error('kill EPERM'),{code:'EPERM',errno:-1,syscall:'kill'});
  return kill.apply(this,arguments);
};
const compile=(src,file)=>{const m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(src,'utf8'),file);return m.exports;};
const lib=compile(libSrc,libFile), load=Module._load;
Module._load=function(name,...args){return name==='./lib/accel-probe.js'?lib:load.call(this,name,...args);};
compile(hookSrc,hookFile).hookMain();
`);
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  const recorded = [];
  const uniform = { csq: DELAY_MS, ollama: DELAY_MS, python3: DELAY_MS };
  async function run(name, hookSource, librarySource, { delays = uniform, eperm = "" } = {}) {
    const project = path.join(scratch, name);
    fs.mkdirSync(project);
    execFileSync(resolveGitBinary(), ["init", "-q"], { cwd: project, env: gitEnv() });
    const hookFile = path.join(scratch, `${name}-hook.js`), libFile = path.join(scratch, `${name}-lib.js`);
    const pids = path.join(scratch, `${name}.pids`);
    fs.writeFileSync(hookFile, hookSource); fs.writeFileSync(libFile, librarySource); fs.writeFileSync(pids, "");
    const child = spawnSync(process.execPath, [driver, hookFile, hookPath, libFile, libraryPath, pids], {
      cwd: project, encoding: "utf8", timeout: 8000,
      input: JSON.stringify({ cwd: project, session_id: `orphan-${name}` }),
      env: { PATH: [bin, process.env.PATH].join(path.delimiter), HOME: home, USERPROFILE: home, COC_RUNTIME: "cc",
        CLAUDE_PROJECT_DIR: project, KAILASH_LEARNING_DIR: path.join(project, ".claude/learning"),
        LOOM_ECOSYSTEM_CONFIG: config, ORPHAN_DELAYS: JSON.stringify(delays), ORPHAN_EPERM: eperm },
    });
    const spawned = fs.readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
    recorded.push(...spawned);
    assert.equal(spawned.length, 3, `${name}: three delayed probe children spawned`);
    for (let attempt = 0; attempt < 25 && spawned.some(alive); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const context = JSON.parse(child.stdout.trim()).hookSpecificOutput?.additionalContext || "";
    return { status: child.status, stderr: child.stderr, survivors: spawned.filter(alive), context };
  }
  const exited = (outcome) => assert.equal(outcome.status, 0, `hook exited non-zero: ${outcome.stderr}`);
  const noSurvivor = (outcome) => {
    exited(outcome);
    assert.deepEqual(outcome.survivors, [], "no probe child survives the hook");
  };
  const mutate = (text, from, to) => {
    assert.equal(text.split(from).length, 2, "orphan mutation target reached exactly once");
    return text.replace(from, to);
  };
  return (async () => {
    try {
      noSurvivor(await run("live", hook, library));
      // Inner deadline dropped: each probe times out 1500ms after its LATE spawn, so the
      // fallback wins — and the fallback's kill of the recorded groups must still hold.
      const lateTimers = mutate(library, "}, Math.max(0, budget(deadline)));", "}, PROBE_TIMEOUT_MS);");
      const fallback = await run("late-timers", hook, lateTimers);
      assert.ok(fallback.context.includes("session-probe-timeout"), "late-timer mutation reached the fallback path");
      noSurvivor(fallback);
      const noKill = mutate(hook, "if (accel) accel.killOutstanding();", "");
      noSurvivor(await run("no-kill", noKill, library));
      const both = await run("late-timers-no-kill", noKill, lateTimers);
      assert.throws(() => noSurvivor(both), /no probe child survives the hook/);
      console.log(`RED CONTROL orphan: both layers dropped leaves ${both.survivors.length} probe children alive`);
      // rag-sec LOW-1: csq's spawn returns past the OUTER deadline, so the fallback wins
      // with csq still outstanding and the finally's killOutstanding meets an EPERM. The
      // hook must still exit 0 with its context. csq stays alive only because the stub
      // refused its kill; the finally below reaps it.
      const emits = (outcome) => {
        exited(outcome);
        assert.ok(outcome.context.includes("[ACCEL]") && outcome.context.includes("session-probe-timeout"),
          "LOW-1 hook context survives an EPERM in the kill path");
      };
      const refused = await run("eperm", hook, library, { delays: { csq: 1700 }, eperm: "csq" });
      emits(refused);
      assert.equal(refused.survivors.length, 1, "LOW-1 the EPERM stub reached the outstanding csq group");
      const rethrow = mutate(library, "    catch { /* Cleanup is best-effort per group; one failure must not strand the rest. */ }\n",
        '    catch (error) { if (error.code !== "ESRCH") throw error; }\n');
      const thrown = await run("eperm-rethrow", hook, rethrow, { delays: { csq: 1700 }, eperm: "csq" });
      assert.throws(() => emits(thrown), /hook exited non-zero/);
      console.log("RED CONTROL LOW-1: a rethrowing killOutstanding drops the hook's context and exits 1");
      return ["orphan-delayed-spawn-no-survivor", "orphan-fallback-kills-recorded-groups",
        "orphan-double-mutation-red", "LOW-1-hook-emits-context-through-eperm-and-mutation-red"];
    } finally {
      for (const pid of recorded) {
        try { process.kill(-pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  })();
}
