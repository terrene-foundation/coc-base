/**
 * guard-foundation/effects.js — THE effect model shared by shell-effects and
 * tool-effects. Deliberately ONE model: a `Bash` tool call and a raw shell
 * command describe the same world and must not drift into two vocabularies.
 *
 * THE SPLIT THAT MATTERS — READ-BYTES vs LOAD-AND-EXECUTE. Reading a file's
 * bytes and LOADING those bytes AS EXECUTABLE CODE are different effects with
 * different policy weight. `bash setup.sh` produces BOTH, in order:
 *
 *     seq 1: read-bytes        setup.sh -> process
 *     seq 2: load-and-execute  setup.sh -> process
 *
 * They are separate entries because a policy may read a file without wanting
 * to permit executing it as code (and vice versa: an executor can run without
 * the caller having modelled the read). Collapsing them loses the distinction.
 *
 * EVERY MOVE CARRIES BOTH ENDPOINTS. READ-BYTES, WRITE-BYTES and
 * LOAD-AND-EXECUTE each require `from` AND `to` (the constructor throws on a
 * missing one). A move with one endpoint unknown is a MISSING FACT, not a
 * determined move: build it with `endpointUnknown()` — the contract then
 * forces the provider verdict to "undetermined" (`contract.js`
 * `isProviderResult`), so L3 sees the gap instead of a half-described move.
 * DELETE is the one non-move: `from` = the removed path, `to` = null (there is
 * no destination).
 *
 * OMISSION IS NEVER A FACT. A side that is absent (or `undefined`) is refused
 * by `effectEndpointViolations` on every kind: null — "no endpoint on this
 * side" — is a CLAIM (on a ref-update, a creation or a deletion), so it must be
 * SAID, never defaulted into existence by a forgotten key. The one omission
 * resolved anywhere is the constructor's delete `to`: null is its ONLY legal
 * value, so omitting it cannot select a different fact, and the stored effect
 * carries `to: null` as an own key — which is what the shape guard, reading a
 * RESULT, requires of every effect.
 *
 * REF-UPDATE is a branch/ref movement with NO worktree write (`git fetch .
 * HEAD:main`, `symbolic-ref`, `fast-import`, `update-ref -d` — the vector the
 * round-1 probe measured every shipped guard silent on; L0 R9). BOTH SIDES
 * NAME THE SAME REF — the one that moves — so a protected-ref rule reads the
 * moved ref off whichever side is a `ref`, and never has to guess which side
 * is "the destination". `from` is that ref's PRIOR state and `to` its NEW
 * state. Each side is a `ref` endpoint, `endpointUnknown()` when the provider
 * could not establish it (the contract then forces "undetermined"), or null:
 *   - from null ⇒ a ref CREATION (no prior state) — a narrower fact, not a
 *     missing one;
 *   - to null   ⇒ a ref DELETION (no new state) — likewise;
 *   - both null ⇒ REFUSED: it describes no ref movement at all;
 *   - both `ref` ⇒ their values MUST be equal (as spelled — the provider spells
 *     one ref one way); two different refs would be a source and a destination,
 *     which is a different (and ambiguous) fact.
 * The SOURCE the new value is read from is NOT part of the ref-update:
 *     git fetch . HEAD:main              { from: ref refs/heads/main | null, to: ref refs/heads/main }
 *     git update-ref -d refs/heads/main  { from: ref refs/heads/main, to: null }
 *     git symbolic-ref HEAD refs/heads/x { from: ref HEAD, to: ref HEAD }
 *
 * A REF IS SPELLED IN FULL. A `ref` endpoint's value is exactly `HEAD` or a
 * FULL refname under `refs/` that git check-ref-format accepts
 * (`refnameViolation`). A short name (`main`) is refused: git resolves a short
 * name against several namespaces, so it does not say WHICH ref moves. The
 * predicate judges the name AS SPELLED and does NOT case-fold: where loose refs
 * live on a case-insensitive filesystem, `refs/heads/MAIN` names the same loose
 * ref file as `refs/heads/main` whatever `core.ignorecase` says. Folding is the
 * POLICY's job, never this predicate's: it folds unless repo-facts determines
 * the ref storage is case-sensitive (L0-field-requirements.md § The effect
 * model and completeness).
 * A path (or argv/process/stream/fd/url) endpoint is never legal on either
 * side: a ref is a name git resolves (loose file, packed-refs line, or
 * reftable record), so a path spelling would be a WRONG fact about which ref
 * moved. Conversely a `ref` endpoint is legal ONLY on a ref-update — a
 * `delete` from a ref or a `write-bytes` to a ref would describe a ref
 * movement under a kind whose policy does not adjudicate refs.
 *
 * OWN DATA, COPIED. An endpoint's `kind` and `value` must be OWN DATA
 * properties: an inherited field or a getter can report one value to the
 * check and another to the reader. The constructor snapshots each endpoint
 * (and the byte provenance) into a fresh frozen object BEFORE judging it, and
 * stores that snapshot — so what was judged is exactly what is stored, and a
 * caller mutating its own object afterwards moves nothing.
 *
 * ONE RULE, EVERY SURFACE. Which effects are legal is decided by
 * `isEndpoint` / `endpointViolation` (one endpoint, including
 * `refnameViolation` for a ref), `effectEndpointViolations` (an effect's
 * per-kind endpoint rule) and `byteProvenanceViolation` (its bytes). The
 * constructor below, the shape guard (`contract.js::providerResultViolation`,
 * whose boolean form is `isProviderResult`) and the corpus gate
 * (`validate-cases.mjs::checkDerivation`, endpoints only — the corpus schema
 * judges its bytes) all call these, so they accept and refuse exactly the
 * same effects and cannot drift apart. The RESULT constructors
 * (`contract.js::determinedEffects` and its siblings) run the guard itself on
 * what they build and throw on a violation, so a result the guard would refuse
 * cannot be constructed either.
 *
 * THE BRAND. `effect()` records every value it returns in a module-private
 * WeakSet (`_EFFECTS`), and `effectList()` records every entry it returns in a
 * second one (`_SEQUENCED`). `effectList()` accepts ONLY `_EFFECTS` members,
 * and the result constructors accept ONLY `_SEQUENCED` members
 * (`isEffect` / `isSequencedEffect`). Neither set is exported and nothing but
 * those two functions adds to them, so a hand-built frozen look-alike —
 * structurally identical, field for field — is refused: the only way into a
 * constructed result is through the constructor that ran the rule.
 *
 * PROSPECTIVE BYTES. `bytes.prospective` is what WOULD move (the L1
 * prospective question); `bytes.observed` is what DID move (populated by
 * post-hoc callers; null in prospective analysis). `basis` grades the number:
 * measured (read off a real entity), derived (computed from supplied input,
 * e.g. Buffer.byteLength of a Write's content), upper-bound (may overcount),
 * unknown. IMPORTANT — an unknown byte count does NOT by itself make a verdict
 * undetermined: the verdict tracks the EFFECT SET (which effects, in what
 * order, between which endpoints). Byte counts are supporting detail; L3 reads
 * `basis: "unknown"` as unknown, never as zero.
 *
 * ORDER. The effects array is ordered by execution sequence. `seq` is 1-based
 * and contiguous, and is assigned ONLY by `effectList()` — never hand-set —
 * so array order and `seq` cannot drift apart (a hand-built effect without
 * `seq` fails `isProviderResult`, which is intentional: unordered effects are
 * not a provider result).
 *
 * Style: CommonJS, zero-dep, pure constructors — matches .claude/hooks/lib/*.
 */

