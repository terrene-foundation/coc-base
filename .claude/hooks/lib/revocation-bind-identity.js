/**
 * revocation-bind-identity — the ONE resolution of "which roster field binds
 * the victim named by this record, and how are two of them compared".
 *
 * WHY THIS MODULE EXISTS (S61 round-3 CRITICAL-1)
 *   A `collaborator-distinctness-revocation` names its victim by a
 *   PROVIDER-SPECIFIC field: `github_login` on GitHub, `principal` (Entra UPN)
 *   on Azure DevOps. Four modules independently spelled that dispatch inline —
 *   `fold-rule-10.js`, `derive-n.js`, `fold-rule-reap.js` — and
 *   `coordination-log.js::_collectVictimChainEntries` DID NOT. It read
 *   `content.github_login` unconditionally and early-returned when it was
 *   absent, which is ALWAYS on ADO.
 *
 *   Net effect, MEASURED end-to-end through `foldLog` on a roster where the
 *   victim was actively heartbeating inside the evidence window:
 *       provider=github        → contestedRevocations=1   (rule 10 fires)
 *       provider=azure-devops  → contestedRevocations=0   (rule 10 INERT)
 *   Rule 10 is the anti-hostile-revocation defense and it is the ONLY
 *   fold-time one — `_validateRevocationShape` never inspects the members
 *   capture, and the ceremony's org-membership check runs on the EMITTING
 *   clone, which an attacker simply does not run. With no victim chain
 *   collected, the contest loop body never executes, nothing stamps
 *   `rule10_contested`, and `derive-n` drops the victim from `liveLogins` —
 *   moving derived_N, the QUORUM DENOMINATOR.
 *
 *   It shipped because the ADO lifecycle test calls `foldRevocation` DIRECTLY
 *   with a hand-injected `victimChainEntries`. That test passes its negative
 *   control and is structurally blind to "the collector never supplies the
 *   entry" — `evidence-first-claims.md` MUST-6: its green covers the CONTEST
 *   logic and EXCLUDES evidence COLLECTION.
 *
 * WHY A SHARED MODULE rather than a fifth inline spelling: `security.md`
 * § Enforcement-Surface Parity. A dispatch replicated per-site drifts per-site,
 * and this defect IS that drift — three sites had it, the fourth did not, and
 * the one that did not is the one that gates the protection.
 *
 * FAIL-CLOSED ON AN UNKNOWN PROVIDER. An unrecognised `content.provider` does
 * NOT fall back to the GitHub field: falling back would read `github_login`
 * off a record that does not use it, find nothing, and reproduce exactly the
 * silent-empty-evidence behaviour this module exists to remove. Callers get
 * `{ ok: false, reason }` and MUST route it to their INDETERMINATE disposition.
 * An ABSENT provider is a different case and DOES default to github — that is
 * the documented backward-compatible shape (`vcs-provider.js`: absent ⇒
 * "github"), and every pre-ADO record on every existing chain relies on it.
 */

const { loginsEqual } = require("./github-login.js");
const { principalsEqual } = require("./ado-login.js");
// S61 round-4 CRITICAL-1 — the ONE shared "unsafe object key" predicate, the
// same one `genesis-anchor-guard.js::verifyRecord` and `fold-rule-9c.js` use.
// Imported rather than re-derived so this refusal cannot drift from theirs.
const { isUnsafeMapKey } = require("./roster-schema-validate.js");

/** Roster/record field that binds a victim identity, per provider. */
const BIND_FIELD_BY_PROVIDER = Object.freeze({
  github: "github_login",
  "azure-devops": "principal",
});

/** Identity comparator, per provider. Both are case-insensitive by host rule. */
const COMPARATOR_BY_PROVIDER = Object.freeze({
  github: loginsEqual,
  "azure-devops": principalsEqual,
});

const DEFAULT_PROVIDER_ID = "github";

/**
 * Resolve the bind field + comparator for a record's `content`.
 *
 * @param {object} content — a coordination-log record's `content`
 * @returns {{ok: true, provider: string, bindField: string, equals: function}
 *          | {ok: false, reason: string}}
 */
