#!/usr/bin/env node
// Audit fixture runner for the SIXTH census dimension in
// `.claude/bin/check-descoping.mjs` — REFERENTIAL inventory:
//
//   codeSpansIn              — the code-span boundary that scopes a citation
//   classifyCitationToken    — path / anchor / bare-basename, one class each
//   citationsInLine          — the one tokenizer both the census and the
//                              MOVED analysis run
//   extractInventory         — citation classes as SETS inside the census
//   parseAddedCitationsByFile— the MOVED evidence, attributed per file
//   isPairedDepthOf          — a citation move is scoped to THIS rule's own
//                              paired depth surface, never corpus-wide
//   evaluate                 — set-difference verdicts, and the two kinds
//                              (vanished vs relocated-to-a-surface-that-does-
//                              not-load)
//   assertExtractorFires     — the instrument's own known-answer self-control,
//                              now covering the citation half
//
// WHY THIS DIMENSION EXISTS. check-descoping censused five NORMATIVE classes
// and no REFERENTIAL one. An extraction pass rewrote 19 rules and compressed
// "registered in `.claude/test-harness/eval-manifest.json` as a probe-only
// entry (`scanner: null`)" down to "probe-only" in
// `probe-driven-verification.md`. The restatement survived; the ANCHOR did not.
// The gate returned CLEAN for the whole pass — correctly, by its own contract.
// THREE registries broke from that one pass.
//
// BIPOLAR BY CONSTRUCTION, and MANDATORILY SO (`instrument-bipolarity.md`
// MUST-1/2). Every arm is asserted in BOTH directions, and § K below is an
// EXECUTABLE POLE PAIR built from that real case: the RED pole is
// `probe-driven-verification.md`'s Detection-mechanism line as it stood before
// and after the deletion, and its expected failure IDENTITY is named (a
// `citation_descoping` finding on `citation_path` naming
// `.claude/test-harness/eval-manifest.json`) rather than merely "some finding".
// The GREEN pole is the SAME line rewritten just as heavily in the RESTORED
// direction, so the two poles differ only in whether the anchor survived — a
// check reacting to "the line changed" scores them identically and fails § K's
// verdicts-differ assertion.
//
// Every fixture is self-contained: none reads the live rule corpus, so a corpus
// edit changes the live gate but never silently rewrites what these predicates
// are asserted to do. The § K pole texts are VERBATIM committed history, pasted
// rather than fetched, for the same reason.
//
// Exits 0 when ALL fixtures pass, non-zero otherwise.
//   node .claude/audit-fixtures/citation-census/run.mjs

import {
  codeSpansIn,
  classifyCitationToken,
  citationsInLine,
  extractInventory,
  removedLines,
  parseAddedCitationsByFile,
  addedElsewhereFor,
  isMoveDestination,
  isInjectedMoveDestination,
  ruleStem,
  isPairedDepthOf,
  isInjectedPairedDepthOf,
  validateRegistry,
  evaluate,
  assertExtractorFires,
  CITATION_CLASSES,
} from "../../bin/check-descoping.mjs";

let pass = 0;
let fail = 0;

function check(name, ok, reason) {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}: ${reason}`);
  }
}

const cls = (tok) => {
  const c = classifyCitationToken(tok);
  return c ? c.cls : null;
};
const toks = (line) => citationsInLine(line).map((c) => c.token);
const clsOf = (line) => {
  const out = Object.create(null);
  for (const c of citationsInLine(line)) (out[c.cls] ||= []).push(c.token);
  return out;
};

/** Build the perRule shape `evaluate` consumes, from two rule bodies. */
function perRuleFor(path, baseText, headText, opts = {}) {
  const base = extractInventory(baseText);
  const head = extractInventory(headText);
  const deltas = Object.create(null);
  for (const c of Object.keys(base.counts)) deltas[c] = head.counts[c] - base.counts[c];
  return {
    rule: path.split("/").pop(),
    path,
    base,
    head,
    deltas,
    removed_entirely: Boolean(opts.removedEntirely),
    is_new: false,
  };
}

/** The citation half of a verdict: kind/class/member triples, sorted. */
function citationVerdict(r, { added = new Set(), injected = new Set(), entries = [] } = {}) {
  const res = evaluate([r], new Set(), entries, [], new Set(), { added, injected });
  return res.findings
    .filter((f) => String(f.kind).startsWith("citation_"))
    .flatMap((f) =>
      [...(f.unaccounted || []), ...(f.uninjected || [])].map(
        (m) => `${f.kind}|${f.class}|${m}`,
      ),
    )
    .sort();
}

// ── A. The code-span boundary ──────────────────────────────────────────────
// A citation is what the corpus WRITES as a citation: a token inside a code
// span. Both poles asserted — prose mentions are not citations, and spans are
// found where they exist.

check(
  "A01-single-backtick-span-is-found",
  codeSpansIn("see `.claude/rules/foo.md` now").join("|") === ".claude/rules/foo.md",
  "a single-backtick code span was not extracted",
);

check(
  "A02-double-backtick-span-is-found",
  codeSpansIn("see ``.claude/rules/a`b.md`` now").join("|") === ".claude/rules/a`b.md",
  "a double-backtick span (containing a backtick) was not extracted",
);

check(
  "A03-two-spans-on-one-line-both-found",
  codeSpansIn("`a.mjs` and `b.mjs`").length === 2,
  "only one of two spans on a line was extracted",
);

check(
  "A04-unspanned-path-is-NOT-a-citation",
  toks("the file .claude/rules/foo.md is relevant").length === 0,
  "a bare prose path outside any code span was censused as a citation",
);

check(
  "A05-spanned-path-IS-a-citation",
  toks("the file `.claude/rules/foo.md` is relevant").length === 1,
  "a spanned path was NOT censused as a citation",
);

check(
  "A06-unterminated-backtick-yields-no-span",
  codeSpansIn("a stray ` backtick with no partner").length === 0,
  "an unbalanced backtick produced a span, so a whole line could be swallowed",
);

