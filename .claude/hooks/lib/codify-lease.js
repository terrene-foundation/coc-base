/**
 * codify-lease — concurrency control for self-referential /codify runs.
 *
 * F14 M7 Shard E (workspaces/multi-operator-coc 02-plans/01-architecture.md §7.1).
 *
 * Problem: under N operators, two concurrent /codify invocations targeting the
 * same scope_files (e.g. both editing `.proposals/latest.yaml` +
 * `learning-codified.json` at once) clobber the rule corpus. The fix is a
 * structural lease that:
 *
 *   1. Names the scope deterministically (sorted, deduped relative file list).
 *   2. ALWAYS includes the codify-class state files
 *      (`learning-codified.json`, `.proposals/latest.yaml`) — even when the
 *      caller forgets, the lease covers them.
 *   3. Forces the codify session onto a `codify/<display_id>-<date>` branch so
 *      two concurrent sessions race for the branch namespace, NOT the working
 *      tree (admin-merge to main resolves the race).
 *   4. Persists an on-disk record at
 *      `.claude/learning/codify-lease.json` so a concurrent process sees the
 *      conflict and EXITS with a typed error (no silent fallback per
 *      rules/zero-tolerance.md Rule 3).
 *   5. Refuses to acquire when the workspace is dirty in a way that would
 *      conflict with the codify edits (an early gate, with a clear message
 *      naming the conflicting paths).
 *
 * Style: CommonJS to match sibling lib/* modules. Pure node:fs / child_process,
 * no external deps. The lease file lives alongside posture state (resolved via
 * state-resolver.js) so worktree-isolated /codify runs still see the same
 * lease as the main checkout.
 *
 * NOT this module's job:
 *   - rule propagation (immediate to main — that's the orchestrator's job
 *     after admin-merge of the codify PR).
 *   - signed [ack] for MUST-clause changes (lives in trust-posture wiring
 *     consumed at SessionStart).
 *   - team-memory promotion (lives in commands/codify.md Step 4b which calls
 *     this lease + then writes the .claude/team-memory/<topic>.md files).
 *
 * Public API:
 *   acquireCodifyLease({ scopeFiles, displayId, repoDir? }) -> Result
 *     Result = { ok: true, lease: {...}, branch, leasePath, scope, record_emit }
 *           | { ok: false, error, reason, conflicting?: {...} }
 *     record_emit (FSUB 2026-06-11): result of emitting the signed
 *     `codify-lease` coordination-log record (cross-clone visibility per
 *     knowledge-convergence.md MUST-3). {ok:true, record} on success;
 *     a typed {ok:false, error, reason, step} on failure — NON-FATAL to
 *     the lease (the on-disk mutex landed), but callers MUST surface it.
 *
 *   releaseCodifyLease({ repoDir?, displayId }) -> { ok, error? }
 *     The leasePath is derived from repoDir via _leasePath(_gitToplevel(repoDir))
 *     so the release path mirrors acquireCodifyLease (Sec-MED-3): callers cannot
 *     misroute the release write to another file under .claude/learning/.
 *
 *   readActiveLease(repoDir?) -> { lease | null }
 *
 * The Result is the contract — callers branch on `ok` and surface `error`
 * + `reason` directly to the user. NO throws on expected-failure paths.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const { resolveStateDir, resolveMainCheckout } = require("./state-resolver");
const { isCoordinationEnabled } = require("./coordination-mode.js");

const LEASE_FILE = "codify-lease.json";

// Codify-class state files that EVERY lease scope MUST include. Even if the
// caller passes an empty / partial scopeFiles, these are always added — the
// failure mode (concurrent /codify clobbers .proposals/latest.yaml) is the
// whole point of the lease.
const MANDATORY_SCOPE = Object.freeze([
  ".claude/learning/learning-codified.json",
  ".claude/.proposals/latest.yaml",
]);

// Lease branch prefix (per §7.1: `codify/<display_id>-<date>`).
const BRANCH_PREFIX = "codify/";

// ---- helpers ----------------------------------------------------------------

function _isoDate(now) {
  // YYYY-MM-DD in UTC (deterministic across time zones).
  const d = now || new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function _isoTimestamp(now) {
  return (now || new Date()).toISOString();
}

function _sortDedupRel(files) {
  // Normalize: trim, drop empty, dedup, sort. Mandatory-scope unioned in.
  const set = new Set();
  for (const f of files || []) {
    if (typeof f !== "string") continue;
    const trimmed = f.trim();
    if (!trimmed) continue;
    set.add(trimmed);
  }
  for (const f of MANDATORY_SCOPE) set.add(f);
  return Array.from(set).sort();
}

function _scopeFingerprint(scope) {
  // Deterministic hash for cross-process equality check.
  return crypto.createHash("sha256").update(scope.join("\n")).digest("hex");
}

function _validateDisplayId(displayId) {
  if (typeof displayId !== "string" || !displayId) {
    return "displayId is required (string, e.g. 'alice')";
  }
  // Match operator-id roster constraints conservatively: lowercase + digits +
  // hyphen + underscore + dot. No spaces, no shell metas.
  if (!/^[a-z0-9._-]+$/.test(displayId)) {
    return `displayId '${displayId}' contains characters outside [a-z0-9._-]`;
  }
  if (displayId.length > 64) {
    return `displayId '${displayId}' exceeds 64 chars`;
  }
  return null;
}

function _safeReadJson(p) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    // Corrupt JSON returns null — the caller sees no active lease, BUT we
    // surface the parse error via a sentinel so acquireCodifyLease can refuse
    // (a corrupt lease file is itself an audit failure).
    return { _corrupt: true, _error: String(e && e.message) };
  }
}

function _atomicWriteJson(p, obj) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmp, p);
}

function _gitToplevel(repoDir) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (e) {
    return null;
  }
}

function _gitCurrentBranch(repoDir) {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (e) {
    return null;
  }
}

function _gitStatusPorcelain(repoDir, files) {
  // Returns the porcelain lines limited to the named files. Empty array = clean.
  const args = ["status", "--porcelain=v1", "--"].concat(files);
  const r = spawnSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    return {
      ok: false,
      error: r.stderr ? r.stderr.trim() : "git status failed",
    };
  }
  const lines = (r.stdout || "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);
  return { ok: true, lines };
}

function _leasePath(repoDir) {
  const stateDir = resolveStateDir(repoDir);
  return path.join(stateDir, LEASE_FILE);
}

/**
 * FSUB (2026-06-11): emit the signed coordination-log record that makes
 * a lease transition visible to sibling CLONES (the on-disk
 * codify-lease.json is the local mutex; it does not travel — a sibling
 * operator's clone learns of the lease only through the fold). Record
 * types `codify-lease` / `codify-lease-release` are registered in
 * coordination-log.js::_registerM0Defaults (liveness-churn class, like
 * claim/release).
 *
 * Emission failure is NON-FATAL to the lease transition: the local
 * mutex already landed atomically, and refusing the lease because the
 * visibility record could not be signed (e.g. un-rostered operator)
 * would block solo /codify entirely. The failure IS surfaced — the
 * caller receives it under `record_emit` and MUST report it per
 * zero-tolerance.md Rule 3 (typed + observable, never silent).
 */
