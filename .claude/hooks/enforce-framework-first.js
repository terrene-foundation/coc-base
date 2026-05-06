#!/usr/bin/env node
/**
 * Hook: enforce-framework-first
 * Event: PostToolUse
 * Matcher: Write, Edit
 * Purpose: Block raw library imports when a Kailash Engine/framework exists.
 *          CC sees the block reason, rewrites using the framework, continues autonomously.
 *
 * Exit Codes:
 *   0 = success (continue)
 *   2 = blocking error (stop tool execution)
 */

const TIMEOUT_MS = 5000;
const timeout = setTimeout(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);

const { instructAndWait } = require("./lib/instruct-and-wait");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    const result = checkForRawFrameworks(data);
    console.log(JSON.stringify(result.output));
    process.exit(result.exitCode);
  } catch (error) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
});

const BLOCKED_IMPORTS = [
  // ── Nexus: API endpoints, web services, HTTP servers ──
  {
    patterns: [
      /\bfrom\s+fastapi\s+import\b/,
      /\bimport\s+fastapi\b/,
      /\bfrom\s+flask\s+import\b/,
      /\bimport\s+flask\b/,
      /\bfrom\s+starlette\b/,
      /\bimport\s+starlette\b/,
      /\bfrom\s+aiohttp\s+import\b/,
      /\bimport\s+aiohttp\b/,
      /\bfrom\s+sanic\s+import\b/,
      /\bimport\s+sanic\b/,
    ],
    framework: "Nexus",
    specialist: "nexus-specialist",
    guide: ".claude/skills/03-nexus/nexus-for-fastapi-users.md",
    reason:
      "Use Nexus for all API endpoints, web services, HTTP servers. " +
      "Nexus() gives you API + CLI + MCP from a single handler registration. " +
      "Consult nexus-specialist or read the translation guide.",
  },

  // ── DataFlow: database, SQL, ORM ──
  {
    patterns: [
      /\bfrom\s+sqlalchemy\s+import\b/,
      /\bimport\s+sqlalchemy\b/,
      /\bfrom\s+psycopg2?\s+import\b/,
      /\bimport\s+psycopg2?\b/,
      /\bfrom\s+asyncpg\s+import\b/,
      /\bimport\s+asyncpg\b/,
      /\bimport\s+sqlite3\b/,
      /\bfrom\s+sqlite3\s+import\b/,
      /\bfrom\s+django\.db\s+import\b/,
      /\bfrom\s+peewee\s+import\b/,
      /\bimport\s+peewee\b/,
      /\bfrom\s+tortoise\s+import\b/,
      /\bimport\s+tortoise\b/,
      /\bfrom\s+sqlmodel\s+import\b/,
      /\bimport\s+sqlmodel\b/,
      /\bfrom\s+databases\s+import\b/,
      /\bimport\s+databases\b/,
    ],
    framework: "DataFlow",
    specialist: "dataflow-specialist",
    guide: ".claude/skills/02-dataflow/SKILL.md",
    reason:
      "Use DataFlow for all database operations. " +
      "DataFlowEngine.builder() for production, db.express for CRUD, @db.model for schemas. " +
      "Consult dataflow-specialist.",
  },

  // ── Kaizen: LLM calls, agents, completions ──
  {
    patterns: [
      /\bfrom\s+openai\s+import\b/,
      /\bimport\s+openai\b/,
      /\bfrom\s+anthropic\s+import\b/,
      /\bimport\s+anthropic\b/,
      /\bfrom\s+google\.generativeai\b/,
      /\bimport\s+google\.generativeai\b/,
      /\bfrom\s+litellm\s+import\b/,
      /\bimport\s+litellm\b/,
      /\bfrom\s+langchain\b/,
      /\bimport\s+langchain\b/,
      /\bfrom\s+llama_index\b/,
      /\bimport\s+llama_index\b/,
      /\bfrom\s+dspy\b/,
      /\bimport\s+dspy\b/,
    ],
    framework: "Kaizen",
    specialist: "kaizen-specialist",
    guide: ".claude/skills/04-kaizen/SKILL.md",
    reason:
      "Use Kaizen for all LLM calls, agents, and AI work. " +
      "Delegate for autonomous agents, BaseAgent + Signature for custom logic. " +
      "Consult kaizen-specialist.",
  },

  // ── ML: classical/deep learning ──
  {
    patterns: [
      /\bfrom\s+sklearn\b/,
      /\bimport\s+sklearn\b/,
      /\bfrom\s+xgboost\s+import\b/,
      /\bimport\s+xgboost\b/,
      /\bfrom\s+lightgbm\s+import\b/,
      /\bimport\s+lightgbm\b/,
      /\bfrom\s+catboost\s+import\b/,
      /\bimport\s+catboost\b/,
      /\bfrom\s+torch\s+import\b/,
      /\bimport\s+torch\b/,
      /\bfrom\s+tensorflow\s+import\b/,
      /\bimport\s+tensorflow\b/,
    ],
    framework: "Kailash ML",
    specialist: "ml-specialist",
    guide: ".claude/skills/34-kailash-ml/SKILL.md",
    reason:
      "Use Kailash ML for all ML training, inference, and feature work. " +
      "AutoMLEngine for end-to-end, FeatureStore + ModelRegistry + TrainingPipeline for control. " +
      "Consult ml-specialist.",
  },

  // ── Align: LLM fine-tuning, LoRA, alignment ──
  {
    patterns: [
      /\bfrom\s+transformers\s+import\b/,
      /\bimport\s+transformers\b/,
      /\bfrom\s+peft\s+import\b/,
      /\bimport\s+peft\b/,
      /\bfrom\s+trl\s+import\b/,
      /\bimport\s+trl\b/,
    ],
    framework: "Kailash Align",
    specialist: "align-specialist",
    guide: ".claude/skills/35-kailash-align/SKILL.md",
    reason:
      "Use Kailash Align for all fine-tuning, LoRA, and alignment work. " +
      "align.train() + align.deploy() for end-to-end. " +
      "Consult align-specialist.",
  },
];

