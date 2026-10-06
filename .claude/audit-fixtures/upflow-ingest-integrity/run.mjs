#!/usr/bin/env node
// Audit fixture runner for `.claude/bin/upflow-ingest-integrity.mjs` — the
// integrity gate for `.claude/upflow-ingest-dispositions.json`, the
// INGESTED-vs-ACKNOWLEDGED ledger (F87) and the symmetric twin of
// `upflow-disposition-integrity.mjs`.
//
//   validateRow              — the per-row contract: six required fields, a
//                              target that is a resolver key and not a path, a
//                              target/entry pair that leaks no checkout
//                              location, (target, entry) row identity, a verdict
//                              from the ledger's OWN vocabulary, a substantive
//                              reason that is not the verdict restated, a
//                              receipt on the one verdict that licenses skipping
//                              work, and the calendar rot that is the point
//                              (`expires` REQUIRED on the two action-deferring
//                              verdicts, a PAST `expires` a hard fail on every
//                              verdict incl. terminal ones)
//   validateBacklog          — the aging of the backlog SNAPSHOT, which is how
//                              an untriaged Gate-1 queue stays visible on a
//                              surface CI can reach without CI needing the
//                              cross-repo reads a re-measurement would take
//   checkIngestDispositions  — ledger level: the FATAL arms that exit 2 rather
//                              than 1 (absent ledger, unparseable JSON, absent
//                              or empty `_disposition_vocabulary`, non-array
//                              `dispositions`), cross-row duplicate identity,
//                              and the F87 VACUOUS-PASS FENCE
//   main                     — the EXIT-CODE contract, which is a separate
//                              claim from the error set: 0 clean · 1 findings ·
//                              2 fatal, in both text and `--json` modes
//
// BIPOLAR: every predicate gets a case that must PASS and a case that must FAIL.
// A runner that only ever asserts rejection cannot distinguish a working
// predicate from one that rejects everything — and one that only ever asserts
// acceptance cannot tell a working predicate from one that accepts everything.
//
// Every RED pole asserts a failure IDENTITY — the distinctive part of the
// specific message — never merely "some error" or a non-zero exit
// (`instrument-bipolarity.md` MUST-2). An exit code is a QUANTITY; the reason is
// an IDENTITY, and a pole that would still be satisfied by an unrelated
// reddening is not a case.
//
// The clock is INJECTED (`NOW`) for every predicate that reads one, so these
// fixtures do not start failing on a calendar date. The LIVE gate is what is
// meant to do that. The eight SPAWNED cases cannot inject a clock — `main` reads
// `new Date()` — so each one that needs a fresh backlog DERIVES `measured_on`
// from the same UTC day the gate will read, rather than hardcoding a date that
// would rot.
//
// No fixture reads the live ledger, so editing
// `.claude/upflow-ingest-dispositions.json` changes what the live gate says and
// never silently rewrites what these predicates are asserted to do.
//
// Exits 0 when ALL fixtures pass, non-zero otherwise.
//   node .claude/audit-fixtures/upflow-ingest-integrity/run.mjs

import "../_lib/no-ambient-git.cjs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateRow,
  validateBacklog,
  checkIngestDispositions,
  LEDGER_REL,
  MIN_REASON_CHARS,
  REQUIRED_ROW_FIELDS,
  ACTION_DEFERRING_VERDICTS,
  RECEIPT_REQUIRED_VERDICT,
  REQUIRED_BACKLOG_COUNTS,
  OPTIONAL_BACKLOG_COUNTS,
} from "../../bin/upflow-ingest-integrity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.resolve(HERE, "..", "..", "bin", "upflow-ingest-integrity.mjs");

// Frozen clock. Fixtures assert the PREDICATE, not today's date.
const NOW = Date.parse("2026-08-19T12:00:00Z");

// The ledger's own vocabulary shape: an OBJECT (term -> gloss), not an array.
// The gate reads membership with hasOwnProperty, so the shape is load-bearing.
const VOCAB = {
  landed: "placed at loom; the entry is closed",
  superseded: "canon already carries it",
  declined: "deliberately not ingested",
  "ingest-owed": "placement owed, dated",
  "needs-human": "owner decision owed, dated",
};

const BASE = {
  target: "use-template.rs",
  entry: "rules/agents.md#agent-result-delivery",
  disposition: "superseded",
  reason: "Canon already carries this clause from the 2026-08-11 Gate-1 pass.",
  decided_on: "2026-08-17",
  accepted_by: "repo-owner",
};

let pass = 0;
let fail = 0;
const failures = [];

/**
 * `predicate` may be a boolean or a THUNK. A thunk is evaluated inside a
 * try/catch and a throw becomes a named FAIL.
 *
 * That is not defensive dressing — it is what keeps an empty red-set readable.
 * Measured while building this suite: deleting the non-array `dispositions`
 * fatal arm made the gate throw a TypeError out of `checkIngestDispositions`,
 * which aborted the runner mid-suite. The mutation was CAUGHT, but it produced
 * no FAIL line, so a mutation battery reading red-sets scored it SURVIVED — an
 * inert-looking result from a mutation that was anything but
 * (`instrument-discipline.md` MUST-2(b)). A throw is now a red with the
 * exception as its identity, and the cases after it still run.
 */
function check(name, predicate, reason) {
  let ok = false;
  let thrown = null;
  try {
    ok = typeof predicate === "function" ? predicate() : predicate;
  } catch (e) {
    thrown = e;
  }
  if (thrown !== null) {
    fail++;
    const why = `threw ${thrown && thrown.constructor ? thrown.constructor.name : "?"}: ${thrown && thrown.message}`;
    failures.push({ name, reason: why });
    console.log(`FAIL  ${name}: ${why}`);
  } else if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    // The reason may itself be a thunk, so a diagnostic that needs the values
    // the predicate computed is not built on the (far more common) green path.
    const why = typeof reason === "function" ? reason() : reason;
    failures.push({ name, reason: why });
    console.log(`FAIL  ${name}: ${why}`);
  }
}

/** Row validator errors for `row`, under a fresh identity map unless one is given. */
function errs(row, { now = NOW, vocabulary = VOCAB, seen = new Map() } = {}) {
  const out = [];
  validateRow("fixture", row, out, now, vocabulary, seen);
  return out;
}

function expectClean(name, row, opts) {
  let e = null;
  check(
    name,
    () => {
      e = errs(row, opts);
      return e.length === 0;
    },
    () => `expected no errors, got: ${JSON.stringify(e)}`,
  );
}

/** RED pole. `needle` is the failure IDENTITY, not a count. */
function expectRejected(name, row, needle, opts) {
  let e = null;
  check(
    name,
    () => {
      e = errs(row, opts);
      return e.some((m) => m.toLowerCase().includes(needle.toLowerCase()));
    },
    () => `expected an error mentioning ${JSON.stringify(needle)}, got: ${JSON.stringify(e)}`,
  );
}

