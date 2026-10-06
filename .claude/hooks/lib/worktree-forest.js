/**
 * worktree-forest.js — the census + finding predicate behind
 * `worktree-isolation.md` Rule 8's deferred Phase-2 detector.
 *
 * WHY THIS EXISTS. Rule 8 ("Creation Owns Teardown — Reap On Evidence, Never
 * `--force`") landed 2026-07-30 with its Detection block reading "Phase 1
 * (manual, gate-review) … Phase 2 (deferred) — no hook detector". The
 * classifier it names (`.claude/bin/worktree-reap.mjs`) shipped; nothing ran it
 * unprompted. Measured on this clone 2026-08-04: 28 worktrees, 1.6 GB, volume at
 * 98% — most created THAT DAY by sessions that had Rule 8 in context the whole
 * time. A rule a compliant agent violates 28 times in a day is an enforcement
 * gap, not an authoring gap.
 *
 * SCOPE — this closes Rule 8 half (b), NOT half (a). Rule 8(a) binds the
 * orchestrator to reap "at the wave's terminal-lane transition"; that transition
 * is a SEMANTIC state (are all lanes done?) no hook can observe, and inferring it
 * would be the semantic analysis `cc-artifacts.md` forbids in hooks. Rule 8(b) —
 * the periodic backstop for "an orchestrator dies mid-wave, the case that leaks
 * most" — is a COUNT, which is exactly what a hook can measure. So the detector
 * arms 8(b) and leaves 8(a) on its gate-review Phase-1 coverage. Claiming
 * otherwise would be a detector that cannot see what it says it enforces.
 *
 * IT REPORTS AT PreToolUse; AT SessionEnd IT ALSO REAPS — ZERO-LOSS ONLY, AND
 * ONLY WHAT THIS SESSION CREATED.
 *
 * OWNERSHIP IS A THIRD AXIS, and it was missing. DURABILITY asks whether removal
 * loses commits; OCCUPANCY asks whether anyone is in the tree now; neither asks
 * whether the tree is THIS session's to remove. Every gate answered correctly on
 * two review worktrees destroyed mid-round — they were clean, pushed, idle, and
 * somebody else's. So the unattended pass now runs with `--reap-owned-by <id>`,
 * which removes only trees whose recorded creator is the closing session and
 * REPORTS the rest; `reapForest` REFUSES to run at all without an identity.
 * Creation records that identity (`worktree-reap.mjs --create`). Until a tree
 * carries a record, the unattended pass will not touch it — ABSENT MEANS
 * NOT-YOURS, which is the fail-closed direction and also the reason this change
 * is safe to land on top of an existing forest nobody has labelled.
 *
 * The original build of this module reported and never removed. That was the
 * right first step and the wrong resting place: measured 2026-08-12, loom's
 * forest reached 30 trees / 2.21 GiB and the Data volume hit 100% (3.1 GiB free
 * of 1.8 TiB) because nothing had RUN the reaper in weeks. A detector whose only
 * remedy is "the operator should go run a tool" fails exactly when the operator
 * is not looking, which is the case Rule 8(b) exists for. So SessionEnd now
 * invokes the reaper with `--apply --zero-loss-only`.
 *
 * WHAT STILL NEVER HAPPENS HERE. No branch of this module or its hook runs
 * `git worktree remove`, `prune`, `rm`, `rmSync`, or `--force`. Removal is
 * DELEGATED to `worktree-reap.mjs`, which owns every safety gate: git's own
 * dirty-tree refusal (never escalated), the KEEP verdict, the main-checkout and
 * own-worktree hard guards, the 12h idle floor, and the ownership gate. This
 * module passes NO `--min-age-hours` and NO `--only`, so the unattended pass runs
 * at the most conservative settings the reaper offers; the ONE thing it does
 * waive is that floor, for a tree the closing session created — see the reaper's
 * `classify`, where the record replaces the clock's proxy for occupancy.
 *
 * WHY `--zero-loss-only` — TAG-FIRST IS EXCLUDED FROM THE UNATTENDED PASS.
 * ZERO-LOSS means the commits are ALREADY durable without anything this pass
 * creates: the branch ref survives `git worktree remove`, and the work is pushed
 * (or its patch is already upstream). Removal is provably lossless and mints no
 * new state. TAG-FIRST is the opposite shape — the tree is detached and
 * unreachable, so the ONLY thing that would preserve its commits is a
 * `reaped/<name>-<sha>` tag the reap itself creates. That is sound with an
 * operator watching (and the reaper already fails closed: `TAG FAILED, NOT
 * REMOVING`), but unattended it trades a disk ratchet for a ref ratchet nobody
 * ever sees, and a later `git tag -d 'reaped/*'` or a fresh clone drops the only
 * copy. So the unattended pass declines it and REPORTS it for an operator
 * instead. `/sweep` Sweep 6 and a hand-run `--apply` keep the TAG-FIRST path.
 *
 * INTERRUPTION IS SAFE AT TREE GRANULARITY. The reaper removes one tree at a
 * time; if the subprocess budget expires mid-pass, the removals already done are
 * complete and consistent and the rest are simply caught next session. What is
 * NOT safe is reporting that case as a no-op, so it gets its own finding kind
 * (`reap-interrupted`) that claims no count at all.
 *
 * The co-owner's earlier incident report is why the verdict gate is not widened:
 * 15 worktrees in the terminal state held 295 uncommitted-or-untracked files,
 * six of them database migrations, none of which exist in any commit. Every one
 * of those is KEEP, and KEEP is never touched.
 *
 * THE TWO SIGNALS, AND WHAT EACH LICENSES (`instrument-discipline.md` MUST-1):
 *
 *   CENSUS — `git worktree list --porcelain`, one call, structural and
 *     deterministic: git enumerates the forest from `.git/worktrees/`, not from a
 *     heuristic. A DIFFERENT forest size yields a different count, so the census
 *     discriminates. It licenses claims about HOW MANY trees exist and NOTHING
 *     about whether any is reapable.
 *
 *   CLASSIFICATION — `worktree-reap.mjs --json`, whose verdicts derive from
 *     `git status --porcelain` (dirty), `git rev-list --not --remotes` (unpushed),
 *     patch-upstream, and mtime (idle). Patch-upstream is decided PROVENANCE
 *     FIRST: the `Landed-From` / `Landed-Partial` trailers recorded at landing
 *     time, read through `landed-map.js::landedVerdict` (applied by
 *     `worktree-reap.mjs::decideTreeLanded`); `git cherry` patch-ids run ONLY
 *     when that verdict is `fallback` (no config, or a branch predating the
 *     recording cutover), and a verdict that is neither decided nor fallback —
 *     including a config whose map cannot be built — is UNMEASURED and holds
 *     the tree. Also structural. It licenses the reapable/KEEP split.
 *
 * When the classification does not complete, this module does NOT fall back to
 * the census and call it a leak — an errored command is zero evidence
 * (`evidence-first-claims.md` MUST-3). It emits a distinct `census-only` finding
 * that states the count and states that reapability is UNKNOWN.
 *
 * SEVERITY. Both hook surfaces emit `halt-and-report` or `advisory`, never
 * `block`. Per `hook-output-discipline.md` MUST-2, `block` needs a structural
 * signal a surface rewrite cannot evade; the census IS structural, but the
 * DISPOSITION is judgment-bearing — a 30-lane wave with 30 legitimately-held
 * trees is healthy, and a detector that blocks it would be the MUST NOT
 * "detectors that block work the agent has been instructed to perform". The
 * finding predicate below is built so that forest never produces a finding at
 * all (every tree classifies KEEP → reapable 0), which is the cheaper defense.
 *
 * Style: CommonJS, matching the rest of .claude/hooks/lib/. `evaluateForest` is
 * PURE — no I/O, no clock, no git — so the finding predicate is testable without
 * a git fixture and a mutation to it reds a specific named test.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const {
  COUNT_BANDS,
  bandFor,
  crossedBand,
  listGitWorktreePaths,
  resolveMainWorktreeRoot,
  minutesSinceTouch,
  realOr,
  snapshotProcesses,
  occupantsOf,
  sanitizeName,
} = require("./worktree-occupancy.js");

// ── the one knob ────────────────────────────────────────────────────────────
//
// The finding predicate is `reapable >= REAPABLE_FLOOR`. There is deliberately
// no second "census floor" knob: the census gate below derives FROM this floor
// (`census < floor` ⇒ `reapable < floor` necessarily, since reapable ⊆ census),
// so the cheap short-circuit is blind-spot-free by construction rather than by
// a second number someone has to keep consistent. `worktree-forest-guard.test.mjs`
// pins that derivation.
//
// Why 4. Two measurements bracket it. Rule 8's own Origin recorded a clone at 20
// trees / 1.0 GB with the volume at 83%; this clone measured 28 trees / 1.6 GB at
// 98% on 2026-08-04. A single parallel wave is ~10 lanes, and during a live wave
// those trees classify KEEP (dirty, or unpushed, or touched inside the reap
// classifier's 12h idle floor) — so they do not count toward `reapable` at all.
// Four trees that are simultaneously clean, durable, and idle 12h+ are not a
// wave; they are residue. The floor therefore sits well below the measured harm
// zone while staying above anything a healthy in-flight wave produces.
const DEFAULT_REAPABLE_FLOOR = 4;

// ── the kill switch ─────────────────────────────────────────────────────────
//
// `COC_WORKTREE_AUTOREAP` turns the unattended SessionEnd reap OFF. It is
// readable from the shell AND from `.claude/settings.json::env`, so an operator
// has both affordances without a second mechanism.
//
// DEFAULT ON, and the fail-direction is deliberate. Only an explicitly
// RECOGNISED off-token disables the reap; every other value — including a typo,
// including garbage — leaves it ENABLED. The inverse (unrecognised ⇒ off) is how
// a safety feature ships inert: a `COC_WORKTREE_AUTOREAP=flase` in someone's
// profile would silently restore the exact accumulation this closes, and nothing
// would ever say so. An unrecognised value is therefore reported rather than
// obeyed, via `source: "default-unrecognized"`.
const AUTOREAP_OFF_TOKENS = new Set(["0", "off", "false", "no", "disabled"]);
const AUTOREAP_ON_TOKENS = new Set(["1", "on", "true", "yes", "enabled"]);

function resolveAutoReap(env) {
  const raw = (env || process.env).COC_WORKTREE_AUTOREAP;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { enabled: true, source: "default", raw: null };
  }
  const v = String(raw).trim().toLowerCase();
  if (AUTOREAP_OFF_TOKENS.has(v)) return { enabled: false, source: "env", raw: String(raw) };
  if (AUTOREAP_ON_TOKENS.has(v)) return { enabled: true, source: "env", raw: String(raw) };
  return { enabled: true, source: "default-unrecognized", raw: String(raw) };
}

function resolveFloor(env) {
  const raw = (env || process.env).COC_WORKTREE_REAPABLE_FLOOR;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_REAPABLE_FLOOR;
  }
  const n = Number(raw);
  // A malformed override falls back to the default rather than to 0 or NaN.
  // Falling back to 0 would make the detector fire on every forest (cry-wolf);
  // NaN would make every comparison false and silently disarm it. Both are the
  // "cannot fail" / "always fails" pair this detector exists to avoid, so a bad
  // value gets the documented default and the caller is told via `floorSource`.
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    return DEFAULT_REAPABLE_FLOOR;
  }
  return n;
}

// ── trigger predicate (PreToolUse) ──────────────────────────────────────────
//
// Segment-anchored, matching the `wrapup-after-landing.js::isLandingCommand`
// precedent: a worktree-creating invocation at command start or after a shell
// separator. `--help`/`-h`/`--dry-run`-style non-creating invocations are
// excluded by requiring a `-b`/`-B`/`--detach`/path operand shape only loosely —
// the trigger is deliberately permissive because an over-fire costs one advisory
// the agent acknowledges, while an under-fire is a missed ratchet turn.
//
// NOT a value comparison, so `hook-output-discipline.md` MUST-3 (skip captured
// shell-variable operands) does not bite: nothing here reads a captured group and
// compares it to a literal. `git worktree add "$WT"` SHOULD fire — a worktree is
// being created regardless of what `$WT` expands to.
const WORKTREE_ADD_RE =
  /(^|[\n;&|]\s*)(?:[\w./-]*\bgit\b(?:\s+-[cC]\s+\S+)*\s+worktree\s+add\b|\/worktree\b)/;

function isWorktreeCreatingCommand(cmd) {
  if (typeof cmd !== "string" || cmd === "") return false;
  if (/\bworktree\s+add\b[^\n;&|]*\s(?:--help|-h)\b/.test(cmd)) return false;
  return WORKTREE_ADD_RE.test(cmd);
}

/**
 * A raw `git worktree add` that does NOT lock — i.e. one that will create a tree
 * the unattended reaper can never remove, because it carries no record of who
 * created it.
 *
 * THE ASYMMETRY IS ON PURPOSE. Locking is the RECORDED state: `--create` locks,
 * so every tree an orchestration path makes carries an owner and is reachable by
 * the unattended teardown. An unlocked add is the one shape that produces a tree
 * nobody can ever prove they own, and the cost of it is not paid here — it is
 * paid by whoever later has to retire that tree by hand.
 *
 * It is a LEXICAL check on the command text, so it names a required flag rather
 * than parsing the invocation, and it is deliberately one-sided: `--lock` appears
 * anywhere in the command that also creates a worktree. A false positive costs
 * one line naming the right affordance; a false negative costs an unrecorded
 * tree. It NEVER withholds a permission — the hook's PreToolUse output is
 * `advisory`, per `hook-output-discipline.md` MUST-2, because the matched signal
 * is a string shape and not a parsed structural fact.
 */
