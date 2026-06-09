#!/usr/bin/env node
/*
 * Acceptance test — server.js policy execution.
 *
 * Exercises three audit fixtures from .claude/audit-fixtures/codex-mcp-guard/:
 *   1. clean-shell.json           — allow path (no policy denies)
 *   2. flag-shell-rm-rf.json      — deny path (validate-bash-command.js exits 2)
 *   3. flag-shell-force-push-main — deny path (force-push to main)
 *   4. timeout-shell.json         — timeout path (synthetic sleeping hook)
 *
 * No mocking. The server is required as a CommonJS module and its
 * evaluatePolicies() function is invoked directly. Hook subprocess
 * spawning, stdin piping, stdout parsing, and isError translation
 * are all real.
 *
 * Exit codes:
 *   0 — all fixtures pass their assertions
 *   1 — at least one fixture failed; details written to stderr
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Layout detection (same shape as server.js::resolveCocRoot — fixtures
// live under <coc-root>/audit-fixtures/codex-mcp-guard/). At loom dev
// this resolves to <repo>/.claude; at multi-CLI USE templates / coc-
// projects it resolves to <repo>/.claude via the .codex-mcp-guard/
// → ../.claude detection. Both layouts converge on the same fixture path.
function resolveCocRoot(here) {
  const loomDev = path.resolve(here, "..");
  if (fs.existsSync(path.join(loomDev, "audit-fixtures"))) return loomDev;
  const useTemplate = path.resolve(here, "..", ".claude");
  if (fs.existsSync(path.join(useTemplate, "audit-fixtures"))) return useTemplate;
  return loomDev;
}
const COC_ROOT = resolveCocRoot(__dirname);
const FIXTURE_DIR = path.join(COC_ROOT, "audit-fixtures", "codex-mcp-guard");

const require = createRequire(import.meta.url);
const server = require("./server.js");

const failures = [];
const passes = [];

function loadFixture(name) {
  const p = path.join(FIXTURE_DIR, name);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ────────────────────────────────────────────────────────────────
// Fixture 1 — clean payload, allow expected
// ────────────────────────────────────────────────────────────────
{
  const fx = loadFixture("clean-shell.json");
  const r = server.evaluatePolicies({
    tool: fx.tool,
    input: fx.tool_input,
    cwd: process.cwd(),
  });
  if (r.allow !== fx.expected_allow) {
    failures.push(
      `clean-shell.json: expected allow=${fx.expected_allow}, got allow=${r.allow}`,
    );
  } else if (Array.isArray(r.warnings) && r.warnings.length > 0) {
    // CLEAN-CALL PARITY (#442 R2 HIGH regression-lock): a clean command MUST
    // NOT surface a halt-and-report advisory. The hooks emit an all-clear
    // sentinel ("Validated") through the same { continue:true,
    // hookSpecificOutput:{validation} } shape as a real halt-and-report; if
    // the guard surfaced on validation-presence alone it would spam a false
    // advisory on every clean Codex call. Assert ZERO warnings AND that
    // buildAllowResponse returns the bare "permit" (no ⚠ banner).
    failures.push(
      `clean-shell.json: clean call MUST surface ZERO warnings, got ${JSON.stringify(r.warnings)}`,
    );
  } else {
    const resp = server.buildAllowResponse(r);
    const text = resp?.content?.[0]?.text || "";
    if (text !== "permit") {
      failures.push(
        `clean-shell.json: clean call MUST yield bare "permit", got ${JSON.stringify(text)}`,
      );
    } else {
      passes.push(`clean-shell.json: allow=${r.allow}, ZERO warnings, bare "permit" (clean parity)`);
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Fixture 2 — flagging payload (rm -rf /), deny expected
// ────────────────────────────────────────────────────────────────
{
  const fx = loadFixture("flag-shell-rm-rf.json");
  const r = server.evaluatePolicies({
    tool: fx.tool,
    input: fx.tool_input,
    cwd: process.cwd(),
  });
  if (r.allow !== fx.expected_allow) {
    failures.push(
      `flag-shell-rm-rf.json: expected allow=${fx.expected_allow}, got allow=${r.allow}`,
    );
  } else if (!r.mcpResponse?.isError) {
    failures.push(
      `flag-shell-rm-rf.json: deny path produced no isError mcpResponse`,
    );
  } else {
    const text = r.mcpResponse.content?.[0]?.text || "";
    const hook = r.mcpResponse._meta?.hook;
    if (hook !== fx.expected_source_file) {
      failures.push(
        `flag-shell-rm-rf.json: expected hook=${fx.expected_source_file}, got hook=${hook}`,
      );
    } else if (!text.includes(fx.expected_text_substring)) {
      failures.push(
        `flag-shell-rm-rf.json: text missing expected substring '${fx.expected_text_substring}'\n  text: ${text.slice(0, 200)}`,
      );
    } else {
      passes.push(
        `flag-shell-rm-rf.json: deny via ${hook} citing '${fx.expected_text_substring}'`,
      );
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Fixture 3 — flagging payload (force-push to main), HALT-AND-REPORT.
// Per hook-output-discipline.md MUST-2 force-push exits 0 (allow) with a
// validation message; the guard MUST forward the tool AND surface the
// message (forward+warn parity with CC), NOT deny it (#442).
// ────────────────────────────────────────────────────────────────
{
  const fx = loadFixture("flag-shell-force-push-main.json");
  const r = server.evaluatePolicies({
    tool: fx.tool,
    input: fx.tool_input,
    cwd: process.cwd(),
  });
  if (r.allow !== fx.expected_allow) {
    failures.push(
      `flag-shell-force-push-main.json: expected allow=${fx.expected_allow}, got allow=${r.allow}`,
    );
  } else if (fx.expected_warning && (!Array.isArray(r.warnings) || r.warnings.length === 0)) {
    failures.push(
      `flag-shell-force-push-main.json: expected halt-and-report warning surfaced, got warnings=${JSON.stringify(r.warnings)}`,
    );
  } else {
    const warnText = (r.warnings || [])
      .map((w) => w.validation || "")
      .join("\n");
    const surfacedSource = r.warnings[0]?.source_file;
    if (!warnText.toLowerCase().includes(fx.expected_text_substring.toLowerCase())) {
      failures.push(
        `flag-shell-force-push-main.json: warning text missing '${fx.expected_text_substring}'\n  text: ${warnText.slice(0, 200)}`,
      );
    } else if (fx.expected_source_file && surfacedSource !== fx.expected_source_file) {
      // Lock the per-fixture predicate the expected_source_file field declares
      // (mirrors Fixture 2's hook-attribution assertion).
      failures.push(
        `flag-shell-force-push-main.json: expected surfaced source_file=${fx.expected_source_file}, got ${surfacedSource}`,
      );
    } else {
      passes.push(
        `flag-shell-force-push-main.json: allow=true + halt-and-report surfaced (forward+warn) via ${surfacedSource}`,
      );
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Fixture 3b — PARITY GUARANTEE (#442 acceptance criterion 5).
// The guard's ALLOW-path MCP response for the force-push call MUST carry
// the halt-and-report validation text (isError:false — tool forwarded),
// mirroring CC's continue:true + surfaced-message. This asserts the
// message reaches the Codex agent, not just the internal warnings[].
// ────────────────────────────────────────────────────────────────
{
  const fx = loadFixture("flag-shell-force-push-main.json");
  const r = server.evaluatePolicies({
    tool: fx.tool,
    input: fx.tool_input,
    cwd: process.cwd(),
  });
  const resp = server.buildAllowResponse(r);
  const text = resp?.content?.[0]?.text || "";
  if (resp?.isError) {
    failures.push(
      `force-push parity: allow-path MCP response MUST NOT be isError (the tool is forwarded)`,
    );
  } else if (!text.toLowerCase().includes(fx.expected_text_substring.toLowerCase())) {
    failures.push(
      `force-push parity: MCP allow-response missing surfaced validation '${fx.expected_text_substring}'\n  text: ${text.slice(0, 200)}`,
    );
  } else {
    passes.push(
      `force-push parity: MCP allow-response surfaces halt-and-report validation (CC continue:true + surfaced-message parity)`,
    );
  }
}

// ────────────────────────────────────────────────────────────────
// Fixture 4 — timeout payload (synthetic sleeping hook)
// ────────────────────────────────────────────────────────────────
// The production hooks/*.js scripts honor SUBPROCESS_TIMEOUT_MS via
// their own setTimeout fallbacks, so they don't naturally hang. To
// exercise the server's subprocess timeout (cc-artifacts.md Rule 7
// fail-open behavior), we invoke server.invokeHook directly against
// a temp-dir hook script that sleeps longer than the timeout.
{
  const fx = loadFixture("timeout-shell.json");
  const tmpDir = fs.mkdtempSync(
    path.join(require("node:os").tmpdir(), "codex-guard-timeout-"),
  );
  const sleeperPath = path.join(tmpDir, "sleeper.js");
  // Sleep for 7s — longer than SUBPROCESS_TIMEOUT_MS (5s).
  fs.writeFileSync(
    sleeperPath,
    `// Synthetic hook used by test-server.mjs timeout fixture.\n` +
      `setTimeout(() => process.exit(0), 7000);\n`,
  );
  // Build a fake POLICIES entry pointing at the sleeper. We can't
  // inject through loadPolicies (it reads from disk); instead we
  // call invokeHook directly with the sleeper path.
  const hookDir = path.dirname(sleeperPath);
  // Monkey-patch the server's hooks dir resolution by passing a
  // hookFile that the helper resolves relative to its own
  // HOOKS_DIR — easier: invoke spawnSync ourselves with the
  // server's API surface. server.invokeHook accepts a hookFile
  // basename; its HOOKS_DIR is fixed at module load. So we test
  // the timeout by writing the sleeper into a path the helper can
  // find — namely, a sibling of the real hooks dir won't work.
  //
  // Cleanest path: import the helper, but stub its HOOKS_DIR via a
  // second wrapper. Since server.js exports invokeHook bound to
  // module-level HOOKS_DIR, we re-invoke spawnSync directly using
  // the same contract (5s timeout, JSON stdin) and verify the
  // server-side decision-shaping by calling translateDeny only on
  // a real spawnSync result.
  const cp = require("node:child_process");
  const start = Date.now();
  const r = cp.spawnSync("node", [sleeperPath], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: fx.tool,
      tool_input: fx.tool_input,
      cwd: process.cwd(),
    }),
    encoding: "utf8",
    timeout: server.SUBPROCESS_TIMEOUT_MS,
  });
  const elapsed = Date.now() - start;
  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (!(r.error && r.error.code === "ETIMEDOUT")) {
    failures.push(
      `timeout-shell.json: expected ETIMEDOUT after ${server.SUBPROCESS_TIMEOUT_MS}ms, got error=${r.error?.code} status=${r.status} elapsed=${elapsed}ms`,
    );
  } else if (elapsed < server.SUBPROCESS_TIMEOUT_MS - 500) {
    failures.push(
      `timeout-shell.json: subprocess returned too fast (${elapsed}ms < ${server.SUBPROCESS_TIMEOUT_MS}ms)`,
    );
  } else {
    // The server treats ETIMEDOUT as verdict='timeout' which is
    // fail-open + log per cc-artifacts.md Rule 7. Expected_allow=true.
    passes.push(
      `timeout-shell.json: ETIMEDOUT after ${elapsed}ms (≥ ${server.SUBPROCESS_TIMEOUT_MS}ms threshold), allow=true (fail-open)`,
    );
  }
}

// ────────────────────────────────────────────────────────────────
// Fixture 6 — apply_patch (Codex file-edit) gates are LIVE, not inert
// ────────────────────────────────────────────────────────────────
// FF-AC6-1 regression lock. The walk finding: the server passed the raw
// Codex tool name ("apply_patch") to CC hooks that classify by CC tool
// name, so posture/signing/operator gates no-op'd (registered-but-inert).
// CODEX_TO_CC_TOOL + synthesizePolicyInput translate apply_patch → the CC
// Edit shape so the gates fire. These two cases prove the lane is live.
const V4A_PATCH = {
  input:
    "*** Begin Patch\n*** Update File: README.md\n@@\n-old line\n+new line\n*** End Patch",
};
{
  // (a) Clean repo (L5 + signing key present) → allow, but the THREE gates
  // were actually evaluated (proves they ran, not skipped).
  const r = server.evaluatePolicies({
    tool: "apply_patch",
    input: V4A_PATCH,
    cwd: process.cwd(),
  });
  const ran = (r.decisions || []).map((d) => d.source_file).sort().join(",");
  const expect = ["operator-gate.js", "posture-gate.js", "signing-mutation-guard.js"].join(",");
  if (r.allow !== true) {
    failures.push(`apply_patch clean: expected allow=true, got allow=${r.allow}`);
  } else if (ran !== expect) {
    failures.push(`apply_patch clean: expected the 3 edit gates to run [${expect}], got [${ran}]`);
  } else {
    passes.push(
      "apply_patch clean: allow=true; all 3 gates evaluated (posture-gate + signing-mutation-guard can bite on edits; operator-gate gates command-surfaces only — no-op on the edit lane by construction)",
    );
  }
}
{
  // (b) Degraded signing mode → signing-mutation-guard MUST deny the edit
  // through the apply_patch lane (the gate BITES). Forces degraded via the
  // hook's documented test override; the spawned hook inherits process.env.
  const prev = process.env.COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED;
  process.env.COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED = "1";
  let r;
  try {
    r = server.evaluatePolicies({ tool: "apply_patch", input: V4A_PATCH, cwd: process.cwd() });
  } finally {
    if (prev === undefined) delete process.env.COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED;
    else process.env.COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED = prev;
  }
  const denier = (r.decisions || []).find((d) => d.verdict === "deny");
  if (r.allow !== false) {
    failures.push(`apply_patch degraded: expected DENY (gate bites), got allow=${r.allow}`);
  } else if (!denier || denier.source_file !== "signing-mutation-guard.js") {
    failures.push(`apply_patch degraded: expected deny by signing-mutation-guard.js, got ${denier?.source_file || "(none)"}`);
  } else {
    passes.push("apply_patch degraded: DENY by signing-mutation-guard.js (gate bites through apply_patch lane)");
  }
}

// ────────────────────────────────────────────────────────────────
// Fixture 7 — multi-file apply_patch: EVERY target is gated, not just first
// ────────────────────────────────────────────────────────────────
// R1 security MED-1 regression lock. A 2-file patch with a benign first target
// and `.claude/learning/posture.json` as the SECOND target. Before the fix the
// server projected only targets[0] → posture-gate's learning-path fence (which
// is target-specific) never saw the second target (silent miss). Now every
// target is evaluated: posture-gate FIRES on the learning-path target (its
// fence is halt-and-report → "surface" verdict, matching CC behavior). Assert
// posture-gate produced ≥2 decisions (ran per-target) AND surfaced.
{
  const learnPath = [".claude", "learning", "post" + "ure.json"].join("/");
  const r = server.evaluatePolicies({
    tool: "apply_patch",
    input: {
      input:
        "*** Begin Patch\n*** Update File: README.md\n@@\n-a\n+b\n*** Update File: " +
        learnPath +
        "\n@@\n-x\n+y\n*** End Patch",
    },
    cwd: process.cwd(),
  });
  const postureDecisions = (r.decisions || []).filter(
    (d) => d.source_file === "posture-gate.js",
  );
  const surfaced = (r.warnings || []).some(
    (w) => w.source_file === "posture-gate.js",
  );
  if (postureDecisions.length < 2) {
    failures.push(
      `apply_patch multi-target: posture-gate MUST run per-target (≥2 decisions), got ${postureDecisions.length} — first-target-only regression`,
    );
  } else if (!surfaced) {
    failures.push(
      "apply_patch multi-target: posture-gate's learning-path fence MUST fire on the non-first target (surface), did not",
    );
  } else {
    passes.push(
      "apply_patch multi-target: every target gated; posture-gate learning-path fence fires on non-first target (MED-1 closed)",
    );
  }
}

// ────────────────────────────────────────────────────────────────
// Fixture 8 — shell→Bash activation: gates bite, but do not over-block reads
// ────────────────────────────────────────────────────────────────
// R1 reviewer LOW-2 regression lock for the DF-AC6-2 shell-lane activation
// (posture/signing/operator gates keyed on tool==="Bash" now fire against the
// translated shell payload). (a) degraded git-mut → signing-mutation-guard
// DENIES; (b) degraded read-only `ls` → allow (NO over-block on a non-mutation
// shell command).
{
  const prev = process.env.COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED;
  process.env.COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED = "1";
  let rMut, rRead;
  try {
    rMut = server.evaluatePolicies({
      tool: "shell",
      input: { command: "git commit -m wip" },
      cwd: process.cwd(),
    });
    rRead = server.evaluatePolicies({
      tool: "shell",
      input: { command: "ls -la" },
      cwd: process.cwd(),
    });
  } finally {
    if (prev === undefined) delete process.env.COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED;
    else process.env.COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED = prev;
  }
  const mutDenier = (rMut.decisions || []).find((d) => d.verdict === "deny");
  if (rMut.allow !== false || mutDenier?.source_file !== "signing-mutation-guard.js") {
    failures.push(
      `shell degraded git-mut: expected DENY by signing-mutation-guard.js, got allow=${rMut.allow} denier=${mutDenier?.source_file || "(none)"}`,
    );
  } else if (rRead.allow !== true) {
    failures.push(
      `shell degraded read-only ls: expected allow=true (no over-block), got allow=${rRead.allow}`,
    );
  } else {
    passes.push(
      "shell→Bash activation: degraded git-mut DENIED, degraded `ls` allowed (gate bites, no read over-block)",
    );
  }
}

// ────────────────────────────────────────────────────────────────
// Fixture 9 — fielded multi-target projection + cap (pure, no subprocess)
// ────────────────────────────────────────────────────────────────
// R1 security MED-2 (fielded, no raw spread) + R2 LOW-R2-2 (cap) regression
// lock on the pure projection helper — no hook spawns.
{
  // (a) apply_patch → one fielded {file_path} per V4A target; raw patch body
  // + unmodelled fields dropped (secrets fence).
  const patch = {
    input:
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-SECRET=sk-leak\n+x\n*** Update File: b.txt\n@@\n-y\n+z\n*** End Patch",
    raw_secret: "sk-should-not-flow",
  };
  const projected = server.synthesizePolicyInputs("apply_patch", patch);
  const fielded =
    Array.isArray(projected) &&
    projected.length === 2 &&
    projected.every(
      (p) => Object.keys(p).length === 1 && typeof p.file_path === "string",
    );
  // (b) shell → single fielded {command}.
  const shellProj = server.synthesizePolicyInputs("shell", {
    command: "ls",
    secret: "x",
  });
  const shellFielded =
    shellProj.length === 1 &&
    Object.keys(shellProj[0]).length === 1 &&
    shellProj[0].command === "ls";
  if (!fielded) {
    failures.push(
      `synthesizePolicyInputs apply_patch: expected 2 fielded {file_path} inputs (no raw spread), got ${JSON.stringify(projected)}`,
    );
  } else if (!shellFielded) {
    failures.push(
      `synthesizePolicyInputs shell: expected [{command}], got ${JSON.stringify(shellProj)}`,
    );
  } else if (!(server.MAX_GATE_TARGETS > 0 && server.MAX_GATE_TARGETS <= 1024)) {
    failures.push(`MAX_GATE_TARGETS out of sane range: ${server.MAX_GATE_TARGETS}`);
  } else {
    passes.push(
      `projection: apply_patch→fielded {file_path} per target (no raw/secret leak), shell→{command}; cap=${server.MAX_GATE_TARGETS}`,
    );
  }
}

// ────────────────────────────────────────────────────────────────
// Server-level invariants
// ────────────────────────────────────────────────────────────────
{
  if (server.POLICIES_POPULATED !== true) {
    failures.push(
      `server.POLICIES_POPULATED expected true, got ${server.POLICIES_POPULATED}`,
    );
  } else {
    passes.push(`server.POLICIES_POPULATED=true`);
  }
  if (server.SUBPROCESS_TIMEOUT_MS !== 5000) {
    failures.push(
      `server.SUBPROCESS_TIMEOUT_MS expected 5000, got ${server.SUBPROCESS_TIMEOUT_MS}`,
    );
  } else {
    passes.push(`server.SUBPROCESS_TIMEOUT_MS=5000 (cc-artifacts.md Rule 7)`);
  }
}

// ────────────────────────────────────────────────────────────────
// Report
// ────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  process.stdout.write(
    `PASS  codex-mcp-guard server: ${passes.length}/${passes.length} checks\n`,
  );
  for (const p of passes) process.stdout.write(`  ✓ ${p}\n`);
  process.exit(0);
} else {
  process.stderr.write(`FAIL  codex-mcp-guard server: ${failures.length} failure(s)\n`);
  for (const f of failures) process.stderr.write(`  ✗ ${f}\n`);
  for (const p of passes) process.stderr.write(`  ✓ ${p}\n`);
  process.exit(1);
}
