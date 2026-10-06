/**
 * wip-lanes.js — the LANE model behind `rules/wip-discipline.md`.
 *
 * A lane is one unit of work: intent → branch → worktree → commits → push → PR →
 * merge → cleanup. Its value is realised only at merge; until then it is
 * inventory. This module answers three questions and nothing else:
 *
 *   1. How many lanes are OPEN right now?           (MUST-2, the WIP limit)
 *   2. Which lanes are past the age bound?          (MUST-3, age governs)
 *   3. Is THIS tree safe to remove?                 (MUST-6, empty vs dirty)
 *
 * IT IS A DUMB DATA ENDPOINT. It computes facts about refs and directories and
 * returns them. It does not decide whether a lane SHOULD land — that is the
 * operator's judgment.
 *
 * WHAT THAT DOES AND DOES NOT IMPLY, corrected 2026-08-23. This header used to
 * finish that sentence with "and `rules/wip-discipline.md` § Trust Posture
 * Wiring records why no surface here carries `block`". That clause is WITHDRAWN
 * as false: the spawn guard now DOES carry `block`. The reasoning it rested on
 * conflated two questions — whether a lane should LAND (a judgment, still the
 * operator's, still un-gated) and whether one more may OPEN past a measured
 * limit (a git-object fact, now refused with a recorded override). This module
 * stays a dumb data endpoint either way; what changed is what the CALLER does
 * with the numbers. `confirmAtLimit` below is the predicate the refusal is
 * taken on, and it is deliberately a LOWER bound for that reason.
 *
 * ── THREE MEASURED DEFECTS THIS MODULE EXISTS TO NOT REPEAT ────────────────
 *
 * E2 — EMPTY IS NOT DIRTY. A `git worktree add --no-checkout` tree has NO index
 * file, so `git status --porcelain` reports EVERY path in HEAD as a staged
 * deletion. Measured: 6917 "dirty paths" on a tree whose total disk size is
 * 4.0K and whose only entry is its own `.git` file. A predicate that reads that
 * as work pins the tree KEEP forever — it stayed KEEP even at
 * `--min-age-hours 0` — so the unattended reaper could never clear it, and every
 * crashed harness run left another. `classifyTree` below tests for the index
 * FIRST, and a tree with no index and no unpushed commits is ZERO-LOSS.
 *
 * E3 — AGE IS FROM CREATION, NEVER mtime. The prior reaper derived a tree's age
 * from its directory mtime and reported 11.1h for a tree whose reflog showed
 * ~44h. Any later touch — a checkout, a stat-updating scan — resets rot to
 * fresh, which is the one direction that must never happen for an ageing
 * metric. `treeAgeHours` reads the worktree's own reflog; `branchAgeHours`
 * reads the first unique commit's AUTHOR date.
 *
 * E4 — REPORT ONLY WHAT IS ACTIONABLE. loom#1885 measured the prior unlanded
 * surface at 63% noise, after which its reader correctly learned to ignore it.
 * `openLanes` classifies by CONTENT (`git cherry` patch-ids), not by
 * reachability, and separates LOCAL-ONLY from pushed — because a pushed branch
 * is recoverable from anywhere and a local-only one is not.
 *
 * E5 — LANDED IS RECORDED, NOT RECONSTRUCTED (landing provenance). Every
 * "is this lane landed?" decision here now consults the `Landed-From` trailers
 * written AT LANDING TIME (`landed-map.js::landedVerdict`) BEFORE any content
 * comparison; `git cherry` runs only where that verdict falls back (no config,
 * a branch predating the cutover, pure ancestry). See `_laneContent` below. The
 * patch-id bound in the next section therefore describes the FALLBACK path only.
 *
 * ── THE BOUND ON CONTENT CLASSIFICATION, STATED NOT IMPLIED ────────────────
 *
 * `git cherry` compares PATCH-IDS. It detects rebases and cherry-picks, and it
 * CANNOT see a squash-merge whose combined patch matches no single commit. Every
 * unique-content count this module returns is therefore an UPPER BOUND, and it
 * says so in the record it returns (`contentBound: "upper"`). A caller that
 * drops that qualifier is making a claim this module did not make.
 *
 * FAIL-OPEN / FAIL-HONEST. Every git call can fail. A question that could not be
 * answered returns `null`, never a zero — `instrument-discipline.md` MUST-1: an
 * unanswerable check is not evidence of a clean answer, and a `0` here would be
 * indistinguishable from "no lanes".
 */

"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
// The ONE parser for "does this command invoke `git <subcommand>`". Consumed
// rather than reimplemented — see `laneCreationIntent` for why a private regex
// here would re-open a measured bypass class.
const { parseGitInvocations, stripShellGroupDelimiters } = require(
  path.join(__dirname, "git-command-parse.js"),
);
// ONE landedness predicate for the whole repo, never a second copy
// (`security.md` § Enforcement-Surface Parity). `reap-on-landing.js` is PURE —
// it owns the READING of `git cherry` output; this module owns the SPAWNING.
const {
  resolveTrunk,
  resolveTrunkFromRefs,
  matchRefInSet,
  nonLaneBranches,
} = require(path.join(__dirname, "trunk-ref.js"));
const { isLandedByContent, isProtectedName } = require(
  path.join(__dirname, "reap-on-landing.js"),
);

const { resolveGitBinary, gitEnv } = require(
  path.join(__dirname, "git-subprocess-env.js"),
);
// LANDING PROVENANCE — the recorded answer to "was this branch landed?". Held as
// the MODULE OBJECT (never destructured) so every call reads the export at call
// time: one policy (`landed-map.js::landedVerdict`), never a local re-derivation.
const LM = require(path.join(__dirname, "landed-map.js"));

/* ── LANDING PROVENANCE FIRST, CONTENT COMPARISON ONLY WHERE IT IS ALLOWED ────
 *
 * Every "is this lane landed?" decision in this module consults the recorded
 * provenance BEFORE any content comparison. Landing rewrites commits (replay,
 * squash, conflict fix, reformat), so `git cherry` patch-ids and ancestry answer a
 * DIFFERENT question from "was this branch landed?" and misreport in both
 * directions: a conflict-resolved landing has a DIFFERENT patch-id from its
 * source and read OPEN forever; a post-cutover branch whose patch merely HAPPENS
 * to be on the trunk read LANDED although nothing landed it. The policy is
 * `landed-map.js::landedVerdict` / `landedVerdicts` (the three-way policy is
 * `.claude/hooks/lib/landed-map.js::_verdictOf` plus `::_mapFailureVerdict`,
 * cited by SYMBOL because the core is still moving), applied here verbatim:
 *
 *   decided:true                    -> `landed` decides; no content comparison runs
 *   decided:false, fallback:true    -> the legacy `git cherry` comparison runs
 *                                      (predates / ancestry / no-config)
 *   decided:false, fallback:false   -> UNMEASURED — never landed, never reapable
 *                                      (unknown, and no-map: the config EXISTS
 *                                      but its map could not be built)
 *
 * The map is built ONCE per process per (repoDir, trunk) — a hook invocation is
 * one process — and re-validated against the trunk's CURRENT tip and cutover on
 * every public call, so a long-lived caller never judges against a stale map. The
 * trunk passed as `ref` is the SAME `baseRef` the legacy comparison uses, so both
 * instruments judge one tip. A repo without `.claude/bin/landing-provenance.json`
 * (every downstream consumer) builds no map and keeps the legacy behaviour exactly
 * (`status:"no-config"`, fallback) at ZERO added git spawns: the config is
 * located by a filesystem walk (`_toplevelFor`), never by a git call. */
const _landedMapMemo = new Map();
const _toplevelMemo = new Map();

/**
 * The checkout toplevel for `repoDir` — the nearest ancestor-or-self holding a
 * `.git` entry (directory, or the file a linked worktree carries), which is the
 * directory git's own discovery stops at. FILESYSTEM ONLY, memoised per process.
 *
 * WHY NOT `landed-map.js::loadConfig(repoDir)` ALONE. When the config is absent
 * at `repoDir` it spawns `git rev-parse --show-toplevel` to look again at the
 * toplevel (`.claude/hooks/lib/landed-map.js::loadConfig`) — which in a repo with NO
 * config (every downstream consumer) is EVERY call, on the tool-call hot path,
 * and it breaks `laneSurvey`'s pinned spawn budget. Passing the toplevel found
 * here makes its first `existsSync` answer, so the spawn never happens.
 * Unresolvable (no `.git` up to the filesystem root) ⇒ `repoDir` itself, and
 * `loadConfig` keeps its own fallback.
 */
function _toplevelFor(repoDir) {
  if (!_toplevelMemo.has(repoDir)) {
    let top = repoDir;
    try {
      let d = path.resolve(repoDir);
      for (;;) {
        if (fs.existsSync(path.join(d, ".git"))) {
          top = d;
          break;
        }
        const up = path.dirname(d);
        if (up === d) break;
        d = up;
      }
    } catch {
      top = repoDir;
    }
    _toplevelMemo.set(repoDir, top);
  }
  return _toplevelMemo.get(repoDir);
}

function _landedMapFor(repoDir, baseRef, timeoutMs = GIT_TIMEOUT_MS) {
  const cfg = LM.loadConfig(_toplevelFor(repoDir));
  if (!cfg.ok) {
    // No config ⇒ nothing to build and nothing to spawn; the verdict reports
    // `no-config` and the caller falls back. A MALFORMED config is `no-map`
    // (noConfig:false): UNMEASURED, never handed to `git cherry`.
    return { ok: false, noConfig: Boolean(cfg.absent), why: cfg.why };
  }
  // The trunk tip is resolved HERE only to VALIDATE a memo entry. On a cold
  // call (every hook invocation: one process, one call) there is no entry, and
  // `buildLandedMap` resolves the tip itself — a second rev-parse here was a
  // pure duplicate spawn on the tool-call hot path. The memo is keyed on the
  // tip the MAP was built for (`map.tip`), so the two can never disagree.
  const key = `${repoDir}\0${baseRef}`;
  const hit = _landedMapMemo.get(key);
  if (hit && hit.map && hit.map.ok && hit.cutover === cfg.config.cutover) {
    let tip = null;
    try {
      tip = LM.resolveCommit(repoDir, baseRef, { timeoutMs });
    } catch {
      tip = null; // "could not ask" never re-uses a map: rebuild below
    }
    if (tip && hit.map.tip === tip) return hit.map;
  }
  // buildLandedMap never throws; a failed build is `ok:false` and is not
  // memoised as reusable (the guard above requires `hit.map.ok`).
  const map = LM.buildLandedMap({ repoDir, ref: baseRef, config: cfg.config, timeoutMs });
  _landedMapMemo.set(key, { cutover: cfg.config.cutover, map });
  return map;
}

/** Test hook: forget every memoised map and toplevel. */
function _resetLandedMapMemo() {
  _landedMapMemo.clear();
  _toplevelMemo.clear();
}

/** Fold one core verdict into the three outcomes the callers act on. */
function _outcomeOf(v) {
  if (v && v.decided === true) {
    return { outcome: v.landed ? "landed" : "open", instrument: "provenance", verdict: v };
  }
  if (v && v.decided === false && v.fallback === true) {
    return { outcome: "fallback", instrument: null, verdict: v };
  }
  return { outcome: "unmeasured", instrument: "provenance", verdict: v || {} };
}

/**
 * The provenance verdict for ONE branch ref. `instrument` names WHAT decided, so
 * a message can say so.
 *   { outcome:"landed",     instrument:"provenance", verdict }
 *   { outcome:"open",       instrument:"provenance", verdict }  (partial | not-landed)
 *   { outcome:"fallback",   instrument:null,         verdict }  (caller's legacy test)
 *   { outcome:"unmeasured", instrument:"provenance", verdict }  (never landed)
 * `prebuilt` is the caller's once-per-call map; `timeoutMs` bounds EACH of the
 * verdict's git spawns inside the caller's budget.
 */
function _provenance(repoDir, baseRef, branchRef, branchName, prebuilt = null, { tip, timeoutMs } = {}) {
  let v;
  try {
    const map = prebuilt || _landedMapFor(repoDir, baseRef, timeoutMs);
    v = LM.landedVerdict({ repoDir, branchRef, branchName, map, ref: baseRef, tip, timeoutMs });
  } catch (e) {
    // landedVerdict is documented never to throw; a throw here is therefore an
    // UNKNOWN, and UNKNOWN is never landed.
    v = { decided: false, fallback: false, status: "unknown", why: String((e && e.message) || e) };
  }
  return _outcomeOf(v);
}

/**
 * Is a lane's content on the trunk? Provenance FIRST, `git cherry` only on
 * fallback. Returns `{ unique, shas, instrument, status }`:
 *   unique      number of UNLANDED source commits, or null when UNMEASURED
 *   shas        those commits (for the age door's committer dates), or null
 *   instrument  "provenance" | "content" | "unmeasured"
 * `unique:0` is a LANDED lane. A provenance "open" returns the core's
 * `outstanding` list — the source commits no trailer covers.
 */
function _laneContent(repoDir, baseRef, branchRef, branchName, timeout, prebuilt = null) {
  const p = _provenance(repoDir, baseRef, branchRef, branchName, prebuilt, { timeoutMs: timeout });
  if (p.outcome === "landed") {
    return { unique: 0, shas: [], instrument: "provenance", status: p.verdict.status };
  }
  if (p.outcome === "open") {
    const shas = Array.isArray(p.verdict.outstanding) ? p.verdict.outstanding.slice() : [];
    // The core APPENDS the branch's own MERGE commits to `outstanding`
    // (`landed-map.js::branchStatus`, `outstandingMerges`); they are counted, but
    // named apart so an age reader never mistakes a merge for the oldest work.
    const merges = Array.isArray(p.verdict.outstandingMerges) ? p.verdict.outstandingMerges.slice() : [];
    return { unique: shas.length, shas, merges, instrument: "provenance", status: p.verdict.status };
  }
  if (p.outcome === "unmeasured") {
    return {
      unique: null,
      shas: null,
      instrument: "unmeasured",
      status: p.verdict.status || "unknown",
      why: p.verdict.why || null,
    };
  }
  const out = _git(["cherry", baseRef, branchRef], { cwd: repoDir, timeout });
  if (out === null) return { unique: null, shas: null, instrument: "content", status: p.verdict.status };
  const shas = (out ? out.split("\n") : [])
    .filter((l) => l.startsWith("+"))
    .map((l) => l.slice(1).trim())
    .filter(Boolean);
  return { unique: shas.length, shas, instrument: "content", status: p.verdict.status };
}

/**
 * The OLDEST committer date (epoch seconds) over a lane's unlanded NON-MERGE
 * commits, from ONE `git show -s --format=%ct%x09%P`, or null when unknown.
 *
 * `content` is `_laneContent`'s result. Its `shas` are newest-first on the
 * provenance path (the core's `outstanding`, `git rev-list` order, with the
 * branch's own merges APPENDED — `landed-map.js::branchStatus`) and oldest-first
 * on the cherry path. A merge is not the lane's work: its committer date is the
 * date someone merged, so it is excluded twice — by the core's own
 * `outstandingMerges` list BEFORE the `maxShas` cap (so the cap keeps the oldest
 * NON-merge end), and by its parent count in the output (the cherry path has no
 * such list). The MIN is taken, so emission order never decides the answer.
 * Null (git failed, nothing parseable, no non-merge commit) is UNKNOWN, never
 * "young".
 */
function _oldestUnlandedCommitSeconds(content, { cwd, timeout, maxShas = 50 } = {}) {
  if (!content || !Array.isArray(content.shas) || content.shas.length === 0) return null;
  const merges = new Set(content.merges || []);
  const nonMerge = content.shas.filter((s) => !merges.has(s));
  const oldestFirst = content.instrument === "provenance" ? nonMerge.slice().reverse() : nonMerge;
  if (oldestFirst.length === 0) return null;
  const asked = oldestFirst.slice(0, maxShas);
  const out = _git(["show", "-s", "--format=%ct%x09%P", ...asked], { cwd, timeout });
  if (out === null) return null;
  // STRICT: exactly one well-formed line per commit asked, or UNKNOWN. A stray
  // line (a signature check a repo config slipped into the output) or a garbled
  // one is never skipped: skipping could drop the OLDEST commit and report the
  // lane younger than it is — the one error direction an age must not have.
  // A root commit's empty %P may lose its tab to `_git`'s trim, hence `\t?`.
  const lines = out.split("\n");
  if (lines.length !== asked.length) return null;
  const ts = [];
  for (const line of lines) {
    const m = /^(\d+)(?:\t([0-9a-f]+(?: [0-9a-f]+)*)?)?$/.exec(line);
    if (!m) return null;
    const parents = m[2] ? m[2].split(" ").length : 0;
    if (parents <= 1) ts.push(Number(m[1]));
  }
  const valid = ts.filter((n) => Number.isFinite(n) && n > 0);
  return valid.length ? Math.min(...valid) : null;
}

/**
 * The ancestry-candidate filter shared by `laneCountFast` and `laneSurvey`: drop
 * the lanes the PROVENANCE decides are landed. Those two surfaces never ran a
 * content comparison, so only a `decided:true, landed:true` verdict changes their
 * answer — every other outcome (open, fallback, UNMEASURED, budget-unreached)
 * leaves the lane counted, exactly as before.
 *
 * THE PREFILTER IS EXACT, not a heuristic. `classifyBranch`
 * (`.claude/hooks/lib/landed-map.js::classifyBranch`) returns `landed` only when own
 * commits are NON-EMPTY and ALL covered by a trailer (own-empty is `ancestry`,
 * whatever a trailer names). Own commits are `rev-list --no-merges`, so they
 * include the tip unless the tip is a merge commit. A lane whose tip no trailer
 * covers and whose tip is not a merge therefore cannot be decided landed, and
 * paying the verdict's spawns on it would change nothing. With no config the map
 * is `ok:false` and nothing is spawned for it.
 *
 * The survivors go through the core's BULK form (`landedVerdicts`,
 * `.claude/hooks/lib/landed-map.js::landedVerdicts`) with their tips supplied — two spawns
 * per lane, the fork test memoised — bounded by `budgetMs`; a lane the budget
 * never reaches is UNMEASURED and stays counted.
 */
function _dropProvenanceLanded(repoDir, baseRef, rows, { budgetMs = 2000, timeoutMs = 2000 } = {}) {
  const map = _landedMapFor(repoDir, baseRef, timeoutMs);
  if (!map || !map.ok) return { kept: rows, landed: [], map, mapStatus: map && map.noConfig ? "no-config" : "no-map" };
  const probe = rows.filter(
    (r) => !r.sha || r.mergeTip === true || map.bySource.has(r.sha),
  );
  const landedNames = new Set();
  if (probe.length) {
    let verdicts;
    try {
      verdicts = LM.landedVerdicts({
        repoDir,
        branches: probe.map((r) => ({ ref: `refs/heads/${r.name}`, name: r.name, tip: r.sha || undefined })),
        map,
        ref: baseRef,
        timeoutMs,
        budgetMs,
      });
    } catch {
      verdicts = []; // UNKNOWN is never landed: every lane stays counted
    }
    for (const v of verdicts) if (_outcomeOf(v).outcome === "landed") landedNames.add(v.name);
  }
  const kept = rows.filter((r) => !landedNames.has(r.name));
  const landed = rows.filter((r) => landedNames.has(r.name)).map((r) => r.name);
  return { kept, landed, map, mapStatus: "ok" };
}

/** Operator-ratified 2026-08-22. Both are CONTRACT, not tuning knobs: the rule
 *  body states them, so changing one here without changing the rule creates the
 *  prose-vs-code drift `zero-tolerance.md` Rule 3e blocks. */
const WIP_LIMIT = 5;
const AGE_BOUND_HOURS = 24;

/** Per-call git budget. A guard that can wedge a session is worse than the
 *  inventory it reports (`cc-artifacts.md` Rule 7). */
const GIT_TIMEOUT_MS = 5000;

