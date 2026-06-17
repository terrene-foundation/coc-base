/**
 * capability-lease — per-CAPABILITY single-writer lease for build→build
 * dependency-edge registration (the §4.3 R3-L1 cross-emitter serialization).
 *
 * ECO-IMPL Wave 4, Shard W4-S4 (A2-T3a). Companion to capability-dag.js (the
 * acyclicity-at-registration gate that holds this lease around its
 * read-DAG → decide-acyclic → emit-edge window). Implements
 * `workspaces/ecosystem-operating-model/02-plans/08-capability-lifecycle.md`
 * §4.3 ("Serialized registration via a per-CAPABILITY lease (R3-L1)").
 *
 * WHY a per-CAPABILITY lease and NOT the per-emitter hash-chain (§4.3 F7):
 * the per-emitter chain totally-orders ONE emitter's records, but two
 * DIFFERENT emitters declaring edges into the SAME capability are not
 * mutually serialized by it — the check-then-act window (read DAG → decide
 * acyclic → append edge) stays OPEN across emitters. The per-capability lease
 * serializes that window for cross-emitter contention WITHIN ONE CLONE: the
 * second edge-declaration to ACQUIRE the lease sees the first folded edge and
 * is rejected if it now closes a cycle.
 *
 * CROSS-CLONE SCOPE (load-bearing honesty, §4.3 / §1.1 detection-eventually
 * law): this on-disk mutex lives under THIS clone's `.claude/learning/` and
 * does NOT travel — two operators on DIFFERENT clones each hold their own
 * lease file, so the mutex provides ZERO cross-clone serialization. Two
 * clones can each pass their clone-LOCAL acyclicity check against a stale
 * fold and emit `A→B` + `B→A` that together close a cycle. That cross-clone
 * cycle is NOT prevented here; it is caught DETECTION-EVENTUALLY at fold time
 * by the AUTHORITATIVE acyclicity backstop in
 * `fold-capability-ledger.js::foldDependencyEdge` (deterministic fold-order
 * forward-reachability rejects whichever edge closes the cycle, consistently
 * on every clone — so the folded DAG stays acyclic everywhere). This lease is
 * the OPTIMISTIC clone-local fast-path (reject early, avoid lease churn + a
 * bad emit); the fold predicate is the authoritative defense. The full
 * cross-clone-PREVENTION (a closure-ordered multi-lease + a signed cross-clone
 * lease-visibility record like codify-lease.js's) is W5 A2-T3b.
 *
 * SHAPE REUSE (per framework-first.md §substrate-reuse): this is NOT a second
 * lease MECHANISM — it MIRRORS the proven `codify-lease.js` shape (the on-disk
 * atomic-write mutex; `_leasePath` derived from repoDir via resolveStateDir,
 * Sec-MED-3; the `_safeReadJson` corruption sentinel; the typed
 * conflict-result that surfaces the holder; the deterministic scope
 * fingerprint) keyed on the CAPABILITY whose dependency set is mutated, with
 * its own lease file so a capability-edge lease and a codify lease never
 * collide. codify-lease.js stays codify-class-coupled (mandatory codify scope
 * files, branch-forcing, codify-lease record emission); reusing it directly
 * would force codify state files into an edge-registration scope and emit the
 * wrong record type — so the reuse is at the SHAPE level, which §4.3 R3-L1
 * names ("the codify-lease shape … keyed on the capability"). The reuse is
 * the ON-DISK MUTEX half ONLY — it does NOT include codify-lease.js's signed
 * `codify-lease`/`-release` coordination-log record (that record is what gives
 * codify-lease its CROSS-CLONE visibility per knowledge-convergence.md MUST-3;
 * this edge-lease deliberately omits it — see CROSS-CLONE SCOPE above — because
 * a signed record would give cross-clone visibility but not cross-clone
 * PREVENTION, and the fold-time acyclicity backstop is the real defense).
 *
 * SCOPE BOUNDARY (load-bearing — NOT W4-S4; W5 A2-T3b):
 *   - This is the SINGLE per-capability lease ONLY. The graduation
 *     transitive-closure CLOSURE-ordered MULTI-lease (the deadlock-free,
 *     blocking-bounded-wait acquisition of EVERY capability in a transitive
 *     closure, with closure-stability re-derivation) is W5 A2-T3b — NOT here.
 *   - CRASH-ORPHAN RESIDUAL (detection-eventually, W5-adjacent): the on-disk
 *     lease records `holder_id` + `acquired_at` but has NO PID-liveness / TTL
 *     reaper. A process crashing BETWEEN acquire and release leaves the lease
 *     permanently held (every subsequent edge registration in that repo returns
 *     `reason: "conflict"` until a manual clear). A TTL/PID-staleness reaper
 *     (mirroring the multi-operator §4.4 reap protocol) is W5-adjacent; until
 *     then the crash-orphan is a documented operational residual, not a silent
 *     gap. The IN-PROCESS exit paths (success / cycle-reject / conflict /
 *     error) ALL release via capability-dag.js's try/finally — only an
 *     out-of-process crash orphans the lease.
 *
 * Style: CommonJS, sync, pure node:fs / node:crypto, no external deps. Per
 * zero-tolerance.md Rule 3: every expected-failure path returns a typed
 * result; NEVER a throw on the conflict/dirty path, NEVER a silent fallback.
 *
 * Public API:
 *   acquireCapabilityLease({ capabilityId, holderId, repoDir? }) -> Result
 *     Result = { ok: true, lease: {...}, leasePath, capabilityId }
 *           | { ok: false, reason, error, conflicting?: {...} }
 *     reason ∈ { "conflict", "not-a-git-repo", "lease-corrupt",
 *                "invalid-capability-id", "invalid-holder-id" }
 *   releaseCapabilityLease({ capabilityId, holderId, repoDir? }) -> { ok, ... }
 *     reason ∈ { "no-lease", "already-released", "wrong-owner",
 *                "wrong-capability", "lease-corrupt", "not-a-git-repo",
 *                "invalid-capability-id", "invalid-holder-id" }
 *   readActiveCapabilityLease(capabilityId, repoDir?) -> { lease | null }
 *
 * The Result is the contract — callers (capability-dag.js) branch on `ok`,
 * surface the holder on conflict, and ALWAYS release on every exit path.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { resolveStateDir } = require("./state-resolver.js");

// One lease file per lease NAMESPACE; the capability key lives INSIDE the file
// (a single on-disk mutex, like codify-lease.json — exactly one edge-edit
// lease is active at a time per repo, keyed on the capability). A per-capability
// FILENAME would let two capabilities' leases race on directory creation; the
// single-file + capability-key-inside shape mirrors codify-lease.js's
// single-mutex discipline and makes the "is THIS capability leased?" check a
// pure folded read of one file.
const LEASE_FILE = "capability-edge-lease.json";

// ---------------------------------------------------------------------------
// MULTI-LEASE (W5 A2-T3b) — the closure-ordered MULTI-lease over a SET of
// capabilities, held SIMULTANEOUSLY.
//
// The single-edge LEASE_FILE above is ONE repo-wide mutex keyed on the
// capability INSIDE the file (only one capability lease is active at a time) —
// the right shape for the single-edge case, WRONG for a graduation that must
// hold the WHOLE transitive closure's leases at once. The multi-lease therefore
// uses a SEPARATE per-capability lease file scheme: ONE file per leased
// capability, `capability-mlease-<sha256(capabilityId)>.json`, so N distinct
// capabilities can each hold their own file simultaneously (the simultaneity
// the single-file mutex cannot give).
//
// Deadlock-freedom is structural: every multi-acquirer takes the leases of the
// union it needs in the SAME canonical `capability_id`-sorted total order. With
// a single global acquisition order there is no hold-and-wait cycle (Coffman's
// fourth condition is broken), so two acquirers contending on an overlapping
// closure can never deadlock — the later one BLOCKS (bounded-wait) on the first
// contended lease in sorted order and proceeds once it frees.
//
// "Blocking bounded-wait" in a node hook lib with NO event loop = a bounded
// retry/poll loop with a DEADLINE + backoff against the on-disk file mutex. The
// DEADLINE makes the wait provably terminate (the livelock surface IS a DoS
// surface per security.md — an unbounded wait is the DoS). The canonical order
// guarantees no deadlock; the deadline guarantees no infinite wait. This is the
// simplest correct shape; the bound is DOCUMENTED on acquireMultiLease's opts.
// ---------------------------------------------------------------------------

// Per-capability multi-lease filename prefix (distinct from LEASE_FILE so the
// single-edge mutex and the multi-lease scheme never collide on the same file).
const MULTILEASE_FILE_PREFIX = "capability-mlease-";

// Default bounded-wait parameters (the DoS-terminating bound). Conservative for
// a hook-lib context: a graduation's closure leases free quickly (the holding
// graduation is itself a bounded read/decide/emit window). Overridable per
// acquireMultiLease call so tests can inject a tight deadline.
const MULTILEASE_DEFAULT_DEADLINE_MS = 30000; // total wait budget across ALL leases
const MULTILEASE_DEFAULT_POLL_MS = 25; // initial backoff between contended-lease retries
const MULTILEASE_DEFAULT_MAX_POLL_MS = 250; // backoff ceiling (exponential, capped)

// ---- helpers (mirror codify-lease.js's proven shapes) ----------------------

function _isoTimestamp(now) {
  return (now || new Date()).toISOString();
}

/**
 * Validate a capability id / holder id token conservatively (mirror
 * codify-lease.js::_validateDisplayId — no shell metas, bounded length). The
 * capability id is the lease KEY and the holder id is the conflict-surfacing
 * attribution, so both must be safe to embed in the lease file + reason.
 */
