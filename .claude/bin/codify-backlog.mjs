#!/usr/bin/env node
/**
 * codify-backlog — the durable "what to codify" enumerator (last-codification anchor).
 *
 * PROBLEM this closes (owner directive 2026-06-25): `/codify` historically
 * derived its work-list from EPHEMERAL per-session artifacts — `.session-notes`
 * (overwritten every session) and `learning-digest.json` (regenerated every
 * `session-end.js`) — plus model memory. Knowledge that accrued across multiple
 * sessions WITHOUT an intervening `/codify`, or that fell off a `/clear`/compaction
 * boundary, was silently DROPPED: the digest/notes only reflected the LAST session,
 * and memory is unfalsifiable after a context boundary (`verify-claims-before-write.md`
 * MUST-2 / `zero-tolerance.md` Rule 1c epistemic shape).
 *
 * THE FIX: anchor on the DURABLE `last_codified` checkpoint in
 * `.claude/learning/learning-codified.json` and mechanically enumerate the COMPLETE
 * delta since that timestamp from APPEND-ONLY + COMMITTED sources — never the
 * per-session snapshots. Because the sources are append-only (observations.jsonl PLUS its
 * 500-record rotation archive observations.archive/, violations.jsonl) or git-committed
 * (journal/ across all local branches, artifact changes), the delta is complete regardless
 * of how many sessions elapsed un-codified, or whether context was cleared. This is the
 * structural "never miss" guarantee the prose alone cannot give.
 *
 * READ-ONLY: this tool NEVER writes `last_codified` (that is written by `/codify` at
 * completion, per `commands/codify.md` Step 1). It only reads + reports.
 *
 * Distributed to BUILD + USE consumers alongside `commands/codify.md` (coc tier);
 * works in any repo class — missing sources (no journal/, empty learning logs) are
 * tolerated, not errors.
 *
 * Committed enumeration spans ALL LOCAL BRANCHES (`git log --branches`), so a journal /
 * artifact commit on an un-merged side branch is caught; paths are read NUL-delimited
 * (`-z`) so non-ASCII / space names are not dropped. Accepted bounds (loud, not silent):
 * a commit reachable ONLY from a detached HEAD (on no branch) is not enumerated, and a
 * filename containing a literal newline may mis-split — both are pathological for journal
 * slugs and out of scope; the never-miss guarantee covers branch-reachable commits + the
 * append-only logs.
 *
 * READ-ONLY (restated): no write/network/exec sink; only read-only git subcommands.
 *
 * Usage:
 *   node .claude/bin/codify-backlog.mjs                  # markdown backlog for cwd's repo
 *   node .claude/bin/codify-backlog.mjs --json           # machine-readable
 *   node .claude/bin/codify-backlog.mjs --repo <dir>     # explicit repo
 *   node .claude/bin/codify-backlog.mjs --since <iso>    # override anchor (audit/replay)
 *
 * Exit code is ALWAYS 0 on success (it is an enumerator, not a gate). The
 * `first_codify` flag in the output signals "no prior anchor — full history in scope".
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

function parseArgs(argv) {
  const o = { json: false, repo: null, since: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--repo") o.repo = argv[++i];
    else if (a === "--since") o.since = argv[++i];
  }
  return o;
}

function resolveRepoDir(explicit) {
  if (explicit) return explicit;
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

// An ISO timestamp with a time component but NO `Z`/±HH:MM offset is parsed as
// LOCAL time by Date.parse — ambiguous across operator timezones. West of UTC it
// would resolve LATER in UTC and silently UNDER-include (a miss). Reject it.
function isTimezoneless(s) {
  return /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) && !/(Z|[+-]\d{2}:?\d{2})\s*$/.test(s);
}

/**
 * Read the durable last-codification checkpoint. Absent/empty/invalid => first codify
 * (epoch, full sweep — never a silent empty). An explicit `--since` override that does
 * not parse, or is timezone-less, THROWS (loud refusal beats a silent under-report on an
 * operator-supplied flag — the exact silent-skip failure this tool exists to prevent).
 */
