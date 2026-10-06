"use strict";
/**
 * register-regression.js — the predicate seam behind `register-regression-guard.js`.
 *
 * It answers two questions about a write to a DECLARED burndown register source:
 *
 *   GUARD A  Does this write RETRACT a delivery claim — by demotion, by removing
 *            the row, or by retiring it — and if so does it carry a rebuttal
 *            naming WHAT WAS OBSERVED?
 *   GUARD B  Does a row that still presents as OWED point at a LIVE ask — an
 *            artifact that exists and does not declare itself superseded?
 *
 * WHY A LIB AND NOT INLINE. The hook is a transport; the predicate is the thing
 * that has to be shown to discriminate. Splitting them lets the fixtures call
 * `evaluate()` directly on constructed pairs AND separately drive the hook as a
 * real subprocess, so a green in one is not mistaken for a green in the other.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE BASELINE IS `HEAD`, NOT THE WORKING COPY — and that is load-bearing.
 *
 * The clause is "an ABSENCE of fresh verification is not evidence AGAINST a
 * RECORDED one." The RECORDED status is the COMMITTED one: it is what
 * `burndown-build.mjs` counts (it refuses on a modified declared source) and what
 * a reader quoting the block is quoting.
 *
 * Comparing against the WORKING COPY would open a two-step evasion costing
 * nothing: edit once `Signed off` → `In progress` (refused), then edit again for
 * any reason — the second write compares `In progress` against `In progress`,
 * finds no demotion, and the rebuttal is never asked for again. Against HEAD every
 * subsequent write re-poses the question until the retraction is either rebutted
 * or committed.
 *
 * It also catches a retraction written through a channel this hook cannot see — a
 * Bash heredoc, a `>` redirect — on the NEXT tool-mediated write.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE THREE SHAPES OF A RETRACTION, and why guarding only the first is useless.
 *
 * A security review of the first revision found that guarding the DEMOTION alone
 * left two equivalent exits wide open, each cheaper than the one being guarded:
 *
 *   1. DEMOTE      `Signed off` → `Not started`.                    (A-1 / A-2)
 *   2. RENAME/DROP change the row's `id`, or delete the row.        (A-3)
 *      The old id vanishes, the new id looks BRAND NEW, and a new row has no
 *      recorded status to contradict — so nothing fired. The generator does NOT
 *      close this: its unknown-id refusal is scoped to `kind: "status-refresh"`
 *      sources, and this repo declares only a `kind: "register"`.
 *   3. RETIRE      add `superseded_by` to a delivered row, commit, THEN demote.  (A-4)
 *      The exclusion that protects a genuine REINSTATEMENT reads the HEAD row, so
 *      once the marker is committed the demotion is excluded. Step 1 of that
 *      chain was silent on every surface.
 *
 * All three move the same count by the same amount. So all three demand the same
 * rebuttal, and A-3/A-4 exist to make the cheap exits cost what the guarded one
 * costs. A guard that only raises the price of the front door is not a guard.
 *
 * BOUNDS, stated rather than implied:
 *   - Once a retraction is COMMITTED, HEAD carries it and no later write re-poses
 *     the question; removing a rebuttal in a follow-up commit is not caught.
 *   - The placeholder set (§ classifyRebuttal) stops the LAZY placeholder, not a
 *     determined one: any novel string of 8+ characters passes it. It buys that
 *     "n/a" cannot silently satisfy a `block`, nothing more.
 *   - The absence corpus is LEXICAL and finite. It is anchored on the SUBJECT so
 *     it does not refuse observations about the system, which costs recall: an
 *     absence phrased without a speaker and outside the corpus reads as an
 *     observation. That trade is deliberate — a `block`-adjacent arm that cries
 *     wolf on real rebuttals gets disabled, and then nothing is enforced.
 *   - No git, no HEAD blob, an unparseable side: UNKNOWN — reported AS unknown,
 *     never as clean.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
// EVERY git a guard spawns routes through this helper (loom#1462/#1471). It is not
// hygiene here, it is the guard's own threat model: this lib asks git for the
// RECORDED status at HEAD, and that answer IS the baseline every verdict is
// measured against. A bare `git` inherits the ambient environment, where `GIT_DIR`
// outranks repository DISCOVERY — so one env var (deliverable via a
// `settings.local.json` `env` block, which reaches every hook subprocess) makes a
// DIFFERENT repository answer "what was this row's committed status?". The guard
// would then compare the incoming write against an attacker-chosen HEAD and clear
// a real retraction. `gitEnv()` builds an explicit minimal env from constants, and
// `resolveGitBinary()` pins an absolute binary rather than trusting PATH.
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env");

const MAX_BYTES = 512 * 1024;
const MAX_ASK_BYTES = 64 * 1024; // per-ask read cap; guardB runs on every write
const MAX_ASK_REFS = 200; // bounded FS work per write, so content cannot time the hook out
const GIT_TIMEOUT_MS = 2500;
// A RESIDUAL floor only — the closed PLACEHOLDER_VALUES set below does the real
// work. Set far under the shortest genuine observation measured ("HTTP 502 at
// /reports", 20 chars) so it cannot refuse a real rebuttal.
const MIN_REBUTTAL_CHARS = 8;

/**
 * The closed vocabulary of `burndown-integrity.md`, ranked.
 *
 * DELIVERED is the pair making a DELIVERY claim: `Signed off` (the owner walked
 * and accepted it) and `Built-not-walked` (we built it). `Blocked on you` is the
 * OWNER-ACTION bucket and claims no delivery, so it sits at the floor: moving
 * there from a delivered bucket RETRACTS a claim.
 *
 * The ladder is the structural signal. A demotion is `rank(new) < rank(old)` with
 * `rank(old)` in the delivered band — an integer comparison over a closed enum,
 * no prose read anywhere. That is what earns A-2 `block` under
 * `hook-output-discipline.md` MUST-2, and why the lookup NORMALIZES hard: if
 * `Signed off` → `signed-off` changed the rank, the "cannot evade by surface
 * rewrite" half of MUST-2 would be false.
 */
