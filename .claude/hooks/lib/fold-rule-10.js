/**
 * fold-rule-10 — liveness-contradiction fold predicate + settlement
 * predicates for shard A0b-2b.
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.2 fold rule 10 — VERBATIM (R9-S-01 + R10-A-01 + R10-S-01 + R10-A-02)
 *   §4.5 owner-departure residual (journal/0120 — the §1.1 general
 *         structural-residual-law instance)
 *   §1.1 — bounded-trust threat model amendment
 *
 * The 3 invariants this module holds (the other 4 live in derive-n.js
 * and the ceremony libs):
 *
 *   (3) Fold rule 10 (liveness-contradiction): a
 *       collaborator-distinctness-revocation naming operator X is
 *       contested the moment the folding clone observes ANY X-signed
 *       record at an seq/ts not strictly prior to the revocation's
 *       evidence window (R10-A-02). On contest: the revocation is
 *       REJECTED, derived-N reverts to counting X (via derive-n.js's
 *       R10-A-03 contested-exclusion), and a block-grade integrity
 *       advisory NAMES the revocation's signer (owner-accountability).
 *       The one X record that never contests is the window's own BOUNDARY:
 *       the observation the ceremony built the window from, recognised by
 *       its seq and ts identity (`_isWindowBoundary`), never by a ts order.
 *
 *   (4) Settlement via LIVENESS_TTL-bounded X-quiescence (R10-A-01):
 *       the quiescence interval is measured by the FOLDING CLONE'S
 *       wall-clock now, identically to the §4.4 reap predicate. X's
 *       self-stamped ts orders only X's own per-emitter chain and
 *       cannot extend or contract another clone's quiescence interval
 *       (a forger backdating its own ts cannot un-fold a real X record
 *       on an honest clone).
 *
 *   (5) Fetch-bounded settlement (R10-S-01): a clone MAY treat a
 *       revocation as settled only if it has fetched X's peer-observed
 *       per-emitter chain high-water (the rule-9d peer-high-water
 *       mechanism applied to X's chain). A would-be forger that
 *       withholds X's heartbeats from its OWN fold view has by
 *       construction NOT fetched X's current chain high-water, so
 *       cannot reach "settled" and cannot unlock the §6.4
 *       settled-revocation gate (the removal-only roster edit).
 *
 *   Settlement also requires the revocation to be UNCONTESTED OVER THE
 *   COMPLETE STREAM, not merely at the point it was folded: X activity
 *   appended after the revocation contests it exactly as earlier activity
 *   does. The fold evaluates that over every accepted record and stamps
 *   `rule10_contested` (coordination-log.js::_contestRevocationsOverFullStream);
 *   `isSettled` honours that verdict and re-contests what its own inputs
 *   show at gate time.
 *
 * Style: CommonJS, zero-dep, pure functions. No I/O, no fs. `Date.parse`
 * is used to compare ISO-8601 timestamp strings; the wall-clock `now`
 * is INJECTED (numeric ms since epoch) so isSettled is deterministic.
 */

"use strict";

/**
 * LIVENESS_TTL = 20 minutes per architecture §4.4. Exported for reuse
 * by A2a's fold engine (rule 7 liveness predicate) and by the
 * cross-operator reap ceremony in B3b. The same wall-clock TTL governs
 * BOTH the reap predicate AND rule-10 quiescence — explicit per
 * R10-A-01: "identically to the §4.4 reap predicate".
 */
const LIVENESS_TTL_MS = 20 * 60 * 1000;

/**
 * Validate a revocation record's shape. Returns null if OK or a string
 * error. The fold engine pre-verifies the signature via rule 1; this
 * predicate trusts the upstream cryptographic verification and focuses
 * on the rule-10 semantic contract.
 */
