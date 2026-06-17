/**
 * capability-classifier — the A2 T1 classifier: a DUMB validator + emitter for
 * the system-proposes / ratify-by-exception need-classification step.
 *
 * ECO-IMPL Wave 4, Shard W4-S3 (A2-T2). The directive's literal subject:
 * "consultants will not know if its a new capability" — so classification
 * CANNOT be a consultant act. Implements
 * `workspaces/ecosystem-operating-model/02-plans/08-capability-lifecycle.md`
 * §3.1 (the classifier — signal / discriminator / confidence threshold /
 * F1 ratifier binding) + §8 NEW-3 (the fingerprint-collision residual);
 * normative `specs/06 §5(a)`.
 *
 * THE LLM-REASONS / DUMB-EMITTER SPLIT (rules/agent-reasoning.md +
 * rules/probe-driven-verification.md MUST-1):
 *   The CLASS JUDGMENT is the orchestrating agent's (the LLM's) reasoning. At
 *   runtime the agent reads the T0 workaround SHAPE + the missing repo surface
 *   + the discriminator SIGNAL DATA this lib surfaces, and PROPOSES a
 *   `class ∈ {capability,bug,product-tweak,methodology}` + a `confidence`.
 *   Those are INPUTS to this lib. This lib contains NO keyword / regex /
 *   substring classifier — that is the naive-NLP anti-pattern
 *   probe-driven-verification.md BLOCKS. The lib provides ONLY the
 *   DETERMINISTIC parts:
 *     (a) discriminate(repoDir, needFingerprint, roster) — the SIGNAL DATA the
 *         LLM reads (does a folded capability-registered already cover this
 *         need_fingerprint? what is the T0 signer's person_id? is the need
 *         already classified?). DATA, never a class verdict.
 *     (b) the confidence-threshold GATE (HIGH → auto-commit; LOW → route).
 *     (c) the F1 ratifier-distinctness validation (the forgery defense).
 *     (d) the need-classified emission (via capability-ledger.js).
 *
 * THE §8 FINGERPRINT-COLLISION RESIDUAL (NEW-3) — NAMED, NOT FAKE-HANDLED
 * (per spec-accuracy.md Rule 3):
 *   A fingerprint COLLISION (two genuinely-different needs that fingerprint
 *   alike) by construction makes a need LOOK like a known shape, which RAISES
 *   apparent confidence — so a collision auto-commits HIGH-confidence-AND-WRONG
 *   rather than surfacing as LOW-confidence. This lib therefore MUST NOT treat
 *   a HIGH-confidence proposal as collision-free: HIGH means "the LLM is
 *   confident given the (possibly-colliding) fingerprint", NOT "the fingerprint
 *   is unique". Collision DETECTION is the fingerprint-SCHEME sub-design's job
 *   (§8 OPEN), NOT this lib's. This lib names the residual; it does not pretend
 *   to catch it. The auto-commit path carries a `collision_residual` note on
 *   its return so a caller cannot read "committed HIGH" as "collision-checked".
 *
 * SCOPE BOUNDARY (load-bearing — NOT this shard):
 *   - NO T2 routing (`need-routed`), NO T3 build, NO retirement.
 *   - NO classifier for non-need inputs.
 *   - This lib does NOT implement an LLM call; `class` + `confidence` are
 *     inputs (the orchestrating agent reasons + calls in).
 *   Just T1 classify: validate the proposal, gate on confidence, enforce F1,
 *   emit (or route).
 *
 * Style: CommonJS, sync, zero-dep beyond the shared capability-ledger +
 * business-roles libs. Per zero-tolerance.md Rule 2/3: no stubs; every failure
 * path returns a typed result; no silent fallback.
 */

"use strict";

const capabilityLedger = require("./capability-ledger.js");
const foldCapabilityLedger = require("./fold-capability-ledger.js");
const { isCapabilityRatifierEligible } = require("./business-roles.js");