const STATUS_RANK = new Map([
  ["signedoff", 3],
  ["builtnotwalked", 2],
  ["inprogress", 1],
  ["notstarted", 0],
  ["blockedonyou", 0],
]);
const DELIVERED_MIN_RANK = 2;

/**
 * Default-ignorable and invisible code points, stripped before the enum lookup.
 *
 * MEASURED EVASION this closes: `"Signed­off"` (SOFT HYPHEN), `"Signed​off"`
 * (ZWSP) and `"Signed‑off"` (NON-BREAKING HYPHEN) each returned rank `null`,
 * because JS `\s` excludes all three and the hyphen class held only `-`, `–`, `—`.
 * A `null` rank means "outside the vocabulary", which the guard skips — so an
 * invisible character bought a silent pass through the ladder. NFKC folds the
 * fullwidth and compatibility forms in the same step.
 */
const INVISIBLE_RX = /[­​-‏⁠-⁤﻿]/g;
const HYPHEN_CLASS_RX = /[\s_\-‐‑‒–—―−]+/g;

function normStatus(s) {
  if (typeof s !== "string") return null;
  let t = s;
  try {
    t = t.normalize("NFKC");
  } catch {
    /* a malformed string normalises to itself; the enum lookup still decides */
  }
  return t.replace(INVISIBLE_RX, "").trim().toLowerCase().replace(HYPHEN_CLASS_RX, "");
}

/** null when the status is OUTSIDE the closed vocabulary — never a guessed rank. */
function rankOf(status) {
  const k = normStatus(status);
  if (k === null) return null;
  return STATUS_RANK.has(k) ? STATUS_RANK.get(k) : null;
}

function isDelivered(status) {
  const r = rankOf(status);
  return r !== null && r >= DELIVERED_MIN_RANK;
}

/** The OWNER-ACTION bucket — the one a row is handed BACK to the owner from. */
function isOwed(status) {
  return normStatus(status) === "blockedonyou";
}

// ── the supersession-marker vocabulary ──────────────────────────────────────

/**
 * TWO vocabularies, because the two uses are not the same question.
 *
 * `RETIREMENT_FIELDS` — fields that assert the ask itself is OVER. Adding one to a
 * delivered row RETRACTS the delivery claim, which is what A-4 detects.
 *
 * `SUPERSESSION_FIELDS` — the wider set that also takes a row OUT OF SCOPE. It
 * adds `internal`, which is a VISIBILITY flag, not a retraction: an internal row is
 * one we do not report on, so it should not be guarded — but tagging a delivered
 * row `internal` is not a claim that it was never delivered.
 *
 * Sharing one list made A-4 block on `internal: true`, refusing an operator who
 * was merely marking a row unreportable. Same shape as the reinstatement false
 * positive: a scope vocabulary reused as a detector.
 */
const RETIREMENT_FIELDS = ["superseded_by", "superseded", "retired", "withdrawn"];
const SUPERSESSION_FIELDS = [...RETIREMENT_FIELDS, "internal"];

/**
 * Values that LOOK like a marker but SAY the opposite. `"retired": "no"` used to
 * read as retired, because any non-empty string was truthy — so a field whose
 * value denies the state switched the state on, and with it Guard A's scope
 * exclusion and the whole of Guard B.
 */
const NEGATION_VALUES = new Set(["no", "false", "none", "n/a", "na", "nil", "null", "0", "never", "not"]);

function markerValueIsSet(v) {
  if (v === true) return true;
  if (typeof v !== "string") return false; // numbers/objects are not a declaration
  const t = v.trim().toLowerCase();
  if (t === "") return false;
  return !NEGATION_VALUES.has(t);
}

/** Which supersession fields are SET on this row (empty array = not retired). */
function supersessionFieldsSet(item) {
  if (!item || typeof item !== "object") return [];
  return SUPERSESSION_FIELDS.filter((f) => markerValueIsSet(item[f]));
}

/** Which RETIREMENT fields are set — the narrower set A-4 keys on. */
function retirementFieldsSet(item) {
  if (!item || typeof item !== "object") return [];
  return RETIREMENT_FIELDS.filter((f) => markerValueIsSet(item[f]));
}

function isSupersededRow(item) {
  return supersessionFieldsSet(item).length > 0;
}

/**
 * Does an ARTIFACT's own text declare ITSELF superseded? Guard B-2's predicate.
 *
 * BANNER-ANCHORED, which is a correction. The first revision matched the marker
 * words anywhere in the head, and MEASURABLY misfired on this repo's own live
 * rules: several open with a sentence saying that some FLAG or OPTION "is
 * RETIRED", in rules that are entirely current. loom's house style puts exactly
 * those words in opening paragraphs, so the head is where the false positives
 * live — not where they are avoided. (The real sentence is not quoted here: a
 * separate guard pins which files may mention that particular retired flag, and
 * an illustrative quote is not a good enough reason to enter that pin list.)
 *
 * A real supersession banner is a LINE, not a clause: it opens the line (after at
 * most a markdown/comment prefix) or it is an explicit `SUPERSEDED BY` /
 * `REPLACED BY` pointer. Prose ABOUT retirement no longer matches.
 */
