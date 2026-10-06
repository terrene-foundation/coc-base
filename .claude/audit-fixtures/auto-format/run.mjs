#!/usr/bin/env node
/**
 * Audit fixtures for `.claude/hooks/auto-format.js` (cc-artifacts.md Rule 9).
 *
 * This file is the `ci-audit-fixtures.json::runners` SURFACE. Every assertion it
 * prints is evaluated by `./auto-format-cases.mjs`, which the eval-manifest
 * scanner `./auto-format-scan.mjs` also resolves through — ONE predicate, two
 * output contracts. Runner contract: assert expected vs actual, non-zero exit on
 * mismatch.
 *
 * BIPOLAR per instrument-bipolarity.md MUST-1, and the markdown pole asserts a
 * failure IDENTITY (the `formatter` string) per MUST-2, never a bare exit code.
 *
 * TWO ARMS ARE CONDITIONAL, AND THE REGISTRY FLOOR IS SET BELOW THEM.
 * The pin-resolution arm and the anti-vacuity arm both need `npx` to reach the
 * registry; every other arm is offline-deterministic. `run-audit-fixtures.mjs`
 * counts only PASS/FAIL lines, so a floor set at the ONLINE figure would red an
 * offline run as a dropped case set — an ENVIRONMENT fact attributed as a
 * regression, which inverts that registry's stated purpose (its `_doc`: the floor
 * is what tells a real drop apart from noise). `min_cases` is therefore the
 * OFFLINE CORE. The live figures and how each was cross-checked are recorded in
 * `ci-audit-fixtures.json::runners["auto-format"]._min_cases_note` and are
 * deliberately NOT restated here: this header carried them once, run.mjs later
 * gained the two-case R5-ARM3-HIGH1 accounting loop below, and both the counts and
 * the floor in this paragraph went stale silently because nothing re-derives a
 * comment. The registry is the one surface that is measured when it changes.
 *
 * WHAT THAT DOES NOT TRADE AWAY. Neither conditional arm ever asserts a pass it
 * did not earn. A BAD PIN still REDS wherever it is testable: the arm separates
 * "npx unreachable" from "npx works and THIS specifier is bad" with a control the
 * environment must satisfy, and only the first yields SKIP. What the lower floor
 * gives up is a COUNT-level signal that could fire on the environment and never on
 * the code — a false RED, traded for nothing.
 */
import { readFileSync } from "node:fs";
import { evaluate, CANONICAL_EXPECT, CHECK_IDS } from "./auto-format-cases.mjs";

const { rows } = evaluate(CANONICAL_EXPECT);

let failures = 0;

// ── R5-ARM3-HIGH1 — every DECLARED check id is ACCOUNTED FOR, on EVERY pole ──
//
// Named for the Tier-1 redteam finding it closes, per coc-artifact-eval-coverage.md
// MUST-2: the case-name IS the finding id, so the class reds the moment a future
// edit re-opens it rather than being verified once by an audit that evaporates.
//
// The finding: `md-byte-identical` was emitted on the `dispatch.md = false` poles
// and SILENTLY OMITTED on the `dispatch.md = true` pole, so the violation fixture
// reported 14 of 15 declared ids while the clean one reported 15. `CHECK_IDS` is an
// EXTERNAL contract — a consumer reconciling it against the emitted rows got a
// shortfall with no account — and an id that renders as an ABSENT row cannot be
// told from one that never ran (probe-driven-verification.md MUST-7).
//
// WHY IT ASSERTS THE ACCOUNTING AND NOT THE ROW. Pinning "`md-byte-identical` is
// present when dispatch.md is true" would close this instance and none of its
// siblings; the invariant is that NO declared id may vanish on ANY pole, so the
// case is written over the whole declared set and every pole the fixtures ship.
// It is deliberately polarity-BLIND: a skipped row satisfies it exactly as a
// scored one does, because the question is whether the id was ACCOUNTED FOR, not
// whether it passed.
const POLES = ["clean-live-hook", "violation-md-dispatched"];
for (const pole of POLES) {
  const want = JSON.parse(readFileSync(new URL(`./${pole}/expect.json`, import.meta.url), "utf8"));
  const emitted = new Set(evaluate(want).rows.map((r) => r.id));
  const unaccounted = CHECK_IDS.filter((id) => !emitted.has(id));
  const ok = unaccounted.length === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  R5-ARM3-HIGH1: every declared CHECK_ID is accounted for on pole "${pole}"\n` +
      `      expected: 0 unaccounted of ${CHECK_IDS.length} declared\n` +
      `      actual  : ${unaccounted.length} unaccounted${unaccounted.length ? ` (${unaccounted.join(", ")})` : ""}`,
  );
}
for (const r of rows) {
  if (r.skipped) {
    console.log(`SKIP  ${r.label} — ${r.note}`);
    continue;
  }
  if (!r.passed) failures++;
  console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.label}\n      expected: ${r.expected}\n      actual  : ${r.actual}`);
}

console.log(failures === 0 ? "\nALL FIXTURES PASS" : `\n${failures} FIXTURE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
