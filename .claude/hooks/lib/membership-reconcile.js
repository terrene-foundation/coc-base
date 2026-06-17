/**
 * membership-reconcile — the §6 reconciliation WRITER (E-loom's
 * guaranteed-eventual sweep over each member's project-side pointer tip).
 *
 * ECO-IMPL Wave 3, Shard A1-T4. Implements
 * `workspaces/ecosystem-operating-model/02-plans/07-cascade-membership.md`
 * §6.2 (continuous + on-demand reconciliation) + §6.3 (the staleness
 * backstop query) + §4.3 M3 (the sever evidence shape the fold accepts);
 * normative `specs/06 §7`.
 *
 * Where A1-T3 (`membership-head.js`) is the READ-ONLY proof-grade DECISION
 * (the fire/suppress/defer gate, zero writes), A1-T4 is the WRITER half: E's
 * loom observing each member P's `upstream-canon` tip and PERSISTING the
 * result into E's `member-registry` so the registry HEAD records it for
 * siblings (§5 HIGH-1 — persistence is E-loom housekeeping, the
 * guaranteed-eventual writer, NOT coupled to whichever clone ran a fire).
 *
 * `reconcileMember` observes ONE member's pointer tip and writes ONE record:
 *
 *   - tip names E (cond-2 holds) → append a fresh `reconciliation-attestation`
 *     (`observed_names_this_ecosystem: true`, `observed_at`) — keeps the
 *     registry head fresh so most §5 SUPPRESS checks hit the fast path (a FIRE
 *     always re-fetches regardless, §4.4). [invariant 1: attest]
 *   - tip names a DIFFERENT ecosystem (a flip / migration, §7 S3) → append a
 *     `membership-severed{reason: pointer-flip}` carrying the §4.3 M3
 *     re-verifiable evidence (`observed_pointer_tip` + `observed_names_this_
 *     ecosystem: false`, `supersedes_ref` = the admitted head). [inv 1: flip]
 *   - tip retracts entirely (a `withdrawn` tombstone) → append a
 *     `membership-severed{reason: withdrawn}` with the same M3 evidence shape.
 *     [inv 1: withdrawn]
 *   - tip UNFETCHABLE (provider partition / network) → DEFER, write NOTHING
 *     (§6.1.1 safety: a deferred decision never fires a wrong sever; the §6.3
 *     staleness query surfaces the long-deferred case). [inv 1: defer]
 *   - NO verifying tip (empty chain / every P-signer revoked — the
 *     signing-identity-revocation axis, §4.2) → NOOP, write NOTHING. This axis
 *     is NOT a recorded sever (§4.2): it is caught LIVE at the §5 cond-2 verify
 *     (fail-closed → the head SUPPRESSES); E MAY additionally `evicted`-sever
 *     to record a permanent removal, but that is a SEPARATE owner act, never an
 *     automatic reconciliation write. [inv 1: noop-no-tip]
 *
 * The sever the writer emits MUST be one the §4.3 fold ACCEPTS: M3 requires
 * `observed_pointer_tip` (non-empty) + `observed_names_this_ecosystem === false`
 * + `supersedes_ref` === the current admitted head_hash, and rejects a sever
 * whose cited evidence still names E (anti-malicious-eviction). A reconciler is
 * EVIDENCE-bearing not authority-bearing (§6.2): any signer (incl.
 * `host_role: ci`) MAY run reconciliation for attest / pointer-flip / withdrawn
 * — the cited P-pointer evidence is the authority, re-verifiable by any folder.
 * (Only an `evicted` sever needs an owner-class signer; that is the owner's act,
 * NOT this automatic writer's — A1-T4 never emits `evicted`.) [invariant 2]
 *
 * `findStaleMembers` is the §6.3 condition-agnostic staleness backstop: it
 * reports every member whose last reconciliation observation is older than a
 * wall-clock threshold (or who has NEVER been reconciled) — REGARDLESS of why
 * (provider unreachable, cadence stalled, partial-push lag). Complete by
 * construction: a never-completing reconciliation is detected-eventually and
 * operator-visible, never a silent indefinite trust of a stale TRUE.
 * [invariant 3]
 *
 * The §5 step-2 LIVE REMOTE pointer fetch is INJECTED via `fetchPointerRecords`
 * (the W2-S2 reader seam) exactly as the head injects its fetchers. The
 * production fetcher composes D6 `resolveRemote(projectKey)` (NAME→remote,
 * `loom-links.mjs`) — NOT `getUpstreamCanon()` (the §3.1 brief-correction,
 * journal/0294) — with the F122 provider ref-read primitive (W6 T2-iface,
 * which does not yet exist; until it lands, callers inject the local reader via
 * `makeLocalPointerReader`). This shard owns the OBSERVE→CLASSIFY→WRITE engine
 * + the local realization; the remote transport rides W6 — no phantom
 * transport is fabricated here (`spec-accuracy.md` Rule 1/7).
 *
 * Style: CommonJS, sync, zero-dep beyond the shared lib. Per
 * zero-tolerance.md Rule 3: every failure path returns a typed disposition;
 * no silent fallback.
 */

