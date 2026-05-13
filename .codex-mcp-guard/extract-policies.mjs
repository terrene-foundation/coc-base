#!/usr/bin/env node
/*
 * Validator 13 — hook predicate extractor (spec v6 §4.4).
 *
 * Reads a directory of hook JS files and emits a POLICIES-shape JSON
 * enumerating every "predicate function" per the v6 three-shape
 * contract. Consumed by /sync at emission time to populate
 * .codex-mcp-guard/server.js POLICIES + flip POLICIES_POPULATED true.
 *
 * Bijection invariant: every predicate function in the hook source
 * MUST appear in the output with exactly one entry. Missing or extra
 * entries HARD BLOCK sync per spec v6 §4.4.
 *
 * Acceptance fixture: workspaces/multi-cli-coc/fixtures/validator-13/
 * (shape-a / shape-b / shape-c + expected-policies.json).
 *
 * Usage:
 *   node extract-policies.mjs <hook-dir> [--json | --pretty]
 *
 * Parse strategy: regex + brace-depth counting. This matches the
 * approach in workspaces/multi-cli-coc/fixtures/slot-markers/emitter.mjs's
 * extractPredicateFunctions(). A proper AST upgrade path (via acorn or
 * @babel/parser) is a Phase F follow-up if real-world hook complexity
 * outgrows the regex approach; the fixtures define the current contract.
 */

import fs from "node:fs";
import path from "node:path";

