/**
 * member-registry — cascade-membership record namespace + signed-emit
 * wrapper (loom-side member registry).
 *
 * ECO-IMPL Wave 2, Shard S1 (A1-T1). Companion to fold-member-registry.js
 * (the M1–M4 fold predicates). Implements
 * `workspaces/ecosystem-operating-model/02-plans/07-cascade-membership.md`
 * §4 (the registry substrate); normative `specs/06 §7`.
 *
 * The member registry is a NEW record NAMESPACE on the SAME signed-append +
 * per-emitter-hash-chain substrate as the multi-operator coordination log
 * (`multi-operator-coordination.md` §2), but it is a DISTINCT log living at
 * its own provider-resolved ref `refs/coc/member-registry` (§4.1). The
 * local on-disk realization is `.claude/learning/member-registry.jsonl` —
 * a separate file from `coordination-log.jsonl`, so the two namespaces
 * carry INDEPENDENT per-emitter chains (an emitter's `seq` in the member
 * registry is unrelated to its `seq` in the coordination log). Per
 * `framework-first.md` (§9 substrate reuse): this is NOT a second signing
 * substrate — every signed append routes through the SAME
 * `coc-emit.js::emitSignedRecord` emitter, and the records fold under the
 * SAME engine (with the membership predicates registered in
 * coordination-log.js::_registerM0Defaults).
 *
 * The provider-adapter ref read/write for the actual `refs/coc/member-
 * registry` is W2-S2 (`upstream-canon-pointer.js` + the F122 provider
 * adapters) and the on-demand head fetch is W3; THIS shard owns the local
 * append-only log + the record-namespace constants + the signed-emit
 * wrapper.
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
const foldMemberRegistry = require("./fold-member-registry.js");

// Re-export the record-type names + sever reasons from the SSOT in
// fold-member-registry.js (single source so emit + registration + fold
// cannot drift).
const TYPE_GENESIS_ANCHOR = foldMemberRegistry.TYPE_GENESIS_ANCHOR;
const TYPE_MEMBER_ADMITTED = foldMemberRegistry.TYPE_MEMBER_ADMITTED;
const TYPE_RECONCILIATION = foldMemberRegistry.TYPE_RECONCILIATION;
const TYPE_MEMBERSHIP_SEVERED = foldMemberRegistry.TYPE_MEMBERSHIP_SEVERED;
const TYPE_GENERATION_ROTATION = foldMemberRegistry.TYPE_GENERATION_ROTATION;

const MEMBER_REGISTRY_TYPES = new Set([
  TYPE_GENESIS_ANCHOR,
  TYPE_MEMBER_ADMITTED,
  TYPE_RECONCILIATION,
  TYPE_MEMBERSHIP_SEVERED,
  TYPE_GENERATION_ROTATION,
]);

/**
 * Local on-disk realization of the `refs/coc/member-registry` ref. A
 * SEPARATE file from coordination-log.jsonl — the member registry is a
 * distinct namespace with its own per-emitter chains (§4.1).
 */
function resolveMemberRegistryPath(repoDir) {
  return path.join(repoDir, ".claude", "learning", "member-registry.jsonl");
}

