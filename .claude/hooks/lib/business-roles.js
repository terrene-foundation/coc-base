/**
 * business-roles — PURE READ predicates over `roster.persons[*].business_roles`
 * (ECO-IMPL W4-S2 / Roles-T1).
 *
 * `business_roles` is the OPTIONAL, advisory operating-model classification
 * shipped on the roster schema (`.claude/operators.roster.schema.json:94-104` —
 * an array enum ∈ {platform-engineer, capability-engineer, business-consultant},
 * NOT in `required`, per `specs/06 §2` / ratified journal/0282, INFRA fold
 * journal/0284).
 *
 * The HIGHEST-CORRECTNESS invariant this module holds (the whole reason it is a
 * standalone, dependency-free lib) is that `business_roles` is **advisory +
 * capability-scoping ONLY** — NEVER quorum-eligible, NEVER consulted by any
 * distinctness / gate-approval / genesis / migration predicate, and ORTHOGONAL
 * to BOTH the authority `role` (owner/senior/contributor) AND the trust-posture
 * (L1–L5) (`rules/multi-operator-coordination.md §1`). To make that orthogonality
 * STRUCTURAL rather than aspirational, this module:
 *   - imports NONE of the quorum / gate / distinctness / genesis / migration
 *     modules (`operator-gate.js`, `fold-rule-*.js`, `derive-n.js`,
 *     `genesis-ceremony.js`, ...);
 *   - exposes NO write / emit / sign surface — every predicate is a pure read
 *     over an already-loaded roster object;
 *   - returns a defined empty value (never throws, never defaults to a role) on
 *     an absent `business_roles` (a pre-model roster) so a quorum/gate path
 *     could not even ACCIDENTALLY read a synthesized role out of this module.
 *
 * The three invariants (W4-S2):
 *   (i)   every predicate is READ-ONLY over the roster (no write/emit/sign).
 *   (ii)  NO predicate is consulted by any quorum/distinctness/gate-approval/
 *         genesis/migration path (proven by the structural import-sweep test).
 *   (iii) absent `business_roles` (pre-model roster) → empty set, never throws,
 *         never defaults to a role.
 *
 * Style: CommonJS, no external deps, mirrors `operator-id.js`'s roster-access
 * convention (`roster.persons[personId]`, defensive on shape).
 */

"use strict";

// The canonical enum of advisory business roles (mirrors the schema's
// `business_roles.items.enum`). Used only by the capability-scoping helper's
// home mapping; the read predicates do NOT validate against it (an unknown
// value already present on a roster is surfaced as-is, not silently dropped —
// validation is the roster-ceremony's job, not this read lib's).
const BUSINESS_ROLES = Object.freeze([
  "platform-engineer",
  "capability-engineer",
  "business-consultant",
]);

// The role-first HOME mapping (advisory, capability-scoping ONLY): which
// `business_role` may ORIGINATE which artifact lane, per `specs/06 §2` +
// `rules/artifact-flow.md` § The Origination Taxonomy (O1/O2/O3).
//   capability-engineer → build  (runtime-consumed capabilities)
//   platform-engineer   → loom   (the ecosystem/dev-process machine)
//   business-consultant → use    (specific products on use-templates)
// This is a READ-ONLY advisory lookup. It is NOT a gate: nothing here decides
// whether an origination is ALLOWED — it answers "which lane is this role's
// home?" for capability-scoping surfaces (e.g. the A2 lane router) to consult.
const ROLE_HOME_LANE = Object.freeze({
  "capability-engineer": "build",
  "platform-engineer": "loom",
  "business-consultant": "use",
});

// ---- helpers ----------------------------------------------------------------

/**
 * Resolve a person's record from an already-loaded roster object, mirroring
 * `operator-id.js::_findPersonByFingerprint`'s defensive shape handling.
 * Returns the person record or null (never throws on a malformed roster).
 */
function _person(roster, personId) {
  if (!roster || typeof roster !== "object") return null;
  if (typeof personId !== "string" || !personId) return null;
  const persons = roster.persons;
  if (!persons || typeof persons !== "object") return null;
  const person = persons[personId];
  if (!person || typeof person !== "object") return null;
  return person;
}

// ---- public API -------------------------------------------------------------

/**
 * getBusinessRoles(roster, personId) → string[]
 *
 * The advisory `business_roles` array for a person. Returns a FRESH array
 * (a copy — never the roster's own array reference, so a caller cannot mutate
 * roster state through the return value; reinforces invariant (i)).
 *
 * Invariant (iii): absent `business_roles` (pre-model roster, absent person, or
 * malformed roster) → `[]`. Never throws, never defaults to a role.
 *
 * @param {object} roster   the loaded operators.roster.json object
 * @param {string} personId the person_id to read
 * @returns {string[]}      a fresh copy of the person's business_roles, or []
 */
