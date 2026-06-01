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
const path = require("path");
const crypto = require("crypto");
const { resolveLogPath } = require("./state-io.js");

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
    let raw;
    try {
      raw = await fs.promises.readFile(logPath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return [];
      throw err;
    }
    if (raw.length === 0) return [];
    const out = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object") out.push(obj);
      } catch {
        // Malformed line: log and continue. The engine's fold rule 1
        // catches mal-shaped records that DO parse; this path covers
        // torn writes that survived a kernel crash or storage hiccup —
        // single-line skip is the right disposition since the broken
        // line cannot be recovered.
        try {
          process.stderr.write(
            `transport-filesystem: skipping malformed line ${i} in ${logPath}\n`,
          );
        } catch {
          // best-effort logging
        }
      }
    }
    return out;
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
   *   - the record is not a non-null object.
   *
   * Throws on filesystem errors (ENOSPC, EACCES, etc.) — the caller is
   * the engine's append-then-fold loop; a thrown filesystem error is the
   * right signal that the substrate failed, not that the record was
   * rejected.
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
    // Ensure the parent directory exists. resolveLogPath returns a path
    // under .claude/learning/ which may not exist on a fresh repo.
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    // O_APPEND is atomic for writes ≤PIPE_BUF; we cap at 2KB.
    await fs.promises.appendFile(logPath, line + "\n");
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
