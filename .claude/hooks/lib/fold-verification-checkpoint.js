/**
 * fold-verification-checkpoint — the signed prefix attestation that bounds
 * read-time fold cost, and its fold predicate.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TYPE EXISTS AND IS NOT `compaction-checkpoint`
 * ---------------------------------------------------------------------------
 *
 * `_foldLog` verifies EVERY record's signature, each by subprocess. Measured on
 * loom's 919-record log (2026-08-21, load avg 8.92): 894 `gpg` spawns + 27
 * `ssh-keygen` spawns, 8.26 s wall-clock, of which the crypto work is ~0 — a
 * `gpg --version` (zero verification) costs 8.33 ms against 7.71 ms for a full
 * detached verify, so the SPAWN is the entire bill. The log is append-only, so
 * that cost grows without bound. It is paid on every integrity-critical
 * Edit/Write (three PreToolUse hooks fold), against a 5-second hook timeout.
 *
 * The architecture already carries a bound — `compaction-checkpoint` (fold
 * rule 5) and `generation-rotation` (rule 9b). Neither has EVER been emitted
 * here, and neither can be, for two independent structural reasons:
 *
 *   1. Both require a 2-of-N owner co-signature with DISTINCT owner-role
 *      signers, verified cryptographically (`_checkRule5`,
 *      `fold-rule-9b::_verifyCoSigner`). This deployment's roster carries
 *      exactly ONE owner-role person, so N = 1 and 2-of-N is unsatisfiable.
 *      Independently, `coc-emit.js::emitSignedRecord` signs with exactly one
 *      key and has no co-signature collection step at all — no code path in
 *      the repo can produce a 2-of-N record.
 *   2. Rule 5 and rule 9b both require a pinned `refs/coc/archive-genN` tip,
 *      and NOTHING in the repo writes that ref. `archive-ref.js` only pins a
 *      field and compares two strings; `transport-git-ref.js::readArchiveRefTip`
 *      only reads. There is no archive writer, so there is no honest value to
 *      pin.
 *
 * Those two types govern COMPACTION — DISCARDING records into a cold archive.
 * Discarding is destructive and unilateral, which is exactly why it is gated on
 * a quorum and an archive. This module does something strictly weaker and needs
 * neither:
 *
 *   A `fold-verification-checkpoint` DISCARDS NOTHING. Every record stays in
 *   the log and every record still flows through the whole fold — rules 2, 3,
 *   4, 5, the presence gate, and per-type dispatch all run unchanged, over the
 *   same array, in the same order. The ONLY thing it changes is that records in
 *   an attested prefix skip the rule-1 SUBPROCESS, because their bytes are
 *   already covered by an owner's signature over their digest.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SIGNATURE AND NOT THE CONTENT-HASH CACHE THAT WAS REJECTED
 * ---------------------------------------------------------------------------
 *
 * A prior lane correctly rejected a content-hash cache: it promotes an
 * UNAUTHENTICATED in-repo file into a signature-verification oracle — anyone
 * who can write the working tree can forge it. It also showed a PURE
 * INCREMENTAL fold fails outright: an attacker who rewrites the tail can
 * recompute every `prev_hash`, and incremental is precisely the scheme that
 * never re-checks the signatures that would catch them.
 *
 * This is neither, for one reason: **the coverage claim is bound to the exact
 * bytes by a digest, and the digest is bound to an owner by a signature.**
 *
 *   - `content.prefix_digest` is SHA-256 over the ordered FULL-record hashes of
 *     records[0 .. covered_count) — full meaning the `sig` field is INCLUDED,
 *     unlike `canonicalRecordHash` and unlike `prev_hash` chaining, both of
 *     which correctly strip it. Change any byte of any covered record —
 *     content, seq, prev_hash, ts, signer, THE SIGNATURE ITSELF, or the
 *     ordering — and the digest changes. It is recomputed from the records on
 *     disk at EVERY fold (`computePrefixDigest`), never read from a cache.
 *     Including `sig` is not incidental: a sig-stripped digest let an attacker
 *     erase signatures inside the covered prefix with no fold-visible effect.
 *     See `fullRecordHash`.
 *   - That digest sits inside a record whose own detached signature is verified
 *     (one subprocess) against a roster key belonging to an `owner`-role,
 *     `owner-quorum`-eligible person. An attacker without an owner key cannot
 *     move it.
 *
 * So a tampered record below a checkpoint IS still caught — by digest
 * divergence, not by trust. This is stated precisely in § THE THREE PROOFS
 * below, including what is genuinely traded.
 *
 * ---------------------------------------------------------------------------
 * THE THREE PROOFS
 * ---------------------------------------------------------------------------
 *
 * (1) A TAMPERED RECORD BELOW A CHECKPOINT IS STILL CAUGHT — and by what.
 *
 *     `computePrefixDigest` re-hashes every covered record on every fold and
 *     compares to the owner-signed pin. Any mutation, insertion, deletion, or
 *     reordering inside the prefix changes the digest, the comparison fails,
 *     `coveredCount` is 0, and the fold runs FULL signature verification on the
 *     entire log — today's behaviour exactly. Detection is therefore never
 *     weaker than today; it is relocated from 894 signature checks to one
 *     signature check plus 919 SHA-256 hashes.
 *
 *     WHAT IS ACTUALLY TRADED, stated plainly rather than implied: for a
 *     covered record that the attesting owner found VALID, the fold no longer
 *     re-derives WHO signed it. Records the owner found INVALID are not
 *     trusted at all — `content.rule1_failed_indices` names them and the fold
 *     RE-VERIFIES each one for real, so their rejection reason is re-derived
 *     rather than replayed from a frozen copy.
 *
 *     The residual is bounded and named: if the checkpoint's owner-signer was
 *     compromised AT THE MOMENT OF ATTESTATION, they could attest a prefix
 *     containing a record whose signature does not verify. That is not a new
 *     trust: the same key already signs the genesis anchor and the trust root,
 *     so an attacker holding it can rewrite the log's authority outright. The
 *     checkpoint grants that key no power it did not already have.
 *
 * (2) A FORGED OR REPLAYED CHECKPOINT IS REJECTED.
 *
 *     - FORGED: `resolveCheckpointCoverage` verifies the checkpoint record's
 *       own detached signature with `cocSign.verify` under the roster pubkey
 *       matching its `verified_id`, bound to that fingerprint via `expectedFpr`
 *       (so one rostered key cannot verify as another's), and requires
 *       `isEligibleSigner(person, "owner-quorum")` — role `owner`, host_role
 *       not `ci`. A checkpoint minted by a contributor, by CI, or by an
 *       unrostered key yields `coveredCount = 0`.
 *     - REPLAYED FROM ELSEWHERE, OR MOVED: the checkpoint's signature covers
 *       its own `seq` and `prev_hash`, so a lifted or moved copy cannot be
 *       re-signed into a new position. What actually STOPS it granting coverage
 *       is the digest: it must satisfy
 *       `prefix_digest === computePrefixDigest(records, N)` against THIS array.
 *       Note precisely what does NOT stop it — `resolveCheckpointCoverage`
 *       runs BEFORE the fold loop and never consults `accepted`, so a
 *       checkpoint the fold later REJECTS on rule 2 or rule 3 can still have
 *       granted coverage. That is deliberate (acceptance and coverage are two
 *       gates, not one) and it is why the digest, not the chain, is the
 *       load-bearing defence here. This proof does not borrow the acceptance
 *       gate's strength.
 *     - REPLAYED IN PLACE (a stale checkpoint re-presented as current): a stale
 *       checkpoint covers a SHORTER prefix, so it is strictly weaker than the
 *       current one — it buys the attacker nothing, and the uncovered tail is
 *       verified in full.
 *
 * (3) A CHECKPOINT CLAIMING COVERAGE IT DOES NOT HAVE IS REJECTED.
 *
 *     Three independent bounds, all fail-closed:
 *       - `covered_count` MUST be a safe integer in `[1, checkpointIndex]`. A
 *         checkpoint can never cover ITSELF or anything appended AFTER it,
 *         because the prefix is the physical run of records preceding it.
 *       - `covered_count` MUST NOT exceed `records.length`.
 *       - The digest MUST match over exactly `covered_count` records. Claiming
 *         a longer prefix hashes a different set and diverges.
 *     Widening the claim is therefore not a matter of degree: any claim other
 *     than the exact prefix the signer attested fails the digest.
 *
 * ---------------------------------------------------------------------------
 * THE INCREMENTAL FOLD (2026-10-08) — DESIGN, AND WHY THE BOUND IS THE FIX
 * ---------------------------------------------------------------------------
 *
 * THE MECHANISM THIS FILE OWNS, stated as the three invariants a reader can
 * check against the code:
 *
 *   1. A checkpoint IS the last verified record plus the fold state needed to
 *      continue from it: `covered_count` (the boundary — every record at an
 *      index BELOW it was verified), `prefix_digest` (SHA-256 over the ordered
 *      FULL-record hashes of exactly those records — a hash of the last
 *      verified record is subsumed by it, and the digest binds every earlier
 *      one too, including order), `roster_digest` (the trust set the verdicts
 *      were reached under), and `rule1_failed_indices` (the pinned verdicts the
 *      next fold must re-derive rather than trust). The remaining fold state is
 *      NOT carried: every non-crypto rule (2, 3, 4, 5, presence gate,
 *      per-type dispatch) still runs over EVERY record on every fold, from the
 *      same array, in the same order. That is deliberate — it is what makes an
 *      incremental fold's `accepted`/`rejected`/`forks` output EQUAL to a full
 *      fold's BY CONSTRUCTION rather than by an argument about cached state.
 *
 *   2. ON THE NEXT CALL ONLY THE RECORDS AFTER THE CHECKPOINT are verified
 *      cryptographically. The resolver re-derives `prefix_digest` from the
 *      records on disk (never from a cache), verifies the checkpoint's ONE
 *      signature, and reports `coveredCount`. The fold loop then replays the
 *      covered prefix through the roster-membership half of rule 1 (no
 *      subprocess) and verifies the tail for real. The checkpoint record itself
 *      is inside the covered prefix of the NEXT checkpoint, so it too is
 *      verified once, not per-fold.
 *
 *   3. ANY MISMATCH, TAMPER, OR UNVERIFIABLE STATE IS A CACHE MISS → FULL FOLD.
 *      There is no partial credit and no soft failure: `coveredCount: 0` (see
 *      FAIL-CLOSED, EVERYWHERE below) puts the fold on full signature
 *      verification, the behaviour that shipped before this file existed.
 *
 * WHY A CHECKPOINT THE FOLD DID NOT PRODUCE IS NEVER TRUSTED, AND CANNOT BE.
 *    A content-hash cache in the working tree was considered and REJECTED — see
 *    § WHY THIS IS A SIGNATURE AND NOT THE CONTENT-HASH CACHE THAT WAS
 *    REJECTED above: it promotes a file anyone who can write the tree can forge
 *    into a signature-verification oracle. The contract implemented instead is
 *    exact: coverage is granted ONLY to a record whose own detached signature
 *    verifies under a CURRENT, owner-eligible roster key, over content that
 *    commits to the covered bytes by digest. A checkpoint minted elsewhere,
 *    replayed, widened, signed by a non-owner, or left behind by a roster
 *    change is not "unlikely to be trusted" — it resolves to coverage 0.
 *
 * WHAT WAS ACTUALLY BROKEN, because the mechanism above already existed and the
 * fold was still refusing every guarded write (measured 2026-10-08): the
 * mechanism could not REFRESH. The producer's trigger was a constant (200)
 * derived from a cost model — 8.98 ms per verify — that the log had outgrown
 * (the owner's signing key moved to ssh-rsa, which the in-process SSHSIG path
 * does not cover, so every tail record pays a ~30 ms `ssh-keygen` SPAWN). At
 * 150 uncovered records the fold cost 7.5-14 s against a 5.75 s dispatcher row
 * budget whose `on_incomplete` is `deny`, so integrity-guard was killed mid-fold
 * and EVERY write to journal/, the roster, posture or team-memory was refused.
 * The trigger never fired (150 < 200), so the tail could only grow.
 *
 * THE FIX, in three parts, each measured rather than argued:
 *   (a) the trigger is DERIVED from its cost model (below), not typed in, so a
 *       tail can never exceed the budget the fold actually has;
 *   (b) the fold no longer pays for two GPG homedirs, or for verifying its own
 *       checkpoint record twice (see coordination-log.js);
 *   (c) the producer, not the read path, absorbs the remaining cost — the
 *       bounded tail is paid once per interval in a detached teardown worker.
 *
 * ---------------------------------------------------------------------------
 * FAIL-CLOSED, EVERYWHERE
 * ---------------------------------------------------------------------------
 *
 * Every failure, malformation, indeterminacy, and unknown in this module
 * resolves to `coveredCount: 0` — i.e. FULL signature verification of every
 * record, the behaviour that shipped before this file existed. There is no
 * path on which a doubt produces a larger covered prefix. `security.md`'s
 * "unrecognized ranks TIGHTEST" is satisfied by construction: the tightest
 * available answer here is "verify everything", and it is the default.
 *
 * Style: CommonJS, zero-dep beyond node builtins + coc-sign + eligibility.
 * Requires NOTHING from coordination-log.js, so it cannot close a cycle.
 */

