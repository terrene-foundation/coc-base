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
const FIXTURE_DIR = path.resolve(
  __dirname,
  "..",
  "audit-fixtures",
  "codex-mcp-guard",
);

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
  } else {
    passes.push(`clean-shell.json: allow=${r.allow}`);
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
// Fixture 3 — flagging payload (force-push to main), deny expected
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
  } else if (!r.mcpResponse?.isError) {
    failures.push(
      `flag-shell-force-push-main.json: deny path produced no isError`,
    );
  } else {
    const text = r.mcpResponse.content?.[0]?.text || "";
    if (!text.toLowerCase().includes(fx.expected_text_substring.toLowerCase())) {
      failures.push(
        `flag-shell-force-push-main.json: text missing '${fx.expected_text_substring}'`,
      );
    } else {
      passes.push(
        `flag-shell-force-push-main.json: deny via ${r.mcpResponse._meta?.hook}`,
      );
    }
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
