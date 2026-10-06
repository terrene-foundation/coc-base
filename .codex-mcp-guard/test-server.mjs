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
import { generateKeyPairSync } from "node:crypto";

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

// ────────────────────────────────────────────────────────────────
// Trust-posture ISOLATION — pin before server.js is required
// ────────────────────────────────────────────────────────────────
// The suite calls evaluatePolicies({… cwd: process.cwd()}), and posture-gate.js
// resolves `readPosture(data.cwd)` from that cwd — i.e. from the LIVE, gitignored
// `.claude/learning/posture.json` of whatever clone the suite happens to run in.
// That made the suite's verdict a function of AMBIENT OPERATOR STATE rather than
// of the code under test: measured on an L3_SHARED_PLANNING clone, posture-gate's
// mutation-verb fence hard-DENIES `git push` / `git commit`, so Fixtures 3, 3b and
// 8a failed — while the SAME code is green on an L4/L5 clone. A suite whose result
// flips with the operator's posture cannot be cited as evidence about server.js
// (`instrument-discipline.md` MUST-1: a check that cannot discriminate is not
// evidence), and it cannot be cited AT ALL below L4.
//
// The fix mirrors the signing-guard's existing test override
// (COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED, used at Fixtures 6b/8): pin the ONE
// ambient variable rather than read it. CLAUDE_TRUST_STATE_DIR is the documented
// in-use trust-state test seam (`hooks/lib/state-resolver.js::resolveStateDirDetailed`
// honours it as `env-override`; ~20 sibling suites under `.claude/test-harness/tests/`
// already drive it). It redirects ONLY the trust-state read — `cwd` stays the real
// repo, so validate-bash-command, signing-mutation-guard identity resolution,
// genesis-anchor-guard, operator-gate and worktree-forest-guard are untouched.
//
// The pin is L5_DELEGATED, which is what the fixtures were authored against —
// Fixture 6a's own comment reads "Clean repo (L5 + signing key present) → allow".
// The assumption was always there; it was simply never enforced.
//
// This writes ONLY to a fresh mkdtemp sandbox. It NEVER touches the live
// `.claude/learning/posture.json` (`multi-operator-coordination.md` § MUST NOT —
// the canonical helpers are that file's only legitimate writers).
//
// The L3 composed outcome is NOT lost by pinning: Fixture 3c below re-pins to
// L3_SHARED_PLANNING and asserts the deny, so both halves are locked.
const POSTURE_SANDBOX = fs.mkdtempSync(
  path.join(require("node:os").tmpdir(), "codex-guard-posture-"),
);
const POSTURE_STATE_DIR = path.join(POSTURE_SANDBOX, ".claude", "learning");
fs.mkdirSync(POSTURE_STATE_DIR, { recursive: true });

