"use strict";
// lane-worktree-root — the operator's DECLARED parent directory for linked lane
// worktrees. It is the ONLY place a linked worktree of the installed repository
// may live and still count as a checkout of it (codex-rule-context.js::checkoutTop).
//
// SOURCE. The operator-local linkage registry loom's tools already read
// (bin/lib/loom-links.mjs): top-level key `laneWorktreeRoot` in
// `.claude/bin/loom-links.local.json` of the installed checkout, or in the file
// named by $LOOM_LINKS_CONFIG, which takes precedence exactly as it does there.
// Read directly here: a hook must not import that ESM bin lib, which does not
// ship to consumers.
//
// VALUE. An absolute path, or `~` / `~/…` (expanded against the home dir). It is
// canonicalized with realpathSync.native (on-disk case, symlinks resolved), the
// same resolver checkoutTop compares tops with, so a symlinked declaration
// declares its TARGET and nothing else.
//
// FAIL CLOSED. Returns null — meaning NO linked worktree is accepted — when the
// file is missing, unreadable, oversized or malformed; when the key is absent or
// not such a path; when it does not resolve to an existing directory; or when it
// resolves to the installed root, to anything inside it, or to one of its
// ancestors (a parent like `/` or the repos root would admit every sibling
// repository). A CONSUMER repo (USE template, downstream project) ships no
// loom-links.local.json, so it ALWAYS fails closed: typed edits there stay inside
// the installed root. That is the intended default, not a gap.
//
// NOT FENCED HERE: who may WRITE the registry. Whatever directory it declares is
// honoured; protecting the file itself is the write fences' job.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONFIG_MAX = 64 * 1024;

function configPath(root) {
  const env = process.env.LOOM_LINKS_CONFIG;
  if (env) return path.isAbsolute(env) ? env : null;
  return path.join(root, ".claude", "bin", "loom-links.local.json");
}

function contains(outer, inner) {
  const rel = path.relative(outer, inner);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The canonical declared lane-worktree parent for installed root `root`, or null. */
function laneWorktreeRoot(root) {
  try {
    const file = configPath(root);
    if (!file) return null;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > CONFIG_MAX) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"))?.laneWorktreeRoot;
    if (typeof value !== "string" || !value || value.includes("\0")) return null;
    const expanded = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
    if (!path.isAbsolute(expanded)) return null;
    const parent = fs.realpathSync.native(expanded);
    if (!fs.statSync(parent).isDirectory()) return null;
    const top = fs.realpathSync.native(root);
    if (contains(top, parent) || contains(parent, top)) return null;
    return parent;
  } catch { return null; } // fail closed: any read/parse/resolve failure ⇒ no declared parent
}

module.exports = { laneWorktreeRoot };
