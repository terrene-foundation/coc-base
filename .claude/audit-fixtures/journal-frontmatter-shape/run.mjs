#!/usr/bin/env node
/**
 * run.mjs — audit-fixture runner for `.claude/hooks/lib/journal-frontmatter-shape.js`,
 * the frontmatter-SHAPE detector for `rules/journal.md` § Naming & Format. Ships
 * WITH the detector per `cc-artifacts.md` Rule 9, and is half of what graduates
 * `phase2-deferrals.json::journal.md#frontmatter-shape-advisory` (the other half
 * being the detector itself, wired into `hooks/journal-write-guard.js`).
 *
 * WHAT THESE FIXTURES SHOW AND DO NOT SHOW. They prove the PREDICATES decide
 * correctly. They do NOT show the guard runs: that is a separate fact, and it is
 * a true one here — `journal-write-guard.js` IS registered in `.claude/settings.json`
 * under `PreToolUse` matcher `Edit|Write|NotebookEdit`, MEASURED, with the same
 * grep fired first at a known-registered control (`integration-hygiene`) so the
 * hit is readable. Registration is established by that measurement, never by this
 * green run. The guard's own end-to-end dispositions are driven by
 * `../journal-write-guard/run.mjs`, not here.
 *
 * SCOPE. This runner drives ONLY the `flag-*.txt` / `clean-*.txt` pairs in this
 * directory, each with a `.expected` answer-key sidecar. The answer key is a
 * SEPARATE FILE from the input on purpose: a fixture that carries its own
 * expectation inline can be silently edited into agreement with whatever the code
 * currently does.
 *
 * BIPOLAR BY CONSTRUCTION (`instrument-bipolarity.md` MUST-2). Every predicate
 * carries BOTH a firing pole and a silence pole:
 *
 *   absent            flag-no-frontmatter          / clean-canonical
 *   shape-unverifiable flag-unterminated-fence     / clean-canonical
 *   missing-required  flag-missing-required-keys   / clean-canonical
 *   empty-value       flag-empty-required-value    / clean-continuation-value
 *   retired-key       flag-retired-keys            / clean-canonical (relates_to present)
 *   enum              flag-unknown-enum-values     / clean-all-enum-values
 *   date form         flag-malformed-date          / clean-canonical
 *   fence anchoring   flag-keys-only-in-body       / clean-body-noise-frontmatter-correct
 *   reservation gate  flag-enrolled-missing-…      / clean-unenrolled-missing-… (SAME BYTES)
 *   input presence    (none)                       / clean-no-input
 *   lexical tolerance (none)                       / clean-quoted-keys-crlf
 *
 * A set that only ever asserts FIRING passes identically against a detector that
 * fires on everything; a set that only ever asserts SILENCE passes identically
 * against an INERT one. Both risks are live here, because every finding this
 * detector produces is `advisory` — and an inert advisory is indistinguishable
 * from a clean session.
 *
 * THE THREE CASES THAT EARN THEIR KEEP, each naming the naive check it defeats:
 *
 *   clean-continuation-value       defeats `/^tags:\s*$/m`. MEASURED on this
 *                                  repo's corpus: that regex matched 22 of the
 *                                  last 40 journal entries and the
 *                                  continuation-aware parse matched 0. All 22
 *                                  were false positives — the tag list was on
 *                                  the indented lines beneath.
 *   flag-keys-only-in-body         defeats `content.includes("project:")`. Every
 *                                  token such a check looks for IS in the file;
 *                                  all three are in the BODY, none in the fence.
 *   clean-body-noise-frontmatter-correct
 *                                  the same check's other pole — a correct entry
 *                                  that DISCUSSES frontmatter keys in its body.
 *                                  MEASURED against a mutant with the fence
 *                                  anchoring removed (`block: content`): a
 *                                  whole-document scan reports SEVEN findings on
 *                                  this clean entry, and the spoof pole above
 *                                  goes silent. Both poles move, which is what
 *                                  makes the pair worth its bytes.
 *
 *   node .claude/audit-fixtures/journal-frontmatter-shape/run.mjs
 *   LIB=/abs/path/to/mutant.js node .../run.mjs     # red it against a mutant
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const require_ = createRequire(import.meta.url);
const LIB =
  process.env.LIB ||
  path.join(REPO, ".claude", "hooks", "lib", "journal-frontmatter-shape.js");
const lib = require_(LIB);

/** Which predicate family each case exercises — printed on every line. */
const FAMILY = {
  "flag-no-frontmatter": "absent (firing)",
  "flag-unterminated-fence": "shape-unverifiable (firing)",
  "flag-missing-required-keys": "missing-required-key (firing)",
  "flag-empty-required-value": "empty-required-value (firing)",
  "flag-retired-keys": "retired-key (firing)",
  "flag-unknown-enum-values": "enum membership (firing)",
  "flag-malformed-date": "date form (firing)",
  "flag-keys-only-in-body": "fence anchoring (firing) — defeats includes()",
  "flag-enrolled-missing-reservation-keys": "reservation gate ON (firing)",
  "clean-canonical": "the contract itself (silence)",
  "clean-continuation-value": "empty-value (silence) — defeats /^tags:$/m",
  "clean-all-enum-values": "enum membership (silence)",
  "clean-body-noise-frontmatter-correct":
    "fence anchoring (silence) — adversarial body",
  "clean-unenrolled-missing-reservation-keys":
    "reservation gate OFF (silence) — SAME BYTES as its flag pole",
  "clean-quoted-keys-crlf": "lexical tolerance (silence)",
  "clean-no-input": "input presence (silence) — no content key at all",
};

