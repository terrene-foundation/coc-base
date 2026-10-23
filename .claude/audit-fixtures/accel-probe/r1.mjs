import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

// ps by ABSOLUTE path: the fixture sets PATH to a stand-in directory, so a bare `ps`
// would not resolve (or would resolve to a stand-in).
const PS = ["/bin/ps", "/usr/bin/ps"].find((file) => fs.existsSync(file));

// One process's pgid and full command line, or null when ps reports no such process
// (exit 1, empty output). Any other ps failure throws: an unreadable process table
// must not read as "gone".
function psInspect(pid) {
  if (!PS) throw new Error("R1-L5 reaper needs /bin/ps or /usr/bin/ps");
  let out;
  try {
    out = execFileSync(PS, ["-ww", "-o", "pgid=", "-o", "command=", "-p", String(pid)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (error.status === 1 && !String(error.stdout || "").trim()) return null;
    throw error;
  }
  const match = /^\s*(\d+)\s+([\s\S]*?)\s*$/.exec(out);
  if (!match) throw new Error(`R1-L5 unparseable ps line for pid ${pid}: ${JSON.stringify(out)}`);
  return { pgid: Number(match[1]), command: match[2] };
}

// SIGKILLs the process group `rec.parent` ONLY when it is provably still the fixture's
// own: `rec` is read back from a pid FILE a stand-in wrote, so both ids are INPUT. The
// group is signalled only if the parent id is a safe integer above 1 that is neither
// this process nor this process's own group, the recorded grandchild is alive IN that
// group and carries the fixture's unique argv marker, and the group still exists.
// Every check except the existence probe runs BEFORE `kill` is first called, so a
// refusal on any of them never reaches `kill` at all. Returns "killed" or "refused:<why>".
function reapVerifiedGroup(rec, marker, { kill = process.kill.bind(process), inspect = psInspect } = {}) {
  const parent = rec?.parent;
  const member = rec?.grandchild;
  if (!Number.isSafeInteger(parent) || parent <= 1 || parent === process.pid) return "refused:parent-id";
  if (typeof marker !== "string" || marker === "") return "refused:no-marker";
  const self = inspect(process.pid);
  if (!self) return "refused:own-group-unknown";
  if (self.pgid === parent) return "refused:own-group";
  if (!Number.isSafeInteger(member) || member <= 1 || member === process.pid) return "refused:member-id";
  const seen = inspect(member);
  if (!seen) return "refused:member-gone";
  if (seen.pgid !== parent) return "refused:member-pgid";
  if (!seen.command.includes(marker)) return "refused:member-marker";
  try { kill(-parent, 0); }
  catch (error) { if (error.code === "ESRCH") return "refused:group-gone"; throw error; }
  try { kill(-parent, "SIGKILL"); }
  catch (error) { if (error.code === "ESRCH") return "refused:group-gone"; throw error; }
  return "killed";
}

export async function r1Fixtures(library) {
  const source = fs.readFileSync(library, "utf8");
  const probe = createRequire(import.meta.url)(library);
  const saved = { ...process.env };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "accel-r1-"));
  const bin = path.join(scratch, "bin");
  const repo = path.join(scratch, "repo");
  const temp = path.join(scratch, "temp");
  for (const dir of [bin, repo, temp]) fs.mkdirSync(dir);
  const python = (saved.PATH || "").split(path.delimiter).filter(path.isAbsolute)
    .map((dir) => path.join(dir, "python3")).find((file) => fs.existsSync(file));
  assert.ok(python, "R1-HIGH-1 needs a real Python interpreter");
  const mutate = (replacements) => {
    let text = source;
    for (const [from, to] of replacements) {
      assert.equal(text.split(from).length, 2, "mutation target reached exactly once");
      text = text.replace(from, to);
    }
    const instance = new Module(library);
    instance.filename = library;
    instance.paths = Module._nodeModulePaths(path.dirname(library));
    instance._compile(text, library);
    return instance.exports;
  };
  const binary = (name, body, dir = bin) => fs.writeFileSync(path.join(dir, name),
    `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  // pids here are read back from a file the probe wrote, so they are INPUT: only a safe
  // integer above 1 that is not this process ever reaches process.kill (sig 0 only here;
  // the group SIGKILL goes through reapVerifiedGroup).
  const usable = (pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid;
  const alive = (pid) => {
    if (!usable(pid)) return false;
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
    const stat = `/proc/${pid}/stat`;
    if (fs.existsSync(stat) && fs.readFileSync(stat, "utf8").split(") ")[1].startsWith("Z")) return false;
    return true;
  };
  // Unique per run (mkdtemp basename): appended to the fixture grandchild's argv so the
  // reaper can prove a recorded group is still this fixture's own before signalling it.
  const memberMarker = `accel-r1-member-${path.basename(scratch)}`;
  const groups = [];
  const passed = [];
  try {
    // R1-L5-RED-CASE-START. Runs FIRST, before any real group is recorded, and only
    // ever through a RECORDER kill and an injected process table: no real signal.
    {
      const P = process.pid + 101, G = process.pid + 102, OWN = process.pid + 103;
      const calls = [];
      const recorder = (pid, sig) => { calls.push([pid, sig]); };
      const table = (entries) => (pid) => entries[pid] ?? null;
      const self = { [process.pid]: { pgid: OWN, command: "node fixture" } };
      const good = `${process.execPath} -e setInterval(()=>{},1000) ${memberMarker}`;
      const refuses = (label, rec, entries, reason) => {
        calls.length = 0;
        const verdict = reapVerifiedGroup(rec, memberMarker, { kill: recorder, inspect: table({ ...self, ...entries }) });
        assert.deepEqual(calls, [], `R1-L5 unverified group must not be signalled (${label})`);
        assert.equal(verdict, reason, `R1-L5 refusal reason (${label})`);
      };
      refuses("wrong-pgid", { parent: P, grandchild: G }, { [G]: { pgid: P + 5, command: good } }, "refused:member-pgid");
      refuses("missing-marker", { parent: P, grandchild: G }, { [G]: { pgid: P, command: `${process.execPath} -e setInterval(()=>{},1000)` } }, "refused:member-marker");
      refuses("dead-member", { parent: P, grandchild: G }, {}, "refused:member-gone");
      for (const bad of [0, 1, -1, process.pid]) {
        refuses(`parent-${bad}`, { parent: bad, grandchild: G }, { [G]: { pgid: bad, command: good } }, "refused:parent-id");
      }
      refuses("own-pgid", { parent: OWN, grandchild: G }, { [G]: { pgid: OWN, command: good } }, "refused:own-group");
      // Group gone at the existence probe: the probe is routed through the same `kill`,
      // so exactly that one [-P, 0] call is recorded and no SIGKILL follows.
      calls.length = 0;
      const gone = (pid, sig) => { calls.push([pid, sig]); throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); };
      assert.equal(reapVerifiedGroup({ parent: P, grandchild: G }, memberMarker,
        { kill: gone, inspect: table({ ...self, [G]: { pgid: P, command: good } }) }), "refused:group-gone");
      assert.deepEqual(calls, [[-P, 0]], "R1-L5 vanished group gets the probe only, never SIGKILL");
      // Control: a fully matching record is signalled exactly once with SIGKILL, after
      // the existence probe (which goes through the same `kill`).
      calls.length = 0;
      assert.equal(reapVerifiedGroup({ parent: P, grandchild: G }, memberMarker,
        { kill: recorder, inspect: table({ ...self, [G]: { pgid: P, command: good } }) }), "killed");
      assert.deepEqual(calls, [[-P, 0], [-P, "SIGKILL"]], "R1-L5 control: verified group is probed then killed");
      passed.push("R1-L5-cleanup-signals-only-verified-own-group");
    }
    process.env.PATH = bin;
    process.env.TMPDIR = temp;
    process.env.R1_API_KEY = "fixture-private-value";
    process.env.PYTHONPATH = repo;
    const marker = path.join(scratch, "marker");
    fs.mkdirSync(path.join(repo, "kailash"));
    fs.writeFileSync(path.join(repo, "kailash/__init__.py"), "");
    fs.writeFileSync(path.join(repo, "kailash/distill.py"),
      `open(${JSON.stringify(marker)}, "w").write("executed")\nGovernedDistiller = object\n`);
    const envFile = path.join(scratch, "child-env-keys.json");
    const pythonResultFile = path.join(scratch, "child-python-result.json");
    const loaderEnv = Object.fromEntries(Object.entries(saved)
      .filter(([key]) => key === "LD_LIBRARY_PATH" || key.startsWith("DYLD_")));
    // macOS injects __CF_USER_TEXT_ENCODING into every process it starts, so
    // this stand-in reports it whatever env the probe passed. It records what
    // the PROBE handed over, so that one OS-injected key is dropped; the
    // ambient-env mutant below still reds on every other key it leaks.
    const installPython = (executable = python) => binary("python3", `const cp=require('node:child_process');
      require('node:fs').writeFileSync(${JSON.stringify(envFile)},JSON.stringify(Object.keys(process.env).filter((k)=>k!=='__CF_USER_TEXT_ENCODING').sort()));
      const r=cp.spawnSync(${JSON.stringify(executable)}, ['-S', ...process.argv.slice(2)], {env:{...process.env,...${JSON.stringify(loaderEnv)}},cwd:process.cwd(),encoding:'utf8'});
      require('node:fs').writeFileSync(${JSON.stringify(pythonResultFile)},JSON.stringify({status:r.status,signal:r.signal,stderr:r.stderr||'',error:r.error?{code:r.error.code,message:r.error.message}:null}));
      process.exit(r.status===null?2:r.status);`);
    installPython();
    const rejectsLocal = async (subject) => {
      fs.rmSync(pythonResultFile, { force: true });
      const value = await subject.probeEngine(repo, "sqlite:///fixture.db");
      assert.deepEqual(JSON.parse(fs.readFileSync(envFile, "utf8")),
        ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"].filter((key) => saved[key] !== undefined || key === "TMPDIR").sort(),
        "R1-HIGH-1 child environment must contain only allowlisted keys");
      assert.equal(fs.existsSync(marker), false, "R1-HIGH-1 planted module marker must be absent");
      const interpreter = JSON.parse(fs.readFileSync(pythonResultFile, "utf8"));
      assert.equal(interpreter.error, null, "R1-HIGH-1 real Python interpreter must start");
      assert.equal(interpreter.signal, null, "R1-HIGH-1 real Python interpreter must finish without a signal");
      assert.equal(interpreter.status, 1, "R1-HIGH-1 real Python interpreter must fail the isolated import");
      assert.match(interpreter.stderr, /No module named 'kailash'/, "R1-HIGH-1 real Python must report the missing module");
      assert.equal(value.reason, "engine-not-installed", "R1-HIGH-1 local module must not report installed");
    };
    await rejectsLocal(probe);
    installPython(path.join(scratch, "interpreter-does-not-exist"));
    await assert.rejects(() => rejectsLocal(probe), /R1-HIGH-1 real Python interpreter must start/);
    assert.equal(JSON.parse(fs.readFileSync(pythonResultFile, "utf8")).error.code, "ENOENT",
      "R1-HIGH-1 failed-start control reached the real interpreter spawn");
    console.log("RED CONTROL R1-HIGH-1: real Python interpreter must start (reached ENOENT)");
    passed.push("R1-HIGH-1-interpreter-start-required-and-failed-start-red");
    installPython();
    const ambientEnv = mutate([
      ['cwd: os.tmpdir(), env, detached: true', 'cwd: os.tmpdir(), env: process.env, detached: true'],
    ]);
    await assert.rejects(() => rejectsLocal(ambientEnv), /R1-HIGH-1 child environment must contain only allowlisted keys/);
    const unsafe = mutate([
      ['["-I", "-c", "import kailash.distill as d; d.GovernedDistiller"]', '["-c", "import kailash.distill as d; d.GovernedDistiller"]'],
      ['cwd: os.tmpdir(), env, detached: true', 'cwd, env, detached: true'],
    ]);
    await assert.rejects(() => rejectsLocal(unsafe), /R1-HIGH-1 planted module marker must be absent/);
    assert.equal(fs.readFileSync(marker, "utf8"), "executed", "double mutation reached planted import");
    console.log("RED CONTROL R1-HIGH-1: planted module marker must be absent (actual true, expected false)");
    passed.push("R1-HIGH-1-isolated-import-minimal-env-and-mutation-red");
    process.env.PATH = ["", ".", "relative-bin", bin].join(path.delimiter);
    binary("csq", "console.log('{}');", temp);
    assert.equal((await probe.probeBroker(temp)).outcome, "unavailable", "R1-LOW-2 cwd csq must be unavailable");
    const unsafePath = mutate([
      ['.filter((entry) => entry && entry !== "." && path.isAbsolute(entry))', '.filter(() => true)'],
    ]);
    assert.equal((await unsafePath.probeBroker(temp)).outcome, "available", "PATH mutation reached cwd executable");
    passed.push("R1-LOW-2-relative-PATH-rejected-and-mutation-red");
    process.env.PATH = bin;
    const pidFile = path.join(scratch, "pids.json");
    binary("csq", `const cp=require('node:child_process');const fs=require('node:fs');
      const child=cp.spawn(${JSON.stringify(process.execPath)},['-e','setInterval(()=>{},1000)',${JSON.stringify(memberMarker)}],{stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,grandchild:child.pid}));
      setInterval(()=>{},1000);`);
    const timeout = async (subject) => {
      const verdict = await subject.probeBroker(repo);
      assert.equal(verdict.reason, "timeout");
      const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
      groups.push(pids);
      for (let attempt = 0; attempt < 30 && alive(pids.grandchild); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(alive(pids.grandchild), false, "R1-LOW-1 sleeping grandchild must be dead");
    };
    await timeout(probe);
    const singleton = mutate([['process.kill(-child.pid, "SIGKILL")', 'process.kill(child.pid, "SIGKILL")']]);
    await assert.rejects(() => timeout(singleton), /R1-LOW-1 sleeping grandchild must be dead/);
    passed.push("R1-LOW-1-timeout-kills-grandchild-and-mutation-red");
    // The singleton mutant left its grandchild alive in the recorded group: the reaper
    // must accept that REAL record through the real ps, and refuse it under a foreign
    // marker, so the ps reader is shown to fire here in both directions.
    const leaked = groups[groups.length - 1];
    assert.equal(alive(leaked.grandchild), true, "R1-L5 singleton mutant left its grandchild alive");
    assert.equal(reapVerifiedGroup(leaked, `${memberMarker}-foreign`), "refused:member-marker",
      "R1-L5 real record under a foreign marker is refused");
    assert.equal(alive(leaked.grandchild), true, "R1-L5 refused reap signalled nothing");
    assert.equal(reapVerifiedGroup(leaked, memberMarker), "killed", "R1-L5 real fixture group is verified and reaped");
    for (let attempt = 0; attempt < 30 && alive(leaked.grandchild); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(alive(leaked.grandchild), false, "R1-L5 verified reap killed the grandchild");
    passed.push("R1-L5-real-group-reaped-only-under-its-own-marker");
    return passed;
  } finally {
    // Backstop for a throw above: every recorded group goes through the verifying
    // reaper. A refusal on a group that still exists is reported, never swallowed.
    for (const rec of groups) {
      const verdict = reapVerifiedGroup(rec, memberMarker);
      if (verdict === "killed" || !usable(rec?.parent)) continue;
      let present = true;
      try { process.kill(-rec.parent, 0); }
      catch (error) { if (error.code === "ESRCH") present = false; else throw error; }
      if (present) console.error(`R1-L5 cleanup ${verdict} for group ${rec.parent}; group still present`);
    }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
