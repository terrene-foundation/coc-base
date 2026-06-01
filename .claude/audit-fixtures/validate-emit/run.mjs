#!/usr/bin/env node
/*
 * Audit fixture runner for validate-emit (F30, issue #350 Stage 2).
 *
 * Structural probes per rules/probe-driven-verification.md MUST-3:
 *   - exit-code / count-of-elements / equality checks on pure-function outputs.
 *   - NO semantic judgment, NO regex on assistant prose.
 *
 * One fixture per scope-restriction predicate per cc-artifacts.md Rule 9 +
 * hook-output-discipline.md MUST-4. Synthetic input is built into temp dirs
 * (mkdtempSync) so the validator's check functions exercise real I/O without
 * touching the live repo.
 *
 * Exit 0 = all fixtures pass. Exit 1 = ≥1 fixture failed.
 */

import {
  parseFrontmatter,
  parseToolList,
  matchesGlob,
  parseReadonlySpecialists,
  parseEmitExclusions,
  enumerateDetectors,
  classifyFixtures,
  checkCommandFrontmatter,
  checkCommandLineCap,
  checkReadonlySpecialistTools,
  checkToolCanonicality,
  checkAuditFixtureCoverage,
  STATUS,
} from "../../bin/validate-emit.mjs";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0;
let failed = 0;

