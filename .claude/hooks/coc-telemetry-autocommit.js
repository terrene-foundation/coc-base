#!/usr/bin/env node
/**
 * Hook: coc-telemetry-autocommit
 * Event: SessionEnd
 * Purpose: Auto-land `.claude/learning/observations.jsonl` +
 *          `violations.jsonl` drift when those files are the ONLY
 *          uncommitted change AND we are on `main`. Replaces the
 *          per-session `chore/coc-telemetry-<date>` PR cycle that
 *          coc-sync-landing.md MUST-1 has driven for ~3 cycles.
 *
 *   Implementation note: the user-facing decision was framed as
 *   "Commit-on-Stop hook". This implementation registers under
 *   SessionEnd, not Stop. Stop fires on every agent-turn boundary
 *   (dozens per session) — wiring there would spam-commit on every
 *   response. SessionEnd fires once per session termination, which
 *   is the correct semantic.
 *
 *   Gates (ALL six MUST pass; otherwise silent no-op):
 *     1. CWD is loom — detected via `.claude/sync-manifest.yaml`
 *        (loom-only file; USE templates ship pre-emitted output).
 *     2. Currently on `main` branch — feature branches stay clean.
 *     3. Only modifications are observations.jsonl and/or
 *        violations.jsonl. No untracked / deleted / staged-but-
 *        uncommitted files anywhere.
 *     4. (Implicit in 3) No git-status entries of other shapes.
 *     5. `gh` CLI authenticated — `gh auth status` exits 0.
 *     6. No concurrent autocommit (lockfile under .claude/learning).
 *
 *   On success: branch `chore/coc-telemetry-auto-<UTC-ts>` lands via
 *   `gh pr merge --admin --merge --delete-branch`, then main is
 *   `git pull --ff-only`'d.
 *
 *   On any failure: best-effort cleanup (switch back to main, delete
 *   local branch if created), release lockfile, exit 0. Failure
 *   leaves drift exactly as it was — next session's SessionStart
 *   drift warning takes over (the existing land-as-PR-#1 flow).
 *
 *   Carries forward .session-notes:48-50 (2026-05-12) open question:
 *   "should `.claude/learning/*.jsonl` be added to a hook-skip or
 *   commit-on-Stop path so telemetry stops being a per-session PR?"
 *   User picked commit-on-Stop (2026-05-12).
 *
 *   Per coc-sync-landing.md MUST-2: stages explicit paths only,
 *   never `git add -A` / `-u` / `.`.
 *   Per feedback_sync_script_commit_heredoc.md: uses `git commit -F
 *   /tmp/<file>` rather than `-m "$(cat <<EOF...)"`.
 *   Per cc-artifacts.md Rule 7: setTimeout fallback returns
 *   `{continue: true}` and exits 0.
 *   Per hook-output-discipline.md MUST-1: this is a NON-halting
 *   hook (always continue:true), so the instructAndWait shape does
 *   not apply.
 *
 * Exit codes:
 *   0 = success or no-op — never blocks session shutdown.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TIMEOUT_MS = 25000;
const _timeout = setTimeout(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}, TIMEOUT_MS);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TELEMETRY_PATHS = [
  ".claude/learning/observations.jsonl",
  ".claude/learning/violations.jsonl",
];
const LEARNING_DIR = path.join(PROJECT_DIR, ".claude/learning");
const LOCKFILE = path.join(LEARNING_DIR, ".autocommit.lock");
const LOG_DIR = path.join(PROJECT_DIR, ".claude/logs");
const LOG_FILE = path.join(LOG_DIR, "coc-telemetry-autocommit.log");
const LOCK_STALE_MS = 5 * 60 * 1000;

function log(msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch (_) {}
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: PROJECT_DIR,
    encoding: "utf8",
  });
  return {
    code: typeof r.status === "number" ? r.status : -1,
    stdout: (r.stdout || "").toString(),
    stderr: (r.stderr || "").toString(),
    ok: r.status === 0,
  };
}

/**
 * Pure gate evaluator. Returns { proceed, reason }.
 * Inputs are explicit so the function is unit-testable; live calls
 * pass the actual filesystem + git probes from main().
 */
