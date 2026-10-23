#!/usr/bin/env node
/**
 * @hook-event: PreToolUse:Edit|NotebookEdit|Write (guard) — the pending artifact path can be checked against gitignore before an untracked write is mistaken for durable codification.
 *
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
 * Origin: loom issue #19 Proposal 1 (2026-04-21 example-workspace/financial-scenario
 *   /redteam — agent wrote rules/spec-accuracy.md to gitignored .claude/rules/,
 *   edited tracked CLAUDE.md to cite it, almost shipped phantom-reference state).
 *
 * Exit Codes:
 *   0 = success / warn
 *   1 = hook error (e.g. timeout, malformed input)
 */

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [],
 *     "network": false,
 *     "spawns": ["git"]
 *   },
 *   "idempotent": true,
 *   "may_rewrite_input": false,
 *   "notes": "spawns: `git check-ignore -v` via lib/git-subprocess-env.js (absolute binary, minimal env) — a local read, so the hook's own process opens no network. The warning renders to stdout as additionalContext; no durable write anywhere."
 * }
 */

const path = require("path");
const { resolveTargetRepo, targetGit } = require(
  path.join(__dirname, "lib", "target-repo-git.js"),
);

const TIMEOUT_MS = 5000;
let timeout = null;

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  timeout = setTimeout(() => {
    console.error("[HOOK TIMEOUT] gitignored-claude-warn exceeded 5s limit");
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
    const result = checkPath(data);
    // Surface advisories to the agent via additionalContext — the delivered
    // PreToolUse field; the prior `validation` sibling was silently dropped
    // (loom #466). Render the message objects to text; emit no context block
    // when there are no advisories.
    const out = { continue: true };
    if (Array.isArray(result.messages) && result.messages.length) {
      out.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        additionalContext: result.messages
          .map((m) => (m && m.message ? `[${m.rule}] ${m.message}` : String(m)))
          .join("\n"),
      };
    }
    console.log(JSON.stringify(out));
    process.exit(0);
  } catch (error) {
    console.error(`[HOOK ERROR] gitignored-claude-warn: ${error.message}`);
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
}

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
  {
    // loom#1471 (s49). LOCAL profile. `cwd` chose a DIRECTORY; an ambient
    // `GIT_DIR` outranked it, so the question "is .claude ignored HERE?" was
    // answered by an attacker-named repository's `.gitignore` — and this hook
    // fails silent, so a "not ignored" from a decoy repo suppressed the warning
    // with nothing to show for it.
    //
    // NAMED BEHAVIOUR NARROWING, accepted deliberately: `gitEnv()` sets
    // GIT_CONFIG_GLOBAL=/dev/null, so a path ignored ONLY via the operator's
    // global `core.excludesFile` now reads as not-ignored. That is a narrower
    // warning, and it is the correct trade — the config profile cannot be used
    // here in any case (`check-ignore` is outside CONFIG_PROFILE_SUBCOMMANDS and
    // gitConfigInvocation() THROWS on it), and admitting global config to widen
    // a warning would re-open the steering channel this closes.
    //
    // M-W4.3 RUN 8: through THE TARGET-REPO ENVELOPE (lib/target-repo-git.js).
    // `check-ignore` reads the index, which refreshes through the repository's
    // configured `core.fsmonitor` program — and the session's repository config is
    // the agent's to write. The repository is resolved ONCE from `cwd`.
    //
    // Rule 7 fail-OPEN: an unresolvable repository (no binary, not a git repo) or a
    // refused/unanswered read ⇒ cannot determine ⇒ no warning, the same silence as
    // before. Returns this function's OWN shape — `{messages: []}`, never a bare
    // boolean.
    const at = path.resolve(cwd);
    const resolved = resolveTargetRepo({ dir: at }, { timeout: 2000 });
    if (!resolved.ok) return { messages: [] };
    const r = targetGit(resolved.repo, ["check-ignore", "-v", "--", norm], { cwd: at, timeout: 2000 });
    // exit 0 — path is ignored; exit 1 — not ignored; anything else (128, refused,
    // unanswered) — not determined. Only exit 0 warns.
    ignored = r.ok;
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

module.exports = {
  hookMain,
  // Exported for the routing closure cases (tests/integration/multi-operator/
  // target-repo-git-routing.test.js), which plant a program in the repository's
  // config and assert this read never runs it.
  _checkPath: checkPath,
};

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
