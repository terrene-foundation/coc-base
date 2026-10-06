#!/usr/bin/env node
/**
 * journal-frontmatter-shape.js — PURE predicates for the frontmatter-SHAPE half
 * of `rules/journal.md`. No I/O, no process state, no require of anything that
 * touches the filesystem. `journal-write-guard.js` is the only caller.
 *
 * WHY THIS IS A LIB AND NOT INLINE IN THE GUARD. Three reasons, in order of
 * weight:
 *
 *   1. The guard already carries a fence-anchored frontmatter parse
 *      (`parseFrontmatterAuthor`), and the `phase2-deferrals.json` row this file
 *      graduates says in as many words: "A future author should EXTEND that
 *      guard's existing frontmatter parse rather than stand up a second one."
 *      A SECOND parse living beside the first is exactly the drift that
 *      direction forbids — two readers of the same bytes that can disagree about
 *      where the block ends. `splitFrontmatterBlock()` below is now the ONE
 *      fence-anchoring implementation and `parseFrontmatterAuthor` delegates to
 *      it, so the author layer and the shape layer cannot disagree by
 *      construction rather than by discipline.
 *   2. The guard is 983 lines of I/O, budget timers and coordination-log folding.
 *      Predicates buried in it are reachable ONLY by spawning the hook with a
 *      coordination log, an operator identity and a reservation record — the
 *      `journal-write-guard/run.mjs` harness. Shape logic has none of those
 *      dependencies, so pinning it there would price a 4-second truth-table at
 *      the cost of a full guard drive.
 *   3. `cc-artifacts.md` Rule 9 + the `triage-routing.js` exemplar: pure
 *      predicates live in `hooks/lib/`, the guard is a thin dispatcher.
 *
 * WHAT THE CONTRACT IS, AND WHERE IT COMES FROM. Every constant below is a
 * transcription of `rules/journal.md`, cited by SECTION rather than line number
 * (line citations in this repo have rotted twice; a section survives edits above
 * it):
 *
 *   - `rules/journal.md` § Naming & Format, the fenced ```yaml block — the
 *     "canonical contract the /journal command emits". REQUIRED_KEYS is its key
 *     list minus the one key it marks `[optional — ...]`.
 *   - the same block's `relates_to: [optional — ...]` — OPTIONAL_KEYS.
 *   - § Naming & Format prose: "`created_at`/`session_id`/`session_turn` are
 *     RETIRED" — RETIRED_KEYS.
 *   - § Entry Types, the seven bullets — TYPE_VALUES (the same seven the yaml
 *     block's `type:` line lists, so the two agree).
 *   - the yaml block's `phase:` line — PHASE_VALUES.
 *
 * WHAT THIS DELIBERATELY DOES **NOT** CHECK, each with the reason it cannot
 * discriminate. Read this before adding a check: every omission below is a
 * measured decision, not an oversight.
 *
 *   - UNKNOWN / EXTRA KEYS. `rules/journal.md` declares a canonical contract but
 *     NEVER declares the key set CLOSED — there is no "MUST NOT add other keys"
 *     anywhere in it. The live corpus carries `slot:` on 129 entries,
 *     `cross-repo-authorized:` on 30, `status:` on 15 and a long tail besides,
 *     none of which any rule line forbids. A detector flagging them would be
 *     asserting a schema this repo has not ratified, so its output could not be
 *     falsified by anything the rule says. Closing the key set is a RULE change
 *     first and a detector change second, in that order.
 *   - `author:` VALUE MEMBERSHIP. `rules/journal.md` § Trust Posture Wiring
 *     scopes it out explicitly: "The `author:`-verifiability half is scoped to
 *     `journal-author-discipline.md`, not this rule." `author:` is already read,
 *     already adjudicated and already attributed to
 *     `journal-author-discipline/MUST-1` by the guard's OTHER layer. Two
 *     obligations reading one key under one rule_id is the mislabelled-quantity
 *     defect; this layer reads whether the key is PRESENT and NON-EMPTY (a shape
 *     property the contract states) and stops there.
 *   - `## For Discussion`. `rules/journal.md` § Detection mechanism says whether
 *     it is required "is the reviewer's judgment, never a grep". Honoured.
 *   - CALENDAR VALIDITY of `date:`. The contract declares the FORM `YYYY-MM-DD`
 *     and nothing more, so `2026-13-45` is well-formed against the contract as
 *     written. Rejecting it would be this file inventing a stricter rule than
 *     the one it enforces.
 *   - `tags: []`. An empty flow sequence IS a list, and it is what
 *     `.claude/commands/journal.md`'s own template emits. The rule says those
 *     two "MUST agree", so flagging the emitter's documented default would put
 *     this detector on the wrong side of that sentence.
 *
 * SEVERITY. Every finding is `advisory`. Not a judgment call — `rules/journal.md`
 * § Detection mechanism names this detector in those words ("a frontmatter-shape
 * advisory detector") and the `phase2-deferrals.json` row grades its risk
 * `hygiene` under a repo-owner acceptance. Note this is a RAISE from the status
 * quo, which enforced nothing at all, never a downgrade of a live gate.
 */

