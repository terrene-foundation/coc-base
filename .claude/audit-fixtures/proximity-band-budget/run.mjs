#!/usr/bin/env node
// Audit fixture runner for getProximityBandAdvisory (F23a, rule-authoring.md MUST Rule 10)
// AND countPriorRule10Invocations (F23b, rule-authoring.md MUST Rule 11).
// Exits 0 when ALL fixtures pass, non-zero otherwise.

import { getProximityBandAdvisory } from "../../bin/emit.mjs";
import { countPriorRule10Invocations } from "./rule-11-helper.mjs";

const BLOCK_CAP = 61440; // matches the live `block_cap_bytes` for context/root.md.

// Scenarios — see README.md for the full table.
const fixtures = [
  {
    name: "fixture-01-above-band-clean",
    input: { cli: "codex", lang: "rs", emissionBytes: 49152, blockCap: BLOCK_CAP, floorPct: 10, proximityBandPct: 15 },
    // 49152/61440 = 80% used → 20% headroom > 15% band → null
    expect: null,
  },
  {
    name: "fixture-02-within-band-advisory",
    input: { cli: "codex", lang: "rs", emissionBytes: 54068, blockCap: BLOCK_CAP, floorPct: 10, proximityBandPct: 15 },
    // 54068/61440 = 88% used → 12% headroom (within [10, 15)) → advisory
    expectShape: { headroom_pct: 12, proximity_band_pct: 15 },
  },
  {
    name: "fixture-03-at-band-edge",
    input: { cli: "codex", lang: "rs", emissionBytes: 52224, blockCap: BLOCK_CAP, floorPct: 10, proximityBandPct: 15 },
    // 52224/61440 = 85% used → 15% headroom EXACTLY → null (band edge exclusive)
    expect: null,
  },
  {
    name: "fixture-04-at-floor-edge",
    input: { cli: "codex", lang: "rs", emissionBytes: 55296, blockCap: BLOCK_CAP, floorPct: 10, proximityBandPct: 15 },
    // 55296/61440 = 90% used → 10% headroom EXACTLY → advisory (floor edge inclusive at-or-above)
    expectShape: { headroom_pct: 10, proximity_band_pct: 15 },
  },
  {
    name: "fixture-05-below-floor",
    input: { cli: "codex", lang: "rs", emissionBytes: 56058, blockCap: BLOCK_CAP, floorPct: 10, proximityBandPct: 15 },
    // 56058/61440 = 91.24% used → 8.76% headroom < floor → null (BLOCK case handled by validateAggregateHeadroom)
    expect: null,
  },
  {
    name: "fixture-06-misconfig-band-le-floor",
    input: { cli: "codex", lang: "rs", emissionBytes: 54068, blockCap: BLOCK_CAP, floorPct: 15, proximityBandPct: 10 },
    // band=10 ≤ floor=15 → misconfiguration → null
    expect: null,
  },
  {
    name: "fixture-07-zero-blockcap",
    input: { cli: "codex", lang: "rs", emissionBytes: 0, blockCap: 0, floorPct: 10, proximityBandPct: 15 },
    // blockCap=0 → null (division-by-zero guard)
    expect: null,
  },
  {
    name: "fixture-08-negative-blockcap",
    input: { cli: "codex", lang: "rs", emissionBytes: 100, blockCap: -1, floorPct: 10, proximityBandPct: 15 },
    // blockCap<=0 → null (security-reviewer M4 — defense against malformed input)
    expect: null,
  },
  {
    name: "fixture-09-nan-emission",
    input: { cli: "codex", lang: "rs", emissionBytes: NaN, blockCap: BLOCK_CAP, floorPct: 10, proximityBandPct: 15 },
    // NaN propagates through computation; both `< floor` and `>= band` comparisons
    // return false for NaN, so the function would fall through to advisory construction.
    // Security-reviewer M4 caveat: caller MUST sanitize input; we lock current behavior here.
    // Current implementation returns advisory with NaN headroom_pct. Document & accept until F23-followup.
    expectAdvisoryOrNull: true, // structural assertion: either null or advisory; do not crash
  },
  {
    name: "fixture-10-output-shape-completeness",
    input: { cli: "codex", lang: "rs", emissionBytes: 54068, blockCap: BLOCK_CAP, floorPct: 10, proximityBandPct: 15 },
    // Within-band advisory MUST include ALL documented keys (security-reviewer M4).
    expectKeys: [
      "cli",
      "lang",
      "emission_bytes",
      "block_cap_bytes",
      "headroom_pct",
      "headroom_floor_pct",
      "proximity_band_pct",
      "proximity_band_bytes",
      "margin_to_floor_bytes",
      "advisory",
    ],
  },
];

let pass = 0;
let fail = 0;
const failures = [];

