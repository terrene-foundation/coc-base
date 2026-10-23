#!/usr/bin/env node
/**
 * @hook-event: PreToolUse:Edit|NotebookEdit|Write (guard) — the pending journal path, existing bytes and slot ownership are available before mutation.
 *
 * journal-write-guard.js — §4.3 pre-tool-use hook for `Write` on journal/.
 *
 * @coc-codex-edit-gate — journal append-only + slot-reservation gate. The
 *   policy extractor fans its CC edit-matcher registration out to the Codex
 *   `apply_patch` lane (mcp-guard, FF-AC6-1). The append-only block reads the
 *   projected target path against `fs.existsSync` and applies in every mode;
 *   the slot-registry half is gated on governance, and an unenrolled repo
 *   receives only the advisory (`shapeAdvisoryOrPassthrough`), so the Codex
 *   posture matches the CC posture exactly.
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
 *   Budget:   ONE source — BUDGET_MS, the run budget handed to
 *             guard-runner.js::runGuard (and back to main as ctx.budgetMs),
 *             set under the registry row's 20 s timeout. The check deadline
 *             is DERIVED from it (ctx.budgetMs - CHECK_RESERVE_MS, from
 *             process start). A check that does not finish in it REFUSES as
 *             a budget refusal naming the slot as unverified — never a bare
 *             {continue: true}; see notCompleted() below. The run itself is
 *             bounded by the runner: a crash, a hang past its budget or an
 *             unreadable payload REFUSES (cc-artifacts.md Rule 7, deny-
 *             capable rows).
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
 * ENV OVERRIDES (test injection only — all stripped by
 * `audit-fixtures/hook-fixture-runner.mjs::GUARD_ENV_KEYS`):
 *   COC_OPERATOR_REPO_DIR  — test injection of the repo root.
 *   COC_OPERATOR_KEY_PATH  — explicit signing-key path (Tier-1 of
 *                             operator-id.js's 3-tier discovery).
 *   COC_JOURNAL_GUARD_BUDGET_MS — TIGHTEN-ONLY check budget (see below).
 *   COC_TEST_JOURNAL_GUARD_INTERNAL_ERROR — throw at the slot-identified point
 *                             so the internal-error disposition (a runner
 *                             crash refusal) is drivable.
 */

"use strict";

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [
 *       "<os.tmpdir()>/coc-sign-ssh-vfy-<rand>/",
 *       "<os.tmpdir()>/coc-sign-gpg-vfy-<rand>/",
 *       "<os.tmpdir()>/coc-sign-gpg-fold-<rand>/"
 *     ],
 *     "network": false,
 *     "spawns": ["git","gpg","ssh-keygen"]
 *   },
 *   "idempotent": true,
 *   "may_rewrite_input": false,
 *   "notes": "spawns: git probes (lib/state-resolver.js, lib/guard-path-scope.js, lib/operator-id.js) plus ssh-keygen / gpg verification of the reservation fold (lib/coordination-log.js -> lib/coc-sign.js). Writes: the per-call / per-fold verify homedirs lib/coc-sign.js mkdtemps under the OS temp root and rmSyncs before returning. The journal target and the coordination log are READ only — M6 D writes the reservation record; this hook never writes the entry."
 * }
 */

// THE HOOK BUDGET, AND WHAT HAPPENS WHEN IT RUNS OUT (2026-09-12; fail-closed 2026-10-19).
//
// The fallback that once stood here fired 5000ms after MODULE LOAD and wrote a bare
// `{continue:true}`, byte-identical to "checked, and the slot is fine". A reservation
// check that never finished read as a PASS, silently (rules/instrument-discipline.md
// MUST-1; rules/conservation-gate.md MUST-4). Its successor rendered every expiry as
// HALT-AND-REPORT — still `continue:true`, so the write still landed on an unverified
// slot of a collision fence.
//
// Every expiry now REFUSES, as a BUDGET refusal (`notCompleted()`): "a guard time-out
// under load is a budget refusal, not a deny" — the refusal names the slot as
// UNVERIFIED (never as taken), and tells the operator to retry. A crash anywhere in
// this guard is no longer rendered here at all: it reaches `guard-runner.js::runGuard`,
// which refuses naming this guard. Neither ending lets an unchecked write through.
//
// WHERE THE TIME GOES, measured on a copy of loom's 935-record log, enrolled-solo,
// load ~356: the fold is 1909ms and 1894ms of it is five subprocesses from ONE
// record — `coordination-log.js::_genesisAnchorPredicate` re-verifying the genesis
// anchor's GPG signature through an ephemeral homedir (gpg --import, gpgconf
// --kill, ps). The JS work over all 935 records is ~15ms. So the fold does not
// scale with the log in any way that matters today; a record-type pre-filter would
// not remove that cost AND would break acceptance (a reservation is accepted only
// through its emitter's whole chain — pinned by run.mjs C9).
//
// TWO ARMS enforce the check deadline, because nothing can preempt synchronous code:
// an explicit check runs before the log read, and `foldLog`'s own `deadlineAtMs` (the
// s49 P5 mechanism integrity-guard.js uses) stops the synchronous fold between
// records. The awaited phases are bounded by the runner's budget outside the engine
// and by the registry row's timeout inside it. RESIDUAL: one record's work is not
// preemptible — a single slow GPG verify straddling the host's kill still dies with
// no output at all (which the dispatcher reads as an incomplete deny row: refused).
//
// ONE BUDGET SOURCE. BUDGET_MS is the run budget the runner enforces outside the engine
// and hands back as ctx.budgetMs; the check deadline is DERIVED from ctx.budgetMs, never
// from a constant of its own (an earlier 4000 ms check constant sat against a 20 s
// registry row, so the guard refused a write at 4 s that its row had budgeted 20 s for).
// 16000 against the row's 20 s is the internal-before-registered shape the other 20 s
// deny rows use (dispatch-registry.json _timeout_note): the runner's own budget, and
// inside the engine the row's timeout, both end after the check deadline, so this
// guard's NAMED budget refusal (notCompleted) is the one that fires.
const BUDGET_MS = 16000;
// Held back from the run budget for the fold to stop between records and the refusal to
// render and leave before the runner's budget would refuse unnamed.
const CHECK_RESERVE_MS = 1000;

// COC_JOURNAL_GUARD_BUDGET_MS is test injection that can only TIGHTEN, and applies
// only once a journal slot is identified (integrity-guard.js's loom#1855 lesson: a
// shortening knob may govern only a deadline whose handler refuses to pass — this
// one's handler refuses).
const PROCESS_STARTED_AT = Date.now();
/** The check budget for this run: derived from the run budget, tightened (only) by the env. */
function checkBudgetOf(runBudgetMs) {
  const derived = Math.max(1, runBudgetMs - CHECK_RESERVE_MS);
  const raw = Number(process.env.COC_JOURNAL_GUARD_BUDGET_MS);
  if (!Number.isFinite(raw) || raw <= 0) return derived;
  return Math.min(raw, derived);
}

