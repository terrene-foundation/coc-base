#!/usr/bin/env node
/**
 * lib/pending-dedup.js — SessionEnd journal-candidate de-duplication.
 *
 * The SessionEnd hook (`session-end.js::generateJournalCandidates`) captures
 * every journal-worthy commit in a `git log --since=<sessionStart>` window into
 * `workspaces/<active>/journal/.pending/`. Two structural facts make the SAME
 * commit get captured 2–4×:
 *
 *   1. When a session file lacks `startedAt`, the window falls back to
 *      `now − 4h`, so consecutive short sessions re-scan an OVERLAPPING window
 *      and re-capture commits an earlier session already captured.
 *   2. The capture targets whatever workspace is active at session end, so a
 *      commit re-scanned across sessions with different active workspaces lands
 *      in DIFFERENT workspaces' `.pending/` dirs.
 *
 * The result is an inflated `/codify` pending backlog (e.g. one commit present
 * as 4 identical stubs across 2 workspaces) that a codify pass must hand-triage
 * away every cycle. This helper closes the gap: the capture skips any commit
 * whose `source_commit` SHA already appears in a pending stub in ANY workspace.
 *
 * Scope: direct children of `workspaces/` — the only place the capture ever
 * WRITES a stub (it targets the ACTIVE workspace, and active workspaces are
 * direct children; archived `_archive/**` workspaces are never a capture target
 * so their frozen stubs cannot collide with a fresh capture). Keeping the scan
 * one level deep also avoids reading the large `journal/*.md` corpora — only the
 * small `.pending/` dirs are read, honoring the hook's ~3s budget.
 *
 * Defensive by contract: every fs call is guarded; an unreadable dir/file is
 * skipped, never thrown (the capture is best-effort per its own budget note).
 */

"use strict";

const fs = require("fs");
const path = require("path");

// Matches the frontmatter line the capture writes: `source_commit: <hash>`.
// Accepts 7–64 hex: SHA-1 (40) AND SHA-256 (64) — this lib syncs to consumer
// repos, one of which may run `extensions.objectFormat=sha256`. The capture
// always writes the FULL %H, so de-dup is a full-hash exact match; the 7-char
// floor only lets a hand-shortened stub be READ without error — an abbreviated
// stub will NOT de-dup against a full-length captured SHA (exact-string Set
// membership, not prefix match).
const SOURCE_COMMIT_RE = /^source_commit:\s*([0-9a-fA-F]{7,64})\s*$/m;

// A capture-authored stub is ~1–3 KB. Cap the read well above that so a
// pathological large file in a .pending/ dir cannot block the synchronous scan
// past the hook budget — the scan runs AFTER the git-log `execSync` timeout, so
// nothing else bounds it. Enforces the "small dirs" assumption instead of trusting it.
const MAX_STUB_BYTES = 64 * 1024;

/**
 * Collect the set of `source_commit` SHAs already present in any workspace's
 * `journal/.pending/*.md` under `reposRoot/workspaces/`.
 *
 * @param {string} reposRoot absolute path to the repo root (the hook's cwd)
 * @returns {Set<string>} full/abbreviated SHAs seen; empty when workspaces/ absent
 */
function collectExistingPendingShas(reposRoot) {
  const seen = new Set();
  if (!reposRoot || typeof reposRoot !== "string") return seen;

  const wsRoot = path.join(reposRoot, "workspaces");
  let children;
  try {
    children = fs.readdirSync(wsRoot, { withFileTypes: true });
  } catch {
    return seen; // no workspaces/ dir — nothing captured yet
  }

  for (const child of children) {
    if (!child.isDirectory()) continue;
    const pendingDir = path.join(wsRoot, child.name, "journal", ".pending");
    let files;
    try {
      files = fs.readdirSync(pendingDir);
    } catch {
      continue; // no .pending in this workspace
    }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      try {
        const full = path.join(pendingDir, f);
        if (fs.statSync(full).size > MAX_STUB_BYTES) continue; // bound the read
        const txt = fs.readFileSync(full, "utf8");
        const m = txt.match(SOURCE_COMMIT_RE);
        if (m) seen.add(m[1]);
      } catch {
        // unreadable stub (or stat on a vanished file) — skip, never throw
      }
    }
  }
  return seen;
}

module.exports = { collectExistingPendingShas, SOURCE_COMMIT_RE };
