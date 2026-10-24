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
 *   - every endpoint is a KNOWN kind carrying a non-empty string value, or
 *     `{ kind: "unknown", value: null }` (`effects.js::isEndpoint`), both held
 *     in OWN DATA properties — so `{kind:"ref", value:null}`,
 *     `{kind:"path", value:""}`, an invented kind, or fields inherited or
 *     served by a getter cannot pass as an established endpoint;
 *   - endpoints are validated per kind by the SAME rule the constructor and
 *     the corpus gate run (`effects.js::effectEndpointViolations`): both keys
 *     PRESENT on every effect (an absent or undefined side is never read as
 *     null); delete = from present, to null; a `ref` endpoint only on a
 *     ref-update, whose from/to name THE SAME moved ref (prior state / new
 *     state), each a ref, an unknown or null, never both null; every move =
 *     BOTH endpoints present;
 *   - bytes are judged by the SAME rule the constructor runs
 *     (`effects.js::byteProvenanceViolation`): a known basis and each count
 *     null or a non-negative integer;
 *   - an effect whose endpoint is `{ kind: "unknown" }` FORCES "undetermined"
 *     (a move with one unknown endpoint is a missing fact, not a determined
 *     move — READ-BYTES/LOAD-AND-EXECUTE both need both endpoints).
 *   - results are built through these constructors, so the shape cannot drift
 *     per provider (same SSOT pattern as `lib/tool-classes.js` MUTATION_TOOLS:
 *     one constructor, no per-site hand-rolling).
 *   - ONE RULE, BUILT AND GUARDED. Every result constructor below runs the
 *     guard (`providerResultViolation`) on the frozen result it built and
 *     throws a TypeError on a violation, so a result the guard refuses cannot
 *     be constructed. The effect constructors accept only `effectList()`
 *     entries (`effects.js::isSequencedEffect`, a module-private brand), and
 *     `effectList()` only `effect()` outputs — so the constructor, effectList,
 *     the result constructors and the guard apply ONE rule. The fact
 *     constructors SNAPSHOT the facts into fresh deep-frozen plain data and
 *     refuse what the guard refuses (an accessor, a function, undefined, a
 *     non-finite number, a non-plain prototype, a cycle, a Proxy).
 *   - THE GUARD READS A RESULT ONCE, AS OWN DATA. Every object at every level
 *     — the result, the effects array, each effect, each endpoint, the bytes,
 *     the unresolved array and its entries, the facts and every object or
 *     array inside them — MUST be frozen, have a plain prototype
 *     (Object.prototype or null; Array.prototype for an array), carry ONLY
 *     enumerable string-keyed own DATA properties, and not be a Proxy. Each
 *     field is read exactly once, through Object.getOwnPropertyDescriptor, and
 *     the rules judge those read values. A record carries exactly its fields:
 *     an extra own field (a `toJSON` included) is refused, so what a
 *     serializer or a later reader sees cannot differ from what was judged.
 *
 * WHAT THE GUARD CAN AND CANNOT SEE ABOUT A PROXY. A Proxy is detected with
 * node:util `types.isProxy` — a HOST (V8) check: nothing in the language itself
 * tells a Proxy from its target. This module refuses to LOAD when that check is
 * unavailable, rather than run a guard that cannot see one. The guard calls it
 * on every object BEFORE any other operation on that object, so no trap of a
 * refused Proxy ever runs (a revoked or throwing one included), and while
 * reading a value it accepts, no caller code runs at all. Independently of that
 * check, a Proxy over a FROZEN target cannot report a value other than the
 * target's own for a non-configurable, non-writable data property — the
 * language forces its traps to agree — but it can still OBSERVE each read and
 * THROW, so even a faithful Proxy is refused outright. NOT covered: intrinsics
 * replaced BEFORE this module loaded (it captures Object.getOwnPropertyDescriptor,
 * Reflect.ownKeys, Object.isFrozen, Object.getPrototypeOf, Array.isArray and
 * util.types.isProxy at load, so a later replacement does not reach it); and
 * anything a consumer reads from an object OTHER than the one judged.
 *
 * REQUIRED vs DETAIL facts. Each provider declares which facts are REQUIRED
 * (absence ⇒ undetermined) and which are DETAIL (absent ⇒ null, documented as
 * "not supplied", never load-bearing for the verdict). A detail fact is never
 * allowed to stand in for a required one.
 *
 * Style: CommonJS, zero-dep, pure constructors — matches .claude/hooks/lib/*.
 */

