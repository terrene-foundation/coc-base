/**
 * hook-findings — the per-session findings record behind the COMPACT hook render.
 *
 * WHY THIS EXISTS (journal/0661, owner directive 2026-10-10). Every non-block finding used to be
 * rendered in full into context on every firing — WHAT HAPPENED / WHY / REPORT TO USER / WHO "USER"
 * MEANS HERE / THEN — and at `Stop` it went to `systemMessage`, which the host shows ONLY to the
 * human and never to the model. MEASURED over this operator's six loom transcripts: 10.2 MB of Stop
 * `systemMessage` across 3,277 firings (median 2,457 B, p90 5,367 B per firing), 2.38 MB of the
 * WHO-"USER" boilerplate alone, and of 2,801 worktree-conservation renders 2,323 were repeats once
 * idle-minute digits are normalized — while only 13 of them ever reached the agent (as a refusal).
 * The human relayed the rest by hand.
 *
 * THE CONTRACT this module serves for `instruct-and-wait.js`:
 *   - the FULL rendered body of a finding is appended to ONE per-session file on disk, which the
 *     agent reads on demand: `<repo>/.claude/learning/hook-findings/<session>.md`, one `## F<n>`
 *     section per finding;
 *   - context receives ONE line naming the rule, a <=160-char summary and that pointer;
 *   - a finding is a REPEAT only after previously confirmed successful stdout handoff
 *     (`.claude/hooks/lib/hook-findings.js::recordFinding` reads the `seen` rows,
 *     `::confirmDelivery` writes them; `.claude/hooks/lib/dispatch-main.js::finish` calls it from
 *     the stdout handoff's completion callback);
 *   - a non-refusing `Stop` finding is QUEUED for the agent and delivered at the next
 *     `UserPromptSubmit` by `drainForAgent` — the systemMessage channel cannot reach the model.
 *
 * FAIL-OPEN, everywhere: any failure to resolve a session, write the record or read the state
 * returns `null` / not-a-repeat, and the caller renders the FULL legacy body. A broken record can
 * cost bytes; it can never swallow a finding. Writes go through `append-sink.js` (symlink /
 * containment hardened, no newline injection).
 *
 * ACCEPTED RESIDUAL (inherits `hook-output-discipline.md` § Accepted Residual): the dedupe state is
 * an in-tree file at a path that is a pure function of `session_id`, so anyone with repo write can
 * pre-plant "seen" rows. Bounded here more tightly than the markers that section names: a repeat at
 * a NON-Stop event still renders a one-line stub with the pointer (never silence), a refusal is
 * never suppressed by it (the refusal verdict is computed before and independently of this
 * module), and block/deny bodies never pass through it at all.
 *
 * KILL SWITCH: `COC_HOOK_FINDINGS_COMPACT=0|off|false|no|disabled` restores the full legacy render.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR_REL = path.join(".claude", "learning", "hook-findings");
const SUMMARY_MAX = 160;
const RULE_MAX = 60;
const STATE_MAX_BYTES = 1024 * 1024;
const MAX_DRAIN_LINES = 12;
// Escalation classes — `CLAUDE.md` § Orchestrator Forest Mode ALWAYS-ESCALATE, closed set. A
// finding carrying one of these goes to the HUMAN (one line) as well as to the agent.
const ESCALATE_CLASSES = new Set([
  "security",
  "disclosure",
  "cross-repo",
  "owner-only",
  "destructive",
  "structural-gate",
]);

function compactEnabled(env) {
  const v = String((env || process.env).COC_HOOK_FINDINGS_COMPACT || "")
    .trim()
    .toLowerCase();
  return !["0", "off", "false", "no", "disabled"].includes(v);
}

function _nonEmpty(s) {
  return typeof s === "string" && s.trim() !== "";
}

/**
 * The raw hook payload as the in-process engine holds it. Under `lib/hook-engine.js` every
 * detector's fd-0 read is served from the dispatcher's already-drained payload by the
 * `hookEngineReadFileSync` shim, so a SECOND read returns the same bytes. Outside the engine fd 0
 * is the real stdin — already drained, or a TTY that would block — so it is NEVER read there: the
 * shim's presence is checked structurally (the engine module is loaded AND `fs.readFileSync` is the
 * shim) before the read is attempted.
 */
