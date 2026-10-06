#!/usr/bin/env node
/**
 * bare-line-citation.js — the pure predicate behind `symbol-anchored-citations.md` MUST-1/MUST-2.
 *
 * WHAT IT DECIDES, stated so nobody reads it wider than it is: in a DURABLE PLANNING ARTIFACT
 * (the rule's own `paths:` globs — specs, plans, analyses, briefs, todos, journal), does a code
 * citation of the shape `<path>.<ext>:<NNN>` (optionally `-<MMM>`) appear with NO grep-stable
 * anchor in its adjacency window? That is the dead-pointer shape MUST-1 blocks.
 *
 * WHY THIS IS `advisory` AND CAN NEVER BE `block`. The LOCATION of a citation is a
 * parsed-document fact, but the VERDICT — "is there a grep-stable anchor near it?" — is decided
 * by a lexical read of the surrounding prose. `hook-output-discipline.md` MUST-2 reserves `block`
 * for a structural signal a surface rewrite cannot evade, and this one is evadable by rewording.
 * The rule's own Wiring field says the same thing in advance ("`advisory` at the hook layer
 * (lexical bare-line-citation detection cannot carry `block`)"), so the cap is the rule's, not a
 * local timidity. Gate-review remains the judging layer; this predicate is the cheap first pass.
 *
 * THE TWO ADJACENCY WINDOWS ARE NOT THE SAME, and the difference is load-bearing. The rule's
 * Detection field mandates: same SENTENCE for a bare `:<NNN>`, widened to the same PARAGRAPH for a
 * `:<NNN>-<MMM>` range — so that a legitimate `zero-tolerance.md` Rule 3e claim-bounding range,
 * which pairs its named contract in the same paragraph rather than the same sentence, is NOT
 * over-flagged. A single window for both poles would either miss the bare-line case or red every
 * Rule 3e citation in the corpus; the asymmetry IS the no-false-positive property.
 *
 * FAILS OPEN / SILENT ON EVERY UNKNOWN per `cc-artifacts.md` Rule 7: unreadable text, a path
 * outside the rule's globs, a citation inside a fenced code block (that is code or terminal
 * output, not a navigation pointer), a URL authority that merely LOOKS like `host:port`.
 *
 * Origin: `symbol-anchored-citations.md` § Origin (2026-06-30, co-owner-directed, journal/0375).
 * Landed 2026-09-13 as the GRADUATION of `phase2-deferrals.json` key
 * `symbol-anchored-citations.md#detect-bare-line-citation`.
 */

"use strict";

const RULE_ID = "symbol-anchored-citations/MUST-1";
const SEVERITY = "advisory";

/**
 * The rule's own `paths:` frontmatter, transcribed ONCE here and nowhere else in this module.
 * Deliberately NOT a hand-restated superset: each entry is the glob as the rule declares it,
 * translated to the narrowest regex that means the same thing.
 */
const DURABLE_ARTIFACT_PATTERNS = [
  /(^|\/)specs\//,
  /(^|\/)02-plans\//,
  /(^|\/)01-analysis\//,
  /(^|\/)briefs\//,
  /(^|\/)todos\//,
  /(^|\/)journal\//,
];

/** Only text surfaces carry citations a reader NAVIGATES by. */
const TEXT_EXT = /\.(md|markdown|txt|mdx|rst)$/i;

function isDurablePlanningArtifact(relPath) {
  if (!relPath || typeof relPath !== "string") return false;
  const p = relPath.replace(/\\/g, "/");
  if (!TEXT_EXT.test(p)) return false;
  return DURABLE_ARTIFACT_PATTERNS.some((re) => re.test(p));
}

/**
 * `<path>.<ext>:<NNN>` or `<path>.<ext>:<NNN>-<MMM>`.
 *
 * The extension is REQUIRED: it is what separates a code citation from a clock time (`12:30`), a
 * ratio, or a list label. Without it this matcher fires on ordinary prose and discriminates
 * nothing — the non-discriminating instrument `instrument-discipline.md` MUST-1 blocks as
 * evidence.
 */
const CITATION_RE =
  /((?:[A-Za-z0-9_@.~-]+\/)*[A-Za-z0-9_.~-]+\.[A-Za-z][A-Za-z0-9]{0,7}):(\d{1,6})(?:-(\d{1,6}))?(?![\w.-])/g;

/** Length-preserving blank, so every index computed on a masked copy is valid on the original. */
function blank(len) {
  return " ".repeat(len);
}

/**
 * Blank out fenced code blocks, length-preservingly.
 *
 * A citation inside a fence is a command, a diff, or captured output — not the navigation pointer
 * this rule governs. Left live, the rule's OWN `# DO NOT` fences would flag every artifact that
 * quotes them, which is the self-firing shape that makes a detector unusable.
 */
function maskFences(text) {
  const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*$/gm;
  const marks = [];
  let m;
  while ((m = fence.exec(text)) !== null) marks.push(m);

  const ranges = [];
  let open = null;
  for (const mark of marks) {
    if (open === null) open = mark;
    else {
      // Blank everything from the opening fence line through the closing fence line.
      ranges.push([open.index, mark.index + mark[0].length]);
      open = null;
    }
  }
  // An UNCLOSED final fence swallows the rest of the file — the same reading a markdown renderer
  // takes, and the conservative one: better to go silent than to flag prose that is really code.
  if (open !== null) ranges.push([open.index, text.length]);

  return maskSpans(text, ranges);
}

