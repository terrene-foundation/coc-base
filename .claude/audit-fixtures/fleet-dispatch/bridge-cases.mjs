import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function runNativeBrokerCases(ctx, native, canonical) {
  const { check, scaffold, HOOKS, ORCH, WH, REG_ONE, IDLE_ROW, BUSY_ROW } = ctx;
  const descriptor = (native.hooks?.PreToolUse || []).flatMap(g => g.hooks || []).find(r => /--native-policy\s*$/.test(r.command || ""));
  const broker = (canonical.events?.PreToolUse?.groups || []).flatMap(g => g.hooks || []).find(r => /\/fleet-dispatch-broker\.js"$/.test(r.command || ""));
  check("bridge.FS6.canonical-native-policy-broker", Boolean(descriptor && broker));
  if (!descriptor || !broker) return;
  const { createHash } = await import("node:crypto");
  const { gzipSync } = await import("node:zlib");
  for (const [pole, rows, reverted] of [["idle", [IDLE_ROW], false], ["busy", [BUSY_ROW], false], ["idle-reverted", [IDLE_ROW], true]]) {
    const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry: REG_ONE, stateRows: rows });
    const copied = path.join(fx.repoDir, ".claude/hooks"), guard = path.join(fx.repoDir, ".claude/codex-mcp-guard");
    fs.mkdirSync(copied, { recursive: true }); fs.mkdirSync(guard, { recursive: true });
    if (!fs.existsSync(path.join(fx.repoDir, ".git"))) fs.mkdirSync(path.join(fx.repoDir, ".git"));
    fs.cpSync(path.join(HOOKS, "lib"), path.join(copied, "lib"), { recursive: true });
    let source = fs.readFileSync(path.join(HOOKS, "fleet-dispatch-broker.js"), "utf8");
    if (reverted) {
      const previous = source;
      source = source.replace("return idle.length ? { refuse: true, tool, body: lib.brokerRemedy(tool, role, idle) } : null;", "return null;");
      check("bridge.FS6.reversion-changed", source !== previous);
    }
    fs.writeFileSync(path.join(copied, "fleet-dispatch-broker.js"), source);
    for (const name of ["server.js", "policy-outcome.js"]) fs.copyFileSync(path.resolve(HOOKS, "../codex-mcp-guard", name), path.join(guard, name));
    fs.writeFileSync(path.join(guard, "policies.json"), JSON.stringify({ policies: {} }));
    fs.writeFileSync(path.join(copied, "dispatch-registry.json"), JSON.stringify({
      schema: canonical.schema, events: { PreToolUse: { dispatcher: { timeout: 20 }, groups: [{ matcher: "Task|Agent|Workflow", hooks: [broker] }] } },
    }));
    fs.writeFileSync(path.join(fx.repoDir, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{
      matcher: "Task|Agent|Workflow", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.js" PreToolUse', timeout: 20 }],
    }] } }));
    const trace = path.join(fx.dir, "native-compile.cjs");
    const reachedFile = path.join(fx.dir, "native.reached");
    fs.writeFileSync(trace, 'const M=require("node:module"),c=require("node:crypto"),fs=require("node:fs"),old=M.prototype._compile;M.prototype._compile=function(s,f){if(f.endsWith("/fleet-dispatch-broker.js"))fs.appendFileSync(' + JSON.stringify(reachedFile) + ',"REACHED native-broker sha256="+c.createHash("sha256").update(s).digest("hex")+"\\n");return old.call(this,s,f);};');
    const outFile = path.join(fx.dir, "native.stdout"), errFile = path.join(fx.dir, "native.stderr");
    const a = fs.openSync(outFile, "wx"), b = fs.openSync(errFile, "wx");
    let result;
    try { result = spawnSync(process.execPath, ["--require", trace, path.join(copied, "lib/codex-hook-runtime.js"), "--native-policy"], {
      cwd: fx.repoDir, env: { ...fx.env, LOOM_LINKS_CONFIG: "", COC_RUNTIME: "codex",
        NODE_OPTIONS: [fx.env.NODE_OPTIONS || "", "--require=" + JSON.stringify(trace)].filter(Boolean).join(" ") },
      input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repoDir, tool_name: "spawn_agent", tool_input: { message: "ROLE: routine-implementation\nImplement the bounded item.", reasoning_effort: "medium" } }),
      stdio: ["pipe", a, b], timeout: 20000,
    }); } finally { fs.closeSync(a); fs.closeSync(b); }
    const stdout = fs.readFileSync(outFile, "utf8"), stderr = fs.readFileSync(errFile, "utf8");
    const digest = createHash("sha256").update(source).digest("hex");
    const reachedBytes = fs.existsSync(reachedFile) ? fs.readFileSync(reachedFile) : Buffer.alloc(0);
    const reached = reachedBytes.toString().includes("REACHED native-broker sha256=" + digest);
    for (const [name, bytes] of [["source", Buffer.from(source)], ["stdout", fs.readFileSync(outFile)], ["stderr", fs.readFileSync(errFile)], ["reached", reachedBytes]]) {
      const compressed = gzipSync(bytes), sha = b => createHash("sha256").update(b).digest("hex");
      console.log("@@UNION_ARTIFACT@@ " + JSON.stringify({ name: "FS6-" + pole + "." + name, bytes: bytes.length, sha256: sha(bytes),
        gzip_bytes: compressed.length, gzip_sha256: sha(compressed), data: compressed.toString("base64") }));
    }
    const output = JSON.parse(stdout || "{}"), denied = result.status === 2 && output.hookSpecificOutput?.permissionDecision === "deny" && stderr.includes("fleet dispatch broker");
    console.log("REACHED native-broker-pole " + JSON.stringify({ pole, sha256: digest, status: result.status, reached }));
    check("bridge.FS6.native-spawn-agent-" + pole, reached && (pole === "idle" ? denied : result.status === 0 && !denied), stderr.slice(-1200));
  }
}


