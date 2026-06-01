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

const FRAGMENT_DIR_NAME = ".session-notes.d";
const SHARED_LEDGER_NAME = ".session-notes.shared.md";

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
    return { ok: true };
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
 * @returns {{ok:true, path:string} | {ok:false, error:string, reason:string}}
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
  return { ok: true, path: fragmentPath };
}

/**
 * Ensure the forest-ledger file exists at
 * `<baseDir>/.session-notes.shared.md`. If absent, create it with the
 * header-only template (zero rows). Idempotent: no-op if file present.
 *
 * @param {string} baseDir
 * @returns {{ok:true, path:string, created:boolean} | {ok:false, error:string, reason:string}}
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
    return { ok: true, path: ledgerPath, created: false };
  }
  const result = _atomicWrite(ledgerPath, LEDGER_HEADER);
  if (!result.ok) return { ...result };
  return { ok: true, path: ledgerPath, created: true };
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
 * @returns {{ok:true, path:string} | {ok:false, error:string, reason:string}}
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

  let current;
  try {
    current = fs.readFileSync(ensure.path, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: "ledger read failed",
      reason: err && err.message ? err.message : String(err),
    };
  }
  // Append AFTER the last existing table row (or after the separator
  // line if the ledger is header-only). The merge driver tolerates
  // trailing blank lines, but writing one preserves human-readable
  // formatting across appends.
  const trimmed = current.endsWith("\n") ? current : current + "\n";
  const next = trimmed + rowLine + "\n";
  const write = _atomicWrite(ensure.path, next);
  if (!write.ok) return { ...write };
  return { ok: true, path: ensure.path };
}

module.exports = {
  FRAGMENT_DIR_NAME,
  SHARED_LEDGER_NAME,
  LEDGER_HEADER,
  writePerOperatorFragment,
  ensureForestLedger,
  appendForestLedgerRow,
};
