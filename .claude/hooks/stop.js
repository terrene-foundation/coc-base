#!/usr/bin/env node

/**
 * Stop Hook - Graceful Shutdown Handler
 *
 * Purpose: Handle stop signals when Claude Code is interrupted
 * - Save final checkpoint before shutdown
 * - Mark session as interrupted
 * - Log observation for learning system
 * - Clean up temporary resources
 *
 * Exit Codes:
 * - 0: Success (allow graceful shutdown)
 *
 * Note: This hook should NEVER block shutdown - always return 0
 */

const fs = require("fs");
const path = require("path");
// learning-utils no longer needed — stop observations removed
const { detectActiveWorkspace } = require("./lib/workspace-utils");

// Timeout fallback — prevents hanging the Claude Code session
const TIMEOUT_MS = 5000;
const _timeout = setTimeout(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0); // Stop hooks always exit 0 to allow shutdown
}, TIMEOUT_MS);

// Get home directory (cross-platform)
const HOME = process.env.HOME || process.env.USERPROFILE;

// Directory paths
const CLAUDE_DIR = path.join(HOME, ".claude");
const CHECKPOINTS_DIR = path.join(CLAUDE_DIR, "checkpoints");

/**
 * Ensure directory exists
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Save final checkpoint
 */
function saveCheckpoint(sessionId, cwd, pendingWork) {
  try {
    ensureDir(CHECKPOINTS_DIR);

    const checkpoint = {
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      cwd: cwd,
      type: "stop",
      pending_work: pendingWork || null,
      interrupted: true,
    };

    const checkpointPath = path.join(
      CHECKPOINTS_DIR,
      `stop_${sessionId}_${Date.now()}.json`,
    );
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));

    return checkpointPath;
  } catch (error) {
    // Don't fail on checkpoint error - allow graceful shutdown
    return null;
  }
}

// Stop observation logging removed — "stop" events were 49% of all observations
// with zero learning value. Session state is captured by saveCheckpoint().

/**
 * Clean up any temporary resources
 */
function cleanupResources(cwd) {
  try {
    // Clean up any .claude-tmp files in working directory
    if (cwd && fs.existsSync(cwd)) {
      const tmpPattern = /^\.claude-tmp/;
      const files = fs.readdirSync(cwd);

      for (const file of files) {
        if (tmpPattern.test(file)) {
          const filePath = path.join(cwd, file);
          try {
            fs.unlinkSync(filePath);
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      }
    }
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Main stop handler
 */
async function main() {
  let input = "";

  // Read input from stdin
  process.stdin.setEncoding("utf8");

  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data = {};
  try {
    data = JSON.parse(input);
  } catch (e) {
    // If no JSON input, use defaults
  }

  // Sanitize session_id to prevent path traversal
  const sessionId = (data.session_id || `stop_${Date.now()}`).replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
  const cwd = data.cwd || process.cwd();
  const pendingWork = data.pending_work || null;
  const reason = data.reason || "signal";

  // ── Workspace: remind about /wrapup ──────────────────────────────────
  try {
    const ws = detectActiveWorkspace(cwd);
    if (ws) {
      console.error(
        `[WORKSPACE] Session ending for ${ws.name}. Run /wrapup next time before closing to save session context.`,
      );
    }
  } catch {}

  // Perform graceful shutdown tasks
  const checkpointPath = saveCheckpoint(sessionId, cwd, pendingWork);
  const cleaned = cleanupResources(cwd);

  // Output result - Stop hooks only support basic schema (no hookSpecificOutput)
  // The schema only defines hookSpecificOutput for PreToolUse, UserPromptSubmit, PostToolUse
  const result = {
    continue: true, // Always allow shutdown
  };

  console.log(JSON.stringify(result));
  process.exit(0); // Always exit 0 - never block shutdown
}

main().catch(() => {
  // Even on error, output valid JSON and exit 0
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
});