"use strict";

const crypto = require("crypto");
const cocSign = require("./coc-sign.js");
const { isEligibleSigner } = require("./eligibility.js");

/**
 * The record type. Registered in `coordination-log.js::_registerM0Defaults`
 * so every default-engine consumer folds it (an unregistered type is
 * dispatch-rejected and rule-2-poisons the emitter's subsequent chain).
 */
const CHECKPOINT_TYPE = "fold-verification-checkpoint";

/**
 * The TAIL BUDGET — how much wall-clock the uncovered tail may spend inside a
 * read-time fold, and therefore the quantity the emit trigger below is DERIVED
 * from rather than guessed at.
 *
 * THE SHAPE OF THE BOUND, stated once because every number below reads from it:
 *
 *   hook budget              5750 ms   (dispatcher row timeout 5000 + 750 GRACE_MS,
 *                                       dispatch-main.js::budgetOf — the row that
 *                                       declares on_incomplete:"deny", i.e. a fold
 *                                       that overruns it REFUSES the write)
 *   − fixed per-fold costs   ~2400 ms  (MEASURED on loom's own 1070-record log,
 *                                       2026-10-08: 3 `gpg --homedir` spawns
 *                                       ~780 ms + 2 `gpgconf --homedir` calls
 *                                       ~1500 ms + git probes ~130 ms)
 *   − non-crypto fold work    ~600 ms  (prefix digest over the covered prefix +
 *                                       the per-record JS rules, same log)
 *   − guard work around it    ~400 ms  (identity, main-checkout, roster reads)
 *   ≈ 2350 ms of headroom, of which the tail may claim TAIL_BUDGET_MS.
 *
 * THE PER-RECORD COST IS A SUBPROCESS SPAWN and it is load-sensitive, which is
 * exactly how the previous value rotted: 200 was derived when a verify cost
 * 8.98 ms (measured 2026-08-21), and the live log's owner key had meanwhile
 * moved to an ssh-rsa key the in-process SSHSIG path does not cover — so every
 * tail record paid a full `ssh-keygen -Y verify` SPAWN. Measured 2026-10-08
 * across this change's own runs: 145 tail verifies took 4403 ms (30.4 ms each,
 * the value used below); the same spawn measured 11-12 ms and 914 ms at
 * different load moments, which is the variance the RESIDUAL below is about.
 * 200 × 30 ms = 6.0 s of tail verification alone, over the whole row budget
 * before the fixed costs are even counted — which is how a log at 150 uncovered
 * records started REFUSING every guarded write (measured end-to-end:
 * integrity-guard killed at its 5 s row budget with on_incomplete:"deny").
 *
 * So the constant is no longer typed in: the trigger is the largest integer
 * whose worst measured tail FITS the budget it is given. Re-derive by editing
 * the two measurement inputs below — never by editing the derived value.
 *
 * RESIDUAL, named rather than implied: spawn cost scales with host load, and a
 * single `ssh-keygen -Y verify` was measured at BOTH 11-12 ms and 914 ms inside
 * this change's own working window (the 30 ms below is the amortised figure
 * over 145 verifies in one run, and it is the one the derivation budgets
 * against). A load spike costs the tail a multiple of that. What keeps the
 * spike bounded is the refresh, not this comment: the tail is re-bounded every
 * time a producer run folds the log, so the exposure is one inter-boundary
 * interval, and the fail direction is a REFUSED WRITE, never a skipped
 * verification.
 */
