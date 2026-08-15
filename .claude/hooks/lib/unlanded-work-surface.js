/**
 * lib/unlanded-work-surface.js
 *
 * Unlanded-work session-start surface. Sibling of `open-pr-surface.js`, which
 * answers "what is ON the board?"; this answers the complementary question
 * "what never GOT to the board?" — local branches carrying commits that are not
 * on the upstream default branch and have no open PR.
 *
 * Design contract — the four properties that make this shippable fleet-wide:
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
 *   4. NO REPO-SHAPE ASSUMPTIONS. The base ref is resolved from origin/HEAD,
 *      then main/master/develop, then upstream/HEAD, in ONE git call. Nothing
 *      assumes loom's branch naming, a wave shape, or that `main` exists.
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

const { execFileSync } = require("child_process");
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env");

// Per-call latency bounds. This runs SYNCHRONOUSLY at session start in every
// consumer; execFileSync blocks the event loop, so these exec timeouts are the
// ONLY real bound (a hook-level setTimeout cannot preempt them). Both calls are
// LOCAL git — no network — so these are generous, not tight-fitting.
// `killSignal: "SIGKILL"` guarantees a wedged git is actually reaped.
const BASE_REF_TIMEOUT_MS = 1000;
const BRANCH_LIST_TIMEOUT_MS = 2000;

// Rendered-list cap. As with open-pr-surface's PR_LIST_LIMIT, the cap is
// disclosed in the output ("showing the oldest 10 of 40") so a truncated list is
// never mistaken for the whole set.
const LIST_LIMIT = 10;

// Age buckets, in days. Chosen so the histogram separates "this week's work in
// flight" from "genuinely stale".
const RECENT_DAYS = 7;
const STALE_DAYS = 30;

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
function resolveBaseRef(cwd) {
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
 * List local branches carrying commits not reachable from `baseRef`, with each
 * branch's last-commit timestamp, in ONE git call.
 *
 * `--no-merged` is REACHABILITY, not content equivalence: a branch whose commits
 * were rebased, squashed, or cherry-picked onto the base still reports here. See
 * the KNOWN OVER-REPORT note on computeUnlandedState — the surface states this
 * in its own output rather than implying reachability means "work is missing".
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
 * @returns {Array<{name:string,ts:number}>|null}
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
        "--format=%(refname:short)%09%(committerdate:unix)",
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
      const tab = line.lastIndexOf("\t");
      if (tab < 0) continue;
      const name = line.slice(0, tab);
      // Seconds → ms. A non-numeric/absent date degrades to NaN and is sorted
      // last + labelled "age unknown", never rendered as a bogus age.
      const secs = Number(line.slice(tab + 1));
      rows.push({
        name,
        ts: Number.isFinite(secs) && secs > 0 ? secs * 1000 : NaN,
      });
    }
    return rows;
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
 * @param {Array<{name:string,ts:number}>|null} branches
 * @param {string[]|null} openPrHeads
 * @param {number} [now]
 * @returns {object|null} null iff branches === null (UNDETERMINED)
 */