/**
 * THE ONE git funnel for this module — routed through the shared envelope
 * (`lib/git-subprocess-env.js`), never a bare `spawnSync("git", …)`.
 *
 * WHY THE ENVELOPE, not a bare spawn. `GIT_DIR` outranks repository DISCOVERY,
 * so `cwd:` alone does NOT pin which repository answers. A bare spawn hands the
 * child the ambient environment and one planted variable re-points every
 * question this module asks — the lane inventory would then be the ATTACKER's
 * branches, reported as this operator's WIP. `resolveGitBinary()` pins the
 * BINARY (absolute, executable) and `gitEnv()` builds the environment from
 * constants, which is the same shape `stranded-artifact-guard.js` already uses
 * and the shape `git-env-regrowth-guard-1471.test.mjs` check 1471-G1 enforces.
 *
 * NO PER-CALL COST IS ADDED, and this is measured rather than assumed.
 * `resolveGitBinary()` memoises in the helper's own module-level cache when no
 * injection seam is passed, so every call after the first is a cache read, not
 * a fresh probe and never a subprocess; `gitEnv()` is object construction from
 * constants. The cache is deliberately the HELPER's and not a private copy
 * here, so `resetGitBinaryCache()` still reaches this module from tests.
 *
 * MEASURED, INTERLEAVED IN ONE PROCESS (2026-08-22, this tree) — bare-spawn and
 * helpered forms of the SAME `for-each-ref` alternated 40× each, because
 * comparing two separate runs cannot separate the change from machine noise:
 * bare median 20.24 ms, helpered median 19.50 ms (delta -0.74 ms). No
 * measurable regression; the git subprocess dominates and the envelope is
 * object construction. Separately pinned rather than argued: with the cache
 * reset, the FIRST `resolveGitBinary()` costs 1 `statSync` and the next 50 cost
 * 0 — so the binary is resolved once per process, never per call.
 *
 * Figures are measured AT LANDING and go stale; re-measure rather than cite
 * them. That the hot path is ONE git call is the durable property —
 * `laneSurvey`'s docblock below records why the per-branch shape was abandoned.
 *
 * NULL IS UNKNOWN, NEVER "no lanes". An unresolvable binary returns null on the
 * SAME channel a failing git call already uses. That is
 * `instrument-discipline.md` MUST-1, not a silent fallback: a guard that
 * reported a clean count because git never ran would be the non-discriminating
 * instrument this module's own header refuses.
 *
 * BE EXACT ABOUT WHICH CALLERS HOLD THAT LINE — an earlier revision of this
 * docblock said "every caller routes null to an `{ok:false, reason}` verdict",
 * which is FALSE and is withdrawn. Audited when written, all 13 `_git` call
 * sites — a figure since SUPERSEDED: 21 `_git(` call sites on 2026-09-12, after
 * the census, lane-depth and budgeted-reader changes (`landedRemoteRefs`' list
 * reads and `remoteDefaultBase` moved to `_gitRun`). Re-count; do not cite either.
 * The per-site dispositions below are the audit's and were not re-derived:
 *   - HOLD IT: `laneCountFast` (→ `for-each-ref-failed`), `laneSurvey`,
 *     `openLanes`' two head calls, `classifyTree`'s porcelain arm (→ KEEP), and
 *     `classifyTree`'s no-index arm (→ KEEP since the MUST-6 fix below).
 *   - DO NOT: `openLanes`' content loop treats null like 0 and DROPS the lane
 *     (under-reports inventory); `isOnAnyRemote` null collapses into
 *     `localOnly:false`; a null `mainTop` collapses into `isMainCheckout:false`.
 * Those three are pre-existing fail-OPEN arms, recorded here rather than
 * papered over. They are NOT fixed in this change: each needs `_git` to
 * distinguish "git could not run" from "git answered nothing", which is a
 * contract change across all 13 sites.
 *
 * ONE SUCCESS-PATH DELTA, deliberate and fail-CLOSED. `gitEnv()` sets
 * `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=os.devNull`, so
 * `classifyTree`'s `status --porcelain` no longer honours an operator's global
 * `core.excludesFile`. Globally-ignored files therefore count as untracked and
 * a tree can classify KEEP where it previously classified ZERO-LOSS. That is
 * the safe direction — a tree is preserved rather than reaped — and it is the
 * price of neutralising attacker-reachable config, which is the whole point of
 * the envelope. Stated because it IS a behavioural change, not because it is a
 * regression.
 *
 * WHAT THIS DOES NOT COPY FROM `stranded-artifact-guard.js`. That guard returns
 * `{code:-1, unavailable:true}` so a host condition is not mis-reported as a
 * repository condition. This module collapses both into null, so a missing git
 * binary still surfaces as `for-each-ref-failed` — a claim about the REPOSITORY
 * for what is really a claim about the HOST. The envelope (absolute binary +
 * constant env) is copied; that honest-reason discrimination is NOT, and adding
 * it is the same `_git` contract change noted above.
 */
function _git(args, opts = {}) {
  return _gitRun(args, opts).out;
}

/**
 * `_git` plus ONE bit: whether a null came from the per-call TIMEOUT.
 *
 * `_git`'s null-is-unknown contract and its call sites are unchanged. A caller
 * running inside a DECISION BUDGET must say WHICH read went unmeasured and WHY —
 * a budget that ran out is a claim about the HOST, a git that could not answer
 * is a claim about the REPOSITORY — and `_git` collapses the two. That caller
 * reads this instead (`landedRemoteRefs`). Same spawn, same envelope, same count.
 */
function _gitRun(args, { cwd, timeout = GIT_TIMEOUT_MS } = {}) {
  try {
    const gitBin = resolveGitBinary();
    // INDETERMINATE, ranked tightest per `security.md` § Enforcement-Surface
    // Parity — the caller's `null` arm, not a fabricated empty answer.
    if (!gitBin) return { out: null, timedOut: false };
    // REPOSITORY config that reshapes a FORMATTED read is neutralised for every
    // call, as the core does (`landed-map.js::git`): a repo-local
    // `log.showSignature=true` prints the signature check inside `--format`
    // output (a signed commit's age read NaN), and a `refs/replace/*` object
    // would substitute another commit. gitEnv() already nulls global/system.
    const r = spawnSync(gitBin, ["-c", "log.showSignature=false", "--no-optional-locks", ...args], {
      cwd,
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...gitEnv(), GIT_NO_REPLACE_OBJECTS: "1" },
    });
    if (r.error || r.status !== 0) {
      return {
        out: null,
        timedOut: Boolean(r.error && r.error.code === "ETIMEDOUT"),
      };
    }
    return { out: (r.stdout || "").trim(), timedOut: false };
  } catch {
    return { out: null, timedOut: false };
  }
}

/**
 * Age of a linked worktree, in hours, FROM CREATION.
 *
 * Reads the worktree's own reflog (`.git/worktrees/<id>/logs/HEAD`), whose FIRST
 * line is the creation event. Deliberately NOT the directory mtime (E3): mtime
 * is reset by any later touch, so it can only ever make old trees look young —
 * the one error direction an ageing metric must not have.
 *
 * Returns null when the reflog is unreadable. Null is UNKNOWN, never 0.
 */
function treeAgeHours(adminDir, now = Date.now()) {
  try {
    const logPath = path.join(adminDir, "logs", "HEAD");
    const first = fs.readFileSync(logPath, "utf8").split("\n")[0];
    if (!first) return null;
    // reflog line: <old> <new> <name> <email> <unix-ts> <tz>\t<message>
    const m = first.match(/>\s+(\d{9,})\s+[+-]\d{4}/);
    if (!m) return null;
    return (now - Number(m[1]) * 1000) / 3_600_000;
  } catch {
    return null;
  }
}

/**
 * Is this worktree provably EMPTY rather than dirty? (E2)
 *
 * A `--no-checkout` worktree has no index file. Without an index git reports
 * every path in HEAD as a staged deletion, which a naive porcelain count reads
 * as thousands of paths of work on a directory holding nothing.
 *
 * The predicate is deliberately conservative in the SAFE direction: it returns
 * true only when the index is genuinely ABSENT. A tree with an index is treated
 * as potentially holding work and falls through to the normal porcelain path.
 */
function hasNoIndex(adminDir) {
  try {
    return !fs.existsSync(path.join(adminDir, "index"));
  } catch {
    return false; // unreadable ⇒ assume it MIGHT hold work
  }
}

/**
 * Commits on `ref` whose PATCH is not present at `baseRef`.
 *
 * `git cherry` emits `+ <sha>` for a commit with no patch-equivalent upstream
 * and `- <sha>` for one that is already there under another SHA. Counting the
 * `+` lines is what separates genuinely-unlanded work from a rebased branch
 * that merely reads "ahead" — the distinction loom#1885 measured at 63% noise.
 *
 * UPPER BOUND — see the module header. Returns null when the query fails.
 *
 * PROVENANCE FIRST since landing provenance was recorded: the count comes from
 * `_laneContent` — the recorded `Landed-From` verdict when it is decided (0 for a
 * landed lane, the uncovered source commits for an open one), `null` when the
 * verdict is UNMEASURED, and the `git cherry` count above ONLY on the core's
 * fallback (no config, predates the cutover, ancestry). No caller can reach the
 * bare patch-id comparison past the recorded answer.
 */
