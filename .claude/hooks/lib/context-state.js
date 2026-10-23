"use strict";
/**
 * context-state — the HANDOVER / BOUNDARY / RESUME half of the per-terminal
 * `coc-context-state/v1` record (workspaces/context-budget-2026-10-10/design/CYCLE.md
 * §4.3, shard S1). The meter (lib/context-meter.js) owns tokens/points/band; this module
 * owns `handover`, `boundary`, `resume` and the background-agent ledger `agents`.
 *
 * Owner directive (2026-10-10, verbatim): "this entire pre and post MUST BE AUTONOMOUS,
 * not requiring human intervention at ANY STEP." csq reads the boundary and injects
 * `/clear` on it with no human in the loop — a KILL PATH for in-flight work — so the
 * predicate is the trust boundary and is FAIL-CLOSED.
 *
 * ── HOW READINESS IS MADE (four steps, each able only to say NO) ──────────────
 *   1. The Stop row (hooks/context-boundary.js) computes a CANDIDATE: computeReady over
 *      the record, where the seed is judged by the SAME function that decides whether
 *      the next SessionStart would inject it (lib/boundary-seed.js::planInjection — one
 *      predicate, never two). FIRST, lock-free, it REPLACES the activity marker (so a
 *      ready:true of an EARLIER Stop is void from that instant, even if this row then
 *      times out or never gets the lock); then it writes ready:false + awaiting_commit,
 *      the nonce it WROTE (boundary.activity_nonce), its own session_id
 *      (boundary.session_id), the transcript position (path/offset/inode) at its START,
 *      and the PER-STOP candidate id the dispatcher minted for this Stop
 *      (boundary.candidate_id, from env COC_STOP_CANDIDATE_ID — lib/dispatch-main.js::main).
 *   2. The DISPATCHER, after merging EVERY Stop verdict OF ITS OWN ROWS (lib/dispatch-
 *      main.js::stopBoundaryCommit), commits ready:true ONLY when the merged reply really
 *      ends the turn (no block, no halt, no failed detector, not a stop_hook_active
 *      refire) AND the awaiting candidate carries the id IT minted for this Stop —
 *      commitStopReadiness. A leftover candidate of an earlier Stop is refused.
 *   3. CLAUDE CODE finishes the Stop: Stop hooks registered OUTSIDE the dispatcher (a
 *      terminal's own settings — measured: csq's inbox hook and cc-status) run in
 *      parallel with it and can still BLOCK after the commit. Only when EVERY Stop hook
 *      has completed does Claude Code append ONE `system:stop_hook_summary` record
 *      naming them all, with `hookErrors` (non-empty whenever any hook blocked or failed)
 *      and `preventedContinuation`. MEASURED 2026-10-10 over this repo's 7 main
 *      transcripts on this account (4,304 summaries, hookCount 1–13, incl. 2,311 with the
 *      two external hooks): 0 Stop-hook attachments ordered AFTER their summary; 0
 *      windows holding a hook_blocking_error whose summary had empty hookErrors; 0
 *      blocking windows without a summary. `system:turn_duration` is NOT the terminal: it
 *      is missing after 2,405 of 4,160 clean summaries. A Stop the user INTERRUPTS
 *      (hook_cancelled) writes no summary — 1 measured — so it never reads ready.
 *   4. The CONSUMER (csq) applies boundaryReadyValid: valid only while the lock-free
 *      activity marker still holds boundary.activity_nonce AND names boundary.session_id
 *      (the marker is REPLACED by a prompt, a COMPLETED tool call, EVERY SessionStart
 *      source — startup/resume/clear/compact — and a compaction; see lib/context-
 *      meter.js § ACTIVITY), AND the transcript past the Stop offset holds only quiescent
 *      records, AND at least one stop_hook_summary among them, every one CLEAN. A tool
 *      call that has STARTED but not finished is witnessed by its tool_use record in the
 *      transcript (non-quiescent), not by the marker.
 *
 * Any unknown — absent record, unreadable seed, unscanned transcript — is NOT ready, and
 * the reason is recorded in `boundary.reasons` (a silent false reads exactly like a
 * healthy one; conservation-gate.md MUST-4).
 *
 * EVERY record write goes through lib/context-meter.js::withStateLock as a READ-MODIFY-
 * WRITE (`updateContextState`); the Stop row's transcript scan runs OUTSIDE the lock and
 * is committed under it with a recheck that the ledger it scanned from is still current.
 *
 * BACKGROUND WORK — the producer, MEASURED on this host's transcripts 2026-10-10:
 *   launches (main-thread tool_result + `toolUseResult`):
 *     Agent/Task async  status "async_launched", agentId           → OPEN (key agentId)
 *     Agent teammate    status "teammate_spawned", agent_id        → OPEN
 *     Bash background   input.run_in_background + backgroundTaskId → OPEN (key task id)
 *     a launch whose result `is_error`                             → closed (nothing ran)
 *     an Agent/Task result with status "completed"                 → closed (it ran inline)
 *     ANY other result shape                                       → OPEN, "unrecognized"
 *   ends — a `<task-notification>` in exactly three record forms (147 transcripts read):
 *     {type:"queue-operation", operation:"enqueue"|"remove", content:"<task-notification>…"}
 *     {type:"attachment", attachment:{type:"queued_command", commandMode:"task-notification", prompt:"<task-notification>…"}}
 *     {type:"user", origin:{kind:"task-notification"}, message:{content:"<task-notification>…"}}
 *   Its header lines precede `<summary>`: `<task-id>` (= the launch's agentId /
 *   backgroundTaskId — 9,858 paired notifications, 0 mismatches), an OPTIONAL
 *   `<tool-use-id>` (absent on 5,530 of them) and `<status>`. Pairing: by tool-use-id
 *   when present (and its task-id must agree); else by task-id against exactly ONE open
 *   entry; an unpairable notification closes NOTHING. Text anywhere else — a nested
 *   tool_result, an assistant message, a `<summary>`/`<event>` body — is never parsed.
 *   Background agents KEEP RUNNING across /clear and their notifications arrive in the
 *   post-clear transcript (csq /clear probe, 13 of 13 agents), so the ledger CARRIES
 *   ACROSS a transcript change: the old transcript is finished first, open entries stay
 *   open until their notification appears in the new one.
 *
 * NEVER THROWS from an exported entry point; failures come back as `{ok:false, reason}`.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const meter = require("./context-meter.js");

const HANDOVER_STATES = Object.freeze(["none", "writing", "written", "injected", "consumed", "failed"]);
const SHA256_RE = /^[0-9a-f]{64}$/;
const RESUME_TOKEN_RE = /^[0-9a-f]{8}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
// A seed file is a DIRECT child of the handoff dir with this basename and nothing else.
const SEED_NAME_RE = /^seed-[A-Za-z0-9._-]{1,120}\.md$/;
// The validator's hard cap (lib/handover-seed.js::SEED_HARD_CAP_BYTES). A larger file is
// refused WITHOUT being read whole.
const SEED_READ_CAP_BYTES = 8000;
// Per-Stop transcript scan ceiling (old + new transcript together). A backlog larger than
// this is scanned across Stops; until it is caught up the agent count is UNKNOWN (null).
const SCAN_MAX_BYTES_PER_CALL = 32 * 1024 * 1024;
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_TRACKED_AGENTS = 64;
// Closed entries are kept so a SendMessage can re-open them. Past this many the OLDEST are
// pruned and `agents.pruned` counts them: a SendMessage that then matches nothing is
// treated as re-opening a pruned agent (OPEN, fail closed) instead of being ignored.
const MAX_KNOWN_AGENTS = 512;
// An OPEN entry with no transcript evidence (its launch, a re-open, any notification
// naming it) for this long is SURFACED — code `open-agent-silent` in boundary.reasons and
// boundary.escalations — and still COUNTED as running. 30 min: well past one agent turn
// on this fleet (review rounds and lane briefs measured at 5–20 min), so a surfacing is
// rare for live work; surfacing is non-destructive, and closing is never automatic.
const SILENT_AGENT_ESCALATE_MS = 30 * 60 * 1000;
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "killed", "cancelled", "canceled", "stopped", "error"]);
// PreCompact freshness AND readiness: a seed more than this far behind the current reading
// is stale (CYCLE.md §1.5). Shared — boundary-seed.js re-exports it.
const FRESH_SEED_MAX_TOKEN_LAG = 80000;
// The handover point must sit at least this far above the session's FIRST measured reading,
// or a fresh context would restart at/near the point and hand over again (a /clear loop).
const MIN_SESSION_GROWTH_TOKENS = 30000;

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

let _warnedGuards = false;
/** O_NOFOLLOW|O_NONBLOCK, or zeros — LOUDLY (once per process) when the platform lacks them. */
function openGuards() {
  let g;
  try {
    g = require("./transcript-read.js").transcriptOpenGuards();
  } catch {
    g = { nofollow: 0, nonblock: 0, active: false };
  }
  if (!g.nofollow && !_warnedGuards) {
    _warnedGuards = true;
    try {
      process.stderr.write("[context-state] O_NOFOLLOW unavailable on this platform — seed reads fall back to an lstat/fstat inode identity check; transcript reads are UNGUARDED against a symlink swap\n");
    } catch {
      /* stderr unavailable */
    }
  }
  return g;
}

/** Where this terminal's state file lives (delegates to the meter: ONE derivation). */
function locateState({ configDir, repoDir, pid, terminalKey }) {
  try {
    return { ...meter.resolveContextStatePath({ configDir, repoDir, pid, terminalKey }), repoDir: path.resolve(repoDir || process.cwd()) };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || "state path could not be resolved" };
  }
}

/** Bounded read of the record. {state:"absent"|"ok"|"corrupt", data?, reason?} */
function readState(loc) {
  if (!loc || !loc.ok) return { state: "absent", reason: (loc && loc.reason) || "no state location" };
  return meter.readContextState(loc.file);
}

/**
 * Read-modify-write under the meter's lock. `mutate(prevData)` returns the TOP-LEVEL keys
 * to replace (it merges nested objects itself); every other key is preserved.
 * Returns {ok, seq?, data?, reason?}. Never throws.
 */
function updateContextState(loc, mutate) {
  if (!loc || !loc.ok) return { ok: false, code: loc && loc.code, reason: (loc && loc.reason) || "no state location" };
  try {
    if (loc.ensureIgnore) fs.mkdirSync(loc.dir, { recursive: true });
    return meter.withStateLock(loc.file, () => {
      const prev = meter.readContextState(loc.file);
      const base = prev.state === "ok" ? prev.data : {};
      const fields = mutate(base);
      if (!isObj(fields)) return { ok: false, reason: "mutator returned no fields" };
      const prevSeq = Number.isInteger(base.seq) && base.seq >= 0 ? base.seq : 0;
      const next = { ...base, ...fields, schema: meter.STATE_SCHEMA_ID, seq: prevSeq + 1 };
      const w = meter.writeJsonAtomic(loc.dir, loc.file, next, { ensureIgnore: !!loc.ensureIgnore });
      if (!w.ok) return w;
      return { ok: true, seq: next.seq, data: next, corrupt_replaced: prev.state === "corrupt" ? prev.reason : null };
    });
  } catch (e) {
    return { ok: false, reason: (e && e.message) || "state write failed" };
  }
}

// ── the activity marker + THE CONSUMER PREDICATE ────────────────────────────

/** Bump this terminal's activity marker (lock-free). See lib/context-meter.js § ACTIVITY. */
function markActivity(loc, event, nowIso, opts) {
  return meter.markActivity(loc, event, nowIso, opts);
}

function readActivity(loc) {
  return meter.readActivity(loc);
}

// ── TRANSCRIPT QUIESCENCE — the activity witness no hook registration is needed for ──
// MEASURED 2026-10-10 (a ~20s tool call sampled once a second from a separate process):
// the assistant tool_use record is DURABLY in the transcript ~23s before its tool_result,
// i.e. before the tool finishes running — the size moved by exactly that record's bytes
// when it was emitted. So any new turn (a prompt, a task notification, a tool call) leaves
// a non-quiescent record past the Stop's offset BEFORE it can do anything long-running.
// After a turn ends, Claude Code keeps appending a measured set of NON-activity records
// (Stop-hook attachments, the stop summary, turn duration, session metadata). That set is
// QUIESCENT_RECORD_KINDS, MEASURED over 200 transcripts / 28,917 turn tails (the kinds
// written between a turn-ending assistant text and the next activity record). Anything
// else — including a kind not in the set — counts as ACTIVITY (fail closed: an unknown
// kind costs readiness, never a /clear mid-turn).
// `last-prompt` / `mode` are quiescent by type: MEASURED 2026-10-10 (this repo's 7 main
// transcripts on this account), 0 of 13,430 `last-prompt` records carried a prompt text
// that was not ALREADY in the transcript (12,276 matched only an earlier prompt, 677 both
// an earlier and the next identical one, 352 neither), and 0 of 289 whose leafUuid names
// a user prompt named one written AFTER it — so a last-prompt never runs ahead of the
// (non-quiescent) prompt record it describes. They are kept: they land in nearly every
// Stop tail (between the dispatcher's own attachments and the summary), so excluding them
// would make readiness unreachable rather than safer.
const QUIESCENT_RECORD_KINDS = new Set([
  "attachment:hook_success:Stop",
  "attachment:hook_system_message:Stop",
  "attachment:hook_cancelled:Stop",
  "attachment:hook_non_blocking_error:Stop",
  "system:stop_hook_summary",
  "system:turn_duration",
  "system:away_summary",
  "last-prompt",
  "atis-latch",
  "mode",
  "ai-title",
  "permission-mode",
  "pr-link",
  "custom-title",
  "agent-name",
  "cost-state",
  "frame-link",
]);
// Past the Stop offset at most this much may be read; more is NOT quiescent (a quiet tail
// is a few KB of hook attachments and metadata).
const TRANSCRIPT_TAIL_MAX_BYTES = 1024 * 1024;
// How far before the seed offset the fence looks for the NAMES of tool calls whose results
// land after it (a call issued alongside the seed write). Names only — never a verdict.
const TOOL_NAME_LOOKBACK_BYTES = 256 * 1024;

