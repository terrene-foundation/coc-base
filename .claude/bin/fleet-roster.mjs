#!/usr/bin/env node
/**
 * fleet-roster.mjs — the registration surface of the fleet dispatch engine
 * (`.claude/hooks/lib/fleet-dispatch.js`; E1 fleet operating model × E3 hook boundary).
 *
 * This CLI is the ONLY writer of `<stateDir>/fleet/registry.json` — the file that says
 * which live csq sessions are a fleet's workhorses and which orchestrator each reports to.
 * Hooks read it; only this command writes it, so "is this session a workhorse" is an
 * explicit, reviewable act, never an inference.
 *
 * Usage:
 *   node .claude/bin/fleet-roster.mjs register <name|pid:started_at> [--orchestrator <name|pid:started_at>]
 *        [--lane <lane>] [--last <item>]
 *   node .claude/bin/fleet-roster.mjs unregister <name|pid:started_at>
 *   node .claude/bin/fleet-roster.mjs status [--json]
 *
 * registration DEFAULTS the orchestrator to THIS session (the command runs inside the
 * orchestrator that owns the workhorse). `--lane` binds the workhorse's queue source: the
 * open durable todos carrying `lane: <lane>` under `workspaces/<ws>/todos/active/` — the
 * SAME binding `rules/wip-discipline.md` MUST-9 measures. Without `--lane` the workhorse
 * still appears in rosters but never reports idle (its queue is UNKNOWN, and an unknown
 * queue must not be reported as 0 — see `countBoundItems`).
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const lib = require("../hooks/lib/fleet-dispatch.js");
const CLI_DEADLINE_MS = 30000;
const CLI_LIST_TIMEOUT_MS = 10000;

function usage(code) {
  console.error(
    [
      "usage: fleet-roster.mjs register <name|pid:started_at> [--orchestrator <name|pid:started_at>] [--lane <lane>] [--last <item>]",
      "       fleet-roster.mjs unregister <name|pid:started_at>",
      "       fleet-roster.mjs status [--json]",
      "Supported: darwin/linux; Windows fleet placement is inert without UID-based executable ownership verification.",
      "Install csq in an owner-controlled absolute PATH directory such as ~/.local/bin, outside the repository; non-sticky ancestors must not be group- or world-writable (.claude/hooks/lib/fleet-dispatch.js:453-497).",
    ].join("\n"),
  );
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "json") out.flags.json = true;
      else out.flags[key] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

function needRoot() {
  const root = lib.stateRoot({ deadlineMs: cliDeadlineMs });
  if (!root) {
    console.error("fleet-roster: the trust-state root is indeterminate; refusing to guess where state lives.");
    process.exit(2);
  }
  return root;
}

function liveSessionsOrDie() {
  const live = lib.liveSessions({ timeoutMs: CLI_LIST_TIMEOUT_MS, deadlineMs: cliDeadlineMs });
  if (!live.ok) {
    const diagnostic = live.diagnostic;
    console.error(diagnostic ? "fleet-roster: " + diagnostic.reason + " — " + diagnostic.remedy : "fleet-roster: `csq sessions list --json` failed; is csq installed and the daemon running?");
    process.exit(2);
  }
  return live.sessions;
}

function resolveOrDie(sessions, ref, what) {
  const s = lib.resolveSessionRef(sessions, ref);
  if (!s) {
    console.error(`fleet-roster: ${what} '${ref}' does not resolve to exactly ONE live session (csq sessions list).`);
    process.exit(2);
  }
  return s;
}

const { _: pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos[0];
if (!cmd) usage(2);
const cliDeadlineMs = Date.now() + CLI_DEADLINE_MS;

if (cmd === "register") {
  const ref = pos[1];
  if (!ref) usage(2);
  const root = needRoot();
  const sessions = liveSessionsOrDie();
  const workhorse = resolveOrDie(sessions, ref, "workhorse");
  const orchestrator = flags.orchestrator
    ? resolveOrDie(sessions, flags.orchestrator, "orchestrator")
    : sessions.find((s) => s.self === true);
  const self = sessions.find((s) => s.self === true);
  if (!orchestrator || !self || lib.targetOf(self) !== lib.targetOf(orchestrator)) {
    console.error("fleet-roster: only the live orchestrator session may register its own fleet.");
    process.exit(2);
  }
  const reg = lib.readRegistry(root);
  if (!reg) { console.error("fleet-roster: registry UNKNOWN; refusing mutation."); process.exit(2); }
  const target = lib.targetOf(workhorse);
  const existing = reg.workhorses.find((w) => w.target === target);
  if (target === lib.targetOf(self) || (existing && existing.orchestrator_target !== lib.targetOf(self))) {
    console.error("fleet-roster: cannot register self or reassign another orchestrator's workhorse.");
    process.exit(2);
  }
  const row = {
    name: workhorse.name || workhorse.label || target,
    target,
    surface: workhorse.surface || "?",
    orchestrator_target: lib.targetOf(orchestrator),
    lane: flags.lane || null,
    last_item: flags.last || null,
    registered_at: Math.floor(Date.now() / 1000),
  };
  reg.workhorses = reg.workhorses.filter((w) => w.target !== target).concat([row]);
  lib.writeRegistry(root, reg);
  console.log(`registered ${row.name} (${row.target}) → orchestrator ${row.orchestrator_target}${row.lane ? ` · lane ${row.lane}` : ""}`);
} else if (cmd === "unregister") {
  const ref = pos[1];
  if (!ref) usage(2);
  const root = needRoot();
  const sessions = liveSessionsOrDie();
  const reg = lib.readRegistry(root);
  if (!reg) { console.error("fleet-roster: registry UNKNOWN; refusing mutation."); process.exit(2); }
  if (reg.workhorses.length === 0) {
    console.log("nothing registered");
    process.exit(0);
  }
  const s = lib.resolveSessionRef(sessions, ref);
  const matches = reg.workhorses.filter((w) => s ? w.target === lib.targetOf(s) : w.target === ref || w.name === ref);
  const self = sessions.find((session) => session.self === true);
  if (!self || matches.length !== 1 || matches[0].orchestrator_target !== lib.targetOf(self)) {
    console.error("fleet-roster: only the live owning orchestrator may unregister one unambiguous workhorse.");
    process.exit(2);
  }
  const target = matches[0].target;
  const before = reg.workhorses.length;
  reg.workhorses = reg.workhorses.filter((w) => w.target !== target);
  if (reg.workhorses.length === before) {
    console.error(`fleet-roster: '${ref}' is not registered.`);
    process.exit(2);
  }
  lib.writeRegistry(root, reg);
  console.log(`unregistered ${ref}`);
} else if (cmd === "status") {
  const root = needRoot();
  const reg = lib.readRegistry(root);
  const sessions = liveSessionsOrDie();
  const roster = reg ? lib.joinRoster(sessions, reg.workhorses, lib.readStateRows(root)) : null;
  if (!roster) {
    console.error("fleet-roster: roster UNKNOWN; registry, live sessions, or state could not be validated.");
    process.exit(2);
  }
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, state_root: root, roster }, null, 2));
  } else if (roster.length === 0) {
    console.log("no workhorses registered");
  } else {
    console.log(lib.rosterText(roster));
  }
} else {
  usage(2);
}
