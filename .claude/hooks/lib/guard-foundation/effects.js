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

function endpoint(kind, value) {
  if (!ENDPOINT_KIND_SET.has(kind)) {
    throw new TypeError(`unknown endpoint kind: ${String(kind)}`);
  }
  if (kind === ENDPOINT_KINDS.UNKNOWN) {
    throw new TypeError("use endpointUnknown() to build an unknown endpoint");
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`endpoint(${kind}) requires a non-empty string value`);
  }
  return Object.freeze({ kind, value });
}

/** The explicit "provider could not establish this endpoint" value. */
function endpointUnknown() {
  return Object.freeze({ kind: ENDPOINT_KINDS.UNKNOWN, value: null });
}

function byteProvenance(spec = {}) {
  const { observed = null, prospective = null, basis = BYTE_BASES.UNKNOWN } = spec;
  if (!BYTE_BASE_SET.has(basis)) {
    throw new TypeError(`unknown byte basis: ${String(basis)}`);
  }
  for (const n of [observed, prospective]) {
    if (n !== null && (!Number.isInteger(n) || n < 0)) {
      throw new TypeError("byte counts must be non-negative integers or null");
    }
  }
  return Object.freeze({ observed, prospective, basis });
}

/**
 * effect — one ordered effect entry. Endpoint requirements per kind:
 *   read-bytes / write-bytes / load-and-execute : from AND to (both moves)
 *   delete                                      : from, to must be null
 * `seq` is intentionally absent here; `effectList()` assigns it.
 */
function effect(kind, spec = {}) {
  if (!EFFECT_KIND_SET.has(kind)) {
    throw new TypeError(`unknown effect kind: ${String(kind)}`);
  }
  const { from = null, to = null, bytes: b = byteProvenance() } = spec;

  if (kind === EFFECT_KINDS.DELETE) {
    if (from === null) throw new TypeError("delete effect requires `from` (the removed path)");
    if (to !== null) throw new TypeError("delete effect has no destination; `to` must be null");
  } else {
    if (from === null || to === null) {
      throw new TypeError(
        `${kind} effect requires BOTH endpoints (from and to); use endpointUnknown() when one could not be established`,
      );
    }
  }
  if (!from || typeof from !== "object" || !ENDPOINT_KIND_SET.has(from.kind)) {
    throw new TypeError("effect `from` must be an endpoint from effects.js");
  }
  if (to !== null && (typeof to !== "object" || !ENDPOINT_KIND_SET.has(to.kind))) {
    throw new TypeError("effect `to` must be an endpoint from effects.js (or null for delete)");
  }

  return Object.freeze({ kind, from, to, bytes: b });
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
 * so ordering is structural and cannot drift from the array.
 */
function effectList(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("effectList requires an array of effect() entries");
  }
  return entries.map((entry, i) => {
    if (!entry || typeof entry !== "object" || !EFFECT_KIND_SET.has(entry.kind)) {
      throw new TypeError(`effectList entry ${i} is not an effect() value`);
    }
    if (entry.seq !== undefined) {
      throw new TypeError("effectList assigns seq; do not hand-set it");
    }
    return Object.freeze({ ...entry, seq: i + 1 });
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
  endpoint,
  endpointUnknown,
  byteProvenance,
  effect,
  effectList,
};