function _enginePayload() {
  try {
    const loaded = Object.keys(require.cache).some((k) =>
      k.endsWith(path.join("hooks", "lib", "hook-engine.js")),
    );
    if (!loaded || fs.readFileSync.name !== "hookEngineReadFileSync") return null;
    const raw = fs.readFileSync(0, "utf8");
    const o = JSON.parse(raw || "null");
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

// The repo root (`stop-refusal.js::_repoRootOf`), or NULL when the cwd IS the home directory —
// home is never a repo root. A null root resolves NO context (`resolveContext` → null, whose
// every caller already renders/behaves as with no findings store), and every reader and writer
// below refuses a context without a root, so nothing is read from or written under HOME. If
// stop-refusal.js cannot load, the fallback keeps the dir — except at home, null for the same reason.
function _repoRootOf(dir) {
  try {
    return require("./stop-refusal.js")._repoRootOf(dir);
  } catch {
    const d = path.resolve(String(dir || process.cwd()));
    return _isHomeFallback(d) ? null : d;
  }
}

function _isHomeFallback(d) {
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

/** The typed no-root reason: a session resolved, but its cwd is home — nothing read or written. */
const NO_REPO_ROOT = "no-repo-root";

function _hasRoot(ctx) {
  return !!ctx && _nonEmpty(ctx.root);
}

/**
 * Resolve { sessionId, repoDir, root, transcriptPath } from, in order: an explicit `payload`, the
 * refusal request's raw payload, the engine's payload. `null` when no session id resolves, AND
 * when the resolved cwd has no repo root (it IS home) — see `_contextOrReason` for which.
 */
function resolveContext(a) {
  const r = _contextOrReason(a);
  return r.ctx || null;
}

/** { ctx } | { reason: "no-session" | "no-repo-root" } — resolveContext with its WHY kept. */
function _contextOrReason(a) {
  const o = a || {};
  const cands = [
    o.payload,
    o.refusalRequest && o.refusalRequest.payload,
  ].filter((p) => p && typeof p === "object" && !Array.isArray(p));
  let p = cands.find((c) => _nonEmpty(c.session_id));
  if (!p) {
    const e = _enginePayload();
    if (e && _nonEmpty(e.session_id)) p = e;
  }
  if (!p) return { reason: "no-session" };
  const repoDir =
    (o.refusalRequest && _nonEmpty(o.refusalRequest.repoDir) && o.refusalRequest.repoDir) ||
    (_nonEmpty(p.cwd) && p.cwd) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const root = _repoRootOf(repoDir);
  if (root === null) return { reason: NO_REPO_ROOT };
  return { ctx: {
    sessionId: String(p.session_id),
    agentId: _nonEmpty(p.agent_id) ? String(p.agent_id) : null,
    repoDir,
    root,
    transcriptPath: _nonEmpty(p.transcript_path) ? p.transcript_path : null,
  } };
}

function _safeSid(sid) {
  const s = String(sid);
  const safe = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "unknown-session";
  return safe === s ? safe : safe + "-" + _hash(s);
}

function _identity(ctx) {
  return _safeSid(ctx.sessionId) + (ctx.agentId ? "-agent-" + _hash(ctx.agentId) : "");
}

/** null for a context without a repo root — never a path joined onto a null root. */
function findingsPath(ctx) {
  if (!_hasRoot(ctx)) return null;
  return path.join(ctx.root, DIR_REL, `${_identity(ctx)}.md`);
}

function statePath(ctx) {
  if (!_hasRoot(ctx)) return null;
  return path.join(ctx.root, DIR_REL, `${_identity(ctx)}.state.jsonl`);
}

function _sink() {
  return require("./append-sink.js");
}

function _append(ctx, sinkPath, line) {
  if (!_hasRoot(ctx) || !_nonEmpty(sinkPath)) return false; // no repo root: write nothing
  if (sinkPath === statePath(ctx)) {
    const row = JSON.parse(line);
    if (!_rowShape(row, false)) return false;
    line = JSON.stringify({ ...row, origin: _origin(ctx) });
  }
  const { appendSinkLine, mainCheckoutBoundaryRoots } = _sink();
  const w = appendSinkLine({
    repoDir: ctx.root,
    additionalRoots: mainCheckoutBoundaryRoots(ctx.root),
    sinkPath,
    line,
  });
  return !!(w && w.ok);
}

function _origin(ctx) {
  return { type: "native-hook-findings/v1", session: ctx.sessionId, agent: ctx.agentId || null };
}

function _keys(row, required, optional = []) {
  return !!row && typeof row === "object" && !Array.isArray(row) &&
    required.every((k) => Object.hasOwn(row, k)) &&
    Object.keys(row).every((k) => required.includes(k) || optional.includes(k));
}

function _rowShape(row, withOrigin = true) {
  const origin = withOrigin ? ["origin"] : [];
  const hex = (v) => typeof v === "string" && /^[a-f0-9]{16}$/.test(v);
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (row.k === "record" || row.k === "seen")
    return _keys(row, ["k", "sig", "content", "n", ...origin]) && hex(row.sig) && hex(row.content) && Number.isSafeInteger(row.n) && row.n > 0;
  if (row.k === "drained") return _keys(row, ["k", "id", ...origin]) && hex(row.id);
  if (row.k === "queue") return _keys(row, ["k", "id", "line", ...origin], ["seen"]) && hex(row.id) &&
    _nonEmpty(row.line) && Buffer.byteLength(row.line, "utf8") <= STATE_MAX_BYTES &&
    (row.seen === undefined || (row.seen.k === "seen" && _rowShape(row.seen, false)));
  return false;
}

function _validStateRow(ctx, row) {
  if (!_rowShape(row) || !_keys(row.origin, ["type", "session", "agent"])) return false;
  const expected = _origin(ctx);
  return Object.keys(expected).every((k) => row.origin[k] === expected[k]);
}

function findingDataLine(text) {
  const clean = require("./compaction-handoff.js").sanitizeInjected(text, { maxChars: STATE_MAX_BYTES * 6 });
  const data = [...JSON.stringify({ finding_text: clean })].map((ch) => {
    const cp = ch.codePointAt(0);
    return "<>`~".includes(ch) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)
      ? "\\u" + cp.toString(16).padStart(4, "0") : ch;
  }).join("");
  return "[HOOK-FINDING-DATA] " + data;
}

/** Parsed, closed-shape producer rows, or null on invalid/unreadable state (absent → []). */
function readState(ctx) {
  if (!_hasRoot(ctx)) return null; // no repo root: nothing is read, and the state is UNKNOWN
  try {
    const { readSinkFile, mainCheckoutBoundaryRoots } = _sink();
    const r = readSinkFile({
      repoDir: ctx.root,
      additionalRoots: mainCheckoutBoundaryRoots(ctx.root),
      sinkPath: statePath(ctx),
      maxBytes: STATE_MAX_BYTES,
    });
    if (!r.ok) return r.absent ? [] : null;
    const rows = [];
    for (const l of r.text.split("\n")) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l);
        if (!_validStateRow(ctx, o)) return null;
        rows.push(o);
      } catch {
        return null;
      }
    }
    return rows;
  } catch {
    return null;
  }
}

