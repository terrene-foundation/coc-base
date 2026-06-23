/**
 * vcs-github-adapter — the GitHub provider adapter.
 *
 * A THIN wrapper over the EXACT endpoint strings + response-shape parsing +
 * allowlist functions the ceremony helpers (`genesis-ceremony.js` et al.)
 * used inline before the provider-adapter refactor. The load-bearing
 * invariant: this adapter is BEHAVIOR-IDENTICAL to the prior inline gh-api
 * code, so GitHub ceremony records remain byte-for-byte unchanged.
 *
 * The injected `transport` is the existing `ghApi` callable. The READ form is
 * GET-only:
 *   (endpoint: string) => { ok, status, body, error? }   (wraps `gh api <endpoint>`)
 * The deploy write surface (ECO-IMPL W6a) extends it to a WRITE-CAPABLE form
 * (the read form is the back-compat default — existing GET callers pass no
 * second arg and are byte-unchanged):
 *   (endpoint: string, opts?: { method?: "GET"|"POST"|"DELETE"|"PATCH",
 *                               fields?: object }) => { ok, status, body, error? }
 * The injected write-transport MUST (1) invoke `gh api` in execFileSync
 * arg-array form (never a composed shell string) — the adapter signature-guards
 * every endpoint-interpolated value, but arg-array invocation is the transport's
 * half of the command-injection contract (`security.md`); AND (2) JSON-serialize
 * the WHOLE `fields` object as the request body (`gh api --input -` semantics),
 * NOT `gh api --field key=val` flattening — `--field` cannot carry a nested
 * `fields.inputs` object, so flattening would silently drop the workflow_dispatch
 * inputs. This serialization contract is inherited by W7's upflow methods.
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
 *   pushImage / applyDeployTarget → { ok, dispatched, workflow, ref, status } | { ok:false, ... }
 *   invalidateCache → { ok, invalidated, key, status } | { ok:false, ... }
 *   createUpflowPR / createUpflowIssue → { ok, created, number, url, status } | { ok:false, ... }
 *   completeUpflowPR → { ok, completed, merged, sha, status } | { ok:false, ... }
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

// ── Deploy write surface (ECO-IMPL W6a / T2-iface) ─────────────────────────
// The deploy half of the provider write-surface. The upflow half
// (createUpflowPR / createUpflowIssue / completeUpflowPR) lands in W7 against
// the SAME contract — W6a agrees the interface, W7 fills its three method
// bodies on this file (shared-source serialization per agents.md worktree
// Rule 9). The deploy descriptors (workflow id, ref, inputs, cache key) are
// the shape C3/C4 (the deploy-config override + /deploy Step-0 wiring) produce;
// this adapter DEFINES the shape, the consumers conform (contract-first).
//
// Endpoints (real GitHub REST):
//   workflow_dispatch → POST repos/{o}/{r}/actions/workflows/{wf}/dispatches
//   cache purge       → DELETE repos/{o}/{r}/actions/caches?key={key}
// pushImage + applyDeployTarget both model a workflow_dispatch (CI builds +
// pushes the image to GHCR / runs the deploy — the adapter NEVER shells out to
// docker); they share _dispatchWorkflow but stay distinct named interface
// methods (ADO implements them via different services).

const WORKFLOW_ID_RE = /^[A-Za-z0-9._-]+$/; // workflow filename or numeric id; no path sep
const GIT_REF_RE = /^[A-Za-z0-9._/-]+$/; // branch / tag / sha; bounded charset
const CACHE_KEY_RE = /^[A-Za-z0-9._/-]+$/; // query-param key; bounded, query-safe charset

/**
 * Shared workflow_dispatch primitive for pushImage + applyDeployTarget.
 * descriptor: { repoRef:{owner,name}, workflow, ref?, inputs? }
 */
