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
const { sanitizeForReason } = require("./upflow-self-repo.js");

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
  // OWN-PROPERTY LOOKUP, not a plain index. `Object.freeze` on an object
  // LITERAL leaves `Object.prototype` on the chain, so `PROVIDERS["constructor"]`
  // (and `toString`, `valueOf`, `hasOwnProperty`, …) resolve to inherited
  // functions — TRUTHY — and the "unknown provider" refusal below never fires
  // for them. The id reaches here from `roster.genesis.provider` and from a
  // coordination-log record's `content.provider`, so it is attacker-authorable.
  // The OUTCOME was already fail-closed (every consumer then calls a method
  // absent on `Function`, throwing), but crash-as-refusal is not the refusal
  // this function documents, and `cc-artifacts.md` Rule 10 wants the positive
  // membership test rather than a truthiness check that inherits.
  const adapter = Object.prototype.hasOwnProperty.call(PROVIDERS, id)
    ? PROVIDERS[id]
    : undefined;
  if (!adapter) {
    return {
      ok: false,
      // SANITIZED + BOUNDED. `id` is attacker-authorable — it arrives from
      // `roster.genesis.provider` and from a coordination-log record's
      // `content.provider`, as the comment above states — and it was
      // interpolated raw and unbounded into a refusal that is logged. A value
      // like "x\nFORGED: ok" put a second line in that output. Uses the same
      // shared helper both adapters use, per `security.md`
      // § Enforcement-Surface Parity: the argument for sanitizing one refusal
      // operand is the argument for all of them.
      reason: `unknown provider "${sanitizeForReason(String(id).slice(0, 64))}" (known: ${PROVIDER_IDS.join(", ")})`,
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
