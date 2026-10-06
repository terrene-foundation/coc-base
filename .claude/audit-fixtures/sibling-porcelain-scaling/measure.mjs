#!/usr/bin/env node
/**
 * measure.mjs — re-derive the MAGNITUDE on a REAL forest.
 *
 * NOT registered in ci-audit-fixtures.json (that registry closes over
 * `run.mjs`). This exists because the magnitude of the loom#1902 fix is NOT
 * observable on a synthetic tree: there the checkout is too small for a
 * whole-tree `git status` to cost more than the ~10 ms git spawn floor, so a
 * synthetic timing ratio measures git's warm stat cache rather than query
 * breadth. MEASURED, which is why the synthetic timing case was removed from
 * `run.mjs`: on a 2500-file temp tree the full/narrow ratio ran 6.65 on the
 * FIRST (cold) trial and 1.10–1.36 on the next eight.
 *
 * On a real forest the separation is unambiguous. Run this to re-derive it
 * rather than citing a number out of README.md.
 *
 * Run: node .claude/audit-fixtures/sibling-porcelain-scaling/measure.mjs
 */
import "../_lib/no-ambient-git.cjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const LIBDIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const { resolveGitBinary, gitEnv } = require(
  path.join(LIBDIR, "git-subprocess-env.js"),
);
const sp = require(path.join(LIBDIR, "sibling-porcelain.js"));

const TARGET = process.argv[2] || ".claude/hooks/lib/sibling-porcelain.js";
const gitBin = resolveGitBinary();
if (!gitBin) {
  console.error("no git binary resolved — cannot measure");
  process.exit(1);
}

const enumerated = sp.enumerateSiblingWorktrees(REPO_ROOT);
if (!enumerated.ok) {
  console.error(`enumeration INDETERMINATE: ${enumerated.reason}`);
  process.exit(1);
}
const sibs = enumerated.siblings;
console.log(`forest: ${sibs.length} sibling worktrees; target: ${TARGET}\n`);

function sweep(label, args) {
  const t0 = process.hrtime.bigint();
  let ok = 0;
  for (const wt of sibs) {
    const r = spawnSync(gitBin, args, {
      cwd: wt,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 5000,
      env: gitEnv(),
    });
    if (r.status === 0) ok += 1;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(
    `${label.padEnd(46)} ok=${ok}/${sibs.length}  total=${Math.round(ms)}ms  per-sibling=${(ms / sibs.length).toFixed(1)}ms`,
  );
  return ms / sibs.length;
}

const wide = sweep("A  status --porcelain            (pre-fix)", [
  "status",
  "--porcelain",
]);
const narrow = sweep("B  --no-optional-locks + :(literal) (shipped)", [
  "--no-optional-locks",
  "status",
  "--porcelain",
  "--",
  `:(literal)${TARGET}`,
]);
console.log(`\nper-sibling query ratio A/B = ${(wide / narrow).toFixed(2)}x`);

// End-to-end, with the spawn count, so the containment-deferral half is visible
// alongside the query-narrowing half.
const probe = spawnSync(
  process.execPath,
  [
    "-e",
    `const cp=require("child_process");const o=cp.spawnSync;let n=0;` +
      `cp.spawnSync=function(){n++;return o.apply(this,arguments);};` +
      `const sp=require(${JSON.stringify(path.join(LIBDIR, "sibling-porcelain.js"))});` +
      `const t=Date.now();const r=sp.detectSiblingMutation(${JSON.stringify(REPO_ROOT)},${JSON.stringify(TARGET)});` +
      `process.stdout.write(JSON.stringify({ms:Date.now()-t,spawns:n,ok:r.ok,matches:r.matches.length}));`,
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
console.log(`\ndetectSiblingMutation end-to-end: ${probe.stdout}`);
console.log(
  `(pre-fix shape was 2N+3 spawns; shipped shape is N+3 with no match, N+3+m with m matches)`,
);
