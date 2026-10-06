#!/usr/bin/env node
/**
 * multi-operator-sessionstart.js — F14 M5 B2 consolidated session-start hook.
 *
 * @hook-event: SessionStart (lifecycle) — the subject is the operator roster,
 *   sibling claims and the coordination log, all durable state on disk before
 *   this session starts; "you're not alone" has to land before the first tool
 *   call to change what the operator does (hook-event-selection.md).
 *
 * Architecture refs:
 *   §4.3 hook table row "multi-operator-sessionstart.js"
 *   §11 M5 row (THE first user-visible behavior signal: "you're not alone")
 *
 * Subsumes `coc-drift-warn.js` (F13 closure). Drift attribution distinguishes
 * own-WIP (this operator's modifications) from claimed-WIP (sibling claims
 * on touched paths), eliminating the F13 false-positive class where
 * .claude/learning/*.jsonl modifications by this session were reported as
 * "cross-operator drift".
 *
 * Surfaces (11):
 *   1.  Own identity (display_id + role + verified_id-tail + posture).
 *   2.  Sibling active claims grouped by display_id + lease-override counts.
 *   3.  Operative posture (computeOperativePosture + partitionAdjustedPosture).
 *   4.  Rules-changed since last session (read-time diff, staleness caveat).
 *   5.  Team-memory index (M7 not yet shipped → "index empty" placeholder).
 *   6.  Peer ref-regression + genesis-generation partition.
 *   7.  Rule-10 revocation-contest surface (forging signer named).
 *   8.  Owner-action audit surface (degenerate-marker via r9s02-fence).
 *   9.  Drift attribution own-WIP vs claimed-WIP (F13 closure).
 *  10.  operator-register UNVERIFIED segregation (R4-S-08).
 *  11.  Pending gate-approvals targeting THIS operator as approver.
 *
 * Hook discipline:
 *   - Event:    SessionStart
 *   - Severity: advisory (never blocks)
 *   - Budget:   10s wall-clock
 *   - Output:   {continue: true} + hookSpecificOutput.additionalContext
 *   - Failure:  fail-open (any error → continue:true with minimal context)
 *
 * @stdin: none — deliberate, per #857. All eleven surfaces derive from
 *   CLAUDE_PROJECT_DIR (see PROJECT_DIR below); the SessionStart `source`
 *   (startup/resume/clear/compact) steers no branch, and the banner is built
 *   from roster + posture + the coordination-log fold, never from the payload.
 *   Declared rather than drained so the hook-runtime-smoke fleet count stays
 *   honest (loom#1380).
 *
 *   This registration is the FOURTH did-not-consume row in #1368's first fleet
 *   run. #1380's body enumerates only three FLAG lines while quoting a summary
 *   of "4 did-not-consume" — this file is the one the enumeration dropped.
 *
 *   NUANCE: #857's rationale (quoted verbatim in runParent) indicts a BLOCKING
 *   `fs.readFileSync(0)` freezing the event loop on an open-no-EOF stdin, which
 *   defeats the setTimeout fallback. lib/read-stdin-bounded.js removes exactly
 *   that failure, so #857 no longer FORBIDS a bounded drain — it just leaves one
 *   pointless here. If a future surface needs the payload, use readStdinBounded
 *   and drop this marker; do NOT reintroduce a synchronous read.
 *
 * Test env overrides (TEST USE ONLY; see m5-b2-lifecycle-hooks.test.js):
 *   COC_TEST_FINGERPRINT, COC_TEST_PERSON_ID — short-circuit identity resolution
 *   COC_TEST_LOCAL_GENESIS_GENERATION, COC_TEST_PEER_GENESIS_GENERATION
 *   COC_TEST_CONTESTED_REVOCATIONS — JSON array of {target_login, forging_signer}
 *   COC_TEST_UNVERIFIED_REGISTRATIONS — JSON array of {display_id, proposed_role}
 *   COC_TEST_PENDING_GATE_APPROVALS — JSON array of gate-approval records
 *   COC_TEST_WORKER_BUDGET_MS — raise the bounded fold-worker budget (default 500ms)
 *     so fold-dependent surfaces render deterministically under parallel test load
 */

"use strict";

const TIMEOUT_MS = 10000;

// setTimeout fallback per cc-artifacts.md Rule 7 — fail-open. Armed as the FIRST
// statement of hookMain() (never at load), so require() of this file schedules
// nothing; the engine requires it once per worker and hookMain re-arms it per run.
let fallback = null;

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
// THE shared git-subprocess allowlist (loom#1462 F1) — see lib/git-subprocess-env.js.
// Never a second copy: two copies of an env allowlist is the shape that leaves
// one of them a variable behind.
const { resolveGitBinary, gitEnv } = require("./lib/git-subprocess-env.js");
// loom#1422 — the own-WIP attribution predicate over `.claude/learning/*.jsonl`
// is a protected-path decision, so it is derived from the shared registry
// rather than re-spelled as an inline regex here.
const { isLearningStateJsonlPath } = require(
  path.join(__dirname, "lib", "guard-path-scope.js"),
);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// #857: worker-mode flag. When present, this process is the HARD-BOUNDED
// child spawned by the parent — it runs the heavy fold-dependent banner build
// DIRECTLY (never the parent spawn path, so there is no fork bomb) and prints
// ONLY the computed additionalContext string to stdout.
const IS_WORKER = process.argv.includes("--coord-worker");

// #866: cache-rebuild flag. When present, this process is the DETACHED,
// UNBUDGETED child spawned by the parent to rebuild the full fold-dependent
// banner OFF the critical path and rewrite the banner cache for the NEXT
// session (see runCacheRebuild). Distinct from --coord-worker (which is the
// hard-BOUNDED, in-budget child the parent waits on).
const IS_CACHE_REBUILD = process.argv.includes("--coord-cache-rebuild");
// Both flags are read from argv AT LOAD, deliberately, and stay here rather than
// inside hookMain(). A load-time argv read is pure (no side effect). And the
// in-process engine sets process.argv = [execPath, <this file>] BEFORE it calls
// hookMain — so under COC_HOOK_ENGINE_SELFTEST=1 (inherited by the worker and
// rebuild children this file spawns) a read inside hookMain would lose the flag
// and send a --coord-worker / --coord-cache-rebuild child down the PARENT path,
// which spawns another worker and another detached rebuild. Read at load, the
// child's real argv decides; inside the dispatcher the module is required under
// the engine's argv, so both are false there, which is the parent path it needs.

