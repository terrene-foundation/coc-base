/**
 * lib/unlanded-work-surface.js
 *
 * Unlanded-work session-start surface. Sibling of `open-pr-surface.js`, which
 * answers "what is ON the board?"; this answers the complementary question
 * "what never GOT to the board?" — local branches carrying commits that are not
 * on the upstream default branch and have no open PR.
 *
 * Design contract — the seven properties that make this shippable fleet-wide:
 *
 *   1. FAIL-OPEN / TRI-STATE. Never blocks, never hangs, never throws. A repo
 *      with no remote skips SILENTLY; a git/gh failure reports UNDETERMINED and
 *      is NEVER rendered as a clean board. (`hook-output-discipline.md` MUST-2,
 *      `evidence-first-claims.md` MUST-3.)
 *
 *   2. COUNT IS NEVER SUPPRESSED. Name-prefix conventions (backup/, parked/,
 *      salvage/, worktree-agent-*) demote a branch out of the rendered LIST, but
 *      every branch is still counted in the TOTAL. Suppression can therefore
 *      never hide magnitude — the failure mode a suppression list would
 *      otherwise reintroduce. See § Suppression below.
 *
 *   3. NO STORED "LAST SEEN" STATE. Recency is derived from commit timestamps
 *      against the wall clock, so there is no ledger, pointer, or last-seen file
 *      that can itself be forgotten — the failure this surface exists to catch.
 *      See § Why age buckets, not a session delta.
 *
 *   4. THE BASE IS THE INTEGRATION TRUNK. It is resolved by the ONE shared
 *      resolver (`trunk-ref.js::resolveTrunk`, `wip-discipline.md` MUST-4):
 *      `origin/dev` where it exists. Where no trunk exists, the pre-existing
 *      read decides — origin/HEAD, then main/master/develop, then
 *      upstream/HEAD, in ONE git call — so nothing assumes loom's branch
 *      naming, a wave shape, or that `main` exists. See § The trunk.
 *
 *   5. THE HEADLINE COUNT IS CONTENT, NOT ANCESTRY. `--no-merged` answers "is
 *      this commit OBJECT on the base", which is not the question. A branch
 *      replayed onto the base by rebase or cherry-pick, and a branch whose only
 *      non-base commits are merges, are both LANDED and both read UNLANDED
 *      under ancestry. The headline is therefore computed by PATCH-ID
 *      equivalence and the ancestry-only remainder is reported in its own
 *      bucket. See § Content equivalence.
 *
 *   6. THE UNRECOVERABLE CLASS IS NAMED SEPARATELY. A branch that is content-
 *      unlanded AND exists on no remote lives in exactly one clone; its loss is
 *      destruction, not re-work, and it is the only row for which the "delete"
 *      disposition is irreversible. Detected by remote-ref EXISTENCE, never by
 *      `%(upstream)` alone — see `getRemoteBranchNames` for the measured 21%
 *      over-report of the cheap form. Tri-state: an unreadable remote list
 *      renders "push state UNKNOWN", never a reassuring zero.
 *
 *   7. RECENCY AND UNLANDEDNESS ARE SEPARATE AXES, AND THE RATCHET LIVES IN THE
 *      INTERSECTION. The age floor in `computeUnlandedSummary` suppresses a
 *      branch touched within RECENT_DAYS. It is sound for its population and
 *      is KEPT — but on its own it collapses two independent axes onto one, and
 *      the cell it then suppresses (actively written AND still carrying old
 *      unlanded work) is exactly the ratchet. `computeCarrySpans` restores the
 *      second axis: see § The ratchet axis.
 *
 *   8. RECORDED PROVENANCE DECIDES FIRST; CONTENT ONLY FOR WHAT PREDATES IT.
 *      Where the repo records landings (`.claude/bin/landing-provenance.json`),
 *      "is this branch landed?" is answered by the `Landed-From` /
 *      `Landed-Partial` trailers written AT LANDING TIME, through the ONE
 *      consumer policy `landed-map.js::landedVerdicts`
 *      (`.claude/hooks/lib/landed-map.js::landedVerdict`, `::landedVerdicts`). The content comparison below
 *      runs ONLY for a branch that verdict hands back as `fallback: true` —
 *      forked before recording began, or ancestry-only. A config whose map
 *      cannot be built makes every branch UNMEASURED, never content-decided.
 *      See § Landing provenance.
 *
 * § Landing provenance — why content is no longer the first instrument
 * --------------------------------------------------------------------
 * Landing rewrites commits (rebase, squash, conflict fix, reformat), so a
 * landed branch's work sits on the trunk under NEW ids, and after the fact no
 * comparison can recover a link nobody wrote down: a conflict-resolved landing
 * has a patch-id equal to NEITHER source commit, so § Content equivalence
 * reads it UNLANDED, and a plain cherry-pick of work that was never landed
 * through the recording path reads LANDED. Both errors are fixed at the source
 * by recording the link when the work lands; this surface now READS that
 * record. Per branch, `landedVerdicts` returns exactly one of:
 *
 *   decided:true               the trailers answer it. `landed` is used as-is
 *                              and NO content comparison runs for that branch —
 *                              a patch present on the trunk without a trailer
 *                              does not make a post-cutover branch landed.
 *   decided:false fallback:true the branch predates recording (forked strictly
 *                              before the cutover) or is ancestry-only: the
 *                              legacy content pass decides.
 *   decided:false fallback:false UNMEASURED — including EVERY branch when the
 *                              config exists but no map could be built
 *                              (`no-map`). Counted in the headline as unlanded
 *                              and rendered as unmeasured — NEVER removed as
 *                              landed, never handed to content.
 *
 * The map is built ONCE per invocation against the SAME base ref the rest of
 * this surface measures against, and every rendered row names the instrument
 * that decided it. A repo WITHOUT the config (every consumer today) gets the
 * pre-existing behaviour and output byte-for-byte: `buildLandedMap` answers
 * `noConfig` (`.claude/hooks/lib/landed-map.js::loadConfig`, `::buildLandedMap`) and this
 * surface then takes none of the new paths.
 *
 * The ancestry-merged reap half is NOT re-asked: a branch whose tip is already
 * reachable from the base has no own commits, for which `classifyBranch`
 * returns only `ancestry` (`.claude/hooks/lib/landed-map.js::classifyBranch`) — a
 * fallback that hands the answer straight back to the ancestry read — so the
 * verdict could not change it and would cost a spawn per branch to say so.
 *
 * § Content equivalence — what it sees, and what it does NOT
 * ----------------------------------------------------------
 * The refinement compares PATCH-IDs (`git patch-id --stable` over each
 * non-merge commit's diff — the same primitive `git cherry` uses) between the
 * branch side and a bounded window of the base side. A branch is CONTENT-LANDED
 * iff every non-merge commit reachable from its tip, and not reachable from the
 * base, has a patch-id twin inside that window.
 *
 * MEASURED on loom 2026-08-21 against the real 102-branch ancestry set: 13
 * branches (12.7%) hold nothing new by content — 9 with every commit matched, 4
 * whose only non-base commits are merges. The bulk classifier below and a
 * per-branch `git cherry` loop returned the IDENTICAL 13-branch set, which is
 * the cross-check that makes the bulk form citable.
 *
 * It does NOT see four things, and the rendered block says so rather than
 * implying a content green means "no work is missing":
 *
 *   (a) MULTI-COMMIT SQUASH. A 2-commit branch squash-merged into the base
 *       becomes ONE base commit whose patch-id equals NEITHER original.
 *       MEASURED on a known-answer fixture: single-commit squash → detected
 *       (`-`); two-commit squash → NOT detected (`+ +`). `git cherry` has the
 *       same blind spot; this is a property of patch-id, not of the bulk form.
 *   (b) A DEFECT FIXED BY A DIFFERENT MECHANISM. The original commit is then
 *       genuinely absent AND genuinely unnecessary. No content test can settle
 *       this — only re-running the defect can. Whether the DEFECT reproduces
 *       outranks whether the COMMIT is present (loom#1775).
 *   (c) DUPLICATES OLDER THAN THE BASE WINDOW. The base side is capped at
 *       MAX_BASE_SCAN commits so the pass stays inside a session-start budget.
 *       MEASURED at loom: a 250-commit window found 9 of the 13, 500 found 10,
 *       1000 and above found all 13. The cap is DISCLOSED in the output
 *       whenever it binds, so a shortfall is visible rather than silent.
 *   (d) ANYTHING, when the pass could not run. Budget exhaustion, a git
 *       failure, or `COC_UNLANDED_CONTENT_CHECK=0` degrade to `contentKnown:
 *       false`, which renders the ancestry figure as an explicit UPPER BOUND —
 *       never as a verified content total.
 *
 * REJECTED, with evidence: computing patch-ids at `-U0` to halve the pass cost.
 * MEASURED on the same 102 branches, it returned 17 content-landed against the
 * true 13 — four FALSE-LANDED verdicts, because without context lines two
 * distinct edits to one file hash alike. That error is in the direction that
 * HIDES work, so the latency was paid instead.
 *
 * § Why age buckets, not a session delta
 * --------------------------------------
 * A "N new since last session" delta needs a stored last-seen pointer, which is
 * exactly the forgettable ledger this surface replaces. It is also the wrong
 * decomposition: the thing that makes work forgotten is AGE, not novelty. A
 * branch first seen today is the LEAST forgotten thing on the list; a 40-day-old
 * branch is the most. Age buckets are strictly more informative than a delta,
 * and they need no state at all.
 *
 * Insensitivity at scale — the reason a delta looks necessary — is a property of
 * rendering a truncated LIST, not of absolute reporting. A bare list of 10 reads
 * identically at 49 branches and 490. A TOTAL plus an age histogram does not:
 * 490 renders as 490, and the histogram shifts as the backlog ages. So the
 * sensitivity requirement is met without importing the state requirement.
 *
 * § The ratchet axis (loom#1912)
 * ------------------------------
 * MEASURED failure: `codify/<operator>-2026-08-20` accumulated 33 unlanded commits
 * across at least three session starts with this surface live, and was listed
 * ZERO times. Written to daily, its `ageDays` never left 0, so the age floor
 * folded it into `inFlightCount` and rendered it as "work in flight, not
 * forgotten". The surface hid it HARDER the more actively it ratcheted — the
 * output was byte-identical for a healthy branch and for a three-day ratchet,
 * which is `instrument-discipline.md` MUST-1 at the surface level.
 *
 * The second axis is CARRY SPAN: `lastCommit(committerdate) − oldestUnlanded
 * (authordate)`, i.e. how long this branch has been carrying work that never
 * landed. A branch touched today whose oldest unlanded commit is a day older is
 * a ratchet; one whose unlanded work is all a few hours old is in flight.
 *
 * WHY SPAN AND NOT "AGE OF THE OLDEST UNLANDED COMMIT" (now − first), which is
 * the more obvious formulation and the one the issue proposed. MEASURED on
 * loom's real backlog, over the 58 branches the age floor currently suppresses:
 *
 *   span ≥ 1d      →  8 of 58 fire   (incl. BOTH known ratchets)
 *   now−first ≥ 1d → 52 of 58 fire
 *
 * `now − first` fires on almost the entire suppressed population, because any
 * branch whose first commit predates yesterday qualifies whether or not it is
 * still being written. Adopting it would not fix the age floor, it would DELETE
 * it — surrendering the exact noise reduction the floor buys. Span does not: it
 * is near-identical to `now − first` for a branch touched today (the region that
 * matters) and inert for one that is merely old (which axis A already handles).
 *
 * WHY THE THRESHOLD IS 1 DAY, and why it was measured rather than picked. At
 * RATCHET_SPAN_DAYS = 2 the motivating branch does NOT fire: its 33 commits
 * span 1.43 days, floor 1. A guessed "2 days feels safer" would have shipped a
 * fix that missed the defect that produced it. 1 day is also the smallest
 * meaningful unit here — floor-day arithmetic means span ≥ 1 requires a full 24h
 * of carried unlanded work, which no genuinely-in-flight branch has.
 *
 * This is NOT a threshold tweak that relocates the blind spot. Axis A is
 * defeated by a behaviour an operator actually performs (writing daily). Span
 * has no such defeat: holding span < 1d while accumulating requires that ALL
 * unlanded work be under 24h old, which IS in-flight work by definition.
 *
 * What it does NOT see, disclosed rather than implied:
 *
 *   (a) AUTHOR-DATE REWRITES. Span reads `%at`, so an ordinary `git rebase`
 *       (which preserves author dates) does not erase it — the reason author
 *       date is used rather than committer date, which a rebase resets to now
 *       and which would therefore hide the ratchet. `--reset-author`,
 *       `--ignore-date`, and `commit --amend --date=` DO erase it. That is a
 *       narrower and more deliberate act than "commit every day".
 *   (b) A FORGED-FUTURE AUTHOR DATE yields a negative span, floored at 0.
 *   (c) ANYTHING, when the pass could not run. `ratchetKnown: false` renders the
 *       in-flight line as explicitly UNCLASSIFIED — never as a verified
 *       in-flight claim. Same tri-state discipline as `contentKnown` and
 *       `localOnlyKnown`.
 *
 * § The trunk, the promotion gap, and reap candidates
 * ----------------------------------------------------
 * MEASURED failure, 2026-09-12: measured against `origin/main`, this surface
 * listed a branch that had landed on `dev` as UNLANDED, and listed `dev` ITSELF
 * as a RATCHET — the dev→main PROMOTION gap reported as forgotten lane work.
 * Three separate facts were folded into one list, and they are now separated:
 *
 *   (a) LANE WORK not on the trunk — the headline, measured against the trunk.
 *       Local `dev` appears only when it carries commits `origin/dev` lacks,
 *       which is genuinely unlanded.
 *   (b) THE PROMOTION GAP — commits on the trunk not yet on `origin/main`. They
 *       ARE landed. Rendered as one counted line, never as a list row. Local
 *       `main` is measured against `origin/main`, its own landing target: a
 *       `main` that carries only what `origin/main` carries is not lane work.
 *   (c) REAP CANDIDATES — local branches whose every commit is already on the
 *       trunk (ancestry, or a patch-id twin from the content pass). Nothing
 *       else reports a branch landed by a web-UI merge, merge queue or API
 *       merge, because the reap guard fires only on an in-session `gh pr merge`
 *       command (`.claude/hooks/reap-on-landing-guard.js::isLandingCommand`, cited by
 *       SYMBOL: a line range there rotted onto an unrelated timing comment).
 *       REPORT-ONLY: this module never deletes anything.
 *
 * A ratchet is LISTED IN ITS OWN SECTION, not merged into the age-sorted list.
 * The two carry different dispositions: an old branch may genuinely be forgotten,
 * whereas a ratchet is known-live work that needs landing or sharding. Merging
 * them would put a live branch under a heading that reads "you forgot this",
 * which is how a surface teaches operators to skip rows.
 *
 * § Suppression
 * -------------
 * Demotion is by NAME PREFIX — a policy of a few patterns, not a per-branch
 * inventory. That distinction is load-bearing: an O(N) per-branch ledger fails
 * when someone forgets to add a row (the original failure mode), whereas an O(1)
 * policy of ~6 prefixes has nothing to forget per branch. Combined with property
 * 2 (suppressed branches still count), the worst case of a stale policy is a
 * branch listed that need not be, never a branch hidden.
 *
 * @see open-pr-surface.js — the sibling surface this deliberately mirrors.
 */

