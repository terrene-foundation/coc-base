/**
 * membership-head — the on-demand-fetchable PROOF-GRADE membership head
 * (the §5 keystone of the two-sided cascade-membership handshake).
 *
 * ECO-IMPL Wave 3, Shard A1-T3. Implements
 * `workspaces/ecosystem-operating-model/02-plans/07-cascade-membership.md`
 * §5 (the on-demand proof-grade head) — the primitive every cascade-fire
 * (08 T5) and every retirement fold (08 §4.4 cond-4) rests its
 * fire/suppress/defer decision on. This shard DISCHARGES 08's PENDING-A1
 * obligation (§5 / 08 §8 "A1 obligation").
 *
 * The head for a project P into ecosystem E is the PAIR of signed chain
 * tips, FETCHED and verified to AGREE at decision time (§5):
 *
 *   1. Registry tip (E's side). Fold E's LIVE `refs/coc/member-registry`
 *      tip through the DEFAULT fold engine (whose membership predicates were
 *      registered in W2) and read the per-project state via
 *      `fold-member-registry.js::computeMembershipState`. Integrity is
 *      proof-grade via the SIGNED per-emitter hash-chain (fold rules 1/2/3),
 *      NOT MUST-5/F51's archive-tip-pin (which guards only the
 *      generation-rotation/archive path, §9). [invariant 6]
 *   2. Pointer tip (P's side). Re-fetch P's CURRENT `refs/coc/upstream-canon`
 *      tip and run the cond-2 verify
 *      (`upstream-canon-pointer.js::verifyPointsAt`) — does the tip name E AND
 *      verify against P's CURRENT roster? ANY cond-2 failure (pointer-flip /
 *      withdrawn / signature-revoked / no-tip) means "P does not currently
 *      point at E" (the four-axis exclusion, fail-closed). [invariant 4]
 *
 * The disposition is the fail-safe asymmetry of §2/§3.3/§4.4 made literal:
 *
 *   - SUPPRESS is licensed by EITHER side showing non-membership.
 *     Exclusion is SINGLE-SIDED (any one party breaks membership) and the
 *     safe direction; a registry sever/absence OR a pointer that no longer
 *     names E suffices to suppress, even if the OTHER tip is unfetchable.
 *     [invariant 2]
 *   - FIRE requires BOTH sides affirming. Inclusion is TWO-SIDED (§1 "it
 *     cannot be just one or the other"); a cascade/retirement fires ONLY when
 *     the registry proves an active admission AND P's CURRENT pointer names
 *     E. Neither side alone licenses a fire. [invariant 1]
 *   - DEFER when there is no suppress signal AND an AFFIRMING side is
 *     unfetchable (provider partition). Safety is unconditional (§6.1.1): a
 *     deferred decision NEVER fires a wrong cascade — it withholds and
 *     re-evaluates later. SAFE, not live. [invariant 3]
 *
 * Read-proof vs registry-write are SEPARATE (§5 F3 / HIGH-1):
 * `proveMembership` derives the decision from two READS alone and performs
 * ZERO writes — so a non-E-loom clone running an 08 retirement fold can
 * decide member/severed/defer (and suppress correctly) WITHOUT registry-write
 * authority. Persisting a discovered sever is E-loom housekeeping via the
 * §6.2 continuous sweep, NOT coupled to whichever clone ran the fire.
 * [invariant 5]
 *
 * NO cached fast path on the fire path (§5 F1) [invariant 4]: a FIRE decision
 * ALWAYS re-fetches both tips through the injected fetchers — there is no
 * fresh-`reconciliation-attestation` short-circuit in this function. "Fresh"
 * means E looked recently, NOT that no flip happened since; trusting the
 * cache on the fire path re-admits exactly the stale-TRUE read this head
 * exists to eliminate. A missing fetcher is treated as unfetchable (→ DEFER),
 * never as a silent local-disk fallback. The cached-fresh fast path serves
 * ADVISORY/read-only queries (a dashboard) — NOT this fire gate.
 *
 * The §5 step-1/step-2 LIVE REMOTE fetch is INJECTED via `fetchRegistryRecords`
 * / `fetchPointerRecords` (the W2-S2-established reader seam). The production
 * P-pointer fetcher composes D6 `resolveRemote(projectKey)` — the
 * NAME→remote binding in `.claude/bin/lib/loom-links.mjs`, NOT
 * `ecosystem-config.mjs::getUpstreamCanon()` (the distinct "which canon do I
 * fork from" accessor — the §3.1 brief-correction, journal/0294) — with the
 * F122 provider ref-read primitive. That provider ref-read primitive is W6
 * T2-iface (the 6 net-new adapter methods); until it lands, callers inject a
 * reader (the local realization via `makeLocalReaders` for the single-clone /
 * advisory / test path). This shard owns the AGREEMENT + DISPOSITION engine
 * and the local-reader realization; the remote transport rides W6 — no
 * phantom transport is fabricated here (`spec-accuracy.md` Rule 1/7).
 *
 * Style: CommonJS, sync, zero-dep beyond the shared lib. Per
 * zero-tolerance.md Rule 3: every failure path returns a typed disposition;
 * no silent fallback.
 */

