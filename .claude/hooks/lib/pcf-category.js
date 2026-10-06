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
 * EVERY VERDICT NAMES ITS CAUSE (loom#1803). The four states above answer WHAT
 * the guard concluded; until 2026-08-19 nothing answered WHY, and NOT_VERIFIED
 * — which is the instrument-failure state, not a finding — collapsed at least
 * eight structurally different situations onto one sentence. Measured cost:
 * three separate sessions each re-diagnosed the same refusal from scratch, and
 * two of the three landed on a WRONG cause (a worktree-resolution story and a
 * directory-deletion story, both refuted later on this same issue) because the
 * message carried no information to discriminate with. Every verdict therefore
 * carries:
 *
 *   cause   a stable code from PCF_CAUSES — the failure IDENTITY, which is what
 *           a regression test can pin. "It refused" is not an identity.
 *   source  where the body came from: inline | file | derived | absent | command
 *   detail  the concrete facts (the path tried, the ROOT it was resolved
 *           against, the resolved target, the errno, the offending token and
 *           its line) — sanitized, because a `--body-file` value is
 *           author-controlled text about to enter agent context.
 *
 * FAIL DIRECTION IS UNCHANGED, and naming a cause must never become a route to
 * passing (`zero-tolerance.md` Rule 3). Every situation that refused before
 * still refuses, with the identical `state`; only the prose and the three new
 * fields differ. The containment decision is untouched — it is still the
 * comparison of two fully-resolved canonical paths — and the taxonomy adds only
 * a diagnostic ancestor walk on the FAILURE path, whose worst case is a less
 * specific message. `readBodyFileDiagnosed`'s header records the first cut that
 * got this wrong and how the fixtures caught it.
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
  resolveCdTrailDir,
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
 * THE CAUSE TAXONOMY — why a verdict is what it is.
 *
 * ONE CODE PER DISTINCT FIX. That is the membership rule, and it is the reason
 * this is not a two-value "readable / unreadable" split: an operator whose file
 * sits outside the containment root must move the file (or open the PR from the
 * root the hook resolves against); one whose file is written by an EARLIER
 * SEGMENT OF THE SAME command line must split the write into its own tool call;
 * one whose body carries `$(` must reword it. Those are three unrelated
 * remedies, and a message that cannot tell them apart sends every operator down
 * the first one.
 *
 * The NOT_VERIFIED codes are INSTRUMENT FAILURES, not findings about the PR —
 * `instrument-discipline.md` MUST-1's distinction, applied to this guard's own
 * output. In all three loom#1803 instances the published PR body carried a
 * correct category; what failed was the read. UNCATEGORIZED (`MARKER_ABSENT`)
 * is the only code in this table that is a statement about the PR itself.
 */
const PCF_CAUSES = Object.freeze({
  // ── the body WAS read; these are findings about the PR ────────────────────
  CATEGORY_DECLARED: "CATEGORY_DECLARED",
  MARKER_ABSENT: "MARKER_ABSENT",
  VALUE_NOT_IN_ENUM: "VALUE_NOT_IN_ENUM",
  VALUE_EMPTY: "VALUE_EMPTY",
  MARKERS_CONFLICT: "MARKERS_CONFLICT",

  // ── the body was NOT read; these are instrument failures ──────────────────
  /** the body text carries `$(` / `${`, so it may not reach `gh` verbatim */
  BODY_SUBSTITUTION: "BODY_SUBSTITUTION",
  /** a substitution swallowed an argv position, so the invocation is unreadable */
  COMMAND_UNRESOLVABLE: "COMMAND_UNRESOLVABLE",
  /** `--fill*` derives the body from commit messages; no text exists to read */
  BODY_DERIVED: "BODY_DERIVED",
  /** neither `--body` nor `--body-file` is present on the command */
  BODY_ABSENT: "BODY_ABSENT",
  /** internal: a non-string reached the body reader */
  BODY_TEXT_MISSING: "BODY_TEXT_MISSING",
  /** `--body-file` was present with an empty value */
  BODY_FILE_PATH_EMPTY: "BODY_FILE_PATH_EMPTY",
  /** the path resolves outside the root this hook resolves against */
  BODY_FILE_OUTSIDE_ROOT: "BODY_FILE_OUTSIDE_ROOT",
  /** the path is inside the root but its SYMLINK TARGET escapes it */
  BODY_FILE_ESCAPES_CONTAINMENT: "BODY_FILE_ESCAPES_CONTAINMENT",
  /** nothing exists at the path at the moment the guard looks */
  BODY_FILE_MISSING: "BODY_FILE_MISSING",
  /** missing AND this same command line writes it — a PreToolUse ordering fault */
  BODY_FILE_WRITTEN_BY_THIS_COMMAND: "BODY_FILE_WRITTEN_BY_THIS_COMMAND",
  /** the path exists but this process may not read it (EACCES/EPERM/ELOOP) */
  BODY_FILE_UNREADABLE: "BODY_FILE_UNREADABLE",
  /** the path exists and is a directory / device / socket, not a regular file */
  BODY_FILE_NOT_A_FILE: "BODY_FILE_NOT_A_FILE",
  /** the file is larger than BODY_FILE_MAX_BYTES */
  BODY_FILE_TOO_LARGE: "BODY_FILE_TOO_LARGE",
  /** the containment ROOT itself would not resolve */
  ROOT_UNRESOLVABLE: "ROOT_UNRESOLVABLE",
  /** an injected reader seam returned no text and named no cause */
  BODY_FILE_UNREAD: "BODY_FILE_UNREAD",
});

/** Where the body the verdict is about came from. */
const PCF_SOURCES = Object.freeze({
  INLINE: "inline",
  FILE: "file",
  DERIVED: "derived",
  ABSENT: "absent",
  COMMAND: "command",
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

/** Cap on the DETAIL line. Wider than OBSERVED_MAX because a detail names a
 *  path AND the root it was resolved against, and truncating either would drop
 *  the very comparison the operator has to make — the whole point of loom#1803.
 *  Still capped: a `--body-file` value is author-controlled text entering agent
 *  context.
 *
 *  MEASURED at 480, not guessed: the worst realistic detail names three paths
 *  (the given value, its resolved form, the root) plus ~90 characters of prose,
 *  and each path is independently ellipsized to PATH_MAX_CHARS below, so
 *  3×110+90 = 420 fits with headroom. A first cut set this to 320 and the
 *  fixture set caught the consequence directly: with a sandbox whose name ran a
 *  few characters longer, the sentence truncated at exactly the point that
 *  dropped the ROOT — the one element the issue exists to surface. */
const DETAIL_MAX = 480;

/** Per-PATH cap inside a detail. The tail of a path (the file, its directory)
 *  and the head (which tree it is in) both carry information; the middle of a
 *  long temp or worktree path does not. Ellipsizing the MIDDLE keeps both ends
 *  and, unlike an outer truncation of the assembled sentence, cannot silently
 *  delete a later element such as the root. */
const PATH_MAX_CHARS = 110;

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

/**
 * WHERE the substitution is, not merely THAT there is one.
 *
 * The refusal is correct and stays; what was missing is the token and its
 * position, which is the whole of what an operator needs to reword it. Returns
 * null on a clean body, so the CALLER's branch is unchanged — this is a
 * strictly richer reading of the same predicate, and `SUBSTITUTION_RE` remains
 * the single definition of what counts.
 *
 * SCOPE, stated (evidence-first-claims.md MUST-6): a `source: "file"` body was
 * read from disk, and `gh` reads the same bytes, so the "text is not present in
 * the command" rationale does NOT hold there. The verdict is deliberately left
 * UNCHANGED anyway — loom#1803 is a diagnostics issue, and softening a refusal
 * is out of its envelope — but the reason string says FILE rather than
 * asserting a transmission risk that would not be true. That over-broad refusal
 * is a real residual and is reported, not silently narrowed.
 */
function locateSubstitution(text) {
  const m = SUBSTITUTION_RE.exec(String(text));
  if (!m) return null;
  const before = String(text).slice(0, m.index);
  const line = before.split("\n").length;
  const column = m.index - (before.lastIndexOf("\n") + 1) + 1;
  return {
    token: m[0],
    line,
    column,
    excerpt: sanitizeObserved(String(text).slice(m.index, m.index + 48)),
  };
}

/** Strip C0/C1 controls, neutralize backticks, collapse runs, cap length —
 *  the `open-pr-surface.js::sanitizeTitle` contract. A PR body is
 *  author-controlled text about to be rendered into agent context, so an
 *  echoed token must not be able to open a code fence or inject a new line. */
function sanitizeTo(raw, max) {
  let s = String(raw == null ? "" : raw)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max) + "…";
  return s;
}

function sanitizeObserved(raw) {
  return sanitizeTo(raw, OBSERVED_MAX);
}

/** Same neutralization as `sanitizeObserved`, wider cap. A detail is assembled
 *  from machine-derived facts AND the author-controlled `--body-file` value, so
 *  it goes through the identical control-char/backtick pass — the injection
 *  surface is the same one `open-pr-surface.js::sanitizeTitle` names. */
function sanitizeDetail(raw) {
  return sanitizeTo(raw, DETAIL_MAX);
}

/** A path short enough to sit in a detail without pushing a later element off
 *  the end, ellipsized in the MIDDLE so both ends survive. Sanitized on the way
 *  through, because a `--body-file` value is author-controlled. */
function shortPath(p) {
  const s = sanitizeTo(p, PATH_MAX_CHARS * 4);
  if (s.length <= PATH_MAX_CHARS) return s;
  const head = s.slice(0, 40);
  const tail = s.slice(-(PATH_MAX_CHARS - 43));
  return `${head}…${tail}`;
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

/**
 * @param {string} state    one of PCF_STATES
 * @param {string|null} category
 * @param {string|null} observed the RAW token the enum gate examined
 * @param {string} reason  one prose sentence, the thing a human reads
 * @param {string} cause   one of PCF_CAUSES — the STABLE failure identity
 * @param {string} source  one of PCF_SOURCES
 * @param {string|null} [detail] concrete facts (paths, roots, errno, token+line)
 */
function verdict(state, category, observed, reason, cause, source, detail) {
  return Object.freeze({
    state,
    category,
    observed,
    reason,
    cause,
    source,
    detail: detail == null ? null : sanitizeDetail(detail),
  });
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
function readCategoryFromBody(body, source = PCF_SOURCES.INLINE) {
  if (typeof body !== "string") {
    return verdict(
      PCF_STATES.NOT_VERIFIED,
      null,
      null,
      "no body text was supplied to read",
      PCF_CAUSES.BODY_TEXT_MISSING,
      source,
      null,
    );
  }
  const sub = locateSubstitution(body);
  if (sub) {
    return verdict(
      PCF_STATES.NOT_VERIFIED,
      null,
      null,
      source === PCF_SOURCES.FILE
        ? `the body FILE text contains the shell-substitution opener ${sub.token} at line ${sub.line}, which this guard does not vouch for`
        : `the INLINE body contains the unexpanded shell substitution ${sub.token} at line ${sub.line}, so its text is not present in the command`,
      PCF_CAUSES.BODY_SUBSTITUTION,
      source,
      `offending token ${sub.token} at line ${sub.line}, column ${sub.column}: ${sub.excerpt}`,
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
      PCF_CAUSES.MARKER_ABSENT,
      source,
      `${body.length} characters were read${source === PCF_SOURCES.FILE ? " from the body file" : ""}; no line matched the PCF-Category field`,
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
        PCF_CAUSES.MARKERS_CONFLICT,
        source,
        `distinct values seen: ${sanitizeObserved(distinct.join(", "))}`,
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
      raw === "" ? PCF_CAUSES.VALUE_EMPTY : PCF_CAUSES.VALUE_NOT_IN_ENUM,
      source,
      `the field was found and read; its value ${JSON.stringify(sanitizeObserved(raw))} is not a member of the closed enum`,
    );
  }
  return verdict(
    PCF_STATES.CATEGORIZED,
    normalized,
    sanitizeObserved(raw),
    `the body declares PCF-Category: ${normalized}`,
    PCF_CAUSES.CATEGORY_DECLARED,
    source,
    null,
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
  return readBodyFileDiagnosed(filePath, repoRoot).text;
}

/**
 * Does THIS command line write the path the guard could not find?
 *
 * The loom#1803 shape: `cat > b.md <<EOF … EOF && gh pr create --body-file
 * b.md && rm -f b.md`, run as ONE Bash call. This guard is PreToolUse, so it
 * sees the whole line BEFORE any segment of it runs — the file legitimately
 * does not exist yet. The refusal is right and stays; reporting it as a plain
 * "missing file" sends the operator hunting for a path that is about to be
 * perfectly correct, which is exactly the wasted-diagnosis cost this issue is
 * about. The fix here is specific and different from every other cause: write
 * the body file in its OWN tool call, then create the PR in a second one.
 *
 * DIAGNOSTIC ONLY — it refines the message on a path already known absent, and
 * can never turn a refusal into a pass. Basename matching is deliberate (the
 * redirect and the flag often spell the path differently) and its cost is a
 * mis-worded message, never a mis-verdict.
 */
function pathWrittenByCommand(command, filePath) {
  const cmd = String(command || "");
  if (!cmd) return false;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const candidates = new Set([filePath, path.basename(String(filePath || ""))]);
  for (const cand of candidates) {
    if (!cand) continue;
    // `> path`, `>> path`, `tee path`, `tee -a path`
    const re = new RegExp(
      `(?:>>?|\\btee\\b(?:\\s+-{1,2}[\\w-]+)*)\\s*["']?${esc(cand)}["']?`,
    );
    if (re.test(cmd)) return true;
  }
  return false;
}

/** Does THIS command line delete the path? Reported as an extra sentence on a
 *  MISSING verdict — the `rm -f b.md` tail of the same one-liner. */
function pathRemovedByCommand(command, filePath) {
  const cmd = String(command || "");
  if (!cmd) return false;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const cand of new Set([filePath, path.basename(String(filePath || ""))])) {
    if (!cand) continue;
    const re = new RegExp(
      `\\brm\\b(?:\\s+-{1,2}[\\w-]+)*\\s+["']?${esc(cand)}["']?`,
    );
    if (re.test(cmd)) return true;
  }
  return false;
}

/**
 * The canonical form of a path whose own `realpathSync` fails, obtained from the
 * deepest ANCESTOR that does resolve, with the unresolved tail re-appended.
 *
 * DIAGNOSTIC ONLY, and never a containment decision on its own: the tail was
 * never canonicalized, so a symlink somewhere in it is invisible here. It is
 * used in exactly one direction — to say "this path was not even AIMED inside
 * the root" — where a false NEGATIVE costs a less specific message and nothing
 * else, because the caller's next branch refuses anyway. The load-bearing test
 * remains the fully-resolved comparison in the success path.
 *
 * Walks past ANY errno, not just ENOENT: ELOOP on a self-referential symlink and
 * ENOTDIR on a path whose parent component is a regular file both need the same
 * "which side of the root was this aimed at?" answer.
 */
function canonicalizeThroughExistingAncestor(target) {
  let cur = String(target);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return null;
}

/** How far up the tree the checkout walk will look for a `.git` entry. Same
 *  bound, same reason, as `canonicalizeThroughExistingAncestor`. */
const CHECKOUT_WALK_MAX = 64;

/**
 * The CHECKOUT a directory belongs to, as a `{root, commonDir}` pair.
 *
 * `root` is the working tree's own top level; `commonDir` is the shared git
 * directory that IDENTIFIES the repository. For a normal checkout `.git` is a
 * directory and the two are `<root>` and `<root>/.git`. For a LINKED WORKTREE
 * `.git` is a FILE reading `gitdir: <main>/.git/worktrees/<name>`, and the
 * common dir is `<main>/.git` — the same value the main checkout reports. That
 * equality is the whole point: it is how two directories are shown to be two
 * views of ONE repository, using nothing but the filesystem.
 *
 * NO SUBPROCESS. This runs inside a 5s PreToolUse hook on a path that also
 * spawns git elsewhere; `git rev-parse --git-common-dir` would be the
 * authoritative answer but costs a spawn per call, and the on-disk contract read
 * here (`.git` file → `gitdir:` pointer → `commondir` sidecar) is git's own
 * published layout, not an inference about it.
 *
 * Returns null when nothing resolves — every caller treats null as "no
 * widening", so an unreadable or non-repository directory lands on the
 * pre-existing single-root containment rather than on a guess.
 */
function checkoutOf(startDir) {
  let cur;
  try {
    cur = fs.realpathSync(String(startDir));
  } catch {
    // The directory itself may not exist (an absent body file's parent). Fall
    // back to the deepest ancestor that does — the walk below still finds the
    // enclosing checkout, and a non-canonical prefix cannot survive it because
    // every returned path is realpath'd before it is used.
    cur = canonicalizeThroughExistingAncestor(String(startDir));
    if (!cur) return null;
  }
  for (let i = 0; i < CHECKOUT_WALK_MAX; i++) {
    const dotGit = path.join(cur, ".git");
    let st = null;
    try {
      st = fs.lstatSync(dotGit);
    } catch {
      st = null;
    }
    if (st) {
      try {
        if (st.isDirectory()) {
          return { root: cur, commonDir: fs.realpathSync(dotGit) };
        }
        if (st.isFile()) {
          const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(
            fs.readFileSync(dotGit, "utf8").slice(0, 4096),
          );
          if (!m) return null;
          const gitDir = fs.realpathSync(path.resolve(cur, m[1]));
          // git writes a `commondir` sidecar inside a worktree's gitdir holding
          // the (usually relative) path to the shared git directory. Read it
          // when present; fall back to the documented
          // `<common>/worktrees/<name>` layout when it is not.
          try {
            const rel = fs
              .readFileSync(path.join(gitDir, "commondir"), "utf8")
              .trim();
            if (rel) {
              return {
                root: cur,
                commonDir: fs.realpathSync(path.resolve(gitDir, rel)),
              };
            }
          } catch {
            /* fall through to the layout form */
          }
          if (path.basename(path.dirname(gitDir)) === "worktrees") {
            return {
              root: cur,
              commonDir: fs.realpathSync(path.dirname(path.dirname(gitDir))),
            };
          }
          return { root: cur, commonDir: gitDir };
        }
      } catch {
        return null;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/**
 * Read a `--body-file` from disk, CONTAINED to the repo and bounded in size —
 * and, on failure, NAME WHICH failure it was.
 *
 * @returns {{text:string|null, cause:string|null, detail:string|null}}
 *
 * Per `rules/security.md` § Path Containment, candidate AND boundary root are
 * resolved through the SAME resolver before the comparison, and the read fails
 * CLOSED (`text: null` → NOT_VERIFIED at the caller) if anything will not
 * resolve. Scoped honestly: containment here bounds which files this HOOK will
 * open; it is not a defense of the subsequent `gh` invocation, which opens
 * whatever path it was given regardless of what this returns.
 *
 * THE CONTAINMENT DECISION IS STILL MADE ON CANONICAL FORMS ONLY, and this is
 * the second cut. The FIRST cut of the loom#1803 change put a LEXICAL
 * out-of-root rejection ahead of the `realpathSync`, reasoning that it could
 * only ever narrow. It did not: on macOS the sandbox root canonicalizes from
 * `/var/folders/...` to `/private/var/folders/...`, so an absolute path handed
 * in under `/var/...` compared as OUTSIDE a root spelled `/private/var/...`,
 * and a perfectly readable in-root body file was refused. The fixture set
 * caught it — 9 red cases on the first run, all of them reporting
 * `BODY_FILE_OUTSIDE_ROOT` for situations that were nothing of the kind. A
 * symlinked path PREFIX is exactly the case a lexical comparison cannot see,
 * which is the reason `security.md` § Path Containment says to resolve BOTH
 * sides through the same resolver in the first place; the first cut re-created
 * the very bug that rule exists to prevent, inside a change whose whole subject
 * is not-mis-reporting a cause.
 *
 * So: `realpathSync` first, exactly as before. The ONLY thing the taxonomy adds
 * on a resolution FAILURE is an ancestor walk — canonicalize the deepest
 * ancestor that does resolve — used solely to answer "was this path even
 * pointing inside the root?", so an absent out-of-root path is reported
 * OUTSIDE_ROOT (actionable) instead of MISSING (a hunt for a file whose absence
 * is not the problem). It changes no verdict: every branch below still returns
 * `text: null`, hence NOT_VERIFIED.
 */
function readBodyFileDiagnosed(filePath, repoRoot, command, opts = {}) {
  const fail = (cause, detail) => ({ text: null, cause, detail });

  if (typeof filePath !== "string" || filePath === "") {
    return fail(
      PCF_CAUSES.BODY_FILE_PATH_EMPTY,
      "--body-file was present on the command with no path after it",
    );
  }

  let root;
  try {
    root = fs.realpathSync(repoRoot);
  } catch (err) {
    return fail(
      PCF_CAUSES.ROOT_UNRESOLVABLE,
      `the containment root ${shortPath(repoRoot)} could not be resolved (${err && err.code ? err.code : "unresolvable"})`,
    );
  }

  // WHERE A RELATIVE `--body-file` IS RESOLVED FROM — the loom#1990 defect.
  //
  // `repoRoot` is the hook payload's `cwd`, which is the SESSION directory. In
  // this repo's own workflow that is the MAIN CHECKOUT, while the command runs
  // in a linked worktree it reaches with a `cd <wt> &&` prefix. Resolving the
  // body file against the session directory therefore looked for it in a tree
  // the command never enters: MEASURED, every `gh pr create --body-file <rel>`
  // issued from a worktree reported NOT_VERIFIED / BODY_FILE_MISSING, which is
  // essentially every PR opened here.
  //
  // The base is now the directory the command ACTUALLY runs in, tracked by the
  // shared `resolveCdTrailDir` walk. When that walk cannot know the directory it
  // returns `known: false` and this falls back to `root` — today's behaviour,
  // hence today's NOT_VERIFIED. It never invents a root, and an unreadable body
  // can never become a "categorized" pass by this route: the base only decides
  // WHICH file is looked at, and every failure below still returns `text: null`.
  const trail =
    typeof opts.invocationDir === "string" && opts.invocationDir
      ? { dir: opts.invocationDir, known: true }
      : resolveCdTrailDir(command, root, {
          stopWhen: (seg) => !!findGhSubcommand(seg, "pr", "create"),
        });
  let base = root;
  if (trail.known && trail.dir) {
    try {
      base = fs.realpathSync(trail.dir);
    } catch {
      base = root;
    }
  }

  const target = path.resolve(base, filePath);

  // CONTAINMENT — widened from ONE root to the SESSION'S OWN REPOSITORY, and no
  // further. A body file authored in a linked worktree is not inside the main
  // checkout under any spelling, so the old single-root test rejected it as
  // OUTSIDE_ROOT even when the path given was absolute and correct — the second
  // half of the same defect, and the reason "just pass an absolute path" did not
  // help. A candidate is contained when it sits under the session root, OR under
  // the working tree of a checkout whose git COMMON DIRECTORY is the session
  // repository's own. That is an identity test on git's own on-disk layout, not
  // a relaxation to "anywhere": a path in /tmp, in another repository, or in an
  // unrelated worktree is OUTSIDE_ROOT exactly as before, and when the session
  // directory is not a git checkout at all the widening is inert.
  const sessionCheckout = checkoutOf(root);
  const under = (p, r) =>
    typeof p === "string" &&
    typeof r === "string" &&
    (p === r || p.startsWith(r + path.sep));
  const inside = (p) => {
    if (under(p, root)) return true;
    if (!sessionCheckout || typeof p !== "string") return false;
    const c = checkoutOf(path.dirname(p));
    return !!c && c.commonDir === sessionCheckout.commonDir && under(p, c.root);
  };

  let candidate;
  try {
    candidate = fs.realpathSync(target);
  } catch (err) {
    const code = err && err.code ? err.code : "UNKNOWN";
    // The path did not resolve. Was it even AIMED inside the root? Answer it on
    // the canonical form of the deepest ancestor that does resolve, never on the
    // raw string — see the header note on `/var` vs `/private/var`.
    const aim = canonicalizeThroughExistingAncestor(target);
    if (aim && !inside(aim)) {
      return fail(
        PCF_CAUSES.BODY_FILE_OUTSIDE_ROOT,
        `${shortPath(filePath)} points at ${shortPath(aim)}, which is OUTSIDE the root this guard reads against: ${shortPath(root)}`,
      );
    }
    if (code === "ENOENT") {
      if (pathWrittenByCommand(command, filePath)) {
        return fail(
          PCF_CAUSES.BODY_FILE_WRITTEN_BY_THIS_COMMAND,
          `nothing exists at ${shortPath(target)} yet, and this same command line writes that path — this guard is PreToolUse, so it runs BEFORE any segment of the command`,
        );
      }
      const removed = pathRemovedByCommand(command, filePath)
        ? " (this same command line also removes that path)"
        : "";
      return fail(
        PCF_CAUSES.BODY_FILE_MISSING,
        `nothing exists at ${shortPath(target)} at the moment this guard looked${removed}`,
      );
    }
    // EACCES / EPERM / ELOOP / ENOTDIR / anything else: the path is there in
    // some form, and this process cannot get through it.
    return fail(
      PCF_CAUSES.BODY_FILE_UNREADABLE,
      `${shortPath(target)} could not be resolved: ${code}`,
    );
  }

  // THE load-bearing containment test, on canonical forms, unchanged.
  if (!inside(candidate)) {
    const parent = canonicalizeThroughExistingAncestor(path.dirname(target));
    return inside(parent)
      ? fail(
          PCF_CAUSES.BODY_FILE_ESCAPES_CONTAINMENT,
          `${shortPath(filePath)} sits inside ${shortPath(root)} but resolves to ${shortPath(candidate)}, which escapes it — a symlink out of the tree`,
        )
      : fail(
          PCF_CAUSES.BODY_FILE_OUTSIDE_ROOT,
          `${shortPath(filePath)} resolves to ${shortPath(candidate)}, which is OUTSIDE the root this guard reads against: ${shortPath(root)}`,
        );
  }

  let st;
  try {
    st = fs.statSync(candidate);
  } catch (err) {
    return fail(
      PCF_CAUSES.BODY_FILE_UNREADABLE,
      `${shortPath(candidate)} could not be stat'ed: ${err && err.code ? err.code : "UNKNOWN"}`,
    );
  }
  if (!st.isFile()) {
    return fail(
      PCF_CAUSES.BODY_FILE_NOT_A_FILE,
      `${shortPath(candidate)} exists but is not a regular file`,
    );
  }
  if (st.size > BODY_FILE_MAX_BYTES) {
    return fail(
      PCF_CAUSES.BODY_FILE_TOO_LARGE,
      `${shortPath(candidate)} is ${st.size} bytes, over the ${BODY_FILE_MAX_BYTES}-byte read cap`,
    );
  }

  try {
    return { text: fs.readFileSync(candidate, "utf8"), cause: null, detail: null };
  } catch (err) {
    // Fails CLOSED by design: an unreadable body yields NOT_VERIFIED at the
    // caller, never a clean or an uncategorized verdict. The ABSENCE of text IS
    // the signal, and it is now reported WITH its cause rather than as a bare
    // null (zero-tolerance.md Rule 3 — no silent fallback, and no anonymous
    // one either).
    return fail(
      PCF_CAUSES.BODY_FILE_UNREADABLE,
      `${shortPath(candidate)} could not be read: ${err && err.code ? err.code : "UNKNOWN"}`,
    );
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
      PCF_CAUSES.COMMAND_UNRESOLVABLE,
      PCF_SOURCES.COMMAND,
      `the ${gh.unresolvable} position of the gh invocation is a substitution, so the argv this guard parsed is not the argv gh will receive`,
    );
  }

  const spec = extractBodySpec(gh.argv);
  if (spec.kind === "inline") {
    return readCategoryFromBody(spec.value, PCF_SOURCES.INLINE);
  }
  if (spec.kind === "derived") {
    return verdict(
      PCF_STATES.NOT_VERIFIED,
      null,
      null,
      "the body is derived from commit messages (--fill), so no body text exists in the command to read",
      PCF_CAUSES.BODY_DERIVED,
      PCF_SOURCES.DERIVED,
      "--fill / --fill-first / --fill-verbose build the body from commit messages after this guard has run",
    );
  }
  if (spec.kind === "absent") {
    return verdict(
      PCF_STATES.NOT_VERIFIED,
      null,
      null,
      "the command passes no --body or --body-file, so the body will be authored outside this command",
      PCF_CAUSES.BODY_ABSENT,
      PCF_SOURCES.ABSENT,
      "neither --body/-b nor --body-file/-F is present on the argv",
    );
  }

  // The file branch. The injected seam is honoured for tests and for consumers
  // that already own a reader; it may return a string (read succeeded) or a
  // diagnosis object. Anything else is an unread body with no cause NAMED,
  // which is still a refusal — just an anonymous one, and it says so.
  const root = opts.repoRoot || process.cwd();
  let read;
  if (typeof opts.readBodyFile === "function") {
    const r = opts.readBodyFile(spec.value);
    if (typeof r === "string") {
      read = { text: r, cause: null, detail: null };
    } else if (r && typeof r === "object" && typeof r.text === "string") {
      read = r;
    } else {
      read = {
        text: null,
        cause: (r && r.cause) || PCF_CAUSES.BODY_FILE_UNREAD,
        detail:
          (r && r.detail) ||
          "the injected body-file reader returned no text and named no cause",
      };
    }
  } else {
    read = readBodyFileDiagnosed(spec.value, root, command);
  }

  if (typeof read.text !== "string") {
    return verdict(
      PCF_STATES.NOT_VERIFIED,
      null,
      null,
      `--body-file ${sanitizeObserved(spec.value)} could not be read: ${causeSentence(read.cause)}`,
      read.cause || PCF_CAUSES.BODY_FILE_UNREAD,
      PCF_SOURCES.FILE,
      read.detail,
    );
  }
  return readCategoryFromBody(read.text, PCF_SOURCES.FILE);
}

/**
 * One short clause per cause, for the `reason` sentence. Separate from the
 * REMEDY (`formatCategoryRemediation`) on purpose: what happened and what to do
 * about it are two different questions, and the guard was previously wrong on
 * the second one for every NOT_VERIFIED — it advised re-issuing `gh pr create`,
 * which on an already-created PR opens a DUPLICATE.
 */
function causeSentence(cause) {
  switch (cause) {
    case PCF_CAUSES.BODY_FILE_PATH_EMPTY:
      return "no path followed --body-file";
    case PCF_CAUSES.BODY_FILE_OUTSIDE_ROOT:
      return "the path is OUTSIDE the root this guard reads against";
    case PCF_CAUSES.BODY_FILE_ESCAPES_CONTAINMENT:
      return "the path resolves, via a symlink, to a target outside the containment root";
    case PCF_CAUSES.BODY_FILE_MISSING:
      return "nothing exists at that path at guard time";
    case PCF_CAUSES.BODY_FILE_WRITTEN_BY_THIS_COMMAND:
      return "the file is written by an EARLIER SEGMENT of this same command, so it does not exist yet when this PreToolUse guard runs";
    case PCF_CAUSES.BODY_FILE_UNREADABLE:
      return "the path exists but this process cannot read it";
    case PCF_CAUSES.BODY_FILE_NOT_A_FILE:
      return "the path is not a regular file";
    case PCF_CAUSES.BODY_FILE_TOO_LARGE:
      return "the file is over the read cap";
    case PCF_CAUSES.ROOT_UNRESOLVABLE:
      return "the containment root itself would not resolve";
    default:
      return "the reader returned no text and named no cause";
  }
}

/**
 * The agent-visible advisory for a verdict, or null when nothing is owed.
 * CATEGORIZED is silent: a hook that speaks on every PR is a hook that gets
 * ignored, which is the non-discrimination failure mode, not a frequency one.
 */
function formatCategoryAdvisory(v) {
  if (!v || v.state === PCF_STATES.CATEGORIZED) return null;
  const enumLine = `Valid values, exactly: ${PCF_CATEGORIES.join(" | ")} (a closed enum — a derived label such as a workspace id or a finding tag is REJECTED, and would breach upstream-issue-hygiene.md MUST-2 on a published surface).`;
  const cause = v.cause ? ` [cause: ${v.cause}]` : "";
  const detail = v.detail ? ` Detail: ${v.detail}.` : "";
  const remedy = formatCategoryRemediation(v);
  if (v.state === PCF_STATES.UNCATEGORIZED) {
    return `PR category UNCATEGORIZED${cause} — ${v.reason}.${detail} ${remedy} ${enumLine}`;
  }
  if (v.state === PCF_STATES.INVALID) {
    return `PR category INVALID${cause} — ${v.reason}.${detail} ${remedy} ${enumLine}`;
  }
  return `PR category NOT VERIFIED${cause} — ${v.reason}.${detail} This is NOT a clean read: the category is UNKNOWN, not absent — the body was never seen, so nothing here is a statement about the PR. ${remedy} ${enumLine}`;
}

/**
 * The REMEDY for a verdict — keyed on the CAUSE, because the causes have
 * nothing in common but their state.
 *
 * The re-issue advice this replaces was wrong in the one direction that does
 * damage. It was written for the UNCATEGORIZED case (where the body really does
 * lack the field) and then applied to NOT_VERIFIED as well — where the body was
 * never read, the PR's published body is very often already correct, and
 * "re-issue the command" therefore means OPEN A SECOND PR for a PR that is
 * fine. A guard whose instruction has to be disregarded to avoid damage is
 * worse than one that says nothing (loom#1803).
 */
function formatCategoryRemediation(v) {
  if (!v || v.state === PCF_STATES.CATEGORIZED) return null;

  if (v.state === PCF_STATES.UNCATEGORIZED || v.state === PCF_STATES.INVALID) {
    return (
      "The body WAS read in full, so this IS a statement about the PR: give it a " +
      "`PCF-Category: <value>` line. This hook runs BEFORE the command, so if the " +
      "create has not run yet, fix the body and let it run once; if the PR already " +
      "exists, amend it with `gh pr edit <n> --body-file <path>` — never a second " +
      "`gh pr create`, which opens a duplicate."
    );
  }

  const head =
    "The body was NOT read. Do NOT re-issue `gh pr create` to 'fix' this — if the " +
    "create already ran, the PR exists and its published body may well be correct " +
    "already; re-issuing opens a DUPLICATE. Read the durable surface instead: " +
    "`gh pr view <n> --json body`, and prove the read discriminates by also " +
    "grepping a value you know is absent. Then fix the cause below so the next " +
    "create is verifiable.";

  switch (v.cause) {
    case PCF_CAUSES.BODY_FILE_OUTSIDE_ROOT:
      return `${head} CAUSE-SPECIFIC FIX: the body file is outside the root this guard resolves \`--body-file\` against (the detail above names both). Relative vs absolute is NOT the axis — the ROOT is; a file authored in a linked worktree is not inside the main checkout either way. Put the body file under the named root, or open the PR from the checkout that root belongs to.`;
    case PCF_CAUSES.BODY_FILE_ESCAPES_CONTAINMENT:
      return `${head} CAUSE-SPECIFIC FIX: the path is inside the root but is a symlink whose target is not. Pass the real in-root path.`;
    case PCF_CAUSES.BODY_FILE_WRITTEN_BY_THIS_COMMAND:
      return `${head} CAUSE-SPECIFIC FIX: this same command line writes the body file, and this guard is PreToolUse — it runs before ANY segment of the command. Write the body file in its OWN tool call, then run \`gh pr create\` in a second one.`;
    case PCF_CAUSES.BODY_FILE_MISSING:
      return `${head} CAUSE-SPECIFIC FIX: nothing existed at that path when the guard looked. Check the path, and check whether something else in the session removed it.`;
    case PCF_CAUSES.BODY_FILE_UNREADABLE:
      return `${head} CAUSE-SPECIFIC FIX: the path exists but could not be read (the errno is in the detail). Fix the permissions, or write the body somewhere readable.`;
    case PCF_CAUSES.BODY_FILE_NOT_A_FILE:
      return `${head} CAUSE-SPECIFIC FIX: the path is a directory or a device, not a regular file. Point \`--body-file\` at the file itself.`;
    case PCF_CAUSES.BODY_FILE_TOO_LARGE:
      return `${head} CAUSE-SPECIFIC FIX: the body file is over the ${BODY_FILE_MAX_BYTES}-byte read cap. A PR body is prose — shorten it, or link the long content.`;
    case PCF_CAUSES.BODY_FILE_PATH_EMPTY:
      return `${head} CAUSE-SPECIFIC FIX: \`--body-file\` carried no path. Give it one.`;
    case PCF_CAUSES.ROOT_UNRESOLVABLE:
      return `${head} CAUSE-SPECIFIC FIX: the containment root itself would not resolve, so no path could have been read. This is an environment fault, not a body fault.`;
    case PCF_CAUSES.BODY_SUBSTITUTION:
      return `${head} CAUSE-SPECIFIC FIX: the body carries a shell-substitution opener (the token and its line are in the detail). Reword it — backticks are fine, \`$(\` and \`\${\` are not — or write the body to a file inside the guard's root and pass \`--body-file\`.`;
    case PCF_CAUSES.COMMAND_UNRESOLVABLE:
      return `${head} CAUSE-SPECIFIC FIX: a substitution swallowed part of the \`gh\` invocation itself, so the argv parsed here is not the argv \`gh\` receives. Spell the invocation out literally.`;
    case PCF_CAUSES.BODY_DERIVED:
      return `${head} CAUSE-SPECIFIC FIX: \`--fill\` builds the body from commit messages after this guard has run. Pass \`--body\`/\`--body-file\` explicitly, or put the field in the commit message that \`--fill\` will use.`;
    case PCF_CAUSES.BODY_ABSENT:
      return `${head} CAUSE-SPECIFIC FIX: the command passes neither \`--body\` nor \`--body-file\`, so the body is authored outside it (an editor, or a later edit) and the category cannot be read at creation time. Pass the body on the command.`;
    default:
      return `${head} CAUSE-SPECIFIC FIX: none — the reader returned no text and named no cause, which is itself a defect in this guard's plumbing.`;
  }
}

module.exports = {
  PCF_CATEGORIES,
  PCF_STATES,
  PCF_CAUSES,
  PCF_SOURCES,
  BODY_FILE_MAX_BYTES,
  isKnownCategory,
  prefilterCouldMatch,
  locateSubstitution,
  readCategoryFromBody,
  extractBodySpec,
  readBodyFileContained,
  readBodyFileDiagnosed,
  pathWrittenByCommand,
  pathRemovedByCommand,
  classifyPrCreate,
  formatCategoryAdvisory,
  formatCategoryRemediation,
};
