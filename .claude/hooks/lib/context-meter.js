"use strict";
/**
 * context-meter — pure logic behind `hooks/context-meter.js`: read the session's
 * CURRENT context size from a bounded tail of its transcript, compare it with the
 * handover point, and decide whether (and what) to tell the agent.
 *
 * Owner directives (2026-10-10, verbatim): "we need to efficienlty let the main agent
 * know the current context length after every turn? so that it can start plannign for
 * handover or wrapup." · "no 400k is where it starts the plan and write and wrap up." ·
 * "this entire pre and post MUST BE AUTONOMOUS, not requiring human intervention at
 * ANY STEP." Its 400k figure is superseded by the 2026-10-17 "our context is 500k"
 * (§ THE POINTS).
 *
 * ── THE READING ──────────────────────────────────────────────────────────────
 * context = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *           + output_tokens
 * of the LAST main-thread assistant record carrying `message.usage`. Skipped:
 *   - `isSidechain: true` records (a sub-agent's turns, not this window);
 *   - `<synthetic>` / `isApiErrorMessage` records. MEASURED on this host's
 *     transcripts: CC writes those with an ALL-ZERO usage block, so reading one
 *     would report a 0-token context — the exact false reading MUST-7 of
 *     probe-driven-verification.md bars;
 *   - any usage block summing to 0, for the same reason.
 * A `compact_boundary` system record NEWER than the last usage record means the
 * window was just replaced; its `compactMetadata.postTokens` is reported as a
 * post-compaction ESTIMATE (status `compaction-estimate`), and without it the
 * reading is UNKNOWN. An unmeasurable reading is ALWAYS `null` + a reason —
 * never 0.
 *
 * BOUNDED: transcripts reach 133 MB on this host (measured, the live session
 * this was built in). The read is a tail window — 256 KB first, then ONE retry at
 * 2 MB when the first window held no usable record (a large tool_result can push
 * the last assistant record further back) — on ONE descriptor opened with the
 * same O_NOFOLLOW|O_NONBLOCK guards as `transcript-read.js` (imported, not copied).
 *
 * ── THE POINTS ──────────────────────────────────────────────────────────────
 * handover point — where the agent starts writing the handover and wraps up.
 * backstop point — where Claude Code's own compaction fires. It must sit at least
 *                  MIN_HEADROOM_TOKENS (30000) ABOVE the handover point; less is
 *                  `headroom_invalid` and there is NO handover point at all.
 * Source precedence (csq's final points contract, 2026-10-10):
 *   1. csq's per-terminal points file `$CLAUDE_CONFIG_DIR/csq-context-points.json`
 *      = {schema_version, handover_tokens, backstop_tokens, headroom_tokens,
 *      window_tokens, model, source, handover_status, cc_auto_compact_window,
 *      cc_autocompact_pct_override, computed_at}. readCsqPoints below additionally
 *      requires descriptor mtime age in [0,120s]; computed_at is points-change time,
 *      not a heartbeat. Only a fresh PRESENT file is authoritative,
 *      including a null handover (handover_status no_backstop / below_floor /
 *      headroom_invalid): CC autocompact is then the only boundary, so no handover
 *      line fires and there is NO env fallback. While present, csq's own hook is the
 *      PRIMARY emitter: this meter injects nothing but still writes its state file.
 *      A CORRUPT file is reported on stderr and does NOT fall back either: the meter
 *      emits the reading with NO handover point. Values are data — never a path.
 *   2. When the file is ABSENT or STALE: env. backstop = (CLAUDE_CODE_AUTO_COMPACT_WINDOW − 20000) ×
 *      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE / 100 (CC's autocompact trigger; the 20k output
 *      reserve was MEASURED by csq — a real compaction at preTokens 400,237). When the
 *      pct is set but the window env is UNSET, CC computes over the model's own window,
 *      so the window is ASSUMED_MODEL_WINDOW_TOKENS (1,000,000 — the window csq measured
 *      that compaction under); an explicit but unparseable window is NOT replaced.
 *      handover = an explicit COC_HANDOVER_AT_TOKENS when set; else backstop −
 *      COC_HANDOVER_HEADROOM_TOKENS (default 60000, CYCLE.md §1.3; below 30000 or
 *      unparseable ⇒ headroom_invalid, NO handover point); else, with no
 *      computable backstop, DEFAULT_HANDOVER_AT_TOKENS (440000 = an assumed 500k
 *      backstop − 60k). Owner directive 2026-10-17 (ROOT ledger 09:15): "our context is
 *      500k" — it supersedes the 2026-10-10 "400k" ruling.
 *
 *
 * ── BANDS (workspaces/context-budget-2026-10-10/design/CYCLE.md §1.1) ─────────
 *   GREEN             tokens < handover
 *   HANDOVER-DUE      tokens ≥ handover — start the handover (seed first)
 *   HANDOVER-OVERDUE  tokens ≥ backstop − OVERDUE_BEFORE_BACKSTOP_TOKENS (30000);
 *                     with no known backstop, handover + 30000 — checkpoint unless the seed is current
 *   BACKSTOP          tokens ≥ backstop — CC compaction is imminent
 *   An unmeasurable reading has NO band (null) — never GREEN.
 *
 * ── WHEN IT SPEAKS ──────────────────────────────────────────────────────────
 * UserPromptSubmit: always ONE line (`[CTX] 212k/440k handover (48%) · …`).
 * PostToolUse: only when the reading rose ≥ RISE_STEP_TOKENS since the last
 * emitted reading for this session, or on EVERY call once in a band at/above
 * HANDOVER-DUE (one firm line); a bound, current seed instead says keep working.
 * Freshness: .claude/hooks/lib/context-meter.js:541-590. A fall silently
 * re-bases. Sub-agent
 * calls (`agent_id` present) are not metered: their context is a different window.
 * The context STATE file is written on every metered call, spoken or silent.
 *
 * ── START-ABOVE-HANDOVER GUARD ──────────────────────────────────────────────
 * A session whose FIRST measured reading is already ≥ the handover point fires NO
 * handover lines (it would loop handover → /clear → restart above the point); the state
 * file records handover_suppressed:"start-above-handover". A later reading below the
 * point re-arms it (suppressionOf).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// The handover point is DERIVED from the backstop: backstop − headroom (owner ruling
// 2026-10-10: "it should start earlier than that"). The fallback below applies only when
// no backstop is computable: an assumed backstop minus the default headroom. The assumed
// backstop is 500k — owner directive 2026-10-17 (ROOT ledger 09:15, verbatim): "our
// context is 500k". It supersedes the 2026-10-10 "400k is where autocompact kicks in".
const DEFAULT_HEADROOM_TOKENS = 60000;
const ASSUMED_BACKSTOP_TOKENS = 500000;
const DEFAULT_HANDOVER_AT_TOKENS = ASSUMED_BACKSTOP_TOKENS - DEFAULT_HEADROOM_TOKENS;
const OVERDUE_BEFORE_BACKSTOP_TOKENS = 30000;
// CC computes its autocompact trigger over the window MINUS an output reserve:
// backstop = (window − 20000) × pct / 100. csq MEASURED this 2026-10-10: a real
// compaction fired at preTokens 400,237 under window 1,000,000 × 40.8163% — i.e. on
// a 980,000 base (400,000), not the raw window (408,163).
const CC_OUTPUT_RESERVE_TOKENS = 20000;
// With CLAUDE_AUTOCOMPACT_PCT_OVERRIDE set and CLAUDE_CODE_AUTO_COMPACT_WINDOW UNSET, CC
// applies the pct to the model's own window. That window is the 1,000,000 csq measured the
// compaction above under, so (1,000,000 − 20,000) × 51.02040816326531% = 500,000 — the owner's 500k.
// The full precision matters: the floor of a truncated pct lands BELOW it — 51.0204 gives 499,999
// and 51.02 gives 499,996 (measured with node; train-8 R1 correctness F9).
const ASSUMED_MODEL_WINDOW_TOKENS = 1000000;
const BANDS = Object.freeze(["GREEN", "HANDOVER-DUE", "HANDOVER-OVERDUE", "BACKSTOP"]);
const RISE_STEP_TOKENS = 50000;
const STATE_FILE = "coc-context-state.json";
const STATE_SCHEMA_ID = "coc-context-state/v1";
const STATE_MAX_BYTES = 256 * 1024;
const TAIL_WINDOWS_BYTES = Object.freeze([256 * 1024, 2 * 1024 * 1024]);
const CSQ_POINTS_FILE = "csq-context-points.json";
// Suppression freshness is descriptor mtime, not computed_at (points-change time).
const CSQ_POINTS_MAX_AGE_MS = 120000;
const CSQ_SOURCES = Object.freeze(["cc_default", "pct_override", "autocompact_disabled", "window_unknown", "window_too_small", "input_unparseable"]);
const CSQ_HANDOVER_STATUSES = Object.freeze(["ok", "no_backstop", "headroom_invalid", "below_floor"]);
const CSQ_MODEL_MAX_CHARS = 128;
// Below this headroom the handover cannot finish before the backstop (CYCLE.md §1.3):
// a smaller or unparseable headroom is `headroom_invalid` — NO handover point.
const MIN_HEADROOM_TOKENS = 30000;
const CSQ_POINTS_MAX_BYTES = 64 * 1024;
const EMIT_SUBDIR = "context-meter"; // hook-private PostToolUse rise baselines

let _openGuards = null;
function openGuards() {
  if (_openGuards) return _openGuards;
  try {
    _openGuards = require("./transcript-read.js").transcriptOpenGuards();
  } catch {
    _openGuards = { nofollow: 0, nonblock: 0, active: false, simulated: false };
  }
  return _openGuards;
}

function isPosInt(n) {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && Math.floor(n) === n;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** The sum, or null when the record carries no usable usage block. */
function usageTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  if (typeof usage.input_tokens !== "number") return null;
  const total =
    num(usage.input_tokens) +
    num(usage.cache_read_input_tokens) +
    num(usage.cache_creation_input_tokens) +
    num(usage.output_tokens);
  return total > 0 ? total : null;
}

