#!/usr/bin/env node
/**
 * bug-signal-defer.js — the pure predicate behind `product-completion-first.md` MUST-1/2/3.
 *
 * WHAT IT DECIDES: in a durable artifact that RECORDS dispositions (a workspace note, a sweep
 * report, a todo list, a journal entry, session notes), does a unit that DEFERS a finding also
 * carry a BUG SIGNAL? That conjunction is the relabelling MUST-2 and MUST-3 block — a BUG or
 * INVEST-NOW finding recategorised INCREMENTAL so it can leave the queue.
 *
 * THE VOCABULARY IS THE RULE'S OWN, not a local invention. `product-completion-first.md`'s
 * Detection field enumerates the BUG-definition signal set verbatim — failing test / build error /
 * type error / insecure / lossy / contract break / gate-integrity / self-ref-enforcement defect —
 * and `BUG_SIGNALS` below is that list and nothing more. Widening it here would make the detector
 * assert a category boundary the rule did not draw.
 *
 * WHY THIS IS `advisory` AND CAN NEVER BE `block`. Both halves are lexical reads of prose, so
 * `hook-output-discipline.md` MUST-2 caps it below `block`; the rule's Phase-2 field already said
 * "an advisory detector", so the cap is the rule's. What this predicate emits is a QUESTION for the
 * reviewer — "this defer names a bug signal; is the category right?" — never a verdict.
 *
 * DISCRIMINATION WAS MEASURED BEFORE THIS WAS BUILT, not assumed. Across 1625 durable markdown
 * files on this tree, 2320 units mention defer/incremental at all and the conjunction fires on 5 —
 * 0.2%. The nearest neighbour in this corpus, `deferral-registry-locality.md`, was RETIRED
 * precisely because its matcher fired on every Wiring block and separated nothing; this one was
 * held to that test first, with the rule's own canonical violation as the positive control and its
 * own canonical compliant defer as the negative control. Both behave.
 *
 * FOUR SUPPRESSORS, each justified by a property of the SURFACE rather than fitted to the corpus:
 *   (1) FENCED CODE — a fence is an example, a command, or captured output, never a live
 *       disposition; the rule's own `# DO NOT` fence is the canonical false positive.
 *   (2) TABLE ROWS — a `|`-delimited row is not a sentence. Splitting a table on sentence
 *       boundaries fabricates adjacency between cells the author never wrote next to each other,
 *       which is where 3 of the 5 measured corpus hits came from.
 *   (3) NON-DEFER DISPOSITIONS — a unit that says FIXED / FIX NOW / fixed in-cycle has NOT
 *       deferred anything; the rule's contract is what says so.
 *   (4) QUOTED ANTI-PATTERNS — a unit marked `BLOCKED` is the corpus convention for quoting a
 *       rationalization in order to forbid it. Firing there is the self-firing shape that makes a
 *       detector unusable inside the very corpus that defines it.
 *
 * FAILS OPEN / SILENT ON EVERY UNKNOWN per `cc-artifacts.md` Rule 7.
 *
 * Origin: `product-completion-first.md` § Origin. Landed 2026-09-13 as the GRADUATION of
 * `phase2-deferrals.json` key `product-completion-first.md#bug-signal-defer-detector`.
 */

"use strict";

const RULE_ID = "product-completion-first/MUST-2";
const SEVERITY = "advisory";

/** Surfaces on which a disposition is RECORDED. Deliberately not the rule's `paths:` frontmatter:
 *  those globs say where the RULE loads, this says where a defer is written down. */
const DISPOSITION_SURFACES = [
  /(^|\/)workspaces\//,
  /(^|\/)todos\//,
  /(^|\/)journal\//,
  /(^|\/)\.session-notes/,
  /(^|\/)(SWEEP|REDTEAM|CONVERGENCE)[^/]*\.md$/i,
];
const TEXT_EXT = /\.(md|markdown|txt)$/i;

function isDispositionSurface(relPath) {
  if (!relPath || typeof relPath !== "string") return false;
  const p = relPath.replace(/\\/g, "/");
  if (!TEXT_EXT.test(p)) return false;
  return DISPOSITION_SURFACES.some((re) => re.test(p));
}

/**
 * A DEFER disposition — the verb or the category label, not the mere noun.
 *
 * CASE-INSENSITIVE deliberately. An earlier revision was case-SENSITIVE and went silent on the
 * rule's own canonical violation, "Deferring the failing-test fix as incremental", purely because
 * the sentence started with a capital. That miss was caught by the fixture, not by reading the
 * regex — which is the whole reason the canonical violation is a committed case.
 */
const DEFER_DISPOSITION =
  /\b(defer|defers|deferred|deferring|incremental improvement|deferred-quality)\b/i;

