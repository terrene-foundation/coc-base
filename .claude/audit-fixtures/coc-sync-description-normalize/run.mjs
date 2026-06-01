#!/usr/bin/env node
/*
 * Fixture for coc-sync.md Step 6b description-normalization (CRIT R-2, F77 R2).
 *
 * Pins the jq sub() invocation Step 6b uses to rewrite the .description
 * field's (Python)/(Rust)/(Ruby) parenthetical per the target VARIANT.
 *
 * The R1 form anchored the regex with `$`, requiring the parenthetical
 * at end-of-string. The loom source descriptions place (Python) MID-
 * string (e.g., "Kailash COC Claude (Python) - Claude Code hooks
 * configuration"); the $-anchored sub() matched nothing, producing the
 * broken shape "Kailash COC Claude (Python) - <prose> (Rust)" on rs sync.
 *
 * This fixture executes the canonical R2 jq command against synthetic
 * shapes and asserts the rewrite preserves mid-string position +
 * trailing prose.
 *
 *   node .claude/audit-fixtures/coc-sync-description-normalize/run.mjs
 *
 * Exit 0 = all assertions pass; 1 = regression in the regex.
 */

import { execFileSync } from "node:child_process";

// Canonical Step 6b jq expression (must match coc-sync.md verbatim
// in the Step 6b DO block).
const JQ_EXPR =
  '.description = (.description | sub("\\\\((Python|Rust|Ruby)\\\\)"; "(\\($lbl))"))';

const CASES = [
  {
    name: "rs: mid-string (Python) → (Rust), trailing prose preserved",
    input: {
      description:
        "Kailash COC Claude (Python) - Claude Code hooks configuration",
    },
    lbl: "Rust",
    expectDescription:
      "Kailash COC Claude (Rust) - Claude Code hooks configuration",
  },
  {
    name: "rs: multi-cli mid-string (Python) → (Rust)",
    input: { description: "Kailash COC Multi-CLI (Python)" },
    lbl: "Rust",
    expectDescription: "Kailash COC Multi-CLI (Rust)",
  },
  {
    name: "rb: mid-string (Python) → (Ruby)",
    input: {
      description: "Kailash COC Claude (Python) - hooks + variant overlays",
    },
    lbl: "Ruby",
    expectDescription:
      "Kailash COC Claude (Ruby) - hooks + variant overlays",
  },
  {
    name: "py: idempotent — (Python) → (Python)",
    input: { description: "Kailash COC Claude (Python) - already correct" },
    lbl: "Python",
    expectDescription: "Kailash COC Claude (Python) - already correct",
  },
  {
    name: "rs: end-of-string (Python) → (Rust) (regression cover for $ anchor)",
    input: { description: "Kailash COC Claude (Python)" },
    lbl: "Rust",
    expectDescription: "Kailash COC Claude (Rust)",
  },
  {
    name: "rs: no parenthetical → unchanged",
    input: {
      description: "Kailash COC Claude - no parenthetical to swap",
    },
    lbl: "Rust",
    expectDescription:
      "Kailash COC Claude - no parenthetical to swap",
  },
  {
    name: "rs: rs source already (Rust) → unchanged",
    input: { description: "Kailash COC Claude (Rust) - rs already correct" },
    lbl: "Rust",
    expectDescription: "Kailash COC Claude (Rust) - rs already correct",
  },
];

function runJq(input, lbl, expr) {
  const stdin = JSON.stringify(input);
  try {
    const out = execFileSync("jq", ["--arg", "lbl", lbl, expr], {
      input: stdin,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, parsed: JSON.parse(out) };
  } catch (e) {
    return {
      ok: false,
      err: (e.stdout || "") + (e.stderr || "") + (e.message || ""),
    };
  }
}

let failed = 0;
for (const c of CASES) {
  const r = runJq(c.input, c.lbl, JQ_EXPR);
  if (!r.ok) {
    failed++;
    console.log(`FAIL  ${c.name}`);
    console.log(`        - jq error: ${r.err.trim()}`);
    continue;
  }
  if (r.parsed.description !== c.expectDescription) {
    failed++;
    console.log(`FAIL  ${c.name}`);
    console.log(`        - expected: ${c.expectDescription}`);
    console.log(`        - actual:   ${r.parsed.description}`);
    continue;
  }
  console.log(`PASS  ${c.name}`);
}

console.log("");
if (failed) {
  console.log(`${failed} case(s) FAILED — description regex regressed`);
  process.exit(1);
}
console.log("all description-normalize cases passed");
process.exit(0);