/**
 * Scan complete JSONL lines newest-first. Returns a reading or null (nothing usable
 * in these lines).
 */
function scanLines(lines) {
  let fromEof = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    fromEof++;
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue; // a torn / partially-written row — skip, never throw
    }
    if (!e || typeof e !== "object" || e.isSidechain === true) continue;
    if (e.type === "system" && e.subtype === "compact_boundary") {
      const post = e.compactMetadata && e.compactMetadata.postTokens;
      if (isPosInt(post)) {
        return { tokens: post, status: "compaction-estimate", reason: null, lines_from_eof: fromEof };
      }
      return {
        tokens: null,
        status: "unknown",
        reason: "compacted; no reading since the compaction",
        lines_from_eof: fromEof,
      };
    }
    if (e.type !== "assistant" || !e.message || typeof e.message !== "object") continue;
    if (e.isApiErrorMessage === true || e.message.model === "<synthetic>") continue;
    const t = usageTokens(e.message.usage);
    if (t === null) continue;
    return {
      tokens: t,
      status: "measured",
      reason: null,
      lines_from_eof: fromEof,
      model: typeof e.message.model === "string" ? e.message.model : null,
    };
  }
  return null;
}

/**
 * Read the current context size. NEVER throws; an unmeasurable reading is
 * `{tokens:null, status:"unknown", reason}`.
 */
function readContextReading(transcriptPath) {
  const unknown = (reason, extra) => ({ tokens: null, status: "unknown", reason, ...(extra || {}) });
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    return unknown(transcriptPath == null ? "no transcript_path in the payload" : "transcript_path unusable");
  }
  const g = openGuards();
  let fd;
  try {
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | g.nofollow | g.nonblock);
  } catch (e) {
    const code = (e && e.code) || "unknown";
    return unknown(code === "ELOOP" ? "transcript is a symlink (refused)" : `transcript could not be opened (${code})`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return unknown("transcript is not a regular file");
    if (st.size === 0) return unknown("transcript is empty");
    let lastWindow = 0;
    for (const win of TAIL_WINDOWS_BYTES) {
      const start = Math.max(0, st.size - win);
      const length = st.size - start;
      if (length <= lastWindow) break; // the previous window already covered the file
      lastWindow = length;
      const buf = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, start);
      const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
      if (start > 0) lines.shift(); // a mid-line fragment
      const r = scanLines(lines);
      if (r) return { ...r, tail_bytes: bytesRead };
      if (start === 0) break;
    }
    return unknown(`no usage-bearing main-thread assistant record in the last ${Math.round(lastWindow / 1024)}KB`, {
      tail_bytes: lastWindow,
    });
  } catch (e) {
    return unknown(`transcript read failed (${(e && e.code) || (e && e.message) || "unknown"})`);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/** "400000" or "400k" → 400000; anything else → null. */
function parseTokenCount(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+)([kK])?$/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return isPosInt(n) ? n : null;
}

