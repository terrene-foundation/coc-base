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
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env.js");
const { parseLedger } = require("./coc-ledger.js");
// A2 — the LOG this file is now the projection OF. `foldProjection` is imported
// rather than re-implemented so the C5 weight fence (a migration_baseline event
// never overwrites a live one) is applied by ONE walker; a second fold here would
// be free to disagree about which event wins, which is precisely the drift the
// log/projection split exists to remove.
// `KINDS` is imported rather than restated: the narrowing validates a declared
// kind against the schema's CLOSED set, and a second copy here would drift the
// first time a kind is added — accepting a kind the fold cannot produce, or
// refusing one it can.
// `statusKey` is imported for the same reason: `exclude_statuses` compares a
// manifest-declared status against a PROJECTED one, and the projection's own fence
// (`projectStatus`) already normalizes with it. Comparing by raw equality here would
// let `"Signed off "` and `"Signed off"` — indistinguishable in a rendered GFM cell —
// take different branches in the two places that read the same value.
const {
  EVENTS_REL,
  foldProjection,
  KINDS,
  statusKey,
  partitionSkips,
} = require("./burndown-events.js");

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
  const body = _buildFragmentBody(sha.trim(), content, { identity });
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
 * Locate the ledger TABLE inside the shared-ledger text.
 *
 * Mirrors `burndown-build.mjs::parseLedger`'s discipline deliberately, because the
 * two must agree by construction: that file is the gate that decides whether a row
 * is reachable, and a writer that inserts where the gate does not read produces
 * rows that render to a human and resolve for nobody.
 *
 *   - FENCED CODE IS NOT LEDGER. A `| … id … |` header inside a ```-fence renders to
 *     a human as a DOCUMENTATION EXAMPLE; the gate skips fences, so this must too.
 *   - EVERY candidate, not the first. Two candidate tables is an AMBIGUITY, and the
 *     gate REFUSES rather than picking. A writer that picked would append into a
 *     table the gate does not read.
 *   - By header NAME, never by column position — the `coc-ledger` merge driver is
 *     entitled to reorder columns.
 *
 * Returns `{ok:true, headerAt, cols, idAt, lastRowAt, rows:Map<id,lineIdx>}` or
 * `{ok:false, kind}` with `kind` ∈ `"none" | "ambiguous"`.
 */
function _locateLedgerTable(text) {
  const lines = String(text || "").split(/\r?\n/);

  const inFence = new Array(lines.length).fill(false);
  {
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*(`{3,}|~{3,})/);
      if (fence === null && m) {
        fence = m[1][0];
        inFence[i] = true;
        continue;
      }
      if (fence !== null) {
        inFence[i] = true;
        if (m && m[1][0] === fence) fence = null;
      }
    }
  }

  const candidates = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (inFence[i] || !/^\s*\|/.test(lines[i])) continue;
    const cols = _splitLedgerRow(lines[i]).map((c) => c.toLowerCase());
    if (!cols.includes("id")) continue;
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    candidates.push({ at: i, cols });
  }
  if (candidates.length === 0) return { ok: false, kind: "none" };
  if (candidates.length > 1) return { ok: false, kind: "ambiguous" };

  const headerAt = candidates[0].at;
  const cols = candidates[0].cols;
  const idAt = cols.indexOf("id");
  const rows = new Map();
  let lastRowAt = headerAt + 1; // the separator; a header-only ledger inserts after it
  for (let i = headerAt + 2; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) {
      if (lines[i].trim() === "") continue; // a blank line inside the section is not the end
      break;
    }
    lastRowAt = i;
    const cells = _splitLedgerRow(lines[i]);
    const id = _stripCellDecoration(cells[idAt]);
    if (id && !rows.has(id)) rows.set(id, i);
  }
  return { ok: true, headerAt, cols, idAt, lastRowAt, rows };
}

/**
 * Split a GFM table row on UNESCAPED pipes only — the same rule the gate applies.
 *
 * A bare `.split("|")` was the highest-value defeat the gate's parser had: GFM says
 * `\|` inside a cell renders as a literal pipe and does NOT split the cell, so a
 * naive split hands the reader a different cell than the reviewer adjudicates. The
 * writer escapes pipes on the way in (`cell()` below), so it MUST un-escape them the
 * same way on the way out or an id containing a pipe would never match itself.
 */
function _splitLedgerRow(line) {
  const body = String(line)
    .trim()
    .replace(/^\|/, "")
    .replace(/\|\s*$/, "");
  const cells = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Backticks / bold / link syntax are TYPOGRAPHY; the id binds the STRING. */
function _stripCellDecoration(cell) {
  let s = (cell || "").trim();
  s = s.replace(/^\[([^\]]*)\]\([^)]*\)$/, "$1");
  s = s.replace(/^[*_`]+/, "").replace(/[*_`]+$/, "");
  return s.trim();
}

/** Render one ledger row line from its cells. The SINGLE renderer, so the
 * no-op fast path in `upsertForestLedgerRow` compares like with like. */
function _renderLedgerRow(id, owner, item, valueAnchor, status) {
  // Escape pipe chars to avoid breaking the markdown table parse on
  // either the merge driver side (coc-ledger.js::parseLedger splits on
  // `|`) or any other reader. Trailing/leading whitespace is also
  // stripped — parseLedger trims cells, but defense in depth.
  //
  // LINE BREAKS ARE ESCAPED FOR THE SAME REASON, AND ONE MORE. A markdown
  // table row IS a line: an embedded LF ends the row mid-cell, so the pipe
  // escape alone left the row-structure half of this contract open. It also
  // silently unbinds ROWS from LINES, and the whole MUST-3 ceiling is stated
  // in LINES — `regenerateForestLedger` counts one row as one line, and the
  // refusal message it prints does that arithmetic out loud. MEASURED before
  // this escape existed: ten checklist-shaped todos (the
  // `PostToolUse:TodoWrite` producer sets `item: t.content` VERBATIM, and
  // `validateEvent` accepts a newline in any field) folded to 268 rows — under
  // the 277-row ceiling — and rendered 541 LINES, past MUST-3's 300 by 241,
  // with the generator returning `ok: true`.
  //
  // ESCAPE, not REJECT, and the choice is load-bearing. Rejecting a newline at
  // `validateEvent` would refuse to record an ordinary multi-line todo, and
  // rejecting one at fold time would take the WHOLE projection unrenderable
  // over one already-committed event — content loss and a hard stop where the
  // defect is purely one of presentation. The escape keeps every byte of the
  // item, on ONE line, visibly escaped.
  //
  // HTML COMMENT MARKERS ARE ESCAPED FOR THE LEDGER GRAMMAR. `validate-forest-ledger.mjs` refuses
  // any ledger line carrying `<!--` or `-->` (a comment hides rows while the text still shows),
  // and a todo such as "migrate A --> B" reached this renderer verbatim — a generated row the
  // operator could not fix by hand, since the next regeneration rewrites it
  // (review-cor-rS-MED-2). In ordinary markdown text a backslash before `!` / `>` renders as the
  // bare character, so the row reads the same; inside a code span it renders literally.
  // Not reversed on read — see coc-ledger.js::_splitTableCells for why (same as `\n`).
  const cell = (s) =>
    String(s)
      .replace(/\|/g, "\\|")
      .replace(/\r\n|\r|\n/g, "\\n")
      .replace(/<!--/g, "<\\!--")
      .replace(/-->/g, "--\\>")
      .trim();
  return `| ${cell(id)} | ${cell(owner)} | ${cell(item)} | ${cell(valueAnchor)} | ${cell(status)} |`;
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

  const rowLine = _renderLedgerRow(
    row.id,
    owner,
    row.item,
    row.value_anchor,
    row.status,
  );

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
  // Insert AFTER the last existing table row (or after the separator line if the
  // ledger is header-only).
  //
  // This USED to be a bare append at end-of-file, which is identical whenever the
  // ledger table is the last content in the file — true of the header-only ledger
  // this helper creates, and true of the shared ledger today. It is NOT guaranteed:
  // the moment any prose follows the table, an EOF append lands a `| … |` line
  // OUTSIDE the table, where `burndown-build.mjs::parseLedger` stops reading. The
  // gate would then report `LINK-1 no row with ID` for a row plainly present in the
  // file — a loud failure, but one that sends an operator to grep a ledger that
  // visibly contains the row. Inserting where the gate READS removes the class.
  const loc = _locateLedgerTable(current);
  let next;
  if (loc.ok) {
    const lines = current.split(/\r?\n/);
    lines.splice(loc.lastRowAt + 1, 0, rowLine);
    next = lines.join("\n");
  } else {
    // No locatable table (or an AMBIGUOUS one). Fall back to the historical EOF
    // append rather than refusing: this helper's contract is to land the row, and
    // an unlocatable table is a pre-existing condition of the ledger, not of the
    // row. The gate reports the consequence either way.
    const trimmed = current.endsWith("\n") ? current : current + "\n";
    next = trimmed + rowLine + "\n";
  }
  if (!next.endsWith("\n")) next += "\n";
  const write = _atomicWrite(ensure.path, next);
  if (!write.ok) return { ...write };
  return {
    ok: true,
    path: ensure.path,
    parent_dir_synced: write.parent_dir_synced,
  };
}

