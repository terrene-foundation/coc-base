/**
 * log-ref-name — the ONE source of the canonical coordination-log ref name.
 *
 * GENMAT-1 Shard 1 (loom#879 root-cause fix). The coordination log is
 * persisted to a fetchable git ref so a fresh clone of an enrolled repo can
 * recover its trust root (fetch-then-fold) instead of being permanently
 * fail-CLOSED-blocked at its first commit. Three consumers MUST agree on the
 * ref name or the recovery silently no-ops (the redteam F1 silent-no-op class):
 *
 *   1. the git-ref transport default (`transport-git-ref.js::createGitRefTransport`)
 *   2. the guard's materialize remediation text (`genesis-anchor-guard.js`)
 *   3. the SessionStart materializer (Shard 3)
 *
 * This module is that single source.
 *
 * --------------------------------------------------------------------------
 * The LOG-generation ref name — NOT the trust-root generation
 * --------------------------------------------------------------------------
 *
 * The log ref is named by the LOG-ROTATION generation, advanced by
 * `generation-rotation` records (fold rule 9b — compaction-driven log
 * rotation). This is a DISTINCT counter from the trust-root `genesis_generation`
 * advanced by `genesis-migration` records (fold rule 9c). The two are
 * orthogonal (redteam HIGH-1, RESOLVED): a fresh clone NEVER needs to know its
 * trust-root generation to name or fetch the ref — it fetches the whole current
 * log-gen ref and folds the whole chain, and rule 9c computes the trust-root
 * generation from the migration record inside that chain.
 *
 *   - loom has had NO `generation-rotation` → its log ref is log-gen 0 →
 *     `refs/coc/coordination-gen0`.
 *   - `refs/coc/coordination` (no `-genN`) is the vestigial F43 empty-tree
 *     seed — NOT the log ref; treated as absent for resolution purposes.
 *   - `refs/coc/archive-gen<N>` is a SEPARATE family (the cold-archive tip-pin
 *     verified by `archive-ref.js::verifyArchiveTipPin`, invoked on the
 *     `fold-rule-9b.js` fold path) and MUST NOT be matched or touched here.
 *
 * This module does NOT read or write `roster.genesis.genesis_generation`
 * anywhere — no trust-root-generation coupling (redteam HIGH-1 RESOLVED).
 *
 * Style: CommonJS, zero-dep beyond child_process. The git runner is injected
 * (opts.git) so tests can use a local `git init --bare` remote in `mktemp -d`
 * without subprocess mocking — the same pattern `transport-git-ref.js` uses.
 */

"use strict";

const { execFileSync } = require("child_process");

// The canonical default ref name. Generation 0 = the un-rotated log family.
// `transport-git-ref.js` imports this so the transport default and this
// resolver's default are one literal, never two that can drift.
const DEFAULT_LOG_REF_NAME = "refs/coc/coordination-gen0";

// The ref-family prefix. A log-gen ref is `<PREFIX><N>` for a non-negative
// integer N. The bare `refs/coc/coordination` (F43 seed) does NOT match this
// prefix (it has no `-gen` suffix) and is therefore treated as absent.
const LOG_REF_PREFIX = "refs/coc/coordination-gen";

const DEFAULT_REMOTE = "origin";

/**
 * Default git runner: `git -C <repoDir> <args...>` via execFileSync (arg-array
 * form, no shell interpolation — `security.md` § "No eval()"). Returns
 * {ok, stdout} on success or {ok:false, stderr} on non-zero exit. NEVER throws
 * — resolution is best-effort and MUST fall back to the default ref name on
 * any failure (a fresh clone with no network still resolves a usable name).
 *
 * @param {{args: string[], repoDir: string}} spec
 * @returns {{ok: boolean, stdout?: string, stderr?: string}}
 */
function _defaultGit({ args, repoDir }) {
  try {
    const stdout = execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: String(stdout) };
  } catch (err) {
    return {
      ok: false,
      stderr: err && err.stderr ? String(err.stderr) : String(err),
    };
  }
}

/**
 * Parse `git ls-remote` output into the highest log-generation integer.
 *
 * Each ls-remote line is `<40-hex-sha>\t<refname>`. We accept ONLY refs of
 * the exact shape `refs/coc/coordination-gen<N>` where <N> is a run of ASCII
 * digits (so `refs/coc/coordination` and `refs/coc/coordination-genFOO` and
 * `refs/coc/archive-gen0` are all rejected). Returns the highest N observed,
 * or null when no log-gen ref is present.
 *
 * Exposed for unit tests (the parse is the load-bearing logic; the ls-remote
 * subprocess is thin).
 *
 * @param {string} lsRemoteStdout
 * @returns {number | null}
 */