function resolveEnvPoints(env) {
  const out = { warnings: [] };
  const pctRaw = env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  const pct = typeof pctRaw === "string" && /^\d+(\.\d+)?$/.test(pctRaw.trim()) ? Number(pctRaw) : null;
  out.pct = pct !== null && pct > 0 && pct <= 100 ? pct : null;
  const windowRaw = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const windowUnset = windowRaw === undefined || windowRaw === "";
  // UNSET + a valid pct ⇒ the model window CC itself uses; SET but unparseable stays null.
  const window = windowUnset ? (out.pct !== null ? ASSUMED_MODEL_WINDOW_TOKENS : null) : parseTokenCount(windowRaw);
  out.window = window;
  // Recorded, never silent (train-8 R1 correctness F11): the 1M window is an ASSUMPTION whenever
  // the pct is set and the window is not — on a smaller-window model that backstop is never reached.
  out.window_assumed = windowUnset && out.pct !== null;
  out.backstop =
    window !== null && out.pct !== null && window > CC_OUTPUT_RESERVE_TOKENS
      ? Math.floor(((window - CC_OUTPUT_RESERVE_TOKENS) * out.pct) / 100)
      : null;
  if (out.backstop === null) {
    out.backstop_reason =
      window === null && out.pct === null
        ? "CLAUDE_CODE_AUTO_COMPACT_WINDOW and CLAUDE_AUTOCOMPACT_PCT_OVERRIDE unset"
        : window === null
          ? "CLAUDE_CODE_AUTO_COMPACT_WINDOW unset or invalid"
          : "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE unset or invalid";
  }

  // Headroom: an explicit value below MIN_HEADROOM_TOKENS, or one that does not parse,
  // is `headroom_invalid` — NO handover point, never a silent default (csq contract).
  let headroom = DEFAULT_HEADROOM_TOKENS;
  let headroomInvalid = null;
  const hRaw = env.COC_HANDOVER_HEADROOM_TOKENS;
  if (hRaw !== undefined && hRaw !== "") {
    const h = parseTokenCount(hRaw);
    if (h === null) headroomInvalid = `COC_HANDOVER_HEADROOM_TOKENS=${JSON.stringify(String(hRaw).slice(0, 40))} is not a token count`;
    else if (h < MIN_HEADROOM_TOKENS) headroomInvalid = `COC_HANDOVER_HEADROOM_TOKENS=${h} is below the ${MIN_HEADROOM_TOKENS} minimum`;
    else headroom = h;
  }

  const raw = env.COC_HANDOVER_AT_TOKENS;
  let explicit = null;
  if (raw !== undefined && raw !== "") {
    explicit = parseTokenCount(raw);
    if (explicit === null) out.warnings.push(`COC_HANDOVER_AT_TOKENS=${JSON.stringify(String(raw).slice(0, 40))} is not a token count; ignored`);
  }

  const invalid = (why) => {
    out.warnings.push(`headroom_invalid — ${why}; NO handover point`);
    out.handover = null;
    out.handover_status = "headroom_invalid";
    out.handover_reason = why;
    out.headroom = null;
  };
  if (explicit !== null) {
    out.handover_source = "env";
    if (out.backstop !== null && out.backstop - explicit < MIN_HEADROOM_TOKENS) {
      invalid(`COC_HANDOVER_AT_TOKENS=${explicit} leaves ${out.backstop - explicit} below the backstop ${out.backstop} (minimum ${MIN_HEADROOM_TOKENS})`);
    } else {
      out.handover = explicit;
      out.handover_status = "ok";
      out.headroom = out.backstop !== null ? out.backstop - explicit : null;
    }
  } else if (headroomInvalid) {
    out.handover_source = out.backstop !== null ? "backstop-minus-headroom" : "default";
    invalid(headroomInvalid);
  } else if (out.backstop !== null) {
    out.handover_source = "backstop-minus-headroom";
    if (out.backstop - headroom <= 0) invalid(`headroom ${headroom} ≥ backstop ${out.backstop}`);
    else {
      out.handover = out.backstop - headroom;
      out.handover_status = "ok";
      out.headroom = headroom;
    }
  } else {
    out.handover_source = "default";
    out.handover = ASSUMED_BACKSTOP_TOKENS - headroom;
    out.handover_status = "ok";
    out.headroom = headroom;
  }
  return out;
}

/**
 * csq's per-terminal points file. Returns one of:
 *   absent · fresh present + points · stale + reason · corrupt + reason.
 * Descriptor mtime is bounded to [0,120s] age; computed_at is not a liveness stamp.
 * Values are DATA: nothing read here is ever used as a path. NEVER throws.
 */
function readCsqPoints(configDir, { nowMs = Date.now() } = {}) {
  if (typeof configDir !== "string" || !configDir) return { state: "absent", reason: "CLAUDE_CONFIG_DIR unset" };
  const p = path.join(configDir, CSQ_POINTS_FILE);
  const g = openGuards();
  let fd;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | g.nofollow | g.nonblock);
  } catch (e) {
    if (e && e.code === "ENOENT") return { state: "absent", path: p };
    return { state: "corrupt", path: p, reason: `could not be opened (${(e && e.code) || "error"})` };
  }
  let text;
  let mtimeMs;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { state: "corrupt", path: p, reason: "not a regular file" };
    if (st.size > CSQ_POINTS_MAX_BYTES) return { state: "corrupt", path: p, reason: `larger than ${CSQ_POINTS_MAX_BYTES} bytes` };
    mtimeMs = st.mtimeMs;
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    text = buf.subarray(0, n).toString("utf8");
  } catch (e) {
    return { state: "corrupt", path: p, reason: `read failed (${(e && e.code) || "error"})` };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return { state: "corrupt", path: p, reason: "not valid JSON" };
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) return { state: "corrupt", path: p, reason: "not a JSON object" };
  // csq writes an undeterminable value as null, with `source` / `handover_status`
  // naming why. null is a LEGITIMATE answer; a wrongly-typed value is corrupt.
  for (const key of ["handover_tokens", "backstop_tokens", "headroom_tokens", "window_tokens"]) {
    if (d[key] !== null && d[key] !== undefined && !isPosInt(d[key])) {
      return { state: "corrupt", path: p, reason: `${key} is neither null nor a positive integer` };
    }
  }
  if (d.source !== undefined && d.source !== null && !CSQ_SOURCES.includes(d.source)) {
    return { state: "corrupt", path: p, reason: "source is not a recognised value" };
  }
  if (d.handover_status !== undefined && d.handover_status !== null && !CSQ_HANDOVER_STATUSES.includes(d.handover_status)) {
    return { state: "corrupt", path: p, reason: "handover_status is not a recognised value" };
  }
  if (d.model !== undefined && d.model !== null && (typeof d.model !== "string" || d.model.length > CSQ_MODEL_MAX_CHARS)) {
    return { state: "corrupt", path: p, reason: `model is not a string of at most ${CSQ_MODEL_MAX_CHARS} chars` };
  }
  const handover = isPosInt(d.handover_tokens) ? d.handover_tokens : null;
  const status = typeof d.handover_status === "string" ? d.handover_status : handover !== null ? "ok" : null;
  if (handover !== null && status !== "ok") {
    return { state: "corrupt", path: p, reason: `handover_tokens set but handover_status is ${status}` };
  }
  if (handover === null && status === "ok") {
    return { state: "corrupt", path: p, reason: "handover_status ok but handover_tokens is null" };
  }
  const ageMs = nowMs - mtimeMs;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > CSQ_POINTS_MAX_AGE_MS) {
    return { state: "stale", path: p, mtime_ms: mtimeMs, age_ms: ageMs, reason: ageMs < 0 ? "mtime is in the future" : "mtime exceeds the 120s freshness limit" };
  }
  return {
    state: "present",
    path: p,
    mtime_ms: mtimeMs,
    age_ms: ageMs,
    points: {
      handover,
      handover_status: status,
      backstop: isPosInt(d.backstop_tokens) ? d.backstop_tokens : null,
      headroom: isPosInt(d.headroom_tokens) ? d.headroom_tokens : null,
      window: isPosInt(d.window_tokens) ? d.window_tokens : null,
      model: typeof d.model === "string" ? d.model : null,
      source: typeof d.source === "string" ? d.source : null,
      computed_at: typeof d.computed_at === "string" ? d.computed_at.slice(0, 64) : null,
    },
  };
}

