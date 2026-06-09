/**
 * reap-ceremony — writer-side library for cross-operator reap of stale
 * claims per multi-operator-coc architecture §4.4.
 *
 * Shard B3b (workspaces/multi-operator-coc, M3).
 *
 * The reap ceremony is the structural mechanism by which a sibling
 * operator can release a STALE claim held by ANOTHER operator without
 * forging the victim's signing key. Per §4.4 the ceremony requires:
 *
 *   - reaper: the invoking operator (signs the outer reap record).
 *   - cosigner: a distinct-person_id co-signer (signs the inner reap
 *     content; their signature is embedded in the reap record's content
 *     as `cosignature`).
 *   - pinned victim heartbeat: the OBSERVED (verified_id, seq, ts) of the
 *     victim's most-recent heartbeat the reaper has seen. The cosigner
 *     witnesses the same pin.
 *
 * Honored only if BOTH:
 *   (a) no victim heartbeat with higher `seq` exists in the post-reap
 *       fold (the pinned heartbeat IS the latest the reaper observed),
 *   (b) the pinned victim heartbeat's `ts` is older than
 *       `now - LIVENESS_TTL_MS` per R5-A-07 / R10-A-01 (wall-clock
 *       identity to M0's fold-rule-10).
 *
 * Alternative bases:
 *   - "owner-2-of-N": owner-class quorum signs; the cosigner must still
 *     be a distinct-person_id eligible signer (R5-S-04 + role floor).
 *   - "self-reap": the reaper IS the victim's verified_id. No cosigner
 *     required; the reaper's own signature suffices.
 *
 * Cosigner eligibility goes through `eligibility.js::isEligibleSigner`
 * with the "gate-approval" context. Per R5-S-04: `host_role: "ci"` is
 * NEVER eligible to co-sign — CI hosts are audit-only.
 *
 * This library ships the writer-side flow (build + validate). The
 * VERIFIER-side (fold rule 4 cross-operator mutation scoping +
 * acceptance of the reap into the engine's accepted set) lives in
 * A2a's coordination-log.js.
 *
 * Style: CommonJS, zero-dep, matches sibling .claude/hooks/lib/*.js.
 * Pure functions; no fs, no network, no clock (caller supplies `now`).
 */

"use strict";

const path = require("path");
const { canonicalSerialize, sign, verify } = require(
  path.join(__dirname, "coc-sign.js"),
);
const { isEligibleSigner } = require(path.join(__dirname, "eligibility.js"));
const { LIVENESS_TTL_MS } = require(path.join(__dirname, "fold-rule-10.js"));

/**
 * Build a signed `reap` record per §4.4.
 *
 * The function signs in two stages:
 *   1. Canonical-serialize the cosignature payload (a stable subset of
 *      the reap content) and have the cosigner sign it; embed the
 *      cosignature in `content.cosignature`. SKIPPED for "self-reap".
 *   2. Canonical-serialize the full reap core (including the
 *      cosignature) and have the reaper sign it; that signature is the
 *      outer `sig` field.
 *
 * Both signatures are verifiable by any fold-engine consumer with the
 * roster's pubkeys for {reaper, cosigner}.
 *
 * @param {object} opts
 * @param {{verified_id: string, seq: number, claim_id?: string}} opts.reapedClaim
 *   The claim being reaped — pointer the engine resolves to the actual
 *   claim record (same shape as `release.content.released_claim_ref`).
 * @param {object} opts.reaperPerson  - roster persons[<pid>] entry
 * @param {string} opts.reaperVerifiedId
 * @param {object|null} opts.cosignerPerson  - null for self-reap basis
 * @param {string|null} opts.cosignerVerifiedId
 * @param {string|null} opts.cosignerKeyPath
 * @param {string} opts.reaperKeyPath
 * @param {{verified_id: string, seq: number, ts: string}} opts.pinnedVictimHeartbeat
 * @param {"co-signed"|"owner-2-of-N"|"self-reap"} opts.basis
 * @param {number} opts.seq  - reaper's per-emitter chain seq
 * @param {string|null} opts.prevHash
 * @param {string} opts.ts  - reap record's wall-clock ts (ISO)
 * @param {object} [opts.ghApiCollaboratorsCapture]
 *   M3 HIGH-2 / R5-S-07: fresh gh-api collaborators capture, in the
 *   allowlisted shape {collaborators: [...], capture_ts: ISO}. Required
 *   for non-self-reap bases (the engine-side predicate rejects without
 *   it). Self-reap omits.
 *
 * @returns {{ok: true, record: object} | {ok: false, error: string}}
 */