// The marker must open the line AND not be modifying a following noun. A banner
// ends the line, or runs into punctuation, or points somewhere ("SUPERSEDED BY x").
// MEASURED false positive this closes: a LIVE ask whose first line reads
// "Deprecated fields: please confirm which of these we can drop." — line-initial,
// but the marker is an adjective on "fields", not a declaration about the document.
const BANNER_LINE_RX = new RegExp(
  "^[\\s>#*_|-]*(?:\\*\\*|__)?\\s*" +
    "(SUPERSEDED\\s+BY|REPLACED\\s+BY|SUPERSEDED|SUPERCEDED|RETIRED|WITHDRAWN|OBSOLETE|DEPRECATED|ARCHIVED|NO LONGER CURRENT|DO NOT USE)" +
    "(?:\\*\\*|__)?\\s*(?:$|[—:–\\-.,()\\[\\]!]|\\bby\\b|\\bin\\s+favou?r\\b)",
  "i",
);
const POINTER_RX = /\b(SUPERSEDED BY|REPLACED BY)\s+\S/i;

function declaresSuperseded(text) {
  if (typeof text !== "string") return null;
  // The head only: a banner is at the top by definition. `slice` counts UTF-16
  // code units, not bytes — said plainly because the previous comment said
  // "bytes" and was wrong on multibyte content.
  const head = text.slice(0, 4000);
  for (const line of head.split(/\r?\n/)) {
    const m = line.match(BANNER_LINE_RX);
    if (m) return m[1];
    const p = line.match(POINTER_RX);
    if (p) return p[1];
  }
  return null;
}

// ── the ABSENCE corpus ──────────────────────────────────────────────────────
//
// VERBATIM from the originating incidents, every one a rebuttal that was OFFERED
// and is REJECTED:
//
//   "this session did not verify it"   "no lane walked it"
//   "I could not confirm it"           "nobody has walked it"
//   "built, not walked"                "merged is not rendered"
//
// Each is an ABSENCE — a statement about what the SPEAKER did not do — and an
// absence of fresh verification is not evidence against a recorded one.
//
// APOSTROPHE CLASS: `['’‘ʼ`]`, not a bare ASCII quote. MEASURED:
// "wasn't verified" classified as an absence and "wasn’t verified" — the SAME
// sentence as any smart-quoting editor or LLM emits it — classified as an
// OBSERVATION. That is not an adversarial evasion; it is the default output of
// ordinary writing, so the ASCII-only class made the arm unreliable on exactly
// the inputs it will see most.
//
// The patterns stay narrow around VERIFICATION verbs. "the migration never ran"
// is an OBSERVATION and must pass; "it was never verified" is an absence and must
// not. Widening to bare negation would swallow the observations the clause exists
// to demand.
const APOS = "['’‘ʼ`]";
// `test`/`review` are deliberately ABSENT: they are things the SYSTEM does as
// often as the observer, and including them made "the acceptance checklist was
// not reviewed" — an observation — read as an absence.
const VERIFY_VERB = "(?:verif\\w*|confirm\\w*|walk\\w*|validat\\w*|observ\\w*|reproduc\\w*|witness\\w*)";

/**
 * THE SUBJECT ANCHOR — the discriminator this corpus turns on.
 *
 * An ABSENCE is a statement about what the OBSERVER did not do. An OBSERVATION is
 * a statement about what the SYSTEM does. English uses the same verbs for both,
 * so keying on the verb alone cannot tell them apart — and measurably did not:
 * every one of these is a legitimate rebuttal that the un-anchored corpus rejected.
 *
 *   "The upload path does not check the MIME type — I uploaded a .exe, accepted."
 *   "The form is not validated on submit: posted an empty payload, got 200."
 *   "The endpoint never validates the bearer token — sent a garbage JWT, got 200."
 *   "Users cannot find the export button: removed from the nav in a8e737a."
 *   "Login returns 401 and no session cookie is set — captured in the run log."
 *
 * Each names something SEEN and each was refused. So the negated verification verb
 * must belong to the OBSERVER: an explicit speaker, an absent actor, or an
 * agentless passive about the row itself. A system component as subject is an
 * observation and passes.
 */
const SPEAKER =
  "(?:I|we|us|our|my|this\\s+session|the\\s+session|this\\s+lane|the\\s+lane|this\\s+pass|nobody|no\\s?body|no[\\s-]?one|anyone|anybody|the\\s+agent|the\\s+reviewer|the\\s+owner|any\\s+lane|any\\s+session|it|this\\s+row|the\\s+row|this\\s+item)";
const ACTOR_ABSENT = "(?:nobody|no[\\s-]?one|no\\s+(?:lane|body|session|agent|reviewer|human|owner))";

