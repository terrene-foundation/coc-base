#!/usr/bin/env node
/**
 * fleet-dispatch-broker.js — part (3) of the fleet dispatch engine (`lib/fleet-dispatch.js`):
 * the DISPATCH BROKER at the PreToolUse boundary.
 *
 * @hook-event: PreToolUse:Task|Agent|Workflow (guard) — registered in the `Task|Agent|Workflow` group BESIDE E3's
 *   `dispatch-contract-guard.js`, deliberately as a SEPARATE row: the effort arm runs first and
 *   owns ROLE/effort enforcement; this row owns PLACEMENT. A Workflow-spawned agent fires no
 *   PreToolUse of its own (E3 § 2, measured), so the Workflow call is the only place its
 *   launches can be seen — the same reason E3's C-11 row exists.
 *
 * ROOT ebd1798f classifies refusal as placement policy, not a trust boundary: only csq-verified
 * self matching a registered orchestrator may deny unknown placement; unknown caller is loud
 * and inert. Override is recorded before unknown placement is read; all roles retain placement
 * intent (.claude/hooks/fleet-dispatch-broker.js:29-98).
 */
"use strict";
const lib = require("./lib/fleet-dispatch.js");
const { runGuard } = require("./lib/guard-runner.js");

const LAUNCH_TOOLS = ["Task", "Agent"];
const WORKFLOW_TOOL = "Workflow";

/**
 * {refuse:true, tool, body}, {notice}, or null; live decision (.claude/hooks/fleet-dispatch-broker.js:29-98).
 * — the facts (liveness, idle fold) are live reads, and the fixture corpus drives THIS function
 * end-to-end instead of a shadow copy of it.
 */
function inert(reason, remedy) {
  const notice = "fleet dispatch broker: " + lib.sanitizeField(reason, 512) + "; placement is inert. " + lib.sanitizeField(remedy, 512);
  process.stderr.write(notice + "\n");
  return { notice };
}

function decide(p, deadlineMs = Date.now() + 3600) {
  const unknownCaller = (diagnostic) => {
    return inert("csq caller identity unavailable (" + diagnostic.reason + ")", diagnostic.remedy);
  };
  const incomplete = (mine = []) => ({ refuse: true, body:
    "STOP — fleet dispatch broker could not establish required placement facts for this verified orchestrator. " +
    "Retry a literal ROLE-first brief with DISPATCH-OVERRIDE: <reason> in the same unbroken header, before any blank or prose line (first 4 header lines); " +
    "the ledger must record that override. Or send the brief directly with csq sessions send --message \"<brief>\" -- " +
    (mine.find(w => live.sessions.some(s => lib.targetOf(s) === w.target))?.target || "<live-registered-workhorse-target>") + "." });
  if (!p || typeof p !== "object" || Array.isArray(p)) return inert("input unavailable or malformed", "Retry the launch with a valid hook payload.");
  const tool = p.tool_name || p.tool || "";
  if (!LAUNCH_TOOLS.includes(tool) && tool !== WORKFLOW_TOOL) return null;
  const root = lib.stateRoot({ deadlineMs });
  if (!root) return inert("fleet learning root unresolved", "Restore the checkout learning-state boundary, then retry.");
  const reg = lib.readRegistry(root);
  if (!reg) return inert("fleet registry unreadable: " + root + "/registry.json", "Inspect the fleet registry with node .claude/bin/fleet-roster.mjs status and repair or re-register its workhorses.");
  if (reg.workhorses.length === 0) return null;
  const live = lib.liveSessions({ deadlineMs });
  if (!live.ok) return unknownCaller(live.diagnostic || { reason: "csq list failed or timed out", remedy: "Restore csq sessions list --json --here, then retry." });
  const selves = live.sessions.filter((s) => s.self === true);
  if (selves.length !== 1) return unknownCaller({ reason: "csq did not verify exactly one self", remedy: "Restore csq sessions list --json --here with one verified self, then retry." });
  const me = lib.targetOf(selves[0]);
  const mine = reg.workhorses.filter((w) => w.orchestrator_target === me);
  if (mine.length === 0) return null;
  try {
  const ti = p.tool_input;
  if (!ti || typeof ti !== "object" || Array.isArray(ti)) return incomplete(mine);
  let text;
  let role;
  let workflowUnknown = false;
  let workflowInline = false;
  if (tool === WORKFLOW_TOOL) {
    const scanner = require("./lib/workflow-launch-scan.js");
    const source = scanner.resolveWorkflowScript(ti);
    if (!source.ok) return incomplete(mine);
    text = source.text;
    workflowInline = source.source === "script";
    const scan = scanner.scanWorkflowScript(text);
    workflowUnknown = !scan.ok || scan.indirect.length || scan.indirectMore || scan.nested.length ||
      scan.calls.some((c) => !c.prompt.evaluable || !c.options.evaluable);
    if (!workflowUnknown && scan.calls.length === 0) return null;
    role = (scan.calls || []).map((c) => lib.roleOfPrompt(c.prompt.text)).find(Boolean) || "undeclared";
  } else {
    if (typeof ti.prompt !== "string" || !ti.prompt.trim()) return incomplete(mine);
    text = ti.prompt;
    role = lib.roleOfPrompt(text) || "undeclared";
  }
  const ov = lib.declaresDispatchOverride(text, { workflow: tool === WORKFLOW_TOOL });
  if (ov.present && (tool !== WORKFLOW_TOOL || workflowInline)) {
    const recorded = lib.appendStateRow(root, {
      event: "dispatch-override", target: me, role,
      reason_sha256: lib.reasonSha256(ov.reason), reason_excerpt: lib.auditReasonExcerpt(ov.reason),
    });
    return recorded && recorded.ok ? null : incomplete(mine);
  }
  if (workflowUnknown) return incomplete(mine);
  const rows = lib.readStateRows(root);
  if (!rows) return incomplete(mine);
  const roster = lib.joinRoster(live.sessions, mine, rows);
  const idle = lib.idleWorkhorses(roster);
  return idle.length ? { refuse: true, tool, body: lib.brokerRemedy(tool, role, idle) } : null;
  } catch {
    return incomplete(mine);
  }
}