function readAnchor(repoDir, override) {
  if (override) {
    const ms = Date.parse(override);
    if (Number.isNaN(ms)) {
      throw new Error(`--since: unparseable timestamp ${JSON.stringify(override)} (use ISO 8601 with a 'Z' or ±HH:MM offset)`);
    }
    if (isTimezoneless(override)) {
      throw new Error(`--since: timezone-less timestamp ${JSON.stringify(override)} is ambiguous — append 'Z' (UTC) or an offset`);
    }
    return { iso: override, ms, firstCodify: false, source: "--since override" };
  }
  const p = join(repoDir, ".claude/learning/learning-codified.json");
  if (!existsSync(p)) {
    return { iso: EPOCH_ISO, ms: 0, firstCodify: true, source: "learning-codified.json ABSENT" };
  }
  try {
    const raw = readFileSync(p, "utf8").trim();
    if (!raw) return { iso: EPOCH_ISO, ms: 0, firstCodify: true, source: "learning-codified.json EMPTY" };
    const j = JSON.parse(raw);
    const iso = j.last_codified;
    const ms = iso ? Date.parse(iso) : NaN;
    if (!iso || Number.isNaN(ms)) {
      return { iso: EPOCH_ISO, ms: 0, firstCodify: true, source: "learning-codified.json has no valid last_codified" };
    }
    // /codify always writes last_codified via toISOString() (always Z-suffixed); a
    // tz-less value is a hand-edit anomaly. Full sweep (never under-include) + loud.
    if (isTimezoneless(iso)) {
      return { iso: EPOCH_ISO, ms: 0, firstCodify: true, source: `last_codified ${JSON.stringify(iso)} is timezone-less (ambiguous) — treating as first codify` };
    }
    return { iso, ms, firstCodify: false, source: "learning-codified.json::last_codified" };
  } catch (e) {
    return { iso: EPOCH_ISO, ms: 0, firstCodify: true, source: `learning-codified.json unreadable (${e.message})` };
  }
}

// Append-only logs are not field-uniform: observations.jsonl stamps `timestamp`,
// violations.jsonl stamps `ts` (16/200 use `timestamp`). Resolve across candidates
// so the delta filter actually fires; a record with NO recognizable stamp falls to
// the never-miss fail-safe (included regardless of anchor).
const TS_FIELDS = ["timestamp", "ts", "detected_at", "created_at", "date"];
function recTimestampMs(rec) {
  for (const f of TS_FIELDS) {
    if (rec[f] != null) {
      const ms = Date.parse(rec[f]);
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return NaN;
}

function _processJsonl(text, anchorMs, keep, out) {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    out.total++;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      out.malformed++;
      continue;
    }
    const ms = recTimestampMs(rec);
    // Undated records cannot be proven older than the anchor -> include (fail-safe: never miss).
    if (Number.isNaN(ms) || ms > anchorMs) {
      if (keep(rec)) {
        out.since++;
        out.items.push(rec);
      }
    }
  }
}

/**
 * Filter an append-only JSONL log to records with timestamp > anchorMs — INCLUDING the
 * rotation archive. `observation-logger.js::checkAndArchive` renameSync's the live file to
 * `<source>.archive/<name>_<N>.jsonl` every MAX_OBSERVATIONS (500). A post-anchor record
 * that rotated since the anchor lives ONLY in the archive; reading the live file alone
 * silently drops it — and that miss GROWS with the codify gap (more un-codified sessions →
 * more likely a 500-rotation fired), which is exactly the never-miss scenario this tool is
 * for. So we union the live file with every `*.jsonl` in the sibling `<source>.archive/` dir.
 * (violations.jsonl is not currently rotated, but the generic glob future-proofs it.)
 */
function jsonlSince(repoDir, relPath, anchorMs, { keep = () => true } = {}) {
  const p = join(repoDir, relPath);
  const out = { path: relPath, present: existsSync(p), total: 0, since: 0, malformed: 0, archives_read: 0, items: [] };
  if (out.present) {
    try {
      _processJsonl(readFileSync(p, "utf8"), anchorMs, keep, out);
    } catch (e) {
      out.error = e.message;
    }
  }
  const archiveDir = join(repoDir, relPath.replace(/\.jsonl$/, ".archive"));
  if (existsSync(archiveDir)) {
    let files = [];
    try {
      files = readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      /* unreadable archive dir — degrade, don't crash */
    }
    for (const f of files) {
      out.present = true; // archived records count as present even if the live file is gone
      try {
        _processJsonl(readFileSync(join(archiveDir, f), "utf8"), anchorMs, keep, out);
        out.archives_read++;
      } catch {
        /* skip an unreadable archive file */
      }
    }
  }
  return out;
}