const ABSENCE_PATTERNS = [
  {
    // SPEAKER … did/could not … VERIFY. The speaker may sit up to a short window
    // before the negation ("this session has not yet verified it").
    id: "did-not-verify",
    rx: new RegExp(
      `\\b${SPEAKER}\\b[^.!?]{0,24}?\\b(?:did|does|do|has|have|had|was|were|is|are|could|can|would|will)\\s*(?:n${APOS}?t|not)\\s+(?:yet\\s+|been\\s+|be\\s+|able\\s+to\\s+)*${VERIFY_VERB}`,
      "i",
    ),
    note: 'a statement about what the OBSERVER did not do — "this session did not verify it"',
  },
  {
    // Agentless passive about the row: "not verified", "has not been walked".
    // No system subject can own this form, so no anchor is needed.
    id: "agentless-not-verified",
    // `\s*` after the auxiliary, not `\s+`: the CONTRACTED form has no space
    // ("wasn't" = "was" + "n't"), so `was\s+` missed every contraction — which is
    // most of them in practice, and exactly the register the absence corpus sees.
    rx: new RegExp(
      `(?:^|[.;:!?]\\s*|\\b(?:but|and|so|it|this|that)\\s+)(?:(?:has|have|had|was|were|is|are)\\s*)?(?:n${APOS}?t|not)\\s+(?:yet\\s+)?(?:been\\s+)?${VERIFY_VERB}\\b`,
      "i",
    ),
    note: 'an agentless "not verified" states an absence and names nothing observed',
  },
  {
    id: "never-verified",
    rx: new RegExp(
      `(?:\\bnever\\s+been\\s+${VERIFY_VERB}|\\b${SPEAKER}\\b[^.!?]{0,24}?\\bnever\\s+${VERIFY_VERB})`,
      "i",
    ),
    note: 'never-verified is still an absence — "it has never been walked"',
  },
  {
    // An ABSENT ACTOR, and the verification verb must be theirs — within a short
    // window. "no session cookie is set" is an observation and must not match;
    // "no lane walked it" must.
    id: "no-one-walked",
    rx: new RegExp(`\\b${ACTOR_ABSENT}\\b[^.!?]{0,30}?\\b(?:has\\s+|have\\s+|had\\s+)?${VERIFY_VERB}`, "i"),
    note: 'an absent actor is not an observation — "no lane walked it"',
  },
  {
    // An inability, and it must be the OBSERVER's. "Users cannot find the export
    // button" is an observation about the system.
    id: "unable-to-confirm",
    // Either an explicit speaker, OR sentence-initial with the subject ELIDED —
    // "couldn't confirm it was live" is unambiguously the writer. A named subject
    // before the modal ("Users cannot find the export button") is an observation
    // about the system and is not sentence-initial, so it stays out.
    rx: new RegExp(
      `(?:\\b${SPEAKER}\\b[^.!?]{0,24}?|^|[.;!?]\\s*)\\b(?:unable\\s+to|cannot|can${APOS}?t|couldn${APOS}?t|could\\s+not|failed\\s+to)\\s+(?:yet\\s+)?(?:${VERIFY_VERB}|find\\b|locate\\b|tell\\b)`,
      "i",
    ),
    note: 'an inability of the OBSERVER is not evidence — "I could not confirm it"',
  },
  {
    id: "built-not-walked",
    rx: /\b(?:built|merged|shipped|landed|deployed|done)\b[\s,;]*(?:but\s+)?(?:is\s+)?not\s+(?:walked|rendered|verified|confirmed|live|validated|reviewed)/i,
    note: 'restating the ladder is not an observation — "built, not walked" / "merged is not rendered"',
  },
  {
    // Labels ABOUT THE ROW's evidential state. These name no subject at all, so
    // they carry no anchor — but the nouns are deliberately evidence-words only
    // (`verification`/`evidence`/`proof`), never `record`/`trace`/`tests`, which
    // made "there is no record of the export in the audit table" — an
    // observation — read as an absence.
    id: "bare-unverified",
    rx: /\b(?:unverified|unconfirmed|unvalidated|unsubstantiated|lack(?:ing|s)?\s+(?:of\s+)?(?:fresh\s+)?(?:verification|confirmation|evidence|proof)|absence\s+of\s+(?:verification|evidence|proof)|(?:no|zero)\s+(?:fresh\s+)?(?:verification|confirmation|proof)\b|(?:no|zero)\s+evidence\s+(?:that|it|of\s+(?:a\s+)?(?:walk|verification|review)))/i,
    note: "a bare unverified/unconfirmed label states an absence and nothing observed",
  },
  {
    id: "outstanding-pending",
    rx: new RegExp(
      `\\b(?:(?:${VERIFY_VERB})\\s+(?:is|remains|are)\\s+(?:still\\s+)?(?:outstanding|pending|missing|absent|owed|todo)|(?:we|I|they)\\s+(?:have|has|had)\\s+yet\\s+to\\s+\\w+|(?:the\\s+)?(?:walkthrough|verification|confirmation)\\s+(?:is|are|was|were)\\s+(?:still\\s+)?(?:missing|absent|outstanding|pending|gone))\\b`,
      "i",
    ),
    note: 'deferral is an absence in the future tense — "we have yet to walk it"',
  },
];

/**
 * Placeholder values — the CLOSED set that may carry `block`.
 *
 * This replaces a bare 24-character length floor. That floor was a MEASURED false
 * positive on the `block` arm: `"HTTP 502 at /reports"` (20), `"Query returns 0
 * rows."` (21) and `"Build fails: exit 127"` (21) are exactly the observations the
 * rule demands, and every one of them was refused.
 *
 * The floor's justification does not survive that: the MEASUREMENT (length) is
 * deterministic, but the load-bearing step is the INFERENCE short ⇒ placeholder,
 * which is semantic and was wrong. An enumerated set is genuinely structural —
 * membership, not judgement — so it can carry `block` under
 * `hook-output-discipline.md` MUST-2 on its own terms.
 *
 * A short residual floor is kept far below any real observation, so a novel
 * one-character placeholder is still caught without reaching a real rebuttal.
 */
const PLACEHOLDER_VALUES = new Set([
  "na",
  "n/a",
  "tbd",
  "tba",
  "todo",
  "none",
  "nil",
  "null",
  "unknown",
  "x",
  "-",
  "--",
  ".",
  "?",
  "??",
  "y",
  "n",
  "ok",
  "done",
  "wip",
  "pending",
  "placeholder",
]);

/**
 * Classify a rebuttal value.
 *   missing      — no key, wrong type, empty, or below the SUBSTANCE FLOOR. STRUCTURAL.
 *   absence      — present and substantive, but states what was NOT done. LEXICAL.
 *   observation  — present, substantive, and not an absence. Passes.
 *
 * THE SUBSTANCE FLOOR IS A MEASURED FIX, not a style preference. Because the
 * structural arm is a pure key-PRESENCE test and the lexical arm is a finite
 * corpus, the composed contract before this floor was literally "type any
 * character into this field": `"n/a"`, `"TBD"`, `"none"`, `"-"` and `"x"` all
 * classified as OBSERVATION and passed a `block` silently. Those are semantically
 * absences that defeat BOTH arms at once.
 *
 * The floor is a length measurement — deterministic, not a semantic read — so it
 * can carry `block` without breaching `hook-output-discipline.md` MUST-2. Its
 * bound is stated honestly in the header: it stops the LAZY placeholder, not a
 * determined one, because padding passes it. That is worth having anyway; the
 * realistic failure here is a hurried agent typing "n/a", not one composing
 * 24 characters of camouflage.
 */