// `childProcess` is kept as the MODULE OBJECT (not only destructured) so the
// content pass's `spawnSync` calls go THROUGH it and are observable to a spy in
// the test suite — that spy is how the patch-id cache's "an already-known sha
// is never re-diffed" contract is proven, rather than inferred from timing.
const childProcess = require("child_process");
const { execFileSync } = childProcess;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env");
// Both ride `hooks/lib/**`, the same distribution glob as this file, so a
// module-scope require cannot reach a consumer where either is absent.
// `promotionGap` is called THROUGH the module object (not destructured) so the
// bound this surface passes is observable to a spy in its test suite.
const trunkRefLib = require("./trunk-ref.js");
const { resolveTrunk } = trunkRefLib;
const {
  isProtectedName,
  parseWorktreeBranches,
  branchNameOfRef,
} = require("./reap-on-landing.js");
// The landing-provenance core. Called THROUGH the module object so a test can
// observe (and a mutation can prove) that the verdict is actually consulted.
const landedMapLib = require("./landed-map.js");

// Per-call latency bounds. This runs SYNCHRONOUSLY at session start in every
// consumer; execFileSync blocks the event loop, so these exec timeouts are the
// ONLY real bound (a hook-level setTimeout cannot preempt them). Both calls are
// LOCAL git — no network — so these are generous, not tight-fitting.
// `killSignal: "SIGKILL"` guarantees a wedged git is actually reaped.
const BASE_REF_TIMEOUT_MS = 1000;
const BRANCH_LIST_TIMEOUT_MS = 2000;
// The worktree list and the promotion-gap count are each ONE local read.
const WORKTREE_LIST_TIMEOUT_MS = 1000;
const PROMOTION_TIMEOUT_MS = 1000;

// The promotion target: `dev -> main` is the deliberate promotion, and
// `trunk-ref.js::promotionGap` measures against `<remote>/main` for the same reason.
const PROMOTION_TARGET = "main";

// Content-equivalence pass bounds. This pass is STRICTLY OPTIONAL: every one of
// these bounds, when hit, degrades to `contentKnown: false` (ancestry reported
// as an explicit UPPER BOUND), never to a wrong content verdict.
//
// CONTENT_BUDGET_MS is a WALL-CLOCK ceiling checked BETWEEN phases, not a per-
// exec timeout: the individual execs carry their own timeouts, and the budget
// stops the pass from starting a phase it cannot afford to finish. MEASURED at
// loom (103 unlanded branches, 422 branch-side commits, 2000-commit base
// window): 1.6 s for the pass, 2.1 s end-to-end including the branch listing.
// The ceiling is set ~2× that so an ordinarily slower machine still gets the
// refinement; a repo far larger blows it and degrades to ancestry-as-upper-
// bound, which is the designed outcome, not a failure.
const CONTENT_BUDGET_MS = 4000;
const CONTENT_EXEC_TIMEOUT_MS = 3000;

// Base-side window, in commits. MEASURED recall/cost curve at loom, against the
// 13-branch ground truth an unbounded per-branch `git cherry` loop returned:
//   250 → 9 found, 734 ms   |  1000 → 13 found, 1128 ms
//   500 → 10 found, 864 ms  |  2000 → 13 found, 1573 ms
// Recall saturates at 1000 HERE; 2000 is the shipped default because that
// saturation point is a property of loom's merge cadence, not of the algorithm,
// and the extra window is affordable. See § Content equivalence (c).
const MAX_BASE_SCAN = 2000;

// Refuse to start the pass at all beyond this many branch-side commits. Bounds
// the diff-tree work per session in a repo with a far larger backlog.
const MAX_LEFT_COMMITS = 5000;

// Buffer for the SMALL outputs the content pass reads into Node — rev-list sha
// lists and `git patch-id` lines (~82 bytes per commit). Patch TEXT is never
// buffered in Node: `git diff-tree -p` writes into a private temp file that
// `git patch-id` reads directly (see `computePatchIds`). MEASURED 2026-09-27 at
// loom: the 2000-commit base window renders ~108 MB of patch text — the earlier
// "~50 MB" figure here was stale — and buffering that in Node, then copying it
// back into a second child, cost ~3 s of CPU per session start.
const CONTENT_MAX_BUFFER = 32 * 1024 * 1024;

// ── Patch-id cache ──────────────────────────────────────────────────────────
// A commit's patch-id is a function of the commit OBJECT (its tree and its first
// parent's tree), which is immutable, so it is computed once per clone and kept
// in `<git-common-dir>/coc-patch-id-cache` — the COMMON dir, so every worktree
// of a clone shares one cache, and never under a worktree, so it cannot be
// committed. Keyed by the FULL object id; a line that does not parse as
// `<full-oid> <full-oid-or-"-">` invalidates the WHOLE file, which is then
// treated as empty (recomputed, never trusted in part).
//
// Correctness does not rest on the cache beyond what patch-id itself gives: a
// stale or foreign entry can only make two EQUIVALENT patches look different
// (e.g. a git upgrade that changes diff output), which keeps a branch in the
// headline — the over-report direction. It cannot make two DIFFERENT patches
// look equal unless the entry itself is forged, and forging requires write
// access to the git dir, which already owns `.git/hooks`.
//
// "-" records a commit that produces NO patch (an empty commit, a root commit
// under `diff-tree` without `--root`). It is written only after a COMPLETE
// diff-tree run, because a killed run cannot distinguish "no patch" from "not
// reached yet".
const PATCH_ID_CACHE_FILE = "coc-patch-id-cache";
const PATCH_ID_CACHE_HEADER = "# coc-patch-id-cache v1";
const PATCH_ID_NONE = "-";
// Bounded: least-recently-USED entries are dropped first. At ~82 bytes per
// SHA-1 entry this is ~1.6 MB; a SHA-256 clone ~2.6 MB. The window it must hold
// per session is MAX_BASE_SCAN + the branch side (≤ MAX_LEFT_COMMITS).
const PATCH_ID_CACHE_MAX_ENTRIES = 20000;
const PATCH_ID_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Rendered-list cap. As with open-pr-surface's PR_LIST_LIMIT, the cap is
// disclosed in the output ("showing the oldest 10 of 40") so a truncated list is
// never mistaken for the whole set.
const LIST_LIMIT = 10;

// Age buckets, in days. Chosen so the histogram separates "this week's work in
// flight" from "genuinely stale".
const RECENT_DAYS = 7;
const STALE_DAYS = 30;

// The ratchet threshold, in days of CARRY SPAN. MEASURED, not chosen — see
// § The ratchet axis for the 8-of-58 vs 52-of-58 selectivity comparison against
// the `now − first` formulation, and for why 2 would have missed the very branch
// that produced this rule (33 commits spanning 1.43 days).
const RATCHET_SPAN_DAYS = 1;

// Wall-clock ceiling for the carry-span pass, checked around its single spawn.
// MEASURED at loom (428 branch-side commits across 103 unlanded branches): 30–50
// ms for the `rev-list`, against the 2.1 s this surface already spends
// end-to-end. The ceiling is ~30× that, so an ordinarily slower machine still
// gets the axis; a repo far larger degrades to `ratchetKnown: false`, which is
// the designed outcome and is rendered as an explicit UNCLASSIFIED, never as a
// verified in-flight claim.
const RATCHET_BUDGET_MS = 1500;

// Wall-clock ceiling for the provenance verdicts, passed as `budgetMs` to the
// ONE bulk `landed-map.js::landedVerdicts` call (`landed-map.js::landedVerdicts`),
// which checks it before each branch (two spawns per branch with own commits,
// fork test memoised per merge-base). A branch the budget does not reach comes
// back `unknown` — UNMEASURED, counted as unlanded and rendered as such — and
// is never handed to the content pass, the instrument that misreports a
// rewritten landing.
const PROVENANCE_BUDGET_MS = 2500;
// Per-spawn bound threaded into the map build and every verdict spawn, so one
// wedged git cannot hold session start past this surface's own ceilings. Same
// magnitude as the other single local reads here (BASE_REF/WORKTREE_LIST).
const PROVENANCE_SPAWN_TIMEOUT_MS = 1000;

const MS_PER_DAY = 86400000;

/**
 * Branch-name prefixes whose branches are counted but not listed. These encode
 * DECLARED INTENT NOT TO LAND: a backup taken before a rebase, an explicitly
 * parked shard, a salvage branch, machine-generated agent scratch.
 *
 * This is a POLICY (a handful of patterns), not a per-branch ledger — see
 * § Suppression in the file header for why that distinction is the whole point.
 * Anchored at the start of the name so `feat/backup-restore-fix` is NOT demoted.
 */
const DEMOTE_PREFIXES = [
  /^backup\//i,
  /^parked\//i,
  /^salvage\//i,
  /^wip\//i,
  /^tmp\//i,
  /^_tmp/i,
  /^worktree-agent-/i,
  /-(?:pre-?rebase|prerebase)-backup$/i,
];

function isDemoted(name) {
  return DEMOTE_PREFIXES.some((re) => re.test(name));
}

/**
 * Resolve the upstream default ref in ONE git call.
 *
 * Asks for every candidate at once and takes the first that exists, in priority
 * order. `origin/HEAD` is the correct answer when set, but it is set only by
 * `git clone` and is frequently absent or stale in long-lived working clones —
 * so main/master/develop and an `upstream` fork remote follow it. Returning null
 * (rather than defaulting to "origin/main") is deliberate: a wrong base ref
 * would report every branch in the repo as unlanded, which is worse than
 * reporting nothing.
 *
 * Fail-open: any error returns null.
 *
 * The binary is RESOLVED and the env is BUILT FROM CONSTANTS (loom#1462/#1471).
 * `cwd:` picks a DIRECTORY, not a REPOSITORY — an ambient `GIT_DIR` outranks
 * discovery, so a bare spawn here would let one environment variable choose
 * which repository answers "what is the base ref", and every branch this surface
 * then reports would be that repository's. `gitEnv()` (not `gitNetEnv()`) is the
 * right profile: this is a purely LOCAL read of refs already on disk.
 *
 * An unresolvable git returns null, which is the SAME disposition this function
 * already had when the spawn threw ENOENT — silent skip, never a clean board.
 * `resolveGitBinary()` returns null only when no absolute candidate and no PATH
 * entry yields an executable git, i.e. exactly the cases where the old bare
 * spawn would itself have failed. So this closes the steering class without
 * moving the tri-state.
 * @param {string} cwd
 * @returns {string|null} e.g. "origin/main", or null if none resolvable
 */
