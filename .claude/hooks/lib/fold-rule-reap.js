/**
 * fold-rule-reap — engine-side `reap` predicate (M3 hardening HIGH-1 + HIGH-3).
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §4.4 — cross-operator reap ceremony. The reaper's record carries a
 *   pinned victim heartbeat (verified_id, seq, ts) AND a basis. Honoring
 *   predicates (a) + (b):
 *     (a) the pinned heartbeat is the LATEST observed for the victim,
 *     (b) wall-clock elapsed since pinned heartbeat.ts >= LIVENESS_TTL_MS.
 *
 * Pre-M3 behavior:
 *   The reap predicate registered on the engine was a no-op accept; the
 *   writer-side `reap-ceremony.js::validateReap` did all the work — but
 *   validateReap was caller-side, consuming the caller's `now` and the
 *   caller's `observedPeerVictimHighWaterSeq`. A malicious reaper could
 *   simply skip validateReap, ship a forged reap record, and the engine
 *   would accept it (no-op predicate).
 *
 * M3 hardening:
 *   This module ships the ENGINE-side predicate that re-verifies both
 *   honoring predicates against AUTHORITATIVE state:
 *     - (a) resolved from `opts.acceptedSoFar` (the engine's own folded
 *       log, NOT the caller's claim of peer-high-water).
 *     - (b) computed from the ENGINE's `opts.now` (the orchestrator's
 *       wall clock at fold time, NOT the record's own ts and NOT the
 *       caller's claim of `now`).
 *
 *   Additionally, the predicate verifies the pinned heartbeat resolves
 *   BYTEWISE — `existingHeartbeat.ts === pinned.ts` — to the actual
 *   heartbeat record present in the log under (verified_id, seq). A
 *   reap referencing a heartbeat that does not exist OR whose ts has
 *   been forged is rejected with the forger named.
 *
 * R5-S-07 (distinct-bound-collaborator) is enforced here as well: the
 * reap record's content MUST carry a `gh_api_collaborators_capture`
 * AND both reaper + cosigner MUST resolve to distinct admin-bound
 * github logins in the capture. The `self-reap` basis short-circuits
 * the distinctness check (there is no cosigner).
 *
 * Style: CommonJS, zero-dep, matches sibling fold-genesis-anchor.js
 * shape. Consumes the engine dispatch ctx
 * ({ foldState, roster, acceptedSoFar, opts }) and returns
 * { accepted, foldState, reason?, forging_signer? }.
 */

"use strict";

const { LIVENESS_TTL_MS } = require("./fold-rule-10.js");
const {
  _isCaptureFresh,
  _verifyDistinctBoundCollaborators,
} = require("./gh-api-allowlist.js");
// Azure DevOps port (Shard 2c): the ADO distinct-bound-member predicate, the
// principalsEqual sibling of _verifyDistinctBoundCollaborators. The fold
// dispatches on content.provider (absent ⇒ github) and reads the matching
// capture field (ado_api_members_capture) + roster bind field (principal).
const { _verifyDistinctBoundMembers } = require("./ado-api-allowlist.js");

/**
 * Resolve the verified_id's roster person (if any). Returns
 * {person_id, person} or null.
 */
function _resolveRosterPerson(roster, verifiedId) {
  if (!roster || !roster.persons) return null;
  for (const [pid, person] of Object.entries(roster.persons)) {
    const keys = (person && person.keys) || [];
    for (const k of keys) {
      if (k && k.fingerprint === verifiedId) {
        return { person_id: pid, person };
      }
    }
  }
  return null;
}

/**
 * Walk the engine's accepted records for a heartbeat at
 * (victimVerifiedId, victimSeq). Returns the heartbeat record or null.
 *
 * The engine accepts in record-walk order; the heartbeat MUST have
 * been folded BEFORE the reap (since reap is rule-4 cross-operator —
 * the engine cannot accept the reap if the victim's chain isn't visible).
 */
function _findVictimHeartbeat(acceptedSoFar, victimVerifiedId, victimSeq) {
  if (!Array.isArray(acceptedSoFar)) return null;
  for (const r of acceptedSoFar) {
    if (!r || r.type !== "heartbeat") continue;
    if (r.verified_id !== victimVerifiedId) continue;
    if (r.seq !== victimSeq) continue;
    return r;
  }
  return null;
}

/**
 * Find the highest-seq heartbeat for victimVerifiedId in acceptedSoFar.
 * Returns the record OR null when no heartbeats exist.
 */
function _findHighestHeartbeat(acceptedSoFar, victimVerifiedId) {
  if (!Array.isArray(acceptedSoFar)) return null;
  let best = null;
  for (const r of acceptedSoFar) {
    if (!r || r.type !== "heartbeat") continue;
    if (r.verified_id !== victimVerifiedId) continue;
    if (best === null || r.seq > best.seq) best = r;
  }
  return best;
}

