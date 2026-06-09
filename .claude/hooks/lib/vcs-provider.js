/**
 * vcs-provider — the provider-adapter registry for the multi-operator
 * coordination substrate's ceremony surface.
 *
 * The genesis/roster ceremony (enrollment, migration, owner-add/depart,
 * reap) verifies trust-root facts against a version-control host's REST API.
 * Historically that host was GitHub, hardcoded inline. This registry lifts
 * the host behind a provider-adapter interface so the SAME ceremony +
 * SAME fold rules + SAME signing substrate work against either GitHub or
 * Azure DevOps. The host is selected per-repo via `roster.genesis.provider`
 * (absent ⇒ "github", backward-compatible).
 *
 * What stays PROVIDER-NEUTRAL (no adapter involvement):
 *   - The coordination log + per-emitter hash chains + signing (coc-sign.js).
 *   - The fold rules' STRUCTURE (signature verify, chain integrity, fork
 *     detection, monotonic generation, latest-wins supersession). The fold
 *     dispatches on `content.provider` only to pick which capture field name
 *     to read; the verification predicates below that point are identical.
 *   - Freshness ceilings (_isCaptureFresh / *_TTL) — they operate on
 *     capture_ts, not on any provider shape.
 *
 * What the ADAPTER owns (provider-specific):
 *   - REST endpoint construction.
 *   - Response-shape parsing → the canonical capture inner shape.
 *   - Identity validation + case-insensitive equality (github_login vs UPN).
 *   - The outer record-content capture field NAMES (gh_api_* vs ado_api_*).
 *
 * The injected `transport` is paired with the provider: GitHub's is the
 * `ghApi(endpointString)` callable; ADO's is the structured
 * `({service,path}) => {...}` callable. The ceremony resolves
 * `{provider, transport}` together at invocation.
 *
 * Style: CommonJS, zero-dep.
 */

"use strict";

const githubAdapter = require("./vcs-github-adapter.js");
const azureAdapter = require("./vcs-azure-adapter.js");

// The canonical provider id set. `github` is the backward-compat default
// (a record / roster with no `provider` field is GitHub).
const DEFAULT_PROVIDER_ID = "github";

const PROVIDERS = Object.freeze({
  github: githubAdapter,
  "azure-devops": azureAdapter,
});

const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

/**
 * Resolve a provider id (or undefined → default) to its adapter.
 *
 * @param {string|undefined|null} providerId
 * @returns {{ok: true, provider: object, providerId: string} |
 *           {ok: false, reason: string}}
 */
function getProvider(providerId) {
  const id =
    providerId === undefined || providerId === null || providerId === ""
      ? DEFAULT_PROVIDER_ID
      : providerId;
  if (typeof id !== "string") {
    return {
      ok: false,
      reason: `provider id must be a string; got ${typeof id}`,
    };
  }
  const adapter = PROVIDERS[id];
  if (!adapter) {
    return {
      ok: false,
      reason: `unknown provider "${id}" (known: ${PROVIDER_IDS.join(", ")})`,
    };
  }
  return { ok: true, provider: adapter, providerId: id };
}

/**
 * Resolve the provider for a roster (reads roster.genesis.provider; absent
 * ⇒ github). Convenience wrapper used by the ceremony + fold dispatch.
 */
function getProviderForRoster(roster) {
  const pid =
    roster && roster.genesis && roster.genesis.provider
      ? roster.genesis.provider
      : DEFAULT_PROVIDER_ID;
  return getProvider(pid);
}

/**
 * Resolve the provider a coordination-log record's content was authored
 * under (content.provider; absent ⇒ github). Used by the fold dispatch so a
 * GitHub record (no provider field) reads gh_api_* and an ADO record reads
 * ado_api_*.
 */
function getProviderForRecordContent(content) {
  const pid =
    content && content.provider ? content.provider : DEFAULT_PROVIDER_ID;
  return getProvider(pid);
}

module.exports = {
  getProvider,
  getProviderForRoster,
  getProviderForRecordContent,
  PROVIDER_IDS,
  DEFAULT_PROVIDER_ID,
};