// ═══ A. the `now` FUNNEL (bin/upflow-ingest-integrity.mjs:88-98) ═══
// The shared date primitives take a YYYY-MM-DD STRING. A Date handed straight to
// them returns null, and null coerces to 0 in a numeric comparison — so every
// date check would "pass" against the epoch. `isoDay` funnels `now` through one
// place. These cases discriminate: if the funnel broke, todayEndMs would be 0
// and a PAST decided_on would be wrongly flagged FUTURE.
expectClean("now as a NUMBER: a past decided_on is accepted", { ...BASE }, { now: NOW });
expectClean("now as a DATE object: a past decided_on is accepted (the isoDay funnel)", { ...BASE }, {
  now: new Date(NOW),
});
expectRejected(
  "decided_on in the FUTURE is rejected",
  { ...BASE, decided_on: "2027-01-01" },
  "is in the FUTURE",
);
expectClean("decided_on dated TODAY is accepted (a deadline runs to end of day)", {
  ...BASE,
  decided_on: "2026-08-19",
});

// ═══ B. row shape (:106-114) ═══
expectClean("well-formed row is accepted", { ...BASE });
for (const field of REQUIRED_ROW_FIELDS) {
  const row = { ...BASE };
  delete row[field];
  expectRejected(
    `missing ${field} is rejected`,
    row,
    `.${field} is required and must be a non-empty string`,
  );
}
expectRejected(
  "whitespace-only accepted_by is rejected",
  { ...BASE, accepted_by: "   " },
  ".accepted_by is required and must be a non-empty string",
);
expectRejected(
  "a NON-STRING disposition is rejected as a missing field, not silently coerced",
  { ...BASE, disposition: 42 },
  ".disposition is required and must be a non-empty string",
);
expectRejected("a string row is rejected", "rules/agents.md", "must be an object");
expectRejected("an array row is rejected", [], "must be an object");
expectRejected("a null row is rejected", null, "must be an object");
expectClean("a row carrying EXTRA unknown fields is accepted (the contract is a floor)", {
  ...BASE,
  ingested_by: "sync-reviewer",
  wave: 3,
});

// ═══ C. target is a resolver LOGICAL KEY (:116-122) ═══
expectClean("a dotted resolver key is accepted", { ...BASE, target: "use-template.rs" });
expectClean("a bare resolver key is accepted", { ...BASE, target: "build" });
expectRejected(
  "target spelled as a repo-relative path is rejected",
  { ...BASE, target: "repos/kailash-rs" },
  "must be a resolver LOGICAL KEY",
);
expectRejected(
  "target with uppercase is rejected (keys are lowercase)",
  { ...BASE, target: "Use-Template.rs" },
  "must be a resolver LOGICAL KEY",
);
expectRejected(
  "target with a leading dash is rejected",
  { ...BASE, target: "-use-template" },
  "must be a resolver LOGICAL KEY",
);

// ═══ D. no checkout-location leakage in target/entry (:123-129) ═══
// Asserted on `entry`, which carries NO key-shape constraint, so the LEAK
// alternand is what decides each case rather than the target-key regex.
//
// SYNTHETIC ROOTS, deliberately. `audit-fixtures/**` ships on the `cc` tier, so
// a real-shaped operator home embedded here would cascade to every consumer —
// the #263 disclosure gate flagged exactly that in the sibling suite. The
// `<operator>` form is the placeholder the #263 scanner itself sanctions: its
// shape regex carries a `(?!<)` lookahead precisely so a fixture can name the
// shape without embedding one.
expectClean("a repo-relative entry is accepted", { ...BASE, entry: "rules/agents.md#1" });
expectClean(
  "a DEEP repo-relative entry with no home segment is accepted",
  { ...BASE, entry: "nested/plain/dir/notes.md#4" },
);
expectRejected(
  "an ABSOLUTE entry is rejected (leading-separator alternand)",
  { ...BASE, entry: "/synthetic/producer-root/rules/agents.md" },
  ".entry looks like an absolute or home-rooted path",
);
expectRejected(
  "a HOME-RELATIVE entry is rejected (tilde alternand)",
  { ...BASE, entry: "~/repos/synthetic/rules/agents.md" },
  ".entry looks like an absolute or home-rooted path",
);
expectRejected(
  "a WINDOWS drive-letter entry is rejected (drive alternand)",
  { ...BASE, entry: "C:/synthetic/rules/agents.md" },
  ".entry looks like an absolute or home-rooted path",
);
expectRejected(
  "a /Users/ segment MID-path is rejected (no leading separator)",
  { ...BASE, entry: "nested/Users/<operator>/rules/agents.md" },
  ".entry looks like an absolute or home-rooted path",
);
expectRejected(
  "a /home/ segment MID-path is rejected (no leading separator)",
  { ...BASE, entry: "nested/home/<operator>/rules/agents.md" },
  ".entry looks like an absolute or home-rooted path",
);
expectRejected(
  "a leaky TARGET is caught by the leak check, not only by the key check",
  { ...BASE, target: "/synthetic/producer-root" },
  ".target looks like an absolute or home-rooted path",
);

// ═══ E. row IDENTITY — (target, entry) is unique (:131-141) ═══
{
  const seen = new Map();
  errs({ ...BASE }, { seen });
  expectRejected(
    "the SAME (target, entry) pair twice is rejected",
    { ...BASE },
    `duplicates (target=${BASE.target}, entry=${BASE.entry})`,
    { seen },
  );
}
{
  const seen = new Map();
  errs({ ...BASE }, { seen });
  expectClean(
    "the same entry under a DIFFERENT target is NOT a duplicate",
    { ...BASE, target: "use-template.py" },
    { seen },
  );
}
{
  const seen = new Map();
  errs({ ...BASE }, { seen });
  expectClean(
    "a DIFFERENT entry under the same target is NOT a duplicate",
    { ...BASE, entry: "rules/agents.md#triad" },
    { seen },
  );
}

// ═══ F. the verdict enum is the LEDGER's own vocabulary (:143-150) ═══
const VALID_FOR_VERDICT = {
  landed: { receipt: "journal/0578" },
  superseded: {},
  declined: {},
  "ingest-owed": { expires: "2026-12-01" },
  "needs-human": { expires: "2026-12-01" },
};
for (const [verdict, extra] of Object.entries(VALID_FOR_VERDICT)) {
  expectClean(`vocabulary term '${verdict}' is accepted when its own obligations are met`, {
    ...BASE,
    disposition: verdict,
    ...extra,
  });
}
expectRejected(
  "a verdict outside the ledger vocabulary is rejected",
  { ...BASE, disposition: "probably-fine" },
  "is not in the ledger's _disposition_vocabulary",
);
expectRejected(
  "a verdict valid in the SIBLING ledger is rejected here (the enum is read, not shared)",
  { ...BASE, disposition: "keep-local" },
  "is not in the ledger's _disposition_vocabulary",
);

// ═══ G. the substantive-reason floor (:152-157) ═══
expectClean("a reason EXACTLY at the floor is accepted", {
  ...BASE,
  reason: "a".repeat(MIN_REASON_CHARS),
});
expectRejected(
  "a reason one char UNDER the floor is rejected",
  { ...BASE, reason: "a".repeat(MIN_REASON_CHARS - 1) },
  `at least ${MIN_REASON_CHARS} are required`,
);

