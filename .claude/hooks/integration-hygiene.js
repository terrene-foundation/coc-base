#!/usr/bin/env node
/**
 * @hook-event: PostToolUse:Edit|NotebookEdit|Write (verification) — the edited source exists on disk for advisory code-pattern checks.
 *
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
 * Every check reads CODE, not prose: lib/source-code-view.js::codeView blanks
 * comments and docstrings (and, for the syntax checks, string literal bodies)
 * without moving any line, so the shapes listed above in this very comment do
 * not fire, and reported line numbers are the file's own.
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
const { findRawSqlStatement } = require("./lib/raw-sql-shape");
const { codeView, languageForPath } = require("./lib/source-code-view");

const TIMEOUT_MS = 3000;
let timeout = null;

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  timeout = setTimeout(() => {
    console.error("[HOOK TIMEOUT] integration-hygiene exceeded 3s limit");
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }, TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      try {
        onStdinEnd(input);
      } catch (e) {
        return reject(e);
      }
      resolve();
    });
  });
}

function onStdinEnd(input) {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    const result = process.env.COC_RUNTIME === "codex" ? checkCodexEdits(data) : checkFile(data);
    // Surface advisories to the agent via additionalContext — the delivered
    // PostToolUse field; the prior `validation` sibling was silently dropped
    // (loom #466). Render the message objects to text; emit no context block
    // when there are no advisories.
    const out = process.env.COC_RUNTIME === "codex" ? {} : { continue: true };
    if (Array.isArray(result.messages) && result.messages.length) {
      out.hookSpecificOutput = {
        hookEventName: "PostToolUse",
        additionalContext: result.messages
          .map((m) => (m && m.message ? `[${m.rule}] ${m.message}` : String(m)))
          .join("\n"),
      };
    }
    console.log(JSON.stringify(out));
    process.exit(0);
  } catch (error) {
    console.error(`[HOOK ERROR] integration-hygiene: ${error.message}`);
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main check dispatcher
// ---------------------------------------------------------------------------

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

// Codex edit hooks expose native patch text rather than a CC file_path. Inspect
// the resulting destinations on disk; never interpret Bash writes. Canonical
// containment is a static check, not protection against hostile path races.
const CODEX_MAX_TARGETS = 100;
const CODEX_MAX_FILE_BYTES = 1024 * 1024;
function checkCodexEdits(data) {
  const skipped = (reason) => ({ rule: "integration-hygiene", message: `Post-edit scan skipped: ${reason}` });
  let root;
  try { root = fs.realpathSync(path.resolve(__dirname, "../..")); }
  catch (error) { return { messages: [skipped(`installed root unavailable (${error.code || error.message})`)] }; }
  const targets = [];
  if (data.tool_name === "apply_patch") {
    const command = data.tool_input?.command;
    if (typeof command !== "string") return { messages: [skipped("apply_patch command must be a string")] };
    let pending = null;
    for (const line of command.split(/\r?\n/)) {
      const entry = /^\*\*\* (Add File|Update File|Delete File): (.+)$/.exec(line);
      if (entry) {
        if (pending) targets.push(pending);
        pending = entry[1] === "Delete File" ? null : entry[2].trim();
      } else if (line.startsWith("*** Move to: ") && pending) {
        pending = line.slice("*** Move to: ".length).trim();
      }
      if (targets.length > CODEX_MAX_TARGETS) break;
    }
    if (pending) targets.push(pending);
  } else if (["Edit", "Write", "NotebookEdit"].includes(data.tool_name)) {
    const target = data.tool_input?.file_path || data.tool_input?.notebook_path;
    if (typeof target === "string" && target) targets.push(target);
  } else {
    return { messages: [skipped(`unsupported tool ${String(data.tool_name)}; shell-generated writes are not inspected`)] };
  }
  if (!targets.length) return { messages: [skipped("no inspectable edit destinations")] };
  if (targets.length > CODEX_MAX_TARGETS) return { messages: [skipped(`target count exceeds ${CODEX_MAX_TARGETS}; no files inspected`)] };
  const messages = [];
  const seen = new Set();
  for (const target of targets) {
    let file;
    let fd;
    try {
      file = fs.realpathSync(path.resolve(data.cwd || root, target));
      const relative = path.relative(root, file);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        messages.push(skipped(`${target}: outside installed repository`)); continue;
      }
      if (seen.has(file)) continue;
      seen.add(file);
      if (!fs.statSync(file).isFile()) { messages.push(skipped(`${target}: not a regular file`)); continue; }
      fd = fs.openSync(file, "r");
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) { messages.push(skipped(`${target}: not a regular file`)); continue; }
      if (stat.size > CODEX_MAX_FILE_BYTES) { messages.push(skipped(`${target}: exceeds 1 MiB limit`)); continue; }
      const buffer = Buffer.alloc(CODEX_MAX_FILE_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
        if (!count) break;
        bytes += count;
      }
      if (bytes > CODEX_MAX_FILE_BYTES) { messages.push(skipped(`${target}: exceeds 1 MiB limit`)); continue; }
      messages.push(...checkFile({ ...data, tool_input: { file_path: file } }, buffer.subarray(0, bytes).toString("utf8")).messages);
    } catch (error) {
      messages.push(skipped(`${target}: ${error.code || error.message}`));
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return { messages };
}

function checkFile(data, suppliedContent) {
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
    content = suppliedContent === undefined ? fs.readFileSync(filePath, "utf8") : suppliedContent;
  } catch {
    return { messages: [] }; // file deleted or unreadable; nothing to check
  }

  const messages = [];
  const rel = path.relative(data.cwd || process.cwd(), filePath);

  // Two same-length views of the file (lib/source-code-view.js::codeView):
  //   code   — comments + docstrings blanked, string literals kept (SQL lives there)
  //   syntax — string/regex literal bodies blanked too, for purely syntactic shapes
  const lang = languageForPath(filePath);
  const code = codeView(content, lang);
  const syntax = codeView(content, lang, { maskStrings: true });

  // 1. Raw SQL strings outside migration files (DataFlow bypass). Matched by SQL
  //    STATEMENT SHAPE via lib/raw-sql-shape.js::findRawSqlStatement — the prior
  //    keyword-prefix regex fired on English ("Update __init__.py before release!").
  const sql = /\/(?:db|infrastructure|dialect)\//.test(filePath)
    ? null
    : findRawSqlStatement(code);
  if (sql) {
    messages.push({
      severity: "warn",
      rule: "framework-first.md § Work-Domain Binding",
      message: `${rel}:${sql.line}: raw SQL string detected (${sql.shape}). DataFlow (@db.model, db.express) is MANDATORY for all DB work. Consult dataflow-specialist.`,
    });
  }

  // 2. Frontend mock-data constants
  const mock = /\b(MOCK|FAKE|DUMMY|SAMPLE)_[A-Z][A-Z0-9_]*\s*[:=]/.exec(syntax);
  if (mock) {
    messages.push({
      severity: "warn",
      rule: "zero-tolerance.md Rule 2",
      message: `${rel}:${lineAt(syntax, mock.index)}: mock/fake/dummy constant detected. Frontend mock data is a stub -- remove before ship.`,
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
  for (const { pat, lang: swallowLang } of silentSwallowPatterns) {
    const m = pat.exec(syntax);
    if (m) {
      messages.push({
        severity: "warn",
        rule: "zero-tolerance.md Rule 3",
        message: `${rel}:${lineAt(syntax, m.index)}: silent ${swallowLang} exception swallow. BLOCKED per Rule 3 -- log AND act (retry, fall back, re-raise) or re-raise.`,
      });
      break;
    }
  }

  // 4. Endpoint handlers with no logger call anywhere in the file
  const endpointPattern =
    /(?:@(?:router|app|api)\.(?:get|post|put|patch|delete)|@route|def\s+\w+\s*\(\s*request|async\s+def\s+\w+\s*\(\s*req)/;
  const loggerPattern =
    /(?:logger\.(?:info|warn|warning|error|debug|exception)|structlog\.|Rails\.logger|semantic_logger|tracing::)/;
  const hasLogger = loggerPattern.test(syntax);
  const endpoint = endpointPattern.exec(syntax);
  if (endpoint && !hasLogger) {
    messages.push({
      severity: "warn",
      rule: "observability.md § Mandatory Log Points",
      message: `${rel}:${lineAt(syntax, endpoint.index)}: endpoint handler detected with no logger call. Every endpoint MUST log entry, exit, and error paths.`,
    });
  }

  // 5. Raw HTTP client calls without any log in the file
  const rawHttpPattern =
    /(?:requests\.(?:get|post|put|patch|delete)|httpx\.(?:get|post|put|patch|delete)|\bfetch\s*\(|urllib\.request)/;
  const http = rawHttpPattern.exec(syntax);
  if (http && !hasLogger) {
    messages.push({
      severity: "warn",
      rule: "framework-first.md § Work-Domain Binding + observability.md",
      message: `${rel}:${lineAt(syntax, http.index)}: raw HTTP client call detected with no surrounding log. Outbound integrations MUST log intent + result. Consult nexus-specialist.`,
    });
  }

  return { messages };
}

module.exports = { hookMain, checkCodexEdits };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
