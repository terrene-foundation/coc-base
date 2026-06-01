#!/usr/bin/env node
/**
 * check-sync-freshness — pre-sync remote freshness probe (F62, journal/0163).
 *
 * Verifies that the local working-tree HEAD of loom (and optionally a sync
 * target's clone) matches the remote tip via `git ls-remote`. HALTs the sync
 * pipeline (exit 1) on any mismatch with verbatim local-vs-remote SHA pair
 * so the operator can fetch + reset before re-running. Read-only — does NOT
 * fetch, mutate the working tree, or write any state.
 *
 * Per hook-output-discipline.md MUST-2: the signal is structural (git ref
 * SHA comparison + process exit code), not lexical. Per sync-completeness.md
 * MUST-3 § symmetric defense: this validator catches at pre-sync time the
 * same class of drift the post-sync verification table catches at post-sync
 * time — operator's "I just fetched" memory is the failure mode `verify-
 * resource-existence.md` MUST-2 (live API > documentation) exists to block.
 *
 * Probes the integration branch (default: `main`), NOT the current HEAD —
 * /sync runs FROM a `codify/<id>-<date>` branch per coc-sync-landing.md
 * MUST-3, but the freshness invariant is "is the source-of-truth integration
 * branch up-to-date with origin?" so the check pins to main regardless of
 * current HEAD. Override via --branch <name> for non-standard layouts.
 *
 * Usage:
 *   node .claude/bin/check-sync-freshness.mjs --loom
 *   node .claude/bin/check-sync-freshness.mjs --target <slug>
 *   node .claude/bin/check-sync-freshness.mjs --loom --target <slug>
 *   node .claude/bin/check-sync-freshness.mjs --loom --branch master
 *   node .claude/bin/check-sync-freshness.mjs --loom --json
 *
 * Output (default — human-readable, sync-completeness.md Rule 2 verification-
 * table-compatible shape):
 *   [validator-sync-freshness] loom (main): PASS local=abc123 remote=abc123
 *   [validator-sync-freshness] use-template.claude-py (main): PASS local=def456 remote=def456
 *
 * Output (--json) — full shape (consumer parsers MUST tolerate unknown keys;
 * future fields are additive per cc-architect MED-2 / journal/0164):
 *   {
 *     "results": [
 *       {
 *         "target":  "loom" | "<slug>",     // string — input label
 *         "repo":    "<absolute-path>",     // string | null — resolved checkout
 *         "branch":  "main" | "<name>",     // string — integration branch probed
 *         "local":   "<40-hex>" | null,     // SHA at refs/heads/<branch>; null on miss
 *         "remote":  "<40-hex>" | null,     // SHA from `git ls-remote`; null on miss
 *         "pass":    true | false,          // local === remote AND both non-null
 *         "reason":  null | "<diagnostic>"  // null on PASS; classified on FAIL
 *       },
 *       ...
 *     ],
 *     "overall_pass": true | false           // && over per-target pass values
 *   }
 *
 * Exit codes:
 *   0 — all probed targets PASS (local HEAD == remote tip)
 *   1 — at least one target FAILed OR ls-remote could not reach origin
 *   2 — invocation error (missing args, unknown target slug)
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const LOOM_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/**
 * Resolve a target slug (e.g., "use-template.claude-py") to an on-disk path
 * via the canonical loom-links resolver. Returns null if the slug is unknown
 * AND require:false is implied (survey-class caller); throws otherwise.
 */
async function resolveTargetPath(slug, { require = true } = {}) {
  const mod = await import(path.join(LOOM_ROOT, ".claude", "bin", "lib", "loom-links.mjs"));
  const r = mod.resolveRepo(slug, { require });
  if (r && r.skipped) return null;
  if (!r || !r.value) {
    throw new Error(`unknown target slug: ${slug}`);
  }
  return r.value;
}

