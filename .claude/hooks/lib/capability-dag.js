/**
 * capability-dag — build→build dependency DAG: single-edge acyclicity at
 * REGISTRATION + the per-capability lease (the §4.3 cross-emitter
 * serialization).
 *
 * ECO-IMPL Wave 4, Shard W4-S4 (A2-T3a). Implements
 * `workspaces/ecosystem-operating-model/02-plans/08-capability-lifecycle.md`
 * §4.3 ("Acyclicity at REGISTRATION" + "Serialized registration via a
 * per-CAPABILITY lease (R3-L1)" + the F7 cross-emitter window). Builds ON:
 *   - capability-ledger.js::emitLedgerRecord (emit the `dependency-edge`
 *     record) + foldLedger (read the folded DAG: edges at
 *     folded.foldState.capabilityLedger.edges).
 *   - capability-lease.js (the per-CAPABILITY single-writer lease — the same
 *     codify-lease.js SHAPE, keyed on the capability whose dep-set is mutated;
 *     framework-first.md §substrate-reuse, NOT a second lease mechanism).
 *
 * THE GATE (registerDependencyEdge, §4.3):
 *   1. Acquire the per-CAPABILITY lease keyed on `from` — the capability whose
 *      DEPENDENCY SET is mutated by adding `from → to` (an edge `from → to`
 *      means `from` depends on `to`, so `from`'s dep-set grows). The lease is
 *      the cross-emitter serialization the acyclicity check requires: the
 *      per-emitter hash-chain alone orders ONE emitter's records, but two
 *      DIFFERENT emitters declaring edges into the same capability are not
 *      mutually serialized (F7) — the lease closes that window.
 *   2. On lease conflict → typed { ok:false, reason:"conflict", conflicting }
 *      surfacing the holder; NEVER silently proceed
 *      (knowledge-convergence.md MUST-3 / zero-tolerance.md Rule 3).
 *   3. Read the folded DAG; compute whether adding `from → to` would CLOSE a
 *      cycle (a path already exists from `to` back to `from`,
 *      wouldCloseCycle). If YES → REJECT at WRITE time with
 *      { ok:false, reason:"cycle" } — a cycle is a CRITICAL ledger-integrity
 *      failure (§4.3), NOT a deferral.
 *   4. If acyclic → emit the `dependency-edge` record via
 *      capability-ledger.js::emitLedgerRecord.
 *   5. RELEASE the lease on EVERY exit path (success, cycle-reject, emit
 *      failure, error) — an orphaned lease is a DoS surface (security.md;
 *      inv iii).
 *
 * SCOPE BOUNDARY (load-bearing — NOT W4-S4; W5 A2-T3b):
 *   - NO graduation transitive-closure CLOSURE-ordered MULTI-lease (the
 *     deadlock-free blocking-bounded-wait acquisition of EVERY capability in a
 *     transitive closure + the closure-stability re-derivation loop).
 *   - NO multi-edge atomic graduation transaction. This builds the SINGLE
 *     per-capability lease + the SINGLE-edge cycle check the multi-lease later
 *     COMPOSES.
 *
 * Style: CommonJS, sync, zero-dep beyond the sibling libs. Per
 * zero-tolerance.md Rule 3: every path returns a typed result; no silent
 * fallback; the lease is released on error.
 */

"use strict";

const capabilityLedger = require("./capability-ledger.js");
const capabilityLease = require("./capability-lease.js");

