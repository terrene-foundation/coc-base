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
// The record separator every appender writes after the JSON. Named because the cap
// above governs the ON-DISK line, and the on-disk line INCLUDES this byte — sizing
// the JSON alone silently permits a MAX_LINE_BYTES+1 write.
const NEWLINE_BYTES = 1;

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

// ---- loom#1338: hardened file-IO primitives (single writer, single reader) ---
//
// EVERY durable write in this module routes through `_writeFileHardened` and
// EVERY read of an attacker-plantable state path routes through
// `_readFileHardened`. The one-helper discipline is `security.md` § "Multi-Site
// Kwarg Plumbing" applied to the open(2) flag set: before loom#1338 this file
// carried the hardened pattern inline in `migrateWitnessIfPresent` (F53 (a))
// and the plain `fs.writeFileSync` pattern in `writePosture` ~350 lines later —
// the documented fix sitting beside the vulnerability its own comment names.
// Centralising the flags is what stops that asymmetry recurring.
//
// Threat model: the bounded-trust adversary of
// `rules/multi-operator-coordination.md` — a team member with repo write access
// seeking privilege escalation. They can create directory entries inside
// `.claude/learning/` WITHOUT passing the agent's Write tool, so the
// `permissions.deny` + posture-gate / integrity-guard file-tool fences never
// see it; the open(2) flag set is the enforcement boundary.
//
// Vectors closed at the FINAL path component:
//   1. SYMLINK — `O_NOFOLLOW` raises ELOOP instead of writing through an
//      attacker's link. Reads add `O_NONBLOCK` so a FIFO planted at the path
//      cannot wedge a hook in a blocking open(2).
//   2. PRE-PLANTED ENTRY / HARD LINK — a hard link is indistinguishable from a
//      regular file to open(2), so `O_NOFOLLOW` alone does NOT close it: an
//      `lstat` classification refuses any non-regular entry and any `nlink > 1`
//      regular file, and `O_CREAT|O_EXCL` fails closed if the entry is
//      (re-)planted inside the lstat→open window.
//   3. PERMISSIONS — `0o600` at create plus `fchmod` on the HELD fd, so the
//      mode is exact rather than umask-dependent.
//
// ANCESTOR components are covered separately by `_assertStateDirContained`,
// NOT by the flags above — `O_NOFOLLOW` is final-component-only. A single
// static `ln -s /attacker <repo>/.claude/learning` needs no race window at all
// and redirects every path in this module; the containment check below is what
// closes it (`security.md` § "Path Containment": resolve BOTH candidate and
// boundary root through the SAME resolver).
//
// Still NOT closed, by construction: the RACING variant — an ancestor swapped
// between the containment check and the open. That needs `O_DIRECTORY`/`openat`
// -relative traversal per component, which Node does not expose synchronously
// (`skills/18-security-patterns/path-containment.md` § TOCTOU-at-sink). The
// static variant is fixed; only the race remains.

/**
 * Assert that no ancestor component of the resolved state dir is a symlink —
 * i.e. that the directory the caller is about to read/write really is the one
 * its path names.
 *
 * `O_NOFOLLOW` guards only the FINAL component, so a single static
 * `ln -s /attacker <repo>/.claude/learning` silently relocates every posture,
 * violation and marker path with no race window whatsoever. Per
 * `security.md` § "Path Containment", BOTH sides go through the SAME resolver:
 * the anchor (two levels up — the repo root, or the sandbox root under
 * `CLAUDE_TRUST_STATE_DIR`) is realpath'd and the two known components are
 * re-joined, then compared against the realpath of the state dir itself. Only
 * components AT/BELOW the anchor are constrained, so a legitimately symlinked
 * ancestor above it (macOS `/var` → `/private/var`, a symlinked home or repo
 * checkout) resolves identically on both sides and is not a false positive.
 *
 * Fails CLOSED: if either side will not resolve, the caller is refused.
 *
 * @param {string} dir - the resolved state dir
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
function _assertStateDirContained(dir) {
  const anchor = path.dirname(path.dirname(dir));
  let realAnchor;
  let realDir;
  try {
    realAnchor = fs.realpathSync(anchor);
    realDir = fs.realpathSync(dir);
  } catch (e) {
    return {
      ok: false,
      reason: `state dir containment: cannot resolve ${dir}: ${e.message}`,
    };
  }
  const expected = path.join(
    realAnchor,
    path.basename(path.dirname(dir)),
    path.basename(dir),
  );
  if (realDir !== expected) {
    return {
      ok: false,
      reason: `state dir containment: ${dir} resolves to ${realDir}, expected ${expected} — symlinked ancestor component`,
    };
  }
  return { ok: true };
}

/**
 * One-time stderr WARN when the platform lacks `O_NOFOLLOW` (Windows), where
 * the flag ORs in as 0 and the symlink protection silently disappears from the
 * open(2) call. The `lstat` pre-checks in `_writeFileHardened` /
 * `_readFileHardened` still refuse a planted link on those platforms, so this
 * is not fail-open — but the residual race between the pre-check and the open
 * is unguarded there, which per `security.md` § "Secure-Default For A New
 * Security Feature" MUST be loud rather than a silent no-op. loom targets
 * Windows/ADO client layouts, so this path is reachable in production.
 */
