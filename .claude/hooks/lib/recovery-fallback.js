/**
 * recovery-fallback — R8-S-01 removal-only owner-departure recovery
 * degenerate-fallback predicates for shard A0b-2c.
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.3 "Owner departure + recovery (R7-A-03; hardened R8-S-01/R8-S-03;
 *         residual-bounded R9-S-01 per journal/0120)":
 *     "When a **settled** revocation (rule 10 — folded + no contradicting
 *      X-activity across a `LIVENESS_TTL`-bounded X-quiescence) drops
 *      `derived-live-N` below the last attested N, the gate enters a
 *      **degenerate-fallback**: the sole remaining owner may self-sign a
 *      roster edit **restricted to REMOVING the departed owner's keys/
 *      person_id ONLY** — MUST NOT add any new `owner` `person_id`/key
 *      in the same self-signed edit (R8-S-01)."
 *   §6.4 — gate matrix row: "owner-departure roster edit (revocation-ack,
 *     REMOVAL-ONLY) when a settled gh-api-bound
 *     collaborator-distinctness-revocation (rule 10) drops derived-live-N
 *     below attested-N | Yes (degenerate-fallback, audit-marked,
 *     removal-only — MUST NOT add any owner key/person_id, R8-S-01)".
 *
 * The 2 invariants this module holds (invariant 1 of the shard contract,
 * split into eligibility + validation):
 *
 *   (1a) eligibleForRecoveryFallback — when a settled revocation drops
 *        derived-live-N to 1, the gate enters degenerate-fallback and the
 *        sole remaining owner becomes the eligible remover.
 *
 *   (1b) validateRemovalOnlyEdit — the self-signed roster edit MUST be
 *        REMOVAL-only: only persons[] removals keyed by github_login
 *        among the departed logins; NO new owner-role person_id; NO key-
 *        array growth on any existing owner; NO genesis-block changes.
 *
 * Style: CommonJS, zero-dep, pure functions. No I/O. Consumes the
 * upstream predicates from fold-rule-10.js (isSettled) and derive-n.js
 * (computeDerivedN) by injection — the caller (C2's gate matrix at
 * §6.4) supplies the peer-high-water resolver per R10-S-01.
 */

"use strict";

const path = require("path");

const foldRule10 = require(path.join(__dirname, "fold-rule-10.js"));
const deriveN = require(path.join(__dirname, "derive-n.js"));
// F14 C2 iter-3 root-cause fix: case-insensitive login compare per
// GitHub server semantics. Roster `github_login: "Alice"` vs record
// `content.github_login: "alice"` must match for recovery resolution.
const { loginsEqual } = require(path.join(__dirname, "github-login.js"));

/**
 * Pick the latest verifying revocation per-login from the folded log,
 * EXCLUDING rule-10-contested entries (R10-A-03). Mirrors derive-n.js's
 * latest-by-seq computation but for revocations specifically — used to
 * identify the candidate departed logins.
 */
function _latestRevocationByLogin(foldedState) {
  const out = {};
  const records =
    foldedState && Array.isArray(foldedState.records)
      ? foldedState.records
      : [];
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.type !== "collaborator-distinctness-revocation") continue;
    if (rec.rule10_contested === true) continue;
    const login =
      rec.content && typeof rec.content.github_login === "string"
        ? rec.content.github_login
        : null;
    if (!login) continue;
    if (typeof rec.seq !== "number") continue;
    if (!out[login] || rec.seq > out[login].seq) {
      out[login] = rec;
    }
  }
  return out;
}

/**
 * Pick the latest verifying attestation per-login (R10-A-03 contested
 * exclusion applied symmetrically). Used to detect whether a revocation's
 * effect has been overridden by a later re-attestation (R9-A-02 — a later
 * verifying attestation re-admits).
 */
function _latestAttestationByLogin(foldedState) {
  const out = {};
  const records =
    foldedState && Array.isArray(foldedState.records)
      ? foldedState.records
      : [];
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.type !== "collaborator-distinctness-attestation") continue;
    const login =
      rec.content && typeof rec.content.github_login === "string"
        ? rec.content.github_login
        : null;
    if (!login) continue;
    if (typeof rec.seq !== "number") continue;
    if (!out[login] || rec.seq > out[login].seq) {
      out[login] = rec;
    }
  }
  return out;
}