// SessionStart hard bound (parent): the worker gets this long to build the
// full fold-dependent banner before it is SIGTERM'd (via spawnSync's `timeout`,
// an OS-level kill that bounds the parent's wait at ~budget+overhead regardless
// of fold duration) and the parent falls back to a lightweight banner.
//
// #857 (REOPENED 2026-07-08): #864 established this hard-bound-worker architecture
// but set the budget to 3.5s. That was too large: on a loom-sized coordination log
// the GPG fold NEVER fits, so the parent blocks the full ~3.5s (+~0.3s overhead)
// then falls back to the lightweight banner ANYWAY — and that ~3.8s total exceeds
// the headless `claude -p` harness's SessionStart deadline (empirically bracketed
// to ~1.1s-3.8s). The harness then CANCELS this hook (exit 1, empty output), which
// on some environments aborts the session before `system/init` and cancels
// SessionEnd (the reopened #857 repro). The fix is a TUNING change within #864's
// architecture: lower the budget so the parent returns well under the harness
// deadline. 500ms (parent ~0.8s) verified to reach init + assistant + result on
// the reopened repro. Since loom's fold never fits ANY budget, a smaller value is
// essentially free on loom (pure startup-latency reduction) and maximizes margin;
// a genuinely small-log downstream repo whose fold fits <500ms still gets the full
// banner via the in-budget worker. Full-banner restoration under a LARGE log is
// #866 (IMPLEMENTED, this file): runParent reads a precomputed full banner from
// the cache (written by the previous session's DETACHED, UNBUDGETED rebuild —
// runCacheRebuild) and emits it instantly when fresh, so the large-log fold that
// never fits ANY budget no longer costs operators the full banner. The advance-
// visibility surfaces are advisory (enforcement is in the PreToolUse hooks), so a
// stale/absent cache degrades to the lightweight fallback — a UX degradation,
// never a correctness/safety loss. The PRODUCTION default stays 500 (do NOT revert
// toward 3.5s — coord-hook-budget's "#857 sessionstart parent" test asserts this
// constant against a 1000ms ceiling and REDs on the revert). That gate reads the
// declaration below directly; the min-of-3 <2000ms LATENCY tripwire it replaced was
// removed by loom#1352 after being measured BLIND to this exact revert whenever the
// #866 banner cache was warm (the fast path never spawns the bounded worker, so no
// parent latency carries information about this constant).
// COC_TEST_WORKER_BUDGET_MS is a TEST-ONLY override (default unchanged at 500 for
// any unset/blank/non-numeric/non-positive value): tests that spawn this hook and
// assert fold-dependent surfaces (contested-revocation / unverified-register /
// pending-gate-approval banners) raise it so the bounded fold worker is NOT
// SIGTERM'd under full-suite parallel CPU starvation — the loom#1259-sibling flake
// class where the 500ms budget was blown by oversubscription, not by any
// production-relevant slowness. The explicit finite-and-positive guard (vs a bare
// `|| 500`) rejects a negative/NaN value at the constant rather than relying on
// spawnSync to throw on a `timeout: -1` (defense-in-depth on the test-only var).
const _testWorkerBudgetMs = Number(process.env.COC_TEST_WORKER_BUDGET_MS);
const WORKER_BUDGET_MS =
  Number.isFinite(_testWorkerBudgetMs) && _testWorkerBudgetMs > 0
    ? _testWorkerBudgetMs
    : 500;

// loom#1474 F8, sibling surface. This already used an argv array (no shell), but
// resolved a bare `git` through the ambient PATH and passed no `env:`. Its one
// call site reads `git status --porcelain -- .claude/ scripts/hooks/` to decide
// what the operator is told about their own working-tree drift, and `cwd:`
// selects a DIRECTORY, not a REPOSITORY. Measured on this hook:
//
//   clean env                     -> "Working-tree drift: 1 own-WIP"
//   GIT_DIR=<evil>/.git           -> "Working-tree drift: 1 own-WIP"  (no effect
//                                     alone — the control that shows the probe
//                                     discriminates)
//   GIT_DIR + GIT_WORK_TREE=<evil> -> the drift line is GONE
//
// so real uncommitted work silently stopped being reported. Routed through the
// same shared allowlist state-resolver.js, coordination-mode.js and
// guard-path-scope.js use (rules/security.md § Enforcement-Surface Parity — one
// shared function, every surface, so they cannot drift). `cmd` is retained in the
// signature for call-site readability but is no longer how the binary is found:
// an unresolvable git returns null exactly as any other git failure already did.
function safeExec(cmd, args) {
  const bin = cmd === "git" ? resolveGitBinary() : cmd;
  if (!bin) return null;
  try {
    return execFileSync(bin, args, {
      cwd: PROJECT_DIR,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      env: cmd === "git" ? gitEnv() : undefined, // NOTHING inherited for git
    });
  } catch {
    return null;
  }
}

