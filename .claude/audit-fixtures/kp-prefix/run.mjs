#!/usr/bin/env node
/**
 * kp-prefix — audit-fixture runner for `.claude/hooks/lib/kp-prefix.js`, the
 * detector of `specs-authority.md` Rule 10 INVARIANT 1 (a `knowledge-product:`
 * field carries a well-formed `kp://` URN). Ships WITH the detector per
 * `cc-artifacts.md` Rule 9.
 *
 *   node .claude/audit-fixtures/kp-prefix/run.mjs
 *   rc=$?        # 0 = all green
 *
 * Override the module under test (to RED the suite against a mutant) with:
 *   LIB=/abs/path/to/mutant.js node .claude/audit-fixtures/kp-prefix/run.mjs
 *
 * ── WHAT A GREEN RUN HERE DOES AND DOES NOT SHOW ────────────────────────────
 * It shows the PREDICATES decide correctly over the cases beside this file. It
 * does NOT show the guard RUNS — that is `.claude/settings.json` plus
 * `registration-preflight.mjs`, not this runner — and it does NOT show Rule 10
 * is enforced: the module reaches ONE of the rule's FIVE invariants, and the
 * other four are judgment-bearing and stay with gate-review.
 *
 * ── THE FIXTURE SHAPE: SUBJECT AND ANSWER KEY ARE SEPARATE FILES ────────────
 * `<case>.txt`      the DOCUMENT, byte-for-byte as it would be written. It
 *                   carries no directives, no expectation and no commentary, so
 *                   nothing in the subject can change the verdict on itself.
 * `<case>.expected` the ANSWER KEY (JSON): the simulated `path` (an INPUT — the
 *                   scope predicate's argument, which is not part of the
 *                   content), the `expect`ed rule_ids, the `disposition`, the
 *                   predicate `family`, and `defeats` — the naive check that
 *                   case exists to break.
 *
 * ── THREE DISPOSITIONS, AND THE THIRD IS THE POINT ──────────────────────────
 * `firing`  a case that MUST produce the named rule_ids.
 * `clean`   a case that MUST be silent, and is silent CORRECTLY.
 * `declared-blind`  a case that IS a violation and on which the detector is
 *           SILENT BY CONSTRUCTION — the column-0 anchor and the unterminated-
 *           fence reading each buy their discrimination at a known cost. These
 *           are reported as BLIND, never PASS, and are EXCLUDED from the clean
 *           count, so a reader can never mistake a declared cost for coverage.
 *           A `clean` and a `declared-blind` case are byte-identical in their
 *           observed output; only this file distinguishes them, which is why
 *           the distinction is recorded rather than inferred.
 *
 * ── BIPOLAR BY CONSTRUCTION (`instrument-bipolarity.md` MUST-2) ─────────────
 * A set that only asserts FIRING passes identically against a detector that
 * fires on everything; a set that only asserts SILENCE passes identically
 * against an INERT one. Both risks are live here and one of them is acute:
 * MEASURED on this tree, the corpus holds ZERO live `knowledge-product:` fields
 * — every occurrence is a fenced teaching example inside a rule file, or prose
 * naming the field type — so this detector has no true-positive population at
 * loom at all, and these fixtures are the ONLY place its firing is ever
 * demonstrated. An inert advisory and a clean session are indistinguishable in
 * production, so the silence poles are the ones that can rot unnoticed. Every
 * scope-restriction predicate therefore carries BOTH poles:
 *
 *   scope: path         flag: bare-table-name-body
 *                       clean: out-of-scope-rule-file  (BYTE-IDENTICAL body;
 *                              only the path differs)
 *   scope: extension    clean: out-of-scope-extension
 *   fence: open         clean: fenced-teaching-example
 *   fence: close        flag: real-field-after-closed-fence  (a FIRING case, so
 *                              a never-closing tracker reds instead of going
 *                              quietly silent)
 *   field vs prose      clean: prose-mention-only
 *   value normalization clean: quoted-urn / comment-tail / parenthetical-tail
 *   grammar             flag: malformed-missing-version / malformed-two-segments
 *                       clean: wellformed-urn
 *   typed worlds        flag: empty-value / block-scalar-value
 *   regions             flag: frontmatter-field-bare (frontmatter)
 *                       flag: bare-table-name-body   (body)
 *
 * ── ANTI-VACUITY FLOOR ──────────────────────────────────────────────────────
 * The run FAILS if the set collapses to one pole, if any expected rule_id is
 * not one the module actually exports, or if a `firing` case expects nothing.
 * A suite that silently loses its firing half would otherwise stay green.
 *
 * FAILURE OUTPUT NAMES AN IDENTITY, never a bare non-zero exit: each mismatch
 * prints the case, its predicate family, the expected and observed rule_ids,
 * and the naive check that case was built to defeat. The run ends with a RED SET.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const require_ = createRequire(import.meta.url);
const LIB_PATH = process.env.LIB || path.join(REPO, ".claude/hooks/lib/kp-prefix.js");
const lib = require_(LIB_PATH);

/** The closed set of rule_ids this module can emit — an expectation outside it is a typo. */
const KNOWN_RULE_IDS = new Set([
  lib.RULE_MISSING_SCHEME,
  lib.RULE_MALFORMED_URN,
  lib.RULE_UNPARSEABLE,
]);

