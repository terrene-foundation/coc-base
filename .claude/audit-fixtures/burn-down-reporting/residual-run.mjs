#!/usr/bin/env node
/**
 * residual-run.mjs — audit-fixture runner for `.claude/hooks/lib/residual-figure.js`,
 * the Phase-2 detector for `burn-down-reporting.md` MUST-1's REMAINS quantity on
 * the close-out surface MUST-3 fixes. Ships WITH the detector per
 * `cc-artifacts.md` Rule 9.
 *
 * SCOPE OF THIS FILE. It drives ONLY the `residual-*` fixtures in this directory.
 * The directory ALSO holds LLM-judge probe candidates (`flag-*`, `clean-*`,
 * `meta-*` with `.expected` sidecars) belonging to a DIFFERENT tier; this runner
 * does not read them, must not be made to, and nothing here modifies them.
 *
 * IT DRIVES THE PURE PREDICATE ON FIXTURE TEXT — no transcript, no hook payload,
 * no filesystem beyond reading these files. That is what makes the firing pole
 * demonstrable at all: the guard itself is only reachable through a live `Stop`
 * event.
 *
 * BIPOLAR BY CONSTRUCTION (`instrument-bipolarity.md` MUST-2). Every
 * scope-restriction predicate carries BOTH an accept pole and a reject pole:
 *
 *   1  the CLOSE-OUT cue gate  flag: counts-without-residual
 *                              clean: not-a-close-out-report (BYTE-IDENTICAL to
 *                                     the flag pole minus the cue line)
 *   2  the PROGRESS-COUNT gate flag: merge-count-only (the minimal firing shape)
 *                              clean: cue-without-counts
 *   3  the RESIDUAL clause     flag: counts-without-residual
 *                              clean: counts-with-residual (BYTE-IDENTICAL to the
 *                                     flag pole PLUS one residual sentence — the
 *                                     one byte-difference that decides the verdict)
 *   4  the EXPLICIT ZERO       clean: explicit-zero-residual ("nothing
 *                                     outstanding" IS a residual figure; reading
 *                                     an honest zero as an absent residual is the
 *                                     easiest way to get this predicate wrong)
 *   5  fence withdrawal        clean: skip-counts-in-code-fence (the flag pole's
 *                                     own count lines, fenced)
 *   6  block-quote withdrawal  clean: skip-counts-in-block-quote (same lines,
 *                                     quoted)
 *   7  fail-open on UNKNOWN    clean: empty-reply
 *   8  cue is not a BARE TOKEN    clean: cue-inside-filename (the token `burndown`
 *                                        inside `burndown-build.mjs` names an ARTEFACT,
 *                                        it makes no close-out claim)
 *                                 clean: cue-inside-inline-code (same token, masked
 *                                        as an inline code span)
 *                                 flag:  sweep-close-cleared-only (a REAL sweep
 *                                        close-out — the cue gate still admits it)
 *   9  PARTITIVE count            flag:  partitive-count ("cleared 12 of the open
 *                                        items" — digit and unit not adjacent)
 *                                 clean: partitive-count-with-residual (BYTE-IDENTICAL
 *                                        plus one residual sentence)
 *  10  residual read from         flag:  residual-word-inside-cleared-clause ("issues
 *      CLEARED-FREE clauses only         that were open" is CLEARED prose, not a
 *                                        residual figure)
 *
 * A set that only ever asserts FIRING passes identically against a detector that
 * fires on everything; a set that only ever asserts SILENCE passes identically
 * against an INERT detector. Both are live risks here: the guard is capped at
 * advisory, so an inert advisory is indistinguishable from a clean session.
 *
 * FAILURE OUTPUT NAMES AN IDENTITY, never merely a non-zero exit: each mismatch
 * prints the case, its predicate family, the expected rule_ids and the observed
 * ones, and the run ends with a RED SET listing every failing case.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const require_ = createRequire(import.meta.url);
const lib = require_(path.join(REPO, ".claude", "hooks", "lib", "residual-figure.js"));

/** Which predicate family each case exercises — printed on failure. */
const FAMILY = {
  "residual-flag-counts-without-residual": "close-out cue + counts + NO residual (accept pole)",
  "residual-flag-merge-count-only": "minimal firing shape (wrap-up cue + one count)",
  "residual-clean-counts-with-residual": "residual clause (reject pole; +1 sentence vs the flag)",
  "residual-clean-explicit-zero-residual": "explicit zero IS a residual figure",
  "residual-clean-not-a-close-out-report": "close-out cue gate (reject pole)",
  "residual-clean-cue-without-counts": "progress-count gate (reject pole)",
  "residual-skip-counts-in-code-fence": "withdrawal — counts inside a fenced block",
  "residual-skip-counts-in-block-quote": "withdrawal — counts inside a block quote",
  "residual-clean-empty-reply": "fail-open on an absent reply",
  "residual-clean-cue-inside-filename": "cue gate — a cue token inside a FILENAME is not a cue",
  "residual-clean-cue-inside-inline-code": "cue gate — a cue token inside an inline code span is not a cue",
  "residual-flag-sweep-close-cleared-only": "cue gate (accept pole — the sweep-close cue)",
  "residual-flag-partitive-count": "progress count — digit and unit split by a partitive",
  "residual-clean-partitive-count-with-residual": "residual clause (reject pole; +1 sentence vs the flag)",
  "residual-flag-residual-word-inside-cleared-clause": "residual read from CLEARED-free clauses only",
  "residual-clean-bare-cue-token-no-report-noun": "cue gate — bare `burndown` needs a report noun (isolates the cue narrowing)",
  "residual-clean-cue-token-inside-path": "cue gate — a cue token inside a PATH is not a cue (isolates path masking)",
};