/** The kind string a transcript record is classified by (QUIESCENT_RECORD_KINDS' vocabulary). */
function recordKind(r) {
  if (!isObj(r)) return "unparsable";
  if (r.type === "attachment") {
    const a = isObj(r.attachment) ? r.attachment : {};
    return `attachment:${String(a.type)}${typeof a.hookEvent === "string" ? `:${a.hookEvent}` : ""}`;
  }
  if (r.type === "system") return `system:${String(r.subtype)}`;
  return String(r.type);
}

/**
 * The verdict a `system:stop_hook_summary` record carries: CLEAN only when `hookErrors` is
 * an EMPTY array and `preventedContinuation` is exactly false. Any other shape — a missing
 * or non-array hookErrors, a non-boolean preventedContinuation — is NOT clean (fail
 * closed: a summary whose verdict cannot be read cannot certify the Stop finished).
 * hookErrors also lists NON-blocking failures (a crashed hook, measured): a Stop with a
 * failed hook is never a boundary either.
 */
function stopSummaryOf(r) {
  const errs = isObj(r) && Array.isArray(r.hookErrors) ? r.hookErrors.length : null;
  const prevented = isObj(r) ? r.preventedContinuation : undefined;
  return { clean: errs === 0 && prevented === false, errors: errs, prevented: typeof prevented === "boolean" ? prevented : null, hook_count: isObj(r) && Number.isInteger(r.hookCount) ? r.hookCount : null };
}

/**
 * {finished, reason}: Claude Code FINISHED this Stop — every Stop hook, including those
 * registered outside the dispatcher — and none of them blocked. Requires, in the tail read
 * since the Stop offset: at least one `system:stop_hook_summary`, one summary verdict per
 * summary record (the reader produced them together), and every summary CLEAN. A blocking
 * record itself (hook_blocking_error, the "Stop hook feedback" user record) is not
 * quiescent, so transcriptQuiescent refuses it wherever it lands after the offset; a
 * blocking record that landed BEFORE the offset (an external hook that blocked before the
 * dispatcher measured the offset — measured) is caught here, by the summary's hookErrors.
 */
function stopFinished(tail) {
  if (!isObj(tail) || tail.ok !== true) return { finished: false, reason: "the transcript since the Stop was not read" };
  const kinds = Array.isArray(tail.kinds) ? tail.kinds : [];
  const sums = Array.isArray(tail.stop_summaries) ? tail.stop_summaries : null;
  const nKinds = kinds.filter((k) => k === "system:stop_hook_summary").length;
  if (!sums || sums.length !== nKinds) return { finished: false, reason: "the Stop's completion record could not be read" };
  if (sums.length === 0) return { finished: false, reason: "Claude Code has not finished the Stop (no stop_hook_summary past the Stop offset — another Stop hook may still block)" };
  const bad = sums.find((s) => !isObj(s) || s.clean !== true);
  if (bad) return { finished: false, reason: `a Stop hook blocked, halted or failed (stop_hook_summary hookErrors=${isObj(bad) ? bad.errors : "?"}, preventedContinuation=${isObj(bad) ? bad.prevented : "?"})` };
  return { finished: true, reason: null };
}

/** {ok, path, size, ino, dev} of the transcript NOW (O_NOFOLLOW), or {ok:false, reason}. */
function transcriptSize(transcriptPath) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) return { ok: false, reason: "no absolute transcript_path" };
  const g = openGuards();
  let fd;
  try {
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | g.nofollow | g.nonblock);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "transcript is not a regular file" };
    return { ok: true, path: transcriptPath, size: st.size, ino: st.ino, dev: st.dev };
  } catch (e) {
    return { ok: false, reason: (e && e.code) || (e && e.message) || "stat failed" };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
    }
  }
}

/**
 * The record kinds written to `transcriptPath` since byte `from`: {ok, path, from, size, ino,
 * dev, kinds} or {ok:false, path, from, reason}. NOT ok — so NOT quiescent — when the file
 * shrank (a different file), grew by more than `maxBytes`, or ends in a torn record (a write
 * in progress).
 */
function readTranscriptSince(transcriptPath, from, { maxBytes = TRANSCRIPT_TAIL_MAX_BYTES } = {}) {
  const base = { path: transcriptPath, from };
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) return { ...base, ok: false, reason: "no absolute transcript path" };
  if (!Number.isInteger(from) || from < 0) return { ...base, ok: false, reason: "no valid offset" };
  const g = openGuards();
  let fd;
  try {
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | g.nofollow | g.nonblock);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ...base, ok: false, reason: "transcript is not a regular file" };
    const id = { size: st.size, ino: st.ino, dev: st.dev };
    if (st.size < from) return { ...base, ...id, ok: false, reason: `transcript is SHORTER (${st.size}) than the Stop offset ${from} — not the same file` };
    const len = st.size - from;
    if (len > maxBytes) return { ...base, ...id, ok: false, reason: `${len} bytes written since the Stop (> ${maxBytes})` };
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    const text = buf.subarray(0, got).toString("utf8");
    if (text && !text.endsWith("\n")) return { ...base, ...id, ok: false, reason: "the transcript ends in an incomplete record (a write in progress)" };
    const kinds = [];
    const stopSummaries = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      let r = null;
      try {
        r = JSON.parse(line);
      } catch {
        r = null;
      }
      const k = recordKind(r);
      kinds.push(k);
      if (k === "system:stop_hook_summary") stopSummaries.push(stopSummaryOf(r));
    }
    return { ...base, ...id, ok: true, kinds, stop_summaries: stopSummaries };
  } catch (e) {
    return { ...base, ok: false, reason: (e && e.code) || (e && e.message) || "read failed" };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
    }
  }
}

/** {quiet, reason}: the tail read since the Stop holds ONLY quiescent records of the SAME file. */
function transcriptQuiescent(b, tail) {
  if (!isObj(b) || typeof b.transcript_path !== "string" || !b.transcript_path || !Number.isInteger(b.transcript_offset) || b.transcript_offset < 0 || !Number.isInteger(b.transcript_ino) || !Number.isInteger(b.transcript_dev)) {
    return { quiet: false, reason: "the Stop's transcript position (path, offset, identity) was not recorded" };
  }
  if (!isObj(tail)) return { quiet: false, reason: "the transcript since the Stop was not read" };
  if (tail.path !== b.transcript_path || tail.from !== b.transcript_offset) return { quiet: false, reason: "the transcript tail was read from a different file or offset than the Stop recorded" };
  if (tail.ok !== true) return { quiet: false, reason: `the transcript since the Stop is unreadable or not quiet (${tail.reason || "unknown"})` };
  if (tail.ino !== b.transcript_ino || tail.dev !== b.transcript_dev) return { quiet: false, reason: "the transcript file was REPLACED since the Stop" };
  const busy = (Array.isArray(tail.kinds) ? tail.kinds : ["unparsable"]).find((k) => !QUIESCENT_RECORD_KINDS.has(k));
  if (busy !== undefined) return { quiet: false, reason: `activity in the transcript since the Stop (a "${busy}" record)` };
  return { quiet: true, reason: null };
}

/**
 * THE PREDICATE A CONSUMER (csq) MUST APPLY before acting on the boundary. `state` is the
 * parsed coc-context-state/v1 record, `activity` the parsed activity marker beside it
 * ({state:"ok", nonce, session_id} — readActivity's shape; or the raw file object
 * {schema, nonce, session_id}).
 * VALID only when ALL hold:
 *   boundary.ready === true
 *   boundary.committed === true                (the dispatcher saw the merged Stop end the turn)
 *   boundary.activity_nonce is 32 lowercase hex
 *   boundary.session_id is a session id, and the activity marker names the SAME session
 *     (the currently-active session: every SessionStart, prompt and tool completion
 *     rewrites the marker with its session)
 *   the activity marker exists, parses, and its nonce === boundary.activity_nonce
 *   boundary.transcript_path / transcript_offset / transcript_ino / transcript_dev are
 *     recorded, and `tail` — readTranscriptSince(transcript_path, transcript_offset) read
 *     NOW — is ok, is the SAME file (ino/dev), holds ONLY QUIESCENT_RECORD_KINDS, and holds
 *     at least one stop_hook_summary, every one CLEAN (stopFinished: Claude Code finished
 *     the Stop, external Stop hooks included, and nothing blocked)
 * Anything else — including an absent or unreadable marker or tail — is NOT ready.
 * Returns {valid, reason}.
 */
function pendingFindingsReason(payload) {
  if (!isObj(payload) || meter.activitySessionId(payload.session_id) === null || typeof payload.cwd !== "string" || !path.isAbsolute(payload.cwd) || (payload.agent_id != null && (typeof payload.agent_id !== "string" || !payload.agent_id.trim()))) return "hook findings queue UNKNOWN: trusted repo/session/agent context is absent";
  let pending = null;
  try { pending = require("./hook-findings.js").pendingForAgent(payload); } catch {}
  if (!Number.isInteger(pending) || pending < 0) return "hook findings queue UNKNOWN: unreadable or unresolved";
  return pending === 0 ? null : `${pending} hook finding(s) pending agent delivery`;
}

function boundaryReadyValid(state, activity, tail, options = {}) {
  const { repoDir = process.cwd(), dirInfo, validate, nowMs } = options;
  const b = isObj(state) && isObj(state.boundary) ? state.boundary : null;
  if (!b || b.ready !== true) return { valid: false, reason: "boundary.ready is not true" };
  if (b.committed !== true) return { valid: false, reason: "readiness was not committed by the merged Stop verdict" };
  if (typeof b.activity_nonce !== "string" || !NONCE_RE.test(b.activity_nonce)) return { valid: false, reason: "boundary.activity_nonce is absent or malformed" };
  const bSession = meter.activitySessionId(b.session_id);
  if (bSession === null) return { valid: false, reason: "boundary.session_id is absent or malformed — readiness is not bound to a session" };
  const live = isObj(activity) && (activity.state === undefined || activity.state === "ok");
  const nonce = live ? activity.nonce : null;
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) return { valid: false, reason: "the activity marker is absent or unreadable" };
  if (nonce !== b.activity_nonce) return { valid: false, reason: "activity since readiness was computed (the marker's nonce moved)" };
  const aSession = meter.activitySessionId(activity.session_id);
  if (aSession !== bSession) return { valid: false, reason: `the active session (${aSession === null ? "unrecorded" : "a different session"}) is not the session that computed readiness` };
  const agentId = options.agentId == null ? null : options.agentId;
  if ((b.agent_id == null ? null : b.agent_id) !== agentId) return { valid: false, reason: "readiness agent does not match trusted consumer agent" };
  const queueReason = pendingFindingsReason({ cwd: repoDir, session_id: aSession, agent_id: agentId });
  if (queueReason) return { valid: false, reason: queueReason };
  const bound = handoverBoundReason(state.handover, b);
  if (bound) return { valid: false, reason: bound };
  const q = transcriptQuiescent(b, tail);
  if (!q.quiet) return { valid: false, reason: q.reason };
  const f = stopFinished(tail);
  if (!f.finished) return { valid: false, reason: f.reason };
  let seed;
  try {
    seed = require("./boundary-seed.js").readinessVerdict({
      state,
      dirInfo: dirInfo || require("./compaction-handoff.js").resolveHandoffDir(repoDir),
      validate: validate || require("./handover-seed.js").validateSeed,
      nowMs,
    });
  } catch (e) {
    return { valid: false, reason: `seed re-check failed (${(e && e.message) || e})` };
  }
  if (!seed || seed.ok !== true) return { valid: false, reason: `seed would NOT be injected: ${(seed && seed.reason) || "unknown"}` };
  return { valid: true, reason: null };
}

/** File-reading form of the predicate, for a consumer holding a state location. */
function readBoundaryReadiness(loc, options = {}) {
  const st = readState(loc);
  if (st.state !== "ok") return { valid: false, reason: `state record ${st.state}${st.reason ? ` (${st.reason})` : ""}` };
  const b = isObj(st.data.boundary) ? st.data.boundary : {};
  const tail = typeof b.transcript_path === "string" ? readTranscriptSince(b.transcript_path, b.transcript_offset) : undefined;
  return boundaryReadyValid(st.data, readActivity(loc), tail, { repoDir: (loc && loc.repoDir) || process.cwd(), ...options });
}