"use strict";

const EFFECT_KINDS = Object.freeze({
  READ_BYTES: "read-bytes",
  WRITE_BYTES: "write-bytes",
  LOAD_AND_EXECUTE: "load-and-execute",
  DELETE: "delete",
  REF_UPDATE: "ref-update",
});

const EFFECT_KIND_SET = new Set(Object.values(EFFECT_KINDS));

const ENDPOINT_KINDS = Object.freeze({
  /** A filesystem path. `value` is the path as established by the provider;
   *  whether it is canonical is the target-identity provider's question. */
  PATH: "path",
  /** The command/tool argument text itself (here-string content, a Write's
   *  `content`, a patch body) — content that exists only in the invocation. */
  ARGV: "argv",
  /** The executing process image: the terminal endpoint for content that
   *  enters execution (a read's destination, an exec's destination). */
  PROCESS: "process",
  /** An anonymous stream (pipe, stdin/stdout glue). `value` names it. */
  STREAM: "stream",
  /** An OS file descriptor / handle. */
  FD: "fd",
  /** A network location. */
  URL: "url",
  /** A git ref name as the command spells it (`refs/heads/main`, `HEAD`).
   *  Which repository it binds in is the repo-facts provider's question. */
  REF: "ref",
  /** NOT an endpoint — the explicit representation of an endpoint the provider
   *  could not establish. Presence in an effect forces verdict "undetermined"
   *  (contract.js::isProviderResult). */
  UNKNOWN: "unknown",
});