// ---------------------------------------------------------------------------
// Pure graph helper — deterministic reachability over a folded edge set.
// ---------------------------------------------------------------------------
/**
 * Would adding the edge `from → to` close a cycle in `foldedDag`?
 *
 * An edge `from → to` (from depends on to) closes a cycle iff a directed path
 * ALREADY exists from `to` back to `from` over the existing edges — adding
 * `from → to` would then complete the loop `from → to → … → from`. A self-loop
 * (from === to) is itself a one-edge cycle.
 *
 * Deterministic forward DFS/BFS from `to` over the folded edges; returns true
 * the moment `from` is reached (or immediately for a self-loop). Pure: no I/O,
 * no lease, no emit — directly unit-testable.
 *
 * @param {{ edges: Array<{from_capability:string,to_capability:string}> }|
 *         Array<{from_capability:string,to_capability:string}>} foldedDag
 *   The folded DAG. Accepts either the capabilityLedger sub-tree
 *   ({ edges: [...] }) OR a bare edge array, so a caller may pass
 *   folded.foldState.capabilityLedger directly OR the edge list.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function wouldCloseCycle(foldedDag, from, to) {
  if (from === to) return true; // a self-loop is a one-edge cycle
  const edges = Array.isArray(foldedDag)
    ? foldedDag
    : (foldedDag && foldedDag.edges) || [];

  // Build an adjacency map: capability → [successors] (from → to direction).
  const adj = new Map();
  for (const e of edges) {
    if (!e || typeof e.from_capability !== "string") continue;
    if (!adj.has(e.from_capability)) adj.set(e.from_capability, []);
    adj.get(e.from_capability).push(e.to_capability);
  }

  // Reachability: is `from` reachable from `to`? If so, `from → to` closes a
  // cycle. Iterative BFS with a visited set (deterministic, no recursion-depth
  // limit, terminates because the visited set bounds the frontier).
  const visited = new Set();
  const queue = [to];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === from) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    const succ = adj.get(node);
    if (succ) {
      for (const n of succ) {
        if (!visited.has(n)) queue.push(n);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The registration gate.
// ---------------------------------------------------------------------------
/**
 * Register a build→build dependency edge `from → to` under the per-capability
 * lease + the single-edge acyclicity gate (§4.3).
 *
 * @param {object} opts
 *   - repoDir   {string}  REQUIRED — the ledger repo.
 *   - from      {string}  REQUIRED — depending capability (dep-set mutated).
 *   - to        {string}  REQUIRED — depended-on capability.
 *   - identity  {object?} signing identity forwarded to emitLedgerRecord.
 *   - holderId  {string?} lease holder attribution (defaults to identity's
 *                         verified_id, else "capability-dag").
 *   - roster    {object?} roster for the fold (forwarded to foldLedger;
 *                         defaults to reading from repoDir's roster file via
 *                         the caller — REQUIRED for a real fold).
 *   - ...rest forwarded to emitLedgerRecord (signingKeyPath, etc.).
 *
 * @returns {{ ok:true, record, leaseReleased:boolean }
 *          |{ ok:false, reason:"conflict", conflicting, error, leaseReleased }
 *          |{ ok:false, reason:"cycle", error, leaseReleased }
 *          |{ ok:false, reason:"emit-failed", emit, error, leaseReleased }
 *          |{ ok:false, reason:"args"|"fold-failed"|"lease-failed",
 *             error, leaseReleased }}
 *   `leaseReleased` is true on EVERY path that acquired the lease — the
 *   inv-iii receipt that no lease orphans (false ONLY when the lease was never
 *   acquired, e.g. an args error or a lease-acquire conflict).
 */