function _validateRevocationShape(record, requireRecordWindow = true) {
  if (!record || typeof record !== "object") return "record not an object";
  if (record.type !== "collaborator-distinctness-revocation") {
    return `record.type != 'collaborator-distinctness-revocation' (got: ${record.type})`;
  }
  if (typeof record.verified_id !== "string" || !record.verified_id) {
    return "verified_id missing";
  }
  if (typeof record.seq !== "number" || !Number.isInteger(record.seq)) {
    return "seq missing or not integer";
  }
  if (typeof record.ts !== "string" || !record.ts) return "ts missing";
  if (!record.content || typeof record.content !== "object") {
    return "content missing";
  }
  const c = record.content;
  // Azure DevOps port (Shard 2c): the victim identity field is provider-
  // specific — `principal` (Entra UPN) on ADO, `github_login` on GitHub. The
  // rule-10 contest logic below (evidence-window vs X-chain activity) is
  // provider-NEUTRAL; only the bound-identity field name dispatches.
  const idField = c.provider === "azure-devops" ? "principal" : "github_login";
  if (typeof c[idField] !== "string" || !c[idField]) {
    return `content.${idField} missing`;
  }
  if (!requireRecordWindow) return null;
  if (!c.evidence_window || typeof c.evidence_window !== "object") {
    return "content.evidence_window missing (R10-A-02)";
  }
  const w = c.evidence_window;
  if (typeof w.opens_at !== "string" || !w.opens_at) {
    return "content.evidence_window.opens_at missing";
  }
  if (typeof w.closes_at !== "string" || !w.closes_at) {
    return "content.evidence_window.closes_at missing";
  }
  return null;
}

/**
 * Determine whether an X-chain entry is "strictly prior" to the evidence
 * window. An entry is strictly prior iff BOTH:
 *   (a) entry.ts < window.opens_at (wall-clock strictly prior), AND
 *   (b) entry.seq <= window.victim_chain_high_water_seq (the revoker's
 *       claimed observation high-water at ceremony time).
 *
 * The seq half is what makes backdated-ts attacks structurally unable
 * to un-contest on an honest clone (R10-A-01): if the forger backdates
 * X's ts to before opens_at, the clone may still observe an X record at
 * a seq HIGHER than the revoker's claimed high-water, which the seq
 * check catches independently of ts.
 *
 * When the revoker omits `victim_chain_high_water_seq` from the evidence
 * window, the seq half is permissive (treats it as the entry's own seq,
 * so only ts decides) — but the ceremony in owner-depart-ceremony.js
 * always populates it, so this branch is the legacy/degenerate path.
 */
function _entryStrictlyPrior(entry, evidenceWindow) {
  if (!entry || typeof entry !== "object") return false;
  const opensMs = Date.parse(evidenceWindow.opens_at);
  const entryTsMs =
    typeof entry.ts === "string" ? Date.parse(entry.ts) : Number.NaN;
  if (Number.isNaN(opensMs) || Number.isNaN(entryTsMs)) return false;
  const tsStrictlyPrior = entryTsMs < opensMs;
  const hi = evidenceWindow.victim_chain_high_water_seq;
  // MED-1 (M0 security review): when victim_chain_high_water_seq is
  // ABSENT from the evidence window (a non-conformant revocation), fold
  // strictly — return false so the contest fires. The previous permissive
  // branch (`hi missing → seq-half passes`) let a malformed revocation
  // bypass the R10-A-01 backdated-ts defense. The ceremony at
  // `owner-depart-ceremony.js` always populates the field; absence here
  // signals tampering or a legacy record and MUST contest.
  if (typeof hi !== "number") return false;
  const seqStrictlyPrior = typeof entry.seq === "number" && entry.seq <= hi;
  return tsStrictlyPrior && seqStrictlyPrior;
}

/**
 * Is `entry` the BOUNDARY record of the evidence window — the most recent
 * victim record the revoker had folded, from which the window was built?
 *
 * owner-depart-ceremony.js copies that record's ts into `opens_at` and its seq
 * into `victim_chain_high_water_seq`, on both the GitHub and the Azure DevOps
 * paths. It is therefore never STRICTLY prior to the window it opened, so the
 * strict ts test in `_entryStrictlyPrior` contested every honest revocation by
 * its own boundary. It is recognised here by IDENTITY — both coordinates the
 * window pins must match, the seq exactly and the ts as the same instant — not
 * by an ordering on ts.
 *
 * Both coordinates, not the seq alone: a revoker can name the victim's NEXT seq
 * as the high-water, but cannot know the ts that record will carry, so a record
 * at the high-water seq with any other ts is victim activity and still
 * contests. Every other record is judged by `_entryStrictlyPrior` exactly as
 * before, and a window without an integer high-water has no boundary (MED-1).
 */