function uniqueCommitCount(ref, baseRef, cwd, timeout, landedMap = null) {
  return _laneContent(
    cwd,
    baseRef,
    ref,
    String(ref).replace(/^refs\/heads\//, ""),
    timeout,
    landedMap,
  ).unique;
}

/**
 * The integration trunk for a LANDEDNESS predicate — the STRICT resolver
 * (`trunk-ref.js::resolveTrunk`, `wip-discipline.md` MUST-4), never the lenient
 * `trunkRef` string.
 *
 * WHY NOT `trunkRef`. It returns an operator override AS DECLARED without probing
 * and turns an unprobeable ladder into `<remote>/main`. Every predicate here used
 * it, so an unresolvable `COC_TRUNK_REF` surfaced as a GIT failure
 * (`for-each-ref-failed`, a bare `{ok:false}`), and inside `confirmAtLimit` /
 * `confirmAgedLane` as a pass that "decided" while every lane was silently
 * `unanswerable`. A transient probe failure was worse: the lenient ladder fell
 * through to main and the predicate MEASURED against the wrong trunk.
 *
 * UNDETERMINED comes back as a typed unmeasured result — `reason:
 * "trunk-undetermined"`, the ref it `trunk`-asked about, and `trunkReason` in the
 * resolver's own words — which each caller returns in its OWN unmeasured shape.
 * `timeoutMs` bounds the probe inside the caller's budget.
 */
function _trunkFor(repoDir, { remote = "origin", timeoutMs } = {}) {
  const t = resolveTrunk({ repoDir, remote, timeoutMs });
  if (t.status === "resolved") return { ok: true, ref: t.ref, basis: t.basis };
  return {
    ok: false,
    reason: "trunk-undetermined",
    trunk: t.asked ?? null,
    trunkReason: t.reason,
  };
}

/**
 * confirmAtLimit — the ONE question a BLOCKING WIP gate is allowed to act on:
 *
 *     are there AT LEAST `limit` lanes whose unlanded content is MEASURED?
 *
 * WHY THIS EXISTS AND `laneCountFast` DOES NOT SUFFICE. `laneCountFast` answers
 * with an ancestry-unmerged count, which is an UPPER BOUND — a rebased or
 * cherry-picked branch reads OPEN when its content has already landed
 * (loom#1885 measured that gap at 16 of 99 on the origination tree). An upper
 * bound is the RIGHT instrument for a REPORT: over-reporting costs one operator
 * glance. It is the WRONG instrument for a BLOCK: over-blocking refuses work the
 * operator is entitled to start, on a lane count that is not real. So the block
 * decision is taken on a LOWER bound instead, and this function computes it.
 *
 * THE ASYMMETRY IS THE WHOLE DESIGN. Every lane counted here is counted because
 * `git cherry` emitted a `+` line for it — a MEASURED patch-id absence at the
 * base, never an inference. `confirmed` is therefore a floor on the true open
 * count, and `confirmed >= limit` implies `true count >= limit` unconditionally.
 * The converse does NOT hold and is never claimed: `atLeastLimit:false` means
 * "not established", not "under the limit".
 *
 * FAIL OPEN ON EVERY UNKNOWN (`cc-artifacts.md` Rule 7). An unanswerable branch
 * is SKIPPED and tallied, never read as 0 and never read as content — skipping
 * only ever lowers `confirmed`, which is the direction that cannot manufacture a
 * block. Budget exhaustion returns `decided:false`, and a caller MUST NOT block
 * on an undecided result. A guard that cannot count must not block.
 *
 * EARLY EXIT is not an optimisation, it is the budget. The loop stops the
 * instant the `limit`-th lane is confirmed, so the common over-limit case costs
 * `limit` git calls regardless of whether 6 branches are open or 600.
 */
function confirmAtLimit({
  repoDir,
  baseRef = null, // resolved via trunk-ref.js below
  names = [],
  limit = WIP_LIMIT,
  budgetMs = 2500,
  perCallTimeoutMs = 1500,
} = {}) {
  // The integration trunk, resolved STRICTLY when the caller omitted it —
  // `_trunkFor`, the shared resolver (`wip-discipline.md` MUST-4).
  // An unresolvable trunk is UNDECIDED, never a pass that "decided" over lanes
  // it silently could not measure.
  if (!baseRef) {
    const t = _trunkFor(repoDir, { timeoutMs: perCallTimeoutMs });
    if (!t.ok) {
      return {
        decided: false,
        reason: t.reason,
        trunk: t.trunk,
        trunkReason: t.trunkReason,
        confirmed: 0,
        confirmedNames: [],
        scanned: 0,
        unanswerable: 0,
        candidates: names.length,
        elapsedMs: 0,
      };
    }
    baseRef = t.ref;
  }
  const startedAt = Date.now();
  const confirmedNames = [];
  let scanned = 0;
  let unanswerable = 0;
  // WHICH INSTRUMENT decided each lane, so the refusal can name it: the recorded
  // landing provenance, or the legacy `git cherry` content comparison (reached
  // ONLY on the core's fallback verdict — see `_laneContent`).
  const decidedBy = { provenance: 0, content: 0 };
  const landedByProvenance = [];
  const unmeasuredNames = [];
  const pmap = names.length ? _landedMapFor(repoDir, baseRef, perCallTimeoutMs) : null; // ONCE per call
  const tally = () => ({ decidedBy: { ...decidedBy }, landedByProvenance: landedByProvenance.slice(), unmeasuredNames: unmeasuredNames.slice() });

  for (const name of names) {
    if (Date.now() - startedAt > budgetMs) {
      return {
        decided: false,
        reason: "budget-exhausted",
        confirmed: confirmedNames.length,
        confirmedNames,
        scanned,
        unanswerable,
        candidates: names.length,
        ...tally(),
        elapsedMs: Date.now() - startedAt,
      };
    }
    scanned += 1;
    const c = _laneContent(
      repoDir,
      baseRef,
      name,
      String(name).replace(/^refs\/heads\//, ""),
      perCallTimeoutMs,
      pmap,
    );
    if (c.unique === null) {
      // UNKNOWN, never 0 and never content (`instrument-discipline.md` MUST-1).
      // A provenance UNMEASURED verdict lands here too: never landed, and never
      // counted as confirmed content either — a lower bound cannot rest on it.
      unanswerable += 1;
      if (c.instrument === "unmeasured") unmeasuredNames.push(name);
      continue;
    }
    decidedBy[c.instrument === "provenance" ? "provenance" : "content"] += 1;
    if (c.unique === 0 && c.instrument === "provenance") landedByProvenance.push(name);
    if (c.unique > 0) {
      confirmedNames.push(name);
      if (confirmedNames.length >= limit) {
        return {
          decided: true,
          atLeastLimit: true,
          confirmed: confirmedNames.length,
          confirmedNames,
          scanned,
          unanswerable,
          candidates: names.length,
          countBound: "lower-content",
          ...tally(),
          elapsedMs: Date.now() - startedAt,
        };
      }
    }
  }

  return {
    decided: true,
    atLeastLimit: false,
    confirmed: confirmedNames.length,
    confirmedNames,
    scanned,
    unanswerable,
    candidates: names.length,
    countBound: "lower-content",
    ...tally(),
    elapsedMs: Date.now() - startedAt,
  };
}

/** Does any remote ref contain this commit? A pushed lane is recoverable from
 *  anywhere; a LOCAL-ONLY lane exists in exactly one clone and is the only
 *  population where a lost disk is a lost lane. */
function isOnAnyRemote(sha, cwd) {
  const out = _git(["branch", "-r", "--contains", sha], { cwd });
  if (out === null) return null;
  return out !== "";
}

/**
 * REMOTE LANDED REFS — the ceiling's third door (`wip-discipline.md` MUST-2/4).
 *
 * Local drainage reaps a branch that landed (`git branch -d`) and a PR'd branch
 * on merge (`--delete-branch`); NOTHING reaps a branch that was pushed and never
 * PR'd, and the CI doctrine that makes a wave affordable — a pushed branch with
 * no open PR fires zero CI and is free — manufactures exactly those.
 *
 * ── WHY THIS IS NO LONGER AN ANCESTRY COUNT — measured, and it was VACUOUS ──
 *
 * This function shipped as ONE spawn of `git for-each-ref --merged <base>`, and
 * its own doc called that "landed by CONTENT". Both halves were wrong at once:
 * `--merged` is ANCESTRY (the tip is reachable from the base), and loom SQUASH-
 * merges, which re-authors every commit under a new sha — so a fully-landed
 * branch is NOT an ancestor of main. The door therefore never fired once.
 *
 * MEASURED on this repo 2026-09-10, `git ls-remote --heads origin` (the SERVER,
 * not `git branch -r`, which reports 1282 here because of a separate
 * `refs/remotes/pr/*` namespace):
 *
 *     88 server refs
 *     ancestry (`--merged`)      ->  0 landed   <- what this returned
 *     content  (`git cherry`)    -> 18 landed   <- what was actually standing
 *
 * ── THE COST, AND WHY THE COUNT IS A LOWER BOUND ────────────────────────────
 *
 * The content predicate is not free: `git cherry` patch-ids both sides of the
 * comparison, MEASURED at p50 270ms per ref and 28.7s for the full 89-ref
 * forest on this repo. This runs inside a PreToolUse door whose own budget is
 * 8s, so a complete scan is not affordable and pretending otherwise would
 * either hang the door or silently truncate.
 *
 * So the scan is BUDGETED and says so. `countBound: "lower-content"` and
 * `truncated` are part of the return, and the caller MUST render a truncated
 * count as "at least N". The error direction is UNDER-reporting — a landed ref
 * the budget did not reach is one the door stays quiet about — which is the
 * same direction the reaper and `reap-on-landing.js` already document. It can
 * never invent a landed ref.
 *
 * Two things make the budget non-vacuous rather than decorative. Refs are
 * examined NEWEST-FIRST (`--sort=-committerdate`), measured to find 4 landed
 * refs within 3s where refname order found 0 — the freshly-merged ref is both
 * the likeliest to be landed and the one the operator just made. And the
 * ancestry set is still consulted, because ancestry is a SOUND SUBSET of
 * content-landed (an ancestor's patches are all present at the base) and costs
 * one spawn — it can only ADD certain hits, never remove one.
 *
 * `requireMeasured` is passed because the budgeted pass runs over the
 * `--no-merged` remainder, so every ref in it is ALREADY established a
 * non-ancestor. For such a ref an EMPTY `git cherry` is not "nothing ahead", it
 * is NO PATCH-ID MEASURED — the CONTENT-UNMEASURED class `remote-ref-reap.mjs`
 * refuses. MEASURED: it moves this repo's count from 21 to 18, and those 3 are
 * exactly the refs the reaper would also decline to reap.
 *
 * `origin/HEAD` and the base branch itself are never candidates.
 *
 * Returns `{ ok:true, count, names, base, countBound, truncated, examined,
 * candidates }`, or `{ ok:false }` when git cannot answer (no such remote, no
 * such base, no git) — the caller MUST fail OPEN on that.
 *
 * AN `ok:false` IS NAMED, never a silent empty. Every failure carries
 * `unmeasured` (WHICH read) and `reason` (why, in that read's own words), and no
 * landed set rides along — `count` and `names` are absent, so a caller cannot
 * mistake an unanswered question for a measured zero. When the failure is an
 * UNRESOLVABLE TRUNK the result adds `undetermined:true` and `asked` (the ref
 * `resolveTrunk` probed and could not confirm) alongside `trunk`/`trunkReason`,
 * because `ok:false` by itself cannot separate "nobody could name the base" from
 * "the base resolved and the ref read failed". Pinned by
 * `test-harness/tests/wip-remote-landed-gate.test.mjs` § UNDETERMINED pole.
 */
/**
 * The remote's DEFAULT branch as the remote itself declares it — the target of
 * `refs/remotes/<remote>/HEAD` — so the door and the reaper measure against the
 * same base. `null` when the symbolic ref is absent (a clone that never ran
 * `remote set-head`), and the caller falls back to `<remote>/main`.
 */
function remoteDefaultBase(
  repoDir,
  remote = "origin",
  timeoutMs = GIT_TIMEOUT_MS,
) {
  return _remoteDefaultBaseRun(repoDir, remote, timeoutMs).ref;
}

/** `remoteDefaultBase` plus whether the read TIMED OUT: a caller inside a budget
 *  must not read a timeout as "no declared default" and silently keep main. */
function _remoteDefaultBaseRun(repoDir, remote, timeoutMs) {
  const r = _gitRun(["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`], {
    cwd: repoDir,
    timeout: timeoutMs,
  });
  if (!r.out || !r.out.startsWith("refs/remotes/")) {
    return { ref: null, timedOut: r.timedOut };
  }
  return { ref: r.out.slice("refs/remotes/".length), timedOut: false };
}

function landedRemoteRefs({
  repoDir,
  baseRef = null,
  remote = "origin",
  budgetMs = 3000,
  now = Date.now, // injectable: the budget is wall-clock, and tests pin it without load
} = {}) {
  if (!repoDir) return { ok: false };
  // ONE BUDGET, EVERY READ. The trunk probe, the declared-default read and both
  // `for-each-ref` reads draw on `budgetMs` exactly as the cherry loop does, each
  // spawn receiving only what is LEFT. Before, only the loop was bounded: the probe
  // had no timeout and each read ran under `GIT_TIMEOUT_MS`, which a caller's
  // decision budget (`reap-on-landing-guard.js::DECISION_BUDGET_MS`) did not reach.
  // A read the budget cannot cover, or that times out, is UNKNOWN and NAMED — never
  // "none landed". Both callers fail OPEN on `ok:false`.
  const startedAt = now();
  const left = () => budgetMs - (now() - startedAt);
  const within = () => Math.max(1, Math.min(left(), GIT_TIMEOUT_MS));
  const notMeasured = (what, why, extra = {}) => ({
    ok: false,
    unmeasured: what,
    reason: `${what} was NOT measured — ${why}. Landed remote refs are UNKNOWN, not zero.`,
    ...extra,
  });
  const budgetSpent = (what) =>
    notMeasured(
      what,
      `the caller's ${budgetMs}ms budget ran out before it was read`,
    );
  if (!baseRef) {
    // THE INTEGRATION TRUNK (directive 2026-09-10). "Landed" means "in dev",
    // because dev is reachable for FREE — a push to it fires no workflow —
    // while main costs a CI run on a shared pool, which is what made every
    // session rationally defer closing a branch. COMPOSED, not replaced: with
    // no override and no dev, the resolver yields `<remote>/main` and the
    // pre-existing declared-default read still wins, so a repo whose symbolic
    // HEAD names something else behaves exactly as before. STRICT resolver
    // (`_trunkFor`): an unresolvable trunk is UNMEASURED, never a git failure
    // reported against a trunk nobody resolved.
    const trunkLabel = "the integration trunk";
    if (left() <= 0) return budgetSpent(trunkLabel);
    const t = _trunkFor(repoDir, { remote, timeoutMs: within() });
    if (!t.ok) {
      return notMeasured(trunkLabel, t.trunkReason, {
        trunk: t.trunk,
        trunkReason: t.trunkReason,
        // THE FAIL-OPEN IS LEGIBLE, NOT MERELY EMPTY. `ok:false` alone cannot
        // tell an UNNAMEABLE base from a git read that failed against a base we
        // DID resolve — the lenient resolver returned `ok:false` for both, the
        // one-output-for-two-worlds instrument `instrument-discipline.md` MUST-1
        // refuses. `undetermined` says WHICH question went unanswered; `asked`
        // carries the ref nobody could resolve, so a caller renders "the trunk
        // is UNDETERMINED (origin/x)" rather than a bare failure.
        //
        // The field NAMES are the corpus's, not invented here: `trunk-ref.js:291`
        // already returns `undetermined:true` for this same class, and `asked` is
        // `resolveTrunk`'s own name for the ref it probed (`trunk-ref.js:161`).
        // Strictly ADDITIVE — `trunk`, `trunkReason`, `unmeasured` and `reason`
        // are unchanged, and MEASURED on this tree no consumer reads either new
        // key off this return (`git grep '\.undetermined|\.asked'` over
        // `.claude/hooks` + `.claude/bin` names only trunk-ref.js:291 and
        // census-build.mjs's unrelated per-site census field).
        undetermined: true,
        asked: t.trunk,
      });
    }
    baseRef = t.ref;
    // KEYED ON THE BASIS, NOT A STRING COMPARE. Only the FALLBACK case defers to
    // the remote's declared default. `t.ref === "<remote>/main"` cannot tell that
    // fallback from an operator who DECLARED `<remote>/main` via COC_TRUNK_REF --
    // it would silently redirect the declaration to whatever refs/remotes/<remote>/HEAD
    // points at. An explicit override is honoured as declared.
    if (t.basis === "main-fallback") {
      const headLabel = `refs/remotes/${remote}/HEAD`;
      if (left() <= 0) return budgetSpent(headLabel);
      const d = _remoteDefaultBaseRun(repoDir, remote, within());
      if (d.timedOut) {
        return notMeasured(
          headLabel,
          `the read timed out inside the ${budgetMs}ms budget`,
        );
      }
      if (d.ref) baseRef = d.ref;
    }
  }
  const prefix = `refs/remotes/${remote}/`;
  const baseBranch = baseRef.startsWith(`${remote}/`)
    ? baseRef.slice(remote.length + 1)
    : null;

  // A ref name is a candidate only if it is a real branch under this remote.
  // `%(refname)` (FULL) deliberately, never `%(refname:short)`: git renders
  // `refs/remotes/origin/HEAD` as the BARE string `origin` under the short
  // form, so a `grep -v 'origin/HEAD$'` filter never matches and HEAD is
  // silently counted as a branch. Prefix arithmetic on the full name has no
  // such hole.
  const nameOf = (line) => {
    if (!line.startsWith(prefix)) return null;
    const branch = line.slice(prefix.length);
    if (!branch || branch === "HEAD" || branch === baseBranch) return null;
    // A ref whose name begins with `-` is handed to git as its own argv token
    // where git's parser may read it as an OPTION. Refuse the class rather than
    // reason about which of git's parsers are option-terminated.
    if (branch.startsWith("-")) return null;
    return branch;
  };

  // (1) ANCESTRY — a SOUND SUBSET of content-landed, one spawn, certain hits.
  // NOT routed through the provenance verdict, and that is outcome-identical
  // rather than a skipped consultation: for a ref whose tip IS reachable from the
  // trunk `rev-list --no-merges tip ^trunk` is empty, so `classifyBranch`
  // (`.claude/hooks/lib/landed-map.js::classifyBranch`) returns `ancestry` — fallback:true,
  // whose legacy answer is exactly this ancestry fact. The verdict would cost
  // spawns per ref to reproduce the answer already in hand. (Residual: a git
  // failure inside the verdict would have read UNMEASURED; this subset reads the
  // ancestry fact git DID answer in the `--merged` read.)
  // Both ref lists go through ONE budgeted reader, so neither can outlive the
  // caller's budget and a timed-out list is NAMED rather than read as empty.
  const readRefs = (mode) => {
    const label = `for-each-ref ${mode} ${baseRef} ${prefix}`;
    if (left() <= 0) return { fail: budgetSpent(label) };
    const args =
      mode === "--merged"
        ? ["for-each-ref", "--merged", baseRef, prefix, "--format=%(refname)"]
        : [
            "for-each-ref",
            "--no-merged",
            baseRef,
            prefix,
            "--sort=-committerdate",
            "--format=%(refname)",
          ];
    const r = _gitRun(args, { cwd: repoDir, timeout: within() });
    if (r.timedOut) {
      return {
        fail: notMeasured(
          label,
          `the read timed out inside the ${budgetMs}ms budget`,
          {
            base: baseRef,
          },
        ),
      };
    }
    // git ANSWERED with a failure — no such remote, no such base, or no git.
    if (r.out === null) {
      return {
        fail: {
          ok: false,
          reason: `${label} failed — no such remote or base, or git could not run`,
        },
      };
    }
    return { out: r.out };
  };

  const merged = readRefs("--merged");
  if (merged.fail) return merged.fail;
  const mergedOut = merged.out;
  const found = new Set();
  // DEMOTE, NEVER SUPPRESS. A PROTECTED ref is landed-and-un-reapable: the
  // reaper refuses it by design, so counting it toward the door's block
  // threshold is an unclearable deadlock. But dropping it from the CANDIDATE
  // set would hide magnitude — the defect this repo already diagnosed in
  // `variants/rs/hooks/lib/unlanded-shards.js` ("a branch literally prefixed
  // `wip/` was exempt from the WIP surface") and forbids in
  // `unlanded-work-surface.js` ("COUNT IS NEVER SUPPRESSED"). So it is
  // CLASSIFIED differently and still counted, never made invisible.
  const protectedFound = new Set();
  const sortInto = (b) => (isProtectedName(b) ? protectedFound : found).add(b);
  for (const line of mergedOut.split("\n")) {
    const b = nameOf(line);
    if (b) sortInto(b);
  }
  const ancestryCount = found.size + protectedFound.size; // the free, certain hits
  let examined = ancestryCount;

  // (2) CONTENT — the budgeted pass over the non-ancestor remainder, newest
  // first. `--no-merged` is the exact complement of the set above, so every ref
  // here is established a non-ancestor and `requireMeasured` applies.
  const rest = readRefs("--no-merged");
  if (rest.fail) return rest.fail;
  const restOut = rest.out;

  let truncated = false;
  let candidates = 0;
  // NAMED, not only counted: a caller that must report "what was not examined"
  // (reap-on-landing-guard.js) cannot do so from a bare `truncated` flag.
  const unexamined = [];
  const unmeasured = [];
  // WHICH INSTRUMENT put each ref in the landed set, so the door can say so.
  const landedBy = { ancestry: ancestryCount, provenance: 0, content: 0 };
  // (2a) PROVENANCE FIRST, IN BULK. One `landedVerdicts` call over every
  // non-ancestor candidate (`.claude/hooks/lib/landed-map.js::landedVerdicts`): tips from
  // ONE `for-each-ref`, two spawns per ref, the fork test memoised, and the
  // pass bounded by what is LEFT of this door's budget — a ref it never reaches
  // comes back `unknown` (UNMEASURED), never landed. With no config the map is
  // `ok:false` and every verdict is `no-config` fallback at zero spawns.
  const restNames = [];
  for (const line of restOut.split("\n")) {
    const branch = nameOf(line);
    if (branch) restNames.push(branch);
  }
  const verdictOf = new Map();
  if (restNames.length && left() > 0) {
    try {
      const pmap = _landedMapFor(repoDir, baseRef, within());
      const vs = LM.landedVerdicts({
        repoDir,
        branches: restNames.map((b) => ({ ref: prefix + b, name: b })),
        map: pmap,
        ref: baseRef,
        timeoutMs: within(),
        budgetMs: Math.max(0, left()),
      });
      restNames.forEach((b, i) => verdictOf.set(b, _outcomeOf(vs[i])));
    } catch (e) {
      // UNKNOWN for every ref — never landed, and named below.
      for (const b of restNames) {
        verdictOf.set(b, _outcomeOf({ decided: false, fallback: false, status: "unknown", why: String((e && e.message) || e) }));
      }
    }
  }
  for (const branch of restNames) {
    candidates++;
    // A decided verdict settles the ref and NO content comparison runs: a
    // replayed or conflict-resolved landing carries a `Landed-From` trailer
    // whatever its patch-id, and a post-cutover ref whose patch merely sits on the
    // trunk with no trailer is NOT landed. UNMEASURED (fallback:false) is never
    // landed and leaves the count a lower bound.
    //
    // A ref the budget never let the provenance pass REACH keeps the pre-existing
    // contract: it is UNEXAMINED (named in `unexamined`), not UNMEASURED. That is
    // a ref the bulk pass was never handed, or one the core returned `unknown`
    // with `budgetExhausted:true` because ITS budget ran out
    // (`.claude/hooks/lib/landed-map.js::landedVerdicts`).
    const prov = verdictOf.get(branch) || null;
    const budgetUnreached =
      !prov ||
      (prov.outcome === "unmeasured" &&
        Boolean(prov.verdict && prov.verdict.budgetExhausted === true));
    if (budgetUnreached) {
      truncated = true;
      unexamined.push(branch);
      continue; // keep COUNTING candidates so the denominator stays honest
    }
    if (prov.outcome !== "fallback") {
      examined++;
      if (prov.outcome === "landed") {
        landedBy.provenance += 1;
        sortInto(branch);
      } else if (prov.outcome === "unmeasured") {
        truncated = true;
        unmeasured.push(branch);
      }
      continue;
    }
    // (2b) FALLBACK ONLY (predates / ancestry / no-config): the legacy
    // content comparison below, inside what is LEFT of the budget. (A ref the
    // provenance DECIDED above is settled whatever the budget: that answer is
    // already in hand and costs nothing more to read.)
    const remaining = left();
    if (remaining <= 0) {
      truncated = true;
      unexamined.push(branch);
      continue; // keep COUNTING candidates so the denominator stays honest
    }
    // The per-spawn timeout is the REMAINING budget, never `_git`'s 5s default.
    // Without this the worst case is budgetMs + GIT_TIMEOUT_MS: one pathological
    // ref could sit for 5s AFTER the budget was already spent, and the door's own
    // ceiling is 8s — so a budget that reads as 3s could overrun it. A timeout
    // returns null from `_git`, which is UNMEASURED, which drops the ref.
    const cherry = _git(["cherry", baseRef, prefix + branch], {
      cwd: repoDir,
      timeout: Math.min(remaining, GIT_TIMEOUT_MS),
    });
    if (cherry === null) {
      truncated = true; // an unmeasured ref leaves the count a LOWER bound
      unmeasured.push(branch);
    }
    examined++;
    // `_git` returns null on a non-zero exit or any spawn error, and
    // `isLandedByContent` returns false for a non-string — UNMEASURED drops the
    // ref from the landed set, it never adds it.
    if (isLandedByContent(cherry, { requireMeasured: true })) {
      landedBy.content += 1;
      sortInto(branch);
    }
  }

  const names = [...found].sort((a, b) => a.localeCompare(b));
  // Reported so magnitude is never hidden; EXCLUDED from `count` because the
  // reaper refuses these by design and a door keyed on them can never clear.
  const protectedNames = [...protectedFound].sort((a, b) => a.localeCompare(b));
  return {
    ok: true,
    count: names.length,
    names,
    protectedCount: protectedNames.length,
    protectedNames,
    base: baseRef,
    countBound: "lower-content",
    // Per-instrument counts over the WHOLE landed set (count + protected):
    // ancestry (the `--merged` subset), provenance (a recorded `Landed-From`
    // landing), content (`git cherry`, run only on the core's fallback verdict).
    landedBy,
    truncated,
    unexamined,
    unmeasured,
    examined,
    // the DENOMINATOR: the whole remote-ref population this door could have
    // looked at, ancestry set plus non-ancestor remainder — NOT the subset the
    // budget reached. "3 of 92 examined 12" and "3 of 3" must not print alike.
    candidates: candidates + ancestryCount,
  };
}

/** Landed remote refs tolerated before creation is refused: none. */
const REMOTE_LANDED_FLOOR = 0;

/**
 * Classify a worktree for removal safety.
 *
 * Verdicts are the SINGLE vocabulary — deliberately not a second one beside the
 * reaper's. `wip-discipline.md`'s consolidation record names two overlapping
 * classifiers (ZERO-LOSS/TAG-FIRST/KEEP and SALVAGE/PUSHED/UNPUSHED/LOST) as
 * redundant precisely because two answers to one question teach an operator to
 * trust neither.
 *
 *   ZERO-LOSS — nothing is lost by removing the directory.
 *   KEEP      — holds work, or the question could not be answered.
 *
 * "Could not answer" maps to KEEP, which is the fail-CLOSED direction for a
 * removal gate. But note E2: failing closed on EVERYTHING is not safety, it is
 * inertia — which is why the no-index case is resolved positively rather than
 * swept into the same bucket.
 */
function classifyTree({ treePath, adminDir, cwd }) {
  const reasons = [];

  const noIndex = hasNoIndex(adminDir);
  const unpushedOut = _git(["rev-list", "--count", "@{u}..HEAD"], {
    cwd: treePath,
  });
  const unpushed = unpushedOut === null ? null : Number(unpushedOut);

  if (noIndex) {
    // E2: no index ⇒ porcelain's "staged deletions" are an artefact of the
    // missing index, not work. Combined with no unpushed commits this is
    // provably nothing-to-lose.
    // UNKNOWN is KEEP (MUST-6). `unpushed === null` means the rev-list did not
    // answer — no upstream, a detached HEAD, a timeout, or no resolvable git
    // binary — and those are NOT distinguishable from each other here. Folding
    // them into ZERO-LOSS would emit a REMOVAL-IS-SAFE verdict from a predicate
    // that could not separate "0 unpushed" from "could not count", which is the
    // exact instrument MUST-6 refuses and which PAIR 6 of this rule's fixtures
    // asserts against. Only a MEASURED zero earns ZERO-LOSS.
    if (unpushed === 0) {
      return {
        verdict: "ZERO-LOSS",
        reasons: [
          "no index file (--no-checkout tree): porcelain deletions are phantom, not work",
          "0 unpushed commits",
        ],
        unpushed,
        noIndex: true,
      };
    }
    if (unpushed === null) {
      return {
        verdict: "KEEP",
        reasons: [
          "no index file (--no-checkout tree): porcelain deletions are phantom, not work",
          "unpushed count could not be read (no upstream, detached, or git unavailable) — UNKNOWN, not zero",
        ],
        unpushed,
        noIndex: true,
      };
    }
    reasons.push(`no index, but ${unpushed} unpushed commit(s)`);
  }

  const porcelain = _git(["status", "--porcelain"], { cwd: treePath });
  if (porcelain === null) {
    return {
      verdict: "KEEP",
      reasons: ["status could not be read — UNKNOWN, not clean"],
      unpushed,
      noIndex,
    };
  }
  const dirtyCount = porcelain === "" ? 0 : porcelain.split("\n").length;
  if (dirtyCount > 0) {
    reasons.push(
      `dirty tree (${dirtyCount} path(s); unstaged + untracked have NO reflog)`,
    );
  }
  if (unpushed !== null && unpushed > 0) {
    reasons.push(`${unpushed} unpushed commit(s)`);
  }

  return {
    verdict: reasons.length ? "KEEP" : "ZERO-LOSS",
    reasons: reasons.length ? reasons : ["clean, and every commit is pushed"],
    unpushed,
    noIndex,
  };
}

/**
 * Enumerate every OPEN lane.
 *
 * A lane is OPEN when it has a branch carrying unique content that has not
 * reached `baseRef`. Worktrees are joined onto their branch where one exists;
 * a detached worktree is its own lane keyed by path.
 *
 * Returns `{ ok, lanes, contentBound, reason }`. On failure `ok:false` and
 * `lanes:[]` — the caller MUST NOT read an empty list as "no lanes"
 * (`instrument-discipline.md` MUST-1).
 */
function openLanes({
  repoDir,
  baseRef = null, // resolved via trunk-ref.js below
  now = Date.now(),
  budgetMs = 8000,
} = {}) {
  // The integration trunk, resolved STRICTLY when the caller omitted it —
  // `_trunkFor`, the shared resolver (`wip-discipline.md` MUST-4).
  if (!baseRef) {
    const t = _trunkFor(repoDir, { timeoutMs: GIT_TIMEOUT_MS });
    if (!t.ok) {
      return {
        ok: false,
        lanes: [],
        reason: t.reason,
        trunk: t.trunk,
        trunkReason: t.trunkReason,
      };
    }
    baseRef = t.ref;
  }
  // THE TRUNK IS NOT A LANE. The branch names the resolver's trunk names —
  // `trunk-ref.js::nonLaneBranches`, derived from `baseRef`, never a literal list —
  // are excluded, so an integration trunk carrying an unpushed merge is not charged
  // to the WIP limit or reported as depth.
  const notLanes = new Set(nonLaneBranches(baseRef));
  const _startedAt = Date.now();
  const wtRaw = _git(["worktree", "list", "--porcelain"], { cwd: repoDir });
  if (wtRaw === null) {
    return { ok: false, lanes: [], reason: "worktree-list-failed" };
  }

  const trees = [];
  let cur = null;
  for (const line of wtRaw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) trees.push(cur);
      cur = { path: line.slice(9), branch: null, detached: false };
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      cur.detached = true;
    }
  }
  if (cur) trees.push(cur);

  // PRE-FILTER BY ANCESTRY BEFORE PAYING FOR CONTENT.
  //
  // `--no-merged` is ONE spawn and removes every branch already reachable from
  // the base — measured on the origination tree, 306 branches down to 99, so
  // two thirds of the per-branch cost disappears before the expensive pass
  // starts. It is a SUPERSET of the content-unlanded set (a rebased branch is
  // ancestry-unmerged but content-landed), so nothing is dropped that the
  // content pass would have kept: the filter can only over-admit, and the
  // `git cherry` below then removes exactly those.
  const branchesRaw = _git(
    [
      "for-each-ref",
      "--no-merged",
      baseRef,
      "--format=%(refname:short)",
      "refs/heads",
    ],
    { cwd: repoDir },
  );
  if (branchesRaw === null) {
    return { ok: false, lanes: [], reason: "branch-list-failed" };
  }
  const branches = branchesRaw ? branchesRaw.split("\n") : [];

  const mainTop = _git(["rev-parse", "--show-toplevel"], { cwd: repoDir });
  const treeByBranch = new Map();
  for (const t of trees) if (t.branch) treeByBranch.set(t.branch, t);

  const lanes = [];
  let truncated = false;
  let openMap = null;
  for (const b of branches) {
    if (notLanes.has(b)) continue;

    // BUDGET, AND THE DEGRADATION IS REPORTED — NEVER SILENT.
    //
    // Exhausting the budget stops the CONTENT pass and marks the result
    // TRUNCATED. It does NOT return the lanes gathered so far as if they were
    // the whole set: a partial list presented as complete is the failure mode
    // `instrument-discipline.md` MUST-1 names, and here it would under-report
    // inventory, which is the one direction this rule cannot tolerate. The
    // caller sees `truncated:true` and must say so.
    if (Date.now() - _startedAt > budgetMs) {
      truncated = true;
      break;
    }

    // PROVENANCE FIRST (`_laneContent`): a recorded landing closes the lane
    // whatever its patch-ids; `git cherry` runs only on the core's fallback.
    if (!openMap) openMap = _landedMapFor(repoDir, baseRef); // ONCE per call
    const content = _laneContent(repoDir, baseRef, b, b, GIT_TIMEOUT_MS, openMap);
    if (content.unique === 0) continue; // LANDED, by the instrument named in `content`
    // UNMEASURED by provenance (fallback:false) is NEVER landed: it stays listed,
    // with `uniqueCommits:null`, so the inventory is not under-reported. A failed
    // `git cherry` on the fallback path keeps its pre-existing disposition
    // (dropped — the fail-open arm this module's `_git` docblock records).
    if (content.unique === null && content.instrument !== "unmeasured") continue;
    const unique = content.unique;

    const tip = _git(["rev-parse", b], { cwd: repoDir });
    const onRemote = tip ? isOnAnyRemote(tip, repoDir) : null;
    // AGE OF THE OLDEST UNLANDED COMMIT — over the commits the SAME instrument
    // that decided the lane is open named (provenance's `outstanding`, else
    // `git cherry`'s `+` lines), MERGES EXCLUDED, minimum committer date
    // (`_oldestUnlandedCommitSeconds`). Not "the last entry": the core appends
    // the branch's own merges AFTER its oldest commit, so the last entry could
    // be a merge dated when someone merged, not when the work began.
    const oldest = _oldestUnlandedCommitSeconds(content, { cwd: repoDir });
    const ageHours = oldest === null ? null : (now - oldest * 1000) / 3_600_000;

    const tree = treeByBranch.get(b) || null;
    lanes.push({
      kind: "branch",
      name: b,
      decidedBy: content.instrument,
      uniqueCommits: unique,
      localOnly: onRemote === false,
      onRemote,
      ageHours,
      worktree: tree ? tree.path : null,
      isMainCheckout: tree ? tree.path === mainTop : false,
    });
  }

  return {
    ok: true,
    lanes,
    contentBound: "upper",
    truncated,
    scanned: branches.length,
    elapsedMs: Date.now() - _startedAt,
  };
}

