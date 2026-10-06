/**
 * transport-filesystem — Transport implementation for the multi-operator
 * coordination log on a shared local checkout.
 *
 * Architecture: workspaces/multi-operator-coc/02-plans/01-architecture.md §3
 * (transport, filesystem variant). Implements the four-method Transport
 * contract declared by `coordination-log.js`:
 *
 *   - readAllRecords()   → Promise<Array<Record>>
 *   - appendRecord(r)    → Promise<{ok:true} | {ok:false, error:string}>
 *   - headHash()         → Promise<string>   (sha256 of file content)
 *   - peerHighWaterFor(verified_id) → Promise<number | null>
 *
 * Storage layout: one JSONL file at `.claude/learning/coordination-log.jsonl`
 * (resolved via state-io.js::resolveLogPath). Each line is the canonical
 * JSON of one signed record terminated by "\n". Records MUST fit in 2KB
 * (line length, including the trailing newline) so the POSIX `O_APPEND`
 * atomicity contract holds — POSIX guarantees writes ≤PIPE_BUF (4KB on
 * Linux + macOS) are atomic, so concurrent processes appending lines never
 * tear each other's writes when both stay under the 2KB cap.
 *
 * Concurrency model (filesystem variant). Concurrent appends are
 * O_APPEND-atomic; the kernel orders them serially. Concurrent reads-then-
 * appends (e.g. two processes both reading current state, then both
 * appending based on their now-stale snapshots) can produce out-of-order
 * `seq` values per emitter — the engine's fold rule 2 catches the broken
 * chain and rejects the duplicate; the transport itself does NOT add
 * locking on top of O_APPEND. For strict ordering, use the git-ref
 * transport (shard A3) which adds fetch-merge-append-retry.
 *
 * The 2KB ceiling is a transport-layer invariant: appendRecord MUST reject
 * any line that would exceed the cap, with a typed error. Bigger records
 * (genesis-anchors carrying large `gh_api_*_capture` blobs, owner-signed
 * checkpoint digests with embedded archive references) belong on the
 * git-ref transport — A3 handles the >2KB case.
 *
 * Style: CommonJS, zero-dep, matches sibling .claude/hooks/lib/*.js.
 */

"use strict";

const fs = require("fs");
// `path` is deliberately NOT required. Its only use was `path.dirname(logPath)`
// for the pre-#1349 unchecked mkdir, which is gone (the primitive owns directory
// creation, and creating it here would defeat defense 1 — see `appendRecord`).
// `state-resolver.js` is required LAZILY inside `appendRecord`, not here, so the
// five read-only hooks that load this module do not pull in its `child_process`
// dependency on a path that never resolves a containment root — the same shape
// `coc-emit.js` uses at its own call site on this sink.
const crypto = require("crypto");
const { resolveLogPath } = require("./state-io.js");
const { appendSinkLine } = require("./append-sink.js");

/**
 * The `appendSinkLine` `error` tags that mean THE SUBSTRATE FAILED, as opposed
 * to THE WRITE WAS REFUSED. `appendRecord` re-raises these so the throw-vs-
 * typed-result split this transport has always declared survives the loom#1349
 * routing (see § FAILURE DIRECTION in `appendRecord`).
 *
 * Membership is by what the operator can DO about it, which is the distinction
 * the two channels encode. `mkdir failed` / `open failed` / `lstat failed` /
 * `fstat failed` / `short write` / `append failed` are ENOSPC, EACCES, EIO and
 * their relatives — the disk, the permissions or the filesystem broke, and the
 * record is not at fault. Everything else `appendSinkLine` can report is a
 * REFUSAL of a specific untrustworthy sink (`containment failed`,
 * `symlink refused`, `hard link refused`, `not a regular file`,
 * `sink identity mismatch`) or a caller bug (`bad arguments`); those stay in
 * the typed channel where they are already handled.
 *
 * The set is written as an ALLOWLIST of throwers rather than a denylist of
 * rejections on purpose: a new REFUSAL tag added to the primitive then lands in
 * the typed channel by default, which is the safe direction. A new SUBSTRATE
 * tag would be mis-filed as a rejection — so if the primitive grows one, add it
 * here. Pinned by the fixture case that enumerates the primitive's tags.
 */
