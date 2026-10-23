/**
 * session-once — "say it once per session, again only when it changes".
 *
 * Owner directive 2026-10-10 (journal/0661, hook output economy): per-turn hook text that does
 * not change within a session is pure context cost. MEASURED over the loom transcripts: the
 * UserPromptSubmit `[ENV] …` reminder fired 5,557 times for 2.79 MB with one distinct content per
 * session, and the dispatcher's "registry changed on disk" NOTICE fired 771 times for 291 KB
 * with ONE distinct content.
 *
 * State: `<repo>/.claude/learning/hook-findings/<session>.once.jsonl`, one `{ch, sig}` row per
 * EMISSION (never per suppression), written and read through `append-sink.js` (the containment
 * every learning sink uses), under the same directory as `hook-findings.js` but a different file,
 * so the two writers never share a sink.
 *
 * FAIL-OPEN, in one direction only: a session that cannot be resolved, a state file that cannot
 * be read, or a write that fails all answer "not seen" — so the text is EMITTED, exactly as before
 * this module existed. Nothing here can turn a read failure into silence.
 *
 * ACCEPTED RESIDUAL (same class as `hook-output-discipline.md` § Accepted Residual): the state is
 * UNAUTHENTICATED. Anyone who can write the repo can pre-plant a row and silence a channel for a
 * session. The channels this module serves are informational (env summary, a registry-pinned
 * notice) — none is a block, a deny, a refusal or a security finding, and none may be routed here.
 */

"use strict";

const path = require("path");
const crypto = require("crypto");

const DIR_REL = path.join(".claude", "learning", "hook-findings");
const MAX_STATE_BYTES = 256 * 1024;

function _nonEmpty(s) {
  return typeof s === "string" && s.length > 0;
}

// The repo root (`stop-refusal.js::_repoRootOf`), or NULL when the cwd IS the home directory —
// home is never a repo root, so a null root reads and writes NOTHING here: `statePath` is null,
// `shouldEmit` answers emit with reason "no-repo-root", `recordEmission` returns false and
// `withCompactionCursor` throws its typed unavailable error. If stop-refusal.js cannot load, the
// fallback keeps the dir — except at home, where it is null for the same reason.
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
    const fs = require("fs");
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

function _safeSid(sid) {
  return String(sid).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
}

/** The state path, or null when there is no usable session id or no repo root (⇒ caller emits). */
function statePath(repoDir, sessionId) {
  if (!_nonEmpty(sessionId) || sessionId.length > 512) return null;
  const root = _repoRootOf(repoDir);
  if (root === null) return null;
  return path.join(root, DIR_REL, `${_safeSid(sessionId)}.once.jsonl`);
}

function signatureOf(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 32);
}

