/**
 * Shared utility: Environment variable parsing and model-key validation.
 *
 * Used by session-start.js, validate-workflow.js, and user-prompt-rules-reminder.js.
 * Framework-agnostic — works with any Kailash project.
 */

const fs = require("fs");
const path = require("path");

// =========================================================================
// Model → Provider → Required API Key mapping
// =========================================================================

const MODEL_PROVIDERS = [
  {
    provider: "OpenAI",
    prefixes: [
      "gpt-",
      "o1-",
      "o3-",
      "o4-",
      "chatgpt-",
      "dall-e",
      "whisper",
      "tts-",
      "text-embedding",
    ],
    keys: ["OPENAI_API_KEY"],
  },
  {
    provider: "Anthropic",
    prefixes: ["claude-"],
    keys: ["ANTHROPIC_API_KEY", "ANTROPIC_API_KEY"], // Intentional: common misspelling fallback
  },
  {
    provider: "Google",
    prefixes: ["gemini-", "models/gemini", "palm-"],
    keys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  },
  {
    provider: "DeepSeek",
    prefixes: ["deepseek-"],
    keys: ["DEEPSEEK_API_KEY"],
  },
  {
    provider: "Mistral",
    prefixes: ["mistral-", "mixtral-", "codestral-", "pixtral-"],
    keys: ["MISTRAL_API_KEY"],
  },
  {
    provider: "Cohere",
    prefixes: ["command-", "embed-", "rerank-"],
    keys: ["COHERE_API_KEY"],
  },
  {
    provider: "Perplexity",
    prefixes: ["pplx-", "sonar-"],
    keys: ["PERPLEXITY_API_KEY"],
  },
  {
    provider: "Hume",
    prefixes: ["hume-"],
    keys: ["HUME_API_KEY"],
  },
];

/**
 * Identify the provider and required API key(s) for a model name.
 *
 * @param {string} modelName - e.g. "gpt-5-2025-08-07", "claude-3-opus"
 * @returns {{ provider: string, keys: string[] } | null}
 */
function getModelProvider(modelName) {
  if (!modelName) return null;
  const m = modelName.toLowerCase();

  for (const entry of MODEL_PROVIDERS) {
    for (const prefix of entry.prefixes) {
      if (m.startsWith(prefix)) {
        return { provider: entry.provider, keys: entry.keys };
      }
    }
  }
  return null;
}

// =========================================================================
// .env file parsing
// =========================================================================

/**
 * Parse a .env file into a key-value object.
 * Handles comments, quoted values, and blank lines.
 *
 * @param {string} envPath - Absolute path to .env file
 * @returns {Object<string, string>}
 */
function parseEnvFile(envPath) {
  const config = {};
  try {
    const content = fs.readFileSync(envPath, "utf8");
    for (const raw of content.split("\n")) {
      let line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      // Handle `export VAR=value` syntax
      if (line.startsWith("export ")) {
        line = line.substring(7).trim();
      }
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.substring(0, eq).trim();
      let val = line.substring(eq + 1).trim();
      // Strip surrounding quotes
      const isQuoted =
        (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2);
      if (isQuoted) {
        val = val.slice(1, -1);
      } else {
        // Strip inline comments for unquoted values (e.g. "value # comment")
        const commentIdx = val.indexOf(" #");
        if (commentIdx > -1) val = val.substring(0, commentIdx).trim();
      }
      config[key] = val;
    }
  } catch {
    // Silently return empty if file can't be read
  }
  return config;
}

// =========================================================================
// Discover models & keys from parsed env
// =========================================================================

/**
 * Scan env config for all *_MODEL and *_API_KEY variables.
 *
 * @param {Object} env - Parsed env object
 * @returns {{ models: Object, keys: Object, validations: Array }}
 */