// ── TAIL-LOSS FENCE (M6e) — nothing said after the seed may be lost to a /clear ──
// MEASURED 2026-10-11 (H1): an instruction given AFTER the seed was written was lost on
// /clear — the resumed context knew only what the seed said. So a handover is NOT a
// boundary while the transcript, after the seed, holds anything the seed cannot carry:
//
//   from `seed_offset` (the transcript size the seed-write hook measured when the seed's
//   bytes landed) — ANY user-role input: an owner prompt, a task notification, a Stop-hook
//   feedback record, anything in a `user` record that is not a pure tool_result;
//   also from `seed_offset` — ANY assistant text (R1-S2 C2: narration after the seed is
//   owner-facing and a /clear loses it just the same), except the cycle's ONE final line
//   after the render: `HANDOVER WRITTEN <sha8 of the stamped seed> …` (skills/wrapup/
//   cycle.md); from `render_offset` (the size the stamp measured at render) — ANY tool call,
//   and a second HANDOVER line. A record the seed offset falls inside is scanned whole.
//   Input that is not a plain user record counts too: AskUserQuestion answers, csq inbox
//   reads, rejected tool calls, queue-operation enqueues, local slash commands.
//
// Positions are BYTE OFFSETS in the same file (ino+dev pinned), not timestamps, so no
// clock — and no hand-typed written= — can move the cutoff. Only COMPLETE lines are judged;
// a record still being written at the end is past every Stop's own offset, where the
// consumer's quiescence check (boundaryReadyValid) already refuses non-quiescent records.
// UNVERIFIED — no recorded transcript, a replaced or shrunk file, an over-cap tail, an
// unparsable complete record — is a refusal, never "safe".
// CANNOT SEE: peer messages delivered outside the transcript (csq inbox state), and content
// arriving by hook attachment; a transcript the hook payload never named (non-Claude CLIs).
// The shape of the final line; tailFenceVerdict also pins it to `HANDOVER WRITTEN <sha8>`.
const HANDOVER_FINAL_LINE_RE = /^HANDOVER [^\n]{0,400}$/;

function isUserInput(r) {
  const m = isObj(r.message) ? r.message : null;
  if (!m) return true; // a user record with no readable message is not provably a tool result
  if (typeof m.content === "string") return m.content.trim() !== "";
  if (!Array.isArray(m.content)) return true;
  return m.content.some((b) => !isObj(b) || b.type !== "tool_result");
}

// MEASURED 2026-10-12 over this operator's recent transcripts: an owner prompt typed while the
// session is busy is delivered as an `attachment` record of type `queued_command` and, in 40 of
// 220 non-notification cases, NEVER re-appears as a `type:"user"` record (e.g. a humanTurn
// prompt existed only there). A fence reading only `user` records misses exactly the owner
// input a mid-cycle /clear loses — so every queued command counts as input, whatever its origin
// (a peer notice or task result arriving after the seed is lost by a /clear just the same).
function isQueuedInput(r) {
  return r.type === "attachment" && isObj(r.attachment) && r.attachment.type === "queued_command";
}

function assistantTexts(r) {
  const m = isObj(r.message) ? r.message : null;
  if (!m) return [];
  if (typeof m.content === "string") return m.content.trim() ? [m.content] : [];
  if (!Array.isArray(m.content)) return [];
  return m.content.filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "").map((b) => b.text);
}

// Owner input that does NOT arrive as a plain user record (R1-S2 security F2/F3/F4):
//   - a tool_result answering AskUserQuestion, or carrying csq's inbox (peer messages the
//     /clear would drop just the same), or a rejection with the owner's feedback. MEASURED
//     2026-10-12 over this operator's transcripts: 88 of 88 AskUserQuestion results carry
//     `toolUseResult.answers` (self-describing, whatever tool id); 115 of 115 rejections carry
//     "The user doesn't want to proceed with this tool use" or "... take this action" text;
//   - a `queue-operation` ENQUEUE (a prompt queued before the Stop and drained after it);
//   - a `system` record of subtype `local_command` (a slash command the owner typed).
const INPUT_TOOL_RE = /^(?:AskUserQuestion|mcp__csq-messaging__inbox)$/;
const REJECTION_RE = /The user doesn't want to (?:proceed|take this action)/;
function inputBearingToolResult(r, toolNames) {
  const m = isObj(r.message) ? r.message : null;
  if (!m || !Array.isArray(m.content)) return false;
  return m.content.some((b) => {
    if (!isObj(b) || b.type !== "tool_result") return false;
    if (isObj(r.toolUseResult) && Object.prototype.hasOwnProperty.call(r.toolUseResult, "answers")) return true;
    if (INPUT_TOOL_RE.test(toolNames.get(b.tool_use_id) || "")) return true;
    const t = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c) => (isObj(c) && typeof c.text === "string" ? c.text : "")).join("\n") : "";
    return REJECTION_RE.test(t);
  });
}
function isOtherInput(r) {
  return (r.type === "queue-operation" && r.operation === "enqueue") || (r.type === "system" && r.subtype === "local_command");
}

/**
 * SEC-F1 — a handover is bound to the session AND the transcript that wrote it. The
 * boundary being judged names the CURRENT Stop's session and transcript identity; any
 * mismatch — a new conversation in the same terminal inheriting a "written" record — is a
 * refusal, as is a boundary that names neither. Returns a reason, or null when bound.
 */
function handoverBoundReason(h, b) {
  if (!isObj(h)) return "[handover-unbound] no handover";
  const bb = isObj(b) ? b : {};
  const bs = meter.activitySessionId(bb.session_id);
  if (!bs) return "[handover-unbound] this boundary names no session — the handover cannot be bound to it";
  if (meter.activitySessionId(h.session_id) !== bs) return "[handover-other-session] the handover was written by another session than this boundary's — a new conversation never inherits it";
  if (typeof bb.transcript_path !== "string" || !Number.isInteger(bb.transcript_ino) || !Number.isInteger(bb.transcript_dev)) {
    return "[handover-unbound] this boundary's transcript identity is unknown — the handover cannot be bound to it";
  }
  if (h.transcript_path !== bb.transcript_path || h.transcript_ino !== bb.transcript_ino || h.transcript_dev !== bb.transcript_dev) {
    return "[handover-other-transcript] the handover's transcript is not this boundary's transcript";
  }
  return null;
}

function hasHumanOrigin(record, undeclaredIsHuman) {
  if (!Object.hasOwn(record, "origin")) return undeclaredIsHuman;
  return isObj(record.origin) && record.origin.kind === "human";
}

/** Owner-text extraction; shared origin discriminator: context-state.js:563-583. */
function ownerTexts(r) {
  if (!isObj(r)) return [];
  if (r.type === "user" && r.isMeta !== true && hasHumanOrigin(r, true) && isUserInput(r)) {
    const c = isObj(r.message) ? r.message.content : null;
    if (typeof c === "string") return [c];
    if (Array.isArray(c)) return c.filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string").map((b) => b.text);
    return [];
  }
  if (isQueuedInput(r) && r.attachment.isMeta !== true && hasHumanOrigin(r.attachment, false)) {
    const pr = r.attachment.prompt;
    if (typeof pr === "string") return [pr];
    if (Array.isArray(pr)) return pr.filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string").map((b) => b.text);
  }
  return [];
}

/**
 * Seed correction notes; explicit clock modes and age check: context-state.js:588-607.
 */
function seedClockNote(h, nowIso) {
  if (!isObj(h) || h.state !== "writing" || typeof h.declared_written !== "string") return null;
  const now = Date.parse(nowIso || "");
  const decl = Date.parse(h.declared_written);
  if (!Number.isFinite(now)) return null;
  const anchored = h.first_written_at !== undefined || h.written_at !== undefined;
  const anchorIso = h.first_written_at === undefined ? h.written_at : h.first_written_at;
  const anchor = anchored ? Date.parse(anchorIso) : now;
  if (!Number.isFinite(anchor)) throw new TypeError("seed first-write clock is unreadable");
  const SEED = require("./handover-seed.js");
  const clock = SEED.clockIso(anchor);
  const freshClock = SEED.clockIso(now);
  const tag = `[CTX] seed ${String(h.seed_sha256 || "").slice(0, 8)} written=${h.declared_written}`;
  if (now - anchor > SEED.WRITTEN_PAST_SKEW_MS) return `${tag} has stale content (seed-stale) — write a NEW seed file, re-checked against live state, with written=${freshClock}`;
  if (!Number.isFinite(decl)) return `${tag} is not a time — Edit the header to written=${clock} before rendering`;
  const skew = decl - anchor;
  const mins = (ms) => `${Math.round(Math.abs(ms) / 60000)} min`;
  if (skew > SEED.WRITTEN_FUTURE_SKEW_MS) return `${tag} is ${mins(skew)} AHEAD of the tool clock — Edit the header to written=${clock} before rendering (the render refuses written-skew)`;
  if (-skew > SEED.WRITTEN_PAST_SKEW_MS) return `${tag} is ${mins(skew)} BEHIND the tool clock — the render will refuse it (seed-stale): write a NEW seed file, re-checked against live state, with written=${freshClock}`;
  return null;
}

/**
 * The fence verdict for a handover: {ok:true, read} | {ok:false, code, reason}. `code` is
 * `tail-unverified` (could not be judged — refused) or `tail-after-seed` (content found).
 */
function tailFenceVerdict(h, { maxBytes = TRANSCRIPT_TAIL_MAX_BYTES } = {}) {
  const unv = (reason) => ({ ok: false, code: "tail-unverified", reason: `tail-loss fence UNVERIFIED — ${reason}; readiness is never assumed safe` });
  if (!isObj(h)) return unv("no handover");
  const tp = h.transcript_path;
  if (typeof tp !== "string" || !path.isAbsolute(tp)) return unv(`no session transcript was recorded when the seed was written${h.transcript_reason ? ` (${String(h.transcript_reason).slice(0, 120)})` : ""}`);
  const so = h.seed_offset;
  const ro = h.render_offset;
  if (!Number.isInteger(so) || so < 0) return unv("the seed-write transcript offset is absent");
  if (!Number.isInteger(ro) || ro < so) return unv("the render-time transcript offset is absent or precedes the seed");
  if (!Number.isInteger(h.transcript_ino) || !Number.isInteger(h.transcript_dev)) return unv("the transcript identity (inode/device) was not recorded");
  const g = openGuards();
  let fd;
  try {
    fd = fs.openSync(tp, fs.constants.O_RDONLY | g.nofollow | g.nonblock);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return unv("the transcript is not a regular file");
    if (st.ino !== h.transcript_ino || st.dev !== h.transcript_dev) return unv("the transcript file was replaced since the seed was written");
    if (st.size < ro) return unv(`the transcript is SHORTER (${st.size}) than the render offset ${ro}`);
    // Tool calls issued in the SAME assistant turn as the seed write precede the seed offset,
    // but their results land after it: learn their names from a bounded look-back. The same
    // look-back finds the start of a record the seed offset falls INSIDE (C5: a straddling
    // record is scanned whole, never skipped as a fragment and never read as a clean start).
    const toolNames = new Map();
    const learnTools = (r) => {
      if (isObj(r) && r.type === "assistant" && isObj(r.message) && Array.isArray(r.message.content)) {
        for (const b of r.message.content) if (isObj(b) && b.type === "tool_use" && typeof b.id === "string") toolNames.set(b.id, String(b.name || ""));
      }
    };
    let scanFrom = so;
    {
      const lb = Math.min(so, TOOL_NAME_LOOKBACK_BYTES);
      const back = Buffer.alloc(lb);
      let bg = 0;
      while (bg < lb) {
        const n = fs.readSync(fd, back, bg, lb - bg, so - lb + bg);
        if (n <= 0) break;
        bg += n;
      }
      if (bg !== lb) return unv("the transcript before the seed offset could not be read");
      if (lb > 0 && back[lb - 1] !== 0x0a) {
        const nl = back.lastIndexOf(0x0a);
        if (nl < 0 && so - lb > 0) return unv(`the seed offset ${so} falls inside a record that starts more than ${TOOL_NAME_LOOKBACK_BYTES} bytes earlier`);
        scanFrom = so - lb + nl + 1;
      }
      // A look-back that starts mid-record drops that partial first line; the straddling tail
      // (after scanFrom) is parsed strictly below, not here.
      const parts = back.subarray(0, scanFrom - (so - lb)).toString("utf8").split("\n");
      if (so - lb > 0) parts.shift();
      for (const l of parts) {
        if (!l.trim()) continue;
        try {
          learnTools(JSON.parse(l));
        } catch {
          /* look-back is advisory for NAMES only; the fenced region below is parsed strictly */
        }
      }
    }
    const len = st.size - scanFrom;
    if (len > maxBytes) return unv(`${len} bytes were written after the seed (> ${maxBytes}) — far more happened than the seed can carry`);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, scanFrom + got);
      if (n <= 0) break;
      got += n;
    }
    // C5: the ONE line that may end the cycle names the seed this record stamped.
    const sha8 = typeof h.seed_sha256 === "string" && /^[0-9a-f]{64}$/.test(h.seed_sha256) ? h.seed_sha256.slice(0, 8) : null;
    const isFinalLine = (t) => {
      const x = t.trim();
      if (!sha8 || !HANDOVER_FINAL_LINE_RE.test(x)) return false;
      const head = `HANDOVER WRITTEN ${sha8}`;
      return x === head || x.startsWith(`${head} `);
    };
    let at = 0;
    let users = 0;
    let texts = 0;
    let handovers = 0;
    let first = null;
    while (at < got) {
      const nl = buf.indexOf(0x0a, at);
      if (nl < 0 || nl >= got) break; // a record still being written: see the header
      const line = buf.subarray(at, nl).toString("utf8");
      const lineStart = scanFrom + at;
      at = nl + 1;
      if (!line.trim()) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        return unv(`a complete transcript record at byte ${lineStart} after the seed is unparsable`);
      }
      if (!isObj(r)) return unv(`a transcript record at byte ${lineStart} after the seed is not an object`);
      learnTools(r);
      if (r.type === "user" && (isUserInput(r) || inputBearingToolResult(r, toolNames))) {
        users++;
        if (!first) first = `user-role input at byte ${lineStart}`;
      } else if (isQueuedInput(r) || isOtherInput(r)) {
        users++;
        if (!first) first = `queued or typed input (${r.type}${r.subtype ? `:${r.subtype}` : ""}) at byte ${lineStart}`;
      } else if (r.type === "assistant") {
        // C2: from the seed write on, the ONLY assistant text is the final HANDOVER line after
        // the render — any other text is owner-facing and a /clear would lose it.
        const all = assistantTexts(r);
        const ok = lineStart >= ro ? all.filter(isFinalLine) : [];
        const bad = all.filter((t) => !ok.includes(t));
        handovers += ok.length;
        // F4: after the render the turn ENDS — a tool call there is work the seed never saw.
        const tools = lineStart >= ro && isObj(r.message) && Array.isArray(r.message.content) ? r.message.content.filter((b) => isObj(b) && b.type === "tool_use").length : 0;
        if (bad.length || tools) {
          texts += bad.length + tools;
          if (!first) first = bad.length ? `assistant text at byte ${lineStart} (${JSON.stringify(bad[0].trim().slice(0, 60))})` : `assistant tool call at byte ${lineStart}`;
        }
      }
    }
    if (handovers > 1) {
      texts += handovers - 1;
      if (!first) first = `${handovers} HANDOVER lines after the render (exactly one ends the cycle)`;
    }
    if (users || texts) {
      return { ok: false, code: "tail-after-seed", reason: `${users} user-role input(s) after the seed and ${texts} assistant text(s) or post-render tool call(s) (first: ${first}) — a /clear now loses them; re-write and re-render the seed so it carries them` };
    }
    return { ok: true, read: got };
  } catch (e) {
    return unv(`the transcript could not be read (${(e && e.code) || (e && e.message) || "error"})`);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
    }
  }
}