function _emitLeaseRecord(repoDir, type, content, opts) {
  const o = opts || {};
  try {
    const { emitSignedRecord } = require("./coc-emit.js");
    const emitOpts = {
      repoDir,
      type,
      content,
      identity: o.identity,
      signingKeyPath: o.signingKeyPath,
      keyType: o.keyType,
      sign: o.sign,
      readChainHead: o.readChainHead,
      append: o.append,
    };
    if (Object.prototype.hasOwnProperty.call(o, "gitConfigSigningKey")) {
      emitOpts.gitConfigSigningKey = o.gitConfigSigningKey;
    }
    return emitSignedRecord(emitOpts);
  } catch (err) {
    return {
      ok: false,
      error: "lease-record emit threw",
      reason: err && err.message ? err.message : String(err),
      step: "emit",
    };
  }
}

// ---- public API ------------------------------------------------------------

/**
 * Acquire a codify-lease for `displayId` covering `scopeFiles` (always
 * unioned with MANDATORY_SCOPE).
 *
 * Returns an object — never throws on expected failures (per
 * rules/zero-tolerance.md Rule 3 — typed error, NEVER silent fallback).
 *
 * Successful return:
 *   { ok: true,
 *     lease: {display_id, scope, scope_fingerprint, branch, acquired_at, pid, lease_id},
 *     branch: "codify/<display_id>-<date>",
 *     leasePath: "<repo>/.claude/learning/codify-lease.json",
 *     scope: [...] }
 *
 * Failure returns (each with a typed `reason`):
 *   { ok: false, error: "...", reason: "conflict", conflicting: {...} }
 *   { ok: false, error: "...", reason: "not-a-git-repo" }
 *   { ok: false, error: "...", reason: "scope-dirty", dirty: [...] }
 *   { ok: false, error: "...", reason: "lease-corrupt", path }
 *   { ok: false, error: "...", reason: "invalid-display-id" }
 *
 * No fallback to "best-effort proceed without lease" — callers MUST surface
 * the error to the user.
 */
