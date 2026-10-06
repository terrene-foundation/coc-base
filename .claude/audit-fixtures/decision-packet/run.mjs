#!/usr/bin/env node
/**
 * run.mjs — audit-fixture runner for `.claude/hooks/lib/decision-packet.js`, the
 * detector for `recommendation-quality.md` MUST-6 § "'The Human Decides' Means
 * Ratify A Recommendation — Not Fill A Blank". Ships WITH the detector per
 * `cc-artifacts.md` Rule 9.
 *
 * WHAT THESE FIXTURES DO AND DO NOT SHOW. They prove the PREDICATES decide
 * correctly. They do NOT show the guard RUNS: whether
 * `.claude/hooks/decision-packet-guard.js` receives a PostToolUse(Write) event
 * depends on its registration in `.claude/settings.json`, which is a different
 * file and a different question. A green run here is evidence about LOGIC, never
 * about enforcement.
 *
 * WHY `.expected` SIDECARS AND NOT THE SIBLING RUNNER'S IN-FILE `# expect:` HEADER.
 * `.claude/audit-fixtures/issue-triage-routing/run.mjs` — the runner this one is
 * modelled on — parses `# repoClass:` / `# expect:` lines out of the top of each
 * fixture, which works there because the fixture body is a SHELL COMMAND and `#`
 * is a comment. The body here is MARKDOWN, which has no comment syntax: a
 * `# expect: ...` line would be an H1 heading, i.e. part of the packet under test,
 * and the fixture would no longer be the artifact it claims to model. So the
 * expectation lives in a sidecar and the `.txt` body stays byte-pure. Everything
 * else — the `flag-` / `clean-` / `skip-` poles, the FAMILY map, the named RED SET
 * on failure — is the sibling's convention unchanged.
 *
 * BIPOLAR BY CONSTRUCTION (`instrument-bipolarity.md` MUST-2). Every predicate
 * family carries BOTH an accept pole and a reject pole:
 *
 *   1  table answer column, EMPTY    flag: table-blank-answer-column
 *                                    clean: table-recommendations-filled
 *   2  table answer column, PUNT     flag: table-punt-in-costume  (NAIVE MISS)
 *                                    clean: punt-token-in-con-column
 *   3  blank-FILL is a blank         flag: table-answer-is-blank-fill-rule (NAIVE MISS)
 *                                    clean: ratify-column-left-blank-for-human
 *                                           (the NAIVE FALSE POSITIVE)
 *   4  ABSENT cell ≠ EMPTY cell      flag: table-row-ragged-absent-cell — expects
 *                                          `packet-row-indeterminate` and expects
 *                                          `packet-answer-empty` to be ABSENT
 *                                    clean: data-table-inside-packet-file (ABSENT
 *                                           COLUMN ⇒ not a packet table at all)
 *   5  bulleted packet form          flag: bullet-recommendation-empty
 *                                    clean: bullet-recommendation-wraps-lines
 *   6  bullet ratify slot            clean: bullet-ratify-slot-blank-fill
 *   7  bare prose ANSWER marker      flag: bare-answer-marker-blank
 *                                    clean: bare-answer-marker-answered
 *   8  whole-file scope gate         clean: not-a-packet-no-markers
 *   9  content-vs-documentation      skip: blank-menu-inside-fence,
 *                                          answer-marker-in-inline-code
 *  10  fail-open                     skip: non-markdown-path, empty-content
 *
 * A set that only ever asserts FIRING passes identically against a detector that
 * fires on everything; a set that only ever asserts SILENCE passes identically
 * against an INERT detector. Both risks are live here — the guard is capped at
 * `halt-and-report`, and an inert advisory is indistinguishable from a clean
 * session — and the corpus this detector runs against is overwhelmingly silent
 * (MEASURED: 0 findings over 4,852 tracked `.md` files), so these fixtures are the
 * ONLY place its firing is demonstrated at all.
 *
 * THE TWO ADVERSARIAL POLES ARE THE POINT. `table-punt-in-costume` and
 * `table-answer-is-blank-fill-rule` are both MISSED by the obvious implementation
 * (`cell.trim() === ""`), because every cell in them is a non-empty string.
 * `ratify-column-left-blank-for-human` and `bullet-ratify-slot-blank-fill` are
 * both FLAGGED by it, because a compliant packet is FULL of deliberate blanks —
 * the human's signature slots. A naive check is wrong in both directions, and
 * dropping either pair would leave that invisible.
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
const lib = require_(path.join(REPO, ".claude", "hooks", "lib", "decision-packet.js"));

/** Which predicate family each case exercises — printed on failure. */
const FAMILY = {
  "packet-flag-table-blank-answer-column": "table answer column — EMPTY",
  "packet-clean-table-recommendations-filled": "table answer column — FILLED (reject pole)",
  "packet-flag-table-punt-in-costume": "table answer column — PUNT (naive MISS)",
  "packet-clean-punt-token-in-con-column": "punt token outside the answer column (reject pole)",
  "packet-flag-table-answer-is-blank-fill-rule": "blank-FILL idiom is a blank (naive MISS)",
  "packet-clean-ratify-column-left-blank-for-human": "ratify slot blank by design (naive FALSE POSITIVE)",
  "packet-flag-table-row-ragged-absent-cell": "ABSENT cell ≠ EMPTY cell (state distinction)",
  "packet-clean-data-table-inside-packet-file": "ABSENT column ⇒ not a packet table",
  "packet-flag-bullet-recommendation-empty": "bulleted packet — EMPTY",
  "packet-clean-bullet-recommendation-wraps-lines": "bulleted packet — FILLED across a wrap",
  "packet-clean-bullet-ratify-slot-blank-fill": "bullet ratify slot blank by design (naive FALSE POSITIVE)",
  "packet-flag-bare-answer-marker-blank": "bare prose ANSWER marker — EMPTY",
  "packet-flag-bare-answer-marker-punt": "bare prose ANSWER marker — PUNT (found by mutation)",
  "packet-clean-bare-answer-marker-answered": "bare prose ANSWER marker — FILLED",
  "packet-clean-not-a-packet-no-markers": "whole-file scope gate (reject pole)",
  "packet-skip-blank-menu-inside-fence": "content-vs-documentation (fenced example)",
  "packet-skip-answer-marker-in-inline-code": "content-vs-documentation (inline-code citation)",
  "packet-skip-non-markdown-path": "fail-open on a non-markdown path",
  "packet-skip-empty-content": "fail-open on absent content",
};

