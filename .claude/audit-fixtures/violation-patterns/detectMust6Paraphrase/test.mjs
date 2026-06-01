#!/usr/bin/env node
/*
 * Audit-fixture smoke test for detectMust6Paraphrase
 * (rules/value-prioritization.md MUST-6, F29 — 2026-05-23).
 *
 * Per cc-artifacts.md Rule 9: every detector ships with committed fixtures
 * covering each scope-restriction predicate, plus an executable test that
 * locks behavior.
 *
 * The detector reads from disk (frontmatter + body block-quotes from the
 * journal under inspection; content from cited journals resolved via
 * NNNN-prefix match in journalDir). Each test scaffolds a temp dir layout:
 *   <tmp>/<fixture-name>.md            ← the entry under inspection
 *   <tmp>/0150-<slug>.md               ← cited journal stub
 *   <tmp>/0149-<slug>.md               ← cited journal stub
 *
 * Cited-journal stubs carry fixed content that the fixture's block-quotes
 * may or may not verbatim-match.
 *
 * Run: node .claude/audit-fixtures/violation-patterns/detectMust6Paraphrase/test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOOKS_LIB = path.resolve(
  HERE,
  "..",
  "..",
  "..",
  "hooks",
  "lib",
  "violation-patterns.js",
);
const { detectMust6Paraphrase } = require(HOOKS_LIB);

// Fixed content for cited journals. Each block-quote in a fixture either
// matches a verbatim substring of these (clean) or does not (flag).
// All cited block-quotes are ≥30 chars per MUST6_MIN_QUOTE_CHARS floor.
const CITED_CONTENT = {
  "0150": [
    "---",
    "type: DECISION",
    "date: 2026-05-21",
    "---",
    "",
    "# Value-prioritization MUST-6 — citation discipline",
    "",
    "The rule body now requires that the only valid sources are the user's brief in this session,",
    "an active workspace's briefs/, a journal DECISION entry, a literal user",
    "quote in this session's transcript, or a spec § success criterion the",
    "user authored or approved.",
    "",
    "Verbatim citation closes the F-3.0 S18 + S22 failure modes.",
  ].join("\n"),
  "0149": [
    "---",
    "type: DECISION",
    "date: 2026-05-21",
    "---",
    "",
    "# Codify-lease scope discipline",
    "",
    "Every /codify acquires a lease via acquireCodifyLease({displayId, scopeFiles}).",
    "The lease scope MUST union scopeFiles with MANDATORY_SCOPE automatically;",
    "callers cannot opt out. On conflict, surface the holder's display_id verbatim",
    "and STOP.",
  ].join("\n"),
};

function readFixture(name) {
  return fs.readFileSync(path.join(HERE, name), "utf8");
}

function readExpected(name) {
  const raw = fs.readFileSync(path.join(HERE, name + ".expected"), "utf8").trim();
  return JSON.parse(raw);
}

function setupTempJournal(fixtureName) {
  const tmp = fs.mkdtempSync(path.join(tmpdir(), `f29-must6-${Date.now()}-`));
  const journalPath = path.join(tmp, `0200-DECISION-${fixtureName}.md`);
  fs.writeFileSync(journalPath, readFixture(fixtureName + ".txt"));
  // Always seed cited stubs so the resolver can find them when frontmatter
  // references them. Stubs not referenced by the entry are simply ignored.
  for (const [id, content] of Object.entries(CITED_CONTENT)) {
    fs.writeFileSync(path.join(tmp, `${id}-DECISION-stub.md`), content);
  }
  return { tmp, journalPath };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// `expected` may be `null` (clean) OR an object with rule_id/severity +
// an `unverified` array that names the journal IDs that should appear in
// the finding's evidence string. We compare structurally to keep the
// .expected files small and human-readable.
function assertResult(result, expected, label) {
  if (expected === null) {
    assert.equal(
      result,
      null,
      `${label}: expected null; got ${JSON.stringify(result)}`,
    );
    return;
  }
  assert.notEqual(result, null, `${label}: expected finding; got null`);
  assert.equal(result.rule_id, expected.rule_id, `${label}: rule_id mismatch`);
  assert.equal(result.severity, expected.severity, `${label}: severity mismatch`);
  assert.equal(
    result.detection_layer,
    expected.detection_layer,
    `${label}: detection_layer mismatch`,
  );
  for (const id of expected.unverified) {
    assert.ok(
      result.evidence.includes(id),
      `${label}: evidence missing unverified id ${id}: ${result.evidence}`,
    );
  }
}

const CASES = [
  "flag-paraphrase-no-verbatim",
  "flag-partial-verbatim",
  "clean-all-verbatim",
  "clean-no-references",
  "clean-single-ref-quoted",
  "edge-empty-block-quote",
  // R1 additions:
  "flag-block-form-references", // reviewer M1 / cc-architect MED-1 — YAML-block syntax
  "clean-ref-not-found", // cc-architect MED-1 — cited journal not on disk
  "clean-whitespace-normalized", // analyst FM-E — smart-quote + whitespace normalization
];

for (const name of CASES) {
  test(`detectMust6Paraphrase: ${name}`, () => {
    const { tmp, journalPath } = setupTempJournal(name);
    try {
      const result = detectMust6Paraphrase(journalPath, { journalDir: tmp });
      const expected = readExpected(name);
      assertResult(result, expected, name);
    } finally {
      cleanup(tmp);
    }
  });
}

// FM-D fixture (cross-directory cited-journal resolution): journal lives in
// workspaces/<x>/journal/, cites a root journal/. Real on-disk layout
// (not via journalDir override) so the candidate-dir walker fires.
test("detectMust6Paraphrase: flag-cross-dir-resolution", () => {
  const tmp = fs.mkdtempSync(path.join(tmpdir(), `f29-must6-cross-${Date.now()}-`));
  try {
    // Build repo layout: tmp/journal/ (root) + tmp/workspaces/myws/journal/ (sub)
    const rootJournal = path.join(tmp, "journal");
    const wsJournal = path.join(tmp, "workspaces", "myws", "journal");
    fs.mkdirSync(rootJournal, { recursive: true });
    fs.mkdirSync(wsJournal, { recursive: true });
    // Seed root cited journals — 0150 with content the entry will verbatim-
    // quote; 0149 with content the entry will NOT quote (→ unverified).
    fs.writeFileSync(
      path.join(rootJournal, "0150-DECISION-root.md"),
      CITED_CONTENT["0150"],
    );
    fs.writeFileSync(
      path.join(rootJournal, "0149-DECISION-other-root.md"),
      CITED_CONTENT["0149"],
    );
    const entryPath = path.join(wsJournal, "0042-DECISION-cross-dir-entry.md");
    fs.writeFileSync(
      entryPath,
      [
        "---",
        "type: DECISION",
        "date: 2026-05-23",
        'references: ["0150", "0149"]',
        "---",
        "",
        "# Cross-dir resolution test",
        "",
        "> the only valid sources are the user's brief in this session",
      ].join("\n"),
    );
    // No journalDir override — exercise the in-scope-guard + candidate-dir walker.
    const result = detectMust6Paraphrase(entryPath);
    assert.notEqual(result, null, "expected finding for unverified 0149");
    assert.equal(result.rule_id, "value-prioritization/MUST-6");
    assert.ok(
      result.verified.includes("0150"),
      `expected 0150 verified via cross-dir; got verified=${JSON.stringify(result.verified)}`,
    );
    assert.ok(
      result.unverified.includes("0149"),
      `expected 0149 unverified; got unverified=${JSON.stringify(result.unverified)}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
