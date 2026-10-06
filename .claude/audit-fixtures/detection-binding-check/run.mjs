#!/usr/bin/env node
/**
 * Structural fixtures — `detection-binding-check.mjs` non-canonical Detection
 * bullet MARKER (2026-09-16).
 *
 * WHY THIS FILE EXISTS ALONGSIDE THE MINI-REPO CASES. Every other case in this
 * directory is a self-contained mini-repo driven by `coc-eval-core.mjs` and
 * pinned in `eval-manifest.json`. That shape is right for whole-scanner
 * dispositions. It is the WRONG shape for this predicate: the defect is that a
 * single character makes a Detection bullet invisible, so the fixture has to
 * vary ONE character and read the verdict — which is a pure-function probe, the
 * `fixture-hookEvent-a/b/w/w0` shape in `validate-emit/run.mjs`. Standing up a
 * mini-repo per marker would bury a one-character difference under a directory
 * tree and make the pair unreadable.
 *
 * Run: node .claude/audit-fixtures/detection-binding-check/run.mjs
 * Exit 0 = all pass. Exit 1 = >=1 failed.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THESE PIN
 * ---------------------------------------------------------------------------
 * `DETECTION_BULLET_RE` anchors a hyphen at COLUMN 0. Every other marker renders
 * identically in markdown and is DISCARDED: `extractDetectionSpans` returns zero
 * spans, the rule reports `wired-no-detection-block`, and that state is
 * "reported, never red". So one keystroke removed a rule and ALL of its bindings
 * from the MUST-4 gap population while the scanner still exited 0.
 *
 * MEASURED on the live corpus BEFORE the fix — `conservation-gate.md`,
 * `- **Detection mechanism:**` -> `* **Detection mechanism:**`:
 *   detection-binding-check : wired-and-resolving (2 bindings) -> wired-no-detection-block (0)
 *                             `wired_and_resolving` 62 -> 61; exit 0, VALID, score 100
 *   validate-emit           : exit 0, 1844 pass / 0 fail — BYTE-IDENTICAL to baseline
 * The cross-check could not see it because `wiringBlocksIn` accepts `*` and any
 * indent. The two instruments held OPPOSITE marker tolerances: the strict one
 * went quiet, the tolerant one stayed green, and neither reported anything.
 *
 * Trigger: `npx prettier --write` has been disarmed for markdown in
 * `.claude/hooks/auto-format.js`. Prettier was normalizing list markers to `-`
 * as an UNDECLARED side effect and these line-oriented parsers depended on it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PARSER STAYS STRICT
 * ---------------------------------------------------------------------------
 * Not because `-` is sacred — `declaration-anchor.mjs` and `validate-emit.mjs`
 * are both tolerant, so strictness here is the MINORITY convention. It stays
 * because TOLERANCE RELOCATES THE CLIFF RATHER THAN REMOVING IT: `^\s*[-*]\s+`
 * still silently drops `+`, `1.` and a U+2011 lookalike. Every tolerance level
 * has an edge and the edge is silent unless something checks it. Only a loud
 * detector removes the class — so the parser keeps ONE contract and the detector
 * DERIVES its verdict from that parser, which is why the two cannot drift.
 */
import {
  findNonCanonicalDetectionBullets,
  extractDetectionSpans,
} from "../../bin/detection-binding-check.mjs";

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("detection-binding-check — non-canonical Detection marker fixtures");

// A Detection bullet carrying a real binding path, so the GREEN pole can assert
// the parser actually READ it. Without that, "0 findings" is indistinguishable
// from a matcher that never fired.
const BINDING = "`.claude/test-harness/probes/example.probes.json`";
const bullet = (prefix) => `${prefix}**Detection mechanism:** Phase 1. Probes: ${BINDING}`;

/**
 * BIPOLAR driver. `expectMarker === null` is the GREEN pole (silent, AND the
 * parser sees the bullet); otherwise the RED pole, which asserts the failure
 * IDENTITY — the exact offending prefix — never a bare "something was flagged".
 */
const fx = (id, prefix, expectMarker) => {
  const body = ["# Fixture rule", "", "## Trust Posture Wiring", "", bullet(prefix), ""].join("\n");
  const nc = findNonCanonicalDetectionBullets(body);
  const spans = extractDetectionSpans(body);
  if (expectMarker === null) {
    check(
      `fixture-detectionMarker-${id}-canonical-CLEAN`,
      nc.length === 0 && spans.length === 1,
      `nonCanonical=${JSON.stringify(nc)} spans=${spans.length} (anti-vacuity: the parser must SEE this bullet)`,
    );
  } else {
    // Both halves of the finding: the detector names the marker, AND the parser
    // really did discard the block. Asserting only the first would pass even if
    // the parser had quietly started accepting it.
    check(
      `fixture-detectionMarker-${id}-nonCanonical-FLAGGED`,
      nc.length === 1 && nc[0].marker === expectMarker && spans.length === 0,
      `expected marker ${JSON.stringify(expectMarker)}; got ${JSON.stringify(nc)} spans=${spans.length}`,
    );
  }
};

