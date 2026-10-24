// run.mjs — fixture runner for the fleet dispatch engine (`.claude/hooks/fleet-*.js` +
// `lib/fleet-dispatch.js`). Registered in `.claude/test-harness/ci-audit-fixtures.json`
// (`rules/cc-artifacts.md` Rule 9). Every case drives the REAL hook file as a child process
// against a fixture repo, a fixture trust-state dir, and a FAKE `csq` binary — no live csq,
// no live fleet, no network. The fake records every invocation, so "did it send exactly one
// message" is a fact about argv, not about trust.
//
// Bipolar coverage: each engine part carries BOTH poles — the broker REFUSES when a workhorse
// is idle and ALLOWS when none is; the idle report SENDS on the transition and stays SILENT
// on repeat/queue>0/unknown; the roster injection INJECTS on change and stays silent on
// no-change and when not the orchestrator.
import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = fs.realpathSync(process.env.FLEET_FIXTURE_HOOKS || path.resolve(HERE, "..", "..", "hooks"));
const GROUP = process.env.FLEET_FIXTURE_GROUP || "all";
if (!["all", "legacy", "facts", "classifier", "transport", "bridge", "contract", "r1-state", "r1-hooks", "fleet-fold"].includes(GROUP)) throw Error("unknown fixture group");
const require = createRequire(import.meta.url);
const lib = require(path.join(HOOKS, "lib", "fleet-dispatch.js"));

