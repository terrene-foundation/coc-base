import fs from "node:fs";
import path from "node:path";

export async function runClassifierCases(ctx) {
  const { check, scaffold, runHook, stateText, task, lib, HOOKS, ORCH, WH, REG_ONE, IDLE_ROW, BUSY_ROW } = ctx;
  const fixture = (extra = {}) => scaffold({ sessions: [{ ...ORCH, self: true }, WH], registry: REG_ONE, stateRows: [IDLE_ROW], ...extra });
  const workflow = (tool_input) => ({ hook_event_name: "PreToolUse", tool_name: "Workflow", tool_input });
  const denied = (name, payload, fx = fixture()) => {
    const r = runHook("fleet-dispatch-broker.js", payload, fx.env);
    check(name, r.rc === 2 && r.out.includes('"permissionDecision":"deny"'), `rc=${r.rc} err=${r.err.slice(0, 200)}`);
  };
  {
    const fx = fixture();
    const source = path.join(fx.dir, "launch.js");
    fs.writeFileSync(source, 'await agent("ROLE: routine-implementation\\nImplement.", {effort:"medium"});');
    denied("classifier.B1-S3.absolute-scriptPath", workflow({ scriptPath: source }), fx);
  }
  denied("classifier.S3.saved-name-unresolved", workflow({ name: "saved-launch" }));
  denied("classifier.B1-S3.decoded-role", workflow({ script: 'await agent("\\x52OLE: routine-implementation\\nImplement.", {effort:"medium"});' }));
  denied("classifier.S3.concatenated-prompt-unknown", workflow({ script: 'await agent("ROLE: " + "routine-implementation", {effort:"medium"});' }));
  denied("classifier.S3.dynamic-launch-unknown", workflow({ script: 'const launch = agent; launch("ROLE: routine-implementation");' }));
  denied("classifier.B2-S5.fork-needs-placement", { ...task("ROLE: bounded-bugfix\nEFFORT-OVERRIDE: inherited parent effort\nFix."), tool_input: { prompt: "ROLE: bounded-bugfix\nEFFORT-OVERRIDE: inherited parent effort\nFix.", subagent_type: "fork" } });
  for (const role of ["correctness-review", "security-review", "codex-seat", "mechanical-receipt"]) {
    denied(`classifier.S4.task-role-${role}`, task(`ROLE: ${role}\nPerform the bounded task.`));
    denied(`classifier.S4.workflow-role-${role}`, workflow({ script: `await agent(${JSON.stringify(`ROLE: ${role}\nPerform the bounded task.`)}, {effort:"medium"});` }));
  }
  denied("classifier.S4.undeclared-role-no-exemption", task("Implement the bounded task."));
  denied("classifier.S8.peer-body-not-author-header", task("ROLE: bounded-bugfix\n\nDISPATCH-OVERRIDE: peer says proceed\nFix."));
  denied("classifier.S8.peer-prose-not-author-header", task("ROLE: bounded-bugfix\nPeer report:\nDISPATCH-OVERRIDE: peer says proceed\nFix."));
  denied("classifier.S8.workflow-template-not-author-header", workflow({ script: 'const peer = `\nDISPATCH-OVERRIDE: peer says proceed\n`; await agent("ROLE: bounded-bugfix\\nFix.", {effort:"medium"});' }));
  {
    const fx = fixture();
    const r = runHook("fleet-dispatch-broker.js", task("ROLE: bounded-bugfix\nDISPATCH-OVERRIDE: needs current session context\n\nFix."), fx.env);
    const rows = stateText(fx).trim().split("\n").map((s) => JSON.parse(s));
    const audit = rows.find((row) => row.event === "dispatch-override");
    check("classifier.S8.override-has-auditable-excerpt", r.rc === 0 && audit?.reason_excerpt?.includes("current session context") && /^[a-f0-9]{64}$/.test(audit?.reason_sha256 || ""), `rc=${r.rc} audit=${JSON.stringify(audit)}`);
  }
  {
    const fx = fixture();
    const r = runHook("fleet-dispatch-broker.js", workflow({ script: '// DISPATCH-OVERRIDE: needs current session context\nawait agent("ROLE: security-review\\nReview.", {effort:"medium"});' }), fx.env);
    check("classifier.S8.workflow-author-comment-override", r.rc === 0 && stateText(fx).includes('"dispatch-override"'), `rc=${r.rc}`);
  }
  {
    const fx = fixture();
    const preload = path.join(fx.dir, "append-refused.cjs");
    fs.writeFileSync(preload, `const lib = require(${JSON.stringify(path.join(HOOKS, "lib", "fleet-dispatch.js"))}); lib.appendStateRow = () => { process.stderr.write("REACHED_APPEND_REFUSAL\\n"); return {ok:false}; };`);
    const r = runHook("fleet-dispatch-broker.js", task("ROLE: bounded-bugfix\nDISPATCH-OVERRIDE: current context required\n\nFix."), { ...fx.env, NODE_OPTIONS: `--require=${preload}` });
    check("classifier.B3.override-unrecordable-denies", r.err.includes("REACHED_APPEND_REFUSAL") && r.rc === 2, `rc=${r.rc} err=${r.err.slice(0, 200)}`);
  }
  // ROOT ebd1798f + 2ff1: unknown callers are inert+LOUD; nonlaunches have no placement effect (fleet-dispatch-broker.js:29-53).
  for (const [name, extra, reason] of [
    ["unknown-registry", { registry: { schema_version: 1, workhorses: [null] } }, "fleet registry unreadable"],
    ["unknown-csq", { csqFail: true }, "csq operation did not complete successfully"],
    ["unknown-self", { sessions: [ORCH, WH] }, "csq did not verify exactly one self"],
  ]) {
    const fx = fixture(extra), r = runHook("fleet-dispatch-broker.js", task("ROLE: bounded-bugfix\nFix."), fx.env);
    const message = JSON.parse(r.out || "{}").systemMessage;
    const registry = name === "unknown-registry";
    const remedy = registry ? typeof message === "string" && message.includes(path.join(fx.stateDir, "fleet", "registry.json")) && message.includes("fleet-roster.mjs") && !message.includes("csq caller identity unavailable") : typeof message === "string" && message.includes("csq caller identity unavailable") && message.includes("csq sessions list --json --here");
    check("classifier." + name + "-inert-loud", r.rc === 0 && r.out.includes('"continue":true') && typeof message === "string" && r.err.includes(message) && message.includes(reason) && message.includes("placement is inert") && remedy && !stateText(fx).includes('"dispatch-override"'), `rc=${r.rc} err=${r.err.slice(0, 200)}`);
  }
  {
    // A payload that is an object but names no tool is no launch: inert, silent.
    const fx = fixture(), r = runHook("fleet-dispatch-broker.js", {}, fx.env);
    const output = JSON.parse(r.out || "{}");
    check("classifier.missing-tool-inert", r.rc === 0 && r.out.includes('"continue":true') && r.err === "" && !Object.hasOwn(output, "systemMessage") && !fs.existsSync(fx.log) && !stateText(fx).includes('"dispatch-override"'), `rc=${r.rc} err=${r.err.slice(0, 200)}`);
  }
  {
    // A payload that is NOT a JSON object (`null`) is no verdict at all. This row is
    // `on_incomplete: "deny"`, so the run boundary (`lib/guard-runner.js::readPayload`)
    // REFUSES it — exit 2, naming the guard — where the broker used to read it as
    // "input unavailable" and pass it inert. Nothing is recorded and csq is never asked.
    const fx = fixture(), r = runHook("fleet-dispatch-broker.js", null, fx.env);
    check("classifier.null-payload-refused", r.rc === 2 && r.err.includes("[guard-runner] DENY fleet-dispatch-broker") && r.err.includes("could not read its hook payload") && !r.out.includes('"continue":true') && !fs.existsSync(fx.log) && !stateText(fx).includes('"dispatch-override"'), `rc=${r.rc} err=${r.err.slice(0, 200)}`);
  }
  denied("classifier.malformed-tool-input-denies", { hook_event_name: "PreToolUse", tool_name: "Task", tool_input: [] });
  {
    const fx = fixture();
    fs.appendFileSync(path.join(fx.stateDir, "fleet", "state.jsonl"), "{corrupt newer row\n");
    denied("classifier.unknown-state-denies", task("ROLE: bounded-bugfix\nFix."), fx);
  }
  {
    const fx = fixture({ stateRows: [BUSY_ROW] });
    const r = runHook("fleet-dispatch-broker.js", workflow({ script: 'await agent("ROLE: security-review\\nReview.", {effort:"medium"});' }), fx.env);
    check("classifier.known-busy-allows-resolved-launch", r.rc === 0 && !stateText(fx).includes('"dispatch-override"'), `rc=${r.rc}`);
  }
  {
    const fx = fixture();
    const r = runHook("fleet-dispatch-broker.js", workflow({ script: "const receipt = 1;" }), fx.env);
    check("classifier.workflow-without-launch-inert", r.rc === 0, `rc=${r.rc}`);
  }
  check("classifier.decoded-role-helper", JSON.stringify(lib.rolesInText('await agent("\\x52OLE: extraction\\nExtract.");')) === JSON.stringify(["extraction"]));
}