// ── DECLARED-HANDOVER STATE (M6, H2) — a handover a watcher can SEE ─────────────
// MEASURED 2026-10-11 (H2): a session announced "handing over, please /clear me" and then
// idled 18 min; nothing noticed, because a declared handover was a chat event only. This
// file is the machine state. The stall ALARM is not built here — it belongs to csq, which
// owns sessions; this is only the state and its read contract (DECLARED_CONTRACT).
const DECLARED_SCHEMA = "coc-handover-declared/v1";
const DECLARED_DIR = "handover-declared";
const DECLARED_CONTRACT =
  "coc-handover-declared/v1. PATH: <main checkout>/.claude/learning/handover-declared/<session_id>.json (gitignored). " +
  "WRITTEN by handover-render's stamp (context-state.js::stampHandover) when a cycle handover is rendered and stamped; a re-render by the same session REPLACES it. " +
  "REMOVED by the SessionStart injector (compaction-handoff-inject.js -> context-state.js::consumeDeclaredHandover) when the next context starts with THIS seed (seed_sha256 must match). " +
  "SEMANTICS: present = a handover was declared and no next context has started from it. A watcher compares now - declared_at against its own threshold; the age is the stall. " +
  "FIELDS: session_id (the declaring session), declared_at (ISO-8601, the TOOL's clock at the stamp — never agent-typed), seed_sha256, seed_path, resume_token, repo (main checkout). " +
  "It says nothing about readiness: boundary.ready in the context-state record is the /clear predicate.";

/**
 * Where a learning-tree child must resolve, anchored on the CANONICAL CHECKOUT
 * (compaction-handoff.js::resolveHandoffDir's `realCheckout`). Never anchored on
 * `canonicalBoundary` resolved through `.claude` or `.claude/learning`: those are
 * the components a redirect replaces, so resolving through them accepts the redirect
 * (security.md § Path Containment). null when the checkout is absent or does not
 * resolve; every caller refuses on null.
 */
function anchoredLearningPath(dirInfo, leaf) {
  if (!dirInfo || typeof dirInfo.realCheckout !== "string" || !path.isAbsolute(dirInfo.realCheckout)) return null;
  try {
    return path.join(fs.realpathSync(dirInfo.realCheckout), ".claude", "learning", leaf);
  } catch {
    return null;
  }
}

/**
 * Canonical form of a path that may not exist yet: the realpath of its longest
 * existing prefix plus the missing tail. A DANGLING symlink anywhere on the path
 * returns null, because creating through it would land wherever it points.
 */
function resolveExistingPrefix(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch (e) {
      if (!e || e.code !== "ENOENT") return null;
      try {
        fs.lstatSync(cur);
        return null; // present but unresolvable: a dangling link
      } catch {
        /* genuinely absent: walk up */
      }
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Is `candidate` (which may not exist yet) exactly the anchored `leaf` of the
 * learning tree? {ok:true, expected} | {ok:false, reason}. Checked BEFORE anything is
 * created, so a redirected tree never gets a directory made through it.
 */
function learningPathContained(dirInfo, leaf, candidate) {
  const expected = anchoredLearningPath(dirInfo, leaf);
  if (!expected) return { ok: false, reason: "main checkout absent or unresolvable — no anchor to contain it against" };
  if (resolveExistingPrefix(candidate) !== expected) return { ok: false, reason: `${leaf} resolves outside the main checkout's learning tree — refusing` };
  return { ok: true, expected };
}

function declaredPath(dirInfo, sessionId) {
  const sid = meter.activitySessionId(sessionId);
  if (!dirInfo || !dirInfo.ok || !dirInfo.canonicalBoundary || !sid || sid === "." || sid === "..") return null;
  return { dir: path.join(dirInfo.canonicalBoundary, DECLARED_DIR), file: path.join(dirInfo.canonicalBoundary, DECLARED_DIR, `${sid}.json`) };
}

const DECLARED_READ_CAP_BYTES = 64 * 1024;

/**
 * SEC-F5: the declared-state DIRECTORY must be a real directory at its canonical place —
 * a symlinked `handover-declared/` would redirect the write (and the removal) elsewhere.
 * Absent is fine (the atomic writer creates it). Returns a reason, or null when safe.
 */
function declaredDirUnsafe(p, dirInfo) {
  // Contained even when ABSENT: the atomic writer creates it, so an absent directory
  // under a redirected .claude or .claude/learning would be created outside the checkout.
  const c = learningPathContained(dirInfo, DECLARED_DIR, p.dir);
  if (!c.ok) return `declared-state directory: ${c.reason}`;
  let st;
  try {
    st = fs.lstatSync(p.dir);
  } catch (e) {
    return e && e.code === "ENOENT" ? null : `declared-state directory unreadable (${(e && e.code) || "lstat failed"})`;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return "declared-state directory is not a real directory (symlink or other) — refused";
  return null;
}

/** Bounded, no-follow, non-blocking read of a declared-state file: {ok, data} | {ok:false, code, reason}. */
function readDeclaredFile(file) {
  const g = openGuards();
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | g.nofollow | g.nonblock);
  } catch (e) {
    return { ok: false, code: (e && e.code) || "open", reason: (e && e.code) || "open failed" };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, code: "not-file", reason: "declared state is not a regular file" };
    if (st.size > DECLARED_READ_CAP_BYTES) return { ok: false, code: "too-large", reason: `declared state is ${st.size} B (> ${DECLARED_READ_CAP_BYTES})` };
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = fs.readSync(fd, buf, got, st.size - got, got);
      if (n <= 0) break;
      got += n;
    }
    return { ok: true, data: JSON.parse(buf.subarray(0, got).toString("utf8")) };
  } catch (e) {
    return { ok: false, code: "unreadable", reason: (e && e.message) || "unreadable" };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* closed */
    }
  }
}

/** Write the declared state for a STAMPED handover. {ok, path?, reason?}. Never throws. */
function writeDeclaredHandover(dirInfo, h, declaredAt) {
  const p = declaredPath(dirInfo, h && h.session_id);
  if (!p) return { ok: false, reason: "no handoff dir or no valid session id — declared state not written" };
  const unsafe = declaredDirUnsafe(p, dirInfo);
  if (unsafe) return { ok: false, path: p.file, reason: unsafe };
  const w = meter.writeJsonAtomic(p.dir, p.file, {
    _contract: DECLARED_CONTRACT,
    schema: DECLARED_SCHEMA,
    session_id: h.session_id,
    declared_at: declaredAt,
    seed_sha256: h.seed_sha256,
    seed_path: h.seed_path,
    resume_token: h.resume_token,
    repo: dirInfo.realCheckout || null,
  });
  return w.ok ? { ok: true, path: p.file } : { ok: false, path: p.file, reason: w.reason };
}

/**
 * The next context started from `seedSha` of `sessionId`'s handover: remove its declared
 * state. Removes ONLY a file naming that seed. {ok, removed, reason?}. Never throws.
 */
function consumeDeclaredHandover(dirInfo, sessionId, seedSha) {
  if (!dirInfo || !dirInfo.ok || !dirInfo.canonicalBoundary) return { ok: false, removed: false, reason: "no handoff dir" };
  const p = declaredPath(dirInfo, sessionId);
  // writeDeclaredHandover requires a valid session id, so none can exist under an absent one.
  if (!p) return { ok: true, removed: false, reason: "no declaring session id — nothing was declared under it" };
  const unsafe = declaredDirUnsafe(p, dirInfo);
  if (unsafe) return { ok: false, removed: false, reason: unsafe };
  const r = readDeclaredFile(p.file);
  if (!r.ok) return r.code === "ENOENT" ? { ok: true, removed: false, reason: "no declared state" } : { ok: false, removed: false, reason: r.reason };
  const cur = r.data;
  if (!isObj(cur) || cur.seed_sha256 !== seedSha) return { ok: true, removed: false, reason: "declared state names a different seed — left in place" };
  try {
    fs.unlinkSync(p.file);
    return { ok: true, removed: true };
  } catch (e) {
    return { ok: false, removed: false, reason: (e && e.code) || "unlink failed" };
  }
}

/**
 * SEC-F7: a session that ENDS without a /clear will never be resumed from its declared
 * handover, so its declared state is retired — a watcher must not read a dead session as a
 * stalled handover. Removes `sessionId`'s file whatever seed it names. {ok, removed, reason?}.
 */
function retireDeclaredHandover(dirInfo, sessionId) {
  if (!dirInfo || !dirInfo.ok || !dirInfo.canonicalBoundary) return { ok: false, removed: false, reason: "no handoff dir" };
  const p = declaredPath(dirInfo, sessionId);
  if (!p) return { ok: true, removed: false, reason: "no session id" };
  const unsafe = declaredDirUnsafe(p, dirInfo);
  if (unsafe) return { ok: false, removed: false, reason: unsafe };
  try {
    fs.unlinkSync(p.file);
    return { ok: true, removed: true };
  } catch (e) {
    return e && e.code === "ENOENT" ? { ok: true, removed: false, reason: "no declared state" } : { ok: false, removed: false, reason: (e && e.code) || "unlink failed" };
  }
}

// ── the seed ─────────────────────────────────────────────────────────────────

/**
 * Read a seed file under containment. `dirInfo` is compaction-handoff.js::resolveHandoffDir
 * output. The candidate is resolved through realpath and must equal the handoff dir anchored
 * on the canonical checkout (anchoredLearningPath), which needs `dirInfo.realCheckout`; the file must
 * be a DIRECT child named seed-*.md, not a symlink, not hard-linked (nlink 1), a regular
 * file, ≤ SEED_READ_CAP_BYTES, and the inode OPENED must be the inode lstat'd (so a swap
 * between the checks and the open is refused even where O_NOFOLLOW is unavailable).
 * {ok, text, sha256, bytes, path} | {ok:false, code, reason}
 */
