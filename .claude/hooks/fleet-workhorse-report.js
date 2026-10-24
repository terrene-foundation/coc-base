#!/usr/bin/env node
/**
 * fleet-workhorse-report.js — part (1) of the fleet dispatch engine (`lib/fleet-dispatch.js`):
 * the IDLE REPORT, plus its busy half.
 *
 * @hook-event: Stop (lifecycle) — THE TURN BOUNDARY IS THE SUBJECT. "Idle" is a property of the
 *   moment a workhorse's turn ends with nothing bound to it; no tool call marks it, so no
 *   PreToolUse hook can fire on it. `Stop` does, for both CLIs (`codex-hook-runtime.js
 *   --native-event Stop` is registered in `.codex/hooks.json`; this hook rides that projection).
 * @hook-event: UserPromptSubmit (lifecycle) — a NEW TURN is the busy transition. The workhorse
 *   was idle, it got woken (a csq brief, the operator), it is now working; without this row the
 *   fold would hold a stale `idle` for the whole task and the orchestrator's broker would refuse
 *   launches citing a workhorse that is already busy.
 *
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./lib/fleet-dispatch.js");
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

function eventOf(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  return p.hook_event_name === "Stop" || p.hook_event_name === "UserPromptSubmit" ? p.hook_event_name : null;
}

function incomplete(reason, remedy) {
  const notice = "fleet workhorse report incomplete: " + lib.sanitizeField(reason, 512) + ". " + lib.sanitizeField(remedy, 512);
  process.stderr.write(notice + "\n");
  return notice;
}

function run(event, deadlineMs) {
  const root = lib.stateRoot({ deadlineMs });
  if (!root) return incomplete("fleet learning root unresolved", "Restore the checkout learning-state boundary, then retry the report.");
  const reg = lib.readRegistry(root);
  if (!reg) return incomplete("fleet registry unreadable: " + root + "/registry.json", "Inspect node .claude/bin/fleet-roster.mjs status and repair or re-register its workhorses.");
  if (reg.workhorses.length === 0) return;
  const live = lib.liveSessions({ deadlineMs });
  if (!live.ok) return incomplete(live.diagnostic?.reason || "csq list failed or timed out", live.diagnostic?.remedy || "Restore csq sessions list --json --here, then retry.");
  const selves = live.sessions.filter((s) => s.self === true);
  if (selves.length !== 1) return incomplete("csq did not verify exactly one self", "Restore csq sessions list --json --here with one verified self, then retry.");
  const self = selves[0];
  const me = lib.targetOf(self);
  const row = reg.workhorses.find((w) => w.target === me);
  if (!row) return; // this session is not a registered workhorse
  const label = row.name || self.name || self.label || me;

  if (event !== "Stop" && event !== "UserPromptSubmit") return;
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, `report-lock-${me.replace(":", "-")}`);
  try { fs.mkdirSync(lock); } catch {
    if (event === "UserPromptSubmit") {
      try { fs.writeFileSync(path.join(root, `state-unknown-busy-overlap-${me.replace(":", "-")}`), "busy event overlapped report\n", { flag: "wx", mode: 0o600 }); }
      catch { /* filesystem unavailable ⇒ no durable invalidation possible */ }
    }
    return incomplete("report lock unavailable", "Inspect the fleet report state before retrying; unsigned lock recovery remains pending signed-log migration.");
  }
  let release = true;
  try {
    if (event === "UserPromptSubmit") {
      const result = lib.appendStateRow(root, { event: "busy", target: me, name: label, queue: null, last: null });
      if (!result.ok) return incomplete("busy state append failed", "Restore fleet-state filesystem writes, then retry the busy transition.");
      return;
    }
    const repoDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const queue = lib.countBoundItems(repoDir, row.lane);
    if (queue === null) return incomplete("bound queue could not be read", "Restore the lane queue files, then retry the report.");
    const rows = lib.readStateRows(root, me);
    if (!rows) return incomplete("own workhorse state is unknown or unreadable", "Inspect the fleet state and restore known state before retrying; this report has not been sent.");
    const prev = lib.foldState(rows, me);
    if (queue === 0) {
      if (prev.state === "idle") return;
      const last = row.last_item || "-";
      const sent = lib.sendMessage(row.orchestrator_target, lib.renderIdleMessage(label, last), { sessions: live.sessions, deadlineMs });
      if (!sent.ok) return incomplete(sent.diagnostic?.reason || "csq report send failed", sent.diagnostic?.remedy || "Restore the orchestrator csq target, then retry the report.");
      const result = lib.appendStateRow(root, { event: "idle", target: me, name: label, queue: 0, last });
      if (!result.ok) {
        release = false;
        try { fs.writeFileSync(path.join(root, `state-unknown-delivered-${me.replace(":", "-")}`), "delivered report not recorded\n", { flag: "wx", mode: 0o600 }); }
        catch { /* retained lock also prevents a duplicate send */ }
        return incomplete("report delivered but idle state append failed", "Do not resend blindly; inspect fleet state and the retained report lock before retrying.");
      }
    } else {
      const result = lib.appendStateRow(root, { event: "busy", target: me, name: label, queue, last: null });
      if (!result.ok) return incomplete("busy state append failed", "Restore fleet-state filesystem writes, then retry the busy transition.");
    }
  } finally {
    if (release) fs.rmdirSync(lock);
  }
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND in-process
// by lib/hook-engine.js (dispatch.js). No load-time side effects.
async function hookMain() {
  const deadlineMs = Date.now() + 3600;
  const timer = setTimeout(() => {
    try { process.stdout.write(JSON.stringify({ continue: true, systemMessage: "Fleet workhorse report input timed out. Retry with a complete hook payload." }) + "\n"); }
    finally { process.exit(1); }
  }, 4500);
  let notice;
  try {
    const event = eventOf(await readStdinBounded({ fallback: null }));
    notice = event ? run(event, deadlineMs) : incomplete("input unavailable or malformed", "Retry with a Stop or UserPromptSubmit hook payload.");
  } catch (error) {
    notice = incomplete(lib.sanitizeField(error.message), "Inspect fleet state and filesystem access before retrying.");
  } finally {
    clearTimeout(timer);
  }
  if (notice) process.stdout.write(JSON.stringify({ continue: true, systemMessage: notice }) + "\n");
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
 *       "<main-checkout>/.claude/learning/fleet/state.jsonl",
 *       "<main-checkout>/.claude/learning/fleet/report-lock-<pid>-<started_at>/",
 *       "<main-checkout>/.claude/learning/fleet/state-unknown-busy-overlap-<pid>-<started_at>",
 *       "<main-checkout>/.claude/learning/fleet/state-unknown-delivered-<pid>-<started_at>",
 *       "<main-checkout>/.claude/learning/fleet/state-unknown-busy-intent-<pid>-<started_at>-<uuid>"
 *     ],
 *     "network": false,
 *     "spawns": [
 *       "git",
 *       "csq"
 *     ]
 *   },
 *   "idempotent": false,
 *   "may_rewrite_input": false,
 *   "notes": "fs_writes: creates fleet root and report-lock directory; overlapping prompts attempt a busy-overlap marker. Successful send plus failed idle append retains the lock and attempts a delivered marker. These legacy unsigned mechanisms remain OPEN pending signed-log S2 under ROOT0785c20a (.claude/hooks/fleet-workhorse-report.js:50-89). Busy and idle append state.jsonl; busy creates a target-scoped intent marker first and removes it after success (.claude/hooks/fleet-workhorse-report.js:61-86; .claude/hooks/lib/fleet-dispatch.js:381-401). idempotent:false: accepted prompts append busy; Stop dedupes known idle (.claude/hooks/fleet-workhorse-report.js:61-86). spawns:[git,csq], network:false: resolution may probe git, one live-session list validates the target for the send child, and this process opens no connection (.claude/hooks/fleet-workhorse-report.js:34-44,75; .claude/hooks/lib/fleet-dispatch.js:334-341,502-549). Stop/UserPromptSubmit failures emit stderr and continue:true/systemMessage at exit0 without input rewrite, so may_rewrite_input:false; healthy no-fleet, non-workhorse and known-idle paths remain ordinary no-ops (.claude/hooks/fleet-workhorse-report.js:27-46,73,95-111). The invocation-local4500ms fallback covers asynchronous stdin only and emits continue:true/exit1; synchronous resolution/list/send use a shared absolute3600ms deadline and explicit child timeout caps (.claude/hooks/fleet-workhorse-report.js:34-40,75,95-110; .claude/hooks/lib/fleet-dispatch.js:502-549). Registry Stop10s/UPS6s/on_incomplete:continue and inherited on_timeout:continue make no host-kill claim (.claude/hooks/dispatch-registry.json:629-633,808-812). Reporter reads explicitly target csq-verified me, so self invalidation returns before send while empty known history and unrelated-worker invalidation remain usable (.claude/hooks/fleet-workhorse-report.js:41-45,69-76; .claude/hooks/lib/fleet-dispatch.js:359-379). Workflow override authority belongs only to inline script headers; other tools require the strict ROLE-first unbroken header within its first 4 header lines (.claude/hooks/fleet-dispatch-broker.js:65-88; .claude/hooks/lib/fleet-dispatch.js:154-176)."
 * }
 */
