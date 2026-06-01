/**
 * genesis-ceremony — the enrollment-ceremony state machine for shard A0b-2a.
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.3 — Genesis ceremony (R5-S-01 + R6-S-01; residual-bounded per journal/0117)
 *   §2.3 — Org-owned branch (R5-S-02)
 *   §2.2 — `genesis-anchor` record type
 *   §4.3 — `genesis-anchor-guard.js` row (this module is the ceremony, the guard
 *          is sibling .claude/hooks/genesis-anchor-guard.js — they coordinate)
 *   journal/0117 — co-owner-accepted genesis residual
 *
 * The 2 of 5 invariants this module holds (the other 3 are in
 * fold-genesis-anchor.js + genesis-anchor-guard.js):
 *
 *   (1) Enrollment ceremony — network-permitted, blocking, fail-CLOSED.
 *       Verifies (a) external owner == roster.genesis.repo_owner;
 *       (b) root_commit verification.verified == true with verified author
 *           == the repo-owner account;
 *       (c) roster declares exactly ONE `owner` person_id whose github_login
 *           resolves to that owner.
 *       If ANY of (a)/(b)/(c) fails OR network unavailable → fail-CLOSED.
 *       NO genesis-anchor record emitted on fail-CLOSED.
 *
 *   (2) Emit signed `genesis-anchor` record owner-bound — signed by the key
 *       whose github_login condition-(c) resolved to. Captures raw gh-api
 *       JSON for owner + root-commit verification (+ org-membership for
 *       repo_owner_kind=org) into the signed record content.
 *
 *   (5) Org-owned anchor variant (R5-S-02): when repo_owner_kind=org, ALSO
 *       verifies gh api orgs/{org}/memberships/{login} .role == "admin"
 *       AND captures it.
 *
 * Style: CommonJS, zero-dep. Network IO + signing IO are injected as
 * function parameters (ghApi, sign, transportAppend, now) so the module
 * is unit-testable without subprocess mocking.
 */

"use strict";

const cocSign = require("./coc-sign.js");
const ghApiAllowlist = require("./gh-api-allowlist.js");
const githubLogin = require("./github-login.js");
const { isUnenrolled } = require("./roster-schema-validate.js");
const { CO_SIGN_ANCHOR_KIND_ORG_ADMIN } = require("./fold-rule-9c.js");

// F86 / MUST-7 typed-error tokens. Callers (sessions, CLI, hooks)
// pattern-match these strings to distinguish the structural-block paths
// from runtime / network failures. The strings are part of the public
// surface (per the rule prose); changes require a coordinated update of
// the rule body + helper + caller pattern matchers.
const ERR_USER_OWNED_N1_BLOCKED =
  "genesis-migration: user-owned N=1 has no structural co-sign anchor; add a second owner via /whoami --register before migrating";
const ERR_GHES_SHARED_APPLIANCE_BLOCKED =
  'genesis-migration: host="ghes-shared-appliance" has out-of-band appliance-admin mutation channel; org-admin attestation cannot substitute as the structural anchor under N=1. Add a second owner via /whoami --register before migrating';

/**
 * Default sign function bound to coc-sign.js. Callers MAY override for
 * testing or to use a non-default key path. The signature returned is
 * a detached SSH or GPG signature over canonicalSerialize(record-without-sig).
 *
 * @param {Buffer} bytes - canonical-serialized record content
 * @param {object} opts - {keyType, keyPath, ...} per coc-sign.sign
 * @returns {{ok: boolean, sig?: string, error?: string, reason?: string}}
 */
function defaultSign(bytes, opts) {
  return cocSign.sign(bytes, opts);
}

/**
 * Validate the roster minimally for ceremony purposes. Returns null if OK
 * or a string error.
 */
function _validateRosterForCeremony(roster) {
  if (!roster || typeof roster !== "object") return "roster not an object";
  if (!roster.genesis || typeof roster.genesis !== "object")
    return "roster.genesis missing";
  const g = roster.genesis;
  if (typeof g.repo_owner !== "string" || !g.repo_owner)
    return "roster.genesis.repo_owner missing";
  if (g.repo_owner_kind !== "user" && g.repo_owner_kind !== "org") {
    return `roster.genesis.repo_owner_kind invalid: ${g.repo_owner_kind}`;
  }
  if (typeof g.root_commit !== "string" || !g.root_commit)
    return "roster.genesis.root_commit missing";
  if (!roster.persons || typeof roster.persons !== "object")
    return "roster.persons missing";
  return null;
}

/**
 * Resolve the genesis owner person_id in the roster. The roster MUST
 * declare EXACTLY ONE `owner` person_id whose github_login matches the
 * target (the repo_owner for kind=user, or the admin login for kind=org).
 *
 * Returns {ok: true, person_id, person} or {ok: false, reason}.
 *
 * PLACEHOLDER- person_ids are treated as unenrolled.
 */
function _resolveGenesisOwner(roster, targetLogin) {
  // F14 C2 iter-2 Q-MED-1: GitHub server semantics are case-insensitive on
  // logins. A strict `!==` allowed an attacker registering as "Alice" to
  // evade a lookup for "alice" (or vice versa). Same sibling-class as
  // PR #316 MED-4's gate-matrix + derive-n case-fold sweep.
  //
  // F14 C2 iter-3 SSOT consistency: route through githubLogin.loginsEqual
  // (was: hand-rolled String(...).toLowerCase() === ... — drifted from
  // sibling libs' approach). Adding a new normalization invariant
  // requires one edit (the helper) — not N edits across every site.
  const matches = [];
  for (const [pid, person] of Object.entries(roster.persons)) {
    if (isUnenrolled(pid)) continue;
    if (person.role !== "owner") continue;
    if (!githubLogin.loginsEqual(person.github_login, targetLogin)) continue;
    matches.push({ person_id: pid, person });
  }
  if (matches.length === 0) {
    return {
      ok: false,
      reason: `no genesis owner declared in roster: no person_id with role=owner has github_login=${targetLogin}`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `roster declares ${matches.length} owner person_ids with github_login=${targetLogin}; ceremony requires exactly one`,
    };
  }
  return {
    ok: true,
    person_id: matches[0].person_id,
    person: matches[0].person,
  };
}

/**
 * Find the signing key (by fingerprint) within the genesis-owner's keys.
 */
function _findSigningKey(person, fingerprint) {
  const keys = person.keys || [];
  for (const k of keys) {
    if (k.fingerprint === fingerprint) return k;
  }
  return null;
}

