#!/usr/bin/env node
/*
 * ============================================================================
 *  Cross-Reference Integrity Validator — F22 (journal/0150)
 * ============================================================================
 *
 *  Mechanical detector for dangling cross-references in `.claude/` artifacts.
 *  Walks rules/, skills/, commands/, agents/; extracts xref tokens from
 *  backtick-inline and markdown-link forms; resolves each token against the
 *  filesystem; reports dangling refs.
 *
 *  Value-anchor (per value-prioritization.md MUST-1 source c — journal
 *  DECISION entries): journal/0144 § analyst FM3 + journal/0149 § Forest
 *  follow-ups name F22 as the mechanical primitive Rule 11 + F25 lean on.
 *
 *  Detection surface (Phase-1):
 *    1. Backtick inline: `rules/foo.md`, `.claude/rules/foo.md`,
 *       `skills/foo/bar.md`, `commands/foo.md`, `agents/foo.md`,
 *       `hooks/foo.js`, `bin/foo.mjs`, `audit-fixtures/foo/`,
 *       `journal/NNNN-...md`.
 *    2. Markdown link: [text](path/to/file.md) and [text](path/to/file.md#anchor).
 *
 *  EXCLUDED (Phase-1):
 *    - Bare prose paths (high false-positive rate).
 *    - Section-anchor heuristic (`§ <heading>`) — deferred to Phase-2 per
 *      cc-artifacts.md Rule 9 false-positive class.
 *    - Refs inside fenced code blocks (treated as example/illustration).
 *    - Template placeholders: `<id>`, `<file>`, `<NN>`, `<NNNN>`, etc.
 *    - `.claude/audit-fixtures/**` is NOT scanned as a SOURCE (FC, journal/0186):
 *      audit-fixture markdown is synthetic test INPUT for the validator battery;
 *      its cross-refs are intentional fakes (`rules/foo.md`, `skills/foo`,
 *      `path.md`) or illustrative. Scanning fixtures for xref integrity is a
 *      category error — they are test corpora, not real-artifact sources. The
 *      fixtures are still exercised by the test harness (which calls the
 *      exported functions directly) and by an explicit `--scope .claude/audit-fixtures`.
 *      Bounded residual (R1 security-reviewer MED-1): a fixture `README.md` MAY
 *      carry a REAL institutional cross-ref (e.g. `rules/<real>.md`) that the
 *      default scan no longer validates. Accepted as bounded — those targets are
 *      authoritatively validated where the target itself is scanned and where
 *      real rules reference it; the example-bearing fixture READMEs additionally
 *      carry intentional-fake refs in table-cell code spans (un-fenceable) that a
 *      README-only re-scan would re-flag. `--scope .claude/audit-fixtures` is the
 *      audit path for fixture-README cross-refs.
 *    - Cross-CLI dispatcher tokens `bin/coc` / `bin/coc-<phase>` (FC, journal/0186):
 *      the Codex CLI phase dispatcher emitted to `<USE>/bin/coc` (loom source is
 *      `.claude/codex-templates/bin/coc`), referenced by NAME in cross-CLI prose
 *      per cross-cli-artifact-hygiene.md. It is never a loom-root `bin/` file, so
 *      the `bin/` prefix match is a structural false-positive.
 *
 *  Resolver (per cross-repo.md Rule 1 — local-only, no positional cross-repo):
 *    - Tokens starting with `.claude/`: resolve against `<repo-root>/.claude/`.
 *    - Tokens starting with `rules/`, `skills/`, `commands/`, `agents/`,
 *      `hooks/`, `bin/`, `audit-fixtures/`: try `<repo-root>/.claude/<token>`
 *      AND `<repo-root>/<token>` (loom-internal precedent).
 *    - Tokens starting with `journal/NNNN[-...]`: glob-match against
 *      `<repo-root>/journal/NNNN-*.md` (NNNN-prefix match).
 *
 *  Exit:
 *    0 = no dangling refs (or all findings are sourced from EXCLUDED contexts)
 *    1 = ≥1 dangling ref
 *    2 = usage / IO error
 *
 *  Usage:
 *    node .claude/bin/validate-xref-integrity.mjs [--json] [--scope <dir>] [--help]
 *
 *  --json     emit JSON report to stdout (machine-readable)
 *  --scope    limit scan to a subdirectory (default: .claude/ + selected
 *             root-level files)
 *  --help     usage text + exit 0
 *
 *  THIS SCRIPT IS A SYNCED ARTIFACT (`bin/**` per sync-manifest.yaml). Zero
 *  client/org tokens; detection is purely structural (a STRUCTURAL probe per
 *  probe-driven-verification.md MUST-3).
 * ============================================================================
 */

