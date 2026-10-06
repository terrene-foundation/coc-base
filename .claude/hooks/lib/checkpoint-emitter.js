/**
 * checkpoint-emitter — the PRODUCER for `fold-verification-checkpoint`.
 *
 * The bound this repo already carried never fired because it had no producer.
 * Measured on the live 919-record log: 0 `generation-rotation` records, 0
 * `compaction-checkpoint` records, against 195 `codify-lease` as the control
 * that proves the instrument sees records at all. The only emission path that
 * existed — `multi-operator-sessionend.js::emitCheckpoint` — is gated on
 * `shouldAttemptCheckpoint()`, whose entire body is
 * `process.env.COC_TEST_FORCE_CHECKPOINT === "1"`. A test-only env var is not
 * a producer, and even when forced it returns early whenever a co-signer
 * exists and otherwise emits a record carrying `folded_state_digest: "stub"`
 * that fold rule 5 rejects. Both ends were inert.
 *
 * This module is the automatic producer. It is deliberately NOT gated on an
 * env var, a config flag, or anything an operator has to remember — a
 * mechanism that needs remembering is the same defect one level up.
 *
 * ---------------------------------------------------------------------------
 * THE TRIGGER, AND WHY IT IS THIS ONE
 * ---------------------------------------------------------------------------
 *
 * Trigger: the number of records ABOVE the last valid checkpoint reaches
 * `CHECKPOINT_INTERVAL` (200). Fired at the SessionEnd/Stop session boundary,
 * never on the per-tool-call path and never at SessionStart.
 *
 * Chosen on the measurement, and the alternatives are rejected on it too:
 *
 *   - RECORD COUNT is the trigger because record count is what the cost is
 *     linear in. Per-record fold cost measured at 8257 ms / 919 records =
 *     8.98 ms, essentially all subprocess spawn. 200 uncovered records is
 *     ~1.8 s of tail verification, inside the 5-second PreToolUse hook timeout
 *     with >3 s of headroom for the rest of the hook's work.
 *   - BYTE SIZE was rejected: cost tracks the number of signatures, not their
 *     length. A log of 200 large records costs the same as 200 small ones.
 *   - AGE was rejected: an idle repo accrues no records and needs no
 *     checkpoint, while a busy hour can add hundreds. Age is uncorrelated with
 *     the quantity being bounded.
 *   - SESSION BOUNDARY ALONE (checkpoint every session) was rejected as the
 *     trigger, though it is the right PLACE: it would write a record per
 *     session regardless of need, and the log is append-only, so the
 *     checkpoints themselves would become the growth they exist to bound.
 *
 * WHY THE SESSION BOUNDARY IS THE RIGHT PLACE, not merely a convenient one:
 * the attestation must be signed by an OWNER, so it can only be produced where
 * an owner's signing key is actually reachable — an interactive owner session.
 * SessionEnd/Stop already folds the whole log, so the fold result the
 * attestation derives from is already in hand and the emission costs one
 * signature, and teardown has no latency budget to protect. The per-tool-call
 * path is deliberately excluded: adding work to the path being optimised would
 * be self-defeating. SessionStart is ALSO excluded — it is the #857-sensitive
 * path, and a write there would spend the very budget this exists to protect.
 *
 * ---------------------------------------------------------------------------
 * HONESTY OF THE ATTESTATION
 * ---------------------------------------------------------------------------
 *
 * An attestation may only claim what the fold that produced it actually did.
 * `foldLog` now reports `checkpointCoverage`, and this module reads it rather
 * than assuming:
 *
 *   - coverage 0  → every signature in that fold was re-derived → "full".
 *   - coverage >0 → the prefix rested on a prior owner-signed attestation →
 *                   "chained", with `derived_from` naming that attestation's
 *                   canonical hash so an auditor can walk the chain back to a
 *                   "full" one. The transitive claim is exactly: this owner
 *                   verified the DELTA in full and accepted the prior owner's
 *                   signed attestation for the rest.
 *
 * A fold run with `skipSignatureVerify` verified nothing and MUST NOT produce
 * an attestation; that is refused explicitly rather than left to the caller.
 *
 * Style: CommonJS, zero-dep beyond node builtins + the sibling libs. Never
 * throws — a session-boundary hook must never block.
 */

"use strict";

const path = require("path");
const fvc = require("./fold-verification-checkpoint.js");
const { isEligibleSigner } = require("./eligibility.js");

/**
 * The transport's per-line cap (`transport-filesystem.js` / `coc-emit.js`
 * MAX_LINE_BYTES) — a record longer than this is refused at append.
 */
const MAX_LINE_BYTES = 2048;

/**
 * Bytes reserved for the detached signature when projecting the record size.
 * Measured: an armored RSA-4096 detached GPG signature is 870 bytes; SSH
 * signatures are smaller. 1024 leaves margin without being generous enough to
 * let a record through that the append would then refuse.
 */
const SIG_RESERVE_BYTES = 1024;

