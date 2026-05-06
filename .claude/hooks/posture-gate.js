#!/usr/bin/env node
/**
 * Hook: posture-gate
 * Events:
 *   - SessionStart — emit stderr summary so user sees current posture
 *   - PreToolUse  — enforce posture-bound tool restrictions at L2/L3
 *
 * Posture allowances (per `rules/trust-posture.md` § Posture Ladder):
 *   L5_DELEGATED            full autonomy → passthrough always
 *   L4_CONTINUOUS_INSIGHT   full autonomy → passthrough (stricter at /redteam,
 *                           journal mandate; gate-level enforcement only)
 *   L3_SHARED_PLANNING      block Edit|Write|Bash beyond read-only;
 *                           block git commit / gh pr create / git push
 *   L2_SUPERVISED           block all Edit|Write; block any non-read-only Bash
 *   L1_PSEUDO_AGENT         block all working-tree mutations
 *
 * Severity: halt-and-report (NOT block exit-2). Posture is policy, not safety;
 * the agent receives structured instruction to surface and wait. Genuine
 * safety blocks (rm -rf, force-push to main, secret leak) live in
 * validate-bash-command.js / validate-deployment.js as `block` severity.
 *
 * Mitigates cc-artifacts.md Rule 7 (timeout fallback).
 */

const TIMEOUT_MS = 5000;
const fallback = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);

const path = require("path");
const { readPosture } = require(path.join(__dirname, "lib", "state-io.js"));
const { instructAndWait } = require(
  path.join(__dirname, "lib", "instruct-and-wait.js"),
);

function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

// Read-only Bash commands permitted at L2 (the most restrictive working-tree posture)
const READ_ONLY_BASH = [
  /^\s*ls\b/,
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*git\s+(status|diff|log|show|branch|blame|reflog|rev-parse|merge-base|ls-files)\b/,
  /^\s*gh\s+(pr|issue|release|run)\s+(view|list|status)/,
  /^\s*node\s+--version\b/,
  /^\s*python3?\s+--version\b/,
  /^\s*which\s+/,
  /^\s*echo\s+/,
  /^\s*pwd\b/,
  /^\s*wc\b/,
  /^\s*jq\b/,
];

function isReadOnlyBash(cmd) {
  return READ_ONLY_BASH.some((p) => p.test(cmd));
}

// Mutating-git commands restricted at L3
const L3_BLOCKED_BASH = [
  /\bgit\s+commit\b/,
  /\bgit\s+push\b/,
  /\bgh\s+pr\s+create\b/,
  /\bgh\s+pr\s+merge\b/,
  /\bgh\s+release\s+create\b/,
];

