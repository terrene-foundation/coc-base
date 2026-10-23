/**
 * guard-foundation/identity.js — L1 provider: operator/repo identity facts.
 *
 * WHO is acting, in WHICH repository — as FACTS for L3's scoping decisions,
 * never as an authorization. This provider answers "what identity is
 * established"; it cannot and does not answer "is this operator allowed",
 * which is policy (L3) resting on these facts plus the roster.
 *
 * REQUIRED vs DETAIL:
 *   operatorIdentity     required: operator (the enrolled operator name/ID).
 *     Absence is undetermined — an absent operator is NOT an anonymous
 *     allow, because L3's protected-path branch escalates on undetermined
 *     and degrades to allow on a fabricated empty identity.
 *     detail: operatorId, accountDir, source (may be null).
 *   operatorRepoBinding  required: BOTH halves. It composes
 *     repo-facts.repoIdentity, so a caller that supplies operator facts but
 *     no repo facts gets a bounded undetermined naming the repo half —
 *     never a half-populated binding presented as whole.
 *
 * Facts are CONSUMED from ctx, never gathered ambiently here: env-var
 * discovery and enrollment lookups are the caller's step (`lib/operator-id.js`
 * owns that machinery), and baking an ambient read into the provider would
 * make its verdict depend on invisible state instead of its input.
 *
 * Style: CommonJS, zero-dep, pure (composes repo-facts) — no policy.
 */

"use strict";

const {
  determinedFacts,
  undeterminedFacts,
  missingFactReason,
} = require("./contract.js");
const { repoIdentity } = require("./repo-facts.js");

/**
 * operatorIdentity — THE operator provider.
 *
 * @param {object} ctx - { operator, operatorId?, accountDir?, source? }
 * @returns {{verdict: string, facts: object, reason: string|null, unresolved?: Array}}
 */
function operatorIdentity(ctx = {}) {
  const { operator, operatorId, accountDir, source } = ctx;

  if (typeof operator !== "string" || operator.trim().length === 0) {
    return undeterminedFacts(missingFactReason("operator (enrolled identity; absence is not anonymous)"), {}, []);
  }

  return determinedFacts({
    operator,
    operatorId: typeof operatorId === "string" ? operatorId : null,
    accountDir: typeof accountDir === "string" ? accountDir : null,
    source: typeof source === "string" ? source : null,
  });
}

/**
 * operatorRepoBinding — the operator/repo PAIR, the fact L3 scopes against.
 * Both halves required; a missing half yields a bounded undetermined that
 * carries the half that WAS established.
 */
function operatorRepoBinding(ctx = {}) {
  const operator = operatorIdentity(ctx);
  const repo = repoIdentity(ctx);

  const unresolved = [];
  const reasonParts = [];
  if (operator.verdict === "undetermined") {
    reasonParts.push(`operator: ${operator.reason}`);
    unresolved.push({ span: "<operator>", reason: "operator identity unresolved" });
  }
  if (repo.verdict === "undetermined") {
    reasonParts.push(`repo: ${repo.reason}`);
    unresolved.push({ span: "<repo>", reason: "repo identity unresolved" });
  }

  if (reasonParts.length > 0) {
    return undeterminedFacts(
      `operator/repo binding incomplete — ${reasonParts.join("; ")}`,
      { operator: operator.facts, repo: repo.facts },
      unresolved,
    );
  }

  return determinedFacts({ operator: operator.facts, repo: repo.facts });
}

module.exports = { operatorIdentity, operatorRepoBinding };
