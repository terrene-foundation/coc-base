/**
 * state-io — atomic appends + corrupt-JSON-resilient reads for trust-posture state.
 *
 * Mitigates red-team CRIT-3 (posture self-modification — defense-in-depth via shape check),
 *   CRIT-4 (fail-open on missing/corrupt → fail-closed to L1),
 *   HIGH-6 (concurrent worktree races → flock + size-bound + write-ahead bak).
 *
 * F42 (2026-05-26): readPosture is the canonical SSOT reader for posture state
 * and always returns a v2-shape object per `posture-v2.js`. On-disk v1 inputs
 * are auto-migrated at read time via `migrateV1ToV2`. Legacy v1-shape fields
 * (`posture`, `since`, `transition_history`, `pending_verification`,
 * `violation_window_30d`) are preserved on the return value so the four
 * legacy consumers (posture-gate, detect-violations, session-start, the
 * local readPosture in multi-operator-sessionstart) keep working unchanged.
 * v2 consumers (`computeOperativePosture`, gate-matrix) consume the v2-shape
 * fields (`schema_version`, `repo_floor`, `operators`).
 *
 * Per `rules/multi-operator-coordination.md` § "MUST NOT — Edit
 * .claude/learning/posture.json directly via the file-edit tools": this
 * module is the ONLY legitimate reader; writes still flow through
 * `fold-posture-event.js` + `writePosture`.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const {
  resolveStateDir,
  ensureStateDir,
  resolveMainCheckout,
} = require("./state-resolver");
const {
  validatePostureV2Schema,
  migrateV1ToV2,
  discriminateState,
} = require("./posture-v2");

const POSTURE_FILE = "posture.json";
const POSTURE_BAK = "posture.json.bak";
const VIOLATIONS_FILE = "violations.jsonl";
const COORDINATION_LOG_FILE = "coordination-log.jsonl";
// F52 (2026-05-26): clone-init witness file name. F50 Phase 2 landed the
// witness inside `.claude/learning/` next to posture.json — a placement that
// satisfies the 3-file-nuke (`rm posture.json posture.json.bak .initialized`)
// adversary but NOT the 4-file/directory-sweep adversary (`rm -rf
// .claude/learning/*`) named in Wave2-R2 NEW-3. F52 relocates the witness OUT
// of `.claude/learning/` to a separate-location sentinel (canonical:
// `<repoRoot>/.git/coc-clone-init-witness`); the legacy in-`.claude/learning/`
// location below is retained ONLY as the migration source path for
// `migrateWitnessIfPresent`. Resolver: `resolveWitnessPath(repoDir)`.
const CLONE_INIT_WITNESS_FILE = "coc-clone-init-witness";
const LEGACY_CLONE_INIT_WITNESS_FILE = ".coc-clone-init-witness";
const INITIALIZED_MARKER = ".initialized";
const MAX_LINE_BYTES = 2048; // mitigates CRIT atomicity (POSIX append < PIPE_BUF=4096)

const L1 = "L1_PSEUDO_AGENT";
const VALID_POSTURES = new Set([
  "L1_PSEUDO_AGENT",
  "L2_SUPERVISED",
  "L3_SHARED_PLANNING",
  "L4_CONTINUOUS_INSIGHT",
  "L5_DELEGATED",
]);

function newId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Detect whether an on-disk posture object is v2 (schema_version === 2) or v1.
 * Anything else is undefined-shape; caller decides the fail-closed path.
 */
function _isV2Shape(obj) {
  return (
    obj &&
    typeof obj === "object" &&
    obj.schema_version === 2 &&
    obj.repo_floor &&
    typeof obj.repo_floor === "object"
  );
}

function _isV1Shape(obj) {
  return (
    obj &&
    typeof obj === "object" &&
    obj.schema_version === undefined &&
    typeof obj.posture === "string" &&
    VALID_POSTURES.has(obj.posture)
  );
}