function parseHighestLogGen(lsRemoteStdout) {
  if (typeof lsRemoteStdout !== "string" || !lsRemoteStdout) return null;
  let highest = null;
  const lines = lsRemoteStdout.split("\n");
  for (const line of lines) {
    if (!line) continue;
    // Split on whitespace/tab; the ref name is the last NON-EMPTY field.
    // Filtering empties makes the parse robust to a trailing `\r` (CRLF on a
    // Windows/ADO client) or any trailing pad, which would otherwise become a
    // trailing empty field and silently drop the ref. `git ls-remote` plumbing
    // emits LF today, but the substrate serves Windows clients, so the parser
    // MUST be tolerant of whitespace the ceremony never intends to be
    // significant.
    const parts = line.split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    const refName = parts[parts.length - 1];
    if (!refName || refName.indexOf(LOG_REF_PREFIX) !== 0) continue;
    const suffix = refName.slice(LOG_REF_PREFIX.length);
    // Suffix MUST be a pure run of digits — `-gen0`, `-gen12`, never
    // `-gen0/foo`, `-genFOO`, or an empty suffix (bare prefix).
    if (!/^[0-9]+$/.test(suffix)) continue;
    const n = parseInt(suffix, 10);
    if (!Number.isSafeInteger(n)) continue;
    if (highest === null || n > highest) highest = n;
  }
  return highest;
}

/**
 * Compose the canonical ref name for a given log generation.
 * @param {number} gen - non-negative integer
 * @returns {string}
 */
function logRefNameForGen(gen) {
  if (!Number.isSafeInteger(gen) || gen < 0) {
    return DEFAULT_LOG_REF_NAME;
  }
  return `${LOG_REF_PREFIX}${gen}`;
}

/**
 * resolveLogRefName — discover the canonical current-log-generation ref name
 * from the remote, defaulting to `refs/coc/coordination-gen0`.
 *
 * Discovery: `git ls-remote <remote> 'refs/coc/coordination-gen*'` and pick the
 * highest `-gen<N>`. When the remote carries only the vestigial bare
 * `refs/coc/coordination` (F43 seed) OR no coordination ref at all OR is
 * unreachable, resolve to `refs/coc/coordination-gen0` — the correct name for
 * an un-rotated log, which is loom's state and every fresh enrolled repo's
 * state before its first rotation.
 *
 * This is a READ-ONLY discovery (ls-remote); it never fetches, writes, or
 * mutates any ref. It is safe to call from a network-permitted path (T2
 * enrollment seed, T3 off-parent materializer, T4 backfill) but MUST NOT be
 * called on the #857-sensitive SessionStart parent path (the ls-remote is a
 * network round-trip).
 *
 * @param {object} [opts]
 * @param {string} [opts.repoDir]  - local checkout for `git -C`; defaults to cwd.
 * @param {string} [opts.remote]   - remote name; defaults to "origin".
 * @param {function} [opts.git]    - injected git runner ({args, repoDir}) =>
 *                                   {ok, stdout?, stderr?}; defaults to execFileSync.
 * @returns {{refName: string, gen: number, source: string}}
 *   source ∈ {"ls-remote", "default-no-log-ref", "default-ls-remote-failed"}.
 *   The return ALWAYS carries a usable refName (fail-safe to gen0).
 */
function resolveLogRefName(opts) {
  const o = opts || {};
  const repoDir = o.repoDir || process.cwd();
  const remote = o.remote || DEFAULT_REMOTE;
  const git = typeof o.git === "function" ? o.git : _defaultGit;

  let res;
  try {
    res = git({
      args: ["ls-remote", remote, "refs/coc/coordination-gen*"],
      repoDir,
    });
  } catch (err) {
    // A throwing injected runner is treated as an ls-remote failure — default.
    return {
      refName: DEFAULT_LOG_REF_NAME,
      gen: 0,
      source: "default-ls-remote-failed",
    };
  }

  if (!res || !res.ok || typeof res.stdout !== "string") {
    return {
      refName: DEFAULT_LOG_REF_NAME,
      gen: 0,
      source: "default-ls-remote-failed",
    };
  }

  const highest = parseHighestLogGen(res.stdout);
  if (highest === null) {
    // Only the vestigial bare ref, or nothing → un-rotated → gen0.
    return {
      refName: DEFAULT_LOG_REF_NAME,
      gen: 0,
      source: "default-no-log-ref",
    };
  }
  return {
    refName: logRefNameForGen(highest),
    gen: highest,
    source: "ls-remote",
  };
}

module.exports = {
  DEFAULT_LOG_REF_NAME,
  LOG_REF_PREFIX,
  resolveLogRefName,
  parseHighestLogGen,
  logRefNameForGen,
};
