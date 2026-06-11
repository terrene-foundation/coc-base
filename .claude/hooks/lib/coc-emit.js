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
  const folded = coordinationLog.foldLog(records, roster, {});
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
  // Exposed for tests.
  _defaultReadChainHead,
  _defaultAppend,
};
