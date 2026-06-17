/**
 * capability-retirement — the §4.4 retirement-FIRING fold (the monotonic
 * re-fold predicate) + the §4.5 defer/retry liveness discipline + the §6
 * condition-agnostic aging-query.
 *
 * ECO-IMPL Wave 5, Shard S2 (A2-T4) — the A2 KEYSTONE (08 §7). Implements
 * `workspaces/ecosystem-operating-model/02-plans/08-capability-lifecycle.md`
 * §4.4 (the retirement predicate as a monotonic re-fold) + §4.5 (defer/retry
 * liveness) + §6 (the aging query); normative `specs/06 §5`/`06 §7`.
 *
 * ECO-IMPL Wave 5, Shard S3 (A2-T5 — the WIRE) ADDS, at the tail of this file:
 *   - `driveRetirementRefold` — the LIVE fold→retire→re-fold driver that makes
 *     the otherwise-inert `retirementRefoldPass` fire `retired` END-TO-END
 *     against the on-disk ledger (consuming the W4-registered default fold; it
 *     does NOT touch coordination-log.js — the predicates are already
 *     registered). Discharges T4's carried-forward "register the pass into the
 *     fold loop" obligation.
 *   - `projectSeverToLedger` — the §5 S3 migration-sever projection: emit a
 *     `ledger-membership-severed` for a reconciliation-severed project so its
 *     open workarounds are suppressed (cond-4), disclosure-isolated to the
 *     SOURCE ledger.
 * Both route every emit through `capability-ledger.js::emitLedgerRecord` (the
 * §4.2 T0–T7 emission seam — no hand-built JSONL, knowledge-convergence.md MUST,
 * invariant i). The literal wiring of T0–T6 emissions into phase-command
 * surfaces is the DEFERRED pipeline (08 §3 G3.4 / artifact-flow.md D4), not T5.
 *
 * THE PREDICATE IS A MONOTONIC RE-FOLD, NOT A ONE-SHOT APPEND-TRIGGER (§4.4 /
 * F2). On EVERY fold step, `retirementRefoldPass` re-evaluates the predicate
 * for EVERY open (not-yet-`retired`) `(X, P)` `workaround-registered`. There is
 * NO materialized "currently-deferred conditions" index (MED-2) — the four
 * conditions are recomputed FRESH from folded state each step (via
 * `fold-capability-ledger.js::projectOpenWorkarounds` + the read-side helpers).
 * When ALL FOUR hold, the pass FIRES a `retired` record for the matching
 * workaround through `capability-ledger.js::emitLedgerRecord` (→ coc-emit.js;
 * NEVER hand-built JSONL — knowledge-convergence.md MUST). The fire is a ledger
 * fold consequence, not a human action; it is IDEMPOTENT (re-firing a `retired`
 * for an already-retired workaround is a no-op — the open-set excludes retired
 * workarounds and `foldRetired` is a monotone flip, F-NEW-3).
 *
 * THE FOUR CONDITIONS (§4.4; ALL must hold to FIRE; any DEFER withholds):
 *
 *   1. BOTH LINEAGES — `cascade-fired` landed for `(X,P)` on BOTH `code` AND
 *      `artifact` (`projectDualLineage`'s `fully_cascaded`). A code-only or
 *      artifact-only cascade does NOT retire.
 *   2. REBOUND + PER-LINEAGE LANDING GATE — DEFER if `supersedes_when` is not
 *      yet the stage-2 `{capability_id, min_satisfying_version}` (a
 *      `supersedes-rebind` has not folded — NEVER gate on an absent bound).
 *      Once rebound: the CODE lineage gates on `cascade-fired.version_or_sync_ref`
 *      (semver) `>=` `min_satisfying_version`; the ARTIFACT lineage gates on
 *      content-ref IDENTITY (the `/sync` ref EQUALS the satisfying ref).
 *      "Meets" is per-lineage — NEVER a single cross-space compare (a semver
 *      string is incomparable with a `/sync` content ref).
 *   3. `migrated` LANDED — a `migrated` record exists for `(X,P)`.
 *   4. MEMBERSHIP PROVEN CURRENT, SEVER-AWARE — consume
 *      `cascade-gate.js::decideFromProof(membership-head.js::proveMembership(...))`;
 *      FIRE only on the PROVEN_MEMBER `allow`/`disposition`. PROVEN_SEVERED
 *      SUPPRESSES; DEFER (un-fetchable head) DEFERS. A clone that cannot prove
 *      P's state DEFERS, NEVER fires on a stale-TRUE read. We consume the
 *      `allow`/`disposition` ONLY — NEVER the raw head `pointer` sub-object
 *      (esp. `pointer.tip.ecosystem_id`): persisting it to any durable E-side
 *      surface is the `07 §8` stored-destination disclosure breach
 *      (G1-security consumer-contract, journal/0298). Additionally, once a
 *      `membership-severed` is folded for P (monotone), retirement is
 *      permanently SUPPRESSED for not-yet-fired cases; a `membership-severed`
 *      folded AFTER a legitimate `retired` does NOT revoke it (`retired`
 *      monotone, F-NEW-3 — the open-set already excludes the fired workaround).
 *
 * §4.5 LIVENESS: safety is UNCONDITIONAL — a deferred operation NEVER fires a
 * wrong result, it WITHHOLDS. Re-evaluation is the monotonic re-fold (run the
 * pass again at the next step). Termination is conditional on the blocking
 * primitive completing, and the condition is NAMED in the per-workaround
 * diagnostic (`deferred_cause` + `detail`). The blocking primitives are the
 * named records — `supersedes-rebind`, the second-lineage `cascade-fired`,
 * `migrated`, `membership-severed` — AND the out-of-band membership-head
 * fetch-completion (the §5 head re-fetch driving cond-4 from DEFER to a
 * verdict). The pass is re-invoked at the next fold OR when a head fetch
 * completes; both feed the SAME recomputation.
 *
 * §6 AGING QUERY: `agingQuery` reports every open `workaround-registered`
 * deferred past a fold-count / wall-clock threshold, COMPLETE-BY-CONSTRUCTION
 * over the base set (R9/MED) — the base is condition-AGNOSTIC (it catches EVERY
 * deferred retirement regardless of WHICH condition fails). Per-condition
 * diagnostics ((i) dormant-member, (ii) membership-proof-wait, (iii)
 * rebind-lag, (iv) partial-lineage) are an OPEN classification LAYERED over the
 * complete base — never a substitute for it.
 *
 * Style: CommonJS, sync, zero-dep beyond the shared lib. Matches the
 * fold-capability-ledger.js naming + `reject`/`extendCapabilityLedger`
 * conventions. Per zero-tolerance.md Rule 3: every path returns a typed
 * result; no silent fallback.
 */

