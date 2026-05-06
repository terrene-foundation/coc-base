#!/usr/bin/env node
// tools/lint-workspaces.js — cross-CLI artifact hygiene lint
//
// Detects CC-native syntax leaks (delegation, tool names, hook events,
// baseline-file references) in workspace artifacts that should be CLI-neutral.
// Per .claude/rules/cross-cli-artifact-hygiene.md.
//
// Usage:   node tools/lint-workspaces.js <path>...
// Exit:    0 if no findings, 1 if findings (advisory).
// Output:  one line per finding: <file>:<line>: <pattern> — <snippet>
//          summary line: "<N> findings" or "0 findings"
//
// Patterns reused from workspaces/multi-cli-coc/fixtures/slot-markers/emitter.mjs:279-301

const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────
// Patterns — each entry: [regex, label]
// Labels appear verbatim in lint output for grep-ability.
// ─────────────────────────────────────────────────────────────────
const PATTERNS = [
  // MUST 1 — Delegation syntax CLI-neutral
  [/Agent\([^)]*subagent_type/, "agent-subagent-type"],
  [/Agent\([^)]*run_in_background/, "agent-run-in-background"],
  [/Agent\(\{[^}]*subagent_type/, "agent-object-subagent-type"],
  [/\bisolation:\s*"worktree"/, "agent-isolation-worktree"],
  [/\bTaskCreate\b/, "task-create"],
  [/\bTaskUpdate\b/, "task-update"],
  [/\bExitPlanMode\b/, "exit-plan-mode"],

  // MUST 2 — Tool names neutral
  [/\bRead tool\b/, "tool-noun-read"],
  [/\bWrite tool\b/, "tool-noun-write"],
  [/\bEdit tool\b/, "tool-noun-edit"],
  [/\bBash tool\b/, "tool-noun-bash"],
  [/\bGrep tool\b/, "tool-noun-grep"],
  [/\bGlob tool\b/, "tool-noun-glob"],

  // MUST 4 — Hook event names neutral
  [/\bSessionStart\b/, "hook-event-session-start"],
  [/\bSessionEnd\b/, "hook-event-session-end"],
  [/\bPreToolUse\b/, "hook-event-pre-tool-use"],
  [/\bPostToolUse\b/, "hook-event-post-tool-use"],
  [/\bUserPromptSubmit\b/, "hook-event-user-prompt-submit"],
  [/\bPreCompact\b/, "hook-event-pre-compact"],

  // MUST 3 — CLI baseline file authority references
  [/\.claude\/(agents|skills|commands)\b/, "cli-baseline-path"],
  [/\bCLAUDE\.md\b/, "cli-baseline-claude-md"],
  [/\bAGENTS\.md\b/, "cli-baseline-agents-md"],
  [/\bGEMINI\.md\b/, "cli-baseline-gemini-md"],
];

// ─────────────────────────────────────────────────────────────────
// Allowlist — lines containing any of these substrings are skipped.
// Captures the qualified-historical-citation pattern from MUST 5.
// ─────────────────────────────────────────────────────────────────
const HISTORICAL_QUALIFIERS = [
  "(historical)",
  "(historical citation)",
  "<!-- cli-portable-exception -->",
];

function isHistoricallyQualified(line) {
  const lower = line.toLowerCase();
  return HISTORICAL_QUALIFIERS.some((q) => lower.includes(q.toLowerCase()));
}

// ─────────────────────────────────────────────────────────────────
// Walk: enumerate *.md files under each input path. Skip _archive/_template.
// ─────────────────────────────────────────────────────────────────
function walk(root, out) {
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (root.endsWith(".md")) out.push(root);
    return;
  }
  if (!stat.isDirectory()) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "_archive" || e.name === "_template") continue;
    if (e.name === "node_modules") continue;
    walk(path.join(root, e.name), out);
  }
}

// ─────────────────────────────────────────────────────────────────
// Lint one file. Returns array of {file, line, label, snippet}.
// ─────────────────────────────────────────────────────────────────
function lintFile(file) {
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = content.split("\n");
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isHistoricallyQualified(line)) continue;
    for (const [re, label] of PATTERNS) {
      if (re.test(line)) {
        findings.push({
          file,
          line: i + 1,
          label,
          snippet: line.trim().slice(0, 120),
        });
      }
    }
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      "usage: node tools/lint-workspaces.js <path>... (workspaces/, briefs/, fixture dir)",
    );
    process.exit(2);
  }

  const files = [];
  for (const a of args) walk(a, files);

  let total = 0;
  for (const f of files) {
    const findings = lintFile(f);
    for (const find of findings) {
      console.log(`${find.file}:${find.line}: ${find.label} — ${find.snippet}`);
      total++;
    }
  }
  console.log(`${total} findings`);
  process.exit(total === 0 ? 0 : 1);
}

main();