// (a) CONTROL — canonical, silent, and the parser DOES read it.
fx("a", "- ", null);
// (b) the measured live defect. Valid CommonMark, renders identically.
fx("b", "* ", "* ");
// (c) the third CommonMark marker.
fx("c", "+ ", "+ ");
// (d) INDENT drift — prettier normalized this too.
fx("d", "  - ", "  - ");
// (e)(f) ORDERED-list markers — a plausible edit when numbering categories.
fx("e", "1. ", "1. ");
fx("f", "1) ", "1) ");
// (g) U+2011 NON-BREAKING HYPHEN. Not a list marker at all (CommonMark renders
//     the line as a PARAGRAPH), but indistinguishable from `-` in every editor
//     and diff — the one form review structurally cannot catch.
//     BUILT FROM ITS CODE POINT, never pasted as a glyph: a literal U+2011
//     here would be unreviewable in exactly the way this fixture is about,
//     and a reader could not tell this pole from the `- ` control at (a).
const NBHYPHEN = String.fromCharCode(0x2011);
fx("g", `${NBHYPHEN} `, `${NBHYPHEN} `);

// (h) WIDTH TOLERANCE — the verdict is DERIVED from the parser, not restated
//     against a second hand-written notion of "canonical". `DETECTION_BULLET_RE`
//     uses `\s+`, so `-  ` (two spaces) IS read; flagging it would mean the
//     detector had grown its own opinion and could drift from its subject. This
//     is the pole that reds if anyone "tidies" the derivation into a literal.
{
  const body = ["# R", "", "## Trust Posture Wiring", "", bullet("-  "), ""].join("\n");
  const nc = findNonCanonicalDetectionBullets(body);
  const spans = extractDetectionSpans(body);
  check(
    "fixture-detectionMarker-h-derivedFromParser-widthAccepted-NOT-FLAGGED",
    nc.length === 0 && spans.length === 1,
    `the parser accepts "-  ", so the detector must too; got ${JSON.stringify(nc)} spans=${spans.length}`,
  );
}

// (i) PRECISION CONTROL — the load-bearing one. The fence against a blanket
//     `/^\s*[-*+]\s+/` draft is the `**Detection` LABEL anchor, not the marker
//     class. Measured over the fence-stripped live corpus: blanket matches 2965
//     lines (503 indented); this probe matches 141, every Detection bullet
//     there is, and flags 0. An over-broad draft would flood on ordinary
//     sibling Wiring bullets and indented detail sub-bullets — and a flooding
//     detector gets switched off by the first operator it blocks.
{
  const body = [
    "# R",
    "",
    "## Trust Posture Wiring",
    "",
    bullet("- "),
    "* **Severity:** `halt-and-report` at gate-review.",
    "+ **Grace period:** 7 days from rule landing.",
    "  - `some-rule.md` (2026-08-03 Gate-1 ingest): codify-governing detail.",
    "  * `another-rule.md` (co-owner-directed): more detail.",
    "1. a numbered prose step that is not a field bullet at all",
    "",
  ].join("\n");
  const nc = findNonCanonicalDetectionBullets(body);
  check(
    "fixture-detectionMarker-i-nonDetectionBullets-NOT-FLAGGED",
    nc.length === 0,
    `only **Detection…:** bullets are in scope; got ${JSON.stringify(nc)}`,
  );
}

// (j) VARIANT LABELS are in scope too. `- **Detection (hook layer):**` is a
//     legitimate corpus form the parser READS, so its non-canonical twin must
//     red — otherwise the 15 variant-labelled bullets in the corpus are a hole
//     the fix does not cover.
{
  const v = (p) => `${p}**Detection (structural — AUTHORED, UNWIRED):** see ${BINDING}`;
  const green = findNonCanonicalDetectionBullets(["# R", "", v("- "), ""].join("\n"));
  const red = findNonCanonicalDetectionBullets(["# R", "", v("* "), ""].join("\n"));
  check(
    "fixture-detectionMarker-j-variantLabel-canonical-CLEAN",
    green.length === 0,
    `got ${JSON.stringify(green)}`,
  );
  check(
    "fixture-detectionMarker-j-variantLabel-nonCanonical-FLAGGED",
    red.length === 1 && red[0].marker === "* ",
    `got ${JSON.stringify(red)}`,
  );
}

// (k) FENCE SCOPING — callers pass a FENCE-STRIPPED body (`scanRuleFile` does).
//     This asserts the predicate reports position faithfully on the text it is
//     handed rather than silently re-deriving scope, so the caller's existing
//     fenced-example guard (false-positive class (1)) keeps working unchanged.
{
  const body = ["# R", "", "## Trust Posture Wiring", "", bullet("* "), ""].join("\n");
  const nc = findNonCanonicalDetectionBullets(body);
  check(
    "fixture-detectionMarker-k-reportsLineNumber",
    nc.length === 1 && nc[0].line === 5,
    `expected line 5; got ${JSON.stringify(nc)}`,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
