/**
 * adjacency.js — §4.1 adjacency relation (SAME / ADJACENT / INDEPENDENT).
 *
 * Pure-function relation predicates consumed by `adjacency-leasecheck.js`
 * (B1's pre-tool-use hook) and `/claim` / `/claims` (M3 B3b's commands).
 *
 * Per architecture v11 §4.1:
 *
 *   SAME iff ANY of:
 *     (a) exact path/glob match
 *     (b) an active dir/glob/workspace claim contains the candidate path
 *     (c) same-commit cohort (last 200 commits, cached) — intersection of
 *         the candidate's recent-commits set with the granted claim's
 *         cohort_commits snapshot
 *     (d) phase collision (same /todos / /implement / /redteam phase
 *         against the same artifact dir / glob / path)
 *     (e) composed-invariant collision (an otherwise-ADJACENT load-bearing
 *         pair sharing an axis-3 cohort → promoted to SAME)
 *
 *   ADJACENT iff (not SAME, AND any of):
 *     (f) same dir
 *     (g) same workspace (both under workspaces/<name>/)
 *     (h) parent-child within 1 level
 *     (i) same journal thread (both touch journal/NNNN-*.md with same NNNN
 *         OR adjacent NNNN)
 *
 *   INDEPENDENT otherwise.
 *
 * § F2-2 RESIDUAL — surfaced-not-eliminated (per R5-A-08).
 *
 * Adjacency is evaluated at CLAIM TIME against the candidate path; a
 * granted claim's `cohort_commits` is the snapshot at claim time. This
 * module MUST NOT re-evaluate already-granted claims when the cohort
 * window slides forward — there is no API for that, deliberately. The
 * "cohort window slide" failure mode is a §4.5 residual: a claim granted
 * at seq=100 may become SAME-conflicting at seq=300 if the cohort window
 * slides; the substrate detects-not-prevents. Promotion (predicate (e))
 * is evaluated at the SAME claim-time moment as the base predicates; it
 * does not re-fire on subsequent folds. The same window-slide failure
 * mode applies to promotion as to base SAME predicates.
 *
 * The structural surfacing is the ABSENCE of any
 * `reEvaluateGrantedClaims` / `recomputeOnSlide` / `refoldGrantedClaim`
 * export. Future hook authors who reach for that surface get `undefined`
 * — a loud signal that the residual is intentional.
 *
 * Active-claim object shape (consumed but not constructed here):
 *   {
 *     claim_id:        string,              // surfaced in hook output
 *     verified_id:     string,              // signing-key fingerprint
 *     person_id:       string,              // unit of authority (§2.1)
 *     display_id:      string,              // human-readable surface
 *     path:            string | null,       // exact path claimed
 *     glob:            string | null,       // glob (e.g. "src/**\/*.js")
 *     dir:             string | null,       // dir prefix claimed
 *     workspace:       string | null,       // workspace name (under
 *                                            //   workspaces/<name>/)
 *     phase:           string | null,       // "todos" / "implement" /
 *                                            //   "redteam"
 *     cohort_commits:  string[] | null,     // snapshot at claim time
 *     granted_at_seq:  number,              // per-emitter seq at grant
 *   }
 *
 * The caller is responsible for filtering to ACTIVE claims (the engine's
 * rule-7 isClaimActive predicate) and for excluding the operator's own
 * claims (verified_id != self) BEFORE invoking this module's predicates.
 */

"use strict";

const path = require("path");

// ---------------------------------------------------------------------------
// Helpers — pure path arithmetic on POSIX-style paths.
// Inputs may be absolute (workspace-rooted) or relative; the relation is
// purely structural over the string form.

