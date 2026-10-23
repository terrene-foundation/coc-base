"use strict";

/**
 * jcs-canonicalize — RFC 8785 JSON Canonicalization Scheme for the shared
 * loom↔consumer substrate (zero dependencies).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM weft-jcs.js. The implementation was
 * written for the WEFT chain and lived only in `weft-jcs.js`, which is
 * `loom_only:` — a USE/BUILD consumer is not a WEFT distributor and never runs
 * the WEFT conformance suite, so the module was fenced from the sync tiers as
 * orphan-on-ship. The hook-registry contract (schema + validator + emitter,
 * delivered to consumers) then needed the SAME canonicalizer for its
 * `content_sha256`: shipping a contract whose hash function does not ship
 * would hand consumers a manifest they cannot verify. Rather than carry a
 * SECOND implementation (two canonicalizers drift, and a divergent canonical
 * form is the interop hazard RFC 8785 exists to remove), the primitive moved
 * here — a shipping home with a shipping consumer — and `weft-jcs.js` now
 * re-exports it, so the WEFT callers are unchanged.
 *
 * THE SCOPE CONTRACT IS UNCHANGED FROM THE WEFT ORIGINAL, and it is the reason
 * the registry's numbers are integers only: string / safe-integer / boolean /
 * null / dense array / plain object, with floats and unsafe integers REJECTED
 * fail-closed rather than serialized through the ECMAScript
 * shortest-round-trip rule (the documented cross-language interop hazard).
 * A value is either canonicalized RFC-8785-correctly or refused; it is never
 * silently mis-serialized.
 *
 * Equivalence with the original is pinned by
 * `.claude/audit-fixtures/hook-registry/jcs-vectors.json` (known-answer rows)
 * and by the battery case that runs BOTH modules over every vector and
 * requires identical output.
 */

const crypto = require("crypto");

/**
 * Serialize a JSON value to its RFC-8785 canonical string form.
 *
 * @param {*} value — a JCS-representable value (string/int/bool/null/array/object)
 * @returns {string} the canonical serialization
 * @throws {TypeError} on a non-representable value (float, NaN, Infinity, unsafe
 *   integer, undefined, function, symbol, bigint) — fail-closed, never silent.
 */
function jcsCanonicalize(value) {
  return serialize(value);
}

function serialize(value) {
  if (value === null) return "null";

  const t = typeof value;

  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    // Fail-closed: only safe integers. Floats/NaN/Infinity/unsafe ints are the
    // RFC-8785 number-canonicalization interop hazard (R6) — reject, never guess.
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new TypeError(
        `jcs-canonicalize: non-integer or unsafe-integer number rejected (R6 float-interop guard): ${value}`,
      );
    }
    // A safe integer's canonical ES6 Number serialization is its decimal string.
    return String(value);
  }

  if (t === "string") {
    // JSON.stringify produces RFC-8785-compliant string serialization: it escapes
    // U+0022 (") and U+005C (\), uses the two-char forms (\b\t\n\f\r) where they
    // exist and lowercase \u00xx for the remaining C0 controls, does NOT escape
    // forward slash, and passes all other codepoints (incl. non-ASCII) through as
    // UTF-8. This is exactly the RFC-8785 §3.2.2.2 string production.
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    // PLAIN array ONLY (symmetric with the plain-object guard below). An `Array`
    // SUBCLASS (`class X extends Array`) passes `Array.isArray` but is outside the
    // JSON data domain; reject it fail-closed so the two container branches treat
    // exotics consistently. A parsed-JSON array always has `Array.prototype`.
    // (A Proxy-wrapped array still passes — Proxies are transparent to both
    // `Array.isArray` and `getPrototypeOf`; that in-process-adversary case is out
    // of the parsed-JSON threat model and is contained by verifyWeftChain's
    // totality — see the module SCOPE note.)
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(
        "jcs-canonicalize: non-plain array (Array subclass or array-like) is not JCS-representable",
      );
    }
    // Iterate by index (NOT `.map`, which SKIPS holes): a SPARSE array like
    // `[1, , 3]` has a hole at index 1 that `.map` would elide, producing the
    // invalid-JSON, RFC-8785-divergent string `"[1,,3]"` silently. A hole is
    // semantically `undefined`, which is already rejected below — so reject it
    // here too, fail-closed and consistent (a silent divergent canonical form is
    // exactly the cross-impl interop hazard R6 exists to prevent). Not reachable
    // from parsed JSON (JSON has no array elision), but the fail-closed contract
    // is absolute.
    const parts = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        throw new TypeError(
          `jcs-canonicalize: sparse array (hole at index ${i}) is not JCS-representable`,
        );
      }
      parts.push(serialize(value[i]));
    }
    return "[" + parts.join(",") + "]";
  }

  if (t === "object") {
    // PLAIN object ONLY (fail-closed, same class as the float/sparse-array
    // rejection above). An exotic host object — Date / Map / Set / RegExp / a
    // class instance — has no own enumerable keys and would otherwise serialize
    // to "{}", COLLIDING with a genuine `{}` and diverging from what a conformant
    // RFC-8785 2nd implementation produces (the interop hazard R6 exists to
    // prevent). A plain object has `Object.prototype` (JSON.parse output, object
    // literals) or a null prototype (`Object.create(null)`); anything else is
    // outside the JCS subset and is rejected rather than silently mis-serialized.
    // Not reachable from parsed JSON (which yields only plain objects), but the
    // fail-closed scope contract is absolute.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(
        `jcs-canonicalize: non-plain object (${value.constructor ? value.constructor.name : "exotic"}) is not JCS-representable`,
      );
    }
    // RFC-8785 §3.2.3: members sorted by the UTF-16 code units of the key. JS
    // Array.prototype.sort() on strings compares by UTF-16 code unit already
    // (including correct ordering of surrogate pairs vs BMP), so a bare .sort()
    // yields the RFC-8785 member order.
    const keys = Object.keys(value).sort();
    const members = keys.map(
      (k) => JSON.stringify(k) + ":" + serialize(value[k]),
    );
    return "{" + members.join(",") + "}";
  }

  // undefined, function, symbol, bigint — not JCS-representable.
  throw new TypeError(
    `jcs-canonicalize: value of type '${t}' is not JCS-representable`,
  );
}

/**
 * sha256 hex digest of a value's RFC-8785 canonical form.
 * This is the WEFT chain-link primitive: `prev_link = sha256Jcs(priorEvent)`.
 *
 * @param {*} value
 * @returns {string} lowercase 64-char hex sha256 digest
 */
function sha256Jcs(value) {
  return crypto
    .createHash("sha256")
    .update(jcsCanonicalize(value), "utf8")
    .digest("hex");
}

module.exports = { jcsCanonicalize, sha256Jcs };
