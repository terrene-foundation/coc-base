"use strict";

/**
 * ci-cost-reach — deliver the CI-cost contract at the moment CI spend is decided.
 *
 * THE GAP THIS CLOSES (T4). `rules/ci-cost-discipline.md` is fully written — MUST-1
 * (do not re-push an open PR to ask CI the question), MUST-2 (one revert-safe PR per
 * wave), MUST-3 (an amendment to a queued PR costs a full run), MUST-4 (merge cadence),
 * MUST-5 (fold only when both preconditions measure true here). It is UNREACHABLE at
 * the moment it governs.
 *
 * WHY A `paths:` GLOB IS NOT THE FIX — stated at the strength the measurement supports,
 * and NARROWED after loom#1715 M-4 found the first version of this paragraph over-claimed
 * it as "structurally impossible".
 *
 * What IS measured: a `paths:` glob cannot be TRIGGERED BY the push event. Path-scoped
 * rules inject off a session's TOUCHED-FILE set, and a `git push` touches no file, so no
 * glob can match ON the push itself.
 *
 * What is NOT true, and was claimed anyway: that a glob therefore cannot REACH the push
 * MOMENT. Injection is sticky-once per session — `check-rule-injection-budget.mjs` is
 * explicit ("path-scoped rules inject their WHOLE body once per session, the first time a
 * tool call touches a path matching the rule's `paths:` globs (sticky-once, verified
 * 2026-06-27)") — so a broad glob matching any file the session touched EARLIER leaves the
 * rule loaded AT push time. A broad glob would therefore reach SOME pushes: those in
 * sessions that happened to touch a matching file first. It is a coincidence, not a
 * guarantee — the session that edits only `src/` and pushes still gets nothing — and it is
 * separately BLOCKED on injection headroom: the `workspace-note` profile measures 409,646 B
 * against a 410,135 B ceiling (2026-08-14), 489 B of room for a 32 KB rule body. That figure
 * MOVES with every path-scoped rule in the profile — re-measure it, do not cite this line.
 * Going `priority: 0` baseline is barred by the measured emission headroom on the same
 * evidence.
 *
 * So the argument for THIS surface is not impossibility, it is COVERAGE: the hook fires on
 * every CI-spending command regardless of what the session touched, which no glob can
 * promise at any headroom. The T1-T6 plan listed glob-widening as the PREFERRED fix; this
 * module is the alternative the same plan named.
 *
 * WHAT THIS IS NOT. It is NOT the deferred Phase-2 DETECTOR. It renders no verdict about
 * whether a push was wasteful; it delivers the CONTRACT so the agent holds it while
 * deciding. Two defeats are deliberately designed around, both found by adversarial review
 * of an earlier attempt at this surface:
 *
 *   - NO NETWORK CALL. `lib/open-pr-surface.js` records that "execFileSync blocks the event
 *     loop, so the hook's own setTimeout cannot preempt them" — a `cc-artifacts.md` Rule 7
 *     timer CANNOT bound a synchronous network call. A network read here would hang every
 *     `git push` in the repo. No existing PreToolUse hook on this matcher makes one.
 *   - NO "IS A RUN IN FLIGHT?" SIGNAL. An in-flight run is consistent with BOTH a wasteful
 *     re-push and a legitimate one, so no output it could produce would falsify the
 *     proposition — a non-discriminating instrument in the exact sense
 *     `instrument-discipline.md` MUST-1 blocks. Building one INTO the fix for
 *     non-discriminating instruments was the defect that got that attempt rejected.
 *
 * DISCRIMINATION — the property that keeps this from becoming wallpaper. A hook that speaks
 * on EVERY push teaches the agent to ignore it, which is the non-discrimination failure mode
 * that made `wrapup-after-landing.js` dismissible (it fires on 100% of merges and carries
 * zero bits) — a frequency symptom of a discrimination disease. So delivery is ONCE PER
 * SESSION, at the FIRST CI-spending command. The falsifying result is nameable and local:
 * a session that has already been delivered the contract gets it again. After the first
 * delivery this module returns null forever, and the marker read is a filesystem stat, not
 * a judgment.
 *
 * FAIL-OPEN, ALWAYS. Every path returns a value; nothing throws to the caller. An
 * observability/delivery surface must never block a session (`cc-artifacts.md` Rule 7). If
 * the marker PATH cannot be resolved, or the marker cannot be written, the contract is
 * delivered — erring toward speaking once too often rather than silently never, because the
 * silent-never failure is invisible and is precisely what T4 exists to end.
 *
 * The wording is PRECISE about which failure is real, because loom#1715 H-2 found the
 * earlier "cannot be READ" version pinned by a test that could not fail. `fs.existsSync`
 * NEVER throws — it swallows its own validation errors and returns false, so a marker that
 * "cannot be read" is indistinguishable from one that does not exist, and a test asserting
 * `false` on that path receives `false` from the ordinary not-exists branch. What DOES
 * throw is `path.join` on a non-string `repoRoot` (ERR_INVALID_ARG_TYPE), which is the
 * branch `alreadyDelivered`'s catch actually guards and the branch its test now exercises.
 */