// The confidence levels the LLM caller may propose. A numeric confidence is
// ALSO accepted (a float in [0,1]) and gated against a threshold; the
// canonical symbolic levels map to the gate directly.
const CONFIDENCE_HIGH = "HIGH";
const CONFIDENCE_LOW = "LOW";
const CONFIDENCE_LEVELS = new Set([CONFIDENCE_HIGH, CONFIDENCE_LOW]);

// The numeric auto-commit threshold (used only when the caller passes a numeric
// confidence). A numeric confidence >= this auto-commits; below it routes.
// Symbolic HIGH/LOW bypass this (they map directly to the gate).
const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

// The system-auto confirmed_by sentinel (the HIGH-confidence autonomous path).
const CONFIRMED_BY_SYSTEM_AUTO = "system-auto";

// The closed need-class set (re-exported from the fold SSOT so emit, fold, and
// classify cannot drift).
const NEED_CLASSES = foldCapabilityLedger.NEED_CLASSES;

// ---------------------------------------------------------------------------
// discriminate — deterministic SIGNAL DATA for the LLM to reason over.
// NOT a class verdict. Pure read over the folded ledger.
// ---------------------------------------------------------------------------
/**
 * Surface the deterministic discriminator signal data the §3.1 classifier
 * reads. The LLM reasons over this data + the T0 workaround shape + the
 * missing repo surface to PROPOSE a class; this function decides NOTHING about
 * the class.
 *
 * Returns:
 *   {
 *     need_fingerprint,
 *     // §3.1 discriminator Q1: does a folded capability-registered already
 *     // cover this need_fingerprint (via a supersedes-rebind binding)? If so,
 *     // it is NOT a new capability — the LLM routes it as a bug / version-bump
 *     // against the EXISTING capability rather than minting a new one.
 *     existing_capability_id: string | null,
 *     // Has this need already been classified (a need-classified folded)? The
 *     // LLM uses this to avoid re-classifying an already-resolved need.
 *     already_classified: boolean,
 *     existing_class: string | null,
 *     // The T0 workaround-registered signer's person_id (the F1 binding's
 *     // distinctness anchor — a ratifier MUST differ from this). null if no
 *     // T0 workaround for this fingerprint has folded.
 *     t0_signer_person_id: string | null,
 *     t0_workaround_ref: string | null,
 *     // Whether the T0 rails-and-workaround chain has folded at all (the
 *     // need exists in the ledger).
 *     workaround_present: boolean,
 *   }
 */
