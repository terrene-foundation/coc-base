#!/usr/bin/env node
/**
 * run.mjs — audit-fixture runner for `.claude/hooks/lib/triage-routing.js`, the
 * detector for `issue-triage-routing.md` § "Route Every Triaged Issue By The Repo
 * `type`, Never By Convenience". Ships WITH the detector per `cc-artifacts.md`
 * Rule 9.
 *
 * THE FILE NAME IS `run.mjs`, and this line used to say `routing-run.mjs`. That
 * was not a typo with no consequence: `issue-triage-routing.md`'s Detection row
 * copied the name FROM HERE, so the rule cited a path that resolves to nothing,
 * and a reader checking the citation would have concluded the fixtures were
 * absent. A file's self-description is a citation source; it is corrected here
 * and in the rule together (2026-09-13 Tier-1 round).
 *
 * WHAT THESE FIXTURES DO AND DO NOT SHOW. They prove the PREDICATES decide
 * correctly, 14/14. They do NOT show the guard RUNS: `.claude/hooks/triage-routing-guard.js`
 * is registered in no hook-configuration surface, so it receives no event. A
 * green run here is evidence about logic, never about enforcement.
 *
 * SCOPE OF THIS FILE. It drives ONLY the `routing-*` fixtures in this directory.
 * The directory ALSO holds LLM-judge probe candidates (`flag-*`, `clean-*`,
 * `meta-*` with `.expected` sidecars) belonging to a different tier; this runner
 * does not read them and must not be made to.
 *
 * BIPOLAR BY CONSTRUCTION (`instrument-bipolarity.md` MUST-2). Every
 * scope-restriction predicate carries BOTH an accept pole and a reject pole:
 *
 *   1  the CLASS gate         flag: consumer-files-on-self-explicit
 *                             clean: non-consumer-class  (BYTE-IDENTICAL command
 *                                    to the off-lane flag; only the class differs)
 *   2  self-filing, explicit  flag: consumer-files-on-self-explicit
 *                             clean: files-on-declared-upstream
 *   3  self-filing, implicit  flag: consumer-files-on-self-implicit (no --repo)
 *                             clean: not-an-issue-create
 *   4  flag-form parity       flag: short-flag (-R, mixed case, .git suffix)
 *                             clean: upstream-equals-form (--repo=)
 *   5  the off-lane verdict   flag: consumer-files-off-lane
 *                             clean: off-lane-withheld-no-upstream (the
 *                                    deliberate degradation to a smaller true
 *                                    answer)
 *   6  segment reach          flag: chained-after-another-command
 *                             clean: empty-command (fail-open)
 *   7  command-vs-data        clean: skip-command-in-heredoc,
 *                                    skip-command-in-quoted-string
 *   8  read-vs-write          clean: skip-help-read
 *
 * A set that only ever asserts FIRING passes identically against a detector that
 * fires on everything; a set that only ever asserts SILENCE passes identically
 * against an INERT detector. Both are live risks here, because the whole guard
 * is capped at advisory and an inert advisory is indistinguishable from a clean
 * session — and because at loom (`coc-source`) this detector can never fire in
 * anger at all, so these fixtures are the ONLY place its firing is demonstrated.
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
const lib = require_(path.join(REPO, ".claude", "hooks", "lib", "triage-routing.js"));

/** Which predicate family each case exercises — printed on failure. */
const FAMILY = {
  "routing-flag-consumer-files-on-self-explicit": "class gate + explicit self-filing",
  "routing-flag-consumer-files-on-self-implicit": "implicit self-filing (no --repo)",
  "routing-flag-consumer-files-on-self-short-flag": "flag-form parity (-R, case, .git)",
  "routing-flag-consumer-files-off-lane": "off-lane verdict",
  "routing-flag-chained-after-another-command": "shell-segment reach",
  "routing-clean-files-on-declared-upstream": "sanctioned Route-A upstream (clean pole)",
  "routing-clean-upstream-equals-form": "--repo= form parity",
  "routing-clean-non-consumer-class": "class gate (reject pole)",
  "routing-clean-off-lane-withheld-no-upstream": "off-lane withheld without an authority",
  "routing-skip-command-in-heredoc": "command-vs-data (heredoc body)",
  "routing-skip-command-in-quoted-string": "command-vs-data (quoted argument)",
  "routing-skip-help-read": "read-vs-write (--help)",
  "routing-clean-not-an-issue-create": "subcommand scope",
  "routing-clean-empty-command": "fail-open on an absent command",
};

function parseFixture(text) {
  const lines = text.split("\n");
  const ctx = { repoClass: null, selfRepo: null, upstreamRepo: null };
  const expect = [];
  const body = [];
  for (const line of lines) {
    const m = /^#\s*(repoClass|selfRepo|upstreamRepo|expect)\s*:\s*(.*)$/.exec(line);
    if (m) {
      const [, key, raw] = m;
      const v = raw.trim();
      if (key === "expect") {
        if (v) expect.push(...v.split(/[,\s]+/).filter(Boolean));
      } else if (key === "repoClass") {
        ctx.repoClass = v || null;
      } else {
        ctx[key] = v ? lib.parseRepoRef(v) : null;
      }
      continue;
    }
    if (/^#/.test(line)) continue; // narrative comment
    body.push(line);
  }
  return { ctx, expect, command: body.join("\n").trim() };
}

const cases = readdirSync(HERE)
  .filter((f) => f.startsWith("routing-") && f.endsWith(".txt"))
  .sort();

if (cases.length === 0) {
  console.error("FAIL harness/no-cases: the runner found zero `routing-*.txt` fixtures.");
  process.exit(1);
}

const red = [];
for (const file of cases) {
  const name = file.replace(/\.txt$/, "");
  const { ctx, expect, command } = parseFixture(readFileSync(path.join(HERE, file), "utf8"));
  let got;
  try {
    got = lib.inspectIssueFiling({ command, ...ctx }).map((f) => f.rule_id);
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
