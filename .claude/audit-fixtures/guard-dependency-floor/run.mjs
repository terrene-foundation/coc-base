#!/usr/bin/env node
/*
 * Pole-pair fixtures for `.claude/bin/check-guard-deps.mjs`.
 *
 * Every case here is one half of a BIPOLAR PAIR (`instrument-bipolarity.md`
 * MUST-1/2): for each proposition, a state that MUST PASS and a state that
 * MUST FAIL. The pair is only counted as covered when the two verdicts are
 * asserted to DIFFER — a checker wired to return "clean" unconditionally
 * satisfies every single-pole assertion in isolation, and is caught here only
 * because the compliant and violating poles are compared against each other.
 *
 * The failing pole additionally asserts a failure IDENTITY — which path, which
 * package, which waiver — never a bare non-zero exit. A gate that fails
 * without naming what failed sends the next reader back to re-derive the
 * finding, which is how a red check becomes something people skip.
 *
 * Runs offline: Arm B is exercised against synthetic `npm audit --json`
 * payloads rather than the live registry, so the fixture is deterministic and
 * carries no network dependency. The live audit is wired separately in CI.
 *
 *   node .claude/audit-fixtures/guard-dependency-floor/run.mjs
 *
 * Exit 0 = every pair holds; 1 = a pole flipped or the two poles agreed.
 */

import {
  findUndeliverablePaths,
  evaluateAudit,
  rankSeverity,
  GUARD_DIR,
} from "../../bin/check-guard-deps.mjs";

const NOW = new Date("2026-08-22T00:00:00Z");
const G = GUARD_DIR;
const TRACKED = [
  `${G}/server.js`,
  `${G}/package.json`,
  `${G}/package-lock.json`,
  `${G}/README.md`,
];

/** One synthetic audit report at the given severity. */
const audit = (name, severity, title = "synthetic advisory") => ({
  vulnerabilities: { [name]: { severity, via: [{ title }] } },
});

/*
 * Each pair: `pass` must yield ZERO findings, `fail` must yield findings, and
 * `identity` must appear in the failing pole's output.
 */
const PAIRS = [
  {
    pair: "A1 node_modules is the cp -r hazard",
    pass: () => findUndeliverablePaths(TRACKED, TRACKED),
    fail: () =>
      findUndeliverablePaths([...TRACKED, `${G}/node_modules`], TRACKED),
    identity: "node_modules",
  },
  {
    pair: "A2 nested .claude/ carries operator identity downstream",
    pass: () => findUndeliverablePaths(TRACKED, TRACKED),
    fail: () => findUndeliverablePaths([...TRACKED, `${G}/.claude`], TRACKED),
    identity: ".claude",
  },
  {
    pair: "A3 any untracked file ships, not just the two known ones",
    pass: () => findUndeliverablePaths(TRACKED, TRACKED),
    fail: () =>
      findUndeliverablePaths([...TRACKED, `${G}/scratch.log`], TRACKED),
    identity: "scratch.log",
  },
  {
    // The hole an untracked-only check leaves: COMMIT node_modules and it
    // becomes tracked, satisfying the untracked test while shipping the whole
    // payload on a clean checkout. The compliant pole proves an ordinary
    // tracked source file is still fine, so this is not just "fail on
    // everything".
    pair: "A4 a COMMITTED node_modules still fails (tracked is not a pass)",
    pass: () =>
      findUndeliverablePaths([`${G}/server.js`], [`${G}/server.js`]),
    fail: () =>
      findUndeliverablePaths(
        [...TRACKED, `${G}/node_modules`],
        [...TRACKED, `${G}/node_modules`], // tracked == committed
      ),
    identity: "COMMITTED",
  },
  {
    pair: "B1 a HIGH advisory over the floor fails; a low one does not",
    pass: () => evaluateAudit(audit("lodash", "low"), [], { floor: "high", now: NOW }),
    fail: () =>
      evaluateAudit(audit("fast-uri", "high"), [], { floor: "high", now: NOW }),
    identity: "fast-uri",
  },
  {
    pair: "B2 an UNPARSEABLE audit fails closed, it is not an all-clear",
    // The compliant pole is a real report with nothing over the floor. The
    // violating pole is `null` — what a network error or a mangled stdout
    // produces. If these two ever agree, the gate has been defanged into
    // reading silence as success.
    pass: () => evaluateAudit({ vulnerabilities: {} }, [], { floor: "high", now: NOW }),
    fail: () => evaluateAudit(null, [], { floor: "high", now: NOW }),
    identity: "audit-unavailable",
  },
  {
    pair: "B3 a live waiver covers; an EXPIRED one does not",
    pass: () =>
      evaluateAudit(audit("hono", "high"), [
        { id: "hono", reason: "stdio-only, transport never loads", expires: "2099-01-01" },
      ], { floor: "high", now: NOW }),
    fail: () =>
      evaluateAudit(audit("hono", "high"), [
        { id: "hono", reason: "stdio-only, transport never loads", expires: "2026-01-01" },
      ], { floor: "high", now: NOW }),
    identity: "waiver-expired",
  },
  {
    pair: "B4 a waiver outliving its advisory is STALE",
    pass: () =>
      evaluateAudit(audit("qs", "high"), [
        { id: "qs", reason: "covered", expires: "2099-01-01" },
      ], { floor: "high", now: NOW }),
    fail: () =>
      evaluateAudit({ vulnerabilities: {} }, [
        { id: "qs", reason: "covered", expires: "2099-01-01" },
      ], { floor: "high", now: NOW }),
    identity: "waiver-stale",
  },
  {
    pair: "B5 an UNRECOGNIZED severity ranks tightest, never mildest",
    // fail-closed per security.md § Enforcement-Surface Parity: a severity
    // string npm starts emitting tomorrow must not slip under the floor.
    pass: () =>
      evaluateAudit(audit("x", "low"), [], { floor: "high", now: NOW }),
    fail: () =>
      evaluateAudit(audit("x", "catastrophic"), [], { floor: "high", now: NOW }),
    identity: "catastrophic",
  },
];