// ---- F52: clone-init witness separate-location sentinel ---------------------
//
// Per `rules/multi-operator-coordination.md` § Origin "Open follow-up forest
// items" — F52 acceptance: the witness MUST resolve OUTSIDE `.claude/learning/`
// so a directory-sweep adversary (`rm -rf .claude/learning/*`) cannot defeat
// the discriminator in the same invocation. Canonical target:
// `<repoRoot>/.git/coc-clone-init-witness` (sibling to `.claude/`, present in
// every clone, scoped per-clone — `.git/` is per-clone state, not shared via
// remote push; survives any nuke targeting `.claude/*`).
//
// Test sandboxes have no `.git/` directory; the resolver falls back to a
// sibling-of-`.claude/` location (`<repoRoot>/.coc-clone-init-witness`). The
// fallback is also separate-location for the threat model (NOT under
// `.claude/learning/`) so the 4-file-nuke / directory-sweep adversary is
// defeated in both production and test contexts.
//
// Per `rules/security.md` § "No eval() on user input" + `verify-resource-existence.md`
// MUST-2 live-API discipline: `git rev-parse --git-common-dir` runs via
// `execFileSync` with an arg-array (no shell expansion); failure modes return
// a typed `{ ok: false, reason }` from the helper or fall back structurally.

/**
 * Resolve the on-disk path of the clone-init witness file for `repoDir`.
 *
 * Resolution order (per `verify-resource-existence.md` MUST-2 — live-runtime
 * resource check, NOT documentation-based):
 *   1. CLAUDE_TRUST_STATE_DIR set + sandbox path → sandbox sibling
 *      `<repoRoot>/.coc-clone-init-witness` where `<repoRoot>` is the
 *      directory two levels above the state dir (i.e., parent of `.claude/`).
 *      This is the test-sandbox path — sandboxes have no `.git/`.
 *   2. `git rev-parse --git-common-dir` succeeds → canonical
 *      `<git-common-dir>/coc-clone-init-witness`. `--git-common-dir` returns
 *      the MAIN repo's `.git/` for both linked worktrees and the main checkout
 *      (worktree-specific git-dir is at `.git/worktrees/<name>/`; the COMMON
 *      dir is the shared `.git/` — that is the per-clone witness location).
 *   3. Fallback: `<repoDir>/.git/coc-clone-init-witness` literal join.
 *
 * Per `zero-tolerance.md` Rule 3 (no silent fallbacks): the function returns a
 * structurally-valid path in every case; failure modes are logged as
 * resolver-source metadata on the return shape so the caller can audit.
 *
 * @param {string} repoDir - repository root (main checkout, NOT a worktree).
 * @returns {{ok: true, value: string, source: string} | {ok: false, reason: string}}
 */
