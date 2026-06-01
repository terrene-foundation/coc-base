#!/usr/bin/env node
/**
 * Hook: fold-amendment-paired-with-helper
 * Event: PostToolUse(Bash) — fires after every `git commit` (and other
 *        Bash invocations the validator filters out below).
 * Severity: halt-and-report (per hook-output-discipline.md MUST-1+2 —
 *        structural git-diff inspection, NOT lexical regex on prose).
 *
 * Purpose: Enforce multi-operator-coordination.md MUST-7 acceptance
 * criterion (6) — the F86 helper (genesis-ceremony.js::performMigration)
 * and the F86 fold predicate amendment (fold-rule-9c.js MUST-7 N=1
 * branch) MUST land in the SAME COMMIT. Splitting them across commits
 * produces either:
 *
 *   (a) a helper that emits N=1 records the fold predicate still
 *       rejects (R6-S-04), OR
 *   (b) a fold predicate that accepts N=1 records no helper can
 *       generate (no caller surface).
 *
 * Either failure mode breaks the substrate's invariant; the rule body's
 * mechanical sweep query catches it only AFTER merge. This hook catches
 * it at commit-time so the operator can fix-immediately per agents.md
 * MUST Rule 4 (same-class gap within shard budget).
 *
 * Detection logic (structural — NOT lexical regex on prose):
 *
 *   1. Read the just-landed commit's name-only diff:
 *        git diff HEAD~1..HEAD --name-only
 *   2. Detect F86-touch on each surface (the DISPATCH-CONTRACT symbols,
 *      not the bare function name — F88 refinement):
 *        - genesis-ceremony.js: contains `co_sign_anchor_kind` or
 *          `CO_SIGN_ANCHOR_KIND_ORG_ADMIN` or `gh_api_org_membership_capture`
 *          in the diff text (added/removed lines)
 *        - fold-rule-9c.js: contains `CO_SIGN_ANCHOR_KIND_ORG_ADMIN`,
 *          `isN1OrgAdminPath`, `MUST-7 N=1`, `co_sign_anchor_kind`, or
 *          `gh_api_org_membership_capture` in the diff text
 *   3. If EITHER surface has F86-touch AND the other does NOT have any
 *      touch (file absent from name-only diff) → halt-and-report.
 *   4. Otherwise pass (no F86 dispatch-contract work in this commit, OR both
 *      surfaces moved together, OR the touch is a non-dispatch maintenance
 *      edit to the helper, e.g. the F88 seq/prev_hash chain-continuation fix).
 *
 * The detection is symbol-grep on the DIFF text (the patch), not on the
 * full file — so a pre-existing dispatch-contract reference in a comment
 * does not false-positive; only added or removed lines count (the diff
 * format prefixes those with `+` / `-`). F88 narrowed the helper trigger
 * from the bare `performMigration` name to the dispatch-contract surface so
 * routine helper maintenance no longer false-positive-halts (journal/0172).
 *
 * Carve-outs:
 *
 *   - The commit landing F86 itself: the hook is being authored AS the
 *     F86 paired commit, so it cannot have fired on F86's own commit
 *     (the hook file doesn't exist until the same wave that introduces
 *     the helper + fold amendment). This is the bootstrap-circularity
 *     carve-out per self-referential-codify.md Rule 3 — one-time-per-rule.
 *   - Commits whose only change to the F86 files is whitespace /
 *     formatting (auto-format hook): the symbol-grep on diff text will
 *     not flag a pure whitespace change because no `+performMigration`
 *     or `+CO_SIGN_ANCHOR_KIND_ORG_ADMIN` line appears.
 *   - Merge commits + revert commits: HEAD~1 may not exist or may
 *     produce a multi-parent diff that returns no name-only output.
 *     The hook degrades to pass-through silently (advisory hooks
 *     must never block legitimate workflows on a tooling edge case).
 *
 * Origin: F86 (multi-operator-coordination.md MUST-7) per journal/0170
 * § Cycle-3 disposition table + journal/0169 § For-Discussion #1.
 */

"use strict";

const path = require("path");
const { execFileSync } = require("child_process");
const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));

const HOOK_EVENT = "PostToolUse";
const RULE_ID = "multi-operator-coordination/MUST-7-paired-landing";
const TIMEOUT_MS = 5000;

// Hard timeout fallback per cc-artifacts.md Rule 7. The hook MUST exit
// within TIMEOUT_MS even when a subprocess hangs (gh hung, git lock).
const _timeoutHandle = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);
_timeoutHandle.unref?.();

// Surface paths the hook gates on. Repo-relative — the hook resolves
// them against process.cwd() (the main checkout per
// trust-posture.md MUST-1 routing; worktree paths are filtered by the
// detector via the path comparison).
const HELPER_PATH = ".claude/hooks/lib/genesis-ceremony.js";
const FOLD_PATH = ".claude/hooks/lib/fold-rule-9c.js";

