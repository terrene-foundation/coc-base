#!/usr/bin/env node
// Audit fixture runner for the Trust-Posture-Wiring mechanical sweep shipped in
// `.claude/agents/cc-architect.md` § Audit Dimensions item 5 — the sweep that
// GATES `/codify` (commands/codify.md Step 6b cites it by name).
//
// WHY THIS EXISTS. The sweep had no committed poles at all, and a Tier-1 re-run
// measured what that bought: dropping the ninth field from
// `check-descoping.mjs::CANONICAL_WIRING_FIELDS` made this consumer go QUIET,
// while the sibling `descoping-gate/run.mjs` redded M01-M04 with identity on the
// same mutation. A gate nothing reds is indistinguishable from one that cannot.
//
// THE SNIPPET IS EXTRACTED, NEVER COPIED. Every case below runs the bash block
// lifted out of the live agent file, so an edit that reverts the fix (a
// hardcoded `origin/main`, a two-dot range, a re-introduced `-ge 1`-only guard,
// a dropped failure flag) reds HERE instead of shipping. A transcribed copy
// would pass forever against a snippet that no longer exists
// (`specs-authority.md` Rule 9).
//
// BIPOLAR BY CONSTRUCTION (`instrument-bipolarity.md` MUST-1/2). Every arm is
// asserted in BOTH directions and every RED pole pins the failure IDENTITY --
// which file, which field, which exit code -- rather than a bare non-zero, since
// a bare non-zero is satisfied by a sweep that refuses every input.
//
// THE AUTHORITY IS STUBBED, DELIBERATELY. These cases mutate a synthetic
// `CANONICAL_WIRING_FIELDS` to prove the loop READS it; the real list's
// three-way parity with the MUST-8 template and `validate-emit.mjs` is section M
// of `descoping-gate/run.mjs` and is NOT re-asserted here.

import "../_lib/no-ambient-git.cjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const AGENT = join(REPO, ".claude", "agents", "cc-architect.md");

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

// ── Extraction ─────────────────────────────────────────────────────────────
// Fail CLOSED: a silent "" would make every case below run an empty script and
// report a uniform rc 0, i.e. green over nothing.
function extractSweep(text) {
  const anchor = text.indexOf("**Trust Posture Wiring (rules only, ENFORCED)**");
  if (anchor < 0) throw new Error("item-5 heading not found in cc-architect.md");
  const open = text.indexOf("```bash", anchor);
  if (open < 0) throw new Error("no bash fence after the item-5 heading");
  const bodyStart = text.indexOf("\n", open) + 1;
  const close = text.indexOf("```", bodyStart);
  if (close < 0) throw new Error("unterminated bash fence after the item-5 heading");
  const body = text
    .slice(bodyStart, close)
    .split("\n")
    .map((l) => (l.startsWith("   ") ? l.slice(3) : l))
    .join("\n");
  if (!/CANONICAL_WIRING_FIELDS/.test(body)) {
    throw new Error("extracted block does not read the canonical authority");
  }
  return body;
}

const SWEEP = extractSweep(readFileSync(AGENT, "utf8"));

// ── Synthetic tree ─────────────────────────────────────────────────────────
const REAL_FIELDS = [
  "Severity",
  "Grace period",
  "Cumulative posture impact",
  "Regression-within-grace",
  "Receipt requirement",
  "Detection mechanism",
  "Invoker class",
  "Violation scope",
  "Origin",
];

function ruleText(fields, { header = true } = {}) {
  const head = "# A Rule\n\nBody.\n\n";
  if (!header) return head;
  return head + "## Trust Posture Wiring\n\n" + fields.map((f) => `- **${f}:** stated.\n`).join("");
}

function authority(fields) {
  return `export const CANONICAL_WIRING_FIELDS = ${JSON.stringify(fields)};\n`;
}