function resolveWitnessPath(repoDir) {
  if (typeof repoDir !== "string" || !repoDir) {
    return {
      ok: false,
      reason: "resolveWitnessPath: repoDir must be a non-empty string",
    };
  }

  // 1. Test-sandbox path: when CLAUDE_TRUST_STATE_DIR is set, the witness
  //    location is derivable from the sandbox layout WITHOUT touching git.
  //    The state dir is `<sandbox>/.claude/learning/`; the witness goes at
  //    `<sandbox>/.coc-clone-init-witness` (sibling of `.claude/`, NOT inside).
  if (process.env.CLAUDE_TRUST_STATE_DIR) {
    const stateDir = process.env.CLAUDE_TRUST_STATE_DIR;
    // Walk up: stateDir → parent (`.claude/`) → parent (sandbox root).
    const sandboxRoot = path.dirname(path.dirname(stateDir));
    return {
      ok: true,
      value: path.join(sandboxRoot, "." + CLONE_INIT_WITNESS_FILE),
      source: "test-sandbox-sibling",
    };
  }

  // 2. Production path: live-API query against git for the main `.git/` dir.
  //    `--git-common-dir` is the worktree-aware primitive (returns the MAIN
  //    repo's git-dir even when invoked inside a linked worktree).
  try {
    const gitCommonDir = execFileSync(
      "git",
      ["rev-parse", "--git-common-dir"],
      {
        cwd: repoDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (gitCommonDir) {
      // `--git-common-dir` may return a relative path (e.g. `.git`) — resolve
      // against repoDir to get an absolute path.
      const absGitDir = path.isAbsolute(gitCommonDir)
        ? gitCommonDir
        : path.join(repoDir, gitCommonDir);
      return {
        ok: true,
        value: path.join(absGitDir, CLONE_INIT_WITNESS_FILE),
        source: "git-common-dir",
      };
    }
  } catch {
    // git unavailable / repoDir not a git repo — fall through to literal join
  }

  // 3. Fallback when git lookup fails: literal `<repoDir>/.git/`. This is
  //    correct for a standard non-worktree repo and reduces to a structural
  //    no-op when the repo is uninitialized (read returns ENOENT, which the
  //    caller already handles by treating witness-absent as "not yet
  //    recorded").
  return {
    ok: true,
    value: path.join(repoDir, ".git", CLONE_INIT_WITNESS_FILE),
    source: "git-dir-fallback",
  };
}

/**
 * Migrate an existing clone-init witness from the legacy in-`.claude/learning/`
 * location to the F52 separate-location sentinel.
 *
 * Idempotent: safe to call on every read path. No-ops when the legacy file is
 * absent OR the new location already exists.
 *
 * Atomic per `knowledge-convergence.md` MUST-6: writes via `.tmp` + `rename` +
 * `fsync` + mode 0o600. The legacy file is unlinked ONLY after the new write
 * has been fsynced AND the rename has settled — partial-failure mode is
 * "witness present at both locations" (read prefers the new location, so the
 * legacy copy is harmless until the next migration call cleans it up).
 *
 * @param {string} repoDir - repository root (main checkout).
 * @returns {{ok: true, migrated: boolean, reason?: string} | {ok: false, reason: string}}
 */
function migrateWitnessIfPresent(repoDir) {
  const dir = (() => {
    try {
      return resolveStateDir(repoDir);
    } catch (e) {
      return null;
    }
  })();
  if (!dir) {
    return {
      ok: false,
      reason: "migrateWitnessIfPresent: cannot resolve state dir",
    };
  }

  const legacy = path.join(dir, LEGACY_CLONE_INIT_WITNESS_FILE);
  if (!fs.existsSync(legacy)) {
    return { ok: true, migrated: false, reason: "no legacy witness present" };
  }

  const target = resolveWitnessPath(repoDir);
  if (!target.ok) {
    return { ok: false, reason: `migrate: ${target.reason}` };
  }
  const newPath = target.value;

  // New location already has a witness — legacy copy is stale. Remove legacy
  // only after confirming the new location is non-empty (defense against
  // truncate-and-unlink that would lose the witness entirely).
  if (fs.existsSync(newPath)) {
    try {
      const stat = fs.statSync(newPath);
      if (stat.size > 0) {
        try {
          fs.unlinkSync(legacy);
        } catch (e) {
          return {
            ok: false,
            reason: `migrate: failed to unlink stale legacy: ${e.message}`,
          };
        }
        return {
          ok: true,
          migrated: true,
          reason: "new location already had witness; legacy unlinked",
        };
      }
    } catch (e) {
      return { ok: false, reason: `migrate: stat new location: ${e.message}` };
    }
  }

  // Read legacy content. Witness files are small (typically a UTC timestamp
  // or short JSON) — single readFileSync is safe.
  let content;
  try {
    content = fs.readFileSync(legacy);
  } catch (e) {
    return { ok: false, reason: `migrate: read legacy: ${e.message}` };
  }

  // Atomic write: ensure parent dir exists, write .tmp, fsync, rename, then
  // unlink legacy. Mode 0o600 — witness is per-clone trust-anchor metadata;
  // not secret per se, but tight permissions match the rest of the state-io
  // contract.
  const parent = path.dirname(newPath);
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (e) {
    return { ok: false, reason: `migrate: mkdir parent: ${e.message}` };
  }

  const tmp = `${newPath}.tmp.${process.pid}`;
  // F53 (a): O_NOFOLLOW defeats a symlink-redirect attack. If a bounded-trust
  // adversary pre-plants a symlink at the tmp path, "w" semantics would FOLLOW
  // the link and write the witness through the attacker's sink; O_NOFOLLOW
  // makes openSync raise ELOOP on the final component instead. "w" decomposes
  // to O_WRONLY|O_CREAT|O_TRUNC; O_NOFOLLOW is ORed in. O_NOFOLLOW is POSIX
  // (defined on darwin + linux); the `|| 0` guard degrades to plain "w"
  // behavior on platforms lacking it (e.g. Windows) rather than NaN-poisoning
  // the bitmask. mode 0o600 still applies via O_CREAT.
  const tmpFlags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_TRUNC |
    (fs.constants.O_NOFOLLOW || 0);
  // F53: surface whether O_NOFOLLOW was actually applied. On darwin/linux it is
  // always present; on a platform lacking it (Windows) the `|| 0` guard silently
  // drops the symlink protection — `nofollow_supported: false` on the return
  // shape makes that degraded-security path observable per `observability.md`
  // rather than silently weakening the write with no signal.
  const nofollowSupported = (fs.constants.O_NOFOLLOW || 0) !== 0;
  let fd;
  try {
    fd = fs.openSync(tmp, tmpFlags, 0o600);
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } catch (e) {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return { ok: false, reason: `migrate: write tmp: ${e.message}` };
  }
  try {
    fs.closeSync(fd);
  } catch (e) {
    return { ok: false, reason: `migrate: close tmp: ${e.message}` };
  }

  try {
    fs.renameSync(tmp, newPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return { ok: false, reason: `migrate: rename: ${e.message}` };
  }

  // F53 (b): fsync the parent directory so the rename is durably visible
  // across crash-recovery. This MUST happen BEFORE unlinking the legacy copy
  // so the crash-window invariant holds: at any crash point the witness is
  // present at `legacy` OR durably at `newPath` — never neither. Without it, a
  // crash after renameSync but before the legacy unlink could leave newPath's
  // directory entry unflushed while the legacy copy is already gone. fsyncing
  // `parent` (= dirname(newPath), the dir the tmp+rename happened in) flushes
  // the rename. Best-effort: directory fds cannot be fsynced on every platform
  // (Windows raises EISDIR/EPERM); a failure here does NOT undo the
  // functionally-complete rename, so it surfaces structurally as
  // `parent_dir_synced: false` per `zero-tolerance.md` Rule 3 (observable, not
  // a silent swallow) rather than failing the migration.
  let parentDirSynced = true;
  try {
    const dirFd = fs.openSync(parent, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    parentDirSynced = false;
  }

  // Only after the new location is durably present do we unlink the legacy
  // copy. A failure here leaves the witness at BOTH locations — the read path
  // prefers the new location, so this is a recoverable no-op (next call
  // retries the unlink).
  try {
    fs.unlinkSync(legacy);
  } catch (e) {
    return {
      ok: false,
      reason: `migrate: unlink legacy after rename: ${e.message}`,
    };
  }

  return {
    ok: true,
    migrated: true,
    reason: "witness relocated",
    parent_dir_synced: parentDirSynced,
    nofollow_supported: nofollowSupported,
  };
}

/**
 * Compose a v2-shape posture that ALSO carries the legacy v1-shape top-level
 * `posture` / `since` / `pending_verification` / `violation_window_30d` /
 * `transition_history` fields so legacy consumers continue working unchanged.
 * The v1-shape `posture` field surfaces the repo_floor posture — which IS the
 * sole authority at v1 — so a legacy consumer reading `obj.posture` sees the
 * SAME semantics it always saw on a v1 file. Multi-operator consumers ignore
 * the legacy fields and route through `computeOperativePosture(obj, pid)`.
 */
function _composeLegacyFacets(v2) {
  const floor =
    v2.repo_floor && v2.repo_floor.posture
      ? v2.repo_floor.posture
      : "L5_DELEGATED";
  return {
    // ---- v2-canonical fields -------------------------------------------
    schema_version: 2,
    repo_floor: v2.repo_floor,
    operators: v2.operators || {},
    trust_root: v2.trust_root || null,
    _initialized: v2._initialized === true,
    transition_history: Array.isArray(v2.transition_history)
      ? v2.transition_history
      : [],
    // ---- v1-legacy facets (read-only mirrors) --------------------------
    // Legacy consumers read `obj.posture` as the repo-wide authority;
    // surface repo_floor so semantics hold.
    posture: floor,
    since:
      v2.repo_floor && v2.repo_floor.since
        ? v2.repo_floor.since
        : new Date().toISOString(),
    pending_verification: Array.isArray(v2.pending_verification)
      ? v2.pending_verification
      : [],
    violation_window_30d:
      v2.violation_window_30d && typeof v2.violation_window_30d === "object"
        ? v2.violation_window_30d
        : {},
  };
}

function failClosedPosture(reason) {
  // F42: fail-closed result is v2-shaped (schema_version: 2, repo_floor at L1)
  // AND carries the legacy v1 facets so existing consumers see the same
  // `posture: L1`, `_fail_closed: true`, `transition_history` they always saw.
  const now = new Date().toISOString();
  const v2 = {
    schema_version: 2,
    repo_floor: {
      posture: L1,
      since: now,
      set_by: "system-fail-closed",
    },
    operators: {},
    transition_history: [
      {
        from: null,
        to: L1,
        type: "FAIL_CLOSED",
        reason,
        ts: now,
      },
    ],
    pending_verification: [],
    violation_window_30d: {},
    _initialized: true,
  };
  const facets = _composeLegacyFacets(v2);
  facets._fail_closed = true;
  return facets;
}

/**
 * Build a fresh-repo v2 posture: floor L5_DELEGATED, no operators yet, no
 * init marker. Per `rules/trust-posture.md` MUST Rule 2 and architecture
 * §6.1: missing `posture.json` AND missing `.initialized` marker → fresh
 * repo → L5 default.
 */
function _freshRepoPosture() {
  const now = new Date().toISOString();
  const v2 = {
    schema_version: 2,
    repo_floor: {
      posture: "L5_DELEGATED",
      since: now,
      set_by: "system-fresh-repo",
    },
    operators: {},
    transition_history: [],
    pending_verification: [],
    violation_window_30d: {},
    _initialized: false,
  };
  const facets = _composeLegacyFacets(v2);
  facets._fresh = true;
  return facets;
}

/**
 * Read posture.json. On missing / corrupt → fail-closed to L1 (mitigates CRIT-4).
 * Tries main file first, then .bak, then fail-closed.
 *
 * F42: always returns v2-shape (schema_version: 2 + repo_floor + operators)
 * with v1-legacy fields mirrored for back-compat. v1-on-disk inputs are
 * migrated through `migrateV1ToV2` at read time. Per
 * `rules/knowledge-convergence.md` MUST-6 + `rules/trust-posture.md` MUST NOT:
 * this is a READ helper — it never writes the migration back to disk. The
 * canonical writer (`fold-posture-event.js` driving the on-disk state) is
 * responsible for landing v2 on disk through a signed posture-event.
 */
function readPosture(cwd) {
  const dir = resolveStateDir(cwd);
  const main = path.join(dir, POSTURE_FILE);
  const bak = path.join(dir, POSTURE_BAK);

  // F52: migrate legacy in-`.claude/learning/.coc-clone-init-witness` to the
  // separate-location sentinel BEFORE any read consults the witness via
  // discriminateState below. Idempotent — safe to call on every read; no-ops
  // when the legacy file is absent. Surfaced as best-effort: a migration
  // failure does NOT block the read (the witness check defaults to "absent"
  // which is the safe disposition for the read path).
  const repoRoot = resolveMainCheckout(cwd);
  try {
    migrateWitnessIfPresent(repoRoot);
  } catch {
    // Best-effort migration; readPosture continues regardless. The next
    // session-start invocation will retry. A persistent failure surfaces as
    // a witness-absent discriminator result on the new location, which is
    // the structurally-correct disposition (fresh-clone vs corrupt-L1
    // distinction is then made by .initialized + log presence).
  }

  for (const p of [main, bak]) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") continue;

      // v2-shape on disk: validate structurally, then compose legacy facets.
      if (_isV2Shape(obj)) {
        const v = validatePostureV2Schema(obj);
        if (!v.valid) continue; // try .bak or fail-closed
        return _composeLegacyFacets(obj);
      }
      // v1-shape on disk: migrate to v2 at read time, then compose facets.
      // Migration is in-memory only — we do NOT write v2 back here per
      // canonical-writer discipline. The next signed posture-event lands v2.
      if (_isV1Shape(obj)) {
        try {
          const v2 = migrateV1ToV2(obj);
          // Preserve any v1 fields the migration does not carry through
          // (pending_verification + violation_window_30d are v1-specific
          // operational state used by detect-violations.js + session-start.js).
          if (Array.isArray(obj.pending_verification)) {
            v2.pending_verification = obj.pending_verification;
          }
          if (
            obj.violation_window_30d &&
            typeof obj.violation_window_30d === "object"
          ) {
            v2.violation_window_30d = obj.violation_window_30d;
          }
          return _composeLegacyFacets(v2);
        } catch {
          continue;
        }
      }
      // Unknown shape → try next candidate (.bak), else fail-closed below.
    } catch {
      continue;
    }
  }

  // Both posture.json and .bak unreadable. Defense-in-depth disposition:
  //   1. Consult discriminateState() for adversarial signals the
  //      marker-only check cannot see (HIGH-1, 2026-05-26): clone-init
  //      witness survives while .initialized is absent ⇒ coordinated
  //      state deletion; OR marker + witness present but log nuked
  //      ⇒ post-init state damage; OR explicit fold/ref-regression flags.
  //      All five corrupt-L1 sub-dispositions fail-close immediately.
  //   2. ELSE preserve legacy marker-only semantics (trust-posture.md MUST-2
  //      + CRIT-4 mitigation): marker presence WITHOUT a clean posture.json
  //      is corruption; marker absence is fresh repo. Fresh-clone-L2 +
  //      use-cache + refold dispositions all collapse here until the
  //      witness + fold-integrity mechanisms are operator-wired (post-F19).
  const initMarkerPath = path.join(dir, INITIALIZED_MARKER);
  // F52: the clone-init witness now resolves to a separate-location sentinel
  // OUTSIDE `.claude/learning/` — a directory-sweep adversary (`rm -rf
  // .claude/learning/*`) cannot defeat the witness, so the discriminator
  // correctly distinguishes 4-file-nuke (corrupt-L1 fail-closed) from
  // pristine fresh repo (fresh-repo-L5).
  const witnessResolution = resolveWitnessPath(repoRoot);
  const witnessPath = witnessResolution.ok ? witnessResolution.value : null;
  const logPath = path.join(dir, COORDINATION_LOG_FILE);
  const disposition = discriminateState({
    postureCachePath: main,
    logPath,
    initializedMarkerPath: initMarkerPath,
    cloneInitWitnessPath: witnessPath,
  });

  if (disposition.disposition === "corrupt-L1") {
    return failClosedPosture(disposition.reason);
  }

  // Legacy marker-only fall-back (CRIT-4 mitigation, unchanged behavior).
  if (!fs.existsSync(initMarkerPath)) {
    return _freshRepoPosture();
  }
  return failClosedPosture(
    "posture.json missing or corrupt; both main and bak unreadable",
  );
}

/**
 * Write posture.json with write-ahead .bak (mitigates HIGH-6 corrupt-on-crash).
 * Caller is responsible for flock if multiple writers; for the POC we use mtime check.
 */
function writePosture(cwd, posture) {
  if (!VALID_POSTURES.has(posture.posture)) {
    throw new Error(`Invalid posture: ${posture.posture}`);
  }
  const dir = ensureStateDir(cwd);
  const main = path.join(dir, POSTURE_FILE);
  const bak = path.join(dir, POSTURE_BAK);
  const tmp = path.join(dir, `posture.json.tmp.${process.pid}`);

  // 1. Copy current main → bak (write-ahead)
  if (fs.existsSync(main)) {
    fs.copyFileSync(main, bak);
  }
  // 2. Write tmp; rename atomic
  fs.writeFileSync(tmp, JSON.stringify(posture, null, 2));
  fs.renameSync(tmp, main);

  // 3. Touch init marker
  const initMarker = path.join(dir, ".initialized");
  if (!fs.existsSync(initMarker))
    fs.writeFileSync(initMarker, new Date().toISOString());
}

/**
 * Strip the absolute-home prefix from a repo path so the `repo` field
 * records only the repo basename (e.g. `loom`, not `/Users/<login>/repos/loom`).
 * M9.1 R3 Sec-R3-S-01: absolute paths under `/Users/<login>/` and `/home/<login>/`
 * are PII (operator username leak) per `security.md` § "No secrets in logs"
 * + `user-flow-validation.md` MUST-6. Per `zero-tolerance.md` Rule 1a
 * scanner-surface symmetry, the row was leaked regardless of when it
 * entered; this strip applies at the write boundary going forward.
 */
function _stripRepoPath(p) {
  if (typeof p !== "string" || !p) return "unknown";
  // Trailing-slash basename: works for `/Users/x/repos/loom`,
  // `/home/x/repos/loom`, `/repos/loom`, `C:\\Users\\x\\repos\\loom`,
  // and relative paths alike.
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) || "unknown" : p;
}

/**
 * Append a violation. Single-line JSON, ≤2KB, atomic O_APPEND (mitigates HIGH-6 race).
 */
function appendViolation(cwd, partial) {
  const dir = ensureStateDir(cwd);
  const file = path.join(dir, VIOLATIONS_FILE);

  const violation = {
    id: newId("vio"),
    timestamp: new Date().toISOString(),
    session_id: process.env.CLAUDE_SESSION_ID || "unknown",
    repo: _stripRepoPath(cwd || process.cwd()),
    ...partial,
  };

  let line = JSON.stringify(violation);
  if (line.length > MAX_LINE_BYTES) {
    // Truncate evidence field to keep line < 2KB (POSIX atomic-append safety)
    const evidence = String(violation.evidence || "");
    const overflow = line.length - MAX_LINE_BYTES + 32;
    violation.evidence =
      evidence.slice(0, Math.max(0, evidence.length - overflow)) + "…[trunc]";
    violation._truncated = true;
    line = JSON.stringify(violation);
  }

  // O_APPEND atomic for writes < PIPE_BUF (4096); we're capped at 2048
  fs.appendFileSync(file, line + "\n");
  return violation.id;
}

/**
 * Read recent violations within a window (mitigates MED-4 unbounded growth — caller filters).
 */
function readRecentViolations(cwd, { sinceTs, limit = 1000 } = {}) {
  const dir = resolveStateDir(cwd);
  const file = path.join(dir, VIOLATIONS_FILE);
  if (!fs.existsSync(file)) return [];

  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (sinceTs && obj.timestamp < sinceTs) continue;
      out.push(obj);
    } catch {
      // skip corrupt line, continue
    }
  }
  return out.reverse();
}