// F86-specific symbol grep against the patch text. The hook detects
// F86-touch via PRESENCE OF THE SYMBOLS in the added/removed lines,
// not by file presence alone (so a comment-only edit to genesis-ceremony
// that does not change the dispatch contract does NOT trigger the gate).
//
// F88 refinement: the helper-side trigger is the DISPATCH-CONTRACT surface
// — the discriminator (`co_sign_anchor_kind` / `CO_SIGN_ANCHOR_KIND_ORG_ADMIN`)
// and the org-admin capture shape (`gh_api_org_membership_capture`) — NOT the
// bare `performMigration` function name. The pairing contract MUST-7 (6)
// protects is: if the helper changes HOW it stamps the discriminator/capture
// the fold dispatches on, the fold predicate MUST change in lockstep (and
// vice versa). A non-dispatch maintenance edit to performMigration (e.g. the
// F88 seq/prev_hash chain-continuation fix, capture-step reordering, error
// taxonomy) does NOT touch the helper⇔fold contract and MUST NOT be forced to
// carry a fold amendment. Grepping the bare function name false-positive-halted
// every such edit. See journal/0172 (F88) For-Discussion #3.
// F88 R2 / reviewer LOW-1: the re-anchor coupling (`gh_api_root_commit_capture`
// + `pre_correction_root_commit`) is a SECOND dispatch-contract surface the
// helper emits (genesis-ceremony.js) and the fold predicate validates DIRECTLY
// (fold-rule-9c.js — not via the shared gh-api-allowlist SSOT, unlike the
// org/owner captures). So a future helper-side edit that changes how it stamps
// these fields without a paired fold change WOULD weaken the contract silently.
// Both fields are added to BOTH symbol sets so that coupling is gate-covered
// symmetrically (answers journal/0172 For-Discussion #3).
const HELPER_F86_SYMBOLS = [
  "CO_SIGN_ANCHOR_KIND_ORG_ADMIN",
  "co_sign_anchor_kind",
  "gh_api_org_membership_capture",
  "gh_api_root_commit_capture",
  "pre_correction_root_commit",
];
const FOLD_F86_SYMBOLS = [
  "CO_SIGN_ANCHOR_KIND_ORG_ADMIN",
  "isN1OrgAdminPath",
  "MUST-7 N=1",
  "co_sign_anchor_kind",
  "gh_api_org_membership_capture",
  "gh_api_root_commit_capture",
  "pre_correction_root_commit",
];

function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2000,
    });
  } catch (err) {
    return null;
  }
}