/**
 * FAST lane count — for the PreToolUse spawn guard, where the budget is a few
 * hundred milliseconds and the question is only "how many lanes are open".
 *
 * WHY THIS TIER EXISTS, measured: the full `openLanes` above issues four git
 * spawns per branch and took **46 seconds** over 306 branches on the
 * origination tree. That is the same O(N)-spawn shape as the signing-guard
 * defect (loom#1921), where ~50 sequential `spawnSync` calls exceeded a 5000 ms
 * budget and the guard silently stopped guarding. A spawn-time gate that costs
 * 46 s is not a gate; it is an outage.
 *
 * The trade: this counts branches NOT MERGED by ancestry, so it OVER-COUNTS
 * relative to content classification (loom#1885 measured that gap at 16 of 99
 * on this tree). It is therefore an UPPER BOUND and says so. That is the right
 * error direction for a WIP limit — over-counting reports the limit reached
 * slightly early, which costs one operator glance; under-counting lets the
 * inventory grow, which is the failure this rule exists to end.
 *
 * TWO git spawns total, both O(1) in branch count.
 *
 * IT ALSO CARRIES THE TIP DATE, AND THAT COSTS NOTHING. `%(committerdate:unix)`
 * is a second field on the SAME `for-each-ref` — no extra spawn, no extra ref
 * walk. `lanes` is ADDITIVE: `count`, `names` and `bound` are byte-identical to
 * what this returned before, so every existing caller reads the same thing.
 *
 * IT IS AN ORDERING SIGNAL FOR THE AGE DOOR, AND EXPLICITLY **NOT** A FILTER.
 * The first draft of `confirmAgedLane` used it as a prefilter on the argument
 * that "the tip is the newest commit, so a lane whose tip is inside the bound
 * holds no unlanded commit outside it". THAT INEQUALITY RUNS THE OTHER WAY and
 * the draft was refuted by firing it at a known-answer case before it was
 * trusted (`instrument-discipline.md` MUST-3(a)). MEASURED on this tree,
 * 2026-09-06: `chore/handbook-authz-receipt` had a TIP age of **0.025 h** and an
 * oldest-unlanded-commit age of **73.19 h** — the lane the age door exists to
 * refuse on, silently excluded by its own prefilter. tipAge is a LOWER bound on
 * the content age, so `tipAge > bound` PROVES a blocker but `tipAge <= bound`
 * proves nothing at all. It is therefore used only to put the proven blockers
 * first in the scan order, and every lane is still measured.
 *
 * `ageHours` is null when the field is absent or unparseable. NULL IS UNKNOWN,
 * never 0 and never "young" — such a lane sorts LAST and is still measured, so
 * an unreadable tip date can neither hide a lane nor manufacture a block.
 */
function laneCountFast({
  repoDir,
  baseRef = null, // resolved via trunk-ref.js below
  now = Date.now(),
} = {}) {
  // The integration trunk, resolved STRICTLY when the caller omitted it —
  // `_trunkFor`, the shared resolver (`wip-discipline.md` MUST-4).
  if (!baseRef) {
    const t = _trunkFor(repoDir, { timeoutMs: 2000 });
    if (!t.ok) {
      return {
        ok: false,
        reason: t.reason,
        trunk: t.trunk,
        trunkReason: t.trunkReason,
      };
    }
    baseRef = t.ref;
  }
  // `%(objectname)` and `%(parent)` ride the SAME spawn: they feed the exact
  // provenance prefilter (`_dropProvenanceLanded`) and cost no extra git call.
  const raw = _git(
    [
      "for-each-ref",
      "--no-merged",
      baseRef,
      "--format=%(refname:short)%09%(committerdate:unix)%09%(objectname)%09%(parent)",
      "refs/heads",
    ],
    { cwd: repoDir, timeout: 2000 },
  );
  if (raw === null) return { ok: false, reason: "for-each-ref-failed" };
  // THE TRUNK IS NOT A LANE. The branch names the resolver's trunk names —
  // `trunk-ref.js::nonLaneBranches`, derived from `baseRef`, never a literal list —
  // are excluded, so an integration trunk carrying an unpushed merge is not charged
  // to the WIP limit or reported as depth.
  const notLanes = new Set(nonLaneBranches(baseRef));
  const rows = [];
  for (const line of raw ? raw.split("\n") : []) {
    if (!line) continue;
    const [name, ts, sha, parents] = line.split("\t");
    if (!name || notLanes.has(name)) continue;
    const n = Number(ts);
    rows.push({
      name,
      ageHours:
        Number.isFinite(n) && n > 0 ? (now - n * 1000) / 3_600_000 : null,
      ageBasis: "tip-committerdate",
      sha: sha || null,
      mergeTip: String(parents || "").trim().split(/\s+/).filter(Boolean).length > 1,
    });
  }
  // A LANE LANDED BY RECORDED PROVENANCE IS NOT OPEN. Ancestry alone reads every
  // replayed / squashed / conflict-fixed landing as open forever, because the
  // landed commits carry new ids; the `Landed-From` trailer is the recorded
  // link. Only a DECIDED-landed verdict removes a lane — every other outcome
  // (open, fallback, unmeasured) leaves it counted, so the count stays an upper
  // bound and can never drop a lane nothing recorded as landed.
  const { kept, landed: landedByProvenance, mapStatus } = _dropProvenanceLanded(
    repoDir,
    baseRef,
    rows,
  );
  const lanes = kept.map(({ name, ageHours, ageBasis }) => ({ name, ageHours, ageBasis }));
  const names = lanes.map((l) => l.name);
  return {
    ok: true,
    count: names.length,
    names,
    lanes,
    bound: "upper-reachability",
    // Lanes the ancestry candidate set held that the recorded provenance
    // decided LANDED — named, never silently dropped. `provenance` is "ok" when a
    // map was consulted, else "no-config" / "no-map" (legacy ancestry only).
    landedByProvenance,
    provenance: mapStatus,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE CENSUS — `wip-discipline.md` MUST-8's seven container classes.
 *
 * WHAT WAS MEASURED, AND WHY THIS EXISTS. Every `for-each-ref` in this module
 * read `refs/heads` (lines ~712, ~843, ~919 before this change) or
 * `refs/remotes` (~926). MUST-8 has required a seven-class census since
 * 2026-08-22 and the rule's own probe fixtures
 * (`audit-fixtures/wip-discipline/flag-census-scoped-to-one-ref-class.*`)
 * describe exactly this defect — but no enumerator here implemented it. The
 * 2026-09-11 audit of this repo found 694 containers a heads+remotes census
 * could not see: 49 of 50 TAGS were work containers (`reaped/`, `dead/`,
 * `backup/`, `parked-`, `preserve/`, `recover/`, `salvage/`, `wave6/`, `held/`,
 * `archive/`) and one was a release anchor; `refs/archive` held 615, `refs/rt`
 * 14, `refs/prs` 9, `refs/tmp` 5, `refs/lanes` 1.
 *
 * DISCOVER, NEVER ENUMERATE. The partition key is DERIVED from each refname
 * that comes back from an UNFILTERED `for-each-ref`; there is no list of
 * namespaces to census. This is not a stylistic preference — a pre-filter of
 * the shape `grep -Ev '^refs/(heads|remotes|tags)/'` is what CREATED the blind
 * spot, by excluding `refs/tags` inside a census that believed it was complete.
 * A namespace nobody anticipated therefore appears as its own partition, loudly
 * and `unclassified`, rather than not appearing at all.
 *
 * `refs/stash` NEEDS NO SPECIAL CALL, measured rather than assumed: an
 * unfiltered `git for-each-ref` emits it alongside every other ref. It is
 * nonetheless a LOWER BOUND and says so (`stashBound`) — the ref names only the
 * TOP of the stack, and a stash of N reads as 1 until `censusStashDepth` pays
 * the extra reflog spawn.
 *
 * THE THIRD VERDICT. Classification is `container` | `anchor` | `unclassified`,
 * declared in `ref-namespace-policy.json` and overridable three ways (an
 * injected `policy`, the `COC_REF_POLICY` env var, or editing the file). A ref
 * matching no rule is `unclassified` and folded into NEITHER total. A binary
 * classifier would emit the same verdict whether or not it had ever seen the
 * ref — `instrument-discipline.md` MUST-1 — and this repo's own
 * `provenance-event-schema/v1` is why that matters: ten live references depend
 * on it, one of them a shipped fixture whose `schema_tag` field IS that string,
 * so a sweep that defaulted unmatched tags to `container` would have destroyed
 * a cross-repo contract anchor.
 *
 * UNKNOWN IS NOT ZERO, PER PARTITION. Each sub-census carries its own `status`.
 * A partition that could not be measured is `status:"unknown"` with a reason and
 * is listed in `census.unknown` — never an empty set folded into a clean total.
 * That is the discipline `activity-build.mjs` already states for the survey as a
 * whole ("That is UNKNOWN, not zero"), applied one level down.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Glob → RegExp. Semantics are DELIBERATELY IDENTICAL to
 * `bin/remote-ref-reap.mjs`'s `globMatch`: `*` is the only metacharacter and
 * expands to `.*`, so it DOES cross `/` and there is no `**`.
 *
 * THE DUPLICATION IS REAL AND IS RECORDED RATHER THAN HIDDEN. That matcher is a
 * local `const` inside an ESM `.mjs` script with no export, and this file is
 * CJS, so it cannot be required here. Consolidating it into a shared lib is the
 * right end state and is NOT done in this change — it would widen the blast
 * radius from one enumerator to every reap surface. What is guaranteed instead
 * is that the two cannot DIVERGE silently: the semantics are pinned by a test,
 * so a change to either dialect reds.
 */
function _globToRegExp(glob) {
  return new RegExp(
    "^" +
      String(glob)
        .split("*")
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
}

const _POLICY_PATH = path.join(__dirname, "ref-namespace-policy.json");

/**
 * Load the DECLARED classification policy. Three override channels, in
 * precedence order: an injected `policy` object (tests, programmatic callers),
 * `COC_REF_POLICY` naming an alternate file (deployment-local, no repo edit),
 * then the shipped declaration beside this module.
 *
 * FAIL-HONEST, NEVER FAIL-SILENT. An absent or unreadable policy does NOT fall
 * back to a built-in list — a second copy of the declaration is exactly the
 * drift this file refuses elsewhere. It returns `ok:false`, and every ref then
 * classifies `unclassified`. The census still reports the full inventory; what
 * it declines to do is invent a verdict for it.
 */
function loadRefPolicy({ policy = null, policyPath = null } = {}) {
  if (policy && typeof policy === "object") {
    return {
      ok: true,
      source: "injected",
      namespaces: policy.namespaces || {},
      anchors: policy.anchors || [],
      containers: policy.containers || [],
    };
  }
  const p = policyPath || process.env.COC_REF_POLICY || _POLICY_PATH;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      ok: true,
      source: p,
      namespaces: parsed.namespaces || {},
      anchors: parsed.anchors || [],
      containers: parsed.containers || [],
    };
  } catch (e) {
    // UNKNOWN, not "no rules". The caller surfaces this; it never becomes a
    // silent all-`unclassified` that reads like a deliberate policy.
    return {
      ok: false,
      source: p,
      reason: `policy-unreadable (${(e && e.code) || "parse-error"})`,
      namespaces: {},
      anchors: [],
      containers: [],
    };
  }
}

/**
 * The partition key for a refname, DERIVED not looked up.
 *
 * `refs/remotes/<remote>/…` collapses to `refs/remotes` with the remote carried
 * separately, because MUST-8 requires every remote and a per-remote partition
 * would hide the class. Everything else keys on its `refs/<ns>` prefix, so an
 * unanticipated namespace becomes its own partition rather than vanishing.
 */
function refPartition(refname) {
  if (typeof refname !== "string" || !refname.startsWith("refs/")) {
    return { partition: "(non-refs)", remote: null };
  }
  if (refname === "refs/stash")
    return { partition: "refs/stash", remote: null };
  const rest = refname.slice("refs/".length);
  const slash = rest.indexOf("/");
  if (slash === -1) return { partition: `refs/${rest}`, remote: null };
  const ns = rest.slice(0, slash);
  if (ns === "remotes") {
    const tail = rest.slice(slash + 1);
    const s2 = tail.indexOf("/");
    return {
      partition: "refs/remotes",
      remote: s2 === -1 ? tail : tail.slice(0, s2),
    };
  }
  return { partition: `refs/${ns}`, remote: null };
}

/**
 * PURE. Classify ONE full refname against the loaded policy.
 *
 * ORDER IS LOAD-BEARING and is anchors-before-containers: an explicit anchor
 * rule must beat a broad container glob, because the error directions are not
 * symmetric. Mistaking an anchor for a container invites a destructive sweep of
 * a contract ref; mistaking a container for an anchor merely leaves inventory
 * standing, which the age bound will surface anyway.
 */
/**
 * PURE. The BRANCH NAME `isProtectedName` expects, derived from a full refname.
 *
 * A one-segment strip (`refs/<ns>/`) is WRONG for `refs/remotes`, whose names carry
 * an extra REMOTE segment: it yields `origin/preserve/x`, and `isProtectedName` is a
 * `startsWith` over `preserve/`, so a ref named for its own preservation reads
 * `protected: false`. Measured on this repo: `refs/remotes/origin/preserve/s50-coord-
 * predicate-983303d1` and `refs/remotes/origin/main` both read false under the old
 * derivation and true under this one.
 *
 * `landedRemoteRefs` in this same file already strips the full `refs/remotes/<remote>/`
 * prefix before calling the same predicate — two call sites, one file, opposite
 * verdicts on the same ref. This is the shared derivation both now use
 * (`security.md` § Enforcement-Surface Parity).
 */
function _protectionName(refname) {
  if (typeof refname !== "string") return "";
  if (refname.startsWith("refs/heads/")) return refname.slice(11);
  if (refname.startsWith("refs/remotes/")) {
    const rest = refname.slice(13);
    const i = rest.indexOf("/");
    // No slash ⇒ a bare remote name with no branch; return it rather than "" so
    // the unnameable branch of isProtectedName does not fire on a real ref.
    return i === -1 ? rest : rest.slice(i + 1);
  }
  return refname.replace(/^refs\/[^/]+\//, "");
}

function classifyRef(refname, policy) {
  const { partition } = refPartition(refname);
  for (const a of policy.anchors || []) {
    if (a && a.glob && _globToRegExp(a.glob).test(refname)) {
      return { verdict: "anchor", rule: a.glob, reason: a.reason || null };
    }
  }
  for (const c of policy.containers || []) {
    if (c && c.glob && _globToRegExp(c.glob).test(refname)) {
      return { verdict: "container", rule: c.glob, reason: c.reason || null };
    }
  }
  const ns = (policy.namespaces || {})[partition];
  if (ns && (ns.class === "container" || ns.class === "anchor")) {
    return { verdict: ns.class, rule: partition, reason: ns.reason || null };
  }
  // `mixed`, absent, or any class this code does not recognise. NOT a default
  // verdict — the honest third answer.
  return {
    verdict: "unclassified",
    rule: null,
    reason: ns
      ? `namespace ${partition} is declared '${ns.class}'; no anchor or container rule matched this ref`
      : `namespace ${partition} is not declared in the policy`,
  };
}

/**
 * PURE. Partition + classify the output of an UNFILTERED
 * `for-each-ref --format=%(refname)\t%(objectname)\t%(objecttype)\t%(creatordate:unix)`.
 *
 * Separated from the spawn so the classification is testable without a git
 * repository, and so `laneSurvey` can reuse the SAME spawn's output rather than
 * paying a second one.
 */
function partitionRefs(raw, policy, now = Date.now(), trunk = null) {
  const trunkRefs = new Set((trunk && trunk.refnames) || []);
  const partitions = Object.create(null);
  const remotes = Object.create(null);
  let total = 0;
  for (const line of raw ? raw.split("\n") : []) {
    if (!line) continue;
    const [refname, sha, objtype, ts] = line.split("\t");
    if (!refname) continue;
    total += 1;
    const { partition, remote } = refPartition(refname);
    let cls = classifyRef(refname, policy);
    // THE TRUNK IS NOT INVENTORY. A ref naming the resolved trunk that the POLICY
    // classed a `container` is moved to anchor — it stays a LISTED row, it is never
    // dropped. Only a container moves: a policy anchor keeps its own rule, and an
    // `unclassified` ref stays unclassified, because an unreadable or silent policy
    // must never acquire a verdict from somewhere else (the census's third answer).
    if (trunkRefs.has(refname) && cls.verdict === "container") {
      cls = {
        verdict: "anchor",
        rule: "trunk",
        reason: `the integration trunk (${trunk.ref}, basis ${trunk.basis}) — where lanes land, not inventory`,
      };
    }
    const n = Number(ts);
    const row = {
      ref: refname,
      sha: sha || null,
      objectType: objtype || null,
      ageHours:
        Number.isFinite(n) && n > 0 ? (now - n * 1000) / 3_600_000 : null,
      verdict: cls.verdict,
      rule: cls.rule,
      // Whether a REAP may touch it — a DIFFERENT question from whether it is a
      // container. `preserve/x` holds real work (container) that a human has
      // decided to keep (protected). Reuses the shared predicate rather than a
      // second copy (`security.md` § Enforcement-Surface Parity).
      protected: isProtectedName(_protectionName(refname)),
    };
    if (!partitions[partition]) {
      partitions[partition] = {
        status: "ok",
        total: 0,
        containers: 0,
        anchors: 0,
        unclassified: 0,
        refs: [],
      };
    }
    const p = partitions[partition];
    p.total += 1;
    p.refs.push(row);
    if (cls.verdict === "container") p.containers += 1;
    else if (cls.verdict === "anchor") p.anchors += 1;
    else p.unclassified += 1;
    if (remote) {
      if (!remotes[remote]) remotes[remote] = { total: 0, containers: 0 };
      remotes[remote].total += 1;
      if (cls.verdict === "container") remotes[remote].containers += 1;
    }
  }
  const totals = { containers: 0, anchors: 0, unclassified: 0 };
  for (const p of Object.values(partitions)) {
    totals.containers += p.containers;
    totals.anchors += p.anchors;
    totals.unclassified += p.unclassified;
  }
  return { partitions, remotes, total, totals };
}

/**
 * Which refs in THIS census are the integration trunk.
 *
 * The trunk is where lanes LAND, not inventory, so its refs are classed `anchor`
 * (rule `trunk`) — reclassified, never hidden. Taken from the caller's trunk when
 * one is passed (`laneSurvey` has already resolved it), else from the ref set this
 * census already read (`trunk-ref.js::resolveTrunkFromRefs`: the SAME ladder, no
 * spawn — this census's spawn count is pinned). UNDETERMINED reclassifies nothing
 * and says so in `bounds.trunk`.
 */
function _censusTrunk(refnames, given, remote = "origin") {
  const r =
    given && given.ref
      ? {
          status: "resolved",
          ref: given.ref,
          basis: given.basis || "caller",
          source: given.source || "caller",
        }
      : {
          ...resolveTrunkFromRefs({ refnames, remote }),
          source: "census-refs",
        };
  if (r.status !== "resolved") {
    return { status: "undetermined", reason: r.reason, source: r.source };
  }
  const branches = nonLaneBranches(r.ref);
  const names = new Set();
  const own = matchRefInSet(refnames, r.ref);
  if (own) names.add(own);
  for (const b of branches) {
    names.add(`refs/heads/${b}`);
    names.add(`refs/remotes/${remote}/${b}`);
  }
  return {
    status: "resolved",
    ref: r.ref,
    basis: r.basis,
    source: r.source,
    branches,
    refnames: [...names].filter((n) => refnames.has(n)).sort(),
  };
}

/**
 * The WORKTREE half of MUST-8 — classes 3 (registered), 4 (STRAY on disk) and
 * 6 (detached HEAD in any tree), all from ONE `worktree list --porcelain`
 * spawn plus a directory read.
 *
 * DETACHED HEAD COSTS NOTHING EXTRA, measured: the porcelain emits a literal
 * `detached` line per tree, so the per-tree `symbolic-ref` the extract's roster
 * names as the enumerator is not needed — one O(1) spawn answers a class the
 * roster prices at N.
 *
 * STRAY IS THE CLASS `git worktree list` CANNOT SEE, which is the whole reason
 * it is enumerated from the FILESYSTEM instead: a disconnected sibling dir is
 * invisible to the porcelain, and `worktree prune --dry-run` reports it as
 * nothing to prune. The sibling root is the one `agents.md` § Worktree
 * Orchestration mandates — `<repo-parent>/.<repo-slug>-wt/` — derived from
 * `repoDir`, never a `~/repos/...` path (`repo-scope-discipline.md`).
 */
function censusTrees(repoDir) {
  const out = {
    status: "ok",
    registered: [],
    detached: [],
    stray: { status: "ok", dirs: [], root: null },
  };
  const raw = _git(["worktree", "list", "--porcelain"], { cwd: repoDir });
  if (raw === null) {
    // UNKNOWN, never an empty forest.
    out.status = "unknown";
    out.reason = "worktree-list-failed";
  } else {
    let cur = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("worktree ")) {
        cur = {
          path: line.slice(9),
          head: null,
          branch: null,
          detached: false,
        };
        out.registered.push(cur);
      } else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
      else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7);
      else if (cur && line.trim() === "detached") {
        cur.detached = true;
        out.detached.push(cur);
      }
    }
  }
  try {
    const top = path.resolve(repoDir);
    const root = path.join(path.dirname(top), `.${path.basename(top)}-wt`);
    out.stray.root = root;
    const known = new Set(out.registered.map((w) => path.resolve(w.path)));
    // ENTRY-level failures are handled PER ENTRY and never abort the scan. A
    // single dangling symlink used to throw ENOENT from `statSync` INSIDE this
    // loop, land in the catch below, and reset `dirs` to [] with `status` still
    // "ok" — a PARTIALLY scanned directory reported as a MEASURED ZERO. Measured
    // bipolar: with one real stray dir present, adding a dangling symlink beside
    // it moved the verdict from `dirs:[realdir]` to `dirs:[]`, both "ok". Two
    // distinct causes (root absent vs one bad entry) had been collapsed onto one
    // error code.
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, ent.name);
      let isDir;
      if (ent.isDirectory()) isDir = true;
      else if (!ent.isSymbolicLink())
        continue; // a plain file is decisively not a tree
      else {
        // A symlink: resolve it. A DANGLING one is decisively not a directory —
        // a measured skip, not an unknown. Any OTHER error (EACCES, ELOOP, EIO)
        // leaves this entry genuinely unanswered, so the CLASS goes unknown
        // rather than the entry silently vanishing from a clean-looking total.
        try {
          isDir = fs.statSync(full).isDirectory();
        } catch (err) {
          if (err && (err.code === "ENOENT" || err.code === "ELOOP")) continue;
          out.stray.status = "unknown";
          out.stray.reason = `stray-entry-unreadable (${(err && err.code) || "unknown"})`;
          (out.stray.unreadable || (out.stray.unreadable = [])).push(full);
          continue;
        }
      }
      if (!isDir) continue;
      if (known.has(path.resolve(full))) continue;
      out.stray.dirs.push(full);
    }
  } catch (e) {
    if (e && e.code === "ENOENT") {
      // The ROOT itself is absent — a sibling root that was never created is a
      // MEASURED zero, not an unanswerable question: the directory's absence IS
      // the answer. Reachable only from `readdirSync(root)` now that entry-level
      // failures are handled above, which is what makes this reading sound.
      out.stray.dirs = [];
    } else {
      out.stray.status = "unknown";
      out.stray.reason = `stray-scan-failed (${(e && e.code) || "unknown"})`;
    }
  }
  // A stray count computed against an UNKNOWN registered set is not a stray
  // count — every dir would read stray. Say so rather than emit the number.
  if (out.status === "unknown" && out.stray.status === "ok") {
    out.stray.status = "unknown";
    out.stray.reason =
      "registered set unknown, so on-disk dirs cannot be partitioned into stray vs registered";
    out.stray.dirs = [];
  }
  return out;
}

