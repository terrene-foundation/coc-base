/**
 * durable-io — the ONE shared durable-IO primitive set: byte and object custody for every
 * writer, appender, lock holder, claimer and own-child signaller that must not lose, alias,
 * double-spend or misattribute content.
 *
 * WHY ONE MODULE. Each writer in this tree grew its own copy of "open, write, rename" and each
 * copy drifted: an O_TRUNC write into an inode a hard link shared, an append that returned ok
 * over a torn tail, a lock whose holder was declared dead because its timestamp was old, a
 * receipt consumed by re-resolving a pathname that had been swapped. The fix for that class is
 * not a better copy — it is a single primitive per obligation, so a consumer cannot hold the
 * guarantee half-way (`rules/security.md` § Multi-Site Kwarg Plumbing; the dual halves of one
 * contract live in one place).
 *
 * WHAT IT GRANTS — AND WHAT IT DOES NOT. Byte/object custody only. It grants no role, lease,
 * quorum, signature, review approval or permission to execute; domain validation callbacks a
 * caller passes in must be that caller's real production verifiers. A durable use record is not
 * evidence a host tool ran.
 *
 * ## The backend is qualified, never assumed
 *
 * `qualifyBackend` MEASURES the host before any primitive will act: platform, the filesystem
 * holding the root (it must be a recognised LOCAL type — network and unrecognised types refuse),
 * and, inside a private probe directory it removes again, exclusive create, O_NOFOLLOW refusal,
 * no-replace link, replacing rename, O_APPEND, file fsync and directory fsync. It also measures
 * the process-instance identity this host can supply. Every primitive re-checks that the
 * qualified root is still the same directory (dev, ino, canonical path) and refuses a STALE
 * backend. Only the `cooperating-participants` threat model is supported: every mutator of a
 * shared sink uses this protocol; an arbitrary same-uid non-participant can still interfere
 * between a check and the syscall that follows it, because Node exposes no `openat`/`renameat2`
 * class primitive to bind the two. That residual is stated, not hidden (`append-sink.js` names
 * the same limit for its append path in its header's residual list, (a) through (e)).
 *
 * ## Process liveness comes from the PROCESS TABLE — no kill() of any kind
 *
 * An owner token is host id + boot id + pid namespace + uid + pid + kernel start identity +
 * nonce. Liveness is read from the process table, never probed with a signal (not even 0):
 *   - Linux: `/proc/<pid>/stat` start time (clock ticks since boot) with
 *     `/proc/sys/kernel/random/boot_id`, `/proc/self/ns/pid` and `/etc/machine-id`. The process
 *     table is used only when `/proc/self` names this process (a `/proc` mounted for another pid
 *     namespace lists different processes under the same numbers), and an owner of another uid
 *     is never judged when `hidepid` may hide it.
 *   - Darwin: the absolute-path `ps` (setuid root, sees every process) run with a FIXED
 *     environment — `LC_ALL=C` and `TZ=UTC`, because `lstart` is printed in the caller's locale
 *     and local time, so two processes in different zones would otherwise disagree about the
 *     same start — plus `kern.bootsessionuuid` and `IOPlatformUUID`.
 * Darwin's `lstart` has ONE-SECOND resolution. That can only err toward LIVE: DEAD is concluded
 * solely from absence, a different start, a zombie state, or a previous boot of this same host,
 * so a pid reused within the same second reads LIVE and costs liveness (the lock waits), never
 * safety (a live owner is never superseded). Foreign-host, other-namespace, unknown-kind and
 * unreadable observations are UNDETERMINED and are never taken over.
 *
 * The one signal path in this module is `signalOwnChild`, which re-verifies the child's pid,
 * start, command line and parent immediately before delivering, logs before and after, and
 * waits for the exit. The re-verification and the delivery run in ONE synchronous stretch: Node
 * reaps a child only on an event-loop turn, so between them the pid is either the live child or
 * its unreaped zombie and cannot have been reused. Measurement tools (`ps`, `sysctl`, `ioreg`,
 * `mount`) are spawned through `execFileSync` with a timeout; on a hung tool Node terminates that
 * just-spawned, still-unreaped measurement child — the module itself calls no kill().
 *
 * ## Contract — every primitive returns a typed result and never throws on an IO outcome
 *
 *   status   COMMITTED | REFUSED | UNDETERMINED (lock, probe and process primitives name their
 *            own states, listed below)
 *   effects  NONE (no canonical effect — scratch named in `cleanup`) | DURABLE |
 *            UNDETERMINED (an effect happened or may have, and its durability is unknown)
 *   code     one of CODES; `before`/`after`/`cleanup`/`receipt` say what was observed.
 * COMMITTED only after every required phase verified. Post-effect sync, publish, readback or
 * close ambiguity is UNDETERMINED with the observed effect — never a fabricated NONE. No
 * automatic rollback and no retry that could duplicate a use or an append.
 *
 * ## Public API — the ground truth is the `module.exports` block at the end of this file
 *
 *   qualifyBackend({ root, platform?, filesystem?, threatModel? })
 *     → QUALIFIED{backend} | UNSUPPORTED{code, missing, measured} | UNDETERMINED{code}
 *   ensureDirectory({ backend, dir, mode, create })          contained mkdir; returns a pinned handle
 *     → COMMITTED{handle, created} | REFUSED | UNDETERMINED
 *   probe({ dirHandle, name, followLeaf:false })
 *     → PRESENT{kind, identity} | ABSENT{cause:'ENOENT', scope} | UNDETERMINED{code, retryable}
 *   replaceFile({ dirHandle, leafName, bytes, expectedEntry, mode, lock?, validateCommit?, durability:'required' })
 *   appendRecord({ dirHandle, leafName, frame, lock, maxFrameBytes, createMode, expectedTail?,
 *                  validateTail?, validateCommit?, durability:'required' })
 *   unlinkIfUnchanged({ dirHandle, name, expected:{identity, sha256}, lock })
 *   removeEmptyDir({ dirHandle, name, expected:{dev, ino}, lock? })
 *   claimOnce({ candidates, custodyHandle, completeCallDescriptor, maxBytes, validateReceipt,
 *               validatePolicy, commitUse })
 *     → COMMITTED{grantToken, claimId, callDigest, objectIdentity, contentDigest, useCommit}
 *       | ABSENT{observations} | REFUSED{code, conservation} | UNDETERMINED{code, heldClaim}
 *   acquireLock({ dirHandle, key, deadlineMs, pollMs?, label? })
 *     → HELD{handle, receipt} | BUSY{holder, liveness} | OCCUPIED_INVALID{preserved}
 *       | UNDETERMINED{code, holder?} | UNSUPPORTED{code} | REFUSED{InputInvalid}
 *   probeOwner({ backend, owner })                     → LIVE | DEAD | UNDETERMINED (with evidence)
 *   verifyLockOwnership({ handle })                     → OWNED | REFUSED_STALE | REFUSED_UNKNOWN
 *   withOwnedStep({ handle, operation, expectedContentIdentity? })
 *     → DURABLE{result} | REFUSED_STALE | REFUSED_UNKNOWN | IO_UNDETERMINED{retainedEvidence}
 *   releaseLock({ handle })
 *     → RELEASED | ALREADY_RELEASED{positiveEvidence} | REFUSED_STALE | REFUSED_UNKNOWN | IO_UNDETERMINED
 *   recordOwnChild({ backend, child })                  → RECORDED{record} | REFUSED | UNDETERMINED
 *   signalOwnChild({ backend, child, record, signal, log, awaitExitMs })   (async)
 *     → SIGNALLED{delivered, exited} | REFUSED | UNDETERMINED
 *
 * TEST SEAMS — `__racePoint(name, ctx)` is called at named interleaving points and `__fs` replaces
 * the node:fs object for a call's own IO steps (validation of the backend and handles always uses
 * the real filesystem). `qualifyBackend` also accepts `__measure.{filesystem, identity}` and
 * `probeOwner` `__readProcess`. They exist so each refusal pole is deterministic in a test; a
 * caller passing them gains nothing it could not do without this module.
 *
 * ## The lock, on disk
 *
 * `<dir>/<key>.dio-lock/` is a permanent anchor directory. Ownership of generation N is the file
 * `gN.owner`, published complete by `link(2)` from a fully-written, fsynced stage — link fails
 * with EEXIST, so publication is an atomic no-replace test-and-set that never exposes a
 * half-written record. Release is `gN.released`, published the same way. The holder is the
 * owner of the HIGHEST generation while that generation has no release marker. Superseding a positively dead
 * owner creates generation N+1; it never deletes or replaces gN, so two contenders cannot both
 * win (the second link gets EEXIST) and no unlink can ever remove a successor. Ownership is
 * re-verified (record bytes and inode intact, no release, no higher generation) immediately
 * before every destructive step this module performs. Generations older than the two before the
 * current one are pruned by the holder; a stage left by a crashed acquirer is removed only once
 * its process is positively dead.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { resolveTrustedTool, TOOL_ENV } = require("./orphan-forest.js");

// ── constants ────────────────────────────────────────────────────────────────

const O = fs.constants;
const O_NOFOLLOW = O.O_NOFOLLOW || 0;
const O_DIRECTORY = O.O_DIRECTORY || 0;
const O_NONBLOCK = O.O_NONBLOCK || 0;

const THREAT_MODEL = "cooperating-participants";
const SUPPORTED_PLATFORMS = new Set(["linux", "darwin"]);

/** Capabilities every QUALIFIED backend has measured true. */
const BASE_CAPABILITIES = Object.freeze([
  "localFilesystem",
  "noFollow",
  "directoryOpen",
  "exclusiveCreate",
  "linkNoReplace",
  "renameReplace",
  "fileSync",
  "dirSync",
  "appendMode",
]);

/**
 * Filesystem types recognised as LOCAL per platform. Anything else — a network filesystem, or a
 * type this list does not name — refuses: an unrecognised type is never assumed to give local
 * rename/link/fsync semantics. Add a type here deliberately, with a measurement, never by default.
 */
const LOCAL_FS = Object.freeze({
  linux: new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "tmpfs", "zfs", "f2fs", "overlay", "bcachefs"]),
  darwin: new Set(["apfs", "hfs"]),
});

const CODES = Object.freeze([
  "InputInvalid",
  "UnsupportedGuarantee",
  "BackendUnqualified",
  "PreimageChanged",
  "AuthorityRefused",
  "AuthorityUndetermined",
  "LockLost",
  "IdentityChanged",
  "OccupiedInvalid",
  "OwnerUnknown",
  "Busy",
  "ShortWrite",
  "TornTail",
  "UnreadableTail",
  "FileSyncFailed",
  "PublishFailed",
  "DirSyncFailed",
  "ReadbackFailed",
  "CloseFailed",
  "CleanupFailed",
  "UnresolvedBoundary",
  "Absent",
  "NotEmpty",
  "NotDirectory",
  "NotRunning",
]);

const RETRYABLE_ERRNO = new Set(["EMFILE", "ENFILE", "EAGAIN", "EINTR", "EBUSY"]);
const TERMINATION_SIGNALS = new Set(["SIGTERM", "SIGINT", "SIGKILL", "SIGHUP"]);

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ANCHOR_SUFFIX = ".dio-lock";
const ENTRY_RE = /^g([1-9][0-9]{0,14})\.(owner|released)$/;
const STAGE_RE = /^\.stage\.[0-9]+\.[0-9a-f]{16}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const OWNER_SCHEMA = "durable-io/lock-owner/v1";
const RELEASE_SCHEMA = "durable-io/lock-release/v1";
const LOCK_RECORD_MAX_BYTES = 4096;
const LOCK_KEEP_PREVIOUS = 2;
const LOCK_PRUNE_BUDGET = 16;
const LOCK_LINK_RACE_RETRIES = 8;
const TOOL_TIMEOUT_MS = 3000;
const TOOL_ENV_UTC = Object.freeze({ ...TOOL_ENV, TZ: "UTC" });

// Handles are honoured only when THIS module issued them: a hand-built object claiming to be a
// qualified backend or a held lock is refused rather than trusted for its shape.
const ISSUED_BACKENDS = new WeakSet();
const ISSUED_DIRS = new WeakSet();
const ISSUED_LOCKS = new WeakSet();
const QUALIFIED_CACHE = new Map();

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const NL = 0x0a;

// ── small helpers ────────────────────────────────────────────────────────────

const hex = (n) => crypto.randomBytes(n).toString("hex");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const errCode = (e) => (e && typeof e.code === "string" ? e.code : "IoUndetermined");
const nowIso = () => new Date().toISOString();
const fsOf = (opts) => (opts && opts.__fs && typeof opts.__fs === "object" ? opts.__fs : fs);
const currentUid = () => (typeof process.getuid === "function" ? process.getuid() : null);

function sleepMs(ms) {
  if (ms > 0) Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

function race(opts, name, ctx) {
  if (opts && typeof opts.__racePoint === "function") opts.__racePoint(name, ctx);
}

function idOfStat(st) {
  return { dev: String(st.dev), ino: String(st.ino) };
}

function sameId(a, b) {
  return !!a && !!b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
}

function validId(x) {
  return (
    !!x &&
    typeof x === "object" &&
    /^[0-9]+$/.test(String(x.dev)) &&
    /^[0-9]+$/.test(String(x.ino))
  );
}

function kindOf(st) {
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "directory";
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFIFO()) return "fifo";
  if (st.isSocket()) return "socket";
  if (st.isBlockDevice()) return "block";
  if (st.isCharacterDevice()) return "char";
  return "unknown";
}

function validLeaf(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

function validRelative(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 4096 && name.split("/").every(validLeaf);
}

function validMode(m) {
  return Number.isSafeInteger(m) && m >= 0 && m <= 0o7777;
}

function toBytes(x) {
  if (typeof x === "string") return Buffer.from(x, "utf8");
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof Uint8Array) return Buffer.from(x);
  return null;
}

function relTo(root, p) {
  const r = path.relative(root, p);
  return r === "" ? "." : r.split(path.sep).join("/");
}

/** Canonical JSON (sorted keys) — refuses values JSON would silently drop or coerce. */
function canonicalJson(v) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  }
  throw new TypeError(`unserialisable ${typeof v}`);
}

/** The common result shape. Unlisted fields pass through. */
function result(primitive, status, fields = {}) {
  return {
    primitive,
    status,
    code: null,
    phase: null,
    effects: status === "COMMITTED" ? "DURABLE" : "NONE",
    reason: null,
    backend: null,
    qualifiedGuarantees: [],
    before: null,
    after: null,
    unresolved: [],
    cleanup: { removed: [], retained: [] },
    receipt: null,
    ...fields,
  };
}

const refused = (p, code, reason, fields = {}) => result(p, "REFUSED", { code, reason, ...fields });
const undetermined = (p, code, reason, fields = {}) => result(p, "UNDETERMINED", { code, reason, ...fields });

// ── raw IO helpers (all through the call's `io`) ─────────────────────────────

const lstatB = (io, p) => io.lstatSync(p, { bigint: true });
const fstatB = (io, fd) => io.fstatSync(fd, { bigint: true });

function closeQuietly(io, fd) {
  try {
    io.closeSync(fd);
    return null;
  } catch (e) {
    return errCode(e);
  }
}

/** Write every byte or report how many landed. Never retries a byte that was written. */
function writeAll(io, fd, buf, position) {
  let off = 0;
  while (off < buf.length) {
    let n;
    try {
      n = io.writeSync(fd, buf, off, buf.length - off, position === null ? null : position + off);
    } catch (e) {
      return { ok: false, written: off, code: errCode(e) };
    }
    if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, written: off, code: "ShortWrite" };
    off += n;
  }
  return { ok: true, written: off };
}

/** Read [start, start+len) exactly, or report what could not be read. */
function readRange(io, fd, start, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    let n;
    try {
      n = io.readSync(fd, buf, off, len - off, start + off);
    } catch (e) {
      return { ok: false, code: errCode(e) };
    }
    if (n === 0) return { ok: false, code: "ShortRead" };
    off += n;
  }
  return { ok: true, bytes: buf };
}

