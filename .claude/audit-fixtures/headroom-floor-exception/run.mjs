#!/usr/bin/env node
// Audit fixture runner for the loom#1355 per-lane headroom-floor exception
// mechanism in `.claude/bin/emit.mjs`:
//
//   resolveHeadroomException   — the scope-restriction predicate (which lane,
//                                which CLI, still in force?)
//   effectiveHeadroomFloorPct  — floor composition (grant may only move the
//                                floor the way it declared)
//   parseHeadroomExceptions    — fail-closed declaration parsing (a malformed
//                                waiver THROWS; it never degrades to "no floor")
//
// Every fixture is self-contained: no fixture reads the live sync-manifest.yaml,
// so a manifest edit changes the live gate but never silently rewrites what
// these predicates are asserted to do.
//
// Exits 0 when ALL fixtures pass, non-zero otherwise.
//   node .claude/audit-fixtures/headroom-floor-exception/run.mjs

import {
  resolveHeadroomException,
  effectiveHeadroomFloorPct,
  parseHeadroomExceptions,
  HEADROOM_EXCEPTION_MIN_FLOOR_PCT,
} from "../../bin/emit.mjs";

// The live declaration's shape, inlined so the fixtures are hermetic.
const RS = {
  lane: "rs",
  clis: ["codex", "gemini"],
  granted_floor_pct: 8.5,
  expires: "2026-10-31",
  issue: "1355",
};
const EXCEPTIONS = [RS];

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

// ── resolveHeadroomException — scope restriction ────────────────────────────
const resolveFixtures = [
  {
    name: "fixture-01-declared-lane-declared-cli-in-force",
    input: { cli: "codex", lang: "rs", exceptions: EXCEPTIONS, now: "2026-07-26" },
    // The one granted case: lane matches, cli is named, date is before expiry.
    expect: "exception",
  },
  {
    name: "fixture-02-second-declared-cli-also-covered",
    input: { cli: "gemini", lang: "rs", exceptions: EXCEPTIONS, now: "2026-07-26" },
    // Parity: an entry naming both CLIs covers both (no per-CLI duplication).
    expect: "exception",
  },
  {
    name: "fixture-03-undeclared-lane-not-covered",
    input: { cli: "codex", lang: "py", exceptions: EXCEPTIONS, now: "2026-07-26" },
    // NARROWNESS: a sibling lane never inherits another lane's grant.
    expect: null,
  },
  {
    name: "fixture-04-base-lane-not-covered",
    input: { cli: "codex", lang: null, exceptions: EXCEPTIONS, now: "2026-07-26" },
    // lang=null normalizes to lane "base", which holds no grant.
    expect: null,
  },
  {
    name: "fixture-05-undeclared-cli-not-covered",
    input: { cli: "cursor", lang: "rs", exceptions: EXCEPTIONS, now: "2026-07-26" },
    // A CLI absent from `clis:` gets nothing, even on the granted lane.
    expect: null,
  },
  {
    name: "fixture-06-day-before-expiry-in-force",
    input: { cli: "codex", lang: "rs", exceptions: EXCEPTIONS, now: "2026-10-30" },
    expect: "exception",
  },
  {
    name: "fixture-07-expiry-day-inclusive",
    input: { cli: "codex", lang: "rs", exceptions: EXCEPTIONS, now: "2026-10-31" },
    // Expiry is inclusive — in force through the end of the declared date.
    expect: "exception",
  },
  {
    name: "fixture-08-day-after-expiry-lapsed",
    input: { cli: "codex", lang: "rs", exceptions: EXCEPTIONS, now: "2026-11-01" },
    // THE load-bearing case: expiry turns the gate RED, it does not lapse
    // into permission.
    expect: null,
  },
  {
    name: "fixture-09-long-after-expiry-still-lapsed",
    input: { cli: "codex", lang: "rs", exceptions: EXCEPTIONS, now: "2031-01-01" },
    expect: null,
  },
  {
    name: "fixture-10-invalid-clock-fails-closed",
    input: { cli: "codex", lang: "rs", exceptions: EXCEPTIONS, now: "not-a-date" },
    // Cannot establish the exception is unexpired → deny it.
    expect: null,
  },
  {
    name: "fixture-11-missing-clock-fails-closed",
    input: { cli: "codex", lang: "rs", exceptions: EXCEPTIONS, now: undefined },
    expect: null,
  },
  {
    name: "fixture-12-calendar-invalid-clock-fails-closed",
    input: { cli: "codex", lang: "rs", exceptions: EXCEPTIONS, now: "2026-13-45" },
    // Shape-valid but not a date — Date round-trip rejects it.
    expect: null,
  },
  {
    name: "fixture-13-empty-corpus",
    input: { cli: "codex", lang: "rs", exceptions: [], now: "2026-07-26" },
    expect: null,
  },
  {
    name: "fixture-14-non-array-corpus-fails-closed",
    input: { cli: "codex", lang: "rs", exceptions: "rs", now: "2026-07-26" },
    // Malformed-input defense: a non-array grants nothing.
    expect: null,
  },
  {
    name: "fixture-15-first-matching-entry-wins-over-nonmatching",
    input: {
      cli: "codex",
      lang: "rs",
      exceptions: [{ lane: "py", clis: ["codex"], granted_floor_pct: 6, expires: "2030-01-01" }, RS],
      now: "2026-07-26",
    },
    // Non-matching entries are skipped, not treated as a match.
    expect: "exception",
  },
];

