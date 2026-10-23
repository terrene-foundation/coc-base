"use strict";
/**
 * stop-receipt.js — the PER-ATTEMPT STOP RECEIPT: a MEASUREMENT instrument, never trust state.
 *
 * WHY IT EXISTS. The handover readiness predicate refuses "ready" while a hook finding is pending
 * at the Stop attempt (context-state.js::commitStopReadiness / boundaryReadyValid, via
 * hook-findings.js::pendingForAgent). How OFTEN a finding is pending at a real Stop was
 * UNANSWERABLE: no record of the queue's state at a Stop existed, so a read-only measurement of
 * real transcripts returned UNKNOWN (pending numerator UNKNOWN, observable denominator 0). This
 * module writes that record — one JSONL row per Stop ATTEMPT — and reads the rate back.
 *
 * WHERE IT IS WRITTEN (the two covered runtimes):
 *   - Claude Code: lib/dispatch-main.js::finish, inside the stdout write's completion callback
 *     AFTER hook-findings.js::confirmDelivery (the findings ACK) and BEFORE end(), so the row can
 *     report the handoff and ACK outcomes it observed instead of predicting them. When the full
 *     receipt cannot run (dispatch-main.js::stopReceiptSkipReason) the dispatcher takes one of
 *     two tiers. A MINIMAL SKIP ROW (buildSkippedReceipt — no queue read, no cycle locate, the
 *     same contained append) when enough budget remains for the append alone: a low time budget
 *     still above the minimal reserve (`skipped: "low-time-budget"`), a registry fault
 *     answered early (`skipped: "registry-fault"`), which leaves nearly the whole budget, and
 *     the dispatcher's own input read hitting its bound (`skipped: "stdin-bound"`). ONE
 *     STDERR LINE and no row on the fatal path, the watchdog's stall reply, and any budget below
 *     the minimal reserve.
 *   - native Codex: lib/codex-hook-runtime.js::main, after its own fs.writeSync of stdout and
 *     stderr. The wrapper performs NO findings ACK and NO dispatcher boundary commit; its row says
 *     `ack: "not-performed"` and never reports a commit verdict.
 *   - Gemini: NOT COVERED. Its hook registrations are BeforeTool / AfterTool / SessionStart only
 *     (`.claude/gemini-templates/settings.json:16-66`, mirrored at `.gemini/settings.json:16-75`);
 *     no per-turn Stop-class event is registered, so there is no seam to write from. The schema
 *     carries this as `coverage.gemini: "UNCOVERED"` and the blind class "gemini-uncovered".
 *
 * WHAT A ROW DOES NOT CLAIM.
 *   - turn_id / turn_end are the literal "UNKNOWN": a Stop attempt is not a completed turn, and
 *     nothing at this seam proves the turn ended (Stop hooks registered OUTSIDE the dispatcher can
 *     still block afterwards — blind class "stop-hooks-registered-outside-dispatcher"). Completed-
 *     turn reconciliation is a separate, OPEN item.
 *   - readiness "committed-ready" is the DISPATCHER-LOCAL commit only; a consumer still requires
 *     Claude Code's clean stop_hook_summary (context-state.js::boundaryReadyValid). It is never
 *     reported as host completion.
 *   - persistence is "process-level": append-sink.js::appendSinkLine closes without fsync, so a
 *     row survives a process exit, not a power loss.
 *   - the denominator is NOT every Stop: BLIND_CLASSES names each path that ends with no row
 *     (the bootstrap answering for a body that failed to load, a fatal inside finish itself, a
 *     SIGKILL / abort, and the dispatcher's no-row skips above).
 *   - a SKIP ROW (`skipped: <code>`, `pending_count: null`) records that an attempt HAPPENED and
 *     why it carries no queue reading. It is never a pending or a not-pending attempt: the read
 *     side counts it as `skipped_attempts` (by code) and keeps it out of every other figure.
 *
 * NEVER BLOCKS, NEVER FAILS THE STOP. Every entry point is synchronous, bounded, and never
 * throws; a failure is ONE stderr diagnostic ("[stop-receipt] receipt NOT recorded …") and the
 * Stop's reply and exit code are untouched. The row is never read by readiness, the seed, resume,
 * or any gate — it cannot change a verdict.
 *
 * SINK — ANCHORED TO THE WRITER'S OWN REPO, CONTAINED BEFORE ANY MUTATION.
 *   `<sinkRoot>/.claude/learning/stop-receipts/receipts.jsonl`, where `sinkRoot` is the repo the
 *   WRITER lives in (the dispatcher's `.claude/hooks/../..`, the Codex wrapper's ROOT) — never the
 *   payload's cwd, which follows wherever the session cd'd, so a cwd in a sibling repo or under
 *   $HOME would otherwise leave an untracked row file there on EVERY Stop. The queue and the
 *   handover cycle are still read from the payload's cwd (the same inputs readiness uses).
 *   Gitignored (`.gitignore:169`, `.claude/learning/**`), mode 0600, written through the shared
 *   hardened primitive (append-sink.js).
 *   CONTAINMENT FIRST: before rotation can rename or unlink anything, the sink directory is
 *   resolved (a missing tail allowed) and must EQUAL `realpath(sinkRoot)/.claude/learning/
 *   stop-receipts`; any symlinked component — the leaf OR an ancestor such as `.claude/learning`
 *   — is refused and nothing is touched (containedSinkDir). Accepted residual, per
 *   rules/security.md § Path Containment: a swap BETWEEN that check and the rename is the
 *   check-to-use TOCTOU the resolve does not close; the append itself re-checks containment
 *   through the primitive's fd-based defences.
 *   BOUNDED: when the live file reaches MAX_SINK_BYTES it is renamed to a uniquely-named
 *   generation and the oldest generations beyond KEEP_ROTATED are deleted (a DECLARED, bounded
 *   loss of the oldest measurements); if rotation cannot run, appends stop at 2 × MAX_SINK_BYTES.
 *   Generation names carry a millisecond stamp and a per-process sequence, so generations sort in
 *   rotation order (two rotations in one millisecond included); a random suffix keeps two
 *   processes from colliding. A row never exceeds MAX_LINE_BYTES: ids and reasons are truncated
 *   with a marker (`…[truncated N chars sha256:<12 hex>]`), never dropped.
 *
 * READ SIDE: `node .claude/hooks/lib/stop-receipt.js --rate [--repo <dir>] [--json]`. An absent
 * ledger prints UNKNOWN — absence is never read as zero attempts or a zero rate. Skip rows are
 * reported apart as `skipped_attempts` (known codes in `skipped_by_reason`, anything else in
 * `unknown_skip_code`), never in `attempts` or the rate. A generation that
 * vanishes between the listing and its read (a concurrent rotation) triggers a bounded re-list.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// v2 (2026-10-12): the minimal SKIP row shape (`skipped`, `pending_count: null`) and the
// renamed/added blind classes. A v1-only reader would fold a skip row into its attempts and its
// unknown-queue count; under v2 it reports the row as unparsable instead of miscounting it.
const SCHEMA = "coc-stop-receipt/v2";
// Every schema the read side accepts: v1 rows written before the bump are still read.
const READ_SCHEMAS = Object.freeze(["coc-stop-receipt/v1", SCHEMA]);
const SINK_SUBDIR = path.join(".claude", "learning", "stop-receipts");
const SINK_BASENAME = "receipts.jsonl";
// receipts.<YYYYMMDD>T<HHMMSS><mmm>Z-<seq6>-<rand8>.jsonl; the legacy second-resolution form
// receipts.<YYYYMMDD>T<HHMMSS>Z-<rand8>.jsonl still matches, so older generations are read and pruned.
const ROTATED_RE = /^receipts\.(\d{8}T\d{6})(\d{3})?Z-(?:(\d{6})-)?([0-9a-f]{8})\.jsonl$/;
const MAX_SINK_BYTES = 2 * 1024 * 1024;
const KEEP_ROTATED = 3;
// The POSIX atomic-append bound every append-sink caller inherits (append-sink.js header).
const MAX_LINE_BYTES = 2048;
const REASON_MAX = 200;
// JSON-escaped byte bounds per free-text field, so the row fits MAX_LINE_BYTES by construction.
const ID_MAX_BYTES = 128;
const REASON_MAX_BYTES = 256;
// How many times the read side re-lists when a listed file vanished before its read.
const LIST_ATTEMPTS = 3;
const UNKNOWN = "UNKNOWN";
const BLIND_CLASSES = Object.freeze([
  "stop-hooks-registered-outside-dispatcher",
  "gemini-uncovered",
  // Stop attempts that end with NO row — each undercounts the denominator:
  "no-receipt-bootstrap-fallback", // dispatch.js answered for a body that failed to load or start
  "no-receipt-fatal-in-finish", // the fatal handler could not even build its reply (bare exit)
  "no-receipt-sigkill-or-abort", // uncatchable process ends (SIGKILL, process.abort, OOM abort)
  // dispatch-main.js::stopReceiptSkipReason, its no-row tier: the fatal / stall paths, a registry
  // fault answered past the early-fault bound, a budget below the minimal reserve
  "no-receipt-dispatcher-fault-or-under-minimal-time-budget",
  // Stop attempts that end with a SKIP ROW (`skipped: <code>`): counted (skipped_attempts), but
  // with no queue reading — the rate's denominator excludes them, it does not lose them:
  "skip-row-carries-no-queue-reading",
]);
// The `skipped` codes a skip row may carry (dispatch-main.js::stopReceiptSkipReason, minimal tier).
const SKIP_CODES = Object.freeze(["low-time-budget", "registry-fault", "stdin-bound"]);
const COVERAGE = Object.freeze({ claude: "covered", codex: "covered", gemini: "UNCOVERED" });
const PERSISTENCE = "process-level";
// A handover cycle is IN PLAY while its seed is being written, is written, or was injected and
// not yet consumed (context-state.js::HANDOVER_STATES). "none" / "consumed" / "failed" are not.
const CYCLE_STATES = new Set(["writing", "written", "injected"]);
const SCOPE_CLAUDE = "dispatcher-local commit of this attempt; NOT host Stop completion";
const SCOPE_CODEX = "native Codex wrapper: no dispatcher commit; NOT host Stop completion";

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** `ms` as ISO-8601 in the host's LOCAL offset, e.g. 2026-10-12T13:04:05.006+08:00. */
function isoWithOffset(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const local = new Date(ms + off * 60000).toISOString().slice(0, 23);
  const abs = Math.abs(off);
  return `${local}${off >= 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** A reason fit for a measurement row: one line, no absolute paths, bounded. */
function sanitizeReason(s) {
  if (s === null || s === undefined) return null;
  return String(s)
    .replace(/[\x00-\x1f\x7f\u0085\u2028\u2029]/g, " ")
    .replace(/(^|[\s("'`=])(?:\/|[A-Za-z]:\\)[^\s"'`,;)]*/g, "$1<path>")
    .slice(0, REASON_MAX);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** sha256 of a file's bytes, or null. */
function fileSha256(file) {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

const jsonBytes = (s) => Buffer.byteLength(JSON.stringify(s), "utf8") - 2;

/**
 * `s` bounded to `maxBytes` of JSON-escaped UTF-8. An over-long value keeps a prefix and ends in
 * the marker `…[truncated <N> chars sha256:<first 12 hex of the WHOLE value>]`, so two different
 * long values stay distinguishable and the row is never dropped for one field.
 */
function boundField(s, maxBytes) {
  if (s === null || s === undefined) return null;
  const str = String(s);
  if (jsonBytes(str) <= maxBytes) return str;
  const marker = `…[truncated ${[...str].length} chars sha256:${sha256(str).slice(0, 12)}]`;
  const budget = Math.max(0, maxBytes - jsonBytes(marker));
  let out = "";
  let used = 0;
  for (const ch of str) {
    const b = jsonBytes(ch);
    if (used + b > budget) break;
    out += ch;
    used += b;
  }
  return out + marker;
}

const boundReason = (s) => boundField(sanitizeReason(s), REASON_MAX_BYTES);

function sessionIdOf(payload) {
  const s = payload && typeof payload === "object" ? payload.session_id : null;
  return typeof s === "string" && s.length > 0 ? boundField(s, ID_MAX_BYTES) : null;
}

function agentIdOf(payload) {
  const a = payload && typeof payload === "object" ? payload.agent_id : null;
  return typeof a === "string" && a.trim() ? boundField(a, ID_MAX_BYTES) : null;
}

/**
 * The repo root a READER names with `--repo` — the SAME derivation hook-findings uses — or NULL
 * when that dir IS the home directory: home is never a repo root, so `readLedger` reads nothing
 * there and answers `{state: "unreadable", code: "no-repo-root"}` (UNKNOWN, never zero). If
 * stop-refusal.js cannot load, the fallback keeps the dir — except at home, null for the same reason.
 */
function repoRootOf(repoDir) {
  try {
    return require("./stop-refusal.js")._repoRootOf(repoDir);
  } catch {
    const d = path.resolve(String(repoDir || process.cwd()));
    return isHomeFallback(d) ? null : d;
  }
}

function isHomeFallback(d) {
  try {
    const h = require("os").homedir();
    if (!h) return false;
    const hs = [path.resolve(h)];
    try { hs.push(fs.realpathSync(h)); } catch { /* the resolved form still bounds */ }
    let rd = d;
    try { rd = fs.realpathSync(d); } catch { /* a missing dir compares on its resolved form */ }
    const k = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
    return hs.some((x) => k(x) === k(d) || k(x) === k(rd));
  } catch {
    return false;
  }
}

const NO_REPO_ROOT = "no-repo-root";

/** realpath of `p`, allowing a MISSING tail; a dangling symlink on the way is an error. */
function realpathAllowingMissingTail(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch (e) {
      if (!e || e.code !== "ENOENT") throw e;
      let dangling = false;
      try {
        fs.lstatSync(cur);
        dangling = true; // the NAME exists but does not resolve: a dangling symlink
      } catch {
        /* genuinely missing: keep walking up */
      }
      if (dangling) {
        const err = new Error("a dangling symlink sits on the receipt directory's path");
        err.code = "EDANGLING";
        throw err;
      }
      const up = path.dirname(cur);
      if (up === cur) throw e;
      tail.unshift(path.basename(cur));
      cur = up;
    }
  }
}

/**
 * The CONTAINED sink location under `sinkRoot`: {ok, root, dir, file} or {ok:false, reason}.
 * The directory must resolve to EXACTLY realpath(sinkRoot)/.claude/learning/stop-receipts — the
 * trust decision is taken on canonical forms of BOTH sides, before anything is renamed, unlinked,
 * created or read (rules/security.md § Path Containment).
 */
function containedSinkDir(sinkRoot) {
  if (typeof sinkRoot !== "string" || !sinkRoot) return { ok: false, reason: "no sink root was named" };
  let root;
  try {
    root = fs.realpathSync(path.resolve(sinkRoot));
  } catch (e) {
    return { ok: false, reason: `the sink root does not resolve (${(e && e.code) || "error"})` };
  }
  const dir = path.join(root, SINK_SUBDIR);
  let real;
  try {
    real = realpathAllowingMissingTail(dir);
  } catch (e) {
    return { ok: false, reason: `refusing to rotate or append: the receipt directory does not resolve (${(e && e.code) || "error"})` };
  }
  if (real !== dir) {
    return { ok: false, reason: "refusing to rotate or append: the receipt directory resolves outside its repo (a symlinked component on .claude/learning/stop-receipts)" };
  }
  return { ok: true, root, dir, file: path.join(dir, SINK_BASENAME) };
}

/** The queue as it stands at the attempt (hook-findings.js::queueSnapshot). Never throws. */
function queueAtAttempt(payload) {
  try {
    return require("./hook-findings.js").queueSnapshot(payload);
  } catch {
    return { state: "unreadable", pending: null, queued: null, drained: null };
  }
}

/**
 * Is a handover cycle in play for this terminal? "in-play" | "none" | "UNKNOWN".
 * Reads the context-state record through its ONE locator (context-state.js::locateState).
 */
function cycleOf({ repoDir, configDir, pid }) {
  try {
    const CS = require("./context-state.js");
    const loc = CS.locateState({ configDir, repoDir, pid });
    if (!loc || !loc.ok) return UNKNOWN;
    const st = CS.readState(loc);
    if (st.state === "absent") return "none";
    if (st.state !== "ok") return UNKNOWN;
    const h = st.data && typeof st.data.handover === "object" && st.data.handover ? st.data.handover : null;
    return h && CYCLE_STATES.has(h.state) ? "in-play" : "none";
  } catch {
    return UNKNOWN;
  }
}

/**
 * The readiness verdict for THIS attempt.
 *   runtime "claude": `commit` is dispatch-main.js::stopBoundaryCommit's return — undefined when
 *     the dispatch never reached it, null when it ran no commit, else
 *     context-state.js::commitStopReadiness's {ok, ready, reason}.
 *   runtime "codex": the wrapper commits nothing.
 * Outside a handover cycle the verdict is "no-cycle" — unless the attempt's own commit made it
 * ready, which is reported as it is. Whenever a commit RAN, its own outcome rides along as
 * `commit: {ran, ok, ready, reason}`, so a no-cycle verdict never hides what the commit decided.
 */
function readinessFor({ runtime, commit, cycle }) {
  const scope = runtime === "codex" ? SCOPE_CODEX : SCOPE_CLAUDE;
  const committed = runtime === "claude" && commit && typeof commit === "object";
  const commitInfo = committed
    ? { ran: true, ok: commit.ok === true, ready: commit.ready === true, reason: boundReason(commit.reason === undefined ? null : commit.reason) }
    : null;
  const out = (verdict, reason) => ({ cycle, verdict, reason: boundReason(reason), scope, ...(commitInfo ? { commit: commitInfo } : {}) });
  if (committed && commit.ok === true && commit.ready === true) return out("committed-ready", null);
  if (cycle === "none") return out("no-cycle", "no-cycle");
  if (runtime === "codex") return out("not-evaluated", "the native Codex wrapper performs no dispatcher boundary commit");
  if (committed) return out("refused", commit.ok === true ? commit.reason || "refused (no reason recorded)" : `boundary commit failed: ${commit.reason || "unknown"}`);
  if (commit === null) return out("not-evaluated", "no dispatcher boundary commit ran for this Stop (no completed context-boundary row, a subagent Stop, or the state was unlocatable)");
  return out("not-evaluated", "the dispatch ended before the boundary commit");
}

/** Build ONE receipt object (pure). */
function buildReceipt({ runtime, attemptedAtMs, payload, dispatcher, queue, readiness, stdoutHandoff, stderrHandoff, ack, ackReceipts, exitCode }) {
  const q = queue && typeof queue === "object" ? queue : { state: "unreadable", pending: null, drained: null };
  return {
    schema: SCHEMA,
    attempt_id: crypto.randomBytes(16).toString("hex"),
    attempted_at: isoWithOffset(Number.isFinite(attemptedAtMs) ? attemptedAtMs : Date.now()),
    recorded_at: isoWithOffset(Date.now()),
    session_id: sessionIdOf(payload),
    agent_id: agentIdOf(payload),
    runtime,
    coverage: COVERAGE,
    dispatcher: dispatcher && typeof dispatcher === "object" ? dispatcher : {},
    pending_count: Number.isInteger(q.pending) ? q.pending : null,
    drained: typeof q.drained === "boolean" ? q.drained : null,
    queue_state: typeof q.state === "string" ? q.state : "unreadable",
    queue_observed: "at the attempt, before the stdout handoff",
    readiness,
    stdout_handoff: stdoutHandoff,
    ...(typeof stderrHandoff === "string" ? { stderr_handoff: stderrHandoff } : {}),
    ack,
    ...(Number.isInteger(ackReceipts) ? { ack_receipts: ackReceipts } : {}),
    exit_code: Number.isInteger(exitCode) ? exitCode : null,
    turn_id: UNKNOWN,
    turn_end: UNKNOWN,
    blind_classes: BLIND_CLASSES,
    persistence: PERSISTENCE,
  };
}

/**
 * Build ONE minimal SKIP row (pure): the attempt happened, and `skipped` says why it carries no
 * queue reading. No session id, no queue, no readiness — nothing that needed the work the skip
 * avoided. `pending_count` is null so no reader can take it for a not-pending attempt.
 */
function buildSkippedReceipt({ runtime, attemptedAtMs, skipped }) {
  if (!SKIP_CODES.includes(skipped)) throw new Error(`unknown skip code ${JSON.stringify(skipped)} (expected one of ${SKIP_CODES.join(", ")})`);
  return {
    schema: SCHEMA,
    attempt_id: crypto.randomBytes(16).toString("hex"),
    attempted_at: isoWithOffset(Number.isFinite(attemptedAtMs) ? attemptedAtMs : Date.now()),
    runtime,
    skipped,
    pending_count: null,
  };
}

/**
 * The row as ONE line no longer than MAX_LINE_BYTES. buildReceipt already bounds every free-text
 * field; if a row still overflows, the free-text fields are tightened further (marked, never
 * dropped). Returns null only for a caller-built object whose OTHER fields alone exceed the cap.
 */
function serializeBounded(receipt) {
  let line = JSON.stringify(receipt);
  if (Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES) return line;
  for (const budget of [64, 16]) {
    const r = JSON.parse(line);
    for (const k of ["session_id", "agent_id"]) if (typeof r[k] === "string") r[k] = boundField(r[k], budget);
    if (r.readiness && typeof r.readiness === "object") {
      if (typeof r.readiness.reason === "string") r.readiness.reason = boundField(r.readiness.reason, budget);
      if (r.readiness.commit && typeof r.readiness.commit.reason === "string") r.readiness.commit.reason = boundField(r.readiness.commit.reason, budget);
    }
    line = JSON.stringify(r);
    if (Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES) return line;
  }
  return null;
}

/** A generation's ordering key: [stamp, millis, seq, rand] — legacy names read as millis 000, seq 000000. */
function generationKey(name) {
  const m = ROTATED_RE.exec(name);
  return m ? [m[1], m[2] || "000", m[3] || "000000", m[4]] : null;
}

function compareGenerations(a, b) {
  const ka = generationKey(a);
  const kb = generationKey(b);
  for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return 0;
}

/** The rotated generations among `names`, oldest first. */
function listGenerations(names) {
  return names.filter((n) => ROTATED_RE.test(n)).sort(compareGenerations);
}

// Per-process rotation sequence: two rotations inside one millisecond still sort in order.
let rotationSeq = 0;
function generationName(nowMs) {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
  rotationSeq = (rotationSeq % 999999) + 1;
  return `receipts.${stamp}-${pad(rotationSeq, 6)}-${crypto.randomBytes(4).toString("hex")}.jsonl`;
}

/**
 * Rotate the live file once it reaches `maxBytes`, then prune generations beyond `keep`.
 * Called ONLY with a directory containedSinkDir has already proven to be inside the repo.
 */
function rotateIfFull(dir, file, maxBytes, keep) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { ok: true, size: 0 };
  }
  if (!st.isFile()) return { ok: false, reason: "the receipt sink is not a regular file" };
  if (st.size < maxBytes) return { ok: true, size: st.size };
  try {
    fs.renameSync(file, path.join(dir, generationName(Date.now())));
  } catch (e) {
    if (!e || e.code !== "ENOENT") return { ok: st.size < 2 * maxBytes, size: st.size, reason: `rotation failed (${(e && e.code) || "error"}) and the sink is at its hard cap` };
  }
  try {
    const gens = listGenerations(fs.readdirSync(dir));
    for (const n of gens.slice(0, Math.max(0, gens.length - keep))) {
      const p = path.join(dir, n);
      if (fs.lstatSync(p).isFile()) fs.unlinkSync(p);
    }
  } catch {
    /* pruning is best-effort; the next rotation retries it */
  }
  return { ok: true, size: 0 };
}

