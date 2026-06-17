/**
 * cascade-gate — the §4.4 cascade gate: fire ONLY on the PROVEN intersection.
 *
 * ECO-IMPL Wave 3, Shard A1-T5. Implements
 * `workspaces/ecosystem-operating-model/02-plans/07-cascade-membership.md`
 * §4.4 (the cascade gate — the consumer of the §5 proof-grade head) +
 * §2/§3.3 (the fail-safe asymmetry); normative `specs/06 §7`.
 *
 * Every cascade — 08 T5 `cascade-fired`, every `/sync` pull, every version-pin
 * advance — AND 08's retirement fold (§4.4 cond-4, the SAME gate at fold time)
 * fires for a project P into ecosystem E ONLY when the §3.3 intersection holds
 * at the §5 proof-grade head. A cascade is a fold consequence of PROVEN
 * membership, never a one-shot trust of a stale list. This shard is the gate
 * primitive those consumers call; it does NOT itself wire `/sync-to-use` or 08
 * T5 (those ride W7 / W5 respectively — no phantom wiring is fabricated here,
 * `spec-accuracy.md` Rule 1/7). It is consumed exactly as A1-T3's head is a
 * forward dependency of A1-T4/T5/08.
 *
 * THE FAIL-SAFE ASYMMETRY (§4.4) made literal — "cheap state is authoritative
 * ONLY toward the SAFE direction":
 *
 *   - Any cached/projected membership state — a fresh `reconciliation-
 *     attestation`, the locally-folded registry, OR 08's in-ledger
 *     `membership-severed` projection (§7 S3) — is authoritative ONLY for
 *     SUPPRESSION. A sever PRESENT in any of them → SUPPRESS FAST (severs are
 *     monotone, M2; a present sever is always current), with NO §5 head
 *     re-fetch. This is the `projectedSever` short-circuit.
 *   - ABSENCE of a sever in cached/projected state NEVER licenses a FIRE —
 *     because the absence may be a not-yet-persisted sever (the
 *     off-loom-suppression / partial-push interval). Every FIRE (cascade or
 *     retirement) therefore ALWAYS pays the §5 head re-fetch of P's CURRENT
 *     pointer (F1 / 08 cond-4), which sees a flip live regardless of whether
 *     any sever record has been persisted. The cheap path moves ONLY toward
 *     non-membership; the unsafe direction always pays full proof.
 *
 * This closes the 07→08 projection seam (NEW-HIGH-1): a sibling clone folding
 * 08's ledger for a DIFFERENT workaround `(Y,P)` cannot fire on
 * absence-of-projection — its fire re-fetches P's pointer and suppresses. The
 * projection only ever makes a SUPPRESS faster; it never makes a FIRE cheaper.
 *
 * Two consumers, two entry points:
 *   - `cascadeGate(opts)` — the full gate: the `projectedSever` short-circuit,
 *     else delegate to the §5 head (`membership-head.js::proveMembership`) and
 *     apply the fire policy. The cascade caller (08 T5 / `/sync` pull) uses this.
 *   - `decideFromProof(proof)` — the PURE policy over an ALREADY-computed head
 *     proof, for a caller (08's retirement fold) that has already run
 *     `proveMembership` and only needs the fire/suppress verdict without paying
 *     the re-fetch twice.
 *
 * Style: CommonJS, sync, zero-dep beyond the shared lib. Per
 * zero-tolerance.md Rule 3: every path returns a typed disposition; no silent
 * fallback. A read-only POLICY layer over the head — it performs ZERO writes
 * (mirrors the head's read-only-proof property, §5 F3 / HIGH-1).
 */

"use strict";

const head = require("./membership-head.js");

// Gate dispositions. ALLOW (fire) is reachable ONLY via the head's
// PROVEN_MEMBER; every other disposition is a non-fire (suppress / defer).
const ALLOW = "ALLOW"; // PROVEN intersection — the cascade/retirement MAY fire
const SUPPRESS = "SUPPRESS"; // proven non-member (head PROVEN_SEVERED) — do not fire
const SUPPRESS_PROJECTED = "SUPPRESS_PROJECTED"; // a sever present in cheap/projected state — fast suppress, no head re-fetch
const DEFER = "DEFER"; // head could not prove (provider partition) — withhold, re-evaluate later

/**
 * Decide the cascade fire/suppress verdict from an ALREADY-computed §5 head
 * proof (`membership-head.js::proveMembership` result). The PURE policy half —
 * no fetch, no write. Use this when the caller has already run the head (08's
 * retirement fold) and only needs the fire policy.
 *
 * The mapping is total and fail-safe: ONLY a PROVEN_MEMBER licenses a fire;
 * PROVEN_SEVERED suppresses; DEFER withholds; anything malformed/unknown
 * withholds (fail-closed — never fire on an unrecognized proof).
 *
 * @param {object} proof - a proveMembership result ({ disposition, fire, ... }).
 * @returns {{ allow: boolean, disposition: string, proof: object, reason: string }}
 */