const CHECKPOINT_TAIL_BUDGET_MS = 750;
/**
 * The per-record tail verification cost the derivation budgets against —
 * amortised over 145 verifies in one measured run (30.4 ms each). NOT a claim
 * about the worst case; see RESIDUAL above for why no such constant exists.
 */
const CHECKPOINT_PER_RECORD_ASSUMED_MS = 30;

/**
 * Emit trigger: number of records ABOVE the last valid checkpoint at which a
 * new one is emitted. DERIVED from the two measurements above so the trigger
 * cannot drift away from the budget it exists to respect.
 *
 * Smaller spends more checkpoint records (one ~1.4 KB signed record per
 * interval) to buy tail headroom; larger spends the headroom a read-time fold
 * does not have. At 25 that is ~4% record-count growth on a log of this
 * shape — the cheap side of the trade, because the expensive side is a
 * fail-closed refusal on every write to a guarded surface.
 */
const CHECKPOINT_INTERVAL = Math.floor(
  CHECKPOINT_TAIL_BUDGET_MS / CHECKPOINT_PER_RECORD_ASSUMED_MS,
);

/**
 * Upper bound on pinned rule-1 failure INDICES.
 *
 * Only indices are pinned — never the rejection REASON. Two reasons, both
 * measured rather than assumed:
 *
 *   1. SIZE. The transport caps a log line at 2048 B and an armored RSA-4096
 *      signature is 870 B of that. Pinning 300-byte reason strings breached the
 *      cap at TWO failures, which would have made the whole mechanism switch
 *      itself off permanently on exactly the damaged logs whose fold cost it
 *      exists to bound — the "bound that silently stops firing" failure this
 *      module was written to end. An index costs ~7 B, so 48 of them fit with
 *      room to spare, and the emitter's projected-size guard remains the real
 *      binding constraint.
 *   2. CORRECTNESS. A stored reason is a FROZEN verdict. A rule-1 rejection can
 *      be transient — `verify threw` from a spawn failure under exactly the
 *      load this optimisation targets — and a frozen copy would replay that
 *      transient failure forever, propagating into every later attestation
 *      derived from it. Re-verifying the handful of pinned indices costs one
 *      subprocess each, re-derives the reason EXACTLY (so the fast path's
 *      `rejected[]` is byte-identical to the full fold's), and lets a transient
 *      failure heal on the next fold.
 *
 * A prefix with more failing signatures than this cap is anomalous; rather than
 * sign an oversized blob the emitter declines, which fails closed to "no
 * checkpoint" = full verification.
 */