"use strict";

const fcl = require("./fold-capability-ledger.js");
const capabilityLedger = require("./capability-ledger.js");
const cascadeGate = require("./cascade-gate.js");

// Retirement disposition constants (the per-workaround verdict the re-fold
// pass yields BEFORE the fire/no-op effect).
const FIRE = "FIRE"; // all four conditions hold → emit a `retired`
const SUPPRESS = "SUPPRESS"; // a `membership-severed` is folded (cond-4) — permanently withheld
const DEFER = "DEFER"; // a condition is not-yet-met; withhold + re-evaluate later

// The named blocking-primitive causes (§4.5 — termination condition is NAMED).
const CAUSE_NOT_REBOUND = "rebind-lag"; // cond-2: supersedes-rebind not folded
const CAUSE_PARTIAL_LINEAGE = "partial-lineage"; // cond-1: exactly one lineage cascaded
const CAUSE_VERSION_FLOOR = "version-floor-unmet"; // cond-2: code semver < min OR artifact ref mismatch
const CAUSE_NOT_MIGRATED = "dormant-member"; // cond-3: migrated absent (cascade present)
const CAUSE_MEMBERSHIP_WAIT = "membership-proof-wait"; // cond-4: head DEFER (un-fetchable)
const CAUSE_SEVERED = "membership-severed"; // cond-4: PROVEN_SEVERED / folded sever (suppress)

// ---------------------------------------------------------------------------
// Semver `>=` for the cond-2 CODE-lineage landing gate
// ---------------------------------------------------------------------------
/**
 * Parse a dotted numeric semver core ("1.2.3" → [1,2,3]); ignores any
 * pre-release / build suffix after the core (`-`/`+`). Returns null on a
 * non-parseable string (so the caller DEFERs rather than firing on a malformed
 * version — fail-safe).
 */
function _parseSemver(v) {
  if (typeof v !== "string" || !v) return null;
  const core = v.split("-")[0].split("+")[0];
  const parts = core.split(".");
  const nums = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(parseInt(p, 10));
  }
  if (nums.length === 0) return null;
  return nums;
}

/**
 * Semver `actual >= floor`. Returns false (NOT a throw) on either side
 * un-parseable — an un-parseable version is treated as "does not meet the
 * floor" so the retirement DEFERs rather than fires on garbage (fail-safe,
 * §4.5 safety-unconditional).
 */
function _semverGte(actual, floor) {
  const a = _parseSemver(actual);
  const f = _parseSemver(floor);
  if (!a || !f) return false;
  const len = Math.max(a.length, f.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] || 0;
    const fv = f[i] || 0;
    if (av > fv) return true;
    if (av < fv) return false;
  }
  return true; // equal
}

