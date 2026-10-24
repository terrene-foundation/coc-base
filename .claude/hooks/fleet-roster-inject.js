#!/usr/bin/env node
/**
 * fleet-roster-inject.js — part (2) of the fleet dispatch engine (`lib/fleet-dispatch.js`):
 * ROSTER INJECTION on the orchestrator's prompt-submit.
 *
 * @hook-event: UserPromptSubmit (lifecycle) — the roster must be present in the orchestrator's
 *   context BEFORE it decides how to dispatch, and re-presented when it changes, "so that
 *   dispatch must never depend on the orchestrator's memory" (the owner problem, 2026-10-16).
 *
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const lib = require("./lib/fleet-dispatch.js");
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

function incomplete(reason, remedy) {
  const notice = "fleet roster injection incomplete: " + lib.sanitizeField(reason, 512) + ". " + lib.sanitizeField(remedy, 512);
  process.stderr.write(notice + "\n");
  return { notice };
}

/** Context or a diagnostic, or null for a healthy no-change result. */
function run(deadlineMs) {
  const root = lib.stateRoot({ deadlineMs });
  if (!root) return incomplete("fleet learning root unresolved", "Restore the checkout learning-state boundary, then retry.");
  const reg = lib.readRegistry(root);
  if (!reg) return incomplete("fleet registry unreadable: " + root + "/registry.json", "Inspect node .claude/bin/fleet-roster.mjs status and repair or re-register its workhorses.");
  if (reg.workhorses.length === 0) return null;
  const live = lib.liveSessions({ deadlineMs });
  if (!live.ok) return incomplete(live.diagnostic?.reason || "csq list failed or timed out", live.diagnostic?.remedy || "Restore csq sessions list --json --here, then retry.");
  const selves = live.sessions.filter((s) => s.self === true);
  if (selves.length !== 1) return incomplete("csq did not verify exactly one self", "Restore csq sessions list --json --here with one verified self, then retry.");
  const self = selves[0];
  const me = lib.targetOf(self);
  const mine = reg.workhorses.filter((w) => w.orchestrator_target === me);
  if (mine.length === 0) return null; // not an orchestrator ⇒ inert
  const roster = lib.joinRoster(live.sessions, mine, lib.readStateRows(root));
  if (!roster) return incomplete("fleet state or roster could not be read", "Inspect the fleet registry and state files before retrying.");
  const text = lib.rosterText(roster);
  if (!text) return incomplete("registered fleet roster could not be rendered", "Inspect node .claude/bin/fleet-roster.mjs status before retrying.");

  // Change-only injection, keyed per SESSION (two orchestrators share the state dir).
  const digest = crypto.createHash("sha256").update(text, "utf8").digest("hex");
  const marker = path.join(root, `roster-injected-${me.replace(":", "-")}.json`);
  try {
    const prev = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (prev && prev.digest === digest) return null;
  } catch {
    /* no marker yet ⇒ inject */
  }
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ digest, ts: Math.floor(Date.now() / 1000) }) + "\n");
  } catch {
    /* marker write is best-effort; worst case is one repeated injection */
  }
  return { text };
}

async function hookMain() {
  const deadlineMs = Date.now() + 3600;
  const timer = setTimeout(() => {
    try { process.stdout.write(JSON.stringify({ continue: true, systemMessage: "Fleet roster input timed out. Retry with a complete hook payload." }) + "\n"); }
    finally { process.exit(1); }
  }, 4500);
  try {
    const payload = await readStdinBounded({ fallback: null });
    if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.hook_event_name === "UserPromptSubmit") {
      const result = run(deadlineMs);
      if (result) process.stdout.write(JSON.stringify({
        continue: true,
        ...(result.text ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: result.text } } : {}),
        ...(result.notice ? { systemMessage: result.notice } : {}),
      }) + "\n");
    } else {
      process.stdout.write(JSON.stringify({ continue: true, systemMessage: incomplete("input unavailable or malformed", "Retry with a UserPromptSubmit hook payload.").notice }) + "\n");
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ continue: true, systemMessage: incomplete(lib.sanitizeField(error.message), "Inspect fleet state and filesystem access before retrying.").notice }) + "\n");
  } finally {
    clearTimeout(timer);
  }
  process.exit(0);
}

module.exports = { hookMain };

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
 *       "<main-checkout>/.claude/learning/fleet/roster-injected-<pid>-<started_at>.json"
 *     ],
 *     "network": false,
 *     "spawns": [
 *       "git",
 *       "csq"
 *     ]
 *   },
 *   "idempotent": true,
 *   "may_rewrite_input": false,
 *   "notes": "fs_writes: creates fleet root and writes a per-session digest/timestamp marker; read failure permits context and write failure can repeat it. This legacy unsigned mechanism remains OPEN pending signed-log S2 under ROOT0785c20a (.claude/hooks/fleet-roster-inject.js:44-59). idempotent:true: matching digest returns before marker write (.claude/hooks/fleet-roster-inject.js:45-55). spawns:[git,csq], network:false: resolution may probe git and this hook only lists sessions, never sends or opens a connection (.claude/hooks/fleet-roster-inject.js:26-34; .claude/hooks/lib/fleet-dispatch.js:334-341,502-540). UserPromptSubmit injects changed roster as additionalContext; unavailable facts and malformed payload emit stderr plus continue:true/systemMessage, while no fleet, non-orchestrator and unchanged digest remain healthy no-ops. No updatedInput means may_rewrite_input:false (.claude/hooks/fleet-roster-inject.js:18-42,49,62-85). The invocation-local4500ms fallback covers asynchronous stdin only and emits continue:true/exit1; synchronous resolution/list use a shared absolute3600ms deadline and explicit child timeout caps (.claude/hooks/fleet-roster-inject.js:26-32,62-83; .claude/hooks/lib/fleet-dispatch.js:502-540). Registry6s/on_incomplete:continue and inherited on_timeout:continue make no host-kill claim (.claude/hooks/dispatch-registry.json:801-805). Workflow override authority belongs only to inline script headers; other tools require the strict ROLE-first unbroken header within its first 4 header lines (.claude/hooks/fleet-dispatch-broker.js:65-88; .claude/hooks/lib/fleet-dispatch.js:154-176)."
 * }
 */
