/**
 * decision-packet.js — the PURE PREDICATES behind `recommendation-quality.md`
 * MUST-6 § "'The Human Decides' Means Ratify A Recommendation — Not Fill A Blank":
 * does a decision packet carry a recommendation on every row, or does it hand the
 * human a blank to fill from scratch?
 *
 * --- WHY THIS CLAUSE IS MECHANICALLY DECIDABLE AND ITS SIBLINGS ARE NOT -------
 * `recommendation-quality.md`'s other clauses are properties of agent PROSE, and
 * the repo has already retired MUST-7's detector on exactly that ground. MUST-6
 * is different, and the deferral row that graduated into this file said so: "A
 * decision packet is a FILE rather than prose, so unlike the sibling clauses in
 * this rule its emptiness is structurally checkable; the existing
 * detectMenuWithoutPick covers only the prose form."
 *
 * The SHAPE is DECLARED, not invented here. Two sources fix it:
 *   - `recommendation-quality.md` MUST-6: "`DO` (packet): each row = recommendation
 *     + spec basis + honest con + \"RATIFY / OVERRIDE\". ... `DO NOT`: a row with an
 *     empty `→ ANSWER:` field; a recommendation cell that says \"needs input\" /
 *     \"TBD\" / \"depends\" (a blank in table costume)".
 *   - `guides/rule-extracts/recommendation-quality.md` § "MUST-6 detection", which
 *     specifies this very detector: "a `PostToolUse(Write)` hook scanning
 *     decision-packet / brief files for ... empty answer-field markers (`→ ANSWER:`
 *     followed by blank; empty table cells under an \"answer\"/\"recommendation\"
 *     column; recommendation cells equal to \"TBD\"/\"needs input\"/\"depends\")."
 * Every token this module matches is lifted from one of those two lines. Nothing
 * is extrapolated, and in particular NO PATH CONVENTION IS ASSUMED — see below.
 *
 * --- SCOPE IS SELF-DECLARED BY THE FILE, NEVER BY ITS PATH -------------------
 * The repo declares no path convention, no frontmatter `kind:` and no template
 * for a decision packet. MEASURED: packets live at
 * `workspaces/<ws>/decisions/00-decision-packet.md`, at
 * `workspaces/<ws>/02-plans/00-open-decisions.md`, and as a SECTION inside files
 * named for something else entirely (`ANALYSIS.md` § 8, `00-plan-overview.md`
 * § "Decision packet for the approval gate"). A filename matcher would therefore
 * both over- and under-reach, and inventing one would be the hand-listed
 * enumeration this corpus keeps getting burned by.
 *
 * So a file is IN SCOPE iff it CARRIES the packet's own declared markers — a
 * ratify gate, or an `ANSWER`-marker column. That predicate is the packet's
 * self-identification, which is the only authority the rule actually supplies.
 *
 * --- EMPTY, ABSENT AND FILLED ARE THREE STATES, NEVER TWO -------------------
 * Collapsing them is the whole defect this detector exists to avoid, so they are
 * three separate verdicts with three separate rule_ids:
 *
 *   FILLED         a cell exists at the answer column and carries content.
 *   EMPTY          a cell EXISTS at the answer column and is blank — whitespace,
 *                  or a blank-FILL run (`____`, `\_\_`, `***`), which renders as a
 *                  ruled line for a human to write on and is a blank in ink.
 *                  ⇒ `packet-answer-empty`
 *   PUNT           a cell exists and carries one of the DECLARED punt tokens.
 *                  Non-empty as a string, so `cell === ""` MISSES it entirely.
 *                  ⇒ `packet-answer-punt`
 *   ABSENT (cell)  the row has NO cell at the answer index — a ragged row. This
 *                  is NOT the same fact as an empty cell and is not reported as
 *                  one: it is INDETERMINATE, because the row may be malformed
 *                  rather than blank. ⇒ `packet-row-indeterminate`
 *   ABSENT (col)   the table has no answer-class column at all ⇒ IT IS NOT A
 *                  PACKET TABLE, and this module is SILENT. That silence is the
 *                  absence of an instrument, never an all-clear
 *                  (`instrument-discipline.md` MUST-3(a)).
 *
 * The last two are why a naive "is the field an empty string" check gets this
 * wrong in BOTH directions, and both directions ship as fixtures.
 *
 * --- THE FALSE POSITIVE THIS MUST NOT MAKE ----------------------------------
 * A COMPLIANT packet CONTAINS BLANKS BY DESIGN. The human's signature slot —
 * `- **→ RATIFY / OVERRIDE: \*\***\_\_**\*\***`, or an empty "Your call" cell — is
 * SUPPOSED to be blank; that blank IS the ratify affordance MUST-6 demands. A
 * detector that flags any empty field in a packet flags every correct packet in
 * the repo and teaches the operator to ignore it. Only the ANSWER/RECOMMENDATION
 * column is ever inspected; the ratify column is never read for emptiness.
 *
 * --- SEVERITY: `halt-and-report`, and why not `block` ------------------------
 * The table walk is STRUCTURAL — a parsed pipe-table, a header index, a cell at
 * that index — and a structural signal MAY carry `block` under
 * `hook-output-discipline.md` MUST-2. This detector does NOT take that, because a
 * detector is no stronger than its weakest half and two halves here are LEXICAL:
 * deciding that a header cell reading "Recommendation (spec basis)" is an answer
 * column at all, and deciding that a cell reading "depends on the vendor" is a
 * punt rather than a real finding, are both prose matches. MUST-2 caps a finding
 * resting on a prose match at `halt-and-report`. The rendered register at
 * PostToolUse is honest for it too: the write ALREADY RAN, which is what the
 * `halt-and-report` head says.
 *
 * --- PURITY ------------------------------------------------------------------
 * NOTHING here touches the filesystem, spawns a process, or reads the
 * environment. Both inputs arrive on the context object, so the fixtures drive
 * the real predicates rather than a re-implementation. All I/O lives in
 * `../decision-packet-guard.js`.
 *
 * Origin: graduated 2026-09-15 from
 * `phase2-deferrals.json::deferrals["recommendation-quality.md#must6-decision-packets"]`,
 * whose registered graduation condition was "Delete this entry when the
 * decision-packet PostToolUse(Write) scanner ships with fixtures."
 */

