/**
 * coc-emit — shared signed-record emitter for the multi-operator
 * coordination log.
 *
 * FSUB (knowledge-convergence MUST-2/MUST-3 emitter wiring, 2026-06-11).
 *
 * Problem: the substrate shipped READERS for several record types —
 * journal-write-guard.js folds `journal-slot-reservation` records,
 * journal-body-anchor.js ships a fold predicate, the session-start
 * surface reads the codify lease — but no WRITER existed that fills the
 * per-emitter chain envelope (seq, prev_hash) and signs + appends a
 * record. Every helper that needed to emit either skipped emission
 * silently (heartbeat without COC_OPERATOR_KEY_PATH) or did not emit at
 * all (journal-reserve, codify-lease), so the guards halt-and-report on
 * every journal write ("slot unreserved") and sibling clones never see
 * a lease in the fold.
 *
 * This module is the single emitter every record-writing helper routes
 * through. It mirrors genesis-ceremony.js's hardened emit path
 * (journal/0172 F88 post-mortem):
 *
 *   1. Chain head is derived from the LIVE log via the SAME default
 *      engine + computeOwnChainHead SSOT the fold will use — never a
 *      local cache, never hardcoded seq:0 (which forks against the
 *      emitter's existing chain and frames them as an equivocator
 *      under fold rule 3).
 *   2. An unreadable log REFUSES (typed error) rather than falling back
 *      to seq:0.
 *   3. Sign covers canonicalSerialize(record - sig); the signature can
 *      be re-verified by stripping sig and re-canonicalizing (fold
 *      rule 1 symmetry).
 *   4. Append enforces the 2KB POSIX-atomic-append cap (transport
 *      invariant) with a typed refusal — never truncate-after-sign
 *      (the Sec-LOW-2 class coc-append.js documents).
 *   5. On the main-log path, steps 1-4 run under ONE exclusive emit lock
 *      (EMIT_LOCK_FILE beside the log), so two concurrent writers cannot
 *      both build on the same head and fork the chain.
 *
 * Style: CommonJS, sync (matches genesis-ceremony.js + sibling lib/*),
 * zero-dep. Per zero-tolerance.md Rule 3: every failure path returns a
 * typed error object; never silent fallback, never throw on expected
 * failures.
 *
 * Contract:
 *   emitSignedRecord(opts) → {ok: true, record}
 *                          | {ok: false, error, reason, step}
 */

"use strict";

const fs = require("fs");
const { parseCoordinationLog } = require("./fold-record-limits.js");
const path = require("path");
const crypto = require("crypto");
const { types: utilTypes } = require("util");

// ---- Intrinsics, captured ONCE at load (sigcov R2-1) ------------------------
// In-process hostile code is inside the gate-approval capability's threat
// model. Every built-in the opts snapshot's refusals depend on is captured
// here, so patching `util.types.isProxy`, `Object.getOwnPropertyDescriptors`,
// `Reflect.ownKeys`, `Function.prototype.call` and the like after load changes
// nothing this module decides. (Code that controls module LOADING itself, i.e.
// runs before this file, is out of reach of any in-module defence.)
const _isProxy = utilTypes.isProxy;
const _getPrototypeOf = Object.getPrototypeOf;
const _getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const _defineProperty = Object.defineProperty;
const _objectCreate = Object.create;
const _freeze = Object.freeze;
const _ownKeys = Reflect.ownKeys;
const _apply = Reflect.apply;
const _hasOwnProperty = Object.prototype.hasOwnProperty;
const _OBJECT_PROTOTYPE = Object.prototype;
const _hasOwn = (obj, key) => _apply(_hasOwnProperty, obj, [key]);
// loom#1349 — the ONE hardened append primitive; see append-sink.js for the six defenses.
const { appendSinkLine, mainCheckoutBoundaryRoots } = require("./append-sink.js");

const cocSign = require(path.join(__dirname, "coc-sign.js"));
const coordinationLog = require(path.join(__dirname, "coordination-log.js"));
const { resolveLogPath } = require(path.join(__dirname, "state-io.js"));
const { resolveIdentity, _discoverSigningKey, _fingerprintFromKey, _makeRosterGpgResolver, _gpgFingerprint } = require(
  path.join(__dirname, "operator-id.js"),
);
const actuationTypes = require(path.join(__dirname, "actuation-types.js"));
// #583 Shard 3a — the EMIT-side presence gate verifies content.presence_proof
// via the Shard-2 verifier and requires PROVEN (the live-`now` consumption tier).
const presenceProofVerify = require(
  path.join(__dirname, "presence-proof-verify.js"),
);

// Match transport-filesystem.js MAX_LINE_BYTES — the POSIX O_APPEND
// atomicity half-budget (PIPE_BUF is 4KB; 2KB keeps the line atomic
// under layered fs shims).
const MAX_LINE_BYTES = 2048;

// ---- Per-log exclusive lock ----------------------------------------------------
// ONE implementation, used by emitSignedRecord below (the emit lock) and by the guard broker's
// log writer (`guard-foundation/broker/log-append.js`, its per-log append lock). The lock is an
// O_CREAT|O_EXCL|O_NOFOLLOW file: the kernel picks exactly one winner. A waiter polls for at most
// `waitMs`; a lock older than LOCK_STALE_MS (a holder killed mid-run) is broken. An untaken lock
// is reported as a failure, never ignored.
const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 60000;
const LOCK_POLL_MS = 20;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const lstatOrNull = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

/**
 * Break a lock older than LOCK_STALE_MS. It is RENAMED aside first and deleted only if the moved
 * file is the very inode that was judged stale, so a writer that took a fresh lock between the
 * judgement and the rename gets its lock put back (linked to the lock name again) instead of
 * silently losing it.
 */
