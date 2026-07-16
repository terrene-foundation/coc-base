#!/usr/bin/env node
/**
 * codex-hook-runtime.js — Codex Bash-lane COC_RUNTIME delivery wrapper (#820 AC3).
 *
 * PROBLEM (forward-compat, not a live bug today):
 *   `.claude/hooks/lib/runtime.js::parseHook` validates `process.env.COC_RUNTIME`
 *   against the closed enum {cc,codex,gemini} and THROWS when it is unset. No
 *   shipped hook adopts parseHook yet, but the moment a native Codex Bash-lane
 *   hook (session-start / validate-bash-command / provenance-capture-tool /
 *   integration-hygiene) does, it would throw "COC_RUNTIME env not set" — and on
 *   the git-safety `validate-bash-command` hook that is a FAIL-OPEN regression
 *   (the dangerous command runs because the guard crashed).
 *
 * WHY NOT A SHELL ENV-PREFIX:
 *   The obvious form `COC_RUNTIME=codex node ./.claude/hooks/<h>.js` is a SHELL
 *   construct. Codex executes `type:"command"` hooks via `execvp(argv)` (verified
 *   against developers.openai.com/codex/config-advanced; #820). Under execvp the
 *   whole string is split into argv and `COC_RUNTIME=codex` becomes argv[0] →
 *   ENOENT → the Bash-lane hook SILENTLY does not run (fail-open). So the env MUST
 *   be stamped by a real process, never a shell prefix.
 *
 * THIS WRAPPER (robust under BOTH shell and execvp — it is a plain argv command):
 *   .codex/hooks.json registers each Bash-lane hook as
 *     node ./.claude/hooks/lib/codex-hook-runtime.js ./.claude/hooks/<target>.js
 *   argv[0]="node" always resolves; the wrapper stamps COC_RUNTIME=codex into a
 *   real child-process env, then delegates to the target hook as a NATIVE child
 *   process. Single source of COC_RUNTIME truth for the Codex Bash lane; needs no
 *   per-hook edits.
 *
 * WHY A CHILD PROCESS (spawnSync + stdio:'inherit') AND NOT in-process require():
 *   - `provenance-capture-tool.js` gates its main logic on `require.main === module`;
 *     an in-process require() would leave require.main pointing at THIS wrapper, so
 *     the hook's main body would never run.
 *   - stdio:'inherit' passes the wrapper's own fd 0/1/2 straight to the child, so
 *     the hook JSON on stdin, the hook's stdout/stderr, and its exit code all flow
 *     through UNCHANGED and NATIVE. An exit-2 deny / continue:false survives the
 *     wrapper byte-for-byte.
 *
 * FAIL-CLOSED (never silently exit 0) — SCOPE: the three WRAPPER-INTERCEPTABLE
 * failures. If the target path is missing / not a regular file, or the child
 * cannot be spawned, or it is killed by a signal (no exit code), the wrapper
 * surfaces the error on stderr and exits 2 — the PreToolUse block contract
 * (validate-bash-command.js uses exit 2 = block). On the git-safety lane a
 * wrapper-level failure therefore BLOCKS rather than letting the command through.
 * Exiting 0 on a delegation failure is BLOCKED (zero-tolerance Rule 3).
 *   NOT remapped: a target that LOADS then throws exits 1, which the wrapper passes
 *   through faithfully as 1. That is CORRECT, not a fail-open — native `node
 *   <hook>.js` behaves identically, and exit 1 is the legitimate "warn, non-blocking"
 *   semantics validate-bash-command / integration-hygiene rely on; remapping it to 2
 *   would clobber that contract.
 *   SELF-ABSENCE: dead code cannot intercept its own absence — if THIS wrapper file
 *   is itself missing downstream (sync miss / erroneous purge), `node <missing>`
 *   exits 1 and may fail-open, dropping every wrapped hook at once. The wrapper is
 *   therefore load-bearing for the git-safety lane and MUST ship (it is in the
 *   synced `hooks/lib/**` tier, NOT loom_only) and belongs on any sync-integrity
 *   allowlist that guards the git-safety hooks.
 *
 * Origin: #820 AC3 (2026-07-13). The server.js half (ACs 1/2/4) stamps
 * COC_RUNTIME programmatically for the non-Bash MCP lane; this is the Bash-lane
 * counterpart. See .claude/agents/codex-architect.md § Hooks Coverage.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Fail-closed exit code for wrapper-level delegation failures. 2 is the
// PreToolUse block contract shared by validate-bash-command.js — the strongest
// fail-closed posture on the git-safety lane.
const FAIL_CLOSED_EXIT = 2;

function failClosed(message) {
  // Synchronous write (fs.writeSync, not process.stderr.write): on a pipe the
  // async stderr write can be dropped when process.exit() terminates before the
  // flush — losing the block diagnostic Codex feeds back to the agent. The exit
  // code (the block itself) is always preserved; this preserves the WHY too.
  try {
    fs.writeSync(2, `[codex-hook-runtime] ${message}\n`);
  } catch {
    // stderr fd unwritable (closed pipe) — the exit-2 block still stands.
  }
  process.exit(FAIL_CLOSED_EXIT);
}

function dispatch() {
  const targetArg = process.argv[2];
  const forwardedArgs = process.argv.slice(3);

  if (!targetArg) {
    failClosed(
      "no target hook path given (usage: node codex-hook-runtime.js <target-hook.js> [args...])",
    );
  }

  // Resolve relative to the invocation cwd (Codex invokes hooks with
  // cwd=project_root; the child inherits the same cwd so its own relative
  // resolution matches this existence check).
  const resolvedTarget = path.resolve(process.cwd(), targetArg);
  // isFile(), not existsSync(): a DIRECTORY (or any non-file) target passes an
  // existence check, but `node <dir>` exits 1 (MODULE_NOT_FOUND) — non-blocking =
  // fail-OPEN on the git-safety lane. Stat and require a regular file so a
  // misconfigured hooks.json entry fails CLOSED (exit 2), not open.
  let targetStat = null;
  try {
    targetStat = fs.statSync(resolvedTarget);
  } catch {
    targetStat = null; // ENOENT etc. → not found → fail closed below (never open)
  }
  if (!targetStat) {
    failClosed(
      `target hook not found: ${targetArg} (resolved ${resolvedTarget})`,
    );
  }
  if (!targetStat.isFile()) {
    // A directory (or socket/fifo) passes an existence check, but `node <dir>`
    // exits 1 (MODULE_NOT_FOUND) — non-blocking = fail-OPEN on the git-safety lane.
    failClosed(
      `target hook is not a regular file: ${targetArg} (resolved ${resolvedTarget})`,
    );
  }

  const result = spawnSync("node", [resolvedTarget, ...forwardedArgs], {
    // Transparent passthrough: the child reads the hook JSON from the wrapper's
    // own stdin and writes stdout/stderr straight back to Codex.
    stdio: "inherit",
    // The single COC_RUNTIME stamp for the Codex Bash lane. parseHook validates
    // this against {cc,codex,gemini}; `codex` is the correct enforcement-lane label.
    // CLAUDE_PROJECT_DIR stamp mirrors the MCP-guard sibling (server.js): on the
    // Codex Bash lane neither CLAUDE_PROJECT_DIR nor GEMINI_PROJECT_DIR is set, so
    // runtime.js::parseHook().projectDir would fall through to CODEX_HOME (~/.codex
    // — the wrong dir) for any future parseHook adopter. Codex invokes hooks with
    // cwd=project_root, so process.cwd() IS the project root; preserve an inherited
    // value if one is present. (parseHook already exposes stdin `data.cwd`
    // separately, so validate-bash-command's git-safety path is unaffected either way.)
    env: {
      ...process.env,
      COC_RUNTIME: "codex",
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    },
  });

  if (result.error) {
    // Spawn itself failed (e.g. node not found on PATH). Fail closed.
    failClosed(`failed to spawn target hook: ${String(result.error)}`);
  }

  if (result.status === null) {
    // Killed by a signal (no exit code). Fail closed rather than assume success.
    failClosed(
      `target hook terminated by signal ${result.signal || "unknown"} with no exit code`,
    );
  }

  // Faithful passthrough of the target hook's own exit code (0 / 1 / 2 / …).
  process.exit(result.status);
}

// Top-level fail-closed guard: any UNEXPECTED internal throw (e.g. process.cwd()
// raising ENOENT if the working directory is unlinked mid-hook) MUST fail closed
// (exit 2), never surface as an uncaught exception → node exit 1 = fail-OPEN on the
// git-safety lane. This completes the fail-closed contract to cover ANY internal
// error, not only the three wrapper-interceptable modes documented above.
// (process.exit does not throw, so the normal fail-closed / passthrough exits inside
// dispatch() terminate before this catch and are never intercepted by it.)
function main() {
  try {
    dispatch();
  } catch (e) {
    failClosed(`internal wrapper error: ${String(e)}`);
  }
}

main();