function _validateToken(token, label) {
  if (typeof token !== "string" || !token) {
    return `${label} is required (non-empty string)`;
  }
  // The holderId is typically a `verified_id` — an SSH key fingerprint like
  // `SHA256:Yk…+jTR/…=` — so the allowlist MUST admit the base64 alphabet
  // (`+`, `/`, `=`) in ADDITION to capability-id-safe chars. The set is still
  // free of shell metas / whitespace / quotes (the embed-into-file + reason
  // safety this validator exists for).
  if (!/^[A-Za-z0-9._:+/=-]+$/.test(token)) {
    return `${label} '${token}' contains characters outside [A-Za-z0-9._:+/=-]`;
  }
  if (token.length > 200) {
    return `${label} '${token}' exceeds 200 chars`;
  }
  return null;
}

/** Deterministic capability-key fingerprint (cross-process equality check). */
function _capabilityFingerprint(capabilityId) {
  return crypto.createHash("sha256").update(capabilityId).digest("hex");
}

function _safeReadJson(p) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    // Corrupt JSON returns a sentinel so the caller can REFUSE (a corrupt
    // lease file is itself an audit failure) — never silently treated as
    // no-lease (zero-tolerance.md Rule 3).
    return { _corrupt: true, _error: String(e && e.message) };
  }
}