/**
 * R9-S-02 gate, fail-CLOSED on unavailability.
 *
 * `gateEligibleForSelfSignedCheckpointOrRotation(roster, foldedState)` reads
 * `{records}`-shaped folded state to decide whether a derived-N=1 roster is a
 * genuine single-owner genesis or a revocation-induced singleton. A missing or
 * throwing fence is an UNKNOWN, and an unknown ranks tightest: refuse.
 *
 * @returns {{eligible: boolean, reason?: string}}
 */
function _r9s02Gate(repoDir, roster, foldResult) {
  try {
    const { gateEligibleForSelfSignedCheckpointOrRotation } = require(
      path.join(__dirname, "r9s02-fence.js"),
    );
    const r = gateEligibleForSelfSignedCheckpointOrRotation(roster, {
      records: (foldResult && foldResult.accepted) || [],
    });
    if (!r || typeof r.eligible !== "boolean") {
      return { eligible: false, reason: "fence returned an unreadable verdict" };
    }
    return r;
  } catch (err) {
    return {
      eligible: false,
      reason: `fence unavailable (${err && err.message ? err.message : String(err)}); blocked conservatively`,
    };
  }
}

/**
 * Decide whether to emit, and emit.
 *
 * @param {object} args
 * @param {string} args.repoDir
 * @param {Array<object>} args.records    - the physical log, in order
 * @param {object} args.foldResult        - the result of folding `records`
 * @param {object} args.roster
 * @param {object} args.identity          - {verified_id, person_id}
 * @param {function} [args.emit]          - injected emitSignedRecord (tests)
 * @param {object} [args.emitOpts]        - extra opts forwarded to emit
 * @returns {{emitted: boolean, reason: string, record?: object}}
 */
