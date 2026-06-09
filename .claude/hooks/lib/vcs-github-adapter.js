/**
 * vcs-github-adapter — the GitHub provider adapter.
 *
 * A THIN wrapper over the EXACT endpoint strings + response-shape parsing +
 * allowlist functions the ceremony helpers (`genesis-ceremony.js` et al.)
 * used inline before the provider-adapter refactor. The load-bearing
 * invariant: this adapter is BEHAVIOR-IDENTICAL to the prior inline gh-api
 * code, so GitHub ceremony records remain byte-for-byte unchanged.
 *
 * The injected `transport` is the existing `ghApi` callable:
 *   (endpoint: string) => { ok, status, body, error? }   (wraps `gh api <endpoint>`)
 *
 * repoRef shape for GitHub: { owner: string, name: string }.
 * principal for GitHub: a github_login (string).
 *
 * Return contract (uniform across all provider adapters; the ceremony +
 * fold consume this neutral shape):
 *   fetchRepoOwner  → { ok, ownerPrincipal, capture } | { ok:false, error, reason, status?, body? }
 *   fetchOrgAdmin   → { ok, role, state, userPrincipal, orgPrincipal, capture } | { ok:false, ... }
 *   fetchCommitVerification → { ok, verified, authorPrincipal, authorName, capture } | { ok:false, ... }
 *   listCollaborators → { ok, capture } | { ok:false, ... }
 *
 * Style: CommonJS, zero-dep. No subprocess here — transport is injected.
 */

"use strict";

const githubLogin = require("./github-login.js");
const ghAllow = require("./gh-api-allowlist.js");

const providerId = "github";

// Outer record-content field names for GitHub records. These are the
// EXISTING names so GitHub records stay byte-identical (and so fold-rule-9c /
// fold-genesis-anchor read them unchanged when content.provider is absent).
const captureFieldNames = {
  owner: "gh_api_owner_capture",
  // 2-of-N migration path uses the legacy `gh_api_repo_owner_capture` name;
  // the N=1 + genesis-anchor paths use `gh_api_owner_capture`. The ceremony
  // selects per-path; this map names the canonical (N=1/anchor) field.
  migrationRepoOwner: "gh_api_repo_owner_capture",
  orgAdmin: "gh_api_org_membership_capture",
  rootCommit: "gh_api_root_commit_capture",
  collaborators: "gh_api_collaborators_capture",
};

function validateRepoRef(ref) {
  if (!ref || typeof ref !== "object") {
    return { valid: false, reason: "repoRef must be an object" };
  }
  const o = githubLogin.validateGithubLogin(ref.owner);
  if (!o.valid) return { valid: false, reason: `repoRef.owner ${o.reason}` };
  const n = githubLogin.validateGithubRepoName(ref.name);
  if (!n.valid) return { valid: false, reason: `repoRef.name ${n.reason}` };
  return { valid: true };
}

function validatePrincipal(s) {
  return githubLogin.validateGithubLogin(s);
}

function principalsEqual(a, b) {
  return githubLogin.loginsEqual(a, b);
}

function _fail(error, reason, extra) {
  return Object.assign({ ok: false, error, reason }, extra || {});
}

/**
 * gh api repos/{owner}/{repo} → external owner login.
 */
