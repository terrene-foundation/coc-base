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
 * IT REPORTS AT PreToolUse; AT SessionEnd IT ALSO REAPS — ZERO-LOSS ONLY.
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
 * own-worktree hard guards, and the 12h idle floor. This module passes NO
 * `--min-age-hours` and NO `--only`, so the unattended pass runs at the most
 * conservative settings the reaper offers.
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
 *     `git cherry` (patch-upstream), and mtime (idle). Also structural. It
 *     licenses the reapable/KEEP split.
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

// SUBPROCESS BUDGETS, derived from measurement rather than picked.
//
// Measured on this clone at a 26-tree forest (APFS, node v25.9.0), three runs
// each: the default reaper (with its `du` size pass) took 12.57 / 12.23 / 11.86
// s; with `--no-size`, 6.75 / 6.11 / 6.20 s. The old budget here was 8000 ms, so
// the DEFAULT invocation timed out deterministically — and it did so precisely
// on the large forests the detector exists for, while completing on the small
// ones nobody needs it for. Observed three times in one session as
// `spawnSync … ETIMEDOUT`, degrading a real audit into a bare tree count.
//
// TWO FIXES, both needed. `--no-size` (below) halves the cost and costs nothing:
// no line this module reports reads a size field. That alone buys headroom only
// to ~33 trees against 8 s, and the incident forest was 30 — so the budgets also
// rise. The cost model is linear and dominated by one `git status --porcelain`
// per tree (measured: 3.11 s for 26 trees, `sys` 3.61 — a working-tree stat
// walk), giving ~0.24 s/tree; removal adds ~0.6 s per tree actually reaped
// (measured on a 5,800-file fixture; real loom trees are 6,030 files).
//
// A TIMEOUT IS A CEILING, NOT A COST. At 26 trees the classify path now costs
// ~6.2 s against a 15 s ceiling — strictly FASTER than the old code, which
// burned the full 8 s and then reported nothing usable.
const CLASSIFY_TIMEOUT_MS = 15000; // ~62 trees at 0.24 s/tree
const REAP_TIMEOUT_MS = 40000; // 26-tree classify + ~56 removals, or ~100 trees classified

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
  const args = [script, "--json", "--no-size"];
  if (apply) args.push("--apply", "--zero-loss-only");

  let out;
  try {
    out = run(process.execPath, args, {
      cwd: repoDir,
      encoding: "utf8",
      timeout: opts.timeoutMs || (apply ? REAP_TIMEOUT_MS : CLASSIFY_TIMEOUT_MS),
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
  for (const w of Array.isArray(parsed.worktrees) ? parsed.worktrees : []) {
    const actions = Array.isArray(w.actions) ? w.actions : [];
    if (actions.includes("removed") || actions.includes("pruned")) {
      removed.push({ path: w.path, name: path.basename(w.path || ""), branch: w.branch || null });
    }
  }

  return {
    ok: true,
    applied: parsed.applied === true,
    counts: c,
    removed,
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

/** Classify AND reap ZERO-LOSS trees. The only caller is the SessionEnd surface. */
function reapForest(repoDir, opts = {}) {
  return runReaper(repoDir, { ...opts, apply: true });
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

// ── the finding predicate (PURE) ────────────────────────────────────────────

const KIND_BACKLOG = "reapable-backlog";
const KIND_CENSUS_ONLY = "census-only";
const KIND_REAPED = "reaped";
const KIND_REAP_INTERRUPTED = "reap-interrupted";

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
  if (removed.length === 0 && tag_first === 0 && refusals.length === 0) return null;

  return {
    kind: KIND_REAPED,
    census,
    classifierTotal: total,
    removed,
    refusals,
    zero_loss,
    tag_first,
    keep,
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
  if (finding.kind === KIND_CENSUS_ONLY) {
    return [
      `State the measured worktree count: ${finding.census} tree(s) in this repo's forest.`,
      `State that reapability is UNKNOWN — the classifier did not complete (${finding.reason}). Do NOT report any tree as safe to remove on this evidence.`,
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
      `State that an unattended ZERO-LOSS reap STARTED on this ${finding.census}-tree forest and was CUT SHORT (${finding.reason}).`,
      "State that an UNKNOWN number of trees were removed before it stopped. Do NOT report a count, do NOT call the reap complete, and do NOT call it a no-op — none of those is known.",
      "Run `node .claude/bin/worktree-reap.mjs` (report-only) to read the CURRENT forest before making any claim about it.",
      "Do NOT use `git worktree remove --force` or `rm -rf` — unstaged and untracked-not-ignored work has NO reflog (worktree-isolation.md Rule 8).",
    ];
  }

  const lines = [];
  if (finding.removed.length > 0) {
    const named = finding.removed.map((r) => r.name).join(", ");
    lines.push(
      `State that the SessionEnd reap REMOVED ${finding.removed.length} ZERO-LOSS worktree(s): ${named}.`,
    );
    lines.push(
      "State that only the DIRECTORIES were removed — every branch ref survives, so each tree re-materialises with `git worktree add <path> <branch>` (worktree-isolation.md Rule 8).",
    );
  } else {
    lines.push(
      `State that the SessionEnd reap removed NOTHING: no tree in this ${finding.census}-tree forest classified ZERO-LOSS.`,
    );
  }
  lines.push(
    `State that ${finding.keep} tree(s) classified KEEP and were not touched — held by a dirty tree, unpushed commits, a lock, recent activity, or being the main checkout or this session's own worktree.`,
  );
  if (finding.tag_first > 0) {
    lines.push(
      `State that ${finding.tag_first} tree(s) classified TAG-FIRST and were deliberately NOT reaped unattended: they are detached and unreachable from any ref, so removal depends on a tag this pass will not mint without an operator. Run \`node .claude/bin/worktree-reap.mjs --apply\` to tag and reap them.`,
    );
  }
  if (finding.refusals.length > 0) {
    const named = finding.refusals.map((r) => `${r.path} (${r.err})`).join("; ");
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
    case KIND_CENSUS_ONLY:
      return `worktree forest: ${finding.census} tree(s); reap classification did not complete`;
    case KIND_REAP_INTERRUPTED:
      return `worktree forest: the unattended reap was cut short — how many of ${finding.census} tree(s) were removed is UNKNOWN`;
    case KIND_REAPED:
      return finding.removed.length > 0
        ? `worktree forest: reaped ${finding.removed.length} ZERO-LOSS tree(s) of ${finding.census}; ${finding.keep} KEEP untouched`
        : `worktree forest: ${finding.census} tree(s), nothing was ZERO-LOSS; ${finding.tag_first} TAG-FIRST need an operator`;
    default:
      return `worktree forest: ${finding.reapable} of ${finding.census} tree(s) are reapable (Rule 8 teardown backlog)`;
  }
}

module.exports = {
  DEFAULT_REAPABLE_FLOOR,
  CLASSIFY_TIMEOUT_MS,
  REAP_TIMEOUT_MS,
  KIND_BACKLOG,
  KIND_CENSUS_ONLY,
  KIND_REAPED,
  KIND_REAP_INTERRUPTED,
  resolveFloor,
  resolveAutoReap,
  isWorktreeCreatingCommand,
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