/**
 * Engine-side reap predicate (M3 hardening).
 *
 * Honoring predicates per §4.4:
 *   self-reap: reaper IS the victim's verified_id; no cosig required;
 *              no liveness check (the operator is choosing to release
 *              their own claim, regardless of liveness).
 *   co-signed / owner-2-of-N:
 *     (a) the pinned heartbeat exists in the folded log at
 *         (pinned.verified_id, pinned.seq) AND ts matches bytewise.
 *     (b) NO heartbeat exists in the folded log at a HIGHER seq for the
 *         same victim (the pinned heartbeat IS the latest).
 *     (c) engine_now - pinned.ts >= LIVENESS_TTL_MS (R5-A-07 wall-clock,
 *         computed from engine_now, NOT the record's ts and NOT a
 *         caller-supplied now).
 *
 * R5-S-07: distinct-bound-collaborator (HIGH-2):
 *   For non-self-reap baseis, content.gh_api_collaborators_capture
 *   MUST resolve reaper.github_login + cosigner.github_login to two
 *   distinct admin-bound logins.
 *
 * @param {object} record - reap record (signed; engine pre-verified rule-1)
 * @param {object} ctx    - { foldState, roster, acceptedSoFar, opts }
 * @returns {{accepted, foldState, reason?, forging_signer?}}
 */
