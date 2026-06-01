#!/usr/bin/env node
/**
 * provenance-capture-tool.js — F101-2 (loom#411 governance-as-DNA, loom lane).
 *
 * Event: PreToolUse (*)
 * Severity: NEVER blocks. {continue:true} on every path. Captured at PreToolUse
 *           so it is DETERMINISTIC — the model cannot skip the record by routing
 *           around it (#411 "Deterministic; model cannot bypass").
 * Budget: 5s wall-clock.
 *
 * Behavior: classify the about-to-run tool call into a provenance kind and
 * record it in the local per-session ledger (provenance-ledger.js):
 *
 *   - Task                              → Delegation  (which sub-agent, what task)
 *   - mutation tool writing a journal    → Decision    (a DECISION entry is landing)
 *     NNNN-*DECISION*.md
 *   - mutation tool (Edit/Write/...) OR  → Action      (a consequential mutation)
 *     Bash
 *   - read-path (Read/Grep/Glob/WebFetch)→ SKIP        (read-path is out of scope
 *                                                       per #411 completeness vet)
 *
 * SECRETS FENCE (`security.md` "no secrets in logs"): the ledger is a permanent,
 * csq-anchored record. Surfaces that can carry literal secret VALUES — a Bash
 * command (`export TOKEN=...`), a Task prompt — are stored as a sha256 COMMITMENT,
 * never raw. Surfaces that are accountability-bearing and not secret-shaped — the
 * file_path of a mutation, the subagent_type of a delegation — are kept verbatim.
 *
 * MUTATION SSOT: file-write tools come from `tool-classes.js::isMutationTool` (the
 * single mutation-tool registry per `cc-artifacts.md` Rule 8). Bash is added HERE
 * (provenance-local) as a consequential-action surface — it is intentionally NOT
 * in MUTATION_TOOLS (that set drives the file-write guards; widening it there would
 * change integrity-guard / adjacency-leasecheck behavior).
 *
 * Test env overrides:
 *   COC_TEST_FINGERPRINT, COC_TEST_PERSON_ID — identity short-circuit
 *
 * Origin: F101-2 (journal/0188 §D; F101-1 schema journal/0190; seam csq journal 0017).
 */

"use strict";

const TIMEOUT_MS = 5000;
// Armed INSIDE main() — NOT at module top level — so `require()`ing this file for
// classify() in tests does not schedule a stray timer that would fire+exit(1).
let fallback = null;

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// A mutation tool writing a path matching this pattern records a Decision, not a
// bare Action. Covers: `NNNN-display_id-DECISION-slug.md` (multi-operator),
// legacy `NNNN-DECISION-topic.md`, AND `journal/.pending/<ts>-N-DECISION.md`
// SessionEnd stubs (13-digit timestamp prefix). `\d+` (not `\d{4}`) + optional
// `.pending/` so a DECISION write is captured as a Decision in every journal form.
const JOURNAL_DECISION_RE =
  /(?:^|\/)journal\/(?:\.pending\/)?\d+-[^/]*DECISION[^/]*\.md$/i;

function sha256(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

function readStdinSyncSafe() {
  try {
    const data = fs.readFileSync(0, "utf8");
    if (!data || !data.trim()) return {};
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function passthrough() {
  if (fallback) clearTimeout(fallback);
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {}
  process.exit(0);
}

function resolveMainCheckoutSafely(repoDir) {
  try {
    const { resolveMainCheckout } = require(
      path.join(__dirname, "lib", "state-resolver.js"),
    );
    return resolveMainCheckout(repoDir);
  } catch {
    return repoDir;
  }
}

function resolveIdentitySafely(repoDir) {
  const testFp = process.env.COC_TEST_FINGERPRINT;
  const testPid = process.env.COC_TEST_PERSON_ID;
  if (testFp && testPid) {
    return { verified_id: testFp, person_id: testPid };
  }
  try {
    const { resolveIdentity } = require(
      path.join(__dirname, "lib", "operator-id.js"),
    );
    return resolveIdentity(repoDir, {});
  } catch {
    return null;
  }
}

function isMutationToolSafely(tool) {
  try {
    const { isMutationTool } = require(
      path.join(__dirname, "lib", "tool-classes.js"),
    );
    return isMutationTool(tool);
  } catch {
    return false;
  }
}

/**
 * Classify a tool call into a provenance {kind, payload} or null (skip).
 * Pure function of (tool name, tool_input) — no IO, fully testable.
 */
function classify(tool, toolInput) {
  const ti = toolInput && typeof toolInput === "object" ? toolInput : {};

  if (tool === "Task") {
    const payload = { tool };
    if (typeof ti.subagent_type === "string" && ti.subagent_type) {
      payload.subagent_type = ti.subagent_type;
    }
    if (typeof ti.description === "string") {
      payload.description_chars = ti.description.length;
    }
    if (typeof ti.prompt === "string") {
      payload.prompt_sha256 = sha256(ti.prompt);
    }
    return { kind: "Delegation", payload };
  }

  const filePath =
    (typeof ti.file_path === "string" && ti.file_path) ||
    (typeof ti.notebook_path === "string" && ti.notebook_path) ||
    null;
  const isMutation = isMutationToolSafely(tool);

  if (isMutation && filePath && JOURNAL_DECISION_RE.test(filePath)) {
    return { kind: "Decision", payload: { tool, journal_path: filePath } };
  }

  if (isMutation) {
    const payload = { tool };
    if (filePath) payload.file_path = filePath;
    return { kind: "Action", payload };
  }

  if (tool === "Bash") {
    const payload = { tool };
    if (typeof ti.command === "string") {
      payload.command_sha256 = sha256(ti.command);
      payload.command_chars = ti.command.length;
    }
    return { kind: "Action", payload };
  }

  // read-path (Read/Grep/Glob/WebFetch/…) — out of scope per #411 vet.
  return null;
}

function main() {
  fallback = setTimeout(() => {
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
    process.exit(1);
  }, TIMEOUT_MS);
  try {
    const payload = readStdinSyncSafe();
    const tool = payload.tool_name || payload.tool || "";
    const classified = classify(tool, payload.tool_input);
    if (!classified) {
      passthrough();
      return;
    }

    const mainCheckout = resolveMainCheckoutSafely(PROJECT_DIR);
    const identity = resolveIdentitySafely(mainCheckout);
    const session = payload.session_id || "unknown-session";

    try {
      const { captureProvenance } = require(
        path.join(__dirname, "lib", "provenance-ledger.js"),
      );
      const r = captureProvenance({
        repoDir: mainCheckout,
        session,
        kind: classified.kind,
        identity,
        payload: classified.payload,
        nowIso: new Date().toISOString(),
      });
      // Observability: a DROPPED governance event must leave a breadcrumb, not
      // vanish silently (`observability.md` / `zero-tolerance.md` Rule 3). stderr
      // does NOT touch the {continue:true} stdout payload, so it never blocks.
      if (r && r.ok === false) {
        try {
          process.stderr.write(
            `provenance.capture.dropped kind=${classified.kind} reason=${String(
              r.error,
            ).slice(0, 120)}\n`,
          );
        } catch {}
      }
    } catch {
      // Best-effort: capture failure degrades the ledger, never blocks the tool.
    }

    passthrough();
  } catch {
    // Never block, never re-throw.
    passthrough();
  }
}

// Run main() ONLY when invoked as a hook (node provenance-capture-tool.js) — NOT
// when required for testing classify(), so the test never blocks reading fd 0.
if (require.main === module) {
  main();
}

// Exported for the test harness (classify is the load-bearing kind-dispatch).
module.exports = { classify, JOURNAL_DECISION_RE };
