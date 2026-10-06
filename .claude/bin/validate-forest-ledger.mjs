#!/usr/bin/env node
/*
 * ============================================================================
 *  Forest-Ledger Conformance Validator — journal/0089..0095 (Option B)
 * ============================================================================
 *
 *  Mechanical gate for the "Outstanding ledger (forest)" section of a
 *  `.session-notes` file (contract: `.claude/commands/wrapup.md`
 *  § Outstanding ledger reconciliation).
 *
 *  OPTION B (journal/0095): rows carry an author-assigned, UNIQUE,
 *  STABLE **ID**. The close list references the ID. L4 reconciles on
 *  the exact ID set. There is NO prose name-parsing and NO
 *  normalization-collision residue — IDs are explicit tokens,
 *  uniqueness is mechanically enforced (L5), so the journal/0093
 *  documented lexical bound and the journal/0094 parser-regression
 *  class are STRUCTURALLY IMPOSSIBLE here, not merely mitigated.
 *
 *  Checks:
 *    L1  section present AND fence-balanced AND non-vacuous (≥1 row OR
 *        the line-anchored `Forest empty` sentinel) AND inside the strict
 *        ledger grammar (strictViolations): blank lines, table rows, and text
 *        with no pipe, pipe lookalike, HTML comment, code fence, `# ` line, indented or empty `##`, setext underline or non-space/tab leading whitespace (and, in the shared form, no heading of any level). Every path (bare, --git-prior, --aggregate) reads a ledger
 *        through ONE reader (readLedger) and ONE byte decoder (decodeText), so
 *        none can accept what another refuses.
 *    L2  every open row carries a non-empty value-anchor (column 3).
 *    L3  every "Closed this session" entry references a syntactic ID
 *        token AND cites a durable receipt SHAPE (PR #N | #N | 7-40-hex
 *        SHA w/ ≥1 digit | journal NNNN | journal/.pending/NNNN).
 *        SHAPE, not EXISTENCE — a fabricated-but-shaped receipt is a
 *        verify-resource-existence.md MUST-1 violation caught at
 *        gate-review, not here.
 *    L5  ledger IDs are UNIQUE within the section (a duplicate ID makes
 *        ID-conservation ambiguous — hard FLAG).
 *    contradiction  `Forest empty` asserted WITH open rows = FLAG.
 *
 *    L4 (only with --git-prior — the anti-vanish gate): every prior
 *        committed OPEN row ID is either still an open row ID in the
 *        current ledger OR appears as a referenced ID in the current
 *        "Closed this session" block. EXACT id-set match (trim only;
 *        IDs are verbatim-stable by contract). Zero residue: distinct
 *        workstreams have distinct IDs by L5, so no collision can mask
 *        a vanish. Without --git-prior the anti-vanish invariant is
 *        NOT mechanically enforced.
 *
 *  THIS SCRIPT IS A SYNCED ARTIFACT (`bin/**`). Zero client/org tokens;
 *  detection is purely structural (a STRUCTURAL probe per
 *  probe-driven-verification.md MUST-3).
 *
 *    --aggregate (issue #669 — the WORKSPACE→ROOT anti-vanish gate): every
 *        OPEN forest-ledger row in a `workspaces/<ws>/.session-notes` (or its
 *        M6-D split `.session-notes.shared.md`) MUST be reflected in the ROOT
 *        ledger (an open root row OR a root "Closed this session" reference).
 *        A workspace-open ID absent from root is a STRANDED item — the
 *        cross-file "vanish" that /sweep + /wrapup were blind to before #669.
 *        Complements --git-prior (intra-file, across commits) with the
 *        cross-file, workspace→root axis. ID-set membership only; no prose
 *        parsing.
 *
 *  Usage:
 *    node .claude/bin/validate-forest-ledger.mjs [--json] <.session-notes>
 *    node .claude/bin/validate-forest-ledger.mjs --git-prior <.session-notes>
 *    node .claude/bin/validate-forest-ledger.mjs --aggregate [--root <repo-root>]
 *
 *  Exit 0 = conformant. Exit 1 = ≥1 finding. Exit 2 = usage / IO error.
 *  Exit 3 = UNRUNNABLE — a check could not execute. NOT a pass, NOT a finding.
 *
 *  HISTORY-DEPENDENT (--git-prior only): the L4 anti-vanish gate compares the current
 *  ledger against the one committed at HEAD, so it answers differently in a tree whose
 *  history is absent (an offload snapshot, a --depth=1 clone, a re-initialised directory).
 *  That case used to render as a `note` inside an exit-0 "OK forest-ledger conformant"
 *  run — the gate going silently green exactly when it could not see. It now exits 3.
 *  L1/L2/L3/L5 are pure working-tree checks and are unaffected.
 *
 *  BOUND, stated rather than implied: this discriminates ABSENT history from present
 *  history. It does NOT detect a FOREIGN repository — a ledger has no declared anchor to
 *  compare a repo identity against, so a snapshot re-committed in an unrelated repo is
 *  still compared against that repo's HEAD. Closing that needs an anchor in the artifact.
 *  WHICH HEAD: the prior is found by asking up to three questions — the real file (from
 *  its own repository), the name as typed in its real directory, and the path as typed from
 *  the directory the tool was started in — and it conserves against the UNION of what they
 *  hold. Exit 0 as a FIRST COMMIT must be PROVEN: every question asked, each answering "no
 *  such path" at a readable HEAD, with no copy under another spelling or an unreadable blob.
 *  Anything short of that proof is UNRUNNABLE (exit 3), never 0 — including a run from
 *  outside the repository, where the as-typed question cannot be formed. What this still
 *  does NOT see, stated because the claim above must not be read wider than it is:
 *    - a RENAME: a ledger moved (git mv or mv) and validated at its new path has no prior
 *      under any of the three questions, so a genuine vanish across a rename reads as a
 *      first commit. Only an identity carried IN the ledger can close that;
 *    - a FOREIGN repository (above).
 *  A shared-form ("# Forest Ledger") prior is UNRUNNABLE: it drops closed rows with no
 *  close record, so vanish and close look alike. Class F of the forest-ledger fixtures pins
 *  each case named here.
 *
 *  THREAT MODEL, decided rather than implied (operator, 2026-09-25): --git-prior guards
 *  against ACCIDENTAL loss — a row dropped in an edit, a malformed or partly unreadable
 *  prior (it refuses, exit 3, rather than conserving part of it), a partial clone, a symlink
 *  or case variant on the path. A MOVED ledger is the RENAME bound above, not covered here.
 *  The section is read under a STRICT GRAMMAR (strictViolations): blank lines, table rows, and
 *  plain text with no pipe, pipe lookalike, HTML comment, code fence, `# ` line, indented or empty `##`, setext underline or non-space/tab leading whitespace (and, in the shared form, no heading of any level). Anything else
 *  is refused — never guessed at — because seven review rounds of markdown heuristics each opened
 *  a new hole. The close list has one accepted shape too (closeEntries); a close written in
 *  another shape is not seen, and the row is reported as VANISHED — loud, never silent.
 *  Declared ACCIDENT-class bounds, each able to exit 0 over a row:
 *    - an unindented `## ` heading typed INSIDE an inline ledger ends the section (an indented
 *      or empty one is refused), so rows below it are not read as ledger rows; telling a real next section from a
 *      stray heading is exactly the guessing the grammar refuses to do (the shared form refuses
 *      any heading instead);
 *    - a data row with a `|---|` line directly under it IS a header by the table grammar;
 *    - a row drawn in a vertical-bar lookalike OUTSIDE PIPE_LOOKALIKE reads as prose (listed
 *      characters are refused anywhere; a structural rule for the rest was removed after it
 *      regressed in three review rounds);
 *    - --aggregate keys on the bare ID: an ID reused by a DIFFERENT workstream in another
 *      workspace reads as reflected when the root holds that ID. IDs are unique per section by
 *      contract; a ledger-carried identity (the queued format change below) closes it;
 *    - at the ROOT, --aggregate reads `.session-notes.shared.md` when it exists and ignores a
 *      legacy `.session-notes` beside it (workspaces read both);
 *    - the L2 row checks (anchor present, "Forest empty" beside open rows) run on the bare path
 *      only; --aggregate and the prior read IDs, not anchors.
 *  And its one accepted cost:
 *  a prior with no ledger section but any table is refused (exit 3) until the commit carrying
 *  the section lands, because an unrelated table and a ledger under a lost heading look alike.
 *  It is NOT built to resist a working tree deliberately staged to defeat it, and four review rounds each found a new such
 *  staging. Known adversarial residuals, each able to exit 0 over a vanished row:
 *    - running from INSIDE a nested repository planted over a tracked directory (every
 *      identity then asks the planted repo, which never held the path), or planting a nested
 *      commit that holds FEWER rows and running from inside it (it reads as a smaller prior);
 *    - a filesystem that folds names beyond NFC + lowercase (compatibility / ignorable code
 *      points), so a respelling is not recognised;
 *    - a working directory reached through a symlink onto a MOVED ledger directory (a rename).
 *  (A close entry inside a fenced "example" block is no longer one: any fence in the section
 *  is refused by the grammar.)
 *  Closing that class needs an identity carried IN the ledger and a structural parser — a
 *  format change queued as its own lane, not a further round of path heuristics.
 * ============================================================================
 */

