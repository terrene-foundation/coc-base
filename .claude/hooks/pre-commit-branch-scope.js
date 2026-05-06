#!/usr/bin/env node
/**
 * Hook: pre-commit-branch-scope
 * Mode: standalone advisory (exits 0 always — never blocks)
 * Purpose: Warn when a commit's modified files fall outside the branch's
 *          declared scope. Catches the "narrow PR balloons into unrelated
 *          work" failure mode described in loom issue #19 Proposal 3.
 *
 * Usage:
 *
 *   1. As a git pre-commit hook (per-clone install):
 *      ln -s ../../.claude/hooks/pre-commit-branch-scope.js \
 *            .git/hooks/pre-commit
 *      chmod +x .git/hooks/pre-commit
 *      → fires on every `git commit` (including from CC's Bash tool).
 *
 *   2. As a manual pre-commit advisory:
 *      node .claude/hooks/pre-commit-branch-scope.js
 *      → reports out-of-scope files; never modifies anything.
 *
 *   3. Invoked from validate-bash-command.js when the agent runs
 *      `git commit ...` via the Bash tool. validate-bash-command.js
 *      calls this script synchronously and bubbles up its stderr as
 *      a WARN-tier validation message (advisory, non-blocking).
 *
 * Scope resolution order (best-to-fallback):
 *
 *   A. `gh pr view --json headRefName,body` for the open PR on this
 *      branch — parse a `Scope:` line OR file globs from the PR body.
 *      This is the PREFERRED ground truth because the PR body is
 *      author-declared rather than agent-inferred.
 *
 *   B. Branch-name keyword regex (slash escaped as ::: in this comment):
 *      chore:::scenario-X         maps to workspaces:::scenario-X, .session-notes
 *      release:::v<X.Y.Z>         maps to pyproject.toml, CHANGELOG.md, VERSION
 *      docs:::any                 maps to docs:::, *.md
 *      Unrecognised pattern: no scope opinion (silent).
 *
 *   C. No PR, no recognisable branch pattern: silent (this is fine;
 *      not every branch follows a convention and false-positive WARNs
 *      train operators to ignore the hook).
 *
 * Origin: loom issue #19 Proposal 3 (2026-04-21 tpc/tpc_cash_treasury-scenario
 *   /redteam — branch chore/scenario-pending-cleanup-2026-04-21 had a narrow
 *   .session-notes + .pending/ scope; session continued on the same branch
 *   for completely unrelated CLAUDE.md / 04-validate/ / .claude/rules/
 *   work; would have ballooned PR #1378 if not caught at /redteam).
 *
 * Exit Codes:
 *   0 = always (advisory, never blocks). Errors print to stderr.
 */

const { execFileSync } = require("child_process");
const path = require("path");

const TIMEOUT_MS = 4000;
const startedAt = Date.now();
function timedOut() {
  return Date.now() - startedAt > TIMEOUT_MS;
}

function git(args, opts = {}) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
      ...opts,
    }).trim();
  } catch (e) {
    return null;
  }
}

function gh(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2500,
    }).trim();
  } catch (e) {
    return null;
  }
}

function getBranch() {
  return git(["rev-parse", "--abbrev-ref", "HEAD"]);
}

function getStagedFiles() {
  // --cached: staged for next commit (the actual commit set)
  const out = git(["diff", "--cached", "--name-only"]);
  if (!out) return [];
  return out.split("\n").filter(Boolean);
}

/**
 * Try to resolve declared scope from the open PR for this branch.
 * Looks for a `Scope:` line in the PR body, or paths in `## Scope`
 * sections. Returns an array of glob-like patterns or null if no PR.
 */