/**
 * Parse an answer key. `# key: value` lines are OPTIONS; everything else is an
 * expected finding identity (`<code> [<key>]`). An empty key means "expect
 * silence", which is a real expectation and not an absent one.
 */
function parseExpected(text) {
  const opts = { reservationKeysRequired: true, transform: null, input: null };
  const expect = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    const m = /^#\s*(reservationKeysRequired|transform|input)\s*:\s*(.*)$/.exec(t);
    if (m) {
      const [, k, raw] = m;
      const v = raw.trim();
      if (k === "reservationKeysRequired") opts.reservationKeysRequired = v !== "false";
      else opts[k] = v;
      continue;
    }
    if (t.startsWith("#")) continue; // narrative comment
    expect.push(t);
  }
  return { opts, expect };
}

/** Finding → the stable identity the answer key is written in. */
const identify = (f) => `${f.code}${f.key ? ` [${f.key}]` : ""}`;

const cases = readdirSync(HERE)
  .filter((f) => /^(flag|clean)-.*\.txt$/.test(f))
  .map((f) => f.replace(/\.txt$/, ""))
  .sort();

if (cases.length === 0) {
  console.error(
    "FAIL harness/no-cases: the runner found zero `flag-*.txt` / `clean-*.txt` fixtures.",
  );
  process.exit(1);
}

// ANTI-VACUITY FLOOR. A set with no firing pole, or no silence pole, passes
// against a detector that is respectively universal or inert — so the harness
// refuses to report a green it could not have failed.
const flags = cases.filter((c) => c.startsWith("flag-"));
const cleans = cases.filter((c) => c.startsWith("clean-"));
if (flags.length === 0 || cleans.length === 0) {
  console.error(
    `FAIL harness/not-bipolar: ${flags.length} firing pole(s) and ${cleans.length} silence pole(s); ` +
      "a set missing either pole cannot distinguish a working detector from a broken one.",
  );
  process.exit(1);
}

const red = [];
for (const name of cases) {
  const raw = readFileSync(path.join(HERE, `${name}.txt`), "utf8");
  let expectedText;
  try {
    expectedText = readFileSync(path.join(HERE, `${name}.expected`), "utf8");
  } catch {
    red.push({ name, family: FAMILY[name] || "?", expect: ["<no .expected sidecar>"], got: [] });
    console.log(`FAIL ${name} [${FAMILY[name] || "?"}] — no .expected answer key beside it`);
    continue;
  }
  const { opts, expect } = parseExpected(expectedText);

  let content = raw;
  if (opts.transform === "crlf") content = raw.replace(/\n/g, "\r\n");
  if (opts.input === "absent") content = undefined;

  let got;
  try {
    got = lib
      .inspectFrontmatterShape(content, {
        reservationKeysRequired: opts.reservationKeysRequired,
      })
      .map(identify);
  } catch (err) {
    red.push({ name, family: FAMILY[name] || "?", expect, got: [`THREW: ${err.message}`] });
    console.log(`FAIL ${name} [${FAMILY[name] || "?"}] — predicate THREW: ${err.message}`);
    continue;
  }

  // Compared as SETS: the lib documents a stable order, but an answer key that
  // depended on it would red on a harmless reordering and teach the next author
  // to edit the key rather than read the finding.
  const e = [...expect].sort().join(",");
  const g = [...got].sort().join(",");
  if (e === g) {
    console.log(`PASS ${name} [${FAMILY[name] || "?"}] — ${g || "(silent)"}`);
  } else {
    red.push({ name, family: FAMILY[name] || "?", expect, got });
    console.log(
      `FAIL ${name} [${FAMILY[name] || "?"}] — expected [${e || "(silent)"}] got [${g || "(silent)"}]`,
    );
  }
}

console.log(
  `\n${cases.length - red.length}/${cases.length} cases pass ` +
    `(${flags.length} firing poles, ${cleans.length} silence poles).`,
);
if (red.length > 0) {
  console.log(
    "\nRED SET — each line names the case, its predicate family, and the identity mismatch:",
  );
  for (const r of red) {
    console.log(
      `  ${r.name} :: ${r.family} :: expected [${r.expect.join(",") || "(silent)"}] ` +
        `:: observed [${r.got.join(",") || "(silent)"}]`,
    );
  }
  process.exit(1);
}
process.exit(0);