check(
  "A07-in-fence-citation-contributes-nothing",
  extractInventory(["```text", "see `.claude/rules/fenced.md`", "```"].join("\n")).counts
    .citation_path === 0,
  "a citation shown inside a fenced EXAMPLE was censused as a real binding",
);

check(
  "A08-same-citation-outside-a-fence-is-counted",
  extractInventory("see `.claude/rules/fenced.md`").counts.citation_path === 1,
  "the identical citation outside a fence was NOT counted — A07 would then be vacuous",
);

// ── B. Token classification — one class per token, precedence asserted ──────

check(
  "B01-claude-rooted-path-is-citation_path",
  cls(".claude/test-harness/eval-manifest.json") === "citation_path",
  "a .claude/-rooted artifact path was not classified as citation_path",
);

check(
  "B02-relative-artifact-path-is-citation_path",
  cls("guides/rule-extracts/instrument-discipline.md") === "citation_path",
  "a corpus-relative artifact path was not classified as citation_path",
);

check(
  "B03-trailing-slash-directory-is-citation_path",
  cls(".claude/audit-fixtures/probe-driven-verification/") === "citation_path",
  "a directory citation (trailing slash) was not classified as citation_path",
);

check(
  "B04-trailing-slash-is-preserved-in-the-token",
  (classifyCitationToken(".claude/audit-fixtures/foo/") || {}).token ===
    ".claude/audit-fixtures/foo/",
  "the trailing slash was stripped, so a directory citation collides with a file citation",
);

check(
  "B05-glob-path-is-citation_path",
  cls(".claude/hooks/lib/**") === "citation_path",
  "a glob citation was not classified as citation_path",
);

check(
  "B06-brace-alternation-path-is-citation_path",
  cls(".claude/rules/{trust-posture,cc-artifacts}.md") === "citation_path",
  "a brace-alternation path (a live corpus shape) was not classified as citation_path",
);

check(
  "B07-anchor-is-citation_anchor",
  cls("sync-tier-aware.mjs::classifyFile") === "citation_anchor",
  "a file::symbol anchor was not classified as citation_anchor",
);

check(
  "B08-anchor-outranks-path",
  cls(".claude/bin/emit.mjs::getCritBaseline") === "citation_anchor",
  "a full-path anchor was classified as a path, so dropping ::symbol would not be visible",
);

check(
  "B09-bare-code-basename-is-citation_file",
  cls("ci-audit-fixtures.json") === "citation_file",
  "a bare data-file basename was not classified as citation_file",
);

check(
  "B10-bare-md-basename-is-EXCLUDED",
  cls("trust-posture.md") === null,
  "a bare sibling-rule .md basename was censused — the high-churn, low-signal half",
);

check(
  "B11-md-INSIDE-a-path-still-counts",
  cls(".claude/rules/trust-posture.md") === "citation_path",
  "the bare-.md exclusion leaked into real paths, gutting the dimension",
);

check(
  "B12-non-citation-span-content-is-null",
  cls("halt-and-report") === null && cls("scanner") === null && cls("block") === null,
  "ordinary code-span vocabulary was classified as a citation",
);

check(
  "B13-trailing-sentence-punctuation-is-stripped",
  (classifyCitationToken(".claude/rules/foo.md,") || {}).token === ".claude/rules/foo.md",
  "a trailing comma stayed in the token, so the same citation has two identities",
);

check(
  "B14-slash-token-with-no-artifact-extension-is-not-a-path",
  cls("owner/repo") === null,
  "any slash-bearing token was treated as an artifact path",
);

// ── C. A BARE BASENAME IS NEVER EQUIVALENT TO A FULL PATH ──────────────────
// This is the `orchestration-launch-ledger.md` defect: the citation was
// TRUNCATED to its basename and the anchor stopped resolving. A census that
// resolved a basename to its path would have scored the truncation CLEAN.

const truncBase = "Registered in `.claude/test-harness/ci-audit-fixtures.json` as a runner.";
const truncHead = "Registered in `ci-audit-fixtures.json` as a runner.";

check(
  "C01-path-and-basename-are-DIFFERENT-classes",
  cls(".claude/test-harness/ci-audit-fixtures.json") === "citation_path" &&
    cls("ci-audit-fixtures.json") === "citation_file",
  "a basename and its full path landed in the same class, where they could cancel",
);

check(
  "C02-truncation-to-a-basename-REDS",
  citationVerdict(perRuleFor(".claude/rules/x.md", truncBase, truncHead)).some((v) =>
    v.endsWith("|.claude/test-harness/ci-audit-fixtures.json"),
  ),
  "truncating a full path to its bare basename did not red — the real defect scores clean",
);

