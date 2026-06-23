/**
 * journal-reserve — slot reservation for multi-operator journal numbering.
 *
 * Shard M6 D (workspaces/multi-operator-coc, design v11 §5.2).
 *
 * Single-writer artifact contention: under N concurrent operators,
 * `journal/NNNN-TYPE-slug.md` numbering silently collides — two operators
 * each scanning `ls journal/` reach the same next-number and clobber each
 * other on write. The structural fix moves the high-water-mark read from
 * the filesystem (race) to the fold-accepted coordination log (totally
 * ordered per-emitter chain): the slot reservation is a record-typed
 * append whose `seq` defines the slot, and the file name carries the
 * operator's `display_id` so two reservations on the same `seq` (e.g.,
 * during a partial-push window) remain distinguishable on disk.
 *
 * Contract:
 *   reserveJournalSlot(dir, opts) → {
 *     slot: NNNN,                      // 4-digit, zero-padded
 *     filename: "NNNN-<display_id>-TYPE-slug.md",
 *     verified_id: <emitter>,          // frontmatter authority field
 *     person_id: <emitter>,
 *     display_id: <emitter>,
 *     type: <UPPER>,
 *     topic: <slug>,
 *   }
 *
 * The returned slot is the high-water + 1 of the journal dir AT
 * RESERVATION TIME — the caller MUST not assume monotonicity across
 * concurrent reserves; under N concurrent ops the disk may receive
 * NNNN-alice-DECISION-foo.md AND NNNN-bob-DISCOVERY-bar.md with the
 * SAME NNNN, distinguishable by display_id. This is by design: the
 * fold rules + per-row owner: attribution (see §5.1) resolve collisions
 * at fold time; the filename is human-readable, not authoritative.
 *
 * The `verified_id` in the returned object is authoritative for the
 * frontmatter the caller writes — that field, not the filename, is
 * what attribution scans grep on.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// FSUB (2026-06-11): signed-emission dependencies are lazy-required inside
// reserveJournalSlotSigned so the pure reserveJournalSlot path keeps its
// zero-dep cost for callers that only need the computation (tests, dry
// runs). The signed path is the one the /journal command mandates.

const VALID_TYPES = new Set([
  "DECISION",
  "DISCOVERY",
  "TRADE-OFF",
  "RISK",
  "CONNECTION",
  "GAP",
  "AMENDMENT",
]);

// Match the canonical journal command's filename regex: NNNN- (4 digits),
// then anything up to .md. We also support the new shape
// NNNN-<display_id>-TYPE-slug.md and tolerate the legacy NNNN-TYPE-slug.md.
const SLOT_RE = /^(\d{4})-/;

function _slugify(s) {
  return (
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}

function _scanHighWater(dir) {
  // Read the journal dir; the high-water is the max NNNN prefix observed.
  // Missing dir → 0 (no entries yet). Caller is responsible for creating
  // the dir before writing a new entry; this function does NOT create it.
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return 0;
    throw err;
  }
  let high = 0;
  for (const name of entries) {
    const m = name.match(SLOT_RE);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n)) continue;
    if (n > high) high = n;
  }
  return high;
}

/**
 * Reserve the next journal slot.
 *
 * @param {string} dir - absolute path to the journal directory (the
 *   slot is computed from this directory's high-water).
 * @param {object} opts
 * @param {{verified_id:string, person_id:string, display_id:string}} opts.identity
 *   REQUIRED. The display_id is consumed in the filename; verified_id
 *   is what the caller will write to frontmatter as authoritative.
 * @param {string} opts.type - one of DECISION/DISCOVERY/TRADE-OFF/RISK/
 *   CONNECTION/GAP/AMENDMENT (the canonical journal TYPE set, per
 *   rules/journal.md Entry Types).
 * @param {string} opts.topic - human-readable topic; slugified.
 * @returns {{
 *   slot: string,            // "NNNN" zero-padded
 *   slot_num: number,        // integer slot
 *   filename: string,        // "NNNN-<display_id>-TYPE-slug.md"
 *   verified_id: string,
 *   person_id: string,
 *   display_id: string,
 *   type: string,
 *   topic: string,
 *   slug: string,
 * }}
 *
 * Throws on missing identity / bad type — same shape as
 * `zero-tolerance.md` Rule 3a typed-delegate-guard pattern.
 */