function resolveBindIdentity(content, opts) {
  const provider =
    content && content.provider !== undefined && content.provider !== null
      ? content.provider
      : DEFAULT_PROVIDER_ID;

  // S61 round-4 CRITICAL-1 — PROTOTYPE-SAFE LOOKUP. `Object.freeze` prevents
  // MUTATION; it does not remove the PROTOTYPE CHAIN. `BIND_FIELD_BY_PROVIDER`
  // is a plain object, so `M["constructor"]` (and 11 siblings) resolved TRUTHY
  // and sailed through the old `!BIND_FIELD_BY_PROVIDER[provider]` guard,
  // handing back a FUNCTION as `bindField`. `namedIdentity` then returned null,
  // the collector took its silent early return, and `foldRevocation` admitted
  // the revocation on absent evidence — the exact fail-open this module was
  // built to close, reproduced inside the fix itself.
  //
  // MEASURED before this guard: all 12 `Object.getOwnPropertyNames(
  // Object.prototype)` spellings resolved ok:true with a function/object bind
  // field, while a genuinely-absent provider correctly refused.
  //
  // Two structural fences, the SAME pair `genesis-anchor-guard.js::verifyRecord`
  // uses — deliberately not a third shape:
  //   (a) `isUnsafeMapKey` — the shared predicate, structural not a denylist;
  //   (b) `hasOwnProperty` — an inherited member is never a declared provider.
  // Unlike at verifyRecord, (b) is NOT redundant here: this map is a source
  // literal, not a `JSON.parse` product, so a caller could in principle reach
  // it with a key (a) does not name. Both are cheap; both stay.
  if (typeof provider !== "string" || isUnsafeMapKey(provider)) {
    return {
      ok: false,
      reason:
        `record provider ${JSON.stringify(provider)} is not a safe object key ` +
        `— it shadows a JavaScript Object.prototype member, so a bare lookup ` +
        `would resolve to a prototype method rather than a declared provider.`,
    };
  }
  if (
    !Object.prototype.hasOwnProperty.call(BIND_FIELD_BY_PROVIDER, provider)
  ) {
    return {
      ok: false,
      reason:
        `unknown record provider ${JSON.stringify(provider)} — cannot resolve ` +
        `which roster field binds the named identity, so the check cannot run. ` +
        `Refusing rather than defaulting to a field this record does not use.`,
    };
  }

  // S61 round-4 CRITICAL-2 — RECORD-vs-ROSTER AGREEMENT. Every dispatch site
  // except `derive-n.js` keys off the RECORD's provider, which the emitter
  // signs; `derive-n.js` keys off the ROSTER's. Nothing enforced that they
  // agree, and derive-n's comment asserted the premise as given.
  //
  // MEASURED on a pure-ADO roster (persons bind via `principal` only), a
  // revocation that simply OMITS `provider` while carrying both id fields:
  //   HONEST (provider declared) → contested=1, per_login_latest={}
  //   ATTACK (provider omitted)  → contested=0, per_login_latest=
  //       {"victim@example.com":{kind:"revocation",seq:0}}
  // The collector defaulted to github, matched no ADO person, collected an
  // empty chain and ADMITTED — while derive-n, keying off the ROSTER, matched
  // the victim and recorded the hostile revocation as their latest state. Rule
  // 10 never examined it. No exotic value required: just an omitted field.
  //
  // Refused HERE rather than by moving derive-n onto the record: derive-n
  // computes the QUORUM DENOMINATOR, and the roster is the PR-gated trust root
  // while the record is attacker-signed. Keying the denominator off attacker
  // data to resolve a disagreement would be strictly worse than refusing it.
  // Because the collector's refusal rejects the record, it never enters
  // `accepted`, so derive-n never sees it either — one fence, both surfaces.
  // S61 round-5 CRITICAL-3 — the roster side resolves ABSENT => DEFAULT, so the
  // comparison is ALWAYS made. The previous form skipped the whole check when
  // `expectedProvider` was undefined, which INVERTED this fence on exactly the
  // rosters it most needed to protect: loom's own production roster declares no
  // `genesis.provider` (measured: genesis keys are repo_owner,
  // repo_owner_kind, root_commit, genesis_generation; 3 persons, all
  // github_login, none with a principal). On such a roster the attacker's
  // signed `provider` won unopposed — CRITICAL-2 mirrored.
  //
  // This was a ONE-LINE SEMANTIC DIVERGENCE, not a missing special case. Every
  // other roster-provider reader in the corpus resolves absent => github
  // (`roster-schema-validate.js:411`, `vcs-provider.js:106`, `derive-n.js:107`),
  // and the SCHEMA states it as contract: "ABSENT ⇒ github (backward-compatible
  // default)". Only this module read absent as "no expectation — skip". The
  // constant reused here is this module's OWN `DEFAULT_PROVIDER_ID`, already
  // applied to the RECORD side a few lines above, so no fourth spelling of the
  // default is introduced — the two sides now share one rule.
  //
  // A genuine ADO ecosystem is unaffected, and the CITATION FOR THAT MATTERS.
  // An earlier revision cited `genesis-ceremony.js:1065, :2277`. That was a
  // WRONG-QUESTION INSTRUMENT and is withdrawn: read at those lines they write
  // `provider` on the RECORD's `content`, not `roster.genesis.provider`. The
  // ceremony READS the roster's provider to dispatch (`:437`, `:1438`) — it
  // presupposes the declaration rather than producing it, so it could never
  // have evidenced this claim.
  //
  // The sound instrument is `roster-schema-validate.js::_validateProviderIdentity`
  // (:437-440): when `genesis.provider` is github OR ABSENT, every enrolled
  // person MUST carry `github_login`. So a provider-less PURE-ADO roster is
  // SCHEMA-INVALID BY CONSTRUCTION — which is precisely what makes
  // `absent => github` safe here rather than merely conventional.
  // MEASURED, discriminating on the error identity rather than on validity:
  //   provider ABSENT   + ADO-only person -> github_login error PRESENT
  //   provider "azure-devops" + same person -> github_login error ABSENT
  const expected = opts && opts.expectedProvider;
  {
    let expectedId;
    if (expected === undefined || expected === null) {
      expectedId = DEFAULT_PROVIDER_ID;
    } else if (typeof expected !== "string" || !expected) {
      // S61 round-5 LOW — REFUSE a non-string expectation rather than coercing
      // it to github. The previous form silently treated `{}`, `['github']`,
      // `0`, `false` and `''` as "github", which is fail-OPEN coercion inside a
      // fail-closed resolver: a caller that hands us a malformed expectation
      // has told us nothing, and "nothing" must not read as "github".
      return {
        ok: false,
        reason:
          `roster provider expectation ${JSON.stringify(expected)} is not a ` +
          `non-empty string — refusing rather than coercing a malformed ` +
          `expectation to a default the caller did not state.`,
      };
    } else {
      expectedId = expected;
    }
    if (expectedId !== provider) {
      return {
        ok: false,
        reason:
          `record provider ${JSON.stringify(provider)} disagrees with the ` +
          `roster's declared provider ${JSON.stringify(expectedId)} — the ` +
          `record names its victim by a field this ecosystem's roster does not ` +
          `bind, so the check cannot run against the identities that exist. ` +
          `Refusing rather than resolving the disagreement in the record's favour.`,
      };
    }
  }

  return {
    ok: true,
    provider,
    bindField: BIND_FIELD_BY_PROVIDER[provider],
    equals: COMPARATOR_BY_PROVIDER[provider],
  };
}

/**
 * The victim identity a record NAMES, resolved through the provider's field.
 * Returns null when the field is absent or not a non-empty string.
 */
function namedIdentity(content, bindField) {
  const v = content && content[bindField];
  return typeof v === "string" && v ? v : null;
}

module.exports = {
  resolveBindIdentity,
  namedIdentity,
  BIND_FIELD_BY_PROVIDER,
  DEFAULT_PROVIDER_ID,
};
