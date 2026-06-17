/**
 * fold-upstream-canon — project-side single-valued `upstream-canon`
 * pointer fold predicate (the P-side half of the two-sided handshake).
 *
 * ECO-IMPL Wave 2, Shard S2 (A1-T2). Implements
 * `workspaces/ecosystem-operating-model/02-plans/07-cascade-membership.md`
 * §3.1 (the single-valued signed pointer) + §4.2 (the `withdrawn`
 * tombstone) + §3.3 cond-2; normative `specs/06 §7`.
 *
 * Each project P carries a signed, append-only, single-valued pointer
 * chain in its OWN repo at `refs/coc/upstream-canon`. A record:
 *
 *   upstream-canon { ecosystem_id, seq, prev_hash, verified_id, person_id,
 *                    sig }                              (names an ecosystem)
 *   upstream-canon { ecosystem_id: null, withdrawn: true, ... }  (tombstone)
 *
 * The record rides the SAME signed-append + per-emitter-hash-chain
 * substrate as the coordination log (`multi-operator-coordination.md` §2);
 * the inherited fold rules 1–3 (signature gate, per-emitter chain
 * integrity, fork detection) run BEFORE this predicate dispatches. This
 * predicate adds the FOUR W2-S2 invariants:
 *
 *   (i)  single-valued — a record names EXACTLY ONE ecosystem_id (or is a
 *        tombstone naming NONE). Enforced by a positive field allowlist +
 *        the shape check below, so there is no record shape that names two
 *        ecosystems at the tip — structurally forbidding a product spanning
 *        two ecosystems (§3.1, `specs/06 §7` R1 HIGH-4).
 *   (ii) flip = monotone signed append — a flip (migration, S3) appends a
 *        record naming a DIFFERENT ecosystem_id with prev_hash = the prior
 *        record's hash. The monotone chain is enforced by the inherited
 *        rule 2 (per-emitter prev_hash); this predicate accepts the flip and
 *        advances the tracked tip (the LAST-accepted record in fold order).
 *   (iii) signed by a P-rostered identity (cond-2) — the inherited rule 1
 *        verifies the signature against P's CURRENT roster. A record whose
 *        signing identity has been revoked from the roster fails rule 1 and
 *        never reaches this predicate, so it cannot become the tip
 *        (fail-closed; the signing-identity-revocation exclusion axis, §3.3
 *        / §5 cond-2 / §4.2). `upstream-canon-pointer.js::verifyPointsAt`
 *        is the consumer-facing cond-2 check that folds with the current
 *        roster.
 *   (iv) no destination disclosure — the pointer is P's OWN data naming P's
 *        OWN ecosystem; the field allowlist forbids any extra field, so the
 *        record cannot smuggle a second ecosystem or unrelated state.
 *
 * Out of scope for THIS shard (named, §5 / §10): the LIVE on-demand remote
 * ref-fetch of P's pointer tip (the §5 step-2 re-fetch via the D6
 * resolveRemote + provider adapter) is the W3 head consumer; this file
 * folds a records array. Multi-emitter pointer races (two P-operators
 * appending concurrently) are the §10 detection-eventually residual caught
 * by the inherited rule-3 fork-detection, NOT prevented here.
 *
 * Style: CommonJS, zero-dep, matches sibling fold-rule-9c.js /
 * fold-member-registry.js shape. Consumes the engine dispatch ctx
 * ({ foldState, roster, acceptedSoFar }) and returns
 * { accepted, foldState, reason? } per coordination-log.js::_foldLog. Per
 * zero-tolerance.md Rule 3: every rejection returns a typed reason.
 */

"use strict";

const TYPE_UPSTREAM_CANON = "upstream-canon";

// Positive field allowlist (invariant i + iv). A record carrying any key
// outside {ecosystem_id, withdrawn} is rejected — so a pointer cannot
// smuggle a second ecosystem id or unrelated destination state.
const CONTENT_FIELD_ALLOWLIST = new Set(["ecosystem_id", "withdrawn"]);

function reject(foldState, reason) {
  return { accepted: false, foldState, reason };
}

/**
 * Fold one `upstream-canon` pointer record. Validates the single-valued /
 * tombstone shape (i), accepts a monotone flip (ii — the chain order is the
 * inherited rule 2), and advances foldState.upstreamCanon.tip to the
 * last-accepted record so a consumer reads the single-valued tip directly.
 */
function foldUpstreamCanon(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "upstream-canon: content missing");
  }
  for (const key of Object.keys(content)) {
    if (!CONTENT_FIELD_ALLOWLIST.has(key)) {
      return reject(
        foldState,
        `upstream-canon: content carries disallowed field '${key}' (only ecosystem_id, withdrawn permitted — single-valued, no destination disclosure)`,
      );
    }
  }

  const isWithdrawn = content.withdrawn === true;
  if (isWithdrawn) {
    // Tombstone (§4.2 withdrawn): names NO ecosystem. ecosystem_id MUST be
    // explicitly null (single-valued: a tombstone cannot also name an
    // ecosystem).
    if (content.ecosystem_id !== null) {
      return reject(
        foldState,
        "upstream-canon: a withdrawn tombstone MUST carry ecosystem_id: null (names no ecosystem)",
      );
    }
  } else {
    // Pointer: names exactly ONE ecosystem.
    if (typeof content.ecosystem_id !== "string" || !content.ecosystem_id) {
      return reject(
        foldState,
        "upstream-canon: ecosystem_id must be a non-empty string (single-valued) unless this is a withdrawn tombstone",
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(content, "withdrawn") &&
      content.withdrawn !== false
    ) {
      return reject(
        foldState,
        "upstream-canon: a naming pointer MUST NOT set withdrawn (only a tombstone with ecosystem_id: null may)",
      );
    }
  }

  // Advance the tip (last-accepted in fold order). The inherited rule 2
  // guarantees the per-emitter chain is monotone; a flip is just the next
  // accepted record naming a different ecosystem.
  const next = Object.assign({}, foldState, {
    upstreamCanon: {
      tip: {
        ecosystem_id: isWithdrawn ? null : content.ecosystem_id,
        withdrawn: isWithdrawn,
        verified_id: record.verified_id,
        person_id: record.person_id,
        seq: record.seq,
      },
    },
  });
  return { accepted: true, foldState: next };
}

/**
 * Read the single-valued pointer tip from a folded pointer chain (the
 * P-side half of the §5 head). Returns the tip summary
 * { ecosystem_id, withdrawn, verified_id, person_id, seq } or null when the
 * chain is empty / no record verified (e.g. every signer revoked from the
 * roster — fail-closed).
 */
function pointerTip(folded) {
  const uc = folded && folded.foldState && folded.foldState.upstreamCanon;
  return (uc && uc.tip) || null;
}

module.exports = {
  foldUpstreamCanon,
  pointerTip,
  TYPE_UPSTREAM_CANON,
  CONTENT_FIELD_ALLOWLIST,
};