function buildReapRecord(opts) {
  if (!opts || typeof opts !== "object") {
    return { ok: false, error: "opts required" };
  }
  if (!opts.reapedClaim || typeof opts.reapedClaim !== "object") {
    return { ok: false, error: "reapedClaim required" };
  }
  if (typeof opts.reaperVerifiedId !== "string" || !opts.reaperVerifiedId) {
    return { ok: false, error: "reaperVerifiedId required" };
  }
  if (!opts.reaperPerson || typeof opts.reaperPerson !== "object") {
    return { ok: false, error: "reaperPerson required" };
  }
  if (typeof opts.basis !== "string" || !opts.basis) {
    return { ok: false, error: "basis required" };
  }
  if (
    opts.basis !== "co-signed" &&
    opts.basis !== "owner-2-of-N" &&
    opts.basis !== "self-reap"
  ) {
    return {
      ok: false,
      error: `basis '${opts.basis}' not in {co-signed, owner-2-of-N, self-reap}`,
    };
  }
  // Azure DevOps port (Shard 2c): provider selects the distinct-bound-member
  // capture field name (gh_api_collaborators_capture vs ado_api_members_capture)
  // + sets content.provider so fold-rule-reap dispatches the matching
  // distinctness predicate (principalsEqual vs loginsEqual). Absent ⇒ github
  // (content.provider field stays ABSENT → byte-identical GitHub records).
  const provider = opts.provider || "github";
  if (provider !== "github" && provider !== "azure-devops") {
    return {
      ok: false,
      error: `provider '${provider}' not in {github, azure-devops}`,
    };
  }
  if (
    !opts.pinnedVictimHeartbeat ||
    typeof opts.pinnedVictimHeartbeat !== "object"
  ) {
    return { ok: false, error: "pinnedVictimHeartbeat required" };
  }
  const hb = opts.pinnedVictimHeartbeat;
  if (typeof hb.verified_id !== "string" || !hb.verified_id) {
    return { ok: false, error: "pinnedVictimHeartbeat.verified_id required" };
  }
  if (typeof hb.seq !== "number" || !Number.isFinite(hb.seq)) {
    return { ok: false, error: "pinnedVictimHeartbeat.seq required (number)" };
  }
  if (typeof hb.ts !== "string" || !hb.ts) {
    return { ok: false, error: "pinnedVictimHeartbeat.ts required (ISO)" };
  }

  const isSelfReap = opts.basis === "self-reap";
  let cosignerPersonId = null;
  let cosignerVerifiedId = null;
  let cosignature = null;

  if (!isSelfReap) {
    // Co-signed (or owner-2-of-N) — cosigner required.
    if (!opts.cosignerPerson || typeof opts.cosignerPerson !== "object") {
      return {
        ok: false,
        error: `basis '${opts.basis}' requires cosignerPerson`,
      };
    }
    if (
      typeof opts.cosignerVerifiedId !== "string" ||
      !opts.cosignerVerifiedId
    ) {
      return {
        ok: false,
        error: `basis '${opts.basis}' requires cosignerVerifiedId`,
      };
    }
    if (typeof opts.cosignerKeyPath !== "string" || !opts.cosignerKeyPath) {
      return {
        ok: false,
        error: `basis '${opts.basis}' requires cosignerKeyPath`,
      };
    }
    // Distinct-person_id check: reaper and cosigner MUST be different persons.
    // The cryptographic key (verified_id) MAY differ even if person_id matches
    // (a person can hold multiple keys), but the structural-rotation defense
    // requires distinct *persons* per §4.4.
    const reaperPid = opts.reaperPerson.person_id;
    const cosignerPid = opts.cosignerPerson.person_id;
    if (!reaperPid || !cosignerPid) {
      return {
        ok: false,
        error:
          "both reaperPerson.person_id and cosignerPerson.person_id required",
      };
    }
    if (reaperPid === cosignerPid) {
      return {
        ok: false,
        error: `cosigner must have distinct person_id; reaper '${reaperPid}' === cosigner '${cosignerPid}' (R5-S-04 + §4.4 cosigner-distinct)`,
      };
    }
    // Eligibility check via gate-approval context.
    // Per R5-S-04: host_role:ci is NEVER eligible. The eligibility module's
    // gate-approval table also enforces the role floor (owner OR senior).
    const elig = isEligibleSigner(opts.cosignerPerson, "gate-approval");
    if (!elig.eligible) {
      return {
        ok: false,
        error: `cosigner not eligible: ${elig.reason}`,
      };
    }
    cosignerPersonId = cosignerPid;
    cosignerVerifiedId = opts.cosignerVerifiedId;

    // Build the cosignature payload — a stable subset of the reap content
    // the cosigner is attesting to. The cosignature MUST verify over the
    // canonical-serialized form of this payload.
    //
    // M3 LOW-5 / F-13: include claim_id (when known) in the cosignature
    // payload — the cosigner is attesting to the SPECIFIC claim by its
    // claim_id, not just the (verified_id, seq) tuple. Without this,
    // claim_id could be mutated post-cosign without invalidating the
    // cosignature. `null` is a stable canonical value when unknown.
    const cosignaturePayload = {
      type: "reap-cosignature",
      reaped_claim_ref: {
        verified_id: opts.reapedClaim.verified_id,
        seq: opts.reapedClaim.seq,
      },
      claim_id: opts.reapedClaim.claim_id || null,
      reaper: reaperPid,
      cosigner: cosignerPid,
      pinned_victim_heartbeat: {
        verified_id: hb.verified_id,
        seq: hb.seq,
        ts: hb.ts,
      },
      basis: opts.basis,
    };
    const bytes = canonicalSerialize(cosignaturePayload);
    const cosignResult = sign(bytes, {
      keyType: "ssh",
      keyPath: opts.cosignerKeyPath,
    });
    if (!cosignResult.ok) {
      return {
        ok: false,
        error: `cosignature sign failed: ${cosignResult.error} (${cosignResult.reason || ""})`,
      };
    }
    cosignature = cosignResult.sig;
  }

  // Build the outer reap record.
  const content = {
    reaped_claim_ref: {
      verified_id: opts.reapedClaim.verified_id,
      seq: opts.reapedClaim.seq,
    },
    // For engine fold rule 4 / release reconciliation: also surface
    // claim_id when known (caller may pass it; optional).
    claim_id: opts.reapedClaim.claim_id || null,
    reaper: opts.reaperPerson.person_id || null,
    cosigner: cosignerPersonId,
    cosigner_verified_id: cosignerVerifiedId,
    cosignature,
    pinned_victim_heartbeat: {
      verified_id: hb.verified_id,
      seq: hb.seq,
      ts: hb.ts,
    },
    basis: opts.basis,
  };
  // M3 HIGH-2 / R5-S-07: non-self-reap bases require the fresh members
  // capture in the provider-correct field. The engine-side predicate verifies
  // it. ADO tags content.provider so the fold reads ado_api_members_capture +
  // applies the principalsEqual distinctness predicate.
  if (provider === "azure-devops") {
    content.provider = "azure-devops";
  }
  if (!isSelfReap) {
    if (provider === "azure-devops") {
      if (!opts.adoMembersCapture) {
        return {
          ok: false,
          error: `basis '${opts.basis}' (azure-devops) requires adoMembersCapture (R5-S-07 / HIGH-2)`,
        };
      }
      content.ado_api_members_capture = opts.adoMembersCapture;
    } else {
      if (!opts.ghApiCollaboratorsCapture) {
        return {
          ok: false,
          error: `basis '${opts.basis}' requires ghApiCollaboratorsCapture (R5-S-07 / HIGH-2)`,
        };
      }
      content.gh_api_collaborators_capture = opts.ghApiCollaboratorsCapture;
    }
  }
  const core = {
    type: "reap",
    verified_id: opts.reaperVerifiedId,
    person_id: opts.reaperPerson.person_id || null,
    display_id: opts.reaperPerson.display_id || null,
    seq: typeof opts.seq === "number" ? opts.seq : 0,
    prev_hash: opts.prevHash || null,
    ts: opts.ts || new Date().toISOString(),
    content,
  };

  if (typeof opts.reaperKeyPath !== "string" || !opts.reaperKeyPath) {
    return { ok: false, error: "reaperKeyPath required" };
  }
  const outerBytes = canonicalSerialize(core);
  const outer = sign(outerBytes, {
    keyType: "ssh",
    keyPath: opts.reaperKeyPath,
  });
  if (!outer.ok) {
    return {
      ok: false,
      error: `reaper sign failed: ${outer.error} (${outer.reason || ""})`,
    };
  }
  return { ok: true, record: Object.assign({}, core, { sig: outer.sig }) };
}