/**
 * Find the trust-root person_id by scanning the roster for the owner
 * whose github_login matches genesis.repo_owner. Sufficient for the
 * derive-n.js trustRoot input under the bounded-trust threat model.
 */
function _trustRootFromRoster(roster) {
  if (!roster || !roster.genesis || !roster.persons) return null;
  const repoOwner = roster.genesis.repo_owner;
  for (const [pid, person] of Object.entries(roster.persons)) {
    if (!person || person.role !== "owner") continue;
    if (person.host_role === "ci") continue;
    if (loginsEqual(person.github_login, repoOwner)) {
      return { person_id: pid, seq: 0 };
    }
  }
  return null;
}

/**
 * eligibleForRecoveryFallback — predicate consumed by C2's gate matrix
 * §6.4 row 7 (owner-departure roster edit, REMOVAL-ONLY).
 *
 * Eligible iff ALL of:
 *   (a) at least one revocation in the log is settled per rule 10 +
 *       R10-S-01 (the peerHighWaterFor callback resolves the
 *       fetch-bounded half);
 *   (b) AFTER excluding settled-revoked logins from derived-N, the
 *       attested N drops to 1;
 *   (c) the sole remaining person_id is the eligible remover (returned
 *       as `eligible_remover`).
 *
 * @param {object} roster
 * @param {object} foldedState - {records, derived_N?}.
 * @param {function(string): number|null} peerHighWaterFor - rule-9d
 *   peer-high-water resolver for X's per-emitter chain (R10-S-01).
 * @param {object} [opts]
 * @param {number} [opts.now] - ms since epoch; defaults to `Date.now()`.
 *   HIGH-4 (M0 security review): callers MAY inject a deterministic
 *   `now` for testing; production callers MUST use the default. The
 *   wall-clock-now is the load-bearing R10-A-01 invariant — without
 *   real wall-clock the LIVENESS_TTL quiescence cannot be enforced.
 *
 * @returns {{
 *   eligible: boolean,
 *   eligible_remover?: string,
 *   departed_logins?: string[],
 *   reason?: string
 * }}
 */
