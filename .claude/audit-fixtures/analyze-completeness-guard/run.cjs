#!/usr/bin/env node
/**
 * Audit-fixture runner for analyze-completeness-guard (loom#675).
 *
 * Per cc-artifacts.md Rule 9: one case per scope-restriction predicate the gate
 * relies on. Inline-runner variant (the runner contract — assert expected vs
 * actual + non-zero exit on mismatch — is the load-bearing primitive; the
 * storage layout is operator-choice).
 *
 * Exercises the PURE decision function decideAnalyzeGate({repoDir, toolName,
 * skillName, args}) against built temp workspace trees — deterministic, no git,
 * no stdin, no process spawn.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { decideAnalyzeGate } = require(
  path.join(__dirname, "..", "..", "hooks", "analyze-completeness-guard.js"),
);

// --- temp-tree builder -------------------------------------------------------

function mkRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "acg-fixture-"));
}

// Create a tree dir; populate with a real .md when `filled`, else leave a
// .gitkeep'd EMPTY tree (mirrors a real scaffolded-but-unpopulated workspace).
function tree(repoDir, rel, filled) {
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(abs, { recursive: true });
  if (filled) {
    fs.writeFileSync(path.join(abs, "01-content.md"), "# content\n");
  } else {
    fs.writeFileSync(path.join(abs, ".gitkeep"), "");
  }
}

// --- cases: one per scope-restriction predicate ------------------------------

const CASES = [
  {
    name: "block (a non-user-flows tree empty → gate fires on ANY tree)",
    predicate: "block",
    build(repoDir) {
      tree(repoDir, "workspaces/proj/01-analysis", true);
      tree(repoDir, "workspaces/proj/02-plans", false); // EMPTY
      tree(repoDir, "workspaces/proj/03-user-flows", true);
      tree(repoDir, "specs", true); // root specs satisfies specs/
    },
    input: { toolName: "Skill", skillName: "todos", args: "" },
    expect: { action: "block", emptyTrees: ["02-plans"] },
  },
  {
    name: "user-flows-missing (the originating loom#675 case)",
    predicate: "user-flows-missing",
    build(repoDir) {
      tree(repoDir, "workspaces/proj/01-analysis", true);
      tree(repoDir, "workspaces/proj/02-plans", true);
      tree(repoDir, "workspaces/proj/03-user-flows", false); // EMPTY
      tree(repoDir, "specs", true);
    },
    input: { toolName: "Skill", skillName: "todos", args: "" },
    expect: { action: "block", emptyTrees: ["03-user-flows"] },
  },
  {
    name: "pass (every compulsory tree populated)",
    predicate: "pass",
    build(repoDir) {
      tree(repoDir, "workspaces/proj/01-analysis", true);
      tree(repoDir, "workspaces/proj/02-plans", true);
      tree(repoDir, "workspaces/proj/03-user-flows", true);
      tree(repoDir, "workspaces/proj/specs", true);
    },
    input: { toolName: "Skill", skillName: "implement", args: "" },
    expect: { action: "pass" },
  },
  {
    name: "dual-location-specs (ws-local specs empty, repo-root specs satisfies)",
    predicate: "dual-location-specs",
    build(repoDir) {
      tree(repoDir, "workspaces/proj/01-analysis", true);
      tree(repoDir, "workspaces/proj/02-plans", true);
      tree(repoDir, "workspaces/proj/03-user-flows", true);
      tree(repoDir, "workspaces/proj/specs", false); // EMPTY ws-local specs
      tree(repoDir, "specs", true); // root specs satisfies the OR
    },
    input: { toolName: "Skill", skillName: "todos", args: "" },
    expect: { action: "pass" },
  },
  {
    name: "fresh-workspace (analysis not started — every ws-local tree empty)",
    predicate: "fresh-workspace",
    build(repoDir) {
      tree(repoDir, "workspaces/proj/01-analysis", false);
      tree(repoDir, "workspaces/proj/02-plans", false);
      tree(repoDir, "workspaces/proj/03-user-flows", false);
      tree(repoDir, "workspaces/proj/specs", false);
      tree(repoDir, "specs", true); // root specs populated — MUST NOT make it "started"
    },
    input: { toolName: "Skill", skillName: "todos", args: "" },
    expect: { action: "pass" },
  },
  {
    name: "non-advance-skill (/redteam not gated even when incomplete)",
    predicate: "non-advance-skill",
    build(repoDir) {
      tree(repoDir, "workspaces/proj/01-analysis", true);
      tree(repoDir, "workspaces/proj/02-plans", true);
      tree(repoDir, "workspaces/proj/03-user-flows", false); // EMPTY but skill is not advancing
      tree(repoDir, "specs", true);
    },
    input: { toolName: "Skill", skillName: "redteam", args: "" },
    expect: { action: "pass" },
  },
  {
    name: "escape-hatch (03-user-flows/00-no-user-flows.md documented rationale satisfies)",
    predicate: "documented-no-user-flows",
    build(repoDir) {
      tree(repoDir, "workspaces/proj/01-analysis", true);
      tree(repoDir, "workspaces/proj/02-plans", true);
      const uf = path.join(repoDir, "workspaces/proj/03-user-flows");
      fs.mkdirSync(uf, { recursive: true });
      fs.writeFileSync(
        path.join(uf, "00-no-user-flows.md"),
        "# No user flows\nPure back-end refactor; no user-facing surface.\n",
      );
      tree(repoDir, "specs", true);
    },
    input: { toolName: "Skill", skillName: "todos", args: "" },
    expect: { action: "pass" },
  },
  {
    name: "explicit-arg selects the named complete workspace over a NEWER incomplete sibling",
    predicate: "explicit-arg-selection",
    build(repoDir) {
      tree(repoDir, "workspaces/target/01-analysis", true);
      tree(repoDir, "workspaces/target/02-plans", true);
      tree(repoDir, "workspaces/target/03-user-flows", true);
      tree(repoDir, "specs", true);
      tree(repoDir, "workspaces/newest/01-analysis", true);
      tree(repoDir, "workspaces/newest/02-plans", true);
      tree(repoDir, "workspaces/newest/03-user-flows", false); // EMPTY → incomplete
      // newest-mtime sibling is the INCOMPLETE one; explicit arg must override it.
      fs.utimesSync(path.join(repoDir, "workspaces/target"), 1000, 1000);
      fs.utimesSync(path.join(repoDir, "workspaces/newest"), 2000, 2000);
    },
    input: { toolName: "Skill", skillName: "todos", args: "target" },
    expect: { action: "pass" },
  },
  {
    name: "newest-of-N (no arg) gates the NEWEST workspace even when an older sibling is complete",
    predicate: "newest-of-N-selection",
    build(repoDir) {
      tree(repoDir, "workspaces/target/01-analysis", true);
      tree(repoDir, "workspaces/target/02-plans", true);
      tree(repoDir, "workspaces/target/03-user-flows", true);
      tree(repoDir, "specs", true);
      tree(repoDir, "workspaces/newest/01-analysis", true);
      tree(repoDir, "workspaces/newest/02-plans", true);
      tree(repoDir, "workspaces/newest/03-user-flows", false); // EMPTY
      fs.utimesSync(path.join(repoDir, "workspaces/target"), 1000, 1000);
      fs.utimesSync(path.join(repoDir, "workspaces/newest"), 2000, 2000); // newer → selected
    },
    input: { toolName: "Skill", skillName: "todos", args: "" },
    expect: { action: "block", workspace: "newest", emptyTrees: ["03-user-flows"] },
  },
];

// --- run ---------------------------------------------------------------------

function arrEq(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
}

let failures = 0;
for (const c of CASES) {
  const repoDir = mkRepo();
  try {
    c.build(repoDir);
    const got = decideAnalyzeGate({ repoDir, ...c.input });
    let ok = got.action === c.expect.action;
    if (ok && c.expect.emptyTrees) {
      ok = arrEq(got.emptyTrees, c.expect.emptyTrees);
    }
    if (ok && c.expect.workspace) {
      ok = got.workspace === c.expect.workspace;
    }
    if (ok) {
      console.log(`PASS  [${c.predicate}] ${c.name}`);
    } else {
      failures++;
      console.log(
        `FAIL  [${c.predicate}] ${c.name}\n      expected ${JSON.stringify(c.expect)}\n      got      ${JSON.stringify(got)}`,
      );
    }
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

console.log(`\n${CASES.length - failures}/${CASES.length} fixtures passed`);
process.exit(failures === 0 ? 0 : 1);