"use strict";

const crypto = require("crypto");

const { canonicalSerialize } = require("./coc-sign.js");
const memberRegistry = require("./member-registry.js");
const upstreamCanonPointer = require("./upstream-canon-pointer.js");
const foldMemberRegistry = require("./fold-member-registry.js");

// §6.2 reconciliation sweep cadence bound (the spec's MEMBERSHIP_RECONCILE_TTL,
// in MILLISECONDS — unit suffix omitted to match the spec name + the sibling
// `MIGRATION_LIVENESS_TTL` convention). The continuous sweep MUST re-observe
// AND persist each member at least once per this window (§6.2), tying the §5
// "bounded by sweep cadence" persistence bound AND the §10 flip-flop
// `max(MEMBERSHIP_RECONCILE_TTL)` bound to ONE clock — so "bounded by sweep
// cadence" is falsifiable, not aspirational (NEW-MED-1). Default 1h; an
// ecosystem MAY tune it, but `findStaleMembers` measures against whatever it is.
const MEMBERSHIP_RECONCILE_TTL = 60 * 60 * 1000;

// The reader marker passed to verifyPointsAt — when an injected reader is
// supplied, repoDir is ignored (the pointer fold is driven by the fetched
// records, not by disk). Mirrors membership-head.js::REMOTE_TIP_MARKER.
const REMOTE_POINTER_MARKER = "<remote-pointer-tip:injected-reader>";

// Reconciliation disposition constants.
const ATTESTED = "ATTESTED"; // tip names E → fresh attestation written
const SEVERED_FLIP = "SEVERED_FLIP"; // tip names another eco → pointer-flip sever
const SEVERED_WITHDRAWN = "SEVERED_WITHDRAWN"; // tip retracts → withdrawn sever
const DEFER = "DEFER"; // tip unfetchable → no write
const NOOP_NO_TIP = "NOOP_NO_TIP"; // no verifying tip → no write (caught live at §5)
const NOOP_NOT_MEMBER = "NOOP_NOT_MEMBER"; // P is not a current member → nothing to reconcile
const NOOP_INVALID_ARGS = "NOOP_INVALID_ARGS"; // a programming-error arg shape (distinct from a genuine non-member, zero-tolerance.md Rule 3 typed failure)

/**
 * Normalize an injected tip fetcher into a fetched/unfetchable result, with
 * the SAME contract `membership-head.js::_fetch` enforces (a deliberate
 * byte-identical local copy so reconcile is independently auditable — the
 * contract is load-bearing and identical on both surfaces; a change here MUST
 * also move the head sibling, and vice versa — see the SIBLING COPY note on
 * `membership-head.js::_fetch`):
 *
 *   array          → { records }           (EMPTY array is reachable-empty, a
 *                                            REAL state: no verifying tip → NOOP)
 *   throw          → { unfetchable }        (provider partition / network → DEFER)
 *   { unfetchable } → { unfetchable }       (a provider-adapter {ok:false} wrapper)
 *   non-array/null → { unfetchable }        (fail-safe)
 *   missing fn     → { unfetchable }        (NEVER a silent local-disk fallback)
 */
function _fetchPointer(fn) {
  if (typeof fn !== "function") {
    return {
      unfetchable: true,
      reason:
        "pointer tip: no fetcher provided (reconciliation never silently falls back to local/cache — §5 F1)",
    };
  }
  let out;
  try {
    out = fn();
  } catch (err) {
    return {
      unfetchable: true,
      reason: `pointer tip: fetch threw (provider partition / network) — ${err && err.message ? err.message : String(err)}`,
    };
  }
  if (Array.isArray(out)) return { records: out };
  if (out && out.unfetchable === true) {
    return {
      unfetchable: true,
      reason: out.reason || "reader reported unfetchable",
    };
  }
  return {
    unfetchable: true,
    reason: `pointer tip: reader returned a non-array, non-sentinel value (${typeof out}); treated as unfetchable (fail-safe)`,
  };
}

