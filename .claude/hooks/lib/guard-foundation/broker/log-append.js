#!/usr/bin/env node
// Guard foundation S4 (R1 H3) — the broker's append-only writer for the two signed learning
// logs. Under the OS write profile a hook cannot open violations.jsonl or coordination-log.jsonl;
// `append-sink.js::appendSinkLine` hands the line to the broker instead, and the broker runs THIS
// file outside the sandbox (policy writer `learning-log-append`).
//
//   node log-append.js <violations|coordination-log> <intended-sink-path> <line>
//
// This is the ONE bytes-accepting broker route, narrowed by ROOT to these two sinks
// (broker/README.md § "The one bytes-accepting route"). Every condition of that ruling is
// enforced here, before anything is written:
//   1. EXACTLY two sinks, named by the caller as a LOG: the sink is derived here from the
//      broker's own cwd (the bound primary) through the state-dir resolver the hooks use, and
//      the path argument NEVER chooses it. The path is the sink the CALLER means; the request is
//      REFUSED (exit 2) unless it is canonically this writer's own derived sink —
//      realpath(dirname(intended)) + basename EQUALS the same canonical form of the derived
//      sink (`append-sink.js::canonicalSinkPath`, the one canonicalization the client route
//      also matches by). So a FOREIGN root's line — the test-context quarantine
//      `os.tmpdir()/coc-trust-quarantine-<pid>/.claude/learning` has the canonical SHAPE — is
//      refused rather than landing in the primary's real log (R2a H-4). The sink actually
//      written is reported on stdout as ONE JSON line `{"appended": <log>, "sinkPath": <path>}`,
//      which the client returns instead of the path it asked for.
//   2. ONE line: no CR or LF, one JSON object, at most MAX_LINE_BYTES with its newline (the cap
//      appendStamped and coc-emit enforce before signing).
//   3. SIGNED by an ENROLLED key: the line is verified by the fold's own signature gate
//      (`coordination-log.js::_verifyRule1` against the roster read by `loadFoldRoster`), so an
//      unsigned line, a line whose signer is not in the roster, and a forged signature are all
//      refused, as is a record whose person_id is not the signer's roster person (the fold's
//      rule 4, `_checkRule4`). An absent roster refuses: nothing can be verified against it.
//      Consequence, by design: `state-io.js::appendViolation`'s UNSIGNED legacy row (the
//      un-rostered fallback) is refused under the profile.
//   4. coordination-log only: the record's (seq, prev_hash) must extend its emitter's CURRENT
//      tail, as the emitter computes it (`coc-emit.js::_defaultReadChainHead`), so the route
//      cannot append a fork or a gap for any emitter. The check and the append run under ONE
//      exclusive per-log lock (R2a M-e): brokers are per launch, so two sessions on one primary
//      run two of these writers at once, and without the lock both could read the same tail and
//      both append the same seq. The lock is an O_CREAT|O_EXCL|O_NOFOLLOW file beside the log
//      (`.<log>.log-append.lock`), waited for at most LOCK_WAIT_MS, broken when older than
//      LOCK_STALE_MS (a holder killed mid-run), and released on every path out — a refusal, a
//      thrown error and a failed append alike. An untaken lock is a failed append (exit 1),
//      never an unlocked one.
//   5. O_APPEND only, never truncate, rename or replace; a symlinked or non-regular sink, a
//      hard-linked sink (nlink > 1), a symlinked ancestor or a swapped directory is refused:
//      delegated to `appendSinkLine`, whose guards are documented at
//      `append-sink.js::appendSinkLine`.
// It adds no power a sandboxed process lacks: the signing key is readable inside the sandbox,
// so the route admits only what the signer could already sign. What it protects is the
// append-only shape of both logs and the fold's acceptance set.
//
// HONEST LIMIT of condition 4's lock: it serializes THIS writer's runs (every brokered append).
// The lock file lives in the state dir, which the profile leaves writable apart from its named
// files, so a sandboxed process can hold it (each append then waits LOCK_WAIT_MS and fails —
// a denial of the route, never a write) or delete it under a holder; and a writer outside the
// broker that appends the log directly does not take it.
//
// Exit: 0 appended; 2 refused (request, intended sink, signature or chain); 1 the append could
// not be made (the hardened append refused, or the lock could not be taken).