function readSeedFile(seedPath, dirInfo) {
  const no = (code, reason) => ({ ok: false, code, reason });
  if (typeof seedPath !== "string" || !path.isAbsolute(seedPath)) return no("seed-path-invalid", "seed_path is not an absolute path");
  if (!SEED_NAME_RE.test(path.basename(seedPath))) return no("seed-path-invalid", `seed file name ${JSON.stringify(path.basename(seedPath).slice(0, 80))} is not seed-*.md`);
  if (!dirInfo || !dirInfo.ok) return no("seed-dir-unresolved", (dirInfo && dirInfo.reason) || "handoff dir unresolved");
  let realDir;
  try {
    realDir = fs.realpathSync(dirInfo.dir);
  } catch {
    return no("seed-dir-unresolved", "handoff dir does not exist");
  }
  // Anchored on the canonical checkout, never on a boundary resolved through
  // .claude or .claude/learning — see anchoredLearningPath.
  const expected = anchoredLearningPath(dirInfo, "handoff");
  if (!expected) return no("seed-dir-unresolved", "main checkout absent or unresolvable — no anchor for the handoff dir");
  if (realDir !== expected) return no("seed-containment", `handoff dir resolves to ${realDir}, outside ${expected}`);
  let lst;
  try {
    lst = fs.lstatSync(seedPath);
  } catch (e) {
    return no("seed-missing", `seed file ${seedPath} is absent (${(e && e.code) || "stat failed"})`);
  }
  if (lst.isSymbolicLink()) return no("seed-containment", "seed file is a symlink — refused");
  if (lst.nlink > 1) return no("seed-hardlinked", `seed file has ${lst.nlink} hard links — refused (a link can alias a file outside the handoff dir)`);
  let realSeed;
  try {
    realSeed = fs.realpathSync(seedPath);
  } catch {
    return no("seed-missing", "seed file could not be canonicalized");
  }
  if (path.dirname(realSeed) !== realDir) return no("seed-containment", `seed file resolves to ${realSeed}, outside ${realDir}`);
  const g = openGuards();
  let fd;
  try {
    fd = fs.openSync(realSeed, fs.constants.O_RDONLY | g.nofollow | g.nonblock);
  } catch (e) {
    return no("seed-unreadable", `seed file could not be opened (${(e && e.code) || "error"})`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return no("seed-unreadable", "seed path is not a regular file");
    if (st.ino !== lst.ino || st.dev !== lst.dev) return no("seed-containment", "the seed file was replaced between its checks and its open — refused");
    if (st.nlink > 1) return no("seed-hardlinked", `seed file has ${st.nlink} hard links — refused`);
    if (st.size > SEED_READ_CAP_BYTES) return no("seed-over-cap", `seed file is ${st.size} bytes, over the ${SEED_READ_CAP_BYTES}-byte cap`);
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    const b = buf.subarray(0, n);
    return { ok: true, text: b.toString("utf8"), sha256: sha256(b), bytes: n, path: realSeed };
  } catch (e) {
    return no("seed-unreadable", `seed read failed (${(e && e.code) || "error"})`);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* closed */
    }
  }
}

/** Re-hash the handover's seed and compare. {ok, read?, code?, reason?} */
function verifyHandoverSeed(handover, dirInfo) {
  if (!isObj(handover)) return { ok: false, code: "no-handover", reason: "no handover recorded" };
  if (typeof handover.seed_sha256 !== "string" || !SHA256_RE.test(handover.seed_sha256)) {
    return { ok: false, code: "seed-sha-invalid", reason: "handover.seed_sha256 is not 64 lowercase hex" };
  }
  const r = readSeedFile(handover.seed_path, dirInfo);
  if (!r.ok) return r;
  if (r.sha256 !== handover.seed_sha256) {
    return { ok: false, code: "seed-sha-mismatch", reason: `seed re-hashes to ${r.sha256.slice(0, 8)}, the record says ${handover.seed_sha256.slice(0, 8)}`, read: r };
  }
  return { ok: true, read: r };
}

/**
 * THE CANDIDATE PREDICATE. `verify(handover, state)` → {ok, reason}: the hook passes
 * lib/boundary-seed.js::readinessVerdict (planInjection — the injector's OWN decision, so
 * readiness can never be true for a seed the next SessionStart would refuse).
 * Returns {ready, reasons[], escalations[]}; ready only when every conjunct POSITIVELY holds.
 */
function computeReady(state, verify, options = {}) {
  const reasons = [];
  if (Object.prototype.hasOwnProperty.call(options, "payload")) {
    const queueReason = pendingFindingsReason(options.payload);
    if (queueReason) reasons.push(queueReason);
  }
  const s = isObj(state) ? state : {};
  const h = isObj(s.handover) ? s.handover : null;
  const b = isObj(s.boundary) ? s.boundary : {};
  // csq contract (2026-10-10): no handover is due — so no boundary may be taken — when the
  // handover point is unknown/null (csq handover_status below_floor / no_backstop: CC's
  // autocompact is then the only boundary), or when the meter SUPPRESSED the handover
  // because the session's FIRST reading already sat at/over it ("start-above-handover"):
  // clearing such a session re-enters above the point and loops handover → /clear.
  const pts = isObj(s.points) ? s.points : {};
  const hp = Number.isInteger(pts.handover_tokens) && pts.handover_tokens > 0 ? pts.handover_tokens : null;
  if (hp === null) {
    reasons.push(`points.handover_tokens is ${JSON.stringify(pts.handover_tokens === undefined ? null : pts.handover_tokens)} — no handover is due; CC autocompact is the only boundary`);
  }
  const suppressed = [s.handover_suppressed, pts.handover_suppressed, h && h.handover_suppressed].find((x) => x !== undefined && x !== null && x !== false);
  if (suppressed !== undefined) reasons.push(`handover suppressed by the meter (${JSON.stringify(suppressed)})`);
  // M3 — the CONTEXT is full enough, the points are sane against this session's start, and
  // the seed is not stale relative to the current reading.
  const tok = isObj(s.tokens) ? s.tokens : {};
  const used = Number.isInteger(tok.used) && tok.used > 0 ? tok.used : null;
  if (used === null) reasons.push("current context reading is UNKNOWN (tokens.used not a positive integer)");
  else if (hp !== null && used < hp) reasons.push(`context ${used} is below the handover point ${hp} — no boundary is due`);
  const start = Number.isInteger(tok.session_start) && tok.session_start > 0 ? tok.session_start : null;
  if (start === null) reasons.push("this session's first measured reading (tokens.session_start) is UNKNOWN — the handover point cannot be sanity-checked");
  else if (hp !== null && hp - start < MIN_SESSION_GROWTH_TOKENS) {
    reasons.push(`points sanity: handover point ${hp} is within ${MIN_SESSION_GROWTH_TOKENS} of the session's first reading ${start} — a fresh context would hand over again (refused)`);
  }
  if (!h || h.state !== "written") reasons.push(`handover.state is ${h ? JSON.stringify(h.state) : "absent"}, not "written"`);
  if (h && h.emergency === true) reasons.push("the handover is an EMERGENCY seed (written mechanically at compaction) — never a /clear boundary");
  if (h && h.state === "written") {
    if (!Number.isInteger(h.at_tokens) || h.at_tokens <= 0) reasons.push("seed staleness UNKNOWN (handover.at_tokens not a positive integer)");
    else if (used !== null && used - h.at_tokens > FRESH_SEED_MAX_TOKEN_LAG) reasons.push(`seed is stale: written at ${h.at_tokens} tokens, now ${used} (> ${FRESH_SEED_MAX_TOKEN_LAG} behind)`);
  }
  if (b.last_event !== "Stop") reasons.push(`last lifecycle event is ${JSON.stringify(b.last_event === undefined ? null : b.last_event)}, not "Stop"`);
  if (!(Number.isInteger(b.background_agents) && b.background_agents === 0)) {
    reasons.push(
      Number.isInteger(b.background_agents)
        ? `${b.background_agents} background agent(s) still running (agents and background tasks)`
        : `background agent count UNKNOWN${b.background_agents_reason ? ` (${b.background_agents_reason})` : ""}`,
    );
  }
  const escalations = Array.isArray(b.escalations) ? b.escalations.filter(isObj) : [];
  for (const e of escalations.slice(0, 8)) reasons.push(`[${String(e.code).slice(0, 40)}] ${String(e.text || "").slice(0, 300)}`);
  if (h && h.state === "written") {
    let v;
    try {
      v = typeof verify === "function" ? verify(h, s) : { ok: false, reason: "no seed verifier" };
    } catch (e) {
      v = { ok: false, reason: `seed verifier threw (${(e && e.message) || e})` };
    }
    if (!v || v.ok !== true) reasons.push(`seed would NOT be injected: ${(v && v.reason) || "unknown"}`);
    const bound = handoverBoundReason(h, b);
    if (bound) reasons.push(bound);
    // M6e: a conjunct that can only ADD a refusal — nothing said after the seed is lost.
    if (h.emergency !== true) {
      let tf;
      try {
        tf = tailFenceVerdict(h);
      } catch (e) {
        tf = { ok: false, code: "tail-unverified", reason: `tail-loss fence threw (${(e && e.message) || e})` };
      }
      if (!tf || tf.ok !== true) reasons.push(`[${(tf && tf.code) || "tail-unverified"}] ${(tf && tf.reason) || "tail-loss fence returned no verdict"}`);
    }
  }
  return { ready: reasons.length === 0, reasons, escalations };
}

/** Boundary fields for a NON-Stop lifecycle/tool event: the session is not idle. */
function activityBoundary(prev, event, nowIso) {
  const b = isObj(prev && prev.boundary) ? prev.boundary : {};
  return {
    ...b,
    ready: false,
    committed: false,
    awaiting_commit: false,
    idle: false,
    last_event: typeof event === "string" ? event : null,
    last_event_at: nowIso,
    preferred: "clear",
    reasons: [`last lifecycle event is ${JSON.stringify(event)}, not "Stop"`],
  };
}

/**
 * Validate a `handover` object before it is stamped (the S2 renderer's receipt shape,
 * bin/lib/handover-render.mjs::renderProjections().handover). Returns {ok, handover|reason}.
 */
function normalizeHandover(h) {
  if (!isObj(h)) return { ok: false, reason: "handover is not an object" };
  if (!HANDOVER_STATES.includes(h.state)) return { ok: false, reason: `handover.state ${JSON.stringify(h.state)} is not one of ${HANDOVER_STATES.join("|")}` };
  if (h.state === "written" || h.state === "writing") {
    if (typeof h.seed_path !== "string" || !path.isAbsolute(h.seed_path) || !SEED_NAME_RE.test(path.basename(h.seed_path))) return { ok: false, reason: "handover.seed_path must be an absolute seed-*.md path" };
    if (typeof h.seed_sha256 !== "string" || !SHA256_RE.test(h.seed_sha256)) return { ok: false, reason: "handover.seed_sha256 must be 64 lowercase hex" };
    if (typeof h.resume_token !== "string" || !RESUME_TOKEN_RE.test(h.resume_token)) return { ok: false, reason: "handover.resume_token must be 8 lowercase hex" };
  }
  const out = {
    state: h.state,
    seed_path: typeof h.seed_path === "string" ? h.seed_path : null,
    seed_sha256: typeof h.seed_sha256 === "string" ? h.seed_sha256 : null,
    session_id: meter.activitySessionId(h.session_id),
    seed_bytes: Number.isInteger(h.seed_bytes) ? h.seed_bytes : null,
    resume_token: typeof h.resume_token === "string" ? h.resume_token : null,
    at_tokens: Number.isInteger(h.at_tokens) ? h.at_tokens : null,
    written_at: typeof h.written_at === "string" ? h.written_at : null,
    first_written_at: typeof h.first_written_at === "string" ? h.first_written_at.slice(0, 40) : null,
    declared_written: typeof h.declared_written === "string" ? h.declared_written.slice(0, 40) : null,
    transcript_path: typeof h.transcript_path === "string" && path.isAbsolute(h.transcript_path) ? h.transcript_path : null,
    seed_offset: Number.isInteger(h.seed_offset) && h.seed_offset >= 0 ? h.seed_offset : null,
    render_offset: Number.isInteger(h.render_offset) && h.render_offset >= 0 ? h.render_offset : null,
    transcript_ino: Number.isInteger(h.transcript_ino) ? h.transcript_ino : null,
    transcript_dev: Number.isInteger(h.transcript_dev) ? h.transcript_dev : null,
    transcript_reason: typeof h.transcript_reason === "string" ? h.transcript_reason.slice(0, 200) : null,
    projections: isObj(h.projections) ? h.projections : {},
    errors: Array.isArray(h.errors) ? h.errors.filter((e) => typeof e === "string").slice(0, 20) : [],
    emergency: h.emergency === true,
    stamped_by: typeof h.stamped_by === "string" ? h.stamped_by.slice(0, 60) : null,
  };
  return { ok: true, handover: out };
}

/**
 * THE S2 INTERFACE: stamp a handover into this terminal's record, after re-hashing the
 * seed under containment. `where` = {configDir, repoDir, pid}; `dirInfo` = resolveHandoffDir.
 * A seed that does not re-hash to the claimed sha is REFUSED (never stamped). A configDir
 * that is set but is not an existing directory is REFUSED (code
 * `config-dir-not-a-directory`) — the record's location is never guessed.
 */
