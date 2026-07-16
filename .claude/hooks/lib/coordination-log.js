/**
 * coordination-log — fold engine + fold rules 1-8 + record-type dispatch +
 * predicate-registration API.
 *
 * Shard A2a (workspaces/multi-operator-coc, design v11 §2.2).
 *
 * This module is the canonical fold engine for the multi-operator
 * coordination log. Every signed record consumed by the substrate flows
 * through `foldLog()`; the M0 predicates (fold-genesis-anchor.js for rule
 * 9a, fold-rule-10.js for liveness-contradiction) are registered as
 * record-type dispatch entries and invoked by the engine after the
 * universal rule-1 (signature) + rule-2 (chain) + rule-3 (fork) gates
 * pass.
 *
 * The 9 invariants this module holds (the A2a shard contract):
 *
 *   (1) Fold rule 1 — signature verification gate. Records with invalid
 *       sigs OR signed by keys absent from the roster are rejected before
 *       any predicate runs. Surfaces both authoritative_for_record and
 *       authoritative_for_aggregate bits per record type.
 *
 *   (2) Fold rule 2 — per-emitter chain integrity. seq exactly +1 from
 *       prior accepted record by same verified_id; prev_hash matches the
 *       canonical content hash of the prior record. Stale seq → rejected.
 *
 *   (3) Fold rule 3 — fork detection. Two records at the same
 *       (verified_id, seq) with different content hashes = cryptographic
 *       equivocation proof; surfaced in the `forks` array NAMING the
 *       equivocator via verified_id.
 *
 *   (4) Fold rule 4 — mutation scoping. A record may mutate only its
 *       emitter's own state. The emitter is the person whose roster
 *       entry contains the signer's verified_id. Cross-operator records
 *       (`reap`, `compaction-checkpoint`, `generation-rotation`,
 *       `genesis-migration`) require a second signer matching one of the
 *       roster's eligible persons.
 *
 *   (5) Fold rule 5 — checkpoint reconciliation. A `compaction-checkpoint`
 *       skips records before up_to_seq only if 2-of-N owner-co-signed AND
 *       it carries, per emitter, the retained chain-head AND the
 *       from-genesis transitive closure of the checkpoint-exempt
 *       subsequence AND a folded-state digest AND the pinned
 *       refs/coc/archive-genN tip hash.
 *
 *   (6) Fold rule 6 — checkpoint-exempt GENERIC + two-tier retention.
 *       EVERY signed witness/accountability/trust-root record type is
 *       checkpoint-exempt by default; pure-liveness churn is the explicit
 *       exception. A new record type defaults to exempt unless its
 *       registration justifies non-exemption.
 *
 *   (7) Fold rule 7 — liveness as read-time fold predicate. Session live
 *       iff last heartbeat within LIVENESS_TTL (20 min by ts) AND
 *       unclosed; claim active iff unexpired, session live,
 *       unreleased/unreaped.
 *
 *   (8) Fold rule 8 — partial-push gap advisory. Cross-checks each
 *       emitter's visible claim/release/lease-override seq vs heartbeat
 *       high-water; gap → "unpushed records" advisory.
 *
 *   (9) Record-type dispatch table + predicate-registration API. The
 *       engine exposes registerFoldPredicate(recordType, predicateFn,
 *       opts) so future record types extend the dispatch without engine
 *       changes. M0 predicates (fold-genesis-anchor.js, fold-rule-10.js)
 *       are pre-registered at module load.
 *
 * Style: CommonJS, zero-dep, matches sibling .claude/hooks/lib/*.js. Pure
 * function over an INJECTED peerHighWaterFor callback; no fs, no
 * network, no clock (caller supplies opts.now where time matters).
 *
 * Transport interface (consumed by future shards A2b + A3):
 *
 * @typedef {Object} Transport
 * @property {() => Promise<Array<object>>} readAllRecords
 *   Returns the full log as an array of signed records (each carrying
 *   {type, verified_id, person_id, seq, prev_hash, ts, content, sig}).
 *   Order MAY be any order — the fold engine sorts/groups by emitter.
 * @property {(record: object) => Promise<{ok: true} | {ok: false, error: string}>} appendRecord
 *   Atomically append a signed record. Implementations MUST guarantee
 *   either the full record lands or none of it does (O_APPEND on local
 *   filesystem; atomic git push for the git-ref transport).
 * @property {() => Promise<string>} headHash
 *   Hash of the current log tip for staleness detection. Callers use
 *   this to know whether to re-fetch before append (optimistic
 *   concurrency control).
 * @property {(verified_id: string) => Promise<number | null>} peerHighWaterFor
 *   Returns the highest seq observed for the given verified_id's
 *   per-emitter chain across peers, per the rule-9d peer-high-water
 *   mechanism (R8-S-04, R10-S-01). Returns null when the clone has not
 *   fetched / cannot resolve. Caller (fold engine) treats null as
 *   "unknown" for rule-8 partial-push gap detection and rule-10
 *   settlement.
 *
 * A2b (next shard) ships the filesystem transport; A3 ships the git-ref
 * transport. Both implement this contract.
 */

"use strict";

const crypto = require("crypto");
const cocSign = require("./coc-sign.js");
const { foldGenesisAnchor } = require("./fold-genesis-anchor.js");
const {
  foldRevocation,
  LIVENESS_TTL_MS: REV_TTL,
} = require("./fold-rule-10.js");
const { computeDerivedN } = require("./derive-n.js");
const { foldReap } = require("./fold-rule-reap.js");
const { foldPostureEvent } = require("./fold-posture-event.js");
// F14 CRIT-1: bind generation-rotation + genesis-migration to their real
// fold predicates instead of the M0-default no-op accept. Without these
// wires, a single roster member could land a single-signer
// genesis-migration past rules 1-5 and posture-v2.resolveTrustRoot would
// rebase the trust root to their key.
const { foldGenerationRotation } = require("./fold-rule-9b.js");
const { foldGenesisMigration } = require("./fold-rule-9c.js");
// FSUB (2026-06-11): journal-body-anchor fold predicate — registered in
// _registerM0Defaults so emitted anchors fold in EVERY default-engine
// consumer (an unregistered type is dispatch-rejected and rule-2-poisons
// the emitter's subsequent chain). journal-body-anchor.js requires only
// node builtins — no require cycle.
const journalBodyAnchor = require("./journal-body-anchor.js");
// ECO-IMPL W2-S1 (A1-T1): cascade-membership registry predicates (M1–M4 +
// disclosure-isolation + genesis-precedes). Registered in
// _registerM0Defaults so member-registry records fold in EVERY
// default-engine consumer AND so coc-emit.js::emitSignedRecord accepts the
// namespace (an unregistered type is dispatch-rejected and rule-2-poisons
// the emitter's subsequent chain). fold-member-registry.js requires only
// coc-sign + node:crypto — no require cycle (it does NOT require this file).
const foldMemberRegistry = require("./fold-member-registry.js");
// ECO-IMPL W2-S2 (A1-T2): project-side single-valued `upstream-canon`
// pointer predicate (the P-side half of the handshake). Same registration
// rationale as the member-registry block above — registering it here lets
// emitSignedRecord accept the type AND foldLog dispatch it.
// fold-upstream-canon.js is zero-dep (no require cycle).
const foldUpstreamCanon = require("./fold-upstream-canon.js");
// ECO-IMPL W4-S1 (A2-T1): capability-lifecycle ledger fold predicates (the
// §4.2 record namespace + dual code/artifact lineage). Same registration
// rationale as the member-registry block above — registering them here lets
// emitSignedRecord accept every §4.2 type (invariant i) AND foldLog dispatch
// them. fold-capability-ledger.js requires only coc-sign + node:crypto — no
// require cycle (it does NOT require this file).
const foldCapabilityLedger = require("./fold-capability-ledger.js");
// F14 MED-3: route inline R5-S-04 host_role:ci + role checks through
// the single eligibility predicate so drift across rule 5 / 9b / 9c is
// closed structurally.
const { isEligibleSigner } = require("./eligibility.js");
// F14 C2 iter-3 root-cause fix: case-insensitive login compare for
// victim-chain population. Roster `github_login: "Alice"` vs revocation
// `content.github_login: "alice"` must populate the chain (fold-rule-10
// settlement bypass otherwise).
const { loginsEqual } = require("./github-login.js");
// #583 Shard 2: the presence-proof fold gate (broker-sig verify against a
// roster trust_anchors entry + single-use nonce ledger + freshness classifier,
// fail-closed). Verifies content.presence_proof on any record that carries one;
// a record WITHOUT a proof folds exactly as today.
const {
  foldPresenceGate,
  registerPresenceNonce,
  // #583 Shard 3b (L7): proof-derived attribution downgrade. Stamps every
  // accepted actuation / proof-bearing record with its EFFECTIVE gate-eligibility
  // host_role (PROVEN → roster host_role; NOT-PROVEN → "ci" audit-only), DERIVED
  // from the verified presence status — never a payload claim (see the accept
  // path in _foldLog).
  // #583 Shard 4 (N-1): the PER-SIGNER attribution map (`by_verified_id`) — one
  // entry per { emitter + each co-signer }, so a gate consumer can confirm the
  // DISTINCT approver (not only the emitter) was PROVEN-present.
  deriveProofAttributionMap,
} = require("./presence-proof-verify.js");
// #583 Shard 3a (F5/Q5a): the actuation partition, asserted structurally at
// module load against this engine's checkpoint-exempt + registration metadata
// (see the invariant assert after the default engine is built). actuation-types
// is a leaf module (requires only fs/path); this import cannot close a cycle.
const { ACTUATION_RECORD_TYPES } = require("./actuation-types.js");

/**
 * LIVENESS_TTL_MS — 20 minutes per architecture §4.4. Same constant as
 * fold-rule-10.js (R10-A-01 explicitly requires identical wall-clock TTL
 * to the §4.4 reap predicate). Re-exported by this module so callers
 * have one canonical import surface for fold rule 7 (liveness predicate)
 * and the reap/quiescence path.
 */
const LIVENESS_TTL_MS = REV_TTL;

// ---- compile-time invariant: rule 7 + rule 10 TTLs match --------------------
if (LIVENESS_TTL_MS !== REV_TTL) {
  // This branch can only fire if a future edit decouples the constants,
  // which would silently violate R10-A-01. Fail loud at module load.
  throw new Error(
    `coordination-log: LIVENESS_TTL_MS (${LIVENESS_TTL_MS}) does not match ` +
      `fold-rule-10.LIVENESS_TTL_MS (${REV_TTL}) — R10-A-01 requires identity`,
  );
}

// ---- canonical content hash --------------------------------------------------

/**
 * Hash the canonical-serialized content of a record (everything except `sig`).
 * Used by:
 *   - Rule 2: prev_hash chaining
 *   - Rule 3: fork detection (same emitter+seq, hash divergence)
 *   - Rule 5: checkpoint folded-state digest verification
 *
 * SHA-256 hex output (64 chars). Deterministic given canonicalSerialize is
 * deterministic — see coc-sign.js for the canonicalization contract.
 */
