#!/usr/bin/env node
/**
 * @hook-event: SessionStart (lifecycle) — EVERY session start is the subject: any start
 *   (startup, resume, clear, compact) begins a context that did not compute the terminal's
 *   recorded boundary, so the activity marker is replaced on every source and stamped with
 *   the new session_id (a consumer then refuses the old readiness). `clear` and `compact`
 *   are additionally the two context BOUNDARIES of the autonomous context cycle
 *   (workspaces/context-budget-2026-10-10/design/CYCLE.md §1.2 step 6, §1.5–§1.6): only
 *   for an explicit `source` of clear|compact is the handover SEED (and, on `compact`, the
 *   mechanical snapshot) injected; startup/resume/absent inject NOTHING (a new terminal is
 *   not a continuation and a seed would be someone else's state).
 *
 * Hook: compaction-handoff-inject
 * Event: SessionStart (no matcher — every source; injection fenced to clear|compact in code)
 * Purpose:
 *   0. On EVERY source: replace this terminal's activity marker with the payload's
 *      session_id (lib/context-meter.js § ACTIVITY) — before the source fence.
 *   1. THE SEED (lib/boundary-seed.js). Look up THIS TERMINAL's pending seed in its
 *      `coc-context-state/v1` record (lookup by terminal: after `/clear` the session id
 *      is new, the terminal's config dir is not), verify containment + sha256 +
 *      re-validation, and inject it FIRST, DATA-wrapped, ≤ 9,000 chars; record
 *      `resume.injected` (and the token the resumed agent must echo) under the state
 *      lock. A failed check injects a ONE-LINE banner naming the path — never the seed.
 *   2. On `compact`, the mechanical pre-compaction snapshot plus the ledger's tail, with
 *      a LOUD banner when it is missing, corrupt, stale or incomplete. When a NON-
 *      emergency seed was injected, that block is replaced by a one-line pointer (the
 *      seed is the only large block; CYCLE.md §1.6).
 *
 * ABSENCE IS LOUD (`conservation-gate.md` MUST-4). On `clear` and `compact` this hook
 * ALWAYS emits a block: with no pending seed it says so in one line.
 *
 * Exit Codes:
 *   0 = success (always — SessionStart cannot block; its exit 2 is a
 *       user-facing error only)
 *   1 = the timeout fallback fired
 */

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [
 *       "~/<claude-config-dir>/coc-context-state.json",
 *       "~/<claude-config-dir>/coc-context-state.json.lock",
 *       "~/<claude-config-dir>/coc-context-state.json.tmp-<suffix>",
 *       "~/<claude-config-dir>/coc-context-state.activity.json",
 *       "~/<claude-config-dir>/coc-context-state.activity.json.tmp-<suffix>",
 *       ".claude/learning/context-state/<terminal-key>.json",
 *       ".claude/learning/context-state/<terminal-key>.json.lock",
 *       ".claude/learning/context-state/<terminal-key>.json.tmp-<suffix>",
 *       ".claude/learning/context-state/<terminal-key>.activity.json",
 *       ".claude/learning/context-state/<terminal-key>.activity.json.tmp-<suffix>",
 *       ".claude/learning/handover-declared/<session_id>.json"
 *     ],
 *     "network": false,
 *     "spawns": ["git", "ps"]
 *   },
 *   "idempotent": false,
 *   "may_rewrite_input": false,
 *   "notes": "Reads the snapshot file, the ledger files, the receipt directory, this terminal's context-state record and the seed file it names (contained, O_NOFOLLOW, <= 8000 bytes). Its writes are the context-state record's handover/boundary/resume keys, read-modify-write under lib/context-meter.js::withStateLock, and only when a seed was injected; after a recorded injection it also REMOVES that seed's declared-handover file (.claude/learning/handover-declared/<session_id>.json, only when it names the injected seed — context-state.js::consumeDeclaredHandover). spawns: `git` through lib/state-resolver.js (main-checkout resolution). NOT idempotent: each injection increments resume.attempts, and after 2 unverified injections of one seed it injects a banner instead."
 * }
 */