check(
  "C03-the-UNtruncated-line-is-quiet",
  citationVerdict(perRuleFor(".claude/rules/x.md", truncBase, truncBase)).length === 0,
  "an unchanged citation produced a finding — C02 would then prove nothing",
);

// ── D. SET semantics, not counts (design call 1) ────────────────────────────
// A count cannot separate "one removed, one added" from "nothing changed", and
// that exact shape occurred in the originating session.

const swapBase = "See `.claude/bin/emit.mjs` for the emitter.";
const swapHead = "See `.claude/bin/compose.mjs` for the emitter.";

check(
  "D01-one-out-one-in-leaves-the-COUNT-flat",
  extractInventory(swapBase).counts.citation_path ===
    extractInventory(swapHead).counts.citation_path,
  "the swap fixture does not actually hold the count flat, so D02 tests nothing",
);

check(
  "D02-one-out-one-in-still-REDS",
  citationVerdict(perRuleFor(".claude/rules/x.md", swapBase, swapHead)).some((v) =>
    v.endsWith("|.claude/bin/emit.mjs"),
  ),
  "a citation swapped for a different one cleared the gate because the count did not fall",
);

check(
  "D03-pure-ADDITION-is-quiet",
  citationVerdict(
    perRuleFor(".claude/rules/x.md", swapBase, `${swapBase}\nAlso \`.claude/bin/compose.mjs\`.`),
  ).length === 0,
  "adding a citation while keeping every existing one produced a finding",
);

check(
  "D04-duplicate-mentions-collapse-to-one-member",
  extractInventory("`.claude/bin/emit.mjs` and again `.claude/bin/emit.mjs`").counts
    .citation_path === 1,
  "duplicate mentions were counted as separate members, so deleting one would red",
);

check(
  "D05-dropping-ONE-of-two-duplicate-mentions-is-quiet",
  citationVerdict(
    perRuleFor(
      ".claude/rules/x.md",
      "`.claude/bin/emit.mjs` and again `.claude/bin/emit.mjs`",
      "`.claude/bin/emit.mjs` once",
    ),
  ).length === 0,
  "removing a redundant second mention of a still-present citation was reported as a loss",
);

check(
  "D06-census-arrays-are-deduped-and-sorted",
  (() => {
    const l = extractInventory("`b.json` `a.json` `b.json`").lines.citation_file;
    return l.length === 2 && l[0] === "a.json" && l[1] === "b.json";
  })(),
  "citation members are not a deduped sorted set, so removedLines is not a set difference",
);

// ── E. Dropping ::symbol from an anchor is visible ──────────────────────────

check(
  "E01-anchor-truncated-to-its-file-REDS",
  citationVerdict(
    perRuleFor(
      ".claude/rules/x.md",
      "per `.claude/bin/validate-emit.mjs::parseSelfRefAllowlist`",
      "per `.claude/bin/validate-emit.mjs`",
    ),
  ).some((v) => v.includes("citation_anchor")),
  "dropping ::symbol from an anchor was not reported — the binding silently loosened",
);

check(
  "E02-the-intact-anchor-is-quiet",
  citationVerdict(
    perRuleFor(
      ".claude/rules/x.md",
      "per `.claude/bin/validate-emit.mjs::parseSelfRefAllowlist`",
      "reworded, still per `.claude/bin/validate-emit.mjs::parseSelfRefAllowlist`",
    ),
  ).length === 0,
  "rewording a line around an intact anchor was reported as a loss",
);

// ── F. Move scoping — a citation is SHARED VOCABULARY ──────────────────────
// The corpus-wide move analysis is sound for a unique MUST line and NOT sound
// for a citation token: "some other rule added this token" is a result it
// produces whether or not THIS rule's binding moved. Measured on the real case.

check(
  "F01-ruleStem-strips-dir-and-extension",
  ruleStem(".claude/rules/probe-driven-verification.md") === "probe-driven-verification",
  "ruleStem did not reduce a rule path to its stem",
);

const pairedOk = isPairedDepthOf(".claude/rules/probe-driven-verification.md");

check(
  "F02-paired-extract-by-stem-prefix-is-in-scope",
  pairedOk(".claude/guides/rule-extracts/probe-driven-verification-examples.md"),
  "the rule's own paired extract was not recognised as its depth surface",
);

check(
  "F03-exact-stem-match-in-another-tree-is-in-scope",
  pairedOk(".claude/guides/rule-extracts/probe-driven-verification.md"),
  "the same-stem extract was not recognised as the rule's depth surface",
);

check(
  "F04-an-UNRELATED-rule-is-NOT-in-scope",
  pairedOk(".claude/rules/instrument-discipline.md") === false,
  "an unrelated sibling rule counted as this rule's depth surface — the measured defect",
);

check(
  "F05-the-rule-itself-is-NOT-a-move-destination",
  pairedOk(".claude/rules/probe-driven-verification.md") === false,
  "a within-file relocation counted as a move",
);

check(
  "F06-journal-is-never-in-scope-even-with-a-matching-stem",
  pairedOk("journal/probe-driven-verification.md") === false,
  "a journal entry counted as a depth surface, so a post-mortem paste would silence the gate",
);

check(
  "F07-injected-paired-scope-accepts-a-skill",
  isInjectedPairedDepthOf(".claude/rules/foo.md")(".claude/skills/30-claude-code-patterns/foo-depth.md"),
  "the rule's own paired SKILL was rejected as an injected destination",
);

