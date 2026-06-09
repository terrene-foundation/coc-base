/**
 * fold-genesis-anchor — pure-function fold predicate for fold rule 9a.
 *
 * Shard A0b-2a (workspaces/multi-operator-coc, design v11 §2.2 fold rule 9a).
 *
 * This module ships the predicate; the fold engine in shard A2a will
 * register it via dispatch on `record.type === "genesis-anchor"`. The
 * function is intentionally pure (no I/O, no clock, no fs) so it is
 * trivially testable and so the engine can drive it.
 *
 * The 4 invariants this predicate holds (architecture §2.2 rule 9a +
 * §2.3 + journal/0117 genesis residual):
 *
 *   1. OWNER-BIND. A record folds ONLY if its `sig` verifies under the
 *      pubkey of a person_id in the roster whose role is "owner" AND
 *      whose `github_login` equals `roster.genesis.repo_owner` (for
 *      `repo_owner_kind: "user"`) or matches the org-admin captured at
 *      enrollment (for `repo_owner_kind: "org"`).
 *
 *   2. THREE-PINNED-FACTS MATCH. The record's content.genesis block
 *      MUST match the roster's genesis block on `repo_owner`,
 *      `repo_owner_kind`, and `root_commit`. (`genesis_generation` is
 *      governed by rules 9c/9d, not 9a.)
 *
 *   3. FIRST-WINS BY LOWEST seq. The first verifying owner-bound anchor
 *      (lowest seq by that signer) is the trust root. Same-signer +
 *      identical pinned facts + DIFFERENT seq → reconcile benign to
 *      lowest seq, NO fork (R7-S-04).
 *
 *   4. DIFFERING PINNED FACTS → TRUST-ROOT FORK. Once a trust root is
 *      established, a second verifying owner-bound anchor with DIFFERENT
 *      pinned facts is a trust-root fork: returns {accepted: false,
 *      fork: true, forging_signer: "<verified_id>"} — the §4.5 genesis
 *      residual (journal/0117).
 *
 * `genesis-migration` (rule 9c) supersedes prior anchors and is A3's
 * territory; this module names the extension point but does not
 * implement it.
 *
 * Style: CommonJS, zero-dep (matches sibling .claude/hooks/lib/*.js).
 */

"use strict";

const { canonicalSerialize } = require("./coc-sign.js");
const { isUnenrolled } = require("./roster-schema-validate.js");
// F14 C2 iter-3 root-cause fix: GitHub server-side login semantics are
// case-insensitive. Route ALL login comparisons through loginsEqual()
// (lib/github-login.js) to close the per-site bug class iter-1/2/3 swept.
const { loginsEqual } = require("./github-login.js");
// Azure DevOps port: ADO principal (Entra UPN) comparison for the
// content.provider === "azure-devops" owner-bind branch. Same
// case-insensitive semantics as loginsEqual (sock-puppet defense).
const { principalsEqual } = require("./ado-login.js");

/**
 * Validate that a record has the shape we expect before we touch sig.
 * Returns a string error or null.
 */
function _validateRecordShape(record) {
  if (!record || typeof record !== "object") return "record not an object";
  if (record.type !== "genesis-anchor")
    return `record.type != 'genesis-anchor' (got: ${record.type})`;
  if (typeof record.verified_id !== "string" || !record.verified_id)
    return "verified_id missing";
  if (typeof record.person_id !== "string" || !record.person_id)
    return "person_id missing";
  if (
    typeof record.seq !== "number" ||
    !Number.isInteger(record.seq) ||
    record.seq < 0
  ) {
    return "seq must be non-negative integer";
  }
  if (typeof record.sig !== "string" || !record.sig) return "sig missing";
  if (!record.content || typeof record.content !== "object")
    return "content missing";
  const g = record.content.genesis;
  if (!g || typeof g !== "object") return "content.genesis missing";
  if (typeof g.repo_owner !== "string" || !g.repo_owner)
    return "content.genesis.repo_owner missing";
  if (g.repo_owner_kind !== "user" && g.repo_owner_kind !== "org") {
    return `content.genesis.repo_owner_kind invalid: ${g.repo_owner_kind}`;
  }
  if (typeof g.root_commit !== "string" || !g.root_commit)
    return "content.genesis.root_commit missing";
  return null;
}