function _hash(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex").slice(0, 16);
}

/** One line, control characters flattened, bounded. */
function oneLine(s, max) {
  // eslint-disable-next-line no-control-regex
  const t = String(s == null ? "" : s).replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * The rule id a reader can grep: `why` up to its first ` — ` / `: ` clause, bounded. Most callers
 * put the rule id first (`repo-scope-discipline/MUST-NOT-1`, `rules/wip-discipline.md MUST-9`).
 */
function ruleIdOf(why) {
  const w = oneLine(why, 400);
  const cut = w.split(/ — | - |: |; /)[0];
  return oneLine(cut || w || "hook", RULE_MAX);
}

// CLOCK text only — durations and timestamps. Counts, PR/issue numbers and SHAs are STATE and stay
// significant: normalizing every digit run made "PR #123" and "PR #456", or "42 paths" and "43
// paths", read as the same finding, and a repeat at a non-refusing Stop renders nothing (security
// review M3, 2026-10-10).
const CLOCK_RE =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?\b|\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds?|min|mins|minutes?|h|hrs?|hours?|d|days?)\b/g;

function _declock(s) {
  return String(s || "").replace(CLOCK_RE, "<t>");
}

/**
 * Content identity of a finding. A caller-supplied `dedupeKey` wins (a guard knows which of its
 * fields are STATE and which are clock). Otherwise the what/report text with CLOCK text normalized,
 * so "idle 72 min" → "idle 75 min" is not a change while "42 paths" → "43 paths" is.
 */
