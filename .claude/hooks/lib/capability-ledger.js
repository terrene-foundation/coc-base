/**
 * capability-ledger — capability-lifecycle ledger record namespace + signed-
 * emit wrapper (loom-side capability ledger).
 *
 * ECO-IMPL Wave 4, Shard W4-S1 (A2-T1). Companion to fold-capability-ledger.js
 * (the §4.2 fold predicates + dual-lineage projection). Implements
 * `workspaces/ecosystem-operating-model/02-plans/08-capability-lifecycle.md`
 * §4.1 (substrate) + §4.2 (record types) + §7 (substrate reuse); normative
 * `specs/06 §5`.
 *
 * The capability ledger is a NEW record NAMESPACE on the SAME signed-append +
 * per-emitter-hash-chain substrate as the multi-operator coordination log
 * (`multi-operator-coordination.md` §2), but it is a DISTINCT log living at
 * its own provider-resolved ref `refs/coc/capability-ledger` (§4.1). The
 * local on-disk realization is `.claude/learning/capability-ledger.jsonl` —
 * a separate file from `coordination-log.jsonl` AND from `member-registry.
 * jsonl`, so the three namespaces carry INDEPENDENT per-emitter chains (an
 * emitter's `seq` in the capability ledger is unrelated to its `seq` in the
 * coordination log or member registry). Per `framework-first.md` (§7
 * substrate reuse): this is NOT a second signing substrate — every signed
 * append routes through the SAME `coc-emit.js::emitSignedRecord` emitter, and
 * the records fold under the SAME engine (with the capability-ledger
 * predicates registered in coordination-log.js::_registerM0Defaults). This is
 * the direct analogue of `member-registry.js` (the W2 member-registry
 * namespace).
 *
 * THIS shard owns the local append-only log + the record-namespace constants
 * + the signed-emit wrapper + a foldLedger convenience. The provider-adapter
 * ref read/write for the actual `refs/coc/capability-ledger` is a later shard
 * (mirroring W2-S2's pointer lib) and is NOT in scope here.
 *
 * Style: CommonJS, sync, zero-dep beyond the shared lib. Per zero-tolerance.md
 * Rule 3: every failure path returns a typed result.
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
const foldCapabilityLedger = require("./fold-capability-ledger.js");

// Re-export the record-type Set + the closed-set constants from the SSOT in
// fold-capability-ledger.js (single source so emit + registration + fold
// cannot drift).
const CAPABILITY_LEDGER_TYPES = foldCapabilityLedger.CAPABILITY_LEDGER_TYPES;

/**
 * Local on-disk realization of the `refs/coc/capability-ledger` ref. A
 * SEPARATE file from coordination-log.jsonl AND member-registry.jsonl — the
 * capability ledger is a distinct namespace with its own per-emitter chains
 * (§4.1).
 */
function resolveCapabilityLedgerPath(repoDir) {
  return path.join(repoDir, ".claude", "learning", "capability-ledger.jsonl");
}

/** Read + parse the local capability-ledger log (parse-tolerant). */
function readCapabilityLedger(repoDir) {
  const p = resolveCapabilityLedgerPath(repoDir);
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
 * Chain-head reader for the CAPABILITY LEDGER log (NOT the coordination log,
 * NOT the member registry). Folds the ledger file through the default engine
 * — which now carries the capability-ledger predicates — and returns the
 * emitter's {lastSeq, lastContentHash} in the LEDGER chain (or null on a
 * fresh chain). Mirrors member-registry.js::_readRegistryChainHead but targets
 * the ledger file, so an emitter's ledger chain is independent of its
 * coordination-log + member-registry chains. Throws on a non-ENOENT read
 * error so emit refuses (refuse-don't-fork) rather than falling back to seq:0.
 */
function _readLedgerChainHead(repoDir, { roster, verifiedId }) {
  const records = readCapabilityLedger(repoDir);
  if (records.length === 0) return null;
  // skipSignatureVerify: chain-head needs only chain STRUCTURE (seq +
  // prev_hash), not crypto validity — O(N)-gpg-verify-per-emit fix mirrored
  // from coc-emit.js::_defaultReadChainHead (fail-closed; read-time
  // foldLedger still verifies).
  const folded = coordinationLog.foldLog(records, roster, {
    skipSignatureVerify: true,
  });
  folded.rawRecords = records;
  return coordinationLog.computeOwnChainHead(folded, verifiedId);
}

/**
 * Append a signed record to the CAPABILITY LEDGER log with the same 2KB
 * POSIX-atomic-append cap the coordination-log transport enforces. Typed
 * refusal on overflow — never truncate-after-sign.
 */
function _appendToLedger(repoDir, record) {
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
      error: `capability-ledger record line (${bytes}B) exceeds MAX_LINE_BYTES (${MAX_LINE_BYTES})`,
    };
  }
  const p = resolveCapabilityLedgerPath(repoDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, line + "\n");
  return { ok: true };
}