const path = require("path");
const {
  readSnapshotFile,
  readLedger,
  renderHandoff,
  resolveHandoffDir,
  resolveLedgerRoots,
} = require("./lib/compaction-handoff.js");
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

const TIMEOUT_MS = 10000;
let _timeout = null;

function hookMain() {
  _timeout = setTimeout(() => {
    // Fail-open: a stall must not cost the session its context. Emit only
    // `continue` — never a half-rendered handoff, which would read as complete.
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    readStdinBounded({ timeoutMs: 2000 })
      .then((payload) => {
        try {
          onPayload(payload);
        } catch (e) {
          return reject(e);
        }
        resolve();
      })
      .catch((e) => {
        // The stdin read itself failed: still answer with JSON (a bare rejection printed
        // nothing, which the host reads as a crashed hook with no reply).
        warn(`stdin read failed (${(e && e.message) || e}); nothing injected`);
        if (_timeout) clearTimeout(_timeout);
        process.stdout.write(JSON.stringify({ continue: true }) + "\n");
        resolve();
        process.exit(1);
      });
  });
}

const BOUNDARY_SOURCES = new Set(["clear", "compact"]);

function warn(msg) {
  try {
    process.stderr.write(`[compaction-handoff] ${msg}\n`);
  } catch {
    /* stderr unavailable */
  }
}

