// presence-proof.js — #583 Shard 1: presence-proof schema + binding (SSOT).
//
// The HYBRID signing presence-proof contract (journal/0505) keeps the ssh/gpg
// RECORD signature UNCHANGED (fold rule-1, coordination-log.js::_verifyRule1,
// canonicalizes the full `core` = record − sig, so a new signature-covered
// field placed in `content` is auto-covered by the primary sig with NO
// fold-rule relaxation — AC-L11). On top of that, a BROKER-signed presence
// proof is persisted as a signature-covered field at `content.presence_proof`.
//
// The broker signs over the canonical bytes of the record's SEMANTIC-ACTUATION
// core — `type`, operator identity (`verified_id`/`person_id`), `content` (minus
// `co_signers`), AND the presence proof itself minus its own `broker_sig`
// (so the broker COMMITS to its `broker_verified_id` + `nonce` + `ts`). It
// EXCLUDES only: the primary `sig`, the emit-time-assigned fields the broker
// cannot know at approval time (`seq`/`prev_hash`/`ts`/`display_id`), `co_signers`
// (added later), and `presence_proof.broker_sig` (the self-reference field the
// broker is producing). Every signature excludes ONLY its own slot — exactly as
// fold rule-1 excludes only the top-level `sig` and a co-signer excludes only
// `co_signers`.
//
// Two rationales, both from the #583 Shard-1 redteam (co-owner-ratified
// 2026-07-15), refining journal/0505's original "_coSignedBytes precedent":
//   (1) EMIT-ENVELOPE EXCLUSION (R1 Finding 1): the off-loom broker signs DURING
//   the human-presence capture, BEFORE `coc-emit.js::emitSignedRecord` assigns
//   `seq`/`prev_hash`/`ts`/`display_id` when it finalizes the record; it cannot
//   know them. Binding them would REFUSE a genuine approval whenever a sibling
//   advances the chain during the seconds–minutes approval window (AC-L5). Chain
//   position stays bound by the operator's PRIMARY sig (rule-1 covers the full
//   record incl. this proof).
//   (2) NONCE/TS COMMITMENT (R2 security finding): the broker MUST bind its own
//   `nonce` (AC-L4) and freshness `ts` (AC-L5). The #583 mintability adversary
//   HOLDS the operator's primary key (journal/0505's honest caveat), so anything
//   covered ONLY by the primary sig is agent-forgeable. If the broker did NOT
//   sign the nonce, an agent could pair one genuine `broker_sig` with any fresh
//   nonce and REPLAY a single human approval unboundedly (the nonce ledger checks
//   a nonce the broker never signed). Keeping `nonce`/`ts` in the binding — and
//   excluding only `broker_sig` — is what makes the Shard-2 nonce-ledger + the
//   freshness check meaningful against that adversary.
//
// This module is the SINGLE SOURCE for the exact bytes the broker signs and the
// (Shard-2) fold predicate re-derives — the single-shared-function discipline of
// security.md § "Enforcement-Surface Parity": the broker signer and the
// independent verifier MUST consume ONE function, or the two derivations drift
// and a valid proof folds as forged (or vice-versa). loom-command's off-loom
// broker MUST compute the binding via THIS function's contract.
//
// Shard 1 delivers the schema + binding + shape validation ONLY. The fold
// predicate that VERIFIES broker_sig against the roster broker trust-anchor, the
// nonce-uniqueness / freshness checks, and the read-time distinguishability are
// Shard 2. Nothing here requires or enforces presence — a record without a
// presence_proof folds exactly as today.

const cocSign = require("./coc-sign.js");

// ---- schema constants -------------------------------------------------------

// The proof lives at record.content.presence_proof (inside `content`, alongside
// the co_signers convention), NOT at the record top level — so it is covered by
// the primary sig (rule-1 canonicalizes all of `core`) and excluded from the
// broker binding by name, mirroring how _coSignedBytes excludes co_signers.
const PRESENCE_PROOF_FIELD = "presence_proof";

// 128-bit CSPRNG nonce floor (AC-L4). The broker issues a single-use nonce of at
// least this many bytes; a shorter nonce is a replay-window / brute-force risk
// and is rejected fail-closed here at the shape gate (before Shard-2 uniqueness).
const MIN_NONCE_BYTES = 16;

const REQUIRED_PROOF_KEYS = ["broker_verified_id", "nonce", "ts", "broker_sig"];