/**
 * Resolve the canonical on-disk path of the multi-operator coordination
 * log for `repoDir`. The log lives at:
 *
 *   <repoDir>/.claude/learning/coordination-log.jsonl
 *
 * Consumers (the filesystem transport in `transport-filesystem.js`, the
 * sessionstart hook, the /claim command, future audit tooling) MUST
 * route through this helper rather than hardcoding the path. Centralising
 * the binding keeps the storage layout in one place — the same
 * single-source-of-truth discipline `resolveStateDir` provides for
 * posture / violations state.
 *
 * @param {string} repoDir - absolute path to the repo root
 * @returns {string} absolute path to the coordination log file
 */
function resolveLogPath(repoDir) {
  const dir = resolveStateDir(repoDir);
  return path.join(dir, COORDINATION_LOG_FILE);
}

module.exports = {
  readPosture,
  writePosture,
  appendViolation,
  readRecentViolations,
  failClosedPosture,
  resolveLogPath,
  // M9.1 R4 Sec-R4-S-01 — exported so `coc-append.js::appendStamped` and
  // `learning-utils.js::logObservation` can route their `repo`/`cwd`
  // field through the same single-source-of-truth strip helper per
  // `security.md` § Multi-Site Kwarg Plumbing (one helper, every caller
  // routes through it; siblings cannot drift).
  stripRepoPath: _stripRepoPath,
  // F52 (2026-05-26): expose the witness resolver + migration helper so the
  // session-start hook, the clone-init writer (when wired post-F19), and
  // future audit tooling can route through the single SSOT for witness
  // location. Per `security.md` § Multi-Site Kwarg Plumbing — one helper,
  // every caller routes through it.
  resolveWitnessPath,
  migrateWitnessIfPresent,
  VALID_POSTURES,
  MAX_LINE_BYTES,
  COORDINATION_LOG_FILE,
  CLONE_INIT_WITNESS_FILE,
  LEGACY_CLONE_INIT_WITNESS_FILE,
};
