"use strict";

/**
 * Fold rule 9d — post-migration partition detection.
 *
 * Per F14 architecture §2.2 rule 9d (R7-A-02 + R8-S-04) and the journal/0120
 * disposition. At zero-network session-start fold time, the local clone's
 * `genesis_generation` is compared against the peer-observed high-water,
 * which is the MAX `to_genesis_generation` across signature-verified folded
 * `genesis-migration` records.
 *
 * The signed record's `content.to_genesis_generation` is AUTHORITATIVE. The
 * git ref name (`refs/coc/coordination-genN`) is ADVISORY only — it is not
 * consulted by this predicate, even when supplied via `currentRefName`. A
 * forger that pushes to a misleading ref name without producing a matching
 * signed migration record cannot inflate the peer high-water.
 *
 * Signature verification is the engine's rule-1 gate (A2a's `coordination-log.js`
 * pre-verifies before dispatching to predicates). This predicate trusts that
 * gate and treats every record in `acceptedRecords` as already
 * signature-verified.
 *
 * @typedef {Object} PartitionDetectionInput
 * @property {number} localGenesisGeneration - The local clone's current
 *   `genesis_generation` integer (from `operators.roster.json::genesis`).
 * @property {Array<Object>} acceptedRecords - Records the engine has folded
 *   and accepted. Only `type === "genesis-migration"` entries are inspected.
 * @property {Object} roster - Parsed `operators.roster.json` (for future
 *   extensions; currently advisory).
 * @property {string} [currentRefName] - The ref name the clone fetched from
 *   (e.g. `refs/coc/coordination-gen7`). EXPLICITLY IGNORED — the predicate
 *   uses signed-record content, never ref names.
 *
 * @typedef {Object} PartitionDetectionResult
 * @property {boolean} partitioned - True iff localGenesisGeneration is
 *   strictly less than peer_high_water_generation.
 * @property {number} local_genesis_generation - Echo of input for the engine
 *   to surface in its fold result.
 * @property {number} peer_high_water_generation - MAX
 *   `to_genesis_generation` across folded genesis-migration records. 0 when
 *   no migration records have been folded.
 * @property {string} [reason] - Set when `partitioned: true`; explains the
 *   delta in user-visible prose for the session-start advisory layer.
 *
 * @param {PartitionDetectionInput} input
 * @returns {PartitionDetectionResult}
 */
function detectPostMigrationPartition(input) {
  const localGenesisGeneration =
    typeof input?.localGenesisGeneration === "number"
      ? input.localGenesisGeneration
      : 0;
  const acceptedRecords = Array.isArray(input?.acceptedRecords)
    ? input.acceptedRecords
    : [];

  // Compute peer high-water from signed records only — NEVER from
  // `currentRefName` even when provided. This is the load-bearing
  // architectural invariant: a misleading ref name cannot inflate the
  // perceived peer generation.
  let peerHighWaterGeneration = 0;
  for (const r of acceptedRecords) {
    if (!r || r.type !== "genesis-migration") continue;
    const to = r?.content?.to_genesis_generation;
    if (typeof to !== "number") continue;
    if (to > peerHighWaterGeneration) {
      peerHighWaterGeneration = to;
    }
  }

  const partitioned = localGenesisGeneration < peerHighWaterGeneration;
  const result = {
    partitioned,
    local_genesis_generation: localGenesisGeneration,
    peer_high_water_generation: peerHighWaterGeneration,
  };
  if (partitioned) {
    result.reason =
      `local genesis_generation (${localGenesisGeneration}) is below ` +
      `peer-observed high-water (${peerHighWaterGeneration}); fetch the ` +
      `latest genesis-migration record(s) before proceeding (degrades to ` +
      `halt-and-report until partition closes)`;
  }
  return result;
}

module.exports = {
  detectPostMigrationPartition,
};
