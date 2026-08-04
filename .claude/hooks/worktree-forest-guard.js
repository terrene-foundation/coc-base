#!/usr/bin/env node
/**
 * worktree-forest-guard.js — the Phase-2 detector `worktree-isolation.md` Rule 8
 * deferred. Surfaces an un-reaped worktree forest; NEVER removes anything.
 *
 * @hook-event: PreToolUse:Bash (guard) — the subject is the worktree-CREATING
 *   command itself, which exists only as the pending Bash invocation; no later
 *   event can see it before the tree is added, and no earlier one knows it is
 *   coming. Bash is the sole matcher because `git worktree add` is a shell
 *   command; an Edit/Write matcher would never see it.
 * @hook-event: SessionEnd (lifecycle) — the subject is the forest a closing
 *   session leaves behind, which is only final once no further tool call will
 *   add to it. Rule 8(b) exists because 8(a) "fails silently whenever an
 *   orchestrator dies mid-wave"; SessionEnd is the last moment that case is
 *   still observable from inside the session that caused it.
 *
 * TWO SURFACES, both chosen on evidence rather than convenience:
 *
 *   PreToolUse(Bash) on a worktree-CREATING command — the moment the ratchet
 *     turns. This is where "creation owns teardown" actually binds: the operator
 *     is about to add tree N+1, and if N already contains a reapable backlog,
 *     that is the cheapest possible moment to say so. It fires RARELY (only on
 *     `git worktree add` / `/worktree`), so it cannot become background noise.
 *
 *   SessionEnd — the once-per-session close-out. Rule 8(b) exists because 8(a)
 *     "fails silently whenever an orchestrator dies mid-wave, the case that leaks
 *     most"; a session ending with a reapable backlog is the visible edge of that
 *     case. Fires exactly once, so it is free.
 *
 * NOT Stop. Stop fires on EVERY turn, and an instruction there nags after every
 * post-commit turn — the reasoning `wrapup-after-landing.js` records verbatim for
 * rejecting Stop for its own trigger. A forest census is also ~28 `git status`
 * calls at this clone's size; paying that per turn would be a real cost for a
 * signal that changes at most a few times a session.
 *
 * SEVERITY — `halt-and-report` at PreToolUse, `advisory` at SessionEnd, never
 * `block`, per `hook-output-discipline.md` MUST-2.
 *
 *   The SIGNAL is structural and deterministic — `git worktree list --porcelain`
 *   enumerates the forest from `.git/worktrees/`, and the reap verdicts derive
 *   from `git status --porcelain` / `rev-list --not --remotes` / `cherry` / mtime.
 *   None of that is a lexical guess and none can be evaded by rewording a
 *   command. By MUST-2's letter, a structural signal MAY carry `block`.
 *
 *   It does not, and the reason is MUST-2's own MUST NOT: "detectors that block
 *   work the agent has been instructed to perform, when the structural fact
 *   confirms in-scope". Whether a reapable backlog should stop the NEXT worktree
 *   from being created is a judgment about the operator's plan, not a fact about
 *   the repo — a 30-lane wave is legitimate. Blocking it would make this the
 *   detector whose false-positive cost exceeds its true-positive value. So the
 *   structural signal buys CONFIDENCE IN THE NUMBER (the report states counts as
 *   fact), not teeth.
 *
 * IT NEVER REMOVES. There is no removal path in this file or its library. The
 * remediation it prints is `worktree-reap.mjs`, which is report-only by default,
 * classifies on evidence, and never implements `--force`. Both scripts ship to
 * every synced target: `.claude/hooks/**` and `.claude/bin/worktree-reap.mjs` are
 * both on `sync-tier-aware.mjs::ALWAYS_INCLUDE`, so the hook this settings.json
 * wires at every consumer resolves the tool it names.
 *
 * FAIL-OPEN. Every error path emits `{continue:true}` and exits 0/1. A detector
 * that can wedge a session is worse than the accumulation it reports.
 */

const path = require("path");
const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
const {
  resolveFloor,
  isWorktreeCreatingCommand,
  censusForest,
  classifyForest,
  evaluateForest,
  reportLines,
  summarize,
  KIND_CENSUS_ONLY,
} = require(path.join(__dirname, "lib", "worktree-forest.js"));

// cc-artifacts.md Rule 7 — timeout fallback that never hangs the session. Exit 1
// (not 0) so a fired timeout is distinguishable from a normal passthrough in
// exit-code logs. Generous over the 8s classifier budget below.
const TIMEOUT_MS = 14000;
const _timeout = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);
_timeout.unref?.();

function passthrough() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

function run(payload) {
  const event = payload.hook_event_name || "";
  const repoDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const floor = resolveFloor(process.env);

  if (event === "PreToolUse") {
    const cmd = (payload.tool_input && payload.tool_input.command) || "";
    if (!isWorktreeCreatingCommand(cmd)) return passthrough();
  } else if (event !== "SessionEnd") {
    // Registered only on those two events; anything else is a mis-registration
    // and passes through rather than guessing what the caller meant.
    return passthrough();
  }

  const census = censusForest(repoDir);
  // The cheap short-circuit: below the floor no finding is REACHABLE (reapable
  // is a subset of census), so the expensive classifier is never spawned. A
  // solo repo with one or two trees pays one `git worktree list` and nothing else.
  if (!Number.isInteger(census) || census < floor) return passthrough();

  const classification = classifyForest(repoDir);
  const finding = evaluateForest(census, classification, floor);
  if (!finding) return passthrough();

  emit({
    hookEvent: event,
    severity: event === "PreToolUse" ? "halt-and-report" : "advisory",
    what_happened:
      finding.kind === KIND_CENSUS_ONLY
        ? `Worktree forest census: ${finding.census} tree(s) (floor ${finding.floor}); reap classification did not complete.`
        : `Worktree forest census: ${finding.census} tree(s), ${finding.reapable} reapable (floor ${finding.floor}).` +
          (event === "PreToolUse"
            ? " A new worktree was about to be created on top of that backlog."
            : " The session is ending with the backlog un-reaped."),
    why: "worktree-isolation.md/Rule-8 — creation owns teardown; the forest grows unbounded until the volume fills",
    agent_must_report: reportLines(finding),
    agent_must_wait:
      event === "PreToolUse"
        ? "Report the counts, then proceed with the worktree creation if it is still what the operator wants. This is a report, not a block."
        : "No action required in this session; the report is for the operator.",
    user_summary: summarize(finding),
  });
}

let input = "";
process.stdin.on("error", passthrough);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  clearTimeout(_timeout);
  try {
    run(JSON.parse(input || "{}"));
  } catch (e) {
    process.stderr.write(`[worktree-forest-guard] HOOK ERROR: ${e.message}\n`);
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }
});
