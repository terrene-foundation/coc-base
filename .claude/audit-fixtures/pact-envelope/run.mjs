#!/usr/bin/env node
/*
 * Audit-fixture runner for validate-pact-envelope.mjs (loom#665).
 *
 * Structural probe per `probe-driven-verification.md` MUST-3 + one case per
 * predicate (both a passing AND a failing case) per `cc-artifacts.md` Rule 9 /
 * `coc-artifact-eval-coverage.md`: the pure validatePactEnvelope() predicate is
 * run over a committed VALID v1.1 envelope (valid-v1_1-envelope.json) AND a
 * per-predicate battery of single-mutation variants; each case's
 * { valid, error-code } is compared to its declared expectation. NO semantic
 * judgment, NO regex on prose.
 *
 *   valid-base                → valid   (the reference envelope: floor tool ≤ declared supervised)
 *   floor-equals-declared     → valid   (boundary: floor == declared is allowed)
 *   floor-pseudo-declared-top → valid   (widest legal spread: pseudo ≤ delegating)
 *   wrong-version             → invalid VERSION_MISMATCH          (predicate 1)
 *   missing-version           → invalid VERSION_MISMATCH          (predicate 1, absent)
 *   missing-declared-posture  → invalid MISSING_DECLARED_POSTURE  (predicate 2)
 *   invalid-declared-posture  → invalid INVALID_DECLARED_POSTURE  (predicate 2, off-ladder)
 *   missing-posture-floor     → invalid MISSING_POSTURE_FLOOR     (predicate 3)
 *   invalid-posture-floor     → invalid INVALID_POSTURE_FLOOR     (predicate 3, off-ladder)
 *   floor-above-declared      → invalid FLOOR_ABOVE_DECLARED      (predicate 4, the allOf floor≤declared rule)
 *   not-an-object             → invalid NOT_AN_OBJECT             (top-level guard)
 *
 * Exit 0 = all cases pass. Exit 1 = >=1 mismatch.
 */
import { validatePactEnvelope } from "../../bin/validate-pact-envelope.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = JSON.parse(readFileSync(join(here, "valid-v1_1-envelope.json"), "utf8"));
const clone = () => JSON.parse(JSON.stringify(BASE));

const cases = [
  { label: "valid-base", mutate: (e) => e, valid: true, code: null },
  {
    label: "floor-equals-declared",
    mutate: (e) => {
      e.posture_floor = "supervised"; // == declared_posture; the ≤ boundary is legal
      return e;
    },
    valid: true,
    code: null,
  },
  {
    label: "floor-pseudo-declared-top",
    mutate: (e) => {
      e.declared_posture = "delegating";
      e.posture_floor = "pseudo"; // widest legal spread
      return e;
    },
    valid: true,
    code: null,
  },
  {
    label: "wrong-version",
    mutate: (e) => {
      e.version = "1.0";
      return e;
    },
    valid: false,
    code: "VERSION_MISMATCH",
  },
  {
    label: "missing-version",
    mutate: (e) => {
      delete e.version;
      return e;
    },
    valid: false,
    code: "VERSION_MISMATCH",
  },
  {
    label: "missing-declared-posture",
    mutate: (e) => {
      delete e.declared_posture;
      return e;
    },
    valid: false,
    code: "MISSING_DECLARED_POSTURE",
  },
  {
    label: "invalid-declared-posture",
    mutate: (e) => {
      e.declared_posture = "omnipotent"; // off the ladder
      return e;
    },
    valid: false,
    code: "INVALID_DECLARED_POSTURE",
  },
  {
    label: "missing-posture-floor",
    mutate: (e) => {
      delete e.posture_floor;
      return e;
    },
    valid: false,
    code: "MISSING_POSTURE_FLOOR",
  },
  {
    label: "invalid-posture-floor",
    mutate: (e) => {
      e.posture_floor = "manual"; // off the ladder
      return e;
    },
    valid: false,
    code: "INVALID_POSTURE_FLOOR",
  },
  {
    label: "floor-above-declared",
    mutate: (e) => {
      e.declared_posture = "tool";
      e.posture_floor = "autonomous"; // rank 3 > rank 1 — floor above declared
      return e;
    },
    valid: false,
    code: "FLOOR_ABOVE_DECLARED",
  },
  {
    label: "not-an-object",
    mutate: () => "just a string",
    valid: false,
    code: "NOT_AN_OBJECT",
  },
];

let passed = 0;
let failed = 0;
for (const c of cases) {
  const env = c.mutate(clone());
  const res = validatePactEnvelope(env);
  const okValid = res.valid === c.valid;
  const okCode = c.code === null ? res.errors.length === 0 : res.errors.some((e) => e.code === c.code);
  if (okValid && okCode) {
    passed++;
    process.stdout.write(`  PASS  ${c.label} → valid=${res.valid}${c.code ? ` [${c.code}]` : ""}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL  ${c.label}: expected valid=${c.valid} code=${c.code}, got valid=${res.valid} codes=${JSON.stringify(res.errors.map((e) => e.code))}\n`);
  }
}

process.stdout.write(`\npact-envelope fixtures: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
