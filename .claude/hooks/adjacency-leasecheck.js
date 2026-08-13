#!/usr/bin/env node
/**
 * adjacency-leasecheck.js — §4.3 pre-tool-use hook for Edit|Write.
 *
 * The first user-visible behavior in F14: every Edit/Write in a
 * multi-operator session now surfaces sibling activity per §4.1's
 * SAME / ADJACENT / INDEPENDENT relation.
 *
 * Per architecture v11 §4.3 hook-table row, with the §4.2 severity as
 * SHIPPED (block → halt-and-report, loom#1323):
 *
 *   Event:    pre-tool-use (Edit | Write)
 *   Severity: halt-and-report (SAME)
 *             halt-and-report (§4.2 filesystem exception — `git status
 *                    --porcelain` IS a valid structural primitive, so
 *                    hook-output-discipline.md MUST-2 WOULD PERMIT block
 *                    here; the downgrade is proportionality, NOT a MUST-2
 *                    violation fix. Sibling worktrees have physically
 *                    separate working trees: this write cannot clobber the
 *                    sibling's bytes on disk, so the only real collision
 *                    is a 3-way merge conflict at merge time — which git
 *                    surfaces loudly and NON-destructively. block stays
 *                    reserved for IRRECOVERABLE outcomes.)
 *             advisory (ADJACENT)
 *             silent + auto-claim (INDEPENDENT)
 *
 *   NO branch of this hook carries severity: block.
 *
 *   Budget:   ≤5s; setTimeout fallback per cc-artifacts.md Rule 7.
 *
 * Flow:
 *   1. Resolve operator identity via operator-id.js (Tier 1: explicit key
 *      path injection from env, Tier 2: git-config user.signingkey,
 *      Tier 3: nothing → L2_SUPERVISED + passthrough).
 *   2. Read the coordination log via filesystem Transport (A2b).
 *   3. Fold the log via A2a's foldLog to derive accepted records.
 *   4. Project accepted records → active sibling claims (rule-7 +
 *      verified_id != self).
 *   5. Evaluate §4.1 relation against the Edit/Write target path.
 *   6. Emit per the severity table above via instruct-and-wait.js::emit().
 *
 * The §4.2 filesystem exception: when a sibling worktree's `git status
 * --porcelain` shows the EXACT target path as uncommitted-modified, the
 * structural signal IS deterministic (process-local primitive), so
 * hook-output-discipline.md MUST-2 would permit severity: block — the
 * hook nonetheless returns halt-and-report on the proportionality grounds
 * in the severity table above (loom#1323). Surrogate for tests: the
 * COC_PORCELAIN_OVERRIDE env var injects a newline-separated list of
 * paths the harness wants the hook to treat as sibling-uncommitted; in
 * production this is replaced by an actual `git -C <sibling-worktree>
 * status --porcelain` enumeration (M3 territory — the worktree-list
 * enumeration is wired by B3a's signing-mutation-guard sibling).
 *
 * F2-2 residual surfacing: the hook calls adjacency.sameReason against
 * the candidate path's CURRENT cohort vs each granted claim's PINNED
 * cohort_commits snapshot. The hook does NOT re-walk granted claims when
 * the cohort window slides — adjacency.js exposes no API for that, per
 * R5-A-08 (§4.5 surfaced-not-eliminated residual).
 *
 * INDEPENDENT auto-claim: a signed `claim` record is appended to the
 * coordination log via Transport.appendRecord. Per the architecture
 * inventory the user-facing `/claim` command (M3 B3b) writes the same
 * record shape via `coc-append.js`; this hook's auto-claim is the
 * implicit-coordination path for Edit/Write that doesn't explicitly
 * invoke `/claim`.
 */

"use strict";

const TIMEOUT_MS = 5000;

