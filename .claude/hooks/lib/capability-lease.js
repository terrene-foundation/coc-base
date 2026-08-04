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
 *   - CRASH-ORPHAN: FIXED for BOTH leases now. The SINGLE-EDGE lease reclaims an
 *     aged-out record instead of wedging edge registration forever (§ liveness/
 *     TTL below); the MULTI-lease REAPS an aged-out O_EXCL lockfile instead of
 *     burning its full bounded wait and returning `deadline-exceeded` forever
 *     (§ multi-lease reaper below). The two reapers share ONE classifier but
 *     NOT one trigger shape: this lease releases by FLIPPING `_released`, the
 *     multi-lease releases by UNLINKING, so for the multi-lease the lockfile's
 *     EXISTENCE *is* the held state and there is no `_released` flag to consult.
 *     The IN-PROCESS exit paths (success / cycle-reject / conflict / error) ALL
 *     release via capability-dag.js's try/finally — only an out-of-process
 *     crash orphans either lease.
 *
 * Style: CommonJS, sync, pure node:fs / node:crypto, no external deps. Per
 * zero-tolerance.md Rule 3: every expected-failure path returns a typed
 * result; NEVER a throw on the conflict/dirty path, NEVER a silent fallback.
 *
 * Public API:
 *   acquireCapabilityLease({ capabilityId, holderId, repoDir? }) -> Result
 *     Result = { ok: true, lease: {...}, leasePath, capabilityId, reclaimed? }
 *           | { ok: false, reason, error, conflicting?: {...}, liveness? }
 *     reason ∈ { "conflict", "not-a-git-repo", "lease-corrupt",
 *                "invalid-capability-id", "invalid-holder-id" }
 *     `reclaimed` is present ONLY on a stale-lease takeover (§ liveness/TTL) and
 *     names the previous holder; `liveness` accompanies every `conflict` and
 *     explains WHY the lease is still held. Both are ADDITIVE — every
 *     pre-existing reason code and `conflicting` field is unchanged.
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
// LIVENESS / TTL — the crash-orphan reaper for the SINGLE-EDGE lease.
//
// THE DEFECT: acquire decided "another edge-registration holds the lease" on
// `existing && !existing._released` and nothing else. capability-dag.js releases
// on every in-process exit path via try/finally, so only an out-of-process crash
// orphans the lease — but when that happens the orphan is PERMANENT: every later
// edge registration in the repo returns `conflict` until a human deletes the
// file. A gate that cannot stop failing is worse than the race it prevents.
//
// THE SIGNAL — elapsed wall-clock since `acquired_at`, and nothing else.
//
// WHY NOT `pid`, even though it WOULD discriminate here. This is where this
// module's answer DIVERGES from codify-lease.js's, and the difference was
// MEASURED, not assumed. codify-lease's acquirer is a transient `node -e` helper
// that exits milliseconds after acquiring, so `process.kill(pid, 0)` returns
// ESRCH for a HEALTHY one-second-old lease exactly as it does for a crash
// orphan — the same output under both branches of the hypothesis, therefore not
// evidence (instrument-discipline.md MUST-1). Here the opposite holds: a healthy
// in-window lease probes ALIVE (measured: age=1081ms, pid alive) and a crash
// orphan probes DEAD(ESRCH), because registerDependencyEdge holds the lease
// only across one synchronous read-DAG → decide → emit window. pid IS
// discriminating for this module. It is still NOT the trigger, for two reasons:
//   (a) The PUBLIC API permits a CROSS-PROCESS hold. releaseCapabilityLease
//       matches on `holder_id` and never on pid, so a holder MAY legitimately
//       acquire in one process and release in another. capability-dag.js happens
//       to do both in one call frame; the contract does not require it, and a
//       pid reaper would steal that live lease.
//   (b) The record carries no process START-TOKEN. sessionend-release-lease.js
//       ::_classifyHolder pairs pid WITH a start-token precisely so a RECYCLED
//       pid is not misread as alive; without one, a pid-only reaper silently
//       fails to reap exactly when the pid recycled.
// A regression test locks that pid never becomes the reclaim trigger. If a
// future change adds a start-token AND narrows the API to same-process holds,
// pid+token becomes a strictly better PRIMARY signal with this TTL as backstop.
//
// THE FLOOR — 15 minutes. Sized for THIS lease's lifecycle, which is NOT
// codify-lease's session scope. A legitimate hold is one read-DAG →
// decide-acyclic → emit window: MEASURED at min 51ms / median 198ms / max 493ms
// across 25 registrations against a growing ledger. 15 minutes is ~1800x that
// worst case and 30x the module's own MULTILEASE_DEFAULT_DEADLINE_MS bounded
// wait, so it cannot plausibly steal a live lease; and it is short enough that a
// crashed registration self-heals within a break instead of wedging the repo for
// a working day. Copying codify-lease's 12h would have been wrong by ~50x — it
// is calibrated to a human session, and this lease has no human in it.
//
// FAIL-CLOSED ON AMBIGUITY: a MISSING, unparseable, non-string, or future-dated
// `acquired_at` all yield age = INDETERMINATE and the lease stays HELD. Only a
// positively-computed age at or past the floor reclaims, so this change can only
// ever refuse where the old code refused — except on the one proven-stale case.
// A corrupt lease file never reaches the classifier at all.
const CAPABILITY_LEASE_TTL_MS = 15 * 60 * 1000;

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

