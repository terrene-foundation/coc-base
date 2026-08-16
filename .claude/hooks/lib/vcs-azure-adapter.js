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
 * repoRef shape for ADO:
 *   { org: string, project: string, repo: string, collection?: string }.
 * `collection` is OPTIONAL and read ONLY by `completeUpflowPR`'s identity
 * fence: the legacy TFS/VSTS URL form
 * `<org>.visualstudio.com/<collection>/<project>/_git/<repo>` carries one and
 * the three modern forms do not, so absent means "the org's DEFAULT
 * collection" and compares equal to a stated `DefaultCollection`, and unequal
 * to any other. Every REST path this adapter builds is
 * `{org}/{project}/_apis/...` — see the residual note on `completeUpflowPR`.
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
const {
  sanitizeForReason,
  reasonText,
  reasonOperand,
  reasonFromError,
} = require("./upflow-self-repo.js");

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
  if (!o.valid) {
    return { valid: false, reason: `repoRef.org ${reasonText(o.reason)}` };
  }
  const p = adoLogin.validateAdoProject(ref.project);
  if (!p.valid) {
    return { valid: false, reason: `repoRef.project ${reasonText(p.reason)}` };
  }
  const r = adoLogin.validateAdoRepo(ref.repo);
  if (!r.valid) {
    return { valid: false, reason: `repoRef.repo ${reasonText(r.reason)}` };
  }
  // OPTIONAL, and optional in the strict sense: absent (undefined/null/"") is
  // VALID and means "the org's DEFAULT collection". It is NOT a wildcard — the
  // fence's `isSelfRepoAdo` normalizes absent to `defaultcollection` and then
  // COMPARES it, so a non-default collection still refuses. Only the legacy
  // `<org>.visualstudio.com/<collection>/<project>/_git/<repo>` form carries one.
  //
  // VALIDATED WITH THE PROJECT SHAPE because a collection appears in the same
  // URL position and is read off the remote by the same `normalizeComponent`
  // allowlist, so a value this rejects could never match a derived one anyway —
  // rejecting it HERE makes that a named refusal instead of a silent mismatch.
  // Present-but-malformed is a caller error and is refused before the fence,
  // like the three legs above.
  if (!(
    ref.collection === undefined ||
    ref.collection === null ||
    ref.collection === ""
  )) {
    const c = adoLogin.validateAdoProject(ref.collection);
    if (!c.valid) {
      return {
        valid: false,
        reason: `repoRef.collection ${reasonText(c.reason)}`,
      };
    }
  }
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
 * Render an ADO collection component for INCLUSION IN A REFUSAL STRING.
 *
 * Absence is rendered as a visible `<default-collection>` rather than an empty
 * string: the collection is the one quad component that is legitimately absent,
 * and a refusal reading `contoso//platform/coc-rs` on both sides would tell a
 * reader nothing about why it refused.
 *
 * PRESENT values go through `reasonText`, the SAME sanitizer every other
 * operand in these refusal strings uses. It is a caller-authored value reaching
 * a logged string, so it carries the identical log-injection surface
 * `displayPrId` and `sanitizeForReason` exist for — `security.md`
 * § Enforcement-Surface Parity: a new operand on an existing refusal path gets
 * the existing bound, not a new unbounded one.
 */
function _collectionLabel(v) {
  // Rendered as `<default-collection>`, not `<no-collection>`: under
  // `isSelfRepoAdo` an absent collection IS the default, so labelling it as an
  // absence understates what differed when the other side names a non-default
  // one (a refusal printing `othercollection` vs `<no-collection>` reads as
  // present-vs-missing when it is actually non-default-vs-default).
  if (v === undefined || v === null || v === "") return "<default-collection>";
  return reasonText(v);
}