"use strict";

const { types: _utilTypes } = require("node:util");
const {
  ENDPOINT_KINDS,
  effectEndpointViolations,
  byteProvenanceViolation,
  isSequencedEffect,
} = require("./effects.js");

const _isProxy = _utilTypes && _utilTypes.isProxy;
if (typeof _isProxy !== "function") {
  throw new Error(
    "guard-foundation/contract.js: node:util types.isProxy is unavailable — the shape guard cannot refuse a Proxy, so it refuses to load",
  );
}

// Intrinsics captured at load (header: WHAT THE GUARD CAN AND CANNOT SEE).
const _getOwn = Object.getOwnPropertyDescriptor;
const _ownKeys = Reflect.ownKeys;
const _isFrozen = Object.isFrozen;
const _getProto = Object.getPrototypeOf;
const _isArray = Array.isArray;
const _freeze = Object.freeze;
const _hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
const _isFinite = Number.isFinite;
const _OBJECT_PROTO = Object.prototype;
const _ARRAY_PROTO = Array.prototype;

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

/**
 * A refusal raised while reading a value. Only this module throws it, and the
 * guard turns it into its reason; the constructors turn it into a TypeError.
 */
class _Refusal {
  constructor(message) {
    this.message = message;
  }
}

function _refuse(at, why) {
  throw new _Refusal(`${at} ${why}`);
}

/** A description of a read value that runs no caller code (no String(), no JSON.stringify of an object). */
function _describe(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null || typeof v === "number" || typeof v === "boolean" || typeof v === "undefined") return `${v}`;
  return `a ${typeof v}`;
}

/**
 * _plain — `value` is an object of the wanted shape that this guard can read
 * without running caller code: not a Proxy (checked FIRST, before any other
 * operation touches it), an array iff `wantArray`, a plain prototype, and —
 * when `requireFrozen` — frozen.
 */
function _plain(value, at, wantArray, requireFrozen) {
  if (value === null || typeof value !== "object") {
    _refuse(at, wantArray ? `is not an array (it is ${_describe(value)})` : `is not an object (it is ${_describe(value)})`);
  }
  if (_isProxy(value)) {
    _refuse(
      at,
      "is a Proxy — its traps run on every read, so what this guard reads need not be what a later reader sees; a Proxy is refused outright",
    );
  }
  if (_isArray(value) !== wantArray) _refuse(at, wantArray ? "is not an array" : "is an array, not a record");
  const proto = _getProto(value);
  if (wantArray ? proto !== _ARRAY_PROTO : proto !== _OBJECT_PROTO && proto !== null) {
    _refuse(
      at,
      "has a non-plain prototype — an inherited field (a toJSON, an unresolved, a seq) reaches a reader without ever being judged here",
    );
  }
  if (requireFrozen && !_isFrozen(value)) _refuse(at, "is not frozen — a mutable object can be changed after this guard read it");
}

/**
 * _fields — every own field of a `_plain` value as [key, value], each read
 * ONCE through its descriptor. Refuses a symbol key, an accessor (never
 * invoked) and a non-enumerable field (an array's `length` excepted).
 */
function _fields(value, at) {
  const out = [];
  for (const key of _ownKeys(value)) {
    if (typeof key !== "string") {
      _refuse(at, "carries a symbol-keyed own field — a field this guard does not read is a second view of the value");
    }
    const d = _getOwn(value, key);
    if (!_hasOwn(d, "value")) {
      _refuse(
        `${at}.${key}`,
        "is an accessor — a getter can report one value to this guard and another to the reader; it is refused, never invoked",
      );
    }
    if (!d.enumerable && !(key === "length" && _isArray(value))) {
      _refuse(`${at}.${key}`, "is not enumerable — a hidden field is a second view of the value");
    }
    out.push([key, d.value]);
  }
  return out;
}

