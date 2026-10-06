#!/usr/bin/env node
"use strict";

/**
 * todo-durable-guard.js — bind the Work Ledger's ingest to the DURABLE todo
 * surface, structurally.
 *
 * @hook-event: PostToolUse:Edit|Write|NotebookEdit (telemetry) — a write to the durable
 *   todo surface is the moment its state changes, so this is the cheapest point to record
 *   the transition. It RECORDS and never gates: the payload is only an early-exit signal,
 *   and the state itself always comes from the tracked tree.
 * @hook-event: SessionStart (telemetry) — the backstop. A lifecycle move made by `git mv`,
 *   a rebase, or a sibling's merge produces NO tool call, so a producer bound only to the
 *   write event would miss it; the sweep catches whatever the write event could not see.
 * @hook-event: SessionEnd (telemetry) — the same backstop at the other boundary, so work
 *   done late in a session is recorded rather than waiting for the next SessionStart.
 *
 * WHY THREE EVENTS AND NOT ONE. The producer this replaces had exactly ONE
 * trigger (`PostToolUse:TodoWrite`), that tool went off-by-default on current
 * models, and the ledger recorded nothing for months while every surface reported
 * healthy. The lesson is not "pick a better trigger" — it is that a single
 * load-bearing trigger is the defect. `todo-durable.js` reports CURRENT state and
 * the diff appends only what changed, so these three events are REDUNDANT rather
 * than duplicative: any one of them catches what the others missed, all three
 * firing costs nothing, and all three failing still leaves the next session's
 * sweep to catch up. Nothing here is load-bearing alone.
 *
 * WHY IT SWEEPS RATHER THAN READS THE TOOL CALL. The `PostToolUse` payload names
 * ONE path, but a lifecycle move is a delete plus a create — and a `git mv`, a
 * Bash `mv`, a rebase or a sibling's merge produce no tool call at all. Reading
 * the payload would bind us to the writers that happen to use Edit/Write, which is
 * the same shape of assumption that just failed. The payload is used ONLY as a
 * cheap early-exit signal; the STATE always comes from the tracked tree.
 *
 * FAIL OPEN ON EVERY UNKNOWN (`cc-artifacts.md` Rule 7). This hook records; it
 * never gates. A bug here must never be able to stop an operator working, so every
 * unresolved branch returns a bare `{"continue":true}` and every append failure is
 * surfaced as ADVISORY, never as a refusal.
 */

const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TIMEOUT_MS = 4000;

/** Bare passthrough — the shape every unknown resolves to. */
function passthrough() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
}

// The fallback fires before any slow path can hang the session. It emits a BARE
// passthrough with NO finding: a timeout is an UNKNOWN, and a hook that claimed
// "no transitions" on timeout would be asserting a measurement it never took.
let timer = null;

/**
 * Tracked todo files only — untracked reaches no sibling and survives no clone
 * (`burndown-traceability.md` MUST-2's durability bar).
 *
 * ENVELOPED, and the reason is specific rather than ceremonial: this call decides
 * WHICH repository's todo surface becomes the ledger's work-state. A literal `git`
 * resolves through an attacker-influenceable PATH, and an inherited `GIT_DIR`
 * outranks repository discovery — so an un-enveloped `ls-files` here would happily
 * enumerate ANOTHER repository's todos and this hook would sign them into THIS
 * repo's ledger as its own. The loom#1471 G1 ratchet exists for exactly this, and
 * it caught this call before it shipped.
 *
 * The binary and env resolve OUTSIDE the try, so an unresolvable envelope THROWS
 * to the caller (which fails open to a bare passthrough) rather than degrading to
 * an ambient git whose answer nobody can attribute.
 */
function trackedTodoFiles(repoDir) {
  const { resolveGitBinary, gitEnvForArgs } = require("./lib/git-subprocess-env.js");
  const bin = resolveGitBinary();
  if (!bin) throw new Error("no git binary on a trusted path");
  const args = ["ls-files", "workspaces/*/todos/**"];
  const out = execFileSync(bin, args, {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: gitEnvForArgs(args),
  });
  return out.split("\n").filter(Boolean);
}

