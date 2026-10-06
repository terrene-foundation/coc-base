/**
 * worktree-conservation.js — the CONSERVATION gate for worktree LIFETIME.
 *
 * WHAT THIS ANSWERS, AND WHY IT IS NOT THE REAPER'S QUESTION.
 * `worktree-reap.mjs` classifies a tree on the REMOVAL-SAFETY axis: may this
 * tree be deleted without losing work (ZERO-LOSS / TAG-FIRST / KEEP)? That is
 * the TEARDOWN question, and `worktree-isolation.md` Rule 8 owns it. This module
 * asks the LIFETIME question instead: is there uncommitted content sitting in a
 * tree that nothing is going to come back for?
 *
 * Those are different questions over the same forest, and the reaper's verdict
 * CANNOT answer this one — measured on the originating forest (52 trees,
 * 2026-08-16): `worktree-reap.mjs --json` returned KEEP for 52 of 52 trees. KEEP
 * is emitted for the main checkout, for a bare repo, for a locked tree, for a
 * tree under the 12h idle floor, for in-flight commits, AND for a dirty tree —
 * so a verdict that is constant across the hypothesis carries no information
 * about it (`instrument-discipline.md` MUST-1). Reading KEEP as "at risk" would
 * be the MUST-4 wrong-question read exactly.
 *
 * WHAT IS REUSED, SO THERE IS ONE DEFINITION OF EACH FACT.
 * `security.md` § Enforcement-Surface Parity refuses a second definition of a
 * shared predicate, so nothing here re-derives a fact that already has an owner:
 *   - "which paths does porcelain name" → `sibling-porcelain.js::parsePorcelain`,
 *     promoted from its `_internal` slot to a public export by this change. A
 *     second porcelain parser is precisely the split contract that rule names.
 *   - "is this tree dirty" → the same `git status --porcelain` non-empty-row
 *     predicate `worktree-reap.mjs::classify` uses.
 *   - "when was this tree last touched" → the reaper's newest-of(root dir mtime,
 *     per-worktree git index mtime), EXTENDED here (see § Two-stage activity) by
 *     the dirty paths' own mtimes. That is a superset of the reaper's signal on
 *     the same clock, not a competing definition of it.
 * The reaper is NOT spawned. Its full pass measured 5.7 s at `--no-size` and
 * ~12 s with sizing on this forest, against a per-turn Stop budget — and it
 * would answer the wrong question at that price. See § Cost.
 *
 * ── The three states, never collapsed ──────────────────────────────────────
 *
 *   CLEAN    — nothing uncommitted. Silent.
 *   WIP      — uncommitted, and the content was touched inside the WIP window.
 *              A live lane is writing right now; this is NORMAL and MUST NOT
 *              alarm. A gate that cannot tell WIP from at-risk gets disabled for
 *              noise within a day, which restores the whole bug class.
 *   AT-RISK  — uncommitted, and the content has been untouched for at least the
 *              WIP window but less than the PARKED window. This is the measured
 *              failure: a lane whose last tool call was refused emits no payload,
 *              goes idle with no summary, and an idle with no summary is
 *              indistinguishable from completion. LOUD.
 *   PARKED   — uncommitted, untouched for longer than the PARKED window. Counted
 *              and reported, never alarmed.
 *   UNMEASURED — the budget ran out before this tree was surveyed. Reported as
 *              its own bucket and NEVER folded into CLEAN: an unmeasured tree
 *              and an empty one print identically in a count, and reading the
 *              former as the latter is the non-discriminating instrument this
 *              file exists to avoid being.
 *
 * WHY PARKED IS A SEPARATE BUCKET AND NOT JUST AT-RISK. Without an upper bound
 * the gate fires forever on trees nobody is coming back for. Measured on the
 * originating forest, the dirty trees are strongly BIMODAL: 7 trees at 0.0–19.7
 * minutes of content-idle (that session's live lanes) and 12 trees at 7,326
 * minutes or more (5+ days). Nothing lands between. A tree idle for days is not
 * "a lane that just went quiet" — it is outside any lane's lifetime, which is the
 * window this gate is scoped to, and the reaper's KEEP verdict plus `/sweep`
 * already own it. So the upper bound is a scope boundary, not noise suppression.
 *
 * ── § Two-stage activity, and why the root mtime alone is not enough ────────
 *
 * The cheap activity proxy (root dir mtime, git index mtime) MISSES a lane that
 * writes files deep in the tree without running a git command: neither stamp
 * moves. Measured on the originating forest, two live lanes would have been
 * misread by the cheap proxy alone —
 *     fixture-payload-exclusion: root idle 38.4 min, content idle  8.9 min
 *     rebase-content-loss:       root idle 12.2 min, content idle  3.6 min
 * — so a 20-minute WIP window over the root mtime would have called an ACTIVE
 * lane at-risk. The authoritative signal is therefore the newest mtime among the
 * DIRTY PATHS themselves, which is exactly what a working lane bumps.
 *
 * That inverts the cheap-first ordering, so the survey runs in two stages:
 *   Stage 1 (free, no subprocess): root+index mtime. Because content idle is the
 *     max over a SUPERSET of those stamps, contentIdle <= rootIdle ALWAYS. So
 *     rootIdle < wipWindow SOUNDLY implies the tree is fresh, and only that
 *     direction is used for pruning. The converse is NOT used: a large rootIdle
 *     implies nothing, which is why parked-looking trees are still surveyed.
 *   Stage 2 (budgeted, one `git status --porcelain` per tree): the dirty paths
 *     and their mtimes. This is what actually classifies.
 *
 * ── § Cost, and the priority order that makes a per-turn gate affordable ────
 *
 * Measured on the originating forest (52 trees, APFS, node v25.9.0): a SERIAL
 * `git status --porcelain` sweep is 5,690 ms (~109 ms/tree); the stage-1 stat
 * sweep over the same 52 trees is 0 ms. 5.7 s per turn is not affordable, and a
 * serial survey under a 3,000 ms budget measured only 11 of the 52 trees — a
 * permanent blind spot on the tail, since the order is deterministic and the
 * forest does not drain. Two things fix that together:
 *   - A BOUNDED WORKER POOL (§ DEFAULT_CONCURRENCY). The work is IO-bound, so
 *     concurrency 8 measured 2,181 ms for all 52 trees against 5,690 serial. The
 *     whole forest now fits inside the budget: re-measured end-to-end through
 *     this module, 2,604 ms, 52 trees surveyed, 0 UNMEASURED.
 *   - RISK-ORDERED DISPATCH, so that when the budget DOES bind (a bigger forest,
 *     a slower disk) it binds on the least valuable trees. See the three tiers
 *     on `surveyForest`.
 * Whatever the budget does not reach is UNMEASURED and says so.
 *
 * There is NO cache and NO stored last-seen state. A per-tree cache would be the
 * forgettable ledger `unlanded-work-surface.js` § "Why age buckets" rejects, and
 * the priority order already makes the steady-state cost bounded by the budget
 * rather than by the forest size.
 *
 * ── FAIL-OPEN ───────────────────────────────────────────────────────────────
 *
 * Per `cc-artifacts.md` Rule 7 every unresolved condition — git absent, non-zero
 * exit, timeout, no worktrees, unreadable state, unparseable config — yields NO
 * finding and lets the turn proceed. Nothing here throws. A conservation gate
 * that can wedge a session destroys more work than the loss it reports.
 *
 * KILL SWITCH: `COC_WORKTREE_CONSERVATION=0` (also `off`/`false`/`no`/
 * `disabled`). DEFAULT ON. An unrecognised value stays ON rather than silently
 * shipping the feature inert (`security.md` § Secure-Default).
 */