function contentKey(f) {
  if (_nonEmpty(f.dedupeKey)) return "k:" + f.dedupeKey;
  const report = Array.isArray(f.agent_must_report) ? f.agent_must_report.join("\n") : "";
  return "t:" + _declock(f.what_happened) + "\n" + _declock(report);
}

/**
 * Record a finding. Returns { ref, n, repeat, ofN } or null on any failure (caller renders legacy).
 * A REPEAT follows a confirmed successful stdout handoff and writes nothing
 * (`.claude/hooks/lib/hook-findings.js::confirmDelivery`; `.claude/hooks/lib/dispatch-main.js::finish`).
 */
function recordFinding(ctx, f) {
  if (!_hasRoot(ctx)) return null; // no repo root: nothing written; the caller renders legacy
  try {
    const rows = readState(ctx);
    if (rows === null) return null;
    const sig = _hash("sig:" + (f.hookEvent || "") + "|" + String(f.why || "") + "|" + String(f.severity || ""));
    const content = _hash(contentKey(f) + "|" + String(f.why || "") + "|" + String(f.severity || ""));
    let n = 0;
    let lastForSig = null;
    for (const r of rows) {
      if (r.k === "seen" || r.k === "record") {
        if (Number.isInteger(r.n) && r.n > n) n = r.n;
        if (r.k === "seen" && r.sig === sig) lastForSig = r;
      }
    }
    const rel = path.relative(ctx.root, findingsPath(ctx)).split(path.sep).join("/");
    if (lastForSig && lastForSig.content === content) {
      return { ref: `${rel}#F${lastForSig.n}`, n: lastForSig.n, repeat: true };
    }
    n += 1;
    const head = `## F${n} · ${new Date().toISOString()} · ${f.hookEvent || "?"} · ${ruleIdOf(f.why)}`;
    const fp = findingsPath(ctx);
    if (!_append(ctx, fp, "")) return null;
    if (!_append(ctx, fp, head)) return null;
    for (const line of String(f.body || "").split("\n")) {
      if (!_append(ctx, fp, line)) return null;
    }
    if (!_append(ctx, statePath(ctx), JSON.stringify({ k: "record", sig, content, n }))) return null;
    return { ref: `${rel}#F${n}`, n, repeat: false,
      receipt: { ctx, row: { k: "seen", sig, content, n } } };
  } catch {
    return null;
  }
}

/** Queue one compact line for delivery to the agent at its next UserPromptSubmit. */
function queueForAgent(ctx, line, receipt) {
  try {
    const rows = readState(ctx);
    if (rows === null) return false;
    const id = receipt ? _hash(receipt.row.sig + receipt.row.content) : _hash(line);
    const acked = new Set(rows.filter((r) => r.k === "drained").map((r) => r.id));
    if (rows.some((r) => r.k === "queue" && r.id === id && !acked.has(id))) return true;
    return _append(ctx, statePath(ctx), JSON.stringify({ k: "queue", id, line: String(line), seen: receipt && receipt.row }));
  } catch {
    return false;
  }
}

/**
 * Prepare queue lines and receipts without acknowledging them; successful final stdout handoff
 * confirms drained ids (`.claude/hooks/lib/hook-findings.js::prepareForAgent` /
 * `::confirmDelivery`; `.claude/hooks/lib/dispatch-main.js::finish`). Returns string[]; NEVER throws.
 */
function drainForAgent(payload) {
  const batch = prepareForAgent(payload);
  const lines = batch.lines;
  Object.defineProperty(lines, "findingsDelivery", { value: batch.receipts });
  return lines;
}