function acquireCodifyLease(opts) {
  const o = opts || {};
  const displayId = o.displayId;
  const repoDir = o.repoDir || process.cwd();

  const idErr = _validateDisplayId(displayId);
  if (idErr) {
    return {
      ok: false,
      reason: "invalid-display-id",
      error: idErr,
    };
  }

  const topLevel = _gitToplevel(repoDir);
  if (!topLevel) {
    return {
      ok: false,
      reason: "not-a-git-repo",
      error: `acquireCodifyLease: ${repoDir} is not inside a git working tree`,
    };
  }

  const scope = _sortDedupRel(o.scopeFiles);
  const fingerprint = _scopeFingerprint(scope);
  const leasePath = _leasePath(topLevel);

  const existing = _safeReadJson(leasePath);
  if (existing && existing._corrupt) {
    return {
      ok: false,
      reason: "lease-corrupt",
      error: `acquireCodifyLease: existing lease at ${leasePath} is unparseable: ${existing._error}`,
      path: leasePath,
    };
  }

  if (existing && !existing._released) {
    // Conflict: someone else holds the lease. Even if the scope overlaps only
    // partially, refuse — the failure mode is concurrent edits to ANY scope
    // file. If scope is genuinely disjoint, the OTHER session should release
    // first.
    const overlap = (existing.scope || []).some((f) => scope.includes(f));
    return {
      ok: false,
      reason: "conflict",
      error:
        `acquireCodifyLease: another /codify session holds the lease ` +
        `(display_id=${existing.display_id}, since=${existing.acquired_at}). ` +
        (overlap
          ? "Scope overlaps — wait for the other session to release."
          : "Scope is disjoint, but only one /codify lease is active at a time per repo."),
      conflicting: {
        display_id: existing.display_id,
        acquired_at: existing.acquired_at,
        scope: existing.scope,
        branch: existing.branch,
        lease_id: existing.lease_id,
        pid: existing.pid,
      },
    };
  }

  // Workspace cleanliness check: refuse if scope files are dirty in the
  // working tree of the current branch, because the codify session will be
  // expected to commit them onto the codify branch.
  const statusRes = _gitStatusPorcelain(topLevel, scope);
  if (!statusRes.ok) {
    return {
      ok: false,
      reason: "git-status-failed",
      error: `acquireCodifyLease: git status --porcelain failed: ${statusRes.error}`,
    };
  }
  if (statusRes.lines.length > 0) {
    return {
      ok: false,
      reason: "scope-dirty",
      error:
        `acquireCodifyLease: scope files have uncommitted changes — commit or stash before /codify.\n` +
        statusRes.lines.join("\n"),
      dirty: statusRes.lines,
    };
  }

  // FSUB walk finding (2026-06-11, journal/0264 §FD1): the lease branch
  // MUST match the branch the codify session actually edits on —
  // integrity-guard.js::findCoveringLease matches content.branch against
  // `git rev-parse --abbrev-ref HEAD`, and a UTC-derived date constructs
  // YESTERDAY's name for a late-evening UTC+N session (live repro:
  // lease said codify/esperie-2026-06-10, session branch was
  // codify/esperie-2026-06-11 → covering check structurally unmatchable).
  // When the session is ALREADY on this operator's codify/* branch, bind
  // the lease to it; otherwise construct the UTC-dated default.
  // PR-B walk finding (2026-06-11, journal/0267): the capture MUST be
  // DATE-TERMINAL (`codify/<display_id>-YYYY-MM-DD` exactly) — the
  // integrity-guard's branch-shape predicate rejects suffixed names
  // (e.g. `codify/esperie-2026-06-11-b`), so a startsWith capture binds
  // a lease to a branch the guard will never honor (lease and guard
  // silently disagree on what a codify branch IS). Same-day second
  // codify work belongs on the SAME date-named branch.
  const currentBranchEarly = _gitCurrentBranch(topLevel);
  const ownBranchRe = new RegExp(
    `^${BRANCH_PREFIX}${displayId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}-\\d{2}-\\d{2}$`,
  );
  const branch =
    currentBranchEarly && ownBranchRe.test(currentBranchEarly)
      ? currentBranchEarly
      : `${BRANCH_PREFIX}${displayId}-${_isoDate()}`;
  const acquiredAt = _isoTimestamp();
  const leaseId =
    `lease_${Date.now()}_` + crypto.randomBytes(4).toString("hex");
  const currentBranch = _gitCurrentBranch(topLevel);

  const lease = {
    lease_id: leaseId,
    display_id: displayId,
    scope,
    scope_fingerprint: fingerprint,
    branch,
    acquired_at: acquiredAt,
    pid: process.pid,
    repo_top_level: topLevel,
    current_branch: currentBranch || null,
    _released: false,
    _version: 1,
  };

  _atomicWriteJson(leasePath, lease);

  // FSUB (2026-06-11): cross-clone visibility record. The content shape
  // matches the READER contract integrity-guard.js::findCoveringLease
  // documents and folds — {branch, date, scope_files} — so the guard's
  // covering check (branch match + signer match + scope path/prefix
  // match) resolves against this record. scope_files are REPO-RELATIVE
  // loom-internal artifact paths (the same visibility class as this
  // repo's own git history; the coordination log is per-repo and never
  // synced per multi-operator-coordination.md MUST NOT), so no
  // downstream-context token ships. A very large scope can exceed the
  // 2KB append cap — the emitter then refuses typed and record_emit
  // surfaces it (the on-disk lease is unaffected).
  // MO-OPT W1-c — opt-in gate (workspaces/multi-operator-optional, journal/0330).
  // The signed `codify-lease` coordination-log record is the CROSS-CLONE
  // visibility surface (knowledge-convergence.md MUST-3); a solo / fresh repo
  // (coordination OFF) has no coordination log + likely no signing key, so the
  // emit would fail non-fatally and surface a confusing "lease record emit
  // failed" warning. Skip it. The on-disk lease mutex AND the
  // codify/<id>-<date> branch are coordination-INDEPENDENT and STAY (they make
  // solo /codify race-safe + admin-merge-shaped exactly as today). When
  // ENABLED, the emit is byte-unchanged.
  // MO-OPT holistic post-multi-wave redteam (Cluster A): coordination state (the
  // predicate read + the coordination-log emit) is MAIN-checkout state (the same
  // CRIT-2 / trust-posture.md MUST-1 discipline state-resolver enforces — the
  // lease FILE already routes through resolveStateDir→main). Resolve main here so
  // a worktree-run /codify reads the predicate AND emits the record against main
  // (where coordination-mode.json + the coordination log live), never the
  // auto-deleted worktree copy. On the normal main-checkout path coordRoot ===
  // topLevel, so the enabled path is byte-unchanged (S6).
  const coordRoot = resolveMainCheckout(repoDir) || topLevel;
  const recordEmit = isCoordinationEnabled(coordRoot)
    ? _emitLeaseRecord(
        coordRoot,
        "codify-lease",
        {
          lease_id: leaseId,
          branch,
          // Informational; keep consistent with the branch's own date token
          // when the lease bound to an existing codify/* branch.
          date: (branch.match(/(\d{4}-\d{2}-\d{2})$/) || [])[1] || _isoDate(),
          scope_files: scope,
          scope_fingerprint: fingerprint,
          acquired_at: acquiredAt,
          action: "acquire",
        },
        o,
      )
    : { ok: true, skipped: true, reason: "coordination-disabled" };

  return {
    ok: true,
    lease,
    branch,
    leasePath,
    scope,
    record_emit: recordEmit,
  };
}