/** Is this citation actually the authority half of a URL (`host.com:8080`)? */
function isUrlAuthority(text, index) {
  return text.slice(Math.max(0, index - 3), index).includes("//");
}

/**
 * The SENTENCE containing `index`, computed on a copy whose citations are blanked so that the `.`
 * inside `foo.mjs` is never read as a full stop. Newline-doubles also terminate a sentence.
 */
function sentenceAround(text, index, citationSpans) {
  const masked = maskSpans(text, citationSpans);
  let start = 0;
  const boundary = /[.!?](?=[\s)\]]|$)|\n\s*\n/g;
  let m;
  while ((m = boundary.exec(masked)) !== null) {
    const end = m.index + m[0].length;
    if (end > index) break;
    start = end;
  }
  boundary.lastIndex = index;
  let end = text.length;
  while ((m = boundary.exec(masked)) !== null) {
    end = m.index + m[0].length;
    break;
  }
  return text.slice(start, end);
}

/** The PARAGRAPH containing `index` — blank-line delimited, the markdown unit. */
function paragraphAround(text, index) {
  let start = text.lastIndexOf("\n\n", index);
  start = start === -1 ? 0 : start + 2;
  let end = text.indexOf("\n\n", index);
  if (end === -1) end = text.length;
  return text.slice(start, end);
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

/** A backticked span's inner text, everywhere in `window`. */
function backtickedTokens(window) {
  const out = [];
  const re = /`([^`\n]{1,200})`/g;
  let m;
  while ((m = re.exec(window)) !== null) out.push(m[1].trim());
  return out;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{1,}\*?$/;
const CALL_FORM = /[A-Za-z_$][A-Za-z0-9_$]*\s*\(\s*\)/;
const NAMED_CONTRACT = /\b(Rule|MUST|MUST NOT|Step|Gate|Phase)\s*-?\s*\d/;
const HAS_SECTION_MARK = /§/;

/**
 * Does `window` carry a grep-stable anchor — something a reader can `grep` for when the line has
 * drifted? This is the recovery test MUST-2 states: the symbol is the contract, the line is the
 * convenience.
 */
function hasGrepStableAnchor(window, citedPath) {
  if (HAS_SECTION_MARK.test(window)) return true;
  if (CALL_FORM.test(window)) return true;
  if (NAMED_CONTRACT.test(window)) return true;
  const basename = String(citedPath).split("/").pop();
  for (const tok of backtickedTokens(window)) {
    if (tok === citedPath || tok === basename) continue;
    // Another citation is not an anchor — it is a second dead pointer.
    if (/\.[A-Za-z][A-Za-z0-9]{0,7}:\d/.test(tok)) continue;
    if (tok.includes("::")) return true;
    if (IDENT.test(tok)) return true;
  }
  return false;
}

/**
 * THE PREDICATE. Returns one finding per un-anchored citation, in document order.
 *
 * Each finding NAMES the failure identity — the citation token, the window class that was
 * searched, and the clause — because `instrument-bipolarity.md` MUST-2 requires a red pole that
 * says WHAT failed, not merely THAT something did.
 */
function findBareLineCitations(text) {
  if (!text || typeof text !== "string") return [];
  const masked = maskFences(text);

  const spans = [];
  const raw = [];
  CITATION_RE.lastIndex = 0;
  let m;
  while ((m = CITATION_RE.exec(masked)) !== null) {
    if (isUrlAuthority(masked, m.index)) continue;
    spans.push([m.index, m.index + m[0].length]);
    raw.push({ token: m[0], path: m[1], isRange: Boolean(m[3]), index: m.index });
  }
  if (raw.length === 0) return [];

  const findings = [];
  for (const c of raw) {
    const window = c.isRange
      ? paragraphAround(masked, c.index)
      : sentenceAround(masked, c.index, spans);
    if (hasGrepStableAnchor(window, c.path)) continue;
    findings.push({
      rule_id: RULE_ID,
      severity: SEVERITY,
      clause: c.isRange ? "MUST-2" : "MUST-1",
      citation: c.token,
      window: c.isRange ? "paragraph" : "sentence",
      evidence:
        `bare line citation \`${c.token}\` has no grep-stable anchor ` +
        `(no symbol, \`§\`, or named contract) in its ${c.isRange ? "paragraph" : "sentence"}`,
    });
  }
  return findings;
}

/** Render findings for the advisory surface — bounded, and every line names its own citation. */
function renderFindings(findings, surface) {
  const lines = [
    `⚠ symbol-anchored-citations MUST-1 — ${findings.length} bare line citation(s) in ${surface}.`,
    "",
    ...findings.slice(0, 12).map((f) => `- [${f.severity}] ${f.rule_id} (${f.clause}): ${f.evidence}`),
  ];
  if (findings.length > 12) lines.push(`- … and ${findings.length - 12} more`);
  lines.push("");
  lines.push(
    "Re-anchor each on a grep-stable token — the function / class / `const` name, or a `§section` " +
      "heading — and keep the line only as a paired, disposable hint. A bare line is invalidated " +
      "by the next edit above it, most often by this session's own.",
  );
  return lines.join("\n");
}

module.exports = {
  RULE_ID,
  SEVERITY,
  DURABLE_ARTIFACT_PATTERNS,
  isDurablePlanningArtifact,
  findBareLineCitations,
  hasGrepStableAnchor,
  maskFences,
  renderFindings,
};