/**
 * The effective points + who emits.
 *   csq file fresh PRESENT → csq's points are authoritative, including a null handover
 *                       (no_backstop / below_floor / headroom_invalid): CC autocompact is
 *                       then the only boundary. csq's hook is the primary emitter; this
 *                       meter injects nothing. NO env fallback.
 *   csq file ABSENT or STALE → env points; this meter is the emitter.
 *   csq file CORRUPT → reported loudly without env fallback; this meter emits the
 *                      reading with no handover point.
 * `source` uses the state-file vocabulary: csq | fallback-env | fallback-default.
 */
function resolvePoints(env, options) {
  const csq = readCsqPoints(env.CLAUDE_CONFIG_DIR, options);
  let p;
  if (csq.state === "present") {
    const c = csq.points;
    p = {
      primary: "csq",
      source: "csq",
      handover: c.handover,
      handover_status: c.handover_status,
      handover_source: "csq",
      backstop: c.backstop,
      window: c.window,
      headroom: c.handover !== null ? (c.headroom !== null ? c.headroom : c.backstop !== null ? c.backstop - c.handover : null) : null,
      csq,
      warnings: [],
    };
  } else if (csq.state === "corrupt") {
    p = {
      primary: "loom",
      source: "csq",
      handover: null,
      handover_status: "points_corrupt",
      handover_source: "csq",
      backstop: null,
      window: null,
      headroom: null,
      csq,
      warnings: [`csq points file ${csq.path} is CORRUPT (${csq.reason}); NO handover point (only an absent file falls back to env)`],
    };
  } else {
    const e = resolveEnvPoints(env);
    p = {
      primary: "loom",
      source: e.handover_source === "default" && e.backstop === null ? "fallback-default" : "fallback-env",
      handover: e.handover,
      handover_status: e.handover_status,
      handover_reason: e.handover_reason || null,
      handover_source: e.handover_source,
      backstop: e.backstop,
      backstop_reason: e.backstop_reason || null,
      window: e.window,
      window_assumed: e.window_assumed === true,
      pct: e.pct,
      headroom: e.headroom,
      csq,
      warnings: e.warnings,
    };
  }
  // The OVERDUE (seed-only) point: backstop − 30k (CYCLE.md §1.1); with no known backstop,
  // handover + 30k. With NO handover point there is no handover-family band at all.
  p.overdue =
    p.handover === null
      ? null
      : p.backstop !== null && p.backstop !== undefined
        ? Math.max(p.handover, p.backstop - OVERDUE_BEFORE_BACKSTOP_TOKENS)
        : p.handover + OVERDUE_BEFORE_BACKSTOP_TOKENS;
  return p;
}

/** GREEN | HANDOVER-DUE | HANDOVER-OVERDUE | BACKSTOP, or null when unmeasurable. */
function bandOf(tokens, points) {
  if (tokens === null || tokens === undefined) return null;
  if (points.backstop !== null && points.backstop !== undefined && tokens >= points.backstop) return "BACKSTOP";
  if (points.handover === null) return "GREEN"; // no handover point: never a handover band
  if (tokens >= points.overdue) return "HANDOVER-OVERDUE";
  if (tokens >= points.handover) return "HANDOVER-DUE";
  return "GREEN";
}

/**
 * The start-above-handover guard. A session whose FIRST measured reading is already at or
 * over the handover point would hand over, /clear, restart above the point and hand over
 * again — a loop — so its handover lines are SUPPRESSED. A later reading below the point
 * (a compaction) re-arms it: a crossing after that is a genuine one. Pure.
 * @returns {{first_measured_tokens:number|null, suppressed:boolean}}
 */
function suppressionOf(prev, reading, points) {
  const first = prev && isPosInt(prev.first_measured_tokens) ? prev.first_measured_tokens : null;
  let suppressed = !!(prev && prev.suppressed === true);
  if (reading.tokens === null) return { first_measured_tokens: first, suppressed };
  if (first === null) {
    return { first_measured_tokens: reading.tokens, suppressed: points.handover !== null && reading.tokens >= points.handover };
  }
  if (suppressed && points.handover !== null && reading.tokens < points.handover) suppressed = false;
  return { first_measured_tokens: first, suppressed };
}

function k(n) {
  return `${Math.round(n / 1000)}k`;
}

/** The ONE line this meter emits. Token-cheap by construction. */
function renderLine(reading, points, suppressed = false, nowMs = null, handover = null, binding = null) {
  // F2: every line that tells the agent to write the seed carries the tool's clock in the
  // header's own format, so `written=` is COPIED, never typed from memory or looked up.
  const clock = Number.isFinite(nowMs) ? ` · seed written=${require("./handover-seed.js").clockIso(nowMs)}` : "";
  const backstop = points.backstop !== null && points.backstop !== undefined ? ` · backstop ${k(points.backstop)}` : "";
  const est = reading.status === "compaction-estimate" ? "~" : "";
  if (points.handover === null) {
    const why = ` · no handover point (${points.handover_status || "unknown"})`;
    if (reading.tokens === null) return `[CTX] UNKNOWN — ${reading.reason}${why}${backstop}`;
    return `[CTX] ${est}${k(reading.tokens)}${why}${backstop}`;
  }
  if (reading.tokens === null) {
    return `[CTX] UNKNOWN/${k(points.handover)} handover — ${reading.reason}${backstop}`;
  }
  const t = `${est}${k(reading.tokens)}`;
  const band = bandOf(reading.tokens, points);
  const seedLag = reading.tokens - handover?.at_tokens;
  const session = activitySessionId(binding?.session_id);
  const written = Date.parse(handover?.written_at || "");
  const seedAge = nowMs - written;
  const transcript = binding?.transcript;
  const transcriptBound = transcript?.ok === true && transcript.path === handover?.transcript_path &&
    transcript.ino === handover.transcript_ino && transcript.dev === handover.transcript_dev &&
    Number.isSafeInteger(handover.seed_offset) && handover.seed_offset >= 0 && transcript.size >= handover.seed_offset;
  if (["writing", "written"].includes(handover?.state) && session !== null &&
      activitySessionId(handover.session_id) === session && Number.isFinite(nowMs) && Number.isFinite(written) &&
      seedAge >= 0 && seedAge <= require("./boundary-seed.js").SEED_MAX_AGE_MS && transcriptBound &&
      handover.emergency !== true && Number.isInteger(handover.at_tokens) &&
      handover.at_tokens > 0 && seedLag >= 0 && seedLag <= require("./context-state.js").FRESH_SEED_MAX_TOKEN_LAG) {
    return `[CTX] ${band} ${t}/${k(points.handover)} handover — seed current; keep working the queue${backstop}`;
  }
  if (suppressed && band !== "GREEN") {
    return `[CTX] ${t}/${k(points.handover)} handover · handover SUPPRESSED (session started above the handover point)${backstop}`;
  }
  switch (band) {
    case "BACKSTOP":
      return `[CTX] BACKSTOP ${t} ≥ ${k(points.backstop)} — CC compaction is imminent: write a current SEED, then keep working the queue${clock}`;
    case "HANDOVER-OVERDUE":
      return `[CTX] HANDOVER-OVERDUE ${t} ≥ ${k(points.overdue)} — write a current SEED, then keep working the queue${backstop}${clock}`;
    case "HANDOVER-DUE":
      return (
        `[CTX] HANDOVER-DUE ${t} ≥ ${k(points.handover)} handover — start the handover now: ` +
        `write the SEED first, then the depth delta and the render; then KEEP WORKING the queue — a checkpoint, never a stop${backstop}${clock}`
      );
    default: {
      const pct = Math.floor((reading.tokens * 100) / points.handover);
      const tag = reading.status === "compaction-estimate" ? ", post-compaction estimate" : "";
      return `[CTX] ${t}/${k(points.handover)} handover (${pct}%${tag})${backstop}`;
    }
  }
}

