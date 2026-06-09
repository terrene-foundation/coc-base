/**
 * ado-login — validators + case-insensitive equality for Azure DevOps
 * principals (Entra/AAD userPrincipalName) and ADO repo-ref components
 * (organization / project / repository) used in ceremony endpoint
 * construction.
 *
 * Sibling to `github-login.js` (the GitHub provider's identity helper).
 * Both are consumed through the provider-adapter layer (`vcs-provider.js`);
 * the substrate's fold rules + signing stay provider-neutral.
 *
 * Identity model (per the Azure DevOps port decision — Entra UPN + group
 * membership):
 *   - An ADO operator binds to their Entra (AAD) userPrincipalName — an
 *     email-like string `<local>@<domain>`. This is the `principal` field
 *     on a person record (the ADO analogue of `github_login`).
 *   - "admin" is membership in the org's Project Collection Administrators
 *     group, resolved via the ADO Graph API (see `ado-api-allowlist.js`
 *     `_allowlistAdoOrgAdmin`). The UPN is the identity the attestation
 *     binds to.
 *
 * Case-insensitivity (mirrors github-login.js rationale):
 *   Entra resolves UPNs case-INSENSITIVELY (`Alice@contoso.com` and
 *   `alice@contoso.com` are the same principal). ALL substrate comparisons
 *   of ADO principals MUST route through `principalsEqual`, exactly as
 *   GitHub login comparisons route through `loginsEqual`. A bare `===`
 *   re-opens the sock-puppet-via-case-mismatch class (`github-login.js`
 *   F14 C2 iter-3).
 *
 * Endpoint-injection safety (mirrors github-login.js HIGH-3):
 *   org / project / repo names are interpolated into ADO REST endpoint
 *   strings. Validating BEFORE interpolation closes the path-traversal /
 *   shell-metachar / query-fragment injection surface
 *   (`rules/security.md` § Input Validation).
 *
 * Style: CommonJS, zero-dep, pure functions. No I/O. Returns
 *   `{valid: true}` / `{valid: false, reason}`. NEVER throws — the ceremony
 *   state-machine surfaces the reason per `rules/zero-tolerance.md` Rule 3.
 */

"use strict";

// Entra userPrincipalName: `<local>@<domain>`. Conservative ASCII-only
// pattern — local part allows the RFC-5322-subset Entra actually issues
// (alphanumeric + . _ % + -), domain is dot-separated labels with a 2+ char
// TLD. ASCII-only by construction (the non-ASCII guard in normalizePrincipal
// is the structural defense; this pattern documents the accepted charset).
const ADO_UPN_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// ADO organization name: 1-63 chars, alphanumeric + hyphen, no leading or
// trailing hyphen. Mirrors the constraint Azure DevOps enforces at org
// creation. The org is interpolated into the REST host/path.
const ADO_ORG_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

// ADO project + repository names: Azure DevOps permits spaces and a wider
// charset in display names, but REST endpoints take either the GUID id or a
// URL-safe slug. For endpoint-injection safety the substrate requires the
// URL-safe form: 1-64 chars, alphanumeric + dot + underscore + hyphen (NO
// spaces, NO slashes — operators pass the project/repo ID or a slug). A
// project carrying spaces in its display name MUST be referenced by its
// GUID (which matches this pattern) per the runbook.
const ADO_PROJECT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ADO_REPO_RE = /^[A-Za-z0-9._-]{1,64}$/;

function validatePrincipal(s) {
  if (typeof s !== "string") {
    return { valid: false, reason: "must be string" };
  }
  if (!ADO_UPN_RE.test(s)) {
    return {
      valid: false,
      reason: `not a valid Entra userPrincipalName (expected <local>@<domain>): ${JSON.stringify(s)}`,
    };
  }
  return { valid: true };
}

function validateAdoOrg(s) {
  if (typeof s !== "string") {
    return { valid: false, reason: "must be string" };
  }
  if (!ADO_ORG_RE.test(s)) {
    return {
      valid: false,
      reason: `not a valid Azure DevOps organization name: ${JSON.stringify(s)}`,
    };
  }
  return { valid: true };
}

function validateAdoProject(s) {
  if (typeof s !== "string") {
    return { valid: false, reason: "must be string" };
  }
  if (!ADO_PROJECT_RE.test(s)) {
    return {
      valid: false,
      reason: `not a valid Azure DevOps project ref (use the GUID or a URL-safe slug; no spaces/slashes): ${JSON.stringify(s)}`,
    };
  }
  return { valid: true };
}

function validateAdoRepo(s) {
  if (typeof s !== "string") {
    return { valid: false, reason: "must be string" };
  }
  if (!ADO_REPO_RE.test(s)) {
    return {
      valid: false,
      reason: `not a valid Azure DevOps repository ref (use the GUID or a URL-safe slug; no spaces/slashes): ${JSON.stringify(s)}`,
    };
  }
  return { valid: true };
}

/**
 * normalizePrincipal — lowercase a candidate UPN. Returns null on
 * non-string, empty, or non-ASCII input. The canonical normalization used
 * by every ADO principal comparison.
 *
 * Defense-in-depth (mirrors github-login.js::normalizeLogin LOW-R4-5):
 * UPNs are ASCII per the Entra-issued charset; rejecting non-ASCII BEFORE
 * `.toLowerCase()` closes the locale-aware case-fold attack surface (e.g.
 * Turkish "İ".toLowerCase() → "i" on locale-aware engines). Node's
 * `.toLowerCase()` is locale-independent, but the ASCII guard makes the
 * property structural, not engine-dependent.
 *
 * @param {*} principal
 * @returns {string|null}
 */
function normalizePrincipal(principal) {
  if (typeof principal !== "string") return null;
  if (principal.length === 0) return null;
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(principal)) return null;
  return principal.toLowerCase();
}

/**
 * principalsEqual — case-insensitive equality. Both sides normalized via
 * `normalizePrincipal`. Returns false if either side is non-string / empty
 * / non-ASCII (NOT truthy, NOT throws — false-safe predicate).
 *
 * Use this for ALL substrate ADO-principal comparisons. Bare `a === b` on
 * principal fields is the sock-puppet-via-case-mismatch surface.
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function principalsEqual(a, b) {
  const na = normalizePrincipal(a);
  const nb = normalizePrincipal(b);
  return na !== null && nb !== null && na === nb;
}

module.exports = {
  validatePrincipal,
  validateAdoOrg,
  validateAdoProject,
  validateAdoRepo,
  normalizePrincipal,
  principalsEqual,
  // Patterns exposed for downstream tests that assert the contract.
  _ADO_UPN_RE: ADO_UPN_RE,
  _ADO_ORG_RE: ADO_ORG_RE,
  _ADO_PROJECT_RE: ADO_PROJECT_RE,
  _ADO_REPO_RE: ADO_REPO_RE,
};
