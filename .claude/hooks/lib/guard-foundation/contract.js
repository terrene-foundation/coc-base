/**
 * guard-foundation/contract.js — THE L1 provider-result contract.
 *
 * WHAT L1 IS. L1 providers REPORT FACTS about an operation before it runs:
 * what a shell command would do (ordered effects), what a tool call would do,
 * what a target path actually is, what the repo/consumer tree is, who the
 * operator is. L1 answers "what is true", never "what should happen".
 *
 * WHAT L1 IS NOT — POLICY LIVES AT L3, NOWHERE ELSE. No module in this
 * directory returns allow/deny, block/advisory, or a severity. The L3
 * decision chain is fixed by the ruling and ordered:
 *
 *     deny > undetermined-on-protected > halt > advisory > allow
 *
 * so "undetermined" is a first-class input to policy, not an error and not a
 * soft "no". A provider that cannot establish a fact returns `undetermined`
 * — it NEVER substitutes `false`, an empty result, or an allow.
 *
 * THE RESULT SHAPE (every provider, without exception):
 *
 *     {
 *       verdict: "determined" | "undetermined",
 *       facts:   {...}        // fact-shaped providers
 *       | effects: [...]      // effect-shaped providers
 *       reason:  string|null, // REQUIRED non-empty when undetermined; null when determined
 *       unresolved?: [{ span, reason }]  // undetermined only: WHAT could not be resolved
 *     }
 *
 * MECHANICAL GUARANTEES (enforced by `isProviderResult`, exercised by the
 * Undetermined-contract tests):
 *   - a MISSING required fact yields "undetermined" — never false, never an
 *     empty result, never an allow. An unmapped tool/command is NOT assumed
 *     effect-free; it is undetermined.
 *   - "determined" carries reason === null, so a reason can never be silently
 *     dropped on the way to policy.
 *   - "undetermined" carries a non-empty reason and MAY carry bounded partial
 *     facts/effects — the partial set is explicitly NOT the whole set, and
 *     `unresolved` names each span the provider could not resolve.
 *   - endpoints are validated per kind (delete: from present, to null; every
 *     move: BOTH endpoints present), and an effect whose endpoint is
 *     `{ kind: "unknown" }` FORCES "undetermined" (a move with one unknown
 *     endpoint is a missing fact, not a determined move —
 *     READ-BYTES/LOAD-AND-EXECUTE both need both endpoints).
 *   - results are built through these constructors, so the shape cannot drift
 *     per provider (same SSOT pattern as `lib/tool-classes.js` MUTATION_TOOLS:
 *     one constructor, no per-site hand-rolling).
 *
 * REQUIRED vs DETAIL facts. Each provider declares which facts are REQUIRED
 * (absence ⇒ undetermined) and which are DETAIL (absent ⇒ null, documented as
 * "not supplied", never load-bearing for the verdict). A detail fact is never
 * allowed to stand in for a required one.
 *
 * Style: CommonJS, zero-dep, pure constructors — matches .claude/hooks/lib/*.
 */

"use strict";

const { EFFECT_KIND_SET, EFFECT_KINDS, BYTE_BASE_SET } = require("./effects.js");

const VERDICTS = Object.freeze({
  DETERMINED: "determined",
  UNDETERMINED: "undetermined",
});

/**
 * Canonical prefix for the most common undetermined reason: a fact the
 * provider requires was not present. Providers MUST route missing-required-fact
 * reasons through `missingFactReason()` so the class stays greppable and
 * stable for L3 and the contract tests.
 */
const MISSING_FACT_PREFIX = "missing fact:";

function missingFactReason(name) {
  return `${MISSING_FACT_PREFIX} ${name}`;
}

function _freezeUnresolved(unresolved) {
  if (!Array.isArray(unresolved)) {
    throw new TypeError("unresolved must be an array of {span, reason}");
  }
  for (const entry of unresolved) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.span !== "string" ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0
    ) {
      throw new TypeError("unresolved entries must be {span: string, reason: non-empty string}");
    }
  }
  return Object.freeze(unresolved.map((e) => Object.freeze({ span: e.span, reason: e.reason })));
}

/**
 * determinedFacts — a fact-shaped provider established its required facts.
 * `reason` is pinned to null: a determined result carries no caveat text.
 */
function determinedFacts(facts) {
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
    throw new TypeError("determinedFacts requires a facts object");
  }
  return Object.freeze({
    verdict: VERDICTS.DETERMINED,
    facts: Object.freeze({ ...facts }),
    reason: null,
  });
}

/**
 * undeterminedFacts — a fact-shaped provider could NOT establish a required
 * fact. `partialFacts` is the bounded known subset ({} when nothing is known),
 * NEVER presented as the whole answer. `reason` is REQUIRED and non-empty.
 */
