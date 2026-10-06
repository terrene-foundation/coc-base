/**
 * handoff-surface.js — the PURE PREDICATES behind `handoff-completion.md`'s
 * Phase-2 detector: does a HANDOFF CLAIM in the closing chat reply carry, BESIDE
 * IT, the executed-or-pending surface the rule requires — or is it a bare
 * "prepared" that silently moves the completion burden to the human?
 *
 * --- THE TRIGGER PHRASES ARE HARVESTED FROM THE RULE, NOT INVENTED -----------
 * `phase2-deferrals.json` recorded the lexical half as already specified: "The
 * trigger phrases are quoted in the rule itself". They are, and every phrase in
 * `HANDOFF_CLAIM_PATTERNS` below is traceable to a quotation in
 * `.claude/rules/handoff-completion.md`, so the matcher and the obligation cannot
 * drift apart:
 *   - "handoff prepared"  — § MUST-1 DO-NOT fence, § Origin, and the rule's own
 *                           Phase-2 sentence ("an advisory detector for 'handoff
 *                           prepared' / 'mirror tracked in <ref>'").
 *   - "handed off"        — § MUST NOT bullet 1 ("done" / "handed off" /
 *                           "prepared").
 *   - "mirror tracked"    — the Phase-2 sentence's second named phrase.
 *   - "mirror prepared"   — § Origin ("reported the cross-SDK mirror 'handoff
 *                           prepared' without filing any Rust SDK issue").
 *
 * DELIBERATELY NOT MATCHED: the bare tokens "done" and "prepared" standing alone.
 * The rule quotes them, but it quotes them AS PREDICATES OF A DELIVERABLE, and a
 * detector keyed on bare "done" fires on every closing report in the corpus —
 * the check-that-cannot-fail `instrument-discipline.md` MUST-1 exists to block.
 * The narrowing is recorded here rather than left implicit: this instrument is
 * scoped to the handoff/mirror vocabulary, and a "done" claim carrying neither
 * noun is OUTSIDE it.
 *
 * --- THE SURFACE DEFINITION IS THE RULE'S, VERBATIM --------------------------
 * `handoff-completion.md` § Trust Posture Wiring, `**Detection mechanism:**`:
 * a handoff claim must be "backed by an executed action (a filed issue/PR URL, a
 * verified issue number) OR an explicit pending-action surface naming target +
 * action + authorization". Both arms are implemented exactly as written:
 *   EXECUTED  — a full issue/PR URL, or a repo-qualified issue number
 *               (`owner/repo#123`, `rs#1732`, `py #1510` — the forms the rule's
 *               own § Origin uses).
 *   PENDING   — all THREE named elements together: a TARGET (a repo slug), an
 *               ACTION verb (file / open / create / post / send / raise), and an
 *               AUTHORIZATION token (authoriz* / approval / permission /
 *               `/cross-repo-authorize`). Three conjuncts, because the rule names
 *               three; two of them would clear a note that says "needs approval"
 *               and nothing else, which is § MUST-3's exact failure.
 *
 * --- THE WINDOW IS BOUNDED, AND THAT IS THE LOAD-BEARING HALF ---------------
 * The deferral row's own `reason` says what was missing: "what is missing is the
 * adjacency check for an executed-or-pending surface". ADJACENT here means ONE
 * UNIT, and a unit is either a markdown LIST ITEM (its marker line plus its
 * indented continuation lines) or, in ordinary prose, a SINGLE SENTENCE. A
 * whole-reply search would clear any report that mentions a PR URL anywhere —
 * and a closing report almost always does — so the instrument would be incapable
 * of the firing verdict. The bounded window is what makes it discriminate.
 *
 * --- WHAT THIS INSTRUMENT CANNOT SEE ----------------------------------------
 * A surface named in an EARLIER message of the same turn — "filed rs#1732" three
 * tool calls ago, then "the mirror is handed off" in the closing line — is
 * INVISIBLE to a window-bounded check over the final reply. So this detector's
 * FIRING is stronger evidence than its SILENCE, and its silence is not an
 * all-clear (`instrument-discipline.md` MUST-3(a)). It is also blind to whether
 * a cited issue number was actually VERIFIED this session (§ MUST-2's own
 * obligation) — a fabricated `rs#9999` clears the EXECUTED arm here. Both gaps
 * stay with the review layer, which is why the rule keeps `halt-and-report` at
 * gate-review above this hook's `advisory`.
 *
 * --- PURITY -----------------------------------------------------------------
 * NOTHING here touches the filesystem, spawns a process, or reads the
 * environment. Text in, findings out, so the fixtures drive the REAL predicates
 * rather than a re-implementation. All I/O lives in `../handoff-surface-guard.js`.
 *
 * Origin: graduated from
 * `phase2-deferrals.json::deferrals["handoff-completion.md#handoff-without-surface"]`
 * 2026-09-13.
 */

"use strict";