/**
 * Run the genesis enrollment ceremony.
 *
 * @param {object} opts
 * @param {object} opts.roster                 - parsed roster JSON
 * @param {{owner: string, name: string}} opts.repo - repo identification for gh api
 * @param {string} opts.signingKeyPath         - path to the SSH/GPG signing key
 * @param {string} opts.signingKeyFingerprint  - the verified_id (fingerprint) of the key
 * @param {function} opts.ghApi                - (endpoint: string) => {ok, status, body, error?}
 *                                                The ONLY mocked surface in tests; in production
 *                                                this is a wrapper around `gh api <endpoint>`.
 * @param {function} opts.transportAppend      - (record: object) => {ok, error?}
 *                                                Appends the signed record to the coordination log.
 * @param {function} [opts.now]                - () => ISO-8601 string; defaults to wall clock
 * @param {function} [opts.sign]               - override for coc-sign.sign; defaults to defaultSign
 * @param {"ssh"|"gpg"} [opts.keyType]         - signing key type; default "ssh"
 *
 * @returns {{ok: true, record: object} |
 *           {ok: false, error: string, reason: string, step: string}}
 *
 * Steps (each can fail-CLOSED):
 *   1. Roster shape sanity (pre-flight; not yet condition (c)).
 *   2. gh api repos/{owner}/{repo} → capture external owner, compare to
 *      roster.genesis.repo_owner (R5-S-01 condition (a) / R4-S-03).
 *   3. (org variant only) gh api orgs/{org}/memberships/{adminLogin} → role
 *      MUST be "admin"; the adminLogin is the github_login the signing
 *      person_id maps to. We pre-resolve it from the signing fingerprint.
 *   4. gh api repos/{owner}/{repo}/commits/{root_commit} → verification.verified
 *      MUST be true AND verified author MUST be the repo-owner account
 *      (R5-S-01 condition (b)).
 *   5. Resolve the genesis owner in the roster (condition (c)); the signing
 *      key MUST match that owner's declared keys.
 *   6. Build the canonical record content, sign, append. NO record is
 *      emitted on any prior failure.
 */
