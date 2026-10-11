#!/usr/bin/env node
// The process-spawning-harness scrub: FIRST import, per the harness contract.
import "../_lib/no-ambient-git.cjs";
/**
 * ============================================================================
 *  hook-registry fixture battery — BIPOLAR, per predicate
 * ============================================================================
 *
 *  Every case PAIRS an accept pole with a reject pole, because a check that has
 *  never been shown to fire is not evidence (instrument-discipline.md MUST-3)
 *  and a fixture that only ever passes cannot show it fires. Each reject case
 *  asserts the EXACT error text it expects, so a failure of the FIXTURE (the
 *  instrument stopped firing) is distinguishable from a failure of the SUBJECT
 *  (the emitter regressed).
 *
 *  WHAT IT DRIVES
 *    - the emitter, against SYNTHETIC minimal roots under a mktemp dir — the
 *      real tree is never mutated, and `--root` keeps every write inside the
 *      scratch root (conservation-gate MUST-5: scratch is asked for).
 *    - the contract CLI for document-level cases (unknown major, version/$id
 *      mismatch, content-hash tamper, duplicate (event,order), prototype keys,
 *      additionalProperties, crash/timeout weakening, SessionStart severity).
 *    - the JCS vector file for canonicalization known-answers.
 *
 *  RUN
 *    node .claude/audit-fixtures/hook-registry/run.mjs
 *  Exit codes: 0 = every case passed, 1 = at least one failed.
 * ============================================================================
 */