/**
 * ID-KEYED UPSERT of a forest-ledger row — the shape a PRODUCER needs, and the
 * reason `appendForestLedgerRow` alone could not be one.
 *
 * MEASURED, not asserted: `burndown-build.mjs::parseLedger` REFUSES a tracker that
 * "declares ledger row '<id>' more than once" — a duplicate id makes that id's
 * anchor ambiguous, and a checker picking either would certify a context artifact
 * the other row does not name. A producer firing on every todo status transition
 * with an APPEND-ONLY writer would therefore append a second row for the same id on
 * the first `pending → in_progress` and break the whole 267-item chain. So the
 * append contract does not fit a producer, and this is the missing half — NOT a
 * second writer. `appendForestLedgerRow` IS the insert leaf below, which is what
 * gives that helper the production caller it has never had.
 *
 * Three outcomes, and `changed` separates them because a no-op write is not free:
 * the tracker is a DECLARED burndown source held to `assertCommittedAndUnmodified`,
 * so any write — even one restoring identical bytes — would be a modification
 * against HEAD that takes the generator UNRUNNABLE. Re-rendering an unchanged row
 * MUST therefore be a genuine no-op that touches no file.
 *
 *   { ok:true, changed:false, action:"unchanged" }  — byte-identical row present
 *   { ok:true, changed:true,  action:"updated" }    — row present, cells differed
 *   { ok:true, changed:true,  action:"inserted" }   — row absent
 *
 * @param {string} baseDir
 * @param {{display_id?:string, person_id?:string, verified_id?:string}} identity
 * @param {{id:string, item:string, value_anchor:string, status:string, owner?:string}} row
 */