function discriminate(repoDir, needFingerprint, roster) {
  if (typeof needFingerprint !== "string" || !needFingerprint) {
    return {
      ok: false,
      error: "invalid argument",
      reason: "needFingerprint must be a non-empty string",
    };
  }
  const { folded } = capabilityLedger.foldLedger(repoDir, roster);
  const cl = (folded &&
    folded.foldState &&
    folded.foldState.capabilityLedger) || {
    needs: {},
    capabilities: {},
  };

  // Q1 — does an existing capability already cover this fingerprint? The
  // binding is the folded need's rebind.capability_id (set by a
  // supersedes-rebind), gated on the capability actually being registered.
  const need = (cl.needs && cl.needs[needFingerprint]) || null;
  let existingCapabilityId = null;
  if (
    need &&
    need.rebind &&
    typeof need.rebind.capability_id === "string" &&
    cl.capabilities &&
    cl.capabilities[need.rebind.capability_id]
  ) {
    existingCapabilityId = need.rebind.capability_id;
  }

  const alreadyClassified = !!(need && typeof need.class === "string");
  const existingClass = alreadyClassified ? need.class : null;

  // The T0 signer's person_id — scanned from the ACCEPTED workaround-registered
  // record for this fingerprint (the deterministic distinctness anchor for F1).
  let t0SignerPersonId = null;
  let t0WorkaroundRef = null;
  let workaroundPresent = false;
  const accepted = (folded && folded.accepted) || [];
  for (const r of accepted) {
    if (
      r &&
      r.type === foldCapabilityLedger.TYPE_WORKAROUND_REGISTERED &&
      r.content &&
      r.content.need_fingerprint === needFingerprint
    ) {
      workaroundPresent = true;
      // First-folded T0 signer is the binding anchor (a later workaround for
      // the same fingerprint from a DIFFERENT project shares the fingerprint
      // but the FIRST signer is the one who could-not-classify).
      // NOTE (sec R1 L1): "first-folded" is first in THIS clone's fold order,
      // NOT globally-first-emitted — under partial-push lag two clones can fold
      // same-fingerprint workarounds in different orders. Bounded by: (a) every
      // candidate record is signature-gated (fold rule 1, so the anchor is
      // always a rostered key), and (b) the F1 person_id-distinctness check
      // (classifyNeed) holds regardless of WHICH valid signer is anchored — a
      // T0 signer still cannot self-ratify. The anchor choice affects only
      // WHICH distinct ratifier is required, never whether distinctness holds.
      if (t0SignerPersonId === null && typeof r.person_id === "string") {
        t0SignerPersonId = r.person_id;
        t0WorkaroundRef =
          typeof r.content.workaround_ref === "string"
            ? r.content.workaround_ref
            : null;
      }
    }
  }

  return {
    ok: true,
    need_fingerprint: needFingerprint,
    existing_capability_id: existingCapabilityId,
    already_classified: alreadyClassified,
    existing_class: existingClass,
    t0_signer_person_id: t0SignerPersonId,
    t0_workaround_ref: t0WorkaroundRef,
    workaround_present: workaroundPresent,
  };
}

// ---------------------------------------------------------------------------
// Confidence gate (deterministic part b)
// ---------------------------------------------------------------------------
/**
 * Resolve the LLM's proposed confidence to a boolean auto-commit decision.
 * Symbolic HIGH/LOW map directly; a numeric confidence is gated against
 * `threshold`. Returns { ok, autoCommit } or { ok:false, error, reason } on a
 * malformed confidence (typed failure — never a silent default).
 */
function _resolveAutoCommit(confidence, threshold) {
  if (typeof confidence === "string") {
    const up = confidence.toUpperCase();
    if (!CONFIDENCE_LEVELS.has(up)) {
      return {
        ok: false,
        error: "invalid confidence",
        reason: `confidence string must be one of ${[...CONFIDENCE_LEVELS].join(", ")} (got '${confidence}')`,
      };
    }
    return { ok: true, autoCommit: up === CONFIDENCE_HIGH };
  }
  if (typeof confidence === "number" && Number.isFinite(confidence)) {
    if (confidence < 0 || confidence > 1) {
      return {
        ok: false,
        error: "invalid confidence",
        reason: `numeric confidence must be in [0,1] (got ${confidence})`,
      };
    }
    return { ok: true, autoCommit: confidence >= threshold };
  }
  return {
    ok: false,
    error: "invalid confidence",
    reason: "confidence must be 'HIGH' / 'LOW' or a number in [0,1]",
  };
}

