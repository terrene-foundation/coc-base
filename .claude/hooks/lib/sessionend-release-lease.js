/**
 * sessionend-release-lease — per-EMITTER single-releaser lease that closes the
 * residual read→append equivocation window in
 * `multi-operator-sessionend.js::releaseOwnClaims` (#874, Option B).
 *
 * THE WINDOW (documented at multi-operator-sessionend.js::releaseOwnClaims, the
 * "RESIDUAL EQUIVOCATION WINDOW" comment): under the #857 detached-worker model,
 * two SAME-`verified_id` SessionEnd workers can BOTH read chain-head=N (via
 * coc-emit.js's per-call `_defaultReadChainHead`) BEFORE either appends, both
 * emit seq=N+1, both pass the COC-CHAIN fold-validate delta guard (each sees the
 * OTHER's record as not-yet-present) → the per-emitter chain FORKS (fold rule 3
 * frames the operator as an equivocator). emit's fresh-per-call read SHRANK the
 * window (#868 Option A) but did not CLOSE it — the read and the append are
 * non-atomic. Option A degraded a fork to "the losing release lingers as a stale
 * claim until its TTL"; Option B (this lib) makes at-most-ONE releaser be
 * in-flight per emitter, so the read→append never overlaps for a given emitter.
 *
 * SCOPE (load-bearing honesty — this is a CLONE-LOCAL mutex, NOT a fold rule):
 * the failure mode is TWO detached SessionEnd workers of the SAME operator on
 * the SAME clone (the #857 latency-decoupling spawns one detached worker per
 * SessionEnd; a rapid resume/second-Stop can spawn a second before the first
 * finishes). Both workers see the SAME on-disk `.claude/learning/`, so an
 * on-disk O_EXCL mutex under that dir fully serializes them. This is NOT the
 * cross-CLONE equivocation class (two operators on two clones) — that is caught
 * DETECTION-EVENTUALLY by the fold rules at read time and is NOT what this lib
 * addresses. Therefore NO new fold rule and NO signed coordination-log record
 * are needed (a signed record would give cross-clone VISIBILITY but the window
 * being closed is intra-clone). Same deliberate omission as
 * `capability-lease.js`'s single-edge lease (the on-disk-mutex half only).
 *
 * SHAPE REUSE (per framework-first.md §substrate-reuse): this is NOT a new lease
 * MECHANISM. It MIRRORS:
 *   - `capability-lease.js::_tryAcquireOneMultiLease` — the ATOMIC test-and-set.
 *     A read-then-write mutex (the single-file `codify-lease.js` /
 *     `capability-lease.js` acquire path) is ITSELF a TOCTOU: two processes each
 *     `_safeReadJson`→null, each write, each believe they won. An exclusive
 *     CREATE is what closes that — the kernel guarantees exactly one caller
 *     wins; every other gets EEXIST. Closing a read→append window with a
 *     read-then-write mutex would just move the window.
 *
 *     This lib publishes via STAGE-THEN-`link()` rather than the sibling libs'
 *     bare `fs.openSync(path, "wx")`. Both are atomic test-and-sets, but O_EXCL
 *     publishes the NAME before the CONTENT, leaving the lockfile observable as
 *     a zero-byte file. The stage-then-link path publishes a fully-written
 *     inode; the degraded O_EXCL path may expose partial content. F6 keeps
 *     corrupt/unreadable holders undetermined; _classifyLeaseLiveness gates reaping
 *     (.claude/hooks/lib/sessionend-release-lease.js:480-500,882-935).
 *   - `coord-background.js::_foldHomedirLiveness` (the #867 pid-liveness reaper)
 *     — a crashed worker orphans its lease; the holder's `{pid, start-token}`
 *     marker distinguishes ESRCH / recycled PID from an unverifiable holder
 *     (_classifyHolder, .claude/hooks/lib/sessionend-release-lease.js:307-350).
 *   - `codify-lease.js` / `capability-lease.js` typed Result shape, `_safeReadJson`
 *     corruption sentinel, `resolveStateDir` path derivation (Sec-MED-3 — callers
 *     cannot misroute the lease write), and per-emitter file keying.
 *
 * Style: CommonJS, sync, pure node:fs / node:crypto / node:child_process, no
 * external deps. Per zero-tolerance.md Rule 3: every expected-failure path
 * returns a typed result; NEVER a throw on the conflict/dirty path, NEVER a
 * silent fallback.
 *
 * Public API:
 *   acquireReleaseLease({ verifiedId, repoDir? }) -> Result
 *     Result = { ok:true, lease:{...}, leasePath, degraded? }
 *           | { ok:false, reason, error?, holder?, liveness? }
 *     reason ∈ { "contended", "invalid-verified-id", "lease-io-error" }
 *     degraded ∈ { "no-hardlink-support" } — present ONLY when the publish fell
 *       back to the bare O_EXCL create because the filesystem has no `link(2)`.
 *       The lease IS held; what is OFF is the half-formed-lease protection.
 *       CALLERS MUST READ THIS FIELD. It is the ONLY channel that reaches a
 *       detached SessionEnd worker; the one-time stderr WARN below does NOT
 *       (the worker is spawned `stdio:"ignore"`, so its fd 2 is /dev/null).
 *       `multi-operator-sessionend.js::releaseOwnClaims` reads it and records a
 *       durable observation row (#1544 F2, round 2).
 *   releaseReleaseLease({ verifiedId, repoDir? }) -> { ok, ... }
 *     reason ∈ { "no-lease", "already-released", "wrong-emitter", "wrong-owner",
 *                "lease-corrupt", "invalid-verified-id", "lease-io-error" }
 *   readActiveReleaseLease(verifiedId, repoDir?) -> { lease | null, ... }
 *
 * The Result is the contract — releaseOwnClaims branches on `ok`: on `contended`
 * it DEFERS its releases (they linger to their claim TTL — the SAME safe
 * degradation Option A already accepts); on any other non-ok it PROCEEDS
 * best-effort (a lease IO error must never BLOCK sessionend — header contract).
 *
 * POLICY TRADE-OFF: persistent EIO with an unchanged old same-uid witness may
 * become reclaimable; age is not proof of holder death. The witness narrows
 * replacement races but decision-time stat is not a sink-time lock. Retained
 * LOW residuals: no-pid markers and non-ESRCH existence-probe errors still take
 * the historical dead path; they are not repaired by this batch. Source symbols:
 * _classifyHolder / _classifyLeaseLiveness / acquireReleaseLease
 * (.claude/hooks/lib/sessionend-release-lease.js:307-350,480-500,882-935).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { resolveStateDir } = require("./state-resolver.js");

// One lease file PER EMITTER (keyed on the verified_id fingerprint), so two
// DIFFERENT emitters never contend (no false serialization) and two SAME-emitter
// releasers contend on ONE file. The verified_id is hashed into the filename so
// a fingerprint with path-unsafe chars can never escape the state dir. Mirrors
// capability-lease.js::_multiLeasePath's per-key file scheme.
const LEASE_FILE_PREFIX = "sessionend-release-lease-";

// Staging files for the stage-then-link publish. Deliberately does NOT start with
// LEASE_FILE_PREFIX — that prefix is exported for directory scans, and a staging
// file wearing it could be swept up as though it were a lease.
//
// DISCLOSURE (#1544 F1): the staged body is the COMPLETE lease — verified_id +
// verified_fingerprint — so a staging file orphaned by a crash between the create
// and the link is a git-visible operator fingerprint. Precisely BECAUSE this prefix
// diverges from LEASE_FILE_PREFIX, the `.gitignore` /
// `sync-manifest.yaml::gitignore_additions` fence on `sessionend-release-lease-*`
// does NOT cover it; it carries its own `.tmp-sereleaselease-*` fence, pinned to
// this constant by `.claude/test-harness/tests/sessionend-release-lease.test.mjs`
// § T-I so a rename here cannot silently outrun the fence.
const STAGING_FILE_PREFIX = ".tmp-sereleaselease-";

// A staging file older than this was orphaned by a crash between the create and
// the publish (a microseconds-wide window). Swept opportunistically so a crash
// loop cannot accumulate unreachable files in the state dir forever.
const STAGING_STALE_MS = 60 * 60 * 1000;

// `link(2)` is unsupported here — degrade to the legacy O_EXCL create rather than
// leaving the caller with no mutex at all. See _publishLeaseAtomically.
const NO_HARDLINK_CODES = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EXDEV",
  "ENOSYS",
]);

/**
 * One-time loud WARN when the real filesystem cannot do `link(2)` and the publish
 * falls back to the legacy O_EXCL create (#1544 F2).
 *
 * SCOPE — read this before citing it as the report (#1544 F2, round 2 correction).
 *
 * THIS WARN IS NOT THE PRODUCTION REPORT, and an earlier version of this comment said it was.
 * It claimed the WARN meant the degradation no longer had to "sit in a return field nobody
 * reads". That was false in the only path that matters: `releaseOwnClaims` runs inside the
 * DETACHED SessionEnd worker, which `coord-background.js::spawnDetachedWorker` spawns with
 * `stdio:"ignore"`. The worker's fd 2 IS /dev/null, so `console.error` SUCCEEDS, the bytes are
 * discarded, and the try/catch never fires — silent, not failed. Round 1 therefore moved a
 * write-only FIELD into a write-only STREAM and changed end-to-end observability not at all.
 *
 * The production report is the DURABLE one: `releaseOwnClaims` now READS `degraded` and records
 * an observation row through `learning-utils.js::logObservation`. The filesystem is the channel
 * that works where stderr does not. That is what satisfies `security.md` § "Secure-Default For A
 * New Security Feature" here.
 *
 * WHY THIS WARN STAYS ANYWAY: it is the report for every caller whose fd 2 is real — the test
 * suites, a future synchronous caller, and the `COC_TEST_*` SYNC_TEARDOWN path where the parent
 * runs the teardown itself. It is a SECOND surface, not the load-bearing one.
 *
 * OBSERVABILITY CONTRACT: stderr cannot substitute for a caller-owned durable
 * observation. Callers must inspect the Result's degradation and undetermined
 * liveness fields, including tombstoneHeld / restore_reason when present.
 * The heldTombstone pathname is private custody metadata, never log payload.
 * Source: _restoreHeldTombstone, .claude/hooks/lib/sessionend-release-lease.js:527-571.
 *
 * Shape is deliberately the SAME as `append-sink.js::_warnDegradedOnce` (module-level latch,
 * stderr only, swallowed write errors) rather than a second mechanism. It is not literally
 * that function: that one is module-private to append-sink and its text names O_NOFOLLOW.
 *
 * stderr only: a hook's stdout is its protocol channel, so this can never reach the halting path.
 */