// What the guard has established about this call so far; read by notCompleted().
const checkState = {
  hookEvent: "PreToolUse",
  slot: null, // {rel, slot, dir} once the target is identified as a journal entry
  phase: "reading the tool call",
  budgetMs: null, // the check budget, set once the slot is identified (checkBudgetOf)
};

const fs = require("fs");
const path = require("path");

const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
// The fail-closed run boundary: it reads the payload, bounds the run, and refuses on a
// crash, a hang or an unreadable payload. REFUSAL_TEXT is the ONE refusal-text source —
// the verbatim budget sentence and the retry sentence — reused so this guard's own
// deadline refusal says the same words as the runner's.
const { runGuard, REFUSAL_TEXT } = require("./lib/guard-runner.js");
const { BUDGET_SENTENCE } = REFUSAL_TEXT;

/**
 * The ONE renderer for "the check did not complete in its deadline": a BUDGET
 * REFUSAL. Never returns: emit() exits 2. Called only once the target is identified
 * as a journal entry (every caller sits after `checkState.slot` is set), and only
 * from the verdict path — never from a catch, a timer or a listener.
 *
 * WHY REFUSE, NOT HALT-AND-REPORT. halt-and-report is `continue:true` at PreToolUse
 * (lib/instruct-and-wait.js), so on this collision fence it let a write land on a
 * slot whose reservation state was never established. A timeout is machine load,
 * not evidence the slot is taken — so the refusal says UNVERIFIED (never "taken")
 * and tells the operator to retry; it is the same budget refusal the runner gives a
 * guard that overran (guard-runner.js::runGuard). Block-grade on a structural fact:
 * the deadline passed on this process's own clock (hook-output-discipline.md MUST-2).
 */
function notCompleted(detail) {
  const s = checkState;
  const elapsed = Date.now() - PROCESS_STARTED_AT;
  const where = s.slot ? `journal slot ${s.slot.slot} in ${s.slot.dir}` : "this call's journal target";
  return emit({
    escalate: "security",
    hookEvent: s.hookEvent,
    severity: "block",
    what_happened: `journal-write-guard did not complete the reservation check for ${where} within its budget — slot unverified. Stopped while ${s.phase} (${detail}; ${elapsed}ms since start, budget ${s.budgetMs}ms): ${BUDGET_SENTENCE}.`,
    why: "multi-operator-coc/journal-write-guard MUST-NOT-2 — the slot-reservation check did not finish, so neither reserved nor unreserved was established; a sibling lane's reservation may sit in the part of the log that was never folded. A check that did not finish cannot clear the write (cc-artifacts.md Rule 7, deny-capable rows — guard-runner.js::runGuard); a bare continue is byte-identical to a completed clean check (rules/instrument-discipline.md MUST-1).",
    agent_must_report: [
      s.slot ? `Target path: ${s.slot.rel}` : "Target path: not yet identified",
      s.slot
        ? `Slot: ${s.slot.slot} in ${s.slot.dir} — reservation state UNKNOWN (check did not complete)`
        : "Reservation state: UNKNOWN (check did not complete)",
      `${BUDGET_SENTENCE}: the slot is NOT known to be taken — state that it was NOT verified, neither free nor reserved.`,
      REFUSAL_TEXT.retrySentence("journal-write-guard"),
    ],
    agent_must_wait:
      "Retry the journal write once; if the budget refusal recurs, report it and wait for the user.",
    user_summary: s.slot
      ? `journal-write-guard — budget refusal: slot ${s.slot.slot} in ${s.slot.dir} UNVERIFIED (check did not complete: ${detail})`
      : `journal-write-guard — budget refusal: check did not complete (${detail})`,
  });
}
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
const { requireMainCheckout } = require(
  path.join(__dirname, "lib", "state-resolver.js"),
);
// loom#1414: worktree-aware root resolution, shared with integrity-guard.js.
// resolveMainCheckout above deliberately redirects repoDir to the MAIN
// checkout for REGISTRY I/O (the fold + reservation records live there) —
// but the same repoDir was ALSO being used for the watched-PATH decision,
// which made this guard blind to every journal write inside a worktree.
// Registry I/O still routes to main; only the path decision is now
// evaluated against the tree the target actually lives in.
const { matchFirstCandidate, matchJournalEntryRel } = require(
  path.join(__dirname, "lib", "guard-path-scope.js"),
);
// M9.1 R4 Sec-R4-S-06 — route tool-name check through the mutation-tool
// SSOT per `cc-artifacts.md` Rule 8. Pre-fix: hardcoded `tool !== "Write"`
// missed MultiEdit + NotebookEdit, which can also create new journal
// entries and bypass the slot-reservation guard. Post-fix: any mutation
// tool fires the guard.
const { isMutationTool } = require(
  path.join(__dirname, "lib", "tool-classes.js"),
);
// FRONTMATTER-SHAPE layer (graduates `phase2-deferrals.json::
// journal.md#frontmatter-shape-advisory`). A SECOND obligation over the SAME
// frontmatter block, carrying its OWN rule_id and its OWN severity — see
// lib/journal-frontmatter-shape.js for why it is `journal/frontmatter-shape`
// and NOT `journal-author-discipline/MUST-1`. `splitFrontmatterBlock` is the
// ONE fence-anchoring implementation; parseFrontmatterAuthor below delegates to
// it rather than carrying a second copy, which is what the deferral row's
// "EXTEND that guard's existing frontmatter parse" direction asks for.
const {
  splitFrontmatterBlock,
  inspectFrontmatterShape,
  renderShapeLines,
} = require(path.join(__dirname, "lib", "journal-frontmatter-shape.js"));
// F101-3 (loom#411 governance-as-DNA): author-VERIFIABILITY layer. On a NEW
// journal entry Write, the `author:` frontmatter claim is checked against the
// LIVE per-session provenance ledger (the F101-2 capture stream). An unbacked /
// undetermined human|co-authored claim emits halt-and-report (REGISTRY-class
// per hook-output-discipline.md MUST-2 — NEVER block; an empty ledger is
// ambiguous degraded-capture, not an irrefutable structural false claim).
const { checkAuthorBacking } = require(
  path.join(__dirname, "lib", "provenance-author-backing.js"),
);
// GOVERNANCE, not coordination (2026-09-12) — see the gate in main() for why the
// registry branch is keyed on enrollment and why the fold's signature
// verification still follows the coordination verdict `governanceMode` carries.
const { isGovernanceEnabled, governanceMode } = require(
  path.join(__dirname, "lib", "coordination-mode.js"),
);
const { resolveRepoDirBound } = require(
  path.join(__dirname, "lib", "repo-dir-override.js"),
);

