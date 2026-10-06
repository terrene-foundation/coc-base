/*
 * Shared markdown-fence tracking — a fenced code block is illustration, not
 * structure.
 *
 * THE DEFECT CLASS THIS CLOSES (loom, 2026-09-06 — sweep finding C4)
 * ────────────────────────────────────────────────────────────────
 * `check-clause-coverage.mjs::deriveClauses` shipped with no fence guard: a
 * `## …` line inside a rule's OWN fenced DO/DO-NOT example was read as a real
 * heading and closed the `## MUST Rules` region, silently under-counting four
 * rules (fixed loom commit cdbffb94). The SAME shape recurred independently as
 * `audit-fixture-prose-count-coupling`, which read `grep` COMMANDS inside a
 * ```bash fence as prose claims.
 *
 * Three sibling checkers were AUDITED against the same class and two were
 * CONFIRMED by a two-pole positive control (pattern inside a fence vs outside
 * one) before this module existed:
 *
 *   - validate-extraction-history.mjs :: hasRule10Anchor / citesRule ran a
 *     flat substring search over a journal entry's WHOLE body, so an
 *     illustrative quoted "Rule-10 disposition: ..." sentence inside a
 *     ```text fence was indistinguishable from a real disposition assertion.
 *   - validate-proximity-band.mjs :: scanProposalDiffForBaselineAdditions
 *     flagged every ADDED line under `.claude/rules/*.md` containing
 *     MUST/MUST NOT/BLOCKED with no fence awareness, so a brand-new
 *     DO/DO-NOT *example* line (this repo's own rule-authoring convention)
 *     reads as a new load-bearing obligation.
 *   - check-baseline-delta.mjs :: its RULE-file byte-delta measurement
 *     already routes through the emitter's OWN `abridgeV6` pipeline (not a
 *     duplicated parser, so REFUTED for that path) — but its OWN
 *     `parseExceptions` helper (scanning commit bodies / journal-diff
 *     additions / PR body for a `Rule-10-exception:` declaration) had the
 *     identical un-guarded substring shape: a fenced WORKED EXAMPLE of a
 *     valid exception declaration reads as a real one, which is the more
 *     dangerous direction (a false CLEARANCE, not a false alarm).
 *
 * Four independent re-implementations of "is this line inside a fence"
 * guarantees drift exactly the way `security.md` § Credential Decode Helpers
 * names for the encode/decode pair: one drifts, the others don't, and the gap
 * is invisible until a probe author reads the source instead of trusting it.
 * This module is the ONE implementation; every caller composes it.
 *
 * A "fence" here is a CommonMark fenced-code-block delimiter: three-or-more
 * backticks or tildes, optionally indented up to 3 spaces. Matched on OPEN
 * only (this repo's corpus never mixes fence characters or lengths within one
 * block), which is exactly what the confirmed-buggy `check-clause-coverage.mjs`
 * original used — this module does not change that matching behavior, only
 * centralizes it.
 */

const FENCE_RE = /^\s{0,3}(?:`{3,}|~{3,})/;

/** True if `line` is a fence delimiter (opening OR closing). */
export function isFenceDelimiterLine(line) {
  return FENCE_RE.test(line);
}

/**
 * Given the FULL text of a document, return a Set of 1-based line numbers
 * that fall INSIDE a fenced block — the delimiter lines themselves are
 * included too (neither a delimiter nor its interior is real prose/structure
 * for any of this module's callers).
 */
export function fencedLineNumbers(text) {
  const fenced = new Set();
  let inFence = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      fenced.add(i + 1);
      inFence = !inFence;
      continue;
    }
    if (inFence) fenced.add(i + 1);
  }
  return fenced;
}

/**
 * Iterate the NON-FENCED lines of `text` only, calling `fn(line, lineNumber)`
 * for each — lineNumber is 1-based and preserves the ORIGINAL document's
 * numbering (fenced lines are skipped, not renumbered). This is the exact
 * primitive `check-clause-coverage.mjs::deriveClauses` needed and, before
 * loom commit cdbffb94, did not have.
 */
export function forEachNonFencedLine(text, fn) {
  let inFence = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    fn(line, i + 1);
  }
}

/**
 * Strip ALL fenced-block content from `text` (delimiters included), returning
 * a string of the SAME LINE COUNT with fenced lines blanked. Any downstream
 * line-number-preserving regex/substring scan (a journal anchor search, an
 * exception-token search) then sees only non-fenced prose, while every OTHER
 * line's number is unchanged — so a caller that reports "matched at line N"
 * keeps reporting the real line N.
 */
export function stripFencedContent(text) {
  const fenced = fencedLineNumbers(text);
  return text
    .split("\n")
    .map((line, i) => (fenced.has(i + 1) ? "" : line))
    .join("\n");
}
