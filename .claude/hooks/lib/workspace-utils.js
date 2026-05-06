/**
 * Shared utility: Workspace detection and phase derivation.
 *
 * Used by session-start.js, user-prompt-rules-reminder.js, and phase commands.
 * Framework-agnostic — works with any Kailash project.
 */

const fs = require("fs");
const path = require("path");

/**
 * Detect the active workspace under workspaces/.
 * Returns the most recently modified project directory, or null if none.
 *
 * @param {string} cwd - Project root directory
 * @returns {{ name: string, path: string } | null}
 */
function detectActiveWorkspace(cwd) {
  const wsDir = path.join(cwd, "workspaces");
  try {
    const entries = fs.readdirSync(wsDir, { withFileTypes: true });
    const projects = entries
      .filter(
        (e) =>
          e.isDirectory() &&
          e.name !== "instructions" &&
          !e.name.startsWith("_"),
      )
      .map((e) => {
        const fullPath = path.join(wsDir, e.name);
        try {
          const stat = fs.statSync(fullPath);
          return { name: e.name, path: fullPath, mtime: stat.mtime.getTime() };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    return projects.length > 0
      ? { name: projects[0].name, path: projects[0].path }
      : null;
  } catch {
    return null;
  }
}

/**
 * Derive the current phase from workspace filesystem state.
 *
 * Heuristics (evaluated in reverse order — latest phase takes priority):
 * - Has .claude/agents/project/ or .claude/skills/project/ files -> phase 05
 * - Has 04-validate/ with files -> phase 04
 * - Has todos/completed/ with files OR src/ or apps/ with files -> phase 03
 * - Has todos/active/ with files -> phase 02
 * - Has 01-analysis/ or 02-plans/ or 03-user-flows/ -> phase 01
 * - Empty workspace -> not-started
 *
 * @param {string} workspacePath - Absolute path to workspace directory
 * @param {string} cwd - Project root (for checking .claude/agents/project/)
 * @returns {string} Phase identifier
 */
function derivePhase(workspacePath, cwd) {
  // Check for phase 05 artifacts
  if (cwd) {
    const agentProjectDir = path.join(cwd, ".claude", "agents", "project");
    const skillProjectDir = path.join(cwd, ".claude", "skills", "project");
    if (dirHasFiles(agentProjectDir) || dirHasFiles(skillProjectDir)) {
      return "05-codify";
    }
  }

  // Check for phase 04 artifacts
  if (dirHasFiles(path.join(workspacePath, "04-validate"))) {
    return "04-validate";
  }

  // Check for implementation activity (phase 03)
  const completedCount = countFiles(
    path.join(workspacePath, "todos", "completed"),
  );
  if (
    completedCount > 0 ||
    dirHasFiles(path.join(workspacePath, "src")) ||
    dirHasFiles(path.join(workspacePath, "apps"))
  ) {
    return "03-implement";
  }

  // Check for todos (phase 02)
  const activeCount = countFiles(path.join(workspacePath, "todos", "active"));
  if (activeCount > 0) {
    return "02-todos";
  }

  // Check for analysis artifacts (phase 01)
  if (
    dirHasFiles(path.join(workspacePath, "01-analysis")) ||
    dirHasFiles(path.join(workspacePath, "02-plans")) ||
    dirHasFiles(path.join(workspacePath, "03-user-flows"))
  ) {
    return "01-analyze";
  }

  return "not-started";
}

/**
 * Get todo progress counts.
 *
 * @param {string} workspacePath
 * @returns {{ active: number, completed: number }}
 */
function getTodoProgress(workspacePath) {
  return {
    active: countFiles(path.join(workspacePath, "todos", "active")),
    completed: countFiles(path.join(workspacePath, "todos", "completed")),
  };
}

/**
 * Read .session-notes content if present.
 *
 * @param {string} workspacePath
 * @returns {{ content: string, stale: boolean, age: string } | null}
 */
function getSessionNotes(workspacePath) {
  const notesPath = path.join(workspacePath, ".session-notes");
  return readSessionNotesFile(notesPath);
}

/**
 * Find all .session-notes across repo root and workspaces, sorted newest first.
 *
 * Searches:
 *   1. cwd/.session-notes (repo root)
 *   2. cwd/workspaces/<dir>/.session-notes (all workspace dirs)
 *
 * @param {string} cwd - Project root directory
 * @returns {Array<{ path: string, relativePath: string, workspace: string|null, content: string, stale: boolean, age: string, mtime: number }>}
 */
function findAllSessionNotes(cwd) {
  const results = [];

  // Check repo root
  const rootNotes = path.join(cwd, ".session-notes");
  const rootResult = readSessionNotesFile(rootNotes);
  if (rootResult) {
    results.push({
      ...rootResult,
      path: rootNotes,
      relativePath: ".session-notes",
      workspace: null,
    });
  }

  // Check all workspace dirs
  const wsDir = path.join(cwd, "workspaces");
  try {
    const entries = fs.readdirSync(wsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name === "instructions" ||
        entry.name.startsWith("_")
      )
        continue;
      const notesPath = path.join(wsDir, entry.name, ".session-notes");
      const result = readSessionNotesFile(notesPath);
      if (result) {
        results.push({
          ...result,
          path: notesPath,
          relativePath: `workspaces/${entry.name}/.session-notes`,
          workspace: entry.name,
        });
      }
    }
  } catch {}

  // Sort newest first
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

/**
 * Read a single .session-notes file and compute age metadata.
 *
 * @param {string} notesPath - Absolute path to .session-notes
 * @returns {{ content: string, stale: boolean, age: string, mtime: number } | null}
 */
function readSessionNotesFile(notesPath) {
  try {
    const content = fs.readFileSync(notesPath, "utf8");
    const stat = fs.statSync(notesPath);
    const mtime = stat.mtime.getTime();
    const ageMs = Date.now() - mtime;
    const ageHours = Math.round(ageMs / (1000 * 60 * 60));
    const stale = ageMs > 24 * 60 * 60 * 1000;

    let age;
    if (ageHours < 1) age = "< 1h ago";
    else if (ageHours < 24) age = `${ageHours}h ago`;
    else age = `${Math.round(ageHours / 24)}d ago`;

    return { content: content.trim(), stale, age, mtime };
  } catch {
    return null;
  }
}

/**
 * Build a compact 1-line workspace summary for per-turn injection.
 *
 * @param {string} cwd
 * @returns {string | null}
 */
function buildWorkspaceSummary(cwd) {
  const ws = detectActiveWorkspace(cwd);
  if (!ws) return null;

  const phase = derivePhase(ws.path, cwd);
  const todos = getTodoProgress(ws.path);

  const parts = [ws.name, `Phase: ${phase}`];
  if (todos.active > 0 || todos.completed > 0) {
    parts.push(`Todos: ${todos.active} active / ${todos.completed} done`);
  }

  // Surface journal candidates waiting for review (written by SessionEnd hook)
  const pending = countFiles(path.join(ws.path, "journal", ".pending"));
  if (pending > 0) {
    parts.push(`Journal candidates pending: ${pending}`);
  }

  return parts.join(" | ");
}

// ── Helpers ────────────────────────────────────────────────────────────

function dirHasFiles(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath);
    return entries.some((e) => !e.startsWith("."));
  } catch {
    return false;
  }
}

function countFiles(dirPath) {
  try {
    return fs.readdirSync(dirPath).filter((e) => !e.startsWith(".")).length;
  } catch {
    return 0;
  }
}

module.exports = {
  detectActiveWorkspace,
  derivePhase,
  getTodoProgress,
  getSessionNotes,
  findAllSessionNotes,
  buildWorkspaceSummary,
  dirHasFiles,
  countFiles,
};
