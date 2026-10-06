#!/usr/bin/env node
/**
 * @hook-event: PreToolUse:Edit|NotebookEdit|Write (guard) — the pending integrity-critical path and current branch or lease state are available before mutation.
 *
 * integrity-guard.js — §2.3 + §4.3 pre-tool-use hook for Edit|Write
 * on the integrity-critical artifact set.
 *
 * Shard B3a (workspaces/multi-operator-coc/02-plans/01-architecture.md
 * §2.3 + §4.3 hook-table row).
 *
 *   Event:    pre-tool-use (Edit | Write)
 *   Watched:  the §2.3 integrity-critical paths —
 *               .claude/operators.roster.json
 *               .claude/learning/coordination-log.jsonl
 *               .claude/learning/posture.json
 *               journal/**
 *               workspaces/<name>/journal/**
 *               .claude/learning/violations.jsonl  (observations.jsonl etc.
 *                                                   are append-only,
 *                                                   integrity-relevant)
 *               .claude/team-memory/**
 *   Severity: block            (active branch IS NOT a codify branch —
 *                               structural primitive: `git rev-parse
 *                               --abbrev-ref HEAD` is process-local
 *                               deterministic per
 *                               hook-output-discipline.md MUST-2)
 *             block            (branch matches but no covering
 *                               codify-lease record in the fold — a
 *                               DETERMINED no, refusing no softer than
 *                               the indeterminate arms. Was
 *                               halt-and-report until loom#1855's
 *                               review; the withdrawal of that reading
 *                               is recorded at the branch itself)
 *             silent           (branch + lease both pass; OR unwatched
 *                               path; OR outside repo)
 *   Budget:   ≤5s. The setTimeout fallback is TWO-DIRECTIONAL (loom#1849b):
 *             fail-OPEN ({continue: true}) per cc-artifacts.md Rule 7 until the
 *             call is established as a mutation of a watched integrity-critical
 *             path on a coordination-ENABLED repo — and fail-CLOSED (block)
 *             thereafter, because past that point the only outstanding question
 *             is the AUTHORIZATION verdict, and "I could not determine" must not
 *             resolve to "yes". See `authPhase` / `denyIndeterminate`.
 *             The ≤5s PRE-authorization half is fixed and NOT env-reachable;
 *             only the authorization half is (loom#1855 F-A). See
 *             AUTH_BUDGET_MS / `enterAuthPhase`.
 *
 * Why codify-branch gating:
 *   Per architecture v11 §6.4 + §7.1, integrity-critical artifacts
 *   change ONLY through the /codify flow: Step 0 acquireCodifyLease,
 *   edits land on `codify/<display_id>-<date>` branch → PR →
 *   admin-merge. Any direct edit off a codify branch IS a structural
 *   contract violation — the codify-lease + 2-of-N owner co-sign
 *   guarantees that govern these artifacts cannot apply to ad-hoc
 *   `feat/`/`fix/` writes.
 *
 * Why lease-record gating:
 *   The codify-branch name alone is necessary but not sufficient. The
 *   signed `codify-lease` record (M7 E ships the writer; B3a reads)
 *   binds the branch to a specific scope_files list and 2-of-N
 *   co-signers. Without a verifying lease, the branch could be any
 *   ad-hoc `codify/*` rename — the lease is the cryptographic anchor.
 *
 * Cross-shard wiring (read-only side):
 *   - Reads branch via `git rev-parse --abbrev-ref HEAD` (process-local).
 *   - Reads identity via lib/operator-id.js (A1).
 *   - Reads coordination log via createFilesystemTransport (A2b).
 *   - Folds via coordination-log.js::foldLog (A2a).
 *   - Scans accepted for type === "codify-lease".
 *
 * ENV OVERRIDES (test injection only):
 *   COC_OPERATOR_REPO_DIR  — test injection of repo root.
 *   COC_OPERATOR_KEY_PATH  — explicit signing-key path.
 *   COC_INTEGRITY_GUARD_TIMEOUT_MS — the AUTHORIZATION budget, clamped to
 *     (0, 5000]. It cannot shorten the pre-authorization budget; see
 *     AUTH_BUDGET_MS for the measurement that forced that split.
 */

"use strict";

const DEFAULT_TIMEOUT_MS = 5000;
const PROCESS_STARTED_AT = Date.now();

