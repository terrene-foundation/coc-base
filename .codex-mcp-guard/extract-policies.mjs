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
// Directory walker
// ────────────────────────────────────────────────────────────────

export function extractPolicies(dir) {
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".js"))
    .map((d) => d.name)
    .sort();

  const predicates = [];

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const source = fs.readFileSync(fullPath, "utf8");
    const functions = findTopLevelFunctions(source);

    for (const fn of functions) {
      const shape = classifyShape(fn, source);
      if (!shape) continue;

      const reason = extractReason(fn);
      predicates.push({
        id: fn.name,
        shape,
        source_file: file,
        reason_raw: reason,
        reason_template: normalizeReasonTemplate(reason),
        reject_condition_shape: {
          A: "process.exit(N>=2) in function body",
          B: "returns { exitCode: N>=2, ... } consumed by caller's process.exit(result.exitCode)",
          C: "returns { isError: true, content: [...] }",
        }[shape],
      });
    }
  }

  return {
    version: 1,
    extracted_at: new Date().toISOString(),
    source_dir: dir,
    predicates,
  };
}

// ────────────────────────────────────────────────────────────────
// CLI entry
// ────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    process.stderr.write(
      "usage: extract-policies.mjs <hook-dir> [--json | --pretty]\n",
    );
    process.exit(2);
  }

  const dir = args[0];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    process.stderr.write(`extract-policies: not a directory: ${dir}\n`);
    process.exit(2);
  }

  const mode = args[1] === "--json" ? "json" : "pretty";
  const out = extractPolicies(dir);

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