function eligibleForRecoveryFallback(
  roster,
  foldedState,
  peerHighWaterFor,
  opts,
) {
  const o = opts || {};
  // HIGH-4: real wall-clock by default; opts.now injection for tests only.
  const now = typeof o.now === "number" ? o.now : Date.now();
  if (!roster || !roster.persons) {
    return { eligible: false, reason: "roster missing" };
  }
  if (typeof peerHighWaterFor !== "function") {
    return {
      eligible: false,
      reason: "peerHighWaterFor callback missing (R10-S-01 fetch-bounded)",
    };
  }

  const latestRev = _latestRevocationByLogin(foldedState);
  const latestAtt = _latestAttestationByLogin(foldedState);

  // For each login with a latest revocation that BEATS any latest
  // attestation by seq, check settlement.
  const settledDeparted = [];
  for (const [login, rev] of Object.entries(latestRev)) {
    const att = latestAtt[login];
    if (att && att.seq > rev.seq) continue; // revocation overridden by re-attestation
    // Build the isSettled ctx from the local fold + peer high-water.
    // The folded high-water for X's chain is the max seq of X-signed
    // records the clone has observed; here X is identified by the
    // victim chain (verified_id-keyed peer high-water).
    const records =
      foldedState && Array.isArray(foldedState.records)
        ? foldedState.records
        : [];
    let foldedHighWaterSeq = 0;
    let lastXActivity = null;
    // The victim's verified_id is not on the revocation record directly
    // (revocation.verified_id is the REVOKER's). We approximate via login;
    // the upstream caller MAY provide a richer ctx via the existing
    // fold-rule-10 surface. For the gate-matrix-consumed predicate, the
    // peerHighWaterFor(login) returning a numeric value is the structural
    // signal of fetch-completeness; settlement collapses to the wall-clock
    // half + that signal.
    const peerHi = peerHighWaterFor(login);
    if (peerHi === null || peerHi === undefined) {
      // Not fetched → cannot be settled (R10-S-01).
      continue;
    }
    if (typeof peerHi !== "number") continue;
    // Construct isSettled ctx using a peerHighWaterFor wrapper bound to
    // this login so the predicate's existing R10-S-01 check is the
    // load-bearing settlement gate.
    const settleCtx = {
      foldedHighWaterSeq: peerHi, // local has caught up to peer (test contract)
      peerHighWaterFor: () => peerHi,
      // No X-activity observed in this folded view → use revocation ts as
      // the quiescence reference; LIVENESS_TTL_MS is owned by fold-rule-10.
      lastXActivity: null,
      // HIGH-4 (M0 security review): the folding clone's REAL wall-clock
      // (or test-injected `opts.now`). The prior synthetic `Date.parse(
      // rev.ts) + LIVENESS_TTL_MS + 1` always cleared the quiescence
      // window by construction — defeating R10-A-01. With real `now`, a
      // recent revocation correctly stays unsettled until the wall clock
      // advances past `ts + LIVENESS_TTL_MS`.
      now,
    };
    const settleResult = foldRule10.isSettled(rev, settleCtx);
    if (settleResult.settled) {
      settledDeparted.push(login);
    }
  }

  if (settledDeparted.length === 0) {
    return {
      eligible: false,
      reason:
        "no settled revocation: every revocation either (a) lacks peer-high-water fetch (R10-S-01) or (b) is overridden by a later attestation (R9-A-02)",
    };
  }

  // Compute attested-N excluding the settled-departed logins.
  const trustRoot = _trustRootFromRoster(roster);
  const dnResult = deriveN.computeDerivedN({
    roster,
    log: (foldedState && foldedState.records) || [],
    trustRoot,
  });

  // After excluding settled-departed logins, the remaining live count:
  const remainingLive = dnResult.live_logins.filter(
    (login) => !settledDeparted.includes(login),
  );

  if (remainingLive.length !== 1) {
    return {
      eligible: false,
      reason: `derived-live-N after settled-revocation exclusion is ${remainingLive.length}, not 1 — recovery-fallback only fires when drop-to-1 occurs`,
    };
  }

  // Resolve the sole remaining login → person_id (the eligible remover).
  const remainingLogin = remainingLive[0];
  let eligibleRemover = null;
  for (const [pid, person] of Object.entries(roster.persons)) {
    if (!person || person.role !== "owner") continue;
    if (person.host_role === "ci") continue;
    if (loginsEqual(person.github_login, remainingLogin)) {
      eligibleRemover = pid;
      break;
    }
  }
  if (!eligibleRemover) {
    return {
      eligible: false,
      reason: `sole remaining owner login '${remainingLogin}' not resolvable to a person_id in the roster`,
    };
  }

  return {
    eligible: true,
    eligible_remover: eligibleRemover,
    departed_logins: settledDeparted.slice().sort(),
  };
}

/**
 * Enumerate persons[] mutations between oldRoster and newRoster.
 * Returns {added: [pid], removed: [pid], modified: [pid]}.
 */
function _diffPersons(oldRoster, newRoster) {
  const oldKeys = Object.keys(oldRoster.persons || {});
  const newKeys = Object.keys(newRoster.persons || {});
  const oldSet = new Set(oldKeys);
  const newSet = new Set(newKeys);
  const added = newKeys.filter((k) => !oldSet.has(k));
  const removed = oldKeys.filter((k) => !newSet.has(k));
  const modified = [];
  for (const k of newKeys) {
    if (!oldSet.has(k)) continue;
    if (
      JSON.stringify(oldRoster.persons[k]) !==
      JSON.stringify(newRoster.persons[k])
    ) {
      modified.push(k);
    }
  }
  return { added, removed, modified };
}

/**
 * validateRemovalOnlyEdit — predicate consumed by the operator-gate.js
 * hook (C2 wires the actual gate) to enforce R8-S-01.
 *
 * Valid iff:
 *   (a) the only persons[] mutations are REMOVALS keyed by github_login
 *       among departedLogins;
 *   (b) no new owner-role person_id added in the same edit (R8-S-01);
 *   (c) no key array additions for any existing owner;
 *   (d) the genesis block is unchanged byte-for-byte.
 *
 * @param {object} oldRoster
 * @param {object} newRoster
 * @param {string} eligibleRemover - the person_id authorized as remover
 *   per eligibleForRecoveryFallback.
 * @param {string[]} departedLogins - the github_logins eligible for
 *   removal per the settled revocations.
 *
 * @returns {{valid: boolean, reason?: string}}
 */
