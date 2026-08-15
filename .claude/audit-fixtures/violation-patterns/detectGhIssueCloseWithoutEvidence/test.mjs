#!/usr/bin/env node
/*
 * Audit-fixture suite for detectGhIssueCloseWithoutEvidence
 * (rules/git.md § Discipline — issue closure MUST cite a commit SHA / PR number
 * / merged-PR link in the comment).
 *
 * Per cc-artifacts.md Rule 9 the fixtures land WITH the detector. BIPOLAR by
 * construction: every predicate class carries a FLAG pole and a CLEAN pole, so
 * a detector that stopped firing and a detector that fired on everything are
 * BOTH caught. A one-poled suite passes identically under either failure.
 *
 * Predicate classes covered:
 *   1. FLAG   no --comment at all; comment with no code reference
 *   2. FLAG   the failure that produced this detector: a PLAN DOCUMENT cited as
 *             completion evidence
 *   3. FLAG   over-broad-SHA controls — a bare 8-digit date and a plain 7-digit
 *             integer must NOT read as commit SHAs
 *   4. CLEAN  the four evidence shapes git.md names (PR #N, bare #N, abbrev
 *             SHA, full SHA, merged-PR URL)
 *   5. CLEAN  out of scope — `--reason not_planned` (sibling #13 owns it),
 *             `gh pr close`, no gh close at all
 *   6. CLEAN  segment anchoring — the verb MENTIONED in prose / a heredoc / a
 *             grep pattern is not an INVOCATION
 *   7. SKIP   unevaluable at hook time per hook-output-discipline.md MUST-3 —
 *             $VAR, ${VAR}, $(...), backticks, --body-file
 *
 * Run: node .claude/audit-fixtures/violation-patterns/detectGhIssueCloseWithoutEvidence/test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOOKS_LIB = path.resolve(HERE, "..", "..", "..", "hooks", "lib", "violation-patterns.js");
const { detectGhIssueCloseWithoutEvidence, hasCompletionEvidence } = require(HOOKS_LIB);

const read = (name) => fs.readFileSync(path.resolve(HERE, name), "utf8").replace(/\n$/, "");

/** Every fixture in this directory, so a committed-but-unasserted file is impossible. */
const ALL = fs
  .readdirSync(HERE)
  .filter((f) => f.endsWith(".txt"))
  .sort();

const FLAG = ALL.filter((f) => f.startsWith("flag-"));
const CLEAN = ALL.filter((f) => f.startsWith("clean-"));
const SKIP = ALL.filter((f) => f.startsWith("skip-"));

test("the fixture set is BIPOLAR — both poles are populated", () => {
  // A suite with only one pole passes identically whether the detector fires on
  // everything or on nothing, so it cannot discriminate (instrument-discipline.md
  // MUST-1). This row is what makes every row below readable.
  assert.ok(FLAG.length >= 5, `expected >=5 flag fixtures, got ${FLAG.length}`);
  assert.ok(CLEAN.length >= 5, `expected >=5 clean fixtures, got ${CLEAN.length}`);
  assert.ok(SKIP.length >= 4, `expected >=4 skip fixtures, got ${SKIP.length}`);
  assert.equal(FLAG.length + CLEAN.length + SKIP.length, ALL.length, `every .txt must carry a flag-/clean-/skip- prefix; got ${ALL.join(", ")}`);
});

for (const name of FLAG) {
  test(`FLAG: ${name}`, () => {
    const r = detectGhIssueCloseWithoutEvidence(read(name));
    assert.notEqual(r, null, `expected a finding for ${name}: ${JSON.stringify(read(name))}`);
    assert.equal(r.rule_id, "git/issue-closure-evidence");
    // hook-output-discipline.md MUST-2: a LEXICAL signal must never carry
    // `block`. Asserted per fixture rather than once, so a severity raised on
    // one path cannot hide behind the others.
    assert.equal(r.severity, "halt-and-report");
    assert.equal(r.detection_layer, "lexical");
    assert.equal(r.mode, "bash");
    assert.ok(typeof r.evidence === "string" && r.evidence.length > 0, "a finding must quote what triggered it");
  });
}

