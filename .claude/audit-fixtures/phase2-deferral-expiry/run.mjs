#!/usr/bin/env node
// Audit fixture runner for the Phase-2 detector deferral expiry gate in
// `.claude/bin/phase2-deferral-integrity.mjs`:
//
//   validateDeferralDeclaration — the declaration contract (all eight fields,
//                                 substantive reason/graduation, a non-empty
//                                 `accepted_by`, a REAL calendar expiry, and the
//                                 past-expiry hard fail that is the whole point
//                                 of the registry)
//   wiringSections              — the Trust Posture Wiring section slicer, whose
//                                 two forms (heading and bold paragraph) and
//                                 fence-awareness decide whether a Phase-2
//                                 clause is reconciled fail-closed or merely
//                                 warned about
//
// BIPOLAR: every predicate gets a case that must PASS and a case that must FAIL.
// A runner that only ever asserts rejection cannot distinguish a working
// predicate from one that rejects everything.
//
// Every fixture is self-contained: no fixture reads the live
// `phase2-deferrals.json` or the live rules corpus, so editing the registry
// changes the live gate but never silently rewrites what these predicates are
// asserted to do. The clock is INJECTED (`NOW`) rather than read, so these
// fixtures do not start failing on a calendar date — the live gate is what is
// meant to do that.
//
// Exits 0 when ALL fixtures pass, non-zero otherwise.
//   node .claude/audit-fixtures/phase2-deferral-expiry/run.mjs

import { validateDeferralDeclaration, wiringSections } from "../../bin/phase2-deferral-integrity.mjs";

// Frozen clock. Fixtures assert the PREDICATE, not today's date.
const NOW = Date.parse("2026-08-06T12:00:00Z");

const BASE = {
  rule: ".claude/rules/sample.md",
  quote: "Phase 2 (deferred) — no hook detector; fixtures land with it.",
  detector: "none built; planned advisory detector",
  risk: "process",
  reason: "Phase-1 coverage is a manual reviewer sweep that fires only when a reviewer runs it.",
  graduation: "Delete this entry when the detector and its audit fixtures land together.",
  expires: "2027-03-01",
  accepted_by: "repo-owner",
};

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, reason) {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    failures.push({ name, reason });
    console.log(`FAIL  ${name}: ${reason}`);
  }
}

/** Run the declaration validator and return its error list. */
function errs(decl) {
  const out = [];
  validateDeferralDeclaration("fixture", decl, out, NOW);
  return out;
}

/** Assert the validator produced NO errors. */
function expectClean(name, decl) {
  const e = errs(decl);
  check(name, e.length === 0, `expected clean, got: ${e.join(" | ")}`);
}

/** Assert the validator produced an error matching `rx`. */
function expectError(name, decl, rx) {
  const e = errs(decl);
  check(name, e.some((m) => rx.test(m)), `expected an error matching ${rx}, got: ${e.join(" | ") || "(none)"}`);
}

// ── DECLARATION CONTRACT — positive pole ───────────────────────────────────

expectClean("clean/well-formed-declaration", BASE);
expectClean("clean/expiry-one-day-in-the-future", { ...BASE, expires: "2026-08-07" });
expectClean("clean/security-band-inside-120d-horizon", { ...BASE, risk: "security", expires: "2026-10-01" });
expectClean("clean/hygiene-band-far-horizon-allowed", { ...BASE, risk: "hygiene", expires: "2027-06-01" });
expectClean("clean/reason-exactly-at-30-char-floor", { ...BASE, reason: "x".repeat(30) });
expectClean("clean/graduation-exactly-at-30-char-floor", { ...BASE, graduation: "y".repeat(30) });

// ── DECLARATION CONTRACT — negative pole ───────────────────────────────────

for (const field of ["rule", "quote", "detector", "risk", "reason", "graduation", "expires", "accepted_by"]) {
  const decl = { ...BASE };
  delete decl[field];
  expectError(`flag/missing-field-${field}`, decl, new RegExp(`\\.${field} is MISSING|\\.${field} must be`));
}