let _nofollowWarned = false;
function _warnIfNoNofollow() {
  if (_nofollowWarned || (fs.constants.O_NOFOLLOW || 0) !== 0) return;
  _nofollowWarned = true;
  console.error(
    "[STATE-IO] WARNING: O_NOFOLLOW is unavailable on this platform — trust-state writes fall back to an lstat pre-check alone, leaving a check-to-use window a symlink can win. Prefer running hooks on a POSIX platform for full protection.",
  );
}

/**
 * Classify what (if anything) occupies `targetPath`, WITHOUT following a
 * symlink at that path (`lstat`, never `stat`).
 *
 * @param {string} targetPath
 * @returns {{kind:"absent"}
 *          |{kind:"regular", nlink:number, size:number}
 *          |{kind:"irregular", detail:string}
 *          |{kind:"error", reason:string}}
 */
function _classifyPathEntry(targetPath) {
  let st;
  try {
    st = fs.lstatSync(targetPath);
  } catch (e) {
    if (e && e.code === "ENOENT") return { kind: "absent" };
    return { kind: "error", reason: `lstat: ${e.message}` };
  }
  if (st.isSymbolicLink()) {
    return { kind: "irregular", detail: "symbolic link" };
  }
  if (st.isDirectory()) return { kind: "irregular", detail: "directory" };
  if (!st.isFile()) return { kind: "irregular", detail: "non-regular file" };
  return { kind: "regular", nlink: st.nlink, size: st.size };
}

/**
 * Create `targetPath` and write `content` to it without ever following a
 * symlink, writing into an aliased inode, or inheriting an ambient umask.
 * The file is ALWAYS freshly created (`O_CREAT|O_EXCL`) — this helper never
 * opens an inode it did not make.
 *
 * @param {string} targetPath - absolute path to write
 * @param {string|Buffer} content
 * @param {{replaceExisting?: boolean}} [opts] - when true, a PLAIN un-aliased
 *   regular file already at `targetPath` is unlinked first. Used for the paths
 *   that are re-materialised on every write (the write-ahead `.bak`, the
 *   pid-scoped `.tmp`): a stale tmp left by a crashed same-pid process must not
 *   wedge the writer forever. An irregular entry or an aliased (`nlink > 1`)
 *   file is REFUSED in BOTH modes — `replaceExisting` is a staleness allowance,
 *   never a licence to write through an adversarial entry. `unlink` removes the
 *   LINK, never a link's target, so the refusal happens before any unlink.
 * @returns {{ok:true, nofollow_supported:boolean}
 *          |{ok:false, reason:string, code?:string}}
 */
