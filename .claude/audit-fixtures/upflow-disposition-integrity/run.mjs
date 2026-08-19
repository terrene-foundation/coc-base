#!/usr/bin/env node
// Audit fixture runner for `.claude/bin/upflow-disposition-integrity.mjs` — the
// gate that gives `.claude/upflow-dispositions.json` the aging teeth
// `phase2-deferrals.json` already has (loom#1751).
//
//   validateDisposition — the per-row contract: six required fields, a target
//                         that is a resolver key and not a path, an artifact
//                         that leaks no checkout location, a verdict from the
//                         ledger's own vocabulary, a substantive reason, a real
//                         non-future decided_on, and the calendar rot that is
//                         the whole point (expires REQUIRED on the
//                         action-deferring verdict, past-expiry a hard fail on
//                         every verdict)
//   validateBacklog     — the aging of the backlog SNAPSHOT, which is how 161
//                         undispositioned rows stay visible on a surface CI can
//                         reach without CI needing cross-repo access
//   checkUpflowDispositions — ledger-level: absent-vs-empty discrimination,
//                         duplicate rows, and the artifact-rot arm that reports
//                         NOT CHECKED rather than passing when it has no
//                         producer access
//
// BIPOLAR: every predicate gets a case that must PASS and a case that must FAIL.
// A runner that only ever asserts rejection cannot distinguish a working
// predicate from one that rejects everything — and one that only ever asserts
// acceptance cannot tell a working predicate from one that accepts everything.
//
// The clock is INJECTED (`NOW`) rather than read, so these fixtures do not start
// failing on a calendar date. The LIVE gate is what is meant to do that.
//
// No fixture reads the live ledger, so editing `.claude/upflow-dispositions.json`
// changes the live gate but never silently rewrites what these predicates are
// asserted to do.
//
// Exits 0 when ALL fixtures pass, non-zero otherwise.
//   node .claude/audit-fixtures/upflow-disposition-integrity/run.mjs

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  validateDisposition,
  validateBacklog,
  checkUpflowDispositions,
  expiryTimestamp,
  calendarDayStart,
  MIN_REASON_CHARS,
} from "../../bin/upflow-disposition-integrity.mjs";

// Frozen clock. Fixtures assert the PREDICATE, not today's date.
const NOW = Date.parse("2026-08-18T12:00:00Z");

const VOCAB = ["keep-local", "upflow-owed", "superseded", "not-an-artifact"];