const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { parsePorcelain } = require(
  path.join(__dirname, "sibling-porcelain.js"),
);

// ── states ──────────────────────────────────────────────────────────────────

const STATE_CLEAN = "clean";
const STATE_WIP = "wip";
const STATE_AT_RISK = "at-risk";
const STATE_PARKED = "parked";
const STATE_UNMEASURED = "unmeasured";

// ── configuration ───────────────────────────────────────────────────────────

// 60, not 20 (loom#2005). The 20 was fitted to the originating forest's live-lane
// band, which topped out at 19.7 minutes of content-idle — a margin of 0.3 min, or
// 1.5%. Anything slightly slower than that session's slowest lane crossed it, and one
// did: a dispatched agent edited two files and then spent a ~19-gate verification
// battery writing nothing, so the tree read AT-RISK while the agent was alive and
// mid-task. A verification phase is exactly when a lane is quiet and exactly when it
// is doing its most careful work.
//
// MEASURED wall-clock for that quiet phase, from real runs in this repo rather than
// from the shape of the failure: the audit-fixture gate is ~8 min, the full harness
// corpus ~13 min, the two in sequence ~21 min, and a structural CI wait 18-22 min. A
// lane that verifies before landing is silent for well over 20 minutes.
//
// WIDENING IS ALMOST FREE HERE, which is why this is the fix rather than a tolerance
// bump. The recorded distribution is strongly BIMODAL: 7 live lanes at 0.0-19.7 min
// and 12 abandoned trees at 7,326 min or more, with NOTHING in between — a gap of
// five days. Moving the boundary from 20 to 60 lands inside that empty band, so it
// reclassifies ZERO observed trees while buying a 3x margin over the fitted maximum.
// The PARKED window still bounds the other side.
//
// THIS IS A MITIGATION, NOT A LIVENESS SIGNAL, and the difference matters: a window
// moves the line, it does not distinguish an abandoned tree from one being written.
// The real signal is unavailable today, MEASURED rather than assumed — the dispatch
// ledger records `dispatch_name`, `launch_id`, `subagent_type` and `session_id` and
// NO worktree, cwd, dir or path field (0 occurrences across the corpus), so a lane
// cannot be keyed to a tree without first teaching the producer to record one. See
// loom#2005 for that decision.
const DEFAULT_WIP_MINUTES = 60;
const DEFAULT_PARKED_HOURS = 24;
const DEFAULT_BUDGET_MS = 3000;
// Concurrency, MEASURED on the originating 52-tree forest rather than picked.
// One `git status --porcelain` per tree is a working-tree stat walk (~6,000
// files/tree here), so it is IO-bound and parallelises well: serial 5,690 ms;
// at concurrency 4 / 8 / 16 → 2,715 / 2,181 / 2,353 ms for the same 52 trees,
// zero failures at every level. 8 is the measured knee — 16 is no better, and
// oversubscribing the disk would start trading latency for nothing.
const DEFAULT_CONCURRENCY = 8;
const STATUS_TIMEOUT_MS = 3000;
const LIST_TIMEOUT_MS = 3000;