let total = 0;
let bad = 0;
function check(name, cond, detail) {
  total++;
  if (cond) console.log(`PASS ${name}`);
  else {
    bad++;
    console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const ORCH = { pid: 21021, started_at: 1791973070, surface: "claude-code", name: "loom", label: "loom", repo: "loom" };
const WH = { pid: 11509, started_at: 1791861643, surface: "claude-code", label: "loom-2d", label_source: "self", repo: "loom" };
const WH2 = { pid: 11931, started_at: 1791973207, surface: "claude-code", name: "loom-ad", label: "loom-9a", repo: "loom" };
const WH_TARGET = "11509:1791861643";
const WH2_TARGET = "11931:1791973207";
const ORCH_TARGET = "21021:1791973070";
const REG_ONE = {
  schema_version: 1,
  workhorses: [
    { name: "loom-2d", target: WH_TARGET, surface: "claude-code", orchestrator_target: ORCH_TARGET, lane: "lw2d-lane", last_item: "lw2d-note-49" },
  ],
};
const IDLE_ROW = { ts: 1, event: "idle", target: WH_TARGET, name: "loom-2d", queue: 0, last: "lw2d-note-49" };
const BUSY_ROW = { ts: 2, event: "busy", target: WH_TARGET, name: "loom-2d", queue: 2, last: null };

const fixtureDirs = new Set();
process.once("exit", () => {
  for (const dir of fixtureDirs) fs.rmSync(dir, { recursive: true, force: true });
});
function scaffold({ sessions, registry, stateRows, laneFiles, csqFail } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetfx-"));
  fixtureDirs.add(dir);
  const repoDir = path.join(dir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(path.join(stateDir, "fleet"), { recursive: true });
  process.env.CLAUDE_PROJECT_DIR = repoDir;
  if (registry) fs.writeFileSync(path.join(stateDir, "fleet", "registry.json"), JSON.stringify(registry));
  if (stateRows && stateRows.length) {
    fs.writeFileSync(path.join(stateDir, "fleet", "state.jsonl"), stateRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  for (const [rel, body] of Object.entries(laneFiles || {})) {
    const p = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  const fake = path.join(dir, "csq");
  fs.writeFileSync(
    fake,
    [
      "#!/usr/bin/env node",
      'const fs=require("fs");',
      "const args=process.argv.slice(2);",
      'fs.appendFileSync(process.env.FLEET_CSQ_LOG, args.join("\\t")+"\\n");',
      "if(process.env.FLEET_CSQ_FAIL)process.exit(1);",
      'if(args[0]==="sessions"&&args[1]==="list")process.stdout.write(fs.readFileSync(process.env.FLEET_CSQ_SESSIONS,"utf8"));',
      "process.exit(0);",
    ].join("\n") + "\n",
  );
  fs.chmodSync(fake, 0o755);
  const sessFile = path.join(dir, "sessions.json");
  fs.writeFileSync(sessFile, JSON.stringify({ schema: "csq.sessions.v1", ok: true, sessions: sessions || [] }));
  const log = path.join(dir, "csq.log");
  return {
    dir,
    repoDir,
    stateDir,
    log,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repoDir,
      CLAUDE_TRUST_STATE_DIR: stateDir,
      PATH: `${dir}${path.delimiter}${process.env.PATH || ""}`,
      FLEET_CSQ_LOG: log,
      FLEET_CSQ_SESSIONS: sessFile,
      ...(csqFail ? { FLEET_CSQ_FAIL: "1" } : {}),
    },
  };
}

function runHook(hook, payload, env) {
  const r = spawnSync(process.execPath, [path.join(HOOKS, hook)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
    timeout: 30000,
  });
  return { rc: r.status, out: r.stdout || "", err: r.stderr || "" };
}
function stateText(fx) {
  try {
    return fs.readFileSync(path.join(fx.stateDir, "fleet", "state.jsonl"), "utf8");
  } catch {
    return "";
  }
}
function csqLog(fx) {
  try {
    return fs.readFileSync(fx.log, "utf8");
  } catch {
    return "";
  }
}
// `sessions list` is EXPECTED (it is the identity/liveness read every part needs); what must
// never appear where the cases assert silence is a `send`.
const sentMessages = (fx) => csqLog(fx).includes("sessions\tsend");
const task = (prompt) => ({ hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { prompt, effort: "medium" } });

// ── part (3): the dispatch broker ───────────────────────────────────────────

if (GROUP === "all" || GROUP === "legacy") {
{
  const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry: REG_ONE, stateRows: [IDLE_ROW] });
  const r = runHook("fleet-dispatch-broker.js", task("ROLE: routine-implementation\n\nImplement the thing."), fx.env);
  check(
    "broker.refuses-when-workhorse-idle",
    r.rc === 2 &&
      r.err.includes("fleet dispatch broker") &&
      r.err.includes("loom-2d") &&
      r.err.includes("csq sessions send") && r.err.includes(`-- ${WH_TARGET}`) &&
      r.err.includes("DISPATCH-OVERRIDE") &&
      r.out.includes('"permissionDecision":"deny"'),
    `rc=${r.rc} err=${JSON.stringify(r.err.slice(0, 160))}`,
  );
}
{
  const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry: REG_ONE, stateRows: [BUSY_ROW] });
  const r = runHook("fleet-dispatch-broker.js", task("ROLE: routine-implementation\n\nImplement the thing."), fx.env);
  check("broker.allows-when-no-workhorse-idle", r.rc === 0 && r.out.includes('"continue":true'), `rc=${r.rc}`);
}
{
  const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], stateRows: [IDLE_ROW] });
  const r = runHook("fleet-dispatch-broker.js", task("ROLE: routine-implementation\n\nx"), fx.env);
  check("broker.inert-without-registry", r.rc === 0, `rc=${r.rc}`);
}
{
  const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry: REG_ONE, stateRows: [IDLE_ROW] });
  const r = runHook("fleet-dispatch-broker.js", task("ROLE: security-review\n\nReview the diff."), fx.env);
  check("broker.S4.places-review-class", r.rc === 2, `rc=${r.rc}`);
}
{
  const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry: REG_ONE, stateRows: [IDLE_ROW] });
  const r = runHook("fleet-dispatch-broker.js", task("Do the thing (no ROLE line)."), fx.env);
  check("broker.S4.places-unclassified-launch", r.rc === 2, `rc=${r.rc}`);
}
{
  const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry: REG_ONE, stateRows: [IDLE_ROW] });
  const r = runHook(
    "fleet-dispatch-broker.js",
    task("ROLE: bounded-bugfix\nDISPATCH-OVERRIDE: needs the orchestrator's live diff context\n\nFix it."),
    fx.env,
  );
  const st = stateText(fx);
  check(
    "broker.override-allows-and-records",
    r.rc === 0 && st.includes('"dispatch-override"') && /"reason_sha256":"[0-9a-f]{64}"/.test(st) && !sentMessages(fx),
    `rc=${r.rc} state=${JSON.stringify(st.slice(-140))}`,
  );
}
{
  const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry: REG_ONE, stateRows: [IDLE_ROW] });
  const r = runHook(
    "fleet-dispatch-broker.js",
    { hook_event_name: "PreToolUse", tool_name: "Workflow", tool_input: { script: 'const r = await agent("ROLE: routine-implementation — do X");' } },
    fx.env,
  );
  check("broker.workflow-work-class-refused", r.rc === 2 && r.err.includes("loom-2d"), `rc=${r.rc}`);
}
{
  const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry: REG_ONE, stateRows: [IDLE_ROW] });
  const r = runHook(
    "fleet-dispatch-broker.js",
    { hook_event_name: "PreToolUse", tool_name: "Workflow", tool_input: { script: 'await agent("ROLE: mechanical-receipt — regen ledger");' } },
    fx.env,
  );
  check("broker.S4.workflow-mechanical-placed", r.rc === 2, `rc=${r.rc}`);
}
{
  const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry: REG_ONE, stateRows: [IDLE_ROW], csqFail: true });
  const r = runHook("fleet-dispatch-broker.js", task("ROLE: routine-implementation\n\nx"), fx.env);
  check("broker.S7.unknown-caller-csq-down-inert-loud", r.rc === 0 && r.out.includes('"continue":true') && /csq/i.test(r.err), `rc=${r.rc} err=${r.err}`);
}

