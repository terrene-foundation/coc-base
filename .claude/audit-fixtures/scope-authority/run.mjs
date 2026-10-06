#!/usr/bin/env node
// Audit fixture runner for `.claude/bin/check-scope-authority.mjs` — the detector for
// a SCOPE GATE that decides a file class by a naming convention a newer convention
// outgrew, whose silence is indistinguishable from a true negative.
//
// BIPOLAR BY CONSTRUCTION (`rules/instrument-bipolarity.md` MUST-1/MUST-2).
// `poles/red-pole.mjs` and `poles/green-pole.mjs` are the same synthetic scrub-surface
// instrument, equal to within 5 bytes (651 / 656), and CODE-identical after comments
// are stripped except for ONE directory arm:
//
//     RED    /(^|\/)test-harness\//.test(rel)   || /\.test\.(mjs|js)$/.test(rel)
//     GREEN  /(^|\/)audit-fixtures\//.test(rel) || /\.test\.(mjs|js)$/.test(rel)
//
// so the two cannot be separated on style, length, shape, import list, symbol names,
// or the test-class literal itself — only on whether the gate can REACH the repo's
// authoritative fixture enumeration. That mirrors the real in-repo contrast between
// `census-build.mjs::isNonRuntime` (clean) and the pre-fix `scan-synced-disclosure.mjs`
// synthetic-fixture exemption (the motivating defect).
//
// The RED pole is asserted on its failure IDENTITY — the file, the symbol, the literal,
// and the "reaches 0 of N" clause — never on a bare non-zero exit, which MUST-2 BLOCKS.
//
// ANTI-VACUITY: the green pole is only meaningful if the checker actually EXAMINED a
// test-class selector in it, so that count is asserted, and asserted EQUAL to the red
// pole's. A green from an empty examination is the failure this fixture exists to catch.
//
// Exits 0 when ALL cases pass, non-zero otherwise.
//   node .claude/audit-fixtures/scope-authority/run.mjs

import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  BASELINE,
  analyse,
  baselineKey,
  identityString,
  loadAuthority,
  scanSource,
  extractLiterals,
} from "../../bin/check-scope-authority.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const RED = path.join(HERE, "poles", "red-pole.mjs");
const GREEN = path.join(HERE, "poles", "green-pole.mjs");
const RED_BLOCK = path.join(HERE, "poles", "red-pole-block.mjs");
const GREEN_BLOCK = path.join(HERE, "poles", "green-pole-block.mjs");

let pass = 0;
let fail = 0;

