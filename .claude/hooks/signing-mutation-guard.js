#!/usr/bin/env node
/**
 * signing-mutation-guard.js — §2.3 + §4.3 pre-tool-use guard.
 *
 * @coc-codex-edit-gate — STATELESS trust gate (degraded-mode signing-key
 *   mutation discipline); the policy extractor fans its CC edit-matcher
 *   registration out to the Codex `apply_patch` lane (mcp-guard,
 *   FF-AC6-1). Its inputs are stateless: a signing key resolves via git
 *   config / explicit env (NOT the multi-operator roster), and the
 *   degraded-mode read-only block is the same behavior already shipped on
 *   the Codex shell lane (DF-AC6-2) — extending it to apply_patch makes
 *   the file-edit lane symmetric with the shell lane. The cc-only
 *   coordination guards deliberately omit this marker.
 *
 * Shard B3a (workspaces/multi-operator-coc/02-plans/01-architecture.md
 * §2.3 + §4.3 hook-table row + R4-S-02 + R5-S-03).
 *
 *   Event:    pre-tool-use
 *               - Bash `git commit` / `git push` (git-ref transport mode)
 *               - ANY mutation-capable tool (Edit | Write | Bash with
 *                 mutation keywords) for filesystem transport mode AND
 *                 the §4.2 sibling-worktree porcelain check
 *   Severity: block      (a) sibling worktree porcelain shows EXACT
 *                            target path uncommitted-modified — §4.2
 *                            filesystem exception, structural primitive
 *                            via lib/sibling-porcelain.js;
 *                        (b) degraded mode (no signing key) AND the
 *                            would-be operation is a tracked-path
 *                            mutation — working-tree-mutation predicate
 *                            per R4-S-02 + R5-S-03.
 *             silent     otherwise (signing key present + no sibling
 *                        contention + non-mutating tool).
 *   Budget:   ≤5s; setTimeout fallback emits {continue: true} on hang.
 *
 * Why degraded mode is a working-tree-mutation predicate, NOT an
 * Edit/Write tool-name allowlist (R5-S-03):
 *
 *   The naive design ("if no signing key, block Edit/Write/Bash")
 *   produces a false-positive flood — read operations are blocked
 *   too. The correct predicate is: "would this operation leave the
 *   working tree mutated on a tracked path?" That's a `git status
 *   --porcelain` before/after delta on tracked paths. The hook
 *   approximates the predicate at PreToolUse time via:
 *
 *     (i)   tool is Edit / Write on a tracked path; OR
 *     (ii)  tool is Bash with a mutation command (`git commit`,
 *           `git push`, `rm`, `mv`, etc.) targeting tracked paths.
 *
 *   Read / Glob / Grep / non-mutating Bash → passthrough even in
 *   degraded mode.
 *
 * Why sibling porcelain is the §4.2 production primitive:
 *
 *   B1's adjacency-leasecheck.js documented the cross-worktree
 *   contention exception with a test-surrogate (COC_PORCELAIN_OVERRIDE);
 *   the natural production primitive is sibling-worktree enumeration
 *   via `git worktree list --porcelain` + `git -C <sibling> status
 *   --porcelain`. That primitive lives in lib/sibling-porcelain.js
 *   (this shard) and IS consumed by BOTH this guard AND B1's hook
 *   (via Step 6 of this shard). The COC_PORCELAIN_OVERRIDE retains
 *   precedence in tests for both hooks.
 *
 * ENV OVERRIDES (test injection only):
 *   COC_OPERATOR_REPO_DIR     — repo root override.
 *   COC_OPERATOR_KEY_PATH     — signing key path; "" forces degraded
 *                                mode (testing).
 *   COC_PORCELAIN_OVERRIDE    — newline-separated list of paths to
 *                                treat as sibling-modified (matches
 *                                B1's surrogate; production precedence:
 *                                override-set → use override; else →
 *                                call sibling-porcelain.js).
 *   COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED — "1" to force degraded
 *                                                mode (used when the
 *                                                test wants to inject
 *                                                a missing key without
 *                                                also breaking identity
 *                                                resolution paths).
 */

"use strict";

