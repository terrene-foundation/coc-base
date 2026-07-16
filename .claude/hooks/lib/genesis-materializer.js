/**
 * genesis-materializer — SessionStart fresh-clone trust-root recovery.
 *
 * GENMAT-1 Wave-2 Shard T3 (loom#879 root-cause fix). A fresh clone of an
 * ENROLLED repo has an empty gitignored `.claude/learning/coordination-log.jsonl`
 * (the per-clone cache). `genesis-anchor-guard.js` therefore fail-CLOSED-blocks
 * the clone's first commit ("enrolled-but-UNMATERIALIZED", loom#879). This
 * module RECOVERS the EXISTING trust root by fetch-then-fold from the canonical
 * coordination-log ref — it NEVER originates a new genesis-anchor (that would
 * FORK the trust root; fold-genesis-anchor.js invariant 4).
 *
 * ADR D3 split:
 *   - a ZERO-NETWORK in-band predicate (`needsMaterialization`) that reuses the
 *     guard's real-owner-roster + no-verifying-local-anchor logic, and
 *   - an OFF-parent fetch-then-fold + atomic direct write (`materialize`).
 *
 * #857 CONSTRAINT: `resolveLogRefName`'s ls-remote AND this module's fetch are
 * NETWORK round-trips. They MUST run ONLY in the DETACHED, UNBUDGETED
 * `runCacheRebuild` lane of `multi-operator-sessionstart.js` — NEVER on the
 * budgeted SessionStart PARENT path. `needsMaterialization` is the zero-network
 * predicate and is safe anywhere; `materialize` is the network lane.
 *
 * Invariants held (ALL of them):
 *   1. NO network in `needsMaterialization` (the parent may call it; the fetch
 *      lives in `materialize`, wired ONLY into `runCacheRebuild`).
 *   2. Fail-OPEN on absent/unreachable ref — no write, session inits, the first
 *      commit stays fail-CLOSED-blocked by the guard with its existing advice.
 *   3. Atomic write — temp file + rename; never a partial log.
 *   4. Whole-blob validation — split on "\n", JSON.parse each line; reject the
 *      ENTIRE write on ANY malformed line or smuggled "\n".
 *   5. NO `materialized=true` short-circuit — every call re-folds every time
 *      (fork-safety); no flag skips re-verification.
 *   6. On empty fetch → no-op + fail-CLOSED; NEVER fall back to enroll-genesis.
 *   7. Whole chain — fetch + fold anchor + migration; a fresh clone never needs
 *      to know its trust-root generation to fetch (the ref name is the LOG gen,
 *      resolved via ls-remote in `resolveLogRefName`).
 *   8. Bounded fetch — cap fetch bytes + record count; reject an implausibly
 *      large ref.
 *   9. Fork-safety — a tampered/forged fetched chain that does NOT fold to a
 *      verifying owner-bound trust root is REJECTED (no write); it cannot mint
 *      a false root, and re-verification runs via `foldGenesisAnchor`.
 *
 * Style: CommonJS, zero-dep beyond child_process/fs. Git runner + fs are
 * injectable (opts.git / opts.fs) so tests drive a real `git init --bare`
 * remote in mktemp with NO subprocess mocking — the log-ref-name.js / transport
 * pattern.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { foldGenesisAnchor } = require("./fold-genesis-anchor.js");
const { isUnenrolled } = require("./roster-schema-validate.js");
const cocSign = require("./coc-sign.js");
const { shouldEmitCloneInit } = require("./clone-init.js");
const {
  resolveLogRefName,
  DEFAULT_LOG_REF_NAME,
} = require("./log-ref-name.js");

const DEFAULT_REMOTE = "origin";
// The transport stores the log as a single blob at the ref tip; we fetch that
// whole blob. Import the blob-name constant from the SINGLE source
// (transport-git-ref.js) — the SAME module T2's enrollment-seed transport
// writes through — so the seed target and this fetch target can never drift.
// A hardcoded copy that drifted from transport-git-ref.js would make
// `cat-file` return blob-absent → materialize silently no-ops → loom#879
// (fresh-clone-cannot-recover) re-opens with no error surfaced. The
// genesis-materializer.test.mjs binds this parity (one literal, no drift).
const { LOG_BLOB_FILENAME } = require("./transport-git-ref.js");

// Invariant 8 — bounded fetch. A coordination log before a checkpoint is
// low-thousands of records; these ceilings reject an implausibly large ref
// (a resource-exhaustion vector off the network) while staying well clear of
// any legitimate pre-checkpoint log.
const DEFAULT_MAX_RECORDS = 50000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB

/**
 * Default git runner: `git -C <repoDir> <args...>` via execFileSync arg-array
 * form (NO shell interpolation — security.md § "No eval()"). Returns
 * {ok, stdout} on success or {ok:false, stderr} on non-zero exit. NEVER throws.
 *
 * @param {{args: string[], repoDir: string, input?: string}} spec
 * @returns {{ok: boolean, stdout?: string, stderr?: string}}
 */