/**
 * `#!expect: <ids>` is the ONLY runner directive. `#!` can never open a markdown
 * line, so the rest of the fixture is the reply body VERBATIM — a `#` heading, a
 * `>` quote and a ``` fence all survive, which they must, since two of them are
 * the predicates under test.
 */
function parseFixture(text) {
  const lines = text.split("\n");
  const expect = [];
  const body = [];
  for (const line of lines) {
    const m = /^#!expect\s*:\s*(.*)$/.exec(line);
    if (m) {
      const v = m[1].trim();
      if (v) expect.push(...v.split(/[,\s]+/).filter(Boolean));
      continue;
    }
    body.push(line);
  }
  return { expect, text: body.join("\n") };
}

const cases = readdirSync(HERE)
  .filter((f) => f.startsWith("residual-") && f.endsWith(".txt"))
  .sort();

if (cases.length === 0) {
  console.error("FAIL harness/no-cases: the runner found zero `residual-*.txt` fixtures.");
  process.exit(1);
}

const red = [];
for (const file of cases) {
  const name = file.replace(/\.txt$/, "");
  const { expect, text } = parseFixture(readFileSync(path.join(HERE, file), "utf8"));
  let got;
  try {
    got = lib.inspectCloseOutReport({ text }).map((f) => f.rule_id);
  } catch (err) {
    red.push({ name, family: FAMILY[name] || "(unclassified)", expect, got: [`THREW: ${err.message}`] });
    console.log(`FAIL ${name} [${FAMILY[name] || "?"}] — predicate THREW: ${err.message}`);
    continue;
  }
  const e = [...expect].sort().join(",");
  const g = [...got].sort().join(",");
  if (e === g) {
    console.log(`PASS ${name} [${FAMILY[name] || "?"}] — ${g || "(silent)"}`);
  } else {
    red.push({ name, family: FAMILY[name] || "(unclassified)", expect, got });
    console.log(
      `FAIL ${name} [${FAMILY[name] || "?"}] — expected [${e || "(silent)"}] got [${g || "(silent)"}]`,
    );
  }
}

console.log(`\n${cases.length - red.length}/${cases.length} cases pass.`);
if (red.length > 0) {
  console.log("\nRED SET — each line names the case, its predicate family, and the identity mismatch:");
  for (const r of red) {
    console.log(
      `  ${r.name} :: ${r.family} :: expected [${r.expect.join(",") || "(silent)"}] ` +
        `:: observed [${r.got.join(",") || "(silent)"}]`,
    );
  }
  process.exit(1);
}
process.exit(0);