function gateAtPosture(posture, tool, input) {
  const cmd = (input.command || "").trim();
  const filePath = input.file_path || "";

  // L5/L4: full passthrough (gate-level enforcement only at /redteam etc.)
  if (posture === "L5_DELEGATED" || posture === "L4_CONTINUOUS_INSIGHT") {
    return null;
  }

  // L3: block commit/push/PR; block Edit|Write to non-config files
  if (posture === "L3_SHARED_PLANNING") {
    if (tool === "Bash" && L3_BLOCKED_BASH.some((p) => p.test(cmd))) {
      return {
        what_happened: `Bash invoked at L3_SHARED_PLANNING: ${cmd.slice(0, 80)}`,
        why: "trust-posture/L3 — commits and PR creation require explicit user instruction at L3",
        agent_must_report: [
          "State which mutation was attempted",
          "Confirm whether the user instructed this commit/push IN THIS CONVERSATION",
          "If yes, quote the user's instruction; if no, do not retry",
        ],
        agent_must_wait:
          "Wait for explicit user instruction before any commit/push/PR mutation at L3.",
        user_summary: `L3 blocked: ${cmd.slice(0, 60)}`,
      };
    }
    // L3 allows Edit/Write — the gate is per-shard plan approval
    return null;
  }

  // L2: block all Edit|Write; block all non-read-only Bash
  if (posture === "L2_SUPERVISED") {
    if (tool === "Edit" || tool === "Write") {
      return {
        what_happened: `${tool} attempted at L2_SUPERVISED: ${filePath.slice(0, 80)}`,
        why: "trust-posture/L2 — every Edit/Write requires user instruction in the immediate prior turn",
        agent_must_report: [
          "State the file being modified and the change intent",
          "Quote the user's prior-turn instruction authorizing this edit",
          "If no instruction exists, propose the diff as a chat message instead",
        ],
        agent_must_wait:
          "Do not retry the Edit/Write. Surface the proposed change to the user and wait.",
        user_summary: `L2 blocked: ${tool} ${filePath.split("/").pop()}`,
      };
    }
    if (tool === "Bash" && !isReadOnlyBash(cmd)) {
      return {
        what_happened: `Mutating Bash attempted at L2_SUPERVISED: ${cmd.slice(0, 80)}`,
        why: "trust-posture/L2 — only read-only Bash is permitted; mutations require user instruction",
        agent_must_report: [
          "State the command and intended effect",
          "Quote the user's prior-turn instruction authorizing this command",
        ],
        agent_must_wait: "Wait for explicit user instruction.",
        user_summary: `L2 blocked: ${cmd.slice(0, 60)}`,
      };
    }
    return null;
  }

  // L1: block everything except read-only Bash
  if (posture === "L1_PSEUDO_AGENT") {
    if (tool === "Edit" || tool === "Write") {
      return {
        what_happened: `${tool} attempted at L1_PSEUDO_AGENT: ${filePath.slice(0, 80)}`,
        why: "trust-posture/L1 — zero working-tree mutations; agent proposes only",
        agent_must_report: [
          "Surface the proposed diff to the user as chat content",
          "Do NOT attempt the Edit/Write again",
        ],
        agent_must_wait:
          "L1 = propose only. The user runs commands; the agent advises.",
        user_summary: `L1 blocked: ${tool}`,
      };
    }
    if (tool === "Bash" && !isReadOnlyBash(cmd)) {
      return {
        what_happened: `Bash attempted at L1_PSEUDO_AGENT: ${cmd.slice(0, 80)}`,
        why: "trust-posture/L1 — only read-only Bash permitted",
        agent_must_report: [
          "Surface the command for the user to run themselves",
        ],
        agent_must_wait: "L1 = advise only.",
        user_summary: `L1 blocked: ${cmd.slice(0, 60)}`,
      };
    }
    return null;
  }

  return null;
}

let input = "";
if (process.stdin.isTTY) {
  passthrough();
} else {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    let data = {};
    try {
      data = JSON.parse(input);
    } catch {
      return passthrough();
    }
    const event = data.hook_event_name || data.hookEventName || "";

    if (event === "SessionStart") {
      try {
        const posture = readPosture(data.cwd);
        const pvCount = (posture.pending_verification || []).filter(
          (e) => e && e.rule_id,
        ).length;
        const tag = posture._fail_closed
          ? "FAIL-CLOSED"
          : posture._fresh
            ? "FRESH"
            : "OK";
        process.stderr.write(
          `[posture-gate] ${posture.posture} (${tag})` +
            (pvCount ? ` — ${pvCount} pending verification(s)` : "") +
            "\n",
        );
      } catch (e) {
        process.stderr.write(`[posture-gate] read failed: ${e.message}\n`);
      }
      return passthrough();
    }

    if (event === "PreToolUse") {
      const tool = data.tool_name;
      const toolInput = data.tool_input || {};
      try {
        const posture = readPosture(data.cwd);
        const gate = gateAtPosture(posture.posture, tool, toolInput);
        if (gate) {
          clearTimeout(fallback);
          const out = instructAndWait({
            hookEvent: "PreToolUse",
            severity: "halt-and-report",
            ...gate,
          });
          process.stdout.write(JSON.stringify(out.json) + "\n");
          process.exit(out.exitCode);
          return;
        }
      } catch {
        // posture read failed → passthrough; corrupt-state already handled
        // by readPosture's fail-closed-to-L1 default which would block
        // here — we explicitly choose passthrough to avoid double-failure.
      }
      return passthrough();
    }

    return passthrough();
  });
}
