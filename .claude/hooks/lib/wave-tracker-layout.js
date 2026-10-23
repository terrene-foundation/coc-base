/** wave-tracker-layout — context-budget S6. */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { atomicWrite, readNotesFileGuarded } = require("./session-notes-layout.js");

const WAVE_TRACKER_DIR = ".wave-tracker.d";
const WAVE_ARCHIVE_SUBDIR = "archive";
const WAVE_TRACKER_CEILING_LINES = 300;

const TERMINAL_WORDS = [
  "CLOSED",
  "LANDED",
  "COMPLETE",
  "COMPLETED",
  "DONE",
  "ARCHIVED",
  "SUPERSEDED",
  "RETIRED",
  "DELIVERED",
];
const HEADING_CLOSED_RE = new RegExp(`\\s(?:—|–|\\||-)\\s+(?:${TERMINAL_WORDS.join("|")})(?:\\s+#+)?\\s*$`);
const STATUS_LINE_RE = new RegExp(
  `^\\s*(?:\\*\\*)?status(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?(?:${TERMINAL_WORDS.join("|")})(?:\\*\\*)?\\s*$`,
  "i",
);
const PRIOR_WAVES_RE = /^##\s+prior waves(?:\s+#+)?\s*$/i;

function countLines(content) {
  if (typeof content !== "string" || content === "") return 0;
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return body.split("\n").length;
}

/**
 * Split a tracker into its preamble and H2 sections, each classified.
 * Pure. Fenced code blocks are respected so a `## ` inside ``` is not a heading.
 *
 * @param {string} text
 * @returns {{preamble:string, sections:Array<{heading:string, text:string, lines:number, closed:boolean, why:string|null}>}}
 */