function check(name, ok, reason) {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}: ${reason}`);
  }
}

const allFiles = execFileSync("git", ["ls-files"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  maxBuffer: 1 << 28,
})
  .split("\n")
  .filter(Boolean);

const { members: authority, error: authErr } = loadAuthority(allFiles);

function run(subjects, auth = authority) {
  return analyse({ subjects, allFiles, authority: auth });
}

/* ── 0. the instrument's own preconditions ───────────────────────────────── */

check("authority-parses", !authErr, `loadAuthority reported: ${authErr}`);
check(
  "authority-non-empty",
  authority.size > 0,
  "authority is EMPTY — every gate would 'reach 0 of 0' and the check would be vacuous",
);
check(
  "authority-members-are-run-mjs",
  [...authority].every((m) => /audit-fixtures\/[^/]+\/run\.mjs$/.test(m)),
  `authority contains a non-runner member: ${[...authority].find((m) => !/run\.mjs$/.test(m))}`,
);
check(
  "poles-exist",
  [RED, GREEN, RED_BLOCK, GREEN_BLOCK].every((p) => fs.existsSync(p)),
  "a pole file is missing",
);

/* ── 1. the pole pair ────────────────────────────────────────────────────── */

const red = run([RED]);
const green = run([GREEN]);

check("red-pole-flags-exactly-one", red.findings.length === 1, `got ${red.findings.length}`);
check("green-pole-flags-none", green.findings.length === 0, `got ${green.findings.length}`);
check(
  "poles-verdicts-differ",
  red.findings.length !== green.findings.length,
  "IDENTICAL verdicts — the pair is VACUOUS and proves nothing (instrument-bipolarity MUST-1)",
);

/* ANTI-VACUITY: a green pole that examined nothing is not a pass. */
check(
  "green-pole-examined-a-selector",
  green.selectorCount >= 1,
  "the green pole produced 0 findings because 0 test-class selectors were EXAMINED — " +
    "a vacuous green, not a clean one",
);
check(
  "poles-examined-equally",
  red.selectorCount === green.selectorCount && red.selectorCount >= 1,
  `red examined ${red.selectorCount}, green examined ${green.selectorCount} — the poles must ` +
    "separate on REACH alone, not on how much of each was looked at",
);

/* ── 1b. the BLOCK-SCOPE pole pair ───────────────────────────────────────────
 * The pair above separates on a sibling arm in the SAME EXPRESSION. This pair puts
 * the rescuing arm in a DIFFERENT STATEMENT of the same function (the sequential
 * early-return `isExcluded` shape), which is the ONLY thing the function-body window
 * decides. Without it, dropping that window changes the checker's verdict on the live
 * repo (measured: 2 findings → 4) while every case above stays green — an empty red
 * set, which resolves nothing. These two cases are that window's coverage. */

const redBlock = run([RED_BLOCK]);
const greenBlock = run([GREEN_BLOCK]);

check(
  "block-red-pole-flags-exactly-one",
  redBlock.findings.length === 1,
  `got ${redBlock.findings.length}`,
);
check(
  "block-green-pole-flags-none",
  greenBlock.findings.length === 0,
  `got ${greenBlock.findings.length} — a rescuing arm in a SIBLING STATEMENT of the same ` +
    "function body was not seen, so the function-body window is not doing its job",
);
check(
  "block-poles-verdicts-differ",
  redBlock.findings.length !== greenBlock.findings.length,
  "IDENTICAL verdicts — this pair is VACUOUS (instrument-bipolarity MUST-1)",
);
check(
  "block-green-pole-examined-a-selector",
  greenBlock.selectorCount >= 1,
  "0 test-class selectors EXAMINED — a vacuous green, not a clean one",
);
check(
  "block-red-identity-names-symbol-and-literal",
  redBlock.findings.length === 1 &&
    redBlock.findings[0].symbol === "isExempt" &&
    identityString(redBlock.findings[0]).includes("/\\.test\\.(mjs|js)$/") &&
    /reaches 0 of \d+ authoritative/.test(identityString(redBlock.findings[0])),
  `identity was not specific: ${redBlock.findings[0] ? identityString(redBlock.findings[0]) : "<no finding>"}`,
);

/* ── 2. the RED pole's failure IDENTITY (MUST-2: never a bare quantity) ───── */

const f = red.findings[0] ?? null;
const id = f ? identityString(f) : "";

check("red-identity-names-the-rule-class", id.includes("SCOPE-AUTHORITY-BLIND-GATE"), id);
check("red-identity-names-the-file", id.includes("red-pole.mjs"), id);
check("red-identity-names-the-symbol", f?.symbol === "isFixtureFile", `symbol=${f?.symbol}`);
check(
  "red-identity-names-the-literal",
  id.includes("/\\.test\\.(mjs|js)$/"),
  `identity did not quote the offending literal: ${id}`,
);
check(
  "red-identity-names-zero-reach-against-a-total",
  /reaches 0 of \d+ authoritative audit-fixture runner/.test(id),
  `identity did not state reach-vs-total: ${id}`,
);
check(
  "red-identity-names-a-concrete-missed-member",
  /audit-fixtures\/[^/]+\/run\.mjs/.test(id),
  `identity named no concrete unreachable member: ${id}`,
);
check(
  "red-identity-is-not-a-bare-quantity",
  id.includes("hand-restated scope gate") && !/^\s*\d+\s*$/.test(id),
  "the red pole's assertion must carry a failure IDENTITY, not a count",
);

/* ── 3. LIVE MUTATION — the separation is caused by that ONE arm ──────────── */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scope-authority-"));
function mutated(src, from, to, name) {
  const text = fs.readFileSync(src, "utf8");
  if (!text.includes(from)) return null;
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text.split(from).join(to));
  return p;
}

// GREEN → RED: swap the authoritative directory arm for a non-reaching one.
const greenBroken = mutated(GREEN, "audit-fixtures", "test-harness", "green-broken.mjs");
check("mutation-reached-green", greenBroken !== null, "the GREEN pole did not contain the arm to mutate");
if (greenBroken) {
  const r = run([greenBroken]);
  check(
    "green-flips-to-RED-when-its-authority-arm-is-removed",
    r.findings.length === 1 && identityString(r.findings[0]).includes("reaches 0 of"),
    `expected 1 finding, got ${r.findings.length} — the green pole was clean for some reason ` +
      "OTHER than its authoritative arm, so the pair does not separate on what it claims",
  );
}

// RED → GREEN: swap the non-reaching arm for the authoritative one.
const redFixed = mutated(RED, "test-harness", "audit-fixtures", "red-fixed.mjs");
check("mutation-reached-red", redFixed !== null, "the RED pole did not contain the arm to mutate");
if (redFixed) {
  const r = run([redFixed]);
  check(
    "red-flips-to-GREEN-when-an-authority-arm-is-added",
    r.findings.length === 0,
    `expected 0 findings, got ${r.findings.length} — the red pole flags for some reason OTHER ` +
      "than its blind arm",
  );
}

/* ── 4. failure DIRECTION under a degenerate authority ────────────────────── */
/* An empty authority must make the check LOUD (everything unreachable), never silent.
 * A detector whose degenerate mode is silence is the defect it exists to catch. */
const degenerate = run([GREEN], new Set());
check(
  "empty-authority-fails-loud-not-silent",
  degenerate.findings.length >= 1,
  "with an EMPTY authority the checker reported the GREEN pole clean — its degenerate mode is " +
    "silence, which is the very failure this detector exists to catch",
);

/* ── 5. tokenizer regression pin (the root-cause bug this checker was born with) ── */
/* A regex literal ending `\//` reads as `//` to a naive comment scanner, which then
 * blanks the rest of the line and LOSES every sibling literal after it — silently
 * turning a clean gate into a finding, or hiding a real one. Pinned in both
 * directions. */
{
  const src = 'const x = /(^|\\/)audit-fixtures\\//.test(p) || /\\.test\\.mjs$/.test(p);\nconst y = 1;\n';
  const lits = extractLiterals(src);
  check(
    "tokenizer-sees-both-literals-across-an-escaped-slash",
    lits.filter((l) => l.kind === "regex").length === 2,
    `expected 2 regex literals, got ${lits.filter((l) => l.kind === "regex").length} — a regex ` +
      "ending in \\// was mis-read as a line comment",
  );
  const { code } = scanSource(src);
  check(
    "tokenizer-does-not-blank-the-following-line",
    code.includes("const y"),
    "the scanner blanked past the regex literal's closing slash",
  );
}
{
  // ...and a real line comment IS still blanked (the opposite pole of the same predicate).
  const { code } = scanSource("const a = 1; // audit-fixtures\nconst b = 2;\n");
  check(
    "tokenizer-still-blanks-a-real-line-comment",
    !code.includes("audit-fixtures") && code.includes("const b"),
    "a genuine line comment survived the scan — a comment could then rescue a blind gate",
  );
}