/** Cheap early-exit: does this PostToolUse payload plausibly touch the surface? */
function touchesTodoSurface(payload) {
  const ti = (payload && payload.tool_input) || {};
  const candidates = [ti.file_path, ti.path, ti.notebook_path].filter((s) => typeof s === "string");
  return candidates.some((p) => p.includes("/todos/") || p.startsWith("workspaces/"));
}

async function main() {
  let payload = {};
  try {
    const { readStdinBounded } = require("./lib/read-stdin-bounded.js");
    payload = (await readStdinBounded()) || {};
  } catch {
    return passthrough();
  }

  const event = String(payload.hook_event_name || "");
  const isSweep = event === "SessionStart" || event === "SessionEnd";
  // On a PostToolUse we only pay for the sweep when the write plausibly touched
  // the surface. On a sweep event we always pay — that is what makes it a backstop.
  if (!isSweep && !touchesTodoSurface(payload)) return passthrough();

  let lib;
  let events;
  try {
    lib = require("./lib/todo-durable.js");
    events = require("./lib/burndown-events.js");
  } catch {
    return passthrough();
  }

  const repoDir = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : PROJECT_DIR;

  let scan;
  try {
    scan = lib.scanDurableTodos(() => trackedTodoFiles(repoDir));
  } catch {
    return passthrough();
  }
  if (!scan || scan.ok !== true) return passthrough();

  // The KNOWN state comes from the SHARED fold, never a second walk of the log.
  // Two folds disagreeing about which event wins is the drift class the whole
  // log/projection split exists to close, so this consumes `foldProjection`
  // rather than re-deriving last-wins semantics here.
  let known = new Map();
  // The fold's skips, rendered BY CLASS. A bare `skipped.length` reported a valid
  // proposal awaiting its owner countersignature as an UNREADABLE line; the class is
  // set at the producer (`burndown-events.js::partitionSkips`) and rendered by
  // `todo-durable.js::describeFoldSkips`, so this hook never guesses it from prose.
  let skipLines = [];
  try {
    const fs = require("node:fs");
    const abs = path.join(repoDir, events.EVENTS_REL);
    if (fs.existsSync(abs)) {
      const p = events.foldProjection(fs.readFileSync(abs, "utf8"));
      skipLines = lib.describeFoldSkips(events.partitionSkips(p));
      for (const [id, row] of p.rows) known.set(id, row.status);
    }
  } catch {
    return passthrough();
  }

  const diff = lib.diffTransitions(scan, known);
  if (!diff || diff.ok !== true) return passthrough();
  if (diff.transitions.length === 0 && skipLines.length === 0) return passthrough();

  // Identity is required to append. An unrostered operator is NOT an error here —
  // it simply cannot sign, so the transitions stay unrecorded and that fact is
  // SURFACED rather than swallowed. Silently dropping them is how a ledger comes
  // to read empty while work happens.
  let identity = null;
  let signOpts = null;
  let identityWhy = null;
  try {
    const { resolveIdentity, _discoverSigningKey } = require("./lib/operator-id.js");
    const id = resolveIdentity(repoDir);
    // The KEY is discovered separately from the IDENTITY, and both are required.
    // Omitting this was a real defect caught end-to-end: with identity alone every
    // append was REFUSED with `keyType:ssh requires non-empty opts.keyPath`, so the
    // hook detected 99 transitions and recorded none. The refusal was surfaced
    // rather than swallowed, which is the only reason it was visible at all.
    const key = _discoverSigningKey(repoDir, {});
    if (!id || !id.verified_id || !id.person_id) {
      identityWhy = !id
        ? "no identity resolved"
        : !id.verified_id
          ? "no verified_id (no signing key configured)"
          : "no person_id (un-rostered — run /whoami --register)";
    } else if (!key || !key.keyPath) {
      identityWhy = "no signing key discovered (set `git config user.signingkey`)";
    } else {
      identity = { verified_id: id.verified_id, person_id: id.person_id, display_id: id.display_id };
      signOpts = { keyType: key.keyType, keyPath: key.keyPath };
    }
  } catch (err) {
    identityWhy = `identity/key resolution threw: ${(err && err.message) || String(err)}`;
  }

  // ONE predicate, used by BOTH the append loop and the report below.
  //
  // These were two separate conditions and the gap between them was a silent
  // no-op: the loop required `person_id`, the warning only checked `verified_id`,
  // so an identity carrying one but not the other skipped the append AND skipped
  // the notice — the ledger stayed empty and nothing said so. That is precisely
  // the absence-reads-as-clean failure this whole module exists to prevent,
  // reproduced inside its own guard. Caught by an end-to-end run against a scratch
  // tree; a unit test of the pure logic could not have seen it, because the defect
  // lived in the wiring rather than the logic.
  const canSign = !!(identity && signOpts);
  const appended = [];
  const refused = [];
  const deferred = [];
  // A DEADLINE inside the 4000 ms fallback. 99 signed appends is a realistic first
  // run, and racing the fallback would drop the tail under a bare
  // `{"continue":true}` — a silent truncation that reads exactly like "there was
  // nothing more to record". The tail is REPORTED instead, and the next sweep
  // picks it up because the diff is idempotent.
  const deadline = Date.now() + 3000;
  if (canSign) {
    for (const t of diff.transitions) {
      if (Date.now() > deadline) {
        deferred.push(t.item_id);
        continue;
      }
      const item = scan.declared.get(t.item_id);
      let r;
      try {
        r = events.appendEvent(
          repoDir,
          events.buildEvent({
            kind: "transition",
            item_id: t.item_id,
            item: (item && item.rel) || t.item_id,
            value_anchor: `\`${t.rel}\``,
            status: t.status,
            // An agent may NEVER assign an owner-vocabulary status; `validateEvent`
            // refuses a non-owner transition outside the `todo:` namespace, and this
            // is the half of that contract the caller owns.
            authority: "agent",
            source: "todo-durable-guard",
          }),
          { identity, signOpts },
        );
      } catch (err) {
        r = { ok: false, reason: (err && err.message) || "append threw" };
      }
      if (r && r.ok) appended.push(t.item_id);
      else refused.push({ id: t.item_id, reason: (r && (r.reason || r.error)) || "unknown" });
    }
  }

  const lines = [];
  if (appended.length) lines.push(`Recorded ${appended.length} durable todo transition(s).`);
  if (!canSign && diff.transitions.length > 0) {
        lines.push(
      `${diff.transitions.length} transition(s) went UNRECORDED: ${identityWhy || "identity unavailable"}. ` +
        `Run /whoami --register. This is stated rather than dropped — an unrecorded transition ` +
        `and an absent one are the same bytes to every later reader.`,
    );
  }
  if (refused.length) {
    lines.push(
      `${refused.length} transition(s) REFUSED by the append gate: ` +
        refused.slice(0, 3).map((r) => `${r.id} (${r.reason})`).join("; "),
    );
  }
  if (deferred.length) {
    lines.push(
      `${deferred.length} transition(s) were NOT recorded this run: the 3000 ms append deadline was ` +
        `reached. They are DEFERRED, not lost — the diff is idempotent, so the next sweep records ` +
        `them. Stated rather than truncated silently, because a dropped tail reads exactly like ` +
        `"there was nothing more to record".`,
    );
  }
  if (scan.collisions.length) {
    lines.push(
      `${scan.collisions.length} id collision(s) — two files claim one identity; ` +
        `neither was recorded, because picking a winner nobody declared is worse than reporting it.`,
    );
  }
  // Unreadable and unclassified lines are always among these; a pending proposal is
  // named as awaiting activation, never as an unreadable line.
  lines.push(...skipLines);
  if (!lines.length) return passthrough();

  try {
    const { instructAndWait } = require("./lib/instruct-and-wait.js");
    const emitted = instructAndWait({
      severity: "advisory",
      hookEvent: event || "PostToolUse",
      rule_id: "knowledge-convergence/MUST-1",
      what_happened: lines[0],
      why:
        `The Work Ledger's ingest is bound to the DURABLE todo surface (todos/active -> ` +
        `todos/completed), not to a tool call. This hook RECORDS; it never gates.`,
      agent_must_report: lines,
    });
    process.stdout.write(JSON.stringify(emitted.json) + "\n");
  } catch {
    return passthrough();
  }
  clearTimeout(timer);
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). It arms the fallback timer the
// file used to arm at load time, then runs main() with the SAME catch handler.
function hookMain() {
  timer = setTimeout(() => {
    try {
      passthrough();
    } catch {
      /* nothing left to do */
    }
    process.exit(0);
  }, TIMEOUT_MS);
  timer.unref?.();
  return main().catch(() => passthrough());
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