function validateRenderedSeed(where, handover, { dirInfo } = {}) {
  const n = normalizeHandover(handover);
  if (!n.ok) return n;
  const loc = locateState(where || {});
  if (!loc.ok) return { ok: false, code: loc.code || "state-unlocatable", reason: loc.reason };
  const v = verifyHandoverSeed(n.handover, dirInfo);
  if (!v.ok) return v;
  const st = readState(loc);
  const prior = st.state === "ok" && st.data.handover;
  const activity = readActivity(loc);
  const sid = prior && meter.activitySessionId(prior.session_id);
  if (!sid || activity.state !== "ok" || meter.activitySessionId(activity.session_id) !== sid) {
    return { ok: false, reason: "seed has no current session binding; write the seed through this session's Write/Edit hook before rendering" };
  }
  if (prior.seed_path !== v.read.path || prior.seed_sha256 !== v.read.sha256) {
    return { ok: false, reason: "seed path/hash does not match this session's seed-write provenance" };
  }
  // The transcript position comes from the HOOK's record of the seed write — never from the
  // caller's receipt — so the renderer cannot move the tail-loss fence's cutoff.
  const transcript = {
    path: typeof prior.transcript_path === "string" && path.isAbsolute(prior.transcript_path) ? prior.transcript_path : null,
    seed_offset: Number.isInteger(prior.seed_offset) && prior.seed_offset >= 0 ? prior.seed_offset : null,
    ino: Number.isInteger(prior.transcript_ino) ? prior.transcript_ino : null,
    dev: Number.isInteger(prior.transcript_dev) ? prior.transcript_dev : null,
    reason: typeof prior.transcript_reason === "string" ? prior.transcript_reason : null,
    first_written_at: typeof prior.first_written_at === "string" ? prior.first_written_at : typeof prior.written_at === "string" ? prior.written_at : null,
  };
  return { ok: true, read: v.read, session_id: sid, transcript, at_tokens: Number.isSafeInteger(prior.at_tokens) && prior.at_tokens > 0 ? prior.at_tokens : null };
}

function stampHandover(where, handover, { dirInfo, nowIso } = {}) {
  const n = normalizeHandover(handover);
  if (!n.ok) return n;
  const loc = locateState(where || {});
  if (!loc.ok) return { ok: false, code: loc.code || "state-unlocatable", reason: `refused: ${loc.reason}` };
  let tail = null;
  if (n.handover.state === "written" || n.handover.state === "writing") {
    const v = validateRenderedSeed(where, n.handover, { dirInfo });
    if (!v.ok) return { ok: false, reason: `refused: ${v.reason}` };
    n.handover.seed_bytes = v.read.bytes;
    n.handover.at_tokens = v.at_tokens;
    n.handover.session_id = v.session_id;
    // The fence's positions: the seed-write offset from the hook's record, the render offset
    // measured NOW (the stamp is the render's last step). Any receipt-supplied value is replaced.
    const t = v.transcript;
    Object.assign(n.handover, { transcript_path: t.path, seed_offset: t.seed_offset, transcript_ino: t.ino, transcript_dev: t.dev, render_offset: null, transcript_reason: t.reason, first_written_at: t.first_written_at });
    if (t.path && Number.isInteger(t.seed_offset) && Number.isInteger(t.ino) && Number.isInteger(t.dev)) {
      const at = transcriptSize(t.path);
      if (!at.ok) n.handover.transcript_reason = `transcript unreadable at render (${at.reason})`;
      else if (at.ino !== t.ino || at.dev !== t.dev) n.handover.transcript_reason = "transcript replaced between the seed write and the render";
      else if (at.size < t.seed_offset) n.handover.transcript_reason = "transcript shorter at render than at the seed write";
      else n.handover.render_offset = at.size;
    } else if (!n.handover.transcript_reason) {
      n.handover.transcript_reason = "the seed-write hook recorded no transcript position";
    }
    if (n.handover.state === "written") {
      tail = tailFenceVerdict(n.handover);
      // Content ALREADY after the seed at render time: this seed can never be a boundary.
      if (!tail.ok && tail.code === "tail-after-seed") return { ok: false, code: "tail-after-seed", reason: `refused: ${tail.reason}`, tail };
    }
  }
  const now = nowIso || new Date().toISOString();
  const w = updateContextState(loc, (prev) => ({
    updated_at: now,
    handover: { ...n.handover, stamped_at: now },
    boundary: { ...(isObj(prev.boundary) ? prev.boundary : {}), ready: false, committed: false, awaiting_commit: false, reasons: ["handover re-stamped; readiness is re-evaluated at the next Stop"] },
  }));
  if (!w.ok || n.handover.state !== "written") return tail ? { ...w, tail } : w;
  // The declared-handover machine state, written ONLY once the record says written.
  const declared = writeDeclaredHandover(dirInfo, n.handover, n.handover.written_at || now);
  return { ...w, tail, declared };
}

/**
 * SEED-FIRST (CYCLE.md §1.4 step 1): the moment the agent's `Write` of a seed lands, the
 * seed must already be usable by a boundary — before any renderer runs. Called by the
 * meter on a main-thread PostToolUse. Returns the `handover` to store, or null when the
 * call did not write a seed / nothing changes. A seed the validator REFUSES never
 * replaces a recorded one: it is noted in `last_refused` (loud, never silent).
 * `validate` = lib/handover-seed.js::validateSeed (injected; absent ⇒ null + reason).
 */
function observeSeedWrite(prevHandover, payload, { dirInfo, validate, nowIso, atTokens = null } = {}) {
  const p = isObj(payload) ? payload : {};
  if (!["Write", "Edit", "MultiEdit"].includes(p.tool_name)) return null;
  const fp = isObj(p.tool_input) && typeof p.tool_input.file_path === "string" ? p.tool_input.file_path : null;
  if (!fp || !SEED_NAME_RE.test(path.basename(fp))) return null;
  if (!dirInfo || !dirInfo.ok) return null;
  let realDir;
  try {
    realDir = fs.realpathSync(dirInfo.dir);
  } catch {
    return null;
  }
  let realParent;
  try {
    realParent = fs.realpathSync(path.dirname(path.resolve(fp)));
  } catch {
    return null;
  }
  if (realParent !== realDir) return null; // a seed-named file elsewhere is not a handover
  const prev = isObj(prevHandover) ? prevHandover : {};
  const r = readSeedFile(path.join(realDir, path.basename(fp)), dirInfo);
  if (!r.ok) return { ...prev, last_refused: { at: nowIso, path: fp, reason: r.reason } };
  if (typeof validate !== "function") return { ...prev, last_refused: { at: nowIso, path: r.path, reason: "seed validator (lib/handover-seed.js) unavailable" } };
  const sid = meter.activitySessionId(p.session_id);
  if (!sid) return { ...prev, last_refused: { at: nowIso, path: r.path, reason: "seed write has no trusted session_id" } };
  const v = validate(r.text, { repoDir: dirInfo.repoRoot || p.cwd || process.cwd() });
  if (!v || v.ok !== true) {
    const codes = v && Array.isArray(v.findings) ? [...new Set(v.findings.map((f) => f.code))].slice(0, 6).join(",") : "unknown";
    return { ...prev, last_refused: { at: nowIso, path: r.path, sha256: r.sha256, reason: `seed REFUSED by the validator (${codes})` } };
  }
  if (prev.seed_sha256 === r.sha256 && prev.session_id === sid && ["written", "injected", "consumed"].includes(prev.state)) return null;
  // Where the transcript stood when the seed's bytes landed: the tail-loss fence's cutoff.
  const tp = transcriptSize(p.transcript_path);
  // An Edit of the SAME seed file (before or after its stamp) never advances the cutoff or the
  // seed's age (S2): fixing a header label must not re-freshen content written earlier, nor
  // move the fence past input that arrived between the first write and the edit. Only a NEW
  // seed file (a rewrite) starts a new cutoff.
  const same = (prev.state === "writing" || prev.state === "written") && prev.session_id === sid && prev.seed_path === r.path && tp.ok && prev.transcript_path === tp.path && prev.transcript_ino === tp.ino && prev.transcript_dev === tp.dev && Number.isInteger(prev.seed_offset) && prev.seed_offset <= tp.size;
  const firstWritten = same && typeof prev.first_written_at === "string" ? prev.first_written_at : same && typeof prev.written_at === "string" ? prev.written_at : nowIso || new Date().toISOString();
  return {
    state: "writing",
    session_id: sid,
    seed_path: r.path,
    seed_sha256: r.sha256,
    seed_bytes: r.bytes,
    resume_token: v.header.resume_token,
    at_tokens: Number.isSafeInteger(atTokens) && atTokens > 0 ? atTokens : null,
    // The HOOK's clock at the moment the seed bytes landed — never the seed's hand-typed
    // written= (measured 2026-10-11: declared 19 min in the future, which pushed this
    // record's 24 h staleness bound forward by the same 19 min). The declared value is
    // kept beside it for the record, not trusted.
    written_at: nowIso || new Date().toISOString(),
    first_written_at: firstWritten,
    declared_written: v.header.written || null,
    transcript_path: tp.ok ? tp.path : null,
    seed_offset: same ? prev.seed_offset : tp.ok ? tp.size : null,
    transcript_ino: tp.ok ? tp.ino : null,
    transcript_dev: tp.ok ? tp.dev : null,
    transcript_reason: tp.ok ? null : `no transcript position at the seed write (${tp.reason})`,
    projections: {},
    errors: [],
    emergency: false,
    stamped_by: "seed-write",
    stamped_at: nowIso,
  };
}

// ── the incremental transcript scan (agents + resume ack) ─────────────────────

/**
 * Read complete lines from `fromOffset`, at most `maxBytes`. Offsets are RAW BYTE offsets
 * (the byte after the last newline consumed) — never derived from decoded text, so a
 * multibyte character split across a chunk boundary cannot skew them. A torn final line
 * (bytes after the last newline at EOF) is NOT caught up. A single line longer than the
 * whole window is SKIPPED loudly: `oversized:true`, the offset advances past the window
 * and `skipToNewline` drops the rest of that line on the next call.
 */
function readIncrement(transcriptPath, fromOffset, maxBytes, { skipToNewline = false } = {}) {
  let fd;
  try {
    const g = openGuards();
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | g.nofollow | g.nonblock);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "transcript is not a regular file" };
    // An offset past EOF means the file was replaced or truncated: rescan from 0.
    const valid = Number.isInteger(fromOffset) && fromOffset >= 0 && fromOffset <= st.size;
    const from = valid ? fromOffset : 0;
    let skipping = valid ? !!skipToNewline : false;
    const lines = [];
    const limit = Math.min(st.size, from + Math.max(0, maxBytes));
    let pos = from;
    let lineStart = from;
    let partial = [];
    while (pos < limit) {
      const len = Math.min(SCAN_CHUNK_BYTES, limit - pos);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      if (n <= 0) break;
      const chunk = buf.subarray(0, n);
      let segStart = 0;
      for (let idx = chunk.indexOf(0x0a); idx !== -1; idx = chunk.indexOf(0x0a, idx + 1)) {
        if (skipping) skipping = false;
        else lines.push(Buffer.concat([...partial, chunk.subarray(segStart, idx)]).toString("utf8"));
        partial = [];
        segStart = idx + 1;
        lineStart = pos + idx + 1;
      }
      if (segStart < n && !skipping) partial.push(chunk.subarray(segStart));
      pos += n;
    }
    const carry = pos - lineStart;
    // No newline anywhere in a FULL window: one line longer than the window. Skip it.
    if (lineStart === from && pos >= limit && limit < st.size && carry === limit - from && limit > from) {
      return { ok: true, lines: [], offset: limit, size: st.size, caughtUp: false, skipToNewline: true, oversized: true };
    }
    return { ok: true, lines, offset: lineStart, size: st.size, caughtUp: pos >= st.size && carry === 0 && !skipping, skipToNewline: skipping, tornTail: pos >= st.size && carry > 0 };
  } catch (e) {
    return { ok: false, code: e && e.code, reason: `transcript scan failed (${(e && e.code) || (e && e.message) || "error"})` };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
    }
  }
}

function emptyAgents() {
  return { transcript: null, offset: 0, skip_to_newline: false, pending: Object.create(null), open: Object.create(null), known: Object.create(null), pruned: 0, untracked_live: 0, lost_tail: null };
}

function cloneAgents(a) {
  const src = isObj(a) ? a : emptyAgents();
  const agents = {
    transcript: typeof src.transcript === "string" ? src.transcript : null,
    offset: Number.isInteger(src.offset) && src.offset >= 0 ? src.offset : 0,
    skip_to_newline: src.skip_to_newline === true,
    pending: Object.assign(Object.create(null), isObj(src.pending) ? src.pending : {}),
    open: Object.assign(Object.create(null), isObj(src.open) ? src.open : {}),
    known: Object.assign(Object.create(null), isObj(src.known) ? src.known : {}),
    pruned: Number.isInteger(src.pruned) && src.pruned >= 0 ? src.pruned : 0,
    untracked_live: src.untracked_live === undefined ? 0 : Number.isSafeInteger(src.untracked_live) && src.untracked_live >= 0 ? src.untracked_live : Number.MAX_SAFE_INTEGER,
    lost_tail: isObj(src.lost_tail) ? { ...src.lost_tail } : null,
  };
  boundAgents(agents);
  return agents;
}