const OFF_TOKENS = new Set(["0", "off", "false", "no", "disabled"]);

/**
 * Read a positive number from the environment, falling back to `dflt`.
 *
 * A garbage value falls back to the DEFAULT and never to zero or to disabled:
 * `COC_CONSERVATION_WIP_MINUTES=abc` silently becoming 0 would classify every
 * dirty tree at-risk, and silently becoming Infinity would classify none. Both
 * are the silent-no-op default `security.md` § Secure-Default forbids.
 */
function envNumber(env, key, dflt) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "")
    return dflt;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return n;
}

function resolveConfig(env = {}) {
  const raw = env.COC_WORKTREE_CONSERVATION;
  const enabled = !(
    raw !== undefined && OFF_TOKENS.has(String(raw).trim().toLowerCase())
  );
  return {
    enabled,
    raw: raw === undefined ? null : String(raw),
    wipMs:
      envNumber(env, "COC_CONSERVATION_WIP_MINUTES", DEFAULT_WIP_MINUTES) *
      60_000,
    parkedMs:
      envNumber(env, "COC_CONSERVATION_PARKED_HOURS", DEFAULT_PARKED_HOURS) *
      3_600_000,
    budgetMs: envNumber(env, "COC_CONSERVATION_BUDGET_MS", DEFAULT_BUDGET_MS),
    concurrency: Math.max(
      1,
      Math.floor(
        envNumber(env, "COC_CONSERVATION_CONCURRENCY", DEFAULT_CONCURRENCY),
      ),
    ),
  };
}

// ── git plumbing (never throws) ─────────────────────────────────────────────