function _canonicalHash(core) {
  const { sig, ...content } = core;
  const bytes = cocSign.canonicalSerialize(content);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// ---- checkpoint-exempt vocabulary -------------------------------------------

/**
 * Per architecture §2.2 rule 6 — GENERIC + TWO-TIER RETENTION:
 *
 *   "Every signed witness / accountability / trust-root record type is
 *    checkpoint-exempt by default; non-exemption is the explicit
 *    justified exception."
 *
 * Default-exempt (NOT folded by `compaction-checkpoint::up_to_seq`):
 *   - violations
 *   - posture-event
 *   - lease-override
 *   - gate-approval
 *   - clone-init
 *   - collaborator-distinctness-attestation
 *   - collaborator-distinctness-revocation
 *   - genesis-anchor
 *   - all owner-signed types (compaction-checkpoint, generation-rotation,
 *     genesis-migration, reap)
 *
 * NON-exempt (pure-liveness churn — folded into the checkpoint's digest):
 *   - heartbeat
 *   - claim
 *   - release
 *   - session-open
 *   - session-close
 *   - operator-register
 *
 * A new record type is exempt-by-default unless its registration
 * explicitly justifies non-exemption (governs the *fold property*, NOT
 * the artifact-class — §9, R6-C-03).
 *
 * Implementation: the non-exempt set is the explicit denylist; everything
 * else is exempt. Per-engine registration metadata MAY override the
 * default for a specific record type.
 */
const NON_EXEMPT_BY_DEFAULT = new Set([
  "heartbeat",
  "claim",
  "release",
  "session-open",
  "session-close",
  "operator-register",
]);

// ---- engine context ---------------------------------------------------------

/**
 * Construct a new engine context with its own predicate registry. The
 * MODULE-DEFAULT engine inherits the M0 pre-registration; sandbox engines
 * created via createEngine({inheritDefaults: false}) start empty.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.inheritDefaults=true] - copy the module-default
 *   predicate registry. Set false for test sandboxes.
 * @returns {Engine} engine with its own foldLog, registerFoldPredicate,
 *   predicateMetadataFor, isCheckpointExempt bound to this registry.
 */
function createEngine(opts) {
  const inheritDefaults = !opts || opts.inheritDefaults !== false;
  /**
   * Predicate registry: recordType → {fn, meta}.
   * meta carries: {
   *   checkpoint_exempt: boolean (default true; explicit denylist below
   *                               flips to false for liveness-churn types),
   *   authoritative_for_record: boolean (default true; rule-1 fine-print
   *                                       flips to false for distinctness
   *                                       + operator-register + clone-init),
   *   authoritative_for_aggregate: boolean (true for distinctness +
   *                                          clone-init; false otherwise),
   * }
   */
  const registry = new Map();

  function registerFoldPredicate(recordType, fn, metaOpts) {
    if (typeof recordType !== "string" || !recordType) {
      throw new Error(
        "registerFoldPredicate: recordType must be a non-empty string",
      );
    }
    if (typeof fn !== "function") {
      throw new Error("registerFoldPredicate: predicate fn must be a function");
    }
    const m = metaOpts || {};
    // Default checkpoint_exempt per rule 6: exempt unless on the
    // pure-liveness denylist OR caller explicitly overrides.
    const defaultExempt = !NON_EXEMPT_BY_DEFAULT.has(recordType);
    const meta = {
      checkpoint_exempt:
        typeof m.checkpoint_exempt === "boolean"
          ? m.checkpoint_exempt
          : defaultExempt,
      authoritative_for_record:
        typeof m.authoritative_for_record === "boolean"
          ? m.authoritative_for_record
          : true,
      authoritative_for_aggregate:
        typeof m.authoritative_for_aggregate === "boolean"
          ? m.authoritative_for_aggregate
          : false,
    };
    registry.set(recordType, { fn, meta });
  }

  function predicateMetadataFor(recordType) {
    const entry = registry.get(recordType);
    if (!entry) return null;
    return Object.assign({}, entry.meta);
  }

  function isCheckpointExempt(recordType) {
    // Explicit registry override wins.
    const entry = registry.get(recordType);
    if (entry) return entry.meta.checkpoint_exempt === true;
    // No registration: default is the rule-6 default — exempt unless on
    // the pure-liveness denylist (architecture §2.2 rule 6: "A new record
    // type is exempt-by-default unless its registration explicitly
    // justifies non-exemption").
    return !NON_EXEMPT_BY_DEFAULT.has(recordType);
  }

  const engine = {
    registerFoldPredicate,
    predicateMetadataFor,
    isCheckpointExempt,
    // foldLog bound after registration helpers above so it can close over
    // `registry`.
    foldLog: (records, roster, foldOpts) =>
      _foldLog(records, roster, foldOpts, registry),
  };

  if (inheritDefaults) {
    _registerM0Defaults(registry);
  }

  return engine;
}

// ---- M0 predicate adapters --------------------------------------------------

/**
 * Adapter: bridges the engine's per-record dispatch interface
 *   predicate(record, ctx) → {accepted, foldState, reason, ...}
 * to fold-genesis-anchor.js's signature
 *   foldGenesisAnchor(record, foldState, roster, verifyFn).
 *
 * The engine pre-verifies sig at rule 1; the predicate re-verifies
 * (defense in depth — the predicate's owner-bind check requires the same
 * signature to be valid under the owner-bound pubkey, which may differ
 * from the rule-1 roster lookup if the predicate's pubkey resolution
 * follows a different path).
 */
function _genesisAnchorPredicate(record, ctx) {
  const state = ctx.foldState || { trustRoot: null };
  const result = foldGenesisAnchor(record, state, ctx.roster, cocSign.verify);
  return {
    accepted: result.accepted,
    foldState: result.foldState,
    reason: result.reason,
    fork: result.fork,
    forging_signer: result.forging_signer,
  };
}

/**
 * Adapter: bridges to fold-rule-10.js::foldRevocation. The engine
 * provides ctx.victimChainEntries (all records signed by the named
 * victim's verified_id, filtered to revocation-relevant types).
 */
function _revocationPredicate(record, ctx) {
  // Resolve victim chain entries from the engine's running state.
  const victimChainEntries = _collectVictimChainEntries(
    record,
    ctx.roster,
    ctx.acceptedSoFar,
  );
  const result = foldRevocation(record, {
    victimChainEntries,
    state: ctx.foldState,
  });
  if (result.contested) {
    return {
      accepted: false,
      contested: true,
      forging_signer: result.forging_signer,
      contested_by_record: result.contested_by_record,
      reason: result.reason,
      foldState: ctx.foldState,
    };
  }
  return {
    accepted: result.accepted,
    foldState: ctx.foldState,
    reason: result.reason,
  };
}

/**
 * Collect victim chain entries — all records signed by the verified_id
 * bound to the revoked github_login. Filtered to the types fold-rule-10
 * considers (per architecture §2.2 rule 10): heartbeat, session-open,
 * gate-approval, claim, OR any per-emitter chain entry.
 *
 * We pass everything signed by the victim's verified_id; fold-rule-10
 * already filters internally to the contradicting-activity types.
 */
function _collectVictimChainEntries(revocationRecord, roster, acceptedSoFar) {
  const targetLogin =
    revocationRecord.content && revocationRecord.content.github_login;
  if (!targetLogin || !roster || !roster.persons) return [];
  // Resolve the victim's verified_ids from the roster.
  // F14 C2 iter-3: case-insensitive compare per GitHub server semantics.
  const victimVerifiedIds = new Set();
  for (const person of Object.values(roster.persons)) {
    if (loginsEqual(person.github_login, targetLogin)) {
      for (const k of person.keys || []) {
        if (k.fingerprint) victimVerifiedIds.add(k.fingerprint);
      }
    }
  }
  if (victimVerifiedIds.size === 0) return [];
  // Pull every accepted record signed by one of those ids.
  return (acceptedSoFar || []).filter((r) =>
    victimVerifiedIds.has(r.verified_id),
  );
}

/**
 * Register the M0 predicates against an engine registry. Called at
 * createEngine time when inheritDefaults is true.
 */
function _registerM0Defaults(registry) {
  // genesis-anchor — authoritative for record (R9-A-03 owner-bind),
  // exempt-by-default per rule 6.
  registry.set("genesis-anchor", {
    fn: _genesisAnchorPredicate,
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: true,
      authoritative_for_aggregate: false,
    },
  });

  // collaborator-distinctness-revocation — advisory for the record itself
  // (rule-1 fine-print) but authoritative for derived-N aggregate.
  registry.set("collaborator-distinctness-revocation", {
    fn: _revocationPredicate,
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: false,
      authoritative_for_aggregate: true,
    },
  });

  // collaborator-distinctness-attestation — symmetric with revocation.
  // The attestation predicate is structurally trivial: the rule-1
  // signature gate already verifies the signer is in the roster; the
  // attestation IS its own admittance. Subsequent revocations or
  // attestations override via the latest-by-seq rule in derive-n.js.
  registry.set("collaborator-distinctness-attestation", {
    fn: (record, ctx) => ({ accepted: true, foldState: ctx.foldState }),
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: false,
      authoritative_for_aggregate: true,
    },
  });

  // clone-init — per-clone first-fold witness, advisory for record,
  // authoritative for aggregate (clone-fetched-before count).
  registry.set("clone-init", {
    fn: (record, ctx) => ({ accepted: true, foldState: ctx.foldState }),
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: false,
      authoritative_for_aggregate: true,
    },
  });

  // operator-register — advisory pre-roster registration; rule-1
  // fine-print says advisory-only AND non-exempt (pure-liveness churn).
  registry.set("operator-register", {
    fn: (record, ctx) => ({ accepted: true, foldState: ctx.foldState }),
    meta: {
      checkpoint_exempt: false,
      authoritative_for_record: false,
      authoritative_for_aggregate: false,
    },
  });

  // Pure-liveness churn — non-exempt per rule 6 denylist.
  // FSUB (2026-06-11): codify-lease + codify-lease-release join this
  // class — lease acquire/release records are the cross-clone visibility
  // surface for the on-disk codify-lease.json local mutex
  // (knowledge-convergence.md MUST-3). Same churn semantics as
  // claim/release: a released lease has no post-checkpoint value.
  for (const t of [
    "heartbeat",
    "claim",
    "release",
    "session-open",
    "session-close",
    "codify-lease",
    "codify-lease-release",
  ]) {
    registry.set(t, {
      fn: (record, ctx) => ({ accepted: true, foldState: ctx.foldState }),
      meta: {
        checkpoint_exempt: false,
        authoritative_for_record: true,
        authoritative_for_aggregate: false,
      },
    });
  }

  // FSUB (2026-06-11): journal-slot-reservation — M6 D's slot-reservation
  // record, previously registered ONLY in journal-write-guard.js's
  // sandboxed engine. Default-registering it is load-bearing: a record
  // type absent from the default registry is dispatch-rejected at fold
  // (line ~1479) WITHOUT advancing the emitter's chain state, so every
  // SUBSEQUENT record by that emitter fails rule 2 in every default-
  // engine fold (session-start, sessionend checkpoint, /claims) — the
  // chain-poisoning class. checkpoint_exempt: true matches the guard's
  // sandboxed registration (rule 6: signed witness/accountability records
  // exempt by default; body-anchors reference reservations via
  // slot_record_ref, so reservations must survive compaction).
  registry.set("journal-slot-reservation", {
    fn: (record, ctx) => ({ accepted: true, foldState: ctx.foldState }),
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: true,
      authoritative_for_aggregate: false,
    },
  });

  // FSUB (2026-06-11): journal-body-anchor — the M6 D invariant-6 body-
  // hash anchor. The fold predicate (re-hash + tamper surface) has lived
  // in journal-body-anchor.js since M6 D but was never registered, so an
  // emitted anchor would have been dispatch-rejected (same chain-
  // poisoning class as above). checkpoint_exempt: true per the module
  // header (rule 6: signed witness record).
  registry.set("journal-body-anchor", {
    fn: (record, ctx) => {
      const v = journalBodyAnchor.foldAnchorPredicate(record, {
        repoDir: ctx && ctx.opts ? ctx.opts.repoDir : undefined,
      });
      if (!v || v.accepted !== true) {
        return {
          accepted: false,
          reason: (v && v.reason) || "journal-body-anchor predicate rejected",
        };
      }
      // Tamper detected → fold-accept (the record IS the detection
      // evidence) AND forward the tampered flag + evidence so the engine
      // surfaces them (FSUB R1 reviewer LOW-2: pre-fix the wrapper
      // swallowed the verdict — the re-hash ran but its detection
      // surfaced nowhere, breaking the knowledge-convergence.md MUST-2
      // "fold-time re-hash detects body tamper and names the anchor's
      // SIGNER" promise).
      return {
        accepted: true,
        foldState: ctx.foldState,
        tampered: v.tampered === true,
        evidence: v.evidence,
      };
    },
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: true,
      authoritative_for_aggregate: false,
    },
  });

  // #47 (backlog-actionable-7): gate-op-receipt — the exact-tracking
  // receipt `artifact-flow.md` § "Exact Gate-1 / Gate-2 Tracking" MUST-2
  // mandates for every Gate-1 ingest AND Gate-2 distribution (emitted by
  // `sync-gate2-worktree.mjs` via coc-emit.js::emitSignedRecord). A signed
  // accountability/witness record — NOT an actuation (absent from
  // actuation-types.js ACTUATION_RECORD_TYPES, so it bypasses the A+
  // presence gate) and single-signer (no owner co-sig): the distributing
  // operator's own signature IS the accountability trail. checkpoint_exempt:
  // true per rule 6 (signed witness/accountability records survive
  // compaction) — same no-op-accept shape as journal-slot-reservation above.
  // Pre-#47 the type was UNregistered, so emitSignedRecord refused it at the
  // type-check and sync-gate2 emitted no record at all — the MUST-2 gap
  // (a rule mandating a record no code emitted and no fold type accepted)
  // this closes.
  registry.set("gate-op-receipt", {
    fn: (record, ctx) => ({ accepted: true, foldState: ctx.foldState }),
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: true,
      authoritative_for_aggregate: false,
    },
  });

  // CHFAPP (#868 reviewer R1 MED): checkpoint-skipped + session-notes-layout-
  // error — the two SessionEnd teardown witness records emitted by
  // multi-operator-sessionend.js. Pre-CHFAPP they were hand-appended (no seq /
  // prev_hash) so `_validateRecordShape` SHAPE-rejected them at every fold (seq
  // is a required field) — written to disk yet invisible to every fold consumer
  // (dead writes). Routing them through coc-emit.js::emitSignedRecord requires
  // them to be registered here (an UNregistered type is refused at emit's
  // type-check — the exact gap #47 closed for gate-op-receipt above). Same
  // no-op-accept signed-witness/accountability class as gate-op-receipt
  // (single-signer, NOT an actuation, checkpoint_exempt so the forensic trail
  // survives compaction).
  //   - checkpoint-skipped: records that a compaction-checkpoint was skipped
  //     because 2-of-N cosigner coordination is required (R8-LOW-1 audit trail).
  //   - session-notes-layout-error: records a per-operator fragment / forest-
  //     ledger write failure (observability.md forensic trail).
  registry.set("checkpoint-skipped", {
    fn: (record, ctx) => ({ accepted: true, foldState: ctx.foldState }),
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: true,
      authoritative_for_aggregate: false,
    },
  });
  registry.set("session-notes-layout-error", {
    fn: (record, ctx) => ({ accepted: true, foldState: ctx.foldState }),
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: true,
      authoritative_for_aggregate: false,
    },
  });

  // Owner-signed types — exempt per rule 6. Their rule-4 (mutation
  // scoping) check requires co-signers; rule 5 governs the checkpoint
  // specifically.
  //
  // F14 CRIT-1 — bind generation-rotation + genesis-migration to their
  // real predicates (fold-rule-9b + fold-rule-9c). Pre-hardening, both
  // types dispatched to the no-op accept, which let a single-signer
  // migration land + rebase posture-v2.resolveTrustRoot. The predicates
  // enforce 2-of-N owner-cosig + fresh gh_api capture (9c) + monotonic
  // generation increments + transitive archive-tip pin re-anchor (9b).
  //
  // compaction-checkpoint stays on the no-op-accept predicate: rule 5
  // (engine-side, _checkRule5) already enforces 2-of-N owner-cosig +
  // cryptographic verification of every cosig sig per F14 HIGH-2.
  //
  // lease-override + gate-approval ship _coSignedStubPredicate — the
  // 2-of-N owner-cosig minimum until a real predicate ships. Per F14
  // CRIT-1 audit: these record types accepted any single-signer record
  // pre-hardening. The stub mirrors _checkRule5's shape (2-of-N owner-
  // cosig + cryptographic verify + isEligibleSigner) so a forger cannot
  // land an unauthorized lease override or gate approval.
  //
  // EXCEPTION (M3 hardening HIGH-1 + HIGH-3): reap dispatches to
  // foldReap, which verifies the pinned victim heartbeat BYTEWISE
  // against acceptedSoFar + the engine's wall clock.
  registry.set("compaction-checkpoint", {
    fn: (record, ctx) => ({ accepted: true, foldState: ctx.foldState }),
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: true,
      authoritative_for_aggregate: false,
    },
  });
  registry.set("generation-rotation", {
    fn: foldGenerationRotation,
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: true,
      authoritative_for_aggregate: false,
    },
  });
  registry.set("genesis-migration", {
    fn: foldGenesisMigration,
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: true,
      authoritative_for_aggregate: false,
    },
  });
  // F14 MED-3: gate-approval → real predicate with context binding.
  //   - target_tool MUST be in TARGET_TOOL_ALLOWLIST (closed set per
  //     cc-artifacts.md Rule 10).
  //   - consumed_nonce MUST be a non-empty string.
  //   - requester_verified_id MUST resolve to a roster person (so
  //     observers can trace the requester chain post-fold).
  //   - REJECT if any acceptedSoFar gate-approval record has the same
  //     consumed_nonce (replay defense, defense-in-depth pair with
  //     operator-gate.js nonce binding).
  //   - Then delegate to _coSignedStubPredicate for the 2-of-N owner
  //     co-sign + cryptographic verify + isEligibleSigner machinery
  //     (already correct from F14 CRIT-1).
  //
  // lease-override stays on the stub: its context binding is `lease_subject`
  // (the path/glob the lease covers), which requires consulting the
  // active-lease registry — out of scope for this F14 MED-3 shard. The
  // stub still enforces 2-of-N owner co-sign + cryptographic verify, so
  // an attacker cannot land an unauthorized lease override; the gap is
  // that the predicate does not yet check `lease_subject` is currently
  // leased. KNOWN OUT-OF-SCOPE for the F14 substrate: a real lease-override
  // predicate consulting the active-lease registry is the M9.x follow-up.
  // The cryptographic core (2-of-N owner co-sign + verify + eligibility)
  // is intact — an attacker cannot land an unauthorized override; the
  // remaining gap is freshness, not authority. (Per zero-tolerance.md
  // Rule 2: documented as out-of-scope prose, no deferred-marker.)
  registry.set("gate-approval", {
    fn: _gateApprovalPredicate,
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: true,
      authoritative_for_aggregate: false,
    },
  });
  registry.set("lease-override", {
    fn: _coSignedStubPredicate,
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: true,
      authoritative_for_aggregate: false,
    },
  });
  // M4 C1: posture-event → engine-side fold predicate. Per architecture
  // §6.1 + §6.4 + rules/trust-posture.md MUST-3 (anti-self-upgrade) +
  // owner-only floor-set. The predicate enforces distinctness of signer
  // vs target_person_id for upgrades, owner-role for floor-set, and
  // accepts violation advisories. Wired as default so every engine
  // (including the module-default consumed by all hooks) dispatches
  // posture-event records to the real predicate, not a no-op.
  registry.set("posture-event", {
    fn: foldPostureEvent,
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: true,
      authoritative_for_aggregate: false,
    },
  });
  // M3 HIGH-1 + HIGH-3: reap → engine-side bytewise + wall-clock predicate.
  // checkpoint_exempt: true per architecture §2.2 rule 6 (reap is an
  // owner/co-signed accountability record; all signed-witness types exempt
  // by default; non-exemption requires explicit justification).
  registry.set("reap", {
    fn: foldReap,
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: true,
      authoritative_for_aggregate: false,
    },
  });

  // ECO-IMPL W2-S1 (A1-T1): cascade-membership registry namespace (M1–M4
  // + disclosure-isolation + genesis-precedes). These records live in a
  // SEPARATE log (refs/coc/member-registry → member-registry.jsonl) but
  // fold under THIS default engine (shared substrate, distinct namespace
  // per framework-first.md §9). checkpoint_exempt: true per rule 6 — every
  // membership record is a signed trust/accountability/trust-root record
  // (admission, sever, attestation, genesis-anchor, rotation) that MUST
  // survive compaction so the per-project causal chain (M2) re-derives.
  // Registering them here is load-bearing for emitSignedRecord's type-
  // check (member-registry.js::emitMemberRecord) AND for foldLog dispatch.
  for (const [type, fn] of [
    [
      foldMemberRegistry.TYPE_GENESIS_ANCHOR,
      foldMemberRegistry.foldRegistryGenesisAnchor,
    ],
    [
      foldMemberRegistry.TYPE_MEMBER_ADMITTED,
      foldMemberRegistry.foldMemberAdmitted,
    ],
    [
      foldMemberRegistry.TYPE_RECONCILIATION,
      foldMemberRegistry.foldReconciliationAttestation,
    ],
    [
      foldMemberRegistry.TYPE_MEMBERSHIP_SEVERED,
      foldMemberRegistry.foldMembershipSevered,
    ],
    [
      foldMemberRegistry.TYPE_GENERATION_ROTATION,
      foldMemberRegistry.foldRegistryGenerationRotation,
    ],
  ]) {
    registry.set(type, {
      fn,
      meta: {
        checkpoint_exempt: true,
        authoritative_for_record: true,
        authoritative_for_aggregate: false,
      },
    });
  }

  // ECO-IMPL W2-S2 (A1-T2): project-side `upstream-canon` pointer. Lives in
  // its OWN log (refs/coc/upstream-canon → upstream-canon.jsonl), folds
  // under THIS default engine. checkpoint_exempt: true — the pointer is a
  // signed trust record whose tip is the single-valued membership claim
  // (must survive compaction so the tip re-derives).
  registry.set(foldUpstreamCanon.TYPE_UPSTREAM_CANON, {
    fn: foldUpstreamCanon.foldUpstreamCanon,
    meta: {
      checkpoint_exempt: true,
      authoritative_for_record: true,
      authoritative_for_aggregate: false,
    },
  });

  // ECO-IMPL W4-S1 (A2-T1): capability-lifecycle ledger namespace (the §4.2
  // record types + dual code/artifact lineage). These records live in a
  // SEPARATE log (refs/coc/capability-ledger → capability-ledger.jsonl) but
  // fold under THIS default engine (shared substrate, distinct namespace per
  // framework-first.md §7 — NOT a second signing substrate). The FULL §4.2
  // type set is registered up front (invariant i: every emit type-checks
  // against the registered fold dispatch; an unknown type is dispatch-rejected
  // at fold AND refused by emitSignedRecord) — so sub-wave 2 (A2-T2 classifier
  // + A2-T3a DAG) never re-touches coordination-log.js. checkpoint_exempt:
  // true per rule 6 — every ledger record (rails / workaround / classification
  // / cascade / retirement / sever) is a signed lifecycle/accountability
  // record that MUST survive compaction so the capability-lineage chain
  // re-derives. Registering them here is load-bearing for emitSignedRecord's
  // type-check (capability-ledger.js::emitLedgerRecord) AND for foldLog
  // dispatch.
  for (const [type, fn] of foldCapabilityLedger.LEDGER_PREDICATES) {
    registry.set(type, {
      fn,
      meta: {
        checkpoint_exempt: true,
        authoritative_for_record: true,
        authoritative_for_aggregate: false,
      },
    });
  }
}

