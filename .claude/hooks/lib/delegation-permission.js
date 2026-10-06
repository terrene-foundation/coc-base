/**
 * delegation-permission.js — the PURE decision half of the delegation-permission detector.
 *
 * THE CLAUSE. `orchestrator-context-economy.md` MUST-3 ("Delegation Is The DEFAULT, Not An
 * Escalation The Human Requests") names the failure from the HUMAN's side: "a human asking 'why
 * aren't you using lanes?' is evidence the default already failed." This module detects the SAME
 * failure one step EARLIER and from the AGENT's side — a turn whose substance is the agent ASKING
 * for authorization to dispatch subagents, an authorization `agents.md` § Triad already grants by
 * default. The sibling `delegation-default.js` reads the same clause's OTHER symptom (declared
 * sub-parts against dispatched lanes). Neither subsumes the other: a session can ask for the lift
 * and then dispatch nothing (both fire), ask and then dispatch (only this one fires), or silently
 * run serially without ever asking (only the sibling fires).
 *
 * ─── WHY THIS IS DETECTABLE AT ALL, stated precisely because an earlier reading said it is not ──
 *
 * The earlier claim: no hook can detect this class, because the harness constraint that produces
 * the ask ("Do not call the AgentTool unless the user requested it") lives in the SYSTEM PROMPT,
 * which appears in NEITHER the hook payload NOR the transcript file. That measurement is TRUE and
 * it answers the WRONG QUESTION — the `instrument-discipline.md` MUST-4 shape, where an instrument
 * sound for question A is read as having answered question B.
 *
 * The VIOLATION is not the constraint's PRESENCE. It is the agent's own assistant message asking
 * for the lift, which is in the transcript BY CONSTRUCTION (it is the turn's visible output) and is
 * reachable at `Stop` through `transcript_path`. The subject exists; only the CAUSE is invisible,
 * and the cause was never what needed detecting.
 *
 * ─── THE DISCRIMINATOR ───────────────────────────────────────────────────────────────────────
 *
 * A finding requires FOUR things to hold AT ONCE, and the conjunction is the whole design — any
 * one of them alone is a well-known false-positive generator:
 *
 *   1. REQUEST — a first-person-to-second-person permission construction ("shall I", "would you
 *      like me to", "with your approval", "awaiting your go-ahead"). This is what separates a
 *      REQUEST from a REPORT: "I dispatched four reviewers" matches nothing here, and neither does
 *      third-person exposition ("the agent asks whether it should dispatch"), which is how every
 *      DOCUMENT about this class is written — including this file.
 *
 *   2. OBJECT — the thing being asked about is subagent dispatch or parallel lanes.
 *
 *   3. SAME SENTENCE — 1 and 2 must co-occur in one sentence. "Shall I force-push? I already
 *      dispatched the reviewers." carries both tokens and is not a lift request; sentence
 *      proximity is what stops it.
 *
 *   4. NOT SUPPRESSED — the sentence names no genuinely-gated action, and is not a quotation or a
 *      citation. See § SUPPRESSION.
 *
 * ─── SUPPRESSION (the false-positive defense) ────────────────────────────────────────────────
 *
 * Three suppressors, each closing a class the brief for this detector named as the main risk:
 *
 *   A. NON-ASSERTIVE SPANS are removed before anything is read: fenced code blocks, inline
 *      backtick spans, double-quoted spans (straight and curly), and blockquote lines. This is
 *      what lets an agent QUOTE the constraint, or quote an example ask, while explaining it —
 *      the exact class of work that produced this detector — without firing it.
 *
 *   B. GATED TOPICS. Asking permission is CORRECT for a cross-repo write, a destructive operation,
 *      a release authorization, or plan approval — `repo-scope-discipline.md` § User-Authorized
 *      Exception, `git.md` § Destructive Working-Tree Ops and `autonomous-execution.md`
 *      § Structural vs Execution Gates each REQUIRE the ask. A sentence naming one of those is
 *      dropped whole. This deliberately over-suppresses: "Shall I dispatch lanes and then push?"
 *      is dropped. See § BLIND SPOTS — under-firing is the chosen direction.
 *
 *   C. CITATION / META markers. A sentence citing a rule file, a MUST number, a section sign, or
 *      quoting the harness constraint verbatim is exposition about the class, not an instance of
 *      it.
 *
 * ─── TRI-STATE, NEVER A BOOLEAN ──────────────────────────────────────────────────────────────
 *
 * ADVISE / QUIET / UNKNOWN. An absent or unreadable transcript is UNKNOWN — never QUIET. The two
 * states render the same silence to the agent, which is a NOISE decision (a line on every session
 * that has no transcript yet is what teaches a reader to skip this hook's output), but they are
 * DISTINCT in the returned data, pinned by fixtures, and the unreadable case additionally emits
 * the shared one-time `warnTranscriptRecovery` stderr line. A silently broken detector is
 * indistinguishable from a well-behaved session, and that is the failure this split prevents.
 *
 * ─── BLIND SPOTS, recorded rather than hidden ────────────────────────────────────────────────
 *
 *   1. UNDER-FIRES BY DESIGN. Suppressor B drops any lift request that also names a gated action,
 *      and suppressor A drops one phrased inside quotes. Both directions were available; a missed
 *      advisory costs one nudge, a false one costs trust in every later nudge.
 *   2. LEXICAL, THEREFORE PARAPHRASABLE. The REQUEST set is a closed list of English
 *      permission idioms. "Ready to fan out on your word." carries no listed construction and is
 *      missed. No regex closes this; the semantic half is `/codify` gate-review's.
 *   3. LAST TEXT-BEARING TURN ONLY. It reads the newest text-bearing assistant message, not the
 *      whole session. An ask made three turns ago and then abandoned is not seen.
 *   4. IT CANNOT SEE WHETHER THE ASK WAS ANSWERED. If the human genuinely did instruct the agent
 *      to check before dispatching in THIS session, the ask is correct and this still fires.
 *      That is a real false positive with no available signal, and is why the severity cannot be
 *      `block` and why the advisory says so in its own text.
 *   5. IT DETECTS THE ASK, NOT THE IDLENESS. A session that asks and then dispatches anyway is
 *      flagged; a session that never asks and never dispatches is invisible here (that is the
 *      sibling's arm).
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { appendSinkLine } = require("./append-sink.js");

/** Verdict vocabulary. Closed — an unrecognized state is a bug, never a guess. */
const STATES = Object.freeze(["ADVISE", "QUIET", "UNKNOWN"]);

