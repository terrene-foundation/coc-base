#!/usr/bin/env node
/**
 * Audit fixtures for `.claude/bin/check-cli-emit-drift.mjs` (loom#1914).
 *
 * BIPOLAR BY CONSTRUCTION (`instrument-bipolarity.md` MUST-1/2). Every planted
 * defect here has a COMPLIANT twin, because a fixture set with only violating
 * poles is satisfied by a checker that reports everything, and a set with only
 * compliant poles is satisfied by one that reports nothing. Neither is a gate.
 *
 *   in-sync         must produce NO finding          (compliant pole)
 *   drifted         one file's bytes differ          -> DRIFTED, named
 *   missing         emitter writes it, tree lacks it -> MISSING, named
 *   orphan          stale file in an owned subdir    -> ORPHAN,  named
 *   hand-maintained config.toml / hooks.json /
 *                   settings.json present            must produce NO finding
 *
 * The last one is the pole that decides whether the gate SURVIVES rather than
 * whether it FIRES. `.codex/config.toml`, `.codex/hooks.json` and
 * `.gemini/settings.json` are copied by coc-sync Step 6.6 and are never emitted;
 * a checker that flags them is red on every commit forever, and a red-forever
 * check is the one an operator learns to ignore — after which a genuinely stale
 * tree reads exactly like every other day.
 *
 * ON-DISK, not synthesised in memory. The shipped `--selftest` already builds
 * its trees in a temp dir; these are committed files so a reviewer can SEE the
 * planted defect (one added line in `drifted/.codex/prompts/codify.md`, one
 * deleted file under `missing/`, one added file under `orphan/`) instead of
 * taking a generator's word for what it planted.
 *
 * Each assertion checks the finding's IDENTITY, never merely its count. "The
 * check returned non-zero" is not evidence the check found THIS defect — it is
 * consistent with the checker being broken in some unrelated way, which is the
 * failure `instrument-discipline.md` MUST-1 names.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareEmittedTree, selftest } from "../../bin/check-cli-emit-drift.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMITTED = path.join(HERE, "emitted");

let pass = 0;
let fail = 0;
const ok = (name) => {
  pass++;
  process.stdout.write(`  PASS  ${name}\n`);
};
const no = (name, detail) => {
  fail++;
  process.stderr.write(`  FAIL  ${name}\n        ${detail}\n`);
};
const assert = (name, cond, detail) => (cond ? ok(name) : no(name, detail));

const cmp = (pole) =>
  compareEmittedTree({
    emittedRoot: EMITTED,
    committedRoot: path.join(HERE, pole),
  });

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── CONTROL FIRST. Every assertion below reads a field off `compareEmittedTree`,
// so if the fixture root were mistyped every pole would report zero findings and
// the whole suite would go green on nothing. Establish that the reference tree
// is non-empty and owns the subdirs the poles depend on, BEFORE any verdict.
{
  const r = cmp("in-sync");
  assert(
    "control: reference emitted tree is non-empty and was actually read",
    r.comparedCount === 5,
    `expected 5 reference files, got ${r.comparedCount} — a suite comparing zero files ` +
      `passes every pole vacuously (fixture root: ${EMITTED})`,
  );
  assert(
    "control: owned subdirs are derived from the reference tree",
    eq(r.owned, [
      ".codex/prompts",
      ".codex/skills",
      ".gemini/agents",
      ".gemini/commands",
    ]),
    `owned set wrong: ${JSON.stringify(r.owned)}`,
  );
}

// ── COMPLIANT POLE: an in-sync tree.
{
  const r = cmp("in-sync");
  assert(
    "in-sync: an identical committed tree produces no finding",
    r.drifted.length === 0 && r.missing.length === 0 && r.extra.length === 0,
    `expected no findings, got ${JSON.stringify({ d: r.drifted, m: r.missing, x: r.extra })}`,
  );
}

// ── VIOLATING POLE: drift.
{
  const r = cmp("drifted");
  assert(
    "drifted: the altered file is reported, BY NAME",
    eq(r.drifted, [".codex/prompts/codify.md"]),
    `expected [".codex/prompts/codify.md"], got ${JSON.stringify(r.drifted)}`,
  );
  assert(
    "drifted: one planted defect yields one finding, with no splash",
    r.missing.length === 0 && r.extra.length === 0,
    `missing=${JSON.stringify(r.missing)} extra=${JSON.stringify(r.extra)}`,
  );
  assert(
    "drifted: the four untouched files are NOT reported",
    !r.drifted.includes(".codex/prompts/analyze.md") &&
      !r.drifted.includes(".gemini/agents/reviewer.md"),
    `clean files leaked into the drift list: ${JSON.stringify(r.drifted)}`,
  );
}

// ── VIOLATING POLE: an emitted file absent from the committed tree.
{
  const r = cmp("missing");
  assert(
    "missing: the absent file is reported, BY NAME",
    eq(r.missing, [".gemini/agents/reviewer.md"]),
    `expected [".gemini/agents/reviewer.md"], got ${JSON.stringify(r.missing)}`,
  );
  assert(
    "missing: an absent file is NOT miscounted as drift",
    r.drifted.length === 0,
    `a nonexistent file cannot differ in bytes; got ${JSON.stringify(r.drifted)}`,
  );
}

// ── VIOLATING POLE: a stale orphan inside an owned subdir.
{
  const r = cmp("orphan");
  assert(
    "orphan: the stale file in an owned subdir is reported, BY NAME",
    eq(r.extra, [".codex/prompts/maintain.md"]),
    `expected [".codex/prompts/maintain.md"], got ${JSON.stringify(r.extra)}`,
  );
  assert(
    "orphan: the five legitimately-emitted files are NOT reported",
    r.drifted.length === 0 && r.missing.length === 0,
    `drifted=${JSON.stringify(r.drifted)} missing=${JSON.stringify(r.missing)}`,
  );
}

// ── COMPLIANT POLE (the survival one): hand-maintained files.
{
  const r = cmp("hand-maintained");
  assert(
    "hand-maintained: coc-sync-owned files outside every owned subdir are NOT reported",
    r.drifted.length === 0 && r.missing.length === 0 && r.extra.length === 0,
    `config.toml / hooks.json / settings.json must not be flagged; got ${JSON.stringify({ d: r.drifted, m: r.missing, x: r.extra })}`,
  );
  // Without this, the pole above passes because the three files are ABSENT from
  // the fixture, not because the checker correctly skipped them — a fixture
  // asserting nothing about its own input. The clean verdict is only evidence
  // if the thing it is clean ABOUT is actually there.
  const handMaintained = [
    ".codex/config.toml",
    ".codex/hooks.json",
    ".gemini/settings.json",
  ];
  const present = handMaintained.filter((f) =>
    fs.existsSync(path.join(HERE, "hand-maintained", f)),
  );
  assert(
    "hand-maintained: those three files are genuinely PRESENT in the pole",
    present.length === 3,
    `the clean verdict above is vacuous unless the files exist; present: ${JSON.stringify(present)}`,
  );
  assert(
    "hand-maintained: none of the three sits in an emitter-owned subdir",
    handMaintained.every((f) => !r.owned.includes(f.split("/").slice(0, 2).join("/"))),
    `a hand-maintained file inside an owned subdir would be a genuine orphan; owned=${JSON.stringify(r.owned)}`,
  );
}

// ── The shipped negative control, re-run here so the registry step exercises it
// too. Its output lines are counted by the CI parser exactly like the ones above.
if (!selftest()) no("shipped --selftest negative control", "see failures above");
else ok("shipped --selftest negative control passes");

process.stdout.write(
  `\ncli-emit-drift fixtures: ${pass} pass, ${fail} fail\n`,
);
if (fail === 0) process.stdout.write("ALL PASS\n");
process.exit(fail === 0 ? 0 : 1);