const TIMEOUT_MS = 5000;

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
const siblingPorcelain = require(
  path.join(__dirname, "lib", "sibling-porcelain.js"),
);
const { isMutationTool } = require(
  path.join(__dirname, "lib", "tool-classes.js"),
);
const { isCoordinationEnabled } = require(
  path.join(__dirname, "lib", "coordination-mode.js"),
);
const { resolveMainCheckout } = require(
  path.join(__dirname, "lib", "state-resolver.js"),
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

/**
 * Classify the candidate tool call.
 *
 * Returns:
 *   { kind: "none"        }  — not a watched operation (Read / Glob /
 *                              Grep / read-only Bash)
 *   { kind: "edit-write", targetPath } — Edit | Write
 *   { kind: "git-mut",    command   } — Bash with `git commit` /
 *                                       `git push` / equivalent
 *   { kind: "fs-mut",     command   } — Bash with `rm` / `mv` / `cp` /
 *                                       `>` truncation / etc.
 */
function classifyOperation(payload) {
  const tool = payload && payload.tool_name;
  const input = (payload && payload.tool_input) || {};
  // F14 C2 iter-3 root-cause fix: route through isMutationTool() to
  // cover Edit/Write/MultiEdit/NotebookEdit uniformly. Per
  // autonomous-execution.md MUST Rule 4: the per-site Edit||Write
  // pattern is the bug class iter-1/2/3 swept; the helper is the
  // structural close.
  if (isMutationTool(tool)) {
    // NotebookEdit uses notebook_path; cover both.
    const fp = input.file_path || input.filePath || input.notebook_path || "";
    if (typeof fp === "string" && fp.length > 0) {
      return { kind: "edit-write", targetPath: fp };
    }
    return { kind: "none" };
  }
  if (tool === "Bash") {
    const cmd = (input.command || "").trim();
    if (!cmd) return { kind: "none" };
    // Git-ref transport mutations: commit, push. We accept any
    // sub-command that mutates the remote ref state.
    if (
      /\bgit\s+commit\b/.test(cmd) ||
      /\bgit\s+push\b/.test(cmd) ||
      /\bgit\s+tag\b/.test(cmd)
    ) {
      return { kind: "git-mut", command: cmd };
    }
    // Filesystem-transport mutations on tracked paths. We do a coarse
    // grep here — false positives are OK because the porcelain check
    // and degraded-mode check below add structural confirmation.
    if (
      /\brm\b\s+/.test(cmd) ||
      /\bmv\b\s+/.test(cmd) ||
      /\bcp\b\s+/.test(cmd) ||
      /^\s*>\s*\S+/.test(cmd) ||
      /\s+>\s*\S+/.test(cmd)
    ) {
      return { kind: "fs-mut", command: cmd };
    }
    return { kind: "none" };
  }
  return { kind: "none" };
}

/**
 * §4.2 sibling-worktree porcelain check.
 *
 * Test-surrogate precedence: when COC_PORCELAIN_OVERRIDE is set, parse
 * its newline-separated path list AND short-circuit to that match-set
 * (matches B1's adjacency-leasecheck.js convention; the override is
 * the test surrogate that REPLACES the production primitive in tests).
 *
 * Production primitive: lib/sibling-porcelain.js::detectSiblingMutation
 * enumerates sibling worktrees via `git worktree list --porcelain` and
 * checks each one's `git status --porcelain` for the exact target
 * path. Returns the array of matches (one per matching sibling).
 *
 * Returns:
 *   { matched: false } — no contention
 *   { matched: true, evidence: "<override|production>", siblings: [...] }
 */
function detectSiblingContention(repoDir, targetRelPath) {
  if (!targetRelPath) return { matched: false };
  // 1. Test-surrogate precedence.
  const override = process.env.COC_PORCELAIN_OVERRIDE;
  if (override !== undefined) {
    const lines = override
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const l of lines) {
      if (l === targetRelPath) {
        return {
          matched: true,
          evidence: "override",
          siblings: [{ worktree: "<test-surrogate>", target: l }],
        };
      }
    }
    // Override set but no match → no production fallback (mirrors
    // B1's contract — when the test injects an override, the override
    // is authoritative).
    return { matched: false };
  }
  // 2. Production primitive — sibling-porcelain.js.
  const matches = siblingPorcelain.detectSiblingMutation(
    repoDir,
    targetRelPath,
  );
  if (matches.length > 0) {
    return { matched: true, evidence: "production", siblings: matches };
  }
  return { matched: false };
}

/**
 * Repo-relative path with safety against outside-repo paths.
 * Returns null when targetPath resolves outside repoDir.
 */