function breakStaleLock(lock, seen, label) {
  const grave = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(lock, grave);
  } catch {
    return; // gone or replaced since it was judged: the caller simply retries the create
  }
  const moved = lstatOrNull(grave);
  if (!moved || moved.dev !== seen.dev || moved.ino !== seen.ino) {
    try {
      fs.linkSync(grave, lock);
    } catch (e) {
      process.stderr.write(`${label}: WARNING: a fresh lock moved while breaking a stale one could not be restored at ${lock}: ${e.code || e.message}\n`);
    }
  }
  try {
    fs.unlinkSync(grave);
  } catch (e) {
    process.stderr.write(`${label}: WARNING: the broken lock ${grave} could not be removed: ${e.code || e.message}\n`);
  }
}

/**
 * Take the lock file `lock`. `o.name` names it in a refusal, `o.label` prefixes a warning,
 * `o.onWait` is called once, the first time the lock is found held, and `o.waitMs` bounds the
 * wait (default LOCK_WAIT_MS). Returns { ok:true, lock, dev, ino, label } or { ok:false, reason }.
 */
function acquireLogLock(lock, o) {
  const opts = o || {};
  const name = opts.name || path.basename(lock);
  const label = opts.label || "coc-emit";
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  const waitMs = typeof opts.waitMs === "number" ? opts.waitMs : LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    let fd = null;
    try {
      fd = fs.openSync(lock, flags, 0o600);
    } catch (e) {
      if (!e || e.code !== "EEXIST") return { ok: false, reason: `the ${name} lock ${lock} could not be created: ${(e && (e.code || e.message)) || e}` };
    }
    if (fd !== null) {
      try {
        fs.writeSync(fd, `${process.pid}\n`);
        const st = fs.fstatSync(fd);
        return { ok: true, lock, dev: st.dev, ino: st.ino, label };
      } catch (e) {
        try {
          fs.unlinkSync(lock);
        } catch {
          // the lock is stale-broken by the next writer after LOCK_STALE_MS; nothing better here
        }
        return { ok: false, reason: `the ${name} lock ${lock} could not be written: ${(e && (e.code || e.message)) || e}` };
      } finally {
        fs.closeSync(fd);
      }
    }
    if (!announced) {
      announced = true;
      if (typeof opts.onWait === "function") opts.onWait();
    }
    const held = lstatOrNull(lock);
    if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
      breakStaleLock(lock, held, label);
      continue;
    }
    if (Date.now() >= deadline) return { ok: false, reason: `the ${name} lock ${lock} is held and was not released within ${waitMs} ms` };
    sleepSync(LOCK_POLL_MS);
  }
}

/** Release a lock this run holds — only if the lock name still holds OUR inode. */
function releaseLogLock(h) {
  const st = lstatOrNull(h.lock);
  if (!st || st.dev !== h.dev || st.ino !== h.ino) {
    process.stderr.write(`${h.label}: WARNING: the lock ${h.lock} no longer held this run's file at release (broken as stale, or removed); it was left alone\n`);
    return;
  }
  try {
    fs.unlinkSync(h.lock);
  } catch (e) {
    process.stderr.write(`${h.label}: WARNING: the lock ${h.lock} could not be released: ${e.code || e.message}\n`);
  }
}

// The emit lock: a DIFFERENT file from the broker's `.coordination-log.log-append.lock`, because
// under the guard foundation's OS profile an emit holding this lock hands its line to the broker,
// which then takes ITS lock — one shared name would make every brokered emit wait on itself. The
// order is always emit lock, then broker lock, and the broker never takes this one, so the two
// cannot deadlock.
const EMIT_LOCK_FILE = ".coordination-log.emit.lock";

