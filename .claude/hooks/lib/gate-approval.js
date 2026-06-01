/**
 * gate-approval — canonical signed-bytes + verifier for the multi-operator
 * gate-approval payload consumed by operator-gate.js.
 *
 * F14 MED-1 + MED-2 (workspaces/multi-operator-coc — security review R1).
 * F14 iter-2 Sec-MED-2: canonical bytes extended to bind approver_verified_id.
 *
 * The 4 invariants this module holds:
 *
 *   (1) Canonical signed-bytes shape — the approver signs over exactly
 *       {target_tool, requester_person_id, requester_verified_id,
 *        approver_verified_id, consumed_nonce, ts} via
 *       cocSign.canonicalSerialize. The shape is fixed; both signer and
 *       verifier MUST agree byte-for-byte. approver_verified_id binding
 *       is iter-2 Sec-MED-2 defense-in-depth: the verifier already
 *       resolves the approver pubkey from this field (so a payload-
 *       level swap is structurally rejected by sig-verify), but binding
 *       it INTO the signed bytes makes the contract explicit and
 *       hardens against a future verifier-resolution-layer bug.
 *
 *   (2) cryptographic verification — the verifier resolves the approver's
 *       roster pubkey from the payload's approver_verified_id (NOT the
 *       attacker-controlled approver_role / approver_host_role fields)
 *       and calls cocSign.verify against the canonical bytes.
 *
 *   (3) nonce + target_tool + TTL binding — the verifier checks that
 *       (a) gate_approval.consumed_nonce equals the requester-supplied
 *           requester_nonce in the current invocation;
 *       (b) gate_approval.target_tool equals the canonical §6.4 row name
 *           derived from the current command surface (no cross-surface
 *           replay);
 *       (c) gate_approval.ts is within GATE_APPROVAL_TTL_MS (24h) of now.
 *
 *   (4) approver-role resolution from roster, NEVER from payload —
 *       the verifier returns the roster-resolved person record so the
 *       gate-matrix consumes a TRUSTED person, never the attacker claim.
 *
 * Cross-shard contracts consumed:
 *   - lib/coc-sign.js::canonicalSerialize / verify — same crypto layer
 *     fold-rule-9b / 9c / coordination-log Rule 1 use; bytes are
 *     deterministic across machines/sessions.
 *   - lib/eligibility.js::isEligibleSigner — single source of truth for
 *     R5-S-04 + role-floor. Same predicate B3b's reap ceremony +
 *     gate-matrix.js evaluateGate uses.
 *
 * Style: CommonJS, zero-dep beyond sibling lib/, matches sibling
 * .claude/hooks/lib/* modules. Pure function on injected `now` for testability.
 */

"use strict";

const path = require("path");
const cocSign = require(path.join(__dirname, "coc-sign.js"));
const { isEligibleSigner } = require(path.join(__dirname, "eligibility.js"));

/**
 * TTL clamp on gate-approval freshness (24h). After this window the signed
 * payload is rejected even if cryptographically valid — closes the long-tail
 * replay class where an attacker accumulates owner approvals and re-uses
 * them weeks later.
 */
const GATE_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Closed allowlist of target_tool values accepted in canonical signed
 * bytes. Mirrors the §6.4 row vocabulary the gate-matrix recognizes for
 * signing-context="gate-approval". Per cc-artifacts.md Rule 10 — positive
 * allowlist closes the bug class instead of enumerating denied values.
 */
const TARGET_TOOL_ALLOWLIST = Object.freeze({
  release: true,
  "posture-upgrade": true,
  "posture-override": true,
  "roster-edit-add-contributor": true,
  "new-rule-codify": true,
});

/**
 * Re-derive the canonical bytes the approver covered. Both signer and
 * verifier MUST construct this object identically; field order is fixed
 * by canonicalSerialize's sort-keys-recursively contract.
 *
 * iter-2 Sec-MED-2: approver_verified_id is bound into the canonical
 * bytes. The verifier already resolves the approver pubkey from this
 * field, so a payload-level swap is structurally rejected by sig-verify.
 * Binding it into the signed bytes is defense-in-depth: it makes the
 * contract explicit AND hardens against a future verifier-resolution-
 * layer bug that might somehow accept a mismatched approver_verified_id.
 *
 * @param {object} fields
 * @param {string} fields.target_tool
 * @param {string} fields.requester_person_id
 * @param {string} fields.requester_verified_id
 * @param {string} fields.approver_verified_id  iter-2 Sec-MED-2
 * @param {string} fields.consumed_nonce
 * @param {string} fields.ts          ISO-8601 timestamp
 * @returns {Buffer} canonical bytes ready for cocSign.sign / verify
 */
