#!/usr/bin/env node
/**
 * Hook: gitignored-claude-warn
 * Event: PreToolUse
 * Matcher: Edit|Write
 * Purpose: Warn when an agent writes to a gitignored .claude/ subtree.
 *
 *   Many downstream COC consumer repos gitignore `.claude/` to prevent drift
 *   from the loom-managed sync source. A Write/Edit to such a path produces
 *   a transient file invisible to git, while the agent often believes it
 *   has "codified" an artifact. The downstream repo's tracked CLAUDE.md
 *   may then cite the transient file, shipping a phantom citation on the
 *   next commit (caught at /redteam, but usually after waste).
 *
 *   This hook fires meaningfully ONLY where .claude/ is gitignored: in
 *   downstream consumer repos. In loom / BUILD repos / USE templates,
 *   .claude/ is tracked, so `git check-ignore` returns non-zero and the
 *   hook stays silent. Zero false-positive surface in artifact-managed
 *   environments.
 *
 *   Returns WARN only — never blocks. Intent is to surface the violation
 *   so the agent self-corrects (upstream to loom via GH issue) before
 *   citing the transient file in tracked content.
 *
 * Origin: loom issue #19 Proposal 1 (2026-04-21 tpc/tpc_cash_treasury-scenario
 *   /redteam — agent wrote rules/spec-accuracy.md to gitignored .claude/rules/,
 *   edited tracked CLAUDE.md to cite it, almost shipped phantom-reference state).
 *
 * Exit Codes:
 *   0 = success / warn
 *   1 = hook error (e.g. timeout, malformed input)
 */

const path = require("path");
const { execFileSync } = require("child_process");

const TIMEOUT_MS = 5000;
const timeout = setTimeout(() => {
  console.error("[HOOK TIMEOUT] gitignored-claude-warn exceeded 5s limit");
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
    const result = checkPath(data);
    console.log(
      JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          validation: result.messages,
        },
      }),
    );
    process.exit(0);
  } catch (error) {
    console.error(`[HOOK ERROR] gitignored-claude-warn: ${error.message}`);
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
});

function checkPath(data) {
  const filePath = data.tool_input?.file_path || "";
  if (!filePath) return { messages: [] };

  // Normalize and only inspect paths under .claude/.
  const norm = path.normalize(filePath);
  if (!/(?:^|\/)\.claude\//.test(norm)) return { messages: [] };

  // Run git check-ignore. Exit 0 means the path IS gitignored.
  // We pass -v for verbose; we only care about the exit code.
  const cwd = data.cwd || process.cwd();
  let ignored = false;
  try {
    execFileSync("git", ["check-ignore", "-v", norm], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 2000,
    });
    ignored = true; // exit 0 — path is ignored
  } catch (e) {
    // exit 1 — not ignored, OR exit 128 — not in a git repo. Both → silent.
    ignored = false;
  }

  if (!ignored) return { messages: [] };

  const rel = path.relative(cwd, norm);
  return {
    messages: [
      {
        severity: "warn",
        rule: "artifact-flow.md (loom #19 P1)",
        message:
          `${rel}: writing to a gitignored .claude/ subtree. ` +
          `This write is transient — the file will not be tracked, and any ` +
          `citation from tracked content (CLAUDE.md, rules, etc.) will become ` +
          `a phantom reference on the next sync. ` +
          `If you intend to codify this artifact, file a GH issue against the ` +
          `loom source-of-truth instead. If this is a session-only note, proceed.`,
      },
    ],
  };
}
