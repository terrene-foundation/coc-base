/**
 * Shared utility: Per-project learning directory resolution and observation logging.
 *
 * Used by all hooks and learning scripts to ensure observations are stored
 * per-project (in <project>/.claude/learning/) rather than globally.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Resolve the learning directory for a given project.
 *
 * Priority:
 *   1. KAILASH_LEARNING_DIR env var (for testing)
 *   2. <cwd>/.claude/learning/ (per-project)
 *   3. ~/.claude/kailash-learning/ (legacy fallback)
 *
 * @param {string} [cwd] - Project working directory
 * @returns {string} Absolute path to the learning directory
 */
function resolveLearningDir(cwd) {
  if (process.env.KAILASH_LEARNING_DIR) {
    return process.env.KAILASH_LEARNING_DIR;
  }
  if (cwd) {
    // M9.1 R7 Sec-R7-S-01 — route through state-resolver SSOT so a
    // worktree-isolated rostered agent reads/writes against the MAIN
    // checkout's `.claude/learning/`, not the worktree's auto-deleted
    // directory. Mirrors `state-resolver.js::resolveStateDir` and
    // closes the asymmetric CRIT-2 re-introduction R7 flagged.
    try {
      const { resolveStateDir } = require(
        path.join(__dirname, "state-resolver.js"),
      );
      return resolveStateDir(cwd);
    } catch {
      // state-resolver unavailable — fall back to the legacy worktree-local
      // resolution. Best-effort; security-relevant callers (stamped path)
      // import state-resolver directly to surface failures loudly.
      return path.join(cwd, ".claude", "learning");
    }
  }
  return path.join(os.homedir(), ".claude", "kailash-learning");
}

/**
 * Ensure the learning directory and its subdirectories exist.
 *
 * @param {string} [cwd] - Project working directory
 * @returns {string} The resolved learning directory path
 */
function ensureLearningDir(cwd) {
  const learningDir = resolveLearningDir(cwd);

  const dirs = [learningDir, path.join(learningDir, "observations.archive")];

  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }

  return learningDir;
}

/**
 * Append an observation to the per-project observations.jsonl file.
 *
 * @param {string} cwd - Project working directory
 * @param {string} type - Observation type (e.g. "rule_violation", "user_correction", "workflow_pattern")
 * @param {Object} data - Observation data payload
 * @param {Object} [context] - Additional context (session_id, framework, etc.)
 */
function logObservation(cwd, type, data, context) {
  try {
    const learningDir = ensureLearningDir(cwd);
    const observationsFile = path.join(learningDir, "observations.jsonl");

    // M9.1 R3 Sec-R3-S-01: strip absolute-home prefix from cwd to avoid
    // PII (operator username) leak per `security.md` § "No secrets in logs"
    // + `user-flow-validation.md` MUST-6. Record repo basename only.
    const rawCwd = cwd || process.cwd();
    const idx = Math.max(rawCwd.lastIndexOf("/"), rawCwd.lastIndexOf("\\"));
    const repoBasename = idx >= 0 ? rawCwd.slice(idx + 1) || "unknown" : rawCwd;

    // M9.1 R4 Sec-R4-S-02 — route through appendStamped (signed identity
    // stamping) per `knowledge-convergence.md` MUST-6 when identity
    // resolves. Mirrors `detect-violations.js::_logViolation` pattern.
    // Un-rostered fallback path preserves the legacy unsigned write with
    // explicit `attribution: "un-rostered"` marker so audit can
    // distinguish stamped from un-stamped rows.
    try {
      const { appendStamped } = require(path.join(__dirname, "coc-append.js"));
      const { resolveIdentity } = require(
        path.join(__dirname, "operator-id.js"),
      );
      const id = resolveIdentity(cwd);
      if (id && id.verified_id && id.person_id) {
        const result = appendStamped(
          cwd || process.cwd(),
          observationsFile,
          { type, data, context: context || {} },
          {
            identity: {
              verified_id: id.verified_id,
              person_id: id.person_id,
              display_id: id.display_id,
            },
          },
        );
        if (result && result.ok) return result.id;
      }
    } catch {
      // identity / append failure — fall through to legacy unsigned path.
    }

    // Legacy unsigned path with attribution marker (un-rostered fallback).
    const observation = {
      id: `obs_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      type,
      data,
      context: {
        session_id: "unknown",
        cwd: repoBasename,
        framework: "unknown",
        ...context,
      },
      attribution: "un-rostered",
    };

    fs.appendFileSync(observationsFile, JSON.stringify(observation) + "\n");
    return observation.id;
  } catch {
    return null;
  }
}

/**
 * Count observations in the current observations.jsonl file.
 *
 * @param {string} learningDir - Learning directory path
 * @returns {number} Number of observations
 */
function countObservations(learningDir) {
  try {
    const observationsFile = path.join(learningDir, "observations.jsonl");
    if (!fs.existsSync(observationsFile)) return 0;
    const content = fs.readFileSync(observationsFile, "utf8");
    return content
      .trim()
      .split("\n")
      .filter((l) => l).length;
  } catch {
    return 0;
  }
}

module.exports = {
  resolveLearningDir,
  ensureLearningDir,
  logObservation,
  countObservations,
};
