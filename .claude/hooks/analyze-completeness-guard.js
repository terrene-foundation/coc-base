#!/usr/bin/env node
/**
 * analyze-completeness-guard.js — PreToolUse(Skill) phase-boundary gate.
 *
 * Enforces `rules/analyze-output-completeness.md` (origin: loom#675). `/analyze`
 * declares `01-analysis/`, `02-plans/`, `03-user-flows/`, and `specs/` compulsory
 * outputs, but `commands/analyze.md` carried no STRUCTURAL phase-complete gate —
 * a session could declare `/analyze` complete with `03-user-flows/` empty and
 * `/todos` would proceed on unvalidated user journeys. Prose alone was the failure
 * class (the command NAMED the outputs and they were still skipped); this hook is
 * the structural fix.
 *
 *   Event:    PreToolUse (Skill)
 *   Watched:  Skill invocations advancing PAST analysis — /todos, /implement
 *   Severity: block  — DENIES the advancing Skill when analysis has STARTED in
 *                      the resolved workspace but a compulsory output tree is
 *                      empty. block fires on the IRREFUTABLE empty-directory fact
 *                      (a deterministic `fs.readdirSync` of the resolved tree —
 *                      file-state, not lexical; no surface rewrite evades "this
 *                      directory holds no non-`.gitkeep` `.md`"), which
 *                      hook-output-discipline.md MUST-2 enumerates as block-grade
 *                      (file existence). The workspace SELECTION is a heuristic
 *                      (explicit arg, else newest-mtime) using the SAME algorithm
 *                      the advancing command uses — but the two reads happen at
 *                      different moments, so under concurrent sibling-mtime churn
 *                      they MAY select different workspaces. The DOMINANT residual
 *                      is a RARE, RECOVERABLE false-block (re-run with an explicit
 *                      `/todos <project>` arg, which the hook honors, or populate the
 *                      tree). The symmetric case — a concurrent session bumping an
 *                      INCOMPLETE sibling's mtime between the hook's read (T1) and the
 *                      command's read (T2) — CAN let the command advance on a sibling
 *                      the hook did not gate: a BOUNDED escape (the intrinsic
 *                      PreToolUse-eval-vs-tool-exec TOCTOU shared by
 *                      genesis-anchor-guard.js / validate-bash-command.js), re-caught
 *                      by the next phase-gate, with NO data loss / credential escape /
 *                      privilege escalation (practically unreachable single-operator).
 *                      block stays correct; ambiguity (unresolved workspace, any
 *                      error) fails OPEN.
 *   Fail-OPEN: any error / timeout / unresolved workspace → {continue:true}. A
 *              FRESH workspace (analysis not yet started — every compulsory tree
 *              empty) also passes: the gate fires only on PARTIAL completion, never
 *              on a legitimate fresh start.
 *   Budget:   ≤5s; setTimeout fallback emits {continue:true} (cc-artifacts.md Rule 7).
 *
 * Workspace-generic — NO hardcoded project. Resolves via
 * workspace-utils.js::detectActiveWorkspace (newest; excludes `instructions` +
 * leading-underscore meta-dirs per cc-artifacts.md Rule 8), honoring an explicit
 * project arg when the Skill carries one.
 *
 * ENV OVERRIDES (test injection only):
 *   COC_OPERATOR_REPO_DIR — test injection of the repo root.
 */

"use strict";

const TIMEOUT_MS = 5000;

// cc-artifacts.md Rule 7 fail-open safety net. Hook-internal hang MUST NOT block
// the agent forever; {continue:true} surfaces no halt.
const fallback = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);

const fs = require("fs");
const path = require("path");

const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
const { detectActiveWorkspace } = require(
  path.join(__dirname, "lib", "workspace-utils.js"),
);
const { resolveMainCheckout } = require(
  path.join(__dirname, "lib", "state-resolver.js"),
);