function _dispatchWorkflow(transport, descriptor, label) {
  const repoRef = descriptor && descriptor.repoRef;
  const rv = validateRepoRef(repoRef);
  if (!rv.valid) return _fail(`${label}: repoRef invalid`, rv.reason);
  const workflow = descriptor.workflow;
  if (typeof workflow !== "string" || !WORKFLOW_ID_RE.test(workflow)) {
    return _fail(
      `${label}: workflow id invalid`,
      `workflow must match /^[A-Za-z0-9._-]+$/ (filename or numeric id); got ${JSON.stringify(workflow)}`,
    );
  }
  const ref = descriptor.ref === undefined ? "main" : descriptor.ref;
  if (typeof ref !== "string" || !GIT_REF_RE.test(ref)) {
    return _fail(
      `${label}: ref invalid`,
      `ref must match /^[A-Za-z0-9._/-]+$/ (git ref shape); got ${JSON.stringify(ref)}`,
    );
  }
  const inputs =
    descriptor.inputs === undefined || descriptor.inputs === null
      ? {}
      : descriptor.inputs;
  if (typeof inputs !== "object" || Array.isArray(inputs)) {
    return _fail(
      `${label}: inputs invalid`,
      `inputs must be a plain object; got ${JSON.stringify(inputs)}`,
    );
  }
  let r;
  try {
    r = transport(
      `repos/${repoRef.owner}/${repoRef.name}/actions/workflows/${workflow}/dispatches`,
      { method: "POST", fields: { ref, inputs } },
    );
  } catch (err) {
    return _fail(
      `${label}: dispatch threw`,
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      `${label}: dispatch failed`,
      `POST actions/workflows/${workflow}/dispatches → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  // workflow_dispatch returns 204 No Content on success.
  return { ok: true, dispatched: true, workflow, ref, status: r.status };
}

/**
 * Publish a container image by dispatching the image-publish workflow (CI
 * builds + pushes to GHCR). descriptor: { repoRef, workflow, ref?, inputs? }.
 */
function pushImage(transport, imageSpec) {
  return _dispatchWorkflow(transport, imageSpec, "pushImage");
}

/**
 * Apply a deploy target by dispatching its deploy workflow.
 * descriptor: { repoRef, workflow, ref?, inputs? }.
 */
function applyDeployTarget(transport, target) {
  return _dispatchWorkflow(transport, target, "applyDeployTarget");
}

/**
 * Purge an Actions cache by key. scope: { repoRef:{owner,name}, key }.
 */
function invalidateCache(transport, scope) {
  const repoRef = scope && scope.repoRef;
  const rv = validateRepoRef(repoRef);
  if (!rv.valid) return _fail("invalidateCache: repoRef invalid", rv.reason);
  const key = scope.key;
  if (typeof key !== "string" || !CACHE_KEY_RE.test(key)) {
    return _fail(
      "invalidateCache: cache key invalid",
      `key must match /^[A-Za-z0-9._/-]+$/ (bounded, query-safe charset); got ${JSON.stringify(key)}`,
    );
  }
  // `key` passes CACHE_KEY_RE (bounded charset — no &, ?, #, =, space) so it
  // cannot break out of the query-value position; the allowed `/` is inert in a
  // value. The key is passed PRE-encoding to the transport, which is responsible
  // for URL-encoding the query (the gh-api transport encodes query params).
  let r;
  try {
    r = transport(
      `repos/${repoRef.owner}/${repoRef.name}/actions/caches?key=${key}`,
      { method: "DELETE" },
    );
  } catch (err) {
    return _fail(
      "invalidateCache: delete threw",
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "invalidateCache: delete failed",
      `DELETE actions/caches?key=${key} → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  return { ok: true, invalidated: true, key, status: r.status };
}

// ── Upflow write surface (ECO-IMPL W7 / G-F) ───────────────────────────────
// The upflow half of the provider write-surface (the deploy half above is W6a),
// filled against the SAME §ADR contract — W6a agreed the 2-arg
// (transport, descriptor) interface, W7 fills these three method bodies on the
// same file (shared-source serialization per agents.md worktree Rule 9).
//
// These are transport PRIMITIVES the Step-7c downstream-upflow procedure
// (commands/codify.md Step 7c) dispatches AFTER its human gate
// (upstream-issue-hygiene.md MUST-1) + consumer-side disclosure scrub (fence i).
// The adapter is the dumb transport; the human gate + scrub live in the
// consumer — the adapter NEVER auto-fires (no standing approval baked here).
//
// Endpoints (real GitHub REST):
//   createUpflowPR    → POST repos/{o}/{r}/pulls
//   createUpflowIssue → POST repos/{o}/{r}/issues
//   completeUpflowPR  → PUT  repos/{o}/{r}/pulls/{n}/merge

const PR_NUMBER_RE = /^[0-9]+$/; // PR number — path-interpolated, integer only
const MERGE_METHOD_RE = /^(merge|squash|rebase)$/; // gh merge_method enum

/**
 * Open the human-gated upflow PR (the consumer has already pushed `head` and
 * staged the inbox proposal YAML on it). descriptor:
 *   { repoRef:{owner,name}, head, base?, title, body? }.
 * head/base reach BODY positions only (no path-injection); guarded for shape.
 */
function createUpflowPR(transport, prSpec) {
  const repoRef = prSpec && prSpec.repoRef;
  const rv = validateRepoRef(repoRef);
  if (!rv.valid) return _fail("createUpflowPR: repoRef invalid", rv.reason);
  const head = prSpec.head;
  if (
    typeof head !== "string" ||
    !GIT_REF_RE.test(head) ||
    head.includes("..")
  ) {
    return _fail(
      "createUpflowPR: head invalid",
      `head must match /^[A-Za-z0-9._/-]+$/ with no '..' segment (git ref shape); got ${JSON.stringify(head)}`,
    );
  }
  const base = prSpec.base === undefined ? "main" : prSpec.base;
  if (
    typeof base !== "string" ||
    !GIT_REF_RE.test(base) ||
    base.includes("..")
  ) {
    return _fail(
      "createUpflowPR: base invalid",
      `base must match /^[A-Za-z0-9._/-]+$/ with no '..' segment (git ref shape); got ${JSON.stringify(base)}`,
    );
  }
  const title = prSpec.title;
  if (typeof title !== "string" || title.length === 0) {
    return _fail(
      "createUpflowPR: title invalid",
      `title must be a non-empty string; got ${JSON.stringify(title)}`,
    );
  }
  const body = prSpec.body === undefined ? "" : prSpec.body;
  if (typeof body !== "string") {
    return _fail(
      "createUpflowPR: body invalid",
      `body must be a string; got ${typeof body}`,
    );
  }
  let r;
  try {
    r = transport(`repos/${repoRef.owner}/${repoRef.name}/pulls`, {
      method: "POST",
      fields: { title, head, base, body },
    });
  } catch (err) {
    return _fail(
      "createUpflowPR: create threw",
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "createUpflowPR: create failed",
      `POST repos/${repoRef.owner}/${repoRef.name}/pulls → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  const pr = r.body || {};
  return {
    ok: true,
    created: true,
    number: pr.number,
    url: pr.html_url,
    status: r.status,
  };
}

/**
 * Open the no-fork Route-A fallback issue on the template. descriptor:
 *   { repoRef:{owner,name}, title, body?, labels? }.
 * All caller content reaches BODY positions (no path-injection); labels are
 * shape-guarded (array of strings) so a malformed label cannot corrupt the body.
 */
function createUpflowIssue(transport, issueSpec) {
  const repoRef = issueSpec && issueSpec.repoRef;
  const rv = validateRepoRef(repoRef);
  if (!rv.valid) return _fail("createUpflowIssue: repoRef invalid", rv.reason);
  const title = issueSpec.title;
  if (typeof title !== "string" || title.length === 0) {
    return _fail(
      "createUpflowIssue: title invalid",
      `title must be a non-empty string; got ${JSON.stringify(title)}`,
    );
  }
  const body = issueSpec.body === undefined ? "" : issueSpec.body;
  if (typeof body !== "string") {
    return _fail(
      "createUpflowIssue: body invalid",
      `body must be a string; got ${typeof body}`,
    );
  }
  const labels = issueSpec.labels;
  if (
    labels !== undefined &&
    (!Array.isArray(labels) || !labels.every((l) => typeof l === "string"))
  ) {
    return _fail(
      "createUpflowIssue: labels invalid",
      `labels must be an array of strings; got ${JSON.stringify(labels)}`,
    );
  }
  const fields =
    labels === undefined ? { title, body } : { title, body, labels };
  let r;
  try {
    r = transport(`repos/${repoRef.owner}/${repoRef.name}/issues`, {
      method: "POST",
      fields,
    });
  } catch (err) {
    return _fail(
      "createUpflowIssue: create threw",
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "createUpflowIssue: create failed",
      `POST repos/${repoRef.owner}/${repoRef.name}/issues → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  const issue = r.body || {};
  return {
    ok: true,
    created: true,
    number: issue.number,
    url: issue.html_url,
    status: r.status,
  };
}

/**
 * Complete (merge) the upflow PR once the template maintainer approves.
 * descriptor: { repoRef:{owner,name}, prId, mergeMethod? }.
 * prId is PATH-interpolated → integer-only guard; mergeMethod is enum-guarded.
 */
function completeUpflowPR(transport, prRef) {
  const repoRef = prRef && prRef.repoRef;
  const rv = validateRepoRef(repoRef);
  if (!rv.valid) return _fail("completeUpflowPR: repoRef invalid", rv.reason);
  const prId = prRef.prId;
  if (
    (typeof prId !== "string" && typeof prId !== "number") ||
    !PR_NUMBER_RE.test(String(prId))
  ) {
    return _fail(
      "completeUpflowPR: prId invalid",
      `prId must match /^[0-9]+$/ (PR number); got ${JSON.stringify(prId)}`,
    );
  }
  const mergeMethod =
    prRef.mergeMethod === undefined ? "merge" : prRef.mergeMethod;
  if (typeof mergeMethod !== "string" || !MERGE_METHOD_RE.test(mergeMethod)) {
    return _fail(
      "completeUpflowPR: mergeMethod invalid",
      `mergeMethod must be one of merge|squash|rebase; got ${JSON.stringify(mergeMethod)}`,
    );
  }
  let r;
  try {
    r = transport(
      `repos/${repoRef.owner}/${repoRef.name}/pulls/${String(prId)}/merge`,
      { method: "PUT", fields: { merge_method: mergeMethod } },
    );
  } catch (err) {
    return _fail(
      "completeUpflowPR: merge threw",
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "completeUpflowPR: merge failed",
      `PUT pulls/${String(prId)}/merge → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  const m = r.body || {};
  return {
    ok: true,
    completed: true,
    merged: m.merged === true,
    sha: m.sha,
    status: r.status,
  };
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
  pushImage,
  applyDeployTarget,
  invalidateCache,
  createUpflowPR,
  createUpflowIssue,
  completeUpflowPR,
  verifyDistinctBoundPrincipals,
};