/** The ONE reduction of producer rows: unique queued ids, and those with no matching drained id. */
function _reduce(rows) {
  const acked = new Set(rows.filter((r) => r.k === "drained").map((r) => r.id));
  const queued = new Set();
  const unique = new Map();
  for (const r of rows) {
    if (r.k !== "queue" || !_nonEmpty(r.id)) continue;
    queued.add(r.id);
    if (!acked.has(r.id)) unique.set(r.id, r);
  }
  return { pending: [...unique.values()], queued };
}

function pendingRows(ctx) {
  const rows = readState(ctx);
  if (rows === null) return null;
  return _reduce(rows).pending;
}

/**
 * The queue's state for a MEASUREMENT reader (lib/stop-receipt.js — the per-attempt Stop
 * receipt): ONE readState, the SAME reduction pendingRows feeds the readiness predicate
 * (context-state.js::pendingFindingsReason via pendingForAgent), so the recorded count and
 * the readiness input cannot disagree about what "pending" means.
 *   state "empty"      — readable, nothing ever queued (absent state reads [] — readState)
 *   state "pending"    — ≥1 queued id with no matching drained id
 *   state "drained"    — ≥1 queued id, every one acknowledged
 *   state "unreadable" — readState returned null; every count is null (UNKNOWN), never 0
 *   state "no-context" — no session id in the payload; nothing was read
 *   state "no-repo-root" — a session, but its cwd IS home (never a repo root); nothing was read
 * `drained` is true ONLY for "drained" — an empty queue drained nothing — and null when
 * UNKNOWN. A session-less payload does NOT fall back to the engine payload (resolveContext's
 * last resort): a snapshot bound to some other session would be a wrong answer, not a guess.
 * NEVER throws.
 */
function queueSnapshot(payload) {
  const unknown = (state) => ({ state, pending: null, queued: null, drained: null });
  try {
    if (!payload || typeof payload !== "object" || !_nonEmpty(payload.session_id)) return unknown("no-context");
    const r = _contextOrReason({ payload });
    if (!r.ctx) return unknown(r.reason === NO_REPO_ROOT ? NO_REPO_ROOT : "no-context");
    const rows = readState(r.ctx);
    if (rows === null) return unknown("unreadable");
    const { pending, queued } = _reduce(rows);
    const state = queued.size === 0 ? "empty" : pending.length ? "pending" : "drained";
    return {
      state,
      pending: pending.length,
      queued: queued.size,
      drained: state === "drained",
    };
  } catch {
    return unknown("unreadable");
  }
}

function pendingForAgent(payload) {
  const ctx = resolveContext({ payload });
  if (!ctx) return null;
  const rows = pendingRows(ctx);
  return rows === null ? null : rows.length;
}

function prepareForAgent(payload) {
  const ctx = resolveContext({ payload });
  if (!ctx) return { lines: [], receipts: [] };
  const rows = pendingRows(ctx);
  if (rows === null) return { lines: ["[HOOK-FINDINGS] QUEUE UNREADABLE — delivery remains outstanding; inspect " + statePath(ctx)], receipts: [] };
  const selected = rows.slice(0, MAX_DRAIN_LINES);
  return { lines: selected.map((r) => findingDataLine(r.line)), receipts: selected.map((r) => ({
    ctx, row: { k: "drained", id: r.id }, seen: r.seen, text: findingDataLine(r.line),
  })) };
}

function receiptForContext(r, trusted) {
  if (!r || !r.ctx || !trusted || !_nonEmpty(trusted.root)) return null;
  try {
    if (fs.realpathSync(r.ctx.root) !== fs.realpathSync(trusted.root) ||
        r.ctx.sessionId !== trusted.sessionId || (r.ctx.agentId || null) !== (trusted.agentId || null)) return null;
  } catch { return null; }
  if (!r.row || !["seen", "drained"].includes(r.row.k) || !_rowShape(r.row, false)) return null;
  const rows = readState(trusted);
  if (rows === null) return null;
  if (r.row.k === "seen") {
    if (r.seen || !rows.some(v => v.k === "record" && v.sig === r.row.sig && v.content === r.row.content && v.n === r.row.n)) return null;
  } else {
    const queued = rows.find(v => v.k === "queue" && v.id === r.row.id);
    if (!queued || JSON.stringify(queued.seen) !== JSON.stringify(r.seen)) return null;
  }
  return { ...r, ctx: { ...trusted } };
}

