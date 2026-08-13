#!/usr/bin/env node
/**
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
 *             halt-and-report  (branch matches but no covering
 *                               codify-lease record in the fold —
 *                               registry-class signal, not structural)
 *             silent           (branch + lease both pass; OR unwatched
 *                               path; OR outside repo)
 *   Budget:   ≤5s; setTimeout fallback emits {continue: true} per
 *             cc-artifacts.md Rule 7.
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
 */

"use strict";

const TIMEOUT_MS = 5000;

// setTimeout fallback per cc-artifacts.md Rule 7.
const fallback = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
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
const { isCoordinationEnabled } = require(
  path.join(__dirname, "lib", "coordination-mode.js"),
);
const { matchFirstCandidate, matchIntegrityWatchedRel } = require(
  path.join(__dirname, "lib", "guard-path-scope.js"),
);
const { resolveGitBinary, gitEnv } = require(
  path.join(__dirname, "lib", "git-subprocess-env.js"),
);

function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

function resolveRepoDir(payload) {
  const envDir = process.env.COC_OPERATOR_REPO_DIR;
  if (envDir && fs.existsSync(envDir)) return envDir;
  if (payload && typeof payload.cwd === "string" && payload.cwd.length > 0) {
    return payload.cwd;
  }
  return process.cwd();
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
    matchFirstCandidate(absPath, repoDir, matchIntegrityWatchedRel, undefined, out) || {
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
 * Codify-branch predicate. Returns { match: true, date } when the
 * branch is `codify/<display_id>-<YYYY-MM-DD>` for THIS display_id;
 * { match: false } otherwise. The branch convention is documented in
 * architecture v11 §7.1.
 *
 * If display_id is null/unknown (un-rostered operator), we accept ANY
 * `codify/*-<date>` branch shape as structurally codify-flavored; the
 * lease-record check below STILL fires (so unauthorized codify-branch
 * names get caught at the lease layer).
 */
function isCodifyBranch(branch, displayId) {
  if (!branch || typeof branch !== "string") return { match: false };
  if (!branch.startsWith("codify/")) return { match: false };
  const suffix = branch.slice("codify/".length);
  // Expected shape: <display_id>-YYYY-MM-DD
  const m = suffix.match(/^(.+)-(\d{4}-\d{2}-\d{2})$/);
  if (!m) return { match: false };
  const [, branchDisplayId, date] = m;
  if (displayId && branchDisplayId !== displayId) {
    // Branch is a codify branch but belongs to a DIFFERENT operator —
    // that's also a block-class condition (cross-operator codify-branch
    // is exactly what the lease guards against).
    return { match: false, foreign: true, foreignDisplayId: branchDisplayId };
  }
  return { match: true, date, displayId: branchDisplayId };
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
 * Find a covering codify-lease record in the folded log. "Covering"
 * means: matching `branch`, the lease's `scope_files` includes the
 * candidate path (or matches as a prefix/glob — the registry record
 * decides; this guard just checks for any record naming the candidate
 * path or a prefix of it).
 *
 * Record shape (the contract M7 E's writer ships; B3a guard READS):
 *   {
 *     type: "codify-lease",
 *     verified_id, person_id, display_id, seq, prev_hash, ts, sig,
 *     content: {
 *       branch: "codify/<display_id>-<YYYY-MM-DD>",
 *       date:   "YYYY-MM-DD",
 *       scope_files: ["path/a.md", "path/b.md"]
 *     }
 *   }
 */
function findCoveringLease(
  accepted,
  branch,
  candidateRel,
  selfVerifiedId,
  selfPersonId,
) {
  if (!Array.isArray(accepted)) return null;
  for (const rec of accepted) {
    if (!rec || rec.type !== "codify-lease") continue;
    const c = rec.content || {};
    if (c.branch !== branch) continue;
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
    const scope = Array.isArray(c.scope_files) ? c.scope_files : [];
    for (const s of scope) {
      // Exact match OR scope is a prefix dir.
      if (s === candidateRel) return rec;
      if (s.endsWith("/") && candidateRel.startsWith(s)) return rec;
      if (!s.includes(".") && candidateRel.startsWith(s + "/")) return rec;
    }
  }
  return null;
}

// ---- main -------------------------------------------------------------------

(async function main() {
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
    const repoDir = mainRes.repoDir;
    const scope = {};
    const wp = isWatchedPath(watch.targetPath, repoDir, scope);
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
    // isCoordinationEnabled is synchronous and never throws into the guard.
    if (!isCoordinationEnabled(repoDir)) {
      passthrough();
    }

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
    const branchVerdict = isCodifyBranch(branch, displayId);

    if (!branchVerdict.match) {
      // BLOCK — structural signal (process-local git invocation).
      clearTimeout(fallback);
      const foreignNote = branchVerdict.foreign
        ? ` (foreign codify-branch for operator ${branchVerdict.foreignDisplayId})`
        : "";
      emit({
        hookEvent,
        severity: "block",
        what_happened: `Edit/Write on integrity-critical path '${wp.rel}' from branch '${branch || "<unknown>"}'${foreignNote}.`,
        why: "multi-operator-coc/integrity-guard §2.3 — integrity-critical artifacts (operators.roster.json, coordination-log.jsonl, posture.json, journal/, team-memory/) MUST be edited only through the /codify flow per architecture v11 §6.4 + §7.1 (Step 0 acquireCodifyLease → codify/<display_id>-<date> branch → PR → admin-merge). Branch resolution via `git rev-parse --abbrev-ref HEAD` IS the structural primitive (hook-output-discipline.md MUST-2): process-local deterministic, not lexical match.",
        agent_must_report: [
          `Target path: ${wp.rel}`,
          `Active branch: ${branch || "<unresolved>"}`,
          `Expected branch shape: codify/${displayId || "<your-display_id>"}-YYYY-MM-DD`,
          "Run /codify to acquire a lease + open a codify branch before retrying the edit.",
          branchVerdict.foreign
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
    try {
      const records = await transport.readAllRecords();
      const roster = loadRoster(repoDir);
      // Sandboxed engine: register the codify-lease predicate. M7 E writes
      // the record; B3a reads it. Sandboxed (createEngine) so the
      // module-default registry is unmodified for parallel callers.
      const engine = createEngine();
      engine.registerFoldPredicate(
        "codify-lease",
        (record, ctx) => ({ accepted: true, foldState: ctx.foldState }),
        {
          checkpoint_exempt: true,
          authoritative_for_record: true,
          authoritative_for_aggregate: false,
        },
      );
      const fold = engine.foldLog(records, roster, {});
      accepted = fold && Array.isArray(fold.accepted) ? fold.accepted : [];
    } catch (err) {
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

    const lease = findCoveringLease(
      accepted,
      branch,
      wp.rel,
      selfVerifiedId,
      selfPersonId,
    );
    if (!lease) {
      clearTimeout(fallback);
      emit({
        hookEvent,
        severity: "halt-and-report",
        what_happened: `Edit/Write on '${wp.rel}' from codify branch '${branch}', but no covering codify-lease record found in the folded coordination log.`,
        why: "multi-operator-coc/integrity-guard — the codify-branch name is necessary but not sufficient. The signed `codify-lease` record (M7 E writes it via /codify Step 0) cryptographically binds the branch to a scope_files list and 2-of-N owner co-signers (architecture v11 §6.4 + §7.1). Without it, the branch could be any ad-hoc codify/* rename. Registry-record signal, not structural: hook-output-discipline.md MUST-2 — severity=halt-and-report.",
        agent_must_report: [
          `Target path: ${wp.rel}`,
          `Branch: ${branch}`,
          "No covering codify-lease record was found in the folded coordination log.",
          "Run /codify Step 0 (acquireCodifyLease) to append the signed lease record. The lease scope_files MUST include this target path.",
          "If the lease was JUST written and the log is stale, run a log fetch and retry.",
        ],
        agent_must_wait:
          "Do not retry the Edit/Write until the covering codify-lease record lands in the folded log.",
        user_summary: `integrity-guard — codify-lease unverifiable for ${wp.rel}`,
      });
      // emit() exits
    }

    // Both branch + lease pass → passthrough.
    passthrough();
  } catch (err) {
    // Defense-in-depth: structural-NULL fallback.
    try {
      process.stderr.write(
        `[ADVISORY] integrity-guard internal error: ${err && err.message ? err.message : String(err)}\n`,
      );
    } catch {
      // best-effort
    }
    try {
      clearTimeout(fallback);
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {
      // best-effort
    }
    process.exit(0);
  }
})();