/**
 * Release a lease. Idempotent — releasing an already-released or missing
 * lease is a no-op (returns ok: true with `noop` flag).
 *
 * The release path REQUIRES the displayId to match the active lease's
 * display_id. A different operator cannot release someone else's lease.
 * That's a structural fence: the codify branch is named after the
 * acquirer, and only the acquirer can declare the work complete.
 *
 * Per Sec-MED-3: the leasePath is DERIVED from repoDir using the same
 * helpers acquireCodifyLease uses (_gitToplevel + _leasePath). Callers
 * cannot supply a leasePath argument to misroute the release write to a
 * different file under .claude/learning/. A `leasePath` field on the
 * opts object is ignored (it is NOT a typed error — silently dropped to
 * stay backward-compatible with any in-flight callers, but the actual
 * write target is always the repo-derived path).
 */
function releaseCodifyLease(opts) {
  const o = opts || {};
  const displayId = o.displayId;
  const repoDir = o.repoDir || process.cwd();

  const idErr = _validateDisplayId(displayId);
  if (idErr) {
    return { ok: false, reason: "invalid-display-id", error: idErr };
  }

  const topLevel = _gitToplevel(repoDir);
  if (!topLevel) {
    return {
      ok: false,
      reason: "not-a-git-repo",
      error: `releaseCodifyLease: ${repoDir} is not inside a git working tree`,
    };
  }

  const leasePath = _leasePath(topLevel);

  const existing = _safeReadJson(leasePath);
  if (existing === null) {
    return { ok: true, noop: true, reason: "no-lease" };
  }
  if (existing && existing._corrupt) {
    return {
      ok: false,
      reason: "lease-corrupt",
      error: `releaseCodifyLease: lease file is corrupt: ${existing._error}`,
    };
  }
  if (existing._released) {
    return { ok: true, noop: true, reason: "already-released" };
  }
  if (existing.display_id !== displayId) {
    return {
      ok: false,
      reason: "wrong-owner",
      error:
        `releaseCodifyLease: lease is held by ${existing.display_id}; ` +
        `cannot be released by ${displayId}`,
    };
  }

  const released = Object.assign({}, existing, {
    _released: true,
    released_at: _isoTimestamp(),
    released_by_pid: process.pid,
  });
  _atomicWriteJson(leasePath, released);

  // FSUB (2026-06-11): release visibility record — siblings folding the
  // log can pair acquire/release by lease_id without reading this
  // clone's codify-lease.json. MO-OPT W1-c: skip the signed emit when
  // coordination is OFF (symmetric with acquire above) — no coordination log
  // to pair against on a solo repo. The on-disk release IS already written.
  // Cluster A (see acquire): coordination state is main-checkout state.
  const coordRoot = resolveMainCheckout(repoDir) || topLevel;
  const recordEmit = isCoordinationEnabled(coordRoot)
    ? _emitLeaseRecord(
        coordRoot,
        "codify-lease-release",
        {
          lease_id: existing.lease_id,
          released_at: released.released_at,
          action: "release",
        },
        o,
      )
    : { ok: true, skipped: true, reason: "coordination-disabled" };

  return { ok: true, lease: released, record_emit: recordEmit };
}

