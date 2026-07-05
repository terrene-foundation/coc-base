/**
 * session-notes-layout — per-operator + forest-ledger layout for
 * `.session-notes` (Shard M6 D §5.1, architecture v11).
 *
 * Single-writer artifact contention: the legacy `.session-notes` file
 * silently clobbers under N concurrent operators — each session's
 * /wrapup writes the file atomically, but the LAST writer wins; every
 * prior session's notes vanish on the next /wrapup elsewhere.
 *
 * The structural fix splits the artifact along the contention axis:
 *
 *   .session-notes.d/<display_id>.md   — per-operator fragment (owned
 *                                         by one writer; no contention)
 *   .session-notes.shared.md           — forest ledger (per-row owner:
 *                                         attribution; merged by the
 *                                         coc-ledger driver)
 *
 * Per architecture §5.4 the same split applies to workspace-level
 * paths: `workspaces/<name>/.session-notes.d/<display_id>.md` +
 * `workspaces/<name>/.session-notes.shared.md`. The helpers below
 * accept the base directory so both surfaces share one implementation.
 *
 * Atomicity: every write lands via `<path>.tmp.<pid>` + `rename()` so
 * a partial-write window cannot expose half-baked content to a
 * concurrent reader (POSIX `rename(2)` is atomic on the same
 * filesystem). The forest-ledger MUST exist before the merge driver
 * fires; the helper creates an empty header-only ledger if absent.
 *
 * Contract:
 *   writePerOperatorFragment(baseDir, identity, body)
 *     → {ok, path, error?, reason?}
 *   ensureForestLedger(baseDir)
 *     → {ok, path, created, error?, reason?}
 *   appendForestLedgerRow(baseDir, identity, row)
 *     → {ok, path, error?, reason?}
 *
 * Per zero-tolerance.md Rule 3: every failure path returns a typed
 * error object; never silent-fallback, never throw uncaught.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const { parseLedger } = require("./coc-ledger.js");

const FRAGMENT_DIR_NAME = ".session-notes.d";
const SHARED_LEDGER_NAME = ".session-notes.shared.md";
// Legacy single-writer monolith (the pre-split `.session-notes`), the
// migration SOURCE. Post-migration it is renamed to MIGRATED_MONOLITH_NAME
// so the (present-monolith, absent-split) convert predicate flips false and
// re-runs no-op (I2 idempotence via rename-away). (#743 Wave 1.)
const MONOLITH_NAME = ".session-notes";
// Option-B read-only per-clone aggregate view (#743 C2). GITIGNORED — a
// TRACKED aggregate would re-introduce the knowledge-convergence.md MUST-1
// single-shared-file clobber. The .gitignore entry MUST be this EXACT name,
// never a broad `.session-notes.*` glob (which would untrack the tracked
// split: SHARED_LEDGER_NAME + FRAGMENT_DIR_NAME). (I11.)
const AGGREGATE_NAME = ".session-notes.aggregate.md";
// Post-migration disposition of the monolith (Decision A — recoverable,
// removes it from the canonical path so the convert predicate is false next
// run). Per-clone recovery artifact → gitignored (X-2).
const MIGRATED_MONOLITH_NAME = ".session-notes.migrated";
// Migration mutual-exclusion lock (I7): the multi-file migration (fragment
// write + ledger ensure + monolith rename) is not a transaction; concurrent
// SessionStart first-runs would race. O_EXCL create; fail-open on contention
// (never block session start). Per-clone transient → gitignored.
const MIGRATE_LOCK_NAME = ".session-notes.migrate.lock";
// A migrate lock older than this is treated as stale (an abandoned prior
// run that crashed before release) and stolen once. Bounds "migration in
// progress" from becoming "migration blocked forever".
const MIGRATION_LOCK_STALE_MS = 60_000;

// Size cap for EVERY synchronous read of a TRACKED/shared session-notes path
// (the monolith, a `.session-notes.d/*.md` fragment, the `.session-notes.shared.md`
// ledger). These files are committed + shared, so a bounded-trust teammate can
// commit an oversized file OR a symlink; a synchronous `readFileSync` cannot be
// interrupted by a hook's Rule-7 timer (the event loop is blocked INSIDE the
// read), so an unguarded read hangs/OOMs every puller's SessionStart. 1 MB is
// parity with the incorporation guard's own fragment cap. A real session-notes
// file is KBs; 1 MB signals corruption/attack. (R7 MED-1 — the reader-parity
// sweep the R5 FIND-2 monolith cap should have covered across ALL readers;
// re-exported so `workspace-utils.js` can pin its mirror against drift.)
const NOTES_READ_CAP_BYTES = 1024 * 1024;

// The shared ledger header carries the column schema the coc-ledger
// merge driver parses by (it detects the table region via header +
// separator pattern; see coc-ledger.js::parseLedger). The `ID` column
// is the stable merge key per §5.1; the `owner` column carries
// per-row attribution. Both are load-bearing for the merge semantics.
const LEDGER_HEADER = [
  "<!--",
  "  .session-notes.shared.md — Forest Ledger (Shard M6 D §5.1)",
  "",
  "  Per-row owner: attribution. Merged via the `coc-ledger` driver",
  "  (.gitattributes). DO NOT edit the table layout — the merge driver",
  "  parses by header + separator pattern; layout changes break the",
  "  driver's column detection.",
  "",
  "  Rows under N concurrent operators are reconciled per-row by the",
  "  stable `ID` column; conflicting edits surface per-row conflict",
  "  markers naming the conflicting owners.",
  "",
  "  The `owner:` column in this file is UNSIGNED. It is a convenience",
  "  attribution surface for human readers and the merge driver's",
  "  per-row conflict-marker output. Authoritative attribution flows",
  "  through the coordination log's signed slot-record + body-anchor",
  "  pair (.claude/learning/coordination-log.jsonl); a row here without",
  "  a matching coordination-log slot is NOT a forensic witness.",
  "-->",
  "",
  "# Forest Ledger",
  "",
  "| ID | owner | item | value_anchor | status |",
  "| --- | --- | --- | --- | --- |",
  "",
].join("\n");

function _slugifyForFilename(s) {
  return (
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "unknown"
  );
}

// Guarded synchronous read of a TRACKED/shared session-notes path. The single
// chokepoint every such read MUST route through so the NOTES_READ_CAP_BYTES +
// symlink defenses cannot drift out of parity again (the R5 FIND-2 monolith cap
// was applied to ONE reader; R7 MED-1 found the sibling readers uncapped). Does
// lstat (symlink / non-regular refusal) → size check → read, in that order, so
// an oversized or symlinked file is NEVER read into memory. Returns a typed
// classification; the caller decides skip-vs-refuse.
//   { ok:true, content }                      — safe to use
//   { ok:false, kind:"symlink"|"not-regular"|"oversize"|"stat-error"|"read-error", size?, err? }
function _readNotesFileGuarded(filePath) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    return { ok: false, kind: "stat-error", err };
  }
  if (st.isSymbolicLink()) return { ok: false, kind: "symlink" };
  if (!st.isFile()) return { ok: false, kind: "not-regular" };
  if (st.size > NOTES_READ_CAP_BYTES) {
    return { ok: false, kind: "oversize", size: st.size };
  }
  try {
    // `stat` (the lstat result) is returned so callers needing file metadata
    // (mtime for an age gate, size) get it WITHOUT a second syscall or a
    // separate un-guarded stat — every notes reader routes through this one path.
    return { ok: true, content: fs.readFileSync(filePath, "utf8"), stat: st };
  } catch (err) {
    return { ok: false, kind: "read-error", err };
  }
}

// Per Sec-MED-1 + reviewer MED-1 (M6 D, 2026-05-22):
//   - O_EXCL on the tmp create refuses to follow a pre-placed symlink at
//     the tmp path AND refuses to clobber an existing file there.
//   - 0o600 mode keeps per-operator fragments + forest-ledger rows
//     readable only by the writing user (identity hints in fragments
//     should not be world-readable; default 0o644 would leak them).
//   - Pre-rename lstat refuses to write THROUGH a symlink at the final
//     filePath (attacker pre-places `.session-notes.shared.md` →
//     `~/.ssh/authorized_keys`; without this check the rename would
//     unlink the symlink and replace it, but a future rewrite that
//     used `writeFileSync(filePath, ...)` directly would clobber the
//     link target — the check makes the contract structural, not
//     incidental to using rename).
//   - fsync between write and rename closes the durability gap: a
//     crash between the two would otherwise leave the tmp file
//     atomically renamed but with stale bytes on disk.
//   - Random suffix on the tmp path (vs. bare `.tmp.<pid>`) prevents a
//     same-pid attacker from pre-creating the exact tmp path to win
//     the O_EXCL race.
function _atomicWrite(filePath, body) {
  let tmpPath;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Refuse to write through a symlink at the final destination.
    // ENOENT (missing) is the happy path; other errors propagate.
    try {
      const st = fs.lstatSync(filePath);
      if (st.isSymbolicLink()) {
        return {
          ok: false,
          error: "atomic write failed",
          reason: `refusing to write through symlink at ${filePath}`,
        };
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    tmpPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`,
    );
    // O_EXCL prevents follow-link on creation + refuses to clobber an
    // existing file at tmpPath. 0o600 = restrictive perms.
    const fd = fs.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
    // Fsync the PARENT DIRECTORY after rename so the directory entry (the
    // rename itself) is durable on crash. The fd fsync above only guarantees
    // the DATA bytes; without this, a crash immediately after rename can leave
    // the file's bytes on disk but the rename un-flushed, vanishing a
    // per-operator fragment or forest-ledger row on power loss (loom#742).
    // Best-effort: some platforms (Windows) refuse a directory fd with
    // EISDIR/EPERM — a refusal is non-fatal (the git-committed split is the
    // durable record of record) but the outcome is surfaced on the return
    // (`parent_dir_synced`) rather than silently no-op'd.
    let parentDirSynced = false;
    let dirFd;
    try {
      dirFd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
      fs.fsyncSync(dirFd);
      parentDirSynced = true;
    } catch {
      /* best-effort: platform refuses directory fsync (Windows EISDIR/EPERM) */
    } finally {
      if (dirFd !== undefined) {
        try {
          fs.closeSync(dirFd);
        } catch {
          /* best-effort */
        }
      }
    }
    return { ok: true, parent_dir_synced: parentDirSynced };
  } catch (err) {
    // Best-effort tmp cleanup; do not mask the original error.
    try {
      if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    return {
      ok: false,
      error: "atomic write failed",
      reason: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Write the per-operator fragment at
 * `<baseDir>/.session-notes.d/<display_id>.md`.
 *
 * The fragment is single-writer: only the operator whose `display_id`
 * matches the filename writes here. Cross-operator coordination flows
 * through the forest ledger (per-row owner attribution) instead.
 *
 * @param {string} baseDir - absolute path to the repo or workspace root
 * @param {{display_id?:string, person_id:string, verified_id:string}} identity
 * @param {string} body - the fragment body to write (caller-supplied)
 * @returns {{ok:true, path:string, parent_dir_synced:boolean} | {ok:false, error:string, reason:string}}
 *   `parent_dir_synced` reports whether the post-rename parent-dir fsync
 *   succeeded (false on platforms that refuse a directory fd; loom#742).
 */
function writePerOperatorFragment(baseDir, identity, body) {
  if (!baseDir || typeof baseDir !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "baseDir must be a non-empty string",
    };
  }
  if (
    !identity ||
    typeof identity !== "object" ||
    (typeof identity.display_id !== "string" &&
      typeof identity.person_id !== "string" &&
      typeof identity.verified_id !== "string")
  ) {
    // Per zero-tolerance Rule 3a: typed guard, not opaque AttributeError.
    return {
      ok: false,
      error: "missing identity",
      reason:
        "opts.identity must carry display_id (preferred) or person_id or verified_id",
    };
  }
  if (typeof body !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "body must be a string",
    };
  }
  const handle =
    identity.display_id || identity.person_id || identity.verified_id;
  const filename = `${_slugifyForFilename(handle)}.md`;
  const fragmentPath = path.join(baseDir, FRAGMENT_DIR_NAME, filename);
  const result = _atomicWrite(fragmentPath, body);
  if (!result.ok) return { ...result };
  return {
    ok: true,
    path: fragmentPath,
    parent_dir_synced: result.parent_dir_synced,
  };
}

/**
 * Write an operator's own fragment with a fresh `last_reconciled_sha` stamp —
 * the single-source routed write for `/reconcile-notes` (C4.3 + C4.5, #743
 * Wave 3). `content` is the reconciled fragment BODY (everything after the
 * frontmatter block); the frontmatter — including the `last_reconciled_sha`
 * lag anchor the incorporation-guard reads (C3.2) — is (re)built HERE via the
 * one canonical `_buildFragmentBody`, so the command NEVER hand-rolls the
 * frontmatter shape (that would drift from the builder — `zero-tolerance.md`
 * Rule 3e code-surface single-source). The write goes through
 * `writePerOperatorFragment` → `_atomicWrite` (tmp+rename+fsync).
 *
 * @param {string} baseDir
 * @param {{display_id?:string, person_id?:string, verified_id?:string}} identity
 * @param {string} content  reconciled fragment body (frontmatter is prepended here, not by the caller)
 * @param {string} sha      HEAD sha to stamp; MUST be a 7–40 hex-char git object id
 * @returns {{ok:true, path:string, parent_dir_synced?:boolean, sha:string} | {ok:false, error:string, reason:string}}
 */
function writeReconciledFragment(baseDir, identity, content, sha) {
  if (typeof content !== "string") {
    // Rule 3a typed guard — never an opaque downstream throw on `.length` etc.
    return {
      ok: false,
      error: "invalid argument",
      reason: "content must be a string (the reconciled fragment body)",
    };
  }
  // Shape-guard the sha BEFORE it is stamped: the stamp is the lag anchor the
  // incorporation-guard feeds to `git rev-list` (C3.2), which itself shape-
  // guards `/^[0-9a-f]{7,40}$/i`. A malformed stamp would make every future
  // lag compute exit-128 → silently suppress the advisory forever (I12b). Fail
  // closed here so a bad HEAD read never poisons the anchor.
  if (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(sha.trim())) {
    return {
      ok: false,
      error: "invalid sha",
      reason:
        "sha must be a 7–40 hex-char git object id (the last_reconciled_sha lag anchor)",
    };
  }
  const body = _buildFragmentBody(sha.trim(), content, {});
  const result = writePerOperatorFragment(baseDir, identity, body);
  if (!result.ok) return { ...result };
  return { ...result, sha: sha.trim() };
}

/**
 * Ensure the forest-ledger file exists at
 * `<baseDir>/.session-notes.shared.md`. If absent, create it with the
 * header-only template (zero rows). Idempotent: no-op if file present.
 *
 * @param {string} baseDir
 * @returns {{ok:true, path:string, created:boolean, parent_dir_synced?:boolean} | {ok:false, error:string, reason:string}}
 *   `parent_dir_synced` is present only when a write occurred (`created:true`);
 *   it reports the post-rename parent-dir fsync outcome (loom#742).
 */
function ensureForestLedger(baseDir) {
  if (!baseDir || typeof baseDir !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "baseDir must be a non-empty string",
    };
  }
  const ledgerPath = path.join(baseDir, SHARED_LEDGER_NAME);
  // Use lstat (not existsSync) to detect symlinks pre-placed at the
  // ledger path. existsSync follows symlinks and short-circuits the
  // _atomicWrite refusal below. Per Sec-MED-1 (M6 D, 2026-05-22).
  let lst;
  try {
    lst = fs.lstatSync(ledgerPath);
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      return {
        ok: false,
        error: "ledger lstat failed",
        reason: err && err.message ? err.message : String(err),
      };
    }
  }
  if (lst) {
    if (lst.isSymbolicLink()) {
      return {
        ok: false,
        error: "atomic write failed",
        reason: `refusing to write through symlink at ${ledgerPath}`,
      };
    }
    // Type-guard the ledger path (G1 reviewer MED-1): a directory / fifo / socket
    // pre-placed here would read as "ledger exists" and let migration dispose the
    // monolith while no row can ever be written. Mirror the isFile() guard the
    // monolith quadrant-detection already applies. (#743 Wave 1.)
    if (!lst.isFile()) {
      return {
        ok: false,
        error: "ledger not a regular file",
        reason: `${ledgerPath} exists but is not a regular file (found ${
          lst.isDirectory() ? "directory" : "special file"
        }); refusing — a non-file ledger cannot hold rows`,
      };
    }
    return { ok: true, path: ledgerPath, created: false };
  }
  const result = _atomicWrite(ledgerPath, LEDGER_HEADER);
  if (!result.ok) return { ...result };
  return {
    ok: true,
    path: ledgerPath,
    created: true,
    parent_dir_synced: result.parent_dir_synced,
  };
}

