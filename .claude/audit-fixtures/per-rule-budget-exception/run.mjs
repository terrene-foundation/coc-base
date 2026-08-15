#!/usr/bin/env node
// Audit fixture runner for the loom#1355 per-lane, per-rule BUDGET exception
// mechanism in `.claude/bin/emit.mjs`:
//
//   resolvePerRuleBudgetException      — the scope-restriction predicate (which
//                                        lane, which CLI, which RULE, still in
//                                        force?)
//   effectivePerRuleBlockCeiling       — ceiling composition (a grant may only
//                                        RELAX; it can never tighten a gate)
//   parsePerRuleBudgetExceptions       — fail-closed declaration parsing (a
//                                        malformed waiver THROWS; it never
//                                        degrades into "no ceiling")
//   assertPerRuleBudgetExceptionsBounded — the budget-relative bounds (an
//                                        unbudgeted rule and an over-broad
//                                        grant both THROW)
//
// Sibling of ../headroom-floor-exception/run.mjs: that stanza governs a lane's
// AGGREGATE emission against block_cap_bytes, this one governs a SINGLE rule
// against its per_rule_size_budget_bytes entry.
//
// Every fixture is self-contained: no fixture reads the live sync-manifest.yaml,
// so a manifest edit changes the live gate but never silently rewrites what
// these predicates are asserted to do.
//
// Exits 0 when ALL fixtures pass, non-zero otherwise.
//   node .claude/audit-fixtures/per-rule-budget-exception/run.mjs

import {
  resolvePerRuleBudgetException,
  effectivePerRuleBlockCeiling,
  parsePerRuleBudgetExceptions,
  assertPerRuleBudgetExceptionsBounded,
  PER_RULE_BUDGET_EXCEPTION_MAX_MULTIPLE,
} from "../../bin/emit.mjs";

// The live declaration's shape, inlined so the fixtures are hermetic.
const RS_SECURITY = {
  lane: "rs",
  clis: ["codex", "gemini"],
  rule: "security.md",
  granted_block_ceiling_bytes: 9600,
  expires: "2026-10-31",
  issue: "1355",
};
const EXCEPTIONS = [RS_SECURITY];

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

// ── resolvePerRuleBudgetException — scope restriction ───────────────────────
const resolveFixtures = [
  {
    name: "fixture-01-declared-lane-cli-rule-in-force",
    input: {
      cli: "codex",
      lang: "rs",
      rule: "security.md",
      exceptions: EXCEPTIONS,
      now: "2026-07-26",
    },
    // The one granted case: lane, cli and rule all match, date before expiry.
    expect: "exception",
  },
  {
    name: "fixture-02-second-declared-cli-also-covered",
    input: {
      cli: "gemini",
      lang: "rs",
      rule: "security.md",
      exceptions: EXCEPTIONS,
      now: "2026-07-26",
    },
    // Parity: one entry naming both CLIs covers both (no per-CLI duplication).
    expect: "exception",
  },
  {
    name: "fixture-03-undeclared-lane-not-covered",
    input: {
      cli: "codex",
      lang: "py",
      rule: "security.md",
      exceptions: EXCEPTIONS,
      now: "2026-07-26",
    },
    // NARROWNESS, the whole point of the instrument: py emits the same rule
    // and MUST keep the flat ceiling. This is the property a flat budget raise
    // could not have given.
    expect: null,
  },
  {
    name: "fixture-04-prism-lane-not-covered",
    input: {
      cli: "codex",
      lang: "prism",
      rule: "security.md",
      exceptions: EXCEPTIONS,
      now: "2026-07-26",
    },
    expect: null,
  },
  {
    name: "fixture-05-base-lane-not-covered",
    input: {
      cli: "codex",
      lang: null,
      rule: "security.md",
      exceptions: EXCEPTIONS,
      now: "2026-07-26",
    },
    // lang null resolves to the "base" lane, which the entry does not name.
    expect: null,
  },
  {
    name: "fixture-06-undeclared-rule-on-declared-lane-not-covered",
    input: {
      cli: "codex",
      lang: "rs",
      rule: "agents.md",
      exceptions: EXCEPTIONS,
      now: "2026-07-26",
    },
    // RULE narrowness: a grant for security.md never relaxes a sibling rule
    // on the same lane.
    expect: null,
  },
  {
    name: "fixture-07-undeclared-cli-not-covered",
    input: {
      cli: "claude",
      lang: "rs",
      rule: "security.md",
      exceptions: EXCEPTIONS,
      now: "2026-07-26",
    },
    expect: null,
  },
  {
    name: "fixture-08-day-before-expiry-still-in-force",
    input: {
      cli: "codex",
      lang: "rs",
      rule: "security.md",
      exceptions: EXCEPTIONS,
      now: "2026-10-30",
    },
    expect: "exception",
  },
  {
    name: "fixture-09-expiry-day-itself-still-in-force-inclusive",
    input: {
      cli: "codex",
      lang: "rs",
      rule: "security.md",
      exceptions: EXCEPTIONS,
      now: "2026-10-31",
    },
    // Expiry is INCLUSIVE, matching resolveHeadroomException.
    expect: "exception",
  },
  {
    name: "fixture-10-day-after-expiry-lapses-gate-turns-red",
    input: {
      cli: "codex",
      lang: "rs",
      rule: "security.md",
      exceptions: EXCEPTIONS,
      now: "2026-11-01",
    },
    // THE core fail-closed property: an exception never lapses into permission.
    expect: null,
  },
  {
    name: "fixture-11-far-future-lapses",
    input: {
      cli: "codex",
      lang: "rs",
      rule: "security.md",
      exceptions: EXCEPTIONS,
      now: "2030-01-01",
    },
    expect: null,
  },
  {
    name: "fixture-12-missing-clock-fails-closed",
    input: {
      cli: "codex",
      lang: "rs",
      rule: "security.md",
      exceptions: EXCEPTIONS,
      now: undefined,
    },
    // Cannot establish the grant is unexpired → it does not apply.
    expect: null,
  },
  {
    name: "fixture-13-malformed-clock-fails-closed",
    input: {
      cli: "codex",
      lang: "rs",
      rule: "security.md",
      exceptions: EXCEPTIONS,
      now: "not-a-date",
    },
    expect: null,
  },
  {
    name: "fixture-14-calendar-invalid-clock-fails-closed",
    input: {
      cli: "codex",
      lang: "rs",
      rule: "security.md",
      exceptions: EXCEPTIONS,
      now: "2026-02-30",
    },
    expect: null,
  },
  {
    name: "fixture-15-empty-corpus-yields-no-grant",
    input: { cli: "codex", lang: "rs", rule: "security.md", exceptions: [], now: "2026-07-26" },
    expect: null,
  },
  {
    name: "fixture-16-non-array-corpus-yields-no-grant",
    input: { cli: "codex", lang: "rs", rule: "security.md", exceptions: null, now: "2026-07-26" },
    expect: null,
  },
];