/** Rows for `channel`, or null when the state could not be read (absent ⇒ []). */
function _rows(repoDir, sessionId, channel) {
  const p = statePath(repoDir, sessionId);
  if (!p) return null;
  try {
    const { readSinkFile, mainCheckoutBoundaryRoots } = require("./append-sink.js");
    const root = _repoRootOf(repoDir);
    if (root === null) return null;
    const r = readSinkFile({
      repoDir: root,
      additionalRoots: mainCheckoutBoundaryRoots(root),
      sinkPath: p,
      maxBytes: MAX_STATE_BYTES,
    });
    if (!r || !r.ok) return r && r.absent ? [] : null;
    const out = [];
    for (const line of String(r.text).split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && o.ch === channel && _nonEmpty(o.sig)) out.push(o.sig);
      } catch {
        /* a malformed row is skipped; it cannot create a match */
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Should `text` be emitted on `channel` now?
 *   mode "changed" — emit unless the LAST emission on this channel had the same text.
 *   mode "once"    — emit unless ANY earlier emission on this channel had the same text.
 * Returns { emit: boolean, sig, reason }. Every failure ⇒ emit:true. No repo root (the cwd IS
 * home) ⇒ { emit: true, reason: "no-repo-root" }: nothing is read, and `recordEmission` writes
 * nothing for it either.
 */
function shouldEmit({ repoDir, sessionId, channel, text, mode }) {
  const sig = signatureOf(text);
  if (_nonEmpty(sessionId) && sessionId.length <= 512 && _repoRootOf(repoDir) === null)
    return { emit: true, sig, reason: NO_REPO_ROOT };
  const rows = _rows(repoDir, sessionId, channel);
  if (rows === null) return { emit: true, sig, reason: "state-unavailable" };
  const seen = mode === "once" ? rows.includes(sig) : rows[rows.length - 1] === sig;
  return { emit: !seen, sig, reason: seen ? "unchanged" : "new" };
}

/** Record an emission. Best-effort; returns true when the row landed (never with no repo root). */
function recordEmission({ repoDir, sessionId, channel, sig }) {
  const p = statePath(repoDir, sessionId);
  if (!p) return false;
  try {
    const { appendSinkLine, mainCheckoutBoundaryRoots } = require("./append-sink.js");
    const root = _repoRootOf(repoDir);
    if (root === null) return false;
    const w = appendSinkLine({
      repoDir: root,
      additionalRoots: mainCheckoutBoundaryRoots(root),
      sinkPath: p,
      line: JSON.stringify({ ch: String(channel), sig, at: new Date().toISOString() }),
    });
    return !!(w && w.ok);
  } catch {
    return false;
  }
}

// Distinct snapshot; informational dedupe only. Shared containment/locking/atomic
// primitives: context-meter.js::resolveLearningDir/withStateLock/writeJsonAtomic.
function withCompactionCursor({ repoDir, sessionId }, update) {
  if (!_nonEmpty(sessionId) || sessionId.length > 512) throw new Error("compaction cursor needs a session id");
  const root = _repoRootOf(repoDir);
  if (root === null) {
    // This function's failure contract is a THROW (its caller keeps the standing block on one);
    // the error is typed so the no-root case is legible, and nothing was read or written.
    const e = new Error("compaction cursor unavailable: no repo root: the cwd is the home directory, which is never a repo root; nothing was written");
    e.code = NO_REPO_ROOT;
    throw e;
  }
  const meter = require("./context-meter.js");
  const dir = meter.resolveLearningDir(root, "hook-findings");
  if (!dir.ok) throw new Error(`compaction cursor unavailable: ${dir.reason}`);
  require("fs").mkdirSync(dir.dir, { recursive: true });
  const file = path.join(dir.dir, `${meter.sessionKey(sessionId)}.compact.json`);
  const result = meter.withStateLock(file, () => {
    const { readSinkFile, mainCheckoutBoundaryRoots } = require("./append-sink.js");
    const read = readSinkFile({ repoDir: root, additionalRoots: mainCheckoutBoundaryRoots(root), sinkPath: file, maxBytes: 8192 });
    if (!read.ok && !read.absent) throw new Error(`compaction cursor read refused: ${read.reason}`);
    let prev = null;
    if (read.ok) {
      try { prev = JSON.parse(read.text); } catch { throw new Error("compaction cursor is malformed"); }
      if (!prev || prev.schema !== "standing-compaction/v1" || prev.session !== sessionId) throw new Error("compaction cursor identity mismatch");
    }
    const next = update(prev);
    const write = meter.writeJsonAtomic(dir.dir, file, { ...next.state, schema: "standing-compaction/v1", session: sessionId });
    if (!write.ok) throw new Error(`compaction cursor write refused: ${write.reason}`);
    return { ok: true, marker: next.marker };
  });
  if (!result.ok) throw new Error(`compaction cursor lock unavailable: ${result.reason}`);
  return result.marker;
}

module.exports = { DIR_REL, NO_REPO_ROOT, statePath, signatureOf, shouldEmit, recordEmission, withCompactionCursor };
