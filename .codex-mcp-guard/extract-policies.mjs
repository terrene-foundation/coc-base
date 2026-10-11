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
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import policyOutcome from "./policy-outcome.js";


// Symlink-safe read (O_RDONLY|O_NOFOLLOW, leaf-only guard). extract-policies is
// reachable from the emit lane (emit.mjs:69 → validateMcpBijectionAgainstFixtures
// on every emit incl. dry-run, + wireMcpPolicies scanning the real .claude/hooks/
// tree on real emit), so its settings.json + hook-source reads are part of the
// #569 emit-lane source-read class: a symlink swapped for a scanned source between
// resolution and read raises ELOOP instead of being silently followed. Local
// mirror of the emit.mjs/compose.mjs/coc-manifest/variant-overlay helper.
function safeReadFileSync(filePath, encoding) {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    return fs.readFileSync(fd, encoding);
  } finally {
    fs.closeSync(fd);
  }
}

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
// converts severity:"block" to exit code 2 + permissionDecision "deny") or routes the
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
// hooks are registered per CC matcher (Bash, Edit|Write|NotebookEdit,
// Read). For the MCP-fallback path, we replay PreToolUse
// hooks against the equivalent Codex tool:
//
//   CC tool        | Codex wrapped tools
//   ---------------+---------------------
//   Bash           | shell, unified_exec
//   Edit           | apply_patch
//   Write          | apply_patch
//   MultiEdit      | apply_patch (LEGACY — tool removed from CC ~v2.0.8;
//                    mapping retained so an older consumer settings.json
//                    still carrying MultiEdit in its matcher fans out to
//                    apply_patch instead of silently dropping the edit
//                    lane, the DF-AC6-1 class; journal/0276)
//   NotebookEdit   | apply_patch
//   Read           | (out of scope — README "What's covered vs. not")
//
// A plain PreToolUse matcher is a `|`- or comma-joined SET of CC tools (e.g.
// "Edit|Write|NotebookEdit"); resolution splits the matcher
// and unions each tool's Codex fan-out (matcherToCodexTools below). The
// prior design keyed CC_TO_CODEX_TOOLS by the WHOLE matcher string and
// looked it up verbatim — the DF-AC6-1 root cause: the then-live edit matcher
// "Edit|Write|MultiEdit|NotebookEdit" was not a literal key, so the
// entire edit lane (apply_patch) silently dropped from the extraction.
//
// `CC_TO_CODEX_TOOLS` is retained as the canonical matcher→tool binding
// table for the `multi-operator-coordination.md` §7 / MUST-6 literal
// reference (CC_TO_CODEX_TOOLS["Edit|Write"] = ["apply_patch"]); the
// authoritative resolver the extractor uses is matcherToCodexTools(),
// which reproduces these bindings for ANY matcher permutation.
const CC_TOOL_TO_CODEX = Object.freeze({
  Bash: ["shell", "unified_exec"],
  Edit: ["apply_patch"],
  Write: ["apply_patch"],
  MultiEdit: ["apply_patch"],
  NotebookEdit: ["apply_patch"],
});

// Reference-only table for the multi-operator-coordination.md §7 / MUST-6
// literal citation (CC_TO_CODEX_TOOLS["Edit|Write"] = ["apply_patch"]). NOT a
// resolver input — matcherToCodexTools() is the authoritative resolver. Keys
// are only the matchers the rule actually cites; do NOT add the live 4-tool
// matcher here (it has no literal-reference contract — R1 cc-architect LOW-1).
const CC_TO_CODEX_TOOLS = Object.freeze({
  Bash: ["shell", "unified_exec"],
  "Edit|Write": ["apply_patch"],
  Edit: ["apply_patch"],
  Write: ["apply_patch"],
});

const CODEX_TOOLS = Object.freeze(["shell", "unified_exec", "apply_patch"]);

// Resolve a plain PreToolUse tool list or wildcard to its Codex tool set.
// Robust to tool-order permutations and to new edit-tool additions —
// each CC tool maps independently via CC_TOOL_TO_CODEX. This is the
// structural close of the DF-AC6-1 brittle-exact-match bug. A CC tool with
// NO CC_TOOL_TO_CODEX entry is intentionally SKIPPED (resolves to []), not an
// error — the validator-13 bijection + audit fixtures are the backstop if a
// future CC tool needs a mapping (R1 reviewer LOW-3).
function matcherToCodexTools(matcher) {
  const out = [];
  const text = String(matcher);
  // This compatibility table maps literal CC names; native registration keeps
  // regex evaluation in the engine. Preserve the existing pipe-list mapping.
  const tools = text === "*" ? Object.keys(CC_TOOL_TO_CODEX)
    : text.split(/[|,]/).map((s) => s.trim());
  for (const tool of tools) {
    for (const ct of CC_TOOL_TO_CODEX[tool] || []) {
      if (!out.includes(ct)) out.push(ct);
    }
  }
  return out;
}