for (const f of resolveFixtures) {
  let ok = false;
  let reason = "";
  try {
    const result = resolveHeadroomException(f.input);
    if (f.expect === null) {
      ok = result === null;
      reason = ok ? "" : `expected null, got ${JSON.stringify(result)}`;
    } else {
      ok = result !== null && result.lane === "rs" && result.granted_floor_pct === 8.5;
      reason = ok ? "" : `expected the rs exception, got ${JSON.stringify(result)}`;
    }
  } catch (err) {
    ok = false;
    reason = `threw: ${err.message}`;
  }
  check(f.name, ok, reason);
}

// ── effectiveHeadroomFloorPct — floor composition ───────────────────────────
const floorFixtures = [
  {
    name: "fixture-16-no-exception-keeps-declared-floor",
    input: [10, null],
    expect: 10,
  },
  {
    name: "fixture-17-grant-lowers-floor-for-this-lane",
    input: [10, RS],
    expect: 8.5,
  },
  {
    name: "fixture-18-grant-above-declared-floor-is-ignored",
    input: [10, { ...RS, granted_floor_pct: 20 }],
    // min() semantics: a nonsense grant cannot silently tighten either.
    expect: 10,
  },
  {
    name: "fixture-19-grant-at-min-clamp",
    input: [10, { ...RS, granted_floor_pct: HEADROOM_EXCEPTION_MIN_FLOOR_PCT }],
    expect: HEADROOM_EXCEPTION_MIN_FLOOR_PCT,
  },
];

for (const f of floorFixtures) {
  let ok = false;
  let reason = "";
  try {
    const result = effectiveHeadroomFloorPct(...f.input);
    ok = result === f.expect;
    reason = ok ? "" : `expected ${f.expect}, got ${result}`;
  } catch (err) {
    ok = false;
    reason = `threw: ${err.message}`;
  }
  check(f.name, ok, reason);
}

// ── parseHeadroomExceptions — fail-closed declaration parsing ───────────────
const WELL_FORMED = `cli_variants:
  context/root.md:
    headroom_floor_exceptions:
      - lane: rs
        clis: [codex, gemini]
        granted_floor_pct: 8.5
        measured_emission_bytes: 56079
        measured_shortfall_bytes: 783
        expires: "2026-10-31"
        issue: 1355
        rationale: "measured, time-bounded"
  agents/**.md:
    codex:
      toml_key_safety: "iterate_and_classify"
`;

