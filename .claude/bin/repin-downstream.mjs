#!/usr/bin/env node
/*
 * ============================================================================
 *  ⚠️  OPERATOR OVERRIDE TOOL — NOT THE DEFAULT FLOW  ⚠️
 * ============================================================================
 *
 *  This script makes loom reach INTO downstream repos to create branches,
 *  commits, and PRs. That violates the downstream-responsibility principle:
 *
 *    "Loom's outbound path ends at the USE template. Each downstream repo's
 *     OWN /sync session pulls from the new template and updates its own pin."
 *
 *  See `rules/artifact-flow.md` § "/sync Is the Only Outbound Path" + user
 *  feedback memory `feedback_downstream_responsibility.md` (2026-04-05).
 *
 *  DEFAULT FLOW (no loom intervention required):
 *    1. aerith / aether / aegis / ... session opens in that downstream repo
 *    2. operator updates `.claude/VERSION` → `upstream.template` locally
 *       (e.g. `kailash-coc-claude-py` → `kailash-coc-py`)
 *    3. operator runs `/sync` inside the downstream repo
 *    4. downstream /sync pulls from the new USE template and reports
 *    5. operator commits + opens PR per the downstream's own governance
 *
 *  USE THIS SCRIPT ONLY WHEN:
 *    - the user has explicitly authorized bulk fan-out from loom
 *    - all affected downstream repos are pre-audited clean (no dirty state,
 *      no uncommitted in-progress branches)
 *    - the re-pin is a within-language URL swap (claude-py → py, claude-rs
 *      → rs). For cross-language correction (e.g. py → rs when the repo is
 *      actually a Rust consumer), do NOT use this script — the repo's own
 *      session fixes the variant + template together.
 *
 *  The dry-run mode is safe to run any time (read-only survey). --apply is
 *  the override gate.
 *
 * ============================================================================
 *
 * Downstream Re-pin Helper — Phase I1 multi-CLI USE template migration
 *
 * Loom shipped new USE templates under the names:
 *   terrene-foundation/kailash-coc-py
 *   terrene-foundation/kailash-coc-rs
 *
 * …replacing the legacy names:
 *   terrene-foundation/kailash-coc-claude-py
 *   terrene-foundation/kailash-coc-claude-rs
 *
 * Per the r3 migration decision, every downstream repo must EXPLICITLY
 * re-pin its `.claude/VERSION` file to the new template name (no GitHub
 * silent-redirect shortcut). This script surveys a shard of downstream
 * repos, shows the proposed edit in dry-run, or in --apply mode creates
 * a branch, commits the edit, pushes, and opens a PR.
 *
 * Usage:
 *   node .claude/bin/repin-downstream.mjs --shard I1a            (dry-run)
 *   node .claude/bin/repin-downstream.mjs --shard all            (dry-run)
 *   node .claude/bin/repin-downstream.mjs --shard I1b --apply    (mutate — override)
 *
 * Exit codes: 0 = pass; 1 = per-repo failure(s); 2 = usage error.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ────────────────────────────────────────────────────────────────
// Shard definitions — absolute filesystem paths per migration plan
// ────────────────────────────────────────────────────────────────
const HOME = process.env.HOME || "/Users/esperie";
const R = (p) => path.join(HOME, "repos", p);

const SHARDS = {
  I1a: [
    R("terrene/foundation"),
    R("terrene/publications"),
    R("terrene/website"),
    R("terrene/arbor"),
    R("terrene/astra"),
    R("terrene/care"),
    R("terrene/pact"),
    R("terrene/praxis"),
  ],
  I1b: [
    R("dev/aegis"),
    R("dev/aerith"),
    R("dev/aether"),
    R("dev/astra"),
    R("dev/coursewright"),
    R("dev/flutter"),
    R("dev/envoy"),
  ],
  I1c: [
    R("tpc/impact-verse"),
    R("tpc/journeymate"),
    R("tpc/talentverse"),
    R("tpc/aspire-treasury"),
    R("tpc/impact_week"),
    R("tpc/stp"),
    R("tpc/tpc_backend"),
    R("tpc/tpc_cash_treasury"),
  ],
  I1d: [
    R("rr/agentic-os"),
    R("rr/rr_helpcentre"),
    R("rr/rr_lead_to_cash"),
    R("rr/rr-aegis"),
    R("rr/rr-agentic-os"),
    R("hmi/hana"),
    R("hmi/hmi-chatbot"),
  ],
  I1e: [
    R("projects/alex3"),
    R("projects/gba"),
    R("projects/byregot"),
    R("projects/metis"),
    R("projects/midas"),
    R("projects/building-management"),
    R("projects/motion"),
    R("projects/portfolio-manager"),
    R("projects/solar"),
    R("projects/ideas"),
    R("loom/kz-engage"),
    R("loom/kaizen-cli-py"),
  ],
};

// Legacy → new template name map (per r3 decision)
const RENAME_MAP = {
  "kailash-coc-claude-py": "kailash-coc-py",
  "kailash-coc-claude-rs": "kailash-coc-rs",
};
const OWNER = "terrene-foundation";

// ────────────────────────────────────────────────────────────────
// CLI arg parsing
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { shard: null, mode: "dry-run", exclude: new Set() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--shard") args.shard = argv[++i];
    else if (a === "--dry-run") args.mode = "dry-run";
    else if (a === "--apply") args.mode = "apply";
    else if (a === "--exclude") {
      for (const name of (argv[++i] || "").split(",").filter(Boolean)) {
        args.exclude.add(name);
      }
    } else if (a === "--help" || a === "-h") args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function usage() {
  console.log(
    `Usage: node .claude/bin/repin-downstream.mjs --shard {I1a|I1b|I1c|I1d|I1e|all} [--dry-run|--apply]

Default mode: --dry-run (safer default).

Shards:
  I1a  terrene/ (${SHARDS.I1a.length} repos)
  I1b  dev/     (${SHARDS.I1b.length} repos)
  I1c  tpc/     (${SHARDS.I1c.length} repos)
  I1d  rr/+hmi/ (${SHARDS.I1d.length} repos)
  I1e  projects/+training/+loom-downstream (${SHARDS.I1e.length} repos)
  all  every shard combined

Re-pins legacy kailash-coc-claude-{py,rs} to new kailash-coc-{py,rs} in
each downstream repo's .claude/VERSION file.`,
  );
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function shMaybe(cmd, args, opts = {}) {
  try {
    return { ok: true, out: sh(cmd, args, opts).trim() };
  } catch (e) {
    return { ok: false, err: e.stderr?.toString() || e.message };
  }
}

function planRewrite(versionJson) {
  // Returns { changed, oldTemplate, newTemplate, oldRepo, newRepo, updated }
  const up = versionJson.upstream;
  if (!up || typeof up !== "object") {
    return { changed: false, reason: "no upstream object" };
  }
  const oldTemplate = up.template;
  const oldRepo = up.template_repo;

  const newTemplate = oldTemplate && RENAME_MAP[oldTemplate];
  if (!newTemplate) {
    return {
      changed: false,
      reason: oldTemplate
        ? `template '${oldTemplate}' not in rename map (already re-pinned?)`
        : "no upstream.template field",
      oldTemplate,
    };
  }
  const newRepo = `${OWNER}/${newTemplate}`;

  // Build new upstream object
  const updatedUpstream = { ...up, template: newTemplate };
  if (oldRepo) updatedUpstream.template_repo = newRepo;
  // Always stamp template_repo so downstream has full path going forward
  else updatedUpstream.template_repo = newRepo;

  const updated = { ...versionJson, upstream: updatedUpstream };
  return {
    changed: true,
    oldTemplate,
    newTemplate,
    oldRepo: oldRepo || "(not set)",
    newRepo,
    updated,
  };
}

function formatJson(obj) {
  // Preserve 2-space indent + trailing newline — matches existing files.
  return JSON.stringify(obj, null, 2) + "\n";
}

function parseOriginOwnerRepo(repoPath) {
  const r = shMaybe("git", ["-C", repoPath, "remote", "get-url", "origin"]);
  if (!r.ok) return null;
  const url = r.out;
  // git@github.com:owner/name.git  |  https://github.com/owner/name.git
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) return null;
  return { owner: m[1], name: m[2], url };
}

// ────────────────────────────────────────────────────────────────
// Per-repo processing
// ────────────────────────────────────────────────────────────────
const BRANCH = "chore/repin-upstream-multi-cli";
const COMMIT_TITLE = "chore: re-pin upstream to multi-CLI USE template";

function commitBody(rw) {
  return [
    "",
    "Loom has shipped new USE templates under the names",
    `  ${OWNER}/kailash-coc-py`,
    `  ${OWNER}/kailash-coc-rs`,
    "replacing the legacy names",
    `  ${OWNER}/kailash-coc-claude-py`,
    `  ${OWNER}/kailash-coc-claude-rs`,
    "",
    "Per the Phase I1 migration decision, downstream repos re-pin",
    "explicitly (no silent GitHub redirect). This commit updates",
    ".claude/VERSION.upstream.{template,template_repo} from the",
    "legacy name to the new multi-CLI template name.",
    "",
    `Before: template='${rw.oldTemplate}' template_repo='${rw.oldRepo}'`,
    `After:  template='${rw.newTemplate}' template_repo='${rw.newRepo}'`,
    "",
    "See loom migration plan (workspaces/multi-cli-coc/02-plans) Phase I1.",
  ].join("\n");
}

function processRepo(repoPath, mode) {
  const name = path.basename(repoPath);
  const rec = { repo: name, path: repoPath, status: "", detail: "" };

  if (!fs.existsSync(repoPath)) {
    rec.status = "skip";
    rec.detail = "repo directory not found locally";
    return rec;
  }
  const verPath = path.join(repoPath, ".claude", "VERSION");
  if (!fs.existsSync(verPath)) {
    rec.status = "skip";
    rec.detail = ".claude/VERSION missing";
    return rec;
  }

  let raw, json;
  try {
    raw = fs.readFileSync(verPath, "utf8");
    json = JSON.parse(raw);
  } catch (e) {
    rec.status = "fail";
    rec.detail = `VERSION parse error: ${e.message}`;
    return rec;
  }

  const rw = planRewrite(json);
  if (!rw.changed) {
    rec.status = "skip";
    rec.detail = rw.reason;
    rec.oldTemplate = rw.oldTemplate;
    return rec;
  }

  rec.oldTemplate = rw.oldTemplate;
  rec.newTemplate = rw.newTemplate;
  rec.oldRepo = rw.oldRepo;
  rec.newRepo = rw.newRepo;

  if (mode === "dry-run") {
    rec.status = "dry";
    rec.detail = `${rw.oldTemplate} → ${rw.newTemplate}`;
    return rec;
  }

  // --apply path below
  const newContent = formatJson(rw.updated);

  // 1. Check working tree is clean (else we'd smuggle unrelated changes)
  const status = shMaybe("git", ["-C", repoPath, "status", "--porcelain"]);
  if (!status.ok) {
    rec.status = "fail";
    rec.detail = `git status failed: ${status.err}`;
    return rec;
  }
  if (status.out !== "") {
    rec.status = "fail";
    rec.detail = "working tree not clean; refusing to commit over local changes";
    return rec;
  }

  // 2. Fetch origin main + create/switch branch
  shMaybe("git", ["-C", repoPath, "fetch", "origin", "main", "--quiet"]);

  // Does the branch already exist locally?
  const branchExists = shMaybe("git", [
    "-C",
    repoPath,
    "rev-parse",
    "--verify",
    BRANCH,
  ]).ok;

  if (branchExists) {
    const co = shMaybe("git", ["-C", repoPath, "checkout", BRANCH]);
    if (!co.ok) {
      rec.status = "fail";
      rec.detail = `checkout ${BRANCH} failed: ${co.err}`;
      return rec;
    }
  } else {
    // Ensure we branch from main (or current default)
    const co = shMaybe("git", [
      "-C",
      repoPath,
      "checkout",
      "-b",
      BRANCH,
      "origin/main",
    ]);
    if (!co.ok) {
      // Fallback: branch from whatever HEAD is
      const co2 = shMaybe("git", ["-C", repoPath, "checkout", "-b", BRANCH]);
      if (!co2.ok) {
        rec.status = "fail";
        rec.detail = `branch create failed: ${co.err}`;
        return rec;
      }
    }
  }

  // 3. Write file
  try {
    fs.writeFileSync(verPath, newContent);
  } catch (e) {
    rec.status = "fail";
    rec.detail = `write failed: ${e.message}`;
    return rec;
  }

  // 4. Stage + commit
  const add = shMaybe("git", ["-C", repoPath, "add", ".claude/VERSION"]);
  if (!add.ok) {
    rec.status = "fail";
    rec.detail = `git add failed: ${add.err}`;
    return rec;
  }

  const commitMsg = COMMIT_TITLE + "\n" + commitBody(rw);
  const commit = shMaybe("git", [
    "-C",
    repoPath,
    "commit",
    "-m",
    commitMsg,
  ]);
  if (!commit.ok) {
    rec.status = "fail";
    rec.detail = `git commit failed: ${commit.err}`;
    return rec;
  }

  // 5. Push
  const push = shMaybe("git", [
    "-C",
    repoPath,
    "push",
    "-u",
    "origin",
    BRANCH,
  ]);
  if (!push.ok) {
    rec.status = "fail";
    rec.detail = `git push failed: ${push.err}`;
    return rec;
  }

  // 6. gh pr create
  const prBody =
    `## Summary\n\n` +
    `Re-pins \`.claude/VERSION.upstream\` from legacy ` +
    `\`${rw.oldTemplate}\` to new multi-CLI template ` +
    `\`${rw.newTemplate}\`.\n\n` +
    `Loom Phase I1 migration — downstream repos re-pin explicitly ` +
    `(no silent GitHub redirect).\n\n` +
    `## Test plan\n\n` +
    `- [ ] Run next \`/sync\` from the downstream repo — should resolve ` +
    `the new template.\n` +
    `- [ ] Verify \`.claude/VERSION\` parses as JSON and ` +
    `\`upstream.template\` equals \`${rw.newTemplate}\`.\n`;

  // gh runs against the repo in cwd
  const pr = shMaybe(
    "gh",
    [
      "pr",
      "create",
      "--title",
      COMMIT_TITLE,
      "--body",
      prBody,
      "--base",
      "main",
      "--head",
      BRANCH,
    ],
    { cwd: repoPath },
  );
  if (!pr.ok) {
    rec.status = "fail";
    rec.detail = `gh pr create failed: ${pr.err}`;
    return rec;
  }

  rec.status = "applied";
  rec.detail = `PR: ${pr.out.split("\n").pop()}`;
  return rec;
}

// ────────────────────────────────────────────────────────────────
// Output
// ────────────────────────────────────────────────────────────────
function renderTable(records, mode) {
  const rows = [];
  rows.push(
    `| Repo | Status | Old template | New template | Detail |`,
  );
  rows.push(`| --- | --- | --- | --- | --- |`);
  for (const r of records) {
    rows.push(
      `| ${r.repo} | ${r.status} | ${r.oldTemplate || "-"} | ${
        r.newTemplate || "-"
      } | ${r.detail || ""} |`,
    );
  }
  return rows.join("\n");
}

function summarize(records, mode, shardLabel) {
  const counts = { dry: 0, applied: 0, skip: 0, fail: 0 };
  for (const r of records) counts[r.status] = (counts[r.status] || 0) + 1;

  console.log("");
  console.log(`=== Re-pin summary — shard ${shardLabel} (${mode}) ===`);
  console.log(renderTable(records, mode));
  console.log("");
  console.log(
    `Aggregate: ${records.length} total | ` +
      `${counts.dry || 0} would-change (dry-run) | ` +
      `${counts.applied || 0} applied | ` +
      `${counts.skip || 0} skipped | ` +
      `${counts.fail || 0} failed`,
  );
  if (counts.fail > 0) return 1;
  return 0;
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv);

if (args.help || !args.shard) {
  usage();
  process.exit(args.shard ? 0 : 2);
}

let repos;
let shardLabel;
if (args.shard === "all") {
  repos = [].concat(...Object.values(SHARDS));
  shardLabel = "all";
} else if (SHARDS[args.shard]) {
  repos = SHARDS[args.shard];
  shardLabel = args.shard;
} else {
  console.error(`Unknown shard: ${args.shard}`);
  usage();
  process.exit(2);
}

const excluded = [];
repos = repos.filter((p) => {
  const name = path.basename(p);
  if (args.exclude.has(name)) {
    excluded.push(name);
    return false;
  }
  return true;
});

if (args.mode === "apply") {
  console.error(
    "WARNING: --apply creates branches and PRs INSIDE downstream repos.",
  );
  console.error(
    "         This circumvents the downstream-responsibility principle:",
  );
  console.error(
    "         each downstream repo should normally run its own /sync after",
  );
  console.error(
    "         manually updating its .claude/VERSION pin. Use --apply only",
  );
  console.error(
    "         when an operator has explicitly authorized bulk fan-out.",
  );
  console.error("");
}

console.log(
  `repin-downstream: shard=${shardLabel} mode=${args.mode} repos=${repos.length}${excluded.length ? ` (excluded: ${excluded.join(", ")})` : ""}`,
);
console.log("");

const records = [];
for (const repoPath of repos) {
  process.stdout.write(`  - ${path.basename(repoPath)} ... `);
  const rec = processRepo(repoPath, args.mode);
  records.push(rec);
  console.log(`${rec.status} (${rec.detail || "-"})`);
}

const exitCode = summarize(records, args.mode, shardLabel);
process.exit(exitCode);
