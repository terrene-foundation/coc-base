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

const VALID_TYPES = new Set([
  "DECISION",
  "DISCOVERY",
  "TRADE-OFF",
  "RISK",
  "CONNECTION",
  "GAP",
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
 *   CONNECTION/GAP (the canonical journal TYPE set).
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

module.exports = {
  reserveJournalSlot,
  VALID_TYPES,
};