function readPayload() {
  // CC delivers the hook payload on stdin as JSON. The hook MUST
  // tolerate empty / malformed stdin (silent pass-through) per
  // hook-output-discipline.md MUST-1's pass-on-edge-case principle.
  try {
    const chunks = [];
    let buf = process.stdin.read();
    while (buf !== null) {
      chunks.push(buf);
      buf = process.stdin.read();
    }
    const raw = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(
      "utf8",
    );
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function isGitCommit(payload) {
  // The hook only acts on `git commit` invocations. Other Bash commands
  // (pytest, gh issue, etc.) pass through without any subprocess work.
  const cmd =
    payload &&
    payload.tool_input &&
    typeof payload.tool_input.command === "string"
      ? payload.tool_input.command.trim()
      : "";
  if (!cmd) return false;
  // Match: `git commit ...`, `git commit -m ...`, `git -c X commit ...`,
  // `cd foo && git commit ...`, etc. Use a structural grep rather than
  // strict prefix so chained / env-prefixed forms still trigger.
  if (!/\bgit\b/.test(cmd)) return false;
  if (!/\bcommit\b/.test(cmd)) return false;
  return true;
}

function commitHasParent() {
  // HEAD~1 must exist; if HEAD is a root commit, the diff is undefined.
  // git rev-parse --verify is the standard existence probe.
  const r = git(["rev-parse", "--verify", "HEAD~1"]);
  return r !== null;
}

function getNameOnlyDiff() {
  const r = git(["diff", "HEAD~1..HEAD", "--name-only"]);
  if (r === null) return null;
  return r
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function getFileDiffText(filePath) {
  // Return the unified diff for a single path. The hook greps only
  // added/removed lines (`+` / `-` prefixes), not context lines, so a
  // contextual symbol mention does NOT false-positive.
  const r = git(["diff", "HEAD~1..HEAD", "--", filePath]);
  if (r === null) return "";
  return r;
}

function diffContainsAddedOrRemovedSymbol(diffText, symbol) {
  // Iterate lines: `+performMigration(` (added) OR `-performMigration(`
  // (removed) → F86 touch. Context lines (` ` prefix) ignored.
  if (!diffText) return false;
  const lines = diffText.split("\n");
  for (const line of lines) {
    if (line.length === 0) continue;
    const prefix = line[0];
    if (prefix !== "+" && prefix !== "-") continue;
    // Skip the `+++ filename` / `--- filename` headers.
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.includes(symbol)) return true;
  }
  return false;
}

function anySymbolMatches(diffText, symbols) {
  for (const s of symbols) {
    if (diffContainsAddedOrRemovedSymbol(diffText, s)) return true;
  }
  return false;
}

function emitHalt({ helperTouched, foldTouched, helperHasF86, foldHasF86 }) {
  const whichTouched = helperHasF86 ? "helper" : "fold-predicate";
  const whichMissing = helperHasF86 ? "fold-predicate" : "helper";
  const missingPath = helperHasF86 ? FOLD_PATH : HELPER_PATH;
  emit({
    hookEvent: HOOK_EVENT,
    severity: "halt-and-report",
    what_happened: `F86 ${whichTouched} change (touching MUST-7 N=1 symbols) landed without the paired ${whichMissing} change in the same commit.`,
    why: `${RULE_ID} — multi-operator-coordination.md MUST-7 acceptance criterion (6) requires the F86 helper (genesis-ceremony.js::performMigration) and the F86 fold predicate amendment (fold-rule-9c.js MUST-7 N=1 branch) to land in the SAME COMMIT. Splitting them produces either a helper that emits records the fold rejects, or a fold predicate that accepts records no helper can generate — both break the substrate invariant.`,
    agent_must_report: [
      `Quote the just-landed commit SHA and the diff that touched the F86 surface (helperTouched=${helperTouched}, foldTouched=${foldTouched}).`,
      `State which side of the pair is missing: ${missingPath}.`,
      `Propose remediation in this turn: amend the just-landed commit (git commit --amend) OR add a fix-up commit landing the paired change in the same PR — do NOT file a follow-up issue (agents.md MUST Rule 4: same-class gap within shard budget MUST be fixed in-session).`,
    ],
    agent_must_wait:
      "Do not push the PR until the paired change lands. The user MAY override by responding 'this is intentional, not an F86 pairing'.",
    user_summary: `${RULE_ID} — F86 paired-landing missing for ${missingPath}`,
  });
}

function main() {
  const payload = readPayload();
  if (!payload || !isGitCommit(payload)) {
    // Not a git commit (or stdin empty / malformed) — silent pass.
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    clearTimeout(_timeoutHandle);
    process.exit(0);
  }
  if (!commitHasParent()) {
    // Root commit — no diff to inspect. Pass.
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    clearTimeout(_timeoutHandle);
    process.exit(0);
  }
  const changed = getNameOnlyDiff();
  if (changed === null) {
    // git diff failed (worktree corruption, merge commit edge case) —
    // advisory hooks degrade to pass per hook-output-discipline.md
    // MUST-1's pass-on-edge-case principle.
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    clearTimeout(_timeoutHandle);
    process.exit(0);
  }
  const helperTouched = changed.includes(HELPER_PATH);
  const foldTouched = changed.includes(FOLD_PATH);
  if (!helperTouched && !foldTouched) {
    // Neither file touched — not F86 territory. Pass.
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    clearTimeout(_timeoutHandle);
    process.exit(0);
  }
  // Determine whether the touch is F86-specific. A 2-of-N path tweak
  // (e.g. naming a different error or fixing a typo in the existing
  // co_signers loop) does NOT require the helper. The symbol grep
  // distinguishes.
  const helperDiff = helperTouched ? getFileDiffText(HELPER_PATH) : "";
  const foldDiff = foldTouched ? getFileDiffText(FOLD_PATH) : "";
  const helperHasF86 = anySymbolMatches(helperDiff, HELPER_F86_SYMBOLS);
  const foldHasF86 = anySymbolMatches(foldDiff, FOLD_F86_SYMBOLS);
  if (!helperHasF86 && !foldHasF86) {
    // Both files touched but neither contains F86-specific symbols.
    // Could be a 2-of-N path adjacent edit on both files — still both
    // moved together; not a pairing violation.
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    clearTimeout(_timeoutHandle);
    process.exit(0);
  }
  if (helperHasF86 && !foldTouched) {
    emitHalt({ helperTouched, foldTouched, helperHasF86, foldHasF86 });
    // emit() exits — unreachable.
  }
  if (foldHasF86 && !helperTouched) {
    emitHalt({ helperTouched, foldTouched, helperHasF86, foldHasF86 });
    // emit() exits — unreachable.
  }
  // Both surfaces moved together (or at least both files appear in the
  // diff). Pass.
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  clearTimeout(_timeoutHandle);
  process.exit(0);
}

// Run main only when invoked directly as a hook (require.main === module).
// When required by a test, skip main and expose the pure detection helpers +
// symbol sets so the F88 dispatch-contract refinement is regression-locked
// per cc-artifacts.md Rule 9 + hook-output-discipline.md MUST-4.
if (require.main === module) {
  main();
} else {
  clearTimeout(_timeoutHandle);
}

module.exports = {
  HELPER_F86_SYMBOLS,
  FOLD_F86_SYMBOLS,
  HELPER_PATH,
  FOLD_PATH,
  diffContainsAddedOrRemovedSymbol,
  anySymbolMatches,
  isGitCommit,
};