// ═══ H. the reason is not the verdict restated (:158-160) ═══
// ISOLATION: the restatement check is reachable independently ONLY when the
// verdict itself clears MIN_REASON_CHARS — otherwise the length floor above
// fires first and a case here would be re-asserting THAT predicate. A ledger
// vocabulary is free-form, so a long verdict is a real shape; this local
// vocabulary constructs one so the restatement arm decides on its own.
const LONG_VERDICT = "needs-human-sign-off-and-countersign";
const LONG_VOCAB = { [LONG_VERDICT]: "owner decision owed" };
const LONG_BASE = { ...BASE, disposition: LONG_VERDICT };
check(
  "the isolating verdict really does clear the reason floor (control for the H cases)",
  LONG_VERDICT.length >= MIN_REASON_CHARS,
  `LONG_VERDICT is ${LONG_VERDICT.length} chars, under the ${MIN_REASON_CHARS}-char floor, so the H cases would be re-asserting the floor`,
);
{
  const e = errs({ ...LONG_BASE, reason: LONG_VERDICT }, { vocabulary: LONG_VOCAB });
  check(
    "a reason that RESTATES the verdict is rejected",
    e.some((m) => m.includes("restates the verdict word and says nothing")),
    `expected the restatement identity, got: ${JSON.stringify(e)}`,
  );
  check(
    "...and it is the RESTATEMENT arm deciding, not the length floor",
    !e.some((m) => m.includes("are required")),
    `the length floor also fired, so the restatement arm is not isolated: ${JSON.stringify(e)}`,
  );
}
expectRejected(
  "a restated verdict in a DIFFERENT case is still rejected",
  { ...LONG_BASE, reason: LONG_VERDICT.toUpperCase() },
  "restates the verdict word and says nothing",
  { vocabulary: LONG_VOCAB },
);
expectClean(
  "a reason that merely CONTAINS the verdict word is accepted (equality, not containment)",
  { ...LONG_BASE, reason: `${LONG_VERDICT} was the Gate-1 verdict; the owner has the entry.` },
  { vocabulary: LONG_VOCAB },
);
expectClean(
  "a substantive reason under the long verdict is accepted",
  { ...LONG_BASE, reason: "Routed to the co-owner for a standing-role decision." },
  { vocabulary: LONG_VOCAB },
);

// ═══ I. the receipt, required for the verdict that licenses skipping (:164-174) ═══
check(
  "the receipt-bearing verdict is 'landed' (control for the I cases)",
  RECEIPT_REQUIRED_VERDICT === "landed",
  `RECEIPT_REQUIRED_VERDICT is ${JSON.stringify(RECEIPT_REQUIRED_VERDICT)}; the I cases name 'landed' literally`,
);
expectRejected(
  "'landed' with NO receipt is rejected",
  { ...BASE, disposition: "landed" },
  ".receipt is required for 'landed'",
);
expectRejected(
  "'landed' with a whitespace-only receipt is rejected",
  { ...BASE, disposition: "landed", receipt: "   " },
  ".receipt is required for 'landed'",
);
expectClean("'landed' + a journal slot is accepted", {
  ...BASE,
  disposition: "landed",
  receipt: "journal/0578",
});
expectClean("'landed' + a PR reference is accepted", {
  ...BASE,
  disposition: "landed",
  receipt: "PR #1751",
});
expectClean("'landed' + a short commit SHA is accepted", {
  ...BASE,
  disposition: "landed",
  receipt: "f4d67e1",
});
expectRejected(
  "'landed' + prose that cites nothing is rejected",
  { ...BASE, disposition: "landed", receipt: "the owner said it was placed" },
  "does not look like a durable receipt",
);
expectClean("a NON-landed verdict needs no receipt", { ...BASE, disposition: "superseded" });
expectClean(
  "the receipt SHAPE check is scoped to 'landed' too (a non-landed row's receipt is unchecked)",
  { ...BASE, disposition: "declined", receipt: "the owner said it was placed" },
);

// ═══ J. `expires` is REQUIRED on the action-deferring verdicts (:186-191) ═══
check(
  "the action-deferring verdicts are exactly ['ingest-owed','needs-human'] (control for the J cases)",
  ACTION_DEFERRING_VERDICTS.length === 2 &&
    ACTION_DEFERRING_VERDICTS.includes("ingest-owed") &&
    ACTION_DEFERRING_VERDICTS.includes("needs-human"),
  `ACTION_DEFERRING_VERDICTS is ${JSON.stringify(ACTION_DEFERRING_VERDICTS)}; the J cases name both literally`,
);
for (const verdict of ACTION_DEFERRING_VERDICTS) {
  expectRejected(
    `'${verdict}' WITHOUT expires is rejected (an undated promise is permanent-by-default)`,
    { ...BASE, disposition: verdict },
    `.expires is required for disposition '${verdict}'`,
  );
  expectClean(`'${verdict}' WITH a future expires is accepted`, {
    ...BASE,
    disposition: verdict,
    expires: "2026-12-01",
  });
}
expectClean("terminal 'superseded' WITHOUT expires is accepted", {
  ...BASE,
  disposition: "superseded",
});
expectClean("terminal 'declined' WITHOUT expires is accepted", {
  ...BASE,
  disposition: "declined",
});
expectClean("terminal 'landed' WITHOUT expires is accepted", {
  ...BASE,
  disposition: "landed",
  receipt: "journal/0578",
});

// ═══ K. calendar rot on `expires` (:192-201) ═══
expectRejected(
  "a malformed expires is rejected",
  { ...BASE, disposition: "ingest-owed", expires: "next quarter" },
  ".expires must be a real calendar date",
);
expectRejected(
  "a CALENDAR-INVALID expires is rejected (no silent roll-forward to March 3)",
  { ...BASE, disposition: "ingest-owed", expires: "2026-02-31" },
  ".expires must be a real calendar date",
);
expectRejected(
  "a PAST expires is a hard fail on an action-deferring verdict",
  { ...BASE, disposition: "ingest-owed", expires: "2026-08-01" },
  "PASSED on 2026-08-01",
);
expectRejected(
  "a PAST expires is a hard fail on a TERMINAL verdict too (a decision that cannot rot is a rubber stamp)",
  { ...BASE, disposition: "superseded", expires: "2026-08-01" },
  "PASSED on 2026-08-01",
);
expectClean("an expires dated exactly TODAY is still live", {
  ...BASE,
  disposition: "ingest-owed",
  expires: "2026-08-19",
});
expectClean("a terminal verdict carrying a FUTURE expires is accepted", {
  ...BASE,
  disposition: "declined",
  expires: "2027-01-01",
});

// ═══ L. calendar validity on `decided_on` (:177-184) ═══
expectRejected(
  "a day-first decided_on is rejected",
  { ...BASE, decided_on: "17-08-2026" },
  ".decided_on must be a real calendar date",
);
expectRejected(
  "a CALENDAR-INVALID decided_on is rejected",
  { ...BASE, decided_on: "2026-02-31" },
  ".decided_on must be a real calendar date",
);
expectRejected(
  "a non-date decided_on is rejected",
  { ...BASE, decided_on: "last Tuesday" },
  ".decided_on must be a real calendar date",
);

