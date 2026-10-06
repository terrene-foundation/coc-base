"use strict";
/**
 * roster-write — THE single durable writer for `.claude/operators.roster.json`.
 *
 * WHY THIS EXISTS. The roster is the `person_id → role → enrolled-keys` binding
 * every signature check resolves against. It had THREE independent writers and
 * all three truncated in place:
 *
 *   .claude/hooks/lib/add-key-ceremony.js   fs.writeFileSync(rosterPath, ...)
 *   .claude/bin/coc-roster-register.mjs     fs.writeFileSync(rosterPath, ...)
 *   .claude/bin/clean-instantiate.mjs       writeFileSync(rosterPath, ...)
 *
 * `writeFileSync` opens the TARGET with O_TRUNC: the live roster is destroyed
 * BEFORE the replacement bytes land. Two failure modes followed.
 *
 *   (A) NON-ATOMIC. A crash inside that window leaves a truncated roster. Every
 *       loader in the corpus fails closed on unparseable JSON, and the
 *       composite integrity guard then refuses EVERY integrity-critical write
 *       in the repo — a self-inflicted repo-wide wedge. The roster is
 *       git-tracked so `git checkout` recovers it, but recovery-by-VCS is not
 *       an atomicity argument: it is what you reach for after the invariant
 *       already broke.
 *
 *   (B) READ-MODIFY-WRITE RACE. `add-key-ceremony` and `coc-roster-register`
 *       both read-whole → mutate → write-whole with no lock and no
 *       compare-and-swap. Two concurrent enrollments → last write wins → one
 *       operator's newly enrolled signing key is silently discarded WHILE THE
 *       CEREMONY REPORTS SUCCESS. That is the worst shape available: the
 *       operator believes they can sign, and the key that would let them is
 *       gone.
 *
 * ── WHICH EXISTING HELPER, AND WHY ──────────────────────────────────────────
 *
 * Two candidates already existed in this repo. The choice is NOT arbitrary and
 * is recorded here so it is not silently re-litigated:
 *
 *   `capability-lease.js::_atomicWriteJson` — REJECTED. It is (1) PRIVATE, not
 *   exported, and (2) ALREADY COPIED: a byte-similar twin lives at
 *   `codify-lease.js:637`. Adopting it here would have made a THIRD copy, which
 *   is precisely the drift `security.md` § Enforcement-Surface Parity blocks —
 *   the rule asks for one shared function, and that helper is already evidence
 *   of what happens when you copy instead. It is also the WEAKER of the two: a
 *   plain `writeFileSync` to a tmp name with no symlink, hard-link, or
 *   short-write protection.
 *
 *   `state-io.js::writeFileHardened` — CHOSEN. It is EXPORTED, and its export
 *   comment states the reason verbatim: "a second writer of durable trust state
 *   must route through THIS open(2) flag set ... rather than re-deriving it",
 *   citing `security.md` § Multi-Site Kwarg Plumbing. It already has an
 *   external ESM caller (`.claude/bin/trust-ledger-excise.mjs`), so the
 *   cross-module-system consumption path is proven rather than assumed. It is
 *   strictly stronger: O_CREAT|O_EXCL|O_NOFOLLOW, an lstat classification that
 *   refuses a symlink / FIFO / hard-linked target, `fchmod` on the HELD fd, a
 *   short-write loop, and an fsync. The roster is durable trust state — exactly
 *   the category that export designates.
 *
 * We do NOT call `writePosture` itself: it is posture-SPECIFIC (it validates a
 * posture enum, maintains `posture.json.bak`, and touches an init marker). We
 * take its two exported primitives and its tmp→rename shape, not its policy.
 *
 * NO WRITE-AHEAD `.bak`. `writePosture` keeps one because `posture.json` is
 * untracked and has no other copy. The roster is git-tracked, and a
 * `.claude/operators.roster.json.bak` would be a NEW untracked file holding a
 * full copy of operator identity — a disclosure surface the sync and scrub
 * fences do not currently enumerate. Atomic rename already makes the truncated
 * state unreachable, so the `.bak` would buy nothing and cost a leak class.
 *
 * ── WHAT IS CLOSED, AND WHAT IS NOT ─────────────────────────────────────────
 *
 * CLOSED (A): the target is never opened for writing. Bytes land in a tmp file
 * in the SAME directory (same filesystem, so `rename(2)` is atomic), and the
 * roster path is replaced by a single rename. A crash at any instant leaves
 * either the whole old roster or the whole new one.
 *
 * CLOSED (B), for cooperating writers: an O_EXCL lock serializes the
 * read-modify-write section, and a compare-and-swap on the pre-image BYTES
 * refuses when the file changed under us. The CAS is the part that also catches
 * a NON-cooperating writer — a hand edit, a `git checkout`, or any future
 * fourth writer that skips this module.
 *
 * NOT CLOSED, stated rather than implied: a non-cooperating writer that renames
 * its own file into place inside the window between our CAS read and our
 * rename. Nothing re-validates in that window. This is the SAME residual
 * `state-io.js::writePosture` documents at its own rename ("an attempted race
 * did not win in 4000 tries, but 'narrow' is not 'closed'"), and closing it
 * needs fd-relative `renameat`-class primitives Node does not expose
 * synchronously — see `security.md` § Path Containment's accepted residual.
 *
 * MODE. `writeFileHardened` fchmods to 0o600, so a roster rewritten by a
 * ceremony ends up 0600 where a fresh `git checkout` leaves it 0644. Git records
 * only the exec bit, so this produces NO diff and no mode churn in the index.
 * The tightening is deliberate and matches every other durable-trust-state file
 * in this repo (`posture.json`, the lease files).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { writeFileHardened, readFileHardened, assertStateDirContained } = require("./state-io.js");

/** Distinct codes — a caller that only checks `ok === false` cannot tell a
 *  CONTENDED write from a CLOBBERED one, and those need different remedies. */