for (const name of [...CLEAN, ...SKIP]) {
  test(`CLEAN: ${name}`, () => {
    const r = detectGhIssueCloseWithoutEvidence(read(name));
    assert.equal(r, null, `expected null for ${name}: ${JSON.stringify(read(name))}; got ${JSON.stringify(r)}`);
  });
}

test("CONTROL: the evidence matcher rejects the over-broad SHA form's false positives", () => {
  // The acceptance list flagged its own matcher: `[0-9a-f]{7,40}` matches any
  // 7+-digit run, so a date reads as a commit and the positives become
  // unreadable. This pins the tightened arm at BOTH poles — it must reject the
  // three shapes the loose form accepts, and still accept every real SHA.
  for (const s of ["20260814", "1234567", "8675309"]) {
    assert.equal(hasCompletionEvidence(`closed ${s}`), false, `"${s}" must NOT read as completion evidence`);
  }
  for (const s of ["f4091e35", "c22d46b0", "43167a54921f", "583c8d310fd094ad9e591041eb496185ee8a85ec"]) {
    assert.equal(hasCompletionEvidence(`landed as ${s}`), true, `"${s}" is a real abbreviated/full SHA and must read as evidence`);
  }
});

test("RESIDUAL: an all-hex-LETTER SHA is not recognised — a KNOWN false positive, not a rejected non-SHA", () => {
  // `deadbeef` used to sit in the reject list above, alongside `20260814` and
  // `1234567`, which read as though the matcher had correctly excluded a non-SHA.
  // It has not: `deadbeef` is a perfectly valid abbreviated SHA that the digit
  // requirement cannot see, so a COMPLIANT closure citing one is FLAGGED.
  // Pinned here under its own name so the suite states the trade instead of
  // disguising it. Rate at 8 chars: (6/16)^8 ≈ 0.04%.
  //
  // The trade is CORRECT and this row is NOT a request to change the regex —
  // dropping the digit requirement re-admits the entire date / plain-integer
  // class the loop above pins, which is far commoner than an all-letter SHA.
  for (const s of ["deadbeef", "facadeb", "cafebabe"]) {
    assert.equal(
      hasCompletionEvidence(`landed as ${s}`),
      false,
      `"${s}" is the accepted residual; if this now PASSES the digit requirement was relaxed — re-check the date/integer rejections above before accepting that`,
    );
  }
});

test("CONTROL: the segment anchor is what suppresses the prose cases, not the evidence matcher", () => {
  // instrument-discipline.md MUST-1 — name the falsifying result. The prose
  // fixtures carry NO code reference, so if the anchor were absent they would
  // FLAG. Showing the same text flags once it is moved to command position
  // proves the clean verdict comes from the anchor and not from some unrelated
  // early return.
  const prose = read("clean-prose-mention.txt");
  assert.equal(detectGhIssueCloseWithoutEvidence(prose), null);
  const invoked = prose.replace(/^echo\s+"remember to\s+/, "").replace(/\s+once the PR lands"$/, "");
  assert.notEqual(invoked, prose, "the fixture rewrote nothing — this control is not exercising the anchor");
  assert.notEqual(
    detectGhIssueCloseWithoutEvidence(invoked),
    null,
    `the same text at COMMAND POSITION must flag, or the clean verdict above is coming from somewhere else: ${JSON.stringify(invoked)}`,
  );
});

test("CONTROL: a clean fixture flags once its code reference is removed", () => {
  // The other direction: the CLEAN pole must be clean BECAUSE of the evidence,
  // not because the detector never reached it.
  const clean = read("clean-pr-number.txt");
  assert.equal(detectGhIssueCloseWithoutEvidence(clean), null);
  const stripped = clean.replace(/PR #\d+/, "the linked work");
  assert.notEqual(stripped, clean, "the fixture rewrote nothing — this control is not exercising the matcher");
  assert.notEqual(detectGhIssueCloseWithoutEvidence(stripped), null, "removing the reference must flip the verdict");
});

test("degenerate input returns null without throwing", () => {
  for (const v of ["", null, undefined, 42, {}, []]) assert.equal(detectGhIssueCloseWithoutEvidence(v), null);
});