/* ── 5b. string-predicate extraction reads TOKENS, not raw text ─────────────
 * `.endsWith("…")` matched off raw text also matches inside ANOTHER string. This
 * file's own BASELINE quotes that exact text as DATA, which manufactured two phantom
 * gates in the checker itself (measured: 16 selectors -> 14 after the fix). Pinned in
 * BOTH directions, because a fix that stopped seeing real ones would look identical. */
{
  // NEGATIVE pole: the predicate text appears INSIDE a string — it is data, not a gate.
  const asData = 'const BASELINE = [{ literal: \'.endsWith(".test.mjs")\' }];\n';
  const lits = extractLiterals(asData);
  check(
    "string-predicate-inside-a-string-is-not-a-gate",
    lits.length === 0,
    `expected 0 literals, got ${lits.length} (${lits.map((l) => l.display).join(", ")}) — quoted ` +
      "DATA was read as a live predicate, manufacturing a phantom gate",
  );
}
{
  // POSITIVE pole: the same text as a REAL call must still be extracted. Without this
  // case, a fix that extracts nothing at all would pass the negative pole above.
  const asCode = 'function f(p) { return p.endsWith(".test.mjs"); }\n';
  const lits = extractLiterals(asCode);
  check(
    "string-predicate-as-a-real-call-IS-a-gate",
    lits.length === 1 && lits[0].display === '.endsWith(".test.mjs")' && lits[0].test("a/b.test.mjs"),
    `expected exactly 1 working endsWith literal, got ${lits.length} ` +
      `(${lits.map((l) => l.display).join(", ")})`,
  );
}