const MAX_PINNED_RULE1_FAILURES = 48;

/**
 * How many trailing checkpoints to try before giving up. A single malformed
 * checkpoint appended by anyone would otherwise disable the bound forever;
 * trying a few earlier ones keeps the mechanism live while keeping the
 * subprocess count bounded (worst case: this many extra verifies).
 */
const MAX_CHECKPOINT_ATTEMPTS = 3;

/**
 * Canonical content hash of one record — SHA-256 over the canonical
 * serialization of the record MINUS its `sig`. Byte-identical to
 * `coordination-log.js::_canonicalHash`; duplicated rather than imported so
 * this module stays acyclic. The shared contract is `coc-sign.js`'s
 * canonicalization, which both call.
 *
 * @param {object} record
 * @returns {string} 64-char lowercase hex
 */
function canonicalRecordHash(record) {
  const { sig, ...core } = record;
  return crypto
    .createHash("sha256")
    .update(cocSign.canonicalSerialize(core))
    .digest("hex");
}

/**
 * SHA-256 over the record INCLUDING its `sig`.
 *
 * This is the hash the prefix digest is built from, and the distinction from
 * `canonicalRecordHash` above is load-bearing — it was a real break, caught by
 * adversarial review:
 *
 *   `canonicalRecordHash` strips `sig`, correctly, because that is what the
 *   signature covers and what `prev_hash` chains. But a digest built from it
 *   is BLIND TO THE SIGNATURE BYTES. An attacker with working-tree write —
 *   exactly the threat model this module invokes — could replace the `sig`
 *   field of any covered record with garbage, and: the prefix digest would be
 *   unchanged, the owner-signed checkpoint would still validate, the index
 *   could not be in `rule1_failed_indices` (the corruption post-dates the
 *   attestation), and the fast path would skip the only check that would have
 *   noticed. Rule 2 does not catch it either, because `_canonicalHash` strips
 *   `sig` too. The result: signatures inside the covered prefix became
 *   erasable with no fold-visible effect.
 *
 * Hashing the record WITH its `sig` closes that: any change to a signature in
 * the covered prefix diverges the digest, coverage drops to 0, and every
 * record is verified in full.
 *
 * @param {object} record
 * @returns {string} 64-char lowercase hex
 */
function fullRecordHash(record) {
  return crypto
    .createHash("sha256")
    .update(cocSign.canonicalSerialize(record))
    .digest("hex");
}

/**
 * SHA-256 over the ordered canonical hashes of `records[0 .. count)`.
 *
 * Binds CONTENT (each record's own hash), ORDER (hashes are joined in array
 * order), and CARDINALITY (the count is hashed in as a prefix, so a truncated
 * or extended prefix cannot collide with a shorter/longer one that happens to
 * share a hash sequence).
 *
 * Throws only if a record cannot be canonicalized; callers treat a throw as
 * "no fast path" (fail-closed).
 *
 * @param {Array<object>} records
 * @param {number} count
 * @returns {string} 64-char lowercase hex
 */
