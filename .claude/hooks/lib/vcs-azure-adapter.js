/**
 * vcs-azure-adapter — the Azure DevOps provider adapter.
 *
 * The ADO sibling of `vcs-github-adapter.js`. Same uniform return contract;
 * ADO-specific endpoint construction + the `ado-api-allowlist.js` shapers.
 * Emits the SAME canonical capture inner shapes, so the fold predicates stay
 * provider-neutral below the `content.provider` dispatch point.
 *
 * Transport contract (the ADO analogue of GitHub's `ghApi(endpointString)`):
 *   (req: { service: "core"|"graph", path: string, meta?: object,
 *           method?: "GET"|"POST"|"DELETE"|"PATCH", fields?: object })
 *     => { ok, status, body, error? }
 *   method defaults to GET (read callers pass none — byte-unchanged). The
 *   deploy write surface (ECO-IMPL W6a) adds method/fields for POSTs; the
 *   ADO deploy endpoints are DOCUMENTED-UNVERIFIED (no live ADO test org — per
 *   `rules/verify-resource-existence.md` MUST-2 the live-API mapping is the
 *   operator-verified runbook's job), so every ADO deploy result carries
 *   `unverified: true` and NONE fakes success. The upflow write surface
 *   (ECO-IMPL W7 / G-F: createUpflowPR / createUpflowIssue / completeUpflowPR)
 *   carries the SAME `unverified: true` posture (same no-live-ADO-org gate,
 *   G-F-4) and the same uniform-return contract.
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

// ── Deploy write surface (ECO-IMPL W6a / T2-iface) ─────────────────────────
// The ADO sibling of the GitHub deploy half. Same uniform return contract +
// the same descriptor shapes (provider-dispatched: gh uses workflow_dispatch,
// ADO uses Azure Pipelines runs). Every ADO deploy result carries
// `unverified: true` per the module header's documented residual policy (see
// the transport-contract + provider-semantics notes above) — NONE fakes
// success; `unverified` flags the API-mapping as not-live-verified.

const ADO_PIPELINE_ID_RE = /^[A-Za-z0-9._-]+$/; // pipeline name or numeric id
const ADO_GIT_REF_RE = /^[A-Za-z0-9._/-]+$/; // branch / tag / sha; bounded charset

/**
 * Shared Azure Pipelines run primitive for pushImage + applyDeployTarget.
 * descriptor: { repoRef:{org,project,repo}, pipeline, ref?, inputs? }.
 * DOCUMENTED-UNVERIFIED endpoint:
 *   POST {org}/{project}/_apis/pipelines/{pipelineId}/runs?api-version=7.1
 */