// ---- per-rule helpers -------------------------------------------------------

/**
 * F14 HIGH-2 — re-derive the canonical bytes a co-signer covered. Each
 * cosig is over the record core with `content.co_signers` REMOVED — same
 * convention as fold-rule-9b._coSignedBytes / fold-rule-9c._coSignedBytes.
 * The primary signer's `sig` is also stripped (cosig is detached, lives
 * inside content.co_signers).
 */
function _coSignedBytes(record) {
  const { sig, ...core } = record;
  const c = core.content || {};
  const { co_signers, ...contentForCoSig } = c;
  const baseForCoSig = Object.assign({}, core, { content: contentForCoSig });
  return cocSign.canonicalSerialize(baseForCoSig);
}

/**
 * #583 Shard 3b (L7) + Shard 4 (N-1) — stamp the proof-derived PER-SIGNER
 * attribution map onto a record that is about to land in `accepted[]`. Returns
 * the ORIGINAL record unchanged when there is nothing to attribute (non-actuation
 * + no emitter proof + no co-signer presence proof — the Shard-1 untouched
 * invariant), otherwise a COPY carrying a derived `_presence_attribution` field
 * whose shape is `{ by_verified_id: { <emitter>: {...}, <approver>: {...} } }`.
 *
 * The stamp is a pure derivation from (each signer's verified_id → roster) + the
 * fold-verified statuses (the emitter's `presenceStatus` + the per-co-signer
 * `coSignerStatuses` foldPresenceGate computed) — NEVER a payload claim. Any
 * `_presence_attribution` an adversary set on the incoming record is DROPPED first
 * (Object.assign overwrites it with the derivation), so a downstream gate consumer
 * reading `_presence_attribution.by_verified_id[approver].gate_eligible` cannot be
 * fed a forged audit-only→human upgrade for the emitter OR any co-signer.
 *
 * A COPY is stamped (never a mutation of `record`) so the original is passed
 * intact to registerPresenceNonce + _advanceChainState (which read the
 * as-signed bytes / nonce), leaving the per-emitter chain hash untouched. The
 * stamp stays a fold-derived TOP-LEVEL field named `_presence_attribution` (never
 * inside `content`) so it is invisible to the canonical hash + primary sig, and
 * `computeOwnChainHead` strips the whole (now larger) field by key — the
 * Shard-3b-R2 chain-head-divergence trap does NOT re-open (the field NAME is
 * unchanged; the single strip site drops it regardless of internal shape).
 *
 * @param {object} coSignerStatuses — { verified_id → STATUS } from foldPresenceGate.
 */