/**
 * Hash of P's observed verified pointer tip — the `observed_pointer_tip`
 * evidence the attestation / M3 sever carries (§4.2). Computed over the
 * canonical bytes of the verified tip summary (`{ ecosystem_id, withdrawn,
 * verified_id, person_id, seq }`), so a flip to a new ecosystem (new `seq`)
 * yields a NEW tip hash. A genuine hash of what E observed — never a placeholder.
 */
function _observedTipHash(tip) {
  return crypto
    .createHash("sha256")
    .update(canonicalSerialize(tip))
    .digest("hex");
}

/**
 * Resolve the registry-writer's `observed_at` timestamp. Defaults to the
 * current wall-clock (hook/lib code, not a workflow script — `new Date()` is
 * available); a caller (or a test) MAY inject a fixed ISO string for
 * determinism. The fold requires a non-empty timestamp string.
 */
function _observedAt(observedAt) {
  if (typeof observedAt === "string" && observedAt) return observedAt;
  return new Date().toISOString();
}

/**
 * Reconcile ONE member P: observe P's CURRENT `upstream-canon` tip and write
 * the appropriate `member-registry` record into E's registry. The
 * guaranteed-eventual writer of §6.2; the §5 head READS what this writer
 * persists.
 *
 * @param {object} opts
 * @param {string} opts.registryRepoDir - the repo holding E's local
 *   `member-registry.jsonl` (the write target).
 * @param {string} opts.ecosystemId     - E's ecosystem id (the one P must name).
 * @param {string} opts.projectId       - P's project id in E's registry.
 * @param {object} opts.registryRoster  - E's loom roster (folds E's registry +
 *   verifies the reconciler's signature on emit).
 * @param {object} opts.pointerRoster   - P's CURRENT roster (verifies P's
 *   pointer tip; a revoked P-signer drops from the fold → no verifying tip →
 *   NOOP, the signing-identity-revocation axis).
 * @param {function} opts.fetchPointerRecords - () => records[] | throws |
 *   {unfetchable}. P's LIVE `refs/coc/upstream-canon` tip (§6.2 / §5 step 2).
 * @param {object} opts.identity        - the reconciler's signed identity
 *   ({verified_id, person_id, display_id}) — evidence-bearing, any role.
 * @param {string} opts.signingKeyPath  - the reconciler's signing key.
 * @param {string} [opts.observedAt]    - ISO timestamp (defaults to now).
 * @param {function} [opts.emit]        - emit override (tests); defaults to
 *   memberRegistry.emitMemberRecord.
 * @returns {{
 *   disposition: string,           // one of the constants above
 *   wrote: boolean,                // did a registry record land?
 *   record?: object,               // {type, ...} summary of what was written
 *   emit?: object,                 // the raw emit result (ok / error)
 *   pointer?: object,              // verifyPointsAt result | {unfetchable,reason}
 *   reason: string,
 * }}
 */
