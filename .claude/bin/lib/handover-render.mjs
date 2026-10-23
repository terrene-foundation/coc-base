/**
 * handover-render.mjs — project ONE validated seed onto every durable surface.
 *
 * @what The library behind `.claude/bin/handover-render.mjs` (CYCLE.md shard
 *       S2, `workspaces/context-budget-2026-10-10/design/CYCLE.md` §1.4 step 3
 *       and §2.2–§2.3). From a seed that `hooks/lib/handover-seed.js` has
 *       ACCEPTED it writes four projections, each reporting exactly one of
 *       `ok | skipped | failed`:
 *
 *         fragment       the operator's `.session-notes.d/<id>.md` gains a new
 *                        `## CURRENT` section carrying the seed; the previous
 *                        CURRENT heading is demoted to HISTORY in place (every
 *                        other byte is preserved).
 *         events         declared burndown transitions (`--events <file>`) are
 *                        appended through the ONE signed write path,
 *                        `burndown-events.js::appendEvent`.
 *         forest-ledger  `.session-notes.shared.md` is regenerated from the log
 *                        when this render appended at least one event.
 *         vault          the Obsidian handover PAIR is written through the
 *                        `vault-handover.mjs` single derivation (`plan` →
 *                        exclusive-create both files → `verify`).
 *
 * @why  The owner's directives: the handover "cannot end up blowing up the
 *       context and yet must contain good information", and the pre/post cycle
 *       "MUST BE AUTONOMOUS, not requiring human intervention at ANY STEP". So
 *       the projections cost ONE tool call and almost no model output, and no
 *       step stops to ask: a surface that cannot be written is reported as
 *       `skipped` (a DECLARED absence, e.g. no vault configured on this machine)
 *       or `failed` (it should have been written and was not) — never swallowed,
 *       never a prompt.
 *
 * @invariants
 *   1. An invalid seed projects NOTHING (the caller refuses before calling here).
 *   2. Every projection returns a status; one failing never aborts the others.
 *   3. The seed bytes hashed at validation are the bytes projected, and the file
 *      is re-hashed at the end — a seed rewritten mid-render is a failure.
 *   4. Re-rendering the same seed is idempotent: the fragment and the vault
 *      recognise their own `seed_sha256` marker; events whose status already
 *      holds are not re-appended.
 *   5. Nothing is overwritten: vault files are created exclusively (`wx`), and a
 *      half-written pair is rolled back rather than left as one file.
 *   6. Every time this module writes is the TOOL's clock (`ctx.stampMs`, else
 *      `deps.now()`, else `Date.now()`), never the seed's hand-typed `written=`:
 *      the record's `written_at`, the fragment heading and the vault date all carry
 *      the stamp; the seed's own value travels only as `declared_written`. The
 *      caller runs `handoverBinding` BEFORE calling here (as it runs validation),
 *      which REFUSES a seed whose `written=` disagrees with the stamp.
 *
 * Dependencies (identity, signing, the event log, the vault CLI, the clock) are
 * INJECTED through `deps`, so every branch is drivable from a fixture; the CLI
 * wires the real ones.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ARCHIVE_SUBDIR, parseFrontmatter, resolveVaultDir } from "./vault-handover.mjs";
const require = createRequire(import.meta.url);
const seedLib = require("../../hooks/lib/handover-seed.js");
const stateLib = require("../../hooks/lib/context-state.js");
const handoffLib = require("../../hooks/lib/compaction-handoff.js");

export const RENDER_SCHEMA = "handover-render/v1";
export const PROJECTIONS = Object.freeze(["fragment", "events", "forest-ledger", "vault"]);
export const STATUSES = Object.freeze(["ok", "skipped", "failed"]);

// ── the writer-side BINDING (M6: stamp, assignment, ledger, owned collapse) ────
//
// handover-seed.js::validateSeed is the SHARED structural schema — it also runs on READ
// (SessionStart re-validates an injected seed hours later), so nothing clock- or
// filesystem-dependent may live there. What only the WRITER can and must check lives
// here, run by the CLI after validation and before any projection:
//
//   written-skew   the seed's `written=` is a hand-typed claim. Measured 2026-10-11: a
//                  seed declared written=23:40 when its bytes landed at 23:21 — 19 min in
//                  the FUTURE, which blinds any "after written=" tail fence for 19 min.
//                  REFUSED rather than rewritten: the seed's bytes are provenance-bound by
//                  sha256 to this session's own Write (context-state.js::validateRenderedSeed),
//                  so a renderer that rewrote them would have to re-bind provenance itself —
//                  widening the trust boundary of a /clear (kill-path) input. The refusal
//                  prints the stamp to copy, so the fix is one Edit the hook observes.
//                  Bounds are ASYMMETRIC because the two errors are: a FUTURE value hides
//                  tail (the dangerous direction) — 120 s absorbs a minute-resolution value
//                  and clock granularity, nothing more; a PAST value only widens a fence —
//                  600 s covers the cycle's ≤ 4 consecutive tool calls between writing the
//                  seed and rendering it; older is a stale seed, rewrite it.
//   assignment-*   M6c/M6b: the seed must DECLARE its assignment — the owner's objective
//                  verbatim + a readable ledger + next step, or `ASSIGNMENT: none`. The
//                  ledger must exist, be a non-empty regular file, CONTAIN the objective
//                  verbatim (whitespace-normalised: it ties the pointer to the RIGHT
//                  document — the measured failure pointed DEPTH at an unrelated design
//                  doc), and have been written within LEDGER_STALE_TOLERANCE_MS of the
//                  stamp.
//   owned-*        M6c: work owned by a delegated session is ONE OWNED BY OTHERS line —
//                  a `who` listed twice, or an IN FLIGHT row owned by a `who` that OWNED
//                  lists, is refused (measured: 5 IN FLIGHT rows of a delegated offshoot's
//                  lanes read as "the orchestrator does ops" and it re-entered relay mode).
//
// WHAT THIS CANNOT SEE (named, not implied): whether the ledger holds the LATEST result
// (mtime is a proxy — a bare touch passes it); an `ASSIGNMENT: none` written over a real
// assignment; delegated rows listed as IN FLIGHT under an owner OWNED does not name; and
// anything said in the transcript AFTER the seed (the tail fence is a separate check).

/** A FUTURE `written=` is a typed time, not a clock: bounded tightly. Shared with the seed-write hook. */
export const WRITTEN_FUTURE_SKEW_MS = seedLib.WRITTEN_FUTURE_SKEW_MS;
/** A seed (or its `written=`) older than this is STALE: rewrite it, never re-label it. Shared with the seed-write hook. */
export const WRITTEN_PAST_SKEW_MS = seedLib.WRITTEN_PAST_SKEW_MS;
/** Owner-message scan bounds (S1): the current transcript first, then its predecessors, newest first. */
export const OWNER_SCAN_MAX_FILES = 24;
export const OWNER_SCAN_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * A ledger last written more than this before the stamp is STALE. Write-through (M6a) puts
 * every reported result into the ledger in the turn it is reported, so a ledger untouched
 * for the 15 min before a context-full handover either missed the latest results (the
 * measured failure: results lived only in chat) or the write-through step was skipped. The
 * costs are asymmetric — a false refusal costs one ledger append, a false accept cost an
 * hour of wrong answers to the owner — so the window is tight.
 */