const path = require("path");
const fs = require("fs");

const { findGhSubcommand, parseGitInvocations } = require(
  path.join(__dirname, "git-command-parse.js"),
);

/**
 * Cheap literal prefilter. The shared parser is hardened but not free, and this runs on
 * EVERY Bash call in the session. Both tokens must appear for any classification to be
 * possible, so their joint absence is a sound early return.
 */
function _couldSpendCI(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  return command.includes("push") || command.includes("pr");
}

/**
 * A push that buys no run. `--dry-run` / `-n` makes `git push` a local no-op: it contacts
 * the remote to compute what WOULD be sent and updates nothing, so no ref moves and no
 * workflow triggers. Delivering the CI-cost contract there spends the session's one
 * delivery on a command that spends no CI — which is the wallpaper failure in miniature,
 * since the delivery is once-per-session and would then be gone before the real push.
 *
 * Read off `argv` (post-subcommand TOKENS), never the joined `args`: the parser's own note
 * is that a joined string cannot tell a real `--dry-run` FLAG from the same characters
 * inside a quoted argument. loom#1715 L-6.
 */
const _isDryRun = (inv) =>
  Array.isArray(inv?.argv) &&
  inv.argv.some((a) => a === "--dry-run" || a === "-n");

/**
 * Classify a command as a CI-spending act, or null.
 *
 * `git push`   — buys a run, and on an OPEN PR cancels the in-flight one (MUST-1/MUST-3).
 * `gh pr create` — buys the first run and fixes the wave's PR count (MUST-2).
 *
 * Routed through the SHARED parser rather than a bare regex: it is already hardened
 * against quoting, nesting, `sh -c`, `eval`, command substitution and leading-token
 * variation (`cd x && git push`, `git -C /repo push`, `sudo git push`,
 * `env FOO=1 git push`), every one of which a `^\s*git\s+push` anchor misses. That anchor
 * class is a recorded defect here (loom#1549 HIGH-3), not a hypothetical.
 *
 * EVERY push invocation is examined, not just the first: `git push --dry-run && git push`
 * spends CI on its second segment, so short-circuiting on the leading dry run would go
 * silent on a command that does buy a run.
 *
 * @returns {{kind: "push"|"pr-create"} | null}
 */
function classifyCiSpend(command) {
  if (!_couldSpendCI(command)) return null;
  const cmd = String(command || "");
  const spendingPush = parseGitInvocations(cmd).some(
    (inv) => inv.sub === "push" && !_isDryRun(inv),
  );
  if (spendingPush) return { kind: "push" };
  if (findGhSubcommand(cmd, "pr", "create")) return { kind: "pr-create" };
  return null;
}