/**
 * Validate a reap record against the §4.4 honoring predicates.
 *
 * This is the writer-side pre-check. The fold engine's rule 4 (mutation
 * scoping) will re-verify cryptographically at acceptance time. This
 * function tells the operator BEFORE-write whether the reap will be
 * honored by the engine, so the agent can halt-and-report rather than
 * append a record that will be rejected.
 *
 * Honoring predicates per §4.4:
 *   - basis == "self-reap": no further checks beyond signature shape
 *     (engine fold rule 4 will check verified_id == reaped_claim_ref's
 *     verified_id).
 *   - basis == "co-signed" or "owner-2-of-N": BOTH
 *     (a) `observedPeerVictimHighWaterSeq` <= pinned_victim_heartbeat.seq
 *         (pinned is the latest the reaper sees), AND
 *     (b) now - Date.parse(pinned_victim_heartbeat.ts) >= LIVENESS_TTL_MS
 *         (wall-clock predicate per R5-A-07 / R10-A-01).
 *
 * @param {object} opts
 * @param {object} opts.record  - reap record (signed)
 * @param {number} opts.now     - wall-clock ms since epoch
 * @param {number|null} opts.observedPeerVictimHighWaterSeq
 *   The MAX seq observed across peers for the victim's per-emitter chain
 *   (rule-9d peer-high-water output). Caller resolves this via the fold
 *   engine; null = unknown (defensive: treat as failed predicate (a)).
 *
 * @returns {{honored: boolean, reason?: string}}
 */