function repoRelative(targetPath, repoDir) {
  if (!targetPath) return null;
  if (path.isAbsolute(targetPath)) {
    const rel = path.relative(repoDir, targetPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.replace(/\\/g, "/");
  }
  return targetPath.replace(/\\/g, "/");
}

/**
 * Working-tree-mutation predicate.
 *
 * The honest implementation per R5-S-03 is "would `git status
 * --porcelain` show a non-empty delta on a tracked path after this
 * operation?" We can't execute the would-be op, so we approximate at
 * PreToolUse time using the operation classification + a path-tracked
 * predicate (`git ls-files --error-unmatch <path>` exits 0 iff the
 * path is tracked).
 *
 * For Edit/Write on tracked paths → predicate fires.
 * For Bash git-mut / fs-mut → predicate fires (the command itself IS
 *   a mutation; the porcelain delta is implicit).
 *
 * Returns true when the operation would leave the working tree mutated.
 */
function wouldMutateWorkingTree(opKind, repoDir, candidateRel) {
  if (opKind === "git-mut" || opKind === "fs-mut") return true;
  if (opKind === "edit-write") {
    // If the path is tracked OR if it would be a new tracked path
    // (file under repoDir and not gitignored), the operation mutates.
    // We default to "yes, it mutates" for any path under repoDir —
    // false-positive in degraded mode is the safe direction (block
    // a tracked-or-would-be-tracked write); a clearly-untracked path
    // (under a gitignored subdir) is rare AND if it slipped through
    // the read-only contract is still the right disposition.
    if (!candidateRel) return false;
    // Try `git ls-files --error-unmatch`. Tracked → exit 0.
    const r = spawnSync("git", ["ls-files", "--error-unmatch", candidateRel], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 2000,
    });
    if (r.status === 0) return true;
    // Untracked. Check if it's gitignored — if so, no mutation
    // signal (untracked + gitignored = silent fail-open).
    const ig = spawnSync("git", ["check-ignore", "-q", candidateRel], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 2000,
    });
    // exit 0 = ignored; exit 1 = not ignored
    if (ig.status === 0) return false;
    // Not tracked AND not ignored — would-be new tracked file. That's
    // a mutation by the working-tree predicate.
    return true;
  }
  return false;
}

// ---- main -------------------------------------------------------------------