// ---------------------------------------------------------------------------
// The per-workaround retirement predicate (recomputed FRESH per open (X,P))
// ---------------------------------------------------------------------------
/**
 * Evaluate the §4.4 retirement predicate for ONE open workaround, FRESH from
 * folded state. Returns a typed verdict { disposition, cause?, detail, ... }.
 * This is the pure decision half — it performs ZERO writes (the FIRE effect is
 * applied by `retirementRefoldPass`). Cond-4's membership proof is supplied by
 * the caller (the pass injects `proveFn`) so a single head fetch is reused and
 * the disclosure-sensitive `pointer` sub-object NEVER reaches this module's
 * durable surface (we read `allow`/`disposition` only).
 *
 * @param {object} wk - one `projectOpenWorkarounds` entry.
 * @param {object} folded - the folded ledger (for cond-3 / cond-4 sever read).
 * @param {object} opts
 * @param {function} [opts.proveFn] - (project, need_fingerprint, capability_id)
 *   => a `proveMembership`-shaped proof (the §5 head). The pass injects this so
 *   cond-4 rests on a LIVE re-fetch (membership-head F1), never a stale read.
 *   ABSENT → cond-4 DEFERs (never fires on an absent/stale read; §4.5 safety).
 */
function evaluateRetirement(wk, folded, opts) {
  const o = opts || {};

  // cond-4 (monotone-suppression half, checked FIRST so a folded sever short-
  // circuits to SUPPRESS without paying a head fetch — the fail-safe direction):
  // once `membership-severed` is folded for P, retirement is permanently
  // withheld for this not-yet-fired workaround (a `retired` that ALREADY fired
  // is monotone and excluded from the open-set upstream, F-NEW-3).
  if (fcl.readLedgerSevered(folded, wk.project)) {
    return {
      disposition: SUPPRESS,
      cause: CAUSE_SEVERED,
      detail: `membership-severed folded for project '${wk.project}' — retirement permanently suppressed for not-yet-fired cases (§4.4 cond-4 monotone)`,
    };
  }

  // cond-2 (rebind half): DEFER if not yet rebound — NEVER gate on an absent
  // bound. The bound capability is the cond-1/cond-3 target.
  if (!wk.rebound || !wk.bound_capability_id) {
    return {
      disposition: DEFER,
      cause: CAUSE_NOT_REBOUND,
      detail: `supersedes_when has not reached the post-T3 {capability_id, min_satisfying_version} stage (a supersedes-rebind has not folded) — cond-2 DEFER, never gate on an absent bound (§4.4)`,
    };
  }

  const cap = wk.bound_capability_id;
  const cascade = wk.cascade || {
    code: null,
    artifact: null,
    migrated: false,
    fully_cascaded: false,
  };

  // cond-1 (both lineages): code-only / artifact-only does NOT retire.
  if (!cascade.fully_cascaded) {
    return {
      disposition: DEFER,
      cause: CAUSE_PARTIAL_LINEAGE,
      detail: `cascade-fired present on ${cascade.code ? "code" : cascade.artifact ? "artifact" : "neither"} lineage only for (${cap}, ${wk.project}) — cond-1 needs BOTH code AND artifact (§4.4)`,
    };
  }

  // cond-2 (per-lineage landing gate): CODE gates on semver >= floor; ARTIFACT
  // gates on content-ref IDENTITY. "Meets" is PER-LINEAGE — never a single
  // cross-space compare.
  const codeMeets = _semverGte(cascade.code, wk.min_satisfying_version);
  const artifactMeets = cascade.artifact === wk.min_satisfying_version;
  if (!codeMeets || !artifactMeets) {
    const parts = [];
    if (!codeMeets) {
      parts.push(
        `code lineage version '${cascade.code}' does NOT satisfy semver floor '${wk.min_satisfying_version}'`,
      );
    }
    if (!artifactMeets) {
      parts.push(
        `artifact lineage ref '${cascade.artifact}' is NOT identity-equal to the satisfying ref '${wk.min_satisfying_version}'`,
      );
    }
    return {
      disposition: DEFER,
      cause: CAUSE_VERSION_FLOOR,
      detail: `cond-2 per-lineage landing gate unmet: ${parts.join("; ")} (§4.4)`,
    };
  }

  // cond-3 (migrated landed).
  if (!fcl.readMigrated(folded, cap, wk.project)) {
    return {
      disposition: DEFER,
      cause: CAUSE_NOT_MIGRATED,
      detail: `no migrated record for (${cap}, ${wk.project}) — cond-3 DEFER (dormant member: cascade landed, migration not yet picked up) (§4.4)`,
    };
  }

  // cond-4 (membership PROVEN current, sever-aware) — the LIVE head re-fetch.
  // We consume decideFromProof's allow/disposition ONLY; the raw proof's
  // `pointer` (esp. pointer.tip.ecosystem_id) is NEVER read here and NEVER
  // persisted to any durable E-side surface (07 §8 stored-destination
  // disclosure breach; G1-security consumer-contract, journal/0298).
  if (typeof o.proveFn !== "function") {
    // A clone that cannot prove P's state DEFERS — never fires on a stale-TRUE
    // read (membership-head F1 + §4.5 safety-unconditional).
    return {
      disposition: DEFER,
      cause: CAUSE_MEMBERSHIP_WAIT,
      detail: `no membership-proof fetcher supplied — cond-4 DEFER (cannot PROVE P current; never fire on a stale/absent read) (§4.4 / §5 F1)`,
    };
  }
  const proof = o.proveFn(wk.project, wk.need_fingerprint, cap);
  const decision = cascadeGate.decideFromProof(proof);
  if (decision.disposition === cascadeGate.SUPPRESS) {
    return {
      disposition: SUPPRESS,
      cause: CAUSE_SEVERED,
      detail: `§5 head PROVEN_SEVERED for (${wk.project}) — cond-4 suppress (sever-aware, fail-safe single-sided exclusion)`,
    };
  }
  if (decision.allow !== true || decision.disposition !== cascadeGate.ALLOW) {
    return {
      disposition: DEFER,
      cause: CAUSE_MEMBERSHIP_WAIT,
      detail: `§5 head did not PROVE membership for (${wk.project}) (decision '${decision.disposition}') — cond-4 DEFER; withhold + re-evaluate when the head fetch completes (§4.5 termination condition NAMED: membership-head re-fetch)`,
    };
  }

  // ALL FOUR conditions hold → FIRE.
  return {
    disposition: FIRE,
    cause: null,
    detail: `all four §4.4 conditions hold for (${wk.workaround_ref} → ${cap}, ${wk.project}): both lineages cascaded + per-lineage landing met + migrated + PROVEN_MEMBER current`,
    by_capability_id: cap,
  };
}

