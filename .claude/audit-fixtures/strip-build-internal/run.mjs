#!/usr/bin/env node
// Audit fixtures for .claude/bin/lib/strip-build-internal.mjs.
//
// Per rules/cc-artifacts.md Rule 9, every mechanical audit tool MUST
// ship with at least one committed fixture per scope-restriction
// predicate. This runner exercises:
//   (a) the helper's built-in self-test (inline fixtures; count asserted
//       by the helper itself — see SELF_TEST_FIXTURES)
//   (b) external-file fixtures that real /sync emissions would hit,
//       so a future refactor that drops in-source fixtures still has
//       a separate audit trail on disk.
//
// Exits non-zero on any failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  stripBuildInternalReferences,
} from "../../bin/lib/strip-build-internal.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let failures = 0;
function check(name, cond, detail = "") {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. Run the helper's inline self-test as a sub-process to assert
//      the canonical pattern set still passes — failure here means
//      a code change broke one of the codified Phase-4 patterns.
import { spawnSync } from "node:child_process";
const helperPath = path.resolve(
  __dirname,
  "..",
  "..",
  "bin",
  "lib",
  "strip-build-internal.mjs",
);
const selftest = spawnSync("node", [helperPath, "--selftest"], {
  encoding: "utf8",
});
check(
  "helper --selftest exits 0",
  selftest.status === 0,
  selftest.stdout.trim(),
);

// ── 2. External-file fixtures: each fixture-NN-<name>.md has a
//      sibling .expected file containing the post-strip content.
const fixturesDir = __dirname;
const inputs = fs
  .readdirSync(fixturesDir)
  .filter((f) => /^fixture-\d{2}-.*\.md$/.test(f))
  .sort();

for (const fn of inputs) {
  const inputPath = path.join(fixturesDir, fn);
  const expectedPath = inputPath.replace(/\.md$/, ".expected");
  if (!fs.existsSync(expectedPath)) {
    check(`fixture ${fn} has .expected sibling`, false);
    continue;
  }
  const input = fs.readFileSync(inputPath, "utf8");
  const expected = fs.readFileSync(expectedPath, "utf8");
  const { stripped } = stripBuildInternalReferences(input);
  check(`fixture ${fn}`, stripped === expected, stripped === expected ? "" : `mismatch (len in=${input.length} expected=${expected.length} actual=${stripped.length})`);
}

// ── 3. Idempotence check: running the strip twice on a real source
//      file produces the same result as running it once. This is the
//      structural invariant that makes the helper safe to wire into
//      composeArtifactBody without worrying about double-emission.
const sampleSource = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "agents", "management", "coc-sync.md"),
  "utf8",
);
const once = stripBuildInternalReferences(sampleSource).stripped;
const twice = stripBuildInternalReferences(once).stripped;
check("idempotent on coc-sync.md", once === twice);

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