// apply_patch (Codex file-edit) is the lane the multi-operator
// COORDINATION substrate (roster / claims / journal-slots / codify-
// branch) must NOT leak into on a non-enrolled Codex consumer. A hook
// registered under a CC edit matcher (Edit/Write/MultiEdit/NotebookEdit)
// fans out to apply_patch ONLY when it carries this opt-in marker —
// declaring it a STATELESS trust gate (posture / 4-eyes / signing) safe
// to replay against a consumer's file-edits WITHOUT that substrate.
//
// The marker lives in the SYNCED hook source, so it is the
// CONSUMER-AVAILABLE selectivity signal (FF-AC6-1 AC#3): the projection
// of sync-manifest's `mcp-guard` lane into the hook itself, because
// sync-manifest.yaml is NOT synced to consumers where this extractor
// regenerates policies.json. The 2026-10-09 orchestrator ruling replaced
// the earlier fail-safe-for-functionality default: every guard runs
// natively on every CLI unless its predicate cannot be computed from a
// Codex edit event, and an EXCLUSION is an exception that must be
// DECLARED — a written reason plus the compensating control that covers
// it on Codex. The coordination guards this comment formerly listed as
// marker-less (adjacency-leasecheck, journal-write-guard, integrity-guard)
// now carry the marker, and a marker-less edit-matcher hook whose
// predicate can refuse is REFUSED here (POLICY-COVERAGE REFUSAL below)
// unless `codex-mcp-guard/policy-exclusions.json` declares it. The
// hook-delivery validator's mirrored-set cross-check
// (validate-emit.mjs::deriveMirroredHookSet) asserts the
// mcp-guard⟺marker bijection at /sync; this refusal is its authoring-time
// sibling, and the two must agree.
//
// The match is ANCHORED to a JSDoc comment LINE — the opt-in must be a
// deliberate ` * @coc-codex-edit-gate` header directive, NOT an incidental
// in-prose mention of the token (R1 security LOW-2). A hook header that merely
// DESCRIBES the exclusion ("this guard omits `@coc-codex-edit-gate`") does not
// match, because the token is not the first non-`*` content on its line — so an
// exclusion-describing coordination guard cannot be silently flipped into the
// gated set.
const CODEX_APPLY_PATCH_GATE_MARKER = /^\s*\*\s*@coc-codex-edit-gate\b/m;

// Typed refusal for an unbuildable matcher map. `code` is the REFUSAL
// IDENTITY — callers and fixtures assert on it rather than on "something
// threw", so a future unrelated exception cannot masquerade as this fence
// firing (nor this fence as an unrelated crash).
export class HookMatcherMapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HookMatcherMapError";
    this.code = code;
  }
}

// Declared policy exclusions (2026-10-09, CODEX-EDIT-LANE WIRING).
// The mirror of the marker: a hook that IS registered under a CC edit
// matcher but must NOT reach the Codex apply_patch lane must SAY SO here —
// a hook, a reason and a compensating control, keyed by hook basename.
// The file ships beside policies.json (`codex-mcp-guard/` next to the
// settings file) so the SAME read works at loom and at every consumer
// where this extractor regenerates the policy table. An ABSENT file means
// no declarations (the policy-coverage refusal then applies); a MALFORMED
// file is a typed refusal — fail closed, because a broken declaration
// must never widen coverage silently (`security.md` § Enforcement-Surface
// Parity: one reader, one shape, never N hand-rolled checks).
export function readPolicyExclusions(settingsPath) {
  const file = path.join(path.dirname(path.resolve(settingsPath)), "codex-mcp-guard", "policy-exclusions.json");
  if (!fs.existsSync(file)) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(safeReadFileSync(file, "utf8"));
  } catch (e) {
    throw new HookMatcherMapError("policy-exclusions-malformed",
      `cannot read declared policy exclusions: ${file} is not valid JSON (${e.code || e.message})`);
  }
  const rows = Array.isArray(parsed && parsed.exclusions) ? parsed.exclusions : null;
  if (!rows) {
    throw new HookMatcherMapError("policy-exclusions-malformed",
      `cannot read declared policy exclusions: ${file} carries no \`exclusions\` array`);
  }
  const map = new Map();
  for (const [index, row] of rows.entries()) {
    const hook = typeof (row && row.hook) === "string" ? row.hook.trim() : "";
    const reason = typeof (row && row.reason) === "string" ? row.reason.trim() : "";
    const control = typeof (row && row.compensating_control) === "string" ? row.compensating_control.trim() : "";
    if (!hook || reason.length < 20 || !control) {
      throw new HookMatcherMapError("policy-exclusions-malformed",
        `cannot read declared policy exclusions: ${file} entry ${index} needs a non-empty \`hook\`, a \`reason\` of at least 20 characters and a non-empty \`compensating_control\``);
    }
    map.set(hook, { reason, compensating_control: control });
  }
  return map;
}

