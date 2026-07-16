// presence-proof-verify.js — #583 Shard 2: presence-proof verifier seam +
// fold gate (broker-sig verify + nonce-uniqueness + freshness + fail-closed).
//
// Shard 1 (`presence-proof.js`) delivered the binding SSOT
// (`presenceProofBindingBytes`) the off-loom broker signs, plus the fail-closed
// shape validator. THIS module (Shard 2) is the loom-SIDE verifier the broker
// does NOT re-implement: it re-derives the SAME binding bytes and INDEPENDENTLY
// verifies the broker's `content.presence_proof.broker_sig` against a roster
// `trust_anchors[]` entry (the presence broker's registered signing key). It is
// deliberately SEPARATE from `presence-proof.js` so the "bytes the off-loom
// broker must copy" surface stays exactly one file (`presence-proof.js`); this
// verify logic is loom-only.
//
// WHY THE BROKER SIGNATURE, NOT THE OPERATOR'S (journal/0505 honest caveat):
// the #583 mintability adversary HOLDS the operator's primary ssh/gpg key (every
// write is LLM-initiated). So anything covered ONLY by the primary sig is
// agent-forgeable. The presence proof ADDS non-mintability ONLY because this
// predicate verifies the BROKER's signature — a key the in-process agent does
// NOT hold — over a binding that COMMITS to the broker's single-use nonce + ts
// (the Shard-1 R2 fix). That is what makes the nonce-uniqueness + freshness
// checks below meaningful against the adversary.
//
// READ-TIME DISTINGUISHABILITY (AC-L11/L12): `verifyPresenceProof` returns a
// four-way status — ABSENT / PROVEN / EXPIRED / INVALID — so any reader can
// tell "signed AND presence-proven-fresh" from "signed but unproven / stale /
// forged" WITHOUT re-running crypto. The fold gate (`foldPresenceGate`) consumes
// this for its accept/reject verdict.
//
// FRESHNESS IS A READ-TIME VERDICT, NOT A CHAIN-ADMISSION GATE (Shard-2
// refinement of journal/0505, surfaced for redteam + co-owner note). journal/0505
// lists freshness (AC-L5) under "read-time distinguishability" for the Shard-2
// fold predicate. The coordination log is APPEND-ONLY and re-folded on EVERY
// read (the fold cache is rebuilt each session). If freshness-vs-wall-clock-now
// REJECTED a record from the fold, a legitimate gate-approval accepted at emit
// time would DROP OUT of tomorrow's fold (stale) AND break its emitter's rule-2
// chain continuity for every later record. So freshness maps to a DISTINGUISHABLE
// status (PROVEN=fresh vs EXPIRED=valid-but-stale), NEVER a fold reject. The
// requirement-latch (Shard 3a) is what requires PROVEN before an actuation is
// authorized; wall-clock-now freshness is meaningful at that consumption point,
// not at append-only re-fold admission. Only the RE-FOLD-STABLE, time-invariant
// conditions gate chain admission (type-membership / shape / anchor / broker-sig /
// nonce-replay). NOTE the anchor + broker-sig conditions carry the SAME
// residual caveats fold rule-1 already carries: an anchor verdict can flip if the
// roster's trust_anchors are mutated (key revocation), and a broker-sig verdict is
// deterministic only modulo verifier availability (a transient gpg-homedir error
// is fail-closed to INVALID, same class as rule-1). type-membership (the Shard-3a
// ABSENT-actuation latch) is the STRICTEST — a pure function of the signed
// record.type against a code constant, with no external dependency at all.
// SECOND-ORDER (bounded): when ≥2 records share ONE broker nonce (itself
// anomalous — a single-use broker issues each nonce once, so this is a replay /
// broker-bug state) AND a transient broker-sig verifier error strikes on one fold
// but not another, WHICH record survives the single-use replay-reject can differ
// across re-folds. The SAFETY invariant is unaffected: AT MOST one record per
// nonce is ever admitted on every fold — only the survivor's identity is
// transient-dependent, in the same detect-eventually class as rule-1.
//
// AC-L14 INJECTABLE VERIFIER SEAM IS TEST-ONLY, NOT PRODUCTION-CONFIGURABLE: the
// `verifyFn` + `now` injection points default to `coc-sign.js::verify` and
// `Date.now()`. The PRODUCTION fold path (`coordination-log.js::_foldLog`) calls
// `foldPresenceGate` with NEITHER override, so there is NO env var / config file
// an in-process agent can set to substitute an always-true verifier (the exact
// class as the `presence-mechanism.json` write-guard, journal/0365 sec MED-3).
// Only an in-process TEST constructing the call can inject — by construction.

"use strict";

const cocSign = require("./coc-sign.js");
const {
  PRESENCE_PROOF_FIELD,
  validatePresenceProofShape,
} = require("./presence-proof.js");
const {
  presenceProofBindingBytes,
  coSignerPresenceProofBindingBytes,
} = require("./presence-proof.js");
// #583 Shard 3a — the fold-latch consults the actuation partition to REJECT an
// ABSENT actuation. actuation-types.js is a leaf module (requires only fs/path),
// so this import cannot close a cycle back to presence-proof-verify.js.
const { requiresPresenceAttestation } = require("./actuation-types.js");

// ---- freshness / skew bounds ------------------------------------------------

// AC-L5: a SHORT per-write freshness bound (seconds–minutes), NOT the 24h
// gate-approval TTL. This is loom's COARSE replay-window CEILING at the fold —
// the off-loom broker's issuance TTL is the tight seconds-scale bound; loom's
// fold classifies anything older than the ceiling as EXPIRED (a backstop, not
// the precise per-write TTL). 300s (5 min) generously covers a human relaying
// an approval through the broker without a false EXPIRED on a genuine approval.
const PRESENCE_FRESHNESS_SEC = 300;

