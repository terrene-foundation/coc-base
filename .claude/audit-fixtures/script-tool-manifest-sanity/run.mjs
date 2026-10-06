#!/usr/bin/env node
/**
 * run.mjs — audit-fixture runner for `.claude/bin/lib/script-tool-parity.mjs`,
 * the Phase-2 detector for `script-tool-manifest-sanity.md` MUST-1. Ships WITH
 * the detector per `cc-artifacts.md` Rule 9.
 *
 * SCOPE OF THIS FILE. It drives ONLY the `parity-*.json` fixtures in this
 * directory. The directory ALSO holds LLM-judge probe candidates (`flag-*`,
 * `clean-*`, `meta-*` with `.expected` sidecars) belonging to the SEMANTIC tier;
 * this runner does not read them and must not be made to. The two tiers are kept
 * apart by prefix, the same separation `issue-triage-routing/` uses for its
 * `routing-*` set.
 *
 * ANSWER KEYS ARE SEPARATED. Each `parity-X.json` carries the INPUT manifest and
 * nothing else; its verdict lives in the sibling `parity-X.expected`. A fixture
 * that carried its own expectation inline could be edited into agreement with a
 * broken detector in one hunk, and the diff would look like a fixture update.
 *
 * WHAT THESE FIXTURES SHOW AND DO NOT SHOW. They prove the PREDICATES decide
 * correctly. They do NOT prove the checker RUNS anywhere: `.claude/bin/**` is
 * `loom_only` (MEASURED — `buildLaneClassifier` returns `skip/no_tier_match` on
 * all seven lanes for `.claude/bin/check-script-tool-parity.mjs`, while the
 * control `.claude/bin/burndown-build.mjs` returns `copy/always_include` on all
 * seven, so that zero is a readable true negative and not a blanket skip). A
 * green run here is evidence about logic, never about enforcement at a consumer.
 *
 * BIPOLAR BY CONSTRUCTION (`instrument-bipolarity.md` MUST-2). Every predicate
 * carries BOTH a firing pole and a silent pole:
 *
 *   1  the originating incident   flag: lint-tool-undeclared
 *                                 clean: lint-tool-declared
 *   2  flag VALUES are not tools  clean: flag-value-looks-like-a-tool
 *                                 (its firing pole IS case 1 — the same command
 *                                  line minus the declaration)
 *   3  sibling-script delegation  flag: npm-run-dangling
 *                                 clean: npm-run-sibling
 *   4  shell / runtime ambient    clean: coreutils-and-runtime
 *   5  npx unwrapping             flag: npx-tool-undeclared
 *                                 clean: npx-tool-declared
 *   6  scope-stripping            flag: scoped-bin-not-declared
 *                                 clean: scoped-bin-unscoped-name
 *   7  the bin-alias table        flag: tsc-without-typescript
 *                                 clean: tsc-satisfied-by-typescript
 *   8  dev vs runtime section     flag: tool-in-runtime-deps-only (advisory)
 *   9  wrapper payloads           flag: cross-env-payload-undeclared
 *                                 clean: env-prefix-and-cross-env
 *  10  quoting is data            clean: operator-inside-quotes
 *                                 flag: chained-second-segment
 *  11  path-qualified vs .bin     clean: path-qualified-local-script
 *                                 flag: node-modules-bin-undeclared
 *  12  LOUD blind spots           notice: bare-yarn-delegation,
 *                                         cross-workspace-script,
 *                                         unsupported-toml-manifest
 *
 * A set that only ever asserts FIRING passes identically against a detector that
 * fires on everything; a set that only ever asserts SILENCE passes identically
 * against an INERT one. Both are live risks here — the whole instrument is
 * capped at `halt-and-report`, and an advisory that never fires is
 * indistinguishable from a clean tree.
 *
 * FAILURE OUTPUT NAMES AN IDENTITY, never merely a non-zero exit.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const lib = await import(
  path.join(REPO, ".claude", "bin", "lib", "script-tool-parity.mjs")
);

/** Which predicate family each case exercises — printed on every line. */
const FAMILY = {
  "parity-flag-lint-tool-undeclared": "originating incident (undeclared linter)",
  "parity-clean-lint-tool-declared": "originating incident (declared pole)",
  "parity-clean-flag-value-looks-like-a-tool": "flag VALUES are not tools",
  "parity-flag-npm-run-dangling": "sibling-script delegation (dangling)",
  "parity-clean-npm-run-sibling": "sibling-script delegation (resolves)",
  "parity-clean-coreutils-and-runtime": "shell / runtime ambient",
  "parity-flag-npx-tool-undeclared": "npx unwrapping (fires)",
  "parity-clean-npx-tool-declared": "npx unwrapping (silent)",
  "parity-flag-scoped-bin-not-declared": "scope-stripping (reject pole)",
  "parity-clean-scoped-bin-unscoped-name": "scope-stripping (accept pole)",
  "parity-flag-tsc-without-typescript": "bin-alias table (reject pole)",
  "parity-clean-tsc-satisfied-by-typescript": "bin-alias table (accept pole)",
  "parity-flag-tool-in-runtime-deps-only": "dev vs runtime section (advisory)",
  "parity-flag-cross-env-payload-undeclared": "wrapper payload reached",
  "parity-clean-env-prefix-and-cross-env": "env assignments + wrapper (silent)",
  "parity-clean-operator-inside-quotes": "quoting is data",
  "parity-flag-chained-second-segment": "segment 2 is reached",
  "parity-clean-path-qualified-local-script": "path-qualified is not a package",
  "parity-flag-node-modules-bin-undeclared": "node_modules/.bin IS a package claim",
  "parity-notice-bare-yarn-delegation": "LOUD blind spot (delegated subcommand)",
  "parity-notice-cross-workspace-script": "LOUD blind spot (other manifest)",
  "parity-notice-unsupported-toml-manifest": "LOUD blind spot (TOML family)",
};

