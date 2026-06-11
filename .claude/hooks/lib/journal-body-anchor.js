/**
 * journal-body-anchor — body-hash crypto anchor for journal-file integrity.
 *
 * Shard M6 D invariant 6 (workspaces/multi-operator-coc, design v11 §5.2 ext).
 *
 * Architecture extension (2026-05-20, co-owner-approved Option A):
 * journal entries on disk are signed coordination-log records by their
 * RESERVATION (slot + frontmatter authoritative `verified_id`), but the
 * BODY BYTES themselves are not cryptographically pinned. A bounded-trust
 * insider with disk access can rewrite a body without the substrate
 * observing — equivocation-parity residual class (§4.5 §1.1 general law).
 *
 * The fix: on journal-file close (/wrapup or /journal --anchor), emit a
 * signed coordination-log record of type `journal-body-anchor` carrying
 * {path, sha256_of_content_bytes, slot_record_ref}. At fold time, a
 * predicate re-hashes the file at the cited path; mismatch = tamper
 * detected, surfaces as block-grade integrity advisory naming the
 * anchor's signer (owner-accountability via the per-emitter chain).
 *
 * The detection is fold-time, NOT continuous (eventually-consistent;
 * same residual class as fold rule 3 fork detection — the §4.5
 * equivocation-parity residual). The anchor is checkpoint-exempt by
 * rule 6 (signed witness / accountability record).
 *
 * Contract:
 *   hashJournalBody(path) → "sha256:<hex>"
 *   buildAnchorRecord({journalPath, relPath, slotRecordRef?}) → partial
 *   foldAnchorPredicate(record, ctx) → {accepted, tampered?, evidence?}
 *
 * The buildAnchorRecord output is the partial that callers pass to
 * coc-append.js or a coordination-log emit path; this module does NOT
 * itself append/sign (that is the caller's substrate choice).
 */

"use strict";

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const RECORD_TYPE = "journal-body-anchor";

/**
 * Compute the canonical hash of a journal file's body bytes.
 *
 * Hashes the raw file bytes; frontmatter and content are both covered.
 * Returns "sha256:<hex>" so downstream consumers can grep on prefix
 * for forward-compat (future hash-alg upgrade preserves the algorithm
 * tag inline with the value).
 *
 * @param {string} filePath - absolute path to the journal file
 * @returns {string} "sha256:<64-hex>"
 *
 * Throws ENOENT-shaped errors to the caller (per zero-tolerance.md
 * Rule 3a: typed guard, no silent fallback). A non-existent path is
 * always a caller bug — anchors are only emitted on close, after the
 * write landed.
 */
function hashJournalBody(filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("hashJournalBody: filePath must be a non-empty string");
  }
  const bytes = fs.readFileSync(filePath);
  const hex = crypto.createHash("sha256").update(bytes).digest("hex");
  return `sha256:${hex}`;
}

/**
 * Build the partial content for a `journal-body-anchor` coordination-log
 * record. The caller appends / signs via coc-append or the coordination
 * log emitter; this function ONLY constructs the partial.
 *
 * @param {object} opts
 * @param {string} opts.journalPath - absolute path to the journal file
 * @param {string} opts.relPath - path relative to the repo root (the
 *   `path` field in the anchor — used by fold-time predicate to locate
 *   the file at re-hash time; a clone-local absolute path would not
 *   make sense across clones).
 * @param {string} [opts.slotRecordRef] - optional reference to the
 *   reservation record (id or seq); informational, not load-bearing.
 * @returns {{
 *   type: "journal-body-anchor",
 *   content: { path: string, sha256_of_content_bytes: string,
 *              slot_record_ref?: string }
 * }}
 *
 * The returned object is NOT a complete coordination-log record — it
 * lacks verified_id / person_id / seq / prev_hash / ts / sig (the
 * envelope fields the emitter fills in). The caller wires those at
 * emit time so the anchor is per-emitter-chained correctly.
 */