/**
 * Find the owner person record in the roster whose github_login resolves
 * to the verified owner. Returns the person record or null.
 *
 * For repo_owner_kind === "user": owner whose github_login === roster.genesis.repo_owner.
 * For repo_owner_kind === "org":  owner whose github_login is recorded in the
 *   anchor's gh_api_org_membership_capture as the admin (A0b-2a captures this
 *   at ceremony time; the predicate trusts the capture because the engine
 *   already verified the signature).
 *
 * NOTE: A person_id beginning with `PLACEHOLDER-` is treated as unenrolled
 * per .claude/operators.roster.README.md and CANNOT serve as the owner-bind.
 */
function _resolveOwnerPerson(roster, record) {
  if (!roster || !roster.persons) return null;
  // Azure DevOps port: dispatch on the record's content.provider (absent ⇒
  // github). An ADO anchor owner-binds via `principal` against the
  // ado_api_org_admin_capture attestation; the inner capture shape is
  // identical to GitHub's org-membership capture, so only the field name +
  // the identity field (principal vs github_login) + the equality function
  // differ. The GitHub branch below is byte-unchanged.
  const providerId = (record.content && record.content.provider) || "github";
  if (providerId === "azure-devops") {
    return _resolveOwnerPersonAdo(roster, record);
  }
  const genesis = roster.genesis || {};
  const kind = genesis.repo_owner_kind;
  let targetLogin;
  if (kind === "user") {
    targetLogin = genesis.repo_owner;
  } else if (kind === "org") {
    const capture =
      record.content && record.content.gh_api_org_membership_capture;
    if (
      !capture ||
      typeof capture.user !== "object" ||
      typeof capture.user.login !== "string"
    ) {
      return null;
    }
    if (capture.role !== "admin") return null;
    targetLogin = capture.user.login;
  } else {
    return null;
  }
  if (!targetLogin) return null;
  for (const [pid, person] of Object.entries(roster.persons)) {
    if (isUnenrolled(pid)) continue;
    if (person.role !== "owner") continue;
    if (!loginsEqual(person.github_login, targetLogin)) continue;
    return { person_id: pid, person };
  }
  return null;
}

/**
 * Azure DevOps owner-bind. An ADO genesis ALWAYS anchors via the org-admin
 * (Project Collection Administrators) attestation — there is no commit-sig
 * verification on ADO. The attestation lives in
 * `content.ado_api_org_admin_capture` (the canonical inner shape is identical
 * to GitHub's gh_api_org_membership_capture: `{role, state, user:{login},
 * organization:{login}, capture_ts}`). The owner person binds via `principal`
 * (Entra UPN), compared case-insensitively.
 *
 * Parity note: this mirrors the GitHub `kind === "org"` branch's
 * role==="admin" predicate. The state==="active" check is enforced at ceremony
 * time (genesis-ceremony.js::_runAdoEnrollment Step 3) for BOTH the github-org
 * and ADO paths; the fold owner-bind checks role only, matching the github
 * branch above (no state re-check in the fold).
 */
function _resolveOwnerPersonAdo(roster, record) {
  if (!roster || !roster.persons) return null;
  const capture = record.content && record.content.ado_api_org_admin_capture;
  if (
    !capture ||
    typeof capture.user !== "object" ||
    typeof capture.user.login !== "string"
  ) {
    return null;
  }
  if (capture.role !== "admin") return null;
  const targetPrincipal = capture.user.login;
  if (!targetPrincipal) return null;
  for (const [pid, person] of Object.entries(roster.persons)) {
    if (isUnenrolled(pid)) continue;
    if (person.role !== "owner") continue;
    if (!principalsEqual(person.principal, targetPrincipal)) continue;
    return { person_id: pid, person };
  }
  return null;
}

/**
 * Re-serialize the record's signed content (everything except `sig`) so
 * verify() can re-derive the bytes the signer covered.
 */
function _signedContentBytes(record) {
  const { sig, ...core } = record;
  return canonicalSerialize(core);
}