let _warnedNoHardlink = false;
function _warnDegradedOnce() {
  if (_warnedNoHardlink) return;
  _warnedNoHardlink = true;
  try {
    console.error(
      "[sessionend-release-lease] WARNING: this filesystem does not support link(2) — the " +
        "release lease falls back to a bare O_EXCL create. At-most-one-releaser STILL HOLDS, " +
        "but the lease is briefly observable ZERO-BYTE between the create and the write, and a " +
        "concurrent acquirer treats corrupt or unreadable content as undetermined and defers. " +
        "Complete-at-publication protection is OFF here; use a hard-link-capable filesystem. " +
        "Source: _classifyHolder / _classifyLeaseLiveness / acquireReleaseLease " +
        "(.claude/hooks/lib/sessionend-release-lease.js:307-350,480-500,882-935). Put the " +
        "trust state dir (CLAUDE_TRUST_STATE_DIR / the main checkout's .claude/learning/) on a " +
        "filesystem with hard links — exFAT/FAT32, many SMB/CIFS mounts and some FUSE/container " +
        "volume drivers do not have them. (loom#874, loom#1544)",
    );
  } catch {
    // A closed/failing stderr must never break a lease acquire.
  }
}

/** Test-only: clear the one-time latch. Declared as a named function because the
 * ESM named-export detection over this CommonJS module does not pick up an
 * inline arrow in the exports object. */
function _resetDegradedWarning() {
  _warnedNoHardlink = false;
}

/** Remove staging files orphaned by a crashed publish. Best-effort and bounded:
 * one readdir, and only entries older than STAGING_STALE_MS are touched, so a
 * concurrent in-flight publish (microseconds old) is never disturbed. */