const ENDPOINT_KIND_SET = new Set(Object.values(ENDPOINT_KINDS));

const BYTE_BASES = Object.freeze({
  MEASURED: "measured",
  DERIVED: "derived",
  UPPER_BOUND: "upper-bound",
  UNKNOWN: "unknown",
});

const BYTE_BASE_SET = new Set(Object.values(BYTE_BASES));

/**
 * The brands (header: THE BRAND). Module-private: only `effect()` adds to
 * `_EFFECTS` and only `effectList()` adds to `_SEQUENCED`, so membership is
 * proof the value came out of the constructor that ran the rule.
 */
const _EFFECTS = new WeakSet();
const _SEQUENCED = new WeakSet();

/**
 * _ownData — the descriptor of `key` on `obj` when it is an OWN DATA property,
 * else null. Reading the descriptor never invokes a getter, so the value seen
 * here is the value that is stored, not one a getter chose for this read.
 */
function _ownData(obj, key) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d !== undefined && Object.prototype.hasOwnProperty.call(d, "value") ? d : null;
}

const _NOT_OWN_DATA =
  "is not an own data property — an inherited field or a getter can report one value to this check and another to the reader";

/** The one ref spelled without `refs/`. */
const REF_HEAD = "HEAD";

/** Characters git check-ref-format refuses anywhere in a refname (controls are tested by code point). */
const _REFNAME_FORBIDDEN = new Set([" ", "~", "^", ":", "?", "*", "[", "\\"]);

/**
 * refnameViolation — THE refname predicate for a `ref` endpoint's value.
 * Returns null when `name` is exactly `HEAD` or a FULL refname valid under git
 * check-ref-format, else the reason. A full refname starts with `refs/` and has
 * none of: a component beginning with `.` or ending with `.lock`; `..`; an
 * ASCII control character (< 0x20 or 0x7f), space, `~`, `^`, `:`, `?`, `*`,
 * `[` or `\`; `@{`; a trailing `/` or `.`; `//`; and it is not a bare `@`.
 * Anything else is refused — a short name like `main` included, because git
 * resolves a short name against several namespaces, so it does not say which
 * ref moves. NO case-folding: the name is judged as spelled, and folding
 * against the repo's ref-storage case sensitivity is the policy's job.
 */
function refnameViolation(name) {
  if (typeof name !== "string" || name.length === 0) return "is not a non-empty string";
  if (name === REF_HEAD) return null;
  if (name === "@") return "is a bare @ (git reads it as HEAD; spell HEAD)";
  if (!name.startsWith("refs/")) {
    return `${JSON.stringify(name)} is neither HEAD nor a full refname under refs/ — a short name is resolved by git against several namespaces, so it does not say which ref moves`;
  }
  for (const ch of name) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp === 0x7f) return `${JSON.stringify(name)} contains an ASCII control character (code ${cp})`;
    if (_REFNAME_FORBIDDEN.has(ch)) return `${JSON.stringify(name)} contains the forbidden character ${JSON.stringify(ch)}`;
  }
  if (name.includes("..")) return `${JSON.stringify(name)} contains ..`;
  if (name.includes("@{")) return `${JSON.stringify(name)} contains @{`;
  if (name.includes("//")) return `${JSON.stringify(name)} contains //`;
  if (name.endsWith("/")) return `${JSON.stringify(name)} ends with /`;
  if (name.endsWith(".")) return `${JSON.stringify(name)} ends with .`;
  for (const component of name.split("/")) {
    if (component.startsWith(".")) return `${JSON.stringify(name)} has a component beginning with . (${JSON.stringify(component)})`;
    if (component.endsWith(".lock")) return `${JSON.stringify(name)} has a component ending with .lock (${JSON.stringify(component)})`;
  }
  return null;
}