function _loadRoster(repoDir) {
  const rosterPath = path.join(repoDir, ".claude", "operators.roster.json");
  try {
    if (!fs.existsSync(rosterPath)) return null;
    return JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Default chain-head reader — mirrors genesis-ceremony.js::
 * _defaultReadChainHead. Reads the live log synchronously, folds through
 * the module-default engine, and returns computeOwnChainHead's
 * {lastSeq, lastContentHash} (or null on a genuinely-fresh chain).
 * Throws on non-ENOENT read errors — the caller converts to a typed
 * refusal (falling back to seq:0 on an unreadable log would fork).
 */
function _defaultReadChainHead({ repoDir, roster, verifiedId }) {
  const logPath = resolveLogPath(repoDir);
  let raw;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  const records = parseCoordinationLog(raw, {
    malformed: "skip", objectRecordsOnly: true, maxRecords: null,
  }).records;
  if (records.length === 0) return null;
  // skipSignatureVerify: computing the emitter's chain HEAD needs only the
  // per-emitter chain STRUCTURE (max seq + its prev_hash) — NOT cryptographic
  // signature validity. Re-verifying every prior record's signature on every
  // emit is pure O(n)-gpg waste (each GPG verify spawns an ephemeral-homedir
  // gpg-agent — ~710ms/record on loom's chain; 127 records ≈ 90s PER emit, and
  // a lease+slot is 2 emits ≈ 180s — the "signing hang" that blocked journal
  // writes + codify-leases). This MIRRORS the identical skip in _foldDelta
  // above (see its NOTE for the fail-closed proof): skip can only make a chain-
  // head computation count a forged-sig squatter at (vid,seq) — advancing OUR
  // next seq PAST it (fail-closed: we never reuse a seq), never reuse a seq a
  // read-time fold would reject. Read-time folds (the actual trust gate) always
  // verify. Without this, _defaultReadChainHead re-verified the whole chain
  // every emit while _foldDelta (already fixed) did not — the sibling-path gap.
  const folded = coordinationLog.foldLog(records, roster, {
    skipSignatureVerify: true,
  });
  // Under COC_TEST_SKIP_SIGN computeOwnChainHead reads rawRecords (fold
  // rule 1 rejects unsigned stubs); attach them so the skip-sign path
  // sees the full chain.
  folded.rawRecords = records;
  return coordinationLog.computeOwnChainHead(folded, verifiedId);
}

/**
 * Default append — sync O_APPEND with the 2KB transport cap. Returns
 * {ok} | {ok: false, error}. Mirrors transport-filesystem.js::
 * appendRecord semantics (size refusal is a typed result; filesystem
 * errors throw — converted to a typed refusal by the caller).
 */
function _defaultAppend(repoDir, record) {
  let line;
  try {
    line = JSON.stringify(record);
  } catch (err) {
    return {
      ok: false,
      error: `record is not JSON-serializable: ${err && err.message ? err.message : String(err)}`,
    };
  }
  if (Buffer.byteLength(line + "\n", "utf8") > MAX_LINE_BYTES) {
    return {
      ok: false,
      error: `record line (${Buffer.byteLength(line + "\n", "utf8")}B) exceeds MAX_LINE_BYTES (${MAX_LINE_BYTES}); shrink content (e.g. carry fingerprints, not full path lists)`,
    };
  }
  // loom#1349 R1 F3 — routed through the shared hardened primitive. This is the CANONICAL
  // signed-record emitter behind 11 modules, and it writes the SAME coordination-log.jsonl that
  // adjacency-heartbeat and multi-operator-sessionend write; leaving it on the bare idiom would
  // have left that sink hardened at 2 of its 4 writers, with one symlink at `.claude/learning`
  // still harvesting the majority of production rows. The MAX_LINE_BYTES cap above stays HERE,
  // before signing, so an oversized record is refused rather than truncated-after-sign.
  const logPath = resolveLogPath(repoDir);
  // The sink is `resolveStateDir(repoDir)/coordination-log.jsonl`, which resolves to the MAIN
  // checkout BY DESIGN (`trust-posture.md` MUST-1; `state-resolver.js` header, red-team CRIT-2):
  // a worktree's `.claude/learning/` is auto-deleted on cleanup, so coordination state
  // deliberately escapes cwd. Containing against `repoDir` ALONE therefore refused the DESIGNED
  // path in every worktree session — the SAME defect coc-append.js fixed at its own call site in
  // loom#1349 R2 F1, which this module (routed through the primitive in R1 F3) did not inherit.
  //
  // The root declared is the MAIN CHECKOUT, deliberately NOT the resolved state dir. Declaring
  // the state dir would be CIRCULAR: `resolveStateDir` builds it by lexical join, so a
  // `.claude/learning` symlinked out of the repo would appear under its own realpath and the
  // check would pass vacuously — defeating the exact attack it exists to block. Against the main
  // checkout that symlink lands under neither root and is still refused.
  //
  // `resolveStateDir`'s OTHER branch — a raw `$CLAUDE_TRUST_STATE_DIR` — is deliberately NOT
  // declared. `resolveMainCheckout` VALIDATES that variable (loom#1444: honored only at the
  // canonical `<root>/.claude/learning` of a real git checkout) while `resolveStateDir` still
  // honors it raw — the residual `state-resolver.js` names above its own definition.
  //
  // State the VALID case honestly, because the obvious phrasing is circular: when the override
  // passes validation, `resolveMainCheckout` returns ITS `<root>`, so the declared boundary and
  // the sink both derive from the SAME attacker-suppliable variable and the containment compare
  // holds VACUOUSLY. It is not that the valid override "needs no entry of its own" — it IS
  // declared, just indirectly, and this check constrains it not at all. What constrains it is
  // `resolveMainCheckout`'s VALIDATION: canonical `<root>/.claude/learning` shape AND a real git
  // checkout at `<root>`. That validation is the whole of the trust decision for this branch;
  // saying otherwise re-imports the exact circularity the paragraph above narrows against.
  //
  // Declaring the RAW value additionally would widen the boundary to overrides that never passed
  // that validation, and an INVALID one MUST stay refused — this containment check is currently
  // the only thing closing that open residual.
  //
  // `repoDir` stays the value stamped into the signed record; only the boundary widens.
  //
  // Containment roots for a state-dir sink: derived by the ONE helper in
  // append-sink.js (see its doc for the fail-closed resolver rationale).
  const boundaryRoots = mainCheckoutBoundaryRoots(repoDir);
  const w = appendSinkLine({
    repoDir,
    additionalRoots: boundaryRoots,
    sinkPath: logPath,
    line,
  });
  if (!w.ok)
    return {
      ok: false,
      error: `coordination-log append refused: ${w.error} — ${w.reason}`,
    };
  return { ok: true };
}

/**
 * Read + parse the MAIN coordination-log's records (ENOENT → []). Mirrors
 * _defaultReadChainHead's read/parse idiom; a partial/garbage line is
 * dropped (the fold engine shape-rejects anything that survives).
 */
function _readMainLogRecords(repoDir) {
  const logPath = resolveLogPath(repoDir);
  let raw = "";
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  return parseCoordinationLog(raw, {
    malformed: "skip", objectRecordsOnly: true, maxRecords: null,
  }).records;
}

/**
 * Delta-based, identity-free fold validation: the candidate is acceptable
 * iff folding [liveRecords + candidate] adds EXACTLY one to accepted and
 * zero to rejected/forks, relative to folding liveRecords alone. Correct
 * even when the live log is ALREADY forked — a clean candidate that would
 * collide shows up in forks/rejected (so emit fail-closed refuses; the
 * chain must be re-chained first, and the repair path re-signs directly,
 * NOT through emit).
 *
 * NOTE — tamper/contested admit by design: a tamper-flagged journal-body-
 * anchor (FSUB R1 LOW-2) and a rule-10 contested-revocation both fold as
 * `accepted` (the fold does accepted.push of a flagged copy, no
 * rejected/forks push) → Δ(+1,0,0) → ADMITTED. That is correct: those
 * records still fold-advance the chain; the tamper/contested ADVISORY is
 * the detection surface, not a chain-break. The guard must not refuse them.
 */
function _foldDelta(liveRecords, roster, record) {
  // skipSignatureVerify: the candidate is freshly self-signed (rule-1 always
  // passes for it) and the prior records are the established accepted chain
  // (already verified) — re-verifying every signature on every emit is pure
  // O(n)-gpg waste that does NOT change which records fold-ACCEPT. The guard
  // needs only rule-2 (chain) + rule-3 (fork) + the predicate to close
  // COC-CHAIN; read-time folds always verify. Without this, an emit on an
  // N-record GPG-signed chain spawned ~2N ephemeral-gpg verifies (the
  // user-flow walk surfaced ~3 min per journal reservation on loom's chain).
  //
  // Fail-closed direction: the ONE case where skip vs verify diverges is a
  // prior INVALIDLY-signed squatter at the candidate's own (vid, seq) — skip
  // caches+forks it (guard over-refuses), verify rule-1-rejects it (guard
  // admits). Skip can therefore only make the guard OVER-refuse a legitimate
  // emit, NEVER admit a record a read-time fold would reject. Fail-closed.
  // VERIFY the candidate (verified-fold, 2026-10-09): the old skip rested on
  // the premise "the candidate is freshly self-signed, so rule-1 always
  // passes" — a premise nothing enforced, and the wBL8jr anomaly class is
  // exactly its negation (a stamp/sign-divergent candidate folded ACCEPTED
  // under the skip and was appended). The premise is now ENFORCED here AND
  // bound at the emission site; the historic per-emit GPG cost this skip
  // avoided is bounded today by checkpoint coverage + in-process SSH
  // fingerprints (measured warm full-verify on the 1072-record log: 623-805ms
  // per fold, median 759 — and this guard runs TWO folds, so ~1.3s per emit).
  const foldOpts = {};
  const before = coordinationLog.foldLog(liveRecords, roster, foldOpts);
  const after = coordinationLog.foldLog(
    liveRecords.concat([record]),
    roster,
    foldOpts,
  );
  const acceptedDelta = after.accepted.length - before.accepted.length;
  const rejectedDelta = after.rejected.length - before.rejected.length;
  const forksDelta = after.forks.length - before.forks.length;

  if (acceptedDelta === 1 && rejectedDelta === 0 && forksDelta === 0) {
    return { ok: true };
  }
  // Surface the candidate's OWN fold reason for an actionable message.
  let reason = `candidate would not fold cleanly (Δaccepted=${acceptedDelta}, Δrejected=${rejectedDelta}, Δforks=${forksDelta})`;
  const ownReject = after.rejected.find(
    (rj) =>
      rj.record &&
      rj.record.verified_id === record.verified_id &&
      rj.record.seq === record.seq &&
      rj.record.ts === record.ts,
  );
  if (ownReject && ownReject.reason) {
    reason += `; fold reason: ${ownReject.reason} (rule: ${ownReject.rule})`;
  } else if (forksDelta > 0) {
    reason += `; candidate forks against an existing record at (${record.verified_id}, seq ${record.seq}) — the chain is forked and must be re-chained before new emits land`;
  }
  return { ok: false, reason };
}

/**
 * Build a fold-validator over a SPECIFIC log's record reader — the
 * fail-closed recurrence guard (COC-CHAIN). The default reader is the MAIN
 * coordination-log; separate-log emitters (member-registry, capability-
 * ledger, upstream-canon) build their OWN validator over their OWN log so
 * the guard validates against the chain the record actually extends — the
 * main-log validator would mis-judge a separate-log record as a rule-2
 * first-record. This closes the COC-CHAIN bug class (a structurally-
 * malformed but TYPE-valid record predicate-rejects at fold but emit
 * appended it anyway → stuck head → rule-3 forks) symmetrically across
 * every signed chain, not just the main log.
 *
 * Carve-outs:
 *   - Roster ABSENT (no file): return ok:true — a rosterless repo is
 *     outside the multi-operator substrate; rule-1 cannot verify any
 *     record, so there is no verifiable chain to poison.
 *   - Roster PRESENT but unparseable (corrupt): return ok:false (fail-
 *     CLOSED) — corrupt ≠ absent per trust-posture.md MUST-2; refusing to
 *     append unvalidated against a broken trust root is the safe disposition.
 *   - COC_TEST_SKIP_SIGN=1: return ok:true — stub signatures cannot pass
 *     rule-1 at fold (mirrors computeOwnChainHead's skip-sign awareness).
 *
 * The reader throws on a non-ENOENT read error — the caller converts to a
 * typed refusal (never append unvalidated).
 *
 * @param {function(string):Array} readRecords - (repoDir) → live records of
 *   the target log (ENOENT → []).
 * @returns {function({repoDir, roster, record}):({ok:true}|{ok:false, reason})}
 */
function makeValidateFold(readRecords) {
  return function validateFold({ repoDir, roster, record }) {
    if (!roster) {
      const rosterPath = path.join(repoDir, ".claude", "operators.roster.json");
      if (fs.existsSync(rosterPath)) {
        return {
          ok: false,
          reason:
            "roster file present but unparseable — refusing to append unvalidated (corrupt roster ≠ absent; trust-posture.md MUST-2). Fix the roster before emitting.",
        };
      }
      return { ok: true }; // genuinely rosterless — outside the substrate
    }
    if (process.env.COC_TEST_SKIP_SIGN === "1") {
      return { ok: true }; // stub sigs fold-reject; validation not meaningful
    }
    const liveRecords = readRecords(repoDir); // throws → caller-typed refusal
    return _foldDelta(liveRecords, roster, record);
  };
}

// The default (main coordination-log) validator. Separate-log emitters
// build their own via makeValidateFold(<their log reader>).
const _defaultValidateFold = makeValidateFold(_readMainLogRecords);

/**
 * True only when `capability` is a live capability minted by `gate-approval.js`
 * (redeeming it consumes it). Any failure to ask is a refusal. The redeemer is
 * the one bound at load (see the end of this file), never looked up on
 * gate-approval's exports or the module cache at call time (sigcov R2-1).
 */
function _holdsGateApprovalCapability(capability) {
  try {
    return typeof _redeemEmitCapability === "function" && _redeemEmitCapability(capability) === true;
  } catch {
    return false;
  }
}

/**
 * Snapshot `opts` once, into a NULL-PROTOTYPE object holding only the caller's
 * own enumerable string-keyed DATA properties, or refuse at step "args".
 * Returns `{ o }` or `{ refusal }`; it never throws.
 *
 * Every check, the record and the presence gate read this snapshot, never
 * `opts` (loom#1442 R2 S1): an accessor or Proxy answering `type` differently
 * on each read could otherwise pass the capability and presence checks as one
 * type and be signed as another. What cannot be copied faithfully is REFUSED,
 * never dropped — a dropped seam (`sign`, `append`, `readChainHead`, …) is
 * silently replaced by the DEFAULT, i.e. the real signing key and the main log,
 * for a call meant to be seamed (loom#1442 A5 I2):
 *   - a Proxy (its traps can lie about keys, values and prototype);
 *   - a prototype other than `Object.prototype` or `null`;
 *   - an accessor (it runs caller code, can answer per read, can throw);
 *   - a non-enumerable or Symbol-keyed own property (a copy keyed on
 *     enumerable string keys would drop it — sigcov R1 S1).
 * The target has no prototype, so a field the caller left out reads
 * `undefined`, never a value planted on a polluted `Object.prototype`, and
 * filling it runs no inherited setter (sigcov R1 S2, S3). A throw while
 * snapshotting is a typed refusal too (sigcov R1 S4).
 */
function snapshotPlainOpts(opts) {
  const refuse = (reason) => ({ refusal: { ok: false, error: "invalid argument", reason, step: "args" } });
  const o = _objectCreate(null);
  if (opts === undefined || opts === null) return { o };
  try {
    // isProxy first: getPrototypeOf on a Proxy runs its trap, which can lie.
    // Every built-in below is the one captured at load (sigcov R2-1).
    if (_isProxy(opts)) return refuse("opts must not be a Proxy");
    const proto = typeof opts === "object" ? _getPrototypeOf(opts) : undefined;
    if (proto !== _OBJECT_PROTOTYPE && proto !== null) {
      return refuse("opts must be a plain object (prototype Object.prototype or null)");
    }
    const descriptors = _getOwnPropertyDescriptors(opts);
    // An index loop: `for…of` would consult a patchable Array iterator.
    const keys = _ownKeys(descriptors);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const d = descriptors[key];
      if (typeof key === "symbol") return refuse(`opts must not carry a Symbol-keyed property (${String(key)})`);
      if (!_hasOwn(d, "value")) {
        return refuse(`opts.${key} must be a data property, not an accessor`);
      }
      if (d.enumerable !== true) return refuse(`opts.${key} must be an enumerable property`);
      _defineProperty(o, key, { value: d.value, writable: true, enumerable: true, configurable: true });
    }
  } catch (err) {
    return refuse(`opts could not be read: ${err && err.message ? err.message : String(err)}`);
  }
  return { o };
}

/**
 * Emit one signed, chained coordination-log record.
 *
 * @param {object} opts
 * @param {string} opts.repoDir - absolute repo root (main checkout —
 *   callers inside worktrees MUST resolve via state-resolver first).
 * @param {string} opts.type - record type. MUST be registered in the
 *   default fold engine (an unregistered type is dispatch-rejected at
 *   fold and the emitter's subsequent chain is rejected by rule 2 for
 *   every reader — the chain-poisoning class this module exists to
 *   prevent). The emitter refuses unknown types.
 * @param {object} opts.content - record content (caller-shaped).
 * @param {{verified_id, person_id, display_id?}} [opts.identity] -
 *   resolved identity; defaults to resolveIdentity(repoDir).
 * @param {string} [opts.signingKeyPath] - explicit signing key (else
 *   discovered via git config user.signingkey).
 * @param {"ssh"|"gpg"} [opts.keyType]
 * @param {function} [opts.sign] - test-injectable sign(bytes, signOpts).
 * @param {function} [opts.readChainHead] - test-injectable chain-head
 *   reader ({repoDir, roster, verifiedId}) → {lastSeq, lastContentHash}|null.
 * @param {function} [opts.append] - test-injectable append(repoDir, record).
 * @param {function} [opts.validateFold] - fold-validator
 *   ({repoDir, roster, record}) → {ok:true}|{ok:false, reason}. The
 *   DEFAULT (_defaultValidateFold) runs ONLY on the default-append
 *   (main-log) path and re-folds [live main-log chain + candidate],
 *   refusing unless the candidate lands in accepted (the COC-CHAIN
 *   fail-closed recurrence guard). When a custom `opts.append` is
 *   injected (separate-log emitters), the default is SKIPPED — inject an
 *   explicit validateFold (built via makeValidateFold over that log's
 *   reader) to opt the separate log in. An injected validateFold always
 *   runs, append-gate notwithstanding. NOTE: a test that injects a stub
 *   `sign` on the DEFAULT-append path (no custom append) MUST also set
 *   COC_TEST_SKIP_SIGN=1, else the stub-signed record fails rule-1 at the
 *   validation fold and emit returns a spurious fold-validate refusal.
 * @param {object} [gateApprovalCapability] - the single-use capability only
 *   `gate-approval.js::emitGateApproval` mints; required for `type:
 *   "gate-approval"`, ignored otherwise. It is a separate ARGUMENT, never an
 *   opts field: caller-visible opts are copied, and a copy can be observed (a
 *   setter planted on `Object.prototype` received it — sigcov R1 S3).
 * @returns {{ok: true, record: object} |
 *           {ok: false, error: string, reason: string, step: string}}
 */
function emitSignedRecord(opts, gateApprovalCapability) {
  // READ ONCE: see snapshotPlainOpts.
  const snapshot = snapshotPlainOpts(opts);
  if (snapshot.refusal) return snapshot.refusal;
  const o = snapshot.o;
  const repoDir = o.repoDir;
  if (!repoDir || typeof repoDir !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "opts.repoDir must be a non-empty string",
      step: "args",
    };
  }
  if (!o.type || typeof o.type !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "opts.type must be a non-empty string",
      step: "args",
    };
  }
  if (!o.content || typeof o.content !== "object") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "opts.content must be a non-null object",
      step: "args",
    };
  }

  // Refuse unknown record types — emitting one would dispatch-reject at
  // fold and poison the emitter's subsequent chain for every reader.
  if (!coordinationLog.predicateMetadataFor(o.type)) {
    return {
      ok: false,
      error: "unknown record type",
      reason: `type '${o.type}' has no registered fold predicate in the default engine; register it in coordination-log.js::_registerM0Defaults before emitting (unregistered records are dispatch-rejected at fold and rule-2-poison the emitter's subsequent chain)`,
      step: "type-check",
    };
  }

  // `gate-approval` is admitted ONLY through `gate-approval.js::emitGateApproval`,
  // which passes a single-use capability minted inside that module and never
  // exported, as this function's SECOND ARGUMENT (never an opts field). A
  // caller that merely names the type cannot forge one, so the emit-site tripwire (gate-identity-signature-coverage.test.js 1442 B/D)
  // guards the record TYPE, not just one function name (loom#1442). Checked
  // before identity, chain head, sign and append, so a refusal touches nothing.
  if (o.type === "gate-approval" && !_holdsGateApprovalCapability(gateApprovalCapability)) {
    return {
      ok: false,
      error: "gate-approval capability required",
      reason:
        "gate-approval records are emitted only through the gate-approval.js emitter, which holds the capability; a direct emitSignedRecord call naming the type is refused (loom#1442)",
      step: "capability",
    };
  }

  // NOTE (#583 Shard 3a): the presence-proof gate for actuation-class records
  // runs AFTER recordCore is constructed (it re-derives presenceProofBindingBytes,
  // which needs type + verified_id + person_id + content) and BEFORE sign — see
  // the "presence-proof gate" block below the recordCore assembly.

  // ---- Identity ----------------------------------------------------------
  let identity = o.identity;
  if (!identity) {
    try {
      identity = resolveIdentity(repoDir, {});
    } catch (err) {
      return {
        ok: false,
        error: "identity resolution failed",
        reason: err && err.message ? err.message : String(err),
        step: "identity",
      };
    }
  }
  // Identity is read once, for the same reason as `opts`, and only from its
  // OWN properties: an omitted `display_id` must stay absent, never be read
  // off a polluted Object.prototype and signed with the operator's key
  // (sigcov R2-5).
  if (identity) {
    const src = identity;
    const own = (key) => (_hasOwn(src, key) ? src[key] : undefined);
    identity = { verified_id: own("verified_id"), person_id: own("person_id"), display_id: own("display_id") };
  }
  if (
    !identity ||
    typeof identity.verified_id !== "string" ||
    !identity.verified_id ||
    typeof identity.person_id !== "string" ||
    !identity.person_id
  ) {
    return {
      ok: false,
      error: "missing identity",
      reason:
        "identity must carry non-empty verified_id and person_id (run /whoami --register if un-rostered)",
      step: "identity",
    };
  }

  // ---- Emit lock (read head → sign → fold-validate → append is ONE section) --
  // Without it, two writers that read the same chain head both sign and append the same seq:
  // the emitter's chain forks and every fold names it an equivocator (fold rule 3), and the
  // second record is lost. Holding the lock from the head read to the append makes a concurrent
  // writer wait and then read a head that includes this record. It is taken on the MAIN-LOG
  // path only (no injected `append`): a separate-log emitter's chain lives in a log this module
  // does not know, so it is not serialized here. It serializes every writer that goes through
  // this function; a writer that appends the main log by another route does not take it.
  let emitLock = null;
  if (!o.append) {
    let lockPath;
    try {
      const stateDir = path.dirname(resolveLogPath(repoDir));
      fs.mkdirSync(stateDir, { recursive: true });
      lockPath = path.join(stateDir, EMIT_LOCK_FILE);
    } catch (err) {
      return {
        ok: false,
        error: "emit lock unavailable",
        reason: `the coordination-log state dir could not be prepared for the emit lock: ${err && err.message ? err.message : String(err)}; nothing was signed or appended`,
        step: "lock",
      };
    }
    emitLock = acquireLogLock(lockPath, { name: "coordination-log emit", label: "coc-emit" });
    if (!emitLock.ok) {
      return {
        ok: false,
        error: "emit lock unavailable",
        reason: `${emitLock.reason}; nothing was signed or appended (a record built on a head read without the lock could fork the chain)`,
        step: "lock",
      };
    }
  }
  try {
    return _emitWithHead(o, repoDir, identity);
  } finally {
    if (emitLock) releaseLogLock(emitLock);
  }
}