/**
 * Get the SHA the local branch ref points to (NOT current HEAD).
 * Returns a 40-hex SHA on success, OR a shape `{ error, stderr }` on failure
 * where `error` is one of:
 *   - "unknown-ref"  : the branch ref does not exist (typo or different default)
 *   - "git-error"    : git ran but failed for a non-ref-shape reason
 *                     (.git/ corruption, permission denied, etc.) — operator
 *                     should escalate, NOT just retry with a different branch
 *
 * Per reviewer LOW-1 (journal/0164): the pre-amendment `stdio: ["ignore",
 * "pipe", "ignore"]` collapsed BOTH classes into the same `null` return,
 * making "typo" indistinguishable from ".git/ corruption" — soft-cousin of
 * zero-tolerance.md Rule 3 (no silent swallow). Capturing stderr + classifying
 * the failure mode preserves the typed-error contract probeOne expects.
 */
function localBranchSha(repoDir, branch) {
  try {
    return execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", `refs/heads/${branch}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (err) {
    const stderr = (err.stderr || "").toString();
    // git's known "ref does not exist" surface texts. Anything else is a real
    // git error (corrupt .git, permission denied, etc.) the operator must see.
    if (/(unknown revision|bad revision|fatal: ambiguous)/i.test(stderr)) {
      return { error: "unknown-ref", stderr: stderr.trim() };
    }
    return { error: "git-error", stderr: stderr.trim() };
  }
}

/**
 * Read the remote tip SHA for `branch` via `git ls-remote origin <branch>`.
 * Returns the 40-hex SHA or null when the remote does not have the branch
 * (caller decides whether absent-on-remote is a HALT or a skip).
 */