/** Read a whole regular file from offset 0, refusing past `maxBytes` (one byte over is read to tell). */
function readAllBounded(io, fd, maxBytes) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const want = Math.min(64 * 1024, maxBytes + 1 - total);
    if (want <= 0) return { ok: false, code: "TooLarge" };
    const buf = Buffer.alloc(want);
    let n;
    try {
      n = io.readSync(fd, buf, 0, want, total);
    } catch (e) {
      return { ok: false, code: errCode(e) };
    }
    if (n === 0) break;
    chunks.push(buf.subarray(0, n));
    total += n;
  }
  if (total > maxBytes) return { ok: false, code: "TooLarge" };
  return { ok: true, bytes: Buffer.concat(chunks, total) };
}

function syncDir(io, dir) {
  const dfd = io.openSync(dir, O.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    io.fsyncSync(dfd);
  } finally {
    io.closeSync(dfd);
  }
}

/** Open a regular file without following, confirm it is still `expectId`, and hash it. */
function digestFile(io, p, expectId, maxBytes = 64 * 1024 * 1024) {
  let fd;
  try {
    fd = io.openSync(p, O.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    return { ok: false, code: errCode(e) };
  }
  try {
    const st = fstatB(io, fd);
    if (!st.isFile()) return { ok: false, code: "OccupiedInvalid" };
    const id = idOfStat(st);
    if (expectId && !sameId(id, expectId)) return { ok: false, code: "IdentityChanged", id };
    const rd = readAllBounded(io, fd, maxBytes);
    if (!rd.ok) return { ok: false, code: rd.code };
    return { ok: true, id, bytes: rd.bytes, sha256: sha256(rd.bytes), mode: Number(st.mode) & 0o7777, nlink: Number(st.nlink) };
  } finally {
    closeQuietly(io, fd);
  }
}

/**
 * What is at `p` right now: absent (proven ENOENT only), a regular file (identity, mode, digest
 * when asked), something that is not a regular file, or undetermined.
 */
function observeEntry(io, p, { digest = false } = {}) {
  let st;
  try {
    st = lstatB(io, p);
  } catch (e) {
    if (e && e.code === "ENOENT") return { state: "absent" };
    return { state: "undetermined", code: errCode(e) };
  }
  if (!st.isFile()) return { state: "invalid", kind: kindOf(st) };
  const out = { state: "present", id: idOfStat(st), mode: Number(st.mode) & 0o7777, nlink: Number(st.nlink), size: Number(st.size) };
  if (digest) {
    const d = digestFile(io, p, out.id);
    if (!d.ok) return d.code === "IdentityChanged" ? { state: "changed" } : { state: "undetermined", code: d.code };
    out.sha256 = d.sha256;
  }
  return out;
}

function sameObservation(a, b) {
  if (a.state === "absent" || b.state === "absent") return a.state === b.state;
  return a.state === "present" && b.state === "present" && sameId(a.id, b.id) && a.sha256 === b.sha256;
}

/** Remove an own scratch entry ONLY while it is still the exact inode this call created. */
function removeExact(io, p, id) {
  let st;
  try {
    st = lstatB(io, p);
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: true, gone: true };
    return { ok: false, code: errCode(e) };
  }
  if (!sameId(idOfStat(st), id)) return { ok: false, code: "IdentityChanged" };
  try {
    io.unlinkSync(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: errCode(e) };
  }
}

function cleanupOwn(io, cleanup, root, p, id) {
  const r = removeExact(io, p, id);
  if (r.ok && !r.gone) cleanup.removed.push(relTo(root, p));
  else if (!r.ok) cleanup.retained.push({ path: relTo(root, p), code: r.code });
}

/**
 * Put a captured object back under its original name WITHOUT replacing anything there: `link`
 * refuses an occupied name. Occupied ⇒ the held object moves to `quarantinePath` (when given) or
 * stays where it is; either way it is named in the result, never dropped.
 */
function restoreCaptured(io, heldPath, originalPath, heldId, quarantinePath) {
  try {
    io.linkSync(heldPath, originalPath);
  } catch (e) {
    if (e && e.code === "EEXIST" && quarantinePath) {
      try {
        io.renameSync(heldPath, quarantinePath);
        return { outcome: "quarantined", path: quarantinePath };
      } catch (e2) {
        return { outcome: "held", path: heldPath, code: errCode(e2) };
      }
    }
    return { outcome: "held", path: heldPath, code: errCode(e) };
  }
  const rm = removeExact(io, heldPath, heldId);
  if (!rm.ok) return { outcome: "restored", path: originalPath, retainedAlias: heldPath, code: rm.code };
  return { outcome: "restored", path: originalPath };
}

// ── trusted process-table readers ────────────────────────────────────────────

function runTool(name, args) {
  const tool = resolveTrustedTool(name);
  if (!tool) return { ok: false, code: "ToolUnavailable", tool: name, status: null, stdout: "", stderr: "" };
  try {
    const stdout = execFileSync(tool, args, {
      env: TOOL_ENV_UTC,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, tool, stdout };
  } catch (e) {
    return {
      ok: false,
      code: e && e.code === "ETIMEDOUT" ? "Timeout" : "ToolFailed",
      tool,
      status: e && typeof e.status === "number" ? e.status : null,
      stdout: e && typeof e.stdout === "string" ? e.stdout : "",
      stderr: e && typeof e.stderr === "string" ? e.stderr : "",
    };
  }
}

function readProcessLinux(pid, withCommand) {
  let text;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, "latin1");
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ESRCH")) return { status: "ABSENT", pid };
    return { status: "UNDETERMINED", pid, code: errCode(e) };
  }
  const close = text.lastIndexOf(")");
  if (close < 0) return { status: "UNDETERMINED", pid, code: "UnparseableStat" };
  // Fields after the parenthesised command: [0]=state(3) [1]=ppid(4) … [19]=starttime(22).
  const f = text.slice(close + 2).trim().split(/\s+/);
  if (f.length < 20 || !/^[0-9]+$/.test(f[1]) || !/^[0-9]+$/.test(f[19])) {
    return { status: "UNDETERMINED", pid, code: "UnparseableStat" };
  }
  const row = { status: "PRESENT", pid, ppid: Number(f[1]), state: f[0], start: f[19], command: null };
  if (withCommand) {
    try {
      row.command = fs.readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter((s) => s !== "").join(" ");
    } catch (e) {
      if (e && (e.code === "ENOENT" || e.code === "ESRCH")) return { status: "ABSENT", pid };
      return { status: "UNDETERMINED", pid, code: errCode(e) };
    }
  }
  return row;
}

const DARWIN_PS_ROW = /^\s*([0-9]+)\s+([0-9]+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+[0-9]{1,2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2}\s+[0-9]{4})(?:\s+(.*))?$/;

function readProcessDarwin(pid) {
  const r = runTool("ps", ["-ww", "-o", "pid=,ppid=,stat=,lstart=,command=", "-p", String(pid)]);
  if (!r.ok) {
    // `ps -p` on a pid that does not exist exits 1 and prints NOTHING on either stream. Any other
    // shape — a message, another status, a timeout — is not evidence of absence.
    if (r.code === "ToolFailed" && r.status === 1 && r.stdout === "" && r.stderr === "") return { status: "ABSENT", pid };
    return { status: "UNDETERMINED", pid, code: r.code, exit: r.status };
  }
  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
  if (lines.length !== 1) return { status: "UNDETERMINED", pid, code: "UnparseablePs" };
  const m = DARWIN_PS_ROW.exec(lines[0]);
  if (!m || Number(m[1]) !== pid) return { status: "UNDETERMINED", pid, code: "UnparseablePs" };
  return { status: "PRESENT", pid, ppid: Number(m[2]), state: m[3], start: m[4].replace(/\s+/g, " "), command: (m[5] || "").trim() };
}

/** One row of the process table: PRESENT{ppid, state, start, command?} | ABSENT | UNDETERMINED. */
function readProcess(pid, { withCommand = false } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "UNDETERMINED", pid, code: "InputInvalid" };
  if (process.platform === "linux") return readProcessLinux(pid, withCommand);
  if (process.platform === "darwin") return readProcessDarwin(pid);
  return { status: "UNDETERMINED", pid, code: "UnsupportedPlatform" };
}

const isGone = (state) => /^[ZX]/.test(String(state));

// ── backend measurement ──────────────────────────────────────────────────────

