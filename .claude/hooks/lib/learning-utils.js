/**
 * Shared utility: Per-project learning directory resolution and observation logging.
 *
 * Used by all hooks and learning scripts to ensure observations are stored
 * per-project (in <project>/.claude/learning/) rather than globally.
 */

const fs = require("fs");
const path = require("path");
// loom#1349 — the ONE hardened append primitive; see append-sink.js for the six defenses.
const { appendSinkLine } = require("./append-sink.js");
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
/**
 * The LEGITIMATE containment roots for a learning-dir sink (loom#1349 R2 F1).
 *
 * `resolveLearningDir` deliberately resolves OUTSIDE cwd — to the MAIN checkout (a worktree's
 * `.claude/learning/` is auto-deleted, red-team CRIT-2) or to an explicit `KAILASH_LEARNING_DIR`.
 * Both are operator-declared locations, so both are named here. The learning dir ITSELF is
 * deliberately NOT a root: using it would make a symlinked `.claude/learning` self-contained and
 * silently re-open the escape the containment check exists to catch.
 */
function _stateRoots(cwd) {
  const roots = [];
  if (process.env.KAILASH_LEARNING_DIR) roots.push(process.env.KAILASH_LEARNING_DIR);
  // `requireMainCheckout`, NOT the legacy `resolveMainCheckout` — the THIRD instance of the idiom
  // shared with `coc-emit.js` and `coc-append.js`, both migrated by loom#1544. Migrating it here is
  // what `security.md` § Enforcement-Surface Parity requires: two of three IS the drift that rule
  // forbids, because one shared accessor is the only way three independent containment-root
  // surfaces cannot disagree about what an indeterminate git means.
  //
  // SCOPE, stated precisely because an earlier revision of this comment overstated it: what closes
  // here is the CONTAINMENT-ROOT class — the three sites that declare a root for a signed write.
  // It is NOT every legacy-resolver caller. `lib/codify-lease.js` (~L462, ~L567) still calls the
  // legacy accessor and is a DIFFERENT class: it GATES, feeding `isCoordinationEnabled(coordRoot)`,
  // so an indeterminate resolution can make the signed lease record be SKIPPED rather than merely
  // widen a fence. Fail-closed-vs-fail-open there is a behaviour decision with its own blast
  // radius, not the mechanical swap made here, so it is deliberately out of this change's scope and
  // carries a `LEGACY_ALLOWED` entry in `trust-resolver-fail-closed-1471.test.js` naming it
  // unfixed. The ledger, not this comment, is the authority on what remains.
  //
  // This file carried the SAME `LEGACY_ALLOWED` rationale the siblings shed — "learning-dir path
  // join, not an allow/deny decision" — and it was inaccurate in kind for the same reason: the
  // value feeds `additionalRoots` at the `logObservation` sink below, and a containment root IS an
  // allow/deny input. Its entry is removed in this change.
  //
  // INERT here, stated rather than glossed (`instrument-discipline.md` — do not let a migration
  // imply a live fix it did not make): the argument passed is `cwd`, and the sink's `repoDir` is
  // `cwd || process.cwd()`, so on an indeterminate resolution the legacy accessor returned its own
  // argument, which was ALREADY the primary root — it pushed a duplicate and widened nothing. What
  // the swap removes is the LATENT case (a future caller passing some other cwd), and it makes the
  // `catch` below deliver the fail-closed disposition it already claimed.
  //
  // `KAILASH_LEARNING_DIR` above is deliberately UNCHANGED: it is pushed raw as an
  // operator-declared location, a separate question from what an indeterminate git means.
  try {
    const { requireMainCheckout } = require(
      path.join(__dirname, "state-resolver.js"),
    );
    const r = requireMainCheckout(cwd);
    if (r.ok && r.repoDir) roots.push(r.repoDir);
  } catch {
    // Resolver unavailable — cwd remains the only root and a main-checkout sink fails CLOSED.
    // Same disposition as an INDETERMINATE resolution above: no root is added either way.
  }
  return roots;
}

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

    // loom#1349 R1 F3 — routed through the shared hardened primitive. This is the UN-ROSTERED
    // fallback row; the stamped path above already goes through appendStamped (itself routed).
    // A live exploit against this site escaped observations.jsonl at world-readable 0o644.
    //
    // R2 F1 — `resolveLearningDir` resolves to the MAIN checkout (or an explicit
    // `KAILASH_LEARNING_DIR`), so this sink escapes cwd BY DESIGN and containing against cwd alone
    // would refuse it in every worktree session. Both legitimate roots are declared; a genuine
    // escape (a symlinked `.claude/learning`) still resolves under neither and is refused.
    const w = appendSinkLine({
      repoDir: cwd || process.cwd(),
      additionalRoots: _stateRoots(cwd),
      sinkPath: observationsFile,
      line: JSON.stringify(observation),
    });
    if (!w.ok) return null;
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
