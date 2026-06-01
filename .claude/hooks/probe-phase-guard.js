#!/usr/bin/env node
/**
 * probe-phase-guard.js — pre-tool-use hook enforcing the /certify probe-phase
 * no-Claude-assistance discipline (PR #355 R1 security HIGH-1 closure).
 *
 *   Event:    pre-tool-use (Read, Grep, Glob, WebFetch only)
 *   Watched:  repo-root presence of any `.claude/.certify-in-probe-<vid>.lock`
 *   Severity: block            (lockfile presence is the structural primitive
 *                               per hook-output-discipline.md MUST-2 — file
 *                               existence is process-local deterministic, not
 *                               lexical; tool name is string-equality on the
 *                               canonical CC tool set, not regex over prose)
 *             silent           (no lockfile / non-retrieval tool / outside-repo)
 *   Budget:   ≤5s; setTimeout fallback emits {continue: true} on hang
 *             (cc-artifacts.md Rule 7).
 *
 * Why block (not halt-and-report):
 *   Per hook-output-discipline.md MUST-2: "Block severity is for structural
 *   facts the agent cannot rationalize away (e.g., `CLAUDE_WORKTREE_PATH` env
 *   set + absolute path outside it; pre-commit exit code non-zero;
 *   `git status --porcelain` non-empty before `--hard`)." The lockfile is
 *   exactly that shape — a file the orchestrator wrote at probe entry, that
 *   exists xor doesn't, and a tool-name equality check is not a regex over
 *   prose. The /certify probe is the load-bearing gate against forged
 *   institutional knowledge; weakening to halt-and-report would let a future
 *   session rationalize the retrieval as "just looking up the cited section."
 *
 * Why probe phase only (not brief phase):
 *   Phase A (brief) NEEDS Read/Grep to walk the briefed surface (specs/,
 *   CLAUDE.md, rules/). The lockfile is created by the /certify command at
 *   the START of Phase B (probe), removed at Phase C completion or abandon.
 *   So Read fires fine during Phase A; only Phase B retrieval is gated.
 *
 * Pairs with:
 *   - rules/probe-driven-verification.md MUST-4 (hooks MAY use structural
 *     signals at block severity AS LONG AS gate-review counterpart exists —
 *     /certify's pass-receipt journal entry IS the gate-review counterpart).
 *   - rules/knowledge-convergence.md MUST-2 (signed pass-receipt) — the
 *     signed receipt is meaningless if the probe was assisted by retrieval.
 *
 * ENV OVERRIDES (test injection only):
 *   COC_OPERATOR_REPO_DIR  — test injection of the repo root.
 *
 * Origin: PR #355 R1 multi-agent self-referential redteam (2026-05-26),
 * security-reviewer HIGH-1 (prose-only no-assist enforcement); cc-architect
 * R1 walk-receipt MUST-4 closure.
 */

"use strict";

const TIMEOUT_MS = 5000;

const fallback = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);

const fs = require("fs");
const path = require("path");

const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));

// Retrieval-class tools — the orchestrator uses these to look things up.
// Bash, Edit, Write, MultiEdit, Task are NOT retrieval tools; the lockfile
// gate is narrow by design. Adding Bash would block the orchestrator's own
// lockfile cleanup at probe exit.
const RETRIEVAL_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch"]);

function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

function readStdinSync() {
  try {
    const data = fs.readFileSync(0, "utf8");
    if (!data || !data.trim()) return {};
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function resolveRepoDir(payload) {
  const envDir = process.env.COC_OPERATOR_REPO_DIR;
  if (envDir && fs.existsSync(envDir)) return envDir;
  if (payload && typeof payload.cwd === "string" && payload.cwd.length > 0) {
    return payload.cwd;
  }
  return process.cwd();
}

/**
 * Find any `.claude/.certify-in-probe-*.lock` file in repo-root `.claude/`.
 * Returns the lockfile basename on hit, null on miss.
 *
 * Structural primitive: fs.readdirSync + filename equality match. NOT a
 * regex over prose; the lockfile naming pattern is fixed by /certify's
 * command body.
 */
function findProbeLockfile(repoDir) {
  const claudeDir = path.join(repoDir, ".claude");
  try {
    if (!fs.existsSync(claudeDir)) return null;
    const entries = fs.readdirSync(claudeDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (e.name.startsWith(".certify-in-probe-") && e.name.endsWith(".lock")) {
        return e.name;
      }
    }
    return null;
  } catch {
    // Defensive: any fs error treated as "no lockfile" (passthrough). The
    // /certify command's own structural identity-gate check (Step 1) catches
    // misconfigured repos before probe entry; this hook is the per-tool-call
    // defense, not the only line.
    return null;
  }
}

(async function main() {
  try {
    const payload = readStdinSync();
    const hookEvent = payload.hook_event_name || "PreToolUse";
    const tool = payload && payload.tool_name;

    // Tool-class gate — only retrieval tools are guarded. String equality on
    // the canonical CC tool set is structural per hook-output-discipline.md
    // MUST-2, not lexical regex over prose.
    if (!RETRIEVAL_TOOLS.has(tool)) {
      passthrough();
    }

    const repoDir = resolveRepoDir(payload);
    const lockfile = findProbeLockfile(repoDir);

    if (!lockfile) {
      // No probe in progress — passthrough. The hook is silent during
      // normal sessions and during /certify Phase A (brief).
      passthrough();
    }

    // Probe in progress + retrieval tool requested = block.
    clearTimeout(fallback);
    emit({
      hookEvent,
      severity: "block",
      what_happened: `/certify probe phase active (${lockfile} present); ${tool} call blocked.`,
      why: "/certify probe phase is the load-bearing institutional-knowledge gate; orchestrator retrieval (Read/Grep/Glob/WebFetch) during probe would assist the operator with answers they should be producing from their own absorbed knowledge. Per `rules/knowledge-convergence.md` MUST-2 the signed pass-receipt is meaningless if the probe was assisted. Structural primitive: lockfile existence + tool-name equality, NOT lexical regex (hook-output-discipline.md MUST-2 permits block on structural signals).",
      agent_must_report: [
        `Tool blocked: ${tool}`,
        `Lockfile present: .claude/${lockfile}`,
        "If you are running /certify Phase B (probe), do NOT retrieve the cited section, the answer, or any rephrasing — the probe tests what the operator absorbed during Phase A (brief), not what you can look up.",
        'If the operator asks for help during probe, refuse with one sentence: "I cannot assist during the gate phase; re-read the cited section and answer when ready."',
        "If the lockfile is stale (a prior /certify session crashed without cleanup), the operator must remove `.claude/" +
          lockfile +
          "` manually before retrying.",
      ],
      agent_must_wait:
        "Do not retry retrieval against this tool. If the operator has answered the current probe question, proceed to judge per the bank's `expected:` + `grading_rubric:` (no retrieval needed for judging — the bank ships the canonical answer + rubric).",
      user_summary: `probe-phase-guard — BLOCK ${tool} during /certify probe phase`,
    });
    // emit() exits
  } catch (err) {
    try {
      process.stderr.write(
        `[ADVISORY] probe-phase-guard internal error: ${err && err.message ? err.message : String(err)}\n`,
      );
    } catch {
      // best-effort
    }
    try {
      clearTimeout(fallback);
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {
      // best-effort
    }
    process.exit(0);
  }
})();