expectError("flag/reason-below-30-char-floor", { ...BASE, reason: "x".repeat(29) }, /too short to be a real reason/);
expectError("flag/graduation-below-30-char-floor", { ...BASE, graduation: "y".repeat(29) }, /too short to be a real graduation/);
expectError("flag/reason-empty-string", { ...BASE, reason: "" }, /must be a non-empty string/);
expectError("flag/graduation-empty-string", { ...BASE, graduation: "" }, /must be a non-empty string/);
expectError("flag/declaration-is-a-string", "nope", /must be an object/);
expectError("flag/declaration-is-an-array", [], /must be an object/);
expectError("flag/declaration-is-null", null, /must be an object/);

// The expiry — the field the whole registry exists for.
expectError("flag/expiry-absent-entirely", { ...BASE, expires: undefined }, /never ages out and is green forever/);
expectError("flag/expiry-not-a-string", { ...BASE, expires: 20270301 }, /must be an ISO calendar date/);
expectError("flag/expiry-prose-not-iso", { ...BASE, expires: "March 2027" }, /must be an ISO calendar date/);
expectError("flag/expiry-slashes-not-iso", { ...BASE, expires: "2027/03/01" }, /must be an ISO calendar date/);
// Date.parse rolls 2027-02-30 forward to Mar 2 rather than rejecting it, so a
// naive parse accepts it. The round-trip comparison is what catches it.
expectError("flag/expiry-rolls-over-feb-30", { ...BASE, expires: "2027-02-30" }, /not a real calendar date/);
expectError("flag/expiry-rolls-over-month-13", { ...BASE, expires: "2027-13-01" }, /not a real calendar date/);
expectError("flag/expiry-in-the-past", { ...BASE, expires: "2026-08-05" }, /is EXPIRED \(expires 2026-08-05\)/);
expectError("flag/expiry-long-past", { ...BASE, expires: "2025-01-01" }, /is EXPIRED/);

// Risk bands are a commitment, not a label: the band caps the horizon.
expectError("flag/unknown-risk-band", { ...BASE, risk: "someday" }, /risk must be one of/);
expectError("flag/risk-band-not-a-string", { ...BASE, risk: 3 }, /risk must be one of/);

// ── `accepted_by` — the named acceptor (completion-criterion.md MUST-6) ─────
//
// The missing-field case is generated by the loop above. These pin the shapes a
// BACKFILL produces by accident, which the missing-field check cannot see: the
// field is PRESENT and says nothing. MUST-6 names that "accepted-by-absence",
// and it is worse than omission because it reads as compliant to any check that
// only tests for presence.
//
// Bipolar on the value itself, not just on presence — a predicate that rejected
// every string would pass an absence-only suite and reject the whole registry.
expectError("flag/accepted-by-empty-string", { ...BASE, accepted_by: "" }, /accepted_by must be a non-empty string/);
expectError("flag/accepted-by-whitespace-only", { ...BASE, accepted_by: "   " }, /accepted_by must be a non-empty string/);
expectError("flag/accepted-by-tab-and-newline-only", { ...BASE, accepted_by: "\t\n" }, /accepted_by must be a non-empty string/);
expectError("flag/accepted-by-not-a-string", { ...BASE, accepted_by: 42 }, /accepted_by must be a non-empty string/);
expectError("flag/accepted-by-null", { ...BASE, accepted_by: null }, /accepted_by must be a non-empty string/);
// The error must be ACTIONABLE: it cites the governing clause, so the reader
// knows this is a residual-ownership contract and not a typo check.
expectError("flag/accepted-by-error-cites-MUST-6", { ...BASE, accepted_by: "" }, /completion-criterion\.md MUST-6/);

// Positive pole. A standing role is legitimately SHORT — there is deliberately
// no 30-char prose floor here, because padding a role name to clear one would
// make it less honest, not more.
expectClean("clean/accepted-by-standing-role", { ...BASE, accepted_by: "repo-owner" });
expectClean("clean/accepted-by-short-role-name", { ...BASE, accepted_by: "repo-owner" });
expectClean("clean/accepted-by-ten-chars-under-prose-floor", { ...BASE, accepted_by: "x".repeat(10) });
expectClean("clean/accepted-by-surrounding-whitespace-tolerated", { ...BASE, accepted_by: "  repo-owner  " });

