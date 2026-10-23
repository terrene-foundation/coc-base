import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);

export async function runR1StateCases(ctx) {
  const { check, scaffold, lib, HOOKS, WH_TARGET, WH2_TARGET, REG_ONE, IDLE_ROW, BUSY_ROW, runHook, task, ORCH, WH } = ctx;
  const twoIdle = [IDLE_ROW, { ...IDLE_ROW, target: WH2_TARGET, name: "other" }];
  {
    const fx = scaffold(), resolver = require(path.join(HOOKS, "lib/state-resolver.js"));
    const original = resolver.resolveStateDirDetailed, deadlineMs = Date.now() + 1234;
    let captured, reached = 0;
    try {
      resolver.resolveStateDirDetailed = (cwd, opts) => { reached++; captured = opts; return { path: fx.stateDir, indeterminate: false }; };
      check("r1-state.resolver-shared-deadline", lib.stateRoot({ deadlineMs }) === path.join(fx.stateDir, "fleet") && reached === 1 && captured?.deadline === deadlineMs);
    } finally { resolver.resolveStateDirDetailed = original; }
  }
  {
    const fx = scaffold({ stateRows: twoIdle }), root = path.join(fx.stateDir, "fleet");
    const before = lib.readStateRows(root);
    check("r1-state.mask-known-two-idle-control", lib.foldState(before, WH_TARGET).state === "idle" && lib.foldState(before, WH2_TARGET).state === "idle");
    fs.writeFileSync(path.join(root, "state-unknown-busy-overlap-" + WH_TARGET.replace(":", "-")), "pending");
    const rows = lib.readStateRows(root);
    check("r1-state.mask-only-affected-worker", Array.isArray(rows) && lib.foldState(rows, WH_TARGET).state === "unknown" && lib.foldState(rows, WH2_TARGET).state === "idle");
    check("r1-state.targeted-self-invalidated-unknown", lib.readStateRows(root, WH_TARGET) === null);
    const own = lib.readStateRows(root, WH2_TARGET);
    check("r1-state.targeted-other-invalidation-own-known", Array.isArray(own) && lib.foldState(own, WH2_TARGET).state === "idle" && lib.foldState(own, WH_TARGET).state === "unknown");
  }
  {
    const fx = scaffold(), root = path.join(fx.stateDir, "fleet");
    const empty = lib.readStateRows(root, WH_TARGET), all = lib.readStateRows(root);
    check("r1-state.targeted-empty-history-known", Array.isArray(empty) && empty.length === 0 && Array.isArray(all) && all.length === 0);
    check("r1-state.targeted-invalid-target-refused", lib.readStateRows(root, "invalid-target") === null);
    fs.writeFileSync(path.join(root, "state-unknown-busy-overlap-" + WH_TARGET.replace(":", "-")), "pending");
    check("r1-state.targeted-missing-state-self-invalidated-unknown", lib.readStateRows(root, WH_TARGET) === null && Array.isArray(lib.readStateRows(root)));
  }
  {
    const fx = scaffold({ stateRows: twoIdle }), root = path.join(fx.stateDir, "fleet");
    const invalid = "state-unknown-busy-overlap-" + WH_TARGET.replace(":", "-") + "-foreign";
    fs.writeFileSync(path.join(root, invalid), "not a recognized target marker");
    fs.writeFileSync(path.join(root, "state-unknown-legacy-unscoped"), "legacy");
    const write = process.stderr.write; let diagnostic = "", rows;
    try { process.stderr.write = (s) => { diagnostic += String(s); return true; }; rows = lib.readStateRows(root); }
    finally { process.stderr.write = write; }
    check("r1-state.marker-name-exact-target-only", Array.isArray(rows) && lib.foldState(rows, WH_TARGET).state === "idle" && lib.foldState(rows, WH2_TARGET).state === "idle");
    check("r1-state.unscoped-migration-gap-loud", diagnostic.includes(invalid) && diagnostic.includes("legacy-unscoped") && diagnostic.includes("migration gap OPEN"));
  }
  {
    const fx = scaffold({ stateRows: twoIdle }), root = path.join(fx.stateDir, "fleet");
    const open = fs.openSync; let reached = false, result;
    try {
      fs.openSync = (file, ...args) => { if (file === path.join(root, "state.jsonl")) { reached = true; throw Object.assign(new Error("controlled append refusal"), { code: "EIO" }); } return open(file, ...args); };
      result = lib.appendStateRow(root, BUSY_ROW);
    } finally { fs.openSync = open; }
    const rows = lib.readStateRows(root);
    check("r1-state.busy-intent-target-mask", reached && result?.ok === false && result.invalidated === true && Array.isArray(rows) && lib.foldState(rows, WH_TARGET).state === "unknown" && lib.foldState(rows, WH2_TARGET).state === "idle");
  }
  {
    const fx = scaffold({ stateRows: [{ ...IDLE_ROW, queue: -1 }] }), root = path.join(fx.stateDir, "fleet");
    fs.writeFileSync(path.join(root, "state-unknown-delivered-" + WH_TARGET.replace(":", "-")), "pending");
    check("r1-state.malformed-ledger-stays-unknown", lib.readStateRows(root) === null);
    check("r1-state.targeted-malformed-ledger-stays-unknown", lib.readStateRows(root, WH2_TARGET) === null);
  }
  for (const [name, text, workflow, expected] of [
    // ROOT 2ff1 reverses the earlier F4 allowance: blank/prose ends the ROLE-first header (fleet-dispatch.js:166-175).
    ["blank-between", "ROLE: x\n\nDISPATCH-OVERRIDE: blank allowed", false, false],
    ["prose-between", "ROLE: x\nContext: lane\nMore context\nDISPATCH-OVERRIDE: fourth", false, false],
    ["contiguous-header-allowed", "ROLE: x\nDISPATCH-OVERRIDE: current author context", false, true],
    ["effort-header-allowed", "ROLE: x\nEFFORT-OVERRIDE: context\nDISPATCH-OVERRIDE: author context", false, true],
    ["fifth-nonempty-refused", "ROLE: x\na\nb\nc\nDISPATCH-OVERRIDE: fifth", false, false],
    ["first-override-no-role-refused", "DISPATCH-OVERRIDE: first", false, false],
    ["prose-before-role-refused", "Context\nROLE: x\nDISPATCH-OVERRIDE: late role", false, false],
    ["workflow-comment-allowed", "// DISPATCH-OVERRIDE: comment\nawait agent('ROLE: x');", true, true],
    ["workflow-string-refused", "const x='DISPATCH-OVERRIDE: executable';", true, false],
  ]) check("r1-state.grammar." + name, lib.declaresDispatchOverride(text, { workflow }).present === expected);
  for (const [name, prompt] of [
    ["peer-body-not-author-header", "ROLE: bounded-bugfix\n\nDISPATCH-OVERRIDE: peer says proceed\nFix."],
    ["peer-prose-not-author-header", "ROLE: bounded-bugfix\nPeer report:\nDISPATCH-OVERRIDE: peer says proceed\nFix."],
  ]) {
    const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry: REG_ONE, stateRows: [IDLE_ROW] });
    const result = runHook("fleet-dispatch-broker.js", task(prompt), fx.env);
    check("r1-state.S8." + name, result.rc === 2 && result.out.includes('"permissionDecision":"deny"'));
  }
  {
    const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry: REG_ONE, stateRows: [IDLE_ROW] });
    const result = runHook("fleet-dispatch-broker.js", task("DISPATCH-OVERRIDE: no ROLE first"), fx.env);
    check("r1-state.F7.first-override-no-role-launch-refused", result.rc === 2 && result.out.includes('"permissionDecision":"deny"'));
    const idle = lib.joinRoster([{ ...ORCH, self: true }, WH], REG_ONE.workhorses, [IDLE_ROW]);
    const roster = lib.rosterText(idle), remedy = lib.brokerRemedy("Agent", "security-review", idle);
    check("r1-state.F5.all-role-intent-words", roster.includes("every role") && remedy.includes("every role") && remedy.includes("in-session launch") && !roster.includes("work-class") && !remedy.includes("work-class"));
    check("r1-state.F4.strict-header-remedy-words", remedy.includes("same unbroken header") && remedy.includes("before any blank or prose line") && remedy.includes("first 4 header lines") && !remedy.includes("blank/prose lines may intervene") && !remedy.includes("first 4 non-empty lines"));
  }
  {
    const fx = scaffold(), originalPath = process.env.PATH, originalBin = process.env.FLEET_CSQ_BIN;
    const planted = path.join(fx.repoDir, "bin"); fs.mkdirSync(planted);
    fs.copyFileSync(path.join(fx.dir, "csq"), path.join(planted, "csq")); fs.chmodSync(path.join(planted, "csq"), 0o755);
    try {
      process.env.PATH = planted + path.delimiter + fx.dir;
      process.env.FLEET_CSQ_BIN = path.join(planted, "csq");
      check("r1-state.csq-owner-absolute-outside-repo", lib.csqBin() === fs.realpathSync(path.join(fx.dir, "csq")));
      fs.chmodSync(path.join(fx.dir, "csq"), 0o777);
      check("r1-state.csq-writable-and-env-override-refused", lib.csqBin() === null);
      fs.chmodSync(path.join(fx.dir, "csq"), 0o755);
      const cp = require("node:child_process"), spawn = cp.spawnSync; let captured;
      try {
        cp.spawnSync = (exe, args, opts) => { captured = { exe, args, opts }; return { status: 0, stdout: "", stderr: "" }; };
        const deadlineMs = Date.now() + 200;
        const sent = lib.sendMessage(WH_TARGET, "known", { sessions: [WH], deadlineMs, timeoutMs: 1600 });
        check("r1-state.csq-reuses-list-bounds-send", sent.ok && captured.args[1] === "send" && path.isAbsolute(captured.exe) && captured.opts.timeout > 0 && captured.opts.timeout <= 200 && captured.opts.killSignal === "SIGKILL");
        captured = null;
        check("r1-state.csq-expired-deadline-no-spawn", !lib.runCsq(["sessions", "list"], { deadlineMs: Date.now() - 1 }).ok && captured === null);
      } finally { cp.spawnSync = spawn; }
    } finally {
      process.env.PATH = originalPath;
      if (originalBin === undefined) delete process.env.FLEET_CSQ_BIN; else process.env.FLEET_CSQ_BIN = originalBin;
    }
  }

  {
    const fx = scaffold(), previousPath = process.env.PATH;
    try {
      process.env.PATH = fx.dir;
      const trusted = lib.csqExecutableStatus();
      check("r2-state.csq-trusted-status-compatible", trusted.ok && trusted.path === fs.realpathSync.native(path.join(fx.dir, "csq")) && lib.csqBin() === trusted.path);
      fs.chmodSync(fx.dir, 0o775);
      const refused = lib.csqExecutableStatus(), listed = lib.liveSessions();
      const reason = "untrusted csq executable: " + fs.realpathSync.native(fx.dir) + " is group-writable";
      check("r2-state.csq-group-writable-exact-diagnostic", !refused.ok && refused.diagnostic?.code === "csq-untrusted-group-writable" && refused.diagnostic.reason === reason && lib.csqBin() === null);
      check("r2-state.csq-group-writable-diagnostic-propagates", !listed.ok && listed.sessions.length === 0 && listed.diagnostic?.reason === reason && listed.diagnostic.remedy.includes("~/.local/bin") && listed.diagnostic.remedy.includes("must not be group- or world-writable"));
      fs.chmodSync(fx.dir, 0o755);
      const calls = [], native = fs.realpathSync.native;
      try {
        fs.realpathSync.native = (input, ...args) => { calls.push(path.resolve(input)); return native(input, ...args); };
        check("r2-state.csq-native-candidate-and-all-boundaries", lib.csqBin() === native(path.join(fx.dir, "csq")) &&
          [path.join(fx.dir, "csq"), process.cwd(), path.resolve(HOOKS, "../.."), fx.repoDir].every(p => calls.includes(path.resolve(p))));
      } finally { fs.realpathSync.native = native; }
      process.env.PATH = "";
      const missing = lib.liveSessions();
      check("r2-state.csq-missing-distinct-diagnostic", !missing.ok && missing.diagnostic?.code === "csq-executable-missing");
      process.env.PATH = fx.dir;
      const cp = require("node:child_process"), spawn = cp.spawnSync;
      try {
        cp.spawnSync = () => ({ status: null, error: { code: "ETIMEDOUT" }, stderr: "untrusted child error bytes" });
        const timeout = lib.liveSessions();
        check("r2-state.csq-timeout-distinct-diagnostic", !timeout.ok && timeout.diagnostic?.code === "csq-timeout" && !timeout.diagnostic.reason.includes("untrusted child error bytes"));
        cp.spawnSync = () => ({ status: 0, stdout: "{", stderr: "" });
        check("r2-state.csq-invalid-list-distinct-diagnostic", lib.liveSessions().diagnostic?.code === "csq-invalid-session-list");
      } finally { cp.spawnSync = spawn; }
    } finally { fs.chmodSync(fx.dir, 0o755); process.env.PATH = previousPath; }
  }
  if (process.platform === "darwin") {
    const fx = scaffold(), oldPath = process.env.PATH, oldProject = process.env.CLAUDE_PROJECT_DIR;
    const planted = path.join(fx.repoDir, "bin"); fs.mkdirSync(planted);
    fs.copyFileSync(path.join(fx.dir, "csq"), path.join(planted, "csq")); fs.chmodSync(path.join(planted, "csq"), 0o755);
    const alias = path.join(fx.dir, "Repo");
    try {
      if (fs.existsSync(alias)) {
        check("r2-state.csq-darwin-alias-same-inode", fs.statSync(alias).ino === fs.statSync(fx.repoDir).ino);
        process.env.PATH = path.join(alias, "bin") + path.delimiter + fx.dir;
        process.env.CLAUDE_PROJECT_DIR = fx.repoDir;
        check("r2-state.csq-darwin-candidate-case-alias-refused", lib.csqBin() === fs.realpathSync.native(path.join(fx.dir, "csq")));
        process.env.PATH = planted + path.delimiter + fx.dir;
        process.env.CLAUDE_PROJECT_DIR = alias;
        check("r2-state.csq-darwin-boundary-case-alias-refused", lib.csqBin() === fs.realpathSync.native(path.join(fx.dir, "csq")));
      } else {
        console.log("SKIP r2-state.csq-darwin-case-alias: this volume is case-sensitive; native resolver invocation poles remain owed");
      }
    } finally { process.env.PATH = oldPath; process.env.CLAUDE_PROJECT_DIR = oldProject; }
  }
  function childCapture(fx, name, args, env = fx.env) {
    const outFile = path.join(fx.dir, name + ".stdout"), errFile = path.join(fx.dir, name + ".stderr");
    const a = fs.openSync(outFile, "wx"), b = fs.openSync(errFile, "wx"); let result;
    try { result = spawnSync(process.execPath, args, { cwd: fx.repoDir, env, stdio: ["ignore", a, b], timeout: 40000 }); }
    finally { fs.closeSync(a); fs.closeSync(b); }
    return { ...result, stdout: fs.readFileSync(outFile, "utf8"), stderr: fs.readFileSync(errFile, "utf8") };
  }
  {
    const fx = scaffold();
    const code = 'const lib=require(' + JSON.stringify(path.join(HOOKS, "lib/fleet-dispatch.js")) +
      ');Object.defineProperty(process,"platform",{value:"win32"});process.getuid=()=>{throw Error("UID_CHECK_REACHED_ON_WINDOWS")};console.log(JSON.stringify(lib.csqExecutableStatus()));';
    const result = childCapture(fx, "windows-platform", ["-e", code]);
    let status; try { status = JSON.parse(result.stdout); } catch { status = null; }
    check("r2-state.csq-windows-explicit-inert-no-uid-check", result.status === 0 && !result.error && status?.ok === false &&
      status.diagnostic?.code === "csq-unsupported-platform" && status.diagnostic.reason.includes("Windows") &&
      status.diagnostic.remedy.includes("darwin or linux") && !result.stderr.includes("UID_CHECK_REACHED_ON_WINDOWS"), result.stderr);
  }
  for (const command of ["status", "register", "unregister"]) {
    const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry: REG_ONE, stateRows: [BUSY_ROW] });
    const log = path.join(fx.dir, "cli-budget.jsonl"), preload = path.join(fx.dir, "cli-observe.cjs");
    fs.writeFileSync(preload, 'const fs=require("node:fs"),cp=require("node:child_process"),lib=require(' +
      JSON.stringify(path.join(HOOKS, "lib/fleet-dispatch.js")) + '),file=' + JSON.stringify(log) +
      ';const emit=o=>fs.appendFileSync(file,JSON.stringify(o)+String.fromCharCode(10));' +
      'const root=lib.stateRoot,list=lib.liveSessions,spawn=cp.spawnSync;' +
      'lib.stateRoot=function(o){emit({kind:"root",deadlineMs:o?.deadlineMs,remaining:o?.deadlineMs-Date.now()});return root.call(this,o)};' +
      'lib.liveSessions=function(o){emit({kind:"list",timeoutMs:o?.timeoutMs,deadlineMs:o?.deadlineMs});return list.call(this,o)};' +
      'cp.spawnSync=function(p,a,o){if(a?.[0]==="sessions")emit({kind:"spawn",timeout:o.timeout,kill:o.killSignal});return spawn.call(this,p,a,o)};');
    const args = ["--require", preload, path.resolve(HOOKS, "../bin/fleet-roster.mjs"), command, ...(command === "status" ? ["--json"] : [WH_TARGET])];
    const result = childCapture(fx, "cli-" + command, args);
    const rows = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
    const root = rows.find(r => r.kind === "root"), list = rows.find(r => r.kind === "list"), spawned = rows.filter(r => r.kind === "spawn");
    check("r2-state.cli-budget-" + command, result.status === 0 && !result.error && root?.remaining > 25000 && root.remaining <= 30000 &&
      list?.timeoutMs === 10000 && list.deadlineMs === root.deadlineMs && spawned.length === 1 && spawned[0].timeout > 1200 &&
      spawned[0].timeout <= 10000 && spawned[0].kill === "SIGKILL", JSON.stringify({ rc: result.status, rows, err: result.stderr }));
  }
}