// Test injection ONLY (same class as COC_OPERATOR_REPO_DIR / COC_OPERATOR_KEY_PATH
// below). It bounds the AUTHORIZATION budget, and ONLY that budget.
//
// A CORRECTED SAFETY CLAIM (loom#1855 review, F-A). The first version of this
// knob shipped the claim: "Clamped to (0, DEFAULT], every reachable value makes
// the guard refuse SOONER on the authorization path, which is the fail-CLOSED
// direction. A knob that can only tighten is not an attack surface." That claim
// was FALSE as written, and was measured false — a watched path, no lease, a
// non-codify branch, i.e. a write the fence answers NO on:
//
//   default budget                      exit 2, continue:false   (refused)
//   COC_INTEGRITY_GUARD_TIMEOUT_MS=1    exit 1, continue:TRUE     (THE WRITE RAN)
//   values 5 / 20 / 50 / 200            exit 2                   (refused)
//
// The clamp bounded the WRONG timer. The knob shortened the timer armed at
// MODULE LOAD, which is upstream of the authorization phase, so a low enough
// value fired it in the window BEFORE `authPhase` was set — and that arm is the
// Rule-7 PASSTHROUGH, not `denyIndeterminate`. Shortening a budget only tightens
// if the shortened window still contains the point where the disposition flips
// to fail-closed. Below that point the same knob is a total fence bypass for
// EVERY watched path, and `.claude/settings.json` carries a live `env:` block,
// so the delivery vector is an ordinary-looking config edit.
//
// The fix makes the original claim TRUE instead of restating it: the PRE-auth
// budget is fixed at DEFAULT and is not env-reachable at all, and the knob is
// applied by re-arming INSIDE `enterAuthPhase()`, where the only disposition is
// `denyIndeterminate`. Every reachable value now genuinely refuses sooner,
// because every reachable value now only ever governs a timer whose handler
// refuses. Pinned bipolar by F1 in
// tests/integration/multi-operator/lease-binding-drop-1849b.test.js.
const AUTH_BUDGET_MS = (() => {
  const raw = Number(process.env.COC_INTEGRITY_GUARD_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(raw, DEFAULT_TIMEOUT_MS);
})();

const AUTH_BUDGET_EXPLICIT = (() => {
  const raw = Number(process.env.COC_INTEGRITY_GUARD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0;
})();

/**
 * THE FOLD BUDGET — and an honest correction to what DEFAULT_TIMEOUT_MS covers
 * (loom s49 P5).
 *
 * DEFAULT_TIMEOUT_MS is documented above as "the hook budget". Measured
 * 2026-08-21 against loom's own 919-record coordination log, it is not: the
 * fold alone costs 8-26s (load-dependent; the host carried load averages of 8
 * to 283 across the session's measurements), because rule-1 verifies EVERY
 * record's signature and each verification costs a subprocess — ssh-keygen on
 * an SSH roster, gpg on a GPG roster like loom's own. A 5000ms budget was never
 * being met on this path; it simply had no way to fire, so nothing reported the
 * overrun. Making the deadline reachable without also correcting the number
 * would convert a slow-but-correct guard into one that refuses every codify
 * write on a mature log, which is strictly worse than the defect being fixed.
 *
 * So the fold carries its OWN, larger bound. This is a real bound and not a
 * restatement of "unbounded": at FOLD_BUDGET_MS the fold stops and the guard
 * refuses, where previously it ran for as long as the log was long. What is
 * given up is the claim that the WHOLE hook fits in 5000ms — a claim that was
 * already false and is now stated as false rather than implied true.
 *
 * THE KNOB STILL ONLY EVER TIGHTENS, which is loom#1855's load-bearing
 * property and is preserved deliberately. When COC_INTEGRITY_GUARD_TIMEOUT_MS
 * is set EXPLICITLY, the fold deadline collapses to AUTH_BUDGET_MS — so every
 * reachable value of the knob shortens the fold too, and (unlike before) now
 * genuinely refuses inside it. There is no value of the knob that lengthens any
 * budget: the default arm is reached only when the knob is ABSENT.
 *
 * RESIDUAL, stated rather than buried: 30s is a bound, not a target, and it is
 * chosen above the highest fold cost measured on a saturated host. The real fix
 * is to stop paying a subprocess per record — done for ssh-ed25519 in
 * coc-sign.js this same change, NOT done for GPG, which is what loom's own
 * roster uses. Until the GPG path is in-process or the log is checkpointed,
 * loom's own guard latency stays in the seconds.
 */
const FOLD_BUDGET_DEFAULT_MS = 30000;
const FOLD_BUDGET_MS = AUTH_BUDGET_EXPLICIT
  ? AUTH_BUDGET_MS
  : FOLD_BUDGET_DEFAULT_MS;

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { emit, instructAndWait } = require(
  path.join(__dirname, "lib", "instruct-and-wait.js"),
);
const { resolveIdentity } = require(
  path.join(__dirname, "lib", "operator-id.js"),
);
const { createEngine } = require(
  path.join(__dirname, "lib", "coordination-log.js"),
);
const { createFilesystemTransport } = require(
  path.join(__dirname, "lib", "transport-filesystem.js"),
);
const { requireMainCheckout } = require(
  path.join(__dirname, "lib", "state-resolver.js"),
);
const { isMutationTool, MUTATION_TOOLS } = require(
  path.join(__dirname, "lib", "tool-classes.js"),
);
// loom#1896 § THE CONFLATION — this guard fences THE AGENT (the codify-branch
// + lease fence over integrity-critical state files), not a sibling human, so
// it asks the GOVERNANCE question, not the COORDINATION one. See
// `lib/coordination-mode.js` § governanceMode. Keying it on
// `isCoordinationEnabled` silently disarmed the whole fence on an
// enrolled-SOLO repo once #1890's solo floor landed.
const { isGovernanceEnabled } = require(
  path.join(__dirname, "lib", "coordination-mode.js"),
);
const {
  matchFirstCandidate,
  matchIntegrityWatchedRel,
  globCoversRel,
} = require(path.join(__dirname, "lib", "guard-path-scope.js"));
const { resolveGitBinary, gitEnv } = require(
  path.join(__dirname, "lib", "git-subprocess-env.js"),
);
const { resolveRepoDirBound } = require(
  path.join(__dirname, "lib", "repo-dir-override.js"),
);

/**
 * THE AUTHORIZATION PHASE (loom#1849b).
 *
 * Null until the guard has ESTABLISHED, from this payload, that the call is a
 * mutation of an integrity-critical path on a coordination-ENABLED repo. From
 * that moment the only remaining question is "is this write authorized?", and
 * an indeterminate answer to THAT question must not resolve to "yes".
 *
 * Before it is set, cc-artifacts.md Rule 7 fail-OPEN is preserved verbatim:
 * the guard does not yet know the call is relevant, and blocking every Edit in
 * the repo because stdin or `git` was slow is a far worse failure than the one
 * being closed. Both directions are pinned by tests (C4 / C5 in
 * tests/integration/multi-operator/lease-binding-drop-1849b.test.js).
 */
let authPhase = null;

/**
 * Fail CLOSED. Used by the budget expiry and the catch-all, which are the two
 * paths that reach a verdict of "could not determine".
 *
 * Rendered through instructAndWait rather than a hand-built object so the deny
 * body is the SAME shape every other block branch emits — and the exit code
 * stays the authoritative teeth (exit 2), not the JSON.
 */
function denyIndeterminate(reason, detail) {
  // The refusal must survive a failure IN THE RENDERER. Without this, a throw
  // anywhere below escapes as an uncaught exception and the process exits 1
  // with no JSON — which the host does not read as a denial, i.e. the exact
  // fail-open this function exists to close, one layer up.
  try {
    _denyIndeterminate(reason, detail);
  } catch {
    try {
      process.stdout.write(
        JSON.stringify({
          // No `continue: false`: it ends the agent's turn instead of denying the call (see
          // lib/instruct-and-wait.js). The deny decision + exit 2 below are the refusal.
          hookSpecificOutput: {
            hookEventName: (authPhase && authPhase.hookEvent) || "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `integrity-guard: codify-lease authorization did not complete (${reason}); refusing rather than passing through.`,
          },
        }) + "\n",
      );
    } catch {
      // best-effort; exit 2 below is the authoritative refusal
    }
  }
  process.exit(2);
}

function _denyIndeterminate(reason, detail) {
  const out = instructAndWait({
    hookEvent: authPhase.hookEvent,
    severity: "block",
    what_happened:
      `Edit/Write on integrity-critical path '${authPhase.rel}', but the ` +
      `codify-lease authorization check did not complete: ${reason}.`,
    why:
      "multi-operator-coc/integrity-guard (loom#1849b) — this guard's job is to " +
      "answer ONE question about an integrity-critical mutation: is it covered " +
      "by a signed codify-lease? It did not finish answering, so the verdict is " +
      "UNKNOWN — and UNKNOWN is not clean. The former disposition emitted " +
      '{"continue":true}, i.e. the write RAN with authorization undetermined, ' +
      "which is a fail-OPEN on a mutation fence and the same shape as this " +
      "guard's already-closed unreadable-log and unidentifiable-tree branches. " +
      "cc-artifacts.md Rule 7 fail-open is PRESERVED for everything upstream of " +
      "this point (unwatched paths, coordination-disabled repos, and any budget " +
      "expiry before the call was known to be integrity-critical); what changes " +
      "is only the AUTHORIZATION verdict. The signal is process-state (a budget " +
      "the process itself measured), the structural class " +
      "hook-output-discipline.md MUST-2 accepts for `block`.",
    agent_must_report: [
      `Target path: ${authPhase.rel}`,
      `Why the check could not answer: ${reason}${detail ? ` — ${detail}` : ""}`,
      "State explicitly that the codify-lease is UNKNOWN for this path — NOT that it is missing, and NOT that the write was authorized.",
      `Budget: ${AUTH_BUDGET_MS}ms. A slow or contended coordination log is the usual cause; the log is read from the MAIN checkout.`,
      "Remediation: retry once. If it recurs, check the size and readability of .claude/learning/coordination-log.jsonl in the main checkout.",
    ],
    agent_must_wait:
      "Do not retry the Edit/Write until the lease check completes and actually returns a verdict.",
    user_summary: `integrity-guard — lease check INDETERMINATE for ${authPhase.rel} (${reason}); refused rather than passed through`,
  });
  try {
    process.stdout.write(JSON.stringify(out.json) + "\n");
  } catch {
    // best-effort; the exit code below is the authoritative refusal
  }
  process.exit(out.exitCode);
}

// setTimeout fallback per cc-artifacts.md Rule 7 — fail-OPEN before the
// authorization phase, fail-CLOSED inside it.
//
// Armed at DEFAULT_TIMEOUT_MS, NEVER at the env knob (loom#1855 F-A). This
// timer's handler can still reach `denyIndeterminate` — that is the no-knob
// case, where one timer spans both phases and the disposition is chosen by
// `authPhase` at fire time. What is no longer possible is for the ENV to shrink
// the window that ends before `authPhase` is set, which is what turned the knob
// into a fence bypass. See AUTH_BUDGET_MS above and `enterAuthPhase` below.
let fallback = null;

/**
 * Enter the authorization phase, and re-arm the budget onto it (loom#1855 F-A).
 *
 * The re-arm is what makes the knob's stated safety property TRUE rather than
 * asserted: from here the ONLY disposition on budget expiry is
 * `denyIndeterminate`, so a shorter budget can only refuse sooner.
 *
 * The remaining window is measured from PROCESS start, not from this call, so
 * the knob keeps its documented meaning — a TOTAL budget for the hook — and C4
 * (which stalls the log read at a 1500ms budget) is timed exactly as before. A
 * value already elapsed yields 0, which fires at the first yield point after
 * this line; the guard's own determined verdict, if it reaches one first on the
 * synchronous path, wins the race and is likewise a refusal. Both orders end in
 * exit 2, which is why F1 asserts the refusal and not the reason string.
 */
function enterAuthPhase(hookEvent, rel) {
  authPhase = { hookEvent, rel };
  if (AUTH_BUDGET_MS >= DEFAULT_TIMEOUT_MS) return;
  clearTimeout(fallback);
  const remaining = Math.max(
    0,
    AUTH_BUDGET_MS - (Date.now() - PROCESS_STARTED_AT),
  );
  fallback = setTimeout(
    () => denyIndeterminate(`the ${AUTH_BUDGET_MS}ms hook budget expired`),
    remaining,
  );
}

function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

function resolveRepoDir(payload) {
  // loom#1871 HIGH-1 — the override is bound to the SESSION REPOSITORY here
  // (lib/repo-dir-override.js). `corroborateOverride` below is KEPT as a second,
  // narrower layer: identity-binding admits the whole legitimate worktree forest,
  // so an override naming a SAME-FAMILY tree that lacks the coordination
  // substrate would satisfy this resolver and still widen the fence. The two
  // close different residuals; neither subsumes the other.
  return resolveRepoDirBound(payload, { hookName: "integrity-guard" }).repoDir;
}

/**
 * The SAME seed resolveRepoDir would use with COC_OPERATOR_REPO_DIR absent.
 * Factored out so the corroboration pass below cannot drift from the primary
 * resolution — one definition, read twice.
 */
function unoverriddenRepoDir(payload) {
  if (payload && typeof payload.cwd === "string" && payload.cwd.length > 0) {
    return payload.cwd;
  }
  return process.cwd();
}

/**
 * Is COC_OPERATOR_REPO_DIR actually STEERING this resolution? Set, extant, AND
 * HONOURED by the repo-identity binding — an override the resolver already
 * refused is not steering anything, so re-corroborating it would be a no-op
 * that spends a git call to compare the seed against itself.
 */
function envRepoDirOverrideActive(payload) {
  const envDir = process.env.COC_OPERATOR_REPO_DIR;
  if (!envDir || !fs.existsSync(envDir)) return false;
  return !resolveRepoDirBound(payload, { quiet: true }).overrideRefused;
}

/**
 * THE OVERRIDE MAY NARROW THE FENCE, NEVER WIDEN IT (loom#1871 follow-up,
 * HIGH-1).
 *
 * #1871 pinned the pre-auth BUDGET so `COC_INTEGRITY_GUARD_TIMEOUT_MS` could no
 * longer fire the fallback on the passthrough arm. It left the SIBLING seam
 * open: `resolveRepoDir` honours `COC_OPERATOR_REPO_DIR` on the sole evidence
 * that the directory EXISTS, and that value is the jurisdiction basis for every
 * pre-auth gate below it. Adding one line to a `settings.json` `env:` block and
 * running `git init` on the target — the same ordinary-looking-config-edit
 * delivery vector #1871's own comment names — moved the whole fence to an
 * unrelated repository.
 *
 * MEASURED, two-pole, on the merged #1871 tree, PreToolUse Edit on
 * `<worktree>/journal/0999-<display-id>-probe.md` with no covering lease:
 *
 *   COC_OPERATOR_REPO_DIR=<mkdtemp + git init, no roster, no genesis>
 *                                        exit 0  {"continue":true}   <- RAN
 *   env scrubbed, byte-identical payload exit 2  deny, "[BLOCK] … off-codify-branch"
 *
 * THE ARM IS NOT THE ONE THE REPORT NAMED, and this is why the obvious fix does
 * not work. The report placed the escape at `if (!isCoordinationEnabled(repoDir))
 * passthrough()`. Measured with the guard's OWN predicate:
 *
 *   repoDir=<decoy>  isWatchedPath -> {watched:false} matchedRoot=null
 *                    coordinationEnabled=false (source=default-off)
 *   repoDir=<real>   isWatchedPath -> {watched:true, rel:"journal/…"}
 *                    coordinationEnabled=true  (source=implicit-roster-genesis)
 *
 * so it leaves at the UNWATCHED passthrough, one gate EARLIER: guard-path-scope
 * suppresses the target's own tree as out-of-repo-family (the decoy's `.git` is
 * a different family) and candidate 1 `..`-escapes, yielding zero candidates.
 * Coordination is OFF too, but control never reaches that line. A fix that
 * hardened only the coordination arm would have measured clean and changed
 * nothing.
 *
 * THE FIX IS AT THE SHARED CAUSE, not at either arm: an env-supplied
 * jurisdiction may not be the thing that converts a FENCED write into an
 * unfenced one. When the override yields a passthrough verdict, the same two
 * predicates are re-run against the override-FREE root; if THAT root would have
 * fenced the write, the override is dropped for this call and the fence
 * proceeds on the corroborated root.
 *
 * WHY CORROBORATION RATHER THAN REMOVAL. `COC_OPERATOR_REPO_DIR` is load-bearing
 * test injection — 6 integration suites and 11 harness tests drive these guards
 * through it — so deleting it breaks the fixtures that prove the fence works.
 * Corroboration keeps every legitimate use: a fixture write targets a path
 * INSIDE the fixture, which is unwatched under the override-free root too, so
 * the baseline agrees with the override and it is honoured.
 *
 * WHAT THIS COSTS. Exactly one workflow: pointing the override at a fixture
 * WHILE writing to a path that the real repo watches under an enabled
 * coordination substrate. That is the attack shape and nothing else has it —
 * but it is a real cost, and a future test wanting a deliberate passthrough on a
 * REAL watched path must now stage the file inside its fixture instead.
 *
 * COST BOUND: the extra pass runs only when the override is set AND the verdict
 * was already a passthrough. An ordinary session (env unset) pays nothing.
 *
 * NOT CLAIMED: this closes the seam in THIS guard. `CLAUDE_TRUST_STATE_DIR` was
 * tested as a second lever and REFUTED — pointed at a bare decoy it returns exit
 * 2, because provenCheckoutRoot's coherence check rejects it (pinned as a
 * regression in F2 of the paired suite). Seven sibling hooks carry the same
 * `resolveRepoDir` shape and are NOT fixed here; see the PR body.
 */
function corroborateOverride(targetPath, verdict, payload, ctx) {
  if (!ctx.overrideActive) return null;
  // Only a PASSTHROUGH verdict is worth re-examining; an override that FENCES
  // is narrowing, which is always allowed.
  if (verdict.watched && verdict.governanceEnabled) return null;
  const baseRes = requireMainCheckout(unoverriddenRepoDir(payload));
  if (!baseRes.ok) {
    // FAIL CLOSED. Returning null here would honour the override on the sole
    // ground that the corroborating root could not be read — i.e. the check
    // designed to catch a widening override would be DEFEATED by making its
    // baseline unreadable, which is a cheaper attack than the one it closes.
    // This is the same disposition, on the same signal (git exited non-zero),
    // that the unidentifiable-main-checkout arm in main() already takes.
    return { uncorroborated: true, reason: baseRes.reason };
  }
  const baseScope = {};
  const baseWp = isWatchedPath(targetPath, baseRes.repoDir, baseScope);
  if (!baseWp.watched) return null;
  if (!isGovernanceEnabled(baseRes.repoDir)) return null;
  // The override-free root WOULD have fenced this write. The override is
  // therefore widening the passthrough set — drop it for this call.
  return { repoDir: baseRes.repoDir, wp: baseWp, scope: baseScope };
}

// F14 C2 iter-2 HIGH-2: integrity-guard MUST cover MultiEdit + NotebookEdit
// in addition to Edit + Write. Sibling-class of PR #316 LOW-2 fix on
// posture-gate.js (which closed the gap for the trust-posture state files).
// integrity-guard protects a broader surface: operators.roster.json,
// coordination-log.jsonl, posture.json, violations.jsonl, observations.jsonl,
// team-memory/**, journal/**. Without MultiEdit/NotebookEdit in the watched
// set, an attacker could bypass the integrity fence entirely via either tool.
//
// F14 C2 iter-3 root-cause fix: route through MUTATION_TOOLS from
// lib/tool-classes.js (SSOT). Adding a new mutation tool requires one
// edit (the helper) — not N edits across every hook.
const WATCHED_TOOLS = MUTATION_TOOLS;

function isWatchedTool(payload) {
  const tool = payload && payload.tool_name;
  if (!isMutationTool(tool)) return { watched: false };
  const input = (payload && payload.tool_input) || {};
  // loom#1549 F4, third site of the same class. WATCHED_TOOLS is MUTATION_TOOLS
  // (the SSOT), so NotebookEdit was recognized by NAME — but the payload read
  // omitted `notebook_path`, the key NotebookEdit actually carries. filePath
  // came back "", the length guard returned watched:false, and a NotebookEdit
  // write to the roster / coordination-log / posture / journal walked the
  // integrity fence untouched. The tool-name SSOT cannot close a gap that
  // lives in the payload read; six sibling hooks already read all three keys.
  const filePath =
    input.file_path || input.filePath || input.notebook_path || "";
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { watched: false };
  }
  return { watched: true, targetPath: filePath };
}

/**
 * Watched-path predicate. The set is the §2.3 integrity-critical
 * artifacts:
 *
 *   .claude/operators.roster.json
 *   .claude/learning/coordination-log.jsonl
 *   .claude/learning/posture.json
 *   .claude/learning/violations.jsonl
 *   .claude/learning/observations.jsonl
 *   .claude/team-memory/**
 *   journal/**           (the global root journal/)
 *   workspaces/<name>/journal/**
 *
 * Returns {watched: true, rel} | {watched: false}.
 */
function isWatchedPath(absPath, repoDir, out) {
  // loom#1414: the rel-computation used to be inline here as a single
  // `path.relative(repoDir, absPath)` against the MAIN checkout, which made
  // this predicate return watched:false for EVERY protected path when the
  // session ran inside a linked worktree (repoDir is the main checkout, the
  // target is in the worktree, so the relative path is `../`-prefixed). The
  // resolution now lives in lib/guard-path-scope.js, which evaluates the
  // target against every root that could legitimately claim it — the session
  // root AND the target's own worktree root — and fails CLOSED (emitting
  // path suffixes) when no root resolves.
  //
  // loom#1422: the watched-path PATTERNS have now moved there too. They used to
  // be owned here — a DIRECT membership set plus three subtree tests — which
  // made this the second of four surfaces that each had to learn the
  // case-insensitivity dimension separately. `matchIntegrityWatchedRel` is
  // derived from the registry rows carrying `surfaces.direct: true`, so the set
  // is no longer hand-maintained in two places.
  //
  // loom#1656: `out` carries `matchedRoot` back — the tree whose rel actually
  // matched. The branch predicate below reads THAT tree's HEAD; see § (1).
  return (
    matchFirstCandidate(
      absPath,
      repoDir,
      matchIntegrityWatchedRel,
      undefined,
      out,
    ) || {
      watched: false,
    }
  );
}

/**
 * Resolve the active git branch via `git rev-parse --abbrev-ref HEAD`.
 * Returns the branch name string or null on any failure (no git, etc).
 *
 * Per hook-output-discipline.md MUST-2, this IS the structural primitive
 * the block branch is grounded in: process-local deterministic, no
 * network, no lexical match against tool_input.
 *
 * @param treeDir the working tree whose HEAD to read. Since loom#1656 the caller
 *   passes the tree that OWNS THE TARGET PATH — not the main checkout and not
 *   the session's cwd. See § (1) in main() for why those two are the wrong
 *   answer in a linked-worktree forest.
 */
function resolveActiveBranch(treeDir) {
  try {
    // loom#1471. This predicate IS the codify-branch fence, so steering it steers
    // the fence. The former shape passed no `env:`, handing the child the ambient
    // environment — and `GIT_DIR` outranks repository DISCOVERY, so `cwd` did NOT
    // pin which repository answered. An attacker-supplied GIT_DIR pointing at a repo
    // whose HEAD is codify-shaped made the fence report that branch instead of the
    // session's own (test T1). `git` is now invoked by ABSOLUTE path with an env
    // built from constants: neither PATH nor GIT_DIR reaches the child.
    const gitBin = resolveGitBinary();
    // Unresolvable git ranks TIGHTEST, never a clean negative (security.md
    // § Enforcement-Surface Parity): null branch → isCodifyBranch({match:false})
    // → BLOCK. Fail-closed, which is the pre-existing disposition for "no git".
    if (!gitBin) return null;
    const r = spawnSync(gitBin, ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: treeDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 2000,
      env: gitEnv(),
    });
    if (r.status !== 0) return null;
    const out = (r.stdout || "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Codify-branch predicate — the BINDING axis. Returns
 * `{ match: true, date, lane }` when the branch is
 * `codify/<display_id>-<YYYY-MM-DD>` or `codify/<display_id>-<YYYY-MM-DD>-<lane>`
 * for THIS display_id; `{ match: false }` otherwise. The branch convention is
 * documented in architecture v11 §7.1.
 *
 * ── WHEN display_id DOES NOT RESOLVE (loom#1481) ───────────────────────────
 *
 * This function used to read `if (displayId && branchDisplayId !== displayId)`,
 * so a FALSY display_id skipped the foreign-operator arm ENTIRELY and ANY
 * `codify/<anything>-<date>` matched. The paragraph that stood here justified it
 * by "the lease-record check below STILL fires" — true, and beside the point:
 * the lease answers "may THIS operator write THIS path", never "whose branch is
 * this". Job (ii) below — the branch is YOURS, not another operator's — was
 * therefore silently DISABLED by a condition the operator never sees, and #1471's
 * own regrowth-guard header records a live path to it (routing operator-id.js
 * through the git-env helper nulls display_id on a host whose signingkey lives in
 * global config, i.e. "the hardening would WIDEN the fence it is meant to
 * protect"). Under that change the fence would have turned off for EVERY operator
 * at once while their leases kept authorizing — a silent loss of (ii), which is
 * exactly the shape `rules/security.md` § "Secure-Default For A New Security
 * Feature" refuses: a control whose default renders it a no-op.
 *
 * The disposition, chosen rather than assumed. With display_id unresolved the
 * branch's own display_id token is checked against the ROSTER: if it names a
 * rostered operator, the branch is FOREIGN and blocks, because we cannot show we
 * are that operator. If it names nobody, it is an ad-hoc lane token that
 * impersonates no one, and the lease layer remains the authorization.
 *
 * WHY NOT BLOCK EVERY codify branch on a null display_id. It would be a wider
 * fence that buys nothing and costs a worse message: an un-rostered operator
 * already cannot be authorized AT ALL (fold rule 1 rejects any record whose
 * verified_id is not in the roster, so `accepted` holds no lease of theirs and
 * the determined-NO arm blocks), and an operator with NO identity at all is
 * refused by the loom#1871 arm below with remediation that can actually clear
 * the state. Blocking every codify branch here would replace those precise
 * refusals with a blanket "you are off-codify", which is the
 * lockout-with-wrong-instructions mode #1871 fixed.
 *
 * STATED EXACTLY, because the narrow arm DOES divert some traffic from those
 * two: an operator whose display_id is unresolved FOR ANY REASON — un-rostered,
 * no identity at all, or a roster row missing the field — is now refused HERE,
 * by the branch fence, whenever the branch names a rostered operator. It was
 * previously refused one or two layers down. Every such case still BLOCKS; what
 * changes is which message it carries, and the message this arm emits names
 * identity resolution as the cause and /whoami as the remedy, which is the same
 * remediation class #1871 built. The OUTCOME changes for exactly one shape —
 * rostered, holding a covering lease, display_id unresolved, writing from
 * another rostered operator's branch — which is the shape this arm exists for.
 *
 * WHY A ROSTER-ABSENT ROSTER IS NOT A FAIL-OPEN HERE. With no readable roster,
 * `rosterDisplayIds` is empty and every branch token matches nobody — but fold
 * rule 1 resolves signers against that same roster, so NOTHING folds, no lease is
 * ever covering, and the determined-NO arm refuses every integrity-critical write
 * in the repo. The permissive-looking branch verdict has no path to a write.
 *
 * The comparison folds case, unlike the resolved-display_id arm above it, and
 * deliberately: folding is strictly TIGHTER (it catches `codify/Alice-<date>`),
 * so it cannot introduce a fail-open, and nothing downstream consumes the token.
 *
 * ── WHY THE OPTIONAL LANE TOKEN (loom#1849b) ───────────────────────────────
 *
 * The former grammar was DATE-TERMINAL, so a branch name was a pure FUNCTION of
 * (operator, date) — a DERIVED identity with no owner. Two concurrent sessions
 * of the same operator on the same day therefore computed the SAME name and
 * silently shared one branch. That is not hypothetical: `codify/<operator>-2026-08-20`
 * accumulated EIGHTEEN commits from two independent sessions, interleaved, with
 * one session's commit sitting between two of the other's.
 *
 * Making the identity OWNED — the session appends a lane token it chooses —
 * gives each lane its own branch, hence its own working tree, which is what the
 * BINDING axis is for: N per operator. It pairs with dropping the binding from
 * `findCoveringLease`: one grant now covers N lanes, and N lanes can now exist.
 *
 * THIS WIDENS THE GRAMMAR AND WIDENS NO AUTHORITY, which is the property to
 * check. The fence has exactly two jobs and both survive verbatim:
 *   (i)  "you are deliberately in a codify flow" — still `codify/` + a date.
 *   (ii) "this branch is YOURS, not another operator's" — the display_id capture
 *        must still EQUAL yours, and the `foreign` block below is unchanged.
 * The lane token confers nothing: it is operator-chosen free text on a branch
 * the operator could already name freely. The actual authorization is the
 * signed lease's SIGNER + SCOPE (findCoveringLease), untouched here.
 *
 * THE CAPTURE IS ANCHORED TO THE FIRST DATE (lazy `+?`), so the operator
 * identity is always the prefix preceding the EARLIEST date token, and the
 * parse is deterministic even when the lane itself contains hyphens or another
 * date. Worked: display_ids legitimately contain hyphens (`display_id` is
 * `/^[a-z0-9._-]+$/`), and a lazy capture still resolves `codify/alex-kim-2026-08-20`
 * to `alex-kim`, because the date sub-pattern is strict enough that no shorter
 * prefix can satisfy it. A crafted `codify/alice-2026-08-20-bob-2026-08-21`
 * resolves the operator to `alice` under every input, so it can neither
 * impersonate bob nor let bob past (ii).
 */
function rosterDisplayIds(roster) {
  const out = new Set();
  const persons = roster && roster.persons;
  if (!persons || typeof persons !== "object") return out;
  for (const personId of Object.keys(persons)) {
    const p = persons[personId];
    const d = p && p.display_id;
    if (typeof d === "string" && d) out.add(d.toLowerCase());
  }
  return out;
}

function isCodifyBranch(branch, displayId, roster) {
  if (!branch || typeof branch !== "string") return { match: false };
  if (!branch.startsWith("codify/")) return { match: false };
  const suffix = branch.slice("codify/".length);
  // Expected shape: <display_id>-YYYY-MM-DD[-<lane>]
  const m = suffix.match(/^(.+?)-(\d{4}-\d{2}-\d{2})(?:-([A-Za-z0-9._-]+))?$/);
  if (!m) return { match: false };
  const [, branchDisplayId, date, lane] = m;
  if (displayId) {
    if (branchDisplayId !== displayId) {
      // Branch is a codify branch but belongs to a DIFFERENT operator —
      // that's also a block-class condition (cross-operator codify-branch
      // is exactly what the lease guards against).
      return { match: false, foreign: true, foreignDisplayId: branchDisplayId };
    }
  } else if (rosterDisplayIds(roster).has(branchDisplayId.toLowerCase())) {
    // loom#1481 — OUR display_id did not resolve, so we cannot show we are the
    // operator this branch names; and the branch names a ROSTERED one. Job (ii)
    // fails closed rather than being skipped. `identityUnresolved` is carried so
    // the refusal names the real cause instead of telling the operator to go
    // coordinate with someone they may in fact be.
    return {
      match: false,
      foreign: true,
      foreignDisplayId: branchDisplayId,
      identityUnresolved: true,
    };
  }
  return { match: true, date, lane: lane || null, displayId: branchDisplayId };
}

function loadRoster(repoDir) {
  const rosterPath = path.join(repoDir, ".claude", "operators.roster.json");
  try {
    if (!fs.existsSync(rosterPath)) return null;
    return JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Find a covering codify-lease record in the folded log. "Covering" means THREE
 * things, and — since loom#1849b — deliberately NOT a fourth:
 *
 *   1. SIGNER MATCH — the record was signed by the operator making this write.
 *   2. SCOPE MATCH  — the lease's `scope_files` names the candidate path, or a
 *      directory prefix of it (`leaseScopeCovers`).
 *   3. STILL A GRANT — the lease has not been RELEASED, and has not EXPIRED
 *      (`leaseGrantVerdict`; see its header for the polarity argument).
 *
 * 1 and 2 are properties of the record as WRITTEN. 3 is the property of its
 * CURRENT STATE, and was missing entirely until 2026-08-21: the minting surface
 * enforced a TTL and emitted release records at three sites, and this — the only
 * surface that AUTHORIZES on a lease — had learned neither, so a lease its
 * holder had explicitly released, or one months past the TTL, kept authorizing
 * integrity-critical writes forever (rules/security.md § Enforcement-Surface
 * Parity: the control existed at one surface and the independent authorization
 * surface was blind to it).
 *
 * Returns `{ lease, reason, detail }`. `lease` is the covering record, or null.
 * `reason` is one of "covered" | "none" | "released" | "expired" | "unpairable"
 * — the CALLER emits it, because "the log holds no covering record" and "the
 * covering record was released four months ago" are different facts with
 * different remediations, and this guard has twice been corrected for stating
 * one on evidence for the other (rules/instrument-discipline.md MUST-1).
 * Collapsing them back into a bare null would re-make that error.
 *
 * Record shape (the contract M7 E's writer ships; B3a guard READS):
 *   {
 *     type: "codify-lease",
 *     verified_id, person_id, display_id, seq, prev_hash, ts, sig,
 *     content: {
 *       lease_id: "lease_<ms>_<hex>",                  // pairs with the release
 *       branch: "codify/<display_id>-<YYYY-MM-DD>",    // INFORMATIONAL — see below
 *       date:   "YYYY-MM-DD",
 *       acquired_at: "<ISO-8601>",                     // the TTL clock
 *       scope_files: ["path/a.md", "path/b.md"]
 *     }
 *   }
 * and its release counterpart:
 *   { type: "codify-lease-release", content: { lease_id, released_at, action } }
 * where `action` is "release" (the holder's own) or "reclaim-stale" (a takeover).
 *
 * ── WHY `content.branch` IS NOT CONSULTED, AND MUST NOT BE RESTORED ─────────
 *
 * The codify lease welds together THREE concerns with three different natural
 * cardinalities:
 *
 *   MUTEX      on shared mutable state (.claude/.proposals/latest.yaml,
 *              .claude/learning/learning-codified.json) — exactly 1, repo-wide,
 *              held across the write. Enforced by the SINGLETON on-disk lease in
 *              lib/codify-lease.js, NOT here.
 *   GRANT      is this write sanctioned? — 1 per operator, for the session.
 *              Enforced HERE, by the signer + scope checks above.
 *   BINDING    which branch / working tree — N per operator, per lane. Protects
 *              NOTHING. It is DERIVED, and this function was its only consumer.
 *
 * A lease records ONE branch name; git binds one branch name to one working
 * tree; so comparing them serialized every codify-class writer in a linked-
 * worktree forest onto a SINGLE tree. That is the defect, and the whole of the
 * fix is the one comparison that is no longer here.
 *
 * The corpus was enumerated before the comparison was dropped. Every reader of
 * the lease's branch field, with a control proving the search fires:
 *
 *   integrity-guard.js  (HERE)               the ONLY authorization consumer,
 *                                            and CIRCULAR — the lease recorded
 *                                            the branch *because* this compared it
 *   skills/41-onboard/SKILL.md               DISPLAY only (the /onboard banner)
 *   lib/codify-lease.js (conflict result)    DISPLAY only
 *
 * The falsifying result, named before the search ran: a fold rule, a sync
 * validator, or any second hook GATING on the branch. None exists.
 *
 * Nor did the comparison bound STALENESS, which is the plausible-sounding
 * reading to reject. A branch name is chosen freely by the very operator it
 * purported to constrain: anyone able to create `codify/<id>-<today>` is equally
 * able to create `codify/<id>-<the old lease's date>`. It constrained only
 * honest callers. Staleness is bounded by check 3 above — by the lease's OWN
 * recorded `acquired_at`, against the floor the minting surface sets — which is
 * the bound the branch name only ever impersonated.
 *
 * The `branch` PARAMETER is gone rather than merely unused, so restoring the
 * gate cannot be a one-line edit that reviews as harmless — the value is not in
 * scope here. `content.branch` stays RECORDED because /onboard and the conflict
 * message stay useful; it is informational, never authorization.
 */
/**
 * Does this lease's `scope_files` cover `candidateRel`?
 *
 * Returns true / false / **null**, where null means the scope is UNREADABLE and
 * the record must not authorize. The three match lines are byte-for-byte the
 * ones that lived inline in `findCoveringLease` before the extraction; the
 * `.claude/audit-fixtures/codify-lease-journal-scope/` pin holds them there.
 *
 * WHY A NON-STRING ENTRY RETURNS null RATHER THAN BEING SKIPPED. The obvious
 * defensive guard — `if (typeof s !== "string") continue;` — is a WIDENING, and
 * was measured as one: on `scope_files: [123, "journal/"]` the pre-extraction
 * loop reached `s.endsWith` with a number, threw a TypeError, and the
 * authorization phase converted that to `denyIndeterminate` — a REFUSAL. Skipping
 * the bad entry lets the sibling `"journal/"` authorize the very write the old
 * code refused. That is a loosening smuggled in under a change whose whole
 * purpose is to TIGHTEN, so it is not taken. null preserves the fail-closed
 * verdict and makes it deliberate rather than a crash artifact.
 *
 * An EMPTY-string entry is deliberately NOT treated as malformed: it flows
 * through the three checks and matches nothing (a repo-relative candidate never
 * equals "" nor starts with "/"), which is exactly what the pre-extraction loop
 * did with it. Only a NON-STRING is unreadable.
 
 *
 * ORDER-INDEPENDENCE (merged from the s48 lane). Validation is a PRE-PASS over
 * every entry, separated from matching. The inline form validated only entries
 * it REACHED, so `["journal/", 123]` authorized while `[123, "journal/"]`
 * refused — the same scope list decided by array ORDER. A fail-closed gate must
 * not have an order-dependent verdict, so any non-string ANYWHERE in the list
 * makes the scope unreadable. This refuses in one case the pre-extraction loop
 * allowed; that is the TIGHTENING direction security.md mandates for an
 * indeterminate input, and it is stated rather than smuggled.
 */
function leaseScopeCovers(content, candidateRel) {
  if (!Array.isArray(content.scope_files)) return false;
  const scope = content.scope_files;
  for (const s of scope) {
    if (typeof s !== "string") return null;
  }
  for (const s of scope) {
    // Exact match OR scope is a prefix dir.
    if (s === candidateRel) return true;
    if (s.endsWith("/") && candidateRel.startsWith(s)) return true;
    if (!s.includes(".") && candidateRel.startsWith(s + "/")) return true;
    // Single-segment glob — the bounded workspace-journal scope shape and its
    // kind. Ordered LAST so every literal entry keeps its existing, cheaper
    // decision path byte-for-byte; globCoversRel returns false immediately for
    // any entry carrying no wildcard, which is every entry this substrate
    // wrote before 2026-08-16. See guard-path-scope.js for why a glob exists.
    //
    // It sits INSIDE leaseScopeCovers, not at the findCoveringLease call site,
    // because main extracted the covering predicate here after this branch was
    // cut. Placing it at the old site would have left the glob unreachable
    // behind an earlier `covers === false` return — a scope entry that reads as
    // covering to the writer and as not-covering to the reader, which is the
    // exact writer/reader split `security.md` § Enforcement-Surface Parity
    // requires be closed in the SAME change.
    //
    // AFTER the non-string PRE-PASS above, so a glob cannot re-open the
    // order-independence hole that pass closed: an unreadable scope still
    // returns null before any matching runs.
    if (globCoversRel(s, candidateRel)) return true;
  }
  return false;
}

/**
 * Is this lease record STILL a grant? Signer and scope (above) are properties
 * of the record as WRITTEN; this is the property of its CURRENT STATE.
 *
 * ── THE POLARITY, WHICH IS THE WHOLE SUBTLETY ──────────────────────────────
 *
 * `codify-lease.js::_classifyLeaseLiveness` answers a DIFFERENT question with
 * the SAME inputs, and resolves ambiguity the OPPOSITE way — deliberately, and
 * both are fail-closed, because the two questions point in opposite directions:
 *
 *   THERE (mutex / ACQUIRE):  "may I STEAL this lease from its holder?"
 *                             indeterminate age -> HELD -> do NOT steal.
 *   HERE  (grant / AUTHORIZE): "may this WRITE proceed?"
 *                             indeterminate age -> DENY -> do NOT grant.
 *
 * So a lease with a missing, unparseable, or future-dated `acquired_at` is
 * treated as HELD by the acquire path and as NO GRANT by this one. That is not
 * a contradiction to be harmonized away by a later reader — flipping either to
 * match the other reintroduces a fail-OPEN on that side. Resolving indeterminacy
 * toward "held" HERE would make "ship a lease record with a broken timestamp" an
 * unbounded, never-expiring grant, which is the cheapest possible defeat of the
 * TTL.
 *
 * The TTL is IMPORTED from the minting surface, never re-declared. A second copy
 * is precisely the drift this function exists to close: the control lived at one
 * surface and the authorizing surface had never learned it
 * (rules/security.md § Enforcement-Surface Parity — ONE shared constant).
 *
 * ── WHY A RELEASE RECORD IS HONOURED NO MATTER WHO SIGNED IT ───────────────
 *
 * The release check does NOT require the release to be signed by the lease's own
 * holder, for two reasons. First, `acquireCodifyLease` emits a
 * `codify-lease-release` with `action: "reclaim-stale"` signed by the RECLAIMER
 * — a different operator — so a signer-matched release check would ignore
 * exactly the takeover case and leave a stolen lease authorizing. Second, every
 * record here has already cleared signature verification in the fold, and
 * honouring one can only ever DENY, which is this function's fail-closed
 * direction. The residual is that a rostered operator could append a release for
 * a sibling's lease_id to deny their writes; that is a signed, attributable,
 * self-healing nuisance (re-acquire a fresh lease) and not an escalation, so it
 * is the correct trade against a lease that never stops granting.
 */
function leaseGrantVerdict(content, releasedLeaseIds, nowMs, ttlMs) {
  const leaseId = content.lease_id;
  if (typeof leaseId !== "string" || !leaseId) {
    // No lease_id means this record cannot be PAIRED with the release that may
    // exist for it. That is indeterminate, and indeterminate denies here.
    return {
      ok: false,
      reason: "unpairable",
      detail:
        "the lease record carries no lease_id, so no codify-lease-release " +
        "record can be paired with it and whether it was released is UNKNOWN",
    };
  }
  if (releasedLeaseIds.has(leaseId)) {
    return {
      ok: false,
      reason: "released",
      detail: `lease ${leaseId} has a matching codify-lease-release record in the folded log`,
    };
  }

  const raw = content.acquired_at;
  if (typeof raw !== "string" || !raw) {
    return {
      ok: false,
      reason: "indeterminate-age",
      detail: `lease ${leaseId} carries no acquired_at timestamp — its age is INDETERMINATE, which DENIES on the authorization side`,
    };
  }
  const acquiredMs = Date.parse(raw);
  if (!Number.isFinite(acquiredMs)) {
    return {
      ok: false,
      reason: "indeterminate-age",
      detail: `lease ${leaseId} has an unparseable acquired_at '${raw}' — its age is INDETERMINATE, which DENIES on the authorization side`,
    };
  }
  const age = nowMs - acquiredMs;
  if (age < 0) {
    return {
      ok: false,
      reason: "indeterminate-age",
      detail: `lease ${leaseId} has a FUTURE-dated acquired_at '${raw}' (by ${-age}ms) — clock skew or a forged record; its age is INDETERMINATE, which DENIES on the authorization side`,
    };
  }
  if (age >= ttlMs) {
    return {
      ok: false,
      reason: "expired",
      detail: `lease ${leaseId} was acquired at ${raw}, ${age}ms ago, at or past the ${ttlMs}ms lease TTL enforced by the minting surface`,
    };
  }
  return { ok: true, reason: "covered", detail: null };
}

function findCoveringLease(
  accepted,
  candidateRel,
  selfVerifiedId,
  selfPersonId,
  nowMs,
  unreadable,
) {
  if (!Array.isArray(accepted)) {
    return { lease: null, reason: "none", detail: null };
  }

  // Required lazily rather than at module load: this call site is INSIDE the
  // authorization phase, so a require failure lands in the phase's catch and
  // routes to denyIndeterminate (fail-closed). A top-level require would crash
  // the hook before any handler exists to refuse on its behalf.
  const { LEASE_TTL_MS } = require("./lib/codify-lease.js");
  if (typeof LEASE_TTL_MS !== "number" || !Number.isFinite(LEASE_TTL_MS)) {
    throw new Error(
      "codify-lease.js did not export a usable LEASE_TTL_MS — the lease TTL " +
        "cannot be evaluated, so no lease may be treated as live",
    );
  }
  const now =
    typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();

  // PASS 1 — every released lease_id. Built in a FULL pass first because the
  // log is append-only and unordered with respect to this pairing: a release
  // may be appended by a different operator (reclaim-stale) and, across a fold
  // of several clones' chains, may sort before its own acquire.
  // Position bookkeeping for the indeterminacy scope (loom#1881 HIGH-2). Both
  // fields are supplied by the caller, which owns the file-position axis.
  const u = unreadable && typeof unreadable === "object" ? unreadable : {};
  const posBySig = u.posBySig instanceof Map ? u.posBySig : new Map();
  let lastUnreadablePos =
    typeof u.lastUnreadablePos === "number" ? u.lastUnreadablePos : -1;

  const releasedLeaseIds = new Set();
  for (const rec of accepted) {
    if (!rec || rec.type !== "codify-lease-release") continue;
    const lid = (rec.content || {}).lease_id;
    if (typeof lid === "string" && lid) {
      releasedLeaseIds.add(lid);
    } else {
      // A release record that carries no usable lease_id is a REVOCATION WE
      // CANNOT PAIR. The prior form dropped it silently, which is the same
      // skip-vs-fatal asymmetry ruled out on the scope side above, surviving on
      // the release side of this same function: the dropped record may be the
      // release for the very lease about to be authorized, and an accepted-set
      // lookup cannot tell that from "never released". Indeterminate DENIES.
      //
      // ERASURE CLASS 3, folded onto the SAME position axis as the other two
      // (loom#1881 HIGH-2). This record is ACCEPTED — it verified — so its
      // position is always resolvable; the only thing missing is the lease_id
      // that would pair it. It therefore implicates every lease above it and
      // none below, exactly like a parse-drop or a fold-reject.
      const s = rec.sig;
      const line = typeof s === "string" ? posBySig.get(s) : undefined;
      const at = typeof line === "number" ? line : Number.MAX_SAFE_INTEGER;
      if (at > lastUnreadablePos) lastUnreadablePos = at;
    }
  }

  // PASS 2 — the covering scan.
  let rejected = null;
  for (const rec of accepted) {
    if (!rec || rec.type !== "codify-lease") continue;
    const c = rec.content || {};
    // M3 HIGH-6 / F-9: lease signer MUST match the active operator.
    // Pre-hardening, the lease was scope+branch only — any operator
    // could ride another operator's lease so long as they happened to
    // be on the same codify branch. The structural defense is to bind
    // the lease to the signer (verified_id) AND/OR person_id of the
    // operator who acquired it; an Edit/Write fires only when self
    // matches that signer.
    const matchesSelf =
      (selfVerifiedId && rec.verified_id === selfVerifiedId) ||
      (selfPersonId && rec.person_id === selfPersonId);
    if (!matchesSelf) continue;
    const covers = leaseScopeCovers(c, candidateRel);
    if (covers === null) {
      // Unreadable scope — this record cannot authorize. Recorded as a
      // rejection (not a silent `continue`) so the refusal names the cause,
      // and the scan goes on: another record may hold a readable scope.
      //
      // Its OWN reason, not `unpairable`. `unpairable` means "no lease_id, so
      // no release can be paired with it"; this is "the scope list cannot be
      // evaluated". Reporting one on evidence for the other is the same
      // instrument-discipline MUST-1 error this file is corrected for twice.
      rejected = {
        ok: false,
        reason: "scope-unreadable",
        detail:
          "the lease record's scope_files contains a non-string entry, so its " +
          "scope is UNREADABLE and cannot be evaluated against this path",
      };
      continue;
    }
    if (!covers) continue;

    const verdict = leaseGrantVerdict(c, releasedLeaseIds, now, LEASE_TTL_MS);
    if (verdict.ok) {
      // The lease looks live — but "live" was read off `releasedLeaseIds`,
      // which is built from ACCEPTED records only. If the fold rejected ANY
      // codify-lease-release, revocation state is UNKNOWN for every lease in
      // this log: the rejected release may be the one for THIS lease_id, and
      // nothing surviving the fold can tell us. By this function's own stated
      // polarity, indeterminate DENIES on the authorization side.
      //
      // SCOPED to THIS lease (loom#1881 HIGH-2). The question is not "does the
      // log contain damage" — it is "could the damage be the release for THIS
      // lease". A record can only be this lease's release if it was appended
      // AFTER this lease was acquired, so an unreadable record ABOVE the lease
      // in the file is not evidence about it. The prior global form denied
      // every lease in the repo off one bad line and could not be cleared by
      // acquiring a fresh lease, which was a worse failure than the gap it
      // closed.
      //
      // A lease whose own position cannot be resolved falls back to the strict
      // reading (any damage at all implicates it) — an unlocatable record
      // cannot be shown to predate anything, and the fail-closed direction is
      // the one this function is for.
      const selfSig = rec.sig;
      const selfPos =
        typeof selfSig === "string" ? posBySig.get(selfSig) : undefined;
      const implicated =
        typeof selfPos === "number"
          ? lastUnreadablePos > selfPos
          : lastUnreadablePos >= 0;
      if (implicated) {
        return {
          lease: null,
          reason: "revocation-indeterminate",
          detail: `revocation state is UNVERIFIABLE for this lease: an UNREADABLE record (a fold-REJECTED record, an unparseable log line, or an accepted release carrying no usable lease_id) was appended AFTER this lease was acquired${typeof selfPos === "number" ? ` (lease at log line ${selfPos}, unreadable record at line ${lastUnreadablePos})` : " (this lease's own log position could not be resolved, so every unreadable record implicates it)"}. An accepted-set lookup cannot distinguish 'never released' from 'the release could not be read', and the unreadable record may be the release for THIS lease. Acquiring a FRESH lease clears this: a lease appended below the damage is not implicated by it`,
        };
      }
      return { lease: rec, reason: "covered", detail: null };
    }
    // Signer + scope matched but the lease is no longer a grant. Remember WHY
    // and keep scanning — a live lease may sit later in the log.
    //
    // THE SCAN MUST NOT STOP HERE. The coordination log is APPEND-ONLY, so an
    // established repo's log is dominated by covering records that are long
    // dead — measured on loom's own log when this check was added: 195
    // `codify-lease` records, of which 195 were released AND 195 were past the
    // TTL, and 0 were live. Returning the first covering-but-dead record as the
    // verdict would refuse every codify write in the repo, which is strictly
    // worse than the gap this closes. The remembered rejection is the LAST one
    // seen, which under append-order is the most recent.
    rejected = verdict;
  }

  if (rejected) {
    return { lease: null, reason: rejected.reason, detail: rejected.detail };
  }
  return { lease: null, reason: "none", detail: null };
}

// ---- main -------------------------------------------------------------------

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  fallback = setTimeout(() => {
    if (authPhase)
      denyIndeterminate(`the ${AUTH_BUDGET_MS}ms hook budget expired`);
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, DEFAULT_TIMEOUT_MS);
  return main();
}

async function main() {
  try {
    const payload = await readStdinBounded();
    const hookEvent = payload.hook_event_name || "PreToolUse";

    const watch = isWatchedTool(payload);
    if (!watch.watched) {
      passthrough();
    }

    // M3 MED-5 / F-11: resolve main-checkout root for the registry-level
    // operations (fold + lease resolution). When the hook is invoked
    // from a worktree, the underlying coordination-log + roster live
    // in the MAIN checkout per trust-posture.md MUST-1. We still use
    // the worktree's cwd for the branch check (a worktree has its own
    // HEAD) but route registry I/O through the main checkout.
    const sessionCwd = resolveRepoDir(payload);
    // Captured BEFORE any gate reads it, so the corroboration pass below and the
    // primary resolution above agree on whether the env was steering at all.
    const envOverrideActive = envRepoDirOverrideActive(payload);
    // loom#1471 F7b — the former `resolveMainCheckout(sessionCwd) || sessionCwd`
    // could not fail closed: the legacy accessor returns `startCwd` (never a
    // falsy value) when git could not identify a main checkout, so the `||` was
    // unreachable. That `repoDir` then fed `isCoordinationEnabled` below, which
    // reads false against a directory holding no roster and no genesis — and the
    // OFF branch calls `passthrough()`, so THIS ENTIRE FENCE disabled itself on
    // any host where git cannot answer (a differently-owned checkout fatals with
    // `detected dubious ownership`; `gitEnv()` discards `safe.directory`).
    // Measured: CONTROL (real worktree) enabled=true → fence runs; PROBE (git
    // cannot answer) enabled=false → passthrough().
    const mainRes = requireMainCheckout(sessionCwd);
    if (!mainRes.ok) {
      clearTimeout(fallback);
      emit({
        hookEvent,
        severity: "block",
        what_happened: `Edit/Write on an integrity-critical path, but the MAIN checkout could not be identified: ${mainRes.reason}`,
        why: "multi-operator-coc/integrity-guard — every check below (coordination-enabled, roster, genesis, codify-lease) is read RELATIVE to the main checkout. With the root unidentified those reads answer about some other directory, and the coordination-enabled read in particular comes back false, whose branch is `passthrough()` — the fence would silently disable itself exactly when it cannot tell where it is. Refusing is the fail-closed direction (`rules/security.md` § Enforcement-Surface Parity). Severity is block — the same disposition, on the same reasoning, as signing-mutation-guard.js on this same predicate: the signal is process-state (git exited non-zero), the structural grounding hook-output-discipline.md MUST-2 requires — a lexical match would not qualify. MUST-2 PERMITS block here; what REQUIRES it is that halt-and-report maps to continue:true and the Edit/Write RUNS (lib/instruct-and-wait.js), so on a mutation fence it is not a softer refusal but no refusal at all, leaving exactly the fail-open described above. The operator's recovery path is CLAUDE_TRUST_STATE_DIR, named in the report below.",
        agent_must_report: [
          `Session cwd: ${sessionCwd}`,
          `Resolver reason: ${mainRes.reason}`,
          "The integrity fence did NOT run — its result is UNKNOWN, not clean.",
          "If this is a differently-owned checkout, `git` reports `detected dubious ownership`; take ownership of the checkout, or set CLAUDE_TRUST_STATE_DIR to pin the trust-state root explicitly.",
        ],
        agent_must_wait:
          "Do not retry the Edit/Write until git can identify the main checkout, or the operator pins CLAUDE_TRUST_STATE_DIR.",
        user_summary:
          "integrity-guard — main checkout unidentifiable; fence refused rather than passed through",
      });
      // emit() exits
    }
    let repoDir = mainRes.repoDir;
    let scope = {};
    let wp = isWatchedPath(watch.targetPath, repoDir, scope);
    // loom#1871 HIGH-1 — CORROBORATE AN ENV-SUPPLIED JURISDICTION BEFORE ANY
    // PASSTHROUGH. Both remaining pre-auth passthrough arms (unwatched path,
    // coordination disabled) read the SAME `repoDir`, and `resolveRepoDir`
    // accepts `COC_OPERATOR_REPO_DIR` on the sole evidence that the directory
    // exists. This is evaluated ONCE, here, covering both arms — see
    // `corroborateOverride` for the two-pole measurement and why the arm the
    // review named is not the arm control actually takes.
    const govAfterOverride = wp.watched && isGovernanceEnabled(repoDir);
    const corroborated = corroborateOverride(
      watch.targetPath,
      { watched: wp.watched, governanceEnabled: govAfterOverride },
      payload,
      { overrideActive: envOverrideActive },
    );
    if (corroborated && corroborated.uncorroborated) {
      // The override produced a PASSTHROUGH and the override-free root could not
      // be resolved, so whether the override is WIDENING the fence is UNKNOWN —
      // and UNKNOWN is not clean on a mutation fence.
      clearTimeout(fallback);
      emit({
        hookEvent,
        severity: "block",
        what_happened: `Edit/Write on '${watch.targetPath}' with COC_OPERATOR_REPO_DIR steering the fence to '${sessionCwd}', which yields a PASSTHROUGH — but the override-free root could not be resolved, so the override could not be corroborated: ${corroborated.reason}`,
        why: "multi-operator-coc/integrity-guard (loom#1871 HIGH-1) — an env-supplied jurisdiction may NARROW this fence but never WIDEN it, and that is checked by re-running the watched-path and coordination predicates against the override-FREE root. Here that root could not be resolved, so the check could not answer. Honouring the override on that basis would mean the corroboration is defeated by making its own baseline unreadable — a cheaper attack than the one it closes. Severity is block on the same signal and the same reasoning as this guard's unidentifiable-main-checkout arm: git exited non-zero, which is the process-state class hook-output-discipline.md MUST-2 accepts, and halt-and-report maps to continue:true (lib/instruct-and-wait.js), so on a mutation fence it is no refusal at all.",
        agent_must_report: [
          `Target path: ${watch.targetPath}`,
          `COC_OPERATOR_REPO_DIR: ${sessionCwd}`,
          `Override-free root consulted: ${unoverriddenRepoDir(payload)}`,
          `Why it could not be resolved: ${corroborated.reason}`,
          "The fence did NOT run — its result is UNKNOWN, not clean.",
          "Remediation: unset COC_OPERATOR_REPO_DIR (it is test injection, not an operator setting), or run from a session cwd inside a resolvable checkout of this repository.",
        ],
        agent_must_wait:
          "Do not retry the Edit/Write until COC_OPERATOR_REPO_DIR is unset, or the session cwd resolves to a real main checkout.",
        user_summary: `integrity-guard — COC_OPERATOR_REPO_DIR override UNCORROBORATED for ${watch.targetPath}; refused rather than passed through`,
      });
      // emit() exits
    }
    if (corroborated) {
      repoDir = corroborated.repoDir;
      scope = corroborated.scope;
      wp = corroborated.wp;
    }
    if (!wp.watched) {
      // Unwatched path — silent passthrough.
      passthrough();
    }

    // MO-OPT W1-b — opt-in gate (workspaces/multi-operator-optional, journal/0330).
    // When the coordination substrate is DISABLED (a solo / fresh repo that
    // never enrolled — no roster+genesis, no explicit switch), the entire
    // codify-branch + lease fence is a no-op: a watched path is editable from
    // any branch, exactly as on a single-writer repo. This fixes THE worst
    // disruption (analysis §A): integrity-guard otherwise blocks every
    // Edit/Write to journal/team-memory/learning/roster on main/feat/* with no
    // coordination precondition. When ENABLED, everything below is byte-unchanged
    // (the S6 invariant — this adds one early branch on the OFF path only).
    // isGovernanceEnabled is synchronous and never throws into the guard.
    //
    // loom#1896 — this reads GOVERNANCE, not COORDINATION. The protected case
    // is a never-enrolled repo (no roster, no genesis), and governance is OFF
    // there, so the MO-OPT W1-b disruption fix above is preserved byte-for-byte.
    // What changes is the enrolled-SOLO repo: it keeps this fence, because one
    // human is not evidence that an AGENT may rewrite the roster off-lease.
    if (!isGovernanceEnabled(repoDir)) {
      passthrough();
    }

    // loom#1849b — ENTER THE AUTHORIZATION PHASE. Everything established: this
    // is a mutation tool, on a watched integrity-critical path, on a
    // coordination-ENABLED repo. The only question left is whether the write is
    // authorized, so from here an indeterminate answer refuses instead of
    // passing through. See `denyIndeterminate` for why this line and not an
    // earlier one, and `enterAuthPhase` for why the budget is re-armed here.
    enterAuthPhase(hookEvent, wp.rel);

    // Resolve identity. Even un-rostered keys get past this gate (the
    // codify-branch + lease checks fire equally). We need display_id
    // for the branch-name predicate AND verified_id + person_id for
    // HIGH-6 lease-ownership matching.
    const explicitKey = process.env.COC_OPERATOR_KEY_PATH;
    const identity = resolveIdentity(repoDir, {
      signingKeyPath: explicitKey || undefined,
      keyType: explicitKey ? "ssh" : undefined,
    });
    const displayId = (identity && identity.display_id) || null;
    const selfVerifiedId = (identity && identity.verified_id) || null;
    const selfPersonId = (identity && identity.person_id) || null;

    // (1) Structural branch predicate — `git rev-parse --abbrev-ref HEAD`, run
    // against THE TREE THAT OWNS THE TARGET PATH.
    //
    // NOT repoDir (the main checkout) and — since loom#1656 — NOT sessionCwd
    // either. Routing registry I/O through the main checkout (repoDir, below) is
    // correct and unchanged; what the BRANCH predicate must answer is "what
    // branch is the file being written on", and in a forest of linked worktrees
    // that is a property of the TARGET, never of wherever the session's cwd
    // happens to sit.
    //
    // #1414 fixed this once, from repoDir to sessionCwd, on the reasoning that
    // "a worktree has its OWN HEAD". True, and insufficient: the harness reports
    // the SESSION's cwd, which for an agent dispatched from the primary checkout
    // is the primary checkout, while the Edit/Write carries an ABSOLUTE path into
    // a lane's worktree. So the two are routinely different trees and the fence
    // judged the wrong one. Measured on the fixture, primary on codify/*, the
    // lane's worktree on feat/*, writing `<worktree>/journal/0002.md`:
    //
    //   pre-fix   exit 0  "continue":true   "Branch: codify/primary-2026-08-12"
    //   post-fix  exit 2  [BLOCK]           "Active branch: feat/lane-work"
    //
    // The pre-fix row is a FAIL-OPEN, not a cosmetic mislabel: halt-and-report
    // maps to continue:true (lib/instruct-and-wait.js), so the write RAN. Any
    // session with the primary parked on a codify branch — the ordinary state
    // during a /codify — disabled the fence for every one of the ~30 linked
    // worktrees at once. #1471 pinned WHICH ENVIRONMENT answers this predicate;
    // this pins WHICH WORKING TREE, the adjacent axis of the same clause.
    //
    // `scope.matchedRoot` is the root whose rel matched in isWatchedPath above,
    // so the branch predicate and the watched-path predicate now answer about
    // ONE tree by construction rather than by coincidence.
    // loom#1664 — a RELATIVE target names no owning tree that can be
    // established from the payload, so it cannot answer the BRANCH question
    // however well it answers the watched-path one. The resolver reads a
    // non-escaping rel as repoDir-relative and reports `matchedRoot` = the MAIN
    // CHECKOUT; taking that as the branch tree makes the fence judge the primary
    // while the write lands wherever the tool resolves the relative path — the
    // #1656 failure mode surviving in a second spelling. Measured A/B on the
    // #1664 fixture (primary on codify/*, session in a lane worktree on feat/*,
    // `file_path: "journal/0002-rel.md"`):
    //
    //   pre-#1656   exit 2  [BLOCK]        branch=feat/lane-work
    //   post-#1656  exit 0  continue:true  branch=codify/primary-2026-08-12  <- RAN
    //
    // i.e. this PR WIDENED the refused-write set on that path. Fail closed
    // instead, matching this hook's disposition for a detached or unresolvable
    // owning tree. The resolver's repoDir-relative convention is deliberately
    // NOT changed — it is house-wide (journal-write-guard.js,
    // signing-mutation-guard.js, adjacency-leasecheck.js) and correct for the
    // WATCHED question; only the BRANCH question, which needs a real tree with a
    // readable HEAD, refuses here.
    const targetIsAbsolute = path.isAbsolute(watch.targetPath);
    const branchTree = targetIsAbsolute ? scope.matchedRoot : null;
    if (!branchTree) {
      // FAIL CLOSED. Either the target is relative (loom#1664 — no owning tree
      // is derivable from the payload at all), or the resolver matched it only
      // through its fail-closed SUFFIX branch, which names no owning tree
      // (guard-path-scope.js) — so there is no HEAD to read. Substituting
      // sessionCwd here is exactly the #1656 defect with an extra step, and it
      // would substitute it precisely on the paths whose jurisdiction is already
      // indeterminate.
      clearTimeout(fallback);
      emit({
        hookEvent,
        severity: "block",
        what_happened: targetIsAbsolute
          ? `Edit/Write on integrity-critical path '${wp.rel}', but the working tree that OWNS that path could not be identified.`
          : `Edit/Write on integrity-critical path '${wp.rel}' given as a RELATIVE path, which names no working tree whose branch can be checked.`,
        why: targetIsAbsolute
          ? "multi-operator-coc/integrity-guard — the codify-branch fence reads `git rev-parse --abbrev-ref HEAD` in the tree the TARGET lives in. That path matched only through the resolver's fail-closed suffix branch, which names no owning tree, so there is no HEAD to read and the branch verdict is UNKNOWN — not clean. Falling back to the session's cwd is loom#1656 itself: in a linked-worktree forest that is routinely a DIFFERENT tree, and the fence would judge a branch nobody is writing from. Severity is block for the same reason as the unidentifiable-main-checkout branch above: halt-and-report maps to continue:true (lib/instruct-and-wait.js), so on a mutation fence it is no refusal at all and the write would land with the branch contract unverified."
          : "multi-operator-coc/integrity-guard (loom#1664) — the codify-branch fence reads `git rev-parse --abbrev-ref HEAD` in the tree the TARGET lives in, and a relative path does not name one. The resolver reads a non-escaping rel as MAIN-CHECKOUT-relative, so treating its root as the branch tree would judge the primary's HEAD while the write lands wherever the writing tool resolves the path — routinely a different worktree, which is loom#1656 in a second spelling. The branch verdict is therefore UNKNOWN, and UNKNOWN is not clean on a mutation fence.",
        agent_must_report: [
          `Target path: ${wp.rel}`,
          `Session cwd: ${sessionCwd}`,
          "The codify-branch fence did NOT run — its result is UNKNOWN, not clean.",
          targetIsAbsolute
            ? "This usually means the target is not inside a resolvable git working tree (git absent or errored), or a tree resolved but produced no usable repo-relative path."
            : "The Edit/Write supplied a RELATIVE file_path. Which working tree it lands in depends on the writing tool's cwd, so the fence cannot establish which branch would receive it.",
          targetIsAbsolute
            ? "Remediation: run the Edit/Write against a path inside a resolvable working tree of this repository."
            : "Remediation: re-issue the Edit/Write with an ABSOLUTE file_path naming the intended working tree.",
        ],
        agent_must_wait: targetIsAbsolute
          ? "Do not retry the Edit/Write until the target path resolves inside a working tree whose HEAD can be read."
          : "Do not retry the Edit/Write until it names an ABSOLUTE path inside a working tree whose HEAD can be read.",
        user_summary: `integrity-guard — owning worktree unidentifiable for ${wp.rel}; fence refused rather than passed through`,
      });
      // emit() exits
    }
    const branch = resolveActiveBranch(branchTree);
    // loom#1481 — the roster is read HERE, not only inside the fold below,
    // because the branch fence needs it when OUR display_id did not resolve
    // (isCodifyBranch's § "WHEN display_id DOES NOT RESOLVE"). Same `loadRoster`
    // call the fold uses, hoisted and reused, so the two surfaces cannot answer
    // from different roster reads.
    const roster = loadRoster(repoDir);
    const branchVerdict = isCodifyBranch(branch, displayId, roster);

    if (!branchVerdict.match) {
      // BLOCK — structural signal (process-local git invocation).
      clearTimeout(fallback);
      // loom#1871 F4a — when OUR identity did not resolve, the headline must
      // name THAT, not the branch's operator name. The two are different
      // propositions: "this branch belongs to someone else" is a claim about
      // the world; "I cannot tell who you are" is a claim about the
      // INSTRUMENT. The verdict already carries `identityUnresolved`, and the
      // remediation line below already said the right thing — but
      // `what_happened` is the sentence the operator actually reads, and it
      // announced a foreign branch, which is the derived conclusion standing
      // in for the unanswered question (`instrument-discipline.md` MUST-1,
      // `probe-driven-verification.md` MUST-7: not-having-run must not be
      // spelled the same as a substantive answer).
      const identityNote = branchVerdict.identityUnresolved
        ? `, but THE OPERATOR'S IDENTITY COULD NOT BE RESOLVED — so the fence cannot establish whether this branch is yours. The operator name in the branch is NOT a claim about who you are`
        : null;
      const foreignNote =
        branchVerdict.foreign && !branchVerdict.identityUnresolved
          ? ` (foreign codify-branch for operator ${branchVerdict.foreignDisplayId})`
          : "";
      // Same idiom the identity-unresolved lease branch below uses, so the two
      // surfaces name the consulted source identically rather than drifting.
      const keySource = explicitKey
        ? `COC_OPERATOR_KEY_PATH=${explicitKey}`
        : "git config user.signingkey / the default key locations";
      emit({
        hookEvent,
        severity: "block",
        what_happened: identityNote
          ? `Edit/Write on integrity-critical path '${wp.rel}' from branch '${branch || "<unknown>"}'${identityNote}.`
          : `Edit/Write on integrity-critical path '${wp.rel}' from branch '${branch || "<unknown>"}'${foreignNote}.`,
        why: "multi-operator-coc/integrity-guard §2.3 — integrity-critical artifacts (operators.roster.json, coordination-log.jsonl, posture.json, journal/, team-memory/) MUST be edited only through the /codify flow per architecture v11 §6.4 + §7.1 (Step 0 acquireCodifyLease → codify/<display_id>-<date> branch → PR → admin-merge). Branch resolution via `git rev-parse --abbrev-ref HEAD` IS the structural primitive (hook-output-discipline.md MUST-2): process-local deterministic, not lexical match.",
        agent_must_report: [
          `Target path: ${wp.rel}`,
          `Active branch: ${branch || "<unresolved>"}`,
          `Expected branch shape: codify/${displayId || "<your-display_id>"}-YYYY-MM-DD[-<lane>]`,
          "The optional -<lane> suffix is how two concurrent sessions of the SAME operator on the SAME date get distinct branches, and therefore distinct working trees. Pick a lane name; one lease covers them all.",
          "Run /codify to acquire a lease + open a codify branch before retrying the edit.",
          ...(branchVerdict.identityUnresolved
            ? [
                `Identity source consulted: ${keySource}${
                  explicitKey && !fs.existsSync(explicitKey)
                    ? " — THIS PATH DOES NOT EXIST, which is very likely the whole cause"
                    : ""
                }. Without naming the source, the operator cannot act on this refusal.`,
              ]
            : []),
          branchVerdict.identityUnresolved
            ? `YOUR display_id did not resolve, and this branch names the ROSTERED operator '${branchVerdict.foreignDisplayId}' — so the fence cannot establish that the branch is yours, and refuses rather than skipping the check (loom#1481). This is NOT a claim that you are a different operator. Run /whoami: if it reports no display_id, fix identity resolution (roster entry, signing key, COC_OPERATOR_KEY_PATH) before retrying. An ad-hoc lane token that names no rostered operator is not refused here.`
            : branchVerdict.foreign
              ? `Foreign codify branch detected (operator ${branchVerdict.foreignDisplayId}) — coordinate with that operator OR open your own codify branch.`
              : "If the edit is genuinely outside /codify scope (e.g. a developer-facing comment), state that and ask the user before proceeding.",
        ],
        agent_must_wait:
          "Do not retry the Edit/Write off-codify. Acquire a codify lease via /codify, switch to the codify/<display_id>-<date> branch, then retry.",
        user_summary: `integrity-guard — BLOCK on ${wp.rel} off-codify-branch (${branch || "<unknown>"})`,
      });
      // emit() exits
    }

    // (2) Codify-lease verification against the fold.
    const transport = createFilesystemTransport(repoDir);
    let accepted = [];
    let readIndeterminate = null;
    // loom#1881 HIGH-2. This was a COUNT, and a count is a GLOBAL fact about
    // the log: `n > 0` denied EVERY lease in the repo, including leases
    // acquired long after the offending record and leases it could never have
    // referred to. Measured on the commit that introduced it: one appended
    // `codify-lease-release` carrying `lease_id: 123` denied every codify write
    // repo-wide, and the remediation its own source comment named —
    // "re-acquire a fresh lease" — did NOT clear it, because the fresh lease
    // was denied by the same global predicate. That is a permanent, one-line,
    // repo-wide denial of service, and it did not exist before the hardening.
    //
    // It is now a POSITION: the file line of the LAST unreadable record. An
    // unreadable record can only be the erased release for a lease that was
    // already in the log when it was appended, so it implicates leases ABOVE
    // it and nothing below. That keeps the fail-closed direction where the
    // evidence actually points, and makes "acquire a fresh lease" work — a
    // record appended now sits below all existing damage.
    let lastUnreadablePos = -1;
    // FILE line of each record, keyed by signature. `fold.accepted` is not in
    // file order (the engine groups by emitter), so the ordering axis has to
    // be carried in rather than inferred from array position.
    let posBySig = new Map();
    try {
      const detailed = await transport.readAllRecordsDetailed();
      const records = detailed.records;
      for (let k = 0; k < records.length; k++) {
        const s = records[k] && records[k].sig;
        if (typeof s === "string" && s)
          posBySig.set(s, detailed.lineIndices[k]);
      }
      // ERASURE CLASS 1 — a line that did not parse at all. It is dropped
      // BEFORE the fold (transport-filesystem.js::readAllRecordsDetailed), so
      // no fold-level counter has ever been able to see it. Measured:
      // corrupting a release line to junk turned a DENY back into a GRANT.
      for (const line of detailed.parseDropLines) {
        if (line > lastUnreadablePos) lastUnreadablePos = line;
      }
      // loom#1481 — `roster` is the SAME read the branch fence above used
      // (hoisted there), not a second one: two reads could disagree if the file
      // changed between them, and the branch verdict and the fold must answer
      // from one roster.
      // Sandboxed engine: register the codify-lease predicate. M7 E writes
      // the record; B3a reads it. Sandboxed (createEngine) so the
      // module-default registry is unmodified for parallel callers.
      const engine = createEngine();
      // BOTH halves of the lease lifecycle, with the SAME checkpoint exemption.
      // The module default is `checkpoint_exempt: false` for each, on the
      // reasoning that "a released lease has no post-checkpoint value" — true
      // while the record was pure cross-clone VISIBILITY, and FALSE as of the
      // 2026-08-21 fix that made the release an AUTHORIZATION REVOCATION.
      // Exempting the acquire alone is the fail-open asymmetry: a checkpoint
      // that prunes the release while keeping its acquire resurrects a
      // released lease as a live grant for the remainder of the TTL, and
      // acquire -> release -> checkpoint inside 12h is the NORMAL /codify
      // shape, not an exotic one. Latent today (no consumer prunes on
      // `up_to_seq`), fixed here because it is the same enforcement-surface
      // -parity class as the rest of this change (rules/security.md).
      for (const leaseType of ["codify-lease", "codify-lease-release"]) {
        engine.registerFoldPredicate(
          leaseType,
          (record, ctx) => ({ accepted: true, foldState: ctx.foldState }),
          {
            checkpoint_exempt: true,
            authoritative_for_record: true,
            authoritative_for_aggregate: false,
          },
        );
      }
      // THE BUDGET IS HANDED TO THE FOLD, because the timer cannot reach it
      // (loom s49 P5).
      //
      // `enterAuthPhase` above arms `AUTH_BUDGET_MS` on a setTimeout whose
      // handler is `denyIndeterminate`, and the comment there states that from
      // that point the ONLY disposition on expiry is a refusal. That is true of
      // the TIMER. It was NOT true of this call, and the gap was measured
      // rather than reasoned about (2026-08-21, loom's own 919-record log):
      //
      //   COC_INTEGRITY_GUARD_TIMEOUT_MS=1     -> exit 2, "budget expired",  110ms
      //   COC_INTEGRITY_GUARD_TIMEOUT_MS=1000  -> exit 2, DETERMINED verdict, 9175ms
      //
      // The first pole is the known-answer control: it shows the process CAN
      // print the budget refusal, so the second pole's silence is evidence and
      // not merely an absent signal. A 1000ms budget yielding a 9175ms hook is
      // the whole finding — `foldLog` is synchronous, so its handler could not
      // run until the fold had already finished and the guard had emitted. The
      // arm was reachable only during the async log read, i.e. everywhere
      // except where the time is actually spent. A fail-closed guarantee that
      // cannot fire on the path that exhausts the budget reads as coverage
      // while providing none.
      //
      // Passing an absolute deadline makes the fold check it in its own loop,
      // which is the one thing that CAN preempt a synchronous loop. On expiry
      // foldLog throws FOLD_DEADLINE_EXCEEDED, caught below and routed to
      // `denyIndeterminate` — the same disposition the timer documents, now
      // actually reachable from the phase that consumes the budget.
      const fold = engine.foldLog(records, roster, {
        deadlineAtMs: PROCESS_STARTED_AT + FOLD_BUDGET_MS,
      });
      accepted = fold && Array.isArray(fold.accepted) ? fold.accepted : [];
      // A PARTIAL fold is not a clean fold. `foldLog` returns a `rejected`
      // array (rule-1 unverified sig / roster-absent key, rule-2 prev_hash
      // mismatch, rule-4), and DISCARDING it made a rejected release
      // indistinguishable from NO release: `releasedLeaseIds` is built from
      // `accepted` alone, so `Set.has()` returning false is consistent with
      // BOTH "no release exists" AND "the release was rejected" — and the only
      // instrument that discriminates was thrown away one line above
      // (rules/instrument-discipline.md MUST-1). The live shape is ordinary:
      // acquire -> chain breaks (re-clone with a fresh seed, unfetched sibling
      // record, partial ref fetch — coordination-log.js:2227 documents it) ->
      // release is rule-2 rejected -> the released lease keeps authorizing for
      // the rest of the TTL. The audit trail says released; the fence said
      // granted. TOTAL fold failure already routes to readIndeterminate; this
      // is the PARTIAL arm, which had none.
      //
      // ERASURE CLASS 2 — a record the fold REJECTED. The prior form filtered
      // these by `type === "codify-lease-release"`, which is the bug HIGH-1
      // names: `type` is INSIDE the signed content, so a record whose type was
      // renamed is rejected (rule 1) AND no longer matches the filter — the
      // tamper that erases a release also erases the evidence that it was one.
      // Measured: renaming `codify-lease-release` to `codify-lease-releasX`
      // turned a DENY back into a GRANT. A rejected record's self-declared
      // type is unverified by construction, so the only sound reading is that
      // ANY rejected record may be an erased release. Widening this is safe
      // ONLY because the indeterminacy is now position-scoped: without that,
      // one rejected record of any type would brick the repo.
      for (const r of fold && Array.isArray(fold.rejected)
        ? fold.rejected
        : []) {
        const rec = r && r.record ? r.record : r;
        const s = rec && rec.sig;
        const line = typeof s === "string" ? posBySig.get(s) : undefined;
        // A rejected record whose position cannot be resolved is treated as
        // being at the END of the log — the fail-closed reading, since an
        // unlocatable record cannot be shown to predate anything.
        const at = typeof line === "number" ? line : Number.MAX_SAFE_INTEGER;
        if (at > lastUnreadablePos) lastUnreadablePos = at;
      }
    } catch (err) {
      // BUDGET EXPIRY GETS ITS OWN DISPOSITION, not the unreadable-log one.
      // Both refuse, but they are DIFFERENT FACTS with different remediation:
      // the log here was perfectly readable and the fold simply did not finish
      // in time. Reporting "the coordination log could not be read" would send
      // an operator to check file permissions on a file with nothing wrong
      // with it — the same assert-one-state-on-evidence-for-another error this
      // guard carries three prior corrections for. `denyIndeterminate` is the
      // disposition `enterAuthPhase` already documents for budget expiry; this
      // is the path that finally reaches it.
      if (err && err.code === "FOLD_DEADLINE_EXCEEDED") {
        denyIndeterminate(
          `the ${FOLD_BUDGET_MS}ms fold budget expired during the coordination-log fold`,
          `folded ${err.recordsFolded} of ${err.recordsTotal} records before the deadline. ` +
            `Signature verification runs once per record, so fold cost grows with log length; ` +
            `a log that has outgrown the budget needs a checkpoint, not a retry.`,
        );
        // denyIndeterminate exits
      }
      // INDETERMINATE — the log could not be read or folded. This is NOT an
      // empty log. Rebuilding `[]` here and falling through would hand
      // findCoveringLease the exact input a genuinely lease-less log produces,
      // and the emit below would then state "no covering codify-lease record
      // found" — a POSITIVE claim on evidence that supports only "could not
      // read" (rules/instrument-discipline.md MUST-1: a result consistent with
      // both branches of the hypothesis is not evidence for either).
      readIndeterminate = err && err.message ? err.message : String(err);
      accepted = [];
    }

    if (readIndeterminate) {
      clearTimeout(fallback);
      emit({
        hookEvent,
        severity: "block",
        what_happened: `Edit/Write on integrity-critical path '${wp.rel}', but the coordination log could not be read or folded: ${readIndeterminate}`,
        why: "multi-operator-coc/integrity-guard — the codify-lease check reads the folded coordination log, and that read FAILED. The lease is therefore UNKNOWN, not absent: this branch must not reuse the lease-absent message below, which asserts the log was read and held no covering record. Severity is block, matching this guard's own indeterminate-ROOT branch above and for the same reason: halt-and-report maps to continue:true (lib/instruct-and-wait.js), so on a mutation fence it is no refusal at all and the Edit/Write on an integrity-critical path would land with authorization unverified. The signal is distinct from the lease-absent case one layer down — that one is registry-level, which hook-output-discipline.md MUST-2 holds BELOW block; this one is a filesystem/process-state failure (EACCES/EISDIR/EIO on the log), the structural class MUST-2 accepts.",
        agent_must_report: [
          `Target path: ${wp.rel}`,
          `Branch: ${branch}`,
          `Why the check could not answer: ${readIndeterminate}`,
          "State explicitly that the codify-lease is UNKNOWN for this path — NOT that it is missing.",
          "Remediation: make .claude/learning/coordination-log.jsonl readable (check permissions, and that it is a regular file), then retry.",
        ],
        agent_must_wait:
          "Do not retry the Edit/Write until the coordination log is readable and the lease can actually be verified.",
        user_summary: `integrity-guard — coordination log UNREADABLE; lease INDETERMINATE for ${wp.rel} (not a clean result)`,
      });
      // emit() exits
    }

    // loom#1871 HIGH-2 — AN UNRESOLVED IDENTITY IS ITS OWN VERDICT, NOT A
    // MISSING LEASE.
    //
    // `findCoveringLease` accepts a record only on
    // `(selfVerifiedId && rec.verified_id === selfVerifiedId) ||
    //  (selfPersonId && rec.person_id === selfPersonId)`. With BOTH null every
    // record is skipped, the function returns null, and control reaches the
    // DETERMINED-NO branch — which #1871 raised from halt-and-report to block.
    // Before that raise this was a report and the session continued; after it,
    // an operator whose signing key is absent, unreadable, or mis-pointed by
    // COC_OPERATOR_KEY_PATH is refused on EVERY watched path at once, and the
    // message tells them to "run /codify Step 0 (acquireCodifyLease)" — which
    // signs the lease record with the identity that is precisely what could not
    // be resolved. The stated remediation cannot clear the state it is offered
    // for. That is a LOCKOUT WITH WRONG INSTRUCTIONS, and it is a strictly worse
    // failure mode than the fail-open #1871 replaced, because the operator has
    // no readable path out.
    //
    // DENY OR REPORT — the judgment, argued rather than assumed. It DENIES.
    // Reporting would make "make your identity unresolvable" the cheapest
    // disable of this entire fence: unset one env var, or point
    // COC_OPERATOR_KEY_PATH at a nonexistent file, and every integrity-critical
    // write passes. That is the same ordinary-looking-config-edit vector as
    // HIGH-1 above, so a fail-open here would reopen by a second door what this
    // PR closes at the first. What makes the deny legitimate is that it is
    // RECOVERABLE WITHOUT A LEASE: every remediation below (point the key path
    // at a real file, fix its permissions, start the agent, run /whoami) is an
    // ENVIRONMENT action, not a write to a watched path, so none of them is
    // fenced by this guard. The unrecoverable half of the finding is what is
    // fixed; the refusal itself is correct and is kept.
    //
    // The verdict class is INDETERMINATE, not a determined no: the guard is not
    // saying this operator holds no lease, it is saying it cannot tell WHO is
    // asking. Severity `block` on the same two-part reading the arms above
    // record — PERMITTED because the signal is filesystem/process state (a key
    // file that does not exist or will not read, an ssh-keygen that failed), the
    // structural class hook-output-discipline.md MUST-2 accepts, and not a
    // lexical match over prose; REQUIRED because halt-and-report maps to
    // {"continue":true} (lib/instruct-and-wait.js), which on a mutation fence is
    // no refusal at all.
    //
    // Narrow by construction: an UN-ROSTERED key still yields
    // `verified_id = <fingerprint>` (operator-id.js Tier 2), and a
    // coordination-OFF repo never reaches this line, so this branch fires ONLY
    // where no fingerprint could be derived at all.
    if (!selfVerifiedId && !selfPersonId) {
      const keySource = explicitKey
        ? `COC_OPERATOR_KEY_PATH=${explicitKey}`
        : "git config user.signingkey / the default key locations";
      const keyExists = explicitKey ? fs.existsSync(explicitKey) : null;
      clearTimeout(fallback);
      emit({
        hookEvent,
        severity: "block",
        what_happened: `Edit/Write on integrity-critical path '${wp.rel}', but THE OPERATOR'S IDENTITY COULD NOT BE RESOLVED (no verified_id and no person_id) — so no lease can be matched to anyone, and whether one exists is UNKNOWN.`,
        why: "multi-operator-coc/integrity-guard (loom#1871 HIGH-2) — lease ownership is matched on verified_id / person_id. With neither resolved, findCoveringLease skips EVERY record and returns null, which is indistinguishable at that layer from a genuinely lease-less log. Reporting it as 'no covering codify-lease record found' is a POSITIVE claim on evidence that supports only 'cannot tell who is asking' (rules/instrument-discipline.md MUST-1), and its remediation — /codify Step 0 — SIGNS the lease with the identity that just failed to resolve, so it cannot clear the state it is offered for. This branch names the actual cause and emits a remediation that can. It refuses rather than reports because a fail-open here would make an unresolvable identity the cheapest disable of the whole fence; the refusal is recoverable because every remediation below is an ENVIRONMENT action, not a write this guard fences.",
        agent_must_report: [
          `Target path: ${wp.rel}`,
          `Branch: ${branch}`,
          "CAUSE: operator identity is UNRESOLVED. This is NOT 'you have no lease' — the lease check never ran, because there is no identity to match a lease to.",
          `Signing key consulted: ${keySource}${keyExists === false ? " (THAT PATH DOES NOT EXIST)" : ""}`,
          "Do NOT report this as a missing lease, and do NOT run /codify Step 0 first — acquiring a lease signs it with this same unresolved identity and will fail the same way.",
          "Remediation, in order — all of these are ENVIRONMENT changes, none is a write this guard fences:",
          "  1. Run /whoami to see how identity resolution is failing.",
          "  2. If COC_OPERATOR_KEY_PATH is set, confirm it points at an existing, readable signing key; if it is wrong, unset or correct it.",
          "  3. If the key is agent-held, confirm the signing agent is running and the key is loaded.",
          `  4. If this operator is genuinely not enrolled, run ${(identity && identity.blocked_into) || "/whoami --register"} — enrollment is PR-gated and does not need a lease.`,
          "  5. Only once /whoami reports a verified_id, run /codify Step 0 and retry the write.",
        ],
        agent_must_wait:
          "Do not retry the Edit/Write until /whoami reports a resolved verified_id. Retrying, or acquiring a lease first, will fail identically.",
        user_summary: `integrity-guard — operator identity UNRESOLVED for ${wp.rel}; lease ownership unmatchable (not a missing lease)`,
      });
      // emit() exits
    }

    // `branch` is deliberately NOT passed: the codify-branch SHAPE gate above
    // (isCodifyBranch) is a separate, retained fence; what is gone is comparing
    // the lease's RECORDED branch to it. See findCoveringLease's header.
    const coverage = findCoveringLease(
      accepted,
      wp.rel,
      selfVerifiedId,
      selfPersonId,
      undefined,
      { posBySig, lastUnreadablePos },
    );
    const lease = coverage.lease;
    if (!lease) {
      // WHICH determined-no this is. All three refuse identically — the
      // severity argument below is the same for each — but they are DIFFERENT
      // FACTS and the remediation differs, so the message must not flatten
      // them. "no covering record" tells an operator whose lease merely
      // EXPIRED to widen their scope_files, which is not the problem and will
      // not fix it. This guard has twice been corrected for asserting one
      // state on evidence that only supported another
      // (rules/instrument-discipline.md MUST-1); reporting a released or
      // expired lease as ABSENT would be the third instance.
      const stateLine =
        coverage.reason === "released"
          ? `A covering codify-lease record EXISTS but was RELEASED: ${coverage.detail}. A released lease is not a grant.`
          : coverage.reason === "expired"
            ? `A covering codify-lease record EXISTS but has EXPIRED: ${coverage.detail}. An expired lease is not a grant.`
            : coverage.reason === "indeterminate-age"
              ? `A covering codify-lease record EXISTS but its AGE cannot be determined: ${coverage.detail}. Fail-closed: a lease whose age is unknown is not a grant. NOTE this is NOT a claim that the lease is old — only that elapsed time cannot be read from it.`
              : coverage.reason === "revocation-indeterminate"
                ? `A covering codify-lease record EXISTS and is within its TTL, but whether it was RELEASED is UNKNOWN: ${coverage.detail}. Fail-closed: unverifiable revocation state is not a grant.`
                : coverage.reason === "scope-unreadable"
                  ? `A codify-lease record signed by you EXISTS, but whether its scope covers this path CANNOT BE EVALUATED: ${coverage.detail}. Fail-closed: an unreadable scope is not a grant.`
                  : coverage.reason === "unpairable"
                    ? `A covering codify-lease record EXISTS but its state is UNKNOWN: ${coverage.detail}. Fail-closed: an unverifiable lease is not a grant.`
                    : "No covering codify-lease record was found in the folded coordination log.";
      const headline =
        coverage.reason === "none"
          ? `Edit/Write on '${wp.rel}' from codify branch '${branch}', but no covering codify-lease record found in the folded coordination log.`
          : `Edit/Write on '${wp.rel}' from codify branch '${branch}', but the covering codify-lease is NO LONGER VALID (${coverage.reason}).`;
      // THE DETERMINED NO (loom#1855 review, F-C). The log was READ and folded
      // successfully; it simply holds no covering record. Severity was
      // halt-and-report until this review, on the reading that a
      // "registry-record" signal sits BELOW block under
      // hook-output-discipline.md MUST-2. That reading is withdrawn on two
      // grounds, and the severity was RAISED, never a test loosened to fit it:
      //
      //   PERMITTED. MUST-2's line is structural / behavioral / AST /
      //   process-state on one side and LEXICAL REGEX on the other — its own
      //   worked examples are `git status --porcelain` non-empty and a non-zero
      //   pre-commit exit, i.e. deterministic reads of repository state. This
      //   verdict is a fold over a signature-verified append-only log read from
      //   disk. It is not a regex over prose or a shell string, and no surface
      //   rewrite evades it, so MUST-2's false-positive concern does not reach
      //   it. MUST-2 permits block here.
      //
      //   REQUIRED. halt-and-report maps to {"continue":true} + exit 0
      //   (lib/instruct-and-wait.js), so on a PreToolUse MUTATION fence it is
      //   not a softer refusal but NO refusal — the Edit/Write RAN. That left
      //   this guard refusing HARDER where it could NOT tell (budget expiry,
      //   unreadable log, unidentifiable tree — all block) than where it COULD
      //   tell the answer was no: incoherent as a fence, and the same fail-OPEN
      //   loom#1849b's own denyIndeterminate rationale names. The identical
      //   argument is already recorded twice above, at the unidentifiable-root
      //   and unreadable-log arms.
      //
      // It also closes the review's F-B. #1849b dropped the lease-to-branch
      // binding, which left the codify-branch SHAPE gate as the only hard gate
      // on this write path — a second lane on its own codify branch, under a
      // lease scoped elsewhere, was silently authorized. This restores a hard
      // gate at exactly that point, on #1849b's own thesis that authorization
      // is by lease COVERAGE.
      //
      // Pinned bipolar by F2 in
      // tests/integration/multi-operator/lease-binding-drop-1849b.test.js.
      clearTimeout(fallback);
      emit({
        hookEvent,
        severity: "block",
        what_happened: headline,
        why: "multi-operator-coc/integrity-guard — the codify-branch name is necessary but not sufficient. The signed `codify-lease` record (M7 E writes it via /codify Step 0) cryptographically binds the scope_files list to a verified operator identity (architecture v11 §6.4 + §7.1). Without it, the branch could be any ad-hoc codify/* rename. This is a DETERMINED no — the log was read and folded, and holds no covering record — so it refuses harder than the indeterminate arms above, not softer: severity is block. The signal is a fold over a signature-verified append-only log read from disk, which is the process-state class hook-output-discipline.md MUST-2 accepts (its own examples are `git status --porcelain` and a non-zero pre-commit exit), not a lexical match. block is REQUIRED rather than merely permitted because halt-and-report maps to continue:true (lib/instruct-and-wait.js): on a mutation fence that is not a softer refusal but no refusal, and the Edit/Write lands unauthorized. The full withdrawal of the prior halt-and-report reading is recorded at this branch in the source.",
        agent_must_report: [
          `Target path: ${wp.rel}`,
          `Branch: ${branch}`,
          stateLine,
          coverage.reason === "none"
            ? "Run /codify Step 0 (acquireCodifyLease) to append the signed lease record. The lease scope_files MUST include this target path."
            : "Run /codify Step 0 (acquireCodifyLease) to acquire a FRESH lease covering this path. Do NOT widen scope_files — the scope already covered this path; it is the lease's STATE that no longer grants.",
          "If the lease was JUST written and the log is stale, run a log fetch and retry.",
        ],
        agent_must_wait:
          "Do not retry the Edit/Write until a LIVE covering codify-lease record (un-released, within the lease TTL) lands in the folded log.",
        user_summary:
          coverage.reason === "none"
            ? `integrity-guard — codify-lease unverifiable for ${wp.rel}`
            : `integrity-guard — codify-lease ${coverage.reason.toUpperCase()} for ${wp.rel}; a lease that is no longer valid is not a grant`,
      });
      // emit() exits
    }

    // Both branch + lease pass → passthrough.
    passthrough();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    clearTimeout(fallback);
    // loom#1849b — the SAME verdict as the budget expiry, reached a different
    // way: inside the authorization phase the guard knows the call mutates an
    // integrity-critical path and has NOT established a covering lease. Emitting
    // {"continue":true} here is the identical fail-OPEN the budget carried, and
    // leaving it would have been a symptom patch on the timer alone. Outside the
    // phase this stays the Rule-7 structural-NULL fallback, byte-for-byte.
    //
    // Reachability, stated rather than assumed: every determinable failure in
    // this phase is ALREADY routed to an explicit `block` branch above (the fold
    // read, the tree resolution, the main-checkout resolution). This arm is
    // REACHABLE, and the prior claim here that "findCoveringLease is pure, so
    // this arm is near-unreachable" is FALSE as of the 2026-08-21 expiry fix:
    // that function now `require()`s ./lib/codify-lease.js lazily and THROWS
    // explicitly when LEASE_TTL_MS is missing or non-finite. A module-resolution
    // failure or a bad export lands exactly here. The routing is unchanged and
    // still correct — inside the authorization phase this denies — but the
    // reachability argument had to be corrected rather than left for a future
    // reader to rely on.
    if (authPhase) {
      try {
        process.stderr.write(
          `[BLOCK] integrity-guard internal error inside the authorization phase: ${msg}\n`,
        );
      } catch {
        // best-effort; denyIndeterminate carries the full body
      }
      denyIndeterminate("the guard errored before reaching a verdict", msg);
    }
    // Defense-in-depth: structural-NULL fallback.
    try {
      process.stderr.write(
        `[ADVISORY] integrity-guard internal error: ${msg}\n`,
      );
    } catch {
      // best-effort
    }
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {
      // best-effort
    }
    process.exit(0);
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