function evaluateGates({
  syncManifestExists,
  lockfilePresent,
  lockfileAgeMs,
  branch,
  porcelainLines, // array of "XY path" strings; empty if no drift
  ghAuthOk,
}) {
  if (!syncManifestExists)
    return { proceed: false, reason: "not loom (no sync-manifest.yaml)" };
  if (lockfilePresent && lockfileAgeMs < LOCK_STALE_MS) {
    return {
      proceed: false,
      reason: `lockfile present (age ${Math.round(lockfileAgeMs / 1000)}s < ${LOCK_STALE_MS / 1000}s)`,
    };
  }
  if (branch !== "main")
    return { proceed: false, reason: `not on main (on ${branch})` };
  if (!porcelainLines || porcelainLines.length === 0)
    return { proceed: false, reason: "no drift" };
  for (const line of porcelainLines) {
    if (line.length < 4)
      return {
        proceed: false,
        reason: `malformed porcelain line: ${JSON.stringify(line)}`,
      };
    const xy = line.slice(0, 2);
    const file = line.slice(3);
    // Only allow " M <telemetry-path>" (unstaged modification, no rename target)
    if (xy !== " M")
      return {
        proceed: false,
        reason: `non-telemetry change shape: [${xy}] ${file}`,
      };
    if (!TELEMETRY_PATHS.includes(file))
      return { proceed: false, reason: `non-telemetry path: ${file}` };
  }
  if (!ghAuthOk) return { proceed: false, reason: "gh CLI not authenticated" };
  return { proceed: true, reason: "all gates pass" };
}

function readPorcelainLines() {
  const r = run("git", ["status", "--porcelain"]);
  if (!r.ok) return null;
  return r.stdout.split("\n").filter((l) => l.length > 0);
}

function readBranch() {
  const r = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!r.ok) return null;
  return r.stdout.trim();
}

function checkGhAuth() {
  const r = run("gh", ["auth", "status"]);
  return r.ok;
}

function cleanupLocalBranch(branchName) {
  // Best-effort: switch back to main; delete local branch if it exists.
  run("git", ["checkout", "main"]);
  if (branchName) run("git", ["branch", "-D", branchName]);
}

function doAutocommit() {
  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[-:T.]/g, "")
    .slice(0, 14); // YYYYMMDDHHMMSS
  const dateLabel = now.toISOString().slice(0, 10);
  const newBranch = `chore/coc-telemetry-auto-${ts}`;
  let createdBranch = null;
  let msgFile = null;

  try {
    // Step 1: create branch
    let r = run("git", ["checkout", "-b", newBranch]);
    if (!r.ok)
      throw new Error(`checkout -b ${newBranch} failed: ${r.stderr.trim()}`);
    createdBranch = newBranch;

    // Step 2: stage EXPLICIT paths (coc-sync-landing.md MUST-2 — no -A/-u/.)
    r = run("git", ["add", ...TELEMETRY_PATHS]);
    if (!r.ok) throw new Error(`git add failed: ${r.stderr.trim()}`);

    // Step 3: commit via -F file (feedback_sync_script_commit_heredoc.md)
    msgFile = path.join(
      os.tmpdir(),
      `coc-telemetry-${process.pid}-${Date.now()}.txt`,
    );
    const body = [
      `chore(coc): land learning telemetry — ${dateLabel} (auto)`,
      "",
      "Auto-commit-on-SessionEnd per .claude/hooks/coc-telemetry-autocommit.js.",
      "Routine telemetry drift (.claude/learning/observations.jsonl +",
      "violations.jsonl) accumulated this session.",
      "",
      "Staged with explicit paths per coc-sync-landing.md MUST-2.",
      "Replaces the per-session chore/coc-telemetry-<date> PR cycle.",
    ].join("\n");
    fs.writeFileSync(msgFile, body);

    r = run("git", ["commit", "-F", msgFile]);
    if (!r.ok) throw new Error(`git commit failed: ${r.stderr.trim()}`);

    // Step 4: push
    r = run("git", ["push", "-u", "origin", newBranch]);
    if (!r.ok) throw new Error(`git push failed: ${r.stderr.trim()}`);

    // Step 5: open PR
    const prBody = [
      "Auto-commit-on-SessionEnd per `.claude/hooks/coc-telemetry-autocommit.js`.",
      "",
      "Routine telemetry drift; same shape as the prior `chore/coc-telemetry-<date>` PRs (#149, #151).",
      "Staged with explicit paths per `coc-sync-landing.md` MUST-2.",
    ].join("\n");
    r = run("gh", [
      "pr",
      "create",
      "--title",
      `chore(coc): land learning telemetry — ${dateLabel} (auto)`,
      "--body",
      prBody,
    ]);
    if (!r.ok) throw new Error(`gh pr create failed: ${r.stderr.trim()}`);
    const prUrl = r.stdout.trim();
    const m = prUrl.match(/\/pull\/(\d+)/);
    if (!m) throw new Error(`gh pr create returned no PR number: ${prUrl}`);
    const prNum = m[1];

    // Step 6: admin merge
    r = run("gh", [
      "pr",
      "merge",
      prNum,
      "--admin",
      "--merge",
      "--delete-branch",
    ]);
    if (!r.ok)
      throw new Error(`gh pr merge #${prNum} failed: ${r.stderr.trim()}`);

    // Step 7: back to main + ff
    r = run("git", ["checkout", "main"]);
    if (!r.ok) throw new Error(`git checkout main failed: ${r.stderr.trim()}`);
    r = run("git", ["pull", "--ff-only"]);
    if (!r.ok) throw new Error(`git pull --ff-only failed: ${r.stderr.trim()}`);

    log(
      `SUCCESS PR #${prNum} merged; main fast-forwarded; branch ${newBranch} deleted`,
    );
    process.stderr.write(
      `[coc-telemetry-autocommit] PR #${prNum} merged — telemetry landed on main\n`,
    );
    return true;
  } catch (e) {
    log(`FAIL: ${e.message}`);
    process.stderr.write(
      `[coc-telemetry-autocommit] no-op: ${e.message.slice(0, 240)}\n`,
    );
    try {
      cleanupLocalBranch(createdBranch);
    } catch (_) {}
    return false;
  } finally {
    if (msgFile) {
      try {
        if (fs.existsSync(msgFile)) fs.unlinkSync(msgFile);
      } catch (_) {}
    }
  }
}