function _stampPresenceAttribution(
  record,
  roster,
  presenceStatus,
  coSignerStatuses,
) {
  const attr = deriveProofAttributionMap(
    record,
    roster,
    presenceStatus,
    coSignerStatuses,
  );
  if (attr) {
    // Stamp: drop any incoming `_presence_attribution` (never trusted) and
    // attach the derivation. `_presence_attribution` is a fold-derived top-level
    // field; it is NOT part of content and never enters the signed/canonical bytes.
    const { _presence_attribution, ...rest } = record;
    return Object.assign({}, rest, { _presence_attribution: attr });
  }
  // Nothing to attribute (a non-actuation record with no proof — the Shard-1
  // untouched invariant). Return the record AS-IS in the common legit case (no
  // copy, zero byte change), BUT if it carries a forged top-level
  // `_presence_attribution` an adversary hand-signed into the record, STRIP it
  // so the forgery can NEVER survive into accepted[]. This makes the "IGNORED /
  // OVERWRITES" invariant hold UNIVERSALLY — on the null-attr path too, not only
  // when a derivation applies (R1 security-reviewer MEDIUM). Fail-closed: a
  // downstream reader of `_presence_attribution` cannot be fed a forged
  // audit-only→human upgrade on ANY record class.
  if (
    record &&
    typeof record === "object" &&
    Object.prototype.hasOwnProperty.call(record, "_presence_attribution")
  ) {
    const { _presence_attribution, ...rest } = record;
    return rest;
  }
  return record;
}

/**
 * F14 CRIT-1 stub — predicate for record types whose REAL fold predicate
 * has not yet shipped (lease-override, gate-approval). Enforces the
 * minimum 2-of-N owner-cosig invariant + cryptographic verification of
 * every cosig + R5-S-04 (host_role:ci ineligibility) via the shared
 * eligibility predicate, then accepts.
 *
 * Once a real predicate ships, the registration in _registerM0Defaults
 * MUST be updated to dispatch to the real predicate.
 */
function _coSignedStubPredicate(record, ctx) {
  const state = (ctx && ctx.foldState) || { trustRoot: null };
  const roster = ctx && ctx.roster;
  const c = (record && record.content) || {};
  if (!Array.isArray(c.co_signers) || c.co_signers.length === 0) {
    return {
      accepted: false,
      foldState: state,
      reason: `${record.type}: 2-of-N owner co-signature required; co_signers missing or empty`,
    };
  }
  const distinctSigners = new Set([record.verified_id]);
  const coSignedBytes = _coSignedBytes(record);
  for (const co of c.co_signers) {
    if (!co || typeof co !== "object") {
      return {
        accepted: false,
        foldState: state,
        reason: `${record.type}: co_signer entry malformed`,
      };
    }
    if (typeof co.verified_id !== "string" || !co.verified_id) {
      return {
        accepted: false,
        foldState: state,
        reason: `${record.type}: co_signer missing verified_id`,
      };
    }
    if (typeof co.sig !== "string" || !co.sig) {
      return {
        accepted: false,
        foldState: state,
        reason: `${record.type}: co_signer missing sig`,
      };
    }
    if (distinctSigners.has(co.verified_id)) {
      return {
        accepted: false,
        foldState: state,
        reason: `${record.type}: co_signer ${co.verified_id} not distinct from prior signer`,
      };
    }
    const resolved = _resolveRosterPerson(roster, co.verified_id);
    if (!resolved) {
      return {
        accepted: false,
        foldState: state,
        reason: `${record.type}: co_signer ${co.verified_id} not in roster`,
      };
    }
    // F14 MED-3: route through isEligibleSigner; gate-approval may accept
    // either owner or senior (per eligibility.js _REQUIRED_ROLES), so we
    // dispatch by record type. lease-override is owner-only per the
    // owner-class roster-edit constraint.
    const ctxName =
      record.type === "gate-approval" ? "gate-approval" : "owner-quorum";
    const elig = isEligibleSigner(resolved.person, ctxName);
    if (!elig.eligible) {
      return {
        accepted: false,
        foldState: state,
        reason: `${record.type}: co_signer ${co.verified_id} ineligible: ${elig.reason}`,
      };
    }
    const matchingKey = (resolved.person.keys || []).find(
      (k) => k.fingerprint === co.verified_id,
    );
    if (!matchingKey) {
      return {
        accepted: false,
        foldState: state,
        reason: `${record.type}: co_signer ${co.verified_id} has no roster pubkey match`,
      };
    }
    let r;
    try {
      r = cocSign.verify(coSignedBytes, co.sig, matchingKey.pubkey, {
        keyType: matchingKey.type,
      });
    } catch (err) {
      return {
        accepted: false,
        foldState: state,
        reason: `${record.type}: co_signer verify threw: ${err && err.message ? err.message : String(err)}`,
      };
    }
    if (!r || !r.ok || !r.valid) {
      return {
        accepted: false,
        foldState: state,
        reason: `${record.type}: co_signer signature did not verify: ${r && r.reason ? r.reason : "invalid"}`,
      };
    }
    distinctSigners.add(co.verified_id);
  }
  if (distinctSigners.size < 2) {
    return {
      accepted: false,
      foldState: state,
      reason: `${record.type}: 2-of-N owner co-signature required; only ${distinctSigners.size} distinct signer(s)`,
    };
  }
  return { accepted: true, foldState: state };
}

/**
 * F14 MED-3 — real predicate for `gate-approval` records.
 *
 * Defense-in-depth pair with operator-gate.js MED-1+MED-2 enforcement.
 * Whereas the hook gates the PreToolUse decision, this predicate gates
 * what lands in the coordination log itself — so even if the hook is
 * bypassed (manual append, future transport bug), the fold engine refuses
 * structurally-invalid gate-approval records.
 *
 * Context-binding checks added beyond the stub:
 *   - target_tool ∈ closed allowlist (mirrors lib/gate-approval.js
 *     TARGET_TOOL_ALLOWLIST per cc-artifacts.md Rule 10).
 *   - consumed_nonce is a non-empty string.
 *   - requester_verified_id is a known roster person.
 *   - No prior accepted gate-approval has the same consumed_nonce
 *     (acceptedSoFar replay defense).
 *
 * After context binding, delegates to _coSignedStubPredicate for the
 * 2-of-N owner co-sign + cryptographic verify + isEligibleSigner
 * machinery, which the stub already shipped correctly under F14 CRIT-1.
 *
 * Lease-override: NOT yet on a real predicate. Context binding would be
 * `lease_subject` (the path/glob the lease covers) — requires consulting
 * the active-lease registry, which is out of scope for this shard.
 * Documented in the registration block above.
 */
const _GATE_APPROVAL_TARGET_TOOL_ALLOWLIST = new Set([
  "release",
  "posture-upgrade",
  "posture-override",
  "roster-edit-add-contributor",
  "new-rule-codify",
]);