for (const f of fixtures) {
  const result = getProximityBandAdvisory(f.input);
  let ok = false;
  let reason = "";

  if (f.expect === null) {
    ok = result === null;
    reason = ok ? "" : `expected null, got ${JSON.stringify(result)}`;
  } else if (f.expectShape) {
    if (result === null) {
      ok = false;
      reason = `expected advisory object, got null`;
    } else {
      ok = Object.entries(f.expectShape).every(([k, v]) => {
        if (typeof v === "number") return Math.abs(result[k] - v) < 0.01;
        return result[k] === v;
      });
      reason = ok ? "" : `shape mismatch: expected ${JSON.stringify(f.expectShape)}, got ${JSON.stringify(result)}`;
    }
  } else if (f.expectAdvisoryOrNull) {
    // structural: function did not throw; result is either null or an object
    ok = result === null || (typeof result === "object" && result !== null);
    reason = ok ? "" : `expected null or object, got ${typeof result}`;
  } else if (f.expectKeys) {
    if (result === null) {
      ok = false;
      reason = `expected advisory object with documented keys, got null`;
    } else {
      const missing = f.expectKeys.filter((k) => !(k in result));
      ok = missing.length === 0;
      reason = ok ? "" : `missing keys in advisory object: ${missing.join(", ")}`;
    }
  }

  if (ok) {
    pass++;
    console.log(`PASS  ${f.name}`);
  } else {
    fail++;
    failures.push({ name: f.name, reason });
    console.log(`FAIL  ${f.name}: ${reason}`);
  }
}

// ============================================================================
// Rule-11 fixtures (F23b — 2nd-extraction escalation on (rule, CLI) pair within 30d).
// Test countPriorRule10Invocations against structured Rule-10-invocation records.
// ============================================================================

const ASOF = "2026-05-23"; // F23b's codify date

const rule11Fixtures = [
  {
    name: "fixture-11-empty-entries-no-fire",
    // Predicate: empty history → count=0, fires=false (clock bootstraps at land-time).
    input: { entries: [], ruleName: "security.md", cli: "codex", lang: "rs", asOfDate: ASOF },
    expect: { count: 0, fires: false },
  },
  {
    name: "fixture-12-one-match-within-30d-fires",
    // Predicate: 1 prior Rule-10 invocation on same (rule, CLI, lang) within 30d → fires.
    input: {
      entries: [
        { date: "2026-05-22", rule: "security.md", cli: "codex", lang: "rs", path: "a" },
      ],
      ruleName: "security.md", cli: "codex", lang: "rs", asOfDate: ASOF,
    },
    expect: { count: 1, fires: true },
  },
  {
    name: "fixture-13-different-lane-no-fire",
    // Predicate: prior invocation exists but on DIFFERENT (rule, CLI, lang) lane → no fire.
    // Tests the structural lane match (NOT regex-over-prose).
    input: {
      entries: [
        { date: "2026-05-22", rule: "security.md", cli: "gemini", lang: "rs", path: "a" }, // different cli
        { date: "2026-05-22", rule: "security.md", cli: "codex", lang: "py", path: "a" },  // different lang
        { date: "2026-05-22", rule: "agents.md", cli: "codex", lang: "rs", path: "a" },    // different rule
      ],
      ruleName: "security.md", cli: "codex", lang: "rs", asOfDate: ASOF,
    },
    expect: { count: 0, fires: false },
  },
  {
    name: "fixture-14-outside-30d-window-no-fire",
    // Predicate: prior invocation exists on same lane but > 30d ago → no fire.
    // ASOF=2026-05-23, cutoff = 2026-04-23; entry date 2026-04-22 is OUTSIDE window.
    input: {
      entries: [
        { date: "2026-04-22", rule: "security.md", cli: "codex", lang: "rs", path: "a" },
      ],
      ruleName: "security.md", cli: "codex", lang: "rs", asOfDate: ASOF,
    },
    expect: { count: 0, fires: false },
  },
  {
    name: "fixture-15-two-matches-corpus-review-signal",
    // Predicate: 2 prior invocations on same lane within window → count=2, fires=true.
    // This is the strongest corpus-level-review escalation signal.
    input: {
      entries: [
        { date: "2026-05-10", rule: "security.md", cli: "codex", lang: "rs", path: "a" }, // 13 days ago
        { date: "2026-05-22", rule: "security.md", cli: "codex", lang: "rs", path: "b" }, // 1 day ago
        { date: "2026-04-01", rule: "security.md", cli: "codex", lang: "rs", path: "a" }, // outside window
      ],
      ruleName: "security.md", cli: "codex", lang: "rs", asOfDate: ASOF,
    },
    expect: { count: 2, fires: true },
  },
];

for (const f of rule11Fixtures) {
  let ok = false;
  let reason = "";
  try {
    const result = countPriorRule10Invocations(f.input);
    ok = result.count === f.expect.count && result.fires === f.expect.fires;
    reason = ok ? "" : `expected count=${f.expect.count} fires=${f.expect.fires}, got count=${result.count} fires=${result.fires}`;
  } catch (err) {
    ok = false;
    reason = `threw: ${err.message}`;
  }

  if (ok) {
    pass++;
    console.log(`PASS  ${f.name}`);
  } else {
    fail++;
    failures.push({ name: f.name, reason });
    console.log(`FAIL  ${f.name}: ${reason}`);
  }
}

console.log(`\n${pass}/${pass + fail} fixtures passed`);

if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f.name}: ${f.reason}`);
  process.exit(1);
}

process.exit(0);