/**
 * The LIVE remote query — OPT-IN, and opt-in for a stated reason.
 *
 * `refs/remotes` IS A CACHE. A ref can exist on the remote with no local
 * remote-tracking counterpart (never fetched, or fetched before it was pushed),
 * so reporting the cache AS the remote is the wrong-question instrument
 * `instrument-discipline.md` MUST-4 names. The honest fix is to ask the remote —
 * but `git ls-remote` is a NETWORK round trip, and `laneSurvey` runs on a
 * `PreToolUse` path with a few-hundred-millisecond budget. Putting a network
 * call there would reproduce the signing-guard outage (loom#1921) exactly.
 *
 * So it is OFF by default and the census SAYS SO: `remote.source` reads
 * `"cache"` with `liveQueried:false`, never a silent claim about the remote.
 */
function censusLiveRemote(repoDir, remote, cachedByRef, timeout) {
  const raw = _git(["ls-remote", "--refs", remote], {
    cwd: repoDir,
    timeout: timeout || 15000,
  });
  if (raw === null) {
    return { status: "unknown", reason: `ls-remote-failed (${remote})` };
  }
  // MEMBERSHIP IS BY REF NAME, NEVER BY SHA — and that distinction was found by
  // firing this at a known-answer case rather than reasoning about it. A lane
  // pushed at the trunk's tip shares the trunk's sha, so a sha-keyed comparison
  // reports it CACHED when no cache entry for it exists at all: the exact ref
  // this query was added to find, invisible to the query that was added to find
  // it. `conservation-gate.md` MUST-2 states the general form — membership is
  // decided by the identity the QUESTION is about, never by whichever identity
  // the comparison happened to have in hand.
  const missing = [];
  const stale = [];
  let total = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [sha, ref] = line.split("\t");
    if (!sha || !ref) continue;
    total += 1;
    // `refs/heads/x` on the remote is cached as `refs/remotes/<remote>/x`;
    // `refs/tags/x` is cached under `refs/tags/x` unchanged.
    let expected = null;
    if (ref.startsWith("refs/heads/")) {
      expected = `refs/remotes/${remote}/${ref.slice("refs/heads/".length)}`;
    } else if (ref.startsWith("refs/tags/")) {
      expected = ref;
    }
    if (expected === null) continue; // a namespace the cache never mirrors
    if (!cachedByRef.has(expected)) missing.push({ ref, sha, expected });
    else if (cachedByRef.get(expected) !== sha) {
      stale.push({ ref, remoteSha: sha, cachedSha: cachedByRef.get(expected) });
    }
  }
  return {
    status: "ok",
    remote,
    total,
    uncachedCount: missing.length,
    missing,
    staleCount: stale.length,
    stale,
  };
}

/**
 * refCensus — MUST-8's census as a first-class call.
 *
 * TWO SPAWNS by default (one unfiltered `for-each-ref`, one
 * `worktree list --porcelain`) plus one directory read, regardless of how many
 * refs, remotes, namespaces or trees exist. Both are O(1) in container count,
 * which is the property `laneCountFast`'s docblock above records as the durable
 * one.
 */
function refCensus({
  repoDir,
  policy = null,
  policyPath = null,
  now = Date.now(),
  trees = true,
  liveRemote = false,
  liveRemoteName = "origin",
  stashDepth = false,
} = {}) {
  const startedAt = Date.now();
  const pol = loadRefPolicy({ policy, policyPath });
  const raw = _git(
    [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(objecttype)%09%(creatordate:unix)",
    ],
    { cwd: repoDir, timeout: 4000 },
  );
  const census = _censusFromRefs(raw, pol, {
    repoDir,
    now,
    trees,
    liveRemote,
    liveRemoteName,
    stashDepth,
  });
  census.elapsedMs = Date.now() - startedAt;
  return census;
}

/**
 * The census body, split out so `laneSurvey` reuses its ALREADY-SPAWNED
 * all-refs output rather than paying a second `for-each-ref` for the same
 * bytes. `raw === null` means the call failed — UNKNOWN for every ref class at
 * once, never an empty forest.
 */
function _censusFromRefs(
  raw,
  pol,
  { repoDir, now, trees, liveRemote, liveRemoteName, stashDepth, trunk = null },
) {
  const unknown = [];
  const out = {
    policy: {
      ok: pol.ok,
      source: pol.source,
      ...(pol.ok ? {} : { reason: pol.reason }),
    },
    refs: null,
    trees: null,
    unknown,
    spawns: 1,
    bounds: {
      // Every bound this census carries, stated where the numbers are read.
      stash: "lower-top-ref-only",
      classification: "declared-policy; unmatched refs are `unclassified`",
      remote: liveRemote ? "live" : "cache-only",
      trunk: "the ref set was not read, so no ref was classed as the trunk",
    },
    trunk: { status: "undetermined", reason: "the ref set could not be read" },
  };
  if (!pol.ok) unknown.push("policy");

  if (raw === null) {
    out.refs = { status: "unknown", reason: "for-each-ref-failed" };
    unknown.push("refs");
  } else {
    const refnames = new Set();
    for (const line of raw.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab > 0) refnames.add(line.slice(0, tab));
    }
    out.trunk = _censusTrunk(refnames, trunk);
    out.bounds.trunk =
      out.trunk.status === "resolved"
        ? `the integration trunk (${out.trunk.ref}) is LISTED and classed anchor (rule \`trunk\`); it is not inventory`
        : `the trunk is UNDETERMINED (${out.trunk.reason}); no ref was reclassified, so a trunk branch outside the policy's anchors counts as a container`;
    const parted = partitionRefs(
      raw,
      pol,
      now,
      out.trunk.status === "resolved" ? out.trunk : null,
    );
    out.refs = {
      status: "ok",
      total: parted.total,
      totals: parted.totals,
      partitions: parted.partitions,
      remotes: parted.remotes,
      // Named so a reader can see the discovery worked rather than infer it.
      namespaces: Object.keys(parted.partitions).sort(),
    };
    const stash = parted.partitions["refs/stash"];
    if (stash) {
      out.refs.stashEntries = stash.total;
      if (stashDepth) {
        const rl = _git(["reflog", "show", "refs/stash"], { cwd: repoDir });
        out.spawns += 1;
        if (rl === null) {
          out.refs.stashDepth = { status: "unknown", reason: "reflog-failed" };
          unknown.push("stashDepth");
        } else {
          out.refs.stashDepth = {
            status: "ok",
            entries: rl.split("\n").filter(Boolean).length,
          };
          out.bounds.stash = "exact-reflog";
        }
      }
    }
  }

  if (trees) {
    out.trees = censusTrees(repoDir);
    out.spawns += 1;
    if (out.trees.status === "unknown") unknown.push("trees");
    if (out.trees.stray.status === "unknown") unknown.push("strayTrees");
  } else {
    out.trees = { status: "unknown", reason: "not-requested (trees:false)" };
    unknown.push("trees");
  }

  if (liveRemote) {
    // Keyed by REF NAME (see `censusLiveRemote`), because the question is
    // "does the cache hold an entry for this remote ref", not "has the cache
    // seen this sha somewhere".
    const cached = new Map();
    const p =
      out.refs && out.refs.partitions && out.refs.partitions["refs/remotes"];
    for (const r of (p && p.refs) || []) if (r.ref) cached.set(r.ref, r.sha);
    for (const r of (out.refs &&
      out.refs.partitions &&
      out.refs.partitions["refs/tags"] &&
      out.refs.partitions["refs/tags"].refs) ||
      [])
      if (r.ref) cached.set(r.ref, r.sha);
    out.remote = censusLiveRemote(repoDir, liveRemoteName, cached);
    out.spawns += 1;
    if (out.remote.status === "unknown") unknown.push("remote");
    out.remote.liveQueried = true;
    out.remote.source = "ls-remote";
  } else {
    out.remote = {
      status: "unknown",
      liveQueried: false,
      source: "cache",
      reason:
        "remote-tracking refs are a CACHE, not the remote; a ref can exist on the remote with no local counterpart. Pass liveRemote:true to ask (one network round trip, off by default on the hook path).",
    };
    unknown.push("remote");
  }

  // Containers ACROSS classes. Deliberately excludes `unclassified` — folding
  // an unadjudicated ref into a container total is the move that would let a
  // sweep act on it.
  // A CLASS-LEVEL "ok" is not enough: each class has a SUB-class that can be
  // unknown on its own while the parent still reads ok, and summing across it
  // yields a partial total wearing a total's grammar.
  //   refs   — the policy can fail to load, in which case every ref classifies
  //            `unclassified` and `totals.containers` is 0 while enumeration
  //            (and so `refs.status`) succeeded. A clean-looking 0 from a
  //            classifier that never ran.
  //   trees  — `stray.status` can be unknown (an unreadable entry) while
  //            `trees.status` is ok, so `stray.dirs` omits an unknown number.
  const policyOk = !(out.policy && out.policy.ok === false);
  const refContainers =
    out.refs && out.refs.status === "ok" && policyOk
      ? out.refs.totals.containers
      : null;
  const treeContainers =
    out.trees &&
    out.trees.status === "ok" &&
    out.trees.stray &&
    out.trees.stray.status === "ok"
      ? out.trees.registered.length + out.trees.stray.dirs.length
      : null;
  out.containerTotal =
    refContainers === null || treeContainers === null
      ? null // UNKNOWN, never a partial sum wearing a total's grammar
      : refContainers + treeContainers;
  out.complete = unknown.length === 0;
  return out;
}

