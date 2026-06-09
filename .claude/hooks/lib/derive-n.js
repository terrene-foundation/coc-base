/**
 * derive-n — derived-N computation for shard A0b-2b.
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.1 — collaborator-distinctness attestation/revocation; derived-N
 *           latest-by-seq per github_login; R9-A-02 + R9-A-03 + R10-A-03;
 *           R5-S-04 host_role:ci is never advisory-eligible
 *   §2.2 — fold rule 10 contested-revocation excluded from latest-by-seq
 *   §6.4 — gate matrix consumes derived-N for degenerate-fallback gating
 *
 * The 2 invariants this module holds (the other 5 live in fold-rule-10.js
 * and the ceremony libs):
 *
 *   (6) Derived-N computation (R9-A-02 + R9-A-03):
 *       For each `owner`-role person in the roster, find the LATEST
 *       (attestation-or-revocation) record by seq for that github_login.
 *       - Attestation-latest → login counts toward derived-N.
 *       - Revocation-latest  → login does NOT count.
 *       - Genesis owner has no attestation; their genesis-anchor binding
 *         IS the distinctness basis (R9-A-03) and counts as-if attested.
 *       - host_role:ci NEVER counts (R5-S-04).
 *
 *   (7) R10-A-03 contested-exclusion: a rule-10-contested revocation is
 *       EXCLUDED from the latest-by-seq computation. The next-latest
 *       verifying record for that login wins, so a contested revocation's
 *       derived-N revert (rule 10) is mechanically consistent with the
 *       latest-wins rule rather than leaving the contested revocation as
 *       the spuriously-authoritative latest record.
 *
 * Style: CommonJS, zero-dep, pure function. No I/O, no clock, no fs.
 * The fold engine (shard A2a) and the gate matrix (shard C2) call this
 * predicate directly.
 */

"use strict";

// F14 C2 iter-3 SSOT consistency: route case-normalization through the
// shared helper (lib/github-login.js). Was: hand-rolled .toLowerCase()
// inline at 3 sites — drifted from sibling libs' approach.
//
// F14 M5-B2 iter-5 R5-MED-2: also route the local-var compares through
// `loginsEqual`. The values at these compare sites are pre-normalized
// via `normalizeLogin` upstream, so `loginsEqual` is idempotent here —
// but routing makes the safety property STRUCTURAL (does not depend on
// upstream discipline). Any future refactor that removes upstream
// normalization stays safe; the SSOT sweep regex catches any new bare
// strict compare on `recLogin`/`login` local-vars.
const { normalizeLogin, loginsEqual } = require("./github-login.js");
// Azure DevOps port (Shard 2c): when roster.genesis.provider === "azure-devops"
// the distinctness binding is the Entra UPN (`principal`) instead of
// github_login, and case-folding routes through normalizePrincipal /
// principalsEqual. Derived-N dispatches ONCE on the roster's provider (the
// roster has exactly one provider; all its records match it) and selects the
// binding field + comparator below — the latest-by-seq algorithm is otherwise
// provider-NEUTRAL.
const { normalizePrincipal, principalsEqual } = require("./ado-login.js");

/**
 * Compute derived-N from a folded log + roster + trust-root snapshot.
 *
 * @param {object} params
 * @param {object} params.roster - the operators roster (validated upstream).
 * @param {Array<object>} params.log - the folded log; each record carries
 *   `type`, `verified_id`, `person_id`, `seq`, `content`, optional
 *   `rule10_contested` (boolean set by fold-rule-10's contest path).
 * @param {object} params.trustRoot - the established trust root from
 *   fold rule 9a / 9c. Carries `{verified_id, person_id, seq, ts,
 *   pinnedFacts}`. Used to identify the genesis owner (R9-A-03).
 *
 * @returns {{
 *   derived_N: number,
 *   live_logins: string[],
 *   per_login_latest: object,
 *   notes: string[]
 * }}
 *
 * `live_logins` is the sorted list of github_logins that count toward
 * derived-N. `per_login_latest` maps github_login → {kind: 'attestation'
 * | 'revocation' | 'genesis-anchor', seq, contested?: boolean}.
 *
 * The function is intentionally permissive about input shape (returns
 * derived_N=0 with notes rather than throwing) — the gate matrix may
 * call this on a degraded log + still need a deterministic answer.
 */
