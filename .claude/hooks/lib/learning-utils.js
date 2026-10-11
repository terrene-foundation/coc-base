/**
 * Shared utility: Per-project learning directory resolution and observation logging.
 *
 * Used by all hooks and learning scripts to ensure observations are stored
 * per-project (in <project>/.claude/learning/) rather than globally.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// loom#1349 — the ONE hardened append primitive; see append-sink.js for the six defenses.
const { appendSinkLine, mainCheckoutBoundaryRoots } = require("./append-sink.js");
const os = require("os");

// ── Rotation: the LIVE observations file is bounded; no byte is ever lost ────
//
// RETENTION RULE (documented here because it is this module's contract):
//   · The live `observations.jsonl` is bounded at MAX_LIVE_OBSERVATION_BYTES.
//     When an append would land on a file at/over the bound, the WHOLE live
//     file is RENAMED — atomically, bytes verbatim — into
//     `observations.archive/observations_<epoch>_<nonce>.jsonl` before the
//     append, and the append starts a fresh live file. The newest records are
//     therefore always in the live file; every older byte stays on disk.
//   · Nothing is ever truncated or rewritten in place: rename preserves the
//     `signed bytes == disk bytes` property `knowledge-convergence.md` MUST-6
//     rests on (a truncate-after-signing would leave rows whose signature no
//     longer verifies). The append-log's own refuse-on-overflow contract for
//     an individual RECORD (`coc-append.js::MAX_LINE_BYTES`) is untouched.
//   · Archive files are NEVER deleted by this module — retained history is the
//     point of the archive. Readers union the archive: `codify-backlog.mjs`
//     (`jsonlSince`) and `scripts/learning/observation-logger.js` (`getStats`)
//     both read live + archive; `learning-digest.js` reads the live file under
//     a 16 MiB ceiling, which is WHY the bound below sits at half that: a
//     35.6 MB live file (measured 2026-10-09) could not be read at all
//     (`readLearningFile` refuses > 16 MiB), so the digest of the whole corpus
//     silently failed until the bound existed.
//   · WHY BYTES AND NOT A RECORD COUNT: `scripts/learning/observation-logger.js`
//     rotates at 500 records, but that path reads the entire file to count —
//     O(file) per append, which the hooks' per-event path cannot afford. This
//     module writes on nearly every hook event, so the bound is a statSync
//     (O(1)). Both rotate into the same archive directory in the same naming
//     shape, so the readers see one coherent store.
const MAX_LIVE_OBSERVATION_BYTES = 8 * 1024 * 1024;

/**
 * Rotate the live observations file into the archive when it is at/over the
 * bound. Best-effort by design: a rotation failure must never lose the
 * observation the caller is about to append, so the caller appends into the
 * existing file and the NEXT append retries (the condition persists).
 *
 * @returns {{rotated:true, dest:string} | {rotated:false, error?:string}}
 */
function rotateObservationsIfNeeded(learningDir, observationsFile) {
  let size;
  try {
    size = fs.statSync(observationsFile).size;
  } catch {
    return { rotated: false }; // absent (first write) or unreadable — nothing to move
  }
  if (size < MAX_LIVE_OBSERVATION_BYTES) return { rotated: false };
  // Re-stat immediately before the rename: a concurrent writer that rotated
  // first leaves a fresh EMPTY file here, and renaming THAT would put an empty
  // entry in the archive (harmless but wrong) — this is the only race window,
  // and it is re-checked rather than assumed.
  try {
    size = fs.statSync(observationsFile).size;
  } catch {
    return { rotated: false };
  }
  if (size < MAX_LIVE_OBSERVATION_BYTES) return { rotated: false };

  const archiveDir = path.join(learningDir, "observations.archive");
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
  } catch {
    // Already created by ensureLearningDir; a failure here surfaces on rename.
  }
  // Same naming shape as `scripts/learning/observation-logger.js` so both
  // rotation paths produce one readable archive family.
  const dest = path.join(
    archiveDir,
    `observations_${Date.now()}_${crypto.randomBytes(12).toString("hex")}.jsonl`,
  );
  try {
    fs.renameSync(observationsFile, dest); // atomic; every byte moves intact
  } catch (err) {
    return { rotated: false, error: err && err.code ? err.code : String(err) };
  }
  // Recreate an empty live file immediately so a reader never observes the
  // file MISSING (only momentarily empty). Losing this race to a concurrent
  // appender is fine: O_EXCL, and the appender's own write already created it.
  try {
    const fd = fs.openSync(
      observationsFile,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.closeSync(fd);
  } catch {
    // EEXIST = a concurrent writer already recreated it; any other cause
    // surfaces as an append failure with the caller's own typed error.
  }
  return { rotated: true, dest };
}

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
  // Delegated to the ONE derivation in append-sink.js. This was the THIRD
  // open-coded copy of the idiom (the comment above recorded that as it happened);
  // six further callers omitted it entirely, which is what broke /codify from a
  // worktree. Same fail-closed disposition: [] when the resolver cannot answer.
  roots.push(...mainCheckoutBoundaryRoots(cwd));
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

    // Bound the live file BEFORE the append (see the retention rule above):
    // rotation is a rename, so the incoming record lands in a fresh file and
    // every already-written byte — signatures included — stays on disk.
    const rot = rotateObservationsIfNeeded(learningDir, observationsFile);
    if (rot.error) {
      // Loud, not silent: the file is unbounded until a later append rotates
      // it, and a reader that hits its own ceiling would otherwise fail with
      // nothing in the log saying why.
      process.stderr.write(
        `[learning] observations rotation failed (${rot.error}); the live file stays over ${MAX_LIVE_OBSERVATION_BYTES}B and the append proceeds\n`,
      );
    }

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
  rotateObservationsIfNeeded,
  // Exported so a fixture seeds the file against the SAME bound the writer
  // rotates on (a hardcoded copy could drift and the bound test would pass
  // while measuring nothing).
  MAX_LIVE_OBSERVATION_BYTES,
};