"use strict";

/** `rules/journal.md` § Naming & Format — the canonical yaml block, minus `relates_to`. */
const REQUIRED_KEYS = Object.freeze([
  "type",
  "date",
  "author",
  "project",
  "topic",
  "phase",
  "verified_id",
  "person_id",
  "display_id",
  "tags",
]);

/**
 * The three keys the canonical block sources "[from reservation]".
 * `reserveJournalSlotSigned` returns them only when it emits a signed record;
 * on an UNENROLLED repo it returns `record: null` and a `degraded` reason, so
 * the author of an entry there cannot produce these values at all. Requiring
 * them unconditionally would fire on a condition the operator has no move to
 * satisfy, which is noise rather than a finding — so the caller gates them (see
 * `inspectFrontmatterShape`'s `reservationKeysRequired` option).
 */
const RESERVATION_KEYS = Object.freeze([
  "verified_id",
  "person_id",
  "display_id",
]);

/** The one key the canonical block marks `[optional — ...]`. */
const OPTIONAL_KEYS = Object.freeze(["relates_to"]);

/** `rules/journal.md` § Naming & Format prose: "…are RETIRED". */
const RETIRED_KEYS = Object.freeze([
  "created_at",
  "session_id",
  "session_turn",
]);

/** `rules/journal.md` § Entry Types (seven bullets) === the yaml block's `type:` line. */
const TYPE_VALUES = Object.freeze([
  "DECISION",
  "DISCOVERY",
  "TRADE-OFF",
  "RISK",
  "CONNECTION",
  "GAP",
  "AMENDMENT",
]);

/** The canonical yaml block's `phase:` line. */
const PHASE_VALUES = Object.freeze([
  "analyze",
  "todos",
  "implement",
  "redteam",
  "codify",
  "deploy",
]);

/**
 * The rule_id every finding here carries. DELIBERATELY NOT
 * `journal-author-discipline/MUST-1`: that id belongs to the author-BACKING
 * obligation which shares this guard and this frontmatter block but is a
 * different rule with a different severity and a different violation scope
 * (`rules/journal.md` § Violation scope draws the line). One guard carrying two
 * obligations under one id is precisely how a finding gets counted against the
 * wrong rule.
 */
const RULE_ID = "journal/frontmatter-shape";

/**
 * Fence-anchored split of a leading YAML frontmatter block. THE ONE
 * IMPLEMENTATION — `journal-write-guard.js::parseFrontmatterAuthor` delegates
 * here rather than carrying its own copy.
 *
 * Tolerates a UTF-8 BOM and leading whitespace before the opening fence, and
 * CRLF throughout. Frontmatter MUST be the LEADING block: a `---` appearing
 * first in the body does not open one, which is what stops a body line from
 * spoofing a key.
 *
 * @returns {{kind:"none"}|{kind:"unterminated"}|{kind:"ok", block:string}}
 */
function splitFrontmatterBlock(content) {
  if (typeof content !== "string" || content.length === 0)
    return { kind: "none" };
  const open = content.match(/^﻿?\s*---[ \t]*\r?\n/);
  if (!open) return { kind: "none" };
  const rest = content.slice(open[0].length);
  const close = rest.match(/(^|\r?\n)---[ \t]*(\r?\n|$)/);
  if (!close) return { kind: "unterminated" };
  return { kind: "ok", block: rest.slice(0, close.index) };
}

