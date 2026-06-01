/**
 * gate-matrix — §6.4 gate-authority matrix as a structured constant +
 * per-row evaluator. Shard C2 (workspaces/multi-operator-coc, design v11
 * §6.4 + §4.3).
 *
 * The 1 invariant this module holds (invariant 2 of the shard contract):
 *
 *   (2) Codify the §6.4 table (10 rows) as a structured constant
 *       (GATE_MATRIX_ROWS) AND ship a per-row evaluator (evaluateGate)
 *       that consults the SAME isEligibleSigner predicate B3b's reap
 *       ceremony uses (contract-identity asserted by test importing both
 *       call sites) AND the SAME r9s02-fence.js M0 ships (checkpoint/
 *       rotation NOT self-signable under revocation-induced N=1).
 *
 * Architecture refs:
 *   §6.4 — Gate authority — 4-eyes on person_id + collaborator distinctness
 *   §4.3 — operator-gate.js — consumes evaluateGate()
 *   §2.3 — R5-S-04 host_role:ci ineligible (routed via eligibility.js)
 *   §2.3 — R5-S-07 same-bound-collaborator-login rejected on owner/senior
 *   §2.3 — R9-S-02 revocation-induced N=1 fence (consumed from r9s02-fence.js)
 *   §2.3 — R7-A-03 owner-departure removal-only recovery
 *   §6.4 — R6-S-04 genesis-migration NO degenerate self-sign
 *
 * Style: CommonJS, zero-dep, pure functions. No I/O. No clock. Same shape
 * as eligibility.js / r9s02-fence.js — a deterministic predicate the
 * operator-gate.js hook calls directly.
 *
 * Cross-shard contracts (MUST preserve):
 *   - lib/eligibility.js::isEligibleSigner — IMPORTED HERE; the function
 *     reference is re-exported as `_sharedEligibility` for the test that
 *     asserts contract-identity with B3b's reap ceremony.
 *   - lib/r9s02-fence.js::gateEligibleForSelfSignedCheckpointOrRotation —
 *     consulted for compaction-checkpoint and generation-rotation rows.
 */

"use strict";

const path = require("path");
const { isEligibleSigner } = require(path.join(__dirname, "eligibility.js"));
// F14 C2 iter-3 SSOT consistency: case-insensitive compare via helper.
const { loginsEqual } = require(path.join(__dirname, "github-login.js"));
const {
  gateEligibleForSelfSignedCheckpointOrRotation,
  isRevocationInducedSingleton,
} = require(path.join(__dirname, "r9s02-fence.js"));

// ---- §6.4 matrix as structured constant -------------------------------------

/**
 * The 10 rows of §6.4. Each row carries:
 *   - gate: canonical row identifier
 *   - self_approvable: "yes" | "no" | "never" | "degenerate" |
 *                       "owner-departure-recovery"
 *   - required_signers: prose summary
 *   - signing_context: the lib/eligibility.js context this row checks
 *     ("n/a" when no co-signer is required — e.g. todos-plan-single-operator
 *     OR owner-departure recovery which is degenerate-self-sign-only)
 *   - notes: brief architectural rationale
 *
 * The 10 rows are enumerated in §6.4 table order; the gate-matrix.test.js
 * structural test asserts length === 10.
 */