function classifyRebuttal(value) {
  if (value === undefined || value === null) return { kind: "missing", why: "no `regression_rebuttal` on the row" };
  if (typeof value !== "string") {
    return { kind: "missing", why: `\`regression_rebuttal\` is ${typeof value}, not a string` };
  }
  const text = value.trim();
  if (text === "") return { kind: "missing", why: "`regression_rebuttal` is empty" };

  // THE LEXICAL ARM IS CONSULTED FIRST, and the order is load-bearing.
  //
  // Four of the six VERBATIM absence phrases are shorter than the substance
  // floor ("no lane walked it" is 17 characters). Running the floor first
  // reclassified them from `absence` to `missing`, which silently promoted a
  // LEXICAL verdict — "these words state an absence" — to `block`. That is
  // exactly what `hook-output-discipline.md` MUST-2 forbids, and the fixtures'
  // MUST-2 ceiling poles caught it.
  //
  // So: a RECOGNISED absence is an absence at `halt-and-report`, whatever its
  // length. The floor then catches only the residue — a short string this
  // corpus does not recognise, which is a placeholder, not a judgement.
  for (const p of ABSENCE_PATTERNS) {
    const m = text.match(p.rx);
    if (m) return { kind: "absence", matched: p.id, note: p.note, span: m[0] };
  }
  const bare = text.toLowerCase().replace(/[\s.!]+$/, "");
  if (PLACEHOLDER_VALUES.has(bare)) {
    return {
      kind: "missing",
      why: `\`regression_rebuttal\` is the placeholder "${text}" — name what you SAW and WHEN, or leave the status alone`,
    };
  }
  if (text.length < MIN_REBUTTAL_CHARS) {
    return {
      kind: "missing",
      why:
        `\`regression_rebuttal\` is ${text.length} characters ("${text}") — too short to name an observation. ` +
        `Name what you SAW and WHEN.`,
    };
  }
  return { kind: "observation" };
}

// ── manifest / declared-source resolution ───────────────────────────────────
//
// THE KEY THE GUARD FIRES ON. The originating issue is explicit that this hook is
// portable "only where a tracker-source convention exists to key on" — without one
// there is nothing to fire on, and installing it anyway yields a guard that
// protects nothing. `burndown-manifest.json` IS that convention: it DECLARES which
// files are registers, so a repo without one pays a single `existsSync`.

function findManifest(repo) {
  const abs = path.join(repo, "burndown-manifest.json");
  try {
    if (!fs.existsSync(abs)) return null;
    const m = JSON.parse(fs.readFileSync(abs, "utf8"));
    if (m && m._schema === "burndown-manifest/v1" && Array.isArray(m.sources)) return m;
    return null;
  } catch {
    return null;
  }
}