// setTimeout fallback per cc-artifacts.md Rule 7. Hook-internal hang
// MUST NOT block the agent forever. {continue: true} surfaces no halt.
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
const { foldLog, isSessionLive, isClaimActive } = require(
  path.join(__dirname, "lib", "coordination-log.js"),
);
const { createFilesystemTransport } = require(
  path.join(__dirname, "lib", "transport-filesystem.js"),
);
const { canonicalSerialize, sign } = require(
  path.join(__dirname, "lib", "coc-sign.js"),
);
const adjacency = require(path.join(__dirname, "lib", "adjacency.js"));
const siblingPorcelain = require(
  path.join(__dirname, "lib", "sibling-porcelain.js"),
);
const { isMutationTool } = require(
  path.join(__dirname, "lib", "tool-classes.js"),
);
const { isCoordinationEnabled } = require(
  path.join(__dirname, "lib", "coordination-mode.js"),
);
const { requireMainCheckout } = require(
  path.join(__dirname, "lib", "state-resolver.js"),
);

function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

/**
 * Resolve the repo directory the hook operates against.
 *
 * Order:
 *   1. COC_OPERATOR_REPO_DIR env var (test injection).
 *   2. Payload's `cwd` field if it points into a real directory.
 *   3. process.cwd() as the last resort.
 */
function resolveRepoDir(payload) {
  const envDir = process.env.COC_OPERATOR_REPO_DIR;
  if (envDir && fs.existsSync(envDir)) return envDir;
  if (payload && typeof payload.cwd === "string" && payload.cwd.length > 0) {
    return payload.cwd;
  }
  return process.cwd();
}

/**
 * Watched-tool predicate. Hook fires on any mutation tool per §4.3.
 *
 * F14 C2 iter-3 root-cause fix: route through isMutationTool() from
 * lib/tool-classes.js so MultiEdit + NotebookEdit are also covered.
 * Per autonomous-execution.md MUST Rule 4: per-site Edit||Write was
 * the bug-class iter-1, iter-2, iter-3 successively swept; the
 * helper is the structural close.
 *
 * Returns { watched: true, targetPath } | { watched: false }.
 */
function isWatchedTool(payload) {
  const tool = payload && payload.tool_name;
  if (!isMutationTool(tool)) return { watched: false };
  const input = (payload && payload.tool_input) || {};
  // NotebookEdit uses `notebook_path` instead of `file_path`; cover both.
  const filePath =
    input.file_path || input.filePath || input.notebook_path || "";
  if (typeof filePath === "string" && filePath.length > 0) {
    return { watched: true, targetPath: filePath };
  }
  return { watched: false };
}

/**
 * Normalize the candidate path to a repo-relative form. The relation
 * library operates on string-prefix comparisons; an absolute path
 * pointing into the repo MUST be converted to its repo-relative form
 * so it matches sibling claims' repo-relative `path`/`dir` fields.
 *
 * Paths that fall OUTSIDE the repo (an absolute path NOT under repoDir)
 * are returned as `null` — the hook treats them as "no claim possible"
 * and passes through.
 */
function repoRelative(targetPath, repoDir) {
  if (typeof targetPath !== "string" || targetPath.length === 0) return null;
  // Absolute path under the repo → relative to repo root.
  if (path.isAbsolute(targetPath)) {
    const rel = path.relative(repoDir, targetPath);
    // Outside the repo (starts with `..` after relative resolution).
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.replace(/\\/g, "/");
  }
  // Already relative.
  return targetPath.replace(/\\/g, "/");
}

/**
 * Read + parse roster. Returns null on absence / malformed JSON — the
 * relation logic still operates without a roster (sibling identities
 * surface as display_id/person_id from the records themselves, not from
 * the roster). The fold engine itself takes roster as a soft input.
 */