// ---------------------------------------------------------------------------
// The monotonic re-fold pass (the §4.4 FIRING fold + integration point)
// ---------------------------------------------------------------------------
/**
 * Run the §4.4 retirement re-fold over a folded ledger: for EVERY open
 * (not-yet-`retired`) workaround, recompute the four conditions FRESH and FIRE
 * a `retired` record (via `emitLedgerRecord`) for every workaround whose
 * predicate holds. SUPPRESS/DEFER outcomes withhold (the §4.5 liveness
 * discipline) and are returned for the aging query + diagnostics.
 *
 * This is the integration point the fold loop wires in: condition-clearing
 * records (`supersedes-rebind`, `migrated`, the second-lineage `cascade-fired`,
 * `membership-severed`) AND the out-of-band membership-head fetch-completion
 * re-fold driver are picked up by re-invoking this pass at the next fold (each
 * re-invocation recomputes from current folded state — no cached index).
 *
 * The fire is IDEMPOTENT by construction: `projectOpenWorkarounds` excludes
 * already-retired workarounds, so a second pass over the SAME state re-fires
 * NOTHING for a workaround whose `retired` already folded (and a redundant emit
 * is a monotone `foldRetired` no-op even if the caller re-supplies the record).
 *
 * @param {object} folded - the folded ledger (`foldLedger(...).folded` shape).
 * @param {object} opts
 * @param {string} opts.repoDir - the ledger repo (for the `retired` emit).
 * @param {object} opts.identity - the emitter identity (per emitLedgerRecord).
 * @param {string} opts.signingKeyPath - the signing key (per emitLedgerRecord).
 * @param {function} [opts.proveFn] - the cond-4 §5 head proof fetcher
 *   (project, need_fingerprint, capability_id) => proveMembership-shaped proof.
 * @param {function} [opts.emitFn] - override for emitLedgerRecord (tests).
 * @returns {{
 *   fired: Array<{ workaround_ref, by_capability_id, project, emit }>,
 *   suppressed: Array<{ workaround_ref, cause, detail }>,
 *   deferred: Array<{ workaround_ref, cause, detail }>,
 *   errors: Array<{ workaround_ref, error }>,
 * }}
 */
