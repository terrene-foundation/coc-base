#!/usr/bin/env node
/*
 * ============================================================================
 *  loom-links-init — reversible bootstrap importer (Phase-2, Shard 1)
 * ============================================================================
 *
 *  Scans the reposRoot for repo basenames that match the loom-links key
 *  vocabulary and PRINTS a proposed loom-links.local.json to stdout. It
 *  writes the file ONLY with --write, and refuses to overwrite an
 *  existing local file without --force. No silent guessing: a known key
 *  is proposed only when a matching directory is actually found on disk;
 *  anything else is left for the operator to fill in.
 *
 *  Disclosure discipline (issue #263): this script is a SYNCED artifact.
 *  It embeds NO real paths/orgs. The proposed JSON it prints is derived
 *  at runtime from the operator's own filesystem and is written ONLY to
 *  the gitignored loom-links.local.json (never committed/synced).
 *
 *  Usage:
 *    node .claude/bin/loom-links-init.mjs              print proposal
 *    node .claude/bin/loom-links-init.mjs --write      write local file
 *    node .claude/bin/loom-links-init.mjs --write --force   overwrite
 *    node .claude/bin/loom-links-init.mjs --help
 *
 *  reposRoot resolution: $LOOM_LINKS_CONFIG's reposRoot if that config
 *  already exists, else --repos-root <dir>, else ~/repos.
 *
 *  Exit codes: 0 = ok; 1 = refused (existing file, no --force);
 *              2 = usage error.
 * ============================================================================
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_CONFIG_PATH = path.join(SCRIPT_DIR, "loom-links.local.json");
const EXAMPLE_PATH = path.join(SCRIPT_DIR, "loom-links.local.example.json");

function expandHome(p) {
  const home = process.env.HOME || os.homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function rel(p) {
  try {
    return path.relative(process.cwd(), p) || p;
  } catch {
    return p;
  }
}

// ────────────────────────────────────────────────────────────────
// Known basename → logical key heuristics. A key is proposed ONLY
// when a directory whose basename matches one of these patterns is
// actually present under reposRoot. Order matters: the FIRST pattern
// that matches a basename wins (more specific patterns first).
// ────────────────────────────────────────────────────────────────
const KEY_RULES = [
  // USE templates (multi-CLI) — must precede the looser build.* rules
  { key: "use-template.claude-py", re: /^kailash-coc-claude-py$/ },
  { key: "use-template.claude-rs", re: /^kailash-coc-claude-rs$/ },
  { key: "use-template.claude-rb", re: /^kailash-coc-claude-rb$/ },
  { key: "use-template.py", re: /^kailash-coc-py$/ },
  { key: "use-template.rs", re: /^kailash-coc-rs$/ },
  { key: "use-template.rb", re: /^kailash-coc-rb$/ },
  // BUILD repos
  { key: "build.prism", re: /^kailash-prism$/ },
  { key: "build.py", re: /^kailash-py$/ },
  { key: "build.rs", re: /^kailash-rs$/ },
  // self + authority
  { key: "loom", re: /^loom$/ },
  { key: "atelier", re: /^atelier$/ },
];

function parseArgs(argv) {
  const a = { write: false, force: false, reposRoot: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") a.write = true;
    else if (arg === "--force") a.force = true;
    else if (arg === "--repos-root") a.reposRoot = argv[++i];
    else if (arg === "--help" || arg === "-h") a.help = true;
    else {
      console.error(`loom-links-init: unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return a;
}

function usage() {
  console.log(
    `loom-links-init — reversible bootstrap importer (Phase-2, Shard 1)

Scans reposRoot for repo basenames matching the loom-links key
vocabulary and proposes a loom-links.local.json. Prints to stdout by
default; writes only with --write; refuses to overwrite without --force.

Usage:
  node .claude/bin/loom-links-init.mjs               print proposal
  node .claude/bin/loom-links-init.mjs --write       write local file
  node .claude/bin/loom-links-init.mjs --write --force
  node .claude/bin/loom-links-init.mjs --repos-root <dir>
  node .claude/bin/loom-links-init.mjs --help

reposRoot: --repos-root <dir>, else the reposRoot from an existing
config ($LOOM_LINKS_CONFIG or loom-links.local.json), else ~/repos.

Exit: 0 ok | 1 refused (file exists, no --force) | 2 usage error.`,
  );
}

function resolveReposRoot(cliReposRoot) {
  if (cliReposRoot) return expandHome(cliReposRoot);
  // Reuse an existing config's reposRoot if one is present.
  const env = process.env.LOOM_LINKS_CONFIG;
  const candidates = [
    env && path.isAbsolute(env) ? env : null,
    LOCAL_CONFIG_PATH,
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(c, "utf8"));
        if (cfg && typeof cfg.reposRoot === "string") {
          return expandHome(cfg.reposRoot);
        }
      } catch {
        // fall through to default — a malformed existing config is not
        // a reason to abort the bootstrap proposal.
      }
    }
  }
  return path.join(process.env.HOME || os.homedir(), "repos");
}

function scanLinks(reposRoot) {
  let entries;
  try {
    entries = fs.readdirSync(reposRoot, { withFileTypes: true });
  } catch (e) {
    console.error(
      `loom-links-init: cannot read reposRoot ${rel(reposRoot)}: ${e.message}`,
    );
    process.exit(2);
  }
  const dirs = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name);

  const links = {};
  const matchedKeys = new Set();
  for (const name of dirs) {
    for (const rule of KEY_RULES) {
      if (matchedKeys.has(rule.key)) continue;
      if (rule.re.test(name)) {
        // store RELATIVE to reposRoot (repin-compatible string entry)
        links[rule.key] = name;
        matchedKeys.add(rule.key);
        break;
      }
    }
  }
  return links;
}

function buildProposal(reposRoot, links) {
  // Mirror the .example file's reposRoot rendering: keep `~/repos`
  // literal when reposRoot is the default home/repos so the written
  // file stays portable; otherwise record the resolved path.
  const home = process.env.HOME || os.homedir();
  const defaultRoot = path.join(home, "repos");
  const reposRootField =
    reposRoot === defaultRoot ? "~/repos" : reposRoot;

  return {
    _README: [
      "Bootstrapped by loom-links-init.mjs. Review every entry before use.",
      "Only repos found on disk under reposRoot were proposed; add any",
      "missing keys (downstream.<slug>, url-only repos, shards) by hand.",
      "See loom-links.local.example.json for the full schema + key vocab.",
      "This file is gitignored and is NEVER committed or synced.",
    ],
    reposRoot: reposRootField,
    links,
  };
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv);
if (args.help) {
  usage();
  process.exit(0);
}

const reposRoot = resolveReposRoot(args.reposRoot);
const links = scanLinks(reposRoot);
const proposal = buildProposal(reposRoot, links);
const json = JSON.stringify(proposal, null, 2) + "\n";

const foundCount = Object.keys(links).length;
console.error(
  `loom-links-init: scanned ${rel(reposRoot)} — matched ${foundCount} known repo(s)`,
);
if (foundCount === 0) {
  console.error(
    `loom-links-init: no known repo basenames found under reposRoot.\n` +
      `Nothing to bootstrap automatically — copy the schema and fill it in:\n` +
      `  cp ${rel(EXAMPLE_PATH)} ${rel(LOCAL_CONFIG_PATH)}`,
  );
}

if (!args.write) {
  // Proposal to stdout (review mode). Diagnostics already on stderr.
  process.stdout.write(json);
  console.error(
    `\nloom-links-init: dry-run (no file written). Re-run with --write to save to\n` +
      `  ${rel(LOCAL_CONFIG_PATH)}`,
  );
  process.exit(0);
}

// --write path
if (fs.existsSync(LOCAL_CONFIG_PATH) && !args.force) {
  console.error(
    `loom-links-init: refusing to overwrite existing ${rel(LOCAL_CONFIG_PATH)}\n` +
      `(re-run with --write --force to overwrite, or edit it by hand).`,
  );
  process.exit(1);
}

try {
  fs.writeFileSync(LOCAL_CONFIG_PATH, json);
} catch (e) {
  console.error(`loom-links-init: write failed: ${e.message}`);
  process.exit(2);
}
console.error(
  `loom-links-init: wrote ${rel(LOCAL_CONFIG_PATH)} (${foundCount} link(s)). ` +
    `Review it; the file is gitignored.`,
);
process.exit(0);
