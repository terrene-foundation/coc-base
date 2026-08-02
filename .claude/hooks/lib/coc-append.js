/**
 * coc-append — stamped append-log helper for observations.jsonl / violations.jsonl
 *
 * Shard M6 D (workspaces/multi-operator-coc, design v11 §5.3).
 *
 * Single-writer artifact contention: under N concurrent operators,
 * observations.jsonl and violations.jsonl silently clobber when each
 * writer constructs a bare line without per-record attribution. This
 * module is the structural defense: every append carries the emitter's
 * verified_id + person_id + a detached signature over the canonical
 * record bytes, so a forensic scan can attribute every row to one human.
 *
 * Contract:
 *   appendStamped(repoDir, filePath, partial, opts) → {ok, error?, reason?}
 *     - partial: caller-supplied content (any JSON-serializable shape).
 *     - opts.identity: {verified_id, person_id, display_id?} — REQUIRED.
 *     - opts.sign: function (bytes) → {ok, sig} | {ok:false, ...} —
 *       caller-injectable for tests; defaults to coc-sign::sign with
 *       discovered key material when omitted.
 *     - Atomic O_APPEND for lines ≤2KB (matches state-io.js
 *       MAX_LINE_BYTES). Truncates evidence-shaped fields on overflow.
 *
 * Why a separate module from state-io.js::appendViolation:
 *   - state-io owns trust-posture state (single-writer-by-design); this
 *     module owns multi-writer attribution. They share the 2KB cap and
 *     the O_APPEND atomic-write technique but have different stamping
 *     contracts (state-io stamps session_id; this stamps verified_id +
 *     person_id + sig).
 *
 * Per zero-tolerance.md Rule 3: every failure path returns a typed
 * error object; never silent-fallback to unsigned, never throw uncaught.
 */

"use strict";

// `fs` is deliberately absent: every write from this module goes through append-sink.js
// (loom#1349), so a direct fs handle here would only invite a future un-hardened append.
const path = require("path");
const crypto = require("crypto");

const { canonicalSerialize, sign: defaultSign } = require(
  path.join(__dirname, "coc-sign.js"),
);
// M9.1 R4 Sec-R4-S-01 — shared strip helper for the `repo` field per
// `security.md` § Multi-Site Kwarg Plumbing (single SSOT, every writer
// routes through it).
const { stripRepoPath } = require(path.join(__dirname, "state-io.js"));
// loom#1349 — the ONE hardened append primitive; see append-sink.js for the six defenses.
const { appendSinkLine } = require(path.join(__dirname, "append-sink.js"));

// Match state-io.js MAX_LINE_BYTES so the same POSIX O_APPEND atomicity
// guarantees (write < PIPE_BUF = 4096) apply to both append surfaces.
const MAX_LINE_BYTES = 2048;

function _newId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Append a stamped record line to filePath atomically.
 *
 * The stamped record shape:
 *   {
 *     id, timestamp, session_id, repo,
 *     verified_id, person_id, [display_id],
 *     ...partial,
 *     sig: "<armored signature over canonical bytes of (record - sig)>"
 *   }
 *
 * Sig is computed over canonical bytes with the sig field absent so the
 * signature can be verified by re-canonicalizing the parsed record after
 * stripping sig — symmetric with coordination-log _canonicalHash.
 *
 * @param {string} repoDir - absolute path to the repo root
 * @param {string} filePath - absolute path to the target append-log file
 * @param {object} partial - caller-supplied content
 * @param {object} opts
 * @param {{verified_id:string, person_id:string, display_id?:string}} opts.identity
 * @param {function} [opts.sign] - optional sign(bytes, signOpts) → {ok, sig}
 * @param {object} [opts.signOpts] - forwarded to opts.sign if provided
 * @returns {{ok:true, id:string, line:string} | {ok:false, error:string, reason:string}}
 */
