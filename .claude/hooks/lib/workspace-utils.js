/**
 * Shared utility: Workspace detection and phase derivation.
 *
 * Used by session-start.js, user-prompt-rules-reminder.js, and phase commands.
 * Framework-agnostic — works with any Kailash project.
 */

const fs = require("fs");
const path = require("path");

// The #743 regenerable per-clone aggregate view filename (Decision-C). SSOT is
// `session-notes-layout.js::AGGREGATE_NAME`; kept as a LOCAL literal here (not a
// runtime import) to avoid coupling this widely-used SessionStart util to the
// heavier layout lib. The two are pinned equal by a cross-file-constant test
// (`zero-tolerance.md` Rule 3e) so a divergence fails a test, never silently.
const AGGREGATE_NOTES_NAME = ".session-notes.aggregate.md";

// Size cap for the SessionStart dashboard read of a session-notes file (R7 MED-1).
// A session-notes file (the regenerated aggregate, or a legacy monolith) is
// derived from tracked/shared fragments, so a teammate-bloated fragment set — or
// a symlink at the notes path — could hang/OOM this synchronous reader. SSOT is
// `session-notes-layout.js::NOTES_READ_CAP_BYTES`; kept as a LOCAL literal here
// (same no-heavy-import decoupling as AGGREGATE_NOTES_NAME) and pinned equal by
// the cross-file-constant test (`zero-tolerance.md` Rule 3e).
const NOTES_READ_CAP_BYTES = 1024 * 1024;

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
 * Find all .session-notes across repo root and workspaces.
 *
 * Ordering (loom#1655): the repo-root row ALWAYS ranks first; workspace rows
 * follow, newest-mtime first among themselves. Root is NOT in the mtime race —
 * see findAllSessionNotesDetailed for why.
 *
 * Searches:
 *   1. cwd/.session-notes (repo root)
 *   2. cwd/workspaces/<dir>/.session-notes (all workspace dirs)
 *
 * @param {string} cwd - Project root directory
 * @returns {Array<{ path: string, relativePath: string, workspace: string|null, content: string, stale: boolean, age: string, mtime: number }>}
 */
function findAllSessionNotes(cwd) {
  return findAllSessionNotesDetailed(cwd).notes;
}

/**
 * findAllSessionNotes + the refusals it had to drop.
 *
 * ── Ordering: the root row is RANK-PRIVILEGED (loom#1655) ──────────────────
 * This helper used to build ONE list (root pushed first, workspaces appended)
 * and then mtime-sort the whole thing, so a freshly-TOUCHED workspace narrative
 * outranked the authoritative root aggregate. mtime is a proxy for AUTHORSHIP
 * that every non-authoring write breaks:
 *   - a fresh clone/worktree stamps checkout time onto every TRACKED workspace
 *     narrative, while the root aggregate is gitignored and therefore ABSENT;
 *   - `git mv` bumps it (the same assumption cc-artifacts.md Rule 8 already had
 *     to fix one level down, for `_archive` meta-dirs);
 *   - any mid-session workspace write bumps it, and user-prompt-rules-reminder.js
 *     re-reads on EVERY turn without regenerating the aggregate (only SessionStart
 *     calls regenerateAggregate), so the root row's mtime goes stale within the
 *     session while narratives keep moving.
 * Root is the single multi-operator READ surface (`commands/wrapup.md`), so its
 * rank MUST be a property of what it IS, not a race against the filesystem. The
 * `workspace: null` discriminator already existed; this just stops discarding it.
 *
 * ── Read failures: fail-OPEN on availability, fail-LOUD on observability ────
 * A refused row is skipped so one bad file can never blank the dashboard — but
 * it is RETURNED in `unreadable` so the caller can say "could not read N" rather
 * than present silence that is indistinguishable from "no notes exist". Plain
 * ABSENCE is not a refusal and is never reported (it is the normal case).
 *
 * @param {string} cwd - Project root directory
 * @returns {{ notes: Array<object>, unreadable: Array<{ path: string, relativePath: string, workspace: string|null, reason: string }> }}
 */
function findAllSessionNotesDetailed(cwd) {
  const notes = [];
  const unreadable = [];

  const record = (res, meta) => {
    if (res.row) {
      notes.push({ ...res.row, ...meta });
      return true;
    }
    // `absent` is the normal case, not a fault — reporting it would cry wolf
    // on every session for every workspace that simply has no notes.
    if (res.reason !== "absent")
      unreadable.push({ ...meta, reason: res.reason });
    return false;
  };

  // ── Root row ────────────────────────────────────────────────────────────
  // Prefer the legacy monolith when present; once the #743 coherence layer has
  // migrated it into the per-operator split (the monolith is renamed to
  // `.session-notes.migrated`), fall back to the regenerable by-name aggregate
  // view (module-level AGGREGATE_NOTES_NAME) so the dashboard still surfaces
  // the operator's notes. A REFUSED monolith also falls through to the
  // aggregate — surfacing the fallback beats surfacing nothing — but the
  // refusal is still recorded so the fallback is not silent.
  const rootNotes = path.join(cwd, ".session-notes");
  const gotMonolith = record(readSessionNotesFileDetailed(rootNotes), {
    path: rootNotes,
    relativePath: ".session-notes",
    workspace: null,
  });
  if (!gotMonolith) {
    const aggNotes = path.join(cwd, AGGREGATE_NOTES_NAME);
    record(readSessionNotesFileDetailed(aggNotes), {
      path: aggNotes,
      relativePath: AGGREGATE_NOTES_NAME,
      workspace: null,
    });
  }

  // ── Workspace rows ──────────────────────────────────────────────────────
  const workspaceRows = [];
  const wsDir = path.join(cwd, "workspaces");
  let entries = [];
  try {
    entries = fs.readdirSync(wsDir, { withFileTypes: true });
  } catch {
    // No workspaces/ dir (or unreadable): a repo without workspaces is normal,
    // and the root row above still stands. Nothing to report.
    entries = [];
  }
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name === "instructions" ||
      entry.name.startsWith("_")
    )
      continue;
    const notesPath = path.join(wsDir, entry.name, ".session-notes");
    const meta = {
      path: notesPath,
      relativePath: `workspaces/${entry.name}/.session-notes`,
      workspace: entry.name,
    };
    const res = readSessionNotesFileDetailed(notesPath);
    if (res.row) {
      workspaceRows.push({ ...res.row, ...meta });
    } else if (res.reason !== "absent") {
      unreadable.push({ ...meta, reason: res.reason });
    }
  }

  // Newest first AMONG WORKSPACES ONLY. Rankable rows sort newest-first; a row
  // whose mtime is non-finite sorts AFTER every rankable row; and two such rows
  // compare EQUAL, keeping their insertion (readdir) order, which the stable
  // sort preserves.
  //
  // REACHABILITY — stated plainly because the comment previously here
  // over-claimed, and replacing that with a smaller over-claim in the opposite
  // direction would be no better. A non-finite mtime was NOT reproducible
  // through the real filesystem path: every extreme `fs.utimesSync` value
  // clamps to a finite epoch (measured: 9223372036855), and the condition was
  // reached only by STUBBING `lstatSync` to return an Invalid Date. This branch
  // is DEFENSIVE. It is not a response to any observed production input, and no
  // claim is made here that a real `stat` can produce one.
  //
  // WHY IT CHANGED ANYWAY. The previous `-Infinity` sentinel returned NaN for
  // the two-unrankable pair (`-Infinity - -Infinity`) — precisely the NaN its
  // own comment claimed to avoid. That NaN was INERT rather than corrupting:
  // V8 tests `cmp(...) > 0`, which NaN and 0 both fail, and ~67k arrangements
  // spanning TimSort's binary-insertion AND merge paths produced identical
  // output under both comparators. So this is not a fix to observable
  // behaviour; it makes the comparator structurally incapable of returning NaN,
  // so the ordering property holds by construction rather than by a
  // coincidence of the engine's comparison predicate.
  workspaceRows.sort((a, b) => {
    const ra = Number.isFinite(a.mtime);
    const rb = Number.isFinite(b.mtime);
    if (ra && rb) return b.mtime - a.mtime; // both rankable: newest first
    if (ra) return -1; // only a rankable: a first
    if (rb) return 1; // only b rankable: b first
    return 0; // neither: equal, stable sort keeps insertion order
  });

  return { notes: notes.concat(workspaceRows), unreadable };
}