export const LEDGER_STALE_TOLERANCE_MS = 15 * 60 * 1000;
/** Read at most this much of a ledger; a larger one is refused as unverifiable, never truncated. */
export const LEDGER_READ_CAP_BYTES = 1024 * 1024;

/** The tool's clock as ISO-8601 with this host's offset (`…T23:21:27+08:00`), seconds precision. */
export function stampIso(ms) {
  return seedLib.clockIso(ms);
}

function fmtDelta(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

const normWs = (t) => String(t).replace(/\s+/g, " ").trim();

function cellsOf(validation, label) {
  return sectionRows(validation, label)
    .filter((r) => !/^\s*(?:[-*•]\s+)?\(?none\)?\.?\s*$/i.test(r))
    .map((r) => r.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, "").split(/\s\|\s/).map((c) => c.trim()));
}

/**
 * The writer-side binding. Pure apart from the ledger and transcript reads (`fsImpl`, default `fs`).
 * @param {object} validation an ACCEPTED validateSeed verdict
 * @param {{nowMs:number, seedWrittenMs?:number, transcriptPath?:string, fsImpl?:object, ownerScan?:object}} opts
 *   seedWrittenMs — the seed-write HOOK's clock when this seed's bytes first landed (S4: the
 *   anchor for both the label check and the content's age); absent ⇒ the render's own clock.
 *   transcriptPath — the session transcript the hook recorded at the seed write (S1).
 * @returns {{ok:boolean, findings:Array<{code,section,question,detail}>, stamp:{ms:number, iso:string},
 *            declared_written:string|null, skew_ms:number|null, assignment:object|null, ledger:object|null, owner:object|null}}
 */
export function handoverBinding(validation, { nowMs, seedWrittenMs, transcriptPath = null, fsImpl = fs, ownerScan = {} } = {}) {
  const findings = [];
  const add = (code, section, question, detail) => findings.push({ code, section, question, detail });
  const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
  const stamp = { ms, iso: stampIso(ms) };
  const hooked = Number.isFinite(seedWrittenMs);
  const anchor = hooked ? seedWrittenMs : ms;
  const anchorName = hooked ? `the seed-write clock (${stampIso(anchor)})` : `the renderer's clock (stamp ${stamp.iso})`;
  const declared = (validation.header && validation.header.written) || null;
  const declaredMs = declared ? Date.parse(declared) : NaN;
  let skew = null;
  // S2: only a FUTURE label is fixed in place (the content is as fresh as its write). A PAST
  // one — or content older than the bound — is a STALE seed: re-labelling it would re-freshen
  // old content, so the remedy is a NEW seed file written from live state.
  if (!Number.isFinite(declaredMs)) {
    add("written-skew", "HEADER", null, `written= ${JSON.stringify(declared)} is not a readable time; Edit the header to written=${stampIso(anchor)} (the clock the [CTX] line prints)`);
  } else {
    skew = declaredMs - anchor;
    if (skew > WRITTEN_FUTURE_SKEW_MS) add("written-skew", "HEADER", null, `written=${declared} is ${fmtDelta(skew)} AHEAD of ${anchorName} (at most ${WRITTEN_FUTURE_SKEW_MS / 1000}s ahead) — a typed time, not a clock. Edit the header to written=${stampIso(anchor)} and re-render`);
    else if (-skew > WRITTEN_PAST_SKEW_MS) add("seed-stale", "HEADER", null, `written=${declared} is ${fmtDelta(skew)} BEHIND ${anchorName} (at most ${WRITTEN_PAST_SKEW_MS / 1000}s behind) — an old seed or an old time. Do NOT re-label it: write a NEW seed file from live state (written=${stamp.iso}) and render that`);
  }
  if (hooked && ms - anchor > WRITTEN_PAST_SKEW_MS) {
    add("seed-stale", "HEADER", null, `this seed's bytes first landed ${fmtDelta(ms - anchor)} before this render (at most ${WRITTEN_PAST_SKEW_MS / 1000}s) — what happened since is not in it. Write a NEW seed file from live state and render that`);
  }

  const a = seedLib.assignmentFields(validation.sections);
  let ledger = null;
  let owner = null;
  if (a === null) {
    add("assignment-missing", "ASSIGNMENT", 1, "a rendered handover must DECLARE its assignment: 'ASSIGNMENT' with objective (owner wording verbatim, quoted) / ledger / next rows, or 'ASSIGNMENT: none' when no owner-assigned objective is carried — without it the objective collapses into the one-line MISSION");
  } else if (!a.none && a.ledger) {
    ledger = checkLedger(a, validation, ms, fsImpl, add);
    owner = checkObjectiveFromOwner(a, transcriptPath, fsImpl, ownerScan, add);
  }

  const owned = cellsOf(validation, "OWNED BY OTHERS").map((c) => normWs(c[0] || "").toLowerCase()).filter(Boolean);
  const dup = owned.filter((w, i) => owned.indexOf(w) !== i);
  for (const w of [...new Set(dup)]) add("owned-not-collapsed", "OWNED BY OTHERS", 3, `'${w}' has ${owned.filter((x) => x === w).length} OWNED BY OTHERS rows — work owned by one delegated session is ONE line (who | what | waiting on | check); its detail lives in that session's own ledger`);
  const escape = (t) => t.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
  for (const row of cellsOf(validation, "IN FLIGHT")) {
    const owner2 = row[4] || "";
    const hit = [...new Set(owned)].find((w) => new RegExp(`(^|[^A-Za-z0-9_-])${escape(w)}($|[^A-Za-z0-9_-])`, "i").test(owner2));
    if (hit) add("inflight-owned-by-other", "IN FLIGHT", 2, `IN FLIGHT row '${row[0]}' is owned by '${hit}', which OWNED BY OTHERS already lists — a delegated session's work is its ONE OWNED line, not IN FLIGHT rows (ops rows of a delegate make the next context re-enter relay mode)`);
  }
  return { ok: findings.length === 0, findings, stamp, declared_written: declared, skew_ms: skew, assignment: a, ledger, owner };
}

