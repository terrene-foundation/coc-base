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
 *   - `capability-lease.js::_tryAcquireOneMultiLease` — the ATOMIC test-and-set
 *     via `fs.openSync(path, "wx")` (O_WRONLY|O_CREAT|O_EXCL). A read-then-write
 *     mutex (the single-file `codify-lease.js` / `capability-lease.js` acquire
 *     path) is ITSELF a TOCTOU: two processes each `_safeReadJson`→null, each
 *     write, each believe they won. O_EXCL makes the CREATE the atomic
 *     test-and-set — the kernel guarantees exactly one open succeeds; every
 *     other gets EEXIST. Closing a read→append window with a read-then-write
 *     mutex would just move the window; O_EXCL is the primitive that closes it.
 *   - `coord-background.js::_foldHomedirLiveness` (the #867 pid-liveness reaper)
 *     — a crashed worker orphans its lease; the holder's `{pid, start-token}`
 *     marker lets the next acquirer classify DEAD (ESRCH / recycled PID /
 *     corrupt) and reap it, so a crash cannot deadlock every future SessionEnd.
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
 *     Result = { ok:true, lease:{...}, leasePath }
 *           | { ok:false, reason, error?, holder?, liveness? }
 *     reason ∈ { "contended", "invalid-verified-id", "lease-io-error" }
 *   releaseReleaseLease({ verifiedId, repoDir? }) -> { ok, ... }
 *     reason ∈ { "no-lease", "already-released", "wrong-emitter", "wrong-owner",
 *                "lease-corrupt", "invalid-verified-id", "lease-io-error" }
 *   readActiveReleaseLease(verifiedId, repoDir?) -> { lease | null, ... }
 *
 * The Result is the contract — releaseOwnClaims branches on `ok`: on `contended`
 * it DEFERS its releases (they linger to their claim TTL — the SAME safe
 * degradation Option A already accepts); on any other non-ok it PROCEEDS
 * best-effort (a lease IO error must never BLOCK sessionend — header contract).
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
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
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
      timeout: 2000,
    });
    const t = (out || "").trim();
    return t.length > 0 ? t : null;
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

/** Classify a lease's holder by its {holder_pid, holder_token} marker. Mirrors
 * coord-background.js::_foldHomedirLiveness. Only "dead" is reap-eligible.
 *   "dead"  — pid gone (ESRCH) / corrupt / no-pid / start-token mismatch (PID
 *             recycled) → reap regardless of age (the crash-orphan class).
 *   "alive" — pid alive (kill(pid,0) ok, or EPERM = alive-other-uid); a genuine
 *             in-flight releaser → contended, do NOT reap. */
