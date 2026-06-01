#!/usr/bin/env node
/*
 * Audit fixture runner for validate-proximity-band (F23e, journal/0155).
 *
 * Structural probes per rules/probe-driven-verification.md MUST-3:
 *   - exit-code / count-of-elements / equality checks on pure-function outputs.
 *   - integration tests use temp git repos (real subprocess; no mocks).
 *   - NO semantic judgment, NO regex on assistant prose.
 *
 * Exit 0 = all fixtures pass. Exit 1 = ≥1 fixture failed.
 */

import {
  getProximityBandAdvisory,
  HEADROOM_PROXIMITY_BAND_PCT_DEFAULT,
} from "../../bin/emit.mjs";
import {
  parseFrontmatter,
  isBaselineRule,
  LOAD_BEARING_MARKERS,
} from "../../bin/validate-proximity-band.mjs";
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  cpSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let passed = 0;
let failed = 0;

function check(name, condition, details) {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL  ${name}\n`);
    if (details) process.stderr.write(`        ${details}\n`);
  }
}

function gitInit(repoDir) {
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });
}

function gitCommit(repoDir, msg, dateIso) {
  execFileSync("git", ["add", "-A"], { cwd: repoDir });
  execFileSync(
    "git",
    ["commit", "--quiet", "-m", msg, "--allow-empty-message", "--allow-empty"],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: dateIso,
        GIT_COMMITTER_DATE: dateIso,
      },
    },
  );
}

// Resolve canonical paths to the validator + emit script for subprocess
// integration tests (fixtures 02 / 03 / 06 / 07 / 09 / 10).
const __filename = fileURLToPath(import.meta.url);
const VALIDATOR_SCRIPT = __filename.replace(
  /\/audit-fixtures\/.*$/,
  "/bin/validate-proximity-band.mjs",
);
const EMIT_SCRIPT = __filename.replace(
  /\/audit-fixtures\/.*$/,
  "/bin/emit.mjs",
);

// Build a minimal-but-faithful temp loom repo with the bin/ scripts +
// rules/ + sync-manifest.yaml needed for emit.mjs to run. Copy from
// the real repo's checked-in artifacts so the temp repo behaves
// identically to a live /sync invocation. The bin/ + rules/ + manifest
// surface is shared across all integration fixtures.
function buildTempLoomRepo(tag) {
  const dir = join(tmpdir(), `f23e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  gitInit(dir);
  // Copy the LIVE .claude/bin + .claude/rules + .claude/skills + manifest
  // + supporting files. Live copy is the cheapest way to keep emit.mjs's
  // dependencies satisfied without re-stubbing every helper.
  const realRoot = __filename.replace(/\/\.claude\/audit-fixtures\/.*$/, "");
  cpSync(join(realRoot, ".claude", "bin"), join(dir, ".claude", "bin"), {
    recursive: true,
  });
  cpSync(join(realRoot, ".claude", "rules"), join(dir, ".claude", "rules"), {
    recursive: true,
  });
  // Skills directory is referenced by the abridge / extract-paths logic
  // inside emit.mjs's composer. Copy in full so emit doesn't choke on a
  // missing skill referenced from a rule.
  if (existsSync(join(realRoot, ".claude", "skills"))) {
    cpSync(join(realRoot, ".claude", "skills"), join(dir, ".claude", "skills"), {
      recursive: true,
    });
  }
  // sync-manifest.yaml lives at .claude/sync-manifest.yaml per emit.mjs
  // REPO resolution (REPO = .claude/bin/.. /.. = repo root; manifest at
  // .claude/sync-manifest.yaml relative to REPO).
  if (existsSync(join(realRoot, ".claude", "sync-manifest.yaml"))) {
    copyFileSync(
      join(realRoot, ".claude", "sync-manifest.yaml"),
      join(dir, ".claude", "sync-manifest.yaml"),
    );
  }
  // .claude/codex-mcp-guard policies fixtures are consulted by validator-13.
  if (existsSync(join(realRoot, ".claude", "codex-mcp-guard"))) {
    cpSync(
      join(realRoot, ".claude", "codex-mcp-guard"),
      join(dir, ".claude", "codex-mcp-guard"),
      { recursive: true },
    );
  }
  // settings.json + supporting policy fixtures
  if (existsSync(join(realRoot, ".claude", "settings.json"))) {
    copyFileSync(
      join(realRoot, ".claude", "settings.json"),
      join(dir, ".claude", "settings.json"),
    );
  }
  if (existsSync(join(realRoot, ".claude", "audit-fixtures"))) {
    // Validator-13 reads MCP-guard fixtures; provide them to keep the
    // emit.mjs subprocess from exiting non-zero on the validator step.
    cpSync(
      join(realRoot, ".claude", "audit-fixtures"),
      join(dir, ".claude", "audit-fixtures"),
      { recursive: true },
    );
  }
  // Initial commit = "main" baseline.
  gitCommit(dir, "init from live tree", "2026-05-23T12:00:00Z");
  return dir;
}