function isUnlockedWorktreeAdd(cmd) {
  if (!isWorktreeCreatingCommand(cmd)) return false;
  return !/(^|\s)--lock(\s|=|$)/.test(cmd);
}

// ── census (cheap, one git call) ────────────────────────────────────────────

/**
 * Count the worktrees git itself reports. Returns an integer, or null when git
 * could not be consulted (not a repo, git missing, timeout). NULL IS NOT ZERO —
 * callers must treat it as "unmeasured", never as "empty forest".
 */
function censusForest(repoDir, opts = {}) {
  const run = opts.exec || execFileSync;
  let out;
  try {
    out = run("git", ["worktree", "list", "--porcelain"], {
      cwd: repoDir,
      encoding: "utf8",
      timeout: opts.timeoutMs || 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  if (typeof out !== "string") return null;
  // One `worktree <path>` line per tree; blank-line separated records.
  const n = out.split("\n").filter((l) => /^worktree\s+\S/.test(l)).length;
  return n;
}

/**
 * Free space in KiB on the volume holding `path`, or null when unreadable.
 *
 * One `statfs` — microseconds, no filesystem walk — which is why the free-space
 * figure survives `--no-size`. NULL IS NOT ZERO: a 0 standing in for an
 * unreadable volume would read as "the disk is full", which is the alarm this
 * whole mechanism exists to avoid raising falsely.
 *
 * `statfsSync` landed in node 18.15, so it is reached through the namespace and
 * feature-tested rather than destructured — an older runtime degrades to null
 * instead of taking the hook down over a decorative number.
 */
function volumeFreeKb(p) {
  try {
    if (typeof fs.statfsSync !== "function") return null;
    const s = fs.statfsSync(p);
    const kb = Math.floor((s.bavail * s.bsize) / 1024);
    return Number.isFinite(kb) ? kb : null;
  } catch {
    return null;
  }
}

// ── classification (delegated to the shipped classifier) ────────────────────

// SUBPROCESS BUDGETS — DERIVED FROM THE CENSUS, NOT A CONSTANT.
//
// WHY THE CONSTANT WAS THE BUG, AND WHY RAISING IT AGAIN WOULD NOT BE A FIX.
// This module has already been through one bump (8000 → 15000 ms) and hit the
// same wall at the next forest size. A fixed millisecond budget cannot bound a
// workload that grows along TWO axes at once:
//
//   FOREST SIZE — unbounded by nature. Rule 8 teardown debt accumulates, so the
//     number of trees to classify is exactly the quantity this detector exists
//     because nobody is watching.
//   CONCURRENT-LANE CONTENTION — highest precisely when the guard fires. The
//     guard runs at PreToolUse and SessionEnd, i.e. DURING waves, when several
//     lanes are doing git work against the same object store. Measured on the
//     same 41-tree forest, same `--json --no-size` invocation: 6.77 / 7.37 /
//     18.45 s — a 2.7× spread with the tail well past any budget the median
//     would justify.
//
// Any single constant is therefore either too small at the next forest size or
// so large it cannot fit inside the hook's own registration timeout. THE FIX IS
// NOT A BIGGER NUMBER. It is (a) a budget that scales with the census the hook
// has ALREADY measured for free, bounded by a floor and a hard ceiling, and
// (b) a child-side SOFT deadline (`--deadline-ms`) so that exhausting the budget
// degrades to a labelled PARTIAL verdict set instead of losing the whole audit.
// With (b) in place the ceiling stops being a cliff: at 60 trees, or at 200, the
// pass still returns the trees it classified and names the rest UNKNOWN. That is
// the property a constant can never have, and it is why this ceiling will not
// need the treatment the previous two did.
//
// THE COST MODEL, re-measured on this clone at 42 trees, APFS, node v25.9.0,
// quiet machine, `--json --no-size`, six runs: 5.11 / 5.03 / 5.06 / 4.82 / 4.99
// / 4.96 s ⇒ ~0.12 s/tree. Isolated at the same size: 42 × `git status
// --porcelain` = 3.07 s (the dominant term, a working-tree stat walk), 42 ×
// `git rev-list --count` = 0.71 s, bare spawn floor = 0.04 s. Removal adds
// ~0.6 s per tree actually reaped.
//
// PER-TREE ALLOWANCE 300 ms — 2.5× the measured quiet cost, chosen to absorb the
// contention tail rather than the median. FLOOR keeps a small forest from
// getting a budget too tight to survive one slow git call. CEILING is set by the
// registration timeouts (PreToolUse 20 s, SessionEnd 45 s), which the harness
// enforces; the parent's hard timeout is deadline + GRACE, and that sum must
// stay under the registration with room for node startup and the census.
const CLASSIFY_MS_PER_TREE = 300;
const CLASSIFY_FLOOR_MS = 6000;
// 12000 rather than the 14000 the registration would nominally allow. The
// binding constraint is `census(3000) + ceiling + GRACE < registration(20000)`,
// and the leftover is the ONLY room the hook has for its own node startup, the
// stdin round-trip, and emit. At 14000 that leftover is 500 ms, which is not a
// margin — it is a coin flip on a cold module load. 12000 leaves 2500 ms.
// SHRINKING THE CEILING IS NOT A LOSS OF COVERAGE HERE, and that is the whole
// point of the deadline: past it the pass degrades to a labelled PARTIAL result
// instead of returning nothing. The old constant had to be big enough to finish
// or the audit was lost; this one only has to be big enough to be useful.
const CLASSIFY_CEILING_MS = 12000;
// Classify + removals. A reaping pass pays the same per-tree classification plus
// ~0.6 s for each tree it actually removes; not every tree is removable, so 800
// ms/tree covers a forest where a majority are.
const REAP_MS_PER_TREE = 800;
const REAP_FLOOR_MS = 15000;
// Same arithmetic against the SessionEnd registration (45 s): 3000 + 36000 +
// 2500 = 41500, leaving 3500 ms.
const REAP_CEILING_MS = 36000;
// Headroom between the SOFT deadline the child honours and the HARD timeout the
// parent enforces. The child needs this to serialise and write its JSON after
// the last checkpoint; the parent's kill is a backstop for a single git call
// that hangs past the budget, which a between-trees checkpoint cannot bound.
const BUDGET_GRACE_MS = 2500;

function clampBudget(census, perTree, floorMs, ceilingMs) {
  const n = Number.isInteger(census) && census > 0 ? census : 1;
  return Math.max(floorMs, Math.min(ceilingMs, n * perTree));
}

/** Soft deadline handed to the classifier, in ms, derived from the census. */
function classifyBudgetMs(census) {
  return clampBudget(census, CLASSIFY_MS_PER_TREE, CLASSIFY_FLOOR_MS, CLASSIFY_CEILING_MS);
}

/** Soft deadline for a classify-AND-reap pass, in ms, derived from the census. */
function reapBudgetMs(census) {
  return clampBudget(census, REAP_MS_PER_TREE, REAP_FLOOR_MS, REAP_CEILING_MS);
}

// The worst case each registration must still fit. Exported so the budget test
// asserts against the SAME arithmetic the runtime uses rather than restating it.
const CLASSIFY_TIMEOUT_MS = CLASSIFY_CEILING_MS + BUDGET_GRACE_MS;
const REAP_TIMEOUT_MS = REAP_CEILING_MS + BUDGET_GRACE_MS;

/**
 * Run `.claude/bin/worktree-reap.mjs` and return its counts — classifying only,
 * or classifying AND reaping when `opts.apply` is set.
 *
 * DELEGATED, NOT REIMPLEMENTED. Rule 8 names that script as the authority and
 * `worktree-reap.test.mjs` holds a positive-control fixture per verdict. A second
 * classifier here would be a second lineage that drifts — the `security.md`
 * § Multi-Site Kwarg Plumbing failure mode, and the substance of loom#1549.
 * Delegation is also what keeps every safety gate in ONE place: this module can
 * only ever be as dangerous as the flags it passes.
 *
 * THE FLAGS ARE THE WHOLE SAFETY SURFACE, so they are fixed here and not
 * caller-supplied:
 *   `--no-size`         cost only; drops the `du` pass nothing here reads.
 *   `--apply`           ONLY when opts.apply — i.e. only the SessionEnd path.
 *   `--zero-loss-only`  ALWAYS paired with --apply; TAG-FIRST is never reaped
 *                       unattended (see the header).
 *   `--deadline-ms`     the SOFT budget, derived from the census. It cannot
 *                       widen what may be removed — a tree the deadline stops us
 *                       reaching classifies UNKNOWN, and UNKNOWN is not a
 *                       reapable verdict. It can only ever reap LESS.
 * No `--min-age-hours` and no `--only` are ever passed, so the reaper's default
 * 12h idle floor stands and no tree gets its occupancy check waived. There is no
 * `--force` to pass: the reaper does not implement one.
 *
 * Spawned WITHOUT a shell and with an argv array, so nothing in the environment
 * can inject a flag.
 *
 * Returns { ok: true, counts, removed, refusals, freeKbAfter } or
 * { ok: false, interrupted, reason } — never throws, and never synthesises
 * counts it did not read.
 */
function runReaper(repoDir, opts = {}) {
  const run = opts.exec || execFileSync;
  const script =
    opts.scriptPath || path.join(repoDir, ".claude", "bin", "worktree-reap.mjs");
  const apply = opts.apply === true;
  // The census is already in hand at every call site (the hook short-circuits on
  // it before reaching here), so scaling costs nothing extra. When a caller does
  // not supply one, the floor applies — never an unbounded budget.
  const budgetMs = Number.isFinite(opts.budgetMs)
    ? opts.budgetMs
    : apply
      ? reapBudgetMs(opts.census)
      : classifyBudgetMs(opts.census);
  const args = [script, "--json", "--no-size", "--deadline-ms", String(budgetMs)];
  if (apply) {
    args.push("--apply", "--zero-loss-only");
    // THE OWNERSHIP GATE, passed only where it must be. `--reap-owned-by <id>`
    // narrows the pass to trees whose recorded creator is that session; the
    // reaper REPORTS everything else rather than removing it. See the header.
    if (opts.reapOwnedBy) args.push("--reap-owned-by", String(opts.reapOwnedBy));
  }

  let out;
  try {
    out = run(process.execPath, args, {
      cwd: repoDir,
      encoding: "utf8",
      // HARD backstop, strictly ABOVE the soft deadline the child honours. In
      // the ordinary case the child finishes first and this never fires; it
      // exists for the one case a between-trees checkpoint cannot bound — a
      // single git call that hangs past the whole budget.
      timeout: opts.timeoutMs || budgetMs + BUDGET_GRACE_MS,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    // A non-zero exit means the script could not run (absent, not a repo) OR —
    // on an --apply run — that git REFUSED a removal (exit 2), OR that we hit the
    // timeout. Only the timeout case may have left the forest half-reaped, and
    // conflating it with "never ran" would report a partial pass as a no-op.
    return { ok: false, applied: apply, interrupted: isTimeoutError(e), reason: shortReason(e) };
  }

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { ok: false, applied: apply, interrupted: false, reason: "classifier output was not JSON" };
  }
  const c = parsed && parsed.counts;
  if (
    !c ||
    !Number.isInteger(c.total) ||
    !Number.isInteger(c.zero_loss) ||
    !Number.isInteger(c.tag_first) ||
    !Number.isInteger(c.keep)
  ) {
    return { ok: false, applied: apply, interrupted: false, reason: "classifier output missing counts" };
  }

  // What was ACTUALLY done, read from the reaper's own per-tree action log —
  // never inferred from the verdict counts. A tree can classify ZERO-LOSS and
  // still not be removed (git refused, or --zero-loss-only skipped a TAG-FIRST),
  // so `zero_loss` is a verdict tally and `removed` is an outcome.
  const removed = [];
  const heldNotOwned = [];
  for (const w of Array.isArray(parsed.worktrees) ? parsed.worktrees : []) {
    const actions = Array.isArray(w.actions) ? w.actions : [];
    if (actions.includes("removed") || actions.includes("pruned")) {
      removed.push({ path: w.path, name: path.basename(w.path || ""), branch: w.branch || null });
    }
    // READ from the record's own flag, never re-derived here. A second
    // derivation of "is this mine" in the caller is exactly the drift this
    // module's header forbids — the reader would quietly disagree with the
    // classifier, and the report would describe a decision nobody made.
    if (w.heldNotOwned === true) {
      heldNotOwned.push({ path: w.path, name: path.basename(w.path || ""), branch: w.branch || null, owner: (w.owner && w.owner.session) || null, ownerName: (w.owner && w.owner.owner) || null });
    }
  }

  return {
    ok: true,
    applied: parsed.applied === true,
    counts: c,
    // READ from the envelope, never inferred. `partial` is the child's own
    // statement that it did not finish; `unknown` is how many trees it never
    // examined. An older classifier that emits neither field reads as a complete
    // run, which is what it was — the fields are additive, not a new contract.
    partial: parsed.partial === true || (Number.isInteger(c.unknown) && c.unknown > 0),
    unknown: Number.isInteger(c.unknown) ? c.unknown : 0,
    classified: Number.isInteger(parsed.classified) ? parsed.classified : c.total,
    budgetMs,
    removed,
    heldNotOwned,
    refusals: Array.isArray(parsed.refusals) ? parsed.refusals : [],
    freeKbAfter:
      parsed.size && Number.isFinite(parsed.size.volume_free_kb)
        ? parsed.size.volume_free_kb
        : null,
  };
}

/**
 * Classify without touching anything. Preserved as the named read-only entry
 * point so a caller cannot reach the reaping path by forgetting a flag.
 */
function classifyForest(repoDir, opts = {}) {
  return runReaper(repoDir, { ...opts, apply: false });
}

/**
 * Classify AND reap ZERO-LOSS trees — OWN trees only. The only caller is the
 * SessionEnd surface.
 *
 * A SESSION IDENTITY IS REQUIRED, and its absence is a REFUSAL, not a fallback
 * to the ungated pass. This is the structural half of the ownership fix: a
 * future caller that forgets the id gets no removal at all, rather than a
 * whole-forest reap whose reports look exactly like a correctly scoped one.
 * Fail-closed belongs in the ONE function that can spawn a removal, not in the
 * discipline of its callers.
 */
function reapForest(repoDir, opts = {}) {
  const sid = typeof opts.reapOwnedBy === "string" && opts.reapOwnedBy.trim() !== "" ? opts.reapOwnedBy.trim() : null;
  if (!sid) {
    return {
      ok: false,
      applied: false,
      interrupted: false,
      noSession: true,
      reason: "no session identity was available, so the unattended reap REFUSED to run — it removes only trees this session created, and without an identity every tree is somebody else's",
    };
  }
  return runReaper(repoDir, { ...opts, apply: true, reapOwnedBy: sid });
}

/**
 * Did this failure come from the timeout, rather than from the script exiting?
 * `execFileSync` reports a timeout by killing the child, so `killed` is set and
 * the signal is the terminating one; some node versions also set ETIMEDOUT.
 * Either way the child died mid-run, which is the distinction that matters.
 */
function isTimeoutError(e) {
  if (!e) return false;
  return e.code === "ETIMEDOUT" || e.killed === true || e.signal === "SIGTERM";
}

function shortReason(e) {
  const s = String((e && (e.stderr || e.message)) || "unknown").trim();
  return s.split("\n")[0].slice(0, 160) || "unknown";
}

// ── the build-cache GC seam ─────────────────────────────────────────────────

/**
 * Which worktrees a language-specific BUILD-CACHE garbage collector may delete
 * inside — e.g. an rs hook removing a stale `target/`.
 *
 * THIS IS THE NEUTRAL SEAM, and it exists so a variant hook never needs its own
 * copy of the forest lineage. Everything a cache GC needs from this subsystem is
 * a path-and-verdict answer with no language semantics in it: which trees is
 * nobody working in? A caller then applies its OWN language rules (is it named
 * `target`? does it carry `CACHEDIR.TAG`?) inside the paths this returns.
 *
 * THE PREDICATE IS EVALUATED EXPLICITLY, NEVER READ OFF A VERDICT — and that is
 * the whole design, not a detail. A classifier's holding reason is the FIRST
 * predicate that objected, because the checks short-circuit so the operator gets
 * the most actionable diagnostic. That makes the reason USELESS as a proxy for
 * "nobody is using this": a tree held for `unpushed` never reached the occupancy
 * or recency checks at all. MEASURED in the design this fold came from: an active
 * sibling agent's worktree was held for a landedness reason and had its 0.5 GB
 * cache deleted anyway, because a cache GC had inferred idleness from the label.
 * So this function asks the two questions it actually needs, directly:
 *
 *   UNOCCUPIED — a determinate process snapshot showing no cwd inside the tree.
 *                An INDETERMINATE snapshot yields the EMPTY set, never the full
 *                one: the disposition here is DELETE, so "the instrument did not
 *                work" must not print the same as "nobody is home".
 *   QUIET      — idle for at least `quietMinutes`, on git's own per-worktree
 *                admin `HEAD` rather than on build output (build output is what a
 *                cache GC is about to delete, so keying on it is circular).
 *
 * Returns a Set of REALPATHS, or NULL when the forest could not be enumerated.
 * NULL MEANS "NO ALLOW-LIST" and callers MUST treat it as such — never as
 * "allow everything", which is the one reading that turns this into a hazard.
 *
 * @param {string} repoDir
 * @param {{quietMinutes?:number, snapshot?:object}} [opts]
 * @returns {Set<string>|null}
 */
const DEFAULT_CACHE_GC_QUIET_MIN = 120;

function cacheGcAllowedWorktrees(repoDir, opts = {}) {
  const quietMinutes = Number.isFinite(opts.quietMinutes)
    ? opts.quietMinutes
    : DEFAULT_CACHE_GC_QUIET_MIN;
  const paths = listGitWorktreePaths(repoDir);
  // An EMPTY forest and an UNREADABLE one both arrive as `[]` from
  // `listGitWorktreePaths`, so the distinction is re-established here rather than
  // assumed: with no main root resolvable, nothing about this repo is known and
  // the honest answer is "no allow-list".
  if (resolveMainWorktreeRoot(repoDir) === null) return null;
  if (paths.length === 0) return new Set();

  const snap = opts.snapshot || snapshotProcesses();
  const allowed = new Set();
  for (const p of paths) {
    const occ = occupantsOf(snap, p);
    if (!occ.determinate || occ.occupied) continue; // someone is in there, or unknown
    const quiet = minutesSinceTouch(repoDir, p);
    if (quiet === null || quiet < quietMinutes) continue; // touched too recently, or unknown
    // REALPATH, because the caller compares against a realpath'd scan result —
    // an asymmetric comparison (raw here, resolved there) misses on any
    // symlinked prefix, and /var → /private/var is the everyday macOS case.
    allowed.add(realOr(p));
  }
  return allowed;
}

// ── the finding predicate (PURE) ────────────────────────────────────────────

const KIND_BACKLOG = "reapable-backlog";
const KIND_CENSUS_ONLY = "census-only";
const KIND_REAPED = "reaped";
const KIND_REAP_INTERRUPTED = "reap-interrupted";
// A classify pass that ran out of budget partway. Distinct from CENSUS_ONLY,
// which is the total loss: this one carries real verdicts for the trees it did
// reach and names the remainder. "39 of 41 classified, 2 UNKNOWN" is a strictly
// better answer than "41 trees, reapability UNKNOWN", and collapsing the two
// would throw away the 39.
const KIND_PARTIAL = "partial-classification";

/**
 * Decide whether this forest is a finding. Pure: no git, no clock, no fs.
 *
 * @param {number|null} census        trees git reported, or null if unmeasured
 * @param {object|null} classification `classifyForest` result, or null if not run
 * @param {number}      floor          reapable floor
 * @returns {object|null} finding, or null when there is nothing to report
 *
 * Order is load-bearing:
 *   1. UNMEASURED census → null. A detector that reports on a forest it could
 *      not count is asserting from an errored command.
 *   2. census < floor → null. The cheap short-circuit; sound because
 *      reapable <= census, so no finding is reachable below the floor.
 *   3. classification missing/failed → census-only finding. Reports the count,
 *      states reapability UNKNOWN, and does NOT claim a leak.
 *   4. reapable < floor → null. THIS is the anti-cry-wolf gate: a large forest
 *      whose every tree is legitimately KEEP produces reapable 0 and is silent.
 *   5. otherwise → backlog finding.
 */
function evaluateForest(census, classification, floor) {
  if (!Number.isInteger(census)) return null;
  if (census < floor) return null;

  if (!classification || classification.ok !== true) {
    return {
      kind: KIND_CENSUS_ONLY,
      census,
      reapable: null,
      zero_loss: null,
      tag_first: null,
      keep: null,
      floor,
      reason: (classification && classification.reason) || "classifier not run",
    };
  }

  const { zero_loss, tag_first, keep, total } = classification.counts;
  const reapable = zero_loss + tag_first;
  const unknown = classification.unknown || 0;

  // THE ANTI-CRY-WOLF GATE, EXTENDED SOUNDLY TO A PARTIAL PASS.
  //
  // On a complete pass `reapable` is exact, so `reapable < floor` provably
  // excludes a finding. On a PARTIAL pass it is a LOWER bound — any of the
  // UNKNOWN trees could be reapable — so the quantity that provably excludes a
  // finding is the UPPER bound, `reapable + unknown`. Below that, no finding is
  // reachable no matter what the unexamined trees turn out to be, and silence is
  // justified by arithmetic rather than by giving up.
  //
  // Note the direction: this is STRICTLY quieter than the behaviour it replaces,
  // which fired a census-only finding on EVERY timeout regardless of the floor.
  if (reapable + unknown < floor) return null;

  if (classification.partial) {
    return {
      kind: KIND_PARTIAL,
      census,
      classifierTotal: total,
      classified: classification.classified,
      unknown,
      // CONFIRMED, not estimated: these count only trees actually examined.
      reapable,
      zero_loss,
      tag_first,
      keep,
      // The most trees that could be reapable once the UNKNOWN ones are read.
      // Reported as a CEILING and labelled as one — never as a count.
      reapableUpperBound: reapable + unknown,
      floor,
      budgetMs: classification.budgetMs || null,
    };
  }

  if (reapable < floor) return null;

  return {
    kind: KIND_BACKLOG,
    census,
    classifierTotal: total,
    reapable,
    zero_loss,
    tag_first,
    keep,
    floor,
  };
}

/**
 * Decide what to say about an unattended reap that has ALREADY RUN. Pure.
 *
 * @param {number|null} census  trees git reported before the pass, or null
 * @param {object|null} result  `reapForest` result
 * @param {number}      floor   reapable floor
 * @returns {object|null} finding, or null when there is nothing worth saying
 *
 * Order is load-bearing, and differs from `evaluateForest` in one way that
 * matters: this runs AFTER the removals, so silence here means "nothing was
 * removed and nothing needs an operator", never "nothing was examined".
 *   1. UNMEASURED census → null (same reasoning as evaluateForest).
 *   2. census < floor → null. The reap never ran; the short-circuit held.
 *   3. INTERRUPTED → its own kind. Trees may already be gone, so this must not
 *      collapse into census-only ("did not complete" reads as "nothing
 *      happened") and must not claim a count.
 *   4. otherwise-failed → census-only. The pass never got going.
 *   5. nothing removed, no TAG-FIRST backlog, no refusals → null. A healthy
 *      forest that was swept and had nothing to give up says nothing.
 *
 * ONE DELIBERATE ASYMMETRY WITH `evaluateForest`, because it looks like a bug.
 * The REPORT path fires only at `reapable >= floor`; this ACT path acts on, and
 * reports, a single removal. The floor is an ANTI-CRY-WOLF device — it exists so
 * a detector does not nag about a two-tree backlog — and that rationale applies
 * to unsolicited advice, not to work already done. Reaping one provably-lossless
 * tree costs nothing and is exactly how accumulation is prevented rather than
 * merely announced; having done it, saying so is not optional at any count. Cost
 * is still bounded by the shared `census < floor` short-circuit above, which
 * gates whether the pass runs at all.
 *   6. otherwise → reaped finding, carrying OUTCOMES (removed, refusals) and
 *      verdict tallies as separate fields, because they are separate claims.
 */
function evaluateReap(census, result, floor) {
  if (!Number.isInteger(census)) return null;
  if (census < floor) return null;

  if (!result || result.ok !== true) {
    if (result && result.interrupted) {
      return {
        kind: KIND_REAP_INTERRUPTED,
        census,
        floor,
        reason: result.reason || "the reap was cut short",
      };
    }
    return {
      kind: KIND_CENSUS_ONLY,
      census,
      reapable: null,
      zero_loss: null,
      tag_first: null,
      keep: null,
      floor,
      reason: (result && result.reason) || "classifier not run",
    };
  }

  const { zero_loss, tag_first, keep, total } = result.counts;
  const removed = result.removed || [];
  const refusals = result.refusals || [];
  const unknown = result.unknown || 0;
  const heldNotOwned = result.heldNotOwned || [];
  // A PARTIAL pass is never silent, even with nothing removed and nothing to
  // escalate — unlike a complete sweep, it has not established that there was
  // nothing to give up. Silence here would assert exactly the thing it failed to
  // check. `unknown > 0` therefore defeats the silence gate.
  //
  // A pass that REFUSED ON OWNERSHIP is never silent either, and for the same
  // reason one step further out: it did not decline because the trees were
  // healthy, it declined because they were somebody else's. Reporting that as
  // "nothing to give up" would be the `conservation-gate.md` MUST-4 empty in the
  // grammar of a completed one — and this is the exact report a reviewer who
  // just watched a sibling's tree vanish needs to see.
  if (removed.length === 0 && tag_first === 0 && refusals.length === 0 && unknown === 0 && heldNotOwned.length === 0) return null;

  return {
    kind: KIND_REAPED,
    census,
    classifierTotal: total,
    removed,
    refusals,
    heldNotOwned,
    zero_loss,
    tag_first,
    keep,
    // Carried so the report can say what the pass did NOT get to. `removed` is
    // still EXACT — the reaper stops between removals, not during one — which is
    // the difference between this and KIND_REAP_INTERRUPTED.
    partial: result.partial === true,
    unknown,
    classified: Number.isInteger(result.classified) ? result.classified : total,
    floor,
    freeKbBefore: Number.isFinite(result.freeKbBefore) ? result.freeKbBefore : null,
    freeKbAfter: Number.isFinite(result.freeKbAfter) ? result.freeKbAfter : null,
  };
}

// ── report formatting (PURE) ────────────────────────────────────────────────
//
// Lives here rather than in the hook so it is requirable without attaching the
// hook's stdin listeners and starting its timeout timer. `hook-output-discipline.md`
// MUST-1 requires a non-empty `agent_must_report`; these are the lines that
// satisfy it, and a test asserts the census-only variant never tells the agent a
// tree is reapable.

/** Build the agent-facing report lines for a finding. */
function reportLines(finding) {
  if (finding.kind === KIND_PARTIAL) {
    return [
      `State the counts as PARTIAL: ${finding.classified} of ${finding.census} tree(s) were classified before the ${finding.budgetMs ?? "classify"}ms budget ran out; ${finding.unknown} were NOT examined.`,
      `State what IS known, as fact: of the ${finding.classified} classified, ${finding.reapable} are reapable (${finding.zero_loss} ZERO-LOSS + ${finding.tag_first} TAG-FIRST) and ${finding.keep} are KEEP.`,
      `State that the remaining ${finding.unknown} tree(s) are UNKNOWN — NOT examined, which is NOT the same as KEEP. Do NOT report any of them as safe to remove, and do NOT count them toward any verdict.`,
      `If a total is needed, give it as a CEILING and say so: at most ${finding.reapableUpperBound} of ${finding.census} could be reapable once the UNKNOWN trees are read. That is an upper bound, not a count.`,
      "Run `node .claude/bin/worktree-reap.mjs` yourself (no deadline, full audit) to resolve the UNKNOWN trees before acting.",
      "Do NOT use `git worktree remove --force` or `rm -rf` — unstaged and untracked-not-ignored work has NO reflog (worktree-isolation.md Rule 8).",
    ];
  }
  if (finding.kind === KIND_CENSUS_ONLY) {
    return [
      `State the measured worktree count: ${finding.census} tree(s) in this repo's forest.`,
      `State that reapability is UNKNOWN — the classifier did not complete (${sanitizeName(finding.reason)}). Do NOT report any tree as safe to remove on this evidence.`,
      "Run `node .claude/bin/worktree-reap.mjs` yourself and report its verdicts before acting.",
      "Do NOT use `git worktree remove --force` or `rm -rf` — unstaged and untracked-not-ignored work has NO reflog (worktree-isolation.md Rule 8).",
    ];
  }
  return [
    `State the counts: ${finding.census} worktree(s); ${finding.reapable} classify reapable (${finding.zero_loss} ZERO-LOSS + ${finding.tag_first} TAG-FIRST); ${finding.keep} are KEEP and will not be touched.`,
    "Name worktree-isolation.md Rule 8 (Creation Owns Teardown) as the obligation this surfaces.",
    "Run `node .claude/bin/worktree-reap.mjs` (report-only) and show the operator the per-tree verdicts before reaping anything.",
    "Reap with `node .claude/bin/worktree-reap.mjs --apply`, which touches ZERO-LOSS and TAG-FIRST only. `--force` and `rm -rf` are BLOCKED — they defeat the dirty-tree refusal that protects work with no reflog.",
  ];
}

/** KiB → a readable binary unit; null → "unknown". */
function fmtKb(kb) {
  if (!Number.isFinite(kb)) return "unknown";
  if (kb < 1024) return `${kb} KiB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MiB`;
  return `${(kb / 1024 / 1024).toFixed(2)} GiB`;
}

/**
 * Agent-facing report lines for a finding produced by `evaluateReap` — i.e. for
 * a pass that ALREADY ACTED. Kept separate from `reportLines` because the tense
 * is different and conflating them is how a report starts telling an operator to
 * go do something that has already been done.
 */
function reapReportLines(finding) {
  if (finding.kind === KIND_REAP_INTERRUPTED) {
    return [
      `State that an unattended ZERO-LOSS reap STARTED on this ${finding.census}-tree forest and was CUT SHORT (${sanitizeName(finding.reason)}).`,
      "State that an UNKNOWN number of trees were removed before it stopped. Do NOT report a count, do NOT call the reap complete, and do NOT call it a no-op — none of those is known.",
      "Run `node .claude/bin/worktree-reap.mjs` (report-only) to read the CURRENT forest before making any claim about it.",
      "Do NOT use `git worktree remove --force` or `rm -rf` — unstaged and untracked-not-ignored work has NO reflog (worktree-isolation.md Rule 8).",
    ];
  }

  const lines = [];
  if (finding.removed.length > 0) {
    // SANITIZED. These lines land VERBATIM in `agent_must_report`, which the
    // agent reads as authoritative. A worktree basename and a branch name are
    // both attacker-influenceable — anyone who can push a branch or create a
    // directory picks one — and a raw control character or backtick breaks the
    // name out of its own bullet. `sanitizeName` is the same function
    // `unlanded-work-surface.js` applies to the branch names IT renders, imported
    // rather than copied. Restored 2026-08-19: the whole worktree lineage was
    // interpolating these raw, which the reconciliation surfaced.
    const named = finding.removed.map((r) => sanitizeName(r.name)).join(", ");
    lines.push(
      `State that the SessionEnd reap REMOVED ${finding.removed.length} ZERO-LOSS worktree(s): ${named}.`,
    );
    lines.push(
      "State that only the DIRECTORIES were removed — every branch ref survives, so each tree re-materialises with `git worktree add <path> <branch>` (worktree-isolation.md Rule 8).",
    );
  } else if (finding.heldNotOwned.length > 0) {
    // "Removed nothing" is TRUE and misleading here — the trees were not held by
    // evidence that they were healthy, they were refused because this pass may
    // not act on them. The two answers call for opposite follow-ups (fix the
    // tree vs. leave it alone), so they must not print the same.
    lines.push(
      `State that the SessionEnd reap removed NOTHING. It was NOT because the forest was clean: ${finding.heldNotOwned.length} of ${finding.census} tree(s) were REFUSED because this session did not create them, and a pass may remove only its own (worktree-isolation.md Rule 8).`,
    );
  } else {
    lines.push(
      `State that the SessionEnd reap removed NOTHING: no tree in this ${finding.census}-tree forest classified ZERO-LOSS.`,
    );
  }
  lines.push(
    `State that ${finding.keep} tree(s) classified KEEP and were not touched — held by a dirty tree, unpushed commits, a lock, recent activity, or being the main checkout or this session's own worktree.`,
  );
  if (finding.unknown > 0) {
    lines.push(
      `State that the pass was PARTIAL: ${finding.classified} of ${finding.census} tree(s) were classified and ${finding.unknown} were NOT examined (the budget ran out). Those ${finding.unknown} are UNKNOWN, not KEEP — none may be reported as safe to remove. The removal count above is still EXACT: the pass stops between removals, never during one.`,
    );
  }
  if (finding.tag_first > 0) {
    lines.push(
      `State that ${finding.tag_first} tree(s) classified TAG-FIRST and were deliberately NOT reaped unattended: they are detached and unreachable from any ref, so removal depends on a tag this pass will not mint without an operator. Run \`node .claude/bin/worktree-reap.mjs --apply\` to tag and reap them.`,
    );
  }
  if (finding.heldNotOwned.length > 0) {
    const named = finding.heldNotOwned.map((r) => sanitizeName(r.name)).join(", ");
    lines.push(
      `State that ${finding.heldNotOwned.length} tree(s) were REPORTED and NOT reaped because this session did not create them: ${named}. Name them as SURVIVORS, not as findings — nothing was wrong with them, and an operator must not go looking for a defect that is not there. A session removes only the trees it created; another session's tree is not this pass's to touch.`,
    );
  }
  if (finding.refusals.length > 0) {
    // `r.err` is GIT's stderr, not this repo's prose, and `r.path` is a
    // filesystem path — both sanitized for the same reason as the names above.
    const named = finding.refusals
      .map((r) => `${sanitizeName(r.path)} (${sanitizeName(r.err)})`)
      .join("; ");
    lines.push(
      `State that git REFUSED ${finding.refusals.length} removal(s): ${named}. That refusal is the dirty-tree safety net working as designed — it was NOT escalated to \`--force\`, and it MUST NOT be.`,
    );
  }
  if (finding.freeKbBefore !== null && finding.freeKbAfter !== null) {
    lines.push(
      `State the volume free space across the pass: ${fmtKb(finding.freeKbBefore)} → ${fmtKb(finding.freeKbAfter)}. Report it as a DELTA ACROSS THE PASS, not as space the reap reclaimed — other processes write to this volume concurrently, so the difference is not attributable to the reap alone.`,
    );
  }
  return lines;
}

/** One-line user-facing stderr summary. */
function summarize(finding) {
  switch (finding.kind) {
    case KIND_PARTIAL:
      return `worktree forest: ${finding.classified} of ${finding.census} tree(s) classified (${finding.reapable} reapable); ${finding.unknown} UNKNOWN — not examined`;
    case KIND_CENSUS_ONLY:
      return `worktree forest: ${finding.census} tree(s); reap classification did not complete`;
    case KIND_REAP_INTERRUPTED:
      return `worktree forest: the unattended reap was cut short — how many of ${finding.census} tree(s) were removed is UNKNOWN`;
    case KIND_REAPED:
      return (
        (finding.removed.length > 0
          ? `worktree forest: reaped ${finding.removed.length} ZERO-LOSS tree(s) of ${finding.census}; ${finding.keep} KEEP untouched`
          : finding.heldNotOwned.length > 0
            ? `worktree forest: removed nothing of ${finding.census} tree(s) — ${finding.heldNotOwned.length} belong to another session and were reported, not reaped`
            : `worktree forest: ${finding.census} tree(s), nothing was ZERO-LOSS; ${finding.tag_first} TAG-FIRST need an operator`) +
        (finding.removed.length > 0 && finding.heldNotOwned.length > 0 ? ` (${finding.heldNotOwned.length} not this session's, reported)` : "")
      );
    default:
      return `worktree forest: ${finding.reapable} of ${finding.census} tree(s) are reapable (Rule 8 teardown backlog)`;
  }
}

module.exports = {
  DEFAULT_REAPABLE_FLOOR,
  DEFAULT_CACHE_GC_QUIET_MIN,
  CLASSIFY_TIMEOUT_MS,
  REAP_TIMEOUT_MS,
  cacheGcAllowedWorktrees,
  // Re-exported from `worktree-occupancy.js` so a variant hook has ONE import
  // for the whole forest surface and never has to reach past this module into a
  // second one — the shape that made a variant grow its own copies.
  COUNT_BANDS,
  bandFor,
  crossedBand,
  listGitWorktreePaths,
  resolveMainWorktreeRoot,
  snapshotProcesses,
  occupantsOf,
  sanitizeName,
  CLASSIFY_MS_PER_TREE,
  CLASSIFY_FLOOR_MS,
  CLASSIFY_CEILING_MS,
  REAP_MS_PER_TREE,
  REAP_FLOOR_MS,
  REAP_CEILING_MS,
  BUDGET_GRACE_MS,
  classifyBudgetMs,
  reapBudgetMs,
  KIND_BACKLOG,
  KIND_CENSUS_ONLY,
  KIND_PARTIAL,
  KIND_REAPED,
  KIND_REAP_INTERRUPTED,
  resolveFloor,
  resolveAutoReap,
  isWorktreeCreatingCommand,
  isUnlockedWorktreeAdd,
  censusForest,
  volumeFreeKb,
  classifyForest,
  reapForest,
  evaluateForest,
  evaluateReap,
  reportLines,
  reapReportLines,
  summarize,
};