import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const EMITTER = path.join(REPO, ".claude", "bin", "emit-hook-registry.mjs");
const CONTRACT = path.join(REPO, ".claude", "hooks", "lib", "hook-registry-contract.js");
const SAMPLE = path.join(HERE, "sample-trestle-base.manifest.json");
const VECTORS = path.join(HERE, "jcs-vectors.json");
const ZERO_SHA = "0".repeat(40);
const require_ = createRequire(import.meta.url);

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "hook-registry-fixtures-"));
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, args, { encoding: "utf8", cwd: opts.cwd || REPO, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { rc: null, out: r.stdout || "", err: `${r.err ? r.err.toString() : ""}${r.error.message}` };
  return { rc: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// ── synthetic roots ─────────────────────────────────────────────────────────

const VALID_BLOCK = `/**
 * Fixture hook.
 *
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [".claude/learning/fixture.jsonl"],
 *     "network": false,
 *     "spawns": []
 *   },
 *   "idempotent": true,
 *   "may_rewrite_input": false
 * }
 */
`;

const DISPATCH_STUB = `"use strict";
// Fixture stand-in for the CC dispatcher: the runtime pin walks its closure.
module.exports = { boot() {} };
`;
const CODEX_STUB = `"use strict";
// Fixture stand-in for the Codex adapter.
const HANDLERS = ["./fixture-hook.js"];
module.exports = { HANDLERS };
`;

function makeRoot(spec) {
  const root = fs.mkdtempSync(path.join(SCRATCH, "root-"));
  const hooksDir = path.join(root, ".claude", "hooks");
  fs.mkdirSync(path.join(hooksDir, "lib"), { recursive: true });
  // Runtime entries are PINNED, so every fixture root carries them.
  fs.writeFileSync(path.join(hooksDir, "dispatch.js"), DISPATCH_STUB);
  fs.writeFileSync(path.join(hooksDir, "lib", "codex-hook-runtime.js"), CODEX_STUB);
  // The THIRD runtime entry (the spawn-by-path supervisor). Every root carries
  // it for the same reason as the other two: runtime entries are pinned, and an
  // emit refuses when one is missing — which is exactly what happened to every
  // fixture the moment this entry was added.
  fs.writeFileSync(path.join(hooksDir, "lib", "local-supervisor.js"), '"use strict";\nmodule.exports = { supervise() {} };\n');
  fs.writeFileSync(path.join(hooksDir, "fixture-hook.js"), spec.hook);
  const rows = spec.events || [{ event: "PreToolUse", matcher: "Bash", onIncomplete: "deny" }];
  const events = {};
  const settingsHooks = {};
  if (spec.direct) {
    fs.writeFileSync(path.join(hooksDir, spec.direct.file), spec.direct.hook);
    settingsHooks[spec.direct.event] = [
      { matcher: spec.direct.matcher, hooks: [{ type: "command", command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${spec.direct.file}"`, timeout: 5 }] },
    ];
  }
  for (const r of rows) {
    events[r.event] = events[r.event] || { dispatcher: { matcher: "*", timeout: 30 }, groups: [] };
    const group = { hooks: [] };
    if (r.matcher) group.matcher = r.matcher;
    const hook = { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/fixture-hook.js"', timeout: 7 };
    if (r.onIncomplete !== null && r.onIncomplete !== undefined) hook.on_incomplete = r.onIncomplete;
    if (r.onTimeout !== undefined && r.onTimeout !== null) hook.on_timeout = r.onTimeout;
    group.hooks.push(hook);
    events[r.event].groups.push(group);
    settingsHooks[r.event] = [
      ...(settingsHooks[r.event] || []),
      { matcher: "*", hooks: [{ type: "command", command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.js" ${r.event}`, timeout: 30 }] },
    ];
  }
  fs.writeFileSync(path.join(hooksDir, "dispatch-registry.json"), JSON.stringify({ schema: 1, events }, null, 2));
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ hooks: settingsHooks }, null, 2));
  // Registration surfaces: the emitter refuses an emit when an EXPECTED one is
  // absent, so a fixture root that wants a normal emit carries all of them.
  if (!spec.omitCodex) {
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node .claude/hooks/lib/codex-hook-runtime.js --native-policy" }] }] } }, null, 2));
  }
  if (!spec.omitGemini) {
    fs.mkdirSync(path.join(root, ".gemini"), { recursive: true });
    fs.writeFileSync(path.join(root, ".gemini", "settings.json"), JSON.stringify({ hooks: { BeforeTool: [{ matcher: "bash", hooks: [{ type: "command", command: "node $GEMINI_PROJECT_DIR/.claude/hooks/fixture-hook.js" }] }] } }, null, 2));
  }
  return root;
}

/**
 * @param {string|null} sourceSha pass null to let the emitter resolve HEAD —
 *   the synthetic roots are not git repos, so a sentinel sha keeps the
 *   non-git cases independent of git; the drift cases need the real one.
 */
function emit(root, extra = [], sourceSha = ZERO_SHA) {
  const out = path.join(root, "out.manifest.json");
  const args = [EMITTER, "--root", root, "--target", "fixture", "--all-rows"];
  if (sourceSha) args.push("--source-sha", sourceSha);
  args.push("--out", out, ...extra);
  const r = run(args);
  return { ...r, outPath: out };
}

function readOut(outPath) {
  try {
    return JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch {
    return null;
  }
}

function jsonReport(err) {
  const line = err.split("\n").find((l) => l.startsWith("{"));
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function validateDoc(doc, name) {
  const p = path.join(SCRATCH, `doc-${name}.json`);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  const r = run([CONTRACT, "validate", p]);
  return { ...r, path: p };
}

const sample = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
const clone = () => JSON.parse(JSON.stringify(sample));

const NAMES = [
  "01-valid-minimal-emits (ACCEPT pole for 02-12)",
  "02-missing-block-refused (REJECT)",
  "03-malformed-block-refused (REJECT)",
  "04-unknown-block-key-refused (REJECT)",
  "05-partial-cost-refused (REJECT)",
  "06-complete-cost-accepted (ACCEPT pole for 05)",
  "07-spawn-contradiction-refused (REJECT)",
  "08-spawn-declared-accepted (ACCEPT pole for 07)",
  "09-empty-fs-writes-contradiction-refused (REJECT)",
  "10-unknown-write-locator-refused (REJECT)",
  "11-legal-external-locator-accepted (ACCEPT pole for 10)",
  "12-network-contradiction-refused (REJECT)",
  "13-network-declared-accepted (ACCEPT pole for 12)",
  "14-rewrite-contradiction-refused (REJECT)",
  "15-rewrite-declared-accepted (ACCEPT pole for 14)",
  "16-posttooluse-null-incomplete-refused (REJECT)",
  "17-pretooluse-null-incomplete-accepted (ACCEPT pole for 16)",
  "18-deny-capable-pretooluse-is-deny-deny (H3 policy)",
  "19-direct-registered-deny-capable-still-deny (H3 + override surfaced)",
  "20-dispatched-deny-capable-twin-denies (ACCEPT pole for 19)",
  "21-timeout-exemption-required (REJECT)",
  "22-timeout-exemption-declared-accepted (ACCEPT pole for 21)",
  "23-unknown-event-refused (REJECT)",
  "24-plan-target-mismatch-refused (REJECT)",
  "25-local-registry-source-restriction-refused (REJECT)",
  "26-local-registry-row-is-repo-local-pool-repo (ACCEPT pole for 25)",
  "27-dynamic-require-refused (REJECT)",
  "28-dynamic-require-exempted-accepted (ACCEPT pole for 27)",
  "29-symlinked-hook-refused (REJECT)",
  "30-absent-surface-source-refused (REJECT)",
  "31-absent-surface-declared-accepted (ACCEPT pole for 30)",
  "32-zero-rows-refused (REJECT)",
  "33-fail-open-row-named (registration weaker than the host)",
  "34-unknown-major-refused (REJECT)",
  "35-known-major-accepted (ACCEPT pole for 34)",
  "36-version-id-major-mismatch-refused (REJECT)",
  "37-content-hash-tamper-refused (REJECT)",
  "38-content-hash-recomputes (ACCEPT pole for 37)",
  "39-duplicate-event-order-refused (REJECT)",
  "40-unique-event-order-accepted (ACCEPT pole for 39)",
  "41-duplicate-row-id-refused (REJECT)",
  "42-crash-weaker-than-incomplete-refused (REJECT)",
  "43-pool-mismatch-refused (REJECT)",
  "44-pool-derived-accepted (ACCEPT pole for 43)",
  "45-prototype-key-refused (REJECT)",
  "46-additional-property-refused (REJECT)",
  "47-sessionsstart-blocking-severity-refused (REJECT)",
  "48-duplicate-json-key-refused (REJECT)",
  "49-lone-surrogate-refused (REJECT)",
  "50-schema-validation-control-reds-on-mutation (REJECT)",
  "51-schema-validation-control-greens-on-sample (ACCEPT pole for 50)",
  "52-jcs-vectors-known-answer (all 15 rows)",
  "53-deps-edges-are-pinned-to-lib-bytes (cross-check)",
  "54-runtime-pins-carry-the-adapter-closure",
  "55-case-insensitive-delivery-match-keeps-the-row",
  "56-check-mode-mismatch-refused (REJECT)",
  "57-check-mode-match-accepted (ACCEPT pole for 56)",
  "58-reemit-is-byte-identical (determinism)",
  "59-sample-is-the-reemit-of-this-tree (the shipped artifact)",
  "60-source-drift-clean-tree-reports-nothing",
  "61-source-drift-dirty-tree-reports-the-file (REJECT pole for 60)",
  "62-sidecar-third-party-accepted (ACCEPT pole for 63)",
  "63-sidecar-on-a-loom-owned-hook-refused (REJECT)",
  "64-advisory-only-events-pinned-to-the-engine (drift guard)",
];

// 01 — the accept pole the vocabulary cases contrast against.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const r = emit(root);
  const doc = readOut(r.outPath);
  const row = doc && doc.hooks[0];
  // NOTE the runtime assertion is shape-only here: the fixture's runtime stubs
  // legitimately require NOTHING, so a non-empty closure is asserted in case 78
  // against the REAL manifests where it means something.
  // source is derived from BYTES vs the emitting commit, and a synthetic root is
  // not a git repo — so the honest label here is repo-local/pool repo. The
  // loom-template pole is case 65, which builds a real git root.
  const ok = r.rc === 0 && doc && doc.hooks.length === 1 && row.event === "PreToolUse" && row.matcher === "Bash" && row.id.startsWith("hk_") && row.file_sha256.length === 64 && row.source === "repo-local" && row.pool === "repo" && Array.isArray(row.deps) && doc.runtimes.length === 3 && doc.runtimes.every((r) => r.entry_sha256 && Array.isArray(r.deps)) && doc.precedence.includes("conflicting-rewrite");
  record(NAMES[0], ok, ok ? `rows=${doc.hooks.length} pool=${row.pool} deps=${row.deps.length} runtimes=${doc.runtimes.length}` : `rc=${r.rc} err=${r.err.trim().split("\n").slice(-2).join(" | ")}`);
}

// 02-04 — block presence, parseability, and the derived-field boundary.
{
  const r = emit(makeRoot({ hook: "// no block\n" }));
  record(NAMES[1], r.rc === 1 && r.err.includes("no @hook-contract block"), `rc=${r.rc}`);
}
{
  const r = emit(makeRoot({ hook: "/**\n * @hook-contract\n * { not json }\n */\n" }));
  record(NAMES[2], r.rc === 1 && r.err.includes("not JSON"), `rc=${r.rc}`);
}
{
  const hook = VALID_BLOCK.replace('"idempotent": true', '"idempotent": true,\n *   "timeout": 7');
  const r = emit(makeRoot({ hook }));
  record(NAMES[3], r.rc === 1 && r.err.includes("unknown key"), `rc=${r.rc}`);
}

// 05/06 — the "never guess a cost" rule, both poles, and the [M] passthrough.
{
  const hook = VALID_BLOCK.replace('"idempotent": true', '"idempotent": true,\n *   "cost": { "p50_ms": 4, "p95_ms": 9, "platform": "m4" }');
  const r = emit(makeRoot({ hook }));
  record(NAMES[4], r.rc === 1 && r.err.includes("omit cost entirely"), `rc=${r.rc}`);
}
{
  const hook = VALID_BLOCK.replace('"idempotent": true', '"idempotent": true,\n *   "cost": { "p50_ms": 4, "p95_ms": 9, "platform": "fixture-platform", "method": "fixture-method" }');
  const r = emit(makeRoot({ hook }));
  const doc = readOut(r.outPath);
  const ok = r.rc === 0 && doc && doc.hooks[0].contract.cost && doc.hooks[0].contract.cost.platform === "fixture-platform";
  record(NAMES[5], ok, ok ? "cost carried" : `rc=${r.rc} err=${r.err.trim().split("\n").pop()}`);
}

// 07/08 — spawns is a LIST, contradicted by the source, and honoured when declared.
{
  const hook = VALID_BLOCK.concat('\nconst { spawnSync } = require("node:child_process");\nspawnSync("true", []);\n');
  const r = emit(makeRoot({ hook }));
  record(NAMES[6], r.rc === 1 && r.err.includes("contradicts the code"), `rc=${r.rc}`);
}
{
  const hook = VALID_BLOCK.replace('"spawns": []', '"spawns": ["true"]').concat('\nconst { spawnSync } = require("node:child_process");\nspawnSync("true", []);\n');
  const r = emit(makeRoot({ hook }));
  const doc = readOut(r.outPath);
  record(NAMES[7], r.rc === 0 && doc && doc.hooks[0].contract.side_effects.spawns[0] === "true", `rc=${r.rc} err=${r.err.trim().split("\n").pop()}`);
}

// 09 — an empty fs_writes list contradicted by a write call.
{
  const hook = VALID_BLOCK.replace('"fs_writes": [".claude/learning/fixture.jsonl"]', '"fs_writes": []').concat('\nrequire("node:fs").writeFileSync("/dev/null", "x");\n');
  const r = emit(makeRoot({ hook }));
  record(NAMES[8], r.rc === 1 && r.err.includes("declares fs_writes:[]"), `rc=${r.rc}`);
}

// 10/11 — the write-target locator allowlist, both poles.
{
  const hook = VALID_BLOCK.replace('".claude/learning/fixture.jsonl"', '"<mystery-root>/tmp/x"');
  const r = emit(makeRoot({ hook }));
  record(NAMES[9], r.rc === 1 && r.err.includes("unknown locator"), `rc=${r.rc}`);
}
{
  const hook = VALID_BLOCK.replace('".claude/learning/fixture.jsonl"', '"<os.tmpdir()>/fixture-<pid>"');
  const r = emit(makeRoot({ hook }));
  record(NAMES[10], r.rc === 0, `rc=${r.rc} err=${r.err.trim().split("\n").pop()}`);
}

// 12/13 — the NETWORK cross-check, which an earlier revision could never fire
// (a one-argument call to a two-parameter indexer read tokens[NaN]).
{
  const hook = VALID_BLOCK.concat('\nvoid fetch("https://example.invalid/x");\n');
  const r = emit(makeRoot({ hook }));
  record(NAMES[11], r.rc === 1 && r.err.includes("declares network:false"), `rc=${r.rc} err=${r.err.trim().split("\n").pop()}`);
}
{
  const hook = VALID_BLOCK.replace('"network": false', '"network": true').concat('\nvoid fetch("https://example.invalid/x");\n');
  const r = emit(makeRoot({ hook }));
  record(NAMES[12], r.rc === 0, `rc=${r.rc} err=${r.err.trim().split("\n").pop()}`);
}

// 14/15 — the rewrite declaration. An UNDECLARED rewrite is a contract
// violation the consumer turns into an INCOMPLETE row, so a wrong `false` here
// moves a verdict rather than a label.
{
  const hook = VALID_BLOCK.concat('\nconst out = { hookSpecificOutput: { updatedInput: { file_path: "/tmp/x" } } };\nprocess.stdout.write(JSON.stringify(out));\n');
  const r = emit(makeRoot({ hook }));
  record(NAMES[13], r.rc === 1 && r.err.includes("may_rewrite_input:false"), `rc=${r.rc}`);
}
{
  const hook = VALID_BLOCK.replace('"may_rewrite_input": false', '"may_rewrite_input": true').concat('\nconst out = { hookSpecificOutput: { updatedInput: { file_path: "/tmp/x" } } };\nprocess.stdout.write(JSON.stringify(out));\n');
  const r = emit(makeRoot({ hook }));
  const doc = readOut(r.outPath);
  record(NAMES[14], r.rc === 0 && doc && doc.hooks[0].contract.may_rewrite_input === true, `rc=${r.rc} err=${r.err.trim().split("\n").pop()}`);
}

// 16/17 — a null on_incomplete is legal ONLY where both defaults agree.
{
  const r = emit(makeRoot({ hook: VALID_BLOCK, events: [{ event: "PostToolUse", matcher: "Edit|Write", onIncomplete: null }] }));
  record(NAMES[15], r.rc === 1 && r.err.includes("Declare it explicitly"), `rc=${r.rc}`);
}
{
  const r = emit(makeRoot({ hook: VALID_BLOCK, events: [{ event: "PreToolUse", matcher: "Bash", onIncomplete: null }] }));
  const doc = readOut(r.outPath);
  const ok = r.rc === 0 && doc && doc.hooks[0].on_incomplete === null && doc.hooks[0].on_crash === null;
  record(NAMES[16], ok, ok ? "null preserved" : `rc=${r.rc} err=${r.err.trim().split("\n").pop()}`);
}

// 18 — H3: a deny-capable PreToolUse row MUST emit deny/deny, and the override
// is SURFACED rather than silent.
{
  const refuser = VALID_BLOCK.concat('\nprocess.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } }));\n');
  const r = emit(makeRoot({ hook: refuser, events: [{ event: "PreToolUse", matcher: "Edit|Write", onIncomplete: "continue" }] }), ["--json"]);
  const doc = readOut(r.outPath);
  const rep = jsonReport(r.err);
  const row = doc && doc.hooks[0];
  const ok = r.rc === 0 && row && row.on_incomplete === "deny" && row.on_crash === "deny" && row.on_timeout === "deny" && rep && Array.isArray(rep.contract_overrides) && rep.contract_overrides.some((x) => x.includes("fixture-hook.js"));
  record(NAMES[17], ok, ok ? "emitted deny/deny + override named" : `rc=${r.rc} row=${JSON.stringify(row && row.on_incomplete)} overrides=${JSON.stringify(rep && rep.contract_overrides)}`);
}

// 19/20 — a DIRECT registration (settings.json names the hook itself) still
// emits deny/deny, and its dispatched twin does too.
{
  const refuser = VALID_BLOCK.concat('\nprocess.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } }));\n');
  const root = makeRoot({ hook: VALID_BLOCK, direct: { file: "direct-guard.js", hook: refuser, event: "PreToolUse", matcher: "Edit|Write" } });
  const r = emit(root, ["--json"]);
  const doc = readOut(r.outPath);
  const row = doc && doc.hooks.find((h) => h.file.endsWith("direct-guard.js"));
  const ok = r.rc === 0 && row && row.on_incomplete === "deny" && row.contract.protocol.severity === "block";
  record(NAMES[18], ok, ok ? "direct row emits deny" : `rc=${r.rc} row=${JSON.stringify(row && row.on_incomplete)}`);
}
{
  const refuser = VALID_BLOCK.concat('\nprocess.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } }));\n');
  const r = emit(makeRoot({ hook: refuser, events: [{ event: "PreToolUse", matcher: "Edit|Write", onIncomplete: "deny" }] }), ["--json"]);
  const doc = readOut(r.outPath);
  const rep = jsonReport(r.err);
  const ok = r.rc === 0 && doc.hooks[0].on_incomplete === "deny" && (!rep.contract_overrides || rep.contract_overrides.length === 0);
  record(NAMES[19], ok, ok ? "deny with no override needed" : `rc=${r.rc} overrides=${JSON.stringify(rep && rep.contract_overrides)}`);
}

// 21/22 — a WEAKER timeout needs a declared exemption, and the exemption is SURFACED.
{
  const r = emit(makeRoot({ hook: VALID_BLOCK, events: [{ event: "PreToolUse", matcher: "Edit|Write", onIncomplete: "deny", onTimeout: "continue" }] }), ["--json"]);
  record(NAMES[20], r.rc === 1 && r.err.includes("timeout_exemption"), `rc=${r.rc}`);
}
{
  const hook = VALID_BLOCK.replace('"may_rewrite_input": false', '"may_rewrite_input": false,\n *   "timeout_exemption": { "reason": "This guard reads one small file and a timeout means the read was slow, not that the edit is unsafe." }');
  const r = emit(makeRoot({ hook, events: [{ event: "PreToolUse", matcher: "Edit|Write", onIncomplete: "deny", onTimeout: "continue" }] }), ["--json"]);
  const doc = readOut(r.outPath);
  const rep = jsonReport(r.err);
  const row = doc && doc.hooks[0];
  const ok = r.rc === 0 && row && row.on_timeout === "continue" && row.timeout_exemption && Array.isArray(rep.timeout_exemptions) && rep.timeout_exemptions.length === 1;
  record(NAMES[21], ok, ok ? "exemption carried + surfaced" : `rc=${r.rc} row=${JSON.stringify(row && row.on_timeout)} surfaced=${JSON.stringify(rep && rep.timeout_exemptions)}`);
}

// 23 — an unknown event cannot be described, so it is refused.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const regPath = path.join(root, ".claude", "hooks", "dispatch-registry.json");
  const settingsPath = path.join(root, ".claude", "settings.json");
  const cmd = (ev) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.js" ${ev}`;
  fs.writeFileSync(regPath, JSON.stringify({ schema: 1, events: { PreFlight: { dispatcher: { matcher: "*", timeout: 30 }, groups: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/fixture-hook.js"', timeout: 5, on_incomplete: "deny" }] }] } } }, null, 2));
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreFlight: [{ matcher: "*", hooks: [{ type: "command", command: cmd("PreFlight"), timeout: 30 }] }] } }, null, 2));
  const err23 = emit(root);
  const refusedUnknownEvent = err23.rc === 1 && err23.err.includes("is not in the contract's event set");
  record(NAMES[22], refusedUnknownEvent, `rc=${err23.rc} err=${err23.err.trim().split("\n")[0]}`);
}

// 24 — a plan built for another target is refused.
{
  const planPath = path.join(SCRATCH, "plan-other-target.json");
  fs.writeFileSync(planPath, JSON.stringify({ plan: { target: "somewhere-else", mode: "build", files: [] } }));
  const r = run([EMITTER, "--target", "fixture", "--lane", "build", "--plan", planPath, "--source-sha", ZERO_SHA, "--root", makeRoot({ hook: VALID_BLOCK }), "--stdout"]);
  record(NAMES[23], r.rc === 1 && r.err.includes("refusing to describe a different target"), `rc=${r.rc}`);
}

// 25/26 — repo-owned rows: the source restriction, and the derivation.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const hooksDir = path.join(root, ".claude", "hooks");
  fs.writeFileSync(path.join(hooksDir, "ours-hook.js"), VALID_BLOCK);
  const localPath = path.join(hooksDir, "local-registry.json");
  const mk = (source) => ({
    schema: 1,
    events: { PreToolUse: { dispatcher: { matcher: "*", timeout: 30 }, groups: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/ours-hook.js"', timeout: 5, on_incomplete: "deny", ...(source ? { source } : {}) }] }] } },
  });
  fs.writeFileSync(localPath, JSON.stringify(mk("loom-template"), null, 2));
  const bad = emit(root, ["--local-registry", localPath]);
  record(NAMES[24], bad.rc === 1 && bad.err.includes("may only declare"), `rc=${bad.rc}`);

  fs.writeFileSync(localPath, JSON.stringify(mk(null), null, 2));
  const good = emit(root, ["--local-registry", localPath]);
  const doc = readOut(good.outPath);
  const row = doc && doc.hooks.find((h) => h.file.endsWith("ours-hook.js"));
  const ok = good.rc === 0 && row && row.source === "repo-local" && row.pool === "repo";
  record(NAMES[25], ok, ok ? "source=repo-local pool=repo" : `rc=${good.rc} row=${JSON.stringify(row && { s: row.source, p: row.pool })} err=${good.err.trim().split("\n").pop()}`);
}

// 27/28 — a dynamic require makes the closure INCOMPLETE, so it is refused —
// and the refusal names the escape hatch, which the second pole exercises.
{
  const hook = VALID_BLOCK.concat('\nconst which = process.env.X || "fs";\nvoid require(which);\n');
  const root = makeRoot({ hook });
  const r = emit(root);
  record(NAMES[26], r.rc === 1 && r.err.includes("not statically resolvable"), `rc=${r.rc} err=${r.err.trim().split("\n").pop()}`);
  const siteLine = /fixture-hook\.js:(\d+)/.exec(r.err);
  const token = siteLine ? `.claude/hooks/fixture-hook.js:${siteLine[1]}` : "MISSING";
  const exempted = emit(root, ["--dynamic-require-exempt", token, "--json"]);
  const rep = jsonReport(exempted.err);
  const doc = readOut(exempted.outPath);
  const ok =
    exempted.rc === 0 &&
    rep &&
    Array.isArray(rep.dynamic_require_exemptions) &&
    rep.dynamic_require_exemptions.length === 1 &&
    doc &&
    Array.isArray(doc.dynamic_require_exemptions) &&
    doc.dynamic_require_exemptions.length === 1 &&
    doc.dynamic_require_exemptions[0].file === ".claude/hooks/fixture-hook.js";
  record(NAMES[27], ok, ok ? "exempted + surfaced" : `rc=${exempted.rc} surfaced=${JSON.stringify(rep && rep.dynamic_require_exemptions)}`);
}

// 29 — a symlinked hook cannot be content-verified.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const target = path.join(root, ".claude", "hooks", "real-hook.js");
  fs.writeFileSync(target, VALID_BLOCK);
  fs.symlinkSync(target, path.join(root, ".claude", "hooks", "link-hook.js"));
  const regPath = path.join(root, ".claude", "hooks", "dispatch-registry.json");
  const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
  reg.events.PreToolUse.groups.push({ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/link-hook.js"', timeout: 5, on_incomplete: "deny" }] });
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
  const r = emit(root);
  record(NAMES[28], r.rc === 1 && r.err.includes("is a SYMLINK"), `rc=${r.rc}`);
}

// 30/31 — an absent registration surface NARROWS the document silently, so it
// is refused unless the absence is declared.
{
  const root = makeRoot({ hook: VALID_BLOCK, omitGemini: true });
  const r = emit(root);
  record(NAMES[29], r.rc === 1 && r.err.includes("registration surface(s) absent"), `rc=${r.rc}`);
  const declared = emit(root, ["--allow-missing-surface", "gemini-settings"]);
  record(NAMES[30], declared.rc === 0, `rc=${declared.rc} err=${declared.err.trim().split("\n").pop()}`);
}

// 32 — a zero-row emit is refused (an empty registry and a fully-dropped one
// are indistinguishable to a consumer).
{
  const planPath = path.join(SCRATCH, "plan-empty.json");
  fs.writeFileSync(planPath, JSON.stringify({ plan: { target: "fixture", mode: "build", files: [] } }));
  const r = run([EMITTER, "--target", "fixture", "--lane", "build", "--plan", planPath, "--source-sha", ZERO_SHA, "--root", makeRoot({ hook: VALID_BLOCK }), "--stdout"]);
  record(NAMES[31], r.rc === 1 && r.err.includes("ZERO rows"), `rc=${r.rc} err=${r.err.trim().split("\n").filter((l) => l.includes("ZERO")).join("")}`);
}

// 33 — a row whose registration is weaker than the host's own behaviour is NAMED.
{
  const refuser = VALID_BLOCK.concat('\nprocess.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } }));\n');
  const root = makeRoot({ hook: VALID_BLOCK, direct: { file: "direct-soft.js", hook: refuser, event: "PostToolUse", matcher: "Edit|Write" } });
  const r = emit(root, ["--json"]);
  const rep = jsonReport(r.err);
  const ok = r.rc === 0 && rep && Array.isArray(rep.host_run_fail_open_rows) && rep.host_run_fail_open_rows.some((x) => x.includes("direct-soft.js"));
  record(NAMES[32], ok, ok ? "named on the report surface" : `rc=${r.rc} rep=${JSON.stringify(rep && rep.host_run_fail_open_rows)}`);
}

// 34/35 — the unknown-major refusal, both poles.
{
  const doc = clone();
  doc.$id = "loom.hook-registry/v2";
  doc.version = "2.0.0";
  const r = validateDoc(doc, "v2");
  record(NAMES[33], r.rc === 1 && r.err.includes("unknown major"), `rc=${r.rc}`);
}
{
  const r = validateDoc(sample, "v1");
  record(NAMES[34], r.rc === 0, `rc=${r.rc} err=${r.err.trim().slice(0, 100)}`);
}

// 36 — version major vs $id major.
{
  const doc = clone();
  doc.version = "2.0.0";
  const r = validateDoc(doc, "mismatch");
  record(NAMES[35], r.rc === 1 && r.err.includes("MUST agree"), `rc=${r.rc}`);
}

// 37/38 — content-hash tamper, and the recompute pole.
{
  const doc = clone();
  doc.hooks[0].timeout = 99999;
  const r = validateDoc(doc, "tamper");
  record(NAMES[36], r.rc === 1 && r.err.includes("does not recompute"), `rc=${r.rc}`);
}
{
  const doc = clone();
  doc.content_sha256 = run([CONTRACT, "hash", SAMPLE]).out.trim();
  const r = validateDoc(doc, "intact");
  record(NAMES[37], r.rc === 0, `rc=${r.rc} err=${r.err.trim().slice(0, 100)}`);
}

// 39/40 — (event, order) uniqueness, both poles.
{
  const doc = clone();
  doc.hooks[1].order = doc.hooks[0].order;
  doc.hooks[1].event = doc.hooks[0].event;
  const p = path.join(SCRATCH, "doc-duporder.json");
  fs.writeFileSync(p, JSON.stringify(doc));
  doc.content_sha256 = run([CONTRACT, "hash", p]).out.trim();
  fs.writeFileSync(p, JSON.stringify(doc));
  const r = run([CONTRACT, "validate", p]);
  record(NAMES[38], r.rc === 1 && r.err.includes("duplicates"), `rc=${r.rc} err=${r.err.trim().split("\n").find((l) => l.includes("duplicates")) || ""}`);
}
{
  const r = validateDoc(clone(), "order-ok");
  record(NAMES[39], r.rc === 0, `rc=${r.rc}`);
}

// 41 — duplicate row ids are refused by the id-integrity check.
{
  const doc = clone();
  doc.hooks[1].id = doc.hooks[0].id;
  const p = path.join(SCRATCH, "doc-dupid.json");
  fs.writeFileSync(p, JSON.stringify(doc));
  doc.content_sha256 = run([CONTRACT, "hash", p]).out.trim();
  fs.writeFileSync(p, JSON.stringify(doc));
  const r = run([CONTRACT, "validate", p]);
  record(NAMES[40], r.rc === 1 && (r.err.includes("duplicates") || r.err.includes("stable derivation")), `rc=${r.rc}`);
}

// 42 — a crash contract weaker than the row's own contract.
{
  const doc = clone();
  const target = doc.hooks.find((h) => h.on_incomplete === "deny");
  target.on_crash = "continue";
  const p = path.join(SCRATCH, "doc-crash.json");
  fs.writeFileSync(p, JSON.stringify(doc));
  doc.content_sha256 = run([CONTRACT, "hash", p]).out.trim();
  fs.writeFileSync(p, JSON.stringify(doc));
  const r = run([CONTRACT, "validate", p]);
  record(NAMES[41], r.rc === 1 && r.err.includes("WEAKER"), `rc=${r.rc} err=${r.err.trim().split("\n").find((l) => l.includes("WEAKER")) || ""}`);
}

// 43/44 — pool is a DERIVATION of source, never a second opinion.
{
  const doc = clone();
  doc.hooks[0].pool = doc.hooks[0].pool === "template" ? "repo" : "template";
  const p = path.join(SCRATCH, "doc-pool.json");
  fs.writeFileSync(p, JSON.stringify(doc));
  doc.content_sha256 = run([CONTRACT, "hash", p]).out.trim();
  fs.writeFileSync(p, JSON.stringify(doc));
  const r = run([CONTRACT, "validate", p]);
  record(NAMES[42], r.rc === 1 && r.err.includes("contradicts source"), `rc=${r.rc}`);
}
{
  const r = validateDoc(clone(), "pool-ok");
  record(NAMES[43], r.rc === 0, `rc=${r.rc}`);
}

// 45 — prototype-chain keys (`__proto__`) are refused by NAME.
{
  // Pretty-printed, because the injection targets a SPACED key/value pair —
  // against compact JSON the replace silently no-ops and the case would pass
  // for the wrong reason (it would validate a clean document).
  const raw = JSON.stringify(clone(), null, 2).replace('"event": "PreToolUse"', '"__proto__": {"event": "x"}, "event": "PreToolUse"');
  if (!raw.includes("__proto__")) throw new Error("case 45 fixture defect: the prototype key was not injected");
  const p = path.join(SCRATCH, "doc-proto.json");
  fs.writeFileSync(p, raw);
  const r = run([CONTRACT, "validate", p]);
  record(NAMES[44], r.rc === 1 && r.err.includes("prototype-chain key"), `rc=${r.rc} err=${r.err.trim().split("\n").find((l) => l.includes("prototype")) || r.err.trim().split("\n")[0]}`);
}

// 46 — additionalProperties is enforced at every level.
{
  const doc = clone();
  doc.hooks[0].surprise = 1;
  const p = path.join(SCRATCH, "doc-extra.json");
  fs.writeFileSync(p, JSON.stringify(doc));
  doc.content_sha256 = run([CONTRACT, "hash", p]).out.trim();
  fs.writeFileSync(p, JSON.stringify(doc));
  const r = run([CONTRACT, "validate", p]);
  record(NAMES[45], r.rc === 1 && r.err.includes("additional propert"), `rc=${r.rc}`);
}

// 47 — a blocking severity at SessionStart, where exit 2 is NOT a refusal.
{
  const doc = clone();
  const target = doc.hooks.find((h) => h.event !== "SessionStart");
  target.event = "SessionStart";
  const p = path.join(SCRATCH, "doc-sev.json");
  fs.writeFileSync(p, JSON.stringify(doc));
  doc.content_sha256 = run([CONTRACT, "hash", p]).out.trim();
  fs.writeFileSync(p, JSON.stringify(doc));
  const r = run([CONTRACT, "validate", p]);
  record(NAMES[46], r.rc === 1 && r.err.includes("SessionStart"), `rc=${r.rc} err=${r.err.trim().split("\n").find((l) => l.includes("SessionStart")) || ""}`);
}

// 48/49 — the strict parse: duplicate keys and lone surrogates, which
// JSON.parse accepts in silence.
{
  const raw = fs.readFileSync(SAMPLE, "utf8").replace('"version": "1.0.0"', '"version": "1.0.0",\n  "version": "1.0.0"');
  const p = path.join(SCRATCH, "doc-dupkey.json");
  fs.writeFileSync(p, raw);
  const r = run([CONTRACT, "validate", p]);
  record(NAMES[47], r.rc === 1 && r.err.includes("duplicate object key"), `rc=${r.rc} err=${r.err.trim().split("\n")[0]}`);
}
{
  const raw = fs.readFileSync(SAMPLE, "utf8").replace('"version": "1.0.0"', '"version": "1.0.0", "x": "\\ud800"');
  const p = path.join(SCRATCH, "doc-surrogate.json");
  fs.writeFileSync(p, raw);
  const r = run([CONTRACT, "validate", p]);
  record(NAMES[48], r.rc === 1 && r.err.includes("lone surrogate"), `rc=${r.rc} err=${r.err.trim().split("\n")[0]}`);
}

// 50/51 — the schema control: it REDS on a mutation the hash does not cover,
// and GREENS on the shipped sample.
{
  const doc = clone();
  doc.hooks[0].surfaces = ["not-a-surface"];
  const p = path.join(SCRATCH, "doc-schema-red.json");
  fs.writeFileSync(p, JSON.stringify(doc));
  doc.content_sha256 = run([CONTRACT, "hash", p]).out.trim();
  fs.writeFileSync(p, JSON.stringify(doc));
  const r = run([CONTRACT, "validate", p]);
  record(NAMES[49], r.rc === 1 && r.err.includes("is not one of"), `rc=${r.rc}`);
}
{
  const r = run([CONTRACT, "validate", SAMPLE]);
  record(NAMES[50], r.rc === 0 && r.out.includes("valid:"), `rc=${r.rc} out=${r.out.trim()}`);
}

// 52 — the JCS known-answer vectors: every row reproduced through the SAME
// pipeline a consumer must implement (strict parse → JCS → sha256).
{
  const vec = JSON.parse(fs.readFileSync(VECTORS, "utf8"));
  const { jcsCanonicalize } = require_(path.join(REPO, ".claude", "hooks", "lib", "jcs-canonicalize.js"));
  // The WEFT module re-exports the same implementation; every vector must agree
  // through BOTH paths, which is the pin that made the extraction safe.
  const weft = require_(path.join(REPO, ".claude", "hooks", "lib", "weft-jcs.js"));
  const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
  const { parseStrictJson } = require_(CONTRACT);
  let failures = [];
  for (const v of vec.vectors) {
    const strict = parseStrictJson(v.input_text);
    if (v.expect === "canonical") {
      const canonical = strict.ok ? jcsCanonicalize(strict.value) : null;
      if (!strict.ok || canonical !== v.canonical || sha256(v.canonical) !== v.sha256 || weft.jcsCanonicalize(strict.value) !== canonical) failures.push(v.name);
    } else if (v.expect === "refused-by-strict-parse") {
      if (strict.ok) failures.push(`${v.name} (was accepted)`);
    } else if (v.expect === "refused-by-canonicalizer") {
      if (!strict.ok) failures.push(`${v.name} (refused earlier than declared)`);
      else {
        try {
          jcsCanonicalize(strict.value);
          failures.push(`${v.name} (was accepted)`);
        } catch {
          /* expected */
        }
      }
    }
  }
  record(NAMES[51], failures.length === 0, failures.length ? `failures: ${failures.join(", ")}` : `${vec.vectors.length} vectors reproduced`);
}

// 53 — deps are pinned to LIB BYTES: change one lib and the emitted sha moves.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  fs.writeFileSync(path.join(root, ".claude", "hooks", "lib", "helper.js"), "module.exports = { v: 1 };\n");
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nconst { v } = require(path.join(__dirname, "lib", "helper.js"));\nvoid v;\n'));
  const first = emit(root);
  const docA = readOut(first.outPath);
  const depA = docA && docA.hooks[0].deps.find((d) => d.path.endsWith("helper.js"));
  const shaA = depA && depA.sha256;
  fs.writeFileSync(path.join(root, ".claude", "hooks", "lib", "helper.js"), "module.exports = { v: 2 };\n");
  const second = emit(root);
  const docB = readOut(second.outPath);
  const depB = docB && docB.hooks[0].deps.find((d) => d.path.endsWith("helper.js"));
  const ok = first.rc === 0 && second.rc === 0 && shaA && depB && depB.sha256 !== shaA && docA.content_sha256 !== docB.content_sha256;
  record(NAMES[52], ok, ok ? `lib edit moved the pin (${String(shaA).slice(0, 8)} → ${String(depB && depB.sha256).slice(0, 8)})` : `rc=${first.rc}/${second.rc} shaA=${shaA} shaB=${depB && depB.sha256}`);
}

// 54 — the runtime pins carry the adapter's own closure, and move with it.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  fs.writeFileSync(path.join(root, ".claude", "hooks", "lib", "adapter-dep.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(root, ".claude", "hooks", "lib", "codex-hook-runtime.js"), `"use strict";\nconst d = require(path.join(__dirname, "adapter-dep.js"));\nconst HANDLERS = ["./fixture-hook.js"];\nmodule.exports = { HANDLERS, d };\n`);
  const r = emit(root);
  const doc = readOut(r.outPath);
  const rt = doc && doc.runtimes.find((x) => x.entry.endsWith("codex-hook-runtime.js"));
  const ok = r.rc === 0 && rt && rt.entry_sha256 && rt.deps.some((d) => d.path.endsWith("adapter-dep.js"));
  record(NAMES[53], ok, ok ? `entry + ${rt.deps.length} deps pinned` : `rc=${r.rc} rt=${JSON.stringify(rt && rt.deps.map((d) => d.path))}`);
}

// 55 — the delivery-set lookup is case-insensitive, so a row is not dropped by
// a case difference (a dropped row is a guard that never runs).
{
  const planPath = path.join(SCRATCH, "plan-case.json");
  fs.writeFileSync(planPath, JSON.stringify({ plan: { target: "fixture", mode: "build", files: [{ path: ".CLAUDE/HOOKS/FIXTURE-HOOK.JS", action: "copy" }] } }));
  const r = run([EMITTER, "--target", "fixture", "--lane", "build", "--plan", planPath, "--source-sha", ZERO_SHA, "--root", makeRoot({ hook: VALID_BLOCK }), "--stdout"]);
  const ok = r.rc === 0 && r.out.includes('"file": ".claude/hooks/fixture-hook.js"');
  record(NAMES[54], ok, ok ? "row kept" : `rc=${r.rc} err=${r.err.trim().split("\n").pop()}`);
}

// 56/57 — --check refusal and acceptance.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const foreign = path.join(root, "foreign.json");
  fs.writeFileSync(foreign, '{"not":"the re-emit"}\n');
  const bad = emit(root, ["--check", foreign]);
  record(NAMES[55], bad.rc === 1 && bad.err.includes("MISMATCH"), `rc=${bad.rc}`);
  const first = emit(root);
  const good = emit(root, ["--check", first.outPath]);
  record(NAMES[56], first.rc === 0 && good.rc === 0, `first=${first.rc} check=${good.rc}`);
}

// 58 — determinism: two emits of one root are byte-identical.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const a = emit(root);
  const b = emit(root, ["--out", path.join(root, "second.json")]);
  const same = a.rc === 0 && b.rc === 0 && fs.readFileSync(a.outPath, "utf8") === fs.readFileSync(path.join(root, "second.json"), "utf8");
  record(NAMES[57], same, `rc=${a.rc}/${b.rc}`);
}

// 59 — the CHECKED-IN sample is the byte-identical re-emit of THIS tree, from a
// plan derived in the same run. This is the case that keeps the shipped fixture
// from rotting: edit a hook or a registration and it reds HERE rather than in a
// consumer's first verification.
{
  const planDir = fs.mkdtempSync(path.join(SCRATCH, "plan-"));
  const planRun = run([path.join(REPO, ".claude", "bin", "sync-tier-aware.mjs"), "--build", "base", "--dry-run", "--json", "--out", planDir]);
  if (planRun.rc !== 0) {
    record(NAMES[58], false, `plan failed rc=${planRun.rc}: ${planRun.err.trim().split("\n").pop()}`);
  } else {
    const planPath = path.join(SCRATCH, "plan.json");
    fs.writeFileSync(planPath, planRun.out);
    const r = run([EMITTER, "--target", "base", "--lane", "build", "--plan", planPath, "--check", SAMPLE, "--source-sha", sample.source_sha]);
    record(NAMES[58], r.rc === 0, `rc=${r.rc} ${r.err.trim().split("\n").slice(-2).join(" | ").slice(0, 220)}`);
  }
}

// 60/61 — the source-drift instrument, BOTH poles. The clean pole is the one
// that caught a real defect: the first implementation compared a sha256 against
// a git OBJECT ID, so it reported every file as drifted and read as "the tree
// is just dirty".
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const gitIn = (args) => spawnSync("git", ["-c", "user.email=fixture@local", "-c", "user.name=fixture", ...args], { cwd: root, encoding: "utf8" });
  gitIn(["init", "-q"]);
  gitIn(["add", "-A"]);
  gitIn(["commit", "-qm", "fixture"]);
  const clean = emit(root, ["--json"], null);
  const rep = jsonReport(clean.err);
  const cleanOk = clean.rc === 0 && rep && Array.isArray(rep.source_drift.files) && rep.source_drift.files.length === 0;
  record(NAMES[59], cleanOk, cleanOk ? "clean tree → 0 drifted" : `rc=${clean.rc} drifted=${JSON.stringify(rep && rep.source_drift)}`);

  fs.appendFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), "\n// drifted after the commit\n");
  const dirty = emit(root, ["--json"], null);
  const drep = jsonReport(dirty.err);
  const named = drep && drep.source_drift.files.some((f) => f.includes("fixture-hook.js"));
  const strict = emit(root, ["--require-source-match"], null);
  const okDirty = dirty.rc === 0 && named && strict.rc === 1 && strict.err.includes("--require-source-match");
  record(NAMES[60], okDirty, okDirty ? "dirty file named; --require-source-match refuses" : `rc=${dirty.rc} named=${named} strictRc=${strict.rc}`);
}

// 62/63 — the third-party sidecar, both poles. Case 62 ASSERTS the no-sidecar
// failure too, so it cannot pass by never exercising the mechanism.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const hooksDir = path.join(root, ".claude", "hooks");
  fs.writeFileSync(path.join(hooksDir, "vendored-hook.js"), "// vendored, not ours\n");
  const localPath = path.join(hooksDir, "local-registry.json");
  fs.writeFileSync(localPath, JSON.stringify({ schema: 1, events: { PreToolUse: { dispatcher: { matcher: "*", timeout: 30 }, groups: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/vendored-hook.js"', timeout: 5, on_incomplete: "deny", source: "third-party" }] }] } } }, null, 2));
  const without = emit(root, ["--local-registry", localPath]);
  const withoutRefused = without.rc === 1 && without.err.includes("no @hook-contract block");
  fs.writeFileSync(path.join(hooksDir, "vendored-hook.js.contract.json"), JSON.stringify({ side_effects: { fs_writes: [], network: false, spawns: [] }, idempotent: true, may_rewrite_input: false }, null, 2));
  const withSidecar = emit(root, ["--local-registry", localPath]);
  const doc = readOut(withSidecar.outPath);
  const row = doc && doc.hooks.find((h) => h.file.endsWith("vendored-hook.js"));
  const ok = withoutRefused && withSidecar.rc === 0 && row && row.source === "third-party" && row.pool === "repo";
  record(NAMES[61], ok, ok ? "no-sidecar refused; with-sidecar third-party+repo" : `without=${without.rc}/${withoutRefused} with=${withSidecar.rc} row=${JSON.stringify(row && { s: row.source, p: row.pool })}`);
}

// 63 — a sidecar on a row loom owns is refused.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const hooksDir = path.join(root, ".claude", "hooks");
  fs.writeFileSync(path.join(hooksDir, "ours-hook.js"), "// ours, but has no block\n");
  fs.writeFileSync(path.join(hooksDir, "ours-hook.js.contract.json"), JSON.stringify({ side_effects: { fs_writes: [], network: false, spawns: [] }, idempotent: true, may_rewrite_input: false }, null, 2));
  const localPath = path.join(hooksDir, "local-registry.json");
  fs.writeFileSync(localPath, JSON.stringify({ schema: 1, events: { PreToolUse: { dispatcher: { matcher: "*", timeout: 30 }, groups: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/ours-hook.js"', timeout: 5, on_incomplete: "deny" }] }] } } }, null, 2));
  const r = emit(root, ["--local-registry", localPath]);
  record(NAMES[62], r.rc === 1 && r.err.includes("reserved for third-party"), `rc=${r.rc}`);
}

// 64 — the contract's ADVISORY_ONLY copy must equal the engine's own set.
{
  const engine = fs.readFileSync(path.join(REPO, ".claude", "hooks", "lib", "hook-engine.js"), "utf8");
  const m = /const ADVISORY_ONLY = new Set\(\[([^\]]*)\]\)/.exec(engine);
  const engineSet = m ? m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : null;
  const ourList = /ADVISORY_ONLY_EVENTS = Object\.freeze\(\[([^\]]*)\]\)/.exec(fs.readFileSync(CONTRACT, "utf8"));
  const ours = ourList ? ourList[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : null;
  const ok = engineSet !== null && ours !== null && JSON.stringify(engineSet) === JSON.stringify(ours);
  record(NAMES[63], ok, ok ? `[${ours.join(", ")}]` : `engine=${JSON.stringify(engineSet)} contract=${JSON.stringify(ours)}`);
}

// 65 — SOURCE IS DERIVED FROM BYTES, both poles: a hook whose bytes equal the
// emitting commit's blob is loom-template/pool template; the same row after a
// one-byte edit is repo-local/pool repo. Without this pair, "source" could be
// a label copied from the registry and nobody would notice.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const gitIn = (args) => spawnSync("git", ["-c", "user.email=fixture@local", "-c", "user.name=fixture", ...args], { cwd: root, encoding: "utf8" });
  gitIn(["init", "-q"]);
  gitIn(["add", "-A"]);
  gitIn(["commit", "-qm", "fixture"]);
  const clean = emit(root, [], null);
  const docClean = readOut(clean.outPath);
  const rowClean = docClean && docClean.hooks[0];
  const templatePole = clean.rc === 0 && rowClean && rowClean.source === "loom-template" && rowClean.pool === "template";
  fs.appendFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), "\n// one byte more\n");
  const dirty = emit(root, [], null);
  const docDirty = readOut(dirty.outPath);
  const rowDirty = docDirty && docDirty.hooks[0];
  const repoPole = dirty.rc === 0 && rowDirty && rowDirty.source === "repo-local" && rowDirty.pool === "repo";
  record("65-source-derived-from-bytes (both poles)", templatePole && repoPole, templatePole && repoPole ? "committed ⇒ template/template; edited ⇒ repo-local/repo" : `template=${templatePole} repo=${repoPole}`);
}

// 66 — the block parser's INTENDED FORM, pinned (the reviewer's L5): the
// opener is line-based, so a `// @hook-contract` whose body is not JSON must
// FAIL LOUDLY as a malformed block rather than be ignored as a comment. The
// reject pole is that body; the accept pole is the same opener with JSON.
{
  const body = '{ "side_effects": { "fs_writes": [], "network": false, "spawns": [] }, "idempotent": true, "may_rewrite_input": false }';
  // REJECT pole: a LINE-comment opener. It is not a block, so the hook has no
  // declaration at all — refused for that reason, never half-parsed.
  const lineComment = `// @hook-contract\n// ${body}\n`;
  const r = emit(makeRoot({ hook: lineComment }));
  const refused = r.rc === 1 && r.err.includes("no @hook-contract block");
  // ACCEPT pole: the SAME content as a block comment.
  const blockComment = `/**\n * @hook-contract\n * ${body}\n */\n`;
  const r2 = emit(makeRoot({ hook: blockComment }));
  record("66-block-opener-form-pinned (both poles)", refused && r2.rc === 0, refused && r2.rc === 0 ? "line-comment opener not a block; block form accepted" : `lineRc=${r.rc}(${refused}) blockRc=${r2.rc}`);
}

// 67 — a sidecar that does NOT travel with its hook is refused: the row would
// be executable downstream and unverifiable.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const hooksDir = path.join(root, ".claude", "hooks");
  fs.writeFileSync(path.join(hooksDir, "vendored.js"), "// vendored\n");
  fs.writeFileSync(path.join(hooksDir, "vendored.js.contract.json"), JSON.stringify({ side_effects: { fs_writes: [], network: false, spawns: [] }, idempotent: true, may_rewrite_input: false }, null, 2));
  const localPath = path.join(hooksDir, "local-registry.json");
  fs.writeFileSync(localPath, JSON.stringify({ schema: 1, events: { PreToolUse: { dispatcher: { matcher: "*", timeout: 30 }, groups: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/vendored.js"', timeout: 5, on_incomplete: "deny", source: "third-party" }] }] } } }, null, 2));
  const planPath = path.join(SCRATCH, "plan-nosidecar.json");
  // The plan delivers the HOOK but not its sidecar.
  fs.writeFileSync(planPath, JSON.stringify({ plan: { target: "fixture", mode: "build", files: [{ path: ".claude/hooks/fixture-hook.js", action: "copy" }, { path: ".claude/hooks/vendored.js", action: "copy" }] } }));
  const refused = run([EMITTER, "--root", root, "--target", "fixture", "--lane", "build", "--plan", planPath, "--source-sha", ZERO_SHA, "--local-registry", localPath, "--stdout"]);
  const refusedOk = refused.rc === 1 && refused.err.includes("does NOT deliver");
  // Accept pole: the same plan WITH the sidecar listed.
  fs.writeFileSync(planPath, JSON.stringify({ plan: { target: "fixture", mode: "build", files: [{ path: ".claude/hooks/fixture-hook.js", action: "copy" }, { path: ".claude/hooks/vendored.js", action: "copy" }, { path: ".claude/hooks/vendored.js.contract.json", action: "copy" }] } }));
  const ok = run([EMITTER, "--root", root, "--target", "fixture", "--lane", "build", "--plan", planPath, "--source-sha", ZERO_SHA, "--local-registry", localPath, "--stdout"]);
  record("67-sidecar-must-be-delivered (both poles)", refusedOk && ok.rc === 0, refusedOk && ok.rc === 0 ? "undelivered sidecar refused; delivered accepted" : `refusedRc=${refused.rc}(${refusedOk}) okRc=${ok.rc}`);
}


// 68 — D1: the require closure is CONTAINED. The reject pole requires a file
// that really exists OUTSIDE the root, so the escape is demonstrable before the
// refusal is read; the accept pole walks out and back IN with `..` segments and
// must still resolve (containment is on the RESOLVED path, not on a ban on
// `..`).
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.js`);
  fs.writeFileSync(outside, "module.exports = { secret: 1 };\n");
  const relEscape = path.relative(path.join(root, ".claude", "hooks"), outside).split(path.sep).join("/");
  const escaping = VALID_BLOCK.concat(`\nrequire("${relEscape.startsWith(".") ? relEscape : "./" + relEscape}");\n`);
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), escaping);
  const rEscape = emit(root);
  const refused = rEscape.rc === 1 && rEscape.err.includes("resolves OUTSIDE the repo root");
  // ACCEPT pole: out through lib/ and back in — resolved path is inside.
  fs.writeFileSync(path.join(root, ".claude", "hooks", "lib", "inner.js"), "module.exports = { v: 1 };\n");
  const walking = VALID_BLOCK.concat('\nconst { v } = require(path.join(__dirname, "lib", "..", "lib", "inner.js"));\nvoid v;\n');
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), walking);
  const rWalk = emit(root);
  const docWalk = readOut(rWalk.outPath);
  const walked = rWalk.rc === 0 && docWalk && docWalk.hooks[0].deps.some((d) => d.path.endsWith("lib/inner.js"));
  record("68-deps-closure-is-contained (both poles)", refused && walked, refused && walked ? "outside-root escape refused; ..-walk staying inside resolves" : `escapeRc=${rEscape.rc}(${refused}) walkRc=${rWalk.rc}(${walked})`);
}

// 69 — D2: the two load forms a lexer silently skips. Each must produce a deps
// entry; before this they produced NOTHING — no entry, no refusal, no exemption.
{
  fs.writeFileSync(path.join(SCRATCH, "d2-root-marker"), "");
  const root = makeRoot({ hook: VALID_BLOCK });
  // ONE DISTINCT FILE PER LOAD FORM. The first version required `lib/m.js` from
  // BOTH the bare form and `module.require`, so deleting the module.require
  // branch left the case GREEN — the bare require still supplied m.js, and the
  // case could not tell the two branches apart (measured by the round's
  // verifier). Three files, three forms: each branch's removal now reds THIS
  // case on its own.
  fs.writeFileSync(path.join(root, ".claude", "hooks", "lib", "bare.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(root, ".claude", "hooks", "lib", "imp.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(root, ".claude", "hooks", "lib", "modreq.js"), "module.exports = {};\n");
  const hook = VALID_BLOCK.concat('\nrequire(path.join(__dirname, "lib", "bare.js"));\nvoid import(path.join(__dirname, "lib", "imp.js"));\nvoid module.require(path.join(__dirname, "lib", "modreq.js"));\n');
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), hook);
  const r = emit(root);
  const doc = readOut(r.outPath);
  const paths = doc ? doc.hooks[0].deps.map((d) => d.path) : [];
  const have = (n) => paths.some((x) => x.endsWith(`lib/${n}`));
  const ok = r.rc === 0 && have("bare.js") && have("imp.js") && have("modreq.js");
  record("69-bare-module.require-and-import()-each-walked (ACCEPT pole)", ok, ok ? `deps=${paths.length}` : `rc=${r.rc} deps=${JSON.stringify(paths)} err=${r.err.trim().split("\n")[0]}`);
}

// 70 — D4: exemptions are keyed to the SITE and carried IN-DOCUMENT. Two
// dynamic sites in one file: the CLI exemption covers exactly ONE, so the other
// still refuses — the file-keyed form would have covered both.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const hook = VALID_BLOCK.concat('\nconst a = process.env.A;\nconst b = process.env.B;\nrequire(a);\nrequire(b);\n');
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), hook);
  const bare = emit(root);
  const bothRefused = bare.rc === 1 && bare.err.includes("is not statically resolvable");
  const sites = [...bare.err.matchAll(/fixture-hook\.js:(\d+)/g)].map((m) => Number(m[1]));
  const uniq = [...new Set(sites)];
  // Exempt exactly ONE site: the emit must STILL refuse, and the refusal must
  // name the OTHER site — a file-keyed exemption would have covered both.
  const one = emit(root, ["--dynamic-require-exempt", `.claude/hooks/fixture-hook.js:${uniq[0]}`]);
  const stillRefused = one.rc === 1 && uniq[1] !== undefined && one.err.includes(`fixture-hook.js:${uniq[1]}`);
  // Exempt BOTH: accepted, and the document CARRIES the two declarations.
  const both = emit(root, ["--dynamic-require-exempt", `.claude/hooks/fixture-hook.js:${uniq[0]}`, "--dynamic-require-exempt", `.claude/hooks/fixture-hook.js:${uniq[1]}`, "--json"]);
  const doc = readOut(both.outPath);
  const surfaced = doc && Array.isArray(doc.dynamic_require_exemptions) && doc.dynamic_require_exemptions.length === 2;
  const ok = bothRefused && uniq.length === 2 && stillRefused && both.rc === 0 && surfaced;
  record(
    "70-exemption-is-site-keyed-and-in-document",
    ok,
    ok
      ? `one site exempted ⇒ the other still refused and NAMED; both ⇒ accepted with ${doc.dynamic_require_exemptions.length} in-document declarations`
      : `bothRc=${bare.rc} sites=${JSON.stringify(uniq)} stillRefused=${stillRefused} bothRc=${both.rc} doc=${JSON.stringify(doc && doc.dynamic_require_exemptions)}`,
  );
}

// 71 — D3: the signing path, three poles. (a) --require-signature with no key
// must REFUSE (it used to exit 0 unsigned); (b) --sign with --stdout refuses
// (there is no file to sign beside); (c) with a real throwaway key the .sig is
// written, and a HAND-EDITED manifest no longer matches the SIGNED PAYLOAD —
// the pin a consumer holds.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const noKey = emit(root, ["--require-signature", "--out", path.join(root, "a.json")]);
  const refusedNoKey = noKey.rc === 1 && noKey.err.includes("signing path is unavailable");
  const stdoutSign = run([EMITTER, "--root", root, "--target", "fixture", "--all-rows", "--source-sha", ZERO_SHA, "--stdout", "--sign"]);
  const refusedStdout = stdoutSign.rc === 2 && stdoutSign.err.includes("needs a file");
  // (c) happy path with a throwaway ed25519 key
  const keyDir = fs.mkdtempSync(path.join(SCRATCH, "key-"));
  const keyPath = path.join(keyDir, "id_ed25519");
  const kg = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath, "-C", "hook-registry-fixture"], { encoding: "utf8" });
  let signedOk = false;
  let pinOk = false;
  let detail = `keygen rc=${kg.status}`;
  if (kg.status === 0) {
    const out = path.join(root, "signed.json");
    const signed = emit(root, ["--sign", "--sign-key", keyPath, "--out", out]);
    const sigPath = `${out}.sig`;
    const sigExists = fs.existsSync(sigPath);
    const sig = sigExists ? JSON.parse(fs.readFileSync(sigPath, "utf8")) : null;
    const doc = readOut(out);
    signedOk = signed.rc === 0 && sigExists && sig && sig.signed_payload && doc && sig.signed_payload.content_sha256 === doc.content_sha256 && typeof sig.signature === "string" && sig.signature.includes("BEGIN SSH SIGNATURE");
    // THE PIN: edit the manifest and recompute its own hash, as an attacker
    // would — the signed payload still names the ORIGINAL content_sha256.
    if (signedOk) {
      const edited = JSON.parse(fs.readFileSync(out, "utf8"));
      edited.hooks[0].timeout = 99999;
      const p2 = path.join(root, "edited.json");
      fs.writeFileSync(p2, JSON.stringify(edited, null, 2) + "\n");
      const rehash = run([CONTRACT, "hash", p2]).out.trim();
      edited.content_sha256 = rehash;
      fs.writeFileSync(p2, JSON.stringify(edited, null, 2) + "\n");
      pinOk = rehash !== sig.signed_payload.content_sha256;
    }
    detail = `signed=${signedOk} pin=${pinOk}`;
  }
  const ok = refusedNoKey && refusedStdout && signedOk && pinOk;
  record("71-signing-path (3 poles: refuse/no-key, refuse/stdout, sign+pin)", ok, ok ? "no-key refused; stdout refused; signed; hand-edit breaks the pin" : `noKey=${refusedNoKey} stdout=${refusedStdout} ${detail}`);
}

// 72 — E1: a null on_incomplete is RANKED against its resolved default, so a
// weaker on_crash under a null must be refused (it validated before).
{
  const root = makeRoot({ hook: VALID_BLOCK, events: [{ event: "PreToolUse", matcher: "Bash", onIncomplete: null }] });
  const r = emit(root);
  const doc = readOut(r.outPath);
  if (r.rc !== 0 || !doc) {
    record("72-null-incomplete-ranked-against-its-default", false, `emitRc=${r.rc}`);
  } else {
    doc.hooks[0].on_crash = "continue"; // weaker than the resolved default (deny at PreToolUse)
    const p2 = path.join(root, "weaker.json");
    fs.writeFileSync(p2, JSON.stringify(doc, null, 2));
    doc.content_sha256 = run([CONTRACT, "hash", p2]).out.trim();
    fs.writeFileSync(p2, JSON.stringify(doc, null, 2));
    const v = run([CONTRACT, "validate", p2]);
    record("72-null-incomplete-ranked-against-its-default", v.rc === 1 && v.err.includes("WEAKER"), `validateRc=${v.rc} ${v.err.trim().split("\n").find((l) => l.includes("WEAKER")) || ""}`);
  }
}

// 73 — R2: an unresolvable source_sha is LOUD. The template/repo split is
// derived from a blob comparison against the emitting commit; when that commit
// cannot be resolved (an EXPORT with no .git), every row falls to repo-local and
// the degradation used to be visible only in the --json report. The synthetic
// roots here are not git repos, which is exactly that condition.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const r = emit(root, ["--json"]);
  const rep = jsonReport(r.err);
  const loud = r.err.includes("could not be resolved") && r.err.includes("every row is labelled source \"repo-local\"");
  const doc = readOut(r.outPath);
  const rowsDegraded = doc && doc.hooks.every((h) => h.source === "repo-local" && h.pool === "repo");
  const declared = rep && rep.source_drift && rep.source_drift.checked === false && typeof rep.source_drift.reason === "string";
  const ok = r.rc === 0 && loud && rowsDegraded && declared;
  record("73-unresolvable-source-is-loud", ok, ok ? "warned on stderr + rows carry the degraded split + reason in --json" : `rc=${r.rc} loud=${loud} degraded=${rowsDegraded} declared=${declared}`);
}

// 74 — F2: the bound-const branch resolves only when the window IS the
// binding. Bipolar IN THE PREDICATE'S OWN TERMS, plus the third pole that stops
// "make everything dynamic" from greening the suite while EMPTYING the closure.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  fs.writeFileSync(path.join(root, ".claude", "hooks", "lib", "impl.js"), "module.exports = {};\n");
  // mkdir BEFORE the write: the first version wrote first and died ENOENT, which
  // is the fixture failing rather than the subject.
  fs.mkdirSync(path.join(root, ".claude", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "bin", "validate-emit.mjs"), "module.exports = {};\n");
  const hookPath = path.join(root, ".claude", "hooks", "fixture-hook.js");

  // (a) REJECT pole: the argument only MENTIONS a binding, behind a runtime override.
  fs.writeFileSync(hookPath, VALID_BLOCK.concat('\nconst REL = ["lib", "impl.js"];\nrequire(process.env.HOOK_IMPL || REL);\n'));
  const rOverride = emit(root);
  const refusedOverride = rOverride.rc === 1 && rOverride.err.includes("is not statically resolvable");

  // (b) ACCEPT pole: the argument IS the binding.
  fs.writeFileSync(hookPath, VALID_BLOCK.concat('\nconst REL = ["lib", "impl.js"];\nrequire(REL);\n'));
  const rDirect = emit(root);
  const docDirect = readOut(rDirect.outPath);
  const resolvedDirect = rDirect.rc === 0 && docDirect && docDirect.hooks[0].deps.some((d) => d.path.endsWith("lib/impl.js"));

  // (c) THIRD pole — THE CLOSURE-DOES-NOT-EMPTY pole, and the only one of the
  // three that is runtime-real: it proves the predicate change did not simply
  // make everything dynamic (which would green the suite while emptying every
  // closure). (a) is the reject pole. (b) is the WINDOW-IS-THE-BINDING pole —
  // and note it is predicate-shaped only: `require(REL)` with REL an ARRAY
  // exercises the recognizer but would throw at runtime, since require() takes a
  // string, so (b) must not be read as the runtime-real pole. (c) is the shape
  // that actually runs: the legitimate wrapper idioms still resolve — the direct
  // dirname join, and the validate-emit override shape (a binding selected by
  // `||` but whose VALUE is a dirname join, reached through pathToFileURL).
  fs.writeFileSync(
    hookPath,
    VALID_BLOCK.concat(
      '\nconst AUTHORITY_REL = path.join("..", "bin", "validate-emit.mjs");\n' +
        'const authorityPath = (opts && opts.authorityPath) || path.resolve(__dirname, AUTHORITY_REL);\n' +
        "void import(pathToFileURL(authorityPath).href);\n" +
        'require(path.join(__dirname, "lib", "impl.js"));\n',
    ),
  );
  const rReal = emit(root);
  const docReal = readOut(rReal.outPath);
  const depsReal = docReal ? docReal.hooks[0].deps.map((d) => d.path) : [];
  // depsReal holds PATHS (already mapped), not dep objects — reading `.path` off
  // a string is how this case first crashed instead of reporting.
  const resolvedReal = rReal.rc === 0 && depsReal.some((p) => p.endsWith(".claude/bin/validate-emit.mjs")) && depsReal.some((p) => p.endsWith("lib/impl.js"));
  const ok = refusedOverride && resolvedDirect && resolvedReal;
  record(
    "74-window-must-BE-the-binding (3 poles)",
    ok,
    ok
      ? "override-window refused; bare binding resolved; wrapper idioms still resolved"
      : `override=${refusedOverride} direct=${resolvedDirect} real=${resolvedReal} deps=${JSON.stringify(depsReal)}`,
  );
}

// 75 — F3: the VERIFICATION contract csq implements. Case 71's re-hash check
// cannot fail independently (it differs by construction); this one runs
// coc-sign's own verify side: the signed payload verifies under the signing key,
// does NOT verify for the edited payload, and does NOT verify under a WRONG key.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const keyDir = fs.mkdtempSync(path.join(SCRATCH, "vk-"));
  const keyPath = path.join(keyDir, "id_ed25519");
  const otherDir = fs.mkdtempSync(path.join(SCRATCH, "vk2-"));
  const otherKey = path.join(otherDir, "id_ed25519");
  const kg1 = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath, "-C", "fixture"], { encoding: "utf8" });
  const kg2 = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", otherKey, "-C", "fixture-wrong"], { encoding: "utf8" });
  if (kg1.status !== 0 || kg2.status !== 0) {
    record("75-signature-verification-contract (3 poles)", false, "ssh-keygen unavailable — the case REDS rather than skipping");
  } else {
    const cocSign = require_(path.join(REPO, ".claude", "hooks", "lib", "coc-sign.js"));
    const out = path.join(root, "signed.json");
    const signed = emit(root, ["--sign", "--sign-key", keyPath, "--out", out]);
    const sigBody = JSON.parse(fs.readFileSync(`${out}.sig`, "utf8"));
    const pub = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
    const wrongPub = fs.readFileSync(`${otherKey}.pub`, "utf8").trim();
    const goodPayload = cocSign.canonicalSerialize(sigBody.signed_payload);
    const editedPayload = cocSign.canonicalSerialize({ ...sigBody.signed_payload, content_sha256: "0".repeat(64) });
    const vGood = cocSign.verify(goodPayload, sigBody.signature, pub);
    const vEdited = cocSign.verify(editedPayload, sigBody.signature, pub);
    const vWrongKey = cocSign.verify(goodPayload, sigBody.signature, wrongPub);
    const ok =
      signed.rc === 0 &&
      vGood && vGood.ok === true && vGood.valid === true &&
      vEdited && vEdited.ok === true && vEdited.valid === false &&
      vWrongKey && vWrongKey.ok === true && vWrongKey.valid === false;
    record(
      "75-signature-verification-contract (3 poles)",
      ok,
      ok
        ? "verifies under the signing key; fails on the edited payload; fails under a wrong key"
        : `good=${JSON.stringify(vGood)} edited=${JSON.stringify(vEdited)} wrongKey=${JSON.stringify(vWrongKey)}`,
    );
  }
}

// 76 — LOOM'S OWN MANIFEST is pinned the same way the sample is. It IS
// currently the byte-identical re-emit at its own source_sha, but nothing in the
// battery redded if it rotted — the sample had case 59 and this one had nothing.
// Emitted with --all-rows (it describes this repo) and checked against the
// committed file at the source_sha the file itself names, so the assertion is
// about BYTES and does not move every time a later commit lands.
{
  const loomPath = path.join(REPO, ".claude", "hook-registry.json");
  if (!fs.existsSync(loomPath)) {
    record("76-loom-manifest-is-the-reemit-of-this-tree", false, "no .claude/hook-registry.json to check");
  } else {
    const loom = JSON.parse(fs.readFileSync(loomPath, "utf8"));
    const r = run([EMITTER, "--root", REPO, "--target", "loom", "--all-rows", "--source-sha", loom.source_sha, "--check", loomPath]);
    record("76-loom-manifest-is-the-reemit-of-this-tree", r.rc === 0, `rc=${r.rc} ${r.err.trim().split("\n").slice(-2).join(" | ").slice(0, 200)}`);
  }
}

// 77 — R1: the validator's containment clause, on a HAND-BUILT document. The
// clause lived only in the module: deleting it reddened nothing, which is the
// definition of an instrument with no fixture. Three poles, and the accept one
// matters as much as the two rejections — a clause that refuses everything
// would pass a two-pole suite.
{
  const base = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
  // RE-HASHED exactly as case 72 does (write -> hash -> set -> rewrite), so the
  // ONLY error a reject pole can produce is the containment one. Without the
  // re-hash the document also reds on "content_sha256 does not recompute", and a
  // case asserting rc===1 alone would then pass with the clause DELETED — the
  // acceptance criterion is explicit about this trap.
  const built = (mutate, tag) => {
    const doc = JSON.parse(JSON.stringify(base));
    mutate(doc);
    const tmp = path.join(SCRATCH, `r1-${tag}.json`);
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    doc.content_sha256 = run([CONTRACT, "hash", tmp]).out.trim();
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    return run([CONTRACT, "validate", tmp]);
  };
  const containmentOf = (r) => r.err.split("\n").filter((l) => l.includes("escapes or is absolute"));
  const hashError = (r) => r.err.includes("does not recompute");

  // ONE REJECT POLE PER ARRAY, each asserting its OWN path — so a clause that
  // covered only hooks[] (the exact gap R1 reported) cannot satisfy both.
  const hookEscape = built((d) => { d.hooks[0].deps[0].path = "../x.js"; }, "hook");
  const runtimeAbs = built((d) => { d.runtimes[0].deps[0].path = "/abs/x.js"; }, "runtime");
  const hookMsg = containmentOf(hookEscape).find((l) => l.includes("$.hooks[0].deps[0]"));
  const runtimeMsg = containmentOf(runtimeAbs).find((l) => l.includes("$.runtimes[0].deps[0]"));

  // ACCEPT CONTROL on BOTH arrays: the clause and the schema pattern
  // deliberately pass a `...` segment, and this is what stops a future
  // over-tightening from shipping unnoticed.
  const acceptHook = built((d) => { d.hooks[0].deps[0].path = ".claude/hooks/lib/...weird.js"; }, "acc-hook");
  const acceptRuntime = built((d) => { d.runtimes[0].deps[0].path = ".claude/hooks/lib/...weird.js"; }, "acc-runtime");
  const acceptMsg = (r) => containmentOf(r).length === 0;

  const ok =
    hookEscape.rc === 1 && Boolean(hookMsg) && !hashError(hookEscape) &&
    runtimeAbs.rc === 1 && Boolean(runtimeMsg) && !hashError(runtimeAbs) &&
    acceptHook.rc === 0 && acceptMsg(acceptHook) &&
    acceptRuntime.rc === 0 && acceptMsg(acceptRuntime);
  record(
    "77-validator-containment-clause (per-array poles + both-array accept control)",
    ok,
    ok
      ? "hooks[0].deps[0] escape named; runtimes[0].deps[0] escape named; '...' passes on BOTH arrays; no hash error masking either refusal"
      : `hook=${hookEscape.rc}:${Boolean(hookMsg)} runtime=${runtimeAbs.rc}:${Boolean(runtimeMsg)} accHook=${acceptHook.rc} accRuntime=${acceptRuntime.rc} hashErr=${hashError(hookEscape) || hashError(runtimeAbs)}`,
  );
}

// 78 — HIGH-1: the runtime closures pin what the dispatcher actually EXECUTES,
// including the two files that no require walk sees: the Worker load and the
// spawn-by-path supervisor. Asserted against the REAL manifests, since a
// synthetic root cannot carry the tree's own runtime files.
{
  const loom = JSON.parse(fs.readFileSync(path.join(REPO, ".claude", "hook-registry.json"), "utf8"));
  const sampleManifest = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
  const check = (doc, label) => {
    const entries = doc.runtimes.map((r) => r.entry);
    const dispatch = doc.runtimes.find((r) => r.entry.endsWith("dispatch.js"));
    const worker = dispatch && dispatch.deps.some((d) => d.path.endsWith("hook-engine-worker.js"));
    const supervisor = entries.some((e) => e.endsWith("local-supervisor.js"));
    const supervisorEntry = doc.runtimes.find((r) => r.entry.endsWith("local-supervisor.js"));
    const supervisorDeps = supervisorEntry ? supervisorEntry.deps.length : 0;
    const sized = doc.runtimes.every((r) => r.entry_sha256 && Array.isArray(r.deps) && r.deps.length > 0);
    return { ok: worker && supervisor && supervisorDeps > 0 && sized && entries.length === 3, worker, supervisor, supervisorDeps, label };
  };
  const a = check(loom, "loom");
  const b = check(sampleManifest, "sample");
  record(
    "78-runtime-closures-pin-worker-and-supervisor",
    a.ok && b.ok,
    a.ok && b.ok ? "3 runtime entries each; hook-engine-worker.js in the dispatch closure; local-supervisor.js pinned with its own closure" : `loom=${JSON.stringify(a)} sample=${JSON.stringify(b)}`,
  );
}

// 79 — the RUNTIME dynamic policy: an unresolvable load in a runtime closure
// refuses the emit unless the SITE is exempted, and the exemption travels
// in-document. Without this case the policy could be deleted silently; without
// the accept pole it could refuse every runtime closure.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  fs.writeFileSync(
    path.join(root, ".claude", "hooks", "lib", "codex-hook-runtime.js"),
    '"use strict";\nconst HANDLERS = ["./fixture-hook.js"];\nconst p = process.env.RT || "./fallback.js";\nrequire(p);\nmodule.exports = { HANDLERS };\n',
  );
  const refused = emit(root);
  const refusedOk = refused.rc === 1 && refused.err.includes("runtime pin would be incomplete");
  const line = /codex-hook-runtime\.js:(\d+)/.exec(refused.err);
  const token = line ? `.claude/hooks/lib/codex-hook-runtime.js:${line[1]}` : "MISSING";
  const accepted = emit(root, ["--dynamic-require-exempt", token, "--json"]);
  const doc = readOut(accepted.outPath);
  const rt = doc && doc.runtimes.find((r) => r.entry.endsWith("codex-hook-runtime.js"));
  const inDoc = rt && Array.isArray(rt.dynamic_require_exemptions) && rt.dynamic_require_exemptions.length === 1;
  const ok = refusedOk && accepted.rc === 0 && inDoc;
  record("79-runtime-dynamic-policy (both poles)", ok, ok ? "un-exempted runtime load refused; exempted + carried in-document" : `refused=${refused.rc}:${refusedOk} accepted=${accepted.rc} inDoc=${inDoc} token=${token}`);
}

// 80 — M2/M5: the three ways a document or a closure could slip past the
// checks that were supposed to see it. Each pole is a measured gap, not a
// hypothetical.
{
  const { parseStrictJson, localRequireClosure } = require_(path.join(REPO, ".claude", "hooks", "lib", "hook-registry-contract.js"));
  const raw = fs.readFileSync(SAMPLE, "utf8");
  // M2a — an ESCAPED duplicate key: "version" and "\u0076ersion" decode to one
  // key, and raw-text comparison called them different.
  const escaped = raw.replace('"version": "1.0.0"', '"version": "1.0.0", "\\u0076ersion": "1.0.0"');
  const m2a = !parseStrictJson(escaped).ok;
  // M2b — a lone surrogate in a KEY: only VALUES were walked.
  const surrogateKey = raw.replace('"version": "1.0.0"', '"\\ud800": "x", "version": "1.0.0"');
  const m2b = !parseStrictJson(surrogateKey).ok;
  // M5 — a require reached through .call, and an ALIASED require. Both produced
  // NO site, so the closure verified clean over a file it never covered.
  // SANDBOXED. The first version created `zz-case80-*` INSIDE the real
  // `.claude/hooks/lib` and removed it afterwards — a fixture that writes into
  // the artifact it is testing, where an interrupted run (or any other process
  // walking that directory) sees a directory the repo never contained. The walk
  // is now driven against the harness's own SYNTHETIC root, which is what every
  // other closure case already uses.
  const walkRoot = makeRoot({ hook: VALID_BLOCK });
  const walkLib = path.join(walkRoot, ".claude", "hooks", "lib");
  fs.writeFileSync(path.join(walkLib, "dep.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(walkLib, "call.js"), 'const a = require.call(null, "./dep.js");\nvoid a;\n');
  const callClosure = localRequireClosure(walkRoot, ".claude/hooks/lib/call.js");
  const callResolved = callClosure.files.some((f) => f.path.endsWith("dep.js"));
  fs.writeFileSync(path.join(walkLib, "alias.js"), 'const r = require;\nconst y = r("./dep.js");\nvoid y;\n');
  const aliasRefused = localRequireClosure(walkRoot, ".claude/hooks/lib/alias.js").dynamic.length > 0;
  const ok = m2a && m2b && callResolved && aliasRefused;
  record(
    "80-escaped-keys-surrogate-keys-require.call-and-alias",
    ok,
    ok
      ? "escaped dup key refused; surrogate key refused; require.call resolved; aliased require refused (dynamic)"
      : `m2a=${m2a} m2b=${m2b} callResolved=${callResolved} aliasRefused=${aliasRefused}`,
  );
}

// 81 — M7: the delivery filter must NOT touch repo-owned rows. Deleting that
// half of the guard left the whole battery green until this case existed, which
// is precisely the "guard whose deletion reds nothing" shape: a repo row outside
// the plan would be silently dropped — a guard that never runs.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const hooksDir = path.join(root, ".claude", "hooks");
  fs.writeFileSync(path.join(hooksDir, "ours-hook.js"), VALID_BLOCK);
  const localPath = path.join(hooksDir, "local-registry.json");
  fs.writeFileSync(localPath, JSON.stringify({ schema: 1, events: { PreToolUse: { dispatcher: { matcher: "*", timeout: 30 }, groups: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/ours-hook.js"', timeout: 5, on_incomplete: "deny" }] }] } } }, null, 2));
  // A plan that lists NEITHER file: the loom-template row is dropped, the
  // repo-owned row is KEPT.
  const planPath = path.join(SCRATCH, "plan-m7.json");
  fs.writeFileSync(planPath, JSON.stringify({ plan: { target: "fixture", mode: "build", files: [] } }));
  const r = run([EMITTER, "--root", root, "--target", "fixture", "--lane", "build", "--plan", planPath, "--source-sha", ZERO_SHA, "--local-registry", localPath, "--stdout"]);
  let doc = null;
  try { doc = JSON.parse(r.out); } catch { /* refused */ }
  const keptRepoRow = doc && doc.hooks.some((h) => h.file.endsWith("ours-hook.js"));
  const droppedTemplateRow = doc && !doc.hooks.some((h) => h.file.endsWith("fixture-hook.js"));
  const ok = r.rc === 0 && keptRepoRow && droppedTemplateRow;
  record("81-repo-rows-survive-the-delivery-filter (M7)", ok, ok ? "repo row kept, loom-template row dropped, both from an empty plan" : `rc=${r.rc} keptRepo=${keptRepoRow} droppedTemplate=${droppedTemplateRow} err=${r.err.trim().split("\n").pop().slice(0, 90)}`);
}

// 82 — the VALIDATOR's deny-capable PreToolUse rule. Disabling it left the
// battery green until this case existed; the emitter's own policy (case 18)
// never produces such a document, so only a hand-built one can exercise it.
{
  const base = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
  const doc = JSON.parse(JSON.stringify(base));
  const target = doc.hooks.find((h) => h.event === "PreToolUse" && h.contract.protocol.severity === "block");
  target.on_incomplete = "continue";
  target.on_crash = "continue";
  target.on_timeout = "continue";
  const tmp = path.join(SCRATCH, "deny-capable.json");
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  doc.content_sha256 = run([CONTRACT, "hash", tmp]).out.trim();
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  const r = run([CONTRACT, "validate", tmp]);
  const named = r.err.includes("deny-capable PreToolUse row");
  const ok = r.rc === 1 && named && !r.err.includes("does not recompute");
  record("82-validator-refuses-a-weakened-deny-capable-row", ok, ok ? "hand-built weaker row refused by the validator's own rule, hash intact" : `rc=${r.rc} named=${named} hashErr=${r.err.includes("does not recompute")}`);
}

// 83 — the runtime closure REFUSAL: a runtime entry whose own closure cannot be
// resolved must fail the emit. Disabling that check left the battery green until
// this case existed, and the failure it guards is exactly the one HIGH-1 was
// about — an incomplete runtime pin verifying clean over code it never covered.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  fs.writeFileSync(
    path.join(root, ".claude", "hooks", "lib", "codex-hook-runtime.js"),
    '"use strict";\nconst missing = require(path.join(__dirname, "does-not-exist.js"));\nconst HANDLERS = ["./fixture-hook.js"];\nmodule.exports = { HANDLERS, missing };\n',
  );
  const r = emit(root);
  const refused = r.rc === 1 && /runtime .*codex-hook-runtime\.js/.test(r.err) && /does not resolve|cannot be pinned/.test(r.err);
  // ACCEPT pole: restore a resolvable runtime and the same root emits.
  fs.writeFileSync(path.join(root, ".claude", "hooks", "lib", "codex-hook-runtime.js"), CODEX_STUB);
  const accepted = emit(root);
  record("83-runtime-closure-refusal (both poles)", refused && accepted.rc === 0, refused && accepted.rc === 0 ? "unresolvable runtime closure refused by name; resolvable one emits" : `refused=${refused} acceptedRc=${accepted.rc} err=${r.err.trim().split("\n").pop().slice(0, 100)}`);
}

// 84 — the two LOWs that were still real, measured before the fix: a QUOTED
// decision key evaded the rewrite cross-check (the scan matched ident tokens,
// and a quoted key is a string token), and a FLOAT made validateManifest THROW
// rather than deny (RFC 8785 rejects non-integers, and the hash recompute was
// unguarded — "this document is wrong" became "the checker broke").
{
  // (a) quoted-key evasion, through the EMITTER on a real hook
  const root = makeRoot({ hook: VALID_BLOCK.replace('"may_rewrite_input": false', '"may_rewrite_input": false').concat('\nmodule.exports = { hookMain() { return { hookSpecificOutput: { "updatedInput": { x: 1 } } }; } };\n') });
  const quoted = emit(root);
  const refusedQuoted = quoted.rc === 1 && quoted.err.includes("may_rewrite_input:false");
  // (b) float: DENIED, not thrown
  const base = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
  const doc = JSON.parse(JSON.stringify(base));
  doc.hooks[0].timeout = 7.5;
  const { validateManifest } = require_(path.join(REPO, ".claude", "hooks", "lib", "hook-registry-contract.js"));
  let threw = false;
  let res = null;
  try { res = validateManifest(doc); } catch { threw = true; }
  const deniedFloat = !threw && res && res.valid === false && res.errors.some((e) => e.includes("cannot be recomputed"));
  const ok = refusedQuoted && deniedFloat;
  record("84-quoted-decision-key-and-float-denial", ok, ok ? "quoted updatedInput refused; float DENIED with a message (no throw)" : `quoted=${refusedQuoted} float=${deniedFloat} threw=${threw}`);
}


// 85/86 — THE TWO WORKER LOAD FORMS, ONE PER ROOT. Case 78 asserts that
// hook-engine-worker.js is in the dispatcher closure ONCE, and the walker
// reaches it by TWO independent branches (`new Worker(path.join(__dirname, …))`
// in hook-engine.js and `require.resolve(path.join(HOOKS_DIR, "lib", …))` in
// dispatch-main.js). One assertion over one closure cannot separate them:
// deleting either branch leaves case 78 green because the other still supplies
// the file. Each form now has its own root, in which it is the ONLY route to the
// worker — so the branch's removal reds exactly its own case.
{
  const rootW = makeRoot({ hook: VALID_BLOCK });
  const libW = path.join(rootW, ".claude", "hooks", "lib");
  fs.writeFileSync(path.join(libW, "worker-only.js"), "module.exports = {};\n");
  fs.writeFileSync(
    path.join(libW, "loader-worker.js"),
    'const { Worker } = require("node:worker_threads");\nconst w = new Worker(path.join(__dirname, "worker-only.js"), {});\nvoid w;\n',
  );
  fs.writeFileSync(path.join(rootW, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nrequire(path.join(__dirname, "lib", "loader-worker.js"));\n'));
  const rW = emit(rootW);
  const docW = readOut(rW.outPath);
  const pinnedW = docW && docW.hooks[0].deps.some((d) => d.path.endsWith("lib/worker-only.js"));
  record(
    "85-new-Worker-load-is-walked (branch-isolated)",
    rW.rc === 0 && Boolean(pinnedW),
    rW.rc === 0 && Boolean(pinnedW) ? "worker-only.js pinned via the `new Worker(...)` branch alone" : `rc=${rW.rc} pinned=${pinnedW} err=${rW.err.trim().split("\n")[0]}`,
  );

  const rootR = makeRoot({ hook: VALID_BLOCK });
  const libR = path.join(rootR, ".claude", "hooks", "lib");
  fs.writeFileSync(path.join(libR, "resolved-only.js"), "module.exports = {};\n");
  fs.writeFileSync(
    path.join(libR, "loader-resolve.js"),
    'const HOOKS_DIR = path.join(__dirname, "..");\nconst p = require.resolve(path.join(HOOKS_DIR, "lib", "resolved-only.js"));\nvoid p;\n',
  );
  fs.writeFileSync(path.join(rootR, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nrequire(path.join(__dirname, "lib", "loader-resolve.js"));\n'));
  const rR = emit(rootR);
  const docR = readOut(rR.outPath);
  const pinnedR = docR && docR.hooks[0].deps.some((d) => d.path.endsWith("lib/resolved-only.js"));
  record(
    "86-require.resolve-load-is-walked (branch-isolated)",
    rR.rc === 0 && Boolean(pinnedR),
    rR.rc === 0 && Boolean(pinnedR) ? "resolved-only.js pinned via the `require.resolve(...)` branch alone" : `rc=${rR.rc} pinned=${pinnedR} err=${rR.err.trim().split("\n")[0]}`,
  );
}

// 87 — the contract's DISPATCHER default must equal the dispatcher's own
// constant. A null `on_incomplete` is a deferral to it, and the constant is a
// named COPY of `ROW_ON_INCOMPLETE_DEFAULT` (an import would pull the
// dispatcher into a build-time consumer), so the two are pinned EQUAL by
// reading the dispatcher's source — the technique case 64 uses for the
// advisory-only list. Before this case the validator compared the document's
// own default map against itself and named the wrong authority in the message.
{
  const dispatcher = fs.readFileSync(path.join(REPO, ".claude", "hooks", "lib", "dispatch-registry.js"), "utf8");
  const m = /const ROW_ON_INCOMPLETE_DEFAULT = "([a-z]+)"/.exec(dispatcher);
  const ours = /const DISPATCHER_ON_INCOMPLETE_DEFAULT = "([a-z]+)"/.exec(fs.readFileSync(CONTRACT, "utf8"));
  const ok = m !== null && ours !== null && m[1] === ours[1];
  record("87-null-on_incomplete-defers-to-the-dispatchers-own-default", ok, ok ? `both resolve to ${m[1]}` : `dispatcher=${m && m[1]} contract=${ours && ours[1]}`);
}

// 88 — the validator's null-on_incomplete clause, both poles, on a HAND-BUILT
// document (the emitter never produces the reject shape — it refuses to). The
// reject pole is the divergence the inverted comparison ACCEPTED: a null at
// PostToolUse where the manifest's own map says "continue" while the dispatcher
// reads any non-"continue" as "deny". The accept pole is a null where the two
// agree, which must still be legal or the deferral is unrepresentable.
{
  const base = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
  const built = (mutate, tag) => {
    const doc = JSON.parse(JSON.stringify(base));
    mutate(doc);
    const tmp = path.join(SCRATCH, `nullon-${tag}.json`);
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    doc.content_sha256 = run([CONTRACT, "hash", tmp]).out.trim();
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    return run([CONTRACT, "validate", tmp]);
  };
  // REJECT: a PostToolUse row deferring to a map entry the dispatcher reads the
  // other way round.
  const diverge = built((d) => {
    const row = d.hooks.find((h) => h.event === "PostToolUse" && h.on_incomplete === "continue");
    row.on_incomplete = null;
    row.on_crash = null;
    row.on_timeout = null;
    d.default_on_incomplete = { ...d.default_on_incomplete, PostToolUse: "continue" };
  }, "diverge");
  const named = diverge.err.includes("the two contracts read this null differently");
  // ACCEPT: the same shape with the map entry the dispatcher itself resolves to.
  const agree = built((d) => {
    const row = d.hooks.find((h) => h.event === "PostToolUse" && h.on_incomplete === "continue");
    row.on_incomplete = null;
    row.on_crash = null;
    row.on_timeout = null;
    d.default_on_incomplete = { ...d.default_on_incomplete, PostToolUse: "deny" };
  }, "agree");
  const ok = diverge.rc === 1 && named && !diverge.err.includes("does not recompute") && agree.rc === 0;
  record("88-null-on_incomplete-is-refused-where-the-two-readers-diverge (both poles)", ok, ok ? "continue-vs-deny null refused and named; deny-vs-deny null accepted" : `divergeRc=${diverge.rc} named=${named} hashErr=${diverge.err.includes("does not recompute")} agreeRc=${agree.rc}`);
}

// 89 — STATIC ESM LOADS ARE WALKED, and a bare specifier is still an EXTERNAL.
// `import x from "./a.mjs"`, `import "./a.mjs"` and `export * from "./a.mjs"`
// all execute their target; before this, a `.mjs` file's whole import graph was
// invisible and verified clean. The accept pole is the LOCAL import reaching a
// file two hops down; the paired pole is a bare specifier, which must NOT
// become a pin (its bytes are not in this repo) and must NOT be refused.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const lib = path.join(root, ".claude", "hooks", "lib");
  fs.writeFileSync(path.join(lib, "esm-deep.mjs"), "export const d = 1;\n");
  fs.writeFileSync(path.join(lib, "esm-target.mjs"), 'import { d } from "./esm-deep.mjs";\nexport * from "./esm-reexport.mjs";\nexport const v = d;\n');
  fs.writeFileSync(path.join(lib, "esm-reexport.mjs"), "export const r = 2;\n");
  fs.writeFileSync(path.join(lib, "esm-ext.mjs"), 'import fs from "node:fs";\nimport path from "node:path";\nimport lodash from "lodash";\nexport const f = [fs, path, lodash];\n');
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nrequire(path.join(__dirname, "lib", "esm-target.mjs"));\nrequire(path.join(__dirname, "lib", "esm-ext.mjs"));\n'));
  const r = emit(root);
  const doc = readOut(r.outPath);
  const paths = doc ? doc.hooks[0].deps.map((d) => d.path) : [];
  const pinned = ["lib/esm-target.mjs", "lib/esm-deep.mjs", "lib/esm-reexport.mjs"].every((x) => paths.some((y) => y.endsWith(x)));
  const noExternalsAsDeps = !paths.some((x) => x.includes("lodash") || x === "node:fs" || x === "node:path");
  const ok = r.rc === 0 && pinned && noExternalsAsDeps;
  record("89-static-ESM-imports-are-walked-and-bare-specifiers-stay-external (both poles)", ok, ok ? "import + export-from pinned transitively; node:/npm specifiers not pinned and not refused" : `rc=${r.rc} pinned=${pinned} noExternalsAsDeps=${noExternalsAsDeps} deps=${paths.length} err=${r.err.trim().split("\n")[0]}`);
}

// 90 — NON-`./` SPECIFIERS THAT NAME A LOCAL PATH ARE REFUSED, not filed as
// externals. `.`, `..`, an absolute path and a `file:` URL are loads the walker
// cannot pin; the first revision dropped them into `externals` and said nothing.
// Three poles: a bare builtin/package still passes through untouched; an
// absolute path refuses and NAMES itself; and the same site with a declared
// exemption is accepted with the exemption carried in-document.
{
  const mk = (spec) => {
    const root = makeRoot({ hook: VALID_BLOCK });
    fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat(`\nrequire(${JSON.stringify(spec)});\n`));
    return root;
  };
  const abs = mk("/etc/hosts.js");
  const rAbs = emit(abs);
  const refusedAbs = rAbs.rc === 1 && rAbs.err.includes("/etc/hosts.js") && rAbs.err.includes("not statically resolvable");
  const dot = mk("..");
  const rDot = emit(dot);
  const refusedDot = rDot.rc === 1 && rDot.err.includes('".."');
  const fileUrl = mk("file:///tmp/x.js");
  const rFile = emit(fileUrl);
  const refusedFile = rFile.rc === 1 && rFile.err.includes("file:///tmp/x.js");
  // ACCEPT pole: bare specifiers are NOT local-path-shaped and stay externals.
  const bare = makeRoot({ hook: VALID_BLOCK });
  fs.writeFileSync(path.join(bare, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nrequire("node:fs");\nrequire("some-package");\n'));
  const rBare = emit(bare);
  const docBare = readOut(rBare.outPath);
  const bareOk = rBare.rc === 0 && docBare && !docBare.hooks[0].deps.some((d) => d.path.includes("some-package"));
  // ACCEPT pole 2: the declared exemption path works and travels in-document.
  // The SITE, read out of the refusal itself — a hand-written line number is a
  // second guess about the fixture, and the first attempt guessed wrong.
  const siteLine = /fixture-hook\.js:(\d+)/.exec(rAbs.err);
  const exempted = emit(abs, ["--dynamic-require-exempt", `.claude/hooks/fixture-hook.js:${siteLine ? siteLine[1] : "MISSING"}`, "--json"]);
  const docEx = readOut(exempted.outPath);
  const exemptOk = exempted.rc === 0 && docEx && (docEx.dynamic_require_exemptions || []).some((e) => e.file === ".claude/hooks/fixture-hook.js");
  const ok = refusedAbs && refusedDot && refusedFile && bareOk && exemptOk;
  record("90-local-path-shaped-non-relative-specifiers-are-refused-not-dropped", ok, ok ? "absolute/../file: refused by name; node:/package untouched; exemption accepted in-document" : `abs=${refusedAbs} dot=${refusedDot} file=${refusedFile} bare=${bareOk} exempt=${exemptOk}`);
}

// 91 — require.call/apply resolves ONLY A LITERAL IN THE SPECIFIER POSITION.
// The previous revision counted any single string token in the argument window,
// so `require.call(null, process.env.HOOK_IMPL || "./a.js")` resolved to ./a.js
// — the substitution bug F2 fixed elsewhere, reintroduced in this spelling. Two
// poles: the literal form still pins; the computed form refuses AND does not pin
// the string it merely mentions.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const lib = path.join(root, ".claude", "hooks", "lib");
  fs.writeFileSync(path.join(lib, "call-lit.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(lib, "call-other.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nvoid require.call(null, "./lib/call-lit.js");\n'));
  const rLit = emit(root);
  const docLit = readOut(rLit.outPath);
  const litPinned = docLit && docLit.hooks[0].deps.some((d) => d.path.endsWith("lib/call-lit.js"));
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nvoid require.call(null, process.env.HOOK_IMPL || "./lib/call-other.js");\n'));
  const rDyn = emit(root);
  const dynRefused = rDyn.rc === 1 && rDyn.err.includes("not statically resolvable");
  // A THIRD POLE, because the first reject pole alone did not exercise the type
  // check: `process.env.X || "./a.js"` is refused by the ARITY check that
  // follows, so dropping the "the specifier token must BE a string" test left
  // the whole battery green (MEASURED: the mutation was inert against this
  // case). A bare identifier in the specifier position IS that test's shape.
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nvoid require.call(null, HOOK_IMPL);\n'));
  const rIdent = emit(root);
  const identRefused = rIdent.rc === 1 && rIdent.err.includes("not statically resolvable");
  const docIdent = readOut(rIdent.outPath);
  const identNotPinned = !docIdent || !docIdent.hooks.some((h) => (h.deps || []).some((d) => d.path.endsWith("lib/call-other.js")));
  const ok = rLit.rc === 0 && Boolean(litPinned) && dynRefused && identRefused && identNotPinned;
  record("91-require.call-resolves-a-literal-specifier-only (3 poles)", ok, ok ? "literal pinned; `A || \"./a.js\"` and a bare identifier both refused" : `litRc=${rLit.rc} pinned=${litPinned} dynRc=${rDyn.rc} refused=${dynRefused} identRc=${rIdent.rc} identRefused=${identRefused} identNotPinned=${identNotPinned}`);
}

// 92 — createRequire RESULTS ARE ALIASES OF require, and their call sites are
// walked: a literal or a path.join(__dirname, …) argument resolves and pins,
// anything else is a dynamic site (refused unless a per-site exemption is
// recorded). Both poles are needed — the alias form is the DOMINANT loader in
// every .mjs file here, so a blanket refusal would be unusable and a blanket
// pass would be the hole the alias was before.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const lib = path.join(root, ".claude", "hooks", "lib");
  fs.writeFileSync(path.join(lib, "alias-target.cjs"), "module.exports = {};\n");
  fs.writeFileSync(
    path.join(lib, "with-create.mjs"),
    'import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\nconst a = r("./alias-target.cjs");\nvoid a;\n',
  );
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nrequire(path.join(__dirname, "lib", "with-create.mjs"));\n'));
  const rOk = emit(root);
  const docOk = readOut(rOk.outPath);
  const pinned = docOk && docOk.hooks[0].deps.some((d) => d.path.endsWith("lib/alias-target.cjs"));
  fs.writeFileSync(
    path.join(lib, "with-create-dyn.mjs"),
    'import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\nconst p = process.env.HOOK_IMPL;\nconst a = r(p);\nvoid a;\n',
  );
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nrequire(path.join(__dirname, "lib", "with-create-dyn.mjs"));\n'));
  const rDyn = emit(root);
  const refused = rDyn.rc === 1 && rDyn.err.includes("with-create-dyn.mjs");
  const ok = rOk.rc === 0 && Boolean(pinned) && refused;
  record("92-createRequire-alias-call-sites-are-walked (both poles)", ok, ok ? "literal alias call pinned; computed alias call refused at its site" : `okRc=${rOk.rc} pinned=${pinned} dynRc=${rDyn.rc} refused=${refused}`);
}

// 93 — SPAWN BY PATH. `spawnSync(process.execPath, [<script>])` EXECUTES the
// script; three shapes, each measured: a __dirname-anchored path pins; a path
// built from the PROJECT ROOT through a binding pins; an unresolvable script
// argument refuses; and `__filename` (a file re-invoking itself) is neither a
// pin nor a hole, because the file's own bytes are already pinned.
{
  const spawnBlock = VALID_BLOCK.replace('"spawns": []', '"spawns": ["node"]');
  const root = makeRoot({ hook: spawnBlock });
  const hooks = path.join(root, ".claude", "hooks");
  fs.writeFileSync(path.join(hooks, "spawned-here.js"), "module.exports = {};\n");
  // mkdir BEFORE the write (the makeRoot helper creates only .claude/hooks) —
  // the same trap case 74 records, hit again here.
  fs.mkdirSync(path.join(root, ".claude", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "bin", "spawned-root.mjs"), "export const x = 1;\n");
  // accept A + accept B + __filename, in one hook
  fs.writeFileSync(
    path.join(hooks, "fixture-hook.js"),
    spawnBlock.concat(
      '\nconst { spawnSync } = require("node:child_process");\n' +
        'const projectDir = process.env.CLAUDE_PROJECT_DIR;\n' +
        'const GEN_REL = path.join(".claude", "bin", "spawned-root.mjs");\n' +
        'const gen = path.join(projectDir, GEN_REL);\n' +
        'spawnSync(process.execPath, [path.join(__dirname, "spawned-here.js")], {});\n' +
        'spawnSync(process.execPath, [gen, "--check"], {});\n' +
        'spawnSync(process.execPath, [__filename, "--self-probe"], {});\n',
    ),
  );
  const rOk = emit(root);
  const docOk = readOut(rOk.outPath);
  const paths = docOk ? docOk.hooks[0].deps.map((d) => d.path) : [];
  const herePinned = paths.some((x) => x.endsWith("spawned-here.js"));
  const rootPinned = paths.some((x) => x.endsWith("spawned-root.mjs"));
  const selfNotPinned = !paths.some((x) => x.endsWith("fixture-hook.js"));
  // reject: the script argument is a parameter the walker cannot resolve
  const root2 = makeRoot({ hook: spawnBlock });
  fs.writeFileSync(
    path.join(root2, ".claude", "hooks", "fixture-hook.js"),
    spawnBlock.concat('\nconst { spawnSync } = require("node:child_process");\nfunction run(s) { spawnSync(process.execPath, [s], {}); }\nvoid run;\n'),
  );
  const rDyn = emit(root2);
  const refused = rDyn.rc === 1 && rDyn.err.includes("spawn-by-path");
  const ok = rOk.rc === 0 && herePinned && rootPinned && selfNotPinned && refused;
  record("93-spawn-by-path-is-pinned (dirname, root-anchored, self, unresolvable)", ok, ok ? "__dirname path and root-anchored path pinned; __filename neither; unresolvable refused" : `rc=${rOk.rc} here=${herePinned} root=${rootPinned} self=${selfNotPinned} dynRc=${rDyn.rc} refused=${refused}`);
}

// 94 — A SYMLINK OUT OF THE TREE IS REFUSED. Case 68 escapes by `../`; this is
// the other escape shape, where the SPECIFIER is an ordinary ./lib path and the
// filesystem redirects it — the containment decision must run on the RESOLVED
// path, which is what makes the symlink case different from the lexical one.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const outside = path.join(path.dirname(root), `outside-link-${path.basename(root)}.js`);
  fs.writeFileSync(outside, "module.exports = { secret: 1 };\n");
  fs.symlinkSync(outside, path.join(root, ".claude", "hooks", "lib", "linked.js"));
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nrequire(path.join(__dirname, "lib", "linked.js"));\n'));
  const r = emit(root);
  const refused = r.rc === 1 && r.err.includes("resolves OUTSIDE the repo root");
  // ACCEPT pole: the same symlink shape pointing INSIDE the tree resolves.
  const rootIn = makeRoot({ hook: VALID_BLOCK });
  fs.writeFileSync(path.join(rootIn, ".claude", "hooks", "lib", "real.js"), "module.exports = {};\n");
  fs.symlinkSync(path.join(rootIn, ".claude", "hooks", "lib", "real.js"), path.join(rootIn, ".claude", "hooks", "lib", "linked-in.js"));
  fs.writeFileSync(path.join(rootIn, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nrequire(path.join(__dirname, "lib", "linked-in.js"));\n'));
  const rIn = emit(rootIn);
  const docIn = readOut(rIn.outPath);
  const inPinned = docIn && docIn.hooks[0].deps.some((d) => d.path.endsWith("lib/real.js"));
  const ok = refused && rIn.rc === 0 && Boolean(inPinned);
  record("94-a-symlink-out-of-the-tree-is-refused (both poles)", ok, ok ? "escaping symlink refused on the resolved path; in-tree symlink resolves to its target" : `rc=${r.rc} refused=${refused} inRc=${rIn.rc} pinned=${inPinned}`);
}

// 95 — THE RUNTIME PINS. A manifest must carry every runtime entry the contract
// names (the supervisor included), and a runtime entry may not be a symlink —
// the row check has existed since case 29; the manifest-level one checked
// existence only. Three poles: a document missing an entry is refused; a root
// whose runtime entry is a symlink is refused; the untouched root emits.
{
  const base = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
  const doc = JSON.parse(JSON.stringify(base));
  const drop = doc.runtimes.find((r) => r.entry.endsWith("local-supervisor.js"));
  doc.runtimes = doc.runtimes.filter((r) => r !== drop);
  const tmp = path.join(SCRATCH, "no-supervisor.json");
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  doc.content_sha256 = run([CONTRACT, "hash", tmp]).out.trim();
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  const rDrop = run([CONTRACT, "validate", tmp]);
  const named = rDrop.err.includes("local-supervisor.js") && rDrop.err.includes("runtimes");
  const root = makeRoot({ hook: VALID_BLOCK });
  const sup = path.join(root, ".claude", "hooks", "lib", "local-supervisor.js");
  const outside = path.join(path.dirname(root), `sup-${path.basename(root)}.js`);
  fs.writeFileSync(outside, '"use strict";\nmodule.exports = { supervise() {} };\n');
  fs.rmSync(sup);
  fs.symlinkSync(outside, sup);
  const rLink = emit(root);
  const linkRefused = rLink.rc === 1 && rLink.err.includes("local-supervisor.js") && rLink.err.includes("SYMLINK");
  const ok = rDrop.rc === 1 && named && linkRefused;
  record("95-runtime-pins-require-every-entry-and-refuse-a-symlink (both rejects)", ok, ok ? "missing supervisor entry named by the validator; symlinked runtime entry refused by the emitter" : `dropRc=${rDrop.rc} named=${named} linkRc=${rLink.rc} linkRefused=${linkRefused}`);
}

// 96 — THE BRACKET FORM OF A DECISION KEY. `reply["updatedInput"] = x` is the
// same undeclared rewrite as the quoted-key form case 84 closed: the quoted-key
// scan requires the NEXT token to be `:`, and a bracket access closes with `]`,
// so this spelling walked through every check. Both poles: refused when
// may_rewrite_input is false, accepted when it is true.
{
  const src = 'module.exports = { hookMain() { const r = {}; r["updatedInput"] = { x: 1 }; return r; } };\n';
  const root = makeRoot({ hook: VALID_BLOCK.concat(`\n${src}`) });
  const r = emit(root);
  const refused = r.rc === 1 && r.err.includes("may_rewrite_input:false");
  const root2 = makeRoot({ hook: VALID_BLOCK.replace('"may_rewrite_input": false', '"may_rewrite_input": true').concat(`\n${src}`) });
  const r2 = emit(root2);
  const ok = refused && r2.rc === 0;
  record("96-bracketed-updatedInput-is-the-same-rewrite (both poles)", ok, ok ? 'r["updatedInput"] refused undeclared; accepted when declared' : `refusedRc=${r.rc}(${refused}) declaredRc=${r2.rc}`);
}


// 97 — THE VALIDATOR'S STRICT CHECKS, both halves. `validateManifest()` is the
// function every in-process caller uses (the emitter's self-check included), and
// the strict checks used to live ONLY in the `validate` subcommand — so a caller
// that parsed the document itself validated one whose defects JSON.parse had
// already flattened. Two poles, one per half:
//   (a) the OBJECT sweep, isolated so the hash recompute cannot mask it: a
//       surrogate is a defect the canonicalizer does NOT refuse, so the hash
//       still recomputes and the ONLY error naming it is findUnrepresentable's;
//   (b) the TEXT scan, which needs `opts.text` because a duplicate key exists
//       only in the bytes.
{
  const { validateManifest } = require_(path.join(REPO, ".claude", "hooks", "lib", "hook-registry-contract.js"));
  const base = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));

  // (a) OBJECT sweep — a lone surrogate in a value.
  const docA = JSON.parse(JSON.stringify(base));
  docA.hooks[0].matcher = `x${String.fromCharCode(0xd800)}y`;
  const resA = validateManifest(docA);
  const namedA = resA.valid === false && resA.errors.some((e) => e.includes("lone surrogate"));

  // (b) TEXT scan — a duplicate key, invisible to the object half.
  const raw = JSON.stringify(base, null, 2);
  const spoofed = raw.replace('"version": "1.0.0"', '"version": "1.0.0", "\\u0076ersion": "1.0.0"');
  const dupAlone = validateManifest(JSON.parse(spoofed));
  const dupWithText = validateManifest(JSON.parse(spoofed), { text: spoofed });
  const namedB = dupWithText.valid === false && dupWithText.errors.some((e) => e.includes("duplicate object key"));
  // The object half ALONE must not see it — otherwise (b) would pass for the
  // wrong reason and the `opts.text` wiring would be unverified.
  const objectBlind = !dupAlone.errors.some((e) => e.includes("duplicate object key"));

  // ACCEPT pole: the untouched sample still validates, so neither half refuses
  // documents that are merely large.
  const clean = validateManifest(JSON.parse(raw), { text: raw });
  const ok = namedA && namedB && objectBlind && clean.valid === true;
  record(
    "97-validator-strict-checks-run-in-process (both halves)",
    ok,
    ok
      ? "surrogate named by the object sweep with the hash intact; duplicate key named only through opts.text; clean sample still valid"
      : `surrogate=${namedA} dup=${namedB} objectBlind=${objectBlind} cleanValid=${clean.valid} cleanErrs=${JSON.stringify(clean.errors.slice(0, 2))}`,
  );
}


// 98 — THE RECEIVER NETWORK FORM. The scan matches a network call by METHOD plus
// a RECEIVER binding (`http.request`, `tls.connect`), and MEASURED against this
// battery: no case source touched that branch — every network fixture used the
// bare `fetch(...)` form — so deleting the receiver half of the check left the
// whole battery green. Both poles here, because a clause that refuses every
// receiver form would satisfy the reject pole alone.
{
  // GET-ONLY, and that is the point: carrying `https.get` AND `https.request`
  // together made the case blind to the MEMBER — removing `get` from
  // NET_METHODS left the battery green because the request spelling still fired
  // (MEASURED, the seat-closure review's MEDIUM). One member per fixture.
  const getSrc = '\nconst https = require("node:https");\nvoid https.get("https://example.invalid/x");\n';
  const reqSrc = '\nconst https = require("node:https");\nvoid https.request("https://example.invalid/y");\n';
  const root = makeRoot({ hook: VALID_BLOCK.concat(getSrc) });
  const r = emit(root);
  const refusedGet = r.rc === 1 && r.err.includes("declares network:false");
  const reqRoot = makeRoot({ hook: VALID_BLOCK.concat(reqSrc) });
  const rReq = emit(reqRoot);
  const refusedReq = rReq.rc === 1 && rReq.err.includes("declares network:false");
  const twin = makeRoot({ hook: VALID_BLOCK.replace('"network": false', '"network": true').concat(getSrc) });
  const rTwin = emit(twin);
  const ok = refusedGet && refusedReq && rTwin.rc === 0;
  record(
    "98-receiver-network-form-is-detected (get-only, request-only, both poles)",
    ok,
    ok ? "https.get refused on its own; https.request refused on its own; declared source accepted" : `get=${refusedGet}(${r.rc}) request=${refusedReq}(${rReq.rc}) twinRc=${rTwin.rc} err=${r.err.trim().split("\n").pop().slice(0, 110)}`,
  );
}

// 99 — THE PIN IS OVER RAW BYTES. `file_sha256` must hash what is ON DISK, not a
// UTF-8 decode re-encoded: for a file carrying bytes that are not valid UTF-8 the
// two differ, and a consumer hashing the file itself would compute the raw digest
// and report a mismatch — a false tamper alarm on every verification. No fixture
// wrote invalid UTF-8, so the difference was unexercised. The case asserts BOTH
// halves: the pin equals the raw-bytes digest AND the lossy form provably differs.
{
  const body = Buffer.from(VALID_BLOCK, "utf8");
  const raw = Buffer.concat([body, Buffer.from("// ", "utf8"), Buffer.from([0xff, 0xfe]), Buffer.from("\n", "utf8")]);
  const root = makeRoot({ hook: VALID_BLOCK });
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), raw);
  const r = emit(root);
  const doc = readOut(r.outPath);
  const wantRaw = crypto.createHash("sha256").update(raw).digest("hex");
  const lossy = crypto.createHash("sha256").update(raw.toString("utf8"), "utf8").digest("hex");
  const ok = r.rc === 0 && doc && doc.hooks[0].file_sha256 === wantRaw && wantRaw !== lossy;
  record(
    "99-file_sha256-is-over-raw-bytes (decode/re-encode differs)",
    ok,
    ok
      ? "pin equals the raw digest; the lossy decode digest provably differs"
      : `rc=${r.rc} pin=${doc && doc.hooks[0].file_sha256.slice(0, 12)} want=${wantRaw.slice(0, 12)} lossy=${lossy.slice(0, 12)} differ=${wantRaw !== lossy} err=${r.err.trim().split("\n").pop().slice(0, 120)}`,
  );
}


// 100 — F1, THE WHOLE-EXPRESSION RULE ON THE PLAIN LITERAL BRANCHES. A string
// that HEADS a larger expression is not the path that loads: `require("./a.js" +
// suffix)` resolves at runtime by the expression, so pinning the string pins a
// file the row may never load — a WRONG PIN, which reads as a complete closure.
// Case 91 learned this for `require.call`; the plain branches had no such check
// until the security re-verify measured it. Two hostile shapes plus the control
// that keeps the fix from refusing every literal.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const lib = path.join(root, ".claude", "hooks", "lib");
  fs.writeFileSync(path.join(lib, "decoy.js"), "module.exports = {};\n");
  // (a) the literal heads a concat CALL SITE
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nconst suffix = process.env.SUFFIX || "";\nrequire("./lib/decoy.js" + suffix);\n'));
  const rConcat = emit(root);
  const refusedConcat = rConcat.rc === 1 && rConcat.err.includes("larger expression");
  // (b) the literal heads a concat BINDING, which PASS 0 used to register as a
  // plain string constant and drop the rest of the expression
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nconst P = "./lib/decoy.js" + (process.env.SUFFIX || "");\nrequire(P);\n'));
  const rBind = emit(root);
  const refusedBind = rBind.rc === 1 && rBind.err.includes("not statically resolvable");
  // CONTROL: the same path as a bare literal still pins, so the fix is not
  // "refuse every literal".
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nrequire("./lib/decoy.js");\n'));
  const rPlain = emit(root);
  const docPlain = readOut(rPlain.outPath);
  const pinnedPlain = docPlain && docPlain.hooks[0].deps.some((d) => d.path.endsWith("lib/decoy.js"));
  const ok = refusedConcat && refusedBind && rPlain.rc === 0 && Boolean(pinnedPlain);
  record("100-head-of-an-expression-is-not-the-specifier (2 hostile + control)", ok, ok ? "concat call site and concat binding both refused; the bare literal still pins" : `concat=${refusedConcat}(${rConcat.rc}) binding=${refusedBind}(${rBind.rc}) plain=${rPlain.rc}:${pinnedPlain}`);
}

// 101 — THE BARE `__filename` ANCHOR NEEDS PROOF (require side). `path.dirname(
// __filename)` is the file's own directory ONLY while the identifier still holds
// it. A file that REASSIGNS it makes the anchor name somewhere else, and a walker
// that trusts the keyword pins an IN-TREE DECOY while node loads the file the
// reassignment names — the wrong-pin class, on the anchor this batch introduced.
// The pair is the proof that the pole measures the REASSIGNMENT and not the
// shape: the same source without it pins the file's real sibling.
{
  const mk = (reassign) => {
    const root = makeRoot({ hook: VALID_BLOCK });
    // `path.dirname(__filename)` is the HOOK file's OWN directory, so the file an
    // unreassigned anchor names sits in `.claude/hooks/`, NOT in its lib/.
    fs.writeFileSync(path.join(root, ".claude", "hooks", "impl.js"), "module.exports = {};\n");
    const outside = path.join(path.dirname(root), `outside-anchor-${path.basename(root)}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "impl.js"), "module.exports = { outside: true };\n");
    fs.writeFileSync(
      path.join(root, ".claude", "hooks", "fixture-hook.js"),
      VALID_BLOCK.concat(`\n${reassign ? `__filename = ${JSON.stringify(outside)};\n` : ""}const D = path.dirname(__filename);\nrequire(path.join(D, "impl.js"));\n`),
    );
    return root;
  };
  const hostile = mk(true);
  const r = emit(hostile);
  const refused = r.rc === 1 && r.err.includes("not statically resolvable");
  const doc = readOut(r.outPath);
  const noDecoy = !doc || !doc.hooks.some((h) => (h.deps || []).some((d) => d.path === ".claude/hooks/impl.js"));
  // CONTROL: no reassignment ⇒ the anchor is the file's own directory ⇒ the
  // sibling pins. Without this the pole could pass on a walker that refuses the
  // shape outright.
  const control = mk(false);
  const rCtl = emit(control);
  const docCtl = readOut(rCtl.outPath);
  const pinnedSibling = docCtl && docCtl.hooks[0].deps.some((d) => d.path === ".claude/hooks/impl.js");
  const ok = refused && noDecoy && rCtl.rc === 0 && Boolean(pinnedSibling);
  record("101-a-reassigned-__filename-anchor-is-not-a-pin (require + control)", ok, ok ? "reassigned anchor refused with the decoy unpinned; unreassigned control pins its real sibling" : `refused=${refused}(${r.rc}) noDecoy=${noDecoy} ctlRc=${rCtl.rc} pinned=${pinnedSibling} ctlErr=${(rCtl.err || "").split("\n").filter((l) => l.includes("emit-hook-registry")).pop() || ""}`.slice(0, 300));
}

// 102 — THE SAME PROOF ON THE SPAWN SIDE. The spawn reader recognized a bare
// `__filename` as SELF (no pin needed, its bytes are file_sha256) with no
// provenance check, so a reassigned identifier made a hostile file look like it
// spawns itself while the expression names a file from elsewhere. Same pair:
// reassigned ⇒ refused; unreassigned ⇒ the file's real sibling is pinned.
{
  const spawnBlock = VALID_BLOCK.replace('"spawns": []', '"spawns": ["node"]');
  const mk = (reassign) => {
    const root = makeRoot({ hook: spawnBlock });
    fs.writeFileSync(path.join(root, ".claude", "hooks", "runner.js"), "module.exports = {};\n");
    const outside = path.join(path.dirname(root), `outside-spawn-${path.basename(root)}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "runner.js"), "module.exports = { outside: true };\n");
    fs.writeFileSync(
      path.join(root, ".claude", "hooks", "fixture-hook.js"),
      spawnBlock.concat(`\nconst { spawnSync } = require("node:child_process");\n${reassign ? `__filename = ${JSON.stringify(outside)};\n` : ""}const D = path.dirname(__filename);\nspawnSync(process.execPath, [path.join(D, "runner.js")], {});\n`),
    );
    return root;
  };
  const hostile = mk(true);
  const r = emit(hostile);
  const refused = r.rc === 1 && r.err.includes("not statically resolvable");
  const doc = readOut(r.outPath);
  const noDecoy = !doc || !doc.hooks.some((h) => (h.deps || []).some((d) => d.path === ".claude/hooks/runner.js"));
  const control = mk(false);
  const rCtl = emit(control);
  const docCtl = readOut(rCtl.outPath);
  const pinnedSibling = docCtl && docCtl.hooks[0].deps.some((d) => d.path === ".claude/hooks/runner.js");
  const ok = refused && noDecoy && rCtl.rc === 0 && Boolean(pinnedSibling);
  record("102-a-reassigned-__filename-spawn-is-not-self (spawn + control)", ok, ok ? "reassigned spawn anchor refused with the decoy unpinned; unreassigned control pins its real sibling" : `refused=${refused}(${r.rc}) noDecoy=${noDecoy} ctlRc=${rCtl.rc} pinned=${pinnedSibling} ctlErr=${(rCtl.err || "").split("\n").filter((l) => l.includes("emit-hook-registry")).pop() || ""}`.slice(0, 300));
}


// 103 — THE SPAWN READER'S OWN SELF-CHECK, which case 102 does NOT aim at: there
// the script argument is `path.join(D, "runner.js")` — the PASS-4 ANCHOR — while
// this one passes the bare identifier `__filename` as the script. The spawn
// reader recognizes that as SELF (no pin needed: the file's own bytes are
// file_sha256), and with no provenance check a hostile reassignment made a file
// that spawns SOMEONE ELSE look like it spawns itself — a silent false claim
// rather than a wrong pin, which is why the mutation on it first came back
// EMPTY (A2, no reds) and forced this pole into existence.
{
  const spawnBlock = VALID_BLOCK.replace('"spawns": []', '"spawns": ["node"]');
  const mk = (reassign) => {
    const root = makeRoot({ hook: spawnBlock });
    const outside = path.join(path.dirname(root), `outside-self-${path.basename(root)}.js`);
    fs.writeFileSync(outside, "module.exports = { outside: true };\n");
    fs.writeFileSync(
      path.join(root, ".claude", "hooks", "fixture-hook.js"),
      spawnBlock.concat(`\nconst { spawnSync } = require("node:child_process");\n${reassign ? `__filename = ${JSON.stringify(outside)};\n` : ""}spawnSync(process.execPath, [__filename, "--probe"], {});\n`),
    );
    return root;
  };
  // REASSIGNED ⇒ not self, and nothing resolves it ⇒ refused.
  const r = emit(mk(true));
  const refused = r.rc === 1 && r.err.includes("not statically resolvable");
  // UNREASSIGNED ⇒ SELF: emitted, and the file is NOT a deps entry of itself
  // (its bytes are the row's file_sha256, so a self-edge would be a duplicate).
  const rCtl = emit(mk(false));
  const docCtl = readOut(rCtl.outPath);
  const selfNotPinned = docCtl && !docCtl.hooks.some((h) => (h.deps || []).some((d) => d.path === ".claude/hooks/fixture-hook.js"));
  const ok = refused && rCtl.rc === 0 && Boolean(selfNotPinned);
  record("103-a-reassigned-__filename-spawn-argument-is-not-self (both poles)", ok, ok ? "reassigned bare __filename refused; unreassigned one is SELF (emitted, no self-edge)" : `refused=${refused}(${r.rc}) ctlRc=${rCtl.rc} selfNotPinned=${selfNotPinned} err=${(r.err || "").split("\n").filter((l) => l.includes("emit-hook-registry")).pop() || ""}`.slice(0, 260));
}


// 104/105 — THE TWO SURVIVING SPELLINGS OF THE ANCHOR BYPASS. The provenance
// scan looked for a reassignment (`NAME =` with a non-declaration token before
// it) and for the shim, so it missed BOTH of these: a DECLARATION with another
// initializer (`var __filename = <outside>`), which is a SHADOW and was skipped
// by the declaration branch; and a DESTRUCTURING ASSIGNMENT (`[__filename] = [x]`),
// whose `=` sits behind a `]`. MEASURED by the security re-verify: in a CJS file
// either spelling read as PROVEN, so the emitter pinned the in-tree decoy while
// node loaded the file the shadow names — the wrong-pin class again, no live
// occurrence in this tree. Each case carries the REQUIRE variant, the SPAWN
// variant, and the CONTROL that keeps the unshadowed spelling pinning.
{
  const mkCase = (spelling, name) => {
  const spawnBlock = VALID_BLOCK.replace('"spawns": []', '"spawns": ["node"]');
  const build = (shadow, spawnVariant) => {
    const root = makeRoot({ hook: spawnBlock });
    const lib = path.join(root, ".claude", "hooks", "lib");
    const leaf = spawnVariant ? "runner.js" : "impl.js";
    fs.writeFileSync(path.join(lib, leaf), "module.exports = {};\n");
    const outsideDir = path.join(path.dirname(root), `outside-${spelling}-${path.basename(root)}${spawnVariant ? "-s" : ""}`);
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, leaf), "module.exports = { outside: true };\n");
    const load = spawnVariant
      ? `const { spawnSync } = require("node:child_process");\nspawnSync(process.execPath, [path.join(D, ${JSON.stringify(leaf)})], {});\n`
      : `require(path.join(D, ${JSON.stringify(leaf)}));\n`;
    const shadowLine = shadow
      ? spelling === "var"
        ? `var __filename = ${JSON.stringify(path.join(outsideDir, "probe.js"))};\n`
        : `[__filename] = [${JSON.stringify(path.join(outsideDir, "probe.js"))}];\n`
      : "";
    fs.writeFileSync(
      path.join(lib, "shadower.js"),
      `"use strict";\n${shadowLine}const D = path.dirname(__filename);\n${load}`,
    );
    fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), spawnBlock.concat('\nrequire(path.join(__dirname, "lib", "shadower.js"));\n'));
    return { root, leaf };
  };
  // HOSTILE, require variant
  const rq = build(true, false);
  const r1 = emit(rq.root);
  const d1 = readOut(r1.outPath);
  const reqOk = r1.rc === 1 && r1.err.includes("not statically resolvable") &&
    (!d1 || !d1.hooks.some((h) => (h.deps || []).some((x) => x.path.endsWith(`lib/${rq.leaf}`))));
  // HOSTILE, spawn variant
  const sp = build(true, true);
  const r2 = emit(sp.root);
  const d2 = readOut(r2.outPath);
  const spOk = r2.rc === 1 && r2.err.includes("not statically resolvable") &&
    (!d2 || !d2.hooks.some((h) => (h.deps || []).some((x) => x.path.endsWith(`lib/${sp.leaf}`))));
  // CONTROL: unshadowed ⇒ the anchor is the file's own directory ⇒ real sibling pins
  const ct = build(false, false);
  const r3 = emit(ct.root);
  const d3 = readOut(r3.outPath);
  const ctlOk = r3.rc === 0 && d3 && d3.hooks[0].deps.some((x) => x.path.endsWith(`lib/${ct.leaf}`));
  return { ok: reqOk && spOk && ctlOk, detail: `require=${reqOk}(${r1.rc}) spawn=${spOk}(${r2.rc}) control=${ctlOk}(${r3.rc})` };
  };
  const v = mkCase("var", "var");
  record("104-a-non-shim-DECLARATION-of-__filename-is-unproven (require + spawn + control)", v.ok, v.ok ? "`var __filename = <outside>` refused on both load forms with the decoy unpinned; unshadowed control pins" : v.detail);
  const w = mkCase("destructure", "destructure");
  record("105-a-DESTRUCTURED-__filename-assignment-is-unproven (require + spawn + control)", w.ok, w.ok ? "`[__filename] = [outside]` refused on both load forms with the decoy unpinned; unshadowed control pins" : w.detail);
}