/**
 * endpointViolation — THE endpoint predicate, with its reason. Returns null for
 * a legal endpoint, else a message naming the broken rule:
 *   - `kind` and `value` are OWN DATA properties (never inherited, never getters);
 *   - `kind` is one of ENDPOINT_KINDS (exact spelling — "UNKNOWN" is not "unknown");
 *   - kind "unknown" carries value === null (it IS the absence of a value);
 *   - every other kind carries a non-empty string value;
 *   - kind "ref" carries exactly `HEAD` or a full refname (`refnameViolation`).
 * A determined result carrying `{kind:"ref", value:null}` would be a missing
 * fact presented as an established one, so this is a fail-closed check, not
 * cosmetics. Used by `endpoint()`, `effect()`, `contract.js::isProviderResult`
 * and `validate-cases.mjs::checkDerivation`.
 */
function endpointViolation(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "is not an endpoint object (expected { kind, value })";
  }
  const k = _ownData(value, "kind");
  if (k === null) return `\`kind\` ${_NOT_OWN_DATA}`;
  const v = _ownData(value, "value");
  if (v === null) return `\`value\` ${_NOT_OWN_DATA}`;
  const kind = k.value;
  const val = v.value;
  if (!ENDPOINT_KIND_SET.has(kind)) {
    return `unknown endpoint kind: ${String(kind)}`;
  }
  if (kind === ENDPOINT_KINDS.UNKNOWN) {
    return val === null
      ? null
      : "an unknown endpoint carries value null — it IS the representation of an endpoint the provider could not establish, so it holds no value";
  }
  if (typeof val !== "string" || val.length === 0) {
    return `a ${kind} endpoint requires a non-empty string value`;
  }
  if (kind === ENDPOINT_KINDS.REF) {
    const why = refnameViolation(val);
    if (why !== null) return `a ref endpoint must be exactly HEAD or a full refname valid under git check-ref-format: ${why}`;
  }
  return null;
}

/** isEndpoint — boolean form of `endpointViolation`. */
function isEndpoint(value) {
  return endpointViolation(value) === null;
}

function endpoint(kind, value) {
  if (!ENDPOINT_KIND_SET.has(kind)) {
    throw new TypeError(`unknown endpoint kind: ${String(kind)}`);
  }
  if (kind === ENDPOINT_KINDS.UNKNOWN) {
    throw new TypeError("use endpointUnknown() to build an unknown endpoint");
  }
  const why = endpointViolation({ kind, value });
  if (why !== null) {
    throw new TypeError(
      typeof value === "string" && value.length > 0 ? `endpoint(${kind}): ${why}` : `endpoint(${kind}) requires a non-empty string value`,
    );
  }
  return Object.freeze({ kind, value });
}

/** The explicit "provider could not establish this endpoint" value. */
function endpointUnknown() {
  return Object.freeze({ kind: ENDPOINT_KINDS.UNKNOWN, value: null });
}

/**
 * byteCountViolation — one byte count: null (not supplied) or a non-negative
 * integer. Returns null when legal, else the reason.
 */
function byteCountViolation(n) {
  return n === null || (Number.isInteger(n) && n >= 0)
    ? null
    : "byte counts must be non-negative integers or null";
}

/**
 * byteProvenanceViolation — THE byte-provenance predicate, shared by
 * `byteProvenance()`, `effect()` and `contract.js::isProviderResult`. Every
 * field is an OWN DATA property (an absent count is a malformed record, never
 * read as null), `basis` is one of BYTE_BASES, and each count passes
 * `byteCountViolation`. Returns null when legal, else the reason.
 */
function byteProvenanceViolation(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "is not a byte-provenance object (expected { observed, prospective, basis })";
  }
  const basis = _ownData(value, "basis");
  if (basis === null) return `\`basis\` ${_NOT_OWN_DATA}`;
  if (!BYTE_BASE_SET.has(basis.value)) return `unknown byte basis: ${String(basis.value)}`;
  for (const field of ["observed", "prospective"]) {
    const d = _ownData(value, field);
    if (d === null) return `\`${field}\` ${_NOT_OWN_DATA}`;
    const why = byteCountViolation(d.value);
    if (why !== null) return `${why} (${field}: ${String(d.value)})`;
  }
  return null;
}

function byteProvenance(spec = {}) {
  const { observed = null, prospective = null, basis = BYTE_BASES.UNKNOWN } = spec;
  const b = Object.freeze({ observed, prospective, basis });
  const why = byteProvenanceViolation(b);
  if (why !== null) throw new TypeError(why);
  return b;
}

/**
 * _snapshot — a fresh frozen object holding ONLY the named fields that are OWN
 * DATA properties of `value` (absent otherwise). Anything that is not a
 * non-array object passes through unchanged, so the predicates still see — and
 * name — a null, an undefined, an array or a primitive. Judging the snapshot
 * and storing the snapshot is what makes "what was judged" and "what is
 * stored" the same object.
 */