// AC-L5 clock-skew clause: skew tolerance MUST be STRICTLY BELOW the freshness
// bound (a skew ≥ freshness re-opens the replay window the freshness bound
// closes — the incoherence journal/0505 L5 calls out in the existing 5-min skew
// tolerance). 30s tolerates realistic cross-host clock drift while staying an
// order of magnitude under the 300s freshness bound.
const PRESENCE_MAX_SKEW_SEC = 30;

// Fail-closed invariant assertion at module load: an author who edits the two
// constants above into an incoherent (skew ≥ freshness) relationship trips this
// immediately, not silently at fold time.
if (!(PRESENCE_MAX_SKEW_SEC < PRESENCE_FRESHNESS_SEC)) {
  throw new Error(
    `presence-proof-verify: PRESENCE_MAX_SKEW_SEC (${PRESENCE_MAX_SKEW_SEC}) MUST be strictly below PRESENCE_FRESHNESS_SEC (${PRESENCE_FRESHNESS_SEC}) — a skew ≥ freshness re-opens the replay window (AC-L5)`,
  );
}

// ---- read-time distinguishability statuses (AC-L11/L12) ---------------------

const STATUS = Object.freeze({
  // No content.presence_proof on the record. A NON-actuation record folds
  // untouched (Shard-1 invariant: a record without a proof is untouched). An
  // ACTUATION-type record that is ABSENT is REJECTED at the fold by the Shard-3a
  // requirement-latch (foldPresenceGate) — the verifyPresenceProof classifier
  // still returns ABSENT here; the fold gate applies the actuation reject.
  ABSENT: "ABSENT",
  // Broker sig valid against a registered trust anchor, nonce well-formed, AND
  // presence_proof.ts within the freshness bound. The only status that
  // authorizes an actuation.
  PROVEN: "PROVEN",
  // Broker sig valid + anchor registered, but presence_proof.ts is outside the
  // freshness bound. Valid-but-stale — distinguishable from PROVEN at read time
  // (a historical actuation re-folded long after emit lands here). Does NOT
  // reject at fold (append-only re-fold stability); does NOT authorize.
  EXPIRED: "EXPIRED",
  // Malformed shape, no matching trust anchor, broker-sig verify failed OR
  // errored (fail-closed per evidence-first-claims.md MUST-3: a verifier
  // error/timeout is REFUSE, never a pass). Rejects at fold.
  INVALID: "INVALID",
});

// ---- trust-anchor resolution ------------------------------------------------

/**
 * Resolve the presence-broker trust anchor whose fingerprint matches the
 * proof's `broker_verified_id`. Returns the anchor object or null.
 *
 * Matches on BOTH `fingerprint === broker_verified_id` AND
 * `purpose === "presence-broker"` — the purpose gate keeps the trust scope
 * closed (a future non-presence anchor, were the schema enum widened, can NOT
 * sign presence proofs). trust_anchors[] lives OUTSIDE roster.persons and is
 * NEVER quorum-eligible (the host_role:ci analogue, Shard-1 schema).
 */
function resolveTrustAnchor(roster, brokerVerifiedId) {
  if (!roster || !Array.isArray(roster.trust_anchors)) return null;
  if (typeof brokerVerifiedId !== "string" || !brokerVerifiedId) return null;
  for (const a of roster.trust_anchors) {
    if (
      a &&
      a.purpose === "presence-broker" &&
      a.fingerprint === brokerVerifiedId &&
      (a.type === "ssh" || a.type === "gpg") &&
      typeof a.pubkey === "string" &&
      a.pubkey
    ) {
      return a;
    }
  }
  return null;
}

// ---- freshness --------------------------------------------------------------

/**
 * Parse an ISO-8601 timestamp (validatePresenceProofShape already guaranteed a
 * timezone designator) to epoch ms, or null if unparseable.
 */