import { readFileSync, readdirSync, statSync, lstatSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// --- Repo root resolution -----------------------------------------------

function findRepoRoot(startDir) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || startDir;
  } catch {
    // security-reviewer LOW — silent cwd-outside-repo footgun. Warn so the
    // operator notices that scan scope will not be repo-anchored.
    process.stderr.write(
      `validate-xref-integrity: warning: git rev-parse failed for cwd=${startDir}; scanning relative to cwd\n`,
    );
    return startDir;
  }
}

// --- Token surface ------------------------------------------------------

// Backtick-inline xref. Captures the path token. Must start with one of the
// known prefixes; must end at backtick. Excludes refs containing `<` (template
// placeholders) or whitespace.
//
// Prefixes covered: .claude/, rules/, skills/, commands/, agents/, hooks/,
// bin/, audit-fixtures/, journal/. The optional `.claude/` prefix is handled
// by allowing either form.
const BACKTICK_RE =
  /`((?:\.claude\/)?(?:rules|skills|commands|agents|hooks|bin|audit-fixtures)\/[A-Za-z0-9_./~+\-]+)`/g;

// Backtick-inline journal ref.
const BACKTICK_JOURNAL_RE = /`(journal\/(?:\.pending\/)?\d{3,4}[A-Za-z0-9_.\-/]*)`/g;

// Markdown link: [text](relative/path.md) or [text](relative/path.md#anchor)
// Skip http(s) URLs, mailto:, fragment-only (#X) and absolute-system paths.
const MD_LINK_RE =
  /\[(?:[^\]]*)\]\(([A-Za-z0-9_./~+\-]+?\.(?:md|mjs|js|json|ya?ml))(?:#[^)]*)?\)/g;

// Section heading detector for resolving section anchors inside markdown
// files (deferred to Phase-2; not used in Phase-1 default mode).

// Template-placeholder detection (skip these as not real refs). Covers:
//   <id>, <NN>, <NNNN>          (angle-bracket form)
//   {topic}, ${VAR}             (curly-brace form)
//   %(var)s                     (printf-named form)
function isPlaceholder(token) {
  if (/[<>{}]/.test(token)) return true;
  if (/%\([A-Za-z_][A-Za-z0-9_]*\)/.test(token)) return true;
  return false;
}

// Cross-CLI dispatcher tokens are not loom files (see docstring EXCLUDED note).
// `bin/coc` and `bin/coc-<phase>` name the Codex CLI dispatcher emitted to
// `<USE>/bin/coc`; the loom source is `.claude/codex-templates/bin/coc`.
const CROSS_CLI_DISPATCHER_RE = /^bin\/coc(-[a-z0-9-]+)?$/;
function isCrossCliDispatcher(token) {
  return CROSS_CLI_DISPATCHER_RE.test(token);
}

// --- Walker -------------------------------------------------------------

// NOTE: `.claude/audit-fixtures` is intentionally NOT a default SOURCE scope
// (FC, journal/0186) — fixture markdown is synthetic test input; see the
// EXCLUDED note in the header. It remains scannable via `--scope .claude/audit-fixtures`.
const DEFAULT_SCOPE_DIRS = [
  ".claude/commands",
  ".claude/rules",
  ".claude/skills",
  ".claude/agents",
];
const DEFAULT_SCOPE_ROOT_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "STACK.md"];

// Explicit ignored-dir set (reviewer MEDIUM-2). The dot-prefix heuristic
// also still skips nested fixture dirs that simulate `.claude/` layouts
// inside audit-fixtures/ (these are intentional test artifacts, not
// real cross-reference sources).
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".worktrees",
  "worktrees",
]);