function discoverModelsAndKeys(env) {
  const models = {};
  const keys = {};

  for (const [k, v] of Object.entries(env)) {
    if (k.endsWith("_MODEL") || k === "DEFAULT_LLM_MODEL") {
      models[k] = v;
    }
    if (k.endsWith("_API_KEY") || k.endsWith("_SECRET")) {
      keys[k] = v ? "present" : "empty";
    }
  }

  // Validate each model has a corresponding key
  const validations = [];
  for (const [varName, modelName] of Object.entries(models)) {
    const info = getModelProvider(modelName);
    if (!info) {
      validations.push({
        model: varName,
        modelName,
        status: "unknown_provider",
        message: `Unknown provider for ${modelName}`,
      });
      continue;
    }

    const hasKey = info.keys.some((k) => env[k] && env[k].length > 5);
    validations.push({
      model: varName,
      modelName,
      provider: info.provider,
      requiredKeys: info.keys,
      hasKey,
      status: hasKey ? "ok" : "MISSING_KEY",
      message: hasKey
        ? `${info.provider} key found for ${modelName}`
        : `MISSING: ${info.keys.join(" or ")} required for ${modelName}`,
    });
  }

  return { models, keys, validations };
}

// =========================================================================
// .env creation from .env.example
// =========================================================================

/**
 * If .env does not exist, create one from .env.example or generate a minimal template.
 *
 * @param {string} cwd - Project working directory
 * @returns {{ created: boolean, source: string }}
 */
function ensureEnvFile(cwd) {
  const envPath = path.join(cwd, ".env");
  if (fs.existsSync(envPath)) {
    return { created: false, source: "existing" };
  }

  // Try copying from .env.example
  const examplePath = path.join(cwd, ".env.example");
  if (fs.existsSync(examplePath)) {
    try {
      fs.copyFileSync(examplePath, envPath);
      return { created: true, source: ".env.example" };
    } catch {
      // Fall through to template creation
    }
  }

  // Generate minimal template
  const template = [
    "# Auto-generated .env template",
    "# Fill in your API keys below",
    "",
    "# LLM Configuration",
    "# OPENAI_API_KEY=sk-your-key-here",
    "# OPENAI_PROD_MODEL=gpt-4o",
    "# OPENAI_DEV_MODEL=gpt-4o-mini",
    "# DEFAULT_LLM_MODEL=gpt-4o",
    "",
    "# ANTHROPIC_API_KEY=sk-ant-your-key-here",
    "# GOOGLE_API_KEY=your-key-here",
    "",
    "# Database",
    "# DATABASE_URL=postgresql://user:pass@localhost:5432/dbname",
    "",
    "# Authentication",
    "# JWT_SECRET_KEY=change-this-to-a-random-string",
    "",
  ].join("\n");

  try {
    fs.writeFileSync(envPath, template);
    return { created: true, source: "template" };
  } catch {
    return { created: false, source: "failed" };
  }
}

// =========================================================================
// Compact summary for hook output (survives context compression)
// =========================================================================

/**
 * Build a terse summary string for injection into conversation context.
 *
 * @param {Object} env - Parsed env
 * @param {{ models: Object, keys: Object, validations: Array }} discovery
 * @returns {string}
 */
function buildCompactSummary(env, discovery) {
  const parts = [];

  // Models line
  const modelParts = Object.entries(discovery.models)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  if (modelParts) parts.push(`Models: ${modelParts}`);

  // Key status line
  const failures = discovery.validations.filter(
    (v) => v.status === "MISSING_KEY",
  );
  if (failures.length > 0) {
    parts.push(`MISSING KEYS: ${failures.map((f) => f.message).join("; ")}`);
  } else if (discovery.validations.length > 0) {
    parts.push("All model-key pairings validated");
  }

  return parts.join(" | ");
}

module.exports = {
  MODEL_PROVIDERS,
  getModelProvider,
  parseEnvFile,
  discoverModelsAndKeys,
  ensureEnvFile,
  buildCompactSummary,
};
