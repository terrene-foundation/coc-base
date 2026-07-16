/**
 * enrollment-seed-transport — the composed `transportAppend` that seeds the
 * WHOLE trust-root chain to the canonical, fetchable git ref at enrollment.
 *
 * GENMAT-1 Wave-2 Shard T2 (loom#879 root-cause fix). The trust-root chain
 * (`genesis-anchor` + `genesis-migration`) has, until now, lived ONLY in
 * `.claude/learning/coordination-log.jsonl` — gitignored per-clone AND never
 * pushed to a fetchable ref (both records exceed the 2 KB `MAX_LINE_BYTES`
 * filesystem-transport cap, so the capped local append is the only writer).
 * A fresh clone therefore has nothing to fetch and fail-CLOSED-blocks its
 * first commit (the guard has no anchor to recover). This module makes
 * enrollment ALSO persist the whole chain to the canonical git ref
 * (`transport-git-ref.js`, uncapped) so a future clone can fetch-then-fold
 * its trust root instead of being permanently blocked.
 *
 * --------------------------------------------------------------------------
 * The composed transport
 * --------------------------------------------------------------------------
 *
 * `createEnrollmentSeedTransport({repoDir, remote, localAppend})` returns a
 * `transportAppend(record)` callback with the SAME contract the ceremonies
 * (`genesis-ceremony.js::runEnrollmentCeremony` / `performMigration`)
 * already inject and validate — `(record) => {ok, error?, reason?}`. The
 * ceremony bodies stay BYTE-UNCHANGED; the composition happens at injection
 * time. Each append writes BOTH surfaces, in a fixed order:
 *
 *   1. git ref FIRST  — `refTransport.appendRecordSync(record)`. Durable +
 *      uncapped + fetchable; the recovery surface a fresh clone reads.
 *      Idempotent (`--force-with-lease` fetch-merge-append); a benign
 *      duplicate reconciles at fold (`fold-genesis-anchor.js`).
 *   2. local cache SECOND — the injected `localAppend(record)` (the existing
 *      per-clone `.claude/learning/coordination-log.jsonl` append the fold
 *      engine reads today). Kept as a callback so this module never hardcodes
 *      the log path and stays deterministically testable.
 *
 * Half-write discipline (T2 invariant 4): if the ref append fails, the local
 * append is NOT attempted and a TYPED error is returned — never a false
 * success, never a one-surface-written state that reads as success. If the
 * ref append SUCCEEDS but the local append fails, a typed error is likewise
 * returned (NOT success); the ref write is idempotent so a re-run converges.
 *
 * Ref-name resolution (T2 invariant): the canonical ref name is resolved via
 * `log-ref-name.js::resolveLogRefName` (READ-ONLY `ls-remote` discovery,
 * fail-safe to gen0) — network-permitted at enrollment — NOT a hardcoded
 * literal. The transport, the guard's materialize-remediation text, and this
 * resolver all agree on the name via the single-source `log-ref-name.js`.
 *
 * Owner-only signing is preserved by construction: the ceremony signs the
 * owner-bound record BEFORE calling `transportAppend`, so this module only
 * ever appends already-signed records. A non-owner signer is rejected UPSTREAM
 * (ceremony steps 3/5) and never reaches this transport.
 *
 * Style: CommonJS, zero-dep beyond the two sibling libs (which are zero-dep
 * beyond child_process). The `git` runner used for discovery + the transport
 * factory are injectable (opts.resolveLogRefName / opts.createGitRefTransport
 * / opts.git) so tests use a real `git init --bare` remote in `mktemp -d`
 * without subprocess mocking — the same pattern the sibling libs' tests use.
 */

"use strict";

const logRefName = require("./log-ref-name.js");
const transportGitRef = require("./transport-git-ref.js");

/**
 * Build the composed enrollment-seed `transportAppend`.
 *
 * @param {object} opts
 * @param {string} opts.repoDir - local git checkout for the ref transport +
 *   ls-remote discovery (`git -C <repoDir>`). REQUIRED.
 * @param {function} opts.localAppend - (record) => {ok, error?} | void. The
 *   local coordination-log cache writer. REQUIRED. A thrown error OR a
 *   returned `{ok:false}` is surfaced as a typed local-surface error.
 * @param {string} [opts.remote] - git remote name; defaults to "origin".
 * @param {function} [opts.resolveLogRefName] - override for
 *   `logRefName.resolveLogRefName` (tests); defaults to the real resolver.
 * @param {function} [opts.createGitRefTransport] - override for
 *   `transportGitRef.createGitRefTransport` (tests); defaults to the real
 *   factory.
 * @param {function} [opts.git] - injected git runner forwarded to
 *   `resolveLogRefName` for ls-remote discovery; defaults to its execFileSync
 *   runner (the ref transport constructs its OWN git runner internally).
 *
 * @returns {{transportAppend: function, refName: string, refSource: string}}
 *   `transportAppend(record)` => {ok:true, refTip, refName, surface:"both"}
 *   on success, or {ok:false, error, reason, surface} on any failure.
 */