// ── part (1): the idle report ───────────────────────────────────────────────

{
  const fx = scaffold({ sessions: [ORCH, { ...WH, self: true }], registry: REG_ONE });
  const r = runHook("fleet-workhorse-report.js", { hook_event_name: "Stop" }, fx.env);
  const log = csqLog(fx);
  const st = stateText(fx);
  check(
    "report.stop-idle-sends-one-message",
    r.rc === 0 &&
      log.split("\n").filter(line => line.startsWith("sessions\tsend\t")).length === 1 &&
      log.includes("IDLE loom-2d queue=0 last=lw2d-note-49") && log.includes(`--\t${ORCH_TARGET}`) &&
      st.includes('"event":"idle"'),
    `rc=${r.rc} log=${JSON.stringify(log)}`,
  );
}
{
  const fx = scaffold({ sessions: [ORCH, { ...WH, self: true }], registry: REG_ONE, stateRows: [IDLE_ROW] });
  const r = runHook("fleet-workhorse-report.js", { hook_event_name: "Stop" }, fx.env);
  check("report.stop-idle-dedupes-repeat", r.rc === 0 && !sentMessages(fx), `log=${JSON.stringify(csqLog(fx))}`);
}
{
  const fx = scaffold({
    sessions: [ORCH, { ...WH, self: true }],
    registry: REG_ONE,
    laneFiles: { "workspaces/ws/todos/active/item.md": "---\nid: ws/item\nlane: lw2d-lane\n---\nbody\n" },
  });
  const r = runHook("fleet-workhorse-report.js", { hook_event_name: "Stop" }, fx.env);
  const st = stateText(fx);
  check(
    "report.stop-nonzero-queue-no-send",
    r.rc === 0 && !sentMessages(fx) && st.includes('"event":"busy"') && st.includes('"queue":1'),
    `log=${JSON.stringify(csqLog(fx))} state=${JSON.stringify(st)}`,
  );
}
{
  const fx = scaffold({ sessions: [ORCH, { ...WH, self: true }], registry: REG_ONE });
  const r = runHook("fleet-workhorse-report.js", { hook_event_name: "UserPromptSubmit", prompt: "go" }, fx.env);
  check(
    "report.prompt-marks-busy",
    r.rc === 0 && !sentMessages(fx) && stateText(fx).includes('"event":"busy"'),
    `state=${JSON.stringify(stateText(fx))}`,
  );
}
{
  const reg = { schema_version: 1, workhorses: [{ ...REG_ONE.workhorses[0], target: WH2_TARGET }] };
  const fx = scaffold({ sessions: [ORCH, { ...WH, self: true }], registry: reg });
  const r = runHook("fleet-workhorse-report.js", { hook_event_name: "Stop" }, fx.env);
  check("report.inert-unregistered-session", r.rc === 0 && !sentMessages(fx) && stateText(fx) === "", `log=${JSON.stringify(csqLog(fx))}`);
}
{
  const reg = { schema_version: 1, workhorses: [{ ...REG_ONE.workhorses[0], lane: null }] };
  const fx = scaffold({ sessions: [ORCH, { ...WH, self: true }], registry: reg });
  const r = runHook("fleet-workhorse-report.js", { hook_event_name: "Stop" }, fx.env);
  check("report.unknown-lane-silent", r.rc === 0 && !sentMessages(fx), `log=${JSON.stringify(csqLog(fx))}`);
}

// ── part (2): roster injection ──────────────────────────────────────────────