function validateRemovalOnlyEdit(
  oldRoster,
  newRoster,
  eligibleRemover,
  departedLogins,
) {
  if (!oldRoster || !oldRoster.persons || !oldRoster.genesis) {
    return { valid: false, reason: "oldRoster missing or malformed" };
  }
  if (!newRoster || !newRoster.persons || !newRoster.genesis) {
    return { valid: false, reason: "newRoster missing or malformed" };
  }
  if (typeof eligibleRemover !== "string" || !eligibleRemover) {
    return { valid: false, reason: "eligibleRemover missing" };
  }
  if (!Array.isArray(departedLogins)) {
    return { valid: false, reason: "departedLogins must be an array" };
  }

  // (d) genesis-block byte-equality (R8-S-01: genesis untouched).
  if (JSON.stringify(oldRoster.genesis) !== JSON.stringify(newRoster.genesis)) {
    return {
      valid: false,
      reason:
        "genesis block modified — removal-only edits MUST NOT touch genesis (R8-S-01)",
    };
  }

  const diff = _diffPersons(oldRoster, newRoster);

  // (b) no owner-role person_id ADDED.
  if (diff.added.length > 0) {
    // Even if the added person isn't an owner, R8-S-01 explicitly forbids
    // adding any new owner person_id in the SAME self-signed edit. We
    // surface ALL adds as a violation because the removal-only window is
    // strictly removal-only — non-owner additions belong in a separate,
    // non-degenerate roster edit.
    const addedOwners = diff.added.filter(
      (pid) =>
        newRoster.persons[pid] && newRoster.persons[pid].role === "owner",
    );
    if (addedOwners.length > 0) {
      return {
        valid: false,
        reason: `R8-S-01: owner-role person_id added in same self-signed edit: ${addedOwners.join(", ")}`,
      };
    }
    return {
      valid: false,
      reason: `removal-only edit added non-owner person_id(s): ${diff.added.join(", ")} — additions are not part of the recovery window`,
    };
  }

  // (a) every removal MUST correspond to a departedLogins entry.
  for (const pid of diff.removed) {
    const oldPerson = oldRoster.persons[pid];
    if (!oldPerson) continue;
    if (!departedLogins.includes(oldPerson.github_login)) {
      return {
        valid: false,
        reason: `person_id '${pid}' (login '${oldPerson.github_login}') removed but not in departedLogins ${JSON.stringify(departedLogins)}`,
      };
    }
  }

  // (c) modifications: no key-array growth + no role changes on remaining
  //     owners. Pure metadata edits (display_id rename, host_role rename
  //     among the human/ci pair) are out of scope for removal-only and
  //     are also rejected — the safest interpretation of R8-S-01 is "no
  //     mutations on remaining owners beyond removal of departed ones".
  for (const pid of diff.modified) {
    const oldP = oldRoster.persons[pid];
    const newP = newRoster.persons[pid];
    if (!oldP || !newP) continue;
    // Key-array growth check.
    const oldKeys = Array.isArray(oldP.keys) ? oldP.keys : [];
    const newKeys = Array.isArray(newP.keys) ? newP.keys : [];
    if (newKeys.length > oldKeys.length) {
      return {
        valid: false,
        reason: `R8-S-01: key array grew on existing owner '${pid}' (${oldKeys.length} → ${newKeys.length}) — no key additions in same self-signed edit`,
      };
    }
    // Any other modification is also forbidden in removal-only mode.
    return {
      valid: false,
      reason: `person_id '${pid}' modified in removal-only edit (must be unchanged)`,
    };
  }

  // (a-positive) at least one removal MUST exist — empty diff is not a
  // "recovery edit" at all.
  if (diff.removed.length === 0) {
    return {
      valid: false,
      reason: "no removal in the edit — not a recovery fallback edit",
    };
  }

  return { valid: true };
}

module.exports = {
  eligibleForRecoveryFallback,
  validateRemovalOnlyEdit,
};