/**
 * The emission decision. Pure.
 * @param {{event:string, reading:object, points:object, prev:object|null, suppressed:boolean}} a
 * @returns {{emit:boolean, line:string|null, band:string|null, next:{last_emitted_tokens:number|null}, why:string}}
 */
function decide({ event, reading, points, prev, suppressed = false, nowMs = null, handover = null, binding = null }) {
  const last = prev && isPosInt(prev.last_emitted_tokens) ? prev.last_emitted_tokens : null;
  const band = bandOf(reading.tokens, points);
  const line = renderLine(reading, points, suppressed, nowMs, handover, binding);
  const keep = { last_emitted_tokens: last };
  const r = (emit, next, why) => ({ emit, line: emit ? line : null, band, next, why });
  if (points.primary === "csq") return r(false, keep, "csq-primary");
  if (event === "UserPromptSubmit") {
    return r(true, { last_emitted_tokens: reading.tokens === null ? last : reading.tokens }, "turn");
  }
  // a tool event (PostToolUse)
  if (reading.tokens === null) return r(false, keep, "unknown-silent");
  // The firm every-call line fires ONLY on a real handover point that is not suppressed.
  if (band !== "GREEN" && points.handover !== null && !suppressed) {
    return r(true, { last_emitted_tokens: reading.tokens }, "at-or-over-handover");
  }
  if (last === null) return r(true, { last_emitted_tokens: reading.tokens }, "first-reading");
  if (reading.tokens < last) return r(false, { last_emitted_tokens: reading.tokens }, "rebase-down");
  if (reading.tokens - last >= RISE_STEP_TOKENS) return r(true, { last_emitted_tokens: reading.tokens }, "rise");
  return r(false, keep, "below-step");
}

// ── on-disk state ─────────────────────────────────────────────────────────────

/** INJECTIVE session_id → file stem (sanitized token + 8-hex sha256 of the raw id). */
function sessionKey(sessionId) {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const suffix = crypto.createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 8);
  return `${safe}-${suffix}`;
}

function resolveWithMissingTail(p) {
  // Climbs ONLY past a genuinely absent component; NULL when one exists but will not resolve
  // (a dangling link, EACCES, ELOOP) or nothing does. It used to climb past any error and
  // return the raw path at the root (train-8 R2 correctness ledger: the corr F1 class). Every caller compares the result
  // for EQUALITY with an expected canonical path, so null never matches: a refusal.
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch (e) {
      if (!e || e.code !== "ENOENT") return null;
      try {
        fs.lstatSync(cur);
        return null; // exists but will not resolve
      } catch (le) {
        if (!le || le.code !== "ENOENT") return null; // not provably absent: refuse
        /* genuinely absent: climb */
      }
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * `<main-checkout>/.claude/learning/<subdir>`, contained: the candidate and the
 * boundary (the CANONICAL main checkout's learning tree) are resolved through the
 * same resolver, and a symlinked dir is refused (security.md § Path Containment;
 * same shape as compaction-handoff.js::resolveHandoffDir).
 */
function resolveLearningDir(repoDir, subdir) {
  let root = null;
  try {
    const r = require("./state-resolver.js").requireMainCheckout(repoDir);
    if (r && r.ok && r.repoDir) root = r.repoDir;
  } catch {
    /* fall through */
  }
  if (!root) return { ok: false, reason: "main checkout could not be resolved" };
  let real;
  try {
    real = fs.realpathSync(root);
  } catch {
    return { ok: false, reason: "main checkout could not be canonicalized" };
  }
  const dir = path.join(root, ".claude", "learning", subdir);
  const expected = path.join(real, ".claude", "learning", subdir);
  if (resolveWithMissingTail(dir) !== expected) {
    return { ok: false, reason: `${subdir} dir resolves outside the main checkout's learning tree — refusing` };
  }
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return { ok: false, reason: `${subdir} dir is a symlink — refusing` };
  } catch {
    /* absent: created on write */
  }
  return { ok: true, dir };
}

/** Hook-private PostToolUse rise baseline, per session. */
function emitStatePath(dir, sessionId) {
  return path.join(dir, `${sessionKey(sessionId)}.emit.json`);
}

// Shells a hook command may run under WITHOUT exec-ing node (MEASURED 2026-10-10 on this
// host: under `zsh -c 'node …'`, and under `sh -c`/`bash -c` for any compound command,
// node's parent is the per-invocation shell — a NEW pid on every call; under `sh -c` with
// a simple command the shell exec'd and the parent was the spawner). The terminal's
// stable identity is therefore the first NON-shell ancestor.
const TRANSIENT_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "mksh", "fish", "tcsh", "csh"]);
const TERMINAL_KEY_MAX_HOPS = 4;
const _terminalKeyCache = new Map();