function retirementRefoldPass(folded, opts) {
  const o = opts || {};
  const emit = o.emitFn || capabilityLedger.emitLedgerRecord;
  const open = fcl.projectOpenWorkarounds(folded);

  const fired = [];
  const suppressed = [];
  const deferred = [];
  const errors = [];

  for (const wk of open) {
    const verdict = evaluateRetirement(wk, folded, { proveFn: o.proveFn });
    if (verdict.disposition === SUPPRESS) {
      suppressed.push({
        workaround_ref: wk.workaround_ref,
        cause: verdict.cause,
        detail: verdict.detail,
      });
      continue;
    }
    if (verdict.disposition === DEFER) {
      deferred.push({
        workaround_ref: wk.workaround_ref,
        cause: verdict.cause,
        detail: verdict.detail,
      });
      continue;
    }
    // FIRE — emit a `retired` through the signed emitter (NEVER hand-built
    // JSONL; knowledge-convergence.md MUST). Content carries ONLY the
    // allowlisted retired fields (member_project / workaround_ref /
    // by_capability_id) — NO head pointer / ecosystem_id (07 §8 fence; the
    // CONTENT_FIELD_ALLOWLIST in fold-capability-ledger structurally rejects a
    // foreign field anyway, but we never construct one).
    const res = emit({
      repoDir: o.repoDir,
      type: capabilityLedger.TYPE_RETIRED,
      content: {
        member_project: wk.project,
        workaround_ref: wk.workaround_ref,
        by_capability_id: verdict.by_capability_id,
      },
      identity: o.identity,
      signingKeyPath: o.signingKeyPath,
    });
    if (!res || res.ok !== true) {
      errors.push({
        workaround_ref: wk.workaround_ref,
        error: (res && (res.reason || res.error)) || "emit failed",
      });
      continue;
    }
    fired.push({
      workaround_ref: wk.workaround_ref,
      by_capability_id: verdict.by_capability_id,
      project: wk.project,
      emit: res,
    });
  }

  return { fired, suppressed, deferred, errors };
}

// ---------------------------------------------------------------------------
// §6 aging query — condition-AGNOSTIC complete base + per-condition diagnostics
// ---------------------------------------------------------------------------
/**
 * The §6 aging query: report every OPEN `workaround-registered` (not-yet-
 * `retired`) deferred past a fold-count / wall-clock threshold, regardless of
 * WHICH condition fails (the COMPLETE-BY-CONSTRUCTION condition-AGNOSTIC base —
 * R9/MED). The base set is "every open workaround that did NOT FIRE this pass
 * AND is past threshold"; it is complete because it derives from the SAME open
 * set the re-fold pass walks (a workaround is open ⟺ it has not retired), so no
 * deferred retirement can hide from it by failing an un-enumerated condition.
 *
 * Layered over the complete base is the per-condition diagnostic classification
 * ((i) dormant-member, (ii) membership-proof-wait, (iii) rebind-lag, (iv)
 * partial-lineage) — an OPEN classification (a workaround may map to one named
 * cause, or to `other` when its DEFER cause is none of the four enumerated
 * diagnostics; `other` is what keeps the classification from silently dropping
 * a base member). The diagnostic is NEVER a substitute for the base — the base
 * stands alone as the completeness guarantee.
 *
 * Age is measured by fold-count (`deferCounts[workaround_ref]`, the number of
 * consecutive passes the workaround has deferred — the caller maintains it
 * across passes) AND/OR wall-clock (`firstSeen[workaround_ref]` epoch-ms). A
 * workaround is "aged" when EITHER threshold is exceeded (whichever the caller
 * supplies); supplying neither reports EVERY currently-deferred workaround
 * (threshold 0).
 *
 * @param {object} folded - the folded ledger.
 * @param {object} opts
 * @param {function} [opts.proveFn] - the cond-4 proof fetcher (so the
 *   classification can distinguish membership-proof-wait from a folded sever).
 * @param {object} [opts.deferCounts] - { [workaround_ref]: consecutive defer count }.
 * @param {object} [opts.firstSeen]   - { [workaround_ref]: epoch-ms first deferred }.
 * @param {number} [opts.foldCountThreshold] - aged when deferCount >= this.
 * @param {number} [opts.wallClockMs]  - aged when (now - firstSeen) >= this.
 * @param {number} [opts.now] - epoch-ms (defaults to Date.now()).
 * @returns {{
 *   base: Array<{ workaround_ref, project, deferred_cause, detail, defer_count, age_ms }>,
 *   byCause: { 'dormant-member': [...], 'membership-proof-wait': [...],
 *             'rebind-lag': [...], 'partial-lineage': [...], other: [...] },
 *   total: number,
 * }}
 */
