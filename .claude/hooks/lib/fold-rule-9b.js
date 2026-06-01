/**
 * fold-rule-9b — generation-rotation fold predicate.
 *
 * Shard A3 (workspaces/multi-operator-coc, design v11 §2.2 rule 9b +
 * R9-A-01).
 *
 * A `generation-rotation` record folds ONLY when ALL of the following
 * hold:
 *
 *   1. 2-of-N owner-co-signed — the primary signer (record.verified_id)
 *      plus at least one DISTINCT co-signer in content.co_signers, each
 *      resolving to an owner-role roster person. The cosignature
 *      verifies under the co-signer's roster pubkey over the canonical
 *      serialization of the record core minus its own co_signers field
 *      (defense-in-depth: the engine's rule-1 covered the primary sig;
 *      the predicate re-verifies the co-sig).
 *
 *   2. Carries per-emitter retained chain-heads — one entry per emitter
 *      in the current generation, content.retained_chain_heads:
 *        { <verified_id>: { lastSeq, lastContentHash } }
 *      The chain-head IS the structural seed the engine uses to verify
 *      post-rotation chain continuation.
 *
 *   3. Carries the from-genesis transitive closure of the
 *      checkpoint-exempt subsequence at content.exempt_closure (array;
 *      may be empty for fresh generations but the field MUST be
 *      present).
 *
 *   4. Carries a folded-state digest at content.folded_state_digest
 *      (the digest the next generation will verify against by replay).
 *
 *   5. Carries archive_genN_tip_pin: { ref, tip_sha } — the pin for the
 *      OUTGOING generation's archive ref. Missing → reject.
 *
 *   6. Transitively re-anchors every prior-generation archive tip pin
 *      embedded in folded compaction-checkpoint records (R9-A-01). The
 *      predicate walks ctx.acceptedSoFar for records of type
 *      compaction-checkpoint, extracts their archive_ref_name + tip
 *      hash, and emits the union of all prior pins PLUS the new
 *      archive_genN_tip_pin into foldState.archive_tip_pins.
 *
 * Style: CommonJS, zero-dep, matches sibling fold-genesis-anchor.js
 * shape. The predicate consumes the engine's dispatch ctx
 * ({ foldState, roster, acceptedSoFar }) and returns
 * { accepted, foldState, reason? } per the engine contract in
 * coordination-log.js::_foldLog.
 */

"use strict";

const { canonicalSerialize, verify: cocVerify } = require("./coc-sign.js");
// F14 MED-3: route inline R5-S-04 (host_role:ci) + role checks through
// the single eligibility predicate. Pre-hardening, every co-sign verifier
// spelled out the same check inline; drift across rule 5 / 9b / 9c was
// unbounded.
const { isEligibleSigner } = require("./eligibility.js");
// F51: live archive-ref tip verification. `verifyArchiveTipPin` compares
// the embedded archive_genN_tip_pin against the observed `refs/coc/
// archive-genN` tip on disk; `readArchiveRefTip` is the live-API
// primitive (`git for-each-ref` via execFileSync) that supplies the
// observed SHA. Both are injected via ctx.opts at fold time so tests can
// substitute a fixture-driven reader without monkey-patching modules.
const { verifyArchiveTipPin } = require("./archive-ref.js");
const {
  readArchiveRefTip: defaultReadArchiveRefTip,
} = require("./transport-git-ref.js");

/**
 * Resolve a verified_id to its roster person (if any).
 * Returns { person_id, person } or null.
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
 * Re-derive the canonical bytes a co-signer covered. Co-signers each
 * sign the record core with content.co_signers REMOVED — otherwise
 * each cosig would have to sign the previous co-signer's sig, which is
 * impossible.
 */
function _coSignedBytes(record) {
  const { sig, ...core } = record;
  const c = core.content || {};
  // Strip co_signers to get the canonical bytes co-signers cover.
  const { co_signers, ...contentForCoSig } = c;
  const baseForCoSig = Object.assign({}, core, { content: contentForCoSig });
  return canonicalSerialize(baseForCoSig);
}

