#!/usr/bin/env node
/**
 * Hook: validate-bash-command
 * Event: PreToolUse
 * Matcher: Bash
 * Purpose: Block dangerous commands, suggest tmux for long-running,
 *          ENFORCE .env loading for pytest/python commands
 *
 * Framework-agnostic — works with any Kailash project.
 *
 * Exit Codes:
 *   0 = success (continue)
 *   2 = blocking error (stop tool execution)
 *   other = non-blocking error (warn and continue)
 */

const fs = require("fs");
const path = require("path");
const {
  logObservation: logLearningObservation,
} = require("./lib/learning-utils");
const { instructAndWait } = require("./lib/instruct-and-wait");

// Timeout handling for PreToolUse hooks (5 second limit)
const TIMEOUT_MS = 5000;
const timeout = setTimeout(() => {
  console.error("[HOOK TIMEOUT] validate-bash-command exceeded 5s limit");
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
    const result = validateBashCommand(data);
    // If result is structured for instruct-and-wait, use canonical shape
    if (result.severity) {
      const out = instructAndWait({
        hookEvent: "PreToolUse",
        severity: result.severity,
        what_happened: result.what_happened,
        why: result.why,
        agent_must_report: result.agent_must_report,
        agent_must_wait: result.agent_must_wait,
        user_summary: result.user_summary,
      });
      console.log(JSON.stringify(out.json));
      process.exit(out.exitCode);
    }
    // Legacy advisory path
    console.log(
      JSON.stringify({
        continue: result.continue,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          validation: result.message,
        },
      }),
    );
    process.exit(result.exitCode);
  } catch (error) {
    console.error(`[HOOK ERROR] ${error.message}`);
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
});