function _gateApprovalPredicate(record, ctx) {
  const state = (ctx && ctx.foldState) || { trustRoot: null };
  const c = (record && record.content) || {};

  // ---- target_tool allowlist (closed set per cc-artifacts.md Rule 10) ----
  if (typeof c.target_tool !== "string" || !c.target_tool) {
    return {
      accepted: false,
      foldState: state,
      reason: "gate-approval: content.target_tool required (MED-3)",
    };
  }
  if (!_GATE_APPROVAL_TARGET_TOOL_ALLOWLIST.has(c.target_tool)) {
    return {
      accepted: false,
      foldState: state,
      reason: `gate-approval: target_tool '${c.target_tool}' not in allowlist (MED-3)`,
    };
  }

  // ---- consumed_nonce shape + uniqueness ----------------------------------
  if (typeof c.consumed_nonce !== "string" || !c.consumed_nonce) {
    return {
      accepted: false,
      foldState: state,
      reason: "gate-approval: content.consumed_nonce required (MED-3)",
    };
  }
  const acceptedSoFar = (ctx && ctx.acceptedSoFar) || [];
  for (const prior of acceptedSoFar) {
    if (
      prior &&
      prior.type === "gate-approval" &&
      prior.content &&
      prior.content.consumed_nonce === c.consumed_nonce
    ) {
      return {
        accepted: false,
        foldState: state,
        reason: `gate-approval: consumed_nonce '${c.consumed_nonce}' already consumed by prior accepted gate-approval (MED-3 replay defense)`,
      };
    }
  }

  // ---- requester_verified_id roster membership ---------------------------
  if (typeof c.requester_verified_id !== "string" || !c.requester_verified_id) {
    return {
      accepted: false,
      foldState: state,
      reason: "gate-approval: content.requester_verified_id required (MED-3)",
    };
  }
  const roster = ctx && ctx.roster;
  const resolved = _resolveRosterPerson(roster, c.requester_verified_id);
  if (!resolved) {
    return {
      accepted: false,
      foldState: state,
      reason: `gate-approval: requester_verified_id '${c.requester_verified_id}' not in roster (MED-3)`,
    };
  }

  // ---- delegate to the stub for 2-of-N cosig + cryptographic verify -----
  return _coSignedStubPredicate(record, ctx);
}

/**
 * Validate structural shape of a record. Returns null on OK or a string
 * error. This is a defense-in-depth check; the per-record predicate may
 * impose tighter shape requirements specific to its type.
 */
function _validateRecordShape(record) {
  if (!record || typeof record !== "object") return "record not an object";
  if (typeof record.type !== "string" || !record.type) return "type missing";
  if (typeof record.verified_id !== "string" || !record.verified_id) {
    return "verified_id missing";
  }
  if (typeof record.person_id !== "string" || !record.person_id) {
    return "person_id missing";
  }
  if (
    typeof record.seq !== "number" ||
    !Number.isInteger(record.seq) ||
    record.seq < 0
  ) {
    return "seq must be non-negative integer";
  }
  if (typeof record.sig !== "string" || !record.sig) return "sig missing";
  if (record.prev_hash !== null && typeof record.prev_hash !== "string") {
    return "prev_hash must be null or string";
  }
  if (record.content === undefined || record.content === null) {
    return "content missing";
  }
  return null;
}

/**
 * Resolve the roster person whose keys include the given verified_id.
 * Returns {person_id, person} or null.
 */
function _resolveRosterPerson(roster, verifiedId) {
  if (!roster || !roster.persons) return null;
  for (const [pid, person] of Object.entries(roster.persons)) {
    const keys = (person && person.keys) || [];
    for (const k of keys) {
      if (k && k.fingerprint === verifiedId) {
        return { person_id: pid, person };
      }
    }
  }
  return null;
}

/**
 * Rule 1 — signature verification gate. Returns {ok, reason, pubkey,
 * keyType} on success-or-fail. The pubkey is returned for downstream
 * use by predicates that re-verify (defense-in-depth, e.g. genesis-anchor
 * which has an additional owner-bind check on top of rule 1).
 */
function _verifyRule1(record, roster, opts, gpgHome) {
  const resolved = _resolveRosterPerson(roster, record.verified_id);
  if (!resolved) {
    return {
      ok: false,
      reason: `rule 1: signer verified_id (${record.verified_id}) not in roster keys`,
    };
  }
  const matchingKey = (resolved.person.keys || []).find(
    (k) => k.fingerprint === record.verified_id,
  );
  if (!matchingKey) {
    return {
      ok: false,
      reason: `rule 1: roster person resolved but no key matching verified_id`,
    };
  }
  // skipSignatureVerify — keep the roster-MEMBERSHIP gate (an unrostered /
  // unknown-key record still rejects above) but skip the expensive
  // cryptographic verify. Used ONLY by the emit-time fold-validation guard
  // (coc-emit.js::_foldDelta): the candidate is freshly self-signed (its
  // signature is guaranteed valid) and the prior records are the already-
  // established accepted chain (verified when first folded), so re-verifying
  // every signature on every emit is pure waste — it does NOT change which
  // records fold-accept, only how long it takes. The COC-CHAIN guard needs
  // rule-2 (chain) + rule-3 (fork) + the predicate, none of which depend on
  // rule-1's crypto check. Read-time folds (every reader) ALWAYS verify
  // (this opt is never set there) — forgery detection is unaffected.
  if (opts && opts.skipSignatureVerify) {
    return {
      ok: true,
      resolvedPerson: resolved,
      pubkey: matchingKey.pubkey,
      keyType: matchingKey.type,
    };
  }
  // Re-derive canonical content bytes and verify the detached signature.
  const { sig, ...core } = record;
  let bytes;
  try {
    bytes = cocSign.canonicalSerialize(core);
  } catch (err) {
    return {
      ok: false,
      reason: `rule 1: canonicalSerialize failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
  let verifyResult;
  try {
    verifyResult = cocSign.verify(bytes, sig, matchingKey.pubkey, {
      keyType: matchingKey.type,
      // F17 — when the fold pre-created a shared GPG homedir, reuse it
      // (one agent per fold). undefined ⇒ _verifyGpg makes its own
      // ephemeral homedir per call (today's behavior; fail-to-slow-path).
      gpgHome,
      // F17 identity binding — the shared homedir holds EVERY roster key, so
      // bind this verify to THIS record's expected signer fingerprint. Without
      // it a multi-key keyring would accept a record signed by ANY rostered
      // key, letting operator B forge a record attributed to operator A
      // (the §1 bounded-trust impersonation adversary). Harmless on the SSH
      // path (ignored) and on the per-call path (single-key keyring already
      // binds) — strictly additive defense.
      expectedFpr: matchingKey.fingerprint,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `rule 1: verify threw: ${err && err.message ? err.message : String(err)}`,
    };
  }
  if (!verifyResult || !verifyResult.ok) {
    return {
      ok: false,
      reason: `rule 1: signature verify call failed: ${verifyResult && verifyResult.reason ? verifyResult.reason : "unknown"}`,
    };
  }
  if (!verifyResult.valid) {
    return {
      ok: false,
      reason: `rule 1: signature did not verify: ${verifyResult.reason || "invalid"}`,
    };
  }
  return {
    ok: true,
    resolvedPerson: resolved,
    pubkey: matchingKey.pubkey,
    keyType: matchingKey.type,
  };
}

/**
 * Rule 2 — per-emitter chain integrity. Verifies that this record's
 * (seq, prev_hash) chains correctly from the prior accepted record on
 * the same emitter's chain. The emitter chain state lives in
 * perEmitterState[verified_id] = {lastSeq, lastContentHash}.
 *
 * Returns {ok, reason}.
 *
 * Note: post-checkpoint/post-rotation chain continuation (rule 9b) is
 * shard A3's territory. This module's rule 2 enforces the universal
 * "seq monotonic +1 from prior record" invariant; the engine's caller
 * SHOULD seed perEmitterState with the retained chain-head BEFORE folding
 * post-checkpoint records, which lets rule 2 work uniformly across the
 * checkpoint boundary.
 */
function _checkRule2(record, perEmitterState) {
  const prior = perEmitterState[record.verified_id];
  if (!prior) {
    // First record on this emitter's chain — seq must be 0 and prev_hash null.
    if (record.seq !== 0) {
      return {
        ok: false,
        reason: `rule 2: first record on emitter's chain must have seq=0 (got ${record.seq})`,
      };
    }
    if (record.prev_hash !== null) {
      return {
        ok: false,
        reason: `rule 2: first record on emitter's chain must have prev_hash=null`,
      };
    }
    return { ok: true };
  }
  // Continuation
  const expectedSeq = prior.lastSeq + 1;
  if (record.seq !== expectedSeq) {
    return {
      ok: false,
      reason: `rule 2: stale or skipped seq — expected ${expectedSeq}, got ${record.seq}`,
    };
  }
  if (record.prev_hash !== prior.lastContentHash) {
    return {
      ok: false,
      reason: `rule 2: prev_hash mismatch — expected ${prior.lastContentHash}, got ${record.prev_hash}`,
    };
  }
  return { ok: true };
}

/**
 * Rule 3 — fork detection. Maintains a per-(verified_id, seq) seen map
 * of content hashes. A second record at the same emitter+seq with a
 * different content hash is an equivocation proof.
 *
 * Returns {fork: true, prior_hash, prior_record} OR {fork: false}.
 */
function _checkRule3(record, hashByEmitterSeq) {
  // M3 MED-1 / F-1: skip canonicalization for sig-less records. A
  // genuine equivocator MUST claim a signature (otherwise rule-1
  // rejects them); a record without a sig cannot equivocate because
  // the canonical-hash content doesn't anchor to a signed identity.
  // Cheap shape gate avoids unbounded canonicalization-before-sig DoS
  // via log spam (caller submits millions of sigless records to make
  // the engine canonical-serialize each one before rule-1 even runs).
  //
  // F14 HIGH-3 reachability note: this branch is STRUCTURALLY UNREACHABLE
  // from _foldLog because _validateRecordShape (line ~520) returns
  // "sig missing" when record.sig is not a non-empty string, AND shape
  // validation runs BEFORE _checkRule3 in the engine loop. The clause
  // is preserved as defense-in-depth — if a future caller invokes
  // _checkRule3 directly via _internal.* OR shape validation regresses,
  // this branch keeps the DoS bound intact. The substrate-hardening
  // integration test
  //   tests/integration/multi-operator/substrate-hardening.test.js
  //   :: "HIGH-3: sig-less records are rejected at shape validation before rule 3"
  // pins the ordering invariant: sig-less records must reject at "shape"
  // never at "rule-3", and forks[] stays empty for sig-less inputs.
  if (typeof record.sig !== "string" || !record.sig) {
    return { fork: false, this_hash: null };
  }
  // M9.1 R1 Sec-LOG-1 — fork-detection cache poisoning by sig-shaped
  // unverified records. This function is now READ-ONLY against
  // hashByEmitterSeq; the caller commits the cache entry via
  // _commitRule3CacheEntry AFTER rule-1 (signature verification) passes.
  // Pre-fix: a shape-valid but cryptographically-invalid record naming
  // a victim's verified_id + upcoming seq seeded the cache with an
  // attacker hash; the victim's legitimate record then triggered
  // fork-detection against the attacker's poisoning. Post-fix: cache
  // commits only on rule-1-passing records, so an attacker cannot frame
  // a victim by writing first with an invalid sig.
  const key = `${record.verified_id}:${record.seq}`;
  const thisHash = _canonicalHash(record);
  const prior = hashByEmitterSeq.get(key);
  if (prior && prior.hash !== thisHash) {
    return {
      fork: true,
      prior_hash: prior.hash,
      this_hash: thisHash,
      prior_record: prior.record,
    };
  }
  return { fork: false, this_hash: thisHash };
}

/**
 * Rule 3 cache commit — runs AFTER rule-1 signature verification passes,
 * per M9.1 R1 Sec-LOG-1. The fold engine MUST call this immediately
 * after rule-1 succeeds so a legitimate record's canonical hash is
 * recorded against (verified_id, seq) for later sibling fork-detection.
 * Sig-less records and rule-1-rejected records never reach this call,
 * which closes the cache-poisoning surface.
 */