function runEnrollmentCeremony(opts) {
  const o = opts || {};
  const {
    roster,
    repo,
    signingKeyPath,
    signingKeyFingerprint,
    ghApi,
    transportAppend,
  } = o;
  const now = o.now || (() => new Date().toISOString());
  const sign = o.sign || defaultSign;
  const keyType = o.keyType || "ssh";

  // Step 1: roster pre-flight
  const rosterErr = _validateRosterForCeremony(roster);
  if (rosterErr) {
    return {
      ok: false,
      error: "roster invalid",
      reason: rosterErr,
      step: "1-roster-preflight",
    };
  }
  if (!repo || typeof repo !== "object" || !repo.owner || !repo.name) {
    return {
      ok: false,
      error: "repo identification missing",
      reason: "opts.repo MUST be {owner, name}",
      step: "1-roster-preflight",
    };
  }
  // HIGH-3 (M0 security review): validate endpoint inputs BEFORE
  // interpolation. Prevents path traversal / shell metachars / URL query
  // injection from contaminating the gh-api endpoint string.
  const repoOwnerValid = githubLogin.validateGithubLogin(repo.owner);
  if (!repoOwnerValid.valid) {
    return {
      ok: false,
      error: "repo.owner invalid",
      reason: `repo.owner ${repoOwnerValid.reason}`,
      step: "1-roster-preflight",
    };
  }
  const repoNameValid = githubLogin.validateGithubRepoName(repo.name);
  if (!repoNameValid.valid) {
    return {
      ok: false,
      error: "repo.name invalid",
      reason: `repo.name ${repoNameValid.reason}`,
      step: "1-roster-preflight",
    };
  }
  // Same validation for the roster-declared owner (used in endpoint
  // construction at step 3 + comparison at step 2).
  if (!roster.genesis || typeof roster.genesis.repo_owner !== "string") {
    // already caught by _validateRosterForCeremony above; defensive guard.
    return {
      ok: false,
      error: "roster.genesis.repo_owner missing",
      reason: "defensive: roster.genesis.repo_owner not a string",
      step: "1-roster-preflight",
    };
  }
  const declaredOwnerValid = githubLogin.validateGithubLogin(
    roster.genesis.repo_owner,
  );
  if (!declaredOwnerValid.valid) {
    return {
      ok: false,
      error: "roster.genesis.repo_owner invalid",
      reason: `roster.genesis.repo_owner ${declaredOwnerValid.reason}`,
      step: "1-roster-preflight",
    };
  }
  if (!signingKeyPath || !signingKeyFingerprint) {
    return {
      ok: false,
      error: "signing key not configured",
      reason:
        "opts.signingKeyPath + opts.signingKeyFingerprint are required (zero-tolerance.md Rule 3 — no silent fallback)",
      step: "1-roster-preflight",
    };
  }
  if (typeof ghApi !== "function") {
    return {
      ok: false,
      error: "ghApi callable missing",
      reason: "opts.ghApi must be a function (endpoint) => {ok,status,body}",
      step: "1-roster-preflight",
    };
  }
  if (typeof transportAppend !== "function") {
    return {
      ok: false,
      error: "transportAppend callable missing",
      reason: "opts.transportAppend must be a function (record) => {ok}",
      step: "1-roster-preflight",
    };
  }

  const repoOwnerKind = roster.genesis.repo_owner_kind;
  const declaredOwner = roster.genesis.repo_owner;
  const declaredRoot = roster.genesis.root_commit;

  // Step 2: gh api repos/{owner}/{repo} → external owner check
  let ownerCapture;
  try {
    const r = ghApi(`repos/${repo.owner}/${repo.name}`);
    if (!r || !r.ok) {
      return {
        ok: false,
        error: "gh api repos call failed",
        reason: `gh api repos/${repo.owner}/${repo.name} → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
        step: "2-gh-api-owner",
      };
    }
    if (!r.body || !r.body.owner || typeof r.body.owner.login !== "string") {
      return {
        ok: false,
        error: "gh api repos response malformed",
        reason: `expected body.owner.login; got ${JSON.stringify(r.body)}`,
        step: "2-gh-api-owner",
      };
    }
    const externalOwner = r.body.owner.login;
    // F14 C2 iter-4 HIGH-R4-1: route through loginsEqual (was strict
    // `!==`). GitHub server-side login semantics are case-INSENSITIVE
    // (same root cause as iter-2 Q-MED-1 + iter-3 SSOT sweep). A roster
    // declaring "alice" with gh-api returning "Alice" is the SAME
    // identity; strict `!==` aborts the ceremony → trust root never
    // establishes → all downstream guards hard-block. Same bug class
    // as fold-genesis-anchor.js step (the iter-3 fix); iter-4 closes
    // the local-var-assigned variant.
    if (!githubLogin.loginsEqual(externalOwner, declaredOwner)) {
      return {
        ok: false,
        error: "owner_mismatch",
        reason: `gh api owner mismatch: roster declares '${declaredOwner}', gh api returned '${externalOwner}' (R5-S-01 condition (a) / R4-S-03)`,
        step: "2-gh-api-owner",
      };
    }
    // HIGH-1 (M0 security review): allowlist response capture. Drops
    // description / homepage / billing_email / private / etc. that
    // would otherwise become permanent in signed records.
    // M3 HIGH-4 / F-7: capture_ts anchored to capture moment for downstream
    // freshness predicate (fold-rule-9c).
    ownerCapture = ghApiAllowlist._allowlistRepoOwner(r.body, {
      capture_ts: new Date().toISOString(),
    });
  } catch (err) {
    return {
      ok: false,
      error: "gh api repos call threw",
      reason: `network unavailable or ghApi threw: ${err && err.message ? err.message : String(err)}`,
      step: "2-gh-api-owner",
    };
  }

  // Step 3-pre: pre-resolve the genesis owner person from the roster so we
  // know the github_login to use for org admin check + the signing key bind.
  // For repo_owner_kind=user, the target login is declaredOwner.
  // For repo_owner_kind=org, the target login is the admin login — but we
  // can't know it without looking up which person_id's signing key matches
  // the fingerprint. So we first find the person whose key matches, then
  // verify they are owner-role AND (for org) their github_login is admin.
  let signingPerson = null;
  let signingPersonId = null;
  for (const [pid, person] of Object.entries(roster.persons)) {
    if (isUnenrolled(pid)) continue;
    if (_findSigningKey(person, signingKeyFingerprint)) {
      signingPerson = person;
      signingPersonId = pid;
      break;
    }
  }
  if (!signingPerson) {
    return {
      ok: false,
      error: "signing key not in roster",
      reason: `signing key fingerprint ${signingKeyFingerprint} does not match any non-PLACEHOLDER person_id in the roster`,
      step: "3-signing-key-bind",
    };
  }
  if (signingPerson.role !== "owner") {
    return {
      ok: false,
      error: "signing key not owner-role",
      reason: `signing key resolves to person_id ${signingPersonId} with role=${signingPerson.role}; only role=owner may sign genesis-anchor`,
      step: "3-signing-key-bind",
    };
  }

  // Step 3: org-owned variant — admin-membership check
  let orgMembershipCapture = null;
  if (repoOwnerKind === "org") {
    const adminLogin = signingPerson.github_login;
    // HIGH-3 (M0 security review): validate adminLogin BEFORE interpolation.
    const adminValid = githubLogin.validateGithubLogin(adminLogin);
    if (!adminValid.valid) {
      return {
        ok: false,
        error: "signing person's github_login invalid",
        reason: `signing person.github_login ${adminValid.reason}`,
        step: "3-org-admin",
      };
    }
    try {
      const r = ghApi(`orgs/${declaredOwner}/memberships/${adminLogin}`);
      if (!r || !r.ok) {
        return {
          ok: false,
          error: "org membership check failed",
          reason: `gh api orgs/${declaredOwner}/memberships/${adminLogin} → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
          step: "3-org-admin",
        };
      }
      if (!r.body || r.body.role !== "admin") {
        return {
          ok: false,
          error: "not an org admin",
          reason: `gh api orgs/${declaredOwner}/memberships/${adminLogin} role is '${r.body && r.body.role}', not 'admin' (R5-S-02)`,
          step: "3-org-admin",
        };
      }
      // Issue #358: also require state=="active". An "admin" with state
      // "pending" / "suspended" cannot stand in as the verified-identity
      // anchor that substitutes for an unsigned root commit in the org-owned
      // bootstrap relaxation (Step 4 below). The relaxation is conditioned
      // on this attestation, so the attestation MUST be currently in force.
      if (r.body.state !== "active") {
        return {
          ok: false,
          error: "org membership not active",
          reason: `gh api orgs/${declaredOwner}/memberships/${adminLogin} state is '${r.body && r.body.state}', not 'active' (issue #358 — admin attestation MUST be active to substitute as the verified-identity anchor)`,
          step: "3-org-admin",
        };
      }
      // HIGH-1: allowlist org-membership capture.
      // M3 HIGH-4: anchor capture_ts.
      orgMembershipCapture = ghApiAllowlist._allowlistOrgMembership(r.body, {
        capture_ts: new Date().toISOString(),
      });
    } catch (err) {
      return {
        ok: false,
        error: "org membership call threw",
        reason: `network unavailable or ghApi threw: ${err && err.message ? err.message : String(err)}`,
        step: "3-org-admin",
      };
    }
  }

  // Step 4: gh api commits/{root_commit} → verification.verified == true
  // + verified author == repo-owner account.
  let rootCommitCapture;
  try {
    const r = ghApi(`repos/${repo.owner}/${repo.name}/commits/${declaredRoot}`);
    if (!r || !r.ok) {
      return {
        ok: false,
        error: "gh api root-commit call failed",
        reason: `gh api commits/${declaredRoot} → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
        step: "4-root-commit",
      };
    }
    const body = r.body || {};
    const commit = body.commit || {};
    const verification = commit.verification || {};
    // Issue #358: org-owned bootstrap relaxation. When the repo is org-owned
    // AND Step 3 verified the signing operator is a current org admin with
    // state=="active" (orgMembershipCapture truthy ⇒ both checks passed), the
    // verified-admin attestation captured at Step 3 substitutes as the
    // verified-identity anchor for the trust root. The unsigned-root state
    // is still captured (via the standard allowlist) into the signed
    // genesis-anchor record so auditors can see the ceremony proceeded under
    // the org-admin attestation path.
    //
    // The user-owned branch (repoOwnerKind === "user") is UNCHANGED: the
    // signed-root-commit IS the verified-identity anchor there; no
    // substituting external attestation is captured for that path, so the
    // gate cannot be relaxed.
    const isOrgBootstrapWithAdminAttestation =
      repoOwnerKind === "org" && orgMembershipCapture;
    if (verification.verified !== true && !isOrgBootstrapWithAdminAttestation) {
      return {
        ok: false,
        error: "root_commit verification unverified",
        reason: `gh api commits/${declaredRoot} .commit.verification.verified is ${verification.verified} (reason: ${verification.reason}); R5-S-01 condition (b) requires verified=true`,
        step: "4-root-commit",
      };
    }
    // For repo_owner_kind=user we require commit.author or verification to
    // be associated with the declared owner. For org-owned we accept the
    // verified flag + the org-admin signer (or, per issue #358, the verified
    // org-admin attestation when the root commit itself is unsigned).
    if (repoOwnerKind === "user") {
      const authorName = commit.author && commit.author.name;
      const authorLogin = body.author && body.author.login;
      // F14 C2 iter-4 HIGH-R4-1: route through loginsEqual (was strict
      // `===`). Same case-insensitive identity invariant as Step 2 above:
      // root-commit author "Alice" / "alice" / "ALICE" are the same
      // GitHub account. Strict `===` would abort the ceremony when the
      // user's gh-api capture casing differs from the roster's
      // repo_owner casing — even though the underlying identity is
      // identical. authorName is checked the same way (the Name field
      // is conventionally a display name but GitHub returns the login
      // for accounts without a display name, so the same case-sensitivity
      // applies).
      const matches =
        githubLogin.loginsEqual(authorLogin, declaredOwner) ||
        githubLogin.loginsEqual(authorName, declaredOwner);
      if (!matches) {
        return {
          ok: false,
          error: "root_commit verified author mismatch",
          reason: `verified author (login=${authorLogin}, name=${authorName}) is not the declared owner '${declaredOwner}'`,
          step: "4-root-commit",
        };
      }
    }
    // HIGH-1: allowlist commit-verification capture.
    // M3 HIGH-4: anchor capture_ts.
    rootCommitCapture = ghApiAllowlist._allowlistCommitVerification(body, {
      capture_ts: new Date().toISOString(),
    });
  } catch (err) {
    return {
      ok: false,
      error: "gh api commits call threw",
      reason: `network unavailable or ghApi threw: ${err && err.message ? err.message : String(err)}`,
      step: "4-root-commit",
    };
  }

  // Step 5: resolve genesis owner (condition (c)) — exactly ONE owner in
  // roster whose github_login is the target.
  const targetLogin =
    repoOwnerKind === "user" ? declaredOwner : signingPerson.github_login;
  const ownerResolution = _resolveGenesisOwner(roster, targetLogin);
  if (!ownerResolution.ok) {
    return {
      ok: false,
      error: "no genesis owner declared",
      reason: ownerResolution.reason,
      step: "5-condition-c",
    };
  }
  // The signing person_id MUST match the resolved genesis-owner person_id.
  if (ownerResolution.person_id !== signingPersonId) {
    return {
      ok: false,
      error: "signing key not the resolved genesis owner",
      reason: `signing fingerprint maps to ${signingPersonId}; condition-(c)-resolved genesis owner is ${ownerResolution.person_id}`,
      step: "5-condition-c",
    };
  }

  // Step 6: build, sign, append. The record core is canonical-serialized
  // and signed; the resulting record carries the detached signature.
  const content = {
    genesis: {
      repo_owner: declaredOwner,
      repo_owner_kind: repoOwnerKind,
      root_commit: declaredRoot,
      genesis_generation: roster.genesis.genesis_generation || 0,
    },
    gh_api_owner_capture: ownerCapture,
    gh_api_root_commit_capture: rootCommitCapture,
  };
  if (orgMembershipCapture) {
    content.gh_api_org_membership_capture = orgMembershipCapture;
  }
  const recordCore = {
    type: "genesis-anchor",
    verified_id: signingKeyFingerprint,
    person_id: signingPersonId,
    seq: 0,
    prev_hash: null,
    ts: now(),
    content,
  };

  let bytes;
  try {
    bytes = cocSign.canonicalSerialize(recordCore);
  } catch (err) {
    return {
      ok: false,
      error: "canonicalSerialize threw",
      reason: err && err.message ? err.message : String(err),
      step: "6-serialize",
    };
  }

  const signResult = sign(bytes, { keyType, keyPath: signingKeyPath });
  if (!signResult || !signResult.ok) {
    return {
      ok: false,
      error: signResult && signResult.error ? signResult.error : "sign failed",
      reason: signResult && signResult.reason ? signResult.reason : "unknown",
      step: "6-sign",
    };
  }
  const record = { ...recordCore, sig: signResult.sig };

  const appendResult = transportAppend(record);
  if (!appendResult || !appendResult.ok) {
    return {
      ok: false,
      error: "transport append failed",
      reason:
        appendResult && appendResult.error
          ? appendResult.error
          : "unknown transport append error",
      step: "6-append",
    };
  }

  return { ok: true, record };
}

// =========================================================================
// F86 / MUST-7 — performMigration (N=1 org-admin path + re-anchor sub-case)
// =========================================================================

/**
 * Resolve the sole owner person_id in the roster for the N=1 path. Returns
 * {ok, person_id, person, count} where `count` is the total number of
 * rostered (non-PLACEHOLDER) owner person_ids. The N=1 path requires
 * count === 1; count ≥ 2 surfaces as a typed error pointing the caller at
 * the 2-of-N path (which lives outside this helper's scope).
 */
function _resolveSoleOwner(roster) {
  const owners = Object.entries((roster && roster.persons) || {}).filter(
    ([pid, person]) => !isUnenrolled(pid) && person && person.role === "owner",
  );
  if (owners.length === 0) {
    return {
      ok: false,
      count: 0,
      reason: "roster declares zero rostered owner person_ids",
    };
  }
  if (owners.length > 1) {
    return {
      ok: false,
      count: owners.length,
      reason: `roster declares ${owners.length} rostered owner person_ids; MUST-7 N=1 path requires exactly one. Use the 2-of-N migration path instead.`,
    };
  }
  const [pid, person] = owners[0];
  return { ok: true, count: 1, person_id: pid, person };
}

/**
 * Run a git command and return {ok, stdout, stderr, status}. The caller
 * MAY override via opts.git for testing (avoids subprocess invocation).
 * In production this wraps `git` with the safer execFileSync arg-array
 * form per `security.md` § "No eval()" (no shell-string interpolation).
 */
function _defaultGit({ args, cwd }) {
  // eslint-disable-next-line global-require
  const { execFileSync } = require("child_process");
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { ok: true, stdout: String(stdout).trim(), stderr: "", status: 0 };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err && err.stderr ? String(err.stderr) : String(err),
      status: err && err.status ? err.status : 1,
    };
  }
}

/**
 * F88 — default per-emitter chain-head reader for the migration record's
 * seq/prev_hash stamping.
 *
 * The migration record MUST extend the emitter's existing coordination-log
 * chain: when the emitter already anchored a `genesis-anchor` (or any prior
 * record), the migration is a CONTINUATION (`seq = head.lastSeq + 1`,
 * `prev_hash = head.lastContentHash`), NOT a fresh `seq:0/prev_hash:null`
 * root. Stamping `seq:0` when a prior record exists triggers fold rule-3
 * fork detection (`coordination-log.js` `_checkRule3`, which runs BEFORE
 * the type-dispatch predicate and is keyed on `(verified_id, seq)` with no
 * genesis-migration exemption) — the legitimate owner would be flagged as a
 * cryptographic equivocator and the trust root would NOT re-anchor. See
 * journal/0172 (F88) for the full defect post-mortem.
 *
 * The reader folds the live log through the SAME engine the migration will
 * later be folded by and reuses `computeOwnChainHead` (the SSOT for rule-2
 * chain-head semantics), so the `prev_hash` it returns is byte-identical to
 * what rule-2 will expect. Reads synchronously to keep performMigration
 * synchronous; an absent / empty log returns null (genuinely-first record →
 * seq:0 is then correct).
 *
 * @param {{cwd: string, roster: object, verifiedId: string}} args
 * @returns {{lastSeq: number, lastContentHash: string} | null}
 */
function _defaultReadChainHead({ cwd, roster, verifiedId }) {
  // eslint-disable-next-line global-require
  const fs = require("fs");
  // eslint-disable-next-line global-require
  const path = require("path");
  // eslint-disable-next-line global-require
  const coordinationLog = require("./coordination-log.js");
  const logPath = path.join(
    cwd,
    ".claude",
    "learning",
    "coordination-log.jsonl",
  );
  let raw;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch (err) {
    // ENOENT → no prior chain (fresh log); any other read error is a real
    // failure the caller MUST see, not silently treat as "fresh" (which
    // would re-introduce the seq:0 fork). Re-throw non-ENOENT.
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
  return coordinationLog.computeOwnChainHead(folded, verifiedId);
}

/**
 * Verify the local repo's root commit per MUST-7 Re-anchor sub-case
 * (4)(a). Returns {ok, sha} or {ok:false, reason, step}.
 *
 * Local root commit = `git rev-list --max-parents=0 HEAD`. If multiple
 * roots exist (octopus history), the command returns multiple lines —
 * reject as ambiguous; the migration ceremony is undefined on multi-root
 * repos.
 */
function _verifyLocalRootCommit(git, cwd, expected) {
  const r = git({ args: ["rev-list", "--max-parents=0", "HEAD"], cwd });
  if (!r || !r.ok) {
    return {
      ok: false,
      step: "4a-local-root-commit",
      reason: `git rev-list --max-parents=0 HEAD failed: ${r && r.stderr ? r.stderr : "unknown"}`,
    };
  }
  const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return {
      ok: false,
      step: "4a-local-root-commit",
      reason: "git rev-list returned no root commit (HEAD has no history)",
    };
  }
  if (lines.length > 1) {
    return {
      ok: false,
      step: "4a-local-root-commit",
      reason: `git rev-list returned ${lines.length} root commits (multi-root history); re-anchor ceremony undefined`,
    };
  }
  const actual = lines[0].trim();
  if (actual !== expected) {
    return {
      ok: false,
      step: "4a-local-root-commit",
      reason: `local root commit ${actual} does not match expected new_root_commit ${expected}`,
    };
  }
  return { ok: true, sha: actual };
}

/**
 * Verify the origin's default-branch root commit matches local per
 * MUST-7 Re-anchor sub-case (4)(d). Closes the residual where an
 * operator running `git filter-repo` between Step 3 capture and the
 * helper invocation could produce a local checkout matching their chosen
 * SHA while remote root diverges. The check is best-effort: if origin
 * is unreachable the helper returns a typed soft-fail so the caller can
 * decide whether to proceed under bounded-trust acceptance OR retry with
 * network available.
 *
 * Returns {ok, sha} | {ok:false, reason, step, soft?:true}.
 */
function _verifyOriginRootCommit(git, cwd, expected, defaultBranch) {
  const refspec = `origin/${defaultBranch}`;
  const r = git({
    args: ["rev-list", "--max-parents=0", refspec],
    cwd,
  });
  if (!r || !r.ok) {
    return {
      ok: false,
      step: "4d-origin-root-commit",
      soft: true,
      reason: `git rev-list --max-parents=0 ${refspec} failed (origin may be unreachable): ${r && r.stderr ? r.stderr : "unknown"}`,
    };
  }
  const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return {
      ok: false,
      step: "4d-origin-root-commit",
      soft: true,
      reason: `git rev-list returned no root commit for ${refspec}`,
    };
  }
  if (lines.length > 1) {
    return {
      ok: false,
      step: "4d-origin-root-commit",
      reason: `${refspec} has ${lines.length} root commits (multi-root history)`,
    };
  }
  const actual = lines[0].trim();
  if (actual !== expected) {
    return {
      ok: false,
      step: "4d-origin-root-commit",
      reason: `origin/${defaultBranch} root commit ${actual} does not match local new_root_commit ${expected} (mid-ceremony git filter-repo divergence — local checkout has been history-rewritten relative to origin)`,
    };
  }
  return { ok: true, sha: actual };
}

/**
 * F86 / MUST-7 — perform a `genesis-migration` ceremony.
 *
 * Two ceremony kinds:
 *
 *   "migration" — relocate the trust root to a new repo owner. Requires
 *     all standard MUST-4 fields PLUS, under N=1 + org-owned, the
 *     MUST-7-mandated structural-equivalent anchor (gh_api_org_membership
 *     capture with role=admin + state=active + fresh per
 *     MIGRATION_LIVENESS_TTL + matched against the sole owner's bound
 *     github_login).
 *
 *   "re-anchor" — correct an existing `genesis.root_commit` pointer to
 *     track the actual repo root. Layered on top of the migration shape:
 *     also requires (a) local root commit verification, (b) gh api
 *     commits/{new_root_commit} verification, (c) origin/<default-branch>
 *     root agreement, and (d) `content.pre_correction_root_commit`
 *     surfacing the old SHA the re-anchor corrects.
 *
 * Routing matrix (per MUST-7 (a)-(g)):
 *
 *   user-owned + N=1   → typed-error ERR_USER_OWNED_N1_BLOCKED
 *   ghes-shared-appliance (host config) → typed-error ERR_GHES_SHARED_APPLIANCE_BLOCKED
 *   org-owned + N=1    → emit canonical N=1 record with
 *                        co_signers:[] + co_sign_anchor_kind discriminator
 *                        + gh_api_org_membership_capture + gh_api_owner_capture
 *                        + signed content covering all of the above
 *   org-owned + N≥2 OR user-owned + N≥2 → typed-error directing caller to
 *                        the 2-of-N path (this helper is N=1-only).
 *
 * @param {object} opts
 * @param {object} opts.roster                 - parsed roster JSON
 * @param {{owner: string, name: string}} opts.repo - source repo identification
 * @param {{owner: string, name: string}} [opts.newRepo] - post-migration repo identification (defaults to opts.repo for re-anchor)
 * @param {string} opts.signingKeyPath         - path to the SSH/GPG signing key
 * @param {string} opts.signingKeyFingerprint  - the verified_id (fingerprint) of the key
 * @param {function} opts.ghApi                - (endpoint: string) => {ok, status, body, error?}
 * @param {function} opts.transportAppend      - (record: object) => {ok, error?}
 * @param {function} [opts.git]                - ({args, cwd}) => {ok, stdout, stderr, status}; defaults to execFileSync
 * @param {string} [opts.cwd]                  - cwd for git invocations; defaults to process.cwd()
 * @param {"migration"|"re-anchor"} opts.kind  - ceremony kind
 * @param {string} [opts.newRootCommit]        - required for kind="re-anchor"; the corrected root SHA
 * @param {string} [opts.preCorrectionRootCommit] - required for kind="re-anchor"; the old SHA being corrected
 * @param {string} [opts.defaultBranch="main"] - origin/<branch> for re-anchor cross-check
 * @param {number} opts.fromGenesisGeneration  - current generation counter
 * @param {number} opts.toGenesisGeneration    - new generation counter (must be > from)
 * @param {string} [opts.host]                 - optional host config token, e.g. "ghes-shared-appliance"
 * @param {function} [opts.now]                - () => ISO-8601 string; defaults to wall clock
 * @param {function} [opts.sign]               - override for coc-sign.sign
 * @param {"ssh"|"gpg"} [opts.keyType]         - signing key type; default "ssh"
 *
 * @returns {{ok: true, record: object} |
 *           {ok: false, error: string, reason: string, step: string}}
 */
function performMigration(opts) {
  const o = opts || {};
  const {
    roster,
    repo,
    signingKeyPath,
    signingKeyFingerprint,
    ghApi,
    transportAppend,
    kind,
    newRootCommit,
    preCorrectionRootCommit,
    fromGenesisGeneration,
    toGenesisGeneration,
    host,
  } = o;
  const newRepo = o.newRepo || o.repo;
  const defaultBranch = o.defaultBranch || "main";
  const cwd = o.cwd || process.cwd();
  const now = o.now || (() => new Date().toISOString());
  const sign = o.sign || defaultSign;
  const keyType = o.keyType || "ssh";
  const git = o.git || _defaultGit;
  // F88 — per-emitter chain-head reader. Injectable for tests; the default
  // folds the live coordination-log so the migration record extends the
  // emitter's chain instead of forking at seq:0. See _defaultReadChainHead.
  const readChainHead = o.readChainHead || _defaultReadChainHead;

  // Step 1: input + roster preflight
  if (kind !== "migration" && kind !== "re-anchor") {
    return {
      ok: false,
      error: "invalid ceremony kind",
      reason: `opts.kind must be "migration" or "re-anchor"; got ${JSON.stringify(kind)}`,
      step: "1-input",
    };
  }
  const rosterErr = _validateRosterForCeremony(roster);
  if (rosterErr) {
    return {
      ok: false,
      error: "roster invalid",
      reason: rosterErr,
      step: "1-input",
    };
  }
  if (!repo || typeof repo !== "object" || !repo.owner || !repo.name) {
    return {
      ok: false,
      error: "repo identification missing",
      reason: "opts.repo MUST be {owner, name}",
      step: "1-input",
    };
  }
  if (!newRepo || !newRepo.owner || !newRepo.name) {
    return {
      ok: false,
      error: "newRepo identification missing",
      reason:
        "opts.newRepo MUST be {owner, name} (defaults to opts.repo for kind=re-anchor)",
      step: "1-input",
    };
  }
  if (
    typeof fromGenesisGeneration !== "number" ||
    !Number.isInteger(fromGenesisGeneration) ||
    typeof toGenesisGeneration !== "number" ||
    !Number.isInteger(toGenesisGeneration)
  ) {
    return {
      ok: false,
      error: "genesis_generation must be integers",
      reason: `from=${fromGenesisGeneration}, to=${toGenesisGeneration}`,
      step: "1-input",
    };
  }
  if (toGenesisGeneration <= fromGenesisGeneration) {
    return {
      ok: false,
      error: "monotonic generation required",
      reason: `genesis_generation must increment monotonically (from=${fromGenesisGeneration}, to=${toGenesisGeneration})`,
      step: "1-input",
    };
  }
  if (!signingKeyPath || !signingKeyFingerprint) {
    return {
      ok: false,
      error: "signing key not configured",
      reason:
        "opts.signingKeyPath + opts.signingKeyFingerprint are required (zero-tolerance.md Rule 3 — no silent fallback)",
      step: "1-input",
    };
  }
  if (typeof ghApi !== "function") {
    return {
      ok: false,
      error: "ghApi callable missing",
      reason: "opts.ghApi must be a function (endpoint) => {ok,status,body}",
      step: "1-input",
    };
  }
  if (typeof transportAppend !== "function") {
    return {
      ok: false,
      error: "transportAppend callable missing",
      reason: "opts.transportAppend must be a function (record) => {ok}",
      step: "1-input",
    };
  }
  if (kind === "re-anchor") {
    if (typeof newRootCommit !== "string" || !newRootCommit) {
      return {
        ok: false,
        error: "newRootCommit required for kind=re-anchor",
        reason: "opts.newRootCommit MUST be the corrected root SHA",
        step: "1-input",
      };
    }
    if (
      typeof preCorrectionRootCommit !== "string" ||
      !preCorrectionRootCommit
    ) {
      return {
        ok: false,
        error: "preCorrectionRootCommit required for kind=re-anchor",
        reason:
          "opts.preCorrectionRootCommit MUST be the old SHA being corrected",
        step: "1-input",
      };
    }
    if (newRootCommit === preCorrectionRootCommit) {
      return {
        ok: false,
        error: "no-op re-anchor",
        reason:
          "newRootCommit === preCorrectionRootCommit; re-anchor would not change the trust root",
        step: "1-input",
      };
    }
  }

  // Validate gh-api endpoint inputs BEFORE interpolation (parity with
  // runEnrollmentCeremony HIGH-3).
  const newOwnerValid = githubLogin.validateGithubLogin(newRepo.owner);
  if (!newOwnerValid.valid) {
    return {
      ok: false,
      error: "newRepo.owner invalid",
      reason: `newRepo.owner ${newOwnerValid.reason}`,
      step: "1-input",
    };
  }
  const newNameValid = githubLogin.validateGithubRepoName(newRepo.name);
  if (!newNameValid.valid) {
    return {
      ok: false,
      error: "newRepo.name invalid",
      reason: `newRepo.name ${newNameValid.reason}`,
      step: "1-input",
    };
  }

  // Step 2: route by repo_owner_kind + host config. The user-owned and
  // ghes-shared-appliance blocks are STRUCTURAL — they fire before any
  // network call so the typed error is reachable offline.
  const repoOwnerKind = roster.genesis.repo_owner_kind;
  if (host === "ghes-shared-appliance") {
    return {
      ok: false,
      error: "ghes-shared-appliance blocked",
      reason: ERR_GHES_SHARED_APPLIANCE_BLOCKED,
      step: "2-route",
    };
  }
  if (repoOwnerKind === "user") {
    return {
      ok: false,
      error: "user-owned N=1 blocked",
      reason: ERR_USER_OWNED_N1_BLOCKED,
      step: "2-route",
    };
  }
  if (repoOwnerKind !== "org") {
    return {
      ok: false,
      error: "unknown repo_owner_kind",
      reason: `roster.genesis.repo_owner_kind must be "user" or "org"; got "${repoOwnerKind}"`,
      step: "2-route",
    };
  }

  // Step 3: resolve the sole owner (N=1 gate).
  const owner = _resolveSoleOwner(roster);
  if (!owner.ok) {
    return {
      ok: false,
      error: "sole-owner resolution failed",
      reason: owner.reason,
      step: "3-sole-owner",
    };
  }
  if (
    !owner.person ||
    typeof owner.person.github_login !== "string" ||
    !owner.person.github_login
  ) {
    return {
      ok: false,
      error: "sole owner missing github_login",
      reason: `roster.persons[${owner.person_id}].github_login is missing or empty; cannot bind org-admin attestation`,
      step: "3-sole-owner",
    };
  }
  // The signing fingerprint MUST belong to the sole owner.
  const signingKey = _findSigningKey(owner.person, signingKeyFingerprint);
  if (!signingKey) {
    return {
      ok: false,
      error: "signing key not the sole owner's enrolled key",
      reason: `signing fingerprint ${signingKeyFingerprint} is not enrolled under the sole owner person_id ${owner.person_id}`,
      step: "3-sole-owner",
    };
  }
  const adminLogin = owner.person.github_login;
  const adminValid = githubLogin.validateGithubLogin(adminLogin);
  if (!adminValid.valid) {
    return {
      ok: false,
      error: "sole owner github_login invalid",
      reason: `sole owner github_login ${adminValid.reason}`,
      step: "3-sole-owner",
    };
  }

  // Step 4 (re-anchor only): local + origin root-commit verification.
  if (kind === "re-anchor") {
    const local = _verifyLocalRootCommit(git, cwd, newRootCommit);
    if (!local.ok) {
      return {
        ok: false,
        error: "local root-commit verification failed",
        reason: local.reason,
        step: local.step,
      };
    }
    const remote = _verifyOriginRootCommit(
      git,
      cwd,
      newRootCommit,
      defaultBranch,
    );
    if (!remote.ok) {
      return {
        ok: false,
        error: "origin root-commit verification failed",
        reason: remote.reason,
        step: remote.step,
        ...(remote.soft ? { soft: true } : {}),
      };
    }
  }

  // Step 5: capture fresh gh api repos/{owner}/{repo} — the
  // post-migration external-owner check.
  let ownerCapture;
  try {
    const r = ghApi(`repos/${newRepo.owner}/${newRepo.name}`);
    if (!r || !r.ok) {
      return {
        ok: false,
        error: "gh api repos call failed",
        reason: `gh api repos/${newRepo.owner}/${newRepo.name} → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
        step: "5-gh-api-owner",
      };
    }
    if (!r.body || !r.body.owner || typeof r.body.owner.login !== "string") {
      return {
        ok: false,
        error: "gh api repos response malformed",
        reason: `expected body.owner.login; got ${JSON.stringify(r.body)}`,
        step: "5-gh-api-owner",
      };
    }
    if (!githubLogin.loginsEqual(r.body.owner.login, newRepo.owner)) {
      return {
        ok: false,
        error: "owner_mismatch",
        reason: `gh api owner mismatch: newRepo.owner '${newRepo.owner}', gh api returned '${r.body.owner.login}'`,
        step: "5-gh-api-owner",
      };
    }
    ownerCapture = ghApiAllowlist._allowlistRepoOwner(r.body, {
      capture_ts: now(),
    });
  } catch (err) {
    return {
      ok: false,
      error: "gh api repos call threw",
      reason: `network unavailable or ghApi threw: ${err && err.message ? err.message : String(err)}`,
      step: "5-gh-api-owner",
    };
  }

  // Step 6: capture fresh gh api orgs/{org}/memberships/{adminLogin} —
  // the structural-equivalent anchor under N=1. Per MUST-7 (c): role
  // MUST be "admin" + state MUST be "active".
  let orgMembershipCapture;
  try {
    const r = ghApi(`orgs/${newRepo.owner}/memberships/${adminLogin}`);
    if (!r || !r.ok) {
      return {
        ok: false,
        error: "org membership check failed",
        reason: `gh api orgs/${newRepo.owner}/memberships/${adminLogin} → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
        step: "6-org-admin",
      };
    }
    if (!r.body || r.body.role !== "admin") {
      return {
        ok: false,
        error: "not an org admin",
        reason: `gh api orgs/${newRepo.owner}/memberships/${adminLogin} role is '${r.body && r.body.role}', not 'admin'`,
        step: "6-org-admin",
      };
    }
    if (r.body.state !== "active") {
      return {
        ok: false,
        error: "org membership not active",
        reason: `gh api orgs/${newRepo.owner}/memberships/${adminLogin} state is '${r.body.state}', not 'active'`,
        step: "6-org-admin",
      };
    }
    orgMembershipCapture = ghApiAllowlist._allowlistOrgMembership(r.body, {
      capture_ts: now(),
    });
  } catch (err) {
    return {
      ok: false,
      error: "org membership call threw",
      reason: `network unavailable or ghApi threw: ${err && err.message ? err.message : String(err)}`,
      step: "6-org-admin",
    };
  }

  // Step 7 (re-anchor only): capture fresh gh api
  // commits/{new_root_commit} — independent gh-api anchor for the
  // corrected root commit per MUST-7 Re-anchor sub-case (4)(b).
  let rootCommitCapture = null;
  if (kind === "re-anchor") {
    try {
      const r = ghApi(
        `repos/${newRepo.owner}/${newRepo.name}/commits/${newRootCommit}`,
      );
      if (!r || !r.ok) {
        return {
          ok: false,
          error: "gh api commits call failed",
          reason: `gh api commits/${newRootCommit} → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
          step: "7-root-commit",
        };
      }
      const body = r.body || {};
      const commit = body.commit || {};
      const verification = commit.verification || {};
      // Org-owned bootstrap relaxation (issue #358 sibling): under the
      // N=1 org-admin path, the verified-active admin attestation
      // captured at Step 6 substitutes as the verified-identity anchor
      // for the trust root — exactly the same shape as enrollment.
      // We still RECORD verification.verified faithfully so an auditor
      // sees the ceremony proceeded under the org-admin path even if
      // the root commit itself was unsigned (typical for filter-repo
      // rewrites).
      void verification;
      rootCommitCapture = ghApiAllowlist._allowlistCommitVerification(body, {
        capture_ts: now(),
      });
    } catch (err) {
      return {
        ok: false,
        error: "gh api commits call threw",
        reason: `network unavailable or ghApi threw: ${err && err.message ? err.message : String(err)}`,
        step: "7-root-commit",
      };
    }
  }

  // Step 8: build canonical content, sign, append.
  //
  // Field-name convention for the N=1 path follows MUST-7 spec literally:
  //   - gh_api_owner_capture (matches genesis-anchor convention)
  //   - gh_api_org_membership_capture (matches enrollment convention)
  //   - co_sign_anchor_kind (discriminator MUST-7 (e))
  //   - co_signers: [] (MUST-7 (b))
  //   - new_repo_owner / new_repo_owner_kind (fold-rule-9c match surface)
  //   - from_genesis_generation / to_genesis_generation (fold-rule-9c)
  //
  // Per MUST-7 (f): the primary signature MUST cover the entire content
  // block including co_signers, co_sign_anchor_kind, and BOTH captures.
  // canonicalSerialize over recordCore (with sig absent) is exactly that.
  const content = {
    new_repo_owner: newRepo.owner,
    new_repo_owner_kind: "org",
    from_genesis_generation: fromGenesisGeneration,
    to_genesis_generation: toGenesisGeneration,
    co_signers: [],
    co_sign_anchor_kind: CO_SIGN_ANCHOR_KIND_ORG_ADMIN,
    gh_api_owner_capture: ownerCapture,
    gh_api_org_membership_capture: orgMembershipCapture,
  };
  if (kind === "re-anchor") {
    content.pre_correction_root_commit = preCorrectionRootCommit;
    content.gh_api_root_commit_capture = rootCommitCapture;
  }

  // F88 — stamp seq/prev_hash as a chain-continuation off the emitter's
  // current chain head. Hardcoding seq:0/prev_hash:null (the pre-F88 bug)
  // forks against an existing genesis-anchor at the same (verified_id, seq=0)
  // — fold rule-3 rejects the record AND flags the owner as an equivocator,
  // and the trust root never re-anchors. The head is derived from the live
  // log via the same engine + SSOT the fold will use, so prev_hash matches
  // rule-2 byte-for-byte. A null head (genuinely-first record, fresh log)
  // correctly yields seq:0/prev_hash:null. See journal/0172.
  let chainHead;
  try {
    chainHead = readChainHead({
      cwd,
      roster,
      verifiedId: signingKeyFingerprint,
    });
  } catch (err) {
    return {
      ok: false,
      error: "chain-head read failed",
      reason: `readChainHead threw (coordination-log unreadable; refusing to fall back to seq:0 which would fork): ${err && err.message ? err.message : String(err)}`,
      step: "8-chain-head",
    };
  }
  const recordSeq = chainHead ? chainHead.lastSeq + 1 : 0;
  const recordPrevHash = chainHead ? chainHead.lastContentHash : null;

  const recordCore = {
    type: "genesis-migration",
    verified_id: signingKeyFingerprint,
    person_id: owner.person_id,
    seq: recordSeq,
    prev_hash: recordPrevHash,
    ts: now(),
    content,
  };

  let bytes;
  try {
    bytes = cocSign.canonicalSerialize(recordCore);
  } catch (err) {
    return {
      ok: false,
      error: "canonicalSerialize threw",
      reason: err && err.message ? err.message : String(err),
      step: "8-serialize",
    };
  }

  const signResult = sign(bytes, { keyType, keyPath: signingKeyPath });
  if (!signResult || !signResult.ok) {
    return {
      ok: false,
      error: signResult && signResult.error ? signResult.error : "sign failed",
      reason: signResult && signResult.reason ? signResult.reason : "unknown",
      step: "8-sign",
    };
  }
  const record = Object.assign({}, recordCore, { sig: signResult.sig });

  const appendResult = transportAppend(record);
  if (!appendResult || !appendResult.ok) {
    return {
      ok: false,
      error: "transport append failed",
      reason:
        appendResult && appendResult.error
          ? appendResult.error
          : "unknown transport append error",
      step: "8-append",
    };
  }

  return { ok: true, record };
}

module.exports = {
  runEnrollmentCeremony,
  performMigration,
  // F86 / MUST-7 typed-error tokens exported so callers can pattern-match
  // structural-block paths without re-deriving the strings.
  ERR_USER_OWNED_N1_BLOCKED,
  ERR_GHES_SHARED_APPLIANCE_BLOCKED,
  _internal: {
    _validateRosterForCeremony,
    _resolveGenesisOwner,
    _findSigningKey,
    _resolveSoleOwner,
    _verifyLocalRootCommit,
    _verifyOriginRootCommit,
  },
};
