/**
 * transport-git-ref — multi-clone-correct git-ref transport for the
 * coordination log (workspaces/multi-operator-coc, design v11 §3).
 *
 * Shard A3 (this module): implements the canonical transport used by every
 * production session. Sibling shard A2b ships the `filesystem` transport for
 * shared-checkout deployments. Both implement the Transport contract typedef'd
 * in `coordination-log.js` (readAllRecords, appendRecord, headHash,
 * peerHighWaterFor).
 *
 * --------------------------------------------------------------------------
 * Storage layout
 * --------------------------------------------------------------------------
 *
 *   refs/coc/coordination-genN   →  current-generation log ref. The ref's
 *                                   tip is a tree containing exactly one
 *                                   blob: `log.jsonl` (one record per line,
 *                                   in append order).
 *
 *   refs/coc/archive-genM        →  cold archive for each rotated generation
 *                                   (M < N). Set up by the generation-rotation
 *                                   ceremony (M6 + helper `archive-ref.js`).
 *
 * JSONL-blob choice (vs tree-per-record): one blob is simpler — appendRecord
 * is "read blob, append line, write blob, commit, push --force-with-lease".
 * The trade-off is whole-blob fetch on read; for the per-session log sizes
 * the substrate targets (≤low-thousands of records before a checkpoint),
 * this is the right shape.
 *
 * --------------------------------------------------------------------------
 * Append algorithm — fetch-merge-append-retry
 * --------------------------------------------------------------------------
 *
 *   for attempt in 1..MAX_RETRY:
 *     git fetch origin refs/coc/coordination-genN
 *     local_tip = git rev-parse refs/coc/coordination-genN  (or null)
 *     prior_jsonl = git cat-file -p local_tip:log.jsonl     (or empty)
 *     new_jsonl = prior_jsonl + canonicalize(record) + "\n"
 *     new_blob = git hash-object -w --stdin << new_jsonl
 *     new_tree = git mktree << "100644 blob <new_blob>\tlog.jsonl"
 *     new_commit = git commit-tree <new_tree> [-p <local_tip>] -m "<msg>"
 *     try push: git push --force-with-lease=refs/coc/coordination-genN:<local_tip>
 *       origin <new_commit>:refs/coc/coordination-genN
 *       success → return ok
 *       lease-failure → next iteration (concurrent push raced)
 *
 * --force-with-lease ensures the push fails if the remote ref has moved
 * since `local_tip` was captured, even though we're force-pushing. This is
 * the optimistic-concurrency primitive that lets multiple clones append
 * without a central coordinator.
 *
 * --------------------------------------------------------------------------
 * refs/coc/** server-side protection: N/A on github.com (CONF-2 REFUTED — GH #367)
 * --------------------------------------------------------------------------
 *
 * The journal/0125 CONF-2 "provision a refs/coc/** ruleset" verdict was
 * REFUTED 2026-06-07 (journal/0233): github.com rulesets reject a custom-ref
 * target pattern. Live: POST repos/{owner}/{repo}/rulesets with
 * conditions.ref_name.include: ["refs/coc/**"] -> 422 "Invalid target
 * patterns: 'refs/coc/**'". github.com rulesets + branch protection target
 * refs/heads/** and refs/tags/** ONLY; there is NO server-side mechanism to
 * restrict creation/deletion of refs/coc/**. The F48 "seed-first" precondition
 * was a misdiagnosis (the 422 is "Invalid target patterns", not empty-
 * namespace) and is withdrawn. Do NOT attempt the POST — it 422s.
 *
 * The equivocation-parity defense is therefore CLIENT-SIDE (the PRIMARY
 * defense, not defense-in-depth): the F51 archive-tip-pin verification —
 * verifyArchiveTipPin (archive-ref.js) invoked from fold-rule-9b.js against
 * the observed refs/coc/archive-genN tip read through readArchiveRefTip below.
 * A GitHub ENTERPRISE (GHES) pre-receive hook MAY add server-side custom-ref
 * protection where available — an Enterprise-only second layer, never a
 * github.com mandate. See multi-operator-coordination.md MUST-5 + journal/0233.
 *
 * --------------------------------------------------------------------------
 * Style: CommonJS, zero-dep beyond child_process + crypto. No production
 * remote contact at module load time — every git operation is parametrized
 * by repoDir + remoteName so tests can use a local `git init --bare` remote
 * in `mktemp -d`.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const DEFAULT_MAX_RETRY = 5;
const DEFAULT_REMOTE = "origin";
const LOG_BLOB_FILENAME = "log.jsonl";

/**
 * @typedef {Object} GitRefTransportOpts
 * @property {string} repoDir
 *   Path to the local git checkout (a working tree, NOT a bare repo). The
 *   transport runs `git -C <repoDir>` against this for every operation.
 * @property {string} [refName]
 *   Full ref name to use as the coordination log. Defaults to
 *   `refs/coc/coordination-gen0`. Generation rotation ceremonies SHOULD
 *   construct a new transport against `refs/coc/coordination-gen<N+1>` AND
 *   call `archive-ref.js::pinArchiveTip` to fold the old gen into the
 *   compaction-checkpoint that triggered the rotation.
 * @property {string} [remote]
 *   Git remote name (defaults to `origin`). Tests may use a per-test
 *   local bare repo as the remote.
 * @property {number} [maxRetry]
 *   Number of fetch-merge-append-retry iterations before raising. Default 5.
 */

