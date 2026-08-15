/**
 * pcf-category — read a Product-Completion-First category off a PR at the
 * moment the PR is created, as a CLOSED LITERAL ENUM.
 *
 * `rules/product-completion-first.md` MUST-1 requires every gate-surfaced
 * finding to be classified BUG / INVEST-NOW ISSUE / INCREMENTAL IMPROVEMENT
 * before disposition. Measured 2026-08-14, that classification was
 * UNOBSERVABLE on a PR — not merely un-enforced. The two facts, each with a
 * fired control:
 *
 *   - 0 of the last 30 PR bodies carried any `Category:` field, and 0 of the
 *     last 40 PRs carried ANY label (control: the same matcher fires on the
 *     synthetic body `Category: BUG`).
 *   - Feeding a categorized and an uncategorized `gh pr create` to the live
 *     PreToolUse Bash hook returned BYTE-IDENTICAL verdicts, 102 B each
 *     (control: `echo hello` 102 B vs `git reset --hard origin/main` 735 B on
 *     the same harness — so the harness CAN emit a different verdict; the
 *     identity was a true negative, not a broken instrument).
 *
 * WHY A BODY FIELD AND NOT A LABEL — the measurement, not a preference:
 *
 *   1. A label puts the enum in GitHub's label registry: MUTABLE remote state,
 *      readable only over the network, and therefore NOT "a literal array in
 *      code". Of the 24 labels defined on this repo none is a PCF category
 *      (`bug` is GitHub's stock "Something isn't working"; `deferred-quality`
 *      is an ISSUE-triage label that merely cites INCREMENTAL).
 *   2. A label is only observable AFTER the PR exists, via `gh pr view --json
 *      labels` — a network round-trip that is unavailable offline and cannot
 *      run at the moment of creation, which is the only moment at which the
 *      category can still be added without a second write.
 *   3. The BODY is a literal argument on the `gh pr create` command line, so it
 *      is readable locally, offline and deterministically at PreToolUse — by
 *      `git-command-parse.js::findGhSubcommand`, already hardened against
 *      quoting, nesting, `sh -c`, `eval` and command substitution.
 *   4. Nothing is displaced: there is no PR template in this repo and PR bodies
 *      use `## Section` headings, so a new field collides with no convention.
 *
 * FOUR STATES, NEVER A BOOLEAN. `categorized: false` conflates "the author
 * declared this INCREMENTAL and we read it" with "we never looked" — the same
 * conflation `open-pr-surface.js` refuses when it prints "NOT verified this
 * session" rather than "0 open PRs". A verdict here is one of:
 *
 *   CATEGORIZED   a marker was found and its value is in the literal enum
 *   UNCATEGORIZED a body was READ in full and carries no marker at all
 *   INVALID       a marker was found and its value is NOT in the enum
 *   NOT_VERIFIED  the body could not be read (substitution, unreadable file,
 *                 `--fill`, or a swallowed command) — never reported as clean
 *
 * This module makes NO trust decision and blocks nothing. Its consumer emits
 * `halt-and-report` at most: the verdict is derived from a lexical read of a
 * shell command string, which `rules/hook-output-discipline.md` MUST-2 bars
 * from carrying `severity: "block"`.
 */

const path = require("path");
const fs = require("fs");

const {
  findGhSubcommand,
} = require(path.join(__dirname, "git-command-parse.js"));

/**
 * THE closed literal enum. A literal frozen array — never a template, never a
 * derived string, never a permissive pattern.
 *
 * DISCLOSURE LOCK, and the reason `isKnownCategory` below tests MEMBERSHIP and
 * not shape. A derived label — a workspace identifier or a finding tag such as
 * `F-G1-HIGH` — is exactly what `rules/upstream-issue-hygiene.md` MUST-2 puts
 * on its denylist, and a PR body is a PUBLISHED surface. A permissive pattern
 * (`/^[A-Z0-9-]+$/` and friends) accepts every one of those tags, so the
 * closed enum is not stylistic tidiness: it is the mechanism that keeps
 * internal finding tags out of published PR bodies. The suite's M5-a mutation
 * IS that regression lock — it replaces this membership test with a permissive
 * pattern and asserts the `F-G1-HIGH` rejection test goes RED.
 *
 * Values are the SHORT forms of the three rows in
 * `rules/product-completion-first.md`'s triage table (whose long forms are
 * "INVEST-NOW ISSUE" and "INCREMENTAL IMPROVEMENT").
 */