function addUntracked(agents, count = 1) {
  agents.untracked_live = Math.min(Number.MAX_SAFE_INTEGER, agents.untracked_live + count);
}

function boundAgents(agents) {
  let retained = 0;
  for (const entries of [agents.open, agents.pending]) {
    for (const id of Object.keys(entries)) {
      if (retained++ < MAX_TRACKED_AGENTS) continue;
      delete entries[id];
      addUntracked(agents);
    }
  }
  const known = Object.keys(agents.known);
  const drop = Math.max(0, known.length - MAX_KNOWN_AGENTS);
  for (const id of known.slice(0, drop)) delete agents.known[id];
  agents.pruned = Math.min(Number.MAX_SAFE_INTEGER, agents.pruned + drop);
}

function recordLive(agents, bucket, id, entry) {
  if (id.length > 160 || (!Object.hasOwn(agents[bucket], id) && Object.keys(agents.open).length + Object.keys(agents.pending).length >= MAX_TRACKED_AGENTS)) {
    addUntracked(agents);
    return;
  }
  agents[bucket][id] = entry;
}

function recordKnown(agents, id, entry) {
  agents.known[id] = entry;
  boundAgents(agents);
}

function firstTextLine(s) {
  for (const l of String(s).split("\n")) if (l.trim()) return l.trim();
  return "";
}

const ID_CHARS = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * The text of a GENUINE task notification, or null. Only the three measured record forms
 * (header comment) qualify, and the text must BEGIN with `<task-notification>`.
 */
function notificationText(e) {
  let t = null;
  if (e.type === "queue-operation" && (e.operation === "enqueue" || e.operation === "remove")) t = e.content;
  else if (e.type === "attachment" && isObj(e.attachment) && e.attachment.type === "queued_command" && e.attachment.commandMode === "task-notification") t = e.attachment.prompt;
  else if (e.type === "user" && isObj(e.origin) && e.origin.kind === "task-notification" && isObj(e.message)) t = e.message.content;
  if (typeof t !== "string") return null;
  const s = t.replace(/^[ \t\r\n]+/, "");
  return s.startsWith("<task-notification>") ? s : null;
}

/** Header fields of a notification: ONLY whole lines before `<summary>`/`<event>`. */
function parseNotification(text) {
  const end = text.search(/\n<(summary|event)>|<\/task-notification>/);
  const head = end === -1 ? text : text.slice(0, end);
  const field = (tag) => {
    const m = head.match(new RegExp(`^<${tag}>([^<\\n]{1,200})</${tag}>$`, "m"));
    return m ? m[1] : null;
  };
  const taskId = field("task-id");
  const toolUseId = field("tool-use-id");
  const status = field("status");
  return {
    taskId: taskId && ID_CHARS.test(taskId) ? taskId : null,
    toolUseId: toolUseId && ID_CHARS.test(toolUseId) ? toolUseId : null,
    status: status && /^[a-z_]{1,40}$/.test(status) ? status : null,
  };
}

/** The ONE open entry a notification names, or null (never a guess). */
function pairNotification(agents, n) {
  if (n.toolUseId) {
    if (!Object.prototype.hasOwnProperty.call(agents.open, n.toolUseId)) return null;
    const e = agents.open[n.toolUseId];
    if (!e) return null;
    const ids = [e.agent_id, e.task_id].filter(Boolean);
    if (n.taskId && ids.length && !ids.includes(n.taskId)) return null; // disagreeing ids close nothing
    return n.toolUseId;
  }
  if (!n.taskId) return null;
  const hits = Object.keys(agents.open).filter((id) => agents.open[id] && (agents.open[id].agent_id === n.taskId || agents.open[id].task_id === n.taskId));
  return hits.length === 1 ? hits[0] : null;
}

/** Apply one transcript line to the agents ledger and the resume progress. Pure. */
function applyLine(line, agents, resume, ctx) {
  const interesting = line.includes("tool_use") || line.includes("task-notification") || (resume && line.includes('"assistant"'));
  if (!interesting) return;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return; // torn row
  }
  if (!isObj(e) || e.isSidechain === true) return;
  const ts = typeof e.timestamp === "string" ? e.timestamp.slice(0, 80) : null;
  const content = isObj(e.message) && Array.isArray(e.message.content) ? e.message.content : [];
  if (e.type === "assistant") {
    for (const b of content) {
      if (!isObj(b) || b.type !== "tool_use" || typeof b.id !== "string") continue;
      const inp = isObj(b.input) ? b.input : {};
      if (b.name === "Agent" || b.name === "Task") {
        recordLive(agents, "pending", b.id, { kind: "agent", name: typeof inp.name === "string" ? inp.name.slice(0, 80) : null, at: ts, seen_at: ctx.nowIso });
      } else if (b.name === "Bash" && inp.run_in_background === true) {
        recordLive(agents, "pending", b.id, { kind: "bash", name: typeof inp.description === "string" ? inp.description.slice(0, 80) : null, at: ts, seen_at: ctx.nowIso });
      } else if (b.name === "SendMessage" && typeof inp.to === "string") {
        const to = inp.to;
        let matched = false;
        for (const [id, k] of Object.entries(agents.known)) {
          if (k && (k.agent_id === to || (k.name && k.name === to))) {
            recordLive(agents, "open", id, { ...k, reopened_at: ts || ctx.nowIso, last_seen: ts || ctx.nowIso });
            delete agents.known[id];
            matched = true;
          }
        }
        for (const [id, k] of Object.entries(agents.open)) {
          if (k && (k.agent_id === to || (k.name && k.name === to))) {
            recordLive(agents, "open", id, { ...k, last_seen: ts || ctx.nowIso });
            matched = true;
          }
        }
        // The target may be an agent whose closed entry was PRUNED: then it cannot be told
        // apart from a non-agent target, so it is OPEN (fail closed; surfaced if silent).
        if (!matched && agents.pruned > 0) recordLive(agents, "open", `sm:${b.id}`, { kind: "unmatched-sendmessage", name: to.slice(0, 80), agent_id: to.slice(0, 80), at: ts, seen_at: ctx.nowIso, reopened_at: ts || ctx.nowIso });
      }
    }
    if (resume && resume.pending && ctx.afterMs !== null) {
      const t = Date.parse(e.timestamp || "");
      if (Number.isFinite(t) && t >= ctx.afterMs && (!ctx.sessionId || e.sessionId === undefined || e.sessionId === ctx.sessionId)) {
        for (const b of content) {
          if (!isObj(b)) continue;
          if (b.type === "text" && !resume.text_checked && typeof b.text === "string" && b.text.trim()) {
            resume.text_checked = true;
            resume.token_echoed = new RegExp(`\\b${ctx.token}\\b`).test(firstTextLine(b.text));
          }
          if (b.type === "tool_use" && !resume.first_action_id && typeof b.id === "string") {
            const inp = isObj(b.input) ? b.input : {};
            const target = [inp.command, inp.file_path, inp.path, inp.pattern, inp.to, inp.description].find((x) => typeof x === "string");
            resume.first_action_id = b.id;
            resume.first_action = { tool: String(b.name || "").slice(0, 60), target: target ? target.slice(0, 160) : null };
          }
        }
      }
    }
    return;
  }
  if (e.type === "user" && content.length) {
    const tur = isObj(e.toolUseResult) ? e.toolUseResult : null;
    for (const b of content) {
      if (!isObj(b) || b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const p = Object.prototype.hasOwnProperty.call(agents.pending, b.tool_use_id) ? agents.pending[b.tool_use_id] : null;
      if (!p) continue;
      delete agents.pending[b.tool_use_id];
      const str = (v) => (typeof v === "string" ? v.slice(0, 80) : null);
      if (b.is_error === true) {
        recordKnown(agents, b.tool_use_id, { ...p, agent_id: null, ended: "launch-error" });
        continue;
      }
      if (p.kind === "bash") {
        if (tur && typeof tur.backgroundTaskId === "string") recordLive(agents, "open", b.tool_use_id, { ...p, task_id: str(tur.backgroundTaskId), shape: "bash-background" });
        else recordLive(agents, "open", b.tool_use_id, { ...p, shape: "unrecognized" });
        continue;
      }
      const agentId = tur ? str(tur.agentId) || str(tur.agent_id) : null;
      if (tur && (tur.isAsync === true || tur.status === "async_launched")) recordLive(agents, "open", b.tool_use_id, { ...p, agent_id: agentId, shape: "async" });
      else if (tur && tur.status === "teammate_spawned") recordLive(agents, "open", b.tool_use_id, { ...p, agent_id: agentId, name: p.name || str(tur.name), shape: "teammate" });
      else if (tur && tur.status === "completed") recordKnown(agents, b.tool_use_id, { ...p, agent_id: agentId });
      else recordLive(agents, "open", b.tool_use_id, { ...p, agent_id: agentId, shape: "unrecognized" });
    }
  }
  const text = notificationText(e);
  if (text) {
    const n = parseNotification(text);
    const id = pairNotification(agents, n);
    if (id) {
      if (n.status && TERMINAL_TASK_STATUSES.has(n.status)) {
        recordKnown(agents, id, { ...agents.open[id], ended: n.status });
        delete agents.open[id];
      } else {
        recordLive(agents, "open", id, { ...agents.open[id], last_seen: ts || ctx.nowIso });
      }
    }
  }
}

/** Open entries with no transcript evidence for SILENT_AGENT_ESCALATE_MS — surfaced, never closed. */
function silentEscalations(agents, nowMs) {
  const out = [];
  for (const [id, e] of Object.entries(agents.open)) {
    if (!isObj(e)) continue;
    const last = Math.max(...[e.last_seen, e.reopened_at, e.at, e.seen_at].map((x) => Date.parse(x || "")).filter(Number.isFinite), -Infinity);
    if (!Number.isFinite(last) || nowMs - last > SILENT_AGENT_ESCALATE_MS) {
      out.push({
        code: "open-agent-silent",
        id: id.slice(0, 120),
        text: `${e.kind || "agent"} ${JSON.stringify(e.name || e.agent_id || e.task_id || id)} (${e.shape || e.kind || "open"}) has had no transcript evidence since ${Number.isFinite(last) ? new Date(last).toISOString() : "UNKNOWN"} — still COUNTED as running; confirm it ended (or stop it), and the next Stop re-evaluates`,
      });
    }
  }
  return out;
}

/**
 * Advance the agents ledger (and the resume ack) over the transcript bytes since the
 * last Stop. Returns {agents, background_agents: int|null, reason, resume, escalations}.
 */
function scanTranscript(prevAgents, prevResume, transcriptPath, { sessionId, maxBytes = SCAN_MAX_BYTES_PER_CALL, nowMs = Date.now() } = {}) {
  const agents = cloneAgents(prevAgents);
  const resume = isObj(prevResume) ? { ...prevResume } : null;
  const nowIso = new Date(nowMs).toISOString();
  const done = (count, reason) => {
    const esc = silentEscalations(agents, nowMs);
    if (agents.lost_tail) esc.push({ code: "transcript-tail-lost", id: "lost-tail", text: `the unscanned tail of ${agents.lost_tail.path} (from byte ${agents.lost_tail.offset}) can no longer be read (${agents.lost_tail.why}); launches in it are unknowable, so the count stays UNKNOWN until this record is reset by an operator` });
    if (agents.untracked_live > 0) esc.push({ code: "agent-ledger-overflow", id: "untracked-live", text: `${agents.untracked_live} live identities were not retained within the ledger ceiling; count UNKNOWN until trusted ledger reconstruction` });
    const unknown = agents.lost_tail || agents.untracked_live > 0;
    return { agents, background_agents: unknown ? null : count, reason: agents.untracked_live > 0 ? "unresolved untracked live agents after ledger ceiling" : agents.lost_tail && count !== null ? "a previous transcript's tail was lost" : reason, resume, escalations: esc };
  };
  if (typeof transcriptPath !== "string" || !transcriptPath) return done(null, "no transcript_path in the Stop payload");
  const rp =
    resume && resume.injected === true && resume.verified !== true && resume.injected_session_id === sessionId && RESUME_TOKEN_RE.test(String(resume.token || ""))
      ? resume
      : null;
  if (rp) rp.pending = true;
  const ctx = { afterMs: rp ? Date.parse(rp.injected_at || "") || null : null, token: rp ? rp.token : "", sessionId, nowIso };
  const finish = (count, reason) => {
    if (rp) delete rp.pending;
    return done(count, reason);
  };
  let budget = maxBytes;
  if (agents.transcript && agents.transcript !== transcriptPath) {
    // CR-H2: FINISH the previous transcript from its stored offset to EOF before switching:
    // launches in its unscanned tail would otherwise be lost and the count could read 0.
    const old = readIncrement(agents.transcript, agents.offset, budget, { skipToNewline: agents.skip_to_newline });
    if (!old.ok) {
      if (old.code !== "ENOENT") return finish(null, `previous transcript not finished (${old.reason})`);
      agents.lost_tail = { path: agents.transcript.slice(-300), offset: agents.offset, why: "file gone", at: nowIso };
    } else {
      for (const l of old.lines) if (l) applyLine(l, agents, rp, ctx);
      budget -= old.offset - agents.offset;
      agents.offset = old.offset;
      agents.skip_to_newline = old.skipToNewline === true;
      if (old.oversized || (!old.caughtUp && !old.tornTail)) return finish(null, `previous transcript not yet finished (${old.size - old.offset} bytes left)`);
      // A torn final line of a SUPERSEDED transcript will never complete.
      if (old.tornTail) agents.lost_tail = { path: agents.transcript.slice(-300), offset: old.offset, why: "torn final line", at: nowIso };
    }
    // The ledger CARRIES ACROSS: open entries stay open until their notification appears.
    agents.transcript = transcriptPath;
    agents.offset = 0;
    agents.skip_to_newline = false;
  } else if (!agents.transcript) {
    agents.transcript = transcriptPath;
    agents.offset = 0;
  }
  if (budget <= 0) return finish(null, "scan budget spent on the previous transcript");
  const inc = readIncrement(transcriptPath, agents.offset, budget, { skipToNewline: agents.skip_to_newline });
  if (!inc.ok) return finish(null, inc.reason);
  for (const l of inc.lines) if (l) applyLine(l, agents, rp, ctx);
  agents.offset = inc.offset;
  agents.skip_to_newline = inc.skipToNewline === true;
  boundAgents(agents);
  const running = Object.keys(agents.open).length + Object.keys(agents.pending).length;
  if (inc.oversized) return finish(null, `an oversized transcript line (> ${budget} bytes) is being skipped — count UNKNOWN for this Stop`);
  if (!inc.caughtUp) return finish(null, inc.tornTail ? "the transcript ends in an incomplete line" : `transcript backlog not yet scanned (${inc.size - inc.offset} bytes left)`);
  if (running > MAX_TRACKED_AGENTS) return finish(null, `${running} agents tracked, over the ${MAX_TRACKED_AGENTS} ceiling`);
  return finish(running, null);
}