/** `ps` view of one pid: {ppid, lstart, comm} or null. */
function psInfo(pid) {
  try {
    const bin = require("./session-load-backstop.js").resolvePsBinary();
    if (!bin) return null;
    const out = require("child_process").execFileSync(bin, ["-o", "ppid=", "-o", "lstart=", "-o", "comm=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = String(out).trim().match(/^(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/);
    if (!m) return null;
    return { ppid: Number(m[1]), lstart: m[2], comm: m[3].trim() };
  } catch {
    return null;
  }
}

/**
 * The fallback state file's key: the first NON-shell ancestor of `pid` (normally the
 * Claude Code process), qualified by a hash of that process's START TIME so a recycled
 * pid can never read another terminal's record. {ok, key, pid} | {ok:false, reason}.
 * Fails CLOSED (no key ⇒ no fallback record) where the ancestry cannot be measured.
 */
function stableTerminalKey(pid) {
  if (!(Number.isInteger(pid) && pid > 1)) return { ok: false, reason: `parent pid ${JSON.stringify(pid)} is unusable` };
  if (_terminalKeyCache.has(pid)) return _terminalKeyCache.get(pid);
  let r = { ok: false, reason: process.platform === "win32" ? "terminal identity is unmeasurable on win32 (no ps); set CLAUDE_CONFIG_DIR" : `ps could not describe pid ${pid}` };
  if (process.platform !== "win32") {
    let cur = pid;
    for (let hop = 0; hop <= TERMINAL_KEY_MAX_HOPS; hop++) {
      const info = psInfo(cur);
      if (!info) {
        r = { ok: false, reason: `ps could not describe pid ${cur}` };
        break;
      }
      const name = path.basename(info.comm).replace(/^-/, "");
      if (TRANSIENT_SHELLS.has(name) && info.ppid > 1 && hop < TERMINAL_KEY_MAX_HOPS) {
        cur = info.ppid;
        continue;
      }
      const h = crypto.createHash("sha256").update(`${cur}\n${info.lstart}`, "utf8").digest("hex").slice(0, 8);
      r = { ok: true, key: `${cur}-${h}`, pid: cur };
      break;
    }
  }
  _terminalKeyCache.set(pid, r);
  return r;
}

/**
 * Where the context STATE file lives (CYCLE.md §4.1):
 *   `$CLAUDE_CONFIG_DIR/coc-context-state.json` when CLAUDE_CONFIG_DIR is set — and it
 *   MUST then name an existing directory: a set-but-missing (or non-directory) value is
 *   REFUSED with code `config-dir-not-a-directory`, never answered with a guessed path
 *   (the earlier fallback wrote a DIFFERENT terminal-keyed file than the one csq reads);
 *   else, with CLAUDE_CONFIG_DIR unset, `<main-checkout>/.claude/learning/context-state/
 *   <terminal-key>.json`, where the key is stableTerminalKey(`pid`) — `pid` is the hook
 *   process's PARENT pid, which under a non-exec'ing shell changes per invocation.
 * `terminalKey` (tests only) supplies the key instead of measuring it.
 */
function resolveContextStatePath({ configDir, repoDir, pid, terminalKey }) {
  if (configDir !== undefined && configDir !== null && configDir !== "") {
    if (typeof configDir !== "string") return { ok: false, code: "config-dir-not-a-directory", reason: "CLAUDE_CONFIG_DIR is not a string" };
    let st;
    try {
      st = fs.statSync(configDir);
    } catch (e) {
      return { ok: false, code: "config-dir-not-a-directory", reason: `CLAUDE_CONFIG_DIR=${JSON.stringify(configDir.slice(0, 200))} does not exist (${(e && e.code) || "stat failed"}) — refusing to guess a state path` };
    }
    if (!st.isDirectory()) return { ok: false, code: "config-dir-not-a-directory", reason: `CLAUDE_CONFIG_DIR=${JSON.stringify(configDir.slice(0, 200))} is not a directory — refusing to guess a state path` };
    return { ok: true, dir: configDir, file: path.join(configDir, STATE_FILE), location: "config-dir" };
  }
  const d = resolveLearningDir(repoDir, "context-state");
  if (!d.ok) return d;
  const k = typeof terminalKey === "string" && /^[A-Za-z0-9-]{1,40}$/.test(terminalKey) ? { ok: true, key: terminalKey } : stableTerminalKey(pid);
  if (!k.ok) return { ok: false, code: "terminal-key-unmeasurable", reason: `no stable terminal key for the fallback state path (${k.reason})` };
  return { ok: true, dir: d.dir, file: path.join(d.dir, `${k.key}.json`), location: "fallback", ensureIgnore: true, terminal_key: k.key };
}

// ── the ACTIVITY marker (lock-free; the boundary's freshness witness) ────────
//
// The activity events that REPLACE this small file with a FRESH 128-bit nonce — the
// complete producer set (`git grep -n "markActivity(" -- .claude/hooks` lists exactly
// these call sites; there is NO PreToolUse producer, the transcript witnesses a tool call
// instead — lib/context-state.js::transcriptQuiescent):
//   UserPromptSubmit + PostToolUse   hooks/context-meter.js::run (the FIRST
//                                     UserPromptSubmit row of hooks/dispatch-registry.json)
//   SessionStart, EVERY source        hooks/compaction-handoff-inject.js::onPayload
//                                     (startup | resume | clear | compact | absent)
//   PreCompact                        hooks/compaction-handoff-snapshot.js
//   Stop, EVERY one, at its start     hooks/context-boundary.js::run (the candidate binds
//                                     to the nonce it WROTE)
//   Stop-void (no session)            hooks/context-boundary.js::voidEarlierReadiness (its
//                                     outer timeout, a failed stdin read, no payload)
// tmp `wx` + rename, no lock, so lock contention can never stop it. The marker also
// records the SESSION it was written for (`session_id`): a Stop binds readiness to the
// nonce it saw at its START (boundary.activity_nonce) AND to its own session_id
// (boundary.session_id); readiness is valid ONLY while the file still holds that nonce
// AND names that session (lib/context-state.js::boundaryReadyValid — the predicate csq
// applies). If the replace fails, the file is UNLINKED so the recorded nonce can no longer
// match (fail closed).
const ACTIVITY_SCHEMA_ID = "coc-context-activity/v1";
const ACTIVITY_MAX_BYTES = 1024;
const ACTIVITY_NONCE_RE = /^[0-9a-f]{32}$/;
// A session id is recorded only in this shape (Claude Code writes a UUID); anything else is
// recorded as null, which no boundary can match (fail closed).
const ACTIVITY_SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** `<state file minus .json>.activity.json`, beside the state file. */
function activityPathFor(loc) {
  return `${String(loc.file).replace(/\.json$/, "")}.activity.json`;
}

/** A payload session id in the recorded shape, or null. */
function activitySessionId(v) {
  return typeof v === "string" && ACTIVITY_SESSION_RE.test(v) ? v : null;
}

/**
 * Replace the activity marker with a fresh nonce, recording `sessionId` (the payload's
 * session_id; null when absent/malformed — such a marker validates no boundary).
 * {ok, nonce, session_id, path} | {ok:false, reason, unlinked}. Never throws.
 */
function markActivity(loc, event, nowIso, { sessionId = null } = {}) {
  if (!loc || !loc.ok) return { ok: false, reason: (loc && loc.reason) || "no state location", unlinked: false };
  const p = activityPathFor(loc);
  const nonce = crypto.randomBytes(16).toString("hex");
  const sid = activitySessionId(sessionId);
  const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    if (loc.ensureIgnore) fs.mkdirSync(loc.dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ schema: ACTIVITY_SCHEMA_ID, nonce, session_id: sid, event: typeof event === "string" ? event.slice(0, 40) : null, at: nowIso || new Date().toISOString() }) + "\n", { flag: "wx" });
    fs.renameSync(tmp, p);
    return { ok: true, nonce, session_id: sid, path: p };
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created */
    }
    let unlinked = false;
    try {
      fs.unlinkSync(p);
      unlinked = true;
    } catch (u) {
      unlinked = !!(u && u.code === "ENOENT");
    }
    return { ok: false, reason: (e && e.code) || (e && e.message) || "activity write failed", unlinked };
  }
}