/**
 * Read the TOP-LEVEL `key: value` pairs out of a frontmatter block.
 *
 * CONTINUATION-AWARENESS IS THE LOAD-BEARING PART, and it is not defensive
 * programming — it is the difference between a detector and a false-positive
 * generator. Prettier formats a long flow sequence across lines:
 *
 *     tags:
 *       [
 *         amendment,
 *         correction,
 *       ]
 *
 * The `tags:` line has an EMPTY inline value and a non-empty real one. A naive
 * "key present but nothing after the colon" test calls that empty. MEASURED on
 * this repo's own corpus before this file existed: that naive test reported 20
 * of the last 40 journal entries as carrying an empty `tags:`, and every one of
 * those 20 was a false positive — the tag list was on the continuation lines.
 * A detector with a 100% false-positive rate on its most common finding is one
 * an operator learns to ignore, which is worse than no detector.
 *
 * So `hasContinuation` is TRUE when the next non-blank line inside the block is
 * INDENTED (YAML's own rule for a value continued onto following lines), and a
 * key is EMPTY only when its inline value is empty AND nothing continues it.
 *
 * @returns {Map<string,{value:string,hasContinuation:boolean}>}
 */
function parseTopLevelFields(block) {
  const lines = block.split(/\r?\n/);
  const fields = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^\s/.test(raw)) continue; // indented ⇒ nested under some other key
    const m = raw.match(
      /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))[ \t]*:[ \t]*(.*)$/,
    );
    if (!m) continue;
    const key = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    let value = m[4].trim();
    // Strip a trailing `# comment` only when the value is not quoted — same
    // narrow grammar `parseFrontmatterAuthor` uses, so the two agree on values.
    if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, "").trim();
    const q = value.match(/^"([^"]*)"$|^'([^']*)'$/);
    if (q) value = (q[1] !== undefined ? q[1] : q[2]).trim();

    let hasContinuation = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === "") continue; // blank lines do not end a value
      hasContinuation = /^\s/.test(lines[j]);
      break;
    }
    // LAST occurrence wins, matching `parseFrontmatterAuthor`'s loop. A
    // duplicated key is the author layer's finding, not this one's.
    fields.set(key, { value, hasContinuation });
  }
  return fields;
}

function finding(code, detail, key) {
  return {
    rule_id: RULE_ID,
    code: `${RULE_ID}#${code}`,
    severity: "advisory",
    key: key || null,
    detail,
  };
}

/**
 * The detector. Returns a (possibly empty) array of advisory findings about the
 * frontmatter SHAPE of a journal entry's content.
 *
 * ORDER OF FINDINGS IS STABLE (absent/unverifiable first, then required-key
 * findings in REQUIRED_KEYS order, then retired keys, then value shapes) so a
 * fixture's answer key can be compared as a set OR a sequence without the
 * comparison depending on Map iteration order.
 *
 * @param {string} content            the Write payload's file content
 * @param {{reservationKeysRequired?: boolean}} [opts]
 *        `reservationKeysRequired` false ⇒ `verified_id`/`person_id`/`display_id`
 *        are not required (an unenrolled repo cannot produce them). Default true.
 * @returns {Array<{rule_id:string, code:string, severity:"advisory", key:string|null, detail:string}>}
 */