const ROSTER_WRITE_CODES = {
  CONTAINMENT: "roster-containment",
  LOCK_CONTENDED: "roster-lock-contended",
  CAS_MISMATCH: "roster-cas-mismatch",
  CAS_UNSAFE: "roster-cas-unsafe",
  PREIMAGE_UNREADABLE: "roster-preimage-unreadable",
  WRITE_FAILED: "roster-write-failed",
};

const LOCK_SUFFIX = ".lock";
const TMP_PREFIX = ".operators.roster.json.tmp.";
/** A ceremony's read-modify-write section is milliseconds of synchronous work.
 *  30s is ~4 orders of magnitude of headroom, so anything older is a crash
 *  orphan rather than a live holder. */
const LOCK_STALE_MS = 30_000;

/**
 * Read the roster's CURRENT bytes. Distinguishes ABSENT (first write) from
 * UNREADABLE (a planted symlink / FIFO / permissions) — collapsing those two
 * would let an unreadable roster be silently treated as "no roster yet" and
 * clobbered, which is `zero-tolerance.md` Rule 3's silent-fallback shape.
 */
function readRosterBytes(rosterPath) {
  // Through `state-io.js::readFileHardened` — the SAME module this file already takes its
  // hardened WRITER from, and the lane's read-side twin of the ESM
  // `identity-scrub.mjs::readRegularFileNoFollow` (lstat classification, then
  // O_RDONLY|O_NOFOLLOW|O_NONBLOCK and an fstat regular-file check on the HELD fd). The CJS
  // sibling is used rather than the ESM lib because this file is CommonJS and is `require`d
  // synchronously by hooks; it is not an inline re-derivation. It was a plain `readFileSync`,
  // which BLOCKED FOREVER on a FIFO planted at the roster path (the CAS read runs under the
  // roster lock, so the hang also wedged every later cooperating writer) and FOLLOWED a symlink.
  // ABSENT keeps its meaning: ENOENT is the first-write case. Everything else — FIFO, symlink,
  // directory, permissions — is PREIMAGE_UNREADABLE, exactly the disposition the header names.
  const r = readFileHardened(rosterPath);
  if (r.ok) return { ok: true, absent: false, bytes: r.value.toString("utf8") };
  if (r.code === "ENOENT") return { ok: true, absent: true, bytes: null };
  return {
    ok: false,
    code: ROSTER_WRITE_CODES.PREIMAGE_UNREADABLE,
    reason: `cannot read roster pre-image at ${rosterPath}: ${r.reason}`,
  };
}

/**
 * Atomic test-and-set via O_EXCL exclusive-create. A plain
 * `existsSync ? bail : create` is a TOCTOU: two processes can both see absent
 * and both believe they won. O_EXCL makes the kernel the arbiter — exactly one
 * create succeeds, every other gets EEXIST.
 *
 * A crash orphan is stolen ONCE, and staleness is decided from the timestamp
 * EMBEDDED in the lock body rather than the filesystem mtime, because mtime is
 * not a monotonic source (NTP step, manual clock set, network-mount skew) and a
 * backward jump could make a LIVE lock look stale. A FUTURE-dated ts is
 * rejected and falls back to mtime, so a crafted timestamp cannot pin the lock
 * as never-stale. This mirrors `session-notes-layout.js::_acquireMigrateLock`.
 */