/**
 * laneSurvey — the SessionStart-grade survey. Batched, bounded, honest.
 *
 * WHY IT EXISTS, MEASURED. `openLanes` above issues per-branch git calls, and
 * each one costs ~150-170 ms on this corpus (measured: `cherry` 164 ms,
 * `branch -r --contains` 147 ms, `rev-parse` 169 ms). Over 99 candidate
 * branches that is ~45 s, which is what `openLanes` actually took end-to-end.
 * A SessionStart hook that costs 45 s does not report inventory; it becomes
 * the outage. Same O(N)-spawn shape as the signing-guard defect (loom#1921).
 *
 * THE BATCHING, and what each call replaces:
 *   1. ONE `for-each-ref refs/heads --no-merged` → every candidate branch WITH
 *      its tip SHA and committer date. Replaces N `rev-parse` calls.
 *   2. ONE `for-each-ref refs/remotes` → the set of remote tip SHAs (measured
 *      1560 SHAs in 162 ms). Replaces N `branch -r --contains` calls.
 *   3. `cherry` ONLY for the lanes actually being REPORTED (top-N by age), not
 *      for all N. Exact content classification where it is shown; a declared
 *      bound everywhere else.
 *
 * THE BOUNDS, stated because a survey that hides them is the 63%-noise defect
 * (loom#1885) wearing a faster coat:
 *   - `pushed` is decided by TIP-SHA membership in the remote set. A branch
 *     pushed and then advanced locally reads LOCAL-ONLY here. That is the SAFE
 *     direction — it over-reports at-risk work rather than under-reporting it.
 *   - `ageHours` is the TIP committer date: "how long since this lane was
 *     touched", not "how long it has been open". The oldest-unlanded-commit age
 *     is what `openLanes` computes; this is the cheap proxy and is labelled.
 *   - Candidates are ancestry-unmerged, so the count is an UPPER BOUND on
 *     genuinely-unlanded content until `cherry` runs per lane.
 */
function laneSurvey({
  repoDir,
  baseRef = null, // resolved via trunk-ref.js below
  now = Date.now(),
  classifyTop = 10,
  // MUST-8's census, ADDITIVE. `false` skips it entirely (the `trees` spawn is
  // the only cost a caller can want back); an object is passed through to
  // `_censusFromRefs` so a caller may opt INTO the network (`liveRemote:true`)
  // or the stash reflog (`stashDepth:true`) without either becoming a default.
  census = true,
  policy = null,
  policyPath = null,
  // PER-LANE DEPTH, ADDITIVE and OPT-IN (journal/0607 decision 3), like the
  // census's `liveRemote` / `stashDepth`. It costs one `git ls-files` spawn, and
  // this function's spawn budget is pinned (`wip-census-namespaces.test.mjs`:
  // 2 ref spawns, +1 for the census) because the PreToolUse arm calls it on the
  // hot path. `true` asks; an object also injects `listTodoFiles` /
  // `readTodoHead` (see `laneDepth`).
  depth = false,
} = {}) {
  // The integration trunk, resolved STRICTLY when the caller omitted it —
  // `_trunkFor`, the shared resolver (`wip-discipline.md` MUST-4).
  let trunkBasis = "caller";
  if (!baseRef) {
    const t = _trunkFor(repoDir, { timeoutMs: 4000 });
    if (!t.ok) {
      return {
        ok: false,
        reason: t.reason,
        trunk: t.trunk,
        trunkReason: t.trunkReason,
      };
    }
    baseRef = t.ref;
    trunkBasis = t.basis;
  }
  // THE TRUNK IS NOT A LANE. The branch names the resolver's trunk names —
  // `trunk-ref.js::nonLaneBranches`, derived from `baseRef`, never a literal list —
  // are excluded, so an integration trunk carrying an unpushed merge is not charged
  // to the WIP limit or reported as depth.
  const notLanes = new Set(nonLaneBranches(baseRef));
  const startedAt = Date.now();

  const headsRaw = _git(
    [
      "for-each-ref",
      "--no-merged",
      baseRef,
      // `%(parent)` rides the same spawn for the exact provenance prefilter.
      "--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)%09%(parent)",
      "refs/heads",
    ],
    { cwd: repoDir, timeout: 4000 },
  );
  if (headsRaw === null) return { ok: false, reason: "for-each-ref-failed" };

  // ONE UNFILTERED `for-each-ref`, REPLACING the `refs/remotes` objectname call
  // this function used to make. NOT an addition: the same spawn now answers
  // BOTH questions, because a format carrying the refname alongside the
  // objectname lets the remote-tip set be FILTERED OUT of a complete census
  // instead of being fetched by a query that excluded every other class.
  //
  // That is the whole shape of the fix. The old call asked git for one
  // namespace and therefore could not have reported another, however carefully
  // its output was read; this one asks for everything and partitions in
  // process. Net spawn delta for `laneSurvey`: ZERO for the ref classes.
  const allRefsRaw = _git(
    [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(objecttype)%09%(creatordate:unix)",
    ],
    { cwd: repoDir, timeout: 4000 },
  );
  // The EXISTING reason string is preserved deliberately: consumers branch on
  // it, and this call is a superset of the one it replaces, so its failure
  // still means exactly "the remote set could not be read".
  if (allRefsRaw === null) return { ok: false, reason: "remote-set-failed" };
  const remoteTips = new Set();
  for (const line of allRefsRaw.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    if (!line.startsWith("refs/remotes/")) continue;
    const rest = line.slice(tab + 1);
    const tab2 = rest.indexOf("\t");
    remoteTips.add(tab2 === -1 ? rest : rest.slice(0, tab2));
  }

  const rows = [];
  for (const line of headsRaw ? headsRaw.split("\n") : []) {
    const [name, sha, ts, parents] = line.split("\t");
    if (!name || notLanes.has(name)) continue;
    rows.push({
      name,
      sha,
      ageHours: ts ? (now - Number(ts) * 1000) / 3_600_000 : null,
      ageBasis: "tip-committerdate",
      localOnly: !remoteTips.has(sha),
      uniqueCommits: null, // filled below for the reported subset only
      mergeTip: String(parents || "").trim().split(/\s+/).filter(Boolean).length > 1,
    });
  }
  // A LANE LANDED BY RECORDED PROVENANCE IS NOT OPEN — the same exact filter
  // `laneCountFast` applies (`_dropProvenanceLanded`). This is what the debt
  // check (`wip-discipline-guard.js::laneStillOpen`) and every depth / age report
  // read, so a replayed landing no longer reads as a lane still owed.
  const {
    kept,
    landed: landedByProvenance,
    map: surveyMap,
    mapStatus,
  } = _dropProvenanceLanded(repoDir, baseRef, rows);
  const lanes = kept.map(({ mergeTip, ...l }) => l);

  lanes.sort((a, b) => (b.ageHours ?? Infinity) - (a.ageHours ?? Infinity));

  // Exact classification ONLY for the lanes that will be shown — provenance
  // first, `git cherry` only on the core's fallback (`_laneContent`).
  let classified = 0;
  for (const l of lanes.slice(0, classifyTop)) {
    const c = _laneContent(repoDir, baseRef, l.name, l.name, GIT_TIMEOUT_MS, surveyMap);
    if (c.unique !== null) {
      l.uniqueCommits = c.unique;
      l.decidedBy = c.instrument;
      classified += 1;
    }
  }

  // ── THE CENSUS, ADDITIVE ──────────────────────────────────────────────────
  //
  // `lanes`, `count`, `localOnly`, `classified`, `countBound`, `ageBasis` and
  // `ok`/`reason` are BYTE-IDENTICAL to what this returned before, because
  // `activity-build.mjs` reads `survey.ok`, `survey.lanes[].ageHours` and
  // `survey.reason`, and `wip-discipline-guard.js` additionally reads
  // `survey.localOnly` and `survey.classified`. Nothing above is repurposed;
  // `census` is a new field beside them.
  //
  // REFS BELONG ON THE LANE AXIS AND NOWHERE NEAR THE BURNDOWN. This census is
  // reported HERE rather than promoted into an item population for the reason
  // `activity-build.mjs`'s own header gives: a feed that inflates the
  // denominator degrades every percentage in the report, blows `max_rows`, and
  // turns an adjudicated backlog into an unadjudicated feed nobody drains.
  const censusOpts = census && typeof census === "object" ? census : {};
  const laneCensus =
    census === false
      ? null
      : _censusFromRefs(allRefsRaw, loadRefPolicy({ policy, policyPath }), {
          repoDir,
          now,
          trunk: { ref: baseRef, basis: trunkBasis, source: "laneSurvey" },
          trees: censusOpts.trees !== false,
          liveRemote: censusOpts.liveRemote === true,
          liveRemoteName: censusOpts.liveRemoteName || "origin",
          stashDepth: censusOpts.stashDepth === true,
        });

  return {
    ok: true,
    lanes,
    count: lanes.length,
    localOnly: lanes.filter((l) => l.localOnly).length,
    classified,
    countBound: "upper-ancestry",
    ageBasis: "tip-committerdate",
    // Ancestry candidates the recorded provenance decided LANDED — named, and
    // excluded from `lanes`/`count`. `provenance`: "ok" | "no-config" | "no-map".
    landedByProvenance,
    provenance: mapStatus,
    // NULL means NOT ASKED, which is a third answer and not an empty forest —
    // a consumer that reads `census` must branch on it before reading a total.
    census: laneCensus,
    // PER-LANE DEPTH — a new field BESIDE `lanes`, never written into a lane
    // row, for the same byte-identity reason `census` gives above. NULL means
    // NOT ASKED; `{ok:false, reason}` means ASKED AND UNANSWERABLE. Neither is
    // an empty ledger.
    depth: depth ? _surveyDepth(repoDir, lanes, depth) : null,
    elapsedMs: Date.now() - startedAt,
  };
}

// ── LANE DEPTH (journal/0607 decision 3; rules/wip-discipline.md MUST-9) ──────
//
// A lane is a MINI-ORCHESTRATOR: the WIP ceiling counts worktrees and branches,
// never agents, so a lane should carry as many items (and agents) as it can.
// Nothing could say how deep a lane was, because no ledger item recorded the
// lane carrying it. The binding is `todo-durable.js::parseLaneBinding` — a
// `lane: <branch>` frontmatter key the producer writes — and this is the join.

/** The per-lane verdicts, most actionable first. */
const LANE_DEPTH_VERDICTS = Object.freeze([
  "UNDER-PACKED",
  "UNDETERMINED",
  "NOTHING-QUEUED",
  "PACKED",
]);

/** Launch-record keys that WOULD let a dispatch be joined to a lane. */
const LANE_ATTRIBUTION_KEYS = Object.freeze([
  "lane",
  "branch",
  "worktree",
  "cwd",
]);

/**
 * THE PATH→LANE MAP. Every registered worktree's REAL path and the branch checked out in it.
 *
 * ## The defect this closes, MEASURED
 *
 * `dispatch-ledger.js` writes `cwd` / `worktree` on every launch row, and
 * `delegation-default.js::attributeLaunchesToLanes` joins those keys ONLY through a
 * `worktreeLanes` map its caller supplies. `laneDepth` accepted the parameter and NEVER built
 * it, and `wip-discipline-guard.js::runSessionStart` never passed one — so at both lane-depth
 * sites a row carrying only path keys was unidentified, every lane's agent axis read UNMEASURED,
 * and the join was live only for the `lane` / `branch` name keys. The Stop arm in
 * `delegation-default-guard.js` built its own map; these two sites did not.
 *
 * ## ONE bounded call, never per row
 *
 * One `git worktree list --porcelain` per `_laneAgents` invocation, and only when a row actually
 * carries a path key — a repository whose dispatches all name a lane pays nothing.
 *
 * ## RESOLVED on BOTH sides, or the row stays unidentified
 *
 * Each listed worktree path is put through `fs.realpathSync`, and so is each row's path value
 * (§ `_pathLaneMapForRows`). Comparing a resolved candidate against a RAW root is the
 * lexical-bypass shape `rules/security.md` § Path Containment forbids, and on macOS it is not
 * hypothetical: `/tmp` is a symlink to `/private/tmp`, so a fixture repository created under
 * `/tmp` lists one form and reports the other. A path that will NOT resolve — a worktree removed
 * since the dispatch — is DROPPED, so its row reads unidentified (UNMEASURED), never zero.
 *
 * @returns {{ok:true, roots:Array<{real:string, branch:string}>} | {ok:false, reason:string}}
 */
function _worktreeLaneRoots(repoDir, timeout = GIT_TIMEOUT_MS) {
  const raw = _git(["worktree", "list", "--porcelain"], {
    cwd: repoDir,
    timeout,
  });
  if (raw === null)
    return {
      ok: false,
      reason:
        "git could not list this repository's worktrees, so a dispatch row carrying only a cwd or worktree path could not be joined to a lane",
    };
  const roots = [];
  let cur = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) cur = line.slice("worktree ".length);
    else if (cur && line.startsWith("branch ")) {
      const branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      let real = null;
      try {
        real = fs.realpathSync(cur);
      } catch {
        real = null;
      }
      if (real && branch) roots.push({ real, branch });
      cur = null;
    } else if (line.trim() === "") cur = null;
  }
  return { ok: true, roots };
}

/**
 * Keyed by each ROW's own path string, so the consumer's exact-match lookup hits.
 *
 * `attributeLaunchesToLanes` compares `path.resolve(key)` to `path.resolve(row[k])` — an EXACT
 * match against a map keyed on worktree ROOTS, which a `cwd` naming a SUBDIRECTORY inside a lane
 * worktree would miss, and which a symlinked prefix would miss on both halves. Containment and
 * real-path resolution are therefore performed HERE, where this module owns both sides, and the
 * result is emitted under the row's literal string so the consumer's lookup is a tautology.
 *
 * A value outside every worktree root is deliberately ABSENT from the map: the row then reads
 * unidentified, which is what `laneDepth` reports as UNATTRIBUTED rather than as zero agents.
 */
function _pathLaneMapForRows(rows, roots) {
  const map = {};
  const cache = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== "object" || r.kind !== "launch") continue;
    for (const k of LANE_PATH_KEYS_LOCAL) {
      const v = r[k];
      if (typeof v !== "string" || v.length === 0 || map[v] !== undefined)
        continue;
      let real;
      if (cache.has(v)) real = cache.get(v);
      else {
        try {
          real = fs.realpathSync(v);
        } catch {
          real = null;
        }
        cache.set(v, real);
      }
      if (real === null) continue;
      for (const root of roots) {
        if (real === root.real || real.startsWith(root.real + path.sep)) {
          map[v] = root.branch;
          break;
        }
      }
    }
  }
  return map;
}

/** The path-joined subset of `LANE_ATTRIBUTION_KEYS`; pinned against the consumer's own export. */
const LANE_PATH_KEYS_LOCAL = Object.freeze(["worktree", "cwd"]);

/**
 * The verdict for ONE lane — pure.
 *
 *   QUEUED       an outstanding item whose declared lane EXISTS NOWHERE in this
 *                repository: work waiting for a lane to be opened for it.
 *   ORPHANED     an outstanding item whose declared lane is a ref that is NOT an
 *                open lane — the lane LANDED (an unlanded local branch is always
 *                open). Stale bookkeeping, NOT work a lane can absorb, so it
 *                NEVER drives UNDER-PACKED. Before the split, one landed lane's
 *                leftover item marked EVERY serial lane UNDER-PACKED.
 *   UNDER-PACKED `queuedCount > 0` AND the lane is SERIAL — at most one bound
 *                item, OR at most one MEASURED agent. The directive's case.
 *   PACKED       two or more bound items AND a MEASURED two or more agents.
 *   UNDETERMINED any axis that was not measured: two or more items whose agent
 *                count is UNATTRIBUTED (a 4-item lane worked by ONE serial agent
 *                and a 4-item lane worked by four are indistinguishable without
 *                the join, so neither reads PACKED), or an outstanding todo file
 *                whose binding could not be measured. Never NOTHING-QUEUED.
 *   NOTHING-QUEUED serial, nothing queued, nothing unmeasured.
 *
 * `agents: null` means UNATTRIBUTED and is never read as 0 — only a MEASURED
 * agent count may make a lane serial on the agent axis, and only a MEASURED
 * count of two or more may make it PACKED.
 */
function laneDepthVerdict({
  itemCount,
  agents = null,
  queuedCount = 0,
  unmeasuredCount = 0,
} = {}) {
  const n = Number.isInteger(itemCount) && itemCount >= 0 ? itemCount : 0;
  const measured = Number.isInteger(agents) && agents >= 0;
  const oneAgent = measured && agents <= 1;
  const serial = n <= 1 || oneAgent;
  if (queuedCount > 0 && serial) {
    return {
      verdict: "UNDER-PACKED",
      why: `carries ${n} item(s)${oneAgent ? ` and ${agents} attributed agent(s)` : ""} while ${queuedCount} item(s) are QUEUED`,
    };
  }
  if (!serial && !measured) {
    return {
      verdict: "UNDETERMINED",
      why: `carries ${n} item(s), but no dispatch this session could be attributed to it — whether ${n} items are worked in parallel or by ONE serial agent is UNMEASURED, so this is not PACKED`,
    };
  }
  if (!serial) {
    return {
      verdict: "PACKED",
      why: `${n} item(s) bound, ${agents} attributed agent(s)`,
    };
  }
  if (unmeasuredCount > 0) {
    return {
      verdict: "UNDETERMINED",
      why: `carries ${n} item(s) and none are QUEUED, but ${unmeasuredCount} todo file(s) could not be measured as bound or queued — whether work is waiting is UNMEASURED`,
    };
  }
  return {
    verdict: "NOTHING-QUEUED",
    why: `carries ${n} item(s) and no outstanding item is waiting`,
  };
}

/**
 * THE AGENT JOIN. How many of THIS session's dispatches went to each lane.
 *
 * ONE join implementation, not two. The row→lane predicate is
 * `delegation-default.js::attributeLaunchesToLanes` — the same function the Stop
 * arm uses — called here rather than restated, so a key added to
 * `LANE_ATTRIBUTION_KEYS` changes both readers at once. This module's older
 * `_agentsAttribution` probed the producer's record SHAPE and returned `null`
 * unconditionally; `dispatch-ledger.js` now writes `cwd` / `worktree` / `branch`
 * on every launch row, so the shape probe's premise is gone and the join is real.
 *
 * TRI-STATE PER LANE, and a zero is never fabricated:
 *   `n > 0`                         MEASURED n.
 *   0 with UNIDENTIFIED rows        `null` — some dispatch this session named no
 *                                   lane it could resolve, so whether one went
 *                                   here is UNMEASURED, not zero.
 *   0 with unparsed ledger lines    `null` — any of them could be a launch here.
 *   0, every row attributed         MEASURED 0.
 *   the ledger could not be read    `null` for every lane, reason carried.
 */