function git(repoDir, args) {
  try {
    // stderr ignored: a git-less consumer repo must not spew "fatal: not a git
    // repository" — the empty result already degrades the journal/commit sections.
    return execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/** Journal entries added (committed) since the anchor + any uncommitted/untracked journal files. */
function journalSince(repoDir, anchorIso) {
  const out = { committed_added: [], uncommitted: [] };
  // NO early `existsSync(journal/)` guard: the committed-side git-log queries history
  // ACROSS BRANCHES and MUST run even when journal/ is absent from the working-tree HEAD
  // (the side-branch-only never-miss case — a prior session committed a journal entry on
  // an un-merged branch, then switched away). git() returns "" on a git-less repo, so the
  // consumer-repo tolerance is preserved without the guard.
  //
  // -z (NUL-delimited) on BOTH git calls: git C-quotes any path with a non-ASCII / space /
  // special byte under default core.quotePath, which would start with `"` and fail the
  // startsWith("journal/") test — a silent never-miss. -z output is NEVER quoted.
  const added = git(repoDir, ["log", "--branches", `--since=${anchorIso}`, "--diff-filter=A", "--name-only", "--pretty=format:", "-z", "--", "journal/"]);
  const seen = new Set();
  // --pretty=format: (empty) + -z + --name-only emits the file paths NUL-delimited, with a
  // stray leading newline per commit; split on NUL, trim the newline, filter.
  for (const tok of added.split("\0")) {
    const p = tok.replace(/\n/g, "").trim();
    if (p && p.startsWith("journal/") && !seen.has(p)) {
      seen.add(p);
      out.committed_added.push(p);
    }
  }
  // In-flight working-tree journal changes. -z porcelain v1: each entry is "XY <path>"
  // NUL-terminated (cols 0-1 = status, col 2 = space, path from col 3), paths NEVER quoted.
  // For a rename/copy (R/C) the ORIG path follows as its OWN NUL field — skip it. (Do NOT
  // trim the entry first: that would strip the leading status-column space and break ` M`.)
  const status = git(repoDir, ["status", "--porcelain=v1", "-z", "--", "journal/"]);
  const parts = status.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const p = entry.slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // the next NUL field is the ORIG path — skip
    if (p.startsWith("journal/")) out.uncommitted.push(p);
  }
  return out;
}

/** A summary of durable artifact changes (commits) since the anchor, for context. */
function artifactCommitsSince(repoDir, anchorIso) {
  // --branches: same never-miss rationale as journalSince — surface artifact-change
  // commits on any local branch since the anchor, not only HEAD's history.
  const log = git(repoDir, [
    "log",
    "--branches",
    `--since=${anchorIso}`,
    "--pretty=format:%cI\t%h\t%s",
    "--",
    ".claude/",
    "specs/",
    "workspaces/",
    "journal/",
  ]);
  const commits = [];
  for (const l of log.split("\n")) {
    const t = l.trim();
    if (!t) continue;
    const [cISO, h, ...rest] = t.split("\t");
    commits.push({ ts: cISO, sha: h, subject: rest.join("\t") });
  }
  return commits;
}

/** Best-effort working-state knowledge: workspace .pending journal stubs + recently-finished todos. */
function workspaceWorkingState(repoDir, anchorMs) {
  const out = { pending: [], done: [] };
  const wsRoot = join(repoDir, "workspaces");
  if (!existsSync(wsRoot)) return out;
  let dirs;
  try {
    dirs = readdirSync(wsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "instructions" && !e.name.startsWith("_"))
      .map((e) => e.name);
  } catch {
    return out;
  }
  const collect = (sub, bucket) => {
    for (const d of dirs) {
      const dir = join(wsRoot, d, sub);
      if (!existsSync(dir)) continue;
      let files;
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        const full = join(dir, f);
        try {
          const st = statSync(full);
          if (st.isFile() && st.mtimeMs > anchorMs) bucket.push(`workspaces/${d}/${sub}/${f}`);
        } catch {
          /* ignore */
        }
      }
    }
  };
  collect("journal/.pending", out.pending);
  collect("todos/done", out.done);
  return out;
}

// Pure telemetry — counted for completeness, not listed in detail (carries no codifiable knowledge).
const TELEMETRY_TYPES = new Set(["session_start", "session_summary", "heartbeat"]);

function typeHistogram(items) {
  const h = {};
  for (const r of items) {
    const t = r.type || "(untyped)";
    h[t] = (h[t] || 0) + 1;
  }
  return h;
}

function obsLabel(rec) {
  const type = rec.type || "observation";
  const ts = rec.timestamp || rec.ts || "(undated)";
  let hint = "";
  if (rec.data && typeof rec.data === "object") {
    if (rec.data.framework) hint = ` framework=${rec.data.framework}`;
    if (rec.data.summary) hint = ` ${String(rec.data.summary).slice(0, 80)}`;
  }
  return `${ts}  ${type}${hint}`;
}

function vioLabel(rec) {
  const ts = rec.timestamp || rec.ts || "(undated)";
  return `${ts}  ${rec.rule_id || "?"} [${rec.severity || "?"}] ${String(rec.evidence || "").slice(0, 80)}`;
}