function computeDerivedN(params) {
  const roster = params && params.roster ? params.roster : null;
  const log = Array.isArray(params && params.log) ? params.log : [];
  const trustRoot = params && params.trustRoot ? params.trustRoot : null;
  const notes = [];

  if (!roster || !roster.persons || typeof roster.persons !== "object") {
    notes.push("roster missing or malformed");
    return {
      derived_N: 0,
      live_logins: [],
      per_login_latest: {},
      notes,
    };
  }

  // Azure DevOps port (Shard 2c): select the binding field + comparator once
  // from the roster's provider. github_login + normalizeLogin/loginsEqual for
  // GitHub (byte-unchanged); principal + normalizePrincipal/principalsEqual for
  // azure-devops. The latest-by-seq algorithm below is provider-NEUTRAL — it
  // reads `bindField` on both roster persons and records.
  const isAdo = !!(
    roster.genesis && roster.genesis.provider === "azure-devops"
  );
  const bindField = isAdo ? "principal" : "github_login";
  const normalizeId = isAdo ? normalizePrincipal : normalizeLogin;
  const idEqual = isAdo ? principalsEqual : loginsEqual;

  // 1. Enumerate the candidate owner logins from the roster.
  //    A login is a candidate iff its person record has role=='owner'
  //    AND host_role != 'ci' (R5-S-04).
  //
  //    F14 MED-4: GitHub usernames are case-insensitive server-side, so
  //    the candidateLogins key MUST be lowercase. Two roster entries
  //    advertising the same gh_login under different cases ("Alice" vs
  //    "alice") would otherwise double-count toward derived-N. (ADO Entra
  //    UPNs are likewise case-insensitive via normalizePrincipal.)
  const candidateLogins = new Map(); // lowercase(bound id) → person_id
  for (const [pid, person] of Object.entries(roster.persons)) {
    if (!person || person.role !== "owner") continue;
    if (person.host_role === "ci") {
      notes.push(
        `host_role:ci suppressed: ${person[bindField]} (person_id ${pid}) — R5-S-04`,
      );
      continue;
    }
    if (typeof person[bindField] === "string" && person[bindField]) {
      candidateLogins.set(normalizeId(person[bindField]), pid);
    }
  }

  // 2. Identify the genesis owner via trust-root (R9-A-03).
  //    The genesis owner has no attestation; the trust root's owner-bind
  //    IS their distinctness basis. We surface this in per_login_latest
  //    so the caller can see the basis even when no attestation exists.
  // F14 MED-4: genesisOwnerLogin is compared against lowercased
  // candidateLogins keys, so normalize at capture time.
  let genesisOwnerLogin = null;
  if (trustRoot && typeof trustRoot.person_id === "string") {
    const p = roster.persons[trustRoot.person_id];
    if (
      p &&
      p.role === "owner" &&
      p.host_role !== "ci" &&
      typeof p[bindField] === "string"
    ) {
      genesisOwnerLogin = normalizeId(p[bindField]);
    }
  }

  // 3. For each candidate login, scan the log for ALL attestation/revocation
  //    records and pick the latest-by-seq, EXCLUDING records flagged
  //    rule10_contested (R10-A-03).
  const perLoginLatest = {};
  for (const login of candidateLogins.keys()) {
    let latest = null; // {kind, seq, record_ref?, contested?}
    let contestedCount = 0;
    for (const rec of log) {
      if (!rec || typeof rec !== "object") continue;
      if (
        rec.type !== "collaborator-distinctness-attestation" &&
        rec.type !== "collaborator-distinctness-revocation"
      ) {
        continue;
      }
      // F14 MED-4: record.content[bindField] may carry any case; match
      // case-insensitively against the lowercased candidateLogins keys.
      // (ADO records carry content.principal; GitHub carry content.github_login.)
      const recLogin =
        rec.content && typeof rec.content[bindField] === "string"
          ? normalizeId(rec.content[bindField])
          : null;
      // F14 M5-B2 iter-5 R5-MED-2: route through the equality fn so the
      // safety property does not depend on upstream normalization
      // discipline. Both sides are pre-normalized here; the fn is
      // idempotent in that case.
      if (!idEqual(recLogin, login)) continue;
      // R10-A-03: contested revocations are EXCLUDED from latest-by-seq.
      if (
        rec.type === "collaborator-distinctness-revocation" &&
        rec.rule10_contested === true
      ) {
        contestedCount += 1;
        continue;
      }
      if (typeof rec.seq !== "number") continue;
      if (latest === null || rec.seq > latest.seq) {
        latest = {
          kind:
            rec.type === "collaborator-distinctness-attestation"
              ? "attestation"
              : "revocation",
          seq: rec.seq,
        };
      }
    }
    if (latest === null) {
      // No verifying distinctness record. R9-A-03 — if this IS the genesis
      // owner, the trust-root binding counts AS-IF an attestation.
      // F14 M5-B2 iter-5 R5-MED-2: route through the equality fn (idempotent
      // when both sides are pre-normalized) — same SSOT safety guarantee
      // as the `recLogin !== login` site above.
      if (idEqual(login, genesisOwnerLogin)) {
        perLoginLatest[login] = {
          kind: "genesis-anchor",
          seq:
            trustRoot && typeof trustRoot.seq === "number" ? trustRoot.seq : 0,
          via: "R9-A-03",
        };
        if (contestedCount > 0) {
          notes.push(
            `login ${login}: ${contestedCount} contested revocation(s) excluded; genesis-anchor basis wins`,
          );
        }
      } else {
        // Non-genesis login with no verifying record AND no rule10-contested
        // exclusion — it has not yet been attested. Does not count.
        if (contestedCount > 0) {
          notes.push(
            `login ${login}: ${contestedCount} contested revocation(s) excluded; NO next-latest record exists; login does not count`,
          );
        }
      }
    } else {
      perLoginLatest[login] = latest;
      if (contestedCount > 0) {
        notes.push(
          `login ${login}: ${contestedCount} contested revocation(s) excluded; next-latest is ${latest.kind} at seq ${latest.seq}`,
        );
      }
    }
  }

  // 4. Compute live_logins = logins whose latest counts as attestation-or-
  //    genesis-anchor.
  const liveLogins = [];
  for (const [login, latest] of Object.entries(perLoginLatest)) {
    if (latest.kind === "attestation" || latest.kind === "genesis-anchor") {
      liveLogins.push(login);
    }
  }
  liveLogins.sort();

  return {
    derived_N: liveLogins.length,
    live_logins: liveLogins,
    per_login_latest: perLoginLatest,
    notes,
  };
}

module.exports = {
  computeDerivedN,
};
