#!/usr/bin/env node
/**
 * journal-write-guard.js — §4.3 pre-tool-use hook for `Write` on journal/.
 *
 * Shard B3a (workspaces/multi-operator-coc/02-plans/01-architecture.md
 * §2.3 + §4.3 hook-table row).
 *
 *   Event:    pre-tool-use (Write only)
 *   Watched:  journal/** AND workspaces/<name>/journal/**
 *   Severity: block            (target file ALREADY exists on disk —
 *                               fs.existsSync IS the process-local
 *                               structural primitive per
 *                               hook-output-discipline.md MUST-2)
 *             halt-and-report  (slot unreserved per fold OR reserved
 *                               by a different operator — registry
 *                               record, not structural)
 *             silent           (slot reserved by self / outside-repo /
 *                               unwatched tool)
 *   Budget:   ≤5s; setTimeout fallback emits {continue: true} on
 *             hook-internal hang (cc-artifacts.md Rule 7).
 *
 * Why immutable journal entries:
 *   Per rules/journal.md (the global journal-entry rule), journal
 *   entries are append-only — they record an event at a moment in time
 *   and overwriting destroys the audit trail. The on-disk file
 *   existence is the absolute structural signal (no rationalization
 *   possible: the file IS there or it ISN'T).
 *
 * Why slot reservation:
 *   Per architecture v11 §5.2 + §5.4, multi-operator concurrent
 *   journal-writes silently clobber on naive `0042-<title>.md` naming.
 *   reserveJournalSlot(dir) is M6 D's writer. B3a's guard READS
 *   existing reservations from the fold and refuses Writes that target
 *   an unreserved slot OR a slot reserved by a sibling operator.
 *
 * Cross-shard wiring:
 *   - Reads identity via lib/operator-id.js (A1).
 *   - Reads coordination log via createFilesystemTransport (A2b).
 *   - Folds the log via coordination-log.js::foldLog (A2a).
 *   - Scans `accepted` for `journal-slot-reservation` records (M6 D
 *     ships the writer; this guard only reads).
 *
 * ENV OVERRIDES (test injection only):
 *   COC_OPERATOR_REPO_DIR  — test injection of the repo root.
 *   COC_OPERATOR_KEY_PATH  — explicit signing-key path (Tier-1 of
 *                             operator-id.js's 3-tier discovery).
 */

"use strict";

const TIMEOUT_MS = 5000;

// setTimeout fallback per cc-artifacts.md Rule 7. Hook-internal hang MUST NOT
// block the agent forever. {continue: true} surfaces no halt — the timeout
// safety net is fail-OPEN by design; the fail-CLOSED behavior applies to the
// fs.existsSync block branch, NOT to internal hangs.
const fallback = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);

const fs = require("fs");
const path = require("path");

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
// F14 MED-4: route session cwd through resolveMainCheckout so worktree-
// isolated journal Writes see the same coordination log + reservation
// records as the main checkout. integrity-guard.js (the sibling
// PreToolUse hook for Edit/Write on integrity-critical paths) already
// uses this pattern at line 325; journal-write-guard.js drifted.
const { resolveMainCheckout } = require(
  path.join(__dirname, "lib", "state-resolver.js"),
);
// M9.1 R4 Sec-R4-S-06 — route tool-name check through the mutation-tool
// SSOT per `cc-artifacts.md` Rule 8. Pre-fix: hardcoded `tool !== "Write"`
// missed MultiEdit + NotebookEdit, which can also create new journal
// entries and bypass the slot-reservation guard. Post-fix: any mutation
// tool fires the guard.
const { isMutationTool } = require(
  path.join(__dirname, "lib", "tool-classes.js"),
);
// F101-3 (loom#411 governance-as-DNA): author-VERIFIABILITY layer. On a NEW
// journal entry Write, the `author:` frontmatter claim is checked against the
// LIVE per-session provenance ledger (the F101-2 capture stream). An unbacked /
// undetermined human|co-authored claim emits halt-and-report (REGISTRY-class
// per hook-output-discipline.md MUST-2 — NEVER block; an empty ledger is
// ambiguous degraded-capture, not an irrefutable structural false claim).
const { checkAuthorBacking } = require(
  path.join(__dirname, "lib", "provenance-author-backing.js"),
);
const { isCoordinationEnabled } = require(
  path.join(__dirname, "lib", "coordination-mode.js"),
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
 * Watched-tool predicate. The hook fires on Write only (Edit on an
 * existing journal entry is governed by integrity-guard.js's
 * codify-branch+lease check, NOT by journal-write-guard).
 *
 * Returns {watched, targetPath} | {watched: false}.
 */
function isWatchedTool(payload) {
  const tool = payload && payload.tool_name;
  // M9.1 R4 Sec-R4-S-06 — route through `isMutationTool()` SSOT so
  // MultiEdit + NotebookEdit creating new journal entries are also
  // gated. Pre-fix hardcoded "Write" missed those bypass surfaces.
  if (!isMutationTool(tool)) return { watched: false };
  const input = (payload && payload.tool_input) || {};
  const filePath =
    input.file_path || input.filePath || input.notebook_path || "";
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { watched: false };
  }
  return { watched: true, targetPath: filePath };
}

