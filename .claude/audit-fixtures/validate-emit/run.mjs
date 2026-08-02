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
  checkClaudeMdSurfaceRoleParity,
  checkHookEventDeclaration,
  parseHookEventMarkers,
  isMissingOwnSpecifier,
  STATUS,
} from "../../bin/validate-emit.mjs";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

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
// fixture-15 — check 13 helper: validateGeminiCommandToml parse-load (#408 AC#7)
// ----------------------------------------------------------------------
// The Gemini-command TOML loader closes a '''…''' literal at the FIRST ''' after
// the opener; an unescaped ''' in the prompt body closes early and turns the
// trailing markdown into invalid TOML (the tomlLiteralEscape escape-bug class).
// Clean shape → no errors; premature-close shape → flagged.
{
  const { validateGeminiCommandToml } = await import("../../bin/validate-emit.mjs");
  const good = `name = "demo"\ndescription = "A demo."\nprompt = '''\nbody \`x\` "q"\n'''\ntools = ["read_file"]\n`;
  const bad = `name = "demo"\ndescription = "A demo."\nprompt = '''\nbody ''' early close\nprose\n'''\ntools = []\n`;
  const goodErrs = validateGeminiCommandToml(good);
  const badErrs = validateGeminiCommandToml(bad);
  check(
    "fixture-15-validateGeminiCommandToml-parse-load",
    goodErrs.length === 0 && badErrs.some((e) => /early|embedded/.test(e)),
    `good=${JSON.stringify(goodErrs)} bad=${JSON.stringify(badErrs)}`,
  );
}

// ----------------------------------------------------------------------
// fixture-16 — check 13 helper: extractRulesIndexCitations (#408 AC#7)
// ----------------------------------------------------------------------
// The rules-reference index's delivery integrity rests on every cited
// `.claude/rules/<file>.md` resolving to a real source file; the extractor must
// surface EVERY citation (matchAll, not just the first) so no dangling row hides.
{
  const { extractRulesIndexCitations } = await import("../../bin/validate-emit.mjs");
  const text =
    "| A | g | `.claude/rules/a.md` |\n| B | g | `.claude/rules/b-c.md` |\n| C | g | `.claude/rules/d.md` |\n";
  const cites = extractRulesIndexCitations(text);
  check(
    "fixture-16-extractRulesIndexCitations-all-rows",
    cites.length === 3 &&
      cites[0] === "a.md" &&
      cites[2] === "d.md" &&
      extractRulesIndexCitations("# none\n").length === 0,
    JSON.stringify(cites),
  );
}

// ----------------------------------------------------------------------
// fixture-17 — check 14 helper: canonicalPolicies (DF-AC6-2 / #408)
// ----------------------------------------------------------------------
// The codex-policies-fresh guard compares the committed policies.json against a
// fresh extraction order-insensitively. canonicalPolicies must (a) treat
// tool-key / entry / matcher-array order as equivalent, and (b) detect a
// dropped entry (the actual DF-AC6-2 drift: gates missing from the stale file).
{
  const { canonicalPolicies } = await import("../../bin/validate-emit.mjs");
  const a = {
    shell: [
      { source_file: "b.js", cc_matchers: ["Bash"], invocation: "subprocess" },
      { source_file: "a.js", cc_matchers: ["Edit", "Write"], invocation: "subprocess" },
    ],
  };
  const aReordered = {
    shell: [
      { source_file: "a.js", cc_matchers: ["Write", "Edit"], invocation: "subprocess" },
      { source_file: "b.js", cc_matchers: ["Bash"], invocation: "subprocess" },
    ],
  };
  const dropped = { shell: [{ source_file: "a.js", cc_matchers: ["Edit", "Write"], invocation: "subprocess" }] };
  check(
    "fixture-17-canonicalPolicies-order-insensitive-and-drop-detecting",
    canonicalPolicies(a) === canonicalPolicies(aReordered) &&
      canonicalPolicies(a) !== canonicalPolicies(dropped),
    `eq=${canonicalPolicies(a) === canonicalPolicies(aReordered)} drop=${canonicalPolicies(a) !== canonicalPolicies(dropped)}`,
  );
}