check(
  "F08-injected-paired-scope-REJECTS-the-guides-extract",
  isInjectedPairedDepthOf(".claude/rules/foo.md")(".claude/guides/rule-extracts/foo.md") === false,
  "a guides/** extract counted as a destination that LOADS — the extract is not the loaded surface",
);

// The whole point, end-to-end: a SIBLING rule gaining the same token does not
// discharge this rule's binding, while the rule's OWN skill does.
const sharedBase = "Registered in `.claude/test-harness/eval-manifest.json`.";
const sharedHead = "Registered, probe-only.";
const sibling = new Set([".claude/test-harness/eval-manifest.json"]);

check(
  "F09-a-SIBLING-rule-gaining-the-token-does-NOT-discharge-it",
  citationVerdict(perRuleFor(".claude/rules/x.md", sharedBase, sharedHead), {
    // Deliberately EMPTY move sets: the scoped builder in main() would produce
    // exactly this for a sibling-only addition.
    added: new Set(),
    injected: new Set(),
  }).some((v) => v.startsWith("citation_descoping|")),
  "a citation deleted here was cleared because an unrelated rule happened to name it",
);

check(
  "F10-the-rules-OWN-paired-skill-DOES-discharge-it",
  citationVerdict(perRuleFor(".claude/rules/x.md", sharedBase, sharedHead), {
    added: sibling,
    injected: sibling,
  }).length === 0,
  "a verbatim move into the rule's own paired skill was still reported as a loss",
);

check(
  "F11-a-move-to-the-EXTRACT-reports-the-OTHER-kind",
  citationVerdict(perRuleFor(".claude/rules/x.md", sharedBase, sharedHead), {
    added: sibling,
    injected: new Set(),
  }).every((v) => v.startsWith("citation_descoping_to_uninjected|")),
  "a citation relocated to a non-loading surface was reported as a plain vanish, or not at all",
);

check(
  "F12-the-two-kinds-are-DISTINGUISHABLE",
  (() => {
    const vanished = citationVerdict(perRuleFor(".claude/rules/x.md", sharedBase, sharedHead));
    const relocated = citationVerdict(perRuleFor(".claude/rules/x.md", sharedBase, sharedHead), {
      added: sibling,
      injected: new Set(),
    });
    return vanished.length > 0 && relocated.length > 0 && vanished[0] !== relocated[0];
  })(),
  "vanished and moved-to-the-extract render identically, so the two remedies cannot be told apart",
);

// ── G. The MOVED analysis runs the SAME tokenizer over the diff ────────────

check(
  "G01-added-citations-are-parsed-from-the-diff",
  (() => {
    const m = parseAddedCitationsByFile(
      [
        "diff --git a/.claude/skills/x-depth.md b/.claude/skills/x-depth.md",
        "--- a/.claude/skills/x-depth.md",
        "+++ b/.claude/skills/x-depth.md",
        "+see `.claude/test-harness/eval-manifest.json` for the registration",
      ].join("\n"),
    );
    return m.get(".claude/test-harness/eval-manifest.json")?.has(".claude/skills/x-depth.md");
  })(),
  "a citation added in the diff was not attributed to the file that gained it",
);

check(
  "G02-REMOVED-diff-lines-are-not-read-as-additions",
  parseAddedCitationsByFile(
    [
      "+++ b/.claude/skills/x-depth.md",
      "-see `.claude/test-harness/eval-manifest.json`",
    ].join("\n"),
  ).size === 0,
  "a deletion line was parsed as an addition, so every removal would self-certify as a move",
);

check(
  "G03-the-+++-header-is-not-itself-tokenized",
  parseAddedCitationsByFile(
    ["+++ b/.claude/rules/foo.md", "+plain prose, no span"].join("\n"),
  ).size === 0,
  "the `+++ b/<path>` header was tokenized, so every touched file would self-discharge",
);

check(
  "G04-diff-tokenizer-and-census-tokenizer-AGREE",
  (() => {
    const line = "see `.claude/bin/emit.mjs::getCritBaseline` and `posture.json`";
    const fromCensus = new Set(extractInventory(line).lines.citation_anchor
      .concat(extractInventory(line).lines.citation_file));
    const fromDiff = new Set(parseAddedCitationsByFile(["+++ b/a.md", `+${line}`].join("\n")).keys());
    return fromCensus.size === 2 && [...fromCensus].every((t) => fromDiff.has(t));
  })(),
  "the census and the MOVED analysis disagree on what a token is, so a verbatim move reads as a deletion",
);

// ── H. Registry accounting works for citation classes ─────────────────────

const citEntryRegistry = {
  exceptions: {
    "x.md::citation_path::consolidated-anchor": {
      rule: ".claude/rules/x.md",
      class: "citation_path",
      removed: ".claude/test-harness/eval-manifest.json",
      disposition: "superseded",
      reason:
        "the registration moved to a dedicated registry and this rule now names that registry " +
        "instead; the binding is not weaker, it points at the surface that actually holds it",
      issue: "#9999",
      // Inside MAX_EXCEPTION_HORIZON_DAYS of the `todayIso` used below. A date
      // further out is refused by the horizon ceiling, which H04 exercises.
      expires: "2026-12-01",
    },
  },
};