function gitOk(args, opts = {}) {
  const run = opts.exec || execFileSync;
  try {
    const out = run("git", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs || LIST_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, out: typeof out === "string" ? out : "" };
  } catch (e) {
    return { ok: false, out: "", reason: shortReason(e) };
  }
}

function shortReason(e) {
  const s = String((e && (e.stderr || e.message)) || "unknown").trim();
  return s.split("\n")[0].slice(0, 160) || "unknown";
}

/**
 * Newest mtime in ms among `candidates`, or null when none can be stat'ed.
 * NULL IS NOT ZERO: zero would read as "touched at the epoch", i.e. maximally
 * idle, which would push an unreadable tree into PARKED and silence it.
 */
function newestMtimeMs(candidates, statFn) {
  const stat = statFn || fs.statSync;
  let newest = null;
  for (const c of candidates) {
    try {
      const m = stat(c).mtimeMs;
      if (Number.isFinite(m) && (newest === null || m > newest)) newest = m;
    } catch {
      /* absent — one fewer signal, not an error */
    }
  }
  return newest;
}

/**
 * Idle milliseconds from a stamp, CLAMPED AT ZERO.
 *
 * The clamp is load-bearing for the same reason it is in `worktree-reap.mjs`:
 * `statSync().mtimeMs` is a sub-millisecond float while `Date.now()` is a
 * floored integer, so a file written at 1000.7 ms read back at 1000 ms yields a
 * NEGATIVE idle. Negative is `<` every window, which happens to be the safe
 * direction here (fresh ⇒ WIP), but a clock skew putting an mtime in the future
 * lands in the same expression, and leaving it unclamped would make the two
 * cases indistinguishable in the reported number. Measured on the originating
 * forest: one tree reported a content idle of `-0.0` minutes.
 */
function idleMsFrom(stampMs, now) {
  if (!Number.isFinite(stampMs)) return null;
  return Math.max(0, now - stampMs);
}

// ── enumeration (ONE subprocess for the whole forest) ───────────────────────

/**
 * Parse `git worktree list --porcelain` into worktree records.
 *
 * Records are blank-line separated; `bare` / `detached` / `locked` / `prunable`
 * are VALUELESS flag keys. Bare repositories are dropped here — they have no
 * working tree, so `git status` in one cannot answer the conservation question
 * and there is no uncommitted content for it to hold.
 */
function parseWorktreeList(porcelain) {
  const out = [];
  let cur = null;
  for (const raw of String(porcelain || "").split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? true : line.slice(sp + 1);
    if (key === "worktree")
      cur = { path: val, bare: false, prunable: false, branch: null };
    else if (!cur) continue;
    else if (key === "branch")
      cur.branch = String(val).replace(/^refs\/heads\//, "");
    else cur[key] = val;
  }
  if (cur) out.push(cur);
  return out.filter((w) => w.path && !w.bare);
}

/**
 * Enumerate the forest. Returns {ok:true, trees, gitCommonDir} when git
 * ANSWERED — `trees` may legitimately be empty — or {ok:false, reason} when it
 * could NOT answer. The two are never interchangeable.
 */
function enumerateWorktrees(repoDir, opts = {}) {
  if (!repoDir || typeof repoDir !== "string") {
    return { ok: false, trees: [], reason: "no repoDir supplied" };
  }
  const list = gitOk(["worktree", "list", "--porcelain"], {
    ...opts,
    cwd: repoDir,
  });
  if (!list.ok)
    return {
      ok: false,
      trees: [],
      reason: `git worktree list failed: ${list.reason}`,
    };

  const common = gitOk(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      ...opts,
      cwd: repoDir,
    },
  );
  // The common dir only locates the per-worktree `index` stamp, which is ONE of
  // two stage-1 signals. Losing it degrades the proxy; it does not invalidate
  // the survey, so this is not a fail-open trigger.
  const gitCommonDir = common.ok ? common.out.trim() : null;

  return {
    ok: true,
    trees: parseWorktreeList(list.out),
    gitCommonDir,
    reason: null,
  };
}

// ── per-tree measurement ────────────────────────────────────────────────────