function _commitRule3CacheEntry(record, thisHash, hashByEmitterSeq) {
  if (thisHash == null) return;
  const key = `${record.verified_id}:${record.seq}`;
  if (!hashByEmitterSeq.has(key)) {
    hashByEmitterSeq.set(key, { hash: thisHash, record });
  }
}

/**
 * Rule 4 — mutation scoping. A record's person_id MUST equal the
 * person_id of the roster entry that owns the signer's verified_id.
 * Cross-operator records (the co-signed types) carry the second signer
 * in content.co_signers / content.cosig and are exempted from the
 * person_id-must-match-signer check (the predicate validates co-signers
 * separately).
 *
 * Returns {ok, reason}.
 */
const COSIGNED_TYPES = new Set([
  "reap",
  "compaction-checkpoint",
  "generation-rotation",
  "genesis-migration",
]);

function _checkRule4(record, resolvedPerson) {
  if (COSIGNED_TYPES.has(record.type)) {
    // Co-signed types are exempt from the person_id-must-equal-signer
    // check; their own predicate validates co-signature semantics.
    return { ok: true };
  }
  if (record.person_id !== resolvedPerson.person_id) {
    return {
      ok: false,
      reason: `rule 4: mutation-scope violation — signer's roster person is ${resolvedPerson.person_id}, but record claims person_id ${record.person_id}`,
    };
  }
  return { ok: true };
}

/**
 * Rule 5 — checkpoint reconciliation. Validates that a
 * compaction-checkpoint carries the structurally-required fields. Per
 * architecture §2.2 rule 5:
 *   - 2-of-N owner-co-signed
 *   - per emitter: retained chain-head
 *   - from-genesis transitive closure of checkpoint-exempt subsequence
 *   - folded-state digest
 *   - pinned refs/coc/archive-genN tip hash
 *
 * Returns {ok, reason}. Full digest-replay validation (re-fold + match
 * digest) is M6 territory; this rule enforces structural completeness
 * AND the 2-of-N co-sign requirement.
 */
function _checkRule5(record, roster) {
  if (record.type !== "compaction-checkpoint") return { ok: true };
  const c = record.content || {};
  // Required fields
  if (!c.retained_chain_heads || typeof c.retained_chain_heads !== "object") {
    return {
      ok: false,
      reason: "rule 5: checkpoint missing required field retained_chain_heads",
    };
  }
  if (!c.exempt_closure || !Array.isArray(c.exempt_closure)) {
    return {
      ok: false,
      reason: "rule 5: checkpoint missing required field exempt_closure",
    };
  }
  if (typeof c.folded_state_digest !== "string" || !c.folded_state_digest) {
    return {
      ok: false,
      reason: "rule 5: checkpoint missing required field folded_state_digest",
    };
  }
  if (typeof c.archive_genN_tip_hash !== "string" || !c.archive_genN_tip_hash) {
    return {
      ok: false,
      reason: "rule 5: checkpoint missing required field archive_genN_tip_hash",
    };
  }
  // F51 NOTE: rule-5 records carry `archive_genN_tip_hash` as a bare
  // string (the pinned tip SHA), NOT a `{ref, tip_sha}` object. Without
  // an embedded ref name there is no archive ref to read live against —
  // unlike rule-9b's `archive_genN_tip_pin` which carries both halves
  // and IS wired through `verifyArchiveTipPin` (see fold-rule-9b.js
  // post-R9-A-01 block). Symmetric live-tip wiring for rule 5 is OUT
  // OF SCOPE for F51 by construction: rule-5's design carries the pin
  // hash via the rotation record (rule 9b transitively re-anchors it
  // per `_collectPriorArchivePins`), so a tampered rule-5 hash is
  // detected via the rule-9b path's live verification at the next
  // rotation. If rule-5 records ever grow a paired `archive_ref_name +
  // archive_genN_tip_hash` shape (and the field-presence check already
  // names `archive_ref_name` in `_collectPriorArchivePins` line 175,
  // suggesting a future-compatible extension), the verify hook should
  // land here under the same `ctx.opts.archiveTipVerify` gate as rule
  // 9b.
  // 2-of-N co-sign requirement
  if (!Array.isArray(c.co_signers) || c.co_signers.length === 0) {
    return {
      ok: false,
      reason:
        "rule 5: checkpoint requires 2-of-N owner-co-signature; co_signers missing or empty",
    };
  }
  // Verify each co-signer is a distinct owner-role person in the roster,
  // is R5-S-04 eligible (host_role!=ci), AND that the cosig signature
  // cryptographically verifies against the co-signer's roster pubkey
  // over the canonical bytes co-signers cover (record core with
  // content.co_signers stripped; same shape as fold-rule-9b._coSignedBytes).
  //
  // F14 HIGH-2: pre-hardening this loop verified roster membership +
  // role + host_role:ci exclusion + distinctness but never called
  // cocSign.verify() — a forger only needed any plausible base64 sig
  // string. fold-rule-9b/9c already verified bytewise; rule 5 drifted.
  //
  // F14 MED-3: role + host_role checks now route through
  // isEligibleSigner ("owner-quorum") so drift across rule 5 / 9b / 9c
  // is closed structurally.
  const signerVerifiedIds = new Set([record.verified_id]);
  const coSignedBytes = _coSignedBytes(record);
  for (const co of c.co_signers) {
    if (!co || typeof co !== "object") {
      return { ok: false, reason: "rule 5: co_signer entry malformed" };
    }
    if (typeof co.verified_id !== "string" || !co.verified_id) {
      return {
        ok: false,
        reason: "rule 5: co_signer entry missing verified_id",
      };
    }
    if (typeof co.sig !== "string" || !co.sig) {
      return { ok: false, reason: "rule 5: co_signer entry missing sig" };
    }
    if (signerVerifiedIds.has(co.verified_id)) {
      return {
        ok: false,
        reason: `rule 5: co_signer verified_id ${co.verified_id} not distinct from prior signer`,
      };
    }
    const resolved = _resolveRosterPerson(roster, co.verified_id);
    if (!resolved) {
      return {
        ok: false,
        reason: `rule 5: co_signer verified_id ${co.verified_id} not in roster`,
      };
    }
    const elig = isEligibleSigner(resolved.person, "owner-quorum");
    if (!elig.eligible) {
      return {
        ok: false,
        reason: `rule 5: co_signer ${co.verified_id} ineligible: ${elig.reason}`,
      };
    }
    // Cryptographic verification of the cosig signature (F14 HIGH-2).
    const matchingKey = (resolved.person.keys || []).find(
      (k) => k.fingerprint === co.verified_id,
    );
    if (!matchingKey) {
      return {
        ok: false,
        reason: `rule 5: co_signer ${co.verified_id} has no roster pubkey match`,
      };
    }
    let v;
    try {
      v = cocSign.verify(coSignedBytes, co.sig, matchingKey.pubkey, {
        keyType: matchingKey.type,
      });
    } catch (err) {
      return {
        ok: false,
        reason: `rule 5: co_signer verify threw: ${err && err.message ? err.message : String(err)}`,
      };
    }
    if (!v || !v.ok) {
      return {
        ok: false,
        reason: `rule 5: co_signer verify failed: ${v && v.reason ? v.reason : "unknown"}`,
      };
    }
    if (!v.valid) {
      return {
        ok: false,
        reason: `rule 5: co_signer signature did not verify: ${v.reason || "invalid"}`,
      };
    }
    signerVerifiedIds.add(co.verified_id);
  }
  // 2-of-N: at least 2 distinct signers (including the primary).
  if (signerVerifiedIds.size < 2) {
    return {
      ok: false,
      reason: `rule 5: 2-of-N owner-co-signature required; only ${signerVerifiedIds.size} distinct signer(s)`,
    };
  }
  return { ok: true };
}

/**
 * Rule 7 — liveness predicate (read-time fold). The engine exposes this
 * as a pure function consumed by `fold-rule-10.js::isSettled` AND by
 * future M2-M5 shards (adjacency-leasecheck, sessionstart).
 */
function isSessionLive(ctx) {
  const now = ctx && typeof ctx.now === "number" ? ctx.now : NaN;
  const hbTs =
    ctx && typeof ctx.lastHeartbeatTs === "string"
      ? Date.parse(ctx.lastHeartbeatTs)
      : NaN;
  if (Number.isNaN(now) || Number.isNaN(hbTs)) {
    return {
      live: false,
      reason: "missing or unparseable now / lastHeartbeatTs",
    };
  }
  if (ctx.sessionClosed === true) {
    return { live: false, reason: "session explicitly closed" };
  }
  const elapsed = now - hbTs;
  if (elapsed < 0) {
    return { live: false, reason: "heartbeat ts in the future" };
  }
  if (elapsed >= LIVENESS_TTL_MS) {
    return {
      live: false,
      reason: `last heartbeat ${elapsed}ms old, exceeds LIVENESS_TTL (${LIVENESS_TTL_MS}ms)`,
    };
  }
  return { live: true };
}

/**
 * Rule 7 continued — claim active predicate. A claim is active iff:
 *   - unexpired (expiresAtTs > now)
 *   - session live
 *   - unreleased
 *   - unreaped
 */
function isClaimActive(ctx) {
  if (!ctx) return { active: false, reason: "ctx missing" };
  if (ctx.released === true) return { active: false, reason: "claim released" };
  if (ctx.reaped === true) return { active: false, reason: "claim reaped" };
  if (ctx.sessionLive !== true) {
    return { active: false, reason: "session not live" };
  }
  const now = typeof ctx.now === "number" ? ctx.now : NaN;
  const exp =
    typeof ctx.expiresAtTs === "string" ? Date.parse(ctx.expiresAtTs) : NaN;
  if (Number.isNaN(now) || Number.isNaN(exp)) {
    return {
      active: false,
      reason: "missing or unparseable now / expiresAtTs",
    };
  }
  if (exp <= now) {
    return { active: false, reason: `claim expired at ${ctx.expiresAtTs}` };
  }
  return { active: true };
}

/**
 * Rule 8 — partial-push gap advisory. For each emitter, compare:
 *   - the highest seq this fold observed in claim/release/lease-override
 *   - the highest seq observed in heartbeat (the visible high-water)
 *   - the peer-observed high-water from peerHighWaterFor (the actual
 *     peer-side chain high-water, per rule-9d R8-S-04)
 *
 * A gap between the visible-claim/release high-water and the peer high-water
 * indicates the emitter has not pushed some records — selective push.
 *
 * Returns an array of {type: "partial-push-gap", verified_id, gap_seq_range}.
 */
function _detectPartialPushGaps(perEmitterStats, peerHighWaterFor) {
  if (typeof peerHighWaterFor !== "function") return [];
  const advisories = [];
  for (const [verifiedId, stats] of Object.entries(perEmitterStats)) {
    let peerHi;
    try {
      peerHi = peerHighWaterFor(verifiedId);
    } catch {
      // The callback threw — treat as unknown high-water; no advisory.
      continue;
    }
    if (peerHi === null || peerHi === undefined) continue;
    if (typeof peerHi !== "number") continue;
    const locallyVisibleHi = stats.highestSeq;
    if (peerHi > locallyVisibleHi) {
      advisories.push({
        type: "partial-push-gap",
        verified_id: verifiedId,
        gap_seq_range: [locallyVisibleHi + 1, peerHi],
        local_visible_high_water: locallyVisibleHi,
        peer_high_water: peerHi,
        reason: `emitter ${verifiedId}: local fold ends at seq ${locallyVisibleHi}; peer reports high-water ${peerHi}`,
      });
    }
  }
  return advisories;
}

