#!/usr/bin/env node
/**
 * Hook: validate-deployment
 * Event: PostToolUse
 * Matcher: Edit|Write
 * Purpose: Detect cloud credentials and secrets in deployment-related files.
 *
 * Framework-agnostic — works with any project.
 *
 * Exit Codes:
 *   0 = success (continue)
 *   2 = blocking error (stop tool execution)
 */

const TIMEOUT_MS = 10000;
const { instructAndWait } = require("./lib/instruct-and-wait");
const timeout = setTimeout(() => {
  // Mitigates red-team validate-deployment-silent-skip:
  // On timeout, surface halt-and-report so agent knows the credential check
  // DID NOT complete. Old behavior silently allowed continue.
  const out = instructAndWait({
    hookEvent: "PostToolUse",
    severity: "halt-and-report",
    what_happened:
      "validate-deployment hook timed out before completing the credential scan",
    why: "validate-deployment.js — timeout means scan was interrupted; bypassing credential checks is BLOCKED",
    agent_must_report: [
      "State which file was being written when the hook timed out",
      "Manually scan the file for: AWS keys, Azure secrets, GCP SA JSON, private keys, GitHub/PyPI/Docker PATs, sk-* API keys",
      "Confirm in the report whether ANY credential pattern is present in the just-written file",
    ],
    agent_must_wait:
      "Do not commit or proceed with deploy work until manual credential scan is reported.",
    user_summary:
      "validate-deployment timeout — manual credential scan required",
  });
  console.log(JSON.stringify(out.json));
  process.exit(1);
}, TIMEOUT_MS);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    const result = validateDeployment(data);
    // Structured output from credential block (already shaped via instruct-and-wait)
    if (result.output) {
      console.log(JSON.stringify(result.output));
      process.exit(result.exitCode);
      return;
    }
    // Legacy advisory path
    console.log(
      JSON.stringify({
        continue: result.continue,
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          validation: result.message,
        },
      }),
    );
    process.exit(result.exitCode);
  } catch (error) {
    console.error(`[HOOK ERROR] ${error.message}`);
    const out = instructAndWait({
      hookEvent: "PostToolUse",
      severity: "halt-and-report",
      what_happened: `validate-deployment hook errored: ${error.message}`,
      why: "validate-deployment.js — hook error means scan did not complete",
      agent_must_report: [
        "State the file being processed when the hook errored",
        "Manually scan that file for credential patterns; report findings",
      ],
      agent_must_wait: "Do not commit or proceed until manual scan reported.",
      user_summary: "validate-deployment hook error — manual scan required",
    });
    console.log(JSON.stringify(out.json));
    process.exit(1);
  }
});

