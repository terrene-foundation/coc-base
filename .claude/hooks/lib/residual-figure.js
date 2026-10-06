/**
 * residual-figure.js — the PURE PREDICATES behind `burn-down-reporting.md`'s
 * Phase-2 detector: does a CLOSE-OUT REPORT that prints PROGRESS COUNTS also
 * print the RESIDUAL — what remains open?
 *
 * The rule's own definitions are harvested, never re-invented. MUST-1 fixes the
 * three quantities ("CLEARED — issues closed, PRs merged, branches landed, items
 * closed, **with counts**" / "REMAINS — the FULL residual surface" / "DELTA");
 * MUST-3 fixes the SURFACE ("the agent's session-close / wave-close REPORT to the
 * human"). This module implements the ADJACENCY between the first and second on
 * that surface — the one half of the rule the deferral row called mechanical.
 *
 * --- THE SCOPE GATE IS THE HARD HALF, AND IT IS BOUNDED CONJUNCTIVELY ---------
 * "Is this a close-out report at all?" is where a careless detector fires on
 * every message. A finding requires ALL THREE of:
 *
 *   (A) a CLOSE-OUT CUE   — a phrase from the closed set below, naming a session
 *                           close, a wave close, a wrap-up, a final/summary
 *                           report, or a burn-down. Absent ⇒ silent, whatever
 *                           counts the message carries. This is the gate: an
 *                           ordinary progress message ("merged 3 PRs, moving on")
 *                           is NOT a close-out report and is not this rule's
 *                           subject.
 *   (B) a PROGRESS COUNT  — a digit + a countable unit near a CLEARING verb, in
 *                           either order, within one clause. A bounded partitive
 *                           or adjective may sit between the digit and the unit
 *                           ("cleared 12 of the open items"), which is ordinary
 *                           English and was a silent miss while the two had to be
 *                           adjacent. This is MUST-1's CLEARED quantity.
 *   (C) NO RESIDUAL       — no figure naming what remains.
 *
 * WHAT WITHDRAWS A MATCH. (A) and (B) are read on PROSE ONLY. Four things are
 * stripped first, on ONE principle — the agent is naming an artefact, not making
 * a claim: fenced code blocks, block-quoted lines, INLINE code spans, and bare
 * PATH/FILENAME tokens. The last two were added after `burndown-build.mjs` was
 * read as a burn-down CUE, so an ordinary "I edited <file> and fixed 3 rows"
 * reported a missing residual on a message that was not a close-out at all.
 *
 * (C) IS READ ON A NARROWER SURFACE THAN (A) AND (B), AND THE SPLIT IS THE POINT.
 * The two UNAMBIGUOUS shapes — an arrow delta and an explicit zero — are read on
 * the FULL text, fences and quotes INCLUDED, which is the fail-open direction: a
 * residual printed inside a fenced table still silences the detector, because the
 * reader DID get the number. The KEYWORD-PROXIMITY shape is read ONLY from clauses
 * that make no CLEARING claim, because its keywords ("open", "left", "still",
 * "pending") occur in CLEARED prose as freely as in residual prose.
 *
 * AN EXPLICIT ZERO IS A RESIDUAL FIGURE. "0 remaining", "nothing outstanding",
 * "none left" all satisfy (C). Treating an honest zero as an ABSENT residual is
 * the single easiest way to get this predicate wrong: it would fire hardest on
 * exactly the session that finished its queue, which is the report most likely
 * to be correct.
 *
 * --- THE SILENCE IS WEAKER EVIDENCE THAN THE FIRING -------------------------
 * State this before citing a clean run (`instrument-discipline.md` MUST-3(a)):
 *
 *   - A residual named in an EARLIER message of the same turn is INVISIBLE here.
 *     Only the final assistant reply is read, so an agent that reported the
 *     residual and then closed with a summary reads as a violation — which is why
 *     the finding is advisory and the agent is asked to state, not to fix.
 *     Symmetrically, a residual named only earlier and genuinely missing from the
 *     close-out is a TRUE finding; the predicate cannot tell these apart.
 *   - The close-out CUE set is lexical and closed. A close-out report phrased with
 *     none of its phrases is silently out of scope. That silence is the absence of
 *     an instrument, NOT evidence the report carried a residual.
 *   - The residual predicate is BROAD, and "broad is always the safe side" was
 *     WRONG and is the defect this module shipped with. A (C) broad enough to
 *     match "cleared 12 of the open items" silenced the detector on the CANONICAL
 *     violation — a close-out reporting cleared counts and no residual — because
 *     the word "open" described what was CLEARED. Breadth is quieter only when it
 *     reads residual prose; over CLEARED prose it is a false NEGATIVE, so (C) is
 *     now scoped to clauses that make no clearing claim.
 *   - A close-out phrased with none of the (A) cues is still out of scope, and a
 *     CUE TOKEN appearing inside an artefact name is deliberately NOT a cue.
 *     "burn-down" alone no longer cues; it must carry a report noun
 *     ("burn-down report"/"summary"/"table"/…).
 *   - Nothing here checks MUST-2 (was the figure MEASURED) or MUST-1's DELTA. A
 *     silent run says only "a residual-shaped figure was present", never "the
 *     burn-down is sound".
 *
 * --- PURITY ------------------------------------------------------------------
 * No filesystem, no subprocess, no environment, no network. Text in, findings
 * out, so the fixtures drive the real predicates rather than a re-implementation.
 * All I/O lives in `../residual-figure-guard.js`.
 *
 * Origin: graduated from
 * `phase2-deferrals.json::deferrals["burn-down-reporting.md#residual-figure-advisory"]`
 * 2026-09-13, whose registered graduation condition was "the close-out
 * residual-figure advisory ships with its fixtures".
 */