// ── Refusal-operand sanitization (GH issue #83) ────────────────────────────
//
// EVERY free-form operand interpolated into a `{ok:false, reason}` string in
// this file goes through one of the three helpers below. Those reasons are
// LOGGED, and `/codify` Step-7c may embed them in a PR body or a journal entry:
// a newline forges a second log line, and an escape sequence reaches a terminal
// a human reads as this tool's own output.
//
// WHY `JSON.stringify` IS NOT A SANITIZER FOR THIS CLASS. It was the escaping
// mechanism at ~45 refusal sites across the two adapters, and per ECMA-262
// `QuoteJSONString` it escapes `"`, `\`, and code units BELOW 0x20 (plus lone
// surrogates since ES2019) — and nothing else. It leaves VERBATIM: 0x7f DEL;
// the whole C1 range 0x80-0x9f, INCLUDING U+009B 8-bit CSI, an ANSI control
// introducer that contains no ESC and so passes every ESC-based check;
// U+2028 / U+2029; and every bidi control. So a `JSON.stringify`'d operand was
// escaped against the classes that were never the threat and unescaped against
// the ones that were.
//
// PARITY, NOT SELECTIVITY (`security.md` § Enforcement-Surface Parity). PR #80
// sanitized exactly two operands — `prId` via `displayPrId`, and the derived
// host + git stderr via `sanitizeForReason` — and left their NEIGHBOURS in the
// same template literals raw. The module docstring in `upflow-self-repo.js`
// states the principle it did not finish applying: "the argument for one is the
// argument for all". Hence: no operand in this file is exempt, including ones
// that a shape guard has already validated (a no-op there today, and the
// property survives a future relaxation of that guard).
//
// THE SANITIZATION CLASS AND ITS BOUND+SCRUB WRAPPER ARE ONE SHARED HELPER, not
// a copy. Character-class removal is `upflow-self-repo.js::sanitizeForReason`;
// the BOUND + URL-userinfo-SCRUB wrapper over it (`reasonText` / `reasonOperand`
// / `reasonFromError`) lives beside it in that same module, which is the
// sanitization SSOT. They were briefly duplicated once per adapter because that
// module was owned by a concurrent lane when the sweep landed; consolidating
// them removes the bound-drift risk that duplication created. The cross-adapter
// parity case in `audit-fixtures/upflow-refusal-operand-sanitization/` now
// guards the single definition. (They cannot live in `vcs-provider.js`, which
// `require`s BOTH adapters at load time — an adapter requiring it back would be
// a cycle that leaves `PROVIDERS.github` as an empty object.)

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
  if (!_rv.valid) return _fail("ado repoRef invalid", reasonText(_rv.reason));
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
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "ado repo call failed",
      `ADO git/repositories/${reasonText(repo)} → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
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
      `expected body.name (repo existence corroboration); got ${reasonOperand(r.body)}`,
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
  if (!_rv.valid) return _fail("ado repoRef invalid", reasonText(_rv.reason));
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
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "ado org-admin check failed",
      `ADO graph admin-membership(${reasonText(org)}, ${reasonText(principal)}) → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  if (!r.body || typeof r.body.role !== "string") {
    return _fail(
      "ado org-admin response malformed",
      `expected determination body.role; got ${reasonOperand(r.body)}`,
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
  if (!_rv.valid) return _fail("ado repoRef invalid", reasonText(_rv.reason));
  // F122 R2 LOW defense-in-depth: shape-guard the only other endpoint-
  // interpolated parameter (sha) at the primitive, matching the fold-layer
  // bound (fold-rule-9c.js re-anchor sha-shape /^[0-9a-f]{7,64}$/). sha
  // originates internally (git rev-list root), but a future caller passing an
  // unbounded value would otherwise interpolate it into the REST path.
  if (typeof sha !== "string" || !/^[0-9a-f]{7,64}$/.test(sha)) {
    return _fail(
      "ado commit sha invalid",
      `sha must match /^[0-9a-f]{7,64}$/ (commit-hash shape); got ${reasonOperand(sha)}`,
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
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "ado commit call failed",
      `ADO commits/${reasonText(sha)} → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
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
  if (!_rv.valid) return _fail("ado repoRef invalid", reasonText(_rv.reason));
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
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "ado members call failed",
      `ADO graph members(${reasonText(org)}) → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  if (!Array.isArray(r.body)) {
    return _fail(
      "ado members response malformed",
      `expected determination array body [{login,isAdmin}]; got ${reasonOperand(r.body)}`,
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
  if (!rv.valid)
    return _fail(`${label}: repoRef invalid`, reasonText(rv.reason));
  const pipeline = descriptor.pipeline;
  if (typeof pipeline !== "string" || !ADO_PIPELINE_ID_RE.test(pipeline)) {
    return _fail(
      `${label}: pipeline id invalid`,
      `pipeline must match /^[A-Za-z0-9._-]+$/ (name or numeric id); got ${reasonOperand(pipeline)}`,
    );
  }
  const ref = descriptor.ref === undefined ? "main" : descriptor.ref;
  if (typeof ref !== "string" || !ADO_GIT_REF_RE.test(ref)) {
    return _fail(
      `${label}: ref invalid`,
      `ref must match /^[A-Za-z0-9._/-]+$/ (git ref shape); got ${reasonOperand(ref)}`,
    );
  }
  const inputs =
    descriptor.inputs === undefined || descriptor.inputs === null
      ? {}
      : descriptor.inputs;
  if (typeof inputs !== "object" || Array.isArray(inputs)) {
    return _fail(
      `${label}: inputs invalid`,
      `inputs must be a plain object; got ${reasonOperand(inputs)}`,
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
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      `${label}: pipeline run failed`,
      `POST pipelines/${reasonText(pipeline)}/runs → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
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
  if (!rv.valid)
    return _fail("invalidateCache: repoRef invalid", reasonText(rv.reason));
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
  if (!rv.valid)
    return _fail("createUpflowPR: repoRef invalid", reasonText(rv.reason));
  const head = prSpec.head;
  if (
    typeof head !== "string" ||
    !ADO_GIT_REF_RE.test(head) ||
    head.includes("..")
  ) {
    return _fail(
      "createUpflowPR: head invalid",
      `head must match /^[A-Za-z0-9._/-]+$/ with no '..' segment (git ref shape); got ${reasonOperand(head)}`,
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
      `base must match /^[A-Za-z0-9._/-]+$/ with no '..' segment (git ref shape); got ${reasonOperand(base)}`,
    );
  }
  const title = prSpec.title;
  if (typeof title !== "string" || title.length === 0) {
    return _fail(
      "createUpflowPR: title invalid",
      `title must be a non-empty string; got ${reasonOperand(title)}`,
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
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "createUpflowPR: create failed",
      `ADO pullrequests POST → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
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
  if (!rv.valid)
    return _fail("createUpflowIssue: repoRef invalid", reasonText(rv.reason));
  const title = issueSpec.title;
  if (typeof title !== "string" || title.length === 0) {
    return _fail(
      "createUpflowIssue: title invalid",
      `title must be a non-empty string; got ${reasonOperand(title)}`,
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
      `workItemType must match /^[A-Za-z][A-Za-z0-9 ._-]*$/ (no path separators); got ${reasonOperand(workItemType)}`,
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
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "createUpflowIssue: create failed",
      `ADO work-item POST → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
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
 * ADO: complete the upflow PR.
 * descriptor: { repoRef:{org,project,repo,collection?}, prId }.
 * prId is PATH-interpolated → integer-only guard.
 * DOCUMENTED-UNVERIFIED endpoint:
 *   PATCH {org}/{project}/_apis/git/repositories/{repo}/pullrequests/{prId}?api-version=7.1
 *
 * KNOWN RESIDUAL, RECORDED NOT FIXED — THE REQUEST PATH HAS NO COLLECTION SLOT.
 * The identity fence below now discriminates collections (the quad), but the
 * path above is `{org}/{project}/_apis/...` on every call in this adapter. So a
 * completion authorized on a NON-default collection is still ADDRESSED
 * collection-free, i.e. to whichever repo the collection-less endpoint resolves
 * to. The identity fix does not close that, and does not claim to: it makes the
 * caller and the working tree agree on WHICH repo is meant, which is the defect
 * that was reported.
 *
 * Deliberately NOT guessed at. Emitting `{org}/{collection}/{project}/_apis/...`
 * for the legacy form is a claim about ADO's legacy REST routing that this repo
 * cannot verify, and acting on an incomplete enumeration of ADO URL forms is
 * exactly what produced the collection-form lockout regression this module
 * already records. Settling it needs a real legacy-collection ADO account —
 * the same disposition, for the same reason, as the `_ssh` parse gap in
 * `upflow-self-repo.js::_parseAdo`.
 *
 * Effect today: for the ordinary hosted case the derived collection is
 * `DefaultCollection` and the collection-less path is the same repo, so the
 * residual is inert; on any other collection the completion would be
 * misdirected, which is why the fence refusing an under-determined target is
 * the safer half to have fixed first.
 */
function completeUpflowPR(transport, prRef) {
  const repoRef = prRef && prRef.repoRef;
  const rv = validateRepoRef(repoRef);
  if (!rv.valid)
    return _fail("completeUpflowPR: repoRef invalid", reasonText(rv.reason));

  // --- Open-Never-Complete fence (upstream-issue-hygiene.md MUST-4) ---------
  // Provider-parity twin of the GitHub adapter's fence (security.md
  // § Enforcement-Surface Parity: a new fail-closed dimension lands at EVERY
  // surface in the SAME change, or the un-fenced provider becomes the bypass).
  // DERIVES the self-identity; does NOT accept one. There is deliberately no
  // `selfRepoRef` descriptor field, no deriver-injection seam, and no `cwd`
  // field — `deriveSelfRepoRef` takes one parameter and this call site
  // hardcodes `process.cwd()`. A Tier-1 redteam found the original shape
  // compared two caller-authored operands, and two later rounds each MOVED that
  // operand rather than removing it.
  //
  // WHAT THAT IS AND IS NOT EVIDENCE OF (the same bound the GitHub twin
  // carries; stated here too because this file is read on its own). The fence
  // refuses any completion whose target does not match the identity derived
  // from the working tree the process runs in. It CLOSES the accident class —
  // an agent following stale prose that completes against its upstream is
  // refused before the transport fires, and that accident IS the originating
  // incident. It RAISES THE COST of a deliberate act: the caller must stand up
  // a tree whose origin remote names the upstream rather than fill in a field.
  // It is NOT a boundary against a caller that can choose its own working
  // directory — `process.cwd()` is selected by whoever launches the process —
  // and it cannot be one, since a caller able to run arbitrary code in-process
  // can replace `upflow-self-repo.js` outright. Removing the descriptor seams
  // was still worth doing: they were forgeable by writing one object literal.
  //
  // ALL THREE ADO COMPONENTS COME FROM THE DERIVATION. `deriveSelfRepoRef`
  // parses the ADO remote itself (`dev.azure.com/<org>/<project>/_git/<repo>`
  // and the visualstudio.com / ssh v3 forms) and returns `self.ado =
  // {org, project, repo}`, so `org` is compared like the other two instead of
  // being taken off `repoRef` — the earlier shape read org from the caller and
  // therefore self-compared, a leg that could never fail. `version-utils.js::
  // normalizeRemoteIdentity` keeps only the last two path segments and drops
  // `_git`, which structurally loses `<org>`; that is why the ADO parse lives in
  // the deriver rather than reusing it. A non-ADO origin remote yields
  // `self.ado === null` and REFUSES: a repo whose remote is not an ADO remote
  // cannot prove an ADO identity.
  //
  // KNOWN RESIDUAL, DOCUMENTED RATHER THAN DISCOVERED LATER BY A LOCKED-OUT
  // MAINTAINER. `completeUpflowPR` is UNAVAILABLE for any ADO project or
  // repository whose URL form is not literally `[A-Za-z0-9._-]+`, and ADO
  // permits SPACES in project and repository display names — `Contoso Web` is
  // an ordinary name, not a contrived one. Its clone URL is
  // `https://dev.azure.com/<org>/Contoso%20Web/_git/<repo>`, and
  // `normalizeComponent` rejects the `%` (measured: it returns null), so
  // `_parseAdo` returns null and this refuses at "self-identity underivable".
  // The maintainer cannot complete their OWN PR.
  //
  // It is FAIL-CLOSED, which is the correct direction, and it is NOT introduced
  // by the character allowlist: before that existed the derived value would
  // have been `contoso%20web`, which `isSelfRepoAdo` would then have compared
  // against a `repoRef.project` that must pass `ADO_PROJECT_RE` (no `%`) — so
  // it refused one line later regardless. The lockout is structural to deriving
  // identity from the URL, not a consequence of the allowlist.
  //
  // THE DOCUMENTED GUID ESCAPE HATCH DOES NOT RESCUE THIS, and the note at
  // `ado-login.js` (which tells a caller to reference a spaced project by its
  // GUID) is correct for the REST endpoints and does NOT transfer here: the
  // caller side would carry the GUID while the DERIVED side carries the NAME
  // read off the remote, so the comparison is guaranteed to fail. That is
  // recorded at the validator too.
  //
  // Percent-DECODING the segments would admit `Contoso Web` only if the
  // allowlist were widened to accept a space, which reopens the interpolation
  // surface the allowlist closed. That is a design change owing its own
  // analysis, deliberately NOT made here.
  const selfRepo = require("./upflow-self-repo.js");
  const d = selfRepo.deriveSelfRepoRef(process.cwd());
  if (!d || !d.ok) {
    return _fail(
      "completeUpflowPR: self-identity underivable",
      `cannot derive this repo's own identity, so a completion cannot be authorized. ` +
        `upstream-issue-hygiene.md MUST-4 (Open, Never Complete): merging is the ` +
        `upstream maintainer's act on the upstream's OWN repo. (${reasonText(d && d.reason)})`,
    );
  }
  // ON-PREM AZURE DEVOPS SERVER IS OUT OF SCOPE, and this branch is where it
  // lands. `upflow-self-repo.js::_parseAdo` recognizes exactly four hosted
  // shapes — `dev.azure.com`, `ssh.dev.azure.com`, `vs-ssh.visualstudio.com`,
  // and `<org>.visualstudio.com`. An on-prem collection URL
  // (`https://<server>/tfs/<collection>/<project>/_git/<repo>`) is on none of
  // them, so no ADO identity is derived and `completeUpflowPR` is UNAVAILABLE
  // for such a deployment.
  //
  // PRE-EXISTING, not introduced by the exact-segment-count fix — stated
  // precisely because the two look alike and the wrong attribution would send
  // the next reader hunting a regression that is not there. Measured both ways:
  // before that fix an on-prem URL's four segments were reduced by the
  // last-two rule to a plain owner/name pair with `ado: null`, which reached
  // THIS branch and refused; after it, the segment count refuses one step
  // earlier in the derivation. Different branch, same outcome, in both cases a
  // refusal.
  //
  // Fail-closed and correct — a server this adapter cannot recognize is one it
  // cannot prove identity against — but recorded rather than left for an
  // on-prem operator to discover as an unexplained refusal.
  const selfAdo = d.self.ado;
  if (!selfAdo) {
    return _fail(
      "completeUpflowPR: self-identity underivable",
      `this working tree's origin remote is not an Azure DevOps remote, so its ` +
        `org/project/repo cannot be derived and an ADO completion cannot be ` +
        `authorized. upstream-issue-hygiene.md MUST-4 (Open, Never Complete): ` +
        `merging is the upstream maintainer's act on the upstream's OWN repo. ` +
        `(derived as ${reasonText(d.self.owner)}/${reasonText(d.self.name)} from a non-ADO remote)`,
    );
  }
  if (!selfRepo.isSelfRepoAdo(repoRef, selfAdo)) {
    return _fail(
      "completeUpflowPR: cross-repo completion refused",
      // BOTH SIDES' COLLECTION IS NAMED. The identity is a QUAD, so a refusal
      // that printed only org/project/repo could show two IDENTICAL-looking
      // triples and no reason for the refusal — the single most confusing
      // refusal this fence can emit, and the one a legacy-collection maintainer
      // hits first now that an unstated collection no longer matches a present
      // one. `_collectionLabel` renders absence as `<default-collection>` so the two
      // sides are visibly different rather than both blank.
      `refusing to complete ${reasonText(repoRef.org)}/${_collectionLabel(repoRef.collection)}/` +
        `${reasonText(repoRef.project)}/${reasonText(repoRef.repo)}` +
        `!${selfRepo.displayPrId(prRef && prRef.prId)} — this repo derives as ${reasonText(selfAdo.org)}/` +
        `${_collectionLabel(selfAdo.collection)}/${reasonText(selfAdo.project)}/${reasonText(selfAdo.repo)}. ` +
        `A PR may only be completed on the repo ` +
        `you ARE. upstream-issue-hygiene.md MUST-4 (Open, Never Complete) — the ` +
        `downstream upflow lane opens a PR against its upstream and stops there.`,
      { self: selfAdo, target: repoRef },
    );
  }
  // -------------------------------------------------------------------------

  const prId = prRef.prId;
  if (
    (typeof prId !== "string" && typeof prId !== "number") ||
    !ADO_PR_ID_RE.test(String(prId))
  ) {
    return _fail(
      "completeUpflowPR: prId invalid",
      `prId must match /^[0-9]+$/ (PR id); got ${reasonOperand(prId)}`,
    );
  }
  // THE PATH IS BUILT FROM THE DERIVED IDENTITY, NOT FROM `repoRef`.
  // `isSelfRepoAdo` compares NORMALIZED components (lowercased, trailing `.git`
  // stripped, `_git` dropped) but the raw `repoRef` was what this path used to
  // interpolate, so check and use were different strings and the invariant held
  // only up to normalization equivalence — not the "you may only complete a PR
  // on the repo you ARE" it states. That gap is REACHABLE on this provider:
  // `ado-login.js:61-62` ADO_PROJECT_RE / ADO_REPO_RE are
  // /^[A-Za-z0-9._-]{1,64}$/ — dots permitted — so `repoRef.repo = "coc-rs.git"`
  // normalizes to `coc-rs`, compares EQUAL to a self derived as `coc-rs`, and
  // the completion then went out against a path naming `coc-rs.git`. `org` is
  // not a lever (ADO_ORG_RE at ado-login.js:52 admits neither dots nor
  // underscores), but project and repo both are. Sourcing all three from
  // `selfAdo` makes check and use the same bytes by construction —
  // `security.md` § Path Containment's principle one surface over: resolve to
  // the canonical form, then USE the canonical form. `prId` still comes from
  // `prRef`; it names the PR, not the repo.
  //
  // Behavior note, stated rather than glossed — TWO folds, not one. Both are
  // applied by `normalizeComponent` to the DERIVED value, so both change the
  // bytes this request is addressed to:
  //   (1) CASE — `selfAdo.*` is case-FOLDED, so a mixed-case org/project/repo
  //       is now addressed in lowercase.
  //   (2) TRAILING `.git` — it is STRIPPED. For the ordinary remote this is
  //       correct and is the point: `.../_git/coc-rs.git` names the repo
  //       `coc-rs`, and git's own `.git` suffix convention is what is being
  //       removed. But it is a LOSSY fold over the provider namespace, not a
  //       canonicalization, and ADO_REPO_RE (`ado-login.js:61-62`,
  //       /^[A-Za-z0-9._-]{1,64}$/) permits dots — so IF Azure DevOps allows a
  //       repository literally NAMED `foo.git`, a remote for it would derive as
  //       `foo` and this PATCH would address a DIFFERENT repository. Whether
  //       ADO permits such a name is NOT established here and is deliberately
  //       not asserted either way; it is recorded so the next reader knows the
  //       question is open rather than cleared. The direction of the residual
  //       is bounded: it can only mis-address WITHIN the same org/project, and
  //       only for a name whose existence is unconfirmed.
  // Every other difference from `repoRef` was already accepted as equal by the
  // check immediately above.
  // COLLECTION IS PART OF THE AUTHORIZATION QUAD BUT NOT OF THIS PATH, so a
  // non-default collection is REFUSED rather than silently dropped. The fence
  // above authorizes on {org, project, repo, collection}; the PATCH below is
  // addressed with only the first three, so on a legacy TFS/VSTS remote
  // (`<org>.visualstudio.com/OtherCollection/<proj>/_git/<repo>`) the check
  // would verify collection `othercollection` on both sides and ALLOW, while
  // the request resolved under the DEFAULT collection — authorized for repo A,
  // delivered to repo B. That is precisely the check-vs-use divergence the
  // comment above claims to have eliminated by sourcing from `selfAdo`; the
  // claim was true for three components and false for the fourth.
  //
  // Fail CLOSED until the legacy collection-scoped REST routing is verified.
  // This costs nothing on the three modern forms, which all derive
  // `collection === null`.
  // NON-DEFAULT only. `_normalizeCollection` resolves an ABSENT collection to the
  // DEFAULT one, so `collection === "defaultcollection"` is the ordinary modern
  // case and IS addressable collection-free. An earlier cut of this guard
  // refused on `!= null`, which reddened two fixture cases that must ALLOW
  // (`ado/allow-own-repo-legacy-collection-form`,
  // `ado/mixed-form-triangular-default-collection-allows`) — over-refusal is a
  // failure too, and the fixtures caught it.
  const _selfCollection =
    selfAdo.collection === null || selfAdo.collection === undefined
      ? selfRepo._ADO_DEFAULT_COLLECTION
      : String(selfAdo.collection).toLowerCase();
  if (_selfCollection !== selfRepo._ADO_DEFAULT_COLLECTION) {
    return _fail(
      "completeUpflowPR: non-default ADO collection unsupported",
      `this tree derives collection ${reasonText(_selfCollection)}, and the ` +
        `completion endpoint is addressed without a collection segment — so an authorization ` +
        `granted for that collection would be delivered under the default one. Refusing ` +
        `rather than mis-addressing (upstream-issue-hygiene.md MUST-4).`,
    );
  }

  const { org, project, repo } = selfAdo;
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
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "completeUpflowPR: complete failed",
      `ADO pullrequests/${reasonText(prId)} PATCH → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
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