/**
 * Append ONE receipt to the sink under `sinkRoot` (the WRITER's own repo). Returns
 * {ok, sinkPath?, reason?}; NEVER throws. `opts.maxBytes` / `opts.keep` bound the sink
 * (defaults MAX_SINK_BYTES / KEEP_ROTATED).
 */
function appendReceipt(sinkRoot, receipt, opts = {}) {
  try {
    const c = containedSinkDir(sinkRoot);
    if (!c.ok) return { ok: false, reason: c.reason };
    const maxBytes = Number.isInteger(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : MAX_SINK_BYTES;
    const keep = Number.isInteger(opts.keep) && opts.keep >= 0 ? opts.keep : KEEP_ROTATED;
    const line = serializeBounded(receipt);
    if (line === null) return { ok: false, reason: `receipt exceeds ${MAX_LINE_BYTES} bytes even with every free-text field truncated` };
    const rot = rotateIfFull(c.dir, c.file, maxBytes, keep);
    if (!rot.ok) return { ok: false, reason: rot.reason };
    const { appendSinkLine } = require("./append-sink.js");
    // `additionalRoots: []` — this sink lives in the WRITER's own repo (`c.root`) by construction,
    // and containedSinkDir already required it to resolve there exactly; the main-checkout root
    // `mainCheckoutBoundaryRoots` would add is a location this sink must NOT widen to.
    const w = appendSinkLine({ repoDir: c.root, additionalRoots: [], sinkPath: c.file, line });
    if (!w || !w.ok) return { ok: false, reason: `${(w && w.error) || "append failed"} — ${(w && w.reason) || ""}` };
    return { ok: true, sinkPath: c.file };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || "receipt append threw" };
  }
}