/**
 * Emit one signed, chained capability-ledger record into the local
 * `capability-ledger.jsonl`. Thin wrapper over coc-emit.js::emitSignedRecord
 * that injects the ledger-targeted append + chain-head reader so the record
 * lands on the capability-ledger chain (NOT the coordination-log chain, NOT
 * the member-registry chain). The record TYPE is type-checked HERE against
 * CAPABILITY_LEDGER_TYPES AND again by emitSignedRecord against the default
 * engine — so a type not registered in coordination-log.js::
 * _registerM0Defaults is refused (chain-poisoning fence, invariant i). Same
 * typed-result contract as emitSignedRecord.
 *
 * @param {object} opts - { repoDir, type, content, identity?, signingKeyPath?,
 *   ... } per emitSignedRecord. The append + readChainHead are injected here
 *   (a caller MAY override for tests).
 */
function emitLedgerRecord(opts) {
  const o = opts || {};
  if (!o.repoDir || typeof o.repoDir !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "opts.repoDir must be a non-empty string",
      step: "args",
    };
  }
  if (!CAPABILITY_LEDGER_TYPES.has(o.type)) {
    return {
      ok: false,
      error: "invalid record type",
      reason: `type '${o.type}' is not a capability-ledger type (expected one of ${[...CAPABILITY_LEDGER_TYPES].join(", ")})`,
      step: "type-check",
    };
  }
  return emitSignedRecord(
    Object.assign({}, o, {
      readChainHead:
        o.readChainHead || ((args) => _readLedgerChainHead(o.repoDir, args)),
      append: o.append || ((_rd, record) => _appendToLedger(o.repoDir, record)),
      // COC-CHAIN guard, capability-ledger chain: validate against THIS log.
      validateFold: o.validateFold || makeValidateFold(readCapabilityLedger),
    }),
  );
}

/**
 * Fold the local capability ledger and return BOTH the folded result and a
 * dual-lineage projection query bound to it. Convenience over
 * readCapabilityLedger + foldLog for callers that have a repoDir + a roster.
 * Returns { folded, projectDualLineage(capabilityId), readWorkaround(ref) } so
 * callers can inspect rejected/forks AND query per-capability dual-lineage
 * state without re-folding. NOTE: this is the W4 ledger-fold half only; the
 * W5 retirement gate additionally re-fetches membership proofs (A1's head) —
 * NOT in scope here.
 */
function foldLedger(repoDir, roster) {
  const folded = coordinationLog.foldLog(
    readCapabilityLedger(repoDir),
    roster,
    {},
  );
  return {
    folded,
    projectDualLineage: (capabilityId) =>
      foldCapabilityLedger.projectDualLineage(folded, capabilityId),
    readWorkaround: (workaroundRef) =>
      foldCapabilityLedger.readWorkaround(folded, workaroundRef),
  };
}

module.exports = {
  CAPABILITY_LEDGER_TYPES,
  // Record-type names re-exported for callers (SSOT in fold-capability-ledger).
  TYPE_RAILS_PROVISIONED: foldCapabilityLedger.TYPE_RAILS_PROVISIONED,
  TYPE_WORKAROUND_REGISTERED: foldCapabilityLedger.TYPE_WORKAROUND_REGISTERED,
  TYPE_NEED_CLASSIFIED: foldCapabilityLedger.TYPE_NEED_CLASSIFIED,
  TYPE_SUPERSEDES_REBIND: foldCapabilityLedger.TYPE_SUPERSEDES_REBIND,
  TYPE_NEED_ROUTED: foldCapabilityLedger.TYPE_NEED_ROUTED,
  TYPE_CAPABILITY_REGISTERED: foldCapabilityLedger.TYPE_CAPABILITY_REGISTERED,
  TYPE_DEPENDENCY_EDGE: foldCapabilityLedger.TYPE_DEPENDENCY_EDGE,
  TYPE_APPROVAL: foldCapabilityLedger.TYPE_APPROVAL,
  TYPE_CASCADE_FIRED: foldCapabilityLedger.TYPE_CASCADE_FIRED,
  TYPE_MIGRATED: foldCapabilityLedger.TYPE_MIGRATED,
  TYPE_RETIRED: foldCapabilityLedger.TYPE_RETIRED,
  TYPE_MEMBERSHIP_SEVERED: foldCapabilityLedger.TYPE_MEMBERSHIP_SEVERED,
  resolveCapabilityLedgerPath,
  readCapabilityLedger,
  emitLedgerRecord,
  foldLedger,
  // Exposed for tests.
  _readLedgerChainHead,
  _appendToLedger,
};