"use strict";

const coordinationLog = require("./coordination-log.js");
const foldMemberRegistry = require("./fold-member-registry.js");
const memberRegistry = require("./member-registry.js");
const upstreamCanonPointer = require("./upstream-canon-pointer.js");

// Disposition constants (the §5 head outcomes).
const PROVEN_MEMBER = "PROVEN_MEMBER";
const PROVEN_SEVERED = "PROVEN_SEVERED";
const DEFER = "DEFER";

// verifyPointsAt takes a repoDir for its DEFAULT (local-disk) reader path;
// when an injected reader is supplied it ignores repoDir. We always inject a
// reader on the fire path, so this marker is never dereferenced as a path —
// it documents that the pointer fold is driven by the fetched records, not by
// disk.
const REMOTE_TIP_MARKER = "<remote-pointer-tip:injected-reader>";

/**
 * Normalize an injected tip fetcher into a fetched/unfetchable result.
 *
 * Contract: a fetcher returns an ARRAY of records on success (possibly EMPTY
 * — a reachable-but-empty ref is a REAL state, not a partition), OR signals
 * unfetchable by THROWING (provider partition / network) OR returning a
 * sentinel `{ unfetchable: true, reason? }` (the shape a provider-adapter
 * wrapper that returns `{ok:false}` naturally yields). A missing fetcher is
 * unfetchable — NEVER a silent local-disk fallback (§5 F1, invariant 4).
 *
 * The empty-array-vs-throw distinction is load-bearing: empty = genuinely
 * empty (registry no-genesis → non-member → SUPPRESS; pointer no-tip → cond-2
 * fail → SUPPRESS), throw = unreachable (→ DEFER). This is the §6.1.1 safety
 * boundary.
 *
 * SIBLING COPY: `membership-reconcile.js::_fetchPointer` is a deliberate
 * byte-identical copy of this contract (kept local so each module is
 * independently auditable). A change to this fetch-classification contract MUST
 * move BOTH — the empty-vs-throw boundary is the §6.1.1 safety boundary on the
 * read (head) AND the write (reconcile) surfaces alike.
 */
function _fetch(fn, label) {
  if (typeof fn !== "function") {
    return {
      unfetchable: true,
      reason: `${label}: no fetcher provided (fire path never silently falls back to local/cache — §5 F1)`,
    };
  }
  let out;
  try {
    out = fn();
  } catch (err) {
    return {
      unfetchable: true,
      reason: `${label}: fetch threw (provider partition / network) — ${err && err.message ? err.message : String(err)}`,
    };
  }
  if (Array.isArray(out)) return { records: out };
  if (out && out.unfetchable === true) {
    return {
      unfetchable: true,
      reason: out.reason || `${label}: reader reported unfetchable`,
    };
  }
  return {
    unfetchable: true,
    reason: `${label}: reader returned a non-array, non-sentinel value (${typeof out}); treated as unfetchable (fail-safe)`,
  };
}