function _laneAgents({
  repoDir,
  laneNames,
  sessionId = null,
  ledgerRows = null,
  worktreeLanes = null,
}) {
  let join;
  try {
    ({ attributeLaunchesToLanes: join } = require(
      path.join(__dirname, "delegation-default.js"),
    ));
  } catch (e) {
    return {
      perLane: null,
      reason: `the dispatch-attribution join could not be loaded (${(e && e.message) || e}) — agents UNATTRIBUTED, not zero`,
    };
  }
  let rows = Array.isArray(ledgerRows) ? ledgerRows : null;
  let skipped = 0;
  let failure = null;
  if (rows === null) {
    try {
      const DL = require(path.join(__dirname, "dispatch-ledger.js"));
      const r = DL.readLedger({ repoDir, sessionId: sessionId || undefined });
      if (r && r.ok) {
        rows = r.rows;
        skipped = Number.isInteger(r.skipped) ? r.skipped : 0;
      } else {
        failure = {
          reason: (r && r.reason) || "the dispatch ledger could not be read",
        };
      }
    } catch (e) {
      failure = {
        reason: `dispatch-ledger.js could not be read (${(e && e.message) || e})`,
      };
    }
  }
  // BUILD THE PATH→LANE MAP, ONCE, AND ONLY IF A ROW NEEDS IT.
  //
  // A caller that supplied one (the Stop arm in `delegation-default-guard.js`) keeps it; the two
  // sites that never did — `laneDepth`'s own callers and `runSessionStart` — are served here, so
  // the build lives in ONE place rather than being restated per call site. `mapFailure` is carried
  // into the per-lane reason below: a map that could not be built makes the path rows UNMEASURED
  // WITH A NAMED CAUSE, and is never allowed to read as "no agents".
  let pathLanes =
    worktreeLanes && typeof worktreeLanes === "object" ? worktreeLanes : null;
  let mapFailure = null;
  if (pathLanes === null && Array.isArray(rows) && repoDir) {
    const needPaths = rows.some(
      (r) =>
        r &&
        typeof r === "object" &&
        r.kind === "launch" &&
        LANE_PATH_KEYS_LOCAL.some(
          (k) => typeof r[k] === "string" && r[k].length > 0,
        ),
    );
    if (needPaths) {
      let built;
      try {
        built = _worktreeLaneRoots(repoDir);
      } catch (e) {
        built = {
          ok: false,
          reason: `the worktree listing threw (${(e && e.message) || e})`,
        };
      }
      if (built.ok) pathLanes = _pathLaneMapForRows(rows, built.roots);
      else mapFailure = built.reason;
    }
  }
  const att = join({
    rows,
    failure,
    skipped,
    sessionId:
      typeof sessionId === "string" && sessionId ? sessionId : undefined,
    laneNames: Array.isArray(laneNames) ? laneNames : [],
    worktreeLanes: pathLanes,
  });
  if (!att || att.ok !== true) {
    return {
      perLane: null,
      reason: `${(att && att.reason) || "the dispatch ledger was not read"} — agents UNATTRIBUTED, not zero`,
    };
  }
  const perLane = new Map();
  for (const lane of Array.isArray(laneNames) ? laneNames : []) {
    const n = att.perLane.get(lane) || 0;
    if (n > 0) {
      perLane.set(lane, {
        agents: n,
        reason: `${n} launch row(s) this session name this lane`,
      });
    } else if (att.unidentified > 0) {
      perLane.set(lane, {
        agents: null,
        reason:
          `${att.unidentified} of this session's ${att.total} launch row(s) carry no lane, branch, worktree or cwd value that resolves to a lane, so whether any went to this lane is UNMEASURED — not zero` +
          (mapFailure ? ` (${mapFailure})` : ""),
      });
    } else if (att.skipped > 0) {
      perLane.set(lane, {
        agents: null,
        reason: `${att.skipped} dispatch-ledger line(s) did not parse, and any of them could be a launch for this lane — UNMEASURED, not zero`,
      });
    } else {
      perLane.set(lane, {
        agents: 0,
        reason:
          att.total === 0
            ? "this session's dispatch ledger holds no launch row at all — a MEASURED zero"
            : `all ${att.total} launch row(s) this session name other lanes — a MEASURED zero`,
      });
    }
  }
  return {
    perLane,
    reason: `${att.total} launch row(s) this session, ${att.unidentified} unidentified, ${att.elsewhere} for lanes outside this set, ${att.skipped} unparsed line(s)`,
  };
}

/**
 * Every branch name that EXISTS in this repository — local heads plus the short
 * name of every remote-tracking ref. `null` when git could not answer, which is
 * a THIRD state and is never read as "the name does not exist".
 *
 * ONE spawn, whatever the ref count: this is the instrument that separates
 * ORPHANED from QUEUED, and it must not scale with the forest.
 */
function _refShortNames(repoDir, timeout = GIT_TIMEOUT_MS) {
  const out = _git(
    ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
    { cwd: repoDir, timeout },
  );
  if (out === null) return null;
  const names = new Set();
  for (const line of out.split("\n")) {
    const ref = line.trim();
    if (ref.startsWith("refs/heads/"))
      names.add(ref.slice("refs/heads/".length));
    else if (ref.startsWith("refs/remotes/")) {
      const rest = ref.slice("refs/remotes/".length);
      const slash = rest.indexOf("/");
      if (slash > 0) names.add(rest.slice(slash + 1));
    }
  }
  return names;
}

/** Tracked todo markdown. `null` when git could not answer — never `[]`. */
function _trackedTodoMarkdown(repoDir) {
  const out = _git(["ls-files", "-z", "--", "workspaces/*/todos/**"], {
    cwd: repoDir,
    timeout: 2000,
  });
  if (out === null) return null;
  return out.split("\0").filter((p) => p && p.endsWith(".md"));
}

/**
 * The first `maxBytes` of a tracked todo file. `security.md` § Path
 * Containment: the repo root and the candidate are resolved through the SAME
 * resolver, a non-regular file (a symlink included) is refused, and the open
 * carries `O_NOFOLLOW`. Throws on refusal — the caller records UNREADABLE.
 */