function _atomicWriteJson(p, obj) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmp, p);
}

function _gitToplevel(repoDir) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (e) {
    return null;
  }
}

/**
 * Derive the lease path from repoDir (Sec-MED-3): callers cannot supply a
 * leasePath argument to misroute the write to another file under
 * .claude/learning/. The path is ALWAYS the repo-derived one. Mirrors
 * codify-lease.js::_leasePath.
 */
function _leasePath(repoDir) {
  const stateDir = resolveStateDir(repoDir);
  return path.join(stateDir, LEASE_FILE);
}

/**
 * Derive the per-capability MULTI-lease path (Sec-MED-3, mirror of _leasePath):
 * repoDir-derived, never caller-supplied, so a caller cannot misroute the write.
 * The capability id is hashed into the filename so an id with path-unsafe chars
 * (already rejected by _validateToken, but defense-in-depth) can never escape
 * the state dir, and so every distinct capability gets its OWN file (the
 * simultaneity the single LEASE_FILE mutex cannot provide).
 */
function _multiLeasePath(capabilityId, repoDir) {
  const stateDir = resolveStateDir(repoDir);
  const fp = _capabilityFingerprint(capabilityId);
  return path.join(stateDir, `${MULTILEASE_FILE_PREFIX}${fp}.json`);
}

/**
 * Sort a set of capability ids into the CANONICAL acquisition order. The sort
 * is the deadlock-freedom primitive: every multi-acquirer takes the union of
 * shared leases in the SAME total order, so no hold-and-wait cycle can form.
 * Deduplicates (a closure may name a capability once; defensive against dup
 * input) and validates each token. Returns { ok, sorted } | { ok:false, ... }.
 */
function _canonicalCapabilityOrder(capabilityIds) {
  if (!Array.isArray(capabilityIds)) {
    return {
      ok: false,
      reason: "invalid-capability-set",
      error:
        "capabilityIds must be an array of non-empty capability-id strings",
    };
  }
  const seen = new Set();
  for (const id of capabilityIds) {
    const err = _validateToken(id, "capabilityId");
    if (err) {
      return { ok: false, reason: "invalid-capability-id", error: err };
    }
    seen.add(id);
  }
  // Deterministic total order — String.prototype.sort default lexicographic is
  // a total order over the validated token alphabet, identical on every clone.
  const sorted = [...seen].sort();
  return { ok: true, sorted };
}