// Canonical padded base64 (the broker emits a fixed-width nonce). Strict form so
// a malformed/short nonce cannot slip through Buffer.from's lenient decode.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// ISO-8601 with a REQUIRED timezone designator (Z or ±HH:MM) — a naive local
// timestamp is rejected. `new Date().toISOString()` (the record `ts` convention)
// is Z-suffixed. Freshness / clock-skew bounds are Shard 2 (AC-L5); Shard 1
// validates SHAPE only.
const ISO_8601_UTC_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

// ---- binding bytes (the shared enforcement-surface function) ----------------

/**
 * presenceProofBindingBytes(record) — the EXACT canonical bytes the presence
 * broker signs (producing content.presence_proof.broker_sig) and the Shard-2
 * fold predicate re-derives to verify that broker_sig against the roster broker
 * trust-anchor. Both surfaces MUST call THIS function (Enforcement-Surface
 * Parity) — a second copy of this derivation is BLOCKED.
 *
 * BINDING SET = record MINUS { top-level `sig`, `seq`, `prev_hash`, `ts`,
 * `display_id` } MINUS { `content.co_signers` } MINUS
 * { `content.presence_proof.broker_sig` }, then canonical-serialize. Everything
 * else — `type`, `verified_id`, `person_id`, `content` (incl. `presence_proof`
 * minus its `broker_sig`) — IS bound. The emit-time-assigned fields
 * (`seq`/`prev_hash`/`ts`/`display_id`) are excluded so the off-loom broker can
 * sign at human-approval time without knowing them (module header rationale 1);
 * only `broker_sig` is stripped from the proof so the broker commits to its own
 * `nonce`/`ts` (module header rationale 2).
 *
 * ORDERING / co_signers note: fold rule-1 (`coordination-log.js::_verifyRule1`)
 * canonicalizes the FULL core minus ONLY the top-level `sig`, so the operator's
 * PRIMARY sig DOES cover `content.co_signers` AND `content.presence_proof`.
 * Co-signed records work because the primary signs LAST (co-signers assemble into
 * `content.co_signers` first — each over `_coSignedBytes`, itself co_signers-
 * stripped — THEN the operator signs the full record). The Shard-4 construction
 * MUST therefore be "assemble co-signers → operator signs last"; a co-signer
 * appended AFTER the primary sig would invalidate the primary sig that protects
 * this proof. This binding excludes `co_signers` so the BROKER proof (signed
 * before the co-sign ceremony) stays stable across it — NOT because rule-1's
 * primary base excludes co_signers (it does not).
 *
 * @param {object} record — a coordination-log record. At broker-sign time the
 *   emit envelope + primary `sig` + `presence_proof.broker_sig` are absent; at
 *   fold-verify time they are present — stripping them makes the two derivations
 *   byte-identical.
 * @returns {Buffer} deterministic canonical UTF-8 bytes.
 * @throws {TypeError} if record is not a non-null object (a programming error,
 *   distinct from a malformed proof which is a fail-closed {ok:false}).
 */
function presenceProofBindingBytes(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError(
      "presenceProofBindingBytes: record must be a non-null object",
    );
  }
  // Strip the primary `sig` AND the emit-time-assigned fields the broker cannot
  // know at approval time — the chain envelope (`seq`/`prev_hash`/`ts`) and the
  // conditionally-added advisory `display_id` (all four assigned by coc-emit.js
  // when it finalizes the record, AFTER the broker has signed).
  const { sig, seq, prev_hash, ts, display_id, ...core } = record;
  const content =
    core.content &&
    typeof core.content === "object" &&
    !Array.isArray(core.content)
      ? core.content
      : {};
  // Strip `co_signers` (broker signs before the co-sign ceremony). WITHIN
  // `presence_proof`, strip ONLY `broker_sig` — the self-reference field the
  // broker produces — and KEEP broker_verified_id + nonce + ts so the broker
  // commits to its own single-use nonce (AC-L4) + freshness ts (AC-L5).
  const { co_signers, [PRESENCE_PROOF_FIELD]: proof, ...contentRest } = content;
  const contentForBinding = { ...contentRest };
  if (proof && typeof proof === "object" && !Array.isArray(proof)) {
    const { broker_sig, ...proofForBinding } = proof;
    contentForBinding[PRESENCE_PROOF_FIELD] = proofForBinding;
  } else if (proof !== undefined) {
    // Non-object proof (shape-invalid; rejected at the shape gate) — keep it
    // verbatim so the binding is still deterministic.
    contentForBinding[PRESENCE_PROOF_FIELD] = proof;
  }
  const baseForBinding = Object.assign({}, core, {
    content: contentForBinding,
  });
  return cocSign.canonicalSerialize(baseForBinding);
}