function _sweepStaleStaging(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return; /* the dir is gone or unreadable — nothing to sweep */
  }
  const cutoff = Date.now() - STAGING_STALE_MS;
  for (const name of entries) {
    if (!name.startsWith(STAGING_FILE_PREFIX)) continue;
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch (_) {
      /* raced with another sweeper or the owning process — leave it */
    }
  }
}

// ---- helpers (mirror the sibling lease libs + coord-background reaper) ------

function _isoTimestamp(now) {
  return (now || new Date()).toISOString();
}

/** Validate a verified_id token (SSH key fingerprint like `SHA256:…=`). Mirrors
 * capability-lease.js::_validateToken — admits the base64 alphabet, no shell
 * metas / whitespace / quotes (the embed-into-file safety this exists for). */
function _validateVerifiedId(token) {
  if (typeof token !== "string" || !token) {
    return "verifiedId is required (non-empty string)";
  }
  if (!/^[A-Za-z0-9._:+/=-]+$/.test(token)) {
    return `verifiedId '${token}' contains characters outside [A-Za-z0-9._:+/=-]`;
  }
  if (token.length > 200) {
    return `verifiedId '${token}' exceeds 200 chars`;
  }
  return null;
}

function _fingerprint(verifiedId) {
  return crypto.createHash("sha256").update(verifiedId).digest("hex");
}

function _leasePath(repoDir, verifiedId) {
  // Sec-MED-3: repoDir-derived (resolveStateDir → main checkout), never
  // caller-supplied, so a caller cannot misroute the lease write.
  const stateDir = resolveStateDir(repoDir);
  return path.join(
    stateDir,
    `${LEASE_FILE_PREFIX}${_fingerprint(verifiedId)}.json`,
  );
}

function _safeReadJson(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    return { _unreadable: true, _error: String(e && e.message) };
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Corrupt JSON → sentinel so callers can classify (never silently no-lease).
    return { _corrupt: true, _error: String(e && e.message) };
  }
}

/** This process's immutable start token (OS process start time) — disambiguates
 * a live PID from a recycled one. Best-effort (null when `ps` unavailable).
 * Mirrors coord-background.js::_processStartToken. */
function _processStartToken(pid) {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      timeout: 2000,
    });
    const t = (out || "").trim();
    return t.length > 0 ? "v2:" + t : null;
  } catch {
    return null;
  }
}

let _ownStartTokenCache;
function _ownStartToken() {
  if (_ownStartTokenCache === undefined) {
    _ownStartTokenCache = _processStartToken(process.pid);
  }
  return _ownStartTokenCache;
}

/** _classifyHolder (.claude/hooks/lib/sessionend-release-lease.js:307-350).
 * PID truth only; _classifyLeaseLiveness supplies separate age-policy eligibility.
 *   "dead"  — absent / no-pid / pid gone / start-token mismatch.
 *   "alive" — pid exists, including EPERM; matching or unverified start token.
 *   "undetermined" — corrupt or unreadable persisted marker; defer.
 * This is a decision-time observation, not sink-time identity. */
function _classifyHolder(existing) {
  if (existing && existing._unsafe) {
    return { state: "undetermined", reason: "unsafe-lease" };
  }
  if (existing && existing._corrupt) {
    return { state: "undetermined", reason: "corrupt-lease" };
  }
  if (existing && existing._unreadable) {
    return { state: "undetermined", reason: "unreadable-lease" };
  }
  if (!existing) {
    return { state: "dead", reason: "absent" };
  }
  const pid =
    Number.isInteger(existing.holder_pid) && existing.holder_pid > 0
      ? existing.holder_pid
      : null;
  if (pid === null) return { state: "dead", reason: "no-pid" };
  let alive;
  try {
    process.kill(pid, 0); // signal 0 = existence probe, delivers nothing
    alive = true;
  } catch (err) {
    // EPERM = process exists but owned by another uid → still alive.
    alive = !!(err && err.code === "EPERM");
  }
  if (!alive) return { state: "dead", reason: "esrch" };
  const storedToken = existing.holder_token || null;
  const liveToken = _processStartToken(pid);
  if (storedToken) {
    if (typeof storedToken !== "string" ||
      !storedToken.startsWith("v2:") || storedToken.length <= 3) {
      return { state: "undetermined", reason: "token-format-unverified" };
    }
    if (liveToken) {
      return storedToken === liveToken
        ? { state: "alive", reason: "token-verified" }
        : { state: "dead", reason: "token-mismatch" };
    }
  }
  // Alive but the start-token could not be compared — a live process this
  // session; spare it (a live in-flight releaser is exactly what we serialize).
  return { state: "alive", reason: "token-unverified" };
}

// Reuse capability-lease.js::MULTILEASE_TTL_MS's existing birth floor
// (.claude/hooks/lib/capability-lease.js:279,532-587), without changing PID truth.
const UNDETERMINED_BIRTH_FLOOR_MS = 15 * 60 * 1000;

// A real lease is a few hundred bytes; anything larger is not a lease this module
// wrote, so it is never decoded into a liveness verdict.
const LEASE_MAX_BYTES = 64 * 1024;

function _statWitness(st) {
  if (!st || !st.isFile() ||
    ![st.dev, st.ino, st.size, st.mtimeMs, st.uid].every(Number.isFinite)) return null;
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, uid: st.uid };
}

// Path-time identity of the NAME, for the pre-rename / pre-unlink recheck. lstat,
// so a symlink planted at the name is never resolved into a "same file" witness.
function _leaseWitness(leasePath) {
  try {
    return _statWitness(fs.lstatSync(leasePath));
  } catch {
    return null;
  }
}

function _sameLeaseWitness(a, b) {
  return !!a && !!b && ["dev", "ino", "size", "mtimeMs", "uid"].every(k => a[k] === b[k]);
}

/**
 * Read a lease (or a held tombstone) so the decoded bytes and the identity
 * witness come from ONE descriptor (R2-S2). A path read followed by a path stat
 * can classify one inode's bytes and witness a replacement's metadata, so a dead
 * holder's bytes would authorize moving a live holder's file. Here the file is
 * opened O_NOFOLLOW (a symlink is never classified through its target), fstat'd
 * (a FIFO, socket or device is refused before any read), read through a
 * LEASE_MAX_BYTES+1 bound, and fstat'd again: metadata that changed across the
 * read leaves the bytes UNBOUND, and unbound bytes never classify dead
 * (_classifyLeaseLiveness).
 *
 * @returns {{absent:true} | {existing:object, witness:object|null, bytes?:Buffer}}
 */