// Build hook-file → CC-matcher map by parsing the project's
// settings.json. Only PreToolUse entries are policy candidates; we
// preserve the matcher so each predicate inherits the correct
// Codex-tool fan-out. A hook file may be registered under multiple
// matchers (e.g. posture-gate.js fires on both Bash and Edit|Write);
// the map values are arrays so the file-level fan-out is complete.
//
// FAIL CLOSED (loom#S73-M5). This function previously degraded to an EMPTY
// map on three separate conditions — settings.json absent, unreadable, or
// unparseable — each returning silently with exit 0. That empty map is the
// SOLE input to the file-level `policies` table, so the degradation
// propagated a silently-empty policy table through `wireMcpPolicies()` into
// the `policies.json` written for every distribution target. An empty policy
// table is indistinguishable from a populated one at every surface between
// here and the consumer, which is what made the failure silent.
//
// The read-failure arm is the ROOT of the class. `safeReadFileSync` opens
// with O_NOFOLLOW precisely so that a symlink swapped in for settings.json
// between resolution and read raises ELOOP instead of being followed (the
// #569 emit-lane source-read class) — and the former `catch { return map; }`
// swallowed that ELOOP into an empty table, defeating the guard it was paired
// with. A read failure therefore ALWAYS refuses, `required` or not: the file
// demonstrably EXISTS and could not be read, and no caller has a legitimate
// reading of that as "nothing matched".
//
// `required: false` is the narrow, EXPLICIT opt-out for a caller that does not
// consume the matcher map at all (the validator-13 shape fixtures, which read
// only `predicates[].shape`). It relaxes ONLY the absent + zero-entry arms.
// The default is `true` so a caller added later inherits the fence rather than
// the degradation.
const DISPATCH_COMMAND_RE = /^node "\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/dispatch\.js" ([A-Za-z]+)(?: --registry-sha256=[0-9a-f]{64})?$/;

// Every command in a settings group that invokes dispatch.js, as
// { index, event } rows ([] when the group carries none). The group-level
// question — "is this a dispatcher entry?" — is `length > 0`, NOT "is the
// dispatcher the group's SOLE command". The original gate recognized the
// consolidation pattern only in its purest form (`hs.length === 1`), so a
// group that ALSO carried a directly-registered hook fell to the
// pass-through arm, injected ZERO registry groups, and still exited 0 — a
// populated-but-SHORT policy table, the one shape the `matcher-map-empty`
// fence cannot see (an empty table and a short one are both "some entries").
// MEASURED 2026-10-09 with one direct hook appended beside the dispatcher:
// the registry cohort vanished from shell/unified_exec and apply_patch went
// to zero, with no refusal anywhere. The multi-hook shapes and both poles are
// locked by `.claude/audit-fixtures/extract-policies/run.mjs`, cited by case
// NAME (numbers re-derive as cases land): "single-hook dispatcher group →
// registry groups injected (live shape, unchanged)", "dispatcher + co-resident
// in ONE group → registry injected AND co-resident has its own policy", "two
// dispatcher commands in one group → registry groups injected ONCE", and the
// RED pole "mixed group + ABSENT registry → typed matcher-map-registry-unreadable".
function dispatcherCommandMatches(group) {
  const hs = (group && group.hooks) || [];
  const matches = [];
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i];
    if (h && typeof h.command === "string") {
      const m = h.command.match(DISPATCH_COMMAND_RE);
      if (m) matches.push({ index: i, event: m[1] });
    }
  }
  return matches;
}