function passthrough() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

function resolveRepoDir(payload) {
  // loom#1871 HIGH-1 — the override is now bound to the SESSION REPOSITORY.
  // It was honoured on the sole evidence that the directory EXISTED, so a
  // `settings.json` env: line plus a `git init` moved this guard to an
  // unrelated repo and it passed everything through. See lib/repo-dir-override.js
  // for the 8-of-8 two-pole measurement, the three arms, and why
  // `provenCheckoutRoot` does not close it.
  return resolveRepoDirBound(payload, { hookName: "journal-write-guard" })
    .repoDir;
}

/**
 * Watched-tool predicate. The hook is registered in settings.json under the
 * PreToolUse matcher `Edit|Write|NotebookEdit` and gates every tool in
 * `tool-classes.js::MUTATION_TOOLS` (Edit, Write, MultiEdit, NotebookEdit) —
 * NOT Write alone. An Edit against an existing journal entry is blocked here;
 * integrity-guard.js's codify-branch+lease check is an ADDITIONAL, separate
 * gate on the same path, not a substitute for this one.
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
  // loom#1414: the realpath normalisation that used to sit inline here
  // (F14 MED-4) was correct for the macOS /var vs /private/var case but did
  // NOT address a target in a DIFFERENT TREE. Since repoDir is the MAIN
  // checkout, every journal Write from inside a linked worktree produced a
  // `../`-prefixed rel and returned watched:false — measured: the identical
  // Write passed silently unpinned and fenced with CLAUDE_TRUST_STATE_DIR
  // pinned to the worktree. Root/rel resolution (including that realpath
  // normalisation) now lives in lib/guard-path-scope.js.
  //
  // loom#1422: the journal-entry SHAPE has now moved there too. It used to be
  // owned here — the fourth of four surfaces that each had to learn the
  // case-insensitivity dimension separately, and the one found ONLY because
  // #1414's shard happened to sweep for siblings.
  return (
    matchFirstCandidate(absPath, repoDir, matchJournalEntryRel, {
      markers: ["/journal/"],
    }) || { watched: false }
  );
}

// THE ROSTER READ THAT STOOD HERE TURNED THIS GUARD'S REFUSAL INTO A PASS
// (#84 follow-up, 2026-09-12). It was:
//
//     try { ... JSON.parse(readFileSync(rosterPath)) } catch { return null; }
//
// A null roster is NOT inert. `coordination-log.js::_resolveRosterPerson`
// resolves nobody, `_verifyRule1` rejects EVERY record, `fold.accepted` empties,
// `findSlotReservation` returns null, and the UNRESERVED branch below fires —
// which is halt-and-report, i.e. `continue:true`, so the Write LANDS. One
// unreadable, corrupt or emptied roster therefore removed the collision fence
// entirely, reporting the strictly WRONG verdict ("the slot is free") rather
// than an honest UNKNOWN.
//
// The allocator this guard is paired with — `journal-reserve.js::_foldHighWater`
// — REFUSES on exactly those inputs. Two readers of the same fold input held
// opposite dispositions about the same bytes, so the reservation primitive
// refused to hand out a slot while the guard waved the write through. Both now
// call `coordination-log.js::loadFoldRoster`, which owns the read, the ENOENT
// carve-out, and the typed disposition; each caller keeps only its own
// fail-closed idiom (allocator: throw; here: block).
const { loadFoldRoster, isRosterCausedRejection } = require(
  path.join(__dirname, "lib", "coordination-log.js"),
);

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
 * Parse the `author:` claim out of a journal entry's YAML frontmatter (the
 * leading `---` … `---` block of the Write payload's content). Frontmatter-only
 * scan so a body line `author: foo` cannot spoof it.
 *
 * F101-3: this is the CLAIM. checkAuthorBacking verifies it against the ledger.
 *
 * WHY THIS RETURNS A TYPED RESULT AND NOT `string|null` (2026-09-12). The prior
 * shape collapsed FOUR different worlds into the single value `null`, and the
 * caller read all four as "no claim to check, pass":
 *
 *   - no frontmatter at all           → genuinely nothing to check
 *   - frontmatter with no `author:`    → genuinely nothing to check
 *   - frontmatter OPENED but never closed → UNPARSEABLE; an `author: human`
 *                                        line inside it was never seen
 *   - `"author": human` / `author : human` → a REAL claim the line regex
 *                                        `/^author:\s*(.+?)\s*$/` did not match
 *
 * The last two are the ones that mattered: a false `author: human` written in
 * any shape the regex missed sailed past the backing check with no finding at
 * all — the check did not FAIL, it never RAN, which is the silence this repo's
 * `instrument-discipline.md` MUST-1 exists to stop. Unparseable frontmatter is
 * a FINDING, not a skip.
 *
 * The parse stays dependency-free and deliberately narrow: journal frontmatter
 * is a flat scalar block (`rules/journal.md`), so a top-level `key: value`
 * scan is the whole grammar. It tolerates a BOM, CRLF, a quoted key, space
 * before the colon, and a quoted value; it refuses on an unterminated fence and
 * on a DUPLICATE `author:` key (two claims, no way to tell which the reader of
 * the rendered entry will believe).
 *
 * @returns {{kind:"none"}                       // no frontmatter block
 *          |{kind:"no-author"}                  // frontmatter, no author key
 *          |{kind:"author", value:string}       // the claim
 *          |{kind:"unparseable", reason:string}}
 */
function parseFrontmatterAuthor(content) {
  // DELEGATED, not re-implemented (2026-09-15). This function used to carry its
  // own copy of the BOM-tolerant, fence-anchored split. The shape layer added
  // below needs the identical split, and two copies of a fence-anchoring parse
  // are two readers of the same bytes that can drift on where the block ends —
  // at which point the author layer and the shape layer disagree about what the
  // frontmatter even IS. One implementation, in lib/journal-frontmatter-shape.js.
  const split = splitFrontmatterBlock(content);
  if (split.kind === "none") return { kind: "none" };
  if (split.kind === "unterminated") {
    return {
      kind: "unparseable",
      reason:
        "the leading `---` frontmatter fence is never closed, so the frontmatter block has no end and any `author:` line inside it was not read",
    };
  }
  const block = split.block;
  let found = null;
  let duplicate = false;
  for (const rawLine of block.split(/\r?\n/)) {
    // TOP-LEVEL keys only: an indented line is nested under some other key and
    // is not this document's `author`.
    if (/^\s/.test(rawLine)) continue;
    const m = rawLine.match(/^(?:"author"|'author'|author)[ \t]*:[ \t]*(.*)$/);
    if (!m) continue;
    let value = m[1].trim();
    // Strip a trailing `# comment` only when the value is not quoted.
    if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, "").trim();
    const q = value.match(/^"([^"]*)"$|^'([^']*)'$/);
    if (q) value = q[1] !== undefined ? q[1] : q[2];
    value = value.trim();
    if (found !== null) duplicate = true;
    found = value;
  }
  if (duplicate) {
    return {
      kind: "unparseable",
      reason:
        "the frontmatter declares `author:` more than once — the entry makes two authorship claims and which one a reader believes depends on their parser",
    };
  }
  if (found === null) return { kind: "no-author" };
  if (found === "") {
    return {
      kind: "unparseable",
      reason: "the frontmatter declares `author:` with an empty value",
    };
  }
  return { kind: "author", value: found };
}