"use strict";

const fs = require("fs");
const path = require("path");
const { appendSinkLine, mainCheckoutBoundaryRoots, canonicalSinkPath } = require("../../append-sink.js");
const { ensureStateDir } = require("../../state-resolver.js");
const coordinationLog = require("../../coordination-log.js");
const { _defaultReadChainHead, acquireLogLock, releaseLogLock } = require("../../coc-emit.js");

const LOG_FILES = { violations: "violations.jsonl", "coordination-log": "coordination-log.jsonl" };
const MAX_LINE_BYTES = 2048;
// LOCK_WAIT_MS / LOCK_STALE_MS belong to the shared lock (`coc-emit.js::acquireLogLock`); this poll
// interval is the test seam's only.
const LOCK_POLL_MS = 20;
// TEST SEAM ONLY. When set, names a directory in which this writer records two phases as empty
// marker files `<pid>.<phase>`: `lock-wait` (the first time it finds the lock held) and `checked`
// (every check passed, lock held, append not yet made) — and at `checked` it PAUSES until a file
// `go` exists there (bounded by SEAM_WAIT_MS). That lets a two-process test put both writers at
// the race point deterministically instead of racing for it. Production callers MUST NOT set it,
// and the broker cannot pass it (its environment is an allowlist that does not name it). It
// weakens nothing: it adds a pause and two marker files, and cannot skip, reorder or relax any
// check.
const TEST_SEAM_ENV = "COC_LOG_APPEND_TEST_SEAM_DIR";
const SEAM_WAIT_MS = 30000;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function seam(phase) {
  const dir = process.env[TEST_SEAM_ENV];
  if (!dir) return;
  fs.writeFileSync(path.join(dir, `${process.pid}.${phase}`), "");
  if (phase !== "checked") return;
  const until = Date.now() + SEAM_WAIT_MS;
  while (!fs.existsSync(path.join(dir, "go")) && Date.now() < until) sleepSync(LOCK_POLL_MS);
}

/** Validate the request's shape. Returns { record } when acceptable, else { refused }. */
function checkRequest(argv) {
  if (argv.length !== 3) return { refused: `expected <log> <intended-sink-path> <line>, got ${argv.length} argument(s)` };
  const [log, intended, line] = argv;
  if (!Object.prototype.hasOwnProperty.call(LOG_FILES, log)) return { refused: `unknown log ${JSON.stringify(log)} (allowed: ${Object.keys(LOG_FILES).join(", ")})` };
  if (typeof intended !== "string" || !path.isAbsolute(intended)) return { refused: `the intended sink must be an absolute path, got ${JSON.stringify(intended)}` };
  if (/[\r\n]/.test(line)) return { refused: "the line must not contain a newline or carriage return" };
  const bytes = Buffer.byteLength(`${line}\n`, "utf8");
  if (bytes > MAX_LINE_BYTES) return { refused: `the line is ${bytes} bytes with its newline, over the ${MAX_LINE_BYTES}-byte cap` };
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return { refused: "the line is not JSON" };
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) return { refused: "the line must be one JSON object" };
  return { record };
}

/**
 * Condition 1: the caller's intended sink must be canonically this writer's own derived sink.
 * null when it is; otherwise the refusal. The derived sink is what gets written either way —
 * this only decides whether the caller and the writer mean the same file.
 */
