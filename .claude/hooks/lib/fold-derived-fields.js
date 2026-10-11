/**
 * fold-derived-fields — the ONE list of field names only the FOLD may compute.
 *
 * WHY THIS MODULE EXISTS (L-REVOKE root fix, orchestrator ruling 2026-10-10)
 *   A value the fold derives — rule 10's contest verdict, the body-anchor tamper
 *   flag, the presence attribution, settlement, derived-N and its parts — means
 *   something only because the fold computed it. A record body that already
 *   carries one of these names is its producer asserting the fold's verdict on
 *   itself. MEASURED before this module: the fold's uncontested accept path kept
 *   a signer's own `rule10_contested: false` intact in accepted[], and that is
 *   precisely the verdict operator-gate requires to unlock an owner removal.
 *
 * THE CONTRACT, two consumers of one list:
 *   - coordination-log.js::_foldLog REJECTS any record whose own top-level keys
 *     include a name here, with the typed reason DERIVED_FIELD_REJECTION, before
 *     any rule reads the record — so the fold never reads a producer's value.
 *   - operator-gate.js::departureRevocation trusts its corroboration verdict
 *     only under a name this list reserves.
 *   A name added here is rejected by the fold and trusted by the gate in the
 *   same change; a name removed here stops being either.
 *
 * Only TOP-LEVEL keys are checked. Every derived value is a top-level
 * annotation on a fold copy or a field of fold output; none is read from inside
 * a record's `content`.
 *
 * Style: CommonJS, zero-dep, pure. No I/O.
 */

"use strict";

const DERIVED_FIELD_NAMES = Object.freeze([
  // Stamped by the fold onto its accepted copies.
  "rule10_contested",
  "body_anchor_tampered",
  "_presence_attribution",
  // Computed by the fold or its predicates; never a record field.
  "settled",
  "derivedN",
  "derived_N",
  "live_logins",
  "per_login_latest",
]);

/** The typed rejection reason the fold records for such a record. */
const DERIVED_FIELD_REJECTION = "derived field in record body";

const _DERIVED = new Set(DERIVED_FIELD_NAMES);

/** Is `name` a field only the fold may compute? */
function isDerivedField(name) {
  return _DERIVED.has(name);
}

/**
 * The record's own top-level keys that only the fold may compute, in the
 * record's key order. Empty for anything that is not a plain object.
 */
function derivedFieldsIn(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  return Object.keys(record).filter((k) => _DERIVED.has(k));
}

module.exports = {
  DERIVED_FIELD_NAMES,
  DERIVED_FIELD_REJECTION,
  isDerivedField,
  derivedFieldsIn,
};