function _runPipeline(transport, descriptor, label) {
  const repoRef = descriptor && descriptor.repoRef;
  const rv = validateRepoRef(repoRef);
  if (!rv.valid) return _fail(`${label}: repoRef invalid`, rv.reason);
  const pipeline = descriptor.pipeline;
  if (typeof pipeline !== "string" || !ADO_PIPELINE_ID_RE.test(pipeline)) {
    return _fail(
      `${label}: pipeline id invalid`,
      `pipeline must match /^[A-Za-z0-9._-]+$/ (name or numeric id); got ${JSON.stringify(pipeline)}`,
    );
  }
  const ref = descriptor.ref === undefined ? "main" : descriptor.ref;
  if (typeof ref !== "string" || !ADO_GIT_REF_RE.test(ref)) {
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
  const { org, project } = repoRef;
  let r;
  try {
    r = transport({
      service: "core",
      path: `${org}/${project}/_apis/pipelines/${pipeline}/runs?api-version=${API_VERSION}`,
      method: "POST",
      fields: {
        // ADO residual: this assumes a BRANCH ref (refs/heads/ prefix). A tag
        // or SHA ref is not supported here — it would resolve to a non-existent
        // branch and the run would be rejected at ADO (the result is already
        // `unverified`, so no false success). A tag/SHA deploy on ADO is an
        // undocumented-residual the W6b/G-D deploy-spec work resolves if needed.
        resources: { repositories: { self: { refName: `refs/heads/${ref}` } } },
        templateParameters: inputs,
      },
    });
  } catch (err) {
    return _fail(
      `${label}: pipeline run threw`,
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      `${label}: pipeline run failed`,
      `POST pipelines/${pipeline}/runs → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body, unverified: true },
    );
  }
  // unverified: the endpoint mapping is not live-verified (no ADO test org).
  return {
    ok: true,
    dispatched: true,
    pipeline,
    ref,
    status: r.status,
    unverified: true,
  };
}

/**
 * ADO: publish a container image by running the image-publish pipeline.
 * descriptor: { repoRef, pipeline, ref?, inputs? }.
 */
function pushImage(transport, imageSpec) {
  return _runPipeline(transport, imageSpec, "pushImage");
}

/**
 * ADO: apply a deploy target by running its deploy pipeline.
 * descriptor: { repoRef, pipeline, ref?, inputs? }.
 */
function applyDeployTarget(transport, target) {
  return _runPipeline(transport, target, "applyDeployTarget");
}

/**
 * ADO residual: Azure Pipelines caching exposes NO public purge-cache-by-key
 * REST endpoint (verify-resource-existence.md MUST-2 — unsupported, NOT faked).
 * Return a typed UNVERIFIED failure so the consumer handles the gap explicitly
 * rather than mistaking absence for success. scope: { repoRef, key }.
 */
function invalidateCache(transport, scope) {
  const rv = validateRepoRef(scope && scope.repoRef);
  if (!rv.valid) return _fail("invalidateCache: repoRef invalid", rv.reason);
  return {
    ok: false,
    error: "ado cache purge unsupported",
    reason:
      "Azure Pipelines exposes no public purge-cache-by-key REST endpoint (documented residual, verify-resource-existence.md MUST-2); not faked",
    unverified: true,
  };
}

// ── Upflow write surface (ECO-IMPL W7 / G-F) ───────────────────────────────
// The ADO sibling of the GitHub upflow half. Same uniform return contract +
// the same 2-arg (transport, descriptor) §ADR convention. Provider-dispatched:
// gh uses the pulls/issues REST; ADO uses pullrequests + work-items. Every ADO
// upflow result carries `unverified: true` (no live ADO test org — G-F-4 gate,
// same posture as the deploy half) — NONE fakes success.

const ADO_PR_ID_RE = /^[0-9]+$/; // PR id — path-interpolated, integer only
const ADO_WORKITEM_TYPE_RE = /^[A-Za-z][A-Za-z0-9 ._-]*$/; // work-item type; path-interpolated, NO path sep

/**
 * ADO: open the human-gated upflow PR. descriptor:
 *   { repoRef:{org,project,repo}, head, base?, title, body? }.
 * DOCUMENTED-UNVERIFIED endpoint:
 *   POST {org}/{project}/_apis/git/repositories/{repo}/pullrequests?api-version=7.1
 */
function createUpflowPR(transport, prSpec) {
  const repoRef = prSpec && prSpec.repoRef;
  const rv = validateRepoRef(repoRef);
  if (!rv.valid) return _fail("createUpflowPR: repoRef invalid", rv.reason);
  const head = prSpec.head;
  if (
    typeof head !== "string" ||
    !ADO_GIT_REF_RE.test(head) ||
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
    !ADO_GIT_REF_RE.test(base) ||
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
  const { org, project, repo } = repoRef;
  let r;
  try {
    r = transport({
      service: "core",
      path: `${org}/${project}/_apis/git/repositories/${repo}/pullrequests?api-version=${API_VERSION}`,
      method: "POST",
      fields: {
        sourceRefName: `refs/heads/${head}`,
        targetRefName: `refs/heads/${base}`,
        title,
        description: body,
      },
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
      `ADO pullrequests POST → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body, unverified: true },
    );
  }
  const pr = r.body || {};
  return {
    ok: true,
    created: true,
    number: pr.pullRequestId,
    url: pr.url,
    status: r.status,
    unverified: true,
  };
}