/** Replace this terminal's activity marker for a session start (every source). LOUD on failure. */
function markSessionStartActivity(payload, source) {
  try {
    const CS = require("./lib/context-state.js");
    const cwd = (payload && payload.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const loc = CS.locateState({ configDir: process.env.CLAUDE_CONFIG_DIR, repoDir: cwd, pid: process.ppid });
    const act = CS.markActivity(loc, `SessionStart:${typeof source === "string" ? source.slice(0, 20) : "absent"}`, new Date().toISOString(), { sessionId: payload && payload.session_id });
    if (!act.ok) warn(`activity marker NOT bumped (${act.reason}); ${act.unlinked ? "it was removed, so no earlier readiness can validate" : "an earlier readiness may still validate"}`);
  } catch (e) {
    warn(`activity marker NOT bumped (${(e && e.message) || e}); an earlier readiness may still validate`);
  }
}

function onPayload(payload) {
  const source = payload && payload.source;
  // A session start — ANY source — is ACTIVITY: no readiness computed before it may
  // validate, and the marker now names THIS session (lock-free, before the source fence).
  markSessionStartActivity(payload, source);
  // FAIL-CLOSED (a security round measured an earlier `if (source && source !==
  // "compact")` injecting 644 chars for a payload that carried NO source at all —
  // and `lib/dispatch-main.js` runs every group when the match field is absent).
  // Only an explicit `clear` or `compact` may inject; anything else, missing included,
  // stays silent. The suppression is ANNOUNCED on stderr rather than silent, so a
  // runtime that stops sending `source` is visible instead of quietly losing the
  // handoff (`conservation-gate.md` MUST-4).
  if (!BOUNDARY_SOURCES.has(source)) {
    if (source === undefined) {
      warn("SessionStart payload carried no `source`; NOT injecting (only an explicit source=clear|compact injects). If this runtime stopped sending `source`, the handoff is being lost here.");
    }
    finish(true);
    return;
  }
  const cwd = (payload && payload.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = (payload && typeof payload.session_id === "string" && payload.session_id) || null;
  const dirInfo = resolveHandoffDir(cwd);

  // ── 1. the SEED ─────────────────────────────────────────────────────────────
  const seed = seedSection({ source, cwd, sessionId, dirInfo });

  // ── 2. the mechanical snapshot (compact only) ──────────────────────────────
  let facts = "";
  if (source === "compact") {
    if (seed.injected && !seed.emergency) {
      facts = `[compaction-handoff] the mechanical snapshot for this session stays on disk under ${dirInfo.ok ? dirInfo.dir : ".claude/learning/handoff/"} — the seed above supersedes it; read it only on demand.`;
    } else {
      facts = renderFacts({ cwd, sessionId, dirInfo });
    }
  }

  let text = [seed.text, facts].filter((t) => t && t.trim()).join("\n\n");
  if (seed.injected && seed.BS) {
    // CR-M5: the seed section must stay within the seed cap, or the SessionStart budget
    // stops treating it as the seed. The facts block is on disk in the snapshot already.
    const c = seed.BS.composeSeedSection({
      seedText: seed.block,
      note: seed.note || "",
      facts,
      factsPointer: `[compaction-handoff] the mechanical facts block (${facts.length} chars) did not fit beside the seed and was NOT inlined — read the snapshot under ${dirInfo.ok ? dirInfo.dir : ".claude/learning/handoff/"}.`,
    });
    if (c.factsMoved) warn(`facts block (${facts.length} chars) moved out of the seed section to keep it within ${seed.BS.INJECT_MAX_CHARS} chars`);
    if (c.noteDropped) warn(`seed note dropped from the context to keep the seed section within ${seed.BS.INJECT_MAX_CHARS} chars: ${String(seed.note).trim()}`);
    text = c.text;
  }
  const out = { continue: true, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
  process.stdout.write(JSON.stringify(out) + "\n");
  finish(false);
}

/**
 * The seed block, or the one-line banner that replaces it. Any failure to load the seed
 * libraries is itself a banner (a consumer tree without them must not lose the snapshot
 * half). Returns {text, injected, emergency}.
 */
function seedSection({ source, cwd, sessionId, dirInfo }) {
  let BS;
  let CS;
  let validate = null;
  try {
    BS = require("./lib/boundary-seed.js");
    CS = require("./lib/context-state.js");
  } catch (e) {
    return { text: `[context-seed] seed-libs-missing: the seed libraries could not be loaded (${(e && e.message) || e}); no seed was checked for this ${source}.`, injected: false };
  }
  try {
    validate = require("./lib/handover-seed.js").validateSeed;
  } catch {
    validate = null;
  }
  const loc = CS.locateState({ configDir: process.env.CLAUDE_CONFIG_DIR, repoDir: cwd, pid: process.ppid });
  // (The activity marker was already replaced for this start — onPayload, every source.)
  const st = CS.readState(loc);
  if (st.state === "corrupt") {
    warn(`context state at ${loc.file} is CORRUPT (${st.reason})`);
    return { text: `${BS.BANNER_PREFIX} state-corrupt: this terminal's context-state record is unreadable (${st.reason}) — no seed injected; read .claude/learning/handoff/ and re-derive.`, injected: false };
  }
  const plan = BS.planInjection({ state: st.state === "ok" ? st.data : null, source, dirInfo, validate, nowMs: Date.now() });
  if (plan.kind !== "inject") {
    if (plan.kind === "banner") warn(plan.line);
    recordNoInjection(CS, loc, plan, st.state === "ok" ? st.data : null);
    return { text: plan.line || "", injected: false };
  }
  const block = { ok: true, text: plan.block };
  const nowIso = new Date().toISOString();
  const w = CS.updateContextState(loc, (prev) => {
    const h = prev && prev.handover;
    // Re-checked INSIDE the lock: the record must still name the seed that was verified.
    if (!h || h.seed_sha256 !== plan.read.sha256) return { updated_at: nowIso };
    return BS.injectedFields(prev, { handover: h, sessionId, source, nowIso });
  });
  let note = "";
  if (!w.ok) {
    warn(`resume NOT recorded: ${w.reason}`);
    note = `\n${BS.BANNER_PREFIX} resume-not-recorded: the injection could not be recorded (${w.reason}) — the resume cannot be verified by the orchestrator.`;
  } else if (!(w.data && w.data.resume && w.data.resume.expected_seed_sha256 === plan.read.sha256)) {
    note = `\n${BS.BANNER_PREFIX} resume-not-recorded: the record changed between verification and recording; this injection is NOT recorded.`;
  } else {
    // The next context has started from THIS seed: the declared handover is consumed, so a
    // watcher stops reading it as a pending (possibly stalled) handover.
    const c = CS.consumeDeclaredHandover(dirInfo, plan.handover && plan.handover.session_id, plan.read.sha256);
    if (!c.ok) warn(`declared handover state NOT cleared (${c.reason}) — a watcher may read this handover as still pending`);
  }
  return { text: block.text + note, block: block.text, note, BS, injected: true, emergency: plan.handover.emergency === true };
}

/**
 * A boundary that injected NO seed must not be able to recur: write ready:false, and — for
 * a BANNER (the pending seed was refused) — handover.state "failed" with the code, so the
 * boundary predicate (which needs state "written") cannot re-arm on the same seed and loop
 * as clear-with-no-seed. A new seed Write re-stamps "writing" (context-state.js::
 * observeSeedWrite). Failure to record is LOUD.
 */
function recordNoInjection(CS, loc, plan, data) {
  const nowIso = new Date().toISOString();
  const seedSha = data && data.handover && typeof data.handover.seed_sha256 === "string" ? data.handover.seed_sha256 : null;
  const w = CS.updateContextState(loc, (prev) => {
    const out = {
      updated_at: nowIso,
      boundary: { ...(prev.boundary && typeof prev.boundary === "object" ? prev.boundary : {}), ready: false, committed: false, awaiting_commit: false, idle: false, last_event: "SessionStart", last_event_at: nowIso, reasons: [`no seed injected at this boundary (${plan.code || plan.kind})`] },
    };
    const h = prev.handover;
    if (plan.kind === "banner" && h && typeof h === "object" && ["writing", "written", "injected"].includes(h.state) && h.seed_sha256 === seedSha) {
      out.handover = { ...h, state: "failed", failed_code: String(plan.code || "banner").slice(0, 60), failed_at: nowIso };
    }
    return out;
  });
  if (!w.ok) warn(`no-injection NOT recorded (${w.reason}); a stale boundary may re-arm`);
}

/** The pre-existing snapshot + ledger render (compact only). */
function renderFacts({ cwd, sessionId, dirInfo }) {
  const snapshotRead = dirInfo.ok
    ? readSnapshotFile(dirInfo.dir, { sessionId })
    : { ok: false, finding: "compaction-handoff/snapshot-missing", reason: dirInfo.reason };

  let ledger = { dirs: [], files: [] };
  try {
    ledger = readLedger({ roots: resolveLedgerRoots(cwd) });
  } catch {
    // A ledger read failure must not cost the rest of the handoff; the
    // renderer reports the empty ledger as ABSENT, which is the honest reading
    // of "could not read" in the same shape as "no such file".
  }

  let rendered;
  try {
    rendered = renderHandoff({ snapshotRead, ledger });
  } catch (e) {
    rendered = {
      text: `**compaction-handoff/render-failed — the handoff block could not be rendered (${(e && e.message) || e}). Treat the mechanical half as ABSENT, not as clean.**`,
      banners: [{ finding: "compaction-handoff/render-failed", text: "" }],
    };
  }
  if (rendered.banners && rendered.banners.length) {
    warn(`injected with ${rendered.banners.length} banner(s): ${rendered.banners.map((b) => b.finding).join(", ")}`);
  }
  return rendered.text;
}

function finish(emitContinue) {
  if (_timeout) clearTimeout(_timeout);
  if (emitContinue) process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

module.exports = { hookMain };

if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") {
    require("./lib/hook-engine.js").runCli(hookMain, __filename);
  } else {
    hookMain();
  }
}
