/**
 * archive-ref — cold archive ref pin/verify helpers.
 *
 * Shard A3 (workspaces/multi-operator-coc, design v11 §2.3 + R8-A-01).
 *
 * Cold archive refs (`refs/coc/archive-genN`) carry the pre-rotation log
 * history of generation N. A compaction-checkpoint pins the archive tip
 * SHA at fold time so subsequent generation-rotation events can
 * transitively re-anchor the pin (rule 9b R9-A-01). Mismatch between the
 * pinned tip and the observed tip is structural detection of archive-ref
 * tampering.
 *
 * Style: CommonJS, zero-dep, pure functions (no I/O, no clock).
 */

"use strict";

/**
 * Embed an archive-ref tip-SHA pin into a compaction-checkpoint record.
 *
 * The pin lands at `record.content.archive_tip_pins[refName] = tipSha`,
 * leaving every other field untouched. The original record is NOT
 * mutated — the helper returns a new record so callers can compose
 * pin updates immutably across multiple archive refs.
 *
 * @param {object} checkpointRecord - compaction-checkpoint (or other
 *   record-shape that carries a `content` object); MUST have a
 *   `content` field.
 * @param {string} archiveRefName - e.g. "refs/coc/archive-gen0"
 * @param {string} tipSha - full SHA-1 hex of the archive ref tip
 * @returns {object} record with the pin embedded (immutable update)
 */
function pinArchiveTip(checkpointRecord, archiveRefName, tipSha) {
  if (!checkpointRecord || typeof checkpointRecord !== "object") {
    throw new Error("pinArchiveTip: checkpointRecord must be an object");
  }
  if (typeof archiveRefName !== "string" || !archiveRefName) {
    throw new Error("pinArchiveTip: archiveRefName must be a non-empty string");
  }
  if (typeof tipSha !== "string" || !tipSha) {
    throw new Error("pinArchiveTip: tipSha must be a non-empty string");
  }
  const content = checkpointRecord.content || {};
  const priorPins =
    content.archive_tip_pins && typeof content.archive_tip_pins === "object"
      ? content.archive_tip_pins
      : {};
  const newPins = Object.assign({}, priorPins, { [archiveRefName]: tipSha });
  const newContent = Object.assign({}, content, { archive_tip_pins: newPins });
  return Object.assign({}, checkpointRecord, { content: newContent });
}

/**
 * Verify that an observed archive-ref tip matches the pin embedded in a
 * compaction-checkpoint record.
 *
 * @param {object} checkpointRecord - record-with-pin from pinArchiveTip
 * @param {string} archiveRefName - the archive ref whose pin to verify
 * @param {string} observedTipSha - the actual observed tip SHA
 * @returns {{match: boolean, reason?: string, expected?: string, observed?: string}}
 *
 * Returns `{match: true}` when the embedded pin matches observed exactly.
 * Returns `{match: false, reason}` for missing pin OR tip drift, with the
 * reason naming the divergence so callers can route to halt-and-report
 * advisories per `rules/observability.md`.
 */
function verifyArchiveTipPin(checkpointRecord, archiveRefName, observedTipSha) {
  if (!checkpointRecord || typeof checkpointRecord !== "object") {
    return {
      match: false,
      reason: "checkpointRecord missing or not an object",
    };
  }
  if (typeof archiveRefName !== "string" || !archiveRefName) {
    return { match: false, reason: "archiveRefName missing" };
  }
  if (typeof observedTipSha !== "string" || !observedTipSha) {
    return { match: false, reason: "observedTipSha missing" };
  }
  const content = checkpointRecord.content || {};
  const pins = content.archive_tip_pins;
  if (!pins || typeof pins !== "object") {
    return {
      match: false,
      reason: `no archive_tip_pins embedded in checkpoint content`,
    };
  }
  const expected = pins[archiveRefName];
  if (typeof expected !== "string" || !expected) {
    return {
      match: false,
      reason: `no pin for archive ref '${archiveRefName}' in checkpoint`,
    };
  }
  if (expected !== observedTipSha) {
    return {
      match: false,
      reason: `archive tip mismatch for '${archiveRefName}': expected ${expected}, observed ${observedTipSha} (tip drift)`,
      expected,
      observed: observedTipSha,
    };
  }
  return { match: true };
}

module.exports = {
  pinArchiveTip,
  verifyArchiveTipPin,
};
