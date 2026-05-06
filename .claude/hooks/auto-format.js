#!/usr/bin/env node
/**
 * Hook: auto-format
 * Event: PostToolUse
 * Matcher: Edit|Write
 * Purpose: Auto-format Python, JavaScript, TypeScript files
 *
 * Exit Codes:
 *   0 = success (continue)
 *   2 = blocking error (stop tool execution)
 *   other = non-blocking error (warn and continue)
 */

const fs = require("fs");
const { execFileSync } = require("child_process");
const path = require("path");

// Timeout fallback — prevents hanging the Claude Code session
const TIMEOUT_MS = 10000;
const _timeout = setTimeout(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const result = autoFormat(data);
    console.log(
      JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          formatted: result.formatted,
          formatter: result.formatter,
        },
      }),
    );
    process.exit(0);
  } catch (error) {
    console.error(`[HOOK ERROR] ${error.message}`);
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
});

function autoFormat(data) {
  const filePath = data.tool_input?.file_path;
  const cwd = data.cwd || process.cwd();

  if (!filePath || !fs.existsSync(filePath)) {
    return { formatted: false, formatter: "none" };
  }

  // Validate file is within the project directory to prevent symlink attacks
  const resolvedPath = path.resolve(filePath);
  const resolvedCwd = path.resolve(cwd);
  if (!resolvedPath.startsWith(resolvedCwd)) {
    return { formatted: false, formatter: "path outside project" };
  }

  const ext = path.extname(filePath).toLowerCase();

  try {
    // Python files: black or ruff
    if (ext === ".py") {
      try {
        execFileSync("black", [filePath], { stdio: "pipe" });
        return { formatted: true, formatter: "black" };
      } catch {
        // Try ruff if black not available
        try {
          execFileSync("ruff", ["format", filePath], { stdio: "pipe" });
          return { formatted: true, formatter: "ruff" };
        } catch {
          return { formatted: false, formatter: "none (black/ruff not found)" };
        }
      }
    }

    // JavaScript/TypeScript files: prettier
    if ([".js", ".jsx", ".ts", ".tsx", ".json"].includes(ext)) {
      try {
        execFileSync("npx", ["prettier", "--write", filePath], {
          stdio: "pipe",
        });
        return { formatted: true, formatter: "prettier" };
      } catch {
        return { formatted: false, formatter: "none (prettier not found)" };
      }
    }

    // YAML/Markdown: prettier
    if ([".yaml", ".yml", ".md"].includes(ext)) {
      try {
        execFileSync("npx", ["prettier", "--write", filePath], {
          stdio: "pipe",
        });
        return { formatted: true, formatter: "prettier" };
      } catch {
        return { formatted: false, formatter: "none" };
      }
    }

    return { formatted: false, formatter: "unsupported file type" };
  } catch (error) {
    return { formatted: false, formatter: `error: ${error.message}` };
  }
}
