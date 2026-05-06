#!/usr/bin/env node
/**
 * Hook: integration-hygiene
 * Event: PostToolUse
 * Matcher: Edit|Write
 * Purpose: Catch integration-hygiene anti-patterns the moment they land in code.
 *
 *   Detects (WARN, non-blocking):
 *   - Raw SQL strings in non-migration source files (DataFlow bypass)
 *   - MOCK_/FAKE_/DUMMY_/SAMPLE_ frontend constants (hidden stub data)
 *   - Silent-swallow exception handlers (`except: pass`, `catch(e){}`, bare rescue)
 *   - New endpoint handlers with no logger call in the function body
 *   - Raw HTTP client calls (requests./httpx./fetch()) without surrounding log
 *
 * Returns WARN only -- never blocks. Intent is to surface the violation so the
 * agent self-corrects in the same session. Blocking here would break too many
 * legitimate edge cases that the agent rightly ignores.
 *
 * Exit Codes:
 *   0 = success / warn
 *   1 = hook error (e.g. timeout, malformed input)
 */

const fs = require("fs");
const path = require("path");

const TIMEOUT_MS = 3000;
const timeout = setTimeout(() => {
  console.error("[HOOK TIMEOUT] integration-hygiene exceeded 3s limit");
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    const result = checkFile(data);
    console.log(
      JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          validation: result.messages,
        },
      }),
    );
    process.exit(0);
  } catch (error) {
    console.error(`[HOOK ERROR] integration-hygiene: ${error.message}`);
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
});

// ---------------------------------------------------------------------------
// Main check dispatcher
// ---------------------------------------------------------------------------

function checkFile(data) {
  const filePath = data.tool_input?.file_path || "";
  const ext = path.extname(filePath).toLowerCase();

  const sourceExts = [".py", ".rs", ".ts", ".tsx", ".js", ".jsx", ".rb"];
  if (!sourceExts.includes(ext)) return { messages: [] };

  // Skip migration, test, and generated files -- they have legitimate
  // reasons to contain patterns this hook would otherwise flag.
  if (
    /(migrations?\/|tests?\/|__tests__\/|test_|_test\.|\.spec\.|\.test\.)/.test(
      filePath,
    )
  ) {
    return { messages: [] };
  }

  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return { messages: [] }; // file deleted or unreadable; nothing to check
  }

  const messages = [];
  const rel = path.relative(data.cwd || process.cwd(), filePath);

  // 1. Raw SQL strings outside migration files (DataFlow bypass)
  const sqlPattern =
    /["'`](?:\s*)(?:SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\s+/i;
  if (
    sqlPattern.test(content) &&
    !/\/(?:db|infrastructure|dialect)\//.test(filePath)
  ) {
    messages.push({
      severity: "warn",
      rule: "framework-first.md § Work-Domain Binding",
      message: `${rel}: raw SQL string detected. DataFlow (@db.model, db.express) is MANDATORY for all DB work. Consult dataflow-specialist.`,
    });
  }

  // 2. Frontend mock-data constants
  const mockPattern = /\b(MOCK|FAKE|DUMMY|SAMPLE)_[A-Z][A-Z0-9_]*\s*[:=]/;
  if (mockPattern.test(content)) {
    messages.push({
      severity: "warn",
      rule: "zero-tolerance.md Rule 2",
      message: `${rel}: mock/fake/dummy constant detected. Frontend mock data is a stub -- remove before ship.`,
    });
  }

  // 3. Silent exception swallows
  const silentSwallowPatterns = [
    { pat: /except\s*:\s*pass\b/, lang: "Python" },
    {
      pat: /except\s+Exception\s*:\s*(?:pass|return\s+None)\b/,
      lang: "Python",
    },
    { pat: /catch\s*\([^)]*\)\s*\{\s*\}/, lang: "JS/TS" },
    { pat: /rescue\s*(?:=>\s*\w+)?\s*$\s*end/m, lang: "Ruby" },
  ];
  for (const { pat, lang } of silentSwallowPatterns) {
    if (pat.test(content)) {
      messages.push({
        severity: "warn",
        rule: "zero-tolerance.md Rule 3",
        message: `${rel}: silent ${lang} exception swallow. BLOCKED per Rule 3 -- log AND act (retry, fall back, re-raise) or re-raise.`,
      });
      break;
    }
  }

  // 4. Endpoint handlers with no logger call anywhere in the file
  const endpointPattern =
    /(?:@(?:router|app|api)\.(?:get|post|put|patch|delete)|@route|def\s+\w+\s*\(\s*request|async\s+def\s+\w+\s*\(\s*req)/;
  const loggerPattern =
    /(?:logger\.(?:info|warn|warning|error|debug|exception)|structlog\.|Rails\.logger|semantic_logger|tracing::)/;
  if (endpointPattern.test(content) && !loggerPattern.test(content)) {
    messages.push({
      severity: "warn",
      rule: "observability.md § Mandatory Log Points",
      message: `${rel}: endpoint handler detected with no logger call. Every endpoint MUST log entry, exit, and error paths.`,
    });
  }

  // 5. Raw HTTP client calls without any log in the file
  const rawHttpPattern =
    /(?:requests\.(?:get|post|put|patch|delete)|httpx\.(?:get|post|put|patch|delete)|\bfetch\s*\(|urllib\.request)/;
  if (rawHttpPattern.test(content) && !loggerPattern.test(content)) {
    messages.push({
      severity: "warn",
      rule: "framework-first.md § Work-Domain Binding + observability.md",
      message: `${rel}: raw HTTP client call detected with no surrounding log. Outbound integrations MUST log intent + result. Consult nexus-specialist.`,
    });
  }

  return { messages };
}