/**
 * Construct a transport handle bound to a specific repoDir + ref name.
 *
 * @param {GitRefTransportOpts} opts
 * @returns {object} transport with appendRecordSync, readAllRecordsSync,
 *   headHashSync, peerHighWaterForSync. The "-Sync" suffix on each method
 *   advertises that these are blocking child_process operations (the
 *   Transport typedef permits promises; we expose sync APIs here because
 *   the consumers — hooks + ceremonies — are themselves synchronous).
 */
function createGitRefTransport(opts) {
  if (!opts || typeof opts !== "object") {
    throw new Error("createGitRefTransport: opts required");
  }
  if (typeof opts.repoDir !== "string" || !opts.repoDir) {
    throw new Error("createGitRefTransport: opts.repoDir required");
  }
  const repoDir = opts.repoDir;
  const refName = opts.refName || "refs/coc/coordination-gen0";
  // M3 MED-3 / F-6: refName allowlist. The coordination-log substrate
  // owns `refs/coc/**`; using this transport against any other ref
  // namespace (e.g. `refs/heads/main`) would let the agent forge or
  // overwrite arbitrary git refs that other tooling protects via
  // server-side rulesets (CONF-2). Validate at constructor time so
  // misuse fails loud rather than silently corrupting state.
  if (!refName.startsWith("refs/coc/")) {
    throw new Error(
      `transport-git-ref: refName must start with refs/coc/ (got: ${refName})`,
    );
  }
  const remote = opts.remote || DEFAULT_REMOTE;
  const maxRetry =
    typeof opts.maxRetry === "number" && opts.maxRetry > 0
      ? opts.maxRetry
      : DEFAULT_MAX_RETRY;

  if (!fs.existsSync(repoDir)) {
    throw new Error(
      `createGitRefTransport: repoDir does not exist: ${repoDir}`,
    );
  }

  /**
   * Run `git -C <repoDir> <args...>`. Returns stdout as utf8; throws on
   * non-zero exit. Stderr is captured and included in the thrown error.
   */
  function git(args, gitOpts) {
    const o = gitOpts || {};
    try {
      return execFileSync("git", ["-C", repoDir, ...args], {
        encoding: "utf8",
        stdio: o.stdio || ["pipe", "pipe", "pipe"],
        input: o.input,
      });
    } catch (err) {
      // Surface stderr for diagnostic clarity.
      const stderr = err.stderr ? err.stderr.toString() : "";
      const stdout = err.stdout ? err.stdout.toString() : "";
      const message = `git ${args.join(" ")} failed (status ${err.status}): ${stderr || stdout || err.message}`;
      const e = new Error(message);
      e.code = err.status;
      e.stderr = stderr;
      e.stdout = stdout;
      throw e;
    }
  }

  /**
   * Try `git` and return null on failure (instead of throwing). Used for
   * "ref might not exist yet" cases.
   */
  function gitOrNull(args) {
    try {
      return git(args, { stdio: ["pipe", "pipe", "pipe"] }).trim();
    } catch {
      return null;
    }
  }

  /**
   * Fetch the current state of `refName` from the remote. Best-effort —
   * if the remote does not yet have the ref, fetch is a no-op.
   */
  function _fetchRefFromRemote() {
    try {
      git(["fetch", remote, "--quiet", `+${refName}:${refName}`], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // Common failure: the ref doesn't exist on the remote yet. That is
      // the legitimate empty-log state; we swallow and let the caller
      // observe `headHashSync() === null`.
      if (
        /couldn't find remote ref|does not appear to be a git repository|reference is not a tree/i.test(
          err.stderr || "",
        )
      ) {
        return;
      }
      // Any other error is fatal — surface it.
      throw err;
    }
  }

  /**
   * Get the current ref tip SHA (40-char hex). Returns null if the ref
   * does not exist locally.
   */
  function headHashSync() {
    const sha = gitOrNull(["rev-parse", "--verify", "--quiet", refName]);
    if (!sha) return null;
    if (!/^[0-9a-f]{40}$/.test(sha)) return null;
    return sha;
  }

  /**
   * Read the JSONL blob at `<ref>:log.jsonl`. Returns "" if the ref does
   * not exist or carries no log blob (fresh log).
   */
  function _readLogBlobAt(refOrSha) {
    const blob = gitOrNull([
      "cat-file",
      "-p",
      `${refOrSha}:${LOG_BLOB_FILENAME}`,
    ]);
    if (blob === null) return "";
    return blob;
  }

  /**
   * Parse the JSONL blob into an array of records. Empty lines are skipped.
   * Malformed lines surface as Error to the caller (the engine cannot
   * meaningfully fold over corrupted JSON; loud failure is correct).
   */
  function _parseJsonl(blob) {
    if (!blob) return [];
    const records = [];
    const lines = blob.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch (err) {
        throw new Error(
          `transport-git-ref: malformed JSON at log line ${i + 1}: ${err && err.message ? err.message : String(err)}`,
        );
      }
      records.push(rec);
    }
    return records;
  }

  /**
   * Read all records from the current ref tip. Fetch-first so multi-clone
   * concurrent updates from other clones are reflected. Order preserved
   * from the JSONL blob (which is the append order).
   *
   * @returns {Array<object>} records (may be empty)
   */
  function readAllRecordsSync() {
    _fetchRefFromRemote();
    const tip = headHashSync();
    if (!tip) return [];
    const blob = _readLogBlobAt(tip);
    return _parseJsonl(blob);
  }

  /**
   * Compute the highest seq observed for the given verified_id, walking
   * the current ref's records. Returns null when the verified_id is not
   * present in the log.
   *
   * Per architecture R8-S-04 + R10-S-01: this is what fold-rule-9d AND
   * fold-rule-10's "settled" predicate consume as "peer-observed
   * high-water for this emitter's per-emitter chain". A would-be forger
   * that withholds X's heartbeats from its own log has not pushed X's
   * records and so cannot fetch back X's high-water.
   */
  function peerHighWaterForSync(verifiedId) {
    if (typeof verifiedId !== "string" || !verifiedId) return null;
    const records = readAllRecordsSync();
    let high = null;
    for (const r of records) {
      if (r && r.verified_id === verifiedId && typeof r.seq === "number") {
        if (high === null || r.seq > high) high = r.seq;
      }
    }
    return high;
  }

  /**
   * Serialize a record to a JSONL line. We do NOT use canonicalSerialize
   * for the transport-layer blob because (a) ordering inside the blob is
   * "append order, by line"; (b) sig+content are already canonical from
   * the sign step and we just preserve the record verbatim. We DO write
   * one record per line so a reader can split on "\n" without needing
   * a JSON parser to find record boundaries.
   *
   * Records MUST NOT carry literal newlines in any value — this is enforced
   * structurally because the canonical sign/verify path uses JSON.stringify
   * which already escapes newlines as `\n`. We add one assertion as
   * defense in depth.
   */
  function _serializeRecord(record) {
    const line = JSON.stringify(record);
    if (line.includes("\n")) {
      throw new Error(
        "transport-git-ref: serialized record contains literal newline (unexpected)",
      );
    }
    return line;
  }

  /**
   * Build a single-file tree containing the new JSONL blob. Returns the
   * new tree SHA.
   */
  function _writeBlobAndTree(jsonl) {
    // Write the blob via stdin.
    const blobSha = git(["hash-object", "-w", "--stdin"], {
      input: jsonl,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(blobSha)) {
      throw new Error(
        `transport-git-ref: hash-object returned non-SHA: ${blobSha}`,
      );
    }
    // Build a tree with exactly one entry: log.jsonl → blobSha.
    // Format expected by `git mktree`: "<mode> <type> <sha>\t<name>\n".
    const treeInput = `100644 blob ${blobSha}\t${LOG_BLOB_FILENAME}\n`;
    const treeSha = git(["mktree"], {
      input: treeInput,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(treeSha)) {
      throw new Error(`transport-git-ref: mktree returned non-SHA: ${treeSha}`);
    }
    return treeSha;
  }

  /**
   * Commit the given tree as the next ref tip. Pass `parentSha` if
   * extending an existing log; pass null for a brand-new ref (initial
   * commit).
   *
   * We use `GIT_AUTHOR_*` + `GIT_COMMITTER_*` env vars set to a stable
   * synthetic identity so test runs don't depend on the user's git config.
   */
  function _commitTree(treeSha, parentSha, message) {
    const env = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: "coc-coordination-log",
      GIT_AUTHOR_EMAIL: "coc@coordination.log.invalid",
      GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "coc-coordination-log",
      GIT_COMMITTER_EMAIL: "coc@coordination.log.invalid",
      GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
    });
    const args = ["commit-tree", treeSha];
    if (parentSha) args.push("-p", parentSha);
    args.push("-m", message);
    try {
      const out = execFileSync("git", ["-C", repoDir, ...args], {
        encoding: "utf8",
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const sha = out.trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error(
          `transport-git-ref: commit-tree returned non-SHA: ${sha}`,
        );
      }
      return sha;
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString() : "";
      throw new Error(
        `transport-git-ref: commit-tree failed: ${stderr || err.message}`,
      );
    }
  }

  /**
   * Update the local ref to point at the new commit, and push to the
   * remote with --force-with-lease anchored on the prior tip. Returns
   * {ok: true} on success, {ok: false, reason} on lease failure (caller
   * should retry).
   */
  function _updateLocalAndPush(newCommitSha, priorTipSha) {
    // Update the local ref first. Without this, the local view diverges
    // from the remote and subsequent fetches confuse fast-forward logic.
    const updateRefArgs = ["update-ref", refName, newCommitSha];
    if (priorTipSha) updateRefArgs.push(priorTipSha);
    try {
      git(updateRefArgs, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      // update-ref failure with a CAS arg means our local copy was already
      // updated by something else mid-iteration. Retry.
      return { ok: false, reason: `update-ref lost CAS: ${err.message}` };
    }

    // Push to the remote. --force-with-lease guarantees we only push if
    // the remote's ref still matches our prior tip — even though we're
    // overwriting the ref. This is the optimistic-concurrency primitive
    // that lets multiple clones append safely.
    const leaseSpec = priorTipSha ? `${refName}:${priorTipSha}` : refName; // no prior tip = expect-empty form
    const pushArgs = [
      "push",
      "--quiet",
      `--force-with-lease=${leaseSpec}`,
      remote,
      `${newCommitSha}:${refName}`,
    ];
    try {
      git(pushArgs, { stdio: ["pipe", "pipe", "pipe"] });
      return { ok: true };
    } catch (err) {
      // Lease failure or non-fast-forward — retry path. Roll back the
      // local ref so the next iteration's fetch sees the remote's view.
      const reason = err.stderr || err.message || "push failed";
      // Reset local ref to prior tip so the next fetch re-syncs cleanly.
      if (priorTipSha) {
        try {
          git(["update-ref", refName, priorTipSha], {
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          // If even rollback fails, leave it — next iteration fetches.
        }
      } else {
        try {
          git(["update-ref", "-d", refName], {
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          /* best-effort */
        }
      }
      return { ok: false, reason };
    }
  }

  /**
   * Append a record to the log. Implements fetch-merge-append-retry per
   * the module docstring. Returns {ok: true} on success, {ok: false,
   * reason} after maxRetry exhaustion.
   *
   * @param {object} record  Signed record (must already carry .sig).
   *   The transport does NOT verify signatures — that is the engine's
   *   responsibility at fold time. The transport is a dumb pipe.
   */
  function appendRecordSync(record) {
    if (!record || typeof record !== "object") {
      return { ok: false, error: "record must be an object" };
    }
    let lastReason = "no attempts";
    for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
      _fetchRefFromRemote();
      const priorTip = headHashSync();
      const priorJsonl = priorTip ? _readLogBlobAt(priorTip) : "";
      const newLine = _serializeRecord(record);
      const newJsonl =
        priorJsonl && !priorJsonl.endsWith("\n")
          ? `${priorJsonl}\n${newLine}\n`
          : `${priorJsonl}${newLine}\n`;
      const treeSha = _writeBlobAndTree(newJsonl);
      const commitSha = _commitTree(
        treeSha,
        priorTip,
        `coc(${refName}): append ${record.type || "?"} ${record.verified_id || "?"}:${record.seq != null ? record.seq : "?"}`,
      );
      const pushResult = _updateLocalAndPush(commitSha, priorTip);
      if (pushResult.ok) {
        return { ok: true, tip: commitSha };
      }
      lastReason = pushResult.reason;
      // Loop: re-fetch, re-build, re-push.
    }
    return {
      ok: false,
      error: "append-record retry exhausted",
      reason: `after ${maxRetry} attempts: ${lastReason}`,
    };
  }

  return {
    // A2a's Transport typedef advertises Promise-returning methods. Our
    // implementation is synchronous (child_process.execFileSync). We
    // expose `-Sync` named methods AND Promise-wrapper aliases so callers
    // on either side of the typedef contract work.
    appendRecordSync,
    readAllRecordsSync,
    headHashSync,
    peerHighWaterForSync,
    // Promise-returning aliases matching the engine's typedef shape.
    appendRecord: (rec) => Promise.resolve(appendRecordSync(rec)),
    readAllRecords: () => Promise.resolve(readAllRecordsSync()),
    headHash: () => Promise.resolve(headHashSync()),
    peerHighWaterFor: (id) => Promise.resolve(peerHighWaterForSync(id)),
    // Diagnostics — exposed for testing/observability, not part of the
    // engine's Transport contract.
    _internal: {
      refName,
      remote,
      repoDir,
      maxRetry,
    },
  };
}

/**
 * Read the live tip SHA of an archive ref (refs/coc/archive-genN) from
 * the local repository. F51: this is the live-API primitive that backs
 * `archive-ref.js::verifyArchiveTipPin` invocation at fold time —
 * `verify-resource-existence.md` MUST-2 shape (live read against the
 * same surface the failing operation targets, NOT a documentation grep).
 *
 * Implementation: `git for-each-ref --format=%(objectname) <refName>` via
 * `execFileSync` arg-array form per `rules/security.md` § "No eval()".
 * No shell expansion; refName is passed directly to git as an argument.
 *
 * Returns `{ ok: true, tipSha }` when the ref exists and resolves to a
 * 40-char SHA; `{ ok: false, reason }` otherwise. NEVER throws — typed
 * error per `rules/zero-tolerance.md` Rule 3 (no silent fallbacks; typed
 * errors only). Callers fold the reason into a halt-and-report advisory
 * per `rules/observability.md` Rule 5.
 *
 * @param {string} repoDir   absolute path to the local git checkout
 * @param {string} refName   full ref name (e.g. "refs/coc/archive-gen0").
 *   MUST start with "refs/coc/" — the substrate's archive-ref namespace.
 *   Other ref namespaces are protected by sibling rulesets and MUST NOT
 *   be readable through this helper (refName-allowlist mirror of
 *   `createGitRefTransport` MUST-prefix check above).
 * @returns {{ok: true, tipSha: string} | {ok: false, reason: string}}
 */
function readArchiveRefTip(repoDir, refName) {
  if (typeof repoDir !== "string" || !repoDir) {
    return { ok: false, reason: "readArchiveRefTip: repoDir required" };
  }
  if (typeof refName !== "string" || !refName) {
    return { ok: false, reason: "readArchiveRefTip: refName required" };
  }
  // refName allowlist: archive refs ONLY. The transport's constructor
  // enforces the same predicate for coordination-log refs; mirroring it
  // here keeps the helper from being repurposed to read arbitrary refs
  // (which other tooling protects via server-side rulesets per CONF-2).
  if (!refName.startsWith("refs/coc/")) {
    return {
      ok: false,
      reason: `readArchiveRefTip: refName must start with refs/coc/ (got: ${refName})`,
    };
  }
  if (!fs.existsSync(repoDir)) {
    return {
      ok: false,
      reason: `readArchiveRefTip: repoDir does not exist: ${repoDir}`,
    };
  }
  let out;
  try {
    out = execFileSync(
      "git",
      ["-C", repoDir, "for-each-ref", "--format=%(objectname)", refName],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (err) {
    const stderr = err && err.stderr ? err.stderr.toString() : "";
    return {
      ok: false,
      reason: `readArchiveRefTip: git for-each-ref failed: ${stderr || err.message}`,
    };
  }
  const tipSha = (out || "").trim();
  // for-each-ref emits empty output (NOT an error) when the ref is absent.
  // That is the canonical "ref does not exist" signal — fail-loud per
  // `verify-resource-existence.md` MUST-3 (default disposition on
  // existence-check empty is surface-the-reason, never silent-default).
  if (!tipSha) {
    return {
      ok: false,
      reason: `readArchiveRefTip: archive ref '${refName}' not found (git for-each-ref returned empty)`,
    };
  }
  if (!/^[0-9a-f]{40}$/.test(tipSha)) {
    return {
      ok: false,
      reason: `readArchiveRefTip: unexpected tip SHA shape for '${refName}': ${tipSha}`,
    };
  }
  return { ok: true, tipSha };
}

module.exports = {
  createGitRefTransport,
  readArchiveRefTip,
  // Constants exposed for downstream use (archive-ref.js uses
  // LOG_BLOB_FILENAME when verifying the cold archive's tip).
  LOG_BLOB_FILENAME,
  DEFAULT_REMOTE,
};