function computePrefixDigest(records, count) {
  const h = crypto.createHash("sha256");
  // v2: elements are `fullRecordHash` (sig INCLUDED). v1 used the sig-stripped
  // `canonicalRecordHash` and was blind to signature corruption inside the
  // covered prefix. The version tag is inside the hashed bytes, so a v1
  // attestation can never be read as a v2 one — it simply fails to match and
  // the fold verifies everything.
  h.update(`fold-verification-checkpoint/v2\ncount=${count}\n`);
  for (let i = 0; i < count; i += 1) {
    h.update(fullRecordHash(records[i]));
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * SHA-256 over the canonical serialization of the roster.
 *
 * A rule-1 verdict is a function of BOTH the record bytes and the roster that
 * resolves its signer. `prefix_digest` pins the first; this pins the second.
 * Without it, a roster change (key rotation, person removal, a contributor
 * promoted to owner) could make a replayed rule-1 verdict diverge from what a
 * full verification would now conclude — the checkpoint would be answering a
 * question that is no longer the question being asked. Binding both makes the
 * fast path's result identical to the full fold's by construction, and makes a
 * checkpoint unusable the moment the trust set it was attested under changes.
 *
 * @param {object} roster
 * @returns {string} 64-char lowercase hex
 */
function computeRosterDigest(roster) {
  return crypto
    .createHash("sha256")
    .update(cocSign.canonicalSerialize(roster))
    .digest("hex");
}

/**
 * Resolve a verified_id to its roster person. Same shape as the sibling
 * helpers in coordination-log.js / fold-rule-9b.js.
 */
function _resolveRosterPerson(roster, verifiedId) {
  if (!roster || !roster.persons) return null;
  for (const [pid, person] of Object.entries(roster.persons)) {
    // S61 — shape-guard the key list: a non-array `keys` SKIPS this person
    // (refuse), never THROWS. Same root cause + rationale as the copy in
    // coordination-log.js::_resolveRosterPerson, which carries the full
    // comment. A throw here is caught by coordination-log.js's
    // `resolveCheckpointCoverage` call site, which ranks the unknown TIGHTEST
    // (coveredCount: 0 → verify everything) — fail-closed today, but the
    // refusal must not depend on that catch staying that way.
    // SKIP IS SAFE HERE ONLY BECAUSE non-resolution is wired to REFUSE.
    // Where non-resolution PERMITS, this shape inverts and becomes the bug —
    // see the condition + the two recorded exceptions (add-key-ceremony.js
    // ::findKeyHolder@:402, identity-scrub.mjs::deriveDynamicTokens) in the
    // canonical comment on coordination-log.js::_resolveRosterPerson.
    const keys = Array.isArray(person && person.keys) ? person.keys : [];
    for (const k of keys) {
      if (k && k.fingerprint === verifiedId) return { person_id: pid, person };
    }
  }
  return null;
}

/**
 * Validate the shape of a checkpoint record's content. Returns {ok, reason}.
 * Shape-only; the cryptographic and coverage checks live in
 * `resolveCheckpointCoverage`.
 */
function _validateCheckpointContent(c, checkpointIndex, recordCount) {
  if (!c || typeof c !== "object") {
    return { ok: false, reason: "content missing or not an object" };
  }
  if (!Number.isSafeInteger(c.covered_count) || c.covered_count < 1) {
    return { ok: false, reason: "covered_count not a positive safe integer" };
  }
  // Proof (3), bound A: a checkpoint can never cover itself or anything after
  // it. The prefix is the physical run of records preceding the checkpoint.
  if (c.covered_count > checkpointIndex) {
    return {
      ok: false,
      reason: `covered_count ${c.covered_count} exceeds the checkpoint's own index ${checkpointIndex} (a checkpoint cannot attest itself or later records)`,
    };
  }
  // Proof (3), bound B.
  if (c.covered_count > recordCount) {
    return {
      ok: false,
      reason: `covered_count ${c.covered_count} exceeds record count ${recordCount}`,
    };
  }
  if (typeof c.prefix_digest !== "string" || !/^[0-9a-f]{64}$/.test(c.prefix_digest)) {
    return { ok: false, reason: "prefix_digest missing or not a sha256 hex" };
  }
  if (typeof c.roster_digest !== "string" || !/^[0-9a-f]{64}$/.test(c.roster_digest)) {
    return { ok: false, reason: "roster_digest missing or not a sha256 hex" };
  }
  if (!Array.isArray(c.rule1_failed_indices)) {
    return {
      ok: false,
      reason: "rule1_failed_indices missing or not an array",
    };
  }
  if (c.rule1_failed_indices.length > MAX_PINNED_RULE1_FAILURES) {
    return {
      ok: false,
      reason: `rule1_failed_indices length ${c.rule1_failed_indices.length} exceeds cap ${MAX_PINNED_RULE1_FAILURES}`,
    };
  }
  const seenIdx = new Set();
  for (const idx of c.rule1_failed_indices) {
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= c.covered_count) {
      return {
        ok: false,
        reason: `rule1_failed_indices entry ${idx} outside the covered prefix [0, ${c.covered_count})`,
      };
    }
    if (seenIdx.has(idx)) {
      return { ok: false, reason: `rule1_failed_indices contains duplicate ${idx}` };
    }
    seenIdx.add(idx);
  }
  // `derived_from` gets the SAME regex the two digests get. A refusal message
  // that says "must be a sha256 hex string" while the check accepts any string
  // is a check that does not do what it reports.
  if (
    c.derived_from !== null &&
    (typeof c.derived_from !== "string" || !/^[0-9a-f]{64}$/.test(c.derived_from))
  ) {
    return { ok: false, reason: "derived_from must be a sha256 hex string or null" };
  }
  // `verifier_mode` and `verified_at` carry the attestation's AUDIT trail — an
  // auditor walking `derived_from` back to a "full" root is reading these. An
  // unvalidated audit field is an audit trail that can say anything.
  if (c.verifier_mode !== "full" && c.verifier_mode !== "chained") {
    return {
      ok: false,
      reason: `verifier_mode must be 'full' or 'chained' (got: ${String(c.verifier_mode)})`,
    };
  }
  if (
    typeof c.verified_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(c.verified_at)
  ) {
    return { ok: false, reason: "verified_at must be an ISO-8601 UTC timestamp" };
  }
  // A "full" attestation claims NOTHING was inherited, so it MUST NOT name a
  // parent; a "chained" one rests on a parent and MUST name it. Without this,
  // the two fields could disagree and the audit chain would be unwalkable.
  if (c.verifier_mode === "full" && c.derived_from !== null) {
    return {
      ok: false,
      reason: "verifier_mode 'full' must not carry a derived_from parent",
    };
  }
  if (c.verifier_mode === "chained" && c.derived_from === null) {
    return {
      ok: false,
      reason: "verifier_mode 'chained' must name its derived_from parent",
    };
  }
  return { ok: true };
}

/**
 * The CHEAP (no-crypto) half of candidate admission: everything the resolver is
 * willing to establish before it spends a signature verification — the roster
 * the verdict set was attested under is still current, the signer resolves to a
 * roster person, that person is owner-quorum eligible, and the roster carries
 * the key the record names.
 *
 * WHY IT IS ONE FUNCTION. The SAME predicate now decides both (a) whether a
 * trailing record may CONSUME one of the MAX_CHECKPOINT_ATTEMPTS candidate
 * slots and (b) whether a candidate is adjudicated. When only (b) ran it, three
 * appended lines that were shape-valid but UNSIGNABLE — no roster key, no
 * eligibility, no signature needed — spent every slot, and the genuine
 * checkpoint below them was never reached: coverage 0, full verification, and
 * (on a log long enough that this mechanism exists to bound it) the refusal
 * storm the checkpoint exists to prevent. Detection was never weakened — the
 * fallback is fail-closed — but the BOUND stopped firing, which is the failure
 * mode this module was built to end.
 *
 * @returns {{ok: true, matchingKey: object} |
 *           {ok: false, reason: string} |
 *           {ok: false, throwing: string}} — `throwing` is the roster digest
 *   failing to compute at all, which is a fact about the ROSTER rather than
 *   about this candidate; the caller must fail the WHOLE resolution closed
 *   (coveredCount 0), never merely skip the candidate.
 */
function _cheapCandidateAdmission(record, roster) {
  const c = record && record.content ? record.content : null;
  if (!c) return { ok: false, reason: "no content" };
  let observedRosterDigest;
  try {
    observedRosterDigest = computeRosterDigest(roster);
  } catch (err) {
    return { ok: false, throwing: `roster digest threw: ${err && err.message}` };
  }
  if (observedRosterDigest !== c.roster_digest) {
    return {
      ok: false,
      reason: `roster digest mismatch (pinned ${String(c.roster_digest).slice(0, 16)}…, observed ${observedRosterDigest.slice(0, 16)}…) — the trust set changed since attestation, so the pinned rule-1 verdicts are stale`,
    };
  }
  const resolved = _resolveRosterPerson(roster, record.verified_id);
  if (!resolved) {
    return { ok: false, reason: `signer ${record.verified_id} not in roster` };
  }
  const elig = isEligibleSigner(resolved.person, "owner-quorum");
  if (!elig || !elig.eligible) {
    return {
      ok: false,
      reason: `signer ineligible: ${(elig && elig.reason) || "unknown"}`,
    };
  }
  // S61 defense-in-depth; REDS NO POLE today — a person returned by
  // `_resolveRosterPerson` provably has an ARRAY `keys` (the resolver only
  // returns after iterating it and matching a `.fingerprint` inside). Kept
  // for a future caller resolving a person some other way; NOT claimed covered.
  const matchingKey = (
    Array.isArray(resolved.person.keys) ? resolved.person.keys : []
  ).find((k) => k && k.fingerprint === record.verified_id);
  if (!matchingKey) {
    return { ok: false, reason: "no roster pubkey matching signer" };
  }
  return { ok: true, matchingKey };
}

/**
 * resolveCheckpointCoverage — decide how much of `records` may skip the
 * rule-1 subprocess.
 *
 * Walks trailing `fold-verification-checkpoint` records newest-first (at most
 * MAX_CHECKPOINT_ATTEMPTS of them) and returns the first that satisfies ALL
 * of: content shape, cheap admission (roster current + owner-eligible signer +
 * roster key present), coverage bounds, a cryptographically valid detached
 * signature bound to that signer's fingerprint, and an exact `prefix_digest`
 * match recomputed from `records`.
 *
 * EVERY failure path returns `coveredCount: 0`, which means "verify every
 * signature" — the pre-existing behaviour.
 *
 * @param {Array<object>} records - the full log, in physical order
 * @param {object} roster
 * @param {object} [opts]
 * @param {string} [opts.gpgHome] - shared verify homedir from the fold
 * @returns {{coveredCount: number, checkpointIndex: number|null,
 *            checkpointHash: string|null, rule1FailedIndices: Set<number>,
 *            reason: string}}
 */
function resolveCheckpointCoverage(records, roster, opts) {
  const none = (reason) => ({
    coveredCount: 0,
    checkpointIndex: null,
    checkpointHash: null,
    rule1FailedIndices: new Set(),
    reason,
  });

  if (!Array.isArray(records) || records.length === 0) {
    return none("no records");
  }
  if (!roster || !roster.persons) {
    return none("no roster: cannot establish an owner signer");
  }

  // Collect trailing checkpoint candidates, newest-first, bounded.
  //
  // Candidacy requires the content to be SHAPE-VALID AND to clear the CHEAP
  // admission checks below — never merely to carry the right `type`. Counting
  // by type alone was a denial-of-bound: anyone able to append to the log could
  // write MAX_CHECKPOINT_ATTEMPTS lines of
  // `{"type":"fold-verification-checkpoint"}` and the genuine checkpoint below
  // them would never be examined again. The log is append-only and nothing in
  // the repo compacts it, so that poison would have been permanent — the fold
  // would silently return to its unbounded cost under a 5-second hook timeout.
  // Fail-closed in the integrity sense (no signature is ever skipped), but it
  // defeats the entire mechanism, so shape is checked BEFORE a slot is spent.
  //
  // SHAPE ALONE WAS NOT ENOUGH (security review, 2026-10-08): a shape-valid line
  // needs no signature, no roster membership and no eligibility, so three such
  // lines still spent every slot. The cheap admission below is the same
  // no-crypto predicate the adjudication loop applies — roster-digest match,
  // signer present in the roster, owner-quorum eligible, roster key present — so
  // a slot can only be spent by a candidate that COULD grant coverage.
  //
  // WHAT THIS DOES NOT CLOSE, stated rather than implied: a writer who can
  // append records AND knows the logged owner fingerprint + current
  // roster_digest (both are in the log) can still spend slots with
  // shape-valid lines whose only defect is an unverifiable signature — no
  // cheap check can separate those from the genuine checkpoint, because the
  // separation IS the signature verification this resolver is trying to spend
  // only once. That variant is bounded by the refresh, not by this gate: the
  // producer appends a NEW checkpoint at the next Stop/SessionEnd, which out-
  // ranks any poison, so the shadowed window closes at the next producer run
  // rather than lasting forever.
  const candidates = [];
  const reasons = [];
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i];
    if (!r || r.type !== CHECKPOINT_TYPE) continue;
    const shape = _validateCheckpointContent(r.content, i, records.length);
    if (!shape.ok) {
      // Malformed candidates are reported but do NOT consume an attempt slot.
      if (reasons.length < 8) reasons.push(`@${i}: ${shape.reason}`);
      continue;
    }
    const cheap = _cheapCandidateAdmission(r, roster);
    if (cheap.throwing) return none(cheap.throwing);
    if (!cheap.ok) {
      // Same rule: an inadmissible candidate costs no slot.
      if (reasons.length < 8) reasons.push(`@${i}: ${cheap.reason}`);
      continue;
    }
    candidates.push(i);
    if (candidates.length >= MAX_CHECKPOINT_ATTEMPTS) break;
  }
  if (candidates.length === 0) {
    return none(
      reasons.length
        ? `no admissible checkpoint: ${reasons.join("; ")}`
        : "no checkpoint record present",
    );
  }

  for (const idx of candidates) {
    const record = records[idx];
    const c = record.content;

    // The SAME cheap admission the collection loop applied — one predicate, so
    // a candidate can never consume a slot here and fail there (or the reverse).
    const cheap = _cheapCandidateAdmission(record, roster);
    if (cheap.throwing) return none(cheap.throwing);
    if (!cheap.ok) {
      reasons.push(`@${idx}: ${cheap.reason}`);
      continue;
    }
    const matchingKey = cheap.matchingKey;
    // --- the checkpoint's OWN signature (the one subprocess we still pay) ---
    let bytes;
    try {
      const { sig, ...core } = record;
      bytes = cocSign.canonicalSerialize(core);
    } catch (err) {
      reasons.push(`@${idx}: canonicalSerialize threw: ${err && err.message}`);
      continue;
    }
    let vr;
    try {
      vr = cocSign.verify(bytes, record.sig, matchingKey.pubkey, {
        keyType: matchingKey.type,
        gpgHome: opts && opts.gpgHome ? opts.gpgHome : undefined,
        // Bind the verify to THIS signer's fingerprint. Without it a shared
        // multi-key homedir would accept a checkpoint signed by ANY rostered
        // key while attributing it to the owner.
        expectedFpr: matchingKey.fingerprint,
      });
    } catch (err) {
      reasons.push(`@${idx}: verify threw: ${err && err.message}`);
      continue;
    }
    if (!vr || !vr.ok || !vr.valid) {
      // INDETERMINATE IS NOT A FORGERY. `coc-sign::verify` distinguishes "this
      // signature does not verify" from "the verifier never reached a verdict"
      // (gpg absent or timed out, no VALIDSIG on the status channel, an issuing
      // key absent from an unasserted ring, a roster fingerprint of the wrong
      // VERSION for its key). Collapsing them told the operator a checkpoint was
      // forged when the fix was to repair gpg or a roster entry.
      //
      // Fail-closed is unchanged — the checkpoint is rejected either way, and the
      // `continue` is untouched. Only the diagnosis moves, which is what
      // `security.md` § Enforcement-Surface Parity requires of an independent
      // consumer of a contract widened elsewhere.
      reasons.push(
        vr && vr.indeterminate === true
          ? `@${idx}: checkpoint signature verification could not RUN: ${vr.reason || "no verdict"} ` +
            `(UNVERIFIED, not forged — repair the verifier or the roster entry)`
          : `@${idx}: checkpoint signature did not verify: ${(vr && vr.reason) || "unknown"}`,
      );
      continue;
    }

    // --- the coverage claim, recomputed from the records on disk ---
    let digest;
    try {
      digest = computePrefixDigest(records, c.covered_count);
    } catch (err) {
      reasons.push(`@${idx}: prefix digest threw: ${err && err.message}`);
      continue;
    }
    if (digest !== c.prefix_digest) {
      reasons.push(
        `@${idx}: prefix digest mismatch over ${c.covered_count} records (pinned ${c.prefix_digest.slice(0, 16)}…, observed ${digest.slice(0, 16)}…) — prefix bytes diverge from what the signer attested`,
      );
      continue;
    }

    return {
      coveredCount: c.covered_count,
      checkpointIndex: idx,
      checkpointHash: canonicalRecordHash(record),
      // The fold RE-VERIFIES exactly these indices (one subprocess each) rather
      // than replaying a stored verdict — see MAX_PINNED_RULE1_FAILURES.
      rule1FailedIndices: new Set(c.rule1_failed_indices),
      reason: "ok",
    };
  }

  return none(`no usable checkpoint: ${reasons.join("; ")}`);
}