/**
 * Append a row to the forest ledger. The row MUST be the markdown
 * table-row form `| id | owner | item | value_anchor | status |`. The
 * helper stamps `owner` from the identity automatically if the caller
 * passed `null` / empty for that column; explicit owner override is
 * permitted (the merge driver attributes by the column, not the
 * caller).
 *
 * The append is read-modify-write atomic via `<path>.tmp.<pid>` +
 * rename — same semantics as the per-operator fragment write. Under N
 * concurrent appends the last writer wins on the file but the merge
 * driver reconciles at branch-merge time using the per-row stable ID
 * (`row.id`). Caller MUST supply a unique `row.id`; collision detection
 * lives in the merge driver, not here.
 *
 * @param {string} baseDir
 * @param {{display_id?:string, person_id:string, verified_id:string}} identity
 * @param {{id:string, item:string, value_anchor:string, status:string, owner?:string}} row
 * @returns {{ok:true, path:string, parent_dir_synced:boolean} | {ok:false, error:string, reason:string}}
 *   `parent_dir_synced` reports the post-rename parent-dir fsync outcome (loom#742).
 */
function appendForestLedgerRow(baseDir, identity, row) {
  if (!baseDir || typeof baseDir !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "baseDir must be a non-empty string",
    };
  }
  if (!identity || typeof identity !== "object") {
    return {
      ok: false,
      error: "missing identity",
      reason: "identity must be an object",
    };
  }
  if (
    !row ||
    typeof row !== "object" ||
    typeof row.id !== "string" ||
    !row.id ||
    typeof row.item !== "string" ||
    typeof row.value_anchor !== "string" ||
    typeof row.status !== "string"
  ) {
    return {
      ok: false,
      error: "invalid row",
      reason:
        "row must carry non-empty string id and string item/value_anchor/status",
    };
  }

  const ensure = ensureForestLedger(baseDir);
  if (!ensure.ok) return { ...ensure };

  const owner =
    (typeof row.owner === "string" && row.owner) ||
    identity.display_id ||
    identity.person_id ||
    identity.verified_id ||
    "unknown";

  // Escape pipe chars to avoid breaking the markdown table parse on
  // either the merge driver side (coc-ledger.js::parseLedger splits on
  // `|`) or any other reader. Trailing/leading whitespace is also
  // stripped — parseLedger trims cells, but defense in depth.
  const cell = (s) => String(s).replace(/\|/g, "\\|").trim();
  const rowLine = `| ${cell(row.id)} | ${cell(owner)} | ${cell(row.item)} | ${cell(row.value_anchor)} | ${cell(row.status)} |`;

  // Guarded read (R7 MED-1): refuse the append on an oversized/symlinked shared
  // ledger rather than hang inside a synchronous read (teammate-writable path).
  const gLedger = _readNotesFileGuarded(ensure.path);
  if (!gLedger.ok) {
    return {
      ok: false,
      error: "ledger read failed",
      reason:
        gLedger.kind === "oversize"
          ? `ledger exceeds ${NOTES_READ_CAP_BYTES} bytes (${gLedger.size}); refusing append`
          : gLedger.err && gLedger.err.message
            ? gLedger.err.message
            : gLedger.kind,
    };
  }
  const current = gLedger.content;
  // Append AFTER the last existing table row (or after the separator
  // line if the ledger is header-only). The merge driver tolerates
  // trailing blank lines, but writing one preserves human-readable
  // formatting across appends.
  const trimmed = current.endsWith("\n") ? current : current + "\n";
  const next = trimmed + rowLine + "\n";
  const write = _atomicWrite(ensure.path, next);
  if (!write.ok) return { ...write };
  return {
    ok: true,
    path: ensure.path,
    parent_dir_synced: write.parent_dir_synced,
  };
}