"use strict";

/** Bound every evidence string so a long packet cannot flood the response. */
const EVIDENCE_MAX = 220;

/**
 * The DECLARED punt tokens, lifted verbatim from the rule and its extract:
 * "needs input" / "TBD" / "depends" (rule MUST-6 + extract § MUST-6 detection),
 * and "needs founder input" (the extract's own DO-NOT table cell). `to be
 * determined` is admitted as the unabbreviated form of TBD and is the ONLY
 * extension; nothing else is added, because a token nobody declared would make
 * this a matcher for a shape nobody agreed to.
 */
const PUNT_PATTERNS = [
  /^tbd\b/i,
  /^to be determined\b/i,
  /^depends\b/i,
  /^needs\s+(?:\S+\s+)*input\b/i,
  /^needs\s+input\b/i,
];

/**
 * Header text that names the column carrying the AGENT's recommendation — the
 * one MUST-6 requires to be filled.
 */
const ANSWER_HEADER = /\b(recommendation|answer)\b/i;

/**
 * Header text that names the column carrying the HUMAN's ratify/override choice.
 * NEVER inspected for emptiness — see "THE FALSE POSITIVE" in the header.
 */
const RATIFY_HEADER = /\b(ratify|override|your call)\b/i;

/** A packet's ratify gate, as MUST-6 spells it. Used for whole-file scope. */
const RATIFY_MARKER = /\bRATIFY\s*\/\s*OVERRIDE\b/;

/** The bulleted packet's recommendation field, e.g. `- **Recommendation:** ...`. */
const RECOMMENDATION_BULLET =
  /^\s*(?:[-*+]\s*)?\*\*\s*recommendation\s*:?\s*\*\*\s*:?\s*(.*)$/i;