// ---- main fold loop ---------------------------------------------------------

/**
 * Internal fold loop bound to a specific registry. Use `createEngine()`
 * to get a public foldLog handle.
 */
/**
 * Collect the DISTINCT armored GPG public keys across the whole roster
 * (F17). These are the only keys that can reach the rule-1 verify call —
 * `_verifyRule1` rejects any non-roster signer at `_resolveRosterPerson`
 * BEFORE verifying — so pre-importing exactly this set into one shared
 * homedir covers every verifiable record. SSH keys are skipped (they use
 * no GPG homedir). Returns [] when the roster has no GPG keys.
 */
function _collectRosterGpgPubkeys(roster) {
  const out = [];
  const seen = new Set();
  if (!roster) return out;
  for (const person of Object.values(roster.persons || {})) {
    const keys = (person && person.keys) || [];
    for (const k of keys) {
      if (k && k.type === "gpg" && typeof k.pubkey === "string" && k.pubkey) {
        if (!seen.has(k.pubkey)) {
          seen.add(k.pubkey);
          out.push(k.pubkey);
        }
      }
    }
  }
  // #583 Shard 2: the presence-proof fold gate verifies broker_sig against a
  // roster trust_anchors entry. A GPG-typed broker anchor's pubkey MUST be in
  // the shared verify-homedir too, or the gate falls back to a per-call
  // ephemeral homedir (correct but slow) — and, under the F17 expectedFpr bind,
  // a key absent from the shared homedir simply fails to verify. trust_anchors
  // live OUTSIDE roster.persons, so the persons-only sweep above misses them.
  for (const a of roster.trust_anchors || []) {
    if (a && a.type === "gpg" && typeof a.pubkey === "string" && a.pubkey) {
      if (!seen.has(a.pubkey)) {
        seen.add(a.pubkey);
        out.push(a.pubkey);
      }
    }
  }
  return out;
}

function _foldLog(records, roster, opts, registry) {
  const optsResolved = opts || {};
  const peerHighWaterFor =
    typeof optsResolved.peerHighWaterFor === "function"
      ? optsResolved.peerHighWaterFor
      : () => null;

  const accepted = [];
  const rejected = [];
  const forks = [];
  const advisories = [];
  const contestedRevocations = [];

  // Per-emitter chain state: verified_id → {lastSeq, lastContentHash}.
  // Seeded from opts.perEmitterStateSeed for post-checkpoint replay.
  const perEmitterState = Object.assign(
    {},
    optsResolved.perEmitterStateSeed || {},
  );
  // Per-emitter stats for rule 8.
  const perEmitterStats = {}; // verified_id → {highestSeq}
  // (verified_id, seq) → {hash, record} for rule 3.
  const hashByEmitterSeq = new Map();
  // #583 Shard 2: single-use presence-proof nonce ledger (AC-L4). Accumulates
  // the broker nonce of every ACCEPTED presence-bearing record so a later
  // record replaying the same nonce is rejected. The durable store IS this
  // append-only log — a full re-fold re-derives the set (durable by
  // construction). First occurrence wins; re-fold-stable.
  const seenPresenceNonces = new Set();
  // Running fold state (predicate side-effect surface, e.g. trustRoot).
  let foldState = Object.assign(
    { trustRoot: null },
    optsResolved.foldStateSeed || {},
  );

  if (!Array.isArray(records)) {
    return {
      foldState,
      accepted,
      rejected,
      forks,
      advisories,
      contestedRevocations,
      derivedN: null,
    };
  }

  // --- F17: one shared GPG verify-homedir per fold ---
  // Read-time folds verify every record's signature (the trust gate). Without
  // a shared homedir, each rule-1 verify spawns its own ephemeral gpg-agent
  // (~710ms — journal/0311 Issue B), so latency scales with the chain length.
  // Pre-import every distinct roster GPG key into ONE homedir (one agent), pass
  // it as gpgHome to every verify, and tear it down once in the finally below.
  // Skipped when skipSignatureVerify is set (no verify happens at all).
  // Fail-to-slow-path: if gpg is absent or creation fails, _sharedGpgHome stays
  // null and each verify falls back to its own ephemeral homedir (correct, slow).
  let _sharedGpgHome = null;
  if (!optsResolved.skipSignatureVerify) {
    const _gpgPubkeys = _collectRosterGpgPubkeys(roster);
    if (_gpgPubkeys.length > 0) {
      const _h = cocSign.createVerifyHomedir(_gpgPubkeys);
      if (_h.ok) _sharedGpgHome = _h.home;
    }
  }

  try {
    for (const record of records) {
      // --- Universal shape check ---
      const shapeErr = _validateRecordShape(record);
      if (shapeErr) {
        rejected.push({
          record,
          reason: `shape invalid: ${shapeErr}`,
          rule: "shape",
        });
        continue;
      }

      // --- Rule 3 (fork detection) — runs BEFORE rule 1 so the engine
      // catches the equivocator's two signed siblings even when the SECOND
      // sibling would otherwise pass rule 2. The fork-check itself does
      // not require signature verification: the hashes are over canonical
      // content (which includes the entire record minus `sig`), and the
      // forks: [] output cites the verified_id — the equivocator's own
      // claim. The forger cannot deny the equivocation because both records
      // are present in the log under the same verified_id.
      // ---
      const forkCheck = _checkRule3(record, hashByEmitterSeq);
      if (forkCheck.fork) {
        forks.push({
          verified_id: record.verified_id,
          seq: record.seq,
          hash_a: forkCheck.prior_hash,
          hash_b: forkCheck.this_hash,
          record_a: forkCheck.prior_record,
          record_b: record,
        });
        // The fork is surfaced; the second sibling is NOT accepted into
        // the fold state (engine refuses to extend the chain with an
        // equivocated record). Move on.
        rejected.push({
          record,
          reason: `rule 3: fork detected at (${record.verified_id}, ${record.seq}) — see forks[]`,
          rule: "rule-3",
        });
        continue;
      }

      // --- Rule 1 — signature verification gate ---
      const r1 = _verifyRule1(record, roster, optsResolved, _sharedGpgHome);
      if (!r1.ok) {
        rejected.push({ record, reason: r1.reason, rule: "rule-1" });
        continue;
      }

      // --- Rule 3 cache commit (Sec-LOG-1) — only rule-1-passing records
      //     get cached against (verified_id, seq) for later fork-detection.
      //     Prevents shape-valid-but-unverified records from poisoning the
      //     cache and framing legitimate emitters as equivocators. ---
      _commitRule3CacheEntry(record, forkCheck.this_hash, hashByEmitterSeq);

      // --- Rule 2 — per-emitter chain integrity ---
      const r2 = _checkRule2(record, perEmitterState);
      if (!r2.ok) {
        rejected.push({ record, reason: r2.reason, rule: "rule-2" });
        continue;
      }

      // --- Rule 4 — mutation scoping ---
      const r4 = _checkRule4(record, r1.resolvedPerson);
      if (!r4.ok) {
        rejected.push({ record, reason: r4.reason, rule: "rule-4" });
        continue;
      }

      // --- Rule 5 — checkpoint reconciliation (only for checkpoint records) ---
      const r5 = _checkRule5(record, roster);
      if (!r5.ok) {
        rejected.push({ record, reason: r5.reason, rule: "rule-5" });
        continue;
      }

      // --- #583 Shard 2 — presence-proof gate (cross-cutting; runs for every
      // record after the sig gate, before per-type dispatch). A record WITHOUT
      // a content.presence_proof passes untouched (Shard-1 invariant). A record
      // WITH one has its broker_sig verified against a roster trust_anchors
      // entry over the SSOT binding bytes, its nonce checked for single-use
      // (AC-L4 replay defense), and is fail-closed on any crypto/anchor/shape
      // failure. Freshness is a READ-TIME verdict (PROVEN vs EXPIRED), NOT a
      // chain-admission gate — only re-fold-stable, time-invariant conditions
      // reject here, so a legitimate historical actuation never oscillates out
      // of the fold (see presence-proof-verify.js header). ---
      const rp = foldPresenceGate(record, roster, {
        seenPresenceNonces,
        gpgHome: _sharedGpgHome || undefined,
      });
      if (!rp.accepted) {
        rejected.push({ record, reason: rp.reason, rule: "presence-proof" });
        continue;
      }

      // --- Record-type dispatch (rule 9 — registration API) ---
      const entry = registry.get(record.type);
      if (!entry) {
        rejected.push({
          record,
          reason: `unknown record type '${record.type}': no predicate registered`,
          rule: "dispatch",
        });
        continue;
      }
      let predicateResult;
      try {
        predicateResult = entry.fn(record, {
          foldState,
          roster,
          acceptedSoFar: accepted,
          opts: optsResolved,
          meta: entry.meta,
        });
      } catch (err) {
        rejected.push({
          record,
          reason: `predicate threw for type '${record.type}': ${err && err.message ? err.message : String(err)}`,
          rule: "dispatch",
        });
        continue;
      }
      if (!predicateResult || typeof predicateResult !== "object") {
        rejected.push({
          record,
          reason: `predicate for '${record.type}' returned non-object`,
          rule: "dispatch",
        });
        continue;
      }
      // Contested revocation (fold-rule-10 path)
      if (predicateResult.contested === true) {
        contestedRevocations.push({
          record,
          forging_signer: predicateResult.forging_signer,
          contested_by_record: predicateResult.contested_by_record,
          reason: predicateResult.reason,
        });
        // Mark the record contested in the accepted stream so derive-n can
        // see R10-A-03 exclusion. We DO accept the record into the stream
        // because derive-n needs to walk it AND mark it contested; without
        // accepting it, the contested-exclusion case in R10-A-03 has nothing
        // to exclude. The contested record is also surfaced separately in
        // contestedRevocations[] so consumer hooks can emit block-grade
        // integrity advisories naming the forger.
        const flagged = Object.assign({}, record, { rule10_contested: true });
        // #583 Shard 3b (L7): stamp attribution on this accept path too — a
        // no-op for a non-actuation revocation record, but uniform so a future
        // proof-bearing record on the flagged path is still proof-attributed.
        accepted.push(
          _stampPresenceAttribution(
            flagged,
            roster,
            rp.status,
            rp.coSignerStatuses,
          ),
        );
        // #583 Shard 2: a flagged-accepted record still LANDS in accepted[], so
        // if it carries a valid presence proof its nonce MUST be consumed too —
        // the single-use ledger invariant "every accepted proof-bearing record
        // burns its nonce" holds on ALL accept paths, not just the clean one.
        registerPresenceNonce(record, seenPresenceNonces);
        _advanceChainState(
          perEmitterState,
          perEmitterStats,
          record,
          forkCheck.this_hash,
        );
        continue;
      }
      if (predicateResult.accepted !== true) {
        rejected.push({
          record,
          reason:
            predicateResult.reason || `predicate rejected '${record.type}'`,
          rule: "predicate",
        });
        continue;
      }
      // Accepted: update fold state, chain state, stats.
      if (
        predicateResult.foldState &&
        typeof predicateResult.foldState === "object"
      ) {
        foldState = predicateResult.foldState;
      }
      // FSUB R1 LOW-2 — tamper-flagged accepted records (journal-body-anchor
      // re-hash mismatch). Mirror of the rule-10 contested path above: the
      // record IS the detection evidence so it folds + chains, but the
      // verdict surfaces BOTH as a flagged accepted record (consumers
      // filtering accepted[] see `body_anchor_tampered`) AND as a fold
      // advisory naming the anchor's SIGNER (per knowledge-convergence.md
      // MUST-2 + the §4.5 signer-vs-author residual: the accountable party
      // is the record's verified_id — the SIGNER — never the journal
      // frontmatter author).
      if (predicateResult.tampered === true) {
        advisories.push({
          type: "journal-body-anchor-tamper",
          verified_id: record.verified_id,
          person_id: record.person_id,
          display_id: record.display_id,
          seq: record.seq,
          evidence: predicateResult.evidence || null,
          reason:
            "journal-body-anchor re-hash mismatch: file bytes diverge from the signed anchor; accountable party is the anchor's SIGNER (verified_id above), not the frontmatter author",
        });
        const flagged = Object.assign({}, record, {
          body_anchor_tampered: true,
        });
        // #583 Shard 3b (L7): stamp attribution on the tamper path too (no-op
        // for a non-actuation journal-body-anchor record; uniform for parity).
        accepted.push(
          _stampPresenceAttribution(
            flagged,
            roster,
            rp.status,
            rp.coSignerStatuses,
          ),
        );
        // #583 Shard 2: same as the contested path — a tamper-flagged record
        // still lands in accepted[], so consume its presence nonce too (ledger
        // invariant holds on every accept path).
        registerPresenceNonce(record, seenPresenceNonces);
        _advanceChainState(
          perEmitterState,
          perEmitterStats,
          record,
          forkCheck.this_hash,
        );
        continue;
      }
      // #583 Shard 3b (L7): stamp the proof-derived attribution (PROVEN →
      // roster host_role; NOT-PROVEN, incl. the EXPIRED actuation the latch
      // admits → "ci" audit-only) onto the accepted record. No-op for a
      // non-actuation record with no proof (Shard-1 untouched invariant).
      accepted.push(
        _stampPresenceAttribution(
          record,
          roster,
          rp.status,
          rp.coSignerStatuses,
        ),
      );
      // #583 Shard 2: an actuation record carrying a valid presence proof has
      // now cleared every gate → consume its single-use nonce (AC-L4). No-op
      // for records without a well-formed proof.
      registerPresenceNonce(record, seenPresenceNonces);
      _advanceChainState(
        perEmitterState,
        perEmitterStats,
        record,
        forkCheck.this_hash,
      );
    }

    // --- Rule 8 — partial-push gap advisory (post-pass) ---
    const r8 = _detectPartialPushGaps(perEmitterStats, peerHighWaterFor);
    for (const a of r8) advisories.push(a);

    // --- Derived-N (consumed by gate matrix) ---
    let derivedN = null;
    try {
      derivedN = computeDerivedN({
        roster,
        log: accepted,
        trustRoot: foldState.trustRoot,
      });
    } catch (err) {
      // derive-n is intentionally permissive; if it throws, surface via
      // advisory rather than failing the whole fold.
      advisories.push({
        type: "derived-n-error",
        reason: `computeDerivedN threw: ${err && err.message ? err.message : String(err)}`,
      });
    }

    return {
      foldState,
      accepted,
      rejected,
      forks,
      advisories,
      contestedRevocations,
      derivedN,
    };
  } finally {
    // F17 — always release the shared verify-homedir's gpg-agent + temp dir,
    // even if a predicate threw mid-loop (no agent/dir leak per fold).
    if (_sharedGpgHome) cocSign.destroyVerifyHomedir(_sharedGpgHome);
  }
}