function foldReap(record, ctx) {
  const state = (ctx && ctx.foldState) || { trustRoot: null };
  const roster = ctx && ctx.roster;
  const acceptedSoFar = (ctx && ctx.acceptedSoFar) || [];
  const opts = (ctx && ctx.opts) || {};

  // --- shape ---
  if (!record || typeof record !== "object") {
    return {
      accepted: false,
      foldState: state,
      reason: "record not an object",
    };
  }
  if (record.type !== "reap") {
    return {
      accepted: false,
      foldState: state,
      reason: `record.type != 'reap' (got: ${record.type})`,
    };
  }
  const c = record.content;
  if (!c || typeof c !== "object") {
    return { accepted: false, foldState: state, reason: "content missing" };
  }
  const basis = c.basis;
  if (
    basis !== "self-reap" &&
    basis !== "co-signed" &&
    basis !== "owner-2-of-N"
  ) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap basis '${basis}' not in {self-reap, co-signed, owner-2-of-N}`,
      forging_signer: record.verified_id,
    };
  }

  // Self-reap basis: short-circuit. The reaper IS the victim's
  // verified_id. No cosig, no liveness check — the operator chose to
  // release their own claim.
  if (basis === "self-reap") {
    if (
      !c.reaped_claim_ref ||
      c.reaped_claim_ref.verified_id !== record.verified_id
    ) {
      return {
        accepted: false,
        foldState: state,
        reason:
          "self-reap: reaper verified_id MUST match reaped claim's verified_id",
        forging_signer: record.verified_id,
      };
    }
    return { accepted: true, foldState: state };
  }

  // Cross-operator basis: require pinned victim heartbeat shape.
  const hb = c.pinned_victim_heartbeat;
  if (!hb || typeof hb !== "object") {
    return {
      accepted: false,
      foldState: state,
      reason: "reap predicate: pinned_victim_heartbeat missing",
      forging_signer: record.verified_id,
    };
  }
  if (typeof hb.verified_id !== "string" || !hb.verified_id) {
    return {
      accepted: false,
      foldState: state,
      reason: "reap predicate: pinned_victim_heartbeat.verified_id missing",
      forging_signer: record.verified_id,
    };
  }
  if (typeof hb.seq !== "number" || !Number.isFinite(hb.seq)) {
    return {
      accepted: false,
      foldState: state,
      reason:
        "reap predicate: pinned_victim_heartbeat.seq missing or not a number",
      forging_signer: record.verified_id,
    };
  }
  if (typeof hb.ts !== "string" || !hb.ts) {
    return {
      accepted: false,
      foldState: state,
      reason: "reap predicate: pinned_victim_heartbeat.ts missing",
      forging_signer: record.verified_id,
    };
  }

  // --- HIGH-1: bytewise heartbeat resolution from engine's acceptedSoFar ---
  const existing = _findVictimHeartbeat(acceptedSoFar, hb.verified_id, hb.seq);
  if (!existing) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate: pinned heartbeat does not exist in folded log: verified_id=${hb.verified_id}, seq=${hb.seq}`,
      forging_signer: record.verified_id,
    };
  }
  if (existing.ts !== hb.ts) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate: pinned heartbeat ts mismatch — folded log has ts=${existing.ts}, pin claims ts=${hb.ts}`,
      forging_signer: record.verified_id,
    };
  }

  // --- Predicate (a) [strengthened]: NO heartbeat exists at HIGHER seq ---
  const highest = _findHighestHeartbeat(acceptedSoFar, hb.verified_id);
  if (highest && highest.seq > hb.seq) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate (a): victim has higher-seq heartbeat than pinned — folded log high-water seq=${highest.seq}, pin seq=${hb.seq}`,
      forging_signer: record.verified_id,
    };
  }

  // --- HIGH-3 / Predicate (b): engine wall-clock check ---
  // Critical: engineNow MUST come from opts.now (the orchestrator's
  // clock), NOT the record's ts. A malicious reaper could backdate the
  // record's ts to satisfy the elapsed check; the engine's own clock
  // is the only structural defense.
  const engineNow = typeof opts.now === "number" ? opts.now : Date.now();
  const hbTs = Date.parse(hb.ts);
  if (Number.isNaN(hbTs)) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate (b): pinned heartbeat ts unparseable: ${hb.ts}`,
      forging_signer: record.verified_id,
    };
  }
  const elapsed = engineNow - hbTs;
  if (elapsed < 0) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate (b): pinned heartbeat ts in the future per engine clock: elapsed=${elapsed}ms`,
      forging_signer: record.verified_id,
    };
  }
  if (elapsed < LIVENESS_TTL_MS) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate (b) fails: heartbeat aged ${elapsed}ms < LIVENESS_TTL_MS (${LIVENESS_TTL_MS}ms) per engine clock`,
      forging_signer: record.verified_id,
    };
  }

  // --- HIGH-2 / R5-S-07: distinct-bound-collaborator/member ---
  // The reap record MUST carry a fresh members capture; the reaper + cosigner
  // MUST resolve to distinct admin-bound identities. Azure DevOps port
  // (Shard 2c): dispatch on content.provider (absent ⇒ github). ADO reads
  // ado_api_members_capture + binds via `principal` + applies the
  // principalsEqual distinctness predicate; the capture freshness +
  // roster-resolution flow below is provider-NEUTRAL.
  const provider = c.provider || "github";
  if (provider !== "github" && provider !== "azure-devops") {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate: unknown content.provider '${provider}' (github | azure-devops)`,
      forging_signer: record.verified_id,
    };
  }
  const isAdo = provider === "azure-devops";
  const captureField = isAdo
    ? "ado_api_members_capture"
    : "gh_api_collaborators_capture";
  const bindField = isAdo ? "principal" : "github_login";
  const verifyDistinct = isAdo
    ? _verifyDistinctBoundMembers
    : _verifyDistinctBoundCollaborators;

  const capture = c[captureField];
  if (!capture) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate: missing required field ${captureField} (R5-S-07 distinct-bound anchor)`,
      forging_signer: record.verified_id,
    };
  }
  // Capture freshness — record ts within ceiling of capture_ts (provider-
  // neutral: _isCaptureFresh operates on capture_ts only).
  const captureTs =
    (capture && typeof capture.capture_ts === "string" && capture.capture_ts) ||
    null;
  if (!captureTs) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate: ${captureField} missing capture_ts (HIGH-4)`,
      forging_signer: record.verified_id,
    };
  }
  const freshness = _isCaptureFresh(captureTs, record.ts);
  if (!freshness.fresh) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate: stale capture: ${freshness.reason}`,
      forging_signer: record.verified_id,
    };
  }
  // Resolve reaper + cosigner bound identities via roster.
  const reaperResolve = _resolveRosterPerson(roster, record.verified_id);
  if (!reaperResolve) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate: reaper verified_id ${record.verified_id} not in roster`,
      forging_signer: record.verified_id,
    };
  }
  const cosignerVid = c.cosigner_verified_id;
  if (typeof cosignerVid !== "string" || !cosignerVid) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate: basis '${basis}' requires cosigner_verified_id`,
      forging_signer: record.verified_id,
    };
  }
  const cosignerResolve = _resolveRosterPerson(roster, cosignerVid);
  if (!cosignerResolve) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate: cosigner verified_id ${cosignerVid} not in roster`,
      forging_signer: record.verified_id,
    };
  }
  const primaryBound = reaperResolve.person[bindField];
  const cosignerBound = cosignerResolve.person[bindField];
  if (typeof primaryBound !== "string" || !primaryBound) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate: reaper roster entry missing ${bindField}`,
      forging_signer: record.verified_id,
    };
  }
  if (typeof cosignerBound !== "string" || !cosignerBound) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate: cosigner roster entry missing ${bindField}`,
      forging_signer: record.verified_id,
    };
  }
  const distinctness = verifyDistinct(primaryBound, cosignerBound, capture);
  if (!distinctness.ok) {
    return {
      accepted: false,
      foldState: state,
      reason: `reap predicate: ${distinctness.reason}`,
      forging_signer: record.verified_id,
    };
  }

  return { accepted: true, foldState: state };
}

module.exports = {
  foldReap,
  _internal: {
    _resolveRosterPerson,
    _findVictimHeartbeat,
    _findHighestHeartbeat,
  },
};
