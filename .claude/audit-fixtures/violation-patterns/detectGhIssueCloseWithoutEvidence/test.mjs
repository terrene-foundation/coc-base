#!/usr/bin/env node
/*
 * Audit-fixture suite for detectGhIssueCloseWithoutEvidence
 * (rules/git.md § Discipline — issue closure MUST cite a commit SHA / PR number
 * / merged-PR link in the comment).
 *
 * Per cc-artifacts.md Rule 9 the fixtures land WITH the detector. THREE-POLED
 * by construction: every predicate class carries a FLAG pole, a CLEAN pole and
 * — since the conflation below — an UNKNOWN pole, so a detector that stopped
 * firing, one that fired on everything, and one that reports a VIOLATION about
 * a comment it could not read are ALL caught.
 *
 * WHY THE THIRD POLE EXISTS. A bipolar suite asks only "did it fire?", and both
 * "no comment was supplied" and "a comment was supplied but could not be
 * parsed" answer YES. So a detector that accused compliant closures — ones
 * citing three SHAs in a multi-line comment — passed this suite unchanged. The
 * fixtures could not see the bug because they only had two names for three
 * outcomes.
 *
 * Predicate classes covered:
 *   1. FLAG    no --comment at all; comment with no code reference
 *   2. FLAG    the failure that produced this detector: a PLAN DOCUMENT cited as
 *              completion evidence
 *   3. FLAG    over-broad-SHA controls — a bare 8-digit date and a plain 7-digit
 *              integer must NOT read as commit SHAs
 *   4. CLEAN   the four evidence shapes git.md names (PR #N, bare #N, abbrev
 *              SHA, full SHA, merged-PR URL)
 *   5. CLEAN   out of scope — `--reason not_planned` (sibling #13 owns it),
 *              `gh pr close`, no gh close at all
 *   6. CLEAN   segment anchoring — the verb MENTIONED in prose / a heredoc / a
 *              grep pattern is not an INVOCATION
 *   7. SKIP    unevaluable at hook time per hook-output-discipline.md MUST-3 —
 *              $VAR, ${VAR}, $(...), backticks, --body-file
 *   8. UNKNOWN a comment flag IS present but its body cannot be read — a
 *              dangling flag, or a truncated body too ambiguous to recover.
 *              Reported, never null: rendering it as a PASS would launder an
 *              unanswered question into a clean bill of health, which is a
 *              worse failure than the false accusation it replaced.
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
const UNKNOWN = ALL.filter((f) => f.startsWith("unknown-"));

test("the fixture set is THREE-POLED — violation, clean, and UNKNOWN are all populated", () => {
  // A suite with only one pole passes identically whether the detector fires on
  // everything or on nothing, so it cannot discriminate (instrument-discipline.md
  // MUST-1). This row is what makes every row below readable.
  //
  // The UNKNOWN pole is not decoration. A TWO-poled suite is structurally unable
  // to see the defect this pole exists for: "could not read the comment" and
  // "there was no comment" both land as `notEqual(r, null)`, so a detector that
  // reports a VIOLATION against a closure citing three SHAs passes a bipolar
  // suite unchanged. That is exactly how the bug shipped.
  assert.ok(FLAG.length >= 5, `expected >=5 flag fixtures, got ${FLAG.length}`);
  assert.ok(CLEAN.length >= 5, `expected >=5 clean fixtures, got ${CLEAN.length}`);
  assert.ok(SKIP.length >= 4, `expected >=4 skip fixtures, got ${SKIP.length}`);
  assert.ok(UNKNOWN.length >= 2, `expected >=2 unknown fixtures, got ${UNKNOWN.length}`);
  assert.equal(
    FLAG.length + CLEAN.length + SKIP.length + UNKNOWN.length,
    ALL.length,
    `every .txt must carry a flag-/clean-/skip-/unknown- prefix; got ${ALL.join(", ")}`,
  );
});

for (const name of FLAG) {
  test(`FLAG: ${name}`, () => {
    const r = detectGhIssueCloseWithoutEvidence(read(name));
    assert.notEqual(r, null, `expected a finding for ${name}: ${JSON.stringify(read(name))}`);
    assert.equal(r.rule_id, "git/issue-closure-evidence");
    // The pole assertion, not just "a finding exists". Without this the FLAG
    // rows would accept an UNKNOWN, which is the conflation under test.
    assert.equal(r.outcome, "violation", `${name} must be a VIOLATION, not ${r.outcome}`);
    // hook-output-discipline.md MUST-2: a LEXICAL signal must never carry
    // `block`. Asserted per fixture rather than once, so a severity raised on
    // one path cannot hide behind the others.
    assert.equal(r.severity, "halt-and-report");
    assert.equal(r.detection_layer, "lexical");
    assert.equal(r.mode, "bash");
    assert.ok(typeof r.evidence === "string" && r.evidence.length > 0, "a finding must quote what triggered it");
  });
}

for (const name of UNKNOWN) {
  test(`UNKNOWN: ${name}`, () => {
    const r = detectGhIssueCloseWithoutEvidence(read(name));
    // THE FAIL-DIRECTION ROW. `null` here would render an unread comment as a
    // PASS — laundering a question nobody answered into a clean bill of health.
    // This assertion is the whole point of the pole: UNKNOWN must be REPORTED.
    assert.notEqual(
      r,
      null,
      `${name} returned null — an unparseable comment rendered as a PASS, which is the fail-OPEN this pole exists to forbid`,
    );
    assert.equal(r.outcome, "unknown", `${name} must be UNKNOWN, not ${r.outcome}`);
    // A DISTINCT rule_id, not the violation's. The emitted banner renders WHY
    // from rule_id alone, and violations.jsonl is counted BY RULE for
    // trust-posture MUST-4 — so sharing the id would both hide the distinction
    // at the only surface the agent reads and charge posture damage for a
    // question the detector could not answer.
    assert.equal(r.rule_id, "git/issue-closure-evidence-undetermined");
    assert.equal(r.severity, "halt-and-report", "UNKNOWN must not be quieter than the violation it could not rule out");
    assert.match(
      r.evidence,
      /UNDETERMINED/,
      "the ledger row must SAY it is undetermined — violations.jsonl carries `evidence`, not `outcome`, so the prefix is what keeps an UNKNOWN distinguishable there",
    );
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

test("SCOPE MUTATION: the suite bans the DEFECT, not this implementation", () => {
  // instrument-discipline.md MUST-2(b) — a mutation that does not red the suite
  // leaves two hypotheses, so the mutation is applied to the CONTRACT (the
  // detector's observable verdict) rather than to any internal it happens to
  // use. Each row below is a DIFFERENT wrong implementation an author could
  // plausibly ship; every one must be caught by a fixture above.
  //
  // Stated as an explicit table because a re-implementation that satisfies all
  // four is CORRECT even if it shares no line with the current one.
  const contract = [
    // [ command, required outcome, which wrong implementation this catches ]
    [`gh issue close 7`, "violation", "treating a genuinely-absent comment as UNKNOWN would fail-open the real violation"],
    [`gh issue close 7 --comment "nothing to see"`, "violation", "an over-eager UNKNOWN that swallows every unreferenced comment"],
    [`gh issue close 7 --comment "landed f4091e35\nand more"`, "clean", "the ORIGINAL bug — a truncated multi-line body judged as a violation"],
    [`gh issue close 7 --comment`, "unknown", "collapsing an unreadable comment back into 'no comment at all'"],
  ];
  for (const [cmd, want, catches] of contract) {
    const r = detectGhIssueCloseWithoutEvidence(cmd);
    const got = r === null ? "clean" : r.outcome;
    assert.equal(got, want, `${JSON.stringify(cmd)} must be ${want}, got ${got} — this row catches: ${catches}`);
  }
});

test("SCOPE MUTATION: recovery must NOT reach across to another command's comment", () => {
  // The recovery step re-reads the UNSEGMENTED command, which is the one place
  // it could over-reach: if it ignored the no-ambiguity guard it would read a
  // NEIGHBOURING closure's comment as this one's evidence and emit a FALSE
  // CLEAN — strictly worse than the bug being fixed. The falsifying result is
  // named: if this returns clean, recovery has crossed a command boundary.
  const twoCommands = `gh issue close 7 --comment "no reference here\nstill none" && gh issue close 8 --comment "landed f4091e35"`;
  const r = detectGhIssueCloseWithoutEvidence(twoCommands);
  assert.notEqual(r, null, "a false CLEAN here means recovery read command 8's SHA as command 7's evidence");
  assert.equal(r.outcome, "unknown", `ambiguous recovery must report UNKNOWN, got ${r.outcome}`);
});

test("CONTROL: the UNKNOWN pole is reachable ONLY via an unparseable body", () => {
  // Shows the UNKNOWN branch is not simply always-on. Same closure, one with a
  // terminated quote and one without: the first must resolve, the second must
  // not. Without this row a detector that returned UNKNOWN for everything would
  // pass every UNKNOWN fixture above.
  assert.equal(detectGhIssueCloseWithoutEvidence(`gh issue close 7 --comment "landed f4091e35"`), null);
  const dangling = detectGhIssueCloseWithoutEvidence(`gh issue close 7 --comment "landed f4091e35`);
  assert.equal(dangling && dangling.outcome, "unknown", "an unterminated quote on a single line must report UNKNOWN");
});

test("every non-null verdict carries an explicit outcome — absence is not a third state", () => {
  // A consumer that discriminated by `!("outcome" in f)` would silently
  // misclassify any finding that forgot the field. Requiring it on EVERY
  // verdict removes that ambiguity by construction.
  for (const name of [...FLAG, ...UNKNOWN]) {
    const r = detectGhIssueCloseWithoutEvidence(read(name));
    assert.ok(
      r && (r.outcome === "violation" || r.outcome === "unknown"),
      `${name}: every finding must declare outcome as "violation" or "unknown"; got ${JSON.stringify(r && r.outcome)}`,
    );
  }
});

test("degenerate input returns null without throwing", () => {
  for (const v of ["", null, undefined, 42, {}, []]) assert.equal(detectGhIssueCloseWithoutEvidence(v), null);
});