// ═══ M. the backlog SNAPSHOT and its aging (:204-261) ═══
function backlogErrs(bl, now = NOW) {
  const out = [];
  validateBacklog(bl, out, now);
  return out;
}
/** Backlog poles, thunked for the same reason the row poles are (see `check`). */
function expectBacklogClean(name, bl, reason) {
  let e = null;
  check(
    name,
    () => {
      e = backlogErrs(bl);
      return e.length === 0;
    },
    () => `${reason}; got: ${JSON.stringify(e)}`,
  );
}
function expectBacklogRejected(name, bl, needle, reason) {
  let e = null;
  check(
    name,
    () => {
      e = backlogErrs(bl);
      return e.some((m) => m.includes(needle));
    },
    () => `${reason}. Expected an error mentioning ${JSON.stringify(needle)}, got: ${JSON.stringify(e)}`,
  );
}
// `producers_undrained` is part of the SHARED fixture, not an afterthought on the
// cases that happen to need it. This object declares FIVE pending producers, and
// every ledger built on it carries one or two rows — so before the per-producer
// coverage clause existed, `FRESH` asserted a denominator no fixture satisfied and
// nothing could see the gap. That is the same shape the clause was written to
// catch in the LIVE ledger (43 verdicts, all one target, against a declared five),
// which is why the fixture is made COHERENT here rather than the clause narrowed
// to tiptoe around it: a backlog that declares five pending producers owes an
// account of all five, and a fixture is not exempt from the contract it scaffolds.
//
// The four declared targets are deliberately DISJOINT from the `use-template.*`
// keys the row fixtures use, so coverage is reached by 1 recorded + 4 declared and
// no case trips the already-ingested-lane arm by accident. A fixture that wants to
// make NO claim about producer coverage sets `producers_pending: 1`; several do.
const FRESH = {
  measured_on: "2026-08-18",
  producers_pending: 5,
  entries_total: 322,
  entries_genuinely_open: 145,
  measurement_ttl_days: 45,
  producers_undrained: [
    { target: "build.py", expires: "2099-01-01", reason: "synthetic fixture declaration; not a real lane" },
    { target: "build.rs", expires: "2099-01-01", reason: "synthetic fixture declaration; not a real lane" },
    { target: "build.prism", expires: "2099-01-01", reason: "synthetic fixture declaration; not a real lane" },
    { target: "build.base", expires: "2099-01-01", reason: "synthetic fixture declaration; not a real lane" },
  ],
};
expectBacklogClean("a fresh backlog snapshot is accepted", FRESH, "a fresh snapshot was rejected");

// ── measured_on in the FUTURE disarms the aging arm entirely ──────
// The load-bearing pair in this section. `ageDays > ttl` is the ONLY aging this
// gate has, and a snapshot dated ahead of today makes ageDays NEGATIVE, so that
// comparison is false forever — the arm does not merely mis-report, it retires.
// The RED pole is what keeps the fix from being silently reverted: without it, a
// regression restores a gate that passes every other case in this suite while
// its aging is permanently off. The SYMMETRIC TWIN has always closed this
// (`upflow-disposition-integrity.mjs:262-267`); this gate's omission was a
// porting gap, found by an independent predicate sweep against the twin.
expectBacklogRejected(
  "a FUTURE measured_on is rejected (it would disarm the aging arm permanently)",
  { ...FRESH, measured_on: "2027-01-01" },
  "is in the FUTURE",
  "a snapshot dated ahead of today was accepted, leaving ageDays negative and the TTL arm dead",
);
expectBacklogClean(
  "a measured_on dated exactly TODAY is accepted (the boundary is tomorrow, not today)",
  { ...FRESH, measured_on: "2026-08-19" },
  "a snapshot measured today was wrongly read as future-dated",
);
check(
  "a FUTURE measured_on returns null rather than a negative-age snapshot",
  () => backlogErrs({ ...FRESH, measured_on: "2027-01-01" }).length > 0 && (() => {
    const out = [];
    return validateBacklog({ ...FRESH, measured_on: "2027-01-01" }, out, NOW) === null;
  })(),
  "the future-dated snapshot still returned an age object, so a caller could read ageDays: -135 as a real age",
);
expectBacklogClean(
  "a snapshot exactly AT its TTL is still accepted",
  { ...FRESH, measured_on: "2026-07-05" },
  "45d old under a 45d TTL should pass",
);
expectBacklogRejected(
  "a snapshot one day PAST its TTL is rejected",
  { ...FRESH, measured_on: "2026-07-04" },
  "_backlog is STALE",
  "a 46d-old snapshot under a 45d TTL was not flagged",
);
expectBacklogRejected(
  "an ARRAY backlog is rejected",
  [],
  "_backlog must be an object",
  "an array was accepted as a backlog snapshot",
);
expectBacklogRejected(
  "an ABSENT backlog is rejected",
  undefined,
  "_backlog must be an object",
  "a missing _backlog was accepted",
);
expectBacklogRejected(
  "a NULL backlog is rejected",
  null,
  "_backlog must be an object",
  "a null _backlog was accepted",
);
expectBacklogRejected(
  "a malformed measured_on is rejected",
  { ...FRESH, measured_on: "18-08-2026" },
  "_backlog.measured_on must be a real calendar date",
  "a day-first measured_on was accepted",
);
expectBacklogRejected(
  "a CALENDAR-INVALID measured_on is rejected",
  { ...FRESH, measured_on: "2026-02-31" },
  "_backlog.measured_on must be a real calendar date",
  "2026-02-31 was accepted; a silent roll-forward would misdate the snapshot",
);
for (const [label, ttl] of [
  ["a STRING ttl", "45"],
  ["a ZERO ttl", 0],
  ["a NEGATIVE ttl", -1],
  ["a FRACTIONAL ttl", 45.5],
]) {
  expectBacklogRejected(
    `${label} is rejected`,
    { ...FRESH, measurement_ttl_days: ttl },
    "_backlog.measurement_ttl_days must be a positive integer",
    `${label} was accepted`,
  );
}
expectBacklogRejected(
  "a NEGATIVE producers_pending is rejected",
  { ...FRESH, producers_pending: -1 },
  "_backlog.producers_pending must be a non-negative integer",
  "a negative count was accepted",
);
expectBacklogRejected(
  "an ABSENT entries_total is rejected",
  { ...FRESH, entries_total: undefined },
  "_backlog.entries_total must be a non-negative integer",
  "a missing count was accepted",
);
expectBacklogRejected(
  "a STRING entries_genuinely_open is rejected",
  { ...FRESH, entries_genuinely_open: "145" },
  "_backlog.entries_genuinely_open must be a non-negative integer",
  "a stringly-typed count was accepted",
);
expectBacklogClean(
  "counts of ZERO are accepted (non-negative includes zero)",
  { ...FRESH, producers_pending: 0, entries_total: 0, entries_genuinely_open: 0 },
  "a genuinely drained queue was rejected",
);
expectBacklogClean(
  "extra descriptive backlog fields are accepted (the live snapshot carries provenance prose)",
  { ...FRESH, measured_by: "Gate-1 ingest ledger", _doc: "counts with denominators" },
  "the snapshot's own provenance fields were rejected",
);
// ── the OPTIONAL count is now VALIDATED-IF-PRESENT ────────────────────────
// This REPLACES a scope pin that asserted `entries_closing_with_no_work: -1` was
// accepted. That pin was honest about the hole and explicitly invited this edit
// ("if a fourth field joins the loop, this case REDS and gets updated"), so this
// is the deliberate widening it asked for, not a surprise.
//
// The hole was not a forgotten field. It was that membership of a hand-written
// list, rather than BEING a count, decided whether a count got checked — the
// same shape as the two other findings in this change.
//
// VALIDATED-IF-PRESENT, deliberately, not REQUIRED: the field is a real key in
// the live snapshot but nothing downstream reads it, and `FRESH` (this suite's
// own base) does not carry it. Requiring it would reject every snapshot
// predating the field — including most cases in this file — for no gain.
const OPTIONAL_COUNT_ID = "_backlog.entries_closing_with_no_work is PRESENT but is not a non-negative integer";
for (const [label, val] of [
  ["a NEGATIVE", -1],
  ["a STRINGLY-TYPED", "166"],
  ["a FRACTIONAL", 1.5],
  ["a NULL", null],
]) {
  expectBacklogRejected(
    `${label} entries_closing_with_no_work is rejected when PRESENT`,
    { ...FRESH, entries_closing_with_no_work: val },
    OPTIONAL_COUNT_ID,
    `${label} optional count was accepted because it was not on the required list`,
  );
}
expectBacklogClean(
  "an ABSENT entries_closing_with_no_work is accepted (optional means optional)",
  { ...FRESH },
  "the optional count was made REQUIRED, which rejects every snapshot predating the field",
);
expectBacklogClean(
  "a VALID entries_closing_with_no_work is accepted, including zero",
  { ...FRESH, entries_closing_with_no_work: 0 },
  "a legitimate optional count was rejected",
);
expectBacklogClean(
  "the LIVE snapshot's own value for the optional count is accepted",
  { ...FRESH, entries_closing_with_no_work: 166 },
  "the value carried by the real ledger would now red the gate",
);
// CONTROL: the required/optional split is a real distinction, not two names for
// one behaviour. An ABSENT required count reds; an ABSENT optional count does
// not. Without this pole, making everything required would still pass the cases
// above.
check(
  "CONTROL: absence separates the REQUIRED counts from the OPTIONAL one",
  () => {
    const reqAbsent = [];
    validateBacklog({ ...FRESH, entries_total: undefined }, reqAbsent, NOW);
    const optAbsent = [];
    validateBacklog({ ...FRESH }, optAbsent, NOW);
    // IDENTITY, not a count. An earlier revision asserted `reqAbsent.length === 1`
    // and a review mutation that replaced the required-count message with
    // "something went wrong somewhere" left this case GREEN — it would have been
    // satisfied by the required arm reddening for any unrelated reason
    // (`instrument-bipolarity.md` MUST-2).
    return (
      reqAbsent.some((m) => m.includes("_backlog.entries_total must be a non-negative integer")) &&
      optAbsent.length === 0
    );
  },
  "a required and an optional count behaved identically under absence, so the split is not real",
);
// SCOPE PIN, NARROWED but still honest. The loops now cover the three required
// counts plus the one declared optional count. A count field on NEITHER list is
// still unvalidated — the boundary moved, it did not disappear. This case pins
// the new edge so the NEXT widening is also deliberate.
expectBacklogClean(
  "SCOPE: a count field on neither the required nor the optional list is still unvalidated",
  { ...FRESH, entries_awaiting_triage: -1 },
  "the count check has widened past the two declared lists; add the field to OPTIONAL_BACKLOG_COUNTS and update this case and the README scope bound",
);
check(
  "CONTROL: the two declared lists are exactly what the cases above name literally",
  () =>
    JSON.stringify([...REQUIRED_BACKLOG_COUNTS]) ===
      JSON.stringify(["producers_pending", "entries_total", "entries_genuinely_open"]) &&
    JSON.stringify([...OPTIONAL_BACKLOG_COUNTS]) === JSON.stringify(["entries_closing_with_no_work"]),
  () =>
    `REQUIRED_BACKLOG_COUNTS is ${JSON.stringify(REQUIRED_BACKLOG_COUNTS)} and OPTIONAL_BACKLOG_COUNTS is ${JSON.stringify(OPTIONAL_BACKLOG_COUNTS)}; the cases above name their members literally`,
);