/** Cap on the marker file read, so a runaway sink cannot turn a shutdown hook into an OOM. */
const MAX_MARKER_BYTES = 256 * 1024;

/**
 * Cap on the text scanned. The reader already bounds the transcript READ to a 512KB tail; this
 * bounds the REGEX work on what it returned, so a pathological single message cannot make a
 * shutdown hook run long. A final assistant message past this size is truncated, not skipped —
 * the ask, when it happens, is overwhelmingly in the closing paragraphs.
 */
const MAX_SCAN_CHARS = 64 * 1024;

/** Longest sentence kept for reporting; longer ones are elided in the advisory only. */
const REPORT_SENTENCE_CHARS = 220;

// ── 1. REQUEST — first-person-to-second-person permission constructions ────────────────────────
// Every entry names an explicit ADDRESSEE ("you") or an explicit first-person subject ("I") in a
// permission frame. That is what makes third-person exposition — the form every document about
// this class takes, this file included — unable to match.
const REQUEST_PATTERNS = Object.freeze([
  /\b(?:shall|should|may|can|could)\s+I\b/i,
  /\bdo\s+you\s+want\s+me\s+to\b/i,
  /\bwould\s+you\s+like\s+me\s+to\b/i,
  /\byou\s+want\s+me\s+to\b/i,
  /\blet\s+me\s+know\s+(?:if|whether)\s+(?:you|you'd)\b/i,
  /\bif\s+you(?:'d|\s+would)?\s+(?:like|prefer|approve|confirm|want|agree|say)\b/i,
  /\b(?:with|on|pending|subject\s+to)\s+your\s+(?:approval|go-?ahead|say-?so|permission|authoriz(?:ation|ations)|authoris(?:ation|ations)|confirmation|sign-?off|word)\b/i,
  /\bawaiting\s+(?:your\s+)?(?:approval|permission|authoriz|authoris|confirmation|go-?ahead|instruction)/i,
  /\bI\s+(?:need|require|would\s+need|'d\s+need|am\s+asking\s+for)\s+(?:your\s+)?(?:permission|approval|authoriz|authoris|the\s+go-?ahead)/i,
  /\bam\s+I\s+(?:allowed|permitted|authoriz|authoris|cleared)\b/i,
  /\bsay\s+the\s+word\s+and\s+I\b/i,
]);

// ── 2. OBJECT — subagent dispatch / parallel lanes ─────────────────────────────────────────────
// Unambiguous on its own: naming a subagent or the delegation tool is never about anything else.
const SUBAGENT_NOUN =
  /\b(?:sub-?agents?|agent\s+tool|agenttool|task\s+tool|agent\s+team|agent\s+teams)\b/i;
// Ambiguous alone, so each is required to co-occur with an agent-ish noun below.
const DISPATCH_VERB = /\b(?:dispatch|delegat|spawn|launch|parallel(?:ize|ise)|fan[-\s]?out)/i;
const PARALLEL_ADV = /\b(?:in\s+parallel|parallel|concurrent|simultaneous|fan[-\s]?out)/i;
const AGENT_NOUN =
  /\b(?:agents?|lanes?|reviewers?|specialists?|workers?|analysts?|architects?)\b/i;

// ── 4B. GATED TOPICS — asking here is MANDATED, never a violation ──────────────────────────────
// Each token names an action some rule in this corpus REQUIRES the agent to ask about:
// cross-repo (`repo-scope-discipline.md` § User-Authorized Exception), destructive working-tree
// ops (`git.md`), release/deploy authorization and plan approval
// (`autonomous-execution.md` § Structural vs Execution Gates), and secret handling
// (`security.md`).
const GATED_TOPIC = new RegExp(
  [
    "\\b(?:push|force-push|merge|merging|rebase|cherry-pick|revert)\\b",
    "\\b(?:release|publish|deploy|deployment|production|prod)\\b",
    "\\b(?:commit|committing|tag|tagging|amend)\\b",
    "\\bcross[-\\s]?repo\\b",
    "\\b(?:another|other|sibling|upstream|downstream)\\s+repo",
    "\\b(?:delete|deleting|remove|removing|destroy|wipe|purge|overwrite|truncate)\\b",
    "rm\\s+-rf|reset\\s+--hard|clean\\s+-fd?",
    "\\b(?:destructive|irreversible|irrecoverable)\\b",
    "\\b(?:approve|approval\\s+of|sign\\s*off\\s+on)\\s+the\\s+plan\\b",
    "\\bplan\\s+approval\\b",
    "\\bproceed\\s+with\\s+the\\s+plan\\b",
    "\\b(?:credential|secret|token|api\\s+key|password)\\b",
    "\\bgh\\s+(?:pr|issue|repo)\\b",
    "\\bopen\\s+an?\\s+(?:PR|pull\\s+request|issue)\\b",
    "\\bfile\\s+an?\\s+issue\\b",
  ].join("|"),
  "i",
);

// ── 4C. CITATION / META markers — exposition about the class, not an instance ──────────────────
const CITATION_MARKER = new RegExp(
  [
    "unless\\s+the\\s+user\\s+(?:requested|asked)",
    "system\\s+prompt",
    "harness\\s+constraint",
    "\\b[a-z][a-z0-9-]*\\.md\\b",
    "\\bMUST[-\\s]?\\d",
    "§", // section sign
  ].join("|"),
  "i",
);

/**
 * Remove spans in which text is MENTIONED rather than ASSERTED.
 *
 * Order matters: fenced blocks first (they may contain quotes and backticks), then blockquote
 * lines, then inline code, then quoted spans. Each removed span is replaced with a single space so
 * sentence boundaries on either side survive.
 *
 * The quoted-span bounds are deliberate. An UNTERMINATED quote must not swallow the rest of the
 * message — that would convert one stray `"` into a blanket suppressor — so the character class
 * excludes newlines and the length is capped.
 */
// EXTRACTED 2026-09-13 to `./non-assertive-spans.js` and re-exported here unchanged.
// The body moved rather than being copied: `handoff-surface.js` needed the same
// withdrawal predicate and had only half of it, so a compliance report quoting the
// rule it complies with — in backticks — was flagged by the detector describing it.
// Two copies of a withdrawal predicate drift silently, because each looks correct
// in isolation; this keeps ONE lineage (`security.md` § Enforcement-Surface Parity
// applied to a text predicate). Behaviour here is byte-identical: same patterns,
// same order, same bounds.
const { stripNonAssertiveSpans } = require("./non-assertive-spans.js");

/**
 * Split into sentences. Newlines and list markers end a sentence as surely as a full stop does —
 * an agent's closing ask is very often a bare bullet with no terminator at all.
 */
function splitSentences(text) {
  if (typeof text !== "string" || text === "") return [];
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.replace(/^[\s>*\-+•]+/, "").trim())
    .filter((s) => s.length > 0);
}

/** Does this sentence carry a permission-request construction? */
function hasRequestConstruction(sentence) {
  return REQUEST_PATTERNS.some((re) => re.test(sentence));
}

/** Is the thing being asked about subagent dispatch or parallel lanes? */
function hasDispatchObject(sentence) {
  if (SUBAGENT_NOUN.test(sentence)) return true;
  const agentNoun = AGENT_NOUN.test(sentence);
  if (!agentNoun) return false;
  return DISPATCH_VERB.test(sentence) || PARALLEL_ADV.test(sentence);
}

/** Is this sentence suppressed? Returns the suppressor name, or null. */
function suppressorFor(sentence) {
  if (CITATION_MARKER.test(sentence)) return "citation";
  if (GATED_TOPIC.test(sentence)) return "gated-topic";
  return null;
}

/**
 * The core predicate. Pure: no IO, no clock, no transcript.
 *
 * @param {string|null|undefined} text the final assistant message
 * @param {{reason?:string|null}} [failure] typed reason when the transcript could not be read
 * @returns {{state:string, sentence:string|null, matches:number, suppressed:number, reason:string|null}}
 */
function assessLiftRequest(text, failure) {
  if (failure && failure.reason) {
    return {
      state: "UNKNOWN",
      sentence: null,
      matches: 0,
      suppressed: 0,
      reason: failure.reason,
    };
  }
  if (typeof text !== "string" || text.trim() === "") {
    return {
      state: "UNKNOWN",
      sentence: null,
      matches: 0,
      suppressed: 0,
      reason:
        "no assistant text was recovered for this turn, so the reply was NOT scanned. This is " +
        "NOT a clean result — it does not mean the turn asked for no lift.",
    };
  }

  const scanned = text.length > MAX_SCAN_CHARS ? text.slice(-MAX_SCAN_CHARS) : text;
  const sentences = splitSentences(stripNonAssertiveSpans(scanned));

  let first = null;
  let matches = 0;
  let suppressed = 0;
  for (const s of sentences) {
    if (!hasRequestConstruction(s)) continue;
    if (!hasDispatchObject(s)) continue;
    if (suppressorFor(s)) {
      suppressed++;
      continue;
    }
    matches++;
    if (first === null) first = s;
  }

  if (matches === 0) {
    return {
      state: "QUIET",
      sentence: null,
      matches: 0,
      suppressed,
      reason:
        suppressed > 0
          ? `no un-suppressed lift request in the final reply (${suppressed} candidate(s) suppressed as quoted, cited, or genuinely gated).`
          : "no lift request in the final reply.",
    };
  }
  return {
    state: "ADVISE",
    sentence: first.length > REPORT_SENTENCE_CHARS ? first.slice(0, REPORT_SENTENCE_CHARS) + "…" : first,
    matches,
    suppressed,
    reason: `${matches} sentence(s) in the final reply ask for authorization to dispatch subagents.`,
  };
}

/**
 * Render a verdict as the advisory body, or null when there is nothing to say.
 *
 * QUIET and UNKNOWN both render null (see the header's TRI-STATE note — a noise decision, not a
 * cleanliness claim). The rendered text carries its OWN false-positive bound, because the bound
 * has to travel with the finding and not only with the docs: on a genuinely-gated ask the agent
 * needs to be able to say so in one line rather than dispatch reflexively.
 */
function formatLiftAdvisory(verdict) {
  if (!verdict || typeof verdict !== "object") return null;
  if (verdict.state !== "ADVISE") return null;
  return (
    "[delegation-permission] this turn asked for AUTHORIZATION TO DISPATCH SUBAGENTS — permission " +
    "`agents.md` § Triad already grants by default. `orchestrator-context-economy.md` MUST-3: " +
    "delegation is the DEFAULT, not an escalation the human requests; waiting to be told to " +
    "parallelize is BLOCKED, and the trigger is the decomposability of the work, never a human " +
    `prompt. The sentence that fired: "${verdict.sentence}". Dispatch the independent lanes now, ` +
    "or state in one line why this particular ask was genuinely gated. ADVISORY, never a block: " +
    "the evidence is LEXICAL — a permission idiom in the reply's own prose — so " +
    "`hook-output-discipline.md` MUST-2 caps it below `block`. It cannot see whether the human " +
    "asked to be consulted in THIS session, so a correct ask can trip it; say which it is rather " +
    "than silently accepting the finding."
  );
}

/**
 * A stable dedupe signature. `Stop` fires at the end of EVERY assistant turn, so an un-deduped
 * advisory would repeat for as many turns as the same closing message stays newest. Keyed on the
 * NORMALIZED matched sentence so a DIFFERENT ask speaks again while the same one does not.
 */
function signatureOf(verdict) {
  if (!verdict || typeof verdict !== "object" || verdict.state !== "ADVISE") return "";
  const crypto = require("node:crypto");
  const norm = String(verdict.sentence || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return `ADVISE:${crypto.createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 12)}`;
}

/** Per-session dedupe marker. Mirrors `delegation-default.js::markerPath`'s injective mapping. */
function markerPath(repoDir, session) {
  const crypto = require("node:crypto");
  const raw = typeof session === "string" && session.trim().length > 0 ? session : "unknown-session";
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  const suffix = crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  return path.join(repoDir, ".claude", "learning", "delegation-permission", `${safe}-${suffix}.jsonl`);
}

/**
 * Has this exact signature already been surfaced this session?
 *
 * FAILS OPEN — an unreadable or absent marker returns false, so the advisory is emitted. A lost
 * dedupe costs one repeated line; a wrongly-suppressed advisory costs the whole finding.
 */
function alreadySurfaced(repoDir, session, sig) {
  if (!sig) return false;
  try {
    const p = markerPath(repoDir, session);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_MARKER_BYTES) return false;
    return fs
      .readFileSync(p, "utf8")
      .split("\n")
      .some((l) => {
        if (l.trim() === "") return false;
        try {
          return JSON.parse(l).sig === sig;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

/** Record that a signature was surfaced. Best-effort; never throws, never blocks shutdown. */
function markSurfaced(repoDir, session, sig, nowIso) {
  if (!sig) return { ok: false, error: "empty signature" };
  try {
    return appendSinkLine({
      repoDir,
      sinkPath: markerPath(repoDir, session),
      line: JSON.stringify({ sig, ts: nowIso || new Date().toISOString() }),
    });
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = {
  STATES,
  MAX_MARKER_BYTES,
  MAX_SCAN_CHARS,
  REPORT_SENTENCE_CHARS,
  stripNonAssertiveSpans,
  splitSentences,
  hasRequestConstruction,
  hasDispatchObject,
  suppressorFor,
  assessLiftRequest,
  formatLiftAdvisory,
  signatureOf,
  markerPath,
  alreadySurfaced,
  markSurfaced,
};