/** emitSignedRecord from the chain-head read to the append; runs under the emit lock. */
function _emitWithHead(o, repoDir, identity) {
  // ---- Chain head (refuse-don't-fork) -------------------------------------
  const roster = _loadRoster(repoDir);
  const readChainHead = o.readChainHead || _defaultReadChainHead;
  let chainHead;
  try {
    chainHead = readChainHead({
      repoDir,
      roster,
      verifiedId: identity.verified_id,
    });
  } catch (err) {
    return {
      ok: false,
      error: "chain-head read failed",
      reason: `readChainHead threw (coordination-log unreadable; refusing to fall back to seq:0 which would fork): ${err && err.message ? err.message : String(err)}`,
      step: "chain-head",
    };
  }

  const draft = {
    type: o.type,
    verified_id: identity.verified_id,
    person_id: identity.person_id,
    seq: chainHead ? chainHead.lastSeq + 1 : 0,
    prev_hash: chainHead ? chainHead.lastContentHash : null,
    ts: new Date().toISOString(),
    content: o.content,
  };
  if (identity.display_id) draft.display_id = identity.display_id;

  // ---- Serialize ONCE, then work on the bytes' own data -------------------
  // `content` is the caller's object and may hold accessors or be a Proxy, so
  // it is read exactly once, here. The bytes are the canonical form of the
  // draft — the same bytes this function always signed — and `recordCore` is
  // parsed back FROM them, so the presence gate, the sign/stamp bind and the
  // appended record all see the data that was signed, not a second read of
  // the caller's object (loom#1442 R2 S1).
  let bytes;
  try {
    bytes = cocSign.canonicalSerialize(draft);
  } catch (err) {
    return {
      ok: false,
      error: "canonical-serialize failed",
      reason: err && err.message ? err.message : String(err),
      step: "serialize",
    };
  }
  const recordCore = JSON.parse(bytes.toString("utf8"));
  // The fold re-derives the signed bytes FROM the appended record, so that
  // record must re-canonicalize to exactly these bytes. A value that does not
  // survive the round trip is refused here rather than appended unverifiable.
  let roundTrip;
  try {
    roundTrip = cocSign.canonicalSerialize(recordCore);
  } catch (err) {
    roundTrip = null;
  }
  if (!roundTrip || !roundTrip.equals(bytes)) {
    return {
      ok: false,
      error: "canonical round-trip mismatch",
      reason:
        "the record parsed from its canonical bytes does not re-serialize to the same bytes, so the fold could not verify its signature; refusing rather than appending it",
      step: "serialize",
    };
  }

  // ---- Presence-proof gate (#583 §C4; Shard-3a requirement-latch) ---------
  // Actuation-class records (gate-approval + future command-center actuation
  // types) carry human intent: holding the primary signing key is NOT sufficient
  // (#583 §C4). Shard-3a UPGRADES this gate from "an attestation SLOT is present"
  // (the retired opts.presenceAttestation truthiness check + the C1/C2
  // byte-indistinguishability invariant, both retired in Shard 1 per
  // journal/0505) to "content.presence_proof is a VALID, PROVEN broker proof":
  // run the Shard-2 verifier over the record about to be signed and require
  // PROVEN (valid broker sig + registered trust anchor + FRESH against live
  // `now` — the consumption tier). This is the EMIT-side early-fail with a clear
  // error; the FOLD (foldPresenceGate, every reader) is the real unbypassable
  // enforcement (the #583 adversary holds the primary key and can hand-append
  // bypassing THIS emitter, but not the fold).
  //
  // ALWAYS-ON (co-owner-ratified): the requirement is UNCONDITIONAL for actuation
  // types — it does NOT consult isPresenceMechanismConfigured. The always-on fold
  // rejects an ABSENT actuation regardless of any provisioning signal, and the
  // COC-CHAIN _foldDelta guard below refuses to append a record that would
  // fold-reject; so a non-PROVEN actuation must be refused here, not advisory-
  // passed. Runs AFTER recordCore (verifyPresenceProof re-derives
  // presenceProofBindingBytes over type+verified_id+person_id+content) and BEFORE
  // sign, so a non-PROVEN actuation is never signed or appended. It reads the
  // record parsed from the signed bytes (see "Serialize ONCE" above).
  if (actuationTypes.requiresPresenceAttestation(recordCore.type)) {
    const verdict = presenceProofVerify.verifyPresenceProof(
      recordCore,
      roster,
      {},
    );
    if (verdict.status !== presenceProofVerify.STATUS.PROVEN) {
      return {
        ok: false,
        error: "presence proof required",
        reason: `actuation record type '${recordCore.type}' requires a PROVEN per-record presence proof in content.presence_proof (verifier status: ${verdict.status}${verdict.reason ? ` — ${verdict.reason}` : ""}) — holding the signing key is NOT sufficient (#583 §C4). The proof is produced by the off-loom hardware-presence broker; an in-process/agent emission without a fresh, broker-signed proof is the identity-≠-intent hole #583 closes.`,
        step: "presence-gate",
      };
    }
  }

  // ---- Sign ---------------------------------------------------------------

  let signFn = o.sign;
  let signOpts = {};
  if (typeof signFn !== "function") {
    const discoverOpts = {
      signingKeyPath: o.signingKeyPath,
      keyType: o.keyType,
    };
    // Test determinism: explicit null suppresses the ambient git-config
    // tier (a sandboxed repo otherwise inherits the operator's GLOBAL
    // user.signingkey through `git -C <repo> config --get`).
    if (_hasOwn(o, "gitConfigSigningKey")) {
      discoverOpts.gitConfigSigningKey = o.gitConfigSigningKey;
    }
    const { keyPath, keyType } = _discoverSigningKey(repoDir, discoverOpts);
    if (!keyPath) {
      return {
        ok: false,
        error: "no signing key",
        reason:
          "no signing key discovered (set opts.signingKeyPath or `git config user.signingkey`); unsigned records are rule-1-rejected at fold, so emission refuses rather than appending an unverifiable record",
        step: "sign",
      };
    }
    signFn = cocSign.sign;
    signOpts = { keyType, keyPath };
  }
  const signResult = signFn(bytes, signOpts);
  if (!signResult || !signResult.ok) {
    return {
      ok: false,
      error: signResult && signResult.error ? signResult.error : "sign failed",
      reason:
        signResult && signResult.reason
          ? signResult.reason
          : "sign returned non-ok result without reason",
      step: "sign",
    };
  }
  // Spread DEFINES own properties and runs no setter: a [[Set]] copy here
  // handed `sig` to a setter on Object.prototype and left the record unsigned
  // (sigcov R2-3).
  const record = { ...recordCore, sig: signResult.sig };

  // ---- Sign/Stamp BIND (verified-fold, 2026-10-09) --------------------------
  // The stamp (`identity.verified_id`) and the signing key (opts or
  // `git config user.signingkey`) are resolved INDEPENDENTLY and nothing bound
  // them — the MEASURED anomaly class: a record stamped to one persona's ssh
  // key but SIGNED by another rostered key (the whole 27-record chain then
  // fails a verifying fold's rule-1). Bind them here: derive the signing key's
  // fingerprint and REFUSE on a mismatch, naming both in FORM (prefixes only).
  // Only when WE resolved the key - an injected `o.sign` carries no keyPath.
  if (!o.sign && signOpts.keyPath) {
    // Compose the SAME resolver resolveIdentity uses (roster suffix-match
    // FIRST, ambient gpg fingerprint as FALLBACK): the roster suffix-match
    // structurally cannot resolve a signing-SUBKEY id or an email/name
    // user-id, and for those selectors a bare roster resolver returns the
    // VERBATIM selector — refusing a legitimate emit and mis-labelling a
    // selector issue as a key mismatch (round-1 security F1).
    const rosterResolver = roster ? _makeRosterGpgResolver(roster) : null;
    const bindResolver = rosterResolver
      ? (keyId) => rosterResolver(keyId) || _gpgFingerprint(keyId)
      : undefined;
    const fp = _fingerprintFromKey(signOpts.keyPath, signOpts.keyType, bindResolver);
    const claimed = String(record.verified_id || "");
    if (!fp) {
      return {
        ok: false,
        error: "sign/key unbound",
        reason: `cannot derive the signing key's fingerprint (${signOpts.keyType}) to bind against verified_id ${claimed.slice(0, 16)}…; refusing an unbound emission`,
        step: "bind",
      };
    }
    if (String(fp) !== claimed) {
      return {
        ok: false,
        error: "sign/key mismatch",
        reason: `REFUSING a sign/key mismatch: the record is stamped verified_id ${claimed.slice(0, 16)}… but the signing key resolves to ${String(fp).slice(0, 16)}… — sign and stamp must name the same key`,
        step: "bind",
      };
    }
  }

  // ---- Fold-validation (fail-closed recurrence guard, COC-CHAIN) ----------
  // Re-fold [live chain + candidate] and refuse to append unless the
  // candidate lands in accepted. A structurally-malformed record
  // predicate-rejects at fold; appending it anyway never advances the
  // accepted head and poisons every subsequent same-emitter record under
  // rule 3 (the seq-88 stuck-chain post-mortem). Validation runs AFTER
  // sign so the bytes the fold verifies are the bytes that would land.
  //
  // SCOPE: the default validator reads the MAIN coordination-log
  // (resolveLogPath). When a caller injects a custom `append`, the record
  // targets a SEPARATE log with its OWN per-emitter chain (member-registry,
  // capability-ledger, upstream-canon); the main-log validator would
  // mis-judge it as a first-record (rule-2) since the separate log's prior
  // records live elsewhere. So the default validator runs ONLY on the
  // default-append (main-log) path — exactly the COC-CHAIN surface
  // (journal-reserve, codify-lease, journal-body-anchor). A separate-log
  // emitter that wants the guard injects its OWN `validateFold` reading its
  // log (clean opt-in; the injectable always wins over the append gate).
  const validateFold =
    o.validateFold || (o.append ? null : _defaultValidateFold);
  if (validateFold) {
    let validation;
    try {
      validation = validateFold({ repoDir, roster, record });
    } catch (err) {
      return {
        ok: false,
        error: "fold-validation read failed",
        reason: `validateFold threw (coordination-log unreadable; refusing to append unvalidated which could poison the chain): ${err && err.message ? err.message : String(err)}`,
        step: "fold-validate",
      };
    }
    if (!validation || !validation.ok) {
      return {
        ok: false,
        error: "fold-validation refused",
        reason:
          validation && validation.reason
            ? validation.reason
            : "candidate record would not fold cleanly into the accepted chain",
        step: "fold-validate",
      };
    }
  }

  // ---- Append (2KB-capped, typed refusal) ---------------------------------
  const append = o.append || _defaultAppend;
  let appendResult;
  try {
    appendResult = append(repoDir, record);
  } catch (err) {
    return {
      ok: false,
      error: "append failed",
      reason: err && err.message ? err.message : String(err),
      step: "append",
    };
  }
  if (!appendResult || !appendResult.ok) {
    return {
      ok: false,
      error: "append refused",
      reason:
        appendResult && appendResult.error
          ? appendResult.error
          : "append returned non-ok result without error",
      step: "append",
    };
  }

  return { ok: true, record };
}