function reserveJournalSlot(dir, opts) {
  if (!dir || typeof dir !== "string") {
    throw new Error("reserveJournalSlot: dir must be a non-empty string");
  }
  const o = opts || {};
  const identity = o.identity;
  if (
    !identity ||
    typeof identity.verified_id !== "string" ||
    !identity.verified_id ||
    typeof identity.person_id !== "string" ||
    !identity.person_id ||
    typeof identity.display_id !== "string" ||
    !identity.display_id
  ) {
    throw new Error(
      "reserveJournalSlot: opts.identity must carry non-empty verified_id, person_id, display_id",
    );
  }
  if (typeof o.type !== "string" || !VALID_TYPES.has(o.type.toUpperCase())) {
    throw new Error(
      `reserveJournalSlot: opts.type must be one of ${Array.from(
        VALID_TYPES,
      ).join("/")}; got ${JSON.stringify(o.type)}`,
    );
  }
  if (typeof o.topic !== "string" || !o.topic.trim()) {
    throw new Error(
      "reserveJournalSlot: opts.topic must be a non-empty string",
    );
  }

  const high = _scanHighWater(dir);
  const slotNum = high + 1;
  const slot = String(slotNum).padStart(4, "0");
  const type = o.type.toUpperCase();
  const slug = _slugify(o.topic);
  // display_id is slugified separately so embedded spaces / punctuation
  // do not break the filename grep surface (TYPE token sits in a stable
  // position regardless of display_id shape).
  const displaySlug = _slugify(identity.display_id);
  const filename = `${slot}-${displaySlug}-${type}-${slug}.md`;

  return {
    slot,
    slot_num: slotNum,
    filename,
    verified_id: identity.verified_id,
    person_id: identity.person_id,
    display_id: identity.display_id,
    type,
    topic: o.topic,
    slug,
  };
}

/**
 * Scan the fold-accepted coordination log for journal-slot-reservation
 * records targeting `dirRel` and return the highest reserved slot number
 * (0 when none). This is the FOLD half of the high-water computation —
 * a sibling operator may have reserved a slot whose file has not landed
 * on this clone's disk yet (partial-push window), so the disk scan alone
 * under-counts. Per knowledge-convergence.md MUST-2 the fold-accepted
 * log is the authoritative ordering surface.
 *
 * Read errors REFUSE (throw) rather than silently returning 0 — a 0 on
 * an unreadable log would hand out an already-reserved slot.
 */
function _foldHighWater(repoDir, dirRel) {
  const { resolveLogPath } = require("./state-io.js");
  const coordinationLog = require("./coordination-log.js");

  const logPath = resolveLogPath(repoDir);
  let raw;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return 0;
    throw err;
  }
  const records = raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && typeof r === "object");
  if (records.length === 0) return 0;

  let roster = null;
  try {
    const rosterPath = path.join(repoDir, ".claude", "operators.roster.json");
    if (fs.existsSync(rosterPath)) {
      roster = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
    }
  } catch {
    roster = null;
  }

  // skipSignatureVerify: the journal-slot HIGH-WATER needs only chain
  // STRUCTURE (which slots are taken), not crypto validity — same O(N)-gpg-
  // verify-per-emit fix as coc-emit.js::_defaultReadChainHead (see its NOTE
  // for the fail-closed proof: a forged-sig reservation at slot N is counted →
  // we advance PAST it, never reuse N). Read-time folds (journal-write-guard)
  // still verify. Without this, reserveJournalSlotSigned re-verified the whole
  // chain (~710ms/record × N) on every reservation — the second half of the
  // signing hang (the first was the chain-head read in coc-emit).
  const folded = coordinationLog.foldLog(records, roster, {
    skipSignatureVerify: true,
  });
  const accepted =
    process.env.COC_TEST_SKIP_SIGN === "1"
      ? records
      : (folded && folded.accepted) || [];
  let high = 0;
  for (const rec of accepted) {
    if (!rec || rec.type !== "journal-slot-reservation") continue;
    const c = rec.content || {};
    if (c.dir !== dirRel) continue;
    const n = parseInt(c.slot, 10);
    if (Number.isFinite(n) && n > high) high = n;
  }
  return high;
}