function resolveRemoteDefaultRef(cwd) {
  try {
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    const out = execFileSync(
      gitBin,
      [
        "for-each-ref",
        "--format=%(refname:short)|%(symref:short)",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
        "refs/remotes/origin/master",
        "refs/remotes/origin/develop",
        "refs/remotes/upstream/HEAD",
      ],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: BASE_REF_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: gitEnv(),
      },
    );
    const rows = new Map();
    let symrefTarget = null;
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [name, symref] = line.split("|");
      // An origin/HEAD row reports as `origin|origin/main` — the symref target
      // is the answer, and it is authoritative when present.
      if (symref) {
        if (!symrefTarget) symrefTarget = symref;
        continue;
      }
      rows.set(name, true);
    }
    if (symrefTarget) return symrefTarget;
    for (const cand of ["origin/main", "origin/master", "origin/develop"]) {
      if (rows.has(cand)) return cand;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * THE BASE THIS SURFACE MEASURES AGAINST — the integration trunk, via the ONE
 * shared resolver (`wip-discipline.md` MUST-4). The STRICT form, because this is
 * a landedness decision (`trunk-ref.js:78-79`).
 *
 *   resolved     — `origin/dev` (basis "dev"), a probed `COC_TRUNK_REF` (basis
 *                  "override"), or — where no trunk exists — the pre-existing
 *                  remote-default read above (basis "main-fallback"). That last
 *                  composition is the one `landedRemoteRefs`'s no-`baseRef` arm uses
 *                  (`wip-lanes.js:880-888`), so a repo without `dev` is measured exactly as before.
 *   undetermined — an operator-declared `COC_TRUNK_REF` that does not resolve.
 *                  Rendered UNDETERMINED: a declaration this repo cannot honour
 *                  is not answered by quietly measuring against main.
 *   none         — no trunk and no remote default, or git cannot probe at all
 *                  (not a repository). The pre-existing silent skip.
 */
function resolveLandingBase(cwd) {
  const t = resolveTrunk({ repoDir: cwd, remote: "origin" });
  if (t.status !== "resolved") {
    return t.basis === "override"
      ? {
          status: "undetermined",
          ref: null,
          basis: "override",
          reason: t.reason,
        }
      : { status: "none", ref: null, basis: t.basis, reason: t.reason };
  }
  if (t.basis !== "main-fallback") {
    return { status: "resolved", ref: t.ref, basis: t.basis, reason: null };
  }
  const legacy = resolveRemoteDefaultRef(cwd);
  return legacy
    ? { status: "resolved", ref: legacy, basis: "main-fallback", reason: null }
    : {
        status: "none",
        ref: null,
        basis: "main-fallback",
        reason: "no origin/dev and no resolvable upstream default branch",
      };
}

/**
 * String form of `resolveLandingBase`, kept for callers that need only the ref.
 * null for every status other than resolved.
 * @param {string} cwd
 * @returns {string|null}
 */
function resolveBaseRef(cwd) {
  const r = resolveLandingBase(cwd);
  return r.status === "resolved" ? r.ref : null;
}

/**
 * Does local branch `name` carry commits absent from `ref`? Tri-state:
 * true / false / null (UNDERIVABLE — git failed, or `ref` does not resolve).
 */
function isUnmergedInto(cwd, name, ref) {
  try {
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    const out = execFileSync(
      gitBin,
      [
        "for-each-ref",
        "--no-merged",
        ref,
        "--format=%(refname:short)",
        `refs/heads/${name}`,
      ],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: BASE_REF_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: gitEnv(),
      },
    );
    return out.split("\n").some((l) => l.trim() === name);
  } catch {
    return null;
  }
}

/**
 * THE PROMOTION TARGET IS MEASURED AGAINST ITS OWN LANDING REF. With the base at
 * the trunk, local `main` reads unlanded whenever `origin/main` carries a commit
 * the trunk does not (a hotfix, a promotion merge commit) — commits that ARE
 * landed, on main. So `main` is re-measured against `origin/main`: dropped when
 * it carries nothing more (false), kept when it genuinely does (true), and KEPT
 * when the question cannot be answered (null) — over-reporting, never hiding.
 * Inert when the base already is `origin/main`.
 */
function excludeLandedPromotionTarget(
  cwd,
  baseRef,
  branches,
  remote = "origin",
) {
  const target = `${remote}/${PROMOTION_TARGET}`;
  if (baseRef === target) return branches;
  if (!branches.some((b) => b.name === PROMOTION_TARGET)) return branches;
  return isUnmergedInto(cwd, PROMOTION_TARGET, target) === false
    ? branches.filter((b) => b.name !== PROMOTION_TARGET)
    : branches;
}

/**
 * Local branch names whose tip IS reachable from `baseRef` (ancestry-landed —
 * a SOUND subset of content-landed). null on any failure, never [].
 */
function getMergedBranchNames(cwd, baseRef) {
  try {
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    const out = execFileSync(
      gitBin,
      [
        "for-each-ref",
        "--merged",
        baseRef,
        "--format=%(refname:short)",
        "refs/heads/",
      ],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: BRANCH_LIST_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: gitEnv(),
      },
    );
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** Branches checked out in any worktree. null on any failure, never []. */
function getWorktreeBranches(cwd) {
  try {
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    const out = execFileSync(gitBin, ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: WORKTREE_LIST_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: gitEnv(),
    });
    return parseWorktreeBranches(out);
  } catch {
    return null;
  }
}

/**
 * PURE. Local branches whose every commit is already on `base` — REPORT-ONLY
 * reap candidates. The landed set is the ancestry-merged names plus the content
 * pass's `landed` set; fenced out are the protected floor (`reap-on-landing.js`
 * — including `main` and `dev`), the branch `base` itself names, and any branch
 * checked out in a worktree (counted in `heldByWorktree`, never proposed).
 *
 * Each input is tri-state and `complete` is true only when all three were read:
 * without the content pass the list is the CERTAIN (ancestry) half only, and a
 * branch landed under another SHA is missing from it — which the render says.
 */
function computeReapCandidates({
  base,
  merged,
  unmerged,
  content,
  held,
  provenance = null,
}) {
  const prov = provenance || null;
  const ancestryKnown = Array.isArray(merged);
  // With provenance, the content pass is owed ONLY for the branches the verdict
  // handed back as fallback; a branch decided by trailers needs no content read.
  // Without it, this is the pre-existing expression exactly.
  const contentOwed = prov
    ? unmerged.filter((b) => prov.fallback.has(b.name)).length
    : unmerged.length;
  const contentKnown =
    contentOwed === 0 || (content !== null && content !== undefined);
  const worktreesKnown = Array.isArray(held);
  const fence = [];
  const trunkBranch = branchNameOfRef(base);
  if (trunkBranch) fence.push(trunkBranch);
  // A trailer-landed branch is NOT a reap candidate: its commits were rewritten
  // on landing, so `git branch -d` refuses it and `git cherry` may show `+`. It
  // is reported as LANDED-OPEN instead, with its own disposition (land-lane
  // retire) — see `formatTrunkTail`.
  const landed = new Set(ancestryKnown ? merged : []);
  if (content && content.landed instanceof Set) {
    // Content may only speak for a branch the provenance verdict released to it.
    for (const b of unmerged)
      if ((!prov || prov.fallback.has(b.name)) && content.landed.has(b.name))
        landed.add(b.name);
  }
  // An unmeasured branch may be landed; the list is then missing it.
  const provenanceKnown =
    !prov ||
    unmerged.every(
      (b) =>
        prov.landed.has(b.name) ||
        prov.unlanded.has(b.name) ||
        prov.fallback.has(b.name),
    );
  const heldSet = new Set(worktreesKnown ? held : []);
  const candidates = [];
  const heldByWorktree = [];
  for (const name of [...landed].sort((a, b) => a.localeCompare(b))) {
    if (isProtectedName(name, fence)) continue;
    if (heldSet.has(name)) heldByWorktree.push(name);
    else candidates.push(name);
  }
  const out = {
    base,
    candidates,
    heldByWorktree,
    ancestryKnown,
    contentKnown,
    worktreesKnown,
    contentBaseCapped: Boolean(content && content.baseCapped),
    contentBaseScanned: content ? content.baseScanned : 0,
    complete:
      ancestryKnown && contentKnown && worktreesKnown && provenanceKnown,
  };
  // Keys added ONLY when provenance is in play, so a no-config repo's reap
  // object is the pre-existing shape exactly.
  if (prov) out.provenanceKnown = provenanceKnown;
  return out;
}

/**
 * PURE. Partition candidate branches by the landing-provenance verdict.
 * `verdictFor(branch)` returns a `landed-map.js::landedVerdict(s)` result
 * (policy at `.claude/hooks/lib/landed-map.js::_verdictOf` and `::_mapFailureVerdict`); this function applies
 * its three-way contract and nothing else:
 *
 *   decided:true  → `landed` (landed === true) or `unlanded` (anything else;
 *                   a `partial` is also recorded in `partial`)
 *   decided:false, fallback:true  → `fallback` (the content pass may decide)
 *   anything else — fallback:false (incl. a branch the core's budget never
 *   reached), a throw, or no verdict → `unmeasured`: NEVER landed.
 *
 * The time budget lives in the core (`landedVerdicts` `budgetMs`); a verdict
 * the core marks `budgetExhausted: true` (the structured flag
 * `landed-map.js::landedVerdicts` sets on every branch its budget never
 * reached) sets `budgetExhausted` here. Read off the FLAG, never off the `why`
 * prose: a reworded message must not silently turn "the budget ran out" into
 * an unexplained UNMEASURED count.
 * @returns {{landed:Set<string>, unlanded:Set<string>, partial:Set<string>,
 *   fallback:Set<string>, unmeasured:Set<string>, budgetExhausted:boolean,
 *   status:Map<string,string>}}
 */
function partitionByProvenance(branches, verdictFor) {
  const out = {
    landed: new Set(),
    unlanded: new Set(),
    partial: new Set(),
    fallback: new Set(),
    unmeasured: new Set(),
    budgetExhausted: false,
    status: new Map(),
  };
  for (const b of branches) {
    let v = null;
    try {
      v = verdictFor(b);
    } catch {
      v = null;
    }
    out.status.set(
      b.name,
      v && typeof v.status === "string" ? v.status : "unknown",
    );
    if (v && v.budgetExhausted === true) out.budgetExhausted = true;
    if (v && v.decided === true) {
      if (v.landed === true) out.landed.add(b.name);
      else {
        out.unlanded.add(b.name);
        if (v.status === "partial") out.partial.add(b.name);
      }
    } else if (v && v.decided === false && v.fallback === true) {
      out.fallback.add(b.name);
    } else {
      out.unmeasured.add(b.name);
    }
  }
  return out;
}

/**
 * Build the landed map ONCE for this invocation, against `baseRef` — the same
 * ref every other pass here measures against — and partition `branches` by it.
 *
 * Returns null when the repo does not record landings (no config): the caller
 * then takes the pre-existing path exactly. Otherwise a partition plus the map
 * facts the render names (`mapOk`, `mapWhy`, `cutover`, `tip`). A config that
 * exists but yields no map is NOT null: the core returns every branch as
 * `no-map` with `fallback: false` — UNMEASURED, never released to the content
 * pass, because in a repo that records landings the content comparison is the
 * instrument the record replaced — and the render says the map was
 * unavailable and every branch unmeasured.
 *
 * ONE `landedVerdicts` call for all branches (`landed-map.js::landedVerdicts`), with
 * the listed tips supplied so the core spends no spawn re-resolving them.
 */