function maybeEmitCheckpoint(args) {
  const a = args || {};
  const skip = (reason) => ({ emitted: false, reason });

  try {
    const { repoDir, records, foldResult, roster, identity } = a;
    if (!repoDir) return skip("no repoDir");
    if (!Array.isArray(records) || records.length === 0) return skip("no records");
    if (!foldResult || typeof foldResult !== "object") return skip("no fold result");
    if (!roster || !roster.persons) return skip("no roster");
    if (!identity || !identity.verified_id || !identity.person_id) {
      return skip("no resolved identity");
    }

    // --- honesty gate: an unverified fold may not produce an attestation ---
    const coverage = foldResult.checkpointCoverage;
    if (!coverage || typeof coverage.coveredCount !== "number") {
      // No coverage report means this fold's scope is unknown, and an unknown
      // ranks tightest: refuse to attest rather than guess "full".
      return skip(
        "fold result carries no checkpointCoverage: cannot state honestly what was verified",
      );
    }
    if (foldResult.skippedSignatureVerify === true) {
      return skip("fold ran with skipSignatureVerify: nothing was verified");
    }

    // --- the trigger ---
    const uncovered = records.length - coverage.coveredCount;
    if (uncovered < fvc.CHECKPOINT_INTERVAL) {
      return skip(
        `only ${uncovered} record(s) above the last checkpoint; threshold is ${fvc.CHECKPOINT_INTERVAL}`,
      );
    }

    // --- the signer must be an owner, and eligible ---
    let resolvedPersonId = null;
    let resolvedPerson = null;
    for (const [pid, person] of Object.entries(roster.persons)) {
      // S61 — shape-guard: a non-array `keys` SKIPS this person, never throws.
      // SKIP IS SAFE HERE because non-resolution is wired to REFUSE:
      // `if (!resolvedPerson) return skip(...)` below, and skipping an
      // attestation emits nothing. (Condition + the recorded exceptions where
      // skip is NOT safe: coordination-log.js::_resolveRosterPerson.)
      //
      // INTERACTION this closes: the S61 fold-resolver fences now SKIP a
      // malformed person instead of throwing, so a roster that previously died
      // at the fold now REACHES this loop — the fix moved the throw downstream
      // to what was, until this guard, an unfenced site.
      const personKeys = Array.isArray(person && person.keys) ? person.keys : [];
      for (const k of personKeys) {
        if (k && k.fingerprint === identity.verified_id) {
          resolvedPersonId = pid;
          resolvedPerson = person;
        }
      }
    }
    if (!resolvedPerson) return skip("this session's identity is not in the roster");

    // --- R9-S-02: the degenerate-single-owner self-sign fence ---
    //
    // This attestation IS a single-owner self-sign, which is the exact shape
    // R9-S-02 governs: it refuses when the roster's derived N=1 traces to a
    // REVOCATION rather than to a genuine single-owner genesis. The compaction
    // path already routes through it (`multi-operator-sessionend.js`), and
    // `isEligibleSigner` cannot substitute — it reads role and host_role only
    // and has no revocation awareness.
    //
    // The module header argues at length why the QUORUM and ARCHIVE
    // requirements do not apply to a non-discarding attestation. That argument
    // does not extend to this fence: the named residual below — an owner key
    // compromised at the moment of attestation — is precisely the scenario
    // R9-S-02 exists for. So it is applied rather than argued away, and it
    // fails CLOSED when unavailable.
    const fence = _r9s02Gate(repoDir, roster, foldResult);
    if (!fence.eligible) {
      return skip(`R9-S-02 fence refused the self-signed attestation: ${fence.reason}`);
    }

    const elig = isEligibleSigner(resolvedPerson, "owner-quorum");
    if (!elig || !elig.eligible) {
      // Not an error. A contributor's session simply cannot attest; the next
      // owner session will. Surfaced so the absence of checkpoints in a
      // contributor-only repo is legible rather than mysterious.
      return skip(
        `this session's identity is not owner-eligible (${(elig && elig.reason) || "unknown"}); only an owner can attest`,
      );
    }

    // --- what we attest: everything currently in the log ---
    //
    // The checkpoint lands at index >= records.length, so `covered_count ===
    // records.length` satisfies the "cannot cover itself or later" bound with
    // no slack needed. If a concurrent writer appends between here and the
    // append, the checkpoint simply lands at a higher index — the prefix is
    // unchanged (the log is append-only), so the digest still matches and the
    // bound still holds. No lock is required for correctness.
    const coveredCount = records.length;

    // --- the indices this fold found FAILING rule 1 ---
    // Indices only, never reasons: the fold RE-VERIFIES each of these, so the
    // rejection reason is re-derived exactly rather than frozen into the
    // attestation. See `fold-verification-checkpoint.js`
    // MAX_PINNED_RULE1_FAILURES for why storing reasons was both oversized and
    // wrong.
    const rule1FailedIndices = [];
    for (const rej of foldResult.rejected || []) {
      if (!rej || rej.rule !== "rule-1") continue;
      const idx = records.indexOf(rej.record);
      if (idx >= 0 && idx < coveredCount) rule1FailedIndices.push(idx);
    }
    if (rule1FailedIndices.length > fvc.MAX_PINNED_RULE1_FAILURES) {
      return skip(
        `${rule1FailedIndices.length} rule-1 failures exceed the pin cap of ${fvc.MAX_PINNED_RULE1_FAILURES}; declining to attest (log stays fully verified)`,
      );
    }

    const verifierMode = coverage.coveredCount > 0 ? "chained" : "full";
    const built = fvc.buildCheckpointContent({
      records,
      roster,
      coveredCount,
      rule1FailedIndices,
      derivedFrom: verifierMode === "chained" ? coverage.checkpointHash : null,
      verifierMode,
      verifiedAt: new Date().toISOString(),
    });
    if (!built.ok) return skip(`content build refused: ${built.reason}`);

    // --- projected size: refuse BEFORE signing rather than after ---
    //
    // The transport caps a line at MAX_LINE_BYTES. `coc-append.js` records why
    // this check belongs before the signature: refusing on overflow keeps the
    // log free of lines that look valid and verify-fail later. Emit enforces
    // its own cap too; projecting here turns a late generic refusal into an
    // early, specific, legible one.
    const projected =
      Buffer.byteLength(
        JSON.stringify({
          type: fvc.CHECKPOINT_TYPE,
          verified_id: identity.verified_id,
          person_id: identity.person_id,
          seq: 999999,
          prev_hash: "0".repeat(64),
          ts: new Date().toISOString(),
          content: built.content,
        }),
        "utf8",
      ) + SIG_RESERVE_BYTES;
    if (projected > MAX_LINE_BYTES) {
      return skip(
        `projected record size ${projected} B exceeds the ${MAX_LINE_BYTES} B line cap (usually too many pinned rule-1 failures); declining to attest`,
      );
    }

    // --- emit ---
    // seq / prev_hash are stamped by emit from a FRESH chain-head read; the
    // caller MUST NOT pass them.
    const emitFn =
      typeof a.emit === "function"
        ? a.emit
        : require(path.join(__dirname, "coc-emit.js")).emitSignedRecord;
    const result = emitFn(
      Object.assign(
        {
          repoDir,
          type: fvc.CHECKPOINT_TYPE,
          content: built.content,
          identity: { verified_id: identity.verified_id, person_id: resolvedPersonId },
        },
        a.emitOpts || {},
      ),
    );
    if (!result || !result.ok) {
      return skip(
        `emit refused at step '${(result && result.step) || "unknown"}': ${(result && result.reason) || "unknown"}`,
      );
    }
    return {
      emitted: true,
      reason: `attested ${coveredCount} records (${verifierMode}${verifierMode === "chained" ? `, derived_from ${String(built.content.derived_from).slice(0, 12)}…` : ""}), ${rule1FailedIndices.length} pinned rule-1 failure(s)`,
      record: result.record,
    };
  } catch (err) {
    // A session-boundary hook must never block. Any throw degrades to "no
    // checkpoint", which means the next fold verifies everything.
    return skip(
      `checkpoint emission threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
}

module.exports = {
  maybeEmitCheckpoint,
  MAX_LINE_BYTES,
  SIG_RESERVE_BYTES,
};