/** Read + parse the local member-registry log (parse-tolerant). */
function readMemberRegistry(repoDir) {
  const p = resolveMemberRegistryPath(repoDir);
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

/**
 * Chain-head reader for the MEMBER REGISTRY log (NOT the coordination
 * log). Folds the registry file through the default engine — which now
 * carries the membership predicates — and returns the emitter's
 * {lastSeq, lastContentHash} in the REGISTRY chain (or null on a fresh
 * chain). Mirrors coc-emit.js::_defaultReadChainHead but targets the
 * registry file, so an emitter's registry chain is independent of its
 * coordination-log chain. Throws on a non-ENOENT read error so emit
 * refuses (refuse-don't-fork) rather than falling back to seq:0.
 */
function _readRegistryChainHead(repoDir, { roster, verifiedId }) {
  const records = readMemberRegistry(repoDir);
  if (records.length === 0) return null;
  // skipSignatureVerify: chain-head needs only chain STRUCTURE (seq +
  // prev_hash), not crypto validity — O(N)-gpg-verify-per-emit fix mirrored
  // from coc-emit.js::_defaultReadChainHead (fail-closed; read-time
  // foldMembership still verifies).
  const folded = coordinationLog.foldLog(records, roster, {
    skipSignatureVerify: true,
  });
  folded.rawRecords = records;
  return coordinationLog.computeOwnChainHead(folded, verifiedId);
}

/**
 * Append a signed record to the MEMBER REGISTRY log with the same 2KB
 * POSIX-atomic-append cap the coordination-log transport enforces. Typed
 * refusal on overflow — never truncate-after-sign.
 */
function _appendToRegistry(repoDir, record) {
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
      error: `member-registry record line (${bytes}B) exceeds MAX_LINE_BYTES (${MAX_LINE_BYTES})`,
    };
  }
  const p = resolveMemberRegistryPath(repoDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, line + "\n");
  return { ok: true };
}

/**
 * Emit one signed, chained member-registry record into the local
 * `member-registry.jsonl`. Thin wrapper over coc-emit.js::emitSignedRecord
 * that injects the registry-targeted append + chain-head reader so the
 * record lands on the member-registry chain (NOT the coordination-log
 * chain). The record TYPE is type-checked by emitSignedRecord against the
 * default engine — so a type not registered in
 * coordination-log.js::_registerM0Defaults is refused (chain-poisoning
 * fence). Same typed-result contract as emitSignedRecord.
 *
 * @param {object} opts - { repoDir, type, content, identity?,
 *   signingKeyPath?, ... } per emitSignedRecord. The append + readChainHead
 *   are injected here (a caller MAY override for tests).
 */
function emitMemberRecord(opts) {
  const o = opts || {};
  if (!o.repoDir || typeof o.repoDir !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "opts.repoDir must be a non-empty string",
      step: "args",
    };
  }
  if (!MEMBER_REGISTRY_TYPES.has(o.type)) {
    return {
      ok: false,
      error: "invalid record type",
      reason: `type '${o.type}' is not a member-registry type (expected one of ${[...MEMBER_REGISTRY_TYPES].join(", ")})`,
      step: "type-check",
    };
  }
  return emitSignedRecord(
    Object.assign({}, o, {
      readChainHead:
        o.readChainHead || ((args) => _readRegistryChainHead(o.repoDir, args)),
      append:
        o.append || ((_rd, record) => _appendToRegistry(o.repoDir, record)),
      // COC-CHAIN guard, member-registry chain: validate against THIS log
      // (not the main coordination-log) so a malformed-but-typed record
      // cannot poison the registry chain the cascade head folds.
      validateFold: o.validateFold || makeValidateFold(readMemberRegistry),
    }),
  );
}

/**
 * Fold the local member registry and report a project's membership state
 * (the M4 fold-side query). Convenience over readMemberRegistry +
 * foldLog + computeMembershipState for callers that have a repoDir + a
 * roster. Returns { folded, membership } so callers can also inspect
 * rejected/forks. NOTE: this is the REGISTRY-TIP-FOLD-TO half only; a FIRE
 * decision additionally re-fetches P's CURRENT pointer (§5 step 2 — W3).
 */
function foldMembership(repoDir, roster, projectId) {
  const folded = coordinationLog.foldLog(
    readMemberRegistry(repoDir),
    roster,
    {},
  );
  const membership = foldMemberRegistry.computeMembershipState(
    folded,
    projectId,
  );
  return { folded, membership };
}

module.exports = {
  MEMBER_REGISTRY_TYPES,
  TYPE_GENESIS_ANCHOR,
  TYPE_MEMBER_ADMITTED,
  TYPE_RECONCILIATION,
  TYPE_MEMBERSHIP_SEVERED,
  TYPE_GENERATION_ROTATION,
  resolveMemberRegistryPath,
  readMemberRegistry,
  emitMemberRecord,
  foldMembership,
  // Exposed for tests.
  _readRegistryChainHead,
  _appendToRegistry,
};