function _snapshot(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out = {};
  for (const key of fields) {
    const d = _ownData(value, key);
    if (d !== null) out[key] = d.value;
  }
  return Object.freeze(out);
}

/**
 * effectEndpointViolations — THE per-kind endpoint rule. `from` / `to` are
 * endpoints or null (null = no endpoint on that side, SAID explicitly). Returns
 * [] for a legal pair, else every broken rule as a message:
 *   every side                : present — an omitted (`undefined`) side is
 *                               refused, never read as null
 *   every non-null side       : a legal endpoint (`endpointViolation`)
 *   ref-update                : each side a ref, an unknown, or null; both
 *                               sides name THE ref that moves: from null =
 *                               creation, to null = deletion, BOTH null
 *                               refused, two `ref` sides with different
 *                               values refused
 *   every other kind          : no `ref` endpoint on either side
 *   delete                    : from present, to null
 *   read-bytes / write-bytes /
 *   load-and-execute (moves)  : from AND to present
 * The constructor throws the first; `contract.js::isProviderResult` refuses on
 * any; `validate-cases.mjs::checkDerivation` reports each.
 */
function effectEndpointViolations(kind, rawFrom, rawTo) {
  if (!EFFECT_KIND_SET.has(kind)) return [`unknown effect kind: ${String(kind)}`];
  // Judge a SNAPSHOT: each endpoint's kind/value are read ONCE, as own data
  // descriptors, into a fresh frozen object, and every read below reads that
  // object — so the rule judges one value per field, not one per read.
  const from = _snapshot(rawFrom, ["kind", "value"]);
  const to = _snapshot(rawTo, ["kind", "value"]);
  const sides = [
    ["from", from],
    ["to", to],
  ];
  const invalid = [];
  for (const [side, ep] of sides) {
    if (ep === undefined) {
      invalid.push(
        `effect \`${side}\` is omitted — an omitted side is not a fact: pass null when there is no endpoint on that side (on a ref-update null is a creation or deletion claim), or endpointUnknown() when it could not be established`,
      );
      continue;
    }
    if (ep === null) continue;
    const why = endpointViolation(ep);
    if (why !== null) invalid.push(`effect \`${side}\` is not a valid endpoint: ${why}`);
  }
  if (invalid.length) return invalid;

  // From here each side is null or the legal SNAPSHOT endpointViolation judged,
  // so reading it reads what was judged. That covers THIS call only. It says
  // nothing about the caller's object on a later read: a non-frozen object can
  // be changed, and a Proxy's traps can answer a later read differently (unless
  // the target's property is non-configurable and non-writable, which the
  // language then forces the traps to report faithfully). A RESULT is covered
  // by the shape guard instead, which refuses any non-frozen object and any
  // Proxy (contract.js::providerResultViolation); the constructor stores the
  // snapshot it judged.
  const out = [];
  if (kind === EFFECT_KINDS.REF_UPDATE) {
    if (from === null && to === null) {
      out.push(
        "ref-update effect requires at least one side: `from` = the moved ref's prior state (null = a creation), `to` = its new state (null = a deletion); both null describes no ref movement",
      );
    }
    for (const [side, ep] of sides) {
      if (ep !== null && ep.kind !== ENDPOINT_KINDS.REF && ep.kind !== ENDPOINT_KINDS.UNKNOWN) {
        out.push(
          `ref-update \`${side}\` must be a ref endpoint or endpointUnknown(), never a ${ep.kind} endpoint — a ref is a name git resolves, so any other spelling is a wrong fact about which ref moved`,
        );
      }
    }
    if (
      from !== null &&
      to !== null &&
      from.kind === ENDPOINT_KINDS.REF &&
      to.kind === ENDPOINT_KINDS.REF &&
      from.value !== to.value
    ) {
      out.push(
        `ref-update \`from\` and \`to\` name different refs (${from.value} vs ${to.value}) — both sides name THE ref that moves (from = its prior state, to = its new state); the source a new value is read from is not part of the ref-update`,
      );
    }
    return out;
  }

  for (const [side, ep] of sides) {
    if (ep !== null && ep.kind === ENDPOINT_KINDS.REF) {
      out.push(`${kind} effect carries a ref endpoint in \`${side}\` — a ref endpoint is legal only on a ref-update`);
    }
  }
  if (kind === EFFECT_KINDS.DELETE) {
    if (from === null) out.push("delete effect requires `from` (the removed path)");
    if (to !== null) out.push("delete effect has no destination; `to` must be null");
  } else if (from === null || to === null) {
    out.push(
      `${kind} effect requires BOTH endpoints (from and to); use endpointUnknown() when one could not be established`,
    );
  }
  return out;
}