/**
 * coSignerPresenceProofBindingBytes(record, coSigner) — #583 Shard 4: the SSOT
 * binding for a CO-SIGNER's OWN presence proof (`co_signers[i].presence_proof`).
 *
 * The 4-eyes security of a gate-approval rests on the DISTINCT APPROVER's
 * presence, not only the requester/emitter's (journal/0510 N-1). Each co-signer
 * therefore carries its own broker-signed presence proof, and THIS function is
 * the single shared surface the off-loom broker signs and the loom fold verifier
 * (`presence-proof-verify.js::verifyCoSignerPresenceProof`) re-derives — the
 * Enforcement-Surface-Parity discipline (§ header): a second copy of this
 * derivation is BLOCKED.
 *
 * BINDING SET (mirrors `presenceProofBindingBytes` for the emitter, one indirection
 * over to the co-signer): record MINUS { top-level `sig`, `seq`, `prev_hash`,
 * `ts`, `display_id` } MINUS { `content.co_signers` } PLUS a computed
 * `co_signer_presence` binding field carrying { the co-signer's `verified_id`, the
 * proof's `broker_verified_id`, `nonce`, `ts` } (i.e. the co-signer proof MINUS
 * its own `broker_sig`). Then canonical-serialize.
 *
 * WHY THIS SHAPE (each clause is load-bearing, per the emitter binding's two
 * rationales extended to the co-signer):
 *   - EXCLUDE the emit envelope (`seq`/`prev_hash`/`ts`/`display_id`): the broker
 *     signs the co-signer's presence DURING human-presence capture at APPROVAL
 *     time, BEFORE `coc-emit.js::emitSignedRecord` assigns the envelope. Binding
 *     it would REFUSE a genuine approval whenever the chain advances during the
 *     approval window (AC-L5). Chain position stays bound by the operator's
 *     PRIMARY sig (rule-1 covers the full record incl. `content.co_signers` and
 *     each co-signer proof).
 *   - EXCLUDE `content.co_signers` (the whole array): co-signers assemble into the
 *     array at DIFFERENT times; a co-signer's proof MUST stay byte-stable as OTHER
 *     co-signers attach. This mirrors why the emitter binding excludes co_signers
 *     so its proof survives the co-sign ceremony.
 *   - BIND the co-signer's `verified_id`: so a genuine broker proof for approver A
 *     cannot be PORTED onto approver B's `co_signers[]` entry (the identity is in
 *     the signed bytes, not just the array position).
 *   - BIND `broker_verified_id` + `nonce` + `ts`, EXCLUDE only `broker_sig` (the
 *     self-reference the broker produces): the #583 mintability adversary HOLDS
 *     the operator's PRIMARY key, so anything covered ONLY by the primary sig is
 *     agent-forgeable. The broker MUST commit to its own single-use `nonce`
 *     (AC-L4) + freshness `ts` (AC-L5), or an agent pairs one genuine `broker_sig`
 *     with a fresh nonce and replays a single approval — exactly the emitter-proof
 *     R2 finding, one indirection over.
 *   - KEEP `content.presence_proof` (the EMITTER's proof) in the base: it is added
 *     before the co-sign ceremony and is stable at approval time, so binding the
 *     co-signer approval to the specific emitter-proof-bearing record is safe and
 *     tightens non-portability (approver A's proof does not transfer to a record
 *     whose emitter proof differs).
 *
 * The computed `co_signer_presence` field is a BINDING-ONLY construct — it is
 * NEVER written onto the record; both the broker and the fold verifier compute it
 * identically from the co-signer entry.
 *
 * @param {object} record — a coordination-log record carrying `content.co_signers`.
 * @param {object} coSigner — one `content.co_signers[i]` entry: at least
 *   `{ verified_id, presence_proof: { broker_verified_id, nonce, ts[, broker_sig] } }`.
 * @returns {Buffer} deterministic canonical UTF-8 bytes.
 * @throws {TypeError} if record or coSigner is not a non-null object (a
 *   programming error, distinct from a malformed proof which is a fail-closed
 *   {ok:false} at the shape gate).
 */