function diagnose(writeErr, reason) {
  const msg = `[stop-receipt] receipt NOT recorded (${sanitizeReason(reason) || "unknown"}) — measurement only; this Stop is unaffected\n`;
  try {
    if (typeof writeErr === "function") writeErr(msg);
    else fs.writeSync(2, msg);
  } catch {
    /* stderr unavailable: nothing further can be said */
  }
}

/**
 * Build and append the receipt for ONE Stop attempt. NEVER throws, never blocks beyond its
 * bounded synchronous reads/append; any failure is one stderr diagnostic.
 *   a.runtime "claude" | "codex"; a.sinkRoot — the WRITER's own repo, where the row lands;
 *   a.repoDir — the payload-derived dir the handover cycle is located from; a.payload;
 *   a.attemptedAtMs; a.dispatcher; a.queue (queueAtAttempt, taken BEFORE the stdout handoff);
 *   a.commit (claude only); a.stdoutHandoff "ok" | "failed"; a.stderrHandoff (optional);
 *   a.ack; a.ackReceipts; a.exitCode — the exit the process really takes;
 *   a.configDir / a.pid — the context-state locator inputs; a.writeErr — optional sink for
 *   the diagnostic (default fs.writeSync(2)).
 */
function recordStopAttempt(a) {
  try {
    const cycle = cycleOf({ repoDir: a.repoDir, configDir: a.configDir, pid: a.pid });
    const receipt = buildReceipt({
      runtime: a.runtime,
      attemptedAtMs: a.attemptedAtMs,
      payload: a.payload,
      dispatcher: a.dispatcher,
      queue: a.queue,
      readiness: readinessFor({ runtime: a.runtime, commit: a.commit, cycle }),
      stdoutHandoff: a.stdoutHandoff,
      stderrHandoff: a.stderrHandoff,
      ack: a.ack,
      ackReceipts: a.ackReceipts,
      exitCode: a.exitCode,
    });
    const w = appendReceipt(a.sinkRoot, receipt, a.sinkOpts || {});
    if (!w.ok) diagnose(a.writeErr, w.reason);
    return w;
  } catch (e) {
    diagnose(a && a.writeErr, (e && e.message) || "receipt build threw");
    return { ok: false, reason: sanitizeReason((e && e.message) || "receipt build threw") };
  }
}