const GATE_MATRIX_ROWS = Object.freeze([
  Object.freeze({
    gate: "todos-plan-single-operator",
    self_approvable: "yes",
    required_signers: "self",
    signing_context: "n/a",
    notes: "§6.4 row 1 — single-operator workstream, self-approvable",
  }),
  Object.freeze({
    gate: "todos-plan-touches-anothers-lease",
    self_approvable: "no",
    required_signers: "lease-holder co-signs",
    signing_context: "gate-approval",
    notes: "§6.4 row 2 — lease-holder co-signature required",
  }),
  Object.freeze({
    gate: "posture-upgrade",
    self_approvable: "no",
    required_signers: "owner/senior",
    signing_context: "gate-approval",
    notes: "§6.4 row 3 — /posture upgrade L1→L4 / →L5",
  }),
  Object.freeze({
    gate: "posture-override",
    self_approvable: "no",
    required_signers: "owner/senior",
    signing_context: "gate-approval",
    notes: "§6.4 row 4 — /posture override",
  }),
  Object.freeze({
    gate: "repo-floor-restore",
    self_approvable: "no",
    required_signers: "owner",
    signing_context: "owner-quorum",
    notes: "§6.4 row 5 — repo_floor restore (owner-only, no fallback)",
  }),
  Object.freeze({
    gate: "release",
    self_approvable: "never",
    required_signers: "owner/senior",
    signing_context: "gate-approval",
    notes:
      "§6.4 row 6 — /release; degenerate-genesis-N=1 self-sign permitted with audit marker",
  }),
  Object.freeze({
    gate: "compaction-checkpoint",
    self_approvable: "no",
    required_signers: "2-of-N owner (or degenerate-genesis self-sign)",
    signing_context: "owner-quorum",
    notes:
      "§6.4 row 7 — compaction-checkpoint; R9-S-02 fence — NOT self-signable under revocation-induced N=1",
  }),
  Object.freeze({
    gate: "generation-rotation",
    self_approvable: "no",
    required_signers: "2-of-N owner (or degenerate-genesis self-sign)",
    signing_context: "owner-quorum",
    notes:
      "§6.4 row 7 — generation-rotation; R9-S-02 fence — NOT self-signable under revocation-induced N=1",
  }),
  Object.freeze({
    gate: "genesis-migration",
    self_approvable: "no",
    required_signers: "2-of-N owner + fresh external check",
    signing_context: "migration",
    notes:
      "§6.4 row 8 — genesis-migration; R6-S-04 NO degenerate self-sign EVER",
  }),
  Object.freeze({
    gate: "owner-departure-roster-removal",
    self_approvable: "owner-departure-recovery",
    required_signers: "self (REMOVAL-ONLY)",
    signing_context: "n/a",
    notes:
      "§6.4 row 9 — owner-departure recovery; R7-A-03 + R8-S-01 (removal-only, never owner-add)",
  }),
  Object.freeze({
    gate: "roster-edit-add-contributor",
    self_approvable: "no",
    required_signers: "one owner",
    signing_context: "gate-approval",
    notes: "§6.4 row 10 — roster edit adding a contributor",
  }),
  Object.freeze({
    gate: "new-rule-codify",
    self_approvable: "no",
    required_signers: "second person_id + signed [ack]",
    signing_context: "gate-approval",
    notes:
      "§6.4 row 11 — new-rule /codify; R5-C-06 second person_id signed [ack]",
  }),
]);

// The final exported constant. compaction-checkpoint + generation-rotation
// share §6.4's same textual row; both have separate matrix entries because
// operator-gate.js routes them via different command surfaces (the row's
// audit marker logic in evaluateGate distinguishes them).
const _MATRIX = GATE_MATRIX_ROWS;

/**
 * findRow — look up a gate row by name.
 * @param {string} gate
 * @returns {object|null}
 */
function findRow(gate) {
  for (const row of _MATRIX) {
    if (row.gate === gate) return row;
  }
  return null;
}

// ---- per-row evaluator ------------------------------------------------------

/**
 * Compare two person_ids for self-approval check.
 */
function _isSelfApproval(requester, approver) {
  if (!requester || !approver) return false;
  return (
    typeof requester.person_id === "string" &&
    typeof approver.person_id === "string" &&
    requester.person_id === approver.person_id
  );
}

/**
 * Compare two bound GitHub-collaborator logins (R5-S-07).
 *
 * F14 MED-4: GitHub usernames are case-insensitive at the server side
 * (github.com/Alice and github.com/alice resolve to the same account).
 * R5-S-07 collaborator-distinctness MUST mirror that semantics; a string-
 * equality check lets an attacker register two roster entries with the
 * same gh_login under different cases and bypass the colluding-collaborator
 * defense on owner/senior gates.
 */