/** Stage-1 stamp: root dir + per-worktree git index. No subprocess. */
function rootActivityMs(treePath, gitCommonDir, statFn) {
  const candidates = [treePath];
  if (gitCommonDir)
    candidates.push(
      path.join(gitCommonDir, "worktrees", path.basename(treePath), "index"),
    );
  return newestMtimeMs(candidates, statFn);
}

/**
 * `git status --porcelain` for one tree, ASYNC. Resolves — never rejects — to
 * {ok, out} or {ok:false, reason}.
 *
 * Async so the survey can run a bounded worker pool (see `surveyForest`), which
 * is what makes a whole forest measurable inside a per-turn budget. It also
 * makes the hook's `cc-artifacts.md` Rule 7 timer REAL: a `setTimeout` cannot
 * interrupt an `execFileSync` (the timer callback is only delivered once the
 * stack unwinds), so a synchronous survey would leave that fallback decorative —
 * the limitation `worktree-forest-guard.js` records verbatim about its own timer.
 */
function statusAsync(treePath, opts = {}) {
  const run = opts.execFile || execFile;
  return new Promise((resolve) => {
    try {
      run(
        "git",
        ["-C", treePath, "status", "--porcelain"],
        {
          encoding: "utf8",
          timeout: opts.statusTimeoutMs || STATUS_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
        },
        (err, stdout) => {
          if (err) resolve({ ok: false, reason: shortReason(err) });
          else
            resolve({
              ok: true,
              out: typeof stdout === "string" ? stdout : "",
            });
        },
      );
    } catch (e) {
      resolve({ ok: false, reason: shortReason(e) });
    }
  });
}

/**
 * Stage-2 measurement for one tree: dirty-path count and the newest mtime among
 * those paths. Resolves {measured:false, reason} when git could not answer —
 * NEVER {dirty:0}, which would launder an unreadable tree into a clean one and
 * so could not discriminate the hypothesis it is cited for.
 */
/**
 * Paths a tree may hold uncommitted WITHOUT that being work at risk, because
 * the operator has decided they stay untracked.
 *
 * DEFAULT is `.claude/.scratch/` alone, and the bar for adding another is high: a
 * prefix belongs here ONLY when committing its contents is FORBIDDEN, not merely
 * unattractive. Anything else is work, and work is what this guard exists to
 * refuse to lose. `.claude/.scratch/` qualifies on the strict reading: it is
 * gitignored AND carries a `sync-manifest.yaml::exclude` fate, so committing it
 * is forbidden rather than merely discouraged.
 *
 * This entry is the SECOND fence, not the first, and the distinction is measured
 * rather than assumed. `statusAsync` runs a plain `git status --porcelain`, which
 * does NOT list gitignored paths — verified two-pole on this tree: a file created
 * under `.claude/.scratch/` yields 0 matches under `--porcelain` and 1 under
 * `--porcelain --ignored`. So gitignore alone already keeps scratch out of the
 * dirty set, and this prefix only becomes load-bearing if a scratch path is
 * force-added or the status flags ever gain `--ignored`.
 *
 * It replaces the former `.claude/.prb/` entry, whose directory no longer exists:
 * `.prb` was an UNDECLARED mixed surface (staging text + durable findings, 46
 * tracked files in nine days, no gitignore rule and no manifest fate), and it was
 * split by kind — durable findings to `workspaces/`, staging to `.claude/.scratch/`.
 * Leaving the dead prefix here would have been an exclusion that excludes nothing.
 *
 * `COC_CONSERVATION_EXCLUDE` REPLACES the default rather than extending it, so an
 * operator can narrow it as well as widen it; an empty value means "exclude
 * nothing", which is the strictest setting and is deliberately reachable.
 */
const DEFAULT_EXCLUDES = [".claude/.scratch/"];