// ---------------------------------------------------------------------------
// classifyNeed — the dumb validator + emitter (the shard's load-bearing API)
// ---------------------------------------------------------------------------
/**
 * The T1 classify step. The LLM has already proposed `proposedClass` +
 * `confidence`; this function validates, gates on confidence, enforces the F1
 * ratifier binding, and either auto-commits a `need-classified` record OR
 * returns a ratify-by-exception routing.
 *
 * Invariants (the four W4-S3 invariants, each enforced by a named branch):
 *   (i)   the consultant NEVER classifies — the ONLY consultant-derived input
 *         is the T0 record's need_fingerprint (read here) + the T0 signer's
 *         person_id (read for the F1 distinctness check). The CLASS is the
 *         LLM's `proposedClass`, NEVER a consultant judgment. No consultant
 *         judgment is an input to this function.
 *   (ii)  HIGH confidence → auto-commit need-classified{confirmed_by:
 *         "system-auto"}; LOW confidence → routed, NEVER auto-committed.
 *   (iii) F1 ratifier binding — a non-`system-auto` confirmed_by (a human
 *         ratifier) MUST have person_id ≠ the T0 signer's person_id AND
 *         isCapabilityRatifierEligible true. A T0-signer self-ratifying is
 *         REJECTED (the A2 crux forgery).
 *   (iv)  the §8 fingerprint-COLLISION residual is NAMED, not silently
 *         mis-bound — the auto-commit return carries a collision_residual note
 *         so a caller cannot read "HIGH committed" as "collision-free".
 *
 * @param {object} opts
 * @param {string} opts.repoDir          - repo whose capability ledger to emit into
 * @param {string} opts.needFingerprint  - the T0 need_fingerprint (consultant-derived; the ONLY consultant input)
 * @param {string} opts.proposedClass    - the LLM's proposed class ∈ NEED_CLASSES
 * @param {string|number} opts.confidence- the LLM's confidence ('HIGH'/'LOW' or [0,1])
 * @param {string} [opts.confirmedBy]    - 'system-auto' (auto path) OR a human ratifier's verified_id. Defaults to 'system-auto' on the HIGH path; REQUIRED to be a human ratifier id on the LOW-ratification path.
 * @param {string} [opts.ratifierPersonId] - the human ratifier's person_id (REQUIRED when confirmedBy is a human ratifier; the F1 distinctness + eligibility key)
 * @param {string} [opts.t0SignerPersonId]  - the T0 signer's person_id (the F1 distinctness anchor). If omitted, discriminate() resolves it from the folded ledger.
 * @param {object} opts.roster           - the loaded operators.roster.json (for isCapabilityRatifierEligible + fold)
 * @param {number} [opts.threshold]      - numeric auto-commit threshold (default 0.8; symbolic HIGH/LOW bypass)
 * @param {object} [opts.identity]       - emit identity (verified_id/person_id/display_id) forwarded to emitLedgerRecord on the HIGH path
 * @param {string} [opts.signingKeyPath] - emit signing key forwarded to emitLedgerRecord on the HIGH path
 * @param {function} [opts.emit]         - test seam: override the emitter (defaults to capabilityLedger.emitLedgerRecord)
 *
 * @returns one of:
 *   HIGH/auto: { ok:true, committed:true, record, collision_residual }
 *   LOW/route: { ok:true, committed:false, routing: { eligible_ratifiers, reason, t0_signer_person_id } }
 *   F1-reject / validation failure: { ok:false, committed:false, error, reason, step }
 */