// ---- public API ------------------------------------------------------------

/**
 * Acquire the per-CAPABILITY single-writer lease keyed on `capabilityId` (the
 * capability whose dependency set is about to be mutated — §4.3). On
 * conflict, surface the HOLDER and STOP (knowledge-convergence.md MUST-3 —
 * never silently proceed). Never throws on an expected-failure path.
 *
 * @param {object} opts - { capabilityId, holderId, repoDir? }
 */
function acquireCapabilityLease(opts) {
  const o = opts || {};
  const capabilityId = o.capabilityId;
  const holderId = o.holderId;
  const repoDir = o.repoDir || process.cwd();

  const capErr = _validateToken(capabilityId, "capabilityId");
  if (capErr) {
    return { ok: false, reason: "invalid-capability-id", error: capErr };
  }
  const holderErr = _validateToken(holderId, "holderId");
  if (holderErr) {
    return { ok: false, reason: "invalid-holder-id", error: holderErr };
  }

  const topLevel = _gitToplevel(repoDir);
  if (!topLevel) {
    return {
      ok: false,
      reason: "not-a-git-repo",
      error: `acquireCapabilityLease: ${repoDir} is not inside a git working tree`,
    };
  }

  const leasePath = _leasePath(topLevel);
  const existing = _safeReadJson(leasePath);
  if (existing && existing._corrupt) {
    return {
      ok: false,
      reason: "lease-corrupt",
      error: `acquireCapabilityLease: existing lease at ${leasePath} is unparseable: ${existing._error}`,
      path: leasePath,
    };
  }

  if (existing && !existing._released) {
    // Conflict: an edge-registration lease is already held. Surface the
    // holder + capability + STOP. A single on-disk mutex serializes edge
    // registration repo-wide (the cross-emitter window, F7); even when the
    // held lease is for a DIFFERENT capability, the second registrant waits
    // for release (the simplest correct serialization for the SINGLE-edge
    // case — the closure-aware multi-lease that would allow disjoint-capability
    // parallelism is W5 A2-T3b, NOT here).
    const sameCapability = existing.capability_id === capabilityId;
    return {
      ok: false,
      reason: "conflict",
      error:
        `acquireCapabilityLease: another edge-registration holds the lease ` +
        `(capability=${existing.capability_id}, holder=${existing.holder_id}, since=${existing.acquired_at}). ` +
        (sameCapability
          ? "Same capability — wait for the holder to release before mutating its dependency set."
          : "A different capability holds the single edge-registration lease; wait for release."),
      conflicting: {
        capability_id: existing.capability_id,
        holder_id: existing.holder_id,
        acquired_at: existing.acquired_at,
        lease_id: existing.lease_id,
        pid: existing.pid,
      },
    };
  }

  const acquiredAt = _isoTimestamp();
  const leaseId =
    `caplease_${Date.now()}_` + crypto.randomBytes(4).toString("hex");
  const lease = {
    lease_id: leaseId,
    capability_id: capabilityId,
    capability_fingerprint: _capabilityFingerprint(capabilityId),
    holder_id: holderId,
    acquired_at: acquiredAt,
    pid: process.pid,
    repo_top_level: topLevel,
    _released: false,
    _version: 1,
  };
  _atomicWriteJson(leasePath, lease);

  return { ok: true, lease, leasePath, capabilityId };
}

/**
 * Release a lease. Idempotent — releasing an already-released or missing lease
 * is a no-op (returns ok:true with a `noop` flag). The release REQUIRES the
 * holderId to match the active lease's holder_id AND the capabilityId to match
 * the leased capability (a different holder / capability cannot release this
 * lease). The leasePath is DERIVED from repoDir (Sec-MED-3) — a caller-supplied
 * leasePath field is ignored.
 *
 * @param {object} opts - { capabilityId, holderId, repoDir? }
 */