function _readLeaseBound(p) {
  const C = fs.constants || {};
  let fd;
  try {
    if (!(C.O_NOFOLLOW > 0)) {
      // No O_NOFOLLOW (win32): refuse a symlink by lstat before the open.
      if (fs.lstatSync(p).isSymbolicLink()) {
        return { existing: { _unreadable: true, _unsafe: true }, witness: null };
      }
    }
    fd = fs.openSync(p, (C.O_RDONLY || 0) | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0));
  } catch (e) {
    if (e && e.code === "ENOENT") return { absent: true, existing: null, witness: null };
    if (e && e.code === "ELOOP") {
      return { existing: { _unreadable: true, _unsafe: true }, witness: null };
    }
    return { existing: { _unreadable: true, _error: String(e && e.message) }, witness: null };
  }
  try {
    let st;
    try {
      st = fs.fstatSync(fd);
    } catch {
      st = null;
    }
    // A FIFO, socket or device at the lease name is not a lease this module
    // wrote, and its size says nothing about how much a read returns: refuse it
    // before any byte is read.
    if (st && !st.isFile()) {
      return { existing: { _unreadable: true, _unsafe: true }, witness: null };
    }
    const before = _statWitness(st);
    if (before && before.size > LEASE_MAX_BYTES) {
      return { existing: { _unreadable: true, _unsafe: true }, witness: null };
    }
    let bytes;
    try {
      // Bounded whatever fstat said (or could not say): one byte past the limit
      // proves the file is oversized without reading the rest of it.
      const buf = Buffer.alloc(LEASE_MAX_BYTES + 1);
      let used = 0;
      while (used < buf.length) {
        const count = fs.readSync(fd, buf, used, buf.length - used, used);
        if (count === 0) break;
        used += count;
      }
      if (used > LEASE_MAX_BYTES) {
        return { existing: { _unreadable: true, _unsafe: true }, witness: null };
      }
      bytes = buf.subarray(0, used);
    } catch (e) {
      // Nothing was decoded, so there is nothing to bind: the witness is the
      // identity of the inode that could not be read (age policy input only).
      return { existing: { _unreadable: true, _error: String(e && e.message) }, witness: before };
    }
    let after;
    try {
      after = _statWitness(fs.fstatSync(fd));
    } catch {
      after = null;
    }
    const existing = _parseLease(bytes.toString("utf8"));
    // Unavailable OR changed metadata leaves the decoded bytes bound to no inode.
    if (!_sameLeaseWitness(before, after)) return { existing, bytes, witness: null };
    return { existing, bytes, witness: after };
  } finally {
    try {
      fs.closeSync(fd);
    } catch (_) {
      /* read-only descriptor; nothing to flush */
    }
  }
}

function _parseLease(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { _corrupt: true, _error: String(e && e.message) };
  }
}

/**
 * Liveness of a bound read: PID truth from _classifyHolder, then a SEPARATE age
 * policy for undetermined content. Only a bound read may be reap-eligible, and
 * an unbound one is never reported dead — its bytes describe no known inode.
 */
function _classifyLeaseLiveness(read) {
  const verdict = _classifyHolder(read.existing);
  if (verdict.state === "alive") return { ...verdict, reap_eligible: false };
  if (read.absent) return { ...verdict, reap_eligible: false, age_reason: "stat-unavailable" };
  const witness = read.witness;
  if (!witness) {
    return { state: "undetermined", reason: verdict.state === "dead" ? "unbound-lease" : verdict.reason,
      reap_eligible: false, age_reason: "stat-unavailable" };
  }
  const result = { ...verdict, witness, reap_eligible: false };
  if (verdict.state === "dead") return { ...result, reap_eligible: true };
  const age = Date.now() - witness.mtimeMs;
  result.floor_ms = UNDETERMINED_BIRTH_FLOOR_MS;
  if (!Number.isFinite(age) || age < 0) return { ...result, age_ms: null, age_reason: "mtime-indeterminate" };
  result.age_ms = age;
  if (typeof process.getuid !== "function" || witness.uid !== process.getuid()) {
    return { ...result, age_reason: "owner-unverifiable" };
  }
  return { ...result, reap_eligible: age >= UNDETERMINED_BIRTH_FLOOR_MS,
    age_reason: age >= UNDETERMINED_BIRTH_FLOOR_MS ? "birth-floor-expired" : "birth-window" };
}

function _publicLiveness(liveness) {
  const { witness: _privateWitness, ...verdict } = liveness;
  return verdict;
}

/**
 * Put a moved lease back at its name without ever clobbering a newborn. link(2)
 * first: it fails EEXIST if a newborn took the name. Where the filesystem has no
 * hard links, fall back to an O_EXCL copy of the bytes that were classified
 * (R2-S1), since leaving the name empty would let the next acquirer publish over
 * a live holder. Any failure keeps the tombstone as HELD custody, which
 * _clearHeldCustody makes every later acquirer honour.
 */
// A tombstone that is GONE was cleared by another acquirer's _clearHeldCustody
// (which unlinks only reap-eligible custody): nothing is held, so it is not a
// restore failure and is not reported as a degradation.
function _tombstoneGone(tombstone) {
  try {
    fs.lstatSync(tombstone);
    return false;
  } catch (e) {
    return !!e && e.code === "ENOENT";
  }
}

