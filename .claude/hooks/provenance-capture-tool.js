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
 *   - delegation tool (Task)             → Delegation  (which sub-agent, what task)
 *   - write tool writing a journal       → Decision    (a DECISION entry is landing)
 *     NNNN-*DECISION*.md
 *   - write tool OR shell tool           → Action      (a consequential mutation)
 *   - read-path (Read/Grep/Glob/WebFetch)→ SKIP        (read-path is out of scope
 *                                                       per #411 completeness vet)
 *
 * CROSS-CLI (F101 item 1, loom#411): this ONE hook file is registered as the
 * provenance capture surface on ALL THREE CLIs — CC (PreToolUse *), Gemini
 * (BeforeTool), Codex (PreToolUse shell). classify() therefore recognizes each
 * CLI's tool vocabulary, which is DISJOINT across CLIs, so the CLI is implicit
 * in the tool name (no env var / flag): CC {Task, Edit/Write/…, Bash}, Gemini
 * {write_file, replace, run_shell_command}, Codex {apply_patch, shell,
 * unified_exec}. classify() maps by EFFECT (delegation / write / shell), so a
 * future cross-CLI tool-name collision (none today) still classifies by kind.
 *
 * SECRETS FENCE (`security.md` "no secrets in logs"): the ledger is a permanent,
 * csq-anchored record. Surfaces that can carry literal secret VALUES — a Bash
 * command (`export TOKEN=...`), a Task prompt — are stored as a sha256 COMMITMENT,
 * never raw. Surfaces that are accountability-bearing and not secret-shaped — the
 * file_path of a mutation, the subagent_type of a delegation — are kept verbatim.
 * A Codex shell/unified_exec ARGV ARRAY is joined-with-spaces THEN hashed: the
 * commitment is a privacy-preserving fingerprint, NOT a faithful argv
 * reconstruction (an argv array and the equivalent string command collide on the
 * same sha256 — acceptable, the hash proves "what" only to a holder of the
 * plaintext). argv elements are assumed string-shaped; the Codex shell contract
 * does not pass nested objects.
 *
 * INTENT vs EXECUTION (PreToolUse capture — accepted residual, NOT a leak): events
 * are captured at PreToolUse / BeforeTool = INTENT time. A captured Action/Decision
 * records that the agent was ABOUT to run the tool, not that it succeeded — a
 * sibling guard (e.g. validate-bash-command.js on the same shell matcher) may exit
 * 2 and DENY the call AFTER this hook recorded the intent. This is BY DESIGN:
 * PreToolUse capture is what makes the record deterministic ("the model cannot skip
 * it"). csq's drain treats provenance events as INTENT; an execution-confirmation
 * (PostToolUse reconciliation marker) is a separate kind the FROZEN schema (F120,
 * provenance-event.js) does not carry — tracked as a #411 sub-shard, not this one.
 *
 * MUTATION SSOT: CC file-write tools come from `tool-classes.js::isMutationTool`
 * (the single mutation-tool registry per `cc-artifacts.md` Rule 8). The Gemini /
 * Codex write-tool names live HERE (provenance-local), NOT in `MUTATION_TOOLS` —
 * that set drives the CC file-write guards (integrity-guard / adjacency-leasecheck),
 * and widening it with non-CC names would change those guards' behavior on CC. The
 * shell tools (Bash / run_shell_command / shell / unified_exec) are also provenance-
 * local consequential-action surfaces, intentionally outside MUTATION_TOOLS.
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
const path = require("path");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// A mutation tool writing a path matching this pattern records a Decision, not a
// bare Action. Covers: `NNNN-display_id-DECISION-slug.md` (multi-operator),
// legacy `NNNN-DECISION-topic.md`, AND `journal/.pending/<ts>-N-DECISION.md`
// SessionEnd stubs (13-digit timestamp prefix). `\d+` (not `\d{4}`) + optional
// `.pending/` so a DECISION write is captured as a Decision in every journal form.
const JOURNAL_DECISION_RE =
  /(?:^|\/)journal\/(?:\.pending\/)?\d+-[^/]*DECISION[^/]*\.md$/i;

// Cross-CLI tool vocabularies (F101 item 1). Disjoint across CLIs, so membership
// alone disambiguates the CLI — classify() maps by EFFECT, not by CLI.
//   - DELEGATION: CC's delegation tool — named `Agent` in current/enhanced
//     harnesses (verified CC 2.1.195) and `Task` in vanilla CC (legacy alias) —
//     is a tool call; accept BOTH (legacy-tolerant — same PATTERN as
//     tool-classes.js::MUTATION_TOOLS's legacy-tool retention, not its
//     contents). Gemini `@agent` fires the native
//     BeforeAgent lifecycle event (a different payload shape, not a tool call);
//     Codex delegation is inline-cat injection via bin/coc (no tool call). Both are
//     deferred per #411 provenance_parity — no tool-call capture point exists here.
//   - WRITE (non-CC): CC write tools come from tool-classes.js::isMutationTool; the
//     Gemini (write_file/replace) + Codex (apply_patch) write-tool names live here.
//   - SHELL: the consequential-command surface across all CLIs.
const DELEGATION_TOOLS = new Set(["Task", "Agent"]);
const GEMINI_WRITE_TOOLS = new Set(["write_file", "replace"]);
const CODEX_WRITE_TOOLS = new Set(["apply_patch"]);
const SHELL_TOOLS = new Set([
  "Bash", // CC
  "run_shell_command", // Gemini
  "shell", // Codex
  "unified_exec", // Codex
]);

function sha256(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

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

// Cross-CLI write-tool predicate: CC mutation tools (via the tool-classes SSOT)
// PLUS the Gemini / Codex write-tool names. A write tool is the Action/Decision
// surface on every CLI.
function isWriteToolSafely(tool) {
  return (
    isMutationToolSafely(tool) ||
    GEMINI_WRITE_TOOLS.has(tool) ||
    CODEX_WRITE_TOOLS.has(tool)
  );
}

/**
 * Classify a tool call into a provenance {kind, payload} or null (skip).
 * Pure function of (tool name, tool_input) — no IO, fully testable.
 */
function classify(tool, toolInput) {
  const ti = toolInput && typeof toolInput === "object" ? toolInput : {};

  if (DELEGATION_TOOLS.has(tool)) {
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
  const isWrite = isWriteToolSafely(tool);

  if (isWrite && filePath && JOURNAL_DECISION_RE.test(filePath)) {
    return { kind: "Decision", payload: { tool, journal_path: filePath } };
  }

  if (isWrite) {
    const payload = { tool };
    if (filePath) payload.file_path = filePath;
    return { kind: "Action", payload };
  }

  if (SHELL_TOOLS.has(tool)) {
    const payload = { tool };
    // Secrets fence: the command is stored as a sha256 commitment + length,
    // never raw. Handle both the CC/Gemini string form and the Codex array
    // form (`shell`/`unified_exec` pass argv as an array).
    const cmd = ti.command;
    if (typeof cmd === "string") {
      payload.command_sha256 = sha256(cmd);
      payload.command_chars = cmd.length;
    } else if (Array.isArray(cmd)) {
      const joined = cmd.map((x) => String(x)).join(" ");
      payload.command_sha256 = sha256(joined);
      payload.command_chars = joined.length;
    }
    return { kind: "Action", payload };
  }

  // read-path (Read/Grep/Glob/WebFetch/read_file/grep_search/…) — out of scope
  // per #411 completeness vet (no kind for a read).
  return null;
}

/**
 * #448 (F128 #445 walk residual) — attribute the EMITTING agent.
 *
 * CC populates top-level `agent_id` / `agent_type` in the PreToolUse hook input
 * ONLY when the tool call originates INSIDE a subagent (Task/Agent) call; for a
 * main-agent call both are absent. EMPIRICALLY CONFIRMED 2026-06-30 (the
 * journal/0224-mandated #448 acceptance re-walk): a live general-purpose
 * subagent's Write captured `agent_id`=<instance-hex> / `agent_type`=
 * "general-purpose" in the ledger; the same session's main-agent events
 * captured neither — receipt journal/0370. (The test suite's "plumbing" cases
 * INJECT these fields to prove the merge path; the live subagent walk is what
 * proves CC supplies them.)
 *
 * Embedding them in the FREE-FORM `payload` (NOT a new top-level EVENT_KEYS
 * field) records per-subagent attribution with NO `schema_version` bump — the
 * F120 csq seam (provenance-event.js EVENT_KEYS, schema_version:1) stays
 * byte-frozen, and a credential-shaped-key scan accepts `agent_id`/`agent_type`
 * (neither is in the `_secret|_token|…|_key` suffix family). A main-agent call
 * leaves payload unchanged, so a subagent-internal Action/Decision/Delegation
 * is now field-distinguishable from a parent one.
 *
 * Captured but NOT decoded: agent_id/agent_type live in the free-form payload,
 * so csq's deriveSurface (provenance-event.js) does not surface them unless csq
 * opts into reading `payload.agent_id` (contrast `subagent_type`, which
 * deriveSurface reads). loom owns FORMAT; csq decides what it decodes.
 *
 * Mutates-and-returns `payload` (testable). Skips non-string/empty values so a
 * malformed hook input never injects a non-string attribution key.
 */
function attachAgentAttribution(payload, hookInput) {
  if (!payload || typeof payload !== "object") return payload;
  const hi = hookInput && typeof hookInput === "object" ? hookInput : {};
  if (typeof hi.agent_id === "string" && hi.agent_id) {
    payload.agent_id = hi.agent_id;
  }
  if (typeof hi.agent_type === "string" && hi.agent_type) {
    payload.agent_type = hi.agent_type;
  }
  return payload;
}

async function main() {
  fallback = setTimeout(() => {
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
    process.exit(1);
  }, TIMEOUT_MS);
  try {
    const payload = await readStdinBounded();
    const tool = payload.tool_name || payload.tool || "";
    const classified = classify(tool, payload.tool_input);
    if (!classified) {
      passthrough();
      return;
    }

    // #448: attribute the emitting subagent (payload-embedded; no schema bump).
    // agent_id/agent_type are top-level PreToolUse fields, present only inside a
    // subagent call — classify() sees only tool_input, so attach here in main().
    attachAgentAttribution(classified.payload, payload);

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

// Exported for the test harness (classify is the load-bearing kind-dispatch;
// attachAgentAttribution is the #448 per-subagent attribution merge).
module.exports = { classify, attachAgentAttribution, JOURNAL_DECISION_RE };