function _classifyHolder(existing) {
  if (!existing || existing._corrupt) {
    return { state: "dead", reason: "corrupt-lease" };
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
  if (storedToken && liveToken) {
    return storedToken === liveToken
      ? { state: "alive", reason: "token-verified" }
      : { state: "dead", reason: "token-mismatch" }; // PID recycled
  }
  // Alive but the start-token could not be compared — a live process this
  // session; spare it (a live in-flight releaser is exactly what we serialize).
  return { state: "alive", reason: "token-unverified" };
}

function _holderView(existing) {
  if (!existing || existing._corrupt) return null;
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
 * wins; a second gets EEXIST. Before returning `contended`, a DEAD (crashed /
 * recycled-PID / corrupt) holder is reaped once (pid-liveness) so a crash cannot
 * deadlock every future SessionEnd.
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
    const lease = {
      lease_id: `sereleaselease_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      verified_id: verifiedId,
      verified_fingerprint: _fingerprint(verifiedId),
      holder_pid: process.pid,
      holder_token: _ownStartToken() || null,
      acquired_at: _isoTimestamp(),
      _version: 1,
    };
    let fd;
    try {
      // "wx" = O_WRONLY | O_CREAT | O_EXCL — the atomic test-and-set. The
      // lockfile's EXISTENCE is the lock; its content is attribution only.
      fd = fs.openSync(leasePath, "wx", 0o600);
    } catch (e) {
      if (e && e.code === "EEXIST") {
        const existing = _safeReadJson(leasePath);
        const liveness = _classifyHolder(existing);
        if (liveness.state === "dead" && attempt === 0) {
          // ATOMIC stale reap (sec-874). A plain `unlinkSync(leasePath)` is a
          // reap-race TOCTOU: between this classify-dead read and the unlink,
          // another racer can reap the SAME stale lease AND create a LIVE one at
          // the same path — an unconditional path-unlink then deletes that LIVE
          // lease, both racers `open("wx")` succeed, both emit seq=N+1 → the
          // exact fork this lib prevents. Reap via a UNIQUE-tombstone rename
          // instead: POSIX rename is atomic on the SOURCE, so exactly ONE racer
          // moves the file; every other racer's rename gets ENOENT and DEFERS
          // (never blind-creates). After winning the move we CONFIRM the
          // tombstone is the SAME dead lease we classified — if a live lease
          // slipped into the path in the window we restore it and defer. Any
          // ambiguity → defer, so at-most-one-releaser holds ACROSS the reap,
          // not merely on the no-crash path.
          const tombstone = `${leasePath}.reap-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
          let renamed = false;
          try {
            fs.renameSync(leasePath, tombstone);
            renamed = true;
          } catch (_) {
            /* lost the reap race (ENOENT) or IO error — fall through to defer */
          }
          if (!renamed) {
            // Another racer already moved the stale lease. DO NOT blind-create
            // — re-read + defer as contention (the winner will hold it).
            const now = _safeReadJson(leasePath);
            return {
              ok: false,
              reason: "contended",
              holder: _holderView(now),
              liveness: _classifyHolder(now),
            };
          }
          // We EXCLUSIVELY hold the tombstone. Confirm the file we moved is
          // STILL dead — the sufficient guard: a live lease that slipped into
          // the path in the classify→rename window classifies `alive` (its
          // holder pid is live), so we must NOT reap it. Re-classifying the
          // exclusively-held tombstone is race-free (no one else can touch our
          // uniquely-named tombstone). A dead file (crash-orphan OR corrupt —
          // no valid live holder) is safe to delete since we alone hold it.
          const moved = _safeReadJson(tombstone);
          const movedLive = _classifyHolder(moved);
          if (movedLive.state === "dead") {
            try {
              fs.unlinkSync(tombstone);
            } catch (_) {
              /* best-effort; the tombstone name is unique to this process */
            }
            continue; // reap confirmed → retry the atomic O_EXCL create
          }
          // The moved file is a LIVE lease (a holder slipped into the path in
          // the window). Restore it best-effort so its holder's release still
          // resolves, and DEFER — never recreate over a live lease.
          try {
            fs.renameSync(tombstone, leasePath);
          } catch (_) {
            /* the holder may already have recreated the path; leave the tombstone (gitignored) */
          }
          return {
            ok: false,
            reason: "contended",
            holder: _holderView(moved),
            liveness: movedLive,
          };
        }
        // A LIVE holder (or a fresh EEXIST after our reap) → genuine contention.
        return {
          ok: false,
          reason: "contended",
          holder: _holderView(existing),
          liveness,
        };
      }
      return {
        ok: false,
        reason: "lease-io-error",
        error: `acquireReleaseLease: open(O_EXCL) failed for ${leasePath}: ${e && e.message ? e.message : String(e)}`,
      };
    }
    // Won the atomic create. Write attribution + close. On a post-create write
    // failure, unlink so the just-created lock is not orphaned in-process (the
    // capability-lease.js MED-1 discipline — keeps "only an out-of-process crash
    // orphans" accurate).
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
        /* best-effort */
      }
      return {
        ok: false,
        reason: "lease-io-error",
        error: `acquireReleaseLease: write failed for ${leasePath} (lockfile unlinked, no orphan): ${e && e.message ? e.message : String(e)}`,
      };
    }
    fs.closeSync(fd);
    return { ok: true, lease, leasePath };
  }
  // Exhausted attempts (reaped, then lost the create race to a live acquirer).
  const existing = _safeReadJson(leasePath);
  return {
    ok: false,
    reason: "contended",
    holder: _holderView(existing),
    liveness: _classifyHolder(existing),
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
  _test_fingerprint: _fingerprint,
  _test_validateVerifiedId: _validateVerifiedId,
  _test_classifyHolder: _classifyHolder,
  _test_leasePath: _leasePath,
};