const PCF_CATEGORIES = Object.freeze(["BUG", "INVEST-NOW", "INCREMENTAL"]);

const PCF_STATES = Object.freeze({
  CATEGORIZED: "CATEGORIZED",
  UNCATEGORIZED: "UNCATEGORIZED",
  INVALID: "INVALID",
  NOT_VERIFIED: "NOT_VERIFIED",
});

/**
 * The body field this module reads. Bold is accepted in all three placements
 * markdown authors actually produce — `**PCF-Category:**`, `**PCF-Category**:`
 * and `PCF-Category: **BUG**` — because bolding a field label is reflex, and a
 * first cut that handled only the pre-colon marker rejected a correctly
 * categorized body as INVALID with the observed token `**`. The leading `PCF-`
 * qualifier keeps the field from colliding with a prose line opening
 * "Category:".
 */
const MARKER_RE =
  /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?PCF-Category(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*(.*)$/gim;

/** Cap on a `--body-file` read. A PR body is prose; anything past this is not
 *  one, and an unbounded read inside a 5s PreToolUse hook is a hang risk. */
const BODY_FILE_MAX_BYTES = 256 * 1024;

/** Cap on how much of a rejected token is echoed back into agent context. */
const OBSERVED_MAX = 80;

/**
 * Flags whose NEXT token is a value, so that token is never mistaken for
 * another flag. Only the SEPARATED form consumes a following token; the
 * attached form (`--title=x`) is one token and needs no entry.
 */
const GH_PR_CREATE_VALUE_FLAGS = new Set([
  "-t", "--title",
  "-b", "--body",
  "-F", "--body-file",
  "-B", "--base",
  "-H", "--head",
  "-a", "--assignee",
  "-l", "--label",
  "-p", "--project",
  "-m", "--milestone",
  "-r", "--reviewer",
  "-R", "--repo",
  "-T", "--template",
]);

/**
 * Markers meaning this invocation creates NO PR, so the category question does
 * not arise. Identifying the verb is necessary but NOT sufficient — the same
 * distinction `posture-gate.js` draws with its own `GH_NON_MUTATING_FLAGS`, and
 * for the same stated reason: nagging a `--help` is the defect this guard
 * exists to prevent, merely inverted, and worse in practice because a gate that
 * fires on `--help` is a gate someone switches off. Found by a false-positive
 * sweep over a 26-command corpus, where it was the single hit.
 */
const GH_NON_CREATING_FLAGS = new Set(["--help", "-h"]);

/**
 * Substitution openers that mean the body TEXT is not present in the command
 * string. Deliberately NOT including backticks: an inline `` `code` `` span is
 * the overwhelmingly common case in this repo's PR bodies, so treating a
 * backtick as a substitution would degrade nearly every real body to
 * NOT_VERIFIED. STATED SCOPE (evidence-first-claims.md MUST-6): a body passed
 * as a BACKTICK substitution is therefore NOT detected here and reads as
 * UNCATEGORIZED. That is the safe direction — it nags for a category that may
 * already be present, rather than reporting an unread body as categorized.
 */
const SUBSTITUTION_RE = /\$\(|\$\{/;

/** Strip C0/C1 controls, neutralize backticks, collapse runs, cap length —
 *  the `open-pr-surface.js::sanitizeTitle` contract. A PR body is
 *  author-controlled text about to be rendered into agent context, so an
 *  echoed token must not be able to open a code fence or inject a new line. */
function sanitizeObserved(raw) {
  let s = String(raw == null ? "" : raw)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > OBSERVED_MAX) s = s.slice(0, OBSERVED_MAX) + "…";
  return s;
}

/**
 * Membership in the closed literal enum. THE line M5-a mutates.
 *
 * Case is normalized because case is not a semantic axis — rejecting `Bug`
 * would generate noise without buying any safety. Membership itself stays
 * EXACT: `F-G1-HIGH`.toUpperCase() is still `F-G1-HIGH`, so normalization
 * cannot widen the enum by even one value.
 */
function isKnownCategory(token) {
  return PCF_CATEGORIES.includes(token);
}

/**
 * The category token, stripped of the markdown an author leaves around it.
 *
 * Only the FIRST whitespace/punctuation-delimited word is the category (`BUG —
 * because…` declares BUG and then a rationale, which is deliberately ignored),
 * and surrounding emphasis markers are removed so `**BUG**` reads as `BUG`.
 * Neither step widens the enum: emphasis characters are not part of any
 * category name, and `F-G1-HIGH` survives both untouched.
 */
function firstWord(value) {
  const m = /^[^\s,;.—–-]+(?:-[^\s,;.—–]+)*/.exec(String(value).trim());
  return m ? m[0].replace(/^[*_]+/, "").replace(/[*_]+$/, "") : "";
}

function verdict(state, category, observed, reason) {
  return Object.freeze({ state, category, observed, reason });
}

/**
 * Read the category out of a PR body.
 *
 * @param {string|null|undefined} body raw PR body text
 * @returns {{state:string, category:string|null, observed:string|null, reason:string}}
 *
 * `observed` carries the RAW token the enum gate examined. It is the REACH
 * PROOF channel: a mutation test reads it to confirm the mutated line actually
 * saw the value under test, so a non-reddening mutation cannot be mistaken for
 * a vacuous assertion (instrument-discipline.md MUST-2b).
 */
function readCategoryFromBody(body) {
  if (typeof body !== "string") {
    return verdict(
      PCF_STATES.NOT_VERIFIED,
      null,
      null,
      "no body text was supplied to read",
    );
  }
  if (SUBSTITUTION_RE.test(body)) {
    return verdict(
      PCF_STATES.NOT_VERIFIED,
      null,
      null,
      "the body contains an unexpanded shell substitution, so its text is not present in the command",
    );
  }

  MARKER_RE.lastIndex = 0;
  const found = [];
  let m;
  while ((m = MARKER_RE.exec(body)) !== null) found.push(m[1]);

  if (found.length === 0) {
    // M5-b mutates THIS branch. It must stay a DISTINCT state: a boolean
    // `categorized: false` cannot tell "read the body, no marker" apart from
    // "never read the body", and those two demand opposite responses.
    return verdict(
      PCF_STATES.UNCATEGORIZED,
      null,
      null,
      "the body was read in full and carries no PCF-Category field",
    );
  }

  const tokens = found.map((f) => firstWord(f));
  if (found.length > 1) {
    const distinct = [...new Set(tokens.map((t) => t.toUpperCase()))];
    if (distinct.length > 1) {
      return verdict(
        PCF_STATES.INVALID,
        null,
        sanitizeObserved(tokens.join(", ")),
        `the body declares ${found.length} PCF-Category fields with conflicting values`,
      );
    }
  }

  const raw = tokens[0];
  const normalized = raw.toUpperCase();
  if (!isKnownCategory(normalized)) {
    return verdict(
      PCF_STATES.INVALID,
      null,
      sanitizeObserved(raw),
      raw === ""
        ? "the PCF-Category field is present but empty"
        : `"${sanitizeObserved(raw)}" is not one of ${PCF_CATEGORIES.join(" | ")}`,
    );
  }
  return verdict(
    PCF_STATES.CATEGORIZED,
    normalized,
    sanitizeObserved(raw),
    `the body declares PCF-Category: ${normalized}`,
  );
}

/**
 * Locate the body a `gh pr create` argv will send.
 *
 * @returns {{kind:"inline"|"file"|"derived"|"absent", value:string|null}}
 */
function extractBodySpec(argv) {
  if (!Array.isArray(argv)) return { kind: "absent", value: null };
  let derived = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (typeof t !== "string") continue;
    if (t === "--") break;
    if (t === "--body" || t === "-b") return { kind: "inline", value: argv[i + 1] ?? "" };
    if (t.startsWith("--body=")) return { kind: "inline", value: t.slice(7) };
    if (t === "--body-file" || t === "-F") return { kind: "file", value: argv[i + 1] ?? "" };
    if (t.startsWith("--body-file=")) return { kind: "file", value: t.slice(12) };
    // `--fill`, `--fill-first`, `--fill-verbose` derive the body from commit
    // messages, so no body text exists in the command to read.
    if (t === "--fill" || t === "--fill-first" || t === "--fill-verbose") derived = true;
    if (GH_PR_CREATE_VALUE_FLAGS.has(t)) i++; // skip the value, never read it as a flag
  }
  return derived ? { kind: "derived", value: null } : { kind: "absent", value: null };
}

/**
 * Read a `--body-file` from disk, CONTAINED to the repo and bounded in size.
 *
 * Per `rules/security.md` § Path Containment, candidate AND boundary root are
 * resolved through the SAME resolver before the comparison, and the read fails
 * CLOSED (returns null → NOT_VERIFIED) if anything will not resolve. Scoped
 * honestly: containment here bounds which files this HOOK will open; it is not
 * a defense of the subsequent `gh` invocation, which opens whatever path it was
 * given regardless of what this returns.
 */
function readBodyFileContained(filePath, repoRoot) {
  try {
    if (typeof filePath !== "string" || filePath === "") return null;
    const root = fs.realpathSync(repoRoot);
    const candidate = fs.realpathSync(path.resolve(root, filePath));
    if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
    const st = fs.statSync(candidate);
    if (!st.isFile() || st.size > BODY_FILE_MAX_BYTES) return null;
    return fs.readFileSync(candidate, "utf8");
  } catch {
    // Fails CLOSED by design: an unreadable body yields NOT_VERIFIED at the
    // caller, never a clean or an uncategorized verdict. This is the one place
    // a swallowed error is correct — the ABSENCE of a return value IS the
    // signal, and it is reported, not discarded (zero-tolerance.md Rule 3).
    return null;
  }
}

/**
 * Cheap, SOUND pre-filter for the expensive parse.
 *
 * `parseGhInvocations` strips comments, segments the whole command, and expands
 * nested command bodies to depth 8. That is fine on a command line and costly on
 * a large payload — and this runs on EVERY Bash call, not just PR creates.
 * MEASURED on the H2-DOS-BOUNDED complexity-ratio case (20,000 heredocs): calling
 * the parser unconditionally moved work(2H)/work(H) from 1.93 to 2.92 against a
 * bound of 3, i.e. it consumed most of the remaining headroom on a guard whose
 * whole point is to stay linear. CI reddened on it; this repo's own machine did
 * not, which is exactly why the ratio (not a millisecond budget) is the instrument.
 *
 * SOUNDNESS — this cannot skip a command the parser would have matched.
 * `findGhSubcommand(cmd,"pr","create")` returns non-null ONLY when an invocation's
 * parsed positional words are literally `pr` and `create` (lowercased) and the
 * command token is `gh`. Those words come from TOKENS OF THIS STRING, so all
 * three substrings must be present for a match to be possible. The unresolvable
 * pseudo-invocation `parseGhInvocations` appends carries `group:null, sub:null`
 * and so never satisfies that predicate either. Absence of any one substring is
 * therefore a proof of no-match, not a heuristic — which is why this is a fence
 * and not a guess. Pinned by `prefilterCouldMatch`'s own test.
 */
function prefilterCouldMatch(command) {
  const s = String(command || "").toLowerCase();
  return s.includes("gh") && s.includes("pr") && s.includes("create");
}

/**
 * Classify the PR a `gh pr create` command is about to open.
 *
 * @param {string} command the raw Bash command string
 * @param {{repoRoot?:string, readBodyFile?:(p:string)=>string|null}} [opts]
 * @returns {object|null} a verdict, or null when the command opens no PR
 *   (NOT a state — the question does not arise, so no answer is reported)
 */
function classifyPrCreate(command, opts = {}) {
  if (!prefilterCouldMatch(command)) return null;
  const gh = findGhSubcommand(String(command || ""), "pr", "create");
  if (!gh) return null;

  // `gh pr create --help` prints usage and creates nothing, so there is no PR
  // to categorize. Returns null (not applicable) rather than NOT_VERIFIED: the
  // latter would be a true statement about the body and a false implication
  // about the PR. Checked BEFORE the unresolvable branch, since `--help` short
  // -circuits gh itself regardless of what else is on the line.
  if (Array.isArray(gh.argv) && gh.argv.some((t) => GH_NON_CREATING_FLAGS.has(t))) {
    return null;
  }

  if (gh.unresolvable) {
    return verdict(
      PCF_STATES.NOT_VERIFIED,
      null,
      null,
      `a shell substitution swallowed the ${gh.unresolvable} position, so the invocation could not be read`,
    );
  }

  const spec = extractBodySpec(gh.argv);
  if (spec.kind === "inline") return readCategoryFromBody(spec.value);
  if (spec.kind === "derived") {
    return verdict(
      PCF_STATES.NOT_VERIFIED,
      null,
      null,
      "the body is derived from commit messages (--fill), so no body text exists in the command to read",
    );
  }
  if (spec.kind === "absent") {
    return verdict(
      PCF_STATES.NOT_VERIFIED,
      null,
      null,
      "the command passes no --body or --body-file, so the body will be authored outside this command",
    );
  }

  const reader =
    typeof opts.readBodyFile === "function"
      ? opts.readBodyFile
      : (p) => readBodyFileContained(p, opts.repoRoot || process.cwd());
  const text = reader(spec.value);
  if (typeof text !== "string") {
    return verdict(
      PCF_STATES.NOT_VERIFIED,
      null,
      null,
      `--body-file ${sanitizeObserved(spec.value)} could not be read inside the repository`,
    );
  }
  return readCategoryFromBody(text);
}

/**
 * The agent-visible advisory for a verdict, or null when nothing is owed.
 * CATEGORIZED is silent: a hook that speaks on every PR is a hook that gets
 * ignored, which is the non-discrimination failure mode, not a frequency one.
 */
function formatCategoryAdvisory(v) {
  if (!v || v.state === PCF_STATES.CATEGORIZED) return null;
  const enumLine = `Valid values, exactly: ${PCF_CATEGORIES.join(" | ")} (a closed enum — a derived label such as a workspace id or a finding tag is REJECTED, and would breach upstream-issue-hygiene.md MUST-2 on a published surface).`;
  const add = `Add a \`PCF-Category: <value>\` line to the PR body. ${enumLine}`;
  if (v.state === PCF_STATES.UNCATEGORIZED) {
    return `PR category UNCATEGORIZED — ${v.reason}. ${add}`;
  }
  if (v.state === PCF_STATES.INVALID) {
    return `PR category INVALID — ${v.reason}. ${add}`;
  }
  return `PR category NOT VERIFIED — ${v.reason}. This is NOT a clean read: the category is UNKNOWN, not absent. ${add}`;
}

module.exports = {
  PCF_CATEGORIES,
  PCF_STATES,
  BODY_FILE_MAX_BYTES,
  isKnownCategory,
  prefilterCouldMatch,
  readCategoryFromBody,
  extractBodySpec,
  readBodyFileContained,
  classifyPrCreate,
  formatCategoryAdvisory,
};
