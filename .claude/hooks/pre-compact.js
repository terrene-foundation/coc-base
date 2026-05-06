#!/usr/bin/env node
/**
 * Hook: pre-compact
 * Event: PreCompact
 * Purpose: Save critical context before compaction
 *
 * Exit Codes:
 *   0 = success (continue)
 *   2 = blocking error (stop tool execution)
 *   other = non-blocking error (warn and continue)
 */

const fs = require("fs");
const path = require("path");
const {
  resolveLearningDir,
  ensureLearningDir,
  logObservation: logLearningObservation,
} = require("./lib/learning-utils");
const { detectActiveWorkspace } = require("./lib/workspace-utils");

// Timeout fallback — prevents hanging the Claude Code session
const TIMEOUT_MS = 10000;
const _timeout = setTimeout(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const result = savePreCompactState(data);
    // PreCompact schema: no hookSpecificOutput. Surface stderr summary so
    // user sees what was checkpointed (was DARK pre-fix).
    if (result && result.checkpointed) {
      const wfCount = result.workflows || 0;
      const recCount = result.recentCount || 0;
      process.stderr.write(
        `[pre-compact] checkpoint saved (framework=${result.framework}, workflows=${wfCount}, recent=${recCount})\n`,
      );
    } else if (result) {
      process.stderr.write(
        `[pre-compact] checkpoint FAILED: ${result.error || "unknown"}\n`,
      );
    }
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  } catch (error) {
    process.stderr.write(`[pre-compact] HOOK ERROR: ${error.message}\n`);
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
});

function savePreCompactState(data) {
  // Sanitize session_id to prevent path traversal
  const session_id = (data.session_id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const cwd = data.cwd;
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const checkpointDir = path.join(homeDir, ".claude", "checkpoints");
  const learningDir = resolveLearningDir(cwd);

  // Ensure directories exist
  [checkpointDir].forEach((dir) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  });
  ensureLearningDir(cwd);

  const checkpoint = {
    session_id,
    cwd,
    compactedAt: new Date().toISOString(),
    preservedContext: {
      // Critical items to preserve
      frameworkInUse: detectFramework(cwd),
      activeWorkflows: findActiveWorkflows(cwd),
      recentlyModified: findRecentlyModified(cwd),
      criticalPatterns: extractCriticalPatterns(cwd),
    },
  };

  try {
    // Save checkpoint
    const checkpointFile = path.join(
      checkpointDir,
      `${session_id}-${Date.now()}.json`,
    );
    fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2));

    // Log enriched connection_pattern observation for learning
    logLearningObservation(
      cwd,
      "connection_pattern",
      {
        framework: checkpoint.preservedContext.frameworkInUse,
        active_workflows: checkpoint.preservedContext.activeWorkflows,
        critical_patterns: checkpoint.preservedContext.criticalPatterns,
        recently_modified_count:
          checkpoint.preservedContext.recentlyModified.length,
      },
      {
        session_id,
      },
    );

    // checkpoint-manager removed — learning digest replaces checkpoints

    // ── Workspace: remind to save session notes before compaction ──────
    try {
      const ws = detectActiveWorkspace(cwd);
      if (ws) {
        console.error(
          `[WORKSPACE] Context compacting. Before losing context, write session notes to workspaces/${ws.name}/.session-notes (or run /wrapup).`,
        );
      }
    } catch {}

    // Clean up old checkpoints (keep last 10 per session)
    cleanupOldCheckpoints(checkpointDir, session_id, 10);

    return {
      checkpointed: true,
      path: checkpointFile,
      framework: checkpoint.preservedContext.frameworkInUse,
      workflows: checkpoint.preservedContext.activeWorkflows.length,
      recentCount: checkpoint.preservedContext.recentlyModified.length,
    };
  } catch (error) {
    return { checkpointed: false, error: error.message };
  }
}

// Permitted exception to cc-artifacts Rule 4 (no semantic analysis in hooks):
// Framework detection here is structural context preservation for compaction checkpoints,
// not agent decision-making. See journal/0009 decision D1.
function detectFramework(cwd) {
  try {
    const files = fs.readdirSync(cwd).filter((f) => f.endsWith(".py"));

    for (const file of files.slice(0, 10)) {
      try {
        const content = fs.readFileSync(path.join(cwd, file), "utf8");
        if (/@db\.model/.test(content) || /from dataflow/.test(content))
          return "dataflow";
        if (/from nexus/.test(content) || /Nexus\(/.test(content))
          return "nexus";
        if (
          /from kaizen/.test(content) ||
          /BaseAgent/.test(content) ||
          /from kaizen\.api import Agent/.test(content)
        )
          return "kaizen";
        if (/WorkflowBuilder/.test(content)) return "core-sdk";
      } catch {}
    }

    return "core-sdk";
  } catch {
    return "unknown";
  }
}

function findActiveWorkflows(cwd) {
  try {
    const workflows = [];
    const files = fs.readdirSync(cwd).filter((f) => f.endsWith(".py"));

    for (const file of files.slice(0, 10)) {
      try {
        const content = fs.readFileSync(path.join(cwd, file), "utf8");
        if (/WorkflowBuilder/.test(content)) {
          // Extract workflow name if possible
          const match = content.match(
            /workflow\s*=\s*WorkflowBuilder\s*\(\s*["']([^"']+)["']/,
          );
          workflows.push({
            file,
            name: match ? match[1] : "unnamed",
          });
        }
      } catch {}
    }

    return workflows;
  } catch {
    return [];
  }
}

function findRecentlyModified(cwd) {
  try {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentFiles = [];

    const files = fs
      .readdirSync(cwd)
      .filter((f) => f.endsWith(".py") || f.endsWith(".md"));

    for (const file of files) {
      try {
        const stats = fs.statSync(path.join(cwd, file));
        if (stats.mtime.getTime() > oneHourAgo) {
          recentFiles.push(file);
        }
      } catch {}
    }

    return recentFiles.slice(0, 10);
  } catch {
    return [];
  }
}

function extractCriticalPatterns(cwd) {
  const patterns = {
    hasDataFlowModels: false,
    hasNexusApp: false,
    hasKaizenAgent: false,
    hasCyclicWorkflow: false,
    hasAsyncRuntime: false,
  };

  try {
    const files = fs.readdirSync(cwd).filter((f) => f.endsWith(".py"));

    for (const file of files.slice(0, 10)) {
      try {
        const content = fs.readFileSync(path.join(cwd, file), "utf8");
        if (/@db\.model/.test(content)) patterns.hasDataFlowModels = true;
        if (/Nexus\(/.test(content)) patterns.hasNexusApp = true;
        if (/BaseAgent|from kaizen\.api import Agent/.test(content))
          patterns.hasKaizenAgent = true;
        if (/enable_cycles\s*=\s*True/.test(content))
          patterns.hasCyclicWorkflow = true;
        if (/AsyncLocalRuntime/.test(content)) patterns.hasAsyncRuntime = true;
      } catch {}
    }
  } catch {}

  return patterns;
}

function cleanupOldCheckpoints(checkpointDir, sessionId, keepCount) {
  try {
    const prefix = `${sessionId}-`;
    const files = fs
      .readdirSync(checkpointDir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({
        name: f,
        path: path.join(checkpointDir, f),
        mtime: fs.statSync(path.join(checkpointDir, f)).mtime,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    // Remove files beyond keepCount
    for (const file of files.slice(keepCount)) {
      try {
        fs.unlinkSync(file.path);
      } catch {}
    }
  } catch {}
}