"use strict";

/** Bound every evidence string so a long reply cannot flood the response. */
const EVIDENCE_MAX = 180;

/** The finding this module can produce. One identity, one severity. */
const RULE_ID = "burn-down-reporting/close-out-without-residual";

/**
 * (A) CLOSE-OUT CUES — the scope gate. A CLOSED set, and small on purpose: every
 * phrase added here widens the population the detector speaks to, and a detector
 * that greets every message is one the operator learns to ignore.
 */
const CLOSE_OUT_CUE =
  /\b(?:close[- ]?out|closing out|session close|closing the session|session summary|session report|end of (?:the )?session|wrap(?:ping)?[- ]?up|wave close|closing the wave|wave summary|end of (?:the )?wave|wave \d+\s*(?:\/|of)\s*\d+|final (?:report|summary|tally)|sprint close|sweep (?:complete|completed|close|summary|report)|closing the sweep|burn[- ]?down\s+(?:report|summary|table|status|tally|figures?|numbers?))\b/i;

/** Verbs by which MUST-1's CLEARED axis is reported. */
const CLEARED_VERB =
  "merged|landed|closed|shipped|resolved|cleared|completed|delivered|fixed|graduated|converged";

/** Countable units a close-out report clears. */
const UNIT =
  "PRs?|pull requests?|issues?|branches?|commits?|items?|lanes?|todos?|tasks?|shards?|waves?|deferrals?|rows?|files?|tests?|suites?|findings?|detectors?|fixtures?|rules?";

/**
 * (B) PROGRESS COUNT — digit + unit adjacent to a clearing verb, either order,
 * bounded to one clause (no sentence or line boundary crossed) so "merged." at
 * the end of one paragraph cannot pair with "3 issues" at the start of the next.
 */