const tmps = [];
function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Build a repo with a BASE branch and a codify branch.
 *  baseRules   — rule files as they stand at the fork point
 *  codifyRules — rule files the CODIFY branch edits
 *  driftRules  — rule files a LATER commit on the BASE branch edits (the
 *                dev-stacked case; these are NOT this codify's work)
 */
function buildRepo({ fields, baseRules, codifyRules, driftRules = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "cc-wiring-sweep-"));
  tmps.push(dir);
  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  mkdirSync(join(dir, ".claude", "bin"), { recursive: true });
  writeFileSync(join(dir, ".claude", "bin", "check-descoping.mjs"), authority(fields));
  git(dir, ["init", "-q", "-b", "base"]);
  git(dir, ["config", "user.email", "f@x"]);
  git(dir, ["config", "user.name", "f"]);
  for (const [n, t] of Object.entries(baseRules)) writeFileSync(join(dir, ".claude", "rules", n), t);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  const fork = git(dir, ["rev-parse", "HEAD"]).trim();

  // The codify branch forks HERE.
  git(dir, ["checkout", "-q", "-b", "codify/x"]);
  for (const [n, t] of Object.entries(codifyRules)) writeFileSync(join(dir, ".claude", "rules", n), t);
  if (Object.keys(codifyRules).length) {
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "codify"]);
  }

  // Later, unrelated work lands on the BASE branch and is merged forward, so a
  // stale base ref enumerates it as though this codify had touched it.
  let stale = fork;
  if (Object.keys(driftRules).length) {
    git(dir, ["checkout", "-q", "base"]);
    for (const [n, t] of Object.entries(driftRules)) writeFileSync(join(dir, ".claude", "rules", n), t);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "unrelated dev work"]);
    git(dir, ["checkout", "-q", "codify/x"]);
    git(dir, ["merge", "-q", "--no-edit", "base"]);
    stale = fork; // the pre-drift ref a stale default still points at
  }
  return { dir, fork, stale };
}