function declaredRegisters(manifest) {
  const out = new Set();
  if (!manifest) return out;
  for (const s of manifest.sources || []) {
    if (s && s.kind === "register" && typeof s.path === "string") {
      out.add(s.path.replace(/\\/g, "/").replace(/^\.\//, ""));
    }
  }
  return out;
}

/**
 * Is `rel` a declared register?
 *
 * CASE-INSENSITIVE FILESYSTEMS ARE THE REASON THIS IS NOT A PLAIN `Set.has`.
 * On macOS and Windows `burndown/Register.json` and `burndown/register.json` are
 * the SAME FILE, but an exact-match lookup saw only the declared spelling — so a
 * write addressed with different casing landed on the real register with the
 * guard never firing. This repo has been burned by this class before
 * (`burndown-build.mjs` documents rejecting `--error-unmatch` for it).
 *
 * The case-insensitive fallback is CONFIRMED by `realpath`, so on a genuinely
 * case-SENSITIVE filesystem — where the two names are different files — a
 * same-spelling-different-case path is NOT treated as the register.
 */
function isDeclaredRegister(manifest, rel, repo) {
  const want = String(rel).replace(/\\/g, "/").replace(/^\.\//, "");
  const set = declaredRegisters(manifest);
  if (set.has(want)) return true;
  if (!repo) return false;
  const lower = want.toLowerCase();
  for (const declared of set) {
    if (declared.toLowerCase() !== lower) continue;
    try {
      if (fs.realpathSync(path.join(repo, declared)) === fs.realpathSync(path.join(repo, want))) return true;
    } catch {
      /* one side does not exist — not the same file */
    }
  }
  return false;
}

// ── the recorded (HEAD) side ────────────────────────────────────────────────

function headBlob(repo, rel) {
  try {
    // execFileSync with an argv array: no shell, so no metacharacter
    // interpretation, and the `HEAD:` prefix makes a leading-dash argument
    // injection unreachable. `rel` is manifest-controlled before we get here.
    // `HEAD:./<rel>` is CWD-RELATIVE; the bare `HEAD:<rel>` form resolves against
    // the worktree TOP. In a repo where the project directory is NOT the git root
    // the bare form fails on every lookup, degrading a `block`-carrying guard to
    // permanent UNKNOWN for that whole deployment shape. Git's own hint names this
    // form. Measured: bare → "fatal: path 'proj/…' exists, but not '…'"; `./` → the
    // blob. Harmless when the project dir IS the root, which is loom's own case —
    // so the bug was invisible here and would only have shown up downstream.
    const out = execFileSync(resolveGitBinary(), ["show", `HEAD:./${rel}`], {
      cwd: repo,
      env: gitEnv(),
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return typeof out === "string" ? out : null;
  } catch {
    return null; // not committed, no git, detached, timeout — all UNKNOWN
  }
}

function parseRegister(text) {
  if (typeof text !== "string" || text.length > MAX_BYTES) return null;
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.items)) return null;
  const byId = new Map();
  for (const it of doc.items) {
    if (it && typeof it === "object" && typeof it.id === "string") byId.set(it.id, it);
  }
  return { doc, byId };
}

// ── GUARD A ─────────────────────────────────────────────────────────────────

function severityFor(kind) {
  return kind === "missing" ? "block" : "halt-and-report";
}

function guardA(oldReg, newReg) {
  const findings = [];
  const mapOf = (k) => (newReg.doc && typeof newReg.doc[k] === "object" && newReg.doc[k] !== null ? newReg.doc[k] : {});
  const renamed = mapOf("_renamed");

  // A row's OLD counterpart, honouring a declared renumber. Without this the
  // shifted row is compared against whatever USED to hold its new id — so
  // renumbering `R3`→`R2` compared old-R2's status to old-R3's and reported a
  // demotion that never happened.
  const oldCounterpart = (newId) => {
    const from = renamed[newId];
    if (typeof from === "string" && oldReg.byId.has(from)) return oldReg.byId.get(from);
    return oldReg.byId.get(newId);
  };

  // A-1 / A-2 · the DEMOTION, and A-4 · the RETIREMENT of a delivered row.
  for (const [id, newItem] of newReg.byId) {
    const oldItem = oldCounterpart(id);
    if (!oldItem) continue; // a NEW row has no recorded status to contradict

    const oldRank = rankOf(oldItem.status);
    const newRank = rankOf(newItem.status);

    // A-5 · a status OUTSIDE the closed vocabulary is surfaced, never skipped.
    // It used to `continue` silently, which was step 1 of the invisible-character
    // chain: park the row on `"Signed­off"` (rank null, silent), commit, then
    // demote from a rank the guard can no longer read. The generator refuses such
    // a status at exit 2, so this arm does not BLOCK — it says so and moves on.
    //
    // SCOPED TO WHAT THIS WRITE INTRODUCES, for the same reason B-0 is. Firing on
    // every unreadable row on every write means one annotated or legacy status
    // halts the guard forever with nothing the writer can do about it in that
    // write — the cry-wolf mode that ends with the guard being ignored.
    if (oldRank === null || newRank === null) {
      if (normStatus(oldItem.status) === normStatus(newItem.status)) continue; // pre-existing, untouched
      const bad = newRank === null ? newItem.status : oldItem.status;
      findings.push({
        guard: "A-5",
        severity: "halt-and-report",
        id,
        reason:
          `status ${JSON.stringify(String(bad))} is outside the closed vocabulary, so the delivered-bucket ` +
          `ladder cannot read it. burndown-build.mjs will refuse this source (exit 2). Use one of: ` +
          `Signed off, Built-not-walked, In progress, Not started, Blocked on you.`,
      });
      continue;
    }

    const wasSuperseded = isSupersededRow(oldItem);

    // A-4 · RETIRING a delivered row is a retraction in its own right.
    //
    // This closes the chain the scope exclusion would otherwise open. The
    // exclusion protects a genuine REINSTATEMENT by reading the HEAD row — but
    // that let an agent ADD a marker to a delivered row in one (silent) write,
    // commit it, and demote in the next write fully excluded. Every surface was
    // quiet for step 1. Now step 1 is the finding, and the reinstatement case is
    // untouched because there the marker was ALREADY at HEAD.
    if (!wasSuperseded && oldRank >= DELIVERED_MIN_RANK) {
      // RETIREMENT fields only, not the wider scope set: `internal` is a
      // visibility flag, and blocking on it refused an operator merely marking a
      // delivered row unreportable.
      const added = retirementFieldsSet(newItem);
      if (added.length > 0) {
        const verdict = classifyRebuttal(newItem.regression_rebuttal);
        if (verdict.kind !== "observation") {
          findings.push({
            guard: "A-4",
            severity: severityFor(verdict.kind),
            id,
            from: oldItem.status,
            to: `${newItem.status} + ${added.join("/")}`,
            reason:
              `retires a row recorded as '${oldItem.status}' by adding ${added.map((f) => `\`${f}\``).join("/")} — ` +
              (verdict.kind === "missing" ? verdict.why : `\`regression_rebuttal\` states an ABSENCE: ${verdict.note}`),
            span: verdict.span || null,
          });
        }
      }
    }

    // SCOPE: the measured false positive. A row that ALREADY declared itself
    // retired at HEAD is out — reinstating it is an owner's call, not a demotion.
    if (wasSuperseded) continue;
    if (oldRank < DELIVERED_MIN_RANK) continue; // no delivery claim to retract
    if (newRank >= oldRank) continue; // same or promoted

    const verdict = classifyRebuttal(newItem.regression_rebuttal);
    if (verdict.kind === "observation") continue;

    findings.push({
      guard: verdict.kind === "missing" ? "A-2" : "A-1",
      severity: severityFor(verdict.kind),
      id,
      from: oldItem.status,
      to: newItem.status,
      reason:
        verdict.kind === "missing"
          ? verdict.why
          : `\`regression_rebuttal\` states an ABSENCE (${verdict.matched}): ${verdict.note}`,
      span: verdict.span || null,
    });
  }

  // A-3 · a delivered id that VANISHED.
  //
  // THE CHEAPEST EXIT, and it was completely open: rename `F80` to `F80-r2` and
  // the old id simply has no counterpart, while the new one looks BRAND NEW and a
  // new row has nothing to contradict. The row leaves `Signed off`, the
  // denominator is unchanged, and every downstream count moves — which is the
  // exact observable Guard A exists to make expensive.
  //
  // The generator does NOT cover this. Its unknown-id refusal lives under
  // `kind: "status-refresh"`, and this repo declares only a `kind: "register"`,
  // so nothing anywhere compared the id SET against HEAD.
  //
  // The rebuttal has nowhere to live on a row that is gone, so it is read from a
  // top-level `_removed` map keyed by the departed id — the same classifier, the
  // same severity split.
  const removedRebuttals = mapOf("_removed");
  // `_renamed: { "<new id>": "<old id>" }` — the IDENTITY-PRESERVING exit.
  //
  // A-3 cannot tell a RENAME from a RENUMBER at the id-set level, and a renumber
  // regresses nothing. Without this map the honest operator had no move: `_removed`
  // asks "what did you observe" about a row that was never withdrawn, and putting a
  // `regression_rebuttal` on the shifted row asserts an observation that did not
  // happen. Either they lie to the guard or they abandon renumbering.
  //
  // So renumbering declares itself STRUCTURALLY — a mapping, no prose, nothing to
  // classify. The old id is still accounted for; only its label moved, and the
  // demotion loop above compares the row against its DECLARED predecessor.
  const renamedFrom = new Set(
    Object.entries(renamed)
      .filter(([to, from]) => typeof from === "string" && newReg.byId.has(to))
      .map(([, from]) => from),
  );

  for (const [id, oldItem] of oldReg.byId) {
    if (newReg.byId.has(id)) continue;
    if (renamedFrom.has(id)) continue; // carried forward under a new id
    if (isSupersededRow(oldItem)) continue; // a retired row may be tidied away
    if (!isDelivered(oldItem.status)) continue;

    const verdict = classifyRebuttal(removedRebuttals[id]);
    if (verdict.kind === "observation") continue;

    findings.push({
      guard: "A-3",
      severity: severityFor(verdict.kind),
      id,
      from: oldItem.status,
      to: "(row no longer present)",
      reason:
        `a row recorded as '${oldItem.status}' is GONE from this write (removed, or its id changed) — ` +
        (verdict.kind === "missing"
          ? `no rebuttal for it. If the ask was WITHDRAWN, record what you observed: ` +
            `\`"_removed": { "${id}": "<what you observed>" }\`. If the id merely CHANGED (a renumber), ` +
            `declare it instead: \`"_renamed": { "<new id>": "${id}" }\` — no prose needed. Or keep the id.`
          : `its \`_removed\` entry states an ABSENCE: ${verdict.note}`),
      span: verdict.span || null,
    });
  }

  return findings;
}

