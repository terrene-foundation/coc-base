"use strict";

/**
 * Canonical provenance-event schema — F101 / loom#411 (governance-as-DNA, loom lane).
 *
 * loom OWNS the event FORMAT. Per the loom↔csq seam (csq journal 0017): a loom-captured
 * event MUST be byte-exact with what csq signs + anchors, so the canonical form is the
 * load-bearing shared contract. This module DEFINES + VALIDATES the event; the hooks that
 * PRODUCE events (UserPromptSubmit / PreToolUse / journal-DECISION capture) are F101-2.
 *
 * Maps onto loom's EXISTING primitives — does NOT rebuild them (per journal/0188 brief
 * correction #4):
 *   - operator_ref → { verified_id, person_id }  — the per-dev signing identity from
 *                     operators.roster.json; NEVER the shared model key (#411 identity
 *                     correction: "the shared model key signs nothing").
 *   - prev_link    → the prior event's content hash (the per-emitter hash-chain analogue
 *                     of coordination-log's prev_hash; #411 draft called it prev_link).
 *   - byte-exact   → coc-sign.js::canonicalSerialize (the determinism contract).
 *
 * This module emits NOTHING and signs NOTHING — signing/anchoring is the csq lane. It is a
 * pure format authority: build, validate, hash, chain-link.
 *
 * Origin: journal/0188 (F101 origination, co-owner-directed) + csq seam journal 0017.
 */

const crypto = require("crypto");
const { canonicalSerialize } = require("./coc-sign.js");

/**
 * Closed event taxonomy (#411 §4 "The event + seam schema"). Adding a kind is a SCHEMA
 * change (bump SCHEMA_VERSION + update csq's conformance), never a caller choice — a
 * free-form kind defeats the byte-exact parity the seam depends on.
 */
const EVENT_KINDS = Object.freeze([
  "HumanInput",
  "Action",
  "Decision",
  "Delegation",
]);

// ── SCHEMA FREEZE (F120, csq M18 seam) ──────────────────────────────────────
// schema_version 1 is FROZEN as the loom↔csq seam FORMAT authority — loom owns
// FORMAT per rules/loom-csq-boundary.md; csq owns evaluation. The canonical event
// schema (EVENT_KINDS + EVENT_KEYS + coc-sign canonical-byte serialization) is
// byte-stable for csq M18 to build on, and MUST NOT change without a COORDINATED
// bump (bump SCHEMA_VERSION + update csq conformance, per the EVENT_KINDS note above).
// Freeze receipt: journal/0211. Converged: journal/0190 (F101-1); validated: F101-4.
//
// SCOPE — FORMAT ONLY. The drain/TRANSPORT contract is decided SEPARATELY from this
// freeze: RESOLVED as Option A — a separate per-session ledger (provenance-ledger.js;
// NOT the coordination-log, NOT a git ref). journal/0190 § For-Discussion #1's OPEN
// framing is superseded by journal/0255 (transport resolved + ordering stability) and
// journal/0258 (#476 — the decided drain contract incl. the completeness guarantee:
// recorded-prefix integrity only; csq must flag gaps).
//
// ── NAMED VERSION + csq M18 5-FIELD MAPPING (loom #461, journal/0251) ────────
// Named frozen anchor: this module @ commit f36a6fe (bytes stable since b02a68c);
// git tag `provenance-event-schema/v1`. csq M18's 5-field decision record maps
// onto the v1 byte-exact event as follows (csq DERIVES the non-stored fields —
// the v1 bytes are NOT widened):
//   • schema version            = `schema_version` (=1)                 [exact]
//   • claimed-decision-timestamp= `ts` (ISO-8601; NOTE: capture/intent
//                                  time, not a separately-claimed time)  [field]
//   • event UUID                = sha256(canonicalSerialize(event))      [derived —
//                                  the SAME content hash csq signs; not a stored field]
//   • surface id                = derive from `kind` + `payload`
//                                  ({tool, journal_path})                [derived]
//   • per-source monotonic counter = DIVERGENCE — v1 orders per operator_ref via the
//                                  `prev_link` HASH-CHAIN, NOT an integer counter.
//                                  csq derives ordering from chain depth per
//                                  operator_ref; there is no `seq` field in v1.
// Guarantee: no #411-lane work reshapes these v1 bytes without a COORDINATED
// SCHEMA_VERSION bump + csq conformance in the same cross-repo cycle. A csq decoder
// requiring event_id/seq/surface_id as byte-present fields is a v2 bump, not v1.
const SCHEMA_VERSION = 1;