function unescapeMount(s) {
  return s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

function parseMountinfoLine(line) {
  const sep = line.indexOf(" - ");
  if (sep < 0) return null;
  const left = line.slice(0, sep).split(" ");
  const right = line.slice(sep + 3).split(" ");
  const mm = /^([0-9]+):([0-9]+)$/.exec(left[2] || "");
  if (!mm || !left[4]) return null;
  return { major: Number(mm[1]), minor: Number(mm[2]), mountPoint: unescapeMount(left[4]), fstype: right[0], superOptions: right[2] || "" };
}

/** glibc's dev_t encoding, as libuv reports st_dev on Linux. */
function linuxDevParts(dev) {
  const d = BigInt(dev);
  return {
    major: Number(((d >> 8n) & 0xfffn) | ((d >> 32n) & 0xfffff000n)),
    minor: Number((d & 0xffn) | ((d >> 12n) & 0xffffff00n)),
  };
}

function underMount(rootReal, mountPoint) {
  return mountPoint === "/" || rootReal === mountPoint || rootReal.startsWith(`${mountPoint}/`);
}

function measureFilesystemLinux(rootReal, rootStat) {
  let text;
  try {
    text = fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch (e) {
    return { type: null, local: false, match: "unreadable", error: errCode(e) };
  }
  const rows = text.split("\n").filter(Boolean).map(parseMountinfoLine).filter(Boolean);
  const { major, minor } = linuxDevParts(rootStat.dev);
  let cands = rows.filter((r) => r.major === major && r.minor === minor);
  let match = "dev";
  if (cands.length === 0) {
    // A btrfs subvolume that is not itself mounted reports an anonymous device no mountinfo row
    // names; fall back to the deepest mount point containing the root, and SAY it was a fallback.
    cands = rows.filter((r) => underMount(rootReal, r.mountPoint));
    match = "prefix";
  }
  if (cands.length === 0) return { type: null, local: false, match: "none" };
  cands.sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  const best = cands[0];
  return { type: best.fstype, local: LOCAL_FS.linux.has(best.fstype), match, mountPoint: best.mountPoint };
}

const DARWIN_MOUNT_ROW = /^(.+?) on (.+) \(([^()]*)\)$/;

function measureFilesystemDarwin(rootReal, rootStat) {
  const r = runTool("mount", []);
  if (!r.ok) return { type: null, local: false, match: "unreadable", error: r.code };
  const rows = r.stdout
    .split("\n")
    .map((l) => DARWIN_MOUNT_ROW.exec(l))
    .filter(Boolean)
    .map((m) => {
      const opts = m[3].split(",").map((s) => s.trim());
      return { mountPoint: m[2], type: opts[0], local: opts.includes("local") };
    });
  // Match by DEVICE, not by path prefix: firmlinks put a data-volume path under "/" whose mount
  // row names a different volume. Only recognised LOCAL rows are statted, so a hung network
  // mount is never touched.
  for (const row of rows) {
    if (!row.local || !LOCAL_FS.darwin.has(row.type)) continue;
    let st;
    try {
      st = fs.statSync(row.mountPoint, { bigint: true });
    } catch {
      continue;
    }
    if (st.dev === rootStat.dev) return { type: row.type, local: true, match: "dev", mountPoint: row.mountPoint };
  }
  const pref = rows.filter((row) => underMount(rootReal, row.mountPoint)).sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
  return { type: pref ? pref.type : null, local: false, match: "none" };
}

function procHidesOthersLinux() {
  let text;
  try {
    text = fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return null;
  }
  const row = text.split("\n").map(parseMountinfoLine).find((r) => r && r.fstype === "proc" && r.mountPoint === "/proc");
  if (!row) return null;
  const opt = row.superOptions.split(",").find((o) => o.startsWith("hidepid="));
  if (!opt) return false;
  const v = opt.slice("hidepid=".length);
  return !(v === "0" || v === "off");
}

function measureIdentity() {
  const sources = {};
  const errors = {};
  let hostId = null;
  let bootId = null;
  let pidNs = null;
  let procHidesOthers = null;
  let startKind = null;
  if (process.platform === "linux") {
    startKind = "linux-proc-starttime";
    // /proc must belong to THIS process's pid namespace: a /proc mounted for another namespace
    // lists other processes under the same numbers, and reading it would turn a live owner into
    // an "absent" one. /proc/self names this process as that mount sees it.
    try {
      const self = fs.readlinkSync("/proc/self");
      if (self !== String(process.pid)) errors.procNamespace = `/proc/self is ${self}, this process is ${process.pid}`;
    } catch (e) {
      errors.procNamespace = errCode(e);
    }
    try {
      const v = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (/^[0-9a-f-]{36}$/.test(v)) {
        bootId = v;
        sources.bootId = "/proc/sys/kernel/random/boot_id";
      }
    } catch (e) {
      errors.bootId = errCode(e);
    }
    for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const v = fs.readFileSync(p, "utf8").trim();
        if (/^[0-9a-f]{32}$/.test(v)) {
          hostId = v;
          sources.hostId = p;
          break;
        }
      } catch (e) {
        errors.hostId = errCode(e);
      }
    }
    try {
      const v = fs.readlinkSync("/proc/self/ns/pid");
      if (/^pid:\[[0-9]+\]$/.test(v)) {
        pidNs = v;
        sources.pidNs = "/proc/self/ns/pid";
      }
    } catch (e) {
      errors.pidNs = errCode(e);
    }
    procHidesOthers = procHidesOthersLinux();
    sources.processTable = "/proc/<pid>/stat";
  } else if (process.platform === "darwin") {
    startKind = "darwin-ps-lstart-utc";
    const b = runTool("sysctl", ["-n", "kern.bootsessionuuid"]);
    const bv = b.ok ? b.stdout.trim() : "";
    if (/^[0-9A-Fa-f-]{36}$/.test(bv)) {
      bootId = bv;
      sources.bootId = "sysctl kern.bootsessionuuid";
    } else {
      errors.bootId = b.code || "unparseable";
    }
    const h = runTool("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const hm = h.ok ? /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(h.stdout) : null;
    if (hm) {
      hostId = hm[1];
      sources.hostId = "ioreg IOPlatformUUID";
    } else {
      errors.hostId = h.code || "unparseable";
    }
    procHidesOthers = false; // the trusted ps is setuid root and lists every process
    sources.processTable = "ps -o lstart (LC_ALL=C, TZ=UTC; one-second resolution)";
  }
  let ownStart = null;
  if (startKind && !errors.procNamespace) {
    const row = readProcess(process.pid);
    if (row.status === "PRESENT") ownStart = Object.freeze({ kind: startKind, value: row.start });
    else errors.ownStart = row.code || row.status;
  }
  return { hostId, bootId, pidNs, procHidesOthers, ownStart, sources, errors };
}

/** Exercise each write capability inside a private probe directory, then remove exactly what it made. */
function probeCapabilities(io, rootReal) {
  const caps = {
    noFollow: false,
    directoryOpen: false,
    exclusiveCreate: false,
    linkNoReplace: false,
    renameReplace: false,
    fileSync: false,
    dirSync: false,
    appendMode: false,
  };
  const errors = {};
  const cleanup = { removed: [], retained: [] };
  if (O_NOFOLLOW === 0) errors.noFollow = "O_NOFOLLOW unavailable";
  if (O_DIRECTORY === 0) errors.directoryOpen = "O_DIRECTORY unavailable";
  let dir = null;
  for (let i = 0; i < 2 && dir === null; i += 1) {
    const p = path.join(rootReal, `.dio-qualify-${process.pid}-${hex(4)}`);
    try {
      io.mkdirSync(p, { mode: 0o700 });
      dir = p;
    } catch (e) {
      if (!e || e.code !== "EEXIST") {
        errors.probeDir = errCode(e);
        break;
      }
    }
  }
  if (dir === null) return { caps, errors, cleanup };
  const made = new Map(); // name -> identity
  const A = path.join(dir, "a");
  const B = path.join(dir, "b");
  const C = path.join(dir, "c");
  const L = path.join(dir, "l");
  const note = (name, p) => {
    try {
      made.set(name, idOfStat(lstatB(io, p)));
    } catch {
      /* an entry that cannot be statted is reported by the cleanup pass below */
    }
  };
  try {
    const fd = io.openSync(A, O.O_CREAT | O.O_EXCL | O.O_WRONLY | O_NOFOLLOW, 0o600);
    note("a", A);
    try {
      if (writeAll(io, fd, Buffer.from("dio"), null).ok) {
        try {
          io.fsyncSync(fd);
          caps.fileSync = true;
        } catch (e) {
          errors.fileSync = errCode(e);
        }
      } else {
        errors.fileSync = "write failed";
      }
    } finally {
      closeQuietly(io, fd);
    }
    try {
      const fd2 = io.openSync(A, O.O_CREAT | O.O_EXCL | O.O_WRONLY | O_NOFOLLOW, 0o600);
      closeQuietly(io, fd2);
      errors.exclusiveCreate = "a second exclusive create of the same name succeeded";
    } catch (e) {
      if (e && e.code === "EEXIST") caps.exclusiveCreate = true;
      else errors.exclusiveCreate = errCode(e);
    }
  } catch (e) {
    errors.exclusiveCreate = errCode(e);
  }
  if (made.has("a")) {
    try {
      const fd = io.openSync(A, O.O_WRONLY | O.O_APPEND | O_NOFOLLOW);
      try {
        writeAll(io, fd, Buffer.from("+"), null);
      } finally {
        closeQuietly(io, fd);
      }
      caps.appendMode = io.readFileSync(A, "latin1") === "dio+";
      if (!caps.appendMode) errors.appendMode = "O_APPEND write did not land at the end";
    } catch (e) {
      errors.appendMode = errCode(e);
    }
    if (O_NOFOLLOW !== 0) {
      try {
        io.symlinkSync("a", L);
        note("l", L);
        try {
          const fd = io.openSync(L, O.O_RDONLY | O_NOFOLLOW);
          closeQuietly(io, fd);
          errors.noFollow = "O_NOFOLLOW opened a symlink";
        } catch (e) {
          if (e && e.code === "ELOOP") caps.noFollow = true;
          else errors.noFollow = errCode(e);
        }
      } catch (e) {
        errors.noFollow = errCode(e);
      }
    }
    try {
      io.linkSync(A, B);
      note("b", B);
      try {
        io.linkSync(A, B);
        errors.linkNoReplace = "link replaced an existing name";
      } catch (e) {
        if (e && e.code === "EEXIST") caps.linkNoReplace = sameId(idOfStat(lstatB(io, A)), idOfStat(lstatB(io, B)));
        else errors.linkNoReplace = errCode(e);
      }
    } catch (e) {
      errors.linkNoReplace = errCode(e);
    }
  }
  try {
    const fd = io.openSync(C, O.O_CREAT | O.O_EXCL | O.O_WRONLY | O_NOFOLLOW, 0o600);
    closeQuietly(io, fd);
    const cId = idOfStat(lstatB(io, C));
    io.renameSync(C, B);
    made.set("b", cId);
    caps.renameReplace = sameId(idOfStat(lstatB(io, B)), cId);
    if (!caps.renameReplace) errors.renameReplace = "rename did not replace the destination";
  } catch (e) {
    errors.renameReplace = errCode(e);
    note("c", C);
  }
  if (O_DIRECTORY !== 0) {
    try {
      const dfd = io.openSync(dir, O.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      caps.directoryOpen = true;
      try {
        io.fsyncSync(dfd);
        caps.dirSync = true;
      } catch (e) {
        errors.dirSync = errCode(e);
      } finally {
        closeQuietly(io, dfd);
      }
    } catch (e) {
      errors.directoryOpen = errCode(e);
    }
  }
  // Remove exactly what this probe made; anything else in the probe directory is retained.
  let names = [];
  try {
    names = io.readdirSync(dir);
  } catch (e) {
    cleanup.retained.push({ path: relTo(rootReal, dir), code: errCode(e) });
  }
  for (const name of names) {
    const p = path.join(dir, name);
    const id = made.get(name);
    if (!id) {
      cleanup.retained.push({ path: relTo(rootReal, p), code: "NotOurs" });
      continue;
    }
    cleanupOwn(io, cleanup, rootReal, p, id);
  }
  try {
    io.rmdirSync(dir);
    cleanup.removed.push(relTo(rootReal, dir));
  } catch (e) {
    cleanup.retained.push({ path: relTo(rootReal, dir), code: errCode(e) });
  }
  return { caps, errors, cleanup };
}

/**
 * Measure this host for durable IO under `root`. QUALIFIED only when every BASE capability was
 * measured true on a recognised LOCAL filesystem; the returned backend is what every other
 * primitive requires, and it goes STALE the moment its root stops being the same directory.
 */
function qualifyBackend(opts = {}) {
  const P = "qualifyBackend";
  const io = fsOf(opts);
  const measure = opts && opts.__measure && typeof opts.__measure === "object" ? opts.__measure : null;
  if (!opts || typeof opts.root !== "string" || !path.isAbsolute(opts.root)) {
    return { primitive: P, status: "UNSUPPORTED", code: "InputInvalid", reason: "root must be an absolute path", missing: ["root"] };
  }
  const platform = opts.platform === undefined ? process.platform : opts.platform;
  const threatModel = opts.threatModel === undefined ? THREAT_MODEL : opts.threatModel;
  const missing = [];
  if (platform !== process.platform || !SUPPORTED_PLATFORMS.has(process.platform)) missing.push("platform");
  if (threatModel !== THREAT_MODEL) missing.push("threatModel");
  if (missing.length) {
    return {
      primitive: P,
      status: "UNSUPPORTED",
      code: "BackendUnqualified",
      reason: `this host cannot qualify: ${missing.join(", ")}`,
      missing,
      measured: { platform: process.platform, requestedPlatform: platform, threatModel },
    };
  }
  let rootReal;
  let rootStat;
  try {
    rootReal = fs.realpathSync(opts.root);
    rootStat = fs.lstatSync(rootReal, { bigint: true });
  } catch (e) {
    return { primitive: P, status: "UNDETERMINED", code: errCode(e), reason: "the root could not be resolved" };
  }
  if (!rootStat.isDirectory()) {
    return { primitive: P, status: "UNSUPPORTED", code: "InputInvalid", reason: "root is not a directory", missing: ["root"] };
  }
  const cacheKey = [process.platform, rootReal, rootStat.dev, rootStat.ino, threatModel, opts.filesystem || "auto"].join("|");
  const cacheable = !measure && !opts.__fs;
  if (cacheable && QUALIFIED_CACHE.has(cacheKey)) return QUALIFIED_CACHE.get(cacheKey);

  const fsm =
    measure && typeof measure.filesystem === "function"
      ? measure.filesystem(rootReal)
      : process.platform === "linux"
        ? measureFilesystemLinux(rootReal, rootStat)
        : measureFilesystemDarwin(rootReal, rootStat);
  const localFilesystem = !!fsm && fsm.local === true && LOCAL_FS[process.platform].has(fsm.type);
  if (!localFilesystem) missing.push("localFilesystem");
  if (opts.filesystem !== undefined && opts.filesystem !== "auto" && (!fsm || opts.filesystem !== fsm.type)) missing.push("filesystem");
  if (missing.length) {
    // Never write probe files onto a filesystem that is not a recognised local one.
    return {
      primitive: P,
      status: "UNSUPPORTED",
      code: "BackendUnqualified",
      reason: `filesystem not qualified: ${missing.join(", ")}`,
      missing,
      measured: { platform: process.platform, filesystem: fsm },
    };
  }
  const probe = probeCapabilities(io, rootReal);
  const capabilities = { localFilesystem, ...probe.caps };
  for (const c of BASE_CAPABILITIES) if (capabilities[c] !== true) missing.push(c);
  const realIdentity = measureIdentity();
  const identity = measure && typeof measure.identity === "function" ? measure.identity(realIdentity) : realIdentity;
  capabilities.processIdentity = !!(identity.ownStart && identity.bootId && (process.platform !== "linux" || identity.pidNs));
  capabilities.hostIdentity = typeof identity.hostId === "string" && identity.hostId.length > 0;
  if (missing.length) {
    return {
      primitive: P,
      status: "UNSUPPORTED",
      code: "BackendUnqualified",
      reason: `capabilities not measured true: ${missing.join(", ")}`,
      missing,
      measured: { platform: process.platform, filesystem: fsm, capabilities, errors: probe.errors },
      cleanup: probe.cleanup,
    };
  }
  const backend = Object.freeze({
    id: `dio:${process.platform}:${fsm.type}:${rootStat.dev}:${rootStat.ino}`,
    platform: process.platform,
    osRelease: os.release(),
    fsType: fsm.type,
    fsMatch: fsm.match,
    local: true,
    rootReal,
    rootDev: String(rootStat.dev),
    rootIno: String(rootStat.ino),
    threatModel,
    capabilities: Object.freeze(capabilities),
    identity: Object.freeze({
      hostId: identity.hostId,
      bootId: identity.bootId,
      pidNs: identity.pidNs,
      procHidesOthers: identity.procHidesOthers,
      ownStart: identity.ownStart,
    }),
    identitySources: Object.freeze({ ...identity.sources }),
    identityErrors: Object.freeze({ ...identity.errors }),
    measuredAt: nowIso(),
    qualificationCleanup: probe.cleanup,
  });
  ISSUED_BACKENDS.add(backend);
  const out = { primitive: P, status: "QUALIFIED", backend };
  // A transient identity failure (a timed-out tool) is not cached: it would deny every lock to
  // this process for its lifetime. A complete measurement is.
  if (cacheable && capabilities.processIdentity) QUALIFIED_CACHE.set(cacheKey, out);
  return out;
}

/** Is `backend` still the backend that was qualified? A replaced or moved root is STALE. */
function backendCurrent(backend) {
  if (!ISSUED_BACKENDS.has(backend)) return { ok: false, reason: "not a backend this module qualified" };
  if (backend.platform !== process.platform) return { ok: false, reason: "platform changed since qualification" };
  try {
    const st = fs.lstatSync(backend.rootReal, { bigint: true });
    if (!st.isDirectory() || String(st.dev) !== backend.rootDev || String(st.ino) !== backend.rootIno) {
      return { ok: false, reason: "the root was replaced since qualification (STALE)" };
    }
    if (fs.realpathSync(backend.rootReal) !== backend.rootReal) return { ok: false, reason: "the root path is no longer canonical (STALE)" };
  } catch (e) {
    return { ok: false, reason: `the root is unreadable (${errCode(e)})` };
  }
  return { ok: true };
}

function missingCaps(backend, names) {
  return names.filter((n) => backend.capabilities[n] !== true);
}

// ── directory handles ────────────────────────────────────────────────────────

function handleCurrent(h) {
  if (!ISSUED_DIRS.has(h)) return { ok: false, code: "InputInvalid", reason: "not a directory handle this module issued" };
  const b = backendCurrent(h.backend);
  if (!b.ok) return { ok: false, code: "BackendUnqualified", reason: b.reason };
  try {
    const st = fs.lstatSync(h.real, { bigint: true });
    if (!st.isDirectory() || String(st.dev) !== h.dev || String(st.ino) !== h.ino) {
      return { ok: false, code: "IdentityChanged", reason: `${h.rel} is no longer the directory that was pinned` };
    }
    if (fs.realpathSync(h.real) !== h.real) return { ok: false, code: "UnresolvedBoundary", reason: `${h.rel} now resolves through a link` };
  } catch (e) {
    return { ok: false, code: e && e.code === "ENOENT" ? "IdentityChanged" : errCode(e), reason: `${h.rel} could not be re-verified` };
  }
  return { ok: true };
}

function issueDir(backend, real, st) {
  const h = Object.freeze({ backend, real, rel: relTo(backend.rootReal, real), dev: String(st.dev), ino: String(st.ino) });
  ISSUED_DIRS.add(h);
  return h;
}

/**
 * Pin (and with `create`, make) a directory inside the qualified root. Every existing component
 * must be a real directory — a symlink anywhere on the path refuses, wherever it points — and
 * containment is checked by realpath both before and after any mkdir. Each missing component is
 * created non-recursively, its mode set exactly on the created inode, and its parent synced.
 */
function ensureDirectory(opts = {}) {
  const P = "ensureDirectory";
  const io = fsOf(opts);
  const b = backendCurrent(opts.backend);
  if (!b.ok) return refused(P, "BackendUnqualified", b.reason);
  const backend = opts.backend;
  const root = backend.rootReal;
  if (typeof opts.dir !== "string" || opts.dir.length === 0) return refused(P, "InputInvalid", "dir must be a non-empty string");
  if (opts.create !== undefined && typeof opts.create !== "boolean") return refused(P, "InputInvalid", "create must be a boolean");
  const create = opts.create === true;
  if (create && !validMode(opts.mode)) return refused(P, "InputInvalid", "a mode is required to create a directory");
  const target = path.resolve(root, opts.dir);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return refused(P, "UnresolvedBoundary", `${opts.dir} is outside the qualified root`);
  const comps = target === root ? [] : path.relative(root, target).split(path.sep);
  let cur = root;
  let i = 0;
  for (; i < comps.length; i += 1) {
    const next = path.join(cur, comps[i]);
    let st;
    try {
      st = lstatB(io, next);
    } catch (e) {
      if (e && e.code === "ENOENT") break;
      return undetermined(P, errCode(e), `${relTo(root, next)} could not be examined`);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return refused(P, "UnresolvedBoundary", `${relTo(root, next)} is a ${kindOf(st)}, not a directory`);
    cur = next;
  }
  try {
    const real = io.realpathSync(cur);
    if (real !== cur || (real !== root && !real.startsWith(`${root}${path.sep}`))) {
      return refused(P, "UnresolvedBoundary", `${relTo(root, cur)} does not resolve inside the root`);
    }
  } catch (e) {
    return undetermined(P, errCode(e), `${relTo(root, cur)} could not be resolved`);
  }
  const created = [];
  if (i < comps.length) {
    if (!create) return refused(P, "Absent", `${relTo(root, path.join(cur, comps[i]))} does not exist`);
    for (; i < comps.length; i += 1) {
      const next = path.join(cur, comps[i]);
      race(opts, "mkdir:before-mkdir", { path: next });
      let ours = false;
      try {
        io.mkdirSync(next, { mode: opts.mode });
        ours = true;
      } catch (e) {
        if (!e || e.code !== "EEXIST") return undetermined(P, errCode(e), `mkdir ${relTo(root, next)} failed`, { effects: created.length ? "UNDETERMINED" : "NONE", created });
      }
      let st;
      try {
        st = lstatB(io, next);
      } catch (e) {
        return undetermined(P, errCode(e), `${relTo(root, next)} could not be examined after mkdir`, { effects: "UNDETERMINED", created });
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return refused(P, "UnresolvedBoundary", `${relTo(root, next)} became a ${kindOf(st)}`, { effects: created.length ? "UNDETERMINED" : "NONE", created });
      }
      if (ours) {
        created.push(relTo(root, next));
        let dfd;
        try {
          dfd = io.openSync(next, O.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
          if (!sameId(idOfStat(fstatB(io, dfd)), idOfStat(st))) throw Object.assign(new Error("identity changed"), { code: "IdentityChanged" });
          io.fchmodSync(dfd, opts.mode);
        } catch (e) {
          return undetermined(P, errCode(e), `mode of ${relTo(root, next)} could not be set`, { effects: "UNDETERMINED", created });
        } finally {
          if (dfd !== undefined) closeQuietly(io, dfd);
        }
        try {
          syncDir(io, cur);
        } catch (e) {
          return undetermined(P, "DirSyncFailed", `${relTo(root, cur)} could not be synced (${errCode(e)})`, { effects: "UNDETERMINED", created });
        }
      }
      cur = next;
    }
  }
  let st;
  try {
    if (io.realpathSync(target) !== target) return refused(P, "UnresolvedBoundary", `${relTo(root, target)} resolves elsewhere after creation`, { created });
    st = lstatB(io, target);
  } catch (e) {
    return undetermined(P, errCode(e), `${relTo(root, target)} could not be pinned`, { effects: created.length ? "UNDETERMINED" : "NONE", created });
  }
  if (!st.isDirectory()) return refused(P, "UnresolvedBoundary", `${relTo(root, target)} is not a directory`, { created });
  return result(P, "COMMITTED", { handle: issueDir(backend, target, st), created, backend: backend.id, effects: created.length ? "DURABLE" : "NONE" });
}

// ── probe ────────────────────────────────────────────────────────────────────

/**
 * What is at `name` under a pinned directory, WITHOUT following the leaf. Only an actual ENOENT
 * is absence; every other failure — ENOTDIR, EACCES, ELOOP, EIO, a link on the way — is
 * UNDETERMINED and must never be read as "not there".
 */
function probe(opts = {}) {
  const P = "probe";
  const io = fsOf(opts);
  const name = opts.name;
  if (opts.followLeaf !== undefined && opts.followLeaf !== false) {
    return { primitive: P, status: "UNDETERMINED", code: "InputInvalid", operation: "validate", scope: "input", retryable: false };
  }
  if (!validRelative(name)) return { primitive: P, status: "UNDETERMINED", code: "InputInvalid", operation: "validate", scope: "input", retryable: false };
  const hc = handleCurrent(opts.dirHandle);
  if (!hc.ok) return { primitive: P, status: "UNDETERMINED", code: hc.code, reason: hc.reason, operation: "pin", scope: "boundary", retryable: false };
  const comps = name.split("/");
  let cur = opts.dirHandle.real;
  for (let i = 0; i < comps.length; i += 1) {
    const next = path.join(cur, comps[i]);
    const leaf = i === comps.length - 1;
    const scopeName = comps.slice(0, i + 1).join("/");
    let st;
    try {
      st = lstatB(io, next);
    } catch (e) {
      if (e && e.code === "ENOENT") return { primitive: P, status: "ABSENT", cause: "ENOENT", scope: leaf ? "leaf" : "ancestor", missing: scopeName };
      return { primitive: P, status: "UNDETERMINED", code: errCode(e), operation: "lstat", scope: scopeName, retryable: RETRYABLE_ERRNO.has(errCode(e)) };
    }
    if (leaf) {
      return {
        primitive: P,
        status: "PRESENT",
        kind: kindOf(st),
        identity: { ...idOfStat(st), mode: Number(st.mode) & 0o7777, nlink: Number(st.nlink), size: String(st.size) },
        scope: name,
      };
    }
    if (st.isSymbolicLink()) return { primitive: P, status: "UNDETERMINED", code: "UnresolvedBoundary", operation: "lstat", scope: scopeName, retryable: false };
    if (!st.isDirectory()) return { primitive: P, status: "UNDETERMINED", code: "ENOTDIR", operation: "lstat", scope: scopeName, retryable: false };
    cur = next;
  }
  return { primitive: P, status: "UNDETERMINED", code: "InputInvalid", operation: "walk", scope: name, retryable: false };
}

// ── replaceFile ──────────────────────────────────────────────────────────────

function parseExpected(exp) {
  if (!exp || typeof exp !== "object") return null;
  if (exp.state === "absent" || exp.state === "observed") return { state: exp.state };
  if (exp.state === "present") {
    if (!validId(exp.identity)) return null;
    if (exp.sha256 !== undefined && !SHA256_RE.test(String(exp.sha256))) return null;
    return { state: "present", identity: exp.identity, sha256: exp.sha256 };
  }
  return null;
}

function parseMode(m) {
  if (validMode(m)) return { mode: m };
  if (m && typeof m === "object" && m.preserve === true && validMode(m.create)) return { preserve: true, create: m.create };
  return null;
}

function expectedMatches(exp, prior) {
  if (exp.state === "absent") return prior.state === "absent";
  if (exp.state === "observed") return prior.state === "absent" || prior.state === "present";
  return prior.state === "present" && sameId(prior.id, exp.identity) && (exp.sha256 === undefined || exp.sha256 === prior.sha256);
}

/**
 * Replace (or create) one file by publishing a FRESH inode: an exclusive stage beside the
 * destination is written completely, given its mode, fsynced, and only then published — by
 * no-replace `link` when the destination must be absent, by `rename` otherwise. The old inode
 * is never truncated or chmodded, so every alias of it keeps its exact bytes and mode. The
 * prior entry, the lock (when given) and the directory are re-verified immediately before the
 * publish; after it, the published identity, the parent sync and a byte readback all have to
 * hold before COMMITTED.
 */
function replaceFile(opts = {}) {
  const P = "replaceFile";
  const io = fsOf(opts);
  if (!validLeaf(opts.leafName)) return refused(P, "InputInvalid", "leafName must be one path component", { phase: "INPUT" });
  if (opts.durability !== "required") {
    return refused(P, opts.durability === undefined ? "InputInvalid" : "UnsupportedGuarantee", "only durability:'required' is supported", { phase: "INPUT" });
  }
  const bytes = toBytes(opts.bytes);
  if (!bytes) return refused(P, "InputInvalid", "bytes must be a string or a Buffer", { phase: "INPUT" });
  const exp = parseExpected(opts.expectedEntry);
  if (!exp) return refused(P, "InputInvalid", "expectedEntry must be {state:'absent'|'observed'} or {state:'present', identity, sha256?}", { phase: "INPUT" });
  const modeSpec = parseMode(opts.mode);
  if (!modeSpec) return refused(P, "InputInvalid", "mode must be a number or {preserve:true, create:number}", { phase: "INPUT" });
  if (opts.lock !== undefined && !ISSUED_LOCKS.has(opts.lock)) return refused(P, "InputInvalid", "lock is not a lock handle this module issued", { phase: "INPUT" });
  const hc = handleCurrent(opts.dirHandle);
  if (!hc.ok) return refused(P, hc.code, hc.reason, { phase: "PARENT" });
  const backend = opts.dirHandle.backend;
  const lacking = missingCaps(backend, ["exclusiveCreate", "noFollow", "fileSync", "dirSync", "renameReplace", "linkNoReplace"]);
  if (lacking.length) return refused(P, "UnsupportedGuarantee", `backend lacks ${lacking.join(", ")}`, { phase: "BACKEND", backend: backend.id });
  if (opts.lock !== undefined) {
    const v = verifyOwnershipInternal(opts.lock);
    if (v.status !== "OWNED") return refused(P, "LockLost", `lock not held (${v.reason})`, { phase: "LOCK", backend: backend.id });
  }
  const dir = opts.dirHandle.real;
  const root = backend.rootReal;
  const dest = path.join(dir, opts.leafName);
  const base = { backend: backend.id };

  const prior = observeEntry(io, dest, { digest: true });
  if (prior.state === "undetermined") return undetermined(P, prior.code, `the destination could not be observed`, { ...base, phase: "PREIMAGE" });
  if (prior.state === "changed") return refused(P, "PreimageChanged", "the destination changed while it was being observed", { ...base, phase: "PREIMAGE" });
  if (prior.state === "invalid") return refused(P, "OccupiedInvalid", `${opts.leafName} is a ${prior.kind}, not a regular file — left as found`, { ...base, phase: "PREIMAGE" });
  if (!expectedMatches(exp, prior)) return refused(P, "PreimageChanged", "the destination is not the expected entry", { ...base, phase: "PREIMAGE", before: prior });
  race(opts, "replace:after-observe", { dest, prior });
  const mode = modeSpec.preserve ? (prior.state === "present" ? prior.mode : modeSpec.create) : modeSpec.mode;
  const before = prior.state === "present" ? { state: "present", dev: prior.id.dev, ino: prior.id.ino, sha256: prior.sha256, mode: prior.mode, nlink: prior.nlink } : { state: "absent" };

  const stagePath = path.join(dir, `.${opts.leafName.slice(0, 200)}.dio-stage.${hex(8)}`);
  race(opts, "replace:before-stage", { stagePath, dest });
  let fd;
  try {
    fd = io.openSync(stagePath, O.O_CREAT | O.O_EXCL | O.O_WRONLY | O_NOFOLLOW | O_NONBLOCK, 0o600);
  } catch (e) {
    if (e && e.code === "EEXIST") return refused(P, "OccupiedInvalid", "an entry already holds the stage name; it is not ours and is left as found", { ...base, phase: "STAGE", before });
    return refused(P, errCode(e), "the stage could not be created", { ...base, phase: "STAGE", before });
  }
  const cleanup = { removed: [], retained: [] };
  let custody;
  try {
    custody = idOfStat(fstatB(io, fd));
  } catch (e) {
    closeQuietly(io, fd);
    cleanup.retained.push({ path: relTo(root, stagePath), code: errCode(e) });
    return undetermined(P, errCode(e), "the stage identity could not be read", { ...base, phase: "STAGE", before, cleanup });
  }
  const abandon = (code, reason, phase) => {
    closeQuietly(io, fd);
    cleanupOwn(io, cleanup, root, stagePath, custody);
    return refused(P, code, reason, { ...base, phase, before, cleanup });
  };
  const w = writeAll(io, fd, bytes, 0);
  if (!w.ok) return abandon(w.written > 0 ? "ShortWrite" : w.code, `the stage write stopped at ${w.written}/${bytes.length} bytes`, "WRITE");
  try {
    io.fchmodSync(fd, mode);
  } catch (e) {
    return abandon(errCode(e), "the stage mode could not be set", "MODE");
  }
  try {
    io.fsyncSync(fd);
  } catch (e) {
    return abandon("FileSyncFailed", `the stage could not be synced (${errCode(e)})`, "FILE_SYNC");
  }
  try {
    const st = fstatB(io, fd);
    if (!st.isFile() || st.nlink !== 1n || st.size !== BigInt(bytes.length) || (Number(st.mode) & 0o7777) !== mode || !sameId(idOfStat(st), custody)) {
      return abandon("IdentityChanged", "the stage is no longer the single-link file that was written", "STAGE_VERIFY");
    }
  } catch (e) {
    return abandon(errCode(e), "the stage could not be re-verified", "STAGE_VERIFY");
  }

  race(opts, "replace:before-publish", { stagePath, dest });
  if (opts.lock !== undefined) {
    const v = verifyOwnershipInternal(opts.lock);
    if (v.status !== "OWNED") return abandon("LockLost", `lock lost before publication (${v.reason})`, "REVERIFY");
  }
  const hc2 = handleCurrent(opts.dirHandle);
  if (!hc2.ok) return abandon(hc2.code, hc2.reason, "REVERIFY");
  const now = observeEntry(io, dest, { digest: true });
  if (now.state === "undetermined") {
    closeQuietly(io, fd);
    cleanupOwn(io, cleanup, root, stagePath, custody);
    return undetermined(P, now.code, "the destination could not be re-observed before publication", { ...base, phase: "REVERIFY", before, cleanup });
  }
  if (!sameObservation(prior, now)) return abandon("PreimageChanged", "the destination changed between observation and publication", "REVERIFY");

  let stageRemoved = false;
  if (prior.state === "absent") {
    try {
      io.linkSync(stagePath, dest);
    } catch (e) {
      if (e && e.code === "EEXIST") return abandon("PreimageChanged", "an entry appeared at the destination", "PUBLISH");
      return abandon("PublishFailed", `link publication failed (${errCode(e)})`, "PUBLISH");
    }
    const rm = removeExact(io, stagePath, custody);
    stageRemoved = rm.ok;
    if (!rm.ok) cleanup.retained.push({ path: relTo(root, stagePath), code: rm.code, note: "second name of the published inode" });
  } else {
    try {
      io.renameSync(stagePath, dest);
      stageRemoved = true;
    } catch (e) {
      let landed = false;
      try {
        landed = sameId(idOfStat(lstatB(io, dest)), custody);
      } catch {
        landed = false;
      }
      if (!landed) return abandon("PublishFailed", `rename publication failed (${errCode(e)})`, "PUBLISH");
    }
  }
  race(opts, "replace:after-publish", { dest });
  const published = { published: true, dev: custody.dev, ino: custody.ino, size: bytes.length, mode, sha256: sha256(bytes) };
  const after = (extra = {}) => ({ ...published, ...extra });
  const tail = (status, code, reason, phase, extra = {}) => {
    const c = closeQuietly(io, fd);
    if (status === "COMMITTED" && c) return undetermined(P, "CloseFailed", `the stage descriptor did not close (${c})`, { ...base, phase: "CLOSE", effects: "UNDETERMINED", before, after: after(), cleanup });
    return result(P, status, { code, reason, ...base, phase, before, after: after(extra), cleanup, effects: status === "COMMITTED" ? "DURABLE" : "UNDETERMINED" });
  };
  if (!stageRemoved && prior.state !== "absent") cleanup.retained.push({ path: relTo(root, stagePath), code: "PublishUncertain" });
  try {
    if (!sameId(idOfStat(lstatB(io, dest)), custody)) return tail("UNDETERMINED", "IdentityChanged", "the destination is not the published inode", "PUBLISH_OBSERVED");
  } catch (e) {
    return tail("UNDETERMINED", errCode(e), "the publication could not be observed", "PUBLISH_OBSERVED");
  }
  try {
    syncDir(io, dir);
  } catch (e) {
    return tail("UNDETERMINED", "DirSyncFailed", `the directory could not be synced after publication (${errCode(e)})`, "DIR_SYNC");
  }
  const rb = digestFile(io, dest, custody, bytes.length + 1);
  if (!rb.ok || rb.sha256 !== published.sha256 || rb.bytes.length !== bytes.length) {
    return tail("UNDETERMINED", "ReadbackFailed", "the published bytes do not read back as written", "READBACK", { readback: rb.ok ? rb.sha256 : rb.code });
  }
  if (typeof opts.validateCommit === "function") {
    let ok;
    try {
      ok = opts.validateCommit({ bytes: rb.bytes, sha256: rb.sha256, identity: custody });
    } catch (e) {
      return tail("UNDETERMINED", "AuthorityUndetermined", `validateCommit threw: ${e && e.message}`, "VALIDATE");
    }
    if (ok !== true) return tail("UNDETERMINED", "AuthorityRefused", "validateCommit refused the published bytes", "VALIDATE");
  }
  const guarantees = ["fresh-inode", "file-sync", "dir-sync", "readback", "preimage-reverified"];
  if (opts.lock !== undefined) guarantees.push("lock-reverified");
  const res = tail("COMMITTED", null, null, "DONE");
  if (res.status === "COMMITTED") res.qualifiedGuarantees = guarantees;
  return res;
}

// ── appendRecord ─────────────────────────────────────────────────────────────

/** The trusted tail: the file must end in a newline; the last frame is what precedes it. */
function readTail(io, fd, size, maxFrameBytes) {
  if (size === 0) return { ok: true, lastFrame: null };
  const window = Math.min(size, maxFrameBytes + 1);
  const start = size - window;
  const rd = readRange(io, fd, start, window);
  if (!rd.ok) return { ok: false, code: "UnreadableTail", reason: `the tail could not be read (${rd.code})` };
  const buf = rd.bytes;
  if (buf[buf.length - 1] !== NL) return { ok: false, code: "TornTail", reason: "the log does not end with a complete record" };
  const prev = buf.lastIndexOf(NL, buf.length - 2);
  if (prev === -1 && start > 0) return { ok: false, code: "UnreadableTail", reason: "the last record is longer than maxFrameBytes" };
  return { ok: true, lastFrame: buf.subarray(prev + 1, buf.length - 1) };
}

/** The caller's expectations about the history: null when they hold, else the refusal. */
function checkTail(opts, { size, lastFrame, lastFrameSha256, absent }) {
  const et = opts.expectedTail;
  if (et !== undefined) {
    const sizeOk = et.size === undefined || et.size === size;
    const shaOk = et.lastFrameSha256 === undefined || et.lastFrameSha256 === lastFrameSha256;
    const absentOk = et.absent === undefined || et.absent === absent;
    if (!sizeOk || !shaOk || !absentOk) return { code: "PreimageChanged", reason: "the log's tail is not the expected one" };
  }
  if (typeof opts.validateTail === "function") {
    let ok;
    try {
      ok = opts.validateTail({ size, lastFrame, lastFrameSha256 });
    } catch (e) {
      return { code: "AuthorityUndetermined", reason: `validateTail threw: ${e && e.message}` };
    }
    if (ok !== true) return { code: "AuthorityRefused", reason: "validateTail refused the log's history" };
  }
  return null;
}

/**
 * Append ONE newline-framed record to a log, serialised through a held lock: the tail must be a
 * complete record (a torn tail refuses and is retained — never repaired, filtered or prefixed),
 * the lock and the sink identity are re-verified immediately before the write, and the append is
 * fsynced and read back through the same descriptor before COMMITTED. An absent log is created
 * only on a proven ENOENT, with its mode set exactly and its directory synced.
 */
function appendRecord(opts = {}) {
  const P = "appendRecord";
  const io = fsOf(opts);
  if (!validLeaf(opts.leafName)) return refused(P, "InputInvalid", "leafName must be one path component", { phase: "INPUT" });
  if (opts.durability !== "required") {
    return refused(P, opts.durability === undefined ? "InputInvalid" : "UnsupportedGuarantee", "only durability:'required' is supported", { phase: "INPUT" });
  }
  if (!Number.isSafeInteger(opts.maxFrameBytes) || opts.maxFrameBytes < 2) return refused(P, "InputInvalid", "maxFrameBytes must be an integer >= 2", { phase: "INPUT" });
  if (!validMode(opts.createMode)) return refused(P, "InputInvalid", "createMode is required", { phase: "INPUT" });
  if (!ISSUED_LOCKS.has(opts.lock)) return refused(P, "InputInvalid", "appendRecord serialises writers through a held lock; none was given", { phase: "INPUT" });
  const frame = toBytes(opts.frame);
  if (!frame || frame.length === 0) return refused(P, "InputInvalid", "frame must be a non-empty string or Buffer", { phase: "INPUT" });
  if (frame.includes(NL)) return refused(P, "InputInvalid", "a frame must not contain a newline", { phase: "INPUT" });
  if (frame.length + 1 > opts.maxFrameBytes) return refused(P, "InputInvalid", `frame of ${frame.length + 1} bytes exceeds maxFrameBytes ${opts.maxFrameBytes}`, { phase: "INPUT" });
  try {
    UTF8.decode(frame);
  } catch {
    return refused(P, "InputInvalid", "frame is not valid UTF-8", { phase: "INPUT" });
  }
  const hc = handleCurrent(opts.dirHandle);
  if (!hc.ok) return refused(P, hc.code, hc.reason, { phase: "PARENT" });
  const backend = opts.dirHandle.backend;
  const lacking = missingCaps(backend, ["noFollow", "exclusiveCreate", "fileSync", "dirSync", "appendMode"]);
  if (lacking.length) return refused(P, "UnsupportedGuarantee", `backend lacks ${lacking.join(", ")}`, { phase: "BACKEND", backend: backend.id });
  const base = { backend: backend.id };
  const v = verifyOwnershipInternal(opts.lock);
  if (v.status !== "OWNED") return refused(P, "LockLost", `lock not held (${v.reason})`, { ...base, phase: "LOCK" });
  const dir = opts.dirHandle.real;
  const sink = path.join(dir, opts.leafName);

  const pre = observeEntry(io, sink);
  if (pre.state === "undetermined") return undetermined(P, pre.code, "the sink could not be observed", { ...base, phase: "PROBE" });
  if (pre.state === "invalid") return refused(P, "OccupiedInvalid", `${opts.leafName} is a ${pre.kind}, not a regular file — left as found`, { ...base, phase: "PROBE" });
  if (pre.state === "absent") {
    // Everything decidable about an empty history is decided BEFORE the log exists, so a refusal
    // here leaves no file behind and NONE is true.
    const t = checkTail(opts, { size: 0, lastFrame: null, lastFrameSha256: null, absent: true });
    if (t) return refused(P, t.code, t.reason, { ...base, phase: "TAIL", before: { absent: true } });
  }
  let fd;
  let created = false;
  try {
    if (pre.state === "absent") {
      fd = io.openSync(sink, O.O_CREAT | O.O_EXCL | O.O_RDWR | O.O_APPEND | O_NOFOLLOW | O_NONBLOCK, opts.createMode);
      created = true;
    } else {
      fd = io.openSync(sink, O.O_RDWR | O.O_APPEND | O_NOFOLLOW | O_NONBLOCK);
    }
  } catch (e) {
    if (e && e.code === "EEXIST") return refused(P, "PreimageChanged", "the log appeared between the probe and the create", { ...base, phase: "OPEN" });
    if (e && e.code === "ELOOP") return refused(P, "OccupiedInvalid", "the sink became a symlink", { ...base, phase: "OPEN" });
    if (e && e.code === "ENOENT") return refused(P, "PreimageChanged", "the log vanished between the probe and the open", { ...base, phase: "OPEN" });
    return undetermined(P, errCode(e), "the sink could not be opened", { ...base, phase: "OPEN" });
  }
  let outcome;
  try {
    outcome = appendThroughFd(io, opts, { fd, sink, dir, frame, pre, created, base });
  } finally {
    const c = closeQuietly(io, fd);
    if (c && outcome && outcome.status === "COMMITTED") {
      outcome = undetermined(P, "CloseFailed", `the sink descriptor did not close (${c})`, { ...base, phase: "CLOSE", effects: "UNDETERMINED", receipt: outcome.receipt });
    }
  }
  if (created && outcome.status === "REFUSED") {
    // This call created the log and then stopped. The file now exists outside this call's control
    // (a refusal after the create means the lock or the sink moved), so what it holds is unknown:
    // never reported as NONE, and never unlinked — another writer may already have appended to it.
    return undetermined(P, outcome.code, `${outcome.reason}; the log this call created is left in place`, {
      ...base,
      phase: outcome.phase,
      effects: "UNDETERMINED",
      after: { created: true, leafName: opts.leafName },
      receipt: outcome.receipt,
    });
  }
  return outcome;
}

function appendThroughFd(io, opts, { fd, sink, dir, frame, pre, created, base }) {
  const P = "appendRecord";
  let st;
  try {
    st = fstatB(io, fd);
  } catch (e) {
    return undetermined(P, errCode(e), "the sink identity could not be read", { ...base, phase: "OPEN", effects: created ? "UNDETERMINED" : "NONE" });
  }
  if (!st.isFile()) return refused(P, "OccupiedInvalid", "the sink is not a regular file", { ...base, phase: "OPEN" });
  if (st.nlink !== 1n) return refused(P, "OccupiedInvalid", `the sink inode has ${st.nlink} names; a shared inode is never appended to`, { ...base, phase: "OPEN" });
  const id = idOfStat(st);
  if (!created && !sameId(id, pre.id)) return refused(P, "IdentityChanged", "the sink was replaced between the probe and the open", { ...base, phase: "OPEN" });
  if (created) {
    try {
      io.fchmodSync(fd, opts.createMode);
    } catch (e) {
      return undetermined(P, errCode(e), "the new log's mode could not be set", { ...base, phase: "MODE", effects: "UNDETERMINED" });
    }
  }
  const size = Number(st.size);
  if (created && size !== 0) return refused(P, "PreimageChanged", "bytes appeared in the log this call had just created", { ...base, phase: "TAIL", before: { size } });
  const tail = readTail(io, fd, size, opts.maxFrameBytes);
  if (!tail.ok) return refused(P, tail.code, tail.reason, { ...base, phase: "TAIL", before: { size } });
  const lastFrameSha256 = tail.lastFrame ? sha256(tail.lastFrame) : null;
  if (!created) {
    const t = checkTail(opts, { size, lastFrame: tail.lastFrame, lastFrameSha256, absent: false });
    if (t) return refused(P, t.code, t.reason, { ...base, phase: "TAIL", before: { size, lastFrameSha256 } });
  }
  race(opts, "append:before-write", { sink });
  const v = verifyOwnershipInternal(opts.lock);
  if (v.status !== "OWNED") return refused(P, "LockLost", `lock lost before the write (${v.reason})`, { ...base, phase: "REVERIFY" });
  try {
    const st2 = fstatB(io, fd);
    if (st2.size !== st.size || st2.nlink !== 1n) return refused(P, "PreimageChanged", "the log changed under the lock before the write", { ...base, phase: "REVERIFY" });
    if (!sameId(idOfStat(lstatB(io, sink)), id)) return refused(P, "IdentityChanged", "the sink path no longer names the open file", { ...base, phase: "REVERIFY" });
  } catch (e) {
    return undetermined(P, errCode(e), "the sink could not be re-verified before the write", { ...base, phase: "REVERIFY", effects: created ? "UNDETERMINED" : "NONE" });
  }
  const payload = Buffer.concat([frame, Buffer.from([NL])]);
  const receipt = { offset: size, length: payload.length, sha256: sha256(payload), created, bytesAttempted: payload.length, bytesWritten: 0, lockGen: opts.lock.gen };
  const w = writeAll(io, fd, payload, null);
  receipt.bytesWritten = w.written;
  if (!w.ok) {
    if (w.written === 0 && !created) return refused(P, w.code, "the write failed before any byte landed", { ...base, phase: "WRITE", receipt });
    return undetermined(P, "ShortWrite", `${w.written}/${payload.length} bytes landed (${w.code}); the tail is torn until reviewed repair`, { ...base, phase: "WRITE", effects: "UNDETERMINED", receipt });
  }
  try {
    io.fsyncSync(fd);
  } catch (e) {
    return undetermined(P, "FileSyncFailed", `the appended bytes could not be synced (${errCode(e)})`, { ...base, phase: "FILE_SYNC", effects: "UNDETERMINED", receipt });
  }
  if (created) {
    try {
      syncDir(io, dir);
    } catch (e) {
      return undetermined(P, "DirSyncFailed", `the new log's directory could not be synced (${errCode(e)})`, { ...base, phase: "DIR_SYNC", effects: "UNDETERMINED", receipt });
    }
  }
  const rb = readRange(io, fd, size, payload.length);
  let prefixOk = true;
  if (size > 0) {
    const pb = readRange(io, fd, size - 1, 1);
    prefixOk = pb.ok && pb.bytes[0] === NL;
  }
  let sizeAfter = null;
  try {
    sizeAfter = Number(fstatB(io, fd).size);
  } catch {
    sizeAfter = null;
  }
  if (!rb.ok || !rb.bytes.equals(payload) || !prefixOk || sizeAfter !== size + payload.length) {
    return undetermined(P, "ReadbackFailed", "the appended record does not read back in place", { ...base, phase: "READBACK", effects: "UNDETERMINED", receipt });
  }
  if (typeof opts.validateCommit === "function") {
    let ok;
    try {
      ok = opts.validateCommit({ offset: size, frame, sha256: receipt.sha256 });
    } catch (e) {
      return undetermined(P, "AuthorityUndetermined", `validateCommit threw: ${e && e.message}`, { ...base, phase: "VALIDATE", effects: "UNDETERMINED", receipt });
    }
    if (ok !== true) return undetermined(P, "AuthorityRefused", "validateCommit refused the appended record", { ...base, phase: "VALIDATE", effects: "UNDETERMINED", receipt });
  }
  return result(P, "COMMITTED", { ...base, phase: "DONE", receipt, qualifiedGuarantees: ["lock-reverified", "complete-tail", "file-sync", "readback"] });
}

// ── unlinkIfUnchanged / removeEmptyDir ───────────────────────────────────────

/**
 * Remove a file only while it is exactly the expected inode with the expected digest, under a
 * held lock. The object is first CAPTURED into a private tombstone name; identity and digest are
 * verified on the captured object, so a swap between the check and the capture moves the
 * impostor — which is then put back by no-replace link — instead of deleting it.
 */
function unlinkIfUnchanged(opts = {}) {
  const P = "unlinkIfUnchanged";
  const io = fsOf(opts);
  if (!validLeaf(opts.name)) return refused(P, "InputInvalid", "name must be one path component", { phase: "INPUT" });
  const e = opts.expected;
  if (!e || !validId(e.identity) || !SHA256_RE.test(String(e.sha256))) return refused(P, "InputInvalid", "expected must be {identity:{dev,ino}, sha256}", { phase: "INPUT" });
  if (!ISSUED_LOCKS.has(opts.lock)) return refused(P, "InputInvalid", "a held lock is required", { phase: "INPUT" });
  const hc = handleCurrent(opts.dirHandle);
  if (!hc.ok) return refused(P, hc.code, hc.reason, { phase: "PARENT" });
  const backend = opts.dirHandle.backend;
  const lacking = missingCaps(backend, ["noFollow", "renameReplace", "linkNoReplace", "dirSync"]);
  if (lacking.length) return refused(P, "UnsupportedGuarantee", `backend lacks ${lacking.join(", ")}`, { phase: "BACKEND" });
  const base = { backend: backend.id };
  let v = verifyOwnershipInternal(opts.lock);
  if (v.status !== "OWNED") return refused(P, "LockLost", `lock not held (${v.reason})`, { ...base, phase: "LOCK" });
  const dir = opts.dirHandle.real;
  const target = path.join(dir, opts.name);
  const obs = observeEntry(io, target, { digest: true });
  if (obs.state === "undetermined") return undetermined(P, obs.code, "the target could not be observed", { ...base, phase: "PREIMAGE" });
  if (obs.state === "invalid") return refused(P, "OccupiedInvalid", `${opts.name} is a ${obs.kind}`, { ...base, phase: "PREIMAGE" });
  if (obs.state !== "present" || !sameId(obs.id, e.identity) || obs.sha256 !== e.sha256) {
    return refused(P, "PreimageChanged", "the target is not the expected inode and digest", { ...base, phase: "PREIMAGE", before: obs });
  }
  race(opts, "unlink:before-capture", { path: target });
  v = verifyOwnershipInternal(opts.lock);
  if (v.status !== "OWNED") return refused(P, "LockLost", `lock lost before the capture (${v.reason})`, { ...base, phase: "REVERIFY" });
  const tomb = path.join(dir, `.${opts.name.slice(0, 200)}.dio-tomb.${hex(8)}`);
  try {
    io.renameSync(target, tomb);
  } catch (err) {
    if (err && err.code === "ENOENT") return refused(P, "PreimageChanged", "the target vanished before the capture", { ...base, phase: "CAPTURE" });
    return undetermined(P, errCode(err), "the capture rename failed", { ...base, phase: "CAPTURE" });
  }
  race(opts, "unlink:after-capture", { tomb });
  const cap = digestFile(io, tomb, null);
  const putBack = (code, reason, phase) => {
    let heldId = cap.ok ? cap.id : null;
    if (!heldId) {
      try {
        heldId = idOfStat(lstatB(io, tomb));
      } catch {
        heldId = null;
      }
    }
    const conservation = heldId ? restoreCaptured(io, tomb, target, heldId, null) : { outcome: "held", path: tomb, code: "IdentityUnknown" };
    if (conservation.outcome !== "restored") return undetermined(P, code, `${reason}; the captured object is held at ${relTo(dir, tomb)}`, { ...base, phase, conservation, effects: "UNDETERMINED" });
    return refused(P, code, reason, { ...base, phase, conservation });
  };
  if (!cap.ok) return putBack(cap.code === "IdentityChanged" ? "IdentityChanged" : cap.code, "the captured object could not be verified", "VERIFY");
  if (!sameId(cap.id, e.identity)) return putBack("IdentityChanged", "the captured object is not the expected inode; it was put back", "VERIFY");
  if (cap.sha256 !== e.sha256) return putBack("PreimageChanged", "the captured object's digest changed; it was put back", "VERIFY");
  v = verifyOwnershipInternal(opts.lock);
  if (v.status !== "OWNED") return putBack("LockLost", `lock lost before the removal (${v.reason})`, "REVERIFY");
  try {
    io.unlinkSync(tomb);
  } catch (err) {
    return undetermined(P, errCode(err), `the captured object could not be removed; it is held at ${relTo(dir, tomb)}`, { ...base, phase: "UNLINK", effects: "UNDETERMINED", conservation: { outcome: "held", path: tomb } });
  }
  try {
    syncDir(io, dir);
  } catch (err) {
    return undetermined(P, "DirSyncFailed", `the removal could not be synced (${errCode(err)})`, { ...base, phase: "DIR_SYNC", effects: "UNDETERMINED" });
  }
  return result(P, "COMMITTED", { ...base, phase: "DONE", before: { dev: cap.id.dev, ino: cap.id.ino, sha256: cap.sha256 }, after: { absent: true } });
}

/**
 * Remove one EMPTY directory that is exactly the expected inode. rmdir is non-recursive: the
 * kernel refuses a directory that holds anything, so an entry that arrives between the identity
 * check and the removal survives (ENOTEMPTY) instead of being erased with it.
 */
function removeEmptyDir(opts = {}) {
  const P = "removeEmptyDir";
  const io = fsOf(opts);
  if (!validLeaf(opts.name)) return refused(P, "InputInvalid", "name must be one path component", { phase: "INPUT" });
  if (!validId(opts.expected)) return refused(P, "InputInvalid", "expected must be {dev, ino}", { phase: "INPUT" });
  if (opts.lock !== undefined && !ISSUED_LOCKS.has(opts.lock)) return refused(P, "InputInvalid", "lock is not a lock handle this module issued", { phase: "INPUT" });
  const hc = handleCurrent(opts.dirHandle);
  if (!hc.ok) return refused(P, hc.code, hc.reason, { phase: "PARENT" });
  const backend = opts.dirHandle.backend;
  const base = { backend: backend.id };
  const lacking = missingCaps(backend, ["dirSync"]);
  if (lacking.length) return refused(P, "UnsupportedGuarantee", `backend lacks ${lacking.join(", ")}`, { ...base, phase: "BACKEND" });
  if (opts.lock !== undefined) {
    const v = verifyOwnershipInternal(opts.lock);
    if (v.status !== "OWNED") return refused(P, "LockLost", `lock not held (${v.reason})`, { ...base, phase: "LOCK" });
  }
  const dir = opts.dirHandle.real;
  const target = path.join(dir, opts.name);
  let st;
  try {
    st = lstatB(io, target);
  } catch (e) {
    if (e && e.code === "ENOENT") return refused(P, "Absent", `${opts.name} does not exist`, { ...base, phase: "OBSERVE" });
    return undetermined(P, errCode(e), `${opts.name} could not be observed`, { ...base, phase: "OBSERVE" });
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return refused(P, "NotDirectory", `${opts.name} is a ${kindOf(st)} — left as found`, { ...base, phase: "OBSERVE" });
  const id = idOfStat(st);
  if (!sameId(id, opts.expected)) return refused(P, "IdentityChanged", `${opts.name} is not the owned directory`, { ...base, phase: "OBSERVE", before: id });
  race(opts, "rmdir:before-rmdir", { path: target });
  if (opts.lock !== undefined) {
    const v = verifyOwnershipInternal(opts.lock);
    if (v.status !== "OWNED") return refused(P, "LockLost", `lock lost before the removal (${v.reason})`, { ...base, phase: "REVERIFY" });
  }
  try {
    io.rmdirSync(target);
  } catch (e) {
    const c = errCode(e);
    if (c === "ENOTEMPTY" || c === "EEXIST") return refused(P, "NotEmpty", `${opts.name} is not empty — every entry is left in place`, { ...base, phase: "RMDIR", before: id });
    if (c === "ENOENT") return refused(P, "Absent", `${opts.name} vanished before the removal`, { ...base, phase: "RMDIR" });
    if (c === "ENOTDIR") return refused(P, "NotDirectory", `${opts.name} stopped being a directory`, { ...base, phase: "RMDIR" });
    return undetermined(P, c, "rmdir failed", { ...base, phase: "RMDIR" });
  }
  let after = { absent: true };
  try {
    after = { absent: false, replacedBy: idOfStat(lstatB(io, target)) };
  } catch (e) {
    if (!e || e.code !== "ENOENT") after = { absent: null, code: errCode(e) };
  }
  try {
    syncDir(io, dir);
  } catch (e) {
    return undetermined(P, "DirSyncFailed", `the removal could not be synced (${errCode(e)})`, { ...base, phase: "DIR_SYNC", effects: "UNDETERMINED", before: id, after });
  }
  return result(P, "COMMITTED", { ...base, phase: "DONE", before: id, after });
}

// ── lock ─────────────────────────────────────────────────────────────────────

function lockAnchorPath(dirHandle, key) {
  if (!dirHandle || typeof dirHandle.real !== "string") throw new TypeError("lockAnchorPath needs a directory handle");
  if (typeof key !== "string" || !KEY_RE.test(key)) throw new TypeError(`invalid lock key ${JSON.stringify(key)}`);
  return path.join(dirHandle.real, `${key}${ANCHOR_SUFFIX}`);
}

function validOwnerShape(rec, key, gen) {
  if (!rec || typeof rec !== "object") return "not an object";
  if (rec.schema !== OWNER_SCHEMA) return "wrong schema";
  if (key !== undefined && rec.key !== key) return "key mismatch";
  if (!Number.isSafeInteger(rec.gen) || rec.gen < 1 || (gen !== undefined && rec.gen !== gen)) return "generation mismatch";
  if (typeof rec.nonce !== "string" || !NONCE_RE.test(rec.nonce)) return "nonce";
  if (!rec.host || typeof rec.host !== "object" || !(rec.host.id === null || typeof rec.host.id === "string") || typeof rec.host.name !== "string") return "host";
  if (typeof rec.boot !== "string" || rec.boot.length === 0) return "boot";
  if (!(rec.pidNs === null || typeof rec.pidNs === "string")) return "pidNs";
  if (!(rec.uid === null || (Number.isSafeInteger(rec.uid) && rec.uid >= 0))) return "uid";
  if (!Number.isSafeInteger(rec.pid) || rec.pid <= 0) return "pid";
  if (!rec.start || typeof rec.start.kind !== "string" || typeof rec.start.value !== "string") return "start";
  if (typeof rec.label !== "string" || rec.label.length > 200) return "label";
  if (typeof rec.acquiredAt !== "string") return "acquiredAt";
  if (!(rec.supersedes === null || (rec.supersedes && Number.isSafeInteger(rec.supersedes.gen)))) return "supersedes";
  return null;
}

function validReleaseShape(rec, key, gen) {
  if (!rec || typeof rec !== "object" || rec.schema !== RELEASE_SCHEMA) return "wrong schema";
  if (rec.key !== key || rec.gen !== gen) return "key or generation mismatch";
  if (typeof rec.nonce !== "string" || !NONCE_RE.test(rec.nonce)) return "nonce";
  return null;
}

/** Read one lock record without following; malformed content is reported, never interpreted. */
function readLockRecord(io, p) {
  let fd;
  try {
    fd = io.openSync(p, O.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    return { ok: false, code: errCode(e) };
  }
  try {
    const st = fstatB(io, fd);
    if (!st.isFile()) return { ok: false, code: "OccupiedInvalid" };
    const rd = readAllBounded(io, fd, LOCK_RECORD_MAX_BYTES);
    if (!rd.ok) return { ok: false, code: rd.code === "TooLarge" ? "Malformed" : rd.code };
    const id = idOfStat(st);
    let rec;
    try {
      const text = UTF8.decode(rd.bytes);
      if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) return { ok: false, code: "Malformed", id, bytes: rd.bytes };
      rec = JSON.parse(text);
    } catch {
      return { ok: false, code: "Malformed", id, bytes: rd.bytes };
    }
    return { ok: true, rec, id, bytes: rd.bytes };
  } finally {
    closeQuietly(io, fd);
  }
}

/** The anchor's entries, or why they cannot be trusted. Unknown entries mean "not a lock". */
function readAnchor(io, anchor) {
  let st;
  try {
    st = lstatB(io, anchor);
  } catch (e) {
    if (e && e.code === "ENOENT") return { status: "absent" };
    return { status: "undetermined", code: errCode(e) };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    let preserved = { kind: kindOf(st) };
    if (st.isFile()) {
      const d = digestFile(io, anchor, null, LOCK_RECORD_MAX_BYTES * 16);
      if (d.ok) preserved = { kind: "file", sha256: d.sha256, size: d.bytes.length };
    }
    return { status: "invalid", reason: `the lock path is a ${kindOf(st)}, not a lock anchor`, preserved };
  }
  let names;
  try {
    names = io.readdirSync(anchor);
  } catch (e) {
    return { status: "undetermined", code: errCode(e) };
  }
  const owners = new Map();
  const released = new Set();
  const stages = [];
  for (const name of names) {
    const m = ENTRY_RE.exec(name);
    if (m) {
      const gen = Number(m[1]);
      if (m[2] === "owner") owners.set(gen, name);
      else released.add(gen);
      continue;
    }
    if (STAGE_RE.test(name)) {
      stages.push(name);
      continue;
    }
    return { status: "invalid", reason: `the lock anchor holds an entry that is not a lock record: ${JSON.stringify(name)}`, preserved: { entry: name } };
  }
  let maxGen = 0;
  for (const g of owners.keys()) if (g > maxGen) maxGen = g;
  return { status: "ok", id: idOfStat(st), owners, released, stages, maxGen };
}

function holderView(rec) {
  return { gen: rec.gen, nonce: rec.nonce, pid: rec.pid, host: { ...rec.host }, boot: rec.boot, start: { ...rec.start }, label: rec.label, acquiredAt: rec.acquiredAt };
}

function ownIdentityFields(backend) {
  const id = backend.identity;
  return { host: { id: id.hostId, name: os.hostname() }, boot: id.bootId, pidNs: id.pidNs, uid: currentUid(), pid: process.pid, start: { ...id.ownStart } };
}

/**
 * Is the owner of a lock record alive? Positive evidence only: DEAD when its pid is absent from
 * the process table, held by a different start, a zombie, or from a previous boot of THIS host;
 * LIVE when the same pid carries the same start; UNDETERMINED for everything else.
 */
function probeOwnerInternal(backend, owner, opts = {}) {
  const P = "probeOwner";
  const ident = backend.identity;
  const bad = validOwnerShape(owner);
  if (bad) return { primitive: P, status: "UNDETERMINED", code: "OwnerUnknown", evidence: { status: "UNDETERMINED", reason: `malformed owner (${bad})` } };
  const ev = { pid: owner.pid, boot: owner.boot, hostId: owner.host.id, start: owner.start.value };
  const unknown = (reason, extra = {}) => ({ primitive: P, status: "UNDETERMINED", code: "OwnerUnknown", evidence: { ...ev, status: "UNDETERMINED", reason, ...extra } });
  const dead = (reason, extra = {}) => ({ primitive: P, status: "DEAD", evidence: { ...ev, status: "DEAD", reason, ...extra } });
  // Every DEAD below compares the owner against THIS process's measured boot and start identity;
  // without them no comparison can be positive evidence of anything.
  if (typeof ident.bootId !== "string" || ident.bootId.length === 0 || !ident.ownStart) return unknown("own-identity-unmeasured");
  const hostKnown = typeof ident.hostId === "string" && typeof owner.host.id === "string";
  if (owner.boot !== ident.bootId) {
    if (hostKnown && owner.host.id === ident.hostId) return dead("previous-boot");
    return unknown(hostKnown ? "foreign-host" : "host-unverifiable");
  }
  if (hostKnown && owner.host.id !== ident.hostId) return unknown("same boot id on a different host id");
  if ((owner.pidNs === undefined ? null : owner.pidNs) !== (ident.pidNs === undefined ? null : ident.pidNs)) return unknown("other-pid-namespace");
  if (!ident.ownStart || owner.start.kind !== ident.ownStart.kind) return unknown("start-identity-kind-differs");
  if (ident.procHidesOthers !== false && owner.uid !== currentUid()) return unknown("process-table-may-hide-other-users");
  const reader = typeof opts.__readProcess === "function" ? opts.__readProcess : (pid) => readProcess(pid);
  const row = reader(owner.pid);
  if (!row || row.status === "UNDETERMINED") return unknown("process-table-unreadable", { code: row && row.code });
  if (row.status === "ABSENT") return dead("absent");
  if (row.status !== "PRESENT") return unknown("process-table-unreadable");
  if (row.start !== owner.start.value) return dead("start-mismatch", { observedStart: row.start });
  if (isGone(row.state)) return dead("exited-unreaped", { state: row.state });
  return { primitive: P, status: "LIVE", evidence: { ...ev, status: "LIVE", reason: "start-verified", state: row.state } };
}

function probeOwner(opts = {}) {
  const b = backendCurrent(opts.backend);
  if (!b.ok) return { primitive: "probeOwner", status: "UNDETERMINED", code: "BackendUnqualified", evidence: { status: "UNDETERMINED", reason: b.reason } };
  return probeOwnerInternal(opts.backend, opts.owner, opts);
}

/** Write a complete record to a fresh stage inside the anchor and fsync it. */
function stageRecord(io, anchor, bytes) {
  const p = path.join(anchor, `.stage.${process.pid}.${hex(8)}`);
  let fd;
  try {
    fd = io.openSync(p, O.O_CREAT | O.O_EXCL | O.O_WRONLY | O_NOFOLLOW | O_NONBLOCK, 0o600);
  } catch (e) {
    return { ok: false, code: errCode(e) };
  }
  let id;
  try {
    id = idOfStat(fstatB(io, fd));
    const w = writeAll(io, fd, bytes, 0);
    if (!w.ok) throw Object.assign(new Error("short stage write"), { code: w.code });
    io.fsyncSync(fd);
  } catch (e) {
    closeQuietly(io, fd);
    if (id) removeExact(io, p, id);
    return { ok: false, code: errCode(e) };
  }
  const c = closeQuietly(io, fd);
  if (c) {
    removeExact(io, p, id);
    return { ok: false, code: c };
  }
  return { ok: true, path: p, id };
}

/** Under the held lock: drop generations older than the two before `gen`, and dead stages. */
function pruneAnchor(io, backend, anchor, state, gen, opts) {
  const removed = [];
  const kept = [];
  let budget = LOCK_PRUNE_BUDGET;
  const floor = gen - LOCK_KEEP_PREVIOUS - 1;
  const candidates = [];
  for (const [g, name] of state.owners) if (g <= floor) candidates.push(name);
  for (const g of state.released) if (g <= floor) candidates.push(`g${g}.released`);
  for (const name of candidates.sort()) {
    if (budget <= 0) break;
    budget -= 1;
    const p = path.join(anchor, name);
    const rec = readLockRecord(io, p);
    if (!rec.ok) {
      kept.push({ entry: name, reason: rec.code });
      continue;
    }
    const rm = removeExact(io, p, rec.id);
    if (rm.ok) removed.push(name);
    else kept.push({ entry: name, reason: rm.code });
  }
  for (const name of state.stages.sort()) {
    if (budget <= 0) break;
    budget -= 1;
    const p = path.join(anchor, name);
    const rec = readLockRecord(io, p);
    // A stage carries its writer's identity; only a positively DEAD writer's stage is removed.
    const owner = rec.ok && rec.rec && rec.rec.schema === OWNER_SCHEMA ? rec.rec : rec.ok && rec.rec && rec.rec.schema === RELEASE_SCHEMA ? { ...rec.rec, schema: OWNER_SCHEMA, label: "", acquiredAt: "", supersedes: null } : null;
    const live = owner ? probeOwnerInternal(backend, owner, opts) : null;
    if (!live || live.status !== "DEAD") {
      kept.push({ entry: name, reason: live ? live.status : "unreadable" });
      continue;
    }
    const rm = removeExact(io, p, rec.id);
    if (rm.ok) removed.push(name);
    else kept.push({ entry: name, reason: rm.code });
  }
  if (removed.length) {
    try {
      syncDir(io, anchor);
    } catch (e) {
      kept.push({ entry: ".", reason: `prune sync ${errCode(e)}` });
    }
  }
  return { removed, kept };
}

function attemptAcquire(io, opts, backend, anchor) {
  const P = "acquireLock";
  let state = readAnchor(io, anchor);
  if (state.status === "absent") {
    try {
      io.mkdirSync(anchor, { mode: 0o700 });
      syncDir(io, path.dirname(anchor));
    } catch (e) {
      if (!e || e.code !== "EEXIST") return { primitive: P, status: "UNDETERMINED", code: errCode(e), reason: "the lock anchor could not be created", effects: "UNDETERMINED" };
    }
    state = readAnchor(io, anchor);
  }
  if (state.status === "invalid") return { primitive: P, status: "OCCUPIED_INVALID", code: "OccupiedInvalid", reason: state.reason, preserved: state.preserved };
  if (state.status !== "ok") return { primitive: P, status: "UNDETERMINED", code: state.code || "IoUndetermined", reason: "the lock anchor could not be read" };
  const key = opts.key;
  let supersedes = null;
  if (state.maxGen > 0) {
    const g = state.maxGen;
    const rec = readLockRecord(io, path.join(anchor, `g${g}.owner`));
    if (!rec.ok) {
      if (rec.code === "Malformed" || rec.code === "OccupiedInvalid") {
        return { primitive: P, status: "OCCUPIED_INVALID", code: "OccupiedInvalid", reason: `g${g}.owner is not a valid owner record`, preserved: { entry: `g${g}.owner`, sha256: rec.bytes ? sha256(rec.bytes) : null } };
      }
      if (rec.code === "ENOENT") return { primitive: P, status: "RETRY" };
      return { primitive: P, status: "UNDETERMINED", code: rec.code, reason: `g${g}.owner could not be read` };
    }
    const bad = validOwnerShape(rec.rec, key, g);
    if (bad) return { primitive: P, status: "OCCUPIED_INVALID", code: "OccupiedInvalid", reason: `g${g}.owner is not a valid owner record (${bad})`, preserved: { entry: `g${g}.owner`, sha256: sha256(rec.bytes) } };
    race(opts, "lock:after-read", { gen: g, owner: rec.rec });
    if (state.released.has(g)) {
      const rel = readLockRecord(io, path.join(anchor, `g${g}.released`));
      if (!rel.ok || validReleaseShape(rel.rec, key, g) || rel.rec.nonce !== rec.rec.nonce) {
        return { primitive: P, status: "OCCUPIED_INVALID", code: "OccupiedInvalid", reason: `g${g}.released does not match its owner record`, preserved: { entry: `g${g}.released` } };
      }
    } else {
      const live = probeOwnerInternal(backend, rec.rec, opts);
      if (live.status === "LIVE") return { primitive: P, status: "BUSY", code: "Busy", reason: "the lock is held by a live owner", holder: holderView(rec.rec), liveness: "LIVE", evidence: live.evidence };
      if (live.status !== "DEAD") {
        return { primitive: P, status: "UNDETERMINED", code: "OwnerUnknown", reason: `the holder's liveness cannot be established (${live.evidence.reason})`, holder: holderView(rec.rec), liveness: "UNDETERMINED", evidence: live.evidence };
      }
      supersedes = { gen: g, nonce: rec.rec.nonce, evidence: live.evidence };
    }
  }
  const gen = state.maxGen + 1;
  const token = {
    schema: OWNER_SCHEMA,
    key,
    gen,
    nonce: hex(16),
    ...ownIdentityFields(backend),
    label: typeof opts.label === "string" ? opts.label : "",
    acquiredAt: nowIso(),
    supersedes,
  };
  const bytes = Buffer.from(`${JSON.stringify(token)}\n`, "utf8");
  const stage = stageRecord(io, anchor, bytes);
  if (!stage.ok) return { primitive: P, status: "UNDETERMINED", code: stage.code, reason: "the owner record could not be staged", effects: "NONE" };
  race(opts, "lock:after-stage", { stagePath: stage.path, gen });
  const ownerPath = path.join(anchor, `g${gen}.owner`);
  try {
    io.linkSync(stage.path, ownerPath);
  } catch (e) {
    removeExact(io, stage.path, stage.id);
    if (e && e.code === "EEXIST") return { primitive: P, status: "RETRY" };
    return { primitive: P, status: "UNDETERMINED", code: errCode(e), reason: "the owner record could not be published", effects: "NONE" };
  }
  const stageGone = removeExact(io, stage.path, stage.id);
  race(opts, "lock:after-link", { ownerPath, gen });
  const handle = Object.freeze({
    backend,
    dirHandle: opts.dirHandle,
    key,
    anchor,
    anchorId: state.id,
    gen,
    nonce: token.nonce,
    ownerId: stage.id,
    tokenBytes: bytes,
    token: Object.freeze({ ...token }),
  });
  ISSUED_LOCKS.add(handle);
  try {
    syncDir(io, anchor);
  } catch (e) {
    return { primitive: P, status: "UNDETERMINED", code: "DirSyncFailed", reason: `the owner record was published but not synced (${errCode(e)}); release it with this handle`, handle, effects: "UNDETERMINED" };
  }
  const after = readAnchor(io, anchor);
  if (after.status !== "ok") return { primitive: P, status: "UNDETERMINED", code: after.code || "OccupiedInvalid", reason: "the anchor could not be re-read after publication", handle, effects: "UNDETERMINED" };
  if (after.maxGen !== gen || !sameId(after.id, state.id)) {
    // A straggler that re-created a generation below the current one: not the holder. Its record
    // is removed by exact identity and the attempt is re-evaluated.
    removeExact(io, ownerPath, stage.id);
    return { primitive: P, status: "RETRY" };
  }
  const prune = pruneAnchor(io, backend, anchor, after, gen, opts);
  return {
    primitive: P,
    status: "HELD",
    code: null,
    handle,
    receipt: { gen, nonce: token.nonce, acquiredAt: token.acquiredAt, supersedes, prune, stageRetained: stageGone.ok ? null : stage.path },
  };
}

/**
 * Acquire the lock `key` in a pinned directory, waiting up to `deadlineMs` for a live holder.
 * Not re-entrant: this process's own live hold reads BUSY like anyone else's.
 */
function acquireLock(opts = {}) {
  const P = "acquireLock";
  const io = fsOf(opts);
  if (typeof opts.key !== "string" || !KEY_RE.test(opts.key)) return { primitive: P, status: "REFUSED", code: "InputInvalid", reason: "key must match [A-Za-z0-9][A-Za-z0-9._-]{0,99}" };
  if (!Number.isSafeInteger(opts.deadlineMs) || opts.deadlineMs < 0) return { primitive: P, status: "REFUSED", code: "InputInvalid", reason: "deadlineMs must be a non-negative integer" };
  const pollMs = opts.pollMs === undefined ? 25 : opts.pollMs;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) return { primitive: P, status: "REFUSED", code: "InputInvalid", reason: "pollMs must be a positive integer" };
  if (opts.label !== undefined && (typeof opts.label !== "string" || opts.label.length > 200)) return { primitive: P, status: "REFUSED", code: "InputInvalid", reason: "label must be a string of at most 200 characters" };
  const hc = handleCurrent(opts.dirHandle);
  if (!hc.ok) {
    const status = hc.code === "BackendUnqualified" ? "UNSUPPORTED" : hc.code === "InputInvalid" ? "REFUSED" : "UNDETERMINED";
    return { primitive: P, status, code: hc.code, reason: hc.reason };
  }
  const backend = opts.dirHandle.backend;
  const lacking = missingCaps(backend, ["linkNoReplace", "exclusiveCreate", "fileSync", "dirSync", "noFollow", "processIdentity"]);
  if (lacking.length) return { primitive: P, status: "UNSUPPORTED", code: "UnsupportedGuarantee", reason: `backend lacks ${lacking.join(", ")}` };
  const anchor = lockAnchorPath(opts.dirHandle, opts.key);
  const deadline = Date.now() + opts.deadlineMs;
  let races = 0;
  let polls = 0;
  for (;;) {
    const r = attemptAcquire(io, opts, backend, anchor);
    if (r.status === "RETRY") {
      races += 1;
      if (races > LOCK_LINK_RACE_RETRIES) return { primitive: P, status: "UNDETERMINED", code: "Busy", reason: "lost the publication race repeatedly" };
      continue;
    }
    const waitable = r.status === "BUSY" || (r.status === "UNDETERMINED" && r.code === "OwnerUnknown");
    if (!waitable) return { ...r, waited: { polls } };
    const left = deadline - Date.now();
    if (left <= 0) return { ...r, waited: { polls } };
    polls += 1;
    race(opts, "lock:poll", { attempt: polls, holder: r.holder });
    sleepMs(Math.min(pollMs, left));
  }
}

/** Ownership, re-derived from disk: our record intact, not released, nothing above it. */
function verifyOwnershipInternal(handle) {
  if (!ISSUED_LOCKS.has(handle)) return { status: "REFUSED_UNKNOWN", code: "InputInvalid", reason: "not a lock handle this module issued" };
  if (handle.token.pid !== process.pid) return { status: "REFUSED_STALE", reason: "other-process" };
  const b = backendCurrent(handle.backend);
  if (!b.ok) return { status: "REFUSED_UNKNOWN", code: "BackendUnqualified", reason: b.reason };
  const state = readAnchor(fs, handle.anchor);
  if (state.status === "absent") return { status: "REFUSED_STALE", reason: "anchor-gone" };
  if (state.status !== "ok") return { status: "REFUSED_UNKNOWN", code: state.code || "OccupiedInvalid", reason: state.reason || "anchor unreadable" };
  if (!sameId(state.id, handle.anchorId)) return { status: "REFUSED_UNKNOWN", code: "IdentityChanged", reason: "anchor-replaced" };
  if (state.maxGen > handle.gen) return { status: "REFUSED_STALE", reason: "superseded", successorGen: state.maxGen };
  if (state.released.has(handle.gen)) return { status: "REFUSED_STALE", reason: "released" };
  const rec = readLockRecord(fs, path.join(handle.anchor, `g${handle.gen}.owner`));
  if (!rec.ok) return rec.code === "ENOENT" ? { status: "REFUSED_STALE", reason: "record-gone" } : { status: "REFUSED_UNKNOWN", code: rec.code, reason: "record-unreadable" };
  if (!sameId(rec.id, handle.ownerId) || !rec.bytes.equals(handle.tokenBytes)) return { status: "REFUSED_STALE", reason: "record-changed" };
  return { status: "OWNED", gen: handle.gen, nonce: handle.nonce };
}

function verifyLockOwnership(opts = {}) {
  return { primitive: "verifyLockOwnership", ...verifyOwnershipInternal(opts.handle) };
}

/**
 * Run one caller-defined destructive step only while ownership re-verifies — and, when given,
 * only while the step's target is still the expected inode and digest.
 */
function withOwnedStep(opts = {}) {
  const P = "withOwnedStep";
  const v = verifyOwnershipInternal(opts.handle);
  if (v.status !== "OWNED") return { primitive: P, ...v };
  if (typeof opts.operation !== "function") return { primitive: P, status: "REFUSED_UNKNOWN", code: "InputInvalid", reason: "operation must be a function" };
  const e = opts.expectedContentIdentity;
  if (e !== undefined) {
    if (!e || typeof e.path !== "string" || !path.isAbsolute(e.path) || !validId(e) || (e.sha256 !== undefined && !SHA256_RE.test(String(e.sha256)))) {
      return { primitive: P, status: "REFUSED_UNKNOWN", code: "InputInvalid", reason: "expectedContentIdentity must be {path, dev, ino, sha256?}" };
    }
    const obs = observeEntry(fs, e.path, { digest: e.sha256 !== undefined });
    if (obs.state === "undetermined") return { primitive: P, status: "REFUSED_UNKNOWN", code: obs.code, reason: "target-unreadable" };
    if (obs.state !== "present" || !sameId(obs.id, e) || (e.sha256 !== undefined && obs.sha256 !== e.sha256)) {
      return { primitive: P, status: "REFUSED_STALE", reason: "target-changed", observed: obs };
    }
  }
  let value;
  try {
    value = opts.operation({ handle: opts.handle, ownership: v });
  } catch (err) {
    return { primitive: P, status: "IO_UNDETERMINED", retainedEvidence: { error: String((err && err.message) || err) } };
  }
  return { primitive: P, status: "DURABLE", result: value, beforeAfterReceipt: { before: v, after: verifyOwnershipInternal(opts.handle) } };
}

/** Mark exactly the acquired generation released. A stale handle never touches a successor. */
function releaseLock(opts = {}) {
  const P = "releaseLock";
  const io = fsOf(opts);
  const h = opts.handle;
  const v = verifyOwnershipInternal(h);
  if (v.status === "REFUSED_STALE" && v.reason === "released") {
    const rel = readLockRecord(io, path.join(h.anchor, `g${h.gen}.released`));
    if (rel.ok && !validReleaseShape(rel.rec, h.key, h.gen) && rel.rec.nonce === h.nonce) {
      return { primitive: P, status: "ALREADY_RELEASED", positiveEvidence: { gen: h.gen, nonce: rel.rec.nonce, dev: rel.id.dev, ino: rel.id.ino } };
    }
    return { primitive: P, status: "REFUSED_UNKNOWN", code: "OccupiedInvalid", reason: "a release marker exists that is not this holder's" };
  }
  if (v.status !== "OWNED") return { primitive: P, ...v };
  const rec = { schema: RELEASE_SCHEMA, key: h.key, gen: h.gen, nonce: h.nonce, ...ownIdentityFields(h.backend), releasedAt: nowIso() };
  const stage = stageRecord(io, h.anchor, Buffer.from(`${JSON.stringify(rec)}\n`, "utf8"));
  if (!stage.ok) return { primitive: P, status: "IO_UNDETERMINED", code: stage.code, reason: "the release record could not be staged", effects: "NONE" };
  race(opts, "release:before-link", { stagePath: stage.path });
  const v2 = verifyOwnershipInternal(h);
  if (v2.status !== "OWNED") {
    removeExact(io, stage.path, stage.id);
    return { primitive: P, ...v2 };
  }
  const relPath = path.join(h.anchor, `g${h.gen}.released`);
  try {
    io.linkSync(stage.path, relPath);
  } catch (e) {
    removeExact(io, stage.path, stage.id);
    if (e && e.code === "EEXIST") return releaseLock({ handle: h });
    return { primitive: P, status: "IO_UNDETERMINED", code: errCode(e), reason: "the release record could not be published" };
  }
  removeExact(io, stage.path, stage.id);
  try {
    syncDir(io, h.anchor);
  } catch (e) {
    return { primitive: P, status: "IO_UNDETERMINED", code: "DirSyncFailed", reason: `the release was published but not synced (${errCode(e)})`, effects: "UNDETERMINED" };
  }
  return { primitive: P, status: "RELEASED", receipt: { gen: h.gen, nonce: h.nonce, releasedAt: rec.releasedAt } };
}

// ── claimOnce ────────────────────────────────────────────────────────────────

function callValidator(fn, args) {
  try {
    const r = fn(args);
    if (r && r.ok === true) return { ok: true, value: r };
    return { ok: false, code: r && typeof r.code === "string" ? r.code : "AuthorityRefused", reason: r && r.reason ? String(r.reason) : "refused" };
  } catch (e) {
    return { ok: false, code: "AuthorityUndetermined", reason: `validator threw: ${e && e.message}` };
  }
}

/**
 * Consume a validated object at most once. The candidate is opened and its identity read on the
 * fd; it is then CAPTURED into custody by one atomic rename, and the captured entry must be the
 * opened inode — otherwise whatever was captured is put back by no-replace link and the claim
 * refuses. Bytes, digest and both domain validators run on the held object; the use is committed
 * through the caller's `commitUse` (an appendRecord under the caller's lock) before the held
 * object is marked consumed and a grant is emitted. Refusals restore the original name only when
 * it is vacant; otherwise the object is quarantined in custody and named.
 */
function claimOnce(opts = {}) {
  const P = "claimOnce";
  const io = fsOf(opts);
  if (!Array.isArray(opts.candidates) || opts.candidates.length === 0 || opts.candidates.length > 16) return refused(P, "InputInvalid", "candidates must be 1..16 entries");
  for (const c of opts.candidates) {
    if (!c || !ISSUED_DIRS.has(c.dirHandle) || !validRelative(c.name)) return refused(P, "InputInvalid", "each candidate must be {dirHandle, name}");
  }
  const d = opts.completeCallDescriptor;
  if (!d || typeof d !== "object" || Array.isArray(d) || typeof d.schema !== "string" || d.schema.length === 0) {
    return refused(P, "InputInvalid", "completeCallDescriptor must be an object with a schema version");
  }
  let callDigest;
  try {
    callDigest = sha256(canonicalJson(d));
  } catch (e) {
    return refused(P, "InputInvalid", `completeCallDescriptor is not serialisable (${e.message})`);
  }
  if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 1 || opts.maxBytes > 1024 * 1024) return refused(P, "InputInvalid", "maxBytes must be 1..1048576");
  for (const fn of ["validateReceipt", "validatePolicy", "commitUse"]) {
    if (typeof opts[fn] !== "function") return refused(P, "InputInvalid", `${fn} must be a function`);
  }
  const hc = handleCurrent(opts.custodyHandle);
  if (!hc.ok) return refused(P, hc.code, `custody: ${hc.reason}`);
  const custody = opts.custodyHandle;
  const lacking = missingCaps(custody.backend, ["renameReplace", "linkNoReplace", "noFollow", "dirSync"]);
  if (lacking.length) return refused(P, "UnsupportedGuarantee", `backend lacks ${lacking.join(", ")}`);
  for (const c of opts.candidates) {
    if (c.dirHandle.dev !== custody.dev) return refused(P, "UnsupportedGuarantee", "custody must be on the same device as every candidate (an atomic rename cannot cross devices)");
  }
  const observations = [];
  for (const cand of opts.candidates) {
    const pr = probe({ dirHandle: cand.dirHandle, name: cand.name, __fs: opts.__fs });
    const obs = { name: cand.name, status: pr.status, code: pr.code || null, cause: pr.cause || null, scope: pr.scope || null };
    observations.push(obs);
    if (pr.status === "ABSENT") continue;
    if (pr.status !== "PRESENT") return undetermined(P, pr.code, "a candidate could not be observed; the claim does not fall through on an unknown", { observations });
    if (pr.kind !== "file") return refused(P, "OccupiedInvalid", `${cand.name} is a ${pr.kind}, not a receipt — left as found`, { observations });
    const out = claimCandidate(io, opts, cand, custody, callDigest, observations);
    if (out === "RACED_ABSENT") {
      obs.status = "ABSENT";
      obs.cause = "claimed-or-removed-concurrently";
      continue;
    }
    return out;
  }
  return { primitive: P, status: "ABSENT", effects: "NONE", observations };
}

function claimCandidate(io, opts, cand, custody, callDigest, observations) {
  const P = "claimOnce";
  const original = path.join(cand.dirHandle.real, cand.name);
  let fd;
  try {
    fd = io.openSync(original, O.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    if (e && e.code === "ENOENT") return "RACED_ABSENT";
    if (e && e.code === "ELOOP") return refused(P, "OccupiedInvalid", `${cand.name} became a symlink`, { observations });
    return undetermined(P, errCode(e), `${cand.name} could not be opened`, { observations });
  }
  try {
    let st;
    try {
      st = fstatB(io, fd);
    } catch (e) {
      return undetermined(P, errCode(e), "the opened candidate could not be identified", { observations });
    }
    if (!st.isFile()) return refused(P, "OccupiedInvalid", `${cand.name} is not a regular file`, { observations });
    if (st.nlink !== 1n) return refused(P, "OccupiedInvalid", `${cand.name} has ${st.nlink} names; an aliased receipt could be spent twice — left as found`, { observations });
    const objectIdentity = { ...idOfStat(st), mode: Number(st.mode) & 0o7777, size: String(st.size) };
    race(opts, "claim:after-open", { path: original });
    const claimId = hex(16);
    const heldPath = path.join(custody.real, `${claimId}.held`);
    const quarantinePath = path.join(custody.real, `${claimId}.quarantined`);
    try {
      io.renameSync(original, heldPath);
    } catch (e) {
      if (e && e.code === "ENOENT") return "RACED_ABSENT";
      return undetermined(P, errCode(e), "the capture rename failed", { observations, claimId });
    }
    race(opts, "claim:after-capture", { heldPath, original });
    let heldId;
    try {
      heldId = idOfStat(lstatB(io, heldPath));
    } catch (e) {
      return undetermined(P, errCode(e), "the captured object could not be identified", { observations, claimId, heldClaim: heldPath, effects: "UNDETERMINED" });
    }
    const conserveAndRefuse = (code, reason, extra = {}) => {
      const conservation = restoreCaptured(io, heldPath, original, heldId, quarantinePath);
      if (conservation.outcome === "held") {
        return undetermined(P, code, `${reason}; the object is held in custody`, { observations, claimId, conservation, heldClaim: heldPath, effects: "UNDETERMINED", ...extra });
      }
      return refused(P, code, reason, { observations, claimId, conservation, ...extra });
    };
    if (!sameId(heldId, objectIdentity)) return conserveAndRefuse("IdentityChanged", "the captured object is not the one that was opened; it was put back untouched");
    const rd = readAllBounded(io, fd, opts.maxBytes);
    if (!rd.ok) return conserveAndRefuse(rd.code === "TooLarge" ? "InputInvalid" : rd.code, `the receipt could not be read within ${opts.maxBytes} bytes`);
    let st2;
    try {
      st2 = fstatB(io, fd);
    } catch (e) {
      return conserveAndRefuse(errCode(e), "the held object could not be re-identified");
    }
    if (!sameId(idOfStat(st2), objectIdentity) || st2.size !== st.size || st2.nlink !== 1n) return conserveAndRefuse("IdentityChanged", "the held object changed while it was read");
    const contentDigest = sha256(rd.bytes);
    const args = { bytes: rd.bytes, sha256: contentDigest, identity: objectIdentity, descriptor: opts.completeCallDescriptor, callDigest, candidate: cand.name, claimId };
    const vr = callValidator(opts.validateReceipt, args);
    if (!vr.ok) return conserveAndRefuse(vr.code, vr.reason);
    const vp = callValidator(opts.validatePolicy, args);
    if (!vp.ok) return conserveAndRefuse(vp.code, vp.reason);
    race(opts, "claim:before-commit", { heldPath });
    let use;
    try {
      use = opts.commitUse({ claimId, callDigest, contentDigest, objectIdentity, candidate: cand.name });
    } catch (e) {
      use = { status: "UNDETERMINED", code: "AuthorityUndetermined", reason: `commitUse threw: ${e && e.message}` };
    }
    if (!use || use.status !== "COMMITTED") {
      if (use && use.status === "REFUSED" && use.effects === "NONE") return conserveAndRefuse(use.code || "AuthorityRefused", "the use could not be recorded; nothing was spent", { useCommit: use });
      return undetermined(P, (use && use.code) || "AuthorityUndetermined", "the use record is not known durable; the object is held in custody and no grant is emitted", {
        observations,
        claimId,
        callDigest,
        contentDigest,
        heldClaim: heldPath,
        useCommit: use || null,
        effects: "UNDETERMINED",
      });
    }
    const consumedPath = path.join(custody.real, `${claimId}.consumed`);
    race(opts, "claim:before-consume", { heldPath, consumedPath });
    const heldUndetermined = (code, reason) =>
      undetermined(P, code, reason, { observations, claimId, callDigest, contentDigest, heldClaim: heldPath, useCommit: use, effects: "UNDETERMINED" });
    try {
      io.renameSync(heldPath, consumedPath);
    } catch (e) {
      return heldUndetermined(errCode(e), "the use is recorded but the held object could not be marked consumed");
    }
    try {
      if (!sameId(idOfStat(lstatB(io, consumedPath)), objectIdentity)) return heldUndetermined("IdentityChanged", "the consumed entry is not the held object");
      syncDir(io, custody.real);
      syncDir(io, cand.dirHandle.real);
    } catch (e) {
      return heldUndetermined("DirSyncFailed", `consumption could not be verified durable (${errCode(e)})`);
    }
    return {
      primitive: P,
      status: "COMMITTED",
      code: null,
      effects: "DURABLE",
      grantToken: hex(16),
      claimId,
      callDigest,
      objectIdentity,
      contentDigest,
      useCommit: use,
      conservation: { outcome: "consumed", consumedPath },
      observations,
    };
  } finally {
    closeQuietly(io, fd);
  }
}

// ── own-child process signalling ─────────────────────────────────────────────

/** Record a just-spawned child's identity from the process table: pid, start, command, parent. */
function recordOwnChild(opts = {}) {
  const P = "recordOwnChild";
  const b = backendCurrent(opts.backend);
  if (!b.ok) return { primitive: P, status: "REFUSED", code: "BackendUnqualified", reason: b.reason };
  const child = opts.child;
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return { primitive: P, status: "REFUSED", code: "InputInvalid", reason: "child must carry a pid" };
  if (child.exitCode !== null || child.signalCode !== null) return { primitive: P, status: "REFUSED", code: "NotRunning", reason: "the child has already exited" };
  const row = readProcess(child.pid, { withCommand: true });
  if (row.status === "ABSENT") return { primitive: P, status: "REFUSED", code: "NotRunning", reason: "the pid is not in the process table" };
  if (row.status !== "PRESENT") return { primitive: P, status: "UNDETERMINED", code: row.code, reason: "the process table could not be read" };
  if (row.ppid !== process.pid) return { primitive: P, status: "REFUSED", code: "IdentityChanged", reason: `pid ${child.pid} is not a child of this process (parent ${row.ppid})` };
  if (isGone(row.state)) return { primitive: P, status: "REFUSED", code: "NotRunning", reason: "the child has exited and is awaiting reaping" };
  const record = Object.freeze({
    pid: child.pid,
    ppid: row.ppid,
    start: Object.freeze({ kind: opts.backend.identity.ownStart.kind, value: row.start }),
    command: row.command,
    recordedAt: nowIso(),
  });
  return { primitive: P, status: "RECORDED", record };
}

function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ exited: true, code: child.exitCode, signal: child.signalCode });
      return;
    }
    let timer = null;
    const onExit = (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ exited: true, code, signal });
    };
    child.once("exit", onExit);
    timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve({ exited: false, code: null, signal: null });
    }, ms);
  });
}

