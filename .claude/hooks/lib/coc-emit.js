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
const path = require("path");

const cocSign = require(path.join(__dirname, "coc-sign.js"));
const coordinationLog = require(path.join(__dirname, "coordination-log.js"));
const { resolveLogPath } = require(path.join(__dirname, "state-io.js"));
const { resolveIdentity, _discoverSigningKey } = require(
  path.join(__dirname, "operator-id.js"),
);

// Match transport-filesystem.js MAX_LINE_BYTES — the POSIX O_APPEND
// atomicity half-budget (PIPE_BUF is 4KB; 2KB keeps the line atomic
// under layered fs shims).
const MAX_LINE_BYTES = 2048;

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
  const records = raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && typeof r === "object");
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
  const logPath = resolveLogPath(repoDir);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, line + "\n");
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
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && typeof r === "object");
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
  const foldOpts = { skipSignatureVerify: true };
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
 * @returns {{ok: true, record: object} |
 *           {ok: false, error: string, reason: string, step: string}}
 */
function emitSignedRecord(opts) {
  const o = opts || {};
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
      reason: `type '${o.type}' has no registered fold predicate in the default engine; register it in coordination-log.js::_registerDefaults before emitting (unregistered records are dispatch-rejected at fold and rule-2-poison the emitter's subsequent chain)`,
      step: "type-check",
    };
  }

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

  const recordCore = {
    type: o.type,
    verified_id: identity.verified_id,
    person_id: identity.person_id,
    seq: chainHead ? chainHead.lastSeq + 1 : 0,
    prev_hash: chainHead ? chainHead.lastContentHash : null,
    ts: new Date().toISOString(),
    content: o.content,
  };
  if (identity.display_id) recordCore.display_id = identity.display_id;

  // ---- Sign ---------------------------------------------------------------
  let bytes;
  try {
    bytes = cocSign.canonicalSerialize(recordCore);
  } catch (err) {
    return {
      ok: false,
      error: "canonical-serialize failed",
      reason: err && err.message ? err.message : String(err),
      step: "serialize",
    };
  }

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
    if (Object.prototype.hasOwnProperty.call(o, "gitConfigSigningKey")) {
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
  const record = Object.assign({}, recordCore, { sig: signResult.sig });

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

module.exports = {
  emitSignedRecord,
  MAX_LINE_BYTES,
  // Separate-log emitters build their own validator over their own log.
  makeValidateFold,
  // Exposed for tests.
  _defaultReadChainHead,
  _defaultAppend,
  _defaultValidateFold,
  _readMainLogRecords,
  _foldDelta,
};