// The SHARED mention-withdrawal predicate. See the note inside
// stripFencesAndQuotes below: this file previously carried only half of it, and
// the half it lacked is the one its own header promises to implement.
const { stripInlineMentionSpans } = require("./non-assertive-spans.js");

/** The finding this module emits. One identity; the rule has one clause here. */
const RULE_ID = "handoff-completion/handoff-without-surface";

/** Capped per `hook-output-discipline.md` MUST-2 — see the guard header. */
const SEVERITY = "advisory";

/** Bound every evidence string so a long reply cannot flood the response. */
const EVIDENCE_MAX = 200;

/**
 * Harvested from the rule text — see the header. Each pattern is case-insensitive
 * and tolerates one or two filler words between the noun and the participle
 * ("the handoff is prepared", "mirror was tracked"), because the rule quotes the
 * CLAIM, not a fixed word order.
 */
const HANDOFF_CLAIM_PATTERNS = [
  /\bhand(?:ed|ing)?\s*-?\s*off\b/i,
  /\bhandoff(?:s)?\b[^.!?\n]{0,40}?\b(?:prepared|ready|complete|completed|done|made)\b/i,
  /\b(?:prepared|ready|complete|completed)\b[^.!?\n]{0,20}?\bhandoff(?:s)?\b/i,
  /\bmirror(?:ed|s)?\b[^.!?\n]{0,40}?\b(?:tracked|prepared|filed|handled|complete|completed|done)\b/i,
  /\b(?:tracked|prepared)\b[^.!?\n]{0,20}?\b(?:in|via|as)\s+(?:the\s+)?mirror\b/i,
];