function getBusinessRoles(roster, personId) {
  const person = _person(roster, personId);
  if (!person) return [];
  const roles = person.business_roles;
  if (!Array.isArray(roles)) return []; // absent / non-array → empty set
  // Copy + keep only string entries (defensive against a malformed roster);
  // do NOT synthesize or default — an empty/garbage array stays empty.
  return roles.filter((r) => typeof r === "string");
}

/**
 * hasBusinessRole(roster, personId, role) → boolean
 *
 * True iff the person carries `role` in their advisory `business_roles`.
 * Invariant (iii): absent → false (never throws, never defaults to true).
 *
 * @param {object} roster
 * @param {string} personId
 * @param {string} role
 * @returns {boolean}
 */
function hasBusinessRole(roster, personId, role) {
  if (typeof role !== "string" || !role) return false;
  return getBusinessRoles(roster, personId).includes(role);
}

/**
 * isCapabilityRatifierEligible(roster, personId) → boolean
 *
 * The A2-T2 classifier's F1 ratifier-eligibility predicate: true iff the person
 * carries `capability-engineer` OR `platform-engineer` in `business_roles`.
 *
 * IMPORTANT — this is the ONLY gate-ADJACENT consumer of `business_roles`, and
 * it is a CAPABILITY-SCOPING ADVISORY check, NOT an authority / quorum check:
 *   - it scopes WHICH role may ratify a LOW-confidence capability-class proposal
 *     (a capability-domain advisory judgment), it does NOT decide quorum,
 *     distinctness, or any authority gate;
 *   - the AUTHORITY half of the A2-T2 F1 binding (the ratifier's `person_id`
 *     MUST differ from the T0 signer's `person_id`) lives in the AUTHORITY
 *     triple (`person_id` distinctness), NOT here — this predicate composes
 *     WITH that authority check, it never substitutes for it.
 * Keeping this predicate in THIS module (which imports no quorum/gate surface)
 * is what keeps `business_roles` structurally out of the authority plane: the
 * A2 classifier calls this advisory predicate AND, separately, the authority
 * distinctness check — the two never merge into a `business_roles`-driven gate.
 *
 * Invariant (iii): absent → false (never throws, never defaults to eligible).
 *
 * @param {object} roster
 * @param {string} personId
 * @returns {boolean}
 */
function isCapabilityRatifierEligible(roster, personId) {
  return (
    hasBusinessRole(roster, personId, "capability-engineer") ||
    hasBusinessRole(roster, personId, "platform-engineer")
  );
}

/**
 * capabilityScopingLane(roster, personId) → string[]
 *
 * Advisory capability-SCOPING helper: the set of artifact-origination lanes a
 * person's `business_roles` may ORIGINATE into, per the role-first HOME mapping
 * (`ROLE_HOME_LANE`). Read-only, advisory — answers "which lanes are this
 * operator's home?" for a capability-scoping surface (e.g. the A2 lane router)
 * to consult. It is NOT a gate: it never decides whether an origination is
 * permitted; the per-lane human gate (`rules/artifact-flow.md`) owns that.
 *
 * Returns a de-duplicated, mapping-ordered array of lane names (a person with
 * ≥2 business_roles may home into ≥2 lanes). Invariant (iii): absent → `[]`.
 *
 * @param {object} roster
 * @param {string} personId
 * @returns {string[]}  e.g. ["build"], ["loom"], or ["build","loom"]
 */
function capabilityScopingLane(roster, personId) {
  const roles = getBusinessRoles(roster, personId);
  if (roles.length === 0) return []; // pre-model / absent → empty set
  const lanes = [];
  // Iterate the canonical mapping order so output is deterministic regardless
  // of the order roles appear on the roster.
  for (const role of BUSINESS_ROLES) {
    if (roles.includes(role)) {
      const lane = ROLE_HOME_LANE[role];
      if (lane && !lanes.includes(lane)) lanes.push(lane);
    }
  }
  return lanes;
}

module.exports = {
  getBusinessRoles,
  hasBusinessRole,
  isCapabilityRatifierEligible,
  capabilityScopingLane,
  // Constants exposed for downstream consumers (the A2 lane router) + tests.
  // These are frozen advisory data, NOT a gate surface.
  BUSINESS_ROLES,
  ROLE_HOME_LANE,
};
