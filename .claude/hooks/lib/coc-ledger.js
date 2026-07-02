#!/usr/bin/env node
/**
 * coc-ledger — 3-way merge driver for `.session-notes.shared.md` forest ledger.
 *
 * Shard M6 D (workspaces/multi-operator-coc, design v11 §5.1).
 *
 * Git invokes a merge driver as:
 *   coc-ledger.js %O %A %B
 * where %O is the common ancestor, %A is "ours" (current, written in-place
 * on resolution), %B is "theirs". Exit 0 on clean resolve; non-zero on
 * unresolvable conflict (caller falls back to standard `merge=union` or
 * manual). The driver writes the resolved bytes to %A.
 *
 * %P (the merged file's repo-relative path) is DELIBERATELY NOT registered in
 * the driver command: it is unused here AND, via the `workspaces/*` gitattributes
 * binding, a shell-injection surface (a maliciously-named directory) under the
 * bounded-trust threat model. See .gitattributes. (loom#741 R1 security)
 *
 * The forest ledger is a markdown table of rows, each carrying a
 * per-row `owner:` token used by the merge driver for conflict-marker
 * output. Per Sec-LOW-1 (M6 D, 2026-05-22): this `owner:` cell is
 * UNSIGNED. It is a convenience attribution surface for human readers
 * and the driver's conflict markers — NOT a forensic witness.
 * Authoritative attribution lives in the coordination log's signed
 * slot-record + body-anchor pair
 * (.claude/learning/coordination-log.jsonl); a ledger row without a
 * matching coordination-log slot proves nothing about who claimed the
 * row. The 3-way merge:
 *
 *   1. Parse the table region (between two `| --- |` separators OR by
 *      header detection) in O, A, and B.
 *   2. For each row, key by stable ID column (first column).
 *   3. Resolve per-row per attribution:
 *      - Row only in A → keep A (our addition).
 *      - Row only in B → keep B (their addition).
 *      - Row in O+A (unchanged in B) → keep A.
 *      - Row in O+B (unchanged in A) → keep B.
 *      - Row in A+B, both changed from O but owners differ → conflict
 *        markered (`<<<<<<< owner=alice` … `=======` … `>>>>>>> owner=bob`).
 *      - Row in A+B, both changed identically → take either.
 *      - Row in O but missing from A AND B → drop (both closed it).
 *      - Row in O but missing from A only → kept as deleted-by-us (drop).
 *      - Row in O but missing from B only → kept as deleted-by-them (drop).
 *
 * Non-table prose outside the table region is reconciled via standard
 * line union: lines present in either A or B are kept; lines only in O
 * (deleted in both) are dropped. This is correct for the forest-ledger
 * format which has bounded prose around a single table region.
 *
 * Exit codes:
 *   0  — clean merge written to %A
 *   1  — conflict markered into %A (caller resolves manually)
 *   2  — fatal parse failure (e.g., O / A / B malformed); caller falls
 *        back to standard merge driver
 *
 * Per zero-tolerance.md Rule 3: every failure mode returns a typed
 * disposition; no silent fallback to "take ours" or "take theirs".
 *
 * This file is BOTH a library (exports parseLedger, merge3) AND an
 * executable git merge driver (when invoked with %O %A %B argv).
 */

"use strict";

const fs = require("fs");

// ---- table parsing ---------------------------------------------------------

/**
 * Parse a forest-ledger markdown body into:
 *   { preamble, header, separator, rows, trailer }
 * where rows is an array of { rawLine, id, owner, cells }.
 *
 * The table region is detected as: a header row (`| ... | ... |`)
 * immediately followed by a separator row (`| --- | --- |`). The first
 * column is the row ID; the `owner:` cell value (if any column header
 * matches /^owner$/i) is extracted; otherwise owner defaults to
 * "unknown". The `owner:` cell is unsigned — see header docs above for
 * the authoritative-attribution path (coordination-log.jsonl).
 *
 * Lines outside the table are preserved as preamble (before header) and
 * trailer (after the last table row).
 */