function releaseCapabilityLease(opts) {
  const o = opts || {};
  const capabilityId = o.capabilityId;
  const holderId = o.holderId;
  const repoDir = o.repoDir || process.cwd();

  const capErr = _validateToken(capabilityId, "capabilityId");
  if (capErr) {
    return { ok: false, reason: "invalid-capability-id", error: capErr };
  }
  const holderErr = _validateToken(holderId, "holderId");
  if (holderErr) {
    return { ok: false, reason: "invalid-holder-id", error: holderErr };
  }

  const topLevel = _gitToplevel(repoDir);
  if (!topLevel) {
    return {
      ok: false,
      reason: "not-a-git-repo",
      error: `releaseCapabilityLease: ${repoDir} is not inside a git working tree`,
    };
  }

  const leasePath = _leasePath(topLevel);
  const existing = _safeReadJson(leasePath);
  if (existing === null) {
    return { ok: true, noop: true, reason: "no-lease" };
  }
  if (existing && existing._corrupt) {
    return {
      ok: false,
      reason: "lease-corrupt",
      error: `releaseCapabilityLease: lease file is corrupt: ${existing._error}`,
    };
  }
  if (existing._released) {
    return { ok: true, noop: true, reason: "already-released" };
  }
  if (existing.capability_id !== capabilityId) {
    return {
      ok: false,
      reason: "wrong-capability",
      error:
        `releaseCapabilityLease: lease is held for capability ` +
        `'${existing.capability_id}'; cannot be released against '${capabilityId}'`,
    };
  }
  if (existing.holder_id !== holderId) {
    return {
      ok: false,
      reason: "wrong-owner",
      error:
        `releaseCapabilityLease: lease is held by '${existing.holder_id}'; ` +
        `cannot be released by '${holderId}'`,
    };
  }

  const released = Object.assign({}, existing, {
    _released: true,
    released_at: _isoTimestamp(),
    released_by_pid: process.pid,
  });
  _atomicWriteJson(leasePath, released);
  return { ok: true, lease: released };
}

/**
 * Inspect the current lease state for `capabilityId`. Returns `{ lease }`
 * (the active lease when held FOR this capability) or `{ lease: null }`.
 * Surfaces corruption explicitly so the caller can refuse rather than silently
 * treat a corrupt file as no-lease.
 */
function readActiveCapabilityLease(capabilityId, repoDir) {
  const rd = repoDir || process.cwd();
  const top = _gitToplevel(rd);
  if (!top) return { lease: null, reason: "not-a-git-repo" };
  const lp = _leasePath(top);
  const existing = _safeReadJson(lp);
  if (existing === null) return { lease: null, leasePath: lp };
  if (existing && existing._corrupt) {
    return {
      lease: null,
      leasePath: lp,
      reason: "lease-corrupt",
      error: existing._error,
    };
  }
  if (existing._released) {
    return { lease: null, leasePath: lp, reason: "released", last: existing };
  }
  // A held lease exists; report it only when it is FOR this capability.
  if (existing.capability_id !== capabilityId) {
    return {
      lease: null,
      leasePath: lp,
      reason: "held-for-other-capability",
      heldFor: existing.capability_id,
    };
  }
  return { lease: existing, leasePath: lp };
}

// ---------------------------------------------------------------------------
// MULTI-LEASE primitives (W5 A2-T3b)
// ---------------------------------------------------------------------------

/**
 * Try to acquire ONE per-capability multi-lease (the per-capability file). A
 * SINGLE non-blocking attempt — the blocking bounded-wait is the loop in
 * acquireMultiLease that calls this with backoff. Returns:
 *   { ok:true, lease } on acquire
 *   { ok:false, reason:"contended", holder } when another holder is active
 *   { ok:false, reason:<other> } on a non-retryable failure
 * Mirrors acquireCapabilityLease's typed shape, but on the per-capability file.
 */