/**
 * Deliver one termination signal to this process's OWN child, and only after re-verifying —
 * immediately before — that the pid still carries the recorded start, command line and parent.
 * Every decision is passed to `log` (refused, verified, signalled, after); the exit is awaited
 * and checked against the process table afterwards.
 */
async function signalOwnChild(opts = {}) {
  const P = "signalOwnChild";
  const { child, record, signal, log } = opts;
  if (typeof signal !== "string" || !TERMINATION_SIGNALS.has(signal)) return { primitive: P, status: "REFUSED", code: "InputInvalid", reason: "signal must be one of SIGTERM, SIGINT, SIGKILL, SIGHUP" };
  if (typeof log !== "function") return { primitive: P, status: "REFUSED", code: "InputInvalid", reason: "a log function is required" };
  if (!Number.isSafeInteger(opts.awaitExitMs) || opts.awaitExitMs < 0) return { primitive: P, status: "REFUSED", code: "InputInvalid", reason: "awaitExitMs must be a non-negative integer" };
  if (!child || typeof child.kill !== "function" || typeof child.once !== "function" || !Number.isSafeInteger(child.pid)) {
    return { primitive: P, status: "REFUSED", code: "InputInvalid", reason: "child must be a ChildProcess" };
  }
  const refuse = (code, reason, extra = {}) => {
    log({ phase: "refused", pid: child.pid, signal, code, reason, at: nowIso(), ...extra });
    return { primitive: P, status: "REFUSED", code, reason, ...extra };
  };
  const b = backendCurrent(opts.backend);
  if (!b.ok) return refuse("BackendUnqualified", b.reason);
  if (!record || record.pid !== child.pid || !record.start || typeof record.command !== "string") return refuse("IdentityChanged", "the record is not this child's");
  if (child.exitCode !== null || child.signalCode !== null) return refuse("NotRunning", "the child has already exited");
  const row = readProcess(child.pid, { withCommand: true });
  if (row.status === "ABSENT") return refuse("NotRunning", "the pid is not in the process table");
  if (row.status !== "PRESENT") {
    log({ phase: "refused", pid: child.pid, signal, code: row.code, reason: "process table unreadable", at: nowIso() });
    return { primitive: P, status: "UNDETERMINED", code: row.code, reason: "the process table could not be read; nothing was signalled" };
  }
  const mismatch = [];
  if (record.start.kind !== opts.backend.identity.ownStart.kind || row.start !== record.start.value) mismatch.push("start");
  if (row.command !== record.command) mismatch.push("command");
  if (row.ppid !== process.pid || record.ppid !== process.pid) mismatch.push("parent");
  if (mismatch.length) return refuse("IdentityChanged", `the process no longer matches the record: ${mismatch.join(", ")}`, { mismatch });
  if (isGone(row.state)) return refuse("NotRunning", "the child has exited and is awaiting reaping");
  log({ phase: "verified", pid: child.pid, ppid: row.ppid, start: row.start, command: row.command, signal, at: nowIso() });
  const exited = waitForExit(child, opts.awaitExitMs);
  let delivered;
  try {
    delivered = child.kill(signal);
  } catch (e) {
    log({ phase: "signalled", pid: child.pid, signal, delivered: false, error: String(e && e.message), at: nowIso() });
    return { primitive: P, status: "UNDETERMINED", code: errCode(e), reason: "the signal call threw" };
  }
  log({ phase: "signalled", pid: child.pid, signal, delivered, at: nowIso() });
  const ex = await exited;
  const afterRow = readProcess(child.pid);
  const gone = ex.exited || afterRow.status === "ABSENT" || (afterRow.status === "PRESENT" && (afterRow.start !== record.start.value || isGone(afterRow.state)));
  log({ phase: "after", pid: child.pid, signal, exited: gone, exitCode: ex.code, exitSignal: ex.signal, table: afterRow.status, at: nowIso() });
  return { primitive: P, status: "SIGNALLED", code: null, delivered, exited: gone, exit: ex, table: afterRow.status };
}

module.exports = {
  qualifyBackend,
  ensureDirectory,
  probe,
  replaceFile,
  appendRecord,
  unlinkIfUnchanged,
  removeEmptyDir,
  claimOnce,
  acquireLock,
  probeOwner,
  verifyLockOwnership,
  withOwnedStep,
  releaseLock,
  recordOwnChild,
  signalOwnChild,
  lockAnchorPath,
  BASE_CAPABILITIES,
  THREAT_MODEL,
  CODES,
};