function _isWindowBoundary(entry, evidenceWindow, windowIsDerived = false) {
  if (windowIsDerived) return false;
  if (!entry || typeof entry !== "object") return false;
  const hi = evidenceWindow.victim_chain_high_water_seq;
  if (!Number.isInteger(hi) || entry.seq !== hi) return false;
  if (typeof entry.ts !== "string") return false;
  const opensMs = Date.parse(evidenceWindow.opens_at);
  return !Number.isNaN(opensMs) && Date.parse(entry.ts) === opensMs;
}

/**
 * Does victim record `entry` contest a revocation with this evidence window?
 * Every one does except the window's own boundary record and the records
 * strictly prior to the window. The fold's contest and `isSettled`'s
 * lastXActivity arm both decide through this one predicate.
 */
function _entryContests(entry, evidenceWindow, windowIsDerived = false) {
  return (
    !_isWindowBoundary(entry, evidenceWindow, windowIsDerived) &&
    !_entryStrictlyPrior(entry, evidenceWindow)
  );
}

/**
 * Fold a collaborator-distinctness-revocation. Returns either:
 *   - {accepted: true, ...} — no contradicting X-activity observed
 *   - {accepted: false, contested: true, forging_signer, contested_by_record,
 *      reason} — rule 10 fires
 *
 * @param {object} record - the revocation record (signature already
 *   verified upstream by fold rule 1).
 * @param {object} ctx
 * @param {Array<object>} ctx.victimChainEntries - all records the folding
 *   clone has observed signed by the named victim X (per-emitter chain
 *   for X's verified_id, filtered to the relevant types: heartbeat,
 *   session-open, gate-approval, claim, or any X chain entry).
 * @param {object} ctx.state - fold state being mutated; expected shape
 *   {revocations: {...}}.
 *
 * @returns {{
 *   accepted: boolean,
 *   contested?: boolean,
 *   forging_signer?: string,
 *   contested_by_record?: object,
 *   reason?: string,
 *   foldState?: object
 * }}
 */
function foldRevocation(record, ctx) {
  const state = ctx && ctx.state ? ctx.state : { revocations: {} };
  const shapeErr = _validateRevocationShape(record);
  if (shapeErr) {
    return { accepted: false, reason: shapeErr, foldState: state };
  }

  const entries = Array.isArray(ctx && ctx.victimChainEntries)
    ? ctx.victimChainEntries
    : [];
  const window = record.content.evidence_window;

  // Find ANY X-signed entry that is NOT strictly prior to the evidence
  // window. The architecture says: "the moment the folding clone observes
  // ANY X-signed record that X emitted at an seq/ts not strictly prior
  // to the revocation's evidence window" → contest. The window's own
  // boundary record — the observation it was built from — is not such a
  // record (`_isWindowBoundary`).
  let contradicting = null;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (!_entryContests(entry, window, ctx.windowIsDerived === true)) continue;
    contradicting = entry;
    break;
  }

  if (contradicting) {
    // R10-A-01: forger backdating ts cannot reduce the seq the clone
    // independently observes. The contest fires.
    return {
      accepted: false,
      contested: true,
      forging_signer: record.verified_id,
      contested_by_record: contradicting,
      reason: `revocation contested by X-signed activity at seq ${contradicting.seq} / ts ${contradicting.ts}, contradicts evidence window [${window.opens_at}..${window.closes_at}]`,
      foldState: state,
    };
  }

  // Uncontested at this fold step. Settlement (R10-A-01 + R10-S-01) is
  // a SEPARATE predicate evaluated by callers (gate matrix) at
  // gate-time; folding does NOT settle.
  return { accepted: true, foldState: state };
}