/** The prose answer marker, e.g. `→ ANSWER:` / `-> ANSWER:`. */
const ANSWER_MARKER = /(?:→|->)\s*ANSWER\s*:/;

function sanitize(s) {
  if (typeof s !== "string") return "";
  const flat = s
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > EVIDENCE_MAX
    ? flat.slice(0, EVIDENCE_MAX) + "..."
    : flat;
}

/**
 * Remove FENCED code blocks, replacing each line with "" so line numbers survive.
 *
 * LOAD-BEARING, not hygiene. `recommendation-quality.md`'s own extract carries
 * the canonical BLANK-MENU table inside a ```markdown fence as its DO-NOT
 * example. Without this strip the detector's loudest true positive would be the
 * rule's own documentation of the thing it forbids — a guard that fires on the
 * text describing the violation is the shape `git.md`'s merge-separation guard
 * records as "a heredoc'd or quoted example stays silent".
 */
function stripFencedBlocks(text) {
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push("");
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length)
        fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * True when `index` inside `line` falls within a backtick code span.
 *
 * Also load-bearing: the RULE BODY writes the marker as `` `→ ANSWER:` `` in
 * running prose. An inline-code occurrence is a CITATION of the marker, never an
 * instance of it. Note this is applied ONLY to the prose-marker check — inline
 * spans are deliberately NOT stripped before the table walk, because a cell whose
 * whole content is `` `--flag` `` would then normalize to empty and be reported
 * as a blank recommendation.
 */
function insideCodeSpan(line, index) {
  let ticks = 0;
  for (let i = 0; i < index; i += 1) if (line[i] === "`") ticks += 1;
  return ticks % 2 === 1;
}

/** Split one markdown table row into its cells, dropping the outer delimiters. */
function splitRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const parts = trimmed.split("|");
  parts.shift();
  if (parts.length && /^\s*$/.test(parts[parts.length - 1])) parts.pop();
  return parts.map((c) => c.trim());
}

/** A GFM delimiter row: every cell is dashes with optional alignment colons. */
function isDelimiterRow(cells) {
  return (
    cells.length > 0 &&
    cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s+/g, "")))
  );
}

/**
 * Reduce a cell to the content a human would read as an ANSWER.
 *
 * Strips markdown emphasis and the blank-FILL idiom this repo actually uses for
 * a signature slot (`\*\***\_\_**\*\***` renders as a ruled line). A cell that is
 * NOTHING BUT fill is EMPTY, which is the point: it looks filled to `cell === ""`
 * and is a blank to the human holding the pen.
 */