function appendStamped(repoDir, filePath, partial, opts) {
  if (!repoDir || typeof repoDir !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "repoDir must be a non-empty string",
    };
  }
  if (!filePath || typeof filePath !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "filePath must be a non-empty string",
    };
  }
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
    return {
      ok: false,
      error: "invalid argument",
      reason: "partial must be a non-array object",
    };
  }
  const o = opts || {};
  const identity = o.identity;
  if (
    !identity ||
    typeof identity.verified_id !== "string" ||
    !identity.verified_id ||
    typeof identity.person_id !== "string" ||
    !identity.person_id
  ) {
    // Per zero-tolerance Rule 3a: typed guard, not opaque AttributeError.
    return {
      ok: false,
      error: "missing identity",
      reason:
        "opts.identity must carry non-empty verified_id and person_id (run /whoami --register if un-rostered)",
    };
  }

  // The id, timestamp, session_id, repo, identity-stamp fields PRECEDE
  // the caller's partial so the canonical bytes include them in the
  // signature scope. Caller-provided keys with the same names override
  // — explicit-by-construction.
  // M9.1 R4 Sec-R4-S-01 — strip the home-prefix from repoDir before
  // stamping into the canonical signed bytes. Pre-fix the stamped path
  // wrote `repo: repoDir` (absolute path) under cryptographic signature,
  // re-leaking the operator-username PII the R3-S-01 fix-wave was
  // designed to suppress (and worse: non-repudiable under the signer's
  // key). Routes through the shared `stripRepoPath` helper exported from
  // state-io.js per `security.md` § Multi-Site Kwarg Plumbing.
  const prefix = {
    id: _newId("rec"),
    timestamp: new Date().toISOString(),
    // Bounded at ingest: env-derived and attacker-influenceable, and an unbounded value
    // here inflates the record past the pre-sign probe, which downgrades the row to the
    // caller's unsigned fallback (see `detect-violations.js::_logViolation`). Mirrors the
    // same bound in `state-io.js::appendViolation` so the two appenders agree.
    session_id: String(process.env.CLAUDE_SESSION_ID || "unknown").slice(0, 128),
    repo: stripRepoPath(repoDir),
    verified_id: identity.verified_id,
    person_id: identity.person_id,
  };
  if (identity.display_id) prefix.display_id = identity.display_id;

  const record = Object.assign({}, prefix, partial);

  // Per Sec-LOW-2 (M6 D, 2026-05-22): refuse-on-overflow BEFORE signing
  // rather than truncating AFTER signing. The prior implementation
  // signed the original record bytes, then mutated record.evidence /
  // dropped fields to fit MAX_LINE_BYTES — but the signature on
  // record.sig was computed over the PRE-truncation bytes, so a
  // verifier re-canonicalizing the parsed line (strip sig, recompute)
  // would compute different bytes and the signature would fail to
  // verify. Loud refusal keeps caller's evidence intact (the caller
  // can decide to shrink + retry); silent truncation-after-signing
  // would have produced lines that look valid but verify-fail later.
  //
  // The size probe serializes (record - sig) padded by a worst-case
  // signature length so we don't sign a record we then have to throw
  // away. Actual signature length depends on the signer (ed25519 → 64
  // raw bytes → ~88 base64 chars + JSON quotes); 128 is a comfortable
  // upper bound that matches the canonicalSerialize+JSON.stringify
  // overhead distinction in practice.
  const SIG_RESERVE = 128;
  const probe = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(probe, "utf8") + SIG_RESERVE > MAX_LINE_BYTES) {
    return {
      ok: false,
      error: "record too large",
      reason: `serialized line (${Buffer.byteLength(probe, "utf8")}B + ~${SIG_RESERVE}B sig reserve) exceeds MAX_LINE_BYTES (${MAX_LINE_BYTES})`,
      size: Buffer.byteLength(probe, "utf8"),
      max: MAX_LINE_BYTES,
    };
  }

  // Canonical-serialize (record - sig) → bytes → sign → stamp sig.
  let bytes;
  try {
    bytes = canonicalSerialize(record);
  } catch (err) {
    return {
      ok: false,
      error: "canonical-serialize failed",
      reason: err && err.message ? err.message : String(err),
    };
  }

  const signFn = typeof o.sign === "function" ? o.sign : defaultSign;
  const signOpts = o.signOpts || {};
  const sigResult = signFn(bytes, signOpts);
  if (!sigResult || !sigResult.ok) {
    return {
      ok: false,
      error: sigResult && sigResult.error ? sigResult.error : "sign failed",
      reason:
        sigResult && sigResult.reason
          ? sigResult.reason
          : "sign returned non-ok result without reason",
    };
  }
  record.sig = sigResult.sig;

  // Serialize the stamped record. Use compact JSON (no pretty-print) to
  // stay within the 2KB POSIX-atomic-append cap. A final guard catches
  // the case where the actual signature exceeds SIG_RESERVE (e.g. a
  // custom signer emits a larger armoring): refuse rather than write a
  // line that violates the POSIX-atomic-append contract OR a line
  // whose signed bytes differ from the disk bytes.
  // Measured over the PAYLOAD, matching the pre-sign probe at the top of this function
  // (`JSON.stringify(record) + "\n"`) and the writer that consumes this line
  // (`append-sink.js` builds `Buffer.from(line + "\n")`). This guard previously sized the
  // JSON alone, so a signed record of exactly MAX_LINE_BYTES passed it and wrote one byte
  // over — against a guard whose own comment above refuses precisely to "write a line that
  // violates the POSIX-atomic-append contract". Under the default ed25519 signer the
  // pre-sign probe binds first (~2029 B), so this was not reachable in production; it
  // becomes reachable via `opts.sign`, which is the exact case the comment names. Every
  // sibling appender already measures the newline — `transport-filesystem.js:165` as
  // `+ 1`, `capability-ledger` / `member-registry` / `coc-emit` / `upstream-canon-pointer`
  // as `+ "\n"`; this line was the lone dissenter.
  const line = JSON.stringify(record);
  const lineBytes = Buffer.byteLength(line + "\n", "utf8");
  if (lineBytes > MAX_LINE_BYTES) {
    return {
      ok: false,
      error: "record too large",
      reason: `signed line (${lineBytes}B incl. newline) exceeds MAX_LINE_BYTES (${MAX_LINE_BYTES}); SIG_RESERVE (${SIG_RESERVE}B) was insufficient`,
      size: lineBytes,
      max: MAX_LINE_BYTES,
    };
  }

  // loom#1349 — routed through the shared hardened primitive, which mkdir -p's the parent (the
  // caller passes an absolute path and first append would otherwise ENOENT) but runs containment
  // against `repoDir` BEFORE that mkdir. Every row here carries verified_id + person_id, so a
  // symlinked sink escaping the gitignore fence leaks operator-correlatable identity; the sink is
  // also held at 0o600 rather than the world-readable 0o644 appendFileSync produced.
  //
  // MAX_LINE_BYTES stays enforced ABOVE, before signing — the helper deliberately does not cap,
  // so this module keeps its refuse-rather-than-truncate-after-sign contract.
  // R2 F1 — the sink for BOTH real callers (`detect-violations.js::_logViolation`,
  // `learning-utils.js::logObservation`) is `resolveStateDir(cwd)/…`, which resolves to the MAIN
  // checkout BY DESIGN: a worktree's `.claude/learning/` is auto-deleted on cleanup, so state I/O
  // deliberately escapes cwd (`state-resolver.js` header, red-team CRIT-2). Containing against
  // `repoDir` alone therefore refused the DESIGNED path in every worktree session — and because
  // both callers fall through to an UNSIGNED legacy append when the stamped write is refused, that
  // fail-closed-at-the-sink became fail-OPEN at the attribution: signed identity-attributed rows
  // silently downgraded to `attribution:"un-rostered"`, which `knowledge-convergence.md` MUST-6
  // requires to be stamped. Declaring the main checkout as a second legitimate root fixes it
  // WITHOUT widening the fence: a genuine escape still lands under neither root and is refused.
  // `repoDir` itself stays the provenance value stamped into the signed record above.
  const boundaryRoots = [];
  try {
    const { resolveMainCheckout } = require(path.join(__dirname, "state-resolver.js"));
    const mainCheckout = resolveMainCheckout(repoDir);
    if (mainCheckout) boundaryRoots.push(mainCheckout);
  } catch {
    // Resolver unavailable — `repoDir` remains the only root; a state-dir sink then fails CLOSED
    // (loudly, to the caller) rather than being written somewhere unverified.
  }
  const w = appendSinkLine({
    repoDir,
    additionalRoots: boundaryRoots,
    sinkPath: filePath,
    line,
  });
  if (!w.ok) return { ok: false, error: "append failed", reason: `${w.error}: ${w.reason}` };

  return { ok: true, id: record.id, line };
}

module.exports = {
  appendStamped,
  MAX_LINE_BYTES,
};