/**
 * Three-pinned-facts comparator.
 *
 * F14 C2 iter-4 MED-R4-1: route `repo_owner` through loginsEqual.
 * `repo_owner` IS a GitHub identity name — a user login when
 * `repo_owner_kind === "user"`, an org name when
 * `repo_owner_kind === "org"`. BOTH are ASCII-only case-INSENSITIVE on
 * GitHub (the org-name case-fold semantics match login case-fold). A
 * strict `===` would declare a fork when two operators each pinned the
 * same identity with different casing — same bug class as the iter-3
 * loginsEqual sweep across owner-bind sites, applied at the
 * pinned-facts compare layer.
 *
 * `repo_owner_kind` and `root_commit` stay strict — kind is an enum
 * (`"user"` / `"org"`) and root_commit is a SHA-1 hex string;
 * case-sensitivity is correct for both.
 */
function _pinnedFactsMatch(a, b) {
  return (
    loginsEqual(a.repo_owner, b.repo_owner) &&
    a.repo_owner_kind === b.repo_owner_kind &&
    a.root_commit === b.root_commit
  );
}

/**
 * Fold a candidate genesis-anchor record into the current fold state.
 *
 * @param {object} record - candidate genesis-anchor record (must include sig)
 * @param {object} foldState - current fold state; { trustRoot: null | {...} }
 *   trustRoot, when non-null, has: { verified_id, person_id, seq, ts, pinnedFacts }
 * @param {object} roster - the operators roster (already loaded + validated)
 * @param {function} verifyFn - signature-verify callback;
 *   (content: Buffer, sig: string, pubKey: string) => { ok: boolean, valid?: boolean, reason?: string }
 *   (this matches coc-sign.js::verify by passing keyType implicitly via opts in caller)
 *
 * @returns {{
 *   accepted: boolean,
 *   foldState: object,
 *   reason?: string,
 *   fork?: boolean,
 *   forging_signer?: string
 * }}
 *
 * Behavior:
 *   - shape invalid → {accepted: false, reason}
 *   - owner-bind fails (no owner person whose github_login resolves) →
 *       {accepted: false, reason}
 *   - signer's verified_id doesn't match the resolved owner's roster keys →
 *       {accepted: false, reason} (this is rule-9a's "not owner-bound")
 *   - signature does not verify → {accepted: false, reason}
 *   - three-pinned-facts don't match roster.genesis →
 *       {accepted: false, reason}
 *   - no trust root yet, all checks pass → accept; trustRoot set
 *   - trust root present, same-signer same-facts different-seq →
 *       accept (benign reconcile, R7-S-04); trustRoot remains lowest-seq
 *   - trust root present, DIFFERENT pinned facts → TRUST-ROOT FORK
 *       (the §4.5 genesis residual — journal/0117):
 *       {accepted: false, fork: true, forging_signer: record.verified_id,
 *        reason: "trust-root fork: pinned facts diverge"}
 *
 * Extension point for A3 (genesis-migration / rule 9c): a record of
 * type "genesis-migration" supersedes the trust root; this predicate
 * does NOT handle that — the engine dispatches to a separate predicate
 * for that record type.
 */