function undeterminedFacts(reason, partialFacts = {}, unresolved = []) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new TypeError("undeterminedFacts requires a non-empty reason");
  }
  if (!partialFacts || typeof partialFacts !== "object" || Array.isArray(partialFacts)) {
    throw new TypeError("undeterminedFacts requires a partial-facts object");
  }
  return Object.freeze({
    verdict: VERDICTS.UNDETERMINED,
    facts: Object.freeze({ ...partialFacts }),
    reason,
    unresolved: _freezeUnresolved(unresolved),
  });
}

/**
 * determinedEffects — an effect-shaped provider established the COMPLETE
 * ordered effect set. A determined-empty set ("no effects") is legitimate and
 * is a different world from "could not determine the effects".
 */
function determinedEffects(effects) {
  if (!Array.isArray(effects)) {
    throw new TypeError("determinedEffects requires an effects array (use effectList())");
  }
  return Object.freeze({
    verdict: VERDICTS.DETERMINED,
    effects: Object.freeze([...effects]),
    reason: null,
  });
}

/**
 * undeterminedEffects — an effect-shaped provider could NOT establish the
 * whole effect set. `partialEffects` is what it DID establish, in order
 * (an ordered prefix of the world is a legitimate bounded partial), and
 * `unresolved` names each span that could not be resolved.
 */
function undeterminedEffects(reason, partialEffects = [], unresolved = []) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new TypeError("undeterminedEffects requires a non-empty reason");
  }
  if (!Array.isArray(partialEffects)) {
    throw new TypeError("undeterminedEffects requires a partial-effects array");
  }
  return Object.freeze({
    verdict: VERDICTS.UNDETERMINED,
    effects: Object.freeze([...partialEffects]),
    reason,
    unresolved: _freezeUnresolved(unresolved),
  });
}

function _isEndpoint(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.kind === "string" &&
    (value.value === null || typeof value.value === "string")
  );
}

function _hasUnknownEndpoint(effect) {
  return (
    (effect.from && effect.from.kind === "unknown") ||
    (effect.to && effect.to.kind === "unknown")
  );
}

/**
 * isProviderResult — the shape guard. This is the discriminating instrument
 * the contract tests run in BOTH directions: it must PASS every provider
 * result and must REJECT malformed shapes (determined-with-a-reason,
 * undetermined-with-empty-reason, unknown endpoint under determined, seq
 * drift) — a guard that could only return true would be no evidence at all.
 */
function isProviderResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { verdict, reason } = value;
  if (verdict !== VERDICTS.DETERMINED && verdict !== VERDICTS.UNDETERMINED) return false;

  const hasFacts = Object.prototype.hasOwnProperty.call(value, "facts");
  const hasEffects = Object.prototype.hasOwnProperty.call(value, "effects");
  if (hasFacts === hasEffects) return false; // exactly one of facts | effects

  if (hasFacts) {
    const f = value.facts;
    if (!f || typeof f !== "object" || Array.isArray(f)) return false;
  } else {
    const effects = value.effects;
    if (!Array.isArray(effects)) return false;
    for (let i = 0; i < effects.length; i++) {
      const eff = effects[i];
      if (!eff || typeof eff !== "object") return false;
      if (eff.seq !== i + 1) return false; // order is assigned by effectList, never hand-set
      if (!EFFECT_KIND_SET.has(eff.kind)) return false;
      // Endpoint requirements per kind (same rules effect() enforces):
      // delete = { from, to: null }; every move = BOTH endpoints.
      if (!_isEndpoint(eff.from)) return false;
      if (eff.kind === EFFECT_KINDS.DELETE) {
        if (eff.to !== null) return false;
      } else if (!_isEndpoint(eff.to)) {
        return false;
      }
      if (!eff.bytes || typeof eff.bytes !== "object" || !BYTE_BASE_SET.has(eff.bytes.basis)) {
        return false;
      }
      if (verdict === VERDICTS.DETERMINED && _hasUnknownEndpoint(eff)) return false;
    }
  }

  if (verdict === VERDICTS.DETERMINED) {
    return reason === null && !Object.prototype.hasOwnProperty.call(value, "unresolved");
  }

  if (typeof reason !== "string" || reason.trim().length === 0) return false;
  if (Object.prototype.hasOwnProperty.call(value, "unresolved")) {
    const u = value.unresolved;
    if (!Array.isArray(u)) return false;
    for (const entry of u) {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.span !== "string" ||
        typeof entry.reason !== "string" ||
        entry.reason.trim().length === 0
      ) {
        return false;
      }
    }
  }
  return true;
}

module.exports = {
  VERDICTS,
  MISSING_FACT_PREFIX,
  missingFactReason,
  determinedFacts,
  undeterminedFacts,
  determinedEffects,
  undeterminedEffects,
  isProviderResult,
};