function confirmDelivery(receipts, trusted) {
  let ok = true;
  for (const r of receipts || []) {
    const bound = receiptForContext(r, trusted);
    if (!bound) { ok = false; continue; }
    if (!_append(bound.ctx, statePath(bound.ctx), JSON.stringify(bound.row))) { ok = false; continue; }
    if (bound.seen && !_append(bound.ctx, statePath(bound.ctx), JSON.stringify(bound.seen))) ok = false;
  }
  return ok;
}

const RULE_ESCALATION_CLASSES = Object.freeze([
  ["cross-repo", /^(?:rules\/)?(?:repo-scope-discipline|cross-repo)(?:\.md)?(?:\b|\/)/],
  ["disclosure", /^(?:rules\/)?(?:cross-ecosystem-disclosure-guard|disclosure|tenant-disclosure)(?:\.md)?(?:\b|\/)/],
  ["structural-gate", /^(?:rules\/)?(?:landing-window|validate-prod-deploy|check-merge-separation|push-preflight|ci-cost-discipline|release|plan-approval|structural-gate)(?:-guard)?(?:\.md)?(?:\b|\/)/],
  ["structural-gate", /^rules\/git\.md § Discipline\b/],
  ["destructive", /^(?:rules\/)?(?:git|rebase-content-loss-guard|force-push-recovery-guard|destructive-ops|destructive-operation)(?:\.md)?(?:\b|\/)/],
  ["destructive", /^orchestration-launch-ledger\.md MUST-6\(b\)/],
  ["destructive", /^multi-operator-coc\/journal-write-guard MUST-NOT-1\b/],
  ["destructive", /^wip-discipline\.md MUST-4\b/],
  ["security", /^(?:rules\/)?(?:security|trust-posture|settings-deny-self-protection|tenant-isolation|tenant-upsert-guard|validate-deployment|auth|signing|revocation|kill-path|process-signalling|process-signaling|fail-closed)(?:\.md)?(?:\b|\/)/],
  ["security", /^multi-operator-(?:coc|coordination)\/(?:signing-mutation-guard|genesis-anchor-guard|integrity-guard|adjacency-leasecheck|journal-write-guard|coordination)(?:\b|\/)/],
  ["owner-only", /^(?:rules\/)?(?:owner-only|operator-gate)(?:\.md)?(?:\b|\/)/],
]);

function escalationClass(why, explicit) {
  // Producer rule identity only; never classify the command, summary or report body.
  const ids = String(why || "").split(/ — | - |: |; /)[0].split(/,\s*/);
  const inferred = [...new Set(ids.map((id) =>
    RULE_ESCALATION_CLASSES.find(([, pattern]) => pattern.test(id.trim()))?.[0]
  ).filter(Boolean))];
  const supplied = explicit !== undefined && explicit !== null && explicit !== false;
  if (supplied && !ESCALATE_CLASSES.has(explicit))
    return `unclassified:${oneLine(explicit, 24)}`;
  if (supplied && inferred.length && !inferred.includes(explicit))
    return `unclassified:mismatch:${oneLine(explicit, 24)}:${inferred.join("+")}`;
  if (supplied && !inferred.includes(explicit)) inferred.push(explicit);
  return inferred.length ? inferred.join("+") : null;
}

module.exports = {
  DIR_REL,
  NO_REPO_ROOT,
  SUMMARY_MAX,
  RULE_MAX,
  ESCALATE_CLASSES,
  escalationClass,
  compactEnabled,
  resolveContext,
  findingsPath,
  statePath,
  readState,
  recordFinding,
  queueForAgent,
  drainForAgent,
  prepareForAgent,
  pendingForAgent,
  queueSnapshot,
  confirmDelivery,
  receiptForContext,
  ruleIdOf,
  contentKey,
  oneLine,
};