check(
  "H01-a-citation-class-is-a-VALID-registry-class",
  validateRegistry(citEntryRegistry, "2026-09-13").errors.length === 0,
  "the registry rejected a citation class, so a declared citation removal is undeclarable",
);

check(
  "H02-a-matching-entry-ACCOUNTS-for-the-removal",
  citationVerdict(perRuleFor(".claude/rules/x.md", sharedBase, sharedHead), {
    entries: validateRegistry(citEntryRegistry, "2026-09-13").entries.map((e) => ({ ...e })),
  }).length === 0,
  "a complete, unexpired registry entry did not discharge the citation removal",
);

check(
  "H03-an-entry-for-the-WRONG-class-does-NOT-account",
  citationVerdict(perRuleFor(".claude/rules/x.md", sharedBase, sharedHead), {
    entries: validateRegistry(
      {
        exceptions: {
          k: { ...citEntryRegistry.exceptions["x.md::citation_path::consolidated-anchor"], class: "citation_file" },
        },
      },
      "2026-09-13",
    ).entries,
  }).length > 0,
  "an exception filed against a different class discharged this one — a waiver must authorise exactly one removal",
);

check(
  "H04-an-EXPIRED-entry-is-a-registry-error",
  validateRegistry(citEntryRegistry, "2031-01-01").errors.length > 0,
  "an expired citation exception was accepted, so a waiver can stand forever",
);

// ── I. Fail closed (design call 4) ─────────────────────────────────────────

check(
  "I01-every-citation-class-is-initialised-on-an-EMPTY-body",
  CITATION_CLASSES.every(
    (c) => extractInventory("").counts[c] === 0 && Array.isArray(extractInventory("").lines[c]),
  ),
  "an empty body left a citation class undefined, so a delta would be NaN and silently skipped",
);

check(
  "I02-a-rule-that-genuinely-cites-nothing-censuses-zero",
  CITATION_CLASSES.every((c) => extractInventory("# A rule\n\nNo citations here.\n").counts[c] === 0),
  "a citation-free rule did not census zero — the control for I03",
);

check(
  "I03-a-rule-that-DOES-cite-censuses-nonzero",
  extractInventory("# A rule\n\nSee `.claude/rules/foo.md`.\n").counts.citation_path === 1,
  "the extractor censused zero on a body that DOES cite — I02 would then be a dead instrument",
);

check(
  "I04-self-control-passes-on-the-real-extractor",
  assertExtractorFires().ok === true,
  "the extractor self-control failed against the shipped implementation",
);

check(
  "I05-self-control-REDS-on-a-citation-blind-extractor",
  (() => {
    // A tokenizer that silently matches nothing: every normative count is
    // correct and every citation count is zero. This is the exact shape of a
    // refactor that breaks the regex — and it must NOT read as a clean corpus.
    const blind = (text) => {
      const inv = extractInventory(text);
      for (const c of CITATION_CLASSES) {
        inv.counts[c] = 0;
        inv.lines[c] = [];
      }
      return inv;
    };
    const r = assertExtractorFires({ extract: blind });
    return r.ok === false && r.detail.some((d) => d.startsWith("citation_"));
  })(),
  "a citation-blind extractor passed the self-control, so a neutered tokenizer ships green forever",
);

check(
  "I06-self-control-REDS-on-a-fence-blind-citation-extractor",
  (() => {
    // Counts in-fence citations too. The probe's fenced example then shows up,
    // and the fence-blind control can no longer separate the two readings.
    const fenceBlind = (text) => {
      const inv = extractInventory(text);
      const extra = [];
      for (const line of String(text).split(/\r?\n/)) {
        for (const c of citationsInLine(line)) if (c.cls === "citation_path") extra.push(c.token);
      }
      const all = [...new Set(inv.lines.citation_path.concat(extra))].sort();
      inv.lines.citation_path = all;
      inv.counts.citation_path = all.length;
      return inv;
    };
    return assertExtractorFires({ extract: fenceBlind }).ok === false;
  })(),
  "an extractor counting fenced EXAMPLE citations passed the self-control",
);

// ── J. Destination fences are inherited, not re-derived ───────────────────

check(
  "J01-guides-extract-is-a-move-destination-but-does-not-LOAD",
  isMoveDestination(".claude/guides/rule-extracts/foo.md") === true &&
    isInjectedMoveDestination(".claude/guides/rule-extracts/foo.md") === false,
  "the two destination predicates collapsed, so the two citation kinds cannot be distinguished",
);

check(
  "J02-addedElsewhereFor-honours-a-scoped-destOk",
  (() => {
    const m = parseAddedCitationsByFile(
      [
        "+++ b/.claude/rules/unrelated.md",
        "+see `.claude/test-harness/eval-manifest.json`",
      ].join("\n"),
    );
    const scoped = addedElsewhereFor(m, ".claude/rules/x.md", isPairedDepthOf(".claude/rules/x.md"));
    const wide = addedElsewhereFor(m, ".claude/rules/x.md", isMoveDestination);
    return scoped.size === 0 && wide.size === 1;
  })(),
  "the scoped and corpus-wide move sets are identical, so the scoping fix is inert",
);

// ── K. THE POLE PAIR — the real case, with a named failure IDENTITY ────────
//
// `instrument-bipolarity.md` MUST-1 + MUST-2. Both poles run the IDENTICAL
// shard through the IDENTICAL pipeline and converge at their most similar
// point: the same base text, and a head that rewrites the same sentence just as
// heavily. They separate ONLY on whether
// `.claude/test-harness/eval-manifest.json` survived the rewrite.
//
// Verbatim committed history from `.claude/rules/probe-driven-verification.md`,
// pasted rather than fetched so a later corpus edit cannot rewrite what these
// poles are asserted to do.

