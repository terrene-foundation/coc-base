#!/usr/bin/env node
/*
 * Audit fixture runner for validate-extraction-history (F25, journal/0152).
 *
 * Structural probes per rules/probe-driven-verification.md MUST-3:
 *   - exit-code / count-of-elements / equality checks on pure-function outputs.
 *   - integration tests use temp git repos (real subprocess; no mocks).
 *   - NO semantic judgment, NO regex on assistant prose.
 *
 * Exit 0 = all fixtures pass. Exit 1 = ≥1 fixture failed.
 */

import {
  parseDateUTC,
  daysBetween,
  parseFrontmatter,
  hasRule10Anchor,
  citesRule,
  classifyEntry,
  getScopeAtDate,
  RULE10_ANCHORS,
} from "../../bin/validate-extraction-history.mjs";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function gitInit(repoDir) {
  execFileSync("git", ["init", "--quiet"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });
}

function gitCommit(repoDir, msg, dateIso) {
  execFileSync("git", ["add", "-A"], { cwd: repoDir });
  execFileSync(
    "git",
    ["commit", "--quiet", "-m", msg, "--allow-empty-message"],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: dateIso,
        GIT_COMMITTER_DATE: dateIso,
      },
    },
  );
}

// ------------------------------------------------------------------
// fixture-01-parse-date-utc
// ------------------------------------------------------------------
{
  const t = parseDateUTC("2026-05-23");
  // 2026-05-23 noon UTC = Date.UTC(2026, 4, 23, 12, 0, 0, 0)
  const expected = Date.UTC(2026, 4, 23, 12, 0, 0, 0);
  let threw = false;
  try {
    parseDateUTC("2026/05/23");
  } catch {
    threw = true;
  }
  check(
    "fixture-01-parse-date-utc",
    t === expected && threw,
    `got t=${t} expected=${expected} threw=${threw}`,
  );
}

// ------------------------------------------------------------------
// fixture-02-days-between
// ------------------------------------------------------------------
{
  const sameDay = daysBetween("2026-05-23", "2026-05-23");
  const oneDay = daysBetween("2026-05-24", "2026-05-23");
  const crossMonth = daysBetween("2026-06-01", "2026-05-30");
  const wholeWindow = daysBetween("2026-05-30", "2026-04-30");
  check(
    "fixture-02-days-between",
    sameDay === 0 && oneDay === 1 && crossMonth === 2 && wholeWindow === 30,
    `sameDay=${sameDay} oneDay=${oneDay} crossMonth=${crossMonth} wholeWindow=${wholeWindow}`,
  );
}

// ------------------------------------------------------------------
// fixture-03-tz-naive-boundary
// ------------------------------------------------------------------
// LOW4: parsing at noon UTC means a local-midnight wraparound on either
// the proposal-date or entry-date stays within the same UTC calendar day.
// We can't directly toggle the runner's TZ, but we can verify that
// arithmetic on adjacent dates produces stable +1 deltas.
{
  const a = daysBetween("2026-12-31", "2026-12-30");
  const b = daysBetween("2026-01-01", "2025-12-31");
  const c = daysBetween("2027-01-01", "2026-12-31");
  check(
    "fixture-03-tz-naive-boundary",
    a === 1 && b === 1 && c === 1,
    `cross-year/month-boundary deltas: a=${a} b=${b} c=${c}`,
  );
}

// ------------------------------------------------------------------
// fixture-04-parse-frontmatter
// ------------------------------------------------------------------
{
  const text = `---
type: DECISION
date: 2026-05-23
scope: baseline
priority: 0
---

# Body

The body is not parsed.
type: ignored_in_body
`;
  const fm = parseFrontmatter(text);
  check(
    "fixture-04-parse-frontmatter",
    fm.get("type") === "DECISION" &&
      fm.get("date") === "2026-05-23" &&
      fm.get("scope") === "baseline" &&
      fm.get("priority") === "0" &&
      !fm.has("ignored_in_body"),
    `got fm=${JSON.stringify([...fm])}`,
  );
}

// ------------------------------------------------------------------
// fixture-05-no-frontmatter
// ------------------------------------------------------------------
{
  const text = "# No frontmatter here\n\ndate: 2026-05-23 (inside body)\n";
  const fm = parseFrontmatter(text);
  check(
    "fixture-05-no-frontmatter",
    fm.size === 0,
    `expected empty map; got ${fm.size}`,
  );
}