/**
 * _record — a closed record: exactly `required` plus any of `optional`, read
 * once into a fresh null-prototype holder. An unexpected field (a `toJSON`
 * included) is refused: a record carries exactly its fields.
 */
function _record(value, at, required, optional, requireFrozen) {
  _plain(value, at, false, requireFrozen);
  const out = Object.create(null);
  for (const [key, v] of _fields(value, at)) {
    if (!required.includes(key) && !optional.includes(key)) {
      _refuse(
        at,
        `carries an unexpected own field ${key} — a record carries exactly its fields, so nothing beside them (a toJSON included) can change what a reader sees`,
      );
    }
    out[key] = v;
  }
  for (const key of required) {
    if (!(key in out)) _refuse(at, `lacks the own field ${key}`);
  }
  return out;
}

/** _list — a dense array read once into a fresh array; a hole or a non-index field is refused. */
function _list(value, at, requireFrozen) {
  _plain(value, at, true, requireFrozen);
  let length = 0;
  const byIndex = new Map();
  for (const [key, v] of _fields(value, at)) {
    if (key === "length") {
      length = v;
      continue;
    }
    const n = Number(key);
    if (!Number.isInteger(n) || n < 0 || `${n}` !== key) {
      _refuse(at, `carries an unexpected own field ${key} — an array carries only its elements`);
    }
    byIndex.set(n, v);
  }
  if (byIndex.size !== length) {
    let hole = 0;
    while (byIndex.has(hole)) hole += 1;
    _refuse(at, `is sparse (a hole at index ${hole}) — every position of an array is a said value`);
  }
  const out = [];
  for (let i = 0; i < length; i++) out.push(byIndex.get(i));
  return out;
}

const _DATA = "a fact is data — a string, a finite number, a boolean, null, a plain object or an array";

/**
 * _data — THE fact-data rule, shared by the guard (`copy` false: the value
 * must already be deep-frozen) and the fact constructors (`copy` true: returns
 * a fresh deep-frozen plain copy). A function (a toJSON included), undefined,
 * a symbol, a bigint, a non-finite number, a non-plain prototype, an accessor,
 * a Proxy and a cycle are refused.
 */
function _data(value, at, stack, copy) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!_isFinite(value)) _refuse(at, `is a non-finite number (${value}) — ${_DATA}`);
    return value;
  }
  if (typeof value === "undefined") _refuse(at, `is undefined — ${_DATA}; say null for "no value"`);
  if (typeof value === "function") _refuse(at, `is a function — ${_DATA}; a function (a toJSON included) is behaviour, not a fact`);
  if (typeof value !== "object") _refuse(at, `is a ${typeof value} — ${_DATA}`);
  if (_isProxy(value)) {
    _refuse(at, "is a Proxy — its traps run on every read, so what is read need not be what a later reader sees; a Proxy is refused outright");
  }
  if (stack.has(value)) _refuse(at, "is cyclic — a fact is a finite tree of data");
  stack.add(value);
  let out;
  if (_isArray(value)) {
    const items = _list(value, at, !copy).map((v, i) => _data(v, `${at}[${i}]`, stack, copy));
    out = copy ? _freeze(items) : value;
  } else {
    _plain(value, at, false, !copy);
    const holder = {};
    for (const [key, v] of _fields(value, at)) holder[key] = _data(v, `${at}.${key}`, stack, copy);
    out = copy ? _freeze(holder) : value;
  }
  stack.delete(value);
  return out;
}

/** _asTypeError — run `fn`, turning a refusal into a TypeError prefixed with `ctor`. */
function _asTypeError(ctor, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof _Refusal) throw new TypeError(`${ctor}: ${err.message}`);
    throw err;
  }
}

function _snapshotFacts(ctor, facts) {
  return _asTypeError(ctor, () => _data(facts, "facts", new Set(), true));
}

function _freezeUnresolved(unresolved) {
  if (!_isArray(unresolved)) {
    throw new TypeError("unresolved must be an array of {span, reason}");
  }
  const entries = _asTypeError("unresolved", () =>
    _list(unresolved, "unresolved", false).map((e, i) => _record(e, `unresolved[${i}]`, ["span", "reason"], [], false)),
  );
  for (const entry of entries) {
    if (typeof entry.span !== "string" || typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new TypeError("unresolved entries must be {span: string, reason: non-empty string}");
    }
  }
  return _freeze(entries.map((e) => _freeze({ span: e.span, reason: e.reason })));
}