function validateDeployment(data) {
  const filePath = data.tool_input?.file_path || "";
  const content = data.tool_input?.content || data.tool_input?.new_string || "";

  // Only check deployment-related files
  const deploymentFiles = [
    /deploy\//,
    /Dockerfile/i,
    /docker-compose/i,
    /\.ya?ml$/,
    /terraform/i,
    /\.tf$/,
    /k8s\//,
    /kubernetes\//,
    /\.github\/workflows\//,
    /Makefile/i,
  ];

  const isDeploymentFile = deploymentFiles.some((p) => p.test(filePath));
  if (!isDeploymentFile) {
    return { continue: true, exitCode: 0, message: "Not a deployment file" };
  }

  // CHECK 1: Cloud credential patterns — BLOCK
  const credentialPatterns = [
    // AWS Access Key ID
    {
      pattern: /AKIA[0-9A-Z]{16}/,
      message: "BLOCKED: AWS Access Key ID detected",
    },
    // AWS Secret Access Key (broad context match)
    {
      pattern: /[0-9a-zA-Z/+]{40}(?=\s|"|'|$)/,
      context:
        /aws_secret|AWS_SECRET|secret_access_key|SecretAccessKey|AKIA[0-9A-Z]{16}/i,
      message: "BLOCKED: Possible AWS Secret Access Key detected",
    },
    // Azure Storage Account Key
    {
      pattern: /AccountKey=[^;]{20,}/,
      message: "BLOCKED: Azure Storage Account Key detected",
    },
    // Azure Client Secret
    {
      pattern:
        /AZURE_CLIENT_SECRET\s*[:=]\s*["'][^"']+["']|client_secret\s*[:=]\s*["'][0-9a-zA-Z~._-]{30,}["']/,
      message: "BLOCKED: Azure Client Secret detected",
    },
    // GCP Service Account JSON
    {
      pattern: /"type"\s*:\s*"service_account"/,
      message: "BLOCKED: GCP Service Account JSON detected",
    },
    // Private keys
    {
      pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
      message: "BLOCKED: Private key detected in deployment file",
    },
    // GitHub PATs (classic and fine-grained)
    {
      pattern: /ghp_[0-9a-zA-Z]{36}|github_pat_[0-9a-zA-Z_]{22,}/,
      message: "BLOCKED: GitHub Personal Access Token detected",
    },
    // PyPI API tokens
    {
      pattern: /pypi-[0-9a-zA-Z_-]{50,}/,
      message: "BLOCKED: PyPI API token detected",
    },
    // Docker Hub tokens
    {
      pattern: /dckr_pat_[0-9a-zA-Z_-]{20,}/,
      message: "BLOCKED: Docker Hub token detected",
    },
    // Generic API secret keys (OpenAI, Anthropic, Stripe, etc.)
    {
      pattern: /sk-[a-zA-Z0-9]{20,}/,
      message: "BLOCKED: API secret key pattern detected",
    },
  ];

  for (const { pattern, context, message } of credentialPatterns) {
    if (pattern.test(content)) {
      if (context && !context.test(content)) continue;
      // PostToolUse: file already written. Surface halt-and-report so agent
      // immediately scrubs the secret before any downstream commit/push.
      const out = instructAndWait({
        hookEvent: "PostToolUse",
        severity: "halt-and-report",
        what_happened: `Credential pattern detected in ${filePath}: ${message}`,
        why: "security.md No-Hardcoded-Secrets — credentials in deploy files leak into git history",
        agent_must_report: [
          `State the exact line number(s) where the pattern matched`,
          `Quote the pattern (redact the value if it's a real secret) for the user`,
          `Propose: remove the literal value, replace with env-var reference, scrub from git index if already staged`,
          `Confirm whether this credential was authentic or a false-positive (e.g., test fixture)`,
        ],
        agent_must_wait:
          "Do not commit or push. Do not proceed with the next file. Wait for user instruction.",
        user_summary: message,
      });
      return { output: out.json, exitCode: out.exitCode };
    }
  }

  // CHECK 2: Plaintext passwords in config — WARN
  const passwordPatterns = [
    /password\s*[:=]\s*["'][^"']{3,}["']/i,
    /POSTGRES_PASSWORD\s*[:=]\s*["'][^"']{3,}["']/i,
    /REDIS_PASSWORD\s*[:=]\s*["'][^"']{3,}["']/i,
    /DB_PASSWORD\s*[:=]\s*["'][^"']{3,}["']/i,
  ];

  const warnings = [];
  for (const pattern of passwordPatterns) {
    if (pattern.test(content)) {
      warnings.push(
        "WARNING: Plaintext password detected. Use secrets manager in production.",
      );
      break;
    }
  }

  // CHECK 3: Dockerfile best practices — WARN
  if (/Dockerfile/i.test(filePath)) {
    // Skip COPY . . check for multi-stage COPY --from patterns
    if (
      /COPY\s+\.\s+\./.test(content) &&
      !content.includes(".dockerignore") &&
      !/COPY\s+--from=/.test(content)
    ) {
      warnings.push(
        "WARNING: COPY . . without .dockerignore may include secrets or unnecessary files.",
      );
    }
    if (!/USER\s+\w+/.test(content) && !/FROM\s+scratch/i.test(content)) {
      warnings.push("WARNING: No USER directive — container will run as root.");
    }
    if (!/HEALTHCHECK/.test(content)) {
      warnings.push("WARNING: No HEALTHCHECK directive.");
    }
  }

  if (warnings.length > 0) {
    return {
      continue: true,
      exitCode: 0,
      message: warnings.join(" | "),
    };
  }

  return { continue: true, exitCode: 0, message: "Deployment file validated" };
}