// ── GUARD B ─────────────────────────────────────────────────────────────────
//
// SCOPE, and why it is asymmetric.
//
// B-1/B-2 scan EVERY owed row in the new content, changed or not. That is the
// only scope reaching the originating incident: the stale row was never touched.
// It went stale because the WORLD moved — the draft it pointed at was superseded —
// so a changed-rows-only guard would never look at it again.
//
// B-0 (an owed row naming NO ask) fires ONLY on a row TRANSITIONING into the owed
// bucket. A pre-existing corpus predates the convention, and re-litigating all of
// it on every unrelated write is the guard that cries wolf until it is ignored.

/**
 * Resolve a candidate path against the repo root through the SAME resolver, per
 * `security.md` § Path Containment.
 *
 * The first revision compared a LEXICALLY-resolved candidate against a lexical
 * root with `startsWith`, then `statSync`/`readFileSync` FOLLOWED symlinks — the
 * exact class that MUST names: a symlink at a lexically-contained path whose
 * target escapes the boundary passed the string check and was then read.
 * `SUPERSESSION_MARKER_RX`'s match is echoed into the finding, making it a weak
 * read oracle, and B-1's verdict an existence oracle.
 *
 * Both sides now go through `realpathSync` and the comparison is on the canonical
 * forms. Resolution failure is CLOSED (null), never assumed contained. This does
 * not by itself defeat a check-to-use TOCTOU — that needs enforcement at the sink —
 * and the MUST is explicit that the resolve is necessary, not sufficient.
 */
