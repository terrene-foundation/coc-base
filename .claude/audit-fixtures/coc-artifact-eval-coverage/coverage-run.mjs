#!/usr/bin/env node
/**
 * coverage-run.mjs — audit-fixture runner for `.claude/hooks/lib/artifact-coverage.js`,
 * the Phase-2 detector for `coc-artifact-eval-coverage.md` MUST-1 / MUST-4.
 * Ships WITH the detector per `cc-artifacts.md` Rule 9.
 *
 * SCOPE OF THIS FILE. It drives ONLY the `coverage-*.txt` fixtures in this
 * directory. The directory ALSO holds LLM-judge probe candidates (`flag-*`,
 * `clean-*`, `meta-*` with `.expected` sidecars) belonging to a different tier;
 * this runner does not read them and must not be made to.
 *
 * SYNTHETIC INPUTS ONLY. Every fixture carries its OWN manifest, deferrals
 * registry and probe inventory inline. This runner NEVER reads
 * `.claude/test-harness/eval-manifest.json`, never touches the filesystem
 * outside this directory, and needs no live repo — so the verdicts cannot move
 * when the manifest is edited by someone else, and a consumer with no manifest
 * at all still runs the set.
 *
 * BIPOLAR BY CONSTRUCTION (`instrument-bipolarity.md` MUST-2). Every
 * scope-restriction predicate carries BOTH an accept pole and a reject pole:
 *
 *   1  registration          flag: new-rule-unregistered
 *                            clean: registered-artifact  (BYTE-IDENTICAL to the
 *                                   flag pole except the artifact's basename)
 *   2  id derivation         flag: new-agent-no-probe
 *                            clean: registered-by-fixturesdir-alias (a key that
 *                                   is NOT the basename still registers)
 *   3  probe-on-disk         flag: new-rule-unregistered
 *                            clean: probe-on-disk
 *   4  _declared_empty       flag: new-rule-unregistered
 *                            clean: declared-empty-sanctioned
 *   5  _deferred_probes      flag: new-rule-unregistered
 *                            clean: deferred-probes-sanctioned
 *   6  authorship deferral   flag: authorship-deferral-EXPIRED
 *                            clean: authorship-deferral-live  (the pair differs
 *                                   only in the `expires` year)
 *   7  subtree gate          flag: new-rule-unregistered
 *                            clean: skip-non-artifact-path, skip-outside-claude
 *   8  artifact-vs-nav       flag: new-rule-unregistered
 *                            clean: skip-readme
 *   9  extension gate        flag: new-rule-unregistered
 *                            clean: skip-non-markdown-in-tree (same directory)
 *  10  fail-open arms        clean: failopen-no-manifest,
 *                                   failopen-probe-shape-underivable,
 *                                   failopen-empty-path
 *
 * A set that only ever asserts FIRING passes identically against a detector that
 * fires on everything; a set that only ever asserts SILENCE passes identically
 * against an INERT detector. Both are live risks here, because this guard is
 * capped at advisory and an inert advisory is indistinguishable from a clean
 * session — nothing downstream would ever notice.
 *
 * FAILURE OUTPUT NAMES AN IDENTITY, never merely a non-zero exit: each mismatch
 * prints the case, the predicate family it belongs to, the expected rule_ids and
 * the observed ones, and the run ends with a RED SET listing every failing case.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const require_ = createRequire(import.meta.url);
const lib = require_(path.join(REPO, ".claude", "hooks", "lib", "artifact-coverage.js"));

/** Which predicate family each case exercises — printed on failure. */
const FAMILY = {
  "coverage-flag-new-rule-unregistered": "registration gate (accept pole)",
  "coverage-clean-registered-artifact": "registration gate (reject pole, byte-identical)",
  "coverage-flag-new-agent-no-probe": "subtree reach: agents/",
  "coverage-clean-registered-by-fixturesdir-alias": "derived id index (fixturesDir alias)",
  "coverage-clean-probe-on-disk": "probe-on-disk withdrawal",
  "coverage-clean-declared-empty-sanctioned": "sanctioned _declared_empty",
  "coverage-clean-deferred-probes-sanctioned": "sanctioned _deferred_probes",
  "coverage-clean-authorship-deferral-live": "probe_authorship_deferrals, LIVE",
  "coverage-flag-authorship-deferral-expired": "probe_authorship_deferrals, EXPIRED",
  "coverage-skip-non-artifact-path": "subtree gate (hooks/ is coc-eval-all's)",
  "coverage-skip-readme": "artifact-vs-navigation gate",
  "coverage-skip-outside-claude": "subtree gate (outside .claude/)",
  "coverage-skip-non-markdown-in-tree": "extension gate",
  "coverage-clean-failopen-no-manifest": "fail open: absent authority",
  "coverage-clean-failopen-probe-shape-underivable": "fail open: underivable probe shape",
  "coverage-clean-failopen-empty-path": "fail open: absent file_path",
};

/**
 * A fixture is `#`-prefixed narrative (one line of which declares `expect:`)
 * followed by the JSON context handed straight to the pure predicate.
 */
function parseFixture(text) {
  const expect = [];
  const body = [];
  for (const line of text.split("\n")) {
    const m = /^#\s*expect\s*:\s*(.*)$/.exec(line);
    if (m) {
      const v = m[1].trim();
      if (v && v !== "(silent)") expect.push(...v.split(/[,\s]+/).filter(Boolean));
      continue;
    }
    if (/^#/.test(line)) continue; // narrative comment
    body.push(line);
  }
  return { expect, ctx: JSON.parse(body.join("\n")) };
}

const cases = readdirSync(HERE)
  .filter((f) => f.startsWith("coverage-") && f.endsWith(".txt"))
  .sort();

if (cases.length === 0) {
  console.error("FAIL harness/no-cases: the runner found zero `coverage-*.txt` fixtures.");
  process.exit(1);
}

const red = [];
for (const file of cases) {
  const name = file.replace(/\.txt$/, "");
  const family = FAMILY[name] || "(unclassified)";
  let expect;
  let ctx;
  try {
    ({ expect, ctx } = parseFixture(readFileSync(path.join(HERE, file), "utf8")));
  } catch (err) {
    red.push({ name, family, expect: ["(unparsed)"], got: [`FIXTURE UNPARSEABLE: ${err.message}`] });
    console.log(`FAIL ${name} [${family}] — fixture unparseable: ${err.message}`);
    continue;
  }
  let got;
  try {
    got = lib.inspectArtifactCoverage(ctx).map((f) => f.rule_id);
  } catch (err) {
    red.push({ name, family, expect, got: [`THREW: ${err.message}`] });
    console.log(`FAIL ${name} [${family}] — predicate THREW: ${err.message}`);
    continue;
  }
  const e = [...expect].sort().join(",");
  const g = [...got].sort().join(",");
  if (e === g) {
    console.log(`PASS ${name} [${family}] — ${g || "(silent)"}`);
  } else {
    red.push({ name, family, expect, got });
    console.log(`FAIL ${name} [${family}] — expected [${e || "(silent)"}] got [${g || "(silent)"}]`);
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