/**
 * Verify a single co-signer entry:
 *   - has verified_id + sig
 *   - resolves to an owner-role roster person
 *   - that person's pubkey matching the cosigner's verified_id verifies
 *     the signature over the co-signed bytes
 *
 * Returns { ok, reason }.
 */
function _verifyCoSigner(coSigner, record, roster) {
  if (!coSigner || typeof coSigner !== "object") {
    return { ok: false, reason: "co_signer entry not an object" };
  }
  if (typeof coSigner.verified_id !== "string" || !coSigner.verified_id) {
    return { ok: false, reason: "co_signer missing verified_id" };
  }
  if (typeof coSigner.sig !== "string" || !coSigner.sig) {
    return { ok: false, reason: "co_signer missing sig" };
  }
  const resolved = _resolveRosterPerson(roster, coSigner.verified_id);
  if (!resolved) {
    return {
      ok: false,
      reason: `co_signer verified_id ${coSigner.verified_id} not in roster`,
    };
  }
  // F14 MED-3: route through isEligibleSigner. generation-rotation is an
  // owner-quorum context per architecture §2.2 rule 9b; isEligibleSigner
  // enforces both role=owner AND host_role!=ci with a single audit surface.
  const elig = isEligibleSigner(resolved.person, "owner-quorum");
  if (!elig.eligible) {
    return {
      ok: false,
      reason: `co_signer ${coSigner.verified_id} ineligible: ${elig.reason}`,
    };
  }
  const matchingKey = (resolved.person.keys || []).find(
    (k) => k.fingerprint === coSigner.verified_id,
  );
  if (!matchingKey) {
    return {
      ok: false,
      reason: `co_signer ${coSigner.verified_id} has no roster pubkey match`,
    };
  }
  const bytes = _coSignedBytes(record);
  let r;
  try {
    r = cocVerify(bytes, coSigner.sig, matchingKey.pubkey, {
      keyType: matchingKey.type,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `co_signer verify threw: ${err && err.message ? err.message : String(err)}`,
    };
  }
  if (!r || !r.ok) {
    return {
      ok: false,
      reason: `co_signer verify failed: ${r && r.reason ? r.reason : "unknown"}`,
    };
  }
  if (!r.valid) {
    return {
      ok: false,
      reason: `co_signer signature did not verify: ${r.reason || "invalid"}`,
    };
  }
  return { ok: true };
}

/**
 * Collect prior archive-tip pins from folded compaction-checkpoint
 * records in ctx.acceptedSoFar. R9-A-01: a generation-rotation
 * transitively re-anchors every prior-generation archive ref. The
 * checkpoint record carries archive_ref_name + archive_genN_tip_hash
 * (per rule 5); we union them into the rotation's emitted pin map.
 */
function _collectPriorArchivePins(acceptedSoFar) {
  const pins = {};
  if (!Array.isArray(acceptedSoFar)) return pins;
  for (const r of acceptedSoFar) {
    if (!r || r.type !== "compaction-checkpoint") continue;
    const c = (r && r.content) || {};
    const refName = c.archive_ref_name;
    const tipHash = c.archive_genN_tip_hash;
    if (
      typeof refName === "string" &&
      refName &&
      typeof tipHash === "string" &&
      tipHash
    ) {
      pins[refName] = tipHash;
    }
  }
  return pins;
}

/**
 * Fold a candidate generation-rotation record.
 *
 * @param {object} record - generation-rotation record (with sig)
 * @param {object} ctx    - engine dispatch ctx: { foldState, roster, acceptedSoFar }
 * @returns {{ accepted, foldState, reason? }}
 */
function foldGenerationRotation(record, ctx) {
  const state = (ctx && ctx.foldState) || { trustRoot: null };
  const roster = ctx && ctx.roster;
  const acceptedSoFar = (ctx && ctx.acceptedSoFar) || [];

  // --- shape ---
  if (!record || typeof record !== "object") {
    return {
      accepted: false,
      foldState: state,
      reason: "record not an object",
    };
  }
  if (record.type !== "generation-rotation") {
    return {
      accepted: false,
      foldState: state,
      reason: `record.type != 'generation-rotation' (got: ${record.type})`,
    };
  }
  const c = record.content;
  if (!c || typeof c !== "object") {
    return { accepted: false, foldState: state, reason: "content missing" };
  }

  // --- field presence ---
  if (!c.retained_chain_heads || typeof c.retained_chain_heads !== "object") {
    return {
      accepted: false,
      foldState: state,
      reason: "rule 9b: missing required field retained_chain_heads",
    };
  }
  if (!Array.isArray(c.exempt_closure)) {
    return {
      accepted: false,
      foldState: state,
      reason: "rule 9b: missing required field exempt_closure",
    };
  }
  if (typeof c.folded_state_digest !== "string" || !c.folded_state_digest) {
    return {
      accepted: false,
      foldState: state,
      reason: "rule 9b: missing required field folded_state_digest",
    };
  }
  // R9-A-01: archive_genN_tip_pin MUST be present.
  if (
    !c.archive_genN_tip_pin ||
    typeof c.archive_genN_tip_pin !== "object" ||
    typeof c.archive_genN_tip_pin.ref !== "string" ||
    !c.archive_genN_tip_pin.ref ||
    typeof c.archive_genN_tip_pin.tip_sha !== "string" ||
    !c.archive_genN_tip_pin.tip_sha
  ) {
    return {
      accepted: false,
      foldState: state,
      reason:
        "rule 9b: missing required field archive_genN_tip_pin (R9-A-01); rotation MUST pin the outgoing generation's archive_genN tip",
    };
  }

  // F51 — live tip verification (multi-operator-coordination.md MUST-5).
  // The pin-presence check above closes the "missing field" failure mode;
  // this block closes the "pinned-tip diverges from observed tip" mode by
  // running `archive-ref.js::verifyArchiveTipPin` against the live
  // `refs/coc/archive-genN` tip read from disk via
  // `transport-git-ref.js::readArchiveRefTip` (a `git for-each-ref`
  // wrapper, NOT a documentation grep — `verify-resource-existence.md`
  // MUST-2 shape).
  //
  // The verifier is opt-in via ctx.opts.archiveTipVerify (the engine's
  // foldOpts.archiveTipVerify forwards here). When the caller does NOT
  // wire it — e.g. the engine is folding an in-memory record stream with
  // no on-disk repo, or a test scenario that asserts only field-presence
  // — the live-tip check is skipped. Skipping the verify on a server-
  // side-ruleset-protected repo would leave dropped/truncated archive
  // refs detectable only at field-presence (MUST-5 second structural
  // defense); the production fold path (session-end emitter, /codify
  // fold) wires archiveTipVerify so the second defense is live.
  //
  // ctx.opts.archiveTipVerify shape:
  //   { repoDir: "/path/to/repo",
  //     readArchiveRefTip?: (repoDir, refName) => { ok, tipSha | reason } }
  // The readArchiveRefTip override exists so Tier-1 tests can substitute
  // a deterministic fixture reader without spinning up a real git repo;
  // production callers omit the override and pick up the default.
  const archiveTipVerify =
    (ctx && ctx.opts && ctx.opts.archiveTipVerify) || null;
  if (archiveTipVerify) {
    if (
      typeof archiveTipVerify !== "object" ||
      typeof archiveTipVerify.repoDir !== "string" ||
      !archiveTipVerify.repoDir
    ) {
      return {
        accepted: false,
        foldState: state,
        reason:
          "rule 9b: ctx.opts.archiveTipVerify provided but malformed (repoDir required); refusing to skip live-tip verification silently",
      };
    }
    const readFn =
      typeof archiveTipVerify.readArchiveRefTip === "function"
        ? archiveTipVerify.readArchiveRefTip
        : defaultReadArchiveRefTip;
    const refName = c.archive_genN_tip_pin.ref;
    const liveRead = readFn(archiveTipVerify.repoDir, refName);
    if (!liveRead || liveRead.ok !== true) {
      // Typed-error per zero-tolerance Rule 3 — no silent fallback to
      // "pass because we couldn't read". Halt-and-report per
      // observability.md Rule 5: the reason names the divergence so the
      // calling fold path can route to the advisory shape.
      const why =
        liveRead && liveRead.reason
          ? liveRead.reason
          : "readArchiveRefTip returned no-ok with no reason";
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9b: live archive-ref read failed for '${refName}': ${why}`,
      };
    }
    // Build a synthetic checkpoint-shaped record for verifyArchiveTipPin —
    // the helper's contract is { content: { archive_tip_pins: { ref: sha } } }
    // and the rotation record carries the equivalent pin under
    // content.archive_genN_tip_pin. Reshape rather than overload the
    // verifier so the helper's audit surface stays one-shape.
    const pinView = {
      content: {
        archive_tip_pins: {
          [c.archive_genN_tip_pin.ref]: c.archive_genN_tip_pin.tip_sha,
        },
      },
    };
    const verifyResult = verifyArchiveTipPin(pinView, refName, liveRead.tipSha);
    if (!verifyResult || verifyResult.match !== true) {
      const why = (verifyResult && verifyResult.reason) || "no reason";
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9b: live archive-ref tip verification failed for '${refName}': ${why} (expected pinned tip ${c.archive_genN_tip_pin.tip_sha}, observed ${liveRead.tipSha})`,
      };
    }
  }

  // --- 2-of-N owner co-signature ---
  if (!Array.isArray(c.co_signers) || c.co_signers.length === 0) {
    return {
      accepted: false,
      foldState: state,
      reason:
        "rule 9b: 2-of-N owner co-signature required; co_signers missing or empty (single-signer rejected)",
    };
  }
  const distinctSigners = new Set([record.verified_id]);
  for (const co of c.co_signers) {
    const v = _verifyCoSigner(co, record, roster);
    if (!v.ok) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9b: co-sign verification failed: ${v.reason}`,
      };
    }
    if (distinctSigners.has(co.verified_id)) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9b: co_signer verified_id ${co.verified_id} not distinct from prior signer (2-of-N requires distinct signers)`,
      };
    }
    distinctSigners.add(co.verified_id);
  }
  if (distinctSigners.size < 2) {
    return {
      accepted: false,
      foldState: state,
      reason: `rule 9b: 2-of-N owner co-signature required; only ${distinctSigners.size} distinct signer(s)`,
    };
  }

  // --- R9-A-01 transitive re-anchor of prior archive tip pins ---
  const priorPins = _collectPriorArchivePins(acceptedSoFar);
  const carriedPriorPins = Object.assign(
    {},
    (state && state.archive_tip_pins) || {},
    priorPins,
  );
  const archivePins = Object.assign({}, carriedPriorPins, {
    [c.archive_genN_tip_pin.ref]: c.archive_genN_tip_pin.tip_sha,
  });

  const newState = Object.assign({}, state, {
    archive_tip_pins: archivePins,
    generation: c.to_generation != null ? c.to_generation : state.generation,
    retained_chain_heads: c.retained_chain_heads,
    folded_state_digest: c.folded_state_digest,
  });

  return { accepted: true, foldState: newState };
}

module.exports = {
  foldGenerationRotation,
  _internal: {
    _resolveRosterPerson,
    _coSignedBytes,
    _verifyCoSigner,
    _collectPriorArchivePins,
  },
};