const POLE_BASE = // the Detection-mechanism bullet BEFORE the extraction pass
  "- **Detection mechanism:** the canonical single-field roll-up of the two bullets above, per " +
  "`trust-posture.md` MUST-8 (which enumerates this literal field name; the " +
  "`**Detection (hook layer)**` / `**Detection (probe layer)**` split predates that mandate and " +
  "is retained because each half carries detail the roll-up cannot). Phase 1 — the hook-layer " +
  "`detectRegexForSemanticAssertion` (advisory) plus the gate-review probe-coverage " +
  "classification. Fixtures: `.claude/audit-fixtures/probe-driven-verification/` (this rule's " +
  "own MUST-1 bipolar set) and " +
  "`.claude/audit-fixtures/violation-patterns/detectRegexForSemanticAssertion/` (the hook " +
  "detector's set). Probes: `.claude/test-harness/probes/probe-driven-verification.probes.json` " +
  "— a bipolar MUST-1 LLM-judge suite (efficacy + no-false-positive + a meta-compliance pair), " +
  "registered in `.claude/test-harness/eval-manifest.json` as a probe-only entry " +
  "(`scanner: null`) and dispatched at gate-review via `/test-harness-probe`; it is deliberately " +
  "NOT in CI (the loom↔csq boundary keeps CI LLM-free). Its disarm-resistance + fixture-hygiene " +
  "floor is `.claude/test-harness/tests/probe-suite-integrity.test.mjs`.";

const POLE_RED = // the SAME bullet after the pass — "probe-only", anchor gone
  "- **Detection mechanism:** the canonical single-field roll-up of the two bullets above, per " +
  "`trust-posture.md` MUST-8 (the split above predates that mandate and is retained because each " +
  "half carries detail the roll-up cannot). Phase 1 — the hook-layer " +
  "`detectRegexForSemanticAssertion` (advisory) plus the gate-review probe-coverage " +
  "classification. Fixtures `.claude/audit-fixtures/probe-driven-verification/` (this rule's own " +
  "MUST-1 bipolar set) + " +
  "`.claude/audit-fixtures/violation-patterns/detectRegexForSemanticAssertion/`; probes " +
  "`.claude/test-harness/probes/probe-driven-verification.probes.json`, probe-only, dispatched " +
  "at gate-review and NOT in CI; disarm-resistance floor " +
  "`.claude/test-harness/tests/probe-suite-integrity.test.mjs`.";

const POLE_GREEN = // the restoring commit — same compression, anchor KEPT
  "- **Detection mechanism:** the canonical single-field roll-up of the two bullets above, per " +
  "`trust-posture.md` MUST-8 (the split above predates that mandate and is retained because each " +
  "half carries detail the roll-up cannot). Phase 1 — the hook-layer " +
  "`detectRegexForSemanticAssertion` (advisory) plus the gate-review probe-coverage " +
  "classification. Fixtures `.claude/audit-fixtures/probe-driven-verification/` (this rule's own " +
  "MUST-1 bipolar set) + " +
  "`.claude/audit-fixtures/violation-patterns/detectRegexForSemanticAssertion/`; probes " +
  "`.claude/test-harness/probes/probe-driven-verification.probes.json`, registered probe-only " +
  "(`scanner: null`) in `.claude/test-harness/eval-manifest.json`, dispatched at gate-review and " +
  "NOT in CI; disarm-resistance floor " +
  "`.claude/test-harness/tests/probe-suite-integrity.test.mjs`.";

const POLE_PATH = ".claude/rules/probe-driven-verification.md";
const EXPECTED_RED_IDENTITY =
  "citation_descoping|citation_path|.claude/test-harness/eval-manifest.json";

const redVerdict = citationVerdict(perRuleFor(POLE_PATH, POLE_BASE, POLE_RED));
const greenVerdict = citationVerdict(perRuleFor(POLE_PATH, POLE_BASE, POLE_GREEN));

check(
  "K01-RED-pole-is-REJECTED",
  redVerdict.length > 0,
  "the real deleted-anchor case produced NO finding — the gate does not close the class it was built for",
);

check(
  "K02-RED-pole-failure-IDENTITY-is-the-expected-one",
  redVerdict.includes(EXPECTED_RED_IDENTITY),
  `expected the named identity ${EXPECTED_RED_IDENTITY}; got ${JSON.stringify(redVerdict)} — ` +
    "a red for some OTHER reason is not evidence this check detects THIS class",
);

check(
  "K03-GREEN-pole-is-ACCEPTED",
  greenVerdict.length === 0,
  `the restored-anchor rewrite was rejected: ${JSON.stringify(greenVerdict)} — a gate that reds ` +
    "on a compliant rewrite is one that gets turned off",
);

check(
  "K04-the-two-verdicts-DIFFER",
  JSON.stringify(redVerdict) !== JSON.stringify(greenVerdict),
  "the poles produced IDENTICAL verdicts — the pair is VACUOUS and proves nothing",
);