/**
 * Append the minimal SKIP row for ONE Stop attempt (buildSkippedReceipt) through the SAME
 * contained, writer-anchored appendReceipt a full receipt uses. No queue read, no cycle locate.
 * NEVER throws; a failure is one stderr diagnostic. a.runtime; a.sinkRoot; a.attemptedAtMs;
 * a.skipped (a SKIP_CODES member); a.sinkOpts; a.writeErr.
 */
function recordSkippedAttempt(a) {
  try {
    const w = appendReceipt(a.sinkRoot, buildSkippedReceipt({ runtime: a.runtime, attemptedAtMs: a.attemptedAtMs, skipped: a.skipped }), a.sinkOpts || {});
    if (!w.ok) diagnose(a.writeErr, w.reason);
    return w;
  } catch (e) {
    diagnose(a && a.writeErr, (e && e.message) || "skip row build threw");
    return { ok: false, reason: sanitizeReason((e && e.message) || "skip row build threw") };
  }
}

// ── READ SIDE ───────────────────────────────────────────────────────────────

/** Read the listed files; {vanished: name} when one disappeared between the listing and its read. */
function readListed(c, files) {
  const { readSinkFile } = require("./append-sink.js");
  const rows = [];
  let unparsable = 0;
  for (const n of files) {
    // `additionalRoots: []` — the reader holds the writer's containment: the sink is inside `c.root`.
    const r = readSinkFile({ repoDir: c.root, additionalRoots: [], sinkPath: path.join(c.dir, n), maxBytes: 4 * MAX_SINK_BYTES });
    if (!r.ok && r.absent) return { vanished: n };
    if (!r.ok) return { state: "unreadable", reason: `${n}: ${r.reason || r.error || "read failed"}` };
    for (const l of r.text.split("\n")) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l);
        if (o && READ_SCHEMAS.includes(o.schema)) rows.push(o);
        else unparsable++;
      } catch {
        unparsable++;
      }
    }
  }
  return { state: "ok", rows, unparsable, files: files.length };
}