function loadRoster(rosterPath) {
  try {
    if (!fs.existsSync(rosterPath)) return null;
    const raw = fs.readFileSync(rosterPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Project an accepted log into the set of ACTIVE sibling claims.
 *
 * "Active" per §2.2 rule 7: claim is unexpired, session live,
 * unreleased, unreaped. "Sibling" per the hook's filter: verified_id
 * !== self.
 *
 * Returns array of active-claim objects shaped for adjacency.js.
 */
function projectActiveSiblingClaims(accepted, selfVerifiedId, nowMs) {
  if (!Array.isArray(accepted) || accepted.length === 0) return [];
  // First pass: index releases + reaps by claim_id so we can resolve
  // the "active" status without re-walking the log per claim.
  const released = new Set();
  const reaped = new Set();
  const lastHeartbeatByEmitter = new Map();
  for (const rec of accepted) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.type === "release" && rec.content && rec.content.claim_id) {
      released.add(rec.content.claim_id);
    } else if (rec.type === "reap" && rec.content && rec.content.claim_id) {
      reaped.add(rec.content.claim_id);
    } else if (rec.type === "heartbeat" && typeof rec.ts === "string") {
      const prev = lastHeartbeatByEmitter.get(rec.verified_id);
      if (!prev || Date.parse(rec.ts) > Date.parse(prev)) {
        lastHeartbeatByEmitter.set(rec.verified_id, rec.ts);
      }
    }
  }
  const out = [];
  for (const rec of accepted) {
    if (!rec || rec.type !== "claim") continue;
    if (rec.verified_id === selfVerifiedId) continue; // own-claim exclusion
    const content = rec.content || {};
    const claim_id = content.claim_id;
    if (!claim_id) continue;
    if (released.has(claim_id)) continue;
    if (reaped.has(claim_id)) continue;
    // Session-live: the engine's isSessionLive predicate consumes
    // {now, lastHeartbeatTs, sessionClosed}. We approximate sessionClosed
    // via the absence of any session-close record for this emitter; the
    // hook's deterministic check is heartbeat-TTL only (rule 7).
    const lastHb =
      lastHeartbeatByEmitter.get(rec.verified_id) ||
      content.last_heartbeat_ts ||
      rec.ts;
    if (lastHb) {
      const live = isSessionLive({
        now: nowMs,
        lastHeartbeatTs: lastHb,
        sessionClosed: false,
      });
      if (!live.live) continue;
    }
    // Claim active per rule 7: caller-supplied expires_at OR forever.
    if (content.expires_at) {
      const active = isClaimActive({
        now: nowMs,
        expiresAtTs: content.expires_at,
        released: false,
        reaped: false,
        sessionLive: true,
      });
      if (!active.active) continue;
    }
    out.push({
      claim_id,
      verified_id: rec.verified_id,
      person_id: rec.person_id || null,
      display_id: rec.display_id || null,
      path: content.path || null,
      glob: content.glob || null,
      dir: content.dir || null,
      workspace: content.workspace || null,
      phase: content.phase || null,
      cohort_commits: content.cohort_commits || null,
      granted_at_seq: typeof rec.seq === "number" ? rec.seq : 0,
    });
  }
  return out;
}

/**
 * §4.2 filesystem exception. Returns the matched-path-string when a
 * sibling worktree has the candidate target as uncommitted-modified, or
 * null otherwise.
 *
 * PRECEDENCE (B3a Step 6 cross-shard handoff):
 *   1. `COC_PORCELAIN_OVERRIDE` (test-surrogate) — newline-separated
 *      repo-relative paths. When set, the override IS authoritative;
 *      the production primitive does NOT run. This preserves B1's
 *      existing test suite (which sets COC_PORCELAIN_OVERRIDE in
 *      synthetic single-worktree test repos where the production
 *      primitive would return empty).
 *   2. Production primitive — `lib/sibling-porcelain.js::detectSiblingMutation`.
 *      Enumerates sibling worktrees via `git worktree list --porcelain`
 *      and reads each sibling's `git status --porcelain`. Process-local
 *      structural primitive per architecture v11 §4.2 + R4-S-02.
 */
function detectFilesystemExceptionMatch(candidateRelPath, repoDir) {
  // Test-surrogate precedence — when override is set, it IS authoritative.
  const override = process.env.COC_PORCELAIN_OVERRIDE;
  if (override !== undefined) {
    const lines = override
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const l of lines) {
      if (l === candidateRelPath) return l;
    }
    return null;
  }
  // Production primitive — sibling-porcelain.js (B3a Step 6 wiring).
  if (!repoDir) return null;
  // loom#1471 shard 5. Result-object API now. This surface is ADVISORY (it
  // answers "is a sibling already touching this path", feeding an adjacency
  // notice, not a fence), so an indeterminate answer keeps returning null —
  // but it says so on stderr rather than being indistinguishable from a clean
  // negative. Deliberately narrower than signing-mutation-guard, which
  // halt-and-reports: that surface gates a write, this one annotates one.
  const res = siblingPorcelain.detectSiblingMutation(repoDir, candidateRelPath);
  if (!res.ok) {
    try {
      process.stderr.write(
        `[ADVISORY] adjacency-leasecheck: sibling contention INDETERMINATE for ` +
          `${candidateRelPath} — ${res.reason}. Reported as no-adjacency; it is not a clean negative.\n`,
      );
    } catch {
      // best-effort
    }
    return null;
  }
  if (res.matches.length > 0) {
    return res.matches[0].target;
  }
  return null;
}

