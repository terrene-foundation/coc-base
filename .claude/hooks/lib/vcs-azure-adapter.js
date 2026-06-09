/**
 * vcs-azure-adapter — the Azure DevOps provider adapter.
 *
 * The ADO sibling of `vcs-github-adapter.js`. Same uniform return contract;
 * ADO-specific endpoint construction + the `ado-api-allowlist.js` shapers.
 * Emits the SAME canonical capture inner shapes, so the fold predicates stay
 * provider-neutral below the `content.provider` dispatch point.
 *
 * Transport contract (the ADO analogue of GitHub's `ghApi(endpointString)`):
 *   (req: { service: "core"|"graph", path: string, meta?: object })
 *     => { ok, status, body, error? }
 *
 *   - service "core"  → dev.azure.com REST (repos, commits)
 *   - service "graph" → vssps.dev.azure.com Graph REST (members, PCA membership)
 *   The production transport (see the ADO runbook,
 *   guides/co-setup/11-genesis-ceremony.md § Azure DevOps) binds the right
 *   host + api-version + PAT/Entra auth. The adapter constructs the path it
 *   needs; it does NOT hardcode unverified Graph response parsing (per
 *   `rules/verify-resource-existence.md` MUST-2 — the live-API mapping is the
 *   operator-verified runbook's job, not gospel baked into the adapter).
 *
 * repoRef shape for ADO: { org: string, project: string, repo: string }.
 * principal for ADO: an Entra userPrincipalName (string).
 *
 * Provider-semantics residuals (documented in `ado-api-allowlist.js` header
 * + `multi-operator-coordination.md` MUST-5 ADO clause): owner-check is
 * "server confirms existence under the auth-scoped org" (not server-asserts-
 * owner); commit signature verification is unavailable on ADO (verified is
 * always false → ADO anchors via the org-admin attestation path).
 *
 * Style: CommonJS, zero-dep. No subprocess here — transport is injected.
 */

"use strict";

const adoLogin = require("./ado-login.js");
const adoAllow = require("./ado-api-allowlist.js");

const providerId = "azure-devops";

// Outer record-content field names for ADO records. Distinct from the
// GitHub `gh_api_*` names so an ADO record is honestly named AND the fold's
// `content.provider === "azure-devops"` dispatch reads the matching field.
const captureFieldNames = {
  owner: "ado_api_owner_capture",
  migrationRepoOwner: "ado_api_owner_capture",
  orgAdmin: "ado_api_org_admin_capture",
  rootCommit: "ado_api_root_commit_capture",
  collaborators: "ado_api_members_capture",
};

const API_VERSION = "7.1";

function validateRepoRef(ref) {
  if (!ref || typeof ref !== "object") {
    return { valid: false, reason: "repoRef must be an object" };
  }
  const o = adoLogin.validateAdoOrg(ref.org);
  if (!o.valid) return { valid: false, reason: `repoRef.org ${o.reason}` };
  const p = adoLogin.validateAdoProject(ref.project);
  if (!p.valid) return { valid: false, reason: `repoRef.project ${p.reason}` };
  const r = adoLogin.validateAdoRepo(ref.repo);
  if (!r.valid) return { valid: false, reason: `repoRef.repo ${r.reason}` };
  return { valid: true };
}

function validatePrincipal(s) {
  return adoLogin.validatePrincipal(s);
}

function principalsEqual(a, b) {
  return adoLogin.principalsEqual(a, b);
}

function _fail(error, reason, extra) {
  return Object.assign({ ok: false, error, reason }, extra || {});
}

/**
 * ADO: confirm the repo exists under the auth-scoped org.
 * core: {org}/{project}/_apis/git/repositories/{repo}?api-version=7.1
 */