/**
 * Every receipt row in the repo's ledger (rotated generations first, oldest first).
 * {state: "ok", rows, unparsable, files} | {state: "absent"} | {state: "unreadable", reason}.
 * `opts.__afterList(attempt)` — TEST SEAM ONLY: called after each listing, before the reads, so
 * a test can make a listed file vanish at the race point instead of racing for it.
 */
function readLedger(repoDir, opts = {}) {
  const root = repoRootOf(repoDir);
  if (root === null) {
    return { state: "unreadable", code: NO_REPO_ROOT, reason: "no repo root: the directory is the home directory, which is never a repo root; nothing was read" };
  }
  const c = containedSinkDir(root);
  if (!c.ok) return { state: "unreadable", reason: c.reason };
  let last = null;
  for (let attempt = 0; attempt < LIST_ATTEMPTS; attempt++) {
    let names;
    try {
      names = fs.readdirSync(c.dir);
    } catch (e) {
      if (e && e.code === "ENOENT") return { state: "absent" };
      return { state: "unreadable", reason: (e && e.code) || "error" };
    }
    const files = [...listGenerations(names), ...(names.includes(SINK_BASENAME) ? [SINK_BASENAME] : [])];
    if (!files.length) return { state: "absent" };
    if (opts && typeof opts.__afterList === "function") opts.__afterList(attempt);
    const r = readListed(c, files);
    if (!r.vanished) return r;
    last = r.vanished;
  }
  return { state: "unreadable", reason: `${last} vanished between listing and read on ${LIST_ATTEMPTS} consecutive listings (concurrent rotation)` };
}

