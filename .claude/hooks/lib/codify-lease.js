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
 *     `degraded` (2026-08-16) is present IFF the record did NOT emit. `ok`
 *     describes THE LEASE — which held, on disk, atomically; `degraded`
 *     describes the CAPABILITY that did not — cross-clone visibility. It also
 *     goes to stderr as `[LEASE-RECORD-NOT-EMITTED]` the moment it happens, so
 *     the failure does not depend on anyone choosing to inspect a return value.
 *     `degraded.structural: true` means it will fail identically on retry.
 *     See `_describeRecordEmitFailure` for why this is loud but not fatal.
 *
 *     `owner_axis` (2026-08-21) names which identity axis this lease's ownership
 *     is decided on — "person_id" | "verified_id" | "display_id" — and is also
 *     recorded on the lease. `identity_error` is present ONLY when identity
 *     resolution THREW (distinct from a repo that has no identity to resolve);
 *     callers MUST surface it. See § ownership axis.
 *
 *   releaseCodifyLease({ repoDir?, displayId }) -> { ok, error? }
 *     A `wrong-owner` refusal carries `owner_axis` + `caller_axis_present`:
 *     `caller_axis_present: false` means the caller could not produce the axis
 *     the record declares (INDETERMINATE — fix your identity), NOT that the
 *     lease belongs to someone else.
 *     UNLIKE the acquire path, the signed `codify-lease-release` emit is
 *     FATAL here (loom#1881): that record IS the revocation the integrity
 *     fence reads, so a release whose record did not land has not released
 *     anything. The emit runs BEFORE the on-disk write and a failure returns
 *     `{ok:false, reason:"release-record-emit-failed", record_emit}` with the
 *     on-disk lease UNTOUCHED — still HELD, still authorizing, and retryable.
 *     Leaving it released locally while the log still granted was a split only
 *     the fence could see.
 *     The leasePath is derived from repoDir via _leasePath(_gitToplevel(repoDir))
 *     so the release path mirrors acquireCodifyLease (Sec-MED-3): callers cannot
 *     misroute the release write to another file under .claude/learning/.
 *
 *   readActiveLease(repoDir?) -> { lease | null, liveness?, stale?,
 *                                  record_emitted?, degraded? }
 *     `record_emitted: false` + a typed `degraded` mean the lease IS held but
 *     its signed coordination-log record never landed, so no sibling clone can
 *     see it. Read from the lease FILE, so unlike the acquire-time `degraded`
 *     it survives a /clear, a compaction, and a different operator. Legibility
 *     only: the grant lives in the folded log, which findCoveringLease reads
 *     and this file is not.
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
// `isGovernanceEnabled`, NOT `isCoordinationEnabled` (2026-08-29). The lease
// RECORD is consumed by integrity-guard.js, which fences journal/ + team-memory/
// + the state files on GOVERNANCE — deliberately so, since keying that fence on
// coordination "silently disarmed the whole fence" (integrity-guard.js § header).
// Emitting on the coordination axis while the guard enforces on the governance
// axis is ONE contract read through TWO predicates, and on an `enrolled-solo`
// repo they disagree: governance ON, coordination OFF => the guard demands a
// covering record that the acquire path never wrote, so every journal write is
// refused with a remediation (/codify Step 0) that provably cannot clear it.
// `governanceMode` already draws the line this emission wants: coordination-ON
// and `enrolled-solo` both yield governance ON, while a genuinely fresh
// unenrolled repo (`default-off`) yields OFF and still skips — so the MO-OPT W1
// protected case keeps its silence and needs no signing key.
const { isGovernanceEnabled } = require("./coordination-mode.js");
// Ownership axis (see § ownership axis below). operator-id.js requires only
// fs/path/child_process/coordination-mode, so this is not a require cycle —
// nothing it pulls reaches back here (integrity-guard.js is the only module
// that requires THIS one, and it does so lazily).
const { resolveIdentity } = require("./operator-id.js");

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
//   (a solo repo emits none). Deliberately NOT consumed here: on a
//   coordination-off repo the absence of heartbeats is indistinguishable from a
//   dead holder, which is precisely the non-discriminating shape rejected above.
//
//   CORRECTION (2026-08-21, the ownership-axis change below). This paragraph
//   used to carry a SECOND reason — that heartbeats "are keyed by `verified_id`
//   while this lease records `display_id`, so consuming them means resolving the
//   roster from inside the mutex". That leg is now FALSE: the lease records
//   `verified_id` and `person_id`, and the roster IS resolved from inside the
//   acquire path. It is struck rather than silently left standing. The
//   disposition does NOT change, because the FIRST reason — a solo repo emits no
//   heartbeats, so their absence carries zero information — was always the
//   disqualifying one and is untouched.
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

// ---- ownership axis ---------------------------------------------------------
//
// THE DEFECT (loom, 2026-08-21): both ownership decisions in this module —
// `acquireCodifyLease`'s same-operator classifier and `releaseCodifyLease`'s
// owner fence — read `existing.display_id === displayId` and nothing else.
// `rules/multi-operator-coordination.md` §1 forbids exactly that:
//
//   display_id  — ADVISORY SIGNAGE. Collisions are HARMLESS BY DESIGN.
//                 "Tooling MUST attribute via `verified_id`, NEVER `display_id`."
//   verified_id — a commit-signing-key fingerprint; authenticates a RECORD.
//   person_id   — THE UNIT OF AUTHORITY (one person_id → one human → role + keys).
//
// A concurrency primitive keyed on signage fails in BOTH directions, and both
// were reproduced before the fix (tests/integration/multi-operator/
// codify-lease-identity-axis.test.js):
//
//   FALSE POSITIVE — two humans sharing a display_id each own the other's lease.
//     MEASURED pre-fix: person `pid-b`, signing key SHA256:YtfF0Jid…, released
//     `pid-a`'s lease and emitted the signed `codify-lease-release` record under
//     pid-b's own identity. The mutex reported `ok: true`.
//   FALSE NEGATIVE — ONE human whose display_id resolves differently in a second
//     session (a clone with a different `user.name`, an updated roster entry)
//     cannot release the lease they themselves hold, and must wait out the 12h TTL.
//
// THE PREDICATE: ownership is decided on the strongest axis THE EXISTING RECORD
// DECLARES — person_id, else verified_id, else display_id. Three properties make
// this the right shape rather than a "try each until one matches" fallback chain:
//
//   1. NO FALL-THROUGH ON MISMATCH. Once the declared axis is chosen, a mismatch
//      on it is NOT-OWNER, full stop. Falling through to a weaker axis after a
//      strong mismatch would WIDEN authority — the shape `rules/security.md`
//      § Enforcement-Surface Parity names ("an unrecognized→recognized transition
//      WIDENS and MUST raise").
//   2. FAIL-CLOSED ON AN INDETERMINATE CALLER. A record declaring person_id is
//      NOT released to a caller who cannot produce one. The refusal carries
//      `caller_axis_present: false` so the operator can tell "fix your signing
//      key" from "this lease is not yours" — a distinction the message must make,
//      or the fence is indistinguishable from a lockout.
//   3. BACK-COMPAT IS STRUCTURAL, NOT A CARVE-OUT. A pre-fix lease (`_version: 1`)
//      names no person and no key, so display_id is the strongest axis it
//      declares and it keeps deciding on display_id — the pre-fix behavior,
//      verbatim. There is NO migration step and no re-keying: a v1 record cannot
//      be re-attributed after the fact without inventing an owner. A LIVE lease
//      existed on this repo when this landed (`lease_1787203809129_57ee6647`,
//      display_id `<operator>`, `_version: 1`), and a fix that wedges an
//      already-held lease is worse than the defect it closes.
//      The same clause covers a SOLO / coordination-OFF repo permanently: there
//      person_id is null by construction (`operator-id.js::_soloIdentity`), so
//      new leases there also declare only signage. That is not degradation — a
//      solo repo has one operator, and the record SAYS which axis it decided on.
//
// display_id is still RECORDED and still DISPLAYED in every operator-facing
// message and every emitted record (`knowledge-convergence.md` MUST-3 requires
// the conflicting display_id verbatim). Only the DECISION moved.
const OWNER_AXES = Object.freeze(["person_id", "verified_id", "display_id"]);

function _nonEmptyString(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * The identity triple this module decides ownership with.
 *
 * `o.identity` when the caller supplied one (the seam the multi-operator test
 * fixtures use to simulate two persons in one process), else resolved from the
 * coordination root. Resolution mirrors `coc-emit.js::emitSignedRecord`
 * EXACTLY — same source, same `resolveIdentity(root, {})` argument shape — so
 * the identity the lease is OWNED by is the identity the lease record is SIGNED
 * by. Diverging here would let a lease be owned by one operator and signed by
 * another, and `integrity-guard.js::findCoveringLease` authorizes on the SIGNER.
 *
 * Resolution failure is NON-FATAL and NEVER a silent fallback: the axes come
 * back null (so the record declares `display_id` and says so), and the reason is
 * returned under `error` for the caller to surface, on the same disposition the
 * record-emit path already takes. Refusing the lease because a roster is absent
 * would block solo /codify entirely.
 */
function _resolveOwnerIdentity(coordRoot, o) {
  if (o && o.identity && typeof o.identity === "object") {
    return {
      person_id: _nonEmptyString(o.identity.person_id),
      verified_id: _nonEmptyString(o.identity.verified_id),
      display_id: _nonEmptyString(o.identity.display_id),
      source: "supplied",
      error: null,
    };
  }
  let resolved;
  try {
    resolved = resolveIdentity(coordRoot, {});
  } catch (err) {
    return {
      person_id: null,
      verified_id: null,
      display_id: null,
      source: "unresolved",
      error: `identity resolution threw: ${err && err.message ? err.message : String(err)}`,
    };
  }
  return {
    person_id: _nonEmptyString(resolved && resolved.person_id),
    verified_id: _nonEmptyString(resolved && resolved.verified_id),
    display_id: _nonEmptyString(resolved && resolved.display_id),
    source: "resolved",
    error: null,
  };
}

/**
 * The strongest ownership axis an EXISTING lease record declares.
 *
 * Returns null when the record declares none — which for a record this module
 * wrote is impossible (display_id is validated non-empty before the write), so
 * null means a hand-crafted or truncated lease file. Every caller treats null as
 * NOT-OWNER, preserving the pre-fix verdict for that shape (`undefined !== "alice"`
 * refused too).
 */
function _declaredOwnerAxis(lease) {
  if (!lease || typeof lease !== "object") return null;
  for (const axis of OWNER_AXES) {
    if (_nonEmptyString(lease[axis])) return axis;
  }
  return null;
}

/**
 * Decide whether `caller` is the owner of `existing`.
 *
 * @returns {{same: boolean, axis: string|null, caller_axis_present: boolean,
 *            basis: string}}
 *   `basis` is a verbatim, quotable sentence — it goes into the conflict
 *   message, the wrong-owner error, and the on-disk/record attribution, so a
 *   human reading any of the three sees the same reason.
 */
function _ownerVerdict(existing, caller) {
  const axis = _declaredOwnerAxis(existing);
  if (!axis) {
    return {
      same: false,
      axis: null,
      caller_axis_present: false,
      basis:
        "the lease record declares NO identity axis (no person_id, no verified_id, " +
        "no display_id) — ownership is INDETERMINATE, so the caller is treated as " +
        "NOT the owner (fail-closed)",
    };
  }
  const recorded = _nonEmptyString(existing[axis]);
  const presented = _nonEmptyString(caller && caller[axis]);
  if (!presented) {
    return {
      same: false,
      axis,
      caller_axis_present: false,
      basis:
        `the lease declares its owner by ${axis} (${recorded}) and this caller ` +
        `presents no ${axis} — ownership is INDETERMINATE, so the caller is ` +
        `treated as NOT the owner (fail-closed). A weaker axis is deliberately ` +
        `NOT consulted: falling back to display_id here would let signage ` +
        `override authority, which is the defect this predicate exists to close`,
    };
  }
  if (recorded === presented) {
    return {
      same: true,
      axis,
      caller_axis_present: true,
      basis: `caller matches the lease's declared owner on ${axis} (${recorded})`,
    };
  }
  return {
    same: false,
    axis,
    caller_axis_present: true,
    basis:
      `caller's ${axis} (${presented}) differs from the lease's declared owner ` +
      `${axis} (${recorded})`,
  };
}

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

// THE JOURNAL DIRECTORIES THIS REPO ACTUALLY HAS, RESOLVED — NEVER HARDCODED.
//
// `/codify` TRIPPED ITS OWN INTEGRITY GUARD ON ITS OWN MANDATED STEP. Step 0
// tells the caller the helper "unions [the two MANDATORY_SCOPE files] into the
// scope automatically" and says nothing about a journal path; `commands/codify.md`
// § "Journal (MUST — phase-complete gate)" then REQUIRES a journal entry before
// `/codify` may be reported complete. A caller following the command LITERALLY
// acquired a lease covering two files and was then halt-and-reported by
// `integrity-guard.js` for the journal write — "no covering codify-lease record
// found in the folded coordination log" — on a step the SAME command mandates.
// The documented workaround (release → widen `scopeFiles` → re-acquire) also hits
// `scope-dirty` once the journal file is already written, forcing a
// remove/re-acquire/re-write dance to make the write genuinely covered rather
// than retroactively blessed.
//
// RESOLVED, NOT HARDCODED, because the journal directory is REPO-LAYOUT-DEPENDENT:
// repo-root `journal/` in some consumers, workspace-scoped
// `workspaces/<name>/journal/` in others, and many repos have both. The shapes
// here are the SAME ones `guard-path-scope.js::JOURNAL_ENTRY_RX` accepts — which
// is what `integrity-guard.js::isWatchedPath` gates on — so the scope covers
// exactly the paths the guard watches, no more and no less. Hardcoding one layout
// would leave the other silently uncovered, which is the defect one repo over.
//
// TRAILING SLASH IS BELT-AND-BRACES HERE, NOT LOAD-BEARING — stated as MEASURED,
// because the first draft of this comment claimed the opposite and was wrong.
// `integrity-guard.js::findCoveringLease` covers a candidate three ways: exact
// match, `s.endsWith("/") && candidate.startsWith(s)`, or a DOT-FREE bare dir
// (`!s.includes(".") && candidate.startsWith(s + "/")`). None of the prefixes
// emitted here contain a dot, so that third clause alone already covers them —
// including `workspaces/<n>/journal/.pending/0001-….md`. Measured: mutating the
// workspace entries to the bare form left both coverage cases GREEN (8/9; only the
// literal-membership case red). The slash is kept because it is the form that stays
// correct if a future journal dir ever DOES contain a dot, at which point the
// third clause stops applying and the second is the only one left.
//
// THE ROOT `journal/` IS UNCONDITIONAL, and that is deliberate rather than a
// hardcode readmitted through the back door: it is the module-level default of
// `journal-reserve.js::reserveJournalSlotSigned` (`opts.dir` defaults to
// "journal"), so a `/codify` CREATING a repo's first journal entry — the case
// where the directory does not exist to be enumerated — must still be covered.
// Workspace journal dirs are enumerated because there is no default to fall back
// on; a workspace created mid-session is the residual, and the caller can still
// pass it explicitly in `scopeFiles`.
//
// BREADTH IS FREE HERE. The lease is a whole-repo mutex — `acquireCodifyLease`
// refuses a second lease whether or not scopes overlap ("only one /codify lease is
// active at a time per repo"), and MANDATORY_SCOPE already guarantees any two
// concurrent /codify runs collide on `.proposals/latest.yaml`. So adding journal
// prefixes cannot introduce a conflict that did not already exist.
//
// ---- 2026-08-16: THE ENUMERATION WAS UNBOUNDED, AND IT BROKE THE RECORD -----
//
// This function USED to `readdirSync(workspaces/)` and emit ONE `workspaces/<n>/
// journal/` entry per workspace. That list is O(number of workspaces), and it
// lands verbatim in `content.scope_files` of the signed `codify-lease`
// coordination-log record — which is capped at MAX_LINE_BYTES (2048 B) by
// `coc-emit.js::_defaultAppend`. REPRODUCED 2026-08-23 end-to-end against the
// real `_defaultAppend` at loom's MAIN-checkout scale — 32 workspace journal
// dirs, 31 of them enumerated (`_template` is `_`-skipped), 34 scope entries:
//
//     record line   2964 B  vs cap 2048 B  → "append refused", step "append"
//     sig            870 B  ← armored GPG, NOT shrinkable here; re-measured as
//                             the median AND max over all 920 signed records in
//                             the live coordination log, so it is a constant
//
// WHICH ACQUIRES THIS KILLED, STATED PRECISELY. An earlier revision of this
// comment said the record "was REFUSED on EVERY acquire". That is FALSE and is
// withdrawn: the live log holds 195 successfully-emitted `codify-lease` records.
// What is true is sharper, and worse to detect. The refusal is a function of the
// ENUMERATED COUNT, which is a function of WHICH CHECKOUT ran /codify:
//
//   main checkout   32 journal dirs → 34 entries → 2964 B → REFUSED, always
//   a worktree      ~11 (most workspace journals are UNTRACKED, so a fresh
//                   worktree materializes few) → ~13 entries → FITS, barely
//
// So /codify from the main checkout NEVER emitted, and /codify from a worktree
// usually did. The log's own histogram is the evidence and also the reason
// nobody noticed: emitted scope_files counts run 2..19 and then STOP DEAD —
// 19 records at 15+, zero above 19. That cliff is not a property of the work,
// it is the cap CENSORING its own audit trail. Every oversized acquire is
// absent from the one surface an investigator would read, so the log looked
// healthy precisely because the failures were invisible in it.
//
// The caller could not fix this either way: an EMPTY `scopeFiles` produced a
// byte-identical record, because the overflow is entirely in the auto-unioned
// scope.
//
// HOW LONG IT HAD BEEN LIVE — measured by replaying the removed enumerator over
// loom's real workspace names at increasing counts: the record crosses 2048 B at
// the TWELFTH enumerated workspace, not at the thirty-first. The failure mode is
// a RATCHET — each new workspace pushed the record further past a cap it had
// already breached, while the API kept returning {ok: true}. The live log's
// largest surviving record is 2036 B against the 2048 B cap: 12 B of headroom,
// i.e. the emitting path was one short workspace name from silence too.
//
// THE FIX IS A BOUNDED PATH-SHAPE, NOT A SNAPSHOT. `workspaces/*/journal/` is a
// single-segment glob that expresses exactly what the enumeration was reaching
// for, in 24 bytes that do not grow with the repo. `integrity-guard.js::
// findCoveringLease` learns the same single-segment `*` in the SAME change (the
// writer/reader pair `security.md` § Enforcement-Surface Parity requires) — it is
// the ONLY reader of `content.scope_files`, verified by grep across
// `.claude/**` (`pre-commit-branch-scope.js` has a similar-looking `isInScope`
// but never reads a lease record).
//
// COVERAGE IS NOW EXACTLY THE WATCHED SURFACE, which is a residual CLOSED rather
// than a widening. `guard-path-scope.js::WATCHED_SUBTREE_RX` watches
// `^workspaces/[^/]+/journal/` with NO `_`-prefix exclusion — so
// `workspaces/_archive/journal/x.md` was WATCHED but, under the old enumerator's
// `e.name.startsWith("_")` skip, could never be COVERED. The glob matches the
// watched regex segment-for-segment: `[^/]+` there, `[^/]*` here.
//
// THE DIRTY GATE NEEDS A DIFFERENT SPELLING — see `_scopeToPathspecs`. A scope
// entry is ALSO handed to `git status --porcelain -- <entry>`, and a trailing-
// slash wildcard pathspec matches NOTHING there (measured, git 2.50.1). Emitting
// the record shape into git would have silently disabled the scope-dirtiness gate.
function _resolveJournalScope() {
  // BOUNDED BY CONSTRUCTION — two entries, always, regardless of repo size.
  // `journal/` stays unconditional for the same reason it always was: it is the
  // module-level default of `journal-reserve.js::reserveJournalSlotSigned`, so a
  // /codify creating a repo's FIRST journal entry must be covered before the
  // directory exists.
  return [JOURNAL_ROOT_SCOPE, WORKSPACE_JOURNAL_SCOPE];
}

// The RECORD/lease spelling (consumed by integrity-guard.js::findCoveringLease)
// and the GIT PATHSPEC spelling (consumed by `git status --porcelain`) of the
// same surface. They are NOT interchangeable, and that is measured, not assumed:
//
//   pathspec                          `git status` result on a modified
//                                     workspaces/alpha/journal/a.md
//   --------------------------------  ---------------------------------------
//   workspaces/*/journal/             (nothing)   ← trailing slash kills it
//   workspaces/*/journal              (nothing)   ← no file IS that path
//   workspaces/*/journal/*            alpha AND workspaces/deep/nested/journal
//                                                 ← plain `*` CROSSES `/`
//   :(glob)workspaces/*/journal/**    alpha only  ← correct single-segment
//   workspaces/alpha/journal/         alpha only  ← the literal control, fires
//
// The literal control is what proves the instrument can report at all here, so
// the three empty results are true negatives of the PATHSPEC, not of the repo.
const JOURNAL_ROOT_SCOPE = "journal/";
const WORKSPACE_JOURNAL_SCOPE = "workspaces/*/journal/";
const WORKSPACE_JOURNAL_PATHSPEC = ":(glob)workspaces/*/journal/**";

/**
 * Render a lease scope for `git status --porcelain -- <pathspec>...`.
 *
 * ONLY the workspace-journal glob is translated; every other entry passes
 * through BYTE-UNCHANGED, so the dirtiness gate's behaviour on
 * MANDATORY_SCOPE, on `journal/`, and on caller-supplied `scopeFiles` is
 * exactly what it was before this function existed.
 *
 * Direction of the one behavioural change: the old enumerator checked only
 * workspaces that (a) already had a `journal/` directory on disk and (b) were
 * not `_`-prefixed or named `instructions`. The glob checks ALL of them, so
 * `git status` can report MORE entries — which makes the lease REFUSE on scope
 * dirtiness more readily, never less. Fail-CLOSED, the same direction
 * `_gitStatusPorcelain`'s own GIT_CONFIG_GLOBAL note already blesses.
 */
function _scopeToPathspecs(scope) {
  return (scope || []).map((s) =>
    s === WORKSPACE_JOURNAL_SCOPE ? WORKSPACE_JOURNAL_PATHSPEC : s,
  );
}

// MANDATORY_SCOPE ITSELF IS LEFT AT ITS TWO FILES. `knowledge-convergence.md`
// MUST-3 names that pair verbatim ("`.claude/learning/learning-codified.json` +
// `.claude/.proposals/latest.yaml`"), and the `42-certify` skill states that
// MANDATORY_SCOPE does NOT include `journal/`. Both statements stay TRUE under
// this shape, so the fix lands without a rule/skill edit that would otherwise be
// required — and MUST-3's actual property (the helper unions the mandatory scope
// automatically; callers cannot opt out) is preserved and extended, not weakened.
//
// The `repoTop` parameter this function used to take is GONE rather than
// retained-and-ignored: the journal scope no longer depends on what is on disk,
// and a parameter accepted with zero effect on the body is the API-surface
// silent-fallback `zero-tolerance.md` Rule 3c blocks.
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
  // The journal dirs `/codify`'s own phase-complete gate writes to. Same
  // auto-union contract as MANDATORY_SCOPE: callers cannot opt out.
  for (const f of _resolveJournalScope()) set.add(f);
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

/**
 * Commits on `branch` not reachable from the default branch — the SIZE of the
 * stranded work, so a caller can report "33 unlanded commits" rather than a bare
 * branch name nobody weighs.
 *
 * Returns null when the count cannot be computed (no git, no such ref, no
 * resolvable base). NOT 0: a failed count and a genuinely-landed branch are
 * OPPOSITE facts, and rendering both as 0 would let an unreadable repo report
 * "nothing stranded" — the absence-reads-as-success shape this whole fix is
 * about. Callers MUST render null as "unknown", never as "none".
 *
 * Base resolution tries `origin/HEAD` first so a fork whose default branch is
 * not `main` still gets a real number instead of a permanent null; the
 * `origin/main` / `main` fallbacks match the in-corpus precedent
 * (`stranded-artifacts.js::baseRef`) and cover a fixture repo with no remote.
 */
const BASE_REF_TIMEOUT_MS = 1000;
const REV_LIST_TIMEOUT_MS = 2000;

function _countUnlandedCommits(repoDir, branch) {
  try {
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    // Per-call latency bounds. `execFileSync` BLOCKS the event loop, so these
    // exec timeouts are the ONLY real bound — a JS-level timer cannot preempt
    // them — and `killSignal: "SIGKILL"` guarantees a wedged git is reaped.
    // Same constants and same reason as the sibling that does this work at
    // session start (`hooks/lib/unlanded-work-surface.js`). `gitEnv()` already
    // closes the credential-prompt and pager hangs; these close the rest
    // (a wedged filesystem, a `core.fsmonitor` in LOCAL .git/config that
    // GIT_CONFIG_GLOBAL cannot neutralise, a pathological history).
    const run = (args, timeout) =>
      execFileSync(gitBin, args, {
        cwd: repoDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: gitEnv(),
        timeout,
        killSignal: "SIGKILL",
      }).trim();
    const bases = [];
    try {
      const head = run(
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        BASE_REF_TIMEOUT_MS,
      );
      if (head) bases.push(head);
    } catch {
      /* no origin/HEAD — fall through to the literal bases */
    }
    bases.push("origin/main", "main");
    for (const base of bases) {
      try {
        const out = run(
          // `--` terminates option parsing: `base` is whatever
          // `.git/refs/remotes/origin/HEAD` points at, is locally writable, and
          // is NOT grammar-checked before interpolation. `branch` is provably
          // safe (it matched an anchored `codify/`-prefixed pattern), but the
          // pair is only as safe as its weaker half.
          ["rev-list", "--count", `${base}..${branch}`, "--"],
          REV_LIST_TIMEOUT_MS,
        );
        if (/^\d+$/.test(out)) return Number(out);
      } catch {
        /* try the next base */
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Is the codify branch this session is STANDING ON fresh enough to bind to?
 *
 * Returns { currentBranchEarly, currentBranchDate, today, bindsToCurrent,
 * staleBranch } — `currentBranchDate` is null when the current branch is not
 * this operator's codify branch at all (main, or a foreign operator's), in which
 * case nothing is stale and a fresh name is minted.
 *
 * THE PREDICATE IS STALENESS (older than YESTERDAY), NEVER INEQUALITY
 * (`!== today`). `_isoDate()` is UTC-derived, so it can name a different day than
 * the operator's wall clock whenever local time and UTC straddle midnight — for a
 * UTC+N operator that is the EARLY-MORNING hours (00:00–N:00 local, still
 * "yesterday" in UTC); for UTC−N it is the late evening, skewing the other way.
 * The FSUB walk finding this module already fixed once is a live repro of the
 * first (lease said `2026-06-10` while the session branch was `2026-06-11`).
 * `>= yesterday` tolerates BOTH signs of skew, which is why the predicate is a
 * one-day window rather than an equality test; an inequality check re-breaks
 * exactly that case, refusing to bind to a branch the same operator minted
 * minutes earlier.
 *
 * A FUTURE-dated branch binds: the ratchet needs ELAPSED days to accrete commits
 * across, so a forward-dated name holds no stranded history at mint time.
 *
 * WHAT THIS BOUNDS, STATED SO IT IS NOT OVER-READ. A one-day window means a
 * daily operator still accumulates up to TWO calendar days of commits on one
 * branch before the bind is declined. This CAPS the ratchet (the measured case
 * ran three days); it does not eliminate stranding, and it does not by itself
 * land anything — declining to bind moves no commits and does not move HEAD.
 *
 * The date is captured by the SAME anchored regex that admits the branch, so for
 * THIS read the token is the token matched. A second, unanchored regex would
 * search the whole name and could capture a date-shaped substring out of a
 * `display_id` or a `-<lane>` token — `_validateDisplayId` permits digits and
 * hyphens, so `display_id: "bot-2026-01-01"` is legal and makes that reachable.
 */
function _classifyBranchFreshness(repoDir, displayId) {
  const currentBranchEarly = _gitCurrentBranch(repoDir);
  const ownBranchRe = new RegExp(
    `^${BRANCH_PREFIX}${displayId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d{4}-\\d{2}-\\d{2})(?:-[A-Za-z0-9._-]+)?$`,
  );
  const ownMatch = currentBranchEarly
    ? ownBranchRe.exec(currentBranchEarly)
    : null;
  const currentBranchDate = ownMatch ? ownMatch[1] : null;
  const today = _isoDate();
  // ISO `YYYY-MM-DD` compares lexicographically exactly as it compares
  // chronologically, so a string `>=` IS the date comparison — no parsing, no
  // timezone re-derivation, no second clock. Both operands come from `_isoDate`,
  // whose `getUTC*` path DST cannot reach.
  const yesterday = _isoDate(new Date(Date.now() - 86400000));
  const bindsToCurrent =
    currentBranchDate !== null && currentBranchDate >= yesterday;
  // Declining to bind is NECESSARY BUT NOT SUFFICIENT: an unreported stale branch
  // is abandoned rather than landed, which is the same stranding one layer over.
  const staleBranch =
    currentBranchDate !== null && !bindsToCurrent
      ? { name: currentBranchEarly, date: currentBranchDate }
      : null;
  return {
    currentBranchEarly,
    currentBranchDate,
    today,
    bindsToCurrent,
    staleBranch,
  };
}

/**
 * Attach `stale_branch` (with its commit count) to a result, or return the
 * result untouched when nothing is stale.
 *
 * The count is computed HERE, at attach time, so it happens BEFORE the caller's
 * durable lease write and signed emit on the success path — a wedged git must not
 * be able to leave a lease held on disk and a grant emitted while the caller
 * receives nothing.
 */
function _attachStaleBranch(result, repoDir, staleBranch) {
  if (!staleBranch) return result;
  result.stale_branch = {
    ...staleBranch,
    unlanded_commits: _countUnlandedCommits(repoDir, staleBranch.name),
  };
  return result;
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
 * Emission failure is NON-FATAL on the ACQUIRE path (including its
 * `reclaim-stale` release): the local mutex already landed atomically, and
 * refusing the lease because the visibility record could not be signed (e.g.
 * un-rostered operator) would block solo /codify entirely. The failure IS
 * surfaced — the caller receives it under `record_emit` and MUST report it per
 * zero-tolerance.md Rule 3 (typed + observable, never silent).
 *
 * It is FATAL on the RELEASE path (loom#1881). The asymmetry is not an
 * inconsistency: an acquire whose record does not land grants NOTHING (the
 * fence finds no covering record and refuses — fail-CLOSED), while a release
 * whose record does not land REVOKES NOTHING (the fence still finds the
 * acquire and authorizes — fail-OPEN). Same failure, opposite directions, so
 * the same disposition would be the wrong one on one of them. See
 * `releaseCodifyLease` for the ordering that makes this hold.
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

/**
 * Surface a FAILED lease-record emission LOUDLY, and say what it costs.
 *
 * THE DEFECT THIS EXISTS FOR (2026-08-16). `record_emit` was returned on the
 * result object and nothing else, and `acquireCodifyLease` returned `{ok: true}`
 * alongside it. So a record that could never emit FROM THE MAIN CHECKOUT — the
 * 2964 B overflow above, which reproduced on every such call including with an
 * EMPTY `scopeFiles` — presented to every caller as a success, and the only way
 * to find out that the cross-clone visibility surface `knowledge-convergence.md`
 * MUST-3 names had not been written was to read a nested field on a result whose
 * TOP level said `ok: true`, with an EMPTY stderr. Measured 2026-08-23 on the
 * pre-fix build: `{ok: true, record_emit: {ok: false, ...}}`, zero bytes on
 * stderr. That is the observable-failure half of `zero-tolerance.md` Rule 3 —
 * the emission failure was TYPED but never SURFACED, so in practice it was
 * silent, and the surrounding command prose asking the caller to "surface
 * record_emit" could only ever be honoured by a caller who chose to look.
 *
 * WHY THIS IS NOT MADE FATAL. MUST-3 states an emission failure "does NOT void
 * the lease but MUST be surfaced verbatim" — and it is right to: the on-disk
 * mutex has already landed atomically by the time we get here, and refusing the
 * lease would block /codify outright for an un-rostered or key-less operator.
 * So `ok` keeps describing THE LEASE (which held), and the failure gets its own
 * unmissable channel instead:
 *
 *   1. stderr, immediately, tagged — visible in the transcript without anyone
 *      choosing to inspect a return value.
 *   2. `result.degraded` — a TOP-LEVEL field on the success object, so a caller
 *      that checks nothing else still trips over it, naming exactly which
 *      capability is absent rather than only which call failed.
 *
 * `structural: true` marks the class that will fail IDENTICALLY on every retry
 * (the record cannot fit, full stop) as opposed to the transient/environmental
 * ones (no signing key, unreadable log). MUST-3 contemplates the occasional
 * failure; a structural always-fail is a different animal and is labelled as one.
 *
 * The byte breakdown is MEASURED from the content actually passed, never
 * estimated — a caller told "too large" without being told BY WHAT and WHICH
 * FIELD cannot act, and a guessed number here would be a non-discriminating
 * instrument in its own right.
 */
function _describeRecordEmitFailure(type, content, emitResult) {
  const reason = String(
    (emitResult && (emitResult.reason || emitResult.error)) || "unknown",
  );
  // The overflow refusal is raised by coc-emit.js::_defaultAppend (and its
  // coc-append.js sibling) with this exact wording; both name MAX_LINE_BYTES.
  const structural = /MAX_LINE_BYTES|record too large|exceeds/i.test(reason);
  const fields = [];
  if (content && typeof content === "object") {
    for (const k of Object.keys(content)) {
      let bytes;
      try {
        bytes = Buffer.byteLength(JSON.stringify(content[k]) || "", "utf8");
      } catch {
        bytes = -1;
      }
      fields.push({ field: k, bytes });
    }
    fields.sort((a, b) => b.bytes - a.bytes);
  }
  const degraded = {
    capability: "cross-clone lease visibility",
    record_type: type,
    structural,
    error: (emitResult && emitResult.error) || "emit failed",
    reason,
    step: (emitResult && emitResult.step) || null,
    content_bytes_by_field: fields,
    impact:
      "The signed coordination-log record did NOT land. The on-disk lease mutex " +
      "IS held (this repo is protected), but NO sibling clone can see it, and " +
      "integrity-guard.js will find no covering lease for Edit/Write on watched " +
      "paths. knowledge-convergence.md MUST-3 requires this surfaced verbatim.",
  };
  const top = fields
    .slice(0, 3)
    .map((f) => `${f.field}=${f.bytes}B`)
    .join(" ");
  try {
    process.stderr.write(
      `[LEASE-RECORD-NOT-EMITTED]${structural ? " STRUCTURAL" : ""} ` +
        `type=${type} — ${reason}\n` +
        `[LEASE-RECORD-NOT-EMITTED] largest content fields: ${top}\n` +
        `[LEASE-RECORD-NOT-EMITTED] ${degraded.impact}\n`,
    );
  } catch {
    // stderr unavailable — `degraded` on the returned object still carries it.
  }
  return degraded;
}

/**
 * Persist the record-emit failure ONTO THE LEASE FILE, so the degradation
 * survives the session that observed it.
 *
 * THE GAP THIS CLOSES (2026-08-23, adversarial review of the fix above).
 * `_describeRecordEmitFailure` gave the failure two channels — a stderr line
 * and `result.degraded` — and BOTH are session-local. The stderr write happens
 * once, in the acquiring process; `result.degraded` lives only on that call's
 * return value. Neither is on disk. So `/onboard`, a sibling operator, a
 * resumed session, or the same session after a `/clear` or a compaction reads
 * a lease file that is BYTE-INDISTINGUISHABLE from a healthy one, and reports
 * "lease HELD" with no hint the signed grant never landed. MEASURED on the
 * pre-mark build: two acquires differing ONLY in whether the append succeeded
 * produced on-disk leases with IDENTICAL key sets
 * (`_released _version acquired_at branch current_branch display_id lease_id
 * owner_axis person_id pid repo_top_level scope scope_fingerprint verified_id`)
 * and identical values on every non-volatile field. By this repo's own
 * instrument test (`instrument-discipline.md` MUST-1), `readActiveLease()` was
 * therefore not evidence about emission at all: no result it could return
 * would have distinguished "held and granting" from "held, grant never
 * emitted".
 *
 * THIS IS LEGIBILITY, NOT AUTHORIZATION. It grants nothing and revokes
 * nothing. `integrity-guard.js::findCoveringLease` resolves against the FOLDED
 * COORDINATION LOG and never reads this file, so a lease whose record did not
 * emit ALREADY authorizes nothing — that is exactly the harm being made
 * visible, and it is unchanged here. Nothing downstream keys on these fields
 * for a permission decision, and nothing should: a reader that started
 * granting on `record_emitted === true` would be trusting a local mutable file
 * for what only the signed log can say.
 *
 * WHY A SECOND WRITE, and not a stamp before the first one. The mark cannot be
 * folded into the write at the top because the failure is not known yet — the
 * emit happens AFTER the mutex lands, and deliberately so: the on-disk mutex
 * must exist before anything slower runs, or a crash mid-emit leaves the repo
 * unprotected. Hoisting the emit above the write would invert that and admit
 * the strictly worse state — a signed coordination-log record announcing a
 * lease with no mutex behind it. So the ordering is kept and the mark is a
 * second atomic write, taken ONLY on the already-degraded path. The healthy
 * path is byte-for-byte what it was: one write, no new fields, so every
 * existing consumer (`/onboard`, the liveness suite, the identity-axis suite)
 * sees an unchanged healthy lease. ABSENT means healthy — every lease written
 * before this change, and every healthy one after it, omits these fields.
 *
 * A crash between the two writes leaves the lease unmarked, which is precisely
 * today's behaviour and no worse; the window is one `rename(2)`.
 *
 * Failure to persist is itself surfaced, never swallowed (zero-tolerance.md
 * Rule 3) — `_atomicWriteJson` throws, and a mark we could not write is a fact
 * the caller needs, since it means the ONLY durable channel is gone.
 */
function _persistRecordEmitFailure(leasePath, lease, degraded) {
  lease.record_emitted = false;
  lease.record_emit_degraded = degraded;
  try {
    _atomicWriteJson(leasePath, lease);
    return { ok: true };
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    try {
      process.stderr.write(
        `[LEASE-RECORD-NOT-EMITTED] AND the degradation mark could NOT be ` +
          `written to ${leasePath}: ${reason}. This session's transcript is ` +
          `now the ONLY record that the signed grant never landed — a later ` +
          `reader will see a lease indistinguishable from a healthy one.\n`,
      );
    } catch {
      // stderr unavailable — the returned object still carries it.
    }
    return { ok: false, error: "degradation mark not persisted", reason };
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
 * On a successful acquire whose signed record FAILED to emit, the result also
 * carries `degraded` (typed; see _describeRecordEmitFailure) AND the same
 * diagnosis is written onto the lease file as `record_emitted: false` +
 * `record_emit_degraded`, so a later session can still tell the two states
 * apart (see _persistRecordEmitFailure). Both fields are ABSENT on a healthy
 * lease — the healthy write is unchanged.
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

  // The journal scope is a repo-RELATIVE path shape, not an on-disk enumeration,
  // so it no longer needs the git top-level to resolve. The shapes it emits are
  // exactly the `candidateRel` forms `integrity-guard.js::findCoveringLease`
  // compares against.
  const scope = _sortDedupRel(o.scopeFiles);
  const fingerprint = _scopeFingerprint(scope);
  const leasePath = _leasePath(topLevel);

  // Coordination state is MAIN-checkout state (see the emit sites below, and the
  // same CRIT-2 / trust-posture.md MUST-1 discipline state-resolver enforces).
  // Hoisted ABOVE the conflict check because the OWNERSHIP identity is resolved
  // from the same root the record is signed at — a worktree-run /codify must
  // decide ownership against main's roster + coordination state, not against the
  // auto-deleted worktree copy. On the normal main-checkout path
  // coordRoot === topLevel, so nothing below observes the hoist.
  const coordRoot = resolveMainCheckout(repoDir) || topLevel;
  const owner = _resolveOwnerIdentity(coordRoot, o);

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
      // loom#1849b — SAME-OPERATOR is a materially different situation and the
      // message must say so. This is a MESSAGE change only: the MUTEX verdict
      // is byte-identical (still exactly one holder, still refused), because
      // returning ok:true for a second same-operator caller is precisely the
      // N-way dissolution that left `.claude/.proposals/latest.yaml` with no
      // serializer at all.
      //
      // What the caller needs to know is that it does NOT need its own lease:
      // the GRANT is per-OPERATOR and lives in the signed coordination log, so
      // the lease this session already holds authorizes its writes from ANY
      // working tree (findCoveringLease matches SIGNER + SCOPE, not branch).
      // The three concerns come apart exactly here — mutex REFUSED, grant
      // ALREADY HELD, binding FREE.
      //
      // 2026-08-21 — the axis. This classifier used to read
      // `existing.display_id === displayId`, which is SIGNAGE (§ ownership axis
      // above). It now reads the strongest axis the existing record declares, so
      // a display_id collision no longer tells a DIFFERENT human "YOU already
      // hold the lease" (sending them hunting a session they never started), and
      // the SAME human under differently-resolved signage is no longer reported
      // as a stranger. The MUTEX verdict is untouched — still exactly one holder,
      // still `ok: false` on both branches.
      const ownership = _ownerVerdict(existing, {
        person_id: owner.person_id,
        verified_id: owner.verified_id,
        display_id: displayId,
      });
      const sameOperator = ownership.same;
      return {
        ok: false,
        reason: "conflict",
        same_operator: sameOperator,
        owner_axis: ownership.axis,
        caller_axis_present: ownership.caller_axis_present,
        ownership,
        error:
          (sameOperator
            ? `acquireCodifyLease: YOU already hold the codify lease ` +
              `(display_id=${existing.display_id}, since=${existing.acquired_at}, ` +
              `branch=${existing.branch}). A second lease is refused by design — ` +
              `the lease is the repo-wide MUTEX on the shared codify state and ` +
              `there is exactly one. You do NOT need a second one: the GRANT it ` +
              `carries is per-OPERATOR and signer-matched, so it already ` +
              `authorizes your writes from any working tree, on any codify ` +
              `branch of yours. Take a distinct lane branch ` +
              `(codify/${displayId}-YYYY-MM-DD-<lane>) and proceed; serialize ` +
              `your writes to the shared scope files against the lane that holds ` +
              `the lease. `
            : `acquireCodifyLease: another /codify session holds the lease ` +
              `(display_id=${existing.display_id}` +
              (existing.person_id ? `, person_id=${existing.person_id}` : "") +
              `, since=${existing.acquired_at}). `) +
          (overlap
            ? "Scope overlaps — wait for the other session to release."
            : "Scope is disjoint, but only one /codify lease is active at a time per repo.") +
          ` Liveness: ${liveness.basis}.` +
          ` Ownership: ${ownership.basis}.`,
        conflicting: {
          display_id: existing.display_id,
          // §1: display_id above is SIGNAGE for the human reading this; these two
          // are what the verdict was actually decided on. Null on a v1 record.
          person_id: existing.person_id || null,
          verified_id: existing.verified_id || null,
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
      // Attribution of the takeover victim on the AUTHORITY axis, not signage —
      // a takeover surfaced only as "alex" is unattributable when two humans
      // share that signage. Null on a v1 record, which is honest: such a record
      // genuinely names no person.
      person_id: existing.person_id || null,
      verified_id: existing.verified_id || null,
      acquired_at: existing.acquired_at || null,
      branch: existing.branch || null,
      scope: existing.scope || null,
      pid: existing.pid === undefined ? null : existing.pid,
      liveness,
      reclaimed_at: _isoTimestamp(),
    };
  }

  // FRESHNESS IS COMPUTED HERE, ABOVE THE DIRTY CHECK, ON PURPOSE.
  //
  // It has no dependency on `git status`, and `scope-dirty` is the ONE early
  // return whose remedy is an action taken FROM THE CURRENT CHECKOUT: its message
  // says "commit". An operator who follows that while standing on a stale codify
  // branch commits ONTO the stale branch — one more turn of the very ratchet this
  // change exists to break — and, if the freshness block sat below this return,
  // nothing would ever have told them the branch was stale, because the only
  // signal that says so would be unreachable from this path.
  //
  // The other early returns above (invalid-display-id, not-a-git-repo,
  // lease-corrupt, conflict, git-status-failed) are NOT given this treatment:
  // each stops the session outright and the next acquire re-derives everything,
  // so there is no action taken from the stale checkout in between.
  const staleness = _classifyBranchFreshness(topLevel, displayId);
  const {
    currentBranchEarly,
    currentBranchDate,
    today,
    bindsToCurrent,
    staleBranch,
  } = staleness;

  // Workspace cleanliness check: refuse if scope files are dirty in the
  // working tree of the current branch, because the codify session will be
  // expected to commit them onto the codify branch.
  // `_scopeToPathspecs`, NOT `scope` — the workspace-journal entry is a RECORD
  // shape and matches nothing as a git pathspec (measured; see the table above
  // that function). Passing `scope` here would leave the gate reporting clean for
  // every workspace journal, which is the silent-no-op direction.
  const statusRes = _gitStatusPorcelain(topLevel, _scopeToPathspecs(scope));
  if (!statusRes.ok) {
    return {
      ok: false,
      reason: "git-status-failed",
      error: `acquireCodifyLease: git status --porcelain failed: ${statusRes.error}`,
    };
  }
  if (statusRes.lines.length > 0) {
    // `git stash` is BLOCKED in this corpus: the stash stack is `.git`-scoped and
    // SHARED with every linked worktree, so a sibling can list and pop this
    // operator's entry (`worktree-isolation.md` Rule 9, `git.md` § Destructive
    // Working-Tree Ops). The message used to recommend it.
    return _attachStaleBranch(
      {
        ok: false,
        reason: "scope-dirty",
        error:
          `acquireCodifyLease: scope files have uncommitted changes — commit, or capture ` +
          `to a patch (\`git add -N . && git diff > wip.patch\`), before /codify. ` +
          `Do NOT \`git stash\`: the stack is shared with every linked worktree.\n` +
          statusRes.lines.join("\n") +
          (staleBranch
            ? `\n\nCOMMIT WHERE? You are standing on ${staleBranch.name}, whose date ` +
              `token (${staleBranch.date}) is older than yesterday, so /codify will NOT ` +
              `bind to it. Committing here appends to a branch nothing lands — land it ` +
              `first (PR + admin-merge) or park it (\`git checkout main\`), then re-run.`
            : ""),
        dirty: statusRes.lines,
      },
      topLevel,
      staleBranch,
    );
  }

  // The branch this lease RECORDS and reports.
  //
  // loom#1849b — READ THIS BEFORE TREATING IT AS AUTHORIZATION. As of that
  // change `integrity-guard.js::findCoveringLease` does NOT compare
  // `content.branch` to anything: the branch is a WORKSPACE BINDING, whose
  // natural cardinality is N-per-operator, welded into a record whose mutex and
  // grant halves are 1-per-repo and 1-per-operator. Comparing it serialized
  // every codify-class writer in a linked-worktree forest onto ONE tree, since
  // git binds one branch name to one working tree. The field is now
  // INFORMATIONAL — /onboard's banner and the conflict message below — and the
  // guard's `branch` parameter was REMOVED so the gate cannot be restored by a
  // one-line edit.
  //
  // The construction below is nonetheless KEPT, verbatim, for two reasons that
  // survive the change:
  //
  //   FSUB walk finding (2026-06-11, journal/0264 §FD1) — a UTC-derived date
  //   constructs YESTERDAY's name for a late-evening UTC+N session (live repro:
  //   lease said codify/<operator>-2026-06-10 while the session branch was
  //   codify/<operator>-2026-06-11). That no longer breaks the covering check, but
  //   it still makes the REPORTED branch wrong, which is a bad banner and a
  //   confusing conflict message. Binding to the session's actual codify branch
  //   when there is one keeps the record honest.
  //
  //   PR-B walk finding (2026-06-11, journal/0267) — the capture must name a
  //   branch the integrity-guard's branch-SHAPE predicate (`isCodifyBranch`)
  //   ACCEPTS, or the lease records a branch on which no write can land at all.
  //   That predicate is a SEPARATE, RETAINED fence, and the two grammars MUST
  //   stay in lockstep — the original bug here was a `startsWith` capture
  //   admitting names the guard rejected, i.e. lease and guard silently
  //   disagreeing on what a codify branch IS.
  //
  //   loom#1849b moves BOTH in lockstep: the grammar gains an OPTIONAL trailing
  //   `-<lane>` token, so two concurrent sessions of the SAME operator on the
  //   SAME date can hold DISTINCT branches — hence distinct working trees —
  //   instead of silently sharing one (measured: `codify/<operator>-2026-08-20`
  //   accumulated 18 interleaved commits from two sessions). The BINDING axis is
  //   N-per-operator by nature; a date-terminal name made it a DERIVED identity
  //   with no owner, which is what let two sessions compute the same one.
  //   loom#1905 (2026-08-22) — the bind above matched the GRAMMAR and never read
  //   the DATE TOKEN the grammar carries, which made an unlanded codify branch
  //   SELF-PERPETUATING. A codify session ends with the checkout still ON its
  //   codify branch, so the next day's session finds that branch in
  //   `currentBranchEarly`, re-binds to it, and appends; the day after, again.
  //   The branch grows, and the larger it grows the less likely anyone lands it —
  //   a ratchet, not a one-off. MEASURED at the fix: `codify/<operator>-2026-08-20`
  //   held 33 unlanded commits and was still being written on 2026-08-22, three
  //   days past the date in its own name and well past LEASE_TTL_MS.
  //
  //   The TTL does not save it. The TTL reclaims the LEASE; the reclaiming
  //   session then inherits the stale lease's recorded BRANCH. Reclaim is not
  //   landing, so expiry alone never returns the work to main.
  //
  //   The GRAMMAR is deliberately untouched — `integrity-guard.js::isCodifyBranch`
  //   is a separate retained fence and the two MUST stay in lockstep (§ PR-B walk
  //   finding above). This adds a FRESHNESS predicate ON TOP of the grammar
  //   match: every name the guard accepted, it still accepts. Only the BIND
  //   narrows, and only in the one direction that strands work.
  //
  //   THE PREDICATE IS STALENESS (older than YESTERDAY), NEVER INEQUALITY
  //   (`!== today`), and the FRESHNESS WINDOW IS ONE DAY WIDE. See
  //   `_classifyBranchFreshness` for the predicate, the skew argument, and the
  //   bound this buys (it CAPS the ratchet at ~2 calendar days; it does not
  //   eliminate stranding).
  //
  // The freshness classification itself is hoisted ABOVE the `scope-dirty` return
  // (see there for why); this site only consumes its verdict.
  const branch = bindsToCurrent
    ? currentBranchEarly
    : `${BRANCH_PREFIX}${displayId}-${today}`;
  const acquiredAt = _isoTimestamp();
  const leaseId =
    `lease_${Date.now()}_` + crypto.randomBytes(4).toString("hex");
  // Reuse the freshness classifier's read rather than re-running `git
  // rev-parse`: two reads of one value cost a second subprocess AND admit a race
  // in which `lease.branch` and `lease.current_branch` describe different
  // instants.
  const currentBranch = currentBranchEarly;

  // `_version: 2` — the record now DECLARES the axis its ownership is decided
  // on (§ ownership axis). The version is not a migration trigger and nothing
  // branches on it: a v1 record is handled by `_declaredOwnerAxis` finding only
  // display_id on it, which is the same verdict v1 always produced. The bump is
  // there so a reader can tell "this record predates the axis fix" from "this
  // operator had no resolvable person_id", which are different facts that both
  // present as `person_id: null`.
  const ownerAxisDeclared =
    (owner.person_id && "person_id") ||
    (owner.verified_id && "verified_id") ||
    "display_id";
  const lease = {
    lease_id: leaseId,
    display_id: displayId,
    // The AUTHORITY axis and the RECORD-authentication axis (§1). Null when the
    // substrate cannot resolve them (solo / coordination-off / un-rostered key) —
    // never faked, never back-filled from display_id.
    person_id: owner.person_id,
    verified_id: owner.verified_id,
    owner_axis: ownerAxisDeclared,
    scope,
    scope_fingerprint: fingerprint,
    branch,
    acquired_at: acquiredAt,
    pid: process.pid,
    repo_top_level: topLevel,
    current_branch: currentBranch || null,
    _released: false,
    _version: 2,
  };
  // Surfaced, never swallowed (zero-tolerance.md Rule 3): the axes fell back to
  // signage because identity resolution FAILED, which is a different situation
  // from a repo that has no identity to resolve.
  if (owner.error) lease.identity_error = owner.error;
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
  // covering check resolves against this record. Since loom#1849b that check is
  // SIGNER match + SCOPE path/prefix match; `branch` and `date` still ship
  // because /onboard and the conflict message read them, but they are
  // INFORMATIONAL and the guard does not consult them. scope_files are REPO-RELATIVE
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
  //
  // `coordRoot` is now resolved ONCE, at the top of this function, because the
  // OWNERSHIP identity resolves from the same root (§ ownership axis). Same
  // value, same call, one site instead of two.

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
    const reclaimContent = {
      lease_id: reclaimed.lease_id,
      released_at: reclaimed.reclaimed_at,
      action: "reclaim-stale",
      reclaimed_by: displayId,
      // Signage above (kept verbatim — existing readers and the
      // liveness suite pair on it); AUTHORITY here. A takeover attributed
      // only by display_id is unattributable when two humans share it.
      reclaimed_by_person_id: owner.person_id,
      reclaimed_from_display_id: reclaimed.display_id,
      reclaimed_from_person_id: reclaimed.person_id,
      original_acquired_at: reclaimed.acquired_at,
      age_ms: reclaimed.liveness.age_ms,
      ttl_ms: reclaimed.liveness.ttl_ms,
      liveness_basis: reclaimed.liveness.basis,
      successor_lease_id: leaseId,
    };
    reclaimed.record_emit = isGovernanceEnabled(coordRoot)
      ? _emitLeaseRecord(coordRoot, "codify-lease-release", reclaimContent, o)
      : { ok: true, skipped: true, reason: "governance-disabled" };
    // Same loud channel as the acquire record below: a stale-takeover that no
    // sibling clone can see is exactly as invisible, and the previous holder's
    // session may still believe it owns the scope.
    if (!reclaimed.record_emit || !reclaimed.record_emit.ok) {
      reclaimed.degraded = _describeRecordEmitFailure(
        "codify-lease-release (reclaim-stale)",
        reclaimContent,
        reclaimed.record_emit,
      );
    }
  }

  // Hoisted out of the call so a failed emit can be diagnosed against the EXACT
  // content that failed (measured per-field bytes), not a reconstruction of it.
  const leaseRecordContent = {
    lease_id: leaseId,
    branch,
    // Informational; keep consistent with the branch's own date token
    // when the lease bound to an existing codify/* branch. NOT anchored
    // to end-of-string: since loom#1849b a branch may carry a trailing
    // `-<lane>`, and an anchored match would silently fall through to
    // today's UTC date on exactly the multi-lane branches this change
    // exists to enable.
    // The ANCHORED capture, not a second unanchored search over the whole
    // name. `_validateDisplayId` permits digits and hyphens, so a
    // `display_id` of `bot-2026-01-01` on branch
    // `codify/bot-2026-01-01-<today>` makes an unanchored match return the
    // display_id's date — a WRONG date written into a signed,
    // cross-clone coordination record. `currentBranchDate` is null only
    // when the branch is not this operator's codify branch, in which case
    // the branch was freshly minted with today's token.
    date: bindsToCurrent ? currentBranchDate : today,
    scope_files: scope,
    scope_fingerprint: fingerprint,
    acquired_at: acquiredAt,
    action: "acquire",
    // The axis this lease's ownership is decided on, carried into the
    // signed record so a sibling clone folding the log can attribute the
    // holder without the roster round-trip. `emitSignedRecord` already
    // stamps verified_id + person_id on the record ENVELOPE; this names
    // which of them the LEASE itself keys on.
    owner_axis: ownerAxisDeclared,
  };
  const recordEmit = isGovernanceEnabled(coordRoot)
    ? _emitLeaseRecord(coordRoot, "codify-lease", leaseRecordContent, o)
    : { ok: true, skipped: true, reason: "governance-disabled" };

  const result = {
    ok: true,
    lease,
    branch,
    leasePath,
    scope,
    record_emit: recordEmit,
    owner_axis: ownerAxisDeclared,
  };
  // Non-fatal but never silent (zero-tolerance.md Rule 3): identity resolution
  // THREW, so this lease decides ownership on signage. Callers surface it the
  // same way they surface `record_emit` failures.
  if (owner.error) result.identity_error = owner.error;
  // A failed emit is now LOUD (stderr) and TOP-LEVEL (`degraded`), not just a
  // nested field on a success object. `skipped: true` (coordination OFF) is a
  // deliberate no-op, not a failure, and is `ok: true` — it does not come here.
  // Independent of `identity_error` above: one names an ownership-axis
  // fallback, the other an absent cross-clone capability, and a lease can
  // carry either, both, or neither.
  if (!recordEmit || !recordEmit.ok) {
    result.degraded = _describeRecordEmitFailure(
      "codify-lease",
      leaseRecordContent,
      recordEmit,
    );
    // ...and DURABLY, on the lease file itself, because both channels above
    // die with the session that saw them (see _persistRecordEmitFailure for
    // the measured indistinguishability this closes). Legibility only — the
    // grant lives in the signed log, which findCoveringLease reads and this
    // file is not; a lease marked here already authorized nothing.
    //
    // Scoped to the ACQUIRE record deliberately. A reclaim-release record that
    // failed to emit keeps its existing `result.reclaimed.degraded` surface:
    // that record closes out ANOTHER operator's orphaned lease, whereas this
    // one IS the grant a later reader is asking about. (When the acquire
    // record fails on a takeover, `lease.reclaimed_from` and `reclaimed`
    // are the same object, so the reclaim's own diagnosis rides along on the
    // write below at no extra cost.)
    const persisted = _persistRecordEmitFailure(
      leasePath,
      lease,
      result.degraded,
    );
    result.degraded.persisted = persisted.ok;
    if (!persisted.ok) {
      result.degraded.persist_error = persisted.error;
      result.degraded.persist_reason = persisted.reason;
    }
  }
  // Callers MUST surface this verbatim when present (commands/codify.md Step 0):
  // it means this session took a lease another operator's session had not
  // released. Present only on a takeover — absent on every normal acquire.
  if (reclaimed) result.reclaimed = reclaimed;
  // Present ONLY when this acquire DECLINED to bind to the codify branch the
  // session was standing on, because its date token is older than yesterday.
  // Callers MUST surface it (commands/codify.md Step 0): the branch holds
  // unlanded work, and saying nothing converts the ratchet this fix broke into
  // silent abandonment. `unlanded_commits: null` means UNKNOWN, never none.
  _attachStaleBranch(result, topLevel, staleBranch);
  return result;
}

/**
 * Release a lease. Idempotent — releasing an already-released or missing
 * lease is a no-op (returns ok: true with `noop` flag).
 *
 * The release path REQUIRES the caller to be the lease's OWNER on the strongest
 * identity axis the lease record declares — person_id (authority), else
 * verified_id (record authentication), else display_id (§ ownership axis).
 * A different operator cannot release someone else's lease. That's a structural
 * fence: only the acquirer can declare the work complete.
 *
 * Until 2026-08-21 this fence compared `display_id` alone, which
 * `multi-operator-coordination.md` §1 names as the WRONG axis — signage whose
 * collisions are harmless by design. It was therefore defeated by a display_id
 * collision (measured: a second person released the first's lease and signed
 * the revocation record with their own key) and, in the other direction, refused
 * the genuine holder whose signage resolved differently in a second session.
 * `displayId` remains a REQUIRED parameter — `knowledge-convergence.md` MUST-3
 * pins the `{repoDir, displayId}` call shape — and is still what decides
 * ownership for a pre-fix (`_version: 1`) record, which declares nothing else.
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
  // Ownership on the declared axis, resolved from the SAME root the release
  // record is signed at (see acquire). `coordRoot` is computed once here and
  // reused by the emit below.
  const coordRoot = resolveMainCheckout(repoDir) || topLevel;
  const owner = _resolveOwnerIdentity(coordRoot, o);
  const ownership = _ownerVerdict(existing, {
    person_id: owner.person_id,
    verified_id: owner.verified_id,
    display_id: displayId,
  });
  if (!ownership.same) {
    // Two materially different refusals share `reason: "wrong-owner"` (the
    // pre-existing typed reason every caller and test keys on). `owner_axis` +
    // `caller_axis_present` tell them apart, and the message says which it is —
    // an operator whose signing key is unavailable needs "fix your key", not
    // "this lease is not yours", or the fence reads as an unexplained lockout.
    const indeterminate = !ownership.caller_axis_present;
    return {
      ok: false,
      reason: "wrong-owner",
      owner_axis: ownership.axis,
      caller_axis_present: ownership.caller_axis_present,
      ownership,
      error:
        (indeterminate
          ? `releaseCodifyLease: the lease declares its owner by ` +
            `${ownership.axis || "no identity axis"} and this session cannot ` +
            `produce one, so ownership is INDETERMINATE and the release is ` +
            `REFUSED (fail-closed). This is NOT a claim that the lease belongs ` +
            `to someone else — resolve your identity (a configured, rostered ` +
            `signing key; \`/whoami\`) and retry. Falling back to display_id ` +
            `here would let signage override authority, which is the defect ` +
            `this fence exists to close. The 12h lease TTL bounds the exposure ` +
            `if the identity cannot be restored.`
          : // Signage may be IDENTICAL on both sides while the deciding axis
            // differs (two humans sharing a display_id; one human on a rotated
            // key). Leading with "held by alice; cannot be released by alice"
            // would read as a bug, so the axis leads whenever it is not signage.
            ownership.axis === "display_id"
            ? `releaseCodifyLease: lease is held by ${existing.display_id}; ` +
              `cannot be released by ${displayId}.`
            : `releaseCodifyLease: this session is NOT the lease's owner. The ` +
              `lease (display_id=${existing.display_id}) declares its owner by ` +
              `${ownership.axis}, and yours does not match — signage is NOT the ` +
              `ownership axis (multi-operator-coordination.md §1), so an ` +
              `identical display_id on both sides does not make you the holder.`) +
        ` Ownership: ${ownership.basis}.`,
    };
  }

  const released = Object.assign({}, existing, {
    _released: true,
    released_at: _isoTimestamp(),
    released_by_pid: process.pid,
  });

  // FSUB (2026-06-11): release visibility record — siblings folding the
  // log can pair acquire/release by lease_id without reading this
  // clone's codify-lease.json. MO-OPT W1-c: skip the signed emit when
  // coordination is OFF (symmetric with acquire above) — no coordination log
  // to pair against on a solo repo.
  // Cluster A (see acquire): coordination state is main-checkout state.
  //
  // NO `degraded` FIELD ON THIS PATH, DELIBERATELY (2026-08-23 rebase). The
  // acquire path returns `ok: true` on an emit failure — the mutex landed, so
  // the LEASE held and only the cross-clone CAPABILITY is absent, and
  // `degraded` is the channel that says so. This path no longer has that
  // shape: since loom#1881 below, a failed release emit returns `ok: false`
  // and does not release at all. A top-level `degraded` here would announce a
  // missing capability on a call that already failed loudly and fatally, which
  // is a weaker statement than the one the caller is already getting.
  //
  // EMIT BEFORE THE ON-DISK WRITE (loom#1881, path 3 of 3). The order used to
  // be write-then-emit, with the emit NON-FATAL — correct while this record
  // was pure cross-clone VISIBILITY, and wrong the moment the 2026-08-21
  // change promoted it to an AUTHORIZATION REVOCATION, because the two halves
  // of the lease lifecycle then failed in OPPOSITE directions:
  //
  //   emit fails on ACQUIRE  -> no grant in the log -> reason "none" -> REFUSE
  //   emit fails on RELEASE  -> the grant PERSISTS in the log -> AUTHORIZE
  //
  // and the caller was told `ok: true` either way. Triggers are ordinary, not
  // exotic: signing key unavailable mid-session, transport/append error, chain
  // contention with a sibling clone. `rules/security.md` § Enforcement-Surface
  // Parity: a control promoted at one surface must be learned at every
  // independent surface, and an indeterminate transition must not WIDEN
  // authority.
  //
  // Emitting first is what eliminates the SPLIT, rather than merely reporting
  // it. Had this returned a typed non-ok while still writing the on-disk
  // release, local state would say "released" while the log — the surface the
  // fence actually reads — still said "granted", with no way for the operator
  // to tell which one the guard would believe. Emit-first has only one
  // failure direction left, and it is the safe one: if the emit SUCCEEDS and
  // the on-disk write then throws, the log says released (no authorization)
  // while the mutex stays held, and re-running the release is idempotent at
  // the fence (`releasedLeaseIds` is a Set, so a duplicate release record
  // changes nothing).
  //
  // The lease is left HELD on failure, NOT wedged: the caller retries, and
  // LEASE_TTL_MS bounds the exposure either way. This is deliberately NOT
  // applied to the `reclaim-stale` emit on the acquire path above — see that
  // site's comment; making that one fatal would convert an emit failure into
  // a permanent lockout on an abandoned lease, and the lease it closes out is
  // by construction already past the TTL the guard independently enforces.
  // `coordRoot` is resolved once at the ownership check above and reused here —
  // the identity the release is OWNED by and the identity it is SIGNED by must
  // come from the same root, or the fence and the log can disagree about who
  // released it.
  const recordEmit = isGovernanceEnabled(coordRoot)
    ? _emitLeaseRecord(
        coordRoot,
        "codify-lease-release",
        {
          lease_id: existing.lease_id,
          released_at: released.released_at,
          action: "release",
          released_by_person_id: owner.person_id,
          owner_axis: ownership.axis,
        },
        o,
      )
    : { ok: true, skipped: true, reason: "governance-disabled" };

  if (!recordEmit || recordEmit.ok !== true) {
    return {
      ok: false,
      reason: "release-record-emit-failed",
      error:
        `releaseCodifyLease: the signed codify-lease-release record could NOT ` +
        `be emitted (${(recordEmit && recordEmit.error) || "unknown"}: ` +
        `${(recordEmit && recordEmit.reason) || "no reason given"}). That ` +
        `record IS the revocation the integrity fence reads, so the lease has ` +
        `NOT been released — it is still HELD, and still authorizes. The ` +
        `on-disk lease was deliberately left untouched so local state and the ` +
        `coordination log cannot disagree about whether the grant exists. ` +
        `Retry the release; the lease TTL bounds the exposure if you cannot.`,
      record_emit: recordEmit,
      lease: existing,
    };
  }

  _atomicWriteJson(leasePath, released);

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
  // The same additive treatment for the OTHER thing a reader cannot otherwise
  // tell about a held lease: whether the signed coordination-log record that
  // makes it visible to sibling clones ever landed. Written by
  // _persistRecordEmitFailure at acquire time; see there for why the durable
  // mark exists and why it is legibility rather than authorization.
  //
  // THE PREDICATE IS `!== false`, NEVER a truthiness test. ABSENT means healthy
  // — every lease written before the mark existed omits the field, and so does
  // every healthy lease after it, so `Boolean(existing.record_emitted)` would
  // report the entire pre-existing population as degraded. Only an EXPLICIT
  // `false`, which only the degraded path writes, is a degradation.
  const recordEmitted = existing.record_emitted !== false;
  return {
    lease: existing,
    leasePath: lp,
    liveness,
    stale: liveness.state === "stale",
    record_emitted: recordEmitted,
    // The typed diagnosis, not a bare boolean: capability, structural?, reason,
    // step, and the measured per-field byte breakdown. Null on a healthy lease,
    // and also null in the one degenerate case where the mark survived but the
    // descriptor did not (a hand-edited or truncated file) — `record_emitted`
    // above still reports the degradation, so nothing is silently downgraded to
    // healthy.
    degraded: recordEmitted ? null : existing.record_emit_degraded || null,
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
  OWNER_AXES,
  // The record/lease spelling of the workspace-journal surface, and its git
  // pathspec twin. Exported so the reader-side test can assert against the SAME
  // constant the writer emits rather than a re-typed copy of it (a re-typed copy
  // is an oracle derived from the test, not from the code under test).
  JOURNAL_ROOT_SCOPE,
  WORKSPACE_JOURNAL_SCOPE,
  WORKSPACE_JOURNAL_PATHSPEC,
  // Test-only — NOT part of the supported API.
  _test_declaredOwnerAxis: _declaredOwnerAxis,
  _test_ownerVerdict: _ownerVerdict,
  _test_scopeFingerprint: _scopeFingerprint,
  _test_sortDedupRel: _sortDedupRel,
  _test_resolveJournalScope: _resolveJournalScope,
  _test_countUnlandedCommits: _countUnlandedCommits,
  _test_classifyBranchFreshness: _classifyBranchFreshness,
  _test_scopeToPathspecs: _scopeToPathspecs,
  _test_describeRecordEmitFailure: _describeRecordEmitFailure,
  _test_classifyLeaseLiveness: _classifyLeaseLiveness,
};