function registerDependencyEdge(opts) {
  const o = opts || {};
  const repoDir = o.repoDir;
  const from = o.from;
  const to = o.to;

  // --- arg validation (before any lease acquisition — no lease to leak) ----
  if (!repoDir || typeof repoDir !== "string") {
    return {
      ok: false,
      reason: "args",
      error: "registerDependencyEdge: repoDir must be a non-empty string",
      leaseReleased: false,
    };
  }
  if (!from || typeof from !== "string") {
    return {
      ok: false,
      reason: "args",
      error: "registerDependencyEdge: from must be a non-empty string",
      leaseReleased: false,
    };
  }
  if (!to || typeof to !== "string") {
    return {
      ok: false,
      reason: "args",
      error: "registerDependencyEdge: to must be a non-empty string",
      leaseReleased: false,
    };
  }
  // Validate BOTH capability ids against the SHARED token validator (uniform
  // contract — `from` reaches it again via the lease, but `to` is the BFS
  // target + the emitted record content and would otherwise be unvalidated;
  // sec R1 M1). Fail-closed before any lease acquisition (no lease to leak).
  for (const [val, label] of [
    [from, "from"],
    [to, "to"],
  ]) {
    const tokErr = capabilityLease._test_validateToken(val, label);
    if (tokErr) {
      return {
        ok: false,
        reason: "args",
        error: `registerDependencyEdge: ${tokErr}`,
        leaseReleased: false,
      };
    }
  }
  if (from === to) {
    // A self-loop is a one-edge cycle — REJECT before acquiring a lease (no
    // dep-set mutation is valid). The fold predicate also rejects it, but the
    // gate catches it up front so no lease churns for a guaranteed-cycle edge.
    return {
      ok: false,
      reason: "cycle",
      error: `registerDependencyEdge: from === to ('${from}') is a self-loop (a one-edge cycle is a CRITICAL ledger-integrity failure, REJECTED at write time)`,
      leaseReleased: false,
    };
  }

  // The lease is keyed on `from` — the capability whose DEPENDENCY SET is
  // mutated by adding `from → to` (§4.3 R3-L1).
  const leasedCapability = from;
  const holderId =
    o.holderId || (o.identity && o.identity.verified_id) || "capability-dag";

  // --- (1) acquire the per-capability lease --------------------------------
  const acq = capabilityLease.acquireCapabilityLease({
    capabilityId: leasedCapability,
    holderId,
    repoDir,
  });
  if (!acq.ok) {
    // (2) conflict / not-a-git-repo / corrupt / invalid — surface the holder,
    // STOP. No lease was acquired by THIS call, so nothing to release.
    if (acq.reason === "conflict") {
      return {
        ok: false,
        reason: "conflict",
        conflicting: acq.conflicting,
        error: acq.error,
        leaseReleased: false,
      };
    }
    return {
      ok: false,
      reason: "lease-failed",
      leaseReason: acq.reason,
      error: acq.error,
      leaseReleased: false,
    };
  }

  // From here the lease IS held — EVERY exit path below MUST release it (inv
  // iii). A try/finally guarantees release even if an unexpected throw occurs
  // inside the read/decide/emit window; the finally records whether the
  // release succeeded so the result can surface it.
  let leaseReleased = false;
  const release = () => {
    if (leaseReleased) return;
    const rel = capabilityLease.releaseCapabilityLease({
      capabilityId: leasedCapability,
      holderId,
      repoDir,
    });
    // A release failure is itself surfaced (zero-tolerance.md Rule 3 — never
    // a silent swallow); the on-disk lease is the source of truth. `ok` with
    // a noop is still a release.
    leaseReleased = rel.ok === true;
  };

  try {
    // --- (3) read the folded DAG + decide acyclicity ----------------------
    let folded;
    try {
      folded = capabilityLedger.foldLedger(repoDir, o.roster);
    } catch (err) {
      release();
      return {
        ok: false,
        reason: "fold-failed",
        error: `registerDependencyEdge: foldLedger threw: ${err && err.message ? err.message : String(err)}`,
        leaseReleased,
      };
    }
    const dag = (folded &&
      folded.folded &&
      folded.folded.foldState &&
      folded.folded.foldState.capabilityLedger) || { edges: [] };

    if (wouldCloseCycle(dag, from, to)) {
      // A cycle is a CRITICAL ledger-integrity failure — REJECT at write
      // time, NEVER defer/accept (§4.3). Release the lease (inv iii).
      release();
      return {
        ok: false,
        reason: "cycle",
        error: `registerDependencyEdge: adding '${from}' → '${to}' would close a cycle (a path already exists from '${to}' back to '${from}'); a cycle is a CRITICAL ledger-integrity failure, REJECTED at registration`,
        leaseReleased,
      };
    }

    // --- (4) acyclic → emit the dependency-edge record --------------------
    const emit = capabilityLedger.emitLedgerRecord(
      Object.assign({}, o, {
        repoDir,
        type: capabilityLedger.TYPE_DEPENDENCY_EDGE,
        content: { from_capability: from, to_capability: to },
        // Do NOT forward DAG-gate-only fields as emit opts.
        from: undefined,
        to: undefined,
        holderId: undefined,
        roster: undefined,
      }),
    );
    if (!emit.ok) {
      release();
      return {
        ok: false,
        reason: "emit-failed",
        emit,
        error: `registerDependencyEdge: emitLedgerRecord failed (step=${emit.step}): ${emit.error}${emit.reason ? ` — ${emit.reason}` : ""}`,
        leaseReleased,
      };
    }

    // --- (5) success → release the lease ----------------------------------
    release();
    return { ok: true, record: emit.record, leaseReleased };
  } catch (err) {
    // Any unexpected throw inside the window — release the lease (inv iii)
    // and surface the error typed (never a silent leak).
    release();
    return {
      ok: false,
      reason: "error",
      error: `registerDependencyEdge: unexpected error: ${err && err.message ? err.message : String(err)}`,
      leaseReleased,
    };
  }
}