function validateBashCommand(data) {
  const command = data.tool_input?.command || "";
  const cwd = data.cwd || process.cwd();

  // ADVISORY (loom #19 P3): branch-scope warn on `git commit` invocations.
  // Delegates to .claude/hooks/pre-commit-branch-scope.js which always
  // exits 0 and writes any out-of-scope advisory to stderr. Warn-only.
  if (/^\s*git\s+commit\b/.test(command)) {
    try {
      const { spawnSync } = require("child_process");
      const scopeScript = path.join(__dirname, "pre-commit-branch-scope.js");
      const r = spawnSync("node", [scopeScript], {
        cwd,
        encoding: "utf8",
        timeout: 4500,
      });
      const output = (r.stderr || "").trim();
      if (output) {
        return { continue: true, exitCode: 0, message: output };
      }
    } catch {
      // Advisory failure must never block the commit.
    }
  }

  // BLOCK: Three-layer Bash mutation detection against trust-posture state files.
  // Mitigates the gap where `permissions.deny` on Edit/Write is bypassable via
  // bash redirects, file utils, or interpreter -c/-e/-m bodies. Pattern adopted
  // from tpc_cash_treasury state-file-write-guard (issue #25, c0aeff73).
  //
  // Protected paths: .claude/learning/posture.json, posture.json.bak,
  // violations.jsonl, violations.jsonl.*, .initialized
  //
  // Commit-message exception: `git commit -m "..."` or `git commit -F path`
  // bodies are documentation prose, not executable commands. Skip detection
  // entirely for those (segment-anchor isn't sufficient — the body can span
  // many lines containing arbitrary shell-like syntax as documentation).
  const STATE_PATH_RX =
    /\.claude\/learning\/(?:posture\.json(?:\.bak|\.tmp\.\d+)?|violations\.jsonl(?:\.[A-Za-z0-9_-]+)?|\.initialized)\b/;
  const isGitCommitWithBody = /^\s*git\s+commit\b[^|;]*(?:\s-m\s|\s-F\s)/.test(
    command,
  );
  const stateFileMutation = isGitCommitWithBody
    ? null
    : detectStateFileMutation(command, STATE_PATH_RX);
  if (stateFileMutation) {
    try {
      logLearningObservation(cwd, "rule_violation", {
        rule: "trust-posture/state-file-mutation",
        layer: stateFileMutation.layer,
      });
    } catch {}
    return {
      severity: "block",
      what_happened: `Bash command attempts to mutate trust-posture state file (Layer ${stateFileMutation.layer}: ${stateFileMutation.kind}): ${command.slice(0, 120)}`,
      why: "trust-posture/state-file-mutation — state files (posture.json, violations.jsonl, .initialized) are owned by hooks; agent edits are BLOCKED",
      agent_must_report: [
        "Quote the exact bash command that was attempted",
        "State whether you intended to read, debug, or modify the state",
        "If reading: use `cat` (allowed); if modifying: use /posture command instead",
      ],
      agent_must_wait:
        "Do not retry. State-file mutations route through the /posture command (challenge-nonce gated), never directly.",
      user_summary: `state-file mutation blocked (Layer ${stateFileMutation.layer})`,
    };
  }

  // BLOCK: Dangerous commands (with evasion-resistant patterns)
  const dangerousPatterns = [
    {
      pattern: /rm\s+(-[rRf]+\s+)*\/($|\s|\*)/,
      message: "Blocked: rm on root filesystem",
    },
    {
      pattern: /rm\s+--(?:recursive|force)\b/,
      message: "Blocked: rm recursive/force with long flags",
    },
    { pattern: />\s*\/dev\/sd/, message: "Blocked: Writing to block device" },
    { pattern: /mkfs\./, message: "Blocked: Filesystem formatting" },
    { pattern: /dd\s+if=.*of=\/dev\/sd/, message: "Blocked: dd to disk" },
    { pattern: /:\(\)\{\s*:\|:&\s*\};:/, message: "Blocked: Fork bomb" },
    {
      pattern: /(\w+)\(\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;\s*\1/,
      message: "Blocked: Fork bomb variant",
    },
    { pattern: /chmod\s+-R\s+777\s+\//, message: "Blocked: chmod 777 on root" },
    {
      pattern: /curl.*\|\s*(ba)?sh/,
      message: "WARNING: Piping curl to shell is dangerous",
    },
    {
      pattern: /wget.*\|\s*(ba)?sh/,
      message: "WARNING: Piping wget to shell is dangerous",
    },
  ];

  for (const { pattern, message } of dangerousPatterns) {
    if (pattern.test(command)) {
      // Log dangerous command observation
      try {
        logLearningObservation(cwd, "rule_violation", {
          rule: "security-dangerous-command",
          message: message.substring(0, 200),
          blocked: message.startsWith("Blocked"),
        });
      } catch {}

      if (message.startsWith("Blocked")) {
        return {
          severity: "block",
          what_happened: `Bash command matched dangerous pattern: ${command.slice(0, 120)}`,
          why: `validate-bash-command/${message}`,
          agent_must_report: [
            "Quote the exact command that was attempted",
            "State why the dangerous pattern matched (which clause)",
            "If the user truly intended this, ask them to confirm in plain language; do NOT retry without confirmation",
          ],
          agent_must_wait:
            "Do not retry the command. Wait for explicit user instruction.",
          user_summary: message,
        };
      }
      return { continue: true, exitCode: 0, message };
    }
  }

  // Split on shell-segment separators so dangerous patterns inside quoted
  // commit-message bodies (e.g. `git commit -m "...git reset --hard..."`) do NOT
  // false-positive. Each segment's LEADING token determines the actual command.
  const segments = command.split(/(?:\|\||&&|;|\|(?!\|))/);
  const isLeadingCmd = (seg, re) => re.test(seg.trim());

  // BLOCK: git reset --hard without preceding porcelain check (rules/git.md MUST 7)
  if (segments.some((s) => isLeadingCmd(s, /^git\s+reset\s+--hard\b/))) {
    return {
      severity: "block",
      what_happened: `Bash invoked \`git reset --hard\`: ${command.slice(0, 120)}`,
      why: "git.md MUST 'git reset --hard MUST verify clean working tree' — prefer git reset --keep which aborts on local changes",
      agent_must_report: [
        "Show `git status --porcelain` output proving the working tree is clean",
        "OR rewrite the command to use `git reset --keep <ref>` which aborts on dirty tree",
        "Explain why --hard was chosen if the user explicitly authorized it",
      ],
      agent_must_wait:
        "Do not retry --hard until porcelain check is shown OR user authorizes after seeing the risk.",
      user_summary:
        "git reset --hard blocked — needs porcelain check or --keep",
    };
  }

  // BLOCK: force-push to main/master (segment-anchored to avoid commit-msg false-positives)
  const forcePushPattern =
    /^git\s+push\b[^|;]*--force(?:-with-lease)?\b[^|;]*\b(main|master)\b|^git\s+push\b[^|;]*\b(main|master)\b[^|;]*--force(?:-with-lease)?\b/;
  if (segments.some((s) => isLeadingCmd(s, forcePushPattern))) {
    return {
      severity: "block",
      what_happened: `Bash attempted force-push to protected branch: ${command.slice(0, 120)}`,
      why: "git.md branch protection — main/master direct push is rejected; force-push is destructive",
      agent_must_report: [
        "State which branch was being force-pushed",
        "Explain the user-facing reason (commit history rewrite? recovery? bug?)",
        "Confirm whether the user explicitly authorized force-push to main/master IN THIS CONVERSATION",
      ],
      agent_must_wait:
        "Do not retry. Force-push to main requires explicit per-action user authorization.",
      user_summary: "force-push to main/master blocked",
    };
  }

  // HALT-AND-REPORT: --no-verify (segment-anchored)
  if (segments.some((s) => /(?:^|\s)--no-verify\b/.test(s.trim()))) {
    return {
      severity: "halt-and-report",
      what_happened: `Bash command uses --no-verify: ${command.slice(0, 120)}`,
      why: "git.md — pre-commit hooks exist for a reason; --no-verify requires explicit user instruction",
      agent_must_report: [
        "State which hook is being bypassed and why",
        "Explain the underlying issue you would otherwise have to fix",
        "Confirm whether the user authorized --no-verify IN THIS CONVERSATION",
      ],
      agent_must_wait:
        "Do not retry without explicit user instruction. Investigate hook failure root cause first.",
      user_summary: "--no-verify usage requires user authorization",
    };
  }

  // ====================================================================
  // ENFORCE: .env loading for pytest/python commands
  // ====================================================================
  const isPytest = /\bpytest\b/.test(command);
  const isPython = /\bpython\b/.test(command) || /\bpython3\b/.test(command);

  if (isPytest || isPython) {
    // Log enriched test pattern observation
    try {
      const testPathMatch = command.match(
        /(?:pytest|python3?\s+-m\s+pytest)\s+([^\s;|&]+)/,
      );
      const testPath = testPathMatch ? testPathMatch[1] : null;

      // Determine test tier from path
      let testTier = "unit";
      if (testPath) {
        if (/e2e|playwright|end.to.end/i.test(testPath)) testTier = "e2e";
        else if (/integrat/i.test(testPath)) testTier = "integration";
      }

      logLearningObservation(cwd, "test_pattern", {
        test_tier: testTier,
        test_path: testPath,
        is_pytest: isPytest,
        command_flags: extractTestFlags(command),
      });
    } catch {}

    // Check if .env exists
    let envExists = false;
    try {
      envExists = fs.existsSync(path.join(cwd, ".env"));
    } catch {}

    if (envExists) {
      // Check if command already loads .env (various patterns)
      const loadsEnv =
        /dotenv/.test(command) || // pytest-dotenv or dotenv CLI
        /\.env/.test(command) || // References .env explicitly
        /OPENAI_API_KEY=/.test(command) || // Explicit env var
        /--env-file/.test(command) || // Docker-style env file
        /source\s+\.env/.test(command) || // Shell sourcing
        /export\s+/.test(command) || // Export pattern
        /env\s+/.test(command); // env prefix

      if (!loadsEnv && isPytest) {
        return {
          continue: true,
          exitCode: 0,
          message:
            "REMINDER: .env exists but pytest may not load it. Consider: pytest-dotenv plugin OR prefix with env vars from .env. OPENAI_API_KEY and model settings are in .env!",
        };
      }
    }
  }

  // WARN: Long-running commands outside tmux/background
  const longRunningPatterns = [
    /npm\s+run\s+(dev|start|serve)/,
    /yarn\s+(dev|start|serve)/,
    /python\s+-m\s+http\.server/,
    /uvicorn/,
    /flask\s+run/,
    /node\s+.*server/,
    /docker\s+compose\s+up(?!\s+-d)/,
  ];

  const inTmux = process.env.TMUX || process.env.TERM_PROGRAM === "tmux";
  const isBackground =
    /&\s*$/.test(command) ||
    /--background/.test(command) ||
    /-d\s/.test(command);

  for (const pattern of longRunningPatterns) {
    if (pattern.test(command) && !inTmux && !isBackground) {
      return {
        continue: true,
        exitCode: 0,
        message:
          "WARNING: Long-running command. Consider using run_in_background or tmux.",
      };
    }
  }

  // WARN: Git push - reminder for security review
  if (/git\s+push/.test(command)) {
    return {
      continue: true,
      exitCode: 0,
      message: "REMINDER: Did you run security-reviewer before pushing?",
    };
  }

  // WARN: Git commit - reminder for review
  if (/git\s+commit/.test(command)) {
    return {
      continue: true,
      exitCode: 0,
      message:
        "REMINDER: Code review completed? Consider delegating to intermediate-reviewer.",
    };
  }

  // Log cargo test / cargo clippy observations for Rust repos
  const isCargoTest = /\bcargo\s+test\b/.test(command);
  const isCargoClippy = /\bcargo\s+clippy\b/.test(command);
  const isCargoBuil = /\bcargo\s+build\b/.test(command);

  if (isCargoTest || isCargoClippy || isCargoBuil) {
    try {
      const crateMatch = command.match(/-p\s+(\S+)/);
      logLearningObservation(cwd, "test_pattern", {
        test_tier: isCargoTest
          ? "cargo_test"
          : isCargoClippy
            ? "clippy"
            : "cargo_build",
        test_path: crateMatch ? crateMatch[1] : "workspace",
        is_rust: true,
        command_flags: extractTestFlags(command),
      });
    } catch {}
  }

  return { continue: true, exitCode: 0, message: "Validated" };
}

/**
 * Extract test-relevant flags from command for learning.
 */
/**
 * Three-layer mutation detection for trust-posture state files.
 *
 * Per issue #25 (esperie-enterprise/loom) — adopted from tpc_cash_treasury's
 * state-file-write-guard (commit c0aeff73). Closes the bypass gap where
 * settings.json `permissions.deny` on Edit/Write does NOT cover bash-mediated
 * mutations (redirects, file utilities, interpreter -c/-e/-m bodies).
 *
 * Returns { layer, kind } if a mutation is detected against any path matching
 * `pathRx`, else null.
 *
 * Per-line scanning: matchers operate on `[^|\\n]*` so multi-line commands
 * cannot cross-match a verb on one line with a protected path on a later line.
 */
function detectStateFileMutation(command, pathRx) {
  if (!command || !pathRx) return null;
  const lines = command.split("\n");
  for (const line of lines) {
    // Layer 1: redirect / heredoc / tee / sed -i / jq -i — but NOT 2>&1 fd-redirect or /dev/null sink
    // Output redirect to protected path
    if (/(?:^|[^&\d2])>\s*[^|\n]*?/.test(line)) {
      const redirectMatch = line.match(/(?:^|[^&\d2])>>?\s*([^\s|;&]+)/);
      if (redirectMatch && pathRx.test(redirectMatch[1])) {
        return { layer: 1, kind: "redirect" };
      }
    }
    // Heredoc to protected path: `cat > path << EOF` or `>>path<<EOF`
    if (/<<[-~]?\s*['"]?[A-Za-z_]/.test(line)) {
      // Heredoc body itself is delivered later; the line that opens it
      // typically has the redirect target. Match `> <protected>` on this line.
      const m = line.match(/>\s*([^\s|;&<]+)/);
      if (m && pathRx.test(m[1])) {
        return { layer: 1, kind: "heredoc" };
      }
    }
    // tee
    if (/\btee\b\s+/.test(line)) {
      const m = line.match(/\btee\b\s+(?:-[a-zA-Z]+\s+)*([^\s|;&]+)/);
      if (m && pathRx.test(m[1])) {
        return { layer: 1, kind: "tee" };
      }
    }
    // sed -i / jq -i in-place editing
    if (/\b(?:sed|jq)\b\s+[^|\n]*-i\b/.test(line)) {
      if (pathRx.test(line)) return { layer: 1, kind: "in-place-edit" };
    }

    // Layer 2: file-mutating utilities
    const layer2Verbs =
      /\b(?:cp|mv|dd|rsync|install|truncate|ln|chmod|chown|touch)\b\s+/;
    if (layer2Verbs.test(line) && pathRx.test(line)) {
      const verbMatch = line.match(layer2Verbs);
      return {
        layer: 2,
        kind: verbMatch ? verbMatch[0].trim() : "file-mutation-util",
      };
    }

    // Layer 3: interpreter -c / -e / -m bodies (e.g. python -c "...", node -e "...")
    // Includes combined short-flag forms like `-uc`, `-uec`
    const interpreterBody =
      /\b(?:python3?|node|nodejs|ruby|perl|bash|sh|zsh)\b\s+[^|\n]*-[a-zA-Z]*[cem][a-zA-Z]*\b\s+["'][^"']*["']/;
    if (interpreterBody.test(line) && pathRx.test(line)) {
      const interpMatch = line.match(
        /\b(python3?|node|nodejs|ruby|perl|bash|sh|zsh)\b/,
      );
      return {
        layer: 3,
        kind: interpMatch ? `${interpMatch[1]} -c/-e/-m` : "interpreter-body",
      };
    }
  }
  return null;
}

function extractTestFlags(command) {
  const flags = [];
  if (/-x\b/.test(command)) flags.push("fail-fast");
  if (/--tb=/.test(command)) flags.push("traceback");
  if (/-v\b|--verbose\b/.test(command)) flags.push("verbose");
  if (/--cov\b/.test(command)) flags.push("coverage");
  if (/-k\s/.test(command)) flags.push("keyword-filter");
  if (/--workspace\b/.test(command)) flags.push("workspace");
  if (/--release\b/.test(command)) flags.push("release");
  return flags;
}
