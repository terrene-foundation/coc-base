import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import Module from "node:module";

// rag-sec LOW-1 (killOutstanding must not throw or strand later groups) and LOW-2
// (the ollama tag match must stay linear inside the session deadline).
export async function secLowFixtures(library) {
  const source = fs.readFileSync(library, "utf8");
  const load = (text) => {
    const instance = new Module(library);
    instance.filename = library;
    instance.paths = Module._nodeModulePaths(path.dirname(library));
    const spawns = [];
    const originalRequire = instance.require;
    instance.require = function (id) {
      const dependency = originalRequire.call(this, id);
      if (id !== "node:child_process") return dependency;
      return { ...dependency, spawn(...args) {
        const record = { pid: null, error: null, close: null };
        spawns.push(record);
        try {
          const child = Reflect.apply(dependency.spawn, this, args);
          record.pid = child.pid ?? null;
          child.once("error", (error) => { record.error = error.code || error.name; });
          child.once("close", (code, signal) => { record.close = { code, signal }; });
          return child;
        } catch (error) {
          record.error = error.code || error.name;
          throw error;
        }
      } };
    };
    try {
      instance._compile(text + "\nmodule.exports.fixtureCommand = command;\nmodule.exports.fixtureOllamaTag = ollamaTag;\n", library);
    } finally { instance.require = originalRequire; }
    instance.exports.fixtureSpawns = spawns;
    return instance.exports;
  };
  const mutate = (from, to) => {
    assert.equal(source.split(from).length, 2, "sec-low mutation target reached exactly once");
    return load(source.replace(from, to));
  };
  const real = load(source);
  const passed = [];

  const tagged = (subject, length) => {
    const name = ":".repeat(length) + "/";
    const started = performance.now();
    const value = subject.fixtureOllamaTag(name);
    return { elapsed: performance.now() - started, value };
  };
  const linear = (outcome) => assert.ok(outcome.elapsed < 50,
    `LOW-2 pathological id took ${outcome.elapsed.toFixed(1)}ms (>= 50ms)`);
  const long = tagged(real, 160000);
  linear(long);
  assert.equal(long.value, ":".repeat(160000) + "/:latest", "LOW-2 a ':' before the last '/' is not a tag");
  for (const [name, expected] of [["bge-m3", "bge-m3:latest"], ["bge-m3:q4", "bge-m3:q4"],
    ["host:5000/model", "host:5000/model:latest"], ["host:5000/model:v2", "host:5000/model:v2"]]) {
    assert.equal(real.fixtureOllamaTag(name), expected, `LOW-2 tag semantics for ${name}`);
  }
  const quadratic = mutate('return name.slice(name.lastIndexOf("/") + 1).includes(":") ? name : `${name}:latest`;',
    "return /:[^/]*$/.test(name) ? name : `${name}:latest`;");
  assert.equal(quadratic.fixtureOllamaTag("host:5000/model"), "host:5000/model:latest", "regex mutation reached");
  const slow = tagged(quadratic, 40000);
  assert.throws(() => linear(slow), /LOW-2 pathological id took/);
  console.log(`RED CONTROL LOW-2: quadratic tag match took ${slow.elapsed.toFixed(0)}ms on a 40k-char id`);
  passed.push("LOW-2-linear-tag-under-50ms-and-mutation-red");

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "accel-sec-low-"));
  const savedPath = process.env.PATH, kill = process.kill;
  const spawned = [];
  const alive = (pid) => {
    try { kill.call(process, pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  try {
    const pidsFile = path.join(scratch, "pids");
    fs.writeFileSync(path.join(scratch, "sleeper"), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');
setInterval(()=>{},1000);\n`, { mode: 0o700 });
    process.env.PATH = scratch;
    const strands = async (subject) => {
      const spawnOffset = subject.fixtureSpawns.length;
      fs.writeFileSync(pidsFile, "");
      const pending = [];
      for (let index = 0; index < 3; index++) {
        pending.push(subject.fixtureCommand("sleeper", [], scratch, performance.now() + 60000));
      }
      let groups = [];
      for (let attempt = 0; attempt < 100 && groups.length < 3; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        groups = fs.readFileSync(pidsFile, "utf8").split("\n").filter(Boolean).map(Number);
      }
      spawned.push(...groups);
      const observed = subject.fixtureSpawns.slice(spawnOffset);
      assert.equal(groups.length, 3, "three sleeper groups started: " + JSON.stringify({
        groups_started: groups.length, pids_registered: groups, spawns: observed,
      }));
      // Detached children lead their own group (pgid === pid). EPERM the FIRST group the
      // registry signals, so the later two are only killed if the loop survives it.
      let first;
      process.kill = function (pid, signal) {
        if (first === undefined && pid < 0 && signal === "SIGKILL") {
          first = -pid;
          throw Object.assign(new Error("kill EPERM"), { code: "EPERM", errno: -1, syscall: "kill" });
        }
        return kill.apply(this, arguments);
      };
      try { assert.doesNotThrow(() => subject.killOutstanding(), "LOW-1 killOutstanding must not throw"); }
      finally { process.kill = kill; }
      assert.ok(groups.includes(first), "LOW-1 the EPERM stub reached a recorded probe group");
      const others = groups.filter((pid) => pid !== first);
      for (let attempt = 0; attempt < 15 && others.some(alive); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepEqual(others.filter(alive), [], "LOW-1 every other group dies");
      kill.call(process, -first, "SIGKILL");
      await Promise.all(pending);
    };
    await strands(real);
    const absent = mutate('child = spawn(binary, args, { cwd: os.tmpdir(), env, detached: true,',
      'child = spawn("ep4-known-absent-sleeper", args, { cwd: os.tmpdir(), env, detached: true,');
    await assert.rejects(() => strands(absent), (error) => {
      assert.match(error.message, /three sleeper groups started:/);
      assert.match(error.message, /"error":"ENOENT"/);
      console.log("RED CONTROL D readiness cause: " + error.message);
      return true;
    });
    const rethrow = mutate("    catch { /* Cleanup is best-effort per group; one failure must not strand the rest. */ }\n",
      '    catch (error) { if (error.code !== "ESRCH") throw error; }\n');
    await assert.rejects(() => strands(rethrow), /LOW-1 killOutstanding must not throw/);
    console.log("RED CONTROL LOW-1: a rethrowing killOutstanding aborts on EPERM and strands later groups");
    passed.push("LOW-1-eperm-kill-reaches-every-other-group-and-mutation-red");
    return passed;
  } finally {
    process.kill = kill;
    process.env.PATH = savedPath;
    for (const pid of spawned) {
      try { kill.call(process, -pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
