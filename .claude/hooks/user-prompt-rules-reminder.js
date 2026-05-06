#!/usr/bin/env node
/**
 * Hook: user-prompt-rules-reminder
 * Event: UserPromptSubmit
 * Purpose: Inject critical rules into conversation on EVERY user message.
 *          This is the PRIMARY mechanism that survives context compression,
 *          because it runs fresh on every turn (independent of memory).
 *
 * Framework-agnostic — works with any Kailash project.
 *
 * Exit Codes:
 *   0 = success (continue)
 */

const fs = require("fs");
const path = require("path");
const {
  parseEnvFile,
  discoverModelsAndKeys,
  buildCompactSummary,
  ensureEnvFile,
} = require("./lib/env-utils");
const {
  buildWorkspaceSummary,
  findAllSessionNotes,
} = require("./lib/workspace-utils");
const {
  logObservation: logLearningObservation,
} = require("./lib/learning-utils");

const TIMEOUT_MS = 3000;
const timeout = setTimeout(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}, TIMEOUT_MS);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    const result = buildReminder(data);
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }
});

function buildReminder(data) {
  const cwd = data.cwd || process.cwd();

  // ── Always inject env summary (brief, 1-2 lines) ─────────────────
  const envPath = path.join(cwd, ".env");
  let envSummary = "No .env found";
  let failures = [];

  if (fs.existsSync(envPath)) {
    const env = parseEnvFile(envPath);
    const discovery = discoverModelsAndKeys(env);
    envSummary = buildCompactSummary(env, discovery);
    failures = discovery.validations.filter((v) => v.status === "MISSING_KEY");
  } else {
    // Try to create .env
    ensureEnvFile(cwd);
  }

  // ── Build the reminder lines ──────────────────────────────────────
  const lines = [];

  // Line 1: Always show model/key status (compressed, 1 line)
  lines.push(`[ENV] ${envSummary}`);

  // Line 2: If there are failures, highlight them
  if (failures.length > 0) {
    lines.push(
      `[ENV] CRITICAL: ${failures.length} model(s) missing API keys — LLM calls will fail!`,
    );
  }

  // (Zero-tolerance rules are loaded as an always-on rule file; no need to
  // duplicate here — doing so costs tokens on every user message.)

  // Line 3: Workspace context (survives compaction — primary anti-amnesia mechanism)
  try {
    const wsSummary = buildWorkspaceSummary(cwd);
    if (wsSummary) {
      lines.push(`[WORKSPACE] ${wsSummary}`);
    }
  } catch {}

  // ── Session notes (critical for continuity across sessions) ───────
  try {
    const allNotes = findAllSessionNotes(cwd);
    if (allNotes.length === 1) {
      const note = allNotes[0];
      const staleTag = note.stale ? " (STALE — verify before acting)" : "";
      const label = note.workspace ? `[${note.workspace}]` : "[root]";
      lines.push(
        `[SESSION-NOTES] ${label} Read ${note.relativePath} before starting work${staleTag} — updated ${note.age}`,
      );
    } else if (allNotes.length > 1) {
      const parts = allNotes.map((note) => {
        const label = note.workspace || "root";
        const staleTag = note.stale ? " STALE" : "";
        return `${label} (${note.age}${staleTag})`;
      });
      lines.push(
        `[SESSION-NOTES] ${allNotes.length} workspaces with notes — pick one to continue: ${parts.join(" | ")}`,
      );
    }
  } catch {}

  // (Keyword-triggered reminders removed — the corresponding rule files
  // are always-on and already cover env-models and e2e god-mode.)

  // --- User correction detection for learning system ---
  try {
    logUserCorrection(data.tool_input?.user_message, cwd, data.session_id);
  } catch {}

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      suppressOutput: false,
      message: lines.join("\n"),
    },
  };
}

/**
 * Detect user corrections and log as learning observations.
 * A correction is when the user pushes back on an approach or redirects.
 * Pure string matching — no LLM. /codify does semantic analysis later.
 */
function logUserCorrection(rawMessage, cwd, sessionId) {
  if (!rawMessage || rawMessage.length < 10) return;

  // Patterns that indicate the user is correcting the agent's approach.
  // We check sentence-start positions to avoid false positives like "no problem".
  const correctionPatterns = [
    /^no[,.]?\s/im, // "No, use X instead"
    /^don'?t\s/im, // "Don't do that"
    /^stop\s/im, // "Stop doing X"
    /^wrong/im, // "Wrong approach"
    /^that'?s\s+(not|wrong|incorrect)/im, // "That's not right"
    /\binstead\s+use\b/i, // "instead use X"
    /\bnot\s+like\s+that\b/i, // "not like that"
    /\bwhy\s+did\s+you\b/i, // "why did you do X"
    /\byou\s+should(n'?t|\s+not)\b/i, // "you shouldn't" / "you should not"
    /\bthat'?s\s+completely\b/i, // "that's completely wrong"
    /\bi\s+don'?t\s+understand\b/i, // "I don't understand" (signals confusion with output)
  ];

  const matched = correctionPatterns.some((p) => p.test(rawMessage));
  if (!matched) return;

  // Log the correction — /codify will analyze semantically
  logLearningObservation(
    cwd,
    "user_correction",
    { message: rawMessage.substring(0, 500) },
    { session_id: sessionId || "unknown" },
  );
}
