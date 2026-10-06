#!/usr/bin/env node
/**
 * parity-run.mjs — the STRUCTURAL fixture runner for the `command-skill-parity`
 * Phase-2 detector (`.claude/hooks/lib/command-skill-parity.js`).
 *
 * SCOPE — this directory holds TWO tiers and they do not mix. The pre-existing
 * `flag-*.txt` / `clean-*.txt` / `meta-*.txt` files with `.expected` sidecars are
 * LLM-JUDGE PROBE CANDIDATES for the semantic tier and are NOT touched, read, or
 * driven by this runner. Everything this runner owns is prefixed `parity-`.
 *
 * NEEDS NO LIVE REPO. Every fixture carries its own synthetic on-disk inventory
 * (`existsSet`), its own synthetic manifest membership (`manifestSet`), and its
 * own synthetic session-edit set — so the runner drives the REAL predicates
 * against a world it fully declares, and cannot be made to pass or fail by the
 * state of the checkout it happens to run in.
 *
 * BIPOLAR ON EVERY PREDICATE (`instrument-bipolarity.md` MUST-2). A set that only
 * asserts firing passes identically against a detector that fires on everything;
 * a set that only asserts silence passes identically against an INERT one, and
 * an inert advisory is indistinguishable from a clean session. Each scope
 * restriction therefore carries BOTH poles, and the RED SET below names the
 * failing case, its predicate family, and the expected-vs-observed IDENTITIES —
 * never merely a non-zero exit.
 *
 * The load-bearing pair: `parity-flag-flag-added-no-skill-edit` and
 * `parity-clean-step-changed-with-skill-edit` are IDENTICAL in every field
 * except `sessionEditedSkills`, which is the property under test.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const lib = require(
  join(HERE, "..", "..", "hooks", "lib", "command-skill-parity.js"),
);

/** Which predicate family a case exercises — printed in the RED SET. */
function familyOf(name) {
  if (name.startsWith("parity-skip-")) return "scope (isCommandPath)";
  if (name.startsWith("parity-failopen-")) return "fail-open (unknown input)";
  if (name.includes("skill-reference")) return "ARM 2 (dangling/unregistered)";
  if (name.includes("slash-prefixed")) return "ARM 2 anchor (extractSkillReferences)";
  if (name.includes("no-paired-skill")) return "ARM 1 withdraw (no pair)";
  if (name.includes("write-withholds")) return "ARM 1 withhold (no prior text)";
  return "ARM 1 (declaredSurfaceChange + co-change)";
}

const files = readdirSync(HERE)
  .filter((f) => f.startsWith("parity-") && f.endsWith(".txt"))
  .sort();

if (files.length === 0) {
  console.error("FAIL: no parity-*.txt fixtures found in " + HERE);
  process.exit(1);
}

const red = [];
let pass = 0;

for (const file of files) {
  const name = file.replace(/\.txt$/, "");
  let spec;
  try {
    spec = JSON.parse(readFileSync(join(HERE, file), "utf8"));
  } catch (e) {
    red.push({ name, family: "fixture", expected: "parseable JSON", observed: String(e && e.message) });
    continue;
  }

  const existsSet = spec.existsSet;
  const manifestSet = spec.manifestSet;

  const skillExists =
    existsSet === "__THROW__"
      ? () => {
          throw new Error("synthetic existsSync failure");
        }
      : Array.isArray(existsSet)
        ? (n) => existsSet.includes(n)
        : undefined;
  const skillInManifest = Array.isArray(manifestSet)
    ? (n) => manifestSet.includes(n)
    : undefined;

  const ctx =
    spec.ctx && typeof spec.ctx === "object"
      ? { ...spec.ctx, skillExists, skillInManifest }
      : spec.ctx;

  let observed;
  try {
    observed = lib.inspectCommandWrite(ctx).map((f) => f.rule_id).sort();
  } catch (e) {
    red.push({ name, family: familyOf(name), expected: JSON.stringify(spec.expect || []), observed: "THREW: " + String(e && e.message) });
    continue;
  }
  const expected = [...(spec.expect || [])].sort();

  const ok =
    observed.length === expected.length &&
    observed.every((v, i) => v === expected[i]);
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}  [${familyOf(name)}]  ${expected.length ? expected.join(",") : "(silent)"}`);
  } else {
    red.push({
      name,
      family: familyOf(name),
      expected: expected.length ? expected.join(",") : "(silent)",
      observed: observed.length ? observed.join(",") : "(silent)",
    });
    console.log(`FAIL  ${name}  [${familyOf(name)}]`);
  }
}

console.log("");
console.log(`cases=${files.length} pass=${pass} fail=${red.length}`);

if (red.length > 0) {
  console.log("");
  console.log("RED SET — each row names the case, the predicate family, and the");
  console.log("expected-vs-observed finding IDENTITIES:");
  for (const r of red) {
    console.log(
      `  RED  ${r.name}\n       family:   ${r.family}\n       expected: ${r.expected}\n       observed: ${r.observed}`,
    );
  }
  process.exit(1);
}

console.log("ALL GREEN — both poles asserted on every predicate family.");
