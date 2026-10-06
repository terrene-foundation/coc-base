/**
 * non-assertive-spans.js — the ONE lineage for "text that is MENTIONED rather
 * than ASSERTED", shared by every prose detector that reads an agent's own reply.
 *
 * WHY THIS FILE EXISTS. Two Stop-event guards needed the same withdrawal
 * predicate and only one had it. `delegation-permission.js` stripped fenced code,
 * blockquotes, INLINE CODE and quoted spans; `handoff-surface.js` stripped only
 * fenced code and blockquotes — so a compliance report that quoted the rule it
 * complies with, using backticks, was flagged by the very detector describing it.
 * That case is the one `handoff-surface.js`'s own header says it closes, so the
 * stated intent was half-implemented rather than merely narrow.
 *
 * The fix is extraction, NOT a second copy. A withdrawal predicate duplicated
 * across two detectors drifts: the moment one learns a new mention form the other
 * silently keeps flagging it, and the divergence is invisible because both look
 * correct in isolation. This is `security.md` § Enforcement-Surface Parity applied
 * to a text predicate — ONE shared function, never two lineages.
 *
 * SPAN BOUNDS ARE DELIBERATE, and are the reason these are not naive regexes. An
 * UNTERMINATED backtick or quote must not swallow the rest of the message: that
 * would turn one stray `"` into a blanket suppressor, silencing every real finding
 * after it. So each character class EXCLUDES newlines and each span is length-
 * capped. Failing to match is the safe direction — an unstripped span can only
 * produce a false POSITIVE, which a reader can see and refute, whereas an
 * over-greedy strip produces silence, which nobody can see.
 *
 * Each removed span becomes a single space so sentence boundaries on either side
 * survive; callers that split into sentences or adjacency windows depend on that.
 */

"use strict";

/**
 * Remove INLINE mention spans: inline code, and straight or curly double-quoted
 * spans. Line-structure preserving — every pattern here excludes newlines, so a
 * caller that has already segmented by line can apply this to the joined result
 * without losing its line count.
 */
function stripInlineMentionSpans(text) {
  if (typeof text !== "string") return "";
  let t = text;
  t = t.replace(/`[^`\n]{0,400}`/g, " "); // inline code
  t = t.replace(/"[^"\n]{0,400}"/g, " "); // straight double-quoted spans
  t = t.replace(/“[^”\n]{0,400}”/g, " "); // curly double-quoted spans
  return t;
}

/**
 * Remove every mention span: fenced blocks first (they may themselves contain
 * quotes and backticks), then blockquote lines, then the inline spans above.
 * Order matters and is not incidental — stripping inline spans first would leave
 * a fence's interior backticks unbalanced.
 */
function stripNonAssertiveSpans(text) {
  if (typeof text !== "string") return "";
  let t = text;
  t = t.replace(/```[\s\S]*?```/g, " "); // fenced code
  t = t.replace(/^[ \t]*>.*$/gm, " "); // blockquote lines
  return stripInlineMentionSpans(t);
}

module.exports = { stripInlineMentionSpans, stripNonAssertiveSpans };