// Split a markdown-table row into trimmed, UNESCAPED cells. The forest-ledger
// writer (session-notes-layout.js::appendForestLedgerRow `cell()`) escapes
// literal pipes `|` -> `\|` so an embedded pipe does not read as a column
// delimiter. This splits on UNESCAPED `|` only (negative lookbehind) and then
// reverses the escape per cell (`\|` -> `|`), making it the exact inverse of
// the writer. Without the lookbehind + unescape, a pipe-bearing cell
// (value `A|B`, written to disk as `A\|B`) is silently split into two cells —
// a lossy round-trip that corrupts merge3 (the live .session-notes.shared.md
// merge driver) and any monolith->split migration reusing this parser.
// (#743 Wave 0 / F1; journal/0391.)
//
// CONTRACT DEPENDENCY (reader<->writer pair — keep in lockstep with
// session-notes-layout.js `cell()`): this inverse is correct ONLY while the
// writer (a) escapes `|`->`\|` and NOTHING ELSE (does not escape `\`), and
// (b) space-pads every field (`| ${cell} |`). (a) makes every in-cell `|`
// provably originate from a `\|`; (b) makes every delimiter `|` space-preceded,
// so the one-char `(?<!\\)` lookbehind never mis-classifies a delimiter as
// escaped. A future writer that escapes `\` or emits an unpadded value ending
// in `\` would silently desync this split — change both files together.
function _splitTableCells(line) {
  return line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

function parseLedger(text) {
  if (typeof text !== "string") {
    throw new Error("parseLedger: text must be a string");
  }
  const lines = text.split("\n");
  let headerIdx = -1;
  let sepIdx = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i];
    const b = lines[i + 1];
    if (/^\s*\|.*\|\s*$/.test(a) && /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(b)) {
      headerIdx = i;
      sepIdx = i + 1;
      break;
    }
  }
  if (headerIdx < 0) {
    // No table region — treat the entire body as preamble. Merge falls
    // back to line-union for prose.
    return {
      hasTable: false,
      preamble: lines.slice(),
      header: null,
      separator: null,
      columns: [],
      rows: [],
      trailer: [],
    };
  }
  const preamble = lines.slice(0, headerIdx);
  const headerLine = lines[headerIdx];
  const separatorLine = lines[sepIdx];
  const columns = _splitTableCells(headerLine);
  let ownerColIdx = -1;
  for (let i = 0; i < columns.length; i++) {
    if (/^owner$/i.test(columns[i])) {
      ownerColIdx = i;
      break;
    }
  }
  const rows = [];
  let rowEnd = sepIdx + 1;
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!/^\s*\|.*\|\s*$/.test(l)) break;
    const cells = _splitTableCells(l);
    if (cells.length === 0) break;
    // First column is the stable ID. Empty ID rows are skipped (a row
    // with all-empty cells is treated as a separator within a section).
    const id = cells[0] || "";
    if (!id) {
      rowEnd = i + 1;
      continue;
    }
    const owner =
      ownerColIdx >= 0 ? cells[ownerColIdx] || "unknown" : "unknown";
    rows.push({ rawLine: l, id, owner, cells });
    rowEnd = i + 1;
  }
  const trailer = lines.slice(rowEnd);
  return {
    hasTable: true,
    preamble,
    header: headerLine,
    separator: separatorLine,
    columns,
    ownerColIdx,
    rows,
    trailer,
  };
}

function _rowKey(row) {
  // The stable ID is the merge key. Owner is informational.
  return row.id;
}

function _rowsByKey(rows) {
  const m = new Map();
  for (const r of rows) m.set(_rowKey(r), r);
  return m;
}

function _rowEqual(a, b) {
  if (!a || !b) return false;
  if (a.cells.length !== b.cells.length) return false;
  for (let i = 0; i < a.cells.length; i++) {
    if (a.cells[i] !== b.cells[i]) return false;
  }
  return true;
}

// ---- 3-way merge -----------------------------------------------------------

/**
 * Perform a 3-way merge on three ledger texts.
 *
 * Returns { ok, body, conflicts } where:
 *   ok       = true if clean, false if conflicts were inserted
 *   body     = merged text (with conflict markers if !ok)
 *   conflicts= array of { id, ownerA, ownerB } describing each conflict
 *
 * @param {string} oText  - common ancestor
 * @param {string} aText  - ours
 * @param {string} bText  - theirs
 */