function canonicalGateApprovalBytes(fields) {
  const f = fields || {};
  const obj = {
    target_tool: f.target_tool,
    requester_person_id: f.requester_person_id,
    requester_verified_id: f.requester_verified_id,
    approver_verified_id: f.approver_verified_id,
    consumed_nonce: f.consumed_nonce,
    ts: f.ts,
  };
  // canonicalSerialize validates undefined/NaN/Infinity and sorts keys;
  // it throws on shape violation. Caller's catch path surfaces as
  // {ok:false, reason:"canonicalSerialize failed: ..."} via verifyGateApproval.
  return cocSign.canonicalSerialize(obj);
}

/**
 * Resolve the roster person whose key.fingerprint == verified_id.
 * Returns {person_id, person, pubkey, keyType} or null.
 */
function _resolveRosterPersonByVerifiedId(roster, verifiedId) {
  if (!roster || !roster.persons || !verifiedId) return null;
  for (const [pid, person] of Object.entries(roster.persons)) {
    const keys = (person && person.keys) || [];
    for (const k of keys) {
      if (k && k.fingerprint === verifiedId) {
        return {
          person_id: pid,
          person,
          pubkey: k.pubkey,
          keyType: k.type || "ssh",
        };
      }
    }
  }
  return null;
}

/**
 * Verify a gate_approval payload against the current invocation context.
 *
 * @param {object} payload       — the tool_input.gate_approval object
 * @param {object} ctx
 * @param {string} ctx.gate                    canonical §6.4 row name
 *                                             derived from current command
 * @param {string} ctx.requester_person_id     current invocation operator
 * @param {string} ctx.requester_verified_id   current invocation operator key
 * @param {string} ctx.requester_nonce         requester-minted nonce
 * @param {object} ctx.roster                  operators roster
 * @param {number} [ctx.now=Date.now()]        wall clock for TTL check
 *
 * @returns {{
 *   ok: boolean,
 *   reason?: string,                          present when ok=false
 *   approverPerson?: object,                  roster-resolved person record
 *   approverVerifiedId?: string,              for downstream audit
 * }}
 *
 * Defense-in-depth ordering: cheap shape checks first, then cryptographic
 * verify (most expensive), then policy checks. The verify-then-binding
 * order is intentional — a forged sig is rejected before nonce/ttl tests
 * even run, so an attacker cannot probe nonce uniqueness by submitting
 * unsigned/forged payloads.
 */