function createEnrollmentSeedTransport(opts) {
  const o = opts || {};
  if (typeof o.repoDir !== "string" || !o.repoDir) {
    throw new Error("createEnrollmentSeedTransport: opts.repoDir required");
  }
  if (typeof o.localAppend !== "function") {
    throw new Error(
      "createEnrollmentSeedTransport: opts.localAppend must be a function (record) => {ok}",
    );
  }
  const repoDir = o.repoDir;
  const remote = o.remote || "origin";
  const resolveRefName =
    typeof o.resolveLogRefName === "function"
      ? o.resolveLogRefName
      : logRefName.resolveLogRefName;
  const createTransport =
    typeof o.createGitRefTransport === "function"
      ? o.createGitRefTransport
      : transportGitRef.createGitRefTransport;

  // Resolve the canonical current-log-generation ref name from the remote
  // (READ-ONLY ls-remote; network-permitted at enrollment; fail-safe to
  // gen0). The `git` runner is forwarded only when explicitly injected — the
  // resolver defaults to its own execFileSync runner otherwise.
  const resolveArgs = { repoDir, remote };
  if (typeof o.git === "function") resolveArgs.git = o.git;
  const resolution = resolveRefName(resolveArgs);
  const refName = resolution && resolution.refName;
  if (typeof refName !== "string" || !refName) {
    throw new Error(
      "createEnrollmentSeedTransport: resolveLogRefName returned no refName",
    );
  }

  // Construct the uncapped git-ref transport bound to the resolved ref.
  const refTransport = createTransport({ repoDir, remote, refName });

  /**
   * The composed append: git ref FIRST (durable), then local cache. On any
   * failure returns a typed error and does NOT claim success. Never leaves a
   * half-write that reads as success (invariant 4).
   *
   * @param {object} record - the already-signed coordination-log record.
   * @returns {{ok: true, refTip: string, refName: string, surface: "both"} |
   *           {ok: false, error: string, reason: string, surface: "ref"|"local", refTip?: string}}
   */
  function transportAppend(record) {
    if (!record || typeof record !== "object") {
      return {
        ok: false,
        error: "seed-transport: record must be an object",
        reason: `got ${record === null ? "null" : typeof record}`,
        surface: "ref",
      };
    }

    // --- Surface 1: the canonical git ref (durable, uncapped, fetchable) ---
    let refResult;
    try {
      refResult = refTransport.appendRecordSync(record);
    } catch (err) {
      return {
        ok: false,
        error: "seed-transport: ref append threw",
        reason: err && err.message ? err.message : String(err),
        surface: "ref",
      };
    }
    if (!refResult || !refResult.ok) {
      return {
        ok: false,
        error: "seed-transport: ref append failed",
        reason:
          (refResult && (refResult.reason || refResult.error)) ||
          "unknown ref-append error",
        surface: "ref",
      };
    }
    const refTip = refResult.tip;

    // --- Surface 2: the local coordination-log cache (fold-engine source) ---
    // Ordering is ref-FIRST then local so the durable recovery surface is
    // written before the ephemeral per-clone cache. A local failure here does
    // NOT roll back the ref (there is no ref-delete on the recovery surface);
    // instead we return a typed error so the caller does NOT claim success —
    // the idempotent ref append means a re-run converges without forking.
    let localResult;
    try {
      localResult = o.localAppend(record);
    } catch (err) {
      return {
        ok: false,
        error: "seed-transport: local append threw (ref already durable)",
        reason: err && err.message ? err.message : String(err),
        surface: "local",
        refTip,
      };
    }
    if (localResult && localResult.ok === false) {
      return {
        ok: false,
        error: "seed-transport: local append rejected (ref already durable)",
        reason:
          (localResult && (localResult.reason || localResult.error)) ||
          "unknown local-append error",
        surface: "local",
        refTip,
      };
    }

    // Both surfaces written.
    return { ok: true, refTip, refName, surface: "both" };
  }

  return {
    transportAppend,
    refName,
    refSource: resolution.source,
  };
}

module.exports = {
  createEnrollmentSeedTransport,
};