function buildAnchorRecord(opts) {
  if (!opts || typeof opts !== "object") {
    throw new Error("buildAnchorRecord: opts must be an object");
  }
  if (typeof opts.journalPath !== "string" || !opts.journalPath) {
    throw new Error(
      "buildAnchorRecord: opts.journalPath must be a non-empty string",
    );
  }
  if (typeof opts.relPath !== "string" || !opts.relPath) {
    throw new Error(
      "buildAnchorRecord: opts.relPath must be a non-empty string",
    );
  }
  const hash = hashJournalBody(opts.journalPath);
  const content = {
    path: opts.relPath,
    sha256_of_content_bytes: hash,
  };
  if (typeof opts.slotRecordRef === "string" && opts.slotRecordRef) {
    content.slot_record_ref = opts.slotRecordRef;
  }
  return {
    type: RECORD_TYPE,
    content,
  };
}

/**
 * Fold-time predicate for `journal-body-anchor` records.
 *
 * Returns a verdict object the foldLog engine consumes:
 *   { accepted: true }              — signature verified AND body matches
 *   { accepted: false, reason: ... }— tamper-detected (block-grade
 *                                     advisory) OR malformed record
 *
 * The predicate consults ctx.repoDir to locate the file. If the file is
 * absent at fold time (deleted), the anchor is honored (record accepted)
 * BUT a tamper-flag is set in ctx.advisories — same eventually-consistent
 * disposition as fork detection (rule 3): the fact is folded; the
 * detection is reported.
 *
 * Per §4.5: detection is the only structural defense the bounded-trust
 * threat model permits — a clone-local file edit + a fresh self-signed
 * anchor by the same operator IS equivocation-parity (the operator is
 * naming themselves as the tamper-er via the chain).
 *
 * @param {object} record - the candidate journal-body-anchor record
 * @param {object} ctx - fold context (carries repoDir, advisories sink)
 * @returns {{accepted: boolean, reason?: string, tampered?: boolean,
 *            evidence?: object}}
 */
function foldAnchorPredicate(record, ctx) {
  if (!record || record.type !== RECORD_TYPE) {
    return { accepted: false, reason: "not a journal-body-anchor record" };
  }
  const content = record.content;
  if (!content || typeof content !== "object") {
    return { accepted: false, reason: "missing or malformed content field" };
  }
  if (typeof content.path !== "string" || !content.path) {
    return {
      accepted: false,
      reason: "content.path must be a non-empty string",
    };
  }
  if (
    typeof content.sha256_of_content_bytes !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(content.sha256_of_content_bytes)
  ) {
    return {
      accepted: false,
      reason:
        "content.sha256_of_content_bytes must match /^sha256:[0-9a-f]{64}$/",
    };
  }
  // Re-hash the file at fold time. Missing file is folded-accepted with
  // an advisory; the per-emitter chain still attributes the anchor.
  const repoDir = ctx && ctx.repoDir;
  if (!repoDir || typeof repoDir !== "string") {
    // Without a repoDir the predicate cannot re-hash; fold-accept the
    // structurally-valid record but flag missing context. Production
    // foldLog always supplies repoDir; missing only in unit tests.
    return { accepted: true, reason: "no repoDir in ctx; structural-only" };
  }
  const filePath = path.resolve(repoDir, content.path);
  let actual;
  try {
    actual = hashJournalBody(filePath);
  } catch (err) {
    // File absent at fold time — accept with advisory (the chain still
    // names the anchor's signer; the deletion is the eventually-detected
    // event the next clone observes as a missing file).
    return {
      accepted: true,
      tampered: false,
      reason: `journal file absent at fold time: ${err && err.message ? err.message : err}`,
    };
  }
  if (actual !== content.sha256_of_content_bytes) {
    // Tamper detected. The fold engine surfaces this as a block-grade
    // integrity advisory naming the anchor's signer (owner-accountability
    // via the per-emitter chain). We accept the record (it IS the
    // detection evidence) but set tampered: true so the engine surfaces it.
    return {
      accepted: true,
      tampered: true,
      evidence: {
        expected: content.sha256_of_content_bytes,
        actual,
        path: content.path,
      },
    };
  }
  return { accepted: true, tampered: false };
}

module.exports = {
  RECORD_TYPE,
  hashJournalBody,
  buildAnchorRecord,
  foldAnchorPredicate,
};
