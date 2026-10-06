#!/usr/bin/env node
/*
 * Audit-fixture runner for `.claude/hooks/lib/bug-signal-defer.js` — the Phase-2 detector of
 * `product-completion-first.md` MUST-2/MUST-3, shipped WITH its fixtures per `cc-artifacts.md`
 * Rule 9.
 *
 * STRUCTURAL probe per `probe-driven-verification.md` MUST-3: the pure predicate
 * `findBugSignalDefers()` runs over each committed case and its flagged/clean verdict is compared
 * byte-exact to the sidecar `.verdict`. NO semantic judgment, NO LLM.
 *
 * BIPOLAR BY CONSTRUCTION per `instrument-bipolarity.md` MUST-2. The predicate is a CONJUNCTION —
 * a DEFER disposition AND a BUG signal — so each half needs a case that isolates it, or a detector
 * that dropped one half would still pass:
 *
 *   THE CONJUNCTION, one arm at a time
 *     flag-failing-test-deferred        — both halves present (the rule's own canonical violation)
 *     skip-bug-signal-no-defer          — BUG signal, NO defer   ⇒ drop the defer half and this reds
 *     skip-polish-defer                 — defer, NO BUG signal   ⇒ drop the signal half and this reds
 *   SIGNAL COVERAGE (the vocabulary is the rule's, and closed)
 *     flag-contract-break-deferred-bullet · flag-gate-integrity-deferred
 *   THE FOUR SUPPRESSORS, each with a live counterpart above
 *     skip-fenced-example               (1) fence mask
 *     skip-table-row-is-not-a-sentence  (2) a `|` row is not a sentence — this is where 3 of the 5
 *                                           measured corpus hits came from
 *     skip-bug-signal-fixed-not-deferred + skip-bug-signal-deferred-but-fixed
 *                                       (3) FIXED / FIX NOW is not a defer
 *     skip-quoted-antipattern-blocked   (4) a `BLOCKED` line QUOTES a rationalization to forbid it
 *   COMPLIANT DEFER
 *     skip-incremental-defer-no-bug-signal — the rule's own canonical compliant record
 *
 * SCOPE-PREDICATE cases are asserted inline: `isDispositionSurface` takes a PATH, not a body.
 *
 * Exit 0 = every case matches its verdict. Exit 1 = >=1 mismatch.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const lib = require_(join(here, "..", "..", "hooks", "lib", "bug-signal-defer.js"));

let passed = 0;
let failed = 0;

function check(name, actual, expected, detail) {
  if (actual === expected) {
    passed++;
    process.stdout.write(`  PASS  ${name} → ${actual}\n`);
  } else {
    failed++;
    process.stderr.write(
      `  FAIL  ${name}: expected ${expected}, got ${actual}${detail ? ` (${detail})` : ""}\n`,
    );
  }
}

for (const name of readdirSync(here)
  .filter((n) => n.endsWith(".case.md"))
  .sort()) {
  const text = readFileSync(join(here, name), "utf8");
  const expected = readFileSync(join(here, name.replace(/\.case\.md$/, ".verdict")), "utf8").trim();
  const hits = lib.findBugSignalDefers(text);
  check(
    name.replace(/\.case\.md$/, ""),
    hits.length > 0 ? "flagged" : "clean",
    expected,
    JSON.stringify(hits.map((h) => h.signal)),
  );
}

// ---- scope predicate, BOTH poles ----------------------------------------
for (const p of [
  "workspaces/lane-a/SWEEP-2026-09-13.md",
  "todos/open.md",
  "journal/0468-amendment.md",
  ".session-notes/someoperator.md",
  "SWEEP-session18.md",
]) {
  check(`scope-in:${p}`, String(lib.isDispositionSurface(p)), "true");
}
for (const p of [
  ".claude/rules/product-completion-first.md", // the RULE itself is out of scope
  ".claude/hooks/lib/bug-signal-defer.js",
  "workspaces/lane-a/diagram.png",
  "src/app.ts",
]) {
  check(`scope-out:${p}`, String(lib.isDispositionSurface(p)), "false");
}

// ---- the finding NAMES a failure identity --------------------------------
{
  const hits = lib.findBugSignalDefers("Deferring the failing-test fix as incremental.");
  check("identity:rule_id", hits[0] && hits[0].rule_id, "product-completion-first/MUST-2");
  check("identity:severity", hits[0] && hits[0].severity, "advisory");
  check("identity:signal", hits[0] && String(hits[0].signal).toLowerCase(), "failing-test");
  check("identity:excerpt-present", String(Boolean(hits[0] && hits[0].excerpt)), "true");
}

// ---- the vocabulary is CLOSED, and is the rule's ------------------------
// A detector that silently widened its signal set would assert a category boundary the rule never
// drew. Pinning the count reds on an undeclared addition.
check("vocabulary:closed", String(lib.BUG_SIGNALS.length), "8");

process.stdout.write(`\nbug-signal-defer fixtures: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