/** _sequenced — a fresh frozen array of `effectList()` entries; anything else is refused. */
function _sequenced(ctor, effects) {
  const out = [];
  for (let i = 0; i < effects.length; i++) {
    const entry = effects[i];
    if (!isSequencedEffect(entry)) {
      throw new TypeError(
        `${ctor} entry ${i} is not an effectList() entry — a result's effects come from effectList(), so every entry passed the rule; a hand-built object, however exact a copy, did not`,
      );
    }
    out.push(entry);
  }
  return _freeze(out);
}

/** _built — the guard, run on what a constructor built (header: ONE RULE, BUILT AND GUARDED). */
function _built(ctor, result) {
  const why = providerResultViolation(result);
  if (why !== null) throw new TypeError(`${ctor}: ${why}`);
  return result;
}

/**
 * determinedFacts — a fact-shaped provider established its required facts.
 * `reason` is pinned to null: a determined result carries no caveat text.
 */
function determinedFacts(facts) {
  if (!facts || typeof facts !== "object" || _isArray(facts)) {
    throw new TypeError("determinedFacts requires a facts object");
  }
  return _built(
    "determinedFacts",
    _freeze({
      verdict: VERDICTS.DETERMINED,
      facts: _snapshotFacts("determinedFacts", facts),
      reason: null,
    }),
  );
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
  if (!partialFacts || typeof partialFacts !== "object" || _isArray(partialFacts)) {
    throw new TypeError("undeterminedFacts requires a partial-facts object");
  }
  return _built(
    "undeterminedFacts",
    _freeze({
      verdict: VERDICTS.UNDETERMINED,
      facts: _snapshotFacts("undeterminedFacts", partialFacts),
      reason,
      unresolved: _freezeUnresolved(unresolved),
    }),
  );
}

/**
 * determinedEffects — an effect-shaped provider established the COMPLETE
 * ordered effect set. A determined-empty set ("no effects") is legitimate and
 * is a different world from "could not determine the effects". Every entry
 * MUST be an `effectList()` entry, and the built result passes the guard or
 * this throws — an unknown endpoint under determined included.
 */
function determinedEffects(effects) {
  if (!_isArray(effects)) {
    throw new TypeError("determinedEffects requires an effects array (use effectList())");
  }
  return _built(
    "determinedEffects",
    _freeze({
      verdict: VERDICTS.DETERMINED,
      effects: _sequenced("determinedEffects", effects),
      reason: null,
    }),
  );
}

/**
 * undeterminedEffects — an effect-shaped provider could NOT establish the
 * whole effect set. `partialEffects` is what it DID establish, in order
 * (an ordered prefix of the world is a legitimate bounded partial), and
 * `unresolved` names each span that could not be resolved. Entries and the
 * built result are held to the same rule as `determinedEffects`.
 */
function undeterminedEffects(reason, partialEffects = [], unresolved = []) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new TypeError("undeterminedEffects requires a non-empty reason");
  }
  if (!_isArray(partialEffects)) {
    throw new TypeError("undeterminedEffects requires a partial-effects array");
  }
  return _built(
    "undeterminedEffects",
    _freeze({
      verdict: VERDICTS.UNDETERMINED,
      effects: _sequenced("undeterminedEffects", partialEffects),
      reason,
      unresolved: _freezeUnresolved(unresolved),
    }),
  );
}

/** An endpoint side as read off a frozen effect: null/undefined/primitives pass to the rule, objects are read once. */
function _side(value, at) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  return _record(value, at, ["kind", "value"], [], true);
}