/**
 * Resolve the author-backing FINDING for this Write, or null when there is
 * nothing to report. Computed ONCE, before the reservation branches, so it can
 * be carried into whichever verdict those branches reach.
 *
 * THE DEFECT THIS EXISTS FOR (2026-09-12). This check used to live INSIDE the
 * self-reserved branch, below two `emit()` calls that never return. An entry
 * claiming `author: human` in an UNRESERVED slot, or in a slot a SIBLING
 * reserved, was reported as unreserved/sibling-reserved and the author claim was
 * never checked at all — so the surface where a false authorship claim is most
 * likely (a slot this session did not reserve) was the one surface the
 * verifier could not reach. One computation, one emit, every finding carried.
 */
function resolveAuthorFinding(payload, repoDir) {
  const parsed = parseFrontmatterAuthor(
    (payload && payload.tool_input && payload.tool_input.content) || "",
  );
  if (parsed.kind === "none" || parsed.kind === "no-author") return null;
  if (parsed.kind === "unparseable") {
    return {
      status: "unparseable",
      author: null,
      lines: [
        `Author claim: NOT CHECKED — the frontmatter could not be parsed (${parsed.reason}).`,
        "An unparseable frontmatter block is a finding, not a clean result: the author-backing check could not run, so the entry's authorship claim is UNVERIFIED. Fix the frontmatter and retry.",
      ],
      summary: "author frontmatter UNPARSEABLE (backing check did not run)",
    };
  }
  const result = checkAuthorBacking({
    repoDir,
    session: payload.session_id || payload.session || "",
    frontmatterAuthor: parsed.value,
  });
  if (result.status !== "unbacked" && result.status !== "undetermined") {
    return null; // backed | n/a-agent
  }
  const isUndetermined = result.status === "undetermined";
  return {
    status: result.status,
    author: parsed.value,
    lines: [
      `Frontmatter author: ${parsed.value}`,
      isUndetermined
        ? "Backing status: UNDETERMINED — no live session ledger to verify against (capture may be degraded, or no HumanInput events were captured this session)."
        : `Backing status: UNBACKED — ${result.humanInputCount} HumanInput events found in this session's ledger; a human|co-authored claim requires ≥1.`,
      isUndetermined
        ? "If the provenance ledger is genuinely degraded, confirm the author classification with the user, OR set author:agent if the entry was agent-surfaced (renders 'n/a — agent-surfaced')."
        : "If no human input shaped this entry, set author:agent (it renders 'n/a — agent-surfaced'). If a human DID drive it, surface why the session captured zero HumanInput events.",
    ],
    summary: `author '${parsed.value}' ${result.status} vs live ledger`,
  };
}

// ---- main -------------------------------------------------------------------

