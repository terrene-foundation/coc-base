#!/usr/bin/env node
/**
 * surface-run.mjs — audit-fixture runner for `.claude/hooks/lib/handoff-surface.js`,
 * the Phase-2 detector for `handoff-completion.md` § MUST-1 / § MUST NOT bullet 1
 * (a handoff claim with no adjacent executed-or-pending surface). Ships WITH the
 * detector per `cc-artifacts.md` Rule 9.
 *
 * SCOPE OF THIS FILE. It drives ONLY the `surface-*.txt` fixtures in this
 * directory. The directory ALSO holds LLM-judge probe candidates (`flag-*`,
 * `clean-*`, `meta-*` with `.expected` sidecars) belonging to a DIFFERENT tier;
 * this runner does not read them and must not be made to.
 *
 * BIPOLAR BY CONSTRUCTION (`instrument-bipolarity.md` MUST-2). Every
 * scope-restriction predicate carries BOTH an accept pole and a reject pole:
 *
 *   1  the CLAIM matcher     flag: flag-handoff-prepared-bare
 *                            clean: clean-no-handoff-language
 *   2  EXECUTED arm, URL     flag: flag-handoff-prepared-bare
 *                            clean: clean-handoff-with-pr-url  (BYTE-IDENTICAL
 *                                   to the flag pole but for the filed URL)
 *   3  EXECUTED arm, number  flag: flag-mirror-tracked-no-ref
 *                            clean: clean-handoff-with-issue-number
 *                                   (BYTE-IDENTICAL but for `rs#1732`)
 *   4  PENDING arm, authz    flag: flag-pending-missing-authorization
 *                            clean: clean-pending-action-target-and-authz
 *                                   (identical target + action; the ONLY
 *                                   difference is the authorization element,
 *                                   so the pair isolates ONE of the rule's
 *                                   three named conjuncts)
 *   5  the ADJACENCY WINDOW  flag: flag-surface-in-a-different-sentence
 *                                   (a filed URL **and** a qualified issue
 *                                   number are both present in the reply — just
 *                                   not in the claim's sentence. A whole-reply
 *                                   search scores this CLEAN, which is exactly
 *                                   the check-that-cannot-fail this fixture
 *                                   exists to red)
 *                            clean: clean-handoff-with-pr-url (same surface, in
 *                                   the window)
 *   6  WITHDRAWAL, fence     skip: skip-phrase-in-code-fence
 *   7  WITHDRAWAL, quote     skip: skip-phrase-in-block-quote
 *   8  FAIL-OPEN arm         clean: clean-empty-reply
 *
 * A set that only ever asserts FIRING passes identically against a detector that
 * fires on everything; a set that only ever asserts SILENCE passes identically
 * against an INERT detector. Both are live risks here because the guard is
 * capped at `advisory`, and an inert advisory is indistinguishable from a clean
 * session — nothing downstream would ever notice.
 *
 * FAILURE OUTPUT NAMES AN IDENTITY, never merely a non-zero exit: each mismatch
 * prints the case, the predicate family it exercises, the expected finding
 * identities and the observed ones, and the run ends with a RED SET listing
 * every failing case.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const require_ = createRequire(import.meta.url);
const lib = require_(path.join(REPO, ".claude", "hooks", "lib", "handoff-surface.js"));

/** Which predicate family each case exercises — printed on failure. */
const FAMILY = {
  "surface-flag-handoff-prepared-bare": "claim matcher + EXECUTED arm (reject pole)",
  "surface-flag-mirror-tracked-no-ref": "mirror-tracked claim, no qualified ref",
  "surface-flag-pending-missing-authorization": "PENDING arm — authorization conjunct missing",
  "surface-flag-surface-in-a-different-sentence": "ADJACENCY WINDOW (the load-bearing half)",
  "surface-clean-handoff-with-pr-url": "EXECUTED arm — filed issue/PR URL (accept pole)",
  "surface-clean-handoff-with-issue-number": "EXECUTED arm — qualified issue number (accept pole)",
  "surface-clean-pending-action-target-and-authz": "PENDING arm — target + action + authorization",
  "surface-clean-no-handoff-language": "claim matcher (reject pole — no handoff vocabulary)",
  "surface-clean-empty-reply": "fail-open on an empty reply",
  "surface-skip-phrase-in-code-fence": "WITHDRAWAL — fenced code block",
  "surface-skip-phrase-in-block-quote": "WITHDRAWAL — block quote",
};

function parseFixture(text) {
  const expect = [];
  const body = [];
  for (const line of text.split("\n")) {
    const m = /^#\s*expect\s*:\s*(.*)$/.exec(line);
    if (m) {
      const v = m[1].trim();
      if (v) expect.push(...v.split(/[,\s]+/).filter(Boolean));
      continue;
    }
    body.push(line);
  }
  return { expect, reply: body.join("\n") };
}

const cases = readdirSync(HERE)
  .filter((f) => f.startsWith("surface-") && f.endsWith(".txt"))
  .sort();

if (cases.length === 0) {
  console.error("FAIL harness/no-cases: the runner found zero `surface-*.txt` fixtures.");
  process.exit(1);
}

const red = [];
for (const file of cases) {
  const name = file.replace(/\.txt$/, "");
  const { expect, reply } = parseFixture(readFileSync(path.join(HERE, file), "utf8"));
  let got;
  try {
    got = lib.inspectHandoffClaims(reply).map((f) => f.rule_id);
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