// ────────────────────────────────────────────────────────────────
// Top-level function enumeration
// ────────────────────────────────────────────────────────────────
// Top-level = declared at column 0. Matches three JS forms:
//   function foo(...)
//   const foo = function(...)
//   const foo = (...) =>  /  const foo = async (...) =>
function findTopLevelFunctions(source) {
  const lines = source.split("\n");
  const functions = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // function foo(...) OR async function foo(...)
    let m = line.match(/^(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/);
    if (m) {
      functions.push({ name: m[1], startLine: i, kind: "function" });
      continue;
    }

    // const foo = function(...) OR const foo = async function(...)
    m = line.match(/^const\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\(/);
    if (m) {
      functions.push({ name: m[1], startLine: i, kind: "named-expr" });
      continue;
    }

    // const foo = (...) => OR const foo = async (...) =>
    m = line.match(/^const\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?\(/);
    if (m) {
      functions.push({ name: m[1], startLine: i, kind: "arrow" });
      continue;
    }
  }

  // Resolve each function's body span by brace-depth counting.
  for (const fn of functions) {
    let depth = 0;
    let opened = false;
    fn.endLine = fn.startLine;
    fn.bodyLines = [];

    for (let i = fn.startLine; i < lines.length; i++) {
      const line = lines[i];
      fn.bodyLines.push(line);
      for (const ch of line) {
        if (ch === "{") {
          depth++;
          opened = true;
        } else if (ch === "}") {
          depth--;
        }
      }
      if (opened && depth === 0) {
        fn.endLine = i;
        break;
      }
    }
    fn.body = fn.bodyLines.join("\n");
  }

  return functions;
}

// ────────────────────────────────────────────────────────────────
// Shape classification (spec v6 §4.4)
// ────────────────────────────────────────────────────────────────

// Shape A: body contains process.exit(N) with N >= 2 literal.
function matchesShapeA(fn) {
  const matches = [...fn.body.matchAll(/process\.exit\(\s*(\d+)\s*\)/g)];
  return matches.some((m) => parseInt(m[1], 10) >= 2);
}

// Shape C: body ends with return { isError: true, content: [...] }.
// Permissive match — any return containing isError: true counts, since
// the spec text allows the shape anywhere control flow returns it.
function matchesShapeC(fn) {
  return /return\s*\{\s*isError:\s*true/.test(fn.body);
}

// Shape D: body returns { severity: "block", ... } and at least one caller
// in the same file consumes the return through `instructAndWait(...)` (which
// converts severity:"block" to exit code 2 + continue:false) or routes the
// returned `severity` field into a callee that exits.
//
// This is the canonical hook-output-discipline.md MUST-1 shape — every halting
// hook MUST emit through `lib/instruct-and-wait.js::instructAndWait()` /
// `emit()`. validate-bash-command.js's validateBashCommand and similar hook
// predicates produce severity:"block" returns wrapped at the hook script's
// stdin-end handler. Pre-Shard-B, none of these were classified as policies
// because the v6 §4.4 shape vocabulary (A/B/C) predates instruct-and-wait
// landing 2026-05-05.
function matchesShapeD(fn, wholeFileSource) {
  // Step 1: function body contains `severity: "block"` literal in a return
  // statement context. Quote variants accepted: 'block' or "block". The
  // predicate must produce the literal "block" — not a variable that might
  // resolve to "block" at runtime — so that the structural classification
  // is grep-derivable without dataflow analysis.
  if (!/\breturn\b/.test(fn.body)) return false;
  if (!/severity:\s*['"]block['"]/.test(fn.body)) return false;

  // Step 2: at least one caller in the same file pumps THIS predicate's
  // return through `instructAndWait(...)` or `emit(...)` from
  // `lib/instruct-and-wait.js`. Two accepted forms (mirrors Shape B):
  //   (a) Captured: const|let|var <v> = <fnName>(...); ... instructAndWait({ severity: <v>... })
  //   (b) Captured: const|let|var <v> = <fnName>(...); ... emit({ severity: <v>... })
  //   (c) Inline: instructAndWait({ ...<fnName>(...) }) / emit({ ...<fnName>(...) })
  //
  // The caller-check distinguishes Shape D from a function that happens
  // to construct {severity: "block", ...} but never reaches the exit
  // pathway. Same structural defense as Shape B's process.exit caller-
  // check.
  const nameEsc = fn.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // (c) Inline: instructAndWait({ ...<fnName>(...) }) or emit({ ...<fnName>(...) })
  const inlinePattern = new RegExp(
    `(?:instructAndWait|emit)\\s*\\(\\s*\\{[^}]*\\b${nameEsc}\\s*\\(`,
  );
  if (inlinePattern.test(wholeFileSource)) return true;

  // (a)/(b) Captured: find every `const|let|var <v> = <fnName>(`, then
  // check the rest of the file for `instructAndWait(`/`emit(` whose
  // argument object spreads or references <v>.
  const capturePattern = new RegExp(
    `\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*${nameEsc}\\s*\\(`,
    "g",
  );
  let m;
  while ((m = capturePattern.exec(wholeFileSource)) !== null) {
    const varName = m[1];
    const afterAssign = wholeFileSource.slice(m.index + m[0].length);
    // Match instructAndWait({ ...<varName>... }) — spread, property,
    // or any reference inside the call's first argument object.
    const wrapPattern = new RegExp(
      `(?:instructAndWait|emit)\\s*\\(\\s*\\{[\\s\\S]*?\\b${varName}\\b`,
    );
    if (wrapPattern.test(afterAssign)) return true;
    // Also match severity-field access from the captured var:
    // process.stdout.write(JSON.stringify(out.json)) where out = instructAndWait(<v>)
    // — handled by inline pattern when nested.
  }

  return false;
}

// Shape B: body returns { exitCode: N, ... } with N >= 2 literal, AND
// at least one caller in the SAME FILE passes that return into
// process.exit(<field>) or process.exit(<captured>.exitCode).
//
// The caller-check is what distinguishes Shape B from a plain result-
// dict function that never gets consumed as an exit code. It's also the
// reason the v5 Shape-A-only definition matched 0 of 13 real hooks.
function matchesShapeB(fn, wholeFileSource) {
  // Step 1: function body contains an `exitCode:` field where a literal
  // N>=2 is reachable at that position. Two reachable forms per v6 §4.4:
  //   (a) direct literal:         exitCode: 2
  //   (b) expression w/ literal:  exitCode: shouldBlock ? 2 : 0
  // The expression form is "N >= 2 via a variable that is assignable from
  // a literal >= 2 elsewhere in the function" — for ternaries and simple
  // assignments, proximity of a standalone digit >=2 on the same RHS is
  // the cheapest correct heuristic. Require at least one `return` statement
  // so the exitCode is structurally a return-value shape.
  if (!/\breturn\b/.test(fn.body)) return false;
  //   direct literal form: exitCode: 2 | exitCode: 10 | ...
  const directLiteral = [...fn.body.matchAll(/\bexitCode:\s*(\d+)/g)].some(
    (m) => parseInt(m[1], 10) >= 2,
  );
  //   expression form: any `exitCode:` RHS up to `,` or `}` that contains
  //   a standalone digit >=2. Matches ternaries, binary exprs, variables
  //   initialised from a literal >=2 on the same line.
  const expressionLiteral = [
    ...fn.body.matchAll(/\bexitCode:\s*([^,}]+?)(?=[,}])/g),
  ].some((m) => /\b([2-9]|\d{2,})\b/.test(m[1]));
  if (!directLiteral && !expressionLiteral) return false;

  // Step 2: at least one caller in the same file routes THIS predicate's
  // return into process.exit(). Two accepted forms:
  //   (a) Inline:   process.exit(<fnName>(...).exitCode)
  //   (b) Captured: const|let|var <v> = <fnName>(...); ... process.exit(<v>...)
  //
  // The file-global check from v5 (any process.exit with any predicate
  // name anywhere) was over-permissive — a hostile hook could define
  // a predicate that LOOKS like Shape B, have an unrelated function in
  // the same file satisfy the process.exit requirement, and get
  // classified as a policy without its return ever firing. This v6.1
  // tightening requires per-predicate data flow.
  const nameEsc = fn.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // (a) Inline: process.exit(<fnName>(...)…)
  const inlinePattern = new RegExp(
    `process\\.exit\\s*\\([^)]*\\b${nameEsc}\\s*\\(`,
  );
  if (inlinePattern.test(wholeFileSource)) return true;

  // (b) Captured: find every `const|let|var <v> = <fnName>(`, then check
  //     the rest of the file for `process.exit(<v>` (exact var match).
  const capturePattern = new RegExp(
    `\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*${nameEsc}\\s*\\(`,
    "g",
  );
  let m;
  while ((m = capturePattern.exec(wholeFileSource)) !== null) {
    const varName = m[1];
    const afterAssign = wholeFileSource.slice(m.index + m[0].length);
    const exitPattern = new RegExp(`process\\.exit\\s*\\(\\s*${varName}\\b`);
    if (exitPattern.test(afterAssign)) return true;
  }

  return false;
}

function classifyShape(fn, wholeFileSource) {
  if (matchesShapeA(fn)) return "A";
  if (matchesShapeC(fn)) return "C";
  if (matchesShapeB(fn, wholeFileSource)) return "B";
  if (matchesShapeD(fn, wholeFileSource)) return "D";
  return null;
}

// ────────────────────────────────────────────────────────────────
// Reason extraction
// ────────────────────────────────────────────────────────────────
// Reason is the string literal after `reason:` in the function body.
// Matches all three shapes (each has a `reason:` in the block payload).
function extractReason(fn) {
  const m = fn.body.match(/reason:\s*(['"`])([^'"`]+)\1/);
  if (m) return m[2];
  // Shape C uses content: [{ type: "text", text: "..." }] — fall back.
  const cm = fn.body.match(/text:\s*(['"`])([^'"`]+)\1/);
  if (cm) return cm[2];
  return null;
}

// Strip parenthetical suffixes like "(Shape A fixture)" to match the
// expected-policies.json reason_template field, which is the canonical
// form without fixture annotations.
function normalizeReasonTemplate(raw) {
  if (!raw) return null;
  return raw.replace(/\s*\([^)]*(?:fixture|Shape [ABC])[^)]*\)\s*$/i, "").trim();
}

// ────────────────────────────────────────────────────────────────
// CC matcher → Codex tool mapping
// ────────────────────────────────────────────────────────────────
//
// Codex's tool surface differs from CC's. The `.claude/settings.json`
// hooks are registered per CC matcher (Bash, Edit|Write, Read). For
// the MCP-fallback path, we replay PreToolUse hooks against the
// equivalent Codex tool:
//
//   CC matcher     | Codex wrapped tools
//   ---------------+---------------------
//   Bash           | shell, unified_exec
//   Edit|Write     | apply_patch
//   Read           | (out of scope — README "What's covered vs. not")
//
// A hook file may map to multiple Codex tools when its CC matcher
// ("Bash") fans out to several Codex primitives. The same predicate
// fires on every fan-out target.
const CC_TO_CODEX_TOOLS = Object.freeze({
  Bash: ["shell", "unified_exec"],
  "Edit|Write": ["apply_patch"],
  Edit: ["apply_patch"],
  Write: ["apply_patch"],
});

const CODEX_TOOLS = Object.freeze(["shell", "unified_exec", "apply_patch"]);

// Build hook-file → CC-matcher map by parsing the project's
// settings.json. Only PreToolUse entries are policy candidates; we
// preserve the matcher so each predicate inherits the correct
// Codex-tool fan-out. A hook file may be registered under multiple
// matchers (e.g. posture-gate.js fires on both Bash and Edit|Write);
// the map values are arrays so the file-level fan-out is complete.
function buildHookMatcherMap(settingsPath) {
  const map = new Map(); // basename(file) → matcher[]
  if (!fs.existsSync(settingsPath)) return map;
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return map;
  }
  const pre = settings?.hooks?.PreToolUse || [];
  for (const block of pre) {
    const matcher = block.matcher;
    if (!matcher || !CC_TO_CODEX_TOOLS[matcher]) continue;
    for (const h of block.hooks || []) {
      // command shape: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<name>.js"`
      const m = (h.command || "").match(/\/hooks\/([\w-]+\.js)/);
      if (!m) continue;
      const arr = map.get(m[1]) || [];
      if (!arr.includes(matcher)) arr.push(matcher);
      map.set(m[1], arr);
    }
  }
  return map;
}

// ────────────────────────────────────────────────────────────────
// Directory walker
// ────────────────────────────────────────────────────────────────

export function extractPolicies(dir, opts = {}) {
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".js"))
    .map((d) => d.name)
    .sort();

  const predicates = [];

  // Resolve settings.json path for hook-matcher map. Default: dir's
  // grandparent + .claude/settings.json (i.e. <repo>/.claude/settings.json
  // when dir is .claude/hooks/). Caller may override via opts.settingsPath.
  const settingsPath =
    opts.settingsPath ||
    path.resolve(dir, "..", "settings.json");
  const matcherMap = buildHookMatcherMap(settingsPath);

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const source = fs.readFileSync(fullPath, "utf8");
    const functions = findTopLevelFunctions(source);

    for (const fn of functions) {
      const shape = classifyShape(fn, source);
      if (!shape) continue;

      const reason = extractReason(fn);
      // Resolve the CC matchers → Codex tool fan-out for this file.
      // Files not registered as PreToolUse (orchestrators like
      // session-start.js, post-mortem hooks) get an empty
      // `codex_tools` array and are excluded from the per-tool
      // POLICIES table while still appearing in `predicates`.
      const ccMatchers = matcherMap.get(file) || [];
      const codexTools = [];
      for (const m of ccMatchers) {
        for (const t of CC_TO_CODEX_TOOLS[m] || []) {
          if (!codexTools.includes(t)) codexTools.push(t);
        }
      }

      predicates.push({
        id: fn.name,
        shape,
        source_file: file,
        cc_matchers: ccMatchers,
        codex_tools: codexTools,
        reason_raw: reason,
        reason_template: normalizeReasonTemplate(reason),
        reject_condition_shape: {
          A: "process.exit(N>=2) in function body",
          B: "returns { exitCode: N>=2, ... } consumed by caller's process.exit(result.exitCode)",
          C: "returns { isError: true, content: [...] }",
          D: 'returns { severity: "block", ... } consumed by instructAndWait()/emit() per hook-output-discipline.md MUST-1',
        }[shape],
      });
    }
  }

  // Build per-Codex-tool policy table consumed by server.js.
  //
  // Two-level enumeration:
  //   1. Predicate-level (functions matched by Shape A/B/C). Useful
  //      for AST audits and the validator-13 bijection check, but the
  //      MCP server cannot CALL a sub-function directly across process
  //      boundaries — hook scripts read stdin and own their exit
  //      semantics.
  //   2. File-level (every PreToolUse hook script registered under a
  //      Bash / Edit|Write matcher). The server spawns the WHOLE
  //      script as a subprocess per CC's documented hook contract;
  //      the script's exit code is what we honor.
  //
  // Both shapes are emitted: `policies_predicates` is the
  // shape-classified per-tool list; `policies` is the file-level
  // executable list the server consumes. The latter is the source
  // of truth for `POLICIES_POPULATED=true` because it directly drives
  // subprocess invocation.
  const policiesPredicates = Object.fromEntries(CODEX_TOOLS.map((t) => [t, []]));
  for (const p of predicates) {
    for (const tool of p.codex_tools) {
      if (!policiesPredicates[tool]) continue;
      policiesPredicates[tool].push({
        id: p.id,
        source_file: p.source_file,
        shape: p.shape,
        reason_template: p.reason_template,
      });
    }
  }

  const policies = Object.fromEntries(CODEX_TOOLS.map((t) => [t, []]));
  // Iterate matcher-map entries → fan-out to Codex tools. Skip files
  // that don't exist in the hook dir (settings.json may reference
  // inactive hooks; the file-level enforcement only applies to
  // scripts present on disk). Dedup by source_file per tool — a
  // single hook registered under both Bash and Edit|Write fans out
  // to (shell, unified_exec, apply_patch) but appears once per tool.
  for (const [hookFile, matchers] of matcherMap.entries()) {
    const fullPath = path.join(dir, hookFile);
    if (!fs.existsSync(fullPath)) continue;
    const tools = new Set();
    for (const m of matchers) {
      for (const t of CC_TO_CODEX_TOOLS[m] || []) tools.add(t);
    }
    for (const tool of tools) {
      if (!policies[tool]) continue;
      if (policies[tool].some((e) => e.source_file === hookFile)) continue;
      policies[tool].push({
        source_file: hookFile,
        cc_matchers: matchers,
        // Subprocess invocation contract: spawn `node <source_file>`,
        // pipe synthesized PreToolUse JSON to stdin, read exit code:
        // 0 = allow, 2 = deny, other = warn (treated as allow).
        invocation: "subprocess",
      });
    }
  }

  return {
    version: 1,
    extracted_at: new Date().toISOString(),
    source_dir: dir,
    predicates,
    policies,
    policies_predicates: policiesPredicates,
  };
}

// ────────────────────────────────────────────────────────────────
// CLI entry
// ────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    process.stderr.write(
      "usage: extract-policies.mjs <hook-dir> [--json | --pretty] [--write-policies <out.json>] [--settings <path>]\n",
    );
    process.exit(2);
  }

  const dir = args[0];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    process.stderr.write(`extract-policies: not a directory: ${dir}\n`);
    process.exit(2);
  }

  // Parse remaining args.
  let mode = "pretty";
  let writePoliciesPath = null;
  let settingsPath = null;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") mode = "json";
    else if (a === "--pretty") mode = "pretty";
    else if (a === "--write-policies") writePoliciesPath = args[++i];
    else if (a === "--settings") settingsPath = args[++i];
  }

  const out = extractPolicies(dir, settingsPath ? { settingsPath } : {});

  if (writePoliciesPath) {
    // Persist the per-tool policies table on its own. server.js
    // loads this at startup; bijection invariant is checked separately
    // via test-extract-policies.mjs. Timestamp is intentionally
    // omitted from the persisted file so deterministic regeneration
    // doesn't churn the artifact on every /sync.
    const payload = {
      version: out.version,
      source_dir: out.source_dir,
      policies: out.policies,
    };
    fs.writeFileSync(writePoliciesPath, JSON.stringify(payload, null, 2) + "\n");
    const total = Object.values(out.policies).reduce((a, p) => a + p.length, 0);
    process.stderr.write(
      `extract-policies: wrote ${writePoliciesPath} (${total} policy entries across ${Object.keys(out.policies).length} tools)\n`,
    );
  }

  if (mode === "json") {
    process.stdout.write(JSON.stringify(out) + "\n");
  } else {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  }
}

// Only run main when invoked directly, not when imported as a module.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