// FROZEN (sigcov R2-1): `gate-approval.js` hands its single-use capability to
// `emitSignedRecord`, so an assignment to `exports.emitSignedRecord` would
// otherwise steal a live capability from a sanctioned call. NULL-PROTOTYPE as
// well: the two modules require each other, and Node re-prototypes a plain
// `Object.prototype` exports object handed out mid-load (its circular-require
// warning proxy), which throws on a frozen one.
module.exports = _freeze(Object.setPrototypeOf({
  emitSignedRecord,
  // ONE opts snapshot, shared with gate-approval.js::emitGateApproval.
  snapshotPlainOpts,
  MAX_LINE_BYTES,
  // Separate-log emitters build their own validator over their own log.
  makeValidateFold,
  // The one per-log lock; the guard broker's log writer takes its append lock with it.
  acquireLogLock,
  releaseLogLock,
  EMIT_LOCK_FILE,
  LOCK_WAIT_MS,
  LOCK_STALE_MS,
  // Exposed for tests.
  _defaultReadChainHead,
  _defaultAppend,
  _defaultValidateFold,
  _readMainLogRecords,
  _foldDelta,
}, null));

// ---- The capability redeemer, bound ONCE at load (sigcov R2-1) --------------
// Required AFTER module.exports is assigned: gate-approval.js requires this
// module at its own end in the same way, so whichever loads first, the other
// finds a COMPLETE frozen exports object in the cache. Bound here, it is never
// re-resolved from gate-approval's exports or the module cache at call time.
const _redeemEmitCapability = require(path.join(__dirname, "gate-approval.js")).redeemEmitCapability;
if (typeof _redeemEmitCapability !== "function") {
  throw new Error(
    "coc-emit: gate-approval.js exposed no redeemEmitCapability at load; the gate-approval capability cannot be checked",
  );
}