const REG_TWO = {
  schema_version: 1,
  workhorses: [
    REG_ONE.workhorses[0],
    { name: "loom-9a", target: WH2_TARGET, surface: "claude-code", orchestrator_target: ORCH_TARGET, lane: "loom-ad-lane", last_item: null },
  ],
};
{
  const fx = scaffold({
    sessions: [{ ...ORCH, self: true }, WH, WH2],
    registry: REG_TWO,
    stateRows: [IDLE_ROW, { ts: 3, event: "busy", target: WH2_TARGET, queue: 2, last: null }],
  });
  const r = runHook("fleet-roster-inject.js", { hook_event_name: "UserPromptSubmit", prompt: "hi" }, fx.env);
  let ctx = "";
  try {
    ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  } catch {
    /* fall through to the assertion below */
  }
  check(
    "inject.emits-changed-roster",
    r.rc === 0 && ctx.includes("loom-2d") && ctx.includes("IDLE") && ctx.includes("loom-9a") && ctx.includes("queue=2") && ctx.includes("csq sessions send"),
    `rc=${r.rc} ctx=${JSON.stringify(ctx.slice(0, 200))}`,
  );
}
{
  const fx = scaffold({
    sessions: [{ ...ORCH, self: true }, WH, WH2],
    registry: REG_TWO,
    stateRows: [IDLE_ROW, { ts: 3, event: "busy", target: WH2_TARGET, queue: 2, last: null }],
  });
  const p = { hook_event_name: "UserPromptSubmit", prompt: "hi" };
  const r1 = runHook("fleet-roster-inject.js", p, fx.env);
  const r2 = runHook("fleet-roster-inject.js", p, fx.env);
  check("inject.dedupes-unchanged-roster", r1.out.trim() !== "" && r2.out.trim() === "", `r1len=${r1.out.length} r2len=${r2.out.length}`);
}
{
  const reg = { schema_version: 1, workhorses: [{ ...REG_ONE.workhorses[0], orchestrator_target: WH2_TARGET }] };
  const fx = scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry: reg, stateRows: [IDLE_ROW] });
  const r = runHook("fleet-roster-inject.js", { hook_event_name: "UserPromptSubmit", prompt: "hi" }, fx.env);
  check("inject.inert-not-orchestrator", r.rc === 0 && r.out.trim() === "", `out=${JSON.stringify(r.out.slice(0, 80))}`);
}

// ── pure core ───────────────────────────────────────────────────────────────

check("pure.idle-grammar", lib.renderIdleMessage("loom-2d", "lw2d-note-49") === "[UNTRUSTED DATA: FLEET IDLE]\nIDLE loom-2d queue=0 last=lw2d-note-49\n[END UNTRUSTED DATA]");
check("pure.render-idle-dash", lib.renderIdleMessage("loom-2d", null) === "[UNTRUSTED DATA: FLEET IDLE]\nIDLE loom-2d queue=0 last=-\n[END UNTRUSTED DATA]");
{
  const f1 = lib.foldState([BUSY_ROW, IDLE_ROW], WH_TARGET);
  const f2 = lib.foldState([{ bogus: true }, IDLE_ROW], WH_TARGET);
  const f3 = lib.foldState([], WH_TARGET);
  check("pure.fold-last-wins", f1.state === "idle" && f2.state === "unknown" && f3.state === "unknown", `${f1.state}/${f2.state}/${f3.state}`);
}
check(
  "pure.work-class-mapping",
  lib.isWorkClass("routine-implementation") &&
    lib.isWorkClass("explore-search") &&
    !lib.isWorkClass("security-review") &&
    !lib.isWorkClass("codex-seat") &&
    !lib.isWorkClass("mechanical-receipt"),
);
check("pure.roles-in-text", JSON.stringify(lib.rolesInText('await agent("ROLE: a\\nx", {effort:"medium"}); await agent("ROLE: b\\ny", {effort:"low"});')) === JSON.stringify(["a", "b"]));
{
  const o1 = lib.declaresDispatchOverride("ROLE: x\nDISPATCH-OVERRIDE: because reasons");
  const o2 = lib.declaresDispatchOverride("ROLE: x\nDISPATCH-OVERRIDE:");
  const o3 = lib.declaresDispatchOverride("a\nb\nc\nd\nDISPATCH-OVERRIDE: too late");
  check("pure.override-parse", o1.present === true && o1.reason === "because reasons" && !o2.present && !o3.present);
}
check(
  "pure.role-of-prompt",
  lib.roleOfPrompt("  \nROLE: extraction\n…") === "extraction" && lib.roleOfPrompt("no role here") === null,
);

}

const ctx = { check, scaffold, runHook, stateText, csqLog, sentMessages, task, lib, HOOKS,
  ORCH, WH, WH2, WH_TARGET, WH2_TARGET, ORCH_TARGET, REG_ONE, IDLE_ROW, BUSY_ROW };
for (const [group, exported] of [["facts", "runFactCases"], ["classifier", "runClassifierCases"],
  ["transport", "runTransportCases"], ["bridge", "runBridgeCases"], ["contract", "runContractCases"],
  ["r1-state", "runR1StateCases"], ["r1-hooks", "runR1HookCases"], ["fleet-fold", "runFleetFoldCases"]]) {
  if (GROUP !== "all" && GROUP !== group) continue;
  const moduleName = group === "facts" ? "fact" : group === "r1-hooks" ? "r1-hook" : group;
  const cases = await import("./" + moduleName + "-cases.mjs");
  await cases[exported](ctx);
}

console.log(`\nfleet-dispatch fixtures: ${total - bad}/${total} passed`);
process.exit(bad === 0 ? 0 : 1);