function _readTodoHead(repoDir, rel, maxBytes) {
  const root = fs.realpathSync(repoDir);
  const abs = path.resolve(root, rel);
  if (!fs.lstatSync(abs).isFile()) throw new Error("not a regular file");
  const real = fs.realpathSync(abs);
  if (!real.startsWith(root + path.sep))
    throw new Error("resolves outside the repository");
  const fd = fs.openSync(
    real,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * laneDepth — per-lane depth from the work ledger.
 *
 * @param {object} o
 * @param {string} o.repoDir
 * @param {string[]|null} [o.openLanes] open lane (branch) names; null ⇒ `laneSurvey`
 * @param {Function|null} [o.listTodoFiles] `() => string[]`; null ⇒ `git ls-files`
 * @param {Function|null} [o.readTodoHead] `(rel) => string`; null ⇒ bounded fs read
 * @param {Function|null} [o.listRefNames] `() => Set<string>|null`; null ⇒ one `for-each-ref`
 * @param {object[]|null} [o.ledgerRows] dispatch-ledger rows; null ⇒ read the session sink
 * @param {string|null} [o.sessionId] fence the ledger read/join to one session
 * @param {object|null} [o.worktreeLanes] worktree path → branch, for the path-key join
 * @returns {{ok:false, reason:string} | {
 *   ok:true,
 *   lanes: Array<{lane, items:string[], itemCount, agents:number|null, agentsReason, verdict, why}>,
 *   underPacked: string[], queued: Array<{id, rel, lane}>,
 *   orphaned: Array<{id, rel, lane}>, unbound: Array<{id, rel}>,
 *   unknown: Array<{class, count:number|null, reason?, items?}>,
 *   counts: {lanes, bound, queued, orphaned, unbound, unmeasured, excludedMetaWorkspace},
 *   basis: object }}
 *
 * UNBOUND items are LISTED and never counted into a lane; every class that
 * could not be measured — agents per lane, a malformed or unreadable binding, an
 * id collision, an undeclared lifecycle, an unparseable path — goes to
 * `unknown` (the `refCensus` precedent). `{ok:false}` is returned when the lane
 * set or the ledger itself cannot be read, and MUST NOT be read as "no lanes are
 * under-packed".
 */
function laneDepth({
  repoDir,
  openLanes = null,
  listTodoFiles = null,
  readTodoHead = null,
  listRefNames = null,
  ledgerRows = null,
  sessionId = null,
  worktreeLanes = null,
} = {}) {
  const fail = (reason) => ({ ok: false, reason });
  const needsRepo =
    !Array.isArray(openLanes) ||
    typeof listTodoFiles !== "function" ||
    typeof readTodoHead !== "function";
  if (needsRepo && !repoDir) return fail("repoDir-required");

  let names = openLanes;
  if (!Array.isArray(names)) {
    const s = laneSurvey({
      repoDir,
      classifyTop: 0,
      census: false,
      depth: false,
    });
    if (!s || !s.ok)
      return fail(`lane-survey-failed: ${(s && s.reason) || "unknown"}`);
    names = s.lanes.map((l) => l.name);
  }
  names = [...new Set(names.filter((x) => typeof x === "string" && x))];

  let TD;
  try {
    TD = require(path.join(__dirname, "todo-durable.js"));
  } catch (e) {
    return fail(`todo-durable-unavailable: ${(e && e.message) || e}`);
  }
  let files;
  try {
    files =
      typeof listTodoFiles === "function"
        ? listTodoFiles()
        : _trackedTodoMarkdown(repoDir);
  } catch (e) {
    return fail(`todo-listing-threw: ${(e && e.message) || e}`);
  }
  if (!Array.isArray(files)) return fail("todo-listing-failed");

  // SCOPE THE POPULATION TO LIVE WORKSPACES, and say so out loud.
  //
  // This census answers "what outstanding work needs a lane?". A workspace under
  // `workspaces/_archive/` has been CLOSED, and the archival convention deliberately
  // leaves its ledger un-reconciled — items stay in `todos/active/` after the move,
  // because the archive is the institutional record rather than a worklist. Asking
  // this question of those files therefore returns a confident wrong answer: before
  // this filter the report read "20 UNBOUND outstanding items", and MEASURED, 0 of
  // the 20 were outstanding loom work. Eleven were stale ledgers whose issues are
  // closed (the archival commit `5b3a99e4d` states it verified open-vs-landed first
  // and carved the one still-open issue OUT before moving: "No open work archived"),
  // one was superseded and relocated, and eight are real unfinished work belonging to
  // the `kailash-ml-rs` BUILD repo, which loom is structurally forbidden to execute.
  //
  // The filter runs HERE, not in `_trackedTodoMarkdown`, so it applies uniformly to
  // an INJECTED `listTodoFiles` as well as the default git population — a census
  // whose scope depended on which reader supplied the list would report different
  // truths to a fixture and to a session.
  //
  // NARROWING A POPULATION SILENTLY IS ITS OWN DEFECT (`conservation-gate.md` MUST-3):
  // "0 UNBOUND" must not be indistinguishable from "we stopped looking". The count of
  // what was set aside is carried in `counts.excludedMetaWorkspace` and named in
  // `basis.items`, so the exclusion is a DECLARED blind class rather than a quiet one.
  const scoped = files.filter((f) => !TD.isMetaWorkspaceTodoPath(f));
  const excludedMetaWorkspace = files.length - scoped.length;
  files = scoped;

  const scan = TD.scanDurableTodos(files);
  if (!scan.ok) return fail(`todo-scan-failed: ${scan.reason}`);
  const read =
    typeof readTodoHead === "function"
      ? readTodoHead
      : (rel) => _readTodoHead(repoDir, rel, TD.LANE_HEAD_BYTES);
  const bound = TD.bindOpenItems(scan, read);
  if (!bound.ok) return fail(`todo-binding-failed: ${bound.reason}`);

  const open = new Set(names);
  const byLane = new Map(names.map((x) => [x, []]));
  const queued = [];
  const orphaned = [];
  const unplaced = [];
  const unbound = [];
  const malformed = [];
  const unreadable = [];
  for (const it of bound.items) {
    if (it.outcome === "bound") {
      if (open.has(it.lane)) byLane.get(it.lane).push(it.id);
      else unplaced.push({ id: it.id, rel: it.rel, lane: it.lane });
    } else if (it.outcome === "unbound") {
      unbound.push({ id: it.id, rel: it.rel });
    } else if (it.outcome === "malformed") {
      malformed.push({ id: it.id, rel: it.rel, reason: it.reason });
    } else {
      unreadable.push({ id: it.id, rel: it.rel, reason: it.reason });
    }
  }

  // ORPHANED vs QUEUED — the split that decides whether a lane is UNDER-PACKED.
  //
  // An item bound to a lane that is not OPEN is not automatically work waiting
  // for a lane. `laneSurvey` drops a local branch from the open set only once its
  // content has LANDED, so a ref that EXISTS and is not open is a landed lane and
  // its leftover item is stale bookkeeping (ORPHANED) — it cannot be packed into
  // anything, and counting it as QUEUED marked every serial lane UNDER-PACKED.
  // A name with NO ref anywhere is a lane that was never opened, so the item IS
  // waiting for one (QUEUED). When the ref enumeration itself fails, the split is
  // UNMEASURED: those items drive neither, and go to `unknown`.
  const refNames =
    typeof listRefNames === "function"
      ? listRefNames()
      : _refShortNames(repoDir);
  const refsUnreadable = !(refNames instanceof Set);
  for (const it of unplaced) {
    if (refsUnreadable) continue;
    if (refNames.has(it.lane)) orphaned.push(it);
    else queued.push(it);
  }

  const attribution = _laneAgents({
    repoDir,
    laneNames: names,
    sessionId,
    ledgerRows,
    worktreeLanes,
  });
  const unknown = [];
  const push = (cls, items) => {
    if (items.length) unknown.push({ class: cls, count: items.length, items });
  };
  if (refsUnreadable && unplaced.length)
    unknown.push({
      class: "lane-existence-unmeasured",
      count: unplaced.length,
      items: unplaced,
      reason:
        "git could not enumerate this repository's refs, so whether each item's declared lane EXISTS — QUEUED (no such ref) or ORPHANED (a landed one) — was not measured; neither drives UNDER-PACKED",
    });
  push("binding-malformed", malformed);
  push("item-unreadable", unreadable);
  push("id-collision", scan.collisions);
  push(
    "lifecycle-undeclared",
    scan.undeclared.map((u) => ({ id: u.id, rel: u.rel })),
  );
  push("path-malformed", scan.malformed);
  const unmeasuredCount =
    unbound.length +
    malformed.length +
    unreadable.length +
    scan.collisions.length +
    scan.undeclared.length +
    scan.malformed.length +
    (refsUnreadable ? unplaced.length : 0);

  const rank = new Map(LANE_DEPTH_VERDICTS.map((v, i) => [v, i]));
  const lanes = names
    .map((lane) => {
      const items = byLane.get(lane).sort((a, b) => a.localeCompare(b));
      const a = (attribution.perLane && attribution.perLane.get(lane)) || {
        agents: null,
        reason: attribution.reason,
      };
      const v = laneDepthVerdict({
        itemCount: items.length,
        agents: a.agents,
        queuedCount: queued.length,
        unmeasuredCount,
      });
      return {
        lane,
        items,
        itemCount: items.length,
        agents: a.agents,
        agentsReason: a.reason,
        verdict: v.verdict,
        why: v.why,
      };
    })
    .sort(
      (a, b) =>
        rank.get(a.verdict) - rank.get(b.verdict) ||
        a.lane.localeCompare(b.lane),
    );

  // AN UNMEASURED AGENT AXIS STAYS LOUD, whether it is unmeasured for every lane
  // (the ledger did not read) or for some (unidentified rows). `count: null` is
  // the refCensus tri-state: NOT ZERO.
  const unattributed = lanes.filter((l) => l.agents === null);
  if (unattributed.length)
    unknown.unshift({
      class: "agents-per-lane",
      count: null,
      reason: `${unattributed.length} of ${lanes.length} lane(s) carry no MEASURED agent count — ${unattributed[0].agentsReason}`,
    });

  return {
    ok: true,
    lanes,
    underPacked: lanes
      .filter((l) => l.verdict === "UNDER-PACKED")
      .map((l) => l.lane),
    queued,
    orphaned,
    unbound,
    unknown,
    counts: {
      lanes: lanes.length,
      bound: lanes.reduce((s, l) => s + l.itemCount, 0),
      queued: queued.length,
      orphaned: orphaned.length,
      unbound: unbound.length,
      unmeasured: unmeasuredCount,
      excludedMetaWorkspace,
    },
    basis: {
      lanes:
        "open lanes = the names passed in, or laneSurvey's ancestry-unmerged local branches — an UPPER bound, so an item bound to a content-landed branch reads BOUND, never QUEUED",
      items:
        `outstanding = tracked todos/active/ markdown in LIVE workspaces; ${excludedMetaWorkspace} tracked path(s) under a workspace META-directory (a segment starting \`_\`: \`_archive\`, \`_template\`, \`_draft\`) were EXCLUDED from this census and are counted in NO class here — a closed archive is the institutional record, not a worklist, and its ledger is deliberately left un-reconciled. They remain in the durable todo ledger, which records history rather than outstanding work. Binding = the \`lane:\` frontmatter key as it reads in THIS working tree (a binding committed only on another branch is not visible here)`,
      queued:
        "an outstanding item whose declared lane is not open AND names no ref in this repository — work waiting for a lane to be opened. ONLY this drives UNDER-PACKED",
      orphaned:
        "an outstanding item whose declared lane names a ref that is not open — the lane landed, so the binding is stale and no lane can absorb it. A landed-and-DELETED lane leaves no ref and therefore reads QUEUED: the loud direction, since it surfaces the item rather than silencing it",
      agents: attribution.reason,
    },
  };
}

/** `laneSurvey`'s depth field — never throws into the survey. */
function _surveyDepth(repoDir, lanes, depth) {
  try {
    const o = depth && typeof depth === "object" ? depth : {};
    return laneDepth({
      repoDir,
      openLanes: lanes.map((l) => l.name),
      listTodoFiles:
        typeof o.listTodoFiles === "function" ? o.listTodoFiles : null,
      readTodoHead:
        typeof o.readTodoHead === "function" ? o.readTodoHead : null,
      listRefNames:
        typeof o.listRefNames === "function" ? o.listRefNames : null,
      ledgerRows: Array.isArray(o.ledgerRows) ? o.ledgerRows : null,
      sessionId: typeof o.sessionId === "string" ? o.sessionId : null,
      worktreeLanes:
        o.worktreeLanes && typeof o.worktreeLanes === "object"
          ? o.worktreeLanes
          : null,
    });
  } catch (e) {
    return { ok: false, reason: `lane-depth-threw: ${(e && e.message) || e}` };
  }
}

/**
 * The age of a lane's OLDEST UNLANDED COMMIT, in hours, plus how many it has.
 *
 * THE BASIS IS CREATION OF THE WORK, NOT LAST TOUCH AND CERTAINLY NOT MTIME.
 * MUST-3 requires age to derive from CREATION — "worktree reflog, branch first
 * unique commit" — and names the failure it exists to prevent: the reaper read a
 * tree as 11.1h from `stat().mtime` whose reflog showed 44h. mtime can ONLY make
 * rot look fresh, which is the one error direction an ageing metric must not
 * have. This is the branch half of that mandate; `treeAgeHours` above is the
 * worktree half, and neither reads a directory timestamp.
 *
 * TWO git spawns, and both are needed for a DIFFERENT reason:
 *   1. `git cherry` — WHICH commits are genuinely unlanded (patch-id absent at
 *      the base). Ancestry alone would count a rebased-and-landed branch's
 *      commits and manufacture a block on work that is already on main.
 *   2. `git show -s --format=%ct <shas…>` — the committer date of each. The MIN
 *      is taken, so the result does NOT depend on `git cherry`'s emission order
 *      (measured ascending on this tree; not relied upon).
 *
 * NULL IS UNKNOWN ON BOTH CHANNELS. A failed `cherry` returns `unique:null`; a
 * failed or unparseable `show` returns `ageHours:null` with the count intact.
 * Neither is ever collapsed into 0 or into "young" — `instrument-discipline.md`
 * MUST-1: a guard that reported a fresh age because git never ran would be the
 * non-discriminating instrument this module's header refuses.
 *
 * `maxShas` caps the second spawn's argv on a lane with a long unlanded run.
 * Truncation can only RAISE the minimum date (drop older commits), so it can
 * only make a lane read YOUNGER — the fail-open direction.
 */
function unlandedContentAge(
  ref,
  baseRef,
  cwd,
  timeout,
  now = Date.now(),
  maxShas = 50,
  landedMap = null, // the caller's once-per-call map (`confirmAgedLane`)
) {
  // STEP 1 IS PROVENANCE FIRST (`_laneContent`): a recorded landing is unique:0
  // whatever its patch-ids, a recorded-open lane's unlanded commits are the
  // core's `outstanding` list, and `git cherry` runs only on the core's fallback.
  // `decidedBy` names which of the two decided; UNMEASURED is `unique:null`.
  const c = _laneContent(
    cwd,
    baseRef,
    ref,
    String(ref).replace(/^refs\/heads\//, ""),
    timeout,
    landedMap,
  );
  const decidedBy = c.instrument;
  if (c.unique === null) return { unique: null, ageHours: null, decidedBy };
  // Newest-first (provenance) or oldest-first (cherry), with the core's merges
  // appended on the provenance path: `_oldestUnlandedCommitSeconds` drops the
  // merges, orients the list so the `maxShas` cap keeps the OLDEST end, and takes
  // the MIN — the same helper `openLanes` ages its lanes with.
  const unique = c.shas.length;
  if (unique === 0) return { unique: 0, ageHours: null, decidedBy };
  const oldest = _oldestUnlandedCommitSeconds(c, { cwd, timeout, maxShas });
  if (oldest === null) return { unique, ageHours: null, decidedBy };
  return {
    unique,
    ageHours: (now - oldest * 1000) / 3_600_000,
    ageBasis: "oldest-unlanded-commit",
    decidedBy,
  };
}

/**
 * confirmAgedLane — the ONE question a BLOCKING AGE gate is allowed to act on:
 *
 *     is there AT LEAST ONE lane whose MEASURED unlanded content is older than
 *     the bound?
 *
 * WHY THIS IS SEPARATE FROM `confirmAtLimit`. They answer different questions on
 * different axes and MUST NOT be collapsed: the count door asks "how many lanes"
 * and the age door asks "how old is the oldest work". MUST-3 is titled "AGE
 * Governs, Not COUNT" precisely because a repo can sit at 2 lanes and 3 weeks —
 * a state the count door passes and the rule calls a defect. This function is
 * what lets the age axis carry teeth instead of a report.
 *
 * THE SHAPE IS `confirmAtLimit`'s, DELIBERATELY, because the discipline is the
 * same. Every lane it fires on fired because `git cherry` emitted a `+` line AND
 * a committer date was read for it — MEASURED git-object facts, never an
 * inference. `aged:false` means "not established", NEVER "everything is young";
 * `decided:false` means the budget ran out and the caller MUST NOT block on it.
 *
 * FAIL OPEN ON EVERY UNKNOWN (`cc-artifacts.md` Rule 7), on three channels:
 *   - a lane whose `cherry` fails is SKIPPED and tallied in `unanswerable`;
 *   - a lane with unlanded commits but NO readable date is SKIPPED, not blocked;
 *   - budget exhaustion returns `decided:false`.
 * Every one of those lowers the chance of a block, which is the only direction
 * that cannot refuse work the operator is entitled to start.
 *
 * THERE IS NO AGE PREFILTER, AND THE ABSENCE IS THE FINDING. Filtering candidates
 * by TIP date would be free and is UNSOUND: tipAge is a LOWER bound on the
 * content age, so a lane committed to one minute ago can still carry a
 * three-day-old unlanded commit. Measured refutation, and why the tip date is
 * kept as an ORDERING signal only: `laneCountFast`'s docblock above.
 *
 * WHAT THE BUDGET COSTS, STATED RATHER THAN HIDDEN. Every candidate costs two
 * git spawns, so a forest large enough to exhaust `budgetMs` returns
 * `decided:false` and the age door does NOT fire. That blind spot is real and it
 * is bounded to exactly the population the COUNT door already refuses: a forest
 * big enough to starve this scan is, by construction, far past `WIP_LIMIT`.
 * Ordering by tip age DESCENDING puts the PROVEN blockers (tipAge > bound) at
 * the front, so a lane the tip date alone establishes is never the one the
 * budget drops.
 *
 * EARLY EXIT is the budget, not an optimisation: the loop stops at the FIRST
 * confirmed aged lane, because one is all a refusal needs.
 */
function confirmAgedLane({
  repoDir,
  baseRef = null, // resolved via trunk-ref.js below
  lanes = [],
  boundHours = AGE_BOUND_HOURS,
  // 1500 ms, NOT the 2500 `confirmAtLimit` takes. Both run on the same
  // PreToolUse call when the count is also at the limit, under ONE 8000 ms
  // fallback timer that `oldestLines`' survey also draws on. The scan is
  // ordered proven-blockers-first precisely so the smaller budget costs
  // detection only in the population the count door already refuses.
  budgetMs = 1500,
  perCallTimeoutMs = 1500,
  now = Date.now(),
} = {}) {
  // The integration trunk, resolved STRICTLY when the caller omitted it —
  // `_trunkFor`, the shared resolver (`wip-discipline.md` MUST-4).
  if (!baseRef) {
    const t = _trunkFor(repoDir, { timeoutMs: perCallTimeoutMs });
    if (!t.ok) {
      return {
        decided: false,
        reason: t.reason,
        trunk: t.trunk,
        trunkReason: t.trunkReason,
        scanned: 0,
        unanswerable: 0,
        candidates: Array.isArray(lanes) ? lanes.length : 0,
        elapsedMs: 0,
      };
    }
    baseRef = t.ref;
  }
  const startedAt = Date.now();
  const rank = (l) =>
    typeof l.ageHours === "number" && Number.isFinite(l.ageHours)
      ? l.ageHours
      : -1; // tip date UNKNOWN ⇒ scanned last, never dropped
  const candidates = (Array.isArray(lanes) ? lanes : [])
    .filter((l) => l && l.name)
    .sort((a, b) => rank(b) - rank(a));

  let scanned = 0;
  let unanswerable = 0;
  const pmap = candidates.length ? _landedMapFor(repoDir, baseRef, perCallTimeoutMs) : null; // ONCE per call

  for (const c of candidates) {
    if (Date.now() - startedAt > budgetMs) {
      return {
        decided: false,
        reason: "budget-exhausted",
        scanned,
        unanswerable,
        candidates: candidates.length,
        elapsedMs: Date.now() - startedAt,
      };
    }
    scanned += 1;
    const m = unlandedContentAge(
      c.name,
      baseRef,
      repoDir,
      perCallTimeoutMs,
      now,
      50,
      pmap,
    );
    if (m.unique === null) {
      unanswerable += 1; // git could not answer — never read as content, never as 0
      continue;
    }
    if (m.unique === 0) continue; // landed (provenance, or content on fallback): not inventory, whatever its date
    if (typeof m.ageHours !== "number" || !Number.isFinite(m.ageHours)) {
      unanswerable += 1; // has content, age UNDERIVABLE ⇒ fail open
      continue;
    }
    if (m.ageHours > boundHours) {
      return {
        decided: true,
        aged: true,
        name: c.name,
        ageHours: m.ageHours,
        tipAgeHours: c.ageHours,
        uniqueCommits: m.unique,
        ageBasis: "oldest-unlanded-commit",
        // WHICH instrument established the unlanded commits: "provenance"
        // (recorded landing trailers) or "content" (`git cherry`, fallback only).
        decidedBy: m.decidedBy,
        scanned,
        unanswerable,
        candidates: candidates.length,
        elapsedMs: Date.now() - startedAt,
      };
    }
  }

  return {
    decided: true,
    aged: false,
    scanned,
    unanswerable,
    candidates: candidates.length,
    ageBasis: "oldest-unlanded-commit",
    elapsedMs: Date.now() - startedAt,
  };
}

/** Lanes past the age bound, oldest first. A lane whose age is UNKNOWN is
 *  included — an unmeasurable age is not evidence of youth. */
function agedLanes(lanes, boundHours = AGE_BOUND_HOURS) {
  return lanes
    .filter((l) => l.ageHours === null || l.ageHours > boundHours)
    .sort((a, b) => (b.ageHours ?? Infinity) - (a.ageHours ?? Infinity));
}

/** Age distribution — the shape MUST-3 requires a surface to report INSTEAD of
 *  a bare count. Returns null when no lane has a measurable age. */
function ageDistribution(lanes) {
  const a = lanes
    .map((l) => l.ageHours)
    .filter((x) => typeof x === "number")
    .sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  return {
    n: a.length,
    min: a[0],
    p50: q(0.5),
    p90: q(0.9),
    max: a[a.length - 1],
    over24h: a.filter((x) => x > 24).length,
    over168h: a.filter((x) => x > 168).length,
  };
}

/** Is the operator at or over the WIP limit? Returns null when the lane set
 *  could not be established — the caller must not read that as "under". */
function wipVerdict(laneResult, limit = WIP_LIMIT) {
  if (!laneResult || !laneResult.ok) return null;
  const open = laneResult.lanes.length;
  return {
    open,
    limit,
    atLimit: open >= limit,
    over: Math.max(0, open - limit),
  };
}

/**
 * Does this shell command OPEN A LANE?
 *
 * ── WHY THIS EXISTS (the enforcement-surface parity gap) ────────────────────
 *
 * MUST-2 says "Opening at the limit is REFUSED", unqualified. The guard
 * implemented that for `PreToolUse:Task|Agent` ONLY — so the ceiling was
 * consulted when an AGENT was spawned and never when a lane was created by
 * hand. Measured on this repo: the forest reached 33 worktrees and 43 branches
 * against a limit of 5, and the ceiling refused nothing, because essentially
 * every lane was opened with `git worktree add` or `git switch -c` from Bash.
 * A ceiling that guards one of the several doors is not a ceiling; this is the
 * `security.md` § Enforcement-Surface Parity shape — a control promoted at one
 * surface that an independent surface never learned.
 *
 * ── IT CONSUMES THE SHARED PARSER, AND THAT IS LOAD-BEARING ─────────────────
 *
 * `git-command-parse.js` is the ONE parser answering "does this command invoke
 * `git <subcommand>`" — segment-aware, wrapper-aware, `-C`-aware, and aware of
 * nested shell bodies. A private regex here would re-open the bypass class a
 * sibling repo measured at 15 of 15, where a pair of parentheses defeated every
 * destructive-op guard in the repo because the guard never PARSED the command
 * rather than assessing and allowing it. It would also miss `git -C <dir>
 * switch -c` and fire on the literal text inside `echo "git worktree add"`.
 *
 * ── FAIL-OPEN IS DELIBERATE AND TOTAL ───────────────────────────────────────
 *
 * An unreadable command, an unparseable one, or a nested body whose content is
 * unknowable (`sh -c "$CMD"`) all return FALSE — allow. A guard that refuses
 * work because it could not parse something is a guard that gets disabled
 * within a week, and this predicate's job is to select WHICH QUESTION to ask,
 * never to decide the answer: the verdict still comes from the measured lane
 * count in git process state, which is what lets the refusal carry `block`
 * under `hook-output-discipline.md` MUST-2 without resting on a lexical match.
 *
 * @param {string} command the raw Bash command line
 * @returns {{creates: boolean, how: string|null}} `how` names the form matched,
 *   so a refusal can say WHICH construct opened a lane rather than a bare verdict.
 */
function laneCreationIntent(command) {
  const none = { creates: false, how: null };
  if (typeof command !== "string" || !command.trim()) return none;

  let invocations;
  try {
    // `stripShellGroupDelimiters` FIRST, and this is not optional. MEASURED:
    // `parseGitInvocations` does not apply it, so `(git worktree add ../y)` and
    // `{ git worktree add ../y; }` both parse to ZERO invocations — a pair of
    // parentheses is a complete bypass. That is the exact class a sibling repo
    // measured at 15 of 15 against its destructive-op guards. The stripper is the
    // shared parser's own exported facility, so this consumes it rather than
    // hand-rolling a second splitter.
    invocations = parseGitInvocations(stripShellGroupDelimiters(command));
  } catch {
    // NEVER throws is the shared parser's contract, but a guard that trusts a
    // contract it did not verify is one refactor away from a crash loop, and a
    // crashing hook emits nothing — which is silence, not allow.
    return none;
  }
  if (!Array.isArray(invocations) || invocations.length === 0) return none;

  // A worktree-ATTACH verdict is held back rather than returned, because it is
  // the only NON-refusing verdict this function can produce, and returning it
  // early ends the scan.
  //
  // THE BYPASS THAT FORCED THIS (adversarial review, 2026-08-29). `parseGitInvocations`
  // yields ONE invocation per shell segment, in order. The `worktree` arm used to
  // `return` — unlike every sibling arm, which `break`s and keeps scanning — so
  // the FIRST segment decided the whole command and a later creating segment was
  // never examined. Both of these opened a lane unrefused, and REPRODUCED:
  //
  //   git worktree add ../w <existing-branch> && git switch -c new-lane
  //   git worktree add --detach ../w          && git switch -c new-lane
  //
  // The second needs no ref at all. Precondition: none — any Bash call. The
  // earlier "fails closed" claim was true of REF RESOLUTION and simply did not
  // reach multi-segment composition.
  //
  // An unconditional creator ANYWHERE therefore outranks an attach: it returns
  // immediately, and the attach candidate is only honoured if the whole command
  // contained no creator.
  let attachCandidate = null;

  for (const inv of invocations) {
    if (!inv || inv.unresolvable) continue; // unknowable ⇒ allow, per fail-open above
    // MEASURED shape: `argv` is an array of plain strings (`["add","../x","-b","lane"]`).
    const argv = Array.isArray(inv.argv)
      ? inv.argv.filter((a) => typeof a === "string")
      : [];
    const flags = argv.filter((a) => a.startsWith("-"));
    const positional = argv.filter((a) => a && !a.startsWith("-"));

    switch (inv.sub) {
      case "worktree":
        // `add` only. `list`, `remove`, `prune` and `repair` open nothing — and
        // `remove` is how a lane is CLOSED, so refusing it would make the ceiling
        // block its own remedy.
        if (positional[0] === "add") {
          // `add` is NOT uniformly lane-creating, and treating it as such
          // over-counted: the ceiling measures INVENTORY (branches carrying
          // unlanded content), and attaching a worktree to a branch that
          // ALREADY EXISTS changes no branch's content, so it cannot raise the
          // count. It adds a WORKER to existing inventory — the same
          // inventory-vs-worker distinction that removed the `Task|Agent` arm
          // (see this file's header). Measured: the guard refused
          // `git worktree add <path> <branch>` for a branch its OWN refusal
          // text listed among the counted lanes.
          //
          // Three shapes, and only the parse is done here — resolving whether
          // the ref exists needs a repo and belongs to the caller, which has
          // one (`wip-discipline-guard.js`). This function stays pure.
          if (flags.some((f) => f === "--detach")) {
            // Detached HEAD creates NO branch, so no inventory either way — but
            // BREAK, never return: a later segment may still open a lane, and
            // returning here was the cheaper half of the composition bypass.
            break;
          }
          if (
            flags.some(
              (f) => f === "-b" || f === "-B" || f === "--force-new-branch",
            )
          ) {
            // Explicitly mints a NEW branch → genuinely opens a lane.
            return {
              creates: true,
              how: "git worktree add -b",
              attachTo: null,
            };
          }
          // `git worktree add <path> <commit-ish>` names an existing ref;
          // `git worktree add <path>` alone makes git derive a NEW branch from
          // the path basename, which DOES create. positional = ["add", path, ref?].
          const ref = positional.length >= 3 ? positional[2] : null;
          if (ref) {
            // HOLD the attach verdict; do not return. Only honoured after the
            // whole command is scanned and no unconditional creator was found.
            if (!attachCandidate) {
              attachCandidate = {
                creates: true,
                how: "git worktree add",
                attachTo: ref,
              };
            }
            break;
          }
          // No commit-ish: git derives a NEW branch from the path basename, so
          // this DOES create unconditionally.
          return { creates: true, how: "git worktree add", attachTo: null };
        }
        break;
      case "switch":
        // `-c`/`-C` create; a bare `git switch <branch>` moves between lanes that
        // already exist and opens nothing.
        if (
          flags.some(
            (f) =>
              f === "-c" ||
              f === "-C" ||
              f === "--create" ||
              f === "--force-create",
          )
        ) {
          return { creates: true, how: "git switch -c" };
        }
        // `--orphan` was unhandled on BOTH spellings. It points HEAD at a NEW
        // unborn branch — MEASURED: `git switch --orphan orph` then
        // `git symbolic-ref --short HEAD` -> `orph` — so the lane opens on its
        // first commit. It creates no ref at the instant it runs, which is
        // exactly why reading the ref list alone missed it.
        if (flags.some((f) => f === "--orphan")) {
          return { creates: true, how: "git switch --orphan" };
        }
        break;
      case "checkout":
        if (flags.some((f) => f === "-b" || f === "-B")) {
          return { creates: true, how: "git checkout -b" };
        }
        if (flags.some((f) => f === "--orphan")) {
          return { creates: true, how: "git checkout --orphan" };
        }
        break;
      case "branch": {
        // The subtle one. `git branch` with a positional name CREATES; with
        // `-d`/`-D`/`--list`/`-m`/`--show-current` and friends it does not, and
        // `-d`/`-D` are again how a lane is CLOSED. Requiring a positional AND no
        // non-creating flag keeps `git branch -D old-lane` allowed.
        //
        // `-c`/`-C`/`--copy` USED TO BE LISTED HERE AND WERE WRONG. A copy ADDS a
        // ref, so it opens a lane exactly as `git branch <name>` does; only a
        // DELETE (closes one) and a MOVE/rename (count unchanged) genuinely do
        // not. MEASURED rather than reasoned, since that is what put them here:
        //   $ git branch --format='%(refname:short)'   ->  main
        //   $ git branch -c main copied                ->  rc=0
        //   $ git branch --format='%(refname:short)'   ->  copied main
        //
        // NOTE THE SHAPE, not just the entries: this is a DENYLIST, which
        // `cc-artifacts.md` Rule 10 asks be an allowlist wherever the vocabulary
        // is enumerable. `git branch`'s flag set IS enumerable, so the Rule-10
        // form is available and is the better end state. It is not taken here
        // because inverting it silently reclassifies every flag not enumerated —
        // including ones no fixture covers — which is a wider blast radius than
        // the defect being fixed. Recorded as the known residual it is.
        const NON_CREATING = new Set([
          "-d",
          "-D",
          "--delete",
          "-m",
          "-M",
          "--move",
          "--list",
          "-l",
          "--show-current",
          "--edit-description",
          "--set-upstream-to",
          "-u",
          "--unset-upstream",
          "--merged",
          "--no-merged",
          "--contains",
          "--points-at",
          "-a",
          "--all",
          "-r",
          "--remotes",
          "-v",
          "-vv",
          "--verbose",
        ]);
        if (flags.some((f) => NON_CREATING.has(f))) break;
        if (positional.length >= 1)
          return { creates: true, how: "git branch <name>" };
        break;
      }
      default:
        break;
    }
  }
  // Whole command scanned, no unconditional creator found. NOW the held attach
  // verdict is safe to honour — the guard resolves its ref and passes through
  // only if it names an existing local branch.
  return attachCandidate || none;
}

module.exports = {
  WIP_LIMIT,
  REMOTE_LANDED_FLOOR,
  landedRemoteRefs,
  remoteDefaultBase,
  AGE_BOUND_HOURS,
  laneCreationIntent,
  GIT_TIMEOUT_MS,
  treeAgeHours,
  hasNoIndex,
  uniqueCommitCount,
  confirmAtLimit,
  isOnAnyRemote,
  classifyTree,
  openLanes,
  laneCountFast,
  laneSurvey,
  // journal/0607 decision 3 — per-lane depth.
  laneDepth,
  laneDepthVerdict,
  LANE_DEPTH_VERDICTS,
  // EXPORTED because `delegation-default.js` declares its own join keys to be the
  // union of these and a fixture pins that equality. Declared-but-unexported, the
  // pin could only be written against a restated literal — two readers of one list
  // that silently disagree, which is the coupling the pin exists to prevent.
  LANE_ATTRIBUTION_KEYS,
  // EXPORTED for the same reason: the path→lane map is built against these keys, and a fixture
  // pins them equal to `delegation-default.js::LANE_PATH_KEYS`. Unexported, a key added there
  // would be written by the ledger, joined by the consumer, and silently never mapped here.
  LANE_PATH_KEYS_LOCAL,
  _worktreeLaneRoots,
  _pathLaneMapForRows,
  // MUST-8's census surface.
  refCensus,
  loadRefPolicy,
  classifyRef,
  refPartition,
  partitionRefs,
  censusTrees,
  _globToRegExp,
  agedLanes,
  ageDistribution,
  unlandedContentAge,
  confirmAgedLane,
  wipVerdict,
  _git,
  // Landing provenance (`landed-map.js`) — exported for the fixtures that land
  // in-process and must re-read the map.
  _resetLandedMapMemo,
};