/**
 * Per-session delivery marker. Lives beside the other per-session sinks under
 * `.claude/learning/` — the per-clone, never-committed, operator-correlatable state class
 * (gitignored). Session id is sanitized to a single path segment: a raw id is caller-
 * supplied and MUST NOT be able to traverse out of the directory.
 */
function _markerPath(repoRoot, sessionId) {
  const safe = String(sessionId || "no-session")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 64);
  return path.join(repoRoot, ".claude", "learning", "ci-cost-reach", `${safe}.marker`);
}

/**
 * True IFF this session has already been delivered the contract. Never throws.
 *
 * The catch guards `_markerPath`, NOT `fs.existsSync`. `existsSync` swallows its own
 * validation errors and returns false for anything it cannot stat, so it contributes no
 * throwing branch; `path.join` raises ERR_INVALID_ARG_TYPE on a non-string `repoRoot`,
 * and that is what this catch converts into a NOT-delivered verdict rather than an
 * exception thrown into a PreToolUse hook (`cc-artifacts.md` Rule 7).
 */
function alreadyDelivered(repoRoot, sessionId) {
  try {
    return fs.existsSync(_markerPath(repoRoot, sessionId));
  } catch {
    // Unresolvable marker path => treat as NOT delivered and speak. Erring toward one
    // extra delivery is recoverable; erring toward silence reproduces the gap being closed.
    return false;
  }
}

/** Record delivery. Never throws; a failure here costs at most one repeat delivery. */
function recordDelivered(repoRoot, sessionId) {
  try {
    const p = _markerPath(repoRoot, sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, "", { mode: 0o600, flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The delivered contract. Deliberately the load-bearing CLAUSES, not the whole rule:
 * `governed-throughput.md` MUST-1 mandates curated MINIMAL slices and BLOCKS full-corpus
 * injection, which measurably DEGRADES output as well as costing budget.
 *
 * Every figure below is quoted from the rule's own measured Origin (793-run sample) rather
 * than restated from memory, and each is labelled WALL-CLOCK — the rule is explicit that
 * these runs largely execute zero steps, so claiming runner-capacity savings would be the
 * over-claim its own MUST NOT block bars.
 */
function formatReachAdvisory(kind) {
  if (kind !== "push" && kind !== "pr-create") return null;
  const head =
    kind === "push"
      ? "About to spend CI on a push. `ci-cost-discipline.md` governs this moment and does not otherwise load here:"
      : "About to open a PR, which fixes this wave's PR count. `ci-cost-discipline.md` governs this moment and does not otherwise load here:";
  return [
    head,
    "- MUST-1: establish locally that this passes BEFORE pushing — every further push to an OPEN PR cancels the in-flight run and starts fresh from zero. Measured: 1,165 of 1,208 destroyed wall-clock minutes (96.5%) were re-pushes to the same open PR, 78 of them averaging 14.9 min. Pushing to ask CI the question is BLOCKED.",
    "- MUST-2: ONE PR per wave IF AND ONLY IF the whole diff is jointly revert-safe — reverting leaves the tree coherent and removes exactly one decision. Split what is not jointly revert-safe, however many PRs that yields; never bundle unrelated work to hit a count.",
    "- MUST-3: amending or force-pushing a QUEUED PR discards a purchased queue position. Queue wait is 78% of elapsed time here, so 'it had not started yet' is the loss, not a mitigation.",
    "- MUST-4: where the target uses a shared concurrency group, serialize or batch merges; use the merge queue where one exists.",
    "- MUST-5: fold a wave onto one integration branch ONLY after measuring BOTH preconditions in THIS repo. Under a branch-general `push:` trigger folding INVERTS into a per-shard cost.",
    "This is the contract, not a verdict — no check has judged your push. Read it and decide.",
  ].join("\n");
}

module.exports = {
  classifyCiSpend,
  formatReachAdvisory,
  alreadyDelivered,
  recordDelivered,
};
