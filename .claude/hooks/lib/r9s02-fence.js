/**
 * r9s02-fence — R9-S-02 fence distinguishing revocation-induced N=1 from
 * genuine-genesis N=1, for shard A0b-2c.
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.3 "Owner departure + recovery" — R9-S-02:
 *     "while derived-N=1 traces to a `collaborator-distinctness-
 *     revocation` (as opposed to a genuine genesis N=1),
 *     `compaction-checkpoint` and `generation-rotation` are also NOT
 *     degenerate-self-signable — they require the N=1→N=2
 *     network-permitted owner-add ceremony first (§6.4). This prevents
 *     a forged-revocation→derived-N=1 window from unlocking a poisoned
 *     self-signed checkpoint before rule 10's contest fires."
 *   §6.4 — gate matrix row: roster edit / compaction-checkpoint /
 *     generation-rotation. Genuine-genesis-degenerate N=1 self-sign is
 *     allowed for checkpoint/rotation/owner-key-removal ONLY; any
 *     owner-ADD needs a fresh gh-api ceremony R8-S-01; checkpoint/
 *     rotation NOT self-signable under a revocation-induced N=1 (R9-S-02).
 *
 * The 1 invariant this module holds (invariant 2 of the shard contract):
 *
 *   (2) `isRevocationInducedSingleton` returns true iff derived-N=1 AND
 *       the dropped-to-1 traces to a settled revocation (NOT a genesis
 *       N=1 where the roster has always had exactly one owner from
 *       inception). `gateEligibleForSelfSignedCheckpointOrRotation`
 *       returns eligible iff isRevocationInducedSingleton is false AND
 *       derived-N=1 is genuine-genesis. Required by C2's gate matrix at
 *       §6.4 — this shard ships the predicate; C2 wires the gate.
 *
 * Distinguishing genuine-genesis-N=1 from revocation-induced-N=1
 * (architecture §2.3, faithfully encoded):
 *   "the genesis roster's initial `persons[]` count + the absence of any
 *    settled `collaborator-distinctness-attestation` records →
 *    genuine-genesis. Any settled attestation (whether or not
 *    subsequently revoked) → owner-add history has occurred, so a
 *    current N=1 is necessarily revocation-induced."
 *
 * The "settled" qualifier is preserved by treating any attestation
 * record in the folded log as evidence of historical owner-add — the
 * fold engine pre-filters by signature-verification (rule 1) before
 * exposing records to this predicate. Contested revocations are
 * excluded by R10-A-03 in derive-n.js; this module reads the same
 * input the gate matrix reads.
 *
 * Style: CommonJS, zero-dep, pure functions. No I/O. No clock.
 */

"use strict";

/**
 * Count owner-role persons in the roster, EXCLUDING host_role:ci (R5-S-04).
 * The "roster owner count" is the structural cardinality of the persons[]
 * map at roster-read time — orthogonal to derived-N which reads the log.
 */
function _rosterOwnerCount(roster) {
  if (!roster || !roster.persons || typeof roster.persons !== "object")
    return 0;
  let n = 0;
  for (const person of Object.values(roster.persons)) {
    if (!person || person.role !== "owner") continue;
    if (person.host_role === "ci") continue;
    n += 1;
  }
  return n;
}

/**
 * Check whether the folded log contains ANY collaborator-distinctness-
 * attestation record (revocation-contested ones inclusive — the question
 * is whether owner-add history has EVER occurred, not whether it is
 * currently active).
 */
function _hasAnyAttestationHistory(foldedState) {
  if (!foldedState) return false;
  const records = Array.isArray(foldedState.records) ? foldedState.records : [];
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.type === "collaborator-distinctness-attestation") return true;
  }
  return false;
}

/**
 * Extract derived-N from folded state. The fold engine (A2a) is
 * responsible for keeping `foldedState.derived_N` current via derive-n.js
 * — this module is a pure predicate and trusts the upstream value.
 *
 * Defaults to roster owner count when foldedState.derived_N is absent;
 * the defensive fallback lets the predicate produce a deterministic
 * answer even on a degraded log (per derive-n.js's permissive contract).
 */
function _deriveN(foldedState, roster) {
  if (
    foldedState &&
    typeof foldedState.derived_N === "number" &&
    Number.isInteger(foldedState.derived_N) &&
    foldedState.derived_N >= 0
  ) {
    return foldedState.derived_N;
  }
  return _rosterOwnerCount(roster);
}

/**
 * isRevocationInducedSingleton — true iff derived-N=1 AND the drop-to-1
 * traces to a settled revocation (faithful to the §2.3 prose: presence
 * of ANY attestation in log = owner-add history has occurred = current
 * N=1 is revocation-induced).
 *
 * @param {object} roster - operators roster.
 * @param {object} foldedState - {records, derived_N?}.
 * @returns {boolean}
 */
function isRevocationInducedSingleton(roster, foldedState) {
  const derivedN = _deriveN(foldedState, roster);
  if (derivedN !== 1) return false;
  return _hasAnyAttestationHistory(foldedState);
}

/**
 * gateEligibleForSelfSignedCheckpointOrRotation — the §6.4 gate matrix
 * row C2 wires for `compaction-checkpoint` and `generation-rotation`:
 *
 *   - N >= 2: this predicate does NOT fire (the question of "degenerate
 *     self-sign" only arises at N=1); return eligible:true.
 *   - genuine-genesis N=1: eligible:true (degenerate self-sign permitted
 *     per §6.4 row for checkpoint/rotation/owner-key-removal only — the
 *     genesis-anchor IS the distinctness basis, R9-A-03).
 *   - revocation-induced N=1: eligible:false — R9-S-02 fence fires.
 *
 * This predicate ONLY answers the R9-S-02 question. C2's gate matrix
 * adds the orthogonal eligibility checks (host_role:ci exclusion via
 * eligibility.js, person_id distinctness, etc.).
 *
 * @param {object} roster
 * @param {object} foldedState
 * @returns {{eligible: boolean, reason?: string}}
 */
function gateEligibleForSelfSignedCheckpointOrRotation(roster, foldedState) {
  const derivedN = _deriveN(foldedState, roster);
  if (derivedN >= 2) {
    return { eligible: true };
  }
  if (derivedN < 1) {
    // Degraded log; the gate matrix MUST NOT permit a self-sign when
    // derived-N cannot even reach 1.
    return {
      eligible: false,
      reason: `derived-N=${derivedN} below the genuine-genesis floor of 1`,
    };
  }
  // derivedN === 1 — check the fence.
  if (_hasAnyAttestationHistory(foldedState)) {
    return {
      eligible: false,
      reason:
        "R9-S-02 fence: derived-N=1 traces to a settled collaborator-distinctness-revocation (attestation history exists in the log); compaction-checkpoint and generation-rotation require the N=1→N=2 network-permitted owner-add ceremony first",
    };
  }
  return { eligible: true };
}

module.exports = {
  isRevocationInducedSingleton,
  gateEligibleForSelfSignedCheckpointOrRotation,
};