/** {state:"absent"|"ok"|"corrupt", nonce?, at?, event?, reason?}. Never throws. */
function readActivity(loc) {
  if (!loc || !loc.ok) return { state: "absent", reason: "no state location" };
  const p = activityPathFor(loc);
  const g = openGuards();
  let fd;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | g.nofollow | g.nonblock);
  } catch (e) {
    if (e && e.code === "ENOENT") return { state: "absent" };
    return { state: "corrupt", reason: `could not be opened (${(e && e.code) || "error"})` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { state: "corrupt", reason: "not a regular file" };
    if (st.size > ACTIVITY_MAX_BYTES) return { state: "corrupt", reason: "oversized" };
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    const d = JSON.parse(buf.subarray(0, n).toString("utf8"));
    if (!d || d.schema !== ACTIVITY_SCHEMA_ID || typeof d.nonce !== "string" || !ACTIVITY_NONCE_RE.test(d.nonce)) return { state: "corrupt", reason: "not a coc-context-activity/v1 record" };
    return { state: "ok", nonce: d.nonce, session_id: activitySessionId(d.session_id), at: typeof d.at === "string" ? d.at : null, event: typeof d.event === "string" ? d.event : null };
  } catch (e) {
    return { state: "corrupt", reason: `unreadable (${(e && e.code) || (e && e.message) || "error"})` };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* closed */
    }
  }
}

/** Bounded read of the hook-private emit record; any failure ⇒ null (emits again). */
function readEmitState(p) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.size > 4096) return null;
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
}

function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no Atomics: spin-free fallback is simply no wait */
  }
}

/** Atomic write (tmp `wx` + rename); optional `.gitignore` (`*`). Returns {ok, reason}. Never throws. */
function writeJsonAtomic(dir, target, obj, { ensureIgnore = true } = {}) {
  let fd;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const realDir = fs.realpathSync(dir);
    if (fs.realpathSync(path.dirname(target)) !== realDir) return { ok: false, reason: "target parent is outside state directory" };
    target = path.join(realDir, path.basename(target));
    if (ensureIgnore) {
      const ignore = path.join(dir, ".gitignore");
      try {
        fs.lstatSync(ignore);
      } catch {
        try {
          fs.writeFileSync(ignore, "*\n", { flag: "wx" });
        } catch {
          /* EEXIST race or unwritable: the parent learning/ tree is gitignored anyway */
        }
      }
    }
    try {
      if (fs.lstatSync(target).isSymbolicLink()) return { ok: false, reason: "target is a symlink — refusing" };
    } catch {
      /* absent */
    }
    const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const guards = openGuards();
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | guards.nofollow | guards.nonblock, 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(obj, null, 2) + "\n");
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e && e.code) || (e && e.message) || "write failed" };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

const LOCK_STALE_MS = 5000;
const LOCK_TRIES = 50;
const LOCK_WAIT_MS = 10;
const LOCK_CONTENT_MAX_BYTES = 512;

/** CLOCK_MONOTONIC in ms — system-wide on Linux/macOS, so comparable across processes. */
function monoNowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

/** {nonce, mono, ino, dev, mtimeMs} of a lock file, read without following a link; null on failure. */
function readLockIdentity(p) {
  const g = openGuards();
  let fd;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | g.nofollow | g.nonblock);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, LOCK_CONTENT_MAX_BYTES);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, 0);
    let d = null;
    try {
      d = JSON.parse(buf.subarray(0, n).toString("utf8"));
    } catch {
      d = null;
    }
    return {
      nonce: d && typeof d.nonce === "string" ? d.nonce : null,
      mono: d && Number.isFinite(d.mono) ? d.mono : null,
      ino: st.ino,
      dev: st.dev,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* closed */
    }
  }
}

/**
 * OWNERSHIP is the OWNER NONCE the holder wrote into the lock. An inode number alone is
 * not identity: a filesystem may hand a freed inode straight back. MEASURED: an inode-only
 * check let the holder unlink a lock re-created by another writer right after an unlink
 * (fixture case "M5 · RED", on a fleet host); the nonce check passes it. A lock with no
 * readable nonce (its writer died between create and write) is identified by inode + dev +
 * mtime instead.
 */
function sameLock(id, mine) {
  if (!id || !mine) return false;
  if (mine.nonce) return id.nonce === mine.nonce;
  return id.nonce === null && id.ino === mine.ino && id.dev === mine.dev && id.mtimeMs === mine.mtimeMs;
}

/**
 * Remove `lock` ONLY if it is still the lock `mine` identifies. rename-and-verify: the
 * lock is atomically renamed to a private name, then the renamed file's identity is
 * compared; a lock that turns out to be SOMEONE ELSE's is linked back (exclusive — never
 * over a newer lock). RESIDUAL, stated: if a third writer created a new lock in the
 * microseconds between the rename and the link-back, the displaced owner's lock is lost
 * (a double fault).
 */