function resolveContained(repo, ref) {
  let root;
  try {
    root = fs.realpathSync(path.resolve(repo));
  } catch {
    return null;
  }
  const candidate = path.resolve(root, ref.replace(/^\.\//, ""));
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    // Does not resolve. Distinguish "inside the tree but absent" (a genuine B-1)
    // from "escapes the tree" using the LEXICAL form, which is sound for the
    // ABSENT case because there is no link to follow.
    return candidate === root || candidate.startsWith(root + path.sep) ? { real: null, contained: true } : null;
  }
  if (real !== root && !real.startsWith(root + path.sep)) return null; // escapes — not ours to grade
  return { real, contained: true };
}

function guardB(oldReg, newReg, repo) {
  const findings = [];
  let budget = MAX_ASK_REFS;

  for (const [id, newItem] of newReg.byId) {
    if (!isOwed(newItem.status)) continue;

    // The exclusion reads the OLD row. Reading the NEW one let a single write add
    // `"internal": "x"` alongside a dead `ask_ref` and skip Guard B entirely.
    const oldItem = oldReg.byId.get(id);
    if (oldItem && isSupersededRow(oldItem)) continue;
    if (!oldItem && isSupersededRow(newItem)) continue; // a brand-new row born retired

    const ref = typeof newItem.ask_ref === "string" ? newItem.ask_ref.trim() : "";
    if (ref === "") {
      const transitioning = !oldItem || !isOwed(oldItem.status);
      if (transitioning) {
        findings.push({
          guard: "B-0",
          severity: "halt-and-report",
          id,
          reason:
            "moves into `Blocked on you` (an owner action) while naming no `ask_ref` — " +
            "a row handed back to the owner must point at the live ask",
        });
      }
      continue;
    }

    // A non-path reference is NOT graded: "does not exist" for something that was
    // never a path is a confident wrong answer. The set is wider than it looks —
    // each of these was MEASURED producing a false B-1:
    //   `<org>/loom#1856`  GitHub shorthand
    //   `see asks/live.md (owner reply pending)`  prose containing a path
    //   `asks/live.md#L20`  a real file with a line anchor
    if (
      !/[/.]/.test(ref) || // no path punctuation at all
      /^[a-z][a-z0-9+.-]*:\/\//i.test(ref) || // a URL
      /^#\d+$/.test(ref) || // #1856
      /^[\w.-]+\/[\w.-]+#\d+$/.test(ref) || // owner/repo#1856
      /\s/.test(ref) // prose, not a path
    ) {
      continue;
    }
    if (budget-- <= 0) continue; // bounded FS work: content cannot time the hook out

    // Strip a trailing fragment or line anchor before asking the filesystem:
    // `asks/live.md#L20` and `asks/live.md:20` both name a file that EXISTS.
    const refPath = ref.replace(/[#:][\w.,-]*$/, "") || ref;
    const resolved = resolveContained(repo, refPath);
    if (resolved === null) continue; // escapes the repo, or the root will not resolve

    if (resolved.real === null) {
      findings.push({
        guard: "B-1",
        severity: "halt-and-report",
        id,
        ref,
        reason: "presents as owed but its `ask_ref` names an artifact that does not exist",
      });
      continue;
    }

    let stat;
    try {
      stat = fs.statSync(resolved.real);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_ASK_BYTES) continue;

    let text;
    try {
      text = fs.readFileSync(resolved.real, "utf8");
    } catch {
      continue; // unreadable — UNKNOWN, never a verdict
    }
    const marker = declaresSuperseded(text);
    if (marker) {
      findings.push({
        guard: "B-2",
        severity: "halt-and-report",
        id,
        ref,
        reason: `presents as owed but its \`ask_ref\` declares itself superseded ("${marker}")`,
      });
    }
  }
  return findings;
}

// ── the seam the hook and the fixtures both call ────────────────────────────

/**
 * @returns {{ran:boolean, unknown:string|null, findings:Array}}
 *   ran=false + unknown=<reason> is UNKNOWN and MUST NOT be rendered as clean.
 */
function evaluate(repo, rel, newText) {
  const manifest = findManifest(repo);
  if (!manifest) return { ran: false, unknown: null, findings: [] }; // no convention to key on
  if (!isDeclaredRegister(manifest, rel, repo)) return { ran: false, unknown: null, findings: [] };

  const newReg = parseRegister(newText);
  if (!newReg) {
    return { ran: false, unknown: `the incoming '${rel}' is not a parseable register`, findings: [] };
  }
  const oldText = headBlob(repo, rel);
  if (oldText === null) {
    return { ran: false, unknown: `no committed '${rel}' at HEAD to compare against`, findings: [] };
  }
  const oldReg = parseRegister(oldText);
  if (!oldReg) {
    return { ran: false, unknown: `the committed '${rel}' at HEAD is not a parseable register`, findings: [] };
  }

  return { ran: true, unknown: null, findings: [...guardA(oldReg, newReg), ...guardB(oldReg, newReg, repo)] };
}

function renderFindings(findings, rel) {
  const L = [];
  const a = findings.filter((f) => f.guard.startsWith("A"));
  const b = findings.filter((f) => f.guard.startsWith("B"));
  if (a.length) {
    L.push(`DELIVERY CLAIM RETRACTED in '${rel}' — ${a.length} row(s):`);
    for (const f of a) {
      L.push(`  [${f.guard}] ${f.id}: ${f.from ? `'${f.from}' → '${f.to}' — ` : ""}${f.reason}`);
    }
    L.push("");
    L.push("An ABSENCE of fresh verification is not evidence AGAINST a recorded one.");
    L.push("These are absences and are REJECTED as rebuttals:");
    L.push(
      '  "this session did not verify it" · "no lane walked it" · "I could not confirm it"\n' +
        '  "nobody has walked it" · "built, not walked" · "merged is not rendered"',
    );
    L.push("");
    L.push("A rebuttal names WHAT WAS OBSERVED that contradicts the record — a status code,");
    L.push("a missing page, a failing query, a dated walkthrough that found the thing gone.");
    L.push('Put it on the row: "regression_rebuttal": "<what you observed, and when>".');
    L.push("If you observed nothing, the recorded status stands. Leave it.");
  }
  if (b.length) {
    if (L.length) L.push("");
    L.push(`OWED ROW WITH NO LIVE ASK in '${rel}' — ${b.length} row(s):`);
    for (const f of b) L.push(`  [${f.guard}] ${f.id}${f.ref ? ` → ${f.ref}` : ""}: ${f.reason}`);
    L.push("");
    L.push("A row that still presents as owed MUST point at a live ask: an artifact that");
    L.push("exists and does not declare itself superseded. Re-point `ask_ref`, or — if the");
    L.push("ask was resolved or withdrawn — move the row off `Blocked on you`.");
  }
  return L.join("\n");
}

module.exports = {
  STATUS_RANK,
  DELIVERED_MIN_RANK,
  MIN_REBUTTAL_CHARS,
  SUPERSESSION_FIELDS,
  RETIREMENT_FIELDS,
  PLACEHOLDER_VALUES,
  ABSENCE_PATTERNS,
  normStatus,
  rankOf,
  isDelivered,
  isOwed,
  markerValueIsSet,
  supersessionFieldsSet,
  retirementFieldsSet,
  isSupersededRow,
  declaresSuperseded,
  classifyRebuttal,
  findManifest,
  declaredRegisters,
  isDeclaredRegister,
  headBlob,
  parseRegister,
  resolveContained,
  guardA,
  guardB,
  evaluate,
  renderFindings,
};