/**
 * Parse a `.expected` sidecar. `path:` is the file path handed to the predicate;
 * `expect:` is a whitespace/comma list of rule_ids, EMPTY meaning "(silent)".
 * Continuation lines under `note:` are narrative and are not read.
 */
function parseExpected(text) {
  const out = { path: null, expect: [] };
  for (const line of text.split("\n")) {
    const m = /^(path|expect)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    const v = raw.trim();
    if (key === "path") out.path = v || null;
    else if (v) out.expect.push(...v.split(/[,\s]+/).filter(Boolean));
  }
  return out;
}

const cases = readdirSync(HERE)
  .filter((f) => f.startsWith("packet-") && f.endsWith(".txt"))
  .sort();

if (cases.length === 0) {
  console.error("FAIL harness/no-cases: the runner found zero `packet-*.txt` fixtures.");
  process.exit(1);
}

const red = [];
for (const file of cases) {
  const name = file.replace(/\.txt$/, "");
  const family = FAMILY[name] || "(unclassified)";
  let sidecar;
  try {
    sidecar = parseExpected(readFileSync(path.join(HERE, `${name}.expected`), "utf8"));
  } catch {
    red.push({ name, family, expect: ["<sidecar>"], got: ["MISSING .expected sidecar"] });
    console.log(`FAIL ${name} [${family}] — no ${name}.expected sidecar`);
    continue;
  }
  if (!sidecar.path) {
    // The path is an INPUT to the predicate (the extension gate reads it), so a
    // sidecar without one cannot drive the case. Refuse rather than default.
    red.push({ name, family, expect: sidecar.expect, got: ["sidecar declares no `path:`"] });
    console.log(`FAIL ${name} [${family}] — sidecar declares no \`path:\``);
    continue;
  }
  const content = readFileSync(path.join(HERE, file), "utf8");
  let got;
  try {
    got = lib.inspectPacketWrite({ path: sidecar.path, content }).map((f) => f.rule_id);
  } catch (err) {
    red.push({ name, family, expect: sidecar.expect, got: [`THREW: ${err.message}`] });
    console.log(`FAIL ${name} [${family}] — predicate THREW: ${err.message}`);
    continue;
  }
  const e = [...sidecar.expect].sort().join(",");
  const g = [...got].sort().join(",");
  if (e === g) {
    console.log(`PASS ${name} [${family}] — ${g || "(silent)"}`);
  } else {
    red.push({ name, family, expect: sidecar.expect, got });
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
