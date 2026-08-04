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
 *     `reclaimed` (2026-08-04) is present ONLY when this acquire took over a
 *     lease the TTL classifier found STALE — it names the previous holder, the
 *     liveness basis, and the `record_emit` of the paired stale-takeover
 *     record. Callers MUST surface it; see § liveness/TTL below.
 *     A conflict result additionally carries `liveness` (why the lease was
 *     judged still HELD).
 *
 *   releaseCodifyLease({ repoDir?, displayId }) -> { ok, error? }
 *     The leasePath is derived from repoDir via _leasePath(_gitToplevel(repoDir))
 *     so the release path mirrors acquireCodifyLease (Sec-MED-3): callers cannot
 *     misroute the release write to another file under .claude/learning/.
 *
 *   readActiveLease(repoDir?) -> { lease | null, liveness?, stale? }
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
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env");
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

// ---- liveness / TTL ---------------------------------------------------------
//
// THE DEFECT (loom, session 9, 2026-08-04): the conflict predicate was
// `if (existing && !existing._released)` and nothing else. There is no
// SessionEnd auto-release for the codify lease (unlike claims — grep
// multi-operator-sessionend.js: it releases claims, never this lease), so the
// ONLY thing that clears it is an in-session `releaseCodifyLease` call. A
// session that crashes, is killed, or is `/clear`ed between Step 0 and release
// therefore leaves a lease that blocks EVERY subsequent /codify in the repo
// FOREVER, with no self-healing path. Observed live: one such orphan silently
// blocked an OWED /journal and had to be cleared by hand.
//
// WHAT LIVENESS SIGNAL IS ACTUALLY AVAILABLE (instrument-discipline.md MUST-1 —
// name the falsifying result before citing a check as evidence):
//
//   `lease.pid` — NOT USABLE, in EITHER direction. The recorded pid is
//   `process.pid` of the process that CALLED acquireCodifyLease, and per
//   commands/codify.md Step 0 that caller is a transient `node -e` helper the
//   agent runs and which exits milliseconds later. The holding "session" is a
//   Claude Code session, not that process. Measured, not derived:
//
//       $ node -e 'const{execFileSync}=require("child_process");
//         const pid=Number(execFileSync(process.execPath,["-e",
//           "process.stdout.write(String(process.pid))"],{encoding:"utf8"}));
//         try{process.kill(pid,0);console.log("ALIVE")}
//         catch(e){console.log("DEAD("+e.code+")")}'
//       DEAD(ESRCH)
//
//   `process.kill(pid, 0)` therefore returns ESRCH for a HEALTHY lease taken
//   one second ago exactly as it does for a lease orphaned by a crash. It
//   produces the SAME result under both branches of the hypothesis, so it
//   carries zero information and is not evidence of anything. Reclaiming on it
//   would drop mutual exclusion for every lease in the repo. It is not used
//   here, and a future edit MUST NOT reintroduce it without first changing WHO
//   writes the pid.
//
//   A pid is additionally meaningless on a host other than the one that wrote
//   it, and this file carries no host identity to test that with. That is a
//   second, independent reason — but the first one alone is disqualifying.
//
//   Coordination-log heartbeats (the §4.4 reap protocol's signal, 20-min
//   LIVENESS_TTL) WOULD discriminate — but only when coordination is ENABLED
//   (a solo repo emits none), and they are keyed by `verified_id` while this
//   lease records `display_id`, so consuming them means resolving the roster
//   from inside the mutex. Deliberately NOT done here: on a coordination-off
//   repo the absence of heartbeats is indistinguishable from a dead holder,
//   which is precisely the non-discriminating shape rejected above.
//
// WHAT IS LEFT: elapsed wall-clock since `acquired_at`. It is the only signal
// this record actually carries that differs between a fresh lease and an
// abandoned one. So the TTL is the sole reclaim trigger.
//
// THE FLOOR — 12 hours. A codify lease is session-scoped: acquired at Step 0,
// released at end of session after the PR admin-merges. The floor has to exceed
// the longest plausible single /codify session (loom's are multi-hour waves,
// not multi-day) while still self-healing without human intervention. 12h
// clears a full working day of continuous codify work and still unblocks the
// next morning's session. Shorter (1h) would steal a live lease from a long
// wave; longer (72h) reproduces the "blocks forever" complaint in slow motion.
// A lease held longer than 12h whose holder never released is, by construction,
// not an in-flight codify.
//
// FAIL-CLOSED ON AMBIGUITY: an unparseable or MISSING `acquired_at`, and a
// future-dated one (clock skew, or a forged record), all yield age =
// INDETERMINATE and the lease is treated as HELD. Only a positively-computed
// age at or past the floor reclaims.
const LEASE_TTL_MS = 12 * 60 * 60 * 1000;

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