const SUBSTRATE_FAILURES = new Set([
  "mkdir failed",
  "open failed",
  "lstat failed",
  "fstat failed",
  "short write",
  "append failed",
]);

/**
 * Per-line atomicity cap (architecture §2.2). POSIX guarantees O_APPEND
 * writes ≤PIPE_BUF are atomic; PIPE_BUF is 4KB on Linux + macOS. We use
 * 2KB as the half-budget so a JSON line plus its trailing newline is well
 * inside the kernel's atomic-write threshold under every layered shim
 * (encrypted overlay fs, fuse, etc.).
 */
const MAX_LINE_BYTES = 2048;

/**
 * Hash of an empty / missing log. SHA-256 of zero bytes. Pinned here so
 * callers can compare to detect the empty-log case without re-hashing.
 */
const EMPTY_HASH = crypto.createHash("sha256").update("").digest("hex");

/**
 * Construct a filesystem-backed Transport rooted at `repoDir`. The log
 * lives at `<repoDir>/.claude/learning/coordination-log.jsonl` (resolved
 * via state-io.js::resolveLogPath). The transport is stateless beyond the
 * file path; instances are cheap to construct and safe to discard.
 *
 * @param {string} repoDir - absolute path to the repo root that owns the
 *   coordination log. State-io.js handles the .claude/learning/ resolution.
 * @returns {Transport} an object with readAllRecords, appendRecord,
 *   headHash, peerHighWaterFor — all async, returning Promises.
 */