/**
 * Auto-claim: append a signed `claim` record for the operator's own
 * candidate path, via the filesystem Transport. Returns void; failures
 * are best-effort (the hook MUST NOT block on append-failure — the
 * coordination contract per the architecture is advisory at this layer).
 */
async function autoClaim(transport, identity, candidateRelPath, nowMs, opts) {
  // Build the canonical claim record.
  const core = {
    type: "claim",
    verified_id: identity.verified_id,
    person_id: identity.person_id || null,
    display_id: identity.display_id || null,
    seq: opts.seq != null ? opts.seq : 0,
    prev_hash: opts.prev_hash || null,
    ts: new Date(nowMs).toISOString(),
    content: {
      claim_id: `auto-${identity.verified_id || "anon"}-${nowMs}`,
      path: candidateRelPath,
      auto: true,
    },
  };
  if (!opts.keyPath) return; // can't sign without a key — skip silently
  const bytes = canonicalSerialize(core);
  const r = sign(bytes, {
    keyType: opts.keyType || "ssh",
    keyPath: opts.keyPath,
  });
  if (!r.ok) return;
  const record = Object.assign({}, core, { sig: r.sig });
  try {
    await transport.appendRecord(record);
  } catch {
    // best-effort
  }
}

/**
 * Resolve a signing-key path from explicit env var injection. Tier 1
 * of operator-id.js's discovery; we forward it to resolveIdentity so
 * the hook's identity matches the auto-claim's signing key.
 */