function computeProvenance(cwd, baseRef, branches, opts = {}) {
  const timeoutMs =
    opts.provenanceTimeoutMs != null
      ? opts.provenanceTimeoutMs
      : PROVENANCE_SPAWN_TIMEOUT_MS;
  const budgetMs =
    opts.provenanceBudgetMs != null
      ? opts.provenanceBudgetMs
      : PROVENANCE_BUDGET_MS;
  let map;
  try {
    map = landedMapLib.buildLandedMap({
      repoDir: cwd,
      ref: baseRef,
      timeoutMs,
    });
  } catch (e) {
    map = { ok: false, why: `landed-map threw: ${e && e.message}` };
  }
  if (!map || (!map.ok && map.noConfig)) return null;
  let verdicts = [];
  try {
    verdicts = landedMapLib.landedVerdicts({
      repoDir: cwd,
      // The listed tips, so the verdicts judge the SAME commits the content
      // pass and the age buckets were computed from.
      branches: branches.map((b) => ({
        ref: `refs/heads/${b.name}`,
        name: b.name,
        tip: b.sha || undefined,
      })),
      map,
      ref: baseRef,
      timeoutMs,
      budgetMs,
    });
  } catch {
    verdicts = []; // every branch then has no verdict ⇒ UNMEASURED
  }
  const byName = new Map();
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    if (v && typeof v.name === "string") byName.set(v.name, v);
  }
  const part = partitionByProvenance(
    branches,
    (b) => byName.get(b.name) || null,
  );
  return {
    ...part,
    mapOk: Boolean(map.ok),
    mapWhy: map.ok ? null : String(map.why || "unknown"),
    cutover: map.ok ? map.cutover : null,
    tip: map.ok ? map.tip : null,
  };
}

/**
 * The promotion gap — commits on the trunk not yet on `origin/main` — through
 * the shared `trunk-ref.js::promotionGap`, bounded. null when there is no trunk
 * distinct from main (a main-fallback base, or an override that IS main).
 * `known:false` when the count could not be answered: UNKNOWN, never zero.
 */
function computePromotion(cwd, landing) {
  if (!landing || landing.status !== "resolved") return null;
  if (landing.basis === "main-fallback") return null;
  const g = trunkRefLib.promotionGap({
    repoDir: cwd,
    remote: "origin",
    timeoutMs: PROMOTION_TIMEOUT_MS,
  });
  if (g.ok && g.sameRef) return null;
  if (!g.ok) return { known: false, trunk: g.trunk, main: g.main };
  return { known: true, ahead: g.ahead, trunk: g.trunk, main: g.main };
}

/**
 * List local branches carrying commits not reachable from `baseRef`, with each
 * branch's last-commit timestamp, in ONE git call.
 *
 * `--no-merged` is REACHABILITY, not content equivalence: a branch whose commits
 * were rebased, squashed, or cherry-picked onto the base still reports here. So
 * this is the CANDIDATE set, not the answer — `classifyByContent` below refines
 * it by patch-id, and the rendered block reports the ancestry-only remainder in
 * its own bucket rather than inside the headline. See § Content equivalence.
 *
 * Fail-open: returns null on ANY error (not a repo, no such ref, timeout), which
 * the caller renders as UNDETERMINED — never as an empty/clean result. An
 * unresolvable git binary takes that same null path, so it surfaces as
 * UNDETERMINED rather than as an empty branch list.
 *
 * Resolved binary + constants-built env, for the same reason as `resolveBaseRef`
 * and with more at stake: this is the call whose answer becomes the rendered
 * backlog. Under an ambient `GIT_DIR` a bare spawn would enumerate the ATTACKER's
 * refs against the victim's base ref, and the surface would publish that as the
 * operator's unlanded work at session start. Local read, so `gitEnv()`.
 * @param {string} cwd
 * @param {string} baseRef
 * @returns {Array<{name:string,ts:number,sha:string|null,upstream:string|null}>|null}
 */
function getUnmergedBranches(cwd, baseRef) {
  try {
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    const out = execFileSync(
      gitBin,
      [
        "for-each-ref",
        "--no-merged",
        baseRef,
        "--format=%(refname:short)%09%(committerdate:unix)%09%(objectname)%09%(upstream)",
        "refs/heads/",
      ],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: BRANCH_LIST_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: gitEnv(),
      },
    );
    const rows = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      // Split from the RIGHT into a FIXED field count: the format appends
      // date, objectname and upstream, and a ref name cannot contain a tab, so
      // the last three separators are ours and anything before them is the
      // name. `%(upstream)` is EMPTY for a branch with no tracking config, so
      // the trailing field is routinely blank and the split must survive that.
      const parts = line.split("\t");
      if (parts.length < 4) continue;
      const upstream = parts.pop().trim();
      const sha = parts.pop().trim();
      // Seconds → ms. A non-numeric/absent date degrades to NaN and is sorted
      // last + labelled "age unknown", never rendered as a bogus age.
      const secs = Number(parts.pop());
      rows.push({
        name: parts.join("\t"),
        ts: Number.isFinite(secs) && secs > 0 ? secs * 1000 : NaN,
        sha: sha || null,
        upstream: upstream || null,
      });
    }
    return rows;
  } catch {
    return null;
  }
}

/**
 * Every branch NAME that exists under a remote, in ONE git call.
 *
 * This answers "has this branch been pushed ANYWHERE", which is not the same
 * question as `%(upstream)`. A branch pushed without `--set-upstream` has an
 * empty `%(upstream)` and a live remote ref; reading the empty tracking field
 * as "never pushed" is a second over-reporting instrument of exactly the kind
 * this surface exists to remove. MEASURED at loom: 19 branches had no
 * `%(upstream)`, but 4 of those (21%) had a matching remote ref and were
 * therefore recoverable — the tracking field alone would have called them
 * unrecoverable.
 *
 * The remote name is stripped, so `origin/feat/x` and `upstream/feat/x` both
 * register `feat/x`. That is deliberately generous: this feeds a claim of
 * UNRECOVERABILITY, and a copy on any remote refutes it.
 *
 * Fail-open: null on any error, which the caller renders as "push state
 * unknown" rather than as a clean or an alarming one.
 * @param {string} cwd
 * @returns {Set<string>|null}
 */
function getRemoteBranchNames(cwd) {
  try {
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    const out = execFileSync(
      gitBin,
      ["for-each-ref", "--format=%(refname:short)", "refs/remotes/"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: BRANCH_LIST_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: gitEnv(),
      },
    );
    const names = new Set();
    for (const line of out.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const slash = t.indexOf("/");
      if (slash < 0) continue; // a bare remote name, not a branch
      names.add(t.slice(slash + 1));
    }
    return names;
  } catch {
    return null;
  }
}

/**
 * One bounded local-git read for the content pass. Same spawn discipline as the
 * two calls above (resolved binary, constants-built env, no shell, SIGKILL) —
 * `cwd:` picks a directory and an ambient `GIT_DIR` would otherwise choose the
 * repository. Throws on ANY failure; every caller path turns that into
 * `contentKnown: false`.
 * @param {string} cwd
 * @param {string} gitBin
 * @param {string[]} args
 * @param {string} [input]
 * @returns {string}
 */
function contentGit(cwd, gitBin, args, input) {
  return execFileSync(gitBin, args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "ignore"],
    timeout: CONTENT_EXEC_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: CONTENT_MAX_BUFFER,
    env: gitEnv(),
  });
}

/**
 * Compute patch-ids for `shas` with git, in TWO spawns regardless of how many
 * there are, WITHOUT holding the patch text in Node.
 *
 * The per-branch alternative (`git cherry` once per branch) was MEASURED at
 * loom: 79.6 ms × 102 branches = 8.1 s, against a ~17 ms floor per spawn — the
 * cost is process spawn plus a base-side rescan repeated once per branch. The
 * bulk form pays the base-side scan ONCE. That is the whole reason this is not
 * simply a `git cherry` loop.
 *
 * `diff-tree` writes into a file in a private `mkdtemp` directory (0700, so the
 * name cannot be pre-planted), opened `O_EXCL|O_NOFOLLOW`; `patch-id` reads that
 * file through a SECOND descriptor as its stdin. Node sees only patch-id's
 * ~82-byte lines. A shell pipeline would overlap the two, but `spawnSync`'s
 * timeout kills only the shell, leaving both gits orphaned; two sequential
 * spawns are each SIGKILLed by their own timeout, so nothing outlives the call.
 *
 * SALVAGE. A `diff-tree` killed by its timeout has still written every patch
 * but the one it was inside, so patch-id's output is read anyway and its LAST
 * row — the only one that can describe a truncated patch — is dropped. The
 * salvaged rows are returned with `complete: false`: the caller still degrades
 * to UPPER BOUND for this session (the timeout semantics are unchanged), but
 * the cache keeps the progress, so a clone too large for one budget converges
 * over successive sessions instead of throwing the same 3 s away every time.
 *
 * @param {string} cwd
 * @param {string} gitBin
 * @param {string[]} shas - validated full object ids
 * @returns {{ids:Map<string,string>, complete:boolean}}
 */
function computePatchIds(cwd, gitBin, shas) {
  const none = { ids: new Map(), complete: false };
  let dir;
  let wfd;
  let rfd;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-patch-id-"));
    const file = path.join(dir, "patches");
    const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
    wfd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        NOFOLLOW,
      0o600,
    );
    rfd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    // `-p` at git's DEFAULT context. `-U0` was measured to produce four false
    // CONTENT-LANDED verdicts on loom's 102 branches — see § Content
    // equivalence "REJECTED, with evidence". Do not shrink the context to buy
    // latency.
    const diff = childProcess.spawnSync(
      gitBin,
      ["diff-tree", "--stdin", "-p"],
      {
        cwd,
        input: shas.join("\n") + "\n",
        stdio: ["pipe", wfd, "ignore"],
        timeout: CONTENT_EXEC_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: gitEnv(),
      },
    );
    fs.closeSync(wfd);
    wfd = undefined;
    const diffComplete = !diff.error && diff.status === 0;
    const pid = childProcess.spawnSync(gitBin, ["patch-id", "--stable"], {
      cwd,
      stdio: [rfd, "pipe", "ignore"],
      encoding: "utf8",
      timeout: CONTENT_EXEC_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: CONTENT_MAX_BUFFER,
      env: gitEnv(),
    });
    if (typeof pid.stdout !== "string") return none;
    const pidComplete = !pid.error && pid.status === 0;
    const wanted = new Set(shas);
    // Only NEWLINE-TERMINATED lines are read: a line cut by a kill is dropped
    // here, so a truncated object id can never be parsed as a short one.
    const lines = pid.stdout.split("\n");
    lines.pop();
    const rows = [];
    for (const line of lines) {
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      const id = line.slice(0, sp);
      const sha = line.slice(sp + 1);
      if (!OID_RE.test(id) || !OID_RE.test(sha) || !wanted.has(sha)) continue;
      rows.push([sha, id]);
    }
    if (!diffComplete) rows.pop();
    return { ids: new Map(rows), complete: diffComplete && pidComplete };
  } catch {
    return none;
  } finally {
    for (const fd of [wfd, rfd]) {
      try {
        if (fd !== undefined) fs.closeSync(fd);
      } catch {}
    }
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

// Lazy: `state-io.js` is the ONE hardened open(2) flag set for attacker-
// plantable paths (`security.md` § Multi-Site Kwarg Plumbing), but it pulls in
// the posture machinery, which this surface needs only when a cache is read.
let _stateIo = null;
function stateIo() {
  if (!_stateIo) _stateIo = require("./state-io.js");
  return _stateIo;
}

/**
 * Load the clone's patch-id cache. Never throws, never returns a PARTIAL map:
 * an unparseable file is treated as empty and rewritten. A path that is not a
 * regular file (a planted symlink, a FIFO, a directory) is neither read through
 * nor replaced — `writable: false` — and every patch-id is computed afresh.
 * null when the git common dir cannot be resolved (no cache at all; the pass
 * runs exactly as it did before the cache existed).
 * @param {string} cwd
 * @param {string} gitBin
 */
function loadPatchIdCache(cwd, gitBin) {
  let common;
  try {
    common = contentGit(cwd, gitBin, ["rev-parse", "--git-common-dir"]).trim();
  } catch {
    return null;
  }
  if (!common) return null;
  const cache = {
    file: path.resolve(cwd, common, PATCH_ID_CACHE_FILE),
    map: new Map(),
    status: "absent",
    writable: true,
    dirty: false,
    hits: 0,
    computed: 0,
  };
  let r;
  try {
    r = stateIo().readFileHardened(cache.file, {
      maxBytes: PATCH_ID_CACHE_MAX_BYTES,
    });
  } catch {
    cache.status = "unreadable";
    return cache;
  }
  if (!r.ok) {
    if (r.code === "ENOENT") return cache;
    if (r.code === "ENOTREGULAR") {
      cache.status = "irregular";
      cache.writable = false;
    } else {
      cache.status = "unreadable";
    }
    return cache;
  }
  const lines = r.value.toString("utf8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines[0] !== PATCH_ID_CACHE_HEADER) {
    cache.status = "corrupt";
    return cache;
  }
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(" ");
    if (
      parts.length !== 2 ||
      !OID_RE.test(parts[0]) ||
      (parts[1] !== PATCH_ID_NONE && !OID_RE.test(parts[1]))
    ) {
      cache.status = "corrupt";
      return cache;
    }
    map.set(parts[0], parts[1]);
  }
  cache.map = map;
  cache.status = "loaded";
  return cache;
}