function allow(notice) {
  try {
    process.stdout.write(JSON.stringify({ continue: true, ...(notice ? { systemMessage: notice } : {}) }) + "\n");
  } catch {
    /* an unwritable stdout on the allow path cannot make the call worse; still exit 0 */
  }
  process.exit(0);
}

/** The E3 hardDeny shape: stderr body, the permissionDecision pair, exit 2. */
function deny(body) {
  try {
    process.stderr.write("\n" + body + "\n");
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: body },
      }) + "\n",
    );
  } catch {
    /* best effort; the exit code is the contract */
  }
  process.exit(2);
}

// The payload is read by guard-runner.js::runGuard, which REFUSES on an empty, stalled,
// unparseable or oversized stdin (it never resolves a default the broker would read as
// "not a launch"), and refuses a throw or a run past the budget. So the broker carries no
// timer and no catch of its own: a decision it cannot finish is the row's refusal.
async function main(payload) {
  const decision = decide(payload, Date.now() + 3600);
  if (decision && decision.refuse) deny(decision.body);
  allow(decision?.notice);
}

const hookMain = runGuard("fleet-dispatch-broker", main, { budgetMs: 4500 });

module.exports = { hookMain, decide };

if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [
 *       "<main-checkout>/.claude/learning/fleet/",
 *       "<main-checkout>/.claude/learning/fleet/state.jsonl"
 *     ],
 *     "network": false,
 *     "spawns": [
 *       "git",
 *       "csq"
 *     ]
 *   },
 *   "idempotent": false,
 *   "may_rewrite_input": false,
 *   "notes": "Placement follows ROOT ebd1798f: only a csq-verified registered orchestrator may refuse incomplete placement; failures before that match that the broker DECIDES emit a stderr diagnostic and continue:true/systemMessage, while healthy unprotected calls continue without an advisory; a THROW, an unreadable payload or a standalone run past budget is no decision and refuses through guard-runner.js::runGuard (.claude/hooks/fleet-dispatch-broker.js:29-58,101-107,125-135). Registry unreadability has a registry remedy rather than a csq identity claim; the incomplete remedy selects a live registered target or a placeholder (.claude/hooks/fleet-dispatch-broker.js:39-55). fs_writes and idempotent:false: an accepted override may create fleet/ and append state.jsonl before reading placement state (.claude/hooks/fleet-dispatch-broker.js:82-92; .claude/hooks/lib/fleet-dispatch.js:381-401). Workflow override authority is limited to inline script leading // headers; a scriptPath header cannot authorize override. Other launch tools require the strict ROLE-first unbroken header within its first 4 header lines (.claude/hooks/fleet-dispatch-broker.js:65-88; .claude/hooks/lib/fleet-dispatch.js:154-176). spawns:[git,csq], network:false: resolution may probe git and this hook only lists sessions, never sends or opens a connection (.claude/hooks/fleet-dispatch-broker.js:47-55; .claude/hooks/lib/fleet-dispatch.js:334-341,502-540). PreToolUse Task|Agent|Workflow emits continue:true/exit0 or native deny/exit2 and no updatedInput, so may_rewrite_input:false (.claude/hooks/fleet-dispatch-broker.js:21-22,44-46,101-122). There is no fail-open fallback: guard-runner.js::runGuard reads the payload (refusing an empty, stalled, unparseable or oversized stdin) and, outside the engine, refuses a run past budgetMs 4500 with exit 2; synchronous child work uses a shared absolute3600ms deadline and explicit timeout caps (.claude/hooks/fleet-dispatch-broker.js:125-135; .claude/hooks/lib/fleet-dispatch.js:502-540). Registry8s/on_incomplete:deny and inherited on_timeout:deny describe dispatcher disposition, without a host-kill claim (.claude/hooks/dispatch-registry.json:247-251; .claude/bin/emit-hook-registry.mjs:1215-1226)."
 * }
 */
