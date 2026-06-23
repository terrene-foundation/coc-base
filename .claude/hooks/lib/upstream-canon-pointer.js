/**
 * upstream-canon-pointer — write / read / verify the project-side
 * `refs/coc/upstream-canon` single-valued signed pointer chain (the P-side
 * half of the two-sided cascade-membership handshake).
 *
 * ECO-IMPL Wave 2, Shard S2 (A1-T2). Companion to fold-upstream-canon.js
 * (the fold predicate). Implements
 * `workspaces/ecosystem-operating-model/02-plans/07-cascade-membership.md`
 * §3.1 (single-valued signed pointer) + §3.3 cond-2 (the tip names E AND is
 * signed by a current P-rostered key) + §4.2 (the `withdrawn` tombstone);
 * normative `specs/06 §7`.
 *
 * The pointer chain lives at the provider-resolved ref
 * `refs/coc/upstream-canon` in P's OWN repo (§3.1). The local on-disk
 * realization is `.claude/learning/upstream-canon.jsonl` — a SEPARATE file
 * from both coordination-log.jsonl and member-registry.jsonl, with its own
 * per-emitter chain. Per `framework-first.md` (§9 substrate reuse): every
 * signed append routes through coc-emit.js::emitSignedRecord and folds under
 * the SAME engine (with `upstream-canon` registered in
 * coordination-log.js::_registerM0Defaults).
 *
 * The LIVE on-demand REMOTE ref-fetch of P's tip (the §5 step-2 re-fetch
 * via the D6 resolveRemote + the F122 provider adapter) is the W3 head
 * consumer; THIS shard owns the local write/read/verify with an INJECTABLE
 * reader so W3 wires the remote provider read without changing the verify
 * contract.
 *
 * Style: CommonJS, sync, zero-dep beyond the shared lib. Per
 * zero-tolerance.md Rule 3: every failure path returns a typed result.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const {
  emitSignedRecord,
  MAX_LINE_BYTES,
  makeValidateFold,
} = require("./coc-emit.js");
const coordinationLog = require("./coordination-log.js");
const foldUpstreamCanon = require("./fold-upstream-canon.js");

const TYPE_UPSTREAM_CANON = foldUpstreamCanon.TYPE_UPSTREAM_CANON;

/**
 * Local on-disk realization of P's `refs/coc/upstream-canon` ref. A
 * SEPARATE file from coordination-log.jsonl + member-registry.jsonl — the
 * pointer is its own namespace with its own per-emitter chain (§3.1).
 */
function resolveUpstreamCanonPath(repoDir) {
  return path.join(repoDir, ".claude", "learning", "upstream-canon.jsonl");
}

/** Read + parse the local pointer log (parse-tolerant). */
function readUpstreamCanonLog(repoDir) {
  const p = resolveUpstreamCanonPath(repoDir);
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
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

/** Chain-head reader for the POINTER log (refuse-don't-fork on read error). */
function _readPointerChainHead(repoDir, { roster, verifiedId }) {
  const records = readUpstreamCanonLog(repoDir);
  if (records.length === 0) return null;
  // skipSignatureVerify: chain-head needs only chain STRUCTURE (seq +
  // prev_hash), not crypto validity — O(N)-gpg-verify-per-emit fix mirrored
  // from coc-emit.js::_defaultReadChainHead (fail-closed; read-time
  // readPointerTip still verifies).
  const folded = coordinationLog.foldLog(records, roster, {
    skipSignatureVerify: true,
  });
  folded.rawRecords = records;
  return coordinationLog.computeOwnChainHead(folded, verifiedId);
}

/** Append a signed pointer record (2KB-capped, typed refusal). */
function _appendToPointer(repoDir, record) {
  let line;
  try {
    line = JSON.stringify(record);
  } catch (err) {
    return {
      ok: false,
      error: `record is not JSON-serializable: ${err && err.message ? err.message : String(err)}`,
    };
  }
  const bytes = Buffer.byteLength(line + "\n", "utf8");
  if (bytes > MAX_LINE_BYTES) {
    return {
      ok: false,
      error: `upstream-canon record line (${bytes}B) exceeds MAX_LINE_BYTES (${MAX_LINE_BYTES})`,
    };
  }
  const p = resolveUpstreamCanonPath(repoDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, line + "\n");
  return { ok: true };
}

function _emit(repoDir, content, opts) {
  return emitSignedRecord(
    Object.assign({}, opts, {
      repoDir,
      type: TYPE_UPSTREAM_CANON,
      content,
      readChainHead:
        opts.readChainHead || ((args) => _readPointerChainHead(repoDir, args)),
      append:
        opts.append || ((_rd, record) => _appendToPointer(repoDir, record)),
      // COC-CHAIN guard, upstream-canon chain: validate against THIS log.
      validateFold: opts.validateFold || makeValidateFold(readUpstreamCanonLog),
    }),
  );
}

/**
 * Append a signed pointer record naming `ecosystemId` (an admission or a
 * flip — a flip is just the next record naming a different ecosystem,
 * invariant ii). Signed by a P-rostered identity (cond-2). Same typed-
 * result contract as emitSignedRecord.
 */
function emitUpstreamCanonPointer(opts) {
  const o = opts || {};
  if (!o.repoDir || typeof o.repoDir !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "opts.repoDir must be a non-empty string",
      step: "args",
    };
  }
  if (typeof o.ecosystemId !== "string" || !o.ecosystemId) {
    return {
      ok: false,
      error: "invalid argument",
      reason: "opts.ecosystemId must be a non-empty string",
      step: "args",
    };
  }
  return _emit(o.repoDir, { ecosystem_id: o.ecosystemId }, o);
}

