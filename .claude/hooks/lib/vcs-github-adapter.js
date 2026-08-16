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
const {
  sanitizeForReason,
  reasonText,
  reasonOperand,
  reasonFromError,
} = require("./upflow-self-repo.js");

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
  if (!o.valid) {
    return { valid: false, reason: `repoRef.owner ${reasonText(o.reason)}` };
  }
  const n = githubLogin.validateGithubRepoName(ref.name);
  if (!n.valid) {
    return { valid: false, reason: `repoRef.name ${reasonText(n.reason)}` };
  }
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
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "gh api repos call failed",
      `gh api repos/${reasonText(repoRef.owner)}/${reasonText(repoRef.name)} → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  if (!r.body || !r.body.owner || typeof r.body.owner.login !== "string") {
    return _fail(
      "gh api repos response malformed",
      `expected body.owner.login; got ${reasonOperand(r.body)}`,
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
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "org membership check failed",
      `gh api orgs/${reasonText(org)}/memberships/${reasonText(principal)} → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  if (!r.body || typeof r.body.role !== "string") {
    return _fail(
      "org membership response malformed",
      `expected body.role; got ${reasonOperand(r.body)}`,
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
      `sha must match /^[0-9a-f]{7,64}$/ (commit-hash shape); got ${reasonOperand(sha)}`,
    );
  }
  const captureTs = (opts && opts.capture_ts) || new Date().toISOString();
  let r;
  try {
    r = transport(`repos/${repoRef.owner}/${repoRef.name}/commits/${sha}`);
  } catch (err) {
    return _fail(
      "gh api commits call threw",
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "gh api root-commit call failed",
      `gh api commits/${reasonText(sha)} → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
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
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "gh api collaborators call failed",
      `gh api repos/${reasonText(repoRef.owner)}/${reasonText(repoRef.name)}/collaborators → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
      { status: r && r.status, body: r && r.body },
    );
  }
  if (!Array.isArray(r.body)) {
    return _fail(
      "gh api collaborators response malformed",
      `expected array body; got ${reasonOperand(r.body)}`,
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
//
// SCOPE OF THE DEPLOY LANE — these primitives take an ARBITRARY `repoRef` BY
// DESIGN, and that is stated here because it previously was not stated
// anywhere. `_dispatchWorkflow` (and therefore `pushImage` /
// `applyDeployTarget`) and `invalidateCache` validate `repoRef` for SHAPE only
// and then interpolate it into the endpoint. There is NO self-repo derivation
// and NO host check on this lane.
//
// That is a LARGER capability than the one `completeUpflowPR` fences: a
// `workflow_dispatch` against any repo the token can write to runs CI in that
// repo, where the fenced primitive only merges one already-open PR. So the
// absence of a fence here is not "less dangerous", it is a DIFFERENT LANE.
//
// `upstream-issue-hygiene.md` MUST-4 does NOT cover it — MUST-4 is scoped to
// "Open, Never Complete" on the upflow PR lane, and deploy-target selection is
// the consumer's decision. WHICH rule (if any) governs that selection is an
// OPEN QUESTION, named here as open rather than implied answered; do not read
// this paragraph as an argument that no fence is needed, only as an accurate
// statement of what exists today. Recorded per the house style the ADO cache
// stub already follows in `vcs-azure-adapter.js`, which names its residual and
// cites the rule it rests on.

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
  if (!rv.valid)
    return _fail(`${label}: repoRef invalid`, reasonText(rv.reason));
  const workflow = descriptor.workflow;
  if (typeof workflow !== "string" || !WORKFLOW_ID_RE.test(workflow)) {
    return _fail(
      `${label}: workflow id invalid`,
      `workflow must match /^[A-Za-z0-9._-]+$/ (filename or numeric id); got ${reasonOperand(workflow)}`,
    );
  }
  const ref = descriptor.ref === undefined ? "main" : descriptor.ref;
  if (typeof ref !== "string" || !GIT_REF_RE.test(ref)) {
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
  let r;
  try {
    r = transport(
      `repos/${repoRef.owner}/${repoRef.name}/actions/workflows/${workflow}/dispatches`,
      { method: "POST", fields: { ref, inputs } },
    );
  } catch (err) {
    return _fail(
      `${label}: dispatch threw`,
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      `${label}: dispatch failed`,
      `POST actions/workflows/${reasonText(workflow)}/dispatches → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
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
  if (!rv.valid)
    return _fail("invalidateCache: repoRef invalid", reasonText(rv.reason));
  const key = scope.key;
  if (typeof key !== "string" || !CACHE_KEY_RE.test(key)) {
    return _fail(
      "invalidateCache: cache key invalid",
      `key must match /^[A-Za-z0-9._/-]+$/ (bounded, query-safe charset); got ${reasonOperand(key)}`,
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
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "invalidateCache: delete failed",
      `DELETE actions/caches?key=${reasonText(key)} → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
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

// The hosts this adapter's transport actually talks to. `gh api` targets
// github.com unless configured otherwise, so a derived identity from any OTHER
// host is not an identity ON the repo this adapter would merge.
//
// DELIBERATELY github.com-ONLY. This repo carries no GitHub Enterprise host
// configuration to read: the one GHES token in the tree is
// `genesis-ceremony.js`'s `host === "ghes-shared-appliance"`, which is a
// deployment-KIND enum in the genesis-migration routing matrix, not a hostname,
// and `ecosystem-config.mjs`'s `registry.host` is a CONTAINER-registry host.
// Inventing a host convention here would be a guess, so the set is closed and
// the refusal below SAYS the limit rather than silently allowing everything
// else. A GHES deployment adds its appliance host here, with its own transport.
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * Open the human-gated upflow PR (the consumer has already pushed `head` and
 * staged the inbox proposal YAML on it). descriptor:
 *   { repoRef:{owner,name}, head, base?, title, body? }.
 * head/base reach BODY positions only (no path-injection); guarded for shape.
 */
function createUpflowPR(transport, prSpec) {
  const repoRef = prSpec && prSpec.repoRef;
  const rv = validateRepoRef(repoRef);
  if (!rv.valid)
    return _fail("createUpflowPR: repoRef invalid", reasonText(rv.reason));
  const head = prSpec.head;
  if (
    typeof head !== "string" ||
    !GIT_REF_RE.test(head) ||
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
    !GIT_REF_RE.test(base) ||
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
  let r;
  try {
    r = transport(`repos/${repoRef.owner}/${repoRef.name}/pulls`, {
      method: "POST",
      fields: { title, head, base, body },
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
      `POST repos/${reasonText(repoRef.owner)}/${reasonText(repoRef.name)}/pulls → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
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
  const labels = issueSpec.labels;
  if (
    labels !== undefined &&
    (!Array.isArray(labels) || !labels.every((l) => typeof l === "string"))
  ) {
    return _fail(
      "createUpflowIssue: labels invalid",
      `labels must be an array of strings; got ${reasonOperand(labels)}`,
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
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "createUpflowIssue: create failed",
      `POST repos/${reasonText(repoRef.owner)}/${reasonText(repoRef.name)}/issues → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
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
 *
 * MAINTAINER-SIDE ONLY — NEVER on the downstream upflow lane.
 * `upstream-issue-hygiene.md` MUST-4 ("Open, Never Complete"): a downstream
 * consumer's Step-7c upflow OPENS a PR against its upstream and STOPS. Merging
 * is the upstream maintainer's act, on the upstream's own repo, after the
 * `/sync-from-downstream` scrub + review-as-untrusted-data.
 *
 * THE FENCE DERIVES THE SELF-IDENTITY; IT DOES NOT ACCEPT ONE. There is
 * deliberately NO `selfRepoRef` descriptor field. The first cut took one, and a
 * Tier-1 redteam correctly found that both operands then came off the same
 * caller-authored object — `{repoRef: X, selfRepoRef: X}` cleared it trivially,
 * so the fence stopped an ACCIDENT but not an agent that had decided to merge.
 * `upflow-self-repo.js::deriveSelfRepoRef` derives the identity from the LIVE
 * GIT REMOTE of this working tree, which is the SOLE authoritative source: it
 * runs `git remote get-url origin` and parses it, and refuses if that yields no
 * owner/name pair. There is no directory-name fallback. `.claude/VERSION::repo`
 * is read only as a CROSS-CHECK — it can REFUSE the derivation by disagreeing
 * with the remote, but it can never SUPPLY the identity, so a forged VERSION
 * file can only deny a completion, never authorize one.
 *
 * WHAT THAT IS AND IS NOT EVIDENCE OF. The fence refuses any completion whose
 * target does not match the identity derived from the working tree the process
 * runs in. It CLOSES the accident class — which IS the originating incident —
 * and raises the cost of a deliberate act. It is NOT a boundary against a caller
 * that can choose its own working directory: `process.cwd()` is selected by
 * whoever launches the process, so a scratch tree with `origin` pointed at the
 * upstream derives that upstream and clears the fence. It cannot be such a
 * boundary — a caller running arbitrary code in-process can replace
 * `upflow-self-repo.js` outright. Removing the descriptor seams was still
 * correct: they were forgeable by writing one object literal.
 *
 * THE HOST IS PART OF THE IDENTITY. `deriveSelfRepoRef` returns an owner/name
 * pair for a remote on ANY host, so the pair alone does not say WHERE the repo
 * lives; the fence below therefore checks `self.host` against `GITHUB_HOSTS` and
 * refuses a non-GitHub identity, plus an ADO one, before the owner/name compare.
 * Without the host check an internal mirror of an upstream template — an
 * ordinary thing to have — derived to the upstream's path and cleared a merge
 * that would have gone to github.com, a different repo than the remote names.
 *
 * NO DESCRIPTOR FIELD FEEDS THE DERIVATION. `deriveSelfRepoRef` takes exactly
 * one parameter and this call site hardcodes `process.cwd()`, so the descriptor
 * carries no `selfRepoRef`, no deriver, and no `cwd`. Two earlier rounds each
 * MOVED the caller-authored operand (`selfRepoRef` → `_deriveSelfFn` → `cwd`)
 * rather than removing it, and each move left the answer one field away.
 *
 * That is a claim about the DESCRIPTOR, and only about the descriptor. It does
 * NOT mean the identity is out of a caller's reach: the working directory still
 * selects it, exactly as the bound above states. Nothing in this paragraph
 * narrows that bound.
 */
function completeUpflowPR(transport, prRef) {
  const repoRef = prRef && prRef.repoRef;
  const rv = validateRepoRef(repoRef);
  if (!rv.valid)
    return _fail("completeUpflowPR: repoRef invalid", reasonText(rv.reason));

  // --- Open-Never-Complete fence (upstream-issue-hygiene.md MUST-4) ---------
  // Fails CLOSED on every branch: underivable identity, disagreeing identity,
  // and non-self target all refuse BEFORE the transport fires.
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
  // The derived identity must be an identity on a host THIS adapter serves.
  // `deriveSelfRepoRef` returns an owner/name pair for ANY host — the pair alone
  // carries no host, so without this check a tree whose origin is an internal
  // mirror (`https://<internal-host>/<org>/<repo>`) derives as `<org>/<repo>`,
  // matches a github.com target with the same path, and authorizes a merge on a
  // DIFFERENT repo than the remote names. Fails closed on any unrecognized host.
  if (!GITHUB_HOSTS.has(d.self.host)) {
    return _fail(
      "completeUpflowPR: non-GitHub self-identity refused",
      `refusing to merge ${reasonText(repoRef.owner)}/${reasonText(repoRef.name)}#${selfRepo.displayPrId(prRef && prRef.prId)} — ` +
        `this working tree's origin remote is on host ${reasonText(d.self.host)}, which this ` +
        `adapter does not serve (recognized: ${[...GITHUB_HOSTS].join(", ")}; a ` +
        `GitHub Enterprise appliance host is NOT configured in this repo, so it is ` +
        `NOT accepted). An owner/name pair derived from another host does not ` +
        `identify the github.com repo this merge would target. ` +
        `upstream-issue-hygiene.md MUST-4 (Open, Never Complete).`,
      { self: d.self, target: repoRef },
    );
  }
  // Mirror image of the ADO adapter's `if (!selfAdo)` refusal, landing in the
  // SAME change (`security.md` § Enforcement-Surface Parity): each adapter must
  // refuse an identity belonging to the OTHER provider, or the un-fenced one is
  // the bypass. Against the CURRENT ADO host set this is unreachable — every
  // host `_parseAdo` recognizes (dev.azure.com, ssh.dev.azure.com,
  // *.visualstudio.com) already fails GITHUB_HOSTS above. It is kept as the
  // explicit statement of the invariant, so the parity holds if either host set
  // ever changes.
  if (d.self.ado !== null) {
    return _fail(
      "completeUpflowPR: Azure DevOps self-identity refused",
      `refusing to merge ${reasonText(repoRef.owner)}/${reasonText(repoRef.name)}#${selfRepo.displayPrId(prRef && prRef.prId)} — ` +
        `this working tree's origin remote is an Azure DevOps remote ` +
        `(${reasonText(d.self.ado.org)}/${reasonText(d.self.ado.project)}/${reasonText(d.self.ado.repo)}), so it cannot ` +
        `establish a GitHub identity. upstream-issue-hygiene.md MUST-4 ` +
        `(Open, Never Complete).`,
      { self: d.self, target: repoRef },
    );
  }
  if (!selfRepo.isSelfRepo(repoRef, d.self)) {
    return _fail(
      "completeUpflowPR: cross-repo completion refused",
      `refusing to merge ${reasonText(repoRef.owner)}/${reasonText(repoRef.name)}#${selfRepo.displayPrId(prRef && prRef.prId)} — ` +
        `this repo derives as ${reasonText(d.self.owner)}/${reasonText(d.self.name)}. A PR may only be ` +
        `completed on the repo you ARE. upstream-issue-hygiene.md MUST-4 ` +
        `(Open, Never Complete) — the downstream upflow lane opens a PR against its ` +
        `upstream and stops there; the upstream merges it after ` +
        `/sync-from-downstream review.`,
      { self: d.self, target: repoRef },
    );
  }
  // -------------------------------------------------------------------------

  const prId = prRef.prId;
  if (
    (typeof prId !== "string" && typeof prId !== "number") ||
    !PR_NUMBER_RE.test(String(prId))
  ) {
    return _fail(
      "completeUpflowPR: prId invalid",
      `prId must match /^[0-9]+$/ (PR number); got ${reasonOperand(prId)}`,
    );
  }
  const mergeMethod =
    prRef.mergeMethod === undefined ? "merge" : prRef.mergeMethod;
  if (typeof mergeMethod !== "string" || !MERGE_METHOD_RE.test(mergeMethod)) {
    return _fail(
      "completeUpflowPR: mergeMethod invalid",
      `mergeMethod must be one of merge|squash|rebase; got ${reasonOperand(mergeMethod)}`,
    );
  }
  // THE PATH IS BUILT FROM THE DERIVED IDENTITY, NOT FROM `repoRef`.
  // `isSelfRepo` compares NORMALIZED components (lowercased, trailing `.git`
  // stripped, `_git` dropped) but the raw `repoRef` was what this path used to
  // interpolate, so check and use were different strings and the invariant held
  // only up to normalization equivalence — not the "you may only complete a PR
  // on the repo you ARE" it states. Sourcing the path from `d.self` makes them
  // the same bytes by construction. This is `security.md` § Path Containment's
  // principle one surface over: resolve to the canonical form, then USE the
  // canonical form. `prId` still comes from `prRef` — it names the PR, not the
  // repo, and the fence makes no claim about it.
  //
  // On GitHub this specific divergence is likely unreachable today
  // (`GITHUB_LOGIN_RE` forbids dots in owner, and GitHub rejects repo names
  // ending `.git` at creation), so the fix is structural rather than a
  // reachable-bug fix here. It is applied anyway: reachability rests on a live
  // provider's behavior, which is not verifiable from this repo, and the ADO
  // twin IS reachable through its dot-permitting repo pattern.
  //
  // Behavior note, stated rather than glossed: `d.self.*` is case-FOLDED by
  // `normalizeComponent`, so a mixed-case repo is now addressed in lowercase.
  // Every other difference from `repoRef` was already accepted as equal by the
  // check immediately above.
  let r;
  try {
    r = transport(
      `repos/${d.self.owner}/${d.self.name}/pulls/${String(prId)}/merge`,
      { method: "PUT", fields: { merge_method: mergeMethod } },
    );
  } catch (err) {
    return _fail(
      "completeUpflowPR: merge threw",
      `network unavailable or transport threw: ${reasonFromError(err)}`,
    );
  }
  if (!r || !r.ok) {
    return _fail(
      "completeUpflowPR: merge failed",
      `PUT pulls/${reasonText(prId)}/merge → status ${reasonOperand(r && r.status)} body ${reasonOperand(r && r.body)}`,
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