/**
 * operator_ref is EXACTLY these fields. The allowlist is the structural defense for the
 * signing-vs-model-key separation (#411) ON THE operator_ref SURFACE: a stray `model_key` /
 * `api_key` / `key` field on operator_ref is rejected. NOTE: this allowlist covers operator_ref
 * ONLY — the FREE-FORM `payload` surface is guarded separately by `_scanForbiddenKeys` (a
 * credential-shaped key anywhere in payload is rejected), because a permanent signed
 * governance record MUST NOT carry secrets on ANY surface (security.md "no secrets in logs").
 */
const OPERATOR_REF_REQUIRED = Object.freeze(["verified_id", "person_id"]);
const OPERATOR_REF_OPTIONAL = Object.freeze(["display_id"]);
const OPERATOR_REF_ALLOWED = Object.freeze([
  ...OPERATOR_REF_REQUIRED,
  ...OPERATOR_REF_OPTIONAL,
]);

/**
 * Keys forbidden ANYWHERE in an event (recursively): prototype-pollution vectors that ALSO
 * silently break canonical determinism (coc-sign's `out[k] = ...` triggers the `__proto__`
 * setter, dropping the key from the serialized bytes → two semantically-distinct events hash
 * identically → the byte-exact seam contract breaks). Reject before canonicalization.
 */
const PROTO_POLLUTION_KEYS = Object.freeze([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Credential-shaped key names forbidden in `payload`. A provenance event is permanently
 * signed + hash-chained + ledger-anchored by csq — the worst possible place for a secret
 * (redaction-after-anchor is impossible). Defense-in-depth name scan (fail-loud), NOT a
 * substitute for the producer not putting secrets in payload. Matches exact credential names
 * + the `_secret`/`_token`/`_password`/`_credential`/`_key` suffix family.
 */
const CREDENTIAL_KEY_RE =
  /^(api_?key|model_?key|access_?key|signing_?key|private_?key|secret|token|password|passwd|credential)$|_(secret|token|password|passwd|credential|key)$/i;

/** Top-level event keys, in canonical declaration order. */
const EVENT_KEYS = Object.freeze([
  "schema_version",
  "kind",
  "ts",
  "session",
  "operator_ref",
  "payload",
  "prev_link",
]);

// Capture groups (year, month, day, hour, min, sec) so the value RANGES can be checked —
// shape alone accepts impossible dates/times (month 13, hour 25).
const ISO_8601_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function _isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

/**
 * Recursively reject prototype-pollution keys (anywhere) + credential-shaped keys (treated as
 * forbidden anywhere — payload is the free-form surface, but a credential is unwelcome on any).
 * Runs BEFORE canonicalSerialize so a `__proto__` key never reaches the setter footgun.
 *
 * @param {*} value
 * @param {string} pathStr  dotted path for error messages
 * @param {string[]} errors accumulator
 */
function _scanForbiddenKeys(value, pathStr, errors) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      _scanForbiddenKeys(value[i], `${pathStr}[${i}]`, errors);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const k of Object.keys(value)) {
    if (PROTO_POLLUTION_KEYS.includes(k)) {
      errors.push(
        `${pathStr}.${k}: prototype-pollution key forbidden (pollution vector AND breaks ` +
          `byte-exact canonical determinism via the __proto__ setter)`,
      );
    }
    if (CREDENTIAL_KEY_RE.test(k)) {
      errors.push(
        `${pathStr}.${k}: credential-shaped key forbidden — a provenance event is a ` +
          `permanent signed governance record and MUST NOT carry secrets ` +
          `(#411 signing-vs-model-key separation + security.md "no secrets in logs")`,
      );
    }
    _scanForbiddenKeys(value[k], `${pathStr}.${k}`, errors);
  }
}