function walkDir(dir, repoRoot) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      // Skip dot-prefixed dirs (e.g. nested `.claude/` test fixtures under
      // audit-fixtures/, `.proposals/`, transient hidden state).
      if (e.name.startsWith(".")) continue;
      out.push(...walkDir(full, repoRoot));
    } else if (e.isFile() && /\.md$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

// --- Fence-block skip ---------------------------------------------------

// Returns the input text with fenced code blocks replaced by blank lines of
// the same length. Backticks INSIDE fenced blocks are example-only and MUST
// not be scanned (Phase-1 disposition).
function stripFencedBlocks(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inFence = false;
  let fenceMarker = null;
  for (const l of lines) {
    const fm = l.match(/^\s*(```+|~~~+)/);
    if (fm) {
      const run = fm[1];
      const kind = run[0];
      if (!inFence) {
        inFence = true;
        fenceMarker = kind;
        out.push("");
        continue;
      }
      if (kind === fenceMarker) {
        inFence = false;
        fenceMarker = null;
        out.push("");
        continue;
      }
      out.push("");
      continue;
    }
    out.push(inFence ? "" : l);
  }
  return out.join("\n");
}

// --- Extractor ----------------------------------------------------------

function extractTokens(text, sourcePath) {
  const stripped = stripFencedBlocks(text);
  const findings = [];
  const lines = stripped.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    // Backtick non-journal
    for (const m of line.matchAll(BACKTICK_RE)) {
      const token = m[1];
      if (isPlaceholder(token)) continue;
      if (isCrossCliDispatcher(token)) continue;
      findings.push({ token, kind: "backtick", line: lineNo, source: sourcePath });
    }
    // Backtick journal
    for (const m of line.matchAll(BACKTICK_JOURNAL_RE)) {
      const token = m[1];
      if (isPlaceholder(token)) continue;
      findings.push({ token, kind: "journal", line: lineNo, source: sourcePath });
    }
    // Markdown link
    for (const m of line.matchAll(MD_LINK_RE)) {
      const token = m[1];
      if (isPlaceholder(token)) continue;
      if (/^(https?:|mailto:|#)/i.test(token)) continue;
      findings.push({ token, kind: "md-link", line: lineNo, source: sourcePath });
    }
  }
  return findings;
}

// --- Resolver -----------------------------------------------------------

function resolveJournalToken(token, repoRoot) {
  // token = "journal/NNNN..." or "journal/.pending/NNNN..."
  const m = token.match(/^journal\/(\.pending\/)?(\d{3,4})/);
  if (!m) return { ok: false, reason: "malformed-journal-token" };
  const subdir = m[1] ? ".pending" : "";
  const nnnn = m[2];
  const dir = subdir ? join(repoRoot, "journal", subdir) : join(repoRoot, "journal");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return { ok: false, reason: "journal-dir-missing" };
  }
  // Match any file starting with `NNNN-` or exact `NNNN.md`.
  const hit = entries.find(
    (n) => n === `${nnnn}.md` || n.startsWith(`${nnnn}-`),
  );
  return hit
    ? { ok: true, resolvedPath: join(dir, hit) }
    : { ok: false, reason: "journal-entry-not-found" };
}

// Path-traversal guard: confine resolved candidates to <repoRoot>/... so a
// malicious md-link token cannot make the validator stat arbitrary
// filesystem paths (security-reviewer MEDIUM-1).
function isInsideRepoRoot(absPath, repoRoot) {
  const normRoot = resolve(repoRoot);
  const normPath = resolve(absPath);
  return normPath === normRoot || normPath.startsWith(normRoot + sep);
}

function resolveRefToken(token, repoRoot, sourcePath, kind) {
  // Candidate paths to try, in order.
  const candidates = [];

  // For md-link kind, try source-relative first (markdown link semantics).
  // This handles `../../skill-x/file.md` and bare `sibling.md` patterns
  // common in skill cross-references.
  if (kind === "md-link") {
    const sourceDir = sourcePath
      ? dirname(join(repoRoot, sourcePath))
      : repoRoot;
    candidates.push(resolve(sourceDir, token));
  }

  if (token.startsWith(".claude/")) {
    candidates.push(join(repoRoot, token));
  } else if (token.startsWith("./") || token.startsWith("../")) {
    // Relative path — source-relative already tried above for md-link;
    // also try repo-root-relative as a fallback for backtick refs.
    candidates.push(resolve(repoRoot, token));
  } else {
    // Bare form (rules/foo.md, skills/foo/bar.md, etc.) — try `.claude/<token>`
    // first (the canonical loom-side path), then `<repo-root>/<token>` (loom-
    // internal precedent).
    candidates.push(join(repoRoot, ".claude", token));
    candidates.push(join(repoRoot, token));
  }

  // Clamp every candidate to repoRoot before stat — defense-in-depth
  // against path-traversal via `../../etc/passwd`-style tokens. Candidates
  // outside the repo are silently dropped (treated as not-found).
  const safeCandidates = candidates.filter((c) => isInsideRepoRoot(c, repoRoot));

  // For dir tokens (ending in `/`), check directory; otherwise check file.
  // Use lstatSync to avoid following symlinks out of the repo (security-
  // reviewer LOW — symlink-following stat).
  const isDir = token.endsWith("/");
  for (const c of safeCandidates) {
    try {
      const st = lstatSync(c);
      if (isDir ? st.isDirectory() : st.isFile()) {
        return { ok: true, resolvedPath: c };
      }
    } catch {
      // try next candidate
    }
  }
  return { ok: false, reason: "not-found" };
}

function resolveOne(finding, repoRoot) {
  if (finding.kind === "journal") {
    return resolveJournalToken(finding.token, repoRoot);
  }
  return resolveRefToken(finding.token, repoRoot, finding.source, finding.kind);
}

// --- Main ---------------------------------------------------------------

function parseArgs(argv) {
  const out = { json: false, scope: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--scope") out.scope = argv[++i];
    else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else {
      // Positional fallback (treat as scope)
      out.scope = a;
    }
  }
  return out;
}

function usage() {
  return `validate-xref-integrity.mjs — mechanical cross-reference detector

usage:
  node .claude/bin/validate-xref-integrity.mjs [--json] [--scope <dir>] [--help]

flags:
  --json        emit JSON report to stdout (machine-readable)
  --scope DIR   limit scan to DIR (default: .claude/{commands,rules,skills,agents}; audit-fixtures excluded — see header)
  --help, -h    show this message and exit 0

exit codes:
  0  no dangling refs
  1  ≥1 dangling ref found
  2  usage / IO error

what it checks:
  - backtick inline refs: \`rules/foo.md\`, \`skills/foo/bar.md\`, \`journal/NNNN\`, etc.
  - markdown links: [text](path/to/file.md)
  - resolves against <repo>/.claude/<token> and <repo>/<token>

what it does NOT check (Phase-1):
  - bare prose paths
  - section-anchor heuristic (§ heading)
  - refs inside fenced code blocks (treated as illustrative)
`;
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const repoRoot = findRepoRoot(process.cwd());
  const scopeDirs = args.scope
    ? [resolve(args.scope)]
    : DEFAULT_SCOPE_DIRS.map((d) => join(repoRoot, d));
  const scopeFiles = args.scope
    ? []
    : DEFAULT_SCOPE_ROOT_FILES.map((f) => join(repoRoot, f)).filter(existsSync);

  // Collect scan targets
  const targets = [];
  for (const d of scopeDirs) {
    if (existsSync(d)) targets.push(...walkDir(d, repoRoot));
  }
  for (const f of scopeFiles) targets.push(f);

  // Extract + resolve. Per reviewer HIGH-4: a single unreadable file MUST
  // NOT kill the scan with exit 2; log to stderr + continue. Exit 2 is
  // reserved strictly for argv-parsing errors above.
  const allFindings = [];
  const readFailures = [];
  for (const t of targets) {
    let text;
    try {
      text = readFileSync(t, "utf8");
    } catch (e) {
      readFailures.push({ path: relative(repoRoot, t), error: e.message });
      process.stderr.write(
        `validate-xref-integrity: read-failed: ${relative(repoRoot, t)}: ${e.message}\n`,
      );
      continue;
    }
    const findings = extractTokens(text, relative(repoRoot, t));
    for (const f of findings) {
      const r = resolveOne(f, repoRoot);
      allFindings.push({ ...f, ...r });
    }
  }

  const dangling = allFindings.filter((f) => !f.ok);
  const totalScanned = allFindings.length;
  const filesScanned = targets.length;

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: dangling.length === 0,
          files_scanned: filesScanned,
          tokens_scanned: totalScanned,
          dangling_count: dangling.length,
          read_failures: readFailures,
          dangling: dangling.map((d) => ({
            source: d.source,
            line: d.line,
            kind: d.kind,
            token: d.token,
            reason: d.reason,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(
      `validate-xref-integrity: scanned ${filesScanned} files, ${totalScanned} xref tokens; ${dangling.length} dangling`,
    );
    if (readFailures.length > 0) {
      process.stdout.write(`; ${readFailures.length} read failures`);
    }
    process.stdout.write("\n");
    if (dangling.length > 0) {
      process.stdout.write("\ndangling refs:\n");
      for (const d of dangling) {
        process.stdout.write(
          `  ${d.source}:${d.line}  [${d.kind}]  ${d.token}  → ${d.reason}\n`,
        );
      }
    }
  }
  process.exit(dangling.length > 0 ? 1 : 0);
}

// Export internals for audit-fixture harness
const __filename = fileURLToPath(import.meta.url);
const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

export {
  extractTokens,
  resolveJournalToken,
  resolveRefToken,
  resolveOne,
  stripFencedBlocks,
  isPlaceholder,
  isCrossCliDispatcher,
  findRepoRoot,
  DEFAULT_SCOPE_DIRS,
};

if (isMain) main();
