#!/usr/bin/env node
/*
 * Audit fixture runner for validate-xref-integrity (F22, journal/0150).
 *
 * Structural probes per rules/probe-driven-verification.md MUST-3:
 *   - exit-code / count-of-elements / equality checks on pure-function outputs.
 *   - NO semantic judgment, NO regex on assistant prose.
 *
 * Exit 0 = all fixtures pass. Exit 1 = ≥1 fixture failed.
 */

import {
  extractTokens,
  resolveJournalToken,
  resolveRefToken,
  resolveOne,
  stripFencedBlocks,
  isPlaceholder,
  isCrossCliDispatcher,
  findRepoRoot,
  DEFAULT_SCOPE_DIRS,
} from "../../bin/validate-xref-integrity.mjs";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = findRepoRoot(process.cwd());

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

// ------------------------------------------------------------------
// fixture-01-backtick-extract
// ------------------------------------------------------------------
{
  const text = "see `rules/foo.md` and `.claude/rules/bar.md` plus `<id>` literal";
  const findings = extractTokens(text, "test.md");
  const tokens = findings.map((f) => f.token).sort();
  check(
    "fixture-01-backtick-extract",
    tokens.length === 2 &&
      tokens.includes("rules/foo.md") &&
      tokens.includes(".claude/rules/bar.md"),
    `got tokens=${JSON.stringify(tokens)}`,
  );
}

// ------------------------------------------------------------------
// fixture-02-md-link-extract
// ------------------------------------------------------------------
{
  const text =
    "[a](rules/foo.md) [b](https://x.com/x.md) [c](#frag) [d](skills/x/y.md#anchor)";
  const findings = extractTokens(text, "test.md");
  const tokens = findings.map((f) => f.token).sort();
  check(
    "fixture-02-md-link-extract",
    tokens.length === 2 &&
      tokens.includes("rules/foo.md") &&
      tokens.includes("skills/x/y.md"),
    `got tokens=${JSON.stringify(tokens)}`,
  );
}

// ------------------------------------------------------------------
// fixture-03-journal-backtick
// ------------------------------------------------------------------
{
  const text = "see `journal/0150-DECISION-foo.md` and `journal/.pending/0001-bar`";
  const findings = extractTokens(text, "test.md");
  const kinds = findings.map((f) => f.kind).sort();
  const tokens = findings.map((f) => f.token).sort();
  check(
    "fixture-03-journal-backtick",
    findings.length === 2 &&
      kinds[0] === "journal" &&
      kinds[1] === "journal" &&
      tokens[0] === "journal/.pending/0001-bar" &&
      tokens[1] === "journal/0150-DECISION-foo.md",
    `got findings=${JSON.stringify(findings.map((f) => ({ k: f.kind, t: f.token })))}`,
  );
}

// ------------------------------------------------------------------
// fixture-04-fence-strip
// ------------------------------------------------------------------
{
  const text = [
    "see `rules/outside.md`",
    "```",
    "this `rules/inside-fence.md` is illustrative",
    "```",
    "and `rules/after-fence.md`",
  ].join("\n");
  const findings = extractTokens(text, "test.md");
  const tokens = findings.map((f) => f.token).sort();
  check(
    "fixture-04-fence-strip",
    tokens.length === 2 &&
      tokens.includes("rules/outside.md") &&
      tokens.includes("rules/after-fence.md") &&
      !tokens.includes("rules/inside-fence.md"),
    `got tokens=${JSON.stringify(tokens)}`,
  );
}