// ── WIRING SECTION SLICER — both declaration forms, fence-aware ────────────

const HEADING_FORM = `# R

## Trust Posture Wiring

- **Detection mechanism:** Phase 2 (deferred) — heading form.

## Next Section

Not wiring.
`;
{
  const secs = wiringSections(HEADING_FORM);
  check("slicer/heading-form-detected", secs.length === 1, `expected 1 section, got ${secs.length}`);
  const i = HEADING_FORM.indexOf("Phase 2 (deferred) — heading form.");
  check("slicer/heading-form-contains-its-clause", secs.length === 1 && i >= secs[0].start && i < secs[0].end, "clause fell outside its own section");
  const j = HEADING_FORM.indexOf("Not wiring.");
  check("slicer/heading-form-stops-at-next-same-level-heading", secs.length === 1 && !(j >= secs[0].start && j < secs[0].end), "section over-ran into the next top-level section");
}

const BOLD_FORM = `# R

**Trust Posture Wiring (Rule 6):**

- **Detection mechanism:** Phase 2 (deferred) — bold form.
`;
{
  // Ten rules in this corpus use the bold-paragraph marker instead of a
  // heading. Missing this form silently demotes 19 markers' clauses from
  // fail-closed reconciliation to a non-fatal warning.
  const secs = wiringSections(BOLD_FORM);
  check("slicer/bold-paragraph-form-detected", secs.length === 1, `expected 1 section, got ${secs.length}`);
  const i = BOLD_FORM.indexOf("Phase 2 (deferred) — bold form.");
  check("slicer/bold-form-contains-its-clause", secs.length === 1 && i >= secs[0].start && i < secs[0].end, "clause fell outside its bold-form section");
}

const FENCED = `# R

## Trust Posture Wiring

\`\`\`bash
# DO — a shell comment, not a markdown heading
# DO NOT — likewise
\`\`\`

- **Detection mechanism:** Phase 2 (deferred) — after the fence.
`;
{
  // REGRESSION PIN. Before fence-awareness, `# DO — …` inside a fenced block
  // was parsed as a level-1 heading and closed the section early, so the
  // post-fence clause was reported as out-of-band. Measured on the real corpus:
  // artifact-flow.md's Detection line was mis-tiered exactly this way.
  const secs = wiringSections(FENCED);
  check("slicer/fence-comment-does-not-open-a-section", secs.length === 1, `expected 1 section, got ${secs.length}`);
  const i = FENCED.indexOf("Phase 2 (deferred) — after the fence.");
  check("slicer/fence-comment-does-not-truncate-section", secs.length === 1 && i >= secs[0].start && i < secs[0].end, "the post-fence clause fell outside the Wiring section");
}

const NESTED = `# R

## Trust Posture Wiring

- **Detection mechanism:** Phase 2 (deferred) — OUTER.

### Clause-scoped wiring — inner

- **Detection mechanism:** Phase 2 (deferred) — INNER.
`;
{
  // Nesting is real in this corpus (agents, recommendation-quality,
  // state-file-write-guard, wave-loop). The outer block physically contains the
  // inner one, which is why coverage must subtract nested spans rather than
  // taking the section wholesale.
  const secs = wiringSections(NESTED);
  check("slicer/nested-blocks-both-detected", secs.length === 2, `expected 2 sections, got ${secs.length}`);
  const outer = secs.find((s) => s.heading.startsWith("## Trust"));
  const inner = secs.find((s) => s.heading.startsWith("### Clause"));
  check(
    "slicer/outer-block-physically-contains-inner",
    !!outer && !!inner && inner.start >= outer.start && inner.end <= outer.end,
    "expected the outer block to contain the inner one",
  );
}

{
  const secs = wiringSections("# R\n\nNo wiring block here at all.\n");
  check("slicer/no-wiring-block-yields-no-sections", secs.length === 0, `expected 0 sections, got ${secs.length}`);
}

console.log(`\n${pass}/${pass + fail} fixtures passed`);

if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f.name}: ${f.reason}`);
  process.exit(1);
}

process.exit(0);
