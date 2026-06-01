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
 *    1. a downstream repo session opens in that repo
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
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveShard as loomLinksResolveShard,
  isConfigured as loomLinksConfigured,
  LinkError,
} from "./lib/loom-links.mjs";

// ────────────────────────────────────────────────────────────────
// Shard registry — loaded from an operator-local, gitignored config
// ────────────────────────────────────────────────────────────────
//
// The downstream-repo registry is NOT shipped inline in this script.
// It correlated every engagement/consumer repo in one synced file
// (`bin/**` is a sync tier), which is the issue #255 / #252 disclosure
// class. The registry now lives in a gitignored operator-local file;
// this script ships only the loader + a committed schema template.
//
//   config (gitignored): .claude/bin/repin-targets.local.json
//   schema (committed):   .claude/bin/repin-targets.local.example.json
//   override:             $REPIN_TARGETS_CONFIG (absolute path)
//
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH =
  process.env.REPIN_TARGETS_CONFIG ||
  path.join(SCRIPT_DIR, "repin-targets.local.json");
const EXAMPLE_PATH = path.join(SCRIPT_DIR, "repin-targets.local.example.json");

function expandHome(p) {
  const home = process.env.HOME || os.homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function configError(msg) {
  console.error(`repin-downstream: ${msg}`);
  process.exit(2);
}

// Legacy loader — repin-targets.local.json (the pre-Phase-2 config).
// Behaviour preserved EXACTLY for operators who have not migrated.
function loadShardsLegacy() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const rel = (p) => path.relative(process.cwd(), p) || p;
    configError(
      `registry config not found at ${CONFIG_PATH}\n\n` +
        `This script no longer ships the downstream-repo registry inline\n` +
        `(it correlated every engagement in one synced file — issue #255).\n\n` +
        `To use it, copy the committed template and fill in your paths:\n` +
        `  cp ${rel(EXAMPLE_PATH)} ${rel(CONFIG_PATH)}\n` +
        `  $EDITOR ${rel(CONFIG_PATH)}\n\n` +
        `The local file is gitignored and is never committed or synced.`,
    );
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    configError(`config parse error in ${CONFIG_PATH}: ${e.message}`);
  }
  if (!cfg || typeof cfg.shards !== "object" || cfg.shards === null) {
    configError(`config ${CONFIG_PATH} missing required 'shards' object`);
  }
  const reposRoot = expandHome(
    cfg.reposRoot || path.join(process.env.HOME || os.homedir(), "repos"),
  );
  const shards = {};
  for (const [name, rels] of Object.entries(cfg.shards)) {
    if (name.startsWith("_")) continue; // _README / _comment keys are ignored
    if (!Array.isArray(rels)) {
      configError(
        `shard '${name}' must be an array of repo-relative paths`,
      );
    }
    shards[name] = rels.map((rel) => path.join(reposRoot, rel));
  }
  if (Object.keys(shards).length === 0) {
    configError(`config ${CONFIG_PATH} defines no shards`);
  }
  return shards;
}

// ────────────────────────────────────────────────────────────────
// Phase-2 unify shim — shared loom-links resolver, legacy fallback
// ────────────────────────────────────────────────────────────────
//
// Source precedence:
//   1. loom-links config present (loom-links.local.json or
//      $LOOM_LINKS_CONFIG)  → resolve `shards` via loom-links.mjs.
//   2. else legacy repin-targets.local.json present → use it AND emit
//      a one-time stderr migrate notice (behaviour byte-identical).
//   3. else → legacy fail-loud message (unchanged from #255).
//
// For an operator with EITHER file, dry-run output is unchanged: both
// loaders join shard-relative paths to reposRoot the same way.
function loadShards() {
  if (loomLinksConfigured()) {
    // Resolve every shard name through the shared resolver. We need the
    // shard NAMES too (usage() lists them, --shard <name> selects one),
    // so read the config object once for its label set, then resolve
    // each label's absolute paths via loom-links.mjs::resolveShard.
    let cfg;
    try {
      const cfgPath =
        process.env.LOOM_LINKS_CONFIG && process.env.LOOM_LINKS_CONFIG.trim()
          ? process.env.LOOM_LINKS_CONFIG
          : path.join(SCRIPT_DIR, "loom-links.local.json");
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch (e) {
      configError(`loom-links config parse error: ${e.message}`);
    }
    if (!cfg || typeof cfg.shards !== "object" || cfg.shards === null) {
      configError(
        `loom-links config has no 'shards' block (required by repin-downstream).\n` +
          `Add a 'shards' object — see loom-links.local.example.json.`,
      );
    }
    const shards = {};
    try {
      for (const name of Object.keys(cfg.shards)) {
        if (name.startsWith("_")) continue;
        shards[name] = loomLinksResolveShard(name);
      }
    } catch (e) {
      configError(
        e instanceof LinkError ? e.message : `loom-links: ${e.message}`,
      );
    }
    if (Object.keys(shards).length === 0) {
      configError(`loom-links config defines no shards`);
    }
    return shards;
  }

  // No loom-links config — fall back to the legacy file.
  if (fs.existsSync(CONFIG_PATH)) {
    const rel = (p) => path.relative(process.cwd(), p) || p;
    console.error(
      `repin-downstream: NOTE — using legacy ${rel(CONFIG_PATH)}.\n` +
        `  Migrate to loom-links.local.json (see loom-links.local.example.json):\n` +
        `  the shared linkage resolver replaces this tool-specific registry.\n`,
    );
  }
  return loadShardsLegacy();
}

const SHARDS = loadShards();

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
  const names = Object.keys(SHARDS);
  const shardLines = names
    .map((n) => `  ${n}  (${SHARDS[n].length} repos)`)
    .join("\n");
  console.log(
    `Usage: node .claude/bin/repin-downstream.mjs --shard {${names.join(
      "|",
    )}|all} [--dry-run|--apply]

Default mode: --dry-run (safer default).

Shard registry is loaded from an operator-local, gitignored config
(${CONFIG_PATH}); see repin-targets.local.example.json for the schema.

Shards:
${shardLines}
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