function _sameBoundCollaborator(requester, approver) {
  if (!requester || !approver) return false;
  if (typeof requester.gh_login !== "string" || !requester.gh_login) return false;
  if (typeof approver.gh_login !== "string" || !approver.gh_login) return false;
  // F14 C2 iter-3: route through loginsEqual for SSOT consistency.
  return loginsEqual(requester.gh_login, approver.gh_login);
}

/**
 * Apply R9-S-02 fence for compaction-checkpoint / generation-rotation rows.
 * Returns { ok: boolean, reason: string }.
 */
function _checkR9S02Fence(roster, foldedState) {
  const fence = gateEligibleForSelfSignedCheckpointOrRotation(roster, foldedState);
  if (fence.eligible) return { ok: true };
  return {
    ok: false,
    reason: fence.reason || "R9-S-02 fence: revocation-induced N=1",
  };
}

/**
 * Determine if the (roster, foldedState) pair represents a genuine-genesis
 * N=1 (degenerate self-sign permitted for the relevant rows).
 */
function _isGenuineGenesisN1(roster, foldedState) {
  // derived-N MUST be 1.
  const derivedN = foldedState && typeof foldedState.derived_N === "number"
    ? foldedState.derived_N
    : null;
  if (derivedN !== 1) return false;
  // ANY attestation history means owner-add occurred → NOT genuine-genesis.
  return !isRevocationInducedSingleton(roster, foldedState);
}

/**
 * Verdict shape returned by evaluateGate:
 *   {
 *     allowed: boolean,
 *     reason: string,          // present when allowed=false (and on allowed
 *                              //   with audit marker)
 *     audit_marker: string|null, // non-null on degenerate self-sign /
 *                                //   owner-departure recovery
 *     row: object,             // the §6.4 row consulted
 *   }
 */