function partitionWaves(text) {
  const src = String(text || "");
  const lines = src.match(/[^\n]*\n|[^\n]+$/g) || [];
  const pre = [];
  const sections = [];
  let cur = null;
  let fence = null;
  for (const raw of lines) {
    const line = raw.replace(/\r?\n$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && /^\s*$/.test(marker[2])) fence = null;
    } else if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
      fence = { char: marker[1][0], length: marker[1].length };
    } else if (/^## /.test(line)) {
      cur = { heading: line, body: [raw] };
      sections.push(cur);
      continue;
    }
    (cur ? cur.body : pre).push(raw);
  }
  if (fence) return { preamble: src, sections: [], error: "unbalanced fence", reason: `unclosed ${fence.char.repeat(fence.length)} fence — tracker untouched` };
  const out = sections.map((s) => {
    const firstBody = s.body.slice(1).find((l) => l.trim() !== "");
    let why = null;
    if (PRIOR_WAVES_RE.test(s.heading)) why = "prior-waves-section";
    else if (HEADING_CLOSED_RE.test(s.heading.replace(/^##\s+/, ""))) why = "heading-marker";
    else if (firstBody && STATUS_LINE_RE.test(firstBody)) why = "status-line";
    const t = s.body.join("");
    return { heading: s.heading, text: t, lines: countLines(t), closed: !!why, why };
  });
  return { preamble: pre.join(""), sections: out };
}

/**
 * Ceiling decision for a tracker body. Pure — the guard and the archiver share it.
 * @returns {{over:boolean, lines:number, ceiling:number}}
 */
function decideWaveTrackerCeiling(content) {
  const lines = countLines(content);
  return { over: lines > WAVE_TRACKER_CEILING_LINES, lines, ceiling: WAVE_TRACKER_CEILING_LINES };
}

function trackerPathFor(baseDir, id) {
  return path.join(baseDir, WAVE_TRACKER_DIR, `${id}.md`);
}

function waveArchivePathFor(baseDir, id) {
  return path.join(baseDir, WAVE_TRACKER_DIR, WAVE_ARCHIVE_SUBDIR, `${id}.md`);
}

const _ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;

/**
 * Move CLOSED wave sections out of the tracker into its archive. Dry-run unless
 * `opts.apply`. The archive is written FIRST and re-read; the tracker is
 * rewritten only once every moved section is found verbatim in the archive.
 *
 * @param {string} baseDir
 * @param {string} id  tracker basename without `.md` (the operator handle)
 * @param {{apply?:boolean}} [opts]
 * @returns {{ok:boolean, applied:boolean, error?:string, reason?:string,
 *            before_lines:number, after_lines:number, ceiling:number,
 *            archived:Array<{heading:string, lines:number, why:string}>,
 *            current:Array<{heading:string, lines:number}>, archive_path:string}}
 */
function archiveClosedWaves(baseDir, id, opts) {
  const apply = !!(opts && opts.apply);
  const base = { applied: false, ceiling: WAVE_TRACKER_CEILING_LINES };
  if (typeof id !== "string" || !_ID_RE.test(id)) {
    return { ...base, ok: false, error: "invalid id", reason: `tracker id must match ${_ID_RE}` };
  }
  try {
    const root = fs.realpathSync.native(baseDir);
    const dir = canonicalDirectory(root, path.join(root, WAVE_TRACKER_DIR));
    const trackerPath = path.join(dir, `${id}.md`);
    const archiveDir = path.join(dir, WAVE_ARCHIVE_SUBDIR);
    try {
      if (canonicalDirectory(root, archiveDir) !== archiveDir) throw new Error("archive directory alias refused");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const run = () => archiveLocked(root, dir, trackerPath, archiveDir, id, apply, base);
    return apply ? { ...base, ...withArchiveLock(trackerPath, run) } : run();
  } catch (e) {
    return { ...base, ok: false, error: "archive transaction refused", reason: e.message };
  }
}

function canonicalDirectory(root, dir) {
  const physical = fs.realpathSync.native(dir);
  const rel = path.relative(root, physical);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !fs.statSync(physical).isDirectory()) {
    throw new Error(`directory outside canonical root: ${dir}`);
  }
  return physical;
}

function withArchiveLock(trackerPath, fn) {
  const lock = `${trackerPath}.archive.lock`;
  let fd;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch (e) {
    return { ok: false, applied: false, error: "archive lock refused", reason: `${e.code || "error"}: tracker and archive untouched` };
  }
  const mine = fs.fstatSync(fd);
  try {
    fs.writeSync(fd, `${process.pid}\n`);
    return fn();
  } finally {
    try {
      const current = fs.lstatSync(lock);
      if (current.dev === mine.dev && current.ino === mine.ino && current.isFile()) fs.unlinkSync(lock);
    } finally {
      fs.closeSync(fd);
    }
  }
}

function archiveLocked(root, dir, trackerPath, archiveDir, id, apply, base) {
  const archivePath = path.join(archiveDir, `${id}.md`);
  const g = readNotesFileGuarded(trackerPath);
  if (!g.ok) {
    return {
      ...base,
      ok: false,
      error: "tracker unreadable",
      reason: `${path.relative(root, trackerPath)}: ${g.kind}`,
      archive_path: archivePath,
    };
  }
  if (!Buffer.from(g.content).equals(fs.readFileSync(trackerPath))) {
    return { ...base, ok: false, error: "tracker bytes unrepresentable", reason: "invalid UTF-8 or changed read — tracker untouched" };
  }
  const parts = partitionWaves(g.content);
  if (parts.error) return { ...base, ok: false, error: parts.error, reason: parts.reason, archive_path: archivePath };
  const { preamble, sections } = parts;
  const closed = sections.filter((s) => s.closed);
  const open = sections.filter((s) => !s.closed);
  const pointer = `Closed waves are archived verbatim at \`${WAVE_TRACKER_DIR}/${WAVE_ARCHIVE_SUBDIR}/${id}.md\` (read on demand).`;
  const pre = preamble.includes(pointer) || closed.length === 0 ? preamble : `${preamble}\n${pointer}\n`;
  const next = pre + open.map((s) => s.text).join("");
  const before = countLines(g.content);
  const after = closed.length ? countLines(next) : before;
  const report = {
    ...base,
    before_lines: before,
    after_lines: after,
    archived: closed.map((s) => ({ heading: s.heading, lines: s.lines, why: s.why })),
    current: open.map((s) => ({ heading: s.heading, lines: s.lines })),
    conservation: { before: closed.map((s) => sectionIdentity(s.heading, s.text)), after: [] },
    archive_path: archivePath,
  };

  if (apply && closed.length) {
    if (canonicalDirectory(root, dir) !== dir) throw new Error("tracker directory changed");
    fs.mkdirSync(archiveDir, { recursive: true });
    if (canonicalDirectory(root, archiveDir) !== archiveDir) throw new Error("archive directory changed");
    let prior = "";
    let exists = true;
    try { fs.lstatSync(archivePath); } catch (e) { if (e.code === "ENOENT") exists = false; else throw e; }
    if (exists) {
      const ga = readNotesFileGuarded(archivePath);
      if (!ga.ok) {
        return { ...report, ok: false, error: "archive unreadable", reason: `${ga.kind} — tracker untouched` };
      }
      prior = ga.content;
      if (!Buffer.from(prior).equals(fs.readFileSync(archivePath))) {
        return { ...report, ok: false, error: "archive bytes unrepresentable", reason: "invalid UTF-8 or changed read — tracker untouched" };
      }
    }
    const stamp = `<!-- archived ${new Date().toISOString()} by wave-tracker-layout.js::archiveClosedWaves -->`;
    const appended =
      (prior ? prior + (prior.endsWith("\n") ? "\n" : "\n\n") : `# Wave tracker archive — ${id}\n\n`) +
      stamp +
      "\n\n" +
      closed.map((s) => s.text).join("");
    const wa = atomicWrite(archivePath, appended);
    if (!wa.ok) return { ...report, ok: false, error: "archive write failed", reason: wa.reason };
    const reread = readNotesFileGuarded(archivePath);
    const missing = closed.filter((s) => !(reread.ok && reread.content.includes(s.text)));
    if (!reread.ok || reread.content !== appended || missing.length) {
      return {
        ...report,
        ok: false,
        error: "archive conservation failed",
        reason: `archive bytes differ from the append plan (${missing.length} missing section(s)) — tracker untouched`,
      };
    }
    let cursor = appended.length - closed.reduce((n, s) => n + s.text.length, 0);
    report.conservation.after = closed.map((s) => {
      const observed = reread.content.slice(cursor, cursor + s.text.length);
      cursor += s.text.length;
      return sectionIdentity(s.heading, observed);
    });
    const wt = atomicWrite(trackerPath, next);
    if (!wt.ok) return { ...report, ok: false, error: "tracker write failed", reason: wt.reason };
    report.applied = true;
  }

  if (after > WAVE_TRACKER_CEILING_LINES) {
    return {
      ...report,
      ok: false,
      error: "over ceiling",
      reason: `${after} lines of CURRENT waves > ${WAVE_TRACKER_CEILING_LINES} after archiving ${closed.length} closed section(s); declare finished waves closed (heading marker or 'Status: closed') — nothing is truncated`,
    };
  }
  return { ...report, ok: true };
}

function sectionIdentity(heading, text) {
  return { heading, bytes: Buffer.byteLength(text), sha256: crypto.createHash("sha256").update(text).digest("hex") };
}

module.exports = {
  WAVE_TRACKER_DIR,
  WAVE_ARCHIVE_SUBDIR,
  WAVE_TRACKER_CEILING_LINES,
  TERMINAL_WORDS,
  partitionWaves,
  decideWaveTrackerCeiling,
  trackerPathFor,
  waveArchivePathFor,
  archiveClosedWaves,
};