function _judgeResult(value) {
  const r = _record(value, "result", ["verdict", "reason"], ["facts", "effects", "unresolved"], true);
  const verdict = r.verdict;
  if (verdict !== VERDICTS.DETERMINED && verdict !== VERDICTS.UNDETERMINED) {
    _refuse("result.verdict", `is ${_describe(verdict)} — a verdict is "determined" or "undetermined"`);
  }
  const hasFacts = "facts" in r;
  if (hasFacts === ("effects" in r)) _refuse("result", "must carry exactly one of facts | effects");

  if (hasFacts) {
    const f = r.facts;
    if (f === null || typeof f !== "object") _refuse("facts", `is not an object (it is ${_describe(f)})`);
    if (!_isProxy(f) && _isArray(f)) _refuse("facts", "is an array, not a record");
    _data(f, "facts", new Set(), false);
  } else {
    _list(r.effects, "effects", true).forEach((raw, i) => {
      const at = `effects[${i}]`;
      const e = _record(raw, at, ["kind", "from", "to", "bytes", "seq"], [], true);
      if (e.seq !== i + 1) {
        _refuse(at, `seq is ${_describe(e.seq)} at position ${i} — effectList assigns contiguous 1-based seq in array order, never by hand`);
      }
      const from = _side(e.from, `${at}.from`);
      const to = _side(e.to, `${at}.to`);
      // THE per-kind endpoint rule effect() throws on and the corpus gate
      // reports (effects.js) — judged on the values read once above.
      const endpointWhy = effectEndpointViolations(e.kind, from, to);
      if (endpointWhy.length !== 0) _refuse(at, endpointWhy[0]);
      // THE byte rule effect() and byteProvenance() throw on (effects.js).
      const bytesWhy = byteProvenanceViolation(_record(e.bytes, `${at}.bytes`, ["observed", "prospective", "basis"], [], true));
      if (bytesWhy !== null) _refuse(`${at}.bytes`, bytesWhy);
      if (
        verdict === VERDICTS.DETERMINED &&
        ((from && from.kind === ENDPOINT_KINDS.UNKNOWN) || (to && to.kind === ENDPOINT_KINDS.UNKNOWN))
      ) {
        _refuse(
          at,
          "has an unknown endpoint under a determined verdict — an endpoint the provider could not establish FORCES undetermined",
        );
      }
    });
  }

  if (verdict === VERDICTS.DETERMINED) {
    if (r.reason !== null) _refuse("result.reason", "must be null on a determined result — a determined result carries no caveat");
    if ("unresolved" in r) _refuse("result.unresolved", "is undetermined-only — a determined result resolved everything it covers");
    return;
  }
  if (typeof r.reason !== "string" || r.reason.trim().length === 0) {
    _refuse("result.reason", "must be a non-empty string on an undetermined result");
  }
  if ("unresolved" in r) {
    _list(r.unresolved, "unresolved", true).forEach((raw, i) => {
      const e = _record(raw, `unresolved[${i}]`, ["span", "reason"], [], true);
      if (typeof e.span !== "string" || typeof e.reason !== "string" || e.reason.trim().length === 0) {
        _refuse(`unresolved[${i}]`, "must be {span: string, reason: non-empty string}");
      }
    });
  }
}

/**
 * providerResultViolation — THE shape guard, with its reason: null for a
 * legal provider result, else a message naming the broken rule. It reads the
 * value once, as own data (header: THE GUARD READS A RESULT ONCE), and judges
 * what it read with the SAME effects.js rules the constructors run. It never
 * throws: a value it cannot read is refused, not an exception.
 */
function providerResultViolation(value) {
  try {
    _judgeResult(value);
    return null;
  } catch (err) {
    if (err instanceof _Refusal) return err.message;
    return `the shape guard could not read the value (${err instanceof Error ? err.name : "a non-Error was thrown"}) — refused`;
  }
}

/**
 * isProviderResult — boolean form of `providerResultViolation`. This is the
 * discriminating instrument the contract tests run in BOTH directions: it
 * must PASS every provider result and must REJECT malformed shapes
 * (determined-with-a-reason, undetermined-with-empty-reason, unknown endpoint
 * under determined, seq drift, a mutable or Proxy or accessor-bearing value) —
 * a guard that could only return true would be no evidence at all.
 */
function isProviderResult(value) {
  return providerResultViolation(value) === null;
}

module.exports = {
  VERDICTS,
  MISSING_FACT_PREFIX,
  missingFactReason,
  determinedFacts,
  undeterminedFacts,
  determinedEffects,
  undeterminedEffects,
  providerResultViolation,
  isProviderResult,
};