// ----------------------------------------------------------------------
// fixture-18 — parseVariantsBlock (overlays + null cells; todo 16 / check 15)
// ----------------------------------------------------------------------
// The `variants:` REPLACEMENT block parses into the non-null overlay path VALUES
// (arm 1 source) AND the explicit <key>×<lang> null cells (arm 4 source). A
// trailing top-level key terminates the block; comment lines are skipped.
{
  const manifest = `other_top: x
variants:
  rules/patterns.md:
    py: null
    rs: variants/rs/rules/patterns.md
  rules/agents.md:
    py: null
    # rs comment line — must be skipped
    rs: null
  skills/01-core-sdk/SKILL.md:
    py: variants/py/skills/01-core-sdk/SKILL.md
variant_only:
  py:
    - variants/py/scripts/migrate.py
`;
  const root = buildFixtureRoot({ ".claude/sync-manifest.yaml": manifest });
  try {
    const { parseVariantsBlock } = await import("../../bin/validate-emit.mjs");
    const b = parseVariantsBlock(root);
    const nullKeys = new Set(b.nullCells.map((c) => `${c.lang}:${c.key}`));
    check(
      "fixture-18-parseVariantsBlock-overlays-and-nullcells",
      b &&
        b.overlays.has("variants/rs/rules/patterns.md") &&
        b.overlays.has("variants/py/skills/01-core-sdk/SKILL.md") &&
        b.overlays.size === 2 && // the variant_only path is NOT swept in
        nullKeys.has("py:rules/patterns.md") &&
        nullKeys.has("py:rules/agents.md") &&
        nullKeys.has("rs:rules/agents.md") &&
        b.nullCells.length === 3,
      `overlays=${[...b.overlays]} nullCells=${JSON.stringify(b.nullCells)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-19 — parseVariantOnlyAll (flat path set across langs; todo 16)
// ----------------------------------------------------------------------
// The `variant_only:` ADDITION block parses into a flat Set of every declared
// path across every lang. This is the SECOND declaration lane the allowlist MUST
// union — a `variants:`-only reading is the ~200-false-orphan client symptom.
{
  const manifest = `variant_only:
  py:
    - variants/py/agents/frameworks/infrastructure-specialist.md
    - variants/py/scripts/migrate.py
  rs:
    - variants/rs/agents/ffi-specialist.md
    # comment — skipped
    - variants/rs/rules/release.md
obsoleted:
  - something/else.md
`;
  const root = buildFixtureRoot({ ".claude/sync-manifest.yaml": manifest });
  try {
    const { parseVariantOnlyAll } = await import("../../bin/validate-emit.mjs");
    const s = parseVariantOnlyAll(root);
    check(
      "fixture-19-parseVariantOnlyAll-flat-set",
      s &&
        s.size === 4 &&
        s.has("variants/py/scripts/migrate.py") &&
        s.has("variants/rs/agents/ffi-specialist.md") &&
        s.has("variants/rs/rules/release.md") &&
        !s.has("something/else.md"), // the next top-level block is NOT swept in
      JSON.stringify([...s]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-20 — classifyVariantFile: one CLEAN per allowlist arm + one ORPHAN
// ----------------------------------------------------------------------
// The pure classifier is the testable core of check 15 (the git-ls-files IO is
// the thin wrapper). One clean case per arm proves allowlist-arm completeness
// (no convention tree mis-flagged); the orphan case proves the FAIL teeth.
{
  const { classifyVariantFile } = await import("../../bin/validate-emit.mjs");
  const ctx = {
    overlays: new Set(["variants/py/skills/01-core-sdk/SKILL.md"]),
    variantOnly: new Set(["variants/py/scripts/migrate.py"]),
    // a null phantom NOT under a convention tree, so it ISOLATES arm 4
    // (a phantom under variants/<lang>/rules/ would ALSO match arm 3).
    nullPhantoms: new Set(["variants/py/skills/02-dataflow/SKILL.md"]),
  };
  const arm = (p) => classifyVariantFile(p, ctx);
  const a1 = arm("variants/py/skills/01-core-sdk/SKILL.md");   // arm 1 variants-overlay
  const a2 = arm("variants/py/scripts/migrate.py");            // arm 2 variant-only
  const a3r = arm("variants/codex/rules/agents.md");           // arm 3 convention-rule (CLI axis)
  const a3t = arm("variants/py-codex/rules/worktree-isolation.md"); // arm 3 ternary axis
  const a3w = arm("variants/codex/wrappers/foo.md");           // arm 3 convention-wrapper
  const a4 = arm("variants/py/skills/02-dataflow/SKILL.md");   // arm 4 null-ack (isolated)
  const a5r = arm("variants/README.md");                       // arm 5 README
  const a5e = arm("variants/rs/rules/ci-runners.operator.local.example.md"); // arm 5 .example.
  const orphan = arm("variants/py/skills/project/leftover.md"); // NO arm → orphan
  const badAxis = arm("variants/pyy/rules/typo.md");           // unknown axis → orphan (not mis-flagged)
  const wrapNonCli = arm("variants/py/wrappers/foo.md");       // wrappers only valid for a CLI axis → orphan
  check(
    "fixture-20-classifyVariantFile-one-clean-per-arm-plus-orphan",
    a1.ok && a1.arm === "variants-overlay" &&
      a2.ok && a2.arm === "variant-only" &&
      a3r.ok && a3r.arm === "convention-rule" &&
      a3t.ok && a3t.arm === "convention-rule" &&
      a3w.ok && a3w.arm === "convention-wrapper" &&
      a4.ok && a4.arm === "null-ack" &&
      a5r.ok && a5r.arm === "readme-or-example" &&
      a5e.ok && a5e.arm === "readme-or-example" &&
      !orphan.ok && orphan.arm === "orphan" &&
      !badAxis.ok && // an unknown axis is NOT mis-allowlisted by arm 3
      !wrapNonCli.ok, // wrappers under a non-CLI axis are NOT allowlisted
    `a1=${JSON.stringify(a1)} a3t=${JSON.stringify(a3t)} a4=${JSON.stringify(a4)} orphan=${JSON.stringify(orphan)} badAxis=${JSON.stringify(badAxis)} wrapNonCli=${JSON.stringify(wrapNonCli)}`,
  );
}

// ----------------------------------------------------------------------
// fixture-21 — checkVariantOrphan end-to-end over a synthetic git tree (todo 16)
// ----------------------------------------------------------------------
// The check enumerates via `git ls-files` (untracked operator-local companions
// out of scope). A planted orphan → FAIL; a planted-but-UNTRACKED leftover is
// NOT flagged (git-tracked enumeration); a declared file → PASS.
{
  const { execFileSync } = await import("node:child_process");
  const { checkVariantOrphan, STATUS: ST } = await import("../../bin/validate-emit.mjs");
  const manifest = `variants:
  skills/01-core-sdk/SKILL.md:
    py: variants/py/skills/01-core-sdk/SKILL.md
variant_only:
  py:
    - variants/py/scripts/migrate.py
`;
  const root = buildFixtureRoot({
    ".claude/sync-manifest.yaml": manifest,
    ".claude/variants/py/skills/01-core-sdk/SKILL.md": "declared overlay\n",
    ".claude/variants/py/scripts/migrate.py": "# variant_only\n",
    ".claude/variants/codex/rules/agents.md": "# convention tree\n",
    ".claude/variants/py/skills/project/leftover.md": "ORPHAN — no allowlist arm\n",
  });
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    // Track everything EXCEPT an untracked operator-local companion we add after.
    execFileSync("git", ["add", "-A"], { cwd: root });
    // An untracked operator-local file must be invisible to the check.
    mkdirSync(join(root, ".claude/variants/py/rules"), { recursive: true });
    writeFileSync(join(root, ".claude/variants/py/rules/foo.operator.local.md"), "untracked\n");
    const c = checkVariantOrphan(root);
    const orphan = c.results.find((r) => r.artifact === "variants/py/skills/project/leftover.md");
    const declared = c.results.find((r) => r.artifact === "variants/py/skills/01-core-sdk/SKILL.md");
    const untrackedSeen = c.results.find((r) => r.artifact.includes("operator.local"));
    check(
      "fixture-21-checkVariantOrphan-git-tracked-enumeration",
      orphan && orphan.status === ST.FAIL &&
        declared && declared.status === ST.PASS &&
        !untrackedSeen, // untracked operator-local companion is OUT of scope
      JSON.stringify(c.results),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-22 — parseSurfaceRoles: KEYED path→roles[] map (W2-b invariant #4)
// ----------------------------------------------------------------------
// The parser reuses parseLoomOnly's line-state-machine IDIOM but returns a KEYED
// Map (NOT a flat string[]). Inline `# comment` lines + a trailing top-level key
// terminate cleanly; comment-only lines are skipped.
{
  const manifest = `other_top: x
surface_roles:
  commands/analyze.md: [build, use-consumer]
  commands/foo.md: [platform]
  # comment line — skipped
next_top: y
`;
  const root = buildFixtureRoot({ ".claude/sync-manifest.yaml": manifest });
  try {
    const { parseSurfaceRoles } = await import("../../bin/validate-emit.mjs");
    const m = parseSurfaceRoles(root);
    check(
      "fixture-22-parseSurfaceRoles-keyed-map",
      m instanceof Map &&
        m.size === 2 &&
        JSON.stringify(m.get("commands/analyze.md")) ===
          JSON.stringify(["build", "use-consumer"]) &&
        JSON.stringify(m.get("commands/foo.md")) === JSON.stringify(["platform"]),
      JSON.stringify([...m]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-23 — checkSurfaceRoleMembership per-artifact predicates (W2-b)
// ----------------------------------------------------------------------
// PASS: valid roles + on-disk + ALSO tier-listed (orthogonality, invariant #1 —
// a near-copy of the loom_only mutual-exclusion check would WRONGLY fail this).
// SKIP(WARN): zero on-disk match. FAIL: out-of-enum role. FAIL: empty role list.
{
  const { checkSurfaceRoleMembership } = await import("../../bin/validate-emit.mjs");
  const manifest = `tiers:
  coc:
    - commands/redteam.md
surface_roles:
  commands/redteam.md: [build, use-consumer]
  commands/ghost.md: [build]
  commands/bad.md: [bogus]
  commands/empty.md: []
`;
  const root = buildFixtureRoot({
    ".claude/sync-manifest.yaml": manifest,
    ".claude/commands/redteam.md": "x\n", // exists AND tier-listed → orthogonality PASS
    ".claude/commands/bad.md": "x\n", // exists, out-of-enum role → FAIL
    ".claude/commands/empty.md": "x\n", // exists, empty role list → FAIL
    // commands/ghost.md intentionally NOT created → zero-match SKIP(WARN)
  });
  try {
    const c = checkSurfaceRoleMembership(root);
    check(
      "fixture-23-checkSurfaceRoleMembership-predicates",
      statusOf(c, "commands/redteam.md") === STATUS.PASS &&
        statusOf(c, "commands/ghost.md") === STATUS.SKIP &&
        statusOf(c, "commands/bad.md") === STATUS.FAIL &&
        statusOf(c, "commands/empty.md") === STATUS.FAIL,
      JSON.stringify(c.results),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-24 — parseReposRoles + per-target role validation (W2b-5)
// ----------------------------------------------------------------------
// A target's `role:` child is collected; a target with NO role: is OMITTED
// (absent = full emission, invariant #7 back-compat). Valid role → PASS,
// out-of-enum → FAIL.
{
  const { parseReposRoles, checkSurfaceRoleMembership } = await import(
    "../../bin/validate-emit.mjs"
  );
  const manifest = `repos:
  base:
    build: null
    role: use-consumer
    variant: base
  py:
    build: kailash-py
    variant: py
  bad:
    role: bogus
next_top: x
`;
  const root = buildFixtureRoot({ ".claude/sync-manifest.yaml": manifest });
  try {
    const rr = parseReposRoles(root);
    const c = checkSurfaceRoleMembership(root);
    check(
      "fixture-24-parseReposRoles-and-per-target-validation",
      rr instanceof Map &&
        rr.get("base") === "use-consumer" &&
        rr.get("bad") === "bogus" &&
        !rr.has("py") && // declares no role → NOT included (back-compat)
        statusOf(c, "repos.base.role") === STATUS.PASS &&
        statusOf(c, "repos.bad.role") === STATUS.FAIL,
      `rr=${JSON.stringify([...rr])} results=${JSON.stringify(c.results)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture — claude-md-surface-role-parity (journal/0357; W6 G2 closure)
// one case per scope-restriction predicate (cc-artifacts.md Rule 9):
// consistent-PASS / manifestAssignsDocOmits-FAIL / docClaimsManifestMissing-FAIL
// / universalWithEntry-FAIL / sourceUnreadable-SKIP
// ----------------------------------------------------------------------
{
  const MF = (entries) => "surface_roles:\n" + entries + "\n";
  const DESURF = (cmds) =>
    `- **Utility — de-surfaced at the platform role:** ${cmds.map((c) => "`/" + c + "`").join(", ")}\n`;
  const UNIV = (cmds) =>
    `- **Universal — default-surfaced for every role (incl. platform):** ${cmds.map((c) => "`/" + c + "`").join(", ")}\n`;
  const hasFail = (c, artifact) =>
    c.results.some((r) => r.artifact === artifact && r.status === STATUS.FAIL);

  // (a) consistent → PASS
  {
    const root = buildFixtureRoot({
      ".claude/sync-manifest.yaml": MF("  commands/sdk.md: [build, use-consumer]"),
      "CLAUDE.md": DESURF(["sdk"]),
    });
    try {
      const c = checkClaudeMdSurfaceRoleParity(root);
      check(
        "fixture-claudeMdParity-a-consistent-PASS",
        c.results.length === 1 && c.results[0].status === STATUS.PASS,
        `results=${JSON.stringify(c.results)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // (b) manifest assigns, doc omits → FAIL (the W6 G2 case)
  {
    const root = buildFixtureRoot({
      ".claude/sync-manifest.yaml": MF(
        "  commands/sdk.md: [build, use-consumer]\n  commands/db.md: [build, use-consumer]",
      ),
      "CLAUDE.md": DESURF(["db"]), // omits /sdk
    });
    try {
      const c = checkClaudeMdSurfaceRoleParity(root);
      check(
        "fixture-claudeMdParity-b-manifestAssignsDocOmits-FAIL",
        hasFail(c, "CLAUDE.md:/sdk"),
        `results=${JSON.stringify(c.results)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // (c) doc claims, manifest missing → FAIL (the reverse direction)
  {
    const root = buildFixtureRoot({
      ".claude/sync-manifest.yaml": MF("  commands/db.md: [build, use-consumer]"),
      "CLAUDE.md": DESURF(["db", "sdk"]), // /sdk has no manifest entry
    });
    try {
      const c = checkClaudeMdSurfaceRoleParity(root);
      check(
        "fixture-claudeMdParity-c-docClaimsManifestMissing-FAIL",
        hasFail(c, "sync-manifest.yaml:/sdk"),
        `results=${JSON.stringify(c.results)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // (d) doc lists a command as universal that the manifest de-surfaces → FAIL
  // (isolates predicate 2: /start is in BOTH the doc de-surfaced + universal
  // bullets so set-equality (1) passes; only the disjointness check (2) fires)
  {
    const root = buildFixtureRoot({
      ".claude/sync-manifest.yaml": MF("  commands/start.md: [build, use-consumer]"),
      "CLAUDE.md": DESURF(["start"]) + UNIV(["start"]),
    });
    try {
      const c = checkClaudeMdSurfaceRoleParity(root);
      check(
        "fixture-claudeMdParity-d-universalWithEntry-FAIL",
        c.results.some(
          (r) =>
            r.artifact === "CLAUDE.md:/start" &&
            r.status === STATUS.FAIL &&
            /universal/i.test(r.detail),
        ),
        `results=${JSON.stringify(c.results)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // (e) source unreadable (no CLAUDE.md) → SKIP, never silent PASS
  {
    const root = buildFixtureRoot({
      ".claude/sync-manifest.yaml": MF("  commands/sdk.md: [build, use-consumer]"),
    });
    try {
      const c = checkClaudeMdSurfaceRoleParity(root);
      check(
        "fixture-claudeMdParity-e-sourceUnreadable-SKIP",
        c.results.length === 1 && c.results[0].status === STATUS.SKIP,
        `results=${JSON.stringify(c.results)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

// ----------------------------------------------------------------------
// fixture-hookEvent-* — checkHookEventDeclaration (hook-event-selection.md)
//
// One fixture per scope-restriction predicate per cc-artifacts.md Rule 9. TWO of
// them are NO-FALSE-POSITIVE CONTROLS and are the load-bearing pair: a rule that
// condemned every SessionStart hook, or every `*` matcher, would be WRONG — a
// session banner belongs at SessionStart and a heartbeat belongs on every tool
// call. `-control-lifecycleAtSessionStart-PASS` and `-control-telemetryStar-PASS`
// are what force the check to discriminate rather than blanket-flag, so a future
// "tighten the detector" edit that drops the class distinction reds here.
// ----------------------------------------------------------------------
{
  const CMD = (n) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${n}"`;
  // Build a settings.json registering each hook at its given (event, matcher).
  // `regs` = [{ name, event, matcher }]; matcher undefined = an event with no
  // tool axis (SessionStart, Stop, …).
  const settingsFor = (regs) => {
    const hooks = {};
    for (const r of regs) {
      hooks[r.event] = hooks[r.event] || [];
      let g = hooks[r.event].find((x) => x.matcher === r.matcher);
      if (!g) {
        g = r.matcher === undefined ? { hooks: [] } : { matcher: r.matcher, hooks: [] };
        hooks[r.event].push(g);
      }
      g.hooks.push({ type: "command", command: r.command ?? CMD(r.name) });
    }
    return JSON.stringify({ hooks }, null, 2);
  };
  // One synthetic repo: hook sources keyed by basename + the registrations.
  // `gf` (optional) = basenames to write into .claude/hook-event-grandfather.json.
  // Omitted => no snapshot on disk => loadHookEventGrandfather fails CLOSED to an
  // empty set, which is what every pre-existing fixture below relies on.
  const hookRoot = (sources, regs, gf) =>
    buildFixtureRoot({
      ".claude/settings.json": settingsFor(regs),
      ...(gf ? { ".claude/hook-event-grandfather.json": JSON.stringify({ grandfathered: gf }, null, 2) } : {}),
      ...Object.fromEntries(Object.entries(sources).map(([n, src]) => [`.claude/hooks/${n}`, src])),
    });
  const hdr = (...lines) => `#!/usr/bin/env node\n/**\n${lines.map((l) => ` * ${l}`).join("\n")}\n */\n`;
  const detailOf = (c, name) => (c.results.find((r) => r.artifact === `hooks/${name}`) || {}).detail || "";
  const stat = (c, name) => (c.results.find((r) => r.artifact === `hooks/${name}`) || {}).status || null;
  const withRoot = (sources, regs, fn, gf) => {
    const root = hookRoot(sources, regs, gf);
    try {
      fn(checkHookEventDeclaration(root), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  // (a) pure parser — a well-formed multi-registration header
  {
    const p = parseHookEventMarkers(
      hdr(
        "@hook-event: SessionStart (lifecycle) — posture.json is on disk already.",
        "@hook-event: PreToolUse:Edit|Write (guard) — only these tools mutate.",
      ),
    );
    check(
      "fixture-hookEvent-a-parseWellFormed",
      p.malformed.length === 0 &&
        p.markers.length === 2 &&
        p.markers[0].event === "SessionStart" &&
        p.markers[0].matcher === null &&
        p.markers[0].cls === "lifecycle" &&
        p.markers[0].rationale.startsWith("posture.json") &&
        p.markers[1].matcher === "Edit|Write" &&
        p.markers[1].cls === "guard",
      JSON.stringify(p),
    );
  }

  // (b) pure parser — a line that names the marker but does not parse is
  //     MALFORMED, never silently dropped (a dropped line = an undeclared
  //     registration that still reads as declared).
  {
    const p = parseHookEventMarkers(hdr("@hook-event: SessionStart lifecycle no parens"));
    check(
      "fixture-hookEvent-b-parseMalformedNotDropped",
      p.markers.length === 0 && p.malformed.length === 1,
      JSON.stringify(p),
    );
  }

  // (c) CONTROL — lifecycle at SessionStart PASSes. The rule must NOT condemn
  //     every SessionStart hook; a session banner belongs there.
  withRoot(
    { "banner.js": hdr("@hook-event: SessionStart (lifecycle) — the session boundary IS the subject.") },
    [{ name: "banner.js", event: "SessionStart" }],
    (c) =>
      check(
        "fixture-hookEvent-c-control-lifecycleAtSessionStart-PASS",
        stat(c, "banner.js") === STATUS.PASS,
        detailOf(c, "banner.js"),
      ),
  );

  // (d) MUST-2 — verification at SessionStart FAILs. The co-owner's finding.
  withRoot(
    { "verify.js": hdr("@hook-event: SessionStart (verification) — checks this session's edits.") },
    [{ name: "verify.js", event: "SessionStart" }],
    (c) =>
      check(
        "fixture-hookEvent-d-verificationAtSessionStart-FAIL",
        stat(c, "verify.js") === STATUS.FAIL && /MUST-2/.test(detailOf(c, "verify.js")),
        detailOf(c, "verify.js"),
      ),
  );

  // (e) CONTROL — telemetry under `*` PASSes. A heartbeat genuinely belongs on
  //     every tool call; `*` is not a defect on its own.
  withRoot(
    { "beat.js": hdr("@hook-event: PreToolUse:* (telemetry) — every tool call is the subject.") },
    [{ name: "beat.js", event: "PreToolUse", matcher: "*" }],
    (c) =>
      check(
        "fixture-hookEvent-e-control-telemetryStar-PASS",
        stat(c, "beat.js") === STATUS.PASS,
        detailOf(c, "beat.js"),
      ),
  );

  // (f) MUST-3 — a guard under `*` FAILs (narrow to the tools that can act).
  withRoot(
    { "wide.js": hdr("@hook-event: PreToolUse:* (guard) — blocks writes outside the worktree.") },
    [{ name: "wide.js", event: "PreToolUse", matcher: "*" }],
    (c) =>
      check(
        "fixture-hookEvent-f-guardUnderStar-FAIL",
        stat(c, "wide.js") === STATUS.FAIL && /MUST-3/.test(detailOf(c, "wide.js")),
        detailOf(c, "wide.js"),
      ),
  );

  // (g) MUST-4 — marker declares one event, settings.json registers another.
  //     The re-homing drift lock.
  withRoot(
    { "moved.js": hdr("@hook-event: SessionStart (lifecycle) — stale rationale for a moved hook.") },
    [{ name: "moved.js", event: "PostToolUse", matcher: "Bash" }],
    (c) =>
      check(
        "fixture-hookEvent-g-declaredVsRegisteredMismatch-FAIL",
        stat(c, "moved.js") === STATUS.FAIL && /MUST-4/.test(detailOf(c, "moved.js")),
        detailOf(c, "moved.js"),
      ),
  );

  // (h) MUST-4 scope restriction — matcher ORDER must not read as a mismatch.
  //     Without the shared `normalizeMatcher`, `Write|Edit` vs `Edit|Write`
  //     would report a false mismatch on a correctly-wired hook.
  withRoot(
    { "order.js": hdr("@hook-event: PreToolUse:Edit|Write (guard) — order-insensitive matcher.") },
    [{ name: "order.js", event: "PreToolUse", matcher: "Write|Edit" }],
    (c) =>
      check(
        "fixture-hookEvent-h-matcherOrderNormalized-PASS",
        stat(c, "order.js") === STATUS.PASS,
        detailOf(c, "order.js"),
      ),
  );

  // (i) MUST-1 — an unrecognized CLASS token FAILs rather than falling out of
  //     the comparison (a typo must not silently disable the MUST-2 predicate).
  withRoot(
    { "typo.js": hdr("@hook-event: SessionStart (verifiction) — typo in the class token.") },
    [{ name: "typo.js", event: "SessionStart" }],
    (c) =>
      check(
        "fixture-hookEvent-i-unknownClassToken-FAIL",
        stat(c, "typo.js") === STATUS.FAIL && /unrecognized class/.test(detailOf(c, "typo.js")),
        detailOf(c, "typo.js"),
      ),
  );

  // (j) MUST-1 — an unrecognized EVENT token FAILs (positive allowlist).
  withRoot(
    { "badevt.js": hdr("@hook-event: SessionStarted (lifecycle) — not a CC hook event.") },
    [{ name: "badevt.js", event: "SessionStart" }],
    (c) =>
      check(
        "fixture-hookEvent-j-unknownEventToken-FAIL",
        stat(c, "badevt.js") === STATUS.FAIL && /unrecognized hook event/.test(detailOf(c, "badevt.js")),
        detailOf(c, "badevt.js"),
      ),
  );

  // (k) MUST-1 — an EMPTY rationale FAILs. The marker is a claim, not a token.
  withRoot(
    { "empty.js": hdr("@hook-event: SessionStart (lifecycle) —") },
    [{ name: "empty.js", event: "SessionStart" }],
    (c) =>
      check(
        "fixture-hookEvent-k-emptyRationale-FAIL",
        stat(c, "empty.js") === STATUS.FAIL && /empty rationale/.test(detailOf(c, "empty.js")),
        detailOf(c, "empty.js"),
      ),
  );

  // (l) GRANDFATHER — a registered hook with NO marker, WHEN NAMED IN THE
  //     LAND-TIME SNAPSHOT, is a NON-blocking advisory (SKIP + `WARN:`), never a
  //     FAIL. That is what lets the rule land without turning the pre-existing
  //     corpus red. It is the CONTROL for (s): without this arm, (s) could pass by
  //     flagging every undeclared hook, which would just be the opposite defect.
  //     The snapshot is INJECTED here — the temp root carries no snapshot file, and
  //     the loader fails CLOSED on absence, which (s) relies on.
  {
    const root = hookRoot(
      { "old.js": hdr("Hook: old — predates the rule; no declaration.") },
      [{ name: "old.js", event: "SessionStart" }],
    );
    try {
      const c = checkHookEventDeclaration(root, { grandfathered: new Set(["old.js"]) });
      check(
        "fixture-hookEvent-l-noMarkerGrandfathered-WARN",
        stat(c, "old.js") === STATUS.SKIP && detailOf(c, "old.js").startsWith("WARN:"),
        detailOf(c, "old.js"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // (m) SCOPE RESTRICTION — a hook registered NOWHERE has no event to
  //     deliberate about; it SKIPs WITHOUT a `WARN:` (settings-hook-registration
  //     owns it). Asserting the absence of the WARN prefix is the point: a
  //     grandfather-WARN here would double-report every git-hook.
  withRoot(
    {
      "wired.js": hdr("@hook-event: SessionStart (lifecycle) — registered."),
      "githook.js": hdr("@settings-registration: git-hook — installed per-clone."),
    },
    [{ name: "wired.js", event: "SessionStart" }],
    (c) =>
      check(
        "fixture-hookEvent-m-unregisteredNotWarned-SKIP",
        stat(c, "githook.js") === STATUS.SKIP && !detailOf(c, "githook.js").startsWith("WARN:"),
        detailOf(c, "githook.js"),
      ),
  );

  // (n) SCOPE RESTRICTION — a NON-CANONICAL settings command does not count as a
  //     registration (the S1 masquerade class). The hook must rank unregistered,
  //     not "registered at whatever the fake command mentions" — otherwise this
  //     check would certify a masquerading registration as event-deliberated.
  withRoot(
    { "masq.js": hdr("@hook-event: SessionStart (lifecycle) — declared but not genuinely wired.") },
    [
      {
        name: "masq.js",
        event: "SessionStart",
        command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/masq.js.disabled"',
      },
    ],
    (c) =>
      check(
        "fixture-hookEvent-n-nonCanonicalNotARegistration-SKIP",
        stat(c, "masq.js") === STATUS.SKIP && !detailOf(c, "masq.js").startsWith("WARN:"),
        detailOf(c, "masq.js"),
      ),
  );

  // (o) A malformed line is reported ONCE (as MUST-1), not also as a MUST-4 set
  //     mismatch — a malformed line yields no (event, matcher) pair, so
  //     comparing sets on top of it would double-count a single defect and send
  //     the author chasing a phantom re-homing.
  withRoot(
    { "one.js": hdr("@hook-event: SessionStart lifecycle no parens") },
    [{ name: "one.js", event: "SessionStart" }],
    (c) =>
      check(
        "fixture-hookEvent-o-malformedNotDoubleCounted-FAIL",
        stat(c, "one.js") === STATUS.FAIL &&
          /MUST-1 malformed/.test(detailOf(c, "one.js")) &&
          !/MUST-4/.test(detailOf(c, "one.js")),
        detailOf(c, "one.js"),
      ),
  );

  // ── Adversarial-round fixtures (security lens, 2026-08-01) ────────────────
  // Each of s/t/u/v closes a fail-OPEN the round found in this check. They are
  // grouped because they share one property: every one of them PASSED before the
  // fix, so the check reported clean on the very defect it exists to catch.

  // (s) M3 — the GRANDFATHER IS BOUNDED. A registered hook with no marker that is
  //     NOT in the land-time snapshot must FAIL. Unbounded, a brand-new
  //     verification-at-SessionStart hook shipped with no marker takes the same
  //     non-blocking SKIP as a pre-existing one and /sync stays green.
  withRoot(
    { "brandnew.js": hdr("Hook: brandnew — shipped after the rule landed, no declaration.") },
    [{ name: "brandnew.js", event: "SessionStart" }],
    (c) =>
      check(
        "fixture-hookEvent-s-newHookNotGrandfathered-FAIL",
        stat(c, "brandnew.js") === STATUS.FAIL && /MUST-1/.test(detailOf(c, "brandnew.js")),
        detailOf(c, "brandnew.js"),
      ),
  );

  // (w) M1 — the lazy seam must discriminate on WHICH module is missing, not on
  //     the error CODE. `reconcile-settings-hooks.mjs` statically imports
  //     `./lib/coc-manifest.mjs` and `../hooks/lib/settings-deny-guard-shape.js`;
  //     if either is deleted or renamed the NESTED failure raises the IDENTICAL
  //     MODULE_NOT_FOUND. A code-only test swallows it, returns SKIP, and asserts
  //     "the recognizer is not present" — a false statement that silently disarms a
  //     blocking check AT LOOM, the one place it is supposed to bite.
  //
  //     THE ERRORS ARE GENERATED, NOT HAND-WRITTEN, AND THAT IS THE FIX TO THIS
  //     FIXTURE. Its first cut synthesised the nested arm as
  //     `new Error("Cannot find module './lib/coc-manifest.mjs'")` — omitting the
  //     `Require stack:` / `imported from <parent>` continuation that IS the leak
  //     mechanism. So it modelled a nested failure the OLD whole-message
  //     `includes()` ALREADY handled, and passed identically with the fix reverted
  //     (52 passed, 0 failed, exit 0). A fixture asserting a property it cannot
  //     observe reports coverage that does not exist. Node emits the parent's path
  //     on the SAME line for ESM ("imported from") and on a CONTINUATION line for
  //     CJS ("Require stack:"); both are reproduced here from real throws.
  {
    const seamDir = mkdtempSync(join(tmpdir(), "validate-emit-seam-"));
    mkdirSync(join(seamDir, "present"), { recursive: true });
    // An ESM module that EXISTS but whose own static import does not — the real
    // production shape (reconcile-settings-hooks.mjs imports ./lib/coc-manifest.mjs).
    writeFileSync(
      join(seamDir, "present", "reconcile-settings-hooks.mjs"),
      'import { loadLoomOnly } from "./lib/coc-manifest.mjs";\nexport const enumerateRegistrations = () => [];\n',
    );
    // The CJS arm. Its FILENAME contains the specifier on purpose: that is what
    // puts "reconcile-settings-hooks" into the `Require stack:` continuation and
    // makes a whole-message `includes()` return true for a NESTED failure.
    writeFileSync(
      join(seamDir, "present", "cjs-reconcile-settings-hooks.js"),
      'module.exports = require("./lib/absent-cjs.js");\n',
    );
    const seamReq = createRequire(join(seamDir, "probe.mjs"));
    const grab = (spec) => {
      try {
        seamReq(spec);
        return null;
      } catch (e) {
        return e;
      }
    };
    // Genuinely absent (the consumer case this predicate exists to allow).
    const ownMissing = grab("./reconcile-settings-hooks.mjs");
    const nestedEsm = grab("./present/reconcile-settings-hooks.mjs");
    const nestedCjs = grab("./present/cjs-reconcile-settings-hooks.js");
    const syntaxErr = Object.assign(new Error("Unexpected token"), { code: "ERR_MODULE_SYNTAX" });
    const S = "reconcile-settings-hooks";

    // ANTI-VACUITY CONTROL, per this file's own "dead control" convention. If Node
    // ever stops emitting the parent path in either shape, the arms below would
    // pass for the wrong reason — the leak would be untested and the fixture would
    // still be green. This asserts the generated messages actually CARRY the leak
    // mechanism, so the arm goes RED rather than inert.
    check(
      "fixture-hookEvent-w0-controlNestedErrorsCarryParentPath",
      ownMissing?.message.includes(S) === true &&
        nestedEsm?.message.includes(S) === true &&
        nestedCjs?.message.includes(S) === true,
      `own=${ownMissing?.code} esm=${nestedEsm?.code} cjs=${nestedCjs?.code} | ` +
        `esmMsg=${JSON.stringify(nestedEsm?.message)} cjsMsg=${JSON.stringify(nestedCjs?.message)}`,
    );

    check(
      "fixture-hookEvent-w-lazySeamDiscriminatesSpecifier",
      isMissingOwnSpecifier(ownMissing, S) === true &&
        isMissingOwnSpecifier(nestedEsm, S) === false &&
        isMissingOwnSpecifier(nestedCjs, S) === false &&
        isMissingOwnSpecifier(syntaxErr, S) === false &&
        isMissingOwnSpecifier(null, S) === false,
      `own=${isMissingOwnSpecifier(ownMissing, S)} nestedEsm=${isMissingOwnSpecifier(nestedEsm, S)} ` +
        `nestedCjs=${isMissingOwnSpecifier(nestedCjs, S)} syntax=${isMissingOwnSpecifier(syntaxErr, S)}`,
    );
    rmSync(seamDir, { recursive: true, force: true });
  }

  // (x)(y) THE NEAR-MISS DETECTOR — a BIPOLAR pair, and neither half is optional.
  //
  //     (x) RECALL. A misspelled keyword (`@hook-events:`, `@hook_event:`,
  //     `@Hook-Event:`, `@hook-event :`) misses the exact-match, leaves `markers`
  //     empty, and drops the hook into the GRANDFATHER branch — a real declaration
  //     carrying a real verdict, waved through by the clause meant to spare hooks
  //     that never opted in. It is listed as grandfathered here ON PURPOSE: that is
  //     the branch it would escape through, so the exemption is the test.
  //
  //     (y) PRECISION, and this is the one that cost a review round. A drafted
  //     detector also accepted the bare keyword at the start of a comment line. With
  //     `[-_ ]?` optional under the `i` flag that branch matches the ordinary JS
  //     property `hookEvent:` — which sits in the output payload of nearly every
  //     hook — and FAILED 13 of 38 registered hooks: 12 legitimately grandfathered
  //     plus posture-gate.js, which had been PASSing. Without (y), broadening the
  //     detector reds two thirds of the corpus and CI stays green.
  withRoot(
    { "typo.js": hdr("@hook-events: PreToolUse:Bash (guard) — plural typo; still a real declaration.") },
    [{ name: "typo.js", event: "PreToolUse", matcher: "Bash" }],
    (c) =>
      check(
        "fixture-hookEvent-x-nearMissMisspelledMarker-FAIL",
        stat(c, "typo.js") === STATUS.FAIL && /malformed declaration/.test(detailOf(c, "typo.js")),
        `status=${stat(c, "typo.js")} detail=${detailOf(c, "typo.js")}`,
      ),
    ["typo.js"],
  );
  withRoot(
    {
      // NO marker anywhere. `hookEvent:` here is an ordinary property in the hook's
      // own output payload — the shape the over-broad draft mistook for a marker.
      // readHookHeader reads the WHOLE file, so a body line is in scope.
      "payload.js":
        '#!/usr/bin/env node\n/**\n * payload.js — no @hook-event marker; grandfathered.\n */\n' +
        'process.stdout.write(JSON.stringify({\n' +
        '  hookSpecificOutput: {\n' +
        '    hookEvent: "PreToolUse",\n' +
        '    permissionDecision: "allow",\n' +
        '  },\n' +
        '}));\n',
    },
    [{ name: "payload.js", event: "PreToolUse", matcher: "Bash" }],
    (c) =>
      check(
        "fixture-hookEvent-y-hookEventPropertyIsNotANearMiss-SKIP",
        stat(c, "payload.js") === STATUS.SKIP &&
          /Grandfathered non-blocking/.test(detailOf(c, "payload.js")),
        `status=${stat(c, "payload.js")} detail=${detailOf(c, "payload.js")}`,
      ),
    ["payload.js"],
  );

  // (t) M2 — an OMITTED matcher is the WIDEST, not the narrowest. A `guard` at
  //     PreToolUse with no matcher fires on every tool call; before the fix it
  //     cleared MUST-3 (short-circuit on null) AND MUST-4 (normalizeMatcher(null)
  //     === "" === the registered key), so writing LESS was the cheaper bypass.
  withRoot(
    { "nomatch.js": hdr("@hook-event: PreToolUse (guard) — blocks writes outside the worktree.") },
    [{ name: "nomatch.js", event: "PreToolUse" }],
    (c) =>
      check(
        "fixture-hookEvent-t-guardAbsentMatcher-FAIL",
        stat(c, "nomatch.js") === STATUS.FAIL && /MUST-3/.test(detailOf(c, "nomatch.js")),
        detailOf(c, "nomatch.js"),
      ),
  );

  // (u) M5 — a NARROW class at an event with no tool axis. `guard`@SessionStart is
  //     what the rule's own first opt-in declared while the class table homed
  //     `guard` at PreToolUse/PostToolUse; the table and the worked example
  //     disagreed on day one, and no predicate enforced either.
  withRoot(
    { "ssguard.js": hdr("@hook-event: SessionStart (guard) — repairs settings.json.") },
    [{ name: "ssguard.js", event: "SessionStart" }],
    (c) =>
      check(
        "fixture-hookEvent-u-narrowClassNoToolAxis-FAIL",
        stat(c, "ssguard.js") === STATUS.FAIL && /no tool axis/.test(detailOf(c, "ssguard.js")),
        detailOf(c, "ssguard.js"),
      ),
  );

  // (v) M4 — enumeration runs from the REGISTRATIONS, not from a disk walk. A
  //     registered `.mjs` hook was skipped by the old `.js` filter and produced NO
  //     ROW AT ALL — not PASS, not SKIP, not FAIL. `CANONICAL_RE` accepts
  //     `js|mjs|cjs`, so the walk and the recognizer disagreed, and the walk lost
  //     silently. Asserting a row EXISTS is the point.
  withRoot(
    { "modern.mjs": hdr("@hook-event: SessionStart (verification) — wrong, and must be SEEN to be wrong.") },
    [{ name: "modern.mjs", event: "SessionStart" }],
    (c) =>
      check(
        "fixture-hookEvent-v-registeredMjsProducesRow-FAIL",
        stat(c, "modern.mjs") === STATUS.FAIL && /MUST-2/.test(detailOf(c, "modern.mjs")),
        `row=${stat(c, "modern.mjs")} detail=${detailOf(c, "modern.mjs").slice(0, 120)}`,
      ),
  );

  // (r) REGRESSION LOCK — a declaration BEYOND any plausible header slice must
  //     still be seen. This case is not hypothetical: the first cut of the check
  //     read only the leading 4000 bytes, 37 of loom's 39 top-level hooks are
  //     larger than that, and a `verification`@`SessionStart` marker at byte ~4500
  //     was SWALLOWED into the grandfather SKIP — a hook that genuinely opted in,
  //     carrying the exact defect the rule blocks, waved through by the clause
  //     meant to spare hooks that never opted in. Reinstating any byte cap reds
  //     here. The assertion is deliberately BOTH arms: it must FAIL (the marker was
  //     read) and it must NOT be the grandfather SKIP (the fail-open path).
  {
    const filler = " * ".concat("x".repeat(60), "\n").repeat(75); // ~4.7 kB
    withRoot(
      {
        "deep.js":
          "#!/usr/bin/env node\n/**\n * Hook: deep\n" +
          filler +
          " * @hook-event: SessionStart (verification) — checks this session's edits.\n */\n",
      },
      [{ name: "deep.js", event: "SessionStart" }],
      (c) =>
        check(
          "fixture-hookEvent-r-markerBeyondHeaderSlice-FAIL",
          stat(c, "deep.js") === STATUS.FAIL &&
            /MUST-2/.test(detailOf(c, "deep.js")) &&
            !detailOf(c, "deep.js").startsWith("WARN:"),
          `status=${stat(c, "deep.js")} detail=${detailOf(c, "deep.js").slice(0, 160)}`,
        ),
    );
  }

  // (q) F1030d DEGRADE — the shared registration recognizer is loom-only and this
  //     tool SHIPS, so the import is lazy. When it cannot resolve, the check must
  //     SKIP with a `WARN:` detail, never FAIL and never silently PASS. Injecting
  //     the loaders proves the seam exists; the ABSENT arm is covered structurally
  //     by f1030d-fail-closed-bin.test.mjs A5 (no static import of a non-shipped
  //     sibling), which reds if the lazy seam is ever converted back.
  {
    const root = hookRoot(
      { "x.js": hdr("@hook-event: SessionStart (lifecycle) — registered.") },
      [{ name: "x.js", event: "SessionStart" }],
    );
    try {
      const injected = checkHookEventDeclaration(root, {
        enumerateRegistrations: () => [
          { rel: ".claude/hooks/x.js", event: "SessionStart", matcherKey: "" },
        ],
        normalizeMatcher: () => "",
      });
      check(
        "fixture-hookEvent-q-recognizerInjectable-PASS",
        injected.results.some((r) => r.artifact === "hooks/x.js" && r.status === STATUS.PASS),
        JSON.stringify(injected.results),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // (p) A hook registered at MULTIPLE events must declare ALL of them; declaring
  //     only one is a MUST-4 registered-but-undeclared finding.
  withRoot(
    { "multi.js": hdr("@hook-event: SessionStart (lifecycle) — only half the story.") },
    [
      { name: "multi.js", event: "SessionStart" },
      { name: "multi.js", event: "PreToolUse", matcher: "Bash" },
    ],
    (c) =>
      check(
        "fixture-hookEvent-p-partialDeclarationOfMultiRegistration-FAIL",
        stat(c, "multi.js") === STATUS.FAIL &&
          /registered-but-undeclared/.test(detailOf(c, "multi.js")),
        detailOf(c, "multi.js"),
      ),
  );
}

// ----------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------
process.stdout.write(
  `\nvalidate-emit audit fixtures: ${passed} passed, ${failed} failed\n`,
);
process.exit(failed > 0 ? 1 : 0);
