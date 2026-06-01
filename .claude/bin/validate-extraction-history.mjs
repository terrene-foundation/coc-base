#!/usr/bin/env node
/*
 * ============================================================================
 *  Extraction-History Validator — F25 (journal/0152)
 *  Rule 11 Phase-2 Automation per rule-authoring.md MUST Rule 11
 * ============================================================================
 *
 *  Mechanical detector for Rule 11 (2nd-extraction escalation across
 *  (rule, CLI) pairs within 30 days). Walks `journal/*.md` for prior entries
 *  citing Rule-10-disposition anchor language; for each grep-match, verifies
 *  the touched rule was `priority: 0` + `scope: baseline` at the entry's
 *  date via `git log --follow` + `git show` (SM2 — rule-rename detect);
 *  counts verified-mandated matches within 30 calendar days of a given
 *  proposal date; emits structured report.
 *
 *  Phase-1 → Phase-2 trigger (per rule-authoring.md Detection mechanism):
 *  Phase 2 (this script) is the mechanical version of cc-architect's manual
 *  sweep. It ships STANDALONE — NOT yet wired into /codify proposal-validation
 *  as a hard gate. Wiring requires ≥3 real Rule-11 manual invocations first
 *  per trust-posture.md MUST Rule 7 Two-Phase Rollout.
 *
 *  Sub-items closed by this validator:
 *    - SM1 (asOfDate): system-clock vs receipt-journal-date binding.
 *      When both --proposal-date and --as-of-date are supplied, they MUST
 *      match — closes the trivial gate bypass where an operator alters
 *      system clock vs journal entry date.
 *    - SM2 (rule-rename): scope-at-date verification traverses `git log
 *      --follow` to detect renames; reads frontmatter at the path-at-commit
 *      using `git show <commit>:<path-at-commit>`.
 *    - LOW4 (TZ-naive Date): all date parsing fixes parse YYYY-MM-DD as
 *      UTC noon (12:00:00Z) + calendar-day delta computed in UTC to avoid
 *      ±1d boundary drift across timezones.
 *
 *  Anchor language (per rule-authoring.md Detection mechanism § Rule 11
 *  sweep): "Rule-10 disposition", "Rule 10 fires", "proximity-band sweep",
 *  "F23a-corpus", "F23a § F23a proximity-band". Match is substring +
 *  case-insensitive within the entry body.
 *
 *  Resolution: the rule path is normalized to the canonical form
 *  `.claude/rules/<name>.md`; the validator searches journal entries
 *  for substring matches against any of: the canonical path, the bare
 *  `rules/<name>.md` form, OR the rule's basename (`<name>.md`).
 *
 *  Exit:
 *    0 = no prior Rule-11-mandated invocations within window
 *        (inclusive of windowDays; Rule 11 does NOT fire)
 *    1 = ≥1 prior Rule-11-mandated invocation found
 *        (Rule 11 fires; cc-architect demands disposition (a') or (b'))
 *    2 = usage / IO error
 *
 *  Value-anchor (per `value-prioritization.md` MUST-1 source c — journal
 *  DECISION entries): `journal/0149` § Forest follow-ups names this script
 *  as the Phase-2 trigger automation; `rule-authoring.md` line 300 defers
 *  Phase 2 here. F25 closes that deferral as a STANDALONE Phase-2 helper.
 *
 *  Usage:
 *    node .claude/bin/validate-extraction-history.mjs --rule <path> \
 *                                                    --proposal-date <YYYY-MM-DD> \
 *                                                    [--as-of-date <YYYY-MM-DD>] \
 *                                                    [--journal-dir <path>] \
 *                                                    [--window-days <N>] \
 *                                                    [--json] [--help]
 *
 *  THIS SCRIPT IS A SYNCED ARTIFACT (`bin/**` per sync-manifest.yaml).
 *  Zero client/org tokens; detection is purely structural.
 * ============================================================================
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// --- Constants ----------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 30;

// Anchor language for Rule-10-disposition mentions (per rule-authoring.md
// § Detection mechanism — Rule 11 sweep). Substring + case-insensitive.
//
// Analyst FM-A1: rule-authoring.md:300 says "Rule-10 disposition (or
// equivalent path (a) / path (b) anchor language)" — equivalent anchor
// expressions added below. Lexical-substring detection is the Phase-1
// disposition per probe-driven-verification.md MUST-1 + MUST-4 (lexical
// hook + probe-driven gate-review counterpart at cc-architect's manual
// sweep).
const RULE10_ANCHORS = [
  "rule-10 disposition",
  "rule 10 disposition",
  "rule-10 fires",
  "rule 10 fires",
  "proximity-band sweep",
  "proximity band sweep",
  "f23a proximity-band",
  "path (a) corpus-level",
  "path (b) named-rationale",
  "sub-field (vi)",
  "named-rationale exception",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
    process.stderr.write(
      `validate-extraction-history: warning: git rev-parse failed for cwd=${startDir}; using cwd as repo root\n`,
    );
    return startDir;
  }
}

// --- Date arithmetic (TZ-naive hardening per LOW4) ----------------------

// Parse YYYY-MM-DD as UTC noon (12:00:00Z) to avoid TZ-boundary ±1d drift.
// Calendar-day delta is computed in UTC days.
function parseDateUTC(dateStr) {
  if (!DATE_RE.test(dateStr)) {
    throw new Error(`invalid date (expected YYYY-MM-DD): ${dateStr}`);
  }
  const [y, m, d] = dateStr.split("-").map(Number);
  // Date.UTC(year, monthIndex, day, hour=12) — noon UTC anchor.
  const t = Date.UTC(y, m - 1, d, 12, 0, 0, 0);
  if (isNaN(t)) throw new Error(`invalid date: ${dateStr}`);
  return t;
}

// Calendar-day delta between two YYYY-MM-DD strings (both parsed as
// noon UTC). Returns the floor of (msA - msB) / 86400_000.
function daysBetween(dateA, dateB) {
  const ms = parseDateUTC(dateA) - parseDateUTC(dateB);
  return Math.floor(ms / 86400000);
}

// --- Frontmatter parsing -------------------------------------------------

// Lightweight YAML frontmatter parse (keys-only, no nested structures).
// Returns Map of { key -> raw value }. Stops at the closing `---`.
function parseFrontmatter(text) {
  const out = new Map();
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") return out;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "---") break;
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

// --- Anchor + rule-citation detection ------------------------------------

// True if any Rule-10-anchor substring matches the body (case-insensitive).
function hasRule10Anchor(body) {
  const lower = body.toLowerCase();
  return RULE10_ANCHORS.some((a) => lower.includes(a));
}

// True if the body contains a reference to the target rule. We accept
// substring matches against:
//   - the canonical path (e.g. ".claude/rules/rule-authoring.md")
//   - the bare form (e.g. "rules/rule-authoring.md")
//   - the basename (e.g. "rule-authoring.md") AS LONG AS it occurs
//     adjacent to a path-marker character (backtick / slash / space-rules)
//     to reduce false-positives.
function citesRule(body, rulePath) {
  // Normalize: extract basename + bare form
  const norm = rulePath.replace(/^\.\//, "");
  const canonicalForm = norm.startsWith(".claude/rules/")
    ? norm
    : norm.startsWith("rules/")
    ? `.claude/${norm}`
    : norm;
  const bareForm = canonicalForm.startsWith(".claude/")
    ? canonicalForm.slice(".claude/".length)
    : canonicalForm;
  const name = basename(canonicalForm);

  if (body.includes(canonicalForm)) return true;
  if (body.includes(bareForm)) return true;
  // Basename match must be adjacent to a path-marker (backtick, slash, or
  // word boundary preceded by `rules/`)
  const baseRe = new RegExp(`(\\\`|/|\\b)${name.replace(/\./g, "\\.")}(\\\`|\\b)`);
  return baseRe.test(body);
}

// --- Scope-at-date verification (SM2 — rule-rename detect) --------------

// Returns the rule's `scope:` frontmatter value at the latest commit
// touching the rule with commit-date <= targetDate. Traces renames via
// `git log --follow`. Returns one of:
//   { ok: true, scope: "baseline" | "path-scoped" | "..." }
//   { ok: false, reason: "no-commit-at-or-before-target-date" }
//   { ok: false, reason: "rule-not-found-in-git-history" }
//   { ok: false, reason: "git-error", error: "<msg>" }
function getScopeAtDate(rulePath, targetDate, repoRoot) {
  let logOut;
  try {
    logOut = execFileSync(
      "git",
      [
        "log",
        "--follow",
        "--name-only",
        "--diff-filter=AMR",
        `--pretty=format:%H|%cI`,
        "--",
        rulePath,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (e) {
    return { ok: false, reason: "git-error", error: e.message };
  }

  // Parse output: hash|isoDate\n<path>\n(blank)\nhash|isoDate\n<path>\n...
  const lines = logOut.split("\n");
  const commits = [];
  let cur = null;
  for (const l of lines) {
    if (/^[0-9a-f]{40}\|/.test(l)) {
      if (cur) commits.push(cur);
      const [hash, iso] = l.split("|");
      cur = { hash, iso, path: null };
    } else if (cur && l.trim() && !cur.path) {
      cur.path = l.trim();
    }
  }
  if (cur) commits.push(cur);

  if (commits.length === 0) {
    return { ok: false, reason: "rule-not-found-in-git-history" };
  }

  // Find latest commit with date <= targetDate (parsed UTC noon).
  // Reviewer HIGH-1: skip commits with null path (pure-merge commits or
  // --diff-filter excluded the path line); they cannot drive a git show.
  const targetMs = parseDateUTC(targetDate);
  const targetEndOfDayMs = targetMs + 86400000 - 1;

  let pick = null;
  for (const c of commits) {
    if (!c.path) continue;
    const cMs = new Date(c.iso).getTime();
    if (cMs <= targetEndOfDayMs) {
      if (!pick || new Date(pick.iso).getTime() < cMs) pick = c;
    }
  }

  if (!pick) {
    return { ok: false, reason: "no-commit-at-or-before-target-date" };
  }

  // Read the rule's frontmatter at the picked commit.
  let showOut;
  try {
    showOut = execFileSync(
      "git",
      ["show", `${pick.hash}:${pick.path}`],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (e) {
    return { ok: false, reason: "git-show-error", error: e.message };
  }

  const fm = parseFrontmatter(showOut);
  const scope = fm.get("scope") || "(unset)";
  const priority = fm.get("priority") || "(unset)";
  return {
    ok: true,
    scope,
    priority,
    commit: pick.hash,
    commitISO: pick.iso,
    pathAtCommit: pick.path,
  };
}

// --- Journal walk -------------------------------------------------------

function listJournalEntries(journalDir) {
  let entries;
  try {
    entries = readdirSync(journalDir);
  } catch {
    return [];
  }
  // Filter: NNNN-*.md, exclude .pending/ subdir contents (we don't recurse).
  return entries
    .filter((n) => /^\d{3,4}-.*\.md$/.test(n))
    .map((n) => ({ name: n, path: join(journalDir, n) }));
}

// --- Per-entry classification -------------------------------------------

// Returns { mandated, reason, details } where mandated is true iff this
// entry counts as a Rule-11-input (Rule-10-MANDATED invocation on the
// target rule lane).
function classifyEntry(entryPath, body, fm, targetRule, repoRoot) {
  if (!hasRule10Anchor(body)) {
    return { mandated: false, reason: "no-rule10-anchor" };
  }
  if (!citesRule(body, targetRule)) {
    return { mandated: false, reason: "rule-not-cited" };
  }
  const entryDate = fm.get("date");
  if (!entryDate || !DATE_RE.test(entryDate)) {
    return { mandated: false, reason: "no-valid-frontmatter-date" };
  }
  // Verify scope: baseline at entry's date (SM2)
  const scopeResult = getScopeAtDate(targetRule, entryDate, repoRoot);
  if (!scopeResult.ok) {
    return {
      mandated: false,
      reason: `scope-verification-failed: ${scopeResult.reason}`,
      details: scopeResult,
    };
  }
  if (scopeResult.scope !== "baseline") {
    return {
      mandated: false,
      reason: `scope-at-date-not-baseline (was '${scopeResult.scope}')`,
      details: scopeResult,
    };
  }
  // Reviewer LOW-2: enforce both `priority: 0` AND `scope: baseline` per
  // rule-authoring.md Rule 11 trigger-scope clarification (line 263:
  // "priority: 0 + scope: baseline at time-of-invocation"). Header claim
  // and behavior now match.
  if (scopeResult.priority !== "0") {
    return {
      mandated: false,
      reason: `priority-at-date-not-0 (was '${scopeResult.priority}')`,
      details: scopeResult,
    };
  }
  return {
    mandated: true,
    reason: "rule-10-mandated-invocation",
    details: scopeResult,
  };
}

// --- Main ---------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    rule: null,
    proposalDate: null,
    asOfDate: null,
    journalDir: null,
    windowDays: DEFAULT_WINDOW_DAYS,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--rule") out.rule = argv[++i];
    else if (a === "--proposal-date") out.proposalDate = argv[++i];
    else if (a === "--as-of-date") out.asOfDate = argv[++i];
    else if (a === "--journal-dir") out.journalDir = argv[++i];
    else if (a === "--window-days") out.windowDays = parseInt(argv[++i], 10);
    else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else {
      console.error(`unexpected positional argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function usage() {
  return `validate-extraction-history.mjs — Rule 11 Phase-2 mechanical sweep

usage:
  node .claude/bin/validate-extraction-history.mjs --rule <path> \\
                                                  --proposal-date <YYYY-MM-DD> \\
                                                  [--as-of-date <YYYY-MM-DD>] \\
                                                  [--journal-dir <path>] \\
                                                  [--window-days <N>] \\
                                                  [--json] [--help]

required:
  --rule PATH            path to the rule file under review
                         (e.g. rules/rule-authoring.md or .claude/rules/foo.md)
  --proposal-date DATE   the receipt-journal date of the current proposal
                         (YYYY-MM-DD)

optional:
  --as-of-date DATE      operator's claimed system-clock date (SM1 binding;
                         MUST match --proposal-date when both supplied)
  --journal-dir PATH     defaults to <repo>/journal
  --window-days N        defaults to 30 (Rule 11's spec window)
  --json                 emit JSON report to stdout
  --help, -h             show this message and exit 0

exit codes:
  0   no prior Rule-11-mandated invocations within window (inclusive of
      windowDays; Rule 11 does NOT fire)
  1   ≥1 prior Rule-11-mandated invocation found (Rule 11 fires)
  2   usage / IO error

what it does:
  - walks <journal-dir>/*.md for entries with Rule-10-disposition anchors
  - verifies the touched rule was scope:baseline at each entry's date
    via git log --follow (SM2 — rule-rename detect)
  - counts mandated matches within --window-days of --proposal-date
  - emits structured report; exit 1 if count >= 1

phase-1 → phase-2 trigger:
  Phase 2 (this script) is the mechanical version of cc-architect's manual
  Rule 11 sweep. Gate-wiring into /codify proposal-validation is DEFERRED
  per trust-posture.md MUST Rule 7 — requires >=3 real manual sweep cycles
  first (the F23b-Phase-2 forest follow-up tracker).
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    process.exit(0);
  }

  // Required-arg validation
  if (!args.rule) {
    console.error("error: --rule is required");
    console.error(usage());
    process.exit(2);
  }
  if (!args.proposalDate || !DATE_RE.test(args.proposalDate)) {
    console.error(
      `error: --proposal-date is required and must be YYYY-MM-DD (got '${args.proposalDate}')`,
    );
    process.exit(2);
  }

  // SM1: asOfDate binding
  if (args.asOfDate) {
    if (!DATE_RE.test(args.asOfDate)) {
      console.error(`error: --as-of-date must be YYYY-MM-DD (got '${args.asOfDate}')`);
      process.exit(2);
    }
    if (args.asOfDate !== args.proposalDate) {
      console.error(
        `error: --as-of-date '${args.asOfDate}' MUST match --proposal-date '${args.proposalDate}' (SM1 system-clock binding)`,
      );
      process.exit(2);
    }
  }

  if (!Number.isFinite(args.windowDays) || args.windowDays <= 0) {
    console.error(`error: --window-days must be a positive integer`);
    process.exit(2);
  }

  const repoRoot = findRepoRoot(process.cwd());
  const journalDir = args.journalDir
    ? resolve(args.journalDir)
    : join(repoRoot, "journal");

  if (!existsSync(journalDir)) {
    console.error(`error: journal dir not found: ${journalDir}`);
    process.exit(2);
  }

  // Security-reviewer LOW-2: emit advisory when --journal-dir resolves
  // outside the repoRoot tree. Not blocking (operator trust boundary; they
  // own the CWD), but a loud warning prevents the silent-misconfig footgun.
  const journalDirRel = relative(repoRoot, journalDir);
  if (journalDirRel.startsWith("..") || journalDirRel === "" || journalDirRel.startsWith("/")) {
    process.stderr.write(
      `validate-extraction-history: warning: --journal-dir resolves outside repo root (${journalDir}); proceeding under operator trust\n`,
    );
  }

  // Analyst FM-B1: rule-authoring.md:300 specifies the recurrence dimension
  // as the (rule, CLI) LANE — F25 currently classifies by (rule) only.
  // Phase-1 disposition: emit a loud disclosure so the operator + the
  // cc-architect's manual sweep both see the gap. Forest follow-up
  // F25/PerCLILane tracks the lane-extraction work.
  process.stderr.write(
    `validate-extraction-history: NOTE: this validator collapses Rule 11's (rule, CLI) lane to (rule) only. Cross-check with cc-architect's manual sweep for CLI-specific disambiguation. Tracked as F25/PerCLILane.\n`,
  );

  const entries = listJournalEntries(journalDir);
  const findings = [];

  for (const entry of entries) {
    let text;
    try {
      text = readFileSync(entry.path, "utf8");
    } catch (e) {
      // Per F22 reviewer HIGH-4 pattern: log + continue, do NOT exit 2.
      process.stderr.write(
        `validate-extraction-history: read-failed: ${relative(repoRoot, entry.path)}: ${e.message}\n`,
      );
      continue;
    }
    const fm = parseFrontmatter(text);
    const entryDate = fm.get("date");
    if (!entryDate || !DATE_RE.test(entryDate)) continue;
    // Window filter: entry must be within [proposal-date - windowDays, proposal-date].
    // Reviewer MEDIUM-3: warn when entry dated AFTER proposal-date (likely
    // operator bug — backdated proposal or wrong --proposal-date arg).
    const delta = daysBetween(args.proposalDate, entryDate);
    if (delta < 0) {
      process.stderr.write(
        `validate-extraction-history: warning: entry ${entry.name} is dated ${entryDate} (after --proposal-date ${args.proposalDate}); skipped\n`,
      );
      continue;
    }
    if (delta > args.windowDays) continue;
    // Classify
    const cls = classifyEntry(entry.path, text, fm, args.rule, repoRoot);
    findings.push({
      entry: entry.name,
      date: entryDate,
      days_before_proposal: delta,
      mandated: cls.mandated,
      reason: cls.reason,
      details: cls.details,
    });
  }

  const mandated = findings.filter((f) => f.mandated);
  const ruleFires = mandated.length >= 1;

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: !ruleFires,
          rule: args.rule,
          proposal_date: args.proposalDate,
          window_days: args.windowDays,
          journal_dir: relative(repoRoot, journalDir),
          rule_11_fires: ruleFires,
          mandated_count: mandated.length,
          // Analyst FM-B1: per-CLI lane reduction; flagged in JSON
          // output for programmatic consumers (cc-architect manual sweep,
          // future Phase-2 gate wiring).
          warnings: [
            "lane-collapse: (rule, CLI) reduced to (rule) — see F25/PerCLILane forest follow-up",
          ],
          mandated,
          all_findings: findings,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(
      `validate-extraction-history: rule=${args.rule} proposal-date=${args.proposalDate} window=${args.windowDays}d\n`,
    );
    process.stdout.write(
      `  scanned ${entries.length} journal entries; ${findings.length} in window; ${mandated.length} Rule-11-mandated\n`,
    );
    if (mandated.length > 0) {
      process.stdout.write("\nRULE 11 FIRES — prior Rule-10-mandated invocations:\n");
      for (const m of mandated) {
        process.stdout.write(
          `  ${m.entry}  date=${m.date}  Δ=${m.days_before_proposal}d  scope-at-date=${m.details?.scope || "?"}\n`,
        );
      }
      process.stdout.write(
        "\nRequired disposition (per rule-authoring.md MUST Rule 11):\n" +
          "  (a') corpus-level forest item with 4 mandatory sub-elements, OR\n" +
          "  (b') named-rationale with sub-field (vi) per .claude/skills/skill-authoring/proximity-band-named-rationale-template.md\n",
      );
    }
  }

  process.exit(ruleFires ? 1 : 0);
}

// Export internals for audit-fixture harness
const __filename = fileURLToPath(import.meta.url);
const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

export {
  parseDateUTC,
  daysBetween,
  parseFrontmatter,
  hasRule10Anchor,
  citesRule,
  classifyEntry,
  getScopeAtDate,
  listJournalEntries,
  findRepoRoot,
  RULE10_ANCHORS,
};

if (isMain) main();