// ------------------------------------------------------------------
// fixture-05-md-link-relative-resolve
// ------------------------------------------------------------------
// Build a temp tree: <tmp>/source-dir/source.md links to ../sibling/target.md
// at <tmp>/sibling/target.md. Resolver must match.
{
  const tmp = join(tmpdir(), `xref-fix-05-${Date.now()}`);
  try {
    mkdirSync(join(tmp, "source-dir"), { recursive: true });
    mkdirSync(join(tmp, "sibling"), { recursive: true });
    writeFileSync(join(tmp, "sibling", "target.md"), "# target\n");
    writeFileSync(join(tmp, "source-dir", "source.md"), "[t](../sibling/target.md)\n");

    // Use resolveRefToken directly with kind="md-link" + source-relative path
    const result = resolveRefToken(
      "../sibling/target.md",
      tmp,
      "source-dir/source.md",
      "md-link",
    );
    check(
      "fixture-05-md-link-relative-resolve",
      result.ok === true,
      `got result=${JSON.stringify(result)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-06-placeholder-reject
// ------------------------------------------------------------------
{
  check(
    "fixture-06-placeholder-reject",
    isPlaceholder("<id>") &&
      isPlaceholder("<NNNN>") &&
      isPlaceholder("{topic}") &&
      !isPlaceholder("rules/foo.md") &&
      !isPlaceholder("skills/x/y.md"),
    `placeholder detection broken`,
  );
}

// ------------------------------------------------------------------
// fixture-07-dir-token-vs-file
// ------------------------------------------------------------------
{
  const tmp = join(tmpdir(), `xref-fix-07-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude", "audit-fixtures", "alpha"), { recursive: true });
    mkdirSync(join(tmp, ".claude", "rules"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "audit-fixtures", "alpha", "README.md"), "# x");
    writeFileSync(join(tmp, ".claude", "rules", "alpha.md"), "# y");

    // Dir token with trailing /
    const r1 = resolveRefToken(
      "audit-fixtures/alpha/",
      tmp,
      null,
      "backtick",
    );
    // File token without trailing /
    const r2 = resolveRefToken("rules/alpha.md", tmp, null, "backtick");
    // File token WITH trailing slash → should fail (file, not dir)
    const r3 = resolveRefToken("rules/alpha.md/", tmp, null, "backtick");
    check(
      "fixture-07-dir-token-vs-file",
      r1.ok === true && r2.ok === true && r3.ok === false,
      `r1=${r1.ok} r2=${r2.ok} r3=${r3.ok}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-08-claude-prefix
// ------------------------------------------------------------------
{
  const tmp = join(tmpdir(), `xref-fix-08-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude", "rules"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "rules", "x.md"), "# x");
    const r = resolveRefToken(".claude/rules/x.md", tmp, null, "backtick");
    check(
      "fixture-08-claude-prefix",
      r.ok === true,
      `got r=${JSON.stringify(r)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-09-bare-prefix-tries-claude-first
// ------------------------------------------------------------------
// `rules/x.md` should resolve to `<repo>/.claude/rules/x.md` when only
// the .claude/-prefixed variant exists.
{
  const tmp = join(tmpdir(), `xref-fix-09-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude", "rules"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "rules", "x.md"), "# x");
    // bare-prefix form (no leading .claude/)
    const r = resolveRefToken("rules/x.md", tmp, null, "backtick");
    check(
      "fixture-09-bare-prefix-tries-claude-first",
      r.ok === true && r.resolvedPath && r.resolvedPath.endsWith(".claude/rules/x.md"),
      `got r=${JSON.stringify(r)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-10-journal-resolve-prefix
// ------------------------------------------------------------------
// Build a temp journal dir with `0150-DECISION-foo.md`; resolveJournalToken
// for `journal/0150` MUST match (NNNN-prefix glob), and `journal/9999` MUST NOT.
{
  const tmp = join(tmpdir(), `xref-fix-10-${Date.now()}`);
  try {
    mkdirSync(join(tmp, "journal"), { recursive: true });
    writeFileSync(join(tmp, "journal", "0150-DECISION-foo.md"), "# foo");
    const hit = resolveJournalToken("journal/0150", tmp);
    const miss = resolveJournalToken("journal/9999", tmp);
    check(
      "fixture-10-journal-resolve-prefix",
      hit.ok === true && miss.ok === false && miss.reason === "journal-entry-not-found",
      `hit=${JSON.stringify(hit)} miss=${JSON.stringify(miss)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-11-anchor-stripping
// ------------------------------------------------------------------
// `journal/0150-foo.md#section` extracts token `journal/0150-foo.md` (the
// regex char-class excludes `#`); the section anchor is NOT verified per
// Phase-1 exclusion. Pinned to prevent regex drift in future edits.
{
  const text = "see `journal/0150-foo.md` and `journal/0150-foo` and [x](rules/foo.md#section)";
  const findings = extractTokens(text, "test.md");
  const tokens = findings.map((f) => f.token).sort();
  check(
    "fixture-11-anchor-stripping",
    tokens.length === 3 &&
      tokens.includes("journal/0150-foo.md") &&
      tokens.includes("journal/0150-foo") &&
      tokens.includes("rules/foo.md") && // md-link strips the `#section` anchor
      !tokens.some((t) => t.includes("#")),
    `got tokens=${JSON.stringify(tokens)}`,
  );
}

// ------------------------------------------------------------------
// fixture-12-crlf-line-endings
// ------------------------------------------------------------------
// split(/\r?\n/) handles CRLF; verify no token corruption.
{
  const text = "first line `rules/a.md`\r\nsecond line `rules/b.md`\r\n";
  const findings = extractTokens(text, "test.md");
  const tokens = findings.map((f) => f.token).sort();
  const lines = findings.map((f) => f.line).sort();
  check(
    "fixture-12-crlf-line-endings",
    tokens.length === 2 &&
      tokens.includes("rules/a.md") &&
      tokens.includes("rules/b.md") &&
      lines[0] === 1 &&
      lines[1] === 2,
    `got tokens=${JSON.stringify(tokens)} lines=${JSON.stringify(lines)}`,
  );
}

// ------------------------------------------------------------------
// fixture-13-tilde-fence
// ------------------------------------------------------------------
// `~~~` fences are stripped exactly like ` ``` ` fences.
{
  const text = [
    "see `rules/outside.md`",
    "~~~",
    "this `rules/inside-tilde.md` is illustrative",
    "~~~",
    "and `rules/after-tilde.md`",
  ].join("\n");
  const findings = extractTokens(text, "test.md");
  const tokens = findings.map((f) => f.token).sort();
  check(
    "fixture-13-tilde-fence",
    tokens.length === 2 &&
      tokens.includes("rules/outside.md") &&
      tokens.includes("rules/after-tilde.md") &&
      !tokens.includes("rules/inside-tilde.md"),
    `got tokens=${JSON.stringify(tokens)}`,
  );
}

// ------------------------------------------------------------------
// fixture-14-path-traversal-guard
// ------------------------------------------------------------------
// Malicious md-link token `../../../../etc/passwd` MUST NOT resolve to
// a path outside repoRoot. Security-reviewer MEDIUM-1.
{
  const tmp = join(tmpdir(), `xref-fix-14-${Date.now()}`);
  try {
    mkdirSync(join(tmp, "source-dir"), { recursive: true });
    writeFileSync(join(tmp, "source-dir", "source.md"), "source");
    // Even if `../../../../etc/passwd` exists on disk, the validator MUST
    // refuse to confirm by clamping candidates to repoRoot.
    const result = resolveRefToken(
      "../../../../../etc/passwd",
      tmp,
      "source-dir/source.md",
      "md-link",
    );
    check(
      "fixture-14-path-traversal-guard",
      result.ok === false && result.reason === "not-found",
      `got result=${JSON.stringify(result)} — traversal NOT blocked`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-15-extended-placeholders
// ------------------------------------------------------------------
// Reviewer MEDIUM-4: isPlaceholder also rejects ${VAR}, %(var)s forms.
{
  check(
    "fixture-15-extended-placeholders",
    isPlaceholder("${API_KEY}") &&
      isPlaceholder("%(var)s") &&
      isPlaceholder("rules/${NAME}.md") &&
      !isPlaceholder("rules/foo.md") &&
      !isPlaceholder("skills/percent-100.md"),
    `placeholder extension broken`,
  );
}

// ------------------------------------------------------------------
// fixture-16-cross-cli-dispatcher (FC, journal/0186)
// ------------------------------------------------------------------
// isCrossCliDispatcher skips the Codex dispatcher token family bin/coc /
// bin/coc-<phase> (anchored ^bin/coc(-[a-z0-9-]+)?$) and NOTHING ELSE.
{
  check(
    "fixture-16-cross-cli-dispatcher",
    isCrossCliDispatcher("bin/coc") === true &&
      isCrossCliDispatcher("bin/coc-analyze") === true &&
      isCrossCliDispatcher("bin/cocktail.mjs") === false &&
      isCrossCliDispatcher("bin/codex.mjs") === false &&
      isCrossCliDispatcher("bin/coc.mjs") === false &&
      isCrossCliDispatcher("bin/emit.mjs") === false,
    `cross-cli dispatcher token classification broken`,
  );
}

// ------------------------------------------------------------------
// fixture-17-default-scope-excludes-audit-fixtures (FC, journal/0186)
// ------------------------------------------------------------------
// audit-fixtures/ is NOT a default SCAN SOURCE (synthetic test corpora);
// still reachable via explicit --scope. The other four trees stay in default.
{
  check(
    "fixture-17-default-scope-excludes-audit-fixtures",
    !DEFAULT_SCOPE_DIRS.some((d) => d.includes("audit-fixtures")) &&
      DEFAULT_SCOPE_DIRS.includes(".claude/rules") &&
      DEFAULT_SCOPE_DIRS.includes(".claude/skills") &&
      DEFAULT_SCOPE_DIRS.includes(".claude/commands") &&
      DEFAULT_SCOPE_DIRS.includes(".claude/agents"),
    `DEFAULT_SCOPE_DIRS scope set incorrect`,
  );
}

// ------------------------------------------------------------------
process.stdout.write(`\n${passed}/${passed + failed} fixtures pass\n`);
process.exit(failed === 0 ? 0 : 1);