function _parseIsoMs(ts) {
  if (typeof ts !== "string" || !ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Freshness verdict on the BROKER-BOUND presence_proof.ts (NEVER the top-level
 * record `ts`, which is emit-assigned and agent-forgeable — the Shard-2 trap
 * from journal/0506). Returns true iff `proof.ts` is within
 * [now - freshness - skew, now + skew].
 */
function _isFresh(proofTsMs, nowMs, freshnessSec, skewSec) {
  if (proofTsMs === null) return false;
  const ageMs = nowMs - proofTsMs;
  // Too far in the future (beyond skew) → not fresh (forged / bad clock).
  if (ageMs < -skewSec * 1000) return false;
  // Older than the freshness bound (plus skew grace) → stale.
  if (ageMs > (freshnessSec + skewSec) * 1000) return false;
  return true;
}

// ---- the classifier (AC-L3/L11/L12/L14) -------------------------------------

/**
 * verifyPresenceProof(record, roster, opts) — the read-time presence
 * classifier. Pure w.r.t. the fold (does NOT check nonce-uniqueness — that
 * needs cross-record fold context; see foldPresenceGate). Returns
 * `{status, reason}` with status ∈ STATUS.
 *
 * @param {object} record — a coordination-log record.
 * @param {object} roster — the roster carrying trust_anchors[].
 * @param {object} [opts]
 * @param {number} [opts.now] — epoch ms; defaults to Date.now(). TEST-ONLY
 *   injection (AC-L14) — the production fold passes nothing.
 * @param {function} [opts.verifyFn] — signature-verify fn with coc-sign.verify's
 *   shape; defaults to cocSign.verify. TEST-ONLY injection (AC-L14).
 * @param {string} [opts.gpgHome] — optional shared GPG verify-homedir (F17).
 * @param {number} [opts.freshnessSec] — override the freshness bound (test).
 * @param {number} [opts.skewSec] — override the skew tolerance (test).
 * @returns {{status: string, reason?: string, broker_verified_id?: string, nonce?: string}}
 */
function _normalizeVerifyOpts(opts) {
  const o = opts || {};
  return {
    verifyFn: typeof o.verifyFn === "function" ? o.verifyFn : cocSign.verify,
    nowMs: typeof o.now === "number" ? o.now : Date.now(),
    freshnessSec:
      typeof o.freshnessSec === "number"
        ? o.freshnessSec
        : PRESENCE_FRESHNESS_SEC,
    skewSec: typeof o.skewSec === "number" ? o.skewSec : PRESENCE_MAX_SKEW_SEC,
    gpgHome: o.gpgHome,
  };
}

/**
 * _classifyProof(proof, deriveBindingBytes, roster, opts) — the SHARED read-time
 * classifier both the emitter proof (`verifyPresenceProof`) and each co-signer
 * proof (`verifyCoSignerPresenceProof`) route through. It differs between the two
 * ONLY in (a) which proof object is classified and (b) the `deriveBindingBytes`
 * thunk (the emitter's `presenceProofBindingBytes` vs the co-signer's
 * `coSignerPresenceProofBindingBytes`) — the Enforcement-Surface-Parity boundary:
 * one classifier, two bindings, so the crypto/anchor/freshness logic can NEVER
 * drift between the emitter and co-signer surfaces (`security.md` § Enforcement-
 * Surface Parity). Returns `{status, reason?, broker_verified_id?, nonce?}`.
 */
function _classifyProof(proof, deriveBindingBytes, roster, o) {
  // ABSENT — no proof present.
  if (proof === undefined || proof === null) {
    return { status: STATUS.ABSENT };
  }

  // Shape gate (fail-closed) — reuses the Shard-1 SSOT validator.
  const shape = validatePresenceProofShape(proof);
  if (!shape.ok) {
    return { status: STATUS.INVALID, reason: `shape: ${shape.reason}` };
  }

  // Trust-anchor resolution — a broker not registered in trust_anchors[] cannot
  // authorize (fail-closed).
  const anchor = resolveTrustAnchor(roster, proof.broker_verified_id);
  if (!anchor) {
    return {
      status: STATUS.INVALID,
      reason: `no registered presence-broker trust anchor matches broker_verified_id '${proof.broker_verified_id}'`,
      broker_verified_id: proof.broker_verified_id,
      // The nonce is returned on EVERY shape-valid path (the shape gate above
      // guaranteed a well-formed 128-bit nonce) so the fold's single-use ledger
      // can track it as a pure function of the record BYTES — independent of the
      // broker-sig verdict (R1 analyst INVEST-NOW: check ⟺ register must be
      // byte-pure, else an INVALID-co-signer nonce is burned-but-unchecked and a
      // transient verifier error oscillates chain admission across re-folds).
      nonce: proof.nonce,
    };
  }

  // Broker-sig verification over the re-derived binding bytes (Enforcement-
  // Surface Parity: the SAME binding SSOT the broker signed).
  let bindingBytes;
  try {
    bindingBytes = deriveBindingBytes();
  } catch (err) {
    // The binding derivation throws only on a non-object record/co-signer — a
    // shape failure already caught upstream. Fail-closed.
    return {
      status: STATUS.INVALID,
      reason: `binding derivation failed: ${err && err.message ? err.message : String(err)}`,
      nonce: proof.nonce, // shape-valid → byte-pure nonce ledger (see anchor branch)
    };
  }

  const verifyOpts = { keyType: anchor.type };
  if (anchor.type === "gpg") {
    // Bind to the anchor's fingerprint so a SHARED multi-key verify-homedir
    // (F17) cannot accept a record signed by a DIFFERENT key in the ring — the
    // impersonation defense coc-sign.js::_verifyGpg's VALIDSIG bind provides.
    verifyOpts.expectedFpr = anchor.fingerprint;
    if (o.gpgHome) verifyOpts.gpgHome = o.gpgHome;
  }

  let v;
  try {
    v = o.verifyFn(bindingBytes, proof.broker_sig, anchor.pubkey, verifyOpts);
  } catch (err) {
    // A verifier THROW is zero evidence, never a pass (evidence-first-claims.md
    // MUST-3) — fail-closed to INVALID.
    return {
      status: STATUS.INVALID,
      reason: `broker-sig verify threw: ${err && err.message ? err.message : String(err)}`,
      broker_verified_id: proof.broker_verified_id,
      nonce: proof.nonce, // shape-valid → byte-pure nonce ledger (see anchor branch)
    };
  }
  // v.ok === "the check ran"; v.valid === "the signature is cryptographically
  // valid". Gate on `valid`; an errored check (ok:false) is fail-closed INVALID.
  if (!v || v.ok !== true || v.valid !== true) {
    return {
      status: STATUS.INVALID,
      reason: `broker-sig invalid: ${(v && v.reason) || "verify did not return valid:true"}`,
      broker_verified_id: proof.broker_verified_id,
      nonce: proof.nonce,
    };
  }

  // Freshness — read-time verdict on the BROKER-BOUND proof.ts (AC-L5). Valid
  // sig + valid anchor but stale ts → EXPIRED (distinguishable, does NOT reject
  // at fold, does NOT authorize).
  const fresh = _isFresh(
    _parseIsoMs(proof.ts),
    o.nowMs,
    o.freshnessSec,
    o.skewSec,
  );
  return {
    status: fresh ? STATUS.PROVEN : STATUS.EXPIRED,
    broker_verified_id: proof.broker_verified_id,
    nonce: proof.nonce,
  };
}

function verifyPresenceProof(record, roster, opts) {
  const o = _normalizeVerifyOpts(opts);
  const content =
    record && record.content && typeof record.content === "object"
      ? record.content
      : {};
  const proof = content[PRESENCE_PROOF_FIELD];
  // ABSENT here folds as today; the requirement latch (Shard 3a, in
  // foldPresenceGate) decides whether an actuation type may be ABSENT.
  return _classifyProof(
    proof,
    () => presenceProofBindingBytes(record),
    roster,
    o,
  );
}

/**
 * verifyCoSignerPresenceProof(record, coSigner, roster, opts) — #583 Shard 4:
 * the loom-side classifier for ONE co-signer's OWN presence proof
 * (`co_signers[i].presence_proof`). Re-derives the Shard-4 co-signer binding
 * SSOT (`coSignerPresenceProofBindingBytes`) and INDEPENDENTLY verifies the
 * co-signer's `broker_sig` against a roster `presence-broker` trust anchor — the
 * SAME four-way ABSENT/PROVEN/EXPIRED/INVALID classifier as the emitter, over the
 * co-signer binding (so a genuine broker proof for approver A cannot be ported
 * onto approver B's entry, and a held primary key cannot mint the approver's
 * presence). Returns `{status, reason?, broker_verified_id?, nonce?}`.
 *
 * @param {object} record — the coordination-log record carrying content.co_signers.
 * @param {object} coSigner — one content.co_signers[i] entry.
 * @param {object} roster — the roster carrying trust_anchors[].
 * @param {object} [opts] — same injectable seam as verifyPresenceProof (now /
 *   verifyFn / gpgHome / freshnessSec / skewSec; TEST-ONLY, production passes none).
 */
function verifyCoSignerPresenceProof(record, coSigner, roster, opts) {
  const o = _normalizeVerifyOpts(opts);
  const proof =
    coSigner && typeof coSigner === "object"
      ? coSigner[PRESENCE_PROOF_FIELD]
      : undefined;
  return _classifyProof(
    proof,
    () => coSignerPresenceProofBindingBytes(record, coSigner),
    roster,
    o,
  );
}

// ---- the fold gate (cross-cutting; AC-L4 nonce ledger, fail-closed) ---------

/**
 * foldPresenceGate(record, roster, ctx) — the cross-cutting fold check
 * `coordination-log.js::_foldLog` runs for EVERY record (after rule-1 sig
 * verify, before record-type dispatch). It:
 *
 *   - passes ABSENT NON-actuation records through untouched (Shard-1 invariant),
 *   - REJECTS an ABSENT ACTUATION record (Shard-3a requirement-latch, Q5b) —
 *     an actuation type MUST carry a valid proof; gated on static type-membership
 *     (re-fold-stable, un-downgradeable) — see the ABSENT branch below,
 *   - REJECTS present-but-crypto-invalid proofs (shape / anchor / broker-sig)
 *     AND nonce-REPLAY — all RE-FOLD-STABLE, time-invariant conditions, so a
 *     re-fold produces the identical accept/reject verdict and no legitimate
 *     record ever oscillates in/out of the chain,
 *   - ACCEPTS PROVEN and EXPIRED (freshness is a read-time verdict, not a
 *     chain-admission gate — see the module header rationale).
 *
 * AC-L4 SINGLE-USE NONCE LEDGER: the durable ledger IS the append-only
 * coordination log. `ctx.seenPresenceNonces` is the set of presence-proof
 * nonces already consumed by ACCEPTED records EARLIER in this fold. A duplicate
 * nonce is a replay → reject (first occurrence wins; re-fold-stable because the
 * log order is fixed). Across restarts the whole log re-folds → the set
 * re-derives → durable by construction.
 *
 * CHECKPOINT-ARCHIVAL WINDOW (precise per the R1 redteam — security + analyst):
 * a `compaction-checkpoint` folds pre-`up_to_seq` records into a digest and
 * archives them, so an archived nonce leaves the live re-fold set. What actually
 * closes the resulting window differs by record type, and it is NOT freshness
 * alone as an earlier draft of this comment claimed:
 *   - The PRIMARY actuation type `gate-approval` (today the ONLY member of
 *     actuation-types.js::ACTUATION_RECORD_TYPES) is `checkpoint_exempt: true`
 *     (coordination-log.js), so its records are NEVER archived → their nonces
 *     never leave the live set → the persistent nonce ledger fully closes replay
 *     for it; freshness is redundant there.
 *   - A checkpoint-NON-exempt type that carries a proof (e.g. `release`) COULD
 *     rely on freshness across a checkpoint: a nonce archived while STILL within
 *     the freshness bound could re-derive absent and replay as PROVEN.
 *     Shard 3a CLOSES this window BY CONSTRUCTION via option (b): a load-time
 *     assert in coordination-log.js requires ACTUATION_RECORD_TYPES ⊆
 *     checkpoint-exempt, so EVERY presence-GATED (actuation) type is
 *     checkpoint-exempt → its nonces never leave the live re-fold set → the
 *     single-use nonce ledger fully closes replay and freshness is redundant for
 *     every gated type (no checkpoint-min-age coupling needed). A non-actuation
 *     type that merely CARRIES a proof (e.g. `release`) is not presence-GATED —
 *     nothing authorizes on its PROVEN verdict — so the window is inert for it.
 *
 * The caller registers an accepted record's nonce via `registerPresenceNonce`
 * AFTER the record clears every gate (only ACCEPTED records consume a nonce).
 *
 * @param {object} record
 * @param {object} roster
 * @param {object} ctx — {seenPresenceNonces:Set, now?, verifyFn?, gpgHome?,
 *   freshnessSec?, skewSec?}
 * #583 Shard 4 — CO-SIGNER presence. A gate-approval's 4-eyes security rests on
 * the DISTINCT approver's presence (journal/0510 N-1), so each `co_signers[i]`
 * that carries a `presence_proof` is verified here per-co-signer via
 * `verifyCoSignerPresenceProof`, and the per-signer statuses are returned in
 * `coSignerStatuses` (keyed by the co-signer's `verified_id`) for the fold to
 * stamp. The ENFORCEMENT asymmetry (principled, matching L7): the EMITTER's
 * proof gates CHAIN ADMISSION (an ABSENT-actuation or crypto-INVALID emitter
 * proof REJECTS — the emitter IS the actuation), whereas a co-signer's crypto
 * verdict is READ-TIME ATTRIBUTION (an ABSENT/EXPIRED/INVALID co-signer proof
 * FOLDS but that approver is not gate-eligible → does not count toward 4-eyes at
 * the CONSUMPTION point). This keeps re-fold stability: a record does not
 * oscillate out of the chain when a trust anchor rotates or a co-signer proof
 * ages. What DOES gate chain admission uniformly (emitter AND co-signers) is the
 * single-use nonce ledger (AC-L4): a within-record duplicate presence-nonce OR a
 * cross-record nonce replay REJECTS the record — a pure, re-fold-stable function
 * of the record's bytes + the accepted-so-far ledger.
 *
 * @returns {{accepted: boolean, reason?: string, status: string, nonce?: string,
 *   coSignerStatuses?: object, coSignerNonces?: string[]}}
 */
function foldPresenceGate(record, roster, ctx) {
  const c = ctx || {};
  const verifyOpts = {
    now: c.now,
    verifyFn: c.verifyFn,
    gpgHome: c.gpgHome,
    freshnessSec: c.freshnessSec,
    skewSec: c.skewSec,
  };
  const verdict = verifyPresenceProof(record, roster, verifyOpts);

  if (verdict.status === STATUS.ABSENT) {
    // #583 Shard 3a requirement-latch (Q5b — enforcement at the FOLD, every
    // reader). An ACTUATION-class record (gate-approval + future command-center
    // actuation types) MUST carry a valid presence proof; ABSENT on an actuation
    // type → REJECT. This is THE non-mintability enforcement point: the #583
    // adversary holds the operator's primary key and can hand-append a signed
    // ABSENT actuation BYPASSING coc-emit, so an emit-only gate is insufficient —
    // the fold (which every reader re-runs and no writer can bypass) is where the
    // requirement bites. Gated on STATIC type-membership (ACTUATION_RECORD_TYPES,
    // an immutable write-guarded code constant), NOT a mutable file/env signal,
    // so it is (a) re-fold-STABLE — a pure function of record.type, time-invariant,
    // producing the identical verdict on every re-fold (unlike freshness, which
    // stays a read-time verdict) — and (b) un-downgradeable by an in-process
    // agent. ALWAYS-ON (co-owner-ratified): unconditional, no provisioning gate.
    // A NON-actuation record with no proof folds untouched (the Shard-1 invariant).
    if (requiresPresenceAttestation(record.type)) {
      return {
        accepted: false,
        status: STATUS.ABSENT,
        reason: `presence-proof: actuation record type '${record.type}' requires a presence proof but none is present (ABSENT) — the identity-≠-intent mintability hole #583 closes; holding the signing key is not sufficient (§C4)`,
      };
    }
    // ABSENT non-actuation: the emitter folds untouched (Shard-1 invariant), but
    // the record may still carry co-signers with their own presence proofs — fall
    // through to co-signer processing (the emitter contributes no nonce).
  } else if (verdict.status === STATUS.INVALID) {
    return {
      accepted: false,
      status: STATUS.INVALID,
      reason: `presence-proof: ${verdict.reason || "invalid"}`,
    };
  }

  // The EMITTER verdict is now accept-eligible (ABSENT-non-actuation, PROVEN, or
  // EXPIRED). The emitter contributes a single-use nonce only for PROVEN/EXPIRED.
  const emitterNonce =
    verdict.status === STATUS.PROVEN || verdict.status === STATUS.EXPIRED
      ? verdict.nonce
      : undefined;

  // #583 Shard 4 — verify each co-signer's presence proof (READ-TIME attribution;
  // a co-signer's crypto verdict NEVER rejects the record — see the header
  // asymmetry). A co-signer WITHOUT a presence proof is ABSENT + inert (e.g. a
  // lease-override co-signer, or an approver not yet broker-attested).
  const coSignerStatuses = {};
  const coSignerNonces = [];
  const content =
    record && record.content && typeof record.content === "object"
      ? record.content
      : {};
  const coSigners = Array.isArray(content.co_signers) ? content.co_signers : [];
  for (const co of coSigners) {
    if (!co || typeof co !== "object" || typeof co.verified_id !== "string") {
      // Malformed co-signer entry: the co-sign quorum predicate rejects it; here
      // it simply carries no presence attribution.
      continue;
    }
    if (
      co[PRESENCE_PROOF_FIELD] === undefined ||
      co[PRESENCE_PROOF_FIELD] === null
    ) {
      coSignerStatuses[co.verified_id] = STATUS.ABSENT;
      continue;
    }
    const cv = verifyCoSignerPresenceProof(record, co, roster, verifyOpts);
    coSignerStatuses[co.verified_id] = cv.status;
    // Track the co-signer nonce for the single-use ledger whenever the proof is
    // SHAPE-VALID (a well-formed nonce is present ⟺ the shape gate passed —
    // `_classifyProof` returns `nonce` on every post-shape path), NOT only on the
    // PROVEN/EXPIRED broker-sig verdict. This makes the ledger a pure function of
    // the record BYTES (R1 analyst INVEST-NOW): an INVALID co-signer proof folds
    // (read-time asymmetry) but its nonce MUST still be checked + burned, else
    // (a) a second record replaying that nonce on an INVALID co-signer double-
    // admits, and (b) a transient verifier error flipping INVALID↔PROVEN
    // oscillates the record's chain admission across re-folds — both breaking the
    // "re-fold-stable, pure function of bytes" invariant this ledger promises.
    if (typeof cv.nonce === "string" && cv.nonce) {
      coSignerNonces.push(cv.nonce);
    }
  }

  // Unified single-use nonce ledger (AC-L4) over the emitter + every SHAPE-VALID
  // co-signer nonce — THIS is the chain-admission gate (re-fold-stable):
  //   (1) within-record duplicate — two presence proofs on ONE record sharing a
  //       nonce is anomalous (a single-use broker issues each nonce once → a
  //       replay / broker-bug); reject.
  //   (2) cross-record replay — a nonce already consumed by a prior accepted
  //       record; reject (first-occurrence-wins, re-fold-stable on the fixed log).
  const allNonces = [];
  if (typeof emitterNonce === "string" && emitterNonce) {
    allNonces.push(emitterNonce);
  }
  for (const n of coSignerNonces) {
    if (typeof n === "string" && n) allNonces.push(n);
  }
  const withinRecord = new Set();
  const seen = c.seenPresenceNonces;
  for (const n of allNonces) {
    if (withinRecord.has(n)) {
      return {
        accepted: false,
        status: STATUS.INVALID,
        reason: `presence-proof: duplicate presence nonce within a single record (two proofs share one single-use nonce — replay / broker anomaly, AC-L4)`,
      };
    }
    withinRecord.add(n);
    if (seen && typeof seen.has === "function" && seen.has(n)) {
      return {
        accepted: false,
        status: STATUS.INVALID,
        reason: `presence-proof: nonce already consumed by a prior accepted record (single-use replay defense, AC-L4)`,
        nonce: n,
      };
    }
  }

  return {
    accepted: true,
    status: verdict.status,
    nonce: emitterNonce,
    coSignerStatuses,
    coSignerNonces,
  };
}

// ---- L7 proof-derived attribution downgrade (#583 Shard 3b) -----------------

/**
 * Resolve the roster person that owns `verifiedId` (a signing-key fingerprint).
 * Returns {person_id, host_role, role} or null. Local to this module so the
 * attribution SSOT is self-contained (the same key→person shape eligibility.js
 * + coordination-log.js::_resolveRosterPerson resolve, minus the pubkey).
 */
function _resolveSignerPerson(roster, verifiedId) {
  if (
    !roster ||
    !roster.persons ||
    typeof verifiedId !== "string" ||
    !verifiedId
  ) {
    return null;
  }
  for (const [pid, person] of Object.entries(roster.persons)) {
    const keys = (person && person.keys) || [];
    for (const k of keys) {
      if (k && k.fingerprint === verifiedId) {
        return {
          person_id: pid,
          host_role: person.host_role || "human",
          role: person.role || null,
        };
      }
    }
  }
  return null;
}

/**
 * deriveProofAttribution(record, roster, presenceStatus) — #583 Shard 3b, the
 * L7 proof-derived attribution downgrade (AC-L7). Returns the record signer's
 * EFFECTIVE gate-eligibility attribution, DERIVED from (a) the signer's
 * verified_id → roster person and (b) the INDEPENDENTLY-verified presence
 * `presenceStatus` (the STATUS the fold's verifyPresenceProof/foldPresenceGate
 * already computed) — NEVER from a payload field on the record.
 *
 * AC-L7: "valid proof => operator person_id (gate-eligible); none =>
 * host_role:ci (audit-only) — never a payload claim." The downgrade:
 *   - proof PROVEN            → effective_host_role = the roster host_role
 *                              (a genuine `ci` host STAYS ci — the proof does
 *                              not PROMOTE; it only conditions the human floor),
 *                              gate_eligible iff the resolved host is a human.
 *   - proof NOT PROVEN        → effective_host_role FORCED to "ci" (audit-only),
 *     (ABSENT/EXPIRED/INVALID)  gate_eligible = false. This is the L7 downgrade:
 *                              an EXPIRED actuation record FOLDS (chain-stability
 *                              per the read-time-verdict invariant) but its
 *                              signer is attributed audit-only.
 *
 * CONSUMPTION IS DEFERRED TO SHARD 4 — this shard produces the STAMP, not the
 * ENFORCEMENT. NO live gate reads `_presence_attribution` today (grep-verified:
 * only this module + coordination-log.js stamp it, and the tests). The Shard-4
 * co-sign plumbing (L8/L10) is what wires a gate consumer that consults the
 * stamp: it will resolve a person carrying `effective_host_role` and route it
 * through `eligibility.js::isEligibleSigner` — which reads `person.host_role`
 * (so a "ci" effective host is forever-ineligible for the 5 quorum contexts,
 * R5-S-04). Until then the downgrade is inert-but-correct (zero gate-approval
 * records are emitted through the log yet — that emit path is also Shard 4). The
 * EXISTING /release gate (operator-gate.js → gate-approval.js) does NOT read
 * this stamp — it resolves the roster person directly; do NOT mistake it for a
 * live L7 consumer.
 *
 * DISTINCT FROM the Shard-3a requirement-latch: the latch REJECTS an ABSENT /
 * INVALID actuation at the FOLD (chain admission). L7 is the CONSUMPTION-point
 * attribution: it catches the EXPIRED actuation the latch admits (freshness is
 * a read-time verdict, not a fold-reject) and any not-PROVEN proof-bearing
 * record, and downgrades its signer to audit-only for every gate-eligibility
 * decision. FOR ACTUATION TYPES the latch pre-rejects ABSENT/INVALID, so an
 * actuation only reaches the stamp as PROVEN or EXPIRED; the ABSENT/INVALID
 * branches below are DEFENSIVE (reachable as direct units + for non-actuation
 * proof-bearing records, never for an actuation via the production fold).
 *
 * NEVER A PAYLOAD CLAIM: the return is a pure function of the signer's
 * roster-resolved host_role + the verified presenceStatus. A record's OWN
 * `_presence_attribution` field (if an adversary set one) is IGNORED — the fold
 * OVERWRITES it with this derivation (see _foldLog). host_role:ci downgrade is
 * one-directional: this never raises a signer ABOVE its roster host_role.
 *
 * Returns null when there is NOTHING to attribute — a record that is NEITHER an
 * actuation type NOR carrying a presence proof folds untouched (the Shard-1
 * invariant: a record without a proof is untouched). Otherwise returns
 * {proof_status, attributed_person_id, effective_host_role, gate_eligible,
 *  downgraded}.
 *
 * @param {object} record — a coordination-log record.
 * @param {object} roster — the roster carrying persons[].
 * @param {string} presenceStatus — a STATUS value the fold already computed via
 *   foldPresenceGate/verifyPresenceProof. Passing an unknown value is treated
 *   as NOT-PROVEN (fail-closed).
 * @returns {null | {proof_status, attributed_person_id, effective_host_role, gate_eligible, downgraded}}
 */
function _deriveSignerAttribution(roster, verifiedId, presenceStatus) {
  const signer = _resolveSignerPerson(roster, verifiedId);
  // Fail-closed: an unknown STATUS (or anything other than PROVEN) is NOT-PROVEN.
  const proven = presenceStatus === STATUS.PROVEN;

  // The L7 downgrade. PROVEN preserves the roster host_role (a genuine ci host
  // stays ci — the proof conditions the human floor, never promotes). Any
  // NOT-PROVEN status forces "ci" (audit-only). An unresolved signer (no roster
  // key match) is audit-only too (fail-closed — an unattributable signer is
  // never gate-eligible).
  const rosterHostRole = signer ? signer.host_role : "ci";
  const effective_host_role = proven ? rosterHostRole : "ci";
  const gate_eligible = effective_host_role !== "ci";

  return {
    // Prototype-safe membership test (R2 security below-LOW): a bracket-index
    // `STATUS[presenceStatus]` would resolve truthy for an inherited Object key
    // name (e.g. "hasOwnProperty"), mislabeling proof_status. Unreachable via the
    // fold (presenceStatus is always a STATUS enum), but this is an EXPORTED path
    // Shard 4 calls — fail-closed to INVALID for any non-own key.
    proof_status: Object.prototype.hasOwnProperty.call(STATUS, presenceStatus)
      ? presenceStatus
      : STATUS.INVALID,
    attributed_person_id: signer ? signer.person_id : null,
    effective_host_role,
    gate_eligible,
    downgraded: rosterHostRole !== effective_host_role,
  };
}

function deriveProofAttribution(record, roster, presenceStatus) {
  if (!record || typeof record !== "object") return null;

  const content =
    record.content && typeof record.content === "object" ? record.content : {};
  const hasProof =
    content[PRESENCE_PROOF_FIELD] !== undefined &&
    content[PRESENCE_PROOF_FIELD] !== null;
  const isActuation = requiresPresenceAttestation(record.type);

  // Nothing to attribute: a non-actuation record with no proof folds untouched.
  if (!hasProof && !isActuation) return null;

  return _deriveSignerAttribution(roster, record.verified_id, presenceStatus);
}

/**
 * deriveProofAttributionMap(record, roster, emitterStatus, coSignerStatuses) —
 * #583 Shard 4 (N-1): the per-signer attribution map. A gate-approval's 4-eyes
 * security rests on the DISTINCT APPROVER's presence, not only the emitter's
 * (journal/0510 N-1), so the single-valued Shard-3b stamp is extended to a map
 * keyed by `verified_id` — one entry per { the emitter + each co-signer } —
 * carrying each signer's INDEPENDENTLY-verified presence status.
 *
 * Shape: `{ by_verified_id: { "<emitter-fpr>": { role:"emitter", ...attribution },
 * "<approver-fpr>": { role:"co_signer", ...attribution } } }`. Each entry is the
 * SAME flat L7 attribution `deriveProofAttribution` produced, plus a `role`
 * discriminator. A `verified_id`-keyed map (not a positional array) is used
 * because attribution is authority-bearing and `verified_id` is the cryptographic
 * key the co-sign distinctness logic already keys on.
 *
 * WHAT A SHARD-4 GATE CONSUMER READS (the broker-gated /release endpoint, NOT
 * built here): for each DISTINCT approver `co.verified_id`, require
 * `by_verified_id[co.verified_id].proof_status === "PROVEN"` AND `gate_eligible
 * === true`. Fail-closed on a MISSING map entry (unknown → not gate-eligible,
 * `security.md` § Enforcement-Surface Parity). Gate on `proof_status`/
 * `gate_eligible`, NEVER `downgraded` (journal/0510 N-4: `downgraded` is false for
 * BOTH a genuine ci-host and an unresolved signer, so it does not detect
 * ineligibility).
 *
 * THIS MAP IS PRESENCE-ONLY — the endpoint MUST COMBINE it with roster distinctness
 * (R1 analyst disposition 1). The map answers "was each approver PROVEN-present?"
 * and carries `attributed_person_id` (enabling person-distinctness), but NOT the
 * bound GitHub-collaborator-login. The 4-eyes gate additionally requires the
 * approver be a DISTINCT person AND distinct bound-login from the requester
 * (`multi-operator-coordination.md` MUST-3, enforced at `operator-gate.js`). The
 * endpoint's contract is therefore: map-presence (here) AND roster-distinctness
 * (there) — neither alone is the gate.
 *
 * NEVER A PAYLOAD CLAIM: every entry is a pure function of (a signer's
 * verified_id → roster host_role) + the fold-verified status. A record's OWN
 * `_presence_attribution` is DROPPED and OVERWRITTEN by the fold (see
 * _stampPresenceAttribution). host_role:ci downgrade stays one-directional per
 * signer (a PROVEN proof never raises a ci host — the Shard-3b J16 property, now
 * per co-signer).
 *
 * Returns null when there is NOTHING to attribute — a non-actuation record with
 * neither an emitter proof NOR any co-signer presence proof (the Shard-1
 * untouched invariant). A co-signer whose status is ABSENT (no proof) still gets
 * a map entry when the record IS otherwise attributable, so a consumer can tell
 * "approver present-but-not-proven" from "approver never in the map".
 *
 * @param {object} record — a coordination-log record.
 * @param {object} roster — the roster carrying persons[].
 * @param {string} emitterStatus — the emitter's fold-verified STATUS.
 * @param {object} [coSignerStatuses] — { verified_id → STATUS } the fold computed
 *   per co-signer (foldPresenceGate.coSignerStatuses). Absent → emitter-only map.
 * @returns {null | {by_verified_id: object}}
 */
function deriveProofAttributionMap(
  record,
  roster,
  emitterStatus,
  coSignerStatuses,
) {
  if (!record || typeof record !== "object") return null;

  const content =
    record.content && typeof record.content === "object" ? record.content : {};
  const hasProof =
    content[PRESENCE_PROOF_FIELD] !== undefined &&
    content[PRESENCE_PROOF_FIELD] !== null;
  const isActuation = requiresPresenceAttestation(record.type);
  const statuses =
    coSignerStatuses && typeof coSignerStatuses === "object"
      ? coSignerStatuses
      : {};
  const coSigners = Array.isArray(content.co_signers) ? content.co_signers : [];
  // Does any co-signer carry a presence proof? (an ABSENT-only co-signer set on a
  // non-actuation record with no emitter proof is still nothing to attribute).
  const anyCoSignerProof = coSigners.some(
    (co) =>
      co &&
      typeof co === "object" &&
      co[PRESENCE_PROOF_FIELD] !== undefined &&
      co[PRESENCE_PROOF_FIELD] !== null,
  );

  if (!hasProof && !isActuation && !anyCoSignerProof) return null;

  const by_verified_id = {};
  // The emitter entry (the requester/primary signer).
  if (typeof record.verified_id === "string" && record.verified_id) {
    by_verified_id[record.verified_id] = Object.assign(
      { role: "emitter" },
      _deriveSignerAttribution(roster, record.verified_id, emitterStatus),
    );
  }
  // One entry per DISTINCT co-signer (the approvers whose presence the 4-eyes
  // gate rests on). Uses the fold-verified per-co-signer status; a co-signer with
  // no proof is ABSENT (present-but-not-proven — distinguishable from absent map).
  for (const co of coSigners) {
    if (!co || typeof co !== "object" || typeof co.verified_id !== "string") {
      continue;
    }
    // Do not let a co-signer entry shadow the emitter entry (a co_signer whose
    // verified_id equals the emitter is rejected by the co-sign distinctness
    // predicate anyway; keep the emitter role here).
    if (co.verified_id === record.verified_id) continue;
    const st = Object.prototype.hasOwnProperty.call(statuses, co.verified_id)
      ? statuses[co.verified_id]
      : STATUS.ABSENT;
    by_verified_id[co.verified_id] = Object.assign(
      { role: "co_signer" },
      _deriveSignerAttribution(roster, co.verified_id, st),
    );
  }

  return { by_verified_id };
}

/**
 * registerPresenceNonce(record, seenPresenceNonces) — record an accepted
 * presence-bearing record's nonce(s) into the fold's single-use ledger. No-op for
 * records without a well-formed presence proof. Called by _foldLog ONLY once a
 * record has cleared every gate and landed in `accepted`.
 *
 * #583 Shard 4: registers the EMITTER's nonce AND every co-signer's own presence
 * nonce (`co_signers[i].presence_proof.nonce`). A co-signer proof's nonce is a
 * single-use broker-issued token exactly like the emitter's, so it MUST burn on
 * the same ledger — else a co-signer approval could be replayed on a later record
 * (the AC-L4 hole one indirection over).
 *
 * The BURN set is gated on `validatePresenceProofShape` — the SAME shape predicate
 * `foldPresenceGate`'s CHECK set uses (a co-signer nonce enters `allNonces` iff its
 * proof is shape-valid, i.e. `_classifyProof` returned a nonce) — AND on the SAME
 * `typeof co.verified_id === "string"` co-signer guard the CHECK loop
 * (`foldPresenceGate`) and `deriveProofAttributionMap` apply. So burn-set ≡
 * check-set EXACTLY on BOTH axes (the broker-sig verdict AND the co-signer
 * `verified_id`), and BOTH are a pure function of the record BYTES — independent of
 * the broker-sig verdict (R1 analyst INVEST-NOW: verdict axis; R2 4-agent-unanimous:
 * verified_id axis). This is load-bearing: an INVALID co-signer proof FOLDS
 * (read-time asymmetry), so if the burn were verdict-gated (PROVEN/EXPIRED-only) OR
 * shape-loose (any string) OR verified_id-unguarded while the check is
 * shape-valid-with-id, the two sets would diverge and a replayed INVALID-co-signer
 * nonce could double-admit OR a transient verifier error could oscillate chain
 * admission across re-folds. Matching both guards keeps the ledger re-fold-stable
 * by construction — and a malformed (verified_id-less) co-signer touches the ledger
 * on NEITHER side (it confers no gate attribution — `deriveProofAttributionMap`
 * skips it too — so it is fully inert).
 */
function registerPresenceNonce(record, seenPresenceNonces) {
  if (!seenPresenceNonces || typeof seenPresenceNonces.add !== "function") {
    return;
  }
  const content =
    record && record.content && typeof record.content === "object"
      ? record.content
      : {};
  const add = (proof) => {
    // Shape-valid ⟺ the fold's CHECK tracked this nonce (byte-pure symmetry).
    if (validatePresenceProofShape(proof).ok) {
      seenPresenceNonces.add(proof.nonce);
    }
  };
  add(content[PRESENCE_PROOF_FIELD]);
  if (Array.isArray(content.co_signers)) {
    for (const co of content.co_signers) {
      // Same guard as foldPresenceGate's CHECK loop + deriveProofAttributionMap:
      // a verified_id-less co-signer is skipped from BOTH the burn AND the check,
      // so burn-set === check-set exactly (R2 verified_id-axis residual).
      if (co && typeof co === "object" && typeof co.verified_id === "string") {
        add(co[PRESENCE_PROOF_FIELD]);
      }
    }
  }
}

module.exports = {
  STATUS,
  PRESENCE_FRESHNESS_SEC,
  PRESENCE_MAX_SKEW_SEC,
  resolveTrustAnchor,
  verifyPresenceProof,
  verifyCoSignerPresenceProof,
  foldPresenceGate,
  registerPresenceNonce,
  deriveProofAttribution,
  deriveProofAttributionMap,
};