const COUNT_GAP = "(?:(?:of|out of)\\s+(?:the\\s+)?)?(?:[A-Za-z][\\w-]*\\s+){0,2}";
const COUNT_THEN_VERB = new RegExp(
  `\\b\\d+\\s+${COUNT_GAP}(?:${UNIT})\\b[^.\\n;]{0,48}?\\b(?:${CLEARED_VERB})\\b`,
  "i",
);
const VERB_THEN_COUNT = new RegExp(
  `\\b(?:${CLEARED_VERB})\\b[^.\\n;]{0,48}?\\b\\d+\\s+${COUNT_GAP}(?:${UNIT})\\b`,
  "i",
);

/**
 * (C) RESIDUAL — three independent shapes, any one of which satisfies the clause.
 *
 *   1. an ARROW DELTA (`63 → 49`, `63 -> 49`): the right-hand number IS the
 *      residual, which is MUST-1's own canonical form.
 *   2. a residual KEYWORD within 40 characters of a digit, in either direction,
 *      READ ONLY FROM CLAUSES CARRYING NO CLEARING VERB — this catches prose
 *      ("14 issues remaining") and MUST-1's table row (`| open issues | 63 | 49 |`)
 *      alike, while declining to read "closed 9 issues that were open" as a
 *      residual figure.
 *   3. an EXPLICIT ZERO with no digit at all ("nothing outstanding"). An honest
 *      zero IS a residual figure.
 */
const ARROW_DELTA = /\d+\s*(?:→|->|=>|—>)\s*\d+/;

const RESIDUAL_KEY =
  "remain(?:s|ing|der)?|outstanding|residual|unresolved|open|left|pending|in flight|in-flight|to go|still|backlog|deferred|not yet|untouched|carried over";

/**
 * A residual figure is a quantity of what is NOT done, so it cannot be read out
 * of a clause that reports CLEARING. Clauses are cut on sentence punctuation AND
 * on coordinators, so "I merged 14 PRs and 21 issues remain open" keeps its two
 * halves apart: the first is CLEARED prose and is discarded, the second is the
 * residual and is read.
 */
const CLAUSE_SPLIT = /[.;:!?\n]+|,|\b(?:and|but|while|whilst|though|although|however|plus|with)\b/i;
const CLEARED_VERB_RE = new RegExp(`\\b(?:${CLEARED_VERB})\\b`, "i");

/** Clauses that make no clearing claim — the only ones a residual may be read from. */
function residualBearingClauses(text) {
  return String(text)
    .split(CLAUSE_SPLIT)
    .filter((c) => typeof c === "string" && c.trim() && !CLEARED_VERB_RE.test(c));
}

const DIGIT_THEN_KEY = new RegExp(`\\d[^.\\n]{0,40}?\\b(?:${RESIDUAL_KEY})\\b`, "i");
const KEY_THEN_DIGIT = new RegExp(`\\b(?:${RESIDUAL_KEY})\\b[^.\\n]{0,40}?\\d`, "i");

const EXPLICIT_ZERO =
  /\b(?:nothing|none|no)\s+(?:\w+\s+){0,2}(?:outstanding|remaining|remains|left|open|pending|unresolved|in flight|in-flight)\b|\bzero\s+(?:\w+\s+){0,2}(?:outstanding|remaining|open|left|pending)\b|\bqueue is (?:empty|clear)\b|\bnothing (?:is )?(?:left|outstanding|remaining)\b/i;

function sanitize(s) {
  if (typeof s !== "string") return "";
  const flat = s
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > EVIDENCE_MAX ? flat.slice(0, EVIDENCE_MAX) + "..." : flat;
}

/**
 * Strip fenced code blocks and block-quoted lines, leaving the agent's own prose.
 *
 * Fences are matched on an OPENING marker (``` or ~~~) at the head of a line and
 * closed by the next such marker; an UNCLOSED fence swallows the remainder of the
 * message, which is the fail-open reading — an unterminated fence means we cannot
 * tell prose from data, so we decline to read what follows as a claim.
 */
