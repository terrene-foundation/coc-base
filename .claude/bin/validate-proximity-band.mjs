#!/usr/bin/env node
/*
 * ============================================================================
 *  Proximity-Band Validator — F23e (journal/0155)
 *  Rule 10 Phase-2a Mechanical Sweep per rule-authoring.md MUST Rule 10
 * ============================================================================
 *
 *  Mechanical detector for the DETECTION half of Rule 10's admission gate.
 *  Closes sub-items 1-3 (near-breach + diff scan); sub-items 4-5
 *  (5-sub-field rationale validation + BLOCKED-corpus grep) — the
 *  bypass-attempt-detection PRIMARY check — are DEFERRED to a separate
 *  sub-shard tracked as F23e-Phase-2b (analyst FM-D + FM-G4).
 *
 *  Phase-2a vs Phase-2b nomenclature (analyst FM-E):
 *    Phase-2a (this script)   = near-breach DETECTION + diff scan
 *    Phase-2b (deferred)      = rationale-exception VALIDATION +
 *                               BLOCKED-rationalization corpus grep
 *
 *  Detection contract closed by Phase-2a (per rule-authoring.md MUST
 *  Rule 10 §Detection mechanism, line ~300, sub-items (a)+(b)):
 *    1. Run `node .claude/bin/emit.mjs --all --dry-run` against the
 *       proposal's working tree; parse stdout for per-CLI per-lang
 *       lane `headroom_pct` rows.
 *    2. For each lane with `headroom_pct < proximityBandPct` (default
 *       15%): record as a NEAR-BREACH lane.
 *    3. Scan the proposal's diff against `--base` (default `origin/main`)
 *       for NEW MUST / MUST NOT / BLOCKED additions on rules whose
 *       frontmatter declares `priority: 0` + `scope: baseline`.
 *    4. Cross-reference: ANY baseline-rule additions in the diff AND
 *       ANY near-breach lane → Rule 10 FIRES (Phase-2a verdict).
 *
 *  Phase-2a EXIT 0 does NOT mean "Rule 10 cleared" — it means the
 *  detection half cleared. cc-architect MUST run the Phase-2b manual
 *  sweep (5-sub-field validation + BLOCKED-corpus grep against the
 *  receipt journal's named-rationale exception text) BEFORE declaring
 *  full Rule 10 disposition. The JSON output `coverage_limitations`
 *  field names the deferred sub-items so the caller cannot accidentally
 *  conflate Phase-2a clean with Rule 10 cleared.
 *
 *  Phase-1 → Phase-2 trigger: Phase 2a (this script) is the mechanical
 *  version of cc-architect's Phase-1 manual sweep DETECTION half. It
 *  ships STANDALONE — NOT yet wired into /codify proposal-validation as
 *  a hard gate. Wiring requires real cc-architect manual sweep cycles
 *  first per `trust-posture.md` MUST Rule 7 Two-Phase Rollout.
 *
 *  Pairs with F23a's `proximity-band-budget` audit-fixture suite and F25
 *  (validate-extraction-history.mjs — Rule 11 escalation across (rule,
 *  CLI) pairs). The output of this validator IS the input to Rule 11's
 *  recurrence-window count: when this validator exits 1 the proposal's
 *  receipt journal MUST carry the Rule 10 disposition anchor language
 *  that F25's mechanical sweep keys on.
 *
 *  Exit:
 *    0 = clean — either no near-breach lane OR no baseline-rule
 *        additions in diff (Rule 10 does NOT fire)
 *    1 = Rule 10 FIRES — ≥1 near-breach lane AND ≥1 baseline-rule
 *        addition in diff; cc-architect demands paired extraction
 *        OR named-rationale exception per Rule 10
 *    2 = usage / IO error
 *
 *  Value-anchor (per `value-prioritization.md` MUST-1 source c — journal
 *  DECISION entries): `journal/0155` § F23e names this script as the
 *  Phase-2 trigger automation; `rule-authoring.md` MUST Rule 10
 *  Detection mechanism line ~300 defers Phase 2 here. F23e closes that
 *  deferral as a STANDALONE Phase-2 helper.
 *
 *  Usage:
 *    node .claude/bin/validate-proximity-band.mjs [--base REF] \
 *                                                 [--head REF] \
 *                                                 [--proximity-band-pct N] \
 *                                                 [--repo-root PATH] \
 *                                                 [--json] [--help]
 *
 *  THIS SCRIPT IS A SYNCED ARTIFACT (`bin/**` per sync-manifest.yaml).
 *  Zero client/org tokens; detection is purely structural.
 * ============================================================================
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, relative, basename } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  HEADROOM_PROXIMITY_BAND_PCT_DEFAULT,
  getProximityBandAdvisory,
} from "./emit.mjs";

// --- Constants ----------------------------------------------------------

const DEFAULT_BASE_REF = "origin/main";
const DEFAULT_HEAD_REF = "HEAD";

// Anchor patterns for NEW baseline-rule load-bearing additions. A line
// added by the proposal (diff `+` prefix, NOT context) matches when it
// contains one of these markers. Substring + case-sensitive — the
// canonical Loud/Linguistic prose uses these exact spellings per
// rule-authoring.md MUST Rule 1.
const LOAD_BEARING_MARKERS = ["MUST", "MUST NOT", "BLOCKED"];

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
      `validate-proximity-band: warning: git rev-parse failed for cwd=${startDir}; using cwd as repo root\n`,
    );
    return startDir;
  }
}

// --- Frontmatter parsing (mirrors validate-extraction-history.mjs) -------

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

// True iff the rule's frontmatter declares the baseline-emission lane
// (priority:0 AND scope:baseline). This is the same predicate F25 uses
// for Rule 11 scope-at-date verification — a path-scoped rule does NOT
// fire Rule 10's gate.
function isBaselineRule(rulePath, repoRoot) {
  const absPath = resolve(repoRoot, rulePath);
  if (!existsSync(absPath)) return false;
  let text;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return false;
  }
  const fm = parseFrontmatter(text);
  // priority can be unset (some legacy rules) — default 0 per emission
  // logic in emit.mjs::getCritBaseline (looks for `priority: 0`).
  const priority = fm.get("priority");
  const scope = fm.get("scope");
  // Match emit.mjs::getCritBaseline behavior: a rule is baseline iff
  // priority: 0 is explicit. scope:baseline is the second half of the
  // gate (rule-authoring.md MUST Rule 10 "Trigger scope" clause: fires
  // on priority:0 + scope:baseline rules ONLY).
  return priority === "0" && scope === "baseline";
}

// --- Emit dry-run runner -------------------------------------------------

// Runs `node .claude/bin/emit.mjs --all --dry-run` as a subprocess and
// parses stdout into a list of per-CLI lane records. Why subprocess and
// not a direct import: emit.mjs::main() has side effects (telemetry
// writes, validator invocations with process.exit on failure); the
// subprocess shape matches the Detection mechanism prose verbatim and
// keeps the validator's blast radius bounded to its own process.
//
// Returns: {
//   ok: boolean,
//   exit_code: number,
//   stdout: string,
//   stderr: string,
//   lanes: Array<{ cli, headroom_pct, advisory_fired, raw_line }>,
// }
//
// Lane records are derived from stable stdout lines emitted by
// `emitBaseline()` (emit.mjs:543+):
//   `[<cli>] ADVISORY: headroom X.XX% within Y% proximity band`  (within band)
//   `[<cli>] WARN: ... B in [WARN_CAP, BLOCK_CAP) ...`            (tier summary)
//   `[<cli>] HARD BLOCK: ...`                                     (cap breach)
//   `[<cli>] headroom-floor BLOCK|WARN: X.XX% < Y% floor ...`     (floor breach)
//
// The ADVISORY line carries the live headroom_pct. For lanes whose
// advisory did NOT fire, we infer headroom_pct >= proximityBandPct
// (clean above-band) — no row recorded as near-breach.
export function runEmitDryRun(repoRoot, { langs = [null] } = {}) {
  const lanes = [];
  let combinedStdout = "";
  let combinedStderr = "";
  let exitCode = 0;

  for (const lang of langs) {
    const args = ["--all", "--dry-run"];
    if (lang) args.push("--lang", lang);
    // emit.mjs lives at .claude/bin/emit.mjs from repo root. Use a
    // RELATIVE path against cwd=repoRoot so emit's `if (import.meta.url
    // === \`file://${process.argv[1]}\`)` entry-point check fires. On
    // macOS, an absolute path through /var/folders/... gets canonicalized
    // to /private/var/folders/... by import.meta.url while process.argv[1]
    // retains the un-canonicalized form — the entry-point guard then
    // silently returns without invoking main(), producing zero stdout.
    // Relative-path-with-cwd avoids the realpath asymmetry entirely.
    const scriptAbs = join(repoRoot, ".claude", "bin", "emit.mjs");
    if (!existsSync(scriptAbs)) {
      return {
        ok: false,
        exit_code: 2,
        stdout: combinedStdout,
        stderr: `emit.mjs not found at ${scriptAbs}\n` + combinedStderr,
        lanes: [],
      };
    }
    const scriptRel = join(".claude", "bin", "emit.mjs");
    // Reviewer R1 M3: 30s timeout per subprocess (loud failure beats hang).
    const result = spawnSync("node", [scriptRel, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30000,
    });
    if (result.error) {
      return {
        ok: false,
        exit_code: 2,
        stdout: combinedStdout,
        stderr: `spawn failed: ${result.error.message}\n` + combinedStderr,
        lanes: [],
      };
    }
    combinedStdout += result.stdout || "";
    combinedStderr += result.stderr || "";
    // emit.mjs exits 1 on validator failures or strict-headroom breach;
    // we surface the worst exit code observed across lang passes.
    if (result.status !== 0 && exitCode === 0) exitCode = result.status;

    // Parse ADVISORY lines for live headroom_pct values.
    // Line shape (emit.mjs:679-683):
    //   `[<cli>] ADVISORY: headroom X.XX% within Y% proximity band — next ...`
    const advisoryRe =
      /^\[([a-z]+)\] ADVISORY: headroom (-?\d+\.\d+|-?\d+)% within (\d+(?:\.\d+)?)% proximity band/;
    // We also note tier-summary lines so non-advisory lanes are
    // recorded (advisory_fired=false). Without the tier-summary we
    // would silently miss lanes whose headroom_pct is clean.
    // Line shape (emit.mjs:1250):
    //   `[<cli>] <TIER>: <rules> rules, <bytes>B → <path>`
    const tierRe = /^\[([a-z]+)\] (OK|WARN|BLOCK): (\d+) rules, (\d+)B/;
    // Floor-breach line shape (emit.mjs:1305):
    //   `[<cli>(<lang>)?] headroom-floor (BLOCK|WARN): X.XX% < Y% floor`
    const floorRe =
      /^\[([a-z]+)(?: ([a-z]+))?\] headroom-floor (BLOCK|WARN): (-?\d+\.\d+|-?\d+)% < (\d+(?:\.\d+)?)% floor/;

    // Per-lang lane key: cli + lang. base lane has lang=null.
    const laneKey = (cli) => `${cli}|${lang || "base"}`;
    const advisorySeen = new Map();
    const tierSeen = new Map();
    const floorSeen = new Map();
    // Reviewer R1 M1: parse-drift loud failure. After processing the lines
    // below, if stdout had bytes BUT zero tier-summary matches, the
    // emit.mjs output format has drifted and the validator MUST surface
    // it rather than silently report zero lanes.
    const stdoutForParseCheck = result.stdout || "";
    for (const line of (result.stdout || "").split("\n")) {
      let m = line.match(advisoryRe);
      if (m) {
        advisorySeen.set(laneKey(m[1]), {
          cli: m[1],
          lang: lang || "base",
          headroom_pct: Number(m[2]),
          proximity_band_pct: Number(m[3]),
          advisory_fired: true,
          raw_line: line,
        });
        continue;
      }
      m = line.match(tierRe);
      if (m) {
        tierSeen.set(laneKey(m[1]), {
          cli: m[1],
          lang: lang || "base",
          tier: m[2],
          rules: Number(m[3]),
          emission_bytes: Number(m[4]),
          raw_line: line,
        });
        continue;
      }
      m = line.match(floorRe);
      if (m) {
        floorSeen.set(laneKey(m[1]), {
          cli: m[1],
          lang: m[2] || lang || "base",
          headroom_pct: Number(m[4]),
          headroom_floor_pct: Number(m[5]),
          floor_breach: true,
          raw_line: line,
        });
        continue;
      }
    }

    // Parse-drift detection (reviewer R1 M1): non-empty stdout + zero
    // tier-summary matches = emit.mjs output format has changed and
    // validator parse is silently no-op-ing. Loud-failure beats silent
    // zero-lane verdict.
    if (stdoutForParseCheck.trim().length > 0 && tierSeen.size === 0) {
      return {
        ok: false,
        exit_code: 2,
        stdout: combinedStdout,
        stderr:
          `emit.mjs parse drift: stdout has ${stdoutForParseCheck.length} bytes but ` +
          `zero tier-summary matches; expected at least one line matching ` +
          `${tierRe.toString()}\n` +
          combinedStderr,
        lanes: [],
        parse_drift: true,
      };
    }

    // Merge: every lane that emitted a tier-summary gets a record;
    // advisory + floor overlays attach if present.
    for (const [key, tier] of tierSeen) {
      const adv = advisorySeen.get(key);
      const fl = floorSeen.get(key);
      lanes.push({
        cli: tier.cli,
        lang: tier.lang,
        tier: tier.tier,
        rules: tier.rules,
        emission_bytes: tier.emission_bytes,
        advisory_fired: !!adv,
        headroom_pct: adv ? adv.headroom_pct : null,
        proximity_band_pct: adv
          ? adv.proximity_band_pct
          : HEADROOM_PROXIMITY_BAND_PCT_DEFAULT,
        floor_breach: !!fl,
        floor_breach_headroom_pct: fl ? fl.headroom_pct : null,
        raw_lines: [tier.raw_line, adv?.raw_line, fl?.raw_line].filter(Boolean),
      });
    }
  }

  return {
    ok: exitCode === 0,
    exit_code: exitCode,
    stdout: combinedStdout,
    stderr: combinedStderr,
    lanes,
  };
}

// --- Proposal-diff scanner ----------------------------------------------

// Scans `git diff <base>..<head> -- .claude/rules/*.md` for ADDED lines
// (diff `+` prefix, NOT context) containing LOAD_BEARING_MARKERS, and
// filters to rules whose frontmatter (at HEAD) declares priority:0 +
// scope:baseline. Returns:
//   {
//     ok: boolean,
//     base, head,
//     additions: Array<{ rule_path, line_text, marker, baseline_at_head }>,
//     baseline_additions: Array<...> (subset where baseline_at_head=true),
//     warnings: Array<string>,
//   }
export function scanProposalDiffForBaselineAdditions(
  repoRoot,
  baseRef,
  headRef,
) {
  const warnings = [];
  let diffOut;
  try {
    diffOut = execFileSync(
      "git",
      [
        "diff",
        "--unified=0",
        // diff <base>..<head> shows changes from base to head
        `${baseRef}..${headRef}`,
        "--",
        ".claude/rules/",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024, // 64MB — large diffs allowed
        timeout: 30000, // reviewer R1 M3: 30s subprocess cap
      },
    );
  } catch (e) {
    warnings.push(
      `git diff failed (base=${baseRef} head=${headRef}): ${e.message?.slice(0, 200) || "unknown"}`,
    );
    return {
      ok: false,
      base: baseRef,
      head: headRef,
      additions: [],
      baseline_additions: [],
      warnings,
    };
  }

  // Parse unified diff. Track current file as we walk the hunk headers.
  const additions = [];
  let curFile = null;
  for (const line of diffOut.split("\n")) {
    // File header: `+++ b/.claude/rules/foo.md`
    if (line.startsWith("+++ b/")) {
      curFile = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("+++ /dev/null") || line.startsWith("--- /dev/null")) {
      // file delete / add — keep curFile from the +++ line for adds
      continue;
    }
    // Skip the --- and +++ headers themselves; only count REAL added lines
    // (start with single `+`, not `+++`).
    if (!line.startsWith("+")) continue;
    if (line.startsWith("+++")) continue;
    if (!curFile) continue;
    // Only count additions under .claude/rules/*.md.
    if (!curFile.startsWith(".claude/rules/")) continue;
    if (!curFile.endsWith(".md")) continue;
    const addedText = line.slice(1); // strip the leading `+`
    // Check for load-bearing markers. Token-boundary check: `MUST` as a
    // word (not "MUSTard"), `MUST NOT` as the two-token sequence,
    // `BLOCKED` as a word. The token regex prevents false-positives on
    // arbitrary capitalized words containing the substring.
    let matchedMarker = null;
    if (/\bMUST NOT\b/.test(addedText)) matchedMarker = "MUST NOT";
    else if (/\bMUST\b/.test(addedText)) matchedMarker = "MUST";
    else if (/\bBLOCKED\b/.test(addedText)) matchedMarker = "BLOCKED";
    if (!matchedMarker) continue;
    additions.push({
      rule_path: curFile,
      line_text: addedText.length > 200 ? addedText.slice(0, 200) + "…" : addedText,
      marker: matchedMarker,
      baseline_at_head: false, // filled in below
    });
  }

  // Filter to baseline-priority rules at HEAD. We classify by the rule's
  // current frontmatter on disk (worktree) because the proposal's
  // additions live at HEAD. A rule that USED to be baseline but is
  // path-scoped at HEAD is NOT a Rule 10 trigger (the gate only fires
  // on rules currently in baseline emission).
  const baselineCache = new Map();
  for (const a of additions) {
    if (!baselineCache.has(a.rule_path)) {
      baselineCache.set(a.rule_path, isBaselineRule(a.rule_path, repoRoot));
    }
    a.baseline_at_head = baselineCache.get(a.rule_path);
  }

  const baseline_additions = additions.filter((a) => a.baseline_at_head);

  return {
    ok: true,
    base: baseRef,
    head: headRef,
    additions,
    baseline_additions,
    warnings,
  };
}

// --- Main ---------------------------------------------------------------

// Input-validation predicates (security-reviewer R1 fixes):
//   MEDIUM-1: git refs must not start with `-` (option-injection class).
//   MEDIUM-3: --lang must be from a closed allowlist.
const GIT_REF_RE = /^[A-Za-z0-9._/\-]+$/;
const VALID_LANGS = new Set(["py", "rs", "base"]);

function isValidGitRef(s) {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    s[0] !== "-" &&
    GIT_REF_RE.test(s)
  );
}

function parseArgs(argv) {
  const out = {
    base: DEFAULT_BASE_REF,
    head: DEFAULT_HEAD_REF,
    proximityBandPct: HEADROOM_PROXIMITY_BAND_PCT_DEFAULT,
    repoRoot: null,
    langs: [null], // base lane only by default; pass --lang to extend
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--base") {
      const v = argv[++i];
      if (!isValidGitRef(v)) {
        console.error(
          `error: --base must match ${GIT_REF_RE} (no leading '-'); got '${v}'`,
        );
        process.exit(2);
      }
      out.base = v;
    } else if (a === "--head") {
      const v = argv[++i];
      if (!isValidGitRef(v)) {
        console.error(
          `error: --head must match ${GIT_REF_RE} (no leading '-'); got '${v}'`,
        );
        process.exit(2);
      }
      out.head = v;
    } else if (a === "--proximity-band-pct") {
      const v = parseFloat(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        console.error(`error: --proximity-band-pct must be a positive number`);
        process.exit(2);
      }
      out.proximityBandPct = v;
    } else if (a === "--repo-root") out.repoRoot = argv[++i];
    else if (a === "--lang") {
      const v = argv[++i];
      if (!VALID_LANGS.has(v)) {
        console.error(
          `error: --lang must be one of ${[...VALID_LANGS].join(", ")}; got '${v}'`,
        );
        process.exit(2);
      }
      // Allow --lang py, --lang rs, or --lang base (=null)
      if (v === "base") out.langs.push(null);
      else out.langs.push(v);
    } else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else {
      console.error(`unexpected positional argument: ${a}`);
      process.exit(2);
    }
  }
  // Deduplicate langs while preserving order.
  out.langs = Array.from(new Set(out.langs));
  return out;
}

function usage() {
  return `validate-proximity-band.mjs — Rule 10 Phase-2 mechanical sweep

usage:
  node .claude/bin/validate-proximity-band.mjs [--base REF] [--head REF] \\
                                               [--proximity-band-pct N] \\
                                               [--repo-root PATH] \\
                                               [--lang py|rs|base] \\
                                               [--json] [--help]

optional:
  --base REF              base ref for proposal diff (default: origin/main)
  --head REF              head ref for proposal diff (default: HEAD)
  --proximity-band-pct N  proximity-band percentage override
                          (default: emit.mjs HEADROOM_PROXIMITY_BAND_PCT_DEFAULT)
  --repo-root PATH        explicit repo root (default: git rev-parse)
  --lang py|rs|base       additional lang lanes to scan (repeatable);
                          default scans only base lanes (codex+gemini)
  --json                  emit JSON report to stdout
  --help, -h              show this message and exit 0

exit codes:
  0   clean — no near-breach lane OR no baseline-rule additions in diff
      (Rule 10 does NOT fire)
  1   Rule 10 FIRES — ≥1 near-breach lane AND ≥1 baseline-rule addition
      in diff; cc-architect demands paired extraction OR named-rationale
      exception per rule-authoring.md MUST Rule 10
  2   usage / IO error

what it does (per rule-authoring.md MUST Rule 10 Detection mechanism):
  - runs \`node .claude/bin/emit.mjs --all --dry-run\` and parses stdout
    for per-CLI lane headroom_pct values
  - identifies NEAR-BREACH lanes (headroom_pct < proximity-band-pct)
  - runs \`git diff <base>..<head> -- .claude/rules/\` and extracts NEW
    MUST / MUST NOT / BLOCKED additions on rules whose frontmatter (at
    HEAD) declares priority:0 + scope:baseline
  - cross-references: ANY baseline-rule additions AND ANY near-breach
    lane → exit 1 (Rule 10 fires)

phase-1 → phase-2 trigger:
  Phase 2 (this script) is the mechanical version of cc-architect's
  manual Rule-10 sweep. Sub-items 4 + 5 of the sweep (named-rationale
  5-sub-field validation + BLOCKED-corpus grep of exception text) are
  DEFERRED to a separate sub-shard; this validator closes sub-items 1-3
  only. Gate-wiring into /codify proposal-validation is DEFERRED per
  \`trust-posture.md\` § Two-Phase Rollout — requires real manual sweep
  cycles first.
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    process.exit(0);
  }

  const repoRoot = args.repoRoot
    ? resolve(args.repoRoot)
    : findRepoRoot(process.cwd());

  if (!existsSync(repoRoot)) {
    console.error(`error: repo root does not exist: ${repoRoot}`);
    process.exit(2);
  }

  // Security-reviewer MEDIUM-2: require the resolved repo root to be a real
  // loom-class checkout (must contain .claude/sync-manifest.yaml + the
  // emit.mjs binary we're about to spawn). Closes the foreign-repo class.
  const manifestPath = join(repoRoot, ".claude", "sync-manifest.yaml");
  const emitPath = join(repoRoot, ".claude", "bin", "emit.mjs");
  if (!existsSync(manifestPath) || !existsSync(emitPath)) {
    console.error(
      `error: repo root '${repoRoot}' is not a loom-class checkout ` +
        `(missing .claude/sync-manifest.yaml or .claude/bin/emit.mjs)`,
    );
    process.exit(2);
  }

  // Analyst FM-B (HIGH): validate that the diff base ref is resolvable
  // BEFORE running emit. A stale or shallow clone where `origin/main`
  // does not exist would otherwise produce a silent "ok:false, no diff"
  // verdict that callers could mistake for "Rule 10 cleared". Convert
  // the unresolvable-base case to a loud exit 2 per
  // `verify-resource-existence.md` MUST-1.
  if (args.base !== "HEAD") {
    try {
      execFileSync("git", ["rev-parse", "--verify", args.base], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      });
    } catch {
      console.error(
        `error: --base ref '${args.base}' is not resolvable in this checkout. ` +
          `In CI runners with shallow clones, run \`git fetch origin main --depth=N\` ` +
          `first OR pass an explicit --base REF. Refusing to silently proceed ` +
          `with an unresolvable diff base (analyst FM-B).`,
      );
      process.exit(2);
    }
  }

  // Run emit dry-run + parse lanes.
  const emit = runEmitDryRun(repoRoot, { langs: args.langs });

  // Identify near-breach lanes. A lane is near-breach iff EITHER
  // (a) emit.mjs printed the ADVISORY line (advisory_fired=true), OR
  // (b) the parsed headroom_pct is below --proximity-band-pct override
  //     when that override is HIGHER than the band the advisory used.
  // The override path lets cc-architect tighten the band for sensitive
  // proposals without re-running emit with a per-CLI manifest change.
  const nearBreachLanes = emit.lanes.filter((l) => {
    if (l.floor_breach) return true; // floor breach is the strongest signal
    if (l.advisory_fired) return true;
    if (l.headroom_pct !== null && l.headroom_pct < args.proximityBandPct) {
      return true;
    }
    return false;
  });

  // Scan proposal diff.
  const diff = scanProposalDiffForBaselineAdditions(repoRoot, args.base, args.head);

  const baselineAdditions = diff.baseline_additions || [];
  // Rule 10 FIRES iff BOTH near-breach lanes AND baseline-rule
  // additions are present.
  const ruleFires = nearBreachLanes.length > 0 && baselineAdditions.length > 0;

  // Compose verdict.
  let verdict;
  if (ruleFires) verdict = "fires";
  else if (nearBreachLanes.length > 0 && baselineAdditions.length === 0)
    verdict = "advisory_only_no_diff";
  else if (nearBreachLanes.length === 0 && baselineAdditions.length > 0)
    verdict = "clean_no_near_breach";
  else verdict = "clean";

  const report = {
    ok: !ruleFires,
    rule_10_fires: ruleFires,
    verdict,
    // Analyst FM-C (HIGH): name the sub-items this validator does NOT
    // cover so cc-architect's prompt cannot conflate Phase-2a clean
    // with Rule 10 cleared. Without this field, an exit-0 Phase-2a
    // run looks identical to "all Rule 10 sub-items pass".
    coverage_limitations: [
      "rule10.sub-item-4-deferred-5sub-field-rationale-validation",
      "rule10.sub-item-5-deferred-blocked-corpus-grep",
    ],
    repo_root: repoRoot,
    base: args.base,
    head: args.head,
    proximity_band_pct: args.proximityBandPct,
    proximity_band_default: HEADROOM_PROXIMITY_BAND_PCT_DEFAULT,
    emit: {
      ok: emit.ok,
      exit_code: emit.exit_code,
      lanes_scanned: emit.lanes.length,
      lanes: emit.lanes,
    },
    proposal_diff: {
      ok: diff.ok,
      additions_total: diff.additions?.length || 0,
      baseline_additions_total: baselineAdditions.length,
      baseline_additions: baselineAdditions,
      warnings: diff.warnings || [],
    },
    near_breach_lanes: nearBreachLanes,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(
      `validate-proximity-band: base=${args.base} head=${args.head} ` +
        `proximity-band-pct=${args.proximityBandPct}%\n`,
    );
    process.stdout.write(
      `  emit dry-run: exit=${emit.exit_code}, ${emit.lanes.length} lane(s) scanned\n`,
    );
    for (const l of emit.lanes) {
      const flags = [];
      if (l.advisory_fired) flags.push("ADVISORY");
      if (l.floor_breach) flags.push("FLOOR_BREACH");
      const hp = l.headroom_pct !== null ? `${l.headroom_pct}%` : "(above band)";
      process.stdout.write(
        `    [${l.cli} ${l.lang}] tier=${l.tier} emission=${l.emission_bytes}B ` +
          `headroom=${hp} ${flags.length ? "[" + flags.join(",") + "]" : ""}\n`,
      );
    }
    process.stdout.write(
      `  proposal diff: ${diff.additions?.length || 0} total MUST/MUST NOT/BLOCKED additions, ` +
        `${baselineAdditions.length} on priority:0 + scope:baseline rules\n`,
    );
    if (baselineAdditions.length > 0) {
      for (const a of baselineAdditions.slice(0, 5)) {
        process.stdout.write(
          `    ${a.rule_path}: [${a.marker}] ${a.line_text}\n`,
        );
      }
      if (baselineAdditions.length > 5) {
        process.stdout.write(
          `    ... and ${baselineAdditions.length - 5} more\n`,
        );
      }
    }
    if (diff.warnings && diff.warnings.length > 0) {
      for (const w of diff.warnings) {
        process.stderr.write(`  WARN: ${w}\n`);
      }
    }
    process.stdout.write(`  near-breach lanes: ${nearBreachLanes.length}\n`);
    process.stdout.write(`  verdict: ${verdict}\n`);

    if (ruleFires) {
      process.stdout.write(
        "\nRULE 10 FIRES — near-breach lane(s) AND new baseline-rule MUST/MUST NOT/BLOCKED additions.\n\n" +
          "Required disposition (per rule-authoring.md MUST Rule 10):\n" +
          "  (a) PAIRED EXTRACTION: ship an extraction-to-skill that recovers\n" +
          "      ≥ the bytes added (see .claude/skills/skill-authoring/\n" +
          "      proximity-band-named-rationale-template.md), OR\n" +
          "  (b) NAMED-RATIONALE EXCEPTION: carry the 5-sub-field exception in\n" +
          "      the proposal's receipt journal per the template.\n\n" +
          "Adding load-bearing content WITHOUT (a) or (b) on a near-breach\n" +
          "lane is BLOCKED per Rule 10.\n",
      );
    } else if (verdict === "advisory_only_no_diff") {
      process.stdout.write(
        "\nADVISORY — near-breach lane(s) exist, but the diff carries no new\n" +
          "baseline-rule MUST/MUST NOT/BLOCKED additions. Rule 10 does NOT fire.\n",
      );
    } else if (verdict === "clean_no_near_breach") {
      process.stdout.write(
        "\nCLEAN — new baseline-rule additions exist but no lane is in the\n" +
          "proximity band. Rule 10 does NOT fire.\n",
      );
    } else {
      process.stdout.write("\nCLEAN — no near-breach lanes; no new baseline-rule additions.\n");
    }
  }

  process.exit(ruleFires ? 1 : 0);
}

// Export internals for audit-fixture harness consumption.
const __filename = fileURLToPath(import.meta.url);
const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

export {
  parseFrontmatter,
  isBaselineRule,
  findRepoRoot,
  LOAD_BEARING_MARKERS,
  DEFAULT_BASE_REF,
  DEFAULT_HEAD_REF,
};

if (isMain) main();