check(
  "K05-the-poles-are-genuinely-similar-and-BOTH-rewrite-the-line",
  POLE_RED !== POLE_BASE && POLE_GREEN !== POLE_BASE && POLE_RED !== POLE_GREEN,
  "a pole is a no-op copy, so the pair separates on 'was the line edited' rather than on the citation",
);

check(
  "K06-the-GREEN-pole-really-does-carry-the-anchor-the-RED-pole-dropped",
  POLE_GREEN.includes(".claude/test-harness/eval-manifest.json") &&
    !POLE_RED.includes(".claude/test-harness/eval-manifest.json"),
  "the pole texts do not actually differ on the citation, so K02/K03 are testing something else",
);

// The real rewrite ALSO compressed one "MUST-1" mention away, so on this
// isolated bullet the normative census happens to move too. MEASURED, and
// recorded rather than asserted away: on the FULL 19-rule commit the whole gate
// returned CLEAN, which is the fact that motivated this dimension. To show the
// blindness DIRECTLY and self-containedly, K08/K09 use a MINIMAL-DELTA pole
// derived from the same real base by deleting ONLY the citation clause — the
// smallest edit that removes the anchor and nothing else.
const CITATION_CLAUSE =
  "registered in `.claude/test-harness/eval-manifest.json` as a probe-only entry " +
  "(`scanner: null`) and ";
const POLE_RED_MINIMAL = POLE_BASE.replace(CITATION_CLAUSE, "");

check(
  "K07-the-minimal-pole-really-is-a-citation-ONLY-delta",
  POLE_BASE.includes(CITATION_CLAUSE) &&
    !POLE_RED_MINIMAL.includes(".claude/test-harness/eval-manifest.json") &&
    (() => {
      const b = extractInventory(POLE_BASE).counts;
      const h = extractInventory(POLE_RED_MINIMAL).counts;
      return ["must_token", "must_not_token", "blocked_token", "why_line", "must_clause"].every(
        (c) => h[c] === b[c],
      );
    })(),
  "the minimal pole moves a normative count too, so K08 would not isolate the citation dimension",
);

check(
  "K08-the-PRE-EXISTING-five-classes-are-SILENT-while-the-SIXTH-REDS",
  (() => {
    const r = perRuleFor(POLE_PATH, POLE_BASE, POLE_RED_MINIMAL);
    const res = evaluate([r], new Set(), [], [], new Set(), {
      added: new Set(),
      injected: new Set(),
    });
    const normative = res.findings.filter((f) => !String(f.kind).startsWith("citation_"));
    const cited = citationVerdict(r);
    return normative.length === 0 && cited.includes(EXPECTED_RED_IDENTITY);
  })(),
  "either a normative class fired (so the sixth dimension is not what caught it) or the sixth " +
    "stayed silent (so the anchor deletion is still invisible) — the exact gap this dimension closes",
);

check(
  "K09-no-NORMATIVE-finding-NAMES-the-lost-citation-even-on-the-real-pole",
  (() => {
    const r = perRuleFor(POLE_PATH, POLE_BASE, POLE_RED);
    const res = evaluate([r], new Set(), [], [], new Set(), {
      added: new Set(),
      injected: new Set(),
    });
    // Normative classes may move for their OWN reasons on the real rewrite (one
    // "MUST-1" mention went with it). What they can NEVER do is NAME the lost
    // anchor: their identity is a whole normalized LINE. A maintainer reading a
    // normative finding is handed a 900-character paragraph and is not told
    // which citation stopped resolving; only the sixth dimension reports the
    // token itself. That REPORTING difference is what K09 pins.
    const normativeMembers = res.findings
      .filter((f) => !String(f.kind).startsWith("citation_"))
      .flatMap((f) => [...(f.unaccounted || []), ...(f.uninjected || [])]);
    const namesTheToken = normativeMembers.some(
      (m) => m === ".claude/test-harness/eval-manifest.json",
    );
    const carriesItBuried = normativeMembers.some(
      (m) => m.includes(".claude/test-harness/eval-manifest.json") && m.length > 200,
    );
    return (
      !namesTheToken &&
      carriesItBuried &&
      citationVerdict(r).includes(EXPECTED_RED_IDENTITY)
    );
  })(),
  "the normative census either NAMED the citation token (so the two censuses are not independent) " +
    "or did not carry it buried in a line at all (so the reporting-difference claim is untested), " +
    "or the citation census failed to name it",
);

// ── L. THREE DISPOSITIONS OF ONE CITATION, from ONE base ───────────────────
//
// The question this section answers, asked directly rather than inferred from
// the clauses above: can the census tell an INTRA-FILE reflow from a
// rule -> EXTRACT relocation? If it cannot, it either cries wolf on every
// bullet that gets reworded, or stays silent on the class it exists to catch.
//
// All three heads derive from the SAME base and differ ONLY in where the
// citation ends up. The mechanism is stated so a reader does not have to infer
// it: for an intra-file move the SET is unchanged, so `removedLines` returns
// EMPTY and the move analysis is never consulted at all — the silence is
// structural, not a lucky pass through the destination fence. For the other two
// the set loses a member, and the move sets then decide WHICH finding it is.

const L_BASE = [
  "# A Rule",
  "",
  "- **Detection mechanism:** registered in `.claude/test-harness/eval-manifest.json` as probe-only.",
  "- **Violation scope:** the clause, per `.claude/rules/trust-posture.md` MUST-8.",
  "",
].join("\n");