// Pin signing availability and sibling contention as well as posture. This
// transport suite does not test the operator's keyring or live worktree forest;
// enumerating active worktrees exhausted the 5-second policy subprocess budget.
// The degraded fixtures still force their own negative branch below.
const fixtureKey = path.join(POSTURE_SANDBOX, "operator-key.pem");
const { privateKey } = generateKeyPairSync("ed25519");
fs.writeFileSync(fixtureKey, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
process.env.COC_OPERATOR_KEY_PATH = fixtureKey;
process.env.COC_PORCELAIN_OVERRIDE = "";


/** Write `posture` into the sandbox state dir and point the hooks at it. */
function pinPosture(posture) {
  fs.writeFileSync(
    path.join(POSTURE_STATE_DIR, "posture.json"),
    JSON.stringify({
      posture,
      since: "2026-01-01T00:00:00.000Z",
      transition_history: [],
    }) + "\n",
  );
  process.env.CLAUDE_TRUST_STATE_DIR = POSTURE_STATE_DIR;
}

/** Run `fn` with posture pinned to `posture`, then restore the suite default. */
function withPosture(posture, fn) {
  pinPosture(posture);
  try {
    return fn();
  } finally {
    pinPosture("L5_DELEGATED");
  }
}

pinPosture("L5_DELEGATED");
process.on("exit", () => {
  fs.rmSync(POSTURE_SANDBOX, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Genesis-anchor ISOLATION — pin the SECOND ambient variable
// ────────────────────────────────────────────────────────────────
// The posture pin above fixed ONE ambient input and its comment asserted the
// rest were "untouched". That assertion was true of the POSTURE pin but was
// never established as a property of the SUITE, and a second ambient input was
// left unpinned: `genesis-anchor-guard.js` resolves its coordination-log and
// roster in `resolvePaths()` RELATIVE TO THE HOOK FILE —
// `<repo>/.claude/learning/coordination-log.jsonl` — and that path is a
// GITIGNORED PER-CLONE CACHE (`.gitignore`: `.claude/learning/**`).
//
// So the suite's verdict was a function of whether the CLONE IT RUNS IN had
// materialized its trust root:
//   - operator's long-lived main checkout (log present, anchor folded) → the
//     guard verifies and passes → 50/50;
//   - ANY fresh clone or worktree (log absent, roster tracked and naming a real
//     owner) → the guard correctly fail-CLOSES on "enrolled-but-unmaterialized"
//     (loom#879) and DENIES every mutation-class command → Fixtures 3, 3b and 8
//     red, because genesis-anchor-guard short-circuits evaluation before
//     validate-bash-command's forward+warn verdict can be read as an allow and
//     before signing-mutation-guard is ever reached.
// That is the SAME defect class the posture pin was written to close
// (`instrument-discipline.md` MUST-1: a check whose result flips with ambient
// operator state cannot be cited as evidence about server.js), applied to the
// one variable that pin missed.
//
// THE PIN. `genesis-anchor-guard.js` exposes a documented pair of test seams,
// COC_GENESIS_GUARD_ROSTER_PATH + COC_GENESIS_GUARD_LOG_PATH, honoured together
// (`resolvePaths()`: `if (logEnv && rosterEnv)`), and driven in exactly this
// shape by the guard's OWN suite (`test-harness/tests/genesis-anchor-guard.test.mjs`
// ::runGuardCommit). Point them at a SCAFFOLD roster (a `PLACEHOLDER-*`
// repo_owner, which `roster-schema-validate.js::isUnenrolled` recognises) plus
// an ABSENT log, which is the guard's documented fresh-substrate-adopter state:
// never-enrolled → advisory pass-through, deterministic on every clone.
//
// This REMOVES NO COVERAGE. This suite carries zero assertions about
// genesis-anchor-guard; the guard's fail-closed enrollment fence is owned and
// tested by `test-harness/tests/genesis-anchor-guard.test.mjs`. Nothing in the
// guard is modified — only which files THIS suite points it at, mirroring the
// posture pin above and the COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED override
// already used at Fixtures 6b/8.
//
// Written into the SAME mkdtemp sandbox the posture pin already cleans up. The
// log path is deliberately NEVER created — its ABSENCE is half the predicate.
const GENESIS_ROSTER_PATH = path.join(
  POSTURE_SANDBOX,
  ".claude",
  "operators.roster.json",
);
const GENESIS_LOG_PATH = path.join(POSTURE_STATE_DIR, "coordination-log.jsonl");
fs.writeFileSync(
  GENESIS_ROSTER_PATH,
  JSON.stringify({
    schema_version: "1.0.0",
    genesis: { repo_owner: "PLACEHOLDER-codex-mcp-guard-suite" },
    persons: [],
  }) + "\n",
);
process.env.COC_GENESIS_GUARD_ROSTER_PATH = GENESIS_ROSTER_PATH;
process.env.COC_GENESIS_GUARD_LOG_PATH = GENESIS_LOG_PATH;

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
// the halt-and-report validation text (isError:false — policy request permitted),
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
      `force-push parity: allow-path MCP response MUST NOT be isError (the policy request is permitted)`,
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
// Fixture 3c — the COMPOSED L3 outcome, pinned (not ambient)
// ────────────────────────────────────────────────────────────────
// Fixtures 3/3b assert validate-bash-command's forward+warn contract, and pin
// L5 so that contract is what they actually measure. That pin would otherwise
// DELETE coverage of the composition: at L3_SHARED_PLANNING, posture-gate's
// mutation-verb fence DENIES `git push`, and the guard MUST deny with it —
// which is exact parity with CC, where the same posture-gate hook denies the
// same command. So the two are not in tension and neither fixture is "wrong":
// forward+warn is validate-bash-command's verdict, deny is the COMPOSED verdict,
// and posture is what selects between them. This case locks the L3 half so a
// regression that silently forwarded a fenced mutation verb at L3 reds here.
{
  const fx = loadFixture("flag-shell-force-push-main.json");
  const r = withPosture("L3_SHARED_PLANNING", () =>
    server.evaluatePolicies({
      tool: fx.tool,
      input: fx.tool_input,
      cwd: process.cwd(),
    }),
  );
  const denier = (r.decisions || []).find((d) => d.verdict === "deny");
  const decisions = r.decisions || [];
  if (r.allow !== false) {
    failures.push(
      `L3 force-push composition: expected DENY at L3_SHARED_PLANNING, got allow=${r.allow}`,
    );
  } else if (denier?.source_file !== "posture-gate.js") {
    failures.push(
      `L3 force-push composition: expected the deny from posture-gate.js, got ${denier?.source_file || "(none)"}`,
    );
  } else if (decisions.length !== 1 || decisions[0].source_file !== "posture-gate.js") {
    failures.push(
      "L3 force-push composition: posture-first denial must stop before downstream policy handlers execute",
    );
  } else {
    passes.push(
      "L3 force-push composition: posture-gate DENIES first at L3 and downstream handlers do not execute; standalone advisory covered separately",
    );
  }
}

// ────────────────────────────────────────────────────────────────
// Fixture 4 — timeout payload (synthetic sleeping hook)
// ────────────────────────────────────────────────────────────────
// The production hooks/*.js scripts honor SUBPROCESS_TIMEOUT_MS via
// their own setTimeout fallbacks, so they don't naturally hang. To
// exercise the server's subprocess timeout (cc-artifacts.md Rule 7
// timing mechanism), we invoke a subprocess directly against
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
    // This fixture exercises the timeout MECHANISM (the subprocess actually
    // hits ETIMEDOUT at SUBPROCESS_TIMEOUT_MS) at the child_process layer; it
    // does NOT drive evaluatePolicies. The server's DISPOSITION for a `timeout`
    // verdict is now FAIL-CLOSED (deny) per #411 B1 — asserted via the
    // un-evaluable-hook path in Fixture 9 (same code branch as error/missing).
    passes.push(
      `timeout-shell.json: ETIMEDOUT after ${elapsed}ms (≥ ${server.SUBPROCESS_TIMEOUT_MS}ms threshold) — timeout mechanism fires (disposition tested in Fixture 9)`,
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
      `shell degraded git-mut: expected DENY by signing-mutation-guard.js, got allow=${rMut.allow} denier=${mutDenier?.source_file || "(none)"}; decisions=${JSON.stringify((rMut.decisions || []).map(d => ({ file: d.source_file, verdict: d.verdict })))}`,
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
// Fixture 9 — FAIL-CLOSED on an un-evaluable hook (#411 B1)
// ────────────────────────────────────────────────────────────────
// A hook the guard CANNOT evaluate — `missing` (source file absent for a gated
// tool), and by the SAME code branch `timeout` (hung) / `error` (crash/spawn
// failure) — MUST DENY (fail-closed), NOT silently forward. Inject a missing-hook
// policy at the HEAD of shell's chain so the first (policy,target) pair is
// un-evaluable; assert the call is denied with the fail_closed marker BEFORE the
// real policies run. Distinct from `warn` (a hook that RAN and returned a clean
// non-2 exit), which stays advisory-forward (Fixture 1's clean allow proves the
// non-deny verdicts still forward).
{
  const realShell = server.POLICIES.shell;
  server.POLICIES.shell = [
    { source_file: "__nonexistent_b1_hook__.js" },
    ...realShell,
  ];
  try {
    const r = server.evaluatePolicies({
      tool: "shell",
      input: { command: "echo hi" },
      cwd: process.cwd(),
    });
    const meta = r.mcpResponse?._meta || {};
    if (r.allow !== false) {
      failures.push(
        `fail-closed (#411 B1): an un-evaluable (missing) hook MUST DENY, got allow=${r.allow}`,
      );
    } else if (!r.mcpResponse?.isError || meta.fail_closed !== true) {
      failures.push(
        `fail-closed (#411 B1): expected isError + _meta.fail_closed=true, got ${JSON.stringify(meta)}`,
      );
    } else if (meta.verdict !== "missing") {
      failures.push(
        `fail-closed (#411 B1): expected _meta.verdict=missing, got ${meta.verdict}`,
      );
    } else if (!/fail-closed/i.test(r.mcpResponse.content?.[0]?.text || "")) {
      failures.push(
        `fail-closed (#411 B1): deny text MUST explain fail-closed, got '${(r.mcpResponse.content?.[0]?.text || "").slice(0, 120)}'`,
      );
    } else {
      passes.push(
        "fail-closed (#411 B1): un-evaluable hook DENIES with the fail_closed marker (compliance-bus posture; distinct from cc-artifacts Rule 7 session-hook fail-open)",
      );
    }
  } finally {
    server.POLICIES.shell = realShell;
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
// #820 — hookSpecificOutput.permissionDecisionReason surfaces as deny text
// ────────────────────────────────────────────────────────────────
// A modern CC PreToolUse deny emits
//   { continue:false, hookSpecificOutput:{ permissionDecision:"deny",
//     permissionDecisionReason:"…" } }.
// extractHookValidation MUST read permissionDecisionReason so translateDeny
// surfaces the actionable reason instead of the generic fallback.
{
  const denyPayload = JSON.stringify({
    continue: false,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "STOP — Tool call blocked. rm -rf / is destructive.",
    },
  });
  const { validation } = server.extractHookValidation(denyPayload);
  if (validation === "STOP — Tool call blocked. rm -rf / is destructive.") {
    passes.push(
      "#820: extractHookValidation surfaces hookSpecificOutput.permissionDecisionReason for a deny",
    );
  } else {
    failures.push(
      `#820: permissionDecisionReason not surfaced — expected the deny reason, got ${JSON.stringify(validation)}`,
    );
  }

  // Precedence: legacy `validation` still wins over permissionDecisionReason.
  const bothPayload = JSON.stringify({
    continue: false,
    hookSpecificOutput: {
      validation: "LEGACY-VALIDATION-WINS",
      permissionDecisionReason: "modern-reason",
    },
  });
  const { validation: pref } = server.extractHookValidation(bothPayload);
  if (pref === "LEGACY-VALIDATION-WINS") {
    passes.push("#820: legacy `validation` retains precedence over permissionDecisionReason");
  } else {
    failures.push(
      `#820: precedence wrong — expected LEGACY-VALIDATION-WINS, got ${JSON.stringify(pref)}`,
    );
  }

  // Regression: a clean-call sentinel riding additionalContext is STILL gated
  // out of the surface by isActionableValidation (no spurious advisory).
  const cleanPayload = JSON.stringify({
    continue: true,
    hookSpecificOutput: { additionalContext: "Validated" },
  });
  const { validation: clean } = server.extractHookValidation(cleanPayload);
  if (clean === "Validated" && server.isActionableValidation(clean) === false) {
    passes.push(
      "#820: clean sentinel 'Validated' extracted but NOT actionable (no clean-call advisory regression)",
    );
  } else {
    failures.push(
      `#820: clean-sentinel gate regressed — validation=${JSON.stringify(clean)} actionable=${server.isActionableValidation(clean)}`,
    );
  }
}

// ────────────────────────────────────────────────────────────────
// #820 — invokeHook stamps COC_RUNTIME=codex into the replayed-hook env
// ────────────────────────────────────────────────────────────────
// parseHook (lib/runtime.js) THROWS on unset COC_RUNTIME. Drive invokeHook
// against a synthetic probe hook (in an OS tmpdir, addressed via a relative
// path from the fixed HOOKS_DIR) that echoes its env; assert COC_RUNTIME=codex
// AND that CLAUDE_PROJECT_DIR is still present (no regression of the prior stamp).
{
  const os = require("node:os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-guard-env-"));
  const probePath = path.join(tmpDir, "env-probe.js");
  fs.writeFileSync(
    probePath,
    "// Synthetic hook for test-server.mjs #820 COC_RUNTIME env fixture.\n" +
      "const cocRuntime = process.env.COC_RUNTIME || 'UNSET';\n" +
      "const projDir = process.env.CLAUDE_PROJECT_DIR ? 'set' : 'unset';\n" +
      "process.stdout.write(JSON.stringify({ continue: true, hookSpecificOutput: {\n" +
      "  validation: 'COC_RUNTIME=' + cocRuntime + ' CLAUDE_PROJECT_DIR=' + projDir } }));\n",
  );
  try {
    const hookFile = path.relative(server.HOOKS_DIR, probePath);
    const r = server.invokeHook({
      hookFile,
      payload: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, cwd: process.cwd() },
    });
    if (r.stdout.includes("COC_RUNTIME=codex")) {
      passes.push("#820: invokeHook stamps COC_RUNTIME=codex into the replayed-hook env");
    } else {
      failures.push(
        `#820: COC_RUNTIME not stamped — probe stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
      );
    }
    if (r.stdout.includes("CLAUDE_PROJECT_DIR=set")) {
      passes.push("#820: invokeHook still stamps CLAUDE_PROJECT_DIR (no regression)");
    } else {
      failures.push(
        `#820: CLAUDE_PROJECT_DIR regression — probe stdout=${JSON.stringify(r.stdout)}`,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ────────────────────────────────────────────────────────────────
// #820 (R1 LOW-1) — a PURE modern-shape deny (permissionDecision:"deny" at
// exit 0, no `continue`) routes to verdict "deny", not fail-open allow
// ────────────────────────────────────────────────────────────────
{
  // Unit: extractHookValidation surfaces the modern permissionDecision.
  const modernDeny = JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: "deny",
      permissionDecisionReason: "modern-shape deny at exit 0",
    },
  });
  const parsed = server.extractHookValidation(modernDeny);
  if (parsed.permissionDecision === "deny") {
    passes.push("#820 LOW-1: extractHookValidation returns permissionDecision='deny'");
  } else {
    failures.push(
      `#820 LOW-1: permissionDecision not captured — got ${JSON.stringify(parsed.permissionDecision)}`,
    );
  }

  // Behavioral: a probe hook emitting the pure modern deny shape at exit 0
  // (NO continue field, NO exit 2) MUST resolve to verdict "deny".
  const os = require("node:os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-guard-modern-deny-"));
  const probePath = path.join(tmpDir, "modern-deny.js");
  fs.writeFileSync(
    probePath,
    "// Synthetic hook: pure modern-shape deny at exit 0 (#820 LOW-1 fixture).\n" +
      "process.stdout.write(JSON.stringify({ hookSpecificOutput: {\n" +
      "  permissionDecision: 'deny', permissionDecisionReason: 'modern deny' } }));\n" +
      "process.exit(0);\n",
  );
  try {
    const hookFile = path.relative(server.HOOKS_DIR, probePath);
    const r = server.invokeHook({
      hookFile,
      payload: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, cwd: process.cwd() },
    });
    if (r.verdict === "deny") {
      passes.push("#820 LOW-1: pure modern-shape deny at exit 0 routes to verdict 'deny' (no fail-open)");
    } else {
      failures.push(
        `#820 LOW-1: modern deny fell open — expected verdict 'deny', got '${r.verdict}' (exitCode=${r.exitCode})`,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ────────────────────────────────────────────────────────────────
// CGUARDask — a modern-shape "ask" (permissionDecision:"ask" at exit 0)
// routes to verdict "surface" (forward + surface reason), not fail-open allow
// ────────────────────────────────────────────────────────────────
{
  // Unit: extractHookValidation captures the modern permissionDecision "ask".
  const modernAsk = JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: "ask",
      permissionDecisionReason: "confirm before writing to the shared config",
    },
  });
  const parsed = server.extractHookValidation(modernAsk);
  if (parsed.permissionDecision === "ask") {
    passes.push("CGUARDask: extractHookValidation returns permissionDecision='ask'");
  } else {
    failures.push(
      `CGUARDask: permissionDecision not captured — got ${JSON.stringify(parsed.permissionDecision)}`,
    );
  }

  // Behavioral: a probe hook emitting the pure modern "ask" shape at exit 0
  // (NO continue field, NO exit 2) MUST resolve to verdict "surface" AND carry
  // the reason — the Codex operator must SEE the advisory (not silent allow).
  const os = require("node:os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-guard-modern-ask-"));
  const probePath = path.join(tmpDir, "modern-ask.js");
  fs.writeFileSync(
    probePath,
    "// Synthetic hook: pure modern-shape ask at exit 0 (CGUARDask fixture).\n" +
      "process.stdout.write(JSON.stringify({ hookSpecificOutput: {\n" +
      "  permissionDecision: 'ask', permissionDecisionReason: 'confirm first' } }));\n" +
      "process.exit(0);\n",
  );
  try {
    const hookFile = path.relative(server.HOOKS_DIR, probePath);
    const r = server.invokeHook({
      hookFile,
      payload: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, cwd: process.cwd() },
    });
    if (r.verdict === "surface") {
      passes.push("CGUARDask: pure modern-shape ask at exit 0 routes to verdict 'surface' (no silent allow)");
    } else {
      failures.push(
        `CGUARDask: modern ask mis-routed — expected verdict 'surface', got '${r.verdict}' (exitCode=${r.exitCode})`,
      );
    }
    if (r.verdict === "surface" && r.validation === "confirm first") {
      passes.push("CGUARDask: the ask reason is surfaced to the Codex operator");
    } else if (r.verdict === "surface") {
      failures.push(
        `CGUARDask: ask surfaced but reason not carried — expected 'confirm first', got ${JSON.stringify(r.validation)}`,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Behavioral: an "ask" that carries NO reason still surfaces (fallback message),
  // never silently allows.
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "codex-guard-ask-noreason-"));
  const probePath2 = path.join(tmpDir2, "ask-noreason.js");
  fs.writeFileSync(
    probePath2,
    "// Synthetic hook: modern ask with no reason (CGUARDask fallback fixture).\n" +
      "process.stdout.write(JSON.stringify({ hookSpecificOutput: {\n" +
      "  permissionDecision: 'ask' } }));\n" +
      "process.exit(0);\n",
  );
  try {
    const hookFile = path.relative(server.HOOKS_DIR, probePath2);
    const r = server.invokeHook({
      hookFile,
      payload: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, cwd: process.cwd() },
    });
    if (r.verdict === "surface" && typeof r.validation === "string" && r.validation.length > 0) {
      passes.push("CGUARDask: reasonless ask surfaces a non-empty fallback advisory (no silent allow)");
    } else {
      failures.push(
        `CGUARDask: reasonless ask mis-handled — expected verdict 'surface' with a fallback message, got verdict '${r.verdict}' validation=${JSON.stringify(r.validation)}`,
      );
    }
  } finally {
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  }
}

// ────────────────────────────────────────────────────────────────
// #71 — multi-line hook stdout: the permissionDecision (ask/deny) MUST be
// captured even when it sits on a DIFFERENT line than the validation object.
// The pre-fix single-`break` scan stopped at the first validation-bearing line
// (scanning upward) and never read a decision on an as-yet-unscanned line, so a
// split-line "ask" fell through to the code===0 branch and — with a non-actionable
// validation — resolved to a silent "allow". Fix captures permissionDecision from
// the FULL stdout; the single-line CC path MUST stay unchanged.
// ────────────────────────────────────────────────────────────────
{
  const os = require("node:os");

  // Unit: ask on an EARLIER line, a non-actionable validation object on a LATER
  // line — the exact ordering the upward-scan `break` used to drop (validation
  // line is scanned first, break fires, the ask line is never reached). Post-fix
  // the "ask" is captured from the full stdout regardless of order.
  const splitAsk =
    JSON.stringify({
      hookSpecificOutput: {
        permissionDecision: "ask",
        permissionDecisionReason: "confirm before writing shared config",
      },
    }) +
    "\n" +
    JSON.stringify({
      hookSpecificOutput: { additionalContext: "non-actionable advisory context" },
    });
  const parsedSplit = server.extractHookValidation(splitAsk);
  if (parsedSplit.permissionDecision === "ask") {
    passes.push(
      "#71: split-line ask (decision on an earlier line than the validation object) is captured",
    );
  } else {
    failures.push(
      `#71: split-line ask dropped — expected permissionDecision 'ask', got ${JSON.stringify(parsedSplit.permissionDecision)}`,
    );
  }

  // Unit: split-line DENY (decision line ≠ validation line) is captured AND wins
  // (most-restrictive) regardless of which line carries the validation body.
  const splitDeny =
    JSON.stringify({ hookSpecificOutput: { additionalContext: "some advisory" } }) +
    "\n" +
    JSON.stringify({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "blocked",
      },
    });
  const parsedDeny = server.extractHookValidation(splitDeny);
  if (parsedDeny.permissionDecision === "deny") {
    passes.push(
      "#71: split-line deny (decision on a different line than the validation object) is captured",
    );
  } else {
    failures.push(
      `#71: split-line deny dropped — expected 'deny', got ${JSON.stringify(parsedDeny.permissionDecision)}`,
    );
  }

  // Behavioral: a probe hook emitting the split-line ask at exit 0 MUST resolve to
  // verdict "surface" (advisory preserved), NOT the fail-open "allow" the pre-fix
  // code produced when the validation body was non-actionable.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-guard-71-splitask-"));
  const probePath = path.join(tmpDir, "split-ask.js");
  fs.writeFileSync(
    probePath,
    "// Synthetic hook: multi-line stdout — ask decision on line 1, a\n" +
      "// non-actionable validation object on line 2 (#71 fixture).\n" +
      "process.stdout.write(JSON.stringify({ hookSpecificOutput: {\n" +
      "  permissionDecision: 'ask', permissionDecisionReason: 'confirm first' } }) + '\\n');\n" +
      "process.stdout.write(JSON.stringify({ hookSpecificOutput: {\n" +
      "  additionalContext: 'non-actionable advisory context' } }) + '\\n');\n" +
      "process.exit(0);\n",
  );
  try {
    const hookFile = path.relative(server.HOOKS_DIR, probePath);
    const r = server.invokeHook({
      hookFile,
      payload: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, cwd: process.cwd() },
    });
    if (r.verdict === "surface") {
      passes.push(
        "#71: split-line ask at exit 0 routes to verdict 'surface' (advisory preserved, no silent allow)",
      );
    } else {
      failures.push(
        `#71: split-line ask mis-routed — expected verdict 'surface', got '${r.verdict}' (exitCode=${r.exitCode})`,
      );
    }
    if (r.verdict === "surface" && typeof r.validation === "string" && r.validation.length > 0) {
      passes.push("#71: split-line ask surfaces a non-empty advisory to the Codex operator");
    } else if (r.verdict === "surface") {
      failures.push(
        `#71: split-line ask surfaced but advisory empty — got ${JSON.stringify(r.validation)}`,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Regression: single-line CC path UNCHANGED. A single JSON line carrying a
  // clean (non-actionable) validation and NO permissionDecision still resolves to
  // a plain "allow" — the #71 full-stdout scan introduces no spurious surface.
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "codex-guard-71-singleclean-"));
  const probePath2 = path.join(tmpDir2, "single-clean.js");
  fs.writeFileSync(
    probePath2,
    "// Synthetic hook: single-line clean all-clear (#71 single-line-unchanged fixture).\n" +
      "process.stdout.write(JSON.stringify({ continue: true, hookSpecificOutput: {\n" +
      "  additionalContext: 'Validated' } }));\n" +
      "process.exit(0);\n",
  );
  try {
    const hookFile = path.relative(server.HOOKS_DIR, probePath2);
    const r = server.invokeHook({
      hookFile,
      payload: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, cwd: process.cwd() },
    });
    if (r.verdict === "allow") {
      passes.push(
        "#71: single-line clean all-clear still resolves to 'allow' (single-line CC path unchanged)",
      );
    } else {
      failures.push(
        `#71: single-line clean regressed — expected verdict 'allow', got '${r.verdict}' validation=${JSON.stringify(r.validation)}`,
      );
    }
  } finally {
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  }

  // Regression: single-line CC ask still captured (the CGUARDask happy path,
  // re-affirmed after the #71 full-stdout refactor is behavior-preserving).
  const singleAsk = JSON.stringify({
    hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "confirm" },
  });
  const parsedSingle = server.extractHookValidation(singleAsk);
  if (parsedSingle.permissionDecision === "ask") {
    passes.push(
      "#71: single-line CC ask still captured (extractHookValidation refactor is behavior-preserving)",
    );
  } else {
    failures.push(
      `#71: single-line CC ask regressed — got ${JSON.stringify(parsedSingle.permissionDecision)}`,
    );
  }
}