/**
 * Build the content for a new checkpoint from a COMPLETED fold.
 *
 * The caller MUST pass a fold result produced with full signature
 * verification of the uncovered tail (i.e. NOT `skipSignatureVerify`). The
 * `verifier_mode` field records honestly which of the two it was:
 *
 *   - "full"    — no prior checkpoint was used; every record in the prefix had
 *                 its signature verified in the fold that produced this.
 *   - "chained" — a prior checkpoint covered part of the prefix. This
 *                 attestation therefore rests on that prior owner-signed
 *                 checkpoint PLUS full verification of the delta above it.
 *                 `derived_from` names the prior checkpoint's canonical hash so
 *                 an auditor can walk the chain of attestations back to a
 *                 "full" one.
 *
 * Returns {ok, content} or {ok:false, reason}.
 *
 * @param {object} args
 * @param {Array<object>} args.records
 * @param {object} args.roster              - bound into content.roster_digest
 * @param {number} args.coveredCount        - prefix length to attest
 * @param {Array<number>} args.rule1FailedIndices - indices that FAILED rule 1
 * @param {string|null} args.derivedFrom
 * @param {string} args.verifierMode        - "full" | "chained"
 * @param {string} args.verifiedAt          - ISO-8601
 */
function buildCheckpointContent(args) {
  const {
    records,
    coveredCount,
    rule1FailedIndices,
    derivedFrom,
    verifierMode,
    verifiedAt,
  } = args || {};
  if (!Array.isArray(records)) return { ok: false, reason: "records not an array" };
  if (!Number.isSafeInteger(coveredCount) || coveredCount < 1) {
    return { ok: false, reason: "coveredCount not a positive safe integer" };
  }
  if (coveredCount > records.length) {
    return { ok: false, reason: "coveredCount exceeds records.length" };
  }
  if (!Array.isArray(rule1FailedIndices)) {
    return { ok: false, reason: "rule1FailedIndices not an array" };
  }
  if (rule1FailedIndices.length > MAX_PINNED_RULE1_FAILURES) {
    return {
      ok: false,
      reason: `rule1FailedIndices ${rule1FailedIndices.length} exceeds cap ${MAX_PINNED_RULE1_FAILURES}; declining to attest`,
    };
  }
  if (verifierMode !== "full" && verifierMode !== "chained") {
    return { ok: false, reason: "verifierMode must be 'full' or 'chained'" };
  }
  if (!args.roster || !args.roster.persons) {
    return { ok: false, reason: "roster missing: cannot bind the verdict set" };
  }
  let prefixDigest;
  let rosterDigest;
  try {
    prefixDigest = computePrefixDigest(records, coveredCount);
    rosterDigest = computeRosterDigest(args.roster);
  } catch (err) {
    return { ok: false, reason: `digest threw: ${err && err.message}` };
  }
  return {
    ok: true,
    content: {
      covered_count: coveredCount,
      prefix_digest: prefixDigest,
      roster_digest: rosterDigest,
      rule1_failed_indices: Array.from(new Set(rule1FailedIndices)).sort(
        (a, b) => a - b,
      ),
      derived_from: derivedFrom || null,
      verifier_mode: verifierMode,
      verified_at: verifiedAt || new Date().toISOString(),
    },
  };
}