/**
 * Append a signed `withdrawn` tombstone (§4.2) — P retracts membership
 * entirely, naming NO ecosystem. The tip then names no ecosystem, so cond-2
 * fails for every E and P is a member of none (the fail-safe exclusion
 * direction).
 */
function emitUpstreamCanonWithdrawal(opts) {
  const o = opts || {};
  if (!o.repoDir || typeof o.repoDir !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "opts.repoDir must be a non-empty string",
      step: "args",
    };
  }
  return _emit(o.repoDir, { ecosystem_id: null, withdrawn: true }, o);
}

/**
 * Fold the pointer chain (with the CURRENT roster) and return the
 * single-valued tip. The reader defaults to the LOCAL pointer log; W3
 * injects a remote provider reader (resolveRemote + adapter) for the §5
 * on-demand fetch WITHOUT changing this contract. A signing identity
 * revoked from `roster` fails the inherited rule 1 → its record drops from
 * the fold → it cannot be the tip (cond-2 fail-closed, the
 * signing-identity-revocation axis).
 *
 * @returns {{ tip: object|null, folded: object }}
 */
function readPointerTip(repoDir, roster, opts) {
  const o = opts || {};
  const records = o.reader ? o.reader(repoDir) : readUpstreamCanonLog(repoDir);
  const folded = coordinationLog.foldLog(records, roster, {});
  return { tip: foldUpstreamCanon.pointerTip(folded), folded };
}

/**
 * Cond-2 verify (§3.3): does P's CURRENT pointer tip name `ecosystemId` AND
 * is it signed by a current P-rostered key? Folds with the given roster so a
 * revoked signer's record is excluded (rule 1), making the four-axis
 * exclusion (names≠E / withdrawn / unfetchable / signature-revoked) a single
 * fail-closed check.
 *
 * @returns {{
 *   names_ecosystem: boolean,   // tip names exactly `ecosystemId`, not withdrawn
 *   withdrawn: boolean,         // tip is a withdrawal tombstone
 *   points_at_other: boolean,   // tip names a DIFFERENT ecosystem (a flip)
 *   tip: object|null,           // the verified tip (null if no record verified)
 * }}
 */
function verifyPointsAt(repoDir, roster, ecosystemId, opts) {
  const { tip } = readPointerTip(repoDir, roster, opts);
  if (!tip) {
    return {
      names_ecosystem: false,
      withdrawn: false,
      points_at_other: false,
      tip: null,
    };
  }
  if (tip.withdrawn) {
    return {
      names_ecosystem: false,
      withdrawn: true,
      points_at_other: false,
      tip,
    };
  }
  const names = tip.ecosystem_id === ecosystemId;
  return {
    names_ecosystem: names,
    withdrawn: false,
    points_at_other: !names,
    tip,
  };
}

module.exports = {
  TYPE_UPSTREAM_CANON,
  resolveUpstreamCanonPath,
  readUpstreamCanonLog,
  emitUpstreamCanonPointer,
  emitUpstreamCanonWithdrawal,
  readPointerTip,
  verifyPointsAt,
  // Exposed for tests.
  _readPointerChainHead,
  _appendToPointer,
};
