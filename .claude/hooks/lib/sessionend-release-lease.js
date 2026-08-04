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
 *     a zero-byte file — which `_safeReadJson`/`_classifyHolder` read as
 *     `corrupt` ⇒ **dead** ⇒ reap-eligible, so a racer could reap a lease that
 *     was being born and both would hold it. `link()` publishes a fully-written
 *     inode, so that window does not exist. See `_publishLeaseAtomically`.
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
 * RESIDUAL, stated rather than glossed: in the detached worker this WARN is unconditionally
 * discarded, and so are the sibling `process.stderr.write` advisories in `releaseOwnClaims`
 * (the contended-lease and lease-io-error notices). Those two are pre-existing, out of scope
 * here, and NOT to be cited as production observability either — the same instrument fault,
 * still open. Only the `degraded` breadcrumb has a durable channel today.
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
        "concurrent acquirer sampling it in that window classifies it `corrupt` ⇒ dead ⇒ " +
        "reap-eligible, so BOTH releasers can end up holding it and the per-emitter chain can " +
        "fork. The half-formed-lease protection is OFF here; it is restored by putting the " +
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

/**
 * Publish a COMPLETE lease file at `leasePath` as the atomic test-and-set.
 *
 * WHY NOT `openSync(leasePath, "wx")` DIRECTLY (sec-874 follow-up): O_EXCL makes
 * the NAME appear atomically, but the CONTENT is written afterwards, so between
 * the open and the write the lease is observable as a ZERO-BYTE file. Every
 * reader in this module funnels through `_safeReadJson` → `_classifyHolder`,
 * and a zero-byte file parses as `{_corrupt:true}`, which classifies **dead** —
 * i.e. REAP-ELIGIBLE. A concurrent acquirer that sampled the path inside that
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