/**
 * Prove a project's CURRENT membership in an ecosystem at the §5 proof-grade
 * head, returning the fire/suppress/defer disposition.
 *
 * @param {object} opts
 * @param {string} opts.ecosystemId  - E's ecosystem id (the one P must name).
 * @param {string} opts.projectId    - P's project id in E's member registry.
 * @param {object} opts.registryRoster - E's loom roster; verifies the
 *   member-registry record signatures (fold rule 1). REQUIRED to fold the
 *   E-side tip.
 * @param {object} opts.pointerRoster  - P's CURRENT roster; verifies the
 *   `upstream-canon` pointer signatures. A signer revoked from THIS roster
 *   drops from the fold (rule 1) → its record cannot be the tip → cond-2
 *   fails closed (the signing-identity-revocation exclusion axis). REQUIRED
 *   to verify the P-side tip.
 * @param {function} opts.fetchRegistryRecords - () => records[] | throws |
 *   {unfetchable}. The LIVE E `refs/coc/member-registry` tip (§5 step 1).
 * @param {function} opts.fetchPointerRecords  - () => records[] | throws |
 *   {unfetchable}. P's LIVE `refs/coc/upstream-canon` tip (§5 step 2);
 *   re-fetched on EVERY fire (never the cache).
 * @returns {{
 *   disposition: "PROVEN_MEMBER"|"PROVEN_SEVERED"|"DEFER",
 *   fire: boolean,                 // true ONLY for PROVEN_MEMBER
 *   registry: object,              // computeMembershipState result | {unfetchable,reason}
 *   pointer: object,               // verifyPointsAt result | {unfetchable,reason}
 *   reason: string,                // typed reason for the disposition
 * }}
 */
function proveMembership(opts) {
  const o = opts || {};
  if (typeof o.ecosystemId !== "string" || !o.ecosystemId) {
    return _defer(
      { unfetchable: true, reason: "ecosystemId missing" },
      { unfetchable: true, reason: "not evaluated" },
      "invalid argument: opts.ecosystemId must be a non-empty string",
    );
  }
  if (typeof o.projectId !== "string" || !o.projectId) {
    return _defer(
      { unfetchable: true, reason: "projectId missing" },
      { unfetchable: true, reason: "not evaluated" },
      "invalid argument: opts.projectId must be a non-empty string",
    );
  }

  // §5 step 1 — LIVE registry tip (E's side).
  const reg = _fetch(o.fetchRegistryRecords, "registry tip");
  // §5 step 2 — LIVE pointer tip (P's side), re-fetched on every fire.
  const ptr = _fetch(o.fetchPointerRecords, "pointer tip");

  let registry = reg.unfetchable ? reg : null;
  let pointer = ptr.unfetchable ? ptr : null;

  if (reg.records) {
    // Fold the LIVE registry records through the DEFAULT engine (membership
    // predicates registered in W2). Integrity is the signed per-emitter
    // hash-chain (rules 1/2/3 run inside foldLog) — invariant 6, NOT F51.
    const folded = coordinationLog.foldLog(reg.records, o.registryRoster, {});
    registry = foldMemberRegistry.computeMembershipState(folded, o.projectId);
  }
  if (ptr.records) {
    // Cond-2 verify against P's CURRENT roster (folds with the injected
    // remote records; a revoked signer fails rule 1 → fail-closed).
    pointer = upstreamCanonPointer.verifyPointsAt(
      REMOTE_TIP_MARKER,
      o.pointerRoster,
      o.ecosystemId,
      { reader: () => ptr.records },
    );
  }

  // The fail-safe asymmetry (§4.4). `member === false` covers every non-member
  // registry state (severed / absent / no-genesis). `names_ecosystem === false`
  // covers every pointer-side exclusion (flip / withdrawn / revoked / no-tip).
  const registrySuppress = !!registry && registry.member === false;
  const registryAffirm = !!registry && registry.member === true;
  const pointerSuppress = !!pointer && pointer.names_ecosystem === false;
  const pointerAffirm = !!pointer && pointer.names_ecosystem === true;

  // [invariant 2] SUPPRESS — single-sided exclusion, the safe direction.
  // A non-membership signal on EITHER side suppresses, even if the OTHER tip
  // is unfetchable (a present sever is monotone; a flipped pointer is P's
  // single-sided exit — both authoritative toward NON-membership).
  if (registrySuppress || pointerSuppress) {
    const causes = [];
    if (registrySuppress) {
      causes.push(`registry state '${registry.state}' (member=false)`);
    }
    if (pointerSuppress) {
      causes.push(
        pointer.withdrawn
          ? "pointer withdrawn (names no ecosystem)"
          : pointer.tip
            ? "pointer names a different ecosystem (flip) or signer revoked"
            : "pointer has no verifying tip (revoked / absent)",
      );
    }
    return {
      disposition: PROVEN_SEVERED,
      fire: false,
      registry,
      pointer,
      reason: `PROVEN severed / non-member — suppress (single-sided exclusion, safe direction): ${causes.join("; ")}`,
    };
  }

  // [invariant 1] FIRE — two-sided inclusion; BOTH sides MUST affirm.
  if (registryAffirm && pointerAffirm) {
    return {
      disposition: PROVEN_MEMBER,
      fire: true,
      registry,
      pointer,
      reason:
        "PROVEN member — registry admission active AND P's CURRENT pointer names E (both signed tips agree, §5)",
    };
  }

  // [invariant 3] DEFER — no suppress signal AND an affirming side is
  // unfetchable. Safety is unconditional: withhold, re-evaluate later.
  return _defer(
    registry,
    pointer,
    `DEFER — cannot PROVE the intersection: ${_deferDetail(reg, ptr, registryAffirm, pointerAffirm)} (safe-but-not-live; re-evaluate on a later fold, §6.1)`,
  );
}