/**
 * effect — one ordered effect entry. The per-kind endpoint rule is
 * `effectEndpointViolations` (above) and the bytes rule
 * `byteProvenanceViolation`; this constructor throws the first violation.
 * `from` and `to` are BOTH required keys (null said explicitly), except a
 * delete's `to`, the one resolved omission (header: OMISSION IS NEVER A FACT).
 * Endpoints and bytes are snapshotted from own data properties before they are
 * judged, and the snapshots are what is stored. `seq` is intentionally absent
 * here; `effectList()` assigns it.
 */
function effect(kind, spec = {}) {
  if (!EFFECT_KIND_SET.has(kind)) {
    throw new TypeError(`unknown effect kind: ${String(kind)}`);
  }
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new TypeError("effect() requires a spec object { from, to, bytes? }");
  }
  const from = _snapshot(spec.from, ["kind", "value"]);
  const rawTo = kind === EFFECT_KINDS.DELETE && spec.to === undefined ? null : spec.to;
  const to = _snapshot(rawTo, ["kind", "value"]);
  const violations = effectEndpointViolations(kind, from, to);
  if (violations.length) throw new TypeError(violations[0]);
  const bytes =
    spec.bytes === undefined ? byteProvenance() : _snapshot(spec.bytes, ["observed", "prospective", "basis"]);
  const bytesWhy = byteProvenanceViolation(bytes);
  if (bytesWhy !== null) throw new TypeError(`effect bytes: ${bytesWhy}`);
  const out = Object.freeze({ kind, from, to, bytes });
  _EFFECTS.add(out);
  return out;
}

/** isEffect — true only for a value `effect()` returned. */
function isEffect(value) {
  return value !== null && typeof value === "object" && _EFFECTS.has(value);
}

/** isSequencedEffect — true only for an entry `effectList()` returned. */
function isSequencedEffect(value) {
  return value !== null && typeof value === "object" && _SEQUENCED.has(value);
}

/** Effect kinds that move content between two endpoints (both required). */
const MOVE_KINDS = Object.freeze([
  EFFECT_KINDS.READ_BYTES,
  EFFECT_KINDS.WRITE_BYTES,
  EFFECT_KINDS.LOAD_AND_EXECUTE,
]);

/**
 * effectList — THE only way to produce the effects array of a provider
 * result. Assigns contiguous 1-based `seq` in array order (execution order),
 * so ordering is structural and cannot drift from the array. Accepts ONLY
 * values `effect()` returned (the `_EFFECTS` brand): a hand-built object —
 * frozen, and field-for-field identical to a real effect — is refused, so an
 * effect that never passed the rule cannot be sequenced into a result. Each
 * returned entry carries the `_SEQUENCED` brand the result constructors
 * require.
 */
function effectList(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("effectList requires an array of effect() entries");
  }
  return entries.map((entry, i) => {
    if (isSequencedEffect(entry)) {
      throw new TypeError(`effectList entry ${i} is already sequenced — effectList assigns seq; pass the effect() values, once`);
    }
    if (!isEffect(entry)) {
      throw new TypeError(
        `effectList entry ${i} is not an effect() value — only effect() output can be sequenced; a hand-built object, however exact a copy, never passed the rule`,
      );
    }
    // A branded value is the frozen plain object effect() built, so these
    // reads cannot run caller code.
    const out = Object.freeze({ kind: entry.kind, from: entry.from, to: entry.to, bytes: entry.bytes, seq: i + 1 });
    _SEQUENCED.add(out);
    return out;
  });
}

module.exports = {
  EFFECT_KINDS,
  EFFECT_KIND_SET,
  ENDPOINT_KINDS,
  ENDPOINT_KIND_SET,
  BYTE_BASES,
  BYTE_BASE_SET,
  MOVE_KINDS,
  REF_HEAD,
  refnameViolation,
  endpointViolation,
  isEndpoint,
  effectEndpointViolations,
  endpoint,
  endpointUnknown,
  byteProvenanceViolation,
  byteProvenance,
  effect,
  effectList,
  isEffect,
  isSequencedEffect,
};
