/**
 * eligibility — R5-S-04 deploy-key-exclusion predicate for shard A0b-2c.
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.1 — R5-S-04 host_role:ci is audit-only, NEVER eligible to co-sign
 *          any owner-quorum, distinctness, gate-approval, or
 *          genesis/migration record.
 *   §6.4 — gate matrix (consumed by C2; this module ships the predicate).
 *
 * The 1 invariant this module holds (invariant 3 of the shard contract):
 *
 *   (3) isEligibleSigner(person, signingContext) returns
 *       {eligible: boolean, reason?: string}. CI hosts are NEVER eligible
 *       for the 5 forever-blocked contexts:
 *           owner-quorum, distinctness, gate-approval, genesis, migration
 *       Human hosts are eligible iff their role matches what the context
 *       requires (the C2 gate matrix wires the full matrix; this module
 *       ships the CI exclusion + the baseline role check).
 *
 * Style: CommonJS, zero-dep, pure functions. No I/O. No clock. Same shape
 * as fold-rule-10.js + derive-n.js — a deterministic predicate the gate
 * matrix calls directly.
 */

"use strict";

/**
 * Signing contexts where host_role:ci is forever ineligible per R5-S-04.
 * Exported as a NAMED constant for downstream consumers (C2's gate matrix,
 * the operator-gate.js hook, audit tooling).
 */
const CI_FOREVER_INELIGIBLE_CONTEXTS = [
  "owner-quorum",
  "distinctness",
  "gate-approval",
  "genesis",
  "migration",
];

/**
 * The full set of signing-context names this module recognizes. Unknown
 * contexts raise loud (eligible:false with reason) rather than defaulting
 * — per rules/zero-tolerance.md Rule 3 (no silent fallback to eligible).
 */
const KNOWN_SIGNING_CONTEXTS = new Set(CI_FOREVER_INELIGIBLE_CONTEXTS);

/**
 * Role requirements per signing context. Baseline check only — C2's gate
 * matrix may add finer per-row constraints (e.g. "owner OR senior" for
 * /posture upgrade L1→L4). This module ships the floor: every context in
 * the table below requires AT LEAST the listed role.
 *
 * Owner-only contexts:  owner-quorum, distinctness, genesis, migration
 * Owner-or-senior:      gate-approval (some gate rows accept senior; C2
 *                       narrows to owner-only on owner-class roster edits)
 */
const _REQUIRED_ROLES = {
  "owner-quorum": new Set(["owner"]),
  distinctness: new Set(["owner"]),
  genesis: new Set(["owner"]),
  migration: new Set(["owner"]),
  "gate-approval": new Set(["owner", "senior"]),
};

/**
 * isEligibleSigner — predicate consumed by C2's gate matrix.
 *
 * @param {object} person - a roster `persons[<pid>]` entry. Required shape:
 *   {role: 'owner'|'senior'|'contributor', host_role: 'human'|'ci', ...}
 * @param {string} signingContext - one of CI_FOREVER_INELIGIBLE_CONTEXTS.
 *
 * @returns {{eligible: boolean, reason?: string}}
 */
function isEligibleSigner(person, signingContext) {
  if (!person || typeof person !== "object") {
    return {
      eligible: false,
      reason: "person record missing or not an object",
    };
  }
  if (typeof signingContext !== "string" || !signingContext) {
    return {
      eligible: false,
      reason: "signingContext missing or not a string",
    };
  }
  if (!KNOWN_SIGNING_CONTEXTS.has(signingContext)) {
    return {
      eligible: false,
      reason: `unknown signing context '${signingContext}' — known: ${Array.from(KNOWN_SIGNING_CONTEXTS).join(", ")}`,
    };
  }

  // R5-S-04: host_role:ci is FOREVER ineligible. Audit-only.
  if (person.host_role === "ci") {
    return {
      eligible: false,
      reason: `host_role:ci is audit-only and NEVER eligible to co-sign '${signingContext}' (R5-S-04)`,
    };
  }

  // Baseline role check.
  const required = _REQUIRED_ROLES[signingContext];
  if (!required) {
    // Defensive — every KNOWN_SIGNING_CONTEXTS entry MUST have a role table.
    return {
      eligible: false,
      reason: `no role table for signing context '${signingContext}' — module misconfigured`,
    };
  }
  if (!required.has(person.role)) {
    return {
      eligible: false,
      reason: `role '${person.role}' insufficient for '${signingContext}'; requires one of: ${Array.from(required).join(", ")}`,
    };
  }

  return { eligible: true };
}

module.exports = {
  CI_FOREVER_INELIGIBLE_CONTEXTS,
  isEligibleSigner,
};