function _restoreHeldTombstone(tombstone, leasePath, bytes) {
  const held = (restore_reason) => ({ heldTombstone: tombstone, tombstoneHeld: true, restore_reason });
  try {
    fs.linkSync(tombstone, leasePath);
  } catch (e) {
    const code = e && e.code;
    if (code === "EEXIST") return held("newborn-present");
    if (code === "ENOENT" && _tombstoneGone(tombstone)) {
      return { tombstoneHeld: false, restore_reason: "tombstone-cleared" };
    }
    if (!NO_HARDLINK_CODES.has(code)) return held("restore-link-failed");
    if (bytes == null) return held("restore-copy-unavailable");
    let fd;
    try {
      fd = fs.openSync(leasePath, "wx", 0o600);
    } catch (e2) {
      return held(e2 && e2.code === "EEXIST" ? "newborn-present" : "restore-copy-failed");
    }
    let copied = false;
    try {
      fs.writeFileSync(fd, bytes);
      copied = true;
    } catch (_) {
      /* partial copy: custody stays held, so the copy can never be reaped first */
    }
    try {
      fs.closeSync(fd);
    } catch (_) {
      copied = false; // a close error leaves the copy's durability unknown
    }
    if (!copied) return held("restore-copy-failed");
    try {
      fs.unlinkSync(tombstone);
      return { tombstoneHeld: false, restore_reason: "restored-by-copy" };
    } catch {
      return held("restore-unlink-failed");
    }
  }
  try {
    fs.unlinkSync(tombstone);
    return { tombstoneHeld: false, restore_reason: "restored" };
  } catch {
    return held("restore-unlink-failed");
  }
}

function _escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * HELD custody (R2-S1): a `<lease>.reap-<pid>-<8hex>` tombstone that a reaper
 * could not restore or remove still holds a lease's bytes. While one exists the
 * lease name may be empty, so a publish there could run beside the holder the
 * tombstone names. Before every publish each held tombstone is classified like a
 * lease: a reap-eligible one is removed (bounded clearing), anything else defers
 * the acquire. An unreadable directory defers too — custody is then unknown,
 * never assumed absent.
 *
 * @returns {{ok:true} | {ok:false, holder:object|null, liveness:object}}
 */
function _clearHeldCustody(leasePath) {
  const dir = path.dirname(leasePath);
  const pattern = new RegExp(`^${_escapeRegExp(path.basename(leasePath))}\\.reap-\\d+-[0-9a-f]{8}$`);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => pattern.test(n));
  } catch (_) {
    return { ok: false, holder: null, liveness: { state: "undetermined",
      reason: "custody-unobservable", reap_eligible: false } };
  }
  for (const name of names) {
    const held = path.join(dir, name);
    const read = _readLeaseBound(held);
    if (read.absent) continue; // its reaper finished between the scan and the read
    const liveness = _classifyLeaseLiveness(read);
    if (liveness.reap_eligible && _sameLeaseWitness(liveness.witness, _leaseWitness(held))) {
      try {
        fs.unlinkSync(held);
        continue;
      } catch (e) {
        if (e && e.code === "ENOENT") continue;
      }
    }
    return { ok: false, holder: _holderView(read.existing), liveness: {
      ..._publicLiveness(liveness), reap_eligible: false,
      heldTombstone: held, tombstoneHeld: true, restore_reason: "custody-held" } };
  }
  return { ok: true };
}

/**
 * Publish a COMPLETE lease file at `leasePath` as the atomic test-and-set.
 *
 * WHY NOT `openSync(leasePath, "wx")` DIRECTLY (sec-874 follow-up): O_EXCL makes
 * the NAME appear atomically, but the CONTENT is written afterwards, so between
 * the open and the write the lease is observable as a ZERO-BYTE file. Every
 * acquire-side reader funnels through `_readLeaseBound` → `_classifyHolder`.
 * Before F6, zero-byte/corrupt content classified dead and authorized a reap
 * (1efa82cc8801010372d2837bbf36a390ee6a42df:.claude/hooks/lib/sessionend-release-lease.js:291-295). A racer inside that
 * window therefore reaped a lease that was being BORN and created its own: BOTH
 * racers returned `ok:true`, which is precisely the at-most-one-releaser
 * invariant this lib exists to hold. Widening that window to 80ms made it fire
 * 12/12; unwidened it fires only under CPU contention, which is why it read as
 * a flaky test rather than the mutual-exclusion break it is.
 *
 * The fix is to make the lease file COMPLETE at the instant it becomes visible:
 * stage the full body under a unique private name, then `link()` it into place.
 * POSIX `link(2)` fails with EEXIST if the target exists, so it is an atomic
 * test-and-set exactly as O_EXCL is — but it publishes a fully-written inode,
 * so no reader can ever sample a half-formed lease. A crash mid-write now
 * orphans only the staging file, never a permanently-dead zero-byte lockfile.
 *
 * `rename()` would NOT do: it CLOBBERS an existing target, so two racers would
 * both "win". The exclusivity has to come from the publish call itself.
 *
 * @returns {{ok:true} | {ok:false, code:string, error:string}} `code === "EEXIST"`
 *   means another racer holds the lease — the caller's contention path.
 */
