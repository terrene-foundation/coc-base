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
// GENMAT-1 Shard 1: the ONE source of the canonical log ref name. Importing
// the default here (instead of re-declaring the literal) guarantees the
// transport default, the guard remediation text, and the materializer resolve
// the SAME name — the single-source invariant that closes the redteam F1
// silent-no-op class.
const { DEFAULT_LOG_REF_NAME } = require("./log-ref-name.js");
const { MAX_RECORD_UTF8_BYTES, parseCoordinationLog, assertRecordSize } = require("./fold-record-limits.js");
const { resolveGitBinary, gitEnv, gitNetEnv } = require("./git-subprocess-env.js");

const DEFAULT_MAX_RETRY = 5;
const DEFAULT_REMOTE = "origin";
const LOG_BLOB_FILENAME = "log.jsonl";
const MAX_GIT_CAPTURE_BYTES = 4 * MAX_RECORD_UTF8_BYTES + 4;

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
  const refName = opts.refName || DEFAULT_LOG_REF_NAME;
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
  const boundPeerUrl = opts.boundPeerUrl;
  const canonicalPeerUrl = boundPeerUrl === undefined ? undefined : require("./signed-peer-binding.js").canonicalPeerUrl;
  if (boundPeerUrl !== undefined && !canonicalPeerUrl(boundPeerUrl)) {
    throw new TypeError("transport-git-ref: invalid signed peer endpoint");
  }
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
      // loom#1471 shard 2. This runner reads and writes the coordination-log
      // record ref. Passing no `env:` handed the child the ambient environment,
      // and `GIT_DIR` outranks repository discovery, so `-C` did NOT pin which
      // repository answered — an attacker-supplied GIT_DIR made the transport
      // read (and fold) the ATTACKER's record log. Measured at readArchiveRefTip
      // (test S2-T2), which shares this defect.
      const gitBin = resolveGitBinary();
      if (!gitBin) {
        throw new Error(
          "transport-git-ref: no git binary resolved; refusing to run against an " +
            "indeterminate repository (security.md § Enforcement-Surface Parity — " +
            "unresolvable git ranks TIGHTEST, never a clean negative)",
        );
      }
      // loom#1471 shard 6. `o.net` opts a SINGLE call into the network profile.
      // This runner is shared by `fetch`/`push` (remote) and `rev-parse`,
      // `mktree`, `update-ref` (local), so the profile is chosen PER CALL rather
      // than per file — the same least-privilege split `template-resolver` uses.
      //
      // WHY THE NET PROFILE IS NEEDED HERE AT ALL. `gitEnv()` omits proxy, TLS
      // anchors and the agent socket by design. That is right for a local query
      // and wrong for a remote one: on a corporate-proxy or TLS-intercepting
      // host the coordination-log fetch and push hard-fail, which takes out the
      // multi-operator substrate for exactly the enterprise and client-fork
      // deployments this repo targets. The argument is the one this sweep
      // already made for `template-resolver` — a blanket `gitEnv()` on a network
      // call does not harden it, it breaks it.
      //
      // WHY THIS IS AVAILABILITY AND NOT A SILENT-STATE BUG, unlike
      // `template-resolver`: the fetch handler used to swallow three stderr
      // patterns and treat everything else as fatal, and this note claimed that
      // narrow swallow-list was what kept it fail-closed. THAT CLAIM WAS WRONG,
      // and the round-2 security review measured the consequence: TWO of the
      // three (`does not appear to be a git repository`, `reference is not a
      // tree`) are COULD-NOT-ANSWER cases, and swallowing them let a peer that
      // could not be reached be read as an empty log — with a stale local ref
      // left in place from an earlier fetch, the settlement predicate then saw a
      // matching high-water. As of 2026-10-09 `_fetchRefFromRemote` returns a
      // TYPED answer: `refreshed` or `absent` (the peer ANSWERED, it has no such
      // ref), and every other failure — including those two patterns and proxy /
      // TLS failures — THROWS. A fetch failure is now an absent instrument at
      // every consumer, never an empty log.
      return execFileSync(gitBin, ["-C", repoDir, ...args], {
        encoding: "utf8",
        stdio: o.stdio || ["pipe", "pipe", "pipe"],
        input: o.input,
        env: o.net ? gitNetEnv() : gitEnv(),
        maxBuffer: MAX_GIT_CAPTURE_BYTES,
      });
    } catch (err) {
      if (err && err.code === "ENOBUFS") {
        const e = new Error(
          `transport-git-ref: git output exceeds ${MAX_GIT_CAPTURE_BYTES} UTF-8 bytes; coordination log read is indeterminate`,
        );
        e.code = "ECOCRECORDSIZE";
        throw e;
      }
      // Surface stderr for diagnostic clarity.
      const stderr = err.stderr ? err.stderr.toString() : "";
      // The module name leads the message: every failure this runner raises is
      // now a COULD-NOT-ANSWER that callers must not mistake for an empty
      // answer, and naming the module makes that origin visible at the call
      // site (and in any consumer's `assert.throws(..., /transport-git-ref/)`).
      const message = `transport-git-ref: git ${args.join(" ")} failed (status ${err.status}): ${stderr || err.message}`;
      const e = new Error(message);
      e.code = err.status;
      e.stderr = stderr;
      throw e;
    }
  }

  /*
   * loom#1471 shard 7 — ABSENT AND INDETERMINATE ARE NOT THE SAME ANSWER.
   *
   * The predecessor of this section was `gitOrNull`, a bare
   * `catch { return null }`. It collapsed two opposite outcomes into one value:
   *
   *   ABSENT        git ANSWERED, and the thing asked about is not there. A
   *                 fresh log has no ref; a fresh ref has no log blob. That is
   *                 a legitimate empty state.
   *   INDETERMINATE git could NOT answer: no binary resolved (the deliberate
   *                 fail-closed throw in the runner above, whose own text says
   *                 unresolvable git "ranks TIGHTEST, never a clean negative"),
   *                 a `safe.directory` refusal, a corrupt object database, a
   *                 killed process.
   *
   * The dubious-ownership case got MORE reachable in this very sweep, not less:
   * `gitEnv()` sets `GIT_CONFIG_GLOBAL=/dev/null` and therefore DISCARDS
   * `safe.directory`, so a differently-owned checkout — container bind-mount,
   * CI runner, shared clone — makes git exit 128 where it used to succeed.
   *
   * Why that mattered here specifically: this is the TRUST-ROOT record chain.
   * `null` reached `_readLogBlobAt`, which returned `""`, which `_parseJsonl`
   * turned into ZERO RECORDS — the strongest possible claim about the log,
   * asserted on the evidence that git failed. So the classifier below is a
   * NARROW POSITIVE ALLOWLIST and everything outside it PROPAGATES: the shape
   * `_fetchRefFromRemote` already uses, and the contract `sibling-porcelain.js`
   * states in prose for its `ok:false` — "could not answer" is distinct from
   * "answered: nothing", and callers MUST NOT read the former as the latter
   * (`rules/zero-tolerance.md` Rule 3).
   *
   * `gitOrNull` is REMOVED rather than fixed in place, for the reason the F7
   * sibling gave for `requireMainCheckout`: leaving the permissive accessor
   * callable leaves the defect re-writable by the next caller.
   *
   * SIGNATURES MEASURED, NOT INFERRED (git 2.x, this host):
   *
   *   rev-parse --verify --quiet <absent ref>   status 1    stderr EMPTY
   *   rev-parse --verify --quiet, non-repo      status 128  "fatal: not a git repository…"
   *   cat-file -p <tip>:log.jsonl, no entry     status 128  "fatal: path 'log.jsonl' does not exist in '<rev>'"
   *   cat-file -p <tip>:log.jsonl, blob DELETED status 128  "fatal: Not a valid object name <rev>:log.jsonl"
   *
   * Note the last two rows. A missing TREE ENTRY and a missing OBJECT both exit
   * 128 and differ only in wording — which is exactly why blob absence is
   * matched by the one message that names a path, and never by the exit code.
   */

  /** git answered, and the thing asked about does not exist. */
  const ABSENT = Symbol("transport-git-ref:absent");

  /**
   * Run `git` and return ABSENT when — and only when — `isAbsent` recognises
   * the failure as a genuine "not there". Every other failure THROWS, so an
   * indeterminate can never be mistaken for an empty answer.
   */
  function _gitOrAbsent(args, isAbsent) {
    try {
      return git(args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      if (isAbsent(err)) return ABSENT;
      throw err;
    }
  }

  /**
   * `rev-parse --verify --quiet` SUPPRESSES its message for a ref that simply
   * is not there, so exit 1 with nothing on stderr is git's own signal for
   * absence. Exit 128 (not a repository, dubious ownership, corrupt refs) — and
   * the runner's own no-binary throw, which carries no `status` at all — are a
   * different answer and do not qualify.
   */
  function _isRefAbsent(err) {
    return Boolean(err) && err.code === 1 && !String(err.stderr || "").trim();
  }

  /**
   * Only "the tree carries no such path" is absence. A missing or corrupt
   * OBJECT exits 128 the same way and is INDETERMINATE.
   */
  function _isLogBlobAbsent(err) {
    return /path '[^']*' does not exist in /i.test((err && err.stderr) || "");
  }

  /**
   * Fetch the current state of `refName` from the remote, returning a TYPED
   * answer so a caller can never mistake "could not ask" for "asked, nothing".
   *
   *   {status: "refreshed"} — the peer answered and the local ref now holds its
   *                           current tip (which may be a valid empty log).
   *   {status: "absent"}    — the peer ANSWERED and has no such ref. This is
   *                           the legitimate empty-log state, and the answer is
   *                           DEFINITIVE: git does not delete a stale LOCAL
   *                           copy when the remote ref is missing, so callers
   *                           MUST NOT fall back to the local ref — that view
   *                           is stale by construction, not the peer's answer.
   *
   * EVERYTHING ELSE THROWS, and that is the point of this function:
   *
   *   An unreachable remote (`does not appear to be a git repository`), a ref
   *   that points at something unreadable (`reference is not a tree`), an auth
   *   failure, a timeout — all of these mean THE PEER COULD NOT ANSWER.
   *   MEASURED (2026-10-09, round-2 security review): they used to be swallowed
   *   together with the legitimate empty state, so a peer that could not be
   *   reached left the previous fetch's LOCAL ref in place and the transport
   *   reported that stale view as the peer's high-water — which made an
   *   UNANSWERABLE peer satisfy R10-S-01 and an unsettled owner-departure
   *   revocation read as SETTLED (the hook ALLOWED a removal). A failed fetch is
   *   not an empty log; it is an absent instrument (`instrument-discipline.md`
   *   MUST-5: could-not-answer is not answered-nothing, and the two must stay
   *   discriminable through every consumer).
   */
  function assertBoundPeerSync() {
    if (boundPeerUrl === undefined) throw new Error("transport-git-ref: signed peer endpoint missing");
    let configured;
    try { configured = git(["config", "--get-all", `remote.${remote}.url`]); }
    catch { throw new Error("transport-git-ref: configured peer binding missing or unreadable"); }
    const urls = configured.trim().split("\n").filter(Boolean);
    if (urls.length !== 1 || canonicalPeerUrl(urls[0]) !== canonicalPeerUrl(boundPeerUrl)) {
      throw new Error("transport-git-ref: configured peer mismatches signed endpoint");
    }
    let routes;
    try {
      routes = git(["config", "--includes", "--get-regexp",
        "(^[uU][rR][lL]\\..*\\.([iI][nN][sS][tT][eE][aA][dD][oO][fF]|[pP][uU][sS][hH][iI][nN][sS][tT][eE][aA][dD][oO][fF])$|^[iI][nN][cC][lL][uU][dD][eE].*\\.[pP][aA][tT][hH]$|^[hH][tT][tT][pP].*\\.[sS][sS][lL][vV][eE][rR][iI][fF][yY]$)"]);
    } catch (error) {
      if (error.code !== 1) throw error;
      routes = "";
    }
    if (routes.trim()) throw new Error("transport-git-ref: mutable peer URL rewrite/include/TLS routing is refused");
    return true;
  }

  function resolveBoundLogRefSync() {
    assertBoundPeerSync();
    const output = git(["-c", "http.followRedirects=false", "ls-remote", boundPeerUrl, "refs/coc/coordination-gen*"], { net: true });
    const { parseHighestLogGen, logRefNameForGen } = require("./log-ref-name.js");
    const generation = parseHighestLogGen(output);
    return { refName: generation === null ? DEFAULT_LOG_REF_NAME : logRefNameForGen(generation),
      gen: generation === null ? 0 : generation, source: generation === null ? "default-no-log-ref" : "ls-remote" };
  }


  function _fetchRefFromRemote() {
    if (boundPeerUrl !== undefined) assertBoundPeerSync();
    // THREE DISPOSITIONS, and the FIRST one is why this probe exists: `git
    // fetch <remote>` reports "does not appear to be a git repository" BOTH when
    // no such remote is CONFIGURED and when a configured remote's URL is
    // unreachable, so the fetch error alone cannot tell "there is no peer" from
    // "the peer did not answer". The remote's configuration can.
    if (!_remoteConfigured()) return { status: "no-remote" };
    try {
      // NETWORK call — see the `o.net` note in the runner above.
      git([...(boundPeerUrl ? ["-c", "http.followRedirects=false"] : []), "fetch", boundPeerUrl || remote, "--quiet", `+${refName}:${refName}`], {
        stdio: ["pipe", "pipe", "pipe"],
        net: true,
      });
      return { status: "refreshed" };
    } catch (err) {
      const stderr = String((err && err.stderr) || "");
      // The peer answered: it has no such ref. Definitive, and local-stale-free
      // by the caller's construction (see readAllRecordsSync).
      if (/couldn't find remote ref/i.test(stderr)) {
        return { status: "absent" };
      }
      // Could not answer. Surface it — never collapse it into "absent".
      throw err;
    }
  }

  /**
   * Is a coordination PEER configured for this checkout at all?
   *
   * `git config --get remote.<remote>.url` is the structural question, and it is
   * asked SEPARATELY from the fetch because the fetch's failure text cannot
   * distinguish "no such remote" from "that remote is unreachable". Exit 1 (key
   * unset) is git ANSWERING "not configured"; anything else — a non-repo, an
   * unreadable config — answers false as well, and false only routes a caller
   * back to the LOCAL ref, where the very next read has to answer for itself
   * (headHashSync throws on a repo git cannot open).
   */
  function _remoteConfigured() {
    if (boundPeerUrl !== undefined) return true;
    try {
      const url = git(["config", "--get", `remote.${remote}.url`], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      return typeof url === "string" && url.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get the current ref tip SHA (40-char hex). Returns null ONLY when git
   * answered that the ref does not exist locally — so a null return means
   * "no log yet", and nothing else. THROWS when git could not answer.
   */
  function headHashSync() {
    const answer = _gitOrAbsent(
      ["rev-parse", "--verify", "--quiet", refName],
      _isRefAbsent,
    );
    if (answer === ABSENT) return null;
    const sha = answer.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      // `--verify` exited 0, so git believes it answered — but the answer is
      // not a SHA. A broken answer is not an absent ref; the prior code
      // returned null here, which is the same silent-empty by another route.
      throw new Error(
        `transport-git-ref: rev-parse returned a non-SHA for '${refName}' ` +
          `(INDETERMINATE, never reported as an absent ref): ${JSON.stringify(sha)}`,
      );
    }
    return sha;
  }

  /**
   * Read the JSONL blob at `<ref>:log.jsonl`. Returns "" ONLY when git answered
   * that the tree carries no such path (a fresh log). THROWS when git could not
   * answer — a missing or corrupt object, an unresolvable binary, a repository
   * git refuses to open. `""` feeds `_parseJsonl` and yields ZERO records, so
   * returning it on an indeterminate would assert the trust-root chain is
   * EMPTY on the strength of a failed subprocess.
   */
  function _readLogBlobAt(refOrSha) {
    const blob = _gitOrAbsent(
      ["cat-file", "-p", `${refOrSha}:${LOG_BLOB_FILENAME}`],
      _isLogBlobAbsent,
    );
    if (blob === ABSENT) return "";
    return blob;
  }

  /**
   * Parse the JSONL blob into an array of records. Empty lines are skipped.
   * Malformed lines surface as Error to the caller (the engine cannot
   * meaningfully fold over corrupted JSON; loud failure is correct).
   */
  function _parseJsonl(blob) {
    try {
      return parseCoordinationLog(blob, {
        malformed: "throw", objectRecordsOnly: false, maxRecords: null,
      }).records;
    } catch (error) {
      if (error && error.code === "ECOCLOGJSON") {
        throw new Error("transport-git-ref: " + error.message);
      }
      throw error;
    }
  }

  /**
   * Read all records from the current ref tip. Fetch-first so multi-clone
   * concurrent updates from other clones are reflected. Order preserved
   * from the JSONL blob (which is the append order).
   *
   * An empty array here is a POSITIVE statement — git answered, and the log
   * holds no records. When git could not answer, this THROWS rather than
   * returning `[]`; the caller MUST surface that as indeterminate and MUST NOT
   * fold an empty record set (see the ABSENT/INDETERMINATE note above).
   *
   * @returns {Array<object>} records (may be empty)
   * @throws {Error} when the ref or blob could not be read (INDETERMINATE)
   */
  function readAllRecordsSync() {
    const fetched = _fetchRefFromRemote();
    // ANSWERED-ABSENT SHORT-CIRCUITS BEFORE ANY LOCAL READ. A stale local ref
    // left by an earlier fetch is not the peer's answer, and reading it is how a
    // peer that had lost the ref was measured settling a revocation (round-2
    // security review). "The peer has no such ref" is a definitive empty log.
    if (fetched.status === "absent") return [];
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
   *
   * `null` therefore means "answered: this verified_id is not in the log".
   * An unreadable log THROWS (via readAllRecordsSync) instead of collapsing
   * into that same `null`, which `fold-rule-10`'s settlement predicate and
   * `recovery-fallback` both read as a definite absence.
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
   * The PEER-OBSERVED high-water — the same question as
   * `peerHighWaterForSync`, asked in the form R10-S-01 actually requires, and
   * the ONE a settlement decision may consume.
   *
   * WHY A SECOND ACCESSOR. `peerHighWaterForSync` deliberately falls back to the
   * LOCAL ref when no peer is configured, because that is the correct reading
   * for a local-only checkout materializing its own log. Settlement is the
   * opposite question: "has this clone fetched X's peer-observed high-water?"
   * A local read is not a peer observation, and the local ref can be STALE
   * relative to the peer — so treating it as one makes every unanswerable peer
   * look like a matching high-water (meadow-measured: the round-2 bypass).
   *
   * Dispositions, and NONE of them can be read as a number unless the peer
   * really reported one:
   *   configured + refreshed  → the peer's high-water, or `null` when the peer
   *                             genuinely holds no record for that chain
   *                             (answered-absent = "not in the log").
   *   configured + absent     → `null` (the peer answered: no such ref).
   *   configured + unreachable / unreadable → THROWS.
   *   NOT configured          → THROWS: there is no peer to observe, so the
   *                             question this accessor exists to answer has no
   *                             answer — fail closed rather than self-observe.
   */
  function peerObservedHighWaterSync(verifiedId) {
    const fetched = _fetchRefFromRemote();
    if (fetched.status === "no-remote") {
      throw new Error(
        "transport-git-ref: no coordination peer is configured for this checkout " +
          `(remote '${remote}' has no url), so a peer-observed high-water cannot be ` +
          "established — a LOCAL read is not a peer observation (R10-S-01)",
      );
    }
    if (fetched.status === "absent") return null;
    if (typeof verifiedId !== "string" || !verifiedId) return null;
    const tip = headHashSync();
    if (!tip) return null;
    const records = _parseJsonl(_readLogBlobAt(tip));
    let high = null;
    for (const r of records) {
      if (r && r.verified_id === verifiedId) {
        if (!Number.isSafeInteger(r.seq) || r.seq < 0) {
          const error = new TypeError("transport-git-ref: invalid peer chain sequence; observation is unknown");
          error.code = "invalid-peer-chain-sequence";
          throw error;
        }
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
    // loom#1471 shard 2. The base was `process.env` — i.e. this site built an
    // explicit env for the AUTHOR/COMMITTER dimension while still inheriting
    // every other ambient variable, GIT_DIR included. Overriding identity does
    // not pin the repository. The base is now gitEnv()'s constants; the
    // deterministic identity overlay below is unchanged and still wins.
    const env = Object.assign({}, gitEnv(), {
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
      const gitBin = resolveGitBinary();
      if (!gitBin) {
        throw new Error(
          "transport-git-ref: no git binary resolved; refusing to commit-tree " +
            "against an indeterminate repository",
        );
      }
      const out = execFileSync(gitBin, ["-C", repoDir, ...args], {
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
      // NETWORK call — see the `o.net` note in the runner above.
      git(pushArgs, { stdio: ["pipe", "pipe", "pipe"], net: true });
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
    const newLine = _serializeRecord(record);
    assertRecordSize(Buffer.byteLength(newLine, "utf8"));
    let lastReason = "no attempts";
    for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
      const fetched = _fetchRefFromRemote();
      // Same rule on the write path: "the peer has no such ref" means the chain
      // starts here, NOT that a stale local ref should be extended. A
      // could-not-answer THROWS out of this function (unchanged: the caller's
      // retry/exhaust path already reports it as a failure, never as success).
      const priorTip = fetched.status === "absent" ? null : headHashSync();
      const priorJsonl = priorTip ? _readLogBlobAt(priorTip) : "";
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
    // The STRICT peer-observed accessor (2026-10-09, round-2): throws when no
    // peer is configured, throws when the peer cannot be reached or read, and
    // answers a number/null ONLY when the peer really answered. Settlement
    // consumers MUST use this one.
    peerObservedHighWaterSync,
    assertBoundPeerSync,
    resolveBoundLogRefSync,
    // Promise-returning aliases matching the engine's typedef shape.
    // `Promise.resolve(f())` evaluates `f()` EAGERLY, so once the sync methods
    // started throwing on INDETERMINATE (shard 7) that throw escaped
    // synchronously from a method the typedef advertises as Promise-returning —
    // a `.catch()` consumer would never see it. `Promise.try`-by-hand keeps the
    // indeterminate on the contract's own channel.
    appendRecord: (rec) =>
      new Promise((resolve) => resolve(appendRecordSync(rec))),
    readAllRecords: () => new Promise((resolve) => resolve(readAllRecordsSync())),
    headHash: () => new Promise((resolve) => resolve(headHashSync())),
    peerHighWaterFor: (id) =>
      new Promise((resolve) => resolve(peerHighWaterForSync(id))),
    peerObservedHighWater: (id) =>
      new Promise((resolve) => resolve(peerObservedHighWaterSync(id))),
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
    // loom#1471 shard 2 — see the `git()` runner above; this is the same defect
    // on the module-level read path (test S2-T2 measured it steering to the
    // attacker's archive tip).
    const gitBin = resolveGitBinary();
    if (!gitBin) {
      return {
        ok: false,
        reason:
          "readArchiveRefTip: no git binary resolved; archive tip is INDETERMINATE " +
          "(never reported as absent — security.md § Enforcement-Surface Parity)",
      };
    }
    out = execFileSync(
      gitBin,
      ["-C", repoDir, "for-each-ref", "--format=%(objectname)", refName],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: gitEnv() },
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