// 106 — THE ESM SHIM SPELLING STILL PINS. The proof accepts `__filename` in an
// ESM file only through the file's own shim, so the shim branch needs a POSITIVE
// pole of its own: cases 101-105 all exercise the CJS branch. Here a `.mjs` file
// declares the shim and loads its sibling through `path.dirname(__filename)`.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const lib = path.join(root, ".claude", "hooks", "lib");
  fs.writeFileSync(path.join(lib, "a-ok.cjs"), "module.exports = {};\n");
  fs.writeFileSync(
    path.join(lib, "anchored.mjs"),
    'import path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst __filename = fileURLToPath(import.meta.url);\nconst D = path.dirname(__filename);\nexport const m = await import(path.join(D, "a-ok.cjs"));\n',
  );
  fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), VALID_BLOCK.concat('\nrequire(path.join(__dirname, "lib", "anchored.mjs"));\n'));
  const r = emit(root);
  const doc = readOut(r.outPath);
  const pinned = doc && doc.hooks[0].deps.some((x) => x.path.endsWith("lib/a-ok.cjs"));
  const ok = r.rc === 0 && Boolean(pinned);
  record("106-the-ESM-shim-anchor-still-pins (positive pole)", ok, ok ? "shim-declared __filename resolves to the file's own directory; a-ok.cjs pinned" : `rc=${r.rc} pinned=${pinned} err=${r.err.trim().split("\n").pop().slice(0, 140)}`);
}