/**
 * Watched-path predicate. The hook fires on:
 *   journal/<slot>-<...>.md
 *   workspaces/<name>/journal/<slot>-<...>.md
 *   workspaces/<name>/journal/.pending/<slot>-<...>.md
 *
 * Returns {watched, slot, dir} | {watched: false}.
 *   slot — the leading NNNN prefix of the filename
 *   dir  — the journal directory relative to repo root ("journal" or
 *          "workspaces/<name>/journal" or with /.pending/ suffix)
 */
function isWatchedPath(absPath, repoDir) {
  // Normalize to repo-relative.
  let rel;
  if (path.isAbsolute(absPath)) {
    // F14 MED-4 follow-up: macOS realpath normalization. After
    // resolveMainCheckout redirects repoDir to the canonical main
    // checkout (which may be the realpath, e.g. /private/var/...),
    // and the caller's absPath was passed unresolved (e.g. /var/...),
    // path.relative produces a `..`-prefixed string and incorrectly
    // marks the path unwatched. Mirror integrity-guard.js's pattern
    // (lines 143-167): realpath both sides of the relative-path math.
    let normalizedAbs = absPath;
    let normalizedRepo = repoDir;
    try {
      let ancestor = absPath;
      while (ancestor && !fs.existsSync(ancestor)) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      if (ancestor && fs.existsSync(ancestor)) {
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
  // Match the journal-entry shape per rules/journal.md +
  // architecture v11 §5.2: <dir>/<NNNN>-<TYPE>-<slug>.md
  const m = rel.match(
    /^((?:workspaces\/[^/]+\/)?journal(?:\/\.pending)?)\/(\d+)(?:-[^/]*)?\.md$/,
  );
  if (!m) return { watched: false };
  return { watched: true, slot: m[2], dir: m[1], rel };
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
 * Find the latest accepted journal-slot-reservation record for the
 * given (dir, slot) tuple. Returns the record or null on absent.
 *
 * Reservation record shape (the contract M6 D's writer ships; B3a's
 * guard READS):
 *   {
 *     type: "journal-slot-reservation",
 *     verified_id, person_id, display_id, seq, prev_hash, ts, sig,
 *     content: { slot: "0042", dir: "journal" }
 *   }
 *
 * "Latest" is by seq ordering on the reservation's emitter chain;
 * because a slot is reserved exactly once in honest play, the
 * disambiguation is mostly defensive — the first verifying reservation
 * is the authoritative one. We pick the first match by accepted-order
 * for determinism.
 */
function findSlotReservation(accepted, dir, slot) {
  if (!Array.isArray(accepted)) return null;
  // M3 HIGH-5 / F-8: deterministic tie-breaking by (seq, ts, verified_id).
  // Pre-hardening returned first-by-accepted-order, which gave a forger
  // a pre-emptive DoS surface — a forger emitting an early-folded
  // reservation could win against an honest reserver's later seq. The
  // structural defense is lowest-seq-wins: the seq value IS the
  // emitter-chain position, anchored by rule-2 chain integrity. The
  // forger cannot game seq without forging a chain, and rule-1 +
  // rule-2 catch that.
  const matches = [];
  for (const rec of accepted) {
    if (!rec || rec.type !== "journal-slot-reservation") continue;
    const c = rec.content || {};
    if (c.dir === dir && c.slot === slot) matches.push(rec);
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    // Primary: lowest seq.
    if (a.seq !== b.seq) return a.seq - b.seq;
    // Secondary: lowest ts (ISO-8601 lex-sorts correctly).
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    // Tertiary: verified_id lex (stable).
    if (a.verified_id !== b.verified_id) {
      return a.verified_id < b.verified_id ? -1 : 1;
    }
    return 0;
  });
  return matches[0];
}

/**
 * Extract the `author:` value from a journal entry's YAML frontmatter
 * (the leading `---` … `---` block of the Write payload's content). Returns the
 * raw author string, or null when absent / unparseable. Frontmatter-only scan
 * (stops at the closing fence) so a body line `author: foo` cannot spoof it.
 *
 * F101-3: this is the CLAIM. checkAuthorBacking verifies it against the ledger.
 */
function extractFrontmatterAuthor(content) {
  if (typeof content !== "string" || content.length === 0) return null;
  // Frontmatter MUST be the leading block. Tolerate a UTF-8 BOM + leading
  // whitespace before the opening fence.
  const m = content.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const block = m[1];
  for (const line of block.split(/\r?\n/)) {
    const am = line.match(/^author:\s*(.+?)\s*$/);
    if (am) return am[1];
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

    // F14 MED-4: resolve to main checkout. Inside a worktree, the
    // session cwd points at the worktree path; the coordination log +
    // slot-reservation records live at the MAIN checkout's
    // .claude/learning/. Without resolveMainCheckout, the fold below
    // reads an empty / stale log and sees no reservations — the guard
    // either passthroughs or halt-and-reports incorrectly. Mirrors
    // integrity-guard.js:324-325.
    const sessionCwd = resolveRepoDir(payload);
    const repoDir = resolveMainCheckout(sessionCwd) || sessionCwd;
    const wp = isWatchedPath(watch.targetPath, repoDir);
    if (!wp.watched) {
      // Outside-repo path OR not a journal entry — silent passthrough.
      passthrough();
    }

    // Resolve absolute target for the fs.existsSync block check.
    const absTarget = path.isAbsolute(watch.targetPath)
      ? watch.targetPath
      : path.join(repoDir, watch.targetPath);

    // (1) BLOCK branch — file ALREADY exists on disk. Structural primitive:
    // fs.existsSync is process-local deterministic per
    // hook-output-discipline.md MUST-2.
    if (fs.existsSync(absTarget)) {
      clearTimeout(fallback);
      emit({
        hookEvent,
        severity: "block",
        what_happened: `Journal entry already exists on disk: ${wp.rel}`,
        why: "multi-operator-coc/journal-write-guard MUST-NOT-1 — journal entries are append-only per rules/journal.md; overwriting destroys the audit trail. fs.existsSync IS the structural primitive (hook-output-discipline.md MUST-2): the file presence is process-local deterministic, not lexical match.",
        agent_must_report: [
          `Target path: ${wp.rel}`,
          `Slot: ${wp.slot}`,
          "Open a NEW journal entry with a fresh slot (run reserveJournalSlot(dir) via /journal --new) rather than overwriting the existing entry.",
          "If amending the existing entry is genuinely required, route through /journal --amend which appends an addendum block rather than overwriting.",
        ],
        agent_must_wait:
          "Do not retry the Write against this path. Acquire a fresh slot via /journal --new and Write the new entry there.",
        user_summary: `journal-write-guard — BLOCK on existing journal file ${wp.rel}`,
      });
      // emit() exits
    }

    // MO-OPT W1-c — opt-in gate (workspaces/multi-operator-optional, journal/0330).
    // The append-only BLOCK above is mode-independent (journal.md forbids
    // overwriting an entry on a solo repo too), so it stays ABOVE this gate.
    // Everything below — the slot-reservation FOLD check, the sibling
    // discrimination, the author-backing verifiability layer — is the
    // coordination substrate. On a solo / fresh repo (coordination OFF), solo
    // journal numbering is race-free via pure reserveJournalSlot (fs
    // high-water), there are no siblings, and the provenance ledger is absent —
    // so the fold check would halt-and-report "slot unreserved" on every solo
    // journal write (analysis gate #2). Skip it. When ENABLED, byte-unchanged.
    if (!isCoordinationEnabled(repoDir)) {
      passthrough();
    }

    // (2) Registry checks against the folded coordination log.
    // Identity is required to discriminate self-reserved vs sibling-reserved.
    const explicitKey = process.env.COC_OPERATOR_KEY_PATH;
    const identity = resolveIdentity(repoDir, {
      signingKeyPath: explicitKey || undefined,
      keyType: explicitKey ? "ssh" : undefined,
    });
    const selfVerifiedId = (identity && identity.verified_id) || null;

    const transport = createFilesystemTransport(repoDir);
    let accepted = [];
    try {
      const records = await transport.readAllRecords();
      const roster = loadRoster(repoDir);
      // Sandboxed engine: register the journal-slot-reservation predicate.
      // M6 D writes the record; B3a reads it. Sandboxed (createEngine) so
      // the module-default registry is unmodified for parallel callers.
      const engine = createEngine();
      engine.registerFoldPredicate(
        "journal-slot-reservation",
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
      // Structural-NULL: log read or fold failed. Surface as
      // halt-and-report (slot-reservation cannot be verified) — the
      // honest disposition is "we can't tell" rather than passthrough.
      accepted = [];
    }

    const reservation = findSlotReservation(accepted, wp.dir, wp.slot);

    if (!reservation) {
      // (2a) Slot UNRESERVED — halt-and-report. Registry-level signal,
      // not structural per hook-output-discipline.md MUST-2.
      clearTimeout(fallback);
      emit({
        hookEvent,
        severity: "halt-and-report",
        what_happened: `Journal slot ${wp.slot} in ${wp.dir} is not reserved in the coordination log.`,
        why: "multi-operator-coc/journal-write-guard MUST-NOT-2 — under N concurrent operators a naive slot pick silently clobbers (architecture v11 §5.2). Reserve via /journal --new (M6 D writes the signed `journal-slot-reservation` record) before writing. Registry-record signal, not structural: hook-output-discipline.md MUST-2 — severity=halt-and-report, not block.",
        agent_must_report: [
          `Target path: ${wp.rel}`,
          `Slot: ${wp.slot} (UNRESERVED in fold)`,
          "Run /journal --new (or reserveJournalSlot(dir) directly) to append a signed journal-slot-reservation record BEFORE writing the entry.",
          "If the slot was JUST reserved by this session and the log is stale, run a log fetch (the heartbeat hook does this on stop) and retry.",
        ],
        agent_must_wait:
          "Do not retry the Write until the reservation lands in the folded coordination log.",
        user_summary: `journal-write-guard — slot ${wp.slot} unreserved in ${wp.dir}`,
      });
      // emit() exits
    }

    // (2b) Slot RESERVED. Discriminate self vs sibling.
    if (reservation.verified_id === selfVerifiedId) {
      // Self-reserved → the writer IS authorized for the SLOT. Before the
      // passthrough, run the F101-3 author-backing branch: a new journal
      // entry's `author:` claim is verified against the live provenance ledger.
      const author = extractFrontmatterAuthor(
        (payload && payload.tool_input && payload.tool_input.content) || "",
      );
      if (author !== null) {
        const result = checkAuthorBacking({
          repoDir,
          session: payload.session_id || payload.session || "",
          frontmatterAuthor: author,
        });
        if (result.status === "unbacked" || result.status === "undetermined") {
          // REGISTRY-class (reads ledger + matches frontmatter), NEVER block —
          // an empty ledger is ambiguous (degraded capture vs false claim) per
          // hook-output-discipline.md MUST-2. halt-and-report; the user
          // adjudicates whether the claim stands.
          clearTimeout(fallback);
          const isUndetermined = result.status === "undetermined";
          emit({
            hookEvent,
            severity: "halt-and-report",
            what_happened: `Journal author claim '${author}' is ${result.status.toUpperCase()} against the live session provenance ledger (${result.label}).`,
            why: "journal-author-discipline/MUST-1 — an author:human|co-authored claim is valid ONLY when backed by ≥1 session HumanInput provenance event (F101-3, #411). Author claims are verifiable, not trusted: the check reads the LIVE per-session ledger, NEVER the frontmatter's own assertion. Registry-record signal (reads a ledger file + matches frontmatter), not structural: hook-output-discipline.md MUST-2 — severity=halt-and-report, NEVER block (an empty/absent ledger is ambiguous degraded-capture, not an irrefutable false claim).",
            agent_must_report: [
              `Target path: ${wp.rel}`,
              `Frontmatter author: ${author}`,
              isUndetermined
                ? "Backing status: UNDETERMINED — no live session ledger to verify against (capture may be degraded, or no HumanInput events were captured this session)."
                : `Backing status: UNBACKED — ${result.humanInputCount} HumanInput events found in this session's ledger; a human|co-authored claim requires ≥1.`,
              isUndetermined
                ? "If the provenance ledger is genuinely degraded, confirm the author classification with the user, OR set author:agent if the entry was agent-surfaced (renders 'n/a — agent-surfaced')."
                : "If no human input shaped this entry, set author:agent (it renders 'n/a — agent-surfaced'). If a human DID drive it, surface why the session captured zero HumanInput events.",
            ],
            agent_must_wait:
              "Do not retry the Write until the author classification is reconciled with the user or corrected to author:agent.",
            user_summary: `journal-author-discipline — author '${author}' ${result.status} vs live ledger (${wp.rel})`,
          });
          // emit() exits
        }
        // backed | n/a-agent → fall through to passthrough below.
      }
      // Self-reserved + (backed | n/a-agent | no author frontmatter) →
      // passthrough. The writer IS authorized.
      passthrough();
    }

    // Sibling-reserved → halt-and-report. Same registry-class signal as
    // slot-unreserved — judgment-bearing, not structural.
    clearTimeout(fallback);
    const siblingDisplay =
      reservation.display_id || reservation.person_id || "unknown";
    emit({
      hookEvent,
      severity: "halt-and-report",
      what_happened: `Journal slot ${wp.slot} in ${wp.dir} is reserved by sibling operator ${siblingDisplay}.`,
      why: "multi-operator-coc/journal-write-guard MUST-NOT-3 — a slot reserved by another operator IS a slot another operator intends to write to. Concurrent writes silently clobber (architecture v11 §5.2). Coordinate handoff before writing. Registry-record signal: hook-output-discipline.md MUST-2 — severity=halt-and-report.",
      agent_must_report: [
        `Target path: ${wp.rel}`,
        `Slot: ${wp.slot}`,
        `Reserved by: sibling operator ${siblingDisplay} (verified_id ${reservation.verified_id.slice(0, 24)}...)`,
        "Acquire a different slot via /journal --new (the writer will allocate the next available NNNN) and write the entry there.",
        "If handoff is genuinely required, coordinate with the sibling operator (the slot is theirs by reservation precedence).",
      ],
      agent_must_wait:
        "Do not retry the Write against this slot. Acquire a different slot or coordinate handoff with the sibling reserver.",
      user_summary: `journal-write-guard — slot ${wp.slot} reserved by sibling ${siblingDisplay}`,
    });
    // emit() exits
  } catch (err) {
    // Defense-in-depth: any unexpected exception MUST NOT block forever.
    // Structural-NULL fallback per cc-artifacts.md Rule 7 — emit
    // {continue: true} so the agent can proceed; the user-visible
    // signal is the stderr advisory line.
    try {
      process.stderr.write(
        `[ADVISORY] journal-write-guard internal error: ${err && err.message ? err.message : String(err)}\n`,
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