function resolveExcludes(env) {
  const raw = (env || {}).COC_CONSERVATION_EXCLUDE;
  if (typeof raw !== "string") return DEFAULT_EXCLUDES.slice();
  if (raw.trim() === "") return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function measureTree(treePath, opts = {}) {
  const existsFn = opts.existsSync || fs.existsSync;
  if (!existsFn(treePath))
    return { measured: false, reason: "worktree directory absent" };

  const st = await statusAsync(treePath, opts);
  if (!st.ok)
    return { measured: false, reason: `git status failed: ${st.reason}` };

  const all = parsePorcelain(st.out);
  if (all.length === 0)
    return { measured: true, dirty: 0, excluded: 0, contentMs: null };

  // DECLARED EXCLUSION, not per-finding suppression — the shape
  // `observability.md` Rule 5a mandates for exactly this class one layer down
  // (an audit log whose CONTENT trips a WARN+ scanner is excluded by NAME, never
  // by tweaking the regex until the finding stops).
  //
  // WHY THIS IS NEEDED, measured 2026-08-27: this guard fired on its own author's
  // tree at 103 uncommitted paths, of which every one lived under
  // `.claude/.prb/` — a directory the operator has standing instructions never to
  // `git add`. The finding was therefore NOT AGENT-CLEARABLE: the remedy the
  // report names (commit it) is forbidden, so a refusal would spend its whole
  // budget and hand back anyway. That is the precise disposition this guard's own
  // producer comment BARS, so without this the guard fails its own admission test
  // — and a gate that cries wolf every session is a gate that gets switched off,
  // taking the real findings with it.
  //
  // The exclusion is PREFIX-keyed and DECLARED, and what it removed is REPORTED
  // (`excluded`) rather than silently subtracted: a caller must be able to tell
  // "nothing at risk" from "everything at risk was excluded".
  const excludes = resolveExcludes(opts.env || process.env);
  const paths = all.filter((p) => !excludes.some((e) => p.startsWith(e)));
  const excluded = all.length - paths.length;
  if (paths.length === 0)
    return { measured: true, dirty: 0, excluded, contentMs: null };

  const abs = paths.map((p) => path.join(treePath, p.replace(/\/+$/, "")));
  return {
    measured: true,
    dirty: paths.length,
    excluded,
    contentMs: newestMtimeMs(abs, opts.statSync),
  };
}

// ── classification (PURE) ───────────────────────────────────────────────────

/**
 * Classify ONE tree from measured facts. Pure: no git, no fs, no clock.
 *
 * @param {object} facts  {measured, dirty, contentIdleMs, rootIdleMs, reason}
 * @param {object} cfg    {wipMs, parkedMs}
 *
 * `contentIdleMs` is authoritative when present. It falls back to `rootIdleMs`
 * only when every dirty path failed to stat (a race against a lane deleting the
 * file it just wrote), and to WIP when neither is known — the fail-open
 * direction, because an unknowable age must not manufacture an alarm.
 */
function classifyTree(facts, cfg) {
  if (!facts || facts.measured !== true) return STATE_UNMEASURED;
  if (!facts.dirty) return STATE_CLEAN;

  const idle = Number.isFinite(facts.contentIdleMs)
    ? facts.contentIdleMs
    : Number.isFinite(facts.rootIdleMs)
      ? facts.rootIdleMs
      : null;
  if (idle === null) return STATE_WIP;
  if (idle < cfg.wipMs) return STATE_WIP;
  if (idle >= cfg.parkedMs) return STATE_PARKED;
  return STATE_AT_RISK;
}

// ── the survey (impure; one subprocess per surveyed tree, under budget) ─────

/**
 * Survey the forest. Never throws; returns {ok:false, reason} when the forest
 * itself could not be enumerated.
 *
 * SURVEY ORDER IS RISK ORDER, not forest order — see § Cost in the header.
 * The three tiers are structural, not an accident of sorting:
 *   P1  wipMs <= rootIdle < parkedMs, ordered by rootIdle ASCENDING. The at-risk
 *       window by the free stage-1 proxy — the lane that went quiet most
 *       recently is surveyed FIRST. A tree with NO readable stage-1 stamp sorts
 *       here too: unknown activity is treated as possibly-quiet and surveyed,
 *       never assumed live.
 *   P2  rootIdle < wipMs. Sound-fresh (contentIdle <= rootIdle), so it can only
 *       be WIP or CLEAN and can never produce a finding. Surveyed only to keep
 *       those two states distinct in the denominator line.
 *   P3  rootIdle >= parkedMs. Reachable as at-risk ONLY through a deep-file
 *       write in a tree whose root and index stamps have not moved in over the
 *       parked window — real, but the rarest shape, so it is surveyed last
 *       rather than dropped.
 * Making the tiers explicit is what turns "the budget happens to land on the
 * risk" into a guarantee: every P1 task is DISPATCHED before any P2 or P3 task
 * starts, so a budget that binds can only ever strand the cheaper questions.
 * Measured on the originating 52-tree forest at the 3,000 ms default with the
 * worker pool: 52 surveyed, 0 UNMEASURED, 2,604 ms — the budget does not bind at
 * that size at all. The tiering is what keeps the failure mode benign when it
 * does.
 */
async function surveyForest(repoDir, cfg, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const forest = enumerateWorktrees(repoDir, opts);
  if (!forest.ok)
    return { ok: false, reason: forest.reason, trees: [], counts: null };

  const staged = forest.trees.map((w) => {
    const rootMs = rootActivityMs(w.path, forest.gitCommonDir, opts.statSync);
    const rootIdleMs = idleMsFrom(rootMs, now);
    // Tier by the FREE stage-1 stamp. An unreadable stamp ranks P1 (possibly
    // quiet), never P2 (assumed live) — the fail-toward-surveying direction.
    const tier =
      rootIdleMs === null
        ? 1
        : rootIdleMs < cfg.wipMs
          ? 2
          : rootIdleMs >= cfg.parkedMs
            ? 3
            : 1;
    return {
      path: w.path,
      name: path.basename(w.path),
      branch: w.branch,
      rootIdleMs,
      tier,
    };
  });

  const order = staged
    .slice()
    .sort(
      (a, b) => a.tier - b.tier || (a.rootIdleMs ?? -1) - (b.rootIdleMs ?? -1),
    );

  const started = Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now();
  const elapsed = opts.elapsed || (() => Date.now() - started);

  // A BOUNDED WORKER POOL over the tier-ordered queue. Workers shift from ONE
  // shared queue, so the tier ordering is preserved as a dispatch order: P1 is
  // handed out before any P2 or P3 task starts, and the budget therefore still
  // lands on the risk. Results are written back by index so the output order is
  // the queue order regardless of which worker finished first.
  const trees = new Array(order.length);
  let budgetExhausted = false;
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= order.length) return;
      const t = order[i];
      if (elapsed() >= cfg.budgetMs) {
        budgetExhausted = true;
        trees[i] = {
          ...t,
          state: STATE_UNMEASURED,
          dirty: null,
          contentIdleMs: null,
          reason: "survey budget exhausted",
        };
        continue;
      }
      const m = await measureTree(t.path, opts);
      const contentIdleMs = m.measured ? idleMsFrom(m.contentMs, now) : null;
      const facts = {
        measured: m.measured,
        dirty: m.dirty,
        contentIdleMs,
        rootIdleMs: t.rootIdleMs,
      };
      trees[i] = {
        ...t,
        state: classifyTree(facts, cfg),
        dirty: m.measured ? m.dirty : null,
        contentIdleMs,
        reason: m.measured ? null : m.reason,
      };
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(cfg.concurrency || 1, Math.max(1, order.length)) },
      worker,
    ),
  );

  const counts = {};
  for (const s of [
    STATE_CLEAN,
    STATE_WIP,
    STATE_AT_RISK,
    STATE_PARKED,
    STATE_UNMEASURED,
  ]) {
    counts[s] = trees.filter((t) => t.state === s).length;
  }
  return {
    ok: true,
    reason: null,
    trees,
    counts,
    budgetExhausted,
    census: forest.trees.length,
  };
}

