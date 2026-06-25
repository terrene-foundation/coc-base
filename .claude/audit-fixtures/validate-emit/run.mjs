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
// Summary
// ----------------------------------------------------------------------
process.stdout.write(
  `\nvalidate-emit audit fixtures: ${passed} passed, ${failed} failed\n`,
);
process.exit(failed > 0 ? 1 : 0);