/**
 * Open-then-fstat read of a regular file, capped ON THE DESCRIPTOR (S6): the type and size
 * that are checked are those of the bytes read — no stat/read race — and O_NONBLOCK keeps a
 * FIFO planted at the path from hanging the render. {ok, text, st} | {ok:false, code, why}.
 */
function readRegularCapped(target, cap, fsImpl) {
  const C = fs.constants;
  let fd;
  try {
    fd = fsImpl.openSync(target, C.O_RDONLY | (C.O_NONBLOCK || 0));
  } catch (e) {
    return { ok: false, why: `cannot be opened (${(e && e.code) || "open failed"})` };
  }
  try {
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile()) return { ok: false, why: "is not a regular file" };
    if (st.size === 0) return { ok: false, why: "is empty" };
    if (st.size > cap) return { ok: false, why: `is ${st.size} B, over the ${cap} B read cap — the objective check cannot run (refused, never truncated)` };
    const buf = Buffer.alloc(st.size + 1);
    let got = 0;
    for (;;) {
      const n = fsImpl.readSync(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
      if (got > cap) return { ok: false, why: `grew past the ${cap} B read cap while being read` };
      if (got === buf.length) return { ok: false, why: "grew while being read" };
    }
    return { ok: true, text: buf.subarray(0, got).toString("utf8"), st };
  } catch (e) {
    return { ok: false, why: `cannot be read (${(e && e.code) || "read failed"})` };
  } finally {
    try {
      fsImpl.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

function checkLedger(a, validation, nowMs, fsImpl, add) {
  const repo = roleField(validation, "repo");
  const target = path.isAbsolute(a.ledger) ? a.ledger : repo ? path.resolve(repo, a.ledger) : null;
  const out = { path: target, mtime_ms: null };
  const no = (code, detail) => {
    add(code, "ASSIGNMENT", 1, detail);
    return out;
  };
  if (!target) return no("assignment-ledger-unreadable", `ledger ${JSON.stringify(a.ledger)} is relative and ROLE has no repo= to resolve it against`);
  const r = readRegularCapped(target, LEDGER_READ_CAP_BYTES, fsImpl);
  if (!r.ok) return no("assignment-ledger-unreadable", `ledger ${target} ${r.why} — the assignment's durable state must exist BEFORE the handover that points at it`);
  out.mtime_ms = r.st.mtimeMs;
  const objective = normWs(a.objective.replace(/^"/, "").replace(/"$/, ""));
  if (!objective || !normWs(r.text).includes(objective)) {
    add("assignment-objective-not-in-ledger", "ASSIGNMENT", 1, `ledger ${target} does not contain the ASSIGNMENT objective verbatim — either the objective was paraphrased or the pointer names the wrong document`);
  }
  const age = nowMs - r.st.mtimeMs;
  // F7: a FUTURE mtime would pass the staleness bound forever — it is refused, not trusted.
  if (-age > WRITTEN_FUTURE_SKEW_MS) {
    add("assignment-ledger-future", "ASSIGNMENT", 1, `ledger ${target} carries a modification time ${fmtDelta(age)} in the FUTURE — a future mtime would satisfy the freshness bound indefinitely, so it proves nothing. Re-write the ledger so its mtime is the real clock`);
  } else if (age > LEDGER_STALE_TOLERANCE_MS) {
    add("assignment-ledger-stale", "ASSIGNMENT", 1, `ledger ${target} was last written ${fmtDelta(age)} before this handover (at most ${LEDGER_STALE_TOLERANCE_MS / 60000} min) — results reported since then exist only in this context. Append them (or a dated 'no change since' line) to the ledger, then re-render`);
  }
  return out;
}

/**
 * S1: the objective must be the OWNER's words, not only the agent's ledger's. It is looked
 * for in owner-typed records (context-state.js::ownerTexts) of the session transcript the
 * seed-write hook recorded, then of its predecessors (the sibling transcripts, newest first),
 * bounded by OWNER_SCAN_MAX_FILES / OWNER_SCAN_MAX_BYTES. No transcript to read ⇒ REFUSED as
 * unverified: an objective nobody can trace to the owner is never carried as the owner's.
 */
function checkObjectiveFromOwner(a, transcriptPath, fsImpl, ownerScan, add) {
  const objective = normWs(a.objective.replace(/^"/, "").replace(/"$/, ""));
  const r = objectiveFromOwner(objective, { transcriptPath, fsImpl, ...ownerScan });
  if (r.found) return r;
  if (r.unverified) {
    add("assignment-objective-unverified", "ASSIGNMENT", 1, `the objective cannot be traced to an owner message: ${r.reason}. An objective is carried only when an owner-typed message holds it verbatim`);
  } else {
    add("assignment-objective-not-from-owner", "ASSIGNMENT", 1, `no owner-typed message holds the objective verbatim (scanned ${r.scanned_files} transcript(s), ${r.scanned_bytes} B${r.skipped ? `; ${r.skipped}` : ""}) — quote the owner's own wording, or declare 'ASSIGNMENT: none'`);
  }
  return r;
}

const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;
const SCAN_MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Stream one transcript for an owner-typed record holding `objective` (whitespace-normalised).
 * A cheap prefilter (the objective's two longest JSON-safe words, as bytes) selects the only
 * lines that are parsed; a line longer than SCAN_MAX_LINE_BYTES is skipped (no owner prompt
 * is that long). {found, bytes}.
 */
function scanTranscriptForOwner(file, objective, keys, budget, fsImpl) {
  let fd;
  try {
    fd = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  } catch {
    return { found: false, bytes: 0 };
  }
  let bytes = 0;
  try {
    if (!fsImpl.fstatSync(fd).isFile()) return { found: false, bytes: 0 };
    let carry = Buffer.alloc(0);
    let pos = 0;
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
    const lineHolds = (line) => {
      for (const k of keys) if (line.indexOf(k) < 0) return false;
      let r;
      try {
        r = JSON.parse(line.toString("utf8"));
      } catch {
        return false;
      }
      return stateLib.ownerTexts(r).some((t) => normWs(t).includes(objective));
    };
    for (;;) {
      if (bytes >= budget) break;
      const n = fsImpl.readSync(fd, chunk, 0, Math.min(chunk.length, budget - bytes), pos);
      if (n <= 0) break;
      pos += n;
      bytes += n;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      let at = 0;
      const seen = new Set();
      // Visit only lines that hold the first key.
      for (let hit = buf.indexOf(keys[0], 0); hit >= 0; hit = buf.indexOf(keys[0], hit + 1)) {
        const s = buf.lastIndexOf(0x0a, hit) + 1;
        const e = buf.indexOf(0x0a, hit);
        if (e < 0) break; // incomplete: carried
        if (seen.has(s)) continue;
        seen.add(s);
        if (lineHolds(buf.subarray(s, e))) return { found: true, bytes };
      }
      const last = buf.lastIndexOf(0x0a);
      at = last + 1;
      carry = Buffer.from(buf.subarray(at));
      if (carry.length > SCAN_MAX_LINE_BYTES) carry = Buffer.alloc(0);
    }
    if (carry.length && lineHolds(carry)) return { found: true, bytes };
    return { found: false, bytes };
  } catch {
    return { found: false, bytes };
  } finally {
    try {
      fsImpl.closeSync(fd);
    } catch {
      /* closed */
    }
  }
}

/** Exported for the binding and its tests. {found, unverified?, reason?, file?, scanned_files, scanned_bytes, skipped?}. */
export function objectiveFromOwner(objective, { transcriptPath, fsImpl = fs, maxFiles = OWNER_SCAN_MAX_FILES, maxBytes = OWNER_SCAN_MAX_BYTES } = {}) {
  const out = { found: false, scanned_files: 0, scanned_bytes: 0 };
  if (!objective) return { ...out, unverified: true, reason: "the objective is empty" };
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) {
    return { ...out, unverified: true, reason: "no session transcript was recorded at the seed write (a CLI without one cannot carry an owner objective)" };
  }
  // Prefilter keys: the two longest words with no JSON-escaped characters, as UTF-8 bytes.
  const words = objective.split(" ").filter((w) => !/["\\\u0000-\u001f]/.test(w)).sort((x, y) => y.length - x.length);
  if (!words.length) return { ...out, unverified: true, reason: "the objective has no word the transcript scan can key on" };
  const keys = words.slice(0, 2).map((w) => Buffer.from(w, "utf8"));
  const dir = path.dirname(transcriptPath);
  let siblings = [];
  try {
    siblings = fsImpl
      .readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl") && path.join(dir, n) !== transcriptPath)
      .map((n) => {
        try {
          return { f: path.join(dir, n), m: fsImpl.statSync(path.join(dir, n)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((x, y) => y.m - x.m)
      .map((x) => x.f);
  } catch {
    siblings = [];
  }
  const files = [transcriptPath, ...siblings].slice(0, maxFiles);
  for (const f of files) {
    if (out.scanned_bytes >= maxBytes) {
      out.skipped = `stopped at the ${maxBytes} B scan budget`;
      break;
    }
    const r = scanTranscriptForOwner(f, objective, keys, maxBytes - out.scanned_bytes, fsImpl);
    out.scanned_files++;
    out.scanned_bytes += r.bytes;
    if (r.found) return { ...out, found: true, file: f };
  }
  if (files.length < 1 + siblings.length && !out.skipped) out.skipped = `${1 + siblings.length - files.length} older transcript(s) beyond the ${maxFiles}-file bound`;
  return out;
}

/** Marker the fragment section carries, so a re-render recognises its own output. */
export function fragmentMarker(sha256) {
  return `<!-- handover-render seed_sha256=${sha256} -->`;
}

function dataFence(text) {
  return "`".repeat(Math.max(4, ...[...String(text).matchAll(/`+/g)].map(m => m[0].length + 1)));
}
function markdownData(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/([`*_{}\[\]()<>#!|=~&])/g, "\\$1");
}

function sha256Of(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** A level-2 heading whose first word (after any emoji markers) is CURRENT. */
const CURRENT_HEADING_RE = /^(##[ \t]+(?:[^\sA-Za-z0-9]+[ \t]+)?)CURRENT\b/;

/**
 * Lines of `text` that sit OUTSIDE fenced code blocks (fence char + length
 * tracked, so an outer ```` contains an inner ```).
 */
function unfencedLineFlags(lines) {
  const flags = new Array(lines.length).fill(true);
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (open) {
      flags[i] = false;
      if (m && m[1][0] === open.char && m[1].length >= open.len) open = null;
      continue;
    }
    if (m) {
      open = { char: m[1][0], len: m[1].length };
      flags[i] = false;
    }
  }
  return flags;
}

/** The `## CURRENT` section the fragment receives — the seed, verbatim, fenced. */
export function renderFragmentSection({ seedText, validation, seedPath, stampIso: stamped }) {
  const h = validation.header;
  const mission = (validation.sections.MISSION && validation.sections.MISSION.inline) || "";
  return [
    `## ⭐⭐ CURRENT — ${stamped || h.written} — cycle handover seed ${validation.sha256.slice(0, 8)} (resume ${h.resume_token})`,
    "",
    fragmentMarker(validation.sha256),
    "",
    `Rendered by \`.claude/bin/handover-render.mjs\` from the session seed (${validation.bytes} B, sha256 \`${validation.sha256}\`${seedPath ? `, \`${seedPath}\`` : ""}). The seed below IS the current state; sections further down are HISTORY.`,
    "",
    `MISSION: ${markdownData(mission)}`,
    "",
    dataFence(seedText) + "text",
    seedText.replace(/\r\n?/g, "\n").replace(/\n+$/, ""),
    dataFence(seedText),
    "",
  ].join("\n");
}

/**
 * Insert `section` as the fragment's CURRENT section.
 *
 * - Every existing level-2 CURRENT heading OUTSIDE a fence is demoted to HISTORY
 *   by rewriting that one word; no other byte of the fragment changes.
 * - The section is inserted before the first level-2 heading outside a fence
 *   (after the comment preamble and frontmatter), or appended when there is none.
 * - When the fragment already carries this seed's marker, nothing changes.
 *
 * @returns {{text:string, changed:boolean, alreadyPresent:boolean, demoted:number[]}}
 */
export function spliceFragment(fragmentText, section, sha256) {
  const src = fragmentText.replace(/\r\n?/g, "\n");
  if (src.includes(fragmentMarker(sha256))) {
    return { text: fragmentText, changed: false, alreadyPresent: true, demoted: [] };
  }
  const lines = src.split("\n");
  const outside = unfencedLineFlags(lines);
  const demoted = [];
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!outside[i]) continue;
    if (/^##[ \t]/.test(lines[i]) && insertAt < 0) insertAt = i;
    if (CURRENT_HEADING_RE.test(lines[i])) {
      lines[i] = lines[i].replace(CURRENT_HEADING_RE, "$1HISTORY");
      demoted.push(i + 1);
    }
  }
  const block = section.replace(/\n+$/, "").split("\n").concat([""]);
  if (insertAt < 0) {
    const head = lines.slice();
    while (head.length && head[head.length - 1] === "") head.pop();
    return { text: head.concat(head.length ? [""] : [], block).join("\n"), changed: true, alreadyPresent: false, demoted };
  }
  lines.splice(insertAt, 0, ...block);
  return { text: lines.join("\n"), changed: true, alreadyPresent: false, demoted };
}

/** A `key=value` cell of the seed's ROLE line (e.g. `trunk`, `repo`). */
export function roleField(validation, key) {
  const role = (validation.sections.ROLE && validation.sections.ROLE.inline) || "";
  for (const cell of role.split(/\s\|\s/)) {
    const m = /^\s*([a-z][a-z-]*)=(.*)$/i.exec(cell);
    if (m && m[1].toLowerCase() === key) return m[2].trim();
  }
  return null;
}

function sectionRows(v, label) {
  const s = v.sections[label];
  if (!s) return [];
  const rows = s.inline ? [s.inline, ...s.rows] : s.rows;
  return rows.filter((r) => r.trim() !== "");
}

function bulletList(rows, empty) {
  if (!rows.length || (rows.length === 1 && /^\s*(?:[-*•]\s+)?\(?none\)?\.?\s*$/i.test(rows[0]))) return [`- ${empty}`];
  return rows.map((r) => `- ${markdownData(r.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, ""))}`);
}

/**
 * Render the vault PAIR for cycle mode (CYCLE.md §2.3). Pure: identity strings
 * come from the `plan` the vault tool derived (never re-derived here), content
 * from the seed and the other projections' outcomes.
 *
 * @returns {{sweep:string, wrapup:string}}
 */
export function renderVaultPair({ plan, validation, seedText, repoName, trunk, priorProjections, stampIso: stamped }) {
  const sha8 = validation.sha256.slice(0, 8);
  const mission = (validation.sections.MISSION && validation.sections.MISSION.inline) || "";
  const next = (validation.sections.NEXT && validation.sections.NEXT.inline) || "";
  const title = `cycle handover ${sha8} — ${mission}`.slice(0, 160);
  const seedFence = dataFence(seedText);
  const fmFor = (kind) => {
    const f = plan.files[kind].frontmatter;
    return [
      "---",
      `date: ${f.date}`,
      `seq: "${f.seq}"`,
      `kind: ${f.kind}`,
      `title: ${JSON.stringify(title)}`,
      `repo: ${repoName}`,
      `trunk: ${trunk}`,
      "tags: [handover, cycle-mode]",
      `pairs_with: "${f.pairs_with}"`,
      `seed_sha256: ${validation.sha256}`,
      "---",
      "",
    ];
  };

  const ev = priorProjections.events || {};
  const landed = (ev.appended || []).map((a) => `- ledger: \`${a.item_id}\` → \`${a.status}\` (record \`${a.id}\`)`);
  const failures = Object.entries(priorProjections)
    .filter(([, r]) => r && r.status === "failed")
    .map(([name, r]) => `- projection \`${name}\` FAILED this render: ${r.detail}`);

  const wrapup = fmFor("wrapup").concat([
    `# Wrapup — cycle handover ${sha8}`,
    "",
    `Mode: **cycle** — rendered by \`handover-render.mjs\` from the session seed (${validation.bytes} B, sha256 \`${validation.sha256}\`, resume token \`${validation.header.resume_token}\`, stamped ${stamped || validation.header.written}${stamped && stamped !== validation.header.written ? ` (seed declares ${validation.header.written})` : ""} at ${validation.header.at_tokens} tokens). No in-session narrative is authored in this mode; the seed below is the whole carried state.`,
    "",
    "## What landed",
    "",
    ...(landed.length ? landed : ["- no ledger events were appended by this render"]),
    "",
    "## Corrections made in-session",
    "",
    "Recorded as the seed's TRAPS plus any projection that failed during this render — not smoothed.",
    "",
    ...bulletList(sectionRows(validation, "TRAPS"), "seed TRAPS: none"),
    ...failures,
    "",
    "## Render receipt",
    "",
    ...Object.entries(priorProjections).map(([name, r]) => `- \`${name}\`: ${r.status} — ${r.detail}`),
    "- `vault`: this pair (verified by `vault-handover.mjs verify` after writing)",
    "",
    "## Standing state",
    "",
    `- ROLE: ${markdownData((validation.sections.ROLE && validation.sections.ROLE.inline) || "")}`,
    `- STANDING: ${markdownData((validation.sections.STANDING && validation.sections.STANDING.inline) || "")}`,
    `- MISSION: ${markdownData(mission)}`,
    "",
    "## Hazards",
    "",
    ...bulletList(sectionRows(validation, "PENDING DECISIONS"), "no pending decisions"),
    "",
    "## Unfinished work",
    "",
    ...bulletList(sectionRows(validation, "IN FLIGHT"), "nothing in flight"),
    `- QUEUED: ${markdownData((validation.sections.QUEUED && [validation.sections.QUEUED.inline, ...validation.sections.QUEUED.rows].filter(Boolean).join("; ")) || "none")}`,
    "",
    "## /clear seed",
    "",
    seedFence + "text",
    `Handover pair: ${plan.files.sweep.absolutePath} · ${plan.files.wrapup.absolutePath}`,
    seedText.replace(/\r\n?/g, "\n").replace(/\n+$/, ""),
    seedFence,
    "",
  ]);

  const sweep = fmFor("sweep").concat([
    `# Sweep — cycle-mode generated report ${sha8}`,
    "",
    "Mode: **cycle** — the GENERATED half of the management report (CYCLE.md §2.3; decision D1). The full `/sweep` judgment did NOT run this cycle; ETA in cycles and the deferred-quality backlog are not computed here and are owed to the next full `/sweep`.",
    "",
    "## Completion status — durable receipts",
    "",
    `- seed sha256 \`${validation.sha256}\` (${validation.bytes} B)`,
    ...(landed.length ? landed : ["- no ledger events appended by this render"]),
    ...bulletList(sectionRows(validation, "MECHANICAL"), "MECHANICAL: none"),
    "",
    "## Backlog — in flight",
    "",
    ...bulletList(sectionRows(validation, "IN FLIGHT"), "nothing in flight"),
    "",
    "## Owned by others",
    "",
    ...bulletList(sectionRows(validation, "OWNED BY OTHERS"), "nothing owned by others"),
    "",
    "## Decision points",
    "",
    ...bulletList(sectionRows(validation, "PENDING DECISIONS"), "no pending decisions"),
    "",
    "## Prioritized queue",
    "",
    `1. NEXT: ${markdownData(next)}`,
    `2. QUEUED: ${markdownData((validation.sections.QUEUED && [validation.sections.QUEUED.inline, ...validation.sections.QUEUED.rows].filter(Boolean).join("; ")) || "none")}`,
    "",
    "## Closing recommendation",
    "",
    `Execute NEXT after its re-validation: ${markdownData(next)}`,
    "",
  ]);

  return { sweep: sweep.join("\n"), wrapup: wrapup.join("\n") };
}

/** tmp + rename in the target's own directory, so a reader never sees half a file. */
export function writeFileAtomic(target, text) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, text, { flag: "wx" });
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the tmp is ours and already failed to land; the rename error is what is reported */
    }
    throw e;
  }
}

const res = (status, detail, extra) => Object.assign({ status, detail }, extra || {});

// ── fragment ────────────────────────────────────────────────────────────────
function projectFragment(ctx, deps) {
  let target = ctx.fragmentPath || null;
  if (!target) {
    let identity = null;
    try {
      identity = deps.resolveIdentity(ctx.repoRoot);
    } catch (e) {
      return res("failed", `identity resolution threw: ${e.message}`);
    }
    target = identity ? deps.fragmentPathFor(ctx.repoRoot, identity) : null;
    if (!target) return res("failed", "no operator identity resolved, so the fragment path cannot be derived (pass --fragment <path>)");
  }
  if (!fs.existsSync(target)) {
    return res("skipped", `no fragment at ${target}; the cycle renders INTO an existing fragment and does not create one (/reconcile-notes owns creation)`, { path: target });
  }
  try {
    const before = fs.readFileSync(target, "utf8");
    const section = renderFragmentSection(ctx);
    const out = spliceFragment(before, section, ctx.validation.sha256);
    if (!out.changed) return res("ok", `unchanged — ${target} already carries this seed's CURRENT section`, { path: target, unchanged: true });
    writeFileAtomic(target, out.text);
    return res("ok", `wrote CURRENT section into ${target}; demoted ${out.demoted.length} prior CURRENT heading(s) to HISTORY`, { path: target, demoted: out.demoted });
  } catch (e) {
    return res("failed", `fragment write failed: ${e.message}`, { path: target });
  }
}

// ── events ──────────────────────────────────────────────────────────────────
const EVENT_FIELDS = ["item_id", "item", "value_anchor", "status"];

export function parseEventsDeclaration(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `events file is not JSON: ${e.message}` };
  }
  if (!Array.isArray(data)) return { ok: false, reason: "events file must be a JSON array of {item_id, item, value_anchor, status}" };
  const bad = [];
  data.forEach((e, i) => {
    if (!e || typeof e !== "object") return bad.push(`entry ${i} is not an object`);
    for (const f of EVENT_FIELDS) {
      if (typeof e[f] !== "string" || e[f].trim() === "") bad.push(`entry ${i} lacks a non-empty string '${f}'`);
    }
    const extra = Object.keys(e).filter((k) => !EVENT_FIELDS.includes(k));
    if (extra.length) bad.push(`entry ${i} carries unsupported field(s) ${extra.join(", ")} — authority and source are set by the renderer`);
  });
  if (bad.length) return { ok: false, reason: bad.join("; ") };
  return { ok: true, events: data };
}

function projectEvents(ctx, deps) {
  if (!ctx.eventsFile) return res("skipped", "no ledger events declared for this cycle (pass --events <file> to record transitions)", { appended: [] });
  let decl;
  try {
    decl = parseEventsDeclaration(fs.readFileSync(ctx.eventsFile, "utf8"));
  } catch (e) {
    return res("failed", `events file unreadable: ${e.message}`, { appended: [] });
  }
  if (!decl.ok) return res("failed", `events declaration REFUSED, nothing appended: ${decl.reason}`, { appended: [] });
  if (decl.events.length === 0) return res("skipped", "events file declares zero events", { appended: [] });

  let signing;
  try {
    signing = deps.resolveSigning(ctx.repoRoot);
  } catch (e) {
    signing = { why: `identity/key resolution threw: ${e.message}` };
  }
  if (!signing || !signing.identity) {
    return res("failed", `${decl.events.length} declared event(s) went UNRECORDED: ${(signing && signing.why) || "no signing identity"}`, { appended: [] });
  }

  let current = new Map();
  try {
    current = deps.foldProjection(deps.readEventsLog(ctx.repoRoot)).rows;
  } catch (e) {
    return res("failed", `event log unreadable, nothing appended (an unreadable log read as empty would re-append every transition): ${e.message}`, { appended: [] });
  }

  const appended = [];
  const already = [];
  const refused = [];
  for (const e of decl.events) {
    const row = current.get(e.item_id);
    if (row && row.status === e.status) {
      already.push(e.item_id);
      continue;
    }
    let r;
    try {
      r = deps.appendEvent(
        ctx.repoRoot,
        deps.buildEvent({ kind: "transition", item_id: e.item_id, item: e.item, value_anchor: e.value_anchor, status: e.status, authority: "agent", source: "handover-render" }),
        { identity: signing.identity, signOpts: signing.signOpts },
      );
    } catch (err) {
      r = { ok: false, reason: err.message };
    }
    if (r && r.ok) appended.push({ item_id: e.item_id, status: e.status, id: r.id });
    else refused.push(`${e.item_id} (${(r && (r.reason || r.error)) || "unknown"})`);
  }
  const parts = [`${appended.length} appended`, `${already.length} already held`];
  if (refused.length) parts.push(`${refused.length} REFUSED: ${refused.join("; ")}`);
  return res(refused.length ? "failed" : "ok", parts.join(", "), { appended, already, refused });
}

// ── forest ledger ───────────────────────────────────────────────────────────
function projectForestLedger(ctx, deps, events) {
  if (!events || !events.appended || events.appended.length === 0) {
    return res("skipped", "no events appended by this render, so the forest ledger projection is unchanged");
  }
  let r;
  try {
    r = deps.regenerateForestLedger(ctx.repoRoot);
  } catch (e) {
    return res("failed", `forest ledger regeneration threw: ${e.message}`);
  }
  if (!r || !r.ok) return res("failed", `forest ledger regeneration refused: ${(r && (r.reason || r.error)) || "unknown"}`);
  return res("ok", `forest ledger ${r.action || "regenerated"} (${r.rows} rows)`, { path: r.path });
}

// ── vault ───────────────────────────────────────────────────────────────────
function findRenderedPair(vaultDir, sha256) {
  for (const dir of [vaultDir, path.join(vaultDir, ARCHIVE_SUBDIR)]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/-wrapup\.md$/.test(n)) continue;
      let text;
      try {
        text = fs.readFileSync(path.join(dir, n), "utf8");
      } catch {
        continue;
      }
      if (parseFrontmatter(text).fields.seed_sha256 === sha256) return path.join(dir, n);
    }
  }
  return null;
}

function projectVault(ctx, deps, prior) {
  const r = resolveVaultDir({ flag: ctx.vaultFlag, env: ctx.env.COC_VAULT_HANDOVER_DIR, repoRoot: ctx.repoRoot });
  if (!r.ok) {
    if (r.kind === "unresolved") {
      return res("skipped", `no vault configured on this machine (${r.reason}${r.tried.length ? `; tried ${r.tried.join(", ")}` : ""}) — declared skip, not an error`);
    }
    return res("failed", r.reason);
  }
  const vaultDir = r.dir;
  const existing = findRenderedPair(vaultDir, ctx.validation.sha256);
  if (existing) return res("ok", `unchanged — this seed is already rendered as ${existing}`, { unchanged: true, wrapup: existing });

  const date = ctx.stampIso.slice(0, 10);
  const planRun = deps.runVaultCli(["plan", "--vault", vaultDir, "--date", date, "--json"]);
  if (!planRun || planRun.status !== 0) {
    return res("failed", `vault-handover plan exited ${planRun ? planRun.status : "?"}: ${((planRun && planRun.stderr) || "").trim().slice(0, 400)}`);
  }
  let plan;
  try {
    plan = JSON.parse(planRun.stdout);
  } catch (e) {
    return res("failed", `vault-handover plan --json printed unparseable output: ${e.message}`);
  }

  const rendered = renderVaultPair({
    plan,
    validation: ctx.validation,
    seedText: ctx.seedText,
    // The seed's own repo= names the REPO; a worktree's directory name does not.
    repoName: path.basename(roleField(ctx.validation, "repo") || ctx.repoRoot),
    trunk: ctx.trunk,
    priorProjections: prior,
    stampIso: ctx.stampIso,
  });
  const sweepPath = plan.files.sweep.absolutePath;
  const wrapupPath = plan.files.wrapup.absolutePath;
  try {
    fs.writeFileSync(sweepPath, rendered.sweep, { flag: "wx" });
  } catch (e) {
    return res("failed", `could not create ${sweepPath} (never overwritten): ${e.message}`);
  }
  try {
    fs.writeFileSync(wrapupPath, rendered.wrapup, { flag: "wx" });
  } catch (e) {
    // Never leave half a pair: the directive requires TWO files, never one.
    try {
      fs.unlinkSync(sweepPath);
    } catch {
      /* reported below: the pair state is named explicitly either way */
    }
    return res("failed", `could not create ${wrapupPath} (${e.message}); the sweep half was removed so no half-pair is left`);
  }

  const verifyRun = deps.runVaultCli(["verify", "--vault", vaultDir, "--json"]);
  let report;
  try {
    report = JSON.parse((verifyRun && verifyRun.stdout) || "");
  } catch {
    return res("failed", `pair written (${sweepPath}, ${wrapupPath}) but vault-handover verify produced no readable verdict (exit ${verifyRun ? verifyRun.status : "?"}): ${((verifyRun && verifyRun.stderr) || "").trim().slice(0, 400)}`, { sweep: sweepPath, wrapup: wrapupPath });
  }
  const stem = `${plan.date}-${plan.seq}`;
  const mine = (report.findings || []).filter((f) => String(f.file).startsWith(stem));
  const others = (report.findings || []).length - mine.length;
  if (mine.length) {
    return res("failed", `pair written but verify reds it: ${mine.map((f) => `[${f.code}] ${f.detail}`).join("; ")}`, { sweep: sweepPath, wrapup: wrapupPath });
  }
  return res(
    "ok",
    `wrote ${path.basename(sweepPath)} + ${path.basename(wrapupPath)} in ${vaultDir}; verify clean for this pair${others ? ` (${others} finding(s) on OTHER pairs, unchanged by this render — run vault-handover verify)` : ""}`,
    { sweep: sweepPath, wrapup: wrapupPath, other_findings: others },
  );
}

/**
 * STAMP a rendered handover into this terminal's `coc-context-state/v1` record —
 * the step without which `boundary.ready` can never become true (CYCLE.md §4.3;
 * S1's interface `hooks/lib/context-state.js::stampHandover`).
 *
 * "rendered" and "stamped" are DISTINCT outcomes (probe-driven-verification
 * MUST-7: "could not run" is not a verdict), so the result is exactly one of:
 *   not-attempted  the render FAILED — a failed handover is never stamped
 *   refused        code `no-config-dir`: CLAUDE_CONFIG_DIR is unset/empty, or
 *                  not an existing directory. The record's location is NEVER
 *                  guessed (the meter's learning-dir fallback is a hook-side
 *                  convenience; a boundary reader would not look there).
 *                  code `stamp-refused`: stampHandover refused — the seed
 *                  re-hashes differently, sits outside the handoff dir, is
 *                  misnamed or over the cap, or the record could not be written.
 *   stamped        the record now carries `handover.state` = the receipt's.
 *
 * @param {object} ctx  {receipt, repoRoot, env, pid}
 * @param {object} deps {stampHandover, resolveHandoffDir, locateState?}
 */
export function stampRenderedHandover(ctx, deps) {
  const { receipt, repoRoot, env, pid } = ctx;
  if (!receipt || !receipt.ok) {
    return { status: "not-attempted", code: "render-failed", detail: "the render failed, so the handover is not stamped (a failed handover never arms a boundary)" };
  }
  const configDir = env && typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR : "";
  if (!configDir) {
    return { status: "refused", code: "no-config-dir", detail: "CLAUDE_CONFIG_DIR is unset — this terminal's context-state record cannot be located, and its path is never guessed" };
  }
  let isDir = false;
  try {
    isDir = fs.statSync(configDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return { status: "refused", code: "no-config-dir", detail: `CLAUDE_CONFIG_DIR (${configDir}) is not an existing directory — the context-state record is never written to a guessed fallback` };
  }
  const where = { configDir, repoDir: repoRoot, pid };
  let r;
  try {
    r = deps.stampHandover(where, receipt.handover, { dirInfo: deps.resolveHandoffDir(repoRoot) });
  } catch (e) {
    r = { ok: false, reason: `stampHandover threw: ${e.message}` };
  }
  if (!r || r.ok !== true) {
    return { status: "refused", code: r && r.code === "tail-after-seed" ? "tail-after-seed" : "stamp-refused", detail: `context-state stamp REFUSED: ${(r && r.reason) || "no reason given"}` };
  }
  let file = null;
  try {
    const loc = deps.locateState ? deps.locateState(where) : null;
    file = loc && loc.ok ? loc.file : null;
  } catch {
    file = null;
  }
  // The tail-loss fence (M6e) and the declared-handover state (M6/H2) are reported, never
  // swallowed: an UNVERIFIED fence means this handover can never read ready; a declared
  // state that failed to write means no watcher can see a stall.
  const tail = r.tail ? (r.tail.ok ? "armed" : `${r.tail.code}: ${r.tail.reason}`) : "not evaluated";
  const declared = r.declared ? (r.declared.ok ? `written ${r.declared.path}` : `FAILED ${r.declared.reason}`) : "not written";
  return {
    status: "stamped",
    code: "stamped",
    detail: `handover.state=${receipt.handover.state} stamped (seq ${r.seq})${file ? ` in ${file}` : ""}; tail fence ${tail}; declared state ${declared}`,
    seq: r.seq,
    file,
    tail_fence: r.tail || null,
    declared: r.declared || null,
  };
}

/**
 * Run every projection for an ACCEPTED seed.
 *
 * @param {object} ctx  {seedPath, seedBuf, seedText, validation, repoRoot, trunk,
 *                       fragmentPath?, eventsFile?, vaultFlag?, env}
 * @param {object} deps {resolveIdentity, fragmentPathFor, resolveSigning,
 *                       readEventsLog, foldProjection, buildEvent, appendEvent,
 *                       regenerateForestLedger, runVaultCli, readFile}
 * @returns the receipt; `ok` is false when ANY projection failed or the seed moved.
 */
export function renderProjections(ctx, deps) {
  if (!ctx.validation || !ctx.validation.ok) {
    throw new Error("renderProjections: called with a seed the validator did not accept — an invalid seed is never projected");
  }
  const bound = stateLib.validateRenderedSeed(
    { configDir: ctx.env && ctx.env.CLAUDE_CONFIG_DIR, repoDir: ctx.repoRoot || process.cwd(), pid: ctx.pid || process.ppid },
    { state: "written", seed_path: ctx.seedPath, seed_sha256: ctx.validation.sha256, resume_token: ctx.validation.header.resume_token },
    { dirInfo: handoffLib.resolveHandoffDir(ctx.repoRoot || process.cwd()) },
  );
  if (!bound.ok) {
    return { schema: RENDER_SCHEMA, ok: false, preflight: { ok: false, reason: bound.reason },
      handover: { state: "failed", errors: [`seed preflight refused: ${bound.reason}`] }, projections: {}, warnings: ctx.validation.warnings || [] };
  }
  const stampMs = Number.isFinite(ctx.stampMs) ? ctx.stampMs : typeof deps.now === "function" ? deps.now() : Date.now();
  ctx = { ...ctx, seedPath: bound.read.path, seedText: bound.read.text, seedBuf: Buffer.from(bound.read.text), stampMs, stampIso: stampIso(stampMs) };
  const projections = {};
  const run = (name, fn) => {
    try {
      projections[name] = fn();
    } catch (e) {
      projections[name] = res("failed", `projection threw: ${e.message}`);
    }
  };
  run("fragment", () => projectFragment(ctx, deps));
  run("events", () => projectEvents(ctx, deps));
  run("forest-ledger", () => projectForestLedger(ctx, deps, projections.events));
  run("vault", () => projectVault(ctx, deps, { ...projections }));

  const errors = Object.entries(projections)
    .filter(([, p]) => p.status === "failed")
    .map(([n, p]) => `${n}: ${p.detail}`);

  // Invariant 3: the bytes projected are the bytes that were validated.
  if (ctx.seedPath) {
    let now = null;
    try {
      now = sha256Of((deps.readFile || fs.readFileSync)(ctx.seedPath));
    } catch (e) {
      errors.push(`seed: could not re-read ${ctx.seedPath} after rendering (${e.message})`);
    }
    if (now && now !== ctx.validation.sha256) {
      errors.push(`seed-changed-during-render: ${ctx.seedPath} now hashes ${now.slice(0, 8)}, the projected bytes hashed ${ctx.validation.sha256.slice(0, 8)}`);
    }
  }

  const v = ctx.validation;
  return {
    schema: RENDER_SCHEMA,
    ok: errors.length === 0,
    // Shaped as CYCLE.md §4.3 `handover`, so the context-state writer copies it
    // rather than re-deriving any of it.
    handover: {
      state: errors.length === 0 ? "written" : "failed",
      seed_path: ctx.seedPath || null,
      seed_sha256: v.sha256,
      session_id: bound.session_id,
      seed_bytes: v.bytes,
      resume_token: v.header.resume_token,
      at_tokens: v.header.at_tokens,
      // The TOOL's stamp, never the seed's hand-typed written= (invariant 6).
      written_at: ctx.stampIso,
      declared_written: v.header.written || null,
      projections: Object.fromEntries(Object.entries(projections).map(([n, p]) => [n, p.status])),
      errors,
    },
    projections,
    warnings: v.warnings,
  };
}