function fetchRepoOwner(transport, repoRef, opts) {
  // F122 R1 LOW-1 defense-in-depth: self-guard the repoRef at the primitive,
  // not only at the caller — a future reusable-primitive caller that forgets
  // validateRepoRef otherwise gets endpoint injection. Idempotent: current
  // callers already validate, so a valid ref returns unchanged.
  const _rv = validateRepoRef(repoRef);
  if (!_rv.valid) return _fail("ado repoRef invalid", _rv.reason);
  const captureTs = (opts && opts.capture_ts) || new Date().toISOString();
  const { org, project, repo } = repoRef;
  let r;
  try {
    r = transport({
      service: "core",
      path: `${org}/${project}/_apis/git/repositories/${repo}?api-version=${API_VERSION}`,
    });
  } catch (err) {
    return _fail(
      "ado repo call threw",
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "ado repo call failed",
      `ADO git/repositories/${repo} → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  if (
    !r.body ||
    typeof r.body !== "object" ||
    typeof r.body.name !== "string"
  ) {
    return _fail(
      "ado repo response malformed",
      `expected body.name (repo existence corroboration); got ${JSON.stringify(r.body)}`,
    );
  }
  // Canonical owner.login = the request-side, auth-scoped org (ADO residual:
  // owner is in the URL, not the body — see ado-api-allowlist.js header).
  const capture = adoAllow._allowlistAdoRepoOwner(r.body, {
    org,
    capture_ts: captureTs,
  });
  return { ok: true, ownerPrincipal: org, capture };
}

/**
 * ADO: resolve whether `principal` is an active Project Collection
 * Administrator of the org.
 *
 * graph (semantic): {org}/_apis/graph/admin-membership?principal=<upn>
 *
 * The production transport implements the multi-step ADO Graph resolution
 * and returns the DETERMINATION shape:
 *   { role: "admin"|"member", state: "active"|<other>,
 *     user: { login: <upn> }, organization: { login: <org> } }
 *
 * Documented Graph sequence the production transport MUST implement (the
 * operator verifies this against live ADO per verify-resource-existence.md):
 *   1. GET vssps {org}/_apis/graph/users?subjectTypes=aad → user descriptor
 *      whose principalName matches <upn>.
 *   2. GET vssps {org}/_apis/graph/groups → "Project Collection
 *      Administrators" group descriptor.
 *   3. GET vssps {org}/_apis/graph/memberships/{userDescriptor}?direction=up
 *      → role="admin" iff the PCA group descriptor is in the membership set;
 *      state="active" iff the user's storage-key membership is active.
 */
function fetchOrgAdmin(transport, repoRef, principal, opts) {
  // F122 R1 LOW-1 defense-in-depth (see fetchRepoOwner).
  const _rv = validateRepoRef(repoRef);
  if (!_rv.valid) return _fail("ado repoRef invalid", _rv.reason);
  const captureTs = (opts && opts.capture_ts) || new Date().toISOString();
  const { org } = repoRef;
  let r;
  try {
    r = transport({
      service: "graph",
      path: `${org}/_apis/graph/admin-membership?api-version=${API_VERSION}-preview.1`,
      meta: { principal, org },
    });
  } catch (err) {
    return _fail(
      "ado org-admin call threw",
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "ado org-admin check failed",
      `ADO graph admin-membership(${org}, ${principal}) → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  if (!r.body || typeof r.body.role !== "string") {
    return _fail(
      "ado org-admin response malformed",
      `expected determination body.role; got ${JSON.stringify(r.body)}`,
    );
  }
  const capture = adoAllow._allowlistAdoOrgAdmin(r.body, {
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
 * ADO: capture the root commit. ADO exposes NO signature verification, so
 * `verified` is always false (the org-admin attestation is the anchor).
 * core: {org}/{project}/_apis/git/repositories/{repo}/commits/{sha}?api-version=7.1
 */
function fetchCommitVerification(transport, repoRef, sha, opts) {
  // F122 R1 LOW-1 defense-in-depth (see fetchRepoOwner).
  const _rv = validateRepoRef(repoRef);
  if (!_rv.valid) return _fail("ado repoRef invalid", _rv.reason);
  // F122 R2 LOW defense-in-depth: shape-guard the only other endpoint-
  // interpolated parameter (sha) at the primitive, matching the fold-layer
  // bound (fold-rule-9c.js re-anchor sha-shape /^[0-9a-f]{7,64}$/). sha
  // originates internally (git rev-list root), but a future caller passing an
  // unbounded value would otherwise interpolate it into the REST path.
  if (typeof sha !== "string" || !/^[0-9a-f]{7,64}$/.test(sha)) {
    return _fail(
      "ado commit sha invalid",
      `sha must match /^[0-9a-f]{7,64}$/ (commit-hash shape); got ${JSON.stringify(sha)}`,
    );
  }
  const captureTs = (opts && opts.capture_ts) || new Date().toISOString();
  const { org, project, repo } = repoRef;
  let r;
  try {
    r = transport({
      service: "core",
      path: `${org}/${project}/_apis/git/repositories/${repo}/commits/${sha}?api-version=${API_VERSION}`,
    });
  } catch (err) {
    return _fail(
      "ado commit call threw",
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "ado commit call failed",
      `ADO commits/${sha} → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  const capture = adoAllow._allowlistAdoCommitVerification(r.body || {}, {
    capture_ts: captureTs,
  });
  return {
    ok: true,
    // ADO never returns a verified signature — honestly false. The ceremony
    // anchors ADO via the org-admin attestation (org-bootstrap relaxation).
    verified: false,
    verificationReason: adoAllow.ADO_COMMIT_UNVERIFIED_REASON,
    authorPrincipal: null,
    authorName: (r.body && r.body.author && r.body.author.name) || undefined,
    capture,
  };
}

/**
 * ADO: list the org/collection members (for distinctness attestation).
 * graph (semantic): {org}/_apis/graph/members → [{login:<upn>, isAdmin}]
 */
function listCollaborators(transport, repoRef, opts) {
  // F122 R1 LOW-1 defense-in-depth (see fetchRepoOwner).
  const _rv = validateRepoRef(repoRef);
  if (!_rv.valid) return _fail("ado repoRef invalid", _rv.reason);
  const captureTs = (opts && opts.capture_ts) || new Date().toISOString();
  const { org } = repoRef;
  let r;
  try {
    r = transport({
      service: "graph",
      path: `${org}/_apis/graph/members?api-version=${API_VERSION}-preview.1`,
      meta: { org },
    });
  } catch (err) {
    return _fail(
      "ado members call threw",
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "ado members call failed",
      `ADO graph members(${org}) → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  if (!Array.isArray(r.body)) {
    return _fail(
      "ado members response malformed",
      `expected determination array body [{login,isAdmin}]; got ${JSON.stringify(r.body)}`,
    );
  }
  const capture = adoAllow._allowlistAdoMembers(r.body, {
    capture_ts: captureTs,
  });
  return { ok: true, capture };
}

/**
 * R5-S-07 distinct-bound-principal predicate (ADO principalsEqual variant).
 */
function verifyDistinctBoundPrincipals(primary, cosigner, capture) {
  return adoAllow._verifyDistinctBoundMembers(primary, cosigner, capture);
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