/**
 * Inspect the current lease state. Returns `{ lease }` or `{ lease: null }`.
 * Surfaces corruption explicitly so the caller can refuse rather than
 * silently treat a corrupt file as no-lease.
 */
function readActiveLease(repoDir) {
  const rd = repoDir || process.cwd();
  const top = _gitToplevel(rd);
  if (!top) {
    return { lease: null, reason: "not-a-git-repo" };
  }
  const lp = _leasePath(top);
  const existing = _safeReadJson(lp);
  if (existing === null) return { lease: null, leasePath: lp };
  if (existing && existing._corrupt) {
    return {
      lease: null,
      leasePath: lp,
      reason: "lease-corrupt",
      error: existing._error,
    };
  }
  if (existing._released) {
    return { lease: null, leasePath: lp, reason: "released", last: existing };
  }
  return { lease: existing, leasePath: lp };
}

module.exports = {
  acquireCodifyLease,
  releaseCodifyLease,
  readActiveLease,
  // Constants exposed for tests + downstream tooling.
  MANDATORY_SCOPE,
  BRANCH_PREFIX,
  LEASE_FILE,
  // Test-only — NOT part of the supported API.
  _test_scopeFingerprint: _scopeFingerprint,
  _test_sortDedupRel: _sortDedupRel,
};
