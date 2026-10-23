/**
 * session-ownership — which of a forest's lanes / worktrees THIS session has touched.
 *
 * WHY (journal/0661). The forest is shared by every session on the machine, and two Stop guards
 * (`worktree-conservation-guard.js`, `delegation-default-guard.js` lane-depth arm) enumerated the
 * WHOLE forest into EVERY session: the owner's measured example listed 22 under-packed lanes and 6
 * quiet worktrees, most of them other sessions' work that this session can neither clear nor
 * decide. A subject this session never touched collapses to ONE count line; a subject it did touch
 * is still enumerated and still drives any refusal.
 *
 * THE SIGNAL IS STRUCTURAL: a subject (an absolute worktree path, a lane/branch name) is OWNED when
 * it appears in an ASSISTANT record of this session's own transcript — a command the agent ran, a
 * brief it dispatched (agents.md pins a lane's absolute worktree path in every brief), or prose it
 * wrote. Tool RESULTS and hook ATTACHMENTS are excluded on purpose: `git worktree list` output and
 * this very guard's earlier finding name every tree, and counting them would make every subject
 * "owned" by being reported once. The session's own `cwd` tree is always owned.
 *
 * FAIL-SAFE IS "OWNED". Every subject whose attribution is not RESOLVED is returned in `owned`
 * (enumerated, refusal kept — the pre-change behaviour). A subject is resolved only when the WHOLE
 * transcript up to EOF has been searched FOR IT. That is why a subject first seen after the main
 * cursor has moved on gets its own CATCH-UP scan from byte 0 (security review H1, 2026-10-10: a
 * tree goes quiet — and so becomes a subject — only AFTER the brief that names it, so a cursor that
 * searched only new bytes for the subjects known at the time classed the session's OWN tree as
 * foreign and dropped its refusal).
 *
 * BOUNDED: at most `maxScanBytes` are read per call (catch-up first, then the main cursor). State is
 * append-only per (session, kind) — a small `{o}` cursor row per call, a full row only on change —
 * so two callers never move each other's cursor.
 *
 * ACCEPTED RESIDUAL: the state is an in-tree (gitignored) file keyed on `session_id` (see
 * `hook-output-discipline.md` § Accepted Residual). A planted row can make a subject read as NOT
 * owned; for worktree-conservation that turns an enumeration into a count line AND drops the
 * hand-back refusal for that tree. Declared there, not claimed closed.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
// O_NONBLOCK: a FIFO at the transcript path must not block the open (security review L1); the
// isFile() check after the open then refuses it.
const OPEN_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

function _nonEmpty(s) {
  return typeof s === "string" && s.trim() !== "";
}

function _statePath(root, sessionId, kind) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown-session";
  const k = String(kind || "default").replace(/[^A-Za-z0-9-]/g, "_").slice(0, 32) || "default";
  return path.join(root, ".claude", "learning", "hook-findings", `${safe}.own-${k}.jsonl`);
}

const EMPTY = (transcript) => ({ transcript: transcript || null, offset: 0, searched: [], hits: [], catchup: null });

/** Fold the append-only rows: the last FULL row, then any `{o}` cursor rows after it. */
function _readState(root, sp) {
  const { readSinkFile, mainCheckoutBoundaryRoots } = require("./append-sink.js");
  const r = readSinkFile({ repoDir: root, additionalRoots: mainCheckoutBoundaryRoots(root), sinkPath: sp, maxBytes: MAX_STATE_BYTES });
  if (!r.ok) return r.absent ? EMPTY() : null;
  let st = EMPTY();
  for (const l of r.text.split("\n")) {
    if (!l.trim()) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue; // a malformed row is skipped; at worst a subject reads unresolved (owned)
    }
    if (!o || typeof o !== "object") continue;
    if (o.full === true && Number.isInteger(o.offset) && Array.isArray(o.hits) && Array.isArray(o.searched)) {
      st = {
        transcript: _nonEmpty(o.transcript) ? o.transcript : null,
        offset: o.offset,
        searched: o.searched.filter(_nonEmpty),
        hits: o.hits.filter(_nonEmpty),
        catchup:
          o.catchup && Number.isInteger(o.catchup.offset) && Array.isArray(o.catchup.subjects)
            ? { offset: o.catchup.offset, subjects: o.catchup.subjects.filter(_nonEmpty) }
            : null,
      };
    } else if (Number.isInteger(o.o)) {
      st.offset = o.o;
      if (st.catchup && Number.isInteger(o.c)) st.catchup.offset = o.c;
    }
  }
  return st;
}