function acquireRosterLock(rosterPath, _retried) {
  const lockPath = rosterPath + LOCK_SUFFIX;
  try {
    const fd = fs.openSync(
      lockPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      fs.writeSync(fd, `pid=${process.pid} ts=${new Date().toISOString()}\n`);
    } finally {
      fs.closeSync(fd);
    }
    let released = false;
    return {
      ok: true,
      lockPath,
      release() {
        if (released) return;
        released = true;
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* Best-effort. A leftover lock is stale-stolen by the next writer;
             throwing here would mask the ceremony's own result. */
        }
      },
    };
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      return {
        ok: false,
        code: ROSTER_WRITE_CODES.LOCK_CONTENDED,
        reason: `roster lock at ${lockPath}: ${err && err.message}`,
      };
    }
    if (_retried) {
      return {
        ok: false,
        code: ROSTER_WRITE_CODES.LOCK_CONTENDED,
        reason:
          `another roster write holds ${lockPath} and it is not stale — ` +
          `refusing rather than racing it`,
      };
    }
    let ageMs = NaN;
    try {
      // Through `state-io.js::readFileHardened` — the SAME helper this module's own
      // pre-image read already takes (`readRosterBytes` above). A plain `readFileSync`
      // here is exactly the asymmetry this file's header warns about: the hardened
      // pattern in one place and the plain one beside it. The lock is `<rosterPath>.lock`
      // — the same plantable `.claude/` directory — and a planted FIFO does NOT divert at
      // the `O_EXCL` create above, because that fails fast with EEXIST for ANY existing
      // entry, a FIFO included. So the hang landed HERE, on the stale-lock probe, and the
      // `catch` below could never reach it. MEASURED: reverting this read alone wedges
      // `writeRosterAtomic` (killed by SIGKILL) with the roster lock unreleased.
      const lockRead = readFileHardened(lockPath);
      if (!lockRead.ok) {
        throw Object.assign(new Error(lockRead.reason), { code: lockRead.code });
      }
      const body = lockRead.value.toString("utf8");
      const m = body.match(/\bts=(\S+)/);
      const embeddedMs = m ? Date.parse(m[1]) : NaN;
      if (Number.isFinite(embeddedMs) && embeddedMs <= Date.now()) {
        ageMs = Date.now() - embeddedMs;
      } else {
        // Falls back to the PATH's mtime. Reached only when the hardened read already
        // confirmed a regular file, and `stat` never blocks on a FIFO, so this cannot
        // reintroduce the hang; a path that no longer stats leaves `ageMs` NaN, which the
        // caller already reads as "not stale enough to steal" — fail-closed, unchanged.
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      }
    } catch {
      // An unreadable / irregular lock is NOT stealable: `ageMs` stays NaN, so the
      // caller refuses with LOCK_CONTENDED rather than unlinking an attacker's entry.
      ageMs = NaN;
    }
    if (!(ageMs > LOCK_STALE_MS)) {
      return {
        ok: false,
        code: ROSTER_WRITE_CODES.LOCK_CONTENDED,
        reason: `another roster write holds ${lockPath} (age ${ageMs}ms)`,
      };
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* Lost the steal to another reaper — the retry below will see its lock. */
    }
    return acquireRosterLock(rosterPath, true);
  }
}

/**
 * Reap orphan tmp files left by a CRASHED writer.
 *
 * MEASURED, not hypothetical: a SIGKILL between the tmp write and the rename
 * cannot run the `finally` that would clean up, so the tmp file survives
 * forever. It is inert — the roster itself is intact, which is the whole point
 * of the rename — but it is untracked debris in `.claude/` that accumulates one
 * file per crash, and nothing else in the repo reaps it.
 *
 * Called ONLY while holding the lock, which is what makes an mtime test sound
 * here: no OTHER cooperating writer can hold an in-flight tmp while we hold the
 * lock, so a tmp older than the stale floor is definitionally an orphan rather
 * than a live write we might be racing. Best-effort throughout — a reap failure
 * must never mask the caller's actual write result.
 */
function reapOrphanTmps(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.lstatSync(full);
      // Regular files only: never follow or unlink through a planted link.
      if (!st.isFile()) continue;
      if (now - st.mtimeMs > LOCK_STALE_MS) fs.unlinkSync(full);
    } catch {
      /* raced away, or not ours to remove — either way, not our problem */
    }
  }
}