/**
 * The pending-at-attempt rate. An absent or unreadable ledger is UNKNOWN in every figure —
 * never 0. `rate` is pending_attempts / attempts-with-a-known-count; UNKNOWN when that
 * denominator is 0. SKIP rows (an own `skipped` key) are counted ONLY in skipped_attempts:
 * never in attempts, pending, unknown_queue, the cycle subset or by_runtime. skipped_by_reason
 * tallies the SKIP_CODES alone, in a null-prototype object; any other `skipped` value — a
 * forged "constructor" / "__proto__", a non-string — is counted in unknown_skip_code instead.
 */
function rate(repoDir) {
  const l = readLedger(repoDir);
  if (l.state !== "ok") {
    return { state: UNKNOWN, reason: l.state === "absent" ? "no receipt ledger exists" : `ledger unreadable (${l.reason})`, attempts: UNKNOWN, pending_attempts: UNKNOWN, unknown_queue: UNKNOWN, rate: UNKNOWN, under_cycle: UNKNOWN, under_cycle_pending: UNKNOWN, skipped_attempts: UNKNOWN, skipped_by_reason: UNKNOWN, unknown_skip_code: UNKNOWN };
  }
  const isSkip = (r) => Object.prototype.hasOwnProperty.call(r, "skipped");
  const skippedRows = l.rows.filter(isSkip);
  const rows = l.rows.filter((r) => !isSkip(r));
  const skippedByReason = Object.create(null);
  let unknownSkipCode = 0;
  for (const r of skippedRows) {
    if (typeof r.skipped === "string" && SKIP_CODES.includes(r.skipped)) skippedByReason[r.skipped] = (skippedByReason[r.skipped] || 0) + 1;
    else unknownSkipCode++;
  }
  const known = rows.filter((r) => Number.isInteger(r.pending_count));
  const pending = known.filter((r) => r.pending_count > 0);
  const cycle = rows.filter((r) => r.readiness && r.readiness.cycle === "in-play");
  const byRuntime = {};
  for (const r of rows) byRuntime[r.runtime] = (byRuntime[r.runtime] || 0) + 1;
  return {
    state: "ok",
    attempts: rows.length,
    pending_attempts: pending.length,
    unknown_queue: rows.length - known.length,
    rate: known.length ? pending.length / known.length : UNKNOWN,
    under_cycle: cycle.length,
    under_cycle_pending: cycle.filter((r) => Number.isInteger(r.pending_count) && r.pending_count > 0).length,
    by_runtime: byRuntime,
    skipped_attempts: skippedRows.length,
    skipped_by_reason: skippedByReason,
    unknown_skip_code: unknownSkipCode,
    unparsable_rows: l.unparsable,
    files: l.files,
    turn_end: UNKNOWN,
  };
}

