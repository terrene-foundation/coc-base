#!/usr/bin/env node
/*
 * Audit fixture runner for validate-emit check 16 `allowlist-paths-coverage`
 * (#443 — self-referential-codify.md allowlist ⊆ paths: glob coverage).
 *
 * Structural probes per rules/probe-driven-verification.md MUST-3:
 *   - set-membership / equality checks on pure-function outputs + an e2e
 *     check over synthetic rule files written into temp dirs.
 *   - NO semantic judgment, NO regex on assistant prose.
 *
 * One fixture per scope-restriction predicate per cc-artifacts.md Rule 9 +
 * hook-output-discipline.md MUST-4. Each check function fixture exercises BOTH
 * a COVERED (pass) AND an UNCOVERED (fail) entry — the #443 contract.
 *
 * Exit 0 = all fixtures pass. Exit 1 = ≥1 fixture failed.
 */

import {
  parseSelfRefAllowlist,
  parsePathsFrontmatter,
  allowlistGlobCovers,
  braceExpandAllowlist,
  stripParentheticals,
  checkAllowlistPathsCoverage,
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

function buildFixtureRoot(spec) {
  const root = mkdtempSync(join(tmpdir(), "allowlist-paths-fx-"));
  for (const [rel, content] of Object.entries(spec)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function statusOf(c, artifact) {
  const r = c.results.find((x) => x.artifact === artifact);
  return r ? r.status : null;
}

// ----------------------------------------------------------------------
// fixture-01 — braceExpandAllowlist (the {a,b,c} expansion the rule uses)
// ----------------------------------------------------------------------
{
  const a = braceExpandAllowlist(".claude/rules/{trust-posture,cc-artifacts}.md");
  const b = braceExpandAllowlist(".claude/codex-mcp-guard/{server.js,extract-policies.mjs}");
  const c = braceExpandAllowlist(".claude/commands/codify.md"); // no braces → identity
  check(
    "fixture-01-braceExpandAllowlist",
    a.length === 2 &&
      a[0] === ".claude/rules/trust-posture.md" &&
      a[1] === ".claude/rules/cc-artifacts.md" &&
      b.length === 2 &&
      b[0] === ".claude/codex-mcp-guard/server.js" &&
      b[1] === ".claude/codex-mcp-guard/extract-policies.mjs" &&
      c.length === 1 && c[0] === ".claude/commands/codify.md",
    `a=${JSON.stringify(a)} b=${JSON.stringify(b)} c=${JSON.stringify(c)}`,
  );
}

// ----------------------------------------------------------------------
// fixture-02 — stripParentheticals (depth-aware; drops prose explanations)
// ----------------------------------------------------------------------
// The per-entry "(added … per `cc-artifacts.md` …)" parentheticals carry
// backtick references that are NOT allowlist entries; stripping them is the
// load-bearing discriminator that keeps `.claude/**` / `cc-artifacts.md` out.
{
  const s = "`a.md`, `b.md` (added per `prose-ref.md` and nested (deep `x.md`)), `c.md`";
  const stripped = stripParentheticals(s);
  check(
    "fixture-02-stripParentheticals-depth-aware",
    stripped.includes("`a.md`") &&
      stripped.includes("`b.md`") &&
      stripped.includes("`c.md`") &&
      !stripped.includes("prose-ref.md") &&
      !stripped.includes("x.md"), // nested paren content gone too
    `stripped=${JSON.stringify(stripped)}`,
  );
}

// ----------------------------------------------------------------------
// fixture-03 — allowlistGlobCovers (exact + /** prefix; COVERED vs UNCOVERED)
// ----------------------------------------------------------------------
{
  check(
    "fixture-03-allowlistGlobCovers-covered-and-uncovered",
    // COVERED: exact-path match
    allowlistGlobCovers(".claude/sync-manifest.yaml", ".claude/sync-manifest.yaml") === true &&
      // COVERED: /** prefix swallows a child file
      allowlistGlobCovers(".claude/commands/**", ".claude/commands/codify.md") === true &&
      // COVERED: /** prefix swallows a child GLOB entry (e.g. validate-*.mjs)
      allowlistGlobCovers(".claude/bin/**", ".claude/bin/validate-*.mjs") === true &&
      // COVERED: /** prefix matches the dir itself
      allowlistGlobCovers(".claude/audit-fixtures/**", ".claude/audit-fixtures/**") === true &&
      // UNCOVERED: root-level file under no subtree glob (the #440 gap class)
      allowlistGlobCovers(".claude/commands/**", ".claude/operators.roster.schema.json") === false &&
      // UNCOVERED: a /** prefix does NOT match a sibling subtree
      allowlistGlobCovers(".claude/rules/**", ".claude/skills/sweep/**") === false,
  );
}

// ----------------------------------------------------------------------
// fixture-04 — parseSelfRefAllowlist (category bullets only; prose excluded)
// ----------------------------------------------------------------------
// The named-file allowlist parses ONLY from the Rule-2 category bullets
// (first word ∈ Commands/Skills/Rules/Hooks/Data/Bin/Tools/Codex/Audit/
// Management). A Trust-Posture-Wiring bullet (`- **Detection ...:**`) shares
// the `- **<Label>:**` shape but is NOT an allowlist source — its backtick
// path references MUST NOT be swept in.
{
  const rule = `---
priority: 10
scope: path-scoped
paths:
  - ".claude/commands/**"
---

## MUST Rules

- **Commands:** \`.claude/commands/codify.md\`, \`.claude/commands/redteam.md\` (added per \`cc-artifacts.md\` Rule 6 — \`.claude/**\` prose ref)
- **Data files (codify-class):** \`.claude/operators.roster.schema.json\` · \`.claude/sync-manifest.yaml\`
- **Audit fixtures:** \`.claude/audit-fixtures/**\`
- **Detection (Phase 2 — deferred):** a planned \`codify-self-referential.js\` hook under \`.claude/hooks/lib/\` (fixtures under \`.claude/audit-fixtures/\`)
- **Extends:** \`rules/cc-artifacts.md\` Rule 6
`;
  const allow = parseSelfRefAllowlist(rule);
  check(
    "fixture-04-parseSelfRefAllowlist-categories-only",
    allow !== null &&
      allow.includes(".claude/commands/codify.md") &&
      allow.includes(".claude/commands/redteam.md") &&
      allow.includes(".claude/operators.roster.schema.json") &&
      allow.includes(".claude/sync-manifest.yaml") &&
      allow.includes(".claude/audit-fixtures/**") &&
      // prose ref inside a parenthetical must be excluded
      !allow.includes(".claude/**") &&
      // the Detection (Phase 2) + Extends bullets are NOT allowlist sources:
      // their backtick paths (.claude/hooks/lib/ trailing-slash, the bare
      // .claude/audit-fixtures/ trailing-slash) must not appear
      !allow.includes(".claude/hooks/lib/") &&
      !allow.includes(".claude/audit-fixtures/"),
    `allow=${JSON.stringify(allow)}`,
  );
}

// ----------------------------------------------------------------------
// fixture-05 — parsePathsFrontmatter
// ----------------------------------------------------------------------
{
  const rule = `---
priority: 10
scope: path-scoped
paths:
  - ".claude/commands/**"
  - ".claude/sync-manifest.yaml"
---
body
`;
  const noFm = "no frontmatter here\n";
  const globs = parsePathsFrontmatter(rule);
  check(
    "fixture-05-parsePathsFrontmatter",
    Array.isArray(globs) &&
      globs.length === 2 &&
      globs[0] === ".claude/commands/**" &&
      globs[1] === ".claude/sync-manifest.yaml" &&
      parsePathsFrontmatter(noFm) === null,
    `globs=${JSON.stringify(globs)}`,
  );
}

// ----------------------------------------------------------------------
// fixture-06 — checkAllowlistPathsCoverage e2e: COVERED entry → PASS
// ----------------------------------------------------------------------
// A synthetic rule whose every allowlist entry IS covered by a paths: glob.
{
  const rule = `---
priority: 10
scope: path-scoped
paths:
  - ".claude/commands/**"
  - ".claude/sync-manifest.yaml"
---

- **Commands:** \`.claude/commands/codify.md\`
- **Data files (codify-class):** \`.claude/sync-manifest.yaml\`
`;
  const root = buildFixtureRoot({ ".claude/rules/self-referential-codify.md": rule });
  try {
    const c = checkAllowlistPathsCoverage(root);
    const blocking = c.results.filter((r) => r.status === STATUS.FAIL);
    check(
      "fixture-06-e2e-covered-entry-passes",
      statusOf(c, ".claude/commands/codify.md") === STATUS.PASS &&
        statusOf(c, ".claude/sync-manifest.yaml") === STATUS.PASS &&
        blocking.length === 0,
      JSON.stringify(c.results),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-07 — checkAllowlistPathsCoverage e2e: UNCOVERED entry → FAIL
// ----------------------------------------------------------------------
// The #443 + #440 gap class: an allowlist entry (a root-level data file) sits
// under NO paths: glob → editing it never loads the rule → the gate silently
// does not fire. The check MUST flag it as a BLOCKING finding.
{
  const rule = `---
priority: 10
scope: path-scoped
paths:
  - ".claude/commands/**"
---

- **Commands:** \`.claude/commands/codify.md\`
- **Data files (codify-class):** \`.claude/operators.roster.schema.json\`
`;
  const root = buildFixtureRoot({ ".claude/rules/self-referential-codify.md": rule });
  try {
    const c = checkAllowlistPathsCoverage(root);
    check(
      "fixture-07-e2e-uncovered-entry-fails",
      statusOf(c, ".claude/commands/codify.md") === STATUS.PASS &&
        statusOf(c, ".claude/operators.roster.schema.json") === STATUS.FAIL,
      JSON.stringify(c.results),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-08 — e2e: a glob allowlist entry covered by a parent /** glob
// ----------------------------------------------------------------------
// An allowlist entry may itself be a glob (e.g. `.claude/bin/validate-*.mjs`,
// `.claude/skills/sweep/**`); a parent `<dir>/**` glob covers it. Confirms the
// check does NOT mis-flag a legitimately-covered glob entry as an orphan.
{
  const rule = `---
priority: 10
scope: path-scoped
paths:
  - ".claude/bin/**"
  - ".claude/skills/**"
---

- **Bin (codify-class):** \`.claude/bin/{validate-*,emit}.mjs\`
- **Skills (codify-discipline):** \`.claude/skills/sweep/**\`, \`.claude/skills/spec-compliance/**\`
`;
  const root = buildFixtureRoot({ ".claude/rules/self-referential-codify.md": rule });
  try {
    const c = checkAllowlistPathsCoverage(root);
    const blocking = c.results.filter((r) => r.status === STATUS.FAIL);
    check(
      "fixture-08-e2e-glob-entry-covered-by-parent",
      statusOf(c, ".claude/bin/validate-*.mjs") === STATUS.PASS &&
        statusOf(c, ".claude/bin/emit.mjs") === STATUS.PASS &&
        statusOf(c, ".claude/skills/sweep/**") === STATUS.PASS &&
        statusOf(c, ".claude/skills/spec-compliance/**") === STATUS.PASS &&
        blocking.length === 0,
      JSON.stringify(c.results),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-09 — e2e: absent rule → SKIP (consumer tree / unreadable)
// ----------------------------------------------------------------------
{
  const root = buildFixtureRoot({ ".claude/other.md": "x\n" });
  try {
    const c = checkAllowlistPathsCoverage(root);
    check(
      "fixture-09-e2e-absent-rule-skips",
      c.results.length === 1 && c.results[0].status === STATUS.SKIP,
      JSON.stringify(c.results),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------
// fixture-10 — allowlistGlobCovers brace-set GLOB (COVERED vs UNCOVERED)
// ----------------------------------------------------------------------
// The rule's own SUPERSET prose writes the load-trigger frontmatter as a
// brace set (`.claude/{commands,rules,skills,hooks,bin}/**`). If a future
// author collapses the `paths:` frontmatter to that form, allowlistGlobCovers
// MUST brace-expand the GLOB side (symmetric with the allowlist parse) so a
// brace-set glob covers an entry iff ANY expansion covers it — else the entry
// silently UNDER-covers and the Rule-1 multi-agent gate drops on a sibling
// surface (#443 R1 security-reviewer finding).
{
  check(
    "fixture-10-allowlistGlobCovers-braceset-glob",
    // COVERED: brace-set /** glob covers an entry under ONE member
    allowlistGlobCovers(".claude/{commands,rules,bin}/**", ".claude/rules/foo.md") === true &&
      // COVERED: brace-set /** glob covers an entry under a DIFFERENT member
      allowlistGlobCovers(".claude/{commands,rules,bin}/**", ".claude/bin/validate-*.mjs") === true &&
      // COVERED: brace-set EXACT-path glob covers one expanded member
      allowlistGlobCovers(".claude/{a.md,b.md}", ".claude/b.md") === true &&
      // UNCOVERED: brace-set /** glob does NOT cover an entry outside ALL members
      allowlistGlobCovers(".claude/{commands,rules}/**", ".claude/skills/foo.md") === false &&
      // REGRESSION: a plain (non-brace) /** glob still covers as before
      allowlistGlobCovers(".claude/commands/**", ".claude/commands/codify.md") === true,
  );
}

// ----------------------------------------------------------------------
// fixture-11 — e2e: brace-set `paths:` frontmatter covers its allowlist
// ----------------------------------------------------------------------
// The future-frontmatter-collapse scenario, end-to-end: a rule whose `paths:`
// is written in the brace-set form the rule's own prose uses MUST still cover
// allowlist entries spread across the brace members — no UNDER-coverage, no
// spurious FAIL. Without the brace-expand hardening, BOTH entries would
// mis-flag as orphans (the literal `===`/prefix test never matches a brace set).
{
  const rule = `---
priority: 10
scope: path-scoped
paths:
  - ".claude/{commands,bin}/**"
---

- **Commands:** \`.claude/commands/codify.md\`
- **Bin (codify-class):** \`.claude/bin/validate-emit.mjs\`
`;
  const root = buildFixtureRoot({ ".claude/rules/self-referential-codify.md": rule });
  try {
    const c = checkAllowlistPathsCoverage(root);
    const blocking = c.results.filter((r) => r.status === STATUS.FAIL);
    check(
      "fixture-11-e2e-braceset-paths-frontmatter-covers",
      statusOf(c, ".claude/commands/codify.md") === STATUS.PASS &&
        statusOf(c, ".claude/bin/validate-emit.mjs") === STATUS.PASS &&
        blocking.length === 0,
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
  `\nallowlist-paths-coverage audit fixtures: ${passed} passed, ${failed} failed\n`,
);
process.exit(failed > 0 ? 1 : 0);