function _tryAcquireOneMultiLease(capabilityId, holderId, topLevel) {
  const leasePath = _multiLeasePath(capabilityId, topLevel);
  // ATOMIC test-and-set via O_EXCL exclusive-create (fs flag "wx"). A plain
  // write-then-confirm is NOT a mutex — two processes can each read "no holder",
  // each write, and each confirm BEFORE the other's write lands, so both
  // believe they won (a TOCTOU mutual-exclusion failure). O_EXCL makes the
  // create itself the atomic test-and-set: the kernel guarantees exactly ONE
  // process's open(...,O_CREAT|O_EXCL) succeeds; every other gets EEXIST. The
  // lockfile's EXISTENCE is the lock; its content is attribution only.
  const acquiredAt = _isoTimestamp();
  const leaseId =
    `mlease_${Date.now()}_` + crypto.randomBytes(4).toString("hex");
  const lease = {
    lease_id: leaseId,
    kind: "multi",
    capability_id: capabilityId,
    capability_fingerprint: _capabilityFingerprint(capabilityId),
    holder_id: holderId,
    acquired_at: acquiredAt,
    pid: process.pid,
    repo_top_level: topLevel,
    _version: 1,
  };
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  let fd;
  try {
    // "wx" = O_WRONLY | O_CREAT | O_EXCL — atomic exclusive create.
    fd = fs.openSync(leasePath, "wx", 0o600);
  } catch (e) {
    if (e && e.code === "EEXIST") {
      // The lock is HELD by another acquirer. Read the holder for attribution
      // (best-effort; a corrupt/half-written holder file is still "contended").
      const existing = _safeReadJson(leasePath);
      return {
        ok: false,
        reason: "contended",
        holder:
          existing && !existing._corrupt
            ? {
                capability_id: existing.capability_id,
                holder_id: existing.holder_id,
                acquired_at: existing.acquired_at,
                lease_id: existing.lease_id,
                pid: existing.pid,
              }
            : null,
      };
    }
    return {
      ok: false,
      reason: "lease-io-error",
      error: `_tryAcquireOneMultiLease: open(O_EXCL) failed for ${leasePath}: ${e && e.message ? e.message : String(e)}`,
      path: leasePath,
    };
  }
  // We won the atomic create. Write the attribution content + close.
  // If the write fails (e.g. ENOSPC) AFTER the O_EXCL create, we own a lockfile
  // that was never populated — unlink it before returning so the just-created
  // lock is not orphaned in-process (the O_EXCL model would otherwise leave a
  // permanent EEXIST for the next acquirer; the prior `finally`-only close left
  // the empty lockfile on disk — MED-1, eco-w5 R1 reviewer). This makes the
  // module's "only an out-of-process crash orphans" residual claim accurate.
  try {
    fs.writeFileSync(fd, JSON.stringify(lease, null, 2) + "\n", {
      encoding: "utf8",
    });
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch (_) {
      /* fd may already be closed; the unlink below is the load-bearing cleanup */
    }
    try {
      fs.unlinkSync(leasePath);
    } catch (_) {
      /* best-effort: a concurrent reaper may have removed it */
    }
    return {
      ok: false,
      reason: "lease-io-error",
      error: `_tryAcquireOneMultiLease: write failed for ${leasePath} (lockfile unlinked, no orphan): ${e && e.message ? e.message : String(e)}`,
      path: leasePath,
    };
  }
  fs.closeSync(fd);
  return { ok: true, lease, leasePath };
}

/**
 * Release ONE per-capability multi-lease held by holderId. Idempotent. Returns
 * { ok, ... } with the same release semantics as releaseCapabilityLease.
 */
function _releaseOneMultiLease(capabilityId, holderId, topLevel) {
  const leasePath = _multiLeasePath(capabilityId, topLevel);
  // With O_EXCL-create locking, the lock IS the file's existence — so RELEASE
  // is UNLINK (delete the lockfile), not a `_released` flag flip. (A flag flip
  // would leave the file present, so the next O_EXCL create would EEXIST and
  // the lease could never be re-acquired — a permanent self-deadlock.)
  const existing = _safeReadJson(leasePath);
  if (existing === null) {
    return { ok: true, noop: true, reason: "no-lease", capabilityId };
  }
  if (existing && existing._corrupt) {
    // A corrupt/half-written lockfile: we cannot verify ownership. Refuse to
    // delete another holder's lock (zero-tolerance.md Rule 3 — surface, don't
    // silently clobber). The on-disk file is the source of truth.
    return {
      ok: false,
      reason: "lease-corrupt",
      error: `_releaseOneMultiLease: lockfile corrupt, cannot verify ownership before unlink: ${existing._error}`,
      capabilityId,
    };
  }
  if (existing.capability_id !== capabilityId) {
    return {
      ok: false,
      reason: "wrong-capability",
      error: `_releaseOneMultiLease: lock held for '${existing.capability_id}', not '${capabilityId}'`,
      capabilityId,
    };
  }
  if (existing.holder_id !== holderId) {
    return {
      ok: false,
      reason: "wrong-owner",
      error: `_releaseOneMultiLease: lock held by '${existing.holder_id}', not '${holderId}'`,
      capabilityId,
    };
  }
  try {
    fs.unlinkSync(leasePath);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      // Already gone (a concurrent reaper or a prior release) — idempotent.
      return { ok: true, noop: true, reason: "already-released", capabilityId };
    }
    return {
      ok: false,
      reason: "lease-io-error",
      error: `_releaseOneMultiLease: unlink failed for ${leasePath}: ${e && e.message ? e.message : String(e)}`,
      capabilityId,
    };
  }
  return { ok: true, capabilityId };
}