// 107 — M4, DRIVEN IN A CONSUMER-SHAPED CLONE. Case 73 covers the EXPORT shape
// (a tree with no git at all); this is the other resolvability branch, and the
// one a real consumer hits: a git repo that carries its OWN commit but does NOT
// carry the sha the emitter is asked to compare against, so `git rev-parse
// <sha>:<rel>` returns null for every file. Loom's HEAD sha stands in for that
// absent commit — it is a real object in the emitting repo and a guarantee-absent
// one here.
//
// THE PAIR IS THE POINT. The same tree, the same command, one flag different:
// the clone's own sha RESOLVES the split (every committed row reads
// loom-template/template, no warning), and loom's sha CANNOT (every row reads
// repo-local/repo, the warning is LOUD, and the safe-fail direction is asserted
// explicitly — NOT ONE row claims loom-template, which is the false provenance
// claim that would make a consumer trust a pin that does not exist).
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const gitIn = (args) => spawnSync("git", ["-c", "user.email=fixture@local", "-c", "user.name=fixture", ...args], { cwd: root, encoding: "utf8" });
  gitIn(["init", "-q"]);
  gitIn(["add", "-A"]);
  gitIn(["commit", "-qm", "fixture"]);
  const ownSha = gitIn(["rev-parse", "HEAD"]).stdout.trim();
  const loomSha = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const shaOk = /^[0-9a-f]{40}$/.test(ownSha) && /^[0-9a-f]{40}$/.test(loomSha) && ownSha !== loomSha;

  // CONTROL — the clone's own sha: the split resolves, nothing degrades.
  // The harness's own third parameter names the sha; appending `--source-sha` as
  // an EXTRA left the harness's default ZERO_SHA in the argv, and the emitter
  // takes the LAST one — so the control silently ran against an unresolvable sha
  // and failed for the harness's reason rather than the subject's.
  const rCtl = emit(root, ["--json"], ownSha);
  const docCtl = readOut(rCtl.outPath);
  const ctlSplit = docCtl && docCtl.hooks.length > 0 && docCtl.hooks.every((h) => h.source === "loom-template" && h.pool === "template");
  const ctlQuiet = !rCtl.err.includes("could not be resolved");

  // CONSUMER — a sha this clone does not carry: degraded, loud, and honest.
  const rCon = emit(root, ["--json"], loomSha);
  const rep = jsonReport(rCon.err);
  const loud = rCon.err.includes("could not be resolved") && rCon.err.includes('every row is labelled source "repo-local"');
  const docCon = readOut(rCon.outPath);
  const allRepoLocal = docCon && docCon.hooks.length > 0 && docCon.hooks.every((h) => h.source === "repo-local" && h.pool === "repo");
  const noFalseClaim = docCon && !docCon.hooks.some((h) => h.source === "loom-template" || h.pool === "template");
  const declared = rep && rep.source_drift && rep.source_drift.checked === false && typeof rep.source_drift.reason === "string";

  const ok = shaOk && rCtl.rc === 0 && ctlSplit && ctlQuiet && rCon.rc === 0 && loud && allRepoLocal && noFalseClaim && declared;
  record(
    "107-a-consumer-clone-degrades-the-provenance-split-safely (control + consumer)",
    ok,
    ok
      ? "own sha ⇒ loom-template/template and quiet; absent sha ⇒ repo-local/repo, LOUD, reason in --json, and no row claims loom-template"
      : `shaOk=${shaOk} ctlRc=${rCtl.rc} ctlSplit=${ctlSplit} ctlQuiet=${ctlQuiet} conRc=${rCon.rc} loud=${loud} allRepoLocal=${allRepoLocal} noFalseClaim=${noFalseClaim} declared=${declared}`,
  );
}