// ---- #743 coherence + migration layer -------------------------------------

// Normalize line endings to LF (I8 / M-c): a CRLF monolith round-trips
// byte-for-byte against an LF fragment only after normalization, else the
// conservation assertion below spuriously fails on every \r\n.
function _normalizeLineEndings(s) {
  return String(s == null ? "" : s)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

// Resolve the repo HEAD sha for the I10 lag-anchor stamp. Returns null on any
// git failure (no repo, no commits, git absent) — a MISSING stamp is NOT an
// error (I10: the incorporation guard treats absent last_reconciled_sha as
// "coherent", suppressing the session-one advisory). Never throws.
function _gitHead(baseDir) {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: baseDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Build the per-operator fragment body: an HTML-comment banner + a small
// frontmatter block carrying the I10 lag anchor, then the VERBATIM
// normalized monolith content. The banner opener is a fixed sentinel so the
// block is unambiguously the migration meta (a monolith cannot collide with
// it at byte 0 because we control construction). The content is appended
// as an exact suffix so `body.endsWith(content)` is the I8 conservation
// witness.
function _buildFragmentBody(sha, content, opts) {
  const o = opts || {};
  const meta = [
    "<!-- .session-notes.d fragment — per-operator, single-writer (Shard M6 D §5.1 + #743).",
    "     last_reconciled_sha below is the incorporation-guard lag anchor (C3.2);",
    "     a missing/empty value is treated as coherent (I10), not an error.",
    "     Read-only aggregate view: .session-notes.aggregate.md (gitignored, regenerable). -->",
    "---",
    `last_reconciled_sha: ${sha || ""}`,
  ];
  if (o.migrated) meta.push(`migrated_from: ${MONOLITH_NAME}`);
  meta.push("---", "");
  return meta.join("\n") + "\n" + content;
}

// I8 anti-vanish witness: the constructed fragment MUST contain the FULL
// normalized monolith as a contiguous suffix. Verbatim suffix-containment is
// the strongest form of full-content conservation — every source segment
// (prose + any table) lands, line-ending-normalized. Returns true iff
// conserved.
function _fragmentConservesMonolith(fragmentBody, normalized) {
  if (typeof fragmentBody !== "string") return false;
  if (normalized === "") return true; // empty monolith: nothing to conserve
  return fragmentBody.endsWith(normalized);
}

// Acquire the migration lock via O_EXCL (I7). Returns {ok:true} on acquire,
// {ok:false, reason} on contention (caller fails OPEN — never blocks session
// start). A stale lock (mtime older than MIGRATION_LOCK_STALE_MS) is stolen
// once; `_retried` bounds recursion to a single steal-and-retry.
function _acquireMigrateLock(baseDir, _retried) {
  const lockPath = path.join(baseDir, MIGRATE_LOCK_NAME);
  try {
    const fd = fs.openSync(
      lockPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    try {
      fs.writeSync(fd, `pid=${process.pid} ts=${new Date().toISOString()}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, lockPath };
  } catch (err) {
    if (err && err.code !== "EEXIST") {
      return { ok: false, reason: `migrate lock error: ${err.message}` };
    }
    // EEXIST — another migration holds it. Steal only if stale, and only once.
    if (!_retried) {
      try {
        // Staleness is decided from the timestamp EMBEDDED in the lock body
        // (written once at a known clock reading at acquire), NOT the
        // filesystem mtime — mtime is not a monotonic source (NTP step,
        // manual clock set, network-mount clock skew) and a backward jump
        // could make a LIVE lock look stale and get stolen (G1 security
        // LOW-2). Fall back to mtime only when the body carries no parseable
        // ts (a hand-created / truncated lock).
        let ageMs;
        // Route the lock-body read through the guarded chokepoint (SNC-DID,
        // #743 R19): a symlinked / oversized / non-regular lockPath is REFUSED
        // (guard → body="" → ts unparsed → mtime fallback below) rather than
        // followed into an unbounded read. lockPath is derived from baseDir, so
        // this is the one family-path reader that was still on a bare
        // fs.readFileSync; every other notes reader is already guarded (via this
        // chokepoint or an equivalent inline lstat+type+size guard).
        // The lock is gitignored + per-clone-transient, so the bounded-trust
        // GIT adversary cannot reach it — this is defense-in-depth uniformity,
        // closing the unbounded-CONTENT-read class for this path (the mtime
        // fallback below still stat-follows the symlink, but stat is
        // metadata-only + bounded — not a reader-DoS vector).
        const guardedLock = _readNotesFileGuarded(lockPath);
        const body = guardedLock.ok ? guardedLock.content : "";
        const m = body.match(/\bts=(\S+)/);
        const embeddedMs = m ? Date.parse(m[1]) : NaN;
        // Use the embedded ts ONLY when it is finite AND not implausibly
        // FUTURE (G1 R2 security LOW): a crafted future ts would make ageMs
        // negative → the lock never looks stale → migration deferred forever.
        // A future-dated (or unparseable) ts falls back to filesystem mtime,
        // which ages normally and self-heals a one-shot poison after the stale
        // window. This is the forward mirror of the backward-clock-jump the
        // embedded-ts read fixed (LOW-2): embedded ts defeats a BACKWARD jump;
        // the mtime fallback backstops a FORWARD poison.
        if (
          Number.isFinite(embeddedMs) &&
          embeddedMs <= Date.now() + MIGRATION_LOCK_STALE_MS
        ) {
          ageMs = Date.now() - embeddedMs;
        } else {
          ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        }
        if (ageMs > MIGRATION_LOCK_STALE_MS) {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            /* another racer already stole it; fall through to skip */
          }
          return _acquireMigrateLock(baseDir, true);
        }
      } catch {
        /* read/stat race (lock vanished) — fall through to skip; a fresh run will retry */
      }
    }
    return { ok: false, reason: "migration in progress (lock held)" };
  }
}

function _releaseMigrateLock(baseDir) {
  try {
    fs.unlinkSync(path.join(baseDir, MIGRATE_LOCK_NAME));
  } catch {
    /* best-effort: never mask the migration outcome on a release failure */
  }
}

// Dispose the migrated monolith (Decision A). When the recovery slot is
// absent, rename → .session-notes.migrated (the recoverable local copy,
// gitignored X-2). When it is ALREADY taken (a 4th-quadrant reappearance
// whose content the caller has ALREADY conserved verbatim into the tracked
// fragment), UNLINK the redundant monolith rather than spawning a
// hash-suffixed sibling — this keeps the recovery artifact to ONE exact
// filename (so the .gitignore entry stays exact per I11, no stray tracked
// files) and the unlink is safe because the bytes live in the fragment. The
// FIRST migration's .migrated copy is never clobbered. Returns
// {ok, path|null, disposed} | {ok:false, ...}.
function _disposeMonolith(monolithPath, migratedPath) {
  try {
    // Structural symlink-refusal parity (G1 security MED-1): lstat the
    // recovery-slot path — existsSync/rename would FOLLOW a pre-placed
    // symlink at .session-notes.migrated, making the refusal incidental to
    // rename(2) semantics rather than structural (the same discipline
    // _atomicWrite + the monolith quadrant-guard already apply). Refuse
    // loudly if the recovery slot is a symlink.
    let mlst;
    try {
      mlst = fs.lstatSync(migratedPath);
    } catch (e) {
      if (e && e.code !== "ENOENT") throw e; // ENOENT = absent (happy path)
    }
    if (mlst && mlst.isSymbolicLink()) {
      return {
        ok: false,
        error: "monolith disposition failed",
        reason: `refusing to dispose through symlink at ${migratedPath}`,
      };
    }
    if (mlst) {
      // Recovery slot taken by a prior migration; content already conserved
      // in the fragment → remove the redundant monolith copy.
      fs.unlinkSync(monolithPath);
      return {
        ok: true,
        path: null,
        disposed: "unlinked",
        reason:
          "prior .session-notes.migrated exists; monolith content conserved in fragment, redundant copy removed",
      };
    }
    // Rename preserves the monolith's RAW bytes (CRLF-preserving) — the
    // recovery copy is intentionally byte-verbatim of the original, while the
    // fragment holds the LF-normalized canonical form (G1 reviewer LOW-2).
    fs.renameSync(monolithPath, migratedPath);
    return { ok: true, path: migratedPath, disposed: "renamed" };
  } catch (err) {
    return {
      ok: false,
      error: "monolith disposition failed",
      reason: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Migrate a legacy monolith `.session-notes` into the per-operator split
 * (#743 C1). VERBATIM full-content conservation (I8, Model A): the entire
 * line-ending-normalized monolith lands in the operator's own fragment
 * `.session-notes.d/<display_id>.md`; the shared forest ledger is ensured
 * header-only (it accrues cross-operator rows going forward, never
 * retroactively from a single-writer monolith). `parseLedger` is used only as
 * a non-blocking table-shape probe — NOT as a routing mechanism.
 *
 * Idempotent 4-quadrant state machine (I2), keyed on (monolith present?,
 * split present?):
 *   - (absent, *)          → no-op {migrated:false} (canonical steady state)
 *   - (present, absent)    → CONVERT: fragment = meta + verbatim monolith
 *   - (present, present)   → MERGE: append (or no-op if already conserved),
 *                            then dispose the monolith (rename-away)
 * On convert AND merge the monolith is renamed to .session-notes.migrated, so
 * a re-run sees (absent, present) and no-ops (idempotence by rename-away).
 *
 * @param {string} baseDir - repo or workspace root
 * @param {{display_id?,person_id?,verified_id?}} identity
 * @param {{dryRun?:boolean}} [opts]
 * @returns {{ok:true, migrated:boolean, mode?:string, fragmentPath?:string,
 *            ledgerPath?:string, migratedPath?:string, last_reconciled_sha?:string|null,
 *            tableProbe?:object, dryRun?:boolean, plan?:object, reason?:string}
 *          | {ok:false, error:string, reason:string, ...}}
 */
function migrateMonolithToSplit(baseDir, identity, opts) {
  const o = opts || {};
  const dryRun = !!o.dryRun;

  if (!baseDir || typeof baseDir !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "baseDir must be a non-empty string",
    };
  }
  if (
    !identity ||
    typeof identity !== "object" ||
    (typeof identity.display_id !== "string" &&
      typeof identity.person_id !== "string" &&
      typeof identity.verified_id !== "string")
  ) {
    return {
      ok: false,
      error: "missing identity",
      reason:
        "identity must carry display_id (preferred) or person_id or verified_id",
    };
  }

  const monolithPath = path.join(baseDir, MONOLITH_NAME);
  const migratedPath = path.join(baseDir, MIGRATED_MONOLITH_NAME);
  const fragmentDir = path.join(baseDir, FRAGMENT_DIR_NAME);
  const ledgerPath = path.join(baseDir, SHARED_LEDGER_NAME);

  // Quadrant detection via lstat (symlink-aware, M-f). ENOENT → absent.
  let mst;
  try {
    mst = fs.lstatSync(monolithPath);
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      return {
        ok: false,
        error: "monolith lstat failed",
        reason: err && err.message ? err.message : String(err),
      };
    }
  }
  if (!mst) {
    return {
      ok: true,
      migrated: false,
      reason: "no monolith at canonical path",
    };
  }
  if (mst.isSymbolicLink()) {
    return {
      ok: false,
      error: "refusing to migrate symlink",
      reason: `refusing to migrate through symlink at ${monolithPath} (never write through / read a pre-placed link)`,
    };
  }
  if (!mst.isFile()) {
    return {
      ok: false,
      error: "monolith not a regular file",
      reason: `${monolithPath} is not a regular file (I2 stat-type guard)`,
    };
  }
  // Size cap (R5 FIND-2): .session-notes is TRACKED/shared (NOT gitignored), so a
  // teammate's oversized commit reaches every puller's SessionStart migrate. A
  // synchronous readFileSync cannot be interrupted by the SessionStart Rule-7
  // timer — refuse loudly on oversize (monolith untouched), never hang/OOM.
  // Mirrors the incorporation guard's 1 MB fragment cap; `mst` is already the
  // lstat result, so no extra syscall.
  if (mst.size > NOTES_READ_CAP_BYTES) {
    return {
      ok: false,
      error: "monolith too large",
      reason: `${monolithPath} exceeds ${NOTES_READ_CAP_BYTES} bytes (${mst.size}); refusing migration (monolith untouched)`,
      monolith_untouched: true,
    };
  }

  let raw;
  try {
    raw = fs.readFileSync(monolithPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: "monolith read failed",
      reason: err && err.message ? err.message : String(err),
    };
  }
  const normalized = _normalizeLineEndings(raw);

  // Non-blocking table-shape probe (defense-in-depth; Model A does NOT route
  // the table into the shared ledger, so a parse anomaly never blocks — the
  // verbatim suffix-containment check below is the anti-vanish authority).
  let tableProbe;
  try {
    const p = parseLedger(normalized);
    tableProbe = { hasTable: !!p.hasTable, rows: p.rows ? p.rows.length : 0 };
  } catch (err) {
    tableProbe = { hasTable: false, parse_error: err && err.message };
  }

  const handle =
    identity.display_id || identity.person_id || identity.verified_id;
  const fragmentPath = path.join(
    fragmentDir,
    `${_slugifyForFilename(handle)}.md`,
  );
  // lstat (not existsSync) so a symlink pre-placed at the fragment path is
  // refused BEFORE the merge branch reads through it (G1 security LOW-1) —
  // structural parity with the monolith guard above; _atomicWrite would
  // refuse the eventual write anyway, but this refuses before the read.
  let flst;
  try {
    flst = fs.lstatSync(fragmentPath);
  } catch (e) {
    if (e && e.code !== "ENOENT") {
      return {
        ok: false,
        error: "fragment lstat failed",
        reason: e && e.message ? e.message : String(e),
      };
    }
  }
  if (flst && flst.isSymbolicLink()) {
    return {
      ok: false,
      error: "refusing to migrate through symlink",
      reason: `refusing to read/write through symlink at ${fragmentPath}`,
    };
  }
  const fragmentExists = !!flst;
  const splitExists = fs.existsSync(fragmentDir) || fs.existsSync(ledgerPath);

  const sha = _gitHead(baseDir);

  // Compute the fragment body + mode (no writes yet — dryRun returns here).
  let mode;
  let newFragmentBody;
  let mergeNoop = false;
  if (!splitExists && !fragmentExists) {
    mode = "convert";
    newFragmentBody = _buildFragmentBody(sha, normalized, { migrated: true });
    if (!_fragmentConservesMonolith(newFragmentBody, normalized)) {
      // Anti-vanish (C1.2): leave the monolith UNTOUCHED, refuse loudly.
      return {
        ok: false,
        error: "anti-vanish refuse",
        reason:
          "constructed fragment does not conserve the full monolith content; leaving monolith untouched",
        monolith_untouched: true,
      };
    }
  } else {
    // 4th quadrant (M-b): a monolith reappeared beside an existing split.
    mode = "merge";
    let existing = "";
    if (fragmentExists) {
      // Guarded read (R7 MED-1 — the FIND-2 sibling in this same SessionStart
      // function): the own fragment is tracked; refuse the merge on
      // oversize/symlink (monolith untouched) rather than hang.
      const gFrag = _readNotesFileGuarded(fragmentPath);
      if (!gFrag.ok) {
        return {
          ok: false,
          error: "fragment read failed",
          reason:
            gFrag.kind === "oversize"
              ? `existing fragment exceeds ${NOTES_READ_CAP_BYTES} bytes (${gFrag.size}); refusing merge (monolith untouched)`
              : gFrag.err && gFrag.err.message
                ? gFrag.err.message
                : gFrag.kind,
          monolith_untouched: true,
        };
      }
      existing = gFrag.content;
    }
    if (normalized === "" || existing.includes(normalized)) {
      // Already conserved (partial-failure re-run OR identical restore) —
      // merge is a no-op on the fragment; just dispose the monolith below.
      mergeNoop = true;
      newFragmentBody = existing;
    } else {
      const recovered =
        `\n\n<!-- RECOVERED-MONOLITH: ${MONOLITH_NAME} reappeared beside an existing split; ` +
        `merged at ${sha || "unknown-sha"}. Content conserved verbatim below. -->\n\n` +
        normalized;
      // Frontmatter-first invariant (R5 FIND-1 — lag-anchor spoof defense).
      // parseLastReconciledSha reads the FIRST `---`…`---` block as the C3.2 lag
      // anchor. When this operator has no own fragment yet (existing===""), a bare
      // `existing + recovered` puts attacker-controlled monolith content at byte 0
      // — a crafted `.session-notes` (TRACKED/shared) beginning with
      // `---\nlast_reconciled_sha: <x>\n---` would BECOME that first block and spoof
      // the victim's anchor on next SessionStart migrate. Route through
      // _buildFragmentBody so the genuine last_reconciled_sha is always the first
      // block, in ALL quadrants (the convert path already does this). When
      // existing!=="" the operator's own frontmatter is already byte 0, so an
      // injected block inside the appended content is a later, ignored block.
      newFragmentBody =
        existing === ""
          ? _buildFragmentBody(sha, recovered, { migrated: true })
          : existing + recovered;
      if (!newFragmentBody.endsWith(normalized)) {
        return {
          ok: false,
          error: "anti-vanish refuse",
          reason:
            "merge did not conserve the lingering monolith; leaving monolith untouched",
          monolith_untouched: true,
        };
      }
    }
  }

  if (dryRun) {
    return {
      ok: true,
      migrated: false,
      dryRun: true,
      mode,
      plan: {
        fragmentPath,
        mergeNoop,
        wouldEnsureLedger: !fs.existsSync(ledgerPath),
        wouldDisposeMonolithTo: migratedPath,
        last_reconciled_sha: sha,
        tableProbe,
      },
    };
  }

  // I7 — acquire the migration lock. Fail-open on contention: return a
  // benign {migrated:false} so SessionStart is NEVER blocked (C5.2).
  const lock = _acquireMigrateLock(baseDir);
  if (!lock.ok) {
    return { ok: true, migrated: false, reason: lock.reason };
  }
  try {
    if (!mergeNoop) {
      // Fragment write via the atomic single-writer helper (symlink-guarded).
      const w = writePerOperatorFragment(baseDir, identity, newFragmentBody);
      if (!w.ok) return { ...w }; // monolith untouched (not yet renamed)
    }
    // Ensure the shared ledger exists (header-only). It starts EMPTY —
    // migration never routes monolith rows into it (Model A).
    const ens = ensureForestLedger(baseDir);
    if (!ens.ok) return { ...ens }; // monolith untouched
    // Only now — after the fragment + ledger are durable — dispose the
    // monolith (rename-away → idempotent re-run sees absent monolith).
    const disp = _disposeMonolith(monolithPath, migratedPath);
    if (!disp.ok) return { ...disp };
    return {
      ok: true,
      migrated: true,
      mode,
      merge_noop: mergeNoop,
      fragmentPath,
      ledgerPath: ens.path,
      migratedPath: disp.path,
      last_reconciled_sha: sha,
      tableProbe,
    };
  } finally {
    _releaseMigrateLock(baseDir);
  }
}

// Run `git check-ignore -q -- <name>` from baseDir. Distinguishes the THREE
// outcomes I12a requires (evidence-first-claims.md MUST-3): an errored git
// invocation is ZERO evidence, NOT a "tracked" verdict.
//   exit 0   → "ignored"
//   exit 1   → "not-ignored"
//   128/else → "error"  (not a git repo / bad invocation / git absent)
function _gitCheckIgnore(baseDir, name) {
  const r = spawnSync("git", ["check-ignore", "-q", "--", name], {
    cwd: baseDir,
    timeout: 4000,
  });
  if (r.error) return { status: "error", code: null, reason: r.error.message };
  if (r.status === 0) return { status: "ignored" };
  if (r.status === 1) return { status: "not-ignored" };
  return { status: "error", code: r.status };
}

function _aggregateHeader() {
  return [
    "<!-- .session-notes.aggregate.md — READ-ONLY per-clone aggregate view (#743 C2).",
    "     Regenerated by session-notes-layout.js::regenerateAggregate from the TRACKED",
    "     split (.session-notes.d/<display_id>.md fragments + .session-notes.shared.md",
    "     forest ledger). DO NOT EDIT — edits are overwritten on the next regenerate.",
    "     This file is GITIGNORED (per-clone): editing it here never contends on a",
    "     tracked path (never the knowledge-convergence.md MUST-1 clobber). -->",
    "",
    "# Session Notes — Aggregate View",
  ].join("\n");
}

/**
 * Regenerate the read-only aggregate view (#743 C2 / I3): each per-operator
 * fragment concatenated by display_id + the shared forest ledger, rendered
 * into the GITIGNORED `.session-notes.aggregate.md`.
 *
 * Tracked-guard (I11 / C2.2): before writing, confirm the target is
 * gitignored via `git check-ignore`. REFUSE (typed) if NOT ignored — a
 * tracked aggregate re-introduces the MUST-1 single-shared-file clobber. An
 * errored git invocation is ZERO evidence (I12a) — a DISTINCT typed error,
 * never conflated with "tracked".
 *
 * @param {string} baseDir - repo or workspace root
 * @returns {{ok:true, path:string, fragment_count:number, parent_dir_synced?:boolean}
 *          | {ok:false, error:string, reason:string, git_code?:number|null}}
 */
function regenerateAggregate(baseDir) {
  if (!baseDir || typeof baseDir !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "baseDir must be a non-empty string",
    };
  }

  const aggPath = path.join(baseDir, AGGREGATE_NAME);

  // I11 / I12a tracked-guard — exit 0 ignored / exit 1 refuse / error = zero evidence.
  const ci = _gitCheckIgnore(baseDir, AGGREGATE_NAME);
  if (ci.status === "error") {
    return {
      ok: false,
      error: "git check-ignore errored",
      reason: `cannot confirm ${AGGREGATE_NAME} is gitignored (git ${
        ci.code != null ? `exit ${ci.code}` : ci.reason || "error"
      }); refusing to write — an errored check is ZERO evidence, NOT a 'tracked' verdict (evidence-first-claims.md MUST-3)`,
      git_code: ci.code != null ? ci.code : null,
    };
  }
  if (ci.status === "not-ignored") {
    return {
      ok: false,
      error: "aggregate not gitignored",
      reason: `${AGGREGATE_NAME} is NOT gitignored; refusing to write a TRACKED per-clone view (would re-introduce the knowledge-convergence.md MUST-1 clobber). Add the exact filename to .gitignore.`,
    };
  }
  // ci.status === "ignored" → proceed.

  const fragDir = path.join(baseDir, FRAGMENT_DIR_NAME);
  let fragFiles = [];
  try {
    fragFiles = fs
      .readdirSync(fragDir)
      .filter((f) => f.endsWith(".md"))
      .sort(); // deterministic by-name order (by display_id)
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      return {
        ok: false,
        error: "fragment dir read failed",
        reason: err && err.message ? err.message : String(err),
      };
    }
  }

  const sections = [_aggregateHeader()];
  for (const f of fragFiles) {
    // Guarded read (R7 MED-1): a teammate-committed oversized or symlinked
    // fragment would otherwise hang/OOM this SessionStart reader. Skip it and
    // render the rest (fail-open — the aggregate is a best-effort view).
    const g = _readNotesFileGuarded(path.join(fragDir, f));
    if (!g.ok) continue;
    const body = g.content;
    const displayId = f.replace(/\.md$/, "");
    sections.push(
      `\n## Fragment — ${displayId}\n\n${body.replace(/\n+$/, "")}\n`,
    );
  }

  if (fs.existsSync(ledgerPath0(baseDir))) {
    // Guarded read (R7 MED-1): the shared ledger is teammate-writable; skip on
    // oversize/symlink so a bloated ledger cannot hang this SessionStart reader.
    const gl = _readNotesFileGuarded(ledgerPath0(baseDir));
    const led = gl.ok ? gl.content : "";
    if (led) {
      sections.push(
        `\n## Forest Ledger (${SHARED_LEDGER_NAME})\n\n${led.replace(/\n+$/, "")}\n`,
      );
    }
  }

  const w = _atomicWrite(aggPath, sections.join("\n") + "\n");
  if (!w.ok) return { ...w };
  return {
    ok: true,
    path: aggPath,
    fragment_count: fragFiles.length,
    parent_dir_synced: w.parent_dir_synced,
  };
}

// Small helper so regenerateAggregate reads the ledger path once, consistently.
function ledgerPath0(baseDir) {
  return path.join(baseDir, SHARED_LEDGER_NAME);
}

/**
 * Resolve the per-operator fragment path for an identity, using the EXACT SAME
 * filename derivation `writePerOperatorFragment` / `migrateMonolithToSplit`
 * apply (handle = display_id || person_id || verified_id, slugified via
 * `_slugifyForFilename`). Exported so a READER — e.g. the #743 Wave-2
 * incorporation guard — derives the same path the WRITER produced, from ONE
 * source of truth, instead of replicating the slugify (which would drift
 * silently the moment the slug rules change). Returns null when no usable
 * handle is present (fail-safe: the caller treats null as "no own fragment" →
 * coherent / suppress, never a throw). Pure: no I/O, no side effects.
 *
 * @param {string} baseDir - repo or workspace root
 * @param {{display_id?:string, person_id?:string, verified_id?:string}} identity
 * @returns {string|null} absolute fragment path, or null if underivable
 */
function fragmentPathFor(baseDir, identity) {
  if (!baseDir || typeof baseDir !== "string") return null;
  if (!identity || typeof identity !== "object") return null;
  const handle =
    identity.display_id || identity.person_id || identity.verified_id;
  if (!handle || typeof handle !== "string") return null;
  return path.join(
    baseDir,
    FRAGMENT_DIR_NAME,
    `${_slugifyForFilename(handle)}.md`,
  );
}

module.exports = {
  FRAGMENT_DIR_NAME,
  SHARED_LEDGER_NAME,
  LEDGER_HEADER,
  MONOLITH_NAME,
  AGGREGATE_NAME,
  MIGRATED_MONOLITH_NAME,
  MIGRATE_LOCK_NAME,
  MIGRATION_LOCK_STALE_MS,
  NOTES_READ_CAP_BYTES,
  // The single guarded-read chokepoint for TRACKED/shared session-notes paths.
  // Exported so EVERY reader (incl. the incorporation guard) routes through ONE
  // symlink+size guard — closing the reader class by construction (R8).
  readNotesFileGuarded: _readNotesFileGuarded,
  writePerOperatorFragment,
  writeReconciledFragment,
  ensureForestLedger,
  appendForestLedgerRow,
  migrateMonolithToSplit,
  regenerateAggregate,
  fragmentPathFor,
};
