"use strict";

/**
 * fold-posture-event — predicate for `posture-event` records.
 *
 * Per workspaces/multi-operator-coc/02-plans/01-architecture.md §6.1 + §6.4
 * (gate authority) + rules/trust-posture.md MUST Rule 3
 * ("Downgrades Are Automatic; Upgrades Are Human-Gated"):
 *
 *   - upgrade  : signer (verified_id-bound person_id) MUST be a DISTINCT
 *                person from `target_person_id`; self-upgrade BLOCKED.
 *   - downgrade: signer MAY downgrade themselves; non-self downgrades
 *                require owner role.
 *   - floor-set: signer MUST be owner-role.
 *   - violation: advisory; auto-downgrade math runs at the consuming hook,
 *                not in the predicate (the record is the receipt, not the
 *                trigger).
 *
 * The engine pre-verifies rule-1 (signature) before dispatch; this predicate
 * trusts that gate and performs role / distinctness checks. Returns the
 * standard A2a predicate shape:
 *   { accepted: bool, foldState: object, reason?: string }
 *
 * @param {Object} record    The signed posture-event record (rule-1 verified).
 * @param {Object} ctx       Engine context: { foldState, roster, acceptedSoFar, opts, meta }.
 * @returns {Object}         { accepted, foldState, reason? }
 */
// M9.1 R6 Sec-R6-S-01 — route `floor-set` eligibility through the shared
// `isEligibleSigner` SSOT per `eligibility.js`. Pre-fix the branch
// checked only `signer.role !== "owner"`, drifting from sibling
// predicates (rule-5, fold-rule-9b/9c, gate-approval, reap) that all
// consolidated through MED-3 onto isEligibleSigner. Closes the host_role:ci
// owner-role-key acceptance path the architecture's gate-matrix row 5
// ("owner-quorum" signing context) explicitly excludes.
const path = require("path");
const { isEligibleSigner } = require(path.join(__dirname, "eligibility.js"));

function foldPostureEvent(record, ctx) {
  const foldState = ctx && ctx.foldState ? ctx.foldState : {};
  const roster = ctx && ctx.roster ? ctx.roster : null;
  if (!record || typeof record !== "object") {
    return { accepted: false, foldState, reason: "record must be an object" };
  }
  if (record.type !== "posture-event") {
    return {
      accepted: false,
      foldState,
      reason: "fold-posture-event invoked on non-posture-event record",
    };
  }
  const content = record.content;
  if (!content || typeof content !== "object") {
    return { accepted: false, foldState, reason: "content must be an object" };
  }

  // Allowlist of events. Anything outside the list is rejected loudly.
  const ALLOWED_EVENTS = new Set([
    "upgrade",
    "downgrade",
    "floor-set",
    "violation",
  ]);
  const event = content.event;
  if (!ALLOWED_EVENTS.has(event)) {
    return {
      accepted: false,
      foldState,
      reason:
        "unknown event '" +
        String(event) +
        "' (allowlist: upgrade, downgrade, floor-set, violation)",
    };
  }

  // Resolve signer's person_id + role via roster lookup on verified_id.
  const signer = _resolveSigner(roster, record.verified_id);

  if (event === "upgrade") {
    // Per trust-posture.md MUST Rule 3: agent CANNOT self-promote — the
    // signer's person_id MUST differ from the target_person_id.
    const target = content.target_person_id;
    if (!signer.personId) {
      return {
        accepted: false,
        foldState,
        reason: "upgrade: signer is not bound to a roster person_id",
      };
    }
    if (typeof target !== "string" || !target) {
      return {
        accepted: false,
        foldState,
        reason: "upgrade: target_person_id must be a non-empty string",
      };
    }
    if (target === signer.personId) {
      return {
        accepted: false,
        foldState,
        reason:
          "upgrade: self-upgrade BLOCKED per trust-posture.md MUST Rule 3 — distinct person required",
      };
    }
    // Challenge-nonce paste-back is required for upgrades per
    // trust-posture.md MUST Rule 3 ("challenge-nonce response from the user").
    if (
      typeof content.challenge_nonce !== "string" ||
      !content.challenge_nonce
    ) {
      return {
        accepted: false,
        foldState,
        reason: "upgrade: challenge_nonce paste-back required",
      };
    }
    return { accepted: true, foldState };
  }

  if (event === "downgrade") {
    const target = content.target_person_id;
    if (!signer.personId) {
      return {
        accepted: false,
        foldState,
        reason: "downgrade: signer is not bound to a roster person_id",
      };
    }
    if (typeof target !== "string" || !target) {
      return {
        accepted: false,
        foldState,
        reason: "downgrade: target_person_id must be a non-empty string",
      };
    }
    // Self-downgrade is always allowed (voluntary step-down).
    if (target === signer.personId) {
      return { accepted: true, foldState };
    }
    // Non-self downgrade requires owner role.
    if (signer.role !== "owner") {
      return {
        accepted: false,
        foldState,
        reason:
          "downgrade: non-self downgrade requires owner role (signer role='" +
          String(signer.role) +
          "')",
      };
    }
    return { accepted: true, foldState };
  }

  if (event === "floor-set") {
    // M9.1 R6 Sec-R6-S-01 — route through `isEligibleSigner("owner-quorum")`
    // SSOT per `eligibility.js`. Per gate-matrix row 5
    // (`repo-floor-restore` → `signing_context: "owner-quorum"`), the
    // eligibility predicate enforces BOTH baseline owner role AND
    // R5-S-04 host_role:ci forever-ineligibility. Pre-fix branch only
    // checked role, allowing a CI-host owner-role key to fold.
    const eligibility = isEligibleSigner(
      { role: signer.role, host_role: signer.hostRole },
      "owner-quorum",
    );
    if (!eligibility.eligible) {
      return {
        accepted: false,
        foldState,
        reason: "floor-set: " + eligibility.reason,
      };
    }
    return { accepted: true, foldState };
  }

  // event === "violation" — advisory; accept any signed record.
  // The auto-downgrade math runs in the consuming hook, not here.
  return { accepted: true, foldState };
}

/**
 * Resolve a roster person from a verified_id (fingerprint).
 * Returns { personId, role, githubLogin, hostRole } or all-null when no match.
 *
 * M9.1 R6 Sec-R6-S-01 — `hostRole` surfaced so the `floor-set` branch
 * can route through `isEligibleSigner("owner-quorum")` which enforces
 * R5-S-04 host_role:ci ineligibility. Pre-fix returned only role +
 * personId + githubLogin, missing the host_role field.
 */
function _resolveSigner(roster, verifiedId) {
  const nullSigner = {
    personId: null,
    role: null,
    githubLogin: null,
    hostRole: null,
  };
  if (!roster || !roster.persons || typeof roster.persons !== "object") {
    return nullSigner;
  }
  if (typeof verifiedId !== "string" || !verifiedId) return nullSigner;
  for (const [pid, person] of Object.entries(roster.persons)) {
    if (!person || !Array.isArray(person.keys)) continue;
    for (const k of person.keys) {
      if (k && k.fingerprint === verifiedId) {
        return {
          personId: pid,
          role: person.role || null,
          githubLogin: person.github_login || null,
          hostRole: person.host_role || null,
        };
      }
    }
  }
  return nullSigner;
}

module.exports = {
  foldPostureEvent,
};