/**
 * Persist the cache iff this run added entries: pruned to the most recently
 * USED `PATCH_ID_CACHE_MAX_ENTRIES`, written to a pid-scoped temp through the
 * hardened writer (`O_CREAT|O_EXCL|O_NOFOLLOW`, 0600, nlink re-check), then
 * renamed into place. A concurrent session's write may win the rename; the
 * loser's entries are simply recomputed later. Best-effort by design — the
 * cache is an accelerator, and a failed write costs recomputation, never a
 * wrong verdict.
 */
function savePatchIdCache(cache) {
  if (!cache || !cache.dirty || !cache.writable) return;
  const map = cache.map;
  for (const k of map.keys()) {
    if (map.size <= PATCH_ID_CACHE_MAX_ENTRIES) break;
    map.delete(k);
  }
  let body = PATCH_ID_CACHE_HEADER + "\n";
  for (const [sha, id] of map) body += `${sha} ${id}\n`;
  const tmp = `${cache.file}.tmp.${process.pid}`;
  try {
    const w = stateIo().writeFileHardened(tmp, body, { replaceExisting: true });
    if (!w.ok) return;
    // An irregular entry planted at the cache path SINCE the load is left for
    // forensics, never replaced — the same disposition as one found at load.
    let st = null;
    try {
      st = fs.lstatSync(cache.file);
    } catch (e) {
      if (!e || e.code !== "ENOENT") throw e;
    }
    if (st && !st.isFile()) throw new Error("irregular cache entry");
    fs.renameSync(tmp, cache.file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

/**
 * Patch-id every sha in `shas`: cached entries are read (and marked recently
 * used), the rest are computed by `computePatchIds` in one bulk pass and added
 * to the cache. `complete: false` ⇒ the computed half was cut short.
 * @param {string} cwd
 * @param {string} gitBin
 * @param {string[]} shas
 * @param {object|null} cache - from loadPatchIdCache
 * @returns {{ids:Map<string,string>, complete:boolean}} sha → patch-id
 */
function patchIdsFor(cwd, gitBin, shas, cache) {
  const ids = new Map();
  const missing = [];
  for (const sha of shas) {
    if (!OID_RE.test(sha)) continue; // never passed to git, never cached
    if (cache && cache.map.has(sha)) {
      const id = cache.map.get(sha);
      cache.map.delete(sha); // re-insert ⇒ most recently used
      cache.map.set(sha, id);
      cache.hits++;
      if (id !== PATCH_ID_NONE) ids.set(sha, id);
    } else {
      missing.push(sha);
    }
  }
  if (missing.length === 0) return { ids, complete: true };
  const got = computePatchIds(cwd, gitBin, missing);
  for (const [sha, id] of got.ids) {
    ids.set(sha, id);
    if (cache) {
      cache.map.delete(sha);
      cache.map.set(sha, id);
      cache.computed++;
      cache.dirty = true;
    }
  }
  if (got.complete && cache) {
    for (const sha of missing) {
      if (got.ids.has(sha)) continue;
      cache.map.delete(sha);
      cache.map.set(sha, PATCH_ID_NONE);
      cache.computed++;
      cache.dirty = true;
    }
  }
  return { ids, complete: got.complete };
}

/**
 * Refine the ancestry candidate set by CONTENT.
 *
 * Returns null — meaning "the pass did not run, report ancestry as an UPPER
 * BOUND" — on every degradation path: opted out, no resolvable git, budget
 * exhausted, too many branch-side commits, or any git failure. It NEVER returns
 * a partial verdict set, because a partially-populated `landed` set is
 * indistinguishable at the call site from a complete one and would silently
 * drop real work out of the headline.
 *
 * Attribution note. A cheaper shape — `git log --source` to attribute each
 * branch-side commit to a ref — is WRONG here and is deliberately not used:
 * `--source` names the ref a commit was FIRST REACHED FROM, so a commit shared
 * by two branches is attributed to only one, and the other branch would appear
 * to hold nothing new. That error hides work. The DAG is walked in-process
 * instead, which is exact and costs one extra spawn.
 *
 * Patch-ids come through the clone's patch-id cache (see PATCH_ID_CACHE_FILE):
 * only shas absent from it reach `git diff-tree`. MEASURED 2026-09-27 on a
 * full-history loom clone, the uncached 2000-commit base window rendered
 * ~108 MB of patch text and overran CONTENT_EXEC_TIMEOUT_MS on every session
 * start, so the pass ALWAYS degraded to UPPER BOUND and its ~3 s were thrown
 * away. The cache is saved on EVERY exit path — including a timeout — so that
 * work is kept and the pass converges. `patchIdCache` on the result reports
 * the cache's status and hit/compute counts, for diagnosis only.
 *
 * @param {string} cwd
 * @param {string} baseRef
 * @param {Array<{name:string,sha:string|null}>} tips
 * @param {{now?:function, budgetMs?:number, maxBaseScan?:number}} [opts]
 * @returns {{landed:Set<string>, baseScanned:number, baseCapped:boolean,
 *            leftCommits:number,
 *            patchIdCache:{status:string,hits:number,computed:number}|null}|null}
 */
function classifyByContent(cwd, baseRef, tips, opts = {}) {
  if (process.env.COC_UNLANDED_CONTENT_CHECK === "0") return null;
  const now = opts.now || Date.now;
  const budgetMs = opts.budgetMs != null ? opts.budgetMs : CONTENT_BUDGET_MS;
  const maxBaseScan =
    opts.maxBaseScan != null ? opts.maxBaseScan : MAX_BASE_SCAN;
  const deadline = now() + budgetMs;
  const overBudget = () => now() >= deadline;

  let cache = null;
  try {
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    const seeds = tips.filter((t) => t && typeof t.sha === "string" && t.sha);
    if (seeds.length === 0) return null;

    // Phase 1 — the branch-side DAG. Merges are KEPT (they are the edges the
    // walk needs) and are exempt from the patch-id test below, which is what
    // makes a merge-only branch tip classify as holding nothing new.
    const dagOut = contentGit(cwd, gitBin, [
      "rev-list",
      "--parents",
      "--branches",
      "--not",
      baseRef,
    ]);
    const dag = new Map();
    for (const line of dagOut.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split(" ");
      dag.set(parts[0], parts.slice(1));
    }
    const leftNonMerge = [];
    for (const [sha, parents] of dag) {
      if (parents.length < 2) leftNonMerge.push(sha);
    }
    if (leftNonMerge.length > MAX_LEFT_COMMITS) return null;
    if (overBudget()) return null;

    // Phase 2 — patch-ids for the branch side. A cut-short computation is
    // the same degradation a git failure always was: UPPER BOUND, never a
    // verdict over a partial id set.
    cache = loadPatchIdCache(cwd, gitBin);
    const left = patchIdsFor(cwd, gitBin, leftNonMerge, cache);
    if (!left.complete) return null;
    const leftIds = left.ids;
    if (overBudget()) return null;

    // Phase 3 — patch-ids for a bounded window of the base side.
    const baseShas = contentGit(cwd, gitBin, [
      "rev-list",
      "--no-merges",
      "--max-count=" + maxBaseScan,
      baseRef,
    ])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (overBudget()) return null;
    const base = patchIdsFor(cwd, gitBin, baseShas, cache);
    if (!base.complete) return null;
    const baseIds = new Set(base.ids.values());

    // Phase 4 — walk each tip's own history. Pure in-process; no budget check
    // is needed or wanted here, because bailing after the expensive spawns
    // would throw away work already paid for.
    const landed = new Set();
    for (const t of seeds) {
      if (!dag.has(t.sha)) continue; // unknown shape → stays UNLANDED (safe)
      const seen = new Set();
      const stack = [t.sha];
      let hasNew = false;
      while (stack.length) {
        const c = stack.pop();
        if (seen.has(c)) continue;
        seen.add(c);
        const parents = dag.get(c);
        if (!parents) continue;
        if (parents.length < 2) {
          const pid = leftIds.get(c);
          // A commit we could not patch-id is NOT evidence of absence — it is
          // an unanswered question, so it counts as new and keeps the branch
          // on the list.
          if (!pid || !baseIds.has(pid)) {
            hasNew = true;
            break;
          }
        }
        for (const p of parents) if (dag.has(p)) stack.push(p);
      }
      if (!hasNew) landed.add(t.name);
    }

    return {
      landed,
      baseScanned: baseShas.length,
      baseCapped: baseShas.length >= maxBaseScan,
      leftCommits: leftNonMerge.length,
      patchIdCache: cache
        ? { status: cache.status, hits: cache.hits, computed: cache.computed }
        : null,
    };
  } catch {
    return null;
  } finally {
    // EVERY exit, including the timeout and budget paths: ids computed before
    // the pass gave up are exactly the progress the next session needs.
    try {
      savePatchIdCache(cache);
    } catch {}
  }
}

/**
 * Per-branch CARRY SPAN inputs: the author timestamp of the OLDEST unlanded
 * commit reachable from each tip, plus that tip's unlanded commit count.
 *
 * ONE git spawn regardless of branch count, for the same reason `patchIdsFor`
 * is bulk: the per-branch form re-scans the base side once per branch. It walks
 * the same DAG shape `classifyByContent` Phase 1 builds, but is a SEPARATE pass
 * on purpose — binding the ratchet axis to the content pass would mean
 * `COC_UNLANDED_CONTENT_CHECK=0`, a blown content budget, or a patch-id
 * ENOBUFS each SILENTLY disabled ratchet detection while the block still
 * rendered a confident "work in flight" line. This pass is ~30–50 ms and has no
 * patch-id phase, so it survives budgets the content pass does not.
 *
 * `--format=%at` composes with `--parents`: git emits `commit <sha> <parents…>`
 * followed by the format line. VERIFIED BY EXECUTION against a merge commit
 * (two parents rendered on the header line, timestamp on the next), not assumed
 * from the documentation.
 *
 * AUTHOR date, not committer date, and the asymmetry is load-bearing: a rebase
 * resets committer dates to now, which would zero the span of exactly the
 * long-lived branch this exists to catch. See § The ratchet axis (a).
 *
 * Returns null — "the pass did not run, report the carry axis as UNKNOWN" — on
 * every degradation path: opted out, no resolvable git, budget exhausted, an
 * over-large DAG, or any git failure. It NEVER returns a partial map, because a
 * partially-populated span map is indistinguishable at the call site from a
 * complete one and would silently re-suppress the ratchets it missed.
 *
 * @param {string} cwd
 * @param {string} baseRef
 * @param {Array<{name:string,sha:string|null}>} tips
 * @param {{now?:function, ratchetBudgetMs?:number}} [opts]
 * @returns {{spans:Map<string,{firstTs:number,commits:number,tsComplete:boolean}>,
 *            nodes:number}|null}
 */
function computeCarrySpans(cwd, baseRef, tips, opts = {}) {
  if (process.env.COC_UNLANDED_RATCHET_CHECK === "0") return null;
  const now = opts.now || Date.now;
  const budgetMs =
    opts.ratchetBudgetMs != null ? opts.ratchetBudgetMs : RATCHET_BUDGET_MS;
  const deadline = now() + budgetMs;

  try {
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    const seeds = tips.filter((t) => t && typeof t.sha === "string" && t.sha);
    if (seeds.length === 0) return null;
    if (now() >= deadline) return null;

    const out = contentGit(cwd, gitBin, [
      "rev-list",
      "--parents",
      "--format=%at",
      "--branches",
      "--not",
      baseRef,
    ]);
    if (now() >= deadline) return null;

    const parents = new Map();
    const authoredAt = new Map();
    let pending = null;
    for (const line of out.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith("commit ")) {
        const parts = t.slice("commit ".length).split(" ").filter(Boolean);
        pending = parts[0] || null;
        if (pending) parents.set(pending, parts.slice(1));
        continue;
      }
      if (pending) {
        const secs = Number(t);
        authoredAt.set(
          pending,
          Number.isFinite(secs) && secs > 0 ? secs * 1000 : NaN,
        );
        pending = null;
      }
    }
    if (parents.size === 0) return null;
    // Same volume guard as the content pass, applied to the WHOLE node set
    // rather than the non-merge subset — a tighter bound, deliberately, since
    // this pass buys a cheaper answer and should give up sooner.
    if (parents.size > MAX_LEFT_COMMITS) return null;

    const spans = new Map();
    for (const t of seeds) {
      if (!parents.has(t.sha)) continue; // unknown shape → no span claim made
      const seen = new Set();
      const stack = [t.sha];
      let firstTs = Infinity;
      let commits = 0;
      let tsComplete = true;
      while (stack.length) {
        const c = stack.pop();
        if (seen.has(c)) continue;
        seen.add(c);
        const ps = parents.get(c);
        if (!ps) continue;
        if (ps.length < 2) commits++;
        const at = authoredAt.get(c);
        // An unreadable author date is NOT evidence the work is young — it is
        // an unanswered question. The partial minimum is still POSITIVE
        // evidence and is kept (if it already crosses the threshold the branch
        // is a ratchet regardless of what the unreadable commit says), but
        // `tsComplete: false` travels with it so a NON-crossing partial is
        // reported as UNKNOWN rather than folded into the in-flight count.
        if (Number.isFinite(at)) {
          if (at < firstTs) firstTs = at;
        } else {
          tsComplete = false;
        }
        for (const p of ps) if (parents.has(p)) stack.push(p);
      }
      spans.set(t.name, {
        firstTs: Number.isFinite(firstTs) ? firstTs : NaN,
        commits,
        tsComplete,
      });
    }

    return { spans, nodes: parents.size };
  } catch {
    return null;
  }
}

/**
 * Combine the branch list with the open-PR head names into the renderable state.
 *
 * `openPrHeads` is tri-state and its meaning is preserved end to end:
 *   Array  → the PR board was read; branches with an open PR are subtracted.
 *   null   → gh FAILED. The subtraction CANNOT be performed, so the count is
 *            reported as an upper bound with `prBoardKnown: false`. Reporting
 *            the unsubtracted number as if it were the forgotten set would be a
 *            claim the instrument cannot support.
 *
 * `content` carries the same tri-state discipline one level deeper:
 *   object → the patch-id pass ran; branches holding nothing new are moved OUT
 *            of the headline into their own reported bucket.
 *   null   → the pass did NOT run. The headline is the ancestry figure and is
 *            labelled an UPPER BOUND, exactly as an unread PR board is. It is
 *            never presented as a content-verified number.
 *
 * @param {Array<{name:string,ts:number,sha?:string}>|null} branches
 * @param {string[]|null} openPrHeads
 * @param {number} [now]
 * @param {object|null} [content] result of classifyByContent
 * @returns {object|null} null iff branches === null (UNDETERMINED)
 */
function computeUnlandedSummary(
  branches,
  openPrHeads,
  now = Date.now(),
  content = null,
  remoteNames = null,
  carry = null,
  // `{ base, reap, promotion }` from `computeUnlandedState`; each absent field
  // renders nothing, which keeps every pre-existing caller's output unchanged.
  extras = {},
) {
  if (branches === null) return null;
  const prBoardKnown = Array.isArray(openPrHeads);
  const onBoard = new Set(prBoardKnown ? openPrHeads : []);
  const afterBoard = branches.filter((b) => !onBoard.has(b.name));

  // The content split. `contentLanded` branches are ancestry-unlanded but hold
  // no commit whose patch is absent from the base window — they are REPORTED,
  // in their own line, and removed from the actionable set. Property 2 still
  // holds: nothing is silently dropped, it is re-bucketed with its count named.
  const contentKnown = content !== null && content !== undefined;
  const landedSet = contentKnown ? content.landed : new Set();
  // Property 8: with provenance in play the content verdict may speak ONLY for
  // a branch the provenance verdict released to it (`fallback`). A branch the
  // trailers decided, or one left unmeasured, is never moved by content.
  // Without provenance every branch is content's, i.e. the pre-existing split.
  const prov = extras && extras.provenance ? extras.provenance : null;
  const provLanded = (b) => Boolean(prov) && prov.landed.has(b.name);
  const contentMayDecide = (b) => !prov || prov.fallback.has(b.name);
  const isContentLanded = (b) =>
    contentKnown && contentMayDecide(b) && landedSet.has(b.name);
  const contentLandedCount = afterBoard.filter(isContentLanded).length;
  const provenanceLandedCount = afterBoard.filter(provLanded).length;
  const candidates = afterBoard.filter(
    (b) => !provLanded(b) && !isContentLanded(b),
  );
  const ancestryTotal = afterBoard.length;
  // Which instrument decided a row that STAYS in the headline. undefined when
  // provenance is not in play, so legacy rows keep their exact shape.
  const decidedBy = (b) => {
    if (!prov) return undefined;
    if (prov.unlanded.has(b.name))
      return prov.partial.has(b.name) ? "provenance-partial" : "provenance";
    if (prov.fallback.has(b.name))
      return contentKnown ? "content" : "reachability";
    return "unmeasured"; // no verdict, fallback:false, or budget — never landed
  };
  const provenanceSummary = prov
    ? {
        mapOk: Boolean(prov.mapOk),
        mapWhy: prov.mapWhy || null,
        cutover: prov.cutover || null,
        budgetExhausted: Boolean(prov.budgetExhausted),
        landedCount: provenanceLandedCount,
        notLandedCount: candidates.filter((b) =>
          /^provenance/.test(decidedBy(b)),
        ).length,
        partialCount: candidates.filter(
          (b) => decidedBy(b) === "provenance-partial",
        ).length,
        preRecordingCount: afterBoard.filter((b) => prov.fallback.has(b.name))
          .length,
        preRecordingListedCount: candidates.filter((b) =>
          prov.fallback.has(b.name),
        ).length,
        unmeasuredCount: candidates.filter((b) => decidedBy(b) === "unmeasured")
          .length,
        // LANDED-OPEN: the branch still exists but every own commit is covered
        // by a trailer (verdict decided + landed). Taken from ALL listed
        // branches, open PR or not — an open PR does not un-land it.
        tip: prov.tip || null,
        landedOpen: branches
          .filter((b) => prov.landed.has(b.name))
          .map((b) => b.name)
          .sort((a, b) => a.localeCompare(b)),
      }
    : null;

  // The unrecoverable class. A branch that is content-unlanded AND exists on no
  // remote lives in exactly one clone: no reflog anywhere else, no PR, nothing
  // to restore it from if this disk fails or someone runs a destructive reset.
  // It is the only row on this surface whose loss is not merely re-work, so it
  // is named separately rather than folded into the total.
  //
  // Tri-state again: a null remote-name set means the question was not asked,
  // and `localOnlyKnown: false` says so instead of rendering 0 (which reads as
  // "nothing at risk" — the reassuring answer, and the one we cannot support).
  const localOnlyKnown = remoteNames instanceof Set;
  const isLocalOnly = (b) =>
    localOnlyKnown && !b.upstream && !remoteNames.has(b.name);

  const ageDays = (b) =>
    Number.isFinite(b.ts) ? Math.floor((now - b.ts) / MS_PER_DAY) : NaN;

  let recent = 0,
    mid = 0,
    stale = 0,
    unknownAge = 0;
  for (const b of candidates) {
    const d = ageDays(b);
    if (!Number.isFinite(d)) unknownAge++;
    else if (d <= RECENT_DAYS) recent++;
    else if (d <= STALE_DAYS) mid++;
    else stale++;
  }

  // Two filters decide what gets LISTED. Neither touches any COUNT above —
  // that is the property that keeps the surface honest about magnitude no
  // matter how wrong the list is.
  //
  //  (a) declared no-land prefixes (see § Suppression), and
  //  (b) an age floor: a branch touched within RECENT_DAYS is work IN FLIGHT,
  //      not forgotten work. Listing it is pure noise — it is the branch you
  //      are on, or the one you pushed yesterday. Naming today's work as
  //      possibly-forgotten is how a surface teaches operators to skip it.
  //
  // (b) is nearly free and matters most in SMALL repos: at a 42-branch backlog
  // the oldest-first ordering already keeps recent branches off a 10-row list,
  // but in a consumer repo with three branches all created today, the
  // unfiltered surface listed all three as if they were forgotten.
  const listable = candidates.filter(
    (b) =>
      !isDemoted(b.name) &&
      (!Number.isFinite(ageDays(b)) || ageDays(b) > RECENT_DAYS),
  );
  const demotedCount = candidates.filter((b) => isDemoted(b.name)).length;

  // ── The second axis (loom#1912) ───────────────────────────────────────────
  // Everything above answers "how long since this branch was TOUCHED". That
  // question alone cannot see a branch touched daily and never landed, because
  // touching it is what keeps it invisible. Carry span answers "how long has
  // this branch been carrying work that never landed", which the same behaviour
  // makes MORE visible rather than less. See § The ratchet axis.
  const ratchetKnown =
    carry !== null && carry !== undefined && carry.spans instanceof Map;
  const spanOf = (b) => (ratchetKnown ? carry.spans.get(b.name) || null : null);
  const carrySpanDays = (b) => {
    const s = spanOf(b);
    if (!s || !Number.isFinite(s.firstTs) || !Number.isFinite(b.ts)) return NaN;
    // Floored at 0: a forged author date in the future must not render as a
    // negative span, and must not be read as a ratchet either.
    return Math.floor(Math.max(0, b.ts - s.firstTs) / MS_PER_DAY);
  };
  // The cell the age floor suppresses — the ONLY population this axis reclassifies.
  // A branch the floor already lists is untouched by any of this.
  const ageSuppressed = (b) =>
    !isDemoted(b.name) &&
    Number.isFinite(ageDays(b)) &&
    ageDays(b) <= RECENT_DAYS;
  const isRatchet = (b) =>
    ageSuppressed(b) &&
    Number.isFinite(carrySpanDays(b)) &&
    carrySpanDays(b) >= RATCHET_SPAN_DAYS;
  // Absence of a span verdict is UNKNOWN, never "young". Reported in its own
  // count so a branch whose carry could not be read is visible as unmeasured
  // rather than silently banked as in-flight.
  const spanUnknown = (b) => {
    if (!ratchetKnown) return false; // reported once, at summary level
    const s = spanOf(b);
    if (!s) return true; // tip absent from the walked DAG
    if (!Number.isFinite(s.firstTs)) return true;
    return !s.tsComplete;
  };

  const ratchetAll = candidates.filter(isRatchet);
  const ratchetSpanUnknownCount = candidates.filter(
    (b) => ageSuppressed(b) && !isRatchet(b) && spanUnknown(b),
  ).length;
  // Widest carry first — the row most likely to be a genuine ratchet leads.
  const ratchetSorted = ratchetAll
    .slice()
    .sort((a, b) => carrySpanDays(b) - carrySpanDays(a));

  // Ratchets are disjoint from BOTH `listable` (they are age-suppressed by
  // construction) and `demotedCount` (excluded inside `ageSuppressed`), so this
  // subtraction cannot double-count. `inFlightCount` now means what it always
  // claimed to mean: recently touched AND not carrying old unlanded work.
  const inFlightCount =
    candidates.length - listable.length - demotedCount - ratchetAll.length;

  const sorted = listable.slice().sort((a, b) => {
    const da = ageDays(a),
      db = ageDays(b);
    if (!Number.isFinite(da) && !Number.isFinite(db)) return 0;
    if (!Number.isFinite(da)) return 1;
    if (!Number.isFinite(db)) return -1;
    return db - da; // oldest first
  });

  return {
    total: candidates.length,
    ancestryTotal,
    prBoardKnown,
    localOnlyKnown,
    localOnlyCount: candidates.filter(isLocalOnly).length,
    contentKnown,
    contentLandedCount,
    contentBaseScanned: contentKnown ? content.baseScanned : 0,
    contentBaseCapped: contentKnown ? Boolean(content.baseCapped) : false,
    buckets: { recent, mid, stale, unknownAge },
    demotedCount,
    inFlightCount,
    ratchetKnown,
    ratchetCount: ratchetAll.length,
    ratchetSpanUnknownCount,
    ratchets: ratchetSorted.slice(0, LIST_LIMIT).map((b) => ({
      name: b.name,
      ageDays: ageDays(b),
      spanDays: carrySpanDays(b),
      // Reachability, so an UPPER BOUND: a rebased or squashed branch
      // over-reports. Labelled as such wherever it is rendered.
      commits: (spanOf(b) || {}).commits || 0,
      localOnly: isLocalOnly(b),
      ...(prov ? { decidedBy: decidedBy(b) } : {}),
    })),
    ratchetTruncated: ratchetSorted.length > LIST_LIMIT,
    listed: sorted.slice(0, LIST_LIMIT).map((b) => ({
      name: b.name,
      ageDays: ageDays(b),
      localOnly: isLocalOnly(b),
      ...(prov ? { decidedBy: decidedBy(b) } : {}),
    })),
    listTruncated: sorted.length > LIST_LIMIT,
    listableCount: sorted.length,
    base: extras && extras.base ? extras.base : null,
    reap: extras && extras.reap ? extras.reap : null,
    promotion: extras && extras.promotion ? extras.promotion : null,
    provenance: provenanceSummary,
  };
}

// Row label naming the instrument that decided a row. Rendered only when
// provenance is in play (a legacy row carries no `decidedBy`).
const DECIDED_BY_LABEL = {
  provenance: "provenance trailers: not landed",
  "provenance-partial": "provenance trailers: partially landed",
  content: "content comparison — predates recording",
  reachability: "reachability only — predates recording, content unverified",
  unmeasured: "UNMEASURED — no provenance verdict",
};
function decidedBySuffix(row) {
  return row && row.decidedBy
    ? `; ${DECIDED_BY_LABEL[row.decidedBy] || row.decidedBy}`
    : "";
}

/**
 * The provenance paragraph of the headline block — which instrument decided
 * what, with counts. `legacyNote` is the pre-existing content/reachability
 * note, re-scoped here to the pre-recording rows it still covers.
 */
function formatProvenanceNote(summary, baseName, legacyNote) {
  const p = summary.provenance;
  if (!p.mapOk) {
    return (
      `**Landing-provenance map UNAVAILABLE** — ${sanitizeName(p.mapWhy)}. ` +
      `This repo records landings, but the record could not be read, so ` +
      `${p.unmeasuredCount} branch(es) are UNMEASURED: counted above as ` +
      `unlanded, never as landed, and NOT decided by content — a content ` +
      `comparison misreports a landing that rewrote its commits (rebase, ` +
      `squash, conflict fix), which is why this repo records landings at all. ` +
      `This is unmeasured, not a finding either way. Repair the map before ` +
      `acting on a row.`
    );
  }
  let out =
    `Landedness decided by LANDING PROVENANCE — the \`Landed-From\` / ` +
    `\`Landed-Partial\` trailers recorded on ${baseName} when work lands ` +
    `(recording cutover \`${String(p.cutover).slice(0, 12)}\`) — not by comparing ` +
    `content: ${p.landedCount} branch(es) excluded as recorded landed, ` +
    `${p.notLandedCount} listed as recorded NOT landed` +
    (p.partialCount ? ` (${p.partialCount} of them partially landed)` : "") +
    `. No content comparison ran for a trailer-decided row, so a patch present ` +
    `on the base WITHOUT a trailer does not make it landed.`;
  if (p.preRecordingCount) {
    out +=
      `\n\n${p.preRecordingCount} branch(es) forked at or before the cutover, ` +
      `before recording began, and were judged by the legacy comparison ` +
      `instead (${p.preRecordingListedCount} still listed). For THOSE rows ` +
      `only: ${legacyNote}`;
  }
  if (p.unmeasuredCount) {
    out +=
      `\n\n**${p.unmeasuredCount} branch(es) UNMEASURED** — no provenance ` +
      `verdict could be read` +
      (p.budgetExhausted
        ? ` (the per-invocation verdict time budget ran out)`
        : "") +
      `. They are counted above as unlanded, never as landed; this is ` +
      `unmeasured, not a finding either way.`;
  }
  return out;
}

/**
 * The promotion-gap line and the reap-candidate section, appended to EVERY
 * rendered block (clean or not) — neither fact depends on whether any lane work
 * is unlanded. Empty string when there is nothing to say.
 */
function formatTrunkTail(summary) {
  let out = "";
  const p = summary.promotion;
  if (p && !p.known) {
    out +=
      `\n\n**Promotion gap UNKNOWN** — \`git rev-list --count ${p.main}..${p.trunk}\` ` +
      `could not be answered at session start (timeout or git failure). This is ` +
      `unmeasured, not zero.`;
  } else if (p && p.ahead > 0) {
    out +=
      `\n\n**Promotion gap:** \`${p.trunk}\` is ${p.ahead} commit(s) ahead of ` +
      `\`${p.main}\`. Those commits are LANDED on the integration trunk; the ` +
      `promotion to \`${p.main}\` is a separate, deliberate step — they are not ` +
      `unlanded lane work and are not listed above.`;
  }

  // LANDED-OPEN — a branch that still exists though every own commit is
  // covered by a Landed-From trailer. Its own labelled line, never a reap row:
  // the landing rewrote its commits, so `git branch -d` refuses it and the
  // disposition is land-lane retire, which checks the push reached the remote.
  const pv = summary.provenance;
  if (pv && Array.isArray(pv.landedOpen) && pv.landedOpen.length) {
    const tip12 = String(pv.tip || "").slice(0, 12) || "(unknown tip)";
    out +=
      `\n\n## LANDED-OPEN — recorded landed, branch still open (${pv.landedOpen.length})\n\n` +
      pv.landedOpen
        .map(
          (name) =>
            `LANDED-OPEN: ${sanitizeName(name)} — landed per Landed-From trailers on ${tip12}; ` +
            `retire it with \`node .claude/bin/land-lane.mjs retire --apply\` once the push is on the remote`,
        )
        .join("\n");
  }

  const r = summary.reap;
  if (r && (r.candidates.length > 0 || !r.complete)) {
    const n = r.candidates.length;
    const provReap = "provenanceKnown" in r;
    const rows = r.candidates
      .slice(0, LIST_LIMIT)
      .map((name) => `- ${sanitizeName(name)}`)
      .join("\n");
    const gaps = [];
    if (provReap && !r.provenanceKnown)
      gaps.push(
        "a landing-provenance verdict could not be read for some branch(es) (UNMEASURED), " +
          "so a branch landed through the recording path may be missing",
      );
    if (!r.ancestryKnown)
      gaps.push(
        "the ancestry read (`git for-each-ref --merged`) failed, so NO branch was checked",
      );
    if (!r.contentKnown)
      gaps.push(
        "the content (patch-id) pass did not run — budget, `COC_UNLANDED_CONTENT_CHECK=0`, " +
          "or a git failure — so a branch landed under a different SHA (rebase, cherry-pick, " +
          "single-commit squash) is NOT listed",
      );
    if (!r.worktreesKnown)
      gaps.push(
        "`git worktree list` failed, so a listed branch may be checked out in a worktree, " +
          "where `git branch -d` refuses it",
      );
    if (r.contentBaseCapped)
      gaps.push(
        `a patch-id twin older than the ${r.contentBaseScanned}-commit base window is not seen`,
      );
    out +=
      `\n\n## Reap candidates — local branches whose every commit is already on \`${r.base}\` (${n})\n\n` +
      `REPORT-ONLY — nothing was deleted, and this surface never deletes. Each is ` +
      (provReap
        ? `landed by ancestry or — for a branch that predates recording — by a ` +
          `patch-id twin on the trunk (a branch recorded landed by provenance ` +
          `trailers is reported as LANDED-OPEN instead); no merge command in ` +
          `this session reported it, so nothing else will. Confirm a row with ` +
          `\`git cherry ${r.base} <branch>\` (no \`+\` line), record its tip SHA, then `
        : `landed by ancestry or by a patch-id twin on the trunk; no merge command in ` +
          `this session reported it, so nothing else will. Confirm a row with ` +
          `\`git cherry ${r.base} <branch>\` (no \`+\` line), record its tip SHA, then `) +
      `\`git branch -d <branch>\` — and \`git push origin --delete <branch>\` if it ` +
      `still has a remote ref.` +
      (rows ? `\n\n${rows}` : "") +
      (n > LIST_LIMIT ? `\n\nShowing ${LIST_LIMIT} of ${n}.` : "") +
      (r.heldByWorktree.length
        ? `\n\nNot proposed: ${r.heldByWorktree.length} landed branch(es) checked out ` +
          `in a worktree (${r.heldByWorktree.slice(0, LIST_LIMIT).map(sanitizeName).join(", ")}) — ` +
          `remove the worktree first.`
        : "") +
      (gaps.length ? `\n\n**INCOMPLETE** — ${gaps.join("; ")}.` : "");
  }
  return out;
}

// Branch names are far less attacker-controllable than PR titles (they come from
// local refs), but this block lands VERBATIM in SessionStart additionalContext
// that the agent reads as authoritative, so the same structural neutralization
// open-pr-surface applies to titles applies here: strip control/newline chars
// that would break a name out of its bullet, neutralize backticks, bound length.
const NAME_MAX = 100;
function sanitizeName(raw) {
  let s = String(raw == null ? "" : raw);
  s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  s = s.replace(/`/g, "'").replace(/\s+/g, " ").trim();
  if (s.length > NAME_MAX) s = s.slice(0, NAME_MAX) + "…";
  return s || "(unnamed)";
}

/**
 * Render the agent-visible block. Tri-state in, mirroring open-pr-surface:
 *   undefined → null    (not checked — no base ref; skip silently)
 *   null      → UNDETERMINED warning (git failed; NEVER read as clean)
 *   total 0   → positive, verified-clean confirmation
 *   total > 0 → the actionable block
 * @param {object|null|undefined} summary
 * @returns {string|null}
 */
function formatUnlandedBlock(summary) {
  if (summary === undefined) return null;
  if (summary === null) {
    return (
      "# ⚠ Unlanded-Work Check: UNDETERMINED\n\n" +
      "The local branch scan could not run at session start (not a git repo, " +
      "no resolvable base, a declared `COC_TRUNK_REF` that does not resolve, or " +
      "git timed out). This is **not** a clean result — the unlanded-work " +
      "backlog is UNKNOWN. Run `git for-each-ref --no-merged <trunk> refs/heads/` " +
      "manually against the integration trunk (`origin/dev` where it exists, " +
      "else `origin/main`) before trusting any claim that nothing is outstanding."
    );
  }
  const tail = formatTrunkTail(summary);
  const baseName = summary.base
    ? `\`${summary.base}\``
    : "the upstream default branch";
  if (summary.total === 0) {
    // A zero reached THROUGH the content pass is a different claim from a zero
    // reached by ancestry alone, and the two are never collapsed: the first
    // says N branches were checked and found to hold nothing new, the second
    // says no branch was even ancestry-unlanded.
    const via = summary.contentLandedCount
      ? ` ${summary.contentLandedCount} branch(es) are not merged by ancestry ` +
        `but hold no commit whose patch is absent from the base — landed under ` +
        `other SHAs, or carrying only merge commits.`
      : "";
    // Which instrument decided the zero. Rendered only with provenance in play.
    const pz = summary.provenance;
    const provVia = !pz
      ? ""
      : !pz.mapOk
        ? ` **Landing-provenance map UNAVAILABLE** (${sanitizeName(pz.mapWhy)}) — ` +
          `no branch here needed a landedness verdict; had one, it would have ` +
          `been reported UNMEASURED, never decided by content.`
        : ` Decided by landing-provenance trailers for ${pz.landedCount} ` +
          `branch(es) recorded landed, and by the legacy content comparison for ` +
          `${pz.preRecordingCount} branch(es) that predate recording.`;
    return (
      "# ✓ No Unlanded Local Branches\n\n" +
      `Every local branch is merged into ${baseName}, has an ` +
      "open PR, or is already present by content." +
      via +
      provVia +
      " Hook-verified at session start — trust this over any note below." +
      tail
    );
  }

  const { buckets: b } = summary;
  const qualifier = summary.prBoardKnown
    ? ""
    : " (UPPER BOUND (open-PR board unread) — the open-PR board could not be " +
      "read, so branches that *do* have an open PR are still counted here)";

  const parts = [];
  if (b.recent) parts.push(`${b.recent} newer than ${RECENT_DAYS}d`);
  if (b.mid) parts.push(`${b.mid} at ${RECENT_DAYS}–${STALE_DAYS}d`);
  if (b.stale) parts.push(`${b.stale} older than ${STALE_DAYS}d`);
  if (b.unknownAge) parts.push(`${b.unknownAge} of unknown age`);

  // The predicate note. These two branches make OPPOSITE claims about the
  // headline number and are never merged into one hedge: with the content pass
  // the figure is patch-verified and the caveats are the specific things
  // patch-id cannot see; without it the figure is raw ancestry and is known to
  // over-report.
  //
  // The two UPPER-BOUND causes carry DISTINCT parenthetical labels — "(open-PR
  // board unread)" above, "(content unverified)" below. A single undifferentiated
  // "UPPER BOUND" would tell a reader the number is inflated without telling
  // them WHICH instrument is missing, and the two have different remedies (re-
  // auth `gh`, versus re-run the content pass or raise its budget).
  const legacyPredicateNote = summary.contentKnown
    ? `Counted by CONTENT, not reachability: each branch here holds at least ` +
      `one commit whose patch is absent from the base` +
      (summary.contentLandedCount
        ? `, and ${summary.contentLandedCount} further ancestry-unmerged ` +
          `branch(es) were EXCLUDED as already present by content ` +
          `(rebased, cherry-picked, single-commit-squashed, or merge-only)`
        : "") +
      `.\n\nWhat this still cannot see, so confirm before acting on a row: a ` +
      `MULTI-COMMIT SQUASH (the squashed commit's patch matches neither ` +
      `original, so the branch is listed though it landed)` +
      (summary.contentBaseCapped
        ? `; a duplicate older than the ${summary.contentBaseScanned}-commit ` +
          `base window this pass scanned`
        : "") +
      `; and a defect fixed on the base by a DIFFERENT mechanism, where the ` +
      `commit is genuinely absent and genuinely unnecessary. Whether the ` +
      `DEFECT still reproduces outranks whether the COMMIT is present.`
    : `Counted by REACHABILITY only — the content pass did not run, so this ` +
      `is an UPPER BOUND (content unverified). A branch rebased, cherry-picked ` +
      `or squashed onto the base still appears here though its work landed. ` +
      `Confirm a row with \`git cherry <base> <branch>\` (a \`+\` line is a ` +
      `commit with no upstream patch twin) before acting on it.`;
  const predicateNote = summary.provenance
    ? formatProvenanceNote(summary, baseName, legacyPredicateNote)
    : legacyPredicateNote;

  // The at-risk line. Deliberately ABOVE the disposition menu, because the
  // dispositions include "delete" and this names the rows for which delete is
  // irreversible. Three states, never two: a count, a verified zero, or an
  // explicit unknown.
  const atRiskNote = !summary.localOnlyKnown
    ? `**Push state UNKNOWN** — the remote ref list could not be read, so ` +
      `whether any of these exists only in this clone is unmeasured. Do not ` +
      `read that as none.\n\n`
    : summary.localOnlyCount
      ? `**${summary.localOnlyCount} of these exist ONLY in this clone** — no ` +
        `upstream, no ref on any remote. That is the one class here whose loss ` +
        `is not re-work but destruction: no reflog elsewhere, nothing to ` +
        `restore from. Push them (\`git push -u origin <branch>\`) before ` +
        `anything else on this list.\n\n`
      : "";

  const head =
    `# ⚠ Unlanded Local Work at Session Start\n\n` +
    `**${summary.total} local branch(es)** carry commits that are not on ` +
    `${baseName} and have no open PR${qualifier}. ` +
    `Age spread: ${parts.join(", ")}.\n\n` +
    `${predicateNote}\n\n` +
    `${atRiskNote}` +
    `Each listed branch wants one of FOUR dispositions this session — land it, ` +
    `fold it, delete it, or open an issue and delete it. "Leave it for now" is ` +
    `not one of them; it is how the count grew. Never delete a branch on this ` +
    `list's say-so alone — record its tip SHA first, so recovery is ` +
    `\`git branch <name> <sha>\`.`;

  // The ratchet section. Rendered ABOVE the age-sorted list because a ratchet is
  // known-LIVE work that is still growing, whereas an old row may simply be
  // abandoned — and because it is the class this surface previously could not
  // show at all (loom#1912).
  const ratchetSection = summary.ratchetCount
    ? `\n\n## ⛔ RATCHET — actively written AND never landed (${summary.ratchetCount})\n\n` +
      `These are NOT part of the "work in flight" line below. Each was touched ` +
      `within the last ${RECENT_DAYS}d — which on its own SUPPRESSES a row here — ` +
      `but each has been carrying unlanded work for at least ${RATCHET_SPAN_DAYS}d ` +
      `of span between its oldest unlanded commit and its newest. Recency and ` +
      `unlandedness are independent, and this is their intersection: the more ` +
      `actively such a branch is written, the more reliably a recency filter ` +
      `hides it.\n\n` +
      summary.ratchets
        .map((r) => {
          const age = Number.isFinite(r.ageDays) ? `${r.ageDays}d` : "unknown";
          const risk = r.localOnly ? ", LOCAL-ONLY — unpushed" : "";
          return (
            `- ${sanitizeName(r.name)} — carrying unlanded work for ` +
            `${r.spanDays}d; last touched ${age} ago; ${r.commits} unlanded ` +
            `commit(s) by REACHABILITY (an UPPER BOUND — a rebased, ` +
            `cherry-picked or squashed branch over-reports)${risk}${decidedBySuffix(r)}`
          );
        })
        .join("\n") +
      (summary.ratchetTruncated
        ? `\n\nShowing the ${summary.ratchets.length} widest-carry of ${summary.ratchetCount}.`
        : "") +
      `\n\nDisposition for a ratchet row is NOT "you forgot this" — it is land ` +
      `it, or shard it so part of it can land. Carry span is read from AUTHOR ` +
      `dates, so an ordinary rebase does not reset it; \`--reset-author\`, ` +
      `\`--ignore-date\` and \`--amend --date=\` do.`
    : "";

  // The in-flight phrase is TRI-STATE, like every other claim on this surface.
  // Without the carry pass the surface cannot tell a ratchet from genuine
  // in-flight work, and saying so is the whole repair — the pre-#1912 text
  // asserted "work in flight, not forgotten" for a population it had never
  // measured, and that assertion is what let 33 commits accumulate unremarked.
  const inFlightPhrase = (longForm) => {
    const base =
      `${summary.inFlightCount} touched within the last ${RECENT_DAYS}d ` +
      (longForm ? `(work in flight, not forgotten)` : `(work in flight)`);
    if (!summary.ratchetKnown) {
      return (
        base +
        ` — carry span UNCLASSIFIED: the ratchet pass did not run, so a branch ` +
        `actively accumulating unlanded work is NOT distinguished here from one ` +
        `genuinely in flight. Do not read this as verified`
      );
    }
    return (
      base +
      `, carry span verified under ${RATCHET_SPAN_DAYS}d` +
      (summary.ratchetSpanUnknownCount
        ? ` except ${summary.ratchetSpanUnknownCount} whose carry span could ` +
          `not be read (UNKNOWN — unmeasured, not verified young)`
        : "")
    );
  };

  // An empty list has TWO possible causes and they mean opposite things, so
  // they are never collapsed into one sentence: everything is recent (nothing
  // is forgotten yet — a good state) versus everything is a declared no-land
  // branch (nothing is actionable — also fine, but for a different reason).
  if (summary.listableCount === 0) {
    const why = [];
    if (summary.inFlightCount) why.push(inFlightPhrase(true));
    if (summary.demotedCount)
      why.push(
        `${summary.demotedCount} carrying a declared no-land prefix ` +
          `(backup/, parked/, salvage/, wip/, agent scratch)`,
      );
    const none = why.length
      ? `\n\nNone are listed by age — ${why.join(", and ")}. They remain counted above.`
      : "";
    return head + ratchetSection + none + tail;
  }

  const rows = summary.listed
    .map((r) => {
      const age = Number.isFinite(r.ageDays) ? `${r.ageDays}d` : "age unknown";
      // The marker rides on the ROW because the count alone does not say WHICH,
      // and "delete" is one of the four dispositions offered above.
      const risk = r.localOnly ? ", LOCAL-ONLY — unpushed" : "";
      return `- ${sanitizeName(r.name)} (${age}${risk}${decidedBySuffix(r)})`;
    })
    .join("\n");

  const listNote = summary.listTruncated
    ? `\n\nShowing the ${summary.listed.length} oldest of ${summary.listableCount} listable.`
    : "";
  const held = [];
  if (summary.inFlightCount) held.push(inFlightPhrase(false));
  if (summary.demotedCount)
    held.push(
      `${summary.demotedCount} carrying a declared no-land prefix ` +
        `(backup/, parked/, salvage/, wip/, agent scratch)`,
    );
  const demotedNote = held.length
    ? `\n\nNot listed: ${held.join(", and ")}. They remain counted above.`
    : "";

  return `${head}${ratchetSection}\n\n${rows}${listNote}${demotedNote}${tail}`;
}

/**
 * Derive the open-PR head-branch names from `open-pr-surface`'s tri-state,
 * PRESERVING the distinction between "board read, nothing open" and "board not
 * read". Both are falsy-ish shapes that collapse to the same thing under a
 * careless `|| []`, and collapsing them is the one bug that would make this
 * surface lie: an unread board would silently render as a subtraction that
 * never happened.
 *
 *   Array → the head names
 *   null      (gh failed)        → null, i.e. board UNKNOWN
 *   undefined (no github remote) → null, i.e. board UNKNOWN
 *
 * SCHEMA-MISMATCH GUARD. A NON-EMPTY board that yields ZERO head names is not a
 * board with nothing to subtract — it is a board whose `headRefName` field is
 * absent, i.e. `open-pr-surface`'s `--json` list and this function have drifted
 * apart. Returning [] there is the worst available outcome: the caller would
 * mark the board KNOWN and publish an unsubtracted total as a confirmed figure.
 * MEASURED at loom when the field was removed: 54 branches reported with
 * `prBoardKnown: true` and no qualifier, against a true 40. So this degrades to
 * UNKNOWN, which is honest, rather than to [], which is a confident lie.
 *
 * An EMPTY board still returns [] — that is a real, readable "nothing open".
 *
 * @param {Array|null|undefined} openPrState
 * @returns {string[]|null}
 */
function openPrHeadsFrom(openPrState) {
  if (!Array.isArray(openPrState)) return null;
  if (openPrState.length === 0) return [];
  const heads = openPrState
    .map((pr) => pr && pr.headRefName)
    .filter((n) => typeof n === "string" && n.length > 0);
  return heads.length === 0 ? null : heads;
}

/**
 * Orchestrating helper. Returns undefined (no base ref → skip silently), null
 * (git failed → UNDETERMINED), or the summary object.
 *
 * `openPrHeads` is supplied by the CALLER, which already fetches the open-PR
 * board for `open-pr-surface.js`. Reusing that result is why this surface adds
 * ZERO network calls — see the measurement note in the lane report.
 * @param {string} cwd
 * @param {string[]|null} openPrHeads
 * @returns {object|null|undefined}
 */
function computeUnlandedState(cwd, openPrHeads, opts = {}) {
  try {
    const landing = resolveLandingBase(cwd);
    // A declared trunk this repo cannot honour is UNDETERMINED — never answered
    // by quietly measuring against main.
    if (landing.status === "undetermined") return null;
    if (landing.status !== "resolved") return undefined; // no base → skip silently
    const baseRef = landing.ref;
    const listed = getUnmergedBranches(cwd, baseRef);
    if (listed === null) return null; // UNDETERMINED — never a content pass
    const branches = excludeLandedPromotionTarget(cwd, baseRef, listed);
    // Property 8: the recorded provenance decides FIRST, against the SAME base
    // ref, with the map built once here. null ⇔ this repo does not record
    // landings, and everything below is then the pre-existing path exactly.
    const provenance = branches.length
      ? computeProvenance(cwd, baseRef, branches, opts)
      : null;
    // The content pass runs ONLY for the branches provenance released to it
    // (`fallback`). When it released none, the pass is not run at all — it
    // could only speak for rows it is not allowed to decide.
    const contentTips = provenance
      ? branches.filter((b) => provenance.fallback.has(b.name))
      : branches;
    // No candidates ⇒ nothing for the content pass to refine, and paying its
    // spawns to confirm an empty set would be pure session-start latency.
    const content = contentTips.length
      ? classifyByContent(cwd, baseRef, contentTips, opts)
      : null;
    const remoteNames = branches.length ? getRemoteBranchNames(cwd) : null;
    // Independent of `content` by design — see `computeCarrySpans`. A degraded
    // content pass must not take the ratchet axis down with it.
    const carry = branches.length
      ? computeCarrySpans(cwd, baseRef, branches, opts)
      : null;
    // Reap candidates REUSE the content pass above rather than running a
    // per-branch `git cherry` loop (MEASURED 8.1 s over 102 branches — see
    // `patchIdsFor`), so the only new cost is two bounded local reads.
    const reap = computeReapCandidates({
      base: baseRef,
      merged: getMergedBranchNames(cwd, baseRef),
      unmerged: branches,
      content,
      held: getWorktreeBranches(cwd),
      provenance,
    });
    const promotion = computePromotion(cwd, landing);
    return computeUnlandedSummary(
      branches,
      openPrHeads,
      Date.now(),
      content,
      remoteNames,
      carry,
      provenance
        ? { base: baseRef, reap, promotion, provenance }
        : { base: baseRef, reap, promotion },
    );
  } catch {
    return undefined;
  }
}

module.exports = {
  resolveBaseRef,
  resolveLandingBase,
  computeReapCandidates,
  partitionByProvenance,
  computeProvenance,
  getUnmergedBranches,
  getRemoteBranchNames,
  classifyByContent,
  computeCarrySpans,
  computeUnlandedSummary,
  formatUnlandedBlock,
  computeUnlandedState,
  openPrHeadsFrom,
  isDemoted,
  LIST_LIMIT,
  RECENT_DAYS,
  STALE_DAYS,
  RATCHET_SPAN_DAYS,
  RATCHET_BUDGET_MS,
  PROVENANCE_BUDGET_MS,
  CONTENT_BUDGET_MS,
  MAX_BASE_SCAN,
  MAX_LEFT_COMMITS,
  PATCH_ID_CACHE_FILE,
  PATCH_ID_CACHE_HEADER,
  PATCH_ID_CACHE_MAX_ENTRIES,
};