/** The rule's own BUG-definition signal set, verbatim and closed. */
const BUG_SIGNALS = [
  /\bfailing[ -]tests?\b/i,
  /\bbuild[ -]errors?\b/i,
  /\btype[ -]errors?\b/i,
  /\binsecure\b/i,
  /\blossy\b/i,
  /\bcontract[ -]breaks?\b/i,
  /\bgate[ -]integrity\b/i,
  /\bself-ref(?:erential)?[ -]enforcement\b/i,
];

/** (3) + (4): dispositions that are NOT a defer, and quoted anti-patterns. */
const NOT_A_DEFER = /\b(FIX NOW|FIXED|fixed in-cycle|fix-now|fixed now)\b/i;
const QUOTED_ANTIPATTERN = /\bBLOCKED\b/;

function blank(n) {
  return " ".repeat(n);
}

function maskSpans(text, spans) {
  if (!spans.length) return text;
  let out = "";
  let i = 0;
  for (const [s, e] of spans) {
    out += text.slice(i, s) + blank(e - s);
    i = e;
  }
  return out + text.slice(i);
}

/** (1) Blank fenced code blocks, length-preservingly. */
function maskFences(text) {
  const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*$/gm;
  const marks = [];
  let m;
  while ((m = fence.exec(text)) !== null) marks.push(m);
  const ranges = [];
  let open = null;
  for (const k of marks) {
    if (open === null) open = k;
    else {
      ranges.push([open.index, k.index + k[0].length]);
      open = null;
    }
  }
  if (open !== null) ranges.push([open.index, text.length]);
  return maskSpans(text, ranges);
}

/** (2) Blank markdown table rows: a `|`-leading line is a row, not a sentence. */
function maskTableRows(text) {
  const ranges = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (/^[ \t]*\|/.test(line)) ranges.push([offset, offset + line.length]);
    offset += line.length + 1;
  }
  return maskSpans(text, ranges);
}

/**
 * The units of analysis: sentences, with a hard break at a blank line and at every list-item
 * bullet. A bullet starts a new disposition record even without terminal punctuation, which is how
 * these artifacts are actually written.
 */
function units(text) {
  const out = [];
  for (const para of text.split(/\n\s*\n/)) {
    for (const item of para.split(/\n(?=[ \t]*(?:[-*+]|\d+\.)\s)/)) {
      for (const s of item.split(/(?<=[.!?])\s+/)) {
        const t = s.trim();
        if (t) out.push(t);
      }
    }
  }
  return out;
}

function matchedSignal(unit) {
  for (const re of BUG_SIGNALS) {
    const m = unit.match(re);
    if (m) return m[0];
  }
  return null;
}

/**
 * THE PREDICATE. One finding per unit that DEFERS while naming a BUG signal.
 *
 * Each finding NAMES the failure identity — the signal token that fired and the unit it fired in —
 * because `instrument-bipolarity.md` MUST-2 requires a red pole that says WHAT failed.
 */
function findBugSignalDefers(text) {
  if (!text || typeof text !== "string") return [];
  const masked = maskTableRows(maskFences(text));
  const findings = [];
  for (const unit of units(masked)) {
    if (!DEFER_DISPOSITION.test(unit)) continue;
    if (NOT_A_DEFER.test(unit)) continue; // (3)
    if (QUOTED_ANTIPATTERN.test(unit)) continue; // (4)
    const signal = matchedSignal(unit);
    if (!signal) continue;
    findings.push({
      rule_id: RULE_ID,
      severity: SEVERITY,
      signal,
      excerpt: unit.replace(/\s+/g, " ").slice(0, 160),
      evidence:
        `a deferred finding names the BUG signal "${signal}" — under the category table a ` +
        `failing test / build or type error / insecure or lossy shipped path / contract break / ` +
        `gate-integrity defect is a BUG, which is FIX NOW and severity-independent`,
    });
  }
  return findings;
}

function renderFindings(findings, surface) {
  const lines = [
    `⚠ product-completion-first MUST-2 — ${findings.length} deferred finding(s) in ${surface} name a BUG signal.`,
    "",
    ...findings.slice(0, 10).map((f) => `- [${f.severity}] ${f.rule_id}: "${f.signal}" in — ${f.excerpt}`),
  ];
  if (findings.length > 10) lines.push(`- … and ${findings.length - 10} more`);
  lines.push("");
  lines.push(
    "This is a QUESTION, not a verdict: re-check each against the category table. If the finding " +
      "IS a BUG or INVEST-NOW it is fixed in-cycle, severity-independent, and relabelling it " +
      "incremental to defer it is BLOCKED. If it is genuinely INCREMENTAL, the defer still needs " +
      "all four generalized-1b conditions — blocking-safety note, value-anchor, full-fix " +
      "acceptance criteria, revisit trigger.",
  );
  return lines.join("\n");
}

module.exports = {
  RULE_ID,
  SEVERITY,
  BUG_SIGNALS,
  DISPOSITION_SURFACES,
  isDispositionSurface,
  findBugSignalDefers,
  maskFences,
  maskTableRows,
  units,
  renderFindings,
};