for (const f of resolveFixtures) {
  const out = resolvePerRuleBudgetException(f.input);
  const ok = f.expect === null ? out === null : out !== null && out.rule === "security.md";
  check(f.name, ok, ok ? "" : `expected ${f.expect}, got ${JSON.stringify(out)}`);
}

// ── effectivePerRuleBlockCeiling — composition ──────────────────────────────
const ceilingFixtures = [
  {
    name: "fixture-17-no-exception-keeps-flat-ceiling",
    base: 9360,
    ex: null,
    expect: 9360,
  },
  {
    name: "fixture-18-grant-above-flat-ceiling-relaxes",
    base: 9360,
    ex: RS_SECURITY,
    expect: 9600,
  },
  {
    name: "fixture-19-grant-below-flat-ceiling-is-ignored-never-tightens",
    base: 9360,
    ex: { ...RS_SECURITY, granted_block_ceiling_bytes: 8000 },
    // Math.max is the structural guarantee: a nonsense grant BELOW the flat
    // ceiling cannot silently tighten a gate nobody meant to constrain.
    expect: 9360,
  },
  {
    name: "fixture-20-grant-equal-to-flat-ceiling-is-a-noop",
    base: 9360,
    ex: { ...RS_SECURITY, granted_block_ceiling_bytes: 9360 },
    expect: 9360,
  },
];

for (const f of ceilingFixtures) {
  const out = effectivePerRuleBlockCeiling(f.base, f.ex);
  check(f.name, out === f.expect, out === f.expect ? "" : `expected ${f.expect}, got ${out}`);
}

// ── assertPerRuleBudgetExceptionsBounded — budget-relative bounds ───────────
const budgets = new Map([
  ["security.md", 7200],
  ["agents.md", 14000],
]);

const boundFixtures = [
  {
    name: "fixture-21-live-shaped-grant-is-within-bounds",
    exceptions: [RS_SECURITY],
    expectThrow: null,
  },
  {
    name: "fixture-22-unbudgeted-rule-throws",
    exceptions: [{ ...RS_SECURITY, rule: "no-such-rule.md" }],
    // A typo'd rule name would otherwise silently cover nothing while READING
    // as coverage in the manifest.
    expectThrow: /no per_rule_size_budget_bytes entry exists/,
  },
  {
    name: "fixture-23-grant-above-2x-budget-throws",
    exceptions: [{ ...RS_SECURITY, granted_block_ceiling_bytes: 14401 }],
    // 2 × 7200 = 14400. Past that the budget itself is wrong; re-measure per
    // spec v6 §A.2 rather than paper over it with a waiver.
    expectThrow: /exceeds the permitted maximum/,
  },
  {
    name: "fixture-24-grant-exactly-at-2x-budget-is-permitted",
    exceptions: [{ ...RS_SECURITY, granted_block_ceiling_bytes: 14400 }],
    expectThrow: null,
  },
  {
    name: "fixture-25-empty-corpus-is-vacuously-bounded",
    exceptions: [],
    expectThrow: null,
  },
];