let failed = 0;

// Sanity pole for the ranking helper itself, asserted in both directions.
if (!(rankSeverity("nonsense") > rankSeverity("critical"))) {
  console.log("FAIL  B5-rank: unrecognized severity must outrank critical (fail-closed)");
  failed++;
} else {
  console.log("PASS  B5-rank: unrecognized severity outranks critical (fail-closed)");
}

for (const p of PAIRS) {
  const clean = p.pass();
  const dirty = p.fail();
  const cleanOk = clean.length === 0;
  const dirtyOk = dirty.length > 0;
  const differ = cleanOk !== (dirty.length === 0); // the two verdicts must DIFFER
  const rendered = JSON.stringify(dirty);
  const named = rendered.includes(p.identity);

  if (!cleanOk) {
    console.log(`FAIL  ${p.pair} [compliant pole]`);
    console.log(`        - expected ZERO findings, got ${clean.length}: ${JSON.stringify(clean)}`);
    failed++;
    continue;
  }
  console.log(`PASS  ${p.pair} [compliant pole: 0 findings]`);

  if (!dirtyOk) {
    console.log(`FAIL  ${p.pair} [violating pole]`);
    console.log("        - expected at least one finding, got ZERO — the pole does not fail");
    failed++;
    continue;
  }
  if (!named) {
    console.log(`FAIL  ${p.pair} [violating pole]`);
    console.log(`        - failed, but never named "${p.identity}": ${rendered}`);
    console.log("        - a bare exit code is not a finding");
    failed++;
    continue;
  }
  if (!differ) {
    console.log(`FAIL  ${p.pair} [pole separation]`);
    console.log("        - both poles returned the same verdict; the check does not discriminate");
    failed++;
    continue;
  }
  console.log(`PASS  ${p.pair} [violating pole: fails, naming "${p.identity}"]`);
}

console.log("");
if (failed) {
  console.log(`${failed} pole assertion(s) FAILED — check-guard-deps no longer discriminates`);
  process.exit(1);
}
console.log(`all ${PAIRS.length} pole pairs hold (both poles asserted, verdicts differ)`);
process.exit(0);