// ═══ N. ledger level — the FATAL arms (:300-352) ═══
function withLedger(obj, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "upflow-ingest-"));
  try {
    const p = path.join(dir, "ledger.json");
    writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
    return fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LEDGER = {
  _disposition_vocabulary: VOCAB,
  _backlog: FRESH,
  dispositions: [],
};
/** A ledger whose backlog reports a DRAINED queue, so the F87 fence is silent. */
const DRAINED = { ...LEDGER, _backlog: { ...FRESH, entries_genuinely_open: 0 } };

check(
  "an ABSENT ledger file is FATAL, and names the path",
  () => {
    const r = checkIngestDispositions({
      ledgerPath: path.join(tmpdir(), "upflow-ingest-does-not-exist", "ledger.json"),
      now: NOW,
    });
    return r.fatal === true && r.ok === false && r.errors.some((m) => m.includes("ledger not found at"));
  },
  "a missing ledger did not fail closed with its own identity",
);
check(
  "an UNPARSEABLE ledger is FATAL, never a pass",
  () => withLedger("{ not json", (p) => {
    const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
    return r.fatal === true && r.ok === false && r.errors.some((m) => m.includes("ledger is unparseable"));
  }),
  "a broken ledger did not fail closed with its own identity",
);
for (const [label, vocab] of [
  ["an ABSENT", undefined],
  ["an EMPTY", {}],
  ["a NULL", null],
]) {
  check(
    `${label} _disposition_vocabulary is FATAL (an absent enum would accept ANY verdict)`,
    () => withLedger({ ...DRAINED, _disposition_vocabulary: vocab }, (p) => {
      const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
      return r.fatal === true && r.errors.some((m) => m.includes("_disposition_vocabulary is missing or empty"));
    }),
    `${label} vocabulary was validated against anyway`,
  );
}

// ── an ARRAY vocabulary is FATAL, with its OWN identity ────────────────────
// This REPLACES a scope pin that asserted the opposite, and the replacement is
// the point of the case. The old pin read "a NON-EMPTY ARRAY vocabulary is not
// fatal, but rejects EVERY verdict" — and the second half was FALSE when it was
// written. Measured: membership is `hasOwnProperty` over an array, whose own
// keys are its INDICES plus `length`, so `"length"`, `"0"`, `"1"` are ACCEPTED
// while real verdicts are rejected. The pin therefore described the hole as
// loud-but-safe when it had a silent arm, which is what licensed leaving it
// open. An empty array joins this arm too: the defect is the SHAPE, and
// diagnosing `[]` as "missing or empty" pointed at the wrong repair.
const ARRAY_VOCAB_ID = "_disposition_vocabulary is an ARRAY";
for (const [label, vocab] of [
  ["an EMPTY-ARRAY", []],
  ["a NON-EMPTY ARRAY", ["landed"]],
  ["a NON-EMPTY ARRAY of several terms", ["landed", "superseded", "declined"]],
]) {
  check(
    `${label} _disposition_vocabulary is FATAL and names the SHAPE, not the emptiness`,
    () => withLedger({ ...DRAINED, _disposition_vocabulary: vocab, dispositions: [{ ...BASE }] }, (p) => {
      const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
      return r.fatal === true && r.ok === false && r.errors.some((m) => m.includes(ARRAY_VOCAB_ID));
    }),
    `${label} vocabulary did not fail closed with the array identity`,
  );
}
check(
  "the ARRAY arm is reached BEFORE the missing-or-empty arm, so an empty array is not misdiagnosed",
  () => withLedger({ ...DRAINED, _disposition_vocabulary: [] }, (p) => {
    const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
    return (
      r.errors.some((m) => m.includes(ARRAY_VOCAB_ID)) &&
      !r.errors.some((m) => m.includes("_disposition_vocabulary is missing or empty"))
    );
  }),
  "an empty array still emitted the missing-or-empty diagnosis, which points at the wrong repair",
);
// THE QUIET ARM, pinned so it cannot silently return. `"length"` is an array's
// own property, so under the OLD gate this ledger exited 0 with ZERO errors —
// and because `"length"` is neither the receipt-bearing verdict nor an
// action-deferring one, it owed no receipt and no `expires` either. This is the
// case the replaced scope pin asserted could not happen.
// NAMED for what they actually assert. An earlier revision called these "a row
// dispositioned X ... is REJECTED", which implied a per-ROW rejection that never
// happens: the ARRAY arm returns before any row is read (`rows: 0`), so the row
// is never reached. Adversarial review caught the overclaim. The cases still earn
// their place — they pin that the three strings an array's own keys WOULD have
// admitted cannot reach the enum at all — but the name now says so.
for (const junkVerdict of ["length", "0", "1"]) {
  check(
    `a ledger whose row is dispositioned ${JSON.stringify(junkVerdict)} never reaches the enum: the ARRAY arm stops it first (the quiet arm, closed)`,
    () => withLedger(
      {
        ...DRAINED,
        _disposition_vocabulary: ["landed", "ingest-owed"],
        dispositions: [{ ...BASE, disposition: junkVerdict }],
      },
      (p) => {
        const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
        return r.ok === false && r.fatal === true && r.errors.some((m) => m.includes(ARRAY_VOCAB_ID));
      },
    ),
    `${JSON.stringify(junkVerdict)} was accepted as a verdict because it is an array's own property`,
  );
}
check(
  "CONTROL: those same junk verdicts ARE rejected under a well-formed OBJECT vocabulary",
  () => ["length", "0", "1"].every((v) => {
    const e = errs({ ...BASE, disposition: v });
    return e.some((m) => m.includes("is not in the ledger's _disposition_vocabulary"));
  }),
  "an object vocabulary accepted an array's own property name, so the quiet-arm cases above prove nothing about the array",
);
check(
  "CONTROL: an array vocabulary is genuinely DISTINGUISHABLE from an object one (both poles, one call)",
  () => {
    const asArray = withLedger({ ...DRAINED, _disposition_vocabulary: ["landed"], dispositions: [{ ...BASE }] }, (p) =>
      checkIngestDispositions({ ledgerPath: p, now: NOW }),
    );
    const asObject = withLedger({ ...DRAINED, _disposition_vocabulary: VOCAB, dispositions: [{ ...BASE }] }, (p) =>
      checkIngestDispositions({ ledgerPath: p, now: NOW }),
    );
    return asArray.fatal === true && asObject.fatal === false && asObject.ok === true;
  },
  "the array and object poles did not separate, so the array arm is not discriminating",
);
for (const [label, rows] of [
  ["an ABSENT", undefined],
  ["an OBJECT", { 0: BASE }],
  ["a STRING", "none yet"],
]) {
  check(
    `${label} 'dispositions' is FATAL`,
    () => withLedger({ ...DRAINED, dispositions: rows }, (p) => {
      const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
      return r.fatal === true && r.errors.some((m) => m.includes("`dispositions` must be an array"));
    }),
    `${label} dispositions value was iterated anyway`,
  );
}
check(
  "a well-formed ledger with one row PASSES",
  () => withLedger({ ...DRAINED, dispositions: [{ ...BASE }] }, (p) => {
    const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
    return r.ok === true && r.fatal === false && r.rows === 1;
  }),
  "the compliant ledger pole failed",
);
check(
  "a broken ROW is a FINDING, not FATAL — the two exit classes stay distinct",
  () => withLedger({ ...DRAINED, dispositions: [{ ...BASE, disposition: "probably-fine" }] }, (p) => {
    const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
    return (
      r.fatal === false &&
      r.ok === false &&
      r.errors.some((m) => m.includes("is not in the ledger's _disposition_vocabulary"))
    );
  }),
  "a row-level defect was conflated with an unreadable ledger",
);

// ═══ O. the F87 VACUOUS-PASS FENCE (:430-451) ═══
const FENCE_ID = "genuinely-open entries but 'dispositions' is EMPTY";
check(
  "an EMPTY ledger against an OPEN backlog is rejected (the vacuous pass)",
  () => withLedger(LEDGER, (p) =>
    checkIngestDispositions({ ledgerPath: p, now: NOW }).errors.some((m) => m.includes(FENCE_ID)),
  ),
  "zero recorded verdicts against 145 genuinely-open entries passed",
);
check(
  "the fence fires at the BOUNDARY of one genuinely-open entry",
  () => withLedger({ ...LEDGER, _backlog: { ...FRESH, entries_genuinely_open: 1 } }, (p) =>
    checkIngestDispositions({ ledgerPath: p, now: NOW }).errors.some((m) => m.includes(FENCE_ID)),
  ),
  "a single open entry did not trip the fence",
);
check(
  "an EMPTY ledger against a DRAINED backlog PASSES (the case an empty ledger legitimately describes)",
  () => withLedger(DRAINED, (p) => checkIngestDispositions({ ledgerPath: p, now: NOW }).ok === true),
  "a genuinely drained queue was flagged",
);
check(
  "an OPEN backlog with at least one recorded verdict PASSES (the fence is narrow)",
  () => withLedger({ ...LEDGER, dispositions: [{ ...BASE }] }, (p) =>
    checkIngestDispositions({ ledgerPath: p, now: NOW }).ok === true,
  ),
  "the fence fired on a ledger that had recorded a verdict",
);
check(
  "an ABSENT backlog cannot silently SATISFY the fence — it reds as a backlog defect instead",
  () => withLedger({ ...LEDGER, _backlog: undefined }, (p) => {
    const e = checkIngestDispositions({ ledgerPath: p, now: NOW }).errors;
    return e.some((m) => m.includes("_backlog must be an object")) && !e.some((m) => m.includes(FENCE_ID));
  }),
  "a missing snapshot either satisfied the fence or misreported which predicate failed",
);
check(
  "a STRINGLY-TYPED open count cannot satisfy the fence either",
  () => withLedger({ ...LEDGER, _backlog: { ...FRESH, entries_genuinely_open: "145" } }, (p) => {
    const e = checkIngestDispositions({ ledgerPath: p, now: NOW }).errors;
    return (
      e.some((m) => m.includes("_backlog.entries_genuinely_open must be a non-negative integer")) &&
      !e.some((m) => m.includes(FENCE_ID))
    );
  }),
  "a non-integer count was read as a satisfied fence",
);

// ═══ O2. the fence counts RECORDED VERDICTS, not ROWS ═══
//
// The fence's operand was `rows.length === 0`, so ONE malformed row disarmed it:
// `rows.length` became 1, the fence went quiet, and that same row independently
// failed validation. One junk row both failed loudly AND silenced the clause
// built to catch emptiness.
//
// WHAT THIS FIX IS, STATED HONESTLY so no later reader over-reads these cases:
// it changes NO exit code. Measured while making it — no row value produces zero
// errors while being junk, so any ledger that disarms the fence this way is
// ALREADY red from the row finding. The defect it closes is that the gate said
// something FALSE while reddening ("'dispositions' is EMPTY" about a ledger
// holding rows), and that the fence's two operands were held to different
// standards: the backlog count was read only when it "parsed as a real count",
// while the rows operand counted anything present. The cases below pin the
// symmetry, not a new refusal.
const FENCE_INVALID_ID = "but NONE of them VALIDATED";
const JUNK_ROW = { target: "use-template.rs" }; // missing five required fields
check(
  "ONE malformed row no longer DISARMS the fence",
  () => withLedger({ ...LEDGER, dispositions: [JUNK_ROW] }, (p) => {
    const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
    return r.ok === false && r.recordedVerdicts === 0 && r.errors.some((m) => m.includes(FENCE_INVALID_ID));
  }),
  "a single junk row silenced the vacuous-pass fence, which is the defect this section exists to pin",
);
check(
  "the rows-present arm does NOT claim the ledger is EMPTY (the message states what is true)",
  () => withLedger({ ...LEDGER, dispositions: [JUNK_ROW] }, (p) => {
    const e = checkIngestDispositions({ ledgerPath: p, now: NOW }).errors;
    return e.some((m) => m.includes(FENCE_INVALID_ID)) && !e.some((m) => m.includes(FENCE_ID));
  }),
  "the fence reported a ledger holding rows as EMPTY, which is a false claim about the code's own subject",
);
check(
  "the EMPTY arm still fires with its ORIGINAL identity when there really are no rows",
  () => withLedger(LEDGER, (p) => {
    const e = checkIngestDispositions({ ledgerPath: p, now: NOW }).errors;
    return e.some((m) => m.includes(FENCE_ID)) && !e.some((m) => m.includes(FENCE_INVALID_ID));
  }),
  "the two message arms are not distinct, so the fence cannot say WHICH vacuous state it found",
);
check(
  "MANY rows, none valid, still counts as zero recorded verdicts",
  () => withLedger({ ...LEDGER, dispositions: [JUNK_ROW, JUNK_ROW, JUNK_ROW] }, (p) => {
    const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
    return r.rows === 3 && r.recordedVerdicts === 0 && r.errors.some((m) => m.includes(FENCE_INVALID_ID));
  }),
  "a pile of junk rows satisfied the fence by sheer count",
);
check(
  "ONE valid row among junk ones SILENCES the fence (it is still narrow)",
  () => withLedger({ ...LEDGER, dispositions: [JUNK_ROW, { ...BASE }] }, (p) => {
    const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
    return (
      r.ok === false &&
      r.recordedVerdicts === 1 &&
      !r.errors.some((m) => m.includes(FENCE_INVALID_ID)) &&
      !r.errors.some((m) => m.includes(FENCE_ID))
    );
  }),
  "the fence fired despite a genuinely recorded verdict, which widens it past its stated scope",
);
// The COUNTING RULE, pinned per class. A recorded verdict is a row the gate
// found NOTHING wrong with — so a well-formed-but-EXPIRED row, a duplicate-pair
// second half, and a too-short reason all fail to count. Each is a row a later
// session must not rely on, which is the fence's actual subject.
check(
  "an EXPIRED but otherwise well-formed row does NOT count as a recorded verdict",
  () => withLedger(
    { ...LEDGER, dispositions: [{ ...BASE, disposition: "ingest-owed", expires: "2026-01-01" }] },
    (p) => {
      const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
      return r.recordedVerdicts === 0 && r.errors.some((m) => m.includes(FENCE_INVALID_ID));
    },
  ),
  "a rotted decision was counted as a verdict a later session may rely on",
);
check(
  "the SECOND half of a duplicate pair does not count, but the FIRST does",
  () => withLedger({ ...LEDGER, dispositions: [{ ...BASE }, { ...BASE }] }, (p) => {
    const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
    // IDENTITY, not a count. An earlier revision asserted only the counts, and a
    // review mutation replacing the duplicate message with "some other complaint
    // entirely" left this case GREEN (`instrument-bipolarity.md` MUST-2).
    return (
      r.rows === 2 &&
      r.recordedVerdicts === 1 &&
      r.errors.some((m) => m.includes(`duplicates (target=${BASE.target}, entry=${BASE.entry})`)) &&
      !r.errors.some((m) => m.includes(FENCE_INVALID_ID))
    );
  }),
  "duplicate rows were both counted or both discarded; exactly one of the pair is a usable verdict",
);
// SCOPE PIN — the count is ORDER-DEPENDENT under a duplicate key, and this pins
// BOTH orders so the asymmetry is recorded rather than discovered. The `seen` map
// registers a (target, entry) pair for the FIRST row carrying it, valid or not,
// so a malformed row sorting ahead of a well-formed one with the SAME key takes
// the slot and the well-formed row is flagged duplicate. Both orders red; only
// the MESSAGE differs. Surfaced by adversarial review, not closed here — see the
// gate's own note at the fence for why, and what closing it would cost.
const DUP_KEY_JUNK = { ...BASE, reason: "short" };
check(
  "SCOPE: a malformed row sorting FIRST takes the duplicate slot, so the valid twin does not count",
  () => withLedger({ ...LEDGER, dispositions: [DUP_KEY_JUNK, { ...BASE }] }, (p) => {
    const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
    return (
      r.recordedVerdicts === 0 &&
      r.errors.some((m) => m.includes("chars; at least")) &&
      r.errors.some((m) => m.includes(`duplicates (target=${BASE.target}`)) &&
      r.errors.some((m) => m.includes(FENCE_INVALID_ID))
    );
  }),
  "the order-dependence this case pins has changed; update it and the gate's fence note together",
);
check(
  "SCOPE: the SAME two rows in the OPPOSITE order record one verdict (the asymmetry, pinned)",
  () => withLedger({ ...LEDGER, dispositions: [{ ...BASE }, DUP_KEY_JUNK] }, (p) => {
    const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
    return r.recordedVerdicts === 1 && !r.errors.some((m) => m.includes(FENCE_INVALID_ID));
  }),
  "the two orders no longer differ; if the order-dependence was closed, retire both SCOPE cases together",
);
check(
  "recordedVerdicts equals rows.length on a CLEAN ledger (the two only diverge on a finding)",
  () => withLedger({ ...DRAINED, dispositions: [{ ...BASE }, { ...BASE, entry: "rules/git.md#ci" }] }, (p) => {
    const r = checkIngestDispositions({ ledgerPath: p, now: NOW });
    return r.ok === true && r.rows === 2 && r.recordedVerdicts === 2;
  }),
  "the fence operand diverged from the row count on a ledger with nothing wrong with it",
);
// ── BOTH operands must survive validation, not just the rows one ──────────
// The fence reads `entries_genuinely_open` only when `validateBacklog` added NO
// error. Without this, a snapshot the gate had just REJECTED could still arm the
// fence and put its count into the message — an unfounded claim sourced from a
// reading that failed. Each pole below is a backlog `validateBacklog` rejects for
// a DIFFERENT reason; all four previously armed the fence. Found by adversarial
// review of this change, against a comment that claimed the symmetry before the
// code delivered it.
for (const [label, bl] of [
  ["a FUTURE-dated", { ...FRESH, measured_on: "2099-01-01" }],
  ["a STALE", { ...FRESH, measured_on: "2026-01-01" }],
  ["a bad-TTL", { ...FRESH, measurement_ttl_days: 0 }],
  ["a counts-missing", { measured_on: "2026-08-16", measurement_ttl_days: 45, entries_genuinely_open: 145 }],
]) {
  check(
    `${label} backlog cannot ARM the fence, even with an empty ledger`,
    () => withLedger({ ...LEDGER, _backlog: bl }, (p) => {
      const e = checkIngestDispositions({ ledgerPath: p, now: NOW }).errors;
      return (
        e.length > 0 && !e.some((m) => m.includes(FENCE_ID)) && !e.some((m) => m.includes(FENCE_INVALID_ID))
      );
    }),
    `${label} backlog armed the fence, so the fence quoted a count from a snapshot whose reading had FAILED`,
  );
}
check(
  "CONTROL: the SAME empty ledger with a SOUND backlog DOES arm the fence",
  () => withLedger(LEDGER, (p) =>
    checkIngestDispositions({ ledgerPath: p, now: NOW }).errors.some((m) => m.includes(FENCE_ID)),
  ),
  "the fence no longer fires on a sound open backlog, so the soundness gate has disarmed it entirely",
);
// CONTROL. Without this pole, a fence hardwired to fire whenever ANY row is
// invalid would pass every case above. It must stay SILENT when the backlog
// reports a drained queue, however broken the rows are.
check(
  "CONTROL: a DRAINED backlog keeps the fence silent even when every row is junk",
  () => withLedger({ ...DRAINED, dispositions: [JUNK_ROW] }, (p) => {
    const e = checkIngestDispositions({ ledgerPath: p, now: NOW }).errors;
    return (
      !e.some((m) => m.includes(FENCE_INVALID_ID)) &&
      !e.some((m) => m.includes(FENCE_ID)) &&
      e.some((m) => m.includes("is required and must be a non-empty string"))
    );
  }),
  "the fence fired on a drained queue, so it is keying on row validity alone rather than on the vacuous state",
);

// ═══ P. cross-row identity at the ledger level (:354-364) ═══
check(
  "two IDENTICAL rows in one ledger are rejected (the seen map spans the array)",
  () => withLedger({ ...DRAINED, dispositions: [{ ...BASE }, { ...BASE }] }, (p) =>
    checkIngestDispositions({ ledgerPath: p, now: NOW }).errors.some((m) =>
      m.includes(`duplicates (target=${BASE.target}, entry=${BASE.entry})`),
    ),
  ),
  "one entry carried two verdicts silently",
);
check(
  "two rows differing only in entry are NOT duplicates",
  () => withLedger(
    { ...DRAINED, dispositions: [{ ...BASE }, { ...BASE, entry: "rules/agents.md#triad" }] },
    (p) => checkIngestDispositions({ ledgerPath: p, now: NOW }).ok === true,
  ),
  "two distinct entries were collapsed into one row identity",
);

// ═══ Q. the EXIT-CODE contract (main, :496-544) ═══
//
// Spawned, because an exit code is a claim `checkIngestDispositions` cannot
// make. `main` reads `new Date()` with no injection point, so every case that
// needs a FRESH backlog derives `measured_on` from the same UTC day the gate
// will read. That is the opposite of hardcoding a date: it keeps these cases
// true on any host on any day. No case here asserts how fast or what day the
// host is.
const TODAY_UTC = new Date().toISOString().slice(0, 10);
const SPAWN_BACKLOG = { ...FRESH, measured_on: TODAY_UTC, entries_genuinely_open: 0 };

/** Run the gate with COC_REPO_ROOT pointed at a throwaway tree. */
function runGate(ledgerObjOrNull, args = []) {
  const root = mkdtempSync(path.join(tmpdir(), "upflow-ingest-root-"));
  try {
    if (ledgerObjOrNull !== null) {
      const p = path.join(root, LEDGER_REL);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, typeof ledgerObjOrNull === "string" ? ledgerObjOrNull : JSON.stringify(ledgerObjOrNull));
    }
    const r = spawnSync(process.execPath, [GATE, ...args], {
      encoding: "utf8",
      env: { ...process.env, COC_REPO_ROOT: root },
    });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const CLEAN_LEDGER = { _disposition_vocabulary: VOCAB, _backlog: SPAWN_BACKLOG, dispositions: [] };
const FINDING_LEDGER = {
  _disposition_vocabulary: VOCAB,
  _backlog: SPAWN_BACKLOG,
  dispositions: [{ ...BASE, accepted_by: "" }],
};

{
  const r = runGate(null);
  check(
    "EXIT 2 on an absent ledger, with the FATAL banner and the path",
    r.status === 2 && r.stderr.includes("upflow-ingest-integrity: FATAL") && r.stderr.includes("ledger not found at"),
    `got exit ${r.status}, stderr ${JSON.stringify(r.stderr.slice(0, 300))}`,
  );
}
{
  const r = runGate("{ not json");
  check(
    "EXIT 2 on an unparseable ledger",
    r.status === 2 && r.stderr.includes("ledger is unparseable"),
    `got exit ${r.status}, stderr ${JSON.stringify(r.stderr.slice(0, 300))}`,
  );
}
{
  const r = runGate(FINDING_LEDGER);
  check(
    "EXIT 1 on a row-level finding, naming the field — NOT the fatal code",
    r.status === 1 &&
      r.stderr.includes("upflow-ingest-integrity: FAIL") &&
      r.stderr.includes(".accepted_by is required and must be a non-empty string"),
    `got exit ${r.status}, stderr ${JSON.stringify(r.stderr.slice(0, 300))}`,
  );
}
{
  const r = runGate(CLEAN_LEDGER);
  check(
    "EXIT 0 on a clean ledger, with the PASS banner",
    r.status === 0 && r.stdout.includes("upflow-ingest-integrity: PASS"),
    `got exit ${r.status}, stdout ${JSON.stringify(r.stdout.slice(0, 300))}, stderr ${JSON.stringify(r.stderr.slice(0, 300))}`,
  );
}
{
  const r = runGate(CLEAN_LEDGER, ["--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    /* left null; the check below names it */
  }
  check(
    "--json on a clean ledger: exit 0 and parseable {ok:true, fatal:false}",
    r.status === 0 && parsed !== null && parsed.ok === true && parsed.fatal === false,
    `got exit ${r.status}, stdout ${JSON.stringify(r.stdout.slice(0, 300))}`,
  );
}
{
  const r = runGate("{ not json", ["--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    /* left null; the check below names it */
  }
  check(
    "--json on an unparseable ledger: exit 2 and parseable {fatal:true}",
    r.status === 2 && parsed !== null && parsed.fatal === true && parsed.ok === false,
    `got exit ${r.status}, stdout ${JSON.stringify(r.stdout.slice(0, 300))}`,
  );
}
{
  const r = runGate(FINDING_LEDGER, ["--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    /* left null; the check below names it */
  }
  check(
    "--json on a finding: exit 1 and {ok:false, fatal:false} — the two failure classes stay distinct",
    r.status === 1 && parsed !== null && parsed.ok === false && parsed.fatal === false,
    `got exit ${r.status}, stdout ${JSON.stringify(r.stdout.slice(0, 300))}`,
  );
}
{
  // The gate's OWN bipolar selftest (:467-494). Its red pole matches the
  // receipt-missing identity rather than counting errors, so a gate that
  // reddened for an unrelated reason would not satisfy it. Pinned GREEN only —
  // reddening it needs a mutation of the gate under test, which this runner
  // must not perform. Named as a bound in the README rather than left implied.
  const r = runGate(null, ["--selftest"]);
  check(
    "--selftest exits 0 and reports its poles DISCRIMINATED",
    r.status === 0 && r.stdout.includes("SELFTEST PASS") && r.stdout.includes("identity-matched=true"),
    `got exit ${r.status}, stdout ${JSON.stringify(r.stdout.slice(0, 300))}`,
  );
}

// ═══ summary ═══
console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  - ${f.name}: ${f.reason}`);
  process.exit(1);
}
process.exit(0);