function upsertForestLedgerRow(baseDir, identity, row) {
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

  const gLedger = _readNotesFileGuarded(ensure.path);
  if (!gLedger.ok) {
    return {
      ok: false,
      error: "ledger read failed",
      reason:
        gLedger.kind === "oversize"
          ? `ledger exceeds ${NOTES_READ_CAP_BYTES} bytes (${gLedger.size}); refusing upsert`
          : gLedger.err && gLedger.err.message
            ? gLedger.err.message
            : gLedger.kind,
    };
  }

  const current = gLedger.content;
  const loc = _locateLedgerTable(current);
  // AMBIGUOUS is a REFUSAL, not a fall-through to append. Which table is THE ledger
  // would then be decided by position, so a table added above the real one silently
  // becomes the one this producer writes into. The gate refuses the same input for
  // the same reason; a writer that guessed where the reader refuses is worse than
  // one that stops.
  if (!loc.ok && loc.kind === "ambiguous") {
    return {
      ok: false,
      error: "ambiguous ledger",
      reason: `${ensure.path} carries more than one candidate ledger table; refusing to guess which is authoritative`,
    };
  }

  const owner =
    (typeof row.owner === "string" && row.owner) ||
    (identity &&
      (identity.display_id || identity.person_id || identity.verified_id)) ||
    "unknown";
  const rowLine = _renderLedgerRow(
    row.id,
    owner,
    row.item,
    row.value_anchor,
    row.status,
  );

  const at = loc.ok ? loc.rows.get(row.id) : undefined;
  if (at === undefined) {
    const res = appendForestLedgerRow(baseDir, identity, row);
    return res.ok ? { ...res, changed: true, action: "inserted" } : res;
  }

  const lines = current.split(/\r?\n/);
  if (lines[at] === rowLine) {
    return { ok: true, changed: false, action: "unchanged", path: ensure.path };
  }
  lines[at] = rowLine;
  let next = lines.join("\n");
  if (!next.endsWith("\n")) next += "\n";
  const write = _atomicWrite(ensure.path, next);
  if (!write.ok) return { ...write };
  return {
    ok: true,
    changed: true,
    action: "updated",
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
// loom#1471 (s49). LOCAL profile — `rev-parse HEAD` against a repository
// already on disk. An ambient `GIT_DIR` outranked `cwd`, so the SHA stamped as
// `last_reconciled_sha` was the DECOY repository's HEAD; the incorporation
// guard then measured the operator's notes against a foreign commit.
function _gitHead(baseDir) {
  const gitBin = resolveGitBinary();
  // Rule 7 fail-OPEN, and already this function's contract: a MISSING stamp is
  // not an error (see the note above).
  if (!gitBin) return null;
  try {
    const out = execFileSync(gitBin, ["rev-parse", "HEAD"], {
      cwd: baseDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
      env: gitEnv(),
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
  // knowledge-convergence.md Rule 1: the FILENAME is advisory signage; the
  // frontmatter is the authoritative attribution surface. `display_id`
  // collisions are explicitly harmless (multi-operator-coordination.md §1),
  // so a filename-derived identity is an index key the corpus permits to be
  // ambiguous. Stamping person_id + verified_id makes the fragment
  // self-describing and survives copy/rename/migration. Emitted ONLY when an
  // identity is supplied, so callers that pass none keep byte-identical
  // output (backward compatible with pre-existing fragments).
  const id = o.identity;
  if (id && typeof id === "object") {
    if (typeof id.person_id === "string" && id.person_id) {
      meta.push(`person_id: ${id.person_id}`);
    }
    if (typeof id.verified_id === "string" && id.verified_id) {
      meta.push(`verified_id: ${id.verified_id}`);
    }
    if (typeof id.display_id === "string" && id.display_id) {
      meta.push(`display_id: ${id.display_id}`);
    }
  }
  if (o.migrated) meta.push(`migrated_from: ${MONOLITH_NAME}`);
  meta.push("---", "");
  return meta.join("\n") + "\n" + content;
}

/**
 * Read the AUTHORITATIVE operator attribution out of a fragment body.
 *
 * knowledge-convergence.md Rule 1 + multi-operator-coordination.md §1:
 * tooling MUST attribute via `person_id` / `verified_id`, NEVER by stripping
 * the filename. Returns nulls for a legacy fragment written before the
 * frontmatter stamp existed, so callers can fall back to the filename for
 * DISPLAY while never treating that fallback as attribution.
 *
 * @param {string} body
 * @returns {{person_id: string|null, verified_id: string|null, display_id: string|null}}
 */
function readFragmentAttribution(body) {
  const out = { person_id: null, verified_id: null, display_id: null };
  if (typeof body !== "string") return out;
  // Only the leading frontmatter block is authoritative — a later `---`
  // fence in prose must not be read as identity.
  const start = body.indexOf("\n---\n");
  if (start === -1) return out;
  const rest = body.slice(start + 5);
  const end = rest.indexOf("\n---");
  const block = end === -1 ? rest : rest.slice(0, end);
  for (const line of block.split("\n")) {
    const m = /^(person_id|verified_id|display_id):\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
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
    newFragmentBody = _buildFragmentBody(sha, normalized, {
      migrated: true,
      identity,
    });
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
          ? _buildFragmentBody(sha, recovered, { migrated: true, identity })
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
// loom#1471 (s49). LOCAL profile, and the tri-state above is preserved exactly:
// an unresolved binary is "error", which this module already ranks as ZERO
// evidence rather than a "tracked" verdict. Same named narrowing as
// `gitignored-claude-warn.js` — GIT_CONFIG_GLOBAL=/dev/null drops a global
// `core.excludesFile`, and `check-ignore` cannot use the config profile
// (outside CONFIG_PROFILE_SUBCOMMANDS; gitConfigInvocation() throws).
function _gitCheckIgnore(baseDir, name) {
  const gitBin = resolveGitBinary();
  if (!gitBin) {
    return { status: "error", code: null, reason: "no git binary resolved" };
  }
  const r = spawnSync(gitBin, ["check-ignore", "-q", "--", name], {
    cwd: baseDir,
    timeout: 4000,
    env: gitEnv(),
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
    // knowledge-convergence.md Rule 1: attribute from the FRONTMATTER, never
    // by stripping the filename. `display_id` collisions are legal
    // (multi-operator-coordination.md §1), so two humans sharing a handle
    // land on one filename and a filename-derived heading silently presents
    // them as one operator. The stem remains the DISPLAY label (it is
    // signage, and legacy fragments carry no stamp), but the authoritative
    // person_id is rendered alongside it whenever the fragment declares one.
    const stem = f.replace(/\.md$/, "");
    const attr = readFragmentAttribution(body);
    const label = attr.person_id
      ? `${attr.display_id || stem} (${attr.person_id})`
      : stem;
    sections.push(`\n## Fragment — ${label}\n\n${body.replace(/\n+$/, "")}\n`);
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

// ---- A2: the forest ledger as a DERIVED PROJECTION -------------------------
//
// ── WHAT CHANGES, AND WHY IT IS THE SAME FILE ────────────────────────────────
//
// `.session-notes.shared.md` was a PROJECTION PRETENDING TO BE A LOG: at once the
// evidence `burndown-build.mjs --check-links` computes a verified count from, and
// a live mutable work surface anyone could hand-edit. A2 splits the two — the LOG
// is `burndown/events.jsonl` (append-only, signed, off the `.session-notes*`
// namespace per C4) and this file becomes its FOLD, regenerated and never
// hand-edited.
//
// The path does NOT move, and that is forced rather than chosen. MEASURED at this
// shard's landing: `burndown-build.mjs` line 745 calls
// `assertCommittedAndUnmodified(repo, trackerRel)` on `manifest.tracker.path`
// before reading it. So the projection MUST stay TRACKED and COMMITTED — the
// untracked fold-cache half of C3's disposition would take the gate UNRUNNABLE.
// That measurement is what decides C3 in `.gitattributes`; it is not a preference.
//
// ── WHY A NO-OP MUST TOUCH NO BYTES ──────────────────────────────────────────
//
// The same assertion is why `regenerateForestLedger` compares BYTES and returns
// `changed:false` without writing when the projection is already correct. A write
// that restored identical content would still be a modification against HEAD, and
// the gate would refuse from the first regeneration until someone committed —
// leak T1, reintroduced by the fix for T2. `upsertForestLedgerRow` carries the
// same discipline for the same reason.
//
// ── HOW IT COEXISTS WITH `migrateMonolithToSplit` ────────────────────────────
//
// Two migrations now live in this module and neither replaces the other:
//
//   `migrateMonolithToSplit`  legacy `.session-notes` MONOLITH → the split.
//                             Model A: it routes NO rows into the shared ledger;
//                             it only ENSURES one exists, header-only.
//   `regenerateForestLedger`  the event LOG → the shared ledger's rows.
//
// Their SOURCES are disjoint (a monolith's prose vs the signed log), so they never
// contend over content. They share the ONE mutex — `MIGRATE_LOCK_NAME` — because
// they share a destination, and the lock is taken at TOP LEVEL by each, NEVER
// nested: `migrateMonolithToSplit` acquires and releases inside its own
// try/finally, so a regeneration invoked from inside it would EEXIST against its
// own lock. Callers sequence the two calls; they do not nest them.
//
// ORDER DOES NOT MATTER, which is what makes the coexistence safe rather than
// lucky. `ensureForestLedger` writes ONLY when the ledger is absent (it returns
// `created:false` otherwise), so a migration running AFTER a regeneration cannot
// clobber the projection back to a header-only file. Both are idempotent, by two
// different mechanisms: the monolith migration by rename-away, the regeneration by
// byte-comparison.

// Size cap for the event-log read. The log is append-only and UNBOUNDED by
// construction, so it gets its OWN cap rather than borrowing the 1 MB
// `NOTES_READ_CAP_BYTES` (which exists for hand-sized session-notes files and
// which this log — 414 KB at landing — would cross on ordinary growth). Refuse
// loudly above it; never truncate-then-fold, which would silently drop the tail of
// the log and render a projection missing rows that the gate would then report as
// vanished (`knowledge-convergence.md` MUST-6 refuse-don't-truncate).
const EVENTS_READ_CAP_BYTES = 32 * 1024 * 1024;

/**
 * `session-notes-continuity.md` MUST-3's FAIL-CLOSED default, in LINES.
 *
 * The rule is explicit: "until a ceiling is declared for a given projection, the
 * 300-line ceiling above applies to it unchanged". So an undeclared projection is
 * bounded, not unbounded — the absent declaration is the strict case, never the
 * permissive one.
 */
const PROJECTION_LINE_CEILING_FALLBACK = 300;

/** The generator's manifest — where a projection DECLARES its own ceiling. */
const PROJECTION_MANIFEST_REL = "burndown-manifest.json";

/**
 * The OUTER bound on what a manifest may DECLARE, in lines.
 *
 * MUST-3 lets a projection declare its own ceiling; it does NOT let a declaration
 * repeal the clause. Without an upper bound `max_rows: 100000` is a well-formed
 * declaration and the bound is gone — validated only as `Number.isInteger && >= 1`,
 * which admits every number a mistake or an edit could put there.
 *
 * 3× the rule's own default is the line drawn, and it is a POLICY constant with a
 * stated rationale rather than a derived one: MUST-3's argument is that a bounded
 * file is what makes MUST-2's read-it-whole affordable, and an exception more than
 * three times the rule's own bound has stopped being a narrowing and become an
 * opt-out. A declaration past it falls back to the 300-line default — the same
 * fail-CLOSED direction absent, malformed and unverifiable take.
 */
const PROJECTION_DECLARED_LINE_CAP = 3 * PROJECTION_LINE_CEILING_FALLBACK;

/** Cap for the manifest read itself — it is a small JSON file, not a log. */
const MANIFEST_READ_CAP_BYTES = 1024 * 1024;

/**
 * Is `rel` COMMITTED and UNMODIFIED against HEAD, and a regular file in the index?
 *
 * This is `burndown-build.mjs::assertCommittedAndUnmodified` re-expressed for a hook
 * that may not refuse: same three clauses (index mode, tracked-by-string-compare,
 * clean against HEAD), typed result instead of a throw. It is here because
 * `security.md` § Enforcement-Surface Parity names exactly this shape — EVERY
 * manifest read in `burndown-build.mjs` carries the guard and `_readEventsGuarded`
 * in this same call chain refuses a symlinked LOG, while the ceiling's own manifest
 * read carried neither. The bound MUST-3 makes fail-closed on ABSENCE was fail-OPEN
 * on a working-tree-only manifest: an uncommitted `{"tracker":{"max_rows":100000}}`
 * lifted it, measured.
 *
 * It is NOT imported from `burndown-build.mjs`: that file is an ESM `bin/` entrypoint
 * with no export surface, so requiring it would execute its CLI — the same reason
 * `burndown-events.js` mirrors the status vocabulary rather than importing it.
 *
 * UNVERIFIABLE is not CLEAN. No git binary, no repository, a timeout — each returns
 * `{ok:false}`, so the declaration is not honoured. That direction is the whole
 * point: a ceiling that trusts a manifest it could not verify is the fail-open this
 * function exists to close.
 */
function _gitCommittedAndUnmodified(baseDir, rel) {
  const gitBin = resolveGitBinary();
  if (!gitBin)
    return { ok: false, kind: "unverifiable", why: "no git binary on PATH" };
  const run = (args) => {
    try {
      return {
        ok: true,
        out: execFileSync(gitBin, args, {
          cwd: baseDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 4000,
          env: gitEnv(),
        }),
      };
    } catch (err) {
      return { ok: false, err };
    }
  };
  const staged = run(["ls-files", "-s", "--", rel]);
  if (!staged.ok) {
    return {
      ok: false,
      kind: "unverifiable",
      why: "git ls-files failed (not a repository?)",
    };
  }
  const first = String(staged.out).split("\n")[0] || "";
  if (!first.trim())
    return {
      ok: false,
      kind: "untracked",
      why: `'${rel}' is not tracked by git`,
    };
  const mode = (first.match(/^(\d{6})\s/) || [])[1];
  // Mode 120000 is a SYMLINK in the index. git hashes the link TEXT while the reader
  // follows it to the TARGET, so a committed-and-clean symlink is a manifest whose
  // content nobody reviewed — the BUG-3 shape `assertCommittedAndUnmodified` names.
  if (mode === "120000")
    return {
      ok: false,
      kind: "symlink-in-index",
      why: `'${rel}' is a symlink in the index`,
    };
  if (mode && mode !== "100644" && mode !== "100755") {
    return {
      ok: false,
      kind: "bad-mode",
      why: `'${rel}' has git mode ${mode}`,
    };
  }
  // STRING COMPARE, not `--error-unmatch`: on a case-insensitive filesystem
  // `--error-unmatch` on a wrong-case path reads identically to untracked.
  const listedPath = first.includes("\t")
    ? first.slice(first.indexOf("\t") + 1).trim()
    : "";
  if (listedPath !== rel) {
    return {
      ok: false,
      kind: "untracked",
      why: `git ls-files returned '${listedPath}', not '${rel}'`,
    };
  }
  const clean = run(["diff", "--quiet", "HEAD", "--", rel]);
  if (!clean.ok)
    return {
      ok: false,
      kind: "modified",
      why: `'${rel}' has uncommitted modifications against HEAD`,
    };
  return { ok: true };
}

/**
 * Guarded read of the ceiling manifest — the parity sibling of `_readEventsGuarded`.
 * Symlink / non-regular / oversize / unreadable / malformed / uncommitted each get a
 * NAMED kind, because the caller turns the kind into the `ceiling_source` string a
 * reader uses to tell a DECLARED ceiling from a fallback that merely looks like one.
 */
function _readManifestGuarded(baseDir, rel) {
  const abs = path.join(baseDir, rel);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: false, kind: "absent" };
    return { ok: false, kind: "stat-failed" };
  }
  if (st.isSymbolicLink()) return { ok: false, kind: "symlink" };
  if (!st.isFile()) return { ok: false, kind: "not-a-file" };
  if (st.size > MANIFEST_READ_CAP_BYTES) return { ok: false, kind: "oversize" };
  const git = _gitCommittedAndUnmodified(baseDir, rel);
  if (!git.ok) return { ok: false, kind: git.kind, why: git.why };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return { ok: false, kind: "malformed" };
  }
  return { ok: true, doc };
}

/**
 * The projection's fixed per-file overhead, in lines, DERIVED rather than pinned.
 *
 * A hardcoded constant here would be a second copy of a number that
 * `renderForestLedgerProjection` already determines, and it would go stale silently
 * the first time a line is added to the header — converting a declared row ceiling
 * into a line ceiling nobody re-measured. Rendering an EMPTY projection asks the
 * renderer itself, so the two cannot drift.
 */
function _ledgerHeaderLines() {
  const empty = renderForestLedgerProjection(new Map(), {});
  const body = empty.endsWith("\n") ? empty.slice(0, -1) : empty;
  return body.split("\n").length;
}

/**
 * Resolve the ceiling this projection is held to — MUST-3's "a ceiling DECLARED in
 * its generator's manifest".
 *
 * DECLARED wins; ABSENT, UNREADABLE, MALFORMED, UNVERIFIABLE and OUT-OF-RANGE all
 * fall back to the 300-line default. That direction is load-bearing: a manifest that
 * will not parse — or that no git object backs — must not read as "no ceiling", which
 * is how a fail-closed bound becomes a fail-open one.
 *
 * BOTH bounds come back, because the rule's unit and the manifest's unit differ.
 * MUST-3 bounds a projection in LINES; `tracker.max_rows` declares ROWS. Those agree
 * only while one row renders as exactly one line, which `_renderLedgerRow` now
 * guarantees and which the caller nonetheless MEASURES rather than assumes — a
 * ceiling that cannot see its own line count is the defect, not the number.
 *
 * @returns {{maxRows:number, maxLines:number, source:string, declared:boolean,
 *            headerLines:number}}
 */
function _resolveProjectionCeiling(baseDir) {
  const headerLines = _ledgerHeaderLines();
  const fallbackFor = (why) => ({
    maxRows: PROJECTION_LINE_CEILING_FALLBACK - headerLines,
    maxLines: PROJECTION_LINE_CEILING_FALLBACK,
    source:
      `session-notes-continuity.md MUST-3 fail-closed default ` +
      `(${PROJECTION_LINE_CEILING_FALLBACK} lines − ${headerLines} header lines); ${why}`,
    declared: false,
    headerLines,
  });
  const g = _readManifestGuarded(baseDir, PROJECTION_MANIFEST_REL);
  if (!g.ok) {
    return fallbackFor(
      g.kind === "absent"
        ? `no ${PROJECTION_MANIFEST_REL} to declare one`
        : `${PROJECTION_MANIFEST_REL} is ${g.kind}${g.why ? ` (${g.why})` : ""} — an unverifiable ` +
            `declaration is NOT honoured, it falls back`,
    );
  }
  const declaredRows =
    g.doc && g.doc.tracker ? g.doc.tracker.max_rows : undefined;
  if (!Number.isInteger(declaredRows) || declaredRows < 1) {
    return fallbackFor(
      `no usable 'tracker.max_rows' in ${PROJECTION_MANIFEST_REL}`,
    );
  }
  const declaredLines = declaredRows + headerLines;
  if (declaredLines > PROJECTION_DECLARED_LINE_CAP) {
    return fallbackFor(
      `${PROJECTION_MANIFEST_REL}::tracker.max_rows declares ${declaredRows} row(s) = ` +
        `${declaredLines} line(s), past the ${PROJECTION_DECLARED_LINE_CAP}-line cap on what a ` +
        `declaration may claim; a declaration does not repeal MUST-3`,
    );
  }
  return {
    maxRows: declaredRows,
    maxLines: declaredLines,
    source: `${PROJECTION_MANIFEST_REL}::tracker.max_rows`,
    declared: true,
    headerLines,
  };
}

/**
 * ── THE DECLARED NARROWING (loom s67, finding S66-1) ─────────────────────────
 *
 * The refusal above names TWO sanctioned ways back under the ceiling — retire an
 * item, or "DECLARE a narrowing of what the projection renders". Only the first
 * was implemented. An operator following the refusal's own advice could not take
 * the route it recommended, which is worse than offering one route, because the
 * message reads as a choice.
 *
 * WHY A NARROWING IS THE PRINCIPLED REMEDY HERE, not a way to duck the bound.
 * MEASURED: the log folds 267 `genesis` item_ids (the burndown REGISTER, and
 * exactly `tracker.min_rows`) and 100 `transition` item_ids keyed in a DIFFERENT
 * namespace — todo and workspace paths (`todo-42ca4f878990-real-work`,
 * `_archive/…`) — with ZERO overlap. `min_rows: 267` / `max_rows: 277` were
 * calibrated against the register, before a second namespace began landing in the
 * same projection. The ceiling did not become wrong; THE ROW SET STOPPED BEING
 * THE THING IT BOUNDED. Narrowing restores the row set to what the bound was
 * measured for, rather than widening the bound to fit a set nobody sized.
 *
 * FAIL-CLOSED MEANS RENDER EVERYTHING. Every failure path here returns
 * `{narrowed: false}` — absent manifest, unverifiable manifest, malformed key,
 * unknown kind, a declaration that would render nothing. A narrowing that cannot
 * be verified is NOT honoured, because a silently-narrowed projection is
 * byte-indistinguishable from a complete one, and "some rows are missing and
 * nothing says so" is this codebase's most-named failure class. The ceiling
 * resolver fails the same way for the same reason; this mirrors it deliberately.
 *
 * IT CANNOT REPEAL THE CEILING. Narrowing chooses WHICH rows render; the ceiling
 * still measures the RENDER and still refuses. A declaration that narrows to a
 * set still over the bound refuses exactly as before.
 */
function _resolveProjectionNarrowing(baseDir) {
  const none = (why) => ({ narrowed: false, why, kinds: null, source: null });
  const g = _readManifestGuarded(baseDir, PROJECTION_MANIFEST_REL);
  if (!g.ok) {
    return none(
      g.kind === "absent"
        ? `no ${PROJECTION_MANIFEST_REL} to declare one`
        : `${PROJECTION_MANIFEST_REL} is ${g.kind}${g.why ? ` (${g.why})` : ""} — an unverifiable ` +
            `declaration is NOT honoured, it renders everything`,
    );
  }
  const decl = g.doc && g.doc.tracker ? g.doc.tracker.narrowing : undefined;
  if (decl === undefined)
    return none(`no 'tracker.narrowing' in ${PROJECTION_MANIFEST_REL}`);
  if (!decl || typeof decl !== "object" || Array.isArray(decl)) {
    return none(
      `'tracker.narrowing' is not an object — malformed, so it renders everything`,
    );
  }
  const kinds = decl.render_kinds;
  if (
    !Array.isArray(kinds) ||
    kinds.length === 0 ||
    !kinds.every((k) => typeof k === "string" && k)
  ) {
    return none(
      `'tracker.narrowing.render_kinds' must be a non-empty array of strings — malformed, ` +
        `so it renders everything`,
    );
  }
  // A kind outside the schema's CLOSED set is a typo, and a typo that silently
  // matched nothing would narrow the projection to zero rows while reporting a
  // clean declaration. Refuse the declaration instead.
  const unknown = kinds.filter((k) => !KINDS.includes(k));
  if (unknown.length > 0) {
    return none(
      `'tracker.narrowing.render_kinds' names ${unknown.map((k) => JSON.stringify(k)).join(", ")}, ` +
        `not in the schema's kinds (${KINDS.join(", ")}) — so it renders everything rather than ` +
        `narrowing to a set a typo chose`,
    );
  }
  const reason =
    typeof decl.reason === "string" && decl.reason.trim()
      ? decl.reason.trim()
      : null;
  if (!reason) {
    return none(
      `'tracker.narrowing.reason' is required and must be a non-empty string — a narrowing with no ` +
        `stated reason is not auditable, so it renders everything`,
    );
  }
  // ── THE SECOND AXIS: `exclude_statuses` (loom s68) ─────────────────────────
  //
  // `render_kinds` narrows BETWEEN namespaces (register vs. not). This narrows
  // WITHIN one, by the status the projection actually renders, and it is a
  // separate axis because the two answer different questions: the first asks
  // "is this row's ID one the ceiling was sized for", the second asks "does this
  // row's cell carry an adjudication a reader can act on".
  //
  // OPTIONAL, and its ABSENCE is not a narrowing — an absent key leaves the
  // declaration exactly as strong as it was before this axis existed, so an
  // existing manifest keeps its meaning.
  //
  // MALFORMED renders everything, matching `render_kinds` above: an unverifiable
  // declaration is never honoured, because a silently-narrowed projection is
  // byte-indistinguishable from a complete one.
  //
  // WHY THERE IS NO CLOSED-SET CHECK HERE, and why that is not the `render_kinds`
  // typo hole reopened. A status is NOT a closed set — `projectStatus` passes a
  // `todo:` work-state through verbatim, so an allowlist would have to enumerate a
  // vocabulary the fold does not own. The failure directions are therefore
  // OPPOSITE and only one of them is dangerous: a `render_kinds` typo narrows to a
  // set the typo chose (fewer rows, silently), while an `exclude_statuses` typo
  // matches nothing and excludes NOTHING (MORE rows), which walks into the ceiling
  // and REFUSES out loud. Refusing a zero-match declaration outright was considered
  // and REJECTED: it turns the moment an operator finishes adjudicating the last
  // excluded row into a build failure, which is the shape `_min_rows_note` already
  // names as the gate an operator switches off. Instead the per-status match count
  // is RENDERED in the projection header, so a typo reads as `…: 0 row(s)` in the
  // artifact itself rather than passing unseen.
  const rawStatuses = decl.exclude_statuses;
  let statusKeys = null;
  let statusesDeclared = null;
  if (rawStatuses !== undefined) {
    if (
      !Array.isArray(rawStatuses) ||
      rawStatuses.length === 0 ||
      !rawStatuses.every((s) => typeof s === "string" && s.trim())
    ) {
      return none(
        `'tracker.narrowing.exclude_statuses', when present, must be a non-empty array of non-empty ` +
          `strings — malformed, so it renders everything`,
      );
    }
    statusesDeclared = rawStatuses.map((s) => s.trim());
    statusKeys = new Set(statusesDeclared.map((s) => statusKey(s)));
  }
  return {
    narrowed: true,
    kinds: new Set(kinds),
    statusKeys,
    statusesDeclared,
    reason,
    source: `${PROJECTION_MANIFEST_REL}::tracker.narrowing`,
    why: null,
  };
}

/**
 * Guarded read of the event log. Same three refusals `_readNotesFileGuarded`
 * applies — symlink, non-regular file, oversize — against this log's own cap.
 * Returns a TYPED result; never throws, never returns partial content.
 */
function _readEventsGuarded(absPath) {
  let st;
  try {
    st = fs.lstatSync(absPath);
  } catch (err) {
    if (err && err.code === "ENOENT")
      return { ok: false, kind: "missing", err };
    return { ok: false, kind: "stat-failed", err };
  }
  if (st.isSymbolicLink()) return { ok: false, kind: "symlink" };
  if (!st.isFile()) return { ok: false, kind: "not-a-file" };
  if (st.size > EVENTS_READ_CAP_BYTES) {
    return { ok: false, kind: "oversize", size: st.size };
  }
  try {
    return { ok: true, content: fs.readFileSync(absPath, "utf8") };
  } catch (err) {
    return { ok: false, kind: "read-failed", err };
  }
}

/**
 * Render the whole projection file from folded rows. PURE — text in, text out, no
 * I/O — so a fixture can assert the bytes without a repo.
 *
 * The table shape is IDENTICAL to `LEDGER_HEADER`'s: same `# Forest Ledger`
 * heading `validate-forest-ledger.mjs::SHARED_HEADING_RE` matches, same five
 * columns `burndown-build.mjs::parseLedger` reads BY NAME. Only the HTML comment
 * differs, and it differs because the two surfaces are now genuinely different
 * artifacts: `LEDGER_HEADER` heads a HAND-EDITED forest ledger (the workspace-level
 * ledgers, which keep the `coc-ledger` row-merge because row-merge is right
 * semantics THERE), and this heads a DERIVED one. One header for two contracts
 * would have to lie to one of them.
 *
 * The row count is embedded deliberately: this file is a `session-notes-continuity.md`
 * MUST-2 surface where a TRUNCATED Read carries `block` teeth, so a reader who
 * needs only the denominator can take it from line ~8 instead of reading 290 lines
 * to count rows.
 */
function renderForestLedgerProjection(rows, opts) {
  const o = opts || {};
  const list = Array.from(rows.values());
  const header = [
    "<!--",
    "  .session-notes.shared.md — Forest Ledger. GENERATED — DO NOT HAND-EDIT.",
    "",
    `  DERIVED PROJECTION of the append-only log \`${o.eventsRel || "burndown/events.jsonl"}\`, written`,
    "  ONLY by `session-notes-layout.js::regenerateForestLedger`. A hand-edit is not",
    "  preserved: the next regeneration overwrites it and it left no event, so it is",
    "  lost with no witness. NOT the verification input — the LOG is; a gate reading",
    "  this file as evidence would be certifying its own output.",
    "",
    `  Rows: ${list.length}. Each is the fold of every event carrying that ID. The ID column`,
    "  is the join key `burndown-build.mjs --check-links` resolves on; `owner` is",
    "  UNSIGNED convenience attribution (the per-event signature is authoritative).",
    "",
    // ── THE NARROWING, STATED IN THE ARTIFACT ITSELF ────────────────────────
    // A narrowed projection MUST NOT be byte-indistinguishable from a complete
    // one. The count of what was excluded and the declared reason are rendered
    // HERE, in the generated header, so a reader holding only this file can see
    // that it is partial and by how much — never having to infer it from a row
    // they expected and did not find.
    ...(o.narrowing
      ? [
          `  NARROWED: this projection renders ${list.length} of ${o.narrowing.total} folded row(s);`,
          `  ${o.narrowing.excluded} are EXCLUDED by ${o.narrowing.source}.`,
          // ── THE COLLAPSED CLASSES, ONE SUMMARY LINE EACH ─────────────────
          // A per-declared-status count, seeded at 0, so the header answers WHICH
          // class was collapsed and HOW MANY rows it stood for — not merely that
          // some number of rows is missing. A declared status matching `0 row(s)`
          // is a typo or a finished class, and reads as one HERE rather than
          // passing as a clean declaration.
          ...(o.narrowing.statusTally && o.narrowing.statusTally.length
            ? o.narrowing.statusTally.map(
                ([s, n]) => `    collapsed by status "${s}": ${n} row(s).`,
              )
            : []),
          `  Declared reason: ${o.narrowing.reason}`,
          "  The excluded rows are NOT lost — they remain in the log and fold normally;",
          "  this file simply does not render them. Remove the declaration to see them all.",
          // ONE row, without regenerating anything: the log is grep-able by id. The
          // sentence names the LOG and not a tool path on purpose — a `.claude/bin/**`
          // invocation here would be an obligation on every lane this module ships to,
          // and `in-force-check.mjs::artifact-names-tool` measures that the named tool
          // reaches NONE of the seven. Telling a reader to run something they do not
          // have is the W4 failure mode; the grep works everywhere the log does.
          `  To recover ONE row without regenerating: grep its id in \`${o.eventsRel || "burndown/events.jsonl"}\`.`,
          "",
        ]
      : []),
    "  MERGE: NO `merge=coc-ledger` binding (see .gitattributes). A row-keyed 3-way",
    "  merge of a PROJECTION yields a table that is the fold of NEITHER branch's log —",
    "  a fabricated state that merges CLEANLY. On a conflict take either side and",
    "  REGENERATE; the log is what merges. `--check` re-derives and reports drift.",
    "-->",
    "",
    "# Forest Ledger",
    "",
    "| ID | owner | item | value_anchor | status |",
    "| --- | --- | --- | --- | --- |",
  ];
  const body = list.map((r) =>
    _renderLedgerRow(r.id, r.owner, r.item, r.anchorRaw, r.status),
  );
  return `${header.concat(body).join("\n")}\n`;
}

/**
 * Regenerate `.session-notes.shared.md` from the event log — A2.
 *
 * MODES:
 *   `{ check: true }`  read-only. Re-derives and compares, returning `in_sync`.
 *                      This is the answer to the C3 finding that a fabricated
 *                      projection "is detectable only by regenerating": it makes
 *                      regenerating a check anyone can run. It takes NO lock (it
 *                      writes nothing) and it NEVER fails open — an unreadable log
 *                      returns `{ok:false}`, because an `in_sync:true` from an
 *                      instrument that could not look is exactly the
 *                      non-discriminating check `instrument-discipline.md` MUST-1
 *                      forbids citing.
 *   default            write mode. Atomic `.tmp` + `rename()` via `_atomicWrite`
 *                      (`knowledge-convergence.md` MUST-1's write primitive), under
 *                      the shared migrate lock, and a NO-OP when already correct.
 *
 * @param {string} baseDir - repo root (the log is resolved relative to it)
 * @param {{check?:boolean, eventsRel?:string}} [opts]
 * @returns {{ok:true, action:"unchanged"|"written"|"deferred", changed:boolean,
 *            rows:number, lines:number, skipped:Array, path:string} |
 *           {ok:true, check:true, in_sync:boolean, rows:number, lines:number,
 *            skipped:Array, drift:object|null, path:string} |
 *           {ok:false, error:string, reason:string}}
 */
function regenerateForestLedger(baseDir, opts) {
  const o = opts || {};
  const check = !!o.check;
  if (!baseDir || typeof baseDir !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "baseDir must be a non-empty string",
    };
  }
  const eventsRel = o.eventsRel || EVENTS_REL;
  const eventsAbs = path.join(baseDir, eventsRel);
  const g = _readEventsGuarded(eventsAbs);
  if (!g.ok) {
    return {
      ok: false,
      error: "event log unreadable",
      reason:
        g.kind === "missing"
          ? `${eventsRel} is absent; the projection has no log to fold and REFUSES rather than rendering an empty table (an empty table is indistinguishable from "every item closed")`
          : g.kind === "oversize"
            ? `${eventsRel} exceeds ${EVENTS_READ_CAP_BYTES} bytes (${g.size}); refusing to fold a truncated log`
            : g.kind === "symlink"
              ? `refusing to read the event log through a symlink at ${eventsAbs}`
              : g.kind === "not-a-file"
                ? `${eventsRel} is not a regular file`
                : (g.err && g.err.message) || g.kind,
    };
  }

  const folded = foldProjection(g.content);
  // A malformed line is a REFUSAL, not a quiet omission. `foldProjection` records
  // skips rather than dropping them, and a projection rendered over a log with
  // unreadable lines would be short exactly those rows — which the gate reports as
  // `LINK-1 no row with ID`, sending an operator to grep a log that plainly
  // contains the item. Surface it here, where the cause is still in hand.
  //
  // ONLY an UNREADABLE skip refuses. `skipped[]` also carries WELL-FORMED records a
  // fold fence declined — an inert proposal awaiting its countersignature, a fenced
  // activation, a baseline genesis under a live row — and none of those is a row this
  // projection should carry, so rendering over them is short nothing. Refusing on the
  // bare count refused the shipped ledger over a log whose every line read clean: one
  // pending proposal (`burndown/events.jsonl` line 635) turned `forest-ledger-project.mjs
  // --check` into "event log has unreadable lines". The class comes from the PRODUCER
  // (`burndown-events.js::partitionSkips`), never from matching `why` prose here, and an
  // entry with no known class is counted as unreadable — fail closed.
  const skipClasses = partitionSkips(folded);
  const unreadable = [...skipClasses.unreadable, ...skipClasses.unclassified];
  if (unreadable.length > 0) {
    return {
      ok: false,
      error: "event log has unreadable lines",
      reason:
        `${unreadable.length} line(s) of ${eventsRel} could not be read: ` +
        unreadable
          .slice(0, 5)
          .map((s) => `line ${s.line}: ${s.why}`)
          .join("; ") +
        (unreadable.length > 5 ? ` (+${unreadable.length - 5} more)` : "") +
        ". Refusing to render a projection that would be short those rows.",
      skipped: folded.skipped,
    };
  }

  // ── THE CEILING: REFUSE TO EMIT, NEVER TRUNCATE ────────────────────────────
  // `session-notes-continuity.md` MUST-3. A projection's length is a function of
  // ANOTHER file's bytes, so the hand-authored overflow remedy — relocate content,
  // leave a pointer — is silently reverted by the next regeneration. The bound has to
  // live where the generator can enforce it, and enforcement has to be a REFUSAL:
  // truncating would drop rows with no diff, which is exactly the hand-removal
  // `burndown-traceability.md` MUST-6 forbids, performed automatically.
  //
  // It refuses in CHECK mode too. A `--check` that answered `in_sync: true` over an
  // over-ceiling projection would certify the breach as healthy — an instrument
  // reporting on a different question than the one it was read for.
  //
  // The two sanctioned ways back under are named in the refusal itself, because an
  // operator who reaches this branch with no remedy in hand will reach for the one
  // the rule forbids.
  //
  // IT IS MEASURED ON THE RENDER, NOT PREDICTED FROM THE ROW COUNT. The render moved
  // ABOVE this check for exactly that reason. MUST-3 bounds LINES; the manifest
  // declares ROWS; the two agree only while one row is one line, and when that
  // invariant broke — an unescaped LF in an item cell — a row check could not see it:
  // MEASURED at 268 rows (under a 277-row ceiling) rendering 541 LINES, past the
  // 300-line bound by 241, with `ok: true` returned and the refusal message's own
  // `rows + headerLines` arithmetic understating the file by 250. `_renderLedgerRow`
  // now escapes the newline, so the invariant holds again — and this check no longer
  // DEPENDS on it holding, which is the difference between a bound and an assumption.
  // ── THE DECLARED NARROWING, APPLIED BEFORE THE RENDER ──────────────────────
  // Chooses WHICH rows render. It does NOT touch `folded.rows` (the fold's
  // population, and the premise `tracker.min_rows` rests on), and it does NOT
  // repeal the ceiling below — the ceiling still MEASURES THE RENDER and still
  // refuses. A narrowing to a set that is still over the bound refuses exactly as
  // an un-narrowed one does.
  //
  // Membership is `registerIds` — "ever carried a genesis event" — not the winning
  // event's kind, so a register item that later receives a `transition` keeps
  // rendering. See `_walk`'s `registerIds` note for why the distinction is the
  // difference between a narrowing and a silent eviction.
  const narrowing = _resolveProjectionNarrowing(baseDir);
  let renderRows = folded.rows;
  let excluded = 0;
  let statusTally = null;
  if (narrowing.narrowed) {
    const keepGenesis = narrowing.kinds.has("genesis");
    const kept = new Map();
    // Per-DECLARED-status match counts, seeded at 0 for EVERY declared status so a
    // status that matched nothing renders as `0 row(s)` rather than vanishing from
    // the header. A declaration that silently matched nothing would be an inert
    // narrowing reporting itself as an active one.
    if (narrowing.statusKeys) {
      statusTally = new Map(narrowing.statusesDeclared.map((s) => [s, 0]));
    }
    for (const [id, row] of folded.rows) {
      const inRegister = folded.registerIds ? folded.registerIds.has(id) : true;
      const inKind = keepGenesis ? inRegister : !inRegister;
      if (!inKind) continue;
      // The status axis applies only to rows the KIND axis kept — the two compose,
      // and a row excluded by kind is not counted twice.
      if (
        narrowing.statusKeys &&
        narrowing.statusKeys.has(statusKey(row.status))
      ) {
        for (const s of narrowing.statusesDeclared) {
          if (statusKey(s) === statusKey(row.status))
            statusTally.set(s, statusTally.get(s) + 1);
        }
        continue;
      }
      kept.set(id, row);
    }
    excluded = folded.rows.size - kept.size;
    // A declaration that would render NOTHING is refused rather than honoured: an
    // empty projection is indistinguishable from "every item closed", the same
    // reason an absent event log refuses above instead of rendering an empty table.
    if (kept.size === 0) {
      return {
        ok: false,
        error: "narrowing renders nothing",
        reason:
          `${narrowing.source} would exclude all ${folded.rows.size} folded row(s), leaving an EMPTY ` +
          `projection — which is indistinguishable from "every item closed". REFUSING to emit; the ` +
          `projection on disk is UNCHANGED. Widen 'render_kinds' or remove the declaration.`,
        rows: folded.rows.size,
        excluded,
      };
    }
    renderRows = kept;
  }

  const next = renderForestLedgerProjection(renderRows, {
    eventsRel,
    narrowing: narrowing.narrowed
      ? {
          excluded,
          total: folded.rows.size,
          reason: narrowing.reason,
          source: narrowing.source,
          statusTally: statusTally ? Array.from(statusTally) : null,
        }
      : null,
  });
  const lines = next.endsWith("\n")
    ? next.slice(0, -1).split("\n").length
    : next.split("\n").length;
  const ceiling = _resolveProjectionCeiling(baseDir);
  // MEASURED ON WHAT RENDERS, not on what folded. Under a narrowing those differ,
  // and the bound is a bound on the PROJECTION — the artifact a human reads —
  // never on the log's population. Comparing the folded size here would refuse a
  // projection that is comfortably inside the bound, which is the same
  // wrong-quantity error one level up from the one that produced this finding.
  if (renderRows.size > ceiling.maxRows || lines > ceiling.maxLines) {
    const overRows = renderRows.size > ceiling.maxRows;
    return {
      ok: false,
      error: "projection ceiling exceeded",
      reason:
        `the event log folds to ${folded.rows.size} row(s)` +
        (narrowing.narrowed
          ? `, of which ${renderRows.size} render after ${narrowing.source} excluded ${excluded}`
          : ``) +
        `, which RENDERS ${lines} line(s) — past the ` +
        (overRows
          ? `ceiling of ${ceiling.maxRows} row(s) (${ceiling.maxLines} line(s))`
          : `${ceiling.maxLines}-line ceiling, though the row count ${renderRows.size} is within the ` +
            `${ceiling.maxRows}-row bound: the rows carry embedded line breaks`) +
        ` set by ${ceiling.source}. REFUSING to emit; the projection on disk is UNCHANGED and no row ` +
        `was truncated. Two sanctioned ways under it: append an event to '${eventsRel}' that RETIRES an ` +
        `item (the fold shrinks, then the projection does), or DECLARE a narrowing of what the projection ` +
        `renders. Deleting rows from the projection is BLOCKED — it is reverted on the next regeneration ` +
        `and the work they recorded is gone with no diff to show it.`,
      rows: folded.rows.size,
      lines,
      max_rows: ceiling.maxRows,
      max_lines: ceiling.maxLines,
      over: overRows ? "rows" : "lines",
      ceiling_source: ceiling.source,
      ceiling_declared: ceiling.declared,
    };
  }

  const ledgerPath = ledgerPath0(baseDir);

  let current = null;
  const gl = _readNotesFileGuarded(ledgerPath);
  // `_readNotesFileGuarded` collapses ENOENT into `kind:"stat-error"`, so ABSENT is
  // read off `err.code` rather than the kind. That distinction is load-bearing: an
  // absent ledger is the first-run happy path, while any OTHER stat error is a file
  // we could not look at — and reporting `in_sync:false` (or clobbering) against a
  // file we could not read would be a verdict from an instrument that never saw its
  // subject.
  if (gl.ok) current = gl.content;
  else if (!(gl.kind === "stat-error" && gl.err && gl.err.code === "ENOENT")) {
    return {
      ok: false,
      error: "ledger unreadable",
      reason:
        gl.kind === "oversize"
          ? `${SHARED_LEDGER_NAME} exceeds ${NOTES_READ_CAP_BYTES} bytes (${gl.size})`
          : (gl.err && gl.err.message) || gl.kind,
    };
  }

  if (check) {
    const inSync = current === next;
    return {
      ok: true,
      check: true,
      in_sync: inSync,
      rows: renderRows.size,
      folded_rows: folded.rows.size,
      excluded_rows: excluded,
      lines,
      skipped: folded.skipped,
      drift: inSync ? null : _describeLedgerDrift(current, next, folded.rows),
      path: ledgerPath,
    };
  }

  if (current === next) {
    return {
      ok: true,
      action: "unchanged",
      changed: false,
      rows: renderRows.size,
      folded_rows: folded.rows.size,
      excluded_rows: excluded,
      lines,
      skipped: folded.skipped,
      path: ledgerPath,
    };
  }

  // Same mutex as `migrateMonolithToSplit` — one destination, one lock — taken at
  // TOP LEVEL, never nested inside it. Fail OPEN on contention so a SessionStart is
  // never blocked; the write is idempotent, so the next run lands it.
  const lock = _acquireMigrateLock(baseDir);
  if (!lock.ok) {
    return {
      ok: true,
      action: "deferred",
      changed: false,
      rows: renderRows.size,
      folded_rows: folded.rows.size,
      excluded_rows: excluded,
      lines,
      skipped: folded.skipped,
      path: ledgerPath,
      reason: lock.reason,
    };
  }
  try {
    const w = _atomicWrite(ledgerPath, next);
    if (!w.ok) return { ...w };
    return {
      ok: true,
      action: "written",
      changed: true,
      rows: renderRows.size,
      folded_rows: folded.rows.size,
      excluded_rows: excluded,
      lines,
      skipped: folded.skipped,
      path: ledgerPath,
      parent_dir_synced: w.parent_dir_synced,
    };
  } finally {
    _releaseMigrateLock(baseDir);
  }
}

/**
 * Describe HOW a committed projection differs from its re-derivation, bounded.
 *
 * The counts are the load-bearing part: `extra` names ids present in the FILE and
 * absent from the LOG, which is the signature of BOTH failure modes C3 names — a
 * hand-edit, and a merge that fabricated rows belonging to neither branch's fold.
 * `missing` names the reverse. `changed` names ids in both whose cells differ.
 */
function _describeLedgerDrift(current, next, foldedRows) {
  const rowsOf = (text) => {
    const m = new Map();
    if (typeof text !== "string") return m;
    const loc = _locateLedgerTable(text);
    if (!loc.ok) return m;
    const lines = text.split(/\r?\n/);
    for (const [id, at] of loc.rows) m.set(id, lines[at]);
    return m;
  };
  const cur = rowsOf(current);
  const nxt = rowsOf(next);
  const missing = [];
  const extra = [];
  const changed = [];
  for (const id of nxt.keys()) if (!cur.has(id)) missing.push(id);
  for (const id of cur.keys()) if (!nxt.has(id)) extra.push(id);
  for (const [id, line] of nxt)
    if (cur.has(id) && cur.get(id) !== line) changed.push(id);
  const CAP = 10;
  // THE OTHER HALF OF `in_sync` (fixed 2026-10-03). `in_sync` is a WHOLE-FILE
  // byte compare, while the three counts above compare ROWS ONLY — two
  // different facts, and only the row half was reported, so a preamble-only
  // drift (the regenerated header counts above the table) produced an all-zero
  // report beside `in_sync:false`: a reader saw "nothing further" while the
  // file provably differed. These fields carry the difference itself, whatever
  // changed — a header count, a blank line, or a row.
  let firstDifferingLines = null;
  if (current !== null && current !== next) {
    const a = String(current).split(/\r?\n/);
    const b = String(next).split(/\r?\n/);
    const n = Math.max(a.length, b.length);
    const sample = [];
    for (let i = 0; i < n && sample.length < CAP; i += 1) {
      if (a[i] !== b[i])
        sample.push({
          line: i + 1,
          file: a[i] === undefined ? null : a[i],
          fold: b[i] === undefined ? null : b[i],
        });
    }
    firstDifferingLines = sample;
  }
  return {
    file_absent: current === null,
    missing_from_file: missing.length,
    extra_in_file: extra.length,
    cells_differ: changed.length,
    first_differing_lines: firstDifferingLines,
    sample: {
      missing_from_file: missing.slice(0, CAP),
      extra_in_file: extra.slice(0, CAP),
      cells_differ: changed.slice(0, CAP),
    },
    folded_rows: foldedRows.size,
  };
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
  // The id-keyed producer surface. `appendForestLedgerRow` is its INSERT leaf —
  // that call is what gives the append helper a production caller, closing the
  // `artifact-stranding.md` MUST-3 instance it had been standing as.
  upsertForestLedgerRow,
  locateLedgerTable: _locateLedgerTable,
  migrateMonolithToSplit,
  // A2 — the SECOND migration in this module, which COEXISTS with the monolith
  // migration above rather than replacing it (disjoint sources, one shared mutex,
  // order-independent, each idempotent by its own mechanism). This is the SOLE
  // sanctioned writer of the derived projection; `--check` re-derives without
  // writing, which is what makes a hand-edit or a merge-fabricated table detectable.
  regenerateForestLedger,
  renderForestLedgerProjection,
  EVENTS_READ_CAP_BYTES,
  regenerateAggregate,
  fragmentPathFor,
  // knowledge-convergence.md Rule 1: the authoritative attribution surface is
  // the fragment's frontmatter, NEVER its filename. Consumers that need to
  // know WHOSE fragment this is MUST route through this reader.
  readFragmentAttribution,
};