// ---------------------------------------------------------------------------
// MULTI-LEASE REAPER — the crash-orphan reaper for the O_EXCL lockfile.
//
// THE DEFECT, and why it was WORSE than the single-edge one. The lockfile's
// EXISTENCE is the lock and RELEASE is `unlink`, so there is no `_released`
// flag to consult — "is there a record?" IS "is it held?". Nothing reaped a
// lockfile whose holder died between acquireMultiLease and releaseMultiLease,
// so every later closure acquisition polled a lock that would never free for
// its FULL bounded-wait budget (30s by default) and then returned
// `deadline-exceeded`. Forever. The single-edge orphan at least failed FAST
// with `conflict`; this one charged 30 seconds per attempt to say the same
// thing. Fail-fast would have been more honest; a reaper is better than both.
//
// THE SIGNAL — elapsed wall-clock since `acquired_at`, exactly as the
// single-edge lease uses, through the SAME _classifyCapabilityLeaseLiveness
// classifier (one implementation, one place to change). The classifier reads
// only `acquired_at`, never `_released`, which is what lets it serve a
// flag-flip lease and an unlink lease unchanged.
//
// PLUS one signal the single-edge lease does not need: the filesystem MTIME,
// used ONLY when the lockfile's CONTENT is unreadable. An out-of-process crash
// BETWEEN openSync(...,"wx") and writeFileSync leaves a 0-BYTE lockfile that
// carries no `acquired_at` at all — the content signal is structurally absent,
// and without a fallback that exact orphan would stay permanent, i.e. the
// defect unfixed in its narrowest case. mtime is the only other timestamp the
// lockfile has; it is no weaker than `acquired_at` (both are wall-clock, both
// are forgeable by a local actor) and it is floored identically.
//
// WHY NOT `pid`, even though — unlike codify-lease — it DOES discriminate here.
// MEASURED for THIS lease, both arms, against the real multi-lease API:
//     ARM A (healthy lease, holder in-window): age=1038ms pid=80821 -> ALIVE
//     ARM B (crash orphan, holder exited):     age=20ms   pid=82659 -> DEAD(ESRCH)
// The falsifying result was nameable and was the thing being looked for: had
// ARM A printed DEAD(ESRCH), pid would be non-discriminating here exactly as it
// is for codify-lease's transient `node -e` acquirer, and that conclusion would
// transfer. It printed ALIVE. pid IS a discriminating signal for this lease. It
// is STILL not the trigger, for the same two reasons the single-edge lease
// records, both of which hold verbatim here:
//   (a) `_releaseOneMultiLease` matches on `holder_id` and NEVER on pid, so the
//       public contract permits a cross-process hold; a pid reaper would steal
//       that live lock.
//   (b) the lockfile carries no process START-TOKEN, so a RECYCLED pid reads as
//       alive and the reaper would silently fail to reap exactly when it
//       matters. (sessionend-release-lease.js::_classifyHolder pairs pid WITH a
//       token precisely for this.)
// Note pid could not even be used as a NARROWING conjunct ("stale AND pid
// dead"): that makes the reaper strictly LESS able to un-wedge — the recycled
// pid case is exactly where it would refuse — which is the wrong direction for
// a fix whose entire purpose is un-wedging.
//
// THE FLOOR — 15 minutes base, WIDENED to 2x the caller's declared wait budget
// when that budget is larger. The base matches the single-edge lease because
// the graduation body it protects is the same class of window (a bounded
// read-closure -> decide-acyclic -> emit). The scaling term is what the
// single-edge lease does NOT need: the FIRST lease in canonical order is held
// for the entire acquisition of the REST of the closure — up to deadlineMs —
// BEFORE the caller's body even starts. With the 30s default, 2x30s = 60s is
// far under the 15-min base and the term is inert; it only bites when a caller
// declares a wait budget over 7.5 min, which is precisely the case where a flat
// 15-min floor would be too tight and would reap a legitimately in-progress
// acquisition. What it CANNOT do: it scales on THIS acquirer's deadline, not on
// the (unrecorded) deadline the HOLDER used.
//
// FAIL-CLOSED ON AMBIGUITY, on every path: missing / unparseable / non-string /
// future-dated `acquired_at`, an unreadable lockfile whose mtime cannot be
// stat'ed, a lockfile that CHANGED or VANISHED between classify and unlink —
// all leave the lock HELD. Only a positively-computed age at or past the floor
// reaps, so this change can only ever refuse where the old code refused, except
// on the one positively-proven-stale case.
const MULTILEASE_TTL_MS = 15 * 60 * 1000;