function checkIntendedSink(log, intended, derivedSink) {
  const want = canonicalSinkPath(derivedSink);
  if (!want) return `this writer's own ${log} sink ${JSON.stringify(derivedSink)} does not resolve`;
  const got = canonicalSinkPath(intended);
  if (got !== want) {
    return `the intended sink ${JSON.stringify(intended)} (canonically ${JSON.stringify(got)}) is not the bound primary's ${log} log ${JSON.stringify(want)}: only that file is appended here`;
  }
  return null;
}

/** Signature against an enrolled key, plus (coordination-log) the emitter's tail. null when admitted. */
function checkSignedRecord(repoDir, log, record, deps = {}) {
  const loadRoster = deps.loadFoldRoster || coordinationLog.loadFoldRoster;
  const verifyRule1 = deps.verifyRule1 || coordinationLog._internal._verifyRule1;
  const readChainHead = deps.readChainHead || _defaultReadChainHead;
  if (typeof record.sig !== "string" || !record.sig) return "the record is unsigned (no 'sig')";
  if (typeof record.verified_id !== "string" || !record.verified_id) return "the record names no signer (no 'verified_id')";
  const r = loadRoster(repoDir);
  if (!r.ok) return `the roster could not be read: ${r.reason}`;
  if (!r.roster) return "no enrolled roster: a signature cannot be verified against an enrolled key";
  const v = verifyRule1(record, r.roster, {}, undefined);
  if (!v || v.ok !== true) return `signature refused: ${(v && v.reason) || "verify failed"}`;
  // The fold's rule 4: the record's person_id is the signer's roster person.
  const r4 = (deps.checkRule4 || coordinationLog._internal._checkRule4)(record, v.resolvedPerson);
  if (!r4 || r4.ok !== true) return `signer refused: ${(r4 && r4.reason) || "person_id does not match the signer"}`;
  if (log !== "coordination-log") return null;
  let head;
  try {
    head = readChainHead({ repoDir, roster: r.roster, verifiedId: record.verified_id });
  } catch (e) {
    return `the coordination-log tail could not be read: ${(e && e.message) || e}`;
  }
  const seq = head ? head.lastSeq + 1 : 0;
  const prev = head ? head.lastContentHash : null;
  if (record.seq !== seq || record.prev_hash !== prev) {
    return `the record does not extend its emitter's tail: expected seq ${seq} prev_hash ${JSON.stringify(prev)}, got seq ${JSON.stringify(record.seq)} prev_hash ${JSON.stringify(record.prev_hash)}`;
  }
  return null;
}

function main(argv) {
  const refuse = (why) => {
    process.stderr.write(`log-append: REFUSED: ${why}\n`);
    return 2;
  };
  const req = checkRequest(argv);
  if (req.refused) return refuse(req.refused);
  const [log, intended, line] = argv;
  const repoDir = process.cwd();
  const sinkPath = path.join(ensureStateDir(repoDir), LOG_FILES[log]);
  const notOurs = checkIntendedSink(log, intended, sinkPath);
  if (notOurs) return refuse(notOurs);
  const lock = acquireLogLock(path.join(path.dirname(sinkPath), `.${log}.log-append.lock`), {
    name: log,
    label: "log-append",
    onWait: () => seam("lock-wait"),
  });
  if (!lock.ok) {
    process.stderr.write(`log-append: append refused: ${lock.reason}; nothing was appended\n`);
    return 1;
  }
  try {
    const bad = checkSignedRecord(repoDir, log, req.record);
    if (bad) return refuse(bad);
    seam("checked");
    const w = appendSinkLine({ repoDir, additionalRoots: mainCheckoutBoundaryRoots(repoDir), sinkPath, line });
    if (!w.ok) {
      process.stderr.write(`log-append: append refused: ${w.error}: ${w.reason}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify({ appended: log, sinkPath: canonicalSinkPath(sinkPath) })}\n`);
    return 0;
  } finally {
    releaseLogLock(lock);
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { checkRequest, checkIntendedSink, checkSignedRecord, LOG_FILES, MAX_LINE_BYTES, TEST_SEAM_ENV };
