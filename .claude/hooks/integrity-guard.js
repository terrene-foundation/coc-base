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
const { resolveMainCheckout } = require(
  path.join(__dirname, "lib", "state-resolver.js"),
);
const { isMutationTool, MUTATION_TOOLS } = require(
  path.join(__dirname, "lib", "tool-classes.js"),
);
const { isCoordinationEnabled } = require(
  path.join(__dirname, "lib", "coordination-mode.js"),
);

function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

function readStdinSync() {
  try {
    const data = fs.readFileSync(0, "utf8");
    if (!data || !data.trim()) return {};
    return JSON.parse(data);
  } catch {
    return {};
  }
}

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
  const filePath = input.file_path || input.filePath || "";
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
function isWatchedPath(absPath, repoDir) {
  let rel;
  if (path.isAbsolute(absPath)) {
    // M3 MED-5 / F-11 follow-up: macOS symlink-vs-realpath mismatch.
    // `git rev-parse --show-toplevel` returns the realpath (e.g.
    // `/private/var/...`) while the symlink path (e.g. `/var/...`) is
    // the caller's view. Normalize both sides via realpath when possible
    // so path.relative resolves correctly.
    let normalizedAbs = absPath;
    let normalizedRepo = repoDir;
    try {
      // Realpath the deepest existing ancestor to handle missing target files.
      let ancestor = absPath;
      while (ancestor && !fs.existsSync(ancestor)) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      if (ancestor) {
        const real = fs.realpathSync(ancestor);
        normalizedAbs = real + absPath.slice(ancestor.length);
      }
      if (fs.existsSync(repoDir)) {
        normalizedRepo = fs.realpathSync(repoDir);
      }
    } catch {
      // best-effort — fall back to raw paths
    }
    const r = path.relative(normalizedRepo, normalizedAbs);
    if (r.startsWith("..") || path.isAbsolute(r)) return { watched: false };
    rel = r.replace(/\\/g, "/");
  } else {
    rel = absPath.replace(/\\/g, "/");
  }
  // Direct hits on integrity-critical singletons.
  //
  // operators.roster.schema.json added per F67/security-reviewer HIGH-1
  // (journal 0162): the schema is the trust-root contract — it defines
  // what a valid roster looks like. A malicious operator who weakens
  // the schema (e.g. removes propertyNames-prototype-pollution rejection,
  // relaxes GPG fingerprint constraint, adds a human_admin synonym to
  // host_role enum) silently accepts forged rosters. Same structural
  // authority class as operators.roster.json — both gated equally.
  const DIRECT = new Set([
    ".claude/operators.roster.json",
    ".claude/operators.roster.schema.json",
    ".claude/learning/coordination-log.jsonl",
    ".claude/learning/posture.json",
    ".claude/learning/violations.jsonl",
    ".claude/learning/observations.jsonl",
    // MO-OPT W1 (journal/0330, G1 R1 security HIGH defense-in-depth): the
    // coordination-mode opt-in override. On an ENROLLED repo (coordination ON)
    // a write to it off-codify is BLOCKED here — mirroring posture.json — so it
    // cannot be silently flipped to disable the substrate. The predicate's
    // asymmetric precedence already REFUSES a local {enabled:false} on an
    // enrolled repo; this is the second layer (gate the write itself). On a solo
    // repo (OFF) the W1-b gate above passes through, so a consumer may still set
    // their local mode freely.
    ".claude/learning/coordination-mode.json",
  ]);
  if (DIRECT.has(rel)) return { watched: true, rel };
  // Subtree hits.
  if (rel.startsWith(".claude/team-memory/")) return { watched: true, rel };
  if (/^journal\//.test(rel)) return { watched: true, rel };
  if (/^workspaces\/[^/]+\/journal\//.test(rel)) {
    return { watched: true, rel };
  }
  return { watched: false };
}

/**
 * Resolve the active git branch via `git rev-parse --abbrev-ref HEAD`.
 * Returns the branch name string or null on any failure (no git, etc).
 *
 * Per hook-output-discipline.md MUST-2, this IS the structural primitive
 * the block branch is grounded in: process-local deterministic, no
 * network, no lexical match against tool_input.
 */
function resolveActiveBranch(repoDir) {
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 2000,
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
    const payload = readStdinSync();
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
    const repoDir = resolveMainCheckout(sessionCwd) || sessionCwd;
    const wp = isWatchedPath(watch.targetPath, repoDir);
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

    // (1) Structural branch predicate — `git rev-parse --abbrev-ref HEAD`.
    const branch = resolveActiveBranch(repoDir);
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
    } catch {
      // Structural-NULL: log unreadable. Treat lease as unverifiable
      // and halt-and-report (registry-class — honest disposition).
      accepted = [];
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