// The floor never drops below `MULTILEASE_TTL_MS`, but widens to this multiple
// of the caller's own bounded-wait budget when that budget is the larger number.
const MULTILEASE_TTL_DEADLINE_FACTOR = 2;

// A reap frees the lock and the create is retried IMMEDIATELY (no sleep) — that
// is what removes the wait burn. This caps how many times one acquisition may
// reap the SAME capability, so a pathological clock (a forward jump larger than
// the floor makes every FRESH lockfile look stale) degrades into ordinary
// bounded contention instead of a no-sleep spin. The livelock surface is a DoS
// surface (security.md), and the deadline alone would bound the time but not the
// spin.
const MULTILEASE_MAX_REAPS_PER_LEASE = 3;

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
 * Classify an on-disk, un-released single-edge lease as HELD or STALE.
 *
 * Returns { state, age_ms, ttl_ms, basis } where:
 *   state ∈ "held" | "stale"
 *   age_ms   number when positively computed, else null (INDETERMINATE) — null
 *            is what keeps "could not compute" distinguishable from "computed
 *            as zero", which a plain 0 would silently merge.
 *   basis    a verbatim, quotable sentence naming WHY. It goes into the conflict
 *            error, the acquire result, and the on-disk `reclaimed_from`
 *            evidence, so a human reading any of the three sees one reason.
 *
 * The ONLY transition to "stale" is a positively-computed age >= ttlMs. Every
 * other path — no timestamp, non-string timestamp, unparseable timestamp,
 * future-dated timestamp — returns "held". See § liveness/TTL above for why
 * `lease.pid` is not consulted even though it would discriminate here.
 */