// ── the finding predicate (PURE) ────────────────────────────────────────────

const KIND_AT_RISK = "uncommitted-at-risk";

/**
 * Decide whether this survey is a finding. Pure: no git, no clock, no fs.
 *
 * Order is load-bearing:
 *   1. Survey failed → null. Reporting on a forest that could not be enumerated
 *      would be asserting from an errored command
 *      (`evidence-first-claims.md` MUST-3).
 *   2. No AT-RISK tree → null. THIS is the anti-cry-wolf gate, and it is what
 *      makes the gate affordable to leave on: a forest of live lanes (all WIP)
 *      and long-parked trees produces nothing. Measured on the originating
 *      52-tree forest, 19 of which were dirty: zero at-risk, so silent.
 *   3. Otherwise → a finding carrying the at-risk trees AND every other bucket,
 *      so a reader is never shown an at-risk count without the denominators.
 */
function evaluateConservation(survey) {
  if (!survey || survey.ok !== true || !survey.counts) return null;
  const atRisk = survey.trees.filter((t) => t.state === STATE_AT_RISK);
  if (atRisk.length === 0) return null;
  return {
    kind: KIND_AT_RISK,
    census: survey.census,
    counts: survey.counts,
    budgetExhausted: survey.budgetExhausted === true,
    atRisk: atRisk
      .slice()
      .sort((a, b) => (b.dirty || 0) - (a.dirty || 0))
      .map((t) => ({
        name: t.name,
        path: t.path,
        branch: t.branch,
        dirty: t.dirty,
        idleMinutes: Number.isFinite(t.contentIdleMs)
          ? Math.round(t.contentIdleMs / 60_000)
          : null,
      })),
  };
}