function reconcileMember(opts) {
  const o = opts || {};
  if (typeof o.registryRepoDir !== "string" || !o.registryRepoDir) {
    return _noop(
      NOOP_INVALID_ARGS,
      "invalid argument: opts.registryRepoDir must be a non-empty string",
    );
  }
  if (typeof o.ecosystemId !== "string" || !o.ecosystemId) {
    return _noop(
      NOOP_INVALID_ARGS,
      "invalid argument: opts.ecosystemId must be a non-empty string",
    );
  }
  if (typeof o.projectId !== "string" || !o.projectId) {
    return _noop(
      NOOP_INVALID_ARGS,
      "invalid argument: opts.projectId must be a non-empty string",
    );
  }

  // Step 1 — fold E's registry; reconciliation acts ONLY on a CURRENT member.
  // A no-genesis / absent / severed project is monotone (a sever never
  // reverts, M2) — nothing to reconcile; reconciliation never RE-severs and
  // never resurrects.
  const { membership } = memberRegistry.foldMembership(
    o.registryRepoDir,
    o.registryRoster,
    o.projectId,
  );
  if (!membership || membership.state !== "member") {
    return _noop(
      NOOP_NOT_MEMBER,
      `project '${o.projectId}' is not a current member (registry state '${membership ? membership.state : "unknown"}') — nothing to reconcile`,
    );
  }
  const admitHead = membership.head_hash;

  // Step 2 — LIVE pointer fetch (§5 step 2 / §6.2). Unfetchable → DEFER, write
  // nothing (§6.1.1 safety unconditional).
  const fetched = _fetchPointer(o.fetchPointerRecords);
  if (fetched.unfetchable) {
    return {
      disposition: DEFER,
      wrote: false,
      pointer: { unfetchable: true, reason: fetched.reason },
      reason: `DEFER — pointer unfetchable, no reconciliation write (safe-but-not-live; the §6.3 staleness query surfaces the long-deferred case): ${fetched.reason}`,
    };
  }

  // Step 3 — cond-2 verify against P's CURRENT roster (the injected records).
  const ptr = upstreamCanonPointer.verifyPointsAt(
    REMOTE_POINTER_MARKER,
    o.pointerRoster,
    o.ecosystemId,
    { reader: () => fetched.records },
  );

  // No verifying tip (empty chain / every signer revoked) — the
  // signing-identity-revocation axis (§4.2). NOT a recorded sever: caught live
  // at the §5 cond-2 verify (the head SUPPRESSES). The writer NOOPs (it has no
  // re-verifiable tip evidence to carry); an owner MAY separately `evicted`-sever.
  if (!ptr.tip) {
    return {
      disposition: NOOP_NO_TIP,
      wrote: false,
      pointer: ptr,
      reason:
        "NOOP — no verifying pointer tip (empty chain / signer revoked); the signing-identity-revocation axis is caught LIVE at the §5 cond-2 verify, NOT a recorded sever (§4.2). An owner MAY separately emit an evicted-sever.",
    };
  }

  const observedTip = _observedTipHash(ptr.tip);

  // Step 4 — classify + write.
  if (ptr.names_ecosystem === true) {
    // Tip still names E → fresh attestation (keeps the head fresh).
    const emit = _emit(o, {
      type: foldMemberRegistry.TYPE_RECONCILIATION,
      content: {
        project_id: o.projectId,
        observed_pointer_tip: observedTip,
        observed_names_this_ecosystem: true,
        observed_at: _observedAt(o.observedAt),
      },
    });
    return _writeResult(ATTESTED, emit, ptr, {
      type: foldMemberRegistry.TYPE_RECONCILIATION,
      observed_pointer_tip: observedTip,
    });
  }

  // The tip no longer names E → a sever. Both the withdrawn-tombstone and the
  // flip carry the SAME M3 evidence shape (observed_pointer_tip +
  // observed_names_this_ecosystem: false + supersedes_ref = the admitted head)
  // — the only difference is the `reason`. The fold ACCEPTS this sever on the
  // boolean alone (M3, fold-member-registry.js): it does NOT recompute the
  // hash against a live pointer. The anti-malicious-eviction guarantee against
  // a DISHONEST reconciler (one setting the boolean false on a loyal P) rests
  // on the §5 head's INDEPENDENT pointer re-fetch (membership-head.js step 2),
  // not on this write-side hash — a write-side observed_pointer_tip is
  // evidence-bearing, not self-authenticating (§4.3 M3 / §10 registry-equivocation
  // = detection-eventually, bounded-trust).
  const reason = ptr.withdrawn
    ? foldMemberRegistry.SEVER_REASON_WITHDRAWN
    : foldMemberRegistry.SEVER_REASON_POINTER_FLIP;
  const emit = _emit(o, {
    type: foldMemberRegistry.TYPE_MEMBERSHIP_SEVERED,
    content: {
      project_id: o.projectId,
      reason,
      observed_pointer_tip: observedTip,
      observed_names_this_ecosystem: false,
      supersedes_ref: admitHead,
    },
  });
  return _writeResult(
    ptr.withdrawn ? SEVERED_WITHDRAWN : SEVERED_FLIP,
    emit,
    ptr,
    {
      type: foldMemberRegistry.TYPE_MEMBERSHIP_SEVERED,
      reason,
      observed_pointer_tip: observedTip,
      supersedes_ref: admitHead,
    },
  );
}

function _emit(o, partial) {
  const emitFn = o.emit || memberRegistry.emitMemberRecord;
  return emitFn({
    repoDir: o.registryRepoDir,
    type: partial.type,
    content: partial.content,
    identity: o.identity,
    signingKeyPath: o.signingKeyPath,
  });
}

function _writeResult(disposition, emit, ptr, recordSummary) {
  const wrote = !!(emit && emit.ok);
  return {
    disposition,
    wrote,
    record: recordSummary,
    emit,
    pointer: ptr,
    reason: wrote
      ? `${disposition} — registry record written (${recordSummary.type})`
      : `${disposition} — emit FAILED (no record written): ${emit && emit.error ? emit.error : "unknown"} (${emit && emit.reason ? emit.reason : ""})`,
  };
}

function _noop(disposition, reason) {
  return { disposition, wrote: false, reason };
}