function merge3(oText, aText, bText) {
  let o, a, b;
  try {
    o = parseLedger(oText);
    a = parseLedger(aText);
    b = parseLedger(bText);
  } catch (err) {
    throw new Error(
      `merge3: parse failed: ${err && err.message ? err.message : err}`,
    );
  }

  // If any side lacks a table, fall back to prose line-union for the
  // whole body; the table-merge logic does not apply.
  if (!a.hasTable && !b.hasTable) {
    // Both sides removed the table. Take union of preambles.
    const merged = _lineUnion(o.preamble, a.preamble, b.preamble).join("\n");
    return { ok: true, body: merged, conflicts: [] };
  }

  // The header/separator come from A; if A doesn't have one but B does,
  // take B's. Preamble + trailer are line-unioned across A and B.
  const useA = a.hasTable ? a : b;
  const header = useA.header;
  const separator = useA.separator;

  const oRows = o.hasTable ? _rowsByKey(o.rows) : new Map();
  const aRows = a.hasTable ? _rowsByKey(a.rows) : new Map();
  const bRows = b.hasTable ? _rowsByKey(b.rows) : new Map();

  // Build merged-row order: A's row order, then any keys present in B
  // but not in A appended in B's order.
  const orderedKeys = [];
  const seen = new Set();
  if (a.hasTable) {
    for (const r of a.rows) {
      if (!seen.has(r.id)) {
        orderedKeys.push(r.id);
        seen.add(r.id);
      }
    }
  }
  if (b.hasTable) {
    for (const r of b.rows) {
      if (!seen.has(r.id)) {
        orderedKeys.push(r.id);
        seen.add(r.id);
      }
    }
  }

  const mergedRows = [];
  const conflicts = [];
  for (const key of orderedKeys) {
    const oR = oRows.get(key);
    const aR = aRows.get(key);
    const bR = bRows.get(key);
    if (aR && bR) {
      if (_rowEqual(aR, bR)) {
        // Identical change (or unchanged on both sides).
        mergedRows.push(aR.rawLine);
        continue;
      }
      if (oR && _rowEqual(oR, aR)) {
        // Only B changed → take B.
        mergedRows.push(bR.rawLine);
        continue;
      }
      if (oR && _rowEqual(oR, bR)) {
        // Only A changed → take A.
        mergedRows.push(aR.rawLine);
        continue;
      }
      // Both changed differently → conflict.
      conflicts.push({ id: key, ownerA: aR.owner, ownerB: bR.owner });
      mergedRows.push(`<<<<<<< owner=${aR.owner}`);
      mergedRows.push(aR.rawLine);
      mergedRows.push("=======");
      mergedRows.push(bR.rawLine);
      mergedRows.push(`>>>>>>> owner=${bR.owner}`);
      continue;
    }
    if (aR && !bR) {
      // Present only in A. If O also had it but B deleted it → keep A
      // unless A is unchanged from O (then take the delete). If never
      // in O → keep A (A's addition).
      if (oR && _rowEqual(oR, aR)) {
        // Unchanged on A; deleted on B → drop.
        continue;
      }
      mergedRows.push(aR.rawLine);
      continue;
    }
    if (!aR && bR) {
      if (oR && _rowEqual(oR, bR)) {
        // Unchanged on B; deleted on A → drop.
        continue;
      }
      mergedRows.push(bR.rawLine);
      continue;
    }
    // Neither side has it; it existed only in O → drop (both closed).
  }

  // Reconcile preamble + trailer via line-union across A and B.
  const oPre = o.hasTable ? o.preamble : o.preamble;
  const aPre = a.hasTable ? a.preamble : a.preamble;
  const bPre = b.hasTable ? b.preamble : b.preamble;
  const oTrail = o.hasTable ? o.trailer : [];
  const aTrail = a.hasTable ? a.trailer : [];
  const bTrail = b.hasTable ? b.trailer : [];

  const preamble = _lineUnion(oPre, aPre, bPre);
  const trailer = _lineUnion(oTrail, aTrail, bTrail);

  const bodyLines = [...preamble, header, separator, ...mergedRows, ...trailer];
  const body = bodyLines.join("\n");
  return { ok: conflicts.length === 0, body, conflicts };
}

function _lineUnion(oLines, aLines, bLines) {
  // Take A's order verbatim; append any line from B not in A AND not in O
  // (B's additions). Lines in O but missing from A are kept-deleted by A;
  // we honor that delete and do NOT re-introduce them via B.
  const oSet = new Set(oLines);
  const aSet = new Set(aLines);
  const out = aLines.slice();
  for (const line of bLines) {
    if (aSet.has(line)) continue;
    if (oSet.has(line) && !aSet.has(line)) {
      // Was in O, removed in A → A's delete wins.
      continue;
    }
    out.push(line);
  }
  return out;
}

// ---- CLI entry (git merge driver) -----------------------------------------

function _runAsDriver(argv) {
  // git invokes: coc-ledger.js %O %A %B  (%P not registered — see file header)
  // We read %O, %A, %B; write the merged bytes back to %A.
  if (argv.length < 3) {
    process.stderr.write(
      "coc-ledger: expected `%O %A %B` argv; got " +
        JSON.stringify(argv) +
        "\n",
    );
    process.exit(2);
  }
  const [oPath, aPath, bPath] = argv;
  let oText, aText, bText;
  try {
    oText = fs.existsSync(oPath) ? fs.readFileSync(oPath, "utf8") : "";
    aText = fs.readFileSync(aPath, "utf8");
    bText = fs.readFileSync(bPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `coc-ledger: read failure: ${err && err.message ? err.message : err}\n`,
    );
    process.exit(2);
  }
  let result;
  try {
    result = merge3(oText, aText, bText);
  } catch (err) {
    process.stderr.write(
      `coc-ledger: merge failed: ${err && err.message ? err.message : err}\n`,
    );
    process.exit(2);
  }
  try {
    fs.writeFileSync(aPath, result.body);
  } catch (err) {
    process.stderr.write(
      `coc-ledger: write failure: ${err && err.message ? err.message : err}\n`,
    );
    process.exit(2);
  }
  if (!result.ok) {
    process.stderr.write(
      `coc-ledger: ${result.conflicts.length} per-row conflict(s) marked; manual resolve required\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  _runAsDriver(process.argv.slice(2));
}

module.exports = {
  parseLedger,
  merge3,
};