function _classifyCapabilityLeaseLiveness(lease, nowMs, ttlMs) {
  const ttl = typeof ttlMs === "number" ? ttlMs : CAPABILITY_LEASE_TTL_MS;
  const raw = lease && lease.acquired_at;
  if (typeof raw !== "string" || !raw) {
    return {
      state: "held",
      age_ms: null,
      ttl_ms: ttl,
      basis:
        "lease carries no acquired_at timestamp — age is INDETERMINATE, so the " +
        "lease is treated as HELD (fail-closed)",
    };
  }
  const acquiredMs = Date.parse(raw);
  if (!Number.isFinite(acquiredMs)) {
    return {
      state: "held",
      age_ms: null,
      ttl_ms: ttl,
      basis:
        `lease acquired_at '${raw}' is unparseable — age is INDETERMINATE, ` +
        "so the lease is treated as HELD (fail-closed)",
    };
  }
  const age = nowMs - acquiredMs;
  if (age < 0) {
    return {
      state: "held",
      age_ms: null,
      ttl_ms: ttl,
      basis:
        `lease acquired_at '${raw}' is in the FUTURE relative to this clock ` +
        `(by ${-age}ms) — age is INDETERMINATE (clock skew or a forged ` +
        "record), so the lease is treated as HELD (fail-closed)",
    };
  }
  if (age >= ttl) {
    return {
      state: "stale",
      age_ms: age,
      ttl_ms: ttl,
      basis:
        `lease has been held for ${age}ms since ${raw}, at or past the ` +
        `${ttl}ms staleness floor, and no edge registration released it — ` +
        "reclaimable",
    };
  }
  return {
    state: "held",
    age_ms: age,
    ttl_ms: ttl,
    basis: `lease is ${age}ms old, within the ${ttl}ms staleness floor — HELD`,
  };
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
 * The effective staleness floor for a multi-lease acquisition: never below the
 * base, widened to MULTILEASE_TTL_DEADLINE_FACTOR x the caller's own declared
 * bounded-wait budget (see § multi-lease reaper for why the first lease in
 * canonical order can legitimately be held for the whole acquisition window).
 */
function _multiLeaseStaleFloor(deadlineMs) {
  const budget =
    typeof deadlineMs === "number" && deadlineMs > 0
      ? deadlineMs
      : MULTILEASE_DEFAULT_DEADLINE_MS;
  return Math.max(MULTILEASE_TTL_MS, MULTILEASE_TTL_DEADLINE_FACTOR * budget);
}

/**
 * Classify an on-disk multi-lease LOCKFILE as HELD or STALE.
 *
 * Readable content -> the SAME `_classifyCapabilityLeaseLiveness` the
 * single-edge lease uses (it reads only `acquired_at`, never `_released`, which
 * is what lets one classifier serve a flag-flip lease and an unlink lease).
 *
 * UNREADABLE content (corrupt JSON, or the 0-byte lockfile an out-of-process
 * crash between openSync(wx) and writeFileSync leaves) -> the filesystem mtime,
 * the only other timestamp this lockfile has. Fail-closed if even that cannot
 * be read. Returns the same { state, age_ms, ttl_ms, basis } shape, plus a
 * `witness` the reaper re-checks immediately before unlinking.
 */
function _classifyMultiLeaseLiveness(leasePath, existing, nowMs, floorMs) {
  if (existing && !existing._corrupt) {
    const v = _classifyCapabilityLeaseLiveness(existing, nowMs, floorMs);
    return Object.assign({}, v, { witness: existing });
  }
  let st;
  try {
    st = fs.statSync(leasePath);
  } catch (e) {
    return {
      state: "held",
      age_ms: null,
      ttl_ms: floorMs,
      basis:
        "lockfile content is unreadable AND its mtime could not be stat'ed " +
        `(${e && e.message ? e.message : String(e)}) — age is INDETERMINATE, ` +
        "so the lock is treated as HELD (fail-closed)",
      witness: null,
    };
  }
  const witness = { _unreadable: true, mtimeMs: st.mtimeMs, size: st.size };
  const age = nowMs - st.mtimeMs;
  if (!Number.isFinite(age) || age < 0) {
    return {
      state: "held",
      age_ms: null,
      ttl_ms: floorMs,
      basis:
        "lockfile content is unreadable and its mtime is in the FUTURE " +
        "relative to this clock — age is INDETERMINATE (clock skew or a " +
        "forged timestamp), so the lock is treated as HELD (fail-closed)",
      witness,
    };
  }
  if (age >= floorMs) {
    return {
      state: "stale",
      age_ms: age,
      ttl_ms: floorMs,
      basis:
        `lockfile content is unreadable (no acquired_at to read), and its ` +
        `filesystem mtime is ${age}ms old, at or past the ${floorMs}ms ` +
        "staleness floor — this is the open-then-crash-before-write orphan, " +
        "reclaimable",
      witness,
    };
  }
  return {
    state: "held",
    age_ms: age,
    ttl_ms: floorMs,
    basis:
      `lockfile content is unreadable but its filesystem mtime is only ` +
      `${age}ms old, within the ${floorMs}ms staleness floor — this is a live ` +
      "acquirer mid-write, HELD",
    witness,
  };
}

/**
 * Unlink a lockfile that was classified STALE — the reap.
 *
 * GUARDED: re-reads the lockfile immediately before the unlink and refuses
 * unless it is byte-for-byte the same lock that was classified (`lease_id` +
 * `acquired_at` + `holder_id` for a readable lockfile; mtime + size for an
 * unreadable one). Without the guard, the window between classify and unlink is
 * the whole poll interval, and a holder that released in that window followed by
 * a DIFFERENT acquirer creating a FRESH lock would have its fresh lock deleted —
 * a mutual-exclusion break introduced by the fix itself.
 *
 * WHAT THIS DOES NOT DO, stated rather than implied: it NARROWS that window to
 * the microseconds between the confirming read and the unlink; it does not CLOSE
 * it. POSIX `unlink` takes a path, not an inode or an fd, so there is no
 * unlink-if-unchanged primitive to call — closing it entirely needs an fd-based
 * protocol this lockfile shape does not have. The residual: a fresh lock created
 * inside that microsecond window would be unlinked. Bounded, and the same class
 * the single-edge lease's TTL takeover already accepts.
 *
 * On success the caller does NOT get the lock — it falls through to the ordinary
 * O_EXCL create, so the atomic test-and-set stays the ONE acquisition primitive.
 * If a third party wins that create, the loser simply contends as normal.
 */
function _reapStaleMultiLease(leasePath, witness) {
  let st;
  try {
    st = fs.statSync(leasePath);
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: false, reason: "vanished" };
    return {
      ok: false,
      reason: "stat-failed",
      error: `_reapStaleMultiLease: stat failed for ${leasePath}: ${e && e.message ? e.message : String(e)}`,
    };
  }
  if (witness && witness._unreadable) {
    if (st.mtimeMs !== witness.mtimeMs || st.size !== witness.size) {
      return { ok: false, reason: "changed" };
    }
  } else {
    const confirm = _safeReadJson(leasePath);
    if (confirm === null) return { ok: false, reason: "vanished" };
    // A lockfile that became unreadable since classification is NOT the lock we
    // judged stale — refuse (fail-closed), do not guess.
    if (confirm._corrupt) return { ok: false, reason: "changed" };
    if (
      !witness ||
      confirm.lease_id !== witness.lease_id ||
      confirm.acquired_at !== witness.acquired_at ||
      confirm.holder_id !== witness.holder_id
    ) {
      return { ok: false, reason: "changed" };
    }
  }
  try {
    fs.unlinkSync(leasePath);
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: false, reason: "vanished" };
    return {
      ok: false,
      reason: "unlink-failed",
      error: `_reapStaleMultiLease: unlink failed for ${leasePath}: ${e && e.message ? e.message : String(e)}`,
    };
  }
  return { ok: true };
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

  // A lease that is present and un-released is HELD unless it is positively
  // shown STALE by the TTL classifier (§ liveness/TTL above). `reclaimed` stays
  // null on the normal path; when a stale lease IS reclaimed the evidence is
  // carried forward into both the successor lease record and the acquire
  // result, so a takeover is never silent.
  let reclaimed = null;
  if (existing && !existing._released) {
    const liveness = _classifyCapabilityLeaseLiveness(
      existing,
      Date.now(),
      CAPABILITY_LEASE_TTL_MS,
    );
    if (liveness.state !== "stale") {
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
            : "A different capability holds the single edge-registration lease; wait for release.") +
          ` Liveness: ${liveness.basis}.`,
        conflicting: {
          capability_id: existing.capability_id,
          holder_id: existing.holder_id,
          acquired_at: existing.acquired_at,
          lease_id: existing.lease_id,
          pid: existing.pid,
        },
        liveness,
      };
    }
    // STALE — reclaim. This is a coordination event, not a quiet retry: the
    // previous holder's process is presumed gone, but everything needed to
    // attribute the takeover is captured here and surfaced two ways below
    // (the acquire result, and the on-disk successor lease).
    //
    // NO coordination-log record is emitted, and that omission is DELIBERATE,
    // not an oversight: this module has no emission surface by design (see
    // SHAPE REUSE above — the codify-lease reuse is the on-disk-mutex half
    // ONLY, because a signed record would buy cross-clone VISIBILITY without
    // cross-clone PREVENTION, and the fold-time acyclicity predicate is the
    // authoritative defense). Adding one here to make a reclaim "louder" would
    // contradict that decision. The on-disk `reclaimed_from` marker is
    // therefore the durable record, and capability-dag.js surfaces the result
    // field to its caller.
    reclaimed = {
      lease_id: existing.lease_id || null,
      capability_id: existing.capability_id || null,
      holder_id: existing.holder_id || null,
      acquired_at: existing.acquired_at || null,
      pid: existing.pid === undefined ? null : existing.pid,
      liveness,
      reclaimed_at: _isoTimestamp(),
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
  if (reclaimed) {
    // The durable half of the takeover record — written unconditionally,
    // because it is the ONLY record a module with no emission surface produces.
    lease.reclaimed_from = reclaimed;
  }
  _atomicWriteJson(leasePath, lease);

  const result = { ok: true, lease, leasePath, capabilityId };
  if (reclaimed) result.reclaimed = reclaimed;
  return result;
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
  // Shape UNCHANGED — the held lease is still returned under `lease`. The
  // `liveness` + `stale` fields are ADDITIVE, so an inspector can tell a live
  // holder from a reclaimable orphan without re-deriving the floor itself.
  const liveness = _classifyCapabilityLeaseLiveness(
    existing,
    Date.now(),
    CAPABILITY_LEASE_TTL_MS,
  );
  return {
    lease: existing,
    leasePath: lp,
    liveness,
    stale: liveness.state === "stale",
  };
}