/**
 * §6.3 — the membership staleness backstop. Reports every CURRENT member whose
 * last reconciliation observation is older than `ttlMs` (default
 * MEMBERSHIP_RECONCILE_TTL) relative to `nowMs`, OR who has NEVER been
 * reconciled (no `last_observed_at`). Condition-agnostic + complete by
 * construction: every stale membership state is caught regardless of WHY
 * (provider unreachable, cadence stalled, partial-push lag), so a
 * never-completing reconciliation is detected-eventually and operator-visible,
 * never a silent indefinite trust of a stale TRUE.
 *
 * Reads the folded registry's per-project state directly (the `last_observed_at`
 * marker `foldReconciliationAttestation` accretes) — NOT
 * `computeMembershipState`, which intentionally omits the timestamp.
 *
 * @param {object} folded - the folded member registry (coordinationLog.foldLog
 *   over E's registry records).
 * @param {object} opts - { nowMs:number, ttlMs?:number }
 * @returns {Array<{ projectId, lastObservedAt:string|null, lastObservedAtMs:number|null,
 *   ageMs:number|null, neverObserved:boolean, futureObserved:boolean }>} the stale
 *   members (a member is stale when neverObserved OR ageMs > ttlMs OR
 *   futureObserved — a future-dated timestamp is fail-safe stale, never fresh).
 */
function findStaleMembers(folded, opts) {
  const o = opts || {};
  const nowMs = typeof o.nowMs === "number" ? o.nowMs : Date.now();
  const ttlMs =
    typeof o.ttlMs === "number" && o.ttlMs >= 0
      ? o.ttlMs
      : MEMBERSHIP_RECONCILE_TTL;
  const mr = folded && folded.foldState && folded.foldState.memberRegistry;
  const projects = (mr && mr.projects) || {};
  const stale = [];
  for (const [projectId, p] of Object.entries(projects)) {
    if (!p || p.state !== "member") continue; // severed/inert states are not "stale"
    const lastObservedAt =
      typeof p.last_observed_at === "string" ? p.last_observed_at : null;
    const lastObservedAtMs = lastObservedAt ? Date.parse(lastObservedAt) : NaN;
    // A member never reconciled (no parseable timestamp) is stale by
    // construction — the never-completing case §6.3 names.
    if (!lastObservedAt || Number.isNaN(lastObservedAtMs)) {
      stale.push({
        projectId,
        lastObservedAt: null,
        lastObservedAtMs: null,
        ageMs: null,
        neverObserved: true,
        futureObserved: false,
      });
      continue;
    }
    const ageMs = nowMs - lastObservedAtMs;
    // A NEGATIVE age = a future-dated `observed_at` (implausible — the fold
    // validates non-empty, not monotonicity/plausibility). It is treated as
    // STALE (fail-safe): a future timestamp must NOT suppress the §6.3 backstop
    // for an otherwise-stale member, so the completeness-by-construction claim
    // holds for implausible as well as old timestamps (`futureObserved` flags
    // it for operator diagnosis).
    if (ageMs < 0) {
      stale.push({
        projectId,
        lastObservedAt,
        lastObservedAtMs,
        ageMs,
        neverObserved: false,
        futureObserved: true,
      });
      continue;
    }
    if (ageMs > ttlMs) {
      stale.push({
        projectId,
        lastObservedAt,
        lastObservedAtMs,
        ageMs,
        neverObserved: false,
        futureObserved: false,
      });
    }
  }
  return stale;
}

/**
 * Build the LOCAL pointer reader (the single-clone / advisory / test
 * realization) — reads P's on-disk `upstream-canon.jsonl`. The production
 * caller injects a REMOTE reader instead (D6 resolveRemote + the W6 F122
 * provider ref-read), so reconciliation sees P's CURRENT remote tip rather
 * than a possibly-stale local mirror. Mirrors membership-head.js::
 * makeLocalReaders' pointer half. Throws on a non-ENOENT read error and returns
 * [] on ENOENT — exactly the throw=unfetchable / []=reachable-empty contract
 * `_fetchPointer` expects.
 */
function makeLocalPointerReader(projectRepoDir) {
  return () => upstreamCanonPointer.readUpstreamCanonLog(projectRepoDir);
}

module.exports = {
  reconcileMember,
  findStaleMembers,
  makeLocalPointerReader,
  MEMBERSHIP_RECONCILE_TTL,
  // Disposition constants.
  ATTESTED,
  SEVERED_FLIP,
  SEVERED_WITHDRAWN,
  DEFER,
  NOOP_NO_TIP,
  NOOP_NOT_MEMBER,
  NOOP_INVALID_ARGS,
  // Exposed for tests.
  _fetchPointer,
  _observedTipHash,
  REMOTE_POINTER_MARKER,
};
