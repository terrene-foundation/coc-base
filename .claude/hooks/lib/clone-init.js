/**
 * clone-init — signed first-fold witness for shard A0b-2c.
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.2 — record types include `clone-init` (per-clone first-fold witness).
 *   §2.3 — "Per-clone freshness witness — in-log, checkpoint-exempt
 *           (R5-S-05, R6-A-01/R6-S-03). First-fold appends a signed
 *           hash-chained `clone-init`, checkpoint-exempt by rule 6."
 *   §2.2 rule 6 — generic checkpoint-exemption: every signed witness /
 *           accountability / trust-root record type is checkpoint-exempt
 *           by default; `clone-init` is in the default-exempt list.
 *
 * The 1 invariant this module holds (invariant 4 of the shard contract):
 *
 *   (4) On first fold of the log by a clone, append a signed hash-chained
 *       `clone-init` record. The `.coc-fetch-cache` gitignored file is a
 *       NON-load-bearing fold-speed optimization; the in-log signed
 *       `clone-init` IS the trust witness.
 *
 * Style: CommonJS, zero-dep. Signing IO is INJECTED (cocSign parameter)
 * so the module is deterministically testable; transport IO is INJECTED
 * (transportAppend) so this module never touches the filesystem directly
 * — same pattern owner-add-ceremony.js / owner-depart-ceremony.js
 * established.
 */

"use strict";

/**
 * shouldEmitCloneInit — predicate the SessionStart / fold path consults to
 * decide whether THIS clone owes a clone-init record yet.
 *
 * A clone-init record is keyed by the EMITTING clone's verifiedId — each
 * clone signs its OWN first-fold witness. Another clone's clone-init does
 * NOT satisfy our obligation (the witness is per-clone, not per-repo).
 *
 * @param {object} roster - the operators roster (unused but passed for
 *   future role-based predicates; kept in the signature for symmetry
 *   with derive-n.js / fold-rule-10.js).
 * @param {object} foldedState - folded log state. Expected shape:
 *   { records: Array<{type, verified_id, seq, ...}>, ... }.
 * @param {string} verifiedId - this clone's signing-key fingerprint.
 *
 * @returns {boolean}
 */
function shouldEmitCloneInit(roster, foldedState, verifiedId) {
  if (typeof verifiedId !== "string" || !verifiedId) return false;
  const records =
    foldedState && Array.isArray(foldedState.records)
      ? foldedState.records
      : [];
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.type !== "clone-init") continue;
    if (rec.verified_id === verifiedId) return false;
  }
  return true;
}

/**
 * Validate emitCloneInit input. Returns null on OK or a string error.
 */
function _validateEmitInput(params) {
  if (!params || typeof params !== "object") return "params not an object";
  if (!params.cocSign || typeof params.cocSign !== "object") {
    return "cocSign module missing";
  }
  if (
    typeof params.cocSign.canonicalSerialize !== "function" ||
    typeof params.cocSign.sign !== "function"
  ) {
    return "cocSign must expose canonicalSerialize + sign";
  }
  if (typeof params.transportAppend !== "function") {
    return "transportAppend callback missing";
  }
  if (typeof params.verifiedId !== "string" || !params.verifiedId) {
    return "verifiedId missing";
  }
  if (typeof params.personId !== "string" || !params.personId) {
    return "personId missing";
  }
  if (
    typeof params.seq !== "number" ||
    !Number.isInteger(params.seq) ||
    params.seq < 0
  ) {
    return "seq must be non-negative integer";
  }
  // prevHash MAY be null (first record on this emitter's chain) or a
  // non-empty string (continuation).
  if (
    params.prevHash !== null &&
    (typeof params.prevHash !== "string" || !params.prevHash)
  ) {
    return "prevHash must be null or a non-empty string";
  }
  if (typeof params.ts !== "string" || !params.ts) return "ts missing";
  if (!params.signer || typeof params.signer !== "object") {
    return "signer missing";
  }
  if (typeof params.signer.keyPath !== "string" || !params.signer.keyPath) {
    return "signer.keyPath missing";
  }
  if (
    !params.fingerprintEvidence ||
    typeof params.fingerprintEvidence !== "object"
  ) {
    return "fingerprintEvidence missing or not an object";
  }
  return null;
}

/**
 * emitCloneInit — build, sign, and append a clone-init record.
 *
 * Architecture §2.2: the record carries
 *   {type, verified_id, person_id, seq, prev_hash, ts, content, sig}
 * where content.fingerprint_evidence is arbitrary clone-identifying
 * material the caller chose (e.g. first_fold_ts +
 * coordination_log_head_at_first_fold sha). The module does NOT
 * prescribe the evidence schema — it is opaque to fold rule 6 generic
 * (checkpoint-exempt witness).
 *
 * @param {object} params
 * @param {object} params.cocSign - the coc-sign module (injected).
 * @param {function} params.transportAppend - (record) => {ok, ...}.
 * @param {string} params.verifiedId - emitter signing-key fingerprint.
 * @param {string} params.personId - emitter person_id.
 * @param {number} params.seq - per-emitter monotonic seq.
 * @param {string|null} params.prevHash - per-emitter chain prev_hash.
 * @param {string} params.ts - ISO-8601 timestamp.
 * @param {object} params.signer - {keyPath, keyType?}.
 * @param {object} params.fingerprintEvidence - opaque clone-identifying
 *   evidence; embedded verbatim under content.fingerprint_evidence.
 *
 * @returns {{ok: true, record: object} | {ok: false, error: string}}
 */
function emitCloneInit(params) {
  const inputErr = _validateEmitInput(params);
  if (inputErr) return { ok: false, error: inputErr };

  const core = {
    type: "clone-init",
    verified_id: params.verifiedId,
    person_id: params.personId,
    seq: params.seq,
    prev_hash: params.prevHash,
    ts: params.ts,
    content: {
      fingerprint_evidence: params.fingerprintEvidence,
    },
  };

  let bytes;
  try {
    bytes = params.cocSign.canonicalSerialize(core);
  } catch (err) {
    return {
      ok: false,
      error: `canonicalSerialize failed: ${err && err.message ? err.message : String(err)}`,
    };
  }

  const signOpts = {
    keyType: params.signer.keyType || "ssh",
    keyPath: params.signer.keyPath,
  };
  const signResult = params.cocSign.sign(bytes, signOpts);
  if (!signResult || signResult.ok !== true) {
    return {
      ok: false,
      error: `sign failed: ${signResult && signResult.error ? signResult.error : "unknown"}${signResult && signResult.reason ? ` (${signResult.reason})` : ""}`,
    };
  }

  const record = Object.assign({}, core, { sig: signResult.sig });

  let appendResult;
  try {
    appendResult = params.transportAppend(record);
  } catch (err) {
    return {
      ok: false,
      error: `transportAppend threw: ${err && err.message ? err.message : String(err)}`,
    };
  }
  if (appendResult && appendResult.ok === false) {
    return {
      ok: false,
      error: `transportAppend rejected: ${appendResult.error || "unknown"}`,
    };
  }

  return { ok: true, record };
}

module.exports = {
  shouldEmitCloneInit,
  emitCloneInit,
};
