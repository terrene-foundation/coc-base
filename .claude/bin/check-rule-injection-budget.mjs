#!/usr/bin/env node
// check-rule-injection-budget.mjs — regression guard for the per-session
// RULE-INJECTION budget, specifically the PATH-SCOPED rule load tax that
// loom#678 exposed.
//
// Background (loom#678): path-scoped rules inject their WHOLE body once per
// session, the first time a tool call touches a path matching the rule's
// `paths:` globs (sticky-once, verified 2026-06-27). An over-broad glob — the
// `paths: ["doublestar/star"]` giants (multi-operator-coordination.md ~82.9 KB,
// user-flow-validation.md ~20.0 KB before extraction) — injects on EVERY
// session against ANY path, in EVERY repo. Levers A/B/C of #678 narrowed/
// extracted those; this harness LOCKS the gain: it measures, per canonical
// session profile, the total path-scoped bytes that would fire, and fails loud
// when (a) a profile's path-scoped injection regresses past tolerance, or
// (b) a NEW broad-load rule (fires in every profile) appears.
//
// It COMPOSES with — does NOT duplicate — the BASELINE-emission guard
// (emit.mjs per-rule/total budgets + validate-proximity-band.mjs headroom
// band). Those guard priority:0 scope:baseline rules emitted into AGENTS.md /
// GEMINI.md. This tool guards the PATH-SCOPED surface they do not measure.
// Baseline totals are reported as context only (raw rule-body bytes; emit.mjs
// remains authoritative for emitted baseline bytes).
//
// Usage:
//   node .claude/bin/check-rule-injection-budget.mjs            # check vs budget
//   node .claude/bin/check-rule-injection-budget.mjs --json     # machine-readable
//   node .claude/bin/check-rule-injection-budget.mjs --update   # regenerate snapshot
//   node .claude/bin/check-rule-injection-budget.mjs --help
//
// Exit codes: 0 = within budget; 1 = budget regression / new broad-load rule;
//             2 = usage error.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RULES_DIR = ".claude/rules";
const BUDGET_FILE = ".claude/rule-injection-budget.json";

// Canonical session profiles — representative touched-file sets. Each maps a
// session TYPE to the path(s) its first tool call typically hits. A rule whose
// `paths:` globs match ANY path in a profile injects its body in that session.
const PROFILES = {
  "loom-rule-edit": [".claude/rules/cc-artifacts.md"],
  "loom-bin-edit": [".claude/bin/emit.mjs"],
  "loom-skill-edit": [".claude/skills/30-claude-code-patterns/sync-flow.md"],
  "loom-command-edit": [".claude/commands/codify.md"],
  "workspace-note": ["workspaces/example/journal/0001-x.md"],
  "consumer-sdk-src": ["packages/kailash/src/core/runtime.py"],
  "consumer-test": ["tests/integration/test_runtime.py"],
  "root-doc": ["README.md"],
};

// Neutral universal probes — nested paths under roots NO specific rule governs,
// with neutral extensions. A rule whose globs match ALL of these is firing on
// paths it has no business governing — the over-broad-glob (#678-giant) signal.
// Requiring ALL probes (distinct roots + distinct extensions) means a genuinely
// narrow rule (`**/*.md`, `**/*.qqq`) is NOT flagged, only a universal glob
// (`**`, `**/*`) or an always-on (no-paths) rule is. This is robust to the
// root-doc edge: `**/*` does NOT match a no-slash `README.md`, so a profile-set
// test would miss the giants; the nested probes catch them.
const BROAD_PROBES = ["zz-broad-probe/deep/nested/file.qqq", "yy-broad-probe/other/leaf.zzz"];

// ── repo root ─────────────────────────────────────────────────────────────
function findRepoRoot(startDir) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || startDir;
  } catch {
    return startDir;
  }
}