import { readFileSync, readdirSync, existsSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Indented up to three spaces, as CommonMark renders it: an indented SECOND ledger heading was
// missed by the heading count while the section-end honoured it, dropping its rows unseen
// (review-cor-r11-M1). The section end and this anchor now read headings the same way.
const HEADING_RE = /^ {0,3}##[ \t]+Outstanding ledger \(forest\)\s*$/i;
// Whole-file shared-ledger anchor (`.session-notes.shared.md`): the `# Forest
// Ledger` heading authored by session-notes-layout.js::LEDGER_HEADER. Binding
// the shared-form parse to THIS section (not the whole file) is what keeps a
// non-ledger wide table elsewhere in the file from injecting spurious IDs.
const SHARED_HEADING_RE = /^ {0,3}#[ \t]+Forest Ledger\b/i;
const EMPTY_FOREST = /^\s*forest empty\b/im;
const FENCE_RE = /^\s*(```+|~~~+)(.*)$/;
// The fence run a line OPENS or CLOSES, or null. CommonMark: a backtick fence's info string
// cannot itself contain a backtick, so a line-start CODE SPAN (```npm test``` passed) is not a
// fence. Reading it as one swallowed the rest of the file — the ledger heading below it then sat
// "inside a fence" and the file read as having no ledger at all (review-sec-r9-F1/F4).
function fenceRun(line) {
  const m = line.match(FENCE_RE);
  if (!m) return null;
  if (m[1][0] === "`" && m[2].includes("`")) return null;
  return m[1];
}
// Every line ending counts — LF, CRLF and a bare CR. Splitting on LF alone read an old-Mac
// (CR-only) file as ONE line: no heading, no rows, "nothing to conserve" (review-cor-r9-F1). One
// splitter for every reader, so no path can read a file another path cannot.
const LINE_SPLIT = /\r\n|\r|\n/;

const RECEIPT_ALTS = [
  /(?:^|[\s([])#\d+\b/,
  /\bPR\s*#\d+\b/i,
  /(?:^|[\s([])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![0-9a-z])/i,
  /\bjournal[\s/](?:\.pending\/)?\.?\d{3,4}\b/i,
];
const hasReceipt = (s) => RECEIPT_ALTS.some((re) => re.test(s));

// ID normalization: trim + strip a surrounding markdown delimiter pair
// (backtick / asterisk). Applied IDENTICALLY at all three ID sites
// (prior rows, current rows, close tokens) so the canonical wrapup.md
// close form `<id>` reconciles with the bare `| <id> |` row form and
// vice-versa (journal/0097 HIGH-1 + MED-1 — symmetric, not one-sided).
// This is deterministic delimiter-stripping of a single bounded token,
// NOT prose parsing — it does not reopen the substring-mask class.
const normId = (s) =>
  String(s)
    .trim()
    .replace(/^[`*]+/, "")
    .replace(/[`*]+$/, "")
    .trim();

// Extract the referenced ID from a close entry: the FIRST whitespace /
// separator-delimited token after list chrome. Deterministic — an ID is
// a single token by contract, never free prose. "" if none (→ L3 flag).
function closeEntryId(entry) {
  const s = entry.replace(/^[\s>*-]+/, "");
  const tok = s.split(/[\s:]|→|->/)[0];
  return normId(tok || "");
}

function isSeparatorRow(cells) {
  return cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, "")) || c === "");
}
// A header row is decided by TABLE GRAMMAR, never by what a row happens to mention. It
// used to be any row whose joined text CONTAINED "value-anchor" and "id" or "item" — and
// "id" is a substring of "valid", "idea", "provide". A data row reading
// `| F7 | add value-anchor check | valid anchor | OPEN |` was skipped as a header: F7 was
// never conserved (its vanish exited 0) and never anchor-checked (review-sec-r3-HIGH-1).
// Now: the FIRST row of a table block, directly followed by a GFM delimiter row (every cell
// dashes), is the header — see isDelimiterRow for why an all-empty row is not one. With no delimiter
// (a malformed table), fall back to WHOLE-CELL equality with the column names — the inline
// `Value-anchor` and the M6-D shared `value_anchor`
// (`.claude/hooks/lib/session-notes-layout.js::LEDGER_HEADER`) — never a substring.
function headerCellNames(cells) {
  return cells.map((c) => c.trim().toLowerCase().replace(/[`*]/g, "").replace(/[-\s]+/g, "_"));
}
// A GFM delimiter row: EVERY cell is dashes (optionally colon-aligned). Unlike
// isSeparatorRow, an all-EMPTY row is not one — a blank `|  |  |  |  |` row is filler, and
// treating it as a delimiter promoted the data row above it to a header, dropping it from
// conservation, the anchor check and aggregation (review-cor-r4-H1: exit 0 over a vanish
// the af57c4839 validator caught).
function isDelimiterRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.replace(/\s/g, "")));
}
// `startsBlock`: no table line directly above it. `delimited`: the line directly below it
// is a delimiter row. Both are required for the grammar rule — a stray `|----|` in
// mid-table must not turn the row above it into a header.
function isHeaderRow(cells, { startsBlock = false, delimited = false } = {}) {
  if (startsBlock && delimited) return true;
  const n = headerCellNames(cells);
  // Whole cell, or the column name followed by a parenthetical — the /wrapup scaffold's own
  // header reads `Value-anchor (MUST-1 source)` (skills/wrapup/SKILL.md), which exact equality
  // missed (review-sec-r5-R5). Still never a substring inside a data cell's prose.
  const hasAnchorCol = n.some((c) => /^value_?anchor(_\(.*\))?$/.test(c));
  return hasAnchorCol && (n.includes("id") || n.includes("item"));
}
// Verbatim wrapup.md template row: | <id> | <workstream> | <why ...> | BLOCKED on ... |
function isVerbatimTemplateRow(cells) {
  const n = cells.map((c) => c.trim().toLowerCase());
  return (
    n[0] === "<id>" &&
    n[1] === "<workstream>" &&
    n[2].startsWith("<why it matters") &&
    n[3] !== undefined &&
    n[3].startsWith("blocked on")
  );
}

// One fence-aware section scanner, parameterised by the heading that OPENS the
// section and the heading shape that CLOSES it. Both ledger forms bind to it so
// the shared form inherits the inline form's fence-awareness and row-binding
// rather than carrying a second, weaker parser.
function scanSection(text, headingRe, stopRe) {
  const lines = text.split(LINE_SPLIT);
  // The OPENING heading outside fenced code: a heading quoted in a fenced example above the real
  // section bound the parse to the quoted copy (review-sec-rS, regression list).
  let start = -1;
  {
    let marker = null;
    let len = 0;
    for (let i = 0; i < lines.length; i++) {
      const run = fenceRun(lines[i]);
      if (run !== null) {
        if (marker === null) {
          marker = run[0];
          len = run.length;
        } else if (run[0] === marker && run.length >= len) {
          marker = null;
          len = 0;
        }
        continue;
      }
      if (marker === null && headingRe.test(lines[i])) {
        start = i;
        break;
      }
    }
  }
  if (start === -1) return null;
  const body = [];
  const rowLines = [];
  let fenceMarker = null;
  let fenceLen = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    const run = fenceRun(l);
    if (run !== null) {
      const kind = run[0];
      const len = run.length;
      if (fenceMarker === null) {
        fenceMarker = kind;
        fenceLen = len;
      } else if (kind === fenceMarker && len >= fenceLen) {
        fenceMarker = null;
        fenceLen = 0;
      }
      body.push(l);
      continue;
    }
    // The section ends at `stopRe`, with no comment tracking: an HTML comment inside
    // the section is refused outright by the strict grammar (strictViolations), so there is no
    // "heading inside a comment" to interpret — and interpreting one let a stray `<!--` swallow
    // every later section (review-sec-r7-R1 / review-cor-r7-H1).
    if (fenceMarker === null && stopRe.test(l)) break;
    body.push(l);
    if (fenceMarker === null) rowLines.push(l);
  }
  return { body, rowLines, unterminated: fenceMarker !== null };
}