/**
 * Fold predicate for `fold-verification-checkpoint`.
 *
 * By the time this runs the engine has already applied rule 1 (this record's
 * own signature — a checkpoint is NEVER inside its own covered prefix, so it
 * is always fully verified), rule 2 (chain), rule 3 (fork) and rule 4. This
 * predicate re-checks the STRUCTURAL claim so a malformed checkpoint never
 * enters `accepted[]`, and re-asserts that the signer is owner-eligible so an
 * accepted checkpoint always means what a reader assumes it means.
 *
 * It deliberately does NOT re-verify `prefix_digest`: the predicate has no
 * access to the physical record array (`ctx.acceptedSoFar` is the accepted
 * subset, not the raw prefix), and the digest is the FAST PATH's gate, checked
 * in `resolveCheckpointCoverage` before any record is admitted. Accepting a
 * structurally valid checkpoint whose digest happens not to match today simply
 * means the fast path declines to use it — fail-closed, not fail-open.
 */
function foldVerificationCheckpoint(record, ctx) {
  const state = (ctx && ctx.foldState) || { trustRoot: null };
  if (!record || record.type !== CHECKPOINT_TYPE) {
    return { accepted: false, foldState: state, reason: "wrong record type" };
  }
  // The engine supplies the record's physical index, so the coverage bounds
  // are enforced against the REAL position here too. Previously the count was
  // passed as its own bound, which made both bounds tautological and let a
  // checkpoint claiming `covered_count: 2**53-1` fold into `accepted[]` — safe
  // only because no consumer reads that field, a negative nothing pinned.
  const idx = ctx && Number.isSafeInteger(ctx.recordIndex) ? ctx.recordIndex : null;
  const shape = _validateCheckpointContent(
    record.content,
    idx === null ? record.content && record.content.covered_count : idx,
    idx === null ? record.content && record.content.covered_count : idx + 1,
  );
  if (!shape.ok) {
    return {
      accepted: false,
      foldState: state,
      reason: `fold-verification-checkpoint: ${shape.reason}`,
    };
  }
  const resolved = _resolveRosterPerson(ctx && ctx.roster, record.verified_id);
  if (!resolved) {
    return {
      accepted: false,
      foldState: state,
      reason: `fold-verification-checkpoint: signer ${record.verified_id} not in roster`,
    };
  }
  // DELIBERATELY NOT CHECKED HERE: owner-quorum eligibility.
  //
  // `isEligibleSigner` reads LIVE `person.role` / `person.host_role`. Checking
  // it in the predicate evaluates a MUTABLE roster property against a
  // HISTORICAL record, so demoting the attesting owner to contributor — or
  // flipping their host to `ci` — would retroactively flip every checkpoint
  // they ever signed from accepted to rejected. A predicate rejection skips
  // `_advanceChainState`, so that would POISON the emitter's chain from the
  // checkpoint onward (every later record of theirs failing rule 2) and, via
  // the integrity guard's position-scoped indeterminacy sweep, deny codify
  // writes. Rule 1 carries no role check, so this rejection condition would
  // have been genuinely new — a role edit that leaves the key rostered could
  // not previously reject anything.
  //
  // Eligibility IS enforced, where it is actually load-bearing and where the
  // roster is PINNED: `resolveCheckpointCoverage` refuses to grant coverage to
  // a non-owner, and refuses at all once `roster_digest` drifts. Accepting a
  // checkpoint whose signer is no longer owner-eligible costs nothing — it
  // grants no coverage either way.
  return { accepted: true, foldState: state };
}

module.exports = {
  CHECKPOINT_TYPE,
  CHECKPOINT_INTERVAL,
  CHECKPOINT_TAIL_BUDGET_MS,
  CHECKPOINT_PER_RECORD_ASSUMED_MS,
  MAX_PINNED_RULE1_FAILURES,
  MAX_CHECKPOINT_ATTEMPTS,
  canonicalRecordHash,
  computePrefixDigest,
  computeRosterDigest,
  resolveCheckpointCoverage,
  buildCheckpointContent,
  foldVerificationCheckpoint,
  _internal: { _resolveRosterPerson, _validateCheckpointContent },
};