function _advanceChainState(
  perEmitterState,
  perEmitterStats,
  record,
  contentHash,
) {
  perEmitterState[record.verified_id] = {
    lastSeq: record.seq,
    lastContentHash: contentHash,
  };
  const stats = perEmitterStats[record.verified_id] || { highestSeq: -1 };
  if (record.seq > stats.highestSeq) stats.highestSeq = record.seq;
  perEmitterStats[record.verified_id] = stats;
}

/**
 * computeOwnChainHead — public helper exposing _advanceChainState's
 * per-emitter chain-head semantics for hook consumers.
 *
 * Walks `folded.accepted` (or `folded.rawRecords` under skip-sign tests)
 * for records emitted by `ownVerifiedId`, picks the highest `seq`, and
 * returns `{lastSeq, lastContentHash}` — the chain-head pair the next
 * emit by this operator MUST extend (rule-2 per-emitter chain integrity).
 *
 * Returns null when:
 *   - folded or ownVerifiedId is missing/falsy
 *   - no records by ownVerifiedId are present
 *   - canonical-hash computation fails (defensive — should not happen on
 *     fold-accepted records, which were already canonical-hashed)
 *
 * Origin: M5 R8-LOW-2 follow-up — consolidates the ~35 LOC chain-head
 * computation previously duplicated at multi-operator-sessionend.js:231-265
 * into a single SSOT here, so fold rule-2 semantic changes propagate
 * automatically. The duplicated implementation drifted exactly the way
 * R8-LOW-2's analysis predicted: the sessionend copy used a hash strip
 * that the engine no longer needs. Single owner → one fix site.
 */
function computeOwnChainHead(folded, ownVerifiedId) {
  if (!folded || !ownVerifiedId) return null;
  const records =
    process.env.COC_TEST_SKIP_SIGN === "1"
      ? folded.rawRecords || folded.accepted
      : folded.accepted;
  if (!Array.isArray(records)) return null;
  let head = null;
  for (const r of records) {
    if (!r || r.verified_id !== ownVerifiedId) continue;
    if (typeof r.seq !== "number") continue;
    if (!head || r.seq > head.seq) head = r;
  }
  if (!head) return null;
  try {
    // Strip sig before canonical-hash (symmetric with _canonicalHash usage
    // at fold-time: rule-3 fork-check hashes content-without-sig).
    //
    // ALSO strip engine-annotation flags (FSUB R2 hardening, 2026-06-11):
    // the fold pushes FLAGGED COPIES into accepted[] for contested
    // revocations (`rule10_contested`, the rule-10 path) and tampered
    // body anchors (`body_anchor_tampered`, the FSUB R1 LOW-2 path).
    // Those flags exist ONLY on the in-memory accepted copies — never on
    // the disk record the signature covers — so hashing them here would
    // diverge this chain head from the fold's own perEmitterState (which
    // advances with the ORIGINAL record's hash), and the emitter's NEXT
    // record would be rule-2-rejected on every fold. Latent today (no
    // production caller folds with the flag-activating ctx before
    // computing a chain head) but structural: any future repoDir-folding
    // caller would trip it.
    //
    // #583 Shard 3b R2 (HIGH): `_presence_attribution` is the SAME class —
    // a fold-DERIVED top-level annotation `_stampPresenceAttribution` stamps
    // onto every accepted actuation (`gate-approval`) + proof-bearing record
    // (e.g. a `release` carrying a proof). Unlike the two flags above it is
    // NOT latent: it stamps on the PLAIN accept path with no special ctx, so
    // an operator whose highest-seq record is a stamped actuation/proof-bearing
    // record would get a chain head hashed over (original + _presence_attribution)
    // that DIVERGES from the fold-time `_canonicalHash(original)` (:1354),
    // rule-2-rejecting their next emit. Strip it here to restore hash parity.
    const {
      sig: _s,
      rule10_contested: _r10,
      body_anchor_tampered: _bat,
      _presence_attribution: _pa,
      ...core
    } = head;
    const contentHash = _canonicalHash(core);
    return { lastSeq: head.seq, lastContentHash: contentHash };
  } catch {
    return null;
  }
}

// ---- module-default engine + exports ----------------------------------------

const defaultEngine = createEngine({ inheritDefaults: true });

// #583 Shard 3a (F5 + Q5a) — structural invariant, asserted at module load
// against the DEFAULT (production) engine: every ACTUATION record type MUST be
// (a) fold-registered AND (b) checkpoint-exempt.
//   (b) closes the F5 checkpoint↔freshness replay window BY CONSTRUCTION: a
//       checkpoint-exempt actuation's presence nonces are NEVER archived, so
//       they never leave the live re-fold set → the single-use nonce ledger
//       fully closes replay and freshness is redundant for every gated type
//       (no checkpoint-min-age coupling needed — journal/0508 F5 option (b)).
//   (a) guarantees the type actually has a predicate — an unregistered actuation
//       would dispatch-reject at fold (Q5a: the allowlist is re-derived against
//       ACTUAL fold-registered types).
// Uses predicateMetadataFor (NOT isCheckpointExempt): the latter returns true
// for UNREGISTERED types by the rule-6 default, which would silently hole (a);
// predicateMetadataFor returns null for an unregistered type, catching it.
// Asserted at LOAD so a future author adding a non-exempt/unregistered actuation
// type to ACTUATION_RECORD_TYPES trips this immediately (mirrors the skew<freshness
// load-time assert in presence-proof-verify.js), never silently at fold time.
for (const t of ACTUATION_RECORD_TYPES) {
  const meta = defaultEngine.predicateMetadataFor(t);
  if (meta === null) {
    throw new Error(
      `coordination-log (#583 F5/Q5a): actuation record type '${t}' (actuation-types.js ACTUATION_RECORD_TYPES) has NO registered fold predicate in the default engine — an unregistered actuation dispatch-rejects at fold. Register it in _registerM0Defaults, or remove it from ACTUATION_RECORD_TYPES.`,
    );
  }
  if (meta.checkpoint_exempt !== true) {
    throw new Error(
      `coordination-log (#583 F5): actuation record type '${t}' MUST be checkpoint_exempt — a non-exempt actuation's presence nonce can be archived while still fresh and replay as PROVEN across a checkpoint. Mark '${t}' checkpoint_exempt in _registerM0Defaults, or scope the presence-proof allowlist to checkpoint-exempt types only.`,
    );
  }
}

module.exports = {
  // Constants
  LIVENESS_TTL_MS,

  // Module-default engine (M0 predicates pre-registered)
  foldLog: defaultEngine.foldLog,
  registerFoldPredicate: defaultEngine.registerFoldPredicate,
  predicateMetadataFor: defaultEngine.predicateMetadataFor,
  isCheckpointExempt: defaultEngine.isCheckpointExempt,

  // Sandboxed engine constructor (for tests + downstream parallel fold
  // contexts that should not share the default registry).
  createEngine,

  // Read-time predicates (rule 7)
  isSessionLive,
  isClaimActive,

  // Per-emitter chain-head helper (M5 R8-LOW-2 SSOT)
  computeOwnChainHead,

  // Exposed for testing + downstream tooling
  _internal: {
    _canonicalHash,
    _verifyRule1,
    _checkRule2,
    _checkRule3,
    _checkRule4,
    _checkRule5,
    _coSignedBytes,
    _coSignedStubPredicate,
    _detectPartialPushGaps,
    _resolveRosterPerson,
    _collectVictimChainEntries,
    _collectRosterGpgPubkeys,
    NON_EXEMPT_BY_DEFAULT,
    COSIGNED_TYPES,
  },
};