function runSweep(dir, baseRef) {
  const env = { ...process.env };
  if (baseRef) env.CODIFY_BASE_REF = baseRef;
  else delete env.CODIFY_BASE_REF;
  try {
    const out = execFileSync("bash", ["-c", SWEEP], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

// ── A. Field presence — the arm the ninth field broke ───────────────────────
{
  const full = ruleText(REAL_FIELDS);
  const missing9 = ruleText(REAL_FIELDS.filter((f) => f !== "Invoker class"));

  const green = buildRepo({ fields: REAL_FIELDS, baseRules: { "r.md": "# A Rule\n" }, codifyRules: { "r.md": full } });
  const a01 = runSweep(green.dir, green.fork);
  check("A01 compliant pole — every canonical field present ⇒ exit 0, no FAIL", a01.code === 0 && !/FAIL/.test(a01.out), `rc=${a01.code} out=${JSON.stringify(a01.out)}`);

  const red = buildRepo({ fields: REAL_FIELDS, baseRules: { "r.md": "# A Rule\n" }, codifyRules: { "r.md": missing9 } });
  const a02 = runSweep(red.dir, red.fork);
  check("A02 violation pole — the NINTH field dropped from the rule ⇒ FAIL names it", /wiring missing field Invoker class/.test(a02.out), `out=${JSON.stringify(a02.out)}`);
  check("A02b — and the sweep EXITS NON-ZERO (the /codify halt is mechanical, not narrated)", a02.code !== 0, `rc=${a02.code}`);
  check("A02c — the named field is not blank (the `**:**` garble is the empty-authority signature)", !/wiring missing field\s*$/m.test(a02.out), `out=${JSON.stringify(a02.out)}`);

  const noHeader = buildRepo({ fields: REAL_FIELDS, baseRules: { "r.md": "# A Rule\n" }, codifyRules: { "r.md": ruleText([], { header: false }) } });
  const a03 = runSweep(noHeader.dir, noHeader.fork);
  check("A03 violation pole — no `## Trust Posture Wiring` header ⇒ FAIL names the section", /missing Trust Posture Wiring/.test(a03.out) && a03.code !== 0, `rc=${a03.code} out=${JSON.stringify(a03.out)}`);
}

// ── B. Derivation liveness — the loop READS the authority ───────────────────
// A02 alone is satisfied by a sweep with the nine fields baked in. These cases
// move the AUTHORITY and require the verdict to move with it.
{
  const full = ruleText(REAL_FIELDS);
  const tenth = buildRepo({ fields: [...REAL_FIELDS, "Zebra"], baseRules: { "r.md": "# A Rule\n" }, codifyRules: { "r.md": full } });
  const b01 = runSweep(tenth.dir, tenth.fork);
  check("B01 — a field ADDED to the authority is demanded of the rule (verdict follows the list)", /wiring missing field Zebra/.test(b01.out) && b01.code !== 0, `rc=${b01.code} out=${JSON.stringify(b01.out)}`);

  const eight = buildRepo({ fields: REAL_FIELDS.filter((f) => f !== "Invoker class"), baseRules: { "r.md": "# A Rule\n" }, codifyRules: { "r.md": ruleText(REAL_FIELDS.filter((f) => f !== "Invoker class")) } });
  const b02 = runSweep(eight.dir, eight.fork);
  check("B02 compliant pole — a field REMOVED from the authority is no longer demanded", b02.code === 0 && !/FAIL/.test(b02.out), `rc=${b02.code} out=${JSON.stringify(b02.out)}`);
}

// ── C. The EMPTY-authority refusal — the guard that did not fire ────────────
// `[].join("\n")` prints a bare newline, so the read loop yielded ONE EMPTY
// element: `${#FIELDS[@]}` was 1, the `-ge 1` guard passed, and the sweep then
// grepped every rule for `**:**` and reported a blank field name. MEASURED on
// the pre-fix snippet with reach proven (0 fields loaded).
{
  const empty = buildRepo({ fields: [], baseRules: { "r.md": "# A Rule\n" }, codifyRules: { "r.md": ruleText(REAL_FIELDS) } });
  const c01 = runSweep(empty.dir, empty.fork);
  check("C01 violation pole — an EMPTY authority REFUSES with the declared message", /canonical field set did not derive/.test(c01.out), `out=${JSON.stringify(c01.out)}`);
  check("C01b — and exits 2 (fail CLOSED, not a silent pass over zero fields)", c01.code === 2, `rc=${c01.code}`);
  check("C01c — and does NOT emit the blank-field garble the old guard produced", !/missing field\s*$/m.test(c01.out), `out=${JSON.stringify(c01.out)}`);

  // The pole that makes C01 mean something: the SAME tree with a non-empty
  // authority must NOT refuse, so C01 is not passing on a sweep that refuses
  // everything.
  const notEmpty = buildRepo({ fields: REAL_FIELDS, baseRules: { "r.md": "# A Rule\n" }, codifyRules: { "r.md": ruleText(REAL_FIELDS) } });
  const c02 = runSweep(notEmpty.dir, notEmpty.fork);
  check("C02 compliant pole — a POPULATED authority does not trip the derivation refusal", c02.code === 0 && !/did not derive/.test(c02.out), `rc=${c02.code} out=${JSON.stringify(c02.out)}`);
}

// ── D. The BASE ref — a stale default charges this codify for other work ────
// ONE tree, two BASE refs. The codify edits a COMPLIANT rule; unrelated work on
// the base branch edits a NON-compliant one (the grandfathered-rule shape).
{
  const full = ruleText(REAL_FIELDS);
  const grandfathered = ruleText(REAL_FIELDS.filter((f) => f !== "Invoker class"));
  const t = buildRepo({
    fields: REAL_FIELDS,
    baseRules: { "mine.md": "# A Rule\n", "theirs.md": "# A Rule\n" },
    codifyRules: { "mine.md": full },
    driftRules: { "theirs.md": grandfathered },
  });

  const correct = runSweep(t.dir, "base");
  check("D01 compliant pole — BASE = the ref this codify forked from ⇒ only MY rule is swept, exit 0", correct.code === 0 && !/theirs\.md/.test(correct.out), `rc=${correct.code} out=${JSON.stringify(correct.out)}`);

  const stale = runSweep(t.dir, t.stale);
  check("D02 violation pole — a STALE base charges this codify for a rule it never touched", /theirs\.md/.test(stale.out), `out=${JSON.stringify(stale.out)}`);
  check("D02b — and the two BASE refs DISAGREE (an identical verdict pair proves nothing)", correct.out !== stale.out, "both BASE refs produced identical output — the sweep does not read BASE");
  check("D03 — the sweep REPORTS the base it used, so a wrong BASE is diagnosable rather than silent", /sweep base: /.test(correct.out), `out=${JSON.stringify(correct.out)}`);
}

// ── E. Extractor fail-closure ──────────────────────────────────────────────
// Without this, a renamed heading would yield an empty script and every case
// above would report a uniform green over nothing.
{
  let noHeading = false;
  let noFence = false;
  let notLive = false;
  try { extractSweep("# a document with no item-5 heading at all\n"); } catch { noHeading = true; }
  try { extractSweep("**Trust Posture Wiring (rules only, ENFORCED)** — prose, no fence.\n"); } catch { noFence = true; }
  try { extractSweep("**Trust Posture Wiring (rules only, ENFORCED)**\n\n```bash\necho hi\n```\n"); } catch { notLive = true; }
  check("E01 — extraction THROWS when the item-5 heading is absent", noHeading, "returned quietly; every case would then run an empty script");
  check("E02 — extraction THROWS when no bash fence follows the heading", noFence, "returned quietly");
  check("E03 — extraction THROWS when the block no longer reads CANONICAL_WIRING_FIELDS", notLive, "a snippet with a re-baked field list would extract cleanly");
}

for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\ncc-architect-wiring-sweep fixtures: ${pass} passed, ${fail} failed (${pass + fail} cases)`);
process.exit(fail === 0 ? 0 : 1);