// 108/109 — THE SPELLINGS THAT ENDED THE ENUMERATION. The provenance rule was
// built by listing the ways `__filename` could be redirected, and the security
// lens kept finding constructions the list had not thought of; these two are the
// ones that made the point: `for (__filename of […])` (the loop variable is a
// WRITE, and the `=` is nowhere near it) and `__filename &&= …` (a compound
// assignment operator, not `=`). Both are now refused by the INVERTED rule —
// every occurrence must be read-shaped or the anchor is unproven — and each case
// carries the control that keeps a genuine read pinning, so the fix cannot pass
// by refusing every file that mentions the name.
{
  const spawnBlock = VALID_BLOCK.replace('"spawns": []', '"spawns": ["node"]');
  const mk = (hostile, spawnVariant) => {
    const root = makeRoot({ hook: spawnBlock });
    const lib = path.join(root, ".claude", "hooks", "lib");
    const leaf = spawnVariant ? "runner.js" : "impl.js";
    fs.writeFileSync(path.join(lib, leaf), "module.exports = {};\n");
    const outsideDir = path.join(path.dirname(root), `outside-${hostile}-${path.basename(root)}${spawnVariant ? "-s" : ""}`);
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, leaf), "module.exports = { outside: true };\n");
    const evil = JSON.stringify(path.join(outsideDir, "probe.js"));
    const redirect = hostile === "forof" ? `for (__filename of [${evil}]) { break; }\n` : `__filename &&= ${evil};\n`;
    const load = spawnVariant
      ? `const { spawnSync } = require("node:child_process");\nspawnSync(process.execPath, [path.join(D, ${JSON.stringify(leaf)})], {});\n`
      : `require(path.join(D, ${JSON.stringify(leaf)}));\n`;
    fs.writeFileSync(
      path.join(lib, "shadower.js"),
      `"use strict";\n${hostile ? redirect : ""}const D = path.dirname(__filename);\n${load}`,
    );
    fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), spawnBlock.concat('\nrequire(path.join(__dirname, "lib", "shadower.js"));\n'));
    return { root, leaf };
  };
  const run = (hostile) => {
    const rq = mk(hostile, false);
    const r1 = emit(rq.root);
    const d1 = readOut(r1.outPath);
    const reqOk = r1.rc === 1 && r1.err.includes("not statically resolvable") &&
      (!d1 || !d1.hooks.some((h) => (h.deps || []).some((x) => x.path.endsWith(`lib/${rq.leaf}`))));
    const sp = mk(hostile, true);
    const r2 = emit(sp.root);
    const d2 = readOut(r2.outPath);
    const spOk = r2.rc === 1 && r2.err.includes("not statically resolvable") &&
      (!d2 || !d2.hooks.some((h) => (h.deps || []).some((x) => x.path.endsWith(`lib/${sp.leaf}`))));
    const ct = mk(false, false);
    const r3 = emit(ct.root);
    const d3 = readOut(r3.outPath);
    const ctlOk = r3.rc === 0 && d3 && d3.hooks[0].deps.some((x) => x.path.endsWith(`lib/${ct.leaf}`));
    return { ok: reqOk && spOk && ctlOk, detail: `require=${reqOk}(${r1.rc}) spawn=${spOk}(${r2.rc}) control=${ctlOk}(${r3.rc})` };
  };
  const a = run("forof");
  record("108-for-of-__filename-is-a-WRITE (require + spawn + control)", a.ok, a.ok ? "`for (__filename of […])` refused on both load forms with the decoy unpinned; unredirected control pins" : a.detail);
  const b = run("andassign");
  record("109-__filename-&&=-is-a-WRITE (require + spawn + control)", b.ok, b.ok ? "`__filename &&= …` refused on both load forms with the decoy unpinned; unredirected control pins" : b.detail);
}