function normalizeCell(cell) {
  if (typeof cell !== "string") return "";
  return cell
    .replace(/\\/g, "")
    .replace(/[*_`~]/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/[—–-]+/g, (m) => (m.length >= 2 ? "" : m))
    .trim();
}

/** FILLED | EMPTY | PUNT for a cell that EXISTS. Never called for an absent cell. */
function classifyCell(cell) {
  const norm = normalizeCell(cell);
  if (norm === "") return "EMPTY";
  if (PUNT_PATTERNS.some((re) => re.test(norm))) return "PUNT";
  return "FILLED";
}

/**
 * Every markdown table in `lines`, as {headerLine, headers, rows:[{line, cells}]}.
 * Rows are the body rows only — the header and the delimiter row are excluded.
 */
function parseTables(lines) {
  const tables = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = splitRow(lines[i]);
    if (!header || header.length < 2) continue;
    const delim = splitRow(lines[i + 1] || "");
    if (!delim || !isDelimiterRow(delim)) continue;
    const rows = [];
    let j = i + 2;
    for (; j < lines.length; j += 1) {
      const cells = splitRow(lines[j]);
      if (!cells) break;
      rows.push({ line: j + 1, cells });
    }
    tables.push({ line: i + 1, headers: header, rows });
    i = j - 1;
  }
  return tables;
}

/**
 * Is this a DECISION table, as opposed to any other table that happens to carry
 * the word "recommendation"?
 *
 * Requires an ANSWER-class column, AND either a RATIFY-class column beside it or
 * an answer header that IS the bare `ANSWER` marker (the blank-menu shape, which
 * by construction has no ratify column — it is the thing MUST-6 forbids).
 *
 * The reject pole is real and is fixtured: a data table such as
 * `| profile | actual | budget | ceiling | over ceiling |`, which lives INSIDE a
 * file literally named `1392-budget-decision-packet.md`, has neither column and
 * is silent. That is why the gate is the table's header and not the filename.
 */
function classifyTable(table) {
  let answerIdx = -1;
  let ratifyIdx = -1;
  for (let i = 0; i < table.headers.length; i += 1) {
    const h = normalizeCell(table.headers[i])
      .replace(/(?:→|->)/g, "")
      .replace(/:/g, "")
      .trim();
    if (answerIdx < 0 && ANSWER_HEADER.test(h)) answerIdx = i;
    if (ratifyIdx < 0 && RATIFY_HEADER.test(h)) ratifyIdx = i;
  }
  if (answerIdx < 0) return null;
  const bareAnswerMarker = /^answer$/i.test(
    normalizeCell(table.headers[answerIdx])
      .replace(/(?:→|->)/g, "")
      .replace(/:/g, "")
      .trim(),
  );
  if (ratifyIdx < 0 && !bareAnswerMarker) return null;
  return { answerIdx, ratifyIdx, bareAnswerMarker };
}

/**
 * The verdict. PURE — every input is supplied by the caller.
 *
 * FAILS OPEN on every unknown (`cc-artifacts.md` Rule 7): a non-string path or
 * content, a non-markdown path, content carrying no packet marker at all, a table
 * with no answer column — all return `[]`.
 *
 * @param {object} ctx
 * @param {string} ctx.path     the written file path (any separator)
 * @param {string} ctx.content  the full written file text
 * @returns {Array<{rule_id,severity,evidence}>}
 */
function inspectPacketWrite(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const filePath = typeof c.path === "string" ? c.path : "";
  const content = typeof c.content === "string" ? c.content : "";
  if (!filePath || !content) return [];
  // Markdown only. A packet is a markdown artifact in every measured instance,
  // and a `.json`/`.txt`/`.rs` file carrying the word "recommendation" is not one.
  if (!/\.(?:md|markdown)$/i.test(filePath)) return [];

  const lines = stripFencedBlocks(content);

  // WHOLE-FILE SCOPE GATE. Cheapest discriminator first: no ratify gate and no
  // answer marker anywhere ⇒ this file does not declare itself a packet ⇒ silent.
  const declaresRatify = lines.some((l) => RATIFY_MARKER.test(l));
  const declaresAnswerMarker = lines.some(
    (l) => ANSWER_MARKER.test(l) && !insideCodeSpan(l, l.search(ANSWER_MARKER)),
  );
  if (!declaresRatify && !declaresAnswerMarker) return [];

  const empty = [];
  const punt = [];
  const indeterminate = [];

  // ── FORM A: the TABLE packet.
  for (const table of parseTables(lines)) {
    const kind = classifyTable(table);
    if (!kind) continue; // Not a decision table — absence of a COLUMN, not a blank.
    for (const row of table.rows) {
      if (row.cells.length <= kind.answerIdx) {
        // ABSENT cell — a ragged row. Distinct from EMPTY and reported as such.
        indeterminate.push({ line: row.line, text: row.cells.join(" | ") });
        continue;
      }
      const cell = row.cells[kind.answerIdx];
      const state = classifyCell(cell);
      if (state === "EMPTY")
        empty.push({ line: row.line, text: row.cells.join(" | ") });
      else if (state === "PUNT") punt.push({ line: row.line, text: cell });
    }
  }

  // ── FORM B: the BULLETED packet (`- **Recommendation:** ...`).
  for (let i = 0; i < lines.length; i += 1) {
    const m = RECOMMENDATION_BULLET.exec(lines[i]);
    if (!m) continue;
    let value = m[1] || "";
    // A recommendation wraps across indented continuation lines; read them before
    // calling it blank, or every multi-line recommendation is a false positive.
    for (
      let j = i + 1;
      j < lines.length && normalizeCell(value) === "";
      j += 1
    ) {
      const nxt = lines[j];
      if (/^\s*$/.test(nxt)) break;
      if (/^\s*(?:[-*+]\s|#{1,6}\s|\|)/.test(nxt)) break;
      if (!/^\s+\S/.test(nxt)) break;
      value += " " + nxt.trim();
    }
    const state = classifyCell(value);
    if (state === "EMPTY") empty.push({ line: i + 1, text: lines[i].trim() });
    else if (state === "PUNT")
      punt.push({ line: i + 1, text: sanitize(value) });
  }

  // ── FORM C: the bare prose answer marker with nothing after it.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const at = line.search(ANSWER_MARKER);
    if (at < 0) continue;
    if (insideCodeSpan(line, at)) continue; // A citation of the marker, not one.
    if (splitRow(line)) continue; // Already walked as a table row.
    const rest = line.slice(at).replace(ANSWER_MARKER, "");
    // Routed through classifyCell rather than testing `normalizeCell(rest) === ""`
    // here. Written the second way first, and a MUTATION caught it: disabling
    // classifyCell's EMPTY arm reddened three of the four blank-detecting fixtures
    // and left the bare-marker one GREEN, because this line was a second,
    // independent implementation of the same verdict. Two consequences, both real:
    // the paths could drift apart silently, and `→ ANSWER: TBD` — a punt in
    // bare-marker form — was detected by NOTHING, since only the table and bullet
    // forms ever reached the punt arm. One classifier now owns all three forms.
    const state = classifyCell(rest);
    if (state === "EMPTY") empty.push({ line: i + 1, text: line.trim() });
    else if (state === "PUNT") punt.push({ line: i + 1, text: sanitize(rest) });
  }

  const findings = [];
  const where = sanitize(filePath);

  if (empty.length > 0) {
    findings.push({
      rule_id: "recommendation-quality/packet-answer-empty",
      severity: "halt-and-report",
      evidence:
        `${where}: ${empty.length} decision-packet row(s) have an answer/recommendation ` +
        `field that EXISTS and is BLANK (line ${empty.map((e) => e.line).join(", ")}). ` +
        `MUST-6: "a row with an empty \`→ ANSWER:\` field" is the MUST-1 violation in ` +
        `disguise — the human ratifies a recommendation, they do not fill a blank. ` +
        `First: ${sanitize(empty[0].text)}`,
    });
  }
  if (punt.length > 0) {
    findings.push({
      rule_id: "recommendation-quality/packet-answer-punt",
      severity: "halt-and-report",
      evidence:
        `${where}: ${punt.length} recommendation field(s) carry a DECLARED punt token ` +
        `(line ${punt.map((p) => p.line).join(", ")}) — non-empty as text, so an ` +
        `emptiness check misses them. MUST-6: "a recommendation cell that says ` +
        `'needs input' / 'TBD' / 'depends' (a blank in table costume)". ` +
        `First: ${sanitize(punt[0].text)}`,
    });
  }
  if (indeterminate.length > 0) {
    findings.push({
      rule_id: "recommendation-quality/packet-row-indeterminate",
      severity: "advisory",
      evidence:
        `${where}: ${indeterminate.length} decision-table row(s) have NO cell at the ` +
        `answer column (line ${indeterminate.map((r) => r.line).join(", ")}). This is ` +
        `ABSENT, not EMPTY, and is reported as INDETERMINATE rather than as a blank ` +
        `answer: the row may be malformed rather than unanswered. Read it and decide. ` +
        `First: ${sanitize(indeterminate[0].text)}`,
    });
  }
  return findings;
}

module.exports = {
  ANSWER_HEADER,
  ANSWER_MARKER,
  EVIDENCE_MAX,
  PUNT_PATTERNS,
  RATIFY_HEADER,
  RATIFY_MARKER,
  classifyCell,
  classifyTable,
  inspectPacketWrite,
  normalizeCell,
  parseTables,
  splitRow,
  stripFencedBlocks,
};