/**
 * The answer-key grammar. One token per line; `#` lines are narrative.
 *
 *   finding:<short-id>:<tool>   a finding, by its FINDING_IDS short name
 *   notice:<reason>             a named blind spot
 *   (silent)                    explicit empty — never an omitted file
 */
const SHORT = {
  undeclared: lib.FINDING_IDS.undeclared,
  "outside-dev": lib.FINDING_IDS.outsideDev,
  "dangling-script": lib.FINDING_IDS.danglingScript,
  unsupported: lib.FINDING_IDS.unsupported,
};

function parseExpected(text, file) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (t === "(silent)") continue;
    const [kind, a, b] = t.split(":");
    if (kind === "finding") {
      if (!SHORT[a]) throw new Error(`${file}: unknown finding short-id \`${a}\``);
      out.push(`finding:${SHORT[a]}:${b}`);
    } else if (kind === "notice") {
      out.push(`notice:${a}`);
    } else {
      throw new Error(`${file}: unparseable expectation line \`${t}\``);
    }
  }
  return out.sort();
}

function observed(result) {
  return [
    ...result.findings.map((f) => `finding:${f.rule_id}:${f.tool}`),
    ...result.notices.map((n) => `notice:${n.reason}`),
  ].sort();
}

const cases = readdirSync(HERE)
  .filter((f) => f.startsWith("parity-") && f.endsWith(".json"))
  .sort();

if (cases.length === 0) {
  console.error("FAIL harness/no-cases: the runner found zero `parity-*.json` fixtures.");
  process.exit(1);
}

const red = [];
for (const file of cases) {
  const name = file.replace(/\.json$/, "");
  const family = FAMILY[name] || "(unclassified)";
  let expect;
  try {
    expect = parseExpected(readFileSync(path.join(HERE, `${name}.expected`), "utf8"), name);
  } catch (err) {
    red.push({ name, family, expect: ["<no answer key>"], got: [`KEY ERROR: ${err.message}`] });
    console.log(`FAIL ${name} [${family}] — answer key: ${err.message}`);
    continue;
  }
  const input = JSON.parse(readFileSync(path.join(HERE, file), "utf8"));
  // `_kind` lets a fixture drive the TOML arm, whose whole point is that it is
  // NOT parsed — so the fixture declares the family rather than the extension.
  const kind = input._kind || "package.json";
  delete input._kind;
  let got;
  try {
    got = observed(lib.analyzeManifest({ kind, path: `<fixture:${name}>`, parsed: input }));
  } catch (err) {
    red.push({ name, family, expect, got: [`THREW: ${err.message}`] });
    console.log(`FAIL ${name} [${family}] — predicate THREW: ${err.message}`);
    continue;
  }
  const e = expect.join(",");
  const g = got.join(",");
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