function coSignerPresenceProofBindingBytes(record, coSigner) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError(
      "coSignerPresenceProofBindingBytes: record must be a non-null object",
    );
  }
  if (
    coSigner === null ||
    typeof coSigner !== "object" ||
    Array.isArray(coSigner)
  ) {
    throw new TypeError(
      "coSignerPresenceProofBindingBytes: coSigner must be a non-null object",
    );
  }
  const { sig, seq, prev_hash, ts, display_id, ...core } = record;
  const content =
    core.content &&
    typeof core.content === "object" &&
    !Array.isArray(core.content)
      ? core.content
      : {};
  // Strip the WHOLE co_signers array (co-signers assemble at different times).
  const { co_signers, ...contentRest } = content;
  const proof =
    coSigner[PRESENCE_PROOF_FIELD] &&
    typeof coSigner[PRESENCE_PROOF_FIELD] === "object" &&
    !Array.isArray(coSigner[PRESENCE_PROOF_FIELD])
      ? coSigner[PRESENCE_PROOF_FIELD]
      : {};
  // The co-signer's identity + own proof commitments, MINUS broker_sig (the
  // self-reference field the broker is producing). A binding-only construct —
  // never written onto the record; the broker computes the identical field.
  const co_signer_presence = {
    verified_id: coSigner.verified_id,
    broker_verified_id: proof.broker_verified_id,
    nonce: proof.nonce,
    ts: proof.ts,
  };
  const baseForBinding = Object.assign({}, core, {
    content: { ...contentRest },
    co_signer_presence,
  });
  return cocSign.canonicalSerialize(baseForBinding);
}

// ---- shape validation (fail-closed) -----------------------------------------

/**
 * validatePresenceProofShape(proof) — fail-closed structural validation of a
 * content.presence_proof object. Returns {ok:true} or {ok:false, reason} — it
 * NEVER throws for a malformed proof (a malformed proof is a REFUSE verdict the
 * Shard-2 fold predicate acts on, per evidence-first-claims.md MUST-3 fail-
 * closed, not a crash). This checks SHAPE only; broker-sig cryptographic
 * verification + nonce-uniqueness + freshness are Shard 2.
 *
 * @param {*} proof — the record.content.presence_proof value.
 * @returns {{ok: boolean, reason?: string}}
 */
function validatePresenceProofShape(proof) {
  if (proof === null || typeof proof !== "object" || Array.isArray(proof)) {
    return { ok: false, reason: "presence_proof must be a non-null object" };
  }
  for (const k of REQUIRED_PROOF_KEYS) {
    if (!(k in proof)) {
      return {
        ok: false,
        reason: `presence_proof missing required field: ${k}`,
      };
    }
  }
  if (
    typeof proof.broker_verified_id !== "string" ||
    proof.broker_verified_id.length === 0
  ) {
    return {
      ok: false,
      reason: "presence_proof.broker_verified_id must be a non-empty string",
    };
  }
  if (typeof proof.nonce !== "string" || !BASE64_RE.test(proof.nonce)) {
    return {
      ok: false,
      reason: "presence_proof.nonce must be a canonical base64 string",
    };
  }
  const nonceBytes = Buffer.from(proof.nonce, "base64");
  // Round-trip guard: BASE64_RE alone accepts strings Buffer decodes shorter;
  // re-encode and compare so a malformed nonce cannot understate its length.
  if (nonceBytes.toString("base64") !== proof.nonce) {
    return {
      ok: false,
      reason:
        "presence_proof.nonce is not canonical base64 (round-trip mismatch)",
    };
  }
  if (nonceBytes.length < MIN_NONCE_BYTES) {
    return {
      ok: false,
      reason: `presence_proof.nonce decodes to ${nonceBytes.length} bytes; floor is ${MIN_NONCE_BYTES} (128-bit CSPRNG nonce)`,
    };
  }
  if (typeof proof.ts !== "string" || !ISO_8601_UTC_RE.test(proof.ts)) {
    return {
      ok: false,
      reason:
        "presence_proof.ts must be an ISO-8601 timestamp with a timezone designator (Z or ±HH:MM)",
    };
  }
  if (typeof proof.broker_sig !== "string" || proof.broker_sig.length === 0) {
    return {
      ok: false,
      reason: "presence_proof.broker_sig must be a non-empty string",
    };
  }
  return { ok: true };
}

module.exports = {
  PRESENCE_PROOF_FIELD,
  MIN_NONCE_BYTES,
  REQUIRED_PROOF_KEYS,
  presenceProofBindingBytes,
  coSignerPresenceProofBindingBytes,
  validatePresenceProofShape,
};
