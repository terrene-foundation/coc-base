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

const { extractPolicies, buildHookMatcherMap, HookMatcherMapError } =
  await import(pathToFileURL(EXTRACTOR).href);

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

// ────────────────────────────────────────────────────────────────
// P6–P11 — matcher-map FAIL-CLOSED fence (loom#S73-M5)
// ────────────────────────────────────────────────────────────────
// buildHookMatcherMap previously degraded to an EMPTY Map on a missing,
// unreadable, or unparseable settings.json, and that empty map is the sole
// input to the file-level `policies` table — so a silently-empty policy table
// propagated to every distribution target, indistinguishable from a populated
// one at every surface in between.
//
// BIPOLAR by construction: the RED poles assert the REFUSAL IDENTITY (the
// typed error + its `code`), never merely "something threw" — an unrelated
// TypeError must NOT score as the fence firing. The GREEN poles prove the
// fence did not simply break the happy path, and that the narrow explicit
// opt-out the validator-13 shape fixtures depend on still returns cleanly.

// Capture the refusal identity. Returns the error's class name + code, so a
// case can assert on WHICH refusal fired rather than on the mere fact of a
// throw.
function refusalOf(fn) {
  try {
    fn();
    return { threw: false, typed: false, code: null };
  } catch (e) {
    return {
      threw: true,
      typed: e instanceof HookMatcherMapError,
      name: e?.name,
      code: e?.code ?? null,
    };
  }
}

// Scratch root carrying a real hooks dir; each case supplies its own settings.
const fx = fs.mkdtempSync(path.join(os.tmpdir(), "extract-policies-failclosed-"));
try {
  const hooksDir = path.join(fx, ".claude", "hooks");
  fs.mkdirSync(path.join(hooksDir, "lib"), { recursive: true });
  for (const [name, body] of Object.entries(HOOKS)) {
    fs.writeFileSync(path.join(hooksDir, name), body);
  }
  fs.writeFileSync(
    path.join(hooksDir, "lib", "instruct-and-wait.js"),
    "module.exports = { emit() {} };\n",
  );

  const goodSettings = path.join(fx, "good-settings.json");
  fs.writeFileSync(goodSettings, JSON.stringify(SETTINGS, null, 2));

  // P6 — RED: settings.json ABSENT under the fail-closed default.
  const r6 = refusalOf(() =>
    buildHookMatcherMap(path.join(fx, "does-not-exist.json")),
  );
  check("06", "absent settings → typed matcher-map-settings-missing",
    r6.typed && r6.code === "matcher-map-settings-missing",
    `typed=${r6.typed} code=${r6.code}`);

  // P7 — RED: settings.json present but NOT valid JSON.
  const badJson = path.join(fx, "unparseable-settings.json");
  fs.writeFileSync(badJson, "{ this is not json ");
  const r7 = refusalOf(() => buildHookMatcherMap(badJson));
  check("07", "unparseable settings → typed matcher-map-settings-unparseable",
    r7.typed && r7.code === "matcher-map-settings-unparseable",
    `typed=${r7.typed} code=${r7.code}`);

  // P8 — RED: parses cleanly, yields ZERO hook→matcher bindings. The arm that
  // catches a structurally-valid settings.json whose PreToolUse set resolves
  // to nothing — the case that reads most like success.
  const emptySettings = path.join(fx, "empty-settings.json");
  fs.writeFileSync(emptySettings, JSON.stringify({ hooks: { PreToolUse: [] } }));
  const r8 = refusalOf(() => buildHookMatcherMap(emptySettings));
  check("08", "zero-entry settings → typed matcher-map-empty",
    r8.typed && r8.code === "matcher-map-empty",
    `typed=${r8.typed} code=${r8.code}`);

  // P9 — RED: settings path is a SYMLINK. safeReadFileSync opens O_NOFOLLOW
  // so this raises ELOOP — the #569 emit-lane source-read class the guard
  // exists to surface, and exactly what the former `catch { return map; }`
  // swallowed into an empty table. existsSync FOLLOWS the link (so this is
  // NOT the absent arm); the open then refuses to.
  const linkSettings = path.join(fx, "linked-settings.json");
  fs.symlinkSync(goodSettings, linkSettings);
  const r9 = refusalOf(() => buildHookMatcherMap(linkSettings));
  check("09", "symlinked settings (O_NOFOLLOW/ELOOP) → typed matcher-map-settings-unreadable",
    r9.typed && r9.code === "matcher-map-settings-unreadable",
    `typed=${r9.typed} code=${r9.code}`);

  // P10 — GREEN: a well-formed settings.json still builds, through the REAL
  // entry point, with a populated policy table. Proves the fence did not
  // break the happy path.
  let green = { ok: false, detail: "did not run" };
  try {
    const res = extractPolicies(hooksDir, { settingsPath: goodSettings });
    const total = Object.values(res.policies).reduce((a, p) => a + p.length, 0);
    green = { ok: total > 0, detail: `policy entries=${total}` };
  } catch (e) {
    green = { ok: false, detail: `threw ${e?.name}: ${e?.code ?? e?.message}` };
  }
  check("10", "well-formed settings still builds a POPULATED table (fence spares happy path)",
    green.ok, green.detail);

  // P11 — GREEN: the narrow explicit opt-out. requireMatcherMap:false is what
  // the validator-13 shape fixtures pass (they read predicates[].shape only
  // and have no sibling settings.json); it must still return cleanly.
  let optOut = { ok: false, detail: "did not run" };
  try {
    const m = buildHookMatcherMap(path.join(fx, "does-not-exist.json"), {
      required: false,
    });
    optOut = { ok: m instanceof Map && m.size === 0, detail: `map.size=${m.size}` };
  } catch (e) {
    optOut = { ok: false, detail: `threw ${e?.name}: ${e?.code ?? e?.message}` };
  }
  check("11", "explicit requireMatcherMap:false opt-out returns cleanly",
    optOut.ok, optOut.detail);
} finally {
  fs.rmSync(fx, { recursive: true, force: true });
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