function verifyGateApproval(payload, ctx) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "gate_approval payload missing" };
  }
  if (!ctx || typeof ctx !== "object") {
    return { ok: false, reason: "verify ctx missing" };
  }

  // ---- shape checks ---------------------------------------------------------

  if (typeof payload.sig !== "string" || !payload.sig) {
    return { ok: false, reason: "gate_approval.sig required (MED-1)" };
  }
  if (
    typeof payload.approver_verified_id !== "string" ||
    !payload.approver_verified_id
  ) {
    return {
      ok: false,
      reason: "gate_approval.approver_verified_id required (MED-1)",
    };
  }
  if (typeof payload.target_tool !== "string" || !payload.target_tool) {
    return { ok: false, reason: "gate_approval.target_tool required (MED-2)" };
  }
  if (typeof payload.consumed_nonce !== "string" || !payload.consumed_nonce) {
    return {
      ok: false,
      reason: "gate_approval.consumed_nonce required (MED-2)",
    };
  }
  if (typeof payload.ts !== "string" || !payload.ts) {
    return { ok: false, reason: "gate_approval.ts required (MED-2)" };
  }
  if (typeof ctx.gate !== "string" || !ctx.gate) {
    return { ok: false, reason: "ctx.gate required" };
  }
  if (
    typeof ctx.requester_person_id !== "string" ||
    !ctx.requester_person_id
  ) {
    return { ok: false, reason: "ctx.requester_person_id required" };
  }
  if (
    typeof ctx.requester_verified_id !== "string" ||
    !ctx.requester_verified_id
  ) {
    return { ok: false, reason: "ctx.requester_verified_id required" };
  }
  if (typeof ctx.requester_nonce !== "string" || !ctx.requester_nonce) {
    return { ok: false, reason: "ctx.requester_nonce required (MED-2)" };
  }

  // ---- target_tool allowlist (MED-2 + MED-3) -------------------------------

  if (!TARGET_TOOL_ALLOWLIST[payload.target_tool]) {
    return {
      ok: false,
      reason: `gate_approval.target_tool '${payload.target_tool}' not in allowlist (MED-2)`,
    };
  }

  // ---- target_tool matches current invocation (MED-2 cross-surface replay) -

  if (payload.target_tool !== ctx.gate) {
    return {
      ok: false,
      reason: `target_tool mismatch: gate_approval signed for '${payload.target_tool}'; current invocation is '${ctx.gate}' (MED-2 cross-surface replay defense)`,
    };
  }

  // ---- nonce binding (MED-2) -----------------------------------------------

  if (payload.consumed_nonce !== ctx.requester_nonce) {
    return {
      ok: false,
      reason: `consumed_nonce mismatch: gate_approval covers '${payload.consumed_nonce}'; requester minted '${ctx.requester_nonce}' for this invocation (MED-2)`,
    };
  }

  // ---- TTL (MED-2) ---------------------------------------------------------

  const now = typeof ctx.now === "number" ? ctx.now : Date.now();
  const tsMs = Date.parse(payload.ts);
  if (!Number.isFinite(tsMs)) {
    return {
      ok: false,
      reason: `gate_approval.ts '${payload.ts}' not a parseable timestamp (MED-2)`,
    };
  }
  const ageMs = now - tsMs;
  if (ageMs > GATE_APPROVAL_TTL_MS) {
    return {
      ok: false,
      reason: `gate_approval expired: ts is ${Math.floor(ageMs / 1000)}s old (TTL ${GATE_APPROVAL_TTL_MS / 1000}s, ~24h) (MED-2)`,
    };
  }
  // Allow small clock skew but reject clearly-future ts (5min tolerance).
  if (ageMs < -5 * 60 * 1000) {
    return {
      ok: false,
      reason: `gate_approval.ts is in the future by ${Math.floor(-ageMs / 1000)}s (MED-2)`,
    };
  }

  // ---- roster resolution (MED-1 + MED-4) -----------------------------------

  const resolved = _resolveRosterPersonByVerifiedId(
    ctx.roster,
    payload.approver_verified_id,
  );
  if (!resolved) {
    return {
      ok: false,
      reason: `approver_verified_id '${payload.approver_verified_id}' not in roster (MED-1)`,
    };
  }

  // R5-S-04 + role-floor check via the single eligibility predicate. The
  // gate matrix re-runs this check downstream; doing it here too is
  // defense-in-depth + provides a clearer rejection reason at the
  // verify boundary.
  const elig = isEligibleSigner(resolved.person, "gate-approval");
  if (!elig.eligible) {
    return {
      ok: false,
      reason: `approver role ineligible: ${elig.reason} (MED-1)`,
    };
  }

  // ---- cryptographic verify (MED-1) ----------------------------------------
  // Re-derive canonical bytes from the payload's claimed signed-payload
  // fields. If the attacker omitted any field, this shape check + verify
  // fails. The verify call is against the roster-resolved pubkey, NOT
  // any pubkey hint in the payload.

  let canonicalBytes;
  try {
    canonicalBytes = canonicalGateApprovalBytes({
      target_tool: payload.target_tool,
      requester_person_id: ctx.requester_person_id,
      requester_verified_id: ctx.requester_verified_id,
      approver_verified_id: payload.approver_verified_id, // iter-2 Sec-MED-2
      consumed_nonce: payload.consumed_nonce,
      ts: payload.ts,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `canonicalSerialize failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
  let verifyResult;
  try {
    verifyResult = cocSign.verify(canonicalBytes, payload.sig, resolved.pubkey, {
      keyType: resolved.keyType,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `verify threw: ${err && err.message ? err.message : String(err)}`,
    };
  }
  if (!verifyResult || !verifyResult.ok) {
    return {
      ok: false,
      reason: `verify call failed: ${verifyResult && verifyResult.reason ? verifyResult.reason : "unknown"}`,
    };
  }
  if (!verifyResult.valid) {
    return {
      ok: false,
      reason: `signature did not verify: ${verifyResult.reason || "invalid"}`,
    };
  }

  return {
    ok: true,
    approverPerson: resolved.person,
    approverPersonId: resolved.person_id,
    approverVerifiedId: payload.approver_verified_id,
  };
}

module.exports = {
  GATE_APPROVAL_TTL_MS,
  TARGET_TOOL_ALLOWLIST,
  canonicalGateApprovalBytes,
  verifyGateApproval,
};