function classifyNeed(opts) {
  const o = opts || {};

  // --- arg validation (typed; never a silent default) ---
  if (!o.repoDir || typeof o.repoDir !== "string") {
    return _err("args", "opts.repoDir must be a non-empty string");
  }
  if (typeof o.needFingerprint !== "string" || !o.needFingerprint) {
    return _err("args", "opts.needFingerprint must be a non-empty string");
  }
  if (!NEED_CLASSES.has(o.proposedClass)) {
    return _err(
      "class",
      `opts.proposedClass must be one of ${[...NEED_CLASSES].join(", ")} (got '${o.proposedClass}') — the class is the LLM's proposal, never a consultant judgment`,
    );
  }
  const roster = o.roster || { persons: {} };

  // Invariant (i): the ONLY consultant-derived inputs read here are the T0
  // need_fingerprint + (for F1) the T0 signer's person_id. No consultant CLASS
  // judgment is an input — the class is opts.proposedClass (the LLM's). Resolve
  // the T0 signer from the folded ledger when not passed (the distinctness
  // anchor for F1).
  const disc = discriminate(o.repoDir, o.needFingerprint, roster);
  if (disc.ok === false) {
    return _err("discriminate", disc.reason);
  }
  const t0SignerPersonId =
    typeof o.t0SignerPersonId === "string" && o.t0SignerPersonId
      ? o.t0SignerPersonId
      : disc.t0_signer_person_id;

  // --- confidence gate (deterministic part b) ---
  const threshold =
    typeof o.threshold === "number" && Number.isFinite(o.threshold)
      ? o.threshold
      : DEFAULT_CONFIDENCE_THRESHOLD;
  const gate = _resolveAutoCommit(o.confidence, threshold);
  if (gate.ok === false) {
    return _err("confidence", gate.reason);
  }

  // ---------------------------------------------------------------------
  // LOW confidence → ratify-by-exception routing (invariant ii: NEVER
  // auto-committed). The caller has NOT supplied a ratifier yet — surface
  // the eligible ratifier set so a NON-consultant ratifier can decide.
  // ---------------------------------------------------------------------
  if (!gate.autoCommit && !_isHumanRatifier(o.confirmedBy)) {
    return {
      ok: true,
      committed: false,
      routing: {
        eligible_ratifiers: _eligibleRatifiers(roster, t0SignerPersonId),
        reason:
          "LOW-confidence need: NOT auto-committed (invariant ii). A NON-consultant ratifier (capability-engineer or platform-engineer) whose person_id differs from the T0 signer's MUST ratify the class via a second classifyNeed call carrying confirmedBy=<their verified_id> + ratifierPersonId=<their person_id>.",
        t0_signer_person_id: t0SignerPersonId,
        proposed_class: o.proposedClass,
        need_fingerprint: o.needFingerprint,
      },
    };
  }

  // ---------------------------------------------------------------------
  // F1 ratifier binding (invariant iii) — when confirmedBy is a HUMAN
  // ratifier (not system-auto), enforce distinctness + eligibility. This is
  // the forgery defense: a T0 signer MUST NOT be able to self-ratify via ANY
  // path. Applies on BOTH the LOW-confidence ratification path AND a
  // HIGH-confidence call that nonetheless names a human ratifier.
  // ---------------------------------------------------------------------
  if (_isHumanRatifier(o.confirmedBy)) {
    if (typeof o.ratifierPersonId !== "string" || !o.ratifierPersonId) {
      return _err(
        "f1",
        "a human ratifier (confirmedBy != 'system-auto') requires opts.ratifierPersonId (the F1 distinctness + eligibility key)",
      );
    }
    // (iii.a) distinctness — the ratifier MUST NOT be the T0 signer. A T0
    // signer self-ratifying is the A2 crux forgery: the human who could-not-
    // classify cannot confirm the class they could not judge.
    if (t0SignerPersonId !== null && o.ratifierPersonId === t0SignerPersonId) {
      return _err(
        "f1",
        `F1 distinctness (invariant iii): ratifier person_id '${o.ratifierPersonId}' is the T0 signer — a T0 signer MUST NOT self-ratify the class they could not classify (the A2 crux forgery). Route to a DISTINCT non-consultant ratifier.`,
      );
    }
    // (iii.b) eligibility — the ratifier role ∈ {capability-engineer,
    // platform-engineer} (the advisory business_roles capability-scoping check
    // via the Roles-T1 predicate). NEVER the consultant.
    if (!isCapabilityRatifierEligible(roster, o.ratifierPersonId)) {
      return _err(
        "f1",
        `F1 eligibility (invariant iii): ratifier person_id '${o.ratifierPersonId}' is NOT capability-ratifier-eligible (role must be capability-engineer or platform-engineer per business_roles). The consultant NEVER ratifies.`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // COMMIT (invariant ii HIGH path, OR a validated human-ratified LOW path).
  // confirmed_by is 'system-auto' for the HIGH autonomous path, or the human
  // ratifier's verified_id once F1 passed.
  // ---------------------------------------------------------------------
  const confirmedBy = _isHumanRatifier(o.confirmedBy)
    ? o.confirmedBy
    : CONFIRMED_BY_SYSTEM_AUTO;

  const emit =
    typeof o.emit === "function" ? o.emit : capabilityLedger.emitLedgerRecord;
  const emitResult = emit({
    repoDir: o.repoDir,
    type: capabilityLedger.TYPE_NEED_CLASSIFIED,
    content: {
      need_fingerprint: o.needFingerprint,
      class: o.proposedClass,
      confirmed_by: confirmedBy,
    },
    identity: o.identity,
    signingKeyPath: o.signingKeyPath,
  });
  if (!emitResult || emitResult.ok !== true) {
    return {
      ok: false,
      committed: false,
      error: "emit failed",
      reason:
        (emitResult && (emitResult.reason || emitResult.error)) ||
        "emitLedgerRecord returned a non-ok result",
      step: (emitResult && emitResult.step) || "emit",
      emit_result: emitResult,
    };
  }

  return {
    ok: true,
    committed: true,
    record: emitResult.record,
    confirmed_by: confirmedBy,
    // Invariant (iv): the §8 fingerprint-collision residual is NAMED here. A
    // HIGH-confidence commit is NOT a claim that the fingerprint is unique — a
    // collision RAISES apparent confidence (the need LOOKS like a known shape),
    // so an auto-commit may be HIGH-confidence-AND-WRONG. Collision DETECTION
    // is the fingerprint-scheme's job (§8 OPEN), NOT this lib's. A caller MUST
    // NOT read this commit as collision-checked.
    collision_residual:
      confirmedBy === CONFIRMED_BY_SYSTEM_AUTO
        ? "§8 NEW-3: HIGH-confidence auto-commit is NOT collision-checked. A fingerprint collision RAISES apparent confidence and would auto-commit HIGH-AND-WRONG; collision detection is the fingerprint-scheme sub-design's job (OPEN), not this classifier's."
        : null,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function _err(step, reason) {
  return {
    ok: false,
    committed: false,
    error: "classify failed",
    reason,
    step,
  };
}

/** True iff confirmedBy is a present, non-system-auto string (a human ratifier id). */
function _isHumanRatifier(confirmedBy) {
  return (
    typeof confirmedBy === "string" &&
    confirmedBy.length > 0 &&
    confirmedBy !== CONFIRMED_BY_SYSTEM_AUTO
  );
}

/**
 * The set of eligible NON-consultant ratifiers for a LOW-confidence routing —
 * rostered persons who are isCapabilityRatifierEligible AND distinct from the
 * T0 signer (the F1 binding's two halves, surfaced as routing DATA, not a
 * decision). Each entry is { person_id, business_roles }.
 */
function _eligibleRatifiers(roster, t0SignerPersonId) {
  const persons = (roster && roster.persons) || {};
  const out = [];
  for (const personId of Object.keys(persons)) {
    if (personId === t0SignerPersonId) continue; // F1 distinctness
    if (isCapabilityRatifierEligible(roster, personId)) {
      const p = persons[personId] || {};
      out.push({
        person_id: personId,
        business_roles: Array.isArray(p.business_roles)
          ? p.business_roles.slice()
          : [],
      });
    }
  }
  return out;
}

module.exports = {
  discriminate,
  classifyNeed,
  // Constants exposed for callers + tests.
  CONFIRMED_BY_SYSTEM_AUTO,
  CONFIDENCE_HIGH,
  CONFIDENCE_LOW,
  CONFIDENCE_LEVELS,
  DEFAULT_CONFIDENCE_THRESHOLD,
  NEED_CLASSES,
  // Exposed for tests.
  _resolveAutoCommit,
  _eligibleRatifiers,
  _isHumanRatifier,
};