function remoteTip(repoDir, branch) {
  const out = execFileSync(
    "git",
    ["-C", repoDir, "ls-remote", "origin", branch],
    { encoding: "utf8" },
  ).trim();
  if (!out) return null;
  const sha = out.split(/\s+/, 1)[0];
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Run the freshness probe against one (label, repoDir, branch) triple.
 * Returns the per-target result object. Probes the named branch (default
 * 'main'), NOT the current HEAD — the integration-branch freshness IS the
 * invariant /sync depends on; current-HEAD freshness is incidental (sync
 * runs from a codify branch per coc-sync-landing.md MUST-3).
 */
function probeOne(label, repoDir, branch) {
  try {
    const local = localBranchSha(repoDir, branch);
    if (typeof local !== "string") {
      // Structured error path (reviewer LOW-1): distinguish typo from corruption.
      const reasonByClass = {
        "unknown-ref": `local has no branch ref 'refs/heads/${branch}' (typo or non-default integration branch — try --branch <name>)`,
        "git-error": `git error reading 'refs/heads/${branch}' — stderr: ${local.stderr || "<none>"}. Likely .git/ corruption, permission denied, or transient. NOT a missing-ref typo; investigate before retrying.`,
      };
      return {
        target: label,
        repo: repoDir,
        branch,
        local: null,
        remote: null,
        pass: false,
        reason: reasonByClass[local.error] || `unknown probe error: ${local.error}`,
      };
    }
    const remote = remoteTip(repoDir, branch);
    if (!remote) {
      return {
        target: label,
        repo: repoDir,
        branch,
        local,
        remote: null,
        pass: false,
        reason: `remote has no branch '${branch}' (or ls-remote unreachable)`,
      };
    }
    return {
      target: label,
      repo: repoDir,
      branch,
      local,
      remote,
      pass: local === remote,
      reason:
        local === remote ? null : `local ${branch} diverges from origin/${branch}`,
    };
  } catch (err) {
    return {
      target: label,
      repo: repoDir,
      branch,
      local: null,
      remote: null,
      pass: false,
      reason: `probe error: ${err.message}`,
    };
  }
}

function parseArgs(argv) {
  const args = { loom: false, targets: [], json: false, branch: "main" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--loom") args.loom = true;
    else if (a === "--target") args.targets.push(argv[++i]);
    else if (a === "--branch") args.branch = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      process.stderr.write(`check-sync-freshness: unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    "Usage: check-sync-freshness.mjs [--loom] [--target <slug> ...] [--branch <name>] [--json]\n" +
      "  --loom            probe the loom checkout (script's repo root)\n" +
      "  --target <slug>   probe a sync-target slug (e.g., use-template.claude-py)\n" +
      "                    resolvable via .claude/bin/lib/loom-links.mjs\n" +
      "  --branch <name>   integration branch to probe (default: main)\n" +
      "  --json            emit machine-readable JSON instead of table\n" +
      "Probes refs/heads/<branch> vs `git ls-remote origin <branch>` (NOT current HEAD).\n" +
      "Exit: 0 all PASS / 1 any FAIL or remote unreachable / 2 invocation error\n",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.loom && args.targets.length === 0) {
    process.stderr.write(
      "check-sync-freshness: at least one of --loom or --target required\n",
    );
    process.exit(2);
  }

  const results = [];
  if (args.loom) {
    results.push(probeOne("loom", LOOM_ROOT, args.branch));
  }
  for (const slug of args.targets) {
    let repoDir;
    try {
      repoDir = await resolveTargetPath(slug);
    } catch (err) {
      results.push({
        target: slug,
        repo: null,
        branch: args.branch,
        local: null,
        remote: null,
        pass: false,
        reason: err.message,
      });
      continue;
    }
    results.push(probeOne(slug, repoDir, args.branch));
  }

  const overall = results.every((r) => r.pass);

  if (args.json) {
    process.stdout.write(JSON.stringify({ results, overall_pass: overall }, null, 2) + "\n");
  } else {
    for (const r of results) {
      const verdict = r.pass ? "PASS" : "FAIL";
      const branchTag = r.branch ? ` (${r.branch})` : "";
      const lineHead = `[validator-sync-freshness] ${r.target}${branchTag}: ${verdict}`;
      if (r.pass) {
        process.stdout.write(
          `${lineHead} local=${r.local.slice(0, 8)} remote=${r.remote.slice(0, 8)}\n`,
        );
      } else {
        const local = r.local ? r.local.slice(0, 8) : "?";
        const remote = r.remote ? r.remote.slice(0, 8) : "?";
        process.stdout.write(`${lineHead} local=${local} remote=${remote}\n`);
        process.stderr.write(
          `  reason: ${r.reason}\n` +
            `  remediation: cd ${r.repo || "<repo>"} && git fetch origin ${r.branch || "<branch>"} ` +
            `&& git reset --keep origin/${r.branch || "<branch>"}  (per git.md '--keep' over '--hard')\n`,
        );
      }
    }
  }

  process.exit(overall ? 0 : 1);
}

// Only run main() when invoked as a CLI script — never when imported by tests
// or sibling tooling. Standard ESM CLI-vs-import-time discriminator.
//
// Per F62 reviewer MED-1 (journal/0164): naive `import.meta.url ===
// \`file://${process.argv[1]}\`` breaks on operator paths with spaces or
// non-ASCII because import.meta.url percent-encodes special chars while
// process.argv[1] is OS-native — equality FALSE → main() does NOT run →
// silent exit-0 FALSE-PASS at the /sync gate. Use fileURLToPath +
// realpathSync to normalize BOTH sides:
//   - fileURLToPath decodes import.meta.url to the OS-native form
//   - realpathSync resolves /usr/local/bin/node-style symlinks +
//     handles any TOCTOU/symlink layer that would otherwise mismatch
// This reproduces the exact failure class F62 exists to block (silent
// sync-gate false-pass), one layer down at the helper's own CLI entry.
const isMainModule =
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`check-sync-freshness: fatal: ${err.message}\n`);
    process.exit(2);
  });
}

export { probeOne, remoteTip, localBranchSha, resolveTargetPath };