/**
 * Release EVERY held multi-lease in a set, on EVERY exit path (success,
 * cycle-reject, growth-retry, error) — the inv-v "no orphan lease" primitive.
 * Releases in REVERSE canonical order (LIFO) for symmetry, but order does not
 * matter for release (release never blocks). NEVER throws — collects per-lease
 * results so a single bad release cannot orphan the rest (zero-tolerance.md
 * Rule 3: every failure surfaced, never silently swallowed).
 *
 * @param {string[]} capabilityIds - the set to release (need not be sorted).
 * @param {string}   holderId
 * @param {string}   repoDir
 * @returns {{ ok:boolean, released:string[], failed:Array<{capabilityId,reason,error}> }}
 *   `ok` is true iff every lease released cleanly (noop counts as released).
 */
function releaseMultiLease(capabilityIds, holderId, repoDir) {
  const rd = repoDir || process.cwd();
  const topLevel = _gitToplevel(rd);
  if (!topLevel) {
    return {
      ok: false,
      released: [],
      failed: (capabilityIds || []).map((c) => ({
        capabilityId: c,
        reason: "not-a-git-repo",
        error: `releaseMultiLease: ${rd} is not inside a git working tree`,
      })),
    };
  }
  const ids = Array.isArray(capabilityIds) ? capabilityIds : [];
  const released = [];
  const failed = [];
  // Reverse order so a partially-acquired prefix unwinds LIFO.
  for (let i = ids.length - 1; i >= 0; i--) {
    const c = ids[i];
    let rel;
    try {
      rel = _releaseOneMultiLease(c, holderId, topLevel);
    } catch (err) {
      failed.push({
        capabilityId: c,
        reason: "release-threw",
        error: err && err.message ? err.message : String(err),
      });
      continue;
    }
    if (rel.ok) {
      released.push(c);
    } else {
      failed.push({ capabilityId: c, reason: rel.reason, error: rel.error });
    }
  }
  return { ok: failed.length === 0, released, failed };
}

/**
 * Acquire the multi-lease over a SET of capability ids, in CANONICAL
 * capability_id-sorted order, with BLOCKING bounded-wait on each contended
 * lease (NOT abort-on-contention — abort reintroduces contention-starvation
 * livelock, R8/HIGH). Deadlock-free by the canonical order; the wait provably
 * terminates by the deadline (the DoS bound).
 *
 * On a deadline-exceeded wait OR a non-retryable failure mid-acquisition, this
 * RELEASES every lease already held in this call (no orphan — inv v) and
 * returns a typed failure. On success the caller OWNS the whole set and MUST
 * call releaseMultiLease on every exit path (success / cycle-reject /
 * growth-retry / error) — use try/finally.
 *
 * @param {object} opts
 *   - capabilityIds {string[]} REQUIRED — the closure to lease.
 *   - holderId      {string}   REQUIRED — holder attribution.
 *   - repoDir       {string?}  defaults to process.cwd().
 *   - deadlineMs    {number?}  total bounded-wait budget (default 30000ms).
 *                              The DOCUMENTED bound: a contended acquisition
 *                              waits AT MOST this long across ALL leases before
 *                              aborting-with-release. Guarantees termination.
 *   - pollMs        {number?}  initial backoff between contended retries.
 *   - maxPollMs     {number?}  backoff ceiling.
 *   - _now          {function?} injectable clock (Date.now) for deterministic
 *                              deadline tests.
 *   - _sleep        {function?} injectable busy-wait (default: a bounded spin)
 *                              so tests need not actually sleep.
 * @returns {{ ok:true, holderId, order:string[] }
 *          |{ ok:false, reason, error, ... }}
 *   `order` is the canonical sorted set the caller now holds (pass it verbatim
 *   to releaseMultiLease).
 */