function discoverKeyPath() {
  const explicit = process.env.COC_OPERATOR_KEY_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return { keyPath: explicit, keyType: "ssh" };
  }
  return { keyPath: null, keyType: null };
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

    const repoDir = resolveRepoDir(payload);

    // MO-OPT W1-e — opt-in gate (workspaces/multi-operator-optional, journal/0330).
    // Claims, adjacency, and the §4.2 cross-worktree-contention halt are all
    // coordination features. A solo / fresh repo (coordination OFF) MUST NOT
    // get the sibling-worktree halt (a solo dev may legitimately run multiple
    // worktrees of their own). Passthrough when OFF. When ENABLED, byte-unchanged
    // (this guard already fail-opens on empty-log / unresolvable identity; the
    // gate makes the solo no-op explicit + covers the §4.2 halt path too).
    //
    // MO-OPT holistic post-multi-wave redteam (Cluster A): the predicate's tier-2
    // local-override (.claude/learning/coordination-mode.json) is GITIGNORED →
    // ABSENT in a worktree. Reading it against the worktree cwd would split a
    // tier-2-enrolled repo OFF here while integrity-guard / journal-write-guard
    // read it ON from main — and the §4.2 cross-worktree-contention halt (this
    // guard's whole reason to exist in a parallel-worktree run) is exactly what
    // gets silenced. Resolve the MAIN checkout for the predicate ONLY (the same
    // main-checkout discipline as trust-posture.md MUST-1 / integrity-guard.js
    // :362); repoDir stays the worktree cwd for the claim + repoRelative below.
    // loom#1471 F7b — fail CLOSED when git cannot identify the main checkout.
    // The former `resolveMainCheckout(repoDir) || repoDir` could not fire (the
    // legacy accessor returns its argument, never falsy), so an unidentifiable
    // root reached the predicate against a directory with no coordination state
    // → false → `passthrough()`, silencing the §4.2 cross-worktree-contention
    // halt that is this guard's whole reason to exist in a parallel run.
    // `repoDir` deliberately STAYS the worktree cwd below (claim + repoRelative);
    // only the predicate reads main.
    const mainRes = requireMainCheckout(repoDir);
    if (!mainRes.ok) {
      clearTimeout(fallback);
      emit({
        hookEvent,
        severity: "halt-and-report",
        what_happened: `Adjacency lease-check could not run: the MAIN checkout could not be identified — ${mainRes.reason}`,
        why: "multi-operator-coc/adjacency-leasecheck — sibling claims live in the MAIN checkout's coordination log. Unidentified, the coordination-enabled predicate returns false and its branch is `passthrough()`, so cross-worktree contention goes unchecked exactly when the resolver is confused about which tree it is in. Refusing is the fail-closed direction (`rules/security.md` § Enforcement-Surface Parity).",
        agent_must_report: [
          `Worktree cwd: ${repoDir}`,
          `Resolver reason: ${mainRes.reason}`,
          "Sibling-claim contention was NOT checked — its result is UNKNOWN, not clean.",
          "A differently-owned checkout reports `detected dubious ownership`; take ownership, or set CLAUDE_TRUST_STATE_DIR.",
        ],
        agent_must_wait:
          "Do not retry until git can identify the main checkout, or the operator pins CLAUDE_TRUST_STATE_DIR.",
        // SAME CLAIM, SAME CORRECTION as `analyze-completeness-guard.js`, swept
        // in the same change (`security.md` § Enforcement-Surface Parity). These
        // two are the only TRUST_BEARING hooks whose indeterminate branch is
        // `halt-and-report` rather than `block` — i.e. the only two where
        // "refused rather than passed through" is FALSE, because
        // `instruct-and-wait.js` maps this severity to `{continue: true}` and the
        // tool RUNS. The other four making this claim emit `block` and it holds
        // for them, so they are deliberately left alone. This is the only line
        // the user actually sees.
        user_summary:
          "adjacency-leasecheck — main checkout unidentifiable; contention NOT checked, action proceeds with its result UNKNOWN",
      });
      // emit() exits
    }
    if (!isCoordinationEnabled(mainRes.repoDir)) {
      passthrough();
    }

    const candidateRelPath = repoRelative(watch.targetPath, repoDir);
    if (candidateRelPath === null) {
      // Target is outside the repo — no claim possible, no sibling
      // conflict. Silent passthrough.
      passthrough();
    }

    // Resolve identity. The hook MUST know "self" so it can exclude its
    // own active claims AND sign the auto-claim. If identity is
    // unresolvable, we passthrough silently — the agent will hit the
    // genesis-anchor-guard / posture-gate for any further structural
    // assertions; adjacency is best-effort coordination, not a gate.
    const { keyPath, keyType } = discoverKeyPath();
    const identity = resolveIdentity(repoDir, {
      signingKeyPath: keyPath,
      keyType,
      gitConfigSigningKey: keyPath ? undefined : null,
    });
    if (!identity || !identity.verified_id) {
      // No identity → no auto-claim, but we still surface sibling claims
      // if any. Continue with selfVerifiedId=null (matches no records).
    }
    const selfVerifiedId = (identity && identity.verified_id) || null;

    // Read + fold the coordination log via filesystem Transport.
    const transport = createFilesystemTransport(repoDir);
    let records;
    let readIndeterminate = null;
    try {
      records = await transport.readAllRecords();
    } catch (err) {
      // INDETERMINATE — NOT an empty log. "Treat as empty log; passthrough" was
      // verbatim the disposition the transport contract forbids: the read failed,
      // so sibling claims are UNKNOWN, and a silent passthrough reports that as
      // "no adjacent claims" (rules/instrument-discipline.md MUST-1).
      readIndeterminate = err && err.message ? err.message : String(err);
    }
    const rosterPath = path.join(repoDir, ".claude", "operators.roster.json");
    const roster = loadRoster(rosterPath);
    let foldResult;
    if (!readIndeterminate) {
      try {
        foldResult = foldLog(records, roster, {});
      } catch (err) {
        // Same class as the transport failure above: a fold that threw did not
        // compute an empty claim set, so passthrough would report UNKNOWN as
        // "no adjacent claims". fold-rule-10.js:271 calls peerHighWaterFor()
        // unwrapped, so a git-ref-transport deployment can surface the shard-7
        // indeterminate throw right here.
        readIndeterminate = err && err.message ? err.message : String(err);
      }
    }

    if (readIndeterminate) {
      clearTimeout(fallback);
      emit({
        hookEvent,
        severity: "halt-and-report",
        what_happened: `Adjacency lease check could not run: the coordination log could not be read or folded — ${readIndeterminate}`,
        why: "multi-operator-coc/adjacency-leasecheck — sibling claim adjacency is projected from the folded coordination log, and that read/fold FAILED. Adjacent sibling claims are therefore UNKNOWN, not absent, and the previous `passthrough()` reported the two identically (rules/instrument-discipline.md MUST-1). Severity is halt-and-report, NOT block, matching this guard's own indeterminate-ROOT branch above and on the same proportionality grounds: this guard gates an ADVISORY on claim adjacency rather than fencing a mutation, so its off-branch does not let an unauthorized write land — the two mutation fences on this same predicate (integrity-guard, journal-write-guard) do, which is why they take block and this one does not.",
        agent_must_report: [
          `Why the check could not answer: ${readIndeterminate}`,
          "State explicitly that adjacent sibling claims are UNKNOWN for this work — NOT that there are none.",
          "A sibling operator may hold an active claim on an adjacent path; the log that would show it could not be read.",
          "Remediation: make .claude/learning/coordination-log.jsonl readable (check permissions, and that it is a regular file), then retry.",
        ],
        agent_must_wait:
          "Report that adjacency is UNKNOWN and wait for the operator's direction before proceeding on adjacent paths.",
        user_summary:
          "adjacency-leasecheck — coordination log UNREADABLE; sibling adjacency INDETERMINATE (not a clean result)",
      });
      // emit() exits
    }
    const accepted =
      foldResult && Array.isArray(foldResult.accepted)
        ? foldResult.accepted
        : [];
    const nowMs = Date.now();
    const activeSiblingClaims = projectActiveSiblingClaims(
      accepted,
      selfVerifiedId,
      nowMs,
    );

    // §4.2 filesystem exception — check FIRST (structural primitive
    // dominates registry-level SAME per architecture).
    const porcelainMatch = detectFilesystemExceptionMatch(
      candidateRelPath,
      repoDir,
    );
    if (porcelainMatch) {
      // Find the matching sibling claim (if any) to enrich the report.
      const same = adjacency.sameReason(
        candidateRelPath,
        activeSiblingClaims,
        {},
      );
      const matchedClaim = same.matched ? same : null;
      clearTimeout(fallback);
      emit({
        hookEvent,
        severity: "halt-and-report",
        what_happened: `Sibling worktree has '${candidateRelPath}' uncommitted-modified (porcelain match).`,
        why: "multi-operator-coc/adjacency-leasecheck §4.2 filesystem exception — structural primitive: `git status --porcelain` reports the exact target file modified in a sibling worktree. That signal IS structural + process-local, so hook-output-discipline.md MUST-2 would PERMIT severity: block; the branch emits halt-and-report on proportionality grounds (loom#1323) — sibling worktrees have physically separate working trees, so this write cannot clobber the sibling's bytes on disk, and the only real collision is a 3-way merge conflict at merge time, which git surfaces loudly and non-destructively. Surface the contention; the operator adjudicates.",
        agent_must_report: [
          `Target path: ${candidateRelPath}`,
          matchedClaim && matchedClaim.claim_id
            ? `Conflicting active claim: ${matchedClaim.claim_id} (operator ${matchedClaim.sibling_display_id || matchedClaim.sibling_person_id || "unknown"})`
            : "No active sibling claim recorded; the porcelain signal alone established cross-worktree contention.",
          "The sibling's on-disk work is NOT at risk (separate working trees); the exposure is a 3-way merge conflict when both branches land.",
          "Adjudication options: reconcile at merge, coordinate with the sibling operator (they commit/stash/land first), or re-scope this edit.",
        ],
        agent_must_wait:
          "Report the contention and your recommended option, then wait for the operator's direction before further edits to this path.",
        user_summary: `adjacency-leasecheck — cross-worktree contention on ${candidateRelPath} (sibling worktree holds it uncommitted-modified)`,
      });
      // emit() exits
    }

    // §4.1 relation evaluation.
    const sameVerdict = adjacency.sameReason(
      candidateRelPath,
      activeSiblingClaims,
      {},
    );
    if (sameVerdict.matched) {
      clearTimeout(fallback);
      emit({
        hookEvent,
        severity: "halt-and-report",
        what_happened: `SAME-class conflict on '${candidateRelPath}' against active sibling claim ${sameVerdict.claim_id} (predicate: ${sameVerdict.predicate}, sibling: ${sameVerdict.sibling_display_id || sameVerdict.sibling_person_id || "unknown"}).`,
        why: "multi-operator-coc/adjacency-leasecheck §4.1 SAME predicate — registry-record-class signal (not structural per hook-output-discipline.md MUST-2; severity: halt-and-report). Architecture v11 §4.3 specifies SAME → halt-and-report; the registry record IS the lease database, not a structural primitive, so block severity is unavailable here on MUST-2 grounds. The structurally-grounded cross-worktree-contention branch COULD take block under MUST-2 but emits halt-and-report on proportionality grounds (loom#1323) — no branch of this hook carries block.",
        agent_must_report: [
          `Target path: ${candidateRelPath}`,
          `Conflicting active claim: ${sameVerdict.claim_id}`,
          `Sibling operator: ${sameVerdict.sibling_display_id || sameVerdict.sibling_person_id || "unknown"}`,
          `Predicate: ${sameVerdict.predicate}`,
          "Coordinate with the sibling operator before retrying (handoff via /release-claim or /claim --override after lease-override gate).",
        ],
        agent_must_wait:
          "Do not retry the Edit/Write without explicit user direction (the user adjudicates SAME-class collisions).",
        user_summary: `adjacency-leasecheck — SAME-class conflict on ${candidateRelPath} (sibling ${sameVerdict.sibling_display_id || "unknown"})`,
      });
      // emit() exits
    }

    const adjVerdict = adjacency.adjacentReason(
      candidateRelPath,
      activeSiblingClaims,
      {},
    );
    if (adjVerdict.matched) {
      clearTimeout(fallback);
      emit({
        hookEvent,
        severity: "advisory",
        what_happened: `ADJACENT-class signal on '${candidateRelPath}' near active sibling claim ${adjVerdict.claim_id} (predicate: ${adjVerdict.predicate}, sibling: ${adjVerdict.sibling_display_id || adjVerdict.sibling_person_id || "unknown"}).`,
        why: "multi-operator-coc/adjacency-leasecheck §4.1 ADJACENT predicate — advisory per architecture §4.2 (leases-advisory). Surface the proximity; agent MAY proceed.",
        agent_must_report: [
          `Target path: ${candidateRelPath}`,
          `Nearby active claim: ${adjVerdict.claim_id}`,
          `Sibling operator: ${adjVerdict.sibling_display_id || adjVerdict.sibling_person_id || "unknown"}`,
          `Predicate: ${adjVerdict.predicate}`,
          "Proceed with awareness; no halt required.",
        ],
        agent_must_wait:
          "No wait required. Acknowledge the adjacency in the next message and continue.",
        user_summary: `adjacency-leasecheck — ADJACENT to ${adjVerdict.claim_id} (sibling ${adjVerdict.sibling_display_id || "unknown"})`,
      });
      // emit() exits
    }

    // INDEPENDENT — silent passthrough + auto-claim.
    // Auto-claim is best-effort: it advertises the operator's intent to
    // siblings on next fold. The hook MUST NOT halt on append failure.
    if (selfVerifiedId && keyPath) {
      const nextSeq = (() => {
        let max = -1;
        for (const r of accepted) {
          if (
            r &&
            r.verified_id === selfVerifiedId &&
            typeof r.seq === "number"
          ) {
            if (r.seq > max) max = r.seq;
          }
        }
        return max + 1;
      })();
      await autoClaim(transport, identity, candidateRelPath, nowMs, {
        keyPath,
        keyType: keyType || "ssh",
        seq: nextSeq,
      });
    }
    passthrough();
  } catch (err) {
    // Defense-in-depth. Any unexpected exception MUST NOT block the
    // agent — the timeout-fallback semantics apply: pass through with
    // {continue: true}. Per cc-artifacts.md Rule 7 + Rule 9 (structural-
    // NULL is the fallback for malformed input / unrecoverable internal
    // error).
    try {
      process.stderr.write(
        `[ADVISORY] adjacency-leasecheck internal error: ${err && err.message ? err.message : String(err)}\n`,
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