/**
 * Write the roster atomically, under a lock, with a compare-and-swap on the
 * pre-image bytes.
 *
 * @param {object}      o
 * @param {string}      o.rosterPath   absolute path to operators.roster.json
 * @param {object}      o.roster       the POST-image object to serialize
 * @param {string|null} o.expectBytes  the EXACT bytes this caller read before
 *                                     mutating. The CAS compares against these.
 * @param {boolean}    [o.allowClobber] explicit opt-out of the CAS, for a
 *                                     ceremony that intends to REPLACE whatever
 *                                     is on disk (the clean-instantiate CLEAR).
 *                                     Required when `expectBytes` is null, so a
 *                                     caller cannot skip the CAS by ACCIDENT.
 * @returns {{ok:true,bytes:string}|{ok:false,code:string,reason:string}}
 */
function writeRosterAtomic(o) {
  const { rosterPath, roster } = o;
  const expectBytes = o.expectBytes === undefined ? null : o.expectBytes;
  const allowClobber = o.allowClobber === true;

  // Fail CLOSED on a caller that supplied neither a pre-image nor an explicit
  // clobber. Defaulting to "no CAS" would reintroduce (B) silently for every
  // future caller — the un-wired-default shape `security.md` § Secure-Default
  // For A New Security Feature blocks.
  if (expectBytes === null && !allowClobber) {
    return {
      ok: false,
      code: ROSTER_WRITE_CODES.CAS_UNSAFE,
      reason:
        "writeRosterAtomic called with no `expectBytes` pre-image and no explicit " +
        "`allowClobber: true` — refusing a write that could silently discard a " +
        "concurrent enrollment",
    };
  }

  const dir = path.dirname(rosterPath);
  // Ancestor containment BEFORE anything else: a symlinked `.claude` redirects
  // the tmp write AND the rename into attacker storage while every
  // final-component guard reports success (`security.md` § Path Containment —
  // resolve BOTH candidate and boundary root through the same resolver).
  const contained = assertStateDirContained(dir);
  if (!contained.ok) {
    return { ok: false, code: ROSTER_WRITE_CODES.CONTAINMENT, reason: contained.reason };
  }

  const lock = acquireRosterLock(rosterPath);
  if (!lock.ok) return lock;
  try {
    reapOrphanTmps(dir);
    if (expectBytes !== null) {
      const current = readRosterBytes(rosterPath);
      if (!current.ok) return current;
      if (current.bytes !== expectBytes) {
        return {
          ok: false,
          code: ROSTER_WRITE_CODES.CAS_MISMATCH,
          reason:
            `roster at ${rosterPath} changed between this ceremony's read and its write ` +
            `(${current.absent ? "it is now ABSENT" : `${current.bytes.length} bytes on disk vs ${expectBytes.length} read`}). ` +
            `Writing would silently discard the other writer's change. NOTHING was written — re-run against the current roster.`,
        };
      }
    }

    const bytes = JSON.stringify(roster, null, 2) + "\n";
    // Tmp in the SAME directory: `rename(2)` is atomic only within one
    // filesystem, so a tmp under os.tmpdir() would degrade to a copy and
    // reintroduce (A).
    const tmp = path.join(
      dir,
      `.operators.roster.json.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`,
    );
    const wrote = writeFileHardened(tmp, bytes, { replaceExisting: false });
    if (!wrote.ok) {
      return {
        ok: false,
        code: ROSTER_WRITE_CODES.WRITE_FAILED,
        reason: `roster tmp write at ${tmp}: ${wrote.reason}`,
      };
    }
    try {
      fs.renameSync(tmp, rosterPath);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* leave no half-written tmp behind on a best-effort basis */
      }
      return {
        ok: false,
        code: ROSTER_WRITE_CODES.WRITE_FAILED,
        reason: `roster rename ${tmp} → ${rosterPath}: ${err && err.message}`,
      };
    }
    return { ok: true, bytes };
  } finally {
    lock.release();
  }
}

module.exports = {
  writeRosterAtomic,
  readRosterBytes,
  ROSTER_WRITE_CODES,
  // Test-only — NOT part of the supported API.
  _test_acquireRosterLock: acquireRosterLock,
  _test_LOCK_STALE_MS: LOCK_STALE_MS,
  _test_LOCK_SUFFIX: LOCK_SUFFIX,
  _test_TMP_PREFIX: TMP_PREFIX,
  _test_reapOrphanTmps: reapOrphanTmps,
};