function expandDispatcherEntries(settings, settingsPath) {
  const hooks = settings && settings.hooks;
  if (!hooks || typeof hooks !== "object") return settings;
  const dispatched = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      if (dispatcherCommandMatches(g).length > 0) dispatched.push(event);
    }
  }
  if (dispatched.length === 0) return settings;
  const registryPath = path.join(path.dirname(path.resolve(settingsPath)), "hooks", "dispatch-registry.json");
  let reg;
  try {
    reg = JSON.parse(safeReadFileSync(registryPath, "utf8"));
  } catch (e) {
    throw new HookMatcherMapError(
      "matcher-map-registry-unreadable",
      `cannot build hook matcher map: ${settingsPath} dispatches ${dispatched.join(", ")} through dispatch.js but ` +
        `${registryPath} could not be read/parsed (${e.code || e.message}) — refusing rather than returning a policy ` +
        `table missing every dispatched guard`,
    );
  }
  const out = { ...settings, hooks: {} };
  for (const [event, groups] of Object.entries(hooks)) {
    const next = [];
    for (const g of Array.isArray(groups) ? groups : []) {
      const hs = (g && g.hooks) || [];
      // Consume every dispatcher command naming THIS event; a command naming a
      // DIFFERENT event stays in the residual group, never silently dropped
      // (today's `next.push(g)` behavior for that shape).
      const eventIndexes = dispatcherCommandMatches(g)
        .filter((d) => d.event === event)
        .map((d) => d.index);
      if (eventIndexes.length === 0) {
        next.push(g);
        continue;
      }
      const spec = reg && reg.events && reg.events[event];
      if (!spec || !Array.isArray(spec.groups)) {
        throw new HookMatcherMapError(
          "matcher-map-registry-unreadable",
          `cannot build hook matcher map: ${registryPath} carries no groups for ${event}, which ${settingsPath} dispatches`,
        );
      }
      // Injected ONCE per group even when several of its commands invoke this
      // event's dispatcher: the registry groups are EVENT-scoped, and a second
      // injection would duplicate each registry hook's on_incomplete
      // declaration set that buildHookMatcherMap accumulates per occurrence.
      next.push(...spec.groups);
      // Co-resident direct hooks keep their own policy: a residual group
      // carrying the original matcher (via the spread) and the unconsumed
      // hooks. A group that was the dispatcher ALONE yields no residual, so
      // the live single-hook shape expands exactly as it did before.
      if (eventIndexes.length < hs.length) {
        const consumed = new Set(eventIndexes);
        next.push({ ...g, hooks: hs.filter((_, i) => !consumed.has(i)) });
      }
    }
    out.hooks[event] = next;
  }
  return out;
}