/** Normalize forward-slashes; strip leading "./". */
function _norm(p) {
  if (typeof p !== "string") return "";
  let s = p.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

/** Posix-style dirname. */
function _dir(p) {
  const norm = _norm(p);
  const i = norm.lastIndexOf("/");
  return i < 0 ? "" : norm.slice(0, i);
}

/**
 * True iff `pathA` lies under `dirB` (or equals dirB exactly).
 * `dirB` is a directory prefix; "src/lib" contains "src/lib/foo.js" but
 * NOT "src/lib2/foo.js".
 */
function _dirContains(dirB, pathA) {
  const a = _norm(pathA);
  const d = _norm(dirB);
  if (d.length === 0) return true; // root contains everything
  return a === d || a.startsWith(d + "/");
}

/**
 * Match a candidate path against a single-line glob (POSIX style with
 * `*` and `**`). Conservative implementation suitable for claim-glob
 * shapes (e.g. "src/lib/*.js", "src/**\/*.js"). Returns boolean.
 */
function _globMatch(glob, candidate) {
  const g = _norm(glob);
  const c = _norm(candidate);
  // Convert glob to a regex. `**` → ".*", `*` → "[^/]*", escape regex meta.
  // First mark `**` with sentinel.
  const SENTINEL_DSTAR = "";
  const SENTINEL_SSTAR = "";
  let pattern = g
    .replace(/\*\*/g, SENTINEL_DSTAR)
    .replace(/\*/g, SENTINEL_SSTAR);
  pattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  pattern = pattern
    .split(SENTINEL_DSTAR)
    .join(".*")
    .split(SENTINEL_SSTAR)
    .join("[^/]*");
  const re = new RegExp("^" + pattern + "$");
  return re.test(c);
}

/**
 * Extract the workspace name from a path of shape
 * `workspaces/<name>/...`. Returns null if not under workspaces/.
 */
function _workspaceOf(p) {
  const norm = _norm(p);
  const m = norm.match(/^workspaces\/([^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

/**
 * Extract the journal NNNN slot from a path of shape
 * `journal/NNNN-*.md` (or `workspaces/<name>/journal/NNNN-*.md`).
 * Returns the slot as an integer or null if no journal slot detected.
 */
function _journalSlotOf(p) {
  const norm = _norm(p);
  const m = norm.match(/(?:^|\/)journal\/(\d+)[-_./]/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Set-intersection over two arrays (cheap; cohort_commits is ~200 max). */
function _intersects(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length === 0 || b.length === 0) return false;
  const setB = new Set(b);
  for (const x of a) if (setB.has(x)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// SAME predicate
// ---------------------------------------------------------------------------

/**
 * Test SAME predicate (a) — exact path/glob match against ONE claim.
 * Returns the matched predicate name, or null.
 */
function _matchExactOrGlob(claim, candidatePath) {
  const c = _norm(candidatePath);
  if (claim.path && _norm(claim.path) === c) return "exact";
  if (claim.glob && _globMatch(claim.glob, c)) return "glob";
  return null;
}

/**
 * Test SAME predicate (b) — active dir/workspace claim contains the path.
 * Returns predicate name, or null.
 */
function _matchContainer(claim, candidatePath) {
  if (claim.dir && _dirContains(claim.dir, candidatePath))
    return "dir-contains";
  if (claim.workspace) {
    const ws = _workspaceOf(candidatePath);
    if (ws && ws === claim.workspace) return "workspace";
  }
  return null;
}

/**
 * Test SAME predicate (c) — same-commit cohort intersection.
 * Returns predicate name, or null.
 */
function _matchCommitCohort(claim, opts) {
  if (
    Array.isArray(claim.cohort_commits) &&
    claim.cohort_commits.length > 0 &&
    Array.isArray(opts.candidateCommits) &&
    _intersects(claim.cohort_commits, opts.candidateCommits)
  ) {
    return "commit-cohort";
  }
  return null;
}

/**
 * Test SAME predicate (d) — phase collision against same artifact.
 * Phase collision fires when the claim's phase matches opts.phase AND
 * the claim's locus (path/glob/dir/workspace) covers the candidate.
 */
function _matchPhaseCollision(claim, candidatePath, opts) {
  if (!claim.phase || !opts.phase || claim.phase !== opts.phase) return null;
  // Phase collision presupposes the locus overlaps. Treat any locus
  // overlap (exact / glob / dir-contains / workspace) as the artifact
  // boundary the phase collides on.
  if (_matchExactOrGlob(claim, candidatePath)) return "phase";
  if (_matchContainer(claim, candidatePath)) return "phase";
  return null;
}

/**
 * Test SAME predicate (e) — composed-invariant collision: an otherwise-
 * ADJACENT pair sharing an axis-3 cohort is promoted to SAME.
 *
 * Per §4.1: promotion narrows F2-2, does not close it; evaluated at
 * claim time.
 */
function _matchComposedInvariant(claim, candidatePath, opts) {
  // The pair must be ADJACENT (one of the four ADJACENT predicates) AND
  // share an axis-3 cohort (commit-cohort intersection).
  if (_matchCommitCohort(claim, opts) !== "commit-cohort") return null;
  // Now check ADJACENT (same dir / workspace / parent-child / journal).
  const adjPred = _matchAdjacentPred(claim, candidatePath);
  if (adjPred) return "composed-axis-3";
  return null;
}

/**
 * Public: does the candidate path SAME-conflict with any active claim?
 */
function isSame(candidatePath, activeClaims, opts) {
  return sameReason(candidatePath, activeClaims, opts).matched === true;
}

/**
 * Public: structured SAME reason. Returns
 *   { matched: true, claim_id, predicate, sibling_display_id, sibling_person_id }
 * on match; { matched: false } otherwise.
 *
 * Caller is responsible for pre-filtering activeClaims (engine rule-7
 * isClaimActive + own-claim exclusion).
 */
function sameReason(candidatePath, activeClaims, opts) {
  const o = opts || {};
  if (!Array.isArray(activeClaims) || activeClaims.length === 0) {
    return { matched: false };
  }
  for (const claim of activeClaims) {
    if (!claim || typeof claim !== "object") continue;
    const pred =
      _matchExactOrGlob(claim, candidatePath) ||
      _matchContainer(claim, candidatePath) ||
      _matchCommitCohort(claim, o) ||
      _matchPhaseCollision(claim, candidatePath, o) ||
      _matchComposedInvariant(claim, candidatePath, o);
    if (pred) {
      return {
        matched: true,
        claim_id: claim.claim_id || null,
        predicate: pred,
        sibling_display_id: claim.display_id || null,
        sibling_person_id: claim.person_id || null,
        sibling_verified_id: claim.verified_id || null,
      };
    }
  }
  return { matched: false };
}

// ---------------------------------------------------------------------------
// ADJACENT predicate
// ---------------------------------------------------------------------------

/**
 * Private: return ADJACENT predicate name for a single claim, or null.
 * Used by both `adjacentReason` and `_matchComposedInvariant`.
 */
function _matchAdjacentPred(claim, candidatePath) {
  const cDir = _dir(candidatePath);
  // (i') Check journal-thread FIRST when both paths name a journal slot:
  // a journal slot is the most-specific same-thread signal and dominates
  // the same-dir match that would otherwise fire for any two files under
  // `journal/`. Order resolves the "both predicates apply" ambiguity in
  // favor of the most-specific descriptor.
  const candSlot = _journalSlotOf(candidatePath);
  if (candSlot !== null && claim.path) {
    const claimSlot = _journalSlotOf(claim.path);
    if (claimSlot !== null && Math.abs(claimSlot - candSlot) <= 1) {
      return "same-journal-thread";
    }
  }
  // (f) same dir — claim has a `path` (or `dir`) whose dirname equals the
  // candidate's dirname.
  if (claim.path) {
    const claimDir = _dir(claim.path);
    if (claimDir === cDir && claimDir.length > 0) return "same-dir";
  }
  if (claim.dir) {
    const claimDir = _norm(claim.dir);
    if (claimDir === cDir && claimDir.length > 0) return "same-dir";
  }
  // (g) same workspace — both under workspaces/<name>/.
  const candWs = _workspaceOf(candidatePath);
  if (candWs && claim.path) {
    const claimWs = _workspaceOf(claim.path);
    if (claimWs && claimWs === candWs) return "same-workspace";
  }
  if (candWs && claim.dir) {
    const claimWs = _workspaceOf(claim.dir);
    if (claimWs && claimWs === candWs) return "same-workspace";
  }
  // (h) parent-child within 1 level — claim's path/dir is one level above
  // or below the candidate's dir.
  if (claim.path) {
    const claimDir = _dir(claim.path);
    if (claimDir.length > 0) {
      if (_dir(cDir) === claimDir) return "parent-child";
      if (_dir(claimDir) === cDir && cDir.length > 0) return "parent-child";
    }
  }
  if (claim.dir) {
    const claimDir = _norm(claim.dir);
    if (claimDir.length > 0) {
      if (_dir(cDir) === claimDir) return "parent-child";
      if (_dir(claimDir) === cDir && cDir.length > 0) return "parent-child";
    }
  }
  // (i) same journal thread is handled at the top of this function (the
  // most-specific descriptor wins per the comment block above).
  return null;
}

/**
 * Public: does the candidate path ADJACENT-conflict with any active
 * claim? Caller MUST pre-check isSame; ADJACENT is "not SAME, and ...".
 */
function isAdjacent(candidatePath, activeClaims, opts) {
  return adjacentReason(candidatePath, activeClaims, opts).matched === true;
}

/**
 * Public: structured ADJACENT reason.
 */
function adjacentReason(candidatePath, activeClaims, opts) {
  // Suppress an ADJACENT report when the SAME relation fires — SAME
  // dominates per §4.1 ("not SAME, AND any of ...").
  if (sameReason(candidatePath, activeClaims, opts).matched) {
    return { matched: false };
  }
  if (!Array.isArray(activeClaims) || activeClaims.length === 0) {
    return { matched: false };
  }
  for (const claim of activeClaims) {
    if (!claim || typeof claim !== "object") continue;
    const pred = _matchAdjacentPred(claim, candidatePath);
    if (pred) {
      return {
        matched: true,
        claim_id: claim.claim_id || null,
        predicate: pred,
        sibling_display_id: claim.display_id || null,
        sibling_person_id: claim.person_id || null,
        sibling_verified_id: claim.verified_id || null,
      };
    }
  }
  return { matched: false };
}

// ---------------------------------------------------------------------------
// Module exports
//
// NOTE — F2-2 residual surfacing: NO `reEvaluateGrantedClaims` /
// `recomputeOnSlide` / `refoldGrantedClaim` export exists. Future hook
// authors who reach for re-evaluation get undefined — the structural
// signal that the residual is intentional per R5-A-08.
// ---------------------------------------------------------------------------

module.exports = {
  isSame,
  sameReason,
  isAdjacent,
  adjacentReason,
  // Internal helpers exposed for testing only. NOT part of the supported
  // API; callers MUST use the four predicates above.
  _internal: {
    _norm,
    _dir,
    _dirContains,
    _globMatch,
    _workspaceOf,
    _journalSlotOf,
    _intersects,
    _matchAdjacentPred,
  },
};