// ------------------------------------------------------------------
// fixture-06-has-rule10-anchor
// ------------------------------------------------------------------
{
  // Each known anchor must match (case-insensitive).
  const matches = RULE10_ANCHORS.every((a) => hasRule10Anchor(`Foo ${a.toUpperCase()} bar`));
  const miss = !hasRule10Anchor("This entry talks about Rule 11 fires but not Rule 10");
  check(
    "fixture-06-has-rule10-anchor",
    matches && miss,
    `matches=${matches} miss=${miss}`,
  );
}

// ------------------------------------------------------------------
// fixture-07-cites-rule-canonical
// ------------------------------------------------------------------
{
  const body = "see `.claude/rules/test-rule.md` for the canonical form";
  const hit = citesRule(body, ".claude/rules/test-rule.md");
  const miss = citesRule(body, ".claude/rules/other-rule.md");
  check(
    "fixture-07-cites-rule-canonical",
    hit && !miss,
    `hit=${hit} miss=${miss}`,
  );
}

// ------------------------------------------------------------------
// fixture-08-cites-rule-bare
// ------------------------------------------------------------------
{
  const body = "see `rules/test-rule.md` for the bare form";
  const hit = citesRule(body, "rules/test-rule.md");
  check("fixture-08-cites-rule-bare", hit, `hit=${hit}`);
}

// ------------------------------------------------------------------
// fixture-09-cites-rule-basename
// ------------------------------------------------------------------
{
  // Basename match requires path-marker adjacency.
  const hitBacktick = citesRule("see `test-rule.md` for...", "rules/test-rule.md");
  const hitSlash = citesRule("path/test-rule.md is the file", "rules/test-rule.md");
  // No path-marker adjacency: just bare basename in prose → also matches per
  // word-boundary regex; this is intentional (Phase-1 prefers false-positive
  // over false-negative on rule citations).
  const proseHit = citesRule("test-rule.md is referenced in prose", "rules/test-rule.md");
  check(
    "fixture-09-cites-rule-basename",
    hitBacktick && hitSlash && proseHit,
    `hitBacktick=${hitBacktick} hitSlash=${hitSlash} proseHit=${proseHit}`,
  );
}

