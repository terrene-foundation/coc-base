#!/usr/bin/env node
/**
 * Hook: validate-prod-deploy
 * Event: PreToolUse
 * Matcher: Bash
 * Purpose: Block direct production deployment commands unless staging has passed.
 *
 * Intercepts Bash commands that touch production Docker containers and
 * requires .staging-passed to exist with the current git HEAD commit.
 *
 * To use this hook, register it in .claude/settings.json under PreToolUse:Bash.
 * See deploy/scripts/ for the stage.sh and deploy.sh that write/read the marker.
 *
 * Exit Codes:
 *   0 = allow (command is safe or staging verified)
 *   2 = block (direct production deploy without staging)
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { instructAndWait } = require("./lib/instruct-and-wait");

const TIMEOUT_MS = 5000;
const timeout = setTimeout(() => {
  // Timeout = allow (fail-open to avoid blocking all Bash commands)
  process.exit(0);
}, TIMEOUT_MS);

/**
 * Emit a halting block via instructAndWait per hook-output-discipline.md MUST-1.
 * Structural evidence (file existence / git rev) is the basis for block severity
 * per MUST-2 — never lexical regex alone.
 */
function emitBlock({
  what_happened,
  why,
  agent_must_report,
  agent_must_wait,
  user_summary,
}) {
  const out = instructAndWait({
    hookEvent: "PreToolUse",
    severity: "block",
    what_happened,
    why,
    agent_must_report,
    agent_must_wait,
    user_summary,
  });
  clearTimeout(timeout);
  console.log(JSON.stringify(out.json));
  process.exit(out.exitCode);
}

async function main() {
  try {
    const input = JSON.parse(fs.readFileSync("/dev/stdin", "utf8"));
    const toolName = input.tool_name;
    const toolInput = input.tool_input || {};
    const command = toolInput.command || "";

    // Only check Bash commands
    if (toolName !== "Bash") {
      clearTimeout(timeout);
      process.exit(0);
      return;
    }

    // Patterns that indicate production deployment
    // Projects should add their own container name patterns below.
    const PROD_PATTERNS = [
      // Generic docker compose prod file patterns
      /docker.*compose.*prod.*up/i,
      /docker.*compose.*prod.*build/i,
      /docker.*compose.*prod.*restart/i,
      /docker.*compose.*-f.*docker-compose\.prod/i,
      // bare docker restart (single container restarts bypass compose)
      /docker\s+restart\s+\S+/,
      // SSH to production server running docker compose
      /ssh\s+.*docker\s+(compose|stack)/i,
    ];

    // Patterns that are always allowed (read-only, logs, status, dev scripts)
    const SAFE_PATTERNS = [
      /docker.*logs/i,
      /docker.*ps/i,
      /docker.*inspect/i,
      /docker.*images/i,
      /docker\s+exec/i,
      /git\s+(pull|log|status|diff)/i,
      /curl/i,
      /cat|grep|head|tail|ls/,
      /deploy\/scripts\/stage\.sh/,
      /deploy\/scripts\/promote\.sh/,
      /deploy\/scripts\/dev\.sh/,
      /docker.*compose.*dev.*up/i,
      /docker.*compose.*staging.*up/i,
    ];

    // Check safe patterns first — if command is clearly safe, allow immediately
    for (const safe of SAFE_PATTERNS) {
      if (safe.test(command)) {
        clearTimeout(timeout);
        process.exit(0);
        return;
      }
    }

    // Check if command matches a production deploy pattern
    let isProductionDeploy = false;
    for (const pattern of PROD_PATTERNS) {
      if (pattern.test(command)) {
        isProductionDeploy = true;
        break;
      }
    }

    if (!isProductionDeploy) {
      clearTimeout(timeout);
      process.exit(0);
      return;
    }

    // Skip-staging escape hatch — allow but warn loudly
    if (command.includes("--skip-staging")) {
      console.error(
        "\n" +
          "[DEPLOY HOOK] WARNING: --skip-staging detected.\n" +
          "[DEPLOY HOOK] Allowing direct production deploy WITHOUT staging verification.\n" +
          "[DEPLOY HOOK] You MUST document the reason in deploy/deployment-config.md.\n",
      );
      clearTimeout(timeout);
      process.exit(0);
      return;
    }

    // Locate repo root by walking up from cwd or script location
    let repoRoot;
    try {
      repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
    } catch {
      // Not in a git repo or git unavailable — fail open
      clearTimeout(timeout);
      process.exit(0);
      return;
    }

    const markerPath = path.join(repoRoot, ".staging-passed");

    // Check that .staging-passed exists.
    // Structural signal per hook-output-discipline.md MUST-2: file existence
    // (fs.existsSync) — not a lexical regex. Block severity is grounded.
    if (!fs.existsSync(markerPath)) {
      emitBlock({
        what_happened: `Production deploy attempted without staging verification (no .staging-passed marker at ${markerPath})`,
        why: "deploy-hygiene.md — staging MUST pass before production deploy; .staging-passed is the structural verification marker written by deploy/scripts/stage.sh",
        agent_must_report: [
          "Quote the exact deploy command that was attempted",
          "State whether staging has been run (run `bash deploy/scripts/promote.sh` or staging+deploy step-by-step)",
          "If emergency bypass is needed, re-issue the command with `--skip-staging` AND document the reason in deploy/deployment-config.md",
        ],
        agent_must_wait:
          "Do not retry until staging has produced .staging-passed at the current commit, OR --skip-staging is passed with a documented reason.",
        user_summary:
          "Production deploy blocked — staging verification missing",
      });
      return;
    }

    // Verify that .staging-passed contains the current commit
    const marker = fs.readFileSync(markerPath, "utf8").trim();
    let currentCommit;
    try {
      currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 3000,
      }).trim();
    } catch {
      // Can't determine current commit — fail open rather than block legitimate work
      clearTimeout(timeout);
      process.exit(0);
      return;
    }

    const shortHash = currentCommit.substring(0, 7);
    // Structural signal per hook-output-discipline.md MUST-2: process state
    // (git rev-parse) compared against a file content (.staging-passed marker).
    // Mismatch is structural evidence that staging is stale; block is grounded.
    if (!marker.includes(shortHash)) {
      emitBlock({
        what_happened: `Production deploy attempted with stale staging marker (HEAD=${shortHash}, marker contains ${marker.substring(0, 7)})`,
        why: "deploy-hygiene.md — code has changed since staging last passed; staging MUST be re-run against the current commit before production deploy",
        agent_must_report: [
          "Quote the deploy command",
          `State the current HEAD (${shortHash}) and the stale marker (${marker.substring(0, 7)})`,
          "Re-run `bash deploy/scripts/promote.sh` to refresh staging at HEAD before retrying",
        ],
        agent_must_wait:
          "Do not retry until staging has been re-run at the current commit and .staging-passed contains the current HEAD short hash.",
        user_summary: `Production deploy blocked — staging stale (HEAD=${shortHash}, marker=${marker.substring(0, 7)})`,
      });
      return;
    }

    // Staging verified and current — allow production deploy
    console.error(
      `[DEPLOY HOOK] Staging verified (${shortHash}). Allowing production deploy.`,
    );
    clearTimeout(timeout);
    process.exit(0);
  } catch (err) {
    // Parse error or unexpected failure — fail open to avoid blocking legitimate work
    clearTimeout(timeout);
    process.exit(0);
  }
}

main();