for (const f of boundFixtures) {
  let ok = false;
  let reason = "";
  try {
    assertPerRuleBudgetExceptionsBounded(f.exceptions, budgets);
    ok = !f.expectThrow;
    reason = ok ? "" : `expected a throw matching ${f.expectThrow}`;
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

check(
  "fixture-26-max-multiple-constant-is-the-documented-2x",
  PER_RULE_BUDGET_EXCEPTION_MAX_MULTIPLE === 2,
  `expected 2, got ${PER_RULE_BUDGET_EXCEPTION_MAX_MULTIPLE}`,
);

// ── parsePerRuleBudgetExceptions — fail-closed declaration parsing ──────────
const WELL_FORMED = `
cli_variants:
  context/root.md:
    per_rule_budget_exceptions:
      - lane: rs
        clis: [codex, gemini]
        rule: security.md
        granted_block_ceiling_bytes: 9600
        measured_emission_bytes: 9545
        base_budget_bytes_at_grant: 7200
        measured_overrun_bytes: 185
        granted_on: "2026-07-26"
        expires: "2026-10-31"
        issue: 1355
        rationale: "measured overrun accepted, lane-scoped"
    other_key: value
`;

const parseFixtures = [
  {
    name: "fixture-27-well-formed-declaration-parses",
    src: WELL_FORMED,
    expectOk: (out) =>
      out.length === 1 &&
      out[0].lane === "rs" &&
      out[0].rule === "security.md" &&
      out[0].granted_block_ceiling_bytes === 9600 &&
      out[0].expires === "2026-10-31" &&
      out[0].issue === "1355" &&
      out[0].clis.length === 2,
  },
  {
    name: "fixture-28-absent-stanza-yields-no-exceptions",
    src: "cli_variants:\n  context/root.md:\n    warn_cap_bytes: 32768\n",
    // Key absent → no exceptions → flat ceiling everywhere.
    expectOk: (out) => out.length === 0,
  },
  {
    name: "fixture-29-parsing-stops-at-dedent-does-not-swallow-siblings",
    src: WELL_FORMED,
    expectOk: (out) => out.length === 1,
  },
  {
    name: "fixture-30-missing-lane-throws",
    src: WELL_FORMED.replace(/^\s*- lane: rs$/m, "      -"),
    expectThrow: /required field "lane" is missing/,
  },
  {
    name: "fixture-31-missing-rule-throws",
    src: WELL_FORMED.replace(/^\s*rule: security\.md$/m, ""),
    expectThrow: /required field "rule" is missing/,
  },
  {
    name: "fixture-32-missing-ceiling-throws",
    src: WELL_FORMED.replace(/^\s*granted_block_ceiling_bytes: 9600$/m, ""),
    expectThrow: /required field "granted_block_ceiling_bytes" is missing/,
  },
  {
    name: "fixture-33-missing-expires-throws",
    src: WELL_FORMED.replace(/^\s*expires: "2026-10-31"$/m, ""),
    // An unexpiring waiver is a permanent one; reject it.
    expectThrow: /required field "expires" is missing/,
  },
  {
    name: "fixture-34-missing-issue-throws",
    src: WELL_FORMED.replace(/^\s*issue: 1355$/m, ""),
    expectThrow: /required field "issue" is missing/,
  },
  {
    name: "fixture-35-missing-clis-throws",
    src: WELL_FORMED.replace(/^\s*clis: \[codex, gemini\]$/m, ""),
    expectThrow: /required field "clis" is missing/,
  },
  {
    name: "fixture-36-non-integer-ceiling-throws",
    src: WELL_FORMED.replace(/granted_block_ceiling_bytes: 9600/, "granted_block_ceiling_bytes: nine"),
    expectThrow: /positive integer byte count/,
  },
  {
    name: "fixture-37-fractional-ceiling-throws",
    src: WELL_FORMED.replace(/granted_block_ceiling_bytes: 9600/, "granted_block_ceiling_bytes: 9600.5"),
    // Bytes are integral; a fractional ceiling is a declaration error.
    expectThrow: /positive integer byte count/,
  },
  {
    name: "fixture-38-zero-ceiling-throws",
    src: WELL_FORMED.replace(/granted_block_ceiling_bytes: 9600/, "granted_block_ceiling_bytes: 0"),
    expectThrow: /positive integer byte count/,
  },
  {
    name: "fixture-39-negative-ceiling-throws",
    src: WELL_FORMED.replace(/granted_block_ceiling_bytes: 9600/, "granted_block_ceiling_bytes: -1"),
    expectThrow: /positive integer byte count/,
  },
  {
    name: "fixture-40-rule-name-not-a-rule-filename-throws",
    src: WELL_FORMED.replace(/rule: security\.md/, "rule: security"),
    // A name that cannot match a budget key can never cover anything.
    expectThrow: /is not a valid rule filename/,
  },
  {
    name: "fixture-41-rule-name-with-path-separator-throws",
    src: WELL_FORMED.replace(/rule: security\.md/, "rule: rules/security.md"),
    expectThrow: /is not a valid rule filename/,
  },
  {
    name: "fixture-42-calendar-invalid-expiry-throws",
    src: WELL_FORMED.replace(/expires: "2026-10-31"/, 'expires: "2026-02-30"'),
    expectThrow: /calendar-valid YYYY-MM-DD/,
  },
  {
    name: "fixture-43-misshaped-expiry-throws",
    src: WELL_FORMED.replace(/expires: "2026-10-31"/, 'expires: "31-10-2026"'),
    expectThrow: /calendar-valid YYYY-MM-DD/,
  },
  {
    name: "fixture-44-unknown-cli-throws",
    src: WELL_FORMED.replace(/clis: \[codex, gemini\]/, "clis: [codex, claude]"),
    // A typo'd CLI would silently cover nothing while reading as coverage.
    expectThrow: /unknown cli "claude"/,
  },
  {
    name: "fixture-45-empty-clis-list-throws",
    src: WELL_FORMED.replace(/clis: \[codex, gemini\]/, "clis: []"),
    expectThrow: /must name at least one CLI/,
  },
  {
    name: "fixture-46-duplicate-lane-cli-rule-throws",
    src: WELL_FORMED.replace(
      /    other_key: value/,
      `      - lane: rs
        clis: [codex]
        rule: security.md
        granted_block_ceiling_bytes: 12000
        expires: "2026-12-31"
        issue: 9999
    other_key: value`,
    ),
    // Two entries covering one rule make the applied ceiling ambiguous.
    expectThrow: /duplicate exception for rule "security\.md"/,
  },
  {
    name: "fixture-47-same-rule-different-lane-is-not-a-duplicate",
    src: WELL_FORMED.replace(
      /    other_key: value/,
      `      - lane: py
        clis: [codex]
        rule: security.md
        granted_block_ceiling_bytes: 9600
        expires: "2026-12-31"
        issue: 9999
    other_key: value`,
    ),
    // The duplicate key is (cli, lane, rule) — a distinct lane is legitimate.
    expectOk: (out) => out.length === 2,
  },
  {
    name: "fixture-48-same-lane-different-rule-is-not-a-duplicate",
    src: WELL_FORMED.replace(
      /    other_key: value/,
      `      - lane: rs
        clis: [codex]
        rule: agents.md
        granted_block_ceiling_bytes: 20000
        expires: "2026-12-31"
        issue: 9999
    other_key: value`,
    ),
    expectOk: (out) => out.length === 2,
  },
  {
    name: "fixture-49-bare-dash-list-item-parses-not-silently-dropped",
    src: WELL_FORMED.replace(
      /^\s*- lane: rs$/m,
      "      -\n        lane: rs",
    ),
    // YAML permits a bare `-` opening an item whose fields all sit below it.
    // The headroom sibling's fixture-36 caught this exact shape silently
    // parsing to zero entries — a written waiver evaporating with no error.
    expectOk: (out) => out.length === 1 && out[0].lane === "rs",
  },
  {
    name: "fixture-50-absent-optional-provenance-fields-are-null",
    src: WELL_FORMED.replace(/^\s*measured_emission_bytes: 9545$/m, "")
      .replace(/^\s*measured_overrun_bytes: 185$/m, "")
      .replace(/^\s*base_budget_bytes_at_grant: 7200$/m, "")
      .replace(/^\s*rationale: .*$/m, ""),
    // The six REQUIRED fields gate admission; measured-provenance fields are
    // optional and resolve to null rather than NaN or "undefined".
    expectOk: (out) =>
      out.length === 1 &&
      out[0].measured_emission_bytes === null &&
      out[0].measured_overrun_bytes === null &&
      out[0].base_budget_bytes_at_grant === null &&
      out[0].rationale === null,
  },
  {
    name: "fixture-51-comment-only-and-blank-lines-are-skipped",
    src: WELL_FORMED.replace(
      /^\s*rule: security\.md$/m,
      "        # a comment inside the entry\n\n        rule: security.md",
    ),
    expectOk: (out) => out.length === 1 && out[0].rule === "security.md",
  },
];

for (const f of parseFixtures) {
  let ok = false;
  let reason = "";
  try {
    const out = parsePerRuleBudgetExceptions(f.src);
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