/**
 * isSettled — the settlement predicate for the §6.4 settled-revocation
 * gate (the removal-only roster edit fence). A revocation is settled
 * only when ALL of:
 *
 *   (a) Wall-clock quiescence (R10-A-01): the most recent observed
 *       X-activity is older than LIVENESS_TTL_MS by the folding clone's
 *       wall-clock now. NULL lastXActivity counts as "no X activity
 *       observed since the revocation" iff the clone has fetched the
 *       peer high-water (so the absence is structural, not stale-fetch).
 *
 *   (b) Fetch-bounded (R10-S-01): the clone's locally-folded high-water
 *       seq for X's chain is >= the peer-observed high-water (returned
 *       by peerHighWaterFor). Unknown peer high-water (null) → NOT
 *       settled. A forger who withholds X's heartbeats from its OWN
 *       fold view will, by construction, never have peer-high-water
 *       known, so it cannot reach settled.
 *
 *   (c) Uncontested over the COMPLETE stream (rule 10). (a) ages X's
 *       activity; it never asks whether that activity CONTESTS the
 *       revocation, and a contested revocation never settles however long
 *       the clone waits. Three arms, in order:
 *         - the fold's verdict: `revocation.rule10_contested` must be
 *           exactly `false`. coordination-log.js stamps it on every accepted
 *           revocation, over every accepted record, so `true` is a contest
 *           and an ABSENT or non-boolean value means the revocation is not
 *           fold output and was never evaluated: both refuse;
 *         - X's folded high-water against the fold-derived `rule10_window`;
 *         - `lastXActivity` against that same derived window, without a
 *           record-window boundary exemption. Record-authored audit windows
 *           are not settlement authority (.claude/hooks/lib/fold-rule-10.js:407-435).
 *       The last two re-contest at gate time from inputs this predicate
 *       already requires, so a verdict folded before X's records were
 *       appended cannot settle on its own.
 *
 * @param {object} revocation - the entry from `foldLog().accepted`, which
 *   carries the fold's `rule10_contested`; anything else is refused.
 * @param {object} ctx
 * @param {number} ctx.foldedHighWaterSeq - the clone's own locally-folded
 *   seq high-water for X's per-emitter chain.
 * @param {function(string): number|null} ctx.peerHighWaterFor - callback
 *   returning the highest seq observed for X's chain via the rule-9d
 *   peer-high-water mechanism (R8-S-04). Returns null when the clone
 *   has not fetched / cannot resolve.
 * @param {object|null} ctx.lastXActivity - the most recent X-signed
 *   activity record the clone has observed in X's chain, or null.
 * @param {number} ctx.now - ms since epoch; the folding clone's
 *   wall-clock now.
 *
 * @returns {{settled: boolean, reason: string}}
 */