function fetchRepoOwner(transport, repoRef, opts) {
  const captureTs = (opts && opts.capture_ts) || new Date().toISOString();
  let r;
  try {
    r = transport(`repos/${repoRef.owner}/${repoRef.name}`);
  } catch (err) {
    return _fail(
      "gh api repos call threw",
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "gh api repos call failed",
      `gh api repos/${repoRef.owner}/${repoRef.name} → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  if (!r.body || !r.body.owner || typeof r.body.owner.login !== "string") {
    return _fail(
      "gh api repos response malformed",
      `expected body.owner.login; got ${JSON.stringify(r.body)}`,
    );
  }
  const capture = ghAllow._allowlistRepoOwner(r.body, {
    capture_ts: captureTs,
  });
  return { ok: true, ownerPrincipal: r.body.owner.login, capture };
}

/**
 * gh api orgs/{org}/memberships/{login} → role + state.
 */
function fetchOrgAdmin(transport, repoRef, principal, opts) {
  const captureTs = (opts && opts.capture_ts) || new Date().toISOString();
  const org = repoRef.owner;
  let r;
  try {
    r = transport(`orgs/${org}/memberships/${principal}`);
  } catch (err) {
    return _fail(
      "org membership call threw",
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "org membership check failed",
      `gh api orgs/${org}/memberships/${principal} → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  if (!r.body || typeof r.body.role !== "string") {
    return _fail(
      "org membership response malformed",
      `expected body.role; got ${JSON.stringify(r.body)}`,
    );
  }
  const capture = ghAllow._allowlistOrgMembership(r.body, {
    capture_ts: captureTs,
  });
  return {
    ok: true,
    role: r.body.role,
    state: r.body.state,
    userPrincipal: r.body.user && r.body.user.login,
    orgPrincipal: r.body.organization && r.body.organization.login,
    capture,
  };
}

/**
 * gh api repos/{owner}/{repo}/commits/{sha} → verification.verified + author.
 */
function fetchCommitVerification(transport, repoRef, sha, opts) {
  // F122 R2 LOW defense-in-depth (symmetric with vcs-azure-adapter.js): shape-
  // guard the endpoint-interpolated sha at the primitive, matching the fold-
  // layer bound /^[0-9a-f]{7,64}$/. sha originates internally (git rev-list
  // root) on every current caller, but the guard closes the injection class
  // for any future reusable-primitive caller.
  if (typeof sha !== "string" || !/^[0-9a-f]{7,64}$/.test(sha)) {
    return _fail(
      "gh commit sha invalid",
      `sha must match /^[0-9a-f]{7,64}$/ (commit-hash shape); got ${JSON.stringify(sha)}`,
    );
  }
  const captureTs = (opts && opts.capture_ts) || new Date().toISOString();
  let r;
  try {
    r = transport(`repos/${repoRef.owner}/${repoRef.name}/commits/${sha}`);
  } catch (err) {
    return _fail(
      "gh api commits call threw",
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "gh api root-commit call failed",
      `gh api commits/${sha} → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  const body = r.body || {};
  const commit = body.commit || {};
  const verification = commit.verification || {};
  const capture = ghAllow._allowlistCommitVerification(body, {
    capture_ts: captureTs,
  });
  return {
    ok: true,
    verified: verification.verified === true,
    verificationReason: verification.reason,
    authorPrincipal: body.author && body.author.login,
    authorName: commit.author && commit.author.name,
    capture,
  };
}

/**
 * gh api repos/{owner}/{repo}/collaborators → admin-permission members.
 */
function listCollaborators(transport, repoRef, opts) {
  const captureTs = (opts && opts.capture_ts) || new Date().toISOString();
  let r;
  try {
    r = transport(`repos/${repoRef.owner}/${repoRef.name}/collaborators`);
  } catch (err) {
    return _fail(
      "gh api collaborators call threw",
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "gh api collaborators call failed",
      `gh api repos/${repoRef.owner}/${repoRef.name}/collaborators → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  if (!Array.isArray(r.body)) {
    return _fail(
      "gh api collaborators response malformed",
      `expected array body; got ${JSON.stringify(r.body)}`,
    );
  }
  const capture = ghAllow._allowlistCollaboratorsList(r.body, {
    capture_ts: captureTs,
  });
  return { ok: true, capture };
}

/**
 * R5-S-07 distinct-bound-collaborator predicate (delegates to the existing
 * gh-api-allowlist implementation — byte-identical behavior).
 */
function verifyDistinctBoundPrincipals(primary, cosigner, capture) {
  return ghAllow._verifyDistinctBoundCollaborators(primary, cosigner, capture);
}

module.exports = {
  providerId,
  captureFieldNames,
  validateRepoRef,
  validatePrincipal,
  principalsEqual,
  fetchRepoOwner,
  fetchOrgAdmin,
  fetchCommitVerification,
  listCollaborators,
  verifyDistinctBoundPrincipals,
};