// ---------------------------------------------------------------------------
// GRADUATION TRANSITIVE-CLOSURE MULTI-LEASE (W5 A2-T3b, §4.3 F4 + NEW-2)
//
// A graduation inherits a use-product's WHOLE transitive dependency set — many
// edges spanning MULTIPLE capabilities' lease domains — and registers them
// atomically under a CLOSURE-ordered MULTI-lease. This COMPOSES the SHIPPED W4
// single-edge primitives (the per-capability lease, the fold's edgeClosesCycle
// backstop); it does NOT re-author them.
// ---------------------------------------------------------------------------

/**
 * Compute the transitive closure of capabilities reachable through an inherited
 * edge-set, OVER the folded DAG's existing edges UNION the inherited edges. The
 * closure is the SET of every capability whose lease the graduation must hold:
 * every endpoint named in `inheritedEdges` PLUS every capability reachable from
 * any of those endpoints through the union graph (so a downstream dependency
 * pulled in transitively is leased too).
 *
 * The "union graph" = existing folded edges ∪ inherited edges. Reachability is
 * deterministic forward-BFS from every endpoint of every inherited edge; the
 * graduatedCapability is included as a seed (its OWN dep-set is being mutated).
 * Pure: no I/O, no lease — directly unit-testable.
 *
 * APPEND-ONLY MONOTONICITY (inv ii): the ledger never retracts an edge, so the
 * closure over the union is NON-DECREASING across re-derivations — it can grow
 * (a sibling emitter registered a new edge between snapshot and re-derive) but
 * never shrink. That bounds total re-snapshots at |capabilities-in-ecosystem|.
 *
 * @param {Array<{from_capability:string,to_capability:string}>} existingEdges
 * @param {Array<{from_capability:string,to_capability:string}>} inheritedEdges
 * @param {string} graduatedCapability
 * @returns {string[]} the closure as a SORTED array (canonical order — the same
 *   array the multi-lease acquisition consumes).
 */
function computeTransitiveClosure(
  existingEdges,
  inheritedEdges,
  graduatedCapability,
) {
  // Adjacency over the UNION graph (existing ∪ inherited).
  const adj = new Map();
  const addEdge = (e) => {
    if (!e || typeof e.from_capability !== "string") return;
    if (!adj.has(e.from_capability)) adj.set(e.from_capability, []);
    adj.get(e.from_capability).push(e.to_capability);
  };
  for (const e of existingEdges || []) addEdge(e);
  for (const e of inheritedEdges || []) addEdge(e);

  const closure = new Set();
  // Seed the BFS with the graduated capability + every endpoint of every
  // inherited edge — those are the capabilities the graduation directly
  // touches; transitive reachability extends to everything they depend on.
  const queue = [];
  if (typeof graduatedCapability === "string" && graduatedCapability) {
    queue.push(graduatedCapability);
  }
  for (const e of inheritedEdges || []) {
    if (e && typeof e.from_capability === "string" && e.from_capability) {
      queue.push(e.from_capability);
    }
    if (e && typeof e.to_capability === "string" && e.to_capability) {
      queue.push(e.to_capability);
    }
  }
  while (queue.length > 0) {
    const node = queue.shift();
    if (closure.has(node)) continue;
    closure.add(node);
    const succ = adj.get(node);
    if (succ) {
      for (const n of succ) {
        if (!closure.has(n)) queue.push(n);
      }
    }
  }
  return [...closure].sort(); // canonical sorted order
}