function _writeFileHardened(targetPath, content, opts = {}) {
  const replaceExisting = opts.replaceExisting === true;
  // F53: report whether O_NOFOLLOW was actually applied. On darwin/linux it is
  // always present; on a platform lacking it (Windows) the `|| 0` guard drops
  // the flag. The `lstat` classification below is what refuses a planted link
  // on THOSE platforms — the flag is the race-proof half, the classification is
  // the portable half. `nofollow_supported` is a diagnostic on the return shape
  // and has no production consumer, so the LOUD signal is the one-time stderr
  // WARN from `_warnIfNoNofollow`; this field alone would observe nothing.
  const nofollowSupported = (fs.constants.O_NOFOLLOW || 0) !== 0;
  _warnIfNoNofollow();

  const existing = _classifyPathEntry(targetPath);
  if (existing.kind === "error") {
    return { ok: false, reason: `classify target: ${existing.reason}` };
  }
  if (existing.kind === "irregular") {
    return {
      ok: false,
      code: "ENOTREGULAR",
      reason: `refusing to write through ${existing.detail} at ${targetPath}`,
    };
  }
  if (existing.kind === "regular") {
    if (existing.nlink > 1) {
      return {
        ok: false,
        code: "EMLINK",
        reason: `refusing to write through hard-linked file at ${targetPath} (nlink=${existing.nlink})`,
      };
    }
    if (!replaceExisting) {
      return {
        ok: false,
        code: "EEXIST",
        reason: `refusing to overwrite existing file at ${targetPath}`,
      };
    }
    try {
      fs.unlinkSync(targetPath);
    } catch (e) {
      return { ok: false, code: e.code, reason: `unlink stale target: ${e.message}` };
    }
  }

  // "w" decomposes to O_WRONLY|O_CREAT|O_TRUNC; O_TRUNC is replaced by O_EXCL
  // (we only ever create) and O_NOFOLLOW is ORed in. The `|| 0` guard degrades
  // to plain create semantics on a platform lacking O_NOFOLLOW rather than
  // NaN-poisoning the bitmask — surfaced via `nofollow_supported`.
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW || 0);

  let fd;
  let created = false;
  try {
    fd = fs.openSync(targetPath, flags, 0o600);
    created = true;
    // umask can only CLEAR bits from the O_CREAT mode, so the file is already
    // no wider than 0o600 — fchmod on the HELD fd (never the path, which could
    // be re-pointed under us) makes the mode exact rather than umask-dependent.
    fs.fchmodSync(fd, 0o600);
    // Loop to completion: `fs.writeSync` may short-write, and unlike
    // `writeFileSync` it does NOT loop internally. This helper is now the
    // single writer for ALL durable trust state, so a silent partial write
    // would be silent state corruption (`zero-tolerance.md` Rule 3).
    const buf = Buffer.isBuffer(content)
      ? content
      : Buffer.from(String(content), "utf8");
    let off = 0;
    while (off < buf.length) {
      const n = fs.writeSync(fd, buf, off, buf.length - off);
      if (!(n > 0)) {
        throw Object.assign(
          new Error(`short write: ${off}/${buf.length} bytes`),
          { code: "EIO" },
        );
      }
      off += n;
    }
    fs.fsyncSync(fd);
    // Re-stat the fd we HOLD, AFTER the write: an adversary who hard-links our
    // freshly-created file mid-write would otherwise keep a live alias to the
    // very inode this write is about to rename into place.
    const st = fs.fstatSync(fd);
    if (st.nlink !== 1) {
      throw Object.assign(
        new Error(`target acquired ${st.nlink} links during write`),
        { code: "EMLINK" },
      );
    }
  } catch (e) {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {}
    // Clean up ONLY what we created. An entry we did not create (the ELOOP /
    // EEXIST refusal paths) is left in place: it is the adversary's artifact
    // and deleting it would destroy the forensic evidence of the attempt.
    if (created) {
      try {
        fs.unlinkSync(targetPath);
      } catch {}
    }
    return { ok: false, code: e.code, reason: e.message };
  }
  try {
    fs.closeSync(fd);
  } catch (e) {
    return { ok: false, code: e.code, reason: `close: ${e.message}` };
  }
  return { ok: true, nofollow_supported: nofollowSupported };
}

/**
 * Read `p` without following a symlink at the final path component. The
 * read-side half of the same escalation: a symlinked `posture.json` /
 * `violations.jsonl` IS attacker-controlled trust state, so every state read
 * must refuse rather than read through.
 *
 * `O_NONBLOCK` is ORed in because `O_NOFOLLOW` does not protect against a FIFO
 * planted at the path — opening one O_RDONLY blocks until a writer appears,
 * which would wedge the hook. With O_NONBLOCK the open returns and the
 * regular-file `fstat` check rejects it.
 *
 * @param {string} p
 * @returns {{ok:true, value:Buffer} | {ok:false, code?:string, reason:string}}
 */