function checkForRawFrameworks(data) {
  const filePath = data.tool_input?.file_path || "";
  const content = data.tool_input?.content || data.tool_input?.new_string || "";

  if (!content || !filePath) {
    return { output: { continue: true }, exitCode: 0 };
  }

  if (isExcluded(filePath)) {
    return { output: { continue: true }, exitCode: 0 };
  }

  for (const group of BLOCKED_IMPORTS) {
    for (const pattern of group.patterns) {
      if (pattern.test(content)) {
        const lib = content.match(pattern)?.[0] || "raw import";
        // PostToolUse: file already written. Use halt-and-report — agent must
        // surface and rewrite using the framework. Per red-team CRIT-1, block
        // semantics are post-hoc here; we cannot un-do the write.
        const out = instructAndWait({
          hookEvent: "PostToolUse",
          severity: "halt-and-report",
          what_happened: `Raw library import \`${lib}\` written to ${filePath}`,
          why: `framework-first.md — Use ${group.framework} (${group.specialist}). Guide: ${group.guide}`,
          agent_must_report: [
            `Quote the exact import line that was just written`,
            `State the equivalent ${group.framework} pattern (consult ${group.specialist} or read the guide)`,
            `Propose the rewrite as a unified diff in your next response`,
          ],
          agent_must_wait: `Do not commit or proceed with related work until the file is rewritten using ${group.framework}.`,
          user_summary: `Raw ${group.framework} import in ${filePath.split("/").pop()} — agent must rewrite`,
        });
        return { output: out.json, exitCode: out.exitCode };
      }
    }
  }

  return { output: { continue: true }, exitCode: 0 };
}

function isExcluded(filePath) {
  // Test files — raw imports allowed for testing
  if (
    /[\\/]tests?[\\/]/.test(filePath) ||
    /[\\/]__tests__[\\/]/.test(filePath) ||
    /\.test\.[jt]sx?$/.test(filePath) ||
    /\.spec\.[jt]sx?$/.test(filePath) ||
    /test_[^/\\]+\.py$/.test(filePath) ||
    /[^/\\]+_test\.py$/.test(filePath) ||
    /conftest\.py$/.test(filePath)
  )
    return true;

  // Config, docs, hooks, artifacts — not application code
  if (
    /[\\/]hooks[\\/]/.test(filePath) ||
    /[\\/]\.claude[\\/]/.test(filePath) ||
    /\.md$/.test(filePath) ||
    /\.ya?ml$/.test(filePath) ||
    /\.toml$/.test(filePath) ||
    /\.json$/.test(filePath)
  )
    return true;

  // BUILD repo — only the adapter/backend/transport/store layer uses raw imports.
  // Engines, features, API, servers MUST use the SDK's own primitives.
  if (
    /[\\/]adapters[\\/]/.test(filePath) ||
    /[\\/]backends[\\/]/.test(filePath) ||
    /[\\/]transports[\\/]/.test(filePath) ||
    /[\\/]providers[\\/]/.test(filePath) ||
    /[\\/]drivers[\\/]/.test(filePath) ||
    /[\\/]middleware[\\/]database[\\/]/.test(filePath) ||
    /[\\/]middleware[\\/]gateway[\\/]event_store/.test(filePath) ||
    /[\\/]trust[\\/].*store/.test(filePath) ||
    /[\\/]trust[\\/]constraints[\\/]/.test(filePath) ||
    /[\\/]trust[\\/]enforce[\\/]/.test(filePath) ||
    /[\\/]crates[\\/]/.test(filePath) ||
    /[\\/]src[\\/]lib\.rs$/.test(filePath) ||
    /[\\/]src[\\/]main\.rs$/.test(filePath)
  )
    return true;

  return false;
}