// 110/111/112 — THE LAST THREE FOR-HEAD SPELLINGS. Round 4 measured each of these
// with a decoy and an oracle: S1 `for ([__filename] of [[<outside>]]) {}` (a
// destructuring TARGET, so the bracket sits where the `=` would be), S2
// `for (const [a, __filename] of [[1,<outside>]]) { …anchor… }` (a loop-scoped
// SHADOW, with the anchor inside the body), S4 `for await (__filename of […]) {}`
// (the `await` sits between `for` and `(`, which defeated the earlier check's
// "the token before the paren must be `for`"). One rule now covers all three:
// ANY occurrence in a for-head TARGET — identifier or pattern member — is a
// write, and the matcher skips `await`. Each case carries both load forms and
// the control that keeps a genuine read pinning.
{
  const spawnBlock = VALID_BLOCK.replace('"spawns": []', '"spawns": ["node"]');
  const build = (spelling, hostile, spawnVariant) => {
    const root = makeRoot({ hook: spawnBlock });
    const lib = path.join(root, ".claude", "hooks", "lib");
    const leaf = spawnVariant ? "runner.js" : "impl.js";
    fs.writeFileSync(path.join(lib, leaf), "module.exports = {};\n");
    const outsideDir = path.join(path.dirname(root), `outside-${spelling}-${path.basename(root)}${spawnVariant ? "-s" : ""}`);
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, leaf), "module.exports = { outside: true };\n");
    const evil = JSON.stringify(path.join(outsideDir, "probe.js"));
    const load = spawnVariant
      ? `const { spawnSync } = require("node:child_process");\nspawnSync(process.execPath, [path.join(D, ${JSON.stringify(leaf)})], {});\n`
      : `require(path.join(D, ${JSON.stringify(leaf)}));\n`;
    // S2's redirect is loop-scoped, so the anchor has to sit INSIDE its body.
    // S2's control is the SAME shape with the loop gone: the redirect IS the
    // loop there, so a control that kept it would assert nothing. Reading the
    // first run's failure — the control refused, because `hostile` was ignored
    // on this branch — is what produced this line.
    const body = spelling === "s2" && hostile
      ? `for (const [a, __filename] of [[1, ${evil}]]) {\nconst D = path.dirname(__filename);\n${load}}\n`
      : `${hostile ? (
          spelling === "s1" ? `for ([__filename] of [[${evil}]]) { break; }\n`
          : `async function __f() { for await (__filename of [${evil}]) { break; } }\n`
        ) : ""}const D = path.dirname(__filename);\n${load}`;
    fs.writeFileSync(path.join(lib, "shadower.js"), `"use strict";\n${body}`);
    fs.writeFileSync(path.join(root, ".claude", "hooks", "fixture-hook.js"), spawnBlock.concat('\nrequire(path.join(__dirname, "lib", "shadower.js"));\n'));
    return { root, leaf };
  };
  const run = (spelling, label) => {
    const rq = build(spelling, true, false);
    const r1 = emit(rq.root);
    const d1 = readOut(r1.outPath);
    const reqOk = r1.rc === 1 && r1.err.includes("not statically resolvable") &&
      (!d1 || !d1.hooks.some((h) => (h.deps || []).some((x) => x.path.endsWith(`lib/${rq.leaf}`))));
    const sp = build(spelling, true, true);
    const r2 = emit(sp.root);
    const d2 = readOut(r2.outPath);
    const spOk = r2.rc === 1 && r2.err.includes("not statically resolvable") &&
      (!d2 || !d2.hooks.some((h) => (h.deps || []).some((x) => x.path.endsWith(`lib/${sp.leaf}`))));
    const ct = build(spelling, false, false);
    const r3 = emit(ct.root);
    const d3 = readOut(r3.outPath);
    const ctlOk = r3.rc === 0 && d3 && d3.hooks[0].deps.some((x) => x.path.endsWith(`lib/${ct.leaf}`));
    return { ok: reqOk && spOk && ctlOk, detail: `require=${reqOk}(${r1.rc}) spawn=${spOk}(${r2.rc}) control=${ctlOk}(${r3.rc})` };
  };
  const a = run("s1", "s1");
  record("110-for-head-DESTRUCTURING-target-is-a-write (require + spawn + control)", a.ok, a.ok ? "`for ([__filename] of …)` refused on both load forms with the decoy unpinned; unredirected control pins" : a.detail);
  const b = run("s2", "s2");
  record("111-a-loop-scoped-for-head-SHADOW-is-a-write (require + spawn + control)", b.ok, b.ok ? "`for (const [a, __filename] of …)` refused with the anchor inside the body; control pins" : b.detail);
  const c = run("s4", "s4");
  record("112-for-AWAIT-head-target-is-a-write (require + spawn + control)", c.ok, c.ok ? "`for await (__filename of …)` refused on both load forms; control pins" : c.detail);
}