/**
 * Read [start, end) and search its COMPLETE assistant lines for `subjects`, adding matches to
 * `hits`. Returns the offset just past the last complete line read (== start when none completed).
 */
function _scan(fd, start, end, subjects, hits) {
  const len = end - start;
  if (len <= 0) return start;
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  if (got <= 0) return start;
  const lastNl = buf.lastIndexOf(10, got - 1);
  if (lastNl < 0) return start;
  if (subjects.length) {
    const text = buf.toString("utf8", 0, lastNl);
    for (const line of text.split("\n")) {
      if (line.indexOf('"role":"assistant"') < 0 || line.indexOf('"type":"attachment"') >= 0) continue;
      for (const s of subjects) if (!hits.has(s) && line.indexOf(s) >= 0) hits.add(s);
    }
  }
  return start + lastNl + 1;
}

/**
 * @param {{root:string, sessionId:string, transcriptPath:string|null, cwd?:string, kind?:string,
 *          subjects:string[], maxScanBytes?:number}} a
 * @returns {{measured:boolean, owned:Set<string>, unresolved:string[], reason:string}}
 *   `owned` ALWAYS includes every unresolved subject (fail-safe); `measured` is true only when every
 *   subject was resolved against the whole transcript.
 */
function resumedSubjects(a, subjects) {
  const CS = require("./context-state.js");
  const CH = require("./compaction-handoff.js");
  const HS = require("./handover-seed.js");
  const repoDir = a.repoDir || a.root;
  const loc = CS.locateState({ repoDir, configDir: a.configDir || process.env.CLAUDE_CONFIG_DIR, pid: a.pid || process.ppid });
  const st = CS.readState(loc), activity = CS.readActivity(loc);
  if (st.state !== "ok" || activity.state !== "ok") return [];
  const h = st.data.handover, r = st.data.resume;
  if (!h || !r || !["injected", "consumed"].includes(h.state) || r.injected !== true ||
      r.verified !== true || r.token_echoed !== true || activity.session_id !== a.sessionId ||
      r.injected_session_id !== a.sessionId || r.expected_seed_sha256 !== h.seed_sha256 ||
      r.token !== h.resume_token) return [];
  const checked = CS.verifyHandoverSeed(h, CH.resolveHandoffDir(repoDir));
  if (!checked.ok) return [];
  const seed = HS.validateSeed(checked.read.text, { repoDir });
  if (!seed.ok || seed.header.resume_token !== h.resume_token) return [];
  const paths = [];
  for (const row of seed.sections["IN FLIGHT"].rows) {
    const cells = row.replace(/^\s*[-*]\s+/, "").split(/\s+\|\s+/);
    const cell = cells[2];
    if (typeof cell !== "string") continue;
    const candidate = cell.trim().replace(/^(?:lane wt|wt)\s+/, "").replace(/^`(.*)`$/, "$1");
    if (!path.isAbsolute(candidate)) continue;
    try { paths.push(fs.realpathSync(candidate)); } catch { /* absent paths grant nothing */ }
  }
  let lanes = null;
  if (a.kind === "lane" && paths.length) lanes = require("./wip-lanes.js")._worktreeLaneRoots(repoDir);
  return subjects.filter(s => {
    if (a.kind === "lane") return lanes && lanes.ok && lanes.roots.some(w => w.branch === s && paths.some(p => p === w.real || p.startsWith(w.real + path.sep)));
    try {
      const real = fs.realpathSync(s);
      return paths.some(p => p === real || p.startsWith(real + path.sep));
    } catch { return false; }
  });
}