export function buildHookMatcherMap(settingsPath, { required = true } = {}) {
  const map = new Map(); // basename(file) → matcher[]
  map.onIncomplete = new Map();

  if (!fs.existsSync(settingsPath)) {
    if (required) {
      throw new HookMatcherMapError(
        "matcher-map-settings-missing",
        `cannot build hook matcher map: no settings file at ${settingsPath} — ` +
          `refusing rather than returning an empty policy table`,
      );
    }
    return map;
  }

  let rawSettings;
  try {
    rawSettings = safeReadFileSync(settingsPath, "utf8");
  } catch (e) {
    throw new HookMatcherMapError(
      "matcher-map-settings-unreadable",
      `cannot build hook matcher map: ${settingsPath} exists but could not be read ` +
        `(${e.code || e.message}) — refusing rather than returning an empty policy table`,
    );
  }

  let settings;
  try {
    settings = JSON.parse(rawSettings);
  } catch (e) {
    throw new HookMatcherMapError(
      "matcher-map-settings-unparseable",
      `cannot build hook matcher map: ${settingsPath} is not valid JSON (${e.message}) — ` +
        `refusing rather than returning an empty policy table`,
    );
  }

  // A consolidated event registers a `dispatch.js <Event>` entry; the hooks
  // behind it live in <settings dir>/hooks/dispatch-registry.json. Expand them back
  // to the per-hook groups, or every PreToolUse guard would drop out of the Codex
  // policy table (the map would hold only dispatch.js — or, beside a directly
  // registered hook, silently hold only that one). A dispatcher sharing its group
  // with direct registrations is recognized too: the group contributes the
  // registry groups AND a residual group carrying the unconsumed hooks
  // (expandDispatcherEntries::dispatcherCommandMatches). Self-contained on
  // purpose: the registry is READ (same O_NOFOLLOW read as settings.json) and
  // parsed here, never require()d from the scanned tree. A dispatcher entry whose
  // registry cannot be read and parsed REFUSES — never a quietly shrunken table.
  settings = expandDispatcherEntries(settings, settingsPath);

  const pre = settings?.hooks?.PreToolUse || [];
  for (const block of pre) {
    const matcher = block.matcher;
    // Resolve via the per-tool splitter (NOT a verbatim CC_TO_CODEX_TOOLS
    // key lookup) so multi-tool matchers like "Edit|Write|MultiEdit|
    // NotebookEdit" map correctly — the DF-AC6-1 root-cause fix.
    if (!matcher || matcherToCodexTools(matcher).length === 0) continue;
    for (const h of block.hooks || []) {
      // command shape: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<name>.js"`
      const m = (h.command || "").match(/\/hooks\/([\w-]+\.js)/);
      if (!m) continue;
      const arr = map.get(m[1]) || [];
      if (!arr.includes(matcher)) arr.push(matcher);
      map.set(m[1], arr);
      const declarations = map.onIncomplete.get(m[1]) || [];
      declarations.push(h.on_incomplete);
      map.onIncomplete.set(m[1], declarations);
    }
  }

  // Parsed cleanly but resolved NOTHING. Distinct from the arms above: the
  // file was read and is valid JSON, yet no PreToolUse block yielded a single
  // hook→matcher binding. For a caller that consumes this map to build an
  // enforcement table, "parsed fine, zero entries" and "could not build" have
  // the same downstream shape — an empty table — so it refuses here too.
  // The per-block `continue`s above stay deliberately silent: a matcher with
  // no Codex fan-out (e.g. Read, documented out of scope) is a BY-DESIGN skip,
  // not a build failure. This checks the AGGREGATE outcome, which is the level
  // at which the caller's "did it build?" question is actually answerable.
  if (required && map.size === 0) {
    throw new HookMatcherMapError(
      "matcher-map-empty",
      `cannot build hook matcher map: ${settingsPath} parsed successfully but yielded ` +
        `ZERO hook→matcher entries — refusing rather than returning an empty policy table`,
    );
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
  // Fail closed by default (loom#S73-M5). `requireMatcherMap: false` is the
  // explicit opt-out for a caller that reads only `predicates[].shape` and
  // never consumes the matcher map — it MUST be stated at the call site, with
  // a reason, so the relaxation is visible in review rather than inherited.
  const matcherMap = buildHookMatcherMap(settingsPath, {
    required: opts.requireMatcherMap !== false,
  });

  // Per-file apply_patch eligibility (the @coc-codex-edit-gate marker).
  // Built once during the file scan; reused by both the predicate-level
  // codex_tools assignment and the file-level policies table.
  const markerByFile = new Map();

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const source = safeReadFileSync(fullPath, "utf8");
    const functions = findTopLevelFunctions(source);
    const gatesApplyPatch = CODEX_APPLY_PATCH_GATE_MARKER.test(source);
    markerByFile.set(file, gatesApplyPatch);

    for (const fn of functions) {
      const shape = classifyShape(fn, source);
      if (!shape) continue;

      const reason = extractReason(fn);
      // Resolve the CC matchers → Codex tool fan-out for this file.
      // Files not registered as PreToolUse (orchestrators like
      // session-start.js, post-mortem hooks) get an empty
      // `codex_tools` array and are excluded from the per-tool
      // POLICIES table while still appearing in `predicates`.
      // apply_patch is marker-gated: only a hook carrying
      // @coc-codex-edit-gate fans out to the Codex file-edit lane.
      const ccMatchers = matcherMap.get(file) || [];
      const codexTools = [];
      for (const m of ccMatchers) {
        for (const t of matcherToCodexTools(m)) {
          if (t === "apply_patch" && !gatesApplyPatch) continue;
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
  // Per-file refusal-capability facts captured during the ONE fan-out pass,
  // consumed by the policy-coverage refusal below (never re-read: the same
  // capability object the policy rows carry).
  const coverageFacts = new Map();
  // Iterate matcher-map entries → fan-out to Codex tools. Skip files
  // that don't exist in the hook dir (settings.json may reference
  // inactive hooks; the file-level enforcement only applies to
  // scripts present on disk). Dedup by source_file per tool — a
  // single hook registered under both Bash and the edit matcher fans
  // out to (shell, unified_exec, apply_patch) but appears once per
  // tool. apply_patch is marker-gated: a hook reaches the Codex
  // file-edit lane only when it carries @coc-codex-edit-gate.
  for (const [hookFile, matchers] of matcherMap.entries()) {
    const fullPath = path.join(dir, hookFile);
    if (!fs.existsSync(fullPath)) continue;
    const gatesApplyPatch =
      markerByFile.get(hookFile) ??
      CODEX_APPLY_PATCH_GATE_MARKER.test(safeReadFileSync(fullPath, "utf8"));
    const tools = new Set();
    for (const m of matchers) {
      for (const t of matcherToCodexTools(m)) {
        if (t === "apply_patch" && !gatesApplyPatch) continue;
        tools.add(t);
      }
    }
    const capability = policyOutcome.capabilityMetadata(
      matcherMap.onIncomplete.get(hookFile) || [], safeReadFileSync(fullPath, "utf8"));
    if (capability.drift) throw new HookMatcherMapError("capability-drift",
      `${hookFile}: registry can_deny=${capability.registry_can_deny} differs from source scan can_deny=${capability.source_can_deny}`);
    coverageFacts.set(hookFile, {
      canDeny: capability.can_deny,
      registryCanDeny: capability.registry_can_deny,
      sourceCanDeny: capability.source_can_deny,
    });
    for (const tool of tools) {
      if (!policies[tool]) continue;
      if (policies[tool].some((e) => e.source_file === hookFile)) continue;
      policies[tool].push({
        source_file: hookFile,
        cc_matchers: matchers,
        can_deny: capability.can_deny,
        // Capability and outcome semantics: policy-outcome.js:3-68.
        invocation: "subprocess",
      });
    }
  }

  // ────────────────────────────────────────────────────────────────
  // POLICY-COVERAGE REFUSAL (2026-10-09, CODEX-EDIT-LANE WIRING)
  // ────────────────────────────────────────────────────────────────
  // The orchestrator ruling: every guard runs natively on every CLI; an
  // exclusion is an exception that must be DECLARED — a reason plus the
  // compensating control that covers it on Codex — never an omission.
  // An edit-matcher hook whose predicate can refuse (`can_deny !== false`:
  // registry declaration or source scan, and UNKNOWN reads as can-deny) and
  // which resolves to ZERO apply_patch policy entries REFUSES the extraction
  // unless `codex-mcp-guard/policy-exclusions.json` names it. PARTIAL
  // coverage counts: a Bash+edit dual-registered hook that keeps shell /
  // unified_exec entries while its apply_patch entry is marker-gated away
  // was previously invisible here — the union-of-all-tools check could not
  // see the edit-lane omission at all (Round-1 correctness finding,
  // 2026-10-09; the widened predicate is the fix, and its live partial
  // instances — provenance-capture-tool, adjacency-heartbeat — are declared
  // rows, not silent exemptions). Scope is the EDIT lane only (a matcher
  // that fans out to apply_patch): hooks whose registrations name no mapped
  // Codex tool (Read / Task / Skill matchers) are outside this check by
  // construction — the exclusions file still RECORDS their reasons, and the
  // hook_delivery labels remain the shipped declaration for the non-edit lanes.
  const declaredExclusions = readPolicyExclusions(settingsPath);
  const applyPatchFiles = new Set((policies.apply_patch || []).map((entry) => entry.source_file));
  for (const [hookFile, matchers] of matcherMap.entries()) {
    if (applyPatchFiles.has(hookFile)) continue;
    if (!fs.existsSync(path.join(dir, hookFile))) continue;
    if (!matchers.some((m) => matcherToCodexTools(m).includes("apply_patch"))) continue;
    const facts = coverageFacts.get(hookFile);
    if (!facts || facts.canDeny === false) continue;
    if (declaredExclusions.has(hookFile)) continue;
    const otherTools = CODEX_TOOLS.filter((t) => (policies[t] || []).some((e) => e.source_file === hookFile));
    throw new HookMatcherMapError(
      "policy-coverage-gap",
      `${hookFile}: edit-matcher hook with refusal capability (registry_can_deny=${facts.registryCanDeny}, source_can_deny=${facts.sourceCanDeny}) resolves to ZERO apply_patch policy entries${otherTools.length ? ` (it keeps ${otherTools.join("/")} coverage, so the omission is PARTIAL and was authoring-time silent)` : ""} and carries no declared exclusion — add \`@coc-codex-edit-gate\` to the hook, or declare it in codex-mcp-guard/policy-exclusions.json with a reason and its compensating control`,
    );
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

  // The CLI is the artifact-WRITING path (--write-policies feeds policies.json,
  // which every distribution target consumes), so it takes the fail-closed
  // default. A typed refusal is reported as a clean, named diagnostic + exit 2
  // rather than an unhandled stack trace: the caller that matters here is
  // validate-emit.mjs::checkCodexPoliciesFresh, which spawns this as a
  // subprocess and correctly FAILs the freshness gate on non-zero exit.
  let out;
  try {
    out = extractPolicies(dir, settingsPath ? { settingsPath } : {});
  } catch (e) {
    if (e instanceof HookMatcherMapError) {
      process.stderr.write(`extract-policies: ${e.code}: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }

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
//
// BOTH operands go through the SAME resolver — resolveEntryPath() below is
// applied to `process.argv[1]` and to this module's own path alike. That
// symmetry is the whole point, because how much resolving Node has ALREADY
// done differs between its two startup modes (both measured, via a symlinked
// directory):
//
//   mode                        import.meta.url   process.argv[1]
//   default                     realpath'd        NOT realpath'd
//   --preserve-symlinks-main    NOT realpath'd    NOT realpath'd
//
// So resolving only ONE side is correct for exactly one of those modes and
// silently wrong for the other, in the same direction each time:
//   - Default + naive `import.meta.url === \`file://${process.argv[1]}\``:
//     FALSE whenever this script is invoked through a SYMLINKED directory
//     component — and at every multi-CLI delivery target (the only targets
//     that receive this tree) `.claude/codex-mcp-guard` IS a symlink to
//     `../.codex-mcp-guard` (`.claude/sync-manifest.yaml`, `symlinks:`).
//   - --preserve-symlinks-main + resolving only argv[1]: argv[1] becomes the
//     real path while import.meta.url stays the symlinked one, so the compare
//     fails again. That flag is reachable from NODE_OPTIONS, i.e. with nothing
//     on the command line to show for it.
//
// Getting this wrong is SILENT by construction, which is why it is worth the
// symmetry: the documented regeneration command — `node
// .claude/codex-mcp-guard/extract-policies.mjs …`, the exact string
// checkCodexPoliciesFresh prints as its remediation — simply no-ops, with exit
// 0, empty stdout, policies.json untouched, and the freshness gate still
// reporting STALE with no reachable fix. validate-emit.mjs worked around this
// for its OWN exec by calling realpathSync() first; the printed remediation had
// no such workaround, so instrument and remedy disagreed.
//
// Comparing OS-native paths (fileURLToPath on the URL side) rather than URL
// strings additionally sidesteps percent-encoding: `file://${...}` does not
// encode spaces or non-ASCII, so the naive form also no-opped on any checkout
// path containing a space.
//
// Precedent for the resolve-both-sides form: .claude/bin/cc-cost.mjs.

// The one resolver, used on both operands. An unresolvable path falls back to
// its raw form rather than throwing: this module is IMPORTED as well as run --
// emit.mjs pulls it in dynamically (`await import(...)`, emit.mjs:187) and
// test-extract-policies.mjs statically -- so a throw out here, at module top
// level, would take the emit lane down at import time rather than merely
// answering "was I run directly?". The fallback cannot yield a false positive:
// a path that will not resolve cannot be THIS file, which is demonstrably
// resolvable since it is currently executing.
function resolveEntryPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isDirectInvocation() {
  // `node -e …`, `node --eval`, and the REPL leave argv[1] undefined. Absent an
  // entry path the answer is simply "not invoked directly".
  const entry = process.argv[1];
  if (!entry) return false;
  let self;
  try {
    self = fileURLToPath(import.meta.url);
  } catch {
    // Non-`file:` module URL (data:, http:) — not a direct CLI invocation.
    return false;
  }
  // Do not collapse this back to the naive
  // `import.meta.url === \`file://${process.argv[1]}\`` form, and do not drop
  // either resolveEntryPath() call: each one covers a mode the other does not.
  return resolveEntryPath(entry) === resolveEntryPath(self);
}

if (isDirectInvocation()) {
  main();
}