// 113 — THE OVER-REFUSAL, as an ACCEPT pole. `const y = __filename;` is a plain
// RHS READ of the name, and the operator test was looking for an assignment
// operator on EITHER side — so a legit file that merely read the value was
// refused as unproven (MEASURED, round 4). Only a trailing operator and prefix
// `++`/`--` are writes now; an operator BEFORE the name means the name is being
// read. The pole asserts the file is ACCEPTED and its real sibling still pins.
{
  const root = makeRoot({ hook: VALID_BLOCK });
  const lib = path.join(root, ".claude", "hooks", "lib");
  fs.writeFileSync(path.join(lib, "impl.js"), "module.exports = {};\n");
  fs.writeFileSync(
    path.join(root, ".claude", "hooks", "fixture-hook.js"),
    VALID_BLOCK.concat('\nconst y = __filename;\nvoid y;\nconst D = path.dirname(__filename);\nrequire(path.join(D, "lib", "impl.js"));\n'),
  );
  const r = emit(root);
  const doc = readOut(r.outPath);
  const pinned = doc && doc.hooks[0].deps.some((x) => x.path.endsWith("lib/impl.js"));
  const ok = r.rc === 0 && Boolean(pinned);
  record("113-a-plain-RHS-read-of-__filename-is-accepted (accept pole)", ok, ok ? "`const y = __filename` accepted; the anchor still pins its real sibling" : `rc=${r.rc} pinned=${pinned} err=${r.err.trim().split("\n").pop().slice(0, 140)}`);
}