function safeJsonParse(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function loadRoster(repoDir) {
  const p = path.join(repoDir, ".claude", "operators.roster.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function resolveOwnIdentity(repoDir) {
  // Test short-circuit: explicit fingerprint + person_id via env.
  const testFp = process.env.COC_TEST_FINGERPRINT;
  const testPid = process.env.COC_TEST_PERSON_ID;
  if (testFp && testPid) {
    const roster = loadRoster(repoDir);
    let display_id = null;
    let role = null;
    let host_role = null;
    // S60: own-key fence BEFORE the lookup — `testPid` is env-supplied, so an
    // `Object.prototype`-shadowing value ("constructor", "__proto__", …) would
    // resolve TRUTHY on a roster holding no such person and enter this branch
    // with a non-person object. An inherited member is never a rostered person.
    if (
      roster &&
      roster.persons &&
      Object.prototype.hasOwnProperty.call(roster.persons, testPid)
    ) {
      const person = roster.persons[testPid] || {};
      display_id = person.display_id || null;
      role = person.role || null;
      host_role = person.host_role || null;
    }
    return {
      verified_id: testFp,
      person_id: testPid,
      display_id,
      role,
      host_role,
    };
  }
  // Production path: use operator-id.js resolver.
  try {
    const { resolveIdentity } = require(
      path.join(__dirname, "lib", "operator-id.js"),
    );
    return resolveIdentity(repoDir, {});
  } catch {
    return null;
  }
}

// loom#1461 — the LOWEST rung. An unresolvable posture ranks here, never at
// L5: this banner is the first thing a session reads and it shapes the whole
// plan before any tool call fires, so "we could not tell" must not read as
// "you have maximum autonomy".
const UNRESOLVABLE_POSTURE = "L1_PSEUDO_AGENT";

/**
 * Read the posture STATE and carry WHY it is what it is.
 *
 * F42 (2026-05-26): route through the SSOT reader in lib/state-io.js so
 * v1-on-disk inputs auto-migrate to v2 shape AND multi-operator consumers
 * (computeOperativePosture below) get the schema_version: 2 + repo_floor +
 * operators surface they require. Pre-F42 this function returned the raw
 * v1 file shape, which silently dropped through computeOperativePosture's
 * null-guard into the L5_DELEGATED default for every operator — the
 * "looks correct, structurally inert" trap the F42 brief flags.
 *
 * loom#1461 — it returned a BARE `null` for three unrelated facts: a genuinely
 * fresh repo, a fail-CLOSED L1 verdict, and "the reader threw". All three then
 * landed on the same `L5_DELEGATED (source=default)` banner, so a state-io
 * refusal was rendered as maximum trust and was indistinguishable from a real
 * one (rules/instrument-discipline.md MUST-1: a result consistent with both
 * branches of the hypothesis is evidence for neither). The `kind` discriminator
 * is what lets the surface below rank each of them differently.
 *
 * The WORKTREE half of #1461 is NOT fixed here and needs no fix: state-io's
 * `readPosture` resolves through `resolveStateDirDetailed`, which folds a linked
 * worktree onto `<main-checkout>/.claude/learning` via `--git-common-dir`. What
 * remained was this function collapsing that reader's verdicts.
 */
function readPostureState(repoDir) {
  try {
    const { readPosture: ssotRead } = require(
      path.join(__dirname, "lib", "state-io.js"),
    );
    const posture = ssotRead(repoDir);
    if (!posture || typeof posture !== "object") {
      return {
        posture: null,
        kind: "unreadable",
        reason: "reader returned no posture object",
      };
    }
    if (posture._fail_closed === true) return { posture, kind: "fail-closed" };
    if (posture._fresh === true) return { posture, kind: "fresh-repo" };
    return { posture, kind: "state" };
  } catch (err) {
    return {
      posture: null,
      kind: "unreadable",
      reason: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Rank the operative posture for the banner, and NAME which fact produced it.
 *
 * Every `source` value is distinguishable, which is loom#1461's third acceptance
 * criterion: a reader must be able to tell a real L5 from an unresolved one.
 *   operator | floor | min          — a genuine computation over posture.json
 *   fresh-repo                      — trust-posture.md MUST-2: no state, no init
 *                                     marker ⇒ L5. The ONLY surviving L5-default.
 *   fail-closed                     — state-io already ranked it L1.
 *   floor-unidentified-operator     — state EXISTS, this operator does not
 *                                     resolve to a person_id.
 *   unresolvable                    — the read or the computation failed.
 *
 * WHY THE UNIDENTIFIED-OPERATOR ARM IS NOT L5. It used to be: `!identity.person_id`
 * returned `L5_DELEGATED (source=default)` and threw away a repo_floor sitting
 * right there in the object it had just read. An un-rostered operator in an L3
 * repo was therefore shown MORE autonomy than any rostered one, i.e. the control
 * was weakest exactly where identity was weakest.
 *
 * WHY IT IS NOT A HARDCODED min(floor, L2_SUPERVISED) EITHER, which is the
 * obvious move and is wrong. `computeOperativePosture` applies L2_SUPERVISED as
 * the default for a person with no entry in `posture.operators` — a sound default
 * for an unknown ROSTERED operator, and exactly the forced-L2 nag MO-OPT W1-d
 * removed for a SOLO repo, where there is no roster to have an entry in. Hardcoding
 * it here would reinstate that disruption for every solo repo that has ever written
 * a posture.json.
 *
 * So the ceiling is taken from the RESOLVER'S OWN disposition instead of invented
 * here: `operator-id.js` populates `identity.posture` (L2_SUPERVISED) precisely on
 * the degraded branches — un-rostered key, no key configured — and deliberately
 * OMITS it on the synthetic solo identity so the gate layer applies the repo's own
 * default. Reading that field gives min(floor, L2) where the resolver asked for
 * supervision and the bare floor where it did not, in ONE rule with no
 * special-casing. Both are strictly tighter than the L5 this replaced.
 */
function computePostureSurface(read, identity) {
  if (!read || typeof read !== "object" || read.kind === "unreadable") {
    return { posture: UNRESOLVABLE_POSTURE, source: "unresolvable" };
  }
  if (read.kind === "fail-closed") {
    const p =
      read.posture && typeof read.posture.posture === "string"
        ? read.posture.posture
        : UNRESOLVABLE_POSTURE;
    return { posture: p, source: "fail-closed" };
  }
  if (read.kind === "fresh-repo") {
    return { posture: "L5_DELEGATED", source: "fresh-repo" };
  }
  try {
    const { computeOperativePosture, minPosture, POSTURE_LADDER } = require(
      path.join(__dirname, "lib", "posture-v2.js"),
    );
    if (identity && identity.person_id) {
      return computeOperativePosture(read.posture, identity.person_id);
    }
    const floor =
      read.posture &&
      read.posture.repo_floor &&
      typeof read.posture.repo_floor.posture === "string"
        ? read.posture.repo_floor.posture
        : null;
    if (!floor || !POSTURE_LADDER.includes(floor)) {
      // State present but its floor is absent or not a ladder rung — that is
      // corrupt state, not a fresh repo. Rank it with the other things we could
      // not determine rather than letting an unknown string reach minPosture,
      // which throws on one.
      return { posture: UNRESOLVABLE_POSTURE, source: "unresolvable" };
    }
    // The resolver's OWN ceiling when it set one (degraded identity ⇒
    // L2_SUPERVISED); the bare floor when it deliberately did not (solo).
    const ceiling =
      identity &&
      typeof identity.posture === "string" &&
      POSTURE_LADDER.includes(identity.posture)
        ? identity.posture
        : null;
    return {
      posture: ceiling ? minPosture(floor, ceiling) : floor,
      source: "floor-unidentified-operator",
    };
  } catch {
    return { posture: UNRESOLVABLE_POSTURE, source: "unresolvable" };
  }
}

function readFoldedLog(repoDir) {
  // S61 — a fold that THREW is NOT an empty log, and this function used to
  // report the two identically: `catch { return { accepted: [], ... } }`, so
  // `projectActiveSiblingClaims` rendered "no sibling activity" on evidence
  // supporting only "the fold died" (rules/instrument-discipline.md MUST-1 —
  // an instrument whose output is constant across the hypothesis carries zero
  // information). A sibling operator may hold an active claim that the fold
  // which would have shown it could not compute.
  //
  // The fix follows the shape already in this corpus — adjacency-leasecheck.js
  // (`readIndeterminate` → halt-and-report), integrity-guard.js and
  // journal-write-guard.js (`readIndeterminate` → block): set the reason in the
  // catch, and GUARD ON IT at the consumer BEFORE any empty array can be read.
  // `indeterminate` is `null` on every success path, so an existing caller that
  // ignores it is unchanged in behaviour — but the discriminating fact now
  // EXISTS to be read, where before it was destroyed at the catch.
  //
  // Severity here is advisory/report, NOT block: this is a SessionStart
  // INFORMATIONAL surface, not a mutation fence. The two mutation fences on
  // this same predicate (integrity-guard, journal-write-guard) take `block`
  // because their off-branch lets an unauthorized write land; this one's does
  // not — the same proportionality adjacency-leasecheck.js records.
  try {
    const { foldLog } = require(
      path.join(__dirname, "lib", "coordination-log.js"),
    );
    const { createFilesystemTransport } = require(
      path.join(__dirname, "lib", "transport-filesystem.js"),
    );
    const transport = createFilesystemTransport(repoDir);
    // Synchronous deopt: spawn a single sync read via fs to avoid async at
    // hook-top-level. We mirror the transport's readAllRecords contract.
    const logPath = transport._logPath;
    if (!fs.existsSync(logPath)) {
      // A genuinely ABSENT log is determinate: there are no sibling claims.
      // This is the one empty-return that is NOT indeterminate.
      return {
        accepted: [],
        contestedRevocations: [],
        foldState: null,
        indeterminate: null,
      };
    }
    const raw = fs.readFileSync(logPath, "utf8");
    const records = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const obj = safeJsonParse(line);
      if (obj && typeof obj === "object") records.push(obj);
    }
    const roster = loadRoster(repoDir);
    const result = foldLog(records, roster, {});
    return {
      accepted: result.accepted || [],
      contestedRevocations: result.contestedRevocations || [],
      foldState: result.foldState || null,
      indeterminate: null,
    };
  } catch (err) {
    // The empty arrays are RETAINED so no caller crashes on shape, but they are
    // now accompanied by the fact that discriminates them from a real empty log.
    // Any consumer reporting on sibling activity MUST guard on `indeterminate`
    // FIRST — see the call site in main(), which does.
    return {
      accepted: [],
      contestedRevocations: [],
      foldState: null,
      indeterminate: err && err.message ? err.message : String(err),
    };
  }
}

function projectActiveSiblingClaims(accepted, ownFingerprint) {
  if (!Array.isArray(accepted)) return [];
  const released = new Set();
  const reaped = new Set();
  for (const r of accepted) {
    if (!r || typeof r !== "object") continue;
    if (r.type === "release" && r.content && r.content.claim_id) {
      released.add(r.content.claim_id);
    } else if (r.type === "reap" && r.content && r.content.claim_id) {
      reaped.add(r.content.claim_id);
    }
  }
  const claims = [];
  for (const r of accepted) {
    if (!r || r.type !== "claim") continue;
    if (r.verified_id === ownFingerprint) continue;
    const claimId = r.content && r.content.claim_id ? r.content.claim_id : null;
    if (!claimId) continue;
    if (released.has(claimId)) continue;
    if (reaped.has(claimId)) continue;
    claims.push({
      claim_id: claimId,
      verified_id: r.verified_id,
      display_id: r.display_id || null,
      person_id: r.person_id || null,
      path: (r.content && r.content.path) || null,
      glob: (r.content && r.content.glob) || null,
      dir: (r.content && r.content.dir) || null,
    });
  }
  return claims;
}

function countLeaseOverrides(accepted, againstPersonId) {
  if (!Array.isArray(accepted) || !againstPersonId) return 0;
  let n = 0;
  for (const r of accepted) {
    if (!r || r.type !== "lease-override") continue;
    if (r.content && r.content.against_person_id === againstPersonId) n++;
  }
  return n;
}

function detectPartition(foldState, accepted) {
  try {
    const { detectPostMigrationPartition } = require(
      path.join(__dirname, "lib", "fold-rule-9d.js"),
    );
    // Test override
    const localStr = process.env.COC_TEST_LOCAL_GENESIS_GENERATION;
    const peerStr = process.env.COC_TEST_PEER_GENESIS_GENERATION;
    if (localStr !== undefined && peerStr !== undefined) {
      const local = parseInt(localStr, 10);
      const peer = parseInt(peerStr, 10);
      if (Number.isFinite(local) && Number.isFinite(peer)) {
        // Synthesize an accepted-record set with one migration to peer.
        return detectPostMigrationPartition({
          localGenesisGeneration: local,
          acceptedRecords: [
            {
              type: "genesis-migration",
              content: { to_genesis_generation: peer },
            },
          ],
        });
      }
    }
    const localGen =
      foldState && typeof foldState.genesis_generation === "number"
        ? foldState.genesis_generation
        : 0;
    return detectPostMigrationPartition({
      localGenesisGeneration: localGen,
      acceptedRecords: accepted || [],
    });
  } catch {
    return { partitioned: false };
  }
}

function applyPartitionCap(operativePostureResult, partitionResult) {
  try {
    const { partitionAdjustedPosture } = require(
      path.join(__dirname, "lib", "posture-v2.js"),
    );
    return partitionAdjustedPosture(
      operativePostureResult.posture,
      partitionResult,
    );
  } catch {
    return operativePostureResult.posture;
  }
}

function detectDrift(repoDir, identity, activeSiblingClaims) {
  // Drift attribution closes F13. We scan the working tree for changes
  // under .claude/** and scripts/hooks/**, then partition:
  //   own-WIP:     uncommitted changes on paths NOT covered by any active
  //                sibling claim — this is the operator's own working set.
  //   claimed-WIP: uncommitted changes on paths covered by an active sibling
  //                claim — actually-cross-operator content (rare).
  //
  // Paths under .claude/learning/*.jsonl (observations, posture state,
  // violations) are ALWAYS attributed to own-WIP per the architecture
  // §4.3 hook-table row (F13 false-positive class).
  const status = safeExec("git", [
    "status",
    "--porcelain",
    "--",
    ".claude/",
    "scripts/hooks/",
  ]);
  if (!status) return { ownWip: [], claimedWip: [], errored: false };
  const lines = status.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { ownWip: [], claimedWip: [], errored: false };
  const ownWip = [];
  const claimedWip = [];
  for (const l of lines) {
    const filePath = l.slice(3).trim();
    // .claude/learning/*.jsonl ALWAYS = own-WIP (F13 closure). loom#1422: the
    // predicate is shared, not re-spelled here — this was the fifth site
    // deciding `.claude/learning/` membership on its own, and the one no prior
    // sweep listed.
    if (isLearningStateJsonlPath(filePath)) {
      ownWip.push({ path: filePath, attribution: "own-wip-learning-jsonl" });
      continue;
    }
    // Check against sibling claims
    let matched = false;
    for (const c of activeSiblingClaims) {
      if (c.path && filePath === c.path) {
        claimedWip.push({
          path: filePath,
          attribution: "claimed-wip",
          sibling: c.display_id || c.person_id || c.verified_id,
        });
        matched = true;
        break;
      }
      if (c.dir && filePath.startsWith(c.dir + "/")) {
        claimedWip.push({
          path: filePath,
          attribution: "claimed-wip-dir",
          sibling: c.display_id || c.person_id || c.verified_id,
        });
        matched = true;
        break;
      }
    }
    if (!matched) {
      ownWip.push({ path: filePath, attribution: "own-wip" });
    }
  }
  return { ownWip, claimedWip, errored: false };
}

function detectRulesChangedSinceLastSession() {
  // Read-time diff: compare HEAD's .claude/rules/ vs the operator's last
  // recorded session-end commit hash (cached in
  // .claude/learning/.session-end-cache). With no cache: no surface.
  // Staleness caveat: this is HEAD-vs-cache; live remote drift is the
  // coc-drift-warn upstream-lag axis, now subsumed below.
  // For now, return null (no surface) when no cache; this is the
  // architecturally-honest "staleness caveat acknowledged in output line"
  // path.
  return null;
}

// detectUpstreamLag (the passive .claude/-scoped upstream-lag warning) was REPLACED by
// the active start-refresh (ECO-IMPL W8b / G-A-T3) — `lib/ecosystem-pull-merge.js`
// runStartRefresh Op1 does the active whole-tree ff-only pull (the co-owner's "always
// pull and merge at start" D2 directive) that supersedes the prior warn-only behavior.

function detectRevocationContests(contestedFromFold) {
  // Test override: explicit JSON array of contested revocations.
  const testRaw = process.env.COC_TEST_CONTESTED_REVOCATIONS;
  if (testRaw) {
    const parsed = safeJsonParse(testRaw);
    if (Array.isArray(parsed)) return parsed;
  }
  if (!Array.isArray(contestedFromFold)) return [];
  return contestedFromFold.map((c) => ({
    target_login:
      (c.record && c.record.content && c.record.content.github_login) ||
      "unknown",
    forging_signer:
      c.forging_signer || (c.record && c.record.person_id) || "unknown",
    reason: c.reason || "rule-10 contest",
  }));
}

function detectUnverifiedRegistrations(accepted) {
  const testRaw = process.env.COC_TEST_UNVERIFIED_REGISTRATIONS;
  if (testRaw) {
    const parsed = safeJsonParse(testRaw);
    if (Array.isArray(parsed)) return parsed;
  }
  if (!Array.isArray(accepted)) return [];
  // operator-register records that did NOT resolve to a rostered person
  // are surfaced as UNVERIFIED self-claims (R4-S-08).
  const out = [];
  for (const r of accepted) {
    if (!r || r.type !== "operator-register") continue;
    // Without further fold context (caller did not record rostered status),
    // we conservatively surface every operator-register as advisory.
    out.push({
      display_id: r.display_id || "(no display_id)",
      proposed_role: (r.content && r.content.proposed_role) || "(unspecified)",
    });
  }
  return out;
}

function detectPendingGateApprovals(accepted, ownVerifiedId) {
  // M5 iter-6 Sec-MED-A3: cross-check signer (verified_id) against the
  // record's claimed requester_verified_id. Pre-iter-6 the surface
  // trusted the content fields without verifying the signer matches the
  // claimed requester — an attacker could craft a gate-approval naming
  // a different operator as the approver, sign it with their OWN key,
  // and have it surface as a legitimate pending approval. The fold
  // engine's rule-1 still enforces signer ∈ roster (auth-bypass at
  // fold-time is not the failure mode); the failure mode is MISLEADING
  // CONTEXT in the operator's session-start view. Cross-check fires here
  // → malformed records segregate into a separate MALFORMED section so
  // the operator can adjudicate.
  //
  // Both legitimate and malformed records flow through the same
  // flattening shape; the `malformed: true` field discriminates.
  const records = (() => {
    const testRaw = process.env.COC_TEST_PENDING_GATE_APPROVALS;
    if (testRaw) {
      const parsed = safeJsonParse(testRaw);
      if (Array.isArray(parsed)) return parsed;
    }
    return Array.isArray(accepted) ? accepted : [];
  })();
  if (!ownVerifiedId) return [];
  const out = [];
  for (const r of records) {
    if (!r) continue;
    // Two record shapes supported:
    //   (a) Full coordination-log record: {type: "gate-approval",
    //       verified_id, person_id, display_id, content: {...}, ts}.
    //       Cross-check fires.
    //   (b) Legacy flat shape (pre-iter-6 test fixtures): top-level
    //       {requester_display_id, target_tool, consumed_nonce,
    //       approver_verified_id, ts}. Cross-check cannot fire
    //       (no signer field) — surfaces in main section.
    const isFullRecord = r.type === "gate-approval";
    if (isFullRecord) {
      const content = r.content || {};
      if (content.approver_verified_id !== ownVerifiedId) continue;
      const signerVerifiedId = r.verified_id;
      const requesterVerifiedId = content.requester_verified_id;
      const malformed =
        !signerVerifiedId ||
        !requesterVerifiedId ||
        signerVerifiedId !== requesterVerifiedId;
      out.push({
        requester_display_id: r.display_id || "(unknown)",
        requester_person_id:
          content.requester_person_id || r.person_id || "(unknown)",
        requester_verified_id: requesterVerifiedId || "(missing)",
        signer_verified_id: signerVerifiedId || "(missing)",
        approver_verified_id: content.approver_verified_id || "(missing)",
        target_tool: content.target_tool || "(unspecified)",
        consumed_nonce: content.consumed_nonce || "(missing)",
        ts: r.ts || "(no-ts)",
        malformed,
      });
      continue;
    }
    // Legacy flat shape — pre-iter-6 test fixtures inject this directly.
    // R8-MED env-gate (M6 D Step 4b): production records MUST flow
    // through the full-record branch above so the signer-vs-requester
    // cross-check fires. The legacy flat shape lacks a signer field;
    // accepting it in production would silently mask the malformed-
    // detection the Sec-MED-A3 close requires. Gate strictly on the
    // test env-var so production paths only honor the full-record
    // shape; under the env-var the legacy branch is active only for
    // the existing pre-iter-6 fixture suite.
    if (!process.env.COC_TEST_PENDING_GATE_APPROVALS) continue;
    // Filter by top-level approver_verified_id.
    if (r.approver_verified_id !== ownVerifiedId) continue;
    out.push({
      requester_display_id: r.requester_display_id || "(unknown)",
      requester_person_id: r.requester_person_id || "(unknown)",
      requester_verified_id: r.requester_verified_id || "(missing)",
      signer_verified_id: "(missing)",
      approver_verified_id: r.approver_verified_id || "(missing)",
      target_tool: r.target_tool || "(unspecified)",
      consumed_nonce: r.consumed_nonce || "(missing)",
      ts: r.ts || "(no-ts)",
      malformed: false, // legacy shape cannot prove signer; trusted-by-construction
    });
  }
  return out;
}

function detectOwnerActionAudit(roster, foldedState) {
  // §2.3 owner-accountability + r9s02-fence degenerate-marker surface.
  try {
    const {
      gateEligibleForSelfSignedCheckpointOrRotation,
      isRevocationInducedSingleton,
    } = require(path.join(__dirname, "lib", "r9s02-fence.js"));
    const isRevoInduced = isRevocationInducedSingleton(roster, foldedState);
    return {
      degenerate_marker: isRevoInduced
        ? "revocation-induced-N=1"
        : "genuine-or-N>=2",
      eligible: gateEligibleForSelfSignedCheckpointOrRotation(
        roster,
        foldedState,
      ),
    };
  } catch {
    return { degenerate_marker: "unknown", eligible: null };
  }
}

// ---- banner builders --------------------------------------------------------

/**
 * #857: the CHEAP surfaces only — identity + operative posture. No fold, no
 * GPG. Used by the parent to render a banner WITHOUT the worker AND as the
 * fallback when the worker exceeds the startup budget. Takes the pre-computed
 * identity + operativeRes so the parent does not resolve them twice.
 */
function buildLightweightBanner(identity, operativeRes) {
  const lines = [];
  lines.push("=== Multi-Operator Session Start ===");
  if (identity && identity.display_id) {
    const role = identity.role || "(no role)";
    const vid = identity.verified_id
      ? identity.verified_id.slice(-12)
      : "(no vid)";
    lines.push(
      `Operator: ${identity.display_id} [role=${role}, vid=...${vid}]`,
    );
  } else {
    lines.push("Operator: (unrostered or no signing key — L2_SUPERVISED)");
  }
  // loom#1461 — a MISSING operativeRes is not a maximally-trusted one. The old
  // fallback was `L5_DELEGATED (source=default)`, which is the exact string the
  // issue reported reading in a worktree, and it fired precisely when the surface
  // above had failed to produce a verdict. Rank it with the other unknowns.
  const posture =
    operativeRes && operativeRes.posture
      ? operativeRes.posture
      : UNRESOLVABLE_POSTURE;
  const source =
    operativeRes && operativeRes.source ? operativeRes.source : "unresolvable";
  lines.push(`Operative posture: ${posture} (source=${source})`);
  lines.push(
    `Coordination state check skipped (startup budget ${WORKER_BUDGET_MS}ms exceeded) — sibling-claim/partition surfaces unavailable this session.`,
  );
  return lines.join("\n");
}

/**
 * #857: the FULL fold-dependent 11-surface banner. This is the GPG-heavy path
 * (readFoldedLog verifies every signed coordination-log record). It runs in
 * the WORKER process (off the harness critical path); the worker prints the
 * returned string to stdout and the parent captures it. Returns the
 * additionalContext STRING only — the parent owns the {continue:true} envelope.
 */
function buildFullBanner() {
  const identity = resolveOwnIdentity(PROJECT_DIR);
  const roster = loadRoster(PROJECT_DIR);
  const postureRead = readPostureState(PROJECT_DIR);
  const operativeRes = computePostureSurface(postureRead, identity || {});

  const folded = readFoldedLog(PROJECT_DIR);
  const activeSiblingClaims = projectActiveSiblingClaims(
    folded.accepted,
    identity ? identity.verified_id : null,
  );
  const overrideCount = countLeaseOverrides(
    folded.accepted,
    identity ? identity.person_id : null,
  );
  const partition = detectPartition(folded.foldState, folded.accepted);
  const cappedPosture = applyPartitionCap(operativeRes, partition);
  const driftAttribution = detectDrift(
    PROJECT_DIR,
    identity,
    activeSiblingClaims,
  );
  // #857 security MED-2: the active start-refresh (runStartRefresh) runs a
  // WORKING-TREE mutation (`git merge --ff-only`). It MUST NOT run in this
  // hard-bounded worker — a SIGTERM at the WORKER_BUDGET_MS budget mid-merge could leave a
  // .git/index.lock / partial worktree that breaks the NEXT session. It now runs
  // ONCE in the PARENT (runParent), which is never SIGTERM'd mid-op, and the
  // parent appends its surface line(s) to whatever banner this worker returns.
  const rulesChanged = detectRulesChangedSinceLastSession();
  const revocationContests = detectRevocationContests(
    folded.contestedRevocations,
  );
  const unverifiedRegs = detectUnverifiedRegistrations(folded.accepted);
  const pendingGates = detectPendingGateApprovals(
    folded.accepted,
    identity ? identity.verified_id : null,
  );
  const ownerAudit = detectOwnerActionAudit(roster, {
    records: folded.accepted,
  });

  // Build the additionalContext block (the 11 surfaces).
  const lines = [];
  lines.push("=== Multi-Operator Session Start ===");

  // 1. Own identity
  if (identity && identity.display_id) {
    const role = identity.role || "(no role)";
    const vid = identity.verified_id
      ? identity.verified_id.slice(-12)
      : "(no vid)";
    lines.push(
      `Operator: ${identity.display_id} [role=${role}, vid=...${vid}]`,
    );
  } else {
    lines.push("Operator: (unrostered or no signing key — L2_SUPERVISED)");
  }

  // 3. Operative posture (always surface; partition cap below)
  //
  // S61 MEDIUM-1 — the partition CAP is fold-derived. `detectPartition` defaults
  // `localGenesisGeneration` to 0 when `foldState` is null, so on a DEAD fold it
  // returns `{partitioned:false}` and `applyPartitionCap` does not cap: the
  // banner then positively asserts "no partition" on evidence supporting only
  // "the fold died", silently skipping a posture downgrade. Say UNKNOWN instead.
  // (Bounded honestly: this line is banner TEXT, not an enforcement decision —
  // a misleading surface, not an authz bypass.)
  lines.push(
    `Operative posture: ${cappedPosture}` +
      (folded.indeterminate
        ? " (partition status UNKNOWN — the coordination log could not be folded, so any partition cap could NOT be evaluated)"
        : partition && partition.partitioned
          ? ` (capped from ${operativeRes.posture} — partition detected: ${partition.reason || "local-genesis-gen below peer-high-water"})`
          : ` (source=${operativeRes.source})`),
  );

  // Coordination-mode tamper/ambiguity surface (MO-OPT W1 G1 R2). When a
  // security-relevant coordination-mode warning is present — a REFUSED
  // enrolled-disable (a planted local-override {enabled:false} on this enrolled
  // repo) or an indeterminate-enrollment OFF — surface it advisory so the
  // disposition is NOT silent. The predicate's warning rides the rich result
  // of coordinationMode(); the ergonomic isCoordinationEnabled() boolean the
  // guards call discards it, so session-start is the operator-facing surface.
  try {
    const { coordinationMode } = require(
      path.join(__dirname, "lib", "coordination-mode.js"),
    );
    const cm = coordinationMode(PROJECT_DIR);
    if (cm && cm.warning) {
      lines.push(`⚠️  coordination-mode (${cm.source}): ${cm.warning}`);
    }
  } catch {
    // advisory surface only; never block session-start
  }

  // 6. Peer ref-regression + genesis-generation partition (advisory line)
  if (partition && partition.partitioned) {
    lines.push(
      `⚠️  partition: local_genesis_generation=${partition.local_genesis_generation}, peer_high_water=${partition.peer_high_water_generation}`,
    );
  }

  // 2. Sibling active claims
  // S61 — GUARD ON `indeterminate` BEFORE reading the (possibly empty-because-
  // dead) accepted array. A fold that threw cannot distinguish "no sibling
  // claims" from "the instrument that would have shown them failed", and the
  // `else` branch below states the former as fact. Reporting UNKNOWN is the
  // fail-closed reading (rules/instrument-discipline.md MUST-1); this mirrors
  // adjacency-leasecheck.js's `readIndeterminate` disposition, at the advisory
  // severity proportionate to an informational SessionStart surface.
  if (folded.indeterminate) {
    lines.push(
      `⚠️  Sibling active claims: UNKNOWN — the coordination log could not be folded (${folded.indeterminate}).`,
    );
    lines.push(
      "    This is NOT 'no claims': a sibling operator may hold an active claim on a path you are about to edit.",
    );
    lines.push(
      "    Remediation: ensure .claude/learning/coordination-log.jsonl is readable and well-formed, then restart the session.",
    );
  } else if (activeSiblingClaims.length > 0) {
    const grouped = new Map();
    for (const c of activeSiblingClaims) {
      const k = c.display_id || c.person_id || c.verified_id || "(unknown)";
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(c);
    }
    lines.push(`Sibling active claims (${activeSiblingClaims.length}):`);
    for (const [k, list] of grouped) {
      lines.push(`  - ${k}: ${list.length} claim(s)`);
    }
  } else {
    lines.push("Sibling active claims: none");
  }
  if (overrideCount > 0) {
    lines.push(`Lease-overrides against you (30d): ${overrideCount}`);
  }

  // S61 MEDIUM-1 — ONE consolidated notice for every REMAINING fold-derived
  // surface in this banner. Each of these renders a dead fold and a clean log
  // identically, asserting "none" by ABSENCE — the exact defect this change
  // names. `activeSiblingClaims` and the posture line are handled at their own
  // call sites above; these four have no natural "none" line to amend, so the
  // honest surface is to state plainly that they were never computed.
  if (folded.indeterminate) {
    lines.push(
      "⚠️  Also UNKNOWN (not 'none') because the fold failed: lease-overrides, " +
        "owner-action audit, unverified self-claims, pending gate-approvals, " +
        "rule-10 revocation contests, and claimed-WIP drift attribution.",
    );
    lines.push(
      "    Each is derived from the same dead fold; their absence below is not evidence of absence.",
    );
    lines.push(
      "    Note: the rule-10 contest alarm is the surface that would flag a hostile revocation — " +
        "it printed nothing here because it could not run, NOT because nothing was found.",
    );
  }

  // 7. Rule-10 revocation contests
  if (revocationContests.length > 0) {
    lines.push("🚨 Contested revocations (rule 10):");
    for (const c of revocationContests) {
      lines.push(
        `  - target=${c.target_login} forging_signer=${c.forging_signer}${c.reason ? ` reason=${c.reason}` : ""}`,
      );
    }
  }

  // 8. Owner-action audit (degenerate-marker)
  if (
    ownerAudit &&
    ownerAudit.degenerate_marker &&
    ownerAudit.degenerate_marker !== "unknown"
  ) {
    lines.push(
      `Owner-action audit: degenerate_marker=${ownerAudit.degenerate_marker}`,
    );
  }

  // 9. Drift attribution (own-WIP vs claimed-WIP) — F13 closure
  //
  // S61 ROUND-3 — CORRECTION to the round-2 note, which claimed `ownWip`
  // "comes from the working tree" and is therefore unaffected. Its PATH LIST
  // does; its MEMBERSHIP does not. `detectDrift` pushes to `ownWip` precisely
  // when a path matches NO sibling claim, and `activeSiblingClaims` is
  // fold-derived — so on a dead fold it is `[]`, the inner loop never runs, and
  // EVERY drifted path is attributed own-WIP, including ones a sibling holds.
  // `ownWip` is therefore an UPPER BOUND, not a count, and is labelled as one.
  // Banner text, not enforcement.
  if (
    driftAttribution.ownWip.length > 0 ||
    driftAttribution.claimedWip.length > 0
  ) {
    lines.push(
      (folded.indeterminate
        ? `Working-tree drift: ${driftAttribution.ownWip.length} drifted path(s), ` +
          "attribution UNKNOWN (fold failed — every path defaulted to own-WIP " +
          "because sibling claims could not be read; some may be sibling-claimed)"
        : `Working-tree drift: ${driftAttribution.ownWip.length} own-WIP, ` +
          `${driftAttribution.claimedWip.length} claimed-WIP`),
    );
    if (driftAttribution.claimedWip.length > 0) {
      lines.push("  ⚠️  Claimed-WIP (cross-operator drift):");
      for (const w of driftAttribution.claimedWip.slice(0, 5)) {
        lines.push(`    - ${w.path} (sibling: ${w.sibling})`);
      }
    }
    // own-WIP is informational (and notably, .claude/learning/*.jsonl is
    // ALWAYS attributed to own-WIP — F13 false-positive closed).
  }

  // #857 security MED-2: the start-refresh surface is appended by the PARENT
  // (buildStartRefreshLines in runParent) — its git working-tree mutation was
  // moved out of this SIGTERM-able worker. See the note above.

  // 4. Rules-changed since last session (staleness caveat)
  if (rulesChanged && rulesChanged.length > 0) {
    lines.push(
      `Rules changed since last session: ${rulesChanged.length} (caveat: HEAD-vs-last-session-cache, NOT live remote)`,
    );
  }

  // 5. Team-memory index — M9.1 R4 Sec-R4-S-07: walk .claude/team-memory/
  // per `knowledge-convergence.md` MUST-5 (Onboard surfaces include team
  // memory). M7 (PR #324) shipped team-memory at .claude/team-memory/;
  // pre-fix this line was stale placeholder text.
  try {
    const tmDir = path.join(PROJECT_DIR, ".claude", "team-memory");
    if (fs.existsSync(tmDir)) {
      const entries = fs
        .readdirSync(tmDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md"));
      if (entries.length === 0) {
        lines.push("Team-memory: index empty (no facts promoted)");
      } else {
        const slugs = entries
          .map((e) => e.name.replace(/\.md$/, ""))
          .sort()
          .join(", ");
        lines.push(`Team-memory: ${entries.length} facts (${slugs})`);
      }
    } else {
      lines.push("Team-memory: directory absent");
    }
  } catch {
    lines.push("Team-memory: index read failed (best-effort)");
  }

  // 10. UNVERIFIED self-claims segregation (R4-S-08)
  if (unverifiedRegs.length > 0) {
    lines.push("--- UNVERIFIED self-claims (advisory only) ---");
    for (const u of unverifiedRegs) {
      lines.push(
        `  - ${u.display_id} (proposed_role=${u.proposed_role || "(unspecified)"})`,
      );
    }
  }

  // 11. Pending gate-approvals targeting THIS operator as approver.
  // Sec-MED-A3 (M5 iter-6): segregate signer-vs-requester mismatches.
  const legitGates = pendingGates.filter((g) => !g.malformed);
  const malformedGates = pendingGates.filter((g) => g.malformed);
  if (legitGates.length > 0) {
    lines.push(
      `Pending gate-approvals awaiting your approval (${legitGates.length}):`,
    );
    for (const g of legitGates) {
      lines.push(
        `  - requester ${g.requester_display_id} [${g.requester_person_id}] → ${g.target_tool} (nonce=${g.consumed_nonce}, ts=${g.ts}, approver_claim=${g.approver_verified_id})`,
      );
    }
  }
  if (malformedGates.length > 0) {
    lines.push(
      `MALFORMED gate-approvals (signer-vs-requester mismatch — DO NOT trust without out-of-band verification) (${malformedGates.length}):`,
    );
    for (const g of malformedGates) {
      lines.push(
        `  - requester_claim=${g.requester_display_id} [${g.requester_person_id}] → ${g.target_tool} (nonce=${g.consumed_nonce}, ts=${g.ts}, signer=${g.signer_verified_id}, requester_verified_id=${g.requester_verified_id})`,
      );
    }
  }

  return lines.join("\n");
}

// ---- worker: print ONLY the full banner string; parent captures it ---------

function runWorker() {
  // #857: the hard-bounded child. Build the full fold-dependent banner and
  // emit ONLY the additionalContext string (NOT the {continue:true} envelope).
  // The parent runs this child with stdio:"ignore" and reads the banner from
  // the COC_SS_BANNER_OUT file — NOT a stdout pipe — because the fold's
  // gpg-agent daemon inherits stdio fds and would hold a captured stdout pipe
  // open past the parent's timeout (deadlock; see lib/coord-background.js).
  // When the env var is absent (direct invocation / debugging), fall back to
  // stdout. The worker is NOT harness-bounded, so disarm the self-fallback.
  clearTimeout(fallback);
  try {
    const banner = buildFullBanner();
    const outFile = process.env.COC_SS_BANNER_OUT;
    if (outFile) {
      // #857 security MED-1: the banner carries operator + sibling identities.
      // Write private (0600) and O_EXCL|O_NOFOLLOW-equivalent (flag "wx" =
      // O_CREAT|O_EXCL) so a symlink planted at the predictable-inside-a-
      // private-dir path fails the write closed; a throw here → exit 1 → the
      // parent renders the lightweight banner (no identity leak, no partial file).
      fs.writeFileSync(outFile, banner, { mode: 0o600, flag: "wx" });
    } else {
      process.stdout.write(banner);
    }
    process.exit(0);
  } catch (_) {
    // Non-zero → the parent renders the lightweight banner from cheap surfaces.
    process.exit(1);
  }
}

// ---- parent: cheap surfaces + hard-bounded worker; emit the envelope -------

/**
 * #857 security MED-2: build the start-refresh surface line(s) from the parent's
 * runStartRefresh result. Op1 = intra-ecosystem ff-only merge (clean-tree-gated,
 * HALT-not-destroy on dirty/diverged per git.md destructive-tree); Op2 = canon-
 * upstream fetch-no-merge (advisory; roll-in human-gated, D3). Same surfacing
 * predicate the worker's buildFullBanner used before the mutation was relocated.
 */
function buildStartRefreshLines(startRefresh) {
  const lines = [];
  if (
    startRefresh &&
    startRefresh.op1 &&
    startRefresh.op1.status !== "up-to-date"
  ) {
    lines.push(startRefresh.op1.message);
  }
  if (
    startRefresh &&
    startRefresh.op2 &&
    startRefresh.op2.status !== "no-canon"
  ) {
    lines.push(startRefresh.op2.message);
  }
  return lines;
}

function emitSessionStart(additionalContext) {
  clearTimeout(fallback);
  try {
    process.stdout.write(
      JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext,
        },
      }) + "\n",
    );
  } catch {}
  process.exit(0);
}

function runParent() {
  // #857: do NOT synchronously read stdin here. A blocking fs.readFileSync(0)
  // freezes the event loop when fd 0 is an open pipe with no EOF (the headless
  // `claude -p --input-format stream-json` condition), which defeats the
  // setTimeout fallback above and hangs session startup before `init`. This
  // hook derives all state from CLAUDE_PROJECT_DIR and never used the stdin
  // payload, so there is nothing to read.
  //
  // #857 fix: the GPG-heavy fold that builds the full banner ran synchronously
  // on the harness critical path (~7-8s) and could abort the session before
  // `system/init` on a contended machine. We now compute the CHEAP surfaces
  // (identity + posture, no GPG) synchronously, then run the full banner build
  // in a HARD-BOUNDED worker (WORKER_BUDGET_MS). If the fold finishes in budget
  // the operator gets the full 11-surface banner; else a lightweight banner
  // (identity + posture + a skip line). The parent is bounded to ~WORKER_BUDGET
  // MS << the 10s registered timeout.
  try {
    // Cheap surfaces (no GPG): identity + operative posture.
    const identity = resolveOwnIdentity(PROJECT_DIR);
    const postureRead = readPostureState(PROJECT_DIR);
    const operativeRes = computePostureSurface(postureRead, identity || {});

    // #857 security MED-2: run the "always pull at start" coordination action
    // (runStartRefresh — a git working-tree merge) HERE in the parent, ONCE per
    // session, BEFORE the bounded worker spawn. The parent is never SIGTERM'd
    // mid-op, so a merge can never be interrupted into a .git/index.lock; it runs
    // every session regardless of the banner budget (it ran synchronously pre-#857
    // too, is git-only and usually a fast no-op). Fail-open — never throws.
    let startRefreshLines = [];
    try {
      const { runStartRefresh } = require(
        path.join(__dirname, "lib", "ecosystem-pull-merge.js"),
      );
      startRefreshLines = buildStartRefreshLines(
        runStartRefresh({ repoDir: PROJECT_DIR }),
      );
    } catch (_) {
      // start-refresh is advisory; a failure never blocks session-start.
    }

    const coordBg = require(path.join(__dirname, "lib", "coord-background.js"));

    // #866 fast-path: a prior session's DETACHED rebuild leaves a precomputed
    // full banner in the cache. When fresh, emit it INSTANTLY (well under budget)
    // so operators get the full 11-surface banner even on a loom-sized log whose
    // synchronous fold never fits WORKER_BUDGET_MS. On a cache miss, fall back to
    // the best-effort in-budget worker (small repos win session 1), then the
    // lightweight banner. EITHER path then spawns a DETACHED, UNBUDGETED rebuild
    // that refreshes the cache for the next session — the large-log full-banner
    // restoration is entirely off the critical path.
    let base;
    const cached = coordBg.readFreshBannerCache(PROJECT_DIR);
    if (cached.ok) {
      base = cached.banner;
    } else {
      // TEST-ONLY structural observable (#866): record that the parent took the
      // MISS branch, i.e. did NOT skip the bounded fold worker. The property
      // under test is exactly which branch ran, so the branch is where it is
      // recorded. It exists because that property has no sound TIMING proxy:
      // WORKER_BUDGET_MS is a spawnSync `timeout:`, a CAP rather than a cost,
      // so the miss pole pays the fold's ACTUAL duration — on a fast idle host
      // that finishes well inside the cap and the poles converge, while on a
      // loaded host the worker is killed at the cap and they diverge. A latency
      // assertion therefore reports on the machine, not on the fast path.
      //
      // The flag is a BOOLEAN and the destination is DERIVED from PROJECT_DIR,
      // never named by the caller: an env-var-supplied path would be an
      // arbitrary-write primitive in a hook that runs in every consumer
      // session, and resolving it would not close the class — the final
      // component stays a symlink sink unless the write itself refuses to
      // follow. `wx` (O_CREAT|O_EXCL) is that refusal, and 0600 keeps the
      // marker unreadable to other users; this mirrors the same guarantee
      // runBoundedWorker's own banner file documents and relies on.
      // Fail-open per cc-artifacts.md Rule 7 — a trace failure never changes
      // what the hook does, and in production the flag is unset.
      if (process.env.COC_TEST_WORKER_SPAWN_TRACE === "1") {
        try {
          fs.writeFileSync(
            path.join(
              PROJECT_DIR,
              ".claude",
              "learning",
              ".worker-spawn.trace",
            ),
            "spawn\n",
            { flag: "wx", mode: 0o600 },
          );
        } catch (_) {
          // observability only — never blocks or alters session start
        }
      }
      const r = coordBg.runBoundedWorker(__filename, WORKER_BUDGET_MS);
      base = r.ok ? r.stdout : buildLightweightBanner(identity, operativeRes);
    }

    // Refresh the cache off the critical path. This detached fold is exactly the
    // time-unbounded case the #867 pid-liveness reaper spares while in flight
    // (createVerifyHomedir stamps its homedir with a coc-fold.pid marker). #871:
    // PROJECT_DIR arms the rebuild-dedup guard so a reconnect storm of concurrent
    // SessionStarts spawns ONE rebuild per coord-log generation, not a herd.
    coordBg.spawnDetachedCacheRebuild(__filename, PROJECT_DIR);

    // Either way, append the parent's start-refresh surface (the worker no
    // longer builds it).
    const banner =
      startRefreshLines.length > 0
        ? base + "\n" + startRefreshLines.join("\n")
        : base;
    emitSessionStart(banner);
  } catch (_) {
    // Fail-open per architecture §4.3
    emitSessionStart("multi-operator-sessionstart: internal error (fail-open)");
  }
}

// ---- #866 detached cache rebuild: build the full banner, rewrite the cache --

function runCacheRebuild() {
  // #866: the DETACHED, UNBUDGETED child. Reap any leaked GPG homedirs, rebuild
  // the full fold-dependent banner, and rewrite the banner cache for the NEXT
  // session. Runs OFF the harness critical path (unref'd, own process group) so
  // it is NOT subject to WORKER_BUDGET_MS — disarm the self-fallback. Its own
  // in-flight fold homedir is spared by the pid-liveness reaper (this process is
  // alive with a matching start-token). Fail-open — never throws to the harness.
  clearTimeout(fallback);
  try {
    const coordBg = require(path.join(__dirname, "lib", "coord-background.js"));
    try {
      coordBg.reapStaleGpgHomedirs();
    } catch (_) {
      // reaping is best-effort hygiene; a failure never blocks the rebuild.
    }
    // GENMAT-1 T3 (loom#879): fresh-clone trust-root recovery. This is the
    // OFF-parent, UNBUDGETED lane — the ONLY place a NETWORK fetch (ls-remote +
    // fetch-then-fold) is permitted (#857: runParent MUST perform NO network).
    // materialize() is fail-OPEN + a strict no-op unless the repo is
    // enrolled-but-unmaterialized (real-owner roster + no verifying local
    // anchor); a tampered/absent/empty ref writes nothing (the guard keeps the
    // first commit fail-CLOSED-blocked). It runs BEFORE buildFullBanner so a
    // freshly-materialized log folds into the same rebuild's banner cache.
    try {
      const { materialize } = require(
        path.join(__dirname, "lib", "genesis-materializer.js"),
      );
      const identity = resolveOwnIdentity(PROJECT_DIR);
      materialize({
        repoDir: PROJECT_DIR,
        verifiedId: identity ? identity.verified_id : undefined,
      });
    } catch (_) {
      // materialization is best-effort + fail-open; never blocks the rebuild.
    }
    const banner = buildFullBanner();
    // #872: stamp the cache with the COMPOSITE freshness key (coord-log ⊕ roster
    // ⊕ posture ⊕ team-memory ⊕ drift) so a change to any banner input — not just
    // the coordination log — invalidates the cache on the next read.
    coordBg.writeBannerCache(
      PROJECT_DIR,
      banner,
      coordBg.bannerFreshnessKey(PROJECT_DIR),
    );
    process.exit(0);
  } catch (_) {
    process.exit(1);
  }
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
//
// Engine residual (hook-engine.js § process.exit): three catches enclose an
// exit — runWorker's and runCacheRebuild's (process.exit only) and runParent's
// (emitSessionStart: clearTimeout / stdout / exit). Each does output, exit or
// clearTimeout ONLY; every write, spawn and start-refresh runs BEFORE the exit.
function hookMain() {
  fallback = setTimeout(() => {
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
    process.exit(1);
  }, TIMEOUT_MS);
  if (IS_WORKER) {
    runWorker();
  } else if (IS_CACHE_REBUILD) {
    runCacheRebuild();
  } else {
    runParent();
  }
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