/** Do two ledgers describe the same scan position? (the commit-under-lock recheck) */
function samePosition(a, b) {
  const x = isObj(a) ? a : {};
  const y = isObj(b) ? b : {};
  return (x.transcript || null) === (y.transcript || null) && (x.offset || 0) === (y.offset || 0) && JSON.stringify(x.open || {}) === JSON.stringify(y.open || {}) && JSON.stringify(x.pending || {}) === JSON.stringify(y.pending || {}) && (x.untracked_live || 0) === (y.untracked_live || 0);
}

/**
 * The Stop row's whole update, computed under the lock from the CURRENT record `prev`.
 * `scan` (precomputed OUTSIDE the lock from `scannedFrom`) is applied only when the
 * ledger is still where it was scanned from; otherwise nothing of it is written and the
 * candidate is NOT ready. `activityNonce` is the marker the Stop saw at its START and
 * `currentNonce()` re-reads it here: a difference means activity during the evaluation.
 * The row NEVER writes ready:true — it writes the CANDIDATE and awaiting_commit; only the
 * dispatcher's commitStopReadiness, after the merged verdict, may set ready.
 */
function stopFields(prev, payload, { nowIso, verify, scan, scannedFrom, activityNonce, activitySession, currentNonce, stopHookActive, transcriptAt, candidateId } = {}) {
  const p = isObj(payload) ? payload : {};
  const sessionId = typeof p.session_id === "string" ? p.session_id : null;
  const boundSession = meter.activitySessionId(sessionId);
  const extra = [];
  if (boundSession === null) extra.push("the Stop payload carries no usable session_id — readiness cannot be bound to a session");
  else if (meter.activitySessionId(activitySession) !== boundSession) extra.push("the activity marker at this Stop's start names a different (or no) session — readiness cannot be bound to this session");
  const cid = typeof candidateId === "string" && NONCE_RE.test(candidateId) ? candidateId : null;
  if (cid === null) extra.push("no per-Stop candidate id (env COC_STOP_CANDIDATE_ID, minted by the dispatcher) — this Stop's candidate could never be told apart from a leftover one");
  let sc = scan;
  if (!sc) sc = scanTranscript(prev.agents, prev.resume, p.transcript_path, { sessionId });
  else if (scannedFrom && !samePosition(prev.agents, scannedFrom.agents)) {
    extra.push("the agents ledger moved while this Stop scanned (a concurrent Stop) — re-evaluated at the next Stop");
    sc = { agents: prev.agents, background_agents: null, reason: "concurrent ledger update", resume: prev.resume, escalations: [] };
  }
  const out = { updated_at: nowIso, agents: sc.agents };
  let resume = isObj(prev.resume) ? { ...prev.resume } : null;
  if (sc.resume && resume && sc.resume.injected_session_id === resume.injected_session_id) {
    resume = { ...sc.resume };
    const h = isObj(prev.handover) ? prev.handover : {};
    resume.verified = resume.token_echoed === true && resume.expected_seed_sha256 === h.seed_sha256 && SHA256_RE.test(String(h.seed_sha256 || ""));
    if (resume.verified && !resume.verified_at) resume.verified_at = nowIso;
    out.resume = resume;
    if (resume.verified && h.state === "injected") out.handover = { ...h, state: "consumed", consumed_at: nowIso };
  }
  const boundaryBase = {
    ...(isObj(prev.boundary) ? prev.boundary : {}),
    agent_id: typeof p.agent_id === "string" && p.agent_id.trim() ? p.agent_id : null,
    idle: true,
    last_event: "Stop",
    last_event_at: nowIso,
    preferred: "clear",
    background_agents: sc.background_agents,
    background_agents_reason: sc.reason,
    escalations: Array.isArray(sc.escalations) ? sc.escalations.slice(0, 16) : [],
    // THIS Stop's session — never a prior Stop's left in the record (SEC-F1): the handover
    // binding in computeReady compares against it.
    session_id: boundSession,
    // Where the transcript stood when this Stop ran: the consumer requires nothing but
    // quiescent records past it (transcriptQuiescent).
    transcript_path: null,
    transcript_offset: null,
    transcript_ino: null,
    transcript_dev: null,
  };
  const tAt = isObj(transcriptAt) && transcriptAt.ok === true && transcriptAt.path === p.transcript_path ? transcriptAt : null;
  if (tAt) Object.assign(boundaryBase, { transcript_path: tAt.path, transcript_offset: tAt.size, transcript_ino: tAt.ino, transcript_dev: tAt.dev });
  if (!tAt) extra.push(`the transcript position at this Stop could not be measured (${(isObj(transcriptAt) && transcriptAt.reason) || "not measured"}) — readiness cannot be bound to it`);
  const r = computeReady({ ...prev, ...out, boundary: boundaryBase }, verify, { payload: p });
  const reasons = [...r.reasons, ...extra];
  const nonceOk = typeof activityNonce === "string" && NONCE_RE.test(activityNonce);
  if (!nonceOk) reasons.push("no activity marker could be established at this Stop — readiness cannot be bound to it");
  else if (typeof currentNonce === "function") {
    let cur = null;
    try {
      cur = currentNonce();
    } catch {
      cur = null;
    }
    if (cur !== activityNonce) reasons.push("activity occurred while this Stop was being evaluated");
  }
  if (stopHookActive === true) reasons.push("stop_hook_active: this Stop is a re-invocation after another Stop guard blocked the turn — never a boundary");
  const candidate = reasons.length === 0;
  out.boundary = {
    ...boundaryBase,
    ready: false,
    committed: false,
    awaiting_commit: candidate,
    candidate_ready: candidate,
    candidate_id: cid,
    session_id: boundSession,
    activity_nonce: nonceOk ? activityNonce : null,
    computed_at: nowIso,
    reasons: candidate ? ["candidate ready — awaiting the merged Stop verdict (dispatch-main.js::stopBoundaryCommit)"] : reasons,
  };
  return out;
}

/**
 * The dispatcher's COMMIT (after the merged Stop verdict). `endsTurn` is true only when
 * the merged reply lets the turn end; `why` names what stopped it otherwise. Under the
 * lock: ready:true ONLY if THIS Stop's candidate is still the record's (awaiting_commit,
 * last_event Stop, candidate_id === `candidateId` — the id this dispatch minted — and
 * session_id === `sessionId`, the Stop payload's) AND the activity marker still holds the
 * candidate's nonce and names that session. A committed ready is still NOT valid for a
 * consumer until Claude Code's stop_hook_summary lands clean (boundaryReadyValid).
 * Returns {ok, ready, reason}. Never throws.
 */
function commitStopReadiness(loc, { endsTurn, why, nowIso, candidateId, sessionId, agentId = null } = {}) {
  let result = { ready: false, reason: "not evaluated" };
  const w = updateContextState(loc, (prev) => {
    const b = isObj(prev.boundary) ? prev.boundary : {};
    const refuse = (reason) => {
      result = { ready: false, reason };
      const reasons = Array.isArray(b.reasons) && b.awaiting_commit !== true ? b.reasons : [];
      return { boundary: { ...b, ready: false, committed: false, awaiting_commit: false, commit_refused: reason, reasons: [reason, ...reasons].slice(0, 24) } };
    };
    if (endsTurn !== true) return refuse(`the merged Stop verdict did not end the turn (${why || "blocked"}) — no boundary`);
    if (b.awaiting_commit !== true || b.candidate_ready !== true) {
      result = { ready: false, reason: "no candidate awaiting commit" };
      return { boundary: { ...b, ready: false, committed: false, awaiting_commit: false } };
    }
    if (typeof candidateId !== "string" || !NONCE_RE.test(candidateId) || b.candidate_id !== candidateId) {
      return refuse("the awaiting candidate was not produced by THIS Stop (a leftover candidate of an earlier Stop, or no per-Stop candidate id) — refused");
    }
    const sid = meter.activitySessionId(sessionId);
    if (sid === null || meter.activitySessionId(b.session_id) !== sid) return refuse("the candidate is not bound to this Stop's session");
    if (b.last_event !== "Stop") return refuse(`an event (${JSON.stringify(b.last_event)}) followed the Stop`);
    const a = readActivity(loc);
    if (a.state !== "ok" || a.nonce !== b.activity_nonce) return refuse("activity since the Stop computed its candidate");
    if (meter.activitySessionId(a.session_id) !== sid) return refuse("the activity marker names a different session than the Stop");
    if ((b.agent_id == null ? null : b.agent_id) !== agentId) return refuse("readiness agent does not match trusted Stop agent");
    const queueReason = pendingFindingsReason({ cwd: loc.repoDir || process.cwd(), session_id: sid, agent_id: agentId });
    if (queueReason) return refuse(queueReason);
    const q = transcriptQuiescent(b, typeof b.transcript_path === "string" ? readTranscriptSince(b.transcript_path, b.transcript_offset) : undefined);
    if (!q.quiet) return refuse(q.reason);
    result = { ready: true, reason: null };
    return { updated_at: nowIso, boundary: { ...b, ready: true, committed: true, committed_at: nowIso, awaiting_commit: false, awaiting_stop_summary: true, commit_refused: null, reasons: [] } };
  });
  if (!w.ok) return { ok: false, ready: false, reason: w.reason };
  return { ok: true, ...result };
}

module.exports = {
  HANDOVER_STATES,
  SHA256_RE,
  RESUME_TOKEN_RE,
  NONCE_RE,
  SEED_NAME_RE,
  SEED_READ_CAP_BYTES,
  SCAN_MAX_BYTES_PER_CALL,
  MAX_TRACKED_AGENTS,
  MAX_KNOWN_AGENTS,
  SILENT_AGENT_ESCALATE_MS,
  TERMINAL_TASK_STATUSES,
  FRESH_SEED_MAX_TOKEN_LAG,
  MIN_SESSION_GROWTH_TOKENS,
  locateState,
  readState,
  updateContextState,
  markActivity,
  readActivity,
  boundaryReadyValid,
  readBoundaryReadiness,
  QUIESCENT_RECORD_KINDS,
  TRANSCRIPT_TAIL_MAX_BYTES,
  recordKind,
  transcriptSize,
  readTranscriptSince,
  transcriptQuiescent,
  stopSummaryOf,
  stopFinished,
  readSeedFile,
  anchoredLearningPath,
  learningPathContained,
  verifyHandoverSeed,
  computeReady,
  activityBoundary,
  normalizeHandover,
  validateRenderedSeed,
  stampHandover,
  observeSeedWrite,
  tailFenceVerdict,
  HANDOVER_FINAL_LINE_RE,
  ownerTexts,
  seedClockNote,
  handoverBoundReason,
  retireDeclaredHandover,
  DECLARED_SCHEMA,
  DECLARED_CONTRACT,
  writeDeclaredHandover,
  consumeDeclaredHandover,
  readIncrement,
  notificationText,
  parseNotification,
  scanTranscript,
  stopFields,
  commitStopReadiness,
};