function decideFromProof(proof) {
  const p = proof || {};
  // FIRE is gated on BOTH the disposition AND the explicit fire boolean — a
  // belt-and-suspenders check so a future head change that sets one without the
  // other cannot silently license a fire.
  if (p.disposition === head.PROVEN_MEMBER && p.fire === true) {
    return {
      allow: true,
      disposition: ALLOW,
      proof: p,
      reason:
        "ALLOW — PROVEN intersection at the §5 head (registry admission active AND P's CURRENT pointer names E); cascade/retirement may fire (§4.4)",
    };
  }
  if (p.disposition === head.PROVEN_SEVERED) {
    return {
      allow: false,
      disposition: SUPPRESS,
      proof: p,
      reason: `SUPPRESS — PROVEN severed / non-member at the §5 head (fail-safe, single-sided exclusion): ${p.reason || "no reason"}`,
    };
  }
  if (p.disposition === head.DEFER) {
    return {
      allow: false,
      disposition: DEFER,
      proof: p,
      reason: `DEFER — the §5 head could not PROVE membership (provider partition); withhold, re-evaluate on a later fold (§6.1 safety unconditional): ${p.reason || "no reason"}`,
    };
  }
  // Unknown / malformed proof → fail-closed (never fire on an unrecognized
  // disposition). This also covers `fire: true` paired with a non-PROVEN_MEMBER
  // disposition — the conjunction above already blocks it.
  return {
    allow: false,
    disposition: DEFER,
    proof: p,
    reason: `DEFER (fail-closed) — unrecognized head disposition '${p.disposition}'; withholding the fire (no fire on an unproven intersection)`,
  };
}

/**
 * The full cascade gate. Applies the §4.4 fail-safe asymmetry:
 *
 *   1. If cheap/projected state shows a sever PRESENT (`opts.projectedSever ===
 *      true`) → SUPPRESS_PROJECTED fast, with NO §5 head re-fetch (severs are
 *      monotone; a present sever is always current — the cheap path toward the
 *      SAFE direction).
 *   2. Otherwise — absence of a projected sever NEVER licenses a fire — ALWAYS
 *      pay the §5 head re-fetch via `proveMembership(opts)`, then apply
 *      `decideFromProof`. A fresh cache does NOT short-circuit a FIRE; the head
 *      itself re-fetches P's CURRENT pointer on every fire (F1).
 *
 * `opts.projectedSever` is the boolean abstraction of "any cheap state (a fresh
 * attestation, the local registry fold, 08's in-ledger projection) shows a
 * sever for P". There is DELIBERATELY no `projectedMember` / `projectedFresh`
 * fire short-circuit — the cheap path is suppress-only by construction.
 *
 * @param {object} opts - the `proveMembership` opts (ecosystemId, projectId,
 *   registryRoster, pointerRoster, fetchRegistryRecords, fetchPointerRecords)
 *   PLUS optional `projectedSever` (boolean) + optional `proveMembership`
 *   override (tests).
 * @returns {{ allow: boolean, disposition: string, proof: object|null, reason: string }}
 */
function cascadeGate(opts) {
  const o = opts || {};

  // `projectedSever` is the BOOLEAN abstraction of "cheap state shows a sever".
  // A defined-but-non-boolean value is a caller-contract bug: rather than
  // silently falling through to a full proof (which is safe-direction but hides
  // the caller's mistake), fail CLOSED with a typed reason (zero-tolerance.md
  // Rule 3a — guard with a typed signal before the truthiness branch). Still no
  // wrong fire: a malformed projectedSever can NEVER license a cascade.
  if (o.projectedSever !== undefined && typeof o.projectedSever !== "boolean") {
    return {
      allow: false,
      disposition: DEFER,
      proof: null,
      reason: `DEFER (fail-closed) — opts.projectedSever must be a boolean (got ${typeof o.projectedSever}); a malformed projected-state signal never licenses a fire`,
    };
  }

  // [invariant 2] the fail-safe asymmetry — cheap state suppresses fast, but
  // ONLY toward the safe direction. A present projected sever is monotone and
  // always current → suppress without paying the head re-fetch.
  if (o.projectedSever === true) {
    return {
      allow: false,
      disposition: SUPPRESS_PROJECTED,
      proof: null,
      reason:
        "SUPPRESS_PROJECTED — a sever is present in cached/projected state (a fresh attestation / local registry fold / 08 in-ledger projection); severs are monotone (M2) so a present sever is always current → fast suppress, no §5 head re-fetch (§4.4)",
    };
  }

  // [invariant 1 + 2] absence of a projected sever NEVER licenses a fire —
  // ALWAYS pay the §5 head re-fetch (the head re-fetches P's CURRENT pointer on
  // every fire, F1). The fire decision is the head's PROVEN_MEMBER alone.
  const proveMembership = o.proveMembership || head.proveMembership;
  const proof = proveMembership(o);
  return decideFromProof(proof);
}

module.exports = {
  cascadeGate,
  decideFromProof,
  ALLOW,
  SUPPRESS,
  SUPPRESS_PROJECTED,
  DEFER,
};
