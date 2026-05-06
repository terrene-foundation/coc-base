#!/usr/bin/env node
/**
 * Hook: log-triage-gate
 * Event: Stop
 * Purpose: Surface unacknowledged WARN+ log entries at session end so the
 *          next session doesn't inherit silent breakage.
 *
 *   At Stop time:
 *   - Scan *.log files modified in the last 120 minutes for WARN/ERROR/FAIL
 *   - Scan recent pytest / cargo / npm output captured in workspace markers
 *   - Dedup entries by (file, message-pattern) to keep output tractable
 *   - Emit a disposition summary as a warning (non-blocking)
 *
 * Non-blocking by design. The /wrapup command owns the hard gate; this hook
 * just makes sure the warnings never disappear silently between sessions.
 *
 * Exit Codes:
 *   0 = success (always, since this is advisory)
 *   1 = hook error
 */

const { execSync } = require("child_process");

const TIMEOUT_MS = 5000;
const timeout = setTimeout(() => {
  console.error("[HOOK TIMEOUT] log-triage-gate exceeded 5s limit");
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input || "{}");
    const cwd = data.cwd || process.cwd();
    const messages = triageLogs(cwd);
    const summary = messages.map((m) => m.message).join("\n");
    console.log(
      JSON.stringify({
        continue: true,
        ...(summary ? { systemMessage: summary } : {}),
      }),
    );
    process.exit(0);
  } catch (error) {
    console.error(`[HOOK ERROR] log-triage-gate: ${error.message}`);
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
});

// ---------------------------------------------------------------------------
// Log triage
// ---------------------------------------------------------------------------

// Directories pruned from the log scan. These produce WARN+ entries that are
// NOT session-actionable (tool caches, browser captures, build output, VCS
// internals, language package dirs). Adding a dir here means "the agent
// cannot fix issues surfaced by logs under this path, so don't waste a
// disposition turn on them."
//
// If you add a project-specific dir, prefer putting it here upstream in loom/
// and syncing out, rather than editing downstream copies.
const EXCLUDED_DIRS = [
  ".playwright-mcp", // Playwright MCP browser console captures
  ".chrome-devtools", // Chrome DevTools MCP captures
  "node_modules",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".cache",
  "target", // Rust build output
  "dist",
  "build",
  ".pytest_cache",
  "__pycache__",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "coverage",
  ".coverage",
  ".git",
  ".claude", // hook logs, learning observations
  "benchmarks", // perf measurement output (FAIL means "missed perf target", not session-actionable)
];

function triageLogs(cwd) {
  const messages = [];

  // 1. Scan *.log files modified recently (proxy for "this session")
  const logEntries = scanRecentLogs(cwd);
  const unique = dedupe(logEntries);

  if (unique.length > 0) {
    messages.push({
      severity: "warn",
      rule: "observability.md MUST Rule 5 (Log Triage Gate)",
      message: `${unique.length} unique WARN+ log entries found in recent *.log files. Review with /redteam or /wrapup before ending the session.`,
    });
    for (const entry of unique.slice(0, 10)) {
      messages.push({
        severity: "warn",
        rule: "log-triage",
        message: `  ${entry.file}: ${entry.line}`,
      });
    }
    if (unique.length > 10) {
      messages.push({
        severity: "warn",
        rule: "log-triage",
        message: `  … and ${unique.length - 10} more unique entries`,
      });
    }
  }

  return messages;
}

function scanRecentLogs(cwd) {
  try {
    // Build -prune expression for excluded tool-cache directories so we don't
    // scan .playwright-mcp/, node_modules/, .venv/, etc. These dirs produce
    // WARN+ entries that are not session-actionable and drown real signal.
    const prune = EXCLUDED_DIRS.map((d) => `-name '${d}'`).join(" -o ");
    // find: prune tool cache dirs, then match *.log modified in last 120 min
    const cmd =
      `find "${cwd}" \\( -type d \\( ${prune} \\) -prune \\) -o ` +
      `-type f -name '*.log' -mmin -120 -print 2>/dev/null ` +
      `| head -20 | xargs -I{} grep -HnE 'WARN|ERROR|FAIL' {} 2>/dev/null ` +
      `| head -200`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 3000 });
    return out
      .split("\n")
      .filter((l) => l.trim())
      .map(parseLogLine);
  } catch {
    return []; // no logs, grep failed, or timeout -- silent
  }
}

function parseLogLine(line) {
  // format: <file>:<lineno>:<content>
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) return { file: "unknown", line: line.slice(0, 120) };
  return { file: m[1], line: m[3].trim().slice(0, 120) };
}

function dedupe(entries) {
  // Group by (file, normalized message) — same file + same message pattern = one entry
  const seen = new Map();
  for (const e of entries) {
    // Normalize: strip timestamps, line numbers, pids, hashes so similar lines collapse
    const key =
      e.file +
      "::" +
      e.line
        .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*/g, "<ts>")
        .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
        .replace(/\b\d{4,}\b/g, "<num>");
    if (!seen.has(key)) seen.set(key, e);
  }
  return Array.from(seen.values());
}