function createFilesystemTransport(repoDir) {
  if (typeof repoDir !== "string" || repoDir.length === 0) {
    throw new Error(
      "createFilesystemTransport: repoDir must be a non-empty string",
    );
  }
  const logPath = resolveLogPath(repoDir);

  /**
   * Read every record from the log. Malformed lines are logged and
   * skipped — the engine's fold rule 1 (signature verification) catches
   * mal-shaped records that survive parse anyway.
   *
   * Returns [] when the log file does not exist (fresh repo). Order of
   * returned records is the order on disk (insertion order under O_APPEND
   * atomicity); the engine's fold sorts/groups by emitter.
   *
   * @returns {Promise<Array<object>>}
   */
  async function readAllRecords() {
    return (await readAllRecordsDetailed()).records;
  }

  /**
   * The SAME read as `readAllRecords`, but it also REPORTS what it threw away.
   *
   * loom#1881 HIGH-1. `readAllRecords` skips a line that will not `JSON.parse`
   * and returns only the survivors, so a caller reasoning about ERASED records
   * cannot distinguish "this line was never there" from "this line was
   * destroyed" — the drop happens BEFORE the fold, so a destroyed record is
   * never `rejected` either, and every fold-level tamper counter is blind to
   * it. Measured: corrupting a `codify-lease-release` line to unparseable junk
   * turned a correctly-DENIED write back into a GRANT, because the only
   * instrument that could have seen the erasure discarded its own evidence
   * (rules/instrument-discipline.md MUST-1).
   *
   * `lineIndices[k]` is the FILE line number of `records[k]`, and
   * `parseDropLines` holds the file line numbers that did not parse. Both are
   * FILE positions, not array positions, so the two arrays share one ordering
   * axis and a caller can ask "was anything unreadable appended AFTER this
   * record?" — the question that scopes an indeterminacy to the records it
   * could actually implicate instead of to the whole log.
   *
   * `readAllRecords` is unchanged in behaviour and delegates here, so no
   * existing caller sees a difference.
   *
   * @returns {Promise<{records: Array<object>, lineIndices: Array<number>,
   *   parseDropLines: Array<number>}>}
   */
  async function readAllRecordsDetailed() {
    let raw;
    try {
      raw = await fs.promises.readFile(logPath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return { records: [], lineIndices: [], parseDropLines: [] };
      }
      throw err;
    }
    if (raw.length === 0) {
      return { records: [], lineIndices: [], parseDropLines: [] };
    }
    const out = [];
    const lineIndices = [];
    const parseDropLines = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        // Malformed line: log, RECORD THE POSITION, and continue. The engine's
        // fold rule 1 catches mal-shaped records that DO parse; this path
        // covers torn writes that survived a kernel crash or storage hiccup —
        // single-line skip is still the right disposition since the broken
        // line cannot be recovered, but the skip is no longer SILENT to a
        // caller that asks.
        parseDropLines.push(i);
        try {
          process.stderr.write(
            `transport-filesystem: skipping malformed line ${i} in ${logPath}\n`,
          );
        } catch {
          // best-effort logging
        }
        continue;
      }
      if (obj && typeof obj === "object") {
        out.push(obj);
        lineIndices.push(i);
      } else {
        // Parsed, but not a record (a bare `null`, number or string on its own
        // line). It is not a usable record and it is not a parse failure —
        // count it with the drops, since from the caller's perspective a line
        // that yields no record is a line whose content is UNKNOWN.
        parseDropLines.push(i);
      }
    }
    return { records: out, lineIndices, parseDropLines };
  }

  /**
   * Append a signed record. The record is canonicalised via
   * `JSON.stringify(record)` (Node's canonical representation for this
   * surface — keys preserved in insertion order; the engine's
   * `canonicalSerialize` in coc-sign.js owns the sort-keys discipline at
   * signing time, so by the time a record reaches this method its
   * canonical bytes are already pinned by the signature).
   *
   * Returns `{ok:true}` on success. Returns `{ok:false, error: <reason>}`
   * when:
   *   - the line (including its trailing newline) would exceed 2KB —
   *     the O_APPEND atomicity ceiling; larger records belong on the
   *     git-ref transport (shard A3),
   *   - the record is not a non-null object,
   *   - the sink is not trustworthy — a symlinked ancestor or sink, a
   *     hard-linked sink, a planted FIFO, a swapped sink directory, or a
   *     path that resolves outside every declared containment root. These
   *     are REJECTIONS of the write, in the same channel as the two above:
   *     nothing was written and the caller may carry on.
   *
   * Throws on filesystem errors (ENOSPC, EACCES, etc.) — the caller is
   * the engine's append-then-fold loop; a thrown filesystem error is the
   * right signal that the substrate failed, not that the record was
   * rejected. That split is PRESERVED across the loom#1349 routing below:
   * `appendSinkLine` never throws, so the substrate classes it reports as
   * typed results are re-raised here rather than being silently demoted
   * into the rejection channel (see § FAILURE DIRECTION in the body).
   *
   * @param {object} record - signed coordination-log record
   * @returns {Promise<{ok:true} | {ok:false, error:string}>}
   */
  async function appendRecord(record) {
    if (!record || typeof record !== "object") {
      return { ok: false, error: "record must be a non-null object" };
    }
    let line;
    try {
      line = JSON.stringify(record);
    } catch (err) {
      return {
        ok: false,
        error: `record is not JSON-serializable: ${err && err.message ? err.message : String(err)}`,
      };
    }
    // Trailing newline counts toward the 2KB atomicity budget — kernel
    // sees the bytes including the newline.
    const totalBytes = Buffer.byteLength(line, "utf8") + 1;
    if (totalBytes > MAX_LINE_BYTES) {
      return {
        ok: false,
        error:
          `record too large for O_APPEND atomicity: ${totalBytes}B > ${MAX_LINE_BYTES}B ` +
          `(2KB cap). Use the git-ref transport for larger captures.`,
      };
    }
    // ── loom#1349, closed here 2026-09-01. ────────────────────────────────
    //
    // This was the SECOND live violator of `append-sink.js` § Scope, and it
    // survived a fix that believed it had made that claim true. The idiom
    // below used to be `fs.promises.mkdir(…,{recursive:true})` then
    // `fs.promises.appendFile(logPath, line + "\n")` — the exact pre-#1349
    // shape, with no symlink refusal, no `O_NOFOLLOW` and no explicit mode —
    // writing the SAME `coordination-log.jsonl` that `coc-emit.js` (the
    // canonical signed-record emitter behind 11 modules) already routes
    // through the primitive. Left unrouted it kept that sink hardened at 3 of
    // its 4 writers, and it is LIVE: five production hooks require this
    // module, and `adjacency-leasecheck.js::autoClaim` reaches this method.
    //
    // THE UNCHECKED MKDIR IS GONE, NOT MOVED. Do not reinstate it "to be
    // safe". `appendSinkLine` does its own `mkdirSync` — AFTER resolving the
    // deepest EXISTING ancestor and containing it (defense 1). A mkdir here
    // would run BEFORE that check and would itself follow an ancestor
    // symlink, creating the sink directory inside the link's target before
    // any containment check could refuse. The ordering IS the defense.
    //
    // § CONTAINMENT ROOT. The sink is `resolveStateDir(repoDir)/…`, which
    // resolves to the MAIN checkout BY DESIGN (`state-resolver.js` header;
    // `trust-posture.md` MUST-1): a linked worktree's `.claude/learning/` is
    // auto-deleted on cleanup, so coordination state deliberately escapes
    // cwd. Containing against `repoDir` ALONE would therefore refuse the
    // DESIGNED path in every worktree session — the R2 F1 case
    // `appendSinkLine`'s `additionalRoots` note names, and the same boundary
    // bug `wip-discipline-guard.js::recordOverride` documents at its own call
    // site. The MAIN CHECKOUT is declared, deliberately NOT the resolved
    // state dir: declaring the state dir would be CIRCULAR, since
    // `resolveStateDir` builds it by lexical join, so a `.claude/learning`
    // symlinked out of the repo would appear under its own realpath and pass
    // vacuously — defeating the exact attack the check exists to block.
    // Against the main checkout that symlink lands under neither root and is
    // still refused.
    //
    // Resolved through `requireMainCheckout` — the FAIL-CLOSED accessor — and
    // not the legacy `resolveMainCheckout`, because what is declared here is a
    // CONTAINMENT ROOT and the legacy accessor silently returns its own `cwd`
    // argument when git cannot identify a main checkout. The `!ok` branch
    // declares NOTHING: a sink outside `repoDir` is then refused rather than
    // written somewhere unverified, while a sink INSIDE `repoDir` — the
    // legitimate non-git / unresolvable-git case the tests exercise — still
    // lands, because `repoDir` is always root[0].
    //
    // § SYNC INSIDE AN ASYNC METHOD — deliberate, and cheaper than it looks.
    // `appendSinkLine` is synchronous, so this method's one `await` on the
    // write is gone. That is acceptable HERE, on a hook path, for three
    // measured-by-inspection reasons rather than by assumption. (1) The
    // sibling that writes THIS SAME SINK on THESE SAME hook paths —
    // `coc-emit.js::_defaultAppend`, the majority writer — is already fully
    // synchronous, so the cost is one this substrate already pays. (2) The
    // sole production caller, `adjacency-leasecheck.js::autoClaim`, performs
    // a SYNCHRONOUS `sign()` (an ssh-keygen subprocess spawn) on the line
    // before this call; a subprocess spawn dominates a dozen stat/open/write
    // syscalls by orders of magnitude, so the append is not the term that
    // sets this path's latency. (3) A hook is a short-lived single-shot
    // process with no concurrent work to yield to, so the event-loop yield
    // the `fs.promises` form bought was never collected by anything. The
    // method stays `async` because the Transport contract in
    // `coordination-log.js` declares it so and the git-ref transport
    // implements the same shape.
    //
    // § FAILURE DIRECTION — PRESERVED, not flattened. This method's contract
    // has TWO channels: a typed `{ok:false, error}` for a REJECTED RECORD,
    // and a THROW for a failed SUBSTRATE (ENOSPC, EACCES). `appendSinkLine`
    // never throws — it converts everything to a typed result — so a naive
    // route would silently demote every substrate failure into the rejection
    // channel and tell the engine's append-then-fold loop the record was
    // refused when in fact the disk is full. The classes are therefore split
    // back apart on the way out: the SUBSTRATE set is re-raised, everything
    // else is a rejection. (Traced: the one production caller discards the
    // result AND catches, so both directions are inert THERE — which is
    // exactly why the split has to be maintained deliberately here, since no
    // caller's behaviour would have caught its loss.)
    const boundaryRoots = [];
    try {
      const { requireMainCheckout } = require("./state-resolver.js");
      const mainCheckout = requireMainCheckout(repoDir);
      if (mainCheckout.ok) boundaryRoots.push(mainCheckout.repoDir);
    } catch {
      // Resolver unavailable — `repoDir` remains the only root and a
      // main-checkout sink fails CLOSED rather than being written somewhere
      // unverified.
    }
    // The line is handed over WITHOUT its terminator; the primitive writes
    // exactly one "\n". O_APPEND atomicity for writes ≤PIPE_BUF is unchanged —
    // the primitive opens with O_WRONLY|O_APPEND and loops until every byte of
    // the ≤2KB payload lands.
    const w = appendSinkLine({
      repoDir,
      additionalRoots: boundaryRoots,
      sinkPath: logPath,
      line,
    });
    if (!w.ok) {
      if (SUBSTRATE_FAILURES.has(w.error)) {
        const err = new Error(
          `coordination-log append failed: ${w.error} — ${w.reason}`,
        );
        // Preserve the classification for a caller that inspects rather than
        // string-matches; the underlying errno is inside `reason`.
        err.code = "ECOCSINK";
        err.sinkError = w.error;
        throw err;
      }
      return {
        ok: false,
        error: `coordination-log append refused: ${w.error} — ${w.reason}`,
      };
    }
    return { ok: true };
  }

  /**
   * SHA-256 of the entire log file's bytes. Used by callers for
   * staleness detection (optimistic-concurrency control on the
   * read-then-append path) and by the engine to detect mid-fold log
   * changes.
   *
   * Returns the sha256 of the empty string when the log file is absent
   * or zero-length — pinned to `EMPTY_HASH` so callers can compare
   * against a constant.
   *
   * @returns {Promise<string>} 64-char lowercase hex sha256
   */
  async function headHash() {
    let raw;
    try {
      raw = await fs.promises.readFile(logPath);
    } catch (err) {
      if (err && err.code === "ENOENT") return EMPTY_HASH;
      throw err;
    }
    return crypto.createHash("sha256").update(raw).digest("hex");
  }

  /**
   * Highest `seq` observed for the given `verified_id`'s per-emitter
   * chain on this transport. For the filesystem variant (shared
   * checkout, single source of truth) the peer high-water is identical
   * to the local high-water — there is no remote peer to drift from.
   * Returns null when the verified_id has no records (the engine treats
   * null as "unknown" for rule-8 partial-push gap detection per
   * coordination-log.js § peerHighWaterFor contract).
   *
   * Malformed records (mismatched verified_id type, missing seq) are
   * skipped — same disposition as readAllRecords.
   *
   * @param {string} verified_id - per-architecture §1 verified-key id
   *   (SHA-256 fingerprint of an SSH public key, e.g. "SHA256:xxx...")
   * @returns {Promise<number | null>}
   */
  async function peerHighWaterFor(verified_id) {
    if (typeof verified_id !== "string" || verified_id.length === 0) {
      return null;
    }
    const records = await readAllRecords();
    let max = null;
    for (const rec of records) {
      if (!rec || rec.verified_id !== verified_id) continue;
      if (typeof rec.seq !== "number" || !Number.isFinite(rec.seq)) continue;
      if (max === null || rec.seq > max) max = rec.seq;
    }
    return max;
  }

  return {
    readAllRecords,
    readAllRecordsDetailed,
    appendRecord,
    headHash,
    peerHighWaterFor,
    // Exposed for direct introspection during testing / debugging.
    // Not part of the Transport contract.
    _logPath: logPath,
  };
}

module.exports = {
  createFilesystemTransport,
  MAX_LINE_BYTES,
  EMPTY_HASH,
};