const INLINE_CODE = /`[^`\n]*`/g;
const PATHISH =
  /\S*\/[\w.\-/]+|\b[\w-]+(?:\.[\w-]+)*\.(?:mjs|cjs|js|jsx|ts|tsx|json|jsonl|md|ya?ml|toml|py|rs|rb|sh|txt|lock)\b/g;

function stripNonProse(text) {
  if (typeof text !== "string") return "";
  const out = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s{0,3}>/.test(line)) continue; // block quote — someone else's text
    out.push(line);
  }
  // An INLINE code span and a bare PATH/FILENAME token are data on the same
  // ground a fence is: the agent is naming an artefact, not making a claim. They
  // are masked rather than deleted so no two words are joined across the gap.
  return out.join("\n").replace(INLINE_CODE, " ").replace(PATHISH, " ");
}

/** (A). Returns the matched cue, or null. */
function findCloseOutCue(prose) {
  if (typeof prose !== "string" || !prose.trim()) return null;
  const m = CLOSE_OUT_CUE.exec(prose);
  return m ? m[0] : null;
}

/** (B). Returns the matched count phrase, or null. */
function findProgressCount(prose) {
  if (typeof prose !== "string" || !prose.trim()) return null;
  const m = COUNT_THEN_VERB.exec(prose) || VERB_THEN_COUNT.exec(prose);
  return m ? m[0] : null;
}

/** (C). Returns the matched residual phrase, or null. Read on the FULL text. */
function findResidualFigure(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  // ARROW_DELTA and EXPLICIT_ZERO are unambiguous ON THEIR OWN — the arrow IS
  // MUST-1's canonical delta form and "nothing outstanding" states a residual
  // outright — so both read the WHOLE text, clearing verbs and all.
  const whole = ARROW_DELTA.exec(text) || EXPLICIT_ZERO.exec(text);
  if (whole) return whole[0];
  // The keyword-proximity shapes are the ambiguous ones: "open", "left", "still"
  // and "pending" all occur in CLEARED prose ("closed 9 issues that were open").
  // Read them ONLY from clauses that make no clearing claim.
  for (const clause of residualBearingClauses(text)) {
    const m = DIGIT_THEN_KEY.exec(clause) || KEY_THEN_DIGIT.exec(clause);
    if (m) return m[0];
  }
  return null;
}

/**
 * The verdict. PURE — the caller supplies the reply text.
 *
 * FAILS OPEN on every unknown (`cc-artifacts.md` Rule 7): a non-string, an empty
 * or whitespace-only reply, and any thrown match all return NO findings.
 *
 * @param {{text: string}} ctx
 * @returns {Array<{rule_id: string, severity: string, evidence: string}>}
 */
function inspectCloseOutReport(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const text = typeof c.text === "string" ? c.text : "";
  if (!text.trim()) return [];

  let prose;
  try {
    prose = stripNonProse(text);
  } catch {
    return []; // cannot separate prose from data ⇒ UNKNOWN ⇒ fail open
  }

  let cue, count, residual;
  try {
    cue = findCloseOutCue(prose);
    if (!cue) return []; // not a close-out report ⇒ out of scope entirely
    count = findProgressCount(prose);
    if (!count) return []; // no CLEARED quantity ⇒ nothing to be adjacent to
    residual = findResidualFigure(text);
  } catch {
    return [];
  }
  if (residual) return []; // MUST-1's REMAINS quantity is present

  return [
    {
      rule_id: RULE_ID,
      severity: "advisory",
      evidence:
        `This reply reads as a close-out report ("${sanitize(cue)}") and prints a ` +
        `cleared count ("${sanitize(count)}"), but no figure in it names what REMAINS. ` +
        `burn-down-reporting.md MUST-1: a close reports CLEARED, REMAINS and DELTA — ` +
        `"reporting CLEARED without REMAINS ... is BLOCKED".`,
    },
  ];
}

module.exports = {
  RULE_ID,
  EVIDENCE_MAX,
  stripNonProse,
  findCloseOutCue,
  findProgressCount,
  findResidualFigure,
  inspectCloseOutReport,
};