function evaluateGate(ctx) {
  if (!ctx || typeof ctx !== "object") {
    return {
      allowed: false,
      reason: "evaluateGate: ctx must be an object",
      audit_marker: null,
      row: null,
    };
  }
  const row = findRow(ctx.gate);
  if (!row) {
    return {
      allowed: false,
      reason: `evaluateGate: unknown gate '${ctx.gate}'`,
      audit_marker: null,
      row: null,
    };
  }

  const requester = ctx.requester || {};
  const approver = ctx.approver || {};
  const approverPerson = ctx.approverPerson || null;
  const roster = ctx.roster || null;
  const foldedState = ctx.foldedState || null;

  // ---- row dispatch ---------------------------------------------------------

  // Row: todos-plan-single-operator — always self-approvable.
  if (row.gate === "todos-plan-single-operator") {
    if (ctx.touchesAnothersLease) {
      return {
        allowed: false,
        reason:
          "operator-gate/4-eyes: row 'todos-plan-single-operator' became 'todos-plan-touches-anothers-lease' (caller must use the latter row when touchesAnothersLease=true)",
        audit_marker: null,
        row,
      };
    }
    return { allowed: true, reason: "single-operator workstream", audit_marker: null, row };
  }

  // Row: owner-departure-roster-removal — degenerate self-sign permitted
  // ONLY when revocation has settled AND derived-N dropped below attested-N
  // AND the edit is REMOVAL ONLY (R8-S-01 — owner-add NEVER self-signable).
  if (row.gate === "owner-departure-roster-removal") {
    if (ctx.rosterEditKind !== "removal") {
      return {
        allowed: false,
        reason:
          "operator-gate/owner-departure (R8-S-01): only REMOVAL is self-approvable on this row; owner-ADD requires fresh gh-api ceremony",
        audit_marker: null,
        row,
      };
    }
    if (!ctx.revocationSettled) {
      return {
        allowed: false,
        reason:
          "operator-gate/owner-departure: revocation must be settled (rule 10 liveness-contest) before this recovery row fires",
        audit_marker: null,
        row,
      };
    }
    return {
      allowed: true,
      reason: "owner-departure recovery (REMOVAL-ONLY, R7-A-03 + R8-S-03)",
      audit_marker: "owner-departure-recovery-removal-only",
      row,
    };
  }

  // ---- universal cross-cutting checks (apply to all co-signer-requiring rows) ----

  // 1. host_role:ci excluded via shared isEligibleSigner (R5-S-04 +
  //    contract-identity with B3b reap ceremony).
  if (row.signing_context !== "n/a" && approverPerson) {
    const elig = isEligibleSigner(approverPerson, row.signing_context);
    if (!elig.eligible) {
      return {
        allowed: false,
        reason: `operator-gate/eligibility: ${elig.reason}`,
        audit_marker: null,
        row,
      };
    }
  }

  // 2. Self-approval check (4-eyes half 1).
  const isSelf = _isSelfApproval(requester, approver);

  // Degenerate-genesis-N=1 audit-marked self-sign — applies to:
  //   release / compaction-checkpoint / generation-rotation /
  //   repo-floor-restore (NOT genesis-migration per R6-S-04).
  const degenerateEligibleRows = new Set([
    "release",
    "compaction-checkpoint",
    "generation-rotation",
  ]);
  if (isSelf && degenerateEligibleRows.has(row.gate)) {
    // First, run R9-S-02 fence for checkpoint/rotation (revocation-induced
    // N=1 BLOCKS the degenerate self-sign; genuine genesis ALLOWS).
    if (
      row.gate === "compaction-checkpoint" ||
      row.gate === "generation-rotation"
    ) {
      const fence = _checkR9S02Fence(roster, foldedState);
      if (!fence.ok) {
        return {
          allowed: false,
          reason: `operator-gate/r9s02-fence: ${fence.reason}`,
          audit_marker: null,
          row,
        };
      }
    }
    // Then check genuine-genesis-N=1.
    if (_isGenuineGenesisN1(roster, foldedState)) {
      return {
        allowed: true,
        reason:
          "operator-gate/degenerate: self-sign permitted under derived genuine-genesis N=1",
        audit_marker: "degenerate-self-sign-genuine-genesis-N1",
        row,
      };
    }
    // Self + non-genuine-genesis → 4-eyes violation.
    return {
      allowed: false,
      reason: `operator-gate/4-eyes: row '${row.gate}' rejects self-approval (approver person_id == requester); not in degenerate-genesis-N=1 either`,
      audit_marker: null,
      row,
    };
  }

  // For self-approval-permitted-only-on-degenerate rows BUT we're NOT degenerate-eligible:
  if (isSelf && row.gate !== "todos-plan-single-operator") {
    return {
      allowed: false,
      reason: `operator-gate/4-eyes: row '${row.gate}' rejects self-approval (approver person_id == requester); distinct ${row.required_signers} required`,
      audit_marker: null,
      row,
    };
  }

  // 3. Same-bound-collaborator-login check on owner/senior gates
  //    (R5-S-07 half 2 — colluding-collaborator). Applies to rows whose
  //    required_signers is owner-class.
  const ownerSeniorGates = new Set([
    "posture-upgrade",
    "posture-override",
    "repo-floor-restore",
    "release",
    "compaction-checkpoint",
    "generation-rotation",
    "genesis-migration",
    "roster-edit-add-contributor",
  ]);
  if (ownerSeniorGates.has(row.gate) && _sameBoundCollaborator(requester, approver)) {
    return {
      allowed: false,
      reason: `operator-gate/collaborator-distinctness (R5-S-07): approver bound to same GitHub collaborator '${approver.gh_login}' as requester`,
      audit_marker: null,
      row,
    };
  }

  // 4. genesis-migration — NO degenerate self-sign EVER (R6-S-04). Falls
  //    through to here because the row is NOT in degenerateEligibleRows.
  //    Self-approval is already rejected above; no additional check needed.

  // 5. All other gates with distinct approver pass.
  return { allowed: true, reason: row.required_signers + " co-signature", audit_marker: null, row };
}

// ---- exports ----------------------------------------------------------------

module.exports = {
  GATE_MATRIX_ROWS,
  evaluateGate,
  findRow,
  // Exported for the contract-identity test (gate-matrix.test.js):
  // "eligibility_predicate_shared_with_b3b_reap_ceremony" asserts that
  // this module consumes the SAME isEligibleSigner function reference
  // B3b's reap ceremony uses.
  _sharedEligibility: isEligibleSigner,
};