function validateReap(opts) {
  if (!opts || !opts.record || typeof opts.record !== "object") {
    return { honored: false, reason: "record required" };
  }
  const r = opts.record;
  if (r.type !== "reap") {
    return { honored: false, reason: `wrong type '${r.type}'` };
  }
  const content = r.content || {};
  const basis = content.basis;
  if (typeof basis !== "string") {
    return { honored: false, reason: "basis missing" };
  }

  // Self-reap basis: short-circuit. The engine fold rule 4 verifies
  // verified_id binding; this writer-side check just confirms the basis
  // is structurally valid.
  if (basis === "self-reap") {
    // Verify the reaper IS the victim's verified_id (self-reap binding).
    if (
      !content.reaped_claim_ref ||
      content.reaped_claim_ref.verified_id !== r.verified_id
    ) {
      return {
        honored: false,
        reason:
          "self-reap: reaper verified_id must match reaped claim's verified_id",
      };
    }
    return { honored: true };
  }

  if (basis !== "co-signed" && basis !== "owner-2-of-N") {
    return { honored: false, reason: `unknown basis '${basis}'` };
  }

  // M3 MED-4 / F-10 / R8-S-01: owner-2-of-N requires ≥2 distinct cosigners.
  // "co-signed" basis takes the single primary cosigner; "owner-2-of-N" is
  // the elevated quorum (e.g. reap of an owner-class claim) and requires
  // two DISTINCT owner cosigners in addition to the reaper. Without ≥2
  // cosigners, owner-2-of-N degrades to co-signed semantics — the elevated
  // quorum claim becomes false.
  if (basis === "owner-2-of-N") {
    const coSigners = Array.isArray(content.co_signers)
      ? content.co_signers
      : [];
    if (coSigners.length < 2) {
      return {
        honored: false,
        reason: `R8-S-01 / MED-4: basis 'owner-2-of-N' requires ≥2 distinct cosigners in content.co_signers (got ${coSigners.length}); use basis 'co-signed' for single-cosigner reap`,
      };
    }
  }

  const hb = content.pinned_victim_heartbeat;
  if (!hb || typeof hb !== "object") {
    return { honored: false, reason: "pinned_victim_heartbeat missing" };
  }
  if (typeof hb.seq !== "number" || typeof hb.ts !== "string") {
    return { honored: false, reason: "pinned_victim_heartbeat malformed" };
  }

  // Predicate (a): no observed peer heartbeat at higher seq.
  const peerHi =
    typeof opts.observedPeerVictimHighWaterSeq === "number"
      ? opts.observedPeerVictimHighWaterSeq
      : null;
  if (peerHi === null) {
    return {
      honored: false,
      reason:
        "observedPeerVictimHighWaterSeq unknown — cannot confirm pinned-is-latest",
    };
  }
  if (peerHi > hb.seq) {
    return {
      honored: false,
      reason: `victim has higher-seq heartbeat than pinned: peer_high_water=${peerHi} > pinned.seq=${hb.seq}`,
    };
  }

  // Predicate (b): wall-clock age >= LIVENESS_TTL_MS (R5-A-07 / R10-A-01).
  const now = typeof opts.now === "number" ? opts.now : NaN;
  const hbTs = Date.parse(hb.ts);
  if (Number.isNaN(now) || Number.isNaN(hbTs)) {
    return { honored: false, reason: "now or pinned heartbeat ts unparseable" };
  }
  const elapsed = now - hbTs;
  if (elapsed < 0) {
    return { honored: false, reason: "pinned heartbeat ts in the future" };
  }
  if (elapsed < LIVENESS_TTL_MS) {
    return {
      honored: false,
      reason: `pinned heartbeat only ${elapsed}ms old; need >= LIVENESS_TTL_MS (${LIVENESS_TTL_MS}ms)`,
    };
  }

  return { honored: true };
}