// ────────────────────────────────────────────────────────────────
// #820 output-contract alignment — the guard RE-EMITS the CC PreToolUse
// decision contract (permissionDecision / permissionDecisionReason /
// additionalContext) on its MCP response `_meta`, stamped with COC_RUNTIME.
// Distinct from #71 (which aligned the guard's PARSING of CC hook stdout);
// this covers the guard's OWN emitted verdict shape. Structural assertions
// (field presence + exact values per probe-driven-verification.md Rule 3),
// behavioral (real exported functions + the real evaluatePolicies fail-closed
// path), no mocking.
// ────────────────────────────────────────────────────────────────
{
  // COC_RUNTIME is single-sourced as the Codex-lane label.
  if (server.COC_RUNTIME === "codex") {
    passes.push("#820 output-contract: COC_RUNTIME single-source === 'codex'");
  } else {
    failures.push(
      `#820 output-contract: COC_RUNTIME expected 'codex', got ${JSON.stringify(server.COC_RUNTIME)}`,
    );
  }

  // Helper unit — DENY shape: permissionDecision:'deny' + permissionDecisionReason,
  // NO additionalContext, coc_runtime stamped.
  const denyHSO = server.ccHookSpecificOutput({
    decision: "deny",
    reason: "rm -rf / is destructive",
  });
  if (
    denyHSO.hookEventName === "PreToolUse" &&
    denyHSO.permissionDecision === "deny" &&
    denyHSO.permissionDecisionReason === "rm -rf / is destructive" &&
    denyHSO.additionalContext === undefined &&
    denyHSO.coc_runtime === "codex"
  ) {
    passes.push(
      "#820 output-contract: ccHookSpecificOutput deny shape (permissionDecision+reason+coc_runtime, no additionalContext)",
    );
  } else {
    failures.push(
      `#820 output-contract: deny hookSpecificOutput malformed — got ${JSON.stringify(denyHSO)}`,
    );
  }

  // Helper unit — ALLOW/advisory shape: permissionDecision:'allow' +
  // additionalContext, NO permissionDecisionReason. A lexical/advisory match
  // never carries a deny/block (hook-output-discipline.md MUST-2).
  const allowHSO = server.ccHookSpecificOutput({
    decision: "allow",
    context: "curl|bash advisory",
  });
  if (
    allowHSO.permissionDecision === "allow" &&
    allowHSO.additionalContext === "curl|bash advisory" &&
    allowHSO.permissionDecisionReason === undefined &&
    allowHSO.coc_runtime === "codex"
  ) {
    passes.push(
      "#820 output-contract: ccHookSpecificOutput advisory shape (permissionDecision:'allow'+additionalContext, never deny)",
    );
  } else {
    failures.push(
      `#820 output-contract: advisory hookSpecificOutput malformed — got ${JSON.stringify(allowHSO)}`,
    );
  }

  // translateDeny end-to-end — the guard's deny emit-site carries the CC deny
  // contract on _meta.hookSpecificOutput while isError stays true.
  const denyStdout = JSON.stringify({
    continue: false,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "STOP — Tool call blocked. rm -rf / is destructive.",
    },
  });
  const denyResp = server.translateDeny({
    hookFile: "validate-bash-command.js",
    hookStdout: denyStdout,
    hookStderr: "",
  });
  const denyMetaHSO = denyResp?._meta?.hookSpecificOutput || {};
  if (
    denyResp.isError === true &&
    denyMetaHSO.permissionDecision === "deny" &&
    typeof denyMetaHSO.permissionDecisionReason === "string" &&
    denyMetaHSO.permissionDecisionReason.length > 0 &&
    denyMetaHSO.coc_runtime === "codex"
  ) {
    passes.push(
      "#820 output-contract: translateDeny re-emits the CC deny contract on _meta.hookSpecificOutput (isError preserved)",
    );
  } else {
    failures.push(
      `#820 output-contract: translateDeny _meta.hookSpecificOutput malformed — isError=${denyResp.isError} hso=${JSON.stringify(denyMetaHSO)}`,
    );
  }

  // buildAllowResponse surface path — a forwarded halt-and-report carries the CC
  // ALLOW+additionalContext contract; isError stays false (the policy request IS permitted).
  const surfaceResp = server.buildAllowResponse({
    allow: true,
    warnings: [
      {
        source_file: "instruct-and-wait.js",
        validation:
          "ADVISORY — Acknowledge in next message. curl|bash detected.",
      },
    ],
  });
  const surfaceHSO = surfaceResp?._meta?.hookSpecificOutput || {};
  if (
    surfaceResp.isError !== true &&
    surfaceHSO.permissionDecision === "allow" &&
    typeof surfaceHSO.additionalContext === "string" &&
    surfaceHSO.additionalContext.includes("curl|bash") &&
    surfaceHSO.coc_runtime === "codex"
  ) {
    passes.push(
      "#820 output-contract: buildAllowResponse surface path re-emits ALLOW+additionalContext (policy request permitted, never deny)",
    );
  } else {
    failures.push(
      `#820 output-contract: buildAllowResponse surface _meta.hookSpecificOutput malformed — isError=${surfaceResp.isError} hso=${JSON.stringify(surfaceHSO)}`,
    );
  }

  // Plain allow (no warnings) stays the bare "permit" — NO hookSpecificOutput
  // stamped (behavior-preserving; only deny + advisory surfaces carry the contract).
  const plainResp = server.buildAllowResponse({ allow: true, warnings: [] });
  if (!plainResp._meta || plainResp._meta.hookSpecificOutput === undefined) {
    passes.push(
      "#820 output-contract: plain allow stays bare 'permit' (no spurious hookSpecificOutput)",
    );
  } else {
    failures.push(
      `#820 output-contract: plain allow unexpectedly carries hookSpecificOutput — got ${JSON.stringify(plainResp._meta)}`,
    );
  }

  // Fail-closed preserved AND CC-contract stamped — the un-evaluable (missing) hook
  // path DENIES and its mcpResponse carries permissionDecision:'deny' on
  // _meta.hookSpecificOutput. A guard that cannot evaluate policy MUST NOT fail open.
  {
    const realShell = server.POLICIES.shell;
    server.POLICIES.shell = [
      { source_file: "__nonexistent_820_hook__.js" },
      ...realShell,
    ];
    try {
      const r = server.evaluatePolicies({
        tool: "shell",
        input: { command: "echo hi" },
        cwd: process.cwd(),
      });
      const fcHSO = r.mcpResponse?._meta?.hookSpecificOutput || {};
      if (
        r.allow === false &&
        r.mcpResponse?.isError === true &&
        r.mcpResponse?._meta?.fail_closed === true &&
        fcHSO.permissionDecision === "deny" &&
        typeof fcHSO.permissionDecisionReason === "string" &&
        fcHSO.permissionDecisionReason.length > 0 &&
        fcHSO.coc_runtime === "codex"
      ) {
        passes.push(
          "#820 output-contract: fail-closed deny carries the CC deny contract on _meta.hookSpecificOutput (fail-closed preserved, never fail-open)",
        );
      } else {
        failures.push(
          `#820 output-contract: fail-closed deny missing CC contract — allow=${r.allow} isError=${r.mcpResponse?.isError} fail_closed=${r.mcpResponse?._meta?.fail_closed} hso=${JSON.stringify(fcHSO)}`,
        );
      }
    } finally {
      server.POLICIES.shell = realShell;
    }
  }
}