function acquireMultiLease(opts) {
  const o = opts || {};
  const holderId = o.holderId;
  const repoDir = o.repoDir || process.cwd();
  const deadlineMs =
    typeof o.deadlineMs === "number" && o.deadlineMs > 0
      ? o.deadlineMs
      : MULTILEASE_DEFAULT_DEADLINE_MS;
  const pollMs =
    typeof o.pollMs === "number" && o.pollMs > 0
      ? o.pollMs
      : MULTILEASE_DEFAULT_POLL_MS;
  const maxPollMs =
    typeof o.maxPollMs === "number" && o.maxPollMs > 0
      ? o.maxPollMs
      : MULTILEASE_DEFAULT_MAX_POLL_MS;
  const now = typeof o._now === "function" ? o._now : Date.now;
  const sleep =
    typeof o._sleep === "function"
      ? o._sleep
      : (ms) => {
          // Bounded synchronous spin-wait (no event loop in a hook lib). The
          // deadline above bounds total time; this just yields the poll gap.
          const until = now() + ms;
          while (now() < until) {
            /* spin */
          }
        };

  const holderErr = _validateToken(holderId, "holderId");
  if (holderErr) {
    return { ok: false, reason: "invalid-holder-id", error: holderErr };
  }
  const ordered = _canonicalCapabilityOrder(o.capabilityIds);
  if (!ordered.ok) return ordered;
  // An empty closure is a valid (trivial) acquisition — the caller holds
  // nothing and releaseMultiLease([]) is a clean no-op.
  if (ordered.sorted.length === 0) {
    return { ok: true, holderId, order: [] };
  }

  const topLevel = _gitToplevel(repoDir);
  if (!topLevel) {
    return {
      ok: false,
      reason: "not-a-git-repo",
      error: `acquireMultiLease: ${repoDir} is not inside a git working tree`,
    };
  }

  const order = ordered.sorted;
  const held = [];
  const deadline = now() + deadlineMs;

  for (const capabilityId of order) {
    let backoff = pollMs;
    // Blocking bounded-wait on THIS lease (canonical order guarantees no
    // deadlock; deadline guarantees termination).
    for (;;) {
      let res;
      try {
        res = _tryAcquireOneMultiLease(capabilityId, holderId, topLevel);
      } catch (err) {
        // Unexpected throw mid-acquire — release the prefix, surface typed.
        releaseMultiLease(held, holderId, topLevel);
        return {
          ok: false,
          reason: "error",
          error: `acquireMultiLease: unexpected error acquiring '${capabilityId}': ${err && err.message ? err.message : String(err)}`,
          held: held.slice(),
        };
      }
      if (res.ok) {
        held.push(capabilityId);
        break; // acquired this lease; advance to the next in canonical order
      }
      if (res.reason !== "contended") {
        // Non-retryable (corrupt) — release the prefix, surface typed.
        releaseMultiLease(held, holderId, topLevel);
        return {
          ok: false,
          reason: res.reason,
          error: res.error,
          capabilityId,
          held: held.slice(),
        };
      }
      // Contended → BLOCK (bounded-wait). Check the deadline BEFORE sleeping so
      // the wait provably terminates (the DoS bound).
      if (now() >= deadline) {
        releaseMultiLease(held, holderId, topLevel);
        return {
          ok: false,
          reason: "deadline-exceeded",
          error: `acquireMultiLease: bounded-wait deadline (${deadlineMs}ms) exceeded waiting for lease on '${capabilityId}' (held by ${res.holder ? res.holder.holder_id : "unknown"}); released ${held.length} already-held lease(s)`,
          capabilityId,
          contendingHolder: res.holder,
        };
      }
      sleep(Math.min(backoff, maxPollMs, Math.max(1, deadline - now())));
      backoff = Math.min(backoff * 2, maxPollMs); // exponential backoff, capped
    }
  }

  return { ok: true, holderId, order };
}

module.exports = {
  acquireCapabilityLease,
  releaseCapabilityLease,
  readActiveCapabilityLease,
  // Multi-lease (W5 A2-T3b) — the closure-ordered MULTI-lease.
  acquireMultiLease,
  releaseMultiLease,
  MULTILEASE_FILE_PREFIX,
  LEASE_FILE,
  // Test-only — NOT part of the supported API.
  _test_capabilityFingerprint: _capabilityFingerprint,
  _test_validateToken: _validateToken,
  _test_canonicalCapabilityOrder: _canonicalCapabilityOrder,
  _test_multiLeasePath: _multiLeasePath,
};