function isSettled(revocation, ctx) {
  const shapeErr = _validateRevocationShape(revocation, false);
  if (shapeErr) {
    return { settled: false, reason: `revocation shape invalid: ${shapeErr}` };
  }
  if (
    !ctx ||
    typeof ctx.foldedHighWaterSeq !== "number" ||
    typeof ctx.peerHighWaterFor !== "function" ||
    typeof ctx.now !== "number"
  ) {
    return {
      settled: false,
      reason:
        "settlement ctx missing required fields (foldedHighWaterSeq, peerHighWaterFor, now)",
    };
  }

  // R10-S-01: fetch-bounded settlement.
  // Azure DevOps port (Shard 2c): provider-neutral victim-identity read.
  const victimLogin =
    revocation.content.provider === "azure-devops"
      ? revocation.content.principal
      : revocation.content.github_login;
  // The peer-high-water function is keyed by the victim's verified_id
  // (X's chain identifier). The ceremony populates this via the
  // mostRecentVictimChainEntry's verified_id; here we accept either a
  // string verified_id key OR the github_login as a fallback the caller
  // may use.
  const lookupKey =
    ctx.lastXActivity && typeof ctx.lastXActivity.verified_id === "string"
      ? ctx.lastXActivity.verified_id
      : victimLogin;
  const peerHi = ctx.peerHighWaterFor(lookupKey);
  if (peerHi === null || peerHi === undefined) {
    return {
      settled: false,
      reason:
        "fetch-bounded settlement: peer high-water for X's chain unknown / not fetched (R10-S-01)",
    };
  }
  if (typeof peerHi !== "number") {
    return {
      settled: false,
      reason: `fetch-bounded settlement: peerHighWaterFor returned non-numeric value (${typeof peerHi})`,
    };
  }
  if (ctx.foldedHighWaterSeq < peerHi) {
    return {
      settled: false,
      reason: `fetch-bounded settlement: local fold seq (${ctx.foldedHighWaterSeq}) is below peer high-water (${peerHi}); local must catch up (R10-S-01)`,
    };
  }

  // R10-A-01: wall-clock quiescence.
  // The quiescence reference point is whichever is LATER:
  //   - the revocation's own ts (no X-activity could plausibly be before
  //     ts since the evidence window closes at ts)
  //   - the last observed X-activity ts (must be silent for TTL after
  //     this)
  // The interval that must elapse is LIVENESS_TTL_MS.
  const revocationTsMs = Date.parse(revocation.ts);
  const lastXMs =
    ctx.lastXActivity && typeof ctx.lastXActivity.ts === "string"
      ? Date.parse(ctx.lastXActivity.ts)
      : -Infinity;
  const referenceMs = Math.max(revocationTsMs, lastXMs);
  if (Number.isNaN(referenceMs) || referenceMs === -Infinity) {
    return {
      settled: false,
      reason:
        "quiescence: cannot parse reference timestamp (revocation.ts or lastXActivity.ts)",
    };
  }
  const elapsed = ctx.now - referenceMs;
  if (elapsed < LIVENESS_TTL_MS) {
    return {
      settled: false,
      reason: `quiescence: only ${elapsed}ms elapsed since reference; need >= ${LIVENESS_TTL_MS}ms (R10-A-01 wall-clock)`,
    };
  }

  // Rule 10 over the COMPLETE stream — see (c) in the doc comment.
  if (revocation.rule10_contested === true) {
    return {
      settled: false,
      reason:
        "rule 10: revocation is contested over the full stream (fold verdict rule10_contested:true); a contested revocation never settles",
    };
  }
  if (revocation.rule10_contested !== false) {
    return {
      settled: false,
      reason:
        "rule 10: this revocation carries no fold verdict, so it was never evaluated over the complete stream; pass the entry from foldLog().accepted",
    };
  }
  const evidenceWindow = Object.prototype.hasOwnProperty.call(revocation, "rule10_window")
    ? revocation.rule10_window : null;
  if (!evidenceWindow || typeof evidenceWindow !== "object" || Array.isArray(evidenceWindow) ||
      !Number.isFinite(Date.parse(evidenceWindow.opens_at)) ||
      !Number.isFinite(Date.parse(evidenceWindow.closes_at))) {
    return { settled: false, reason: "rule 10: missing or invalid fold-derived contest window; pass the entry from foldLog().accepted" };
  }
  const victimHi = evidenceWindow.victim_chain_high_water_seq;
  if (!Number.isSafeInteger(victimHi) || victimHi < 0) {
    return {
      settled: false,
      reason:
        "rule 10: evidence window carries no victim_chain_high_water_seq, so the revocation cannot be shown uncontested (MED-1)",
    };
  }
  const auditWindow = revocation.content.evidence_window;
  const auditHi = auditWindow && typeof auditWindow === "object" && !Array.isArray(auditWindow)
    ? auditWindow.victim_chain_high_water_seq : undefined;
  if (!Number.isSafeInteger(auditHi) || auditHi < -1) {
    return {
      settled: false,
      reason:
        "rule 10: invalid audit evidence window: victim_chain_high_water_seq must be a safe integer >= -1; settlement cannot establish the revoker's observed high-water",
    };
  }
  const settlementHi = Math.min(victimHi, auditHi);
  if (ctx.foldedHighWaterSeq > settlementHi) {
    return {
      settled: false,
      reason: `rule 10: contested — X's folded high-water seq ${ctx.foldedHighWaterSeq} is past the revocation's observed victim high-water ${settlementHi}, so X was active after the revoker looked`,
    };
  }
  if (
    ctx.lastXActivity !== null &&
    ctx.lastXActivity !== undefined &&
    _entryContests(ctx.lastXActivity, evidenceWindow, true)
  ) {
    return {
      settled: false,
      reason: `rule 10: contested — lastXActivity (seq ${ctx.lastXActivity.seq} / ts ${ctx.lastXActivity.ts}) is not strictly prior to the evidence window [${evidenceWindow.opens_at}..${evidenceWindow.closes_at}]`,
    };
  }

  // All three satisfied.
  return {
    settled: true,
    reason: `settled: ${elapsed}ms >= LIVENESS_TTL (R10-A-01) AND local seq ${ctx.foldedHighWaterSeq} >= peer high-water ${peerHi} (R10-S-01) AND uncontested over the full stream (rule 10)`,
  };
}

module.exports = {
  LIVENESS_TTL_MS,
  foldRevocation,
  isSettled,
  // exposed for tests + downstream tools
  _internal: {
    _entryStrictlyPrior,
    _isWindowBoundary,
    _entryContests,
    _validateRevocationShape,
  },
};