async function main(payload, ctx) {
  const hookEvent = payload.hook_event_name || "PreToolUse";

  const watch = isWatchedTool(payload);
  if (!watch.watched) {
    return passthrough();
  }

  // F14 MED-4: resolve to main checkout. Inside a worktree, the
  // session cwd points at the worktree path; the coordination log +
  // slot-reservation records live at the MAIN checkout's
  // .claude/learning/. Without resolveMainCheckout, the fold below
  // reads an empty / stale log and sees no reservations — the guard
  // either passthroughs or halt-and-reports incorrectly. Mirrors
  // integrity-guard.js:324-325.
  const sessionCwd = resolveRepoDir(payload);
  // loom#1471 F7b — fail CLOSED when git cannot identify the main checkout.
  // The former `|| sessionCwd` could not fire; an unidentified root makes the
  // fold below read an empty log and see no slot reservations, which is
  // indistinguishable from "no reservations exist" — the guard then
  // passthroughs on a repo whose reservation state it never actually read.
  const mainRes = requireMainCheckout(sessionCwd);
  if (!mainRes.ok) {
    return emit({
      escalate: "security",
      hookEvent,
      severity: "block",
      what_happened: `Journal-write check could not run: the MAIN checkout could not be identified — ${mainRes.reason}`,
      why: "multi-operator-coc/journal-write-guard — slot reservations live in the MAIN checkout's coordination log. With the root unidentified the fold reads an empty log, which reads as `no reservations` and passes the write through; that is a fail-OPEN on the collision fence. Refusing is the fail-closed direction (`rules/security.md` § Enforcement-Surface Parity).",
      agent_must_report: [
        `Session cwd: ${sessionCwd}`,
        `Resolver reason: ${mainRes.reason}`,
        "Journal slot-reservation checking did NOT run — its result is UNKNOWN, not clean.",
        "A differently-owned checkout reports `detected dubious ownership`; take ownership, or set CLAUDE_TRUST_STATE_DIR.",
      ],
      agent_must_wait:
        "Do not retry the journal write until git can identify the main checkout, or the operator pins CLAUDE_TRUST_STATE_DIR.",
      user_summary:
        "journal-write-guard — main checkout unidentifiable; refused rather than passed through",
    });
  }
  const repoDir = mainRes.repoDir;
  const wp = isWatchedPath(watch.targetPath, repoDir);
  if (!wp.watched) {
    // Outside-repo path OR not a journal entry — silent passthrough.
    return passthrough();
  }

  // IDENTIFIED: from here the check owes a verdict on THIS slot, so the budget
  // re-arms on the check deadline and every expiry names the slot. Re-arming
  // HERE, not at module load, is what keeps COC_JOURNAL_GUARD_BUDGET_MS off
  // every non-journal Edit (see the header above `PROCESS_STARTED_AT`).
  checkState.hookEvent = hookEvent;
  checkState.slot = { rel: wp.rel, slot: wp.slot, dir: wp.dir };
  checkState.phase = "checking the slot";
  checkState.budgetMs = checkBudgetOf(ctx.budgetMs);
  // DETERMINISTIC TRIGGER FOR THE INTERNAL-ERROR BRANCH. That branch is
  // otherwise reachable only by a defect, so nothing could drive it and its
  // disposition went unmeasured — which is how it kept a bare `{continue:true}`
  // (a check that errored rendering as a check that passed). Placed AFTER slot
  // identification so the emitted finding names the slot, exactly as a real
  // exception from the fold below would. Test injection only: it can only make
  // the guard MORE conservative (halt-and-report), never bypass a fence, and
  // `hook-fixture-runner.mjs::GUARD_ENV_KEYS` strips it so an ambient value
  // cannot reach a fixture that did not ask for it.
  if (process.env.COC_TEST_JOURNAL_GUARD_INTERNAL_ERROR === "1") {
    throw new Error("COC_TEST_JOURNAL_GUARD_INTERNAL_ERROR injected fault");
  }
  const checkDeadlineAt = PROCESS_STARTED_AT + checkState.budgetMs;

  // Resolve absolute target for the fs.existsSync block check.
  const absTarget = path.isAbsolute(watch.targetPath)
    ? watch.targetPath
    : path.join(repoDir, watch.targetPath);

  // (1) BLOCK branch — file ALREADY exists on disk. Structural primitive:
  // fs.existsSync is process-local deterministic per
  // hook-output-discipline.md MUST-2.
  if (fs.existsSync(absTarget)) {
    return emit({
      escalate: "destructive",
      hookEvent,
      severity: "block",
      what_happened: `Journal entry already exists on disk: ${wp.rel}`,
      why: "multi-operator-coc/journal-write-guard MUST-NOT-1 — journal entries are append-only per rules/journal.md; overwriting destroys the audit trail. fs.existsSync IS the structural primitive (hook-output-discipline.md MUST-2): the file presence is process-local deterministic, not lexical match.",
      agent_must_report: [
        `Target path: ${wp.rel}`,
        `Slot: ${wp.slot}`,
        "Open a NEW journal entry with a fresh slot (run reserveJournalSlot(dir) via /journal new <TYPE> <topic>) rather than overwriting the existing entry.",
        "If amending the existing entry is genuinely required, open a NEW entry of type AMENDMENT carrying `relates_to: <NNNN-slug>` pointing at the original (rules/journal.md § types). There is no in-place amend: entries are immutable once created, and no /journal flag edits one.",
      ],
      agent_must_wait:
        "Do not retry the Write against this path. Acquire a fresh slot via /journal new <TYPE> <topic> and Write the new entry there.",
      user_summary: `journal-write-guard — BLOCK on existing journal file ${wp.rel}`,
    });
  }

  // FRONTMATTER SHAPE — computed HERE, and the placement is three deliberate
  // choices rather than convenience.
  //
  // BELOW the existsSync BLOCK: an Edit/Write onto an EXISTING entry is
  // already refused above, so this layer only ever sees a NEW entry. That is
  // exactly the population `rules/journal.md` § Backfill / Grandfathering
  // scopes a contract change to ("a contract change applies only to entries
  // created AFTER it lands"), and it is why shipping this detector does not
  // oblige — or permit — a backfill sweep of the 274 existing entries that
  // diverge from the contract. The immutability MUST NOT wins over shape.
  //
  // ABOVE the GOVERNANCE gate: shape is a property of the CONTENT alone. It
  // needs no roster, no coordination log and no reservation record. Below the
  // gate it would be silently dead on every unenrolled repo — a detector whose
  // silence there would be the absence of an instrument, not a clean result.
  //
  // RESERVATION KEYS ARE GATED ON GOVERNANCE, not on nothing: `verified_id`,
  // `person_id` and `display_id` come "[from reservation]", and on an
  // unenrolled repo `reserveJournalSlotSigned` returns `record: null`, so
  // their absence there is a state the author cannot fix. Requiring them
  // anyway would emit noise an operator can only learn to ignore.
  const shapeFindings = inspectFrontmatterShape(
    (payload.tool_input || {}).content,
    { reservationKeysRequired: isGovernanceEnabled(repoDir) },
  );
  // Self-labelling lines: these ride into emits whose OWN severity is `block`
  // or `halt-and-report`, and an advisory finding that arrives inside a
  // refusal, unlabelled, reads as part of the reason the tool was refused.
  const shapeLines = renderShapeLines(shapeFindings);
  const shapeTail =
    shapeFindings.length > 0
      ? ` | +${shapeFindings.length} advisory frontmatter-shape finding(s)`
      : "";

  /**
   * Emit the shape findings as an ADVISORY, or pass through when there are
   * none. Called at each point the guard would otherwise have passed through
   * AFTER the target was identified as a journal entry.
   *
   * SEVERITY IS `advisory`, NEVER halt-and-report: `rules/journal.md`
   * § Detection mechanism names this detector in exactly those words, and its
   * `phase2-deferrals.json` row grades the risk `hygiene` under a repo-owner
   * acceptance — a malformed entry costs searchability, not correctness. This
   * is a RAISE from a status quo that enforced nothing, not a downgrade.
   *
   * It is also NEVER emitted BEFORE a higher-severity finding. The internal-
   * error comment at the bottom of this file records the measured reason: a
   * reader of this hook's stderr takes the FIRST severity tag it sees, so an
   * `[ADVISORY]` line ahead of a `[HALT-AND-REPORT]` downgrades the whole
   * verdict. Every call site below is terminal — the higher-severity branches
   * carry `shapeLines` INSIDE their own finding instead.
   */
  function shapeAdvisoryOrPassthrough() {
    if (shapeFindings.length === 0) return passthrough();
    return emit({
      hookEvent,
      severity: "advisory",
      what_happened: `Journal entry ${wp.rel} diverges from the canonical frontmatter contract in ${shapeFindings.length} place(s). The write was NOT blocked.`,
      why: "journal/frontmatter-shape — `rules/journal.md` § Naming & Format declares the canonical frontmatter block the /journal command emits, and the two MUST agree. Entries that diverge cannot be filtered by type, phase or date, which is what § MUST NOT means by 'unsearchable at scale'. Severity=advisory, not halt-and-report: `rules/journal.md` § Detection mechanism specifies an ADVISORY detector for this obligation and the accepted risk is `hygiene` — a malformed entry costs searchability, not correctness, and the journal is the receipt substrate every other rule writes to, so a gate here would stop the append-only journal over a missing `tags:`. Distinct rule_id from `journal-author-discipline/MUST-1`, which reads the SAME block for a DIFFERENT obligation (`rules/journal.md` § Violation scope draws that line).",
      agent_must_report: [`Target path: ${wp.rel}`, ...shapeLines],
      agent_must_wait:
        "None — this is advisory. Fix the frontmatter in the entry you are about to write; do NOT rewrite existing entries to match (rules/journal.md § Backfill / Grandfathering forbids it).",
      user_summary: `journal/frontmatter-shape — ${shapeFindings.length} advisory finding(s) on ${wp.rel}`,
    });
  }

  // GOVERNANCE gate — re-keyed 2026-09-12 from `isCoordinationEnabled`, in the
  // same change as `lib/journal-reserve.js::reserveJournalSlotSigned`, whose
  // record now emits on governance. The append-only BLOCK above stays ABOVE
  // this gate: rules/journal.md forbids overwriting an entry in every mode.
  //
  // WHAT THE REGISTRY BRANCH BELOW PROTECTS: a NEW entry lands in a slot the
  // reservation primitive allocated AND whose record the fold can see, so no
  // other reserver is handed the same number. That population is RESERVERS,
  // not humans — a sibling operator, or the same operator's other worktree or
  // clone. The MO-OPT W1-c comment that stood here called solo numbering
  // "race-free via pure reserveJournalSlot (fs high-water)"; the disk scan sees
  // only the tree it runs in, and on an enrolled single-human repo one slot was
  // issued to two lanes (W5a). Keyed on coordination, this branch stood down on
  // exactly that repo shape.
  //
  // WHY THIS CANNOT DEADLOCK: the one precondition below — a
  // `journal-slot-reservation` record for this (dir, slot) — is emitted by
  // `reserveJournalSlotSigned` under this SAME predicate, so every repo that
  // reaches the check can satisfy it by reserving first (/journal new). The
  // two MUST move together; `enforcement-predicate-partition.test.mjs` pins the
  // pair. An UNENROLLED repo (governance OFF — no roster, no genesis) still
  // passes through here, as reserve still emits no record there: issue #76's
  // receipt stays satisfiable.
  if (!isGovernanceEnabled(repoDir)) {
    // Not a bare passthrough since 2026-09-15: the SHAPE layer has no
    // governance precondition, so an unenrolled repo still gets its advisory.
    return shapeAdvisoryOrPassthrough();
  }

  // SIGNATURE VERIFICATION follows COORDINATION; the gate above does not.
  // Verifying every record by subprocess is the fold cost loom#1890 removed from
  // single-human repos, and it answers whether a SIBLING HUMAN forged a record —
  // coordination's question (`coordination-mode.js::governanceMode` § WHAT THIS
  // FUNCTION DELIBERATELY DOES NOT DO). Coordination ON: the fold is
  // byte-unchanged. Coordination OFF: `skipSignatureVerify`, which keeps the
  // roster-membership gate and every other rule — the SAME acceptance set
  // `journal-reserve.js::_foldHighWater` allocates slots from, so the allocator
  // and this guard cannot disagree about which records count. Read through
  // `governanceMode(...).coordination`: an input to the instrument, not a gate.
  const coordinationOn =
    governanceMode(repoDir).coordination.enabled === true;

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
  let rejected = [];
  let readIndeterminate = null;
  let foldDeadline = null;
  // SYNCHRONOUS deadline arm. Everything since identification ran without
  // yielding (git, key resolution); this is the first point a spent check
  // deadline can be noticed.
  checkState.phase = "reading the coordination log";
  if (Date.now() >= checkDeadlineAt) {
    return notCompleted("budget spent before the coordination-log read");
  }
  let rosterPresent = false;
  let rosterFailure = null;
  let foldRoster = null;
  try {
    const records = await transport.readAllRecords();
    // FAIL CLOSED EXACTLY AS THE ALLOCATOR DOES. `loadFoldRoster` returns
    // ok:false for an unreadable or unparseable roster; that is UNKNOWN, and
    // the disposition below is the same BLOCK the unreadable-LOG branch takes,
    // for the same reason (halt-and-report maps to continue:true, so on a
    // mutation fence it is no refusal at all). ENOENT stays ok:true with
    // present:false — a solo un-enrolled repo legitimately has no roster and
    // still folds, which is the issue-#76 receipt this must not break.
    const rosterLoad = loadFoldRoster(repoDir);
    if (!rosterLoad.ok) {
      rosterFailure = rosterLoad;
      throw new Error(rosterLoad.reason);
    }
    rosterPresent = rosterLoad.present;
    foldRoster = rosterLoad.roster;
    const roster = foldRoster;
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
    // EVERY record is folded, never a record-type subset: a reservation is
    // accepted only if its emitter's chain (rule-2) reaches it through records
    // of every type. `deadlineAtMs` makes the synchronous fold stop between
    // records and throw FOLD_DEADLINE_EXCEEDED, handled below.
    checkState.phase = "folding the coordination log";
    const fold = engine.foldLog(
      records,
      roster,
      coordinationOn
        ? { deadlineAtMs: checkDeadlineAt }
        : { skipSignatureVerify: true, deadlineAtMs: checkDeadlineAt },
    );
    accepted = fold && Array.isArray(fold.accepted) ? fold.accepted : [];
    rejected = fold && Array.isArray(fold.rejected) ? fold.rejected : [];
  } catch (err) {
    // BUDGET EXPIRY IS NOT AN UNREADABLE LOG. The log read fine; the fold did
    // not finish in time. Routing it to the unreadable-log BLOCK below would send
    // the operator to check file permissions on a healthy file, so it is only
    // RECORDED here and refused, as a budget refusal, below (never from a catch).
    if (err && err.code === "FOLD_DEADLINE_EXCEEDED") {
      foldDeadline = err;
    } else {
      // INDETERMINATE — the log could not be read or folded. The comment that
      // stood here said the honest disposition is "we can't tell", but the code
      // rebuilt `[]` and fell through to the UNRESERVED emit below, which tells
      // the agent the opposite: that the log WAS read and the slot is free.
      // `[]` is the same input a genuinely empty log produces, so the two states
      // became indistinguishable downstream (rules/instrument-discipline.md
      // MUST-1). Keep the disposition the comment always claimed, in the emit.
      readIndeterminate = err && err.message ? err.message : String(err);
    }
    accepted = [];
  }

  if (foldDeadline) {
    return notCompleted(
      `fold deadline reached after ${foldDeadline.recordsFolded} of ${foldDeadline.recordsTotal} records`,
    );
  }

  if (readIndeterminate) {
    return emit({
      escalate: "security",
      hookEvent,
      severity: "block",
      what_happened: `Write to journal slot ${wp.slot} in ${wp.dir}, but the coordination log could not be read or folded: ${readIndeterminate}`,
      why: "multi-operator-coc/journal-write-guard MUST-NOT-2 — the slot-reservation check reads the folded coordination log, and that read FAILED. The slot's reservation state is UNKNOWN, not unreserved: this branch must not reuse the UNRESERVED message below, which asserts the fold was computed and held no reservation. Severity is block, matching this guard's own indeterminate-ROOT branch above and for the same reason: halt-and-report maps to continue:true (lib/instruct-and-wait.js), so on a mutation fence it is no refusal and the Write would land — the precise clobber MUST-NOT-2 exists to prevent, since a sibling's reservation may be sitting in the log we could not read. The signal is distinct from the unreserved case one layer down: that one is registry-level, held BELOW block by hook-output-discipline.md MUST-2; this one is a filesystem/process-state failure (EACCES/EISDIR/EIO), the structural class MUST-2 accepts.",
      agent_must_report: [
        `Target path: ${wp.rel}`,
        `Slot: ${wp.slot} in ${wp.dir} — reservation state UNKNOWN`,
        `Why the check could not answer: ${readIndeterminate}`,
        "State explicitly that the slot's reservation is UNKNOWN — NOT that the slot is free. A sibling operator may hold it.",
        rosterFailure
          ? `Remediation: the ROSTER is the unreadable fold input (${rosterFailure.code} at ${rosterFailure.path}) — a roster the fold cannot read resolves NO signer, so every record drops out and the log reads empty. Restore it (e.g. \`git show HEAD:.claude/operators.roster.json\`), then retry. This is the same disposition the reservation allocator takes (journal-reserve.js::_foldHighWater refuses on these bytes).`
          : "Remediation: make .claude/learning/coordination-log.jsonl readable (check permissions, and that it is a regular file), then retry.",
      ],
      agent_must_wait:
        "Do not retry the Write until the coordination log is readable and the reservation can actually be verified.",
      user_summary: `journal-write-guard — coordination log UNREADABLE; slot ${wp.slot} INDETERMINATE (not a clean result)`,
    });
  }

  // (2c) A ROSTER THAT PARSES BUT RESOLVES NOBODY IS THE SAME COLLAPSE AS AN
  // UNREADABLE ONE, reached more cheaply. `null`, `{}`, `{"persons":null}` and
  // `{"persons":{}}` all parse — so `loadFoldRoster` returns ok:true — and each
  // then resolves NO signer, so every record is rejected at rule-1 and the fold
  // reads exactly like a repo where nothing was ever reserved. Writing `{}` over
  // the roster is the cheapest way to defeat the fence the loud corrupt-bytes
  // refusal above closes, and `multi-operator-coordination.md` puts a
  // write-capable team member seeking sabotage squarely inside the threat model.
  //
  // Asked DIRECTLY, not by proxy: did a `journal-slot-reservation` for THIS dir
  // drop out of the fold for a ROSTER reason? Same question, same scope and the
  // same shared classifier `journal-reserve.js::_foldHighWater` uses, so the
  // allocator and this guard cannot disagree about which losses count.
  //
  // GATED ON THE ROSTER BEING PRESENT, which is load-bearing: with NO roster
  // file, rule-1 rejects every record for want of a roster to check against, and
  // that is the NORMAL state of a solo un-enrolled repo, not evidence of a loss.
  // (Unreachable in practice — the governance gate above already passed those
  // repos through — but stated because the gate's predicate may move again.)
  //
  // THE ROSTER IS HANDED TO THE CLASSIFIER, not the fold mode. rule-1
  // conflates "the roster does not resolve the signer" with "the signature does
  // not verify" whenever verification runs, and the mode cannot disambiguate
  // it: an erased roster FLIPS coordination ON (measured — `{"persons":{}}`
  // moves `coordination-mode.js` to `implicit-roster-genesis`), so keying on
  // the mode misses exactly the input this branch exists for. Asking the roster
  // directly is mode-independent: a well-rostered record rejected at rule-1 was
  // rejected for its SIGNATURE — a forgery the fold correctly refused — and
  // UNRESERVED stays the right verdict for it (the C8 fixture pins that).
  if (rosterPresent) {
    const lost = rejected.filter((entry) => {
      if (!isRosterCausedRejection(entry, { roster: foldRoster })) {
        return false;
      }
      const rec = entry.record;
      if (!rec || rec.type !== "journal-slot-reservation") return false;
      return ((rec.content || {}).dir || null) === wp.dir;
    });
    if (lost.length > 0) {
      const first = lost[0];
      return emit({
        escalate: "security",
        hookEvent,
        severity: "block",
        what_happened: `Write to journal slot ${wp.slot} in ${wp.dir}, but ${lost.length} journal-slot reservation record(s) for "${wp.dir}" were dropped by the fold for a ROSTER reason (first: ${first.reason || first.rule || "unknown rule"}).`,
        why: "multi-operator-coc/journal-write-guard MUST-NOT-2 — a roster that no longer resolves the signers who reserved slots makes their reservations invisible to this fold, so the slot state is UNKNOWN, not unreserved. This branch must not fall through to the UNRESERVED message below: that one asserts the fold was computed and held no reservation, and it is halt-and-report, i.e. continue:true, so the Write would land on top of whatever those lost records reserved. Severity block, matching the unreadable-log branch above and the reservation allocator's own refusal on these inputs (journal-reserve.js::_foldHighWater), which is what stops the allocator and this guard disagreeing about the same bytes.",
        agent_must_report: [
          `Target path: ${wp.rel}`,
          `Slot: ${wp.slot} in ${wp.dir} — reservation state UNKNOWN (records were dropped)`,
          `First dropped record: rule ${first.rule || "?"} — ${first.reason || "no reason given"}`,
          "State explicitly that the slot's reservation is UNKNOWN — NOT that the slot is free.",
          first.rule === "rule-4"
            ? "Remediation: the roster resolves the signer's key but binds it to a DIFFERENT person_id than the records claim — reconcile the persons-map key with the emitted records (a persons-map key is declared immutable by the roster schema)."
            : "Remediation: the roster does not resolve the signer(s) that reserved these slots — restore it (e.g. `git show HEAD:.claude/operators.roster.json`) before writing.",
        ],
        agent_must_wait:
          "Do not retry the Write until the roster resolves the reserving signers and the reservation can actually be verified.",
        user_summary: `journal-write-guard — roster drops ${lost.length} reservation record(s) for ${wp.dir}; slot ${wp.slot} INDETERMINATE (not a clean result)`,
      });
    }
  }

  // AUTHOR BACKING IS COMPUTED HERE, ABOVE THE RESERVATION BRANCHES, AND
  // CARRIED INTO WHICHEVER ONE FIRES. It used to sit inside the self-reserved
  // branch, below two emit() calls that never return — so an entry claiming
  // `author: human` in an unreserved slot, or in a slot a sibling reserved, was
  // never author-checked at all. Collect the findings, emit ONCE.
  const authorFinding = resolveAuthorFinding(payload, repoDir);
  const authorLines = authorFinding
    ? ["", "ALSO:", ...authorFinding.lines]
    : [];
  const authorTail = authorFinding ? ` | ${authorFinding.summary}` : "";

  const reservation = findSlotReservation(accepted, wp.dir, wp.slot);

  if (!reservation) {
    // (2a) Slot UNRESERVED — halt-and-report. Registry-level signal,
    // not structural per hook-output-discipline.md MUST-2.
    return emit({
      escalate: "security",
      hookEvent,
      severity: "halt-and-report",
      what_happened: `Journal slot ${wp.slot} in ${wp.dir} is not reserved in the coordination log.`,
      why: "multi-operator-coc/journal-write-guard MUST-NOT-2 — under N concurrent operators, or one operator's concurrent worktrees, a naive slot pick silently clobbers (architecture v11 §5.2): the disk high-water sees only the tree it runs in. Reserve via /journal new <TYPE> <topic> (M6 D writes the signed `journal-slot-reservation` record) before writing. Registry-record signal, not structural: hook-output-discipline.md MUST-2 — severity=halt-and-report, not block.",
      agent_must_report: [
        `Target path: ${wp.rel}`,
        `Slot: ${wp.slot} (UNRESERVED in fold)`,
        "Run /journal new <TYPE> <topic> (or reserveJournalSlot(dir) directly) to append a signed journal-slot-reservation record BEFORE writing the entry.",
        "If the slot was JUST reserved by this session and the log is stale, run a log fetch (the heartbeat hook does this on stop) and retry.",
        ...authorLines,
        ...shapeLines,
      ],
      agent_must_wait:
        "Do not retry the Write until the reservation lands in the folded coordination log.",
      user_summary: `journal-write-guard — slot ${wp.slot} unreserved in ${wp.dir}${authorTail}${shapeTail}`,
    });
  }

  // (2b) Slot RESERVED. Discriminate self vs sibling.
  if (reservation.verified_id === selfVerifiedId) {
    // Self-reserved → the writer IS authorized for the SLOT. The F101-3
    // author-backing verdict was computed above (so it also reaches the
    // unreserved and sibling branches); here it is the ONLY remaining finding.
    if (authorFinding) {
      // REGISTRY-class (reads ledger + matches frontmatter), NEVER block —
      // an empty ledger is ambiguous (degraded capture vs false claim) per
      // hook-output-discipline.md MUST-2. halt-and-report; the user
      // adjudicates whether the claim stands. An UNPARSEABLE frontmatter is
      // the same tier: the check did not run, which is a finding, not a pass.
      return emit({
        escalate: "security",
        hookEvent,
        severity: "halt-and-report",
        what_happened:
          authorFinding.status === "unparseable"
            ? `Journal author claim could NOT be checked: the entry's frontmatter is unparseable (${wp.rel}).`
            : `Journal author claim '${authorFinding.author}' is ${authorFinding.status.toUpperCase()} against the live session provenance ledger.`,
        why: "journal-author-discipline/MUST-1 — an author:human|co-authored claim is valid ONLY when backed by ≥1 session HumanInput provenance event (F101-3, #411). Author claims are verifiable, not trusted: the check reads the LIVE per-session ledger, NEVER the frontmatter's own assertion. A frontmatter the parser cannot read is reported rather than skipped: a check that never RAN is not a check that PASSED (rules/instrument-discipline.md MUST-1). Registry-record signal (reads a ledger file + matches frontmatter), not structural: hook-output-discipline.md MUST-2 — severity=halt-and-report, NEVER block (an empty/absent ledger is ambiguous degraded-capture, not an irrefutable false claim).",
        agent_must_report: [
          `Target path: ${wp.rel}`,
          ...authorFinding.lines,
          ...shapeLines,
        ],
        agent_must_wait:
          "Do not retry the Write until the author classification is reconciled with the user or corrected to author:agent.",
        user_summary: `journal-author-discipline — ${authorFinding.summary} (${wp.rel})${shapeTail}`,
      });
    }
    // Self-reserved + (backed | n/a-agent | no author frontmatter) → the
    // SLOT and AUTHOR layers are both satisfied, so the shape layer is the
    // only one left that can have anything to say.
    return shapeAdvisoryOrPassthrough();
  }

  // Sibling-reserved → halt-and-report. Same registry-class signal as
  // slot-unreserved — judgment-bearing, not structural.
  const siblingDisplay =
    reservation.display_id || reservation.person_id || "unknown";
  return emit({
    escalate: "security",
    hookEvent,
    severity: "halt-and-report",
    what_happened: `Journal slot ${wp.slot} in ${wp.dir} is reserved by sibling operator ${siblingDisplay}.`,
    why: "multi-operator-coc/journal-write-guard MUST-NOT-3 — a slot reserved by another operator IS a slot another operator intends to write to. Concurrent writes silently clobber (architecture v11 §5.2). Coordinate handoff before writing. Registry-record signal: hook-output-discipline.md MUST-2 — severity=halt-and-report.",
    agent_must_report: [
      `Target path: ${wp.rel}`,
      `Slot: ${wp.slot}`,
      `Reserved by: sibling operator ${siblingDisplay} (verified_id ${reservation.verified_id.slice(0, 24)}...)`,
      "Acquire a different slot via /journal new <TYPE> <topic> (the writer will allocate the next available NNNN) and write the entry there.",
      "If handoff is genuinely required, coordinate with the sibling operator (the slot is theirs by reservation precedence).",
      ...authorLines,
      ...shapeLines,
    ],
    agent_must_wait:
      "Do not retry the Write against this slot. Acquire a different slot or coordinate handoff with the sibling reserver.",
    user_summary: `journal-write-guard — slot ${wp.slot} reserved by sibling ${siblingDisplay}${authorTail}${shapeTail}`,
  });
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Built by the fail-closed runner:
// it reads the payload, bounds the run, and refuses on a crash, a hang or an
// unreadable payload. AN ERRORED CHECK IS NOT A CLEAN CHECK: an internal exception
// anywhere above (COC_TEST_JOURNAL_GUARD_INTERNAL_ERROR drives one) reaches the
// runner and REFUSES naming this guard — it once rendered as halt-and-report, i.e.
// continue:true, so a guard that threw still let the write land. The check deadline is
// CHECK_RESERVE_MS inside this budget (checkBudgetOf), so the guard's own named budget
// refusal (notCompleted) wins wherever it can fire.
const hookMain = runGuard("journal-write-guard", main, { budgetMs: BUDGET_MS });

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