/**
 * Register a graduation's inherited edge-set ATOMICALLY under a CLOSURE-ordered
 * MULTI-lease (§4.3 F4 + NEW-2). Steps:
 *   (1) snapshot the inherited edge-set's transitive closure;
 *   (2) acquire the closure's leases in canonical order (blocking bounded-wait);
 *   (3) RE-DERIVE the transitive closure UNDER the held leases (F-NEW-1: a
 *       sibling emitter holding capability A's lease may have registered A→Q
 *       between snapshot and acquisition, pulling Q in unseen);
 *   (4) on detected closure GROWTH ONLY (never mere contention) → GENUINE
 *       abort-retry: release ALL held leases, re-snapshot the (larger) closure,
 *       re-acquire from scratch in canonical order (do NOT retain-and-extend —
 *       retention forfeits the single canonical order, the R7/HIGH-1 defect);
 *   (5) once the closure is STABLE under the freshly-held canonical-order
 *       leases, register the whole edge-set as ONE atomic transaction whose
 *       cycle-check runs over the UNION (via edgeClosesCycle) BEFORE any edge
 *       commits — never edge-by-edge. A cycle rejects the WHOLE set; no partial
 *       commit.
 *
 * Invariants (the redteam verifies each):
 *   (i)   deadlock-free — canonical capability_id acquisition order.
 *   (ii)  livelock-free — BLOCKING acquisition (bounded-wait); the SOLE
 *         abort-retry driver is detected closure GROWTH; APPEND-ONLY closure
 *         monotonicity bounds total re-snapshots at |closure-capabilities|.
 *   (iii) closure-stability precondition — the union cycle-check runs ONLY
 *         after re-derive-stable-under-held-leases.
 *   (iv)  atomic union registration — cycle check over the UNION before ANY
 *         edge commits; a cycle rejects the whole set; no partial commit.
 *   (v)   no orphan lease — every held lease released on every path (success,
 *         cycle-reject, growth-retry, error) via try/finally.
 *
 * @param {object} opts
 *   - repoDir            {string}   REQUIRED — the ledger repo.
 *   - graduatedCapability{string}   REQUIRED — the capability being graduated
 *                                   (its dep-set inherits the whole edge-set).
 *   - inheritedEdges     {Array<{from_capability,to_capability}>} REQUIRED —
 *                                   the use-product's whole transitive dep set.
 *   - identity           {object?}  signing identity forwarded to emit.
 *   - holderId           {string?}  multi-lease holder attribution.
 *   - roster             {object?}  roster for the fold.
 *   - maxResnapshots     {number?}  defensive cap on growth-retry iterations
 *                                   (default = closure size + 1; inv ii bounds
 *                                   it structurally, this is belt-and-suspenders
 *                                   against an unexpected non-monotone fold).
 *   - deadlineMs/pollMs/maxPollMs/_now/_sleep — forwarded to acquireMultiLease.
 *   - ...rest forwarded to emit per edge.
 *
 * @returns {{ ok:true, records:Array, closure:string[], resnapshots:number,
 *             leaseReleased:boolean }
 *          |{ ok:false, reason, error, leaseReleased, ... }}
 */