function agingQuery(folded, opts) {
  const o = opts || {};
  const deferCounts = o.deferCounts || {};
  const firstSeen = o.firstSeen || {};
  const now = typeof o.now === "number" ? o.now : Date.now();
  const hasFoldThresh = typeof o.foldCountThreshold === "number";
  const hasWallThresh = typeof o.wallClockMs === "number";
  const foldThresh = hasFoldThresh ? o.foldCountThreshold : 0;
  const wallThresh = hasWallThresh ? o.wallClockMs : null;
  // When the caller supplies NEITHER threshold, the query reports EVERY
  // currently-deferred workaround (the complete base, no age gating) — the
  // "give me all pending retirement work" mode. When EITHER threshold is
  // supplied, a workaround surfaces only when that axis is exceeded.
  const surfaceAll = !hasFoldThresh && !hasWallThresh;

  const open = fcl.projectOpenWorkarounds(folded);

  const base = [];
  const byCause = {
    [CAUSE_NOT_MIGRATED]: [],
    [CAUSE_MEMBERSHIP_WAIT]: [],
    [CAUSE_NOT_REBOUND]: [],
    [CAUSE_PARTIAL_LINEAGE]: [],
    other: [],
  };

  for (const wk of open) {
    const verdict = evaluateRetirement(wk, folded, { proveFn: o.proveFn });
    // The base is condition-AGNOSTIC: every open workaround that did NOT FIRE.
    // (SUPPRESS is a terminal non-fire — a folded sever — and is NOT a
    // deferred retirement awaiting a primitive; it is excluded from the
    // aging base, which surfaces only WORK STILL PENDING. A SUPPRESS will
    // never fire, so it is not "aging".)
    if (verdict.disposition === FIRE || verdict.disposition === SUPPRESS) {
      continue;
    }

    const ref = wk.workaround_ref;
    const deferCount = deferCounts[ref] || 0;
    const ageMs = firstSeen[ref] ? Math.max(0, now - firstSeen[ref]) : 0;

    const agedByFold = hasFoldThresh && deferCount >= foldThresh;
    const agedByWall = hasWallThresh && ageMs >= wallThresh;
    // surfaceAll (no threshold supplied) reports the complete base; otherwise
    // EITHER supplied axis being met surfaces the workaround.
    if (!surfaceAll && !(agedByFold || agedByWall)) continue;

    const entry = {
      workaround_ref: ref,
      project: wk.project,
      deferred_cause: verdict.cause,
      detail: verdict.detail,
      defer_count: deferCount,
      age_ms: ageMs,
    };
    base.push(entry);

    // Layer the per-condition diagnostic over the complete base. An
    // unrecognized cause lands in `other` so the classification never drops a
    // base member (the OPEN-classification property).
    if (Object.prototype.hasOwnProperty.call(byCause, verdict.cause)) {
      byCause[verdict.cause].push(entry);
    } else {
      byCause.other.push(entry);
    }
  }

  return { base, byCause, total: base.length };
}

// ---------------------------------------------------------------------------
// T5 (A2-T5, W5-S3) — the LIVE fold→retire→re-fold driver (the WIRE surface)
// ---------------------------------------------------------------------------
/**
 * Drive the §4.4 retirement re-fold to a FIXPOINT against the on-disk ledger —
 * the live "fold → retire → re-fold" loop that makes `retirementRefoldPass`
 * (otherwise an inert callable) actually fire `retired` END-TO-END.
 *
 * W4 (`coordination-log.js::_registerM0Defaults`) already registers the §4.2
 * ledger fold predicates into the DEFAULT engine, so this driver does NOT touch
 * the fold engine — it CONSUMES the registered fold via
 * `capability-ledger.js::foldLedger` and runs the pass over the result. (T4's
 * carried-forward obligation — "until T5 registers the pass into the fold loop,
 * the §4.4 re-evaluated-on-EVERY-fold-step promise is not met" — is discharged
 * HERE: each driver invocation re-folds fresh and re-runs the pass, so every
 * condition-clearing record + every out-of-band membership-head fetch-completion
 * is picked up on the next drive. The driver is the re-fold loop; the §4.5
 * monotonic-re-fold is one invocation of it.)
 *
 * The loop: foldLedger → retirementRefoldPass (FIRES `retired` via the SAME
 * `emitLedgerRecord` → coc-emit.js signed-append path production uses — NEVER
 * hand-built JSONL, knowledge-convergence.md MUST) → re-fold (the just-emitted
 * `retired` records are now folded, removing those workarounds from the open
 * set) → re-run until a pass FIRES nothing (fixpoint). Retirement conditions are
 * per-workaround and independent (one workaround's `retired` never enables
 * another's), so iteration 1 fires every eligible workaround and iteration 2
 * fires zero — `maxIterations` is a defensive bound, not the expected depth.
 *
 * Invariant (iii, §6 / F9 / V5): `retired` is a LEDGER event, NOT a forced local
 * removal. The driver emits `retired` records into the ledger; it does NOT touch
 * any project's working tree, force a restart-and-pull, or remove a workaround
 * file. Local removal is the project's own T6 (`migrated`) responsibility. A
 * dormant member that never migrated shows `cascade-fired` WITHOUT `retired`
 * (cond-3 DEFER) and surfaces in `agingQuery`, never a forced action.
 *
 * Safety (§4.5 item-1): unconditional. A driver invocation only ever FIRES on
 * the FIRE verdict; every SUPPRESS/DEFER withholds. An emit failure is collected
 * into `errors` and does NOT corrupt folded state (the record simply did not
 * land); the next drive re-evaluates fresh.
 *
 * @param {string} repoDir - the ledger repo (the SOURCE ecosystem's ledger).
 * @param {object} roster - the roster the fold verifies signatures against.
 * @param {object} opts
 * @param {object} [opts.identity] - emitter identity (per emitLedgerRecord).
 * @param {string} [opts.signingKeyPath] - signing key (per emitLedgerRecord).
 * @param {function} [opts.proveFn] - the cond-4 §5 head proof fetcher
 *   (project, need_fingerprint, capability_id) => proveMembership-shaped proof.
 *   Absent → cond-4 DEFERs (never fires on a stale/absent read).
 * @param {function} [opts.emitFn] - override for emitLedgerRecord (tests that
 *   inject a disk-appending emitter; the default appends to the real ledger so
 *   the re-fold reads the fired records back).
 * @param {number} [opts.maxIterations=16] - defensive fixpoint bound.
 * @returns {{
 *   fired: Array<{ workaround_ref, by_capability_id, project, emit }>,
 *   suppressed: Array<{ workaround_ref, cause, detail }>,
 *   deferred: Array<{ workaround_ref, cause, detail }>,
 *   errors: Array<{ workaround_ref, error }>,
 *   iterations: number,
 *   boundHit: boolean,   // true iff the loop stopped on maxIterations while a
 *                        // pass was STILL firing (fixpoint NOT reached) — a
 *                        // pathological signal an automated caller MUST surface
 *                        // (observability.md Rule 5; unreachable in practice
 *                        // since retirements are per-workaround independent).
 *   folded: object,
 * }}
 */
