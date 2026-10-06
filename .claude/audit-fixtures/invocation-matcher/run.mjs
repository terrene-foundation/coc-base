#!/usr/bin/env node
/**
 * Bipolar poles for the BIN-TOOL MATCHER in
 * `.claude/bin/check-invocation-obligation.mjs` (cc-artifacts.md Rule 9,
 * instrument-bipolarity.md MUST-1/MUST-2).
 *
 * THE DEFECT THESE PIN. The matcher required a literal `bin/` prefix, so a rule
 * naming a tool by BARE BASENAME -- `` `in-force-check.mjs` `` -- was invisible to
 * the checker and its invocation obligation was never evaluated. MEASURED on the
 * real corpus at the time of the fix: 24 rule-named tools resolve to real files in
 * `.claude/bin` and are named WITHOUT the prefix. All 24 are invoked today, so the
 * findings set was EMPTY -- which is exactly why the gap was invisible, and exactly
 * what would have kept it quiet on the day one of them lost its caller.
 *
 * WHY SYNTHETIC ROOTS. Each pole is a minimal hand-built `.claude/` -- settings,
 * rules, bin -- so the assertion is about the AUTHORITY under test and not about
 * the shape of this one repository. A pole built by copying the live tree would
 * change its verdict every time an unrelated lane armed or retired something.
 *
 * EVERY ASSERTION IS AN IDENTITY, NEVER A CARDINALITY. The poles name the artifact
 * and the gap kind they expect. A `findings.length > 0` assertion would pass on the
 * wrong finding just as happily as on the right one, and this repo has a measured
 * case where exactly that kept a pole GREEN while the defect it pinned returned.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "../../bin/check-invocation-obligation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = path.join(HERE, "roots");

let failures = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`PASS ${name}`);
  else {
    console.log(`FAIL ${name}`);
    console.log(`     ${detail}`);
    failures += 1;
  }
};

const run = (root) => {
  const res = scan(path.join(ROOTS, root));
  return Array.isArray(res) ? res : (res.findings ?? []);
};
const show = (fs) => fs.map((f) => `${f.kind}:${f.artifact}:${f.gap}`).join(", ") || "(none)";
const has = (fs, artifact, gap) => fs.some((f) => f.artifact === artifact && f.gap === gap);
const names = (fs, artifact) => fs.some((f) => f.artifact === artifact);

// ── POLE 1 (RED) — the core fix. A bare-named tool with no caller MUST be seen. ──
{
  const f = run("bare-no-caller");
  ok(
    "bare-no-caller: a BARE-named tool with no caller is REPORTED as NO-CALLER",
    has(f, "orphan-tool.mjs", "NO-CALLER"),
    `findings = ${show(f)}`,
  );
}

// ── POLE 2 (GREEN) — identical rule text; the tool IS invoked, so silence. ───────
// Converges with POLE 1 at its most similar point: same rule file, same tool, same
// bare spelling. The ONLY difference is that a command invokes it.
{
  const f = run("bare-with-caller");
  ok(
    "bare-with-caller: the same bare-named tool, genuinely invoked, is SILENT",
    !names(f, "orphan-tool.mjs"),
    `findings = ${show(f)}`,
  );
}

// ── POLE 3 (GREEN) — resolution is by AUTHORITY, so prose cannot fabricate. ──────
{
  const f = run("bare-not-a-real-tool");
  ok(
    "bare-not-a-real-tool: a bare .mjs name matching NO file in .claude/bin fabricates nothing",
    !names(f, "imaginary-tool.mjs"),
    `findings = ${show(f)}`,
  );
}

// ── POLE 4 (GREEN) — the registration-preflight DISPATCH REGISTRY is a caller. ───
// This is the fabricated-finding guard. Without it the widened matcher reports
// three genuinely-dispatched tools as gaps — the exact class this repo already
// recorded once, when a narrower caller-check invented findings about tools
// invoked via registration-preflight.
{
  const f = run("preflight-dispatched");
  ok(
    "preflight-dispatched: a tool dispatched by COUPLINGS is NOT reported as a gap",
    !names(f, "dispatched-tool.mjs"),
    `findings = ${show(f)}`,
  );
}

// ── POLE 5 (GREEN) — a multi-line import specifier is a caller. ─────────────────
// The specifier line carries no `import` keyword, so the invocation-shape test
// alone cannot see it.
{
  const f = run("module-specifier-caller");
  ok(
    "module-specifier-caller: a tool reached by a MULTI-LINE import is NOT reported as a gap",
    !names(f, "imported-tool.mjs"),
    `findings = ${show(f)}`,
  );
}

console.log(failures === 0 ? `\nAll poles held (${failures} failures).` : `\n${failures} pole assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
