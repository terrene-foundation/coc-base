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
 * IT REPORTS; IT NEVER REMOVES. No branch of this module or its hook runs
 * `git worktree remove`, `prune`, `--force`, or `rm`. The co-owner's incident
 * report is explicit that blanket removal is the dangerous path — 15 worktrees
 * in the terminal state held 295 uncommitted-or-untracked files, six of them
 * database migrations, none of which exist in any commit. The remedy this
 * detector points at is `worktree-reap.mjs`, which is report-only by default and
 * never implements `--force`.
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

// ── classification (delegated to the shipped classifier) ────────────────────

/**
 * Run `.claude/bin/worktree-reap.mjs --json` and return its counts.
 *
 * DELEGATED, NOT REIMPLEMENTED. Rule 8 names that script as the authority and
 * `worktree-reap.test.mjs` holds a positive-control fixture per verdict. A second
 * classifier here would be a second lineage that drifts — the `security.md`
 * § Multi-Site Kwarg Plumbing failure mode, and the substance of loom#1549.
 *
 * The invocation is READ-ONLY: no `--apply`, so the script's own default
 * (report-only, "changes NOTHING") governs. It is spawned WITHOUT a shell and
 * with an argv array, so nothing in the environment can turn it into a removal.
 *
 * Returns { ok: true, counts } or { ok: false, reason } — never throws, and
 * never synthesises counts it did not read.
 */
function classifyForest(repoDir, opts = {}) {
  const run = opts.exec || execFileSync;
  const script =
    opts.scriptPath || path.join(repoDir, ".claude", "bin", "worktree-reap.mjs");
  let out;
  try {
    out = run(process.execPath, [script, "--json"], {
      cwd: repoDir,
      encoding: "utf8",
      timeout: opts.timeoutMs || 8000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    // worktree-reap exits 2 when an --apply removal was REFUSED. We never pass
    // --apply, so a non-zero exit here means the script could not run (absent,
    // not a repo, timed out). Either way we have no counts, and saying so is the
    // whole point — a fabricated zero would read as "healthy forest".
    return { ok: false, reason: shortReason(e) };
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { ok: false, reason: "classifier output was not JSON" };
  }
  const c = parsed && parsed.counts;
  if (
    !c ||
    !Number.isInteger(c.total) ||
    !Number.isInteger(c.zero_loss) ||
    !Number.isInteger(c.tag_first) ||
    !Number.isInteger(c.keep)
  ) {
    return { ok: false, reason: "classifier output missing counts" };
  }
  return { ok: true, counts: c };
}

function shortReason(e) {
  const s = String((e && (e.stderr || e.message)) || "unknown").trim();
  return s.split("\n")[0].slice(0, 160) || "unknown";
}

// ── the finding predicate (PURE) ────────────────────────────────────────────

const KIND_BACKLOG = "reapable-backlog";
const KIND_CENSUS_ONLY = "census-only";

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

/** One-line user-facing stderr summary. */
function summarize(finding) {
  return finding.kind === KIND_CENSUS_ONLY
    ? `worktree forest: ${finding.census} tree(s); reap classification did not complete`
    : `worktree forest: ${finding.reapable} of ${finding.census} tree(s) are reapable (Rule 8 teardown backlog)`;
}

module.exports = {
  DEFAULT_REAPABLE_FLOOR,
  KIND_BACKLOG,
  KIND_CENSUS_ONLY,
  resolveFloor,
  isWorktreeCreatingCommand,
  censusForest,
  classifyForest,
  evaluateForest,
  reportLines,
  summarize,
};