function _isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Validate a provenance event against the canonical contract.
 *
 * @param {*} evt
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateProvenanceEvent(evt) {
  const errors = [];

  if (!_isPlainObject(evt)) {
    return { ok: false, errors: ["event MUST be a plain object"] };
  }

  // schema_version
  if (evt.schema_version !== SCHEMA_VERSION) {
    errors.push(
      `schema_version MUST be ${SCHEMA_VERSION} (got ${JSON.stringify(evt.schema_version)})`,
    );
  }

  // kind ∈ closed taxonomy
  if (!EVENT_KINDS.includes(evt.kind)) {
    errors.push(
      `kind MUST be one of ${JSON.stringify(EVENT_KINDS)} (got ${JSON.stringify(evt.kind)})`,
    );
  }

  // ts — ISO-8601 SHAPE + calendar/clock RANGE validity (shape alone accepts month 13 / hour 25)
  const tsMatch = _isNonEmptyString(evt.ts) ? ISO_8601_RE.exec(evt.ts) : null;
  if (!tsMatch) {
    errors.push("ts MUST be a non-empty ISO-8601 timestamp string");
  } else {
    const yr = Number(tsMatch[1]);
    const mo = Number(tsMatch[2]);
    const da = Number(tsMatch[3]);
    const ho = Number(tsMatch[4]);
    const mi = Number(tsMatch[5]);
    const se = Number(tsMatch[6]);
    // Offset-independent calendar/clock validity. Day-of-month is checked against the
    // actual month length (Feb 30 is invalid in EVERY timezone), because `new Date()`
    // silently ROLLS OVER an over-long day (Feb 30 → Mar 2) instead of returning NaN.
    const leap = (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0;
    const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
      mo < 1 ||
      mo > 12 ||
      da < 1 ||
      da > dim[mo - 1] ||
      ho > 23 ||
      mi > 59 ||
      se > 60
    ) {
      errors.push("ts has an out-of-range calendar/clock field");
    } else if (Number.isNaN(new Date(evt.ts).getTime())) {
      errors.push("ts is not a valid calendar timestamp");
    }
  }

  // session
  if (!_isNonEmptyString(evt.session)) {
    errors.push("session MUST be a non-empty string");
  }

  // operator_ref — exact-shape, NEVER a model key
  if (!_isPlainObject(evt.operator_ref)) {
    errors.push(
      "operator_ref MUST be a plain object { verified_id, person_id }",
    );
  } else {
    for (const req of OPERATOR_REF_REQUIRED) {
      if (!_isNonEmptyString(evt.operator_ref[req])) {
        errors.push(`operator_ref.${req} MUST be a non-empty string`);
      }
    }
    for (const k of Object.keys(evt.operator_ref)) {
      if (!OPERATOR_REF_ALLOWED.includes(k)) {
        errors.push(
          `operator_ref.${k} is not an allowed field — operator_ref carries identity ` +
            `(verified_id/person_id[/display_id]) ONLY, never a model/API key ` +
            `(#411 signing-vs-model-key separation)`,
        );
      }
    }
    if (
      "display_id" in evt.operator_ref &&
      !_isNonEmptyString(evt.operator_ref.display_id)
    ) {
      errors.push(
        "operator_ref.display_id, when present, MUST be a non-empty string",
      );
    }
  }

  // payload — plain object (kind-specific contents validated by the emitter, F101-2)
  if (!_isPlainObject(evt.payload)) {
    errors.push("payload MUST be a plain object");
  }

  // Recursively reject prototype-pollution + credential-shaped keys (runs BEFORE
  // canonicalSerialize so __proto__ never reaches the setter). Scan the whole event;
  // operator_ref's allowlist already covers it, payload is the free-form surface.
  _scanForbiddenKeys(evt, "event", errors);

  // prev_link — null (genesis) OR a sha256 hex string. Type-guard BEFORE the regex:
  // String(["aaaa…64"]) coerces a single-element array to the hex string and would pass,
  // then store an ARRAY → byte-mismatch at the seam. Never coerce.
  if (
    evt.prev_link !== null &&
    !(typeof evt.prev_link === "string" && SHA256_HEX_RE.test(evt.prev_link))
  ) {
    errors.push(
      "prev_link MUST be null (genesis) or a 64-char sha256 hex string",
    );
  }

  // no extraneous top-level keys (byte-exact parity requires a closed shape)
  for (const k of Object.keys(evt)) {
    if (!EVENT_KEYS.includes(k)) {
      errors.push(`unexpected top-level key '${k}' (closed event shape)`);
    }
  }

  // canonical-serializability — the byte-exact seam contract. If the event cannot be
  // canonical-serialized (NaN/Infinity/undefined/control chars), it cannot cross the seam.
  if (errors.length === 0) {
    try {
      canonicalSerialize(evt);
    } catch (e) {
      errors.push(`event is not canonical-serializable: ${e.message}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Build a canonical provenance event. Throws on invalid input (fail-loud — a malformed
 * event must never reach the seam).
 *
 * @param {object} args
 * @param {string} args.kind        one of EVENT_KINDS
 * @param {string} args.ts          ISO-8601 timestamp (caller supplies; this module is
 *                                   time-source-agnostic so it stays deterministic/testable)
 * @param {string} args.session     session id
 * @param {object} args.operatorRef { verified_id, person_id, [display_id] }
 * @param {object} args.payload     kind-specific payload (plain object)
 * @param {?string} [args.prevLink] prior event hash, or null for the chain genesis
 * @returns {Readonly<object>} the frozen canonical event
 */
function buildProvenanceEvent(args) {
  if (!_isPlainObject(args)) {
    throw new TypeError("buildProvenanceEvent: args MUST be a plain object");
  }
  const { kind, ts, session, operatorRef, payload } = args;
  const prevLink = "prevLink" in args ? args.prevLink : null;

  // Re-shape operator_ref to the canonical key set (drop nothing, add nothing silently —
  // an unexpected field is surfaced by validation below, not stripped).
  const operator_ref = _isPlainObject(operatorRef)
    ? { ...operatorRef }
    : operatorRef;

  const evt = {
    schema_version: SCHEMA_VERSION,
    kind,
    ts,
    session,
    operator_ref,
    payload,
    prev_link: prevLink === undefined ? null : prevLink,
  };

  const { ok, errors } = validateProvenanceEvent(evt);
  if (!ok) {
    throw new Error(
      `buildProvenanceEvent: invalid event:\n  - ${errors.join("\n  - ")}`,
    );
  }
  return Object.freeze(evt);
}

/**
 * Content hash of an event — sha256 over the canonical bytes. This is the value a SUBSEQUENT
 * event carries as its prev_link (the chain link). Deterministic: identical events → identical
 * hash, regardless of key insertion order (canonicalSerialize sorts keys).
 *
 * @param {object} evt  a valid provenance event
 * @returns {string} 64-char lowercase sha256 hex
 */
function hashProvenanceEvent(evt) {
  const { ok, errors } = validateProvenanceEvent(evt);
  if (!ok) {
    throw new Error(
      `hashProvenanceEvent: refusing to hash an invalid event:\n  - ${errors.join("\n  - ")}`,
    );
  }
  return crypto
    .createHash("sha256")
    .update(canonicalSerialize(evt))
    .digest("hex");
}

/**
 * Link a new event to a prior one: build the new event with prev_link = hash(prior).
 * Pass priorEvent = null for the chain genesis.
 *
 * @param {?object} priorEvent  the prior event, or null for genesis
 * @param {object} args         same shape as buildProvenanceEvent minus prevLink
 * @returns {Readonly<object>}
 */
function chainProvenanceEvent(priorEvent, args) {
  const prevLink = priorEvent === null ? null : hashProvenanceEvent(priorEvent);
  return buildProvenanceEvent({ ...args, prevLink });
}

// ── DECODE ARM (F101-1 v1, loom↔csq seam) ───────────────────────────────────
// loom OWNS the decode RULE; csq owns the decoder that APPLIES it (loom-csq-
// boundary § FORMAT-vs-evaluation). Three v1 decode outputs and where each comes
// from (journal/0251 mapping):
//   decision_id ("event UUID")  — DERIVED: sha256 of the canonical bytes
//                                 (= hashProvenanceEvent). csq computes
//                                 sha256(received_bytes); loom emits canonical
//                                 bytes so received == canonical → identical.
//                                 (This identity holds ONLY while the emitter is
//                                 canonical — a non-canonical producer would make
//                                 received != canonical; loom always emits via
//                                 canonicalSerialize, so the invariant holds.)
//   surface                     — DERIVED from (kind, payload) via deriveSurface
//                                 below; NOT byte-present (Option A: v1 bytes not
//                                 widened).
//   ordering                    — chain-level: prev_link hash-chain DEPTH per
//                                 operator_ref, NOT a stored integer seq and NOT a
//                                 per-event field. Cross-drain stability is
//                                 GUARANTEED under the decided per-session-ledger
//                                 transport (journal/0255 + 0258: gap-free within a
//                                 recorded segment; prefix-stable under partial /
//                                 degraded drain). Ordering remains a CHAIN
//                                 property, so it is intentionally NOT a per-event
//                                 decode here.

/**
 * Derive the governance SURFACE id from a v1 event — the FORMAT-authority rule.
 * surface is NOT byte-present in v1; it is derived from (kind, payload). csq's M18
 * decoder applies this SAME rule and is tested against loom's conformance vector,
 * so drift surfaces as a conformance-test failure, not silent divergence.
 *
 * Rule (payload shapes per provenance-capture-tool.js::classify):
 *   HumanInput                  → "human-input"
 *   Decision   {journal_path}   → payload.journal_path          (the DECISION record)
 *   Delegation {subagent_type?} → payload.subagent_type ?? "delegation:" + tool
 *   Action     {file_path}      → payload.file_path             (write surface)
 *   Action     {command_sha256} → "shell"                       (opaque-by-hash command)
 *   Action     (neither)        → "action:" + payload.tool      (consequential tool, no path)
 *
 * @param {object} evt  a valid v1 provenance event
 * @returns {string} the surface id
 */
function deriveSurface(evt) {
  const { ok, errors } = validateProvenanceEvent(evt);
  if (!ok) {
    throw new Error(
      `deriveSurface: refusing to derive from an invalid event:\n  - ${errors.join("\n  - ")}`,
    );
  }
  const p = evt.payload || {};
  switch (evt.kind) {
    case "HumanInput":
      return "human-input";
    case "Decision":
      if (!_isNonEmptyString(p.journal_path)) {
        throw new Error(
          "deriveSurface: Decision payload MUST carry a non-empty journal_path",
        );
      }
      return p.journal_path;
    case "Delegation":
      if (_isNonEmptyString(p.subagent_type)) return p.subagent_type;
      // Fallback requires a tool name; a Delegation event with neither is
      // malformed (classify always sets tool). Fail loud rather than emit the
      // degraded "delegation:undefined" surface (R1 security LOW-1).
      if (!_isNonEmptyString(p.tool)) {
        throw new Error(
          "deriveSurface: Delegation payload MUST carry a non-empty subagent_type or tool",
        );
      }
      return `delegation:${p.tool}`;
    case "Action":
      if (_isNonEmptyString(p.file_path)) return p.file_path;
      if (_isNonEmptyString(p.command_sha256)) return "shell";
      if (!_isNonEmptyString(p.tool)) {
        throw new Error(
          "deriveSurface: Action payload MUST carry a non-empty file_path, command_sha256, or tool",
        );
      }
      return `action:${p.tool}`;
    default:
      // Unreachable — validateProvenanceEvent already rejects kinds outside the
      // closed taxonomy. Kept as a fail-loud guard if EVENT_KINDS grows without
      // this switch being updated (the coordinated-bump discipline).
      throw new Error(
        `deriveSurface: unhandled kind ${JSON.stringify(evt.kind)} — EVENT_KINDS grew without updating deriveSurface`,
      );
  }
}

/**
 * Decode the FORMAT-derivable fields of a v1 event: decision_id (the content hash /
 * "event UUID") + surface. ORDERING is intentionally NOT included — it is chain-level
 * (prev_link depth per operator_ref; stability guaranteed by the decided
 * per-session-ledger transport, journal/0255 + 0258); the consumer derives it
 * across the chain.
 *
 * @param {object} evt  a valid v1 provenance event
 * @returns {{ decision_id: string, surface: string, schema_version: number, kind: string }}
 */
function decodeProvenanceEvent(evt) {
  return {
    decision_id: hashProvenanceEvent(evt),
    surface: deriveSurface(evt),
    schema_version: evt.schema_version,
    kind: evt.kind,
  };
}

module.exports = {
  EVENT_KINDS,
  SCHEMA_VERSION,
  EVENT_KEYS,
  OPERATOR_REF_ALLOWED,
  validateProvenanceEvent,
  buildProvenanceEvent,
  hashProvenanceEvent,
  chainProvenanceEvent,
  deriveSurface,
  decodeProvenanceEvent,
};
