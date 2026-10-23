import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import sandboxModules from "../_lib/sandbox-module-tree.cjs";
const { copyModuleTree, moduleClosureArgs, moduleClosureResult } = sandboxModules;

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function ship(name, bytes) {
  const gzip = gzipSync(bytes);
  console.log("@@UNION_ARTIFACT@@ " + JSON.stringify({ name, bytes: bytes.length, sha256: hash(bytes),
    gzip_bytes: gzip.length, gzip_sha256: hash(gzip), data: gzip.toString("base64") }));
}
export async function runR1HookCases(ctx) {
  const { check, scaffold, HOOKS, ORCH, WH, WH_TARGET, REG_ONE, IDLE_ROW, BUSY_ROW, csqLog, stateText, lib } = ctx;
  const broker = "fleet-dispatch-broker.js", reporter = "fleet-workhorse-report.js";
  const stop = { hook_event_name: "Stop" };
  const task = prompt => ({ hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { prompt } });
  const brief = "ROLE: routine-implementation\nImplement the bounded item.";
  const override = task("ROLE: routine-implementation\nDISPATCH-OVERRIDE: source context is here");
  const rootOf = fx => path.join(fx.stateDir, "fleet");
  const fixture = (self = ORCH, stateRows = [BUSY_ROW]) => scaffold({
    sessions: [self.pid === ORCH.pid ? { ...ORCH, self: true } : ORCH, self.pid === WH.pid ? { ...WH, self: true } : WH,
      ...([ORCH.pid, WH.pid].includes(self.pid) ? [] : [{ ...self, self: true }])],
    registry: REG_ONE, stateRows,
  });
  const sends = fx => (csqLog(fx).match(/sessions\tsend\t/g) || []).length;
  let sequence = 0;
  function invoke(fx, file, payload, { mutate, preload = "", mode = "main" } = {}) {
    const bundle = mode === "dispatch" ? fx.repoDir : path.join(fx.dir, "hook-pole-" + sequence);
    const dir = path.join(bundle, ".claude/hooks");
    sequence++;
    fs.mkdirSync(dir, { recursive: true });
    copyModuleTree(path.join(HOOKS, "lib"), path.join(dir, "lib"));
    const original = fs.readFileSync(path.join(HOOKS, file), "utf8");
    const source = mutate ? mutate(original) : original;
    if (mutate && source === original) throw Error("inert reversion " + file);
    const candidate = path.join(dir, file), digest = hash(source);
    fs.writeFileSync(candidate, source);
    const compiledCandidate = fs.realpathSync(candidate);
    const trace = path.join(dir, "trace.cjs");
    fs.writeFileSync(trace, 'const M=require("node:module"),c=require("node:crypto"),old=M.prototype._compile;M.prototype._compile=function(s,f){if(f===' + JSON.stringify(compiledCandidate) + ')process.stderr.write("REACHED actual-hook sha256="+c.createHash("sha256").update(s).digest("hex")+"\\n");return old.call(this,s,f);};\n' + preload);
    let dispatchPin;
    if (mode === "dispatch") {
      const canonical = JSON.parse(fs.readFileSync(path.join(HOOKS, "dispatch-registry.json"), "utf8"));
      const row = canonical.events.PreToolUse.groups.flatMap(g => g.hooks || []).find(h => (h.command || "").endsWith('/fleet-dispatch-broker.js"'));
      if (!row) throw Error("actual broker registration missing");
      const registry = JSON.stringify({ schema: canonical.schema, events: { PreToolUse: { dispatcher: { timeout: 20 }, groups: [{ matcher: "Task|Agent|Workflow", hooks: [row] }] } } });
      fs.writeFileSync(path.join(dir, "dispatch-registry.json"), registry);
      dispatchPin = hash(registry);
      fs.copyFileSync(path.join(HOOKS, "dispatch.js"), path.join(dir, "dispatch.js"));
      fs.mkdirSync(path.join(fx.repoDir, ".git"), { recursive: true });
    }
    const outFile = path.join(dir, "stdout"), errFile = path.join(dir, "stderr");
    const a = fs.openSync(outFile, "wx"), b = fs.openSync(errFile, "wx");
    const args = mode === "load" ? ["--require", trace, "-e", "let calls=0;global.setTimeout=()=>{calls++};require(" + JSON.stringify(candidate) + ");console.log('LOAD_TIMERS='+calls);"] :
      mode === "dispatch" ? ["--require", trace, path.join(dir, "dispatch.js"), "PreToolUse", "--registry-sha256=" + dispatchPin] : ["--require", trace, candidate];
    let result;
    try { result = spawnSync(process.execPath, moduleClosureArgs(bundle, args), { cwd: fx.repoDir, env: mode === "dispatch" ? { ...fx.env, NODE_OPTIONS: [fx.env.NODE_OPTIONS || "", "--require=" + JSON.stringify(trace)].filter(Boolean).join(" ") } : fx.env, input: JSON.stringify(payload), stdio: ["pipe", a, b], timeout: mode === "dispatch" ? 25000 : 9000 }); }
    finally { fs.closeSync(a); fs.closeSync(b); }
    moduleClosureResult(bundle, result);
    const out = fs.readFileSync(outFile), err = fs.readFileSync(errFile);
    const name = "r1-" + sequence + "-" + digest.slice(0, 12);
    ship(name + ".source", Buffer.from(source)); ship(name + ".stdout", out); ship(name + ".stderr", err);
    const reached = err.toString().includes("REACHED actual-hook sha256=" + digest);
    check("r1.reached." + name, reached && !result.error, result.error?.message);
    console.log("REACHED r1-hook-pole " + JSON.stringify({ file, mutated: Boolean(mutate), sha256: digest, status: result.status }));
    return { rc: result.status, out: out.toString(), err: err.toString(), reached };
  }
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-reach-tmpdir-"));
    process.once("exit", () => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, "target"), alias = path.join(root, "alias");
    fs.mkdirSync(target);
    fs.symlinkSync(target, alias, "dir");
    const previous = process.env.TMPDIR;
    let fx;
    try {
      process.env.TMPDIR = alias;
      fx = fixture();
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
    check("r1.reach.symlinked-tmpdir-active", fx.dir.startsWith(alias + path.sep) &&
      fs.realpathSync(fx.dir) !== fx.dir);
    const preload = 'const prior=module.constructor.prototype._compile;module.constructor.prototype._compile=function(s,f){if(f.endsWith("/fleet-dispatch-broker.js"))process.stderr.write("REACHED symlink-tmpdir compile sha256="+require("node:crypto").createHash("sha256").update(s).digest("hex")+"\\n");return prior.call(this,s,f);};';
    const result = invoke(fx, broker, {}, { mode: "load", preload });
    const digest = hash(fs.readFileSync(path.join(HOOKS, broker)));
    const compiled = result.err.includes("REACHED symlink-tmpdir compile sha256=" + digest);
    check("r1.reach.symlinked-tmpdir-hook-loaded", compiled && result.rc === 0 && result.out.trim() === "LOAD_TIMERS=0");
    check("r1.reach.symlinked-tmpdir-detected", compiled && result.reached,
      JSON.stringify({ rc: result.rc, stdout: result.out, stderr: result.err }));
  }
  const oldCaller = source => source.replace('  const unknownCaller = (diagnostic) => {', '  const unknownCaller = (diagnostic) => {\n    return { refuse: true, body: "REVERTED caller unknown refusal" };');
  for (const caller of [{ ...ORCH, pid: 30033 }, WH]) for (const mode of ["down", "no-self", "timeout"]) {
    const fx = fixture(caller);
    if (mode === "down") fx.env.FLEET_CSQ_FAIL = "1";
    if (mode === "no-self") fs.writeFileSync(fx.env.FLEET_CSQ_SESSIONS, JSON.stringify({ ok: true, sessions: [ORCH, WH] }));
    if (mode === "timeout") {
      const fake = path.join(fx.dir, "csq");
      fs.writeFileSync(fake, fs.readFileSync(fake, "utf8").replace("const args=process.argv.slice(2);", 'const args=process.argv.slice(2);if(args[1]==="list")Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2200);'));
    }
    const normal = invoke(fx, broker, task(brief));
    check("r1.F3.inert-caller-baseline-" + caller.pid + "-" + mode, normal.rc === 0 && normal.err.includes("csq caller identity unavailable"));
    const reverted = invoke(fx, broker, task(brief), { mutate: oldCaller });
    check("r1.F3.unknown-caller-" + caller.pid + "-" + mode, normal.rc === 0 && normal.err.includes("csq caller identity unavailable") && reverted.rc === 2);
  }
  {
    const fx = fixture(WH, [IDLE_ROW]);
    check("r1.F3.known-workhorse-inert", invoke(fx, broker, task(brief)).rc === 0);
  }
  {
    const fx = fixture();
    fs.writeFileSync(path.join(rootOf(fx), "state-unknown-busy-overlap-" + WH_TARGET.replace(":", "-")), "busy event overlapped report\n");
    const normal = invoke(fx, broker, task(brief));
    check("r1.F1.per-workhorse-unknown-excluded-baseline", normal.rc === 0);
    const reverted = invoke(fx, broker, task(brief), { mutate: s => s.replace("  const idle = lib.idleWorkhorses(roster);", '  if (roster.some(r => r.live && r.state === "unknown")) return incomplete(mine);\n  const idle = lib.idleWorkhorses(roster);') });
    check("r1.F1.per-workhorse-unknown-excluded", normal.rc === 0 && reverted.rc === 2);
    const other = { ...WH, pid: WH.pid + 1, name: "other-idle" };
    const target = other.pid + ":" + other.started_at;
    const pair = scaffold({ sessions: [{ ...ORCH, self: true }, WH, other],
      registry: { ...REG_ONE, workhorses: [...REG_ONE.workhorses, { ...REG_ONE.workhorses[0], target, name: "other-idle" }] },
      stateRows: [BUSY_ROW, { ...IDLE_ROW, target }] });
    fs.writeFileSync(path.join(rootOf(pair), "state-unknown-busy-overlap-" + WH_TARGET.replace(":", "-")), "busy event overlapped report\n");
    const protectedIdle = invoke(pair, broker, task(brief));
    check("r1.F1.unrelated-known-idle-still-refuses", protectedIdle.rc === 2 && protectedIdle.err.includes(target));
  }
  {
    const fx = fixture();
    const preload = 'const fs=require("node:fs"),read=fs.readFileSync;fs.readFileSync=function(p,...a){if(String(p).endsWith("/fleet/state.jsonl")){process.stderr.write("REACHED state-read EACCES\\n");const e=Error("state unreadable");e.code="EACCES";throw e;}return read.call(this,p,...a);};';
    const refused = invoke(fx, broker, task(brief), { preload });
    check("r1.F3.verified-orchestrator-incomplete", refused.rc === 2 && refused.err.includes("REACHED state-read EACCES") && refused.err.includes("DISPATCH-OVERRIDE") && refused.err.includes("csq sessions send"));
    const allowed = invoke(fx, broker, override, { preload });
    check("r1.F3.incomplete-override-baseline", allowed.rc === 0 && stateText(fx).includes('"dispatch-override"'));
    const reverted = invoke(fx, broker, override, { preload, mutate: s => s.replace("if (ov.present && (tool !== WORKFLOW_TOOL || workflowInline)) {", "if (ov.present && (tool !== WORKFLOW_TOOL || workflowInline) && lib.readStateRows(root)) {") });
    check("r1.F3.override-before-incomplete", allowed.rc === 0 && stateText(fx).includes('"dispatch-override"') && reverted.rc === 2 && reverted.err.includes("REACHED state-read EACCES"));
  }
  {
    const fx = fixture(ORCH, [IDLE_ROW]);
    const firstLine = task("DISPATCH-OVERRIDE: misplaced first line\nImplement this.");
    const r = invoke(fx, broker, firstLine);
    check("r1.F7.non-workflow-role-first", r.rc === 2 && !stateText(fx).includes('"dispatch-override"'));
  }
  {
    const fx = fixture();
    const payload = { hook_event_name: "PreToolUse", tool_name: "Workflow", tool_input: {
      script: '// DISPATCH-OVERRIDE: context requires this session\nawait agent("ROLE: " + "routine-implementation", {effort:"medium"});',
    } };
    const baseline = invoke(fx, broker, payload);
    check("r1.F3.incomplete-workflow-override-baseline", baseline.rc === 0 && stateText(fx).includes('"dispatch-override"'));
    const reverted = invoke(fx, broker, payload, { mutate: s => s.replace("if (ov.present && (tool !== WORKFLOW_TOOL || workflowInline)) {", "if (ov.present && (tool !== WORKFLOW_TOOL || workflowInline) && !workflowUnknown) {") });
    check("r1.F3.incomplete-workflow-override", baseline.rc === 0 && reverted.rc === 2);
  }
  {
    // The BROKER is a deny row: it has no Rule-7 fail-open fallback any more. Its 4500ms is the
    // standalone run budget guard-runner.js::runGuard arms, and that budget firing is a budget
    // REFUSAL (exit 2, naming the guard, the two verbatim budget sentences), never continue:true.
    // The preload fires the 4500ms timer at once (REACH), so the stdin read is still pending.
    const fx = fixture();
    const loaded = invoke(fx, broker, {}, { mode: "load" });
    check("r1.F2.no-load-time-timer." + broker, loaded.rc === 0 && loaded.out.trim() === "LOAD_TIMERS=0");
    const preload = 'const t=global.setTimeout;global.setTimeout=function(fn,ms,...a){if(ms===4500){process.stderr.write("REACHED run budget\\n");queueMicrotask(()=>fn(...a));return {};}return t(fn,ms,...a);};';
    const r = invoke(fx, broker, {}, { preload });
    check("r1.F2.budget-refusal." + broker, r.rc === 2 && r.err.includes("REACHED run budget") && !r.out.includes('"continue":true') &&
      r.err.includes("[guard-runner] DENY fleet-dispatch-broker") && r.err.includes("a guard time-out under load is a budget refusal, not a deny") &&
      r.err.includes("Retry once; if it recurs, report fleet-dispatch-broker's budget and wait for the user"), `rc=${r.rc} err=${r.err.slice(0, 600)}`);
    // Mutation pole: the budget is the runner's, armed at exactly this value — move it and the
    // preload no longer reaches it, so the same {} payload runs to its normal inert verdict.
    const m = invoke(fx, broker, {}, { preload, mutate: s => s.replace('runGuard("fleet-dispatch-broker", main, { budgetMs: 4500 })', 'runGuard("fleet-dispatch-broker", main, { budgetMs: 4501 })') });
    check("r1.F2.budget-is-the-runners." + broker, r.rc === 2 && m.rc === 0 && !m.err.includes("REACHED run budget") && m.out.includes('"continue":true'), `rc=${r.rc} mutant=${m.rc}`);
  }
  for (const file of [reporter, "fleet-roster-inject.js"]) {
    const fx = fixture();
    const loaded = invoke(fx, file, {}, { mode: "load" });
    check("r1.F2.no-load-time-timer." + file, loaded.rc === 0 && loaded.out.trim() === "LOAD_TIMERS=0");
    const preload = 'const t=global.setTimeout;global.setTimeout=function(fn,ms,...a){if(ms===4500){process.stderr.write("REACHED Rule7 fallback\\n");queueMicrotask(()=>fn(...a));return {};}return t(fn,ms,...a);};';
    const r = invoke(fx, file, {}, { preload });
    check("r1.F2.timer-baseline." + file, r.rc === 1 && JSON.parse(r.out || "{}").continue === true && r.err.includes("REACHED Rule7 fallback"));
    const m = invoke(fx, file, {}, { preload, mutate: s => s.replace("  const timer = setTimeout(() => {", "  const timer = false && setTimeout(() => {") });
    check("r1.F2.timeout-fallback." + file, r.rc === 1 && JSON.parse(r.out || "{}").continue === true && r.err.includes("REACHED Rule7 fallback") && m.rc === 0 && !m.err.includes("REACHED Rule7 fallback"));
  }
  {
    const fx = fixture(WH);
    const first = invoke(fx, reporter, stop);
    const calls = csqLog(fx).split("\n").filter(l => l.startsWith("sessions\tlist\t"));
    check("r1.F2.report-reuses-one-live-list", first.rc === 0 && sends(fx) === 1 && calls.length === 1);
    const mutant = fixture(WH);
    const reverted = invoke(mutant, reporter, stop, { mutate: s => s.replace("{ sessions: live.sessions, deadlineMs }", "{ deadlineMs }") });
    const repeated = csqLog(mutant).split("\n").filter(l => l.startsWith("sessions\tlist\t"));
    check("r1.F2.repeated-live-list-reversion", first.rc === 0 && calls.length === 1 && reverted.rc === 0 && sends(mutant) === 1 && repeated.length === 2);
  }
  for (const pole of ["empty-history", "self-invalidated", "other-invalidated"]) {
    const fx = fixture(WH, pole === "empty-history" ? [] : [BUSY_ROW]);
    const root = rootOf(fx);
    if (pole === "empty-history") fs.writeFileSync(path.join(root, "state.jsonl"), "");
    if (pole !== "empty-history") {
      const target = pole === "self-invalidated" ? WH_TARGET : (WH.pid + 1) + ":" + WH.started_at;
      fs.writeFileSync(path.join(root, "state-unknown-busy-overlap-" + target.replace(":", "-")), "busy event overlapped report\n");
    }
    const rows = lib.readStateRows(root, WH_TARGET);
    check("r1.F1.actual-targeted-read-" + pole, pole === "self-invalidated" ? rows === null : Array.isArray(rows));
    const reported = invoke(fx, reporter, stop);
    check("r1.F1.reporter-targeted-unknown-" + pole, reported.rc === 0 &&
      sends(fx) === (pole === "self-invalidated" ? 0 : 1) &&
      (pole === "self-invalidated" || stateText(fx).includes('"event":"idle"')));
  }
  {
    const preload = 'const cp=require("node:child_process"),run=cp.spawnSync;cp.spawnSync=function(p,a,o){if(a?.[0]==="sessions")process.stderr.write("REACHED csq-budget "+JSON.stringify({timeout:o.timeout,kill:o.killSignal,verb:a[1]})+"\\n");return run.call(this,p,a,o);};';
    const good = r => {
      const calls = r.err.split("\n").filter(l => l.startsWith("REACHED csq-budget ")).map(l => JSON.parse(l.slice(19)));
      return r.rc === 0 && calls.length === 2 && calls.every(c => c.kill === "SIGKILL") && calls.reduce((n,c) => n+c.timeout,0) <= 2800;
    };
    const baseline = invoke(fixture(WH), reporter, stop, { preload });
    check("r1.F2.actual-child-timeouts-under-stop-margin", good(baseline));
    const reverted = invoke(fixture(WH), reporter, stop, { preload, mutate: s => s.replace("lib.liveSessions({ deadlineMs })", "lib.liveSessions({ timeoutMs: 4000, deadlineMs: Date.now() + 10000 })")
      .replace("{ sessions: live.sessions, deadlineMs }", "{ sessions: live.sessions, timeoutMs: 6000, deadlineMs: Date.now() + 10000 }") });
    check("r1.F2.over-budget-reversion-red", !good(reverted));
  }

  const advisory = r => r.rc === 0 && JSON.parse(r.out || "{}").continue === true &&
    typeof JSON.parse(r.out || "{}").systemMessage === "string" && JSON.parse(r.out || "{}").systemMessage.length > 0;
  for (const file of [broker, reporter, "fleet-roster-inject.js"]) {
    const payload = file === broker ? task(brief) : { hook_event_name: file === reporter ? "Stop" : "UserPromptSubmit" };
    for (const failure of ["registry", "csq", "self", "untrusted"]) {
      const fx = fixture(file === reporter ? WH : ORCH);
      if (failure === "registry") fs.writeFileSync(path.join(rootOf(fx), "registry.json"), "{");
      if (failure === "csq") fx.env.FLEET_CSQ_FAIL = "1";
      if (failure === "self") fs.writeFileSync(fx.env.FLEET_CSQ_SESSIONS, JSON.stringify({ ok: true, sessions: [ORCH, WH] }));
      if (failure === "untrusted") { fs.chmodSync(fx.dir, 0o775); fx.env.PATH = fx.dir; }
      const result = invoke(fx, file, payload);
      const message = JSON.parse(result.out || "{}").systemMessage || "";
      check("r2.S5.model-visible-" + failure + "." + file, advisory(result) && result.err.includes(message));
      if (failure === "registry") check("r2.S5.registry-own-remedy." + file,
        message.includes("fleet registry unreadable") && message.includes("fleet-roster.mjs") && !message.includes("csq caller identity unavailable"));
      if (failure === "untrusted") check("r2.C1.typed-group-writable." + file,
        message.includes("untrusted csq executable:") && message.includes("is group-writable") && !csqLog(fx));
    }
  }
  {
    const text = '// DISPATCH-OVERRIDE: file content is not author consent\nawait agent("ROLE: routine-implementation — bounded item", {effort:"medium"});';
    for (const [sourceKind, rows, expected] of [["inline", [IDLE_ROW], 0], ["file-idle", [IDLE_ROW], 2], ["file-busy", [BUSY_ROW], 0]]) {
      const fx = fixture(ORCH, rows);
      const scriptPath = path.join(fx.repoDir, "workflow.mjs");
      fs.writeFileSync(scriptPath, text);
      const input = sourceKind === "inline" ? { script: text } : { scriptPath };
      const result = invoke(fx, broker, { hook_event_name: "PreToolUse", tool_name: "Workflow", tool_input: input });
      check("r2.S3.workflow-override-" + sourceKind, result.rc === expected &&
        stateText(fx).includes('"dispatch-override"') === (sourceKind === "inline"));
    }
  }
  for (const withLive of [true, false]) {
    const deadTarget = (WH.pid + 200) + ":" + WH.started_at;
    const dead = { ...REG_ONE.workhorses[0], target: deadTarget, name: "offline-first" };
    const registry = { ...REG_ONE, workhorses: withLive ? [dead, ...REG_ONE.workhorses] : [dead] };
    const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry, stateRows: [BUSY_ROW] });
    const result = invoke(fx, broker, { hook_event_name: "PreToolUse", tool_name: "Task", tool_input: null });
    check("r2.C3.incomplete-remedy-" + (withLive ? "live-target" : "no-live-placeholder"),
      result.rc === 2 && result.err.includes(withLive ? WH_TARGET : "<live-registered-workhorse-target>") &&
      !result.err.includes(deadTarget) && result.err.includes("DISPATCH-OVERRIDE"));
  }

  for (const down of [false, true]) {
    const fx = fixture(ORCH, [IDLE_ROW]);
    if (down) fx.env.FLEET_CSQ_FAIL = "1";
    const result = invoke(fx, broker, { ...task(brief), cwd: fx.repoDir }, { mode: "dispatch" });
    const output = JSON.parse(result.out || "{}");
    check("r2.S5.actual-dispatch-" + (down ? "inert-advisory" : "idle-deny-control"),
      down ? advisory(result) && output.systemMessage.includes("csq") :
        result.rc === 2 && output.hookSpecificOutput?.permissionDecision === "deny" && result.err.includes(WH_TARGET));
  }

}
