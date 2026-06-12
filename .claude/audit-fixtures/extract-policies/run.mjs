#!/usr/bin/env node
/*
 * Audit fixtures for `.claude/codex-mcp-guard/extract-policies.mjs` —
 * the FF-AC6-1 marker-gating + multi-tool-matcher-resolution predicates.
 *
 * Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md`
 * MUST-4: one fixture per scope-restriction predicate the extractor
 * relies on. The predicates exercised here:
 *
 *   P1  Bash matcher          → shell + unified_exec (never apply_patch)
 *   P2  edit matcher + MARKER  → apply_patch (the @coc-codex-edit-gate
 *                                stateless-trust-gate opt-in, FF-AC6-1 AC#1)
 *   P3  edit matcher, NO marker → EXCLUDED from apply_patch (the cc-only
 *                                coordination-guard exclusion, FF-AC6-1 AC#2)
 *   P4  multi-tool matcher
 *       "Edit|Write|MultiEdit|NotebookEdit" resolves (the DF-AC6-1
 *       brittle-exact-match root-cause regression guard). The matcher
 *       deliberately KEEPS the removed-from-CC MultiEdit token: loom's
 *       own settings.json dropped it (journal/0276), but an OLDER
 *       consumer's settings may still carry it — this fixture locks the
 *       legacy MultiEdit→apply_patch fan-out in matcherToCodexTools()
 *       so stale consumer matchers never silently drop the edit lane.
 *   P5  dual registration (Bash + edit matcher) + MARKER → all three
 *       tools; the marker gates ONLY the apply_patch portion
 *
 * Structural probe (per `rules/probe-driven-verification.md` MUST-3):
 * file-level set membership of the extractor's `policies` output —
 * exit code is the signal, no lexical scan of prose.
 *
 * Invocation:  node .claude/audit-fixtures/extract-policies/run.mjs
 * Exit 0 = all cases pass; 1 = at least one regression.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTOR = path.resolve(
  HERE,
  "..",
  "..",
  "codex-mcp-guard",
  "extract-policies.mjs",
);

const { extractPolicies } = await import(pathToFileURL(EXTRACTOR).href);

// Synthetic hooks. Each carries a Shape-D predicate (severity:"block"
// consumed by emit()) so it is a realistic policy candidate; the
// MARKER comment is the only difference between a stateless gate and a
// coordination guard.
const MARKER = "@coc-codex-edit-gate";
function hookBody(name, withMarker) {
  return `#!/usr/bin/env node
/**
 * ${name}${withMarker ? `\n * ${MARKER} — stateless trust gate; fans out to apply_patch.` : ""}
 */
const { emit } = require("./lib/instruct-and-wait.js");
function guard(payload) {
  return { severity: "block", reason: "${name} fired" };
}
const out = guard({});
emit({ severity: out.severity });
`;
}

const SETTINGS = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/bash-gate.js"' },
        ],
      },
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [
          { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/stateless-edit-gate.js"' },
          { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/coordination-guard.js"' },
          { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/dual-gate.js"' },
        ],
      },
      // dual-gate is ALSO registered under Bash (P5).
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/dual-gate.js"' },
        ],
      },
    ],
  },
};

const HOOKS = {
  "bash-gate.js": hookBody("bash-gate", false), // P1: Bash matcher, no marker
  "stateless-edit-gate.js": hookBody("stateless-edit-gate", true), // P2: edit + marker
  "coordination-guard.js": hookBody("coordination-guard", false), // P3: edit, no marker
  "dual-gate.js": hookBody("dual-gate", true), // P5: Bash+edit + marker
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extract-policies-fx-"));
  const hooksDir = path.join(root, ".claude", "hooks");
  fs.mkdirSync(path.join(hooksDir, "lib"), { recursive: true });
  for (const [name, body] of Object.entries(HOOKS)) {
    fs.writeFileSync(path.join(hooksDir, name), body);
  }
  // Minimal lib stub so the hook bodies are syntactically resolvable if
  // ever required(); the extractor only reads source, never executes.
  fs.writeFileSync(
    path.join(hooksDir, "lib", "instruct-and-wait.js"),
    "module.exports = { emit() {} };\n",
  );
  fs.writeFileSync(
    path.join(root, ".claude", "settings.json"),
    JSON.stringify(SETTINGS, null, 2),
  );
  return { root, hooksDir, settingsPath: path.join(root, ".claude", "settings.json") };
}

function filesFor(policies, tool) {
  return new Set((policies[tool] || []).map((e) => e.source_file));
}

const cases = [];
function check(id, name, cond, detail) {
  cases.push({ id, name, pass: !!cond, detail });
}

const { root, hooksDir, settingsPath } = setup();
try {
  const res = extractPolicies(hooksDir, { settingsPath });
  const shell = filesFor(res.policies, "shell");
  const unified = filesFor(res.policies, "unified_exec");
  const apply = filesFor(res.policies, "apply_patch");

  // P1 — Bash matcher → shell + unified_exec, NEVER apply_patch.
  check("01", "bash-gate→shell/unified_exec only",
    shell.has("bash-gate.js") && unified.has("bash-gate.js") && !apply.has("bash-gate.js"),
    `shell=${shell.has("bash-gate.js")} unified=${unified.has("bash-gate.js")} apply=${apply.has("bash-gate.js")}`);

  // P2 — edit matcher + MARKER → apply_patch (AC#1).
  check("02", "stateless-edit-gate (marker)→apply_patch",
    apply.has("stateless-edit-gate.js") && !shell.has("stateless-edit-gate.js"),
    `apply=${apply.has("stateless-edit-gate.js")}`);

  // P3 — edit matcher, NO marker → EXCLUDED from apply_patch (AC#2).
  check("03", "coordination-guard (no marker) EXCLUDED from apply_patch",
    !apply.has("coordination-guard.js"),
    `apply=${apply.has("coordination-guard.js")} (MUST be false)`);

  // P4 — the 4-tool matcher resolved at all (DF-AC6-1 regression guard):
  //      if it had silently dropped, apply_patch would be empty.
  check("04", "multi-tool edit matcher resolves (DF-AC6-1 guard)",
    apply.size > 0,
    `apply_patch entries=${apply.size}`);

  // P5 — dual registration + marker → shell + unified_exec + apply_patch.
  check("05", "dual-gate (Bash+edit+marker)→all three tools",
    shell.has("dual-gate.js") && unified.has("dual-gate.js") && apply.has("dual-gate.js"),
    `shell=${shell.has("dual-gate.js")} unified=${unified.has("dual-gate.js")} apply=${apply.has("dual-gate.js")}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

let failed = 0;
for (const c of cases) {
  const tag = c.pass ? "PASS" : "FAIL";
  if (!c.pass) failed++;
  process.stdout.write(`${tag}  ${c.id}  ${c.name}  [${c.detail}]\n`);
}
process.stdout.write(
  `\n${cases.length - failed}/${cases.length} cases pass\n`,
);
process.exit(failed === 0 ? 0 : 1);