// (i) INTRA-FILE MOVE — the citation relocates to the other bullet; BOTH bullets
//     are reworded, so this is a genuine text change, not a no-op copy.
const L_INTRA = [
  "# A Rule",
  "",
  "- **Detection mechanism:** probe-only; gate-review is the enforcement layer.",
  "- **Violation scope:** the clause, per `.claude/rules/trust-posture.md` MUST-8;",
  "  the suite is registered in `.claude/test-harness/eval-manifest.json`.",
  "",
].join("\n");

// (ii) RULE -> EXTRACT — the citation leaves the rule entirely and lands in the
//      paired guides extract, which does NOT load.
const L_TO_EXTRACT = [
  "# A Rule",
  "",
  "- **Detection mechanism:** probe-only. Depth: the extract.",
  "- **Violation scope:** the clause, per `.claude/rules/trust-posture.md` MUST-8.",
  "",
].join("\n");

// (iii) DELETED — identical head text to (ii); the ONLY difference is that no
//       destination anywhere in the diff gained the token.
const L_DELETED = L_TO_EXTRACT;

const L_PATH = ".claude/rules/a-rule.md";
const L_TOKEN = ".claude/test-harness/eval-manifest.json";
const L_EXTRACT_MOVE = { added: new Set([L_TOKEN]), injected: new Set() };

const vIntra = citationVerdict(perRuleFor(L_PATH, L_BASE, L_INTRA));
const vExtract = citationVerdict(perRuleFor(L_PATH, L_BASE, L_TO_EXTRACT), L_EXTRACT_MOVE);
const vDeleted = citationVerdict(perRuleFor(L_PATH, L_BASE, L_DELETED));

check(
  "L01-INTRA-FILE-move-is-SILENT",
  vIntra.length === 0,
  `an intra-file reflow produced findings (${JSON.stringify(vIntra)}) — the census would cry ` +
    "wolf on every bullet that gets reworded, and would be switched off within a week",
);

check(
  "L02-INTRA-FILE-move-is-a-REAL-text-change-not-a-no-op",
  (() => {
    // The citation must actually CHANGE BULLETS: present on the Detection line
    // at base, absent from it at head, and present on some OTHER line at head.
    const lineWith = (text, pred) =>
      text.split("\n").filter((l) => l.includes(L_TOKEN) && pred(l));
    const baseOnDetection = lineWith(L_BASE, (l) => l.includes("Detection mechanism")).length === 1;
    const headOnDetection = lineWith(L_INTRA, (l) => l.includes("Detection mechanism")).length === 0;
    const headElsewhere = lineWith(L_INTRA, () => true).length === 1;
    return L_INTRA !== L_BASE && baseOnDetection && headOnDetection && headElsewhere;
  })(),
  "the intra-file head is a copy of the base, or the citation did not actually change bullets — " +
    "L01 would then be passing on a no-op and would prove nothing",
);

check(
  "L03-INTRA-FILE-silence-is-STRUCTURAL-not-a-lucky-move-match",
  (() => {
    // The set is unchanged, so removedLines is EMPTY and the destination fence
    // is never reached. Asserted directly against the primitive, and with EMPTY
    // move sets, so the silence cannot be coming from a move credit.
    const r = perRuleFor(L_PATH, L_BASE, L_INTRA);
    const removed = CITATION_CLASSES.flatMap((c) =>
      removedLines(r.base.lines[c], r.head.lines[c]),
    );
    return removed.length === 0 && citationVerdict(r, { added: new Set(), injected: new Set() }).length === 0;
  })(),
  "the intra-file case reaches the move analysis (so its silence depends on a destination fence " +
    "rather than on the set being unchanged) — a fragile pass",
);

check(
  "L04-RULE-to-EXTRACT-move-REDS-as-to_uninjected",
  vExtract.length === 1 && vExtract[0] === `citation_descoping_to_uninjected|citation_path|${L_TOKEN}`,
  `expected exactly the to_uninjected finding for ${L_TOKEN}; got ${JSON.stringify(vExtract)} — ` +
    "the class this dimension exists to catch either did not fire or fired as the wrong kind",
);

check(
  "L05-VANISHED-citation-REDS-as-plain-descoping",
  vDeleted.length === 1 && vDeleted[0] === `citation_descoping|citation_path|${L_TOKEN}`,
  `expected exactly the plain descoping finding for ${L_TOKEN}; got ${JSON.stringify(vDeleted)}`,
);

check(
  "L06-the-THREE-dispositions-are-PAIRWISE-DISTINCT",
  JSON.stringify(vIntra) !== JSON.stringify(vExtract) &&
    JSON.stringify(vExtract) !== JSON.stringify(vDeleted) &&
    JSON.stringify(vIntra) !== JSON.stringify(vDeleted),
  "two of the three dispositions render identically — the census cannot tell a reflow, a " +
    "relocation to the extract, and a deletion apart, which is the whole discrimination claim",
);

check(
  "L07-EXTRACT-and-DELETED-heads-are-BYTE-IDENTICAL",
  L_TO_EXTRACT === L_DELETED,
  "the extract and deleted poles differ in their rule text, so L04/L05 could be separating on " +
    "the rule body rather than on where the citation went — the discrimination would be confounded",
);

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\ncitation-census fixtures: ${pass} passed, ${fail} failed (${pass + fail} cases)`);
process.exit(fail === 0 ? 0 : 1);