const parseFixtures = [
  {
    name: "fixture-20-well-formed-declaration-parses",
    src: WELL_FORMED,
    expectOk: (out) =>
      out.length === 1 &&
      out[0].lane === "rs" &&
      out[0].granted_floor_pct === 8.5 &&
      out[0].expires === "2026-10-31" &&
      out[0].issue === "1355" &&
      out[0].measured_shortfall_bytes === 783,
  },
  {
    name: "fixture-21-absent-stanza-yields-no-exceptions",
    src: "cli_variants:\n  context/root.md:\n    codex:\n      block_cap_bytes: 61440\n",
    expectOk: (out) => out.length === 0,
  },
  {
    name: "fixture-22-block-ends-at-dedent-not-at-eof",
    src: WELL_FORMED,
    // The `agents/**.md:` stanza that follows at a shallower indent must NOT
    // be swallowed into the exception list.
    expectOk: (out) => out.length === 1,
  },
  {
    name: "fixture-23-missing-granted_floor_pct-throws",
    src: WELL_FORMED.replace(/^\s*granted_floor_pct: 8\.5$/m, ""),
    expectThrow: /required field "granted_floor_pct" is missing/,
  },
  {
    name: "fixture-24-missing-expires-throws",
    src: WELL_FORMED.replace(/^\s*expires: "2026-10-31"$/m, ""),
    expectThrow: /required field "expires" is missing/,
  },
  {
    name: "fixture-25-missing-issue-throws",
    src: WELL_FORMED.replace(/^\s*issue: 1355$/m, ""),
    expectThrow: /required field "issue" is missing/,
  },
  {
    name: "fixture-26-missing-clis-throws",
    src: WELL_FORMED.replace(/^\s*clis: \[codex, gemini\]$/m, ""),
    expectThrow: /required field "clis" is missing/,
  },
  {
    name: "fixture-27-grant-below-min-floor-throws",
    src: WELL_FORMED.replace(/granted_floor_pct: 8\.5/, "granted_floor_pct: 2"),
    // An exception may not be used to disable the reserve outright.
    expectThrow: /outside the permitted \[5, 100\) range/,
  },
  {
    name: "fixture-28-non-numeric-grant-throws",
    src: WELL_FORMED.replace(/granted_floor_pct: 8\.5/, "granted_floor_pct: soon"),
    expectThrow: /granted_floor_pct must be a finite number/,
  },
  {
    name: "fixture-29-calendar-invalid-expiry-throws",
    src: WELL_FORMED.replace(/expires: "2026-10-31"/, 'expires: "2026-02-30"'),
    expectThrow: /expires must be a calendar-valid YYYY-MM-DD date/,
  },
  {
    name: "fixture-30-misshaped-expiry-throws",
    src: WELL_FORMED.replace(/expires: "2026-10-31"/, 'expires: "31-10-2026"'),
    expectThrow: /expires must be a calendar-valid YYYY-MM-DD date/,
  },
  {
    name: "fixture-31-unknown-cli-throws",
    src: WELL_FORMED.replace(/clis: \[codex, gemini\]/, "clis: [codex, gemeni]"),
    expectThrow: /unknown cli "gemeni"/,
  },
  {
    name: "fixture-32-empty-clis-throws",
    src: WELL_FORMED.replace(/clis: \[codex, gemini\]/, "clis: []"),
    expectThrow: /clis must name at least one CLI/,
  },
  {
    name: "fixture-33-duplicate-lane-cli-throws",
    src: WELL_FORMED.replace(
      /^(\s*)- lane: rs$/m,
      '$1- lane: rs\n$1  clis: [codex]\n$1  granted_floor_pct: 9\n$1  expires: "2026-10-31"\n$1  issue: 1355\n$1- lane: rs',
    ),
    expectThrow: /duplicate exception for lane "rs" on cli "codex"/,
  },
  {
    name: "fixture-34-two-distinct-lanes-both-parse",
    src: WELL_FORMED.replace(
      /^(\s*)- lane: rs$/m,
      '$1- lane: py\n$1  clis: [codex]\n$1  granted_floor_pct: 9\n$1  expires: "2026-10-31"\n$1  issue: 1355\n$1- lane: rs',
    ),
    expectOk: (out) => out.length === 2 && out[0].lane === "py" && out[1].lane === "rs",
  },
  {
    name: "fixture-35-comment-lines-inside-block-ignored",
    src: WELL_FORMED.replace(
      /^(\s*)- lane: rs$/m,
      "$1# why 8.5: measured 8.73% on 2026-07-26\n$1- lane: rs",
    ),
    expectOk: (out) => out.length === 1 && out[0].granted_floor_pct === 8.5,
  },
  {
    name: "fixture-36-bare-dash-item-with-fields-on-following-lines",
    src: WELL_FORMED.replace(/^(\s*)- lane: rs$/m, "$1-\n$1  lane: rs"),
    // A list item may open with a bare `-`; the entry still assembles from the
    // indented lines beneath it.
    expectOk: (out) => out.length === 1 && out[0].lane === "rs",
  },
  {
    name: "fixture-37-stray-scalar-before-first-list-item-ignored",
    src: WELL_FORMED.replace(
      /^(\s*)- lane: rs$/m,
      "$1stray_key: value\n$1- lane: rs",
    ),
    // A scalar sitting between the key and the first `-` belongs to no entry;
    // it must not be silently folded into the first one.
    expectOk: (out) => out.length === 1 && out[0].lane === "rs" && out[0].stray_key === undefined,
  },
  {
    name: "fixture-38-non-key-value-line-inside-block-ignored",
    src: WELL_FORMED.replace(
      /^(\s*)issue: 1355$/m,
      "$1issue: 1355\n$1  a continuation line that is not key: shaped at all",
    ),
    // Guards the `if (!kv) return` arm — a line the field regex cannot read is
    // skipped, never assigned under a garbage key.
    expectOk: (out) => out.length === 1 && out[0].issue === "1355",
  },
  {
    name: "fixture-39-trailing-comment-stripped-from-unquoted-value",
    src: WELL_FORMED.replace(
      /granted_floor_pct: 8\.5/,
      "granted_floor_pct: 8.5 # measured 8.73% on 2026-07-26",
    ),
    // The live manifest annotates values inline; the comment must not land in
    // the parsed number.
    expectOk: (out) => out.length === 1 && out[0].granted_floor_pct === 8.5,
  },
  {
    name: "fixture-40-grant-at-or-above-100-throws",
    src: WELL_FORMED.replace(/granted_floor_pct: 8\.5/, "granted_floor_pct: 100"),
    // Upper bound of the permitted range — a 100% floor would demand zero
    // emission and is a declaration error, not a grant.
    expectThrow: /outside the permitted \[5, 100\) range/,
  },
  {
    name: "fixture-41-absent-optional-provenance-fields-are-null",
    src: WELL_FORMED.replace(/^\s*measured_emission_bytes: 56079$/m, "")
      .replace(/^\s*measured_shortfall_bytes: 783$/m, "")
      .replace(/^\s*rationale: .*$/m, ""),
    // The five REQUIRED fields gate admission; the measured-provenance fields
    // are optional and resolve to null rather than NaN or "undefined".
    expectOk: (out) =>
      out.length === 1 &&
      out[0].measured_emission_bytes === null &&
      out[0].measured_shortfall_bytes === null &&
      out[0].rationale === null &&
      out[0].granted_on === null,
  },
];

for (const f of parseFixtures) {
  let ok = false;
  let reason = "";
  try {
    const out = parseHeadroomExceptions(f.src);
    if (f.expectThrow) {
      ok = false;
      reason = `expected a throw matching ${f.expectThrow}, but parsed ${JSON.stringify(out)}`;
    } else {
      ok = f.expectOk(out);
      reason = ok ? "" : `predicate rejected output ${JSON.stringify(out)}`;
    }
  } catch (err) {
    if (f.expectThrow) {
      ok = f.expectThrow.test(err.message);
      reason = ok ? "" : `threw, but message did not match ${f.expectThrow}: ${err.message}`;
    } else {
      ok = false;
      reason = `unexpected throw: ${err.message}`;
    }
  }
  check(f.name, ok, reason);
}

console.log(`\n${pass}/${pass + fail} fixtures passed`);

if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f.name}: ${f.reason}`);
  process.exit(1);
}

process.exit(0);