const BASE = {
  target: "build.rs",
  artifact: "hooks/lib/worktree-reclaim.js",
  disposition: "keep-local",
  reason: "Binds to a cargo target-dir layout no other ecosystem member has.",
  decided_on: "2026-08-17",
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

/** Row validator errors for `row`. */
function errs(row) {
  const out = [];
  validateDisposition("fixture", row, out, NOW, VOCAB);
  return out;
}

function expectClean(name, row) {
  const e = errs(row);
  check(name, e.length === 0, `expected no errors, got: ${JSON.stringify(e)}`);
}

function expectRejected(name, row, needle) {
  const e = errs(row);
  const hit = e.some((m) => m.toLowerCase().includes(needle.toLowerCase()));
  check(name, hit, `expected an error mentioning ${JSON.stringify(needle)}, got: ${JSON.stringify(e)}`);
}

// ── date helpers ─────────────────────────────────────────────────
check(
  "expiryTimestamp: accepts a real calendar date",
  expiryTimestamp("2026-08-18") !== null,
  "a valid date was rejected",
);
check(
  "expiryTimestamp: REJECTS a calendar-invalid date (no silent roll-forward)",
  expiryTimestamp("2026-02-31") === null,
  "2026-02-31 was accepted; Date.parse rolls it forward silently",
);
check(
  "expiryTimestamp: rejects a non-date string",
  expiryTimestamp("soon") === null,
  "a non-date was accepted",
);
check(
  "calendarDayStart is EARLIER than expiryTimestamp for the same date",
  calendarDayStart("2026-08-18") < expiryTimestamp("2026-08-18"),
  "day-start is not before day-end; an age computed from it would be off by a day",
);

// ── row contract: the compliant pole ─────────────────────────────
expectClean("well-formed keep-local row is accepted", { ...BASE });
expectClean("well-formed upflow-owed row WITH expires is accepted", {
  ...BASE,
  disposition: "upflow-owed",
  reason: "Language-agnostic worktree affordance canon needs; proposal owed.",
  expires: "2026-12-01",
});
expectClean("terminal verdict WITHOUT expires is accepted", {
  ...BASE,
  disposition: "superseded",
  reason: "worktree-reap.mjs already carries this capability in canon.",
});
expectClean("terminal verdict WITH a future expires is accepted", {
  ...BASE,
  disposition: "not-an-artifact",
  reason: "Generated build scratch; matched the shape heuristic only.",
  expires: "2027-01-01",
});
expectClean("decided_on dated TODAY is accepted", { ...BASE, decided_on: "2026-08-18" });

// ── row contract: the violation pole ─────────────────────────────
for (const field of ["target", "artifact", "disposition", "reason", "decided_on", "accepted_by"]) {
  const row = { ...BASE };
  delete row[field];
  expectRejected(`missing ${field} is rejected`, row, field);
}
expectRejected("empty accepted_by is rejected", { ...BASE, accepted_by: "   " }, "accepted_by");
expectRejected(
  "verdict outside the ledger vocabulary is rejected",
  { ...BASE, disposition: "probably-fine" },
  "_disposition_vocabulary",
);
expectRejected(
  "reason shorter than the substantive floor is rejected",
  { ...BASE, reason: "no cascade" },
  `${MIN_REASON_CHARS} characters`,
);
// Padded to clear MIN_REASON_CHARS, so this asserts the RESTATEMENT predicate
// rather than re-asserting the length floor above it.
expectRejected(
  "reason padded to length by repeating the verdict is rejected",
  { ...BASE, reason: "keep-local keep-local keep-local" },
  "restates the verdict",
);
expectRejected(
  "target spelled as a filesystem path is rejected",
  { ...BASE, target: "repos/kailash-rs" },
  "resolver key",
);
// SYNTHETIC ROOT, deliberately. An earlier revision used a real-shaped operator
// home path here and the #263 disclosure gate flagged it — correctly, since
// `audit-fixtures/**` ships on the `cc` tier and would have cascaded that
// literal to every consumer. The predicate under test is the LEADING-SEPARATOR
// alternand, which an obviously-synthetic absolute root exercises identically.
expectRejected(
  "absolute artifact path is rejected (checkout-location leak)",
  { ...BASE, artifact: "/synthetic/producer-root/.claude/hooks/x.js" },
  "absolute path",
);
// Pins a DIFFERENT alternand: a home-directory segment MID-path, with no
// leading separator. Without this case the leading-separator alternand fires
// first on every absolute fixture and the mid-path arm is reachable but never
// asserted. `<operator>` is the placeholder form the #263 scanner itself
// sanctions — its shape regex carries a `(?!<)` lookahead precisely so a
// fixture can name the shape without embedding a real one.
expectRejected(
  "home-directory segment mid-path is rejected (no leading separator)",
  { ...BASE, artifact: "nested/Users/<operator>/x.js" },
  "absolute path",
);
expectRejected(
  "home-relative artifact path is rejected",
  { ...BASE, artifact: "~/repos/kailash-rs/.claude/hooks/x.js" },
  "absolute path",
);
expectRejected(
  "decided_on in the future is rejected",
  { ...BASE, decided_on: "2027-01-01" },
  "FUTURE",
);
expectRejected(
  "malformed decided_on is rejected",
  { ...BASE, decided_on: "18-08-2026" },
  "decided_on",
);
expectRejected(
  "upflow-owed WITHOUT expires is rejected (the action-deferring verdict must age)",
  { ...BASE, disposition: "upflow-owed", reason: "Should cascade to every member of the ecosystem." },
  "expires is required",
);
expectRejected(
  "PAST expires is a hard fail on the action-deferring verdict",
  {
    ...BASE,
    disposition: "upflow-owed",
    reason: "Should cascade to every member of the ecosystem.",
    expires: "2026-08-01",
  },
  "PASSED",
);
expectRejected(
  "PAST expires is a hard fail on a TERMINAL verdict too",
  { ...BASE, disposition: "keep-local", expires: "2026-08-01" },
  "PASSED",
);
expectRejected("malformed expires is rejected", { ...BASE, expires: "next quarter" }, "expires");
expectRejected("a non-object row is rejected", "hooks/x.js", "must be an object");
expectRejected("an array row is rejected", [], "must be an object");

// ── backlog aging ────────────────────────────────────────────────
function backlogErrs(bl) {
  const out = [];
  validateBacklog(bl, out, NOW);
  return out;
}
const FRESH = {
  measured_on: "2026-08-18",
  never_offered: 161,
  offered_not_landed: 28,
  unreadable_producers: 1,
  measurement_ttl_days: 45,
};
check(
  "fresh backlog snapshot is accepted",
  backlogErrs(FRESH).length === 0,
  `expected clean, got ${JSON.stringify(backlogErrs(FRESH))}`,
);
check(
  "snapshot exactly AT its TTL is still accepted",
  backlogErrs({ ...FRESH, measured_on: "2026-07-04" }).length === 0,
  `45d old should be within a 45d TTL, got ${JSON.stringify(backlogErrs({ ...FRESH, measured_on: "2026-07-04" }))}`,
);
check(
  "snapshot PAST its TTL is rejected",
  backlogErrs({ ...FRESH, measured_on: "2026-06-01" }).some((m) => m.includes("STALE")),
  "an 78-day-old snapshot under a 45d TTL was not flagged STALE",
);
check(
  "snapshot dated in the FUTURE is rejected (it could never go stale)",
  backlogErrs({ ...FRESH, measured_on: "2027-01-01" }).some((m) => m.includes("FUTURE")),
  "a future-dated snapshot was accepted",
);
check(
  "non-integer TTL is rejected",
  backlogErrs({ ...FRESH, measurement_ttl_days: "45" }).some((m) => m.includes("ttl_days")),
  "a string TTL was accepted",
);
check(
  "negative count is rejected",
  backlogErrs({ ...FRESH, never_offered: -1 }).some((m) => m.includes("never_offered")),
  "a negative count was accepted",
);
check(
  "absent backlog is rejected",
  backlogErrs(undefined).length > 0,
  "a missing _backlog was accepted",
);

// ── ledger level ─────────────────────────────────────────────────
function withLedger(obj, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "upflow-disp-"));
  try {
    const p = path.join(dir, "ledger.json");
    writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
    return fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LEDGER = {
  _disposition_vocabulary: Object.fromEntries(VOCAB.map((v) => [v, "x"])),
  _grandfathered_before: "2026-08-18",
  _backlog: FRESH,
  dispositions: [],
};

check(
  "a well-formed EMPTY ledger passes",
  withLedger(LEDGER, (p) => checkUpflowDispositions({ ledgerPath: p, now: NOW }).ok),
  "the compliant pole failed",
);
check(
  "a ledger with one well-formed row passes",
  withLedger({ ...LEDGER, dispositions: [{ ...BASE }] }, (p) =>
    checkUpflowDispositions({ ledgerPath: p, now: NOW }).ok,
  ),
  "a valid row was rejected",
);
check(
  "ABSENT dispositions key is fatal, and distinct from empty",
  withLedger({ ...LEDGER, dispositions: undefined }, (p) => {
    const r = checkUpflowDispositions({ ledgerPath: p, now: NOW });
    return r.fatal === true && r.errors.some((m) => m.includes("Absent is not the same as empty"));
  }),
  "a missing dispositions key was not distinguished from an empty one",
);
check(
  "unparseable ledger is FATAL, never a pass",
  withLedger("{ not json", (p) => {
    const r = checkUpflowDispositions({ ledgerPath: p, now: NOW });
    return r.fatal === true && r.ok === false;
  }),
  "a broken ledger did not fail closed",
);
check(
  "missing _grandfathered_before is rejected",
  withLedger({ ...LEDGER, _grandfathered_before: undefined }, (p) =>
    checkUpflowDispositions({ ledgerPath: p, now: NOW }).errors.some((m) =>
      m.includes("_grandfathered_before"),
    ),
  ),
  "the grandfather cutoff was optional",
);
check(
  "duplicate (target, artifact) rows are rejected",
  withLedger({ ...LEDGER, dispositions: [{ ...BASE }, { ...BASE }] }, (p) =>
    checkUpflowDispositions({ ledgerPath: p, now: NOW }).errors.some((m) => m.includes("duplicates")),
  ),
  "the same artifact carried two dispositions silently",
);
check(
  "same artifact under a DIFFERENT target is NOT a duplicate",
  withLedger({ ...LEDGER, dispositions: [{ ...BASE }, { ...BASE, target: "build.py" }] }, (p) =>
    checkUpflowDispositions({ ledgerPath: p, now: NOW }).ok,
  ),
  "two producers were collapsed into one row identity",
);
check(
  "empty _disposition_vocabulary is fatal (no enum to validate against)",
  withLedger({ ...LEDGER, _disposition_vocabulary: {} }, (p) => {
    const r = checkUpflowDispositions({ ledgerPath: p, now: NOW });
    return r.fatal === true;
  }),
  "a ledger with no vocabulary was validated anyway",
);

// ── artifact rot: NOT CHECKED must never read as clean ───────────
check(
  "without a producer probe, artifact-existence reports NOT CHECKED",
  withLedger({ ...LEDGER, dispositions: [{ ...BASE }] }, (p) =>
    checkUpflowDispositions({ ledgerPath: p, now: NOW }).notes.some((m) =>
      m.includes("NOT CHECKED"),
    ),
  ),
  "an unchecked arm rendered silently",
);
check(
  "with a probe reporting ABSENT, the row is flagged STALE",
  withLedger({ ...LEDGER, dispositions: [{ ...BASE }] }, (p) =>
    checkUpflowDispositions({
      ledgerPath: p,
      now: NOW,
      artifactExists: () => false,
    }).warnings.some((m) => m.includes("STALE")),
  ),
  "a decision that outlived its artifact was not flagged",
);
check(
  "with a probe reporting PRESENT, the row is NOT flagged",
  withLedger({ ...LEDGER, dispositions: [{ ...BASE }] }, (p) => {
    const r = checkUpflowDispositions({ ledgerPath: p, now: NOW, artifactExists: () => true });
    return r.warnings.length === 0 && r.notes.some((m) => m.includes("CHECKED against producer"));
  }),
  "a live artifact was flagged stale, or the checked arm did not report",
);

// ── summary ──────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  - ${f.name}: ${f.reason}`);
  process.exit(1);
}
process.exit(0);