function _publishLeaseAtomically(leasePath, body) {
  // Same directory as the lease (never cross-device) and unique per process, so
  // two racers never collide on the staging name. The name deliberately does NOT
  // begin with LEASE_FILE_PREFIX: that prefix is exported for directory scans, so
  // a staging file carrying it could be swept up as if it were a lease.
  const tmpPath = path.join(
    path.dirname(leasePath),
    `${STAGING_FILE_PREFIX}${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  const cleanupTmp = () => {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      /* best-effort; a leftover is swept by _sweepStaleStaging on a later acquire */
    }
  };

  let tfd;
  try {
    tfd = fs.openSync(tmpPath, "wx", 0o600);
  } catch (e) {
    return {
      ok: false,
      code: (e && e.code) || "EIO",
      error: `staging create failed for ${tmpPath}: ${e && e.message ? e.message : String(e)}`,
    };
  }
  try {
    fs.writeFileSync(tfd, body, { encoding: "utf8" });
  } catch (e) {
    try {
      fs.closeSync(tfd);
    } catch (_) {
      /* fd may already be closed; the cleanup below is the load-bearing part */
    }
    cleanupTmp();
    return {
      ok: false,
      code: (e && e.code) || "EIO",
      error: `staging write failed for ${tmpPath}: ${e && e.message ? e.message : String(e)}`,
    };
  }
  try {
    fs.closeSync(tfd);
  } catch (_) {
    /* writeFileSync already issued the write; a close error cannot un-write it,
       and the link below is what decides whether we hold the lease. */
  }

  try {
    // THE test-and-set. EEXIST here === another racer holds the lease.
    //
    // `COC_TEST_FORCE_NO_HARDLINK=1` simulates a filesystem without `link(2)` so the degraded
    // branch below — and, more importantly, the OBSERVABILITY of that degradation at the caller —
    // is exercisable from an OUT-OF-PROCESS test on darwin/linux, where APFS/ext4 always have hard
    // links and the branch is otherwise unreachable. T-H/T-J stub `fs.linkSync` in-process, which
    // cannot reach a spawned hook; the production question ("is the degradation observable when the
    // worker's stderr is /dev/null?") can only be asked across a process boundary. Same established
    // `COC_TEST_*` seam idiom as `append-sink.js`'s `COC_TEST_FORCE_NO_NOFOLLOW` and this hook's own
    // `COC_TEST_FORCE_RELEASE`/`COC_TEST_SKIP_SIGN`.
    //
    // It is purely WEAKENING-toward-the-already-reachable, and that is stated rather than assumed:
    // it selects the SAME O_EXCL publish a link-less platform selects on its own, so it can only
    // move this host onto a path some real host already takes. It cannot disable the mutex (the
    // fallback still holds at-most-one — T-H) and it cannot suppress the breadcrumb (which is
    // exactly what the test asserts).
    //
    // CHANNEL RESIDUAL, scoped honestly — this seam is UNGATED and ships to every consumer. It is
    // read straight from `process.env` with no sanctioned-test-context predicate, exactly like the
    // rest of the family; the settings.json `env` CONTENT surface denylists the `COC_` prefix
    // (`settings-deny-guard-shape.js` § #1450 Class-C / #1471 F2), but a HOST/SHELL export is open
    // by documented design. So it belongs on loom#1450's shard-2 residual list — the read-site
    // gate that family still lacks — and is NOT gated here, because inventing a one-off predicate
    // for this seam alone is the enumeration treadmill #1450 shard 2 exists to end. Same disposition as
    // the `COC_TEST_FORCE_NO_NOFOLLOW` channel note in `append-sink.js` (~L189), which names the same
    // `COC_` prefix more briefly — the two agree on the prefix, not on phrasing, so read it for the
    // disposition rather than as a verbatim twin. (That note said `COC_TEST_` until loom#1544 F4; the
    // denylist entry it describes is and was `COC_`.)
    if (process.env.COC_TEST_FORCE_NO_HARDLINK === "1") {
      const e = new Error("link(2) disabled by COC_TEST_FORCE_NO_HARDLINK (test seam)");
      e.code = "ENOTSUP";
      throw e;
    }
    fs.linkSync(tmpPath, leasePath);
  } catch (e) {
    const code = (e && e.code) || "EIO";
    if (code !== "EEXIST" && NO_HARDLINK_CODES.has(code)) {
      // The filesystem does not support hard links at all (exFAT/FAT32, many
      // SMB/CIFS mounts, some FUSE + container volume drivers). DEGRADE to the
      // legacy O_EXCL create rather than failing.
      //
      // This branch exists because failing here is NOT the safe option, which is
      // the opposite of the intuition: `releaseOwnClaims` treats a non-contended
      // lease error as "proceed WITHOUT serialization" (its header contract —
      // sessionend must never block). So on such a filesystem a hard failure does
      // not merely narrow the mutex, it REMOVES it, deterministically, for every
      // SessionEnd — strictly worse than the birth-window race this publish path
      // was written to close, because `openSync(leasePath,"wx")` works fine there.
      // Trading a rare interleaving for a guaranteed no-mutex is a bad trade, so
      // the degraded path keeps the O_EXCL guarantee where link() cannot run.
      //
      // The degradation is REPORTED, never silent (zero-tolerance.md Rule 3). That
      // claim used to rest on the `degraded` field alone, which the one production
      // caller never reads — so it was false (#1544 F2). It now rests on TWO
      // surfaces: `_warnDegradedOnce` prints a loud one-time stderr WARN naming the
      // OFF protection and its wiring (security.md § "Secure-Default For A New
      // Security Feature"), and `degraded` is propagated onto the `acquireReleaseLease`
      // SUCCESS shape for a caller/telemetry that does inspect it.
      _warnDegradedOnce();
      cleanupTmp();
      let fd;
      try {
        fd = fs.openSync(leasePath, "wx", 0o600);
      } catch (e2) {
        return {
          ok: false,
          code: (e2 && e2.code) || "EIO",
          error: `publish (no-hardlink fallback) failed for ${leasePath}: ${e2 && e2.message ? e2.message : String(e2)}`,
        };
      }
      try {
        fs.writeFileSync(fd, body, { encoding: "utf8" });
      } catch (e2) {
        try {
          fs.closeSync(fd);
        } catch (_) {
          /* fd may already be closed; the unlink below is the load-bearing part */
        }
        try {
          fs.unlinkSync(leasePath);
        } catch (_) {
          /* best-effort — leaving it would EEXIST every future acquirer */
        }
        return {
          ok: false,
          code: (e2 && e2.code) || "EIO",
          error: `publish (no-hardlink fallback) write failed for ${leasePath}: ${e2 && e2.message ? e2.message : String(e2)}`,
        };
      }
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* content already written; the lease is held either way */
      }
      return { ok: true, degraded: "no-hardlink-support" };
    }
    cleanupTmp();
    return {
      ok: false,
      code,
      error: `publish link failed for ${leasePath}: ${e && e.message ? e.message : String(e)}`,
    };
  }
  // The lease is published and complete. Drop the staging name; the lease inode
  // survives (link count 2 → 1). A failure here leaks a staging file only.
  cleanupTmp();
  _sweepStaleStaging(path.dirname(leasePath));
  return { ok: true };
}

function _holderView(existing) {
  if (!existing || existing._corrupt || existing._unreadable) return null;
  return {
    verified_id: existing.verified_id,
    holder_pid: existing.holder_pid,
    acquired_at: existing.acquired_at,
    lease_id: existing.lease_id,
  };
}

// ---- public API ------------------------------------------------------------

/**
 * Acquire the per-emitter single-releaser lease keyed on `verifiedId`. The
 * ATOMIC O_EXCL create IS the serialization: exactly one same-emitter releaser
 * wins; a second gets EEXIST. _classifyLeaseLiveness and the tombstone witness
 * select one bounded reap attempt (PID verdict or old-unknown age policy), over
 * bytes and a witness taken from ONE descriptor (_readLeaseBound). Every publish
 * is preceded by _clearHeldCustody, so a held tombstone defers or is cleared.
 * Source: .claude/hooks/lib/sessionend-release-lease.js:393-465,588-616,856-859,882-935.
 *
 * @param {object} opts - { verifiedId, repoDir? }
 * @returns {{ok:true, lease, leasePath} | {ok:false, reason, ...}}
 */
function acquireReleaseLease(opts) {
  const o = opts || {};
  const verifiedId = o.verifiedId;
  const repoDir = o.repoDir || process.cwd();

  const idErr = _validateVerifiedId(verifiedId);
  if (idErr) return { ok: false, reason: "invalid-verified-id", error: idErr };

  const leasePath = _leasePath(repoDir, verifiedId);
  try {
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  } catch (e) {
    return {
      ok: false,
      reason: "lease-io-error",
      error: `acquireReleaseLease: cannot create state dir for ${leasePath}: ${e && e.message ? e.message : String(e)}`,
    };
  }

  // Up to 2 attempts: attempt 0 may reap a DEAD holder and retry; attempt 1
  // (post-reap) never reaps again (bounds the loop — a fresh EEXIST after our
  // reap means another acquirer won the race, which is genuine contention).
  for (let attempt = 0; attempt < 2; attempt++) {
    // HELD custody first (R2-S1): a tombstone that still holds a lease's bytes
    // means the name may be empty while its holder runs, so a publish there is
    // not evidence of exclusivity. _clearHeldCustody clears or defers.
    const custody = _clearHeldCustody(leasePath);
    if (!custody.ok) {
      return { ok: false, reason: "contended", holder: custody.holder, liveness: custody.liveness };
    }
    const lease = {
      lease_id: `sereleaselease_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      verified_id: verifiedId,
      verified_fingerprint: _fingerprint(verifiedId),
      holder_pid: process.pid,
      holder_token: _ownStartToken() || null,
      acquired_at: _isoTimestamp(),
      _version: 1,
    };
    // Stage-then-link — the atomic test-and-set. The lockfile's EXISTENCE is the
    // lock, and (unlike a bare O_EXCL create) it is COMPLETE the instant it
    // exists, so a concurrent acquirer can never sample it mid-birth and reap it
    // as `corrupt`. See _publishLeaseAtomically for the window this closes.
    const published = _publishLeaseAtomically(
      leasePath,
      JSON.stringify(lease, null, 2) + "\n",
    );
    if (!published.ok) {
      const e = { code: published.code, message: published.error };
      if (e.code === "EEXIST") {
        // Bytes and witness from ONE descriptor (_readLeaseBound), so the
        // classified holder and the inode the rename may move are the same file.
        const read = _readLeaseBound(leasePath);
        const existing = read.existing;
        const liveness = _classifyLeaseLiveness(read);
        if (liveness.reap_eligible && attempt === 0) {
          // Re-check the NAME still holds the classified inode before moving it,
          // then reclassify the moved file under its unique tombstone name;
          // _sameLeaseWitness rejects a replacement observed around the rename.
          const tombstone = `${leasePath}.reap-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
          let renamed = false;
          try {
            if (!_sameLeaseWitness(liveness.witness, _leaseWitness(leasePath))) {
              return { ok: false, reason: "contended", holder: _holderView(existing),
                liveness: { ..._publicLiveness(liveness), reap_eligible: false, age_reason: "witness-changed" } };
            }
            fs.renameSync(leasePath, tombstone);
            renamed = true;
          } catch (_) {
            /* lost the reap race (ENOENT) or IO error — fall through to defer */
          }
          if (!renamed) {
            // Another racer already moved the stale lease. DO NOT blind-create
            // — re-read + defer as contention (the winner will hold it).
            const now = _readLeaseBound(leasePath);
            return {
              ok: false,
              reason: "contended",
              holder: _holderView(now.existing),
              liveness: _publicLiveness(_classifyLeaseLiveness(now)),
            };
          }
          const movedRead = _readLeaseBound(tombstone);
          const moved = movedRead.existing;
          const movedLive = _classifyLeaseLiveness(movedRead);
          if (movedLive.reap_eligible && movedLive.state === liveness.state &&
            _sameLeaseWitness(liveness.witness, movedLive.witness) &&
            _sameLeaseWitness(liveness.witness, _leaseWitness(tombstone))) {
            try {
              fs.unlinkSync(tombstone);
            } catch (e) {
              // Cleared by another acquirer first: the reap is done either way.
              if (e && e.code === "ENOENT" && _tombstoneGone(tombstone)) continue;
              return { ok: false, reason: "contended", holder: _holderView(moved),
                liveness: { ..._publicLiveness(movedLive), reap_eligible: false,
                  heldTombstone: tombstone, tombstoneHeld: true, restore_reason: "reap-unlink-failed" } };
            }
            continue;
          }
          const restored = _restoreHeldTombstone(tombstone, leasePath, movedRead.bytes);
          return {
            ok: false,
            reason: "contended",
            holder: _holderView(moved),
            liveness: { ..._publicLiveness(movedLive), reap_eligible: false, ...restored },
          };
        }
        // A LIVE holder (or a fresh EEXIST after our reap) → genuine contention.
        return {
          ok: false,
          reason: "contended",
          holder: _holderView(existing),
          liveness: _publicLiveness(liveness),
        };
      }
      // Not EEXIST — a genuine IO failure (ENOSPC, EROFS, EACCES on the state
      // dir, …). Fail with a typed reason.
      //
      // This is NOT the no-hard-link case, and an earlier version of this comment
      // said it was (#1544 F2): it claimed the lib fails loudly here "rather than
      // falling back to a bare O_EXCL create", naming EPERM/ENOTSUP as an example.
      // `_publishLeaseAtomically` does exactly that fallback — those codes are in
      // NO_HARDLINK_CODES and are handled inside the publish, which returns
      // `{ok:true, degraded:"no-hardlink-support"}` and never reaches this branch.
      // The fallback is DELIBERATE and stays: `releaseOwnClaims` proceeds WITHOUT
      // serialization on a non-contended lease error (its header contract —
      // sessionend must never block), so hard-failing on a link-less filesystem
      // would not narrow the mutex, it would REMOVE it on every SessionEnd. The
      // remedy for the residual weakness is the loud one-time WARN, not a refusal.
      // See `_publishLeaseAtomically`'s NO_HARDLINK_CODES branch.
      //
      // Per the header contract the caller PROCEEDS best-effort on a
      // lease-io-error — sessionend is never blocked by the lease.
      return {
        ok: false,
        reason: "lease-io-error",
        error: `acquireReleaseLease: ${published.error}`,
      };
    }
    // Won the atomic publish: the lease at `leasePath` is already complete on
    // disk (attribution included), so there is no post-create write step and
    // therefore no orphan-on-write-failure case to clean up.
    //
    // `degraded` rides the SUCCESS shape (#1544 F2) — present only when the
    // publish fell back to the bare O_EXCL create on a link-less filesystem. The
    // lease IS held either way, so this is not a failure signal; it tells an
    // inspecting caller WHICH publish strategy ran, i.e. that the half-formed-lease
    // protection is off for this acquire.
    //
    // THIS FIELD IS THE REPORT — reading it is not optional (#1544 F2, round 2).
    // An earlier version of this comment said "the loud one-time WARN is emitted at
    // the point of degradation, so a caller that ignores this field is still
    // informed." That was FALSE for the production caller: `releaseOwnClaims` runs
    // in a worker spawned `stdio:"ignore"`, so that WARN goes to /dev/null (see
    // `_warnDegradedOnce` § SCOPE). `releaseOwnClaims` now reads this field and
    // writes a durable observation row; a future caller that drops that read
    // re-opens the silence, and no stderr write will substitute for it.
    return published.degraded
      ? { ok: true, lease, leasePath, degraded: published.degraded }
      : { ok: true, lease, leasePath };
  }
  // Exhausted attempts (reaped, then lost the create race to a live acquirer).
  const last = _readLeaseBound(leasePath);
  return {
    ok: false,
    reason: "contended",
    holder: _holderView(last.existing),
    liveness: _publicLiveness(_classifyLeaseLiveness(last)),
  };
}

/**
 * Release the per-emitter lease. With O_EXCL locking the lock IS the file's
 * existence, so release is UNLINK (a `_released` flag flip would leave the file
 * present → the next O_EXCL create EEXISTs forever). Idempotent. Requires the
 * lease to be held by THIS emitter AND THIS process (the acquirer releases it —
 * a different process cannot release someone else's in-flight lease).
 *
 * @param {object} opts - { verifiedId, repoDir? }
 */
function releaseReleaseLease(opts) {
  const o = opts || {};
  const verifiedId = o.verifiedId;
  const repoDir = o.repoDir || process.cwd();

  const idErr = _validateVerifiedId(verifiedId);
  if (idErr) return { ok: false, reason: "invalid-verified-id", error: idErr };

  const leasePath = _leasePath(repoDir, verifiedId);
  const existing = _safeReadJson(leasePath);
  if (existing === null) return { ok: true, noop: true, reason: "no-lease" };
  if (existing._unreadable) {
    return { ok: false, reason: "lease-io-error", error: existing._error };
  }
  if (existing._corrupt) {
    // Cannot verify ownership → refuse to clobber (never silently delete
    // another holder's lock; zero-tolerance.md Rule 3).
    return {
      ok: false,
      reason: "lease-corrupt",
      error: `releaseReleaseLease: lease file corrupt, cannot verify ownership before unlink: ${existing._error}`,
    };
  }
  if (existing.verified_id !== verifiedId) {
    return {
      ok: false,
      reason: "wrong-emitter",
      error: `releaseReleaseLease: lease held for '${existing.verified_id}', not '${verifiedId}'`,
    };
  }
  if (existing.holder_pid !== process.pid) {
    return {
      ok: false,
      reason: "wrong-owner",
      error: `releaseReleaseLease: lease held by pid ${existing.holder_pid}, not ${process.pid}`,
    };
  }
  try {
    fs.unlinkSync(leasePath);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return { ok: true, noop: true, reason: "already-released" };
    }
    return {
      ok: false,
      reason: "lease-io-error",
      error: `releaseReleaseLease: unlink failed for ${leasePath}: ${e && e.message ? e.message : String(e)}`,
    };
  }
  return { ok: true, lease: existing };
}

/**
 * Inspect the current lease state for `verifiedId`. Returns `{ lease }` (the
 * active lease when held) or `{ lease:null, ... }`. Surfaces corruption
 * explicitly. Read-only — does NOT reap.
 */
function readActiveReleaseLease(verifiedId, repoDir) {
  const idErr = _validateVerifiedId(verifiedId);
  if (idErr)
    return { lease: null, reason: "invalid-verified-id", error: idErr };
  const lp = _leasePath(repoDir || process.cwd(), verifiedId);
  const existing = _safeReadJson(lp);
  if (existing === null) return { lease: null, leasePath: lp };
  if (existing._unreadable) {
    return { lease: null, leasePath: lp, reason: "lease-io-error", error: existing._error };
  }
  if (existing._corrupt) {
    return {
      lease: null,
      leasePath: lp,
      reason: "lease-corrupt",
      error: existing._error,
    };
  }
  return {
    lease: existing,
    leasePath: lp,
    liveness: _classifyHolder(existing),
  };
}

module.exports = {
  acquireReleaseLease,
  releaseReleaseLease,
  readActiveReleaseLease,
  LEASE_FILE_PREFIX,
  // Test-only — NOT part of the supported API.
  // STAGING_FILE_PREFIX is exported test-only (never for directory scans, unlike
  // LEASE_FILE_PREFIX) so the gitignore-fence test derives the fenced path from
  // the REAL constant rather than restating the literal (#1544 F1).
  _test_STAGING_FILE_PREFIX: STAGING_FILE_PREFIX,
  _test_fingerprint: _fingerprint,
  _test_validateVerifiedId: _validateVerifiedId,
  _test_classifyHolder: _classifyHolder,
  _test_leasePath: _leasePath,
  _test_publishLeaseAtomically: _publishLeaseAtomically,
  // The one-time WARN latch is module-global by design (that IS the "once"). A
  // test asserting the WARN fires must clear it first, or the assertion depends
  // on which test ran earlier in the same process.
  _test_resetDegradedWarning: _resetDegradedWarning,
};