function _defaultGit({ args, repoDir, input }) {
  try {
    const stdout = execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      input,
      maxBuffer: DEFAULT_MAX_BYTES + 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout) };
  } catch (err) {
    return {
      ok: false,
      stderr: err && err.stderr ? String(err.stderr) : String(err),
    };
  }
}

function _loadRoster(fsImpl, rosterPath) {
  try {
    if (!fsImpl.existsSync(rosterPath)) return null;
    return JSON.parse(fsImpl.readFileSync(rosterPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Load the local coordination-log records (zero-network). Skips malformed
 * lines — the SAME anti-narrowing disposition genesis-anchor-guard.js uses:
 * a stray parseable line trips the enrolled→block branch, never fresh→advisory.
 * Returns [] when the file is absent (the fresh-clone case).
 */
function _loadLocalRecords(fsImpl, logPath) {
  try {
    if (!fsImpl.existsSync(logPath)) return [];
    const text = fsImpl.readFileSync(logPath, "utf8");
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // malformed line — insufficient info; contributes nothing to the fold.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * rosterHasRealOwner — the guard's own real-owner predicate, re-expressed via
 * the SHARED `isUnenrolled` primitive (NOT a copy of the guard's inline block).
 * True ⟺ the roster names a real (non-PLACEHOLDER) genesis owner = enrollment
 * has occurred.
 */
function rosterHasRealOwner(roster) {
  return !!(
    roster &&
    roster.genesis &&
    typeof roster.genesis.repo_owner === "string" &&
    roster.genesis.repo_owner &&
    !isUnenrolled(roster.genesis.repo_owner)
  );
}

/**
 * Fold a record set through the genesis-anchor predicate (rule 9a) and report
 * whether it establishes a verifying owner-bound trust root. The genesis-anchor
 * survives a later genesis-migration (9c governs genesis_generation, not the
 * 9a-pinned facts), so a whole anchor+migration chain still folds to a root.
 * Re-verification runs on EVERY call — invariant 5 (no materialized short-circuit)
 * + invariant 9 (fork-safety: a forged chain that does not fold → no root).
 */
function _foldEstablishesTrustRoot(records, roster, verifyFn) {
  const verify = typeof verifyFn === "function" ? verifyFn : cocSign.verify;
  let state = { trustRoot: null };
  for (const rec of Array.isArray(records) ? records : []) {
    if (rec && rec.type === "genesis-anchor") {
      const r = foldGenesisAnchor(rec, state, roster, verify);
      if (r && r.accepted) state = r.foldState;
    }
  }
  return state.trustRoot !== null;
}

/**
 * needsMaterialization — ZERO-NETWORK predicate (invariant 1). True ⟺ the
 * roster names a REAL owner (enrollment occurred) AND the local records carry
 * NO verifying owner-bound trust root (fresh clone / tampered-or-absent local
 * anchor). Scaffold/PLACEHOLDER rosters → false (that is never-enrolled; the
 * guard's enroll-genesis remediation is correct there, NOT materialization).
 *
 * @param {object} roster        loaded operators roster (or null)
 * @param {Array}  localRecords  parsed local coordination-log records
 * @param {function} [verifyFn]  signature verify (defaults to cocSign.verify)
 * @returns {boolean}
 */
function needsMaterialization(roster, localRecords, verifyFn) {
  if (!rosterHasRealOwner(roster)) return false;
  return !_foldEstablishesTrustRoot(localRecords, roster, verifyFn);
}

/**
 * Fetch the WHOLE coordination-log ref blob from the remote (invariant 7 —
 * whole chain). NETWORK — off-parent lane only. Fail-OPEN: an absent/unreachable
 * ref returns {ok:false} and the caller no-ops (invariant 2, 6). Bounded
 * (invariant 8): a blob larger than maxBytes is rejected.
 */
function _fetchWholeRefBlob({ git, repoDir, remote, refName, maxBytes }) {
  // 1. fetch the ref into the local ref namespace (best-effort — an absent
  //    remote ref is the legitimate empty state; we swallow and observe below).
  git({
    args: ["fetch", remote, "--quiet", `+${refName}:${refName}`],
    repoDir,
  });
  // 2. resolve the ref tip. Absent locally after fetch ⟺ absent on remote.
  const tipRes = git({
    args: ["rev-parse", "--verify", "--quiet", refName],
    repoDir,
  });
  if (!tipRes || !tipRes.ok || typeof tipRes.stdout !== "string") {
    return { ok: false, reason: "ref-absent" };
  }
  const tip = tipRes.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(tip)) return { ok: false, reason: "ref-absent" };
  // 3. read the whole log blob at the tip.
  const blobRes = git({
    args: ["cat-file", "-p", `${tip}:${LOG_BLOB_FILENAME}`],
    repoDir,
  });
  if (!blobRes || !blobRes.ok || typeof blobRes.stdout !== "string") {
    return { ok: false, reason: "blob-absent" };
  }
  const blob = blobRes.stdout;
  if (Buffer.byteLength(blob, "utf8") > maxBytes) {
    return { ok: false, reason: "ref-too-large" };
  }
  return { ok: true, blob };
}

/**
 * Whole-blob validation (invariant 4). Split on "\n"; JSON.parse each non-empty
 * line. ANY malformed line (or a smuggled literal "\n", which necessarily
 * breaks a record across two physical lines and so fails parse on at least one)
 * rejects the ENTIRE write. Returns the ORIGINAL line strings (byte-preserving —
 * the fold re-derives signed bytes from the parsed record, so preserving the
 * exact stored line keeps the on-disk cache byte-identical to the ref blob).
 * An EMPTY blob is rejected (invariant 6 — no-op, never seed an empty log).
 */
function _validateAndParse(blob, maxRecords) {
  const lines = String(blob).split("\n");
  const keptLines = [];
  const records = [];
  for (const line of lines) {
    if (line === "") continue; // trailing/interstitial blank — not a record
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return { ok: false, reason: "malformed-line" };
    }
    keptLines.push(line);
    records.push(rec);
    if (records.length > maxRecords) {
      return { ok: false, reason: "too-many-records" };
    }
  }
  if (records.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, lines: keptLines, records };
}

/**
 * Atomic direct write (invariant 3) — bypasses the transport's 2KB cap
 * (invariant 4). temp file in the SAME directory (so rename is atomic on one
 * filesystem) → fs.renameSync. mode 0600 (the log carries person_ids). Never a
 * partial log: a reader sees either the old file or the fully-written new one.
 */
function _atomicWrite(fsImpl, logPath, content) {
  const dir = path.dirname(logPath);
  fsImpl.mkdirSync(dir, { recursive: true });
  // O_EXCL ("wx") so a symlink planted at the predictable temp path fails the
  // write CLOSED (rather than the default "w"/O_TRUNC, which FOLLOWS a symlink)
  // — the same defense the sibling banner-writer in multi-operator-sessionstart.js
  // uses. Retry with a fresh name on the rare EEXIST collision.
  let tmp = null;
  let writeErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = path.join(
      dir,
      `.coordination-log.materialize-${process.pid}-${Date.now()}-${attempt}.tmp`,
    );
    try {
      fsImpl.writeFileSync(candidate, content, { mode: 0o600, flag: "wx" });
      tmp = candidate;
      writeErr = null;
      break;
    } catch (err) {
      writeErr = err;
      if (err && err.code === "EEXIST") continue; // collision — try a fresh name
      throw err;
    }
  }
  if (tmp === null) throw writeErr;
  try {
    fsImpl.renameSync(tmp, logPath);
  } catch (err) {
    try {
      fsImpl.unlinkSync(tmp);
    } catch {
      // best-effort temp cleanup
    }
    throw err;
  }
}

/**
 * materialize — OFF-parent fetch-then-fold + atomic write (the network lane).
 * MUST be called ONLY from the detached, unbudgeted `runCacheRebuild` lane
 * (#857). Fail-OPEN on every failure branch (no throw to the caller): the
 * session still inits and the first commit stays fail-CLOSED-blocked by the
 * guard until the log is materialized.
 *
 * @param {object} opts
 * @param {string} [opts.repoDir]     checkout dir; defaults to cwd.
 * @param {string} [opts.remote]      git remote; defaults to "origin".
 * @param {string} [opts.refName]     canonical log ref; resolved via
 *   resolveLogRefName (ls-remote) when omitted.
 * @param {object} [opts.roster]      pre-loaded roster (else read from disk).
 * @param {string} [opts.logPath]     local coordination-log path.
 * @param {string} [opts.rosterPath]  operators roster path.
 * @param {string} [opts.verifiedId]  this clone's signing-key fingerprint — used
 *   ONLY to compute `cloneInitOwed` (compose with clone-init; NOT emitted here).
 * @param {function} [opts.git]       injected git runner (tests).
 * @param {object}   [opts.fs]        injected fs (tests).
 * @param {function} [opts.verify]    injected signature verify (tests).
 * @param {number}   [opts.maxBytes]  fetch byte ceiling.
 * @param {number}   [opts.maxRecords] record-count ceiling.
 * @returns {{ok: boolean, wrote: boolean, reason?: string, records?: number,
 *            cloneInitOwed?: boolean|null}}
 */
function materialize(opts) {
  const o = opts || {};
  const repoDir = o.repoDir || process.cwd();
  const fsImpl = o.fs || fs;
  const git = typeof o.git === "function" ? o.git : _defaultGit;
  const verifyFn = typeof o.verify === "function" ? o.verify : cocSign.verify;
  const remote = o.remote || DEFAULT_REMOTE;
  const maxBytes = Number.isInteger(o.maxBytes)
    ? o.maxBytes
    : DEFAULT_MAX_BYTES;
  const maxRecords = Number.isInteger(o.maxRecords)
    ? o.maxRecords
    : DEFAULT_MAX_RECORDS;
  const logPath =
    o.logPath ||
    path.join(repoDir, ".claude", "learning", "coordination-log.jsonl");
  const rosterPath =
    o.rosterPath || path.join(repoDir, ".claude", "operators.roster.json");

  const roster = o.roster || _loadRoster(fsImpl, rosterPath);

  // Zero-network gate: only an enrolled-but-unmaterialized clone materializes.
  const localRecords = _loadLocalRecords(fsImpl, logPath);
  if (!needsMaterialization(roster, localRecords, verifyFn)) {
    return { ok: false, wrote: false, reason: "not-needed" };
  }

  // Resolve the FETCHABLE ref name (network ls-remote; off-parent only). The
  // ref name is the LOG generation, discovered from the remote — NOT the
  // trust-root generation (redteam HIGH-1 resolved).
  let refName = o.refName;
  if (!refName) {
    try {
      refName = resolveLogRefName({ repoDir, remote, git }).refName;
    } catch {
      refName = DEFAULT_LOG_REF_NAME;
    }
  }

  // Fetch the WHOLE ref blob. Fail-OPEN on absent/unreachable/oversized.
  const fetched = _fetchWholeRefBlob({
    git,
    repoDir,
    remote,
    refName,
    maxBytes,
  });
  if (!fetched.ok) return { ok: false, wrote: false, reason: fetched.reason };

  // Whole-blob validation: reject the ENTIRE write on any malformed line.
  const parsed = _validateAndParse(fetched.blob, maxRecords);
  if (!parsed.ok) return { ok: false, wrote: false, reason: parsed.reason };

  // Fork-safety (invariant 9): the fetched chain MUST fold to a verifying
  // owner-bound trust root against THIS clone's roster, else no write — a
  // tampered/forged chain cannot mint a false root.
  if (!_foldEstablishesTrustRoot(parsed.records, roster, verifyFn)) {
    return { ok: false, wrote: false, reason: "fetched-chain-no-trust-root" };
  }

  // Atomic direct write (bypasses the 2KB transport cap).
  const content = parsed.lines.join("\n") + "\n";
  try {
    _atomicWrite(fsImpl, logPath, content);
  } catch (err) {
    return {
      ok: false,
      wrote: false,
      reason: `write-failed: ${err && err.message ? err.message : String(err)}`,
    };
  }

  // Compose with clone-init (redteam MED-1): a materialized clone still owes
  // its OWN first-fold clone-init witness. We CONSULT shouldEmitCloneInit and
  // report the obligation — we do NOT emit it here (that is clone-init.js's job,
  // wired on the signing path; duplicating the emission is BLOCKED).
  let cloneInitOwed = null;
  if (typeof o.verifiedId === "string" && o.verifiedId) {
    try {
      cloneInitOwed = shouldEmitCloneInit(
        roster,
        { records: parsed.records },
        o.verifiedId,
      );
    } catch {
      cloneInitOwed = null;
    }
  }

  return {
    ok: true,
    wrote: true,
    records: parsed.records.length,
    cloneInitOwed,
  };
}

/**
 * Best-effort resolve this clone's own signing-key fingerprint (for the
 * clone-init compose). Returns undefined when no identity resolves — the CLI /
 * off-parent lane still recovers the trust root; only `cloneInitOwed` is unknown.
 */
function _resolveVerifiedId(repoDir) {
  try {
    const { resolveIdentity } = require("./operator-id.js");
    const id = resolveIdentity(repoDir, {});
    return id && typeof id.verified_id === "string"
      ? id.verified_id
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fail-CLOSED operator guidance for each non-recoverable disposition. NEVER
 * suggests /whoami --enroll-genesis (which ORIGINATES a new anchor → trust-root
 * fork). The copy-the-log LAST RESORT mirrors the guard's remediation text.
 */
function _failClosedMessage(reason) {
  const doNotEnroll =
    "Do NOT run /whoami --enroll-genesis — it ORIGINATES a new genesis-anchor " +
    "and risks a trust-root fork. LAST RESORT (trusted source only): copy " +
    ".claude/learning/coordination-log.jsonl from an already-materialized clone " +
    "(the guard re-verifies every anchor against the roster owner's key, so a " +
    "tampered/forged log simply re-blocks and cannot mint a false trust root).";
  if (
    reason === "ref-absent" ||
    reason === "blob-absent" ||
    reason === "empty"
  ) {
    return (
      "genesis-materializer: the canonical coordination-log ref carries no trust " +
      "root to fetch. The repo owner must re-seed the existing trust root to the " +
      `ref (an un-rotated repo uses ${DEFAULT_LOG_REF_NAME}). ${doNotEnroll}\n`
    );
  }
  if (reason === "fetched-chain-no-trust-root") {
    return (
      "genesis-materializer: the fetched chain does NOT verify against this " +
      "roster's owner key (tamper / corruption / roster⊥anchor mismatch). Restore " +
      `from a trusted source and investigate the mismatch. ${doNotEnroll}\n`
    );
  }
  if (
    reason === "malformed-line" ||
    reason === "too-many-records" ||
    reason === "ref-too-large"
  ) {
    return (
      `genesis-materializer: the fetched ref failed validation (${reason}); ` +
      `refusing to write a partial or oversized log. ${doNotEnroll}\n`
    );
  }
  if (typeof reason === "string" && reason.startsWith("write-failed")) {
    return (
      `genesis-materializer: the local write failed (${reason}); no partial log ` +
      "was written. Re-run once the underlying condition is resolved.\n"
    );
  }
  return (
    `genesis-materializer: recovery did not complete (${reason || "unknown"}); ` +
    `the first commit stays fail-CLOSED-blocked by the guard. ${doNotEnroll}\n`
  );
}

/**
 * runCli — the EXPLICIT, one-time, foreground on-demand recovery path (ADR-D3
 * disposition ii). An operator who hits the guard's enrolled-but-unmaterialized
 * block runs this NOW to recover synchronously, instead of waiting for the next
 * session's detached rebuild (disposition i). It is NOT a hook (no hook event,
 * no hookSpecificOutput envelope) — it is a foreground CLI, so CLI exit codes
 * (0 success / 1 fail-CLOSED / 2 usage) are the correct contract, NOT the
 * instruct-and-wait shape. It reuses the SAME `materialize()` core the
 * off-parent lane calls — no second implementation. Network-permitted (this is
 * NOT the SessionStart parent path; the #857 no-network lock is on runParent).
 *
 * @param {string[]} argv - args after the node script (process.argv.slice(2)).
 * @param {object}   env  - environment (process.env).
 * @returns {number} exit code.
 */
function runCli(argv, env) {
  const args = Array.isArray(argv) ? argv : [];
  const e = env || process.env;
  const out = (s) => process.stdout.write(s);
  const err = (s) => process.stderr.write(s);

  if (!args.includes("--materialize")) {
    err(
      "genesis-materializer — on-demand fresh-clone trust-root recovery (loom#879).\n" +
        "Usage: node .claude/hooks/lib/genesis-materializer.js --materialize\n" +
        "Fetch-then-fold the EXISTING trust root from the canonical coordination-\n" +
        "log ref into this clone's local log. Fails CLOSED (never originates) when\n" +
        "the ref carries no verifying trust root.\n",
    );
    return 2;
  }

  const repoDir = e.CLAUDE_PROJECT_DIR || process.cwd();
  const logPath = path.join(
    repoDir,
    ".claude",
    "learning",
    "coordination-log.jsonl",
  );
  const rosterPath = path.join(repoDir, ".claude", "operators.roster.json");
  const roster = _loadRoster(fs, rosterPath);

  // Scaffold / never-enrolled: this command recovers an EXISTING root; it does
  // NOT enroll. Fail-CLOSED with enroll guidance (never originate here).
  if (!rosterHasRealOwner(roster)) {
    err(
      "genesis-materializer: this repo's roster names no real owner " +
        "(scaffold / never-enrolled). This command RECOVERS an existing trust " +
        "root; it does NOT enroll. Run /whoami --enroll-genesis to establish the " +
        "trust root. This command NEVER originates one.\n",
    );
    return 1;
  }

  // Already materialized: a verifying trust root is present locally — no-op.
  const localRecords = _loadLocalRecords(fs, logPath);
  if (_foldEstablishesTrustRoot(localRecords, roster, cocSign.verify)) {
    out(
      "genesis-materializer: this clone already carries a verifying trust root — " +
        "nothing to materialize.\n",
    );
    return 0;
  }

  // Enrolled-but-unmaterialized → attempt fetch-then-fold recovery via the SAME
  // core the off-parent lane calls.
  const res = materialize({
    repoDir,
    roster,
    logPath,
    verifiedId: _resolveVerifiedId(repoDir),
  });
  if (res.ok && res.wrote) {
    out(
      `genesis-materializer: recovered the existing trust root — materialized ` +
        `${res.records} record(s) from the canonical log ref into this clone's ` +
        `local coordination-log. You may now commit.\n`,
    );
    return 0;
  }
  err(_failClosedMessage(res.reason));
  return 1;
}

module.exports = {
  needsMaterialization,
  materialize,
  runCli,
  DEFAULT_MAX_RECORDS,
  DEFAULT_MAX_BYTES,
  // Exposed for tests + downstream tooling.
  _internal: {
    rosterHasRealOwner,
    _foldEstablishesTrustRoot,
    _fetchWholeRefBlob,
    _validateAndParse,
    _atomicWrite,
    _loadLocalRecords,
    _loadRoster,
    _defaultGit,
    _failClosedMessage,
    _resolveVerifiedId,
  },
};

// Explicit foreground entry (ADR-D3 disposition ii). Only fires on direct
// invocation (`node .../genesis-materializer.js --materialize`); require()'d as
// a lib (the off-parent lane, tests) this block is inert.
if (require.main === module) {
  process.exit(runCli(process.argv.slice(2), process.env));
}