// ------------------------------------------------------------------
// fixture-10-sm1-asofdate-mismatch
// ------------------------------------------------------------------
{
  // Subprocess test: invoke the CLI; expect exit 2 + error message.
  const __filename = fileURLToPath(import.meta.url);
  const script = join(
    __filename.replace(/\/audit-fixtures\/.*$/, "/bin/validate-extraction-history.mjs"),
  );
  let result;
  try {
    execFileSync(
      "node",
      [
        script,
        "--rule",
        "rules/foo.md",
        "--proposal-date",
        "2026-05-30",
        "--as-of-date",
        "2026-05-28",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    result = { code: 0 };
  } catch (e) {
    result = { code: e.status, stderr: e.stderr };
  }
  check(
    "fixture-10-sm1-asofdate-mismatch",
    result.code === 2 && /MUST match/i.test(result.stderr || ""),
    `code=${result.code} stderr=${result.stderr?.slice(0, 200)}`,
  );
}

// ------------------------------------------------------------------
// fixture-11-sm2-rule-rename-git
// ------------------------------------------------------------------
// Create temp git repo; commit a rule under one name at date D1; git mv
// rename it at D2; verify getScopeAtDate at D1 returns the original path's
// scope, and at D2 returns the new path's scope.
{
  const tmp = join(tmpdir(), `f25-fix-11-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude", "rules"), { recursive: true });
    gitInit(tmp);
    // D1 — original name + scope:baseline
    writeFileSync(
      join(tmp, ".claude", "rules", "old-name.md"),
      "---\ntype: rule\nscope: baseline\npriority: 0\n---\n# Rule body\n",
    );
    gitCommit(tmp, "initial", "2026-05-20T12:00:00Z");
    // D2 — pure rename (no content change so rename detection always fires)
    execFileSync(
      "git",
      ["mv", ".claude/rules/old-name.md", ".claude/rules/new-name.md"],
      { cwd: tmp },
    );
    gitCommit(tmp, "rename only", "2026-05-22T10:00:00Z");
    // D2+ — scope change (separate commit)
    writeFileSync(
      join(tmp, ".claude", "rules", "new-name.md"),
      "---\ntype: rule\nscope: path-scoped\npriority: 10\n---\n# Rule body\n",
    );
    gitCommit(tmp, "scope change", "2026-05-22T12:00:00Z");

    // Verify at D1: the rule was at old name with scope:baseline
    const atD1 = getScopeAtDate(".claude/rules/new-name.md", "2026-05-20", tmp);
    // Verify at D2: the rule is at new name with scope:path-scoped
    const atD2 = getScopeAtDate(".claude/rules/new-name.md", "2026-05-23", tmp);

    check(
      "fixture-11-sm2-rule-rename-git",
      atD1.ok &&
        atD1.scope === "baseline" &&
        atD1.pathAtCommit === ".claude/rules/old-name.md" &&
        atD2.ok &&
        atD2.scope === "path-scoped" &&
        atD2.pathAtCommit === ".claude/rules/new-name.md",
      `atD1=${JSON.stringify(atD1)} atD2=${JSON.stringify(atD2)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-12-scope-at-date-baseline
// ------------------------------------------------------------------
// classifyEntry returns mandated=true when (a) anchor present, (b) rule
// cited, (c) scope=baseline at entry's date (via real git repo).
{
  const tmp = join(tmpdir(), `f25-fix-12-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude", "rules"), { recursive: true });
    gitInit(tmp);
    writeFileSync(
      join(tmp, ".claude", "rules", "baseline-rule.md"),
      "---\nscope: baseline\npriority: 0\n---\n",
    );
    gitCommit(tmp, "init", "2026-05-15T12:00:00Z");

    // Fake journal entry: anchor + citation + frontmatter date
    const fmText = `---
type: DECISION
date: 2026-05-20
---

# Entry body

This entry's Rule-10 disposition is path (b) named-rationale on rules/baseline-rule.md.
`;
    const fm = parseFrontmatter(fmText);
    const result = classifyEntry(
      "fake.md",
      fmText,
      fm,
      ".claude/rules/baseline-rule.md",
      tmp,
    );
    check(
      "fixture-12-scope-at-date-baseline",
      result.mandated === true && result.reason === "rule-10-mandated-invocation",
      `got result=${JSON.stringify(result)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-13-scope-at-date-path-scoped
// ------------------------------------------------------------------
// classifyEntry returns mandated=false when scope=path-scoped at entry's
// date — this is the journal/0148 amendment correction class.
{
  const tmp = join(tmpdir(), `f25-fix-13-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude", "rules"), { recursive: true });
    gitInit(tmp);
    writeFileSync(
      join(tmp, ".claude", "rules", "path-scoped-rule.md"),
      "---\nscope: path-scoped\npriority: 10\n---\n",
    );
    gitCommit(tmp, "init", "2026-05-15T12:00:00Z");

    const fmText = `---
type: DECISION
date: 2026-05-20
---

# Entry body

This entry's Rule-10 disposition is on rules/path-scoped-rule.md but the
rule is path-scoped so Rule-10 did NOT actually fire (journal/0148 class).
`;
    const fm = parseFrontmatter(fmText);
    const result = classifyEntry(
      "fake.md",
      fmText,
      fm,
      ".claude/rules/path-scoped-rule.md",
      tmp,
    );
    check(
      "fixture-13-scope-at-date-path-scoped",
      result.mandated === false &&
        /scope-at-date-not-baseline/.test(result.reason),
      `got result=${JSON.stringify(result)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-14-window-filter
// ------------------------------------------------------------------
// daysBetween-based window filter excludes entries > windowDays before
// proposal-date. The classifier itself is window-agnostic; the main
// driver applies the window. Verify the boundary at exactly 30 days
// and at 31 days (the off-by-one edge).
{
  const inWindow = daysBetween("2026-05-30", "2026-04-30"); // 30
  const justOutside = daysBetween("2026-05-30", "2026-04-29"); // 31
  check(
    "fixture-14-window-filter",
    inWindow === 30 && justOutside === 31,
    `inWindow=${inWindow} justOutside=${justOutside}`,
  );
}

// ------------------------------------------------------------------
// fixture-15-multiple-rule10-anchors
// ------------------------------------------------------------------
{
  const hits = [
    "Per Rule-10 disposition path (b) we ship the named-rationale.",
    "When Rule 10 fires, the named-rationale MUST carry 5 sub-fields.",
    "The proximity-band sweep checks emit.mjs output.",
    "F23a proximity-band gate landed in journal/0146.",
  ].every(hasRule10Anchor);
  const negs = [
    "Just rule 11 fires here, no rule 10 mentioned.",
    "Random prose with no anchor language at all.",
  ].every((s) => !hasRule10Anchor(s));
  check(
    "fixture-15-multiple-rule10-anchors",
    hits && negs,
    `hits=${hits} negs=${negs}`,
  );
}

// ------------------------------------------------------------------
// fixture-16-empty-git-log
// ------------------------------------------------------------------
// Reviewer HIGH-1 follow-up: getScopeAtDate against a path that does not
// exist in git history returns rule-not-found-in-git-history (NOT a crash
// and NOT a fabricated path-at-commit).
{
  const tmp = join(tmpdir(), `f25-fix-16-${Date.now()}`);
  try {
    mkdirSync(tmp, { recursive: true });
    gitInit(tmp);
    writeFileSync(join(tmp, "README.md"), "# repo\n");
    gitCommit(tmp, "init", "2026-05-20T12:00:00Z");
    const r = getScopeAtDate(".claude/rules/never-existed.md", "2026-05-21", tmp);
    check(
      "fixture-16-empty-git-log",
      r.ok === false && r.reason === "rule-not-found-in-git-history",
      `got r=${JSON.stringify(r)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-17-future-dated-entry-warning
// ------------------------------------------------------------------
// Reviewer MEDIUM-3: entries dated AFTER --proposal-date produce a stderr
// warning + skip. Subprocess test against the real CLI.
{
  const __filename = fileURLToPath(import.meta.url);
  const script = join(
    __filename.replace(/\/audit-fixtures\/.*$/, "/bin/validate-extraction-history.mjs"),
  );
  const tmp = join(tmpdir(), `f25-fix-17-${Date.now()}`);
  try {
    mkdirSync(join(tmp, "journal"), { recursive: true });
    writeFileSync(
      join(tmp, "journal", "0099-DECISION-future-dated.md"),
      "---\ntype: DECISION\ndate: 2099-12-31\n---\n# future Rule-10 disposition on rules/foo.md\n",
    );
    // spawnSync returns stdout + stderr regardless of exit code.
    const result = spawnSync(
      "node",
      [
        script,
        "--rule",
        "rules/foo.md",
        "--proposal-date",
        "2026-05-30",
        "--journal-dir",
        join(tmp, "journal"),
      ],
      { encoding: "utf8", cwd: tmp },
    );
    // The future-dated entry IS skipped (with warning), so Rule 11 does
    // NOT fire and exit code is 0.
    check(
      "fixture-17-future-dated-entry-warning",
      result.status === 0 &&
        /dated 2099-12-31.*after.*proposal-date/.test(result.stderr),
      `code=${result.status} stderr=${(result.stderr || "").slice(0, 250)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-18-priority-non-zero-not-mandated
// ------------------------------------------------------------------
// Reviewer LOW-2: enforce both priority:0 AND scope:baseline.
{
  const tmp = join(tmpdir(), `f25-fix-18-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude", "rules"), { recursive: true });
    gitInit(tmp);
    // scope=baseline but priority=10 (artificial mismatch) — should NOT be mandated
    writeFileSync(
      join(tmp, ".claude", "rules", "weird-rule.md"),
      "---\nscope: baseline\npriority: 10\n---\n",
    );
    gitCommit(tmp, "init", "2026-05-15T12:00:00Z");

    const fmText = `---
type: DECISION
date: 2026-05-20
---

# Rule-10 disposition on rules/weird-rule.md
`;
    const fm = parseFrontmatter(fmText);
    const result = classifyEntry(
      "fake.md",
      fmText,
      fm,
      ".claude/rules/weird-rule.md",
      tmp,
    );
    check(
      "fixture-18-priority-non-zero-not-mandated",
      result.mandated === false &&
        /priority-at-date-not-0/.test(result.reason),
      `got result=${JSON.stringify(result)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-19-extended-anchor-corpus
// ------------------------------------------------------------------
// Analyst FM-A1: extended anchor list catches "path (a) corpus-level",
// "path (b) named-rationale", "sub-field (vi)", "named-rationale exception".
{
  const cases = [
    "Disposition: path (a) corpus-level forest item per FM-C.",
    "Per the path (b) named-rationale exception in the receipt journal.",
    "Sub-field (vi) verbatim-cites the prior invocation.",
    "Named-rationale exception covers this addition.",
  ];
  const hits = cases.every(hasRule10Anchor);
  check(
    "fixture-19-extended-anchor-corpus",
    hits,
    `extended-corpus hits=${hits}`,
  );
}

// ------------------------------------------------------------------
process.stdout.write(`\n${passed}/${passed + failed} fixtures pass\n`);
process.exit(failed === 0 ? 0 : 1);