export async function runBridgeCases(ctx) {
  const { check, scaffold, csqLog, stateText, HOOKS, ORCH, WH, REG_ONE } = ctx;
  const sourceRoot = path.resolve(HOOKS, "../..");
  const native = JSON.parse(fs.readFileSync(path.join(sourceRoot, ".codex/hooks.json"), "utf8"));
  const descriptors = (native.hooks?.Stop || []).flatMap(group => group.hooks || []);
  const host = descriptors.find(row => row.type === "command" &&
    /codex-hook-runtime\.js/.test(row.command) && /--native-event Stop\s*$/.test(row.command));
  check("bridge.f.canonical-native-Stop-descriptor", Boolean(host));
  const canonical = JSON.parse(fs.readFileSync(path.join(HOOKS, "dispatch-registry.json"), "utf8"));
  await runNativeBrokerCases(ctx, native, canonical);
  const hooks = (canonical.events?.Stop?.groups || []).flatMap(group => group.hooks || [])
    .filter(row => /\/fleet-workhorse-report\.js"$/.test(row.command || ""));
  check("bridge.f.canonical-fleet-Stop-descriptor", hooks.length === 1);
  if (!host || hooks.length !== 1) return;
  const fx = scaffold({ sessions: [ORCH, { ...WH, self: true }], registry: REG_ONE });
  const copiedHooks = path.join(fx.repoDir, ".claude/hooks");
  fs.mkdirSync(copiedHooks, { recursive: true });
  if (!fs.existsSync(path.join(fx.repoDir, ".git"))) fs.mkdirSync(path.join(fx.repoDir, ".git"));
  fs.cpSync(path.join(HOOKS, "lib"), path.join(copiedHooks, "lib"), { recursive: true });
  fs.copyFileSync(path.join(HOOKS, "fleet-workhorse-report.js"), path.join(copiedHooks, "fleet-workhorse-report.js"));
  const guard = path.join(sourceRoot, ".claude/codex-mcp-guard");
  fs.mkdirSync(path.join(fx.repoDir, ".claude/codex-mcp-guard"), { recursive: true });
  for (const name of ["server.js", "policy-outcome.js"]) {
    fs.copyFileSync(path.join(guard, name), path.join(fx.repoDir, ".claude/codex-mcp-guard", name));
  }
  fs.writeFileSync(path.join(copiedHooks, "dispatch-registry.json"), JSON.stringify({
    schema: canonical.schema,
    events: { Stop: { dispatcher: { timeout: 60 }, groups: [{ hooks }] } },
  }));
  fs.writeFileSync(path.join(fx.repoDir, ".claude/settings.json"), JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.js" Stop', timeout: 60 }] }],
  } }));
  const result = spawnSync("/bin/sh", ["-c", host.command], {
    cwd: fx.repoDir,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: fx.repoDir, session_id: "fleet-bridge-fixture", stop_hook_active: false }),
    encoding: "utf8", timeout: 60000,
    env: { ...fx.env, LOOM_LINKS_CONFIG: "", COC_STOP_REFUSAL: "0" },
  });
  const sends = csqLog(fx).split("\n").filter(line => line.startsWith("sessions\tsend\t"));
  check("bridge.f.native-Stop-runs-registered-reporter", result.status === 0 && sends.length === 1 &&
    stateText(fx).includes('"event":"idle"'), `rc=${result.status} sends=${sends.length} stderr=${result.stderr?.slice(-1200)}`);
}
