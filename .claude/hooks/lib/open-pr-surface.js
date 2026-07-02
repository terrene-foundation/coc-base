/**
 * lib/open-pr-surface.js
 *
 * Open-PR session-start surface (orphan-PR guard) for the COC baseline
 * session-start hook. Surfaces the LIVE open-PR queue into agent context at
 * session start so a forgotten/orphan PR cannot hide behind a stale session
 * note's "nothing queued" claim.
 *
 * Design contract (issue #574):
 *   - FAIL-OPEN everywhere: a session NEVER blocks or hangs on the gh
 *     round-trip. Every error path returns a safe value; nothing throws.
 *   - Gated on "has a github.com remote", NOT on orchestrator/project mode —
 *     a purely local repo (no remote) would otherwise get a false
 *     "could not verify" warning every session, so it skips SILENTLY.
 *   - Tri-state block: open PRs → actionable; clean → positive confirmation;
 *     gh failed → "could not verify" warning (never mistaken for clean).
 *
 * All three functions are pure / best-effort and individually testable.
 */

const { execFileSync } = require("child_process");

// Per-call latency bounds. This surface runs SYNCHRONOUSLY at EVERY session
// start in EVERY github-remote consumer, so the two external calls' timeouts
// ARE the worst-case added latency (execFileSync blocks the event loop, so the
// hook's own setTimeout cannot preempt them). Kept tight so the total added
// latency is ~3s worst-case; both calls fail-OPEN fast on timeout/error and
// NEVER block or delay session start. `killSignal: "SIGKILL"` guarantees the
// timeout actually reaps a wedged `git`/`gh` rather than waiting on SIGTERM.
const REMOTE_TIMEOUT_MS = 1000;
const PR_LIST_TIMEOUT_MS = 2000;
const PR_LIST_LIMIT = 50;

/**
 * Best-effort: does `cwd` have ANY github.com remote (not just `origin`)? A
 * fork-of-a-fork or a repo whose github remote is named `upstream` would be
 * missed by an origin-only check, so this scans every configured remote.
 * Fail-open — returns false on ANY error (no git, no remotes, detached,
 * non-github remotes), so a local-only repo is skipped silently rather than
 * warned about.
 *
 * The short exec timeout bounds the git call; execFileSync blocks the event
 * loop so the exec timeout is the real bound.
 * @param {string} cwd
 * @returns {boolean}
 */