function _deferDetail(reg, ptr, registryAffirm, pointerAffirm) {
  const parts = [];
  if (reg.unfetchable) parts.push(reg.reason);
  else if (!registryAffirm)
    parts.push("registry side did not affirm membership");
  if (ptr.unfetchable) parts.push(ptr.reason);
  else if (!pointerAffirm) parts.push("pointer side did not affirm naming E");
  return parts.join("; ");
}

function _defer(registry, pointer, reason) {
  return { disposition: DEFER, fire: false, registry, pointer, reason };
}

/**
 * Build the LOCAL tip fetchers (the single-clone / advisory / test
 * realization). These read the on-disk `member-registry.jsonl` /
 * `upstream-canon.jsonl` files — the realization that exists TODAY before the
 * W6 provider ref-read transport lands.
 *
 * NOTE: passing these into `proveMembership` makes the "fire" decision rest on
 * LOCAL state. That is correct for a SINGLE-CLONE ecosystem (E-loom and P in
 * one checkout) and for tests; in a multi-clone deployment the production
 * caller injects REMOTE fetchers instead (D6 `resolveRemote` + the W6 F122
 * provider ref-read), so a fire sees P's CURRENT remote tip rather than a
 * possibly-stale local mirror (§5 F1). The local readers throw on a non-ENOENT
 * read error and return [] on ENOENT — exactly the throw=unfetchable /
 * []=reachable-empty contract `_fetch` expects.
 *
 * @param {object} args
 * @param {string} args.registryRepoDir - the repo holding E's local
 *   `member-registry.jsonl`.
 * @param {string} args.projectRepoDir  - the repo holding P's local
 *   `upstream-canon.jsonl`.
 * @returns {{ fetchRegistryRecords: function, fetchPointerRecords: function }}
 */
function makeLocalReaders(args) {
  const a = args || {};
  return {
    fetchRegistryRecords: () =>
      memberRegistry.readMemberRegistry(a.registryRepoDir),
    fetchPointerRecords: () =>
      upstreamCanonPointer.readUpstreamCanonLog(a.projectRepoDir),
  };
}

module.exports = {
  proveMembership,
  makeLocalReaders,
  PROVEN_MEMBER,
  PROVEN_SEVERED,
  DEFER,
  // Exposed for tests.
  _fetch,
  REMOTE_TIP_MARKER,
};