/**
 * Reserve the next journal slot AND emit the signed
 * `journal-slot-reservation` coordination-log record that
 * journal-write-guard.js folds for its slot-reserved check.
 *
 * This is the FSUB wiring (knowledge-convergence.md MUST-2): the pure
 * reserveJournalSlot computes a slot from the filesystem only and emits
 * nothing, so every subsequent journal Write halt-and-reports "slot
 * unreserved in fold". This variant:
 *
 *   1. Computes slot = max(disk high-water, fold-accepted reservation
 *      high-water for the same dir) + 1 — the fold half covers the
 *      partial-push window where a sibling reserved a slot whose file
 *      has not landed on this clone yet.
 *   2. Emits the signed record {type: "journal-slot-reservation",
 *      content: {slot, dir, filename}} via coc-emit.js (per-emitter
 *      chained seq/prev_hash, canonical-bytes signature, 2KB-capped
 *      append).
 *
 * @param {string} repoDir - absolute MAIN-checkout repo root (callers
 *   inside worktrees resolve via state-resolver first — the log + the
 *   guard's fold both live at the main checkout).
 * @param {object} opts
 * @param {string} [opts.dir="journal"] - REPO-RELATIVE journal directory
 *   ("journal", "workspaces/<name>/journal", or the /.pending variant).
 *   MUST match the dir token journal-write-guard.js derives from the
 *   Write path, byte-for-byte — the guard's reservation match is
 *   content.dir === <derived dir>.
 * @param {{verified_id, person_id, display_id}} [opts.identity] -
 *   defaults to operator-id.js::resolveIdentity(repoDir).
 * @param {string} opts.type / opts.topic - as reserveJournalSlot.
 * @param {string} [opts.signingKeyPath] / {function} [opts.sign] /
 *   {function} [opts.readChainHead] / {function} [opts.append] -
 *   forwarded to coc-emit.js (test injection).
 * @returns {{ok: true, reservation: object, record: object} |
 *           {ok: false, error: string, reason: string, step: string,
 *            reservation?: object}}
 *   On emission failure the computed reservation is attached so the
 *   caller can surface BOTH the slot it would have taken AND why the
 *   reservation did not land (the guard will halt the Write either way).
 */
function reserveJournalSlotSigned(repoDir, opts) {
  if (!repoDir || typeof repoDir !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "repoDir must be a non-empty string",
      step: "args",
    };
  }
  const o = opts || {};
  const dirRel =
    typeof o.dir === "string" && o.dir.trim() ? o.dir.trim() : "journal";

  // Resolve identity up front — the filename embeds display_id and the
  // emitter stamps verified_id/person_id.
  let identity = o.identity;
  if (!identity) {
    const { resolveIdentity } = require("./operator-id.js");
    identity = resolveIdentity(repoDir, {});
  }

  // Fold high-water FIRST (it can refuse); then compute the reservation
  // off max(disk, fold). reserveJournalSlot re-validates identity/type/
  // topic with its typed throws — convert to the typed-result shape.
  let foldHigh;
  try {
    foldHigh = _foldHighWater(repoDir, dirRel);
  } catch (err) {
    return {
      ok: false,
      error: "fold high-water read failed",
      reason: `coordination log unreadable; refusing to hand out a possibly-reserved slot: ${err && err.message ? err.message : String(err)}`,
      step: "fold-high-water",
    };
  }

  const absDir = path.join(repoDir, dirRel);
  let reservation;
  try {
    reservation = reserveJournalSlot(absDir, {
      identity,
      type: o.type,
      topic: o.topic,
    });
  } catch (err) {
    return {
      ok: false,
      error: "reservation invalid",
      reason: err && err.message ? err.message : String(err),
      step: "reserve",
    };
  }

  if (foldHigh >= reservation.slot_num) {
    // A fold-accepted reservation outranks the disk scan — rebuild the
    // reservation at fold-high + 1 (same identity/type/topic).
    const slotNum = foldHigh + 1;
    const slot = String(slotNum).padStart(4, "0");
    const displaySlug = _slugify(identity.display_id);
    reservation = Object.assign({}, reservation, {
      slot,
      slot_num: slotNum,
      filename: `${slot}-${displaySlug}-${reservation.type}-${reservation.slug}.md`,
    });
  }

  const { emitSignedRecord } = require("./coc-emit.js");
  const emitOpts = {
    repoDir,
    type: "journal-slot-reservation",
    content: {
      slot: reservation.slot,
      dir: dirRel,
      filename: reservation.filename,
    },
    identity,
    signingKeyPath: o.signingKeyPath,
    keyType: o.keyType,
    sign: o.sign,
    readChainHead: o.readChainHead,
    append: o.append,
  };
  if (Object.prototype.hasOwnProperty.call(o, "gitConfigSigningKey")) {
    emitOpts.gitConfigSigningKey = o.gitConfigSigningKey;
  }
  const emitResult = emitSignedRecord(emitOpts);
  if (!emitResult.ok) {
    return {
      ok: false,
      error: emitResult.error,
      reason: emitResult.reason,
      step: `emit:${emitResult.step}`,
      reservation,
    };
  }

  return { ok: true, reservation, record: emitResult.record };
}

module.exports = {
  reserveJournalSlot,
  reserveJournalSlotSigned,
  VALID_TYPES,
};