function hasGithubRemote(cwd) {
  try {
    const out = execFileSync("git", ["remote", "-v"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: REMOTE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    // `git remote -v` lists every remote (name\turl (fetch|push)). Matches
    // https://github.com/... and git@github.com:... on ANY remote line —
    // not just `origin`. Case-insensitive host; multiline for the `^` anchor.
    return /(^|@|\/\/)github\.com[/:]/im.test(out);
  } catch {
    return false;
  }
}

/**
 * Best-effort: list open PRs for the repo at `cwd` via `gh`. Fail-open —
 * returns null on ANY error (gh missing, unauthed, no remote, timeout,
 * non-JSON) so a session NEVER blocks or hangs on the GitHub round-trip.
 * Returns [] for a clean board (distinct from null = could-not-check).
 *
 * The exec timeout is LOAD-BEARING: execFileSync blocks the event loop, so
 * the hook's setTimeout CANNOT preempt a gh hang — this exec timeout is the
 * ONLY real bound on the round-trip. Kept tight (PR_LIST_TIMEOUT_MS) so the
 * whole surface adds ~3s worst-case to session start; `killSignal: "SIGKILL"`
 * reaps a wedged gh rather than waiting on SIGTERM.
 * @param {string} cwd
 * @returns {Array<{number:number,title:string,createdAt:string}>|null}
 */
function getOpenPullRequests(cwd) {
  try {
    const out = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "number,title,createdAt",
        "--limit",
        String(PR_LIST_LIMIT),
      ],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: PR_LIST_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Defense-in-depth title sanitizer (security LOW). A PR title is controllable by
// anyone who can open a PR and is interpolated VERBATIM into the SessionStart
// additionalContext the agent reads as authoritative — a crafted title is a
// prompt-injection vector. This does NOT attempt full semantic neutralization
// (impossible for free text); it removes the STRUCTURAL escape hatches: control
// + newline/tab chars that would let a title break out of its single bullet
// line into fresh markdown/instructions, backticks that open code-fence games,
// and unbounded length that could flood the block.
const TITLE_MAX = 120;
function sanitizeTitle(raw) {
  let s = String(raw == null ? "" : raw);
  // Strip C0/C1 control chars (incl. \n \r \t) → single space, so the title
  // cannot inject a new line / heading / list item into the context block.
  s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  // Neutralize backticks (code-fence / inline-code games) and collapse runs.
  s = s.replace(/`/g, "'").replace(/\s+/g, " ").trim();
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX) + "…";
  return s || "(untitled)";
}

/**
 * Build the agent-visible open-PR block. Tri-state in, so the hook is the
 * board's source of truth in EVERY state and a gh failure is never allowed to
 * pass as "clean":
 *   undefined → null  (not checked — no github remote; no block, skip silent)
 *   null      → could-not-check WARNING block (gh failed; queue is UNKNOWN)
 *   []        → clean-board CONFIRMATION block (positive, hook-verified)
 *   [..]      → open-PR block (the actionable case; oldest-first, NaN-safe)
 * @param {Array<{number:number,title:string,createdAt:string}>|null|undefined} openPrs
 * @returns {string|null}
 */
function formatOpenPrBlock(openPrs) {
  if (openPrs === undefined) return null; // not checked (no github remote)
  if (openPrs === null) {
    // gh check FAILED — announce could-not-check loudly. A silent degrade would
    // re-create the exact blindness the check exists to prevent: gh being down
    // is precisely when a forgotten PR is most likely to slip.
    return (
      "# ⚠ Open-PR Queue NOT Verified This Session\n\n" +
      "`gh pr list --state open` could not run at session start (gh missing, " +
      "unauthenticated, or no network). This is NOT a clean board — the live PR " +
      'queue is UNKNOWN. Do not trust any note claiming "nothing queued" until ' +
      "you run `gh pr list --state open` manually."
    );
  }
  if (openPrs.length === 0) {
    // Clean board — emit a POSITIVE, hook-verified confirmation. A clean board
    // must not leave the agent trusting a note's "nothing queued" claim; this
    // line's ABSENCE then means "not verified" (gh failed), never "clean".
    return (
      "# ✓ Open-PR Queue Verified Clean\n\n" +
      "`gh pr list --state open` ran at session start and returned **0 open PRs** " +
      "— a live, hook-verified clean board. Trust this over any note below that " +
      'claims "nothing queued".'
    );
  }
  const now = Date.now();
  // NaN-safe: gh's --json createdAt is always ISO, but a malformed/missing/null
  // value must not print "open NaNd" — OR "open <huge>d" — into an authoritative
  // block. `new Date(null)` is the epoch (a FINITE 0), so a literal null would
  // slip past a bare isFinite check and render a ~20000-day age; only a
  // non-empty STRING is a candidate ISO timestamp. Degrade everything else to
  // "age unknown" and sort unparseable rows last.
  const ageMs = (pr) => {
    const raw = pr && pr.createdAt;
    if (typeof raw !== "string" || raw === "") return NaN;
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? now - t : NaN;
  };
  const lines = openPrs
    .slice()
    .sort((a, b) => {
      const da = ageMs(a),
        db = ageMs(b);
      if (!Number.isFinite(da) && !Number.isFinite(db)) return 0;
      if (!Number.isFinite(da)) return 1; // a (unparseable) sorts after b
      if (!Number.isFinite(db)) return -1;
      return db - da; // oldest (largest age) first
    })
    .map((pr) => {
      const age = ageMs(pr);
      const label = Number.isFinite(age)
        ? `open ${Math.floor(age / 86400000)}d`
        : "age unknown";
      const num = Number(pr && pr.number);
      const numLabel = Number.isFinite(num) ? num : "?";
      // SANITIZE the title before interpolation: it is attacker-controllable
      // (anyone who can open a PR) and lands VERBATIM in the SessionStart
      // additionalContext the agent reads as authoritative. Defense-in-depth
      // against prompt-injection via crafted titles — see sanitizeTitle.
      return `- #${numLabel} (${label}) — ${sanitizeTitle(pr && pr.title)}`;
    });
  // LOW-a: --limit caps the fetch, so length === PR_LIST_LIMIT means "at least
  // this many" — never imply the cap IS the total. Show "50+" when capped.
  const capped = openPrs.length >= PR_LIST_LIMIT;
  const countLabel = capped ? `${PR_LIST_LIMIT}+` : String(openPrs.length);
  return (
    "# ⚠ Open Pull Requests at Session Start\n\n" +
    `The live PR queue has ${countLabel} open PR(s)` +
    (capped ? ` (showing the oldest ${PR_LIST_LIMIT})` : "") +
    ". This is the " +
    'unconditional session-start check: a note saying "nothing queued" is a ' +
    "claim about *remembered* work, not the *live* queue — trust this list over " +
    "the notes below. Verify any stale PR before merging.\n\n" +
    lines.join("\n")
  );
}

/**
 * Orchestrating helper: compute the tri-state value for the current cwd.
 * Returns undefined (no github remote → skip silent), null (gh failed), [] /
 * [..] (queue). Fail-open: any unexpected error degrades to undefined.
 * @param {string} cwd
 * @returns {Array|null|undefined}
 */
function computeOpenPrState(cwd) {
  try {
    if (!hasGithubRemote(cwd)) return undefined;
    return getOpenPullRequests(cwd);
  } catch {
    return undefined;
  }
}

module.exports = {
  hasGithubRemote,
  getOpenPullRequests,
  formatOpenPrBlock,
  computeOpenPrState,
};