function driveRetirementRefold(repoDir, roster, opts) {
  const o = opts || {};
  const maxIterations =
    typeof o.maxIterations === "number" && o.maxIterations > 0
      ? o.maxIterations
      : 16;

  const fired = [];
  let suppressed = [];
  let deferred = [];
  let errors = [];
  let iterations = 0;
  let boundHit = false;
  let folded = null;

  for (;;) {
    iterations += 1;
    // Re-fold fresh from disk: picks up every record emitted by a prior
    // iteration AND every condition-clearing record / out-of-band membership
    // fetch-completion since the last drive (no cached deferred-condition index,
    // MED-2).
    folded = capabilityLedger.foldLedger(repoDir, roster).folded;
    const pass = retirementRefoldPass(folded, {
      repoDir,
      identity: o.identity,
      signingKeyPath: o.signingKeyPath,
      proveFn: o.proveFn,
      emitFn: o.emitFn,
    });
    // The LAST pass's suppressed/deferred/errors describe the current frontier
    // (fired workarounds leave the open set, so they never re-appear in a later
    // pass's suppressed/deferred).
    suppressed = pass.suppressed;
    deferred = pass.deferred;
    errors = pass.errors;
    if (pass.fired.length > 0) fired.push(...pass.fired);
    // Fixpoint: a pass that fired nothing leaves the open set unchanged, so a
    // further iteration would be identical — stop. Also stop on the defensive
    // bound (and FLAG it: breaking on the bound while a pass is still firing
    // means fixpoint was not reached — a pathological signal, not a clean stop).
    if (pass.fired.length === 0) break;
    if (iterations >= maxIterations) {
      boundHit = true;
      break;
    }
  }

  // Final re-fold reflects every fire (the last iteration may have fired and
  // then broken on the bound without a confirming re-fold).
  folded = capabilityLedger.foldLedger(repoDir, roster).folded;

  return { fired, suppressed, deferred, errors, iterations, boundHit, folded };
}