// ---------------------------------------------------------------------------
// MULTI-LEASE primitives (W5 A2-T3b)
// ---------------------------------------------------------------------------

/**
 * Try to acquire ONE per-capability multi-lease (the per-capability file). A
 * SINGLE non-blocking attempt — the blocking bounded-wait is the loop in
 * acquireMultiLease that calls this with backoff. Returns:
 *   { ok:true, lease } on acquire
 *   { ok:false, reason:"contended", holder, liveness } when a LIVE holder is active
 *   { ok:false, reason:"reaped", reclaimedFrom } when a STALE lockfile was
 *       cleared — the caller retries the create IMMEDIATELY (no sleep); this is
 *       what removes the full-bounded-wait burn on a crash orphan
 *   { ok:false, reason:<other> } on a non-retryable failure
 * Mirrors acquireCapabilityLease's typed shape, but on the per-capability file.
 *
 * @param {object} [opts] - { staleFloorMs, reclaimedFrom, allowReap }
 */
function _tryAcquireOneMultiLease(capabilityId, holderId, topLevel, opts) {
  const o = opts || {};
  const staleFloorMs =
    typeof o.staleFloorMs === "number" && o.staleFloorMs > 0
      ? o.staleFloorMs
      : _multiLeaseStaleFloor(MULTILEASE_DEFAULT_DEADLINE_MS);
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
  // A takeover is never silent: the successor lockfile names the orphan it
  // cleared. This module has NO signed-record emission surface by design (see
  // the SHAPE REUSE note above — a signed record would buy cross-clone
  // VISIBILITY without cross-clone PREVENTION, and the fold-time acyclicity
  // predicate is the real defense), so the on-disk marker plus the `reclaimed`
  // field on acquireMultiLease's result are the whole loudness surface, and
  // that is stated rather than left to be inferred.
  if (o.reclaimedFrom) lease.reclaimed_from = o.reclaimedFrom;
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  let fd;
  try {
    // "wx" = O_WRONLY | O_CREAT | O_EXCL — atomic exclusive create.
    fd = fs.openSync(leasePath, "wx", 0o600);
  } catch (e) {
    if (e && e.code === "EEXIST") {
      // The lock EXISTS — but existence alone no longer means a LIVE holder.
      // Read it, classify it, and reap it if it is positively stale; otherwise
      // report contention exactly as before.
      const existing = _safeReadJson(leasePath);
      const holder =
        existing && !existing._corrupt
          ? {
              capability_id: existing.capability_id,
              holder_id: existing.holder_id,
              acquired_at: existing.acquired_at,
              lease_id: existing.lease_id,
              pid: existing.pid,
            }
          : null;
      const liveness = _classifyMultiLeaseLiveness(
        leasePath,
        existing,
        Date.now(),
        staleFloorMs,
      );
      if (liveness.state === "stale" && o.allowReap !== false) {
        const reap = _reapStaleMultiLease(leasePath, liveness.witness);
        if (reap.ok) {
          const { witness: _w, ...verdict } = liveness;
          return {
            ok: false,
            reason: "reaped",
            reclaimedFrom: {
              capability_id: capabilityId,
              lease_id: holder ? holder.lease_id : null,
              holder_id: holder ? holder.holder_id : null,
              acquired_at: holder ? holder.acquired_at : null,
              pid: holder ? holder.pid : null,
              liveness: verdict,
              reclaimed_at: _isoTimestamp(),
            },
          };
        }
        // The reap REFUSED (the lock changed, vanished, or could not be
        // unlinked). Fail closed: fall through and report contention — the
        // next poll re-reads and re-classifies from scratch.
      }
      const { witness: _unused, ...contendedLiveness } = liveness;
      return {
        ok: false,
        reason: "contended",
        holder,
        liveness: contendedLiveness,
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
 * @returns {{ ok:true, holderId, order:string[], reclaimed? }
 *          |{ ok:false, reason, error, ..., liveness?, reclaimed? }}
 *   `order` is the canonical sorted set the caller now holds (pass it verbatim
 *   to releaseMultiLease). `reclaimed` is present ONLY when this call reaped one
 *   or more crash-orphan lockfiles (§ multi-lease reaper) and names each
 *   previous holder; `liveness` accompanies a `deadline-exceeded` and explains
 *   WHY the contended lock was judged still HELD. Both are ADDITIVE — every
 *   pre-existing reason code, error string, and field is unchanged.
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
  const staleFloorMs = _multiLeaseStaleFloor(deadlineMs);
  // Every stale lockfile this call cleared, surfaced on BOTH the success and
  // failure results — a reap that happened is reported even if the acquisition
  // later fails, so a takeover is never lost.
  const reclaimed = [];

  for (const capabilityId of order) {
    let backoff = pollMs;
    let reapsHere = 0;
    // The orphan this call cleared for THIS capability, embedded into the
    // lockfile we go on to create. If a sibling briefly wins the create in
    // between, the field still names the orphan WE cleared — which is the fact
    // worth recording — rather than being dropped.
    let reclaimedFrom = null;
    // Blocking bounded-wait on THIS lease (canonical order guarantees no
    // deadlock; deadline guarantees termination).
    for (;;) {
      let res;
      try {
        res = _tryAcquireOneMultiLease(capabilityId, holderId, topLevel, {
          staleFloorMs,
          reclaimedFrom,
          allowReap: reapsHere < MULTILEASE_MAX_REAPS_PER_LEASE,
        });
      } catch (err) {
        // Unexpected throw mid-acquire — release the prefix, surface typed.
        releaseMultiLease(held, holderId, topLevel);
        return {
          ok: false,
          reason: "error",
          error: `acquireMultiLease: unexpected error acquiring '${capabilityId}': ${err && err.message ? err.message : String(err)}`,
          held: held.slice(),
          ...(reclaimed.length ? { reclaimed } : {}),
        };
      }
      if (res.ok) {
        held.push(capabilityId);
        if (reclaimedFrom) reclaimed.push(reclaimedFrom);
        break; // acquired this lease; advance to the next in canonical order
      }
      if (res.reason === "reaped") {
        // A crash orphan was cleared. Retry the O_EXCL create IMMEDIATELY — no
        // sleep, no backoff growth. THIS is what removes the full-bounded-wait
        // burn: a provably-dead lock now costs one read + one unlink + one
        // retry instead of the whole 30s budget. The deadline is still checked
        // so a pathological clock cannot spin without bound.
        reapsHere += 1;
        reclaimedFrom = res.reclaimedFrom;
        if (now() >= deadline) {
          releaseMultiLease(held, holderId, topLevel);
          return {
            ok: false,
            reason: "deadline-exceeded",
            error: `acquireMultiLease: bounded-wait deadline (${deadlineMs}ms) exceeded on '${capabilityId}' immediately after reaping a stale lockfile; released ${held.length} already-held lease(s)`,
            capabilityId,
            contendingHolder: null,
            reclaimed: reclaimed.concat([reclaimedFrom]),
          };
        }
        continue;
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
          ...(reclaimed.length ? { reclaimed } : {}),
        };
      }
      // Contended by a LIVE holder → BLOCK (bounded-wait). Check the deadline
      // BEFORE sleeping so the wait provably terminates (the DoS bound). This
      // path is UNCHANGED by the reaper: a live holder still costs the full
      // budget, and so does an INDETERMINATE one (fail-closed — we cannot prove
      // it dead, so we must wait for it).
      if (now() >= deadline) {
        releaseMultiLease(held, holderId, topLevel);
        return {
          ok: false,
          reason: "deadline-exceeded",
          error: `acquireMultiLease: bounded-wait deadline (${deadlineMs}ms) exceeded waiting for lease on '${capabilityId}' (held by ${res.holder ? res.holder.holder_id : "unknown"}); released ${held.length} already-held lease(s)`,
          capabilityId,
          contendingHolder: res.holder,
          liveness: res.liveness,
          ...(reclaimed.length ? { reclaimed } : {}),
        };
      }
      sleep(Math.min(backoff, maxPollMs, Math.max(1, deadline - now())));
      backoff = Math.min(backoff * 2, maxPollMs); // exponential backoff, capped
    }
  }

  return {
    ok: true,
    holderId,
    order,
    ...(reclaimed.length ? { reclaimed } : {}),
  };
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
  CAPABILITY_LEASE_TTL_MS,
  MULTILEASE_TTL_MS,
  // Test-only — NOT part of the supported API.
  _test_classifyCapabilityLeaseLiveness: _classifyCapabilityLeaseLiveness,
  _test_classifyMultiLeaseLiveness: _classifyMultiLeaseLiveness,
  _test_reapStaleMultiLease: _reapStaleMultiLease,
  _test_multiLeaseStaleFloor: _multiLeaseStaleFloor,
  _test_multiLeaseDefaults: () => ({
    deadlineMs: MULTILEASE_DEFAULT_DEADLINE_MS,
    pollMs: MULTILEASE_DEFAULT_POLL_MS,
    maxPollMs: MULTILEASE_DEFAULT_MAX_POLL_MS,
    maxReapsPerLease: MULTILEASE_MAX_REAPS_PER_LEASE,
    ttlDeadlineFactor: MULTILEASE_TTL_DEADLINE_FACTOR,
  }),
  _test_capabilityFingerprint: _capabilityFingerprint,
  _test_validateToken: _validateToken,
  _test_canonicalCapabilityOrder: _canonicalCapabilityOrder,
  _test_multiLeasePath: _multiLeasePath,
};