// 85 — THE IDENTITY GATE. `.claude/hook-registry.json` is a DELIVERED surface
// (sync ALWAYS_INCLUDE), so the emitter scans what it wrote for private org
// identity and REFUSES on a hit, removing the file rather than leaving a tainted
// manifest for the next sync to carry. The slug is READ FROM THE CONFIG at run
// time, never written into this file.
{
  const { privateOrgSlugs } = require_(path.join(REPO, ".claude", "bin", "lib", "strip-build-internal.mjs"));
  const slugs = privateOrgSlugs();
  if (slugs.length === 0) {
    record("85-identity-gate-over-the-emitted-manifest", false, "no private org slug configured at this tree — the ARMED path cannot be exercised here (this is a refusal to fake a green, not a skip)");
  } else {
    const slug = slugs[0];
    // PLANT IT WHERE THE MANIFEST ACTUALLY CARRIES IT. The first version put the
    // slug in the block's `notes`, which is AUTHOR-FACING and never emitted — so
    // nothing reached the manifest and the gate correctly found nothing, which
    // made the case fail for a reason that had nothing to do with the gate.
    // `fs_writes` IS emitted, and a slug is a legal path segment here.
    const planted = VALID_BLOCK.replace(
      '".claude/learning/fixture.jsonl"',
      `"<os.tmpdir()>/${slug}-marker"`,
    );
    const badRoot = makeRoot({ hook: planted });
    const badOut = path.join(badRoot, "out.manifest.json");
    const refused = emit(badRoot);
    const removed = !fs.existsSync(badOut);
    const clean = emit(makeRoot({ hook: VALID_BLOCK }));
    const ok = refused.rc === 1 && /identity gate REFUSED/.test(refused.err) && removed && clean.rc === 0;
    record("85-identity-gate-over-the-emitted-manifest", ok, ok ? "planted private slug refused, tainted manifest REMOVED; clean emit unaffected" : `rc=${refused.rc} removed=${removed} cleanRc=${clean.rc} err=${refused.err.trim().split("\n").pop().slice(0, 110)}`);
  }
}

// 114 — a root-anchored join with an UNRESOLVABLE SEGMENT is a dynamic site
// WITH A REASON, never a crash: `readRootJoin`'s `{why}` object previously
// crossed the join boundary as `parts: undefined`, and the consumer's
// `site.parts.join("/")` THREW — the measured cost being the selector's whole
// real-corpus run dying (all eight child runs exit 1, no selected suite
// executed). The CONTROL beside it is the same shape with a resolvable
// segment, which must still pin — so the fix cannot be satisfied by refusing
// every root-anchored join.
{
  const spawnBase = VALID_BLOCK.replace('"spawns": []', '"spawns": ["node"]');
  const whyCode =
    spawnBase +
    '\nconst path = require("node:path");\nconst { spawnSync } = require("node:child_process");\n' +
    'const ROOT = process.env.FIXTURE_ROOT || "/fixture";\n' +
    'spawnSync(process.execPath, [path.join(ROOT, "bin", UNRESOLVED_NAME, "x.js")], {});\n';
  const okCode =
    spawnBase +
    '\nconst path = require("node:path");\nconst { spawnSync } = require("node:child_process");\n' +
    'const ROOT = process.env.FIXTURE_ROOT || "/fixture";\n' +
    'spawnSync(process.execPath, [path.join(ROOT, "bin", "inside.js")], {});\n';
  const whyRun = emit(makeRoot({ hook: whyCode }));
  const okRoot = makeRoot({ hook: okCode });
  // The control's join must RESOLVE to a real file — an unresolvable target is
  // dynamic-not-found and refuses for a different reason than the crash.
  fs.mkdirSync(path.join(okRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(okRoot, "bin", "inside.js"), '"use strict";\nmodule.exports = {};\n');
  const okRun = emit(okRoot);
  const crashed = /Cannot read properties of undefined/.test(whyRun.err);
  // The why-site is REPORTED BY SITE (file:line), never as a TypeError — the
  // measured pre-fix behaviour was the selector's whole run dying on the throw.
  // The pin matches the site SHAPE plus the why-REASON substring, not a
  // hardcoded `:19`: a line literal rots on any insertion above the fixture
  // source (zero-tolerance.md Rule 3e's failure mode) and would red a fix that
  // moved the site without changing the behaviour under test.
  const whySite = /fixture-hook\.js:\d+/.test(whyRun.err);
  const whyReason = /segment the walker cannot resolve/.test(whyRun.err);
  const whyReported = whyRun.rc === 1 && !crashed && whySite && whyReason;
  const controlOk = okRun.rc === 0;
  const ok = whyReported && controlOk;
  record(
    "114-root-join-with-unresolvable-segment-is-dynamic-not-a-crash (RED pole + pin control)",
    ok,
    ok
      ? "why-only join reported by site (file:line) with its reason, no parts.join crash; resolvable control still pins"
      : `whyRc=${whyRun.rc} crashed=${crashed} site=${whySite} reason=${whyReason} okRc=${okRun.rc} whyErr=${whyRun.err.trim().split("\n").pop().slice(0, 140)}`,
  );
}

// 115 — THE CLOSURE ENTRY IS A READ LIKE ANY OTHER. Every DEPENDENCY the walk
// pulls in is canonically resolved and containment-checked (case 68's reject
// pole), but the ENTRY itself was read straight off the lexical queue: an entry
// spelled as a symlink pointing outside the tree was read, lexed and walked
// with no containment check at all. The RED pole is exactly that symlink; the
// ACCEPT pole is an IN-TREE symlink entry, which must resolve to its canonical
// target AND still walk the target's closure — so the fix cannot be satisfied
// by refusing symlinks wholesale. Introduced with the fix that hoists the entry
// through the same resolver pair (rules/security.md § Path Containment).
{
  const contract = require_(CONTRACT);
  const root = makeRoot({ hook: VALID_BLOCK });
  const entryRel = ".claude/hooks/fixture-hook.js";
  const outside = path.join(path.dirname(root), `outside-entry-${path.basename(root)}.js`);
  fs.writeFileSync(outside, "module.exports = { outside: true };\n");
  fs.rmSync(path.join(root, ".claude", "hooks", "fixture-hook.js"));
  fs.symlinkSync(outside, path.join(root, ".claude", "hooks", "fixture-hook.js"));
  const rEscape = contract.localRequireClosure(root, entryRel);
  const refused =
    rEscape.ok === false &&
    String(rEscape.error).includes("closure entry") &&
    String(rEscape.error).includes("resolves OUTSIDE the repo root");
  // ACCEPT pole: the entry symlink points IN-TREE; the walk follows it to the
  // canonical target and pins that target's dependency.
  const realEntry = path.join(root, ".claude", "hooks", "real-entry.js");
  fs.writeFileSync(realEntry, 'module.exports = {};\nrequire("./lib/inner115.js");\n');
  fs.writeFileSync(path.join(root, ".claude", "hooks", "lib", "inner115.js"), "module.exports = {};\n");
  fs.rmSync(path.join(root, ".claude", "hooks", "fixture-hook.js"));
  fs.symlinkSync(realEntry, path.join(root, ".claude", "hooks", "fixture-hook.js"));
  const rWalk = contract.localRequireClosure(root, entryRel);
  const walked =
    rWalk.ok === true &&
    Array.isArray(rWalk.files) &&
    rWalk.files.some((f) => f.path.endsWith("lib/inner115.js"));
  const ok = refused && walked;
  record(
    "115-closure-entry-symlink-outside-root-is-refused (RED pole + in-tree control)",
    ok,
    ok
      ? "outside-root entry symlink refused by name; in-tree symlink entry resolves to its canonical target and pins its dependency"
      : `escapeOk=${rEscape.ok} escapeErr=${String(rEscape.error).slice(0, 120)} walkOk=${rWalk.ok} walkErr=${String(rWalk.error || "").slice(0, 80)}`,
  );
}

// ── summary ─────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} cases pass\n`);
if (failed.length) {
  process.stdout.write(`FAILED: ${failed.map((f) => f.name).join(", ")}\n`);
  process.stdout.write(`scratch: ${SCRATCH}\n`);
  process.exit(1);
}
process.exit(0);