// Inline form: `## Outstanding ledger (forest)` → the next UNINDENTED `## ` heading, and ONLY that.
// An indented or empty `##` is not a boundary but a grammar refusal (strictViolations): as a
// boundary it hid the rows below it (review-sec-r11-F4), as text it counted rows the page shows
// under another heading (review-sec-r10-F7). A `# ` line inside the section is not a boundary either: it is REFUSED by the grammar (strictViolations), because it is as
// likely a pasted shell comment as a heading. Ending the section there let a `# rerun: node x.mjs`
// line hide every row below it from the prior, exit 0 over a vanish (review-sec-r9-F2); not ending
// it there let a `# Archive` table join the ledger (review-sec-rS-L3). Refusing it closes both
// without choosing a reading.
function extractSection(text) {
  // A heading WITH text: an empty `## ` (trailing space) ended the section here while the grammar
  // said an empty `##` is refused (review-cor-r12-F3). Now it enters the section and is refused.
  // "Text" is anything but a space or tab — the blank rule's definition. `\S` also rejected a
  // leading NBSP or U+3000 (an IME space), so "## 　Archive" stopped ending the section and a
  // row moved under it was still read as open (review-sec-r13-1).
  return scanSection(text, HEADING_RE, /^##[ \t]+[^ \t]/);
}

// Whole-file shared-ledger form (`.session-notes.shared.md`): the `# Forest Ledger` heading
// (SHARED_HEADING_RE) through the END OF THE FILE. It used to end at any heading, so a pasted
// `# rerun …` comment or a `### Blocked` subheading silently cut every row below it out of the bare
// check and --aggregate (review-sec-r10-F3) — the hole review-sec-r9-F2 closed for the inline form.
// Running to EOF puts every later line under the grammar, which refuses a heading of any level
// here (strictViolations, shared form): the generated file (session-notes-layout.js) holds none,
// and a hand-added one is exactly the ambiguity the grammar exists to refuse.
function extractSharedSectionFull(text) {
  return scanSection(text, SHARED_HEADING_RE, /(?!)/);
}

// Column resolution from a header row. The two mandated ledger shapes do NOT
// agree positionally:
//   inline `.session-notes`      | ID | Item | Value-anchor | Status |
//   shared `.session-notes.shared.md` | ID | owner | item | value_anchor | status |
// (the shared shape is `session-notes-layout.js::LEDGER_HEADER`, whose `owner`
// column is load-bearing for the coc-ledger merge driver). Reading position 2 as
// "the value-anchor" is correct for the first and reads `item` on the second —
// so an EMPTY value_anchor in a shared row would pass the L2 anchor check
// against a non-empty `item`. Resolve by NAME when a header is present; fall
// back to the positional contract when it is absent, which is the pre-existing
// behaviour every header-less fixture depends on.
function headerIndex(cells) {
  const norm = cells.map((c) =>
    c
      .trim()
      .toLowerCase()
      .replace(/[`*]/g, "")
      .replace(/[-\s]+/g, "_"),
  );
  const at = (...names) => {
    for (const n of names) {
      const i = norm.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };
  const id = at("id");
  const item = at("item", "workstream");
  const anchor = at("value_anchor", "valueanchor", "anchor");
  if (id === -1 || item === -1 || anchor === -1) return null;
  return { id, item, anchor };
}

// Rows: | ID | Item | Value-anchor | Status | (or the shared 5-column shape).
// Returns open rows with {id, item, anchor} + malformed (<4 col) + duplicate-id
// list (L5).
function parseRows(rowLines) {
  const rows = [];
  const malformed = [];
  const seen = new Map();
  const dupes = [];
  let cols = null; // resolved from the first header row seen; null ⇒ positional
  let headerLen = null; // cell count of that header row
  const trimmed = rowLines.map((raw) => raw.trim());
  const table = [];
  for (let i = 0; i < trimmed.length; i++) {
    const line = trimmed[i];
    // Non-table lines are judged by the STRICT GRAMMAR (strictViolations), never guessed at
    // here: a line with a pipe that is not a table row is refused there, whatever its shape.
    if (!line.startsWith("|")) continue;
    table.push({
      line,
      i,
      // Split on UNESCAPED pipes only: the generator writes an in-cell pipe as `\|`
      // (session-notes-layout.js cell()), and splitting on it shifted every later column — an
      // empty value_anchor then read the next cell and passed L2 (review-sec-r9, also noted).
      cells: line
        .replace(/^\|/, "")
        .replace(/(?<!\\)\|$/, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.trim()),
    });
  }
  for (let t = 0; t < table.length; t++) {
    const { line, cells, i } = table[t];
    if (isSeparatorRow(cells)) continue;
    const startsBlock = t === 0 || table[t - 1].i !== i - 1;
    const next = table[t + 1];
    const delimited = next !== undefined && next.i === i + 1 && isDelimiterRow(next.cells);
    if (isHeaderRow(cells, { startsBlock, delimited })) {
      if (cols === null) {
        cols = headerIndex(cells);
        // Trailing EMPTY header cells are no column (`| ID | Item | Value-anchor | Status | |`):
        // counting them refused every row as short (review-sec-r11-F7).
        let n = cells.length;
        while (n > 0 && cells[n - 1] === "") n--;
        headerLen = n;
      }
      continue;
    }
    // FEWER cells than the header is a row missing a column. `C:\|` (an escaped pipe, merging two
    // cells, as a GFM renderer merges them) otherwise left a 5-column shared row with 4 cells whose
    // "anchor" read the status cell, passing L2 over an empty anchor (review-sec-r10-F6).
    if (cells.length < 4 || (headerLen !== null && cells.length < headerLen)) {
      malformed.push(line);
      continue;
    }
    if (isVerbatimTemplateRow(cells)) continue;
    const idx = cols ?? { id: 0, item: 1, anchor: 2 };
    const id = normId(cells[idx.id] ?? "");
    if (id === "") {
      malformed.push(line);
      continue;
    }
    if (seen.has(id)) dupes.push(id);
    else seen.set(id, true);
    rows.push({ id, item: cells[idx.item] ?? "", anchor: cells[idx.anchor] ?? "" });
  }
  return { rows, malformed, dupes };
}

// Close-entry collector. The close list has ONE accepted shape, and anything outside it ends the
// list rather than being interpreted:
//   intro   a line STARTING with "Closed this session" — optionally as a heading (`### …`), a
//           bullet (`- …`) and/or in emphasis (`**…:**`); an inline tail is the first entry;
//   entry   a `-` / `*` / `+` bullet at the list's OWN indentation — set by its first bullet, or
//           by the intro line when the intro carries an inline entry;
//   part    a line indented DEEPER than the list's bullets — a soft-wrapped line OR a nested
//           sub-bullet — belongs to the entry above it and never starts one. A nested bullet read as
//           an entry filed "  - W3 still open, tracked in #815" as a close of W3 (review-sec-r10-F1,
//           review-cor-r10-M2).
// Blank lines and lead-in prose are skipped BEFORE the first entry. The list ENDS at: a blank line
// after an entry; an unindented (not-deeper) non-bullet line after an entry; a bullet SHALLOWER than
// the list's; ANY non-bullet line ending in `:` — a new list label such as `Still open:`, before or
// after the first entry, indented or not; a table row; a heading. A lead-in such as "The following
// landed:" therefore ends the list too: it cannot be told from "Still open:", and reading the wrong
// one files open rows as closed. Every end fails CLOSED — a close the parser does not see is
// reported as a VANISHED row, and that message states this shape.
const CLOSE_INTRO_RE = /^(?:#{1,6}[ \t]+|[-*+][ \t]+)?[*_]*closed this session[*_]*[ \t]*:?[ \t]*[*_]*[ \t]*(.*)$/i;
const BULLET_RE = /^[-*+][ \t]+/;
// Indentation in columns, a tab advancing to the next multiple of four (CommonMark): counting every
// tab as four wherever it sat read "  \t- F1" as column 6 and split one list in two (review-cor-r11-L3).
const indentOf = (raw) => {
  let col = 0;
  for (const ch of raw.match(/^[ \t]*/)[0]) col = ch === "\t" ? col + 4 - (col % 4) : col + 1;
  return col;
};
function closeEntries(body) {
  const entries = [];
  for (let i = 0; i < body.length; i++) {
    const m = body[i].trim().match(CLOSE_INTRO_RE);
    if (!m) continue;
    let cur = m[1].trim() ? m[1].trim() : null;
    let entryIndent = cur === null ? null : indentOf(body[i]);
    for (let j = i + 1; j < body.length; j++) {
      const raw = body[j];
      const b = raw.trim();
      if (b.startsWith("|") || /^#{1,6}[ \t]/.test(b)) break;
      if (b === "") {
        if (cur === null) continue; // between the intro and the first entry
        break;
      }
      const ind = indentOf(raw);
      if (BULLET_RE.test(b)) {
        if (entryIndent === null) entryIndent = ind;
        if (ind === entryIndent) {
          if (cur !== null) entries.push(cur);
          cur = b.replace(BULLET_RE, "");
        } else if (ind > entryIndent && cur !== null) {
          cur = `${cur} ${b}`; // a nested sub-bullet is part of its parent entry
        } else {
          break; // shallower than the list's own bullets: a different list
        }
        continue;
      }
      if (/:$/.test(b)) break; // a new list label, never an entry
      if (cur === null) continue; // lead-in prose before the first entry
      if (ind > entryIndent) {
        cur = `${cur} ${b}`; // soft-wrap continuation — deeper, as a wrapped bullet is
        continue;
      }
      break;
    }
    if (cur !== null) entries.push(cur);
    break;
  }
  return entries;
}

// The git subprocess envelope, loaded from THIS script's own tree — never from the
// repository under examination, which must not be able to supply the code meant to
// constrain the query made against it (the same reasoning build-trust-root.mjs records).
// An inherited GIT_DIR outranks repository discovery, so an un-enveloped probe can be
// answered by whatever repository the environment names.
let _gitEnvLib;
function gitEnvLib() {
  if (_gitEnvLib !== undefined) return _gitEnvLib;
  try {
    const require = createRequire(import.meta.url);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const lib = require(path.join(here, "..", "hooks", "lib", "git-subprocess-env.js"));
    _gitEnvLib = lib && typeof lib.resolveGitBinary === "function" && typeof lib.gitEnvForArgs === "function" ? lib : null;
  } catch {
    _gitEnvLib = null;
  }
  return _gitEnvLib;
}

/**
 * Run git through the envelope and report WHAT HAPPENED, never a bare boolean.
 * `noEnvelope` means the question could not be asked safely at all; callers
 * treat it as UNRUNNABLE, never as a negative answer.
 */
function gitRun(argv, { maxBuffer = 1024 * 1024, cwd, encoding = "utf8" } = {}) {
  const lib = gitEnvLib();
  if (!lib) return { ok: false, noEnvelope: true };
  const bin = lib.resolveGitBinary();
  if (!bin) return { ok: false, noEnvelope: true };
  try {
    const stdout = execFileSync(bin, argv, {
      cwd,
      encoding,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
      maxBuffer,
      env: lib.gitEnvForArgs(argv),
    });
    return { ok: true, stdout };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/**
 * Did git itself ANSWER (it ran and exited non-zero), or could the question not be
 * asked at all (no envelope, spawn failure, timeout, buffer overflow)? Only the first
 * is a statement about the repository; the second is a statement about this run.
 */
function gitAnswered(res) {
  return !res.ok && !res.noEnvelope && res.error && typeof res.error.status === "number" && !res.error.signal;
}

// Lines of `text` OUTSIDE fenced code blocks, using the same fence grammar as scanSection.
function unfencedLines(text) {
  const out = [];
  let marker = null;
  let len = 0;
  for (const l of text.split(LINE_SPLIT)) {
    const run = fenceRun(l);
    if (run !== null) {
      if (marker === null) {
        marker = run[0];
        len = run.length;
      } else if (run[0] === marker && run.length >= len) {
        marker = null;
        len = 0;
      }
      continue;
    }
    if (marker === null) out.push(l);
  }
  return out;
}

// THE STRICT LEDGER GRAMMAR (operator decision, 2026-09-25). Inside the ledger section a line is
// accepted only if it is blank, a table row (starts with `|`), or plain text that carries NONE
// of the things that can hide, fake or end a row: a pipe outside a table row, a vertical-bar
// lookalike, an HTML comment marker, a code fence, a `# ` line, an indented or empty `##`, a
// setext underline, leading whitespace other than spaces/tabs — and in the shared form a heading
// of any level. Anything else is REFUSED — an L1
// finding on the current file, UNRUNNABLE (exit 3) on a prior, an AGG finding on --aggregate —
// and never interpreted.
//
// Why a grammar and not heuristics, measured rather than argued: seven review rounds each found
// a new accidental input that made the check exit 0 over a vanished row, and several of those
// holes were opened by the previous round's heuristic (code-span pipes, comment tracking, ID
// shapes, ledger-word signals). The accepted language here is small enough to be checked whole;
// what it costs is that stray prose with pipes, comments or fences must be moved out of the
// section, and the refusal says exactly which line.
//
// Vertical-bar LOOKALIKES are refused by a fixed list (PIPE_LOOKALIKE), anywhere on a non-table
// line. A STRUCTURAL rule for unlisted characters ran for three review rounds and regressed in each
// — every shape that caught a spaced row also refused ordinary Arabic, Hebrew, Korean or symbol
// prose (review-sec-r10-F5, r12-F3) — so it was removed by operator decision (2026-09-25). A row
// drawn in an UNLISTED lookalike reads as prose: a declared bound (file header).
const PIPE_LOOKALIKE =
  /[¦ǀǁ׀।॥‖∣∥⎮⎸⎹⏐│┃┆┇┊┋╎╏║╵╷╹╻❘❙❚丨︱︲｜￤￨]/;
// `form` decides one rule: the inline section may hold `###`-and-deeper headings as text (the
// close intro may be one), while the shared section refuses a heading of ANY level, since it runs
// to the end of the file (extractSharedSectionFull).
function strictViolations(sectionLines, form = "inline") {
  const out = [];
  for (let k = 0; k < sectionLines.length; k++) {
    const raw = sectionLines[k];
    // BLANK means spaces and tabs only, as CommonMark defines it: trim() also strips NBSP, so an
    // NBSP-only line read as blank here and let a setext underline under the text above it through
    // (review-cor-r12-F1). Such a line now reaches the leading-whitespace refusal below.
    if (/^[ \t]*$/.test(raw)) continue;
    const line = raw.trim();
    const prevRaw = k > 0 ? sectionLines[k - 1] : "";
    // The previous line by the SAME blank rule: an NBSP-only line is text, so a `---` under it is a
    // setext underline (trim() alone would have called it blank; review-cor-r13-2).
    const prevBlank = /^[ \t]*$/.test(prevRaw);
    const prev = prevRaw.trim();
    if (/[^ \t]/.test(raw.match(/^\s*/)[0])) {
      // A non-breaking, full-width or other Unicode space in the indentation: String.trim() strips
      // it while the indentation count does not see it, so an "  - F3 still open" sub-bullet read as
      // a sibling CLOSE of F3 (review-sec-r11-F1). One whitespace definition: spaces and tabs only.
      out.push({ line: raw, why: "leading whitespace other than spaces or tabs (a non-breaking or full-width space hides a line's indentation)" });
    } else if (fenceRun(raw) !== null) {
      out.push({ line: raw, why: "a code fence (it hides the lines inside it from the ledger)" });
    } else if (line.includes("<!--") || line.includes("-->")) {
      out.push({ line: raw, why: "an HTML comment marker (a comment hides rows while the text still shows)" });
    } else if (/^#(?:[ \t]|$)/.test(line)) {
      // A heading of level 1 — or a pasted shell comment; the two cannot be told apart, and
      // either reading hides rows (see extractSection).
      out.push({ line: raw, why: "a `# ` line (a level-1 heading or a pasted comment; end the section with a `## ` heading instead)" });
    } else if (form === "shared" && /^#{1,6}(?:[ \t]|$)/.test(line)) {
      out.push({ line: raw, why: "a heading inside the whole-file shared ledger (it would split the ledger; the shared form holds none)" });
    } else if (form === "inline" && (/^ {1,3}##(?:[ \t]|$)/.test(raw) || line === "##")) {
      // An INDENTED (or empty) level-2 heading renders as a heading, but the section ends only at an
      // unindented `## `. Ending it there too let "  ## rerun" hide every row below it, exit 0
      // (review-sec-r11-F4); reading past it silently counted rows the page shows elsewhere. Refused.
      out.push({ line: raw, why: "an indented or empty `##` heading (end the section with an unindented `## ` heading)" });
    } else if (!line.startsWith("|") && /^(?:=+|-+)$/.test(line) && !prevBlank && !prev.startsWith("|")) {
      // A setext underline — `=`/`-` run DIRECTLY under a text line, one `-` included — turns that
      // line into a heading in every renderer, moving the rows below out of the rendered ledger while
      // the parser still read them (review-sec-r10-F7, review-cor-r11-M2). After a blank line or a
      // table row the same run is a thematic break (`---` before the next section), which is accepted
      // (review-sec-r11-F7).
      out.push({ line: raw, why: "a setext heading underline (a `=`/`-` run directly under a text line makes that line a heading)" });
    } else if (!line.startsWith("|") && line.includes("|")) {
      out.push({ line: raw, why: "a pipe outside a table row (a row missing its leading pipe, or prose that could be one)" });
    } else if (!line.startsWith("|") && PIPE_LOOKALIKE.test(line)) {
      out.push({ line: raw, why: "a vertical-bar lookalike (e.g. full-width or box-drawing) — a row typed with it is invisible to the table parser" });
    }
  }
  return out;
}

// Any table line anywhere in the file, fenced or not. A file with NO ledger section may hold no
// ledger only if it holds no table at all: a table there might be the ledger under a damaged or
// deleted heading, or under a heading swallowed by an unclosed fence, and telling which is the
// guessing this grammar exists to stop.
function hasTableLine(text) {
  return text.split(LINE_SPLIT).some((l) => l.trim().startsWith("|"));
}

// Bytes → text, or the reason it is not text. The SAME decoder for every reader. It used to be
// a regex over already-decoded text on the prior only: a valid U+FFFD or a stray CR in an
// unrelated section passed the bare check and then made every later --git-prior refuse
// (review-cor-r9-F2, review-sec-r9-F3), while a CR-only workspace ledger read as empty on
// --aggregate (review-cor-r9-F1). Now: invalid UTF-8 and NUL bytes (UTF-16, binary) are refused
// everywhere, and every line ending is read (LINE_SPLIT).
const UTF8 = new TextDecoder("utf-8", { fatal: true });
function decodeText(buf) {
  let text;
  try {
    text = UTF8.decode(buf);
  } catch {
    return { problem: "it is not valid UTF-8 text" };
  }
  if (text.includes("\u0000")) return { problem: "it holds NUL bytes (UTF-16 or binary), not UTF-8 text" };
  return { text };
}

// THE ONE LEDGER READER. Every path — the bare check, the --git-prior prior, --aggregate —
// reads a ledger through this function and nothing else.
function readLedger(text) {
  const inline = extractSection(text);
  const sec = inline ?? extractSharedSectionFull(text);
  const led = {
    form: sec === null ? null : inline !== null ? "inline" : "shared",
    headingCount: unfencedLines(text).filter((l) => HEADING_RE.test(l)).length,
    sharedHeadingCount: unfencedLines(text).filter((l) => SHARED_HEADING_RE.test(l)).length,
    tableWithoutSection: sec === null && hasTableLine(text),
    unterminated: false,
    violations: [],
    vacuous: false,
    rows: [],
    malformed: [],
    dupes: [],
    entries: [],
    badCloses: [],
    openAndClosed: [],
    emptyForest: false,
  };
  if (sec === null) return led;
  led.unterminated = sec.unterminated;
  led.violations = strictViolations(sec.body, led.form);
  led.emptyForest = EMPTY_FOREST.test(sec.rowLines.join("\n"));
  const p = parseRows(sec.rowLines);
  led.rows = p.rows;
  led.malformed = p.malformed;
  led.dupes = p.dupes;
  led.vacuous = !sec.unterminated && !led.emptyForest && p.rows.length === 0 && p.malformed.length === 0;
  led.entries = closeEntries(sec.body);
  led.badCloses = led.entries
    .map((e) => ({ entry: e, noId: closeEntryId(e) === "", noReceipt: !hasReceipt(e) }))
    .filter((x) => x.noId || x.noReceipt);
  const open = new Set(p.rows.map((r) => r.id));
  led.openAndClosed = [...new Set(led.entries.map(closeEntryId).filter((x) => x !== ""))].filter((id) => open.has(id));
  return led;
}

const MISSING_SECTION_MSG =
  'missing "## Outstanding ledger (forest)" section (or a whole-file "# Forest Ledger" shared ledger) — absent ledger is the stale-snapshot trap (journal/0089)';

// EVERY reason a ledger cannot be read exactly, in one fixed order, each carrying ALL of its
// renderings: `findings` (the bare check's L1/L2/L3 lines), `prior` (the --git-prior refusal) and
// `summary` (the --aggregate finding). The three paths render THIS list and nothing else, so a
// reason added here reaches every path. Review round 10 found the round-9 version still left each
// path picking which fields to check: --aggregate skipped the close-list (L3) refusals and a
// ledger file with no section (review-sec-r10-F2/F4, review-cor-r10-L2).
//
// `stage` places a reason in the bare check's output: "read", then "dupes" (L5), then the bare
// check's own L2 row checks, then "close" — the order every fixture's expected output records.
// The PRIOR skips exactly the kinds in PRIOR_IGNORES, each for a stated reason; every other path
// skips none.
function ledgerProblems(led) {
  const out = [];
  const add = (kind, stage, summary, findings, prior) => out.push({ kind, stage, summary, findings, prior });
  if (led.form === null) {
    const missing = [{ rule: "L1", msg: MISSING_SECTION_MSG }];
    if (led.tableWithoutSection) {
      add(
        "tableWithoutSection",
        "read",
        "it has no ledger section but holds a table (a damaged, deleted or fenced-in heading?)",
        missing,
        "the prior committed file has no ledger section but DOES hold a table, which may be the ledger under a damaged or deleted heading; it clears once a commit carrying the ledger section lands",
      );
    } else {
      add("noSection", "read", "it has no ledger section", missing, null);
    }
    return out;
  }
  if (led.headingCount > 0 && led.sharedHeadingCount > 0) {
    // BOTH forms in one file: the reader takes the inline section and never reads the shared
    // table, so a row dropped from it vanished with exit 0 — and appending an inline section to a
    // shared-form prior turned its refusal into a pass (review-sec-r12-F2).
    add(
      "twoForms",
      "read",
      'it holds both an inline "## Outstanding ledger (forest)" and a shared "# Forest Ledger" section, so only one is read',
      [{ rule: "L1", msg: 'both an inline "## Outstanding ledger (forest)" section and a whole-file "# Forest Ledger" section — only one is read; keep exactly one form per file' }],
      'the prior committed file holds both ledger forms, so only one of them was read',
    );
  }
  if (led.headingCount > 1) {
    add(
      "headings",
      "read",
      `it has ${led.headingCount} ledger headings, so which rows are the ledger is ambiguous`,
      [{ rule: "L1", msg: `${led.headingCount} "## Outstanding ledger (forest)" headings — only the first is parsed, so the others' rows are never checked; keep exactly one` }],
      `the prior committed file has ${led.headingCount} ledger headings (a commented-out template, or a second section), so which rows are the ledger is ambiguous`,
    );
  }
  if (led.unterminated) {
    add(
      "unterminated",
      "read",
      "it has an unclosed code fence, so rows after it are invisible",
      [{ rule: "L1", msg: `unterminated code fence in ledger section — rows after it are invisible; balance the fence (journal/0092)` }],
      "the prior committed ledger has an unclosed code fence, so its rows after it cannot be read or conserved",
    );
  }
  if (led.violations.length > 0) {
    const v = led.violations[0];
    const first = `first: ${v.why}: ${v.line.trim().slice(0, 80)}`;
    add(
      "grammar",
      "read",
      `${led.violations.length} line(s) outside the ledger grammar — ${first}`,
      led.violations.map((x) => ({ rule: "L1", msg: `line outside the ledger grammar — ${x.why}; move it out of the section: ${x.line.trim()}` })),
      `the prior committed ledger section has ${led.violations.length} line(s) outside the ledger grammar — ${first} — so which rows it held cannot be read exactly`,
    );
  }
  if (led.vacuous) {
    add(
      "vacuous",
      "read",
      'its section has no rows and does not say "Forest empty"',
      [{ rule: "L1", msg: `ledger section present but contains no rows and no "Forest empty" sentinel — indistinguishable from a dropped ledger (journal/0089)` }],
      'the prior committed ledger section has no rows and does not say "Forest empty", so its rows are somewhere this parser cannot see',
    );
  }
  if (led.malformed.length > 0) {
    add(
      "malformed",
      "read",
      `${led.malformed.length} row(s) could not be parsed — first: ${led.malformed[0].slice(0, 80)}`,
      led.malformed.map((bad) => ({ rule: "L2", msg: `malformed ledger row (expected | ID | Item | Value-anchor | Status |): ${bad}` })),
      `${led.malformed.length} row(s) of the prior committed ledger could not be parsed, so their IDs cannot be conserved`,
    );
  }
  if (led.dupes.length > 0) {
    const ds = [...new Set(led.dupes)];
    add(
      "dupes",
      "dupes",
      `duplicate ID(s) ${ds.map((x) => `"${x}"`).join(", ")} — which workstream an ID names is ambiguous`,
      ds.map((x) => ({ rule: "L5", msg: `duplicate ledger ID "${x}" — IDs MUST be unique (ID-conservation is ambiguous otherwise; journal/0095)` })),
      null,
    );
  }
  if (led.badCloses.length > 0) {
    const findings = [];
    for (const x of led.badCloses) {
      if (x.noId) findings.push({ rule: "L3", msg: `"Closed this session" entry references no ID token — cannot reconcile: ${x.entry}` });
      if (x.noReceipt) findings.push({ rule: "L3", msg: `"Closed this session" entry cites no durable receipt (PR#/#N/SHA/journal NNNN) — not closed: ${x.entry}` });
    }
    add(
      "badClose",
      "close",
      `${led.badCloses.length} "Closed this session" entr${led.badCloses.length === 1 ? "y lacks" : "ies lack"} an ID or a receipt — first: ${led.badCloses[0].entry.slice(0, 80)}`,
      findings,
      null,
    );
  }
  if (led.openAndClosed.length > 0) {
    add(
      "openAndClosed",
      "close",
      `ID(s) ${led.openAndClosed.map((id) => `"${id}"`).join(", ")} are both an open row and a "Closed this session" entry`,
      led.openAndClosed.map((id) => ({ rule: "L3", msg: `ID "${id}" is both an open ledger row and a "Closed this session" entry — one of them is wrong` })),
      null,
    );
  }
  return out;
}

// What the PRIOR may skip, and why — nothing else. A prior is read only for the rows it held OPEN:
//   noSection      a prior with no ledger and no table held no rows: the caller reads it as "no
//                  forest-ledger section" (a note, nothing to conserve), never as a first commit;
//   badClose       its close list decides nothing about which rows it held open;
//   openAndClosed  likewise — the row is read as open, which is the fail-closed reading.
//   dupes          reported as an L4 transparency finding instead, and every occurrence is still
//                  conserved (review-sec-r11-F6 added this kind so --aggregate refuses it too).
const PRIOR_IGNORES = new Set(["noSection", "dupes", "badClose", "openAndClosed"]);

// Read `HEAD:./<rel>` from `cwd`. Four outcomes, never a boolean: the ledger text; git
// ANSWERED that there is none (no repo, no HEAD, or no such path — the caller decides which
// matters); an entry that is not a regular file (a symlink or a directory — UNRUNNABLE);
// or the question could not be asked (no envelope, timeout, buffer, spawn) — UNRUNNABLE.
function readPriorAt(cwd, rel) {
  // Raw BYTES, decoded below by the one decoder (decodeText): a utf8 read replaced invalid bytes
  // with U+FFFD, which could then not be told from a real U+FFFD in the text.
  const shown = gitRun(["show", `HEAD:./${rel}`], { cwd, maxBuffer: 16 * 1024 * 1024, encoding: "buffer" });
  if (shown.ok) {
    // A path committed as a SYMLINK prints its link target, not a ledger — and that text
    // then read as "no section", exit 0, over a real vanish (review-sec-r3-HIGH-2). Ask the
    // tree for the entry's MODE: list the parent tree by object (`HEAD:<dir>`, root-relative)
    // with --full-tree — without it ls-tree silently narrows to the cwd's prefix (measured) —
    // and match the name in JS, never via a pathspec, which would glob.
    const pre = gitRun(["rev-parse", "--show-prefix"], { cwd });
    const repoPath = pre.ok ? path.posix.normalize(`${pre.stdout.replace(/\r?\n$/, "")}${rel}`) : null;
    const dir = repoPath === null ? null : path.posix.dirname(repoPath);
    const tree =
      repoPath === null
        ? pre
        : gitRun(["ls-tree", "-z", "--full-tree", `HEAD:${dir === "." ? "" : dir}`], { cwd, maxBuffer: 64 * 1024 * 1024 });
    if (!tree.ok) {
      return {
        unrunnable:
          `L4 anti-vanish DID NOT RUN: read '${rel}' at HEAD but could not ask what KIND of entry it is ` +
          `(${tree.noEnvelope ? "no git envelope" : "git failed"}), so a committed symlink cannot be ruled out. This is NOT a pass.`,
      };
    }
    const name = path.posix.basename(repoPath);
    const entry = tree.stdout.split("\0").find((e) => e.slice(e.indexOf("\t") + 1) === name);
    if (entry && entry.startsWith("120000 ")) {
      return {
        unrunnable:
          `L4 anti-vanish DID NOT RUN: '${repoPath}' is a SYMLINK in HEAD, so its committed content is a ` +
          `link target, not a ledger — there is no prior ledger text to conserve against. This is NOT a pass.`,
      };
    }
    // Only a regular file carries ledger text. A DIRECTORY entry prints its listing, which
    // read as a ledger-less prior (review-sec-r4-L4); an entry that cannot be found in its
    // own parent tree is a question this code did not answer.
    if (!entry || !(entry.startsWith("100644 ") || entry.startsWith("100755 "))) {
      return {
        unrunnable:
          `L4 anti-vanish DID NOT RUN: '${repoPath}' at HEAD is ${entry ? "not a regular file" : "not found in its own parent tree"}, ` +
          `so there is no prior ledger text to conserve against. This is NOT a pass.`,
      };
    }
    const d = decodeText(shown.stdout);
    if (d.problem) {
      return {
        unrunnable: `L4 anti-vanish DID NOT RUN: the prior committed file cannot be read — ${d.problem}. This is NOT a pass.`,
      };
    }
    return { text: d.text };
  }
  if (shown.noEnvelope) {
    return {
      unrunnable:
        `L4 anti-vanish DID NOT RUN: the git subprocess envelope could not be loaded, so the ` +
        `prior ledger cannot be read without trusting whatever repository the environment names. ` +
        `This is NOT a pass.`,
    };
  }
  if (!gitAnswered(shown)) {
    // A read that did not run to completion could not ASK — unrunnable, exit 3. It used
    // to be a finding (exit 1), which made "could not ask" exit 1 here and 3 below.
    const e = shown.error || {};
    return {
      unrunnable:
        `L4 anti-vanish DID NOT RUN: \`git show\` did not complete ` +
        `(${e.code || e.signal || (/maxBuffer/i.test(e.message || "") ? "maxBuffer" : "spawn")}), ` +
        `so the prior ledger was never read. This is NOT a pass, and NOT a finding about the ledger.`,
    };
  }
  return { absent: true };
}

function priorOpen(notesPath) {
  // The prior COMMITTED ledger L4 conserves against. Every git call goes through the
  // envelope (an inherited GIT_DIR outranks discovery; measured: pointed at a decoy repo,
  // an un-enveloped read printed "OK forest-ledger conformant" over a real vanish).
  //
  // WHICH COMMITTED FILE IS THIS LEDGER THE SUCCESSOR OF? Asking about one identity has
  // failed open in both directions, each measured or traced:
  //   - the path AS TYPED, from the cwd: `.SESSION-NOTES` on a case-insensitive disk and an
  //     untracked symlink alias both read as "never committed" (exit 0 over a vanish), and
  //     run from a subdirectory `HEAD:<path>` named the ROOT ledger, not the file read;
  //   - the REAL file only: a tracked ledger replaced by a symlink, or a directory on its
  //     path turned into a nested repository, moved the comparison to a HEAD that never
  //     held it (exit 0 over a vanish).
  // So every identity the path can have is asked, and the prior is the UNION of what they
  // hold — fail-closed: a row any of them committed must be carried or closed.
  //   real      — the file on disk (native realpath: on-disk spelling, symlinks collapsed),
  //               asked from its own directory, so a nested repo is asked as itself;
  //   as-named  — the name as typed, in its real directory, NOT following the leaf;
  //   from-cwd  — the path as typed, relative to the directory the tool was started in,
  //               which git resolves lexically: a symlinked or nested directory on the
  //               path cannot move it.
  // The leading `HEAD:` keeps every token a <rev>:<path>; no name is a bare argv element.
  const lex = path.resolve(notesPath);
  let real;
  let parentReal;
  try {
    // Resolve the path AS GIVEN, not `lex`: path.resolve() folds `..` lexically, but the
    // kernel — which is what validate() read — applies `..` AFTER following a symlink, so
    // `lnk/../x` read one file and conserved another (review-sec-r3-MED-2).
    real = realpathSync.native(notesPath);
    parentReal = realpathSync.native(path.dirname(notesPath));
  } catch (e) {
    return {
      unrunnable:
        `L4 anti-vanish DID NOT RUN: '${notesPath}' could not be resolved to a real path ` +
        `(${(e && e.code) || "error"}). This is NOT a pass.`,
    };
  }
  const idents = [{ label: "real", cwd: path.dirname(real), rel: path.basename(real) }];
  idents.push({ label: "as-named", cwd: parentReal, rel: path.basename(notesPath) });
  const fromCwd = path.relative(process.cwd(), lex);
  if (fromCwd && !fromCwd.startsWith("..") && !path.isAbsolute(fromCwd)) {
    idents.push({ label: "from-cwd", cwd: process.cwd(), rel: fromCwd.split(path.sep).join("/") });
  }
  // An identity is a QUESTION — (directory git is asked from, path it is asked about) — not
  // a filesystem path: the same file asked from a nested repo and from the repo around it
  // are two identities, and collapsing them by path is exactly how a planted nested repo
  // hid a vanish. Only an identical question is dropped.
  const seen = new Set();
  const distinct = idents.filter((id) => {
    const k = `${id.cwd}\0${id.rel}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const found = [];
  const unfound = [];
  for (const id of distinct) {
    const r = readPriorAt(id.cwd, id.rel);
    if (r.unrunnable) return r;
    if (r.text !== undefined) found.push({ label: id.label, text: r.text });
    else unfound.push(id);
  }
  if (found.length > 0) {
    // An identity that found nothing leaves the union — so its "nothing" must be a real
    // answer, not a failure: in a partial clone a missing blob makes `git show` answer no
    // exactly like a never-committed path, and the rows only that identity held silently
    // dropped out while another identity supplied a SMALLER prior (review-sec-r4-H2). The
    // respelling check is skipped here: a case variant of the found file is not a missing
    // prior, it is the prior already read.
    for (const id of unfound) {
      const r = absentAt(id.cwd, id.rel, { respelling: false, outsideRepoIsAbsent: true });
      if (r !== null) return r;
    }
    const ids = new Set();
    const dupes = new Set();
    let anySection = false;
    for (const f of found) {
      // Read through THE ONE READER, refusing EVERY reason it reports except the kinds
      // PRIOR_IGNORES names. A prior read only PARTLY conserves only part — rows after an unclosed
      // fence, rows with too few cells, lines outside the grammar, a second heading, a table under a
      // damaged heading all used to drop out of the comparison, exit 0 (review-sec-r3-MED-3, r4-M2,
      // r5-A1).
      const led = readLedger(f.text);
      for (const p of ledgerProblems(led)) {
        if (PRIOR_IGNORES.has(p.kind)) continue;
        return { unrunnable: `L4 anti-vanish DID NOT RUN: ${p.prior ?? p.summary}. This is NOT a pass.` };
      }
      if (led.form === null) continue;
      if (led.form === "shared") {
        // The shared form merges closed rows OUT with no close record, so a vanished row
        // and a closed one are the same absence. Conserving against it would flag every
        // legitimate close; reading it as "no section" (what this used to do, silently,
        // exit 0) conserves nothing. Neither is an answer.
        return {
          unrunnable:
            `L4 anti-vanish DID NOT RUN: the prior committed ledger is the whole-file shared form ` +
            `("# Forest Ledger"), which removes closed rows without a close record, so a vanished row ` +
            `cannot be told from a closed one. This is NOT a pass.`,
        };
      }
      anySection = true;
      for (const r of led.rows) ids.add(r.id);
      for (const d of led.dupes) dupes.add(d);
    }
    // Name only the identities whose prior DIFFERS from the real file's — asking the same
    // blob by another route (an ordinary run from the repo root) is not an alias to report.
    const realText = found.find((f) => f.label === "real")?.text;
    const via = [...new Set(found.filter((f) => f.label !== "real" && f.text !== realText).map((f) => f.label))];
    return { ids: [...ids], dupes: [...dupes], noSection: !anySection, via };
  }
  // No identity holds a prior. "Never committed" is the ONE verdict that ends in exit 0, so
  // it must be PROVEN, not inferred. It used to be inferred from a single identity, and
  // each round of review found a new way for that identity to be the wrong one (a nested
  // repo or a replaced directory asked from outside the repo; an identity git REFUSED
  // rather than answered; a blob missing under a sibling identity). The invariant now:
  // exit 0 only when EVERY identity was asked, and EVERY one answered "no such path" at a
  // readable HEAD, with no copy under another spelling and no unreadable blob.
  // Whether the as-typed question could be FORMED — tested before de-duplication, which
  // drops it whenever it is the same question as the real one (a file in the cwd).
  if (!idents.some((id) => id.label === "from-cwd")) {
    return {
      unrunnable:
        `L4 anti-vanish DID NOT RUN: no committed prior was found, and '${notesPath}' lies outside ` +
        `the directory this was run from, so the path cannot be asked as typed — a nested repository ` +
        `or a replaced directory on it would go unseen. Run it from inside the repository. ` +
        `This is NOT a pass, and it is NOT the first-commit case.`,
    };
  }
  for (const id of distinct) {
    const r = absentAt(id.cwd, id.rel);
    if (r !== null) return r;
  }
  return null; // case (a): genuinely absent at HEAD, under every identity and spelling
}

// Is `rel` (asked from `cwd`) PROVABLY absent at HEAD? null when proven; otherwise the
// UNRUNNABLE reason. Three facts used to share one answer, all rendered "first commit":
//   (a) the file genuinely is not in HEAD            — the only case that note is true of;
//   (b) no repository / no HEAD / a repo git refuses — nothing was compared;
//   (c) it IS in HEAD but unreadable                 — a partial clone missing the blob, or
//       present only under a different spelling (a case-only rename not yet committed).
function absentAt(cwd, rel, { respelling = true, outsideRepoIsAbsent = false } = {}) {
  // A symlink alias living OUTSIDE any repository (`~/notes -> repo/.session-notes`) gives an
  // as-named identity with no repository at all. When another identity already FOUND the prior,
  // "no repository here" is a real answer for this one — it can hold no committed file — and
  // refusing the run over it was a regression (review-sec-r5-R4). Only in that union branch;
  // for the first-commit verdict it still fails closed.
  if (outsideRepoIsAbsent) {
    // STRUCTURALLY: no `.git` entry in cwd or any ancestor. Git's exit code cannot decide it —
    // "not a repository" and "a repository git REFUSES to read" (safe.directory, a broken
    // config, a dangling worktree gitfile) both exit 128, and reading the second as the first
    // dropped a real prior from the union (review-sec-r6-L3). A refused repo falls through and
    // fails closed below.
    let dir = path.resolve(cwd);
    let found = false;
    for (;;) {
      if (existsSync(path.join(dir, ".git"))) {
        found = true;
        break;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (!found) return null;
  }
  const head = gitRun(["rev-parse", "--verify", "HEAD"], { cwd });
  if (!head.ok) {
    return {
      unrunnable: gitAnswered(head)
        ? `L4 anti-vanish DID NOT RUN: git reports no readable HEAD for this tree, so there is no ` +
          `prior committed ledger to conserve against — a snapshot (an offload carrying the working ` +
          `tree without the history, a --depth=1 clone, a re-initialised directory), or a checkout ` +
          `git refuses to read (e.g. safe.directory ownership). This is NOT a pass — nothing was compared.`
        : `L4 anti-vanish DID NOT RUN: could not ask git whether this tree has a HEAD ` +
          `(${head.noEnvelope ? "no git envelope" : "git did not run to completion"}). This is NOT a pass.`,
    };
  }
  // Decide (a) vs (c) against the WHOLE tree at HEAD, compared in JS: `ls-tree` pathspecs
  // are case-sensitive and git refuses `:(icase)` for ls-tree (measured: "pathspec magic
  // not supported by this command: 'icase'", rc 128), so a pathspec query cannot see a case
  // variant. ~0.8 MB on this repo; read only on this branch.
  // Toplevel and prefix from SEPARATE calls, each losing exactly its one trailing newline:
  // splitting one combined output on newlines broke on a directory whose name contains one
  // (review-sec-r3-LOW-3), the sibling of the leading-space trim (review-sec-r2-LOW-1).
  const topR = gitRun(["rev-parse", "--show-toplevel"], { cwd });
  const where = topR.ok ? gitRun(["rev-parse", "--show-prefix"], { cwd }) : topR;
  const listed = where.ok
    ? gitRun(["ls-tree", "-r", "--full-tree", "--name-only", "-z", "HEAD"], { cwd, maxBuffer: 64 * 1024 * 1024 })
    : where;
  if (!listed.ok) {
    return {
      unrunnable:
        `L4 anti-vanish DID NOT RUN: could not list HEAD to tell "absent" from "present but ` +
        `unreadable" (${listed.noEnvelope ? "no git envelope" : "git failed"}). This is NOT a pass, ` +
        `and it is NOT the first-commit case.`,
    };
  }
  const top = topR.stdout.replace(/\r?\n$/, "");
  const prefix = where.stdout.replace(/\r?\n$/, "");
  const want = path.posix.normalize(`${prefix}${rel}`);
  // Fold case AND Unicode form: APFS keeps a name in the form it was CREATED in, so a
  // directory committed NFC and recreated NFD is the same name to a reader and a different
  // one to git (review-cor-r3-M3).
  const fold = (s) => s.normalize("NFC").toLowerCase();
  const names = listed.stdout.split("\0").filter(Boolean);
  if (names.includes(want)) {
    return {
      unrunnable:
        `L4 anti-vanish DID NOT RUN: '${want}' IS present at HEAD but its blob could not be read ` +
        `(a partial or shallow clone). This is NOT a pass, and it is NOT the first-commit case.`,
    };
  }
  if (!respelling) return null;
  let realIno = null;
  try {
    realIno = statSync(path.join(cwd, rel)).ino;
  } catch {
    realIno = null;
  }
  const respelled = names.filter((n) => {
    if (fold(n) !== fold(want)) return false;
    // On a case-SENSITIVE disk a name differing only in case can be a DIFFERENT file; that
    // one is not this ledger's history, and refusing a genuine first commit over it would
    // be wrong. Same inode (or no separate file on disk) is a respelling.
    try {
      const st = statSync(path.join(top, n));
      return realIno === null || st.ino === realIno;
    } catch {
      return true;
    }
  });
  if (respelled.length === 0) return null;
  return {
    unrunnable:
      `L4 anti-vanish DID NOT RUN: '${want}' is present at HEAD only under a different spelling ` +
      `('${respelled[0]}'). This is NOT a pass, and it is NOT the first-commit case.`,
  };
}

function validate(notesPath, { gitPrior } = {}) {
  let buf;
  try {
    buf = readFileSync(notesPath);
  } catch (e) {
    return { ok: false, error: `cannot read ${notesPath}: ${e.message}` };
  }

  const findings = [];
  const d = decodeText(buf);
  if (d.problem) {
    findings.push({ rule: "L1", msg: `the file cannot be read as a ledger — ${d.problem}` });
    return { ok: false, findings };
  }
  // Two ledger shapes carry the SAME L1/L2/L3/L5 contract:
  //   (a) inline    `## Outstanding ledger (forest)` inside a notes file
  //   (b) shared    whole-file `# Forest Ledger` (`.session-notes.shared.md`)
  // (b) is the form `knowledge-convergence.md` MUST-1 MANDATES alongside the
  // per-operator `.session-notes.d/<display_id>.md` fragments; without it the mandated shared
  // form failed L1 for lacking a heading it is never supposed to have.
  // Read through THE ONE READER, and render EVERY reason it reports (ledgerProblems) — the prior
  // and --aggregate render the same list.
  const led = readLedger(d.text);
  const problems = ledgerProblems(led);
  const render = (stage) => {
    for (const p of problems) if (p.stage === stage) findings.push(...p.findings);
  };
  if (led.form === null) {
    render("read");
    return { ok: false, findings };
  }
  render("read");
  render("dupes");

  const { emptyForest, rows, entries } = led;
  if (emptyForest && rows.length > 0) {
    findings.push({
      rule: "L2",
      msg: `"Forest empty" asserted but ${rows.length} open row(s) present — contradictory ledger state`,
    });
  }
  if (!(emptyForest && rows.length === 0)) {
    for (const r of rows) {
      if (r.anchor === "" || /^-+$/.test(r.anchor)) {
        findings.push({
          rule: "L2",
          msg: `ledger row "${r.id}" has no value-anchor (value-prioritization.md MUST-1+2)`,
        });
      }
    }
  }
  render("close");

  if (gitPrior) {
    const prior = priorOpen(notesPath);
    if (prior === null) {
      findings.push({
        rule: "L4",
        severity: "note",
        msg: `no prior committed .session-notes (first commit) — nothing to conserve against (not a failure)`,
      });
    } else if (prior.unrunnable) {
      findings.push({ rule: "L4", severity: "unrunnable", msg: prior.unrunnable });
    } else {
      if (prior.noSection) {
        findings.push({
          rule: "L4",
          severity: "note",
          msg: `the prior committed file has no forest-ledger section — nothing to conserve against`,
        });
      }
      if (prior.via && prior.via.length > 0) {
        findings.push({
          rule: "L4",
          severity: "note",
          msg: `prior read through ${prior.via.join(" + ")}, not only through the file on disk — the ledger is reached through a symlink, another spelling or a nested repository, so it is conserved against every committed prior it could succeed`,
        });
      }
      // prior ledger was non-L5-clean (duplicate IDs) — conservation is
      // ambiguous; surface it rather than trust silently (journal/0097
      // cc-arch MED). Per-occurrence iteration below still fails LOUD
      // (each prior occurrence must be individually satisfied), so this
      // is a transparency finding, not a masked-vanish.
      for (const d of prior.dupes || []) {
        findings.push({
          rule: "L4",
          msg: `prior committed ledger had duplicate ID "${d}" — it was not L5-clean; ID-conservation against it is ambiguous`,
        });
      }
      const currentIds = new Set(rows.map((r) => r.id));
      const closedIds = new Set(
        entries.map(closeEntryId).filter((x) => x !== ""),
      );
      for (const id of prior.ids) {
        if (!currentIds.has(id) && !closedIds.has(id)) {
          findings.push({
            rule: "L4",
            msg: `prior open ID "${id}" vanished — not carried forward and not referenced in "Closed this session" (wrapup.md reconciliation step 2). A close is a bullet (\`- ${id} → PR #N\`) under a line starting "Closed this session"; a blank line, an unindented non-bullet line, or a line ending in ":" ends that list`,
          });
        }
      }
    }
  }

  // THREE buckets, not two. `unrunnable` is neither a finding about the ledger nor a
  // clean result: it records that a check did not execute. Folding it into `hard` would
  // report a defect that was never observed; leaving it in `note` (where it used to sit)
  // reports a clean run that never happened.
  const unrunnable = findings.filter((f) => f.severity === "unrunnable");
  const hard = findings.filter((f) => f.severity !== "note" && f.severity !== "unrunnable");
  return { ok: hard.length === 0 && unrunnable.length === 0, hard_count: hard.length, unrunnable, findings };
}

// ============================================================================
//  Workspace→root aggregation (--aggregate) — the CROSS-FILE anti-vanish gate
//  (issue #669). The intra-file --git-prior gate above conserves IDs WITHIN one
//  .session-notes across commits; this gate conserves them ACROSS the
//  workspace→root boundary: every OPEN forest-ledger row in a
//  workspaces/*/.session-notes (or its M6-D split .session-notes.shared.md)
//  MUST be reflected in the ROOT ledger (open row OR "Closed this session"
//  reference). A workspace-open ID absent from root is a STRANDED item — the
//  exact "vanish" /sweep + /wrapup were blind to before #669. Detection is
//  purely structural (ID-set membership); no client/org tokens (synced artifact).
// ============================================================================

// Resolve the forest-ledger file for a directory: the M6-D split
// `.session-notes.shared.md` takes precedence (knowledge-convergence.md MUST-1),
// else the legacy inline `.session-notes`. null if neither exists.
function resolveLedgerPath(dir) {
  const shared = path.join(dir, ".session-notes.shared.md");
  if (existsSync(shared)) return shared;
  const inline = path.join(dir, ".session-notes");
  if (existsSync(inline)) return inline;
  return null;
}

// File-level reasons (a read error, bytes that are not UTF-8 text) are decided here, before any
// ledger exists to read; every ledger-level reason comes from ledgerProblems.
// Collect OPEN row IDs + closed-this-session IDs from a ledger file, handling BOTH shapes, through
// THE ONE READER (readLedger) — so --aggregate refuses exactly what the bare check and the prior
// refuse (review-sec-r9-F7), and reads every line ending (review-cor-r9-F1). `problems` lists every
// reason the IDs cannot be read exactly, a read error included.
// "Open" = a table-row ID NOT referenced in a "Closed this session" entry.
function collectLedgerIds(filePath) {
  let buf;
  try {
    buf = readFileSync(filePath);
  } catch (e) {
    // An unreadable ledger (permissions, a DIRECTORY where the file should be) is a problem, never
    // a skipped one: returning null here made --aggregate report "0 workspace ledger(s); all open
    // IDs reflected" over a stranded row (review-sec-r11-F5).
    return { openIds: [], closedIds: [], problems: [{ kind: "unreadable", summary: `it cannot be read (${(e && e.code) || "error"})` }] };
  }
  const d = decodeText(buf);
  if (d.problem) return { openIds: [], closedIds: [], problems: [{ kind: "encoding", summary: d.problem }] };
  const led = readLedger(d.text);
  const closedIds = new Set(led.entries.map(closeEntryId).filter((x) => x !== ""));
  const openIds = [...new Set(led.rows.map((r) => r.id).filter((id) => !closedIds.has(id)))];
  return { openIds, closedIds: [...closedIds], problems: ledgerProblems(led) };
}

// List workspaces under <root>/workspaces, skipping `instructions` + any leading-underscore
// meta-dir (cc-artifacts.md Rule 8). Sorted for determinism. Each entry is judged ON ITS OWN: a
// symlinked workspace is followed, and one that cannot be followed (a loop, a dangling link, a
// permission error) is returned WITH its error — the round-11 version let one bad link throw out of
// the whole listing, so --aggregate read "0 workspace ledger(s)" over a stranded row
// (review-sec-r12-F1).
function listWorkspaces(rootDir) {
  const wsRoot = path.join(rootDir, "workspaces");
  let entries;
  try {
    entries = readdirSync(wsRoot, { withFileTypes: true });
  } catch (e) {
    return e && e.code === "ENOENT" ? [] : [{ name: ".", error: (e && e.code) || "error" }];
  }
  const out = [];
  for (const e of entries) {
    if (e.name === "instructions" || e.name.startsWith("_")) continue;
    if (e.isDirectory()) {
      out.push({ name: e.name });
    } else if (e.isSymbolicLink()) {
      try {
        if (statSync(path.join(wsRoot, e.name)).isDirectory()) out.push({ name: e.name });
      } catch (err) {
        out.push({ name: e.name, error: (err && err.code) || "error" });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function aggregate(rootDir) {
  const findings = [];

  // Root ledger known-ID set = its open rows ∪ its closed-this-session refs.
  // A workspace-open ID present in EITHER is "reflected at root" (not stranded).
  const rootLedger = resolveLedgerPath(rootDir);
  const rootKnown = new Set();
  let rootAbsent = false;
  if (rootLedger) {
    const r = collectLedgerIds(rootLedger);
    if (r.problems.length > 0) {
      findings.push({
        rule: "AGG",
        msg: `root ledger ${path.relative(rootDir, rootLedger)} cannot be read exactly — ${r.problems.map((p) => p.summary).join("; ")} — so its IDs cannot be reconciled against`,
      });
    }
    for (const id of r.openIds) rootKnown.add(id);
    for (const id of r.closedIds) rootKnown.add(id);
  } else {
    rootAbsent = true;
  }

  // Collect every (workspace, open-id) pair; flag those absent from root.
  const stranded = [];
  let workspacesWithLedger = 0; // workspaces holding at least one ledger file, not files
  for (const ws of listWorkspaces(rootDir)) {
    const dir = path.join(rootDir, "workspaces", ws.name);
    const relDir = path.relative(rootDir, dir);
    // A workspace that cannot be listed hides its ledger from existsSync, which then read as "no
    // ledger" (review-sec-r12-F4). Report it.
    let err = ws.error;
    if (!err) {
      try {
        readdirSync(dir);
      } catch (e) {
        err = (e && e.code) || "error";
      }
    }
    if (err) {
      findings.push({ rule: "AGG", msg: `workspace ${relDir} cannot be read (${err}) — any ledger in it is not reconciled` });
      continue;
    }
    // BOTH ledger files, when both exist: the shared file used to win and a legacy
    // `.session-notes` holding an open row was never read (review-sec-r12-F4).
    const ledgers = [".session-notes.shared.md", ".session-notes"].map((n) => path.join(dir, n)).filter((p) => existsSync(p));
    if (ledgers.length > 0) workspacesWithLedger++;
    for (const led of ledgers) {
      const r = collectLedgerIds(led);
      const rel = path.relative(rootDir, led);
      if (r.problems.length > 0) {
        findings.push({
          rule: "AGG",
          msg: `workspace ledger ${rel} cannot be read exactly — ${r.problems.map((p) => p.summary).join("; ")} — so its open IDs cannot be reconciled`,
        });
      }
      for (const id of r.openIds) {
        if (!rootKnown.has(id)) stranded.push({ id, ws: ws.name, rel });
      }
    }
  }
  // Deterministic ordering: by workspace path, then by ID.
  stranded.sort((a, b) => a.rel.localeCompare(b.rel) || a.id.localeCompare(b.id));

  if (rootAbsent && stranded.length > 0) {
    findings.push({
      rule: "AGG",
      msg: `no root ledger (.session-notes / .session-notes.shared.md) at ${rootDir} — ${stranded.length} open workspace ID(s) cannot be reconciled upward (wrapup.md rollup never ran)`,
    });
  }
  for (const s of stranded) {
    findings.push({
      rule: "AGG",
      msg: `open workspace-ledger ID "${s.id}" (${s.rel}) absent from root ledger — workspace→root no-vanish (issue #669)`,
    });
  }

  return {
    ok: findings.length === 0,
    findings,
    rootLedger: rootLedger ? path.relative(rootDir, rootLedger) : null,
    workspacesScanned: workspacesWithLedger,
    strandedCount: stranded.length,
  };
}

// ---- CLI ----
const args = process.argv.slice(2);
const json = args.includes("--json");
const gitPrior = args.includes("--git-prior");
const doAggregate = args.includes("--aggregate");
// `--root <dir>` takes the next token; everything else non-`--` is the
// positional .session-notes path (intra-file modes).
let rootDir = null;
const positionals = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--root") {
    rootDir = args[++i];
    continue;
  }
  if (a.startsWith("--")) continue;
  positionals.push(a);
}
const notesPath = positionals[0];

if (doAggregate) {
  // Workspace→root aggregation (issue #669). Default root = cwd.
  const root = rootDir || process.cwd();
  const result = aggregate(root);
  if (json) {
    console.log(JSON.stringify({ mode: "aggregate", root, ...result }, null, 2));
  } else if (result.ok) {
    console.log(
      `OK forest-ledger aggregation: ${result.workspacesScanned} workspace ledger(s); all open IDs reflected in root (${result.rootLedger || "no root ledger, but nothing to reconcile"})`,
    );
  } else {
    console.log(`FAIL forest-ledger aggregation: ${root}`);
    for (const f of result.findings) console.log(`  [${f.rule}] ${f.msg}`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (!notesPath) {
  console.error(
    "usage: validate-forest-ledger.mjs [--json] [--git-prior] <.session-notes>\n" +
      "       validate-forest-ledger.mjs --aggregate [--json] [--root <repo-root>]",
  );
  process.exit(2);
}

const result = validate(notesPath, { gitPrior });

if (result.error) {
  console.error(result.error);
  process.exit(2);
}

if (json) {
  console.log(JSON.stringify({ file: notesPath, ...result }, null, 2));
} else if (result.ok) {
  console.log(`OK forest-ledger conformant: ${notesPath}`);
  for (const f of result.findings || [])
    console.log(`  [${f.rule}] note: ${f.msg}`);
} else if ((result.hard_count || 0) === 0 && (result.unrunnable || []).length > 0) {
  console.log(`UNRUNNABLE forest-ledger: ${notesPath}`);
  for (const f of result.findings)
    console.log(`  [${f.rule}]${f.severity === "note" ? " note:" : ""} ${f.msg}`);
  console.log(`  A check did not execute. This is NOT a pass and NOT a finding.`);
} else {
  console.log(`FAIL forest-ledger: ${notesPath}`);
  for (const f of result.findings)
    console.log(`  [${f.rule}]${f.severity === "note" ? " note:" : ""} ${f.msg}`);
}

// 0 conformant · 1 findings · 3 a check could not run. Exit 3 ONLY when nothing else
// failed: a real finding outranks an unrunnable sibling, because a defect that WAS
// observed is the more actionable fact.
if (result.ok) process.exit(0);
process.exit((result.hard_count || 0) === 0 && (result.unrunnable || []).length > 0 ? 3 : 1);