function computeUnlandedSummary(branches, openPrHeads, now = Date.now()) {
  if (branches === null) return null;
  const prBoardKnown = Array.isArray(openPrHeads);
  const onBoard = new Set(prBoardKnown ? openPrHeads : []);
  const candidates = branches.filter((b) => !onBoard.has(b.name));

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
  const inFlightCount = candidates.length - listable.length - demotedCount;

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
    prBoardKnown,
    buckets: { recent, mid, stale, unknownAge },
    demotedCount,
    inFlightCount,
    listed: sorted.slice(0, LIST_LIMIT).map((b) => ({
      name: b.name,
      ageDays: ageDays(b),
    })),
    listTruncated: sorted.length > LIST_LIMIT,
    listableCount: sorted.length,
  };
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
      "no resolvable upstream default branch, or git timed out). This is **not** " +
      "a clean result — the unlanded-work backlog is UNKNOWN. Run " +
      "`git for-each-ref --no-merged origin/main refs/heads/` manually before " +
      'trusting any claim that nothing is outstanding.'
    );
  }
  if (summary.total === 0) {
    return (
      "# ✓ No Unlanded Local Branches\n\n" +
      "Every local branch is merged into the upstream default branch, or has an " +
      "open PR. Hook-verified at session start — trust this over any note below."
    );
  }

  const { buckets: b } = summary;
  const qualifier = summary.prBoardKnown
    ? ""
    : " (UPPER BOUND — the open-PR board could not be read, so branches that " +
      "*do* have an open PR are still counted here)";

  const parts = [];
  if (b.recent) parts.push(`${b.recent} newer than ${RECENT_DAYS}d`);
  if (b.mid) parts.push(`${b.mid} at ${RECENT_DAYS}–${STALE_DAYS}d`);
  if (b.stale) parts.push(`${b.stale} older than ${STALE_DAYS}d`);
  if (b.unknownAge) parts.push(`${b.unknownAge} of unknown age`);

  const head =
    `# ⚠ Unlanded Local Work at Session Start\n\n` +
    `**${summary.total} local branch(es)** carry commits that are not on the ` +
    `upstream default branch and have no open PR${qualifier}. ` +
    `Age spread: ${parts.join(", ")}.\n\n` +
    `This counts REACHABILITY, not content: a branch whose commits were ` +
    `rebased, squashed, or cherry-picked onto the base still appears here even ` +
    `though its work landed. Confirm with ` +
    `\`git diff <base>...<branch>\` before acting on any single row — and never ` +
    `delete a branch on this list's say-so.`;

  // An empty list has TWO possible causes and they mean opposite things, so
  // they are never collapsed into one sentence: everything is recent (nothing
  // is forgotten yet — a good state) versus everything is a declared no-land
  // branch (nothing is actionable — also fine, but for a different reason).
  if (summary.listableCount === 0) {
    const why = [];
    if (summary.inFlightCount)
      why.push(
        `${summary.inFlightCount} touched within the last ${RECENT_DAYS}d ` +
          `(work in flight, not forgotten)`,
      );
    if (summary.demotedCount)
      why.push(
        `${summary.demotedCount} carrying a declared no-land prefix ` +
          `(backup/, parked/, salvage/, wip/, agent scratch)`,
      );
    return (
      head +
      `\n\nNone are listed — ${why.join(", and ")}. They remain counted above.`
    );
  }

  const rows = summary.listed
    .map((r) => {
      const age = Number.isFinite(r.ageDays) ? `${r.ageDays}d` : "age unknown";
      return `- ${sanitizeName(r.name)} (${age})`;
    })
    .join("\n");

  const listNote = summary.listTruncated
    ? `\n\nShowing the ${summary.listed.length} oldest of ${summary.listableCount} listable.`
    : "";
  const held = [];
  if (summary.inFlightCount)
    held.push(
      `${summary.inFlightCount} touched within the last ${RECENT_DAYS}d ` +
        `(work in flight)`,
    );
  if (summary.demotedCount)
    held.push(
      `${summary.demotedCount} carrying a declared no-land prefix ` +
        `(backup/, parked/, salvage/, wip/, agent scratch)`,
    );
  const demotedNote = held.length
    ? `\n\nNot listed: ${held.join(", and ")}. They remain counted above.`
    : "";

  return `${head}\n\n${rows}${listNote}${demotedNote}`;
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
function computeUnlandedState(cwd, openPrHeads) {
  try {
    const baseRef = resolveBaseRef(cwd);
    if (!baseRef) return undefined; // no upstream default → skip silently
    const branches = getUnmergedBranches(cwd, baseRef);
    return computeUnlandedSummary(branches, openPrHeads);
  } catch {
    return undefined;
  }
}

module.exports = {
  resolveBaseRef,
  getUnmergedBranches,
  computeUnlandedSummary,
  formatUnlandedBlock,
  computeUnlandedState,
  openPrHeadsFrom,
  isDemoted,
  LIST_LIMIT,
  RECENT_DAYS,
  STALE_DAYS,
};