const cases = readdirSync(HERE)
  .filter((f) => f.endsWith(".txt"))
  .sort();

if (cases.length === 0) {
  console.error("FAIL harness/no-cases: the runner found zero `*.txt` fixtures.");
  process.exit(1);
}

const red = [];
let firing = 0;
let clean = 0;
let blind = 0;

for (const file of cases) {
  const name = file.replace(/\.txt$/, "");
  const keyPath = path.join(HERE, `${name}.expected`);
  if (!existsSync(keyPath)) {
    red.push({
      name,
      family: "(no answer key)",
      expect: ["<none>"],
      got: ["<not run>"],
      defeats: "a fixture with no `.expected` sidecar asserts nothing and would pass vacuously.",
    });
    console.log(`FAIL ${name} — no \`${name}.expected\` answer key beside the subject.`);
    continue;
  }

  let key;
  try {
    key = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch (err) {
    red.push({
      name,
      family: "(unparseable answer key)",
      expect: ["<none>"],
      got: [`THREW: ${err.message}`],
      defeats: "an unparseable answer key is a finding, not a skip.",
    });
    console.log(`FAIL ${name} — answer key is not valid JSON: ${err.message}`);
    continue;
  }

  const expect = Array.isArray(key.expect) ? [...key.expect].sort() : [];
  const disposition = key.disposition || (expect.length ? "firing" : "clean");
  const family = key.family || "(unclassified)";
  const defeats = key.defeats || "(undeclared)";

  const unknown = expect.filter((id) => !KNOWN_RULE_IDS.has(id));
  if (unknown.length > 0) {
    red.push({
      name,
      family,
      expect,
      got: [`UNKNOWN rule_id(s): ${unknown.join(",")}`],
      defeats,
    });
    console.log(`FAIL ${name} [${family}] — expects rule_id(s) the module cannot emit: ${unknown.join(",")}`);
    continue;
  }
  if (disposition === "firing" && expect.length === 0) {
    red.push({
      name,
      family,
      expect,
      got: ["<vacuous firing case>"],
      defeats,
    });
    console.log(`FAIL ${name} [${family}] — declared \`firing\` but expects no rule_id.`);
    continue;
  }

  const text = readFileSync(path.join(HERE, file), "utf8");

  // The guard's OWN order: the scope predicate first, then the content parse.
  // Composing it here (rather than calling only the content half) is what makes
  // the out-of-scope poles test the predicate the hook actually applies.
  let findings;
  try {
    findings = lib.isGovernedSpecSurface(key.path)
      ? lib.findKnowledgeProductFindings(text)
      : [];
  } catch (err) {
    red.push({ name, family, expect, got: [`THREW: ${err.message}`], defeats });
    console.log(`FAIL ${name} [${family}] — predicate THREW: ${err.message}`);
    continue;
  }
  const got = findings.map((f) => f.rule_id);

  // EVIDENCE INTEGRITY — the rule_id is not the whole finding.
  // `quotes_verbatim` (optional, per case) names a substring the evidence MUST
  // carry unaltered. Added after a DOUBLE-ESCAPED control-character class in
  // `sanitize()` silently ate letters out of the quoted value
  // (`churn_features_table` rendered `ch rn_ eat res_table`) while every case
  // here still passed, because the set only ever compared rule_ids. An advisory
  // whose evidence misquotes the offending line sends the reader looking for a
  // string that is not in their file — so the quote is part of the contract, and
  // is now pinned rather than assumed.
  if (Array.isArray(key.quotes_verbatim) && key.quotes_verbatim.length > 0) {
    const blob = findings.map((f) => f.evidence).join("\n");
    const missing = key.quotes_verbatim.filter((q) => !blob.includes(q));
    if (missing.length > 0) {
      red.push({
        name,
        family: `${family} [evidence integrity]`,
        expect: key.quotes_verbatim,
        got: [`evidence does NOT carry verbatim: ${missing.join(" | ")}`],
        defeats:
          "an evidence string that mangles the value it quotes. The rule_ids can be entirely correct while the quoted text is corrupted, and a rule_id-only comparison is blind to it.",
      });
      console.log(
        `FAIL ${name} [${family}] — evidence lost verbatim text: ${missing.join(" | ")}`,
      );
      continue;
    }
  }

  const e = expect.join(",");
  const g = [...got].sort().join(",");
  if (e !== g) {
    red.push({ name, family, expect, got, defeats });
    console.log(
      `FAIL ${name} [${family}] — expected [${e || "(silent)"}] got [${g || "(silent)"}]`,
    );
    continue;
  }

  if (disposition === "declared-blind") {
    blind += 1;
    console.log(
      `BLIND ${name} [${family}] — SILENT ON A REAL VIOLATION, by construction. Not a clean pole.`,
    );
  } else if (disposition === "firing") {
    firing += 1;
    console.log(`PASS  ${name} [${family}] — ${g}`);
  } else {
    clean += 1;
    console.log(`PASS  ${name} [${family}] — (silent)`);
  }
}

// ── anti-vacuity floor ───────────────────────────────────────────────────────
if (firing === 0) {
  red.push({
    name: "harness/no-firing-pole",
    family: "anti-vacuity",
    expect: [">=1 firing case"],
    got: ["0"],
    defeats: "a silence-only set passes identically against an INERT detector.",
  });
  console.log("FAIL harness/no-firing-pole — the set asserts no firing case.");
}
if (clean === 0) {
  red.push({
    name: "harness/no-clean-pole",
    family: "anti-vacuity",
    expect: [">=1 clean case"],
    got: ["0"],
    defeats: "a firing-only set passes identically against a detector that fires on everything.",
  });
  console.log("FAIL harness/no-clean-pole — the set asserts no clean case.");
}

// TWO QUANTITIES, NEVER SUMMED UNDER ONE LABEL. An earlier revision printed
// `${cases.length - red.length}/${cases.length} cases pass`, which counted the
// DECLARED-BLIND rows as passing cases — so it reported 24 while only 22 rows
// ever emit a PASS. That is the mislabelled-quantity defect: the denominator
// said "cases" and meant "rows in the table", while every consumer of the line
// reads "cases" as "coverage-asserting cases". It had a live consequence — the
// registry's `min_cases` for this runner was first declared 24 from this line
// and `run-audit-fixtures.mjs`, which counts PASS rows, red it as `under-cases`.
// The blind rows are still printed, still enumerated, and still not coverage;
// they are simply no longer added to a total labelled "pass".
console.log(
  `\n${cases.length - red.length - blind}/${cases.length - blind} coverage-asserting cases pass ` +
    `(${firing} firing, ${clean} clean). ` +
    `${blind} DECLARED-BLIND row(s) are excluded from BOTH sides of that fraction — they are ` +
    `silent on a REAL violation by construction and are not coverage. Total rows: ${cases.length}.`,
);

if (red.length > 0) {
  console.log("\nRED SET — case :: predicate family :: identity mismatch :: what it defends against:");
  for (const r of red) {
    console.log(
      `  ${r.name} :: ${r.family} :: expected [${r.expect.join(",") || "(silent)"}] ` +
        `:: observed [${r.got.join(",") || "(silent)"}]\n      DEFEATS: ${r.defeats}`,
    );
  }
  process.exit(1);
}
process.exit(0);