function registerGraduationEdgeSet(opts) {
  const o = opts || {};
  const repoDir = o.repoDir;
  const graduatedCapability = o.graduatedCapability;
  const inheritedEdges = o.inheritedEdges;

  // --- arg validation (before any lease acquisition) -----------------------
  if (!repoDir || typeof repoDir !== "string") {
    return {
      ok: false,
      reason: "args",
      error: "registerGraduationEdgeSet: repoDir must be a non-empty string",
      leaseReleased: false,
    };
  }
  if (!graduatedCapability || typeof graduatedCapability !== "string") {
    return {
      ok: false,
      reason: "args",
      error:
        "registerGraduationEdgeSet: graduatedCapability must be a non-empty string",
      leaseReleased: false,
    };
  }
  const gradErr = capabilityLease._test_validateToken(
    graduatedCapability,
    "graduatedCapability",
  );
  if (gradErr) {
    return {
      ok: false,
      reason: "args",
      error: `registerGraduationEdgeSet: ${gradErr}`,
      leaseReleased: false,
    };
  }
  if (!Array.isArray(inheritedEdges)) {
    return {
      ok: false,
      reason: "args",
      error:
        "registerGraduationEdgeSet: inheritedEdges must be an array of {from_capability,to_capability}",
      leaseReleased: false,
    };
  }
  // Validate every inherited edge's endpoints + reject any self-loop up front
  // (a self-loop is a one-edge cycle; the whole set rejects — atomic, inv iv).
  for (let i = 0; i < inheritedEdges.length; i++) {
    const e = inheritedEdges[i];
    if (!e || typeof e !== "object") {
      return {
        ok: false,
        reason: "args",
        error: `registerGraduationEdgeSet: inheritedEdges[${i}] must be a {from_capability,to_capability} object`,
        leaseReleased: false,
      };
    }
    for (const side of ["from_capability", "to_capability"]) {
      const v = e[side];
      const err = capabilityLease._test_validateToken(v, `inheritedEdges[${i}].${side}`);
      if (err) {
        return {
          ok: false,
          reason: "args",
          error: `registerGraduationEdgeSet: ${err}`,
          leaseReleased: false,
        };
      }
    }
    if (e.from_capability === e.to_capability) {
      return {
        ok: false,
        reason: "cycle",
        error: `registerGraduationEdgeSet: inheritedEdges[${i}] is a self-loop ('${e.from_capability}') — a one-edge cycle; the whole edge-set is REJECTED (atomic, no partial commit)`,
        leaseReleased: false,
      };
    }
  }

  const holderId =
    o.holderId ||
    (o.identity && o.identity.verified_id) ||
    "capability-dag-graduation";

  // Read the current folded edge-set (the snapshot basis). A helper so the
  // snapshot + every re-derive reads through ONE path.
  const readFoldedEdges = () => {
    const folded = capabilityLedger.foldLedger(repoDir, o.roster);
    const cl =
      folded &&
      folded.folded &&
      folded.folded.foldState &&
      folded.folded.foldState.capabilityLedger;
    return (cl && cl.edges) || [];
  };

  // --- (1) snapshot the inherited edge-set's transitive closure ------------
  let snapshotEdges;
  try {
    snapshotEdges = readFoldedEdges();
  } catch (err) {
    return {
      ok: false,
      reason: "fold-failed",
      error: `registerGraduationEdgeSet: snapshot fold threw: ${err && err.message ? err.message : String(err)}`,
      leaseReleased: false,
    };
  }
  let closure = computeTransitiveClosure(
    snapshotEdges,
    inheritedEdges,
    graduatedCapability,
  );

  // Defensive growth-retry cap (inv ii bounds re-snapshots structurally at the
  // closure size; this is belt-and-suspenders against a non-monotone fold).
  const maxResnapshots =
    typeof o.maxResnapshots === "number" && o.maxResnapshots > 0
      ? o.maxResnapshots
      : closure.length + 1;

  let heldOrder = null; // the canonical order currently held (for release).
  let resnapshots = 0;

  // release-all helper bound to the currently-held order; idempotent.
  let leaseReleased = true; // true while nothing is held
  const releaseHeld = () => {
    if (!heldOrder) return;
    const rel = capabilityLease.releaseMultiLease(heldOrder, holderId, repoDir);
    leaseReleased = rel.ok;
    heldOrder = null;
  };

  try {
    // --- (2)+(3)+(4) acquire → re-derive-under-held-leases → growth-retry --
    for (;;) {
      // (2) acquire the snapshotted closure's leases in canonical order
      // (blocking bounded-wait — NOT abort-on-contention).
      const acq = capabilityLease.acquireMultiLease({
        capabilityIds: closure,
        holderId,
        repoDir,
        deadlineMs: o.deadlineMs,
        pollMs: o.pollMs,
        maxPollMs: o.maxPollMs,
        _now: o._now,
        _sleep: o._sleep,
      });
      if (!acq.ok) {
        // Acquisition failed (deadline / corrupt / not-a-git-repo) — nothing of
        // OURS is held (acquireMultiLease released its own prefix), so no
        // orphan. Surface typed.
        leaseReleased = true;
        return {
          ok: false,
          reason: acq.reason,
          error: acq.error,
          contendingHolder: acq.contendingHolder,
          closure,
          resnapshots,
          leaseReleased: true,
        };
      }
      heldOrder = acq.order;
      leaseReleased = false;

      // (3) RE-DERIVE the transitive closure UNDER the held leases. A sibling
      // emitter could have appended an edge between our snapshot and our
      // acquisition (F-NEW-1); re-reading the fold WHILE holding the leases
      // gives the authoritative current closure.
      let rederivedEdges;
      try {
        rederivedEdges = readFoldedEdges();
      } catch (err) {
        releaseHeld();
        return {
          ok: false,
          reason: "fold-failed",
          error: `registerGraduationEdgeSet: re-derive fold threw: ${err && err.message ? err.message : String(err)}`,
          closure,
          resnapshots,
          leaseReleased,
        };
      }
      const rederived = computeTransitiveClosure(
        rederivedEdges,
        inheritedEdges,
        graduatedCapability,
      );

      // (4) GROWTH detection — closure GREW iff the re-derived set contains a
      // capability NOT in the currently-held set. (Append-only ⇒ never shrinks;
      // so "grew" ⟺ "re-derived ⊄ held" ⟺ some new capability appeared.)
      const heldSet = new Set(heldOrder);
      const grew = rederived.some((c) => !heldSet.has(c));
      if (grew) {
        // GENUINE abort-retry (do NOT retain-and-extend — retaining the prefix
        // while extending forfeits the single canonical acquisition order, the
        // R7/HIGH-1 deadlock-reintroducing defect). Release ALL held leases,
        // re-snapshot the (larger) closure, re-acquire from scratch.
        releaseHeld(); // releases every held lease (inv v)
        resnapshots += 1;
        if (resnapshots > maxResnapshots) {
          // Structural impossibility under append-only monotonicity; surface
          // typed rather than spin (the DoS bound — inv ii).
          return {
            ok: false,
            reason: "closure-unstable",
            error: `registerGraduationEdgeSet: closure failed to stabilize after ${resnapshots} re-snapshots (> bound ${maxResnapshots}); the fold is non-monotone (a ledger-integrity violation — edges must never retract)`,
            closure: rederived,
            resnapshots,
            leaseReleased: true,
          };
        }
        closure = rederived;
        continue; // re-acquire from scratch in canonical order
      }

      // STABLE: the re-derived closure ⊆ the held set. (If it's a strict subset
      // — a capability we leased turned out unreachable in the re-derive — we
      // still hold a superset, which is SAFE: holding MORE leases than strictly
      // needed never violates correctness, only over-conserves; the canonical
      // order still holds. We proceed with the stable closure under held
      // leases.) The closure-stability precondition (inv iii) is now met.
      break;
    }

    // --- (5) atomic UNION cycle-check, THEN commit the whole edge-set -------
    // The cycle-check runs over the UNION (existing folded edges ∪ the inherited
    // edges being added), BEFORE any edge commits — never edge-by-edge. We
    // re-read the authoritative folded edges UNDER the held, stable leases.
    let baseEdges;
    try {
      baseEdges = readFoldedEdges();
    } catch (err) {
      releaseHeld();
      return {
        ok: false,
        reason: "fold-failed",
        error: `registerGraduationEdgeSet: pre-commit fold threw: ${err && err.message ? err.message : String(err)}`,
        resnapshots,
        leaseReleased,
      };
    }

    // Build the union incrementally and test EACH inherited edge against the
    // accumulating union BEFORE committing ANY. The cycle predicate is
    // wouldCloseCycle (in this file) — byte-identical BFS reachability to the
    // fold's authoritative edgeClosesCycle backstop in fold-capability-ledger.js
    // (deterministic forward-reachability; same self-loop + duplicate-edge
    // semantics), so the gate's verdict matches the fold's on every clone WHILE
    // keeping this shard file-disjoint from T4's surface. A cycle ANYWHERE in
    // the set rejects the WHOLE set (atomic — inv iv); nothing committed.
    const unionEdges = baseEdges.slice();
    for (let i = 0; i < inheritedEdges.length; i++) {
      const e = inheritedEdges[i];
      if (
        wouldCloseCycle(unionEdges, e.from_capability, e.to_capability)
      ) {
        // Cycle in the union — REJECT THE WHOLE SET. No edge committed (we have
        // not emitted anything yet). Release the leases (inv v).
        releaseHeld();
        return {
          ok: false,
          reason: "cycle",
          error: `registerGraduationEdgeSet: inheritedEdges[${i}] ('${e.from_capability}' → '${e.to_capability}') closes a cycle in the UNION of existing + inherited edges; the WHOLE edge-set is REJECTED atomically (no partial commit) — a cycle is a CRITICAL ledger-integrity failure`,
          cyclingEdge: { from_capability: e.from_capability, to_capability: e.to_capability },
          resnapshots,
          leaseReleased,
        };
      }
      // Acyclic SO FAR — accumulate into the union for the next edge's check
      // (so an internal cycle WITHIN the inherited set is also caught).
      unionEdges.push({
        from_capability: e.from_capability,
        to_capability: e.to_capability,
      });
    }

    // The whole union is acyclic — commit every inherited edge. We are under the
    // held closure leases, so no sibling can interleave a cycle-closing edge
    // between our check and our commits.
    const records = [];
    for (let i = 0; i < inheritedEdges.length; i++) {
      const e = inheritedEdges[i];
      const emit = capabilityLedger.emitLedgerRecord(
        Object.assign({}, o, {
          repoDir,
          type: capabilityLedger.TYPE_DEPENDENCY_EDGE,
          content: {
            from_capability: e.from_capability,
            to_capability: e.to_capability,
          },
          // Do NOT forward gate-only fields as emit opts.
          graduatedCapability: undefined,
          inheritedEdges: undefined,
          holderId: undefined,
          roster: undefined,
          maxResnapshots: undefined,
          deadlineMs: undefined,
          pollMs: undefined,
          maxPollMs: undefined,
          _now: undefined,
          _sleep: undefined,
        }),
      );
      if (!emit.ok) {
        // An emit failed mid-commit. The union was verified acyclic, so this is
        // an infrastructure failure (signing/append), NOT a cycle. We have a
        // PARTIAL commit (records[0..i-1] landed). Surface typed with the
        // partial state + release leases. The fold's authoritative backstop
        // keeps the DAG acyclic regardless; the caller MUST treat this as a
        // failed graduation and re-drive. (We do NOT silently swallow — inv v +
        // zero-tolerance Rule 3.)
        releaseHeld();
        return {
          ok: false,
          reason: "emit-failed",
          error: `registerGraduationEdgeSet: emit failed on inheritedEdges[${i}] after committing ${records.length} edge(s): ${emit.error}${emit.reason ? ` — ${emit.reason}` : ""}`,
          emit,
          committedRecords: records,
          partialCommit: records.length > 0,
          resnapshots,
          leaseReleased,
        };
      }
      records.push(emit.record);
    }

    // --- success → release the whole multi-lease (inv v) -------------------
    releaseHeld();
    return {
      ok: true,
      records,
      closure: heldOrder ? heldOrder.slice() : closure,
      resnapshots,
      leaseReleased,
    };
  } catch (err) {
    // Any unexpected throw inside the held-lease window — release every held
    // lease (inv v) and surface typed (never a silent leak).
    releaseHeld();
    return {
      ok: false,
      reason: "error",
      error: `registerGraduationEdgeSet: unexpected error: ${err && err.message ? err.message : String(err)}`,
      resnapshots,
      leaseReleased,
    };
  }
}

module.exports = {
  registerDependencyEdge,
  wouldCloseCycle,
  // Graduation closure-ordered multi-lease (W5 A2-T3b).
  registerGraduationEdgeSet,
  computeTransitiveClosure,
};