function removeLockIfMine(lock, mine) {
  const priv = `${lock}.rm-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(lock, priv);
  } catch {
    return false; // gone already
  }
  const same = sameLock(readLockIdentity(priv), mine);
  if (!same) {
    try {
      fs.linkSync(priv, lock);
    } catch {
      /* a newer lock exists (EEXIST) — see RESIDUAL */
    }
  }
  try {
    fs.unlinkSync(priv);
  } catch {
    /* already gone */
  }
  return same;
}

/** The identity of `lock` if it is a crashed writer's (stale on its MONOTONIC stamp), else null. */
function lockIsStale(lock) {
  const id = readLockIdentity(lock);
  if (!id) return null;
  const now = monoNowMs();
  // A stamp AHEAD of now is a previous boot's: stale. No stamp (the owner crashed between
  // create and write) falls back to the file's age.
  const stale = id.mono !== null ? now - id.mono > LOCK_STALE_MS || id.mono > now + 1000 : Date.now() - id.mtimeMs > LOCK_STALE_MS;
  return stale ? id : null;
}

/**
 * Exclusive section over `<file>.lock` (O_CREAT|O_EXCL). EVERY writer of the state
 * file — this meter and the later handover/boundary/resume shards — MUST take it,
 * because the write is read-modify-write and a lost update would clobber another
 * writer's fields. OWNERSHIP IS AN OWNER NONCE written into the lock: the holder releases
 * ONLY a lock carrying its own nonce (removeLockIfMine), so it can never unlink a lock that a
 * stale-break handed to someone else. A lock is stale when its owner's MONOTONIC stamp
 * is older than LOCK_STALE_MS (a wall-clock step cannot make a live lock look stale);
 * the break is the same rename-and-verify, so a fresh lock that replaced the stale one
 * between the check and the break is restored, never removed.
 * Returns fn()'s value, or {ok:false, reason} when the lock was not won.
 */
function withStateLock(file, fn) {
  const lock = `${file}.lock`;
  for (let i = 0; i < LOCK_TRIES; i++) {
    let fd = null;
    try {
      fd = fs.openSync(lock, "wx");
    } catch (e) {
      if (!e || e.code !== "EEXIST") return { ok: false, reason: `lock failed (${(e && e.code) || "error"})` };
      const stale = lockIsStale(lock);
      if (stale) removeLockIfMine(lock, stale);
      sleepMs(LOCK_WAIT_MS);
      continue;
    }
    let mine = null;
    try {
      mine = { nonce: crypto.randomBytes(16).toString("hex") };
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, nonce: mine.nonce, mono: monoNowMs(), at: new Date().toISOString() }) + "\n");
      fs.closeSync(fd);
      fd = null;
      return fn();
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* closed */
        }
      }
      if (mine) removeLockIfMine(lock, mine);
    }
  }
  return { ok: false, reason: "state file lock not acquired" };
}

/** Bounded read of the existing state file. {state:"absent"|"ok"|"corrupt", data?, reason?} */
function readContextState(file) {
  let fd;
  try {
    const guards = openGuards();
    if (!guards.nofollow || !guards.nonblock) return { state: "corrupt", reason: "guarded state reads unavailable" };
    const parent = fs.realpathSync(path.dirname(file));
    const candidate = path.join(parent, path.basename(file));
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | guards.nofollow | guards.nonblock);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { state: "corrupt", reason: "not a regular file" };
    if (st.size > STATE_MAX_BYTES) return { state: "corrupt", reason: `larger than ${STATE_MAX_BYTES} bytes` };
    const real = fs.realpathSync(candidate);
    if (path.dirname(real) !== parent || real !== candidate) return { state: "corrupt", reason: "state path escaped canonical parent" };
    const named = fs.statSync(real);
    if (named.ino !== st.ino || named.dev !== st.dev) return { state: "corrupt", reason: "state identity changed during open" };
    const buf = Buffer.alloc(STATE_MAX_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const n = fs.readSync(fd, buf, total, buf.length - total, total);
      if (!n) break;
      total += n;
    }
    if (total > STATE_MAX_BYTES) return { state: "corrupt", reason: `larger than ${STATE_MAX_BYTES} bytes` };
    const after = fs.fstatSync(fd);
    if (after.size !== total || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) return { state: "corrupt", reason: "state changed during read" };
    const d = JSON.parse(buf.subarray(0, total).toString("utf8"));
    if (!d || typeof d !== "object" || Array.isArray(d)) return { state: "corrupt", reason: "not a JSON object" };
    return { state: "ok", data: d };
  } catch (e) {
    if (fd === undefined && e && e.code === "ENOENT") return { state: "absent" };
    return { state: "corrupt", reason: `state read failed (${(e && e.code) || (e && e.message) || "error"})` };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * The meter's OWN fields of the `coc-context-state/v1` record (CYCLE.md §4.3).
 * Only these keys are written; every other key already in the file is preserved.
 */
function meterFields({ sessionId, cwd, reading, points, band, suppressed, nowIso, sessionStart }) {
  return {
    // The start-above-handover guard's verdict (suppressionOf): non-null ⇒ this session's
    // handover lines are suppressed, so a reader must not act on a handover band either.
    handover_suppressed: suppressed ? "start-above-handover" : null,
    schema: STATE_SCHEMA_ID,
    updated_at: nowIso,
    session_id: sessionId,
    cwd,
    tokens: {
      used: reading.tokens,
      measured_at: nowIso,
      source:
        reading.status === "measured" ? "transcript-usage" : reading.status === "compaction-estimate" ? "compaction-estimate" : "unknown",
      reason: reading.reason || null,
      // This session's FIRST measured reading (suppressionOf) — the boundary predicate's
      // sanity floor for the handover point (lib/context-state.js::computeReady).
      session_start: isPosInt(sessionStart) ? sessionStart : null,
    },
    points: {
      handover_tokens: points.handover,
      overdue_tokens: points.overdue,
      backstop_tokens: points.backstop === undefined ? null : points.backstop,
      window_tokens: points.window === undefined ? null : points.window,
      // true ⇒ window_tokens is ASSUMED_MODEL_WINDOW_TOKENS, not a value anyone set or measured.
      window_assumed: points.window_assumed === true,
      headroom_tokens: points.headroom === undefined ? null : points.headroom,
      handover_status: points.handover_status || null,
      handover_reason: points.handover_reason || null,
      source: points.source,
      // why the source is what it is: csq's file state (absent|present|corrupt) and, when
      // corrupt, the reason — so a missing handover point is never silent in the record.
      csq_points: points.csq ? points.csq.state : "absent",
      csq_reason: points.csq && ["corrupt", "stale"].includes(points.csq.state) && points.csq.reason ? points.csq.reason : null,
    },
    band,
  };
}

/**
 * Read-modify-write of the state file under the lock: preserve every field the
 * meter does not own, overwrite the meter's own, `seq` = previous + 1.
 * Returns {ok, seq?, reason?, corrupt_replaced?}. Never throws.
 */
function writeContextState(loc, fields) {
  try {
    if (loc.ensureIgnore) fs.mkdirSync(loc.dir, { recursive: true });
    return withStateLock(loc.file, () => {
      const prev = readContextState(loc.file);
      const base = prev.state === "ok" ? prev.data : {};
      const prevSeq = prev.state === "ok" && Number.isInteger(base.seq) && base.seq >= 0 ? base.seq : 0;
      const next = { ...base, ...fields, seq: prevSeq + 1 };
      const w = writeJsonAtomic(loc.dir, loc.file, next, { ensureIgnore: !!loc.ensureIgnore });
      if (!w.ok) return w;
      return { ok: true, seq: next.seq, corrupt_replaced: prev.state === "corrupt" ? prev.reason : null };
    });
  } catch (e) {
    return { ok: false, reason: (e && e.message) || "write failed" };
  }
}

module.exports = {
  DEFAULT_HANDOVER_AT_TOKENS,
  DEFAULT_HEADROOM_TOKENS,
  ASSUMED_BACKSTOP_TOKENS,
  OVERDUE_BEFORE_BACKSTOP_TOKENS,
  BANDS,
  RISE_STEP_TOKENS,
  TAIL_WINDOWS_BYTES,
  CSQ_POINTS_FILE,
  CSQ_SOURCES,
  CSQ_HANDOVER_STATUSES,
  MIN_HEADROOM_TOKENS,
  STATE_FILE,
  EMIT_SUBDIR,
  CC_OUTPUT_RESERVE_TOKENS,
  ASSUMED_MODEL_WINDOW_TOKENS,
  STATE_SCHEMA_ID,
  usageTokens,
  readContextReading,
  parseTokenCount,
  resolveEnvPoints,
  readCsqPoints,
  resolvePoints,
  bandOf,
  suppressionOf,
  renderLine,
  decide,
  sessionKey,
  resolveLearningDir,
  emitStatePath,
  resolveContextStatePath,
  readEmitState,
  writeJsonAtomic,
  withStateLock,
  stableTerminalKey,
  activityPathFor,
  markActivity,
  readActivity,
  activitySessionId,
  ACTIVITY_SCHEMA_ID,
  LOCK_STALE_MS,
  readContextState,
  meterFields,
  writeContextState,
};
