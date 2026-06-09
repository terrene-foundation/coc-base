/**
 * ado-api-allowlist — response-capture allowlists for Azure DevOps ceremony
 * captures. The ADO sibling of `gh-api-allowlist.js`.
 *
 * Design contract (THE load-bearing invariant of this module):
 *   Every allowlist here emits the SAME canonical INNER shape its
 *   gh-api-allowlist.js counterpart emits, so the provider-neutral fold
 *   predicates (`fold-rule-9c.js`, `fold-genesis-anchor.js`) consume ONE
 *   shape regardless of provider. Only the OUTER record-content field name
 *   differs by provider (`gh_api_*` vs `ado_api_*`) — the fold dispatches on
 *   `content.provider` (absent ⇒ github) and reads the matching field, then
 *   runs the identical inner predicates (role==="admin", state==="active",
 *   verified===true|relaxed, principal distinctness, freshness).
 *
 *   Canonical inner shapes (byte-for-byte the gh-api-allowlist.js shapes):
 *     owner       → { owner: { login }, name, full_name, capture_ts }
 *     org-admin   → { role, state, user: { login }, organization: { login }, capture_ts }
 *     commit      → { sha, commit: { author: {name,email,date},
 *                     verification: { verified, reason } },
 *                     author: { login }, capture_ts }
 *     members     → { collaborators: [{ login, permissions:{admin,push} }], capture_ts }
 *
 *   `login` carries the ADO-side principal: the ORG name for owner.login /
 *   organization.login, the Entra UPN for user.login / author.login /
 *   collaborators[].login. The inner KEY stays `login`/`collaborators` (not
 *   `principal`/`members`) precisely so the fold predicates need no
 *   per-provider branching below the dispatch point.
 *
 * Provider-semantics differences (documented residuals — surfaced honestly,
 * NOT papered over):
 *
 *   1. Owner check. GitHub's `repos/{owner}/{repo}` response asserts the
 *      owner server-side (`body.owner.login`). Azure DevOps carries the org
 *      in the REST URL, not the body — a 200 from
 *      `{org}/{project}/_apis/git/repositories/{repo}` confirms the
 *      authenticated caller can reach the repo UNDER the asserted org. The
 *      allowlist therefore stamps `owner.login` from the REQUEST-side org
 *      (passed via opts.org), and records the repo id/name the server DID
 *      return as corroboration. Threat-model note: ADO owner-verification is
 *      "server confirms existence under the asserted, auth-scoped org",
 *      where GitHub's is "server asserts the owner". The PAT/auth being
 *      org-scoped is what makes the 200 meaningful. (ADO residual — see
 *      `multi-operator-coordination.md` MUST-5 ADO clause.)
 *
 *   2. Commit signature verification. Azure DevOps does NOT expose a
 *      `commit.verification.verified` field — the ADO commits API returns no
 *      GPG/SSH signature-verification result. The allowlist records
 *      `verified: false` + `reason: "ado-no-api-commit-signature-verification"`
 *      faithfully; the ADO enrollment ceremony therefore anchors via the
 *      org-admin attestation (the issue #358 org-bootstrap relaxation path),
 *      NOT via root-commit signature. (ADO residual.)
 *
 *   3. Org admin. ADO has no `orgs/{org}/memberships/{login}` endpoint. The
 *      adapter computes `role: "admin"` from Project Collection
 *      Administrators group membership (ADO Graph API) and passes the
 *      already-determined `{role, state, user, organization}` shape here for
 *      validation + stripping. `state: "active"` is set by the adapter when
 *      the resolved membership is active.
 *
 * Replay defense (M3 HIGH-4 parity): every shape preserves + requires
 * capture_ts; the provider-neutral `_isCaptureFresh` (re-exported from
 * gh-api-allowlist.js) enforces freshness at fold time.
 *
 * Style: CommonJS, zero-dep, pure functions. No I/O.
 */

"use strict";

const { principalsEqual } = require("./ado-login.js");
// Freshness predicate + ceilings are PROVIDER-NEUTRAL (they operate on
// capture_ts only). Re-use the single implementation; do NOT fork it. The
// `GH_`-prefixed constant name is historical — the value is a generic
// ceremony-capture freshness ceiling, not GitHub-specific.
const {
  _isCaptureFresh,
  GH_API_CAPTURE_FRESHNESS_MS,
  MIGRATION_LIVENESS_TTL,
} = require("./gh-api-allowlist.js");