function runValidator(repoRoot, extraArgs = []) {
  const result = spawnSync(
    "node",
    [VALIDATOR_SCRIPT, "--repo-root", repoRoot, ...extraArgs],
    { encoding: "utf8", cwd: repoRoot },
  );
  return result;
}

// ------------------------------------------------------------------
// fixture-01-no-near-breach
// ------------------------------------------------------------------
// Direct helper call: getProximityBandAdvisory at 20% headroom (> 15%
// band) returns null. No subprocess needed.
{
  const BLOCK_CAP = 61440;
  // emissionBytes producing 20% headroom: 0.80 * BLOCK_CAP = 49152
  const advisory = getProximityBandAdvisory({
    cli: "codex",
    lang: "base",
    emissionBytes: 49152,
    blockCap: BLOCK_CAP,
    floorPct: 10,
    proximityBandPct: 15,
  });
  check(
    "fixture-01-no-near-breach",
    advisory === null,
    `expected null (20% headroom > 15% band); got ${JSON.stringify(advisory)}`,
  );
}

// ------------------------------------------------------------------
// fixture-02-near-breach-no-diff
// ------------------------------------------------------------------
// Subprocess integration: live tree has near-breach lanes (13.92%
// codex / 13.54% gemini per current emit output) BUT diff is empty
// (HEAD..HEAD). Expect verdict=advisory_only_no_diff, exit 0.
{
  const tmp = buildTempLoomRepo("fix-02");
  try {
    const result = runValidator(tmp, ["--base", "HEAD", "--head", "HEAD", "--json"]);
    let report = null;
    try {
      report = JSON.parse(result.stdout || "{}");
    } catch {
      // fall through
    }
    check(
      "fixture-02-near-breach-no-diff",
      result.status === 0 &&
        report &&
        report.rule_10_fires === false &&
        report.verdict === "advisory_only_no_diff" &&
        report.near_breach_lanes.length > 0 &&
        report.proposal_diff.baseline_additions_total === 0,
      `exit=${result.status} verdict=${report?.verdict} ` +
        `near_breach=${report?.near_breach_lanes?.length} ` +
        `baseline_additions=${report?.proposal_diff?.baseline_additions_total} ` +
        `stderr=${(result.stderr || "").slice(0, 300)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-03-near-breach-with-diff
// ------------------------------------------------------------------
// Subprocess integration: create a SECOND commit that adds a NEW MUST
// clause to a known baseline rule. Diff main..HEAD now shows a
// baseline addition; emit lanes are still near-breach → Rule 10 fires.
{
  const tmp = buildTempLoomRepo("fix-03");
  try {
    // Identify a known baseline rule (priority: 0, scope: baseline).
    // security.md is a canonical baseline rule per emit.mjs::getCritBaseline.
    const targetRule = join(tmp, ".claude", "rules", "security.md");
    if (!existsSync(targetRule)) {
      check(
        "fixture-03-near-breach-with-diff",
        false,
        `setup: target rule security.md not present in temp tree`,
      );
    } else {
      // Confirm baseline-at-head.
      const isBL = isBaselineRule(".claude/rules/security.md", tmp);
      if (!isBL) {
        check(
          "fixture-03-near-breach-with-diff",
          false,
          `setup: .claude/rules/security.md not classified as baseline at HEAD (frontmatter mismatch)`,
        );
      } else {
        // Append a new MUST clause to the rule body.
        const cur = execFileSync(
          "git",
          ["show", "HEAD:.claude/rules/security.md"],
          { cwd: tmp, encoding: "utf8" },
        );
        writeFileSync(
          targetRule,
          cur + "\n\n## F23e Fixture Probe\n\nMUST exercise the validator gate.\n",
        );
        execFileSync("git", ["checkout", "-b", "feat/f23e-fixture-03"], {
          cwd: tmp,
        });
        gitCommit(tmp, "test: add MUST clause", "2026-05-23T13:00:00Z");

        const result = runValidator(tmp, [
          "--base",
          "main",
          "--head",
          "HEAD",
          "--json",
        ]);
        let report = null;
        try {
          report = JSON.parse(result.stdout || "{}");
        } catch {
          // fall through
        }
        check(
          "fixture-03-near-breach-with-diff",
          result.status === 1 &&
            report &&
            report.rule_10_fires === true &&
            report.verdict === "fires" &&
            report.near_breach_lanes.length > 0 &&
            report.proposal_diff.baseline_additions_total >= 1,
          `exit=${result.status} verdict=${report?.verdict} ` +
            `near_breach=${report?.near_breach_lanes?.length} ` +
            `baseline_additions=${report?.proposal_diff?.baseline_additions_total} ` +
            `stderr=${(result.stderr || "").slice(0, 300)}`,
        );
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-04-band-edge-15pct
// ------------------------------------------------------------------
// F23a's band edge is EXCLUSIVE: headroom == proximityBandPct → null.
// Mirrors proximity-band-budget fixture-03 to lock the symmetric edge
// behavior at the composition layer.
{
  const BLOCK_CAP = 61440;
  // 85% used = 15% headroom EXACTLY
  const advisory = getProximityBandAdvisory({
    cli: "codex",
    lang: "base",
    emissionBytes: 52224,
    blockCap: BLOCK_CAP,
    floorPct: 10,
    proximityBandPct: 15,
  });
  check(
    "fixture-04-band-edge-15pct",
    advisory === null,
    `expected null at exact band edge; got ${JSON.stringify(advisory)}`,
  );
}

// ------------------------------------------------------------------
// fixture-05-misconfig-band-le-floor
// ------------------------------------------------------------------
// proximityBandPct <= floorPct → null (security M4 defense).
{
  const BLOCK_CAP = 61440;
  const advisory = getProximityBandAdvisory({
    cli: "codex",
    lang: "base",
    emissionBytes: 54068,
    blockCap: BLOCK_CAP,
    floorPct: 15,
    proximityBandPct: 10,
  });
  check(
    "fixture-05-misconfig-band-le-floor",
    advisory === null,
    `expected null on band<=floor misconfig; got ${JSON.stringify(advisory)}`,
  );
}

// ------------------------------------------------------------------
// fixture-06-diff-only-path-scoped
// ------------------------------------------------------------------
// A diff that adds a MUST clause to a `scope: path-scoped` rule MUST
// NOT contribute to Rule 10's trigger (per Rule 10 Trigger scope:
// fires on priority:0 + scope:baseline rules ONLY). Even with near-
// breach lanes present, rule_10_fires=false because baseline_additions=0.
{
  const tmp = buildTempLoomRepo("fix-06");
  try {
    // Create a NEW path-scoped rule (no priority:0) so the diff only
    // touches a non-baseline rule.
    const pathScopedRule = join(
      tmp,
      ".claude",
      "rules",
      "f23e-fixture-path-scoped.md",
    );
    writeFileSync(
      pathScopedRule,
      "---\nscope: path-scoped\npriority: 10\npaths: \"foo/**\"\n---\n\n# Test path-scoped rule\n\nMUST not fire Rule 10.\n",
    );
    execFileSync("git", ["checkout", "-b", "feat/f23e-fixture-06"], {
      cwd: tmp,
    });
    gitCommit(tmp, "test: add path-scoped rule with MUST", "2026-05-23T13:00:00Z");

    const result = runValidator(tmp, [
      "--base",
      "main",
      "--head",
      "HEAD",
      "--json",
    ]);
    let report = null;
    try {
      report = JSON.parse(result.stdout || "{}");
    } catch {
      // fall through
    }
    check(
      "fixture-06-diff-only-path-scoped",
      result.status === 0 &&
        report &&
        report.rule_10_fires === false &&
        // additions on path-scoped rules are recorded but NOT baseline
        report.proposal_diff.additions_total >= 1 &&
        report.proposal_diff.baseline_additions_total === 0,
      `exit=${result.status} verdict=${report?.verdict} ` +
        `additions_total=${report?.proposal_diff?.additions_total} ` +
        `baseline_additions=${report?.proposal_diff?.baseline_additions_total} ` +
        `stderr=${(result.stderr || "").slice(0, 300)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-07-empty-diff
// ------------------------------------------------------------------
// No commits beyond main → diff HEAD..HEAD is empty; additions_total=0.
// Verdict is either advisory_only_no_diff (near-breach lanes exist) or
// clean (no near-breach). Either way exit 0.
{
  const tmp = buildTempLoomRepo("fix-07");
  try {
    const result = runValidator(tmp, [
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--json",
    ]);
    let report = null;
    try {
      report = JSON.parse(result.stdout || "{}");
    } catch {
      // fall through
    }
    check(
      "fixture-07-empty-diff",
      result.status === 0 &&
        report &&
        report.rule_10_fires === false &&
        report.proposal_diff.additions_total === 0,
      `exit=${result.status} additions_total=${report?.proposal_diff?.additions_total} ` +
        `stderr=${(result.stderr || "").slice(0, 300)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-08-multiple-lanes-mixed
// ------------------------------------------------------------------
// Direct helper call exercises (a) within-band advisory, (b) above-band
// null, (c) below-floor null — three lanes from one BLOCK_CAP. The
// validator's near-breach predicate is exercised at the composition
// layer in fixtures 02 + 03 + 07; here we lock the per-lane helper
// shape that the composition layer consumes.
{
  const BLOCK_CAP = 61440;
  const lanes = [
    // within band (12% headroom) → advisory
    getProximityBandAdvisory({
      cli: "codex",
      lang: "rs",
      emissionBytes: 54068,
      blockCap: BLOCK_CAP,
      floorPct: 10,
      proximityBandPct: 15,
    }),
    // above band (20% headroom) → null
    getProximityBandAdvisory({
      cli: "gemini",
      lang: "rs",
      emissionBytes: 49152,
      blockCap: BLOCK_CAP,
      floorPct: 10,
      proximityBandPct: 15,
    }),
    // below floor (8.76% headroom) → null (BLOCK path)
    getProximityBandAdvisory({
      cli: "codex",
      lang: "py",
      emissionBytes: 56058,
      blockCap: BLOCK_CAP,
      floorPct: 10,
      proximityBandPct: 15,
    }),
  ];
  check(
    "fixture-08-multiple-lanes-mixed",
    lanes[0] !== null &&
      lanes[0].cli === "codex" &&
      lanes[0].lang === "rs" &&
      Math.abs(lanes[0].headroom_pct - 12) < 0.01 &&
      lanes[1] === null &&
      lanes[2] === null,
    `lanes=${JSON.stringify(lanes.map((l) => (l ? { cli: l.cli, lang: l.lang, hp: l.headroom_pct } : null)))}`,
  );
}

// ------------------------------------------------------------------
// fixture-09-help-exit-0
// ------------------------------------------------------------------
// Subprocess: --help exits 0 with usage text.
{
  const result = spawnSync("node", [VALIDATOR_SCRIPT, "--help"], {
    encoding: "utf8",
  });
  check(
    "fixture-09-help-exit-0",
    result.status === 0 &&
      result.stdout &&
      result.stdout.includes("usage:") &&
      result.stdout.includes("Rule 10"),
    `exit=${result.status} stdout-prefix=${(result.stdout || "").slice(0, 100)}`,
  );
}

// ------------------------------------------------------------------
// fixture-10-malformed-flag-exit-2
// ------------------------------------------------------------------
// Subprocess: unknown flag exits 2.
{
  const result = spawnSync(
    "node",
    [VALIDATOR_SCRIPT, "--this-flag-does-not-exist"],
    { encoding: "utf8" },
  );
  check(
    "fixture-10-malformed-flag-exit-2",
    result.status === 2 && /unknown flag/i.test(result.stderr || ""),
    `exit=${result.status} stderr=${(result.stderr || "").slice(0, 200)}`,
  );
}

// ------------------------------------------------------------------
process.stdout.write(`\n${passed}/${passed + failed} fixtures pass\n`);
process.exit(failed === 0 ? 0 : 1);
