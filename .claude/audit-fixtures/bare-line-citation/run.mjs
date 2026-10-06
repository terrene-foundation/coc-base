#!/usr/bin/env node
/*
 * Audit-fixture runner for `.claude/hooks/lib/bare-line-citation.js` — the Phase-2 detector of
 * `symbol-anchored-citations.md` MUST-1/MUST-2, shipped WITH its fixtures per
 * `cc-artifacts.md` Rule 9.
 *
 * STRUCTURAL probe per `probe-driven-verification.md` MUST-3: the pure predicate
 * `findBareLineCitations()` runs over each committed case and its flagged/clean verdict is
 * compared byte-exact to the sidecar `.verdict`. NO semantic judgment, NO LLM.
 *
 * BIPOLAR BY CONSTRUCTION per `instrument-bipolarity.md` MUST-2. Every scope-restriction
 * predicate carries BOTH poles, because a set that only ever asserts FIRING passes identically
 * against a detector that fires on everything, and a set that only ever asserts SILENCE passes
 * identically against one that is INERT. Both are live risks here: this predicate's whole job is
 * to stay quiet on the overwhelming majority of citations in the corpus.
 *
 *   WINDOW ASYMMETRY (the load-bearing pair, and the reason this detector is not one regex)
 *     skip-range-anchor-in-sibling-sentence   — a RANGE reaches the whole PARAGRAPH for its anchor
 *     flag-bare-anchor-in-sibling-sentence    — byte-identical text, `:88` instead of `:88-140`,
 *                                               so the window narrows to the SENTENCE and the same
 *                                               anchor is out of reach. These two differ by FOUR
 *                                               characters and must disagree.
 *   SECTION MARK
 *     skip-section-mark-same-sentence / flag-section-mark-in-next-sentence
 *   ANCHOR KINDS (each a separate `hasGrepStableAnchor` arm)
 *     skip-symbol-primary-line-hint  (call form)   skip-named-contract-anchor  (Rule N)
 *     skip-scope-resolution-anchor   (`a::b`)
 *   SUPPRESSORS (each one is a way the matcher would otherwise fire on non-citations)
 *     skip-fenced-block-citation (fence mask)   skip-url-authority (host:port)
 *     skip-no-citation-shape     (clock / ratio — no extension, so not a citation at all)
 *   NON-ANCHOR
 *     flag-two-citations-no-anchor — a SECOND citation is not an anchor, it is a second dead
 *                                    pointer; without this arm the predicate would self-clear
 *                                    every list of bare lines.
 *   PARAGRAPH BOUND
 *     flag-range-anchor-in-other-paragraph — the paragraph window has a far edge too.
 *
 * SCOPE-PREDICATE CASES are asserted inline below rather than as files: `isDurablePlanningArtifact`
 * takes a PATH, not a body, so a file fixture could not express it. Both poles are covered.
 *
 * Exit 0 = every case matches its verdict. Exit 1 = >=1 mismatch.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const lib = require_(join(here, "..", "..", "hooks", "lib", "bare-line-citation.js"));

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

// ---- 1. body cases -------------------------------------------------------
for (const name of readdirSync(here)
  .filter((n) => n.endsWith(".case.md"))
  .sort()) {
  const text = readFileSync(join(here, name), "utf8");
  const expected = readFileSync(
    join(here, name.replace(/\.case\.md$/, ".verdict")),
    "utf8",
  ).trim();
  const hits = lib.findBareLineCitations(text);
  const actual = hits.length > 0 ? "flagged" : "clean";
  check(
    name.replace(/\.case\.md$/, ""),
    actual,
    expected,
    JSON.stringify(hits.map((h) => h.citation)),
  );
}

// ---- 2. scope predicate, BOTH poles --------------------------------------
// The detector must never fire outside the rule's own `paths:` globs, and must fire inside every
// one of them. A scope predicate that answers `true` everywhere is the same non-discriminating
// instrument `instrument-discipline.md` MUST-1 refuses as evidence.
for (const p of [
  "workspaces/x/specs/01-domain.md",
  "workspaces/x/02-plans/01-sharded-plan.md",
  "workspaces/x/01-analysis/02-findings.md",
  "briefs/lane-a.md",
  "todos/open.md",
  "journal/0375-decision.md",
]) {
  check(`scope-in:${p}`, String(lib.isDurablePlanningArtifact(p)), "true");
}
for (const p of [
  ".claude/rules/symbol-anchored-citations.md", // the RULE itself is out of scope
  ".claude/hooks/lib/bare-line-citation.js", // source, not a planning artifact
  "journal/0375-decision.png", // in a glob, but not a text surface
  "README.md", // durable, but not a planning artifact
  "src/specsheet.md", // `specs` as a substring, not a path segment
]) {
  check(`scope-out:${p}`, String(lib.isDurablePlanningArtifact(p)), "false");
}

// ---- 3. the finding NAMES a failure identity -----------------------------
// `instrument-bipolarity.md` MUST-2: a red pole must say WHAT failed. A finding that carried only
// a boolean would pass every case above and still be useless at the surface.
{
  const hits = lib.findBareLineCitations(
    "The canon tip resolver is at `sync-from-canon-fetch.mjs:337`.",
  );
  check("identity:rule_id", hits[0] && hits[0].rule_id, "symbol-anchored-citations/MUST-1");
  check("identity:severity", hits[0] && hits[0].severity, "advisory");
  check("identity:citation", hits[0] && hits[0].citation, "sync-from-canon-fetch.mjs:337");
  check("identity:window", hits[0] && hits[0].window, "sentence");
  check(
    "identity:clause-range",
    lib.findBareLineCitations("The battery is at `f.mjs:471-509` and was reviewed.")[0].clause,
    "MUST-2",
  );
}

process.stdout.write(
  `\nbare-line-citation fixtures: ${passed} passed, ${failed} failed\n`,
);
process.exit(failed > 0 ? 1 : 0);