// ── frontmatter + paths parsing ─────────────────────────────────────────────
// Returns { keys: Map<string,string>, pathsRaw: string[] }. `paths:` is parsed
// for BOTH inline-array (`paths: ["**/*"]`) AND block-list styles — the inline
// form is the one a list-style grep misses, which is exactly how the #678
// giants hid (`paths: ["**/*"]` invisible to `grep '^  - '`).
function parseFrontmatter(text) {
  const keys = new Map();
  const paths = [];
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") return { keys, paths };
  let i = 1;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "---") break;
    // Block-list `paths:` (value empty on the key line, items follow).
    const keyMatch = l.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    const val = keyMatch[2].trim();
    if (key === "paths") {
      if (val === "" || val === "|" || val === ">") {
        // Block list: subsequent `  - "glob"` lines until dedent to next key.
        for (let j = i + 1; j < lines.length; j++) {
          const item = lines[j];
          if (item.trim() === "---") break;
          const m = item.match(/^\s+-\s+(.*)$/);
          if (!m) break; // next key at column 0 or end of list
          paths.push(stripQuotes(m[1].trim()));
        }
      } else if (val.startsWith("[")) {
        // Inline array — the giant-hiding form.
        for (const tok of val.replace(/^\[/, "").replace(/\]$/, "").split(",")) {
          const t = stripQuotes(tok.trim());
          if (t) paths.push(t);
        }
      } else {
        paths.push(stripQuotes(val)); // bare scalar
      }
    } else {
      keys.set(key, val);
    }
  }
  return { keys, paths };
}