/**
 * ADO: open the no-fork Route-A fallback as a work-item. descriptor:
 *   { repoRef:{org,project,repo}, title, body?, workItemType? }.
 * workItemType defaults to "Task" (the D6 getAdoWorkItemType() default, G-F-3);
 * it is PATH-interpolated → guarded against path separators. NOTE: the caller
 * threads getAdoWorkItemType() in through the /codify Step-7c procedure (the
 * doc-side bridge, sync-flow.md § Provider-dispatched transport) — there is no
 * executable call site that passes workItemType, BY DESIGN (the LLM procedure
 * invokes this dumb adapter per agent-reasoning.md). The accessor is
 * procedure-bridged, NOT dead code.
 *
 * G-F-1 disclosure-surface neutralization (security-sensitive): an ADO
 * work-item exposes disclosure fields BEYOND title/body — System.AreaPath,
 * System.IterationPath, System.Tags, System.AssignedTo — each of which can
 * carry org / consumer identity. The adapter constructs a MINIMAL JSON-Patch
 * that sets ONLY System.Title + System.Description, and NEVER auto-populates
 * the disclosure fields (they default to the project root, carrying no consumer
 * identity). Arbitrary caller fields are NOT passed through — the minimal,
 * fixed field set IS the structural neutralization.
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
  const workItemType =
    issueSpec.workItemType === undefined ? "Task" : issueSpec.workItemType;
  if (
    typeof workItemType !== "string" ||
    !ADO_WORKITEM_TYPE_RE.test(workItemType)
  ) {
    return _fail(
      "createUpflowIssue: workItemType invalid",
      `workItemType must match /^[A-Za-z][A-Za-z0-9 ._-]*$/ (no path separators); got ${JSON.stringify(workItemType)}`,
    );
  }
  // G-F-1: minimal JSON-Patch — Title + Description ONLY. The disclosure fields
  // (AreaPath / IterationPath / Tags / AssignedTo) are NEVER set.
  const patch = [
    { op: "add", path: "/fields/System.Title", value: title },
    { op: "add", path: "/fields/System.Description", value: body },
  ];
  const { org, project } = repoRef;
  let r;
  try {
    r = transport({
      service: "core",
      // `$<type>` is the ADO work-item-create path form; the production
      // transport sets Content-Type: application/json-patch+json (unverified —
      // no live ADO org).
      path: `${org}/${project}/_apis/wit/workitems/$${workItemType}?api-version=${API_VERSION}`,
      method: "POST",
      fields: patch,
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
      `ADO work-item POST → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body, unverified: true },
    );
  }
  const wi = r.body || {};
  return {
    ok: true,
    created: true,
    number: wi.id,
    url: wi.url,
    status: r.status,
    unverified: true,
  };
}

/**
 * ADO: complete the upflow PR. descriptor: { repoRef:{org,project,repo}, prId }.
 * prId is PATH-interpolated → integer-only guard.
 * DOCUMENTED-UNVERIFIED endpoint:
 *   PATCH {org}/{project}/_apis/git/repositories/{repo}/pullrequests/{prId}?api-version=7.1
 */
function completeUpflowPR(transport, prRef) {
  const repoRef = prRef && prRef.repoRef;
  const rv = validateRepoRef(repoRef);
  if (!rv.valid) return _fail("completeUpflowPR: repoRef invalid", rv.reason);
  const prId = prRef.prId;
  if (
    (typeof prId !== "string" && typeof prId !== "number") ||
    !ADO_PR_ID_RE.test(String(prId))
  ) {
    return _fail(
      "completeUpflowPR: prId invalid",
      `prId must match /^[0-9]+$/ (PR id); got ${JSON.stringify(prId)}`,
    );
  }
  const { org, project, repo } = repoRef;
  let r;
  try {
    r = transport({
      service: "core",
      path: `${org}/${project}/_apis/git/repositories/${repo}/pullrequests/${String(prId)}?api-version=${API_VERSION}`,
      method: "PATCH",
      fields: { status: "completed" },
    });
  } catch (err) {
    return _fail(
      "completeUpflowPR: complete threw",
      `network unavailable or transport threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "completeUpflowPR: complete failed",
      `ADO pullrequests/${String(prId)} PATCH → status ${r && r.status} body ${JSON.stringify(r && r.body)}`,
      { status: r && r.status, body: r && r.body, unverified: true },
    );
  }
  return { ok: true, completed: true, status: r.status, unverified: true };
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
  pushImage,
  applyDeployTarget,
  invalidateCache,
  createUpflowPR,
  createUpflowIssue,
  completeUpflowPR,
  verifyDistinctBoundPrincipals,
};