function build(repoDir, args) {
  const anchor = readAnchor(repoDir, args.since);
  const observations = jsonlSince(repoDir, ".claude/learning/observations.jsonl", anchor.ms);
  const violations = jsonlSince(repoDir, ".claude/learning/violations.jsonl", anchor.ms, {
    keep: (r) => r.addressed_by == null,
  });
  const journal = journalSince(repoDir, anchor.iso);
  const commits = artifactCommitsSince(repoDir, anchor.iso);
  const working = workspaceWorkingState(repoDir, anchor.ms);
  const total =
    observations.since +
    violations.since +
    journal.committed_added.length +
    journal.uncommitted.length +
    commits.length +
    working.pending.length +
    working.done.length;
  return { repoDir, anchor, observations, violations, journal, commits, working, total };
}

function renderMarkdown(b) {
  const L = [];
  L.push(`# /codify backlog — delta since last codification`);
  L.push("");
  L.push(`Repo: \`${b.repoDir}\``);
  L.push(`Anchor: **${b.anchor.iso}** (source: ${b.anchor.source})`);
  if (b.anchor.firstCodify) {
    L.push("");
    L.push(`> ⚠️  **FIRST CODIFY / NO PRIOR ANCHOR** — \`last_codified\` is absent or invalid, so the`);
    L.push(`> entire history is in scope. Do a FULL sweep; do NOT assume "nothing to do".`);
  }
  L.push("");
  L.push(`**Completeness guarantee:** this list is the COMPLETE delta since the durable anchor,`);
  L.push(`computed from append-only + git-committed sources — NOT from \`.session-notes\`, the`);
  L.push(`learning-digest, or model memory. Codify the ENTIRE backlog. ${b.total} item(s) total.`);
  L.push("");

  L.push(`## Observations since anchor (${b.observations.since} of ${b.observations.total})`);
  if (b.observations.malformed) L.push(`_(${b.observations.malformed} malformed line(s) skipped)_`);
  const hist = typeHistogram(b.observations.items);
  const types = Object.keys(hist).sort((a, c) => hist[c] - hist[a]);
  if (types.length) L.push(`By type: ${types.map((t) => `${t}=${hist[t]}`).join(", ")}`);
  // Detail only the actionable (non-telemetry) observations; telemetry is counted above.
  const actionable = b.observations.items.filter((r) => !TELEMETRY_TYPES.has(r.type));
  L.push(`Actionable (non-telemetry): ${actionable.length}`);
  for (const r of actionable.slice(0, 200)) L.push(`- ${obsLabel(r)}`);
  if (actionable.length > 200) L.push(`- … and ${actionable.length - 200} more`);
  if (!b.observations.present) L.push(`_(observations.jsonl absent)_`);
  L.push("");

  L.push(`## Unaddressed violations since anchor (${b.violations.since})`);
  for (const r of b.violations.items.slice(0, 200)) L.push(`- ${vioLabel(r)}`);
  if (!b.violations.present) L.push(`_(violations.jsonl absent)_`);
  L.push("");

  L.push(`## Journal entries since anchor (${b.journal.committed_added.length} committed, ${b.journal.uncommitted.length} in-flight)`);
  for (const f of b.journal.committed_added) L.push(`- ${f}`);
  for (const f of b.journal.uncommitted) L.push(`- ${f} _(uncommitted)_`);
  L.push("");

  L.push(`## Artifact-change commits since anchor (${b.commits.length})`);
  for (const c of b.commits.slice(0, 100)) L.push(`- ${c.ts}  ${c.sha}  ${c.subject}`);
  if (b.commits.length > 100) L.push(`- … and ${b.commits.length - 100} more`);
  L.push("");

  if (b.working.pending.length || b.working.done.length) {
    L.push(`## Workspace working-state since anchor`);
    for (const f of b.working.pending) L.push(`- pending journal stub: ${f}`);
    for (const f of b.working.done) L.push(`- finished todo: ${f}`);
    L.push("");
  }
  return L.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoDir = resolveRepoDir(args.repo);
  let b;
  try {
    b = build(repoDir, args);
  } catch (e) {
    // Loud refusal on an invalid operator-supplied --since (never a silent empty backlog).
    process.stderr.write(`codify-backlog: ${e.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          repo: b.repoDir,
          anchor: b.anchor,
          total: b.total,
          observations: { present: b.observations.present, total: b.observations.total, since: b.observations.since, malformed: b.observations.malformed, archives_read: b.observations.archives_read, items: b.observations.items },
          violations: { present: b.violations.present, since: b.violations.since, items: b.violations.items },
          journal: b.journal,
          commits: b.commits,
          working: b.working,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(renderMarkdown(b) + "\n");
  }
  // Do NOT process.exit() here: a forced exit truncates a large async stdout write
  // at the pipe buffer boundary. Set the code and let the event loop drain stdout.
  process.exitCode = 0;
}

main();