function stripQuotes(s) {
  return s.replace(/^["']/, "").replace(/["']$/, "");
}

// ── glob matching (mirrors coc-manifest.mjs::globToRegex — the canonical loom
// interpretation: `**`→`.*` cross-slash, `*`→`[^/]*`, `?` literal, anchored). ──
const _globCache = new Map();
function globToRegex(glob) {
  let re = _globCache.get(glob);
  if (re) return re;
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  const withStars = escaped
    .replace(/\*\*/g, "__DOUBLESTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLESTAR__/g, ".*");
  re = new RegExp(`^${withStars}$`);
  _globCache.set(glob, re);
  return re;
}

function matchesAny(relPath, globs) {
  for (const g of globs) {
    if (globToRegex(g).test(relPath)) return true;
  }
  return false;
}

// ── rule enumeration + classification ───────────────────────────────────────
// klass: "baseline"   — priority:0 + scope:baseline (guarded by emit.mjs)
//        "path-scoped"— has ≥1 non-empty path glob (the surface THIS tool guards)
//        "always-on"  — no paths AND not baseline (effectively injects everywhere)
function classify(keys, paths) {
  const priority = keys.get("priority");
  const scope = keys.get("scope");
  if (priority === "0" && scope === "baseline") return "baseline";
  if (paths.length > 0) return "path-scoped";
  return "always-on";
}

function loadRules(root) {
  const dir = join(root, RULES_DIR);
  if (!existsSync(dir)) return [];
  const rules = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    const { keys, paths } = parseFrontmatter(text);
    rules.push({ name, bytes, paths, klass: classify(keys, paths) });
  }
  rules.sort((a, b) => a.name.localeCompare(b.name));
  return rules;
}

// ── measurement ─────────────────────────────────────────────────────────────
// A rule fires in a profile iff any of its globs matches any of the profile's
// paths (the per-profile byte budget catches a rule GROWING or its glob
// WIDENING to fire on more profiles). broad-load = matches every neutral
// universal probe (the #678-giant signal — injects regardless of what it
// governs); always-on (no-paths) rules are broad-load by construction.
function measure(rules) {
  const profileNames = Object.keys(PROFILES);
  const pathScoped = rules.filter((r) => r.klass === "path-scoped");
  const alwaysOn = rules.filter((r) => r.klass === "always-on");
  const baseline = rules.filter((r) => r.klass === "baseline");

  const profiles = {};
  for (const p of profileNames) profiles[p] = { fired: [], pathScopedBytes: 0 };

  for (const r of pathScoped) {
    for (const p of profileNames) {
      if (matchesAny2(PROFILES[p], r.paths)) {
        profiles[p].fired.push(r.name);
        profiles[p].pathScopedBytes += r.bytes;
      }
    }
  }

  // always-on rules inject in every profile by construction.
  const alwaysOnBytes = alwaysOn.reduce((s, r) => s + r.bytes, 0);
  for (const p of profileNames) {
    for (const r of alwaysOn) {
      profiles[p].fired.push(r.name);
      profiles[p].pathScopedBytes += r.bytes;
    }
  }

  const broadLoad = pathScoped
    .filter((r) => matchesAllProbes(BROAD_PROBES, r.paths))
    .map((r) => ({ name: r.name, bytes: r.bytes }))
    .concat(alwaysOn.map((r) => ({ name: r.name, bytes: r.bytes, alwaysOn: true })))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    baselineRawBytes: baseline.reduce((s, r) => s + r.bytes, 0),
    baselineCount: baseline.length,
    alwaysOnBytes,
    profiles,
    broadLoad,
    pathScopedCount: pathScoped.length,
  };
}

function matchesAny2(profilePaths, globs) {
  for (const pp of profilePaths) {
    if (matchesAny(pp, globs)) return true;
  }
  return false;
}

// True iff the rule's globs match EVERY probe (a genuinely universal glob).
function matchesAllProbes(probes, globs) {
  for (const probe of probes) {
    if (!matchesAny(probe, globs)) return false;
  }
  return true;
}

// ── budget snapshot ─────────────────────────────────────────────────────────
function buildSnapshot(m) {
  const profiles = {};
  for (const [p, v] of Object.entries(m.profiles)) {
    profiles[p] = { path_scoped_bytes: v.pathScopedBytes, fired_count: v.fired.length };
  }
  return {
    _comment:
      "loom#678 path-scoped rule-injection budget snapshot. Regenerate with " +
      "`node .claude/bin/check-rule-injection-budget.mjs --update`. A NEW broad_load " +
      "rule, or a profile exceeding path_scoped_bytes*(1+tolerance_pct/100), fails the guard.",
    tolerance_pct: 5,
    profiles,
    broad_load_rules: m.broadLoad.map((b) => b.name).sort(),
    broad_load_total_bytes: m.broadLoad.reduce((s, b) => s + b.bytes, 0),
  };
}

function compare(m, budget) {
  const failures = [];
  const tol = (budget.tolerance_pct ?? 5) / 100;
  for (const [p, v] of Object.entries(m.profiles)) {
    const want = budget.profiles?.[p]?.path_scoped_bytes;
    if (want == null) {
      failures.push(`profile "${p}" missing from budget snapshot (run --update)`);
      continue;
    }
    const ceiling = Math.floor(want * (1 + tol));
    if (v.pathScopedBytes > ceiling) {
      failures.push(
        `profile "${p}" path-scoped injection ${v.pathScopedBytes} B exceeds ` +
          `budget ${want} B +${(tol * 100).toFixed(0)}% tolerance (ceiling ${ceiling} B)`,
      );
    }
  }
  const budgetBroad = new Set(budget.broad_load_rules || []);
  for (const b of m.broadLoad) {
    if (!budgetBroad.has(b.name)) {
      failures.push(
        `NEW broad-load rule "${b.name}" (${b.bytes} B) fires in every session ` +
          `profile — over-broad glob (#678 class). Narrow/extract it, or accept via --update.`,
      );
    }
  }
  return failures;
}

// ── reporting ───────────────────────────────────────────────────────────────
function humanReport(m, budget, failures) {
  const lines = [];
  lines.push("Rule-injection budget — path-scoped surface (loom#678 guard)");
  lines.push("");
  lines.push(
    `  baseline rules: ${m.baselineCount} (${m.baselineRawBytes} B raw body; ` +
      `emit.mjs is authoritative for emitted baseline)`,
  );
  lines.push(`  path-scoped rules: ${m.pathScopedCount}`);
  lines.push("");
  lines.push("  per-profile path-scoped injection (bytes / rules fired):");
  for (const [p, v] of Object.entries(m.profiles)) {
    const want = budget?.profiles?.[p]?.path_scoped_bytes;
    const delta = want != null ? ` (budget ${want})` : "";
    lines.push(`    ${p.padEnd(20)} ${String(v.pathScopedBytes).padStart(8)} B  / ${v.fired.length}${delta}`);
  }
  lines.push("");
  lines.push("  broad-load rules (fire in EVERY profile — #678-giant class):");
  if (m.broadLoad.length === 0) {
    lines.push("    (none)");
  } else {
    for (const b of m.broadLoad) {
      lines.push(`    ${b.name.padEnd(40)} ${String(b.bytes).padStart(8)} B${b.alwaysOn ? "  [always-on: no paths]" : ""}`);
    }
  }
  lines.push("");
  if (failures.length === 0) {
    lines.push("  ✓ within budget");
  } else {
    lines.push(`  ✗ ${failures.length} budget failure(s):`);
    for (const f of failures) lines.push(`    - ${f}`);
  }
  return lines.join("\n");
}

// ── main ────────────────────────────────────────────────────────────────────
function main(argv) {
  const args = new Set(argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    process.stdout.write(
      "check-rule-injection-budget.mjs — guard the path-scoped rule-injection budget (loom#678).\n" +
        "  --json    machine-readable output\n" +
        "  --update  regenerate the budget snapshot at " + BUDGET_FILE + "\n" +
        "  --help    this message\n",
    );
    return 0;
  }
  const root = findRepoRoot(process.cwd());
  const rules = loadRules(root);
  if (rules.length === 0) {
    process.stderr.write(`check-rule-injection-budget: no rules found under ${join(root, RULES_DIR)}\n`);
    return 2;
  }
  const m = measure(rules);
  const budgetPath = resolve(root, BUDGET_FILE);

  if (args.has("--update")) {
    const snap = buildSnapshot(m);
    writeFileSync(budgetPath, JSON.stringify(snap, null, 2) + "\n", "utf8");
    process.stdout.write(`Updated budget snapshot: ${BUDGET_FILE}\n`);
    if (args.has("--json")) process.stdout.write(JSON.stringify(snap, null, 2) + "\n");
    return 0;
  }

  let budget = null;
  if (existsSync(budgetPath)) {
    try {
      budget = JSON.parse(readFileSync(budgetPath, "utf8"));
    } catch (e) {
      process.stderr.write(`check-rule-injection-budget: budget snapshot unparseable: ${e.message}\n`);
      return 2;
    }
  }

  const failures = budget ? compare(m, budget) : ["no budget snapshot — run --update to establish a baseline"];

  if (args.has("--json")) {
    const profiles = {};
    for (const [p, v] of Object.entries(m.profiles)) {
      profiles[p] = { path_scoped_bytes: v.pathScopedBytes, fired_count: v.fired.length, fired: v.fired };
    }
    process.stdout.write(
      JSON.stringify(
        {
          baseline_raw_bytes: m.baselineRawBytes,
          baseline_count: m.baselineCount,
          path_scoped_count: m.pathScopedCount,
          profiles,
          broad_load: m.broadLoad,
          failures,
          ok: failures.length === 0,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(humanReport(m, budget, failures) + "\n");
  }
  return failures.length === 0 ? 0 : 1;
}

// Exported for unit tests (pure functions; main() has I/O side effects).
export {
  parseFrontmatter,
  stripQuotes,
  globToRegex,
  matchesAny,
  classify,
  measure,
  buildSnapshot,
  compare,
  PROFILES,
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main(process.argv));
}
