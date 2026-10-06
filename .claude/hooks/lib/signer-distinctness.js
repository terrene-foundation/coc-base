/**
 * signer-distinctness.js — the ONE canonical answer to "are these two signatures
 * from DIFFERENT principals?", for every 2-of-N quorum predicate in the fold.
 *
 * WHY THIS FILE EXISTS. The substrate carried FOUR different notions of "the same
 * human" and the fold — the layer whose stated job is "even if the hook is
 * bypassed, the fold engine refuses" (`coordination-log.js`) — used the WEAKEST
 * of them. MEASURED before this module, with a firing control
 * (`gate-matrix.js` returned 6 hits for the normalizers on the same tree):
 *
 *   activation, tier-4 today  roster present + genesis anchored  ⇒ ASSUME multi
 *   activation, loom#1896     distinct normalized bound login / principal
 *   hook gate, gate-matrix.js `requester.person_id === approver.person_id`
 *   quorum, THE FOLD          distinct `verified_id` — a KEY FINGERPRINT
 *   normalizeLogin/normalizePrincipal hits in coordination-log.js,
 *   fold-rule-9b.js, fold-rule-9c.js:  0, 0, 0
 *
 * `verified_id` distinctness silently equalled person distinctness only because
 * NO SHIPPED CEREMONY COULD PUT TWO KEYS UNDER ONE `person_id`. `/whoami
 * --add-key` is the first producer that can, and `multi-operator-coordination.md`
 * §1 makes `person_id`, never the fingerprint, the unit of authority — its
 * § MUST NOT says in as many words: "self-approve via a sibling key under the
 * same person_id" is BLOCKED. So the moment that ceremony lands, a single human
 * holding two enrolled keys satisfies every `size < 2` check in the fold, on the
 * roster-edit rule itself. That is `security.md` § Enforcement-Surface Parity's
 * exact shape: an unrecognized→recognized transition that WIDENS.
 *
 * THE FIX IS A SHARED PREDICATE, NOT FOUR PATCHES. `_resolveRosterPerson` is
 * duplicated across three files, which is the drift substrate; a fifth private
 * notion of distinctness would extend it. This mirrors `eligibility.js::
 * isEligibleSigner`, introduced for this same reason and cited in
 * `coordination-log.js` as what closed "drift across rule 5 / 9b / 9c".
 *
 * TWO AXES, and the second is what makes this a root-cause fix rather than a
 * patch. `person_id` alone stops one human's two KEYS. It does NOT stop one human
 * holding two `person_id`s — which is the live shape of this repo's own roster
 * (three person_ids, ONE bound login). The bound provider identity is the coarser
 * key, compared through the SAME normalizers the sock-puppet fence R5-S-07 uses,
 * so "one distinct human" finally means one thing everywhere.
 *
 * DIRECTION OF FAILURE, stated because it bounds the blast radius: this predicate
 * can only ever REFUSE a co-signature the old code accepted. It cannot accept one
 * the old code refused, so it cannot introduce an acceptance vulnerability. The
 * only class it newly refuses is two signatures resolving to one principal — and
 * two genuinely distinct humans never share a `person_id`, a GitHub login, or an
 * Entra UPN, so no legitimate quorum is reachable by it.
 *
 * ABSENT BINDING is NOT treated as a match. A person with no `github_login` and
 * no `principal` contributes only its `pid:` key. That is deliberate: absence is
 * unknown, not sameness, and inventing a match from a missing field would refuse
 * legitimate quorums on an incomplete roster. The `pid:` axis still holds.
 */

"use strict";

const { normalizeLogin } = require("./github-login.js");
const { normalizePrincipal } = require("./ado-login.js");

/**
 * Every canonical identity key a resolved roster person answers to.
 *
 * A COLLISION ON ANY ONE of them means "the same principal". Returning a LIST
 * rather than a single key is what lets one accumulator enforce both axes without
 * the caller choosing between them — the choice is where drift re-enters.
 *
 * @param {string} personId  the roster key (the unit of authority)
 * @param {object} person    the roster person record
 * @returns {string[]} namespaced keys; never empty
 */
function principalKeysFor(personId, person) {
  const keys = [`pid:${String(personId)}`];
  const login = person && person.github_login;
  if (typeof login === "string" && login) {
    const n = normalizeLogin(login);
    if (n) keys.push(`gh:${n}`);
  }
  const principal = person && person.principal;
  if (typeof principal === "string" && principal) {
    const n = normalizePrincipal(principal);
    if (n) keys.push(`ado:${n}`);
  }
  return keys;
}

/**
 * An accumulator over the signers of ONE record.
 *
 * `add()` is all-or-nothing: on a collision it records NOTHING, so a refusing
 * caller and a caller that ignores the result cannot end up with different sets.
 *
 * @returns {{add: function, size: function, has: function}}
 */
function createDistinctSignerSet() {
  const seen = new Set();
  /** @type {Set<string>} one entry per DISTINCT principal admitted */
  const principals = new Set();
  return {
    /**
     * @param {string} personId
     * @param {object} person
     * @returns {{ok: boolean, collidingKey?: string}}
     */
    add(personId, person) {
      const keys = principalKeysFor(personId, person);
      for (const k of keys) {
        if (seen.has(k)) return { ok: false, collidingKey: k };
      }
      for (const k of keys) seen.add(k);
      principals.add(`pid:${String(personId)}`);
      return { ok: true };
    },
    /** How many DISTINCT principals have been admitted. */
    size() {
      return principals.size;
    },
    has(key) {
      return seen.has(key);
    },
  };
}

/**
 * The human-readable half of a refusal. Kept here so all four call sites word it
 * identically — a reason string that differs per site is how an operator learns
 * to read one refusal as more serious than another.
 *
 * @param {string} collidingKey
 * @returns {string}
 */
function describeCollision(collidingKey) {
  if (collidingKey.startsWith("pid:")) {
    return `resolves to the SAME person_id (${collidingKey.slice(4)}) as a prior signer — a second key under one person_id is the same human, and 2-of-N requires two`;
  }
  if (collidingKey.startsWith("gh:")) {
    return `binds the SAME GitHub login (${collidingKey.slice(3)}) as a prior signer — two person_ids held by one human do not make a quorum (sock-puppet defense)`;
  }
  if (collidingKey.startsWith("ado:")) {
    return `binds the SAME Entra principal (${collidingKey.slice(4)}) as a prior signer — two person_ids held by one human do not make a quorum (sock-puppet defense)`;
  }
  return `is not distinct from a prior signer (${collidingKey})`;
}

module.exports = {
  principalKeysFor,
  createDistinctSignerSet,
  describeCollision,
};