// ── rendering ───────────────────────────────────────────────────────────────

function fmtIdle(min) {
  if (!Number.isFinite(min)) return "idle for an unknown period";
  if (min < 90) return `idle ${min} min`;
  return `idle ${(min / 60).toFixed(1)} h`;
}

function reportLines(finding) {
  const lines = [];
  const n = finding.atRisk.length;
  lines.push(
    `State that ${n} worktree${n === 1 ? "" : "s"} hold${n === 1 ? "s" : ""} UNCOMMITTED work that has gone quiet — unstaged and untracked files have NO reflog and exist in exactly ONE place on disk:`,
  );
  for (const t of finding.atRisk) {
    lines.push(
      `  - ${t.name} (${t.branch || "detached"}) — ${t.dirty} uncommitted path${t.dirty === 1 ? "" : "s"}, ${fmtIdle(t.idleMinutes)}: ${t.path}`,
    );
  }
  lines.push(
    "For EACH tree above: an idle lane with no summary is indistinguishable from a finished one, so do not assume it completed. Inspect it (`git -C <path> status --porcelain`), then either commit the work on its branch or report to the operator what it holds and why it stopped.",
  );
  lines.push(
    `State the denominators so the count is readable: ${finding.census} tree(s) in the forest — ${finding.counts[STATE_WIP]} actively being written (normal), ${finding.counts[STATE_CLEAN]} clean, ${finding.counts[STATE_PARKED]} long-parked, ${finding.counts[STATE_UNMEASURED]} UNMEASURED.`,
  );
  if (finding.budgetExhausted) {
    lines.push(
      `State that the survey budget was exhausted, so ${finding.counts[STATE_UNMEASURED]} tree(s) were NOT surveyed — that is UNKNOWN, not clean. Run \`node .claude/bin/worktree-reap.mjs --no-size\` for a full per-tree read.`,
    );
  }
  return lines;
}

function summarize(finding) {
  const n = finding.atRisk.length;
  const files = finding.atRisk.reduce((a, t) => a + (t.dirty || 0), 0);
  return `${n} worktree(s) hold ${files} uncommitted path(s) that have gone quiet — no reflog, one copy on disk`;
}

module.exports = {
  STATE_CLEAN,
  STATE_WIP,
  STATE_AT_RISK,
  STATE_PARKED,
  STATE_UNMEASURED,
  KIND_AT_RISK,
  DEFAULT_WIP_MINUTES,
  DEFAULT_PARKED_HOURS,
  DEFAULT_BUDGET_MS,
  resolveConfig,
  enumerateWorktrees,
  parseWorktreeList,
  rootActivityMs,
  DEFAULT_EXCLUDES,
  resolveExcludes,
  measureTree,
  classifyTree,
  surveyForest,
  evaluateConservation,
  reportLines,
  summarize,
  _internal: { envNumber, idleMsFrom, newestMtimeMs, fmtIdle },
};