/** EXECUTED arm — "a filed issue/PR URL, a verified issue number". */
const URL_PATTERN = /https?:\/\/[^\s<>()]*\/(?:issues|pull|pulls|merge_requests|-\/issues)\/\d+/i;
/** `owner/repo#123`, `rs#1732`, `py #1510` — the repo-qualified forms § Origin uses. */
const QUALIFIED_ISSUE_PATTERN = /(?:^|[\s(`[])[A-Za-z][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)?\s?#\d+\b/;

/** PENDING arm — the rule's three named elements. */
const TARGET_PATTERN = /(?:^|[\s(`[/])[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[\s)`\],.;:]|$)/;
const ACTION_PATTERN = /\b(?:file|filed|filing|open|opening|create|creating|post|posting|send|sending|raise|raising|submit|submitting)\b/i;
const AUTHORIZATION_PATTERN = /\b(?:authoriz\w*|authoris\w*|approval|approve\w*|permission|cross-repo-authorize|unauthorized)\b/i;

function sanitize(s) {
  if (typeof s !== "string") return "";
  const flat = s
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > EVIDENCE_MAX ? flat.slice(0, EVIDENCE_MAX) + "..." : flat;
}

/**
 * WITHDRAWAL, applied BEFORE any segmentation: blank out every line inside a
 * fenced code block (``` or ~~~) and every block-quoted line (`>`), preserving
 * the line COUNT so nothing downstream shifts.
 *
 * This is the prose analogue of `violation-patterns.js::stripHeredocBodies` —
 * that helper separates COMMAND from DATA in a shell string, which is the wrong
 * axis here: the subject is a markdown chat reply, where the data regions are
 * fences and quotes. It is deliberately NOT required, because requiring it would
 * be citing an instrument built for a different question
 * (`instrument-discipline.md` MUST-4).
 *
 * The case this closes is concrete and recurring: a compliance report that
 * QUOTES the rule it complies with ("the rule BLOCKS `handoff prepared` with no
 * filed issue") must not be flagged by the very detector it is describing.
 */
function stripFencesAndQuotes(text) {
  if (typeof text !== "string" || !text) return "";
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const openClose = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      // Inside a fence: the closing marker line is itself data.
      out.push("");
      if (openClose && openClose[1][0] === fence[0] && openClose[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (openClose) {
      fence = openClose[1];
      out.push("");
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      out.push(""); // block quote — quoted material, not this session's claim
      continue;
    }
    out.push(line);
  }
  // INLINE spans, stripped through the SHARED predicate (`./non-assertive-spans.js`)
  // rather than a second copy. Until 2026-09-13 this function stopped at the line
  // loop above, so inline code and quoted spans SURVIVED — and the concrete case
  // this header claims to close ("the rule BLOCKS `handoff prepared` with no filed
  // issue") was flagged by the very detector describing it. The stated intent was
  // half-implemented, not merely narrow. The sibling Stop guard already had the
  // missing half; extracting it keeps ONE lineage, because two copies of a
  // withdrawal predicate drift the moment one learns a new mention form.
  //
  // Applied AFTER the loop, and that order is load-bearing: every pattern in the
  // shared inline strip excludes newlines, so applying it to the joined result
  // preserves the line count the adjacency-window splitter below depends on.
  // Fences are already blanked by the loop, so no unbalanced backticks remain.
  return stripInlineMentionSpans(out.join("\n"));
}

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^\s{0,3}#{1,6}\s/;

/**
 * Split a reply into ADJACENCY WINDOWS. One window is either a markdown LIST
 * ITEM (marker line plus its continuation lines) or a SINGLE SENTENCE of
 * ordinary prose. A heading ends the preceding paragraph and is itself a window.
 *
 * Sentence splitting is on terminal punctuation FOLLOWED BY whitespace, which
 * leaves URLs and `v1.2.3`-style tokens intact — they carry no space after the
 * dot. A soft-wrapped paragraph is joined before splitting, so a claim and its
 * surface separated only by a line wrap are still ONE window; a claim and a
 * surface in different SENTENCES are not, which is the whole point.
 */
function segmentWindows(text) {
  const lines = stripFencesAndQuotes(text).split("\n");
  const windows = [];
  let para = [];

  const flushPara = () => {
    if (para.length === 0) return;
    const joined = para.join(" ").replace(/\s+/g, " ").trim();
    para = [];
    if (!joined) return;
    for (const s of joined.split(/(?<=[.!?])\s+/)) {
      const t = s.trim();
      if (t) windows.push(t);
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      flushPara();
      i += 1;
      continue;
    }
    if (HEADING.test(line)) {
      flushPara();
      windows.push(line.trim());
      i += 1;
      continue;
    }
    if (LIST_MARKER.test(line)) {
      flushPara();
      const item = [line.trim()];
      i += 1;
      // Continuation: non-blank, not a new marker, not a heading.
      while (i < lines.length) {
        const nxt = lines[i];
        if (!nxt.trim() || LIST_MARKER.test(nxt) || HEADING.test(nxt)) break;
        item.push(nxt.trim());
        i += 1;
      }
      const joined = item.join(" ").replace(/\s+/g, " ").trim();
      if (joined) windows.push(joined);
      continue;
    }
    para.push(line.trim());
    i += 1;
  }
  flushPara();
  return windows;
}

/** True when the window carries an EXECUTED action per the rule's definition. */
function hasExecutedSurface(window) {
  if (typeof window !== "string") return false;
  return URL_PATTERN.test(window) || QUALIFIED_ISSUE_PATTERN.test(window);
}

/**
 * True when the window carries an explicit PENDING-ACTION surface naming all
 * THREE of the rule's elements: target + action + authorization.
 */
function hasPendingSurface(window) {
  if (typeof window !== "string") return false;
  return (
    TARGET_PATTERN.test(window) &&
    ACTION_PATTERN.test(window) &&
    AUTHORIZATION_PATTERN.test(window)
  );
}

/** Which surface arm satisfied the window, or null. Exported for the fixtures. */
function classifySurface(window) {
  if (hasExecutedSurface(window)) return "executed";
  if (hasPendingSurface(window)) return "pending";
  return null;
}

/** The claim phrase actually matched in this window, for the evidence line. */
function matchedClaim(window) {
  for (const re of HANDOFF_CLAIM_PATTERNS) {
    const m = re.exec(window);
    if (m) return m[0];
  }
  return null;
}

/**
 * The verdict. PURE — the caller supplies the reply text.
 *
 * FAILS OPEN on every unknown (`cc-artifacts.md` Rule 7): a non-string, an empty
 * reply, or a reply that after withdrawal carries no window at all returns [].
 *
 * @param {string} replyText  the final assistant chat reply
 * @returns {Array<{rule_id,severity,evidence,claim,window}>}
 */
function inspectHandoffClaims(replyText) {
  if (typeof replyText !== "string" || !replyText.trim()) return [];
  let windows;
  try {
    windows = segmentWindows(replyText);
  } catch {
    return []; // Cannot segment ⇒ UNKNOWN ⇒ fail open.
  }
  const findings = [];
  for (const w of windows) {
    const claim = matchedClaim(w);
    if (!claim) continue;
    if (classifySurface(w)) continue; // backed — the clean pole
    findings.push({
      rule_id: RULE_ID,
      severity: SEVERITY,
      claim: sanitize(claim),
      window: sanitize(w),
      evidence:
        `"${sanitize(claim)}" is claimed with NO executed-or-pending surface beside it. ` +
        `The rule requires the claim to be backed, IN THE SAME sentence or list item, by an ` +
        `executed action (a filed issue/PR URL, a verified issue number) OR an explicit ` +
        `pending-action surface naming target + action + authorization. ` +
        `Window: ${sanitize(w)}`,
    });
  }
  return findings;
}

module.exports = {
  RULE_ID,
  SEVERITY,
  EVIDENCE_MAX,
  HANDOFF_CLAIM_PATTERNS,
  classifySurface,
  hasExecutedSurface,
  hasPendingSurface,
  inspectHandoffClaims,
  matchedClaim,
  segmentWindows,
  stripFencesAndQuotes,
};
