#!/usr/bin/env node
/**
 * Audit-fixture runner for `.claude/hooks/lib/pcf-category.js` — the closed
 * literal enum backing `rules/product-completion-first.md` MUST-1 at the PR
 * surface (T5).
 *
 * Per `cc-artifacts.md` Rule 9 the fixtures ship WITH the detector, and the
 * coverage shape is ONE CASE PER SCOPE-RESTRICTION PREDICATE — not one per
 * clause. The predicates a wrong edit would silently widen or narrow are: what
 * counts as a category MARKER, what counts as a MEMBER of the enum, which of
 * the four states an unreadable body lands in, where the body actually comes
 * from on the argv, and whether the verdict is a state or a boolean.
 *
 * BIPOLAR by construction: every predicate carries BOTH an accept pole and a
 * reject pole. A fixture set that only ever asserts acceptance passes
 * identically against a validator that accepts everything, which is precisely
 * the M5-a mutation this set exists to lock out.
 *
 * Every case exercises a PURE decision function — no stdin, no spawn, no git.
 * The one filesystem-touching predicate (`--body-file`) is driven through the
 * injectable `readBodyFile` seam, so the cases cannot pass or fail by accident
 * of what happens to be on this machine's disk.
 *
 * ESTABLISHED RED (`instrument-discipline.md` MUST-2): each case's `reds_under`
 * names the mutation to `pcf-category.js` that makes it FAIL. The two mutations
 * the plan requires (M5-a permissive pattern, M5-b boolean state) were RUN and
 * their reddened sets recorded in the landing PR, each with a reach proof — a
 * fixture never shown to red is not a regression guard, and a mutation that
 * fails to red leaves two live hypotheses (vacuous case OR inert mutation).
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const lib = require(join(HERE, "..", "..", "hooks", "lib", "pcf-category.js"));

const {
  findGhSubcommand,
} = require(join(HERE, "..", "..", "hooks", "lib", "git-command-parse.js"));

const {
  PCF_CATEGORIES,
  PCF_STATES,
  isKnownCategory,
  prefilterCouldMatch,
  readCategoryFromBody,
  extractBodySpec,
  classifyPrCreate,
  formatCategoryAdvisory,
} = lib;

const CASES = [
  // ── the enum is a CLOSED LITERAL, not a shape ───────────────────────────────
  {
    predicate: "enum-is-a-frozen-literal-triple",
    name: "enum — exactly three members, frozen, in the rule's own order",
    reds_under: "PCF_CATEGORIES: add a fourth member, or build it from a template",
    run: () => ({
      members: PCF_CATEGORIES,
      frozen: Object.isFrozen(PCF_CATEGORIES),
      isArray: Array.isArray(PCF_CATEGORIES),
    }),
    expect: {
      members: ["BUG", "INVEST-NOW", "INCREMENTAL"],
      frozen: true,
      isArray: true,
    },
  },
  {
    predicate: "enum-accepts-every-member",
    name: "enum ACCEPT pole — each of the three literals is a member",
    reds_under: "isKnownCategory(): invert or narrow the membership test",
    run: () => PCF_CATEGORIES.map((c) => isKnownCategory(c)),
    expectDeep: [true, true, true],
  },
  {
    predicate: "enum-rejects-derived-finding-tag",
    name: "enum REJECT pole — the derived finding tag `F-G1-HIGH` is NOT a member (disclosure lock)",
    reds_under:
      "isKnownCategory(): replace membership with a permissive pattern (M5-a)",
    run: () => isKnownCategory("F-G1-HIGH"),
    expectDeep: false,
  },
  {
    predicate: "enum-rejects-adjacent-shapes",
    name: "enum REJECT pole — near-miss and workspace-identifier shapes are all non-members",
    reds_under:
      "isKnownCategory(): replace membership with a permissive pattern (M5-a)",
    run: () =>
      [
        "BUGS",
        "INVEST",
        "INVEST_NOW",
        "INCREMENTAL-IMPROVEMENT",
        "W3-D",
        "loom-1689",
        "",
      ].map((t) => isKnownCategory(t)),
    expectDeep: [false, false, false, false, false, false, false],
  },

  // ── the four states, and the fact that they are STATES ──────────────────────
  {
    predicate: "state-categorized-on-a-member",
    name: "state — a body declaring BUG is CATEGORIZED and names the category",
    reds_under: "readCategoryFromBody(): drop the CATEGORIZED return",
    run: () => readCategoryFromBody("## Summary\nPCF-Category: BUG\ndetail"),
    expect: { state: "CATEGORIZED", category: "BUG", observed: "BUG" },
  },
  {
    predicate: "state-uncategorized-is-its-own-state",
    name: "state — a body with NO marker is UNCATEGORIZED, a distinct state (not clean, not false)",
    reds_under:
      "readCategoryFromBody(): return `{categorized:false}` for the no-marker branch (M5-b)",
    run: () => {
      const v = readCategoryFromBody("## Summary\nno category here");
      return {
        state: v.state,
        isString: typeof v.state === "string",
        notABoolean: !Object.prototype.hasOwnProperty.call(v, "categorized"),
      };
    },
    expect: { state: "UNCATEGORIZED", isString: true, notABoolean: true },
  },
  {
    predicate: "state-invalid-on-a-non-member",
    name: "state — a marker carrying a non-member is INVALID and echoes what it saw",
    reds_under:
      "isKnownCategory(): replace membership with a permissive pattern (M5-a)",
    run: () => readCategoryFromBody("PCF-Category: F-G1-HIGH"),
    expect: { state: "INVALID", category: null, observed: "F-G1-HIGH" },
  },
  {
    predicate: "state-invalid-on-a-present-but-empty-marker",
    name: "state — a marker present with no value is INVALID, not UNCATEGORIZED",
    reds_under:
      "readCategoryFromBody(): fall through an empty capture to the no-marker branch",
    run: () => readCategoryFromBody("PCF-Category:"),
    expect: { state: "INVALID", category: null, observed: "" },
  },
  {
    predicate: "state-invalid-on-conflicting-markers",
    name: "state — two markers with different values is INVALID, never first-wins",
    reds_under:
      "readCategoryFromBody(): stop collecting matches and read only the first",
    run: () =>
      readCategoryFromBody("PCF-Category: BUG\n\nPCF-Category: INCREMENTAL"),
    expect: { state: "INVALID", category: null },
  },
  {
    predicate: "state-categorized-on-duplicate-agreeing-markers",
    name: "state ACCEPT pole — two markers AGREEING is still CATEGORIZED (the conflict test is about disagreement)",
    reds_under:
      "readCategoryFromBody(): reject on marker COUNT rather than on disagreement",
    run: () => readCategoryFromBody("PCF-Category: BUG\n\nPCF-Category: bug"),
    expect: { state: "CATEGORIZED", category: "BUG" },
  },
  {
    predicate: "state-not-verified-on-an-unreadable-body",
    name: "state — an unexpanded substitution is NOT_VERIFIED, never UNCATEGORIZED",
    reds_under: "SUBSTITUTION_RE: drop the `$(` alternative",
    run: () => readCategoryFromBody("$(cat /tmp/body.md)"),
    expect: { state: "NOT_VERIFIED", category: null },
  },
  {
    predicate: "four-states-are-mutually-distinct",
    name: "state — the four state values are four distinct strings",
    reds_under: "PCF_STATES: collapse any two states onto one value",
    run: () => new Set(Object.values(PCF_STATES)).size,
    expectDeep: 4,
  },

  // ── marker recognition: what IS and IS NOT the field ────────────────────────
  {
    predicate: "marker-accepts-the-markdown-forms-authors-write",
    name: "marker ACCEPT pole — bold (either placement), list-bullet and lowercase all read",
    reds_under: "MARKER_RE: drop the emphasis or list-bullet groups",
    run: () =>
      [
        "**PCF-Category:** incremental",
        "**PCF-Category**: BUG",
        "PCF-Category: **INVEST-NOW**",
        "- PCF-Category: BUG",
        "pcf-category: bug",
      ].map((b) => readCategoryFromBody(b).category),
    expectDeep: ["INCREMENTAL", "BUG", "INVEST-NOW", "BUG", "BUG"],
  },
  {
    predicate: "marker-rejects-an-unqualified-category-line",
    name: "marker REJECT pole — a bare `Category:` prose line is NOT the field",
    reds_under: "MARKER_RE: make the `PCF-` qualifier optional",
    run: () => readCategoryFromBody("Category: BUG").state,
    expectDeep: "UNCATEGORIZED",
  },
  {
    predicate: "marker-rejects-a-mid-line-mention",
    name: "marker REJECT pole — the field name inside prose is not a declaration",
    reds_under: "MARKER_RE: drop the `^` line anchor",
    run: () =>
      readCategoryFromBody("we discussed PCF-Category: BUG in review").state,
    expectDeep: "UNCATEGORIZED",
  },
  {
    predicate: "marker-value-stops-at-the-first-word",
    name: "marker — a trailing rationale after the category is ignored, not merged into it",
    reds_under: "firstWord(): return the whole captured remainder",
    run: () => readCategoryFromBody("PCF-Category: BUG — the gate fails closed"),
    expect: { state: "CATEGORIZED", category: "BUG" },
  },

  // ── where the body comes from on the argv ───────────────────────────────────
  {
    predicate: "body-spec-reads-both-inline-spellings",
    name: "argv — `--body x`, `-b x` and `--body=x` all resolve to the inline body",
    reds_under: "extractBodySpec(): drop the attached-form or short-flag branch",
    run: () => [
      extractBodySpec(["--body", "A"]),
      extractBodySpec(["-b", "B"]),
      extractBodySpec(["--body=C"]),
    ],
    expectDeep: [
      { kind: "inline", value: "A" },
      { kind: "inline", value: "B" },
      { kind: "inline", value: "C" },
    ],
  },
  {
    predicate: "body-spec-does-not-read-a-flag-value-as-a-flag",
    name: "argv REJECT pole — a `--title` whose VALUE is the string `--body` does not become the body",
    reds_under: "extractBodySpec(): drop the GH_PR_CREATE_VALUE_FLAGS skip",
    run: () => extractBodySpec(["--title", "--body", "--body", "real"]),
    expectDeep: { kind: "inline", value: "real" },
  },
  {
    predicate: "body-spec-marks-fill-as-derived",
    name: "argv — `--fill` derives the body from commits, so there is no text to read",
    reds_under: "extractBodySpec(): drop the --fill branch",
    run: () => extractBodySpec(["--fill"]).kind,
    expectDeep: "derived",
  },
  {
    predicate: "body-file-read-through-the-injected-seam",
    name: "argv — a readable `--body-file` is parsed like an inline body",
    reds_under: "classifyPrCreate(): stop dispatching the file branch to the reader",
    run: () =>
      classifyPrCreate("gh pr create --body-file body.md", {
        readBodyFile: () => "PCF-Category: INCREMENTAL",
      }),
    expect: { state: "CATEGORIZED", category: "INCREMENTAL" },
  },
  {
    predicate: "body-file-unreadable-fails-closed-to-not-verified",
    name: "argv REJECT pole — an unreadable `--body-file` is NOT_VERIFIED, never UNCATEGORIZED",
    reds_under: "classifyPrCreate(): treat a null reader result as an empty body",
    run: () =>
      classifyPrCreate("gh pr create --body-file body.md", {
        readBodyFile: () => null,
      }).state,
    expectDeep: "NOT_VERIFIED",
  },

  // ── applicability: the question must not be asked of the wrong command ──────
  {
    predicate: "not-applicable-on-a-non-pr-create",
    name: "applicability — a command that opens no PR returns null, not a state",
    reds_under: "classifyPrCreate(): drop the findGhSubcommand guard",
    run: () => [
      classifyPrCreate("git push"),
      classifyPrCreate("gh pr list --search create"),
      classifyPrCreate('echo "gh pr create --body x"'),
    ],
    expectDeep: [null, null, null],
  },
  {
    predicate: "applicable-through-a-shell-wrapper",
    name: "applicability ACCEPT pole — a wrapped `sh -c 'gh pr create …'` is still a PR create",
    reds_under: "classifyPrCreate(): bypass the shared parser and regex the string",
    run: () =>
      classifyPrCreate(`sh -c 'gh pr create --body "PCF-Category: BUG"'`).state,
    expectDeep: "CATEGORIZED",
  },
  {
    predicate: "not-applicable-on-a-help-invocation",
    name: "applicability REJECT pole — `--help`/`-h` creates no PR, so no verdict is owed",
    reds_under: "classifyPrCreate(): drop the GH_NON_CREATING_FLAGS guard",
    run: () => [
      classifyPrCreate("gh pr create --help"),
      classifyPrCreate("gh pr create -h"),
      classifyPrCreate("gh pr create --title t --help"),
    ],
    expectDeep: [null, null, null],
  },
  {
    predicate: "help-guard-does-not-swallow-a-real-create",
    name: "applicability ACCEPT pole — the help guard does not silence a genuine create",
    reds_under: "GH_NON_CREATING_FLAGS: widen it to match any flag, or substring-match",
    run: () =>
      classifyPrCreate(
        `gh pr create --title "help the user" --body "PCF-Category: BUG"`,
      ),
    expect: { state: "CATEGORIZED", category: "BUG" },
  },
  {
    predicate: "prefilter-is-sound-never-skips-a-real-match",
    name: "prefilter — agrees with the PARSER on every corpus command (equivalence, not a heuristic)",
    reds_under:
      "prefilterCouldMatch(): drop a conjunct, or gate on a token the parser does not require",
    run: () => {
      // The property: prefilter FALSE ⇒ the parser would not have matched. A
      // disagreement in that direction is a silently skipped PR create.
      const corpus = [
        `gh pr create --body x`,
        `sh -c 'gh pr create --body x'`,
        `git add -A && gh pr create --title t --body x`,
        `GH_TOKEN=x gh pr create --body y`,
        `/usr/local/bin/gh pr create --body y`,
        `gh --repo o/r pr create --body y`,
        `gh pr list`,
        `git push`,
        `echo create`,
        `cat > a.js <<E\nnothing\nE`,
        `gh issue create --body y`,
        `PR=1 gh pr view 3`,
        ``,
      ];
      const unsound = corpus.filter(
        (c) => !prefilterCouldMatch(c) && findGhSubcommand(c, "pr", "create") !== null,
      );
      return { unsound, checked: corpus.length };
    },
    expect: { unsound: [], checked: 13 },
  },
  {
    predicate: "prefilter-actually-rejects-the-hot-payload",
    name: "prefilter — a large heredoc payload with no gh/pr/create is rejected before the parser",
    reds_under: "prefilterCouldMatch(): return true unconditionally",
    run: () =>
      prefilterCouldMatch(
        Array(500).fill("cat > a.js <<E\n.claude/state/roster.json\nE").join("\n"),
      ),
    expectDeep: false,
  },
  {
    predicate: "title-is-not-the-body",
    name: "applicability REJECT pole — a category in the TITLE does not categorize the PR",
    reds_under: "extractBodySpec(): read --title as a body source",
    run: () =>
      classifyPrCreate(
        'gh pr create --title "PCF-Category: BUG" --body "no marker"',
      ).state,
    expectDeep: "UNCATEGORIZED",
  },

  // ── the advisory the hook renders ───────────────────────────────────────────
  {
    predicate: "advisory-is-silent-on-a-categorized-pr",
    name: "advisory — a CATEGORIZED verdict emits NOTHING (non-discrimination is what gets a hook ignored)",
    reds_under: "formatCategoryAdvisory(): drop the CATEGORIZED early return",
    run: () => formatCategoryAdvisory(readCategoryFromBody("PCF-Category: BUG")),
    expectDeep: null,
  },
  {
    predicate: "advisory-names-the-state-and-the-enum",
    name: "advisory — a non-categorized verdict names its state AND the three valid values",
    reds_under: "formatCategoryAdvisory(): drop the enum line",
    run: () => {
      const msg = formatCategoryAdvisory(readCategoryFromBody("no marker"));
      return {
        namesState: msg.includes("UNCATEGORIZED"),
        namesEnum: PCF_CATEGORIES.every((c) => msg.includes(c)),
      };
    },
    expect: { namesState: true, namesEnum: true },
  },
  {
    predicate: "advisory-sanitizes-an-echoed-token",
    name: "advisory — an echoed rejected token cannot inject a newline or open a code fence",
    reds_under: "sanitizeObserved(): drop the control-char or backtick pass",
    run: () => {
      const msg = formatCategoryAdvisory(
        readCategoryFromBody("PCF-Category: `x`evil"),
      );
      return { noBacktick: !msg.includes("`x`"), noControl: !/[\x00-\x1f]/.test(msg) };
    },
    expect: { noBacktick: true, noControl: true },
  },
];

// ── run ───────────────────────────────────────────────────────────────────────

/** Subset match on `expect` (load-bearing fields only); `expectDeep` pins the
 *  WHOLE return, which is what the array- and scalar-returning cases need. */
function matches(got, c) {
  if (Object.prototype.hasOwnProperty.call(c, "expectDeep")) {
    return JSON.stringify(got) === JSON.stringify(c.expectDeep);
  }
  const expect = c.expect;
  if (expect === null) return got === null;
  if (got === null || typeof got !== "object") return false;
  for (const [k, v] of Object.entries(expect)) {
    if (JSON.stringify(got[k]) !== JSON.stringify(v)) return false;
  }
  return true;
}

let failures = 0;
for (const c of CASES) {
  let got;
  try {
    got = c.run();
  } catch (err) {
    got = { threw: err && err.message ? err.message : String(err) };
  }
  if (matches(got, c)) {
    console.log(`PASS  [${c.predicate}] ${c.name}`);
  } else {
    failures++;
    const want = Object.prototype.hasOwnProperty.call(c, "expectDeep")
      ? c.expectDeep
      : c.expect;
    console.error(
      `FAIL  [${c.predicate}] ${c.name}\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`,
    );
  }
}

console.log(`\n${CASES.length - failures}/${CASES.length} fixtures passed`);
process.exit(failures === 0 ? 0 : 1);
