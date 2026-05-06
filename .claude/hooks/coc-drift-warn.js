#!/usr/bin/env node
/**
 * Hook: coc-drift-warn
 * Event: SessionStart
 * Purpose: Detect uncommitted COC-artifact drift in this BUILD repo and
 *          emit a LOUD non-blocking warning into the session's
 *          additionalContext + systemMessage.
 *
 *   Failure mode this defends: loom's `/sync-to-build` delivers artifacts
 *   into the working tree as M/D/?? files under `.claude/**` and (until
 *   2.8.31) `scripts/hooks/**`. Multiple historical sessions worked AROUND
 *   the drift — staging only "touched" files for unrelated PRs — instead
 *   of landing it. Result: new commands like `/autonomize`, new agents
 *   like `cli-orchestrator`, and the canonical `.claude/hooks/` migration
 *   sat uncommitted for days. Sessions assumed those artifacts were
 *   "available" because they were physically on disk; once committed to
 *   a feature branch, switching to main silently removed them and the
 *   user saw "Unknown command: /autonomize".
 *
 *   This hook scans for the drift at SessionStart and prints a loud
 *   warning citing the user's 2026-05-02 directive: "ALWAYS get the
 *   updated coc artifacts INTO MAIN BRANCH!!! Never leave them out!
 *   memory IS NOT ENOUGH". Memory + rule + this hook = three layers
 *   of defense.
 *
 *   Non-blocking by design — the warning informs, the agent decides
 *   whether to land it as PR #1 (default) or document why deferral
 *   is appropriate (rare). Always use admin-merge flow per the repo's
 *   owner workflow (rules/git.md § Branch Protection).
 *
 * Origin: 2026-05-02 user directive after a session opened with
 *   /autonomize unknown despite the command having been delivered to
 *   the working tree by the prior loom /sync-to-build cycle.
 *
 * Exit Codes:
 *   0 = success (always — never blocks)
 *   1 = hook timeout (still continues the session)
 */

const { execFileSync } = require("child_process");

const TIMEOUT_MS = 5000;
const timeout = setTimeout(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function safeExec(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      cwd: PROJECT_DIR,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
  } catch (_) {
    return null;
  }
}

function detectDrift() {
  const status = safeExec("git", [
    "status",
    "--porcelain",
    "--",
    ".claude/",
    "scripts/hooks/",
  ]);
  if (status === null) return null;
  const lines = status
    .split("\n")
    .map((l) => l)
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  const counts = {
    modified: 0,
    deleted: 0,
    untracked: 0,
    renamed: 0,
    added: 0,
  };
  for (const l of lines) {
    const xy = l.slice(0, 2);
    if (xy === "??") counts.untracked++;
    else if (xy[0] === "R" || xy[1] === "R") counts.renamed++;
    else if (xy[0] === "A" || xy[1] === "A") counts.added++;
    else if (xy[0] === "D" || xy[1] === "D") counts.deleted++;
    else if (xy[0] === "M" || xy[1] === "M") counts.modified++;
  }

  const sample = lines
    .slice(0, 10)
    .map((l) => `  ${l}`)
    .join("\n");
  const more = lines.length > 10 ? `\n  ... and ${lines.length - 10} more` : "";

  return { total: lines.length, counts, sample: sample + more };
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    const drift = detectDrift();
    if (!drift) {
      console.log(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const c = drift.counts;
    const breakdown = `modified=${c.modified} deleted=${c.deleted} untracked=${c.untracked} renamed=${c.renamed} added=${c.added}`;

    const warning = [
      "==================================================================",
      "🚨 COC ARTIFACT DRIFT DETECTED — LAND IT BEFORE OTHER WORK 🚨",
      "==================================================================",
      "",
      `${drift.total} uncommitted change(s) under .claude/** or scripts/hooks/**`,
      `  ${breakdown}`,
      "",
      "Paths:",
      drift.sample,
      "",
      "USER DIRECTIVE (2026-05-02, ESCALATED):",
      '  "ALWAYS get the updated coc artifacts INTO MAIN BRANCH!!!',
      '   Never leave them out! memory IS NOT ENOUGH"',
      "",
      "WHY THIS MATTERS: When loom's /sync-to-build delivers artifacts and",
      "they sit uncommitted, every session sees them on disk and assumes",
      "they're 'available' — but the moment any commit moves them to a",
      "feature branch, switching to main silently removes them. New",
      "commands like /autonomize disappear; new agents and skills become",
      "invisible. The drift is the failure mode.",
      "",
      "REQUIRED ACTION (this session, before other work):",
      "  1. git checkout -b chore/coc-sync-<date-or-version>",
      "  2. git add .claude/ scripts/hooks/    # NEVER `git add -u` (sweeps unrelated)",
      "  3. git commit -m 'chore(coc): land /sync-to-build delivery'",
      "  4. git push -u origin <branch>",
      "  5. gh pr create --title '...' --body '...'",
      "  6. gh pr merge <N> --admin --merge --delete-branch",
      "  7. git checkout main && git pull --ff-only",
      "",
      "Only AFTER the COC drift is on main may the session proceed to",
      "other work. If drift is genuinely non-COC (e.g. local WIP a teammate",
      "would not want), state why in the first user-facing message and",
      "proceed with awareness.",
      "==================================================================",
    ].join("\n");

    const summaryMessage = `🚨 COC drift: ${drift.total} uncommitted .claude/ files — land as PR #1 (see additionalContext)`;

    const output = {
      continue: true,
      systemMessage: summaryMessage,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: warning,
      },
    };
    console.log(JSON.stringify(output));
    process.exit(0);
  } catch (_) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }
});