function inspectFrontmatterShape(content, opts) {
  const reservationKeysRequired = !(
    opts && opts.reservationKeysRequired === false
  );

  // NO INPUT IS NOT A FINDING — it is a check that did not run, and the two are
  // not the same fact. The guard fires on `Edit|Write|NotebookEdit`, and only
  // `Write` carries `tool_input.content`: an Edit carries `old_string` /
  // `new_string`, a NotebookEdit carries cell fields, and a payload may carry
  // none of them. Reporting the `absent` finding for those would be this
  // detector saying "the entry has no frontmatter" on the sole evidence that IT
  // WAS HANDED NOTHING — a verdict that cannot tell "no frontmatter" from "no
  // input", which is the non-discriminating instrument
  // `rules/instrument-discipline.md` MUST-1 blocks as evidence.
  //
  // MEASURED, NOT ANTICIPATED. The pre-existing
  // `audit-fixtures/journal-write-guard/03-pass-self-reserved/input.json`
  // supplies a `tool_input` with NO `content` key, and the first revision of
  // this function reported `absent` for it. The existing suite reddened, and
  // that red was CORRECT — it caught a real defect in this detector, not a
  // stale expectation.
  //
  // An empty STRING is a different fact and IS still checked: `""` is content
  // that was supplied and genuinely carries no frontmatter.
  if (typeof content !== "string") return [];

  const split = splitFrontmatterBlock(content);

  if (split.kind === "none") {
    return [
      finding(
        "absent",
        "the entry has no leading `---` YAML frontmatter block; `rules/journal.md` § MUST NOT forbids creating entries without frontmatter (they cannot be filtered by type, phase or date)",
      ),
    ];
  }
  if (split.kind === "unterminated") {
    // NOT a duplicate of the author layer's `unparseable`. That one reports that
    // the AUTHOR claim went unread; this reports that the SHAPE went unchecked.
    // Two checks that could not run are two findings, and reporting only one of
    // them would leave the other's silence looking like a clean result.
    return [
      finding(
        "shape-unverifiable",
        "the leading `---` frontmatter fence is never closed, so the block has no end and NO key in it was read — the shape check did not run, which is a finding rather than a pass (`rules/instrument-discipline.md` MUST-1)",
      ),
    ];
  }

  const fields = parseTopLevelFields(split.block);
  const findings = [];

  for (const key of REQUIRED_KEYS) {
    if (!reservationKeysRequired && RESERVATION_KEYS.includes(key)) continue;
    const f = fields.get(key);
    if (f === undefined) {
      findings.push(
        finding(
          "missing-required-key",
          `the canonical frontmatter contract (\`rules/journal.md\` § Naming & Format) declares \`${key}:\` and the entry does not carry it`,
          key,
        ),
      );
      continue;
    }
    if (f.value === "" && !f.hasContinuation) {
      findings.push(
        finding(
          "empty-required-value",
          `\`${key}:\` is present but carries no value, inline or on a continuation line — a declared key with nothing after it is not a populated field`,
          key,
        ),
      );
    }
  }

  for (const key of RETIRED_KEYS) {
    if (fields.has(key)) {
      findings.push(
        finding(
          "retired-key",
          `\`${key}:\` is RETIRED per \`rules/journal.md\` § Naming & Format and is not part of the canonical contract`,
          key,
        ),
      );
    }
  }

  const type = fields.get("type");
  if (type && type.value !== "" && !TYPE_VALUES.includes(type.value)) {
    findings.push(
      finding(
        "unknown-enum-value",
        `\`type: ${type.value}\` is not one of the seven types \`rules/journal.md\` § Entry Types declares (${TYPE_VALUES.join(" | ")})`,
        "type",
      ),
    );
  }

  const phase = fields.get("phase");
  if (phase && phase.value !== "" && !PHASE_VALUES.includes(phase.value)) {
    findings.push(
      finding(
        "unknown-enum-value",
        `\`phase: ${phase.value}\` is not one of the COC phases the canonical contract declares (${PHASE_VALUES.join(" | ")})`,
        "phase",
      ),
    );
  }

  const date = fields.get("date");
  if (date && date.value !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(date.value)) {
    findings.push(
      finding(
        "malformed-date",
        `\`date: ${date.value}\` is not the \`YYYY-MM-DD\` form the canonical contract declares (calendar validity is deliberately NOT checked — the contract states a form, not a range)`,
        "date",
      ),
    );
  }

  return findings;
}

/**
 * Render findings as `agent_must_report` lines. Every line is SELF-LABELLING
 * with its tier and rule_id, because these lines are carried into emits whose
 * OWN severity is `block` or `halt-and-report` (the reservation and author
 * layers). Without the per-line label an advisory finding rides into a refusal
 * and reads as part of the reason the tool was refused — a finding counted at a
 * severity nobody assigned it.
 */
function renderShapeLines(findings) {
  if (!findings || findings.length === 0) return [];
  return [
    "",
    `ADVISORY — ${RULE_ID} (${findings.length} frontmatter-shape finding${findings.length === 1 ? "" : "s"}; does NOT change the verdict above):`,
    ...findings.map(
      (f) => `  ${f.code}${f.key ? ` [${f.key}]` : ""} — ${f.detail}`,
    ),
  ];
}

module.exports = {
  REQUIRED_KEYS,
  RESERVATION_KEYS,
  OPTIONAL_KEYS,
  RETIRED_KEYS,
  TYPE_VALUES,
  PHASE_VALUES,
  RULE_ID,
  splitFrontmatterBlock,
  parseTopLevelFields,
  inspectFrontmatterShape,
  renderShapeLines,
};