/* ── 6. baseline hygiene — every accepted finding is fully identified ─────── */

for (const b of BASELINE) {
  check(
    `baseline-entry-complete:${b.file}::${b.symbol}`,
    Boolean(b.file && b.symbol && b.literal && /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") && b.reason && b.reason.length > 40),
    "a baseline entry must name file + symbol + literal + an ISO date + a substantive reason",
  );
}
/* An entry whose removal condition is unstated is permanent by default — the same
 * shape as a deferral nobody can discharge. Each must say what would retire it. */
for (const b of BASELINE) {
  check(
    `baseline-entry-states-its-removal-condition:${b.symbol}`,
    /REMOVE WHEN:/.test(b.reason || ""),
    "this accepted finding says why it exists but not what would let it be removed, so it is " +
      "permanent by default — state a REMOVE WHEN: condition",
  );
}
check(
  "baseline-keys-are-unique",
  new Set(BASELINE.map(baselineKey)).size === BASELINE.length,
  "two baseline entries share an identity — one silently covers the other",
);
/* The poles must never be baselined — that would report clean over the exact class the
 * detector exists to catch. Anchored to the POLES DIRECTORY, not to the substring
 * "scope-authority": the loose form also matched `bin/check-scope-authority.mjs`, whose
 * own true-positive finding IS legitimately baselined. A guard too broad to tell those
 * two apart is the same defect this whole fixture is about. */
const POLES_DIR = ".claude/audit-fixtures/scope-authority/poles/";
check(
  "baseline-does-not-suppress-the-pole-pair",
  !BASELINE.some((b) => b.file.replace(/\\/g, "/").startsWith(POLES_DIR)),
  `a baseline entry covers a file under ${POLES_DIR} — the detector would report clean over ` +
    "the exact class it exists to catch",
);
check(
  "pole-guard-can-actually-fire",
  [{ file: `${POLES_DIR}red-pole.mjs` }].some((b) => b.file.replace(/\\/g, "/").startsWith(POLES_DIR)) &&
    ![{ file: ".claude/bin/check-scope-authority.mjs" }].some((b) =>
      b.file.replace(/\\/g, "/").startsWith(POLES_DIR),
    ),
  "the pole guard is non-discriminating: it must flag a pole path AND spare the checker's own " +
    "source, or it is either blind or over-broad",
);

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* tmp cleanup is best-effort */
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