/**
 * Verify the embedded cosignature in a reap record against the cosigner's
 * pubkey. Returns the same result shape as coc-sign.js::verify.
 *
 * @param {object} record - reap record
 * @param {string} cosignerPubKey - the cosigner's SSH/GPG pubkey
 * @param {object} [opts] - { keyType?: "ssh" | "gpg" }
 */
function verifyCosignature(record, cosignerPubKey, opts) {
  if (!record || !record.content || !record.content.cosignature) {
    return { ok: false, error: "no cosignature on record" };
  }
  const content = record.content;
  // M3 LOW-5 / F-13: claim_id is part of the cosignature payload. The
  // canonical key order MUST match buildReapRecord's payload exactly;
  // canonicalSerialize handles sort-keys discipline so insertion order
  // here does not matter for the BYTES, but the FIELDS MUST be identical.
  const cosignaturePayload = {
    type: "reap-cosignature",
    reaped_claim_ref: content.reaped_claim_ref,
    claim_id: content.claim_id || null,
    reaper: content.reaper,
    cosigner: content.cosigner,
    pinned_victim_heartbeat: content.pinned_victim_heartbeat,
    basis: content.basis,
  };
  const bytes = canonicalSerialize(cosignaturePayload);
  return verify(bytes, content.cosignature, cosignerPubKey, opts);
}

module.exports = {
  buildReapRecord,
  validateReap,
  verifyCosignature,
};