// ---------------------------------------------------------------------------
// T5 (A2-T5, W5-S3) — the §5 S3 migration-sever ledger projection
// ---------------------------------------------------------------------------
/**
 * Project a §6.2/§5-S3 reconciliation SEVER for project P into the SOURCE
 * ecosystem's capability ledger: emit ONE `ledger-membership-severed` record so
 * P's still-open `workaround-registered` rows are MARKED severed in folded state
 * (retained as immutable history, never re-fired, never counted live — §5 S3 /
 * §6). Once folded, `fold-capability-ledger.js::readLedgerSevered` returns true
 * for P, and the §4.4 cond-4 monotone-suppression half (the FIRST check in
 * `evaluateRetirement`) permanently SUPPRESSES P's not-yet-fired retirements —
 * closing the F5/F6 disclosure breach (a stale pre-sever view firing a
 * retirement into a departed ecosystem). A `membership-severed` folded AFTER a
 * legitimate `retired` does NOT revoke it (`retired` monotone, F-NEW-3 — the
 * open-set already excludes the fired workaround).
 *
 * Disclosure isolation (invariant ii, §6): this function writes ONLY into the
 * SOURCE ledger (`repoDir`) — it has NO parameter for a client/destination
 * ledger and NO code path that copies P's rows across the ecosystem boundary.
 * The emitted content carries ONLY the three allowlisted fields
 * (`member_project` / `severed_at` / `pointer_flip_ref`); the
 * `fold-capability-ledger.js` CONTENT_FIELD_ALLOWLIST structurally REJECTS any
 * foreign-ecosystem field (e.g. an `ecosystem_id`), so a destination identity
 * cannot ride this record even by caller error. The returned
 * `suppressedWorkarounds` is a read-side list of the SOURCE ledger's own refs
 * (for caller diagnostics), never written elsewhere.
 *
 * Idempotent + monotone: if P is already folded-severed, this is a no-op
 * (`severed: false, alreadySevered: true`) — re-projecting a sever for an
 * already-severed project emits nothing.
 *
 * @param {string} repoDir - the SOURCE ecosystem's ledger repo.
 * @param {object} roster - the roster the fold verifies against.
 * @param {object} opts
 * @param {string} opts.project - the severed member project (→ member_project).
 * @param {string} opts.pointer_flip_ref - the reconciliation sever evidence ref
 *   (the membership-reconcile record hash / supersedes_ref that proves the
 *   pointer-flip / withdrawal). REQUIRED — never fabricate.
 * @param {string} [opts.severed_at] - ISO timestamp; defaults to now.
 * @param {object} [opts.identity] - emitter identity (per emitLedgerRecord).
 * @param {string} [opts.signingKeyPath] - signing key (per emitLedgerRecord).
 * @param {function} [opts.emitFn] - override for emitLedgerRecord (tests).
 * @returns {{ ok: boolean, severed?: boolean, alreadySevered?: boolean,
 *   suppressedWorkarounds?: string[], emit?: object, error?: string }}
 */
function projectSeverToLedger(repoDir, roster, opts) {
  const o = opts || {};
  if (typeof o.project !== "string" || !o.project) {
    return { ok: false, error: "projectSeverToLedger: opts.project required" };
  }
  if (typeof o.pointer_flip_ref !== "string" || !o.pointer_flip_ref) {
    return {
      ok: false,
      error:
        "projectSeverToLedger: opts.pointer_flip_ref required (the sever evidence ref; never fabricate)",
    };
  }
  const severedAt =
    typeof o.severed_at === "string" && o.severed_at
      ? o.severed_at
      : new Date().toISOString();
  const emit = o.emitFn || capabilityLedger.emitLedgerRecord;

  const folded = capabilityLedger.foldLedger(repoDir, roster).folded;

  // Idempotent + monotone: already severed → no-op (re-projecting emits nothing).
  if (fcl.readLedgerSevered(folded, o.project)) {
    return {
      ok: true,
      severed: false,
      alreadySevered: true,
      suppressedWorkarounds: [],
    };
  }

  // Read-side: the SOURCE ledger's own open rows this sever will suppress
  // (diagnostics only — NEVER copied across the ecosystem boundary).
  const suppressedWorkarounds = fcl
    .projectOpenWorkarounds(folded)
    .filter((wk) => wk.project === o.project)
    .map((wk) => wk.workaround_ref);

  const res = emit({
    repoDir,
    type: capabilityLedger.TYPE_MEMBERSHIP_SEVERED,
    content: {
      member_project: o.project,
      severed_at: severedAt,
      pointer_flip_ref: o.pointer_flip_ref,
    },
    identity: o.identity,
    signingKeyPath: o.signingKeyPath,
  });
  if (!res || res.ok !== true) {
    return {
      ok: false,
      error: (res && (res.reason || res.error)) || "emit failed",
      emit: res,
    };
  }
  return { ok: true, severed: true, suppressedWorkarounds, emit: res };
}

module.exports = {
  // The §4.4 re-fold pass (the FIRING fold + integration point).
  retirementRefoldPass,
  // T5 (W5-S3) — the LIVE fold→retire→re-fold driver + the §5 S3 sever
  // projection (the WIRE surface; both route emits through emitLedgerRecord).
  driveRetirementRefold,
  projectSeverToLedger,
  // The pure per-workaround predicate (FIRE/SUPPRESS/DEFER; no writes).
  evaluateRetirement,
  // The §6 aging query (condition-agnostic base + per-condition diagnostics).
  agingQuery,
  // Disposition + cause constants.
  FIRE,
  SUPPRESS,
  DEFER,
  CAUSE_NOT_REBOUND,
  CAUSE_PARTIAL_LINEAGE,
  CAUSE_VERSION_FLOOR,
  CAUSE_NOT_MIGRATED,
  CAUSE_MEMBERSHIP_WAIT,
  CAUSE_SEVERED,
  // Exposed for tests.
  _semverGte,
  _parseSemver,
};