function foldGenesisAnchor(record, foldState, roster, verifyFn) {
  const state = foldState || { trustRoot: null };

  // --- Invariant 0: structural shape ---
  const shapeErr = _validateRecordShape(record);
  if (shapeErr) {
    return { accepted: false, foldState: state, reason: shapeErr };
  }

  // --- Invariant 1a: owner-bind via roster ---
  const owner = _resolveOwnerPerson(roster, record);
  if (!owner) {
    return {
      accepted: false,
      foldState: state,
      reason:
        "not owner-bound: no roster owner person resolves to the verified github_login",
    };
  }

  // --- Invariant 1b: signer's verified_id MUST be one of the owner's keys ---
  const ownerKeys = owner.person.keys || [];
  const matchingKey = ownerKeys.find(
    (k) => k.fingerprint === record.verified_id,
  );
  if (!matchingKey) {
    return {
      accepted: false,
      foldState: state,
      reason: `not owner-bound: signer verified_id (${record.verified_id}) is not in roster owner person_id ${owner.person_id}'s keys — signer not the verified owner`,
    };
  }

  // --- Invariant 1c: signature MUST verify under that pubkey ---
  let verifyResult;
  try {
    const bytes = _signedContentBytes(record);
    verifyResult = verifyFn(bytes, record.sig, matchingKey.pubkey, {
      keyType: matchingKey.type,
    });
  } catch (err) {
    return {
      accepted: false,
      foldState: state,
      reason: `signature verify threw: ${err && err.message ? err.message : String(err)}`,
    };
  }
  if (!verifyResult || !verifyResult.ok) {
    return {
      accepted: false,
      foldState: state,
      reason: `signature verify failed: ${verifyResult && verifyResult.reason ? verifyResult.reason : "unknown"}`,
    };
  }
  if (!verifyResult.valid) {
    return {
      accepted: false,
      foldState: state,
      reason: `signature did not verify: ${verifyResult.reason || "invalid"}`,
    };
  }

  // --- Compute pinned facts up-front so we can check fork BEFORE roster ---
  const rosterPinned = {
    repo_owner: roster.genesis.repo_owner,
    repo_owner_kind: roster.genesis.repo_owner_kind,
    root_commit: roster.genesis.root_commit,
  };
  const recordPinned = {
    repo_owner: record.content.genesis.repo_owner,
    repo_owner_kind: record.content.genesis.repo_owner_kind,
    root_commit: record.content.genesis.root_commit,
  };

  // --- Invariant 4 (early): trust-root fork detection — cross-record check ---
  // When a trust root is already established and the new (verifying,
  // owner-bound) record carries DIFFERENT pinned facts, this is the §4.5
  // genesis residual: an honest clone has folded two divergent anchors.
  // The fork check fires BEFORE the roster check because the §4.5
  // scenario explicitly involves divergent rosters across clones.
  if (
    state.trustRoot !== null &&
    !_pinnedFactsMatch(state.trustRoot.pinnedFacts, recordPinned)
  ) {
    return {
      accepted: false,
      foldState: state,
      fork: true,
      forging_signer: record.verified_id,
      reason: `trust-root fork: pinned facts diverge between record (${JSON.stringify(recordPinned)}) and established trust root (${JSON.stringify(state.trustRoot.pinnedFacts)})`,
    };
  }

  // --- Invariant 2: three-pinned-facts MUST match roster.genesis ---
  if (!_pinnedFactsMatch(rosterPinned, recordPinned)) {
    return {
      accepted: false,
      foldState: state,
      reason: `pinned-facts mismatch with roster.genesis: record=${JSON.stringify(recordPinned)} roster=${JSON.stringify(rosterPinned)}`,
    };
  }

  // --- Invariants 3 + 4 continued: first-wins ---
  if (state.trustRoot === null) {
    // First verifying owner-bound anchor — establish trust root.
    const newState = {
      ...state,
      trustRoot: {
        verified_id: record.verified_id,
        person_id: record.person_id,
        seq: record.seq,
        ts: record.ts,
        pinnedFacts: recordPinned,
      },
    };
    return { accepted: true, foldState: newState };
  }

  // Trust root already established AND pinned facts match (fork case
  // handled earlier). Benign reconcile per R7-S-04: keep lowest seq.
  if (record.seq < state.trustRoot.seq) {
    const newState = {
      ...state,
      trustRoot: {
        verified_id: record.verified_id,
        person_id: record.person_id,
        seq: record.seq,
        ts: record.ts,
        pinnedFacts: recordPinned,
      },
    };
    return {
      accepted: true,
      foldState: newState,
      reason: "benign reconcile: lower seq replaces existing trust root",
    };
  }
  // record.seq >= state.trustRoot.seq → existing trust root remains
  // authoritative; accept the record (it's a duplicate witness, not a fork).
  return {
    accepted: true,
    foldState: state,
    reason:
      "benign reconcile: same-signer same-facts higher seq, trust root unchanged (R7-S-04)",
  };
}

module.exports = {
  foldGenesisAnchor,
  // Exposed for testing + downstream tools.
  _internal: {
    _resolveOwnerPerson,
    _pinnedFactsMatch,
    _signedContentBytes,
    _validateRecordShape,
  },
};