function getDeclaredScopeFromPR(branch) {
  const json = gh([
    "pr",
    "view",
    "--json",
    "headRefName,body",
    "--head",
    branch,
  ]);
  if (!json) return null;
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed.body) return null;
  const body = parsed.body;

  // Look for `Scope: <comma-separated globs>` line.
  const scopeLine = body.match(/^Scope:\s*(.+)$/m);
  if (scopeLine) {
    return scopeLine[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Look for `## Scope` section with bullet list.
  const scopeSection = body.match(/^##\s+Scope\s*\n([\s\S]+?)(?:\n##|\n*$)/m);
  if (scopeSection) {
    const bullets = scopeSection[1].match(/^[-*]\s+`?([^\s`]+)`?$/gm) || [];
    const patterns = bullets
      .map((b) => b.replace(/^[-*]\s+`?|`?$/g, "").trim())
      .filter(Boolean);
    if (patterns.length) return patterns;
  }
  return null;
}

/**
 * Conservative branch-name → scope-pattern fallback. Only emit a scope
 * opinion when the branch name fits a known shape. Unknown shapes →
 * no opinion (return null) → no warnings.
 */
function getInferredScopeFromBranch(branch) {
  if (!branch) return null;

  // chore/scenario-* → any workspaces/scenario-* dir, plus .session-notes.
  // Use a glob rather than capturing a specific identifier — branch names
  // like `chore/scenario-foo-cleanup-2026-05-01` make it ambiguous where
  // the scenario name ends, so glob the whole scenario- workspace family.
  if (/^chore\/scenario-/.test(branch)) {
    return ["workspaces/scenario-*", ".session-notes"];
  }

  // release/v<X.Y.Z> → metadata-only
  if (/^release\/v\d/.test(branch)) {
    return [
      "pyproject.toml",
      "Cargo.toml",
      "Cargo.lock",
      "CHANGELOG.md",
      ".claude/VERSION",
      "VERSION",
      "src/", // for __version__ updates
      "packages/", // for sub-package version bumps
      "lib.rs", // Rust version constant
    ];
  }

  // docs/* → docs + .md
  if (/^docs\//.test(branch)) {
    return ["docs/", "*.md", "**/*.md"];
  }

  // No confident inference → silent.
  return null;
}

/**
 * Match a file path against a list of scope patterns. Patterns are
 * substring/prefix matches: a pattern ending in `/` is a directory
 * prefix; one with `*` is treated as a regex-ish glob; otherwise it's
 * a substring match. Conservative — designed to err toward false
 * negatives (silent), not false positives (noise).
 */
function isInScope(filePath, patterns) {
  for (const p of patterns) {
    if (!p) continue;
    if (p.endsWith("/")) {
      if (filePath.startsWith(p)) return true;
    } else if (p.includes("*")) {
      const re = new RegExp(
        "^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
      );
      if (re.test(filePath)) return true;
    } else {
      if (filePath === p) return true;
      if (filePath.endsWith("/" + p)) return true;
      if (filePath.includes(p)) return true;
    }
  }
  return false;
}

function main() {
  // Bail if not in a git repo.
  if (!git(["rev-parse", "--is-inside-work-tree"])) return;

  const branch = getBranch();
  if (!branch || branch === "HEAD") return; // detached HEAD or fresh repo

  const staged = getStagedFiles();
  if (staged.length === 0) return;

  // Resolve scope: PR-declared first, then branch-name inference.
  let scopePatterns = null;
  let scopeSource = null;

  scopePatterns = getDeclaredScopeFromPR(branch);
  if (scopePatterns && scopePatterns.length) {
    scopeSource = "open PR `Scope:` declaration";
  } else {
    scopePatterns = getInferredScopeFromBranch(branch);
    if (scopePatterns) scopeSource = `branch name (${branch})`;
  }

  if (!scopePatterns) return; // no confident scope → silent

  if (timedOut()) return;

  const out = staged.filter((f) => !isInScope(f, scopePatterns));
  if (out.length === 0) return;

  const lines = [];
  lines.push(
    `[branch-scope advisory] ${out.length} file(s) outside declared scope`,
  );
  lines.push(`  branch:  ${branch}`);
  lines.push(`  scope:   ${scopeSource}`);
  lines.push(`  pattern: [${scopePatterns.join(", ")}]`);
  lines.push("  out-of-scope files:");
  for (const f of out.slice(0, 20)) lines.push(`    - ${f}`);
  if (out.length > 20) lines.push(`    ... and ${out.length - 20} more`);
  lines.push("  → If this is intentional, ignore. If unintentional,");
  lines.push("    consider splitting onto a separate branch before commit.");

  console.error(lines.join("\n"));
}

try {
  main();
} catch (e) {
  // Advisory-only — never propagate errors.
  console.error(`[branch-scope advisory] internal error: ${e.message}`);
}
process.exit(0);
