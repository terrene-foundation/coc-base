#!/usr/bin/env node
/**
 * wiring-detection-canonical — fixture runner for
 * `.claude/bin/validate-emit.mjs::checkWiringDetectionCanonical`, the structural
 * gate for `trust-posture.md` MUST-8's canonical `**Detection mechanism:**` field.
 *
 *   node .claude/audit-fixtures/wiring-detection-canonical/run.mjs
 *   echo $?      # 0 = all green
 *
 * ## WHY THIS SUITE IS BIPOLAR PER ARM (instrument-bipolarity.md MUST-1/2)
 *
 * Every RED pole asserts a failure IDENTITY, never merely a non-zero result. The
 * check has TWO distinct identities and they fail for OPPOSITE reasons, so a
 * suite that only asserted "some FAIL appeared" would pass against a detector
 * that reported the wrong one:
 *
 *   wiring-detection-missing    0 canonical fields — the anchor cannot address it
 *   wiring-detection-ambiguous  >1 canonical fields — locateByAnchor refuses
 *
 * ## THE RED POLE IS THE REAL CASE, NOT A SYNTHETIC ONE
 *
 * A1's fixture is the VERBATIM pre-fix `- **Detection:**` block from
 * `sync-completeness.md` — the block that actually made `declaration-anchor`
 * unable to address that rule. A2 is the SAME block with the ONE token changed
 * (`Detection` -> `Detection mechanism`). The two poles differ by exactly that
 * token and in no other byte, so a detector that passes A2 and fails A1 can only
 * be keying on the field NAME, which is the property under test.
 *
 * ## THE LOAD-BEARING NO-FALSE-POSITIVE CASE IS B2, NOT B1
 *
 * B2 is a block carrying a canonical field AND two variant-labelled siblings. It
 * MUST stay silent. That is the whole concession the contract makes — variant
 * labels carry per-layer scoping a roll-up cannot, so they are PERMITTED
 * alongside the canonical field and must never be flagged. A check implemented as
 * "no variant Detection bullets allowed" passes every other case in this suite
 * and fails B2, which is why B2 is the pole that discriminates the real contract
 * from the naive one.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const { checkWiringDetectionCanonical } = await import(
  path.join(ROOT, ".claude", "bin", "validate-emit.mjs")
);

let pass = 0;
let fail = 0;
const failures = [];

// Per-case lines in the shape `run-audit-fixtures.mjs` counts
// (`CASE_PASS = /^[ \t]*(?:PASS|ok)[ \t]+\S/`). A runner that prints ONLY a
// summary is scored `observed 0 case(s)` against its declared `min_cases` and
// reds the CI dispatcher — its standalone exit code is not coverage
// (coc-artifact-eval-coverage.md MUST-3). Measured: this suite reported 0
// observed cases through the dispatcher before these lines existed.
const emitPass = (id) => console.log(`PASS ${id}`);
const emitFail = (id, why) => console.log(`FAIL ${id} — ${why}`);

function stage(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wdc-fx-"));
  fs.mkdirSync(path.join(dir, ".claude", "rules"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, ".claude", "rules", name), body);
  }
  return dir;
}

/** Assert the check's verdict over a staged corpus. */
function check(id, files, { expect, identity }) {
  const dir = stage(files);
  try {
    const out = checkWiringDetectionCanonical(dir);
    const fails = out.results.filter((r) => r.status === "fail");
    const got = fails.length > 0 ? "fail" : "pass";
    if (got !== expect) {
      fail++;
      const why = `expected ${expect}, got ${got}`;
      failures.push(`${id}: ${why} — ${JSON.stringify(out.results.map((r) => r.detail?.slice(0, 90)))}`);
      emitFail(id, why);
      return;
    }
    if (identity) {
      // The IDENTITY assertion, not just the polarity. A detector reporting the
      // wrong identity is a different defect than one reporting none.
      const hit = fails.some((r) => (r.detail || "").includes(identity));
      if (!hit) {
        fail++;
        const why = `FAILED with the wrong identity — expected "${identity}"`;
        failures.push(`${id}: ${why}, got ${JSON.stringify(fails.map((r) => (r.detail || "").slice(0, 60)))}`);
        emitFail(id, why);
        return;
      }
    }
    pass++;
    emitPass(id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The REAL pre-fix block from sync-completeness.md, reduced to the two fields
// that make it a Wiring block plus the offending Detection bullet. The label is
// the only thing that varies between A1 and A2.
const REAL_BLOCK = (label) => `# Sync Completeness

## Trust Posture Wiring

### Rules 1, 2 (version-stale row), 4 — enumeration + table + count discipline

- **Severity:** \`halt-and-report\` (agent surfaces, user adjudicates).
- **Grace period:** 7 days from rule landing (2026-05-06 -> 2026-05-13, expired).
- **${label}:** \`cc-architect\` mechanical sweep at \`/codify\`: every \`/sync-to-*\` command body MUST enumerate from manifest.
`;

// ── A — THE REAL CASE, one token apart ───────────────────────────────────────
check("A1 real pre-fix block FAILS as missing", { "sync-completeness.md": REAL_BLOCK("Detection") }, {
  expect: "fail",
  identity: "wiring-detection-missing",
});
check("A2 same block, canonical label, PASSES", { "sync-completeness.md": REAL_BLOCK("Detection mechanism") }, {
  expect: "pass",
});

// ── B — VARIANT SIBLINGS ─────────────────────────────────────────────────────
const VARIANTS_ONLY = `# Rec Quality

## Trust Posture Wiring

- **Severity:** \`halt-and-report\` at gate-review.
- **Grace period:** 7 days from rule landing.
- **Detection mechanism (hook layer — IMPLEMENTED 2026-05-06):** \`violation-patterns.js::detectMenuWithoutPick\`.
- **Detection mechanism (review layer — semantic):** the \`/codify\` reviewer sweep.
`;
const VARIANTS_PLUS_CANONICAL = `# Rec Quality

## Trust Posture Wiring

- **Severity:** \`halt-and-report\` at gate-review.
- **Grace period:** 7 days from rule landing.
- **Detection mechanism:** the canonical single-field roll-up of the two bullets below.
- **Detection mechanism (hook layer — IMPLEMENTED 2026-05-06):** \`violation-patterns.js::detectMenuWithoutPick\`.
- **Detection mechanism (review layer — semantic):** the \`/codify\` reviewer sweep.
`;
check("B1 variant labels ALONE fail as missing", { "rq.md": VARIANTS_ONLY }, {
  expect: "fail",
  identity: "wiring-detection-missing",
});
// THE LOAD-BEARING NO-FALSE-POSITIVE POLE — see the header.
check("B2 canonical + variant siblings PASSES", { "rq.md": VARIANTS_PLUS_CANONICAL }, { expect: "pass" });

// ── C — AMBIGUITY, the OTHER identity ────────────────────────────────────────
const TWO_CANONICAL = `# Dup

## Trust Posture Wiring

- **Severity:** \`halt-and-report\`.
- **Grace period:** 7 days.
- **Detection mechanism:** first field.
- **Detection mechanism:** second field.
`;
check("C1 two canonical fields FAIL as ambiguous", { "dup.md": TWO_CANONICAL }, {
  expect: "fail",
  identity: "wiring-detection-ambiguous",
});

// ── D — BLOCK RECOGNITION ────────────────────────────────────────────────────
// A section with <2 canonical fields is NOT a Wiring block and must be ignored,
// or every prose rule in the corpus would be flagged.
check("D1 a one-field section is not a Wiring block", {
  "prose.md": `# Prose\n\n## Some Section\n\n- **Severity:** mentioned in passing.\n`,
}, { expect: "pass" });

// Bold-paragraph-titled Wiring blocks (artifact-flow.md's form) must be caught —
// a heading-only walk would miss them, and that is a real corpus shape.
check("D2 bold-titled Wiring block IS recognised", {
  "af.md": `# AF\n\n**Trust Posture Wiring (Intake Disclosure Scrub):**\n\n- **Severity:** \`halt-and-report\`.\n- **Grace period:** 7 days.\n- **Detection:** the scanner invocation.\n`,
}, { expect: "fail", identity: "wiring-detection-missing" });

check("D3 bold-titled Wiring block, canonical, PASSES", {
  "af.md": `# AF\n\n**Trust Posture Wiring (Intake Disclosure Scrub):**\n\n- **Severity:** \`halt-and-report\`.\n- **Grace period:** 7 days.\n- **Detection mechanism:** the scanner invocation.\n`,
}, { expect: "pass" });

// Two sibling Wiring blocks under one file, each needing its OWN canonical field:
// the second is short one. A check that scanned per FILE rather than per BLOCK
// would pass this, since the file as a whole contains a canonical field.
check("D4 per-BLOCK, not per-FILE", {
  "two.md": `# Two

## Trust Posture Wiring

- **Severity:** a.
- **Grace period:** 7 days.
- **Detection mechanism:** present here.

## Trust Posture Wiring — MUST-4

- **Severity:** b.
- **Grace period:** 7 days.
- **Detection (hook layer):** but NOT here.
`,
}, { expect: "fail", identity: "wiring-detection-missing" });

// ── E — FENCE AWARENESS ──────────────────────────────────────────────────────
// A fenced example containing a Wiring-shaped block is documentation, not a
// block. trust-posture.md itself ships exactly this (its MUST-8 template fence).
check("E1 a fenced template is not a live block", {
  "tp.md": `# TP

## Trust Posture Wiring

- **Severity:** real.
- **Grace period:** 7 days.
- **Detection mechanism:** real.

The canonical template:

\`\`\`markdown
## Trust Posture Wiring

- **Severity:** \`block\` / \`halt-and-report\` / \`advisory\`.
- **Grace period:** N days from rule landing.
- **Detection:** named hook function.
\`\`\`
`,
}, { expect: "pass" });

// ── G — DUPLICATE BLOCK TITLE, the THIRD failure identity ────────────────────
// `locateByAnchor` refuses for TWO reasons and the field count is only one. The
// other is a duplicated block title: the anchor is (file, block_title, field), so
// two sections sharing a title make the anchor resolve to NEITHER. Both poles are
// the REAL case, not a synthetic one — deployment.md carried three identical
// `**Trust Posture Wiring:**` titles until `bbbc2c17e` renamed them BY HAND, and
// nothing gated it before or after. Field text is copied from that file.
const DUP_TITLES = `# Deployment

**Trust Posture Wiring:**

- **Severity:** \`halt-and-report\` at the /release gate (eager-import sweep).
- **Grace period:** 7 days from rule landing.
- **Detection mechanism:** release-specialist mechanical clean-venv sweep.

**Trust Posture Wiring:**

- **Severity:** \`halt-and-report\` at the /release gate (pre-pledge version anchor).
- **Grace period:** 7 days from rule landing.
- **Detection mechanism:** release-specialist mechanical sweep on any new public API.
`;
// The GREEN pole is the SAME file after the real rename — identical fields, every
// one canonical, differing ONLY in the parenthetical that makes each title unique.
const DISTINCT_TITLES = DUP_TITLES
  .replace("**Trust Posture Wiring:**", "**Trust Posture Wiring (Eagerly-Imported Transitive Dependencies):**")
  .replace("**Trust Posture Wiring:**", "**Trust Posture Wiring (Pre-Pledge Release Disclosure):**");

check("G1 duplicate block titles FAIL as title-ambiguous", { "deployment.md": DUP_TITLES }, {
  expect: "fail",
  identity: "wiring-title-ambiguous",
});
// The discriminating pole: canonical fields alone do NOT make a block addressable.
check("G2 the same blocks with DISTINCT titles PASS", { "deployment.md": DISTINCT_TITLES }, { expect: "pass" });

// ── F — LIVE CORPUS ──────────────────────────────────────────────────────────
// The real tree must be clean. This is the pole that would red if someone landed
// a non-conforming Wiring block, and it is the reason no grandfather set exists.
{
  const out = checkWiringDetectionCanonical(ROOT);
  const fails = out.results.filter((r) => r.status === "fail");
  if (fails.length === 0) {
    pass++;
    emitPass("F1 live corpus is clean");
  } else {
    fail++;
    failures.push(`F1 live corpus: ${fails.length} non-conforming block(s) — ${JSON.stringify(fails.map((r) => r.artifact))}`);
    emitFail("F1 live corpus is clean", `${fails.length} non-conforming block(s)`);
  }
}
// ...and the live corpus must actually have been INSPECTED, not vacuously empty.
// Without this, F1 passes against a check that enumerates nothing at all.
{
  const out = checkWiringDetectionCanonical(ROOT);
  const detail = out.results.map((r) => r.artifact).join(" ");
  const m = /(\d+) Wiring block\(s\)/.exec(detail);
  if (m && Number(m[1]) > 50) {
    pass++;
    emitPass(`F2 live corpus inspected ${m[1]} Wiring blocks (anti-vacuity)`);
  } else {
    fail++;
    failures.push(`F2 live corpus coverage: expected >50 Wiring blocks inspected, saw "${detail.slice(0, 120)}"`);
    emitFail("F2 live corpus coverage", "expected >50 Wiring blocks inspected");
  }
}

console.log(`wiring-detection-canonical fixtures: ${pass} pass / ${fail} fail`);
for (const f of failures) console.log("  FAIL " + f);
process.exit(fail === 0 ? 0 : 1);