(async function main() {
  try {
    const payload = await readStdinBounded();
    const hookEvent = payload.hook_event_name || "PreToolUse";

    const op = classifyOperation(payload);
    if (op.kind === "none") {
      passthrough();
    }

    const repoDir = resolveRepoDir(payload);

    // MO-OPT W1-c — opt-in gate (workspaces/multi-operator-optional, journal/0330).
    // BOTH the §4.2 sibling-worktree porcelain check AND the degraded-mode
    // (no-signing-key) mutation block are coordination-substrate concerns. On a
    // solo / fresh repo (coordination OFF) there are no sibling worktrees, and
    // an absent signing key is "un-enrolled", NOT "degraded" — blocking every
    // tracked-path Edit/Write/commit because no GPG key is configured is THE
    // disruption (analysis gate #3). Passthrough. When ENABLED, byte-unchanged.
    //
    // MO-OPT holistic post-multi-wave redteam (Cluster A): the predicate's tier-2
    // local-override (.claude/learning/coordination-mode.json) is GITIGNORED →
    // ABSENT in a worktree. Reading it against the worktree cwd would split a
    // tier-2-enrolled repo OFF here while integrity-guard / journal-write-guard
    // read it ON from main (cross-shard inconsistency + S6 weakening on the
    // local-override path). Resolve the MAIN checkout for the predicate ONLY (the
    // same main-checkout discipline as trust-posture.md MUST-1 / integrity-guard
    // .js:362); repoDir stays the worktree cwd for §4.2 porcelain + repoRelative.
    if (!isCoordinationEnabled(resolveMainCheckout(repoDir) || repoDir)) {
      passthrough();
    }

    const candidateRel =
      op.kind === "edit-write" ? repoRelative(op.targetPath, repoDir) : null;

    // (1) §4.2 sibling-worktree porcelain check. Fires only when we
    // have a concrete target path (Edit/Write); git-mut/fs-mut don't
    // have a single target path to check (the commit/push touches
    // whatever is staged; the porcelain check IS the signal but
    // operates on the local working tree, not sibling worktrees, in
    // that case — out of scope for this branch).
    if (op.kind === "edit-write" && candidateRel) {
      const contention = detectSiblingContention(repoDir, candidateRel);
      if (contention.matched) {
        const sib = contention.siblings[0] || {};
        clearTimeout(fallback);
        emit({
          hookEvent,
          severity: "block",
          what_happened: `Sibling worktree porcelain shows '${candidateRel}' uncommitted-modified at ${sib.worktree || "<sibling>"}.`,
          why: `multi-operator-coc/signing-mutation-guard §4.2 filesystem exception — sibling-worktree contention detected via the porcelain primitive (lib/sibling-porcelain.js, evidence=${contention.evidence}). The porcelain primitive is process-local structural (\`git status --porcelain\` against an enumerated sibling worktree) — qualifies as the hook-output-discipline.md MUST-2 structural fact, so severity=block applies.`,
          agent_must_report: [
            `Target path: ${candidateRel}`,
            `Conflicting sibling worktree: ${sib.worktree || "<unknown>"}`,
            `Detection: ${contention.evidence === "override" ? "test-surrogate override (COC_PORCELAIN_OVERRIDE)" : "production primitive (git worktree list + sibling status --porcelain)"}`,
            "Coordinate with the sibling operator before retrying (commit/stash their WIP, or wait).",
          ],
          agent_must_wait:
            "Do not retry the Edit/Write until the sibling worktree's working tree no longer shows this file as modified.",
          user_summary: `signing-mutation-guard — BLOCK on cross-worktree contention for ${candidateRel}`,
        });
        // emit() exits
      }
    }

    // (2) Degraded-mode working-tree-mutation predicate.
    // Discover signing key. If absent → degraded mode. The predicate
    // then fires when the operation would mutate the working tree on
    // a tracked path.
    const explicitKey = process.env.COC_OPERATOR_KEY_PATH;
    const forceDegraded =
      process.env.COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED === "1";
    let signingKeyAvailable;
    if (forceDegraded) {
      signingKeyAvailable = false;
    } else if (explicitKey !== undefined) {
      // Explicit env path. Empty string IS degraded.
      signingKeyAvailable =
        typeof explicitKey === "string" &&
        explicitKey.length > 0 &&
        fs.existsSync(explicitKey);
    } else {
      // Fall back to resolveIdentity — verified_id present = signing
      // key chain works.
      const id = resolveIdentity(repoDir, {});
      signingKeyAvailable = !!(id && id.verified_id);
    }

    if (!signingKeyAvailable) {
      const mutates = wouldMutateWorkingTree(op.kind, repoDir, candidateRel);
      if (mutates) {
        clearTimeout(fallback);
        const opDesc =
          op.kind === "edit-write"
            ? `Edit/Write on ${candidateRel || "<unknown>"}`
            : op.kind === "git-mut"
              ? `git mutation command: ${op.command.slice(0, 80)}`
              : `fs mutation command: ${op.command.slice(0, 80)}`;
        emit({
          hookEvent,
          severity: "block",
          what_happened: `Degraded mode (no signing key configured) — would-be working-tree mutation: ${opDesc}.`,
          why: "multi-operator-coc/signing-mutation-guard — degraded mode is READ-ONLY per architecture v11 R4-S-02 + R5-S-03. The working-tree-mutation predicate (`git status --porcelain` before/after on tracked paths) IS the structural primitive — NOT an Edit/Write tool-name allowlist. Without a signing key, the operator cannot sign coordination records; any mutation that would leave a tracked-path delta is structurally inconsistent with the coordination contract. Block grounded in structural git-tracking signal (hook-output-discipline.md MUST-2).",
          agent_must_report: [
            `Operation: ${op.kind}`,
            candidateRel
              ? `Target: ${candidateRel} (tracked or would-be-tracked)`
              : "Target: derived from the mutation command above",
            "Signing key resolution: no key discoverable via operator-id.js (Tier-1 explicit / Tier-2 git config).",
            "Configure a signing key (run /whoami --register), then retry.",
            "If this session is genuinely read-only (audit/inspection only), use read tools (Read / Glob / Grep) instead of Edit/Write/git-mut.",
          ],
          agent_must_wait:
            "Do not retry the mutation until a signing key is configured AND /whoami --register has rostered it.",
          user_summary: `signing-mutation-guard — BLOCK degraded-mode mutation (${op.kind})`,
        });
        // emit() exits
      }
    }

    // No contention, no degraded-mode mutation → passthrough.
    passthrough();
  } catch (err) {
    try {
      process.stderr.write(
        `[ADVISORY] signing-mutation-guard internal error: ${err && err.message ? err.message : String(err)}\n`,
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