function check(name, condition, details) {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL  ${name}\n`);
    if (details) process.stderr.write(`        ${details}\n`);
  }
}

// Build a synthetic loom-like fixture root with the minimum subdirs and files
// the check functions touch. Returns the dir path; caller MUST rmSync.
function buildFixtureRoot(spec) {
  const root = mkdtempSync(join(tmpdir(), "validate-emit-fx-"));
  for (const [rel, content] of Object.entries(spec)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function statusOf(check, artifactSubstr) {
  const r = check.results.find((x) => x.artifact.includes(artifactSubstr));
  return r ? r.status : null;
}

// ----------------------------------------------------------------------
// fixture-01 — parseFrontmatter
// ----------------------------------------------------------------------
{
  const ok = parseFrontmatter("---\nname: foo\ntools: Read, Edit\n---\nbody\n");
  const unterm = parseFrontmatter("---\nname: foo\n(no closing)\nbody");
  const none = parseFrontmatter("# H1 only\nno frontmatter");
  check(
    "fixture-01-parseFrontmatter",
    ok.hasFrontmatter === true &&
      ok.fields.name === "foo" &&
      ok.fields.tools === "Read, Edit" &&
      ok.body.trim() === "body" &&
      unterm.unterminated === true &&
      none.hasFrontmatter === false,
    `ok=${JSON.stringify(ok.fields)} unterm.unterminated=${unterm.unterminated} none.hasFM=${none.hasFrontmatter}`,
  );
}

// ----------------------------------------------------------------------
// fixture-02 — parseToolList
// ----------------------------------------------------------------------
{
  const a = parseToolList("Read, Edit, Bash");
  const b = parseToolList(["Read", "Edit", "Bash"]);
  const c = parseToolList(undefined);
  check(
    "fixture-02-parseToolList",
    a.length === 3 && a[0] === "Read" && a[2] === "Bash" &&
      b.length === 3 && b[1] === "Edit" &&
      c.length === 0,
    `a=${JSON.stringify(a)} b=${JSON.stringify(b)} c=${JSON.stringify(c)}`,
  );
}

// ----------------------------------------------------------------------
// fixture-03 — matchesGlob (exact + /** prefix)
// ----------------------------------------------------------------------
{
  check(
    "fixture-03-matchesGlob",
    matchesGlob("agents/cc-architect.md", "agents/cc-architect.md") === true &&
      matchesGlob("skills/foo/SKILL.md", "skills/foo/**") === true &&
      matchesGlob("skills/foo", "skills/foo/**") === true &&
      matchesGlob("skills/bar/SKILL.md", "skills/foo/**") === false &&
      matchesGlob("commands/other.md", "commands/cc-audit.md") === false,
  );
}

// ----------------------------------------------------------------------
// fixture-04 — check 1 command-frontmatter (flag + clean + exempt-list shape)
// ----------------------------------------------------------------------
{
  const root = buildFixtureRoot({
    ".claude/commands/good.md": "---\nname: good\n---\nbody\n",
    ".claude/commands/bad.md": "# /bad - H1 only\n\nno frontmatter\n",
  });
  try {
    const c = checkCommandFrontmatter(root);
    check(
      "fixture-04-check-1-flag-and-clean",
      statusOf(c, "good.md") === STATUS.PASS &&
        statusOf(c, "bad.md") === STATUS.FAIL,
      JSON.stringify(c.results),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-05 — check 2 command-line-cap (counts body AFTER frontmatter)
// ----------------------------------------------------------------------
{
  const fm = "---\nname: x\ndescription: y\n---\n";
  const okBody = Array(150).fill("line").join("\n");      // 150 lines, at cap
  const overBody = Array(160).fill("line").join("\n");    // 160 lines, over
  const root = buildFixtureRoot({
    ".claude/commands/ok.md": fm + okBody + "\n",
    ".claude/commands/over.md": fm + overBody + "\n",
  });
  try {
    const c = checkCommandLineCap(root);
    check(
      "fixture-05-check-2-body-counts-post-frontmatter",
      statusOf(c, "ok.md") === STATUS.PASS &&
        statusOf(c, "over.md") === STATUS.FAIL,
      JSON.stringify(c.results),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-06 — check 3 read-only specialist tools
// ----------------------------------------------------------------------
{
  const agentsRule = "Read-only specialists (`clean-agent`, `dirty-agent`) MUST NOT be delegated implementation tasks.\n";
  const root = buildFixtureRoot({
    ".claude/rules/agents.md": agentsRule,
    ".claude/agents/clean-agent.md": "---\nname: clean-agent\ntools: Read, Grep, Glob\n---\nbody\n",
    ".claude/agents/dirty-agent.md": "---\nname: dirty-agent\ntools: Read, Write, Edit, Bash\n---\nbody\n",
  });
  try {
    const c = checkReadonlySpecialistTools(root);
    check(
      "fixture-06-check-3-readonly-flag-and-clean",
      statusOf(c, "clean-agent") === STATUS.PASS &&
        statusOf(c, "dirty-agent") === STATUS.FAIL,
      JSON.stringify(c.results),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-07 — check 4 tool canonicality
// ----------------------------------------------------------------------
{
  const root = buildFixtureRoot({
    ".claude/agents/ok-agent.md": "---\nname: ok-agent\ntools: Read, Bash, Grep, Glob\n---\nbody\n",
    ".claude/agents/ls-agent.md": "---\nname: ls-agent\ntools: Read, Glob, Grep, LS\n---\nbody\n",
  });
  try {
    const c = checkToolCanonicality(root);
    check(
      "fixture-07-check-4-tool-canonicality",
      statusOf(c, "ok-agent") === STATUS.PASS &&
        statusOf(c, "ls-agent") === STATUS.FAIL,
      JSON.stringify(c.results),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-08 — check 7 audit-fixture coverage (fixture-needed vs pass)
// ----------------------------------------------------------------------
{
  const vp = `module.exports = { detectFoo, detectBar };\nfunction detectFoo(){}\nfunction detectBar(){}\n`;
  const root = buildFixtureRoot({
    ".claude/hooks/lib/violation-patterns.js": vp,
    // detectFoo: has flag + clean
    ".claude/audit-fixtures/violation-patterns/detectFoo/flag-fire.txt": "x",
    ".claude/audit-fixtures/violation-patterns/detectFoo/clean-quiet.txt": "x",
    // detectBar: missing fixture dir entirely
  });
  try {
    const c = checkAuditFixtureCoverage(root);
    check(
      "fixture-08-check-7-coverage-flag-vs-clean",
      statusOf(c, "detectFoo") === STATUS.PASS &&
        statusOf(c, "detectBar") === STATUS.FIXTURE_NEEDED,
      JSON.stringify(c.results),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-09 — parseReadonlySpecialists
// ----------------------------------------------------------------------
{
  const root = buildFixtureRoot({
    ".claude/rules/agents.md":
      "Read-only specialists (`security-reviewer`, `analyst`, `reviewer`) MUST NOT be delegated implementation tasks.\n",
  });
  try {
    const names = parseReadonlySpecialists(root);
    check(
      "fixture-09-parseReadonlySpecialists",
      Array.isArray(names) &&
        names.length === 3 &&
        names.includes("security-reviewer") &&
        names.includes("analyst") &&
        names.includes("reviewer"),
      JSON.stringify(names),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-10 — parseEmitExclusions (sub-block under top-level YAML key)
// ----------------------------------------------------------------------
{
  const manifest = `other_key: value
cli_emit_exclusions:
  codex:
    - skills/aaa/**
    - agents/bbb.md
  gemini:
    - skills/ccc/**
next_top_level: foo
`;
  const root = buildFixtureRoot({ ".claude/sync-manifest.yaml": manifest });
  try {
    const ex = parseEmitExclusions(root);
    check(
      "fixture-10-parseEmitExclusions",
      ex &&
        Array.isArray(ex.codex) && ex.codex.length === 2 &&
        ex.codex[0] === "skills/aaa/**" && ex.codex[1] === "agents/bbb.md" &&
        Array.isArray(ex.gemini) && ex.gemini.length === 1 &&
        ex.gemini[0] === "skills/ccc/**",
      JSON.stringify(ex),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-11 — classifyFixtures naming convention
// ----------------------------------------------------------------------
{
  const root = buildFixtureRoot({
    "fx/flag-one.txt": "x",
    "fx/clean-one.txt": "x",
    "fx/flag-two.txt": "x",
    "fx/whatever.expected": "x", // sidecar — should be ignored
  });
  try {
    const c = classifyFixtures(join(root, "fx"));
    check(
      "fixture-11-classifyFixtures",
      c && c.flag === 2 && c.clean === 1,
      JSON.stringify(c),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-12 — check 6 multi-rule-per-row (reviewer R1 #1 regression-lock)
// ----------------------------------------------------------------------
// A Rules-Index row that names TWO rules with one shared `**/*.rs` glob —
// previously `.match` returned only the first ruleRef and silently skipped
// the second. matchAll now visits both.
{
  const indexRow = "| concern | `rules/a.md` and `rules/b.md` | `**/*.rs` | CO |\n";
  const root = buildFixtureRoot({
    "CLAUDE.md": indexRow,
    ".claude/rules/a.md": "---\npriority: 10\nscope: path-scoped\npaths:\n  - \"**/*.rs\"\n---\nbody\n",
    ".claude/rules/b.md": "---\npriority: 10\nscope: path-scoped\npaths:\n  - \"**/*.py\"\n---\nbody\n",
  });
  try {
    const { checkPathsAnnotationConsistency } = await import("../../bin/validate-emit.mjs");
    const c = checkPathsAnnotationConsistency(root);
    // a.md has rs in paths → PASS; b.md lacks rs but is annotated → FAIL.
    // Both must be present in the result set (the bug was that b was silently dropped).
    const aRes = c.results.find((r) => r.artifact.endsWith("a.md"));
    const bRes = c.results.find((r) => r.artifact.endsWith("b.md"));
    check(
      "fixture-12-check-6-multi-rule-per-row",
      aRes && aRes.status === STATUS.PASS &&
        bRes && bRes.status === STATUS.FAIL,
      `aRes=${JSON.stringify(aRes)} bRes=${JSON.stringify(bRes)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-13 — classifyFixtures strict prefix (reviewer R1 #2 regression-lock)
// ----------------------------------------------------------------------
// Under the strict prefix rule, only the FIRST segment is significant. The
// regression we're guarding against is the OLD broad regex classifying
// `clean-flag-X.txt` as flag (because `-flag` matched the flag pattern's
// `(^|[-_.])flag` anchor). Strict `^flag-` makes the first segment decide.
{
  const root = buildFixtureRoot({
    "fx/clean-flag-suppression.txt": "x", // starts with `clean-` → CLEAN (strict prefix)
    "fx/safe-foo.txt": "x",               // legacy broad-match would have counted as clean — must NOT
    "fx/flag-real.txt": "x",              // strict prefix → flag
    "fx/clean-real.txt": "x",             // strict prefix → clean
  });
  try {
    const { classifyFixtures } = await import("../../bin/validate-emit.mjs");
    const c = classifyFixtures(join(root, "fx"));
    // Expected post-fix: flag=1 (flag-real), clean=2 (clean-flag-suppression + clean-real).
    // safe-foo MUST be neither (the old broad regex would have counted it as clean).
    check(
      "fixture-13-classifyFixtures-strict-prefix",
      c && c.flag === 1 && c.clean === 2,
      JSON.stringify(c),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-14 — check 1 fails on unterminated frontmatter (reviewer R1 #4)
// ----------------------------------------------------------------------
// A command with an unclosed `---` block previously passed check 1 (because
// the first line WAS `---`) but parseFrontmatter would consume the entire
// body as frontmatter. check 1 now fails it explicitly.
{
  const root = buildFixtureRoot({
    ".claude/commands/unterm.md": "---\nname: unterm\n(no closing dashes)\n\nbody never starts\n",
  });
  try {
    const { checkCommandFrontmatter } = await import("../../bin/validate-emit.mjs");
    const c = checkCommandFrontmatter(root);
    check(
      "fixture-14-check-1-unterminated-frontmatter-fails",
      statusOf(c, "unterm.md") === STATUS.FAIL,
      JSON.stringify(c.results),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------
process.stdout.write(
  `\nvalidate-emit audit fixtures: ${passed} passed, ${failed} failed\n`,
);
process.exit(failed > 0 ? 1 : 0);