// ────────────────────────────────────────────────────────────────
// F-CGUARD-EXIT1 — exit-1 load-crash fails CLOSED; the Rule-7 advisory
// exit-1 ({continue:true} then exit 1) still forwards (journal/0535)
// ────────────────────────────────────────────────────────────────
// The crash-vs-advisory discriminator: a clean non-zero-non-2 exit is `warn`
// (advisory-forward) ONLY when stdout carried a parseable canonical decision (the
// 45 real Rule-7 timeout-fallback advisories); a decision-less load-crash is
// `crash` → FAIL-CLOSED (deny). Regression guards both directions.
{
  const os = require("node:os");

  // Unit: hasParseableHookDecision discriminates decision-bearing stdout from a crash.
  const P = server.hasParseableHookDecision;
  const predCases = [
    ['{"continue":true}', true, "bare continue:true (the Rule-7 advisory)"],
    ['{"continue":true}\n', true, "continue:true with trailing newline"],
    ['{"hookSpecificOutput":{"validation":"x"}}', true, "hookSpecificOutput shape"],
    ['{"systemMessage":"x"}', true, "systemMessage (Stop-class) shape"],
    ["Error: boom\n    at Object.<anonymous>", false, "a stack trace (crash, no decision)"],
    ["", false, "empty stdout (crash before any write)"],
    ["not json at all", false, "non-JSON garbage"],
    ['{"unrelated":1}', false, "JSON with no recognized decision key"],
    ['{"decision":"block"}', false, "top-level decision — NOT consumed by the guard → fail-closed (R1 sec-reviewer)"],
  ];
  for (const [stdout, expected, label] of predCases) {
    if (P(stdout) === expected) {
      passes.push(`F-CGUARD-EXIT1: hasParseableHookDecision — ${label} → ${expected}`);
    } else {
      failures.push(
        `F-CGUARD-EXIT1: hasParseableHookDecision — ${label} expected ${expected}, got ${P(stdout)}`,
      );
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-guard-exit1-"));
  try {
    // Behavioral A: a hook node LAUNCHES then throws (uncaught) → exit 1, NO stdout
    // decision → invokeHook verdict "crash".
    const crashPath = path.join(tmpDir, "load-crash.js");
    fs.writeFileSync(
      crashPath,
      "// Synthetic hook: launches then crashes (uncaught throw), no stdout (F-CGUARD-EXIT1).\n" +
        "throw new Error('simulated load crash — no parseable decision emitted');\n",
    );
    const crashHookFile = path.relative(server.HOOKS_DIR, crashPath);
    const rCrash = server.invokeHook({
      hookFile: crashHookFile,
      payload: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, cwd: process.cwd() },
    });
    if (rCrash.verdict === "crash") {
      passes.push(
        "F-CGUARD-EXIT1: exit-1 load-crash (no stdout decision) routes to verdict 'crash' (was fail-open 'warn')",
      );
    } else {
      failures.push(
        `F-CGUARD-EXIT1: load-crash mis-routed — expected verdict 'crash', got '${rCrash.verdict}' (exitCode=${rCrash.exitCode})`,
      );
    }

    // Behavioral B: a Rule-7 timeout-fallback advisory writes {continue:true} to stdout
    // THEN exits 1 → invokeHook verdict "warn" (advisory-forward, UNCHANGED — the 45-hook
    // regression guard: the crash fix MUST NOT convert legitimate advisories into denials).
    const advisoryPath = path.join(tmpDir, "rule7-advisory.js");
    fs.writeFileSync(
      advisoryPath,
      "// Synthetic hook: cc-artifacts.md Rule-7 timeout-fallback advisory (F-CGUARD-EXIT1).\n" +
        "process.stdout.write(JSON.stringify({ continue: true }) + '\\n');\n" +
        "process.exit(1);\n",
    );
    const advisoryHookFile = path.relative(server.HOOKS_DIR, advisoryPath);
    const rAdvisory = server.invokeHook({
      hookFile: advisoryHookFile,
      payload: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, cwd: process.cwd() },
    });
    if (rAdvisory.verdict === "warn") {
      passes.push(
        "F-CGUARD-EXIT1: Rule-7 advisory exit-1 (continue:true then exit 1) stays verdict 'warn' (45-hook regression guard)",
      );
    } else {
      failures.push(
        `F-CGUARD-EXIT1: Rule-7 advisory mis-routed — expected verdict 'warn', got '${rAdvisory.verdict}' (exitCode=${rAdvisory.exitCode})`,
      );
    }

    // Behavioral D: end-to-end through evaluatePolicies — a crash hook at the HEAD of
    // shell's chain MUST DENY with the fail_closed marker and _meta.verdict='crash'
    // (mirrors the Fixture-9 missing-hook fail-closed assertion for the new verdict).
    const realShell = server.POLICIES.shell;
    server.POLICIES.shell = [{ source_file: crashHookFile }, ...realShell];
    try {
      const r = server.evaluatePolicies({
        tool: "shell",
        input: { command: "echo hi" },
        cwd: process.cwd(),
      });
      const meta = r.mcpResponse?._meta || {};
      if (r.allow !== false) {
        failures.push(
          `F-CGUARD-EXIT1: a load-crash enforcement hook MUST DENY (fail-closed), got allow=${r.allow}`,
        );
      } else if (!r.mcpResponse?.isError || meta.fail_closed !== true) {
        failures.push(
          `F-CGUARD-EXIT1: expected isError + _meta.fail_closed=true on crash, got ${JSON.stringify(meta)}`,
        );
      } else if (meta.verdict !== "crash") {
        failures.push(
          `F-CGUARD-EXIT1: expected _meta.verdict=crash, got ${meta.verdict}`,
        );
      } else {
        passes.push(
          "F-CGUARD-EXIT1: end-to-end — a load-crash enforcement hook DENIES with the fail_closed marker (verdict 'crash', #411 posture)",
        );
      }
    } finally {
      server.POLICIES.shell = realShell;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