function main() {
  // Probe filesystem + git state.
  const syncManifestExists = fs.existsSync(
    path.join(PROJECT_DIR, ".claude/sync-manifest.yaml"),
  );
  let lockfilePresent = false;
  let lockfileAgeMs = 0;
  try {
    const stat = fs.statSync(LOCKFILE);
    lockfilePresent = true;
    lockfileAgeMs = Date.now() - stat.mtimeMs;
  } catch (_) {}
  const branch = syncManifestExists ? readBranch() : null;
  const porcelainLines = syncManifestExists ? readPorcelainLines() : null;
  // Only spend on gh auth probe if earlier gates look promising.
  const earlyOk =
    syncManifestExists &&
    branch === "main" &&
    porcelainLines &&
    porcelainLines.length > 0 &&
    porcelainLines.every(
      (l) => l.startsWith(" M ") && TELEMETRY_PATHS.includes(l.slice(3)),
    );
  const ghAuthOk = earlyOk ? checkGhAuth() : false;

  const verdict = evaluateGates({
    syncManifestExists,
    lockfilePresent,
    lockfileAgeMs,
    branch: branch || "<unknown>",
    porcelainLines: porcelainLines || [],
    ghAuthOk,
  });

  if (!verdict.proceed) {
    log(`no-op: ${verdict.reason}`);
    clearTimeout(_timeout);
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
    return;
  }

  // Acquire lockfile.
  try {
    fs.mkdirSync(LEARNING_DIR, { recursive: true });
    fs.writeFileSync(
      LOCKFILE,
      `${process.pid}\n${new Date().toISOString()}\n`,
      {
        flag: "wx",
      },
    );
  } catch (e) {
    log(`no-op: lockfile acquire failed: ${e.message}`);
    clearTimeout(_timeout);
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
    return;
  }

  try {
    doAutocommit();
  } finally {
    try {
      fs.unlinkSync(LOCKFILE);
    } catch (_) {}
  }

  clearTimeout(_timeout);
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}

// SessionEnd payload: drain stdin (we don't use its content but CC sends one).
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    main();
  } catch (e) {
    log(`fatal: ${e && e.message}`);
    clearTimeout(_timeout);
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }
});

// Exported for unit testing — does not affect hook runtime.
if (require.main !== module) {
  module.exports = { evaluateGates, TELEMETRY_PATHS, LOCK_STALE_MS };
}