// Skills that advance PAST the analysis phase — gating these enforces the
// `/analyze` → `/todos`/`/implement` phase boundary.
const ADVANCING_SKILLS = new Set(["todos", "implement"]);

// The workspace-local compulsory output trees `/analyze` declares.
const WS_TREES = ["01-analysis", "02-plans", "03-user-flows"];

/**
 * True iff `dir` contains ≥1 `.md` file (recursively, UNBOUNDED depth) whose
 * basename is not `.gitkeep`. Mirrors the command's UNBOUNDED
 * `find <dir> -type f -name '*.md' ! -name '.gitkeep'` battery (the command's
 * repo-root specs arm dropped its earlier `-maxdepth 2` cap so a deep
 * `specs/methodology/<...>.md` satisfies BOTH surfaces identically).
 * Missing dir / unreadable → false (treated as empty).
 */
function hasNonGitkeepMd(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (hasNonGitkeepMd(full)) return true;
    } else if (e.isFile() && e.name.endsWith(".md") && e.name !== ".gitkeep") {
      return true;
    }
  }
  return false;
}

/**
 * Normalize a Skill invocation's name: strip leading `/`, lowercase, take the
 * first token. `/todos foo` → `todos`.
 */
function skillNameOf(toolInput) {
  const ti = toolInput || {};
  const raw = ti.skill || ti.name || ti.command || "";
  return String(raw)
    .trim()
    .replace(/^\//, "")
    .toLowerCase()
    .split(/[\s/]+/)[0];
}

/**
 * Resolve the workspace the advancing command will operate on, mirroring
 * `commands/analyze.md` § Workspace Resolution: an explicit project arg wins,
 * else the newest workspace. Returns {name, path} | null.
 */
function resolveWorkspace(repoDir, args) {
  const argStr = typeof args === "string" ? args.trim() : "";
  if (argStr) {
    const first = argStr.split(/\s+/)[0];
    if (first && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(first)) {
      const candidate = path.join(repoDir, "workspaces", first);
      try {
        if (fs.statSync(candidate).isDirectory()) {
          return { name: first, path: candidate };
        }
      } catch {
        // not an explicit workspace name — fall through to newest
      }
    }
  }
  return detectActiveWorkspace(repoDir);
}

/**
 * Pure decision function — no stdin, no exit. The unit-test surface.
 *
 * @returns {{action:"pass"|"block", workspace?:string, emptyTrees?:string[]}}
 */
function decideAnalyzeGate({ repoDir, toolName, skillName, args }) {
  // Only Skill invocations advancing past analysis are gated.
  if (toolName !== "Skill") return { action: "pass", reason: "not-a-skill" };
  if (!ADVANCING_SKILLS.has(skillName)) {
    return { action: "pass", reason: "non-advancing-skill" };
  }

  const ws = resolveWorkspace(repoDir, args);
  if (!ws) return { action: "pass", reason: "no-workspace" };

  // Per-tree satisfaction. specs/ is satisfied by EITHER location (the corpus is
  // ambiguous — specs-authority.md Rule 1 says project root, Rule 9 says
  // workspaces/<project>/specs/).
  const wsSpecs = hasNonGitkeepMd(path.join(ws.path, "specs"));
  const rootSpecs = hasNonGitkeepMd(path.join(repoDir, "specs"));
  const treeStatus = {};
  for (const t of WS_TREES) {
    treeStatus[t] = hasNonGitkeepMd(path.join(ws.path, t));
  }
  treeStatus["specs"] = wsSpecs || rootSpecs;

  // analysisStarted is keyed on WORKSPACE-LOCAL trees only — repo-root specs/
  // (always populated at loom-the-methodology-repo) must NOT make every fresh
  // workspace look "started".
  const analysisStarted = WS_TREES.some((t) => treeStatus[t]) || wsSpecs;

  if (!analysisStarted) {
    return { action: "pass", reason: "fresh-workspace", workspace: ws.name };
  }

  const emptyTrees = Object.keys(treeStatus).filter((t) => !treeStatus[t]);
  if (emptyTrees.length === 0) {
    return { action: "pass", reason: "complete", workspace: ws.name };
  }
  return { action: "block", workspace: ws.name, emptyTrees };
}

// ---- main (only when invoked directly) --------------------------------------

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

function resolveRepoDir(payload) {
  const envDir = process.env.COC_OPERATOR_REPO_DIR;
  if (envDir && fs.existsSync(envDir)) return envDir;
  if (payload && typeof payload.cwd === "string" && payload.cwd.length > 0) {
    return payload.cwd;
  }
  return process.cwd();
}

// Deliberate no-payload ALLOW shape: a bare {continue:true} is the canonical
// CC "allow with no message" for PreToolUse (absent output = allow). This pass
// path carries no agent-facing message, so it intentionally does NOT route
// through instruct-and-wait.js's hookSpecificOutput.additionalContext channel
// (which is for message-bearing emits). Only the block branch below uses emit().
function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

async function main() {
  try {
    const payload = await readStdinBounded();
    const hookEvent = payload.hook_event_name || "PreToolUse";
    const toolName = payload.tool_name;
    if (toolName !== "Skill") passthrough();

    const ti = (payload && payload.tool_input) || {};
    const skillName = skillNameOf(ti);
    if (!ADVANCING_SKILLS.has(skillName)) passthrough();

    const sessionCwd = resolveRepoDir(payload);
    const repoDir = resolveMainCheckout(sessionCwd) || sessionCwd;
    const args = ti.args || ti.arguments || "";

    const decision = decideAnalyzeGate({
      repoDir,
      toolName,
      skillName,
      args,
    });

    if (decision.action !== "block") passthrough();

    const trees = decision.emptyTrees.join(", ");
    clearTimeout(fallback);
    emit({
      hookEvent,
      severity: "block",
      what_happened: `/${skillName} blocked — workspace '${decision.workspace}' has started analysis but compulsory /analyze output tree(s) are empty: ${trees}.`,
      why: "analyze-output-completeness/MUST-1 — /analyze declares 01-analysis, 02-plans, 03-user-flows, and specs/ compulsory; advancing to /todos or /implement while any is empty sends feature planning into unvalidated journeys (origin loom#675). The empty-directory signal is a deterministic fs check (file-state, not lexical) — block-eligible per hook-output-discipline.md MUST-2.",
      agent_must_report: [
        `Workspace: ${decision.workspace}`,
        `Empty compulsory tree(s): ${trees}`,
        "Populate each empty tree with the missing /analyze output before re-running this command.",
        "If 03-user-flows genuinely does not apply (a pure back-end change with no user-facing surface), write workspaces/" +
          decision.workspace +
          "/03-user-flows/00-no-user-flows.md stating WHY — a documented rationale file satisfies the gate; a silent-empty tree does not.",
        "specs/ is satisfied by EITHER workspaces/<project>/specs/ OR repo-root specs/.",
      ],
      agent_must_wait:
        "Do not retry the advancing command until every compulsory /analyze output tree is populated (or carries a documented rationale file).",
      user_summary: `analyze-output-completeness — /${skillName} blocked; ${decision.workspace} missing ${trees}`,
    });
    // emit() exits
  } catch (err) {
    // Defense-in-depth: any unexpected exception MUST fail OPEN.
    try {
      process.stderr.write(
        `[ADVISORY] analyze-completeness-guard internal error: ${err && err.message ? err.message : String(err)}\n`,
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
}

if (require.main === module) {
  main();
} else {
  // Library surface for the fixture runner / unit tests.
  clearTimeout(fallback);
  module.exports = {
    decideAnalyzeGate,
    hasNonGitkeepMd,
    skillNameOf,
    resolveWorkspace,
    ADVANCING_SKILLS,
    WS_TREES,
  };
}