function ownedSubjects(a) {
  const subjects = [...new Set((Array.isArray(a && a.subjects) ? a.subjects : []).filter(_nonEmpty))];
  const failSafe = (reason) => ({ measured: false, owned: new Set(subjects), unresolved: subjects.slice(), reason });
  const owned = new Set();
  const cwd = a && _nonEmpty(a.cwd) ? path.resolve(a.cwd) : null;
  if (cwd) {
    for (const s of subjects) {
      if (path.isAbsolute(s) && (cwd === path.resolve(s) || cwd.startsWith(path.resolve(s) + path.sep))) owned.add(s);
    }
  }
  try {
    if (!a || !_nonEmpty(a.root) || !_nonEmpty(a.sessionId) || !_nonEmpty(a.transcriptPath))
      return failSafe("no session transcript to attribute against");
    const sp = _statePath(a.root, a.sessionId, a.kind);
    let st = _readState(a.root, sp);
    if (!st) return failSafe("ownership state unreadable");
    if (st.transcript !== a.transcriptPath) st = EMPTY(a.transcriptPath);
    const fd = fs.openSync(a.transcriptPath, OPEN_FLAGS);
    let size;
    let mainEnd;
    const before = JSON.stringify([st.searched, st.hits, st.catchup && st.catchup.subjects]);
    const hits = new Set(st.hits);
    const searched = new Set(st.searched);
    try {
      const stt = fs.fstatSync(fd);
      if (!stt.isFile()) return failSafe("transcript is not a regular file");
      size = stt.size;
      if (st.offset > size) {
        // Truncated or replaced transcript: everything restarts from byte 0.
        st = EMPTY(a.transcriptPath);
        hits.clear();
        searched.clear();
      }
      // New subjects: while the main cursor is still at 0 they simply join the main scan; once it
      // has moved, they need a CATCH-UP scan from byte 0 (H1). A running catch-up restarts with the
      // union, so no subject is ever resolved against less than the whole transcript.
      const known = new Set([...searched, ...(st.catchup ? st.catchup.subjects : [])]);
      const fresh = subjects.filter((s) => !known.has(s));
      if (fresh.length) {
        if (st.offset === 0 && !st.catchup) fresh.forEach((s) => searched.add(s));
        else st.catchup = { offset: 0, subjects: [...(st.catchup ? st.catchup.subjects : []), ...fresh] };
      }
      let budget = Number.isInteger(a.maxScanBytes) && a.maxScanBytes > 0 ? a.maxScanBytes : DEFAULT_MAX_SCAN_BYTES;
      if (st.catchup) {
        const target = st.offset; // always a line boundary
        const end = Math.min(target, st.catchup.offset + budget);
        if (end > st.catchup.offset) {
          budget -= end - st.catchup.offset;
          st.catchup.offset = _scan(fd, st.catchup.offset, end, st.catchup.subjects, hits);
        }
        if (st.catchup.offset >= target) {
          st.catchup.subjects.forEach((s) => searched.add(s));
          st.catchup = null;
        }
      }
      mainEnd = st.offset;
      if (budget > 0) {
        mainEnd = Math.min(size, st.offset + budget);
        st.offset = _scan(fd, st.offset, mainEnd, [...searched], hits);
      }
    } finally {
      fs.closeSync(fd);
    }
    const { appendSinkLine, mainCheckoutBoundaryRoots } = require("./append-sink.js");
    const after = JSON.stringify([[...searched], [...hits], st.catchup && st.catchup.subjects]);
    const row =
      after !== before
        ? { full: true, transcript: a.transcriptPath, offset: st.offset, searched: [...searched], hits: [...hits], catchup: st.catchup }
        : st.catchup
          ? { o: st.offset, c: st.catchup.offset }
          : { o: st.offset };
    appendSinkLine({ repoDir: a.root, additionalRoots: mainCheckoutBoundaryRoots(a.root), sinkPath: sp, line: JSON.stringify(row) });
    // Resolved = searched for, over a main read that reached EOF (an unterminated final line is
    // still being written and holds nothing the agent has finished saying).
    const atEof = mainEnd >= size;
    const unresolved = subjects.filter((s) => !(atEof && searched.has(s)));
    for (const s of subjects) if (hits.has(s)) owned.add(s);
    for (const s of resumedSubjects(a, subjects)) owned.add(s);
    for (const s of unresolved) owned.add(s);
    return {
      measured: unresolved.length === 0,
      owned,
      unresolved,
      reason: unresolved.length
        ? `${unresolved.length} subject(s) not yet resolved against the whole transcript`
        : "every subject resolved against the transcript to EOF",
    };
  } catch (e) {
    return failSafe(`ownership scan failed: ${e && e.message ? e.message : String(e)}`);
  }
}

module.exports = { ownedSubjects, DEFAULT_MAX_SCAN_BYTES, _statePath };