// loom#1471 shard 2. `_gitToplevel` is the FIRST call in acquireCodifyLease, and
// its result is passed to _leasePath (where the lease is WRITTEN),
// _gitStatusPorcelain (the scope-dirtiness gate) and _gitCurrentBranch (the
// branch the lease binds to). Steering it therefore re-anchors the whole lease
// operation into an attacker's repo — measured, not derived (test S2-T1). Shard
// 1's state-resolver fix does NOT cover this: _leasePath receives the ALREADY
// steered topLevel. git is invoked by absolute path with an env built from
// constants, so neither PATH, GIT_DIR nor GIT_WORK_TREE reaches the child.
//
// Unresolvable git returns null here, which every caller already treats as
// "not-a-git-repo" and REFUSES on — fail-closed, the pre-existing disposition.
function _gitToplevel(repoDir) {
  try {
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    return execFileSync(gitBin, ["rev-parse", "--show-toplevel"], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    }).trim();
  } catch (e) {
    return null;
  }
}

function _gitCurrentBranch(repoDir) {
  try {
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    return execFileSync(gitBin, ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    }).trim();
  } catch (e) {
    return null;
  }
}

function _gitStatusPorcelain(repoDir, files) {
  // Returns the porcelain lines limited to the named files. Empty array = clean.
  //
  // NOTE the config dimension (loom#1471 shard 2, measured): gitEnv() sets
  // GIT_CONFIG_GLOBAL=/dev/null, so a global `core.excludesFile` no longer
  // suppresses matching paths and status can report MORE entries than before.
  // Direction is fail-CLOSED for this caller — more reported entries means the
  // lease REFUSES on scope dirtiness more readily, never less.
  const args = ["status", "--porcelain=v1", "--"].concat(files);
  const gitBin = resolveGitBinary();
  if (!gitBin) {
    return { ok: false, error: "git binary unresolved" };
  }
  const r = spawnSync(gitBin, args, {
    cwd: repoDir,
    encoding: "utf8",
    env: gitEnv(),
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
 * Classify an on-disk, un-released lease as HELD or STALE.
 *
 * Returns { state, age_ms, ttl_ms, basis } where:
 *   state ∈ "held" | "stale"
 *   age_ms   number when positively computed, else null (indeterminate)
 *   basis    a verbatim, quotable sentence naming WHY — it goes into the
 *            conflict error, the reclaim record and the on-disk
 *            `reclaimed_from` evidence, so a human reading any of the three
 *            sees the same reason.
 *
 * The ONLY transition to "stale" is a positively-computed age >= ttlMs. Every
 * other path — no timestamp, unparseable timestamp, future-dated timestamp —
 * returns "held". See § liveness/TTL above for why `lease.pid` is not consulted.
 */
function _classifyLeaseLiveness(lease, nowMs, ttlMs) {
  const ttl = typeof ttlMs === "number" ? ttlMs : LEASE_TTL_MS;
  const raw = lease && lease.acquired_at;
  if (typeof raw !== "string" || !raw) {
    return {
      state: "held",
      age_ms: null,
      ttl_ms: ttl,
      basis:
        "lease carries no acquired_at timestamp — age is INDETERMINATE, so the lease is treated as HELD (fail-closed)",
    };
  }
  const acquiredMs = Date.parse(raw);
  if (!Number.isFinite(acquiredMs)) {
    return {
      state: "held",
      age_ms: null,
      ttl_ms: ttl,
      basis:
        `lease acquired_at '${raw}' is unparseable — age is INDETERMINATE, ` +
        "so the lease is treated as HELD (fail-closed)",
    };
  }
  const age = nowMs - acquiredMs;
  if (age < 0) {
    return {
      state: "held",
      age_ms: null,
      ttl_ms: ttl,
      basis:
        `lease acquired_at '${raw}' is in the FUTURE relative to this clock ` +
        `(by ${-age}ms) — age is INDETERMINATE (clock skew or a forged record), ` +
        "so the lease is treated as HELD (fail-closed)",
    };
  }
  if (age >= ttl) {
    return {
      state: "stale",
      age_ms: age,
      ttl_ms: ttl,
      basis:
        `lease has been held for ${age}ms since ${raw}, at or past the ` +
        `${ttl}ms staleness floor, and no session released it — reclaimable`,
    };
  }
  return {
    state: "held",
    age_ms: age,
    ttl_ms: ttl,
    basis: `lease is ${age}ms old, within the ${ttl}ms staleness floor — HELD`,
  };
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

  // A lease that is present and un-released is HELD unless it is positively
  // shown STALE by the TTL classifier (§ liveness/TTL above). `reclaimed` stays
  // null on the normal path; when a stale lease IS reclaimed it carries the
  // evidence forward into the new lease record, the signed coordination-log
  // record, and the acquire result — a reclaim is never silent.
  let reclaimed = null;
  if (existing && !existing._released) {
    const liveness = _classifyLeaseLiveness(existing, Date.now(), LEASE_TTL_MS);
    if (liveness.state !== "stale") {
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
            : "Scope is disjoint, but only one /codify lease is active at a time per repo.") +
          ` Liveness: ${liveness.basis}.`,
        conflicting: {
          display_id: existing.display_id,
          acquired_at: existing.acquired_at,
          scope: existing.scope,
          branch: existing.branch,
          lease_id: existing.lease_id,
          pid: existing.pid,
        },
        liveness,
      };
    }
    // STALE — reclaim. This is a coordination event, not a quiet retry: the
    // previous holder's session may still believe it owns the scope. Everything
    // needed to attribute the takeover is captured here and surfaced three ways
    // below (result field, on-disk lease, signed record).
    reclaimed = {
      lease_id: existing.lease_id || null,
      display_id: existing.display_id || null,
      acquired_at: existing.acquired_at || null,
      branch: existing.branch || null,
      scope: existing.scope || null,
      pid: existing.pid === undefined ? null : existing.pid,
      liveness,
      reclaimed_at: _isoTimestamp(),
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
  if (reclaimed) {
    // Durable on-disk evidence of the takeover. This is the ONLY reclaim record
    // that survives on a coordination-DISABLED repo (the signed record below is
    // gated on coordination, symmetric with the normal acquire), and it is what
    // readActiveLease surfaces to /onboard. Never omit it.
    lease.reclaimed_from = reclaimed;
  }

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

  // Stale-takeover visibility. The orphaned lease is closed out in the fold with
  // the SAME registered record type its holder would have used
  // (`codify-lease-release`, registered in coordination-log.js
  // ::_registerM0Defaults) so the orphan's `codify-lease` acquire record does not
  // dangle unpaired forever — a minted `codify-lease-steal` type is NOT in that
  // registry and every fold would reject it. `action: "reclaim-stale"`
  // distinguishes it from a holder's own release, and `reclaimed_by` +
  // `liveness_basis` name who took it and on what evidence. Emitted BEFORE the
  // acquire record so the log reads release-then-acquire in causal order.
  // Emission failure is NON-FATAL for the same reason it is on the normal
  // acquire path (the on-disk mutex already landed) and is surfaced verbatim
  // under `reclaimed.record_emit`.
  if (reclaimed) {
    reclaimed.record_emit = isCoordinationEnabled(coordRoot)
      ? _emitLeaseRecord(
          coordRoot,
          "codify-lease-release",
          {
            lease_id: reclaimed.lease_id,
            released_at: reclaimed.reclaimed_at,
            action: "reclaim-stale",
            reclaimed_by: displayId,
            reclaimed_from_display_id: reclaimed.display_id,
            original_acquired_at: reclaimed.acquired_at,
            age_ms: reclaimed.liveness.age_ms,
            ttl_ms: reclaimed.liveness.ttl_ms,
            liveness_basis: reclaimed.liveness.basis,
            successor_lease_id: leaseId,
          },
          o,
        )
      : { ok: true, skipped: true, reason: "coordination-disabled" };
  }

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

  const result = {
    ok: true,
    lease,
    branch,
    leasePath,
    scope,
    record_emit: recordEmit,
  };
  // Callers MUST surface this verbatim when present (commands/codify.md Step 0):
  // it means this session took a lease another operator's session had not
  // released. Present only on a takeover — absent on every normal acquire.
  if (reclaimed) result.reclaimed = reclaimed;
  return result;
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
  // The lease is still on disk and un-released, so it is still returned as the
  // active lease — but a reader (/onboard's Codify Lease section per
  // knowledge-convergence.md MUST-5) must be able to tell a lease that will
  // block from one the next acquire will reclaim. `stale` is additive; `lease`
  // is unchanged.
  const liveness = _classifyLeaseLiveness(existing, Date.now(), LEASE_TTL_MS);
  return {
    lease: existing,
    leasePath: lp,
    liveness,
    stale: liveness.state === "stale",
  };
}

module.exports = {
  acquireCodifyLease,
  releaseCodifyLease,
  readActiveLease,
  // Constants exposed for tests + downstream tooling.
  MANDATORY_SCOPE,
  BRANCH_PREFIX,
  LEASE_FILE,
  LEASE_TTL_MS,
  // Test-only — NOT part of the supported API.
  _test_scopeFingerprint: _scopeFingerprint,
  _test_sortDedupRel: _sortDedupRel,
  _test_classifyLeaseLiveness: _classifyLeaseLiveness,
};