function main(argv) {
  if (!argv.includes("--rate")) {
    process.stderr.write("usage: stop-receipt.js --rate [--repo <dir>] [--json]\n");
    return 2;
  }
  const i = argv.indexOf("--repo");
  const repo = i >= 0 && argv[i + 1] ? argv[i + 1] : process.cwd();
  const r = rate(repo);
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(r) + "\n");
    return 0;
  }
  if (r.state !== "ok") {
    process.stdout.write(`pending-at-attempt rate: UNKNOWN (${r.reason}) — absence is not zero\n`);
    return 0;
  }
  const pct = typeof r.rate === "number" ? `${(r.rate * 100).toFixed(1)}%` : UNKNOWN;
  process.stdout.write(
    `stop attempts: ${r.attempts}\nattempts with pending>0: ${r.pending_attempts}\nattempts with queue UNKNOWN: ${r.unknown_queue}\n` +
      `pending-at-attempt rate: ${pct}\nattempts under a handover cycle: ${r.under_cycle} (pending>0: ${r.under_cycle_pending})\n` +
      `skipped attempts (no queue reading; not in any figure above): ${r.skipped_attempts}${r.skipped_attempts ? ` (${[...Object.entries(r.skipped_by_reason), ...(r.unknown_skip_code ? [["unknown skip code", r.unknown_skip_code]] : [])].map(([k, v]) => `${k}: ${v}`).join(", ")})` : ""}\n` +
      `unparsable rows: ${r.unparsable_rows} (not counted in any figure above)\n` +
      `turn end: UNKNOWN (an attempt is not a completed turn)\n`,
  );
  return 0;
}

module.exports = {
  SCHEMA,
  READ_SCHEMAS,
  SINK_SUBDIR,
  SINK_BASENAME,
  MAX_SINK_BYTES,
  MAX_LINE_BYTES,
  KEEP_ROTATED,
  BLIND_CLASSES,
  SKIP_CODES,
  COVERAGE,
  NO_REPO_ROOT,
  isoWithOffset,
  sanitizeReason,
  boundField,
  fileSha256,
  sha256,
  containedSinkDir,
  queueAtAttempt,
  cycleOf,
  readinessFor,
  buildReceipt,
  buildSkippedReceipt,
  appendReceipt,
  recordStopAttempt,
  recordSkippedAttempt,
  readLedger,
  rate,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