/**
 * Read a single .session-notes file and compute age metadata.
 *
 * @param {string} notesPath - Absolute path to .session-notes
 * @returns {{ content: string, stale: boolean, age: string, mtime: number } | null}
 */
function readSessionNotesFile(notesPath) {
  return readSessionNotesFileDetailed(notesPath).row;
}

/**
 * readSessionNotesFile + a typed reason when the read is refused.
 *
 * Reasons: `absent` (nothing there — the normal case, not a fault), `symlink`,
 * `not-a-file`, `oversize`, `read-error`. Callers distinguish "there are no
 * notes" from "there are notes I could not read"; the latter must be reported,
 * never swallowed (`zero-tolerance.md` Rule 3).
 *
 * @param {string} notesPath - Absolute path to .session-notes
 * @returns {{ row: { content: string, stale: boolean, age: string, mtime: number } | null, reason?: string }}
 */
function readSessionNotesFileDetailed(notesPath) {
  let stat;
  try {
    // Guarded read (R7 MED-1): lstat BEFORE reading so a symlinked or
    // teammate-bloated oversized notes path is refused (the dashboard skips
    // it), never read synchronously into a hang/OOM. Parity with
    // session-notes-layout.js::_readNotesFileGuarded + the incorporation guard cap.
    stat = fs.lstatSync(notesPath);
  } catch (e) {
    return {
      row: null,
      reason: e && e.code === "ENOENT" ? "absent" : "read-error",
    };
  }
  if (stat.isSymbolicLink()) return { row: null, reason: "symlink" };
  if (!stat.isFile()) return { row: null, reason: "not-a-file" };
  if (stat.size > NOTES_READ_CAP_BYTES)
    return { row: null, reason: "oversize" };

  let content;
  try {
    content = fs.readFileSync(notesPath, "utf8");
  } catch {
    return { row: null, reason: "read-error" };
  }

  const mtime = stat.mtime.getTime();
  // An unrankable mtime means unknown freshness — which is NOT the same as
  // fresh. Report it as unknown and mark it STALE so the surface says "verify
  // before acting" rather than rendering a confident `NaNd ago`.
  if (!Number.isFinite(mtime)) {
    return {
      row: { content: content.trim(), stale: true, age: "age unknown", mtime },
    };
  }

  const ageMs = Date.now() - mtime;
  const ageHours = Math.round(ageMs / (1000 * 60 * 60));
  const stale = ageMs > 24 * 60 * 60 * 1000;

  let age;
  if (ageHours < 1) age = "< 1h ago";
  else if (ageHours < 24) age = `${ageHours}h ago`;
  else age = `${Math.round(ageHours / 24)}d ago`;

  return { row: { content: content.trim(), stale, age, mtime } };
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
  findAllSessionNotesDetailed,
  buildWorkspaceSummary,
  dirHasFiles,
  countFiles,
  AGGREGATE_NOTES_NAME,
  NOTES_READ_CAP_BYTES,
};