function _readFileHardened(p, opts) {
  _warnIfNoNofollow();
  // Portable half: where `O_NOFOLLOW` is 0 (Windows) the flag below vanishes
  // and the open would follow a planted link, so the refusal cannot rest on the
  // flag alone. `lstat` first, then open — the flag makes it race-proof where
  // it exists, the classification makes it correct everywhere.
  const existing = _classifyPathEntry(p);
  if (existing.kind === "irregular") {
    return {
      ok: false,
      code: "ENOTREGULAR",
      reason: `refusing to read through ${existing.detail} at ${p}`,
    };
  }
  const flags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW || 0) |
    (fs.constants.O_NONBLOCK || 0);
  let fd;
  try {
    fd = fs.openSync(p, flags);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw Object.assign(new Error(`not a regular file: ${p}`), {
        code: "ENOTREGULAR",
      });
    }
    // OPTIONAL size cap, checked on the HELD fd BEFORE any bytes are read, so an
    // oversized entry is refused rather than slurped into memory. Enforcing it here —
    // on the fstat this function already performs — rather than at each call site is
    // the same one-helper discipline as the flag set above (`security.md` § Multi-Site
    // Kwarg Plumbing): a caller-side `value.length` check would run only AFTER the
    // allocation it exists to prevent. Callers that pass no `maxBytes` are unaffected.
    const maxBytes =
      opts && Number.isFinite(opts.maxBytes) ? opts.maxBytes : null;
    if (maxBytes !== null && st.size > maxBytes) {
      return {
        ok: false,
        code: "EFBIG",
        reason: `refusing to read ${st.size}B (cap ${maxBytes}B) at ${p}`,
      };
    }
    return { ok: true, value: fs.readFileSync(fd) };
  } catch (e) {
    return { ok: false, code: e.code, reason: e.message };
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {}
  }
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
  // loom#1338: lstat-based, not `existsSync` — a link planted at the legacy
  // path must surface as an adversarial artifact, not read as "absent" (a
  // dangling link) or as a witness whose CONTENT the attacker chooses.
  const legacyEntry = _classifyPathEntry(legacy);
  if (legacyEntry.kind === "absent") {
    return { ok: true, migrated: false, reason: "no legacy witness present" };
  }
  if (legacyEntry.kind === "error") {
    return { ok: false, reason: `migrate: stat legacy: ${legacyEntry.reason}` };
  }
  if (legacyEntry.kind === "irregular") {
    return {
      ok: false,
      reason: `migrate: refusing to migrate ${legacyEntry.detail} at legacy witness path`,
    };
  }

  const target = resolveWitnessPath(repoDir);
  if (!target.ok) {
    return { ok: false, reason: `migrate: ${target.reason}` };
  }
  const newPath = target.value;

  // New location already has a witness — legacy copy is stale. Remove legacy
  // only after confirming the new location is non-empty (defense against
  // truncate-and-unlink that would lose the witness entirely).
  //
  // loom#1338: this probe used `existsSync` + `statSync`, BOTH of which follow
  // links. A symlink planted at the witness path pointing at any non-empty file
  // therefore satisfied "new location already had witness" and the branch
  // UNLINKED the real legacy witness — an attacker-triggered destruction of the
  // trust-anchor the fresh-clone-vs-state-nuke discriminator depends on. lstat
  // classification sees the link itself and refuses without touching legacy.
  const newEntry = _classifyPathEntry(newPath);
  if (newEntry.kind === "error") {
    return { ok: false, reason: `migrate: stat new location: ${newEntry.reason}` };
  }
  if (newEntry.kind === "irregular") {
    return {
      ok: false,
      reason: `migrate: refusing to treat ${newEntry.detail} at new witness location as a witness`,
    };
  }
  if (newEntry.kind === "regular" && newEntry.size > 0) {
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

  // Read legacy content. Witness files are small (typically a UTC timestamp
  // or short JSON) — single read is safe. loom#1338: routed through
  // `_readFileHardened` so a symlink planted at the LEGACY path cannot feed
  // attacker-chosen bytes into the witness the migration is about to make
  // canonical.
  const legacyRead = _readFileHardened(legacy);
  if (!legacyRead.ok) {
    return { ok: false, reason: `migrate: read legacy: ${legacyRead.reason}` };
  }
  const content = legacyRead.value;

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
  // F53 (a): O_NOFOLLOW defeats a symlink-redirect attack — if a bounded-trust
  // adversary pre-plants a symlink at the tmp path, "w" semantics would FOLLOW
  // the link and write the witness through the attacker's sink. loom#1338 moved
  // that flag set (plus the hard-link + umask guards) into `_writeFileHardened`
  // so it is the SINGLE writer for this module; keeping it inline here is
  // precisely what let `writePosture` ship the un-hardened pattern beside it.
  // `replaceExisting` covers a stale tmp from a crashed same-pid process; a
  // symlink or hard link at the path is still refused.
  const wrote = _writeFileHardened(tmp, content, { replaceExisting: true });
  if (!wrote.ok) {
    return { ok: false, reason: `migrate: write tmp: ${wrote.reason}` };
  }
  const nofollowSupported = wrote.nofollow_supported;

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
  // Ancestor containment: a symlinked `.claude/learning` makes every path below
  // attacker-chosen, so a "valid" posture read out of it is attacker-authored.
  // Fail closed rather than trusting it (the read path returns L1 rather than
  // throwing — its callers expect a posture object, never an exception).
  const dirContained = _assertStateDirContained(dir);
  if (!dirContained.ok) {
    console.error(`[STATE-IO] ${dirContained.reason}`);
    return failClosedPosture(dirContained.reason);
  }
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

  // loom#1338 (round 2): an ADVERSARIAL refusal is not the same event as a
  // benign absent file, and collapsing them was wrong. With `.initialized`
  // absent, falling through lands on `_freshRepoPosture()` — the MAXIMUM
  // posture — so planting a link over a real L1 `posture.json` would have
  // UPGRADED the repo. A non-ENOENT refusal is now recorded and forces the
  // fail-closed disposition regardless of marker state, and it is reported on
  // stderr rather than swallowed (`zero-tolerance.md` Rule 3).
  let adversarialRefusal = null;
  for (const p of [main, bak]) {
    try {
      // Hardened read: a symlink / FIFO / directory at the posture path is
      // attacker-controlled trust state, NOT a candidate to parse.
      const read = _readFileHardened(p);
      if (!read.ok) {
        if (read.code && read.code !== "ENOENT") {
          adversarialRefusal = `${p}: ${read.reason}`;
          console.error(
            `[STATE-IO] refusing to read trust state at ${p}: ${read.reason}`,
          );
        }
        continue;
      }
      const obj = JSON.parse(read.value.toString("utf8"));
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

  // An adversarial entry at a posture path outranks the marker heuristic: the
  // repo demonstrably is NOT a pristine fresh clone if someone planted a link
  // over its trust state.
  if (adversarialRefusal) {
    return failClosedPosture(
      `adversarial entry at a posture path — ${adversarialRefusal}`,
    );
  }

  // Legacy marker-only fall-back (CRIT-4 mitigation, unchanged behavior).
  // loom#1338: presence is decided by `lstat`, not `existsSync`. `existsSync`
  // follows links, so a DANGLING symlink planted at `.initialized` read as
  // ABSENT and handed back the fresh-repo L5 disposition to an adversary who
  // merely created a link. lstat sees the link itself ⇒ marker PRESENT ⇒
  // corrupt-state fail-closed L1. An lstat error (EACCES) is likewise not
  // "absent", so it also falls through to fail-closed.
  if (_classifyPathEntry(initMarkerPath).kind === "absent") {
    return _freshRepoPosture();
  }
  return failClosedPosture(
    "posture.json missing or corrupt; both main and bak unreadable",
  );
}

/**
 * Grace-window predicate for a `pending_verification` entry (loom#875).
 *
 * A `pending_verification` entry records a rule inside its grace period (per
 * `rules/trust-posture.md` § 6 Grace Period Semantics; canonical grace = 7
 * days from rule landing). The trust-posture rules promise the entry stops
 * driving the SessionStart ack soft-gate + the trust-gate banner + the
 * diagnostic count once the grace window elapses — but nothing rewrites the
 * on-disk entry, so a grace-EXPIRED entry kept firing `acknowledgement_failure`
 * on every Stop event forever (the day-17-of-a-7-day-grace bug).
 *
 * This is a pure READ-TIME predicate — deliberately NOT a posture.json write.
 * posture.json's ONLY legitimate writers are the fold hooks (per
 * `rules/trust-posture.md` MUST NOT + `rules/multi-operator-coordination.md`),
 * and `readPosture` returns a COMPOSED v2+legacy-facet object (see
 * `_composeLegacyFacets`) that is NOT the on-disk shape — writing it back
 * through `writePosture` would corrupt state. Filtering at read time in each
 * of the three consumers stops the nag with zero state mutation, so the
 * cleanup is idempotent by construction (re-running mutates nothing).
 *
 * Fail-SAFE on a bad/absent `since`: an unparseable timestamp returns `true`
 * (keep requiring the ack) rather than silently dropping the entry — a parse
 * error MUST NOT weaken the grace gate (`rules/zero-tolerance.md` Rule 3: no
 * silent fallback). Grace is measured from the PER-ENTRY `since` (the same
 * field the SessionStart banner reads), NOT the posture-level `since`.
 *
 * Enforcement is NOT weakened post-grace: `pending_verification` is only a
 * grace-period ACK receipt; the violation-detection battery + the cumulative
 * downgrade math never consult it, so a grace-expired rule stays fully enforced
 * via cumulative math, and `regression_within_grace` cannot fire post-grace by
 * definition.
 *
 * @param {{rule_id?: string, since?: string, grace_period_days?: number}} entry
 * @param {number} [now=Date.now()] injectable clock (tests pass a fixed epoch)
 * @returns {boolean} true iff the entry is still within its grace window
 */
function isPendingWithinGrace(entry, now = Date.now()) {
  if (!entry || !entry.rule_id) return false;
  const graceDays =
    typeof entry.grace_period_days === "number" ? entry.grace_period_days : 7;
  const since = new Date(entry.since).getTime();
  if (!Number.isFinite(since)) return true; // fail-safe: unparseable → keep requiring ack
  return Math.floor((now - since) / 86400000) < graceDays;
}

/**
 * Write posture.json with write-ahead .bak (mitigates HIGH-6 corrupt-on-crash).
 * Caller is responsible for flock if multiple writers; for the POC we use mtime check.
 *
 * loom#1338: all three writes route through `_writeFileHardened` (see its
 * header for the symlink / hard-link / umask contract). Previously each used
 * plain `fs.copyFileSync` / `fs.writeFileSync`, which FOLLOW a symlink planted
 * at the destination. The tmp instance was the escalation: `renameSync` does
 * NOT follow, so an unhardened write through a planted link renamed the LINK
 * over `posture.json` — making the posture file itself a symlink into
 * attacker-controlled storage, and every later read/write flow through it.
 *
 * Fails CLOSED: any refusal throws rather than degrading to a plain write, so
 * a caller can never silently persist posture state through an adversarial
 * path entry.
 *
 * @param {string} cwd
 * @param {{posture: string}} posture
 * @returns {{ok: true, nofollow_supported: boolean}} `nofollow_supported`
 *   surfaces the degraded-security path on platforms without `O_NOFOLLOW`,
 *   matching the `migrateWitnessIfPresent` sibling's contract.
 */
function writePosture(cwd, posture) {
  if (!VALID_POSTURES.has(posture.posture)) {
    throw new Error(`Invalid posture: ${posture.posture}`);
  }
  const dir = ensureStateDir(cwd);
  // Ancestor containment BEFORE any write: a symlinked `.claude/learning`
  // redirects all three writes below into attacker storage while every
  // final-component guard reports success.
  const contained = _assertStateDirContained(dir);
  if (!contained.ok) throw new Error(`writePosture: ${contained.reason}`);
  const main = path.join(dir, POSTURE_FILE);
  const bak = path.join(dir, POSTURE_BAK);
  const tmp = path.join(dir, `posture.json.tmp.${process.pid}`);

  // 1. Copy current main → bak (write-ahead). `copyFileSync(main, bak)` followed
  //    a symlink at EITHER end; a hardened read + hardened re-write refuses
  //    both. An absent main is the first-write case — skip the write-ahead.
  const prior = _readFileHardened(main);
  if (prior.ok) {
    const baked = _writeFileHardened(bak, prior.value, {
      replaceExisting: true,
    });
    if (!baked.ok) {
      throw new Error(`writePosture: write-ahead bak: ${baked.reason}`);
    }
  } else if (prior.code !== "ENOENT") {
    // Unreadable-but-present main (symlink, FIFO, permissions): refuse rather
    // than skip the write-ahead copy and overwrite it anyway.
    throw new Error(`writePosture: read main for write-ahead bak: ${prior.reason}`);
  }

  // 2. Write tmp; rename atomic. The tmp is created O_EXCL|O_NOFOLLOW and its
  //    nlink verified === 1 AT WRITE TIME, which is what stops the rename
  //    installing an attacker's link at the posture path. Deliberately NOT
  //    "provably a regular file this process created" at rename time: nothing
  //    re-validates between the final fstat and the renameSync, so a link
  //    raced into that window is unguarded (an attempted race did not win in
  //    4000 tries, but "narrow" is not "closed").
  const wrote = _writeFileHardened(tmp, JSON.stringify(posture, null, 2), {
    replaceExisting: true,
  });
  if (!wrote.ok) {
    throw new Error(`writePosture: write tmp: ${wrote.reason}`);
  }
  try {
    fs.renameSync(tmp, main);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw new Error(`writePosture: rename tmp: ${e.message}`);
  }

  // 3. Touch init marker. `if (!existsSync) writeFileSync` was the third
  //    instance of the class, and `existsSync` FOLLOWS links: a DANGLING
  //    symlink here reads as absent, so the branch fired and created the
  //    attacker's target through the link. lstat-based classification sees the
  //    link itself.
  const initMarker = path.join(dir, INITIALIZED_MARKER);
  const marker = _classifyPathEntry(initMarker);
  if (marker.kind === "error") {
    throw new Error(`writePosture: classify init marker: ${marker.reason}`);
  }
  if (marker.kind === "irregular") {
    throw new Error(
      `writePosture: refusing to write init marker through ${marker.detail} at ${initMarker}`,
    );
  }
  if (marker.kind === "absent") {
    // Create-once: no `replaceExisting`, so a marker re-planted in the
    // classify→open window fails EEXIST instead of being overwritten.
    const markerWrite = _writeFileHardened(
      initMarker,
      new Date().toISOString(),
    );
    if (!markerWrite.ok) {
      throw new Error(`writePosture: write init marker: ${markerWrite.reason}`);
    }
  }

  return { ok: true, nofollow_supported: wrote.nofollow_supported };
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
  const contained = _assertStateDirContained(dir);
  if (!contained.ok) throw new Error(`appendViolation: ${contained.reason}`);
  const file = path.join(dir, VIOLATIONS_FILE);

  // `...partial` spreads FIRST so the four provenance fields below are PINNED, not
  // caller-overridable. Spread last (as it was), a caller-supplied `id` reached the
  // minimal-marker fallback UNSLICED — measured at 4317 bytes on disk, past PIPE_BUF,
  // which is the non-atomic interleaving that fallback's own comment exists to prevent.
  // It is also the recorded-but-never-applied fix direction from the env-seam redteam
  // (`workspaces/loom-tracks-2026-07-28/03-waves/72-redteam-security-envseam.md` F5:
  // "make id non-overridable (spread partial first, then pin id/timestamp)").
  // No production caller passes any of these four (swept: the sole caller is
  // `detect-violations.js::_logViolation`), so pinning changes no live behaviour — it
  // removes a lever. An audit row's own identity and provenance should not be
  // suppliable by the thing being audited.
  const violation = {
    ...partial,
    id: newId("vio"),
    timestamp: new Date().toISOString(),
    // Env-derived and attacker-influenceable, so bounded HERE, at ingest, rather than
    // trusted downstream (`security.md` § Input Validation). Unbounded it is a lever for
    // inflating the record past the signed path's cap — see the F5 note in
    // `detect-violations.js::_logViolation`.
    session_id: String(process.env.CLAUDE_SESSION_ID || "unknown").slice(0, 128),
    repo: _stripRepoPath(cwd || process.cwd()),
  };

  // loom#1338: sizing is in BYTES, not UTF-16 units. `line.length` counts code
  // units, so a record of 1900 em-dashes measured 2029 "long" — under the 2048
  // cap — while occupying 5829 bytes, blowing straight past PIPE_BUF (4096) and
  // silently voiding the single-syscall atomicity the append below depends on.
  // Char-based truncation could not fix it either: the same record truncated to
  // 2048 UNITS was still 6129 bytes. `coc-append.js` already sizes in bytes;
  // this is the same contract, measured the same way.
  const _bytes = (s) => Buffer.byteLength(s, "utf8");
  // ...and measured over the same PAYLOAD. The writer below emits `line + "\n"`,
  // so the on-disk record is one byte longer than the JSON. Sizing the JSON alone
  // let a truncation landing exactly on MAX_LINE_BYTES write 2049 bytes — over the
  // cap this function exists to enforce. Whether it landed there depended on the
  // repo basename embedded in the row, so the overrun surfaced or hid based on
  // where the repo happened to be checked out. `coc-append.js` measures
  // `JSON.stringify(record) + "\n"` (its line 164); the parity the comment above
  // claims was true of the UNIT and false of the PAYLOAD. This closes that half.
  const _payloadBytes = (s) => _bytes(s) + NEWLINE_BYTES;
  let line = JSON.stringify(violation);
  if (_payloadBytes(line) > MAX_LINE_BYTES) {
    // Binary-search the largest evidence prefix whose WHOLE serialized line
    // fits in bytes. Re-measure per probe: dropping one code unit can drop 1–4
    // bytes, and JSON escaping means the line does not shrink one-for-one with
    // the field, so no closed-form trim is correct.
    const evidence = String(violation.evidence || "");
    violation._truncated = true;
    let lo = 0;
    let hi = evidence.length;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      violation.evidence = evidence.slice(0, mid) + "…[trunc]";
      if (_payloadBytes(JSON.stringify(violation)) <= MAX_LINE_BYTES) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best >= 0) {
      violation.evidence = evidence.slice(0, best) + "…[trunc]";
      line = JSON.stringify(violation);
    } else {
      // Even a zero-length evidence field does not fit — the non-evidence
      // fields alone (an oversized rule_id, say) blow the cap. Emit a minimal
      // marker row instead of a record that cannot be appended atomically:
      // losing the detail is recoverable, losing the ROW is not, and a
      // non-atomic write would interleave and corrupt a sibling's record.
      line = JSON.stringify({
        id: violation.id,
        timestamp: violation.timestamp,
        session_id: String(violation.session_id).slice(0, 64),
        repo: String(violation.repo).slice(0, 64),
        rule_id: String(violation.rule_id || "unknown").slice(0, 128),
        severity: String(violation.severity || "unknown").slice(0, 32),
        evidence: "[dropped: record exceeded MAX_LINE_BYTES]",
        _truncated: true,
      });
      // MEASURED, not reasoned. Every other path through this function is checked
      // against the cap; this one was bounded only by arithmetic over the `.slice()`
      // limits above — and that arithmetic was WRONG while `id`/`timestamp` carried no
      // slice and were caller-overridable (a supplied 4000-char `id` wrote 4317 bytes,
      // past PIPE_BUF, in the branch whose whole purpose is avoiding a non-atomic
      // append). Pinning them at construction fixes the lever; asserting here is what
      // makes the invariant hold for the NEXT field someone adds to this row.
      if (_payloadBytes(line) > MAX_LINE_BYTES) {
        // Last resort. Both surviving fields are sliced even though both are GENERATED
        // above and therefore already bounded — deliberately, so this row's size does not
        // depend on that pinning holding. Without the slices these two defenses are
        // coupled: measured under a mutation that unpinned `id` while leaving this guard
        // in place, the "last resort" row was itself 8098 bytes, because it copied the
        // caller's 4000-char value verbatim. A defense-in-depth layer that fails whenever
        // the layer above it fails is not depth. Sliced, this row is bounded by
        // construction regardless of what reaches it.
        line = JSON.stringify({
          id: String(violation.id).slice(0, 64),
          timestamp: String(violation.timestamp).slice(0, 32),
          evidence: "[dropped: record exceeded MAX_LINE_BYTES]",
          _truncated: true,
        });
      }
    }
  }

  // O_APPEND atomic for writes < PIPE_BUF (4096); we're capped at 2048.
  //
  // loom#1338: `fs.appendFileSync` FOLLOWS a symlink planted at
  // `violations.jsonl` — an arbitrary-append primitive that also silently
  // diverts the audit trail. O_NOFOLLOW makes that ELOOP (fail closed, the same
  // disposition appendFileSync already had for EACCES/ENOSPC), and mode 0o600
  // applies on create.
  //
  // Deliberately NOT refused here: `nlink > 1`. A hard link at this path aliases
  // the SAME inode, so the record IS still appended to the real log — the only
  // gain to the attacker is read-visibility they already have (they can create
  // entries in this directory). Refusing would instead let one planted link
  // SUPPRESS the audit trail entirely, which is the strictly worse failure. The
  // asymmetry with `_writeFileHardened` is recorded here so it does not read as
  // an oversight.
  //
  // loom#1338 (round 2): `O_NONBLOCK` is load-bearing here, not cosmetic. A
  // FIFO planted at `violations.jsonl` is not a symlink, so `O_NOFOLLOW` does
  // nothing — and a blocking `open(2)` on a reader-less FIFO never returns.
  // That wedges the whole hook synchronously: the JS timeout is a timer on an
  // event loop that never gets control back, and because `detect-violations.js`
  // logs BEFORE it emits, the user is never warned at all. Suppressing every
  // violation detection is a fail-OPEN outcome, strictly worse than losing the
  // audit row. The `lstat` pre-check refuses it outright; `O_NONBLOCK` is the
  // belt-and-braces that also covers a FIFO raced in after the check.
  _warnIfNoNofollow();
  const existingLog = _classifyPathEntry(file);
  if (existingLog.kind === "irregular") {
    throw Object.assign(
      new Error(
        `refusing to append violations through ${existingLog.detail} at ${file}`,
      ),
      { code: "ENOTREGULAR" },
    );
  }
  const appendFlags =
    fs.constants.O_WRONLY |
    fs.constants.O_APPEND |
    fs.constants.O_CREAT |
    (fs.constants.O_NOFOLLOW || 0) |
    (fs.constants.O_NONBLOCK || 0);
  let fd;
  try {
    fd = fs.openSync(file, appendFlags, 0o600);
    // Confirm on the HELD fd that we are appending to a regular file: with
    // O_NONBLOCK the open of a FIFO SUCCEEDS instead of blocking, so the flag
    // converts a hang into an open that must still be rejected here.
    if (!fs.fstatSync(fd).isFile()) {
      throw Object.assign(
        new Error(`refusing to append violations to non-regular file ${file}`),
        { code: "ENOTREGULAR" },
      );
    }
    // Deliberately a SINGLE writeSync, not a completion loop: the O_APPEND
    // atomicity guarantee holds only for one write syscall under PIPE_BUF, and
    // `line` is capped at MAX_LINE_BYTES (2048) above precisely so it fits. A
    // resumed partial write would interleave with a concurrent writer's record,
    // so a short write is reported LOUDLY instead of being stitched back.
    const payload = Buffer.from(line + "\n", "utf8");
    const written = fs.writeSync(fd, payload, 0, payload.length);
    if (written !== payload.length) {
      throw Object.assign(
        new Error(
          `violation append short-wrote ${written}/${payload.length} bytes; record not atomically logged`,
        ),
        { code: "EIO" },
      );
    }
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {}
  }
  return violation.id;
}

/**
 * Read recent violations within a window (mitigates MED-4 unbounded growth — caller filters).
 */
function readRecentViolations(cwd, { sinceTs, limit = 1000 } = {}) {
  const dir = resolveStateDir(cwd);
  const contained = _assertStateDirContained(dir);
  if (!contained.ok) {
    console.error(`[STATE-IO] ${contained.reason}`);
    return [];
  }
  const file = path.join(dir, VIOLATIONS_FILE);

  // loom#1338: hardened read — a symlinked violations log is attacker-authored
  // history, not history. Disposition on refusal is `[]`, matching the
  // absent-file case: the sole consumer (detect-violations.js's ack-check
  // dedup) treats an empty history as "nothing seen yet" and therefore emits
  // MORE findings, never fewer — so `[]` is the fail-closed direction here.
  // The refusal is NOT silent (`zero-tolerance.md` Rule 3): a non-ENOENT
  // failure is reported on stderr, which the hook surface propagates.
  const read = _readFileHardened(file);
  if (!read.ok) {
    if (read.code !== "ENOENT") {
      console.error(
        `[STATE-IO] refusing to read violations log at ${file}: ${read.reason}`,
      );
    }
    return [];
  }

  const raw = read.value.toString("utf8");
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
  // loom#875 — shared grace-window predicate; the three pending_verification
  // consumers (session-start banner, detect-violations ack-check, posture-gate
  // diagnostic count) filter through this single source of truth so a
  // grace-EXPIRED entry stops nagging. Pure read-time filter, no posture.json
  // write (readPosture composes legacy facets; writing that object back
  // corrupts state — hooks are the only legitimate posture writers).
  isPendingWithinGrace,
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
  // loom#1500-L3: exported so readers of OTHER attacker-plantable paths route
  // through this same open(2) flag set instead of re-deriving it. First external
  // caller is the artifact-activation idempotence guard, which reads a sink whose
  // WRITES already go through `append-sink.js`; its plain `readFileSync` was the
  // asymmetry this file's own header warns about — the hardened pattern present in
  // one place and the plain one beside it. `security.md` § Multi-Site Kwarg Plumbing.
  readFileHardened: _readFileHardened,
  VALID_POSTURES,
  MAX_LINE_BYTES,
  COORDINATION_LOG_FILE,
  CLONE_INIT_WITNESS_FILE,
  LEGACY_CLONE_INIT_WITNESS_FILE,
};