const ADO_COMMIT_UNVERIFIED_REASON = "ado-no-api-commit-signature-verification";

/** Strip keys whose value is exactly `undefined` (null preserved). */
function _omitUndefined(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function _captureTs(opts) {
  return (
    (opts && typeof opts.capture_ts === "string" && opts.capture_ts) ||
    new Date().toISOString()
  );
}

/**
 * Allowlist for the ADO repo-existence / owner capture.
 *
 * ADO source: `GET {org}/{project}/_apis/git/repositories/{repo}` → body
 * carries `{id, name, project:{id,name}, ...}` but NOT the org (the org is
 * in the URL). The adapter passes the request-side org via opts.org; that
 * org becomes the canonical `owner.login` (the ADO analogue of GitHub's
 * server-asserted owner).
 *
 * @param {object} body - the ADO repo response body (raw)
 * @param {object} opts - { org: string (REQUIRED — the request-side org),
 *                          capture_ts?: string }
 */
function _allowlistAdoRepoOwner(body, opts) {
  if (!body || typeof body !== "object") return body;
  const org = opts && typeof opts.org === "string" ? opts.org : null;
  const repoName = typeof body.name === "string" ? body.name : null;
  const projectName =
    body.project && typeof body.project.name === "string"
      ? body.project.name
      : null;
  const out = {
    // Canonical owner.login = the ADO org (request-side, auth-scoped).
    owner: org ? { login: org } : null,
  };
  if (repoName !== null) out.name = repoName;
  // full_name mirrors GitHub's `owner/repo` — here `org/project/repo`.
  if (org && projectName && repoName) {
    out.full_name = `${org}/${projectName}/${repoName}`;
  }
  out.capture_ts = _captureTs(opts);
  return out;
}

/**
 * Allowlist for the ADO org-admin determination.
 *
 * The adapter resolves PCA membership (ADO Graph) and passes the
 * already-determined `{role, state, user:{login}, organization:{login}}`
 * shape. This function validates + strips it to the canonical inner shape
 * identical to gh-api-allowlist.js `_allowlistOrgMembership`.
 *
 * @param {object} determined - { role, state, user:{login}, organization:{login} }
 * @param {object} [opts] - { capture_ts?: string }
 */
function _allowlistAdoOrgAdmin(determined, opts) {
  if (!determined || typeof determined !== "object") return determined;
  const out = _omitUndefined({
    role: determined.role,
    state: determined.state,
  });
  out.user =
    determined.user && typeof determined.user.login === "string"
      ? { login: determined.user.login }
      : null;
  out.organization =
    determined.organization && typeof determined.organization.login === "string"
      ? { login: determined.organization.login }
      : null;
  out.capture_ts = _captureTs(opts);
  return out;
}

/**
 * Allowlist for the ADO commit capture.
 *
 * ADO source: `GET {org}/{project}/_apis/git/repositories/{repo}/commits/{sha}`
 * → `{commitId, author:{name,email,date}, ...}`. ADO returns NO signature
 * verification. The canonical `commit.verification.verified` is therefore
 * recorded as `false` with the explicit `reason` token so an auditor sees
 * the ceremony proceeded under the org-admin attestation path, not under a
 * verified root commit.
 *
 * @param {object} body - the ADO commit response body (raw)
 * @param {object} [opts] - { capture_ts?: string }
 */
function _allowlistAdoCommitVerification(body, opts) {
  if (!body || typeof body !== "object") return body;
  const out = {};
  // ADO uses `commitId`; GitHub uses `sha`. Canonical key is `sha`.
  const sha =
    typeof body.sha === "string"
      ? body.sha
      : typeof body.commitId === "string"
        ? body.commitId
        : undefined;
  if (sha !== undefined) out.sha = sha;
  const author = body.author || (body.commit && body.commit.author) || null;
  out.commit = _omitUndefined({
    author: author
      ? _omitUndefined({
          name: author.name,
          email: author.email,
          date: author.date,
        })
      : null,
    // ADO has no commit-signature verification API surface — record the
    // unverified state faithfully (NOT a silent `verified: true`).
    verification: {
      verified: false,
      reason: ADO_COMMIT_UNVERIFIED_REASON,
    },
  });
  // ADO does not bind a commit to a platform login the way GitHub's
  // body.author.login does; the verified-identity anchor for ADO is the
  // org-admin attestation, not the commit author. Record null.
  out.author = null;
  out.capture_ts = _captureTs(opts);
  return out;
}

/**
 * Allowlist for the ADO project/collection members capture.
 *
 * The adapter resolves members (ADO Graph) and passes an array of
 * `{login: <UPN>, isAdmin: <bool>}`. The canonical inner shape reuses the
 * `collaborators` key + `permissions.{admin,push}` so the provider-neutral
 * distinctness predicate consumes it unchanged.
 *
 * @param {Array<{login:string, isAdmin?:boolean}>} members
 * @param {object} [opts] - { capture_ts?: string }
 */
function _allowlistAdoMembers(members, opts) {
  if (!Array.isArray(members)) return members;
  const collaborators = members.map((m) => {
    const admin = !!(m && m.isAdmin);
    return _omitUndefined({
      login: m && m.login,
      type: "User",
      permissions: { admin, push: admin },
    });
  });
  return { collaborators, capture_ts: _captureTs(opts) };
}

/**
 * R5-S-07 distinct-bound-principal predicate for ADO — the principalsEqual
 * sibling of gh-api-allowlist.js `_verifyDistinctBoundCollaborators`.
 *
 * Verifies the primary + cosigner principals (a) are DISTINCT (case-
 * insensitive sock-puppet defense), and (b) are BOTH present as
 * admin-permission entries in the members capture.
 *
 * @param {string} primaryPrincipal
 * @param {string} cosignerPrincipal
 * @param {object} capture - { collaborators:[...], capture_ts } (bare array
 *                            also accepted for backward compat)
 * @returns {{ok: boolean, reason?: string}}
 */
function _verifyDistinctBoundMembers(
  primaryPrincipal,
  cosignerPrincipal,
  capture,
) {
  if (typeof primaryPrincipal !== "string" || !primaryPrincipal) {
    return { ok: false, reason: "primaryPrincipal missing or not a string" };
  }
  if (typeof cosignerPrincipal !== "string" || !cosignerPrincipal) {
    return { ok: false, reason: "cosignerPrincipal missing or not a string" };
  }
  if (principalsEqual(primaryPrincipal, cosignerPrincipal)) {
    return {
      ok: false,
      reason: `R5-S-07: primary and cosigner resolve to the SAME Entra principal '${primaryPrincipal}' (sock-puppet defense — two distinct person_ids cannot share a principal for cosig purposes)`,
    };
  }
  let entries;
  if (Array.isArray(capture)) {
    entries = capture;
  } else if (capture && Array.isArray(capture.collaborators)) {
    entries = capture.collaborators;
  } else {
    return {
      ok: false,
      reason:
        "R5-S-07: members capture missing or not in {collaborators: [...]} shape",
    };
  }
  const isAdminMatch = (login) => (c) =>
    c &&
    typeof c.login === "string" &&
    principalsEqual(c.login, login) &&
    c.permissions &&
    c.permissions.admin === true;
  if (!entries.find(isAdminMatch(primaryPrincipal))) {
    return {
      ok: false,
      reason: `R5-S-07: primary principal '${primaryPrincipal}' is not an admin-permission member in the ADO capture`,
    };
  }
  if (!entries.find(isAdminMatch(cosignerPrincipal))) {
    return {
      ok: false,
      reason: `R5-S-07: cosigner principal '${cosignerPrincipal}' is not an admin-permission member in the ADO capture`,
    };
  }
  return { ok: true };
}

module.exports = {
  _allowlistAdoRepoOwner,
  _allowlistAdoOrgAdmin,
  _allowlistAdoCommitVerification,
  _allowlistAdoMembers,
  _verifyDistinctBoundMembers,
  ADO_COMMIT_UNVERIFIED_REASON,
  // Re-export the PROVIDER-NEUTRAL freshness surface so ADO callers import
  // from one place; these are the SAME values gh-api-allowlist.js exports
  // (not forks).
  _isCaptureFresh,
  GH_API_CAPTURE_FRESHNESS_MS,
  MIGRATION_LIVENESS_TTL,
};
